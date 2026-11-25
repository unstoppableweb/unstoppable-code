import { createHash } from 'node:crypto';
import {
  TOOL_SETTLEMENT_OUTPUT,
  type ToolInterruptionReason,
} from '@canopy/protocol/remote-control/shell';
import {
  persistedInterruptedSettlementTime,
  persistedInterruptedTurnRange,
  persistedTurnEndsInAnswer,
  isSyntheticSettlementMessage,
  supersedeToolInterruptions,
  type SettlementAnswerTracker,
} from '@canopy/agent-transcript/settlement';
import { isRootUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import type {
  ChatCoreMutation,
  ChatRuntimeState,
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  hydrateChatTurnState,
  initialChatTurnState,
  serializeChatTurnState,
  settleChatTurnForRestart,
} from '@canopy/agent-transcript/turn';
import { withTurnEnd } from './chat-turn-ends';
import { withInterruptedTurn } from './chat-turn-succession';

/** Whether persisted reducer state still records a live turn, irrespective of
 * the legacy runtime status. Host reconciliation owns the liveness decision.
 */
export function hasOpenPersistedChatTurn(value: unknown): boolean {
  return hydrateChatTurnState(value)?.current !== undefined;
}

/**
 * Close every open `turn_timer` block. Used when a transcript leaves live
 * streaming ownership (archive of an interrupted chat, fork of a streaming
 * source) so the copy never renders a running timer.
 */
export function closeOpenPersistedTurnTimers(
  messages: PersistedChatMessage[],
  completedAt: number,
): PersistedChatMessage[] {
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const blocks = message.blocks.map((block) => {
      if (block.type !== 'turn_timer' || block.completedAt !== null) {
        return block;
      }
      changed = true;
      messageChanged = true;
      const startedAt =
        typeof block.startedAt === 'number' &&
        Number.isFinite(block.startedAt) &&
        block.startedAt >= 0
          ? block.startedAt
          : completedAt;
      const elapsed = Math.max(0, completedAt - startedAt);
      const accumulatedPause = block.accumulatedPausedDurationMs;
      const pausedAt = block.pausedAt;
      const pausedDuration =
        (typeof accumulatedPause === 'number' &&
        Number.isFinite(accumulatedPause)
          ? Math.max(0, accumulatedPause)
          : 0) +
        (typeof pausedAt === 'number' && Number.isFinite(pausedAt)
          ? Math.max(0, completedAt - pausedAt)
          : 0);
      return {
        ...block,
        completedAt,
        ...(block.pausedAt !== undefined ? { pausedAt: null } : {}),
        ...(block.accumulatedPausedDurationMs !== undefined ||
        block.pausedAt != null
          ? {
              accumulatedPausedDurationMs: Math.min(elapsed, pausedDuration),
            }
          : {}),
      };
    });
    return messageChanged ? { ...message, blocks } : message;
  });
  return changed ? result : messages;
}

interface SettleToolResultGroup {
  parentToolUseId?: string;
  parentBlockId?: string;
  codexThreadId?: string;
  codexTurnId?: string;
  blocks: PersistedChatBlock[];
}

function settleToolResultGroupKey(message: PersistedChatMessage): string {
  const parentKey =
    message.parentBlockId !== undefined
      ? `block:${message.parentBlockId}|tool:${message.parentToolUseId ?? ''}`
      : `tool:${message.parentToolUseId ?? ''}`;
  return [
    parentKey,
    `codexThread:${message.codexThreadId ?? ''}`,
    `codexTurn:${message.codexTurnId ?? ''}`,
  ].join('|');
}

/** Background child results can arrive after another root prompt. */
function collectChildToolResultIds(
  messages: readonly PersistedChatMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!message.parentBlockId && !message.parentToolUseId) continue;
    for (const block of message.blocks) {
      if (block.type === 'tool_result') {
        ids.add(
          JSON.stringify([settleToolResultGroupKey(message), block.toolUseId]),
        );
      }
    }
  }
  return ids;
}

/**
 * Append error `tool_result` blocks for every `tool_use` that never received
 * one, grouped so nested/codex results keep their parent identity. `output`
 * names the reason the tool never completed (e.g. `Cancelled`).
 */
