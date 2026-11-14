import type {
  AgentModelConfig,
  AgentProviderType,
  ApprovalRequestEvent,
  AppliedOrgMemoryTurn,
  AttachmentMeta,
  ChatActiveSessionInfo,
  ChatAttachmentPromptContext,
  ChatInterfaceMode,
  ChatModel,
  ChatSendMessageRequest,
  ChatTabPluginSelections,
  ChatTurnPhase,
  ChatWatcherFiredInfo,
  ClaudeTerminalLaunchRequest,
  DeferredToolsReloadLifecycle,
  EmptyCompletionRecovery,
  ExternalProjectProvider,
  FileReference,
  McpAskUserEvent,
  McpQuestionAnswer,
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedChatTab,
  QueuedMessageRetryBlockedReason,
  QueuedMessageWaitingReason,
  ResolvedAgentModelConfig,
  StaleSessionInfo,
  ThinkingLevel,
  TodoItem,
  WorktreeSelection,
  SettingsHeldChange,
} from '@canopy/desktop-shared/types';
import type { LoadedSubagentSummary } from '@canopy/agent-transcript/lib/subagent-tree/native-inputs';
import type { WorkflowRunLocation } from '@/components/subagents/workflow-run-launches';
export type { AppliedOrgMemoryTurn } from '@canopy/desktop-shared/types';

/**
 * CAN-4742: a Home first send shown in its new chat before dispatch. The
 * echo, its turn bridge and its title patch are renderer-only presentation;
 * `sendMessage` adopts them under the same user-message id.
 */
export interface ProvisionalFirstSend {
  userMessageId: string;
  /** When Home accepted the send; the adopted turn keeps this start. */
  submittedAt: number;
  /**
   * `preparing` until `sendMessage` installs the turn, `dispatched` while
   * waiting for output, `queued` once a setup or host queue row holds it.
   * `failed` when its model was refused: the unsent prompt and
   * title stay, with recovery offered in place (CAN-5021).
   */
  phase: 'preparing' | 'dispatched' | 'queued' | 'failed';
  /**
   * The current preparation attempt. A retry starts a new one, so a stale
   * completion of an earlier attempt cannot fail the newer one.
   */
  attemptId?: string;
  /** Present only while `failed`. */
  failure?: ProvisionalFirstSendFailure;
  /** Synchronous guard while the matching send prepares its real turn. */
  dispatchClaimed?: boolean;
  /** Outbound live-terminal prompt, used only to reconcile this first send. */
  terminalPromptText?: string;
  /** Canonical terminal import identity; the submission id stays the UI key. */
  terminalUserMessageId?: string;
  /** The title this submission applied, when it applied one. */
  ownedTitle?: Pick<ChatTab, 'title' | 'automaticTitleState'>;
  /** The title the tab had before, restored only while the patch is owned. */
  priorTitle?: Pick<ChatTab, 'title' | 'automaticTitleState'>;
}

/** Why a provisional first send could not be dispatched (display only). */
export interface ProvisionalFirstSendFailure {
  /** An accepted picker choice may equal the tab's already retained model. */
  recoveryModelSelectionAccepted?: true;
  /** Unique per failure, so a repeated identical failure still takes focus. */
  failureId: string;
  /** The model the send attempted to apply. */
  model: string;
  /** User-facing explanation, naming that model. */
  message: string;
}

export interface StreamingTabVerificationResult {
  projectId: string;
  worktreeId: string;
  key: string;
  activeSet: Set<string>;
  sessionByChatId: Map<string, ChatActiveSessionInfo>;
}

export interface HydratedWorktreeTabsResult {
  key: string;
  chatState: WorktreeChatState;
  pendingQuestions: Record<string, PendingQuestion>;
  pendingApprovals: Record<string, ApprovalRequestEvent>;
  removedStaleApprovals: boolean;
  wasEmpty: boolean;
  preservedAnyOnRestore: boolean;
}

