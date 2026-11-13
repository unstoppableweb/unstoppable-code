import type { ChatMessage } from '@/stores/chatStore';
import type { AgentUsage } from '@canopy/desktop-shared/types';
import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import {
  reorderMessagesForDisplay,
  mergeToolResults,
} from './message-transforms';
import {
  groupIntoTurns,
  TASK_MGMT_TOOLS,
} from '@canopy/desktop-shared/lib/turn-utils';
import type {
  DisplayBlock,
  DisplayMessage,
  TurnGroup,
  TurnGroupOrMessage,
} from './types';
import { beginTranscriptPerformanceStage } from '@/lib/transcript-performance';

/**
 * True when a turn group has at least one assistant block that's worth
 * forking from — anything other than turn timers and task-management tool
 * calls. Used to skip past empty / cancelled-with-no-content turns when
 * picking the latest forkable point in the transcript.
 */
export function hasForkableAssistantContent(group: TurnGroup): boolean {
  return group.assistantMessages.some((m) =>
    m.blocks.some(
      (b) =>
        b.type !== 'turn_timer' &&
        !(b.type === 'tool_use' && TASK_MGMT_TOOLS.has(b.toolName)),
    ),
  );
}

export function findLastForkableTurnGroupIndex(
  turnGroups: TurnGroupOrMessage[],
): number {
  for (let i = turnGroups.length - 1; i >= 0; i--) {
    const item = turnGroups[i];
    if (
      item.kind === 'turn-group' &&
      // A fork cuts at a prompt, and a prompt's cut includes its wakes.
      item.userMessage.role === 'user' &&
      item.isComplete &&
      hasForkableAssistantContent(item)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * The display group holding a search match. Search reports a prompt's indexed
 * turn, and a wake in it has its own group (turn-state phase 40d).
 */
export function searchTurnGroupId(
  turnGroups: readonly TurnGroupOrMessage[],
  selection:
    | { turnId: string; messageId: string; renderMessageId?: string }
    | null
    | undefined,
): string | undefined {
  if (!selection) return undefined;
  const target = selection.renderMessageId ?? selection.messageId;
  for (const item of turnGroups) {
    if (
      item.kind === 'turn-group' &&
      item.assistantMessages.some((message) => message.id === target)
    )
      return item.userMessage.id;
  }
  return selection.turnId;
}

// ---------------------------------------------------------------------------
// Cache structure — keyed by chatId so tab switches invalidate
// ---------------------------------------------------------------------------

export interface TurnGroupCache {
  /** Which chat this cache belongs to. */
  chatId: string;
  /** Completed turn groups from the previous computation, keyed by user message id. */
  completedGroups: Map<string, TurnGroup>;
  /**
   * The previous computation's merged display messages. `mergeToolResults`
   * shares every structurally unchanged message and block with it, so a
   * completed turn's merged tool results keep their identity (its revision)
   * across recomputations and unchanged active-turn blocks skip `memo`.
   */
  displayMessages: DisplayMessage[];
}

export function createEmptyTurnGroupCache(): TurnGroupCache {
  return { chatId: '', completedGroups: new Map(), displayMessages: [] };
}

// ---------------------------------------------------------------------------
// Structural comparison — determines if a cached group can be reused
// ---------------------------------------------------------------------------

function usageMatch(
  a: AgentUsage | undefined,
  b: AgentUsage | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.apiCalls === b.apiCalls &&
    a.toolUses === b.toolUses &&
    a.contextTokens === b.contextTokens &&
    a.outputTokens === b.outputTokens &&
    a.durationMs === b.durationMs &&
    a.model === b.model &&
    a.contextWindow === b.contextWindow &&
    a.cacheReadInputTokens === b.cacheReadInputTokens &&
    a.cacheCreationInputTokens === b.cacheCreationInputTokens
  );
}

/**
 * Shared by both halves of the CAN-1814 late-attachment bug class: the
 * `resultMatch` (tool_result / MCP failures) and `text` (provider failures)
 * branches of `blocksMatch` both call this so a structured `authFailure`
 * that attaches via a follow-up `canopy_auth_failure` event — without
 * changing the block's other fields — still busts a cached completed turn
 * group. Keeping one helper for both call sites is deliberate: the two
 * paths must not drift back out of sync with each other.
 */
function authFailureMatch(
  a: AuthFailureFields | undefined,
  b: AuthFailureFields | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.authFailure === b.authFailure && a.authFailures === b.authFailures) {
    return true;
  }
  // Both fields, because the checklist writes the array and the scalar together
  // and a late event can add either (CAN-1814 PR 2).
  return (
    JSON.stringify([a.authFailure, a.authFailures]) ===
    JSON.stringify([b.authFailure, b.authFailures])
  );
}

/** The auth-failure fields a block may carry, on either the text or result path. */
interface AuthFailureFields {
  authFailure?: AuthDependencyFailure;
  authFailures?: AuthDependencyFailure[];
}

function resultMatch(
  a: ({ output: string; isError: boolean } & AuthFailureFields) | undefined,
  b: ({ output: string; isError: boolean } & AuthFailureFields) | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.output === b.output &&
    a.isError === b.isError &&
    // A structured auth failure (CAN-1814) can attach to an already-streamed
    // tool_result via a follow-up `canopy_auth_failure` event without
    // changing `output`/`isError`. Without this check the cached turn group
    // would look unchanged and the reconnect CTA would render stale — the
    // same class of bug the `workflow` and `codex_agent` branches above
    // guard against for their own late-arriving fields.
    authFailureMatch(a, b)
  );
}

