import {
  extractCanonicalAgentArtifacts,
  serializeAgentArtifactReceipts,
} from '@canopy/protocol/agent-artifacts';
import { isArtifactDispatchTool } from '@canopy/desktop-shared/lib/agent-artifact-projection';
import { isRecord } from './type-guards';
import { isPersistedChatMessage } from './persisted-chat-message-validation';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import { isRootUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import {
  groupIntoTurns,
  splitFinalMessages,
  computeTurnSummary,
  getTurnOutcomeStepStates,
  getTurnSafetyDeniedToolUseIds,
  type TurnOutcomeStep,
} from '@canopy/desktop-shared/lib/turn-utils';
import {
  mergeToolResults,
  reorderMessagesForDisplay,
} from '@canopy/desktop-shared/lib/message-transforms';
import type {
  TranscriptTurnContinuation,
  TranscriptTurnSummary,
} from '@canopy/agent-transcript/transcript-storage';
import type { TurnOutcomeCounts } from '@canopy/protocol/remote-control/shell';
import { isTurnOutcomeCounts } from '@canopy/protocol/remote-control/shell';
import { collectTurnFiles } from '@canopy/desktop-shared/lib/turn-files';
import { isTurnFileRecord } from '@canopy/protocol/turn-files';

export interface IndexedTurn extends Omit<TranscriptTurnSummary, 'before'> {
  /** Required in persisted version-10 projections, including all-zero turns. */
  outcomes: TurnOutcomeCounts;
  /** Internal receipt correlation, including calls still in the active overlay. */
  deniedToolUseIds: string[];
  /** Raw ordinals, including source rows of merged tool results. */
  retained: number[];
  frame: number[];
  frameTimer?: PersistedChatMessage;
}

export interface TranscriptTurnIndex {
  version: 10;
  committedByteLength: number;
  committedMessageCount: number;
  /** Ended-turn projections use exactly the same display helpers as the UI. */
  turns: IndexedTurn[];
}

export function indexTurn(
  rows: PersistedChatMessage[],
  start: number,
  followedByTurn = false,
): IndexedTurn {
  return projectTurn(rows, start, followedByTurn).turn;
}

function projectTurn(
  rows: PersistedChatMessage[],
  start: number,
  followedByTurn = false,
  inheritedDenials: ReadonlySet<string> = new Set(),
): {
  turn: IndexedTurn;
  steps: Map<string, TurnOutcomeStep['outcome'] | undefined>;
  /** Each tools-loaded continuation's steps, for a late receipt. */
  continuationSteps: Map<
    string,
    Map<string, TurnOutcomeStep['outcome'] | undefined>
  >;
} {
  const hasTimer = rows.some((row) =>
    row.blocks.some((block) => block.type === 'turn_timer'),
  );
  const frameTimer: PersistedChatMessage | undefined =
    // A lone historical prompt provides no evidence of agent activity. Adding
    // a frame timer would turn it into a phantom running (or completed) turn.
    !hasTimer && rows.length > 1 && rows[0].role === 'user'
      ? {
          id: `${rows[0].id}-implicit-turn-timer`,
          role: 'system',
          timestamp: rows[rows.length - 1].timestamp,
          blocks: [
            {
              type: 'turn_timer',
              completedAt: followedByTurn
                ? rows[rows.length - 1].timestamp
                : null,
            },
          ],
        }
      : undefined;
  const rendered = groupIntoTurns(
    mergeToolResults(
      // Display folds some runs into the turn they follow; the index keeps
      // the placement it has always used (see `indexOrder`).
      reorderMessagesForDisplay(frameTimer ? [...rows, frameTimer] : rows, {
        indexOrder: true,
      }),
    ),
  );
  const group = rendered.find((item) => item.kind === 'turn-group');
  const assistantMessages =
    group?.kind === 'turn-group' ? group.assistantMessages : [];
  const { intermediateMessages, finalMessages, trailingToolMessages } =
    splitFinalMessages(assistantMessages);
  const retainedIds = new Set(
    group?.kind === 'turn-group' && group.isComplete
      ? finalMessages.map((message) => message.id)
      : [],
  );
  for (const message of finalMessages)
    for (const block of message.blocks) {
      if (
        'result' in block &&
        block.result &&
        'messageId' in block.result &&
        typeof block.result.messageId === 'string'
      )
        retainedIds.add(block.result.messageId);
    }
  // Questions can outlive completion and optimistic answer reservations. Keep
  // their source rows; the existing renderer filters settled/dismissed cards.
  for (const row of rows)
    if (
      row.blocks.some((block) => block.type === 'text' && block.asyncQuestion)
    )
      retainedIds.add(row.id);
  // A collapsed turn keeps its visuals, so keep the rows that render one: the
  // owning result and the call it answers.
  const visualToolUseIds = new Set(
    rows.flatMap((row) =>
      row.blocks.flatMap((block) =>
        block.type === 'tool_result' &&
        !block.isError &&
        (block.visualRef ||
          (isArtifactDispatchTool(block.toolName) &&
            (serializeAgentArtifactReceipts(block.agentArtifacts).length > 0 ||
              extractCanonicalAgentArtifacts(block.output).length > 0)))
          ? [block.toolUseId]
          : [],
      ),
    ),
  );
  if (visualToolUseIds.size > 0)
    for (const row of rows)
      if (
        row.blocks.some(
          (block) =>
            (block.type === 'tool_use' || block.type === 'tool_result') &&
            visualToolUseIds.has(block.toolUseId),
        )
      )
        retainedIds.add(row.id);
  // A tools-loaded continuation shows as its own turn in this span; keep its
  // own projection, and its answer, for when its rows are compacted.
  const continuations: Record<string, TranscriptTurnContinuation> = {};
  const continuationSteps = new Map<
    string,
    Map<string, TurnOutcomeStep['outcome'] | undefined>
  >();
  for (const item of rendered) {
    const head = item.kind === 'turn-group' ? item.userMessage.blocks[0] : null;
    if (
      item.kind !== 'turn-group' ||
      head?.type !== 'wake_boundary' ||
      head.toolsLoaded !== true
    )
      continue;
    const split = splitFinalMessages(item.assistantMessages);
    const counted = [
      ...split.intermediateMessages,
      ...split.trailingToolMessages,
    ];
    const denied = new Set([
      ...Array.from(inheritedDenials),
      ...getTurnSafetyDeniedToolUseIds(item.assistantMessages, rows[0].id),
    ]);
    const counts: TurnOutcomeCounts = { blocked: 0, failed: 0, interrupted: 0 };
    const ownSteps = getTurnOutcomeStepStates(counted, denied, {
      settled: item.isComplete,
      resultsComplete: true,
    });
    ownSteps.forEach((outcome): void => {
      if (outcome !== undefined) counts[outcome] += 1;
    });
    continuationSteps.set(item.userMessage.id, ownSteps);
    continuations[item.userMessage.id] = {
      complete: item.isComplete,
      summary: computeTurnSummary(counted),
      outcomes: counts,
      finalMessageIds: split.finalMessages.map((message) => message.id),
      files: collectTurnFiles(item.assistantMessages),
    };
    if (item.isComplete)
      for (const message of split.finalMessages) retainedIds.add(message.id);
  }
  const frame = rows.flatMap((row, index) =>
    index === 0 || row.blocks.some((block) => block.type === 'turn_timer')
      ? [start + index]
      : [],
  );
  const retained = rows.flatMap((row, index) =>
    retainedIds.has(row.id) || index >= rows.length - 16 ? [start + index] : [],
  );
  const countedMessages = [...intermediateMessages, ...trailingToolMessages];
  const deniedToolUseIds = Array.from(
    new Set([
      ...Array.from(inheritedDenials),
      ...getTurnSafetyDeniedToolUseIds(assistantMessages, rows[0].id),
    ]),
  );
  const steps = getTurnOutcomeStepStates(
    countedMessages,
    new Set(deniedToolUseIds),
    {
      settled: group?.kind === 'turn-group' && group.isComplete,
      resultsComplete: true,
    },
  );
  const outcomes: TurnOutcomeCounts = { blocked: 0, failed: 0, interrupted: 0 };
  steps.forEach((outcome): void => {
    if (outcome !== undefined) outcomes[outcome] += 1;
  });
  return {
    steps,
    continuationSteps,
    turn: {
      id: rows[0].id,
      start,
      end: start + rows.length,
      complete: group?.kind === 'turn-group' && group.isComplete,
      summary: computeTurnSummary(countedMessages),
      outcomes,
      deniedToolUseIds,
      finalMessageIds: finalMessages.map((message) => message.id),
      files: collectTurnFiles(assistantMessages),
      frame,
      ...(frameTimer ? { frameTimer } : {}),
      retained,
      ...(Object.keys(continuations).length > 0 ? { continuations } : {}),
    },
  };
}

/**
 * Stream the raw source one turn at a time; never hydrate the whole chat.
 * Retain only compact eligible-step states after each turn so a later receipt
 * can update its explicit owner without retaining the owner's messages.
 */
export async function buildTurnIndex(
  source: AsyncIterable<PersistedChatMessage> | Iterable<PersistedChatMessage>,
  start = 0,
  receiptTurns: readonly Pick<IndexedTurn, 'id' | 'deniedToolUseIds'>[] = [],
  expandBlocks?: (
    message: PersistedChatMessage,
  ) => Promise<PersistedChatMessage>,
): Promise<IndexedTurn[]> {
  const turns: IndexedTurn[] = [];
  const denials = new Map(
    receiptTurns.map((turn) => [turn.id, new Set(turn.deniedToolUseIds)]),
  );
  const projected = new Map<string, ReturnType<typeof projectTurn>>();
  let rows: PersistedChatMessage[] = [];
  let ordinal = start;
  const finish = (followedByTurn = false): void => {
    const value = projectTurn(
      rows,
      ordinal,
      followedByTurn,
      denials.get(rows[0].id),
    );
    turns.push(value.turn);
    projected.set(value.turn.id, value);
    denials.set(value.turn.id, new Set(value.turn.deniedToolUseIds));
  };
  for await (const storedMessage of source) {
    const message =
      expandBlocks && storedMessage.blocksRef
        ? await expandBlocks(storedMessage)
        : storedMessage;
    if (rows.length > 0 && isRootUserTurnBoundary(message)) {
      finish(true);
      ordinal += rows.length;
      rows = [];
      // Let IPC and cancellation callbacks run between completed turns.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const block of message.blocks) {
      if (
        block.type !== 'approval_safety_denied_info' ||
        !block.toolUseId ||
        block.subagentId ||
        block.turnUserMessageId === undefined
      )
        continue;
      const owner = block.turnUserMessageId;
      const ids = denials.get(owner) ?? new Set<string>();
      ids.add(block.toolUseId);
      denials.set(owner, ids);
      const value = projected.get(owner);
      if (!value) continue;
      value.turn.deniedToolUseIds = Array.from(ids);
      // The step is the prompt's own, or one of its continuations'.
      const toolUseId = block.toolUseId;
      const continuation = Array.from(value.continuationSteps).find(
        ([, steps]) => steps.has(toolUseId),
      );
      const target = value.steps.has(toolUseId)
        ? { steps: value.steps, outcomes: value.turn.outcomes }
        : continuation && value.turn.continuations?.[continuation[0]]?.outcomes
          ? {
              steps: continuation[1],
              outcomes: value.turn.continuations[continuation[0]].outcomes,
            }
          : undefined;
      if (!target?.outcomes) continue;
      const previous = target.steps.get(toolUseId);
      if (previous === 'blocked') continue;
      if (previous !== undefined) target.outcomes[previous] -= 1;
      target.outcomes.blocked += 1;
      target.steps.set(toolUseId, 'blocked');
    }
    rows.push(message);
  }
  if (rows.length > 0) finish();
  return turns;
}

function isTurnContinuations(
  value: unknown,
): value is Record<string, TranscriptTurnContinuation> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.complete === 'boolean' &&
        isRecord(entry.summary) &&
        Array.isArray(entry.finalMessageIds) &&
        entry.finalMessageIds.every((id: unknown) => typeof id === 'string') &&
        isTurnOutcomeCounts(entry.outcomes) &&
        (entry.files === undefined ||
          (Array.isArray(entry.files) &&
            entry.files.every((file: unknown) => isTurnFileRecord(file)))),
    )
  );
}

