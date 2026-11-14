import {
  isAgentDelegationTranscript,
  type AgentDelegationTranscript,
  type AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import type { CardState } from '@canopy/protocol/canopy-core';
import type {
  DelegatedAgentCallBlock,
  PersistedChatMessage,
  PersistedChatBlock,
} from '../types';
import type { TranscriptReducerState } from './transcript-parser';
import { isPersistedToolOutputReference } from '../transcript-storage';
import {
  persistedDelegationSnapshot,
  STREAM_CARD_KEY_CLASSES,
} from './delegation-card-snapshot';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `agentBlockId` of a delegation generation's card; child rows link to it. */
export function delegationBlockId(id: string, generation: number): string {
  return `delegated-agent-${id}${generation > 1 ? `-run-${generation}` : ''}`;
}

/** Child-only persisted metadata; primary messages remain unchanged. */
export type DelegationChildRow = PersistedChatMessage & {
  itemRevision: number;
  final: boolean;
  truncated?: true;
};

/** Only stream-backed cards receive mutable descriptor state. */
export function overlayStreamBackedDelegationCard(
  card: DelegatedAgentCallBlock,
  state: CardState | null,
  streamRevision?: number,
): DelegatedAgentCallBlock {
  if (card.transcriptStore !== 'chat-stream-v2') return card;
  const displayCard =
    streamRevision !== undefined &&
    Number.isSafeInteger(streamRevision) &&
    streamRevision >= 0
      ? { ...card, streamRevision }
      : card;
  if (state === null) return displayCard;
  if (state.version === 2) {
    const {
      version: _version,
      cardRevision: _revision,
      canonical,
      detailOmitted: _omitted,
      ...draft
    } = state;
    void _version;
    void _revision;
    void _omitted;
    const creation: DelegatedAgentCallBlock & { answerUnavailable?: true } = {
      ...displayCard,
    };
    for (const key of [
      'routeSnapshot',
      'requestedModelId',
      'nativeSessionId',
      'nestedDelegation',
      'childDelegationIds',
      'capabilities',
      'isolatedWorkspace',
      'workspaceDiscarded',
      'control',
      'cancelledByUser',
      'stoppedBy',
      'resultIndex',
      'error',
      'usage',
      'stopReason',
      'finalText',
      'finalTextRef',
      'partialText',
      'partialTextRef',
      'phase',
      'queue',
      'approvalPending',
      'stopRequested',
      'workspaceObservation',
      'requestedThinkingLevel',
      'effectiveThinkingLevel',
      'answerUnavailable',
    ] as const)
      delete creation[key];
    const route = draft.routeSnapshot;
    return {
      ...creation,
      ...draft,
      ...canonical,
      status: canonical?.status ?? draft.status ?? card.status,
      outputTruncated: draft.outputTruncated ?? card.outputTruncated,
      prompt: draft.prompt ?? card.prompt,
      selectedModelId:
        route?.selectedModelId ??
        draft.requestedModelId ??
        card.selectedModelId,
      runtimeModelId: route?.runtimeModelId ?? card.runtimeModelId,
      targetHarnessId: route?.harnessId ?? card.targetHarnessId,
      ...(route?.requestedThinkingLevel === undefined
        ? {}
        : { requestedThinkingLevel: route.requestedThinkingLevel }),
      ...(route?.effectiveThinkingLevel === undefined
        ? {}
        : { effectiveThinkingLevel: route.effectiveThinkingLevel }),
    };
  }
  // A descriptor preview replaces the card's answer string, so the card's
  // reference to a different body no longer describes it.
  const { partialTextRef, finalTextRef, ...rest } = displayCard;
  return {
    ...rest,
    status: state.status,
    ...(state.resultIndex === null ? {} : { resultIndex: state.resultIndex }),
    ...(state.partialPreview === null
      ? partialTextRef === undefined
        ? {}
        : { partialTextRef }
      : { partialText: state.partialPreview }),
    ...(state.finalPreview === null
      ? finalTextRef === undefined
        ? {}
        : { finalTextRef }
      : { finalText: state.finalPreview }),
    workspaceDiscarded: state.workspaceDiscarded,
    ...(state.usage === null ? {} : { usage: state.usage }),
  };
}

/**
 * A delegate's transcript items as child rows of its card, `agentBlockId`.
 * The same rows whether they come from a live snapshot, a parent transcript
 * written before delegate logs, or a delegate log.
 */
export function delegationChildMessages(
  agentBlockId: string,
  items: readonly AgentDelegationTranscriptItem[],
): (PersistedChatMessage & { truncated?: true })[] {
  return items.map((item) => {
    const id = `${agentBlockId}:${item.id}`;
    const blocks: PersistedChatBlock[] =
      item.type === 'tool'
        ? [
            {
              type: 'tool_use',
              toolUseId: id,
              toolName: item.toolName,
              input: item.input,
            },
            ...(item.output !== undefined
              ? [
                  {
                    type: 'tool_result' as const,
                    toolUseId: id,
                    toolName: item.toolName,
                    output: item.output,
                    isError: item.isError === true,
                  },
                ]
              : []),
          ]
        : [{ type: item.type, text: item.text }];
    return {
      id,
      role: item.type === 'text' && item.author ? 'user' : 'assistant',
      ...(item.type === 'text' && item.author
        ? { delegationAuthor: item.author }
        : {}),
      ...(item.type === 'text' && item.delivery
        ? { delegationDelivery: item.delivery }
        : {}),
      timestamp: item.occurredAt,
      parentBlockId: agentBlockId,
      delegationSequence: item.sequence,
      ...(item.truncated ? { truncated: true as const } : {}),
      blocks,
    };
  });
}

/** Normalize once, at the shared parser boundary; neither provider owns these messages. */
export function delegationTranscriptMessages(
  value: AgentDelegationTranscript,
): PersistedChatMessage[] {
  const { snapshot: sourceSnapshot, task, transcript } = value;
  // Display observations cannot enter creation or legacy rewrite bytes.
  const snapshot: typeof sourceSnapshot & { streamRevision?: number } = {
    ...sourceSnapshot,
  };
  delete snapshot.streamRevision;
  const route = snapshot.routeSnapshot;
  const agentBlockId = delegationBlockId(
    value.delegationId,
    value.runGeneration,
  );
  const block: DelegatedAgentCallBlock = {
    ...snapshot,
    type: 'delegated_agent_call',
    agentBlockId,
    runGeneration: value.runGeneration,
    sequence: value.sequence,
    parentHarnessId: value.parentHarnessId,
    parentTurnId: value.parentTurnId,
    parentToolCallId: value.parentToolCallId,
    createdAt: value.createdAt,
    selectedModelId: route?.selectedModelId ?? snapshot.requestedModelId ?? '',
    runtimeModelId: route?.runtimeModelId ?? '',
    targetHarnessId: route?.harnessId ?? '',
    requestedThinkingLevel: route?.requestedThinkingLevel,
    effectiveThinkingLevel: route?.effectiveThinkingLevel,
    description: task.description,
    prompt: task.prompt,
    executionMode: task.executionMode,
    ...(value.transcriptStore
      ? { transcriptStore: value.transcriptStore }
      : {}),
  };
  const children = delegationChildMessages(agentBlockId, transcript);
  return [
    {
      id: agentBlockId,
      role: 'assistant',
      timestamp: value.createdAt,
      blocks: [block],
    },
    ...children,
  ];
}

// Known authored fields come from the new projection, including omission. Only
// opaque extensions and references to unchanged bodies survive a rewrite.
const LEGACY_ROW_FIELDS = {
  id: true,
  role: true,
  blocks: true,
  timestamp: true,
  hidden: true,
  userMessageSource: true,
  autoResume: true,
  parentToolUseId: true,
  parentBlockId: true,
  delegationSequence: true,
  delegationAuthor: true,
  delegationDelivery: true,
  delegationSegment: true,
  codexThreadId: true,
  codexTurnId: true,
  attachmentPaths: true,
  attachmentPromptContexts: true,
  inputMode: true,
  watcherFired: true,
  claudeUuid: true,
  itemRevision: true,
  final: true,
  truncated: true,
  agentSent: true,
  cancelled: true,
  // Read results only; a rewrite never carries one forward.
  blocksOmitted: true,
} satisfies Record<Exclude<keyof DelegationChildRow, 'blocksRef'>, true>;

function preservedRewriteFields(
  previous: object,
  next: object,
  knownFields: object,
): Record<string, unknown> {
  const before = Object.fromEntries(Object.entries(previous));
  const after = Object.fromEntries(Object.entries(next));
  return Object.fromEntries(
    Object.entries(previous).filter(([key]) => {
      const suffixLength = key.endsWith('Refs')
        ? 4
        : key.endsWith('Ref')
          ? 3
          : 0;
      if (suffixLength > 0) {
        const body = key.slice(0, -suffixLength);
        return JSON.stringify(before[body]) === JSON.stringify(after[body]);
      }
      return !Object.prototype.hasOwnProperty.call(knownFields, key);
    }),
  );
}

export function applyDelegationTranscriptEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
): TranscriptReducerState {
  const value = data.delegation;
  if (!isAgentDelegationTranscript(value)) return state;
  const id = delegationBlockId(value.delegationId, value.runGeneration);
  const existingIndex = state.messages.findIndex((message) =>
    message.blocks.some(
      (block) =>
        block.type === 'delegated_agent_call' && block.agentBlockId === id,
    ),
  );
  if (value.transcriptStore === 'chat-stream-v2') {
    if (existingIndex >= 0) return state;
    const [creation] = delegationTranscriptMessages({
      ...value,
      snapshot: persistedDelegationSnapshot(value.snapshot),
      transcript: [],
    });
    if (creation === undefined) return state;
    return { ...state, messages: [...state.messages, creation] };
  }
  const prior =
    existingIndex >= 0
      ? state.messages[existingIndex].blocks.find(
          (block) =>
            block.type === 'delegated_agent_call' && block.agentBlockId === id,
        )
      : undefined;
  if (
    prior?.type === 'delegated_agent_call' &&
    (prior.transcriptStore === 'chat-stream-v2' ||
      prior.runGeneration > value.runGeneration ||
      (prior.runGeneration === value.runGeneration &&
        prior.sequence >= value.sequence))
  )
    return state;
  const normalized = delegationTranscriptMessages(value);
  const previousRows = new Map(
    state.messages.map((message) => [message.id, message]),
  );
  for (let index = 0; index < normalized.length; index++) {
    const next = normalized[index];
    const previous = previousRows.get(next.id);
    if (!previous) continue;
    if (next.id === id && prior?.type === 'delegated_agent_call') {
      next.blocks = next.blocks.map((block) =>
        block.type === 'delegated_agent_call'
          ? {
              ...preservedRewriteFields(prior, block, STREAM_CARD_KEY_CLASSES),
              ...block,
            }
          : block,
      );
    }
    normalized[index] = {
      ...preservedRewriteFields(previous, next, LEGACY_ROW_FIELDS),
      ...next,
    };
  }
  const updatedIds = new Set(normalized.map((message) => message.id));
  const retainedChildren =
    value.transcriptMode === 'patch'
      ? state.messages.filter(
          (message) =>
            message.parentBlockId === id && !updatedIds.has(message.id),
        )
      : [];
  normalized.push(...retainedChildren);
  const parent = normalized.shift();
  if (!parent) return state;
  normalized.sort(
    (left, right) =>
      (left.delegationSequence ?? 0) - (right.delegationSequence ?? 0),
  );
  normalized.unshift(parent);
  const messages = state.messages.filter(
    (message) => message.id !== id && message.parentBlockId !== id,
  );
  // Recovery may arrive in a later root turn. Keep it beside its originating tool/turn.
  let insertAt = existingIndex;
  if (insertAt < 0) {
    const toolIndex = messages.findIndex((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'tool_use' &&
          block.toolUseId === value.parentToolCallId,
      ),
    );
    const turnIndex = messages.findIndex(
      (message) => message.id === value.parentTurnId,
    );
    // A user follow-up has no root turn or tool call of its own; its
    // delegate's earlier run card places it (below).
    const hasEarlierRun = messages.some((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'delegated_agent_call' &&
          block.delegationId === value.delegationId &&
          block.runGeneration < value.runGeneration,
      ),
    );
    if (toolIndex < 0 && turnIndex < 0 && !hasEarlierRun && messages.length > 0)
      return state;
    insertAt =
      toolIndex >= 0
        ? toolIndex + 1
        : turnIndex >= 0
          ? turnIndex + 1
          : messages.length;
  }
  if (existingIndex < 0) {
    // Generations may share their originating parent turn. Keep prior results
    // beside their child content, even when recovery arrives out of order.
    for (let index = 0; index < messages.length; index += 1) {
      const sibling = messages[index].blocks.find(
        (block) =>
          block.type === 'delegated_agent_call' &&
          block.delegationId === value.delegationId,
      );
      if (sibling?.type !== 'delegated_agent_call') continue;
      if (sibling.runGeneration > value.runGeneration) {
        insertAt = index;
        break;
      }
      if (sibling.runGeneration < value.runGeneration) {
        let end = index + 1;
        while (
          end < messages.length &&
          messages[end].parentBlockId === sibling.agentBlockId
        )
          end += 1;
        insertAt = Math.max(insertAt, end);
      }
    }
  }
  messages.splice(insertAt, 0, ...normalized);
  return { ...state, messages };
}

