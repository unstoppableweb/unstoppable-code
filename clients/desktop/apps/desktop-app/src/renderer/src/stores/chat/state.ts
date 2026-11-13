import type { FileDiffContext } from '@canopy/desktop-shared/types/code-review';
// Chat store state contract, split into per-domain slices. ChatState is the
// intersection of all slices; the store itself is still a single Zustand
// store so cross-domain set() calls remain atomic.
import type { Descendant } from 'slate';
import type {
  AdhocMultiRepoCombineResponse,
  AgentModelConfig,
  AgentProviderType,
  ApprovalMode,
  ApprovalPromptDecision,
  ApprovalAutoResolvedEvent,
  ApprovalRequestEvent,
  ApprovalRuleAddedEvent,
  ArchivedChatSummary,
  AttachmentMeta,
  ChatAttachmentPromptContext,
  ChatBillingFramework,
  ChatEvent,
  ChatQueueUpdatedEvent,
  ChatInterfaceMode,
  ChatModel,
  ModelHarness,
  ChatSessionImportedEvent,
  ChatTabPluginSelections,
  CodexSpeed,
  PluginSelectionTombstones,
  ClaudeTerminalScheduledPromptEvent,
  FileReference,
  FileTabViewMode,
  HookChatTabStartedEvent,
  HookChatQueueRemovedEvent,
  McpAskUserEvent,
  McpQuestionAnswer,
  ChatCommand,
  ChatCommandResult,
  ChatRuntimeState,
  ChatStateChangedEvent,
  ModelDefaultsByProvider,
  ModelRegistrySnapshot,
  PlanExitRequestEvent,
  SharedRunMetadata,
  ThinkingLevel,
  WorktreeDiscoveryEvent,
  WorktreeSelection,
  DeferredToolsReloadEvent,
  DeferredToolsReloadScopeKey,
  PreferencesData,
  WorktreeChatBadgesSummary,
} from '@canopy/desktop-shared/types';
import type { CodexContextWindowSetting } from '@canopy/execution-engine/lib/codex-context-window';
import type {
  TurnFeedbackRating,
  TurnFeedbackReason,
  TurnFeedbackSummary,
} from '@canopy/protocol/turn-feedback';
import type { AgentArtifactCarryReceiptV1 } from '@canopy/desktop-shared/types/agent-artifacts';
import type { BillingLane } from '@canopy/desktop-shared/lib/default-model-lane';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { ClaudeTerminalClientState } from '@/stores/claudeTerminalStore';
import type { ForkedPanelTabBinding } from '@canopy/desktop-shared/panels/fork-layout';
import type {
  AddEditorSelectionDetail,
  EditorSelectionContext,
} from '@/lib/editorSelectionContext';
import type { InlineFailure } from '@/lib/inline-app-error';
import type {
  ChatActionTarget,
  ChatTab,
  ClaudeTerminalLaunchOptions,
  CreateTabTarget,
  DelegationStreamScopeHints,
  PendingPlanExit,
  PendingQuestion,
  ProvisionalFirstSendFailure,
  QueuedChatMessage,
  SendMessageDispatchOptions,
  WorktreeChatState,
} from './types';
import type { ChatScopeSyncStatus } from './revisioned-sync';
import type { ChatCommandDisposition } from './revisioned-commands';
import type { ProvisionalFirstSendInput } from './provisional-first-send';

/**
 * Transient, per-scope user-facing notice raised by the revisioned command
 * path (stale destructive conflict / non-conflict command failure). Cleared
 * on dismissal or when the scope refreshes.
 */
export interface ChatStateNotice {
  kind: 'conflict' | 'command_failed';
  message: string;
}

/**
 * Read-only revisioned projection of main-owned chat state (frontend plan).
 * The renderer hydrates from revisioned snapshots, applies committed deltas
 * in order, issues typed commands, and keeps only presentation state local.
 */
export interface ChatRevisionedSlice {
  delegationStreamHints: Record<string, DelegationStreamScopeHints>;
  /** Per-scope sync lifecycle keyed by `projectId/worktreeId`. */
  chatStateSync: Record<string, ChatScopeSyncStatus>;
  /** Canonical runtime state per chat id from committed snapshots/deltas. */
  runtimeByChatId: Record<string, ChatRuntimeState>;
  /** Transient per-scope recovery notices keyed by `projectId/worktreeId`. */
  chatStateNotices: Record<string, ChatStateNotice>;
  /** Route one committed `chat:state-changed` event into the projection. */
  handleChatStateChanged: (event: ChatStateChangedEvent) => void;
  /**
   * Attempt revisioned hydration for a scope. Returns 'installed' when the
   * canonical snapshot now backs the projection, 'unavailable' when the main
   * process does not (yet) expose the revisioned chat service, and 'failed'
   * on a load error (the caller must show the load-error treatment, never a
   * blank starter chat).
   */
  hydrateChatScopeRevisioned: (
    projectId: string,
    worktreeId: string,
    /** `speculative` (prefetch): no starter chat and no snapshot auto-archive
     * until the scope is loaded. */
    options?: { speculative?: boolean },
  ) => Promise<'installed' | 'unavailable' | 'failed'>;
  /** Manual retry for the inline refresh-error treatment. */
  retryChatStateRefresh: (projectId: string, worktreeId: string) => void;
  /** Re-read a live scope through the revision-guarded snapshot refresh. */
  refreshChatScopeRevisioned: (projectId: string, worktreeId: string) => void;
  /** Stop tracking a scope (idle unload / worktree removal). */
  releaseChatScopeRevisioned: (projectId: string, worktreeId: string) => void;
  /** Dismiss the transient conflict/command-failure notice for a scope. */
  dismissChatStateNotice: (projectId: string, worktreeId: string) => void;
  /**
   * Submit one typed command with optional optimistic-overlay and revision
   * sequencing hooks. `rollback` undoes exactly this command's optimistic
   * effect; conflicts refresh the view and are never auto-retried.
   */
  dispatchChatCommand: (
    scope: { projectId: string; worktreeId: string },
    command: ChatCommand,
    options?: {
      rollback?: () => void;
      reconcile?: (result: ChatCommandResult) => void;
      expectedRevision?: number;
      /** Stable id for replay-safe commands such as watcher deliveries. */
      commandId?: string;
      onResult?: (result: ChatCommandResult) => void;
      /** Treat an idempotent command's not-found result as success. */
      acceptNotFound?: boolean;
      /**
       * The caller shows its own failure, as the question card does, so a
       * rejected or failed command raises no chat-wide notice.
       */
      callerReportsFailure?: boolean;
    },
  ) => Promise<ChatCommandDisposition>;
}

/** Which chat tabs a registry reconcile may rewrite, and for whom. */
export interface ModelRegistryOwnerScope {
  /** Owner of the active work; `undefined` applies the legacy union. */
  owner: WorkOwner | undefined;
  /** Display name of the owner's organization, for the change notice. */
  organizationName?: string;
  /** Whether the owner's organization makes its gateway the only route. */
  gatewayEnforced?: boolean;
  /** Organizations whose gateway routes satisfy an unknown-owner union. */
  gatewayEnforcingOrganizationIds?: readonly string[];
  /** Whether a tab's immutable session owner belongs to `owner`. */
  isTabInOwnerScope: (
    projectId: string,
    executionContext: string | undefined,
    hasConversationContent: boolean,
  ) => boolean;
}