export function closeOpenPersistedToolUses(
  messages: PersistedChatMessage[],
  completedAt: number,
  output: string = TOOL_SETTLEMENT_OUTPUT.stopped,
  reason: ToolInterruptionReason = output === TOOL_SETTLEMENT_OUTPUT.app_restart
    ? 'app_restart'
    : output === TOOL_SETTLEMENT_OUTPUT.fork
      ? 'fork'
      : 'stopped',
): PersistedChatMessage[] {
  // Resolve tools within each owning turn, including later result messages.
  messages = supersedeToolInterruptions(messages);
  const childResultIds = collectChildToolResultIds(messages);
  const boundaries = messages.flatMap((message, index) =>
    index > 0 && isRootUserTurnBoundary(message) ? [index] : [],
  );
  if (boundaries.length) {
    let start = 0;
    let changed = false;
    const result: PersistedChatMessage[] = [];
    for (const end of [...boundaries, messages.length]) {
      const turn = messages.slice(start, end);
      const settled = closeOpenPersistedToolUsesInTurn(
        turn,
        completedAt,
        output,
        reason,
        childResultIds,
      );
      changed ||= settled !== turn;
      result.push(...settled);
      start = end;
    }
    return changed ? result : messages;
  }
  return closeOpenPersistedToolUsesInTurn(
    messages,
    completedAt,
    output,
    reason,
    childResultIds,
  );
}

function closeOpenPersistedToolUsesInTurn(
  messages: PersistedChatMessage[],
  completedAt: number,
  output: string,
  reason: ToolInterruptionReason,
  childResultIds: ReadonlySet<string>,
): PersistedChatMessage[] {
  messages = supersedeToolInterruptions(messages);
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') {
        toolResultIds.add(
          JSON.stringify([settleToolResultGroupKey(message), block.toolUseId]),
        );
      }
    }
  }

  const unmatchedByParent = new Map<string, SettleToolResultGroup>();
  const unmatchedGroups: SettleToolResultGroup[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      const resultKey = JSON.stringify([
        settleToolResultGroupKey(message),
        block.toolUseId,
      ]);
      if (
        toolResultIds.has(resultKey) ||
        ((message.parentBlockId || message.parentToolUseId) &&
          childResultIds.has(resultKey))
      ) {
        continue;
      }
      const key = settleToolResultGroupKey(message);
      let entry = unmatchedByParent.get(key);
      if (!entry) {
        entry = {
          ...(message.parentToolUseId
            ? { parentToolUseId: message.parentToolUseId }
            : {}),
          ...(message.parentBlockId
            ? { parentBlockId: message.parentBlockId }
            : {}),
          ...(message.codexThreadId
            ? { codexThreadId: message.codexThreadId }
            : {}),
          ...(message.codexTurnId ? { codexTurnId: message.codexTurnId } : {}),
          blocks: [],
        };
        unmatchedByParent.set(key, entry);
        unmatchedGroups.push(entry);
      }
      entry.blocks.push({
        type: 'tool_result',
        toolUseId: block.toolUseId,
        toolName: block.toolName,
        output,
        isError: true,
        interruption: { reason, at: completedAt },
      });
    }
  }

  if (unmatchedByParent.size === 0) {
    return messages;
  }

  const result = [...messages];
  let index = 0;
  for (const entry of unmatchedGroups) {
    result.push({
      id: `archive-cancel-${completedAt}-${createHash('sha256')
        .update(
          JSON.stringify([
            messages[0]?.id,
            index,
            entry.blocks.flatMap((block) =>
              block.type === 'tool_result' ? [block.toolUseId] : [],
            ),
          ]),
        )
        .digest('hex')
        .slice(0, 20)}`,
      role: 'system',
      timestamp: completedAt,
      ...(entry.parentToolUseId
        ? { parentToolUseId: entry.parentToolUseId }
        : {}),
      ...(entry.parentBlockId ? { parentBlockId: entry.parentBlockId } : {}),
      ...(entry.codexThreadId ? { codexThreadId: entry.codexThreadId } : {}),
      ...(entry.codexTurnId ? { codexTurnId: entry.codexTurnId } : {}),
      blocks: entry.blocks,
    });
    index += 1;
  }
  return result;
}

/**
 * Settle a transcript snapshot cloned out of a still-streaming source: close
 * open timers and mark unfinished tool uses as interrupted, so the copy is an
 * idle, independently editable record while the original turn continues.
 */
