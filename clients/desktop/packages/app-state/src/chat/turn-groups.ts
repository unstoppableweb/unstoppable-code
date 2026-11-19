import { isPlanFileWrite } from '@canopy/protocol/plan-tool-input';
import { isClaudeAiCreditsFallbackErrorCode } from '@canopy/protocol/llm-gateway';
import { isCodexAccountModelAccessFailure } from '@canopy/protocol/auth-recovery';
import type {
  RemoteControlChatMessage,
  RemoteControlChatToolFamily,
  RemoteControlChatTurnGroup,
  TurnOutcomeCounts,
  TurnOutcomeStepDetail,
  TurnOutcomeEvidence,
  ToolInterruption,
} from '@canopy/protocol/remote-control/shell';
import {
  classifyTurnStepOutcome,
  readToolInterruption,
} from '@canopy/protocol/remote-control/shell';

/**
 * Neutral turn-grouping for the shared chat store.
 *
 * This is the transport-agnostic counterpart to the desktop renderer's
 * `incremental-turn-groups.ts`. That implementation is hard-coupled to desktop
 * rich-block types (`DisplayBlock`, `groupIntoTurns`/`AgentUsage`) which live in
 * `@canopy/desktop-shared` and the desktop renderer — both forbidden imports for
 * `@canopy/app-state`. So this module re-derives the grouping over the neutral
 * {@link RemoteControlChatMessage} shape from `@canopy/protocol`, preserving the one
 * behaviour the shared UI depends on: **referential identity of completed turn
 * groups**, so a downstream `React.memo` can skip re-rendering settled turns
 * while only the streaming tail changes.
 *
 * The intermediate-vs-final classification below is a deliberately simple,
 * documented default (the concluding textual answer and anything after it is
 * "final"; earlier tool-only steps are "intermediate"). The shared
 * `ui-app` transcript (`ChatTranscript`/`TurnGroupView`) renders these groups,
 * so the rule is load-bearing there; exact parity with the desktop
 * `splitFinalMessages` / server projector remains a follow-up refinement
 * (CAN-741) and any change must keep those consumers' tests green.
 */

/** Per-chat cache of completed turn groups, keyed by the anchoring user id. */
export interface TurnGroupCache {
  /** Which chat this cache belongs to; a mismatch invalidates the cache. */
  chatId: string;
  /** Completed groups from the previous computation, keyed by user message id. */
  completedGroups: Map<string, RemoteControlChatTurnGroup>;
}

/** A fresh, empty cache; callers own one per chat thread. */
export function createEmptyTurnGroupCache(): TurnGroupCache {
  return { chatId: '', completedGroups: new Map() };
}

/** A message whose status is no longer streaming. */
function isTerminalStatus(status: RemoteControlChatMessage['status']): boolean {
  return status !== 'streaming';
}

/**
 * A system message carrying only `turn_timer` parts — the turn's "Working…" /
 * "Completed X:XX" row. Its `createdAtMs` is pinned to the turn start (that is
 * its upsert identity), so in transcript order it sits *before* the assistant
 * answer; like the desktop `reorderMessagesForDisplay`, we float it to the end
 * of its turn for display. One deliberate divergence from desktop: where
 * desktop drops a duplicate timer for the same turn, this module floats all N
 * it finds — never hiding data over a dedupe heuristic. Mixed-part system
 * messages are not timers and stay where they are.
 *
 * This is the single shared timer-shape predicate: the display float here and
 * the transcript's spinner suppression ({@link hasLiveTurnTimer}) must agree,
 * or a message could suppress the fallback spinner while never rendering a
 * visible timer row.
 */