export type CreateTabTarget = WorktreeSelection & {
  planMode?: boolean;
  id?: string;
  title?: string;
  /**
   * Ask to take over the active tab's slot instead of appending. The store
   * replaces it only when it is a pristine starter (see `isPristineChatTab`):
   * a tab holding a draft, staged context, a schedule, or conversation stays,
   * and the new tab opens beside it.
   */
  replaceActiveEmpty?: boolean;
  model?: ChatModel;
  /**
   * Whether `model` is a DELIBERATE user pick rather than a resolved default.
   *
   * `model` alone carries no provenance, and inferring the flag from
   * `model !== undefined` marked every Home-composer chat explicit — Home
   * always pins the EFFECTIVE model it displayed, even when the user never
   * opened the picker. That permanently disabled the lane-aware re-stamp, so a
   * credits-only user who sent from Home during the startup window kept a chat
   * pinned to a Claude subscription model forever. Only real picks (the
   * ChatInput model picker, a quick-prompt config that names a model) set it.
   */
  modelExplicitlyChosen?: boolean;
  thinkingLevel?: ThinkingLevel;
  interfaceMode?: ChatInterfaceMode;
  modelConfig?: AgentModelConfig;
  /** @deprecated Use modelConfig.fastMode. */
  codexFastModeEnabled?: boolean;
  pluginSelections?: ChatTabPluginSelections;
  /** Child repository to bind before the tab can receive its first message. */
  selectedRepoId?: string;
  deferredToolsAllowed?: boolean;
};

export type ChatActionTarget = Pick<
  WorktreeSelection,
  'projectId' | 'worktreeId'
>;

// ---------------------------------------------------------------------------
// Renderer-only chat types (parsed from raw SDK events)
// ---------------------------------------------------------------------------

/**
 * Renderer chat block — structurally identical to {@link PersistedChatBlock}.
 * Aliased rather than re-declared so the shared persisted shape is the single
 * source of truth (used to be a copy-pasted union here).
 */
export type ChatBlock = PersistedChatBlock;

/**
 * Renderer chat message — same shape as {@link PersistedChatMessage}. The
 * runtime previously redeclared this verbatim; aliasing keeps the renderer
 * transcript code working unchanged while removing ~30 duplicated lines of
 * type definitions.
 */
export type ChatMessage = PersistedChatMessage;

export interface QueuedChatMessage {
  promptSource?: 'human' | 'automated';
  /** Presentation only; queue controls become available after host acceptance. */
  pendingSend?: boolean;
  hostQueueEntryId?: string;
  /** Existing canonical prompt reused when a host credit Retry dequeues. */
  supersedesUserMessageId?: string;
  origin?: 'desktop' | 'portal';
  enqueuedAtMs?: number;
  /**
   * Host-reported turn phase of the chat, present only on host-mirror rows.
   * Transient: never persisted. Renderer-local rows leave it unset.
   */
  turnPhase?: ChatTurnPhase;
  /**
   * Host-reported reason a queued row is waiting. Present only on host-mirror
   * rows. Transient: never persisted. Renderer-local rows leave it unset.
   */
  waitingReason?: QueuedMessageWaitingReason;
  /**
   * Host-reported reason an explicit retry cannot send yet. Present only on
   * host-mirror rows. Transient: never persisted.
   */
  retryBlockedReason?: QueuedMessageRetryBlockedReason;
  /** A held row still requires explicit Retry after funding is confirmed. */
  retryable?: boolean;
  /**
   * Host-reported background-work hold marker. Present only on host-mirror
   * rows. Transient: never persisted. Renderer-local rows leave it unset.
   */
  blockedByBackgroundWork?: true;
  editLocked?: boolean;
  /**
   * Host-reported: Run now is locked while edit and delete still work, as for
   * a row queued behind a turn its worktree's Git setup holds. Transient.
   */
  forceLocked?: true;
  canSteer?: boolean;
  steerBlockedByCapabilityChange?: boolean;
  /** Host: sending now would wait for background work to apply these settings. */
  restartHeldChanges?: readonly SettingsHeldChange[];
  text: string;
  fileReferences?: FileReference[];
  attachmentPaths?: string[];
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  scheduledSendDraft?: { runAt: string };
  dispatchOptions?: QueuedChatDispatchOptions;
  /**
   * Human-readable explanation for why the message is queued. When present,
   * the queued bubble renders this below the `Queued` header. Used by the
   * hook-chat concurrency queue to surface
   * `Waiting for active chat sessions to finish.`
   */
  reason?: string;
  /**
   * Identifier of the main-process queue entry backing this placeholder. Set
   * only on hook-chat queued placeholders; clearing the bubble issues a
   * `chat:cancel-queued-hook-chat` IPC for the matching entry.
   */
  queuedHookQueueId?: string;
  inputMode?: 'typed' | 'voice';
  /**
   * Present when the queued message was generated by a fired Canopy watcher.
   * Drives the info-tinted queued bubble and its "<kind> watcher has fired"
   * title line.
   */
  watcherFired?: ChatWatcherFiredInfo;
  /** Present when main handed off an agent-sent input; drives its title line. */
  agentSent?: ChatSendMessageRequest['agentSent'];
}

