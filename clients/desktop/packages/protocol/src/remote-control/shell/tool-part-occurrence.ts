/**
 * Stable identity for ordinary Portal tool parts, so every merge keeps a live
 * result's output locator on the occurrence that canonical admission proved,
 * and never lends it to another call that reuses the same provider tool id.
 * Browser-safe and pure: the web server, the browser shell and the shared
 * chat store use the same rules.
 */
import type { RemoteControlChatPart } from './index';

/** Upper bound on {@link RemoteControlToolOccurrence.id}. */
export const REMOTE_CONTROL_TOOL_OCCURRENCE_ID_MAX_LENGTH = 512;
/**
 * The canonical call (or, for an unpaired result, result) block a visible tool
 * part shows, and the admission revision of its read target.
 */
export interface RemoteControlToolOccurrence {
  readonly id: string;
  readonly revision: number;
}

export type RemoteControlToolOutputLocator = NonNullable<
  RemoteControlChatPart['outputLocator']
>;

// Printable ASCII without spaces: canonical row ids are generated, so this
// alphabet survives event sanitization unchanged.
const OCCURRENCE_ID_ALPHABET = /^[\x21-\x7e]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOccurrenceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= REMOTE_CONTROL_TOOL_OCCURRENCE_ID_MAX_LENGTH &&
    OCCURRENCE_ID_ALPHABET.test(value)
  );
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The occurrence id of a canonical block: its row id and absolute block
 * ordinal. Live admission and the persisted projection derive it the same
 * way, before display rows converge. Undefined when the id is not
 * representable, which leaves the part unkeyed and preview-only.
 */
export function remoteControlToolOccurrenceId(
  rowId: string,
  blockOrdinal: number,
): string | undefined {
  if (!isRevision(blockOrdinal)) return undefined;
  const id = `${rowId}#${String(blockOrdinal)}`;
  return isOccurrenceId(id) ? id : undefined;
}

/** A validated occurrence, or undefined. Extra fields are rejected. */
export function readRemoteControlToolOccurrence(
  value: unknown,
): RemoteControlToolOccurrence | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'id' && key !== 'revision') ||
    !isOccurrenceId(value.id) ||
    !isRevision(value.revision)
  )
    return undefined;
  return { id: value.id, revision: value.revision };
}

/** A validated output locator, or undefined. */
export function readRemoteControlToolOutputLocator(
  value: unknown,
): RemoteControlToolOutputLocator | undefined {
  if (
    !isRecord(value) ||
    typeof value.messageId !== 'string' ||
    value.messageId.length === 0 ||
    value.messageId.length > REMOTE_CONTROL_TOOL_OCCURRENCE_ID_MAX_LENGTH ||
    !isRevision(value.blockOrdinal) ||
    value.field !== 'output'
  )
    return undefined;
  return {
    messageId: value.messageId,
    blockOrdinal: value.blockOrdinal,
    field: 'output',
  };
}

type ToolKind = 'tool_use' | 'tool_result';

function toolKind(part: Record<string, unknown>): ToolKind | undefined {
  const kind = part.kind ?? part.type;
  return kind === 'tool_use' || kind === 'tool_result' ? kind : undefined;
}

function toolUseIdOf(part: Record<string, unknown>): string | undefined {
  const data = isRecord(part.data) ? part.data : {};
  for (const value of [
    data.toolUseId,
    data.tool_use_id,
    part.toolUseId,
    part.tool_use_id,
  ])
    if (typeof value === 'string') return value;
  return undefined;
}

/** A tool part's validated occurrence; undefined for every other part. */
export function remoteControlToolPartOccurrence(
  part: unknown,
): RemoteControlToolOccurrence | undefined {
  return isRecord(part) && toolKind(part)
    ? readRemoteControlToolOccurrence(part.occurrence)
    : undefined;
}

/**
 * Where a part keeps its result locator: on a standalone result, or on a
 * paired call's folded `data.result`.
 */
function readPartLocator(
  part: Record<string, unknown>,
): RemoteControlToolOutputLocator | undefined {
  if (toolKind(part) === 'tool_result')
    return readRemoteControlToolOutputLocator(part.outputLocator);
  const data = isRecord(part.data) ? part.data : undefined;
  const result = data && isRecord(data.result) ? data.result : undefined;
  return result
    ? readRemoteControlToolOutputLocator(result.outputLocator)
    : undefined;
}

function withPartLocator(
  part: Record<string, unknown>,
  locator: RemoteControlToolOutputLocator,
): Record<string, unknown> {
  if (toolKind(part) === 'tool_result')
    return { ...part, outputLocator: locator };
  const data = isRecord(part.data) ? part.data : undefined;
  // A call without a folded result has nowhere to show a result locator.
  if (!data || !isRecord(data.result)) return part;
  return {
    ...part,
    data: { ...data, result: { ...data.result, outputLocator: locator } },
  };
}

function sameLocator(
  left: RemoteControlToolOutputLocator,
  right: RemoteControlToolOutputLocator,
): boolean {
  return (
    left.messageId === right.messageId &&
    left.blockOrdinal === right.blockOrdinal
  );
}