export function isTurnTimerMessage(message: RemoteControlChatMessage): boolean {
  if (message.role !== 'system') {
    return false;
  }
  const parts = message.parts ?? [];
  return parts.length > 0 && parts.every((part) => part.kind === 'turn_timer');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the **current turn** (messages after the last `user` message)
 * carries a live turn timer — a row that already renders its own ticking
 * "Working…" spinner, making a transcript-level fallback spinner a duplicate.
 *
 * The scan is deliberately scoped to the current turn and requires the timer
 * message to still be `streaming` — strictly stricter than the store's
 * `openTimer` liveness scan (`semanticStalenessSignature` in
 * `create-chat-store.ts`), which checks only message status; this predicate
 * additionally requires a timer part without a numeric `completedAt`. An orphaned
 * timer from an interrupted earlier turn — `completedAt: null` forever, e.g.
 * after a mid-turn client `dispose()` that never settles open turns — must not
 * suppress a later turn's send→timer-gap fallback spinner. The walk therefore
 * starts at the tail and stops at the first `user` message.
 */
export function hasLiveTurnTimer(
  messages: readonly RemoteControlChatMessage[],
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (startsRootTurn(message)) break;
    if (!isTurnTimerMessage(message) || message.status !== 'streaming') {
      continue;
    }
    const live = (message.parts ?? []).some((part) => {
      const data = isRecord(part.data) ? part.data : {};
      return typeof data['completedAt'] !== 'number';
    });
    if (live) {
      return true;
    }
  }
  return false;
}

/** Maps a tool family to its `RemoteControlChatTurnGroup.summary` count field. */
const TOOL_FAMILY_TO_SUMMARY_FIELD: Readonly<
  Record<
    RemoteControlChatToolFamily,
    keyof NonNullable<RemoteControlChatTurnGroup['summary']>
  >
> = {
  read: 'readCount',
  edit: 'editCount',
  write: 'writeCount',
  plan: 'planCount',
  bash: 'bashCount',
  grep: 'grepCount',
  glob: 'globCount',
  todo: 'todoCount',
  web: 'webCount',
  agent: 'agentCount',
  'ask-user': 'askUserCount',
  'script-output': 'scriptOutputCount',
  claude: 'claudeCount',
  watcher: 'watcherCount',
  canopy: 'canopyCount',
  graph: 'graphCount',
  skill: 'otherCount',
  monitor: 'otherCount',
  'app-advisor': 'otherCount',
  'pipeline-editor': 'otherCount',
  'computer-use': 'computerUseCount',
  unknown: 'otherCount',
};

