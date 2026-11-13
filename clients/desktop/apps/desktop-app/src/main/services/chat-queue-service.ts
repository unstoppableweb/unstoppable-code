import { DELEGATION_NOTICE_KIND } from '@canopy/agent-actions';
import { readAutoResumeMetadata } from '@canopy/protocol/portal';
import {
  agentSendAcceptanceReceipt,
  reportAgentSendAccepted,
} from '../canopy-runtime/core-chat-message-command-adapter';
import type {
  AgentSendAcceptanceFacts,
  AgentSendRefusalCode,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import type {
  WatcherDeliveryIngressCheck,
  ChatWatcherHeldOutcome,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  checkWatcherDeliveryIngress,
  WatcherDeliveryHeldError,
} from './active-chat-input';
import {
  revalidateAgentSenderRequest,
  revalidateAgentSteeringActor,
  agentSendTargetReadiness,
  withAgentSenderAuthority,
  isAgentSenderContextError,
} from '../agent-messaging/sender-context';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BrowserWindow } from 'electron';
import type {
  ChatQueueEditRequest,
  ChatQueueOrigin,
  ChatQueueTarget,
  ChatQueueUpdatedEvent,
  ChatSendMessageRequest,
  ChatTabPluginSelections,
  HostQueuedMessageView,
  PersistedHostQueuedMessage,
} from '@canopy/desktop-shared/types';
import {
  getExecutionHarnessForModel,
  getProviderForChatModel,
  getProviderForModel,
  IPC_CHANNELS,
  isTerminalBackedInterfaceMode,
} from '@canopy/desktop-shared/types';
import { getEffectiveClaudeChatInterfaceMode } from '../lib/claude-tui-chats';
import {
  chatSurfaceUsesGlobalPluginDefaults,
  pluginSelectionsEqual,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { isInternalChatRequest } from '@canopy/desktop-shared/lib/internal-chat-row';
import {
  classifyInputRequest,
  isGeneratedInputRequest,
} from './chat-input-request-kind';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  getChatSessionLiveness,
  getSessionPluginSelections,
  getSessionGlobalPluginDefaultsRevision,
  chatHasNativeBackgroundWork,
  subscribeChatSessionActivity,
  subscribeGlobalPluginDefaultsRevision,
  subscribeLiveBackgroundTasks,
  hasPendingCodexContinuation,
} from '../agents/session-manager';
import {
  chatHasLiveDelegations,
  subscribeDelegationActivity,
} from '../agents/delegation/activity';
import { isDelegationDeliveryActive } from '../agents/delegation/lifecycle';
import { subscribeSteeringEligibility } from '../agents/steering-eligibility-events';
import { buildChatSessionKey } from '../agents/session-key';
import { hasPendingApprovalForSession } from '../approvals/pending-approvals';
import { hasPendingRequestForSession } from '../mcp/pending-requests';
import {
  getCodexTurnEvidence,
  observeCodexTurnTerminal,
} from '../agents/provider-turn-evidence';
import { getInheritedPluginDefaultsRevision } from '../plugins/plugin-defaults-revision';
import { isTurnAuthPreflightRefusal } from '../lib/auth-preflight-error';
import { beginChatTurnPreparation } from '../lib/chat-turn-cancel';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { sendToWindow } from '../lib/window-send';
import { isAutoModelRoutingApplyError } from '../model-routing/apply-error';
import { isAutoModelRoutingInProgressError } from '../model-routing/in-progress-error';
import { RetiredChatScopeError } from '../lib/retired-chat-scope-guard';
import { isChatScopeDeletingError } from './chat-scope-lifecycle';
import * as turnSessionReuse from '../lib/turn-session-reuse';
import type { TurnSessionReuseDecision } from '../lib/turn-session-reuse';
import { getObservabilityService } from '../observability';
import type { SessionDiagnosticRecord } from '../observability/service';
import {
  startChatWaitOperation,
  type ChatWaitOperation,
} from '../observability/chat-wait-diagnostics';
import type { GeneratedSteeringResult } from './chat-input-delivery-coordinator';
import type { ChatMutationOptions } from './chat-state-contracts';
import type {
  ChatTurnPhase,
  QueuedMessageRetryBlockedReason,
  SettingsHeldChange,
} from '@canopy/protocol/portal';
import {
  canRecoverCodexTurn,
  evaluateTurnAdmission,
  readChatTurnPhase,
  type ChatTurnReservation,
} from './chat-turn-phase';
import {
  getChatTurnOwnership,
  type ChatTurnOwnershipSource,
} from './chat-turn-ownership';
import { isCurrentTurnBindingFull } from './chat-turn-binding-slots';
import {
  ChatDispatchOutcomeError,
  getChatDispatchAuthorization,
  getChatDispatchOutcomeAction,
  type AuthorizedChatDispatch,
  type ChatDispatchAuthorizationPort,
  type ChatDispatchOutcome,
} from './chat-dispatch-authorization';

type ChatQueueCommandResult = NonNullable<ChatMutationOptions['commandResult']>;

export type ChatQueueDispatchOptions = Pick<
  PersistedHostQueuedMessage,
  'requiredAccountProxyConnectionId'
> & {
  /** Host-only: explicit force of a confirmed funded credit hold. */
  creditRetryAttemptId?: string;
};

function assertValidQueueDispatchOptions(
  options: ChatQueueDispatchOptions,
): void {
  const pin = options.requiredAccountProxyConnectionId;
  if (pin !== undefined && (typeof pin !== 'string' || !pin.trim()))
    throw new Error('Queued continuation billing constraint is invalid.');
}

const QUEUE_PERSISTENCE_RETRY_MIN_MS = 500;
const QUEUE_PERSISTENCE_RETRY_MAX_MS = 5_000;
const QUEUE_COMMIT_FALLBACK_MAX_AUTOMATIC_RETRIES = 5;
const QUEUE_COMMIT_FALLBACK_MAX_RETRY_MS = 30_000;
const QUEUE_GATE_STALE_RECONCILE_MS = 5_000;
const QUEUE_DRAIN_RETRY_MS = 1_000;
const QUEUE_RESTORE_WAIT_RETRY_MS = 50;
const QUEUE_RESTORE_WAIT_MAX_MS = 30_000;

async function readExistingTabComposerOptions(
  target: ChatQueueTarget,
): Promise<Partial<ChatSendMessageRequest>> {
  // Both dependencies are lazy: chat-service routes through this queue and
  // the canonical tab reader is backed by chat-state-service.
  const [{ buildExistingTabDispatchOptions }, { readChatTabsFile }] =
    await Promise.all([
      import('./chat-service'),
      import('../lib/chat-tabs-reader'),
    ]);
  const [persistedOptions, tabsFile] = await Promise.all([
    buildExistingTabDispatchOptions(
      target.projectId,
      target.worktreeId,
      target.chatId,
    ),
    readChatTabsFile(target.projectId, target.worktreeId),
  ]);
  const tab = tabsFile.tabs.find(
    (candidate) =>
      candidate.id === target.chatId && (candidate.kind ?? 'chat') === 'chat',
  );
  if (!tab) return persistedOptions;

  // Mirror the watcher's dispatch projection: persisted values win, with
  // metadata fallbacks for model/provider/harness and resolved tab approval.
  const model = persistedOptions.model ?? tab.model;
  const persistedHarness =
    persistedOptions.executionHarness ?? tab.executionHarness;
  const persistedProvider = persistedOptions.providerType ?? tab.providerType;
  const executionHarness =
    persistedHarness ??
    (model ? getExecutionHarnessForModel(model) : undefined) ??
    (persistedProvider === 'codex' ||
    persistedProvider === 'cursor' ||
    persistedProvider === 'copilot'
      ? persistedProvider
      : 'claude');
  const modelProvider = model
    ? (getProviderForChatModel(model, executionHarness) ??
      getProviderForModel(model))
    : undefined;
  const providerType =
    executionHarness === 'cursor' || executionHarness === 'copilot'
      ? executionHarness
      : (persistedProvider ??
        modelProvider ??
        (executionHarness === 'claude' || executionHarness === 'codex'
          ? executionHarness
          : 'claude'));
  const { clampToLiveApprovalMode } =
    await import('../approvals/live-approval-modes');
  const { resolvePersistedApprovalMode } =
    await import('../lib/approval-mode-resolution');
  const approvalMode = await resolvePersistedApprovalMode(
    target.projectId,
    target.worktreeId,
    clampToLiveApprovalMode(
      target.projectId,
      target.worktreeId,
      target.chatId,
      tab.approvalMode,
    ),
  );
  return {
    ...persistedOptions,
    ...(model ? { model } : {}),
    ...(providerType ? { providerType } : {}),
    executionHarness,
    approvalMode,
  };
}

type QueueGateSource = NonNullable<SessionDiagnosticRecord['queueGateSource']>;
type QueueDrainGuard = NonNullable<SessionDiagnosticRecord['queueDrainGuard']>;
type QueueDrainWakeEvent = NonNullable<
  SessionDiagnosticRecord['queueDrainWakeEvent']
>;

function isTurnPreparationCancelled(
  preparation: { readonly cancelled: boolean } | undefined,
): boolean {
  return preparation?.cancelled === true;
}

export type ChatQueueTerminalStatus = 'complete' | 'error' | 'cancelled';
export type ChatQueueMutationResult =
  | 'applied'
  | 'not_found'
  | 'busy'
  | 'conflict';
/** Receipt reason for a stale entry revision (CAN-4112). */
export const QUEUE_ENTRY_REVISION_CONFLICT_REASON =
  'The queued message has changed. Read the queue again and retry.';
export interface ChatQueueEntryGuard {
  /** The revision the caller read; absent skips the check. */
  readonly entryRevision?: number;
}

/** Ownership token for the queue side of an accepted provider-turn revival. */
export interface ChatQueueRevivalLease {
  readonly rootId: string;
  readonly epoch: number;
}

/** An admitted host dispatch; undefined capability means an unbound queue. */
export interface ChatDirectDispatchAdmission {
  readonly authorization: AuthorizedChatDispatch | undefined;
  /** Release D when the dispatch did not start; idempotent. */
  release(): void;
}

interface InertRevivalLeaseEvidence {
  readonly key: string;
  entry?: ChatQueueEntry;
}

export type ChatQueuePersistenceMutation =
  | {
      type: 'agent-send-accepted';
      request: ChatSendMessageRequest;
      acceptance: AgentSendAcceptanceFacts;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      type: 'restore-input';
      request: ChatSendMessageRequest;
      rowId: string;
      epoch: number;
      ordinaryOnly?: true;
      allowUncertain?: true;
      continuation?: { attemptId: string; epoch: number };
      /** Async question reopened because the user edited this answer. */
      restoredAsyncQuestionId?: string;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      type: 'edit';
      request: ChatSendMessageRequest;
      /** Async question reopened when this queued answer became ordinary text. */
      restoredAsyncQuestionId?: string;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      type: 'cancel';
      request: ChatSendMessageRequest;
      lastErrorMessage?: string;
      agentSendRefusalCode?: AgentSendRefusalCode;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      /** Order-only commit: the complete queue order is the runtime patch. */
      type: 'move';
      commandResult?: ChatQueueCommandResult;
    }
  | {
      type: 'consume-restored-input';
      request: ChatSendMessageRequest;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      type: 'force';
      request: ChatSendMessageRequest;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      /** Cancels a still-queued agent acceptance row; never touches the transcript. */
      type: 'settle-agent-input';
      request: ChatSendMessageRequest;
      reason: string;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      /**
       * The sends taken off the queue, in order, because the worktree setup
       * that held them ended `outcome`; their turns end that way in the
       * commit that removes them.
       */
      type: 'end-setup-held';
      requests: readonly ChatSendMessageRequest[];
      outcome: 'cancelled' | 'failed';
    };

interface HostQueuedMessage extends PersistedHostQueuedMessage {
  ordinaryOnly?: boolean;
  editLocked?: boolean;
  /** Runtime-only hold: retain the durable row, but do not stall later input. */
  watcherDeliveryHeld?: ChatWatcherHeldOutcome;
  /** A committed user edit prevents later watcher deliveries coalescing here. */
  watcherConsolidationBoundary?: boolean;
  /** Trusted source messages retained while adjacent watcher rows coalesce. */
  watcherParts?: QueuedWatcherPart[];
  /** Transient: Run now on a held row sends with the live session's settings. */
  liveSessionSettings?: true;
  /** Transient: what sending this row's saved request now would restart for. */
  restartHeldChanges?: readonly SettingsHeldChange[];
}

interface QueuedWatcherPart {
  authority: 'watcher' | 'notice' | 'none';
  request: ChatSendMessageRequest;
  userMessageId: string;
  kind: string;
  text: string;
  hiddenContextText?: string;
}

interface ChatQueueEntry {
  /** Chat identity for activity-driven phase refreshes; never a request payload. */
  readonly target: ChatQueueTarget;
  operationEpoch?: number;
  /**
   * Accepted dispatches published as canonical D owners. Each holds admission
   * and wake from acquisition until its durable start, refusal, cancel or
   * terminal; provider idle and elapsed time never release one.
   */
  dispatchOwners?: Array<{
    readonly token: symbol;
    readonly operationEpoch: number;
    readonly userMessageId?: string;
  }>;
  /** A D with no message, held for the continuation its holder admits later. */
  directDispatchHold?: { readonly token: symbol; readonly holderId: string };
  /** The gate was adopted from canonical evidence, not from host runtime. */
  gateFromCanonical?: boolean;
  /** Untagged terminal releases (Stop/destroy) seen for this chat. */
  untaggedTerminals?: number;
  queue: HostQueuedMessage[];
  /** Dequeued user intent remains durable until its prompt transaction commits. */
  dispatching?: HostQueuedMessage;
  persistedInputIds: Set<string>;
  turnActive: boolean;
  dispatchInFlight: boolean;
  /** Serializes queue drains while asynchronous provider-event barriers settle. */
  drainInFlight?: boolean;
  /** A wake arrived while a serialized drain was awaiting its event barrier. */
  drainRequested?: true;
  recoveryInFlight: boolean;
  recoveryWait?: ChatWaitOperation;
  /**
   * Set with recoveryInFlight while a queue order commit persists. The order
   * change keeps every row's payload, so published Steer actions stay
   * available; steer() itself still refuses until the commit settles.
   */
  reorderInFlight?: boolean;
  /**
   * Cancels whose removal is still persisting. A failed cancel puts its row
   * back at the index it had, so moves wait until these settle.
   */
  cancelsInFlight?: number;
  /** Suppresses changed queue snapshots when concurrent persistence resolves out of order. */
  broadcastRevision?: number;
  /** Serialized public queue shape associated with broadcastRevision. */
  broadcastQueueSignature?: string;
  /** Current queue operation that owns an admission reservation, if any. */
  reservation?: ChatTurnReservation;
  /** Identity token for the current provider-turn recovery operation. */
  recoveryOwner?: symbol;
  /** Phase most recently published for the current queue snapshot. */
  lastPublishedTurnPhase?: ChatTurnPhase;
  /** Current durable broadcast is waiting before its event can be published. */
  broadcastPersistencePending?: boolean;
  /** A phase refresh arrived while durable queue state was being written. */
  pendingPhaseBroadcast?: boolean;
  pendingBroadcastRevision?: number;
  pendingBroadcastCount?: number;
  pendingBroadcastSucceeded?: boolean;
  /** Number of canonical queue writes that have not settled yet. */
  pendingQueuePersistenceCount?: number;
  /** Deferred automatic watcher-steering loop state. */
  steeringEligibilityRevision?: number;
  steeringPending?: boolean;
  steeringTimer?: ReturnType<typeof setTimeout>;
  steeringInFlight?: boolean;
  /** Queue row an automatic steering attempt holds until it settles. */
  steeringRowId?: string;
  /** Prevents a durable claim from being projected as still waiting during races. */
  claimedQueueRowIds?: Set<string>;
  /** By queue row id: the eligibility revision at which it was last refused. */
  steeringRefusalRevisions?: Map<string, number>;
  frozenForDeletion?: boolean;
  authenticationPause?: string;
  /**
   * Set while the chat's worktree Git setup runs. `turnUserMessageId` is the
   * turn the setup holds, which owns the gate meanwhile; once released for it
   * as `firstUserMessageId`, only that send dispatches.
   */
  worktreeSetupHold?: {
    turnUserMessageId?: string;
    firstUserMessageId?: string;
  };
  discardedForDeletion?: boolean;
  /** userMessageId of the currently dispatched turn, for stale-release checks. */
  activeTurnUserMessageId?: string;
  /** Root accepted by the current revival lease, if one is still current. */
  revivalLeaseRootId?: string;
  /** A current revival lease whose own tagged terminal released the gate. */
  revivalTerminalReleaseRootId?: string;
  /** Selection snapshot captured when the currently running turn was accepted. */
  activePluginSelections?: ChatTabPluginSelections;
  activeGlobalPluginDefaultsRevision?: number;
  currentGlobalPluginDefaultsRevision?: number;
  drainTimer?: ReturnType<typeof setTimeout>;
  drainTimerDueAtMs?: number;
  heldRetryTimer?: ReturnType<typeof setTimeout>;
  heldRetryDelayMs?: number;
  /** A durably restored row waiting for a user or auth retry trigger. */
  externalRetryParked?: true;
  /** A refused queued turn is retained until explicit funded Retry. */
  creditHold?: { funded: boolean; refresh?: Promise<void> };
  creditRetryCandidate?: HostQueuedMessage;
  /** Ephemeral native-work refusal; never restored from persisted queue state. */
  backgroundWorkHold?: { readonly rowId: string };
  /** Latest best-effort projection of persisted chat settings onto live work. */
  restartHeldByBackgroundWork?: true;
  queueGateSource?: QueueGateSource;
  queueGateArmedAtMs?: number;
  gateReconcileTimer?: ReturnType<typeof setTimeout>;
  gateReconcileTimerOwner?: symbol;
  gateReconcileOwner?: symbol;
  diagnosedDrainDeclines?: Set<QueueDrainGuard>;
}

interface RestartHoldRefreshState {
  revision: number;
}

export interface ChatQueueWorktreeDeletion {
  commit(): void;
  rollback(options?: ChatQueueWorktreeDeletionRollbackOptions): void;
}

export interface ChatQueueWorktreeDeletionRollbackOptions {
  /** Every provider session in the scope was removed before deletion failed. */
  sessionsDestroyed?: boolean;
}