/**
 * Where a send reported through `onQueuedWithoutDispatch` is parked.
 * - `'renderer'`: this renderer's own queue on the chat tab (the worktree setup
 *   queue, a hook placeholder, an automation prompt behind a running Claude
 *   terminal turn, or a prompt kept for retry after a failed Claude terminal
 *   launch). `queuedMessages` is not saved with the chat tab, so the message
 *   is lost if the app restarts before it flushes.
 * - `'host'`: main's input-delivery queue, which owns the message durably.
 */
export type QueuedWithoutDispatchLocation = 'renderer' | 'host';

export interface SendMessageDispatchOptions {
  /** Main-admitted plan delivery must dispatch with its exact identity, never queue locally. */
  terminalPlanImplementation?: true;
  /** Renderer-only intent: a composer submission deliberately replaces this unsent failure. */
  replaceFailedFirstSend?: { userMessageId: string; failureId: string };
  planMode?: boolean;
  assistantMode?: ChatSendMessageRequest['assistantMode'];
  hiddenContext?: ChatSendMessageRequest['hiddenContext'];
  /**
   * The tracked plan the user is working with, captured with this message:
   * the composer's active plan at submit, or a plan panel's comment
   * submission. Main turns it into a one-turn plan-file instruction; a
   * terminal-backed chat resolves it here, since the renderer composes that
   * prompt. Request-scoped only: never stored on the tab, and programmatic
   * sends (Implement, nudges, watchers, automations) carry none. Copied into
   * renderer-local queued copies so a later flush still carries it.
   */
  activePlan?: ChatSendMessageRequest['activePlan'];
  appAdvisorContext?: ChatSendMessageRequest['appAdvisorContext'];
  initiationSource?: ChatSendMessageRequest['initiationSource'];
  automationName?: string;
  /** Trusted capability overlay attached by the main-issued automation command. */
  packageOverlay?: ChatSendMessageRequest['packageOverlay'];
  /** Caller-assigned id for an exact link to the user-authored turn. */
  userMessageId?: string;
  /** Renderer submission time, retained through first-send adoption. */
  submittedAt?: number;
  watcherFired?: ChatSendMessageRequest['watcherFired'];
  /**
   * Stable event id for a watcher send presented by a terminal-backed Claude
   * chat. Main delivers watcher messages for every other chat directly.
   */
  watcherDeliveryId?: string;
  /**
   * Accepted input id from main's trusted terminal handoff of an agent-sent
   * input; dedups terminal writes. Main-originated only.
   */
  acceptedInputId?: string;
  /** Display-only attribution from main's trusted handoff; never sent back. */
  agentSent?: ChatSendMessageRequest['agentSent'];
  attachmentPaths?: string[];
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  /** The caller already removed this send's attachments from the composer. */
  composerAttachmentsReserved?: boolean;
  /** One-shot revert summary claimed by the composer before async dispatch. */
  reservedRevertAttachmentPath?: string;
  throwOnDispatchFailure?: boolean;
  onDispatchAccepted?: () => void;
  onDispatchRejected?: () => void;
  /**
   * Called only when dispatch is rejected before the message is queued or
   * committed, so a composer can safely restore its submitted draft. Returns
   * `true` once the composer holds that draft again; a cloud send the web
   * core refused leaves the transcript only then (CAN-6364).
   */
  onPreDispatchRejected?: () => boolean | void;
  /**
   * Called when the send was parked in a queue instead of being dispatched,
   * naming which queue holds it (see {@link QueuedWithoutDispatchLocation}).
   * The queued row is then the message's only representation until it
   * flushes, so a caller holding a provisional echo must withdraw it or the
   * prompt renders twice. This is not rejection: a composer must keep its
   * draft cleared, since the queued row keeps the prompt for retry. A caller
   * that must know the message is durable (comment submission) treats only
   * `'host'` as sent. Intentionally excluded from
   * {@link QueuedChatDispatchOptions} so the flush's re-dispatch cannot
   * re-enter it.
   */
  onQueuedWithoutDispatch?: (queue: QueuedWithoutDispatchLocation) => void;
}