/** Tally visible prose, thinking, and tool parts across intermediate messages. */
function summarizeIntermediate(
  intermediate: readonly RemoteControlChatMessage[],
): RemoteControlChatTurnGroup['summary'] {
  const counts: Record<string, number> = {};
  for (const message of intermediate) {
    if (message.text.trim().length > 0) {
      counts['messageCount'] = (counts['messageCount'] ?? 0) + 1;
    }
    for (const part of message.parts ?? []) {
      if (part.kind === 'thinking') {
        const data = isRecord(part.data) ? part.data : {};
        if (
          typeof data['text'] === 'string' &&
          data['text'].trim().length > 0
        ) {
          counts['thinkingCount'] = (counts['thinkingCount'] ?? 0) + 1;
        }
        continue;
      }
      if (part.kind === 'agent') {
        counts['agentCount'] = (counts['agentCount'] ?? 0) + 1;
        continue;
      }
      if (part.kind !== 'tool_use') {
        continue;
      }
      const data = isRecord(part.data) ? part.data : {};
      const toolName =
        typeof data.toolName === 'string'
          ? data.toolName
          : typeof data.name === 'string'
            ? data.name
            : '';
      if (isPlanFileWrite(toolName, data.input)) continue;
      const field = TOOL_FAMILY_TO_SUMMARY_FIELD[part.toolFamily ?? 'unknown'];
      counts[field] = (counts[field] ?? 0) + 1;
    }
  }
  const summary: Record<string, number> = {};
  for (const [field, value] of Object.entries(counts)) {
    if (value > 0) {
      summary[field] = value;
    }
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/** A tool result's error flag and text, as far as it is readable. */
interface RemoteControlToolResult {
  isError: boolean;
  output?: string;
  interruption?: ToolInterruption;
}

/** The first string among the text fields a tool result may carry. */
function readResultText(value: Record<string, unknown>): string | undefined {
  return (
    readString(value, 'output') ??
    readString(value, 'content') ??
    readString(value, 'text')
  );
}

/**
 * Reads a tool result carried as an object or, in persisted projections, as
 * its JSON text. `undefined` when there is no readable result.
 */
function readToolResult(value: unknown): RemoteControlToolResult | undefined {
  let result: unknown = value;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(result)) return undefined;
  const output = readResultText(result);
  const interruption = readToolInterruption(result['interruption']);
  return {
    isError: result['isError'] === true,
    ...(output === undefined ? {} : { output }),
    ...(interruption === undefined ? {} : { interruption }),
  };
}

/**
 * A `tool_use` part's input as the text `getToolDisplayInfo` takes. Runtime
 * frames carry it stringified; persisted projections keep a (truncated)
 * object, which is serialized here.
 */
function readRemoteControlToolInput(data: Record<string, unknown>): string {
  const raw = data['input'];
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return '';
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

/** One counted call and its latest known result. */
interface RemoteControlCountedCall {
  toolName: string;
  input: string;
  result?: RemoteControlToolResult;
}

/**
 * Exclusive step outcomes for a web-rendered turn, over the same
 * `tool_use` parts the collapsed summary counts (plan-mode tools excluded).
 *
 * `countedMessages` are the folded messages the summary counts;
 * `resultMessages` is the complete current turn, so a `tool_result` part
 * carried on a later message (a trailing result) still reaches its call. A
 * result is matched to its call by `toolUseId`; an unassociated result never
 * invents a step, and a call reported twice counts once, with the latest
 * result winning.
 *
 * The Portal carries no structured safety receipt, so a step is blocked only
 * when `isDenial` recognizes its error text, as desktop's step line does.
 * Helper agent outcomes are not derived.
 */
export function computeRemoteControlTurnOutcomes(
  countedMessages: readonly RemoteControlChatMessage[],
  resultMessages: readonly RemoteControlChatMessage[] = countedMessages,
  evidence?: TurnOutcomeEvidence,
  isDenial: (output: string) => boolean = () => false,
): TurnOutcomeCounts {
  const calls = collectCountedCalls(countedMessages, evidence);
  applyTurnResults(calls.byId, resultMessages);
  const counts: TurnOutcomeCounts = {
    blocked: 0,
    failed: calls.failedWithoutId,
    interrupted: calls.interruptedWithoutId,
  };
  calls.byId.forEach((call) => {
    const outcome = classifyTurnStepOutcome(
      call.result,
      deniedResult(call.result, isDenial),
      evidence,
    );
    if (outcome !== undefined) counts[outcome] += 1;
  });
  return counts;
}

/**
 * The outcome steps behind {@link computeRemoteControlTurnOutcomes}, in transcript
 * order, each with its display call and latest result text for the outcome
 * tooltip. Calls without an id are counted there but cannot be listed or
 * jumped to, so they are left out here.
 */
export function getRemoteControlTurnOutcomeSteps(
  countedMessages: readonly RemoteControlChatMessage[],
  resultMessages: readonly RemoteControlChatMessage[] = countedMessages,
  evidence?: TurnOutcomeEvidence,
  isDenial: (output: string) => boolean = () => false,
): TurnOutcomeStepDetail[] {
  const calls = collectCountedCalls(countedMessages, evidence);
  applyTurnResults(calls.byId, resultMessages);
  const steps: TurnOutcomeStepDetail[] = [];
  calls.byId.forEach((call, toolUseId) => {
    const outcome = classifyTurnStepOutcome(
      call.result,
      deniedResult(call.result, isDenial),
      evidence,
    );
    if (outcome === undefined) return;
    const step: TurnOutcomeStepDetail = {
      toolUseId,
      outcome,
      toolName: call.toolName,
      input: call.input,
    };
    if (call.result?.output !== undefined) step.output = call.result.output;
    if (call.result?.interruption !== undefined)
      step.interruption = call.result.interruption;
    steps.push(step);
  });
  return steps;
}

/** An errored result whose text the host recognizes as a denial. */
function deniedResult(
  result: RemoteControlToolResult | undefined,
  isDenial: (output: string) => boolean,
): boolean {
  return result?.isError === true && isDenial(result.output ?? '');
}

/** The `data` of each part of `kind` across `messages`, in order. */
function partData(
  messages: readonly RemoteControlChatMessage[],
  kind: 'tool_use' | 'tool_result',
): Record<string, unknown>[] {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) =>
      part.kind === kind ? [isRecord(part.data) ? part.data : {}] : [],
    ),
  );
}