export function settlePersistedForkMessages(
  messages: PersistedChatMessage[],
  completedAt: number,
): PersistedChatMessage[] {
  return closeOpenPersistedToolUses(
    closeOpenPersistedTurnTimers(messages, completedAt),
    completedAt,
    TOOL_SETTLEMENT_OUTPUT.fork,
  );
}

/**
 * What restart cleanup knows about an orphaned turn beyond its transcript.
 * Callers read these before cleanup clears them; a fact a caller cannot
 * establish must be reported as present, never assumed absent.
 */
export interface PersistedTurnSettlementFacts {
  /**
   * Whether the turn's last root row is a saved answer, for callers whose
   * `messages` are body-free evidence. Derived from `messages` when omitted.
   */
  endsInAnswer?: boolean;
  /** A synchronous question the provider still awaited. */
  pendingQuestion: boolean;
  /** A Claude terminal still running or starting the turn. */
  terminalActive: boolean;
  /**
   * Whether a quit recorded this turn as still running. Asked only when every
   * other fact says the turn completed; a record keeps it interrupted, since
   * the app saw the turn live when it quit.
   */
  hasShutdownRecord: (userMessageId: string) => Promise<boolean>;
}

export type PersistedTurnSettlementOutcome = 'completed' | 'interrupted';

export interface PersistedTurnSettlement {
  /**
   * How the turn settled. `completed` only when its answer was saved and
   * nothing was left open (CAN-7612); otherwise `interrupted`.
   */
  outcome: PersistedTurnSettlementOutcome;
  /** The settled turn's prompt, when the runtime named one. */
  userMessageId?: string;
  mutations: ChatCoreMutation[];
}

const ANSWER_SETTLEMENT_STATUSES: readonly ChatRuntimeState['status'][] = [
  'streaming',
  'completing',
];

/**
 * Atomically settle a transcript and its runtime when live host ownership is
 * lost. Only changed or appended messages are upserted so restart recovery
 * does not rewrite an otherwise unchanged transcript.
 *
 * A turn whose answer was saved, with no tool, question, pause or terminal
 * left open and no quit record of it still running, settles as completed
 * (CAN-7612): its timer closes at its last activity and nothing offers to
 * resume it. Any other turn settles as interrupted, awaiting a resume.
 */