export interface ChatModelsSlice {
  /** Unconfirmed picker intent, keyed by project/worktree/chat, never persisted. */
  pendingModelChanges: Record<string, { requestId: string; model: ChatModel }>;
  /** Cached per-provider + overall model/thinking defaults from preferences. */
  modelDefaults: {
    chatProvider: AgentProviderType;
    chatModelByProvider: ModelDefaultsByProvider;
    worktreeProvider: AgentProviderType;
    worktreeModelByProvider: ModelDefaultsByProvider;
    /**
     * Default chat interface mode applied to new Claude-backed worktree
     * chats (created directly by the user, or by switching an unstarted
     * Codex/Ollama chat onto a Claude model). Codex- and Ollama-backed
     * chats ignore this value — the managed Claude Code terminal
     * experience is Claude-specific.
     */
    defaultChatInterfaceMode?: ChatInterfaceMode;
    /** Default chat interface mode applied to new Claude-backed standalone chats. */
    defaultStandaloneChatInterfaceMode?: ChatInterfaceMode;
    /** Default chat interface mode applied to new Claude-backed App Advisor chats. */
    defaultAppAdvisorInterfaceMode?: ChatInterfaceMode;
    /** Default model applied to new App Advisor chats (entry-keyed targets). */
    appAdvisorModel?: ChatModel;
    /** Default thinking level applied to new App Advisor chats. */
    appAdvisorThinkingLevel?: ThinkingLevel;
    codexFastModeDefaultEnabled?: boolean;
    modelConfigDefaultsByProvider?: Partial<
      Record<AgentProviderType, AgentModelConfig>
    >;
    /**
     * The user's last explicit "Use AI Credits" picker choice
     * (`PreferencesData.lastChatBillingFramework`), used to seed new chat tabs
     * and worktrees. Unset means "never chosen" — new chats fall back to
     * today's behavior.
     */
    billingFramework?: ChatBillingFramework;
    /**
     * Last lane the main process resolved with no provisional facts, PER
     * DEFAULT SCOPE (`PreferencesData.lastResolvedDefaultLaneByScope`). Held so
     * an in-flight auth probe keeps the previous answer instead of flip-flopping
     * the default.
     *
     * Per scope because the chat and worktree defaults can prefer different
     * providers and therefore resolve to different lanes; one shared slot let a
     * surface hold the other surface's answer.
     */
    lastResolvedLaneByScope?: {
      chat?: BillingLane;
      worktree?: BillingLane;
    };
  } | null;
  loadModelDefaults: () => Promise<void>;
  applyModelDefaults: (preferences: PreferencesData) => void;
  ensureModelDefaultsLoaded: () => Promise<ChatState['modelDefaults']>;
  setModel: (
    model: ChatModel,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => void;
  /**
   * Re-read a chat tab's persisted model/provider pair and apply it to the
   * in-memory tab (CAN-1305).
   *
   * `portal.standalone_chat.set_model` writes the cowork tab file directly in
   * main and announces the change over `standaloneChatMetaUpdated`; it never
   * round-trips through this renderer's own `setModelAndWait` path, so the
   * composer dropdown would otherwise keep showing the previous model until
   * the scope was reloaded. Resolves to `true` when an in-memory tab was
   * actually updated.
   */
  syncPersistedTabModel: (
    projectId: string,
    chatId: string,
  ) => Promise<boolean>;
  /**
   * Turn per-turn Auto routing on or off for one chat (CAN Auto routing).
   *
   * Auto is a SELECTION MODE, not a model: `mode: 'auto'` leaves the concrete
   * `model` in place so the chat keeps a deterministic fallback; the chip
   * reads plain `Auto` and each routed turn names its model. Choosing any concrete model returns the chat to
   * manual through the ordinary model-change path, which clears the mode in
   * main, so this is only for entering Auto and for a durable capability loss.
   */
  setModelSelectionMode: (
    mode: 'auto' | 'manual',
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<void>;
  /** True when accepted and still the latest selection for the captured chat. */
  setModelAndWait: (
    model: ChatModel,
    target?: { projectId: string; worktreeId: string; chatId: string },
    executionHarness?: ModelHarness,
    billingFramework?: ChatBillingFramework,
  ) => Promise<boolean>;
  /**
   * `ownerScope` names the active owner and which tabs it covers. `modelPolicy`
   * is that owner's policy, so only tabs in scope are rewritten against it.
   *
   * `modelPolicy` is the org model-policy set resolved by `modelCatalogStore`
   * (CAN-2314), in the opaque encoding `isModelBlocked` consumes. Optional and
   * absent for every user not in an enforcing org, which keeps this the
   * unchanged Ollama-reconcile path for the overwhelming majority.
   */
  reconcileModelRegistry: (
    snapshot: ModelRegistrySnapshot,
    modelPolicy?: ReadonlySet<string>,
    ownerScope?: ModelRegistryOwnerScope,
  ) => void;
  applyModelConfigDefaults: (
    defaults: Partial<Record<AgentProviderType, AgentModelConfig>>,
  ) => void;
  /**
   * Request an exact Codex speed for the chat's next turn. Updates the tab
   * optimistically (speed with its derived `fastMode`, marked explicit), then
   * commits through the existing Codex fast-mode channel with the exact
   * `speed`. A no-op for non-Codex chats.
   */
  setSpeed: (
    speed: CodexSpeed,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<void>;
  /**
   * Choose a Codex chat's context window. Shows it optimistically, so a
   * message sent before main echoes the patch already carries it, then
   * commits `modelConfig.contextWindow` through `chat.patch_tab_settings`.
   */
  setContextWindow: (
    contextWindow: CodexContextWindowSetting,
    target: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<void>;
  /**
   * Legacy boolean adapter: `true` requests Fast and `false` Regular,
   * replacing any current speed (including Ultra fast).
   */
  setFastMode: (
    enabled: boolean,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<void>;
  /**
   * Legacy boolean toggle: flips the derived `fastMode`, so Ultra fast (whose
   * boolean projection is `false`) toggles to Fast and Fast to Regular.
   */
  toggleFastMode: (target?: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => void;
  /** @deprecated Use setFastMode. */
  setCodexFastMode: (
    enabled: boolean,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => void;
  /** @deprecated Use toggleFastMode. */
  toggleCodexFastMode: (target?: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => void;
  cycleThinkingLevel: (target?: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => void;
  setThinkingLevel: (
    level: ThinkingLevel,
    target?: {
      projectId: string;
      worktreeId: string;
      chatId: string;
    },
  ) => Promise<void>;
}

export interface ChatDeferredToolsSlice {
  /** Defaults for the per-chat deferred-tools toggle on newly-created tabs. */
  deferredToolsDefaults: Pick<
    PreferencesData,
    | 'deferredToolsWorktreeChatsEnabled'
    | 'deferredToolsStandaloneChatsEnabled'
    | 'deferredToolsAppAdvisorEnabled'
    | 'deferredToolsPipelineAssistantEnabled'
  > | null;
  handleDeferredToolsReloadEvent: (event: DeferredToolsReloadEvent) => void;
  cancelDeferredToolsReload: (
    scope: DeferredToolsReloadScopeKey,
    request: { requestId: string; toolCallId: string },
  ) => void;
  applyDeferredToolsDefaults: (preferences: PreferencesData) => void;
}

export type BranchTabResult =
  | { status: 'created'; projectId: string; worktreeId: string }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; retryable: boolean };

/**
 * Outcome of {@link ChatTabsSlice.continueTabOnProvider}. `failed` carries the
 * user-facing reason so the confirm dialog can stay open and show it instead of
 * dismissing on a failure the user never saw.
 */
export type ContinueTabOnProviderResult =
  | { status: 'created'; chatId: string }
  | { status: 'failed'; message: string };

export interface ChatTabsSlice {
  selectedWorktree: WorktreeSelection | null;
  /**
   * The non-standalone worktree that was selected immediately before the user
   * (or a code path like the failed-pipeline Debug button) entered the
   * standalone-chat context. Used by StandaloneChatPage to restore the prior
   * worktree on unmount when its mount-time capture would otherwise miss it
   * because `selectedWorktree` was already overwritten before navigation.
   */
  selectedWorktreeBeforeStandaloneChat: WorktreeSelection | null;
  worktreeChats: Record<string, WorktreeChatState>;
  /**
   * Chat tabs whose close is waiting on an asynchronous archive/cancel write.
   * The panel sync bridge uses this to avoid recreating a panel that the user
   * just closed while the authoritative chat mutation is still in flight.
   */
  closingChatTabs: Readonly<Record<string, ReadonlySet<string>>>;
  /**
   * Chat tab IDs whose panel is currently COLLAPSED (icon-only bar), fed by
   * the chat⇄panel sync bridge. A collapsed chat is not on screen, so it is
   * treated as not-visible for unread: a completed turn (or an ask-user
   * request) on such a chat marks it unread even when it is the worktree's
   * active tab. Empty when no chat panel is collapsed. Bridge-owned — do not
   * mutate from chat actions.
   */
  hiddenChatTabIds: ReadonlySet<string>;
  /** Replace {@link hiddenChatTabIds} (bridge-owned; no-op when unchanged). */
  setHiddenChatTabIds: (ids: ReadonlySet<string>) => void;
  /**
   * Idempotently persist watched pipeline-run and GitHub workflow-run
   * snapshots for one user turn.
   */
  recordAgentArtifactCarry: (
    target: { projectId: string; worktreeId: string; chatId: string },
    userMessageId: string,
    receipts: readonly AgentArtifactCarryReceiptV1[],
  ) => void;
  selectWorktree: (
    projectId: string,
    worktreeId: string,
    options?: {
      deferTabLoad?: boolean;
      newlyCreated?: boolean;
      /**
       * An implicit entry (a sidebar row): open on the tab needing the user
       * (question, approval, plan review, then newest unread) instead of the
       * persisted active tab. Explicit chat navigation leaves this unset.
       */
      attentionLanding?: boolean;
    },
  ) => void;
  deselectWorktree: () => void;
  loadTabs: () => Promise<void>;
  loadTabsForTarget: (
    projectId: string,
    worktreeId: string,
    defaults?: {
      model?: ChatModel;
      thinkingLevel?: ThinkingLevel;
      defaultChatInterfaceMode?: ChatInterfaceMode;
      modelConfig?: AgentModelConfig;
      pluginSelections?: ChatTabPluginSelections;
      deferredToolsAllowed?: boolean;
      skipActiveSessions?: boolean;
    },
  ) => Promise<void>;
  ensureSelectedWorktreeTabsLoaded: (timeoutMs?: number) => Promise<boolean>;
  /** Eagerly load chat tabs for all worktrees so sidebar badges render on startup. */
  loadAllWorktreeTabs: (
    worktrees: { projectId: string; worktreeId: string }[],
  ) => Promise<void>;
  /**
   * Flush and drop hydrated renderer state for idle, background chats.
   * Selected chats and chats with live/attention state are retained.
   */
  unloadIdleWorktreeChats: (now?: number) => Promise<void>;
  createTab: (target?: CreateTabTarget) => void;
  createTabWithId: (id: string) => void;
  /**
   * Ensure a scoped worktree has at least one real chat tab and a valid active
   * chat tab. Used by embedded chat surfaces that must never render without a
   * composer target, such as the Plan Explore modal.
   */
  ensureWorktreeHasChatTab: (
    target: ChatActionTarget,
    options?: {
      preserveActiveTab?: boolean;
      eager?: boolean;
      approvalMode?: ApprovalMode;
    },
  ) => Promise<void>;
  /**
   * Fork an existing chat tab into a sibling tab with a deep-cloned snapshot
   * of its messages and configuration. The new tab gets a fresh id and a
   * "Fork:" title prefix. Claude forks carry the source SDK session until the
   * next turn diverges; Codex forks start without an SDK session and backfill a
   * forked thread id in the background. Disabled for file tabs; streaming
   * sources are disallowed unless `options.includeActiveTurn` is true (clone
   * the current live session snapshot and preserve provider context) or
   * `options.forkAfterUserMessageId` is provided (truncate to that completed
   * turn and drop provider context because the source has advanced past the
   * fork point). No-op when the source tab cannot be found.
   */
  forkTab: (
    sourceTabId: string,
    target?: ChatActionTarget,
    options?: {
      forkAfterUserMessageId?: string;
      includeActiveTurn?: boolean;
      sourceSdkSessionId?: string;
      syncWarning?: string;
    },
  ) => void;
  /**
   * Continue an existing chat on the OTHER execution harness. Claude and Codex
   * sessions are mutually unintelligible (provider-bound reasoning signatures),
   * so this is not a fork: it snapshots the transcript, generates an LLM
   * handoff summary, and stages it as a `pendingSystemInstructions` entry on a
   * brand-new chat whose provider/model are the target's.
   *
   * Because the continued chat is a NEW chat id, the main-process
   * `isProviderChangeAllowed` guard is never asked to approve anything.
   *
   * Fails closed: when the summary call rejects or returns nothing, NO tab is
   * created, so a continued chat never renders history the target model has not
   * actually received. Unlike `forkTab` the config is normalized for the target
   * provider rather than copied, and `sdkSessionId`,
   * `claudeForkSessionOnNextSend`, `queuedMessages`, `pendingPlanExit`,
   * `interfaceMode` and `claudeTerminal` are never carried.
   */
  continueTabOnProvider: (
    sourceTabId: string,
    targetModel: ChatModel,
    target?: ChatActionTarget,
    billingFramework?: ChatBillingFramework,
  ) => Promise<ContinueTabOnProviderResult>;
  /**
   * Like `forkTab`, but also creates a brand-new worktree branched from the
   * target worktree and lands the cloned chat tab inside it. The target
   * defaults to the selected worktree; portal commands supply their own so a
   * non-selected worktree can be branched. After the cloned tab is installed
   * the renderer transitions to the new worktree, so the user ends up there
   * with the cloned conversation active. Plan-approval state on the source tab
   * (pendingPlanExit, trackedPlanId, trackedPlanReviewStatus,
   * hasOutstandingProposal) is preserved so the user can act on the plan in
   * the new worktree. Disabled for file tabs, empty chats, and the
   * standalone-chat project; streaming sources are disallowed unless
   * `options.forkAfterUserMessageId` is provided (same truncation semantics as
   * `forkTab`).
   */
  branchTab: (
    sourceTabId: string,
    target?: ChatActionTarget,
    options?: {
      forkAfterUserMessageId?: string;
      cancelled?: () => boolean;
      /**
       * Invoked at the point of no return — after the final cancellation
       * check, immediately before the new worktree is created. Lets the
       * caller stop treating a deadline as authoritative once side effects
       * are guaranteed to happen.
       */
      onCommitted?: () => void;
    },
  ) => Promise<BranchTabResult>;
  /**
   * Open (or focus) a file viewer tab in the currently selected worktree.
   * Dedup'd by absolute path — calling twice with the same path switches to
   * the existing tab instead of creating a duplicate. File tabs do not
   * participate in command discovery or model-defaults sync.
   *
   * A tab this call creates starts in, by precedence: `initialViewMode`, the
   * file's remembered Source/Formatted/Table choice from this renderer
   * session, then the file kind's default (Markdown/HTML formatted, CSV as a
   * table, otherwise unset for the raw fallback). Callers pass
   * `initialViewMode` only for a genuine override, never for a kind default.
   * Every mode input is ignored when the file is already open, so reopening
   * never overrides the mode the user last chose there.
   *
   * `activate: false` opens or finds the tab without selecting it, keeping
   * the user's current tab (background agent presentation).
   */
  openFileTab: (
    params: {
      absolutePath: string;
      filename: string;
      initialViewMode?: FileTabViewMode;
    },
    target?: { projectId: string; worktreeId: string },
    options?: { activate?: boolean },
  ) => string | null;
  /**
   * Create a new, empty file tab (`filePath: ''`) in the selected worktree.
   * The bound panel renders the file-picker empty state until a file is
   * assigned via {@link assignFileTab}. Never dedupes — every call creates a
   * fresh tab.
   */
  createEmptyFileTab: (target?: {
    projectId: string;
    worktreeId: string;
  }) => string | null;
  /**
   * Assign a file into an existing (typically empty) file tab. If another
   * file tab already shows `absolutePath`, that tab is activated instead and
   * its id returned; otherwise the target tab's path/title are updated in
   * place and the tab id is returned. The assigned file's view mode resolves
   * like {@link openFileTab} without an explicit mode, replacing any mode the
   * tab held before.
   */
  assignFileTab: (
    tabId: string,
    params: {
      absolutePath: string;
      filename: string;
    },
    target?: { projectId: string; worktreeId: string },
  ) => string | null;
  /**
   * Persist the raw/preview/table mode selected inside an open file tab so
   * switching away and back restores the same view. A successfully applied
   * non-diff mode is also remembered for the file for the rest of the
   * renderer session; closing a file tab remembers its last non-diff mode the
   * same way, so a later reopen restores it. Entering Diff also preserves a
   * restored reading mode without replacing a choice already made in that tab.
   * Diff itself is never remembered.
   */
  setFileTabViewMode: (
    tabId: string,
    mode: FileTabViewMode,
    target?: { projectId: string; worktreeId: string },
    diffContext?: FileDiffContext,
  ) => void;
  closeTab: (
    tabId: string,
    options?: {
      force?: boolean;
      // When provided, close the tab in this worktree instead of the
      // currently selected one. Used by async save-then-close paths
      // (Auto Save on close, modal Save / Don't Save) so worktree
      // switches during a pending save still close the originating tab.
      projectId?: string;
      worktreeId?: string;
    },
  ) => void;
  /**
   * Batch-close tabs in the active worktree (or the worktree named by
   * `target` when provided). Tabs not in `targetIds` are left alone.
   * "Protected" tabs are silently skipped: chat tabs that are streaming,
   * awaiting a plan-exit decision, or have queued messages, and file tabs
   * with unsaved edits. The active tab falls back to the closest remaining
   * tab via the same logic as `closeTab`.
   */
  closeTabs: (
    targetIds: string[],
    target?: { projectId: string; worktreeId: string },
  ) => void;
  switchTab: (
    tabId: string,
    target?: { projectId: string; worktreeId: string },
  ) => void;
  /**
   * Move a tab to a new position within the active worktree's tab list
   * (or the worktree named by `target` when provided). `beforeTabId === null`
   * appends to the end; otherwise inserts immediately before the named tab.
   * No-op when ids are missing or unchanged. Insertion is clamped to the
   * dragged tab's section (pinned tabs stay before unpinned tabs).
   */
  reorderTabs: (
    fromTabId: string,
    beforeTabId: string | null,
    target?: { projectId: string; worktreeId: string },
  ) => void;
  /**
   * Toggle the persisted `pinned` flag on a tab in the active worktree (or
   * the worktree named by `target` when provided). Pinning moves the tab to
   * the end of the pinned section; unpinning moves it to the front of the
   * unpinned section. Persisted so it survives navigation and restart.
   */
  setTabPinned: (
    tabId: string,
    pinned: boolean,
    target?: { projectId: string; worktreeId: string },
  ) => void;
  /**
   * Set or clear (`null` or blank) the user-owned `customTitle` of a chat tab
   * in the active worktree, or the worktree named by `target`. The draft is
   * trimmed; an unchanged value, a missing tab, a file tab, or an over-limit
   * name is a no-op. Resolves `true` only once the rename is durable (or
   * nothing needed saving).
   */
  renameTab: (
    tabId: string,
    customTitle: string | null,
    target?: { projectId: string; worktreeId: string },
  ) => Promise<boolean>;
  /** Prevent any further persisted tab writes for a worktree during archive/delete. */
  suppressWorktreePersistence: (projectId: string, worktreeId: string) => void;
  /** Re-enable persisted tab writes for a worktree after a failed archive/delete. */
  resumeWorktreePersistence: (projectId: string, worktreeId: string) => void;
  /** Immediately persist a worktree's tabs, bypassing the debounce timer. */
  flushWorktreeTabs: (projectId: string, worktreeId: string) => Promise<void>;
  /** Drop cached tabs for a worktree and reload if it is currently selected. */
  reloadWorktreeTabs: (projectId: string, worktreeId: string) => Promise<void>;
  /**
   * Fork every live chat tab and copy every file tab from one worktree into a
   * newly-created sibling worktree. Chat ids are regenerated and provider
   * continuity follows the normal fork rules; file paths are rewritten from
   * the source checkout root to the destination checkout root. Archived chats
   * are intentionally not read or copied. Returns the source→destination tab
   * bindings used to retarget the copied panel layout without reordering it.
   */
  forkOpenTabsToWorktree: (target: {
    projectId: string;
    sourceWorktreeId: string;
    destinationWorktreeId: string;
  }) => Promise<ReadonlyMap<string, ForkedPanelTabBinding>>;
  /**
   * Migrate cached chat / file tabs from a source worktree to the adhoc
   * multi-repo destination worktree described by `response`. Preserves chat
   * continuity (transcript history, plan state, model/provider settings,
   * plugin selections, discovery, usage, turn diffs, pending plan state)
   * and provider continuity (Claude carries `sdkSessionId`; Codex calls
   * `chat.forkCodexThread` in the background). File tabs are rewritten via
   * `response.filePathRewrites`; tabs whose paths fall outside any mapped
   * root are dropped. Migrated tabs MERGE into any existing destination
   * chat state (existing tabs first, deduped by tab id / file path) rather
   * than replacing it, so the join-existing flow can run this twice into
   * the same destination and update-mode joins never wipe the live source
   * worktree's own tabs. The source worktree's cached chat state and unread
   * marker are cleared and, when the destination is the currently selected
   * worktree, its tabs are reloaded. Called by `AddRepoToWorktreeModal`
   * after `projectsStore.combineWorktreeWithWorkspace` resolves.
   */
  migrateWorktreeTabsToAdhocWorkspace: (
    response: AdhocMultiRepoCombineResponse,
  ) => Promise<void>;
  /** Remove all renderer state for a deleted worktree. */
  cleanupWorktree: (projectId: string, worktreeId: string) => void;
  /**
   * Insert a cloned tab into a cowork work entry's tab list. Awaits any
   * in-flight tab hydration for the entry first so the insert is never
   * dropped or clobbered by a concurrent disk load.
   */
  insertClonedStandaloneTab: (
    workspaceId: string,
    entryId: string,
    tab: ChatTab,
    makeActive?: boolean,
    replaceActiveEmpty?: boolean,
  ) => Promise<void>;
}

export interface ChatArchiveSlice {
  /**
   * Archived chats per worktree key (`${projectId}/${worktreeId}`), newest-first.
   * Populated lazily by `loadArchivedChats` and after each archive/restore.
   * Drives the archive icon / popover / modal in the tab bar.
   */
  archivedChats: Record<string, ArchivedChatSummary[]>;
  /**
   * Load the archive summary list for a worktree into `archivedChats[key]`.
   * Best-effort: a missing/failed backend leaves the existing list untouched
   * (the archive icon simply stays hidden). Called from eager hydration and
   * after every archive/restore.
   */
  loadArchivedChats: (projectId: string, worktreeId: string) => Promise<void>;
  /**
   * Restore an archived chat back into the worktree's live tabs. The backend
   * returns the full tab snapshot (with `sdkSessionId` intact so the next send
   * resumes the same provider session) and removes the archive entry; the
   * renderer re-hydrates it with the worktree's resolved model defaults,
   * appends it, makes it active, and refreshes `archivedChats`.
   */
  restoreArchivedChat: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ) => Promise<void>;
  /**
   * Summarize an archived chat into a fresh tab. Reads the archived transcript
   * (non-destructively), generates a handoff summary, opens a new empty tab,
   * and prefills its composer draft with a `[SESSION HANDOFF]` block for the
   * user to review/edit before sending. The archive entry stays put.
   */
  summarizeArchivedChat: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ) => Promise<void>;
  /** Toggle auto-archive for the active turn after the marker was offered. */
  setAutoArchiveForActiveTurn: (
    target: { projectId: string; worktreeId: string; chatId: string },
    enabled: boolean,
  ) => void;
  /**
   * Bring an archived chat back into the live tabs because a new agent response
   * arrived for it after archiving. Unlike `restoreArchivedChat`, this is not a
   * user action: it preserves the `autoArchive` marker so the chat re-archives
   * when its resumed turn finishes, and it does not steal focus.
   */
  unarchiveChatForNewResponse: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ) => Promise<void>;
  /** Clear the unread flag on a single archived chat (e.g. viewer opened). */
  markArchivedChatRead: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ) => Promise<void>;
  /** Clear the unread flag on every archived chat in a worktree. */
  markAllArchivedChatsRead: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
}

export interface ChatMessagingSlice {
  sendMessage: (
    text: string,
    fileReferences?: FileReference[],
    target?: { projectId: string; worktreeId: string; chatId: string },
    inputMode?: 'typed' | 'voice',
    options?: SendMessageDispatchOptions,
  ) => Promise<void>;
  /**
   * Shows a Home first send in its empty, idle destination chat before
   * dispatch (CAN-4742): the echo, a renderer-only turn and the first-message
   * title. Idempotent for the same message id. Returns whether this
   * submission is presented; `false` leaves the tab unchanged. A later
   * `sendMessage` with the same `userMessageId` adopts it.
   */
  presentProvisionalFirstSend: (
    target: { projectId: string; worktreeId: string; chatId: string },
    input: ProvisionalFirstSendInput,
  ) => boolean;
  /** Clears the notice of a cloud send the web core refused (CAN-6364). */
  dismissSendRefusal: (target: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => void;
  /**
   * Retires a presented first send that was never dispatched or queued,
   * restoring the prior title only while this submission still owns it.
   */
  withdrawProvisionalFirstSend: (
    target: { projectId: string; worktreeId: string; chatId: string },
    userMessageId: string,
  ) => void;
  /**
   * Marks the current attempt of a presented first send failed because its
   * model was refused, keeping the prompt and title (CAN-5021).
   * Returns whether that failure is now shown.
   */
  failProvisionalFirstSend: (
    target: { projectId: string; worktreeId: string; chatId: string },
    input: {
      userMessageId: string;
      attemptId: string;
      failure: ProvisionalFirstSendFailure;
      /** Refused before dispatch: the failure replaces its dispatch claim. */
      refusedBeforeDispatch?: boolean;
    },
  ) => boolean;
  /**
   * Claims a failed first send for exactly one retry under `attemptId`.
   * Returns `false` when the failure is gone or already claimed.
   */
  retryProvisionalFirstSend: (
    target: { projectId: string; worktreeId: string; chatId: string },
    input: { userMessageId: string; failureId: string; attemptId: string },
  ) => boolean;
  /** Hands a presented first send to the queue row that now holds it. */
  handOffProvisionalFirstSend: (
    target: { projectId: string; worktreeId: string; chatId: string },
    userMessageId: string,
  ) => void;
  /**
   * Persist the chosen chat-interface surface on a tab. Missing tabs are
   * tolerated as no-ops so this is safe to call from idempotent UI effects
   * (the toggle component). The persistence schedule is reused so older
   * tabs without `interfaceMode` are migrated lazily. Revisioned scopes
   * return their command disposition so action dispatchers can report a
   * structured failure while UI callers rely on the store's inline notice.
   */
  setChatInterfaceMode: (
    tabId: string,
    mode: ChatInterfaceMode,
    target?: { projectId: string; worktreeId: string },
  ) => Promise<ChatCommandDisposition | undefined>;
  /**
   * Launch (or rehydrate) the managed Claude Code terminal for the active
   * chat tab. Idempotent — repeated calls reuse the in-flight or already-
   * resolved runtime in {@link useClaudeTerminalStore}.
   */
  ensureClaudeTerminal: (
    tabId: string,
    target?: { projectId: string; worktreeId: string },
    dimensions?: { cols: number; rows: number },
    initialPrompt?: string,
    options?: ClaudeTerminalLaunchOptions & {
      initialPromptIdempotencyKey?: string;
    },
  ) => Promise<ClaudeTerminalClientState | undefined>;
  /**
   * Tear down the managed Claude Code terminal owned by `tabId` before the
   * renderer dispatches a Canopy-native send. The cleanup IPC must resolve
   * (with the canonical reason) before {@link sendMessage} fires; on failure
   * the caller should surface an error rather than running both owners
   * concurrently.
   */
  cleanupClaudeTerminalForNativeSend: (
    tabId: string,
    target?: { projectId: string; worktreeId: string },
  ) => Promise<void>;
  cancelSession: (target?: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => Promise<void>;
  /**
   * Explicitly resume a turn the user stopped (CAN-3137). Continues the same
   * provider session without re-sending the original user message. No-ops
   * while a resume for the tab is already in flight, so rapid repeated clicks
   * cannot dispatch twice.
   */
  resumeStoppedTurn: (target: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => Promise<void>;
  resetToPoint: (
    userMessageId: string,
    target: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<void>;
  /**
   * Set the working-directory repo for the active multi-repo workspace tab.
   * Pass `undefined` (or `WORKSPACE_ROOT_REPO_ID`) for the workspace root.
   * Callers should only invoke this before the session has started; the UI
   * locks the picker after the first message.
   */
  setSelectedRepoId: (
    selectedRepoId: string | undefined,
    target?: ChatActionTarget & { chatId: string },
  ) => void;
  /**
   * Dispatch a scheduled (automation) prompt forwarded from main for a
   * terminal-backed Claude chat. Runs through the normal terminal send path,
   * which queues until the running turn is idle and relaunches reaped
   * terminals with the prompt as the CLI's initial argument.
   */
  handleScheduledTerminalPrompt: (
    event: ClaudeTerminalScheduledPromptEvent,
  ) => void;
}

/**
 * A failed attempt to edit a queued message, shown on that message's row.
 * `worktreeKey` and `chatId` scope it so a chat keeps at most one.
 */
export interface QueuedMessageEditFailure extends InlineFailure {
  worktreeKey: string;
  chatId: string;
  /** The row's text when it failed; a row whose text changed drops it. */
  text: string;
}

export interface ChatQueueSlice {
  /** Row-level edit failures, keyed by `queuedMessageEditFailureKey`. */
  queuedMessageEditFailures: Readonly<Record<string, QueuedMessageEditFailure>>;
  dismissQueuedMessageEditFailure: (entryKey: string) => void;
  clearQueuedMessage: (
    index: number,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => void;
  forceQueuedMessage: (
    index: number,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => void;
  /**
   * Mark a queued message at `index` as being edited inline, or pass `null`
   * to leave edit mode. While editing index 0, the post-turn queue flush is
   * suppressed; on exit, the queue resumes draining naturally.
   *
   * `expected` is the message the user activated. When given, the target is
   * resolved by that identity rather than `index`, so a queue that advanced
   * since render cannot open a different message; a target that is gone or no
   * longer editable opens nothing and explains why.
   */
  setEditingQueuedMessage: (
    index: number | null,
    target?: { projectId: string; worktreeId: string; chatId: string },
    expected?: QueuedChatMessage,
  ) => Promise<void>;
  /**
   * Apply edited content to the queued message at `index`, leave edit mode,
   * and either restore it to the queue or send it immediately if the agent
   * is currently idle.
   */
  saveEditedQueuedMessage: (
    index: number,
    text: string,
    fileReferences?: FileReference[],
    attachmentPaths?: string[],
    attachmentPromptContexts?: ChatAttachmentPromptContext[],
    inputMode?: 'typed' | 'voice',
    scheduledSendDraft?: { runAt: string },
    target?: { projectId: string; worktreeId: string; chatId: string },
    expected?: QueuedChatMessage,
  ) => void;
  /**
   * Drop renderer-side state for a removed worktree. Closes tabs hydrated by
   * `loadAllWorktreeTabs`, clears `queuedMessages`, removes pending questions
   * / plan exits for the worktree, and clears `selectedWorktree` if it
   * currently points at that worktree (so the renderer doesn't render a
   * stale empty chat for a worktree that no longer exists). Distinct from
   * `cleanupWorktree`, which is the post-archive path.
   */
  dropWorktreeQueuedState: (projectId: string, worktreeId: string) => void;
}

export interface ChatEventsSlice {
  handleChatQueueUpdated: (event: ChatQueueUpdatedEvent) => void;
  handleChatEvent: (event: ChatEvent) => void;
  handleHookQueueRemoved: (event: HookChatQueueRemovedEvent) => void;
  handleHookTabStarted: (event: HookChatTabStartedEvent) => void;
  handleSessionImported: (event: ChatSessionImportedEvent) => void;
  /** Update a chat tab's haiku-generated description. */
  handleTabDescriptionUpdated: (
    projectId: string,
    worktreeId: string,
    chatId: string,
    description: string,
  ) => void;
  /** Re-verify streaming tabs against main-process active sessions to catch stale states. */
  verifyStreamingTabs: () => Promise<void>;
}

export interface ChatQuestionsSlice {
  pendingQuestions: Record<string, PendingQuestion>;
  handleMcpAskUser: (event: McpAskUserEvent) => void;
  answerMcpQuestion: (requestId: string, answers: McpQuestionAnswer[]) => void;
  dismissMcpQuestion: (requestId: string) => void;
  expireMcpQuestion: (requestId: string) => void;
  /**
   * Awaited answer variant for portal-originated mutations. Resolves only after
   * the provider IPC resolves, the desktop accepted/stale-fallback state
   * transitions apply, and the pending save is flushed to disk, so a portal
   * command completion never races ahead of durable answered state. An entry
   * that already carries `answeredAt` resolves as an idempotent success without
   * calling the provider waiter again. Rejects (leaving the question actionable)
   * when the provider IPC rejects.
   */
  answerMcpQuestionAndWait: (
    requestId: string,
    answers: McpQuestionAnswer[],
  ) => Promise<void>;
  /**
   * Awaited dismiss variant for portal-originated mutations. Calls the provider
   * dismiss IPC, removes the entry, and flushes the removal before resolving. A
   * missing/already-removed entry resolves as an idempotent no-op. Rejects
   * (leaving the question actionable) when the provider IPC rejects.
   */
  dismissMcpQuestionAndWait: (requestId: string) => Promise<void>;
}

export interface ChatPlanSlice {
  pendingPlanExits: Record<string, PendingPlanExit>;
  togglePlanMode: (
    target?: {
      projectId: string;
      worktreeId: string;
      chatId: string;
    },
    onActivated?: (enabled: boolean) => void,
  ) => void;
  handlePlanExitRequest: (
    event: PlanExitRequestEvent,
    mode?: 'recover',
  ) => void;
  /**
   * Resolve once the review decision is synchronized into the tracked plan
   * (or that failure is handled); not when the implementation turn finishes.
   */
  approvePlanExit: (requestId: string) => Promise<void>;
  /** Resolves once the dismissal is synchronized or its failure is handled. */
  denyPlanExit: (requestId: string) => Promise<void>;
  /**
   * Call only after the workflow launch succeeded. Resolves once the plan
   * list is reconciled with the approval main recorded for that launch.
   */
  dismissPlanForPipeline: (requestId: string) => Promise<void>;
  markTrackedPlanExecuted: (options: {
    projectId: string;
    worktreeId: string;
    planId: string;
  }) => void;
  /** Clear a restored (post-restart) pendingPlanExit from a tab. */
  dismissRestoredPlanExit: (options?: { keepPlanMode?: boolean }) => void;
  /**
   * Track whether a code-review chat panel is visually open in the takeover
   * modal, keyed by the composite scope key. The code-review scope is not the
   * globally selected worktree, so unread gating needs this explicit
   * visibility signal.
   */
  setCodeReviewChatVisible: (scopeKey: string, visible: boolean) => void;
  /**
   * Record the real `(projectId, worktreeId)` a code-review chat scope key maps
   * to so later unread toasts can resolve a navigation target even after the
   * review modal has closed. The scope key is the `projectId--worktreeId`
   * composite.
   */
  registerCodeReviewOrigin: (
    scopeKey: string,
    projectId: string,
    worktreeId: string,
  ) => void;
  /**
   * Append a pending system instruction to the tab identified by `chatId` so
   * that the next message sent from that tab includes a note about the
   * imported plan document. The instruction is consumed on send (same lifecycle
   * as other `pendingSystemInstructions`). No-op when the tab cannot be found.
   */
  queuePlanImportInstruction: (chatId: string, sourceFilePath: string) => void;
}

export interface ChatApprovalsSlice {
  /** Pending Canopy tool-approval prompts, keyed by requestId. */
  pendingApprovals: Record<string, ApprovalRequestEvent>;
  /**
   * Last resolved approval-mode default per projectId, from
   * `window.api.approvals.getResolvedDefault`. The resolution chain
   * (workspace override -> canopy.json -> surface preference ->
   * `PRODUCT_DEFAULT_APPROVAL_MODE`) only
   * varies by project/workspace, not by worktree, so one cache entry covers
   * every worktree/tab under that project. Used to keep `sendMessage`'s
   * `tab.approvalMode ?? resolvedDefault` fallback synchronous.
   */
  approvalDefaultsCache: Record<string, ApprovalMode>;
  /** Wired to `window.api.approvals.onRequest` at store init beside the mcpAskUser subscription. */
  handleApprovalRequest: (event: ApprovalRequestEvent) => void;
  /** Remove a prompt whose provider session was torn down before the user answered. */
  handleApprovalCancelled: (requestId: string) => void;
  /**
   * Remove a prompt that main already resolved as *approved* because the user
   * widened the chat's approval mode while the card was on screen (CAN-3083).
   *
   * Distinct from `handleApprovalCancelled`, which means the tool was denied.
   * Never calls `window.api.approvals.respond` — main has already settled the
   * request, and re-answering it would be faking a click the user never made.
   * Chat durability stays main-owned, so this writes no snapshot of its own.
   */
  handleApprovalAutoResolved: (event: ApprovalAutoResolvedEvent) => void;
  respondToApproval: (
    requestId: string,
    decision: ApprovalPromptDecision,
  ) => Promise<void>;
  /**
   * Allow a secret-input approval. The secret goes straight to main's
   * dedicated channel and is never kept in the store.
   */
  respondToSecretApproval: (
    requestId: string,
    bindingId: string,
    secret: string,
  ) => Promise<void>;
  /** Deny once. */
  dismissApproval: (requestId: string) => Promise<void>;
  /** Append a newly-granted session-scope rule to the tab's sessionApprovalRules and schedule persistence. */
  handleApprovalRuleAdded: (event: ApprovalRuleAddedEvent) => void;
  setTabApprovalMode: (
    target:
      | { projectId: string; worktreeId: string; chatId: string }
      | undefined,
    mode: ApprovalMode,
  ) => Promise<void>;
  /**
   * Resolves the effective approval-mode default for `projectId` via IPC,
   * caches it in `approvalDefaultsCache`, and returns it. Falls back to the
   * cached value (or `'ask'` when nothing is cached yet) if the IPC call
   * fails, so a resolution error can never widen tool access.
   */
  fetchApprovalDefault: (
    projectId: string,
    worktreeId?: string,
    options?: { forceFresh?: boolean },
  ) => Promise<ApprovalMode>;
}

export interface ChatStaleSessionSlice {
  handleStaleSessionStartNew: () => Promise<void>;
  handleStaleSessionHandOff: () => Promise<void>;
  dismissStaleSession: () => void;
}

export interface ChatDiscoverySlice {
  worktreeDefaultPlugins: Record<string, ChatTabPluginSelections>;
  /** Chat tab IDs with in-flight discovery. */
  tabDiscoveryLoading: Set<string>;
  /** Override default plugin selections for a specific worktree. */
  setWorktreeDefaultPlugins: (
    projectId: string,
    worktreeId: string,
    selections?: ChatTabPluginSelections,
  ) => void;
  /** Handle a per-tab discovery event (events bearing a chatId). */
  handleTabDiscoveryEvent: (event: WorktreeDiscoveryEvent) => void;
  /** Re-trigger command discovery for a specific chat tab. */
  retriggerTabDiscovery: (
    projectId: string,
    worktreeId: string,
    chatId: string,
    pluginSelections?: ChatTabPluginSelections,
    providerType?: AgentProviderType,
    selectedRepoId?: string,
  ) => void;
  /** Re-trigger command/skill discovery for every loaded chat tab in a worktree. */
  refreshWorktreeTabDiscoveries: (
    projectId: string,
    worktreeId: string,
  ) => void;
  /** Queue a worktree-wide discovery refresh and coalesce duplicates in the same tick. */
  queueWorktreeTabDiscoveryRefresh: (
    projectId: string,
    worktreeId: string,
  ) => void;
  /**
   * Bring a target worktree's chats in line with newly persisted project
   * defaults after source-controlled recommendations are accepted. Chats that
   * inherit project defaults only re-run discovery; other surfaces copy the
   * selections into the active empty tab.
   */
  syncEmptyChatPluginSelections: (
    projectId: string,
    worktreeId: string,
    selections: ChatTabPluginSelections,
    options?: { repoId?: string },
  ) => Promise<void>;
  syncActiveEmptyTabToDefaults: () => Promise<void>;
  setPluginSelections: (
    selections: ChatTabPluginSelections,
    target?: { projectId: string; worktreeId: string; chatId: string },
    deferredToolsAllowed?: boolean,
    options?: {
      runtimeAlreadyUpdated?: boolean;
      sdkSessionId?: string;
      /**
       * Replacement set of inherited (project and global) defaults this chat
       * has turned off. Omitted means "leave the persisted tombstones
       * unchanged"; an empty set clears them.
       */
      disabledGlobalPluginSelections?: PluginSelectionTombstones;
    },
  ) => ChatTabPluginSelections | undefined;
}

export interface ChatUsageSlice {
  /**
   * Persist the dismissal of the current provider usage-limit banner for a
   * tab. Records `dismissKey` on the tab so the banner stays hidden for that
   * event; a later rate-limit event with a different `dismissKey` re-shows
   * it. Never touches `messages`.
   */
  dismissLlmProviderUsageLimitBanner: (
    dismissKey: string,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => void;
  /**
   * Activate per-tab AI Credits fallback routing (CAN-838). Sets
   * `aiCreditsRouting` on the tab and dismisses the usage-limit banner so the
   * user is not re-prompted. `scope: 'persistent'` maps to routing mode `on`
   * (never auto-reverts); `'session'` stops at its reset time or after a native
   * account change (see `isAiCreditsRoutingInEffect`).
   * The routing state is threaded into the next `chat.sendMessage` so the main
   * process injects gateway proxy env at session spawn. Returns the stamped
   * `activatedAt`, or `undefined` when there was no chat tab to update.
   */
  enableAiCreditsRouting: (
    input: {
      scope: 'session' | 'persistent';
      resetsAt?: number;
      modelId?: string;
    },
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => number | undefined;
  /**
   * Clear per-tab AI Credits fallback routing, reverting to native provider
   * auth. Persists the clear without setting a subscription override, so the
   * chat falls back to its normal billing default (CAN-4200).
   */
  clearAiCreditsRouting: (target?: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => void;
  /**
   * Record a reset time resolved after "just this time" routing was stamped.
   * No-ops unless the tab still has active session routing activated at
   * `activatedAt`, so a late lookup never touches a newer choice (CAN-4200).
   */
  setAiCreditsRoutingResetsAt: (
    input: { resetsAt: number; activatedAt: number },
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => void;
  /**
   * Set the per-chat billing framework from the model selector's billing
   * toggle. Keeps the two per-tab billing bits mutually consistent:
   * - `'ai-credits'`: activate `aiCreditsRouting` (persistent scope — a
   *   deliberate, durable per-chat choice), clear `subscriptionBillingOverride`,
   *   and dismiss any usage-limit banner (mirroring `enableAiCreditsRouting`).
   * - `'subscription'`: clear `aiCreditsRouting` and set
   *   `subscriptionBillingOverride` so native billing is forced for this chat
   *   even when a global AI Credits routing mode is on.
   * Persisted so the choice survives restart.
   */
  /** Remember an explicit picker billing choice for newly created chats. */
  rememberBillingFramework: (framework: ChatBillingFramework) => void;
  selectBillingFramework: (
    framework: 'subscription' | 'ai-credits',
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => void;
  /**
   * Persist (or clear) the locally-tracked "this session has been shared as an
   * org run" metadata for a tab (CAN-395). Drives the persistent "Shared"
   * indicator and the manage popover. Pass `undefined` to clear it on unshare.
   * Never touches `messages`.
   */
  setSharedRun: (
    projectId: string,
    worktreeId: string,
    chatId: string,
    sharedRun: SharedRunMetadata | undefined,
  ) => Promise<void>;
}

export interface ChatAttentionSlice {
  /** Worktree keys with unread activity (agent finished or plan arrived while not selected). */
  unreadWorktreeKeys: Set<string>;
  /**
   * Startup-seeded persisted badge summaries (from `worktrees.json`
   * `chatBadges`) for worktrees that have NOT been hydrated. Sidebar badges
   * and hover previews fall back to these so full transcripts never need to
   * load just to render badges. An entry is dropped the moment its worktree
   * hydrates — live tab state supersedes it.
   */
  persistedWorktreeBadges: Record<string, WorktreeChatBadgesSummary>;
  /**
   * Seed persisted badge summaries for non-hydrated worktrees and mark keys
   * with unread chats as unread. Called at startup with every worktree's
   * `chatBadges` from projects data; hydrated keys are ignored.
   */
  seedPersistedWorktreeBadges: (
    byKey: Record<string, WorktreeChatBadgesSummary>,
  ) => void;
  acknowledgeSelectedWorktreeAttention: () => void;
  /**
   * Dismiss a chat card from the overview's unread panel. Clears the tab's
   * unread flag, stamps `attentionDismissedAt`, and prunes the worktree from
   * `unreadWorktreeKeys` if no other tabs still need attention. Pending plan
   * reviews and stale-session state on the tab are left intact — the user can
   * still act on them inside the chat itself.
   */
  dismissOverviewChatCard: (
    projectId: string,
    worktreeId: string,
    tabId: string,
  ) => void;
  /**
   * Clear unread/`attentionDismissedAt` for a target's tabs (or a single
   * tab when `options.tabId` is provided). Used by App Advisor on window
   * show/focus to clear blue unread treatment in the Sidebar.
   *
   * Durable read-state changes are main-owned typed commands; the main
   * renderer's clear for the App Advisor sentinel target stays in-memory
   * only so the Sidebar treatment drops immediately without issuing a
   * competing command.
   */
  markTargetRead: (
    projectId: string,
    worktreeId: string,
    options?: { allTabs?: boolean; tabId?: string },
  ) => void;
  /**
   * The chat tab menu's "Mark as unread" / "Mark as read". Marking unread is
   * recorded as the user's manual mark and leaves a viewed chat unread until
   * it is left and re-acknowledged; marking read reuses {@link markTargetRead}.
   * No-op when the tab is missing or already in the requested state.
   */
  setChatUnread: (
    projectId: string,
    worktreeId: string,
    chatId: string,
    unread: boolean,
  ) => void;
}

export interface ChatComposerSlice {
  /** Per-tab unsent editor content (session-only, not persisted). Keyed by tab ID. */
  tabDrafts: Record<string, Descendant[]>;
  /**
   * Live "composer has typed content" signal keyed by tab ID (session-only).
   * Unlike {@link tabDrafts}, which persists only on tab switches, this is
   * updated by the composer as the user types so empty-state affordances
   * (CAN-1809 suggested prompts) can hide while a draft is in progress.
   * Entries are removed (not set false) when a composer empties or unmounts.
   */
  composerTextPresent: Record<string, boolean>;
  setComposerTextPresent: (tabId: string, present: boolean) => void;
  saveTabDraft: (tabId: string, content: Descendant[]) => void;
  getTabDraft: (tabId: string) => Descendant[] | undefined;
  clearTabDraft: (tabId: string) => void;
  /**
   * Transient flag: the composer's scheduled-send modal is open. Lifted to the
   * store (not the tab) so the App Advisor current-UI snapshot can report it via
   * the `chat.activeTab` slice without prop-drilling out of the composer.
   */
  scheduledSendModalOpen: boolean;
  setScheduledSendModalOpen: (open: boolean) => void;
  /**
   * Stage (or clear with `null`) a one-time scheduled-send selection on a tab.
   * Kept on the tab and persisted with draft metadata so it survives tab
   * switches and renderer restarts.
   */
  setScheduledSendDraft: (
    draft: { runAt: string } | null,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<void>;
  /**
   * Clear the composer state consumed by a successful scheduled send: pending
   * attachments, the pending revert-summary attachment, and the staged
   * scheduled-send draft. Mirrors what a normal successful send clears, so the
   * synthetic revert attachment is neither dropped from the scheduled message
   * nor left dangling onto the next immediate send.
   */
  clearScheduledSendComposerState: (target?: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => void;
  /**
   * Per-tab staged editor selections (session-only, not persisted). Keyed by
   * tab ID, like {@link tabDrafts}. Serialized into the outgoing message as
   * structured blocks at send time (CAN-1250).
   */
  pendingEditorSelections: Record<string, readonly EditorSelectionContext[]>;
  /** Stage a captured editor selection on a tab (duplicates are ignored). */
  addPendingEditorSelection: (
    tabId: string,
    selection: AddEditorSelectionDetail,
  ) => void;
  /** Remove one staged editor selection by its id. */
  removePendingEditorSelection: (tabId: string, selectionId: string) => void;
  /** Drop all staged editor selections for a tab. */
  clearPendingEditorSelections: (tabId: string) => void;
  /** Atomically claim the one-shot revert summary for a composer submission. */
  reservePendingRevertAttachment: (target?: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => string | undefined;
  /** Return a failed submission's revert summary unless another is staged. */
  restorePendingRevertAttachment: (
    absolutePath: string,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => void;
  /** Add file attachments to the active tab's pending list. */
  addPendingAttachments: (
    attachments: AttachmentMeta[],
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => void;
  /** Remove a single pending attachment by its absolute path. */
  removePendingAttachment: (
    absolutePath: string,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => void;
  /** Clear all pending attachments on the active tab. */
  clearPendingAttachments: () => void;
}

/**
 * Turn-level thumbs up/down feedback (CAN-1521). Ratings live on the chat tab
 * (`ChatTab.turnFeedback`, keyed by `userMessageId`) and are persisted
 * alongside `turnDiffs`.
 */
export interface ChatTurnFeedbackSlice {
  /**
   * Record (or clear, with `null`) a thumbs rating on one completed turn.
   * Writes optimistically as `pending` and settles on the IPC ack; a rejected
   * upload settles to `failed` with the rating preserved.
   */
  setTurnFeedback: (
    userMessageId: string,
    rating: TurnFeedbackRating | null,
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<void>;
  /**
   * Amend an existing rating with the thumbs-down reason and/or comment.
   * No-ops when the turn has no rating, so skipping can never undo one.
   */
  submitTurnFeedbackDetail: (
    userMessageId: string,
    detail: { reason?: TurnFeedbackReason; comment?: string },
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<void>;
  /**
   * Fold server rows into tab state. A local `pending`/`failed` entry always
   * wins over a conflicting server entry — it is the newer user intent.
   */
  mergeServerTurnFeedback: (
    summaries: readonly TurnFeedbackSummary[],
    target?: { projectId: string; worktreeId: string; chatId: string },
  ) => void;
  /** Fetch and merge this chat's ratings (server rows plus queued outbox). */
  loadTurnFeedback: (target?: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => Promise<void>;
}

export type ChatState = ChatRevisionedSlice &
  ChatModelsSlice &
  ChatDeferredToolsSlice &
  ChatTabsSlice &
  ChatArchiveSlice &
  ChatMessagingSlice &
  ChatQueueSlice &
  ChatEventsSlice &
  ChatQuestionsSlice &
  ChatPlanSlice &
  ChatApprovalsSlice &
  ChatStaleSessionSlice &
  ChatDiscoverySlice &
  ChatUsageSlice &
  ChatAttentionSlice &
  ChatComposerSlice &
  ChatTurnFeedbackSlice;