/**
 * Counted calls keyed by `toolUseId` in first-seen order, each with its
 * folded result. Calls without an id cannot be matched later, so their own
 * folded failures are tallied apart.
 */
function collectCountedCalls(
  messages: readonly RemoteControlChatMessage[],
  evidence?: TurnOutcomeEvidence,
): {
  byId: Map<string, RemoteControlCountedCall>;
  failedWithoutId: number;
  interruptedWithoutId: number;
} {
  const byId = new Map<string, RemoteControlCountedCall>();
  let failedWithoutId = 0;
  let interruptedWithoutId = 0;
  for (const data of partData(messages, 'tool_use')) {
    const toolName = data['toolName'];
    if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') continue;
    const result = readToolResult(data['result']);
    const toolUseId = data['toolUseId'];
    if (typeof toolUseId === 'string' && toolUseId !== '') {
      const previous = byId.get(toolUseId);
      const resolved = result ?? previous?.result;
      byId.set(toolUseId, {
        toolName:
          previous?.toolName ??
          (typeof toolName === 'string' ? toolName : 'tool'),
        input: previous?.input ?? readRemoteControlToolInput(data),
        ...(resolved ? { result: resolved } : {}),
      });
    } else {
      const outcome = classifyTurnStepOutcome(result, false, evidence);
      if (outcome === 'failed') failedWithoutId += 1;
      if (outcome === 'interrupted') interruptedWithoutId += 1;
    }
  }
  return { byId, failedWithoutId, interruptedWithoutId };
}

/** Apply folded and separate results in transcript order, latest wins. */
function applyTurnResults(
  byId: Map<string, RemoteControlCountedCall>,
  messages: readonly RemoteControlChatMessage[],
): void {
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (!isRecord(part.data)) continue;
      const toolUseId = part.data['toolUseId'];
      if (typeof toolUseId !== 'string') continue;
      const call = byId.get(toolUseId);
      if (!call) continue;
      const result =
        part.kind === 'tool_use'
          ? readToolResult(part.data['result'])
          : part.kind === 'tool_result'
            ? readSeparateResult(part.data)
            : undefined;
      if (result) call.result = result;
    }
  }
}

/** A `tool_result` part's result; it only applies with a boolean `isError`. */
function readSeparateResult(
  data: Record<string, unknown>,
): RemoteControlToolResult | undefined {
  const isError = data['isError'];
  if (typeof isError !== 'boolean') return undefined;
  const output = readResultText(data);
  const interruption = readToolInterruption(data['interruption']);
  return {
    isError,
    ...(output === undefined ? {} : { output }),
    ...(interruption === undefined ? {} : { interruption }),
  };
}

/**
 * Whether a message's concluding content is an `ExitPlanMode` plan.
 *
 * A plan-mode turn ends on a tool call, not on prose: the plan lives in the
 * tool input and the message carries no `text`. Desktop's `splitFinalMessages`
 * anchors on the same block, so without this the shared transcript buries a
 * finished plan behind the collapsed "N steps" chip (CAN-3019).
 */
function isExitPlanModeMessage(message: RemoteControlChatMessage): boolean {
  return (message.parts ?? []).some((part) => {
    // `RemoteControlChatPart.data` is `unknown` by contract, so narrow rather than
    // assert: both producers (`runtime-chat-projection` for live frames and
    // `persisted-chat-projection` for a reloaded/seeded transcript) put the
    // raw provider tool name on `data.toolName`.
    const data: unknown = part.data;
    if (
      part.kind !== 'tool_use' ||
      typeof data !== 'object' ||
      data === null ||
      !('toolName' in data)
    ) {
      return false;
    }
    return data.toolName === 'ExitPlanMode';
  });
}