export async function buildPersistedTurnSettlement(
  chatId: string,
  messages: PersistedChatMessage[],
  runtime: ChatRuntimeState,
  completedAt: number,
  queuedMessageIds: string[],
  tab:
    | Pick<
        PersistedChatTab,
        'id' | 'interruptedTurns' | 'turnEnds' | 'trackedPlanImplementation'
      >
    | undefined,
  facts: PersistedTurnSettlementFacts,
): Promise<PersistedTurnSettlement> {
  const reducerTurn = hydrateChatTurnState(runtime.turn);
  const currentTurn = reducerTurn?.current;
  if (
    currentTurn?.userMessageId &&
    runtime.activeTurn &&
    currentTurn.userMessageId !== runtime.activeTurn.userMessageId
  )
    return { outcome: 'interrupted', mutations: [] };
  const activeTurn =
    runtime.activeTurn ??
    (currentTurn?.userMessageId
      ? {
          userMessageId: currentTurn.userMessageId,
          startedAt: currentTurn.startedAtMs,
        }
      : undefined);
  const settlementRuntime = activeTurn ? { ...runtime, activeTurn } : runtime;
  const range = persistedInterruptedTurnRange(
    messages,
    activeTurn?.userMessageId,
  );
  const interrupted = messages.slice(range.start, range.end);
  completedAt = persistedInterruptedSettlementTime(
    messages,
    completedAt,
    settlementRuntime,
  );
  const reconciledInterrupted = supersedeToolInterruptions(messages).slice(
    range.start,
    range.end,
  );
  const timedMessages = closeOpenPersistedTurnTimers(
    reconciledInterrupted,
    completedAt,
  );
  const settledMessages = closeOpenPersistedToolUsesInTurn(
    timedMessages,
    completedAt,
    TOOL_SETTLEMENT_OUTPUT.app_restart,
    'app_restart',
    collectChildToolResultIds(messages),
  );
  const userMessageId = activeTurn?.userMessageId;
  const openPause = [currentTurn, reducerTurn?.lastEnded].some((turn) =>
    turn?.pauses.some((pause) => pause.endedAtMs === undefined),
  );
  // Closing any tool, root or child, means work was cut off, whatever the
  // root text suggested. An open timer alone is expected.
  const outcome: PersistedTurnSettlementOutcome =
    userMessageId !== undefined &&
    messages[range.start]?.id === userMessageId &&
    ANSWER_SETTLEMENT_STATUSES.includes(runtime.status) &&
    !facts.pendingQuestion &&
    !facts.terminalActive &&
    !openPause &&
    (facts.endsInAnswer ??
      persistedTurnEndsInAnswer(messages, userMessageId)) &&
    settledMessages.length === timedMessages.length &&
    !(await facts.hasShutdownRecord(userMessageId))
      ? 'completed'
      : 'interrupted';
  const mutations: ChatCoreMutation[] = settledMessages.flatMap(
    (message, index) =>
      message === interrupted[index]
        ? []
        : [
            {
              type: 'message.upserted' as const,
              chatId,
              message,
              ...(index >= interrupted.length && interrupted.length
                ? { afterMessageId: settledMessages[index - 1].id }
                : {}),
            },
          ],
  );
  const settledRuntime = { ...runtime };
  const turn = reducerTurn ?? initialChatTurnState();
  delete settledRuntime.activeTurn;
  delete settledRuntime.deferredToolsReload;
  if (outcome === 'completed' && userMessageId !== undefined) {
    // Record the end a clean completion records, so every surface that reads
    // turn ends, Remote Control included, reports it completed.
    if (tab)
      mutations.push({
        type: 'tab.metadata_patched',
        tabId: tab.id,
        patch: {
          turnEnds: withTurnEnd(
            tab.turnEnds,
            userMessageId,
            'completed',
            completedAt,
            tab.trackedPlanImplementation?.userMessageId,
          ),
        },
      });
    delete settledRuntime.error;
    delete settledRuntime.emptyCompletionRecovery;
    mutations.push({
      type: 'runtime.patched',
      chatId,
      runtime: {
        ...settledRuntime,
        turn: serializeChatTurnState(
          settleChatTurnForRestart(turn, completedAt, 'completed').state,
        ),
        status: 'completed',
        queuedMessageIds,
        lastActivityAt: completedAt,
      },
    });
    return { outcome, userMessageId, mutations };
  }
  if (tab && activeTurn) {
    mutations.push({
      type: 'tab.metadata_patched',
      tabId: tab.id,
      patch: {
        interruptedTurns: withInterruptedTurn(
          tab.interruptedTurns,
          activeTurn.userMessageId,
        ),
      },
    });
  }
  const settledTurn = settleChatTurnForRestart(turn, completedAt);
  mutations.push({
    type: 'runtime.patched',
    chatId,
    runtime: {
      ...settledRuntime,
      turn: serializeChatTurnState(settledTurn.state),
      status: 'interrupted',
      queuedMessageIds,
      lastActivityAt: completedAt,
      error: {
        code: 'interrupted',
        message: 'The provider turn was interrupted by an app restart.',
        retryable: true,
        occurredAt: new Date(completedAt).toISOString(),
      },
    },
  });
  return {
    outcome,
    ...(userMessageId !== undefined ? { userMessageId } : {}),
    mutations,
  };
}

/** Archive/restore settlement uses original activity rather than the archive action time. */
export function settlePersistedInterruptedMessages(
  messages: PersistedChatMessage[],
  detectedAt: number,
  runtime?: ChatRuntimeState,
): PersistedChatMessage[] {
  messages = supersedeToolInterruptions(messages);
  const childResultIds = collectChildToolResultIds(messages);
  const boundaries = messages.flatMap((message, index) =>
    index > 0 && isRootUserTurnBoundary(message) ? [index] : [],
  );
  let start = 0;
  let changed = false;
  const result: PersistedChatMessage[] = [];
  for (const end of [...boundaries, messages.length]) {
    const turn = messages.slice(start, end);
    const turnRuntime =
      runtime?.activeTurn &&
      turn.some((message) => message.id === runtime.activeTurn?.userMessageId)
        ? runtime
        : undefined;
    const completedAt =
      runtime &&
      ['starting', 'streaming', 'awaiting_input', 'completing'].includes(
        runtime.status,
      )
        ? detectedAt
        : persistedInterruptedSettlementTime(turn, detectedAt, turnRuntime);
    const timed = closeOpenPersistedTurnTimers(turn, completedAt);
    const settled = closeOpenPersistedToolUsesInTurn(
      timed,
      completedAt,
      runtime?.status === 'interrupted'
        ? TOOL_SETTLEMENT_OUTPUT.app_restart
        : TOOL_SETTLEMENT_OUTPUT.stopped,
      runtime?.status === 'interrupted' ? 'app_restart' : 'stopped',
      childResultIds,
    );
    changed ||= settled !== turn;
    result.push(...settled);
    start = end;
  }
  return changed ? result : messages;
}