/** Persistence readers validate owned blocks through the same public contract. */
export function isDelegatedAgentCallBlock(
  value: unknown,
): value is DelegatedAgentCallBlock {
  if (!isRecord(value)) return false;
  const block = value;
  if (
    block.type !== 'delegated_agent_call' ||
    block.agentBlockId !==
      delegationBlockId(String(block.delegationId), Number(block.runGeneration))
  )
    return false;
  if (block.routeSnapshot !== undefined && !isRecord(block.routeSnapshot))
    return false;
  if (
    block.transcriptStore !== undefined &&
    block.transcriptStore !== 'chat-log-v1' &&
    block.transcriptStore !== 'chat-stream-v2'
  )
    return false;
  if (
    (block.partialTextRef !== undefined &&
      !isPersistedToolOutputReference(block.partialTextRef)) ||
    (block.finalTextRef !== undefined &&
      !isPersistedToolOutputReference(block.finalTextRef))
  )
    return false;
  const route = isRecord(block.routeSnapshot) ? block.routeSnapshot : undefined;
  return (
    block.selectedModelId ===
      (route?.selectedModelId ?? block.requestedModelId ?? '') &&
    block.runtimeModelId === (route?.runtimeModelId ?? '') &&
    block.targetHarnessId === (route?.harnessId ?? '') &&
    isAgentDelegationTranscript({
      delegationId: block.delegationId,
      runGeneration: block.runGeneration,
      sequence: block.sequence,
      parentHarnessId: block.parentHarnessId,
      parentTurnId: block.parentTurnId,
      parentToolCallId: block.parentToolCallId,
      createdAt: block.createdAt,
      task: {
        description: block.description,
        prompt: block.prompt,
        executionMode: block.executionMode,
      },
      snapshot: block,
      transcript: [],
      transcriptStore: block.transcriptStore,
    })
  );
}

/** Hide children only when the owning card is present; retain orphaned historical output. */
export function delegationRootMessages(
  messages: readonly PersistedChatMessage[],
): PersistedChatMessage[] {
  const parents = new Set(
    messages.flatMap((message) =>
      message.blocks.flatMap((block) =>
        block.type === 'delegated_agent_call' ? [block.agentBlockId] : [],
      ),
    ),
  );
  return messages.filter(
    (message) =>
      !message.hidden &&
      (!message.parentBlockId || !parents.has(message.parentBlockId)),
  );
}
