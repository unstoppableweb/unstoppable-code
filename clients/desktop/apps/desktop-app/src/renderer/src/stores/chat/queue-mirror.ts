import type {
  ChatInternalRow,
  ChatQueueUpdatedEvent,
  ChatTurnPhase,
  HostQueuedMessageView,
} from '@canopy/desktop-shared/types';
import { isInternalChatRequest } from '@canopy/desktop-shared/lib/internal-chat-row';
import { queuedMessageForceKind } from '@canopy/ui-shared/lib/queued-message-force';

import {
  reconcilePendingQueueMessages,
  restoreDispatchedQueueRow,
  withdrawQueuedSends,
} from './optimistic-presentation';
import type { LocalTurnActivity } from './turn-activity';
import type { ChatTab, QueuedChatMessage } from './types';
import type { ChatState } from './state';

type HostQueueMirrorInput = HostQueuedMessageView & {
  managedDelegationDeliveryId?: string;
  internalRow?: ChatInternalRow;
};

type HostQueueSummary = {
  waitingDelegationIds?: readonly string[];
  restartHeldByBackgroundWork?: true;
};

type HostQueueSummarySnapshot = Pick<ChatQueueUpdatedEvent, 'chatId'> &
  HostQueueSummary;

export const EMPTY_WAITING_DELEGATION_IDS: readonly string[] = Object.freeze(
  [],
);

/**
 * Normalizes the host's parent-delegation queue summary without changing its
 * queue order. Empty snapshots share one immutable array to keep selectors
 * stable when the host has nothing waiting.
 */
export function normalizeWaitingDelegationIds(
  delegationIds: readonly string[] | undefined,
): readonly string[] {
  if (!delegationIds || delegationIds.length === 0) {
    return EMPTY_WAITING_DELEGATION_IDS;
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const delegationId of delegationIds) {
    if (
      typeof delegationId !== 'string' ||
      delegationId.length === 0 ||
      seen.has(delegationId)
    ) {
      continue;
    }
    seen.add(delegationId);
    normalized.push(delegationId);
  }
  // An already-normalized list keeps its identity so rebuilt tabs stay stable.
  if (normalized.length === delegationIds.length) return delegationIds;
  return normalized.length > 0 ? normalized : EMPTY_WAITING_DELEGATION_IDS;
}

function sameWaitingDelegationIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((delegationId, index) => delegationId === right[index])
  );
}

/** Set one tab's transient host-reported queue summary. */
export function withHostQueueSummary(
  tab: ChatTab,
  summary: HostQueueSummary | undefined,
): ChatTab {
  const normalized = normalizeWaitingDelegationIds(
    summary?.waitingDelegationIds,
  );
  const restartHeldByBackgroundWork =
    summary?.restartHeldByBackgroundWork === true;
  if (
    tab.waitingDelegationIds !== undefined &&
    sameWaitingDelegationIds(tab.waitingDelegationIds, normalized) &&
    (tab.restartHeldByBackgroundWork === true) === restartHeldByBackgroundWork
  ) {
    return tab;
  }
  const updatedTab: ChatTab = {
    ...tab,
    waitingDelegationIds: normalized,
  };
  if (restartHeldByBackgroundWork) {
    updatedTab.restartHeldByBackgroundWork = true;
  } else {
    delete updatedTab.restartHeldByBackgroundWork;
  }
  return updatedTab;
}

/**
 * Apply full host queue summaries to their tabs. Tabs omitted by the snapshot
 * are cleared because it is authoritative for the hydrated scope.
 */
export function attachHostQueueSummariesFromQueueSnapshots(
  tabs: ChatTab[],
  snapshots: readonly HostQueueSummarySnapshot[],
): ChatTab[] {
  const summaryByChatId = new Map(
    snapshots.map((snapshot) => [snapshot.chatId, snapshot]),
  );
  return tabs.map((tab) =>
    withHostQueueSummary(tab, summaryByChatId.get(tab.id)),
  );
}

/** Keep one tab's transient host queue summary when a renderer event rebuilds it. */
export function preserveHostQueueSummaryForTab(
  previous: ChatTab | undefined,
  next: ChatTab,
): ChatTab {
  if (!previous) return next;
  return withHostQueueSummary(next, previous);
}

/** Keep transient host queue summaries when canonical changes rebuild tabs. */
export function preserveHostQueueSummaries(
  previousTabs: readonly ChatTab[],
  nextTabs: ChatTab[],
): ChatTab[] {
  const previousById = new Map(previousTabs.map((tab) => [tab.id, tab]));
  return nextTabs.map((tab) =>
    preserveHostQueueSummaryForTab(previousById.get(tab.id), tab),
  );
}

/** Select whether the host currently holds this chat for a settings restart. */
export function selectRestartHeldByBackgroundWork(
  state: Pick<ChatState, 'worktreeChats'>,
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return (
    state.worktreeChats[`${projectId}/${worktreeId}`]?.tabs.find(
      (tab) => tab.id === chatId,
    )?.restartHeldByBackgroundWork === true
  );
}

/**
 * Convert the host-owned queue view rows (broadcast over `chatQueueUpdated` or
 * pulled via `getChatQueueSnapshot`) into renderer `QueuedChatMessage` mirror
 * rows. Mirror rows carry `hostQueueEntryId` so the store can distinguish them
 * from renderer-local rows (hook placeholders, git-pending) that main does not
 * own. Single source of truth for the mapping so the live-event path and the
 * hydration path stay identical.
 */