export interface ChatQueueServiceDependencies {
  /** Read hosted funding for this work owner; never starts a turn. */
  readCreditFunding?(target: ChatQueueTarget): Promise<boolean>;
  checkWatcherIngress?(
    request: ChatSendMessageRequest,
  ): ReturnType<WatcherDeliveryIngressCheck>;
  steerGenerated?(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    queuedIds: () => string[],
    allowSteering: boolean,
    canSteerNow?: () => boolean,
    /** Runs once the input-delivery ledger durably owns the input. */
    claimed?: () => void,
  ): Promise<GeneratedSteeringResult>;
  steerQueuedGenerated?(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    queuedIds: () => string[],
    canSteerNow: () => boolean,
    claimed: () => void,
  ): Promise<GeneratedSteeringResult>;
  dispatch(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    fromQueue: boolean,
    /** This admission's capability; the final dispatcher consumes it once. */
    authorization?: AuthorizedChatDispatch,
    options?: ChatQueueDispatchOptions,
  ): Promise<void | ChatDispatchOutcome>;
  /**
   * Register Stop ownership for a send the queue has accepted but not yet
   * handed to the provider. The same send's turn preparation, begun inside
   * `dispatch`, inherits a Stop that lands in between.
   */
  beginTurnPreparation?(
    target: ChatQueueTarget & { readonly userMessageId?: string },
  ): { readonly cancelled: boolean; finish(): void };
  cancel(target: ChatQueueTarget): Promise<void>;
  settleCancelledTurn(
    target: ChatQueueTarget,
    turnUserMessageId?: string,
  ): void | Promise<void>;
  /**
   * True when the provider session is already processing (or has internally
   * accepted) a turn that did not originate through this queue service, such
   * as a Claude background-task continuation waking an idle chat.
   */
  hasActiveProviderTurn(target: ChatQueueTarget): boolean;
  /** Selection snapshot of the active provider session, if one exists. */
  getActiveProviderPluginSelections?(
    target: ChatQueueTarget,
  ): ChatTabPluginSelections | undefined;
  getActiveProviderPluginDefaultsRevision?(
    target: ChatQueueTarget,
  ): number | undefined;
  getCurrentPluginDefaultsRevision?(
    target: ChatQueueTarget,
  ): number | undefined;
  /** Settle received events before a new dispatch replaces their route. */
  drainProviderEvents?(target: ChatQueueTarget): Promise<void>;
  endDiscardedTurns?(
    target: ChatQueueTarget,
    requests: readonly ChatSendMessageRequest[],
  ): Promise<void>;
  /** True while a live Codex turn is paused for user input and can resume. */
  hasPendingProviderContinuation(target: ChatQueueTarget): boolean;
  /** Live child/delegation work that remains after its root provider turn ends. */
  hasBackgroundWork?(target: ChatQueueTarget): boolean;
  /** Native provider work that a session recycle would stop; excludes delegations. */
  hasNativeBackgroundWork?(target: ChatQueueTarget): boolean;
  /** Injectable seams for session-reuse protection and force-send projection. */
  decideTurnSessionReuse?(
    request: ChatSendMessageRequest,
  ): Promise<TurnSessionReuseDecision>;
  holdsForBackgroundWork?(
    target: ChatQueueTarget,
    decision: TurnSessionReuseDecision,
  ): boolean;
  /** Persisted, user-editable tab options only; never transcript/generated metadata. */
  readPersistedTabOptions?(
    target: ChatQueueTarget,
  ): Promise<Partial<ChatSendMessageRequest>>;
  /** A tool approval or a question for this chat is waiting on the user. */
  hasPendingUserDecision?(target: ChatQueueTarget): boolean;
  persistRuntime(
    target: ChatQueueTarget,
    queuedMessageIds: readonly string[],
    turnActive: boolean,
    mutation?: ChatQueuePersistenceMutation,
    queuedMessages?: readonly PersistedHostQueuedMessage[],
    activeTurnUserMessageId?: string,
    inFlight?: PersistedHostQueuedMessage,
  ): void | Promise<void>;
  /** Whether the provider prompt has already committed to the transcript. */
  hasCommittedMessage?(
    target: ChatQueueTarget,
    userMessageId: string,
  ): Promise<boolean>;
  /** Whether the canonical chat runtime still has this tagged turn open. */
  isCanonicalTurnOpen?(
    target: ChatQueueTarget,
    turnUserMessageId: string,
  ): Promise<boolean>;
  broadcast(event: ChatQueueUpdatedEvent): void;
  createId(): string;
  now(): number;
  schedule(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  /**
   * Canonical turn ownership. The process queue passes the aggregate; without
   * one, the provider inputs decide (isolated tests).
   */
  ownership?: ChatQueueOwnershipPort;
  /** Dispatch capabilities; defaults to the process registry. */
  authorization?: ChatDispatchAuthorizationPort;
}

/**
 * The chat turn execution seam (CAN-4110 D2). The queue starts an admitted
 * turn by calling it; chat admission, receipts and idempotency all happen
 * before this call. Its production value, `dispatchQueuedChatMessage`,
 * stays; the turn below this seam runs on the local worker (CAN-4115), whose
 * boundary sits at session creation.
 */
type ChatTurnExecutionSeam = ChatQueueServiceDependencies['dispatch'];

/** The canonical ownership the queue reads and publishes its D owners into. */
export type ChatQueueOwnershipPort = Pick<
  ChatTurnOwnershipSource,
  | 'getSnapshot'
  | 'hydrate'
  | 'subscribe'
  | 'registerDispatchOwner'
  | 'removeDispatchOwner'
> & { isBound(): boolean };

/** Retry delay after a failed canonical ownership read; admission stays closed. */
const OWNERSHIP_HYDRATION_RETRY_MS = 1_000;

function chatQueueKey(target: ChatQueueTarget): string {
  return `${target.projectId}/${target.worktreeId}/${target.chatId}`;
}

/** Requests carry more than identity; ownership is keyed by the bare scope. */
function chatTurnScope(target: ChatQueueTarget): ChatQueueTarget {
  return {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
  };
}

function chatQueueRowKey(target: ChatQueueTarget, rowId: string): string {
  return `${chatQueueKey(target)}:${rowId}`;
}

function prioritizeQueue(entry: ChatQueueEntry): void {
  // Stable sorting keeps arrival order within both visible and internal rows.
  // Hidden delegation deliveries always wait behind every visible queued row.
  entry.queue.sort(
    (left, right) =>
      Number(isInternalChatRequest(left.request)) -
      Number(isInternalChatRequest(right.request)),
  );
}

/**
 * Delegation provenance must be host-issued and still live before admission,
 * and a delegate is a message's sender only on its own delivery.
 */
function validateDelegationDelivery(
  request: ChatSendMessageRequest,
  origin: ChatQueueOrigin,
): void {
  const deliveryId = request.managedDelegationDeliveryId;
  const noticeBatchId = request.delegationNoticeBatchId;
  const isDelegationNotice =
    request.watcherFired?.kind === DELEGATION_NOTICE_KIND;
  const hasNoticeBatchId = noticeBatchId !== undefined;
  const validNoticeBatchId =
    typeof noticeBatchId === 'string' &&
    noticeBatchId.length > 0 &&
    noticeBatchId === request.userMessageId &&
    origin !== 'portal' &&
    isDelegationNotice &&
    request.watcherDeliveryId === undefined &&
    request.managedDelegationDeliveryId === undefined &&
    request.internalRow === undefined;
  if (
    (deliveryId &&
      (origin === 'portal' ||
        deliveryId !== request.userMessageId ||
        !isDelegationDeliveryActive(request, deliveryId))) ||
    (request.agentSent !== undefined &&
      'kind' in request.agentSent &&
      request.agentSent.kind === 'managed_delegate' &&
      !deliveryId) ||
    (hasNoticeBatchId && !validNoticeBatchId) ||
    (isDelegationNotice && !validNoticeBatchId && !request.watcherDeliveryId)
  ) {
    throw new Error('Invalid delegation delivery');
  }
}

function hasTrackedWatcherDelivery(
  entry: ChatQueueEntry,
  request: ChatSendMessageRequest,
): boolean {
  if (!request.watcherFired) return false;
  const userMessageId = request.userMessageId;
  if (entry.activeTurnUserMessageId === userMessageId) return true;
  return entry.queue.some(
    (message) =>
      message.request.userMessageId === userMessageId ||
      message.request.consolidatedWatcherUserMessageIds?.includes(
        userMessageId,
      ) === true ||
      message.watcherParts?.some(
        (part) => part.userMessageId === userMessageId,
      ) === true,
  );
}

function watcherPartFromRequest(
  request: ChatSendMessageRequest,
): QueuedWatcherPart | undefined {
  if (
    !request.watcherFired ||
    request.agentSent ||
    request.agentSenderProvenance ||
    request.internalRow ||
    request.managedDelegationDeliveryId !== undefined ||
    request.asyncQuestionId !== undefined ||
    request.initiationSource === 'automation' ||
    request.automationName !== undefined ||
    classifyInputRequest(request) !== 'watcher'
  )
    return undefined;
  if (
    request.hiddenContext !== undefined &&
    request.hiddenContext.kind !== 'canopy-watcher-event'
  ) {
    return undefined;
  }
  return {
    authority:
      request.delegationNoticeBatchId !== undefined
        ? 'notice'
        : request.watcherDeliveryId !== undefined
          ? 'watcher'
          : 'none',
    request,
    userMessageId: request.userMessageId,
    kind: request.watcherFired.kind,
    text: request.text,
    ...(request.hiddenContext?.text
      ? { hiddenContextText: request.hiddenContext.text }
      : {}),
  };
}

function watcherVisibleSummary(part: QueuedWatcherPart): string {
  const lines = part.text.trim().split('\n');
  if (
    lines.length > 1 &&
    /(?:^|\s)watcher fired\.$/i.test(lines[0]?.trim() ?? '')
  ) {
    const summary = lines.slice(1).join('\n').trim();
    if (summary) return summary;
  }
  return part.text.trim() || part.kind;
}

function unwrapSystemInstruction(text: string): string {
  const trimmed = text.trim();
  const opening = '<system_instruction>';
  const closing = '</system_instruction>';
  if (trimmed.startsWith(opening) && trimmed.endsWith(closing)) {
    return trimmed.slice(opening.length, -closing.length).trim();
  }
  return trimmed;
}

function combinedWatcherHiddenContext(
  parts: readonly QueuedWatcherPart[],
): ChatSendMessageRequest['hiddenContext'] {
  const withContext = parts.filter(
    (part): part is QueuedWatcherPart & { hiddenContextText: string } =>
      Boolean(part.hiddenContextText?.trim()),
  );
  if (withContext.length === 0) return undefined;
  const contextCount = withContext.length;
  return {
    kind: 'canopy-watcher-event',
    text: [
      '<system_instruction>',
      `${contextCount} watcher event${contextCount === 1 ? '' : 's'} supplied hidden context while ${parts.length} watcher events fired and were consolidated into this queued message. The visible message summarizes every watcher; the entries below preserve hidden context only for events that supplied it. Respond to every watcher represented in the visible message and preserve each provided event's safety and follow-up instructions.`,
      '',
      `<watcher_messages count="${contextCount}">`,
      ...withContext.flatMap((part, index) => [
        `<watcher_message index="${index + 1}">`,
        unwrapSystemInstruction(part.hiddenContextText),
        '</watcher_message>',
      ]),
      '</watcher_messages>',
      '</system_instruction>',
    ].join('\n'),
  };
}

const WATCHER_IDENTITY_FIELDS = [
  'text',
  'watcherFired',
  'hiddenContext',
  'userMessageId',
  'clientUserMessageId',
  'watcherDeliveryId',
  'delegationNoticeBatchId',
  'consolidatedWatcherUserMessageIds',
  'watcherPartSnapshots',
] as const;

function watcherSharedFields(
  request: ChatSendMessageRequest,
): Partial<ChatSendMessageRequest> {
  const shared: Partial<ChatSendMessageRequest> = { ...request };
  for (const field of WATCHER_IDENTITY_FIELDS) delete shared[field];
  return shared;
}

/** Identity comes from the original part; shared settings remain current. */
function requestWithWatcherPartIdentity(
  current: ChatSendMessageRequest,
  original: ChatSendMessageRequest,
): ChatSendMessageRequest {
  const request = { ...current };
  for (const field of WATCHER_IDENTITY_FIELDS) {
    if (field !== 'text' && field !== 'userMessageId') delete request[field];
  }
  return {
    ...request,
    userMessageId: original.userMessageId,
    text: original.text,
    watcherFired: original.watcherFired,
    ...(original.hiddenContext !== undefined
      ? { hiddenContext: original.hiddenContext }
      : {}),
    ...(original.clientUserMessageId !== undefined
      ? { clientUserMessageId: original.clientUserMessageId }
      : {}),
    ...(original.watcherDeliveryId !== undefined
      ? { watcherDeliveryId: original.watcherDeliveryId }
      : {}),
    ...(original.delegationNoticeBatchId !== undefined
      ? { delegationNoticeBatchId: original.delegationNoticeBatchId }
      : {}),
  };
}

/** A stale snapshot from an older writer must never be used to split a row. */
function watcherPartsForMessage(
  message: HostQueuedMessage,
): QueuedWatcherPart[] | undefined {
  if (message.watcherParts) return message.watcherParts;
  const request = message.request;
  const ids = request.consolidatedWatcherUserMessageIds;
  const snapshots = request.watcherPartSnapshots;
  if (
    ids &&
    snapshots &&
    snapshots.length > 0 &&
    isDeepStrictEqual(
      snapshots.map((part) => part.userMessageId),
      ids,
    )
  ) {
    const parts = snapshots.map((part) =>
      watcherPartFromRequest({
        ...request,
        text: part.text,
        watcherFired: { kind: part.kind },
        hiddenContext: part.hiddenContext,
        userMessageId: part.userMessageId,
        clientUserMessageId: part.clientUserMessageId,
        watcherDeliveryId: part.watcherDeliveryId,
        delegationNoticeBatchId: part.delegationNoticeBatchId,
        consolidatedWatcherUserMessageIds: undefined,
        watcherPartSnapshots: undefined,
      }),
    );
    if (
      parts.every((part): part is QueuedWatcherPart => part !== undefined) &&
      parts.filter((part) => part.authority === 'watcher').length <= 1 &&
      parts.find((part) => part.authority === 'watcher')?.request
        .watcherDeliveryId === request.watcherDeliveryId
    ) {
      return parts;
    }
  }
  const part = watcherPartFromRequest(request);
  return part ? [part] : undefined;
}

function mergeableWatcherParts(
  previous: HostQueuedMessage,
  next: HostQueuedMessage,
  steeringRowId: string | undefined,
): QueuedWatcherPart[] | undefined {
  if (
    [previous, next].some(
      (row) =>
        row.id === steeringRowId ||
        row.ordinaryOnly ||
        row.editLocked ||
        row.watcherDeliveryHeld ||
        row.watcherConsolidationBoundary,
    ) ||
    previous.origin !== next.origin ||
    previous.requiredAccountProxyConnectionId !==
      next.requiredAccountProxyConnectionId ||
    previous.liveSessionSettings !== next.liveSessionSettings ||
    !isDeepStrictEqual(
      watcherSharedFields(previous.request),
      watcherSharedFields(next.request),
    )
  )
    return undefined;
  const left = watcherPartsForMessage(previous);
  const right = watcherPartsForMessage(next);
  if (!left || !right) return undefined;
  const parts = [...left, ...right];
  const opaque = parts.filter(
    (part) => part.request.consolidatedWatcherUserMessageIds !== undefined,
  );
  // An opaque authority-bearing row cannot prove its composition. An opaque
  // authority-free row behaves like a legacy no-id watcher, never a notice.
  if (opaque.some((part) => part.request.watcherDeliveryId !== undefined))
    return undefined;
  const watchers = parts.filter((part) => part.authority === 'watcher');
  if (
    watchers.length > 1 ||
    (watchers.length === 1 &&
      parts.some((part) => part.authority === 'none' || opaque.includes(part)))
  )
    return undefined;
  return parts;
}

function combinedWatcherRequest(
  request: ChatSendMessageRequest,
  parts: readonly QueuedWatcherPart[],
): ChatSendMessageRequest {
  const watcher = parts.find((part) => part.authority === 'watcher');
  const singleNotice =
    parts.length === 1 && parts[0]?.authority === 'notice'
      ? parts[0]
      : undefined;
  const combined = { ...request };
  // Never inherit a head's identity, including stale snapshots, by spreading it.
  for (const field of WATCHER_IDENTITY_FIELDS) {
    if (field !== 'text' && field !== 'userMessageId') delete combined[field];
  }
  const ids = Array.from(
    new Set(
      parts.flatMap(
        (part) =>
          part.request.consolidatedWatcherUserMessageIds ?? [
            part.userMessageId,
          ],
      ),
    ),
  );
  return {
    ...combined,
    userMessageId: watcher?.userMessageId ?? request.userMessageId,
    text: parts.map(watcherVisibleSummary).join('\n\n'),
    watcherFired: {
      kind: `Multiple watchers fired (${parts.length})`,
      combinedWatchers: parts.map(({ kind, text }) => ({ kind, text })),
    },
    hiddenContext: combinedWatcherHiddenContext(parts),
    consolidatedWatcherUserMessageIds: ids,
    ...(watcher
      ? { watcherDeliveryId: watcher.request.watcherDeliveryId }
      : {}),
    ...(singleNotice
      ? {
          delegationNoticeBatchId: singleNotice.request.delegationNoticeBatchId,
          clientUserMessageId: singleNotice.request.clientUserMessageId,
        }
      : {}),
    ...(parts.every(
      (part) => part.request.consolidatedWatcherUserMessageIds === undefined,
    )
      ? {
          watcherPartSnapshots: parts.map((part) => ({
            userMessageId: part.userMessageId,
            kind: part.kind,
            text: part.text,
            ...(part.request.hiddenContext
              ? { hiddenContext: part.request.hiddenContext }
              : {}),
            ...(part.request.clientUserMessageId !== undefined
              ? { clientUserMessageId: part.request.clientUserMessageId }
              : {}),
            ...(part.request.watcherDeliveryId !== undefined
              ? { watcherDeliveryId: part.request.watcherDeliveryId }
              : {}),
            ...(part.request.delegationNoticeBatchId !== undefined
              ? {
                  delegationNoticeBatchId: part.request.delegationNoticeBatchId,
                }
              : {}),
          })),
        }
      : {}),
  };
}

function canSteerQueuedMessage(
  entry: ChatQueueEntry,
  message: HostQueuedMessage,
  turnPhase: ChatTurnPhase,
): boolean {
  return !(
    (entry.recoveryInFlight && entry.reorderInFlight !== true) ||
    entry.dispatchInFlight ||
    entry.creditHold !== undefined ||
    entry.worktreeSetupHold !== undefined ||
    entry.backgroundWorkHold?.rowId === message.id ||
    message.ordinaryOnly === true ||
    message.editLocked ||
    message.watcherParts ||
    isGeneratedInputRequest(message.request) ||
    message.requiredAccountProxyConnectionId !== undefined ||
    steerBlockedByCapabilityChange(entry, message, turnPhase) ||
    entry.frozenForDeletion
  );
}

function steerBlockedByCapabilityChange(
  entry: ChatQueueEntry,
  message: HostQueuedMessage,
  turnPhase: ChatTurnPhase,
): boolean {
  return (
    turnPhase === 'foreground' &&
    (entry.activePluginSelections === undefined ||
      (entry.activeGlobalPluginDefaultsRevision !== undefined &&
        entry.currentGlobalPluginDefaultsRevision !==
          entry.activeGlobalPluginDefaultsRevision) ||
      !pluginSelectionsEqual(
        entry.activePluginSelections,
        normalizePluginSelections(message.request.pluginSelections),
      ))
  );
}

function isStaleEntry(
  message: HostQueuedMessage,
  guard?: ChatQueueEntryGuard,
): boolean {
  return (
    guard?.entryRevision !== undefined &&
    (message.revision ?? 1) !== guard.entryRevision
  );
}

function queuedMessageView(
  message: HostQueuedMessage,
  entry: ChatQueueEntry,
  turnPhase: ChatTurnPhase,
): HostQueuedMessageView {
  const autoResume = readAutoResumeMetadata(message.request.autoResume);
  return {
    id: message.id,
    text: message.request.text,
    supersedesUserMessageId: message.request.userMessageId,
    ...(autoResume ? { autoResume } : {}),
    promptSource:
      autoResume ||
      message.request.watcherFired ||
      message.request.initiationSource === 'hook'
        ? 'automated'
        : 'human',
    ...(message.request.fileReferences
      ? { fileReferences: message.request.fileReferences }
      : {}),
    ...(message.request.attachmentPaths
      ? { attachmentPaths: message.request.attachmentPaths }
      : {}),
    ...(message.request.attachmentPromptContexts
      ? { attachmentPromptContexts: message.request.attachmentPromptContexts }
      : {}),
    ...(message.request.inputMode
      ? { inputMode: message.request.inputMode }
      : {}),
    origin: message.origin,
    enqueuedAtMs: message.enqueuedAtMs,
    revision: message.revision ?? 1,
    turnPhase,
    ...(entry.creditHold
      ? {
          retryable: true,
          ...(!entry.creditHold.funded
            ? { retryBlockedReason: 'insufficient_credits' as const }
            : {}),
        }
      : {}),
    ...(message.editLocked === true ? { editLocked: true } : {}),
    // Nothing behind a worktree setup hold may run before the turn it holds.
    ...(entry.worktreeSetupHold !== undefined
      ? { forceLocked: true as const }
      : {}),
    ...(turnPhase === 'foreground' && isGeneratedInputRequest(message.request)
      ? { waitingReason: 'steer_unavailable' }
      : {}),
    ...(canSteerQueuedMessage(entry, message, turnPhase)
      ? { canSteer: true }
      : {}),
    ...(entry.backgroundWorkHold?.rowId === message.id
      ? {
          waitingReason: 'background_work',
          blockedByBackgroundWork: true,
        }
      : {}),
    ...(steerBlockedByCapabilityChange(entry, message, turnPhase)
      ? { steerBlockedByCapabilityChange: true }
      : {}),
    ...(message.restartHeldChanges
      ? { restartHeldChanges: message.restartHeldChanges }
      : {}),
    ...(message.request.agentSent
      ? { agentSent: message.request.agentSent }
      : {}),
    ...(message.request.watcherFired
      ? { watcherFired: message.request.watcherFired }
      : {}),
  };
}

/** The production dispatch dependency: host dispatch, refusals as outcomes. */
export async function dispatchQueuedChatMessage(
  request: ChatSendMessageRequest,
  origin: ChatQueueOrigin,
  fromQueue: boolean,
  authorization?: AuthorizedChatDispatch,
  options?: ChatQueueDispatchOptions,
): Promise<void | ChatDispatchOutcome> {
  // Keep this local-module import lazy to break the queue-service/chat-service
  // cycle: chat-service submits here, while the queue owns dispatch timing.
  const { dispatchHostQueuedWorktreeChatMessage } =
    await import('./chat-service');
  try {
    await dispatchHostQueuedWorktreeChatMessage(
      request,
      origin,
      fromQueue,
      authorization,
      options,
    );
  } catch (error) {
    // A dispatcher's typed refusal or park is an outcome, not a failure.
    if (error instanceof ChatDispatchOutcomeError) return error.outcome;
    throw error;
  }
}

async function defaultCancel(target: ChatQueueTarget): Promise<void> {
  // Cancellation helpers reconcile back into this queue, so resolve them only
  // when cancellation runs to avoid the initialization cycle.
  const { interruptChatTurnForQueuedMessage } =
    await import('../lib/chat-turn-cancel');
  await interruptChatTurnForQueuedMessage(target);
  // The cancelled turn's terminal event may lag behind cancel() resolving;
  // clear the active-turn marker now so the force-send dispatch that follows
  // does not trip the second-active-turn guard in dispatchWorktreeChatTurn.
  const { clearActiveTurnUserMessageId } =
    await import('../lib/worktree-chat-turn');
  clearActiveTurnUserMessageId(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
}

function defaultBroadcast(event: ChatQueueUpdatedEvent): void {
  // Partial electron test doubles may omit getAllWindows; queue mechanics
  // must not depend on a window being reachable.
  if (typeof BrowserWindow.getAllWindows !== 'function') return;
  for (const window of BrowserWindow.getAllWindows()) {
    sendToWindow(window, IPC_CHANNELS.chatQueueUpdated, event);
  }
  void import('./chat-service').then(({ projectChatQueueSummary }) =>
    projectChatQueueSummary(event),
  );
}

async function defaultPersistRuntime(
  target: ChatQueueTarget,
  queuedMessageIds: readonly string[],
  turnActive: boolean,
  mutation?: ChatQueuePersistenceMutation,
  queuedMessages?: readonly PersistedHostQueuedMessage[],
  activeTurnUserMessageId?: string,
  inFlight?: PersistedHostQueuedMessage,
): Promise<void> {
  // Canonical state dispatches queued commands through this service; keep the
  // reverse dependency local to reconciliation.
  const { getChatStateService } = await import('./chat-state-service');
  await getChatStateService().reconcileHostQueue(
    target,
    queuedMessageIds,
    turnActive,
    mutation,
    queuedMessages,
    activeTurnUserMessageId,
    inFlight,
  );
}

async function defaultHasCommittedMessage(
  target: ChatQueueTarget,
  userMessageId: string,
): Promise<boolean> {
  // Keep the reverse dependency lazy, like persistence reconciliation.
  const { getChatStateService } = await import('./chat-state-service');
  return getChatStateService().hasTranscriptMessage(
    target,
    target.chatId,
    userMessageId,
  );
}

async function defaultIsCanonicalTurnOpen(
  target: ChatQueueTarget,
  turnUserMessageId: string,
): Promise<boolean> {
  // Keep the reverse dependency lazy, like persistence reconciliation.
  const { getChatStateService } = await import('./chat-state-service');
  return getChatStateService().isTurnOpen(
    target,
    target.chatId,
    turnUserMessageId,
  );
}

function isEntryBeingDeleted(entry: ChatQueueEntry): boolean {
  return (
    entry.frozenForDeletion === true || entry.discardedForDeletion === true
  );
}

function defaultSchedule(
  callback: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs);
}

function defaultHasActiveProviderTurn(target: ChatQueueTarget): boolean {
  return getChatSessionLiveness(
    target.projectId,
    target.worktreeId,
    target.chatId,
  ).foreground;
}

function defaultHasBackgroundWork(target: ChatQueueTarget): boolean {
  return (
    getChatSessionLiveness(target.projectId, target.worktreeId, target.chatId)
      .background ||
    chatHasLiveDelegations(target.projectId, target.worktreeId, target.chatId)
  );
}

function defaultHasPendingProviderContinuation(
  target: ChatQueueTarget,
): boolean {
  return hasPendingCodexContinuation(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
}

function defaultHasPendingUserDecision(target: ChatQueueTarget): boolean {
  const sessionKey = buildChatSessionKey(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
  return (
    hasPendingApprovalForSession(sessionKey) ||
    hasPendingRequestForSession(sessionKey)
  );
}

function hasOrdinarySteerFallback(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'fallback' in error &&
    error.fallback === 'ordinary'
  );
}

async function defaultSettleCancelledTurn(
  target: ChatQueueTarget,
  turnUserMessageId?: string,
): Promise<void> {
  // Match the regular Stop IPC's renderer settlement. Codex interruption can
  // resolve before its provider terminal event arrives; forced queue dispatch
  // starts the replacement turn immediately, so that late tagged terminal is
  // then (correctly) ignored as stale. Emit an ordered synthetic terminal now
  // so the superseded turn's timer closes before the replacement prompt opens.
  // chat-service owns dispatch and imports this queue; load it here to break
  // that cycle while preserving ordered cancellation emission.
  const { emitHostQueueForcedCancellation } = await import('./chat-service');
  await emitHostQueueForcedCancellation(target, turnUserMessageId);
}

const DEFAULT_DEPENDENCIES: ChatQueueServiceDependencies = {
  checkWatcherIngress: checkWatcherDeliveryIngress,
  steerGenerated: async (
    request,
    origin,
    queuedIds,
    allowSteering,
    canSteerNow,
    claimed,
  ) => {
    // Chat-state owns this queue. Keep the reverse dependency lazy, as in
    // explicit queued-message steering, to avoid an initialization cycle.
    const { getChatStateService } = await import('./chat-state-service');
    return getChatStateService().inputDelivery.steerGenerated(
      request,
      queuedIds,
      origin,
      allowSteering,
      canSteerNow,
      claimed,
    );
  },
  steerQueuedGenerated: async (
    request,
    origin,
    queuedIds,
    canSteerNow,
    claimed,
  ) => {
    // Chat-state owns the queue. Keep the reverse dependency lazy to avoid an
    // initialization cycle while the durable input-delivery claim is made.
    const { getChatStateService } = await import('./chat-state-service');
    return getChatStateService().inputDelivery.steerQueuedGenerated(
      request,
      queuedIds,
      origin,
      canSteerNow,
      claimed,
    );
  },
  readCreditFunding: async (target): Promise<boolean> => {
    const [{ getAiCreditsRoutingContext }, { resolveAiCreditsScopeOwner }] =
      await Promise.all([
        import('../agents/ai-credits-routing'),
        import('../agents/work-owner'),
      ]);
    const owner = await resolveAiCreditsScopeOwner({ kind: 'work', ...target });
    if (!owner) return false;
    const context = await getAiCreditsRoutingContext({
      owner,
      forceRefresh: true,
    });
    const currentOwner = await resolveAiCreditsScopeOwner({
      kind: 'work',
      ...target,
    });
    return (
      JSON.stringify(owner) === JSON.stringify(currentOwner) &&
      context?.creditsEligibilityKnown === true &&
      context.creditsEligible
    );
  },
  dispatch: dispatchQueuedChatMessage satisfies ChatTurnExecutionSeam,
  beginTurnPreparation: beginChatTurnPreparation,
  cancel: defaultCancel,
  settleCancelledTurn: defaultSettleCancelledTurn,
  hasActiveProviderTurn: defaultHasActiveProviderTurn,
  getActiveProviderPluginSelections: (target) =>
    getSessionPluginSelections(
      target.projectId,
      target.worktreeId,
      target.chatId,
    ),
  getActiveProviderPluginDefaultsRevision: (target) =>
    getSessionGlobalPluginDefaultsRevision(
      target.projectId,
      target.worktreeId,
      target.chatId,
    ),
  getCurrentPluginDefaultsRevision: (target) =>
    chatSurfaceUsesGlobalPluginDefaults(target.projectId)
      ? getInheritedPluginDefaultsRevision(target)
      : undefined,
  drainProviderEvents: async (target): Promise<void> => {
    // Lazy by design: the event router feeds lifecycle state back into this
    // queue. Deferring the reverse edge breaks that initialization cycle; the
    // packaged Electron main build exercises this local import path.
    const { drainCurrentSessionEvents } =
      await import('../agents/session-event-router');
    await drainCurrentSessionEvents(target);
  },
  endDiscardedTurns: async (target, requests): Promise<void> => {
    const { getChatStateService } = await import('./chat-state-service');
    getChatStateService().endDiscardedQueuedTurns(target, requests);
  },
  hasPendingProviderContinuation: defaultHasPendingProviderContinuation,
  hasBackgroundWork: defaultHasBackgroundWork,
  hasNativeBackgroundWork: (target) =>
    chatHasNativeBackgroundWork(
      target.projectId,
      target.worktreeId,
      target.chatId,
    ),
  decideTurnSessionReuse: (request) =>
    turnSessionReuse.decideTurnSessionReuse(request),
  holdsForBackgroundWork: (target, decision) =>
    turnSessionReuse.holdsForBackgroundWork(target, decision),
  readPersistedTabOptions: readExistingTabComposerOptions,
  hasPendingUserDecision: defaultHasPendingUserDecision,
  persistRuntime: defaultPersistRuntime,
  hasCommittedMessage: defaultHasCommittedMessage,
  isCanonicalTurnOpen: defaultIsCanonicalTurnOpen,
  broadcast: defaultBroadcast,
  createId: randomUUID,
  now: Date.now,
  schedule: defaultSchedule,
};

export class ChatQueueService {
  private readonly entries = new Map<string, ChatQueueEntry>();
  /** Normal leases are valid only for the exact entry that issued them. */
  private readonly revivalLeaseEntries = new WeakMap<
    ChatQueueRevivalLease,
    ChatQueueEntry
  >();
  /** An accepted revival that had no entry yet, and can confirm one later. */
  private readonly pendingInertRevivalLeases = new Map<
    string,
    ChatQueueRevivalLease
  >();
  private readonly inertRevivalLeaseEvidence = new WeakMap<
    ChatQueueRevivalLease,
    InertRevivalLeaseEvidence
  >();
  private readonly committedMessageFallbackRetries = new Map<string, number>();
  private readonly editLockAttempts = new WeakMap<HostQueuedMessage, symbol>();
  private readonly editLockOwners = new WeakMap<HostQueuedMessage, string>();
  private readonly editLockSaves = new WeakMap<
    HostQueuedMessage,
    Promise<void>
  >();
  private readonly activeInputHydrations = new Map<string, number>();
  private readonly generatedSubmissions = new Map<string, Promise<void>>();
  private readonly inputRestorations = new Map<string, Promise<void>>();
  private readonly restartHoldRefreshes = new Map<
    string,
    RestartHoldRefreshState
  >();
  private readonly ownershipHydrations = new Set<string>();
  private ownershipSubscription?: {
    readonly source: ChatQueueOwnershipPort;
    readonly dispose: () => void;
  };
  private startupDrainHeld = false;

  public constructor(
    private readonly dependencies: ChatQueueServiceDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  /** Queue an eligibility reread on the next turn of the configured scheduler. */
  public notifySteeringEligibility(sessionKey: string): void {
    const entry = this.entries.get(sessionKey);
    if (!entry) return;
    this.markSteeringEligibility(entry);
  }

  private hasNativeBackgroundWork(target: ChatQueueTarget): boolean {
    try {
      return this.dependencies.hasNativeBackgroundWork?.(target) ?? false;
    } catch {
      return false;
    }
  }

  private clearBackgroundWorkHold(
    entry: ChatQueueEntry,
    rowId?: string,
  ): boolean {
    if (
      entry.backgroundWorkHold === undefined ||
      (rowId !== undefined && entry.backgroundWorkHold.rowId !== rowId)
    ) {
      return false;
    }
    delete entry.backgroundWorkHold;
    this.clearDrainDecline(entry, 'background-work');
    return true;
  }

  private isBackgroundWorkHoldActive(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): boolean {
    const hold = entry.backgroundWorkHold;
    if (!hold) return false;
    if (!entry.queue.some((message) => message.id === hold.rowId)) {
      this.clearBackgroundWorkHold(entry, hold.rowId);
      return false;
    }
    if (this.hasNativeBackgroundWork(target)) return true;
    if (this.clearBackgroundWorkHold(entry, hold.rowId))
      this.broadcastBestEffort(target, entry, false);
    return false;
  }

  private markBackgroundWorkHold(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    rowId: string,
  ): boolean {
    if (
      !this.hasNativeBackgroundWork(target) ||
      !entry.queue.some((message) => message.id === rowId)
    ) {
      return false;
    }
    entry.backgroundWorkHold = { rowId };
    delete entry.externalRetryParked;
    if (entry.drainTimer !== undefined) {
      clearTimeout(entry.drainTimer);
      delete entry.drainTimer;
    }
    delete entry.drainTimerDueAtMs;
    this.broadcastBestEffort(target, entry, false);
    return true;
  }

  private markSteeringEligibility(entry: ChatQueueEntry): void {
    entry.steeringEligibilityRevision =
      (entry.steeringEligibilityRevision ?? 0) + 1;
    entry.steeringPending = true;
    this.schedulePendingGeneratedSteering(entry);
  }

  private schedulePendingGeneratedSteering(entry: ChatQueueEntry): void {
    if (
      entry.creditHold !== undefined ||
      entry.steeringPending !== true ||
      !entry.queue.some(
        (message) =>
          message.ordinaryOnly !== true &&
          isGeneratedInputRequest(message.request),
      ) ||
      entry.steeringTimer ||
      entry.recoveryOwner ||
      entry.recoveryInFlight === true ||
      entry.dispatchInFlight === true ||
      entry.reservation !== undefined ||
      entry.steeringInFlight === true ||
      (entry.pendingQueuePersistenceCount ?? 0) > 0 ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true ||
      entry.authenticationPause !== undefined ||
      !this.dependencies.steerQueuedGenerated ||
      this.entries.get(chatQueueKey(entry.target)) !== entry
    ) {
      return;
    }
    entry.steeringTimer = this.dependencies.schedule(() => {
      delete entry.steeringTimer;
      void this.steerNextQueuedGenerated(entry).catch((error: unknown) => {
        logMainProcessWarn(
          '[chat-queue] Automatic watcher steering did not complete:',
          error,
        );
      });
    }, 0);
  }

  /** Queued watcher rows the provider has not refused since eligibility last changed. */
  private untriedQueuedGenerated(entry: ChatQueueEntry): HostQueuedMessage[] {
    const revision = entry.steeringEligibilityRevision ?? 0;
    const untried = entry.queue.filter((candidate) => {
      if (
        candidate.ordinaryOnly === true ||
        candidate.watcherDeliveryHeld !== undefined ||
        !isGeneratedInputRequest(candidate.request)
      )
        return false;
      const refusedAt = entry.steeringRefusalRevisions?.get(candidate.id);
      return refusedAt === undefined || revision > refusedAt;
    });
    const internalRows = entry.queue.filter((candidate) =>
      isInternalChatRequest(candidate.request),
    );
    if (internalRows.length === 0) return untried;

    // Generated visible rows retain their established watcher/automation
    // behavior. A visible row of any kind otherwise outranks hidden work.
    const visibleGenerated = untried.filter(
      (candidate) => !isInternalChatRequest(candidate.request),
    );
    if (visibleGenerated.length > 0) return visibleGenerated;
    if (
      entry.queue.some((candidate) => !isInternalChatRequest(candidate.request))
    )
      return [];

    // Only the oldest internal row may be automatically steered. A refusal,
    // settings mismatch, or missing capability holds every later delegation.
    const firstInternal = internalRows[0];
    return firstInternal && untried.includes(firstInternal)
      ? [firstInternal]
      : [];
  }

  private async steerNextQueuedGenerated(entry: ChatQueueEntry): Promise<void> {
    if (
      entry.steeringPending !== true ||
      entry.steeringInFlight === true ||
      entry.recoveryOwner ||
      this.entries.get(chatQueueKey(entry.target)) !== entry
    ) {
      return;
    }
    const untried = this.untriedQueuedGenerated(entry);
    if (untried.length === 0) {
      entry.steeringPending = false;
      return;
    }
    // A row the user is editing, or whose settings no longer match the running
    // session, does not hold the rows behind it.
    const message = untried.find((candidate) =>
      this.canStartQueuedGeneratedSteering(entry, candidate),
    );
    if (!message) return;

    const target = entry.target;
    const eligibilityRevision = entry.steeringEligibilityRevision ?? 0;
    const operationEpoch = entry.operationEpoch ?? 0;
    const originalIndex = entry.queue.indexOf(message);
    // The provider is handed the request the row holds now. A change to the
    // row while the attempt runs fails the guard, so a stale request is never
    // claimed in place of the row.
    const steeredRequest = message.request;
    const owner = Symbol('chat-queue-generated-steering');
    entry.recoveryOwner = owner;
    entry.recoveryInFlight = true;
    const wait = this.beginRecoveryWait(
      entry,
      'chat_queue.steer_queued_generated',
      owner,
    );
    entry.steeringInFlight = true;
    entry.steeringRowId = message.id;
    entry.steeringPending = false;
    let claimed = false;
    const canSteerNow = (): boolean =>
      this.canSteerQueuedGeneratedNow(
        target,
        entry,
        message,
        steeredRequest,
        owner,
        operationEpoch,
        claimed,
      );
    const queuedIds = (): string[] =>
      entry.queue
        .filter((candidate) => candidate.id !== message.id)
        .map((candidate) => candidate.id);
    const removeQueuedRow = (): boolean => {
      const index = entry.queue.findIndex(
        (candidate) => candidate.id === message.id,
      );
      if (index < 0) return false;
      entry.queue.splice(index, 1);
      entry.persistedInputIds.add(message.id);
      return true;
    };
    const onClaimed = (): void => {
      if (claimed) return;
      claimed = true;
      entry.claimedQueueRowIds ??= new Set<string>();
      entry.claimedQueueRowIds.add(message.id);
      if (!removeQueuedRow()) return;
      // The durable claim wrote this queue without the candidate. Write it
      // again from the live queue: a queue write computed before the claim
      // and applied after it would otherwise bring the claimed row back for
      // a reload to resend.
      this.broadcastBestEffort(target, entry);
    };
    const refuseUntilEligibilityChanges = (): void => {
      entry.steeringRefusalRevisions ??= new Map<string, number>();
      entry.steeringRefusalRevisions.set(message.id, eligibilityRevision);
    };

    let result: GeneratedSteeringResult | undefined;
    try {
      wait.phase('steer_generated');
      result = await this.dependencies.steerQueuedGenerated?.(
        steeredRequest,
        message.origin,
        queuedIds,
        canSteerNow,
        onClaimed,
      );
      if (result?.status === 'handled') {
        this.releaseWatcherAuthority(steeredRequest);
        // A durable, already-owned delivery can be reported as handled without
        // a new claim callback. Retire its stale host projection only after
        // that result arrives, never before coordinator settlement.
        if (!claimed && removeQueuedRow()) {
          wait.phase('queue_persistence');
          const persistence = this.broadcast(target, entry);
          if (persistence) await persistence;
        }
      } else {
        refuseUntilEligibilityChanges();
        if (claimed && result?.status === 'requeue') {
          wait.phase('restore_refused_generated');
          await this.restoreRefusedGenerated(
            target,
            entry,
            message,
            originalIndex,
            result.rowId,
            result.epoch,
            result.continuation,
            owner,
            result.watcherDeliveryHeld,
          );
        }
      }
    } catch (error) {
      if (claimed) {
        // Settlement after a durable claim is ambiguous: provider I/O may
        // already have accepted this delivery. A rejected restore ends here
        // too. Either way delivery keeps the input, and it is never turned
        // back into resendable queue input.
        logMainProcessWarn(
          '[chat-queue] Watcher delivery settlement failed after its durable claim; retaining delivery ownership:',
          error,
        );
      } else {
        // Nothing was claimed, so the row is still queued. Leave it until
        // eligibility changes instead of trying it again in this pass.
        refuseUntilEligibilityChanges();
        throw error;
      }
    } finally {
      if (entry.recoveryOwner === owner) {
        delete entry.recoveryOwner;
        entry.recoveryInFlight = false;
      }
      this.finishRecoveryWait(entry, wait);
      entry.steeringInFlight = false;
      delete entry.steeringRowId;
      if (this.entries.get(chatQueueKey(target)) === entry) {
        if (this.getTurnPhase(target, entry) !== 'foreground')
          this.scheduleDrain(target, entry, 0);
        // One trigger covers every queued watcher row: go on to the rows this
        // pass has not tried yet.
        if (this.untriedQueuedGenerated(entry).length > 0)
          entry.steeringPending = true;
        this.schedulePendingGeneratedSteering(entry);
      }
    }
  }

  private canStartQueuedGeneratedSteering(
    entry: ChatQueueEntry,
    message: HostQueuedMessage,
  ): boolean {
    const target = entry.target;
    return (
      this.entries.get(chatQueueKey(target)) === entry &&
      entry.queue.includes(message) &&
      entry.creditHold === undefined &&
      message.ordinaryOnly !== true &&
      message.watcherDeliveryHeld === undefined &&
      message.requiredAccountProxyConnectionId === undefined &&
      isGeneratedInputRequest(message.request) &&
      !message.editLocked &&
      entry.dispatchInFlight !== true &&
      entry.recoveryInFlight !== true &&
      entry.reservation === undefined &&
      (entry.pendingQueuePersistenceCount ?? 0) === 0 &&
      entry.frozenForDeletion !== true &&
      entry.discardedForDeletion !== true &&
      entry.authenticationPause === undefined &&
      this.getTurnPhase(target, entry) === 'foreground' &&
      // An overflow row waits for the next turn instead of retrying this one.
      !isCurrentTurnBindingFull(target) &&
      !steerBlockedByCapabilityChange(
        entry,
        message,
        this.getTurnPhase(target, entry),
      )
    );
  }

  private canSteerQueuedGeneratedNow(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    message: HostQueuedMessage,
    steeredRequest: ChatSendMessageRequest,
    owner: symbol,
    operationEpoch: number,
    claimed: boolean,
  ): boolean {
    const queued = entry.queue.find((candidate) => candidate.id === message.id);
    // Before the claim the row is still queued and still holds the request the
    // provider is being handed. After it the queue no longer holds the row.
    const rowStateMatches = claimed
      ? queued === undefined
      : queued === message && message.request === steeredRequest;
    return (
      this.entries.get(chatQueueKey(target)) === entry &&
      entry.recoveryOwner === owner &&
      entry.recoveryInFlight === true &&
      entry.steeringInFlight === true &&
      entry.reservation === undefined &&
      (entry.operationEpoch ?? 0) === operationEpoch &&
      rowStateMatches &&
      // Until its claim commits, an internal row yields to any visible row
      // or older internal row that is now ahead of it.
      (claimed ||
        !isInternalChatRequest(message.request) ||
        entry.queue[0] === message) &&
      message.ordinaryOnly !== true &&
      message.watcherDeliveryHeld === undefined &&
      isGeneratedInputRequest(message.request) &&
      !message.editLocked &&
      entry.dispatchInFlight !== true &&
      (claimed || (entry.pendingQueuePersistenceCount ?? 0) === 0) &&
      entry.frozenForDeletion !== true &&
      entry.discardedForDeletion !== true &&
      entry.authenticationPause === undefined &&
      this.getTurnPhase(target, entry) === 'foreground' &&
      !steerBlockedByCapabilityChange(
        entry,
        message,
        this.getTurnPhase(target, entry),
      )
    );
  }

  /**
   * Put a watcher row back in the queue after the provider proved it refused
   * the delivery. The delivery ledger decides whether the input may be queued
   * again: it rejects this write once Stop or Interrupt has superseded the
   * delivery, and then the row is taken back out.
   */
  private async restoreRefusedGenerated(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    message: HostQueuedMessage,
    index: number,
    ledgerRowId: string,
    ledgerEpoch: number,
    continuation: { attemptId: string; epoch: number } | undefined,
    owner: symbol,
    watcherDeliveryHeld?: ChatWatcherHeldOutcome,
  ): Promise<void> {
    if (
      this.entries.get(chatQueueKey(target)) !== entry ||
      entry.recoveryOwner !== owner ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true ||
      entry.queue.some((candidate) => candidate.id === message.id)
    ) {
      return;
    }
    if (watcherDeliveryHeld) {
      delete message.ordinaryOnly;
      message.watcherDeliveryHeld = watcherDeliveryHeld;
    } else message.ordinaryOnly = true;
    this.insertQueuedMessage(entry, message, index);
    try {
      const persistence = this.broadcast(target, entry, {
        type: 'restore-input',
        request: message.request,
        rowId: ledgerRowId,
        epoch: ledgerEpoch,
        ...(watcherDeliveryHeld ? {} : { ordinaryOnly: true }),
        ...(continuation ? { continuation } : {}),
      });
      if (persistence) await persistence;
    } catch (error) {
      const restoredIndex = entry.queue.findIndex(
        (candidate) => candidate.id === message.id,
      );
      if (restoredIndex >= 0) entry.queue.splice(restoredIndex, 1);
      this.broadcastBestEffort(target, entry);
      throw error;
    }
    entry.persistedInputIds.add(message.id);
    if (watcherDeliveryHeld) {
      // Restore the ledger claim with its epoch/attempt fence before splitting;
      // a failed or superseded restore must never publish innocent parts.
      this.splitHeldWatcherRow(message, entry);
      await this.persistRestoredQueueUntilDurable(target, entry);
      this.armHeldWatcherRetry(target, entry);
      this.markSteeringEligibility(entry);
    }
  }

  /**
   * `ownTurnUserMessageId` names the turn the calling operation armed the
   * host gate for, so its own gate does not read as another turn's.
   */
  private readTurnActivity(
    target: ChatQueueTarget,
    entry?: ChatQueueEntry,
    operationOwner?: symbol,
    ownTurnUserMessageId?: string,
    unknownBlocks = true,
  ): ReturnType<typeof readChatTurnPhase> {
    const canonical = this.readCanonicalOwnership(target, operationOwner);
    const activity = readChatTurnPhase(
      {
        hasActiveProviderTurn:
          canonical?.providerForeground ??
          this.dependencies.hasActiveProviderTurn(target),
        hasPendingProviderContinuation:
          canonical === undefined &&
          this.dependencies.hasPendingProviderContinuation(target),
        hasBackgroundWork:
          this.dependencies.hasBackgroundWork?.(target) ?? false,
        hostGateArmed:
          entry?.turnActive === true &&
          (ownTurnUserMessageId === undefined ||
            entry.activeTurnUserMessageId !== ownTurnUserMessageId),
        ...(entry?.reservation ? { reservation: entry.reservation } : {}),
      },
      operationOwner,
    );
    // Another D/S owner or unknown ownership closes admission, but it is not
    // provider work: it must never adopt the host gate.
    return canonical !== undefined &&
      (canonical.hostOwned || (canonical.waiting && unknownBlocks)) &&
      activity.turnPhase !== 'foreground'
      ? {
          turnPhase: 'foreground',
          hasForegroundProviderWork: activity.hasForegroundProviderWork,
        }
      : activity;
  }

  private get ownership(): ChatQueueOwnershipPort | undefined {
    return this.dependencies.ownership;
  }

  /**
   * What canonical ownership says about admission. Provider foreground is
   * receipt or committed `current` or unacknowledged lifecycle; host owners
   * are other D/S owners; unknown or loading knowledge waits and starts a read.
   * shortcut: with no state service bound there is no canonical state, so the
   * provider inputs decide (undefined); production always binds one.
   */
  private readCanonicalOwnership(
    target: ChatQueueTarget,
    callerToken: symbol | undefined,
  ):
    | { providerForeground: boolean; hostOwned: boolean; waiting: boolean }
    | undefined {
    const ownership = this.ownership;
    if (!ownership?.isBound()) return undefined;
    this.subscribeToOwnership(ownership);
    const scope = chatTurnScope(target);
    const verdict = evaluateTurnAdmission({
      ...ownership.getSnapshot(scope),
      ...(callerToken ? { callerToken } : {}),
    });
    if (verdict.kind === 'wait') {
      this.requestOwnershipHydration(scope);
      return { providerForeground: false, hostOwned: false, waiting: true };
    }
    const blockers = verdict.kind === 'blocked' ? verdict.blockers : [];
    return {
      providerForeground: blockers.some(
        (blocker) => blocker.kind !== 'dispatch' && blocker.kind !== 'stop',
      ),
      hostOwned: blockers.some(
        (blocker) => blocker.kind === 'dispatch' || blocker.kind === 'stop',
      ),
      waiting: false,
    };
  }

  /**
   * Follow canonical settlement: release a gate adopted from canonical
   * provider evidence once that evidence settles, and re-drain as soon as
   * ownership admits a queued row.
   */
  private subscribeToOwnership(ownership: ChatQueueOwnershipPort): void {
    if (this.ownershipSubscription?.source === ownership) return;
    this.ownershipSubscription?.dispose();
    const dispose = ownership.subscribe((snapshot) => {
      const entry = this.entries.get(chatQueueKey(snapshot.scope));
      if (!entry) return;
      const verdict = evaluateTurnAdmission(snapshot);
      const providerSettled =
        verdict.kind === 'allow' ||
        (verdict.kind === 'blocked' &&
          verdict.blockers.every(
            (blocker) => blocker.kind === 'dispatch' || blocker.kind === 'stop',
          ));
      if (
        providerSettled &&
        entry.turnActive &&
        entry.queueGateSource === 'adopted-provider-activity' &&
        entry.activeTurnUserMessageId === undefined
      ) {
        this.releaseTurnGate(entry);
        this.broadcastBestEffort(entry.target, entry);
      }
      if (entry.queue.length > 0 && verdict.kind === 'allow')
        this.scheduleDrain(entry.target, entry, 0);
    });
    this.ownershipSubscription = { source: ownership, dispose };
  }

  private requestOwnershipHydration(scope: ChatQueueTarget): void {
    const ownership = this.ownership;
    const key = chatQueueKey(scope);
    if (!ownership || this.ownershipHydrations.has(key)) return;
    this.ownershipHydrations.add(key);
    void ownership
      .hydrate(scope)
      .catch(() => {
        // A failed read stays unknown, so admission stays closed; retry.
        const entry = this.entries.get(key);
        if (entry && entry.queue.length > 0)
          this.scheduleDrain(entry.target, entry, OWNERSHIP_HYDRATION_RETRY_MS);
      })
      .finally(() => {
        this.ownershipHydrations.delete(key);
      });
  }

  /** Whether an admission must first learn this chat's canonical ownership. */
  private needsOwnershipHydration(target: ChatQueueTarget): boolean {
    const ownership = this.ownership;
    return (
      ownership?.isBound() === true &&
      ownership.getSnapshot(chatTurnScope(target)).knowledge !== 'known'
    );
  }

  /** Learn canonical ownership before an admission decision; never throws. */
  private async hydrateOwnership(target: ChatQueueTarget): Promise<void> {
    try {
      await this.ownership?.hydrate(chatTurnScope(target));
    } catch {
      // Unknown knowledge keeps admission closed at the next read.
    }
  }

  /**
   * Ordinary admission for a host dispatch with no queue row (a direct
   * launcher, Resume, the standalone direct path; contracts §6): install its
   * D and issue its capability, or return undefined while admission is
   * blocked. The caller hands the capability to the final dispatcher and
   * releases D when that dispatch does not start; its terminal releases it too.
   */
  public async admitDirectDispatch(
    target: ChatQueueTarget,
    userMessageId: string,
    holderId?: string,
  ): Promise<ChatDirectDispatchAdmission | undefined> {
    if (this.needsOwnershipHydration(target))
      await this.hydrateOwnership(target);
    const ownership = this.ownership;
    const entry = this.getOrCreateEntry(target);
    // Only the continuation a hold was taken for passes it, so it does not
    // queue behind its own hold; every other dispatch stays blocked by it.
    const hold =
      holderId !== undefined && entry.directDispatchHold?.holderId === holderId
        ? entry.directDispatchHold
        : undefined;
    if (
      ownership?.isBound() &&
      evaluateTurnAdmission({
        ...ownership.getSnapshot(chatTurnScope(target)),
        ...(hold ? { callerToken: hold.token } : {}),
      }).kind !== 'allow'
    )
      return undefined;
    if (hold) this.releaseDirectDispatchHold(target, hold.holderId);
    const token = Symbol('chat-queue-direct-dispatch');
    const authorization = this.registerDispatchOwner(
      target,
      entry,
      token,
      userMessageId,
    );
    let released = false;
    return {
      authorization,
      release: (): void => {
        if (released) return;
        released = true;
        if (authorization)
          (
            this.dependencies.authorization ?? getChatDispatchAuthorization()
          ).revoke(authorization);
        this.removeDispatchOwners(target, entry, { token });
      },
    };
  }

  /**
   * Admission for a continuation whose predecessor may still be settling (its
   * end commits after the reload asks to continue): wait for canonical
   * ownership to admit it, or return undefined once `signal` aborts.
   */
  public async admitDirectDispatchWhenAllowed(
    target: ChatQueueTarget,
    userMessageId: string,
    signal: AbortSignal,
    holderId?: string,
  ): Promise<ChatDirectDispatchAdmission | undefined> {
    const key = chatQueueKey(target);
    while (!signal.aborted) {
      let stopWaiting: (() => void) | undefined;
      // Subscribe before checking, so a change between the two still wakes.
      const changed = new Promise<void>((resolve) => {
        const dispose = this.ownership?.subscribe((snapshot) => {
          if (chatQueueKey(snapshot.scope) === key) resolve();
        });
        const onAbort = (): void => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
        stopWaiting = (): void => {
          dispose?.();
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
      });
      try {
        const admission = await this.admitDirectDispatch(
          target,
          userMessageId,
          holderId,
        );
        if (admission) {
          if (signal.aborted) {
            admission.release();
            return undefined;
          }
          return admission;
        }
        // A failed ownership read already resolved `changed`; retry it on a
        // delay rather than at once.
        if (this.needsOwnershipHydration(target))
          await this.delayUnlessAborted(OWNERSHIP_HYDRATION_RETRY_MS, signal);
        else await changed;
      } finally {
        stopWaiting?.();
      }
    }
    return undefined;
  }

  /** {@link runAdmittedDirectDispatch} for this queue. */
  public async runDirectDispatch(
    target: ChatQueueTarget,
    userMessageId: string,
    run: (
      authorization: AuthorizedChatDispatch | undefined,
    ) => Promise<boolean>,
  ): Promise<void> {
    const admission = await this.admitDirectDispatch(target, userMessageId);
    if (!admission) throw new Error('Another turn owns this chat.');
    let started = false;
    try {
      started = await run(admission.authorization);
    } finally {
      if (!started) admission.release();
    }
  }

  /**
   * Hold admission for a continuation its holder admits later (a
   * deferred-tools reload, from its interruption): a D with no message, so
   * the predecessor's end cannot admit another send first. Idempotent.
   */
  public holdDirectDispatch(target: ChatQueueTarget, holderId: string): void {
    const entry = this.getOrCreateEntry(target);
    const held = entry.directDispatchHold;
    // An untagged Stop releases every D, this hold included.
    if (
      held?.holderId === holderId &&
      entry.dispatchOwners?.some((owner) => owner.token === held.token)
    )
      return;
    if (held) this.releaseDirectDispatchHold(target, held.holderId);
    const token = Symbol('chat-queue-direct-dispatch-hold');
    entry.directDispatchHold = { token, holderId };
    this.registerDispatchOwner(target, entry, token, undefined);
  }

  public releaseDirectDispatchHold(
    target: ChatQueueTarget,
    holderId: string,
  ): void {
    const entry = this.entries.get(chatQueueKey(target));
    const hold = entry?.directDispatchHold;
    if (!entry || hold?.holderId !== holderId) return;
    delete entry.directDispatchHold;
    this.removeDispatchOwners(target, entry, { token: hold.token });
  }

  private delayUnlessAborted(
    delayMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const onAbort = (): void => resolve();
      signal.addEventListener('abort', onAbort, { once: true });
      this.dependencies.schedule(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
    });
  }

  /**
   * Publish an acquired dispatch as a canonical D owner (which also holds
   * wake) and issue its dispatch capability.
   */
  private registerDispatchOwner(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    token: symbol,
    userMessageId: string | undefined,
  ): AuthorizedChatDispatch | undefined {
    const ownership = this.ownership;
    if (!ownership?.isBound()) return undefined;
    const scope = chatTurnScope(target);
    const record = ownership.registerDispatchOwner(scope, {
      token,
      ...(userMessageId ? { userMessageId } : {}),
    });
    entry.dispatchOwners = [
      ...(entry.dispatchOwners ?? []),
      {
        token,
        operationEpoch: record.operationEpoch,
        ...(userMessageId ? { userMessageId } : {}),
      },
    ];
    if (!userMessageId) return undefined;
    return (
      this.dependencies.authorization ?? getChatDispatchAuthorization()
    ).issue(scope, { ...record, kind: 'dispatch', userMessageId });
  }

  /**
   * Apply a dispatcher's explicit outcome. Acceptance keeps D for its start;
   * a refusal (already committed by the dispatcher) or a hand-back retires it.
   * Returns false when D must be released; rethrows an undispatched failure.
   */
  private async applyDispatchOutcome(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    dispatchOwner: symbol,
    outcome: ChatDispatchOutcome,
    authorization: AuthorizedChatDispatch | undefined,
    handBack: () => Promise<void>,
  ): Promise<boolean> {
    const owner = entry.dispatchOwners?.find(
      (candidate) => candidate.token === dispatchOwner,
    );
    const action = getChatDispatchOutcomeAction(
      outcome,
      owner && { token: owner.token, operationEpoch: owner.operationEpoch },
    );
    if (action.kind === 'ignore-stale') return true;
    if (action.kind !== 'retain-accepted-start' && authorization)
      (
        this.dependencies.authorization ?? getChatDispatchAuthorization()
      ).revoke(authorization);
    switch (action.kind) {
      case 'retain-accepted-start':
      case 'retain-for-reconciliation':
      case 'settle-captured-turn':
        return true;
      case 'recover-undispatched':
        throw action.error;
      case 'durable-hand-back':
        // FIFO hand-back: the row returns first, durably, before D releases.
        this.releaseTurnGate(entry);
        await handBack();
        return false;
      case 'retire-after-refusal-commit':
        this.releaseTurnGate(entry);
        this.broadcastBestEffort(target, entry);
        return false;
    }
  }

  /** Release D owners: one token, one root's, or (untagged) every one. */
  private removeDispatchOwners(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    match: { token: symbol } | { userMessageId?: string },
  ): void {
    const owners = entry.dispatchOwners;
    if (!owners?.length) return;
    const released = owners.filter((owner) =>
      'token' in match
        ? owner.token === match.token
        : match.userMessageId === undefined ||
          owner.userMessageId === match.userMessageId,
    );
    if (released.length === 0) return;
    entry.dispatchOwners = owners.filter((owner) => !released.includes(owner));
    const scope = chatTurnScope(target);
    for (const owner of released)
      this.ownership?.removeDispatchOwner(
        scope,
        owner.token,
        owner.operationEpoch,
      );
  }

  private getTurnPhase(
    target: ChatQueueTarget,
    entry?: ChatQueueEntry,
    operationOwner?: symbol,
  ): ChatTurnPhase {
    return this.readTurnActivity(target, entry, operationOwner).turnPhase;
  }

  private armTurnGate(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    source: QueueGateSource,
    turnUserMessageId?: string,
    options: {
      preserveRevivalLease?: boolean;
      advanceOperationEpoch?: boolean;
    } = {},
  ): void {
    const pendingInertLease = this.pendingInertRevivalLeases.get(
      chatQueueKey(target),
    );
    // Adopting provider activity without a root is not a new owner; only a
    // gate armed for a different root supersedes a pending inert lease.
    if (
      pendingInertLease &&
      turnUserMessageId !== undefined &&
      pendingInertLease.rootId !== turnUserMessageId
    ) {
      this.pendingInertRevivalLeases.delete(chatQueueKey(target));
    }
    if (options.preserveRevivalLease !== true) {
      // A regular queue operation that changes the gate supersedes a revival
      // lease. Advance the existing operation epoch only when there was a
      // revival owner to invalidate, so unrelated recovery/steering captures
      // keep their established epoch behavior.
      if (
        options.advanceOperationEpoch ??
        entry.revivalLeaseRootId !== undefined
      ) {
        entry.operationEpoch = (entry.operationEpoch ?? 0) + 1;
      }
      delete entry.revivalLeaseRootId;
      delete entry.revivalTerminalReleaseRootId;
    }
    entry.turnActive = true;
    if (turnUserMessageId === undefined) {
      delete entry.activeTurnUserMessageId;
    } else {
      entry.activeTurnUserMessageId = turnUserMessageId;
    }
    entry.queueGateSource = source;
    // While bound, provider activity comes only from canonical ownership.
    if (source === 'adopted-provider-activity' && this.ownership?.isBound())
      entry.gateFromCanonical = true;
    else delete entry.gateFromCanonical;
    entry.queueGateArmedAtMs = this.dependencies.now();
    // A new arm supersedes any async check captured for the previous gate.
    delete entry.gateReconcileOwner;
    this.scheduleStaleGateReconciliation(
      target,
      entry,
      QUEUE_GATE_STALE_RECONCILE_MS,
    );
  }

  private clearGateReconciliationTimer(entry: ChatQueueEntry): void {
    if (entry.gateReconcileTimer !== undefined) {
      clearTimeout(entry.gateReconcileTimer);
      delete entry.gateReconcileTimer;
    }
    delete entry.gateReconcileTimerOwner;
  }

  private releaseTurnGate(
    entry: ChatQueueEntry,
    terminalRootId?: string,
  ): void {
    const key = chatQueueKey(entry.target);
    const pendingInertLease = this.pendingInertRevivalLeases.get(key);
    // An inert lease is superseded only when its own root's gate is released
    // by something other than that root's terminal (an untagged Stop, say).
    if (
      pendingInertLease &&
      entry.activeTurnUserMessageId === pendingInertLease.rootId &&
      terminalRootId !== pendingInertLease.rootId
    ) {
      this.pendingInertRevivalLeases.delete(key);
    }
    const releasedByOwnTerminal =
      terminalRootId !== undefined &&
      entry.revivalLeaseRootId === terminalRootId &&
      (entry.activeTurnUserMessageId === terminalRootId ||
        entry.revivalTerminalReleaseRootId === terminalRootId);
    if (releasedByOwnTerminal) {
      entry.revivalTerminalReleaseRootId = terminalRootId;
    } else {
      // Only an accepted revival owns this lease epoch. Normal terminal and
      // recovery releases do not perturb unrelated operation captures.
      if (entry.revivalLeaseRootId !== undefined) {
        entry.operationEpoch = (entry.operationEpoch ?? 0) + 1;
      }
      delete entry.revivalLeaseRootId;
      delete entry.revivalTerminalReleaseRootId;
    }
    entry.turnActive = false;
    delete entry.activeTurnUserMessageId;
    delete entry.gateFromCanonical;
    delete entry.queueGateSource;
    delete entry.queueGateArmedAtMs;
    delete entry.gateReconcileOwner;
    this.clearGateReconciliationTimer(entry);
  }

  private scheduleStaleGateReconciliation(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    delayMs: number,
  ): void {
    if (
      !entry.turnActive ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true ||
      this.entries.get(chatQueueKey(target)) !== entry
    ) {
      this.clearGateReconciliationTimer(entry);
      return;
    }
    this.clearGateReconciliationTimer(entry);
    const timerOwner = Symbol('chat-queue-stale-gate-timer');
    entry.gateReconcileTimerOwner = timerOwner;
    const timer = this.dependencies.schedule(
      (): void => {
        if (entry.gateReconcileTimerOwner !== timerOwner) return;
        delete entry.gateReconcileTimer;
        delete entry.gateReconcileTimerOwner;
        if (
          this.entries.get(chatQueueKey(target)) !== entry ||
          entry.frozenForDeletion === true ||
          entry.discardedForDeletion === true
        ) {
          return;
        }
        void this.reconcileStaleTurnGate(target, entry);
      },
      Math.max(0, delayMs),
    );
    if (
      typeof timer === 'object' &&
      timer !== null &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref();
    }
    entry.gateReconcileTimer = timer;
  }

  private hasStaleGateBlocker(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    reconcileOwner?: symbol,
  ): boolean {
    const sessionKey = buildChatSessionKey(
      target.projectId,
      target.worktreeId,
      target.chatId,
    );
    const evidence = getCodexTurnEvidence(sessionKey);
    return (
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true ||
      entry.authenticationPause !== undefined ||
      entry.dispatchInFlight ||
      (entry.recoveryInFlight &&
        (reconcileOwner === undefined ||
          entry.recoveryOwner !== reconcileOwner)) ||
      entry.reservation !== undefined ||
      // Provider idle and elapsed time never release an accepted, unstarted D.
      (entry.dispatchOwners?.length ?? 0) > 0 ||
      this.dependencies.hasPendingUserDecision?.(target) === true ||
      evidence.holdsTurn ||
      evidence.terminal !== undefined ||
      this.readTurnActivity(target, entry).hasForegroundProviderWork
    );
  }

  private async reconcileStaleTurnGate(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): Promise<void> {
    const key = chatQueueKey(target);
    const source = entry.queueGateSource;
    const armedAtMs = entry.queueGateArmedAtMs;
    if (!entry.turnActive || source === undefined || armedAtMs === undefined) {
      return;
    }
    if (this.entries.get(key) !== entry) return;

    const ageMs = Math.max(0, this.dependencies.now() - armedAtMs);
    if (ageMs < QUEUE_GATE_STALE_RECONCILE_MS) {
      this.scheduleStaleGateReconciliation(
        target,
        entry,
        QUEUE_GATE_STALE_RECONCILE_MS - ageMs,
      );
      return;
    }

    if (entry.gateReconcileOwner !== undefined) {
      // Keep the one-shot alive while a prior check waits for its finite event
      // barrier. It will re-check after that owner settles without overlapping
      // another canonical settlement attempt.
      this.scheduleStaleGateReconciliation(
        target,
        entry,
        QUEUE_GATE_STALE_RECONCILE_MS,
      );
      return;
    }

    if (this.hasStaleGateBlocker(target, entry)) {
      this.scheduleStaleGateReconciliation(
        target,
        entry,
        QUEUE_GATE_STALE_RECONCILE_MS,
      );
      return;
    }

    const reconcileOwner = Symbol('chat-queue-stale-gate-reconcile');
    const operationEpoch = entry.operationEpoch ?? 0;
    const turnUserMessageId = entry.activeTurnUserMessageId;
    entry.gateReconcileOwner = reconcileOwner;
    const wait = this.beginRecoveryWait(
      entry,
      'chat_queue.stale_gate_reconcile',
      reconcileOwner,
      {
        claim: false,
        gateAgeMs: () => Math.max(0, this.dependencies.now() - armedAtMs),
      },
    );
    const stillOwnsGateToken = (): boolean =>
      this.entries.get(key) === entry &&
      entry.turnActive &&
      (entry.operationEpoch ?? 0) === operationEpoch &&
      entry.activeTurnUserMessageId === turnUserMessageId &&
      entry.queueGateSource === source &&
      entry.queueGateArmedAtMs === armedAtMs &&
      entry.gateReconcileOwner === reconcileOwner;
    const stillOwnsGate = (): boolean =>
      stillOwnsGateToken() &&
      entry.recoveryOwner === reconcileOwner &&
      entry.recoveryInFlight === true;

    // Keep a one-shot pending if any awaited check proves inconclusive or the
    // event barrier is still settling. A successful release clears it.
    this.scheduleStaleGateReconciliation(
      target,
      entry,
      QUEUE_GATE_STALE_RECONCILE_MS,
    );

    try {
      try {
        // Do not release a gate or dispatch a replacement across events already
        // received for this chat. This dependency is a finite received-event
        // barrier; it deliberately has no timeout or bypass. The armed gate
        // holds dispatches back while it settles, so the recovery reservation
        // is claimed only after it: a real terminal in this backlog releases
        // the gate and ends the check without delaying the next send.
        wait.phase('provider_events');
        await this.dependencies.drainProviderEvents?.(target);
      } catch (error) {
        if (stillOwnsGateToken()) {
          logMainProcessWarn(
            '[chat-queue] Could not settle provider events before stale gate reconciliation:',
            error,
          );
          const retryAtMs = this.dependencies.now() + QUEUE_DRAIN_RETRY_MS;
          this.scheduleStaleGateReconciliation(
            target,
            entry,
            QUEUE_DRAIN_RETRY_MS,
          );
          if (entry.queue.length > 0) {
            this.recordDrainDecline(
              target,
              entry,
              'backlog-wait-failed',
              undefined,
              false,
              retryAtMs,
            );
          }
        }
        return;
      }
      // Revalidate after every await: an event can revive the same root (with
      // a new operation epoch), replace its owner, release the gate, or remove
      // this entry while the barrier is settling.
      if (!stillOwnsGateToken()) return;
      this.clearDrainDecline(entry, 'backlog-wait-failed');
      // Claim the per-chat recovery reservation used by Codex recovery and
      // queue mutations before canonical settlement; any in-flight reservation
      // blocks the check first. The gate token only invalidates this
      // reconciliation's result; the reservation keeps a competing recovery or
      // dispatch out while settlement is pending.
      if (this.hasStaleGateBlocker(target, entry)) return;
      entry.recoveryOwner = reconcileOwner;
      entry.recoveryInFlight = true;
      entry.recoveryWait = wait;
      wait.claim();

      if (turnUserMessageId !== undefined) {
        // An absent optional reader is not evidence that the canonical turn is
        // closed. Match Codex recovery: conservatively assume open and require
        // durable synthetic settlement before releasing a message-owned gate.
        let canonicalTurnOpen = true;
        if (this.dependencies.isCanonicalTurnOpen) {
          try {
            wait.phase('canonical_turn');
            canonicalTurnOpen = await this.dependencies.isCanonicalTurnOpen(
              target,
              turnUserMessageId,
            );
          } catch (error) {
            if (stillOwnsGate()) {
              logMainProcessWarn(
                '[chat-queue] Could not check canonical turn before stale gate reconciliation:',
                error,
              );
            }
            return;
          }
          if (!stillOwnsGate()) return;
          if (this.hasStaleGateBlocker(target, entry, reconcileOwner)) return;
        }
        if (canonicalTurnOpen) {
          try {
            // A message-owned canonical turn must be closed durably before its
            // host gate can be released. A rejected settlement leaves it gated.
            wait.phase('settle_cancelled_turn');
            await this.dependencies.settleCancelledTurn(
              target,
              turnUserMessageId,
            );
          } catch (error) {
            if (stillOwnsGate()) {
              logMainProcessWarn(
                '[chat-queue] Could not durably settle canonical turn before stale gate release:',
                error,
              );
            }
            return;
          }
          if (!stillOwnsGate()) return;
          if (this.hasStaleGateBlocker(target, entry, reconcileOwner)) return;
        }
      }

      if (!stillOwnsGate()) return;
      if (this.hasStaleGateBlocker(target, entry, reconcileOwner)) return;
      const currentAgeMs = Math.max(0, this.dependencies.now() - armedAtMs);
      if (currentAgeMs < QUEUE_GATE_STALE_RECONCILE_MS) return;

      this.releaseTurnGate(entry);
      this.recordStaleGateRelease(
        target,
        source,
        turnUserMessageId,
        currentAgeMs,
      );
      this.broadcastBestEffort(target, entry);
      if (entry.queue.length > 0) this.scheduleDrain(target, entry, 0);
    } finally {
      if (entry.gateReconcileOwner === reconcileOwner) {
        delete entry.gateReconcileOwner;
      }
      // Revival invalidates the gate token/epoch but must not release this
      // reservation until its awaited operation unwinds. Clear only our owner.
      this.releaseRecoveryReservation(entry, reconcileOwner);
      wait.finish('released');
      if (
        this.entries.get(key) === entry &&
        entry.turnActive &&
        entry.frozenForDeletion !== true &&
        entry.discardedForDeletion !== true &&
        entry.queueGateSource === source &&
        entry.queueGateArmedAtMs === armedAtMs &&
        !entry.gateReconcileTimer
      ) {
        this.scheduleStaleGateReconciliation(
          target,
          entry,
          QUEUE_GATE_STALE_RECONCILE_MS,
        );
      }
      if (
        this.entries.get(key) === entry &&
        !entry.turnActive &&
        !entry.dispatchInFlight &&
        !entry.recoveryInFlight &&
        entry.reservation === undefined &&
        entry.authenticationPause === undefined &&
        entry.frozenForDeletion !== true &&
        entry.discardedForDeletion !== true &&
        entry.queue.length > 0 &&
        !entry.drainTimer
      ) {
        // A real terminal can release the gate during an awaited barrier or
        // settlement. Its drain may have stood down on this reservation.
        this.scheduleDrain(target, entry, 0);
      }
    }
  }

  private recordStaleGateRelease(
    target: ChatQueueTarget,
    source: QueueGateSource,
    turnUserMessageId: string | undefined,
    ageMs: number,
  ): void {
    const nowMs = this.dependencies.now();
    try {
      getObservabilityService().recordSessionDiagnostic({
        version: 1,
        timestamp: new Date(nowMs).toISOString(),
        kind: 'chat_queue_gate_stale',
        sessionKey: buildChatSessionKey(
          target.projectId,
          target.worktreeId,
          target.chatId,
        ),
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
        providerType: 'unknown',
        queueGateSource: source,
        ...(turnUserMessageId !== undefined
          ? { queueGateOwnerId: turnUserMessageId }
          : {}),
        queueGateAgeMs: ageMs,
      });
    } catch {
      // Queue progress must not depend on optional observability storage.
    }
  }

  private foregroundDrainGuard(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): QueueDrainGuard | undefined {
    const activity = this.readTurnActivity(target, entry);
    if (activity.hasForegroundProviderWork) return 'provider-foreground';
    if (entry.reservation !== undefined) return 'reservation';
    if (entry.turnActive) return 'host-gate';
    return undefined;
  }

  private initialDrainGuard(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): QueueDrainGuard | undefined {
    if (entry.authenticationPause !== undefined) return 'auth-pause';
    if (entry.queue.length === 0) return undefined;
    if (this.isBackgroundWorkHoldActive(target, entry))
      return 'background-work';
    if (entry.dispatchInFlight) return 'dispatch-in-flight';
    if (entry.recoveryInFlight) return 'recovery-in-flight';
    return this.foregroundDrainGuard(target, entry);
  }

  private postBarrierDrainGuard(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): QueueDrainGuard | undefined {
    if (entry.authenticationPause !== undefined) return 'auth-pause';
    if (
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true
    ) {
      return undefined;
    }
    if (entry.queue.length === 0) return undefined;
    if (this.isBackgroundWorkHoldActive(target, entry))
      return 'background-work';
    if (entry.dispatchInFlight) return 'dispatch-in-flight';
    if (entry.recoveryInFlight) return 'recovery-in-flight';
    if (entry.queue[0]?.editLocked === true) return 'edit-locked-head';
    return this.foregroundDrainGuard(target, entry);
  }

  private clearDrainDecline(
    entry: ChatQueueEntry,
    guard: QueueDrainGuard,
  ): void {
    entry.diagnosedDrainDeclines?.delete(guard);
    if (entry.diagnosedDrainDeclines?.size === 0) {
      delete entry.diagnosedDrainDeclines;
    }
  }

  private clearResolvedDrainDeclines(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): void {
    if (entry.queue.length === 0) {
      delete entry.diagnosedDrainDeclines;
      return;
    }
    if (entry.authenticationPause === undefined)
      this.clearDrainDecline(entry, 'auth-pause');
    if (!entry.dispatchInFlight)
      this.clearDrainDecline(entry, 'dispatch-in-flight');
    if (!entry.recoveryInFlight)
      this.clearDrainDecline(entry, 'recovery-in-flight');
    if (entry.reservation === undefined)
      this.clearDrainDecline(entry, 'reservation');
    if (!entry.turnActive) this.clearDrainDecline(entry, 'host-gate');
    if (!this.isBackgroundWorkHoldActive(target, entry))
      this.clearDrainDecline(entry, 'background-work');
    if (!this.readTurnActivity(target, entry).hasForegroundProviderWork)
      this.clearDrainDecline(entry, 'provider-foreground');
    if (entry.queue[0]?.editLocked !== true)
      this.clearDrainDecline(entry, 'edit-locked-head');
  }

  private clearAllDrainDeclines(entry: ChatQueueEntry): void {
    delete entry.diagnosedDrainDeclines;
  }

  private wakeEventForDrainGuard(
    guard: QueueDrainGuard,
  ): QueueDrainWakeEvent | undefined {
    switch (guard) {
      case 'provider-foreground':
        return 'provider-terminal-or-session-activity';
      case 'host-gate':
        return 'gate-reconcile';
      case 'reservation':
        return 'reservation-released';
      case 'dispatch-in-flight':
        return 'dispatch-finalizer';
      case 'recovery-in-flight':
        return 'recovery-finalizer';
      case 'edit-locked-head':
        return 'head-edit-unlocked';
      case 'auth-pause':
        return 'authentication-resumed';
      case 'backlog-wait-failed':
        return undefined;
      case 'background-work':
        return 'native-background-work-ended';
    }
  }

  private scheduleDrainRetry(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): number | undefined {
    if (
      entry.authenticationPause !== undefined ||
      entry.externalRetryParked === true ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true
    ) {
      return undefined;
    }
    const retryAtMs = this.dependencies.now() + QUEUE_DRAIN_RETRY_MS;
    if (
      entry.drainTimer &&
      entry.drainTimerDueAtMs !== undefined &&
      entry.drainTimerDueAtMs <= retryAtMs
    ) {
      return entry.drainTimerDueAtMs;
    }
    this.scheduleDrain(target, entry, QUEUE_DRAIN_RETRY_MS);
    return entry.drainTimerDueAtMs;
  }

  private recordDrainDecline(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    guard: QueueDrainGuard,
    wakeEvent?: QueueDrainWakeEvent,
    retry = false,
    retryAtMsOverride?: number,
  ): void {
    if (
      entry.queue.length === 0 ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true
    ) {
      return;
    }

    let retryAtMs = retryAtMsOverride;
    if (retry) retryAtMs = this.scheduleDrainRetry(target, entry);
    // Authentication can pause the chat while its event barrier is awaiting.
    // If that barrier rejects, the suppressed retry waits for auth resume.
    const effectiveWakeEvent =
      wakeEvent ??
      (retryAtMs === undefined && entry.authenticationPause !== undefined
        ? 'authentication-resumed'
        : undefined);

    const diagnosed = (entry.diagnosedDrainDeclines ??= new Set());
    if (diagnosed.has(guard)) return;
    diagnosed.add(guard);

    const nowMs = this.dependencies.now();
    const gateFields =
      entry.turnActive && entry.queueGateSource !== undefined
        ? {
            queueGateSource: entry.queueGateSource,
            ...(entry.activeTurnUserMessageId !== undefined
              ? { queueGateOwnerId: entry.activeTurnUserMessageId }
              : {}),
            ...(entry.queueGateArmedAtMs !== undefined
              ? {
                  queueGateAgeMs: Math.max(0, nowMs - entry.queueGateArmedAtMs),
                }
              : {}),
          }
        : {};
    try {
      getObservabilityService().recordSessionDiagnostic({
        version: 1,
        timestamp: new Date(nowMs).toISOString(),
        kind: 'chat_queue_drain_declined',
        sessionKey: buildChatSessionKey(
          target.projectId,
          target.worktreeId,
          target.chatId,
        ),
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
        providerType: 'unknown',
        ...gateFields,
        queueDrainGuard: guard,
        ...(retryAtMs !== undefined ? { queueDrainRetryAtMs: retryAtMs } : {}),
        ...(effectiveWakeEvent !== undefined
          ? { queueDrainWakeEvent: effectiveWakeEvent }
          : {}),
      });
    } catch {
      // Queue progress must not depend on optional observability storage.
    }
  }

  /**
   * Drop a host gate nothing owns: one armed from provider activity, with no
   * turn id, once the provider reports no foreground work. A gate armed for a
   * dispatched turn stays until that turn's terminal, Stop or Send now.
   */
  private releaseUnownedTurnGate(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): void {
    const sessionKey = buildChatSessionKey(
      target.projectId,
      target.worktreeId,
      target.chatId,
    );
    if (
      !entry.turnActive ||
      entry.activeTurnUserMessageId !== undefined ||
      entry.dispatchInFlight ||
      entry.recoveryInFlight ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true ||
      entry.authenticationPause !== undefined ||
      entry.reservation ||
      getCodexTurnEvidence(sessionKey).holdsTurn ||
      this.readTurnActivity(target, entry).hasForegroundProviderWork
    ) {
      return;
    }
    this.releaseTurnGate(entry);
    this.broadcastBestEffort(target, entry);
  }

  private queueSnapshot(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    turnPhase = this.getTurnPhase(target, entry),
  ): ChatQueueUpdatedEvent {
    const waitingDelegationIds = entry.queue.flatMap((message) => {
      const admissionInFlight =
        (entry.dispatchInFlight || entry.reservation?.kind === 'dispatch') &&
        entry.activeTurnUserMessageId === message.request.userMessageId;
      if (
        !isInternalChatRequest(message.request) ||
        entry.dispatching?.id === message.id ||
        entry.steeringRowId === message.id ||
        entry.claimedQueueRowIds?.has(message.id) ||
        admissionInFlight
      ) {
        return [];
      }
      const delegationId = message.request.internalRow?.delegationId;
      return delegationId ? [delegationId] : [];
    });
    return {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      queue: entry.queue
        .filter((message) => !isInternalChatRequest(message.request))
        .map((message) => queuedMessageView(message, entry, turnPhase)),
      waitingDelegationIds,
      ...(entry.restartHeldByBackgroundWork === true
        ? { restartHeldByBackgroundWork: true }
        : {}),
    };
  }

  private publishPhaseSnapshot(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    turnPhase: ChatTurnPhase,
  ): void {
    if (entry.discardedForDeletion === true) return;
    this.dependencies.broadcast(this.queueSnapshot(target, entry, turnPhase));
    this.recordPublishedTurnPhase(entry, turnPhase);
  }

  private recordPublishedTurnPhase(
    entry: ChatQueueEntry,
    turnPhase: ChatTurnPhase,
  ): void {
    const changed = entry.lastPublishedTurnPhase !== turnPhase;
    entry.lastPublishedTurnPhase = turnPhase;
    entry.pendingPhaseBroadcast = false;
    if (changed) {
      entry.steeringRefusalRevisions?.clear();
      this.markSteeringEligibility(entry);
    }
  }

  private finishBroadcastPersistence(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    revision: number,
    succeeded: boolean,
  ): void {
    if (
      entry.broadcastRevision !== revision ||
      entry.pendingBroadcastRevision !== revision ||
      (entry.pendingBroadcastCount ?? 0) === 0
    ) {
      return;
    }
    entry.pendingBroadcastCount = Math.max(
      0,
      (entry.pendingBroadcastCount ?? 0) - 1,
    );
    if (succeeded) {
      entry.pendingBroadcastSucceeded = true;
      entry.broadcastPersistencePending = false;
      entry.pendingPhaseBroadcast = false;
      if (entry.discardedForDeletion === true) return;
      const turnPhase = this.getTurnPhase(target, entry);
      this.dependencies.broadcast(this.queueSnapshot(target, entry, turnPhase));
      this.recordPublishedTurnPhase(entry, turnPhase);
      return;
    }
    if (entry.pendingBroadcastCount === 0) {
      entry.broadcastPersistencePending = false;
      entry.pendingPhaseBroadcast = false;
      entry.pendingBroadcastSucceeded = false;
    }
  }

  private finishQueuePersistence(entry: ChatQueueEntry): void {
    entry.pendingQueuePersistenceCount = Math.max(
      0,
      (entry.pendingQueuePersistenceCount ?? 0) - 1,
    );
    if (entry.pendingQueuePersistenceCount === 0) {
      delete entry.pendingQueuePersistenceCount;
      this.schedulePendingGeneratedSteering(entry);
    }
  }

  /** Retain consumed IDs only while a previously read worktree snapshot can hydrate. */
  public beginInputHydration(
    projectId: string,
    worktreeId: string,
  ): () => void {
    const scope = `${projectId}/${worktreeId}/`;
    this.activeInputHydrations.set(
      scope,
      (this.activeInputHydrations.get(scope) ?? 0) + 1,
    );
    return (): void => {
      const remaining = (this.activeInputHydrations.get(scope) ?? 1) - 1;
      if (remaining > 0) this.activeInputHydrations.set(scope, remaining);
      else {
        this.activeInputHydrations.delete(scope);
        this.entries.forEach((entry, key) => {
          if (key.startsWith(scope)) this.prunePersistedInputIds(entry);
        });
      }
    };
  }

  private prunePersistedInputIds(entry: ChatQueueEntry): void {
    const liveIds = new Set(entry.queue.map(({ id }) => id));
    // The durable queue keeps a dispatching row until its prompt commits, so
    // a snapshot read in that window must not hydrate it a second time.
    if (entry.dispatching) liveIds.add(entry.dispatching.id);
    entry.persistedInputIds.forEach((id) => {
      if (!liveIds.has(id)) entry.persistedInputIds.delete(id);
    });
  }

  private pruneInputIdsAfterPersistence(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): void {
    if (
      !this.activeInputHydrations.has(
        `${target.projectId}/${target.worktreeId}/`,
      )
    )
      this.prunePersistedInputIds(entry);
  }

  /** Refresh the derived Steer state after global or project plugin defaults change. */
  public refreshGlobalPluginDefaults(): void {
    for (const entry of Array.from(this.entries.values())) {
      const queued = entry.queue[0];
      if (!queued || entry.discardedForDeletion) continue;
      const revision = this.dependencies.getCurrentPluginDefaultsRevision?.(
        queued.request,
      );
      if (revision === entry.currentGlobalPluginDefaultsRevision) continue;
      entry.currentGlobalPluginDefaultsRevision = revision;
      this.broadcastBestEffort(queued.request, entry, false);
      this.markSteeringEligibility(entry);
    }
  }

  /** Refresh transient phase fields for queued chats without writing durable state. */
  public refreshTurnPhases(): void {
    for (const entry of Array.from(this.entries.values())) {
      const { target } = entry;
      if (entry.discardedForDeletion || entry.queue.length === 0) {
        continue;
      }
      const turnPhase = this.getTurnPhase(target, entry);
      if (
        turnPhase === entry.lastPublishedTurnPhase &&
        entry.pendingPhaseBroadcast !== true
      ) {
        this.markSteeringEligibility(entry);
        continue;
      }
      if (entry.broadcastPersistencePending === true) {
        entry.pendingPhaseBroadcast = true;
        continue;
      }
      this.publishPhaseSnapshot(target, entry, turnPhase);
    }
  }

  /** Reconcile idle/removal activity and promptly retry queued chats. */
  public reconcileSessionActivity(): void {
    this.refreshTurnPhases();
    for (const entry of Array.from(this.entries.values())) {
      if (
        entry.discardedForDeletion === true ||
        (entry.turnActive !== true && entry.queue.length === 0)
      ) {
        continue;
      }
      if (entry.turnActive) {
        void this.reconcileStaleTurnGate(entry.target, entry);
      }
      if (
        entry.queue.length > 0 &&
        entry.externalRetryParked !== true &&
        entry.drainTimer === undefined
      ) {
        void this.drain(entry.target, entry);
      }
    }
  }

  /**
   * The callback runs under the dispatch reservation after final admission,
   * before provider I/O. It is never retained on a durable queued request.
   */
  private releaseWatcherAuthority(request: ChatSendMessageRequest): void {
    if (!request.watcherDeliveryId) return;
    const deliveryId = request.watcherDeliveryId;
    void import('../app-advisor/watchers')
      .then(({ getAppAdvisorWatcherService }) =>
        getAppAdvisorWatcherService().releaseChatDeliveryAuthority(deliveryId),
      )
      .catch((error: unknown) => {
        logMainProcessWarn(
          '[chat-queue] Failed to release watcher delivery authority:',
          error,
        );
      });
  }

  private resetHeldWatcherRetry(entry: ChatQueueEntry): void {
    if (entry.heldRetryTimer) clearTimeout(entry.heldRetryTimer);
    delete entry.heldRetryTimer;
    delete entry.heldRetryDelayMs;
  }

  private armHeldWatcherRetry(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): void {
    if (
      entry.heldRetryTimer ||
      entry.frozenForDeletion ||
      entry.discardedForDeletion ||
      !entry.queue.some((message) => message.watcherDeliveryHeld)
    )
      return;
    const delay = entry.heldRetryDelayMs ?? 5000;
    entry.heldRetryDelayMs = Math.min(delay * 2, 60000);
    entry.heldRetryTimer = this.dependencies.schedule((): void => {
      delete entry.heldRetryTimer;
      for (const message of entry.queue) delete message.watcherDeliveryHeld;
      this.scheduleDrain(target, entry, 0);
    }, delay);
    entry.heldRetryTimer.unref?.();
  }

  private watcherDispatchSucceeded(
    request: ChatSendMessageRequest,
    entry: ChatQueueEntry,
  ): void {
    this.releaseWatcherAuthority(request);
    this.resetHeldWatcherRetry(entry);
    this.armHeldWatcherRetry(request, entry);
  }

  /** Access-change wakeup for main-accepted watcher inputs whose outbox may be ACKed. */
  public retryHeldWatcherDeliveries(): void {
    for (const entry of Array.from(this.entries.values())) {
      this.resetHeldWatcherRetry(entry);
      const held = entry.queue.find((message) => message.watcherDeliveryHeld);
      if (!held) continue;
      for (const message of entry.queue) delete message.watcherDeliveryHeld;
      this.scheduleDrain(held.request, entry, 0);
    }
  }

  /**
   * Hold every queue drain until the core accepts turns (CAN-4112). Startup
   * recovery hydrates queued rows before the desktop runtime exists; edits,
   * cancels, moves and locks still apply, only drains wait.
   */
  public holdDrainsForStartup(): void {
    this.startupDrainHeld = true;
  }

  /** End the startup hold and drain every chat that has queued rows. Idempotent. */
  public releaseStartupDrainHold(): void {
    if (!this.startupDrainHeld) return;
    this.startupDrainHeld = false;
    this.reconcileSessionActivity();
  }

  /** Whether queue drains wait for startup to finish. */
  public isStartupDrainHeld(): boolean {
    return this.startupDrainHeld;
  }

  public async submit(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    beforeImmediateDispatch?: (options: {
      cancelledBeforeDispatch: boolean;
      startsTurn: boolean;
    }) => Promise<void>,
    options: ChatQueueDispatchOptions = {},
  ): Promise<void> {
    validateDelegationDelivery(request, origin);
    assertValidQueueDispatchOptions(options);
    if (request.watcherFired && request.watcherDeliveryId) {
      const check = await this.dependencies.checkWatcherIngress?.(request);
      if (check && !check.allowed)
        throw new WatcherDeliveryHeldError(check.reason);
    }
    const key = chatQueueKey(request);
    const existingEntry = this.entries.get(key);
    if (existingEntry) delete existingEntry.externalRetryParked;
    // A delegate's message steers on arrival like any generated row, but its
    // delegate waits on it under a short response budget: while another
    // generated row's provider handoff holds this chat, it queues as a hidden
    // internal row instead, and the pending loop delivers it in order. A
    // billing pin binds its continuation to its own turn, so it never steers.
    const internal = isInternalChatRequest(request);
    if (
      existingEntry?.creditHold !== undefined ||
      !isGeneratedInputRequest(request) ||
      (internal && this.generatedSubmissions.has(key)) ||
      !this.dependencies.steerGenerated ||
      options.requiredAccountProxyConnectionId
    )
      return this.submitNormally(
        request,
        origin,
        options,
        beforeImmediateDispatch,
      );
    const entry = this.getOrCreateEntry(request);
    let ledgerOwns: () => void = () => undefined;
    const claimed = new Promise<'claimed'>((resolve) => {
      ledgerOwns = (): void => resolve('claimed');
    });
    const run = async (): Promise<void> => {
      if (
        this.entries.get(key) !== entry ||
        entry.frozenForDeletion ||
        entry.discardedForDeletion
      )
        throw new Error('Chat is closing');
      if (hasTrackedWatcherDelivery(entry, request)) return;
      // Authority may change while another watcher or provider event commits.
      // Retain accepted input locally rather than steering stale source data.
      if (request.watcherDeliveryId) {
        const check = await this.dependencies.checkWatcherIngress?.(request);
        if (check && !check.allowed) {
          await this.enqueueDurably(request, entry, {
            id: this.dependencies.createId(),
            request,
            origin,
            enqueuedAtMs: this.dependencies.now(),
            watcherDeliveryHeld: {
              outcome: check.outcome,
              reason: check.reason,
            },
          });
          this.armHeldWatcherRetry(request, entry);
          return;
        }
      }
      if (!this.canStartInitialGeneratedSteering(request, entry, origin)) {
        await this.submitNormally(
          request,
          origin,
          options,
          beforeImmediateDispatch,
        );
        return;
      }

      const operationEpoch = entry.operationEpoch ?? 0;
      const owner = Symbol('chat-queue-initial-generated-steering');
      entry.recoveryOwner = owner;
      entry.recoveryInFlight = true;
      const wait = this.beginRecoveryWait(
        entry,
        'chat_queue.steer_initial_generated',
        owner,
      );
      const canSteerNow = (): boolean =>
        this.canSteerInitialGeneratedNow(
          request,
          entry,
          origin,
          owner,
          operationEpoch,
        );
      let result: GeneratedSteeringResult | undefined;
      try {
        if (canSteerNow()) {
          wait.phase('steer_generated');
          result = await this.dependencies.steerGenerated?.(
            request,
            origin,
            () => entry.queue.map((row) => row.id),
            true,
            canSteerNow,
            ledgerOwns,
          );
        }
        if (result?.status === 'handled') {
          // The input is steered or already in the delivery ledger.
          this.releaseWatcherAuthority(request);
          return;
        }
        if (result?.status === 'requeue') {
          wait.phase('restore_refused_generated');
          await this.restoreRefusedGenerated(
            request,
            entry,
            {
              id: result.rowId,
              request,
              origin,
              enqueuedAtMs: this.dependencies.now(),
            },
            // Internal rows queued during this attempt arrived after it.
            internal ? 0 : entry.queue.length,
            result.rowId,
            result.epoch,
            result.continuation,
            owner,
          );
        }
      } finally {
        if (entry.recoveryOwner === owner) {
          delete entry.recoveryOwner;
          entry.recoveryInFlight = false;
        }
        this.finishRecoveryWait(entry, wait);
        if (this.getTurnPhase(request, entry) !== 'foreground')
          this.scheduleDrain(request, entry, 0);
        this.schedulePendingGeneratedSteering(entry);
      }
      if (
        this.entries.get(key) !== entry ||
        entry.frozenForDeletion ||
        entry.discardedForDeletion
      )
        throw new Error('Chat is closing');
      if (result?.status === 'requeue') return;
      await this.submitNormally(
        request,
        origin,
        options,
        beforeImmediateDispatch,
        internal,
      );
    };
    // A delegate's message decides at once, so one that arrives after it
    // cannot reach the queue ahead of it.
    const submission = internal
      ? run()
      : (this.generatedSubmissions.get(key) ?? Promise.resolve())
          .catch(() => undefined)
          .then(run);
    this.generatedSubmissions.set(key, submission);
    const settled = submission
      .finally(() => {
        if (this.generatedSubmissions.get(key) === submission)
          this.generatedSubmissions.delete(key);
      })
      .then(() => 'settled' as const);
    if (!internal) {
      await settled;
      return;
    }
    // The delegate's call returns once the input-delivery ledger owns its
    // message. The provider handoff may take as long as the delegate's
    // response budget, and its outcome is the ledger's from here on.
    if ((await Promise.race([settled, claimed])) === 'claimed')
      void settled.catch((error: unknown) => {
        logMainProcessWarn(
          '[chat-queue] A delegate message steer failed after its durable claim:',
          error,
        );
      });
  }

  private canStartInitialGeneratedSteering(
    request: ChatSendMessageRequest,
    entry: ChatQueueEntry,
    origin: ChatQueueOrigin,
  ): boolean {
    if (
      this.entries.get(chatQueueKey(request)) !== entry ||
      entry.dispatchInFlight ||
      entry.recoveryInFlight ||
      entry.reservation !== undefined ||
      (entry.pendingQueuePersistenceCount ?? 0) > 0 ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true ||
      entry.authenticationPause !== undefined ||
      this.getTurnPhase(request, entry) !== 'foreground' ||
      hasTrackedWatcherDelivery(entry, request) ||
      isCurrentTurnBindingFull(request)
    ) {
      return false;
    }
    if (entry.queue.length > 0) return false;
    const currentRevision =
      this.dependencies.getCurrentPluginDefaultsRevision?.(request);
    if (currentRevision !== undefined)
      entry.currentGlobalPluginDefaultsRevision = currentRevision;
    const message: HostQueuedMessage = {
      id: request.userMessageId,
      request,
      origin,
      enqueuedAtMs: this.dependencies.now(),
    };
    return !steerBlockedByCapabilityChange(
      entry,
      message,
      this.getTurnPhase(request, entry),
    );
  }

  private canSteerInitialGeneratedNow(
    request: ChatSendMessageRequest,
    entry: ChatQueueEntry,
    origin: ChatQueueOrigin,
    owner: symbol,
    operationEpoch: number,
  ): boolean {
    return (
      this.entries.get(chatQueueKey(request)) === entry &&
      entry.recoveryOwner === owner &&
      entry.recoveryInFlight === true &&
      (entry.operationEpoch ?? 0) === operationEpoch &&
      entry.dispatchInFlight !== true &&
      entry.reservation === undefined &&
      (entry.pendingQueuePersistenceCount ?? 0) === 0 &&
      entry.frozenForDeletion !== true &&
      entry.discardedForDeletion !== true &&
      entry.authenticationPause === undefined &&
      this.getTurnPhase(request, entry) === 'foreground' &&
      !hasTrackedWatcherDelivery(entry, request) &&
      !steerBlockedByCapabilityChange(
        entry,
        { id: request.userMessageId, request, origin, enqueuedAtMs: 0 },
        this.getTurnPhase(request, entry),
      )
    );
  }

  /**
   * Whether a send during live native background work could be held. Auto
   * rows are routed only after admission, and a failed decision proves
   * nothing, so both take the queue where the adapter decides again.
   */
  private async mayHoldForBackgroundWork(
    request: ChatSendMessageRequest,
  ): Promise<boolean> {
    if (request.modelSelectionMode === 'auto') return true;
    try {
      const decision = await (this.dependencies.decideTurnSessionReuse?.(
        request,
      ) ?? turnSessionReuse.decideTurnSessionReuse(request));
      return (
        this.dependencies.holdsForBackgroundWork?.(request, decision) ??
        turnSessionReuse.holdsForBackgroundWork(request, decision)
      );
    } catch {
      return true;
    }
  }

  private async submitNormally(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    options: ChatQueueDispatchOptions,
    beforeImmediateDispatch?: (options: {
      cancelledBeforeDispatch: boolean;
      startsTurn: boolean;
    }) => Promise<void>,
    /** Queue ahead of the internal rows that arrived during an arrival steer. */
    prepend = false,
  ): Promise<void> {
    if (
      request.agentSent ||
      request.agentSenderProvenance ||
      request.hiddenContext?.kind === 'agent-sender-context'
    )
      await revalidateAgentSenderRequest(request);
    const entry = this.getOrCreateEntry(request);
    if (
      request.agentSendSetup &&
      (await agentSendTargetReadiness(request)) === 'pending'
    ) {
      await this.enqueueDurably(request, entry, {
        id: this.dependencies.createId(),
        request,
        origin,
        enqueuedAtMs: this.dependencies.now(),
      });
      this.scheduleDrain(request, entry, 1000);
      return;
    }
    entry.currentGlobalPluginDefaultsRevision =
      this.dependencies.getCurrentPluginDefaultsRevision?.(request);
    if (hasTrackedWatcherDelivery(entry, request)) return;
    // A send that could be held goes through the durable queue, where the
    // dispatch adapter makes the authoritative post-routing decision. One
    // that cannot keeps the direct path, so no queued row flashes (D3).
    // Generated rows retain their existing delivery/steering path.
    if (
      !isGeneratedInputRequest(request) &&
      this.hasNativeBackgroundWork(request) &&
      (await this.mayHoldForBackgroundWork(request))
    ) {
      await this.enqueueDurably(request, entry, {
        id: this.dependencies.createId(),
        request,
        origin,
        enqueuedAtMs: this.dependencies.now(),
        ...options,
      });
      this.scheduleDrain(request, entry, 0);
      return;
    }
    // Unknown ownership is settled under dispatch's reservation, so a cold
    // chat's first send does not detour through the queue.
    const activity = this.readTurnActivity(
      request,
      entry,
      undefined,
      undefined,
      false,
    );
    if (request.executionHarness === 'codex') {
      const turnUserMessageId = entry.activeTurnUserMessageId;
      const operationEpoch = entry.operationEpoch ?? 0;
      const recoveryOwner = Symbol('chat-queue-codex-recovery');
      if (
        turnUserMessageId !== undefined &&
        this.canRecoverCodexGate(
          request,
          entry,
          turnUserMessageId,
          operationEpoch,
          recoveryOwner,
          true,
        )
      ) {
        await this.recoverIdleCodexTurnGate(
          request,
          origin,
          entry,
          turnUserMessageId,
          operationEpoch,
          recoveryOwner,
          options,
        );
        await this.drain(request, entry);
        return;
      }
      if (
        turnUserMessageId === undefined &&
        this.canReleaseIdleUnownedCodexGate(request, entry)
      ) {
        await this.enqueueOnIdleUnownedCodexGate(
          request,
          origin,
          entry,
          operationEpoch,
          recoveryOwner,
          options,
        );
        return;
      }
    }
    // Provider sessions can resume without a new Canopy send (for example,
    // when Claude reports a completed background task). In that case the
    // session manager has already raised its active-turn state, but this
    // queue's gate is still idle because it did not dispatch the continuation.
    // Synchronize before deciding whether to dispatch so a renderer send made
    // during that continuation remains a visible host-owned queue row instead
    // of disappearing into the provider SDK's private pending-message queue.
    if (activity.hasForegroundProviderWork && !entry.turnActive) {
      this.armTurnGate(request, entry, 'adopted-provider-activity');
      entry.activePluginSelections =
        this.dependencies.getActiveProviderPluginSelections?.(request);
      entry.activeGlobalPluginDefaultsRevision =
        this.dependencies.getActiveProviderPluginDefaultsRevision?.(request);
    }
    const heldFirst =
      entry.worktreeSetupHold?.firstUserMessageId !== undefined &&
      entry.worktreeSetupHold.firstUserMessageId === request.userMessageId;
    if (heldFirst) {
      delete entry.worktreeSetupHold;
      if (entry.activeTurnUserMessageId === request.userMessageId) {
        entry.turnActive = false;
        delete entry.activeTurnUserMessageId;
      }
      if (
        entry.authenticationPause ||
        this.getTurnPhase(request, entry) === 'foreground' ||
        entry.dispatchInFlight ||
        entry.recoveryInFlight
      ) {
        await this.enqueueDurably(
          request,
          entry,
          {
            id: this.dependencies.createId(),
            request,
            origin,
            enqueuedAtMs: this.dependencies.now(),
            ...options,
          },
          true,
        );
        if (
          this.getTurnPhase(request, entry) !== 'foreground' &&
          !entry.dispatchInFlight &&
          !entry.recoveryInFlight
        )
          this.scheduleDrain(request, entry, 0);
        return;
      }
      // The held turn takes the same admission and authorization as any send.
      await this.dispatch(
        request,
        origin,
        entry,
        false,
        options,
        beforeImmediateDispatch,
      );
      return;
    }
    if (
      entry.authenticationPause ||
      entry.creditHold !== undefined ||
      entry.worktreeSetupHold !== undefined ||
      activity.turnPhase === 'foreground' ||
      entry.dispatchInFlight ||
      entry.recoveryInFlight ||
      entry.queue.length > 0
    ) {
      await this.enqueueDurably(
        request,
        entry,
        {
          id: this.dependencies.createId(),
          request,
          origin,
          enqueuedAtMs: this.dependencies.now(),
          ...options,
        },
        prepend,
      );
      // A restored row can leave the host queue non-empty while every runtime
      // gate is idle (for example after an auth-preflight refusal). A new send
      // is the user's explicit retry trigger: preserve FIFO by enqueueing it,
      // then restart the drain rather than leaving both rows stranded.
      if (
        this.getTurnPhase(request, entry) !== 'foreground' &&
        !entry.dispatchInFlight &&
        !entry.recoveryInFlight &&
        !entry.drainTimer
      ) {
        this.scheduleDrain(request, entry, 0);
      }
      return;
    }
    await this.dispatch(
      request,
      origin,
      entry,
      false,
      options,
      beforeImmediateDispatch,
    );
  }

  public async pauseForAuthentication(
    target: ChatQueueTarget,
    attemptId: string,
  ): Promise<void> {
    const entry = this.getOrCreateEntry(target);
    if (entry.authenticationPause === attemptId) return;
    entry.authenticationPause = attemptId;
    if (entry.drainTimer) {
      clearTimeout(entry.drainTimer);
      delete entry.drainTimer;
    }
    const persistence = this.broadcast(target, entry);
    if (persistence) await persistence;
  }

  /** Release only the matching attempt. Its resumed turn will drain follow-ups. */
  public releaseAuthenticationPause(
    target: ChatQueueTarget,
    attemptId: string,
  ): void {
    const entry = this.entries.get(chatQueueKey(target));
    if (entry?.authenticationPause === attemptId) {
      delete entry.authenticationPause;
      delete entry.externalRetryParked;
      this.broadcastBestEffort(target, entry);
      this.markSteeringEligibility(entry);
      if (
        entry.queue.length > 0 &&
        this.getTurnPhase(target, entry) !== 'foreground' &&
        !entry.dispatchInFlight &&
        !entry.recoveryInFlight
      ) {
        this.scheduleDrain(target, entry, 0);
      }
    }
  }

  /** Manual Stop retires even a pause restored without an in-memory attempt. */
  public releaseAuthenticationPauseForStop(
    target: ChatQueueTarget,
  ): string | undefined {
    const entry = this.entries.get(chatQueueKey(target));
    const attemptId = entry?.authenticationPause;
    if (!entry || !attemptId) return undefined;
    delete entry.authenticationPause;
    delete entry.externalRetryParked;
    this.broadcastBestEffort(target, entry);
    this.markSteeringEligibility(entry);
    return attemptId;
  }

  /**
   * Holds the chat's sends while its worktree's Git setup runs: a send queues
   * instead of dispatching, and nothing drains, not even after a Stop, until
   * the hold is released. `turnUserMessageId`, the turn the setup holds,
   * owns the gate as the chat's active turn meanwhile.
   */
  public holdForWorktreeSetup(
    target: ChatQueueTarget,
    turnUserMessageId?: string,
  ): void {
    const entry = this.getOrCreateEntry(target);
    entry.worktreeSetupHold = {
      ...(entry.worktreeSetupHold?.turnUserMessageId !== undefined
        ? { turnUserMessageId: entry.worktreeSetupHold.turnUserMessageId }
        : {}),
      ...(turnUserMessageId !== undefined ? { turnUserMessageId } : {}),
    };
    if (entry.drainTimer) {
      clearTimeout(entry.drainTimer);
      delete entry.drainTimer;
    }
    if (turnUserMessageId !== undefined && !entry.turnActive) {
      entry.turnActive = true;
      entry.activeTurnUserMessageId = turnUserMessageId;
      this.broadcastBestEffort(target, entry);
    } else if (entry.queue.length > 0) {
      // Rows already queued project locked behind the hold.
      this.broadcastBestEffort(target, entry);
    }
  }

  /**
   * Releases the setup hold. With `firstUserMessageId`, the turn the setup
   * held, only that send may dispatch, ahead of the sends queued behind it;
   * the hold lifts when it is submitted. Otherwise the queue drains as usual.
   */
  public releaseWorktreeSetupHold(
    target: ChatQueueTarget,
    options: { firstUserMessageId?: string } = {},
  ): void {
    const entry = this.entries.get(chatQueueKey(target));
    const hold = entry?.worktreeSetupHold;
    if (!entry || !hold) return;
    if (options.firstUserMessageId !== undefined) {
      entry.worktreeSetupHold = {
        ...hold,
        firstUserMessageId: options.firstUserMessageId,
      };
      return;
    }
    delete entry.worktreeSetupHold;
    if (
      hold.turnUserMessageId !== undefined &&
      entry.activeTurnUserMessageId === hold.turnUserMessageId &&
      !entry.dispatchInFlight
    ) {
      entry.turnActive = false;
      delete entry.activeTurnUserMessageId;
      this.broadcastBestEffort(target, entry);
    } else if (entry.queue.length > 0) {
      // Rows queued behind the hold project unlocked again.
      this.broadcastBestEffort(target, entry);
    }
    if (
      !entry.turnActive &&
      !entry.dispatchInFlight &&
      !entry.recoveryInFlight &&
      entry.queue.length > 0
    )
      this.scheduleDrain(target, entry, 0);
  }

  /**
   * Removes the sends queued behind a worktree setup that ended `outcome`,
   * in order, so their turns end that way without running. The commit that
   * removes them records their ends; if it fails they stay queued.
   */
  public async takeWorktreeSetupHeldSends(
    target: ChatQueueTarget,
    outcome: 'cancelled' | 'failed',
  ): Promise<ChatSendMessageRequest[]> {
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry?.worktreeSetupHold || entry.queue.length === 0) return [];
    const taken = entry.queue.splice(0);
    const requests = taken.map((message) => message.request);
    try {
      const persistence = this.broadcast(target, entry, {
        type: 'end-setup-held',
        requests,
        outcome,
      });
      if (persistence) await persistence;
    } catch (error) {
      entry.queue.unshift(...taken);
      this.broadcastBestEffort(target, entry);
      throw error;
    }
    return requests;
  }

  public onTurnTerminal(
    target: ChatQueueTarget,
    status: ChatQueueTerminalStatus,
    turnUserMessageId?: string,
    retryBlockedReason?: QueuedMessageRetryBlockedReason,
  ): void {
    observeCodexTurnTerminal(
      buildChatSessionKey(target.projectId, target.worktreeId, target.chatId),
      turnUserMessageId,
    );
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return;
    // A root's own terminal settles its D even when the gate moved on. A
    // started D was already transferred at its durable start, and canonical
    // lifecycle holds until the end commits; an unstarted one is orphaned.
    // An untagged Stop/destroy release cannot outrun a newer D: Stop holds S.
    this.removeDispatchOwners(target, entry, {
      ...(turnUserMessageId ? { userMessageId: turnUserMessageId } : {}),
    });
    // A terminal notification tagged with a superseded turn's id must not
    // release the gate: after a cancel-release already drained the next
    // message, the old turn's late provider terminal would otherwise clear
    // turnActive mid-turn and overlap dispatches. Untagged releases (IPC
    // cancel/destroy paths) are deliberate and always accepted.
    if (
      turnUserMessageId !== undefined &&
      entry.activeTurnUserMessageId !== undefined &&
      entry.activeTurnUserMessageId !== turnUserMessageId
    ) {
      return;
    }
    if (retryBlockedReason === 'insufficient_credits') {
      entry.creditHold = { funded: false };
      const refused = entry.creditRetryCandidate;
      if (
        refused &&
        refused.request.userMessageId === turnUserMessageId &&
        !entry.queue.some((row) => row.id === refused.id)
      ) {
        this.insertQueuedMessage(entry, refused, 0);
      }
    }
    if (
      turnUserMessageId === undefined ||
      entry.creditRetryCandidate?.request.userMessageId === turnUserMessageId
    )
      delete entry.creditRetryCandidate;
    if (turnUserMessageId === undefined) {
      entry.untaggedTerminals = (entry.untaggedTerminals ?? 0) + 1;
    }
    if (
      turnUserMessageId === undefined ||
      (entry.reservation?.kind === 'dispatch' &&
        entry.activeTurnUserMessageId === turnUserMessageId)
    ) {
      delete entry.reservation;
    }
    delete entry.externalRetryParked;
    this.releaseTurnGate(entry, turnUserMessageId);
    this.broadcastBestEffort(target, entry);
    this.scheduleDrain(target, entry, status === 'complete' ? 0 : 500);
    this.refreshRestartHold(target);
  }

  /**
   * Reacquire the host queue gate when provider output revives a turn that
   * had just emitted a terminal event. Returns false when another turn has
   * already acquired the gate, so stale continuation output can be dropped.
   */
  public onTurnRevived(
    target: ChatQueueTarget,
    turnUserMessageId: string,
  ): boolean {
    return this.acceptTurnRevival(target, turnUserMessageId).accepted;
  }

  /**
   * Arbitrate and record a provider-turn revival. A missing queue entry keeps
   * the historical acceptance behavior and returns an inert lease that can
   * confirm only while no newer operation epoch or different active root has
   * appeared.
   */
  public acceptTurnRevival(
    target: ChatQueueTarget,
    turnUserMessageId: string,
  ): { accepted: false } | { accepted: true; lease: ChatQueueRevivalLease } {
    const key = chatQueueKey(target);
    const entry = this.entries.get(key);
    if (!entry) {
      const lease: ChatQueueRevivalLease = {
        rootId: turnUserMessageId,
        epoch: -1,
      };
      this.pendingInertRevivalLeases.set(key, lease);
      this.inertRevivalLeaseEvidence.set(lease, { key });
      return {
        accepted: true,
        lease,
      };
    }
    if (
      entry.turnActive &&
      entry.activeTurnUserMessageId !== undefined &&
      entry.activeTurnUserMessageId !== turnUserMessageId
    ) {
      return { accepted: false };
    }
    this.pendingInertRevivalLeases.delete(key);
    this.confirmTurnRevived(target, turnUserMessageId);
    const lease: ChatQueueRevivalLease = {
      rootId: turnUserMessageId,
      epoch: entry.operationEpoch ?? 0,
    };
    this.revivalLeaseEntries.set(lease, entry);
    return {
      accepted: true,
      lease,
    };
  }

  /**
   * Apply a turn-root acceptance that was already arbitrated by the provider
   * event router. This is deliberately not a second ownership decision: it
   * makes the accepted stamp durable against an old root's concurrent terminal
   * release while rejected stamps never call this path.
   */
  public confirmTurnRevived(
    target: ChatQueueTarget,
    turnUserMessageId: string,
  ): void {
    const key = chatQueueKey(target);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.pendingInertRevivalLeases.delete(key);
    // A new accepted revival supersedes any older lease, including a
    // same-root revival. Preserve the legacy one-step operation-epoch advance.
    entry.operationEpoch = (entry.operationEpoch ?? 0) + 1;
    this.applyConfirmedTurnRevival(target, entry, turnUserMessageId, false);
  }

  /**
   * Confirm only the revival represented by this lease. A normal lease can
   * survive a release only when its own tagged terminal caused that release;
   * untagged Stop and unrelated gate changes invalidate it.
   */
  public confirmTurnRevival(
    target: ChatQueueTarget,
    lease: ChatQueueRevivalLease,
  ): boolean {
    const key = chatQueueKey(target);
    const entry = this.entries.get(key);
    if (lease.epoch === -1) {
      const evidence = this.inertRevivalLeaseEvidence.get(lease);
      if (
        !evidence ||
        evidence.key !== key ||
        this.pendingInertRevivalLeases.get(key) !== lease
      ) {
        return false;
      }
      // An inert lease may bind to the first later entry, but never across an
      // entry replacement. Its pending marker is removed by deletion/reset.
      if (!entry) return true;
      if (evidence.entry && evidence.entry !== entry) return false;
      if ((entry.operationEpoch ?? 0) !== 0) return false;
      if (
        entry.revivalLeaseRootId !== undefined &&
        entry.revivalLeaseRootId !== lease.rootId
      ) {
        return false;
      }
      // Like acceptance, an active gate with no known root is adopted.
      if (
        entry.turnActive &&
        entry.activeTurnUserMessageId !== undefined &&
        entry.activeTurnUserMessageId !== lease.rootId
      ) {
        return false;
      }
      evidence.entry = entry;
      this.applyConfirmedTurnRevival(target, entry, lease.rootId, true);
      return true;
    }
    if (
      !entry ||
      this.revivalLeaseEntries.get(lease) !== entry ||
      (entry.operationEpoch ?? 0) !== lease.epoch ||
      entry.revivalLeaseRootId !== lease.rootId
    ) {
      return false;
    }
    const leaseStillOwnsGate =
      (entry.turnActive && entry.activeTurnUserMessageId === lease.rootId) ||
      (!entry.turnActive &&
        entry.revivalTerminalReleaseRootId === lease.rootId);
    if (!leaseStillOwnsGate) return false;

    this.applyConfirmedTurnRevival(target, entry, lease.rootId, true);
    return true;
  }

  /**
   * Roll back only the gate represented by this live lease. The scheduled
   * drain still passes through the queue's ordinary foreground, reservation,
   * event-barrier, deletion and parked-input guards.
   */
  public rollbackTurnRevival(
    target: ChatQueueTarget,
    lease: ChatQueueRevivalLease,
  ): boolean {
    if (lease.epoch === -1) return false;
    const entry = this.entries.get(chatQueueKey(target));
    if (
      !entry ||
      this.revivalLeaseEntries.get(lease) !== entry ||
      (entry.operationEpoch ?? 0) !== lease.epoch ||
      entry.revivalLeaseRootId !== lease.rootId ||
      entry.reservation !== undefined ||
      entry.dispatchInFlight ||
      entry.recoveryInFlight
    ) {
      return false;
    }
    // A terminal may release a lease for a later confirm, but rollback only
    // reports success when it itself releases the currently-owned gate.
    if (!entry.turnActive || entry.activeTurnUserMessageId !== lease.rootId) {
      return false;
    }

    this.releaseTurnGate(entry);
    this.broadcastBestEffort(target, entry);
    if (entry.queue.length > 0) this.scheduleDrain(target, entry, 0);
    return true;
  }

  private applyConfirmedTurnRevival(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    turnUserMessageId: string,
    preserveRevivalLease: boolean,
  ): void {
    if (entry.drainTimer) {
      clearTimeout(entry.drainTimer);
      delete entry.drainTimer;
    }
    this.armTurnGate(target, entry, 'revived-root', turnUserMessageId, {
      preserveRevivalLease,
      // Legacy confirmation advanced once immediately before this helper.
      advanceOperationEpoch: false,
    });
    entry.revivalLeaseRootId = turnUserMessageId;
    delete entry.revivalTerminalReleaseRootId;
    entry.currentGlobalPluginDefaultsRevision =
      this.dependencies.getCurrentPluginDefaultsRevision?.(target);
    entry.activePluginSelections =
      this.dependencies.getActiveProviderPluginSelections?.(target) ??
      entry.activePluginSelections;
    entry.activeGlobalPluginDefaultsRevision =
      this.dependencies.getActiveProviderPluginDefaultsRevision?.(target) ??
      entry.activeGlobalPluginDefaultsRevision;
    this.broadcastBestEffort(target, entry);
    this.markSteeringEligibility(entry);
  }

  public async edit(
    request: ChatQueueEditRequest,
    commandResult?: ChatQueueCommandResult,
    attachmentMode: 'replace' | 'preserve' = 'replace',
    guard?: ChatQueueEntryGuard,
  ): Promise<ChatQueueMutationResult> {
    const entry = this.entries.get(chatQueueKey(request));
    const message = entry?.queue.find(
      (candidate) => candidate.id === request.entryId,
    );
    if (!entry || !message) {
      // Existing-channel terminal-local edits are canonical input policy, not IPC policy.
      const { getChatStateService } = await import('./chat-state-service');
      return getChatStateService().editRetainedTerminalAgentInput(
        request,
        guard,
      );
    }
    if (entry.recoveryInFlight) return 'busy';
    if (isStaleEntry(message, guard)) return 'conflict';
    const previousRequest = message.request;
    const previousWatcherParts = message.watcherParts;
    const previousWatcherConsolidationBoundary =
      message.watcherConsolidationBoundary;
    const restoredAsyncQuestionId = message.request.asyncQuestionId;
    const { asyncQuestionId: _asyncQuestionId, ...editableRequest } =
      message.request;
    void _asyncQuestionId;
    const previousRevision = message.revision;
    message.revision = (message.revision ?? 1) + 1;
    message.request = {
      ...editableRequest,
      text: request.text,
      ...(attachmentMode === 'replace'
        ? {
            fileReferences: request.fileReferences,
            attachmentPaths: request.attachmentPaths,
            attachmentPromptContexts: request.attachmentPromptContexts,
          }
        : {}),
      ...(request.inputMode ? { inputMode: request.inputMode } : {}),
    };
    delete message.watcherParts;
    delete message.request.watcherPartSnapshots;
    message.watcherConsolidationBoundary = true;
    delete message.editLocked;
    try {
      const persistence = this.broadcast(request, entry, {
        type: 'edit',
        request: message.request,
        ...(restoredAsyncQuestionId ? { restoredAsyncQuestionId } : {}),
        ...(commandResult ? { commandResult } : {}),
      });
      if (persistence) await persistence;
    } catch (error) {
      message.request = previousRequest;
      if (previousRevision === undefined) delete message.revision;
      else message.revision = previousRevision;
      if (previousWatcherParts) message.watcherParts = previousWatcherParts;
      else delete message.watcherParts;
      if (previousWatcherConsolidationBoundary) {
        message.watcherConsolidationBoundary = true;
      } else {
        delete message.watcherConsolidationBoundary;
      }
      this.broadcastBestEffort(request, entry);
      throw error;
    }
    this.committedMessageFallbackRetries.delete(
      chatQueueRowKey(request, message.id),
    );
    this.clearBackgroundWorkHold(entry, message.id);
    delete entry.externalRetryParked;
    this.markSteeringEligibility(entry);
    if (
      this.getTurnPhase(request, entry) !== 'foreground' &&
      entry.queue[0]?.id === message.id
    ) {
      void this.drain(request, entry);
    }
    // The edited request may carry different settings.
    this.refreshRestartHold(request);
    return 'applied';
  }

  /**
   * Places `entryId` before `beforeEntryId`, or at the tail when it is null.
   * The complete canonical order commits (with the command receipt) before it
   * is acknowledged or published; a failed commit restores the prior order.
   * Internal delegation deliveries are not part of the public queue, so they
   * can be neither moved nor used as an anchor.
   */
  public async move(
    target: ChatQueueTarget,
    entryId: string,
    beforeEntryId: string | null,
    commandResult?: ChatQueueCommandResult,
    guard?: ChatQueueEntryGuard,
  ): Promise<ChatQueueMutationResult> {
    const entry = this.entries.get(chatQueueKey(target));
    const isPublic = (message: HostQueuedMessage): boolean =>
      !message.request.managedDelegationDeliveryId;
    const message = entry?.queue.find(
      (candidate) => candidate.id === entryId && isPublic(candidate),
    );
    if (!entry || !message) return 'not_found';
    const anchor =
      beforeEntryId === null
        ? undefined
        : entry.queue.find(
            (candidate) =>
              candidate.id === beforeEntryId && isPublic(candidate),
          );
    if (beforeEntryId !== null && !anchor) return 'not_found';
    // Moving while an edit is open would shift the row under the editor, and
    // a dispatch or another queue operation owns the current order.
    if (
      entry.recoveryInFlight ||
      entry.dispatchInFlight ||
      (entry.cancelsInFlight ?? 0) > 0 ||
      entry.frozenForDeletion === true ||
      entry.queue.some((candidate) => candidate.editLocked === true)
    )
      return 'busy';
    if (isStaleEntry(message, guard)) return 'conflict';
    const previousOrder = entry.queue.map((candidate) => candidate.id);
    if (anchor !== message) {
      const reordered = entry.queue.filter(
        (candidate) => candidate !== message,
      );
      const index = anchor ? reordered.indexOf(anchor) : reordered.length;
      reordered.splice(index, 0, message);
      entry.queue = reordered;
      // A tail move must not put a visible row behind hidden deliveries.
      prioritizeQueue(entry);
    }
    entry.recoveryInFlight = true;
    entry.reorderInFlight = true;
    const wait = this.beginRecoveryWait(entry, 'chat_queue.move');
    try {
      wait.phase('queue_persistence');
      const persistence = this.broadcast(target, entry, {
        type: 'move',
        ...(commandResult ? { commandResult } : {}),
      });
      if (persistence) await persistence;
      // A reorder is a user action on the queue, like an edit or cancel.
      delete entry.externalRetryParked;
    } catch (error) {
      // Restore by id: rows can be replaced (plugin approval) or appended
      // while the commit is pending. Appended rows keep their tail order.
      const current = new Map(
        entry.queue.map((candidate) => [candidate.id, candidate]),
      );
      const known = new Set(previousOrder);
      entry.queue = [
        ...previousOrder.flatMap((id) => current.get(id) ?? []),
        ...entry.queue.filter((candidate) => !known.has(candidate.id)),
      ];
      prioritizeQueue(entry);
      this.broadcastBestEffort(target, entry);
      throw error;
    } finally {
      entry.recoveryInFlight = false;
      this.finishRecoveryWait(entry, wait);
      delete entry.reorderInFlight;
      // A new head changes what can steer and what drains next.
      this.markSteeringEligibility(entry);
      if (this.getTurnPhase(target, entry) !== 'foreground')
        void this.drain(target, entry);
    }
    return 'applied';
  }

  public async cancel(
    target: ChatQueueTarget,
    entryId: string,
    commandResult?: ChatQueueCommandResult,
    guard?: ChatQueueEntryGuard,
  ): Promise<ChatQueueMutationResult> {
    const entry = this.entries.get(chatQueueKey(target));
    const index =
      entry?.queue.findIndex((message) => message.id === entryId) ?? -1;
    if (!entry || index < 0) {
      const { getChatStateService } = await import('./chat-state-service');
      return getChatStateService().cancelRetainedTerminalAgentInput(
        target,
        entryId,
        guard,
      );
    }
    if (entry.recoveryInFlight) return 'busy';
    const queued = entry.queue[index];
    if (queued && isStaleEntry(queued, guard)) return 'conflict';
    const [message] = entry.queue.splice(index, 1);
    if (!message) return 'not_found';
    entry.cancelsInFlight = (entry.cancelsInFlight ?? 0) + 1;
    try {
      const persistence = this.broadcast(target, entry, {
        type: 'cancel',
        request: message.request,
        ...(commandResult ? { commandResult } : {}),
      });
      if (persistence) await persistence;
    } catch (error) {
      this.insertQueuedMessage(entry, message, index);
      this.broadcastBestEffort(target, entry);
      throw error;
    } finally {
      entry.cancelsInFlight = (entry.cancelsInFlight ?? 1) - 1;
    }
    this.releaseWatcherAuthority(message.request);
    this.committedMessageFallbackRetries.delete(
      chatQueueRowKey(target, message.id),
    );
    this.clearBackgroundWorkHold(entry, message.id);
    if (entry.queue.length === 0) delete entry.creditHold;
    delete entry.externalRetryParked;
    this.markSteeringEligibility(entry);
    if (this.getTurnPhase(target, entry) !== 'foreground')
      void this.drain(target, entry);
    return 'applied';
  }

  public async force(
    target: ChatQueueTarget,
    entryId: string,
    commandResult?: ChatQueueCommandResult,
    guard?: ChatQueueEntryGuard,
  ): Promise<ChatQueueMutationResult> {
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return 'not_found';
    const message = entry.queue.find((candidate) => candidate.id === entryId);
    if (!message) return 'not_found';
    // A row behind a worktree setup hold is locked from Run now
    // (`forceLocked`): its worktree has no checkout until setup ends.
    if (entry.worktreeSetupHold !== undefined) return 'busy';
    if (entry.creditHold) {
      await this.refreshCreditHold(entry);
      if (this.entries.get(chatQueueKey(target)) !== entry) return 'not_found';
      if (!entry.creditHold?.funded) {
        this.scheduleDrain(target, entry, 5000);
        return 'busy';
      }
    }
    if (
      message.request.agentSent ||
      message.request.agentSenderProvenance ||
      message.request.hiddenContext?.kind === 'agent-sender-context'
    )
      await revalidateAgentSenderRequest(message.request);
    if (
      message.request.agentSendSetup &&
      (await agentSendTargetReadiness(message.request)) === 'pending'
    )
      return 'busy';
    // A terminal notification can release turnActive before the provider
    // dispatch promise finishes unwinding. Leave the queued row intact until
    // the existing completion path can drain it instead of overlapping a
    // second dispatch (or a recovery operation) for the same chat.
    if (
      entry.dispatchInFlight ||
      entry.recoveryInFlight ||
      entry.reservation !== undefined
    )
      return 'busy';
    // The awaits above can let a cancel or edit remove the row; never cancel
    // the active turn for a forced row that no longer exists.
    if (!entry.queue.includes(message)) return 'not_found';
    const key = chatQueueKey(target);
    const heldAtStart = entry.backgroundWorkHold?.rowId === message.id;
    const creditHoldAtStart = entry.creditHold;
    const epoch = entry.operationEpoch ?? 0;
    entry.recoveryInFlight = true;
    const wait = this.beginRecoveryWait(entry, 'chat_queue.force');
    try {
      if (isStaleEntry(message, guard)) return 'conflict';
      // Cancel a genuinely active provider turn BEFORE removing the row: if
      // cancel rejects, the queued message stays intact and the turn gate is
      // untouched, instead of the row being lost and turnActive wedged true.
      const activity = this.readTurnActivity(target, entry);
      // A turn this queue dispatched can sit idle in the provider while it
      // waits on an approval or a question. Interrupt stops that turn too.
      const pausedOnUserDecision =
        entry.turnActive &&
        this.dependencies.hasPendingUserDecision?.(target) === true;
      if (activity.hasForegroundProviderWork || pausedOnUserDecision) {
        const interruptedTurnUserMessageId = entry.activeTurnUserMessageId;
        wait.phase('cancel_provider');
        await this.dependencies.cancel(target);
        if (
          this.entries.get(key) !== entry ||
          (entry.operationEpoch ?? 0) !== epoch ||
          entry.reservation !== undefined
        )
          return 'busy';
        try {
          wait.phase('settle_cancelled_turn');
          await this.dependencies.settleCancelledTurn(
            target,
            interruptedTurnUserMessageId,
          );
        } catch (error) {
          // UI settlement is best-effort. Once provider cancellation succeeds,
          // a renderer notification failure must not wedge the host queue gate.
          logMainProcessWarn(
            '[chat-queue] Failed to settle cancelled turn before forced dispatch:',
            error,
          );
        }
        if (
          this.entries.get(key) !== entry ||
          (entry.operationEpoch ?? 0) !== epoch ||
          entry.reservation !== undefined
        )
          return 'busy';
        this.releaseTurnGate(entry);
      } else {
        // A reservation is an admission owner, not provider work to cancel.
        // Leave the queue untouched until its owner releases or receives its
        // terminal rather than force-dispatching across that owner.
        if (entry.reservation) return 'busy';
        // Background agent streams can outlive their root turn. A stale host
        // gate must not sweep provider input and interrupt those agents.
        if (entry.turnActive) {
          this.releaseTurnGate(entry);
          this.broadcastBestEffort(target, entry);
        }
      }
      // Re-resolve after the await — a concurrent cancel/edit may have mutated
      // the queue while the turn cancellation was in flight.
      const index = entry.queue.findIndex(
        (candidate) => candidate.id === entryId,
      );
      if (index < 0) {
        // The row was removed concurrently; still drain the head we just freed.
        this.scheduleDrain(target, entry, 0);
        return 'not_found';
      }
      if (
        this.entries.get(key) !== entry ||
        (entry.operationEpoch ?? 0) !== epoch ||
        entry.reservation !== undefined
      ) {
        return 'busy';
      }
      // Run now on a held row sends it with the live session's settings. The
      // saved request keeps the user's settings for a later turn.
      if (heldAtStart && !isGeneratedInputRequest(message.request)) {
        message.liveSessionSettings = true;
      }
      this.clearBackgroundWorkHold(entry, message.id);
      this.committedMessageFallbackRetries.delete(
        chatQueueRowKey(target, message.id),
      );
      entry.queue.splice(index, 1);
      delete entry.externalRetryParked;
      entry.recoveryInFlight = false;
      this.finishRecoveryWait(entry, wait);
      await this.dispatchDequeued(
        message,
        entry,
        (): void => {
          this.insertQueuedMessage(entry, message, index);
        },
        {
          type: 'force',
          request: message.request,
          ...(commandResult ? { commandResult } : {}),
        },
      );
      if (entry.creditHold === creditHoldAtStart) delete entry.creditHold;
      this.markSteeringEligibility(entry);
      return 'applied';
    } finally {
      entry.recoveryInFlight = false;
      this.finishRecoveryWait(entry, wait);
      if (this.getTurnPhase(target, entry) !== 'foreground')
        this.scheduleDrain(target, entry, 500);
      this.schedulePendingGeneratedSteering(entry);
    }
  }

  /**
   * Recompute whether the chat's current settings would restart its session
   * while native background work is live (`restartHeldByBackgroundWork`).
   * Settings setters call this after persisting a change.
   */
  public refreshRestartHold(target: ChatQueueTarget): void {
    const key = chatQueueKey(target);
    const existingEntry = this.entries.get(key);
    if (
      existingEntry?.frozenForDeletion === true ||
      existingEntry?.discardedForDeletion === true
    ) {
      return;
    }
    // A settings change can happen before a user has queued anything for this
    // chat. Still publish its derived composer flag on the first refresh.
    this.getOrCreateEntry(target);
    const existing = this.restartHoldRefreshes.get(key);
    if (existing) {
      existing.revision += 1;
      return;
    }
    const state: RestartHoldRefreshState = { revision: 1 };
    this.restartHoldRefreshes.set(key, state);
    void this.refreshRestartHoldUntilCurrent(target, key, state);
  }

  private async refreshRestartHoldUntilCurrent(
    target: ChatQueueTarget,
    key: string,
    state: RestartHoldRefreshState,
  ): Promise<void> {
    try {
      while (this.restartHoldRefreshes.get(key) === state) {
        const revision = state.revision;
        const entryAtStart = this.entries.get(key);
        if (
          !entryAtStart ||
          entryAtStart.frozenForDeletion === true ||
          entryAtStart.discardedForDeletion === true
        ) {
          return;
        }
        let restartHeld = false;
        // Each row dispatches its own saved request, so each is judged on it.
        const rowChanges = new Map<string, SettingsHeldChange[]>();
        try {
          if (this.hasNativeBackgroundWork(target)) {
            const persistedOptions = this.dependencies.readPersistedTabOptions
              ? await this.dependencies.readPersistedTabOptions(target)
              : await this.readPersistedTabOptions(target);
            const settingsRequest: ChatSendMessageRequest = {
              ...target,
              userMessageId: 'chat-queue-restart-hold-refresh',
              text: '',
              ...persistedOptions,
            };
            const decision = await (this.dependencies.decideTurnSessionReuse?.(
              settingsRequest,
            ) ?? turnSessionReuse.decideTurnSessionReuse(settingsRequest));
            restartHeld =
              this.hasNativeBackgroundWork(target) &&
              (this.dependencies.holdsForBackgroundWork?.(target, decision) ??
                turnSessionReuse.holdsForBackgroundWork(target, decision));
            // Mirrors dispatch: generated input runs on the live settings.
            for (const message of [...entryAtStart.queue]) {
              if (
                isInternalChatRequest(message.request) ||
                isGeneratedInputRequest(message.request)
              )
                continue;
              const rowDecision =
                await (this.dependencies.decideTurnSessionReuse?.(
                  message.request,
                ) ?? turnSessionReuse.decideTurnSessionReuse(message.request));
              if (
                this.hasNativeBackgroundWork(target) &&
                (this.dependencies.holdsForBackgroundWork?.(
                  target,
                  rowDecision,
                ) ??
                  turnSessionReuse.holdsForBackgroundWork(target, rowDecision))
              )
                rowChanges.set(
                  message.id,
                  turnSessionReuse.settingsHeldChanges(rowDecision),
                );
            }
          }
        } catch (error) {
          // This field is advisory only. Settings reads must never fail a send
          // or the queue if the target was deleted or the tab is unavailable.
          logMainProcessWarn(
            '[chat-queue] Could not refresh native background-work restart hold:',
            error,
          );
          restartHeld = false;
        }
        if (state.revision !== revision) continue;
        // Re-read after the awaits: deletion can start while settings load.
        if (
          this.entries.get(key) === entryAtStart &&
          !isEntryBeingDeleted(entryAtStart)
        ) {
          const previouslyHeld =
            entryAtStart.restartHeldByBackgroundWork === true;
          let changed = previouslyHeld !== restartHeld;
          if (restartHeld) entryAtStart.restartHeldByBackgroundWork = true;
          else delete entryAtStart.restartHeldByBackgroundWork;
          for (const message of entryAtStart.queue) {
            const next = rowChanges.get(message.id);
            if (message.restartHeldChanges?.join() === next?.join()) continue;
            changed = true;
            if (next) message.restartHeldChanges = next;
            else delete message.restartHeldChanges;
          }
          if (changed) this.broadcastBestEffort(target, entryAtStart, false);
        }
        return;
      }
    } catch (error) {
      // The refresh is deliberately best-effort and has no effect on dispatch.
      logMainProcessWarn(
        '[chat-queue] Could not refresh native background-work restart hold:',
        error,
      );
    } finally {
      if (this.restartHoldRefreshes.get(key) === state)
        this.restartHoldRefreshes.delete(key);
    }
  }

  private async readPersistedTabOptions(
    target: ChatQueueTarget,
  ): Promise<Partial<ChatSendMessageRequest>> {
    // Use the same metadata-only tab projection as watcher delivery. Keeping
    // this import lazy prevents the queue/chat-service construction cycle.
    const { buildExistingTabDispatchOptions } = await import('./chat-service');
    return buildExistingTabDispatchOptions(
      target.projectId,
      target.worktreeId,
      target.chatId,
    );
  }

  /** Live native-task notifications are queue wakeups, not managed delegation events. */
  public onNativeBackgroundWorkChanged(sessionKey: string): void {
    for (const entry of Array.from(this.entries.values())) {
      const target = entry.target;
      if (
        buildChatSessionKey(
          target.projectId,
          target.worktreeId,
          target.chatId,
        ) !== sessionKey
      ) {
        continue;
      }
      this.refreshRestartHold(target);
      if (!this.hasNativeBackgroundWork(target)) {
        if (this.clearBackgroundWorkHold(entry))
          this.broadcastBestEffort(target, entry, false);
      }
      if (
        entry.queue.length > 0 &&
        !this.isBackgroundWorkHoldActive(target, entry) &&
        !entry.dispatchInFlight &&
        !entry.recoveryInFlight &&
        this.getTurnPhase(target, entry) !== 'foreground'
      ) {
        this.scheduleDrain(target, entry, 0);
      }
    }
  }

  public invalidatePendingInputOperations(target: ChatQueueTarget): void {
    const key = chatQueueKey(target);
    const entry = this.getOrCreateEntry(target);
    entry.operationEpoch = (entry.operationEpoch ?? 0) + 1;
    delete entry.revivalLeaseRootId;
    delete entry.revivalTerminalReleaseRootId;
    this.pendingInertRevivalLeases.delete(key);
  }

  public releaseInputOwnership(target: ChatQueueTarget): void {
    const entry = this.entries.get(chatQueueKey(target));
    if (entry) this.releaseUnownedTurnGate(target, entry);
    if (entry) this.markSteeringEligibility(entry);
    if (
      !entry ||
      this.getTurnPhase(target, entry) === 'foreground' ||
      entry.dispatchInFlight ||
      entry.recoveryInFlight ||
      entry.authenticationPause !== undefined ||
      entry.worktreeSetupHold !== undefined ||
      entry.queue.length === 0 ||
      entry.drainTimer
    ) {
      return;
    }
    this.scheduleDrain(target, entry, 0);
  }

  public async steer(
    target: ChatQueueTarget,
    entryId: string,
    receipt: ChatQueueCommandResult,
    guard?: ChatQueueEntryGuard,
  ): Promise<ChatQueueMutationResult> {
    const entry = this.entries.get(chatQueueKey(target));
    const index =
      entry?.queue.findIndex((message) => message.id === entryId) ?? -1;
    if (!entry || index < 0) return 'not_found';
    const message = entry.queue[index];
    if (
      entry.recoveryInFlight ||
      !canSteerQueuedMessage(entry, message, this.getTurnPhase(target, entry))
    )
      return 'busy';
    delete entry.externalRetryParked;
    const operationEpoch = entry.operationEpoch ?? 0;
    if (
      message.request.agentSendSetup &&
      (await agentSendTargetReadiness(message.request)) === 'pending'
    )
      return 'busy';
    await revalidateAgentSenderRequest(message.request);
    if (receipt.agentSteeringActor)
      await revalidateAgentSteeringActor(
        receipt.agentSteeringActor,
        target.projectId,
        message.request.agentSenderProvenance,
      );
    // The awaits above let a cancel or drain move rows; re-find by identity.
    const current = entry.queue.indexOf(message);
    if (this.entries.get(chatQueueKey(target)) !== entry || current < 0)
      return 'not_found';
    if (
      entry.recoveryInFlight ||
      !canSteerQueuedMessage(entry, message, this.getTurnPhase(target, entry))
    )
      return 'busy';
    if (isStaleEntry(message, guard)) return 'conflict';
    entry.recoveryInFlight = true;
    const wait = this.beginRecoveryWait(entry, 'chat_queue.steer_queued');
    entry.queue.splice(current, 1);
    this.clearBackgroundWorkHold(entry, message.id);
    let claimed = false;
    let restoredDurably = false;
    let suppressDrain = false;
    try {
      // Lazy by design: chat-state constructs and calls this queue singleton,
      // so a static reverse import would create an initialization cycle. The
      // packaged Electron main build exercises this local import path.
      wait.phase('chat_state_import');
      const { getChatStateService } = await import('./chat-state-service');
      wait.phase('steer_queued_input');
      await getChatStateService().inputDelivery.steerQueued(
        message.request,
        () => entry.queue.map((r) => r.id),
        { ...receipt, outcome: 'applied', entityId: target.chatId },
        () => {
          claimed = true;
          // Durable ownership has moved to input delivery. Release the queue
          // operation before provider submission so a proven rejection can
          // restore this same row as ordinary queued input.
          entry.recoveryInFlight = false;
          this.finishRecoveryWait(entry, wait);
          this.broadcastBestEffort(target, entry);
        },
        message.origin,
      );
      return 'applied';
    } catch (error) {
      if (!claimed) {
        if (entry.discardedForDeletion !== true)
          this.insertQueuedMessage(entry, message, current);
        const epochUnchanged = (entry.operationEpoch ?? 0) === operationEpoch;
        const ordinaryFallback =
          hasOrdinarySteerFallback(error) &&
          epochUnchanged &&
          entry.frozenForDeletion !== true &&
          entry.discardedForDeletion !== true;
        if (!epochUnchanged) suppressDrain = true;
        try {
          if (entry.discardedForDeletion !== true) {
            wait.phase('restore_queue_persistence');
            const persistence = this.broadcast(target, entry);
            if (persistence) await persistence;
            restoredDurably = true;
          }
        } catch (persistenceError) {
          suppressDrain = true;
          if (ordinaryFallback) throw persistenceError;
          logMainProcessWarn(
            '[chat-queue] Could not durably restore queued input after Steer refusal:',
            persistenceError,
          );
        }
        if (ordinaryFallback) {
          if (
            (entry.operationEpoch ?? 0) !== operationEpoch ||
            entry.frozenForDeletion === true ||
            entry.discardedForDeletion === true
          ) {
            suppressDrain = true;
            return 'busy';
          }
          // The row is back in the durable queue and the preclaim refusal is
          // proven non-delivery. Release only this recovery operation: the
          // row is sent now if no turn holds the gate, or at that turn's
          // terminal.
          suppressDrain = false;
          return 'applied';
        }
        if (hasOrdinarySteerFallback(error)) {
          suppressDrain = true;
          return 'busy';
        }
      }
      throw error;
    } finally {
      entry.recoveryInFlight = false;
      this.finishRecoveryWait(entry, wait);
      this.broadcastBestEffort(target, entry, restoredDurably);
      if (!suppressDrain && this.getTurnPhase(target, entry) !== 'foreground')
        this.scheduleDrain(target, entry, 0);
      this.schedulePendingGeneratedSteering(entry);
    }
  }

  private isQueueEntryClosing(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): boolean {
    return (
      this.entries.get(chatQueueKey(target)) !== entry ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true
    );
  }

  public async restoreWithdrawnInput(
    request: ChatSendMessageRequest,
    rowId: string,
    receipt: ChatQueueCommandResult | undefined,
    epoch: number,
    origin: ChatQueueOrigin = 'desktop',
    restoredAsyncQuestionId?: string,
    options?: {
      ordinaryOnly?: boolean;
      waitForQueue?: boolean;
      allowUncertain?: true;
      continuation?: { attemptId: string; epoch: number };
    },
  ): Promise<void> {
    const restorationKey = `${chatQueueKey(request)}:${rowId}:${receipt?.commandId ?? ''}`;
    const existing = this.inputRestorations.get(restorationKey);
    if (existing) {
      await existing;
      return;
    }
    const restoration = this.restoreWithdrawnInputOnce(
      request,
      rowId,
      receipt,
      epoch,
      origin,
      restoredAsyncQuestionId,
      options,
    );
    this.inputRestorations.set(restorationKey, restoration);
    try {
      await restoration;
    } finally {
      if (this.inputRestorations.get(restorationKey) === restoration) {
        this.inputRestorations.delete(restorationKey);
      }
    }
  }

  public async consumeRestoredInput(
    target: ChatQueueTarget,
    rowId: string,
  ): Promise<void> {
    const restorationPrefix = `${chatQueueKey(target)}:${rowId}:`;
    const matchingRestorations = Array.from(this.inputRestorations.entries())
      .filter(([key]) => key.startsWith(restorationPrefix))
      .map(([, restoration]) => restoration);
    await Promise.all(matchingRestorations);

    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return;
    const index = entry.queue.findIndex((message) => message.id === rowId);
    if (index < 0) {
      entry.persistedInputIds.delete(rowId);
      return;
    }
    if (entry.recoveryInFlight || entry.dispatchInFlight) {
      throw new Error('Another message operation is in progress');
    }
    const previousHeadId = entry.queue[0]?.id;
    const [message] = entry.queue.splice(index, 1);
    if (!message) return;
    entry.recoveryInFlight = true;
    const wait = this.beginRecoveryWait(entry, 'chat_queue.consume_restored');
    try {
      wait.phase('queue_persistence');
      const persistence = this.broadcast(target, entry, {
        type: 'consume-restored-input',
        request: message.request,
      });
      if (persistence) await persistence;
      entry.persistedInputIds.delete(rowId);
      this.releaseWatcherAuthority(message.request);
      this.committedMessageFallbackRetries.delete(
        chatQueueRowKey(target, rowId),
      );
      this.clearBackgroundWorkHold(entry, rowId);
      if (entry.queue[0]?.id !== previousHeadId)
        delete entry.externalRetryParked;
    } catch (error) {
      this.insertQueuedMessage(entry, message, index);
      throw error;
    } finally {
      entry.recoveryInFlight = false;
      this.finishRecoveryWait(entry, wait);
      this.broadcastBestEffort(target, entry);
      this.schedulePendingGeneratedSteering(entry);
    }
  }

  private async restoreWithdrawnInputOnce(
    request: ChatSendMessageRequest,
    rowId: string,
    receipt: ChatQueueCommandResult | undefined,
    epoch: number,
    origin: ChatQueueOrigin,
    restoredAsyncQuestionId: string | undefined,
    options:
      | {
          ordinaryOnly?: boolean;
          waitForQueue?: boolean;
          allowUncertain?: true;
          continuation?: { attemptId: string; epoch: number };
        }
      | undefined,
  ): Promise<void> {
    const entry = this.getOrCreateEntry(request);
    if (entry.frozenForDeletion) throw new Error('Chat is closing');
    if (entry.queue.some((message) => message.id === rowId)) return;
    const waitForQueue = options?.waitForQueue === true;
    const maxWaits = QUEUE_RESTORE_WAIT_MAX_MS / QUEUE_RESTORE_WAIT_RETRY_MS;
    let waits = 0;
    const wait = this.beginRecoveryWait(
      entry,
      'chat_queue.restore_withdrawn',
      undefined,
      { claim: false },
    );
    wait.phase('queue_wait');
    while (entry.recoveryInFlight || entry.dispatchInFlight) {
      if (!waitForQueue) {
        wait.finish('failed');
        throw new Error('Another message operation is in progress');
      }
      if (waits >= maxWaits) {
        wait.finish('failed');
        throw new Error('Another message operation is in progress');
      }
      if (this.isQueueEntryClosing(request, entry)) {
        wait.finish('failed');
        throw new Error('Chat is closing');
      }
      await new Promise<void>((resolve) => {
        this.dependencies.schedule(resolve, QUEUE_RESTORE_WAIT_RETRY_MS);
      });
      waits += 1;
    }
    if (waitForQueue && this.isQueueEntryClosing(request, entry)) {
      wait.finish('failed');
      throw new Error('Chat is closing');
    }
    // Another restore of this row may have landed while this one waited.
    if (waits > 0 && entry.queue.some((message) => message.id === rowId)) {
      wait.finish('completed');
      return;
    }
    entry.recoveryInFlight = true;
    entry.recoveryWait = wait;
    wait.claim();
    const message: HostQueuedMessage = {
      id: rowId,
      request,
      origin,
      enqueuedAtMs: this.dependencies.now(),
      ...(options?.ordinaryOnly === true ? { ordinaryOnly: true } : {}),
    };
    const previousHeadId = entry.queue[0]?.id;
    this.insertQueuedMessage(entry, message);
    try {
      if (request.watcherFired && request.watcherDeliveryId) {
        wait.phase('watcher_ingress');
        const check = await this.dependencies.checkWatcherIngress?.(request);
        if (check && !check.allowed) {
          message.watcherDeliveryHeld = {
            outcome: check.outcome,
            reason: check.reason,
          };
        }
      }
      wait.phase('queue_persistence');
      await this.broadcast(request, entry, {
        type: 'restore-input',
        rowId,
        request,
        epoch,
        ...(options?.ordinaryOnly === true ? { ordinaryOnly: true } : {}),
        ...(options?.allowUncertain === true ? { allowUncertain: true } : {}),
        ...(options?.continuation
          ? { continuation: options.continuation }
          : {}),
        ...(restoredAsyncQuestionId ? { restoredAsyncQuestionId } : {}),
        ...(receipt ? { commandResult: receipt } : {}),
      });
      if (entry.queue[0]?.id !== previousHeadId)
        delete entry.externalRetryParked;
    } catch (error) {
      entry.queue = entry.queue.filter((r) => r !== message);
      throw error;
    } finally {
      entry.recoveryInFlight = false;
      this.finishRecoveryWait(entry, wait);
      if (this.entries.get(chatQueueKey(request)) === entry) {
        this.broadcastBestEffort(request, entry, false);
        this.schedulePendingGeneratedSteering(entry);
      }
    }
    entry.persistedInputIds.add(rowId);
    if (message.watcherDeliveryHeld) {
      this.splitHeldWatcherRow(message, entry);
      await this.persistRestoredQueueUntilDurable(request, entry);
    }
    this.armHeldWatcherRetry(request, entry);
    if (this.getTurnPhase(request, entry) !== 'foreground')
      this.scheduleDrain(request, entry, 0);
    if (options?.ordinaryOnly !== true && isGeneratedInputRequest(request))
      this.markSteeringEligibility(entry);
  }

  public hydratePersistedInput(
    request: ChatSendMessageRequest,
    rowId: string,
    origin: ChatQueueOrigin,
    enqueuedAtMs: number,
    authenticationAttemptId?: string,
    requiredAccountProxyConnectionId?: string,
    options?: {
      atHead?: boolean;
      ordinaryOnly?: boolean;
      creditRefused?: boolean;
      revision?: number;
    },
  ): void {
    assertValidQueueDispatchOptions({ requiredAccountProxyConnectionId });
    const entry = this.getOrCreateEntry(request);
    if (authenticationAttemptId)
      entry.authenticationPause = authenticationAttemptId;
    if (options?.creditRefused && !entry.creditHold)
      entry.creditHold = { funded: false };
    if (
      entry.persistedInputIds.has(rowId) ||
      entry.dispatching?.id === rowId ||
      entry.queue.some((message) => message.id === rowId)
    )
      return;
    entry.persistedInputIds.add(rowId);
    // A row recovered mid-dispatch was already the head of the queue.
    const previousHeadId = entry.queue[0]?.id;
    this.insertQueuedMessage(
      entry,
      {
        id: rowId,
        request,
        origin,
        enqueuedAtMs,
        ...(options?.ordinaryOnly === true ? { ordinaryOnly: true } : {}),
        ...(requiredAccountProxyConnectionId !== undefined
          ? { requiredAccountProxyConnectionId }
          : {}),
        ...(options?.revision !== undefined &&
        Number.isSafeInteger(options.revision) &&
        options.revision > 1
          ? { revision: options.revision }
          : {}),
      },
      options?.atHead ? 0 : undefined,
    );
    if (entry.queue[0]?.id !== previousHeadId) {
      delete entry.externalRetryParked;
    }
    if (options?.ordinaryOnly !== true && isGeneratedInputRequest(request))
      this.markSteeringEligibility(entry);
  }

  public async setEditLock(
    target: ChatQueueTarget,
    entryId: string,
    locked: boolean,
    acquisitionId?: string,
    guard?: ChatQueueEntryGuard,
  ): Promise<ChatQueueMutationResult> {
    const entry = this.entries.get(chatQueueKey(target));
    const message = entry?.queue.find((candidate) => candidate.id === entryId);
    if (!entry || !message) {
      if (locked)
        throw new Error('This message is no longer available to edit.');
      return 'applied';
    }
    if (
      !locked &&
      acquisitionId !== undefined &&
      this.editLockOwners.get(message) !== acquisitionId
    )
      return 'applied';
    if (entry.recoveryInFlight)
      throw new Error('Another message operation is in progress');
    if (locked && isStaleEntry(message, guard)) return 'conflict';
    if (locked && message.editLocked) {
      // Repeating a lock is safe for the acquisition that holds it (CAN-4112).
      if (
        acquisitionId !== undefined &&
        this.editLockOwners.get(message) === acquisitionId
      ) {
        // A repeat answers only once the original acquisition is saved.
        await this.editLockSaves.get(message)?.catch(() => undefined);
        if (
          this.entries.get(chatQueueKey(target)) === entry &&
          entry.queue.includes(message) &&
          message.editLocked &&
          this.editLockOwners.get(message) === acquisitionId
        )
          return 'applied';
      }
      throw new Error('This message is no longer available to edit.');
    }
    const attempt = Symbol(entryId);
    if (locked && acquisitionId !== undefined)
      this.editLockOwners.set(message, acquisitionId);
    else this.editLockOwners.delete(message);
    if (locked) this.editLockAttempts.set(message, attempt);
    else this.editLockAttempts.delete(message);
    let undoConsolidation: (() => void) | undefined;
    if (locked) message.editLocked = true;
    else {
      delete message.editLocked;
      undoConsolidation = this.consolidateNextWatcherRow(entry, message);
    }
    try {
      const persistence = this.broadcast(target, entry);
      if (locked && persistence) this.editLockSaves.set(message, persistence);
      if (persistence) await persistence;
    } catch (error) {
      if (locked && this.editLockAttempts.get(message) === attempt) {
        this.editLockAttempts.delete(message);
        this.editLockOwners.delete(message);
        delete message.editLocked;
        // A drain that ran while this lock was pending skipped the head.
        if (
          this.entries.get(chatQueueKey(target)) === entry &&
          this.getTurnPhase(target, entry) !== 'foreground' &&
          entry.queue[0] === message
        )
          this.scheduleDrain(target, entry, 0);
      }
      undoConsolidation?.();
      this.broadcastBestEffort(target, entry);
      throw error;
    }
    // Persistence can finish after removal, an edit, or cancellation. A
    // successful acquisition must still refer to a live, locked queue row.
    if (
      locked &&
      (this.entries.get(chatQueueKey(target)) !== entry ||
        this.editLockAttempts.get(message) !== attempt ||
        !entry.queue.some(
          (candidate) => candidate.id === entryId && candidate.editLocked,
        ))
    ) {
      throw new Error('This message is no longer available to edit.');
    }
    if (
      !locked &&
      this.getTurnPhase(target, entry) !== 'foreground' &&
      entry.queue[0]?.id === message.id
    ) {
      await this.drain(target, entry);
    }
    if (!locked) this.markSteeringEligibility(entry);
    return 'applied';
  }

  private consolidateNextWatcherRow(
    entry: ChatQueueEntry,
    message: HostQueuedMessage,
  ): (() => void) | undefined {
    const index = entry.queue.indexOf(message);
    const next = index >= 0 ? entry.queue[index + 1] : undefined;
    if (!next) return undefined;
    const combinedParts = mergeableWatcherParts(
      message,
      next,
      entry.steeringRowId,
    );
    if (!combinedParts) return undefined;

    const previousRequest = message.request;
    const previousParts = message.watcherParts;
    message.watcherParts = combinedParts;
    message.request = combinedWatcherRequest(message.request, combinedParts);
    entry.queue.splice(index + 1, 1);
    return (): void => {
      message.request = previousRequest;
      if (previousParts) message.watcherParts = previousParts;
      else delete message.watcherParts;
      entry.queue.splice(Math.min(index + 1, entry.queue.length), 0, next);
    };
  }

  /**
   * Keep host-owned queued sends aligned with a capability update. The
   * in-flight turn retains its immutable snapshot, while every prompt that
   * has not dispatched yet must use the newly approved selections.
   */
  public updateQueuedPluginSelections(
    target: ChatQueueTarget,
    pluginSelections: ChatSendMessageRequest['pluginSelections'],
    deferredToolsAllowed: ChatSendMessageRequest['deferredToolsAllowed'],
  ): void {
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return;
    entry.queue = entry.queue.map((message) =>
      isGeneratedInputRequest(message.request)
        ? message
        : {
            ...message,
            request: {
              ...message.request,
              pluginSelections,
              ...(typeof deferredToolsAllowed === 'boolean'
                ? { deferredToolsAllowed }
                : {}),
            },
          },
    );
    this.clearBackgroundWorkHold(entry);
    this.broadcastBestEffort(target, entry);
    this.markSteeringEligibility(entry);
    if (this.getTurnPhase(target, entry) !== 'foreground')
      void this.drain(target, entry);
  }

  public beginWorktreeDeletion(
    projectId: string,
    worktreeId: string,
  ): ChatQueueWorktreeDeletion {
    const prefix = `${projectId}/${worktreeId}/`;
    const frozen: Array<{
      key: string;
      chatId: string;
      entry: ChatQueueEntry;
    }> = [];
    this.entries.forEach((entry, key) => {
      if (!key.startsWith(prefix)) return;
      entry.frozenForDeletion = true;
      this.resetHeldWatcherRetry(entry);
      delete entry.backgroundWorkHold;
      delete entry.restartHeldByBackgroundWork;
      if (entry.drainTimer) {
        clearTimeout(entry.drainTimer);
        delete entry.drainTimer;
      }
      if (entry.steeringTimer) {
        clearTimeout(entry.steeringTimer);
        delete entry.steeringTimer;
      }
      this.clearGateReconciliationTimer(entry);
      frozen.push({ key, chatId: key.slice(prefix.length), entry });
    });

    let settled = false;
    return {
      commit: (): void => {
        if (settled) return;
        settled = true;
        for (const { key, chatId, entry } of frozen) {
          if (this.entries.get(key) !== entry) continue;
          delete entry.frozenForDeletion;
          entry.discardedForDeletion = true;
          entry.queue.forEach((message) => {
            this.committedMessageFallbackRetries.delete(`${key}:${message.id}`);
            this.releaseWatcherAuthority(message.request);
          });
          const discarded = entry.queue.map((message) => message.request);
          entry.queue = [];
          delete entry.backgroundWorkHold;
          delete entry.restartHeldByBackgroundWork;
          this.clearGateReconciliationTimer(entry);
          this.pendingInertRevivalLeases.delete(key);
          this.entries.delete(key);
          if (discarded.length > 0) {
            void this.dependencies
              .endDiscardedTurns?.({ projectId, worktreeId, chatId }, discarded)
              .catch((error: unknown) => {
                logMainProcessWarn(
                  '[chat-queue] Could not end the turns of discarded queued sends:',
                  error,
                );
              });
          }
        }
      },
      rollback: (options?: ChatQueueWorktreeDeletionRollbackOptions): void => {
        if (settled) return;
        settled = true;
        for (const { key, chatId, entry } of frozen) {
          if (this.entries.get(key) !== entry) continue;
          delete entry.frozenForDeletion;
          if (options?.sessionsDestroyed === true) {
            this.releaseTurnGate(entry);
            // A destroyed session can no longer deliver the untagged terminal
            // a Stop reservation waits for.
            if (entry.reservation?.kind === 'stop') delete entry.reservation;
          }
          const target = { projectId, worktreeId, chatId };
          this.armHeldWatcherRetry(target, entry);
          if (options?.sessionsDestroyed !== true && entry.turnActive) {
            const armedAtMs =
              entry.queueGateArmedAtMs ?? this.dependencies.now();
            const ageMs = Math.max(0, this.dependencies.now() - armedAtMs);
            this.scheduleStaleGateReconciliation(
              target,
              entry,
              Math.max(0, QUEUE_GATE_STALE_RECONCILE_MS - ageMs),
            );
          }
          this.broadcastBestEffort(target, entry);
          this.markSteeringEligibility(entry);
          if (
            this.getTurnPhase(target, entry) !== 'foreground' &&
            !entry.dispatchInFlight &&
            !entry.recoveryInFlight &&
            entry.queue.length > 0
          ) {
            this.scheduleDrain(target, entry, 0);
          }
        }
      },
    };
  }

  /** Test-only: drop all per-chat state and pending drain timers. */
  public resetForTests(): void {
    this.entries.forEach((entry) => {
      if (entry.drainTimer) clearTimeout(entry.drainTimer);
      this.clearGateReconciliationTimer(entry);
      if (entry.steeringTimer) clearTimeout(entry.steeringTimer);
      this.resetHeldWatcherRetry(entry);
    });
    this.entries.clear();
    this.pendingInertRevivalLeases.clear();
    this.committedMessageFallbackRetries.clear();
    this.activeInputHydrations.clear();
    this.inputRestorations.clear();
    this.restartHoldRefreshes.clear();
    this.ownershipHydrations.clear();
    this.ownershipSubscription?.dispose();
    delete this.ownershipSubscription;
    this.startupDrainHeld = false;
  }

  /** Whether this message is the chat's dispatching turn or a queued row. */
  public holdsUserMessage(
    target: ChatQueueTarget,
    userMessageId: string,
  ): boolean {
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return false;
    return (
      entry.activeTurnUserMessageId === userMessageId ||
      entry.queue.some(
        (message) => message.request.userMessageId === userMessageId,
      )
    );
  }

  /** The queued send the chat is handing to its provider, if any. */
  public dispatchingUserMessageId(target: ChatQueueTarget): string | undefined {
    const entry = this.entries.get(chatQueueKey(target));
    return entry?.dispatchInFlight ? entry.activeTurnUserMessageId : undefined;
  }

  /**
   * The user message id of the turn the chat is running: set when that turn
   * is dispatched, so a message queued behind it never changes it.
   */
  public runningTurnUserMessageId(target: ChatQueueTarget): string | undefined {
    return this.entries.get(chatQueueKey(target))?.activeTurnUserMessageId;
  }

  /**
   * Host-runtime liveness only: provider sessions, host-owned gates and
   * reservations. Restart reconciliation reads this, so hydrated canonical
   * ownership cannot hide an orphaned turn from its settlement.
   */
  public isTurnActive(target: ChatQueueTarget): boolean {
    const entry = this.entries.get(chatQueueKey(target));
    return (
      readChatTurnPhase({
        hasActiveProviderTurn: this.dependencies.hasActiveProviderTurn(target),
        hasPendingProviderContinuation:
          this.dependencies.hasPendingProviderContinuation(target),
        hasBackgroundWork:
          this.dependencies.hasBackgroundWork?.(target) ?? false,
        hostGateArmed:
          entry?.turnActive === true && entry.gateFromCanonical !== true,
        ...(entry?.reservation ? { reservation: entry.reservation } : {}),
      }).turnPhase === 'foreground'
    );
  }

  /** Host-owned automatic messages can be withdrawn before native dispatch. */
  public async cancelUserMessages(
    target: ChatQueueTarget,
    userMessageIds: readonly string[],
  ): Promise<void> {
    const ids = new Set(userMessageIds);
    const entry = this.entries.get(chatQueueKey(target));
    const matches =
      entry?.queue.filter((message) =>
        ids.has(message.request.userMessageId),
      ) ?? [];
    for (const message of matches) await this.cancel(target, message.id);
  }

  /** Withdraw one queued send before it starts, reporting the queue's result. */
  public async withdrawQueuedUserMessage(
    target: ChatQueueTarget,
    userMessageId: string,
  ): Promise<ChatQueueMutationResult> {
    const queued = this.entries
      .get(chatQueueKey(target))
      ?.queue.find(
        (message) => message.request.userMessageId === userMessageId,
      );
    return queued ? this.cancel(target, queued.id) : 'not_found';
  }

  public broadcastWorktree(projectId: string, worktreeId: string): void {
    const prefix = `${projectId}/${worktreeId}/`;
    this.entries.forEach((entry, key) => {
      if (!key.startsWith(prefix)) return;
      const chatId = key.slice(prefix.length);
      this.broadcastBestEffort({ projectId, worktreeId, chatId }, entry);
    });
  }

  /**
   * Race-free pull of the current queue snapshots for a worktree's chats.
   * The renderer requests this during hydration (request/response), so a
   * reloaded renderer recovers the live queue even though the push-based
   * `chatQueueUpdated` broadcast can fire before its listener is attached.
   */
  public getWorktreeSnapshots(
    projectId: string,
    worktreeId: string,
  ): ChatQueueUpdatedEvent[] {
    const prefix = `${projectId}/${worktreeId}/`;
    const snapshots: ChatQueueUpdatedEvent[] = [];
    this.entries.forEach((entry, key) => {
      if (!key.startsWith(prefix)) return;
      if (entry.queue.length === 0) return;
      const chatId = key.slice(prefix.length);
      snapshots.push(
        this.queueSnapshot({ projectId, worktreeId, chatId }, entry),
      );
    });
    return snapshots;
  }

  private getOrCreateEntry(target: ChatQueueTarget): ChatQueueEntry {
    const key = chatQueueKey(target);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: ChatQueueEntry = {
      target: {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
      },
      queue: [],
      persistedInputIds: new Set(),
      turnActive: false,
      dispatchInFlight: false,
      recoveryInFlight: false,
      currentGlobalPluginDefaultsRevision:
        this.dependencies.getCurrentPluginDefaultsRevision?.(target),
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** Funding only republishes eligibility; it never releases queued sends. */
  public async refreshCreditHolds(): Promise<void> {
    await Promise.all(
      Array.from(this.entries.values()).map((entry) =>
        this.refreshCreditHold(entry),
      ),
    );
  }

  private async refreshCreditHold(entry: ChatQueueEntry): Promise<void> {
    const hold = entry.creditHold;
    if (
      !hold ||
      entry.queue.length === 0 ||
      entry.discardedForDeletion ||
      entry.frozenForDeletion
    )
      return;
    if (hold.refresh) return hold.refresh;
    hold.refresh = (async (): Promise<void> => {
      let funded = false;
      try {
        funded =
          (await this.dependencies.readCreditFunding?.(entry.target)) === true;
      } catch {
        /* Unknown funding retains the hold. */
      }
      if (
        entry.creditHold !== hold ||
        this.entries.get(chatQueueKey(entry.target)) !== entry
      )
        return;
      if (hold.funded !== funded) {
        hold.funded = funded;
        this.broadcastBestEffort(entry.target, entry, false);
      }
    })();
    try {
      await hold.refresh;
    } finally {
      delete hold.refresh;
    }
  }

  private async drain(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): Promise<void> {
    // Startup recovery: drains wait for the core to accept (CAN-4112).
    if (this.startupDrainHeld) return;
    if (entry.creditHold) {
      await this.refreshCreditHold(entry);
      if (
        entry.creditHold &&
        !entry.creditHold.funded &&
        entry.queue.length > 0
      )
        this.scheduleDrain(target, entry, 5000);
      return;
    }
    // Releasing the setup hold schedules the drain again.
    if (entry.worktreeSetupHold !== undefined) return;
    if (entry.drainInFlight === true) {
      const inFlightGuard = this.initialDrainGuard(target, entry);
      if (inFlightGuard !== undefined) {
        this.recordDrainDecline(
          target,
          entry,
          inFlightGuard,
          this.wakeEventForDrainGuard(inFlightGuard),
          inFlightGuard === 'reservation' ||
            inFlightGuard === 'dispatch-in-flight' ||
            inFlightGuard === 'recovery-in-flight',
        );
      }
      entry.drainRequested = true;
      return;
    }
    entry.drainInFlight = true;
    try {
      this.clearResolvedDrainDeclines(target, entry);
      const initialGuard = this.initialDrainGuard(target, entry);
      if (initialGuard !== undefined) {
        this.recordDrainDecline(
          target,
          entry,
          initialGuard,
          this.wakeEventForDrainGuard(initialGuard),
          initialGuard === 'reservation' ||
            initialGuard === 'dispatch-in-flight' ||
            initialGuard === 'recovery-in-flight',
        );
        return;
      }
      if (entry.queue.length === 0) return;
      // Provider I/O can already be idle while its pickup/result events are
      // awaiting the durable reducer. Preserve that route until ingress settles.
      try {
        await this.dependencies.drainProviderEvents?.(target);
        if (this.entries.get(chatQueueKey(target)) !== entry) return;
      } catch (error) {
        if (this.entries.get(chatQueueKey(target)) !== entry) return;
        logMainProcessWarn(
          '[chat-queue] Could not settle provider events before dispatch:',
          error,
        );
        this.recordDrainDecline(
          target,
          entry,
          'backlog-wait-failed',
          undefined,
          true,
        );
        return;
      }
      // A refusal committed inside the event barrier must fence this drain too.
      if (entry.creditHold) return;
      this.clearDrainDecline(entry, 'backlog-wait-failed');
      this.clearResolvedDrainDeclines(target, entry);
      const postBarrierGuard = this.postBarrierDrainGuard(target, entry);
      if (postBarrierGuard !== undefined) {
        this.recordDrainDecline(
          target,
          entry,
          postBarrierGuard,
          this.wakeEventForDrainGuard(postBarrierGuard),
          postBarrierGuard === 'reservation' ||
            postBarrierGuard === 'dispatch-in-flight' ||
            postBarrierGuard === 'recovery-in-flight',
        );
        return;
      }
      if (
        entry.frozenForDeletion === true ||
        entry.discardedForDeletion === true ||
        entry.queue.length === 0
      ) {
        this.clearAllDrainDeclines(entry);
        return;
      }
      if (entry.worktreeSetupHold !== undefined) return;
      // A watcher input held for reauthorization waits for its retry.
      const index = entry.queue.findIndex(
        (candidate) => !candidate.watcherDeliveryHeld,
      );
      const message = entry.queue[index];
      if (!message) return;
      if (message.request.agentSendSetup) {
        try {
          await revalidateAgentSenderRequest(message.request);
          if ((await agentSendTargetReadiness(message.request)) === 'pending') {
            this.scheduleDrain(target, entry, 1000);
            return;
          }
        } catch {
          /* Dequeue persists typed cancellation for unavailable targets. */
        }
        if (
          entry.creditHold !== undefined ||
          this.postBarrierDrainGuard(target, entry) !== undefined ||
          entry.queue[index] !== message
        )
          return;
      }
      if (message.editLocked) return;
      // Passing the event barrier and dequeue guard is real queue progress; a
      // later independent blocker may now be diagnosed again.
      this.clearAllDrainDeclines(entry);
      const [dequeued] = entry.queue.splice(index, 1);
      if (!dequeued) {
        this.broadcastBestEffort(target, entry);
        return;
      }
      try {
        await this.dispatchDequeued(dequeued, entry, (): void => {
          this.insertQueuedMessage(entry, dequeued, index);
        });
      } catch {
        // Dispatch failures already reset turnActive in dispatchDequeued();
        // swallow so fire-and-forget drain callers never reject unhandled.
      }
    } finally {
      const drainRequested = entry.drainRequested === true;
      delete entry.drainRequested;
      delete entry.drainInFlight;
      if (drainRequested && entry.queue.length > 0) {
        this.scheduleDrain(target, entry, 0);
      }
    }
  }

  /** Restore innocent parts in source order; only the original watcher is held. */
  private splitHeldWatcherRow(
    message: HostQueuedMessage,
    entry: ChatQueueEntry,
  ): void {
    const parts = watcherPartsForMessage(message);
    if (
      !parts ||
      parts.length < 2 ||
      parts.some(
        (part) => part.request.consolidatedWatcherUserMessageIds !== undefined,
      )
    )
      return;
    const watcher = parts.find((part) => part.authority === 'watcher');
    const index = entry.queue.indexOf(message);
    if (!watcher || index < 0) return;
    const currentRequest = message.request;
    message.request = requestWithWatcherPartIdentity(
      currentRequest,
      watcher.request,
    );
    delete message.watcherParts;
    const restored = parts.map((part): HostQueuedMessage => {
      if (part === watcher) return message;
      let id = this.dependencies.createId();
      while (entry.persistedInputIds.has(id)) id = this.dependencies.createId();
      const row: HostQueuedMessage = {
        ...message,
        id,
        request: requestWithWatcherPartIdentity(currentRequest, part.request),
      };
      delete row.watcherDeliveryHeld;
      entry.persistedInputIds.add(row.id);
      return row;
    });
    entry.queue.splice(index, 1, ...restored);
  }

  /**
   * Atomically move a host-owned queued row into the active-turn state before
   * provider dispatch. If canonical persistence rejects, restore the row so a
   * transient journal failure cannot silently discard an undispatched prompt.
   */
  private async dispatchDequeued(
    message: HostQueuedMessage,
    entry: ChatQueueEntry,
    restore: () => void,
    mutation?: ChatQueuePersistenceMutation,
  ): Promise<void> {
    if (entry.reservation) {
      restore();
      return;
    }
    let providerDispatchStarted = false;
    let dispatchSucceeded = false;
    // Set for known pre-provider refusals below, and read by `finally` so it
    // does not re-arm a drain the catch deliberately declined to schedule.
    let waitsForExternalRetryTrigger = false;
    const dispatchOwner = Symbol('chat-queue-dispatch');
    let handedOff = false;
    const untaggedTerminalsAtStart = entry.untaggedTerminals ?? 0;
    entry.reservation = { kind: 'dispatch', owner: dispatchOwner };
    // The reservation keeps other dispatches out while watcher authority is
    // rechecked; a held row never arms the turn gate.
    if (message.request.watcherFired && message.request.watcherDeliveryId) {
      let check: Awaited<ReturnType<WatcherDeliveryIngressCheck>> | undefined;
      try {
        check = await this.dependencies.checkWatcherIngress?.(message.request);
      } catch (error) {
        if (entry.reservation?.owner === dispatchOwner)
          delete entry.reservation;
        restore();
        throw error;
      }
      if (check && !check.allowed) {
        message.watcherDeliveryHeld = {
          outcome: check.outcome,
          reason: check.reason,
        };
        if (entry.reservation?.owner === dispatchOwner)
          delete entry.reservation;
        restore();
        this.splitHeldWatcherRow(message, entry);
        this.armHeldWatcherRetry(message.request, entry);
        await this.persistRestoredQueueUntilDurable(message.request, entry);
        // A held row never blocks the input behind it.
        if (entry.queue.some((queued) => !queued.watcherDeliveryHeld))
          this.scheduleDrain(message.request, entry, 0);
        return;
      }
      delete message.watcherDeliveryHeld;
    }
    this.armTurnGate(
      message.request,
      entry,
      'queued-dispatch',
      message.request.userMessageId,
    );
    entry.currentGlobalPluginDefaultsRevision =
      this.dependencies.getCurrentPluginDefaultsRevision?.(message.request);
    entry.activePluginSelections = normalizePluginSelections(
      message.request.pluginSelections,
    );
    entry.activeGlobalPluginDefaultsRevision =
      entry.currentGlobalPluginDefaultsRevision;
    entry.dispatchInFlight = true;
    entry.dispatching = message;
    // Same Stop ownership as a direct send: it spans the durable dequeue.
    const preparation = this.dependencies.beginTurnPreparation?.(
      message.request,
    );
    try {
      // Persist queue removal and active-turn acquisition together. There must
      // never be a durable idle state in which the queued row is already gone.
      const persistence = this.broadcast(message.request, entry, mutation);
      if (persistence) await persistence;
      if (
        entry.authenticationPause !== undefined ||
        entry.worktreeSetupHold !== undefined ||
        entry.frozenForDeletion === true
      ) {
        this.releaseTurnGate(entry);
        delete entry.dispatching;
        restore();
        // The row is already back in memory. A journal failure here must not
        // escape into the outer catch, whose pre-dispatch recovery would run
        // `restore()` a second time and duplicate the same queued prompt.
        this.broadcastBestEffort(message.request, entry);
        return;
      }
      if (entry.discardedForDeletion === true) {
        this.releaseWatcherAuthority(message.request);
        return;
      }
      // This dispatch armed the gate for its own turn above; only another
      // turn's activity sends the row back.
      const activity = this.readTurnActivity(
        message.request,
        entry,
        dispatchOwner,
        message.request.userMessageId,
      );
      if (activity.turnPhase === 'foreground') {
        delete entry.dispatching;
        if (activity.hasForegroundProviderWork) {
          this.armTurnGate(message.request, entry, 'adopted-provider-activity');
          entry.activePluginSelections =
            this.dependencies.getActiveProviderPluginSelections?.(
              message.request,
            );
          entry.activeGlobalPluginDefaultsRevision =
            this.dependencies.getActiveProviderPluginDefaultsRevision?.(
              message.request,
            );
        } else if (
          entry.activeTurnUserMessageId === message.request.userMessageId
        ) {
          this.releaseTurnGate(entry);
        }
        if (entry.reservation?.owner === dispatchOwner)
          delete entry.reservation;
        restore();
        // As above, the row is back in memory: a journal failure must not
        // reach the outer catch and restore it a second time.
        this.broadcastBestEffort(message.request, entry);
        return;
      }
      if (
        message.request.agentSent ||
        message.request.agentSenderProvenance ||
        message.request.hiddenContext?.kind === 'agent-sender-context'
      )
        await revalidateAgentSenderRequest(message.request);
      if (message.request.watcherFired && message.request.watcherDeliveryId)
        await this.assertWatcherIngress(message.request);
      // Published only once admitted, so a blocked dequeue never flaps wake.
      const authorization = this.registerDispatchOwner(
        message.request,
        entry,
        dispatchOwner,
        message.request.userMessageId,
      );
      entry.creditRetryCandidate = message;
      providerDispatchStarted = true;
      const dispatchRequest: ChatSendMessageRequest =
        message.liveSessionSettings === true
          ? { ...message.request, useLiveSessionSettings: true }
          : message.request;
      const dispatchOptions = {
        requiredAccountProxyConnectionId:
          message.requiredAccountProxyConnectionId,
        ...(entry.creditHold?.funded === true
          ? { creditRetryAttemptId: this.dependencies.createId() }
          : {}),
      };
      const dispatchNow = (): ReturnType<
        ChatQueueServiceDependencies['dispatch']
      > =>
        this.dependencies.dispatch(
          dispatchRequest,
          message.origin,
          true,
          authorization,
          dispatchOptions,
        );
      const outcome = message.request.agentSenderProvenance
        ? await withAgentSenderAuthority(
            message.request,
            dispatchNow,
            revalidateAgentSenderRequest,
          )
        : await dispatchNow();
      handedOff =
        !outcome ||
        (await this.applyDispatchOutcome(
          message.request,
          entry,
          dispatchOwner,
          outcome,
          authorization,
          async (): Promise<void> => {
            delete entry.dispatching;
            restore();
            const persistence = this.broadcast(message.request, entry);
            if (persistence) await persistence;
          },
        ));
      // A refusal can follow a prompt this dispatch already committed: a
      // Stop invalidated the capability mid-preparation. Settle it as below.
      const refused = Boolean(outcome && outcome.kind === 'refused');
      if (!handedOff && !refused) return;
      const currentEntry = this.entries.get(chatQueueKey(message.request));
      if (
        isTurnPreparationCancelled(preparation) &&
        currentEntry === entry &&
        currentEntry.frozenForDeletion !== true &&
        currentEntry.discardedForDeletion !== true
      ) {
        if ((entry.untaggedTerminals ?? 0) === untaggedTerminalsAtStart) {
          entry.reservation = {
            kind: 'stop',
            owner: Symbol('chat-queue-stop'),
          };
        }
        // As with the initial send, acceptance can finish after Stop commits.
        await this.settleCancelledHandoffUntilDurable(
          message.request,
          entry,
          message.request.userMessageId,
        );
        // Stop reached this send before it started; nothing will start it.
        this.removeDispatchOwners(message.request, entry, {
          token: dispatchOwner,
        });
      }
      if (refused) return;
      dispatchSucceeded = true;
      this.watcherDispatchSucceeded(message.request, entry);
      delete entry.externalRetryParked;
      this.committedMessageFallbackRetries.delete(
        chatQueueRowKey(message.request, message.id),
      );
    } catch (error) {
      delete entry.dispatching;
      if (entry.reservation?.owner === dispatchOwner) {
        delete entry.reservation;
        this.releaseTurnGate(entry);
      } else if (entry.reservation?.kind !== 'stop') {
        this.releaseTurnGate(entry);
      }
      // The send-time auth preflight (CAN-1814) runs INSIDE
      // `dependencies.dispatch`, i.e. after `providerDispatchStarted` is
      // already true, so its refusal used to skip `restore()` entirely. The row
      // had been durably enqueued by `enqueueDurably` and was then durably
      // removed by the `broadcast(...)` above; `drain()`'s bare `catch {}`
      // swallowed the error and the user watched their typed follow-up vanish
      // with no card, no error, and no log (CAN-1814 review).
      //
      // The auth refusal and Auto model-application refusal are provably
      // PRE-dispatch: both run before `ensureChatForTrustedSend`, before the
      // user message is persisted, and before the session is created, so
      // nothing was sent and the row is safe to put back. They join
      // `isChatScopeDeletingError` for exactly that reason rather than widening
      // the flag itself —
      // `providerDispatchStarted` exists to stop a partially-sent prompt from
      // being re-sent, and it keeps that job for every other error.
      if (
        error instanceof WatcherDeliveryHeldError &&
        entry.discardedForDeletion !== true
      ) {
        message.watcherDeliveryHeld = {
          outcome: error.outcome,
          reason: error.reason,
        };
        restore();
        this.splitHeldWatcherRow(message, entry);
        this.armHeldWatcherRetry(message.request, entry);
        await this.persistRestoredQueueUntilDurable(message.request, entry);
        if (entry.queue.some((queued) => !queued.watcherDeliveryHeld))
          this.scheduleDrain(message.request, entry, 0);
        return;
      }
      if (
        isAgentSenderContextError(error) &&
        entry.discardedForDeletion !== true
      ) {
        if (
          error.code === 'target_not_ready' &&
          message.request.agentSendSetup &&
          (await agentSendTargetReadiness(message.request).catch(
            () => 'ready',
          )) === 'pending'
        ) {
          restore();
          await this.persistRestoredQueueUntilDurable(message.request, entry);
          this.scheduleDrain(message.request, entry, 1000);
          return;
        }
        // Sender/target authorization refusals are permanent. Persist cancellation
        // before releasing the next row; never restore this row to the FIFO head.
        await this.persistRestoredQueueUntilDurable(message.request, entry, {
          type: 'cancel',
          request: message.request,
          agentSendRefusalCode:
            error.code === 'authorization_conflict'
              ? 'owner_boundary'
              : error.code,
          lastErrorMessage:
            'The agent that sent this message can no longer reach this chat.',
        });
        this.releaseWatcherAuthority(message.request);
        return;
      }
      const refusedByAuthPreflight = isTurnAuthPreflightRefusal(error);
      const autoModelApplyFailed = isAutoModelRoutingApplyError(error);
      const autoModelRoutingInProgress = isAutoModelRoutingInProgressError(
        error,
      )
        ? error
        : undefined;
      const refusedByBackgroundWork =
        turnSessionReuse.isTurnHeldForBackgroundWorkError(error);
      const retiredChatScope = error instanceof RetiredChatScopeError;
      waitsForExternalRetryTrigger =
        refusedByAuthPreflight ||
        autoModelApplyFailed ||
        refusedByBackgroundWork;
      let shouldRestore =
        (!providerDispatchStarted ||
          waitsForExternalRetryTrigger ||
          autoModelRoutingInProgress !== undefined ||
          isChatScopeDeletingError(error)) &&
        entry.discardedForDeletion !== true;
      let restoredByCommittedMessageFallback = false;
      if (
        !shouldRestore &&
        !retiredChatScope &&
        entry.discardedForDeletion !== true &&
        this.dependencies.hasCommittedMessage
      ) {
        let promptCommitted = false;
        try {
          promptCommitted = await this.dependencies.hasCommittedMessage(
            message.request,
            message.request.userMessageId,
          );
        } catch {
          // A failed transcript read cannot prove that the accepted prompt
          // committed, so retain it for recovery rather than dropping it.
        }
        if (!promptCommitted) {
          shouldRestore = true;
          restoredByCommittedMessageFallback = true;
        }
      }
      let committedMessageFallbackRetryDelayMs: number | undefined;
      let committedMessageFallbackRetryCapped = false;
      if (restoredByCommittedMessageFallback) {
        const rowKey = chatQueueRowKey(message.request, message.id);
        const retriesScheduled =
          this.committedMessageFallbackRetries.get(rowKey) ?? 0;
        if (retriesScheduled >= QUEUE_COMMIT_FALLBACK_MAX_AUTOMATIC_RETRIES) {
          committedMessageFallbackRetryCapped = true;
          waitsForExternalRetryTrigger = true;
        } else {
          committedMessageFallbackRetryDelayMs = Math.min(
            500 * 2 ** retriesScheduled,
            QUEUE_COMMIT_FALLBACK_MAX_RETRY_MS,
          );
          this.committedMessageFallbackRetries.set(
            rowKey,
            retriesScheduled + 1,
          );
        }
      } else if (!shouldRestore) {
        // A committed prompt or a permanent refusal drops this row.
        this.committedMessageFallbackRetries.delete(
          chatQueueRowKey(message.request, message.id),
        );
      }
      if (shouldRestore) {
        restore();
        logMainProcessWarn(
          refusedByAuthPreflight
            ? '[chat-queue] Retaining queued message refused by the authentication preflight:'
            : refusedByBackgroundWork
              ? '[chat-queue] Retaining queued message while native background work is live:'
              : autoModelApplyFailed
                ? '[chat-queue] Retaining queued Auto message after its routed model could not be applied:'
                : autoModelRoutingInProgress
                  ? '[chat-queue] Retaining queued Auto message while its routing decision is still in progress:'
                  : !providerDispatchStarted
                    ? '[chat-queue] Retaining queued message after dispatch failed before provider start:'
                    : committedMessageFallbackRetryCapped
                      ? '[chat-queue] Retaining queued message after dispatch failed before prompt commit; waiting for a retry trigger:'
                      : '[chat-queue] Retaining queued message after dispatch failed before prompt commit:',
          error,
        );
      }
      if (!shouldRestore) this.releaseWatcherAuthority(message.request);
      if (entry.discardedForDeletion !== true) {
        const restorationPersisted = shouldRestore
          ? await this.persistRestoredQueueUntilDurable(message.request, entry)
          : false;
        if (!shouldRestore) {
          // The dropped row will never run; settle its agent acceptance row.
          if (message.request.agentSenderProvenance)
            await this.persistRestoredQueueUntilDurable(
              message.request,
              entry,
              {
                type: 'settle-agent-input',
                request: message.request,
                reason: error instanceof Error ? error.message : String(error),
              },
            );
          else this.broadcastBestEffort(message.request, entry);
        }
        if (restorationPersisted && refusedByBackgroundWork) {
          // A Run now that is still held (an account, owner or routing
          // change) goes back to waiting; the user can choose again.
          delete message.liveSessionSettings;
          waitsForExternalRetryTrigger = this.markBackgroundWorkHold(
            message.request,
            entry,
            message.id,
          );
        }
        if (
          restorationPersisted &&
          waitsForExternalRetryTrigger &&
          !refusedByBackgroundWork
        ) {
          entry.externalRetryParked = true;
          if (entry.drainTimer !== undefined) {
            clearTimeout(entry.drainTimer);
            delete entry.drainTimer;
          }
          delete entry.drainTimerDueAtMs;
        }
        if (
          restorationPersisted &&
          refusedByBackgroundWork &&
          !waitsForExternalRetryTrigger
        ) {
          // Work ended between the dispatch adapter's guard and our catch.
          // Do not create a stale hold or wait out a retry delay; run one fresh
          // guarded dispatch against the now-current native-work state.
          this.scheduleDrain(message.request, entry, 0);
        }
        // Authentication and model-application refusals wait for an external
        // trigger because an immediate redrain would repeat the same failure.
        // Commit-probe fallback restores retry with bounded exponential delays,
        // then wait for an external trigger rather than retrying forever.
        // An active routing decision is different: the server supplies a
        // bounded retry delay and the same durable request ID replays safely.
        //
        // NOT on reconnect, despite the obvious guess. The OAuth settle
        // listener reaches the queue only via `resumeChatsAfterMcpOAuthSuccess`
        // -> `sendWorktreeChatMessage` -> `submit`, and that runs only for a
        // chat that has a `PendingAuthResume` — i.e. one whose turn this
        // failure actually stopped. A chat whose turn ended normally while the
        // credential lapsed keeps its refused row until the user acts. Visible
        // and user-actionable, so a stall rather than a loss (CAN-1814 review).
        if (
          restorationPersisted &&
          !waitsForExternalRetryTrigger &&
          !refusedByBackgroundWork
        ) {
          this.scheduleDrain(
            message.request,
            entry,
            autoModelRoutingInProgress
              ? autoModelRoutingInProgress.retryAfterMs
              : (committedMessageFallbackRetryDelayMs ?? 500),
          );
        }
      }
      throw error;
    } finally {
      delete entry.dispatching;
      if (entry.reservation?.owner === dispatchOwner) delete entry.reservation;
      // Only an accepted hand-off keeps its D; it then waits for its start.
      if (!handedOff)
        this.removeDispatchOwners(message.request, entry, {
          token: dispatchOwner,
        });
      preparation?.finish();
      entry.dispatchInFlight = false;
      this.schedulePendingGeneratedSteering(entry);
      if (
        this.entries.get(chatQueueKey(message.request)) === entry &&
        entry.frozenForDeletion !== true &&
        entry.discardedForDeletion !== true
      ) {
        this.broadcastBestEffort(message.request, entry, dispatchSucceeded);
      }
      if (
        !waitsForExternalRetryTrigger &&
        entry.frozenForDeletion !== true &&
        entry.discardedForDeletion !== true &&
        this.getTurnPhase(message.request, entry) !== 'foreground' &&
        !entry.recoveryInFlight &&
        entry.queue.some((queued) => !queued.watcherDeliveryHeld) &&
        !entry.drainTimer
      ) {
        this.scheduleDrain(message.request, entry, 0);
      }
      this.refreshRestartHold(message.request);
    }
  }

  private async settleCancelledHandoffUntilDurable(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    turnUserMessageId: string,
  ): Promise<void> {
    let retryDelayMs = QUEUE_PERSISTENCE_RETRY_MIN_MS;
    while (
      this.entries.get(chatQueueKey(target)) === entry &&
      entry.frozenForDeletion !== true &&
      entry.discardedForDeletion !== true
    ) {
      try {
        await this.dependencies.settleCancelledTurn(target, turnUserMessageId);
        return;
      } catch (error) {
        logMainProcessWarn(
          '[chat-queue] Retrying stopped handoff settlement before next dispatch:',
          error,
        );
        await new Promise<void>((resolve) => {
          this.dependencies.schedule(resolve, retryDelayMs);
        });
        retryDelayMs = Math.min(
          retryDelayMs * 2,
          QUEUE_PERSISTENCE_RETRY_MAX_MS,
        );
      }
    }
  }

  private async persistRestoredQueueUntilDurable(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    mutation?: ChatQueuePersistenceMutation,
  ): Promise<boolean> {
    let retryDelayMs = QUEUE_PERSISTENCE_RETRY_MIN_MS;
    while (
      this.entries.get(chatQueueKey(target)) === entry &&
      entry.frozenForDeletion !== true &&
      entry.discardedForDeletion !== true
    ) {
      try {
        const persistence = this.broadcast(target, entry, mutation);
        if (persistence) await persistence;
        return true;
      } catch (error) {
        logMainProcessWarn(
          '[chat-queue] Retrying durable queued-input settlement:',
          error,
        );
        await new Promise<void>((resolve) => {
          this.dependencies.schedule(resolve, retryDelayMs);
        });
        retryDelayMs = Math.min(
          retryDelayMs * 2,
          QUEUE_PERSISTENCE_RETRY_MAX_MS,
        );
      }
    }
    return false;
  }

  private scheduleDrain(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    delayMs: number,
  ): void {
    if (
      entry.authenticationPause !== undefined ||
      entry.externalRetryParked === true ||
      entry.worktreeSetupHold !== undefined ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true ||
      this.isBackgroundWorkHoldActive(target, entry)
    ) {
      return;
    }
    // Preserve delayed retry deadlines even while another drain is settling
    // provider events. If the deadline expires before that drain finishes,
    // `drain()` records the wake and the active drain's finalizer runs it once.
    // Immediate wakes, on the other hand, can be coalesced directly.
    if (entry.drainInFlight === true && delayMs <= 0) {
      entry.drainRequested = true;
      return;
    }
    if (entry.drainTimer) clearTimeout(entry.drainTimer);
    delete entry.drainTimer;
    entry.drainTimerDueAtMs = this.dependencies.now() + Math.max(0, delayMs);
    entry.drainTimer = this.dependencies.schedule((): void => {
      delete entry.drainTimer;
      delete entry.drainTimerDueAtMs;
      if (
        this.entries.get(chatQueueKey(target)) !== entry ||
        entry.externalRetryParked === true ||
        entry.authenticationPause !== undefined ||
        entry.worktreeSetupHold !== undefined ||
        entry.frozenForDeletion === true ||
        entry.discardedForDeletion === true ||
        this.isBackgroundWorkHoldActive(target, entry)
      ) {
        return;
      }
      void this.drain(target, entry);
    }, delayMs);
  }

  /** Recheck after durable writes and other awaited preparation, at handoff. */
  private async assertWatcherIngress(
    request: ChatSendMessageRequest,
  ): Promise<void> {
    if (!request.watcherFired || !request.watcherDeliveryId) return;
    const check = await this.dependencies.checkWatcherIngress?.(request);
    if (check && !check.allowed)
      throw new WatcherDeliveryHeldError(check.reason);
  }

  private async dispatch(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    entry: ChatQueueEntry,
    fromQueue: boolean,
    options: ChatQueueDispatchOptions = {},
    beforeImmediateDispatch?: (options: {
      cancelledBeforeDispatch: boolean;
      startsTurn: boolean;
    }) => Promise<void>,
  ): Promise<void> {
    // Unknown ownership is settled under the reservation below, so a cold
    // chat's first send does not detour through the queue.
    let activity = this.readTurnActivity(
      request,
      entry,
      undefined,
      undefined,
      false,
    );
    if (activity.turnPhase === 'foreground') {
      if (activity.hasForegroundProviderWork && !entry.turnActive) {
        this.armTurnGate(request, entry, 'adopted-provider-activity');
        entry.activePluginSelections =
          this.dependencies.getActiveProviderPluginSelections?.(request);
        entry.activeGlobalPluginDefaultsRevision =
          this.dependencies.getActiveProviderPluginDefaultsRevision?.(request);
      }
      await this.enqueueDurably(request, entry, {
        id: this.dependencies.createId(),
        request,
        origin,
        enqueuedAtMs: this.dependencies.now(),
        ...options,
      });
      return;
    }
    let acquiredTurn = false;
    let handedOff = false;
    entry.dispatchInFlight = true;
    const dispatchOwner = Symbol('chat-queue-dispatch');
    entry.reservation = { kind: 'dispatch', owner: dispatchOwner };
    const untaggedTerminalsAtStart = entry.untaggedTerminals ?? 0;
    // Take Stop ownership before the first await; the session may not exist
    // yet, so a provider-level cancel alone would miss this send.
    const preparation = this.dependencies.beginTurnPreparation?.(request);
    try {
      // An idle composer can submit before already-received provider events
      // finish committing. Reserve this submission's position without claiming
      // a turn: the old route must still be allowed to revive during the drain.
      await this.dependencies.drainProviderEvents?.(request);
      if (this.entries.get(chatQueueKey(request)) !== entry) return;
      if (this.needsOwnershipHydration(request)) {
        await this.hydrateOwnership(request);
        if (this.entries.get(chatQueueKey(request)) !== entry) return;
      }
      if (isTurnPreparationCancelled(preparation)) {
        this.releaseWatcherAuthority(request);
        // Acceptance still owns the user-visible prompt. Stop prevented its
        // provider hand-off, not the durable transcript row.
        if (beforeImmediateDispatch)
          await beforeImmediateDispatch({
            cancelledBeforeDispatch: true,
            startsTurn: false,
          });
        // Stop cancelled this send before it claimed the turn. While that Stop
        // is still unwinding, hold the gate for it so no queued send starts
        // first; Stop's own untagged terminal then releases and drains. If the
        // terminal already ran, there is nothing left to wait for.
        if ((entry.untaggedTerminals ?? 0) === untaggedTerminalsAtStart) {
          entry.reservation = {
            kind: 'stop',
            owner: Symbol('chat-queue-stop'),
          };
          this.armTurnGate(
            request,
            entry,
            'stop-preparation',
            request.userMessageId,
          );
          this.broadcastBestEffort(request, entry);
        }
        return;
      }
      activity = this.readTurnActivity(request, entry, dispatchOwner);
      if (activity.turnPhase === 'foreground') {
        if (activity.hasForegroundProviderWork) {
          // An armed gate keeps its source, time and root (a revived root
          // stays tied to its own terminal); only an unarmed gate is adopted.
          if (!entry.turnActive) {
            this.armTurnGate(
              request,
              entry,
              'adopted-provider-activity',
              entry.activeTurnUserMessageId,
            );
          }
          entry.activePluginSelections =
            this.dependencies.getActiveProviderPluginSelections?.(request);
          entry.activeGlobalPluginDefaultsRevision =
            this.dependencies.getActiveProviderPluginDefaultsRevision?.(
              request,
            );
        }
        await this.enqueueDurably(
          request,
          entry,
          {
            id: this.dependencies.createId(),
            request,
            origin,
            enqueuedAtMs: this.dependencies.now(),
            ...options,
          },
          true,
        );
        return;
      }
      if (
        request.agentSendSetup &&
        (await agentSendTargetReadiness(request)) === 'pending'
      ) {
        await this.enqueueDurably(request, entry, {
          id: this.dependencies.createId(),
          request,
          origin,
          enqueuedAtMs: this.dependencies.now(),
        });
        this.scheduleDrain(request, entry, 1000);
        return;
      }
      acquiredTurn = true;
      this.armTurnGate(
        request,
        entry,
        'immediate-dispatch',
        request.userMessageId,
      );
      const authorization = this.registerDispatchOwner(
        request,
        entry,
        dispatchOwner,
        request.userMessageId,
      );
      entry.currentGlobalPluginDefaultsRevision =
        this.dependencies.getCurrentPluginDefaultsRevision?.(request);
      entry.activePluginSelections = normalizePluginSelections(
        request.pluginSelections,
      );
      entry.activeGlobalPluginDefaultsRevision =
        entry.currentGlobalPluginDefaultsRevision;
      const acceptance = this.acceptanceMutation(request, 'started');
      const persistence = this.broadcast(request, entry, acceptance);
      if (persistence) await persistence;
      if (acceptance) reportAgentSendAccepted(request, acceptance.acceptance);
      if (
        entry.authenticationPause !== undefined ||
        entry.worktreeSetupHold !== undefined ||
        entry.frozenForDeletion === true
      ) {
        this.releaseTurnGate(entry);
        this.insertQueuedMessage(
          entry,
          {
            id: this.dependencies.createId(),
            request,
            origin,
            enqueuedAtMs: this.dependencies.now(),
            ...options,
          },
          0,
        );
        const restoredPersistence = this.broadcast(request, entry);
        if (restoredPersistence) await restoredPersistence;
        return;
      }
      if (entry.discardedForDeletion === true) {
        this.releaseWatcherAuthority(request);
        return;
      }
      // Recheck the sender and watcher authority before the prompt commits.
      if (
        request.agentSent ||
        request.agentSenderProvenance ||
        request.hiddenContext?.kind === 'agent-sender-context'
      )
        await revalidateAgentSenderRequest(request);
      if (request.watcherFired && request.watcherDeliveryId)
        await this.assertWatcherIngress(request);
      // A Stop after this claim is settled by that Stop's own gate release;
      // the hand-off below inherits the cancel. Releasing here would let a
      // queued send start before Stop finishes.
      // Admission is now final: live events, auth and deletion gates have
      // settled, and this dispatch owns the gate. Queued requests never run
      // this callback; their prompt event is their first transcript write.
      if (beforeImmediateDispatch)
        await beforeImmediateDispatch({
          cancelledBeforeDispatch: false,
          startsTurn: true,
        });
      const dispatchNow = (): ReturnType<
        ChatQueueServiceDependencies['dispatch']
      > =>
        this.dependencies.dispatch(
          request,
          origin,
          fromQueue,
          authorization,
          options,
        );
      const outcome = request.agentSenderProvenance
        ? await withAgentSenderAuthority(
            request,
            dispatchNow,
            revalidateAgentSenderRequest,
          )
        : await dispatchNow();
      handedOff =
        !outcome ||
        (await this.applyDispatchOutcome(
          request,
          entry,
          dispatchOwner,
          outcome,
          authorization,
          async (): Promise<void> => {
            this.insertQueuedMessage(
              entry,
              {
                id: this.dependencies.createId(),
                request,
                origin,
                enqueuedAtMs: this.dependencies.now(),
                ...options,
              },
              0,
            );
            const persistence = this.broadcast(request, entry);
            if (persistence) await persistence;
          },
        ));
      // As in a dequeued dispatch: settle a prompt committed before refusal.
      const refused = Boolean(outcome && outcome.kind === 'refused');
      if (!handedOff && !refused) return;
      if (handedOff) this.watcherDispatchSucceeded(request, entry);
      delete entry.externalRetryParked;
      const currentEntry = this.entries.get(chatQueueKey(request));
      if (
        isTurnPreparationCancelled(preparation) &&
        currentEntry === entry &&
        currentEntry.frozenForDeletion !== true &&
        currentEntry.discardedForDeletion !== true
      ) {
        if ((entry.untaggedTerminals ?? 0) === untaggedTerminalsAtStart) {
          entry.reservation = {
            kind: 'stop',
            owner: Symbol('chat-queue-stop'),
          };
        }
        // Stop can commit before an in-flight acceptance write finishes.
        // Settle that late prefix while dispatch still owns the queue gate.
        await this.settleCancelledHandoffUntilDurable(
          request,
          entry,
          request.userMessageId,
        );
        // Stop reached this send before it started; nothing will start it.
        this.removeDispatchOwners(request, entry, { token: dispatchOwner });
      }
    } catch (error) {
      if (
        error instanceof WatcherDeliveryHeldError &&
        entry.discardedForDeletion !== true
      ) {
        if (acquiredTurn && entry.reservation?.kind !== 'stop')
          this.releaseTurnGate(entry);
        await this.enqueueDurably(
          request,
          entry,
          {
            id: this.dependencies.createId(),
            request,
            origin,
            enqueuedAtMs: this.dependencies.now(),
            watcherDeliveryHeld: {
              outcome: error.outcome,
              reason: error.reason,
            },
          },
          true,
        );
        this.armHeldWatcherRetry(request, entry);
        return;
      }
      // Generated input skips submit's pre-dispatch hold check, so a direct
      // send can still be held here, before its turn starts: keep it queued
      // until the native work ends, as a drained row would be. A send Stop
      // cancelled during the reuse decision is not kept for a later retry.
      if (
        turnSessionReuse.isTurnHeldForBackgroundWorkError(error) &&
        !isTurnPreparationCancelled(preparation) &&
        entry.discardedForDeletion !== true
      ) {
        if (acquiredTurn && entry.reservation?.kind !== 'stop')
          this.releaseTurnGate(entry);
        const rowId = this.dependencies.createId();
        await this.enqueueDurably(
          request,
          entry,
          {
            id: rowId,
            request,
            origin,
            enqueuedAtMs: this.dependencies.now(),
            ...options,
          },
          true,
        );
        // Work ended after the guard: run one fresh guarded dispatch.
        if (!this.markBackgroundWorkHold(request, entry, rowId))
          this.scheduleDrain(request, entry, 0);
        return;
      }
      if (
        isAgentSenderContextError(error) &&
        acquiredTurn &&
        entry.discardedForDeletion !== true
      ) {
        if (acquiredTurn && entry.reservation?.kind !== 'stop')
          this.releaseTurnGate(entry);
        if (
          error.code === 'target_not_ready' &&
          request.agentSendSetup &&
          (await agentSendTargetReadiness(request).catch(() => 'ready')) ===
            'pending'
        ) {
          await this.enqueueDurably(request, entry, {
            id: this.dependencies.createId(),
            request,
            origin,
            enqueuedAtMs: this.dependencies.now(),
          });
          this.scheduleDrain(request, entry, 1000);
          return;
        }
        await this.persistRestoredQueueUntilDurable(request, entry, {
          type: 'cancel',
          request,
          agentSendRefusalCode:
            error.code === 'authorization_conflict'
              ? 'owner_boundary'
              : error.code,
          lastErrorMessage:
            'The agent that sent this message can no longer reach this chat.',
        });
        return;
      }
      // Rows enqueued while this dispatch was in flight must not strand:
      // release the gate, publish the corrected state, and drain them.
      if (acquiredTurn && entry.reservation?.kind !== 'stop') {
        this.releaseTurnGate(entry);
      }
      if (entry.discardedForDeletion !== true) {
        if (acquiredTurn && request.agentSenderProvenance)
          await this.persistRestoredQueueUntilDurable(request, entry, {
            type: 'settle-agent-input',
            request,
            reason: error instanceof Error ? error.message : String(error),
          });
        else this.broadcastBestEffort(request, entry);
        this.scheduleDrain(request, entry, 500);
      }
      throw error;
    } finally {
      if (entry.reservation?.owner === dispatchOwner) delete entry.reservation;
      // Only an accepted hand-off keeps its D; it then waits for its start.
      if (!handedOff)
        this.removeDispatchOwners(request, entry, { token: dispatchOwner });
      preparation?.finish();
      entry.dispatchInFlight = false;
      this.schedulePendingGeneratedSteering(entry);
      // A different client can enqueue while the first send is handing off to
      // the provider. Publish the released gate so its Steer control does not
      // stay disabled until another queue mutation or a terminal event.
      if (
        this.entries.get(chatQueueKey(request)) === entry &&
        entry.frozenForDeletion !== true &&
        entry.discardedForDeletion !== true &&
        entry.queue.length > 0
      ) {
        this.broadcastBestEffort(request, entry, false);
      }
      if (
        entry.frozenForDeletion !== true &&
        entry.discardedForDeletion !== true &&
        this.getTurnPhase(request, entry) !== 'foreground' &&
        !entry.recoveryInFlight &&
        entry.queue.some((message) => !message.watcherDeliveryHeld) &&
        !entry.drainTimer
      ) {
        this.scheduleDrain(request, entry, 0);
      }
      this.refreshRestartHold(request);
    }
  }

  private canRecoverCodexGate(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    turnUserMessageId: string,
    operationEpoch: number,
    recoveryOwner: symbol,
    canonicalTurnOpen: boolean,
  ): boolean {
    if (
      this.entries.get(chatQueueKey(target)) !== entry ||
      !entry.turnActive ||
      entry.activeTurnUserMessageId !== turnUserMessageId ||
      (entry.operationEpoch ?? 0) !== operationEpoch ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true ||
      entry.authenticationPause !== undefined ||
      (entry.recoveryInFlight && entry.recoveryOwner !== recoveryOwner)
    ) {
      return false;
    }
    const sessionKey = buildChatSessionKey(
      target.projectId,
      target.worktreeId,
      target.chatId,
    );
    const evidence = getCodexTurnEvidence(sessionKey);
    return canRecoverCodexTurn({
      hostGateArmed: entry.turnActive,
      turnUserMessageId,
      hasActiveProviderTurn: this.dependencies.hasActiveProviderTurn(target),
      hasPendingProviderContinuation:
        this.dependencies.hasPendingProviderContinuation(target),
      hasPendingUserDecision:
        this.dependencies.hasPendingUserDecision?.(target) === true,
      dispatchInFlight: entry.dispatchInFlight,
      hasRecoveryInFlight:
        entry.recoveryInFlight && entry.recoveryOwner !== recoveryOwner,
      hasReservation: entry.reservation !== undefined,
      holdsTurn: evidence.holdsTurn,
      hasMatchingTerminal:
        evidence.terminal?.turnUserMessageId === turnUserMessageId,
      canonicalTurnOpen,
    });
  }

  private canReleaseIdleUnownedCodexGate(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): boolean {
    return (
      entry.turnActive &&
      entry.activeTurnUserMessageId === undefined &&
      !entry.dispatchInFlight &&
      !entry.recoveryInFlight &&
      entry.frozenForDeletion !== true &&
      entry.discardedForDeletion !== true &&
      entry.authenticationPause === undefined &&
      entry.reservation === undefined &&
      !this.dependencies.hasActiveProviderTurn(target) &&
      !this.dependencies.hasPendingProviderContinuation(target) &&
      this.dependencies.hasPendingUserDecision?.(target) !== true &&
      !getCodexTurnEvidence(
        buildChatSessionKey(target.projectId, target.worktreeId, target.chatId),
      ).holdsTurn
    );
  }

  private ownsIdleUnownedCodexGate(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    operationEpoch: number,
    recoveryOwner: symbol,
  ): boolean {
    return (
      this.entries.get(chatQueueKey(target)) === entry &&
      entry.recoveryInFlight &&
      entry.recoveryOwner === recoveryOwner &&
      (entry.operationEpoch ?? 0) === operationEpoch &&
      entry.turnActive &&
      entry.activeTurnUserMessageId === undefined &&
      !entry.dispatchInFlight &&
      entry.frozenForDeletion !== true &&
      entry.discardedForDeletion !== true &&
      entry.authenticationPause === undefined &&
      entry.reservation === undefined &&
      !this.dependencies.hasActiveProviderTurn(target) &&
      !this.dependencies.hasPendingProviderContinuation(target) &&
      this.dependencies.hasPendingUserDecision?.(target) !== true &&
      !getCodexTurnEvidence(
        buildChatSessionKey(target.projectId, target.worktreeId, target.chatId),
      ).holdsTurn
    );
  }

  private releaseRecoveryReservation(
    entry: ChatQueueEntry,
    recoveryOwner: symbol,
  ): void {
    if (entry.recoveryOwner !== recoveryOwner) return;
    delete entry.recoveryOwner;
    entry.recoveryInFlight = false;
    this.finishRecoveryWait(entry);
    this.schedulePendingGeneratedSteering(entry);
  }

  private beginRecoveryWait(
    entry: ChatQueueEntry,
    operation: string,
    owner?: symbol,
    options?: { claim?: boolean; gateAgeMs?: () => number },
  ): ChatWaitOperation {
    const wait = startChatWaitOperation({
      name: operation,
      scope: entry.target,
      queueDepth: entry.queue.length,
      operationEpoch: entry.operationEpoch ?? 0,
      gateOwnerInputId: entry.activeTurnUserMessageId,
      ...(options?.gateAgeMs ? { gateAgeMs: options.gateAgeMs } : {}),
      ownerTokenId: owner
        ? `${owner.description ?? 'recovery'}-${randomUUID()}`
        : randomUUID(),
      bounded: true,
      record: (record): void => {
        getObservabilityService().recordSessionDiagnostic(record);
      },
    });
    if (options?.claim !== false) {
      entry.recoveryWait = wait;
      wait.claim();
    }
    return wait;
  }

  private finishRecoveryWait(
    entry: ChatQueueEntry,
    wait: ChatWaitOperation | undefined = entry.recoveryWait,
  ): void {
    wait?.finish('released');
    if (entry.recoveryWait === wait) delete entry.recoveryWait;
  }

  private async enqueueOnIdleUnownedCodexGate(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    entry: ChatQueueEntry,
    operationEpoch: number,
    recoveryOwner: symbol,
    options: ChatQueueDispatchOptions,
  ): Promise<void> {
    entry.recoveryInFlight = true;
    entry.recoveryOwner = recoveryOwner;
    const wait = this.beginRecoveryWait(
      entry,
      'chat_queue.recover_idle_unowned_codex_gate',
      recoveryOwner,
    );
    let canReleaseGate = false;
    try {
      wait.phase('queue_persistence');
      await this.enqueueDurably(request, entry, {
        id: this.dependencies.createId(),
        request,
        origin,
        enqueuedAtMs: this.dependencies.now(),
        ...options,
      });
      if (
        !this.ownsIdleUnownedCodexGate(
          request,
          entry,
          operationEpoch,
          recoveryOwner,
        )
      ) {
        return;
      }
      try {
        wait.phase('provider_events');
        await this.dependencies.drainProviderEvents?.(request);
      } catch (error) {
        if (
          this.ownsIdleUnownedCodexGate(
            request,
            entry,
            operationEpoch,
            recoveryOwner,
          )
        ) {
          logMainProcessWarn(
            '[chat-queue] Could not settle provider events before releasing an idle Codex gate:',
            error,
          );
        }
        return;
      }
      canReleaseGate = this.ownsIdleUnownedCodexGate(
        request,
        entry,
        operationEpoch,
        recoveryOwner,
      );
    } finally {
      this.releaseRecoveryReservation(entry, recoveryOwner);
      if (
        this.entries.get(chatQueueKey(request)) === entry &&
        entry.frozenForDeletion !== true &&
        entry.discardedForDeletion !== true &&
        entry.authenticationPause === undefined &&
        !entry.dispatchInFlight &&
        this.getTurnPhase(request, entry) !== 'foreground' &&
        entry.queue.length > 0
      ) {
        // Terminal ingress can release this formerly idless gate while the
        // recovery reservation is held. A drain timer that ran in that window
        // stood down, so restart FIFO once this owner has fully unwound.
        this.scheduleDrain(request, entry, 0);
      }
    }
    if (!canReleaseGate || this.entries.get(chatQueueKey(request)) !== entry)
      return;
    this.releaseUnownedTurnGate(request, entry);
    if (this.getTurnPhase(request, entry) !== 'foreground')
      await this.drain(request, entry);
  }

  private async recoverIdleCodexTurnGate(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    entry: ChatQueueEntry,
    turnUserMessageId: string,
    operationEpoch: number,
    recoveryOwner: symbol,
    options: ChatQueueDispatchOptions,
  ): Promise<void> {
    if (
      !this.canRecoverCodexGate(
        request,
        entry,
        turnUserMessageId,
        operationEpoch,
        recoveryOwner,
        true,
      )
    ) {
      return;
    }
    entry.recoveryInFlight = true;
    entry.recoveryOwner = recoveryOwner;
    const wait = this.beginRecoveryWait(
      entry,
      'chat_queue.recover_idle_codex_turn_gate',
      recoveryOwner,
    );
    try {
      try {
        wait.phase('queue_persistence');
        await this.enqueueDurably(request, entry, {
          id: this.dependencies.createId(),
          request,
          origin,
          enqueuedAtMs: this.dependencies.now(),
          ...options,
        });
      } catch (error) {
        const stillOwnsRecovery = this.canRecoverCodexGate(
          request,
          entry,
          turnUserMessageId,
          operationEpoch,
          recoveryOwner,
          true,
        );
        this.releaseRecoveryReservation(entry, recoveryOwner);
        if (
          !stillOwnsRecovery &&
          this.entries.get(chatQueueKey(request)) === entry &&
          entry.frozenForDeletion !== true &&
          entry.discardedForDeletion !== true &&
          entry.authenticationPause === undefined &&
          this.getTurnPhase(request, entry) !== 'foreground' &&
          entry.queue.length > 0
        ) {
          // A matching provider terminal can release the gate while durable
          // enqueue is pending. Its scheduled drain may have observed this
          // reservation and exited, so re-arm FIFO after our failed enqueue.
          this.scheduleDrain(request, entry, 0);
        }
        throw error;
      }
      if (
        !this.canRecoverCodexGate(
          request,
          entry,
          turnUserMessageId,
          operationEpoch,
          recoveryOwner,
          true,
        )
      ) {
        return;
      }

      try {
        wait.phase('provider_events');
        await this.dependencies.drainProviderEvents?.(request);
      } catch (error) {
        if (
          this.canRecoverCodexGate(
            request,
            entry,
            turnUserMessageId,
            operationEpoch,
            recoveryOwner,
            true,
          )
        ) {
          logMainProcessWarn(
            '[chat-queue] Could not settle provider events before Codex recovery:',
            error,
          );
        }
        return;
      }
      if (
        !this.canRecoverCodexGate(
          request,
          entry,
          turnUserMessageId,
          operationEpoch,
          recoveryOwner,
          true,
        )
      ) {
        return;
      }

      let canonicalTurnOpen = true;
      if (this.dependencies.isCanonicalTurnOpen) {
        try {
          wait.phase('canonical_turn');
          canonicalTurnOpen = await this.dependencies.isCanonicalTurnOpen(
            request,
            turnUserMessageId,
          );
        } catch (error) {
          if (
            !this.canRecoverCodexGate(
              request,
              entry,
              turnUserMessageId,
              operationEpoch,
              recoveryOwner,
              true,
            )
          ) {
            return;
          }
          logMainProcessWarn(
            '[chat-queue] Could not check canonical Codex turn state before recovery:',
            error,
          );
          return;
        }
      }
      if (
        !this.canRecoverCodexGate(
          request,
          entry,
          turnUserMessageId,
          operationEpoch,
          recoveryOwner,
          canonicalTurnOpen,
        )
      ) {
        return;
      }

      try {
        wait.phase('settle_cancelled_turn');
        await this.dependencies.settleCancelledTurn(request, turnUserMessageId);
      } catch (error) {
        if (
          !this.canRecoverCodexGate(
            request,
            entry,
            turnUserMessageId,
            operationEpoch,
            recoveryOwner,
            canonicalTurnOpen,
          )
        ) {
          return;
        }
        // A synthetic terminal that failed to commit cannot release the queue
        // gate. A later real provider terminal remains responsible for FIFO.
        logMainProcessWarn(
          '[chat-queue] Failed to settle interrupted Codex turn before recovery dispatch:',
          error,
        );
        return;
      }
      if (
        !this.canRecoverCodexGate(
          request,
          entry,
          turnUserMessageId,
          operationEpoch,
          recoveryOwner,
          canonicalTurnOpen,
        )
      ) {
        return;
      }
      this.releaseTurnGate(entry);
    } finally {
      this.releaseRecoveryReservation(entry, recoveryOwner);
    }
  }

  private acceptanceMutation(
    request: ChatSendMessageRequest,
    disposition: 'started' | 'queued',
    queuedMessageId?: string,
  ):
    | Extract<ChatQueuePersistenceMutation, { type: 'agent-send-accepted' }>
    | undefined {
    if (
      disposition === 'started' &&
      request.agentSent &&
      isTerminalBackedInterfaceMode(
        getEffectiveClaudeChatInterfaceMode(request.interfaceMode),
      )
    )
      return undefined;
    const acceptance: AgentSendAcceptanceFacts = {
      acceptedInputId: request.userMessageId,
      disposition,
      acceptedAt: new Date(this.dependencies.now()).toISOString(),
      ...(queuedMessageId ? { queuedMessageId } : {}),
    };
    const commandResult = agentSendAcceptanceReceipt(request, acceptance);
    return commandResult
      ? { type: 'agent-send-accepted', request, acceptance, commandResult }
      : undefined;
  }

  private async enqueueDurably(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    message: HostQueuedMessage,
    prepend = false,
  ): Promise<void> {
    const previous = entry.queue[entry.queue.length - 1];
    const combinedParts =
      !prepend && previous
        ? mergeableWatcherParts(previous, message, entry.steeringRowId)
        : undefined;
    if (previous && combinedParts) {
      const previousRequest = previous.request;
      const previousParts = previous.watcherParts;
      previous.watcherParts = combinedParts;
      previous.request = combinedWatcherRequest(
        previous.request,
        combinedParts,
      );
      try {
        const persistence = this.broadcast(target, entry);
        if (persistence) await persistence;
      } catch (error) {
        previous.request = previousRequest;
        if (previousParts) previous.watcherParts = previousParts;
        else delete previous.watcherParts;
        this.broadcastBestEffort(target, entry);
        throw error;
      }
      this.markSteeringEligibility(entry);
      return;
    }
    this.insertQueuedMessage(entry, message, undefined, prepend);
    // A snapshot loaded before dequeue/cancel can finish hydrating afterward.
    // Remember locally accepted IDs as well as recovered IDs so that stale
    // snapshot cannot reintroduce a row this live queue already consumed.
    entry.persistedInputIds.add(message.id);
    const acceptance = this.acceptanceMutation(
      message.request,
      'queued',
      message.id,
    );
    try {
      const persistence = this.broadcast(target, entry, acceptance);
      if (persistence) await persistence;
      if (acceptance)
        reportAgentSendAccepted(message.request, acceptance.acceptance);
    } catch (error) {
      const index = entry.queue.findIndex(
        (candidate) => candidate.id === message.id,
      );
      if (index >= 0) entry.queue.splice(index, 1);
      entry.persistedInputIds.delete(message.id);
      this.broadcastBestEffort(target, entry);
      throw error;
    }
    if (
      message.ordinaryOnly !== true &&
      isGeneratedInputRequest(message.request)
    )
      this.markSteeringEligibility(entry);
    this.refreshRestartHold(target);
  }

  private insertQueuedMessage(
    entry: ChatQueueEntry,
    message: HostQueuedMessage,
    index?: number,
    prepend = false,
  ): void {
    entry.claimedQueueRowIds?.delete(message.id);
    if (index !== undefined) {
      entry.queue.splice(Math.min(index, entry.queue.length), 0, message);
    } else if (prepend) {
      // The stable sort below keeps a prepended internal row behind every
      // visible row and ahead of the internal rows that arrived after it.
      entry.queue.unshift(message);
    } else {
      entry.queue.push(message);
    }
    prioritizeQueue(entry);
  }

  private broadcast(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    mutation?: ChatQueuePersistenceMutation,
  ): void | Promise<void> {
    const turnPhase = this.getTurnPhase(target, entry);
    const event = this.queueSnapshot(target, entry, turnPhase);
    const queueSignature = JSON.stringify({
      queue: event.queue,
      waitingDelegationIds: event.waitingDelegationIds,
    });
    let revision = entry.broadcastRevision ?? 0;
    if (entry.broadcastQueueSignature !== queueSignature) {
      revision += 1;
      entry.broadcastRevision = revision;
      entry.broadcastQueueSignature = queueSignature;
    }
    const persistence = this.dependencies.persistRuntime(
      target,
      entry.queue.map((message) => message.id),
      entry.turnActive,
      mutation,
      entry.queue.map(
        ({
          id,
          request,
          origin,
          enqueuedAtMs,
          requiredAccountProxyConnectionId,
          revision: rowRevision,
        }) => ({
          id,
          request,
          origin,
          enqueuedAtMs,
          ...(requiredAccountProxyConnectionId !== undefined
            ? { requiredAccountProxyConnectionId }
            : {}),
          ...(rowRevision !== undefined && rowRevision > 1
            ? { revision: rowRevision }
            : {}),
          ...(entry.authenticationPause
            ? { authenticationAttemptId: entry.authenticationPause }
            : {}),
        }),
      ),
      entry.activeTurnUserMessageId,
      entry.dispatching
        ? {
            id: entry.dispatching.id,
            request: entry.dispatching.request,
            origin: entry.dispatching.origin,
            enqueuedAtMs: entry.dispatching.enqueuedAtMs,
            ...(entry.dispatching.requiredAccountProxyConnectionId !== undefined
              ? {
                  requiredAccountProxyConnectionId:
                    entry.dispatching.requiredAccountProxyConnectionId,
                }
              : {}),
            ...(entry.dispatching.revision !== undefined &&
            entry.dispatching.revision > 1
              ? { revision: entry.dispatching.revision }
              : {}),
            ...(entry.authenticationPause
              ? { authenticationAttemptId: entry.authenticationPause }
              : {}),
          }
        : undefined,
    );
    if (!persistence || typeof persistence.then !== 'function') {
      entry.pendingBroadcastRevision = revision;
      entry.pendingBroadcastCount = 0;
      entry.pendingBroadcastSucceeded = false;
      entry.broadcastPersistencePending = false;
      entry.pendingPhaseBroadcast = false;
      this.dependencies.broadcast(event);
      this.recordPublishedTurnPhase(entry, turnPhase);
      this.pruneInputIdsAfterPersistence(target, entry);
      return;
    }
    if (entry.pendingBroadcastRevision !== revision) {
      entry.pendingBroadcastRevision = revision;
      entry.pendingBroadcastCount = 0;
      entry.pendingBroadcastSucceeded = false;
    }
    entry.pendingBroadcastCount = (entry.pendingBroadcastCount ?? 0) + 1;
    entry.broadcastPersistencePending =
      entry.pendingBroadcastSucceeded !== true;
    entry.pendingQueuePersistenceCount =
      (entry.pendingQueuePersistenceCount ?? 0) + 1;
    return persistence.then(
      () => {
        this.pruneInputIdsAfterPersistence(target, entry);
        this.finishBroadcastPersistence(target, entry, revision, true);
        this.finishQueuePersistence(entry);
      },
      (error: unknown) => {
        this.finishBroadcastPersistence(target, entry, revision, false);
        this.finishQueuePersistence(entry);
        throw error;
      },
    );
  }

  private broadcastBestEffort(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    persist = true,
  ): void {
    try {
      if (!persist) {
        if (entry.broadcastPersistencePending === true) {
          entry.pendingPhaseBroadcast = true;
          return;
        }
        this.publishPhaseSnapshot(
          target,
          entry,
          this.getTurnPhase(target, entry),
        );
        return;
      }
      const persistence = this.broadcast(target, entry);
      if (persistence) {
        void persistence.catch((error: unknown) => {
          logMainProcessWarn(
            '[chat-queue] Refusing to broadcast queue state before canonical persistence:',
            error,
          );
        });
      }
    } catch (error) {
      logMainProcessWarn(
        '[chat-queue] Refusing to broadcast queue state before canonical persistence:',
        error,
      );
    }
  }
}

let chatQueueService: ChatQueueService | undefined;

export function getChatQueueService(): ChatQueueService {
  if (!chatQueueService) {
    chatQueueService = new ChatQueueService({
      ...DEFAULT_DEPENDENCIES,
      ownership: getChatTurnOwnership(),
    });
    subscribeChatSessionActivity(() => {
      chatQueueService?.reconcileSessionActivity();
    });
    subscribeDelegationActivity(() => {
      chatQueueService?.reconcileSessionActivity();
    });
    subscribeLiveBackgroundTasks((sessionKey) => {
      chatQueueService?.onNativeBackgroundWorkChanged(sessionKey);
    });
    subscribeGlobalPluginDefaultsRevision(() => {
      chatQueueService?.refreshGlobalPluginDefaults();
    });
    subscribeSteeringEligibility((sessionKey) => {
      chatQueueService?.notifySteeringEligibility(sessionKey);
    });
  }
  return chatQueueService;
}

/**
 * Run a host dispatch that has no queue row under ordinary admission
 * (contracts §6): its D precedes the first prompt effect, and is released
 * unless `run` reports that its dispatch started.
 */
export function runAdmittedDirectDispatch(
  target: ChatQueueTarget,
  userMessageId: string,
  run: (authorization: AuthorizedChatDispatch | undefined) => Promise<boolean>,
): Promise<void> {
  return getChatQueueService().runDirectDispatch(target, userMessageId, run);
}