export interface ClaudeTerminalLaunchOptions {
  assistantMode?: ClaudeTerminalLaunchRequest['assistantMode'];
}

export type QueuedChatDispatchOptions = Omit<
  SendMessageDispatchOptions,
  | 'attachmentPaths'
  | 'attachmentPromptContexts'
  | 'composerAttachmentsReserved'
  | 'reservedRevertAttachmentPath'
  | 'throwOnDispatchFailure'
  | 'onPreDispatchRejected'
  | 'onQueuedWithoutDispatch'
>;

/**
 * Runtime marker held on a tab while a deferred-tools reload
 * (SearchDeferredTools / LoadDeferredTools) interrupts and resumes the tab's
 * in-flight turn as one continuous logical UX turn. Written by the authoritative
 * renderer (the App Advisor window for its sentinel tabs; the main window
 * otherwise) and consumed by the streaming re-verification and the terminal
 * reducers. Transient and never persisted — a renderer reload mid-flight settles
 * through the existing stale-session recovery.
 */
export interface DeferredToolsReloadTabState {
  /** Idempotency key of the in-flight reload (matches the coordinator's). */
  requestId: string;
  /**
   * Originating LoadDeferredTools tool-call id — the second half of the
   * coordinator scope key alongside `(projectId, worktreeId, chatId)`.
   */
  toolCallId: string;
  /**
   * The original logical user message id captured when the reload began, reused
   * for the hidden `<system_instruction>` continuation (round-tripped as
   * `canopy_turn_user_message_id`) so the resumed provider segment attaches to
   * the same turn and no second user bubble is created. Undefined only when no
   * open turn timer was found at reload time (defensive).
   */
  userMessageId?: string;
  /** Last lifecycle the coordinator reported for this reload (UI/debug only). */
  lifecycle: DeferredToolsReloadLifecycle;
}

/**
 * Runtime chat tab. Extends {@link PersistedChatTab} with renderer-only fields
 * that aren't persisted (live todos, attachments, lastEventAt, …) plus a few
 * fields the renderer requires to be present (`status`, `error`,
 * `queuedMessages`, `planMode`, `thinkingLevel`, `proposalMode`).
 *
 * The `Omit` + intersection pattern keeps the persisted union (`messages`
 * etc.) intact while letting us tighten the optional fields the renderer
 * always assumes are present.
 */
/** Renderer view of main's resume offer for a user-stopped turn (CAN-3137). */
/** A cloud chat's Stop, for one turn (CAN-6592). */
export interface CloudStopState {
  readonly phase: 'stopping' | 'not_stopped';
  /** The prompt of the turn Stop was pressed for; a later turn ignores it. */
  readonly promptMessageId: string | undefined;
  /**
   * Stopping for a while with the turn still running: Stop, still reading
   * Stopping…, can send the cancel again (`CLOUD_STOP_RETRY_AFTER_MS`).
   */
  readonly retryable?: boolean;
  /** Which press this is for the turn: each retry is a new attempt. */
  readonly attempt?: number;
}

