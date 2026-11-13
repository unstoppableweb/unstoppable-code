import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { createJsonLineStream } from './json-lines';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { JsonValue } from './generated/serde_json/JsonValue';

const MAX_ROLLOUT_FILES_SCANNED = 25_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

/**
 * Drop provider-private reasoning that a different upstream family cannot
 * decode.
 *
 * Provenance is deliberately fail-closed: reasoning is retained **only** when
 * `sourceRouteFamily` is known and equals `targetRouteFamily`. An `undefined`
 * `sourceRouteFamily` means "unknown provenance" and is treated as a route
 * change. That intentionally includes native threads whose route never changed
 * but whose lease predates route-family tracking: replaying reasoning the
 * upstream provider rejects breaks the turn outright, while dropping
 * recoverable reasoning only costs cached thinking context.
 *
 * **On a changed or unknown family, EVERY `type: 'reasoning'` item is dropped**
 * — not only the ones carrying `content` or `encrypted_content`. Reasoning
 * items are optional in a Responses input list, so removing all of them is
 * always safe, and the narrower filter was not: the upstream rejections this
 * sanitizer exists to prevent also name `input[N].type` and
 * `input[N].internal_chat_message_metadata_passthrough` (see
 * `isIncompatibleReasoningHistoryError()` in `agents/codex-session.ts`). A
 * content-empty reasoning item carrying foreign passthrough metadata, or one
 * rejected purely on its `type`, survived the old filter, so the self-heal
 * rebuild reinjected the exact offending item, burned its retry budget, and
 * surfaced the original error anyway.
 *
 * **Ordering decision — a `function_call` whose preceding reasoning item was
 * dropped is retained.** The Responses API ordering constraint runs in the
 * other direction: it rejects a *reasoning* item that is not followed by the
 * item it belongs to, and it rejects a `function_call_output` with no matching
 * `function_call`. Removing the reasoning item and keeping the
 * call/output pair therefore satisfies both, while dropping the orphaned call
 * would strand its output (or force cascading removal of a real tool result).
 * Reasoning items are optional in an input list; tool calls are not optional
 * for their outputs. See the paired-item test in
 * `__tests__/rollout-seed.test.ts`.
 */
export function sanitizeSeedItemsForRouteChange(
  items: readonly JsonValue[],
  routeFamilies?: {
    targetRouteFamily?: string;
    sourceRouteFamily?: string;
  },
): JsonValue[] {
  if (
    routeFamilies?.sourceRouteFamily !== undefined &&
    routeFamilies.sourceRouteFamily === routeFamilies.targetRouteFamily
  ) {
    return [...items];
  }
  return items.filter((item) => !isRecord(item) || item.type !== 'reasoning');
}

/**
 * Text of a user message, but only when the message is composed *entirely* of
 * recognized text parts.
 *
 * Returning `null` for anything else is deliberate: a message carrying an
 * image, a file attachment, or any part shape this function does not
 * understand must never be considered a match, because the caller deletes what
 * matches. Matching on text alone would silently discard the non-text parts
 * along with it.
 */
function textOnlyUserMessageText(item: JsonValue): string | null {
  if (!isRecord(item) || item.type !== 'message' || item.role !== 'user') {
    return null;
  }
  const { content } = item;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) return null;
    if (part.type !== 'input_text' && part.type !== 'text') return null;
    if (typeof part.text !== 'string') return null;
    parts.push(part.text);
  }
  return parts.join('');
}

/**
 * Remove **at most one** trailing user message that repeats
 * `pendingUserInputText`.
 *
 * A turn rejected by the Responses API may already have persisted its user
 * input to the rollout. Reconstructing from that rollout and then re-sending
 * the same message would show the model the prompt twice, so the persisted
 * copy is trimmed and the live turn remains the single source.
 *
 * Two deliberate restrictions, because this deletes real conversation history:
 *
 * - **At most one item.** A user who legitimately sent the same prompt several
 *   times in a row has a genuine run of identical messages; only the single
 *   copy attributable to the failed turn may be removed.
 * - **Text-only messages.** A message with attachments or unrecognized parts is
 *   never dropped, even when its text matches.
 *
 * Callers must only pass `pendingUserInputText` on a path where the failed
 * turn is *known* to have persisted its input:
 *
 * - Proactive reconstruction runs before `turn/start`, so nothing has been
 *   persisted yet and trimming there would delete history the user still has.
 * - The items must have come from the **rollout**
 *   (`CodexThreadSeedLoad.source === 'rollout'`). The renderer transcript
 *   fallback is loaded with `excludeMessageId`, so it never contains the
 *   pending message and its trailing item is a genuine earlier one.
 */
export function dropTrailingUserInput(
  items: readonly JsonValue[],
  pendingUserInputText: string | undefined,
): JsonValue[] {
  const pending = pendingUserInputText?.trim();
  if (!pending) return [...items];
  const last = items[items.length - 1];
  if (last === undefined) return [...items];
  const text = textOnlyUserMessageText(last);
  if (text === null || text.trim() !== pending) return [...items];
  return items.slice(0, -1);
}

function compactedReplacementHistory(value: unknown): JsonValue[] | null {
  if (!isRecord(value) || !Array.isArray(value.replacement_history)) {
    return null;
  }
  return value.replacement_history.every(isJsonValue)
    ? value.replacement_history
    : null;
}

function legacyCompactionHistory(value: unknown): JsonValue[] | null {
  if (!isRecord(value) || typeof value.message !== 'string') {
    return null;
  }
  return [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: value.message || '(no summary available)',
        },
      ],
    },
  ];
}

