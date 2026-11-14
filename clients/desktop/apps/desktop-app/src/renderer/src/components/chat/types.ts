import {
  presentedMessages,
  presentedQueueMessages,
  withStartingTurnTimer,
} from '@/stores/chat/optimistic-presentation';
import {
  startingTurnUserMessageId,
  isProvisionalFirstSendAdmissionPending,
} from '@/stores/chat/provisional-first-send';
import type { ProvisionalFirstSendFailure } from '@/stores/chat/types';
import { getLockedHarness, getLockedProvider } from '@/lib/chatProviderLock';
import type {
  ChatMessage,
  ChatTab,
  QueuedChatMessage,
} from '@/stores/chatStore';
import type {
  AgentProviderType,
  ApprovalMode,
  ResolvedAgentModelConfig,
  AgentUsage,
  AiCreditsNoBillingSourceState,
  AiCreditsRoutingState,
  ChatInterfaceMode,
  ChatModel,
  ChatTabPluginSelections,
  PluginSelectionTombstones,
  ChatTabUsage,
  ChatRuntimeState,
  LlmProviderUsageLimitBannerState,
  StaleSessionInfo,
  ThinkingLevel,
  TurnDiffData,
  WorktreeDiscovery,
} from '@canopy/desktop-shared/types';
import {
  TASK_MGMT_TOOLS,
  type TurnGroup,
  type TurnGroupOrMessage,
  type TurnMessage,
  type TurnSummaryCounts,
} from '@canopy/desktop-shared/lib/turn-utils';
import { hasUnresolvedToolUseInCurrentTurn } from '@/stores/chat/messages';
import { computeEmptyCompletionRecoveryView } from '@/stores/chat/empty-completion';
import { presentableStoppedTurnResume } from '@/stores/chat/stopped-turn-resume';
import {
  presentableInterruptedTurnResume,
  type InterruptedTurnResumePromptKind,
} from '@/stores/chat/interrupted-turn-resume';

// ---------------------------------------------------------------------------
// Display types — tool_use blocks can carry an inlined result
// ---------------------------------------------------------------------------

export type {
  ToolResult,
  DisplayBlock,
  DisplayMessage,
} from '@canopy/desktop-shared/types/message-display';

export interface ActiveTranscriptView {
  transcript?: ChatTab['transcript'];
  transcriptLoaded?: boolean;
  transcriptWindow?: ChatTab['transcriptWindow'];
  id: string;
  messages: ChatMessage[];
  pendingTurnTimerId?: string;
  /** User message whose turn shows the pending "Starting…" status. */
  startingTurnUserMessageId?: string;
  startingTurnPresentationKey?: string;
  queuedMessages: QueuedChatMessage[];
  agentUsage?: Record<string, AgentUsage>;
  turnDiffs?: Record<string, TurnDiffData>;
  memoryByMessageId?: ChatTab['memoryByMessageId'];
  /** Index of the queued message currently being edited inline, if any. */
  editingQueuedMessageIndex?: number;
  editingQueuedMessageFocusAllowed?: boolean;
  pendingQueuedMessageEditId?: string;
}

