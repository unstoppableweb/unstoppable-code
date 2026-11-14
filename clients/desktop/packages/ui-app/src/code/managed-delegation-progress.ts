import type {
  AgentDelegationCardData,
  AgentDelegationSnapshot,
} from '@canopy/protocol/delegation';

/** Stream fields that may change before the parent chat commits a new card. */
export interface ManagedDelegationProgress {
  readonly runGeneration: number;
  readonly status: AgentDelegationSnapshot['status'];
  readonly phase?: AgentDelegationSnapshot['phase'];
  readonly queue?: AgentDelegationSnapshot['queue'];
  readonly approvalPending?: AgentDelegationSnapshot['approvalPending'];
}

type ManagedDelegationProgressCard = Pick<AgentDelegationSnapshot, 'status'> & {
  readonly runGeneration?: number;
  readonly phase?: AgentDelegationSnapshot['phase'];
  readonly queue?: AgentDelegationSnapshot['queue'];
  readonly approvalPending?: AgentDelegationSnapshot['approvalPending'];
};

type LiveOnlyFields = Pick<
  AgentDelegationSnapshot,
  'phase' | 'queue' | 'approvalPending'
>;

/** Durable fields retain their card type; only optional live fields are overlaid. */
export type ManagedDelegationProgressOverlay<
  Card extends ManagedDelegationProgressCard,
> = Omit<Card, keyof LiveOnlyFields> & LiveOnlyFields;

function isActiveStatus(status: AgentDelegationSnapshot['status']): boolean {
  return status === 'pending' || status === 'running';
}

/**
 * Applies current stream-only fields without allowing a live snapshot to
 * replace durable card data or revive a settled or different generation.
 */
export function overlayManagedDelegationProgress<
  Card extends ManagedDelegationProgressCard,
>(
  card: Card,
  progress: ManagedDelegationProgress | undefined,
): ManagedDelegationProgressOverlay<Card> {
  const applies =
    progress !== undefined &&
    isActiveStatus(card.status) &&
    isActiveStatus(progress.status) &&
    progress.runGeneration === (card.runGeneration ?? 1);
  const live = applies ? progress : undefined;
  const phase = live?.phase;
  const queue = live?.queue;
  const approvalPending = live?.approvalPending;
  const hasPhase = Object.prototype.hasOwnProperty.call(card, 'phase');
  const hasQueue = Object.prototype.hasOwnProperty.call(card, 'queue');
  const hasApprovalPending = Object.prototype.hasOwnProperty.call(
    card,
    'approvalPending',
  );

  if (
    hasPhase === (phase !== undefined) &&
    card.phase === phase &&
    hasQueue === (queue !== undefined) &&
    card.queue === queue &&
    hasApprovalPending === (approvalPending !== undefined) &&
    card.approvalPending === approvalPending
  )
    return card;

  const {
    phase: _phase,
    queue: _queue,
    approvalPending: _approvalPending,
    ...durableCard
  } = card;
  void _phase;
  void _queue;
  void _approvalPending;

  return {
    ...durableCard,
    ...(phase === undefined ? {} : { phase }),
    ...(queue === undefined ? {} : { queue }),
    ...(approvalPending === undefined ? {} : { approvalPending }),
  };
}

/**
 * A card with the delegation's current snapshot, as its authority reads it,
 * for a host whose transcript never commits a newer card (cloud chats: the
 * card is the Delegate Task call's first answer). Every snapshot field comes
 * from `live`; the card keeps what only it knows: the task, the parent and
 * where its child transcript is. A snapshot of an older run than the card's
 * changes nothing.
 */
export function overlayManagedDelegationSnapshot(
  card: AgentDelegationCardData,
  live: AgentDelegationSnapshot | undefined,
): AgentDelegationCardData {
  if (live === undefined || live.delegationId !== card.delegationId)
    return card;
  if ((live.runGeneration ?? 1) < (card.runGeneration ?? 1)) return card;
  return {
    ...live,
    parentHarnessId: card.parentHarnessId,
    description: card.description,
    prompt: card.prompt,
    executionMode: card.executionMode,
    ...(card.transcriptStore === undefined
      ? {}
      : { transcriptStore: card.transcriptStore }),
    ...(card.streamRevision === undefined
      ? {}
      : { streamRevision: card.streamRevision }),
  };
}