export interface StoppedTurnResumeState {
  /** User-message anchor of the stopped turn. */
  userMessageId: string;
  /** `resuming` while a resume request is in flight; guards double dispatch. */
  status: 'available' | 'resuming';
  /** Identifies the in-flight request so a late reply cannot clear a newer offer. */
  requestToken?: string;
  /** Actionable failure text from the last attempt. */
  error?: string;
}

/**
 * A send the renderer shows as starting before main confirms it. It ends when
 * canonical runtime shows the turn (acknowledged) or at its deadline (expired).
 */
export interface SendingLease {
  /** Correlates the optimistic state with main's acknowledgement. */
  userMessageId: string;
  kind: 'send' | 'resume' | 'hook';
  issuedAt: number;
  /** `issuedAt` plus `SENDING_LEASE_MS`; the lease is expired after it. */
  deadline: number;
  state: 'pending' | 'acknowledged' | 'expired';
}

export const SENDING_LEASE_MS = 15_000;

export interface ChatTab extends Omit<
  PersistedChatTab,
  'messages' | 'planMode' | 'thinkingLevel' | 'proposalMode' | 'modelConfig'
> {
  messages: ChatMessage[];
  status: 'idle' | 'streaming' | 'error';
  /** Renderer-only timestamp while main is choosing an Auto model. */
  modelRoutingStartedAt?: number;
  /**
   * Renderer-only: whether the account proxy serves the chat's live session,
   * as main reported when it created the session. Undefined until then; never
   * persisted, because the next session decides its route again.
   */
  accountProxyRouted?: boolean;
  error: string | null;
  queuedMessages: QueuedChatMessage[];
  /** Host-reported delegations waiting in this tab's queue; transient and never persisted. */
  waitingDelegationIds?: readonly string[];
  /** Host-reported settings restart hold; transient and never persisted. */
  restartHeldByBackgroundWork?: true;
  /** User echoes awaiting canonical message delivery; never persisted. */
  pendingUserMessages?: ChatMessage[];
  /** Presentation-only bridge from submission to its canonical turn timer. */
  pendingTurn?: { userMessageId: string; timerMessage: ChatMessage };
  /** Optimistic sending state until main acknowledges the turn; never persisted. */
  sendingLease?: SendingLease;
  /** Dequeued prompt awaiting its canonical user id; presentation only. */
  pendingQueueDispatch?: {
    entryId: string;
    message: ChatMessage;
    previousMessageIds: string[];
    supersedesUserMessageId?: string;
  };
  /** Host submissions awaiting their queue mirror; never dispatched locally. */
  pendingQueueMessages?: Array<{
    userMessageId: string;
    message: QueuedChatMessage;
    previousHostIds: string[];
  }>;
  /** Home first send presented before dispatch (CAN-4742); never persisted. */
  provisionalFirstSend?: ProvisionalFirstSend;
  /**
   * Why the web core refused this cloud chat's last send (CAN-6364): the
   * composer shows it beside the draft it took back. Renderer-only and never
   * persisted; the next send or a dismiss clears it.
   */
  sendRefusal?: string;
  /**
   * A cloud chat's Stop (CAN-6592), for the turn whose prompt it names:
   * `stopping` from the press until that turn ends (re-enabled after a
   * while), and `not_stopped` when nothing could name the turn to cancel,
   * so Stop stays to try again.
   * Renderer-only and never persisted; the composer reads it through
   * `presentedCloudStop`.
   */
  cloudStop?: CloudStopState;
  /** Starter for a confirmed new worktree, awaiting initial canonical creation. */
  pendingInitialCreation?: boolean;
  /**
   * Foreground-first delivery: main left this chat's message bodies out of
   * this window's pushes (`messages.omitted`), so the cached rows may be old.
   * Renderer-only, never persisted; only a successful catch-up read clears it.
   */
  transcriptStale?: true;
  /** Renderer-only subagent root summary retained after eviction; never persisted. */
  evictedSubagentRoot?: {
    native: LoadedSubagentSummary;
    hasWorkflowLaunches: boolean;
    workflowLocations: readonly WorkflowRunLocation[];
  };
  /** Required at runtime; `PersistedChatTab.planMode` is optional. */
  planMode: boolean;
  /** Required at runtime; `PersistedChatTab.thinkingLevel` is optional. */
  thinkingLevel: ThinkingLevel;
  modelConfig: ResolvedAgentModelConfig;
  fastModeExplicit: boolean;
  /**
   * Renderer-only marker on file tabs cloned by the explicit Branch-from
   * flow. It lets an inactive transferred tab mounted after `git-ready` still
   * wait for and recheck after the destination's relevant setup script. The
   * persistence serializer intentionally omits it. A renderer restart during
   * setup reconstructs retry eligibility from the restored active script-run
   * snapshot instead.
   */
  recheckAfterWorktreeSetup?: boolean;
  /** Required at runtime; `PersistedChatTab.proposalMode` is optional. */
  proposalMode: 'optional' | 'required';
  /** SDK session ID for resuming the conversation after app restart. */
  sdkSessionId?: string;
  codexReconstructionSeedId?: string;
  /** Cleared after Claude emits init for the forked provider session. */
  claudeForkSessionOnNextSend?: boolean;
  /**
   * Absolute path to a synthetic markdown attachment generated by the
   * "Revert" action that summarizes the rolled-back changes. The renderer
   * prepends this to `attachmentPaths` on the next user message; cleared
   * on send.
   */
  pendingRevertAttachmentPath?: string;
  readOnly?: boolean;
  /** The tool this chat was imported from by the external project import. */
  importedFrom?: ExternalProjectProvider;
  /**
   * Main-owned recovery record for a turn the provider reported as complete
   * while producing no visible output (CAN-2307). Projected verbatim from
   * `ChatRuntimeState.emptyCompletionRecovery` by the canonical runtime patch,
   * so it clears itself as soon as late output reconciles the turn or the user
   * starts a new one. The renderer never fabricates or auto-clears it.
   */
  emptyCompletionRecovery?: EmptyCompletionRecovery;
  staleSessionDetected?: StaleSessionInfo;
  /** Transient original session id retained so a false stale-session hit can recover. */
  staleSessionResumeId?: string;
  /** Tracks whether the current in-flight turn began as a resume attempt. */
  lastTurnWasResumeAttempt?: boolean;
  /** Tracks whether the current in-flight turn was cancelled from the UI. */
  cancelRequestedByUser?: boolean;
  /**
   * Explicit Resume offer for a turn the user stopped (CAN-3137). Set only
   * when main's `chat:cancel` reports the stopped turn as resumable; cleared
   * when the resume dispatches, when main reports the offer stale, or when a
   * new turn starts. Transient: never persisted, because main's offer does not
   * survive a restart either.
   */
  stoppedTurnResume?: StoppedTurnResumeState;
  /**
   * Set while Force is cancelling the active turn so the first cancellation
   * terminal event drains the top queued message immediately.
   */
  forceQueuedMessageCancelPending?: boolean;
  /**
   * Suppresses the duplicate cancellation terminal that can arrive from the
   * cancelled old turn after a forced queued message has already started.
   */
  ignoreNextCancellationTerminal?: boolean;
  /** Tab has new activity the user hasn't seen yet. */
  unread?: boolean;
  /**
   * The current `unread` came from the user's "Mark as unread" rather than
   * unseen output. Meaningful only while `unread` is true; persisted.
   */
  unreadMarkedManually?: boolean;
  /**
   * The current `unread` was raised by an unanswered ask-user question on a
   * non-visible tab, not by a completed turn. Answering the last unanswered
   * question clears that unread again; a completed-turn unread never carries
   * this marker and so survives the answer. Transient, not persisted.
   */
  unreadRaisedByQuestion?: boolean;
  /**
   * The current in-flight turn exposed the auto-archive toggle. Kept transient
   * so disabling auto-archive preserves the button only until the turn ends.
   */
  autoArchiveToggleVisible?: boolean;
  /** Injected organization-memory facts keyed by their sent user message id. */
  memoryByMessageId?: Record<string, AppliedOrgMemoryTurn>;
  /** Timestamp of the last SDK event received (transient, not persisted). */
  lastEventAt?: number;
  /** Live todo list from the agent's TodoWrite calls (transient, not persisted). */
  currentTodos?: TodoItem[];
  /** Live task list from Claude TaskCreate/TaskUpdate calls (transient, not persisted). */
  currentTaskTodos?: TodoItem[];
  /** Files selected for the next message (transient, not persisted). */
  pendingAttachments?: AttachmentMeta[];
  /**
   * Composer-local one-time scheduled-send selection. Held on the tab and
   * persisted with draft metadata so switching tabs or restarting does not drop
   * a chosen schedule. `runAt` is an ISO 8601 future local time. Absent means
   * no scheduled send is staged.
   */
  scheduledSendDraft?: { runAt: string };
  /**
   * Marks a tab created from a queued hook-chat event whose start has not
   * yet been emitted. Stripped by `toPersistedTabs` and cleared when the
   * subsequent start event replaces the placeholder. Transient: a renderer
   * reload while the hook is queued drops the placeholder, matching the
   * existing setup-queue limitation.
   */
  queuedHookPlaceholder?: boolean;
  /**
   * The hook that queued this placeholder. Presented as the "Chat initiated
   * by … hook" banner while the placeholder waits (see `presentedMessages`)
   * without adding a transcript message, so lone-placeholder checks keep
   * treating the tab as empty. Dropped with the placeholder on start.
   */
  queuedHookInfo?: { triggerName: string; timestamp: number };
  /**
   * Index of the queued message currently being edited inline. While set to
   * `0`, the post-turn flush of `queuedMessages[0]` is suppressed so the
   * message can't slip out from under the editor. Transient, not persisted.
   */
  editingQueuedMessageIndex?: number;
  /** Do not steal focus after an intentional move during acquisition. */
  editingQueuedMessageFocusAllowed?: boolean;
  pendingQueuedMessageEditId?: string;
  /**
   * Set while a deferred-tools reload is interrupting-and-resuming this tab's
   * turn (see {@link DeferredToolsReloadTabState}). Holds the tab `streaming`
   * across the provider-session gap, lets the intermediate internal cancellation
   * be ignored, and carries the reused user message id for the hidden
   * continuation. Transient, not persisted.
   */
  deferredToolsReload?: DeferredToolsReloadTabState;
}