export interface ActiveComposerView {
  /** Keep drafting while the first send awaits preparation or acknowledgement. */
  firstSendPreparing?: boolean;
  /**
   * A Home first send whose model was refused (CAN-5021): its recovery notice
   * renders in the composer's notice stack, and an explicit replacement
   * captures the failure the person saw before awaiting.
   */
  failedFirstSend?: Pick<
    ProvisionalFirstSendFailure,
    'failureId' | 'message'
  > & {
    userMessageId: string;
  };
  queuedHookPlaceholder?: boolean;
  executionHarness?: ChatTab['executionHarness'];
  executionHarnessExplicitlyChosen?: boolean;
  id: string;
  title: string;
  status: ChatTab['status'];
  error: ChatTab['error'];
  readOnly?: boolean;
  /** Where an imported chat came from; its read-only notice names it. */
  importedFrom?: ChatTab['importedFrom'];
  planMode: boolean;
  /** Effective tool-approval mode for this tab's `ApprovalModePicker`. Undefined until the tab-creation/send-time default resolution lands. */
  approvalMode?: ApprovalMode;
  proposalMode: 'optional' | 'required';
  thinkingLevel: ThinkingLevel;
  modelConfig: ResolvedAgentModelConfig;
  model?: ChatModel;
  providerType?: AgentProviderType;
  pendingPlanExit?: ChatTab['pendingPlanExit'];
  pendingPlanExitRequestId?: ChatTab['pendingPlanExitRequestId'];
  /**
   * Set while a completed turn produced no visible output (CAN-2307) — the id
   * of the turn's user message. Absent means the turn is fine or has already
   * reconciled.
   *
   * Flat, not an object, on purpose: this projection is read through
   * `useShallow`, and a nested object rebuilt on every render never compares
   * equal, which re-renders the composer until React gives up (#185).
   */
  emptyCompletionTurnUserMessageId?: string;
  /** See `EmptyCompletionRecoveryView.repeatsToolActivity`. */
  emptyCompletionRepeatsToolActivity?: boolean;
  /** See `EmptyCompletionRecoveryView.canRetryPrompt`. */
  emptyCompletionCanRetryPrompt?: boolean;
  /**
   * User-message id of a stopped turn that can be resumed (CAN-3137). Absent
   * when there is no offer or it has gone stale. Flat for the same `useShallow`
   * reason as `emptyCompletionTurnUserMessageId`.
   */
  stoppedTurnResumeUserMessageId?: string;
  /** Actionable failure text from the last resume attempt. */
  stoppedTurnResumeError?: string;
  /**
   * User-message id of the latest turn an app close interrupted that can be
   * resumed in place (CAN-5177). Flat for the same `useShallow` reason.
   */
  interruptedTurnResumeUserMessageId?: string;
  /** What that resume sends; absent when the history cannot tell. */
  interruptedTurnResumePromptKind?: InterruptedTurnResumePromptKind;
  staleSessionDetected?: StaleSessionInfo;
  pluginSelections?: ChatTabPluginSelections;
  /** Mirror of `ChatTab.disabledGlobalPluginSelections`. */
  disabledGlobalPluginSelections?: PluginSelectionTombstones;
  /** Mirror of `ChatTab.inheritedPluginDefaultsVersion`. */
  inheritedPluginDefaultsVersion?: number;
  deferredToolsAllowed?: boolean;
  usage?: ChatTabUsage;
  trackedPlanId?: string;
  /** Mirror of `ChatTab.latestRevisionNumber`, for the revised plan heading. */
  latestRevisionNumber?: number;
  discovery?: WorktreeDiscovery;
  lastEventAt?: number;
  /** True while the transcript shows a tool/command that has not completed. */
  hasActiveAgentStep?: boolean;
  lockedProvider?: AgentProviderType;
  /** Number of queued turns, projected without exposing the queue payload. */
  queuedMessageCount?: number;
  /** A transient queue hold, projected without exposing prompt content. */
  queuedCreditHeld?: boolean;
  lockedHarness?:
    | 'claude'
    | 'codex'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode';
  /** Selected repo for multi-repo workspace cwd resolution. */
  selectedRepoId?: string;
  /**
   * Chat-interface mode (`'canopy'` native vs `'claude-code'` terminal).
   * Used to gate native-only affordances (scheduled send, usage-limit resume).
   */
  interfaceMode?: ChatInterfaceMode;
  /** Latest detected provider usage-limit banner metadata (banner-only). */
  llmProviderUsageLimitBanner?: LlmProviderUsageLimitBannerState;
  /** `dismissKey` of the usage-limit banner the user last dismissed for this tab. */
  dismissedLlmProviderUsageLimitBannerKey?: string;
  /**
   * Persisted marked-402 metadata, replayed into the target-keyed banner store
   * so the recovery banner survives a reload (CAN-2413).
   */
  aiCreditsNoBillingSource?: AiCreditsNoBillingSourceState;
  /** Per-tab AI Credits fallback routing decision (CAN-838), when active. */
  aiCreditsRouting?: AiCreditsRoutingState;
  /** Mirror of `ChatTab.accountProxyRouted`. */
  accountProxyRouted?: boolean;
  /**
   * Per-chat override forcing native subscription billing for this chat, even
   * when a global AI Credits routing mode is on. Set by the model selector's
   * billing toggle; mirror of `ChatTab.subscriptionBillingOverride`.
   */
  subscriptionBillingOverride?: boolean;
  /**
   * Synthetic revert-summary attachment path the next send must prepend. Mirror
   * of `ChatTab.pendingRevertAttachmentPath`; surfaced so a scheduled send can
   * capture (and then clear) it exactly like a normal send.
   */
  pendingRevertAttachmentPath?: string;
  /** Staged one-time scheduled-send selection for this tab's composer. */
  scheduledSendDraft?: { runAt: string };
  /**
   * True once the chat has at least one persisted message. The DirectoryPicker
   * locks on this because the agent SDK binds cwd at session creation.
   */
  hasStartedSession: boolean;
  /**
   * Mirror of `ChatTab.modelSelectionMode`. Absent is manual, so an older
   * persisted tab and a chat that never opted in behave identically.
   */
  modelSelectionMode?: 'auto';
  /**
   * Locally-persisted team/organization shared-run metadata. Drives the
   * persistent "Shared" indicator and the
   * manage popover. Mirror of `ChatTab.sharedRun`.
   */
  sharedRun?: ChatTab['sharedRun'];
  /**
   * True when the session is not in a shareable, idle state — streaming, a
   * pending plan-exit approval, or real queued turns (a lone queued hook
   * placeholder does not count). Mirrors ChatTabBar's session-menu busy guard
   * so the composer's share control disables sharing under the same conditions
   * as the other surfaces.
   */
  shareSessionBusy: boolean;
}