async function containedRolloutPath(
  sessionsRoot: string,
  candidate: string,
): Promise<string | null> {
  if (!isAbsolute(candidate)) return null;
  const [realRoot, realCandidate] = await Promise.all([
    realpath(sessionsRoot).catch(() => null),
    realpath(candidate).catch(() => null),
  ]);
  if (!realRoot || !realCandidate) return null;
  const fromRoot = relative(realRoot, realCandidate);
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    return null;
  }
  const fileStat = await stat(realCandidate).catch(() => null);
  return fileStat?.isFile() && realCandidate.endsWith('.jsonl')
    ? realCandidate
    : null;
}

/**
 * Reconstruct the active model-visible Responses API history persisted in a
 * Codex rollout. A `compacted` item replaces all prior history with its
 * `replacement_history`; only later response items remain as the active tail.
 * Legacy compaction records predate `replacement_history`, so their summary is
 * retained as a user message checkpoint instead of resurrecting the discarded
 * pre-compaction history.
 *
 * The resulting payloads are accepted directly by `thread/inject_items`, so a
 * capability-changing continuation does not need to flatten the conversation
 * into display text or recreate a provider-neutral transcript first.
 */
export async function readCodexRolloutSeedItems(
  rolloutPath: string,
): Promise<JsonValue[]> {
  const items: JsonValue[] = [];
  const input = createReadStream(rolloutPath, { encoding: 'utf8' });
  const lines = createJsonLineStream(input);
  try {
    for await (const line of lines) {
      if (typeof line !== 'string' || !line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A process crash can leave one incomplete trailing JSONL record. All
        // prior complete response items remain a valid reconstruction seed.
        continue;
      }
      if (!isRecord(parsed)) continue;
      if (parsed.type === 'response_item') {
        if (isJsonValue(parsed.payload)) items.push(parsed.payload);
        continue;
      }
      if (parsed.type !== 'compacted') continue;

      const replacementHistory = compactedReplacementHistory(parsed.payload);
      if (replacementHistory) {
        items.splice(0, items.length, ...replacementHistory);
        continue;
      }

      const legacyHistory = legacyCompactionHistory(parsed.payload);
      if (legacyHistory) {
        items.splice(0, items.length, ...legacyHistory);
      }
    }
  } finally {
    lines.destroy();
    input.destroy();
  }
  return items;
}

async function findRolloutByThreadId(
  sessionsRoot: string,
  threadId: string,
): Promise<string | null> {
  const stack = [sessionsRoot];
  let filesScanned = 0;
  while (stack.length > 0 && filesScanned < MAX_ROLLOUT_FILES_SCANNED) {
    const directory = stack.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      filesScanned += 1;
      if (entry.name.includes(threadId)) {
        return entryPath;
      }
      if (filesScanned >= MAX_ROLLOUT_FILES_SCANNED) break;
    }
  }
  return null;
}

/**
 * Which store the returned seed items actually came from.
 *
 * Not diagnostic metadata: the two sources have different de-duplication
 * contracts. The canonical rollout retains the user input of a turn that just
 * failed, so a caller re-sending that input must trim the persisted copy. The
 * renderer transcript fallback is built with `excludeMessageId` and never
 * contains the pending message, so its trailing item is always a genuine
 * earlier message — trimming there deletes real history whenever the user
 * repeated themselves (`Continue`, `go on`).
 */
export type CodexThreadSeedSource = 'rollout' | 'fallback';

export interface CodexThreadSeedLoad {
  /** Route-sanitized items, safe to inject into a replacement thread. */
  items: JsonValue[];
  /** Where {@link CodexThreadSeedLoad.items} came from. */
  source: CodexThreadSeedSource;
  /**
   * How many persisted items were found **before** route sanitization.
   *
   * A caller that treats "no persisted history" as fatal must test this rather
   * than `items.length`. A thread whose entire surviving tail was
   * provider-private reasoning sanitizes down to nothing even though history
   * genuinely existed, and failing there hard-fails the user's turn on the one
   * path (the self-heal retry) whose recovery budget is already spent.
   */
  loadedItemCount: number;
}

export async function loadCodexThreadSeedItemsWithLoadCount(options: {
  codexHome: string;
  threadId: string;
  rolloutPath?: string | null;
  fallbackItems?: readonly JsonValue[];
  targetRouteFamily?: string;
  sourceRouteFamily?: string;
}): Promise<CodexThreadSeedLoad> {
  const sessionsRoot = join(options.codexHome, 'sessions');
  const explicitPath = options.rolloutPath
    ? await containedRolloutPath(sessionsRoot, options.rolloutPath)
    : null;
  const discoveredPath =
    explicitPath ??
    (await findRolloutByThreadId(sessionsRoot, options.threadId));
  let loadedItemCount = 0;
  if (discoveredPath) {
    // Sanitize before the emptiness check: both callers treat an empty result
    // as a fatal "no persisted history" error, so a rollout whose entire tail
    // is provider-private reasoning must still fall through to the persisted
    // transcript rather than failing the turn.
    const rawItems = await readCodexRolloutSeedItems(discoveredPath);
    loadedItemCount = rawItems.length;
    const items = sanitizeSeedItemsForRouteChange(rawItems, options);
    if (items.length > 0) {
      return { items, source: 'rollout', loadedItemCount };
    }
  }
  const fallbackItems = options.fallbackItems ?? [];
  return {
    items: sanitizeSeedItemsForRouteChange(fallbackItems, options),
    source: 'fallback',
    loadedItemCount: Math.max(loadedItemCount, fallbackItems.length),
  };
}