/**
 * Deep-compare two `agentsStates` records. Used by `blocksMatch` so a Codex
 * subagent status update (e.g. `running` → `completed`) busts the cached
 * turn group and the spinner / error label re-render correctly.
 */
function agentsStatesMatch(
  a: Record<string, { status: string; message?: string | null }>,
  b: Record<string, { status: string; message?: string | null }>,
): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const av = a[key];
    const bv = b[key];
    if (!bv) return false;
    if (av.status !== bv.status) return false;
    // Treat null and undefined as equivalent for `message` so a snapshot that
    // explicitly clears the field doesn't mismatch one that simply omits it.
    if ((av.message ?? null) !== (bv.message ?? null)) return false;
  }
  return true;
}

/**
 * Block types with a dedicated field-by-field branch in `blocksMatch`.
 * Anything else falls back to a structural (JSON) comparison so the
 * "any meaningful content differs → false" contract holds for every
 * DisplayBlock variant, including ones added later.
 */
const FIELD_COMPARED_BLOCK_TYPES = new Set<DisplayBlock['type']>([
  'text',
  'thinking',
  'agent',
  'codex_agent',
  'tool_use',
  'workflow',
]);

/**
 * Recursively compare two DisplayBlock arrays. Returns false if any
 * meaningful content differs — block types, results, agent sub-blocks,
 * or usage data.
 */