function hasDisplayText(message: RemoteControlChatMessage): boolean {
  return (
    message.text.trim().length > 0 ||
    (message.parts ?? []).some(
      (part) =>
        part.kind === 'text' &&
        isRecord(part.data) &&
        (isClaudeAiCreditsFallbackErrorCode(part.data['errorCode']) ||
          // The Codex account model notice (CAN-4716) rides a text part
          // whose message text is empty, like the AI Credits notice above.
          isCodexAccountModelAccessFailure(part.data['modelAccessFailure'])),
    )
  );
}

/**
 * A host notice that stays beside the final answer when a turn collapses: a
 * system text message, the line where the account proxy moved the chat to
 * another account, or the line where a launch skipped Claude Mods. Mirrors
 * desktop's `splitFinalMessages`.
 */
function isSystemTextMessage(message: RemoteControlChatMessage): boolean {
  return (
    message.role === 'system' &&
    (hasDisplayText(message) ||
      (message.parts ?? []).some(
        (part) =>
          part.kind === 'account_switch' || part.kind === 'mods_skipped',
      ))
  );
}

const TASK_MANAGEMENT_TOOLS = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TodoWrite',
]);

function hasImagePart(message: RemoteControlChatMessage): boolean {
  return (message.parts ?? []).some((part) => part.kind === 'image');
}

function isTaskManagementMessage(message: RemoteControlChatMessage): boolean {
  const parts = message.parts ?? [];
  return (
    message.text.trim().length === 0 &&
    parts.length > 0 &&
    parts.every((part) => {
      if (part.kind !== 'tool_use') return false;
      const data = isRecord(part.data) ? part.data : {};
      return (
        typeof data['toolName'] === 'string' &&
        TASK_MANAGEMENT_TOOLS.has(data['toolName'])
      );
    })
  );
}

/**
 * Split a turn's assistant messages into the collapsed "intermediate" prefix
 * and the inline "final" suffix. The final segment starts at the last message
 * carrying real textual content (the concluding answer), or — when the turn
 * concluded with a plan instead of prose — at that `ExitPlanMode` message; if
 * neither exists, the whole turn is intermediate. Mirrors the intent of the
 * desktop `splitFinalMessages` without its block-level rules.
 *
 * A plan anchor also ENDS the final segment, matching desktop's
 * `trailingToolMessages`: Canopy denies `ExitPlanMode` on purpose, so the
 * provider emits a "the user rejected this tool use" result immediately after
 * the plan. Desktop never renders it on a collapsed turn, and neither may we,
 * or the transcript tells the user they refused the plan they just wrote.
 * Messages after the anchor stay `intermediate`, which also keeps them in the
 * collapsed summary's counts — again matching desktop, whose `computeTurnSummary`
 * tallies intermediate and trailing tool messages together.
 */
function splitFinal(assistant: readonly RemoteControlChatMessage[]): {
  intermediate: RemoteControlChatMessage[];
  final: RemoteControlChatMessage[];
} {
  const hasNotices = assistant.some(isSystemTextMessage);
  let finalStart = assistant.length;
  let finalEnd = assistant.length;
  for (let i = assistant.length - 1; i >= 0; i--) {
    if (hasNotices && isSystemTextMessage(assistant[i])) continue;
    if (
      hasDisplayText(assistant[i]) ||
      hasImagePart(assistant[i]) ||
      isExitPlanModeMessage(assistant[i])
    ) {
      finalStart = i;
      finalEnd = i + 1;
      break;
    }
  }
  if (finalStart < assistant.length) {
    for (let i = finalStart - 1; i >= 0; i--) {
      const message = assistant[i];
      if (hasNotices && isSystemTextMessage(message)) continue;
      if (
        hasDisplayText(message) ||
        hasImagePart(message) ||
        isExitPlanModeMessage(message) ||
        isTaskManagementMessage(message)
      ) {
        finalStart = i;
        continue;
      }
      break;
    }
  }
  if (!hasNotices)
    return {
      intermediate: [
        ...assistant.slice(0, finalStart),
        ...assistant.slice(finalEnd),
      ],
      final: assistant.slice(finalStart, finalEnd),
    };
  return {
    intermediate: [
      ...assistant.slice(0, finalStart),
      ...assistant.slice(finalEnd),
    ].filter((message) => !isSystemTextMessage(message)),
    final: assistant.filter(
      (message, index) =>
        isSystemTextMessage(message) ||
        (index >= finalStart && index < finalEnd),
    ),
  };
}