/**
 * Combine two frames of the same occurrence. The incoming frame wins, except
 * that its read metadata never regresses: a frame without a locator keeps the
 * existing one and its revision, and a conflicting locator replaces it only
 * at a newer revision.
 */
function mergeSameOccurrence(existing: unknown, incoming: unknown): unknown {
  if (!isRecord(existing) || !isRecord(incoming)) return incoming;
  const held = readRemoteControlToolOccurrence(existing.occurrence);
  const next = readRemoteControlToolOccurrence(incoming.occurrence);
  const heldLocator = readPartLocator(existing);
  if (!held || !heldLocator) {
    return next || !held ? incoming : { ...incoming, occurrence: held };
  }
  const nextLocator = readPartLocator(incoming);
  if (nextLocator && next) {
    // The same target never moves its revision backwards.
    if (sameLocator(nextLocator, heldLocator))
      return next.revision >= held.revision
        ? incoming
        : { ...incoming, occurrence: held };
    if (next.revision > held.revision) return incoming;
  }
  const kept = withPartLocator(incoming, heldLocator);
  if (kept === incoming)
    return next ? incoming : { ...incoming, occurrence: held };
  return { ...kept, occurrence: held };
}

function legacyToolKey(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  const kind = toolKind(part);
  const toolUseId = kind ? toolUseIdOf(part) : undefined;
  return kind && toolUseId ? `${kind}:${toolUseId}` : undefined;
}

function occurrenceKey(part: unknown): string | undefined {
  const occurrence = remoteControlToolPartOccurrence(part);
  return occurrence && isRecord(part)
    ? `${String(toolKind(part))}:occurrence:${occurrence.id}`
    : undefined;
}

/** How many parts of each kind and tool id a frame carries, keyed or not. */
function countLegacyKeys(parts: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const part of parts) {
    const legacy = legacyToolKey(part);
    if (legacy) counts.set(legacy, (counts.get(legacy) ?? 0) + 1);
  }
  return counts;
}

/**
 * Occurrence ids of calls that already carry their folded result, so a fold
 * can drop a separate result part for the same occurrence that a merge kept.
 */
export function foldedRemoteControlToolOccurrenceIds(
  parts: readonly unknown[],
): Set<string> {
  const ids = new Set<string>();
  for (const part of parts) {
    if (!isRecord(part) || toolKind(part) !== 'tool_use') continue;
    const data = isRecord(part.data) ? part.data : undefined;
    const occurrence = readRemoteControlToolOccurrence(part.occurrence);
    if (occurrence && data && isRecord(data.result)) ids.add(occurrence.id);
  }
  return ids;
}

/** Whether a part is a standalone result its call has already folded in. */
export function isFoldedRemoteControlToolResult(
  part: unknown,
  folded: ReadonlySet<string>,
): boolean {
  if (!isRecord(part) || toolKind(part) !== 'tool_result') return false;
  const occurrence = readRemoteControlToolOccurrence(part.occurrence);
  return occurrence !== undefined && folded.has(occurrence.id);
}

export interface RemoteControlChatPartMergeOptions {
  /** The caller's existing key for every part that is not keyed by occurrence. */
  readonly legacyKey: (part: unknown) => string;
  /** The caller's existing same-key resolution (timers, delegation cards). */
  readonly mergeMatched: (existing: unknown, incoming: unknown) => unknown;
}

/**
 * Union two part lists of one message, as the server cache and the browser
 * shell already do, with tool parts keyed by occurrence when they have one:
 *
 * - The same occurrence matches and keeps its read metadata
 *   ({@link mergeSameOccurrence}).
 * - Different occurrences never exchange read metadata, even with one tool id.
 * - An unkeyed tool part upgrades the one keyed part of its kind and tool id
 *   in place, when it is also the frame's only part of that kind and tool id. With several, it cannot be attributed and is dropped; the keyed
 *   parts stay as they were.
 * - A keyed part replaces the unkeyed part of its kind and tool id in place.
 * - Every other part keeps the caller's existing behavior.
 */