function blocksMatch(a: DisplayBlock[], b: DisplayBlock[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const blkA = a[i];
    const blkB = b[i];
    // Shared (identical) blocks are equal by construction: display blocks are
    // never mutated, so this identity check stands in for the field and JSON
    // comparisons below on every block `mergeToolResults` carried forward.
    if (blkA === blkB) continue;
    if (blkA.type !== blkB.type) return false;
    if (blkA.type === 'text' && blkB.type === 'text') {
      if (
        blkA.text !== blkB.text ||
        blkA.errorCode !== blkB.errorCode ||
        blkA.providerErrorDetails !== blkB.providerErrorDetails ||
        (blkA.modelAccessFailure !== blkB.modelAccessFailure &&
          JSON.stringify(blkA.modelAccessFailure) !==
            JSON.stringify(blkB.modelAccessFailure))
      )
        return false;
      if (
        (blkA.asyncQuestion !== blkB.asyncQuestion &&
          JSON.stringify(blkA.asyncQuestion) !==
            JSON.stringify(blkB.asyncQuestion)) ||
        (blkA.asyncQuestionAnswer !== blkB.asyncQuestionAnswer &&
          JSON.stringify(blkA.asyncQuestionAnswer) !==
            JSON.stringify(blkB.asyncQuestionAnswer))
      )
        return false;
      // A structured provider authFailure (CAN-1814) can attach to an
      // already-streamed text block via a follow-up `canopy_auth_failure`
      // event without changing `text` — see `authFailureMatch`'s doc
      // comment on the `resultMatch` (tool_result) half of this same bug
      // class.
      if (!authFailureMatch(blkA, blkB)) return false;
    }
    if (blkA.type === 'thinking' && blkB.type === 'thinking') {
      if (blkA.text !== blkB.text) return false;
    }
    if (blkA.type === 'agent' && blkB.type === 'agent') {
      if (!resultMatch(blkA.result, blkB.result)) return false;
      if (!resultMatch(blkA.taskOutputResult, blkB.taskOutputResult)) {
        return false;
      }
      if (!usageMatch(blkA.usage, blkB.usage)) return false;
      if (!blocksMatch(blkA.subBlocks, blkB.subBlocks)) return false;
    }
    // Codex codex_agent: cached groups must invalidate when status,
    // agentsStates, prompt, display metadata, sub-blocks, or usage change.
    // Without this branch, a late subagent message arriving on a completed
    // turn would look structurally identical to the cached version and the
    // subagent transcript would render stale (Phase F3 §6).
    if (blkA.type === 'codex_agent' && blkB.type === 'codex_agent') {
      if (blkA.agentBlockId !== blkB.agentBlockId) return false;
      if (blkA.status !== blkB.status) return false;
      if (blkA.prompt !== blkB.prompt) return false;
      if (blkA.displayName !== blkB.displayName) return false;
      if (blkA.description !== blkB.description) return false;
      if (blkA.model !== blkB.model) return false;
      if (blkA.reasoningEffort !== blkB.reasoningEffort) return false;
      if (!agentsStatesMatch(blkA.agentsStates, blkB.agentsStates)) {
        return false;
      }
      if (!usageMatch(blkA.usage, blkB.usage)) return false;
      if (!blocksMatch(blkA.subBlocks, blkB.subBlocks)) return false;
    }
    if (blkA.type === 'tool_use' && blkB.type === 'tool_use') {
      if (blkA.toolUseId !== blkB.toolUseId) return false;
      if (blkA.toolName !== blkB.toolName) return false;
      if (blkA.input !== blkB.input) return false;
      if (!resultMatch(blkA.result, blkB.result)) return false;
    }
    // Background workflows return their launch receipt as a tool_result that
    // can arrive after the turn already completed; mergeToolResults folds it
    // into this block without changing the group's message structure, so the
    // result must participate in the comparison or the receipt renders stale.
    if (blkA.type === 'workflow' && blkB.type === 'workflow') {
      if (blkA.toolUseId !== blkB.toolUseId) return false;
      if (blkA.workflowName !== blkB.workflowName) return false;
      if (blkA.summary !== blkB.summary) return false;
      if (blkA.runId !== blkB.runId) return false;
      if (blkA.transcriptDir !== blkB.transcriptDir) return false;
      if (!resultMatch(blkA.result, blkB.result)) return false;
    }
    // Marker blocks (turn timers, hook/automation/revert info, file
    // references, …) are small; compare them structurally so a content
    // change in any variant without a dedicated branch still busts the cache.
    if (!FIELD_COMPARED_BLOCK_TYPES.has(blkA.type)) {
      if (JSON.stringify(blkA) !== JSON.stringify(blkB)) return false;
    }
  }
  return true;
}