/**
 * The prefix `@canopy/agent-transcript`'s reducer gives a saved failure row
 * (`handleClaudeErrorEvent` and `applyCodexFailure` in `transcript-parser.ts`).
 */
const SAVED_ERROR_PREFIX = 'Error: ';

/**
 * Drop a saved `Error: <text>` row when the same turn's failed message shows
 * exactly `<text>` (trimmed). The live failed frame and the reducer's saved row
 * are one failure under two ids, and a history merge keeps live rows, so both
 * would render. A row with parts shows more than that text, so it always stays.
 */
function withoutFailureEchoes(
  assistant: RemoteControlChatMessage[],
): RemoteControlChatMessage[] {
  const failures = new Set<string>();
  for (const message of assistant) {
    if (message.role === 'assistant' && message.status === 'failed') {
      const text = message.text.trim();
      if (text.length > 0) failures.add(text);
    }
  }
  if (failures.size === 0) return assistant;
  return assistant.filter(
    (message) =>
      message.role !== 'system' ||
      (message.parts?.length ?? 0) > 0 ||
      !message.text.startsWith(SAVED_ERROR_PREFIX) ||
      !failures.has(message.text.slice(SAVED_ERROR_PREFIX.length).trim()),
  );
}

/** Structural equality for two completed groups (id lists + summary). */
function groupsEqual(
  a: RemoteControlChatTurnGroup,
  b: RemoteControlChatTurnGroup,
): boolean {
  if (a.userMessageId !== b.userMessageId) return false;
  if (a.complete !== b.complete) return false;
  if (a.revertedAt !== b.revertedAt) return false;
  if (a.revertedPreview !== b.revertedPreview) return false;
  if (JSON.stringify(a.wake) !== JSON.stringify(b.wake)) return false;
  if (!arraysEqual(a.intermediateMessageIds, b.intermediateMessageIds)) {
    return false;
  }
  if (!arraysEqual(a.finalMessageIds, b.finalMessageIds)) return false;
  if (!arraysEqual(a.expandedMessageIds ?? [], b.expandedMessageIds ?? [])) {
    return false;
  }
  // Stringify equality is sound here because `summarizeIntermediate` is the only
  // producer of `summary` and always inserts keys in `TOOL_FAMILY_TO_SUMMARY_FIELD`
  // order, so two equal summaries serialize identically. Keep that invariant if
  // another code path ever constructs a summary.
  return JSON.stringify(a.summary) === JSON.stringify(b.summary);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface RawTurn {
  userMessageId: string;
  assistant: RemoteControlChatMessage[];
  /** Turn-timer messages, floated after the final answer for display. */
  timers: RemoteControlChatMessage[];
  complete: boolean;
  wake?: NonNullable<RemoteControlChatTurnGroup['wake']>;
}

/**
 * A canonical timer's turn anchor, or undefined for a legacy timer (no
 * `turnId`) or a canonical execution with no prompt.
 */
function canonicalTimerAnchor(
  message: RemoteControlChatMessage,
): string | undefined {
  const data = isRecord(message.parts?.[0]?.data) ? message.parts[0].data : {};
  return typeof data['turnId'] === 'string' &&
    typeof data['userMessageId'] === 'string'
    ? data['userMessageId']
    : undefined;
}

function readString(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[field];
  return typeof property === 'string' ? property : undefined;
}

/**
 * A wake's timer: a canonical timer with the cause that started its turn
 * (turn-state phase 40c) and no prompt anchor among the turns so far. The
 * continuation after a tools load heads its own turn under its prompt's anchor.
 */
function wakeCause(
  message: RemoteControlChatMessage,
  turnsByUserMessageId: ReadonlyMap<string, RawTurn>,
): Record<string, unknown> | undefined {
  if (!isTurnTimerMessage(message)) return undefined;
  const data = message.parts?.[0]?.data;
  if (!isRecord(data) || typeof data['turnId'] !== 'string') return undefined;
  // The Portal's event stream flattens nested part data to JSON strings.
  let spawnedBy: unknown = data['spawnedBy'];
  if (typeof spawnedBy === 'string') {
    try {
      spawnedBy = JSON.parse(spawnedBy);
    } catch {
      spawnedBy = undefined;
    }
  }
  const anchor = readString(data, 'userMessageId');
  return isRecord(spawnedBy) &&
    (anchor === undefined ||
      !turnsByUserMessageId.has(anchor) ||
      spawnedBy['toolsLoaded'] === true)
    ? spawnedBy
    : undefined;
}

/** Each tool call's label and the prompt whose turn made it, by tool id. */
function toolCallsById(
  messages: readonly RemoteControlChatMessage[],
): Map<string, { taskLabel?: string; userMessageId?: string }> {
  const calls = new Map<
    string,
    { taskLabel?: string; userMessageId?: string }
  >();
  let prompt: string | undefined;
  for (const message of messages) {
    if (startsRootTurn(message)) prompt = message.messageId;
    for (const part of message.parts ?? []) {
      if (part.kind !== 'tool_use') continue;
      const toolUseId = readString(part.data, 'toolUseId');
      if (toolUseId === undefined) continue;
      const rawInput = isRecord(part.data) ? part.data['input'] : undefined;
      let input: unknown = rawInput;
      if (typeof rawInput === 'string') {
        try {
          input = JSON.parse(rawInput);
        } catch {
          input = undefined;
        }
      }
      // A cron job's call names its work by its prompt.
      const taskLabel =
        readString(input, 'description') ??
        readString(input, 'command')?.split('\n')[0] ??
        readString(input, 'prompt')?.split('\n')[0];
      calls.set(toolUseId, {
        ...(taskLabel ? { taskLabel: taskLabel.slice(0, 120) } : {}),
        ...(prompt === undefined ? {} : { userMessageId: prompt }),
      });
    }
  }
  return calls;
}

/** Projected child/steering input retains the root prompt's turn ownership. */
function startsRootTurn(message: RemoteControlChatMessage): boolean {
  return message.role === 'user' && message.continuesTurn !== true;
}

/** Partition an ordered message list into user-anchored turns. */
function partitionTurns(
  messages: readonly RemoteControlChatMessage[],
): RawTurn[] {
  const turns: RawTurn[] = [];
  let toolCalls:
    | Map<string, { taskLabel?: string; userMessageId?: string }>
    | undefined;
  const turnsByUserMessageId = new Map<string, RawTurn>();
  // A prompt's later executions (a Stop and Resume) after its tools-loaded
  // continuation belong to that continuation's turn.
  const continuations = new Map<string, RawTurn>();
  let current: RawTurn | null = null;
  for (const message of messages) {
    if (startsRootTurn(message)) {
      if (current) {
        current.complete = true;
      }
      current = {
        userMessageId: message.messageId,
        assistant: [],
        timers: [],
        complete: true,
      };
      turns.push(current);
      turnsByUserMessageId.set(message.messageId, current);
      continue;
    }
    // A wake heads its own turn, as on desktop (turn-state phase 40e).
    const spawnedBy = wakeCause(message, turnsByUserMessageId);
    if (spawnedBy !== undefined) {
      if (current) current.complete = true;
      const toolUseId = readString(spawnedBy, 'toolUseId');
      toolCalls ??= toolCallsById(messages);
      const call =
        toolUseId === undefined ? undefined : toolCalls.get(toolUseId);
      // A tools-loaded continuation's load call is in its prompt's turn; when
      // the call's id isn't the transcript's, link the prompt.
      const spawningUserMessageId =
        call?.userMessageId ??
        (spawnedBy['toolsLoaded'] === true
          ? canonicalTimerAnchor(message)
          : undefined);
      current = {
        userMessageId: message.messageId,
        assistant: [],
        timers: [message],
        complete: isTerminalStatus(message.status),
        wake: {
          ...(call?.taskLabel === undefined
            ? {}
            : { taskLabel: call.taskLabel }),
          ...(spawningUserMessageId === undefined
            ? {}
            : { spawningUserMessageId }),
          ...(call === undefined ? {} : { spawningToolUseId: toolUseId }),
          ...(spawnedBy['event'] === true ? { event: true } : {}),
          ...(spawnedBy['scheduled'] === true ? { scheduled: true } : {}),
          ...(spawnedBy['toolsLoaded'] === true ? { toolsLoaded: true } : {}),
        },
      };
      turns.push(current);
      const anchor = canonicalTimerAnchor(message);
      if (spawnedBy['toolsLoaded'] === true && anchor !== undefined)
        continuations.set(anchor, current);
      continue;
    }
    // Assistant/system messages before any user message have no anchor to
    // attach to; skip them (they do not occur in normal transcripts).
    if (!current) {
      continue;
    }
    // A canonical timer joins its anchor's turn wherever it was appended, as
    // desktop places it (turn-state phase 40b).
    const anchor = isTurnTimerMessage(message)
      ? canonicalTimerAnchor(message)
      : undefined;
    const turn =
      (anchor === undefined
        ? undefined
        : (continuations.get(anchor) ?? turnsByUserMessageId.get(anchor))) ??
      current;
    if (isTurnTimerMessage(message)) {
      turn.timers.push(message);
    } else {
      turn.assistant.push(message);
    }
    if (!isTerminalStatus(message.status)) {
      turn.complete = false;
    }
  }
  return turns;
}

/**
 * Compute turn groups from an ordered message list, reusing cached object
 * references for completed groups that have not changed. The caller owns the
 * `cache` and passes it in; this function mutates it in place. A chat-id
 * mismatch transparently resets the cache.
 */
export function computeIncrementalTurnGroups(
  chatId: string,
  messages: readonly RemoteControlChatMessage[],
  cache: TurnGroupCache,
  latestTurnActive = false,
): RemoteControlChatTurnGroup[] {
  if (cache.chatId !== chatId) {
    cache.chatId = chatId;
    cache.completedGroups = new Map();
  }

  const turns = partitionTurns(messages);
  const nextCompleted = new Map<string, RemoteControlChatTurnGroup>();

  const result = turns.map((turn, index): RemoteControlChatTurnGroup => {
    const complete =
      turn.complete && (!latestTurnActive || index < turns.length - 1);
    const dedupedAssistant = withoutFailureEchoes(turn.assistant);
    const { intermediate, final } = splitFinal(dedupedAssistant);
    const visibleIntermediate = complete ? intermediate : [];
    const visibleFinal = complete ? final : dedupedAssistant;
    const group: RemoteControlChatTurnGroup = {
      userMessageId: turn.userMessageId,
      ...(turn.wake === undefined ? {} : { wake: turn.wake }),
      intermediateMessageIds: visibleIntermediate.map((m) => m.messageId),
      // Timers render after the concluding answer (and outside the collapsed
      // intermediate chip), matching the desktop transcript order.
      finalMessageIds: [
        ...visibleFinal.map((m) => m.messageId),
        ...turn.timers.map((m) => m.messageId),
      ],
      expandedMessageIds: [
        ...dedupedAssistant.map((m) => m.messageId),
        ...turn.timers.map((m) => m.messageId),
      ],
      complete,
      summary: summarizeIntermediate(visibleIntermediate),
    };

    if (!complete) {
      // Streaming turns change every frame; never cache them.
      return group;
    }

    const cached = cache.completedGroups.get(turn.userMessageId);
    const resolved = cached && groupsEqual(cached, group) ? cached : group;
    nextCompleted.set(turn.userMessageId, resolved);
    return resolved;
  });

  cache.completedGroups = nextCompleted;
  return result;
}