export function isTranscriptTurnIndex(
  value: unknown,
): value is TranscriptTurnIndex {
  if (
    !isRecord(value) ||
    value.version !== 10 ||
    !Number.isSafeInteger(value.committedByteLength) ||
    !Number.isSafeInteger(value.committedMessageCount) ||
    !Array.isArray(value.turns)
  )
    return false;
  let end = 0;
  const valid = value.turns.every((turn: unknown) => {
    if (
      !isRecord(turn) ||
      typeof turn.id !== 'string' ||
      typeof turn.start !== 'number' ||
      typeof turn.end !== 'number' ||
      !Number.isSafeInteger(turn.start) ||
      !Number.isSafeInteger(turn.end) ||
      turn.start !== end ||
      turn.end <= turn.start ||
      typeof turn.complete !== 'boolean' ||
      !Array.isArray(turn.finalMessageIds) ||
      !turn.finalMessageIds.every((id: unknown) => typeof id === 'string') ||
      !isRecord(turn.summary) ||
      !isTurnOutcomeCounts(turn.outcomes) ||
      !Array.isArray(turn.deniedToolUseIds) ||
      !turn.deniedToolUseIds.every(
        (id: unknown) => typeof id === 'string' && id.length > 0,
      ) ||
      new Set(turn.deniedToolUseIds).size !== turn.deniedToolUseIds.length ||
      !Array.isArray(turn.files) ||
      !turn.files.every((file: unknown) => isTurnFileRecord(file))
    )
      return false;
    const counts = turn.summary;
    if (
      !Object.keys(computeTurnSummary([])).every(
        (key) =>
          typeof counts[key] === 'number' &&
          Number.isSafeInteger(counts[key]) &&
          counts[key] >= 0,
      )
    )
      return false;
    const start = turn.start;
    const nextEnd = turn.end;
    if (
      ![turn.frame, turn.retained].every(
        (ordinals) =>
          Array.isArray(ordinals) &&
          ordinals.every(
            (ordinal: unknown) =>
              typeof ordinal === 'number' &&
              Number.isSafeInteger(ordinal) &&
              ordinal >= start &&
              ordinal < nextEnd,
          ),
      )
    )
      return false;
    if (
      turn.frameTimer !== undefined &&
      !isPersistedChatMessage(turn.frameTimer)
    )
      return false;
    if (
      turn.continuations !== undefined &&
      !isTurnContinuations(turn.continuations)
    )
      return false;
    end = nextEnd;
    return true;
  });
  return valid && end === value.committedMessageCount;
}