/**
 * Returns true when two completed turn groups are structurally identical —
 * same messages, same block structure, same agent results and usage. When
 * true the caller can reuse the cached object reference so that React.memo
 * skips re-rendering.
 */
function turnGroupsMatch(a: TurnGroup, b: TurnGroup): boolean {
  if (a === b) return true;
  if (a.isComplete !== b.isComplete) return false;
  // A wake's head row gains its label and link once older history loads.
  if (!blocksMatch(a.userMessage.blocks, b.userMessage.blocks)) return false;
  if (a.assistantMessages.length !== b.assistantMessages.length) return false;
  for (let i = 0; i < a.assistantMessages.length; i++) {
    if (a.assistantMessages[i].id !== b.assistantMessages[i].id) return false;
    if (
      !blocksMatch(a.assistantMessages[i].blocks, b.assistantMessages[i].blocks)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Frozen-turn check: true when a completed turn's grouping is unchanged by
 * identity — the same user and assistant display messages (which
 * `mergeToolResults` shares while their content is unchanged). Identical
 * inputs make `turnGroupsMatch` true, so this only skips its block walk; any
 * changed identity falls through to the full `turnGroupsMatch` comparison.
 */
function sameTurnRevision(cached: TurnGroup, next: TurnGroup): boolean {
  if (
    cached.isComplete !== next.isComplete ||
    cached.userMessage !== next.userMessage ||
    cached.assistantMessages.length !== next.assistantMessages.length
  ) {
    return false;
  }
  for (let index = 0; index < next.assistantMessages.length; index += 1) {
    if (cached.assistantMessages[index] !== next.assistantMessages[index]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Core computation — always runs the full pipeline for correctness,
// preserves referential identity of completed groups for React.memo.
// ---------------------------------------------------------------------------

/**
 * Compute turn groups from the full message list. Completed turn groups that
 * are structurally identical to their cached versions are returned by reference
 * so React.memo can skip re-rendering them.
 *
 * Unlike a split/slice approach, this always processes the complete message
 * list through `mergeToolResults`, which guarantees that late-arriving
 * background-agent sub-messages (with `parentToolUseId` pointing into
 * earlier turns) are correctly folded into their parent agent blocks.
 *
 * The caller owns the `cache` object (e.g. via `useRef`) and passes it in.
 * This function mutates it in-place.
 */
export function computeIncrementalTurnGroups(
  chatId: string,
  messages: ChatMessage[],
  agentUsage: Record<string, AgentUsage> | undefined,
  cache: TurnGroupCache,
): TurnGroupOrMessage[] {
  const finishPerformanceStage = beginTranscriptPerformanceStage(
    'turn_grouping',
    { messages: messages.length },
  );
  // Invalidate cache on chat switch
  if (cache.chatId !== chatId) {
    cache.chatId = chatId;
    cache.completedGroups = new Map();
    cache.displayMessages = [];
  }

  // Always run the full pipeline — correctness first. Structural sharing
  // against the previous run keeps unchanged messages and blocks identical.
  const displayMessages = mergeToolResults(
    reorderMessagesForDisplay(messages),
    agentUsage,
    cache.displayMessages,
  );
  cache.displayMessages = displayMessages;
  const groups = groupIntoTurns(displayMessages);

  // Preserve referential identity of completed groups
  const nextCompleted = new Map<string, TurnGroup>();
  const result: TurnGroupOrMessage[] = groups.map(
    (group: TurnGroupOrMessage): TurnGroupOrMessage => {
      if (group.kind === 'turn-group' && group.isComplete) {
        const key = group.userMessage.id;
        const cached = cache.completedGroups.get(key);
        const resolved: TurnGroup =
          cached &&
          (sameTurnRevision(cached, group) || turnGroupsMatch(cached, group))
            ? cached
            : group;
        nextCompleted.set(key, resolved);
        return resolved;
      }
      return group;
    },
  );

  cache.completedGroups = nextCompleted;
  finishPerformanceStage({ groups: result.length });
  return result;
}