export function hostQueueViewsToQueuedMessages(
  queue: readonly HostQueueMirrorInput[],
): QueuedChatMessage[] {
  return queue
    .filter((message) => !isInternalChatRequest(message))
    .map((message) => ({
      hostQueueEntryId: message.id,
      ...(message.supersedesUserMessageId !== undefined
        ? { supersedesUserMessageId: message.supersedesUserMessageId }
        : {}),
      text: message.text,
      ...(message.promptSource ? { promptSource: message.promptSource } : {}),
      ...(message.fileReferences
        ? { fileReferences: message.fileReferences }
        : {}),
      ...(message.attachmentPaths
        ? { attachmentPaths: message.attachmentPaths }
        : {}),
      ...(message.attachmentPromptContexts
        ? { attachmentPromptContexts: message.attachmentPromptContexts }
        : {}),
      origin: message.origin,
      enqueuedAtMs: message.enqueuedAtMs,
      // Transient: main republishes rows when only the phase changes.
      ...(message.turnPhase ? { turnPhase: message.turnPhase } : {}),
      ...(message.waitingReason
        ? { waitingReason: message.waitingReason }
        : {}),
      ...(message.retryable === true ? { retryable: true } : {}),
      ...(message.retryBlockedReason
        ? { retryBlockedReason: message.retryBlockedReason }
        : {}),
      ...(message.blockedByBackgroundWork === true
        ? { blockedByBackgroundWork: true }
        : {}),
      ...(message.editLocked === true ? { editLocked: true } : {}),
      ...(message.forceLocked === true ? { forceLocked: true as const } : {}),
      ...(message.canSteer === true ? { canSteer: true } : {}),
      ...(message.steerBlockedByCapabilityChange === true
        ? { steerBlockedByCapabilityChange: true }
        : {}),
      ...(message.restartHeldChanges
        ? { restartHeldChanges: message.restartHeldChanges }
        : {}),
      ...(message.watcherFired ? { watcherFired: message.watcherFired } : {}),
      ...(message.agentSent ? { agentSent: message.agentSent } : {}),
    }));
}

export function attachHostQueueMirror(
  tabs: ChatTab[],
  queuedByChatId: Map<string, QueuedChatMessage[]>,
): ChatTab[] {
  if (queuedByChatId.size === 0) return tabs;

  return tabs.map((tab) => {
    const mirrored = queuedByChatId.get(tab.id);
    if (!mirrored || mirrored.length === 0) return tab;
    tab = withdrawQueuedSends(
      restoreDispatchedQueueRow(tab, mirrored),
      mirrored,
    );
    // Preserve renderer-local rows (hook placeholders, git-pending) that main
    // does not own, then append the host-owned mirror rows.
    const localRows = tab.queuedMessages.filter(
      (message) => message.hostQueueEntryId === undefined,
    );
    return {
      ...tab,
      queuedMessages: [...localRows, ...mirrored],
      pendingQueueMessages: reconcilePendingQueueMessages(
        tab.pendingQueueMessages,
        mirrored,
      ),
    };
  });
}

/**
 * Keep the host-owned queue mirror when a renderer event rebuilds a tab from
 * persisted data. The caller remains responsible for deciding which
 * renderer-local rows survive that rebuild.
 */
export function preserveHostQueueMirror(
  previousRows: QueuedChatMessage[] | undefined,
  localRows: QueuedChatMessage[],
): QueuedChatMessage[] {
  const mirroredRows =
    previousRows?.filter((message) => message.hostQueueEntryId !== undefined) ??
    [];
  return [...localRows, ...mirroredRows];
}

/** What the head row's force action means for a queued row. */
export type QueuedRowForceAction = 'interrupt' | 'retry' | 'run-now';

/**
 * Chooses the force action's meaning by row. A background-work-held host row
 * runs now so the settings-triggered restart can be bypassed; otherwise a
 * host-accepted row interrupts in the foreground and retries outside it. A
 * hook placeholder runs now without waiting for a concurrency slot. Any other
 * renderer-local row interrupts a streaming turn and retries a failed or
 * uncertain dispatch. While its turn is dispatching, or the tab is idle with
 * nothing to recover, it offers no force action (CAN-5031).
 */
export function queuedRowForceAction(
  message: Pick<
    QueuedChatMessage,
    | 'hostQueueEntryId'
    | 'queuedHookQueueId'
    | 'turnPhase'
    | 'waitingReason'
    | 'retryBlockedReason'
    | 'retryable'
  >,
  localTurn: LocalTurnActivity,
): QueuedRowForceAction | undefined {
  if (message.hostQueueEntryId !== undefined) {
    return queuedMessageForceKind({
      turnPhase: message.turnPhase,
      waitingReason: message.waitingReason,
      retryBlockedReason: message.retryBlockedReason,
      retryable: message.retryable,
    });
  }
  if (message.queuedHookQueueId !== undefined) return 'run-now';
  if (localTurn === 'streaming') return 'interrupt';
  return localTurn === 'recoverable' ? 'retry' : undefined;
}

/**
 * The phase the action strip gates Steer and Interrupt by. Host rows carry
 * the host's phase. A renderer-local row reports none, so its phase is the
 * tab's own turn, in the foreground from dispatch on, rather than the
 * pre-phase rule for older hosts.
 */
export function queuedRowTurnPhase(
  message: Pick<QueuedChatMessage, 'hostQueueEntryId' | 'turnPhase'>,
  localTurn: LocalTurnActivity,
): ChatTurnPhase | undefined {
  if (message.hostQueueEntryId !== undefined) return message.turnPhase;
  return localTurn === 'streaming' || localTurn === 'dispatching'
    ? 'foreground'
    : 'idle';
}