interface ActiveComposerProjectionOptions {
  /** Canonical main-owned activity timestamp for revisioned live chats. */
  lastActivityAt?: number;
  /** Only composer surfaces need the current-turn active-tool derivation. */
  includeActiveAgentStep?: boolean;
}

/**
 * The chat's transcript as the list renders it. `runtime` is the chat's
 * canonical runtime: a turn it reports `starting` (one main holds for its
 * worktree's setup, or a Portal or agent send) shows the starting status
 * even when this renderer minted no provisional send for it. A provisional
 * send for the same message id is the same turn and keeps its presentation.
 */
export function toActiveTranscriptView(
  tab: ChatTab,
  runtime?: Pick<ChatRuntimeState, 'status' | 'activeTurn'>,
): ActiveTranscriptView {
  const provisionalStartingId = tab.provisionalFirstSend
    ? startingTurnUserMessageId(tab)
    : undefined;
  const canonicalStarting =
    provisionalStartingId === undefined &&
    tab.status !== 'error' &&
    runtime?.status === 'starting'
      ? runtime.activeTurn
      : undefined;
  const presented = presentedMessages(tab);
  const messages = canonicalStarting
    ? withStartingTurnTimer(presented, canonicalStarting)
    : presented;
  const canonicalStartingId =
    canonicalStarting &&
    messages.some((message) => message.id === canonicalStarting.userMessageId)
      ? canonicalStarting.userMessageId
      : undefined;
  return {
    transcript: tab.transcript,
    transcriptLoaded: tab.transcriptLoaded,
    transcriptWindow: tab.transcriptWindow,
    id: tab.id,
    messages,
    pendingTurnTimerId:
      tab.status !== 'error' ? tab.pendingTurn?.timerMessage.id : undefined,
    ...(canonicalStartingId
      ? { startingTurnUserMessageId: canonicalStartingId }
      : tab.provisionalFirstSend
        ? {
            startingTurnUserMessageId: provisionalStartingId,
            startingTurnPresentationKey: tab.provisionalFirstSend.userMessageId,
          }
        : {}),
    queuedMessages: presentedQueueMessages(tab),
    ...(tab.agentUsage ? { agentUsage: tab.agentUsage } : {}),
    ...(tab.turnDiffs ? { turnDiffs: tab.turnDiffs } : {}),
    ...(tab.memoryByMessageId
      ? { memoryByMessageId: tab.memoryByMessageId }
      : {}),
    pendingQueuedMessageEditId: tab.pendingQueuedMessageEditId,
    ...(tab.editingQueuedMessageIndex !== undefined
      ? {
          editingQueuedMessageIndex: tab.editingQueuedMessageIndex,
          editingQueuedMessageFocusAllowed:
            tab.editingQueuedMessageFocusAllowed,
        }
      : {}),
  };
}