/** Retain turn anchors, timer state, tool identities and one activity stamp per
 * turn. Never retain transcript text or tool bodies during legacy migration;
 * `answer` sees each original row and keeps only body-free flags. */
export async function collectPersistedSettlementEvidence(
  messages: AsyncIterable<PersistedChatMessage>,
  detectedAt: number,
  answer?: SettlementAnswerTracker,
): Promise<PersistedChatMessage[]> {
  const evidence: PersistedChatMessage[] = [];
  let activity: PersistedChatMessage | undefined;
  for await (const message of messages) {
    // Classify the original row before its text is dropped (CAN-7612).
    answer?.observe(message);
    if (isRootUserTurnBoundary(message)) activity = undefined;
    const blocks: PersistedChatBlock[] = message.blocks.flatMap(
      (block): PersistedChatBlock[] => {
        if (block.type === 'turn_timer') return [block];
        if (block.type === 'tool_use') return [{ ...block, input: '{}' }];
        if (block.type === 'tool_result') return [{ ...block, output: '' }];
        return [];
      },
    );
    if (isRootUserTurnBoundary(message) || blocks.length)
      evidence.push({
        id: message.id,
        role: message.role,
        timestamp: message.timestamp,
        parentToolUseId: message.parentToolUseId,
        parentBlockId: message.parentBlockId,
        codexThreadId: message.codexThreadId,
        codexTurnId: message.codexTurnId,
        blocks,
      });
    if (
      !isSyntheticSettlementMessage(message) &&
      Number.isFinite(message.timestamp) &&
      message.timestamp <= detectedAt
    ) {
      if (!activity) {
        activity = {
          id: `settlement-evidence-${message.id}`,
          role: 'assistant',
          timestamp: message.timestamp,
          blocks: [],
        };
        evidence.push(activity);
      } else
        activity.timestamp = Math.max(activity.timestamp, message.timestamp);
    }
  }
  return evidence;
}

/** Two-pass migration: emit original bodies once, settling each owning turn
 * before emitting the next user boundary. */
export async function* settlePersistedInterruptedStream(
  messages: () => AsyncIterable<PersistedChatMessage>,
  detectedAt: number,
  runtime?: ChatRuntimeState,
): AsyncGenerator<PersistedChatMessage> {
  const evidence = await collectPersistedSettlementEvidence(
    messages(),
    detectedAt,
  );
  const childResultIds = collectChildToolResultIds(evidence);
  const settlements = new Map<
    string,
    { at: number; results: PersistedChatMessage[] }
  >();
  const boundaries = evidence.flatMap((message, index) =>
    isRootUserTurnBoundary(message) ? [index] : [],
  );
  let start = 0;
  for (const end of [
    ...boundaries.filter((index) => index > 0),
    evidence.length,
  ]) {
    const turn = evidence.slice(start, end);
    const turnRuntime =
      runtime?.activeTurn &&
      turn.some((message) => message.id === runtime.activeTurn?.userMessageId)
        ? runtime
        : undefined;
    const at = persistedInterruptedSettlementTime(
      turn,
      detectedAt,
      turnRuntime,
    );
    const settled = closeOpenPersistedToolUsesInTurn(
      turn,
      at,
      TOOL_SETTLEMENT_OUTPUT.app_restart,
      'app_restart',
      childResultIds,
    );
    const key = turn.find(isRootUserTurnBoundary)?.id ?? '';
    settlements.set(key, { at, results: settled.slice(turn.length) });
    start = end;
  }
  let current = settlements.get('');
  for await (const message of messages()) {
    if (isRootUserTurnBoundary(message)) {
      if (current) for (const result of current.results) yield result;
      current = settlements.get(message.id);
    }
    yield closeOpenPersistedTurnTimers([message], current?.at ?? detectedAt)[0];
  }
  if (current) for (const result of current.results) yield result;
}