export interface PendingQuestion {
  delivery?: 'async';
  dismissedAt?: number;
  requestId: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  questions: McpAskUserEvent['questions'];
  answers?: McpQuestionAnswer[];
  answeredAt?: number;
  /**
   * Optional deterministic correlation id carried over from the IPC event.
   * Used by the transcript matcher to pair this pending card with a
   * specific `tool_use` block (Codex dynamic + built-in ask-user paths).
   * When absent (Claude MCP path), the renderer matches by identical ordered
   * question text, and attaches nothing when several records match.
   */
  toolUseId?: string;
}

export interface PendingPlanExit {
  requestId: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  source: AgentProviderType;
  toolInput: Record<string, unknown>;
}

export interface WorktreeChatState {
  tabs: ChatTab[];
  activeTabId: string;
  /** Last editable chat selected, retained while a file tab has focus. */
  lastActiveEditableChatId?: string;
  /** Last provider observed when a chat tab was active, retained across file focus. */
  lastActiveChatProvider?: AgentProviderType;
}

/**
 * Window event dispatched to ask the worktree chat tab bar to open the
 * read-only archive transcript viewer for a specific archived chat. Consumed by
 * `ChatTabBar`. Used by the unread-chat toast for auto-archived chats.
 */
export const WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT =
  'canopy:worktree-chat-open-archive-transcript';

export interface WorktreeChatOpenArchiveTranscriptDetail {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/** Renderer-only invalidation state; canonical transcript revisions remain server-owned. */
export interface DelegationStreamScopeHints {
  epoch: number;
  runs: Record<string, { streamRevision: number; cardRevision: number }>;
}

/** One delegation run's key in {@link DelegationStreamScopeHints.runs}. */
export function delegationStreamRunKey(
  chatId: string,
  delegationId: string,
  runGeneration: number,
): string {
  return `${chatId}:${delegationId}:${runGeneration}`;
}