export function toActiveComposerView(
  tab: ChatTab,
  options: ActiveComposerProjectionOptions = {},
): ActiveComposerView {
  const lockedProvider = getLockedProvider(tab);
  const lockedHarness = getLockedHarness(tab);
  const lastEventAt =
    tab.lastEventAt === undefined
      ? options.lastActivityAt
      : options.lastActivityAt === undefined
        ? tab.lastEventAt
        : Math.max(tab.lastEventAt, options.lastActivityAt);

  const emptyCompletionRecovery = computeEmptyCompletionRecoveryView(
    tab.emptyCompletionRecovery,
    tab.messages,
  );
  const stoppedTurnResume = presentableStoppedTurnResume(tab);
  const interruptedTurnResume = presentableInterruptedTurnResume(tab);

  return {
    id: tab.id,
    ...(tab.queuedHookPlaceholder === true
      ? { queuedHookPlaceholder: true }
      : {}),
    title: tab.title,
    firstSendPreparing:
      tab.provisionalFirstSend?.phase !== 'failed' &&
      isProvisionalFirstSendAdmissionPending(tab),
    ...(tab.provisionalFirstSend?.phase === 'failed' &&
    tab.provisionalFirstSend.failure
      ? {
          failedFirstSend: {
            userMessageId: tab.provisionalFirstSend.userMessageId,
            failureId: tab.provisionalFirstSend.failure.failureId,
            message: tab.provisionalFirstSend.failure.message,
          },
        }
      : {}),
    status: tab.status,
    error: tab.error,
    ...(tab.readOnly ? { readOnly: true } : {}),
    ...(tab.importedFrom ? { importedFrom: tab.importedFrom } : {}),
    planMode: tab.planMode,
    ...(tab.approvalMode ? { approvalMode: tab.approvalMode } : {}),
    proposalMode: tab.proposalMode,
    thinkingLevel: tab.thinkingLevel,
    modelConfig: tab.modelConfig,
    ...(tab.model ? { model: tab.model } : {}),
    ...(tab.providerType ? { providerType: tab.providerType } : {}),
    ...(tab.executionHarness ? { executionHarness: tab.executionHarness } : {}),
    ...(tab.executionHarnessExplicitlyChosen === true
      ? { executionHarnessExplicitlyChosen: true }
      : {}),
    ...(tab.pendingPlanExit ? { pendingPlanExit: tab.pendingPlanExit } : {}),
    ...(tab.pendingPlanExitRequestId
      ? { pendingPlanExitRequestId: tab.pendingPlanExitRequestId }
      : {}),
    ...(emptyCompletionRecovery
      ? {
          emptyCompletionTurnUserMessageId:
            emptyCompletionRecovery.turnUserMessageId,
          emptyCompletionRepeatsToolActivity:
            emptyCompletionRecovery.repeatsToolActivity,
          emptyCompletionCanRetryPrompt: emptyCompletionRecovery.canRetryPrompt,
        }
      : {}),
    ...(stoppedTurnResume
      ? {
          stoppedTurnResumeUserMessageId: stoppedTurnResume.userMessageId,
          ...(stoppedTurnResume.error
            ? { stoppedTurnResumeError: stoppedTurnResume.error }
            : {}),
        }
      : {}),
    ...(interruptedTurnResume
      ? {
          interruptedTurnResumeUserMessageId:
            interruptedTurnResume.userMessageId,
          ...(interruptedTurnResume.promptKind
            ? {
                interruptedTurnResumePromptKind:
                  interruptedTurnResume.promptKind,
              }
            : {}),
        }
      : {}),
    ...(tab.staleSessionDetected
      ? { staleSessionDetected: tab.staleSessionDetected }
      : {}),
    ...(tab.pluginSelections ? { pluginSelections: tab.pluginSelections } : {}),
    ...(tab.disabledGlobalPluginSelections
      ? { disabledGlobalPluginSelections: tab.disabledGlobalPluginSelections }
      : {}),
    ...(tab.inheritedPluginDefaultsVersion !== undefined
      ? { inheritedPluginDefaultsVersion: tab.inheritedPluginDefaultsVersion }
      : {}),
    ...(typeof tab.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: tab.deferredToolsAllowed }
      : {}),
    ...(tab.usage ? { usage: tab.usage } : {}),
    ...(tab.trackedPlanId ? { trackedPlanId: tab.trackedPlanId } : {}),
    ...(tab.latestRevisionNumber !== undefined
      ? { latestRevisionNumber: tab.latestRevisionNumber }
      : {}),
    ...(tab.discovery ? { discovery: tab.discovery } : {}),
    ...(lastEventAt !== undefined ? { lastEventAt } : {}),
    hasActiveAgentStep:
      options.includeActiveAgentStep === true &&
      tab.status === 'streaming' &&
      hasUnresolvedToolUseInCurrentTurn(tab.messages),
    ...(lockedProvider ? { lockedProvider } : {}),
    queuedMessageCount: presentedQueueMessages(tab).length,
    queuedCreditHeld: presentedQueueMessages(tab).some(
      (row) => row.retryBlockedReason === 'insufficient_credits',
    ),
    ...(lockedHarness ? { lockedHarness } : {}),
    ...(tab.selectedRepoId ? { selectedRepoId: tab.selectedRepoId } : {}),
    ...(tab.interfaceMode ? { interfaceMode: tab.interfaceMode } : {}),
    ...(tab.llmProviderUsageLimitBanner
      ? { llmProviderUsageLimitBanner: tab.llmProviderUsageLimitBanner }
      : {}),
    ...(tab.dismissedLlmProviderUsageLimitBannerKey
      ? {
          dismissedLlmProviderUsageLimitBannerKey:
            tab.dismissedLlmProviderUsageLimitBannerKey,
        }
      : {}),
    ...(tab.aiCreditsNoBillingSource
      ? { aiCreditsNoBillingSource: tab.aiCreditsNoBillingSource }
      : {}),
    ...(tab.aiCreditsRouting ? { aiCreditsRouting: tab.aiCreditsRouting } : {}),
    ...(typeof tab.accountProxyRouted === 'boolean'
      ? { accountProxyRouted: tab.accountProxyRouted }
      : {}),
    ...(tab.subscriptionBillingOverride
      ? { subscriptionBillingOverride: tab.subscriptionBillingOverride }
      : {}),
    ...(tab.pendingRevertAttachmentPath
      ? { pendingRevertAttachmentPath: tab.pendingRevertAttachmentPath }
      : {}),
    ...(tab.scheduledSendDraft
      ? { scheduledSendDraft: tab.scheduledSendDraft }
      : {}),
    hasStartedSession: tab.messages.length > 0,
    ...(tab.modelSelectionMode === 'auto'
      ? { modelSelectionMode: 'auto' as const }
      : {}),
    ...(tab.sharedRun ? { sharedRun: tab.sharedRun } : {}),
    // Parity with ChatTabBar's `isChatTabBusy`. A lone queued hook placeholder
    // (no real messages yet, exactly one queued placeholder entry) is an
    // internal artifact and does not make the session "busy" for sharing.
    shareSessionBusy:
      tab.status === 'streaming' ||
      tab.pendingPlanExit != null ||
      (tab.queuedMessages.length > 0 &&
        !(
          tab.kind !== 'file' &&
          tab.queuedHookPlaceholder === true &&
          tab.messages.length === 0 &&
          tab.queuedMessages.length === 1
        )),
  };
}

export { TASK_MGMT_TOOLS };
export type { TurnGroup, TurnGroupOrMessage, TurnMessage, TurnSummaryCounts };