export function mergeRemoteControlChatPartLists(
  existing: readonly unknown[],
  incoming: readonly unknown[],
  options: RemoteControlChatPartMergeOptions,
): unknown[] {
  const merged = [...existing];
  const indexes = new Map<string, number>();
  const keyed = new Map<string, number[]>();
  const keyOf = (part: unknown): string =>
    occurrenceKey(part) ?? options.legacyKey(part);
  const remember = (part: unknown, index: number): void => {
    indexes.set(keyOf(part), index);
    const legacy = occurrenceKey(part) ? legacyToolKey(part) : undefined;
    if (legacy) keyed.set(legacy, [...(keyed.get(legacy) ?? []), index]);
  };
  merged.forEach(remember);
  const incomingCounts = countLegacyKeys(incoming);
  for (const part of incoming) {
    const occurrence = occurrenceKey(part);
    const index = indexes.get(occurrence ?? options.legacyKey(part));
    if (index !== undefined) {
      merged[index] = occurrence
        ? mergeSameOccurrence(merged[index], part)
        : options.mergeMatched(merged[index], part);
      continue;
    }
    if (occurrence) {
      // A keyed frame of a part first seen unkeyed takes its place, as the
      // same key did before; later unkeyed frames then find it by occurrence.
      const legacyKey = options.legacyKey(part);
      const legacyIndex = indexes.get(legacyKey);
      if (legacyIndex !== undefined && !occurrenceKey(merged[legacyIndex])) {
        indexes.delete(legacyKey);
        merged[legacyIndex] = options.mergeMatched(merged[legacyIndex], part);
        remember(merged[legacyIndex], legacyIndex);
        continue;
      }
    } else {
      const legacy = legacyToolKey(part);
      // Only the frame's one part of its kind and tool id can be the keyed
      // part's later frame; a sibling beside it is another occurrence.
      const candidates =
        legacy && incomingCounts.get(legacy) === 1
          ? keyed.get(legacy)
          : undefined;
      if (candidates?.length === 1) {
        merged[candidates[0]] = mergeSameOccurrence(
          merged[candidates[0]],
          part,
        );
        continue;
      }
      if (candidates && candidates.length > 1) continue;
    }
    merged.push(part);
    remember(part, merged.length - 1);
  }
  return merged;
}

/**
 * Carry read metadata into a replacement frame of the same message, as the
 * shared chat store replaces a message on every event. Keyed parts match by
 * occurrence. An unkeyed part matches a keyed one only when each side has
 * exactly one part of its kind and tool id, keyed or not; any other ambiguity
 * gains nothing. Parts absent from the incoming frame stay absent.
 */
export function retainRemoteControlToolPartMetadata(
  existing: readonly RemoteControlChatPart[],
  incoming: readonly RemoteControlChatPart[],
): RemoteControlChatPart[] {
  const byOccurrence = new Map<string, unknown>();
  const keyedByLegacy = new Map<string, unknown[]>();
  for (const part of existing) {
    const key = occurrenceKey(part);
    const legacy = legacyToolKey(part);
    if (!key) continue;
    byOccurrence.set(key, part);
    if (legacy)
      keyedByLegacy.set(legacy, [...(keyedByLegacy.get(legacy) ?? []), part]);
  }
  if (byOccurrence.size === 0) return [...incoming];
  const existingCounts = countLegacyKeys(existing);
  const incomingCounts = countLegacyKeys(incoming);
  return incoming.map((part) => {
    const key = occurrenceKey(part);
    const legacy = legacyToolKey(part);
    let previous: unknown;
    if (key) previous = byOccurrence.get(key);
    else if (
      legacy &&
      incomingCounts.get(legacy) === 1 &&
      existingCounts.get(legacy) === 1
    ) {
      const candidates = keyedByLegacy.get(legacy);
      if (candidates?.length === 1) previous = candidates[0];
    }
    if (previous === undefined) return part;
    const merged = mergeSameOccurrence(previous, part);
    return isRemoteControlChatPartRecord(merged) ? merged : part;
  });
}

function isRemoteControlChatPartRecord(
  value: unknown,
): value is RemoteControlChatPart {
  return isRecord(value) && typeof value.kind === 'string';
}

/**
 * Pair each result with its call. A result that names an occurrence pairs
 * with the unmatched call of that occurrence; otherwise each result consumes
 * the nearest preceding unmatched call of its tool id that is not keyed to a
 * different occurrence. Indices identify occurrences, not potentially
 * duplicated provider tool ids.
 */
export function pairToolResultOccurrences<T>(
  items: readonly T[],
  identify: (item: T) =>
    | {
        kind: 'tool_use' | 'tool_result';
        toolUseId: string;
        occurrenceId?: string;
      }
    | undefined,
): ReadonlyMap<number, number> {
  const unmatched = new Map<
    string,
    Array<{ index: number; occurrenceId?: string }>
  >();
  const pairs = new Map<number, number>();
  items.forEach((item, index) => {
    const occurrence = identify(item);
    if (!occurrence) return;
    const calls = unmatched.get(occurrence.toolUseId) ?? [];
    if (occurrence.kind === 'tool_use') {
      calls.push({ index, occurrenceId: occurrence.occurrenceId });
      unmatched.set(occurrence.toolUseId, calls);
      return;
    }
    const wanted = occurrence.occurrenceId;
    let position = -1;
    for (let at = calls.length - 1; at >= 0; at -= 1) {
      const callOccurrence = calls[at].occurrenceId;
      if (
        wanted === undefined ||
        callOccurrence === undefined ||
        callOccurrence === wanted
      ) {
        if (wanted !== undefined && callOccurrence === undefined) {
          // An unkeyed call is only a fallback for a keyed result.
          if (position < 0) position = at;
          continue;
        }
        position = at;
        break;
      }
    }
    if (position < 0) return;
    const [call] = calls.splice(position, 1);
    pairs.set(call.index, index);
  });
  return pairs;
}
