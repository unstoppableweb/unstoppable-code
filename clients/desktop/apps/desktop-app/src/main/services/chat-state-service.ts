import { TrackedPlanImplementationInputSchema } from '@canopy/protocol/portal';
import { supersedeToolInterruptions } from '@canopy/agent-transcript/settlement';
import { readAutoResumeMetadata } from '@canopy/protocol/portal';
import type {
  ChildStreamCompatibilityPageRequest,
  ChildStreamCompatibilityPageReply,
} from '../agents/delegation/record-reader-contract';
import type { DelegationRegistryOperations } from '../lib/chat-delta-journal/delegation-registry-api';
import { checkWatcherDeliveryIngress } from './active-chat-input';
import {
  applyProviderSwitchToSession,
  resetSessionForHarnessChange,
} from './chat-provider-sessions';
import { assertUntrustedChatInput } from '../agent-messaging/untrusted-input';
import { automationDispatchRequestFields } from '../agent-messaging/automation-dispatch';
import {
  revalidateAgentSenderRequest,
  parseAgentSenderProvenance,
  agentSendTargetReadiness,
  withAgentSenderAuthority,
  isAgentSenderContextError,
  AgentSenderContextError,
  changesAuthority,
} from '../agent-messaging/sender-context';
import {
  withLegacyChatMessageCommand,
  agentSendAcceptanceReceipt,
  reportAgentSendAccepted,
} from '../canopy-runtime/core-chat-message-command-adapter';
import {
  retainedTerminalAgentInput,
  settleTerminalAgentImports,
} from '../agent-messaging/terminal-input';
import { inputSettingsKey } from '@canopy/desktop-shared/chat-input-delivery';
import {
  isMcpActivationMessage,
  mcpActivationMessageId,
} from './mcp-activation-message';
import { isPlanProposal } from '@canopy/desktop-shared/plan-review';
import {
  hasChatContinuationSession,
  resolveChatModelChangeHarness,
  supportsChatHarnessChoice,
  isNativeOpenCodeSelection,
} from '@canopy/desktop-shared/lib/chat-model-selection';
import {
  clearOpenCodeForkPlanReview,
  prepareOpenCodeVisibleFork,
} from '@canopy/desktop-shared/lib/opencode-fork-context';
import type { ChatPlanReviewApproval } from '@canopy/protocol/portal';
import {
  DELEGATION_TRANSCRIPT_CHAT_LOG,
  DELEGATION_TRANSCRIPT_CHAT_STREAM,
  isAgentDelegationTranscript,
  type AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import type {
  DelegationRun,
  DelegationRunItems,
} from '../lib/chat-delegation-log';
import { persistedDelegationSnapshot } from '../agents/delegation/card-persistence';
import { CHAT_CUSTOM_TITLE_MAX_LENGTH } from '@canopy/protocol';
import { validateQuestionControlAnswers } from '@canopy/protocol/portal';
import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import {
  setTurnLifecycleEndedLookup,
  setTurnLifecycleSink,
} from '../agents/provider-turn-lifecycle';
import {
  bindChatTurnOwnership,
  getChatTurnOwnership,
} from './chat-turn-ownership';
import {
  applyTurnEffects,
  projectTurnRuntime,
  snapshotTimerRows,
} from './chat-turn-effects';
import {
  ChatTurnStateHandoff,
  isBackgroundTurnState,
  type ChatTurnStateChange,
  type ChatTurnStateCommit,
  type ChatTurnStateScope,
  type ChatTurnStateHandoffSnapshot,
} from './chat-turn-state-handoff';
export type {
  ChatTurnStateChange,
  ChatTurnStateCommit,
  ChatTurnStateScope,
} from './chat-turn-state-handoff';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  hasTrustedVisualToolUse,
  type VisualToolTarget,
} from './visual-tool-identity';
import { publishForeignChatActivity } from './foreign-activity-sources';
import type { AgentSession } from '../agents/types';
import { settleInputExecution } from './chat-input-delivery-state';
import {
  detachInputDelivery,
  validOrdinaryContinuation,
} from '@canopy/desktop-shared/chat-input-delivery';
import {
  recordDelegationSnapshot,
  recordProviderEventApplied,
  recordProviderEventIngested,
} from '@canopy/desktop-shared/node/work-counters';
import { searchTranscriptMessages } from '@canopy/agent-transcript/lib/transcript-search';
import type {
  ChatStateV2Backend as ChatStateV2BackendType,
  ChildStreamContentRange,
  ChildStreamRowsPage,
  ChatStorageImportOptions,
} from './chat-state-v2-backend';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type {
  TranscriptContentField,
  TranscriptTarget,
  TranscriptStreamDescriptor,
} from '@canopy/protocol/canopy-core';
import type { ChatStorageV2 } from '../lib/chat-storage-v2';
import { createHash, randomUUID } from 'node:crypto';
import { isE2eBuild } from '../lib/e2e-gate';
import { isChatFormat4PromotionEnabled } from './chat-format4-promotion-flag';
import { recordChatFormat4Outcome } from './chat-format4-telemetry';
import { installChatScopeResidencyE2eHook } from './chat-scope-residency-e2e';
import { BACKGROUND_WORK_CHAT_REFUSAL } from '../agents/delegation/activity';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  mcpActivationRecordSchema,
  readMcpActivationRecord,
  type McpActivationRecord,
  type McpActivationScope,
} from '@canopy/protocol/mcp-servers';
import {
  ChatInputDeliveryCoordinator,
  type InputPickupObserver,
} from './chat-input-delivery-coordinator';
import { isHistoryCandidate, isInputLedger } from './chat-input-delivery-state';
import type { InputRow } from './chat-input-delivery-state';
import { reopenAsyncQuestionMutations } from './async-question-reopen';
import type {
  ChatInputDeliveryEvent,
  ChatSteeringCapabilities,
} from '@canopy/protocol/portal';
import { readChatInputDeliveryFailure } from '@canopy/protocol/portal/input-delivery';
import { prepareCodexItemFields } from './chat-transcript-field-preparation';
import { admittedResultCall } from '@canopy/agent-transcript/lib/admitted-result-call';
import { toolResultNeedsRead } from '../lib/chat-transcript-artifacts';
import { portalToolOccurrenceId } from '@canopy/protocol/portal';
import {
  PROVIDER_EVENT_ADMISSION_MAX_TOOLS,
  PROVIDER_EVENT_ADMISSION_MAX_BYTES,
  type ToolOccurrenceAdmission,
  type ProviderEventIngestResult,
} from './provider-event-admission';
import {
  CHILD_TOOLS_ENDED_EVENT_TYPE,
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  claudeResultErrorMessage,
  parseAgentTranscriptLines,
  setTranscriptModelResolver,
  type TranscriptReducerState,
} from '@canopy/agent-transcript';
import {
  hydrateChatTurnState,
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import type {
  ChatTurnRecord,
  PersistedChatTurnState,
} from '@canopy/agent-transcript/turn';
import type {
  ChatTranscriptPageRequest,
  ChatTranscriptContentRequest,
  ChatTranscriptBlocksRequest,
  ChatTranscriptBlocksPage,
  ChatTranscriptSearchRequest,
  ChatTranscriptSearchResult,
  ChatToolOutputRequest,
  ChatToolOutputResponse,
  ChatVisualReadRequest,
  ChatVisualReadResponse,
  AgentModelConfig,
  ApprovalMode,
  ArchivedChatEntry,
  ArchivedChatsFile,
  ArchivedTurnFence,
  ChatCommand,
  ChatCommandEnvelope,
  ChatCommandExecutionOptions,
  ChatCommandResult,
  ChatCoreMutation,
  ChatQueueOrigin,
  ChatQueueEditRequest,
  ChatRuntimeState,
  ChatSendAdmittedApproval,
  ChatSendMessageRequest,
  ChatSendTurnOverride,
  ChatStateChangedEvent,
  ChatStateCommandPort,
  ChatStateSnapshot,
  ChatTabMetadataPatch,
  ChatTabsFile,
  ChangedFileInfo,
  McpQuestionAnswer,
  ModelHarness,
  PersistedChatMessage,
  PersistedCommandReceipt,
  PortalChatSendIdentity,
  PortalChatSendReceiptProbe,
  PersistedHostQueuedMessage,
  PersistedChatTab,
  PersistedPendingQuestion,
  PlanExitRequestEvent,
  TurnDiffTreeRef,
} from '@canopy/desktop-shared/types';
import {
  chatAgentSent,
  type AgentSentInfo,
} from '@canopy/protocol/portal/external-agent-sender';
import {
  isRetiredPlanChatScope,
  RETIRED_PLAN_CHAT_MESSAGE,
} from '@canopy/desktop-shared/lib/retired-chat-scopes';
import { readMetadataOfRecord } from '@canopy/desktop-shared/node/delegation/record-v3';
import type {
  TranscriptDescriptor,
  TranscriptPage,
} from '@canopy/agent-transcript/transcript-storage';
import type { PersistedVisualReference } from '@canopy/agent-transcript/types';
import {
  ChatStateV2Repository,
  type TranscriptPreviewOptions,
  type TranscriptPreviewRead,
} from './chat-state-v2-repository';
import { applyMutation } from './chat-state-reducer';
import {
  APP_ADVISOR_PROJECT_ID,
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  canSwitchProviderInPlace,
  CODE_REVIEW_CHAT_PROJECT_ID,
  FAIL_CLOSED_APPROVAL_MODE,
  getEffectiveModelContextWindow,
  getExecutionHarnessForModel,
  getModelContextWindow,
  getModelDisplayName,
  getProviderForModel,
  isSetAutoArchiveRequestedEventData,
  isTerminalBackedInterfaceMode,
  normalizeAgentModelConfig,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  resolveKnownModel,
  resolveModelAlias,
  resolveRuntimeModel,
} from '@canopy/desktop-shared/types';
import {
  createPersistedChatTab,
  createPersistedFileTab,
  mergePersistedMessagesById,
} from '@canopy/desktop-shared/persisted-chat-state';
import { normalizeOrgMemoryTurn } from '@canopy/desktop-shared/lib/org-memory';
import {
  persistedTabProvider,
  resolveTerminalDrivenChat,
} from '../lib/terminal-driven-chat';
import { getEffectiveClaudeChatInterfaceMode } from '../lib/claude-tui-chats';
import { newChatPluginDefaultsStamp } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { formatAskUserAnswers } from '@canopy/desktop-shared/lib/ask-user-answers';
import { resolveClaudeForkResumePoint } from '@canopy/desktop-shared/lib/claude-fork-resume-point';
import {
  canonicalizeAgentModelConfig,
  isCodexSpeed,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  defineChatTabMetadataProperty,
  isSafeChatTabMetadataKey,
} from '@canopy/desktop-shared/chat-tab-metadata';
import {
  clearAskUserRequestCancellation,
  isAskUserRequestCancelled,
  rejectRequest,
  resolveRequest,
} from '../mcp/pending-requests';
import { toArchivedChatSummary } from '../lib/chat-archives';
import {
  isClaudeChildFrame,
  isCodexSubagentFollowupEvent,
  isCodexSubagentTerminalEvent,
  isRootAgentContinuationEvent,
  isPlanHandoffResult,
  isRootTerminalChatEventData,
  isTerminalChatEventData,
  isUserAbortResult,
} from '../lib/chat-turn-audit';
import {
  projectChatRuntime,
  projectChatStateChanges,
} from './chat-state-projection';
import {
  ensureChatTabsRequiredDurability,
  notifyChatTabsMaterialized,
  type ChatTabsWriteDelta,
} from '../lib/chat-tabs';
import {
  isPersistedChatMessage,
  isPersistedChatTab,
} from '../lib/chat-tabs-reader';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import {
  buildPersistedTurnInterruptedMutations,
  settlePersistedInterruptedMessages,
  closeOpenPersistedTurnTimers,
  settlePersistedForkMessages,
} from '../lib/persisted-chat-settle';
import {
  resolveTurnSuccession,
  succeedInterruptedTurns,
} from '../lib/chat-turn-succession';
import { turnMessages } from '../lib/chat-turn-messages';
import {
  recordedTurnEnd,
  withTurnEnd,
  withoutTurnEnd,
  type TurnEnds,
} from '../lib/chat-turn-ends';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import { preserveSettledTurnTimers } from '../lib/settled-turn-timer-guard';
import { recordInterruptedChats } from '../lib/usage-limited-chats-registry';
import {
  installChatTranscriptRewriteDiagnosticSink,
  installChatTranscriptRewriteRateDiagnosticSink,
} from './chat-transcript-rewrite-diagnostics';
import { chatEventDroppedDiagnostic } from '../lib/chat-event-drop-diagnostics';
import { isRealWorkspaceTarget } from '../lib/chat-targets';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { withWorkspaceTargetRuntimeStartReservation } from '../lib/workspace-target-exclusion';
import { classifyProviderRunEvent } from '../lib/provider-run-reconciliation';
// Type-only: erased at compile time, so it cannot create the import cycle
// the lazy `recordDiagnostic` default below deliberately avoids.
import type { SessionDiagnosticRecord } from '../observability/service';
import {
  startChatWaitOperation,
  type ChatWaitOperation,
} from '../observability/chat-wait-diagnostics';
import type {
  ChatReadSelection,
  TranscriptConsumeOptions,
} from './chat-state-v2-backend';
import type { CanonicalChatState } from './chat-state-reducer';
import { ChatScopeDeletingError } from './chat-scope-lifecycle';
import {
  chatSendAdmissionCheck,
  type ChatSendAdmissionCheck,
  type ChatSendAdmissionTab,
} from './chat-send-admission';
import { getApprovalSettingsRevision } from '../approvals/rule-revisions';
import {
  claimWorktreeGitSetup,
  type WorktreeGitSetupOutcome,
} from '../lib/worktree-git-setup';
import {
  beginChatTurnPreparation,
  type PendingChatTurnPreparation,
} from '../lib/chat-turn-preparation';
import {
  automationInfoMessageId,
  buildAutomationInfoMessage,
} from './automation-info-message';
import {
  ChatStateRevisionConflictError,
  type ChatScopeKey,
  type ChatStateCommit,
  type ChatStateStorageDiagnostic,
  type ChatStateTransactionContext,
  type ChildStreamWritePreparation,
  type PreparedChildStreamCommit,
} from './chat-state-contracts';
import type {
  ChatQueueEntryGuard,
  ChatQueuePersistenceMutation,
} from './chat-queue-service';
import {
  SHOW_VISUAL_TOOL_KEY,
  type StageVisualDocument,
  type VisualStagingSidecar,
  type VisualStagingTarget,
  type VisualToolIdentityResolver,
} from '../lib/chat-visual-contracts';

setTranscriptModelResolver({
  resolveModelAlias,
  resolveKnownModel,
  resolveRuntimeModel,
  getModelDisplayName,
  getModelContextWindow: (model, aiCreditsRouted) =>
    aiCreditsRouted
      ? getEffectiveModelContextWindow(model, true)
      : getModelContextWindow(model),
});

export interface ProviderEventInput extends ChatScopeKey {
  chatId: string;
  data: unknown;
  providerType?:
    | 'claude'
    | 'codex'
    | 'ollama'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode';
  mutationId?: string;
  source?: 'provider' | 'terminal';
  turnUserMessageId?: string;
  /**
   * Called once the event's commit holds its place in the scope's commit
   * order. Its producer may then submit its next event without waiting for
   * this commit to be durable (group commit); see
   * `lib/session-event-commit-pipeline.ts`.
   */
  onCommitQueued?: () => void;
}

export type HookChatCreateOutcome = 'created' | 'already_exists' | 'removed';

/**
 * `applied` committed a canonical change. `activity-only` committed nothing
 * because the event only refreshed runtime activity, yet it is still a live
 * event for chat-event listeners. `not-applied` is a duplicate, stale-turn, or
 * other rejected event that must not be delivered.
 */
export type ChatTurnOutcome = 'pending' | 'completed' | 'failed' | 'cancelled';

export type ProviderEventIngestOutcome =
  | 'applied'
  | 'activity-only'
  | 'not-applied';

export type { ChatPickupVerdict } from './chat-input-delivery-state';

// One result for both consumers: the pickup verdict for turn dispatch and the
// tool admission for the Portal projection.
export type { ProviderEventIngestResult } from './provider-event-admission';

interface ProviderEventReduction {
  mutations: ChatCoreMutation[];
  activityOnly: boolean;
  canonicalAdmissionRejectionReason?: string;
  canonicalAdmissionOwnerTurnUserMessageId?: string;
  shouldResolveInputHistory: boolean;
  emptyCompletionDiagnostic?: SessionDiagnosticRecord;
  /** Canonical mode: the receipt turn this root terminal ends; fenced once committed. */
  rootTerminalTurnId?: string;
  terminalAttributionAmbiguous?: boolean;
  /** Interrupted turns this prompt started instead of resuming. */
  abandonedTurns?: string[];
  /** Tool occurrences this event's committed blocks map to, for the Portal. */
  admissionTools: ToolOccurrenceAdmission[];
  /** A mapping bound stopped the capture; the excess stays preview-only. */
  admissionLimited: boolean;
}

type ChatStateRepositoryPort = Pick<
  ChatStateV2Repository,
  keyof ChatStateV2Repository
>;

interface PlanReviewApprovalRecordRequest extends ChatScopeKey {
  chatId: string;
  planId: string;
  revisionNumber: number;
  approvedAt: string;
}

/** A new turn retires the tab's waiting non-proposal plan request. */
function retiresSupersededPlanExit(tab: PersistedChatTab | undefined): boolean {
  return (
    tab?.pendingPlanExit !== undefined &&
    !isPlanProposal({
      ...tab.pendingPlanExit,
      source: tab.pendingPlanExit.source ?? tab.trackedPlanSource,
    })
  );
}

/** Retire only the request; revision tracking remains available during work. */
function retireSupersededPlanExitMutations(
  tab: PersistedChatTab | undefined,
): ChatCoreMutation[] {
  if (!tab || !retiresSupersededPlanExit(tab)) return [];
  return [
    {
      type: 'tab.metadata_patched',
      tabId: tab.id,
      patch: {
        pendingPlanExit: null,
        pendingPlanExitRequestId: null,
      },
    },
  ];
}

function matchesOpenCodePlanReview(
  tab: PersistedChatTab | undefined,
  runtime: ChatRuntimeState | undefined,
  approval: ChatPlanReviewApproval,
): boolean {
  return (
    tab !== undefined &&
    tab.kind !== 'file' &&
    tab.readOnly !== true &&
    tab.planMode === true &&
    tab.trackedPlanSource === 'opencode' &&
    tab.pendingPlanExitRequestId === approval.requestId &&
    tab.pendingPlanExit?.source === 'opencode' &&
    tab.trackedPlanId === approval.planId &&
    tab.latestRevisionNumber === approval.revisionNumber &&
    tab.trackedPlanReviewStatus === 'pending' &&
    persistedTabProvider(tab) === 'opencode' &&
    runtime?.activeTurn === undefined &&
    (runtime?.queuedMessageIds.length ?? 0) === 0 &&
    (runtime === undefined ||
      ![
        'queued',
        'starting',
        'streaming',
        'awaiting_input',
        'completing',
      ].includes(runtime.status))
  );
}

export interface ChatStateServiceOptions {
  withPlanReviewRevision?: <T>(
    request: PlanReviewApprovalRecordRequest,
    commit: () => Promise<T>,
  ) => Promise<{ accepted: false } | { accepted: true; result: T }>;
  withPlanImplementationRevision?: <T>(
    request: PlanReviewApprovalRecordRequest,
    commit: (
      source: NonNullable<PersistedChatTab['trackedPlanSource']>,
    ) => Promise<T>,
  ) => Promise<{ accepted: false } | { accepted: true; result: T }>;
  approvePlanReview?: (
    request: PlanReviewApprovalRecordRequest,
  ) => Promise<boolean>;
  onInputPickup?: InputPickupObserver;
  inputSession?: (
    target: ChatScopeKey & { chatId: string },
  ) => Promise<AgentSession | undefined>;
  repository?: ChatStateRepositoryPort;
  now?: () => number;
  createId?: () => string;
  dispatch?: (
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
  ) => Promise<void>;
  /** Queue-aware adapter; invoke the callback only for immediate admission. */
  submit?: (
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    beforeImmediateDispatch: (options: {
      cancelledBeforeDispatch: boolean;
      startsTurn: boolean;
    }) => Promise<void>,
  ) => Promise<void>;
  authorizeSend?: (
    target: ChatScopeKey & {
      tab: PersistedChatTab;
      allowTrustedTerminal?: boolean;
    },
  ) => Promise<void>;
  /**
   * The outcome of the scope's worktree Git setup that an admitted send's
   * turn waits for and ends with: one still running, or one that failed or
   * was cancelled before any send claimed it. Synchronous.
   */
  awaitWorktreeSetup?: (
    scope: ChatScopeKey,
  ) => Promise<WorktreeGitSetupOutcome> | undefined;
  notifyTurnTerminal?: (event: ChatTurnTerminalNotice) => Promise<void>;
  worktreeSetupQueue?: ChatWorktreeSetupQueue;
  /**
   * The route a send must carry, settled before anything is written: see
   * `resolveSendModelPin`.
   */
  resolveSendModel?: (
    target: ChatScopeKey & { chatId?: string; executionHarness?: ModelHarness },
    stored: string | undefined,
    requested: string | undefined,
  ) => Promise<string | undefined>;
  cleanupSession?: (target: ChatScopeKey & { chatId: string }) => Promise<void>;
  chatCloseBlockReason?: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ) => 'delegates' | 'background' | null;
  schedule?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  recordDiagnostic?: (record: SessionDiagnosticRecord) => void;
  /** Exact MCP-qualified Claude names; defaults empty (fail closed). */
  claudeToolNames?: ReadonlySet<string>;
  /** Exact Codex dynamic tool names; defaults empty (fail closed). */
  codexToolNames?: ReadonlySet<string>;
  /**
   * Trusted ACP (Cursor and OpenCode) session ledger lookup; absent by
   * default (fail closed).
   */
  cursorToolUse?: (target: VisualToolTarget, toolUseId: string) => boolean;
}

export interface ChatHostRuntimeRecovery {
  tabs: PersistedChatTab[];
  runtimeByChatId: Record<string, ChatRuntimeState>;
}

/** Trusted host-only execution metadata that must never come from renderer input. */
export interface TrustedChatCommandExecutionOptions extends ChatCommandExecutionOptions {
  agentSent?: AgentSentInfo;
  /**
   * Set only by the entry points where a person answers: the window's
   * question card and a Portal session of the signed-in user. Every other
   * answer reaches the waiting tool as an agent's.
   */
  answeredByPerson?: true;
}

interface ScopeActivityLease {
  lifecycleKey: string;
  active: boolean;
}

/**
 * A delegated run whose child transcript lives in the chat's delegate log
 * commits only its card's persisted projection: the event becomes a card
 * patch with no items, so the parent transcript neither gains nor loses
 * child rows and its live-only progress is never committed. The event's
 * other consumers (live delivery, the observability sidecar) still see
 * everything it carries.
 */
function withCardOnlyDelegation(input: ProviderEventInput): ProviderEventInput {
  const data = input.data;
  if (
    !isRecord(data) ||
    data.type !== 'canopy_delegation' ||
    !isAgentDelegationTranscript(data.delegation) ||
    data.delegation.transcriptStore !== DELEGATION_TRANSCRIPT_CHAT_LOG
  )
    return input;
  return {
    ...input,
    data: {
      ...data,
      delegation: {
        ...data.delegation,
        snapshot: persistedDelegationSnapshot(data.delegation.snapshot),
        transcriptMode: 'patch',
        transcript: [],
      },
    },
  };
}

type ArchiveChatBackend = Pick<
  ChatStateV2BackendType,
  | 'page'
  | 'toolOutput'
  | 'visual'
  | 'readDelegationItems'
  | 'content'
  | 'blocks'
  | 'search'
>;
type ChatCloseBlockReason = 'delegates' | 'background' | null;
type ChatCloseBlockReasonChecker = (
  projectId: string,
  worktreeId: string,
  chatId: string,
) => ChatCloseBlockReason;

const ARCHIVE_BACKEND_CACHE_LIMIT = 16;
/** Longest a streaming chat's persisted runtime.lastActivityAt may lag. */
const PROVIDER_ACTIVITY_PERSIST_INTERVAL_MS = 10_000;
const EMPTY_SHOW_VISUAL_TOOL_NAMES: ReadonlySet<string> = new Set();

function isSuccessfulToolResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === 'tool_result' &&
    value.isError !== true &&
    value.is_error !== true
  );
}

function hasSuccessfulToolResult(value: unknown): boolean {
  return Array.isArray(value) && value.some(isSuccessfulToolResult);
}

function cursorSnapshotHasToolResult(data: Record<string, unknown>): boolean {
  if (
    hasSuccessfulToolResult(data.content) ||
    hasSuccessfulToolResult(data.blocks)
  )
    return true;
  if (!isRecord(data.message)) return false;
  return (
    hasSuccessfulToolResult(data.message.content) ||
    hasSuccessfulToolResult(data.message.blocks)
  );
}

function cursorPatchHasToolResult(data: Record<string, unknown>): boolean {
  if (!Array.isArray(data.patches)) return false;
  return data.patches.some(
    (patch) => isRecord(patch) && isSuccessfulToolResult(patch.block),
  );
}

/**
 * The ACP harnesses whose sessions record trusted ShowVisual invocations in
 * a turn ledger.
 */
function isAcpVisualProvider(provider: unknown): boolean {
  return provider === 'cursor' || provider === 'opencode';
}

/** True only for native provider result events that can safely admit visuals. */
export function isNativeVisualToolResultEvent(event: {
  providerType?: string;
  source?: string;
  data: unknown;
}): boolean {
  if (event.source === 'terminal' || !isRecord(event.data)) return false;
  const data = event.data;
  if (
    data.type === 'claude_terminal_transcript_sync' ||
    data.type === 'result' ||
    data.type === 'error'
  )
    return false;
  if (event.providerType === 'claude' && data.type === 'user') {
    const message = isRecord(data.message) ? data.message : undefined;
    return (
      hasSuccessfulToolResult(message?.content) ||
      hasSuccessfulToolResult(data.content)
    );
  }
  if (event.providerType === 'codex' && data.type === 'codex') {
    if (!isRecord(data.event) || data.event.type !== 'item.completed')
      return false;
    const item = data.event.item;
    return (
      isRecord(item) &&
      item.type === 'dynamic_tool_call' &&
      item.success !== false &&
      item.status !== 'failed' &&
      item.status !== 'error'
    );
  }
  if (
    !isAcpVisualProvider(event.providerType) &&
    !isAcpVisualProvider(data.provider)
  )
    return false;
  if (data.type === 'canopy_assistant_patch')
    return cursorPatchHasToolResult(data);
  return data.type === 'assistant' && cursorSnapshotHasToolResult(data);
}

/** Resolves only an exact injected provider tool name; empty is fail-closed. */
export function createShowVisualToolKeyResolver(
  knownToolNames: ReadonlySet<string>,
): VisualToolIdentityResolver {
  return (call) =>
    call.toolName !== undefined && knownToolNames.has(call.toolName)
      ? SHOW_VISUAL_TOOL_KEY
      : undefined;
}

function visualResolverForEvent(
  input: ProviderEventInput,
  claudeToolNames: ReadonlySet<string>,
  codexToolNames: ReadonlySet<string>,
  cursorToolUse?: (target: VisualToolTarget, toolUseId: string) => boolean,
): VisualToolIdentityResolver {
  const data = isRecord(input.data) ? input.data : {};
  if (input.providerType === 'claude' && data.type === 'user')
    return createShowVisualToolKeyResolver(claudeToolNames);
  if (input.providerType === 'codex' && data.type === 'codex')
    return (call) =>
      call.codexCallId && call.toolName && codexToolNames.has(call.toolName)
        ? SHOW_VISUAL_TOOL_KEY
        : undefined;
  if (
    (isAcpVisualProvider(input.providerType) ||
      (input.providerType === undefined &&
        isAcpVisualProvider(data.provider))) &&
    (data.type === 'canopy_assistant_patch' || data.type === 'assistant')
  ) {
    const target = {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      chatId: input.chatId,
    };
    return (call) =>
      cursorToolUse?.(target, call.toolUseId)
        ? SHOW_VISUAL_TOOL_KEY
        : undefined;
  }
  return () => undefined;
}

/** Restores trusted prior refs and strips any ref supplied by parsed data. */
export function preserveProviderVisualReferences(
  previousMessages: readonly PersistedChatMessage[],
  reducedMessages: readonly PersistedChatMessage[],
): PersistedChatMessage[] {
  const refsByMessageAndTool = new Map<
    string,
    Map<string, PersistedVisualReference>
  >();
  for (const message of previousMessages)
    for (const block of message.blocks) {
      if (block.type !== 'tool_result' || !block.visualRef) continue;
      const refs =
        refsByMessageAndTool.get(message.id) ??
        new Map<string, PersistedVisualReference>();
      refs.set(block.toolUseId, block.visualRef);
      refsByMessageAndTool.set(message.id, refs);
    }
  return reducedMessages.map((message) => {
    let changed = false;
    const blocks = message.blocks.map((block) => {
      if (block.type !== 'tool_result') return block;
      const trustedRef = refsByMessageAndTool
        .get(message.id)
        ?.get(block.toolUseId);
      if (trustedRef) {
        if (block.visualRef === trustedRef) return block;
        changed = true;
        return { ...block, visualRef: trustedRef };
      }
      if (!block.visualRef) return block;
      const { visualRef: _untrusted, ...safe } = block;
      void _untrusted;
      changed = true;
      return safe;
    });
    return changed ? { ...message, blocks } : message;
  });
}

/** Carries a handoff snapshot on the chat's runtime patch, adding one if absent. */
/** The tab's Auto-routed models, which the Portal's live timer chip reads. */
function tabAutoRoutedModels(
  current: CanonicalChatState,
  chatId: string,
): Readonly<Record<string, string>> | undefined {
  return current.tabsFile.tabs.find((tab) => tab.id === chatId)
    ?.autoRoutedModels;
}

function withTurnSnapshot(
  mutations: ChatCoreMutation[],
  current: Pick<CanonicalChatState, 'runtimeByChatId'>,
  chatId: string,
  snapshot: ChatTurnStateHandoffSnapshot,
  project: (runtime: ChatRuntimeState) => ChatRuntimeState = (runtime) => ({
    ...runtime,
    turn: snapshot.turn,
  }),
): void {
  const index = mutations.findIndex(
    (mutation) =>
      mutation.type === 'runtime.patched' && mutation.chatId === chatId,
  );
  const existing = index >= 0 ? mutations[index] : undefined;
  if (existing?.type === 'runtime.patched') {
    mutations[index] = { ...existing, runtime: project(existing.runtime) };
    return;
  }
  const runtime = current.runtimeByChatId[chatId] ?? {
    status: 'idle' as const,
    queuedMessageIds: [],
  };
  mutations.push({
    type: 'runtime.patched',
    chatId,
    runtime: project(runtime),
  });
}

function initialChatTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine ?? 'New chat';
  return title.slice(0, 40) + (title.length > 40 ? '...' : '');
}

type CreateChatTabCommand = Extract<ChatCommand, { type: 'chat.create_tab' }>;

/**
 * Canonical write form of a caller-supplied model config: unsupported fields
 * are dropped, and any Codex speed is stored as the exact `speed` with its
 * derived `fastMode` (never `true` for Ultra fast).
 */
function canonicalModelConfig(
  config: AgentModelConfig | undefined,
): AgentModelConfig | undefined {
  const normalized = normalizeAgentModelConfig(config);
  return normalized ? canonicalizeAgentModelConfig(normalized) : undefined;
}

function canonicalModelConfigField(
  config: AgentModelConfig | undefined,
): Pick<PersistedChatTab, 'modelConfig'> {
  const modelConfig = canonicalModelConfig(config);
  return modelConfig ? { modelConfig } : {};
}

function persistedChatTabFromCreateCommand(
  command: CreateChatTabCommand,
  createdAt: string,
  projectId: string,
): PersistedChatTab {
  if (command.seedTab) assertUntrustedChatInput(command.seedTab);
  if (
    command.seedTab &&
    command.seedTab.id === command.tabId &&
    isPersistedChatTab(command.seedTab)
  ) {
    const seed = structuredClone(command.seedTab);
    const seedModelConfig = canonicalModelConfig(seed.modelConfig);
    if (seedModelConfig) seed.modelConfig = seedModelConfig;
    else delete seed.modelConfig;
    if (!isCodexSpeed(seed.retainedCodexSpeed)) delete seed.retainedCodexSpeed;
    delete seed.approvalMode;
    delete seed.sessionApprovalRules;
    delete seed.kind;
    delete seed.filePath;
    delete seed.fileViewMode;
    delete seed.fileDiffContext;
    return {
      ...seed,
      id: command.tabId,
      createdAt,
      ...(command.approvalMode ? { approvalMode: command.approvalMode } : {}),
    };
  }
  return {
    ...createPersistedChatTab({
      id: command.tabId,
      createdAt,
      ...(command.title ? { title: command.title } : {}),
      ...(command.providerType ? { providerType: command.providerType } : {}),
      ...(command.model ? { model: command.model } : {}),
      ...(command.defaultStampModel
        ? { defaultStampModel: command.defaultStampModel }
        : {}),
      ...canonicalModelConfigField(command.modelConfig),
      ...(command.planMode ? { planMode: true } : {}),
      ...(command.proposalMode ? { proposalMode: command.proposalMode } : {}),
      ...(typeof command.deferredToolsAllowed === 'boolean'
        ? { deferredToolsAllowed: command.deferredToolsAllowed }
        : {}),
      ...(command.interfaceMode
        ? { interfaceMode: command.interfaceMode }
        : {}),
      ...(command.selectedRepoId
        ? { selectedRepoId: command.selectedRepoId }
        : {}),
    }),
    ...(command.approvalMode ? { approvalMode: command.approvalMode } : {}),
    ...(command.pluginSelections
      ? { pluginSelections: command.pluginSelections }
      : {}),
    ...newChatPluginDefaultsStamp(projectId),
    ...(command.aiCreditsRouting
      ? { aiCreditsRouting: command.aiCreditsRouting }
      : {}),
    ...(typeof command.subscriptionBillingOverride === 'boolean'
      ? {
          subscriptionBillingOverride: command.subscriptionBillingOverride,
        }
      : {}),
  };
}

/**
 * The session rules a tab materialized for a trusted send starts with: only
 * the deny rules the send carries, which can only make it stricter. Grants
 * are never seeded onto a new tab.
 */
function trustedSendDenyRulesField(
  rules: ChatSendMessageRequest['sessionApprovalRules'],
): Pick<PersistedChatTab, 'sessionApprovalRules'> {
  const denies = (rules ?? []).filter((rule) => rule.behavior === 'deny');
  return denies.length > 0 ? { sessionApprovalRules: denies } : {};
}

/**
 * A title a send names its chat with: the name the chat keeps as its custom
 * title, ahead of any generated summary. Undefined when none is usable.
 */
function explicitChatTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  return trimmed ? trimmed.slice(0, CHAT_CUSTOM_TITLE_MAX_LENGTH) : undefined;
}

function hasPlaceholderChatTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === '' || normalized === 'new chat';
}

function initialTitleChatKey(scope: ChatScopeKey, chatId: string): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, chatId]);
}

/** Nullable legacy fields and whitespace alone do not settle naming. */
export function isInitialChatTitleEligible(tab: {
  customTitle?: string | null;
  description?: string | null;
  title?: string | null;
  automaticTitleState?: 'pending' | 'closed';
  kind?: 'chat' | 'file';
  readOnly?: boolean;
}): boolean {
  return (
    tab.kind !== 'file' &&
    tab.readOnly !== true &&
    tab.automaticTitleState !== 'closed' &&
    !tab.customTitle?.trim() &&
    !tab.description?.trim() &&
    (tab.automaticTitleState === 'pending' ||
      hasPlaceholderChatTitle(tab.title ?? ''))
  );
}

function isEditablePersistedChatTab(
  tab: PersistedChatTab | undefined,
): boolean {
  return tab !== undefined && tab.kind !== 'file' && tab.readOnly !== true;
}

function rememberedEditableTabAfterClose(
  tabs: PersistedChatTab[],
  activeTabId: string,
  rememberedTabId: string | undefined,
): PersistedChatTab | undefined {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (isEditablePersistedChatTab(activeTab)) return activeTab;
  const rememberedTab = tabs.find((tab) => tab.id === rememberedTabId);
  if (isEditablePersistedChatTab(rememberedTab)) return rememberedTab;
  return tabs.slice().reverse().find(isEditablePersistedChatTab);
}

function tabWithSendModel(
  tab: PersistedChatTab,
  command: Pick<
    Extract<ChatCommand, { type: 'chat.send_message' }>,
    'model' | 'providerType'
  >,
): PersistedChatTab {
  if (command.model === undefined && command.providerType === undefined) {
    return tab;
  }
  const model = command.model ?? tab.model;
  const providerType =
    command.providerType ?? (model ? getProviderForModel(model) : undefined);
  if (model === tab.model && providerType === tab.providerType) {
    return tab;
  }
  const next = { ...tab, model, providerType };
  const currentHarness =
    tab.executionHarness ??
    (tab.model ? getExecutionHarnessForModel(tab.model) : undefined);
  const targetHarness = model ? getExecutionHarnessForModel(model) : undefined;
  const providerChanged = persistedTabProvider(tab) !== providerType;
  if (providerChanged) {
    delete next.modelConfig;
    delete next.thinkingLevel;
    delete next.codexFastModeEnabled;
    delete next.interfaceMode;
    delete next.executionHarness;
    delete next.executionHarnessExplicitlyChosen;
  }
  if (providerChanged && providerType !== undefined) {
    applyProviderSwitchToSession(
      tab,
      next,
      persistedTabProvider(tab),
      providerType,
    );
  } else if (
    tab.model !== model &&
    currentHarness !== undefined &&
    targetHarness !== undefined &&
    currentHarness !== targetHarness
  ) {
    resetSessionForHarnessChange(tab, next);
    delete next.executionHarness;
    delete next.executionHarnessExplicitlyChosen;
  }
  if (
    providerType === 'cursor' ||
    targetHarness === 'cursor' ||
    providerType === 'copilot' ||
    providerType === 'antigravity' ||
    targetHarness === 'copilot' ||
    targetHarness === 'antigravity'
  ) {
    delete next.aiCreditsRouting;
    delete next.subscriptionBillingOverride;
    delete next.billingExplicitlyChosen;
  }
  return next;
}

function terminalTranscriptTitle(
  data: Record<string, unknown>,
): string | undefined {
  if (
    data.type !== 'claude_terminal_transcript_sync' ||
    !Array.isArray(data.messages)
  ) {
    return undefined;
  }
  for (const candidate of data.messages) {
    if (!isPersistedChatMessage(candidate) || candidate.role !== 'user') {
      continue;
    }
    const text = candidate.blocks
      .filter(
        (
          block,
        ): block is Extract<
          (typeof candidate.blocks)[number],
          { type: 'text' }
        > => block.type === 'text',
      )
      .map((block) => block.text)
      .join('')
      .trim();
    if (text) return initialChatTitle(text);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalStringFieldIsValid(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return value[key] === undefined || typeof value[key] === 'string';
}

function isChatInputDeliveryEvent(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ChatInputDeliveryEvent {
  return (
    value.type === 'canopy_input_delivery' &&
    typeof value.attemptId === 'string' &&
    typeof value.generation === 'string' &&
    (value.provider === 'claude' || value.provider === 'codex') &&
    (value.phase === 'accepted' ||
      value.phase === 'picked-up' ||
      value.phase === 'withdrawn' ||
      value.phase === 'completed' ||
      value.phase === 'unknown') &&
    optionalStringFieldIsValid(value, 'providerTurnId') &&
    optionalStringFieldIsValid(value, 'itemId') &&
    optionalStringFieldIsValid(value, 'userMessageId') &&
    (value.startsTurn === undefined || typeof value.startsTurn === 'boolean') &&
    (value.turnRootAccepted === undefined ||
      typeof value.turnRootAccepted === 'boolean')
  );
}

/**
 * The event with its failure rebuilt from the code alone, and only on an
 * unknown event: malformed metadata never forges a class or summary.
 */
function withTrustedDeliveryFailure(
  event: ChatInputDeliveryEvent,
): ChatInputDeliveryEvent {
  const failure =
    event.phase === 'unknown'
      ? readChatInputDeliveryFailure(event.failure)
      : undefined;
  const trusted: ChatInputDeliveryEvent = { ...event };
  delete trusted.failure;
  return failure ? { ...trusted, failure } : trusted;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isChangedFileInfo(value: unknown): value is ChangedFileInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === 'string' &&
    typeof value.status === 'string' &&
    [
      'added',
      'modified',
      'deleted',
      'renamed',
      'copied',
      'unmerged',
      'type-changed',
      'untracked',
      'unknown',
    ].includes(value.status) &&
    typeof value.insertions === 'number' &&
    Number.isFinite(value.insertions) &&
    typeof value.deletions === 'number' &&
    Number.isFinite(value.deletions) &&
    isOptionalString(value.previousPath) &&
    isOptionalString(value.repoId) &&
    isOptionalString(value.repoName)
  );
}

function isTurnDiffTreeRef(value: unknown): value is TurnDiffTreeRef {
  return (
    isRecord(value) &&
    typeof value.startTree === 'string' &&
    typeof value.endTree === 'string' &&
    isOptionalString(value.repoId) &&
    isOptionalString(value.startHeadCommitSha)
  );
}

/**
 * Scopes whose chat closes have never archived (mirrors the renderer's
 * `shouldArchiveChatTargetOnClose` complement): the synthetic plan-explore,
 * code-review, and pipeline-editor sentinels. Only these may hard-delete a
 * contentful chat through close mode `discard`.
 */
function isHardDeleteChatScope(projectId: string, worktreeId: string): boolean {
  return (
    projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
    projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
    (projectId === PIPELINE_EDITOR_PROJECT_ID &&
      worktreeId === PIPELINE_EDITOR_WORKTREE_ID)
  );
}

function chatRuntimeHostKey(scope: ChatScopeKey, chatId: string): string {
  return `${scope.projectId}\u0000${scope.worktreeId}\u0000${chatId}`;
}

/** Failed reconcile commits of a chat's turn state before it is reported stalled. */
const RECONCILE_TURN_COMMIT_STALL_PASSES = 3;

export interface ChatTurnTerminalNotice extends ChatScopeKey {
  chatId: string;
  userMessageId: string;
  outcome: 'cancelled' | 'failed';
  data: Record<string, unknown>;
}

/** The chat queue's hold on sends while a worktree's Git setup runs. */
export interface ChatWorktreeSetupQueue {
  hold(
    target: ChatScopeKey & { chatId: string },
    turnUserMessageId?: string,
  ): Promise<void>;
  release(
    target: ChatScopeKey & { chatId: string },
    options?: { firstUserMessageId?: string },
  ): Promise<void>;
  /**
   * Removes the sends queued behind the hold, whose setup ended `outcome`,
   * recording their ends in the commit that removes them.
   */
  takeHeld(
    target: ChatScopeKey & { chatId: string },
    outcome: 'cancelled' | 'failed',
  ): Promise<readonly ChatSendMessageRequest[]>;
}

type SendMessageCommand = Extract<
  ChatCommandEnvelope['command'],
  { type: 'chat.send_message' }
>;

/** A Portal or agent send admitted as a `chat.send_message` command. */
interface AdmittedHeldDispatch {
  readonly kind: 'admitted';
  readonly envelope: ChatCommandEnvelope;
  readonly command: SendMessageCommand;
  readonly revision: number;
  readonly startsNewTrackedChat: boolean;
  readonly admissionCheck: ChatSendAdmissionCheck | undefined;
}

/**
 * A desktop send, whose request dispatches unchanged through the chat queue
 * once setup is ready; its prompt is already committed. Unlike an admitted
 * send it keeps the settings it was sent with (model route, approval mode,
 * attachments, hidden context): the message already reads as sent.
 */
interface LocalHeldDispatch {
  readonly kind: 'local';
  readonly request: ChatSendMessageRequest;
  /** Undoes the caller's admission, as its own catch does for a send. */
  readonly onDispatchFailed: (() => Promise<void>) | undefined;
}

interface HeldSend {
  readonly key: string;
  readonly scope: ChatScopeKey;
  readonly command: { readonly chatId: string; readonly userMessageId: string };
  readonly timestamp: number;
  readonly dispatch: AdmittedHeldDispatch | LocalHeldDispatch;
  readonly preparation: PendingChatTurnPreparation | undefined;
  state: 'held' | 'dispatching' | 'settled';
}

interface SetupHold {
  readonly scope: ChatScopeKey;
  readonly chatId: string;
  acquired: Promise<void>;
  owner: HeldSend | undefined;
  /** The prompt commit of the send becoming `owner`, which settling awaits. */
  installing?: Promise<boolean>;
  /**
   * Desktop sends admitted behind the held turn whose queue rows are still
   * being written; settling awaits them, so it takes or releases every row.
   * The chat queue is held meanwhile, so each submit only enqueues its row
   * and never waits on this hold.
   */
  readonly submitting: Set<Promise<void>>;
  /** How the setup ended, once settling has begun. */
  outcome?: WorktreeGitSetupOutcome;
}

/**
 * A desktop send that waited for a chat's worktree setup hold, which ended
 * without the setup becoming ready. The held turn ended the same way.
 */
export class WorktreeSetupEndedError extends Error {
  public readonly outcome: 'cancelled' | 'failed';

  public constructor(outcome: 'cancelled' | 'failed') {
    super(
      outcome === 'failed'
        ? WORKTREE_SETUP_FAILED
        : 'Worktree setup was cancelled.',
    );
    this.name = 'WorktreeSetupEndedError';
    this.outcome = outcome;
  }
}

const UNFINISHED_RUNTIME_STATUSES: readonly string[] = [
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
];

const WORKTREE_SETUP_FAILED = 'The worktree could not be set up.';

/**
 * The chat's turn ends after a runtime commit: a turn whose runtime settles
 * records how it ended, and a turn that runs again drops its record. A
 * settled runtime that stays settled records nothing, since a terminal
 * runtime no longer names the turn it settled.
 */
function settleTurnEnds(
  ends: TurnEnds | undefined,
  previous: ChatRuntimeState | undefined,
  next: ChatRuntimeState,
  turnUserMessageId: string | undefined,
  endedAt: number,
): TurnEnds | undefined {
  if (UNFINISHED_RUNTIME_STATUSES.includes(next.status)) {
    return next.activeTurn
      ? withoutTurnEnd(ends, next.activeTurn.userMessageId)
      : ends;
  }
  const outcome =
    next.status === 'completed' ||
    next.status === 'failed' ||
    next.status === 'cancelled'
      ? next.status
      : undefined;
  if (!outcome || !turnUserMessageId) return ends;
  const settles =
    previous === undefined ||
    !['completed', 'failed', 'cancelled'].includes(previous.status) ||
    (previous.activeTurn?.userMessageId === turnUserMessageId &&
      previous.status !== outcome);
  return settles
    ? withTurnEnd(ends, turnUserMessageId, outcome, endedAt)
    : ends;
}

/**
 * The chat's turn ends as a canonical snapshot places them: each `turn.ended`
 * effect records how its turn ended, and the turn that runs drops its
 * record. The canonical reducer owns turn ends, so these records follow its
 * outbox rather than a runtime status change; only an empty completion,
 * which the runtime fails, records `failed` for a completed end.
 */
function recordSnapshotTurnEnds(
  mutations: ChatCoreMutation[],
  current: CanonicalChatState,
  chatId: string,
  snapshot: ChatTurnStateHandoffSnapshot,
  now: number,
): void {
  const tab = current.tabsFile.tabs.find(
    (candidate) => candidate.id === chatId,
  );
  if (!tab) return;
  const records = new Map<string, ChatTurnRecord>();
  for (const record of [
    ...(snapshot.turnRecords ?? []),
    snapshot.turn.lastEnded,
    snapshot.turn.current,
  ])
    if (record) records.set(record.id, record);
  // This commit's own runtime and turn ends, when it writes them, are newer.
  let runtime = current.runtimeByChatId[chatId];
  let recorded = tab.turnEnds;
  for (const mutation of mutations)
    if (mutation.type === 'runtime.patched' && mutation.chatId === chatId)
      runtime = mutation.runtime;
    else if (
      mutation.type === 'tab.metadata_patched' &&
      mutation.tabId === chatId &&
      'turnEnds' in mutation.patch
    )
      recorded = mutation.patch.turnEnds ?? undefined;
  const empty = emptyCompletionTurn(runtime);
  let ends = recorded;
  for (const effect of snapshot.effects ?? []) {
    if (effect.type !== 'turn.ended') continue;
    const record = records.get(effect.turnId);
    if (record?.userMessageId === undefined) continue;
    ends = withTurnEnd(
      ends,
      record.userMessageId,
      effect.outcome === 'completed' && record.userMessageId === empty
        ? 'failed'
        : effect.outcome,
      record.endedAtMs ?? now,
      tab.trackedPlanImplementation?.userMessageId,
    );
  }
  const running = snapshot.turn.current?.userMessageId;
  if (running !== undefined) ends = withoutTurnEnd(ends, running);
  if (ends !== recorded)
    mutations.push({
      type: 'tab.metadata_patched',
      tabId: chatId,
      patch: { turnEnds: ends ?? null },
    });
  const inputIds = { ...tab.rootTurnInputIds };
  for (const record of Array.from(records.values()))
    if (record.inputIds !== undefined || record.userMessageId === undefined)
      inputIds[record.id] = [...(record.inputIds ?? [])];
  if (!isDeepStrictEqual(tab.rootTurnInputIds, inputIds))
    mutations.push({
      type: 'tab.metadata_patched',
      tabId: chatId,
      patch: { rootTurnInputIds: inputIds },
    });
}

/**
 * The owner a marker write records (CAN-6014): setting the marker takes the
 * turn running now, or none while the chat is idle, which the next turn then
 * adopts; clearing it clears its owner.
 */
function autoArchiveOwnerPatch(
  autoArchive: boolean | null | undefined,
  turn: PersistedChatTurnState | undefined,
): Pick<ChatTabMetadataPatch, 'autoArchiveTurnId'> {
  if (autoArchive === undefined) return {};
  return { autoArchiveTurnId: (autoArchive && turn?.current?.id) || null };
}

/**
 * Settles the auto-archive marker's one-turn lifetime as a turn-state commit
 * lands (CAN-6014). A marker without an owner, set while the chat was idle or
 * written by a hook chat or before owners existed, is adopted by the first
 * turn this commit starts, else the turn it runs. Any turn that
 * starts after the owner drops its marker, even one that also ends in this
 * commit, and the owner ending without completing drops it too.
 */
function settleAutoArchiveOwner(
  mutations: ChatCoreMutation[],
  current: CanonicalChatState,
  chatId: string,
  snapshot: ChatTurnStateHandoffSnapshot,
): void {
  // The tab as this commit leaves it: a tab it restores or creates, then its
  // own patches, are newer than the stored tab.
  const tab = current.tabsFile.tabs.find(
    (candidate) => candidate.id === chatId,
  );
  let marked = tab?.autoArchive === true;
  let owner = tab?.autoArchiveTurnId;
  for (const mutation of mutations)
    if (mutation.type === 'tab.created' && mutation.tab.id === chatId) {
      marked = mutation.tab.autoArchive === true;
      owner = mutation.tab.autoArchiveTurnId;
    } else if (
      mutation.type === 'tab.metadata_patched' &&
      mutation.tabId === chatId
    ) {
      if ('autoArchive' in mutation.patch)
        marked = mutation.patch.autoArchive === true;
      if ('autoArchiveTurnId' in mutation.patch)
        owner = mutation.patch.autoArchiveTurnId ?? undefined;
    }
  if (!marked) {
    if (owner !== undefined)
      mutations.push({
        type: 'tab.metadata_patched',
        tabId: chatId,
        patch: { autoArchiveTurnId: null },
      });
    return;
  }
  const ended = new Map<string, string>();
  for (const effect of snapshot.effects ?? [])
    if (effect.type === 'turn.ended') ended.set(effect.turnId, effect.outcome);
  const starts: string[] = [];
  for (const entry of snapshot.lifecycle ?? [])
    if (entry.transition === 'start' && !starts.includes(entry.turnId))
      starts.push(entry.turnId);
  const running = snapshot.turn.current?.id;
  // Never the turn that just ended: a marker set while idle is for the next.
  const adopted = owner ?? starts[0] ?? running;
  // Starts before the owner's are older turns; an owner from an earlier
  // commit precedes them all.
  const newerStart =
    adopted !== undefined &&
    starts.slice(starts.indexOf(adopted) + 1).some((id) => id !== adopted);
  const endedUnfinished =
    adopted !== undefined &&
    ended.has(adopted) &&
    ended.get(adopted) !== 'completed';
  if (
    endedUnfinished ||
    newerStart ||
    (running !== undefined && adopted !== running)
  )
    mutations.push({
      type: 'tab.metadata_patched',
      tabId: chatId,
      patch: { autoArchive: null, autoArchiveTurnId: null },
    });
  else if (adopted !== owner)
    mutations.push({
      type: 'tab.metadata_patched',
      tabId: chatId,
      patch: { autoArchiveTurnId: adopted },
    });
}

/** The turn the runtime holds as an empty completion, which failed. */
function emptyCompletionTurn(
  runtime: ChatRuntimeState | undefined,
): string | undefined {
  return runtime?.error?.code === 'empty_completion'
    ? runtime.emptyCompletionRecovery?.turnUserMessageId
    : undefined;
}

/**
 * A provider can complete a turn without output, which fails it, and its
 * late output recovers it. Either can follow the turn's canonical end, so
 * the end it recorded follows the runtime.
 */
function reclassifyEmptyCompletionEnd(
  ends: TurnEnds | undefined,
  previous: ChatRuntimeState | undefined,
  next: ChatRuntimeState,
  turnUserMessageId: string | undefined,
): TurnEnds | undefined {
  const emptied = emptyCompletionTurn(next);
  const recovered =
    emptied === undefined &&
    next.status === 'completed' &&
    turnUserMessageId !== undefined &&
    emptyCompletionTurn(previous) === turnUserMessageId
      ? turnUserMessageId
      : undefined;
  const id = emptied ?? recovered;
  if (
    id === undefined ||
    !ends ||
    recordedTurnEnd(ends, id) !== (emptied ? 'completed' : 'failed')
  )
    return ends;
  return withTurnEnd(
    ends,
    id,
    emptied ? 'failed' : 'completed',
    ends[id].endedAt,
  );
}

const UNACCEPTED_TURN_END_RETRIES = 8;

function recordUnacceptedTurnEnd(
  tab: PersistedChatTab,
  userMessageId: string,
  outcome: 'cancelled' | 'failed',
  endedAt: number,
): ChatCoreMutation {
  return {
    type: 'tab.metadata_patched',
    tabId: tab.id,
    patch: {
      ...(tab.trackedPlanImplementation?.userMessageId === userMessageId
        ? {
            turnEnds: withTurnEnd(
              tab.turnEnds,
              userMessageId,
              outcome,
              endedAt,
              tab.lastAcceptedUserMessageId,
            ),
          }
        : {}),
      unacceptedTurnEnds: {
        ...tab.unacceptedTurnEnds,
        [userMessageId]: outcome,
      },
    },
  };
}

function closeUnacceptedTurnTimer(
  tab: PersistedChatTab,
  userMessageId: string,
  startedAt: number,
  completedAt: number,
): ChatCoreMutation[] {
  const promptIndex = tab.messages.findIndex(
    (message) => message.id === userMessageId,
  );
  if (promptIndex < 0) return [];
  const after = tab.messages.slice(promptIndex + 1);
  const nextPrompt = after.findIndex(isUserTurnBoundary);
  const turn = nextPrompt < 0 ? after : after.slice(0, nextPrompt);
  const timed = turn.filter((message) =>
    message.blocks.some((block) => block.type === 'turn_timer'),
  );
  if (timed.length === 0)
    return [
      {
        type: 'message.upserted',
        chatId: tab.id,
        afterMessageId: userMessageId,
        message: {
          id: `${userMessageId}-turn-timer`,
          role: 'system',
          timestamp: completedAt,
          blocks: [{ type: 'turn_timer', startedAt, completedAt }],
        },
      },
    ];
  return closeOpenPersistedTurnTimers(timed, completedAt)
    .filter((message, index) => message !== timed[index])
    .map((message) => ({
      type: 'message.upserted',
      chatId: tab.id,
      message,
    }));
}

interface UnacceptedTurnEnd {
  readonly userMessageId: string;
  readonly startedAt: number;
  readonly outcome: 'cancelled' | 'failed';
  readonly reason: string;
}

/**
 * Records, in order, how turns no provider accepted ended: on their chat
 * (`unacceptedTurnEnds`, which turnOutcome reports, and with the time they
 * ended among its `turnEnds`, so a chat's latest end can be ordered),
 * closing each turn's timer in the transcript, and, while no other turn runs
 * the chat, in the chat's runtime, which then describes the last of them. Returns the chat
 * mutations and the runtime they leave, `runtime` itself when it is kept.
 */
function recordUnacceptedTurnEnds(
  tab: PersistedChatTab,
  runtime: ChatRuntimeState | undefined,
  ends: readonly UnacceptedTurnEnd[],
  occurredAt: number,
): { mutations: ChatCoreMutation[]; runtime: ChatRuntimeState | undefined } {
  const unacceptedTurnEnds = { ...tab.unacceptedTurnEnds };
  let turnEnds = tab.turnEnds;
  const timers: ChatCoreMutation[] = [];
  let ended = runtime;
  for (const end of ends) {
    unacceptedTurnEnds[end.userMessageId] = end.outcome;
    // Keeps the last accepted end, which the chat's latest end is ordered
    // against.
    turnEnds = withTurnEnd(
      turnEnds,
      end.userMessageId,
      end.outcome,
      occurredAt,
      tab.trackedPlanImplementation?.userMessageId ??
        tab.lastAcceptedUserMessageId,
    );
    timers.push(
      ...closeUnacceptedTurnTimer(
        tab,
        end.userMessageId,
        end.startedAt,
        occurredAt,
      ),
    );
    if (
      ended !== undefined &&
      UNFINISHED_RUNTIME_STATUSES.includes(ended.status) &&
      ended.activeTurn?.userMessageId !== end.userMessageId
    )
      continue;
    ended = {
      status: end.outcome,
      queuedMessageIds: ended?.queuedMessageIds ?? [],
      ...(ended?.queuedMessages
        ? { queuedMessages: ended.queuedMessages }
        : {}),
      // The canonical turn state never saw this turn; keep it as it was.
      ...(ended?.turn !== undefined ? { turn: ended.turn } : {}),
      activeTurn: {
        userMessageId: end.userMessageId,
        startedAt: end.startedAt,
      },
      lastActivityAt: occurredAt,
      ...(end.outcome === 'failed'
        ? {
            error: {
              code: 'provider_error' as const,
              message: end.reason,
              retryable: true,
              occurredAt: new Date(occurredAt).toISOString(),
            },
          }
        : {}),
    };
  }
  return {
    mutations: [
      {
        type: 'tab.metadata_patched',
        tabId: tab.id,
        patch: { unacceptedTurnEnds, turnEnds },
      },
      ...timers,
    ],
    runtime: ended,
  };
}

function unacceptedTurnMutationId(
  target: { chatId: string; userMessageId: string },
  outcome: 'cancelled' | 'failed',
): string {
  return `${target.chatId}:${target.userMessageId}:unaccepted:${outcome}`;
}

/**
 * The user messages of a chat whose transcript position does not mark the
 * start of a turn yet: queued sends, and the queued send the chat queue is
 * `dispatching` until its provider accepts it, which the chat persists before
 * its prompt event moves it to its dispatch position; and sends that ended
 * before any provider accepted them.
 */
function provisionalTurnIds(
  state: CanonicalChatState,
  chatId: string,
  dispatching: string | undefined,
): ReadonlySet<string> {
  const tab =
    state.tabsFile.tabs.find((candidate) => candidate.id === chatId) ??
    state.archivesFile.archived.find((entry) => entry.tab.id === chatId)?.tab;
  const runtime = state.runtimeByChatId[chatId];
  const ids = new Set<string>([
    ...Object.keys(tab?.unacceptedTurnEnds ?? {}),
    ...(runtime?.queuedMessageIds ?? []),
    ...(runtime?.queuedMessages ?? []).map(
      (message) => message.request.userMessageId,
    ),
  ]);
  if (
    dispatching !== undefined &&
    dispatching !== tab?.lastAcceptedUserMessageId
  ) {
    ids.add(dispatching);
  }
  return ids;
}

/** A chat's default approval mode and the settings revision it was read at. */
interface AdmissionDefaultRead {
  approvalMode: ApprovalMode;
  settingsRevision: number;
}

/**
 * Reads, before a send commits, the default its admission check can admit it
 * at: the default cannot be read in the check's synchronous step.
 */
async function readAdmissionDefault(
  scope: ChatScopeKey,
): Promise<AdmissionDefaultRead> {
  const settingsRevision = getApprovalSettingsRevision();
  // Lazy: the approval reads stay off the chat state graph's load path.
  const { resolvePersistedApprovalMode } =
    await import('../lib/approval-mode-resolution');
  return {
    approvalMode: await resolvePersistedApprovalMode(
      scope.projectId,
      scope.worktreeId,
    ),
    settingsRevision,
  };
}

/**
 * The approval a send's admission check admitted it against
 * (`admittedApproval`), which its turn, even a queued one, never exceeds. Taken
 * from the tab the check passed, in the check's synchronous step, so nothing
 * that changes after the check reaches it. A chat without a saved mode was
 * admitted at its default, read before the check; that read counts only if no
 * approval setting changed since, otherwise the send is admitted at Ask. Root
 * agent sends' checks already refuse once the settings changed, so they never
 * reach that fallback.
 */
function admittedApprovalOf(
  tab: ChatSendAdmissionTab,
  defaultRead: AdmissionDefaultRead | undefined,
): ChatSendAdmittedApproval {
  const defaultMode =
    defaultRead?.settingsRevision === getApprovalSettingsRevision()
      ? defaultRead.approvalMode
      : FAIL_CLOSED_APPROVAL_MODE;
  return {
    approvalMode: tab.approvalMode ?? defaultMode,
    sessionApprovalRules: tab.sessionApprovalRules ?? [],
  };
}

/**
 * A pipeline send's override (D2) commits its model and composer settings to
 * the tab with the message, as the automation session prompt does, so the chat
 * keeps them afterwards.
 */
function withTurnOverrideTabSettings(
  command: SendMessageCommand,
): SendMessageCommand {
  const override = command.turnOverride;
  if (!override) return command;
  return {
    ...command,
    ...(override.model !== undefined ? { model: override.model } : {}),
    ...(override.providerType !== undefined
      ? { providerType: override.providerType }
      : {}),
    ...(override.modelConfig !== undefined
      ? { modelConfig: override.modelConfig }
      : {}),
    ...(override.planMode !== undefined ? { planMode: override.planMode } : {}),
  };
}

/**
 * The override's fields on the request: its model settings, reapplied over the
 * tab so a request rebuilt after a setup hold keeps them; its harness, plugins
 * and approval mode, the last also its admitted approval; and a changed
 * runtime's session reset. A named model runs as named, so Auto routing skips
 * the turn.
 */
function turnOverrideRequestFields(
  override: ChatSendTurnOverride | undefined,
  canonical: PersistedChatTab,
): Partial<ChatSendMessageRequest> {
  if (!override) return {};
  const sessionApprovalRules = canonical.sessionApprovalRules ?? [];
  return {
    turnOverride: override,
    ...(override.model !== undefined
      ? { model: override.model, modelSelectionMode: undefined }
      : {}),
    ...(override.providerType !== undefined
      ? { providerType: override.providerType }
      : {}),
    ...(override.modelConfig !== undefined
      ? { modelConfig: override.modelConfig }
      : {}),
    ...(override.planMode !== undefined ? { planMode: override.planMode } : {}),
    ...(override.executionHarness
      ? { executionHarness: override.executionHarness }
      : {}),
    ...(override.pluginSelections
      ? { pluginSelections: override.pluginSelections }
      : {}),
    ...(override.approvalMode
      ? {
          approvalMode: override.approvalMode,
          sessionApprovalRules,
          admittedApproval: {
            approvalMode: override.approvalMode,
            sessionApprovalRules,
          },
        }
      : {}),
    ...(override.resetRuntime
      ? {
          sdkSessionId: undefined,
          globalInstructionsSnapshot: undefined,
          codexReconstructionSeedId: undefined,
          claudeForkSession: undefined,
          claudeForkResumeAt: undefined,
          claudeForkStartsFresh: undefined,
        }
      : {}),
  };
}

function admittedSendRequest(
  scope: ChatScopeKey,
  command: SendMessageCommand,
  canonical: PersistedChatTab,
  {
    startsNewTrackedChat,
    asyncAnswer,
  }: {
    startsNewTrackedChat: boolean;
    asyncAnswer?: { questionId: string; answers: McpQuestionAnswer[] };
  },
): ChatSendMessageRequest {
  // An automation's own send (CAN-4549) keeps the native send's reading of a
  // terminal tab: with Claude TUI chats off, its terminal-owned session and
  // saved instructions are ignored, so the turn starts clean.
  const nativeAutomationTab =
    command.automationDispatch !== undefined &&
    isTerminalBackedInterfaceMode(canonical.interfaceMode) &&
    getEffectiveClaudeChatInterfaceMode(canonical.interfaceMode) === 'canopy';
  const sdkSessionId = nativeAutomationTab ? undefined : canonical.sdkSessionId;
  const interfaceMode = nativeAutomationTab
    ? undefined
    : canonical.interfaceMode;
  const resumePointRequired =
    canonical.forkedFrom?.resumePointRequired === true &&
    sdkSessionId !== undefined &&
    canonical.claudeForkSessionOnNextSend === true;
  const claudeForkResumeAt =
    sdkSessionId && canonical.claudeForkSessionOnNextSend && resumePointRequired
      ? resolveClaudeForkResumePoint(
          canonical.messages,
          canonical.forkedFrom?.atMessageId,
        )
      : undefined;
  const safeSdkSessionId =
    sdkSessionId &&
    canonical.claudeForkSessionOnNextSend &&
    resumePointRequired &&
    !claudeForkResumeAt
      ? undefined
      : sdkSessionId;
  const claudeForkStartsFresh =
    Boolean(sdkSessionId) &&
    canonical.claudeForkSessionOnNextSend === true &&
    resumePointRequired &&
    !claudeForkResumeAt;
  return {
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: command.chatId,
    userMessageId: command.userMessageId,
    ...(asyncAnswer
      ? {
          clientUserMessageId: `answer-${asyncAnswer.questionId}`,
          asyncQuestionId: asyncAnswer.questionId,
        }
      : {}),
    ...(command.agentSent ? { agentSent: command.agentSent } : {}),
    ...(command.agentSenderProvenance
      ? { agentSenderProvenance: command.agentSenderProvenance }
      : {}),
    ...(command.hiddenContext ? { hiddenContext: command.hiddenContext } : {}),
    ...(command.agentSendSetup
      ? { agentSendSetup: command.agentSendSetup }
      : {}),
    text: command.text,
    ...(command.fileReferences
      ? { fileReferences: command.fileReferences }
      : {}),
    ...(command.attachmentPaths
      ? { attachmentPaths: command.attachmentPaths }
      : {}),
    ...(command.attachmentPromptContexts
      ? { attachmentPromptContexts: command.attachmentPromptContexts }
      : {}),
    ...(command.inputMode ? { inputMode: command.inputMode } : {}),
    ...(canonical.executionHarness
      ? { executionHarness: canonical.executionHarness }
      : {}),
    ...(canonical.thinkingLevel
      ? { thinkingLevel: canonical.thinkingLevel }
      : {}),
    ...(canonical.codexFastModeEnabled !== undefined
      ? { codexFastModeEnabled: canonical.codexFastModeEnabled }
      : {}),
    ...(canonical.globalInstructionsSnapshot && !nativeAutomationTab
      ? { globalInstructionsSnapshot: canonical.globalInstructionsSnapshot }
      : {}),
    ...(canonical.providerType ? { providerType: canonical.providerType } : {}),
    ...(canonical.model ? { model: canonical.model } : {}),
    // The canonical tab is the authority: a surface that entered Auto with
    // `chat.patch_tab_settings` (Remote Control) sends an ordinary message
    // with no mode on it, and that turn must still route.
    ...((command.modelSelectionMode ?? canonical.modelSelectionMode) === 'auto'
      ? { modelSelectionMode: 'auto' as const }
      : {}),
    ...(canonical.modelConfig ? { modelConfig: canonical.modelConfig } : {}),
    ...(canonical.pluginSelections
      ? { pluginSelections: canonical.pluginSelections }
      : {}),
    ...(typeof canonical.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: canonical.deferredToolsAllowed }
      : {}),
    ...(command.planReviewApproval
      ? { planMode: false }
      : canonical.planMode
        ? { planMode: true }
        : {}),
    ...(canonical.approvalMode ? { approvalMode: canonical.approvalMode } : {}),
    ...(canonical.sessionApprovalRules
      ? { sessionApprovalRules: canonical.sessionApprovalRules }
      : {}),
    ...(interfaceMode ? { interfaceMode } : {}),
    ...(safeSdkSessionId ? { sdkSessionId: safeSdkSessionId } : {}),
    ...(canonical.codexReconstructionSeedId
      ? { codexReconstructionSeedId: canonical.codexReconstructionSeedId }
      : {}),
    ...(safeSdkSessionId && canonical.claudeForkSessionOnNextSend
      ? {
          claudeForkSession: true,
          ...(claudeForkResumeAt ? { claudeForkResumeAt } : {}),
        }
      : {}),
    ...(claudeForkStartsFresh ? { claudeForkStartsFresh: true } : {}),
    ...(canonical.selectedRepoId
      ? { selectedRepoId: canonical.selectedRepoId }
      : {}),
    ...(canonical.proposalMode
      ? { codexProposalMode: canonical.proposalMode }
      : {}),
    ...(canonical.aiCreditsRouting
      ? { aiCreditsRouting: canonical.aiCreditsRouting }
      : {}),
    ...(canonical.subscriptionBillingOverride
      ? { subscriptionBillingOverride: true }
      : {}),
    ...(startsNewTrackedChat ? { startsNewTrackedChat: true } : {}),
    ...turnOverrideRequestFields(command.turnOverride, canonical),
    ...automationDispatchRequestFields(command.automationDispatch),
  };
}

/**
 * A refused start never runs; its agent acceptance row must not stay pending,
 * or watchers could bind to an input that never completes.
 */
function settleRefusedAgentInput(
  tab: PersistedChatTab | undefined,
  userMessageId: string,
  reason: string,
): ChatCoreMutation[] {
  const ledger = tab?.inputDelivery;
  if (
    !tab ||
    !isInputLedger(ledger) ||
    !ledger.rows.some(
      (row) =>
        row.id === userMessageId &&
        row.state === 'queued' &&
        row.payload.agentSenderProvenance !== undefined,
    )
  )
    return [];
  return [
    {
      type: 'tab.metadata_patched',
      tabId: tab.id,
      patch: {
        inputDelivery: {
          ...ledger,
          rows: ledger.rows.map((row) =>
            row.id === userMessageId
              ? {
                  ...row,
                  revision: row.revision + 1,
                  state: 'cancelled' as const,
                  reason,
                }
              : row,
          ),
        },
      },
    },
  ];
}

function awaitingSetupKey(
  scope: ChatScopeKey,
  message: { chatId: string; userMessageId: string },
): string {
  return `${chatRuntimeHostKey(scope, message.chatId)}\u0000${message.userMessageId}`;
}

function chatScopeLifecycleKey(scope: ChatScopeKey): string {
  return `${scope.projectId}\u0000${scope.worktreeId}`;
}

/** Commands that can start or continue a provider turn in a chat. */
function isTurnStartingCommand(command: ChatCommand): boolean {
  return (
    command.type === 'chat.send_message' ||
    command.type === 'chat.force_queued_message' ||
    command.type === 'chat.steer_queued_message' ||
    command.type === 'chat.input_delivery_action' ||
    command.type === 'chat.answer_question'
  );
}

/**
 * Commands a retired chat scope (a legacy plan chat) refuses: every turn
 * start plus the other commands that write user messages into a chat.
 * Closing, archiving and dismissing stay allowed so old chats can be cleaned
 * up.
 */
function isRetiredScopeRefusedCommand(command: ChatCommand): boolean {
  return (
    isTurnStartingCommand(command) ||
    command.type === 'chat.commit_terminal_initial_prompt' ||
    command.type === 'chat.fork_tab' ||
    command.type === 'chat.import_session'
  );
}

function commandResult(
  envelope: ChatCommandEnvelope,
  revision: number,
  outcome: ChatCommandResult['outcome'],
  details: Partial<
    Pick<ChatCommandResult, 'reason' | 'entityId' | 'messageId' | 'archivedAt'>
  > = {},
): ChatCommandResult {
  return {
    commandId: envelope.commandId,
    revision,
    outcome,
    ...details,
  };
}

/**
 * Only mutations that can discard, replace, or reorder existing user state
 * reject a stale client revision. Idempotent metadata patches intentionally
 * commute with newer transcript/runtime commits; applying the envelope's
 * observed revision to those patches would make independent commands from one
 * interaction conflict with each other.
 */
function requiresExpectedRevision(command: ChatCommand): boolean {
  switch (command.type) {
    case 'chat.reorder_tabs':
    case 'chat.close_tab':
    case 'chat.close_tabs':
    case 'chat.archive_tab':
    case 'chat.restore_archive':
    case 'chat.edit_queued_message':
    case 'chat.move_queued_message':
    case 'chat.cancel_queued_message':
    case 'chat.force_queued_message':
    case 'chat.answer_question':
    case 'chat.dismiss_question':
    case 'chat.reset_to_point':
      return true;
    default:
      return false;
  }
}

function expectedRevisionForCommand(
  envelope: ChatCommandEnvelope,
): number | undefined {
  // A remote view acknowledges a particular observed message. Unlike local
  // desired-state metadata patches, it must not clear output committed since
  // the portal adapter checked that message against its snapshot.
  if (
    envelope.origin === 'portal' &&
    envelope.command.type === 'chat.mark_read'
  ) {
    return envelope.expectedTabRevision ?? envelope.expectedRevision;
  }
  if (!requiresExpectedRevision(envelope.command)) return undefined;
  return envelope.expectedTabRevision ?? envelope.expectedRevision;
}

function expectedRevisionOption(
  envelope: ChatCommandEnvelope,
): { expectedRevision: number } | Record<string, never> {
  const expectedRevision = expectedRevisionForCommand(envelope);
  return expectedRevision === undefined ? {} : { expectedRevision };
}

function buildUserMessage(
  command:
    | ChatSendMessageRequest
    | Extract<
        ChatCommand,
        {
          type: 'chat.send_message' | 'chat.commit_terminal_initial_prompt';
        }
      >,
  timestamp: number,
): PersistedChatMessage {
  const autoResume = readAutoResumeMetadata(
    'autoResume' in command ? command.autoResume : undefined,
  );
  return {
    id: command.userMessageId,
    role: 'user',
    // A message an external MCP agent sent stays the person's own.
    ...(autoResume ? { autoResume } : {}),
    userMessageSource: autoResume
      ? 'auto_resume'
      : 'agentSent' in command && chatAgentSent(command.agentSent)
        ? 'agent'
        : 'watcherFired' in command && command.watcherFired
          ? 'watcher'
          : 'initiationSource' in command && command.initiationSource === 'hook'
            ? 'hook'
            : 'human',
    ...('agentSent' in command && command.agentSent
      ? { agentSent: command.agentSent }
      : {}),
    timestamp,
    blocks: [
      ...(command.fileReferences?.length
        ? [
            {
              type: 'file_references' as const,
              references: command.fileReferences,
            },
          ]
        : []),
      { type: 'text' as const, text: command.text },
    ],
    ...(command.attachmentPaths?.length
      ? { attachmentPaths: command.attachmentPaths }
      : {}),
    ...(command.attachmentPromptContexts?.length
      ? { attachmentPromptContexts: command.attachmentPromptContexts }
      : {}),
    ...(command.inputMode && !(autoResume && !autoResume.resendsUserMessage)
      ? { inputMode: command.inputMode }
      : {}),
    ...('watcherFired' in command && command.watcherFired
      ? { watcherFired: command.watcherFired }
      : {}),
  };
}

function eventMutationId(input: ProviderEventInput): string {
  if (input.mutationId) return input.mutationId;
  return createHash('sha256')
    .update(input.projectId)
    .update('\u0000')
    .update(input.worktreeId)
    .update('\u0000')
    .update(input.chatId)
    .update('\u0000')
    .update(JSON.stringify(input.data))
    .digest('hex');
}

function transcriptState(
  tab: PersistedChatTab,
  runtime: ChatRuntimeState | undefined,
): TranscriptReducerState {
  return {
    messages: tab.messages,
    status:
      runtime?.status === 'failed'
        ? 'error'
        : runtime &&
            ['starting', 'streaming', 'awaiting_input', 'completing'].includes(
              runtime.status,
            )
          ? 'streaming'
          : 'idle',
    error: runtime?.error?.message ?? null,
    planMode: tab.planMode ?? false,
    ...(tab.providerType ? { providerType: tab.providerType } : {}),
    ...(tab.sdkSessionId ? { sdkSessionId: tab.sdkSessionId } : {}),
    ...(tab.model ? { model: tab.model } : {}),
    ...(tab.usage ? { usage: tab.usage } : {}),
    ...(tab.agentUsage ? { agentUsage: tab.agentUsage } : {}),
    ...(tab.llmProviderUsageLimitBanner
      ? { llmProviderUsageLimitBanner: tab.llmProviderUsageLimitBanner }
      : {}),
  };
}

function mergePromptMessages(
  messages: readonly PersistedChatMessage[],
  data: Record<string, unknown>,
  pendingQuestions: readonly PersistedPendingQuestion[] = [],
): PersistedChatMessage[] {
  const next = [...messages];
  const imported = Array.isArray(data.canopy_persisted_messages)
    ? data.canopy_persisted_messages
    : [];
  for (const candidate of imported) {
    if (!isPersistedChatMessage(candidate)) continue;
    const question = pendingQuestions.find(
      (pending) =>
        pending.answeredAt !== undefined &&
        (pending.requestId === data.canopy_async_question_id ||
          ('answerUserMessageId' in pending &&
            pending.answerUserMessageId === data.canopy_turn_user_message_id)),
    );
    const answers = question?.answers;
    const message: PersistedChatMessage =
      question && answers && candidate.id === data.canopy_turn_user_message_id
        ? {
            ...candidate,
            blocks: candidate.blocks.map((block) =>
              block.type === 'text'
                ? {
                    ...block,
                    asyncQuestionAnswer: {
                      requestId: question.requestId,
                      startsTurn: true,
                      answers,
                    },
                    ...(block.steering
                      ? {
                          steering: {
                            ...block.steering,
                            startsTurn: true,
                          },
                        }
                      : {}),
                  }
                : block,
            ),
          }
        : candidate;
    const index = next.findIndex((current) => current.id === message.id);
    if (index < 0) next.push(message);
    else {
      const existing = next[index];
      if (!existing) {
        next.push(message);
        continue;
      }
      const answerBlock = existing.blocks.find(
        (block) => block.type === 'text' && block.asyncQuestionAnswer,
      );
      const asyncQuestionAnswer =
        answerBlock?.type === 'text'
          ? answerBlock.asyncQuestionAnswer
          : undefined;
      const steering =
        answerBlock?.type === 'text' ? answerBlock.steering : undefined;
      const withAnswerDecoration: PersistedChatMessage = asyncQuestionAnswer
        ? {
            ...message,
            blocks: message.blocks.map((block) =>
              block.type === 'text'
                ? {
                    ...block,
                    asyncQuestionAnswer,
                    ...(steering
                      ? {
                          steering: {
                            ...steering,
                            startsTurn: asyncQuestionAnswer.startsTurn,
                          },
                        }
                      : {}),
                  }
                : block,
            ),
          }
        : message;
      const {
        inputMode: candidateInputMode,
        userMessageSource: candidateUserMessageSource,
        timestamp: _candidateTimestamp,
        ...candidateFields
      } = withAnswerDecoration;
      void _candidateTimestamp;
      const normalized: PersistedChatMessage = {
        ...candidateFields,
        timestamp: existing.timestamp,
        ...(existing.userMessageSource !== undefined
          ? { userMessageSource: existing.userMessageSource }
          : candidateUserMessageSource !== undefined
            ? { userMessageSource: candidateUserMessageSource }
            : {}),
        ...(existing.inputMode !== undefined
          ? { inputMode: existing.inputMode }
          : candidateInputMode !== undefined && candidateInputMode !== 'typed'
            ? { inputMode: candidateInputMode }
            : {}),
        ...(existing.autoResume !== undefined
          ? { autoResume: existing.autoResume }
          : {}),
        ...(existing.watcherFired !== undefined
          ? { watcherFired: existing.watcherFired }
          : {}),
        ...(existing.attachmentPaths !== undefined
          ? { attachmentPaths: existing.attachmentPaths }
          : {}),
        ...(existing.attachmentPromptContexts !== undefined
          ? { attachmentPromptContexts: existing.attachmentPromptContexts }
          : {}),
      };
      next[index] = isSamePersistedValue(existing, normalized)
        ? existing
        : normalized;
    }
  }
  // Only a real user-prompt event establishes a new turn. Queued prompts and
  // answers may have been submitted during an earlier turn; move their boundary
  // to the actual dispatch position while retaining structured answer data.
  const promptIndex = next.findIndex(
    (message) => message.id === data.canopy_turn_user_message_id,
  );
  const prompt = next[promptIndex];
  if (
    prompt &&
    (promptIndex < next.length - 1 ||
      prompt.blocks.some(
        (block) =>
          block.type === 'text' &&
          block.asyncQuestionAnswer?.startsTurn === false,
      ))
  ) {
    next.splice(promptIndex, 1);
    next.push({
      ...prompt,
      blocks: prompt.blocks.map((block) =>
        block.type === 'text' && block.asyncQuestionAnswer
          ? {
              ...block,
              asyncQuestionAnswer: {
                ...block.asyncQuestionAnswer,
                startsTurn: true,
              },
              ...(block.steering
                ? {
                    steering: {
                      ...block.steering,
                      startsTurn: true,
                    },
                  }
                : {}),
            }
          : block,
      ),
    });
  }
  return next;
}

/**
 * Structural equality of persisted JSON data, independent of key order and
 * object prototypes; an undefined member is equivalent to an absent one.
 */
function isSamePersistedValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => isSamePersistedValue(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter(
    (key) => right[key] !== undefined,
  );
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => isSamePersistedValue(left[key], right[key]))
  );
}

/** Whether a provider runtime patch only advances a recent activity time. */
function isRecentActivityOnlyRuntime(
  current: ChatRuntimeState | undefined,
  next: ChatRuntimeState,
  now: number,
): boolean {
  if (!current) return false;
  const { lastActivityAt: currentActivityAt, ...currentRest } = current;
  const { lastActivityAt: _nextActivityAt, ...nextRest } = next;
  void _nextActivityAt;
  return (
    isSamePersistedValue(currentRest, nextRest) &&
    now - (currentActivityAt ?? 0) < PROVIDER_ACTIVITY_PERSIST_INTERVAL_MS
  );
}

function removeAdmittingRuntimeEntry(
  runtime: ChatRuntimeState | undefined,
  userMessageId: string,
): ChatRuntimeState | undefined {
  if (!runtime?.queuedMessages) return runtime;
  const queuedMessages = runtime.queuedMessages.filter(
    (message) =>
      message.admitting !== true ||
      message.request.userMessageId !== userMessageId,
  );
  if (queuedMessages.length === runtime.queuedMessages.length) return runtime;
  const {
    queuedMessages: _previousQueuedMessages,
    ...runtimeWithoutQueuedMessages
  } = runtime;
  void _previousQueuedMessages;
  return queuedMessages.length > 0
    ? { ...runtimeWithoutQueuedMessages, queuedMessages }
    : runtimeWithoutQueuedMessages;
}

function runtimeForEvent(
  current: ChatRuntimeState | undefined,
  data: unknown,
  now: number,
  turnUserMessageId?: string,
  codexRootThreadId?: string,
  turnHasVisibleOutput?: boolean,
): ChatRuntimeState {
  const base: ChatRuntimeState = current ?? {
    status: 'idle',
    queuedMessageIds: [],
  };
  if (!isRecord(data)) return { ...base, lastActivityAt: now };
  const eventTurnUserMessageId =
    typeof data.canopy_turn_user_message_id === 'string'
      ? data.canopy_turn_user_message_id
      : undefined;
  const effectiveTurnUserMessageId =
    turnUserMessageId ?? eventTurnUserMessageId;
  const activeTurn =
    base.activeTurn ??
    (effectiveTurnUserMessageId
      ? { userMessageId: effectiveTurnUserMessageId, startedAt: now }
      : undefined);
  const settledTurnRevival =
    ['completed', 'failed', 'cancelled', 'interrupted'].includes(base.status) &&
    isSettledProviderTurnRevival(data, turnUserMessageId);
  if (
    ['completed', 'failed', 'cancelled', 'interrupted'].includes(base.status) &&
    isClaudeChildFrame(data)
  ) {
    return base;
  }
  const buildEmptyCompletionRuntime = (): ChatRuntimeState | null => {
    if (!effectiveTurnUserMessageId || turnHasVisibleOutput !== false) {
      return null;
    }
    // The Claude CLI ran this command itself and never called the model, so
    // no output is missing: `/clear` prints nothing (CAN-6416).
    if (data.type === 'result' && typeof data.local_command === 'string') {
      return null;
    }
    const sessionId =
      typeof data.session_id === 'string'
        ? data.session_id
        : activeTurn?.sessionId;
    return {
      status: 'failed',
      activeTurn: {
        ...(activeTurn ?? {
          userMessageId: effectiveTurnUserMessageId,
          startedAt: now,
        }),
        ...(sessionId ? { sessionId } : {}),
      },
      queuedMessageIds: base.queuedMessageIds,
      ...(base.queuedMessages ? { queuedMessages: base.queuedMessages } : {}),
      lastActivityAt: now,
      error: {
        code: 'empty_completion',
        message:
          'The provider completed this turn without returning any output.',
        retryable: true,
        occurredAt: new Date(now).toISOString(),
      },
      emptyCompletionRecovery: {
        turnUserMessageId: effectiveTurnUserMessageId,
        detectedAt: now,
        automaticRetryAllowed: false,
      },
    };
  };
  const recoversEmptyCompletion =
    base.error?.code === 'empty_completion' &&
    base.emptyCompletionRecovery?.turnUserMessageId ===
      effectiveTurnUserMessageId &&
    !settledTurnRevival &&
    turnHasVisibleOutput === true;
  if (
    recoversEmptyCompletion &&
    !isRootTerminalChatEventData(data, codexRootThreadId)
  ) {
    return {
      status: 'completed',
      queuedMessageIds: base.queuedMessageIds,
      ...(base.queuedMessages ? { queuedMessages: base.queuedMessages } : {}),
      lastActivityAt: now,
    };
  }
  const retainsEmptyCompletion =
    base.error?.code === 'empty_completion' &&
    base.emptyCompletionRecovery?.turnUserMessageId ===
      effectiveTurnUserMessageId &&
    !settledTurnRevival &&
    turnHasVisibleOutput === false;
  if (
    retainsEmptyCompletion &&
    !isRootTerminalChatEventData(data, codexRootThreadId)
  ) {
    return { ...base, lastActivityAt: now };
  }
  if (data.type === 'codex' && isRecord(data.event)) {
    const eventType = data.event.type;
    const item = isRecord(data.event.item) ? data.event.item : undefined;
    if (
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(
        base.status,
      ) &&
      isCodexSubagentFollowupEvent(data, codexRootThreadId)
    ) {
      return { ...base, lastActivityAt: now };
    }
    if (
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(
        base.status,
      ) &&
      (eventType === 'item.started' ||
        eventType === 'item.updated' ||
        eventType === 'item.completed') &&
      item?.type === 'agent_message' &&
      item.delivery === 'async'
    ) {
      return { ...base, lastActivityAt: now };
    }
    if (eventType === 'turn.started') {
      return {
        ...base,
        status: 'streaming',
        ...(activeTurn ? { activeTurn } : {}),
        lastActivityAt: now,
      };
    }
    if (
      eventType === 'turn.completed' &&
      !isCodexSubagentTerminalEvent(data, codexRootThreadId)
    ) {
      // A stop can tear the session down before its terminal result, so the
      // interrupted completion itself must settle the turn as cancelled.
      if (data.event.status === 'interrupted') {
        return {
          status: 'cancelled',
          queuedMessageIds: base.queuedMessageIds,
          ...(base.queuedMessages
            ? { queuedMessages: base.queuedMessages }
            : {}),
          lastActivityAt: now,
        };
      }
      return (
        buildEmptyCompletionRuntime() ?? {
          status: 'completed',
          queuedMessageIds: base.queuedMessageIds,
          ...(base.queuedMessages
            ? { queuedMessages: base.queuedMessages }
            : {}),
          lastActivityAt: now,
        }
      );
    }
    if (
      (eventType === 'turn.failed' || eventType === 'error') &&
      !isCodexSubagentTerminalEvent(data, codexRootThreadId)
    ) {
      return {
        status: 'failed',
        queuedMessageIds: base.queuedMessageIds,
        ...(base.queuedMessages ? { queuedMessages: base.queuedMessages } : {}),
        lastActivityAt: now,
        error: {
          code: 'provider_error',
          message:
            typeof data.event.message === 'string'
              ? data.event.message
              : isRecord(data.event.error) &&
                  typeof data.event.error.message === 'string'
                ? data.event.error.message
                : 'Codex turn failed',
          retryable: true,
          occurredAt: new Date(now).toISOString(),
        },
      };
    }
    return {
      ...base,
      status: 'streaming',
      ...(activeTurn ? { activeTurn } : {}),
      lastActivityAt: now,
    };
  }
  if (isRootTerminalChatEventData(data, codexRootThreadId)) {
    // A plan handed to review ends its turn by an abort, which may leave no
    // visible output; the turn still did its work.
    const planHandoff = isPlanHandoffResult(data);
    const cancelled =
      !planHandoff &&
      (isUserAbortResult(data) ||
        (data.type === 'result' &&
          typeof data.result === 'string' &&
          /^(?:(?:turn )?cancel(?:l)?ed|interrupted by user|aborted by user|session aborted|session ended)$/i.test(
            data.result.trim(),
          )));
    const failed =
      !planHandoff &&
      !cancelled &&
      (data.type === 'error' ||
        (data.type === 'result' && data.is_error === true));
    if (!planHandoff && !cancelled && !failed) {
      const emptyCompletionRuntime = buildEmptyCompletionRuntime();
      if (emptyCompletionRuntime) return emptyCompletionRuntime;
    }
    return {
      status: cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
      queuedMessageIds: base.queuedMessageIds,
      ...(base.queuedMessages ? { queuedMessages: base.queuedMessages } : {}),
      lastActivityAt: now,
      ...(failed
        ? {
            error: {
              code: 'provider_error' as const,
              message:
                typeof data.error === 'string'
                  ? data.error
                  : data.type === 'result'
                    ? claudeResultErrorMessage(data)
                    : 'Provider turn failed',
              retryable: true,
              occurredAt: new Date(now).toISOString(),
            },
          }
        : {}),
    };
  }
  if (data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE) {
    // Every dispatch commits its prompt (`starting`) before the host records
    // acceptance, so a turn that is already completed, failed or cancelled
    // here ended while its prompt was being handed over: the provider failed
    // to start (an MCP proxy port held by another instance, a spawn or
    // authentication failure) or Stop won the race. Acceptance is host
    // bookkeeping, not provider activity, and must not reopen that turn as a
    // live one nothing will ever settle. An `interrupted` turn (restart
    // recovery) can still be redispatched under its original prompt.
    if (['completed', 'failed', 'cancelled'].includes(base.status)) {
      return { ...base, lastActivityAt: now };
    }
    return {
      ...base,
      status: 'streaming',
      ...(activeTurn ? { activeTurn } : {}),
      lastActivityAt: now,
    };
  }
  if (data.type === 'canopy_user_prompt') {
    const committedPromptQueueIds = new Set(
      (base.queuedMessages ?? [])
        .filter(
          (message) =>
            message.request.userMessageId === effectiveTurnUserMessageId,
        )
        .map(({ id }) => id),
    );
    const queuedMessageIds = base.queuedMessageIds.filter(
      (id) => !committedPromptQueueIds.has(id),
    );
    const queuedMessages = (base.queuedMessages ?? []).filter(
      (message) => message.request.userMessageId !== effectiveTurnUserMessageId,
    );
    const promptTurn =
      turnUserMessageId && base.activeTurn?.userMessageId !== turnUserMessageId
        ? { userMessageId: turnUserMessageId, startedAt: now }
        : activeTurn;
    const sessionId =
      typeof data.session_id === 'string'
        ? data.session_id
        : promptTurn?.sessionId;
    return {
      status: 'starting',
      queuedMessageIds,
      ...(base.queuedMessages ? { queuedMessages } : {}),
      ...(base.steeringCapabilities
        ? { steeringCapabilities: base.steeringCapabilities }
        : {}),
      ...(promptTurn
        ? {
            activeTurn: {
              ...promptTurn,
              ...(sessionId ? { sessionId } : {}),
            },
          }
        : {}),
      lastActivityAt: now,
    };
  }
  if (
    canFollowSettledProviderTurn(
      data,
      turnUserMessageId,
      base.activeTurn?.userMessageId,
      codexRootThreadId,
    ) ||
    (['completed', 'failed', 'cancelled', 'interrupted'].includes(
      base.status,
    ) &&
      !settledTurnRevival)
  ) {
    return { ...base, lastActivityAt: now };
  }
  const sessionId =
    typeof data.session_id === 'string'
      ? data.session_id
      : activeTurn?.sessionId;
  const {
    error: _settledError,
    emptyCompletionRecovery: _emptyCompletionRecovery,
    ...activeBase
  } = base;
  void _settledError;
  void _emptyCompletionRecovery;
  return {
    ...activeBase,
    status: 'streaming',
    ...(activeTurn
      ? { activeTurn: { ...activeTurn, ...(sessionId ? { sessionId } : {}) } }
      : {}),
    lastActivityAt: now,
  };
}

function hasVisibleTurnOutput(
  messages: PersistedChatMessage[],
  turnUserMessageId: string,
  turnDiff: NonNullable<PersistedChatTab['turnDiffs']>[string] | undefined,
): boolean {
  const userIndex = messages.findIndex(
    (message) => message.id === turnUserMessageId && message.role === 'user',
  );
  if (userIndex < 0) return true;
  if (turnDiff && turnDiff.files.length > 0) return true;

  return messages.slice(userIndex + 1).some((message) => {
    if (message.role !== 'user' && (message.attachmentPaths?.length ?? 0) > 0) {
      return true;
    }
    return message.blocks.some((block) => {
      switch (block.type) {
        case 'text':
        case 'thinking':
          return message.role !== 'user' && block.text.trim().length > 0;
        case 'tool_result':
        case 'codex_agent_call':
          return true;
        case 'file_references':
          return message.role !== 'user' && block.references.length > 0;
        case 'image':
          return (
            message.role !== 'user' &&
            (block.path.length > 0 || Boolean(block.dataUrl))
          );
        default:
          return false;
      }
    });
  });
}

function applyTrustedEventMetadata(
  tab: PersistedChatTab,
  data: Record<string, unknown>,
  now: number,
): PersistedChatTab {
  if (data.canopy_fork_model_context === 'fresh' && tab.forkedFrom) {
    return {
      ...tab,
      forkedFrom: { ...tab.forkedFrom, modelContext: 'fresh' },
    };
  }
  if (
    data.type === 'org_memory_used' &&
    data.localChatId === tab.id &&
    typeof data.localMessageId === 'string' &&
    tab.messages.some(
      (message) =>
        message.id === data.localMessageId && message.role === 'user',
    )
  ) {
    const memory = normalizeOrgMemoryTurn(data);
    if (memory) {
      return {
        ...tab,
        memoryByMessageId: {
          ...tab.memoryByMessageId,
          [data.localMessageId]: memory,
        },
      };
    }
  }
  if (data.type === 'claude_terminal_transcript_sync') {
    tab = settleTerminalAgentImports(
      tab,
      Array.isArray(data.messages)
        ? data.messages.filter(isPersistedChatMessage)
        : [],
      now,
    );
    const settingsSync = isRecord(data.settingsSync) ? data.settingsSync : {};
    const model =
      typeof settingsSync.model === 'string' && settingsSync.model.length > 0
        ? settingsSync.model
        : undefined;
    const turnDiffs = readTerminalTurnDiffs(data.turnDiffs);
    return {
      ...tab,
      ...(model ? { model, providerType: 'claude' as const } : {}),
      ...(typeof settingsSync.planMode === 'boolean'
        ? { planMode: settingsSync.planMode }
        : {}),
      ...(turnDiffs ? { turnDiffs: { ...tab.turnDiffs, ...turnDiffs } } : {}),
    };
  }
  if (
    data.type === 'turn_diff' &&
    typeof data.userMessageId === 'string' &&
    Array.isArray(data.files) &&
    data.files.every(isChangedFileInfo) &&
    typeof data.totalInsertions === 'number' &&
    typeof data.totalDeletions === 'number' &&
    typeof data.capturedAt === 'number'
  ) {
    return {
      ...tab,
      turnDiffs: {
        ...tab.turnDiffs,
        [data.userMessageId]: {
          files: data.files,
          totalInsertions: data.totalInsertions,
          totalDeletions: data.totalDeletions,
          capturedAt: data.capturedAt,
          ...(Array.isArray(data.treeRefs) &&
          data.treeRefs.every(isTurnDiffTreeRef)
            ? { treeRefs: data.treeRefs }
            : {}),
        },
      },
    };
  }
  if (isSetAutoArchiveRequestedEventData(data)) {
    return {
      ...tab,
      autoArchive: data.enabled ? true : undefined,
    };
  }
  if (data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE) {
    const acceptedId =
      typeof data.canopy_turn_user_message_id === 'string'
        ? data.canopy_turn_user_message_id
        : undefined;
    const acceptedTab: PersistedChatTab = {
      ...tab,
      ...(acceptedId ? { lastAcceptedUserMessageId: acceptedId } : {}),
    };
    if (isInputLedger(tab.inputDelivery)) {
      acceptedTab.inputDelivery = {
        ...tab.inputDelivery,
        rows: tab.inputDelivery.rows.map((row) =>
          row.id === data.canopy_turn_user_message_id &&
          // A queued row's turn consumed the queue's only copy of the input.
          (row.payload.agentSenderProvenance || row.state === 'queued')
            ? { ...row, state: 'picked-up', revision: row.revision + 1 }
            : row,
        ),
      };
    }
    if (acceptedId && tab.unacceptedTurnEnds?.[acceptedId]) {
      const ends = { ...tab.unacceptedTurnEnds };
      delete ends[acceptedId];
      if (Object.keys(ends).length > 0) acceptedTab.unacceptedTurnEnds = ends;
      else delete acceptedTab.unacceptedTurnEnds;
    }
    delete acceptedTab.llmProviderUsageLimitBanner;
    delete acceptedTab.dismissedLlmProviderUsageLimitBannerKey;
    delete acceptedTab.claudeUsageLimitBanner;
    delete acceptedTab.dismissedClaudeUsageLimitBannerKey;
    const consumedIds = new Set(
      Array.isArray(data.canopy_consumed_pending_system_instruction_ids)
        ? data.canopy_consumed_pending_system_instruction_ids.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
    );
    if (consumedIds.size === 0 || !tab.pendingSystemInstructions?.length) {
      return acceptedTab;
    }
    const pendingSystemInstructions = tab.pendingSystemInstructions.filter(
      (instruction) => !consumedIds.has(instruction.id),
    );
    return {
      ...acceptedTab,
      pendingSystemInstructions:
        pendingSystemInstructions.length > 0
          ? pendingSystemInstructions
          : undefined,
    };
  }
  return tab;
}

const NON_METADATA_TAB_KEYS = new Set([
  'id',
  'messages',
  'createdAt',
  'kind',
  'filePath',
]);

/**
 * Build the smallest canonical mutation for provider-owned tab metadata.
 * Provider reduction intentionally carries the existing transcript alongside
 * metadata, but journaling that whole tab turns every usage/session update
 * into an O(transcript) record. Missing optional fields are encoded as null so
 * replay removes them rather than retaining stale metadata.
 */
function buildTabMetadataPatch(
  current: PersistedChatTab,
  next: PersistedChatTab,
): ChatTabMetadataPatch {
  const patch: ChatTabMetadataPatch = {};
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const key of Array.from(keys)) {
    if (!isSafeChatTabMetadataKey(key) || NON_METADATA_TAB_KEYS.has(key)) {
      continue;
    }
    const currentValue: unknown = Reflect.get(current, key);
    const nextValue: unknown = Reflect.get(next, key);
    if (isDeepStrictEqual(currentValue, nextValue)) continue;
    defineChatTabMetadataProperty(
      patch,
      key,
      nextValue === undefined ? null : nextValue,
    );
  }
  return patch;
}

function canFollowSettledProviderTurn(
  data: Record<string, unknown>,
  turnUserMessageId?: string,
  activeTurnUserMessageId?: string,
  codexRootThreadId?: string,
  followsRevivalInit = true,
): boolean {
  return (
    data.type === 'canopy_delegation' ||
    data.type === CHILD_TOOLS_ENDED_EVENT_TYPE ||
    data.type === 'turn_diff' ||
    data.type === 'claude_terminal_transcript_sync' ||
    data.type === 'org_memory_used' ||
    data.type === 'canopy_org_memory_used' ||
    isClaudeChildFrame(data) ||
    isCodexSubagentFollowupEvent(data, codexRootThreadId) ||
    (followsRevivalInit &&
      data.type === 'system' &&
      data.subtype === 'init' &&
      data.canopy_turn_revival === true &&
      (typeof data.canopy_turn_user_message_id !== 'string' ||
        (data.canopy_turn_user_message_id === turnUserMessageId &&
          (activeTurnUserMessageId === undefined ||
            data.canopy_turn_user_message_id === activeTurnUserMessageId)))) ||
    isSetAutoArchiveRequestedEventData(data)
  );
}

/** An archive incarnation and cutoff (contracts §5), never a start permit. */
function archiveTurnFence(
  tab: PersistedChatTab,
  turn: PersistedChatTurnState | undefined,
  archivedAtMs: number,
): ArchivedTurnFence {
  const closedTurnId = turn?.current?.id ?? turn?.lastEnded?.id;
  return {
    version: 1,
    archiveEpoch: randomUUID(),
    archivedAtMs,
    ...(closedTurnId ? { closedTurnId } : {}),
    ...(tab.sdkSessionId ? { providerSessionId: tab.sdkSessionId } : {}),
  };
}

/**
 * A fresh start for this auto-archive incarnation: not the turn it closed,
 * not a recovered restart, and started after its cutoff. A legacy or unknown
 * fence authorizes no automatic restoration.
 */
function isFreshArchivedStart(
  entry: ArchivedChatEntry | undefined,
  turn: Pick<PersistedChatTurnState, 'current'> | undefined,
): boolean {
  const fence = entry?.turnFence;
  const start = turn?.current;
  return (
    entry?.tab.autoArchive === true &&
    fence?.version === 1 &&
    start !== undefined &&
    start.id !== fence.closedTurnId &&
    start.origin !== 'restart' &&
    start.startedAtMs > fence.archivedAtMs
  );
}

function shouldResumeAutoArchivedChat(data: Record<string, unknown>): boolean {
  return (
    data.type === 'canopy_user_prompt' ||
    data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE ||
    isRootAgentContinuationEvent(data) ||
    (data.type === 'system' &&
      data.subtype === 'init' &&
      data.canopy_turn_revival === true)
  );
}

function isSettledProviderTurnRevival(
  data: Record<string, unknown>,
  turnUserMessageId?: string,
): boolean {
  if (isClaudeChildFrame(data)) return false;
  const eventTurnUserMessageId =
    typeof data.canopy_turn_user_message_id === 'string'
      ? data.canopy_turn_user_message_id
      : undefined;
  return (
    (data.canopy_turn_revival === true &&
      (eventTurnUserMessageId === undefined ||
        turnUserMessageId === undefined ||
        eventTurnUserMessageId === turnUserMessageId)) ||
    (eventTurnUserMessageId === undefined && isRootAgentContinuationEvent(data))
  );
}

function readTerminalTurnDiffs(value: unknown): PersistedChatTab['turnDiffs'] {
  if (!isRecord(value)) return undefined;
  const result: NonNullable<PersistedChatTab['turnDiffs']> = {};
  for (const [userMessageId, candidate] of Object.entries(value)) {
    if (
      !isRecord(candidate) ||
      !Array.isArray(candidate.files) ||
      !candidate.files.every(isChangedFileInfo) ||
      typeof candidate.totalInsertions !== 'number' ||
      typeof candidate.totalDeletions !== 'number' ||
      typeof candidate.capturedAt !== 'number'
    ) {
      continue;
    }
    result[userMessageId] = {
      files: candidate.files,
      totalInsertions: candidate.totalInsertions,
      totalDeletions: candidate.totalDeletions,
      capturedAt: candidate.capturedAt,
      ...(Array.isArray(candidate.treeRefs) &&
      candidate.treeRefs.every(isTurnDiffTreeRef)
        ? { treeRefs: candidate.treeRefs }
        : {}),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function countTurns(tab: PersistedChatTab): number {
  if (tab.transcript?.userMessageCount !== undefined)
    return tab.transcript.userMessageCount;
  return tab.messages.filter((message) => message.role === 'user').length;
}

/** The session-events record of a scope storage diagnostic. */
export function storageSessionDiagnostic(
  diagnostic: ChatStateStorageDiagnostic,
): SessionDiagnosticRecord {
  return {
    version: 1,
    timestamp: diagnostic.occurredAt,
    kind: 'chat_storage_diagnostic',
    sessionKey: `${diagnostic.projectId}/${diagnostic.worktreeId}/`,
    projectId: diagnostic.projectId,
    worktreeId: diagnostic.worktreeId,
    chatId: '',
    providerType: 'unknown',
    chatStorageKind: diagnostic.kind,
    chatStorageAuthority: diagnostic.storageAuthority,
    chatStorageJournalBytes: diagnostic.journalBytes,
    chatStorageRecordBytes: diagnostic.recordBytes,
    chatStorageRecordCount: diagnostic.recordCount,
    chatStorageMaxRecordBytes: diagnostic.maxRecordBytes,
    chatStorageMeanRecordBytes: diagnostic.meanRecordBytes,
    chatStorageCheckpointDurationMs: diagnostic.checkpointDurationMs,
    chatStorageCheckpointAbortCount: diagnostic.checkpointAbortCount,
    ...(diagnostic.journalTailReason
      ? { chatStorageJournalTailReason: diagnostic.journalTailReason }
      : {}),
    ...(diagnostic.maintenanceReason
      ? { chatStorageMaintenanceReason: diagnostic.maintenanceReason }
      : {}),
    ...(diagnostic.journalQuarantineFile
      ? { chatStorageJournalQuarantineFile: diagnostic.journalQuarantineFile }
      : {}),
    ...(diagnostic.revisionGap
      ? {
          chatStorageGapExpectedRevision:
            diagnostic.revisionGap.expectedRevision,
          chatStorageGapFoundRevision: diagnostic.revisionGap.foundRevision,
          chatStorageGapNewestRevision: diagnostic.revisionGap.newestRevision,
          chatStorageGapTabsRevision: diagnostic.revisionGap.tabsRevision,
          chatStorageGapArchiveRevision: diagnostic.revisionGap.archiveRevision,
          chatStorageGapStaleComponent: diagnostic.revisionGap.staleComponent,
          chatStorageGapSkippedMutationCount:
            diagnostic.revisionGap.skippedMutationCount,
        }
      : {}),
  };
}

function matchesPortalSendReceipt(
  receipt: PersistedCommandReceipt,
  identity: PortalChatSendIdentity,
): boolean {
  return (
    receipt.outcome === 'applied' &&
    receipt.entityId === identity.chatId &&
    receipt.messageId === identity.userMessageId &&
    receipt.portalSend?.chatId === identity.chatId &&
    receipt.portalSend.userMessageId === identity.userMessageId &&
    receipt.portalSend.fingerprint === identity.fingerprint
  );
}

class ChatSendAuthorizationRevokedError extends Error {
  public constructor(
    message = 'The paired session no longer authorizes this send.',
  ) {
    super(message);
  }
}

interface PendingChatTabsProjection {
  projectId: string;
  worktreeId: string;
  revision: number;
  data: ChatTabsFile;
  changedTabIds: Set<string>;
  removedTabIds: Set<string>;
  changedTabs: Map<string, PersistedChatTab>;
}

/**
 * The idle unload interval for a repository the service builds itself. Read
 * only then, so a caller that supplies its own repository outside a Vite
 * build (where the E2E constant is undefined) never evaluates the gate.
 */
function defaultIdleScopeUnloadOption(): { idleScopeUnloadMs?: number } {
  const e2eMs = isE2eBuild()
    ? Number(process.env.CANOPY_E2E_SCOPE_IDLE_UNLOAD_MS)
    : undefined;
  if (e2eMs !== undefined && Number.isSafeInteger(e2eMs) && e2eMs > 0)
    return { idleScopeUnloadMs: e2eMs };
  // Never arm idle unload under Jest: a suite that builds the service without
  // draining it would run the unload's live check after the environment is
  // torn down. Repository tests set the option.
  return process.env.NODE_ENV === 'test' ? { idleScopeUnloadMs: 0 } : {};
}

type QueueHydrationOptions = { ordinaryOnly?: true; creditRefused?: true };

function withQueuedRevision(
  options: [] | [QueueHydrationOptions],
  revision: number | undefined,
): [] | [QueueHydrationOptions & { revision?: number }] {
  return revision === undefined ? options : [{ ...options[0], revision }];
}

export class ChatStateService implements ChatStateCommandPort {
  public readonly inputDelivery: ChatInputDeliveryCoordinator;
  private readonly repository: ChatStateRepositoryPort;
  private readonly uninstallScopeResidencyHook: () => void;
  private readonly getChatCloseBlockReasonChecker: () => Promise<ChatCloseBlockReasonChecker>;
  private defaultChatCloseBlockReasonChecker:
    | Promise<ChatCloseBlockReasonChecker>
    | undefined;
  private readonly nativeClaimRollback = new WeakMap<
    ChatSendMessageRequest,
    { row: InputRow; revision: number }
  >();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly dispatch: (
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    beforeImmediateDispatch: (options: {
      cancelledBeforeDispatch: boolean;
      startsTurn: boolean;
    }) => Promise<void>,
  ) => Promise<void>;
  private readonly withPlanReviewRevision: NonNullable<
    ChatStateServiceOptions['withPlanReviewRevision']
  >;
  private readonly withPlanImplementationRevision: NonNullable<
    ChatStateServiceOptions['withPlanImplementationRevision']
  >;
  private readonly approvePlanReview: (
    request: PlanReviewApprovalRecordRequest,
  ) => Promise<boolean>;
  private readonly authorizeSend: (
    target: ChatScopeKey & {
      tab: PersistedChatTab;
      allowTrustedTerminal?: boolean;
    },
  ) => Promise<void>;
  private readonly awaitWorktreeSetup: (
    scope: ChatScopeKey,
  ) => Promise<WorktreeGitSetupOutcome> | undefined;
  private readonly notifyTurnTerminal: (
    event: ChatTurnTerminalNotice,
  ) => Promise<void>;
  private readonly worktreeSetupQueue: ChatWorktreeSetupQueue;
  private readonly resolveSendModel: NonNullable<
    ChatStateServiceOptions['resolveSendModel']
  >;
  private readonly cleanupSession: (
    target: ChatScopeKey & { chatId: string },
  ) => Promise<void>;
  private readonly schedule: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly reconcileHostRuntime: boolean;
  private readonly scopeRuntimeRecoveries = new Map<string, Promise<void>>();
  /**
   * Chats whose initial naming is settled: ineligible and not `pending`
   * (closed, a saved custom title or description, a file or read-only tab,
   * or a legacy meaningful title). Settled chats never become eligible again,
   * so later sends skip the canonical read; a stale entry can only suppress
   * naming. Entries are id strings kept for the process lifetime, unpruned.
   */
  private readonly settledInitialTitleChats = new Set<string>();
  private readonly recordDiagnostic: (record: SessionDiagnosticRecord) => void;
  private readonly turnHandoff: ChatTurnStateHandoff;
  /** Canonical mode: per chat, the receipt turn whose root terminal event was reduced. */
  private readonly reducedRootTerminals = new Map<string, Set<string>>();
  private readonly retainedTerminalTurns = new Map<
    string,
    Map<string, ChatTurnRecord>
  >();
  private readonly turnHandoffNonce = randomUUID();
  private turnHandoffCommitSequence = 0;
  private readonly persistedBackgroundSnapshotRequests = new Set<string>();
  private readonly claudeToolNames: ReadonlySet<string>;
  private readonly codexToolNames: ReadonlySet<string>;
  private readonly cursorToolUse?: (
    target: VisualToolTarget,
    toolUseId: string,
  ) => boolean;
  private readonly unsubscribeStorageDiagnostics: () => void;
  private readonly listeners = new Set<
    (event: ChatStateChangedEvent) => void
  >();
  private readonly turnStateChangeListeners = new Set<
    (change: ChatTurnStateChange) => void
  >();
  private readonly turnStateCommittedListeners = new Set<
    (commit: ChatTurnStateCommit) => void
  >();
  private readonly pendingQuestionScopes = new Map<
    string,
    ChatScopeKey & { chatId: string }
  >();
  private readonly pendingChatTabsProjections = new Map<
    string,
    PendingChatTabsProjection
  >();
  private readonly latestProjectionCommitRevisionByScope = new Map<
    string,
    number
  >();
  private readonly projectionGenerationByScope = new Map<string, number>();
  private readonly scopesAwaitingProjectionReadmission = new Map<
    string,
    Set<string>
  >();
  private readonly runningChatTabsProjections = new Map<string, number>();
  private readonly activeChatTabsProjections = new Map<
    string,
    { generation: number; projection: PendingChatTabsProjection }
  >();
  private readonly chatTabsProjectionFailures = new Map<string, number>();

  public async getCommandReceipt(request: {
    projectId: string;
    worktreeId: string;
    commandId: string;
  }): Promise<PersistedCommandReceipt | null> {
    return (
      (await this.repository.getReceipt(request, request.commandId)) ?? null
    );
  }

  public async getPortalSendReceipt(request: {
    projectId: string;
    worktreeId: string;
    commandId: string;
    identity: PortalChatSendIdentity;
  }): Promise<PortalChatSendReceiptProbe> {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateId(request.commandId, 'commandId');
    validateId(request.identity.chatId, 'chatId');
    validateId(request.identity.userMessageId, 'userMessageId');
    if (!/^[a-f0-9]{64}$/.test(request.identity.fingerprint))
      return { outcome: 'conflict' };
    const receipt =
      (await this.repository.getReceipt(request, request.commandId)) ??
      (await this.repository.getPortalSendReceipt(
        request,
        request.identity.userMessageId,
      ));
    if (receipt) {
      return matchesPortalSendReceipt(receipt, request.identity)
        ? { outcome: 'matched', receipt }
        : { outcome: 'conflict' };
    }
    const state = await this.repository.getState(request, {
      chatIds: [request.identity.chatId],
    });
    const existingMessage = state.tabsFile.tabs
      .find((tab) => tab.id === request.identity.chatId)
      ?.messages.some(
        (message) => message.id === request.identity.userMessageId,
      );
    return { outcome: existingMessage ? 'conflict' : 'missing' };
  }
  /** Accepted sends not yet guaranteed visible in the queue/session hosts. */
  private readonly dispatchesInFlight = new Map<string, number>();
  /** Consecutive reconcile passes whose commit of a chat's turn state failed. */
  private readonly reconcileTurnCommitFailures = new Map<string, number>();
  private readonly acceptedSendsInFlight = new Map<
    string,
    Promise<ChatCommandResult>
  >();
  private readonly heldSends = new Map<string, HeldSend>();
  private readonly setupHolds = new Map<string, SetupHold>();
  /** Unaccepted turns whose end is not durable yet (`awaitingSetupKey`). */
  private readonly unrecordedTurnEnds = new Set<string>();
  private draining = false;
  /** Commands currently claiming a scope/commandId idempotency key. */
  private readonly commandsInFlight = new Map<
    string,
    Promise<ChatCommandResult>
  >();
  /**
   * Ref-counted deletion boundaries. Worktree cleanup owns the outer boundary
   * while deleteScope owns the nested chat-state boundary.
   */
  private readonly deletingScopeIds = new Map<string, number>();
  /** Admitted sends that deletion must include in its session cleanup sweep. */
  private readonly activeScopeOperations = new Map<string, number>();
  /** Host-owned window interests that keep a scope's in-memory state live. */
  private scopePinProvider: ((scope: ChatScopeKey) => boolean) | undefined;
  /** Deletion waiters released when the last admitted send leaves a scope. */
  private readonly scopeOperationDrainWaiters = new Map<
    string,
    Set<() => void>
  >();
  /** Active leases inherited by awaited descendants of an admitted operation. */
  private readonly scopeActivityLeases = new AsyncLocalStorage<
    readonly ScopeActivityLease[]
  >();
  /** Immutable archive scopes retain bounded ownership and artifact caches. */
  private readonly archiveBackends = new Map<
    string,
    Promise<ArchiveChatBackend>
  >();

  private childStreamRepository(): ChatStateV2Repository {
    if (!(this.repository instanceof ChatStateV2Repository))
      throw new Error(
        'Child transcript streams require the V2 chat repository',
      );
    return this.repository;
  }

  public constructor(options: ChatStateServiceOptions = {}) {
    if (options.chatCloseBlockReason) {
      const injectedChatCloseBlockReason = options.chatCloseBlockReason;
      this.getChatCloseBlockReasonChecker =
        (): Promise<ChatCloseBlockReasonChecker> =>
          Promise.resolve(injectedChatCloseBlockReason);
    } else {
      this.getChatCloseBlockReasonChecker =
        (): Promise<ChatCloseBlockReasonChecker> => {
          // `background-work` imports session-manager, whose provider runtime
          // graph reaches this service. Keep that graph lazy and resolve it
          // before entering the synchronous repository transaction callback.
          this.defaultChatCloseBlockReasonChecker ??=
            import('../agents/background-work').then(
              ({ chatCloseBlockReason }): ChatCloseBlockReasonChecker =>
                chatCloseBlockReason,
            );
          return this.defaultChatCloseBlockReasonChecker;
        };
    }
    this.claudeToolNames =
      options.claudeToolNames ?? EMPTY_SHOW_VISUAL_TOOL_NAMES;
    this.codexToolNames =
      options.codexToolNames ?? EMPTY_SHOW_VISUAL_TOOL_NAMES;
    this.cursorToolUse = options.cursorToolUse;
    this.recordDiagnostic =
      options.recordDiagnostic ??
      ((record): void => {
        // Lazy by design: the observability service pulls in the codex runtime
        // graph, which reaches back into the chat state port; a static import
        // here would reintroduce an initialization cycle.
        void import('../observability/ingest')
          .then(({ getExecutionObservabilityIngest }) => {
            getExecutionObservabilityIngest().recordSessionDiagnostic(record);
          })
          .catch(() => {
            // A diagnostic that cannot be recorded must never change the
            // outcome of the command that produced it.
          });
      });
    this.repository =
      options.repository ??
      new ChatStateV2Repository({
        // Normal builds handle format 4 scopes and promote only while the
        // promotion flag is on; a promoted scope stays format 4 when it goes
        // off. E2E builds keep CANOPY_E2E_CHAT_FORMAT4 as their opt-in.
        enableFormat4:
          !isE2eBuild() || process.env.CANOPY_E2E_CHAT_FORMAT4 === '1',
        ...(isE2eBuild()
          ? {}
          : {
              format4Promotion: (): boolean => isChatFormat4PromotionEnabled(),
            }),
        // v1.18.0, the rollback floor, reads stream metadata a checkpoint
        // left unchanged, so format 4 scopes restage only changed streams.
        deltaJournalIncrementalStreamMetadata:
          !isE2eBuild() || process.env.CANOPY_E2E_CHAT_FORMAT4 === '1',
        delegationReadMetadata: readMetadataOfRecord,
        format4Telemetry: recordChatFormat4Outcome,
        hasLiveDependency: async (scope): Promise<boolean> => {
          // Lazy by design: these local services import the chat-state singleton,
          // so static imports here would reintroduce an initialization cycle.
          const [{ getActiveChatIds }, { getChatQueueService }] =
            await Promise.all([
              import('../agents/session-manager'),
              import('./chat-queue-service'),
            ]);
          return (
            getActiveChatIds(scope.projectId, scope.worktreeId).length > 0 ||
            getChatQueueService().getWorktreeSnapshots(
              scope.projectId,
              scope.worktreeId,
            ).length > 0
          );
        },
        ...defaultIdleScopeUnloadOption(),
        // Separate from hasLiveDependency, which also guards v1 migration:
        // an operation's own admission must not block its first load.
        hasAdmittedOperation: (scope): boolean =>
          this.activeScopeOperations.has(chatScopeLifecycleKey(scope)),
        isScopePinned: (scope): boolean => {
          try {
            return this.scopePinProvider?.(scope) ?? false;
          } catch {
            return true;
          }
        },
      });
    this.unsubscribeStorageDiagnostics =
      this.repository.subscribeStorageDiagnostics((diagnostic) => {
        this.recordDiagnostic(storageSessionDiagnostic(diagnostic));
      });
    // Only for the repository built here, as for the idle unload option.
    this.uninstallScopeResidencyHook =
      options.repository === undefined &&
      this.repository instanceof ChatStateV2Repository
        ? installChatScopeResidencyE2eHook(this.repository)
        : (): void => undefined;
    this.reconcileHostRuntime = options.repository === undefined;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    const directDispatch = options.dispatch;
    this.dispatch =
      options.submit ??
      (directDispatch
        ? async (request, origin, beforeImmediateDispatch): Promise<void> => {
            await beforeImmediateDispatch({
              cancelledBeforeDispatch: false,
              startsTurn: true,
            });
            await directDispatch(request, origin);
          }
        : async (request, origin, beforeImmediateDispatch): Promise<void> => {
            // Lazy to preserve the chat-state/queue startup boundary.
            const { getChatQueueService } =
              await import('./chat-queue-service');
            await getChatQueueService().submit(
              request,
              origin,
              beforeImmediateDispatch,
            );
          });
    this.awaitWorktreeSetup =
      options.awaitWorktreeSetup ??
      ((target): Promise<WorktreeGitSetupOutcome> | undefined =>
        claimWorktreeGitSetup(target.projectId, target.worktreeId));
    this.notifyTurnTerminal =
      options.notifyTurnTerminal ??
      (async (event): Promise<void> => {
        const [{ getAppAdvisorWatcherService }, { isCoworkWorkspace }] =
          await Promise.all([
            import('../app-advisor/watchers'),
            import('../lib/workspace-registry'),
          ]);
        await getAppAdvisorWatcherService().handleChatTerminalEvent({
          scope: isCoworkWorkspace(event.projectId) ? 'standalone' : 'worktree',
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId: event.chatId,
          data: event.data,
          status: event.outcome === 'failed' ? 'failure' : 'cancelled',
          receivedAt: new Date(this.now()).toISOString(),
        });
      });
    this.worktreeSetupQueue = options.worktreeSetupQueue ?? {
      hold: async (target, turnUserMessageId): Promise<void> => {
        const { getChatQueueService } = await import('./chat-queue-service');
        getChatQueueService().holdForWorktreeSetup(target, turnUserMessageId);
      },
      release: async (target, releaseOptions): Promise<void> => {
        const { getChatQueueService } = await import('./chat-queue-service');
        getChatQueueService().releaseWorktreeSetupHold(target, releaseOptions);
      },
      takeHeld: async (
        target,
        outcome,
      ): Promise<readonly ChatSendMessageRequest[]> => {
        const { getChatQueueService } = await import('./chat-queue-service');
        return getChatQueueService().takeWorktreeSetupHeldSends(
          target,
          outcome,
        );
      },
    };
    this.resolveSendModel =
      options.resolveSendModel ??
      (async (target, stored, requested): Promise<string | undefined> => {
        // Lazy by design: the default-model resolver reaches services that
        // import the chat-state singleton.
        const { resolveSendModelPin } =
          await import('../agents/agent-default-model');
        return resolveSendModelPin(target.projectId, stored, requested, target);
      });
    this.withPlanReviewRevision =
      options.withPlanReviewRevision ??
      (async <T>(
        request: PlanReviewApprovalRecordRequest,
        commit: () => Promise<T>,
      ): Promise<{ accepted: false } | { accepted: true; result: T }> => {
        const { withTrackedPlanRevision } =
          await import('../lib/plan-persistence');
        return withTrackedPlanRevision(
          { ...request, source: 'opencode', reviewStatus: 'approved' },
          commit,
        );
      });
    this.withPlanImplementationRevision =
      options.withPlanImplementationRevision ??
      (async <T>(
        request: PlanReviewApprovalRecordRequest,
        commit: (
          source: NonNullable<PersistedChatTab['trackedPlanSource']>,
        ) => Promise<T>,
      ): Promise<{ accepted: false } | { accepted: true; result: T }> => {
        const { withTrackedPlanRevision } =
          await import('../lib/plan-persistence');
        return withTrackedPlanRevision(
          { ...request, reviewStatus: 'approved' },
          (plan): Promise<T> => commit(plan.source),
        );
      });
    this.approvePlanReview =
      options.approvePlanReview ??
      (async (request): Promise<boolean> => {
        const { approveOpenCodePlanReview } = await import('./plans-service');
        return approveOpenCodePlanReview(request);
      });
    this.authorizeSend =
      options.authorizeSend ??
      (async (target): Promise<void> => {
        // Lazy by design: chat-service owns the singleton chat-state port and
        // statically importing it here would create an initialization cycle.
        const { assertWorktreeChatSendNotSplitLocked } =
          await import('./chat-service');
        assertWorktreeChatSendNotSplitLocked(
          target.projectId,
          target.worktreeId,
        );
        if (
          target.allowTrustedTerminal !== true &&
          (await resolveTerminalDrivenChat(target))
        ) {
          throw new Error(
            'Terminal-backed chats cannot be driven from the revisioned renderer.',
          );
        }
      });
    this.cleanupSession =
      options.cleanupSession ??
      (async (target): Promise<void> => {
        // Lazy by design: session-manager owns provider sessions that call back
        // into this service; defer both sides until cleanup is actually needed.
        const [{ cancelChatTurn }, { destroySession }] = await Promise.all([
          import('../lib/chat-turn-cancel'),
          import('../agents/session-manager'),
        ]);
        try {
          await cancelChatTurn(target);
        } finally {
          await destroySession(
            target.projectId,
            target.worktreeId,
            target.chatId,
          );
        }
      });
    this.turnHandoff = new ChatTurnStateHandoff({
      load: async (target): Promise<unknown> =>
        (
          await this.repository.getState(
            {
              projectId: target.projectId,
              worktreeId: target.worktreeId,
            },
            // Runtime comes from the index; selecting no chat reads no transcript.
            { chatIds: [] },
          )
        ).runtimeByChatId[target.chatId]?.turn,
      commit: async (
        snapshot: ChatTurnStateHandoffSnapshot,
      ): Promise<{
        applied: boolean;
        written?: ChatTurnStateHandoffSnapshot;
        timerMessages?: readonly PersistedChatMessage[];
        autoRoutedModels?: Readonly<Record<string, string>>;
      }> => {
        if (!this.turnHandoff.isCurrent(snapshot)) return { applied: false };
        let written: ChatTurnStateHandoffSnapshot | undefined;
        let timerMessages: PersistedChatMessage[] = [];
        let autoRoutedModels: Readonly<Record<string, string>> | undefined;
        this.turnHandoffCommitSequence += 1;
        const commit = await this.repository.transactWith(
          {
            projectId: snapshot.scope.projectId,
            worktreeId: snapshot.scope.worktreeId,
          },
          (current) => {
            if (!this.turnHandoff.isCurrent(snapshot)) return [];
            const exists = current.tabsFile.tabs.some(
              (tab) => tab.id === snapshot.scope.chatId,
            );
            if (!exists) {
              // A fresh start on an auto-archived chat stays staged: its
              // content restores the chat and commits this turn with it.
              const archived = current.archivesFile.archived.find(
                (entry) => entry.tab.id === snapshot.scope.chatId,
              );
              if (!isFreshArchivedStart(archived, snapshot.turn))
                this.turnHandoff.invalidate(snapshot.scope);
              return [];
            }
            // A transaction queued ahead may already have made newer state
            // durable; write only what is still unacknowledged at this point.
            written = this.turnHandoff.snapshotNow(snapshot.scope);
            if (!written) return [];
            const mutations: ChatCoreMutation[] = [];
            if (
              this.attachTurnSnapshot(
                mutations,
                current,
                snapshot.scope.chatId,
                written,
                'skip',
              )
            ) {
              timerMessages = snapshotTimerRows(mutations, written);
              autoRoutedModels = tabAutoRoutedModels(
                current,
                snapshot.scope.chatId,
              );
            } else {
              // These timer effects cannot apply at all (for example, a chat
              // that is gone): commit the turn without its rows rather than
              // retrying the same snapshot forever.
              const ownership = getChatTurnOwnership().getSnapshot(
                snapshot.scope,
              );
              const turn = written.turn;
              mutations.length = 0;
              withTurnSnapshot(
                mutations,
                current,
                snapshot.scope.chatId,
                written,
                (runtime) => projectTurnRuntime(runtime, turn, ownership),
              );
            }
            return mutations;
          },
          {
            source: 'automation',
            // A timer row being closed can lie outside the active window of
            // a long transcript; outside it, the row would look absent.
            fullTranscript: true,
            // A recreated entry restarts its generations, so ids carry this
            // service instance and a commit sequence instead.
            mutationId: `turn-state-handoff:${snapshot.scope.chatId}:${this.turnHandoffNonce}:${this.turnHandoffCommitSequence}`,
            chatIds: [snapshot.scope.chatId],
          },
        );
        return {
          applied: commit.applied,
          ...(written ? { written } : {}),
          timerMessages,
          ...(autoRoutedModels ? { autoRoutedModels } : {}),
        };
      },
      now: this.now,
      onChange: (change): void => this.publishTurnStateChange(change),
      onCommitted: (commit): void => this.publishTurnStateCommitted(commit),
      onError: (error): void =>
        logMainProcessWarn('[chat-state] Turn-state handoff failed:', error),
    });
    this.inputDelivery = new ChatInputDeliveryCoordinator(
      {
        // Late-bound so repository spies installed after construction still apply.
        getRevision: (
          ...args: Parameters<ChatStateRepositoryPort['getRevision']>
        ): ReturnType<ChatStateRepositoryPort['getRevision']> =>
          this.repository.getRevision(...args),
        getState: (
          ...args: Parameters<ChatStateRepositoryPort['getState']>
        ): ReturnType<ChatStateRepositoryPort['getState']> =>
          this.repository.getState(...args),
        transactWith: (
          ...args: Parameters<ChatStateRepositoryPort['transactWith']>
        ): Promise<ChatStateCommit> => this.transactWithTurnHandoff(...args),
      },
      options.inputSession ??
        (async (target): Promise<AgentSession | undefined> => {
          // Lazy by design: session-manager imports this chat-state singleton;
          // defer the reverse edge to break that initialization cycle. The
          // packaged Electron main build exercises this local import path.
          const { getSession } = await import('../agents/session-manager');
          return getSession(target.projectId, target.worktreeId, target.chatId);
        }),
      this.authorizeSend,
      options.onInputPickup ??
        (async (target, row, event): Promise<void> => {
          const attempt = row.attempts.find(
            (candidate) => candidate.id === event.attemptId,
          );
          const payload = attempt?.payloadSnapshot ?? row.payload;
          try {
            // Observability composes chat-state during main-process startup;
            // defer the reverse edge to avoid that initialization cycle. The
            // packaged Electron main build exercises this local import path.
            const { getExecutionObservabilityIngest } =
              await import('../observability/ingest');
            getExecutionObservabilityIngest().observeSteeringInput({
              ...target,
              provider: event.provider,
              userMessageId: row.id,
              originalUserText: attempt?.displayText ?? row.text,
              submittedText: attempt?.submittedText ?? row.text,
              fileReferences: payload.fileReferences,
              planMode: payload.planMode ?? false,
              initiationSource: payload.initiationSource ?? 'user',
              ...(payload.internalRow !== undefined
                ? { internalRow: payload.internalRow }
                : {}),
              ...(payload.managedDelegationDeliveryId !== undefined
                ? {
                    managedDelegationDeliveryId:
                      payload.managedDelegationDeliveryId,
                  }
                : {}),
              startsTurn:
                event.startsTurn === true && event.turnRootAccepted !== false,
            });
          } catch (error) {
            // An audit sink failure must not drop the already committed provider event.
            logMainProcessWarn('Failed to record steering pickup audit', error);
          }
        }),
      async (target): Promise<string | undefined> => {
        try {
          const state = await this.repository.getState(target, {
            chatIds: [target.chatId],
            pageOnly: true,
          });
          const tab =
            state.tabsFile.tabs.find(
              (candidate) => candidate.id === target.chatId,
            ) ??
            state.archivesFile.archived.find(
              (entry) => entry.tab.id === target.chatId,
            )?.tab;
          if (!tab || tab.kind === 'file') return undefined;
          const { resolveWorktreeCwd } =
            await import('../lib/resolve-worktree');
          return resolveWorktreeCwd(
            target.projectId,
            target.worktreeId,
            tab.selectedRepoId,
          );
        } catch {
          // History recovery is best effort. A missing chat or unresolvable
          // worktree must not make ordinary chat-state reads fail.
          return undefined;
        }
      },
      checkWatcherDeliveryIngress,
    );
    this.schedule = options.schedule ?? setTimeout;
    this.repository.setCommitListener(
      (commit, wait): Promise<void> => this.publishCommit(commit, wait),
      (commit): ChatWaitOperation => this.startCommitWait(commit),
    );
  }

  public setScopePinProvider(
    provider: (scope: ChatScopeKey) => boolean,
  ): () => void {
    this.scopePinProvider = provider;
    return (): void => {
      if (this.scopePinProvider === provider) this.scopePinProvider = undefined;
    };
  }

  /** Whether canonical turn state already ended this turn id, receipt first. */
  public hasEndedTurn(scope: ChatTurnStateScope, turnId: string): boolean {
    const state =
      this.turnHandoff.getState(scope) ??
      getChatTurnOwnership().getSnapshot(scope).committed?.state;
    return state?.endedTurnIds.includes(turnId) === true;
  }

  public observeTurnLifecycle(event: ChatTurnLifecycleEvent): void {
    try {
      this.turnHandoff.observeLifecycle(event);
    } catch {
      // Reducer, timer and diagnostic failures cannot escape into a producer.
    }
  }

  /**
   * The scope's durable turn state, for ownership hydration. A failed or
   * unrecoverable read rejects, so it can never certify a chat idle.
   */
  public async loadCommittedTurnState(
    scope: ChatTurnStateScope,
  ): Promise<PersistedChatTurnState> {
    const target = { projectId: scope.projectId, worktreeId: scope.worktreeId };
    // Runtime comes from the index; selecting no chat reads no transcript.
    const state = await this.repository.getState(target, { chatIds: [] });
    const recoveryError = this.repository
      .getDiagnostics(target)
      .find(
        (diagnostic) =>
          diagnostic.kind === 'unrecoverable_snapshot' ||
          diagnostic.kind === 'unrecoverable_journal',
      );
    if (recoveryError) throw new Error(recoveryError.message);
    return (
      state.runtimeByChatId[scope.chatId]?.turn ??
      serializeChatTurnState(initialChatTurnState())
    );
  }

  /**
   * Carry a handoff snapshot on a transaction. In canonical mode, also apply
   * its ordered timer effects and project root runtime from canonical state.
   * Returns false when the effects cannot be placed in this view (a turn
   * anchor outside the selected window, say); the snapshot then stays
   * unacknowledged and the fallback commit places it over the full transcript.
   */
  private attachTurnSnapshot(
    mutations: ChatCoreMutation[],
    current: CanonicalChatState,
    chatId: string,
    snapshot: ChatTurnStateHandoffSnapshot,
    /** `skip` (fallback commit): drop only a turn whose timer cannot apply. */
    placement: 'defer' | 'skip' = 'defer',
  ): boolean {
    try {
      const skipped = applyTurnEffects(current, mutations, snapshot, {
        skipUnplaceable: placement === 'skip',
      });
      if (skipped.length > 0)
        logMainProcessWarn(
          '[chat-state] Canonical timers could not be placed:',
          skipped,
        );
    } catch {
      return false;
    }
    const refusal = current.tabsFile.tabs.find(
      ({ id }) => id === chatId,
    )?.aiCreditsNoBillingSource;
    const previousTurn = current.runtimeByChatId[chatId]?.turn;
    if (
      refusal &&
      !mutations.some(
        (mutation) =>
          mutation.type === 'tab.metadata_patched' &&
          mutation.tabId === chatId &&
          mutation.patch.aiCreditsNoBillingSource !== undefined,
      ) &&
      snapshot.turnRecords?.some(
        (turn) =>
          turn.origin === 'user' &&
          turn.userMessageId !== undefined &&
          turn.startedAtMs > refusal.detectedAt &&
          !previousTurn?.endedTurnIds.includes(turn.id) &&
          (previousTurn?.current?.id !== turn.id ||
            previousTurn.current.userMessageId !== turn.userMessageId) &&
          snapshot.lifecycle?.some(
            (owner) =>
              owner.turnId === turn.id &&
              owner.transition !== 'end' &&
              owner.inputIds[0] === turn.userMessageId,
          ),
      )
    )
      mutations.push({
        type: 'tab.metadata_patched',
        tabId: chatId,
        patch: { aiCreditsNoBillingSource: null },
      });
    recordSnapshotTurnEnds(mutations, current, chatId, snapshot, this.now());
    settleAutoArchiveOwner(mutations, current, chatId, snapshot);
    const ownership = getChatTurnOwnership().getSnapshot(snapshot.scope);
    withTurnSnapshot(mutations, current, chatId, snapshot, (runtime) =>
      projectTurnRuntime(runtime, snapshot.turn, ownership),
    );
    return true;
  }

  /**
   * Canonical mode: an event can report its own failure, but only canonical
   * state starts, runs or revives a root turn. While a canonical turn runs,
   * status and the active turn come from receipt-time state. The durable
   * `turn` stays as committed; only a handoff snapshot advances it.
   */
  private projectReceiptRuntime(
    scope: ChatTurnStateScope,
    runtime: ChatRuntimeState,
    /** Host writers: project only while a canonical turn runs. */
    onlyRunning = false,
  ): ChatRuntimeState {
    // Receipt state can still be loading, and an end receipt precedes its
    // durable settle: a running committed turn stays authoritative until the
    // snapshot that settles it commits, together with its timer close.
    const receipt = this.turnHandoff.getState(scope);
    const turn = receipt?.current
      ? receipt
      : runtime.turn?.current
        ? runtime.turn
        : (receipt ??
          runtime.turn ??
          serializeChatTurnState(initialChatTurnState()));
    const live =
      runtime.status === 'starting' ||
      runtime.status === 'streaming' ||
      runtime.status === 'awaiting_input' ||
      runtime.status === 'completing';
    if (!turn.current && (onlyRunning || !live)) return runtime;
    const { turn: _projectedTurn, ...projected } = projectTurnRuntime(
      runtime,
      turn,
      getChatTurnOwnership().getSnapshot(scope),
    );
    void _projectedTurn;
    return runtime.turn === undefined
      ? projected
      : { ...projected, turn: runtime.turn };
  }

  /**
   * Canonical status follows lifecycle receipts, which precede delivery of a
   * turn's own output: a committed settled status is not yet a settled
   * provider stream. Output is admitted (content only) while a receipt turn
   * runs, and for the turn that just ended on its own until its root terminal
   * event is reduced; a stopped turn's output, and later frames, are not.
   */
  private deliversReceiptTurnOutput(
    scope: ChatTurnStateScope,
    runtime: ChatRuntimeState,
    tab?: PersistedChatTab,
  ): boolean {
    const turn = this.turnHandoff.getState(scope) ?? runtime.turn;
    if (turn?.current) return true;
    return this.trailingEndedTurn(scope, turn, tab) !== undefined;
  }

  /**
   * The turn that just ended on its own, while its root terminal is still
   * unreduced. Receipt runs ahead of admission, so its last frames can arrive
   * after the next turn's start commits; they are still that turn's output.
   */
  private trailingEndedTurn(
    scope: ChatTurnStateScope,
    turn: PersistedChatTurnState | undefined,
    tab?: PersistedChatTab,
  ): PersistedChatTurnState['lastEnded'] {
    const ended = turn?.lastEnded;
    return ended !== undefined &&
      ended.outcome !== 'cancelled' &&
      tab?.reducedRootTerminalTurnIds?.includes(ended.id) !== true &&
      !this.reducedRootTerminals
        .get(JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]))
        ?.has(ended.id)
      ? ended
      : undefined;
  }

  /** Read the installed reducer state; returns undefined while its entry loads. */
  public getTurnState(
    scope: ChatTurnStateScope,
  ): PersistedChatTurnState | undefined {
    return this.turnHandoff.getState(scope);
  }

  public onTurnStateChange(
    listener: (change: ChatTurnStateChange) => void,
  ): () => void {
    this.turnStateChangeListeners.add(listener);
    return (): void => {
      this.turnStateChangeListeners.delete(listener);
    };
  }

  public onTurnStateCommitted(
    listener: (commit: ChatTurnStateCommit) => void,
  ): () => void {
    this.turnStateCommittedListeners.add(listener);
    return (): void => {
      this.turnStateCommittedListeners.delete(listener);
    };
  }

  private publishTurnStateChange(change: ChatTurnStateChange): void {
    const key = JSON.stringify([
      change.scope.projectId,
      change.scope.worktreeId,
      change.scope.chatId,
    ]);
    const previous = this.retainedTerminalTurns.get(key);
    if (change.cause === 'reset') this.reducedRootTerminals.delete(key);
    const records =
      change.cause === 'reset' || previous === undefined
        ? new Map<string, ChatTurnRecord>()
        : previous;
    for (const record of [change.state.lastEnded, change.state.current])
      if (record)
        records.set(record.id, {
          ...record,
          inputIds: record.inputIds ? [...record.inputIds] : undefined,
          pauses: record.pauses.map((pause) => ({ ...pause })),
        });
    while (records.size > 64) records.delete(records.keys().next().value ?? '');
    this.retainedTerminalTurns.set(key, records);
    for (const listener of Array.from(this.turnStateChangeListeners)) {
      try {
        listener({
          ...change,
          scope: { ...change.scope },
          state: serializeChatTurnState(
            hydrateChatTurnState(change.state) ?? initialChatTurnState(),
          ),
          effects: change.effects.map((effect) => ({ ...effect })),
        });
      } catch {
        // An observational listener cannot block another listener or producer.
      }
    }
  }

  private publishTurnStateCommitted(commit: ChatTurnStateCommit): void {
    this.reconcileTurnCommitFailures.delete(
      chatRuntimeHostKey(commit.scope, commit.scope.chatId),
    );
    for (const listener of Array.from(this.turnStateCommittedListeners)) {
      try {
        listener({
          ...commit,
          scope: { ...commit.scope },
          state: serializeChatTurnState(
            hydrateChatTurnState(commit.state) ?? initialChatTurnState(),
          ),
          ...(commit.effects
            ? { effects: commit.effects.map((effect) => ({ ...effect })) }
            : {}),
          ...(commit.lifecycle
            ? {
                lifecycle: commit.lifecycle.map((owner) => ({
                  ...owner,
                  inputIds: [...owner.inputIds],
                })),
              }
            : {}),
          ...(commit.timerMessages
            ? { timerMessages: structuredClone(commit.timerMessages) }
            : {}),
          ...(commit.autoRoutedModels
            ? { autoRoutedModels: { ...commit.autoRoutedModels } }
            : {}),
        });
      } catch {
        // A committed observer cannot change acknowledgement or later listeners.
      }
    }
  }

  /** Host pause observations are best effort and never escape to the caller. */
  public observeTurnPause(input: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    type: 'PauseOpened' | 'PauseClosed';
    ownerKind: 'approval' | 'question';
    ownerId: string;
    turnId?: string;
    atMs?: number;
  }): void {
    try {
      const { projectId, worktreeId, chatId, ...observation } = input;
      this.turnHandoff.observePause(
        { projectId, worktreeId, chatId },
        observation,
      );
    } catch {
      // A local reducer or scheduling failure must not block host work.
    }
  }

  /** Commit a host pause before publishing a request or continuing execution.
   * Call outside repository transactions: preparing the handoff can load state.
   */
  public async commitTurnPause(
    input: Parameters<ChatStateService['observeTurnPause']>[0],
  ): Promise<void> {
    const { projectId, worktreeId, chatId, ...observation } = input;
    const scope = { projectId, worktreeId, chatId };
    // Unlike best-effort observations, approval initialization must fail closed.
    this.turnHandoff.observePause(scope, observation);
    await this.turnHandoff.prepare(scope);
    await this.transactWithTurnHandoff(
      scope,
      (current) => {
        if (!current.tabsFile.tabs.some((tab) => tab.id === chatId))
          throw new Error('Canonical turn pause could not be committed');
        return [];
      },
      { source: 'provider', chatIds: [chatId], fullTranscript: true },
      undefined,
      true,
    );
  }

  private async transactWithTurnHandoff(
    scope: ChatScopeKey,
    build: Parameters<ChatStateRepositoryPort['transactWith']>[1],
    options: Parameters<ChatStateRepositoryPort['transactWith']>[2],
    visualAdmission?: { resolveToolKey: VisualToolIdentityResolver },
    requireTurnPlacement = false,
  ): Promise<ChatStateCommit> {
    const snapshots: Array<{
      snapshot: ChatTurnStateHandoffSnapshot;
      timerMessages: PersistedChatMessage[];
      autoRoutedModels: Readonly<Record<string, string>> | undefined;
    }> = [];
    const withTurnState: typeof build = async (
      current,
      revision,
      transaction,
    ) => {
      const mutations = await build(current, revision, transaction);
      for (const mutation of mutations) {
        if (
          mutation.type === 'pending_question.upserted' &&
          mutation.question.answeredAt === undefined &&
          mutation.question.delivery !== 'async'
        ) {
          this.turnHandoff.observePauseFromState(
            {
              projectId: scope.projectId,
              worktreeId: scope.worktreeId,
              chatId: mutation.question.chatId,
            },
            {
              type: 'PauseOpened',
              ownerKind: 'question',
              ownerId: mutation.question.requestId,
              atMs: this.now(),
            },
            current.runtimeByChatId[mutation.question.chatId]?.turn,
          );
        } else if (mutation.type === 'pending_question.removed') {
          this.turnHandoff.observePauseFromState(
            {
              projectId: scope.projectId,
              worktreeId: scope.worktreeId,
              chatId: mutation.chatId,
            },
            {
              type: 'PauseClosed',
              ownerKind: 'question',
              ownerId: mutation.requestId,
              atMs: this.now(),
            },
            current.runtimeByChatId[mutation.chatId]?.turn,
          );
        }
      }
      const chatIds = new Set(options.chatIds ?? []);
      for (const mutation of mutations) {
        if (mutation.type === 'tab.created') chatIds.add(mutation.tab.id);
        if ('chatId' in mutation) chatIds.add(mutation.chatId);
        if (mutation.type === 'tab.removed') chatIds.add(mutation.tabId);
      }
      const merged = mutations.map((mutation): ChatCoreMutation => {
        if (mutation.type !== 'runtime.patched') return mutation;
        const previousTurn = current.runtimeByChatId[mutation.chatId]?.turn;
        return mutation.runtime.turn === undefined && previousTurn !== undefined
          ? {
              ...mutation,
              runtime: { ...mutation.runtime, turn: previousTurn },
            }
          : mutation;
      });
      for (const chatId of Array.from(chatIds)) {
        if (
          mutations.some(
            (mutation) =>
              (mutation.type === 'tab.removed' && mutation.tabId === chatId) ||
              (mutation.type === 'archive.upserted' &&
                mutation.entry.tab.id === chatId),
          )
        ) {
          continue;
        }
        // Never await the handoff here: its first load reads this scope, which
        // queues behind this transaction. Unreduced events ride a later commit.
        const target = {
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          chatId,
        };
        this.turnHandoff.seedFromState(
          target,
          current.runtimeByChatId[chatId]?.turn,
        );
        const snapshot = this.turnHandoff.snapshotNow(target);
        if (!snapshot || !this.turnHandoff.isCurrent(snapshot)) continue;
        // An unplaced snapshot stays unacknowledged for the fallback commit.
        if (!this.attachTurnSnapshot(merged, current, chatId, snapshot)) {
          if (requireTurnPlacement)
            throw new Error('Canonical turn pause could not be committed');
          continue;
        }
        snapshots.push({
          snapshot,
          timerMessages: snapshotTimerRows(merged, snapshot),
          autoRoutedModels: tabAutoRoutedModels(current, chatId),
        });
      }
      return merged;
    };
    const commit = visualAdmission
      ? await this.repository.transactProviderEventWith(
          scope,
          withTurnState,
          options,
          visualAdmission,
        )
      : await this.repository.transactWith(scope, withTurnState, options);
    for (const { snapshot, timerMessages, autoRoutedModels } of snapshots) {
      this.turnHandoff.acknowledge(
        snapshot,
        commit.applied,
        timerMessages,
        autoRoutedModels,
      );
    }
    return commit;
  }

  public disposeTurnHandoff(): void {
    this.turnHandoff.dispose();
    this.persistedBackgroundSnapshotRequests.clear();
  }

  private scheduleRecoveredHistoryResolution(
    scope: ChatScopeKey,
    tabs: readonly PersistedChatTab[],
  ): void {
    for (const tab of tabs) {
      // Every read hydrates: schedule only chats with a row history could settle.
      if (
        !isInputLedger(tab.inputDelivery) ||
        !tab.inputDelivery.rows.some((row) => isHistoryCandidate(row))
      )
        continue;
      this.inputDelivery.scheduleHistoryResolution({
        ...scope,
        chatId: tab.id,
      });
    }
  }

  /** Claim only a committed visible first input; serialize with all chat writes. */
  public async claimNewChatStarted(
    input: ChatScopeKey & {
      chatId: string;
      sourceInputId: string;
      occurredAt: string;
    },
  ): Promise<boolean> {
    let claimed = false;
    await this.repository.transactWith(
      input,
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === input.chatId,
        );
        if (!tab || tab.newChatStartedWatcherFiredAt !== undefined) return [];
        const visibleUsers = tab.messages.filter(
          (message) =>
            message.role === 'user' &&
            message.hidden !== true &&
            message.parentBlockId === undefined &&
            message.parentToolUseId === undefined,
        );
        if (!visibleUsers.some((message) => message.id === input.sourceInputId))
          return [];
        if (
          tab.newChatStartedWatcherPending !== true &&
          visibleUsers[0]?.id !== input.sourceInputId
        )
          return [];
        claimed = true;
        return [
          {
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              newChatStartedWatcherPending: null,
              newChatStartedWatcherFiredAt: input.occurredAt,
            },
          },
        ];
      },
      { source: 'migration', chatIds: [input.chatId], fullTranscript: true },
    );
    return claimed;
  }

  public async getState(request: ChatScopeKey): Promise<ChatStateSnapshot> {
    // Register before reading the snapshot: a queue mutation can commit while
    // that read is in flight, and the older rows may hydrate afterward.
    const { getChatQueueService } = await import('./chat-queue-service');
    const releaseInputHydration = this.reconcileHostRuntime
      ? getChatQueueService().beginInputHydration(
          request.projectId,
          request.worktreeId,
        )
      : undefined;
    try {
      if (this.reconcileHostRuntime) await this.recoverScopeRuntime(request);
      let state = await this.repository.getState(request);
      await this.requestPersistedBackgroundSnapshots(request, state);
      if (this.reconcileHostRuntime)
        this.scheduleRecoveredHistoryResolution(request, state.tabsFile.tabs);
      if (state.tabsFile.activeTabId)
        state = await this.repository.getState(request, {
          chatIds: [state.tabsFile.activeTabId],
          pageOnly: true,
        });
      for (const question of state.tabsFile.pendingQuestions ?? []) {
        this.pendingQuestionScopes.set(question.requestId, {
          ...request,
          chatId: question.chatId,
        });
      }
      // Lazy for the documented chat-state/chat-queue initialization cycle; the
      // queue is runtime-only and is not needed while materializing snapshots.
      const recoveryError = this.repository
        .getDiagnostics(request)
        .find(
          (diagnostic) =>
            diagnostic.kind === 'unrecoverable_snapshot' ||
            diagnostic.kind === 'unrecoverable_journal',
        )?.message;
      const runtimeByChatId = { ...state.runtimeByChatId };
      if (this.reconcileHostRuntime)
        await Promise.all(
          state.tabsFile.tabs.map(async (tab) => {
            const runtime = runtimeByChatId[tab.id] ?? {
              status: 'idle' as const,
              queuedMessageIds: [],
            };
            runtimeByChatId[tab.id] = {
              ...runtime,
              steeringCapabilities: await this.inputDelivery.capabilities({
                ...request,
                chatId: tab.id,
              }),
            };
          }),
        );
      for (const chatId of Object.keys(runtimeByChatId)) {
        const runtime = runtimeByChatId[chatId];
        if (runtime !== undefined) {
          runtimeByChatId[chatId] = projectChatRuntime(runtime);
        }
      }
      // Canonical publication can queue behind a watcher mutation awaiting
      // this snapshot. Start recovery only after the read has returned; failed
      // publication retains its durable pending marker for the next read.
      if (this.reconcileHostRuntime) {
        for (const tab of state.tabsFile.tabs) {
          if (
            tab.kind === 'file' ||
            !isTerminalBackedInterfaceMode(tab.interfaceMode)
          )
            continue;
          setImmediate(() => {
            void import('../integration/claude-terminal-session-service')
              .then(({ getClaudeTerminalSessionService }) =>
                getClaudeTerminalSessionService().resumePendingObservations({
                  ...request,
                  chatId: tab.id,
                }),
              )
              .catch((error: unknown) => {
                logMainProcessWarn(
                  '[chat-state] Could not resume terminal watcher observations:',
                  error,
                );
              });
          });
        }
      }
      return {
        schemaVersion: 1,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        revision: state.tabsFile.revision ?? 0,
        tabsFile: {
          ...state.tabsFile,
          tabs: state.tabsFile.tabs.map((tab) => ({
            ...tab,
            messages: Object.prototype.propertyIsEnumerable.call(
              tab,
              'messages',
            )
              ? tab.messages
              : [],
            ...(tab.transcript
              ? {
                  transcript: tab.transcript,
                  transcriptLoaded: Object.prototype.propertyIsEnumerable.call(
                    tab,
                    'messages',
                  ),
                }
              : {}),
          })),
        },
        archives: state.archivesFile.archived.map((entry) =>
          toArchivedChatSummary(entry, this.now()),
        ),
        runtimeByChatId,
        queue: getChatQueueService().getWorktreeSnapshots(
          request.projectId,
          request.worktreeId,
        ),
        ...(recoveryError ? { recoveryError } : {}),
      };
    } finally {
      releaseInputHydration?.();
    }
  }

  /**
   * Share one in-flight recovery per scope. Each pass holds a full snapshot
   * while it waits in the scope's serial queue, so overlapping readers must
   * not each run one. Callers read after this settles, so none gets a snapshot
   * from before it arrived; a failed pass rejects its callers and the next
   * read retries.
   */
  private recoverScopeRuntime(scope: ChatScopeKey): Promise<void> {
    const key = chatScopeLifecycleKey(scope);
    const running = this.scopeRuntimeRecoveries.get(key);
    if (running) return running;
    const recovery = this.reconcileScopeRuntime(scope).finally(() => {
      this.scopeRuntimeRecoveries.delete(key);
    });
    this.scopeRuntimeRecoveries.set(key, recovery);
    return recovery;
  }

  private async reconcileScopeRuntime(scope: ChatScopeKey): Promise<void> {
    const read = await this.repository.getState(scope);
    await this.requestPersistedBackgroundSnapshots(scope, read);
    const state = await this.reconcileRuntimeHosts(scope, read);
    for (const tab of state.tabsFile.tabs) {
      if (isInputLedger(tab.inputDelivery))
        await this.inputDelivery.recover(
          { ...scope, chatId: tab.id },
          tab.inputDelivery,
        );
    }
  }

  private async requestPersistedBackgroundSnapshots(
    scope: ChatScopeKey,
    state: CanonicalChatState,
  ): Promise<void> {
    for (const tab of state.tabsFile.tabs) {
      if (tab.kind === 'file') continue;
      // Persisted input is untrusted: a malformed value must not stop the load.
      const turn = hydrateChatTurnState(state.runtimeByChatId[tab.id]?.turn);
      if (
        !isBackgroundTurnState(turn) &&
        !(
          turn?.background.native.length ||
          turn?.background.managed.live ||
          turn?.background.managed.queued
        )
      ) {
        continue;
      }
      const tabProvider =
        tab.providerType ??
        (tab.model ? getProviderForModel(tab.model) : undefined);
      // Ollama publishes its lifecycle through its execution harness.
      const provider =
        tabProvider === 'ollama'
          ? tab.model
            ? getExecutionHarnessForModel(tab.model, tab.executionHarness)
            : tab.executionHarness
          : tabProvider;
      if (
        provider !== 'claude' &&
        provider !== 'codex' &&
        provider !== 'cursor' &&
        provider !== 'copilot' &&
        provider !== 'antigravity' &&
        provider !== 'opencode'
      ) {
        continue;
      }
      const key = JSON.stringify([scope.projectId, scope.worktreeId, tab.id]);
      if (this.persistedBackgroundSnapshotRequests.has(key)) continue;
      this.persistedBackgroundSnapshotRequests.add(key);
      try {
        const { requestBackgroundSnapshot } =
          await import('../agents/claude-turn-lifecycle');
        requestBackgroundSnapshot({
          provider,
          ...scope,
          chatId: tab.id,
        });
      } catch {
        this.persistedBackgroundSnapshotRequests.delete(key);
      }
    }
  }

  public async recoverHostRuntime(
    scope: ChatScopeKey,
  ): Promise<ChatHostRuntimeRecovery> {
    const { getChatQueueService } = await import('./chat-queue-service');
    const releaseInputHydration = this.reconcileHostRuntime
      ? getChatQueueService().beginInputHydration(
          scope.projectId,
          scope.worktreeId,
        )
      : undefined;
    try {
      if (this.reconcileHostRuntime) await this.recoverScopeRuntime(scope);
      const state = await this.repository.getState(scope);
      await this.requestPersistedBackgroundSnapshots(scope, state);
      if (this.reconcileHostRuntime)
        this.scheduleRecoveredHistoryResolution(scope, state.tabsFile.tabs);
      return {
        tabs: state.tabsFile.tabs,
        runtimeByChatId: state.runtimeByChatId,
      };
    } finally {
      releaseInputHydration?.();
    }
  }

  public hasMutation(
    request: ChatScopeKey,
    mutationId: string,
  ): Promise<boolean> {
    return this.repository.hasMutation(request, mutationId);
  }

  /** Whether the committed runtime still shows this turn as the chat's open
   * turn. Reads canonical state only; it does not reconcile host runtimes. */
  public async isTurnOpen(
    scope: ChatScopeKey,
    chatId: string,
    turnUserMessageId: string,
  ): Promise<boolean> {
    const state = await this.repository.getState(scope);
    const runtime = state.runtimeByChatId[chatId];
    return (
      runtime !== undefined &&
      ['starting', 'streaming', 'awaiting_input', 'completing'].includes(
        runtime.status,
      ) &&
      runtime.activeTurn?.userMessageId === turnUserMessageId
    );
  }

  /** The chat authority settles only its exact admitted managed-terminal attempt. */
  public async recordTerminalPlanImplementation(
    target: ChatScopeKey & { chatId: string; userMessageId: string },
    phase: 'started' | 'completed' | 'failed' | 'cancelled',
    options?: { pendingOnly: true },
  ): Promise<boolean> {
    let matched = false;
    const now = this.now();
    await this.repository.transactWith(
      target,
      (current): ChatCoreMutation[] => {
        const tab = current.tabsFile.tabs.find(
          (entry) => entry.id === target.chatId,
        );
        const link = tab?.trackedPlanImplementation;
        if (
          !tab ||
          !link ||
          link.userMessageId !== target.userMessageId ||
          link.outcome
        )
          return [];
        const runtime = current.runtimeByChatId[tab.id];
        if (
          options?.pendingOnly &&
          (runtime?.status !== 'starting' ||
            runtime.activeTurn?.userMessageId !== target.userMessageId ||
            (tab.providerType ??
              (tab.model ? getProviderForModel(tab.model) : 'claude')) !==
              'claude' ||
            !isTerminalBackedInterfaceMode(tab.interfaceMode))
        )
          return [];
        if (
          phase === 'started' &&
          runtime?.activeTurn &&
          runtime.activeTurn.userMessageId !== target.userMessageId
        )
          return [];
        matched = true;
        if (
          phase === 'started' &&
          runtime?.status === 'streaming' &&
          runtime.activeTurn?.userMessageId === target.userMessageId
        )
          return [];
        const mutations: ChatCoreMutation[] =
          phase === 'started'
            ? []
            : [
                {
                  type: 'tab.metadata_patched',
                  tabId: tab.id,
                  patch: {
                    turnEnds: withTurnEnd(
                      tab.turnEnds,
                      target.userMessageId,
                      phase,
                      now,
                      tab.lastAcceptedUserMessageId,
                    ),
                  },
                },
              ];
        // A delayed end may settle its link but must not end a newer turn.
        if (
          !runtime?.activeTurn ||
          runtime.activeTurn.userMessageId === target.userMessageId
        ) {
          mutations.push({
            type: 'runtime.patched',
            chatId: tab.id,
            runtime: {
              ...runtime,
              status: phase === 'started' ? 'streaming' : phase,
              queuedMessageIds: runtime?.queuedMessageIds ?? [],
              activeTurn: {
                userMessageId: target.userMessageId,
                startedAt: Date.parse(link.startedAt),
              },
              lastActivityAt: now,
            },
          });
        }
        return mutations;
      },
      {
        source: 'terminal',
        ...(phase === 'started'
          ? {}
          : { mutationId: `plan-terminal:${target.userMessageId}:${phase}` }),
        chatIds: [target.chatId],
      },
    );
    return matched;
  }

  /**
   * How the turn of one user message ended, or `pending` while it has not.
   * Answered from durable chat state, never from the bounded mutation
   * index: a turn that ran reports the end its chat recorded when the turn
   * ended (`turnEnds`), and a turn that ended before any provider
   * accepted it reports the outcome recorded for it (`unacceptedTurnEnds`).
   * Otherwise it is pending while the chat queue holds it as the dispatching
   * turn or a queued row, or the chat queues it or runs or can resume it as
   * its active turn, whose own failure or cancellation is reported while it
   * is the active turn. A turn without a recorded end that is no longer
   * active (it ended before ends were recorded, or its record was dropped
   * past the bound) has ended once it passed acceptance: it is the chat's
   * last accepted turn (`lastAcceptedUserMessageId`) or precedes it in the
   * transcript, since a chat accepts its turns one at a time and a later
   * turn is accepted only after every earlier one ended or left the queue.
   * Every turn of an archived chat has ended, because a chat with queued or
   * active work cannot be archived. A turn an app restart interrupted is
   * carried on by the turn that resumed it (`interruptedTurns`), so it
   * reports how the last resume in that chain ended; it is pending while it
   * awaits a resume, and cancelled once another turn started instead or its
   * chat was archived. A null `userMessageId` names the chat's first turn,
   * `pending` until the chat has a user message.
   */
  public async turnOutcome(
    target: ChatScopeKey & { chatId: string; userMessageId: string | null },
  ): Promise<ChatTurnOutcome> {
    const { chatId } = target;
    const read = (fullTranscript: boolean): Promise<CanonicalChatState> =>
      this.repository.getState(target, {
        chatIds: [chatId],
        ...(fullTranscript ? { fullTranscript: true } : { pageOnly: true }),
      });
    let state = await read(target.userMessageId === null);
    const archived = state.archivesFile.archived.find(
      (entry) => entry.tab.id === chatId,
    )?.tab;
    let tab = state.tabsFile.tabs.find((candidate) => candidate.id === chatId);
    if (!tab) {
      if (!archived) return 'pending';
      if (target.userMessageId === null) return 'completed';
      const succession = resolveTurnSuccession(
        archived.interruptedTurns,
        target.userMessageId,
      );
      if (succession.abandoned || succession.awaitingResume) {
        return 'cancelled';
      }
      return (
        recordedTurnEnd(archived.turnEnds, succession.userMessageId) ??
        archived.unacceptedTurnEnds?.[succession.userMessageId] ??
        'completed'
      );
    }
    const watchedUserMessageId =
      target.userMessageId ??
      tab.messages.find((message) => message.role === 'user')?.id ??
      null;
    if (watchedUserMessageId === null) return 'pending';
    const succession = resolveTurnSuccession(
      tab.interruptedTurns,
      watchedUserMessageId,
    );
    if (succession.abandoned) return 'cancelled';
    if (succession.awaitingResume) return 'pending';
    const { userMessageId } = succession;
    const ended =
      recordedTurnEnd(tab.turnEnds, userMessageId) ??
      tab.unacceptedTurnEnds?.[userMessageId];
    if (ended) return ended;
    const { getChatQueueService } = await import('./chat-queue-service');
    if (getChatQueueService().holdsUserMessage(target, userMessageId)) {
      return 'pending';
    }
    const runtime = state.runtimeByChatId[chatId];
    if (runtime?.queuedMessageIds.includes(userMessageId)) return 'pending';
    if (runtime?.activeTurn?.userMessageId === userMessageId) {
      switch (runtime.status) {
        case 'failed':
        case 'cancelled':
          return runtime.status;
        case 'idle':
        case 'completed':
          return 'completed';
        default:
          return 'pending';
      }
    }
    const lastAccepted = tab.lastAcceptedUserMessageId;
    if (lastAccepted === undefined) return 'pending';
    if (lastAccepted === userMessageId) return 'completed';
    const precedes = (messages: readonly PersistedChatMessage[]): boolean => {
      const ids = messages
        .filter((message) => message.role === 'user')
        .map((message) => message.id);
      const position = ids.indexOf(userMessageId);
      const acceptedPosition = ids.indexOf(lastAccepted);
      return position >= 0 && acceptedPosition > position;
    };
    if (precedes(tab.messages)) return 'completed';
    if (target.userMessageId !== null) {
      state = await read(true);
      tab = state.tabsFile.tabs.find((candidate) => candidate.id === chatId);
      if (tab && precedes(tab.messages)) return 'completed';
    }
    return 'pending';
  }

  /**
   * How a watched turn ended, as `turnOutcome` reports it, with the turn that
   * carried it on after app restarts interrupted it and whether another turn
   * started instead of a resume. Includes the owner's original terminal time
   * when retained, and the reason an input ended without a report of its own.
   */
  public async settledTurn(
    target: ChatScopeKey & { chatId: string; userMessageId: string | null },
  ): Promise<{
    outcome: ChatTurnOutcome;
    userMessageId: string | null;
    abandoned: boolean;
    endedAt?: number;
    endReason?: 'unaccepted' | 'abandoned';
  }> {
    const outcome = await this.turnOutcome(target);
    if (target.userMessageId === null) {
      return { outcome, userMessageId: null, abandoned: false };
    }
    const succession = await this.turnSuccession({
      ...target,
      userMessageId: target.userMessageId,
    });
    const state = await this.repository.getState(target, {
      chatIds: [target.chatId],
      pageOnly: true,
    });
    const tab =
      state.tabsFile.tabs.find((candidate) => candidate.id === target.chatId) ??
      state.archivesFile.archived.find(
        (candidate) => candidate.tab.id === target.chatId,
      )?.tab;
    const endedAt = tab?.turnEnds?.[succession.userMessageId]?.endedAt;
    return {
      outcome,
      ...succession,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(succession.abandoned
        ? { endReason: 'abandoned' }
        : tab?.unacceptedTurnEnds?.[succession.userMessageId] !== undefined
          ? { endReason: 'unaccepted' }
          : {}),
    };
  }

  /**
   * The messages of one turn of a chat, read from the end of its transcript
   * back to the user message that opened it (`turnMessages`): the turn of
   * `userMessageId`, or with null the chat's latest turn. A user message
   * whose place in the transcript does not mark a turn yet neither ends the
   * turn nor belongs to it. Those messages and the transcript come from one
   * read under the chat's scope lease, so a follow-up accepted meanwhile is
   * never both provisional and at its dispatch position. Null when the
   * transcript does not hold that message.
   */
  public async turnReplyMessages(
    target: ChatScopeKey & { chatId: string; userMessageId: string | null },
  ): Promise<PersistedChatMessage[] | null> {
    const { getChatQueueService } = await import('./chat-queue-service');
    const queue = getChatQueueService();
    const opens = (
      message: PersistedChatMessage,
      provisional: ReadonlySet<string>,
    ): boolean =>
      message.role === 'user' &&
      (target.userMessageId === null
        ? isUserTurnBoundary(message) && !provisional.has(message.id)
        : message.id === target.userMessageId);
    const { value: provisional, messages } =
      await this.repository.readTranscriptTail(
        target,
        target.chatId,
        { chatIds: [target.chatId], pageOnly: true },
        {
          fromState: (state) =>
            provisionalTurnIds(
              state,
              target.chatId,
              queue.dispatchingUserMessageId(target),
            ),
          reachedStart: (ids, page) =>
            page.some((message) => opens(message, ids)),
        },
      );
    const opening = messages
      .filter((message) => opens(message, provisional))
      .pop();
    if (opening) return turnMessages(messages, opening.id, provisional);
    return target.userMessageId === null
      ? messages.filter(
          (message) => message.role !== 'user' || !provisional.has(message.id),
        )
      : null;
  }

  /**
   * The turn that carries a watched turn on: the turn itself, or the last
   * turn in its chain of resumes after app restarts interrupted it, and
   * whether another turn started instead of a resume (`abandoned`).
   */
  public async turnSuccession(
    target: ChatScopeKey & { chatId: string; userMessageId: string },
  ): Promise<{ userMessageId: string; abandoned: boolean }> {
    const state = await this.repository.getState(target, {
      chatIds: [target.chatId],
      pageOnly: true,
    });
    const tab =
      state.tabsFile.tabs.find((candidate) => candidate.id === target.chatId) ??
      state.archivesFile.archived.find(
        (entry) => entry.tab.id === target.chatId,
      )?.tab;
    const { userMessageId, abandoned } = resolveTurnSuccession(
      tab?.interruptedTurns,
      target.userMessageId,
    );
    return { userMessageId, abandoned };
  }

  /** {@link provisionalTurnIds} of a chat as its current state reports them. */
  public async provisionalTurnUserMessageIds(
    target: ChatScopeKey & { chatId: string },
  ): Promise<ReadonlySet<string>> {
    const { getChatQueueService } = await import('./chat-queue-service');
    const state = await this.repository.getState(target, {
      chatIds: [target.chatId],
      pageOnly: true,
    });
    return provisionalTurnIds(
      state,
      target.chatId,
      getChatQueueService().dispatchingUserMessageId(target),
    );
  }

  /** Whether a live or auto-archived chat durably contains one message id.
   * A bounded point lookup: it never loads or pages the whole transcript. */
  public hasTranscriptMessage(
    request: ChatScopeKey,
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.repository.hasMessage(request, chatId, messageId);
  }

  public result(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['result']>
  ): Promise<Awaited<ReturnType<DelegationRegistryOperations['result']>>> {
    return this.childStreamRepository().result(scope, ...args);
  }

  public receipt(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['receipt']>
  ): Promise<Awaited<ReturnType<DelegationRegistryOperations['receipt']>>> {
    return this.childStreamRepository().receipt(scope, ...args);
  }

  public resultBySettlementKey(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultBySettlementKey']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['resultBySettlementKey']>>
  > {
    return this.childStreamRepository().resultBySettlementKey(scope, ...args);
  }

  public resultByGeneration(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultByGeneration']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['resultByGeneration']>>
  > {
    return this.childStreamRepository().resultByGeneration(scope, ...args);
  }

  public generation(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['generation']>
  ): Promise<Awaited<ReturnType<DelegationRegistryOperations['generation']>>> {
    return this.childStreamRepository().generation(scope, ...args);
  }

  public resultsPage(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultsPage']>
  ): Promise<Awaited<ReturnType<DelegationRegistryOperations['resultsPage']>>> {
    return this.childStreamRepository().resultsPage(scope, ...args);
  }

  public generationsPage(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['generationsPage']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['generationsPage']>>
  > {
    return this.childStreamRepository().generationsPage(scope, ...args);
  }

  public resultAnswerRange(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultAnswerRange']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['resultAnswerRange']>>
  > {
    return this.childStreamRepository().resultAnswerRange(scope, ...args);
  }

  public itemAdmission(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['itemAdmission']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['itemAdmission']>>
  > {
    return this.childStreamRepository().itemAdmission(scope, ...args);
  }

  /**
   * The selected format after the scope's ordered load and promotion attempt.
   * A non-V2 repository can hold neither format 4 nor the option.
   */
  public generationStoreReadiness(
    scope: ChatScopeKey,
  ): ReturnType<ChatStateV2Repository['generationStoreReadiness']> {
    if (!(this.repository instanceof ChatStateV2Repository))
      return Promise.resolve({
        formatVersion: 2,
        enableFormat4: false,
        promotes: false,
      });
    return this.repository.generationStoreReadiness(scope);
  }

  public subscribeChildSearchDirty(
    listener: Parameters<ChatStateV2Repository['subscribeChildSearchDirty']>[0],
  ): () => void {
    if (!(this.repository instanceof ChatStateV2Repository))
      return (): void => undefined;
    return this.repository.subscribeChildSearchDirty(listener);
  }

  public listChildSearchDocuments(
    ...args: Parameters<ChatStateV2Repository['listChildSearchDocuments']>
  ): ReturnType<ChatStateV2Repository['listChildSearchDocuments']> {
    if (!(this.repository instanceof ChatStateV2Repository))
      return Promise.resolve([]);
    return this.repository.listChildSearchDocuments(...args);
  }

  public readChildSearchDocument(
    ...args: Parameters<ChatStateV2Repository['readChildSearchDocument']>
  ): ReturnType<ChatStateV2Repository['readChildSearchDocument']> {
    return this.childStreamRepository().readChildSearchDocument(...args);
  }

  public commitChildSearchDocuments(
    ...args: Parameters<ChatStateV2Repository['commitChildSearchDocuments']>
  ): ReturnType<ChatStateV2Repository['commitChildSearchDocuments']> {
    return this.childStreamRepository().commitChildSearchDocuments(...args);
  }

  public registerGeneration(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['registerGeneration']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['registerGeneration']>>
  > {
    return this.childStreamRepository().registerGeneration(scope, ...args);
  }

  public updateCardState(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['updateCardState']>
  ): ReturnType<DelegationRegistryOperations['updateCardState']> {
    return this.childStreamRepository().updateCardState(scope, ...args);
  }

  public settleDelegationResult(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['settleDelegationResult']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['settleDelegationResult']>>
  > {
    return this.childStreamRepository().settleDelegationResult(scope, ...args);
  }

  public appendDelegationReceipt(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['appendDelegationReceipt']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['appendDelegationReceipt']>>
  > {
    return this.childStreamRepository().appendDelegationReceipt(scope, ...args);
  }

  /** Serialize a complete target operation without holding the scope lease. */
  public withChildStreamTarget<T>(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.childStreamRepository().withChildStreamTarget(
      scope,
      target,
      operation,
    );
  }

  /** Register a child stream by its complete target, idempotently. */
  public openChildStream(
    scope: ChatScopeKey,
    target: TranscriptTarget,
  ): Promise<TranscriptStreamDescriptor> {
    return this.childStreamRepository().openChildStream(scope, target);
  }

  /** Read the projected child descriptor, including pending journal updates. */
  public getChildStreamState(
    scope: ChatScopeKey,
    target: TranscriptTarget,
  ): Promise<TranscriptStreamDescriptor | undefined> {
    return this.childStreamRepository().getChildStreamState(scope, target);
  }

  /** Read the stored parent row without applying its child stream overlay. */
  public readStoredParentMessage(
    scope: ChatScopeKey,
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined> {
    return this.childStreamRepository().readStoredParentMessage(
      scope,
      chatId,
      messageId,
    );
  }

  /** Persist child rows with a deterministic journal mutation identity. */
  public commitChildStream(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    mutationKey: string,
    rows: readonly DelegationChildRow[],
  ): Promise<{
    applied: boolean;
    revision: number;
    descriptor: TranscriptStreamDescriptor;
  }> {
    return this.childStreamRepository().commitChildStream(
      scope,
      target,
      mutationKey,
      rows,
    );
  }

  /** Read, choose and commit a child write in one turn of the scope lease. */
  public commitPreparedChildStream(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    mutationKey: string,
    prepare: ChildStreamWritePreparation,
  ): Promise<PreparedChildStreamCommit> {
    return this.childStreamRepository().commitPreparedChildStream(
      scope,
      target,
      mutationKey,
      prepare,
    );
  }

  /** Read one logical row only at the stream revision the caller observed. */
  public getChildStreamMessage(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    messageId: string,
    streamRevision: number,
  ): Promise<DelegationChildRow | undefined> {
    return this.childStreamRepository().getChildStreamMessage(
      scope,
      target,
      messageId,
      streamRevision,
    );
  }

  /** Read one bounded stored compatibility page, without hydrating answers. */
  public childStreamCompatibilityPage(
    scope: ChatScopeKey,
    request: ChildStreamCompatibilityPageRequest,
  ): Promise<ChildStreamCompatibilityPageReply> {
    return this.childStreamRepository().childStreamCompatibilityPage(
      scope,
      request,
    );
  }

  public getChildStreamPage(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    streamRevision: number,
    cursor?: string,
    limit?: number,
  ): Promise<ChildStreamRowsPage> {
    return this.childStreamRepository().getChildStreamPage(
      scope,
      target,
      streamRevision,
      cursor,
      limit,
    );
  }

  /** Read a pinned inline/referenced child field range in stored encoding. */
  public readChildStreamContent(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    streamRevision: number,
    messageId: string,
    blockOrdinal: number,
    field: TranscriptContentField,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ChildStreamContentRange> {
    return this.childStreamRepository().readChildStreamContent(
      scope,
      target,
      streamRevision,
      messageId,
      blockOrdinal,
      field,
      offset,
      limit,
      signal,
    );
  }

  public searchTranscript(
    request: ChatTranscriptSearchRequest,
    signal?: AbortSignal,
  ): Promise<ChatTranscriptSearchResult> {
    if (request.target && request.target.chatId !== request.chatId)
      return Promise.reject(new Error('Unknown child stream'));
    if (request.target?.kind === 'delegation')
      return this.repository.search(request, signal);
    return this.consumeTranscript(request, request.chatId, false, (messages) =>
      searchTranscriptMessages(messages, request.query, signal),
    );
  }

  public async getTranscriptPage(
    request: ChatTranscriptPageRequest,
  ): Promise<TranscriptPage> {
    if (request.standaloneHistory) {
      const backend = await this.standaloneArchiveBackend(
        request.projectId,
        request.chatId,
      );
      return backend.page(
        request.chatId,
        request.before,
        request.transcriptRevision,
        request,
      );
    }
    if (request.archivedContainerId) {
      const backend = await this.archivedContainerBackend(
        request.projectId,
        request.archivedContainerId,
      );
      return backend.page(
        request.chatId,
        request.before,
        request.transcriptRevision,
        request,
      );
    }
    return this.repository.page(
      request,
      request.chatId,
      request.before,
      request.transcriptRevision,
      request,
    );
  }

  /**
   * Appends delegated runs' new and changed child transcript items to the
   * parent chat's delegate logs, under one scope lease. False when the chat
   * no longer exists.
   */
  public appendDelegationItems(
    scope: ChatScopeKey,
    chatId: string,
    runs: readonly DelegationRunItems[],
  ): Promise<boolean> {
    return this.repository.appendDelegationItems(scope, chatId, runs);
  }

  /** A delegated run's child transcript from its parent chat's delegate log. */
  public async readDelegationItems(
    request: ChatScopeKey & {
      chatId: string;
      archivedContainerId?: string;
      standaloneHistory?: boolean;
    } & DelegationRun,
  ): Promise<AgentDelegationTranscriptItem[]> {
    const run = {
      delegationId: request.delegationId,
      runGeneration: request.runGeneration,
    };
    if (request.standaloneHistory) {
      const backend = await this.standaloneArchiveBackend(
        request.projectId,
        request.chatId,
      );
      return backend.readDelegationItems(request.chatId, run);
    }
    if (request.archivedContainerId) {
      const backend = await this.archivedContainerBackend(
        request.projectId,
        request.archivedContainerId,
      );
      return backend.readDelegationItems(request.chatId, run);
    }
    return this.repository.readDelegationItems(request, request.chatId, run);
  }

  public async readToolOutput(
    request: ChatToolOutputRequest,
    signal?: AbortSignal,
  ): Promise<ChatToolOutputResponse> {
    const backend = await this.readArchiveBackend(request);
    if (backend) {
      return backend.toolOutput(
        request.chatId,
        request.messageId,
        request.toolUseId,
        request.reference,
        request.offset,
        request.limit,
        signal,
        request,
      );
    }
    return this.repository.toolOutput(
      request,
      request.chatId,
      request.messageId,
      request.toolUseId,
      request.reference,
      request.offset,
      request.limit,
      signal,
      request,
    );
  }

  /** A verified byte range from the selected row's stored body. */
  public async readTranscriptContent(
    request: ChatTranscriptContentRequest,
    signal?: AbortSignal,
  ): Promise<ChatToolOutputResponse> {
    if (request.standaloneHistory) {
      const backend = await this.standaloneArchiveBackend(
        request.projectId,
        request.chatId,
      );
      return backend.content(request, signal);
    }
    if (request.archivedContainerId) {
      const backend = await this.archivedContainerBackend(
        request.projectId,
        request.archivedContainerId,
      );
      return backend.content(request, signal);
    }
    return this.repository.content(request, signal);
  }

  /** A bounded ordinal page of the selected row's logical blocks. */
  public async getTranscriptBlocks(
    request: ChatTranscriptBlocksRequest,
    signal?: AbortSignal,
  ): Promise<ChatTranscriptBlocksPage> {
    if (request.standaloneHistory) {
      const backend = await this.standaloneArchiveBackend(
        request.projectId,
        request.chatId,
      );
      return backend.blocks(request, signal);
    }
    if (request.archivedContainerId) {
      const backend = await this.archivedContainerBackend(
        request.projectId,
        request.archivedContainerId,
      );
      return backend.blocks(request, signal);
    }
    return this.repository.blocks(request, signal);
  }

  public async readVisual(
    request: ChatVisualReadRequest,
    signal?: AbortSignal,
  ): Promise<ChatVisualReadResponse> {
    const backend = await this.readArchiveBackend(request);
    if (backend)
      return backend.visual(
        request.chatId,
        request.messageId,
        request.toolUseId,
        request.reference,
        request.offset,
        request.limit,
        signal,
      );
    return this.repository.visual(
      request,
      request.chatId,
      request.messageId,
      request.toolUseId,
      request.reference,
      request.offset,
      request.limit,
      signal,
    );
  }

  private async readArchiveBackend(request: {
    projectId: string;
    chatId: string;
    standaloneHistory?: boolean;
    archivedContainerId?: string;
  }): Promise<ArchiveChatBackend | undefined> {
    if (request.standaloneHistory)
      return this.standaloneArchiveBackend(request.projectId, request.chatId);
    if (request.archivedContainerId)
      return this.archivedContainerBackend(
        request.projectId,
        request.archivedContainerId,
      );
    return undefined;
  }

  private standaloneArchiveBackend(
    projectId: string,
    chatId: string,
  ): Promise<ArchiveChatBackend> {
    return this.archiveBackend(
      JSON.stringify(['standalone', projectId, chatId]),
      async () => {
        // Keep archive filesystem setup and backend loading off packaged main
        // startup until an archived transcript is first opened.
        const [{ getStandaloneHistoryStorage }, { ChatStateV2Backend }] =
          await Promise.all([
            import('../lib/standalone-history'),
            import('./chat-state-v2-backend'),
          ]);
        const store = await getStandaloneHistoryStorage(projectId, chatId);
        if (!store) throw new Error('Standalone archive not found');
        return new ChatStateV2Backend(store);
      },
    );
  }

  private archivedContainerBackend(
    projectId: string,
    containerId: string,
  ): Promise<ArchiveChatBackend> {
    return this.archiveBackend(
      JSON.stringify(['container', projectId, containerId]),
      async () => {
        // Keep archive filesystem setup and backend loading off packaged main
        // startup until an archived transcript is first opened.
        const [{ getArchivedContainerChatStorage }, { ChatStateV2Backend }] =
          await Promise.all([
            import('../lib/archived-containers'),
            import('./chat-state-v2-backend'),
          ]);
        const store = await getArchivedContainerChatStorage(
          projectId,
          containerId,
        );
        return new ChatStateV2Backend(store);
      },
    );
  }

  private archiveBackend(
    key: string,
    create: () => Promise<ArchiveChatBackend>,
  ): Promise<ArchiveChatBackend> {
    const cached = this.archiveBackends.get(key);
    if (cached) {
      this.archiveBackends.delete(key);
      this.archiveBackends.set(key, cached);
      return cached;
    }
    const loading = create();
    this.archiveBackends.set(key, loading);
    if (this.archiveBackends.size > ARCHIVE_BACKEND_CACHE_LIMIT) {
      const oldest = this.archiveBackends.keys().next();
      if (!oldest.done) this.archiveBackends.delete(oldest.value);
    }
    void loading.catch(() => {
      if (this.archiveBackends.get(key) === loading) {
        this.archiveBackends.delete(key);
      }
    });
    return loading;
  }

  /** Whether the handoff holds received turn state this chat has not committed. */
  private hasUncommittedTurnState(
    target: ChatTurnStateScope,
    committed?: PersistedChatTurnState,
  ): boolean {
    if (committed) this.turnHandoff.seedFromState(target, committed);
    const snapshot = this.turnHandoff.snapshotNow(target);
    return snapshot !== undefined && this.turnHandoff.isCurrent(snapshot);
  }

  /** Commit a deferred chat's turn state; report a store that keeps refusing it. */
  private async commitDeferredTurnState(
    target: ChatTurnStateScope,
  ): Promise<void> {
    await this.turnHandoff.flush(target);
    const key = chatRuntimeHostKey(target, target.chatId);
    if (!this.hasUncommittedTurnState(target)) {
      this.reconcileTurnCommitFailures.delete(key);
      return;
    }
    const failures = (this.reconcileTurnCommitFailures.get(key) ?? 0) + 1;
    this.reconcileTurnCommitFailures.set(key, failures);
    if (failures !== RECONCILE_TURN_COMMIT_STALL_PASSES) return;
    logMainProcessWarn(
      '[chat-state] Turn state keeps failing to commit; host reconciliation is waiting for it:',
      { chatId: target.chatId },
    );
    try {
      this.recordDiagnostic({
        version: 1,
        timestamp: new Date(this.now()).toISOString(),
        kind: 'turn_state_commit_stalled',
        sessionKey: `${target.projectId}/${target.worktreeId}/${target.chatId}`,
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
        providerType: 'unknown',
      });
    } catch {
      // Diagnostics are best-effort and must never change reconciliation.
    }
  }

  private async reconcileRuntimeHosts(
    scope: ChatScopeKey,
    state: CanonicalChatState,
  ): Promise<CanonicalChatState> {
    // Both host registries depend on the installed chat-state port. Resolve
    // them after repository startup to avoid a circular module initializer.
    const [
      { getActiveChatIds },
      { getChatQueueService },
      { getClaudeTerminalSessionService },
      { getE2eInjectedLiveTurnChatIds },
    ] = await Promise.all([
      import('../agents/session-manager'),
      import('./chat-queue-service'),
      import('../integration/claude-terminal-session-service'),
      import('../lib/e2e-injected-turns'),
    ]);
    const queueService = getChatQueueService();
    const memoryQueueIds = new Map(
      queueService
        .getWorktreeSnapshots(scope.projectId, scope.worktreeId)
        .map((snapshot) => [
          snapshot.chatId,
          new Set(snapshot.queue.map((message) => message.id)),
        ]),
    );
    const hydratedTargets = new Map<
      string,
      ChatScopeKey & { chatId: string }
    >();
    for (const tab of state.tabsFile.tabs) {
      if (tab.kind === 'file') continue;
      const runtime = state.runtimeByChatId[tab.id];
      const durableQueueIds = new Set(runtime?.queuedMessageIds ?? []);
      const inputLedger = isInputLedger(tab.inputDelivery)
        ? tab.inputDelivery
        : undefined;
      const queuedLedgerRowFor = (
        message: PersistedHostQueuedMessage,
      ): InputRow | undefined => {
        if (!inputLedger) return undefined;
        const byMessageId = inputLedger.rows.find(
          (row) => row.id === message.id && row.state === 'queued',
        );
        if (byMessageId) return byMessageId;
        return inputLedger.rows.find(
          (row) =>
            row.id === message.request.userMessageId && row.state === 'queued',
        );
      };
      for (const message of runtime?.queuedMessages ?? []) {
        const ledgerRow = queuedLedgerRowFor(message);
        const hydrationOptions:
          | []
          | [{ ordinaryOnly?: true; creditRefused?: true }] =
          ledgerRow?.ordinaryOnly === true ||
          tab.aiCreditsNoBillingSource !== undefined
            ? [
                {
                  ...(ledgerRow?.ordinaryOnly === true
                    ? { ordinaryOnly: true }
                    : {}),
                  ...(tab.aiCreditsNoBillingSource
                    ? { creditRefused: true }
                    : {}),
                },
              ]
            : [];
        // A flagged row was dispatching when this state was written. Its
        // prompt commit would have removed it, so it never reached the
        // transcript: return it to the head of the queue.
        if (message.dispatching === true && !durableQueueIds.has(message.id)) {
          queueService.hydratePersistedInput(
            message.request,
            message.id,
            message.origin,
            message.enqueuedAtMs,
            message.authenticationAttemptId,
            message.requiredAccountProxyConnectionId,
            {
              atHead: true,
              ...hydrationOptions[0],
              ...(message.revision !== undefined
                ? { revision: message.revision }
                : {}),
            },
          );
          hydratedTargets.set(tab.id, { ...scope, chatId: tab.id });
          continue;
        }
        if (!durableQueueIds.has(message.id)) continue;
        queueService.hydratePersistedInput(
          message.request,
          message.id,
          message.origin,
          message.enqueuedAtMs,
          message.authenticationAttemptId,
          message.requiredAccountProxyConnectionId,
          ...withQueuedRevision(hydrationOptions, message.revision),
        );
        hydratedTargets.set(tab.id, { ...scope, chatId: tab.id });
      }
      if (inputLedger) {
        for (const row of [...inputLedger.rows]
          .filter(
            (candidate) =>
              candidate.state === 'queued' && durableQueueIds.has(candidate.id),
          )
          .sort((left, right) => left.createdAt - right.createdAt)) {
          if (row.ordinaryOnly === true) {
            queueService.hydratePersistedInput(
              row.payload,
              row.id,
              row.origin ?? 'desktop',
              row.createdAt,
              undefined,
              undefined,
              {
                ordinaryOnly: true,
                ...(tab.aiCreditsNoBillingSource
                  ? { creditRefused: true }
                  : {}),
              },
            );
          } else {
            const hydration: Parameters<
              typeof queueService.hydratePersistedInput
            > = tab.aiCreditsNoBillingSource
              ? [
                  row.payload,
                  row.id,
                  row.origin ?? 'desktop',
                  row.createdAt,
                  undefined,
                  undefined,
                  { creditRefused: true },
                ]
              : [row.payload, row.id, row.origin ?? 'desktop', row.createdAt];
            queueService.hydratePersistedInput(...hydration);
          }
          hydratedTargets.set(tab.id, { ...scope, chatId: tab.id });
        }
      }
      for (const message of runtime?.queuedMessages ?? []) {
        if (message.admitting !== true || durableQueueIds.has(message.id))
          continue;
        const userMessageId = message.request.userMessageId;
        if (await this.repository.hasMessage(scope, tab.id, userMessageId))
          continue;
        if (
          isInputLedger(tab.inputDelivery) &&
          tab.inputDelivery.rows.some(
            (row) => row.payload.userMessageId === userMessageId,
          )
        )
          continue;
        if (
          (runtime?.queuedMessages ?? []).some(
            (queued) =>
              durableQueueIds.has(queued.id) &&
              queued.request.userMessageId === userMessageId,
          )
        )
          continue;
        // Every read hydrates, and an admission still running in this process
        // owns its message; a snapshot read during it can also be stale by
        // now. Recover only an entry the current state still holds with no
        // admission in flight, i.e. one a crash or quit left behind.
        const currentRuntime = (
          await this.repository.getState(scope, { chatIds: [tab.id] })
        ).runtimeByChatId[tab.id];
        if (
          this.acceptedSendsInFlight.has(
            JSON.stringify([
              scope.projectId,
              scope.worktreeId,
              tab.id,
              userMessageId,
            ]),
          ) ||
          !currentRuntime?.queuedMessages?.some(
            (entry) => entry.id === message.id && entry.admitting === true,
          )
        )
          continue;
        const hydrationOptions:
          | []
          | [{ ordinaryOnly?: true; creditRefused?: true }] =
          queuedLedgerRowFor(message)?.ordinaryOnly === true ||
          tab.aiCreditsNoBillingSource !== undefined
            ? [
                {
                  ...(queuedLedgerRowFor(message)?.ordinaryOnly === true
                    ? { ordinaryOnly: true }
                    : {}),
                  ...(tab.aiCreditsNoBillingSource
                    ? { creditRefused: true }
                    : {}),
                },
              ]
            : [];
        queueService.hydratePersistedInput(
          message.request,
          message.id,
          message.origin,
          message.enqueuedAtMs,
          message.authenticationAttemptId,
          message.requiredAccountProxyConnectionId,
          ...withQueuedRevision(hydrationOptions, message.revision),
        );
        hydratedTargets.set(tab.id, { ...scope, chatId: tab.id });
      }
      if (inputLedger) {
        const durableMessages = runtime?.queuedMessages ?? [];
        const inMemoryIds = memoryQueueIds.get(tab.id) ?? new Set<string>();
        for (const row of inputLedger.rows) {
          const continuation = validOrdinaryContinuation(inputLedger, row);
          if (row.state !== 'cancelled' || !continuation) continue;
          const presentDurably =
            durableQueueIds.has(row.id) ||
            durableMessages.some(
              (message) =>
                durableQueueIds.has(message.id) &&
                (message.id === row.id ||
                  message.request.userMessageId === row.id),
            );
          if (presentDurably || inMemoryIds.has(row.id)) continue;
          void Promise.resolve()
            .then(() =>
              queueService.restoreWithdrawnInput(
                row.payload,
                row.id,
                undefined,
                continuation.epoch,
                row.origin ?? 'desktop',
                undefined,
                {
                  ordinaryOnly: true,
                  waitForQueue: true,
                  continuation,
                },
              ),
            )
            .catch((error: unknown) =>
              logMainProcessWarn(
                'Failed to restore cancelled generated input after chat hydration',
                error,
              ),
            );
        }
      }
    }
    // The transaction checks transcript timers before it can classify idle
    // and interrupted runtimes, so it may only touch runtimes whose
    // transcripts were selected from this snapshot. A runtime accepted
    // between the read and the lease is reconciled by the next snapshot.
    const selectedChatIds = new Set(Object.keys(state.runtimeByChatId));
    const restartChatIds = new Set<string>();
    const deferredChatIds = new Set<string>();
    let commit: ChatStateCommit;
    try {
      commit = await this.repository.transactWith(
        scope,
        async (current) => {
          // Resolve every liveness source inside the serialized transaction so
          // a stale pre-transaction snapshot cannot interrupt a newly accepted
          // turn. Queue turnActive covers the period after dispatch returns;
          // dispatchesInFlight covers durable acceptance through host exposure.
          const activeChatIds = new Set([
            ...getActiveChatIds(scope.projectId, scope.worktreeId),
            ...getE2eInjectedLiveTurnChatIds(scope.projectId, scope.worktreeId),
          ]);
          const hostQueueIds = new Map(
            queueService
              .getWorktreeSnapshots(scope.projectId, scope.worktreeId)
              .map((snapshot) => [
                snapshot.chatId,
                snapshot.queue.map((message) => message.id),
              ]),
          );
          const mutations: ChatCoreMutation[] = [];
          for (const [chatId, runtime] of Object.entries(
            current.runtimeByChatId,
          )) {
            if (!selectedChatIds.has(chatId)) continue;
            const tab = current.tabsFile.tabs.find(
              (candidate) => candidate.id === chatId,
            );
            if (!tab || tab.kind === 'file') continue;
            const openTimer = tab.messages.some((message) =>
              message.blocks.some(
                (block) =>
                  block.type === 'turn_timer' &&
                  block.completedAt == null &&
                  (block.pausedAt == null || block.resumedAt != null),
              ),
            );
            const terminalActive =
              tab.claudeTerminal &&
              ['running', 'starting'].includes(tab.claudeTerminal.turnState);
            const unfinished = [
              'queued',
              'starting',
              'streaming',
              'awaiting_input',
              'completing',
            ].includes(runtime.status);
            const reducerTurn = hydrateChatTurnState(runtime.turn);
            const openTurnPauseOwner = [
              reducerTurn?.current,
              reducerTurn?.lastEnded,
            ].some((turn) =>
              turn?.pauses.some((pause) => pause.endedAtMs === undefined),
            );
            const reducerTurnNeedsRestart =
              reducerTurn?.current !== undefined || openTurnPauseOwner;
            if (
              !unfinished &&
              !terminalActive &&
              !(
                openTimer && ['idle', 'interrupted'].includes(runtime.status)
              ) &&
              !reducerTurnNeedsRestart
            )
              continue;
            const queuedMessageIds = hostQueueIds.get(chatId) ?? [];
            if (runtime.status === 'queued' && queuedMessageIds.length > 0) {
              if (
                JSON.stringify(queuedMessageIds) !==
                JSON.stringify(runtime.queuedMessageIds)
              ) {
                mutations.push({
                  type: 'runtime.patched',
                  chatId,
                  runtime: { ...runtime, queuedMessageIds },
                });
              }
              continue;
            }
            const target = { ...scope, chatId };
            const terminal = getClaudeTerminalSessionService().getState(
              scope.projectId,
              scope.worktreeId,
              chatId,
            );
            if (
              activeChatIds.has(chatId) ||
              (terminal && !['exited', 'error'].includes(terminal.turnState)) ||
              queueService.isTurnActive(target) ||
              this.dispatchesInFlight.has(chatRuntimeHostKey(scope, chatId))
            ) {
              continue;
            }
            // Received turn state outranks this committed runtime: commit it
            // first, and reconcile the chat from the committed result later.
            if (this.hasUncommittedTurnState(target, runtime.turn)) {
              deferredChatIds.add(chatId);
              continue;
            }
            this.reconcileTurnCommitFailures.delete(
              chatRuntimeHostKey(scope, chatId),
            );
            // Fence the handoff before awaiting, so receipts that arrive
            // meanwhile queue for the restarted state instead of being replaced.
            if (reducerTurnNeedsRestart) {
              this.turnHandoff.prepareRestart(target);
              restartChatIds.add(chatId);
            }
            const now = this.now();
            // Persist the resume target before closing its durable running marker.
            // A registry failure leaves the original state available for a retry.
            if (isRealWorkspaceTarget(target)) {
              await recordInterruptedChats([
                {
                  ...target,
                  provider:
                    tab.providerType ??
                    (tab.model ? getProviderForModel(tab.model) : undefined) ??
                    'claude',
                  detectedAt: now,
                  resumeReason: 'app_shutdown',
                  interruptedUserMessageId:
                    runtime.activeTurn?.userMessageId ??
                    runtime.turn?.current?.userMessageId,
                  workspaceName: '',
                  chatTitle: tab.title ?? '',
                },
              ]);
            }
            if (terminalActive && tab.claudeTerminal)
              mutations.push({
                type: 'tab.metadata_patched',
                tabId: chatId,
                patch: {
                  claudeTerminal: {
                    ...tab.claudeTerminal,
                    turnState: 'exited',
                  },
                },
              });
            // An app restart ends the marked turn without completing it, so
            // its auto-archive ends here, before any resume (CAN-6014).
            if (tab.autoArchive === true)
              mutations.push({
                type: 'tab.metadata_patched',
                tabId: chatId,
                patch: { autoArchive: null, autoArchiveTurnId: null },
              });
            for (const question of current.tabsFile.pendingQuestions ?? []) {
              // Synchronous questions belong to the interrupted provider turn,
              // but Codex async questions remain actionable after that turn has
              // settled and must survive restart reconciliation.
              if (question.chatId === chatId && question.delivery !== 'async')
                mutations.push({
                  type: 'pending_question.removed',
                  chatId,
                  requestId: question.requestId,
                });
            }
            mutations.push(
              ...buildPersistedTurnInterruptedMutations(
                chatId,
                tab.messages,
                runtime,
                now,
                queuedMessageIds,
                tab,
              ),
            );
          }
          return mutations;
        },
        {
          ...{
            source: 'automation',
            mutationId: `host-reconcile:${state.tabsFile.revision ?? 0}`,
            checkpoint: true,
          },
          chatIds: Array.from(selectedChatIds),
        },
      );
    } catch (error) {
      for (const chatId of Array.from(restartChatIds))
        this.turnHandoff.cancelRestart({ ...scope, chatId });
      throw error;
    }
    for (const chatId of Array.from(restartChatIds)) {
      const target = { ...scope, chatId };
      if (commit.applied)
        this.turnHandoff.restartFromState(
          target,
          commit.state.runtimeByChatId[chatId]?.turn,
        );
      else this.turnHandoff.cancelRestart(target);
    }
    for (const chatId of Array.from(deferredChatIds))
      await this.commitDeferredTurnState({ ...scope, chatId });
    for (const target of Array.from(hydratedTargets.values()))
      queueService.releaseInputOwnership(target);
    return commit.state;
  }

  public subscribe(
    listener: (event: ChatStateChangedEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async command(
    envelope: ChatCommandEnvelope<ChatCommand>,
    options: TrustedChatCommandExecutionOptions = {},
  ): Promise<ChatCommandResult> {
    if (
      isRetiredPlanChatScope(envelope.projectId) &&
      isRetiredScopeRefusedCommand(envelope.command)
    ) {
      // Canonical command hosts (the chat-command IPC, the portal) reach this
      // service directly: refuse a legacy plan chat before its scope is
      // opened, so nothing is read, migrated, or persisted. No surface shows
      // the retired scope, so the reported revision is never observed.
      return commandResult(envelope, 0, 'rejected', {
        reason: RETIRED_PLAN_CHAT_MESSAGE,
      });
    }
    if (envelope.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
      await this.assertViewerCommandAllowed(envelope);
    }
    const lifecycleKey = chatScopeLifecycleKey(envelope);
    const isSendCommand = isTurnStartingCommand(envelope.command);
    if (isSendCommand && !this.isScopeDeletionBlocking(lifecycleKey)) {
      return this.runWithScopeActivity(envelope, () =>
        this.commandWithinScopeActivity(envelope, options),
      );
    }
    return this.commandWithinScopeActivity(envelope, options);
  }

  /**
   * The shared-container viewer scope is read-only content, but its view state
   * is recipient-local: tab activation, order and read markers, plus file tabs
   * the recipient opens beside the published chats (the standard file viewer
   * keeps its tab identity here). Every other command, and any file-tab
   * command aimed at a published chat, fails closed.
   */
  private async assertViewerCommandAllowed(
    envelope: ChatCommandEnvelope<ChatCommand>,
  ): Promise<void> {
    const command = envelope.command;
    switch (command.type) {
      case 'chat.activate_tab':
      case 'chat.reorder_tabs':
      case 'chat.mark_read':
      case 'chat.mark_unread':
      case 'chat.dismiss_attention':
      case 'chat.create_file_tab':
        return;
      case 'chat.patch_tab_settings': {
        const fileViewKeys = new Set<string>([
          'fileViewMode',
          'fileDiffContext',
          'filePath',
          'title',
        ]);
        if (
          Object.keys(command.patch).every((key) => fileViewKeys.has(key)) &&
          (await this.viewerTabsAreFileTabs(envelope, [command.tabId]))
        ) {
          return;
        }
        break;
      }
      case 'chat.close_tab':
        if (
          command.mode === 'discard_empty' &&
          command.replacementTab === undefined &&
          command.replacementTabId === undefined &&
          (await this.viewerTabsAreFileTabs(envelope, [command.tabId]))
        ) {
          return;
        }
        break;
      case 'chat.close_tabs':
        if (
          command.replacementTab === undefined &&
          command.replacementTabId === undefined &&
          command.targets.every((target) => target.mode === 'discard_empty') &&
          (await this.viewerTabsAreFileTabs(
            envelope,
            command.targets.map((target) => target.tabId),
          ))
        ) {
          return;
        }
        break;
      default:
        break;
    }
    assertWritableScope(envelope.projectId);
  }

  private async viewerTabsAreFileTabs(
    scope: ChatScopeKey,
    tabIds: readonly string[],
  ): Promise<boolean> {
    if (tabIds.length === 0) return false;
    const { tabs } = await this.getCompatibilityTabs(
      { projectId: scope.projectId, worktreeId: scope.worktreeId },
      { chatIds: tabIds, pageOnly: true },
    );
    return tabIds.every(
      (tabId) => tabs.find((tab) => tab.id === tabId)?.kind === 'file',
    );
  }

  private async commandWithinScopeActivity(
    envelope: ChatCommandEnvelope<ChatCommand>,
    options: TrustedChatCommandExecutionOptions,
  ): Promise<ChatCommandResult> {
    const isSendCommand = isTurnStartingCommand(envelope.command);
    if (
      this.isScopeDeletionBlocking(chatScopeLifecycleKey(envelope)) ||
      (this.deletingScopeIds.has(chatScopeLifecycleKey(envelope)) &&
        !isSendCommand)
    ) {
      return commandResult(
        envelope,
        await this.repository.getRevision(envelope),
        'rejected',
        { reason: 'Chat scope is being deleted' },
      );
    }
    const claimKey = `${envelope.projectId}\u0000${envelope.worktreeId}\u0000${envelope.commandId}`;
    const claimed = this.commandsInFlight.get(claimKey);
    if (claimed) {
      const result = await claimed;
      if (
        options.portalSend &&
        (result.outcome === 'applied' || result.outcome === 'already_applied')
      ) {
        return this.executeCommandWithDiagnostics(envelope, options);
      }
      if (options.onAgentSendAccepted) {
        const receipt = await this.repository.getReceipt(
          envelope,
          envelope.commandId,
        );
        if (receipt?.agentSendAcceptance)
          options.onAgentSendAccepted(receipt.agentSendAcceptance);
      }
      return result.outcome === 'applied'
        ? { ...result, outcome: 'already_applied' }
        : result;
    }
    const execution = withWorkspaceTargetRuntimeStartReservation(
      envelope.projectId,
      envelope.worktreeId,
      () => this.executeCommandWithDiagnostics(envelope, options),
    );
    this.commandsInFlight.set(claimKey, execution);
    try {
      return await execution;
    } finally {
      if (this.commandsInFlight.get(claimKey) === execution) {
        this.commandsInFlight.delete(claimKey);
      }
    }
  }

  /**
   * Failure chokepoint for the revisioned command path. A `rejected` outcome
   * and an escaping error both surface the same generic "couldn't save this
   * chat change" banner in the renderer, which drops the `reason` main
   * computed; without this record a field report has no way to say which
   * command failed or why. Recorded here rather than in `command()` so a
   * deduplicated concurrent caller replaying the same result does not
   * double-count one failure.
   */
  private async executeCommandWithDiagnostics(
    envelope: ChatCommandEnvelope<ChatCommand>,
    options: TrustedChatCommandExecutionOptions,
  ): Promise<ChatCommandResult> {
    try {
      const result = await this.executeCommandWithConflictHandling(
        envelope,
        options,
      );
      if (result.outcome === 'rejected') {
        this.recordCommandFailure(envelope, 'rejected', result.reason);
      }
      return result;
    } catch (error) {
      this.recordCommandFailure(
        envelope,
        'threw',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private recordCommandFailure(
    envelope: ChatCommandEnvelope<ChatCommand>,
    outcome: 'rejected' | 'threw',
    reason: string | undefined,
  ): void {
    const command = envelope.command;
    // Entity ids only: the command payload can carry message text, file
    // paths, and attachments that have no place in a diagnostics day file.
    const chatId =
      'chatId' in command
        ? command.chatId
        : 'tabId' in command
          ? command.tabId
          : '';
    try {
      this.recordDiagnostic({
        version: 1,
        timestamp: new Date(this.now()).toISOString(),
        kind: 'chat_command_failed',
        sessionKey: `${envelope.projectId}/${envelope.worktreeId}/${chatId}`,
        projectId: envelope.projectId,
        worktreeId: envelope.worktreeId,
        chatId,
        providerType: 'unknown',
        chatCommandType: command.type,
        chatCommandId: envelope.commandId,
        chatCommandOutcome: outcome,
        ...(reason ? { error: reason } : {}),
      });
    } catch {
      // Diagnostics are best-effort and must never change a command outcome.
    }
  }

  private async executeCommandWithConflictHandling(
    envelope: ChatCommandEnvelope<ChatCommand>,
    options: TrustedChatCommandExecutionOptions,
  ): Promise<ChatCommandResult> {
    try {
      return await this.executeCommand(envelope, options);
    } catch (error) {
      if (error instanceof ChatSendAuthorizationRevokedError) {
        return commandResult(
          envelope,
          await this.repository.getRevision(envelope),
          'rejected',
          { reason: error.message },
        );
      }
      if (error instanceof ChatStateRevisionConflictError) {
        return commandResult(envelope, error.actualRevision, 'conflict', {
          reason: error.message,
        });
      }
      throw error;
    }
  }

  private async executeCommand(
    envelope: ChatCommandEnvelope<ChatCommand>,
    options: TrustedChatCommandExecutionOptions,
  ): Promise<ChatCommandResult> {
    const scope = {
      projectId: envelope.projectId,
      worktreeId: envelope.worktreeId,
    };
    if (options.portalSend) {
      if (
        envelope.origin !== 'portal' ||
        envelope.command.type !== 'chat.send_message' ||
        envelope.command.chatId !== options.portalSend.chatId ||
        envelope.command.userMessageId !== options.portalSend.userMessageId
      ) {
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          'rejected',
          {
            reason:
              'The logical portal send identity does not match the command.',
          },
        );
      }
      const probe = await this.getPortalSendReceipt({
        ...scope,
        commandId: envelope.commandId,
        identity: options.portalSend,
      });
      if (probe.outcome === 'matched') {
        return commandResult(
          envelope,
          probe.receipt.revision,
          'already_applied',
          {
            entityId: probe.receipt.entityId,
            messageId: probe.receipt.messageId,
          },
        );
      }
      if (probe.outcome === 'conflict') {
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          'rejected',
          { reason: 'The logical portal send payload or target has changed.' },
        );
      }
    }
    const receipt = await this.repository.getReceipt(scope, envelope.commandId);
    if (receipt) {
      if (receipt.agentSendAcceptance)
        options.onAgentSendAccepted?.(receipt.agentSendAcceptance);
      return commandResult(envelope, receipt.revision, 'already_applied', {
        ...(receipt.reason ? { reason: receipt.reason } : {}),
        ...(receipt.entityId ? { entityId: receipt.entityId } : {}),
        ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
        ...(receipt.archivedAt ? { archivedAt: receipt.archivedAt } : {}),
      });
    }
    const revision = await this.repository.getRevision(scope);
    const expectedRevision = expectedRevisionForCommand(envelope);
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      return commandResult(envelope, revision, 'conflict', {
        reason: `Expected revision ${expectedRevision}, current revision is ${revision}`,
      });
    }

    switch (envelope.command.type) {
      case 'chat.create_tab':
        return this.createTab(
          scope,
          envelope,
          false,
          options.canCommitCreate,
          options.preserveActiveTab,
        );
      case 'chat.create_file_tab':
        return this.createTab(scope, envelope, true);
      case 'chat.activate_tab':
        return this.activateTab(scope, envelope, envelope.command.tabId);
      case 'chat.reorder_tabs':
        return this.commit(scope, envelope, [
          { type: 'tab.order_changed', tabIds: envelope.command.tabIds },
        ]);
      case 'chat.patch_tab_settings':
        return this.patchTabSettings(scope, envelope, envelope.command);
      case 'chat.set_model':
        return this.setModel(scope, envelope);
      case 'chat.set_approval_mode':
        return this.setApprovalMode(scope, envelope, envelope.command);
      case 'chat.mark_read':
        return this.patchWholeTab(
          scope,
          envelope,
          envelope.command.chatId,
          (tab) => ({
            ...tab,
            unread: false,
            unreadMarkedManually: undefined,
          }),
        );
      case 'chat.mark_unread': {
        // An automatic mark replaces an earlier manual one, so a new reply
        // restores the reply preview.
        const manual = envelope.command.manual === true;
        return this.patchWholeTab(
          scope,
          envelope,
          envelope.command.chatId,
          (tab) => ({
            ...tab,
            unread: true,
            unreadMarkedManually: manual ? true : undefined,
            attentionDismissedAt: undefined,
          }),
        );
      }
      case 'chat.dismiss_attention':
        return this.patchWholeTab(
          scope,
          envelope,
          envelope.command.chatId,
          (tab) => ({
            ...tab,
            attentionDismissedAt: this.now(),
          }),
        );
      case 'chat.send_message':
        return this.sendMessage(scope, envelope, options);
      case 'chat.commit_terminal_initial_prompt':
        return this.commitTerminalInitialPrompt(scope, envelope);
      case 'chat.reject_plan_implementation_delivery': {
        const matched = await this.recordTerminalPlanImplementation(
          {
            ...scope,
            chatId: envelope.command.chatId,
            userMessageId: envelope.command.userMessageId,
          },
          'failed',
          { pendingOnly: true },
        );
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          matched ? 'applied' : 'already_applied',
        );
      }
      case 'chat.edit_queued_message':
      case 'chat.move_queued_message':
      case 'chat.cancel_queued_message':
      case 'chat.steer_queued_message':
      case 'chat.force_queued_message':
      case 'chat.set_queued_message_edit_lock':
        return this.queueCommand(scope, envelope);
      case 'chat.input_delivery_action':
        return this.inputDelivery.action(envelope);
      case 'chat.answer_question':
        return this.answerQuestion(scope, envelope, false, options);
      case 'chat.dismiss_question':
        return this.answerQuestion(scope, envelope, true, options);
      case 'chat.close_tab':
        return this.closeTab(
          scope,
          envelope,
          envelope.command.tabId,
          envelope.command.mode,
        );
      case 'chat.close_tabs':
        return this.closeTabs(scope, envelope, envelope.command);
      case 'chat.archive_tab':
        return this.closeTab(
          scope,
          envelope,
          envelope.command.tabId,
          'archive',
        );
      case 'chat.restore_archive':
        return this.restoreArchive(scope, envelope, envelope.command);
      case 'chat.mark_archive_read':
        return this.commit(scope, envelope, [
          {
            type: 'archive.read_state_changed',
            archiveEntryId: envelope.command.archiveEntryId,
            chatId: envelope.command.archiveEntryId,
            unread: envelope.command.unread,
          },
        ]);
      case 'chat.mark_all_archives_read':
        return this.markAllArchivesRead(scope, envelope);
      case 'chat.fork_tab':
        return this.forkTab(scope, envelope, envelope.command);
      case 'chat.reset_to_point':
        return this.resetToPoint(scope, envelope, envelope.command);
      case 'chat.set_scheduled_send_draft':
        return this.commitExistingTabCommand(
          scope,
          envelope,
          envelope.command.chatId,
          [
            {
              type: 'tab.metadata_patched',
              tabId: envelope.command.chatId,
              patch: {
                scheduledSendDraft: envelope.command.draft,
                ...(envelope.command.clearPendingRevertAttachment === true
                  ? { pendingRevertAttachmentPath: null }
                  : {}),
              },
            },
          ],
        );
      case 'chat.import_session':
        return this.importSession(scope, envelope, envelope.command);
    }
  }

  /** Records a rejected provider event without changing canonical admission. */
  private recordCanonicalAdmissionRejection(
    input: ProviderEventInput,
    reason: string,
    ownerTurnUserMessageId?: string,
  ): void {
    const data = isRecord(input.data) ? input.data : undefined;
    const eventTurnUserMessageId =
      typeof data?.canopy_turn_user_message_id === 'string'
        ? data.canopy_turn_user_message_id
        : input.turnUserMessageId;
    const turnUserMessageId =
      ownerTurnUserMessageId &&
      ownerTurnUserMessageId !== eventTurnUserMessageId
        ? ownerTurnUserMessageId
        : undefined;
    try {
      this.recordDiagnostic(
        chatEventDroppedDiagnostic({
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          chatId: input.chatId,
          ...(input.providerType ? { providerType: input.providerType } : {}),
          gate: 'canonical_admission_rejected',
          reason,
          data: input.data,
          ...(turnUserMessageId ? { turnUserMessageId } : {}),
        }),
      );
    } catch {
      // Diagnostics are best-effort and must never change provider admission.
    }
  }

  /** Stage one prepared visual through the trusted scope route. */
  public stageVisual(
    scope: ChatScopeKey,
    target: VisualStagingTarget,
    document: StageVisualDocument,
  ): Promise<VisualStagingSidecar> {
    return this.repository.stageVisual(scope, target, document);
  }

  /** Whether the provider event committed a canonical change. */
  public async ingestProviderEvent(
    input: ProviderEventInput,
  ): Promise<boolean> {
    return (await this.ingestProviderEventWithOutcome(input)) === 'applied';
  }

  public async ingestProviderEventWithOutcome(
    input: ProviderEventInput,
  ): Promise<ProviderEventIngestOutcome> {
    return (await this.ingestProviderEventWithResult(input)).outcome;
  }

  public async ingestProviderEventWithResult(
    providerInput: ProviderEventInput,
  ): Promise<ProviderEventIngestResult> {
    recordProviderEventIngested();
    const input = withCardOnlyDelegation(providerInput);
    const providerRunClassification = classifyProviderRunEvent(input.data, {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      chatId: input.chatId,
    });
    if (providerRunClassification.kind === 'reject') {
      this.recordCanonicalAdmissionRejection(
        input,
        providerRunClassification.reason,
      );
      return { outcome: 'not-applied' };
    }
    if (isRecord(input.data) && input.data.type === 'canopy_input_delivery') {
      const event = input.data;
      const startingPickup =
        event.phase === 'picked-up' && event.startsTurn === true;
      if (!isChatInputDeliveryEvent(event)) {
        this.recordCanonicalAdmissionRejection(
          input,
          'invalid_input_delivery_event',
        );
        return {
          outcome: 'not-applied',
          ...(startingPickup ? { pickup: 'rejected' } : {}),
        };
      }
      const { observed, pickup } = await this.inputDelivery.observeWithResult(
        input,
        withTrustedDeliveryFailure(event),
      );
      if (observed) {
        recordProviderEventApplied();
      } else {
        this.recordCanonicalAdmissionRejection(
          input,
          'input_delivery_not_observed',
        );
      }
      const outcome = observed ? 'applied' : 'not-applied';
      return {
        outcome,
        ...(startingPickup ? { pickup: pickup ?? 'rejected' } : {}),
      };
    }
    const data = isRecord(input.data) ? input.data : {};
    const delegation =
      data.type === 'canopy_delegation' && isRecord(data.delegation)
        ? data.delegation
        : undefined;
    const streamDelegation =
      delegation?.transcriptStore === DELEGATION_TRANSCRIPT_CHAT_STREAM;
    // Delegates can finish many parent turns later. Hydrate their own card
    // for sequence checks; a new run falls back to its retained parent turn.
    // This is only a read hint. The shared reducer still validates the whole
    // event once, including its transcript; do not walk that transcript twice.
    const messageAnchor =
      providerRunClassification.kind === 'transcript_only' &&
      providerRunClassification.run.item
        ? {
            messageId: `codex-${providerRunClassification.run.item.id}`,
            fallbackMessageId:
              providerRunClassification.run.executionUserMessageId,
          }
        : delegation &&
            typeof delegation.delegationId === 'string' &&
            typeof delegation.runGeneration === 'number' &&
            Number.isSafeInteger(delegation.runGeneration) &&
            delegation.runGeneration >= 1 &&
            typeof delegation.parentTurnId === 'string'
          ? {
              messageId: `delegated-agent-${delegation.delegationId}${delegation.runGeneration > 1 ? `-run-${delegation.runGeneration}` : ''}`,
              ...(streamDelegation
                ? {}
                : { fallbackMessageId: delegation.parentTurnId }),
              ...(!streamDelegation && delegation.runGeneration > 1
                ? {
                    previousRunMessageId: `delegated-agent-${delegation.delegationId}${delegation.runGeneration > 2 ? `-run-${delegation.runGeneration - 1}` : ''}`,
                  }
                : {}),
            }
          : undefined;
    const checkpoint =
      isRecord(input.data) &&
      (isTerminalChatEventData(input.data) ||
        input.data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE);
    const refreshCapabilities =
      (data.type === 'system' && data.subtype === 'init') ||
      data.type === 'result' ||
      data.type === 'canopy_user_prompt' ||
      data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE ||
      (data.type === 'codex' &&
        isRecord(data.event) &&
        ['turn.started', 'turn.completed', 'turn.failed'].includes(
          String(data.event.type),
        ));
    const scope = {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
    };
    let fullTranscript = false;
    if (
      data.type === 'canopy_user_prompt' &&
      !(await this.repository.hasMutation(scope, eventMutationId(input)))
    ) {
      const promptMessageId = data.canopy_turn_user_message_id;
      if (typeof promptMessageId === 'string') {
        const location = await this.repository.locateMessage(
          scope,
          input.chatId,
          promptMessageId,
        );
        if (typeof location === 'object' && !location.last) {
          fullTranscript = true;
        } else if (location === 'active') {
          const snapshot = await this.repository.getState(scope, {
            chatIds: [input.chatId],
          });
          const tab = snapshot.tabsFile.tabs.find(
            (candidate) => candidate.id === input.chatId,
          );
          const promptIndex =
            tab?.messages.findIndex(
              (message) => message.id === promptMessageId,
            ) ?? -1;
          fullTranscript =
            promptIndex >= 0 && promptIndex < (tab?.messages.length ?? 0) - 1;
        }
      }
    }
    const capabilities = refreshCapabilities
      ? await this.inputDelivery.capabilities(input)
      : undefined;
    const mutationId = eventMutationId(input);
    let emptyCompletionDiagnostic: SessionDiagnosticRecord | undefined;
    let activityOnly = false;
    let shouldResolveInputHistory = false;
    let canonicalAdmissionRejectionReason: string | undefined;
    let canonicalAdmissionOwnerTurnUserMessageId: string | undefined;
    let rootTerminalTurnId: string | undefined;
    let terminalAttributionAmbiguous = false;
    let abandonedTurns: string[] = [];
    let admissionTools: ToolOccurrenceAdmission[] = [];
    let admissionLimited = false;
    const commit = await this.transactWithTurnHandoff(
      input,
      async (current, _revision, context) => {
        const reduction = await this.reduceProviderEvent(
          current,
          input,
          mutationId,
          checkpoint,
          refreshCapabilities,
          capabilities,
          messageAnchor,
          streamDelegation,
          context,
        );
        activityOnly = reduction.activityOnly;
        admissionTools = reduction.admissionTools;
        admissionLimited = reduction.admissionLimited;
        shouldResolveInputHistory = reduction.shouldResolveInputHistory;
        canonicalAdmissionRejectionReason =
          reduction.canonicalAdmissionRejectionReason;
        canonicalAdmissionOwnerTurnUserMessageId =
          reduction.canonicalAdmissionOwnerTurnUserMessageId;
        emptyCompletionDiagnostic = reduction.emptyCompletionDiagnostic;
        rootTerminalTurnId = reduction.rootTerminalTurnId;
        terminalAttributionAmbiguous =
          reduction.terminalAttributionAmbiguous === true;
        abandonedTurns = reduction.abandonedTurns ?? [];
        return reduction.mutations;
      },
      {
        ...{
          source: input.source ?? 'provider',
          mutationId,
          checkpoint,
        },
        chatIds: [input.chatId],
        fullTranscript,
        ...(fullTranscript ? { rewriteReason: 'prompt_relocation' } : {}),
        ...(streamDelegation ? { rawStreamCards: true } : {}),
        ...(messageAnchor ? { messageAnchor } : {}),
        ...(input.onCommitQueued ? { onQueued: input.onCommitQueued } : {}),
      },
      isNativeVisualToolResultEvent(input)
        ? {
            resolveToolKey: visualResolverForEvent(
              input,
              this.claudeToolNames,
              this.codexToolNames,
              this.cursorToolUse,
            ),
          }
        : undefined,
    );
    // Fence later frames only once the terminal is durable (a failed write
    // throws above, so its retry is still admitted).
    if (rootTerminalTurnId !== undefined) {
      const key = JSON.stringify([
        input.projectId,
        input.worktreeId,
        input.chatId,
      ]);
      const reduced = this.reducedRootTerminals.get(key) ?? new Set<string>();
      reduced.add(rootTerminalTurnId);
      this.reducedRootTerminals.set(key, reduced);
    }
    if (commit.applied && terminalAttributionAmbiguous)
      logMainProcessWarn('[chat-state] Root terminal attribution ambiguous', {
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        chatId: input.chatId,
        mutationId,
      });
    if (commit.applied && emptyCompletionDiagnostic) {
      try {
        this.recordDiagnostic(emptyCompletionDiagnostic);
      } catch {
        // Diagnostics are best-effort and must never change provider ingestion.
      }
    }
    // Only the turn gate rejects; other unapplied commits are no-op events.
    if (!commit.applied && canonicalAdmissionRejectionReason !== undefined) {
      this.recordCanonicalAdmissionRejection(
        input,
        canonicalAdmissionRejectionReason,
        canonicalAdmissionOwnerTurnUserMessageId,
      );
    }
    if (commit.applied) {
      recordProviderEventApplied();
      if (admissionLimited) {
        try {
          logMainProcessWarn('Provider event admission mapping limit reached');
        } catch {
          /* Best effort, never change durable admission. */
        }
      }
      if (shouldResolveInputHistory)
        this.inputDelivery.scheduleHistoryResolution({
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          chatId: input.chatId,
        });
      if (delegation) recordDelegationSnapshot('admitted', delegation);
      for (const userMessageId of abandonedTurns) {
        this.deliverUnacceptedTurnEnd(
          { projectId: input.projectId, worktreeId: input.worktreeId },
          { chatId: input.chatId, userMessageId },
          'cancelled',
          'Interrupted by an app restart and not resumed.',
          { canopy_turn_abandoned: true },
        );
      }
      return {
        outcome: 'applied',
        ...(admissionTools.length > 0
          ? {
              admission: {
                projectId: input.projectId,
                worktreeId: input.worktreeId,
                chatId: input.chatId,
                mutationId,
                ...(input.turnUserMessageId !== undefined
                  ? { turnUserMessageId: input.turnUserMessageId }
                  : {}),
                revision: commit.revision,
                tools: admissionTools,
              },
            }
          : {}),
      };
    }
    return { outcome: activityOnly ? 'activity-only' : 'not-applied' };
  }

  private async reduceProviderEvent(
    current: Readonly<CanonicalChatState>,
    input: ProviderEventInput,
    mutationId: string,
    checkpoint: boolean,
    refreshCapabilities: boolean,
    capabilities: ChatSteeringCapabilities | undefined,
    messageAnchor: ChatReadSelection['messageAnchor'],
    streamDelegation: boolean,
    context: ChatStateTransactionContext,
  ): Promise<ProviderEventReduction> {
    let activityOnly = false;
    const admissionTools: ToolOccurrenceAdmission[] = [];
    let admissionLimited = false;
    let admissionBytes = 2; // JSON array brackets, plus separators below.
    let shouldResolveInputHistory = false;
    let canonicalAdmissionRejectionReason: string | undefined;
    let canonicalAdmissionOwnerTurnUserMessageId: string | undefined;
    let emptyCompletionDiagnostic: SessionDiagnosticRecord | undefined;
    let rootTerminalTurnId: string | undefined;
    let terminalAttributionAmbiguous = false;
    let abandonedTurns: string[] = [];
    const finish = (mutations: ChatCoreMutation[]): ProviderEventReduction => ({
      mutations,
      activityOnly,
      ...(canonicalAdmissionRejectionReason !== undefined
        ? { canonicalAdmissionRejectionReason }
        : {}),
      ...(canonicalAdmissionOwnerTurnUserMessageId !== undefined
        ? { canonicalAdmissionOwnerTurnUserMessageId }
        : {}),
      shouldResolveInputHistory,
      ...(emptyCompletionDiagnostic !== undefined
        ? { emptyCompletionDiagnostic }
        : {}),
      ...(rootTerminalTurnId !== undefined ? { rootTerminalTurnId } : {}),
      ...(terminalAttributionAmbiguous ? { terminalAttributionAmbiguous } : {}),
      ...(abandonedTurns.length > 0 ? { abandonedTurns } : {}),
      admissionTools,
      admissionLimited,
    });
    const data = isRecord(input.data) ? input.data : {};
    const delegation =
      data.type === 'canopy_delegation' && isRecord(data.delegation)
        ? data.delegation
        : undefined;
    const providerRunClassification = classifyProviderRunEvent(input.data, {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      chatId: input.chatId,
    });
    if (providerRunClassification.kind === 'reject') {
      canonicalAdmissionRejectionReason = providerRunClassification.reason;
      return finish([]);
    }
    if (providerRunClassification.kind === 'transcript_only') {
      const run = providerRunClassification.run;
      const item = run.item;
      const event = isRecord(data.event) ? data.event : undefined;
      const nativeItem = event && isRecord(event.item) ? event.item : undefined;
      if (
        !item ||
        !nativeItem ||
        typeof nativeItem.aggregated_output !== 'string'
      ) {
        canonicalAdmissionRejectionReason = 'late_command_identity_missing';
        return finish([]);
      }
      const lateMessageId = `codex-${item.id}`;
      if (
        messageAnchor?.messageId !== lateMessageId ||
        messageAnchor.fallbackMessageId !== run.executionUserMessageId
      ) {
        canonicalAdmissionRejectionReason = 'late_command_anchor_mismatch';
        return finish([]);
      }
      const liveTab = current.tabsFile.tabs.find(
        (candidate) => candidate.id === input.chatId,
      );
      const archivedCandidate = liveTab
        ? undefined
        : current.archivesFile.archived.find(
            (entry) =>
              entry.tab.id === input.chatId && entry.tab.autoArchive === true,
          );
      const tab = liveTab ?? archivedCandidate?.tab;
      if (!tab || tab.kind === 'file') {
        canonicalAdmissionRejectionReason = 'late_command_row_missing';
        return finish([]);
      }
      const row = tab.messages.find((message) => message.id === lateMessageId);
      if (!row) {
        canonicalAdmissionRejectionReason = 'late_command_row_missing';
        return finish([]);
      }
      if (
        row.codexThreadId !== run.threadId ||
        row.codexTurnId !== run.turnId
      ) {
        canonicalAdmissionRejectionReason = 'late_command_row_owner_mismatch';
        return finish([]);
      }
      const commandUses = row.blocks.filter(
        (block) =>
          block.type === 'tool_use' &&
          block.toolUseId === lateMessageId &&
          block.toolName === 'command',
      );
      if (commandUses.length !== 1) {
        canonicalAdmissionRejectionReason = 'late_command_tool_use_mismatch';
        return finish([]);
      }
      const matchingResultIndices: number[] = [];
      row.blocks.forEach((block, index) => {
        if (block.type === 'tool_result' && block.toolUseId === lateMessageId)
          matchingResultIndices.push(index);
      });
      if (matchingResultIndices.length > 1) {
        canonicalAdmissionRejectionReason = 'late_command_result_ambiguous';
        return finish([]);
      }
      const status = nativeItem.status;
      const exitCode = nativeItem.exit_code;
      const resultBlock: Extract<
        PersistedChatMessage['blocks'][number],
        { type: 'tool_result' }
      > = {
        type: 'tool_result',
        toolUseId: lateMessageId,
        toolName: 'command',
        // Same fallback as the shared parser's command_execution result.
        output:
          nativeItem.aggregated_output.length > 0
            ? nativeItem.aggregated_output
            : status === 'completed'
              ? 'Done'
              : typeof status === 'string'
                ? status
                : '',
        isError:
          status === 'failed' ||
          status === 'declined' ||
          (typeof exitCode === 'number' && exitCode !== 0),
      };
      const matchingResultIndex = matchingResultIndices[0];
      const blocks =
        matchingResultIndex === undefined
          ? [...row.blocks, resultBlock]
          : row.blocks.map((block, index) =>
              index === matchingResultIndex ? resultBlock : block,
            );
      const updatedRow: PersistedChatMessage = { ...row, blocks };
      if (isDeepStrictEqual(row, updatedRow)) return finish([]);
      if (archivedCandidate) {
        return finish([
          {
            type: 'archive.upserted',
            entry: {
              ...archivedCandidate,
              tab: {
                ...tab,
                messages: tab.messages.map((message) =>
                  message.id === row.id ? updatedRow : message,
                ),
              },
            },
          },
        ]);
      }
      return finish([
        {
          type: 'message.upserted',
          chatId: tab.id,
          message: updatedRow,
          afterMessageId: row.id,
        },
      ]);
    }
    let tab = current.tabsFile.tabs.find(
      (candidate) => candidate.id === input.chatId,
    );
    const archivedCandidate = tab
      ? undefined
      : current.archivesFile.archived.find(
          (entry) =>
            entry.tab.id === input.chatId && entry.tab.autoArchive === true,
        );
    // Canonically only a host prompt or a fresh start after the archive cutoff
    // restores the chat; content shape alone is replayable (contracts §5).
    const resumesArchive =
      archivedCandidate !== undefined &&
      shouldResumeAutoArchivedChat(data) &&
      (data.type === 'canopy_user_prompt' ||
        data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE ||
        isFreshArchivedStart(
          archivedCandidate,
          this.turnHandoff.getState({
            projectId: input.projectId,
            worktreeId: input.worktreeId,
            chatId: input.chatId,
          }),
        ));
    if (archivedCandidate) {
      tab = archivedCandidate.tab;
    }
    if (!tab || tab.kind === 'file') {
      throw new Error(`Provider event targets missing chat ${input.chatId}`);
    }
    // The own-card point lookup also hydrates paged-out/restarted cards.
    // Stream rows are immutable after creation, including in archives;
    // descriptor publication, not ingestion, owns their durable display.
    if (
      streamDelegation &&
      messageAnchor &&
      tab.messages.some(
        (message) =>
          message.id === messageAnchor.messageId &&
          message.blocks.some(
            (block) =>
              block.type === 'delegated_agent_call' &&
              block.transcriptStore === DELEGATION_TRANSCRIPT_CHAT_STREAM &&
              block.delegationId === delegation?.delegationId &&
              block.runGeneration === delegation?.runGeneration,
          ),
      )
    )
      return finish([]);
    const runtime = current.runtimeByChatId[input.chatId];
    const activeTurnUserMessageId = runtime?.activeTurn?.userMessageId;
    const providerTurnIsSettled =
      runtime !== undefined &&
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(
        runtime.status,
      ) &&
      !this.deliversReceiptTurnOutput(
        {
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          chatId: input.chatId,
        },
        runtime,
        tab,
      );
    // Only a current turn admits settled content (contracts §1): a revival
    // flag or an untagged continuation is not one.
    const startsOrAcknowledgesTurn =
      data.type === 'canopy_user_prompt' ||
      data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE;
    const reconcilesEmptyCompletion =
      runtime?.error?.code === 'empty_completion' &&
      activeTurnUserMessageId === input.turnUserMessageId;
    // Canonical binding can name a merged steer instead of the dispatch that
    // started the turn; a dispatch that still holds its owner is not stale,
    // and neither is the trailing output of the turn that just ended.
    const scope = {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      chatId: input.chatId,
    };
    const staleOwner =
      activeTurnUserMessageId !== undefined &&
      activeTurnUserMessageId !== input.turnUserMessageId &&
      !(
        getChatTurnOwnership()
          .getSnapshot(scope)
          .dispatchOwners.some(
            (owner) => owner.userMessageId === input.turnUserMessageId,
          ) ||
        (input.turnUserMessageId !== undefined &&
          this.trailingEndedTurn(
            scope,
            this.turnHandoff.getState(scope) ?? runtime?.turn,
            tab,
          )?.userMessageId === input.turnUserMessageId)
      );
    if (
      input.turnUserMessageId &&
      !startsOrAcknowledgesTurn &&
      !reconcilesEmptyCompletion &&
      !canFollowSettledProviderTurn(
        data,
        input.turnUserMessageId,
        activeTurnUserMessageId,
        tab.sdkSessionId,
        false,
      ) &&
      (staleOwner || providerTurnIsSettled)
    ) {
      canonicalAdmissionRejectionReason = staleOwner
        ? 'stale_turn_mismatch'
        : 'settled_turn_rejected';
      canonicalAdmissionOwnerTurnUserMessageId = activeTurnUserMessageId;
      return finish([]);
    }
    // Format 4 scopes only: stream a final Codex tool body into its
    // artifact here, under this transaction, so the reducer below never
    // builds the whole body. Absent port: unchanged legacy reduction.
    const transcriptFields = context.transcriptFields;
    const preparedCodexItem =
      transcriptFields && data.type === 'codex'
        ? await prepareCodexItemFields(
            transcriptFields,
            input.chatId,
            data.event,
          )
        : undefined;
    const onToolBlock: NonNullable<
      Parameters<typeof applyClaudeTranscriptEvent>[2]['onToolBlock']
    > = (sourceToken, row, blockOrdinal, previousMessages): void => {
      if (admissionLimited || row.blocksRef !== undefined) return;
      const block = row.blocks[blockOrdinal];
      if (block.type !== 'tool_use' && block.type !== 'tool_result') return;
      const address = { rowId: row.id, blockOrdinal };
      const pairing =
        block.type === 'tool_result'
          ? admittedResultCall(
              row,
              blockOrdinal,
              previousMessages,
              block.toolUseId,
            )
          : { authoritative: true, call: address };
      if (!pairing.authoritative) return;
      const anchor = pairing.call ?? address;
      const occurrenceId = portalToolOccurrenceId(
        anchor.rowId,
        anchor.blockOrdinal,
      );
      if (occurrenceId === undefined) return;
      const mapping: ToolOccurrenceAdmission = {
        sourceToken,
        occurrenceId,
        ...(pairing.call ? { call: pairing.call } : {}),
        ...(block.type === 'tool_result'
          ? {
              result: {
                ...address,
                needsRead:
                  preparedCodexItem?.output.needsRead === true ||
                  toolResultNeedsRead(block),
              },
            }
          : {}),
      };
      const bytes =
        Buffer.byteLength(JSON.stringify(mapping)) +
        (admissionTools.length === 0 ? 0 : 1);
      if (
        admissionTools.length >= PROVIDER_EVENT_ADMISSION_MAX_TOOLS ||
        admissionBytes + bytes > PROVIDER_EVENT_ADMISSION_MAX_BYTES
      ) {
        admissionLimited = true;
        return;
      }
      admissionBytes += bytes;
      admissionTools.push(mapping);
    };
    const now = this.now();
    const succession =
      data.type === 'canopy_user_prompt' &&
      typeof data.canopy_turn_user_message_id === 'string'
        ? succeedInterruptedTurns(
            tab.interruptedTurns,
            data.canopy_turn_user_message_id,
            data.canopy_resumes_interrupted_turn === true,
            typeof data.canopy_resumes_user_message_id === 'string'
              ? data.canopy_resumes_user_message_id
              : undefined,
          )
        : undefined;
    abandonedTurns = succession?.abandoned ?? [];
    const trustedTab = applyTrustedEventMetadata(tab, data, now);
    const eventTab =
      succession && succession.turns !== tab.interruptedTurns
        ? { ...trustedTab, interruptedTurns: succession.turns }
        : trustedTab;
    let base = transcriptState(eventTab, current.runtimeByChatId[input.chatId]);
    const existingPromptIndex = eventTab.messages.findIndex(
      (message) => message.id === data.canopy_turn_user_message_id,
    );
    const reordersExistingPrompt =
      data.type === 'canopy_user_prompt' &&
      existingPromptIndex >= 0 &&
      existingPromptIndex < eventTab.messages.length - 1;
    if (data.type === 'canopy_user_prompt') {
      base = {
        ...base,
        messages: mergePromptMessages(
          base.messages,
          data,
          (current.tabsFile.pendingQuestions ?? []).filter(
            (question) => question.chatId === input.chatId,
          ),
        ),
      };
    }
    let messageSequence = 0;
    const createMessageId = (): string =>
      `${input.chatId}:${mutationId}:${messageSequence++}`;
    const provider =
      input.providerType ??
      tab.providerType ??
      (tab.model ? getProviderForModel(tab.model) : 'claude');
    // Canonical turn state owns root timers and status; the parser folds content.
    const rootTurnOptions: { rootTurnMode: 'canonical-content-only' } = {
      rootTurnMode: 'canonical-content-only',
    };
    const reduced =
      data.type === 'claude_terminal_transcript_sync' &&
      Array.isArray(data.messages)
        ? {
            ...base,
            messages: mergePersistedMessagesById(
              base.messages,
              data.messages.filter(isPersistedChatMessage),
            ),
          }
        : data.type === 'codex' && isRecord(data.event)
          ? applyCodexTranscriptEvent(base, data.event, {
              now,
              onToolBlock,
              toolBlockCaptureLimit: PROVIDER_EVENT_ADMISSION_MAX_TOOLS + 1,
              createMessageId,
              aiCreditsRouted: tab.aiCreditsRouted,
              childToolLiveness: { kind: 'unknown' },
              ...rootTurnOptions,
              ...(transcriptFields
                ? { transcriptStorageFormat: transcriptFields.format }
                : {}),
              ...(preparedCodexItem ? { preparedCodexItem } : {}),
            })
          : applyClaudeTranscriptEvent(base, data, {
              now,
              onToolBlock,
              toolBlockCaptureLimit: PROVIDER_EVENT_ADMISSION_MAX_TOOLS + 1,
              createMessageId,
              aiCreditsRouted: tab.aiCreditsRouted,
              childToolLiveness: { kind: 'unknown' },
              ...rootTurnOptions,
            });
    const {
      status: _status,
      error: _error,
      currentTodos: _todos,
      currentTaskTodos: _taskTodos,
      lastEventAt: _lastEventAt,
      codexThreads: _codexThreads,
      messages: reducedMessages,
      ...persistedMetadata
    } = reduced;
    void _status;
    void _error;
    void _todos;
    void _taskTodos;
    void _lastEventAt;
    void _codexThreads;
    const trustedReducedMessages = preserveProviderVisualReferences(
      tab.messages,
      reducedMessages,
    );
    const stickyPlanReview =
      Boolean(eventTab.trackedPlanId) &&
      eventTab.trackedPlanReviewStatus === 'pending';
    const pendingPlanSource =
      eventTab.pendingPlanExit?.source ?? eventTab.trackedPlanSource;
    const codexRootThreadId =
      typeof persistedMetadata.sdkSessionId === 'string'
        ? persistedMetadata.sdkSessionId
        : tab.sdkSessionId;
    const effectiveTurnUserMessageId =
      input.turnUserMessageId ??
      (typeof data.canopy_turn_user_message_id === 'string'
        ? data.canopy_turn_user_message_id
        : runtime?.activeTurn?.userMessageId);
    const turnHasVisibleOutput = effectiveTurnUserMessageId
      ? hasVisibleTurnOutput(
          trustedReducedMessages,
          effectiveTurnUserMessageId,
          eventTab.turnDiffs?.[effectiveTurnUserMessageId],
        )
      : undefined;
    const clearPendingPlanExit =
      (isRootTerminalChatEventData(input.data, codexRootThreadId) &&
        !stickyPlanReview &&
        !isPlanProposal({
          ...eventTab.pendingPlanExit,
          source: pendingPlanSource,
        })) ||
      // A provider prompt that first writes an admitted send retires its
      // waiting request (CAN-5431). A replayed
      // prompt is already committed and leaves any newer request alone.
      (data.type === 'canopy_user_prompt' &&
        typeof data.canopy_turn_user_message_id === 'string' &&
        existingPromptIndex < 0 &&
        retiresSupersededPlanExit(eventTab));
    const metadataTab: PersistedChatTab = {
      ...eventTab,
      ...persistedMetadata,
      ...(hasPlaceholderChatTitle(eventTab.title)
        ? {
            title: terminalTranscriptTitle(data) ?? eventTab.title,
            automaticTitleState:
              eventTab.automaticTitleState === 'closed' ? 'closed' : 'pending',
          }
        : {}),
      providerType: reduced.providerType ?? provider,
      messages: eventTab.messages,
      ...(clearPendingPlanExit ? { pendingPlanExit: undefined } : {}),
      ...(clearPendingPlanExit ? { pendingPlanExitRequestId: undefined } : {}),
    };
    // Init publishes the child's own session id. Consume the one-shot
    // source cutoff in that same durable commit: compatibility callbacks
    // run after ingestion and can already see the new id, so they cannot
    // reliably distinguish a pending fork from an initialized child.
    if (
      data.type === 'system' &&
      data.subtype === 'init' &&
      typeof data.session_id === 'string' &&
      data.session_id.length > 0 &&
      metadataTab.claudeForkSessionOnNextSend === true
    ) {
      delete metadataTab.claudeForkSessionOnNextSend;
      if (metadataTab.forkedFrom?.resumePointRequired === true) {
        metadataTab.forkedFrom = { ...metadataTab.forkedFrom };
        delete metadataTab.forkedFrom.resumePointRequired;
      }
    }
    // Output from the active provider advances the conversation past what
    // every parked session holds, including a hidden continuation that adds
    // no user turn, so none of them can be resumed any more (CAN-6445).
    if (metadataTab.providerSessions !== undefined && turnHasVisibleOutput) {
      delete metadataTab.providerSessions;
    }
    const currentRuntime = current.runtimeByChatId[tab.id];
    const reducedRuntime = runtimeForEvent(
      currentRuntime,
      input.data,
      now,
      input.turnUserMessageId,
      codexRootThreadId,
      turnHasVisibleOutput,
    );
    const eventRuntime: ChatRuntimeState =
      reducedRuntime.turn === undefined && currentRuntime?.turn !== undefined
        ? { ...reducedRuntime, turn: currentRuntime.turn }
        : reducedRuntime;
    const nextRuntime = this.projectReceiptRuntime(
      {
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        chatId: tab.id,
      },
      eventRuntime,
    );
    const turnEnds = reclassifyEmptyCompletionEnd(
      metadataTab.turnEnds,
      currentRuntime,
      nextRuntime,
      effectiveTurnUserMessageId,
    );
    if (turnEnds !== metadataTab.turnEnds) metadataTab.turnEnds = turnEnds;
    // The auto-archive marker belongs to one turn (CAN-6014): the event's own
    // turn when its agent sets it, else the one running now.
    const liveTurn =
      this.turnHandoff.getState({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        chatId: tab.id,
      }) ?? currentRuntime?.turn;
    const turnOf = (userMessageId: string | undefined): string | undefined =>
      userMessageId === undefined
        ? undefined
        : [liveTurn?.current, liveTurn?.lastEnded].find(
            (record) => record?.userMessageId === userMessageId,
          )?.id;
    if (
      metadataTab.autoArchive !== tab.autoArchive ||
      isSetAutoArchiveRequestedEventData(input.data)
    ) {
      const owner =
        metadataTab.autoArchive === true
          ? (turnOf(effectiveTurnUserMessageId) ?? liveTurn?.current?.id)
          : undefined;
      if (owner === undefined) delete metadataTab.autoArchiveTurnId;
      else metadataTab.autoArchiveTurnId = owner;
    }
    // An empty completion fails its turn, so it drops that turn's marker like
    // any other failed turn.
    if (
      nextRuntime.error?.code === 'empty_completion' &&
      currentRuntime?.error?.code !== 'empty_completion' &&
      metadataTab.autoArchiveTurnId !== undefined &&
      metadataTab.autoArchiveTurnId ===
        turnOf(nextRuntime.emptyCompletionRecovery?.turnUserMessageId)
    ) {
      delete metadataTab.autoArchive;
      delete metadataTab.autoArchiveTurnId;
    }
    if (isRootTerminalChatEventData(input.data, codexRootThreadId)) {
      const scope = {
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        chatId: tab.id,
      };
      const receipt = this.turnHandoff.getState(scope);
      const history = this.turnHandoff.snapshotNow(scope)?.turnRecords ?? [];
      const candidates = new Map<
        string,
        { inputIds: Set<string>; complete: boolean; autonomous: boolean }
      >();
      const retain = (
        turnId: string,
        inputIds: readonly string[] = [],
        complete = false,
        autonomous = false,
      ): void => {
        const candidate = candidates.get(turnId) ?? {
          inputIds: new Set<string>(),
          complete: false,
          autonomous: false,
        };
        for (const id of inputIds) candidate.inputIds.add(id);
        candidate.complete ||= complete;
        candidate.autonomous ||= autonomous;
        candidates.set(turnId, candidate);
      };
      for (const id of [
        ...(runtime?.turn?.endedTurnIds ?? []),
        ...(receipt?.endedTurnIds ?? []),
      ])
        retain(id);
      for (const [id, inputIds] of Object.entries(tab.rootTurnInputIds ?? {}))
        retain(id, inputIds, true);
      for (const turn of [
        runtime?.turn?.current,
        runtime?.turn?.lastEnded,
        ...Array.from(
          this.retainedTerminalTurns
            .get(
              JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]),
            )
            ?.values() ?? [],
        ),
        ...history,
        receipt?.current,
        receipt?.lastEnded,
      ])
        if (turn)
          retain(
            turn.id,
            [
              ...(turn.userMessageId ? [turn.userMessageId] : []),
              ...(turn.inputIds ?? []),
            ],
            turn.inputIds !== undefined || turn.userMessageId === undefined,
            turn.origin === 'autonomous',
          );
      const taggedInputId =
        input.turnUserMessageId ??
        (typeof data.canopy_turn_user_message_id === 'string'
          ? data.canopy_turn_user_message_id
          : undefined);
      const executionId =
        typeof data.canopy_execution_turn_id === 'string'
          ? data.canopy_execution_turn_id
          : typeof data.canopy_wake_turn_id === 'string'
            ? data.canopy_wake_turn_id
            : undefined;
      const matches =
        taggedInputId === undefined
          ? []
          : Array.from(candidates).filter(([, candidate]) =>
              candidate.inputIds.has(taggedInputId),
            );
      if (executionId !== undefined) {
        const candidate = candidates.get(executionId);
        // An autonomous or unbound execution's tag is only the anchor it ran
        // under (a Codex provider-owned run's), so its marker decides.
        if (
          candidate !== undefined &&
          (taggedInputId === undefined ||
            candidate.inputIds.has(taggedInputId) ||
            candidate.autonomous ||
            candidate.inputIds.size === 0 ||
            !candidate.complete)
        )
          rootTerminalTurnId = executionId;
        else terminalAttributionAmbiguous = candidates.size > 0;
      } else if (taggedInputId !== undefined) {
        // A complete owner's recorded inputs prove the match; candidates with
        // unknown inputs (turns from before input retention) then can't take it.
        if (
          matches.length === 1 &&
          (matches[0]?.[1].complete === true ||
            !Array.from(candidates).some(
              ([turnId, candidate]) =>
                turnId !== matches[0]?.[0] && !candidate.complete,
            ))
        )
          rootTerminalTurnId = matches[0]?.[0];
        else terminalAttributionAmbiguous = candidates.size > 0;
      } else if (candidates.size === 1) {
        rootTerminalTurnId = candidates.keys().next().value;
      } else {
        terminalAttributionAmbiguous = candidates.size > 1;
      }
      if (rootTerminalTurnId !== undefined)
        metadataTab.reducedRootTerminalTurnIds = Array.from(
          new Set([
            ...(metadataTab.reducedRootTerminalTurnIds ?? []),
            rootTerminalTurnId,
          ]),
        );
      // A turn that failed before its provider started it has no canonical
      // turn to record its end, so its terminal records it, as develop did.
      if (
        effectiveTurnUserMessageId !== undefined &&
        recordedTurnEnd(metadataTab.turnEnds, effectiveTurnUserMessageId) ===
          undefined &&
        receipt?.current?.userMessageId !== effectiveTurnUserMessageId &&
        receipt?.lastEnded?.userMessageId !== effectiveTurnUserMessageId
      )
        metadataTab.turnEnds = settleTurnEnds(
          metadataTab.turnEnds,
          currentRuntime,
          nextRuntime,
          effectiveTurnUserMessageId,
          now,
        );
    }
    // The shared reducer reopens a settled turn's timer in place; main
    // never commits that edit to settled history (see the guard).
    const mayRecoverInterruptedTurn =
      runtime?.status === 'interrupted' ||
      (effectiveTurnUserMessageId !== undefined &&
        tab.interruptedTurns?.[effectiveTurnUserMessageId] !== undefined) ||
      archivedCandidate !== undefined;
    const messages = preserveSettledTurnTimers({
      previous: tab.messages,
      next: mayRecoverInterruptedTurn
        ? supersedeToolInterruptions(trustedReducedMessages)
        : trustedReducedMessages,
      previousRuntime: runtime,
      nextRuntime,
      now,
      createMessageId,
    });
    if (
      isInputLedger(metadataTab.inputDelivery) &&
      isRootTerminalChatEventData(input.data, codexRootThreadId)
    ) {
      const previousInputDelivery = metadataTab.inputDelivery;
      const nextInputDelivery = settleInputExecution(
        previousInputDelivery,
        input.turnUserMessageId ?? activeTurnUserMessageId,
        nextRuntime.status,
        now,
      );
      metadataTab.inputDelivery = nextInputDelivery;
      shouldResolveInputHistory =
        nextInputDelivery !== previousInputDelivery ||
        nextInputDelivery.rows.some((row) => isHistoryCandidate(row));
    }
    if (archivedCandidate && !resumesArchive) {
      const updatedArchivedTab = { ...metadataTab, messages };
      return finish([
        {
          type: 'archive.upserted',
          entry: {
            ...archivedCandidate,
            tab: updatedArchivedTab,
            turnCount: countTurns(updatedArchivedTab),
          },
        },
      ]);
    }
    const mutations: ChatCoreMutation[] = archivedCandidate
      ? [
          {
            type: 'archive.removed',
            archiveEntryId: archivedCandidate.tab.id,
            chatId: archivedCandidate.tab.id,
          },
          { type: 'tab.created', tab: archivedCandidate.tab },
        ]
      : [];
    const metadataPatch = buildTabMetadataPatch(tab, metadataTab);
    if (Object.keys(metadataPatch).length > 0) {
      mutations.push({
        type: 'tab.metadata_patched',
        tabId: tab.id,
        patch: metadataPatch,
      });
    }
    if (reordersExistingPrompt) {
      mutations.push({
        type: 'messages.replaced',
        chatId: tab.id,
        messages,
        removedMessageIds: [],
      });
    }
    const nextById = new Map(messages.map((message) => [message.id, message]));
    const currentById = new Map(
      tab.messages.map((message) => [message.id, message]),
    );
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) continue;
      const existing = currentById.get(message.id);
      if (
        !existing ||
        (existing !== message &&
          JSON.stringify(existing) !== JSON.stringify(message))
      ) {
        // A delegation card and its rows can update after this window or
        // a renderer page has moved on. Position them so neither storage
        // nor a client appends them to the tail. Storage ignores the
        // position for rows it already holds.
        const afterMessageId =
          !streamDelegation &&
          messageAnchor !== undefined &&
          (message.id === messageAnchor.messageId ||
            message.parentBlockId === messageAnchor.messageId)
            ? existing
              ? (messages[index - 1]?.id ?? messageAnchor.fallbackMessageId)
              : index > 0 &&
                  messages
                    .slice(index + 1)
                    .some((later) => currentById.has(later.id))
                ? messages[index - 1]?.id
                : undefined
            : undefined;
        mutations.push({
          type: 'message.upserted',
          chatId: tab.id,
          message,
          ...(afterMessageId ? { afterMessageId } : {}),
        });
        if (
          !message.parentBlockId &&
          (!message.codexThreadId ||
            message.codexThreadId === codexRootThreadId)
        ) {
          for (const block of message.blocks) {
            if (block.type !== 'text' || !block.asyncQuestion) continue;
            const { requestId, questions } = block.asyncQuestion;
            // Started/completed/replayed events share one durable request.
            // Settled records are deliberately retained so replay cannot
            // make a previously answered or dismissed question actionable.
            if (
              (current.tabsFile.pendingQuestions ?? []).some(
                (question) =>
                  question.requestId === requestId &&
                  question.chatId === tab.id,
              )
            )
              continue;
            mutations.push({
              type: 'pending_question.upserted',
              question: {
                requestId,
                chatId: tab.id,
                delivery: 'async',
                questions: questions.map((question, index) => ({
                  id: String(index),
                  question: question.title,
                  options: question.options ?? [],
                  multiSelect: false,
                  allowOther: true,
                })),
              },
            });
          }
        }
      }
    }
    for (const existing of tab.messages) {
      if (!nextById.has(existing.id)) {
        mutations.push({
          type: 'message.removed',
          chatId: tab.id,
          messageId: existing.id,
        });
      }
    }
    if (
      nextRuntime.error?.code === 'empty_completion' &&
      nextRuntime.emptyCompletionRecovery &&
      runtime?.error?.code !== 'empty_completion'
    ) {
      emptyCompletionDiagnostic = {
        version: 1,
        timestamp: new Date(now).toISOString(),
        kind: 'empty_turn_completion',
        sessionKey: `${input.projectId}/${input.worktreeId}/${input.chatId}`,
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        chatId: input.chatId,
        providerType: provider ?? 'unknown',
        emptyCompletionTurnUserMessageId:
          nextRuntime.emptyCompletionRecovery.turnUserMessageId,
        ...(typeof data.duration_ms === 'number'
          ? { emptyCompletionDurationMs: data.duration_ms }
          : {}),
      };
    }
    const runtimePatch: ChatRuntimeState = {
      ...nextRuntime,
      ...(refreshCapabilities ? { steeringCapabilities: capabilities } : {}),
    };
    // Every commit journals and rewrites the scope indexes, so an event
    // whose only change is a fresher lastActivityAt is not committed; the
    // next other commit, or the persist interval, carries it. Turn-boundary
    // events always commit: their mutation IDs record prompt acceptance.
    if (
      mutations.length === 0 &&
      !checkpoint &&
      !refreshCapabilities &&
      isRecentActivityOnlyRuntime(runtime, runtimePatch, now)
    ) {
      activityOnly = true;
      return finish(mutations);
    }
    mutations.push({
      type: 'runtime.patched',
      chatId: tab.id,
      runtime: runtimePatch,
    });
    return finish(mutations);
  }

  /**
   * Bridge the legacy desktop send channel into main-owned state.
   *
   * A renderer can create a tab and immediately send before its revisioned
   * create command or compatibility snapshot reaches main. Provider ingestion
   * must never race that propagation. The repository-side conditional makes
   * this compare-and-create atomic with a concurrent canonical create and
   * preserves whichever writer established the tab first.
   */
  public async ensureChatForTrustedSend(
    request: ChatSendMessageRequest,
  ): Promise<void> {
    const scope = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
    };
    if (this.isScopeDeletionBlocking(chatScopeLifecycleKey(scope))) {
      throw new ChatScopeDeletingError();
    }
    const createdAt = new Date(this.now()).toISOString();
    const explicitTitle = explicitChatTitle(request.title);
    const title = explicitTitle ?? initialChatTitle(request.text);
    // An agent action may pin the fresh chat to one of its model's chat
    // harness options, as the pickers do for an empty tab; the send that
    // follows then captures that harness. Every other trusted sender echoes
    // the harness main already resolved for the chat (the advisor, the
    // renderer, the Portal), which is no choice and pins nothing. The choice
    // is checked only when the tab is created below: a send to an existing
    // chat keeps whatever harness that chat captured, whatever the current
    // catalog says.
    const explicitHarness =
      request.executionHarnessChoice === true
        ? request.executionHarness
        : undefined;
    const tab: PersistedChatTab = {
      ...createPersistedChatTab({
        id: request.chatId,
        createdAt,
        title,
        ...(request.providerType ? { providerType: request.providerType } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...canonicalModelConfigField(request.modelConfig),
        ...(request.planMode ? { planMode: true } : {}),
        ...(request.codexProposalMode
          ? { proposalMode: request.codexProposalMode }
          : {}),
        ...(typeof request.deferredToolsAllowed === 'boolean'
          ? { deferredToolsAllowed: request.deferredToolsAllowed }
          : {}),
        ...(request.interfaceMode
          ? { interfaceMode: request.interfaceMode }
          : {}),
        ...(request.selectedRepoId
          ? { selectedRepoId: request.selectedRepoId }
          : {}),
      }),
      ...(explicitTitle ? { customTitle: explicitTitle } : {}),
      ...(explicitHarness !== undefined
        ? {
            executionHarness: explicitHarness,
            executionHarnessExplicitlyChosen: true,
          }
        : {}),
      ...(request.approvalMode ? { approvalMode: request.approvalMode } : {}),
      ...trustedSendDenyRulesField(request.sessionApprovalRules),
      ...(request.pluginSelections
        ? { pluginSelections: request.pluginSelections }
        : {}),
      automaticTitleState: explicitTitle ? 'closed' : 'pending',
      ...newChatPluginDefaultsStamp(request.projectId),
      ...(request.sdkSessionId ? { sdkSessionId: request.sdkSessionId } : {}),
      ...(request.codexReconstructionSeedId
        ? { codexReconstructionSeedId: request.codexReconstructionSeedId }
        : {}),
      ...(request.pendingSystemInstructions?.length
        ? { pendingSystemInstructions: request.pendingSystemInstructions }
        : {}),
      ...(request.aiCreditsRouting
        ? { aiCreditsRouting: request.aiCreditsRouting }
        : {}),
      ...(request.subscriptionBillingOverride
        ? { subscriptionBillingOverride: true }
        : {}),
    };
    await this.repository.transactWith(
      scope,
      (current, _revision, context) => {
        const existing = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        if (!existing) {
          if (context.hasRemovedTab(request.chatId)) {
            throw new Error(
              `Trusted send targets removed chat ${request.chatId}`,
            );
          }
          // An explicit harness on a fresh tab must be one its model offers
          // a chat; anything else fails closed before the tab exists.
          if (
            explicitHarness !== undefined &&
            (request.model === undefined ||
              !supportsChatHarnessChoice(request.model, explicitHarness))
          )
            throw new Error(
              `Model "${request.model ?? ''}" does not run on the "${explicitHarness}" execution harness.`,
            );
          // Chats nobody asked for open behind the tab the user is on:
          // hook-started chats and sends that ask to stay behind (scheduled
          // and catch-up automation runs). Everything the user set in motion
          // comes forward as before: a Run now, a pipeline Run, a delegate,
          // the usage-limit, auth-failure, and transient-error retries, and
          // the Pull or Commit & Push resolution chat. Only a brand-new chat
          // is affected, and only while the current active tab still
          // exists; an empty scope still selects the new chat.
          const keepActiveTab =
            (request.preserveActiveTab === true ||
              request.initiationSource === 'hook') &&
            current.tabsFile.tabs.some(
              (candidate) => candidate.id === current.tabsFile.activeTabId,
            );
          return [
            { type: 'tab.created' as const, tab },
            ...(keepActiveTab
              ? []
              : [
                  {
                    type: 'tab.active_changed' as const,
                    activeTabId: request.chatId,
                  },
                ]),
          ];
        }
        const retitle =
          existing.messages.length === 0 &&
          hasPlaceholderChatTitle(existing.title) &&
          existing.title !== title;
        const name =
          explicitTitle !== undefined &&
          existing.messages.length === 0 &&
          existing.customTitle === undefined;
        const requestHarness =
          request.executionHarness ??
          (request.model
            ? getExecutionHarnessForModel(request.model)
            : undefined);
        // Advisor hydration can change an empty tab's default before its first
        // dispatch. Commit that route before the prompt makes it a chat lock.
        const synchronizeAdvisorRouting =
          request.projectId === APP_ADVISOR_PROJECT_ID &&
          (existing.transcript?.messageCount ?? existing.messages.length) ===
            0 &&
          existing.executionHarnessExplicitlyChosen !== true;
        const backfillRouting =
          request.model !== undefined &&
          requestHarness !== undefined &&
          (synchronizeAdvisorRouting ||
            (existing.model === undefined &&
              (existing.executionHarness === undefined ||
                existing.executionHarness === requestHarness)));
        // A send never saves its approval mode onto an existing chat: the
        // chat's own setting or its defaults stay its authority (CAN-4469).
        if (retitle || name || backfillRouting) {
          return [
            {
              type: 'tab.created' as const,
              tab: {
                ...existing,
                ...(retitle ? { title } : {}),
                ...(name ? { customTitle: explicitTitle } : {}),
                ...(retitle || name
                  ? {
                      // An explicit title is a saved name and closes naming,
                      // like a rename; a placeholder stays eligible.
                      automaticTitleState:
                        explicitTitle !== undefined ||
                        existing.automaticTitleState === 'closed'
                          ? ('closed' as const)
                          : ('pending' as const),
                    }
                  : {}),
                ...(backfillRouting ? { model: request.model } : {}),
                ...(backfillRouting && request.providerType
                  ? { providerType: request.providerType }
                  : {}),
                ...(backfillRouting &&
                (synchronizeAdvisorRouting ||
                  existing.executionHarness === undefined)
                  ? { executionHarness: requestHarness }
                  : {}),
                ...(backfillRouting
                  ? canonicalModelConfigField(request.modelConfig)
                  : {}),
              },
            },
          ];
        }
        return [];
      },
      {
        ...{
          source: 'migration',
          mutationId: `trusted-send-tab:${request.chatId}`,
        },
        chatIds: [request.chatId],
      },
    );
    await this.commitAutomationStartBanner(scope, request);
  }

  /**
   * Create a hook-started chat behind the active tab without replacing a stored
   * chat or recreating an archived or removed one (CAN-4138).
   */
  public async createHookChat(
    scope: ChatScopeKey,
    tab: PersistedChatTab,
  ): Promise<HookChatCreateOutcome> {
    if (this.isScopeDeletionBlocking(chatScopeLifecycleKey(scope)))
      throw new ChatScopeDeletingError();
    let outcome: HookChatCreateOutcome = 'created';
    const commit = await this.repository.transactWith(
      scope,
      (current, _revision, context) => {
        outcome = 'created';
        if (
          current.tabsFile.tabs.some((candidate) => candidate.id === tab.id)
        ) {
          outcome = 'already_exists';
          return [];
        }
        if (
          current.archivesFile.archived.some(
            (entry) => entry.tab.id === tab.id,
          ) ||
          context.hasRemovedTab(tab.id)
        ) {
          outcome = 'removed';
          return [];
        }
        const keepActiveTab = current.tabsFile.tabs.some(
          (candidate) => candidate.id === current.tabsFile.activeTabId,
        );
        return [
          { type: 'tab.created' as const, tab },
          ...(keepActiveTab
            ? []
            : [{ type: 'tab.active_changed' as const, activeTabId: tab.id }]),
        ];
      },
      {
        source: 'hook',
        mutationId: `hook-chat:${tab.id}:created`,
        chatIds: [tab.id],
      },
    );
    if (!commit.applied)
      return commit.state.tabsFile.tabs.some(
        (candidate) => candidate.id === tab.id,
      )
        ? 'already_exists'
        : 'removed';
    return outcome;
  }

  /**
   * Commits the automation banner (automation name and launch time) directly
   * ahead of an automation-initiated prompt. Renderer-driven sends (App
   * Advisor quick prompts, Cowork IPC sends, local worktree drains) persist
   * only their user message, so without this the banner existed only as the
   * renderer's optimistic copy and vanished on the canonical projection.
   *
   * The banner id is derived from the prompt's user-message id: when a main
   * send path already wrote it, or a retried trusted send committed it, it is
   * left exactly as it is, so its position and timestamp never change. A
   * prompt that is already in the transcript gets no retroactive banner.
   */
  private async commitAutomationStartBanner(
    scope: ChatScopeKey,
    request: ChatSendMessageRequest,
  ): Promise<void> {
    if (request.initiationSource !== 'automation') return;
    const bannerId = automationInfoMessageId(request.userMessageId);
    await this.repository.transactWith(
      scope,
      (current, _revision, context) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        if (!tab || context.hasRemovedMessage(bannerId)) return [];
        if (
          tab.messages.some(
            (message) =>
              message.id === bannerId || message.id === request.userMessageId,
          )
        )
          return [];
        const banner = buildAutomationInfoMessage(
          request,
          request.userMessageId,
        );
        return banner
          ? [
              {
                type: 'message.upserted' as const,
                chatId: request.chatId,
                message: banner,
              },
            ]
          : [];
      },
      {
        source: 'automation',
        mutationId: `${request.chatId}:${request.userMessageId}:automation-info`,
        chatIds: [request.chatId],
      },
    );
  }

  public async upsertPendingQuestion(
    scope: ChatScopeKey,
    question: PersistedPendingQuestion,
  ): Promise<void> {
    await this.transactWithTurnHandoff(
      scope,
      (current) => [
        { type: 'pending_question.upserted', question },
        {
          type: 'runtime.patched',
          chatId: question.chatId,
          // A question pauses the turn: its queued input and active turn stay.
          runtime: {
            ...(current.runtimeByChatId[question.chatId] ?? {
              queuedMessageIds: [],
            }),
            status: 'awaiting_input',
            lastActivityAt: this.now(),
          },
        },
      ],
      {
        source: 'provider',
        mutationId: `question:${question.requestId}`,
        chatIds: [question.chatId],
      },
    );
    this.pendingQuestionScopes.set(question.requestId, {
      ...scope,
      chatId: question.chatId,
    });
  }

  public async consumePendingQuestion(
    scope: ChatScopeKey,
    chatId: string,
    requestId: string,
  ): Promise<void> {
    const state = await this.repository.getState(scope);
    const question = (state.tabsFile.pendingQuestions ?? []).find(
      (candidate) =>
        candidate.requestId === requestId && candidate.chatId === chatId,
    );
    if (!question) {
      this.observeTurnPause({
        ...scope,
        chatId,
        type: 'PauseClosed',
        ownerKind: 'question',
        ownerId: requestId,
        atMs: this.now(),
      });
      const pause = await this.turnHandoff.prepare({ ...scope, chatId });
      if (pause) {
        await this.transactWithTurnHandoff(scope, () => [], {
          source: 'provider',
          mutationId: `question-pause-close:${chatId}:${requestId}:${pause.generation}`,
          chatIds: [chatId],
        });
      }
      this.pendingQuestionScopes.delete(requestId);
      clearAskUserRequestCancellation(requestId);
      return;
    }
    if (question.delivery !== 'async') {
      this.observeTurnPause({
        ...scope,
        chatId,
        type: 'PauseClosed',
        ownerKind: 'question',
        ownerId: requestId,
        atMs: this.now(),
      });
    }
    const previousRuntime = state.runtimeByChatId[chatId] ?? {
      status: 'streaming' as const,
      queuedMessageIds: [],
    };
    await this.transactWithTurnHandoff(
      scope,
      () => [
        // Answered records are retained: portal answered-question bubbles and
        // reload idempotence project from the committed `answeredAt` state.
        // Only an unanswered consume (timeout/cancel/abort) removes the record.
        ...(question.answeredAt === undefined
          ? [{ type: 'pending_question.removed', requestId, chatId } as const]
          : []),
        {
          type: 'runtime.patched',
          chatId,
          runtime: {
            ...previousRuntime,
            status:
              previousRuntime.status === 'awaiting_input'
                ? 'streaming'
                : previousRuntime.status,
            lastActivityAt: this.now(),
          },
        },
      ],
      {
        source: 'provider',
        mutationId: `question-consumed:${requestId}`,
        chatIds: [chatId],
      },
    );
    this.pendingQuestionScopes.delete(requestId);
  }

  public async answerPendingQuestion(
    requestId: string,
    answers: readonly McpQuestionAnswer[],
    dismiss = false,
  ): Promise<boolean> {
    const target = this.pendingQuestionScopes.get(requestId);
    if (!target) return false;
    const result = await this.command({
      schemaVersion: 1,
      commandId: this.createId(),
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      command: dismiss
        ? {
            type: 'chat.dismiss_question',
            chatId: target.chatId,
            questionId: requestId,
          }
        : {
            type: 'chat.answer_question',
            chatId: target.chatId,
            questionId: requestId,
            answers: [...answers],
          },
    });
    if (dismiss && result.outcome === 'applied') {
      this.pendingQuestionScopes.delete(requestId);
    }
    return result.outcome === 'applied' || result.outcome === 'already_applied';
  }

  /** Durable correlation before a trusted tool input crosses to a managed terminal. */
  public async retainTrustedTerminalInput(
    request: ChatSendMessageRequest,
  ): Promise<void> {
    await revalidateAgentSenderRequest(request);
    if (
      !request.agentSenderProvenance ||
      request.agentSenderProvenance.acceptedInputId !== request.userMessageId
    ) {
      throw new Error('Missing trusted terminal input provenance');
    }
    // The retained inputDelivery row is the terminal path's actual host-held queue record.
    const acceptance = {
      acceptedInputId: request.userMessageId,
      disposition: 'queued' as const,
      queuedMessageId: request.userMessageId,
      acceptedAt: new Date(this.now()).toISOString(),
    };
    const receipt = agentSendAcceptanceReceipt(request, acceptance);
    await this.repository.transactWith(
      request,
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        if (!tab || tab.readOnly)
          throw new Error('Terminal chat is no longer available');
        if (tab.inputDelivery && !isInputLedger(tab.inputDelivery))
          throw new Error('Unsupported message history version');
        const ledger = tab.inputDelivery ?? {
          version: 1 as const,
          epoch: 0,
          rows: [],
        };
        const previous = ledger.rows.find(
          (row) => row.id === request.userMessageId,
        );
        if (previous) {
          if (
            previous.payload.text !== request.text ||
            JSON.stringify(previous.payload.agentSenderProvenance) !==
              JSON.stringify(request.agentSenderProvenance) ||
            JSON.stringify(previous.payload.agentSent) !==
              JSON.stringify(request.agentSent)
          )
            throw new Error('Terminal input correlation conflict');
          if (
            previous.attempts.some(
              (attempt) => attempt.generation === 'managed-terminal',
            )
          )
            return [];
          if (
            previous.state !== 'queued' ||
            !previous.payload.agentSent ||
            previous.payload.agentSenderProvenance?.acceptedInputId !==
              request.userMessageId
          )
            throw new Error(
              'Terminal input is no longer available for handoff',
            );
        }
        const retained: InputRow = {
          id: request.userMessageId,
          revision: (previous?.revision ?? 0) + 1,
          createdAt: previous?.createdAt ?? this.now(),
          state: 'sending',
          text: request.text,
          payload: structuredClone({
            ...request,
            ...(previous
              ? {
                  agentSent: previous.payload.agentSent,
                  agentSenderProvenance: previous.payload.agentSenderProvenance,
                  hiddenContext: previous.payload.hiddenContext,
                }
              : {}),
            pendingSystemInstructions:
              request.pendingSystemInstructions ??
              tab.pendingSystemInstructions,
          }),
          settingsKey: inputSettingsKey(tab),
          currentAttemptId: request.userMessageId,
          attempts: [
            ...(previous?.attempts ?? []),
            {
              id: request.userMessageId,
              generation: 'managed-terminal',
              provider: 'claude',
              createdAt: this.now(),
            },
          ],
        };
        return [
          {
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              inputDelivery: {
                ...ledger,
                rows: previous
                  ? ledger.rows.map((row) =>
                      row.id === retained.id ? retained : row,
                    )
                  : [...ledger.rows, retained],
              },
            },
          },
        ];
      },
      {
        source: 'provider',
        chatIds: [request.chatId],
        ...(receipt
          ? {
              mutationId: `${receipt.commandId}:agent-send-accepted`,
              commandResult: receipt,
            }
          : {}),
      },
    );
    if (receipt) reportAgentSendAccepted(request, acceptance);
  }

  /** Recover main authority when a terminal-local queue drains through native ingress. */
  public async claimRetainedTerminalAgentInputForNative(
    request: ChatSendMessageRequest,
  ): Promise<ChatSendMessageRequest> {
    const state = await this.repository.getState(request, {
      chatIds: [request.chatId],
    });
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === request.chatId,
    );
    const retainedRow = isInputLedger(tab?.inputDelivery)
      ? tab.inputDelivery.rows.find(
          (row) =>
            row.id === request.userMessageId &&
            row.payload.agentSent &&
            row.payload.agentSenderProvenance &&
            row.attempts.some(
              (attempt) => attempt.generation === 'managed-terminal',
            ),
        )
      : undefined;
    if (
      retainedRow &&
      (retainedRow.state === 'cancelled' ||
        retainedRow.attempts.some(
          (attempt) =>
            attempt.generation === 'managed-terminal' &&
            attempt.withdrawnAt !== undefined,
        ))
    )
      throw new Error(
        'The agent that sent this message can no longer reach this chat.',
      );
    // Delivery is proven by terminal pickup, not transcript presence: core
    // precommits agent messages before the terminal picks them up.
    const pickedUp = (row: InputRow | undefined): boolean =>
      row?.attempts.some(
        (attempt) =>
          attempt.generation === 'managed-terminal' &&
          attempt.pickedUpAt !== undefined,
      ) === true;
    if (
      !tab ||
      pickedUp(retainedRow) ||
      !retainedTerminalAgentInput(tab, request.userMessageId)
    )
      return request;
    // Shares the delayed-delivery refusal and durable withdrawal with pre-paste authorization.
    await this.authorizeRetainedTerminalAgentInputWrite(
      request,
      request.userMessageId,
    );
    let trusted: ChatSendMessageRequest | undefined;
    let originalRow: InputRow | undefined;
    await this.repository.transactWith(
      request,
      (current) => {
        const live = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        trusted = live
          ? retainedTerminalAgentInput(live, request.userMessageId)
          : undefined;
        if (!live || !trusted || !isInputLedger(live.inputDelivery))
          throw new Error(
            'The agent that sent this message can no longer reach this chat.',
          );
        originalRow = live.inputDelivery.rows.find(
          (row) => row.id === request.userMessageId,
        );
        if (pickedUp(originalRow))
          throw new Error(
            'The agent that sent this message can no longer reach this chat.',
          );
        const now = this.now();
        return [
          {
            type: 'tab.metadata_patched',
            tabId: live.id,
            patch: {
              inputDelivery: {
                ...live.inputDelivery,
                rows: live.inputDelivery.rows.map((row) =>
                  row.id === request.userMessageId
                    ? {
                        ...row,
                        revision: row.revision + 1,
                        state: 'cancelled',
                        reason: 'Superseded by native delivery',
                        attempts: row.attempts.map((attempt) =>
                          attempt.generation === 'managed-terminal'
                            ? {
                                ...attempt,
                                withdrawnAt: now,
                                turnOutcome: 'cancelled',
                                turnSettledAt: now,
                              }
                            : attempt,
                        ),
                      }
                    : row,
                ),
              },
            },
          },
        ];
      },
      { source: 'provider', chatIds: [request.chatId] },
    );
    if (!trusted)
      throw new Error(
        'The agent that sent this message can no longer reach this chat.',
      );
    // Only payload/authority fields come from retention; model/mode/approval settings remain current.
    const claimed: ChatSendMessageRequest = {
      ...request,
      text: trusted.text,
      fileReferences: trusted.fileReferences,
      attachmentPaths: trusted.attachmentPaths,
      attachmentPromptContexts: trusted.attachmentPromptContexts,
      inputMode: trusted.inputMode,
      agentSent: trusted.agentSent,
      agentSenderProvenance: trusted.agentSenderProvenance,
      hiddenContext: trusted.hiddenContext,
      initiationSource: trusted.initiationSource,
    };
    if (originalRow)
      this.nativeClaimRollback.set(claimed, {
        row: originalRow,
        revision: originalRow.revision + 1,
      });
    return claimed;
  }

  /** Restore only our provisional withdrawal, never a later user cancel or delivered input. */
  public async restoreRetainedTerminalAgentInputAfterFailedNativeAdmission(
    request: ChatSendMessageRequest,
  ): Promise<void> {
    const rollback = this.nativeClaimRollback.get(request);
    if (!rollback) return;
    // Core precommits agent messages to the transcript, so only native
    // acceptance shows the input was delivered.
    if (
      await this.repository.hasMutation(
        request,
        `${request.chatId}:${request.userMessageId}:accepted`,
      )
    ) {
      this.nativeClaimRollback.delete(request);
      return;
    }
    await this.repository.transactWith(
      request,
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        const runtime = current.runtimeByChatId[request.chatId];
        if (
          !tab ||
          !isInputLedger(tab.inputDelivery) ||
          runtime?.queuedMessages?.some(
            (message) =>
              message.request.userMessageId === request.userMessageId,
          )
        )
          return [];
        const row = tab.inputDelivery.rows.find(
          (candidate) => candidate.id === request.userMessageId,
        );
        if (
          !row ||
          row.revision !== rollback.revision ||
          row.state !== 'cancelled' ||
          row.reason !== 'Superseded by native delivery'
        )
          return [];
        return [
          {
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              inputDelivery: {
                ...tab.inputDelivery,
                rows: tab.inputDelivery.rows.map((candidate) =>
                  candidate.id === row.id
                    ? { ...rollback.row, revision: row.revision + 1 }
                    : candidate,
                ),
              },
            },
          },
        ];
      },
      { source: 'provider', chatIds: [request.chatId] },
    );
    this.nativeClaimRollback.delete(request);
  }

  /** Existing queue-cancel compatibility for renderer-local terminal inputs. */
  public async cancelRetainedTerminalAgentInput(
    target: ChatScopeKey & { chatId: string },
    entryId: string,
    guard?: ChatQueueEntryGuard,
  ): Promise<'applied' | 'not_found' | 'conflict'> {
    let outcome: 'applied' | 'not_found' | 'conflict' = 'not_found';
    let endedTurn = false;
    const commit = await this.repository.transactWith(
      target,
      (current) => {
        outcome = 'not_found';
        endedTurn = false;
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === target.chatId,
        );
        if (!tab || !isInputLedger(tab.inputDelivery)) return [];
        const row = tab.inputDelivery.rows.find(
          (candidate) =>
            candidate.id === entryId &&
            candidate.attempts.some(
              (attempt) => attempt.generation === 'managed-terminal',
            ),
        );
        const existingMessage = tab.messages.find(
          (message) => message.id === entryId,
        );
        const agentInput =
          row?.payload.agentSenderProvenance &&
          row.payload.userMessageId === row.id;
        // A superseded row went to native delivery; once its prompt is in
        // the transcript or its turn runs, a late cancel must not undo it.
        const nativelyDelivered =
          row?.state === 'cancelled' &&
          row.reason === 'Superseded by native delivery' &&
          (existingMessage !== undefined ||
            current.runtimeByChatId[target.chatId]?.activeTurn
              ?.userMessageId === entryId);
        // Core sends precommit agent messages before the terminal picks them up.
        const delivered = agentInput
          ? nativelyDelivered ||
            row.attempts.some(
              (attempt) =>
                attempt.id === row.currentAttemptId &&
                attempt.generation === 'managed-terminal' &&
                attempt.pickedUpAt !== undefined,
            )
          : existingMessage !== undefined;
        if (
          !row ||
          delivered ||
          (row.state === 'cancelled' &&
            row.reason !== 'Superseded by native delivery') ||
          row.state === 'picked-up'
        )
          return [];
        // Retained inputs left the queue, so no entry revision can match.
        if (guard?.entryRevision !== undefined) {
          outcome = 'conflict';
          return [];
        }
        const now = this.now();
        outcome = 'applied';
        const mutations: ChatCoreMutation[] = [
          {
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              inputDelivery: {
                ...tab.inputDelivery,
                rows: tab.inputDelivery.rows.map((candidate) =>
                  candidate.id === row.id
                    ? {
                        ...candidate,
                        revision: candidate.revision + 1,
                        state: 'cancelled',
                        reason: 'Cancelled before delivery',
                        attempts: candidate.attempts.map((attempt) =>
                          attempt.generation === 'managed-terminal'
                            ? {
                                ...attempt,
                                withdrawnAt: attempt.withdrawnAt ?? now,
                                turnOutcome: 'cancelled',
                                turnSettledAt: now,
                              }
                            : attempt,
                        ),
                      }
                    : candidate,
                ),
              },
            },
          },
        ];
        if (agentInput && existingMessage) {
          mutations.push({
            type: 'message.removed',
            chatId: tab.id,
            messageId: entryId,
          });
        }
        // End the cancelled input's turn so watchers bound to it settle.
        if (
          tab.turnEnds?.[entryId] === undefined &&
          tab.unacceptedTurnEnds?.[entryId] === undefined
        ) {
          mutations.push(
            recordUnacceptedTurnEnd(tab, entryId, 'cancelled', this.now()),
          );
          endedTurn = true;
        }
        return mutations;
      },
      { source: 'renderer-command', chatIds: [target.chatId] },
    );
    if (endedTurn && commit.applied)
      this.deliverUnacceptedTurnEnd(
        target,
        { chatId: target.chatId, userMessageId: entryId },
        'cancelled',
        'Cancelled',
      );
    return outcome;
  }

  /** Revalidate delayed terminal input immediately before a paste crosses to the worker. */
  public async authorizeRetainedTerminalAgentInputWrite(
    target: ChatScopeKey & { chatId: string },
    acceptedInputId: string,
  ): Promise<void> {
    const refusal =
      'The agent that sent this message can no longer reach this chat.';
    const withdrawn = (tab: PersistedChatTab | undefined): boolean => {
      const row = isInputLedger(tab?.inputDelivery)
        ? tab.inputDelivery.rows.find(
            (candidate) => candidate.id === acceptedInputId,
          )
        : undefined;
      return (
        row?.payload.agentSent !== undefined &&
        row.payload.agentSenderProvenance?.acceptedInputId ===
          acceptedInputId &&
        row.payload.userMessageId === acceptedInputId &&
        row.payload.chatId === target.chatId &&
        row.payload.hiddenContext?.kind === 'agent-sender-context' &&
        row.attempts.some(
          (attempt) =>
            attempt.generation === 'managed-terminal' &&
            attempt.withdrawnAt !== undefined,
        )
      );
    };
    const state = await this.repository.getState(target, {
      chatIds: [target.chatId],
    });
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === target.chatId,
    );
    if (withdrawn(tab)) throw new Error(refusal);
    const payload = tab
      ? retainedTerminalAgentInput(tab, acceptedInputId)
      : undefined;
    if (!payload) return;
    try {
      await withAgentSenderAuthority(
        payload,
        () => undefined,
        revalidateAgentSenderRequest,
      );
    } catch (error) {
      const refusalError = new AgentSenderContextError(
        isAgentSenderContextError(error)
          ? error.code
          : 'owner_context_unavailable',
        refusal,
      );
      const reason = isAgentSenderContextError(error)
        ? `agent_send:${error.code}`
        : 'agent_send:owner_context_unavailable';
      let endedTurn = false;
      try {
        const commit = await this.repository.transactWith(
          target,
          (current) => {
            endedTurn = false;
            const live = current.tabsFile.tabs.find(
              (candidate) => candidate.id === target.chatId,
            );
            if (!live || !isInputLedger(live.inputDelivery)) return [];
            const now = this.now();
            const mutations: ChatCoreMutation[] = [
              {
                type: 'tab.metadata_patched',
                tabId: live.id,
                patch: {
                  inputDelivery: {
                    ...live.inputDelivery,
                    rows: live.inputDelivery.rows.map((candidate) =>
                      candidate.id === acceptedInputId
                        ? {
                            ...candidate,
                            state: 'cancelled',
                            revision: candidate.revision + 1,
                            reason,
                            attempts: candidate.attempts.map((attempt) =>
                              attempt.generation === 'managed-terminal'
                                ? {
                                    ...attempt,
                                    withdrawnAt: attempt.withdrawnAt ?? now,
                                    turnOutcome: 'cancelled',
                                    turnSettledAt: now,
                                  }
                                : attempt,
                            ),
                          }
                        : candidate,
                    ),
                  },
                },
              },
            ];
            // The refused input never runs; end its turn so bound watchers settle.
            if (
              live.inputDelivery.rows.some(
                (candidate) => candidate.id === acceptedInputId,
              ) &&
              live.turnEnds?.[acceptedInputId] === undefined &&
              live.unacceptedTurnEnds?.[acceptedInputId] === undefined
            ) {
              mutations.push(
                recordUnacceptedTurnEnd(
                  live,
                  acceptedInputId,
                  'cancelled',
                  this.now(),
                ),
              );
              endedTurn = true;
            }
            return mutations;
          },
          { source: 'provider', chatIds: [target.chatId] },
        );
        if (endedTurn && commit.applied)
          this.deliverUnacceptedTurnEnd(
            target,
            { chatId: target.chatId, userMessageId: acceptedInputId },
            'cancelled',
            'Cancelled',
          );
      } catch {
        throw refusalError;
      }
      throw refusalError;
    }
    // A cancel may commit while validation awaits. An empty transaction orders
    // this read after it; the caller writes in this continuation.
    let withdrawnDuringValidation = false;
    await this.repository.transactWith(
      target,
      (current) => {
        withdrawnDuringValidation = withdrawn(
          current.tabsFile.tabs.find(
            (candidate) => candidate.id === target.chatId,
          ),
        );
        return [];
      },
      { source: 'provider', chatIds: [target.chatId] },
    );
    if (withdrawnDuringValidation) throw new Error(refusal);
  }

  /** Canonical edit for a trusted terminal input still waiting in a renderer queue. */
  public async editRetainedTerminalAgentInput(
    request: ChatQueueEditRequest,
    guard?: ChatQueueEntryGuard,
  ): Promise<'applied' | 'not_found' | 'conflict'> {
    assertUntrustedChatInput(request);
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateId(request.chatId, 'chatId');
    validateId(request.entryId, 'entryId');
    if (typeof request.text !== 'string')
      throw new Error('Queued message text must be a string.');
    let outcome: 'applied' | 'not_found' | 'conflict' = 'not_found';
    await this.repository.transactWith(
      request,
      (current) => {
        const ownerTab = current.tabsFile.tabs.find(
          (candidate) =>
            isInputLedger(candidate.inputDelivery) &&
            candidate.inputDelivery.rows.some(
              (row) =>
                row.id === request.entryId &&
                row.attempts.some(
                  (attempt) => attempt.generation === 'managed-terminal',
                ),
            ),
        );
        if (!ownerTab) return [];
        const tab = ownerTab.id === request.chatId ? ownerTab : undefined;
        const payload = tab
          ? retainedTerminalAgentInput(tab, request.entryId)
          : undefined;
        const row =
          tab && isInputLedger(tab.inputDelivery)
            ? tab.inputDelivery.rows.find(
                (candidate) => candidate.id === request.entryId,
              )
            : undefined;
        const existingMessage = tab?.messages.find(
          (message) => message.id === request.entryId,
        );
        const agentInput =
          row?.payload.agentSenderProvenance &&
          row.payload.userMessageId === row.id;
        const delivered = agentInput
          ? row.state === 'picked-up' ||
            row.attempts.some(
              (attempt) =>
                attempt.id === row.currentAttemptId &&
                attempt.generation === 'managed-terminal' &&
                attempt.pickedUpAt !== undefined,
            )
          : existingMessage !== undefined;
        if (
          !tab ||
          tab.readOnly ||
          !payload ||
          !isInputLedger(tab.inputDelivery) ||
          delivered ||
          payload.projectId !== request.projectId ||
          payload.worktreeId !== request.worktreeId
        ) {
          throw new Error(
            'The retained terminal agent input is no longer editable.',
          );
        }
        if (guard?.entryRevision !== undefined) {
          outcome = 'conflict';
          return [];
        }
        outcome = 'applied';
        const editedPayload: ChatSendMessageRequest = {
          ...payload,
          text: request.text,
          fileReferences: request.fileReferences,
          attachmentPaths: request.attachmentPaths,
          attachmentPromptContexts: request.attachmentPromptContexts,
          ...(request.inputMode ? { inputMode: request.inputMode } : {}),
        };
        const mutations: ChatCoreMutation[] = [
          {
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              inputDelivery: {
                ...tab.inputDelivery,
                rows: tab.inputDelivery.rows.map((row) =>
                  row.id === request.entryId
                    ? {
                        ...row,
                        revision: row.revision + 1,
                        text: request.text,
                        payload: editedPayload,
                      }
                    : row,
                ),
              },
            },
          },
        ];
        if (agentInput && existingMessage) {
          mutations.push({
            type: 'message.upserted',
            chatId: tab.id,
            message: buildUserMessage(editedPayload, existingMessage.timestamp),
          });
        }
        return mutations;
      },
      { source: 'renderer-command', chatIds: [request.chatId] },
    );
    return outcome;
  }

  public async reconcileHostQueue(
    scope: ChatScopeKey & { chatId: string },
    queuedMessageIds: readonly string[],
    turnActive: boolean,
    mutation?: ChatQueuePersistenceMutation,
    queuedMessages?: readonly PersistedHostQueuedMessage[],
    activeTurnUserMessageId?: string,
    inFlight?: PersistedHostQueuedMessage,
  ): Promise<void> {
    const loaded = await this.repository.getState(scope, {
      chatIds: [scope.chatId],
    });
    const setupEnds: UnacceptedTurnEnd[] =
      mutation?.type === 'end-setup-held'
        ? mutation.requests.map((request) => ({
            userMessageId: request.userMessageId,
            startedAt: this.now(),
            outcome: mutation.outcome,
            reason: WORKTREE_SETUP_FAILED,
          }))
        : [];
    const deliverSetupEnds = (): void => {
      for (const end of setupEnds) {
        this.deliverUnacceptedTurnEnd(
          scope,
          { chatId: scope.chatId, userMessageId: end.userMessageId },
          end.outcome,
          end.reason,
        );
      }
    };
    if (
      !loaded.tabsFile.tabs.some(
        (candidate) =>
          candidate.id === scope.chatId && candidate.kind !== 'file',
      )
    ) {
      if (mutation?.type === 'cancel') {
        this.deliverUnacceptedTurnEnd(
          scope,
          {
            chatId: scope.chatId,
            userMessageId: mutation.request.userMessageId,
          },
          'cancelled',
          'Cancelled',
        );
      }
      deliverSetupEnds();
      return;
    }
    // Set by the transaction when settling a dropped agent input ends its turn.
    let settledAgentInputEnd = false;
    const commit = await this.repository.transactWith(
      scope,
      (current) => {
        settledAgentInputEnd = false;
        const previous = current.runtimeByChatId[scope.chatId] ?? {
          status: 'idle' as const,
          queuedMessageIds: [],
        };
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === scope.chatId,
        );
        // A dispatching row leaves `queuedMessageIds` at dequeue, which is
        // how the renderer recognizes a dispatch. Its payload stays durable,
        // flagged, until the prompt commit removes it; once its row exists it
        // must not be written back.
        const keepInFlight =
          inFlight !== undefined &&
          !queuedMessageIds.includes(inFlight.id) &&
          !tab?.messages.some(
            (message) => message.id === inFlight.request.userMessageId,
          );
        const dispatchingInFlight =
          keepInFlight &&
          turnActive &&
          inFlight !== undefined &&
          activeTurnUserMessageId === inFlight.request.userMessageId;
        const previousDispatchingRow = previous.queuedMessages?.find(
          (message) =>
            message.dispatching === true &&
            message.request.userMessageId ===
              previous.activeTurn?.userMessageId,
        );
        const canStartQueuedDispatch =
          previous.status === 'idle' ||
          previous.status === 'queued' ||
          previous.status === 'completed' ||
          previous.status === 'cancelled' ||
          previous.status === 'interrupted' ||
          previous.status === 'failed';
        const installsDispatchStarting =
          dispatchingInFlight && canStartQueuedDispatch;
        const nextQueuedMessageIds = [...queuedMessageIds];
        const nextQueuedMessages = queuedMessages ? [...queuedMessages] : [];
        if (keepInFlight && inFlight)
          nextQueuedMessages.unshift({ ...inFlight, dispatching: true });
        const representedUserMessageIds = new Set(
          nextQueuedMessages.map((message) => message.request.userMessageId),
        );
        // Keep the durable handoff marker while its prompt has not reached the
        // transcript. In particular, a later stale-gate release needs to
        // distinguish this dispatch's provisional `starting` from a direct
        // send that is still starting.
        if (
          turnActive &&
          activeTurnUserMessageId !== undefined &&
          previousDispatchingRow?.request.userMessageId ===
            activeTurnUserMessageId &&
          !representedUserMessageIds.has(
            previousDispatchingRow.request.userMessageId,
          ) &&
          !tab?.messages.some(
            (message) =>
              message.id === previousDispatchingRow.request.userMessageId,
          )
        ) {
          nextQueuedMessages.unshift(previousDispatchingRow);
          representedUserMessageIds.add(
            previousDispatchingRow.request.userMessageId,
          );
        }
        for (const message of previous.queuedMessages ?? []) {
          if (
            message.admitting !== true ||
            representedUserMessageIds.has(message.request.userMessageId) ||
            tab?.messages.some(
              (row) => row.id === message.request.userMessageId,
            )
          )
            continue;
          nextQueuedMessages.push(message);
          representedUserMessageIds.add(message.request.userMessageId);
        }
        const dispatchedUserMessageId = previous.activeTurn?.userMessageId;
        const dispatchRowReturnedToQueue =
          dispatchedUserMessageId !== undefined &&
          nextQueuedMessages.some(
            (message) =>
              message.request.userMessageId === dispatchedUserMessageId,
          );
        const dispatchWasReleased =
          !turnActive &&
          previous.status === 'starting' &&
          (previousDispatchingRow !== undefined || dispatchRowReturnedToQueue);
        const {
          error: _previousError,
          emptyCompletionRecovery: _previousEmptyCompletionRecovery,
          ...runtimeWithoutPreviousTurnError
        } = previous;
        void _previousError;
        void _previousEmptyCompletionRecovery;
        const runtimeBase = installsDispatchStarting
          ? runtimeWithoutPreviousTurnError
          : previous;
        const status = installsDispatchStarting
          ? 'starting'
          : dispatchWasReleased
            ? nextQueuedMessageIds.length > 0
              ? 'queued'
              : 'idle'
            : !turnActive && nextQueuedMessageIds.length > 0
              ? 'queued'
              : previous.status === 'queued'
                ? 'idle'
                : previous.status;
        // A canonical `starting` outlives its dispatch once the turn it
        // started ends (35c4 binds dispatches at start). With no dispatch
        // still awaiting its start, settle it from canonical state.
        const terminalImplementationPending =
          persistedTabProvider(tab) === 'claude' &&
          isTerminalBackedInterfaceMode(
            getEffectiveClaudeChatInterfaceMode(tab?.interfaceMode),
          ) &&
          tab?.trackedPlanImplementation &&
          !tab.trackedPlanImplementation.outcome &&
          tab.trackedPlanImplementation.userMessageId ===
            previous.activeTurn?.userMessageId;
        const settlesStaleStart =
          status === 'starting' &&
          !installsDispatchStarting &&
          !terminalImplementationPending &&
          // A worktree setup holding this chat's turn owns its start.
          this.setupHolds.get(chatRuntimeHostKey(scope, scope.chatId))?.owner
            ?.state !== 'held' &&
          // An unaccepted end that cannot commit yet leaves the turn as
          // durably recorded, for restart recovery to interrupt.
          !(
            previous.activeTurn !== undefined &&
            this.unrecordedTurnEnds.has(
              awaitingSetupKey(scope, {
                chatId: scope.chatId,
                userMessageId: previous.activeTurn.userMessageId,
              }),
            )
          ) &&
          !getChatTurnOwnership()
            .getSnapshot(scope)
            .dispatchOwners.some((owner) => owner.reason === 'awaiting-start');
        // A running canonical turn owns root status, not the host gate.
        const reconciled = this.projectReceiptRuntime(
          scope,
          {
            ...runtimeBase,
            status,
            queuedMessageIds: nextQueuedMessageIds,
            queuedMessages: nextQueuedMessages,
            ...(turnActive && activeTurnUserMessageId
              ? {
                  activeTurn:
                    previous.activeTurn?.userMessageId ===
                    activeTurnUserMessageId
                      ? previous.activeTurn
                      : {
                          userMessageId: activeTurnUserMessageId,
                          startedAt:
                            previous.activeTurn?.startedAt ?? this.now(),
                        },
                }
              : {}),
            lastActivityAt: this.now(),
            ...(mutation?.type === 'cancel' && mutation.lastErrorMessage
              ? {
                  error: {
                    code: 'cancelled',
                    message: mutation.lastErrorMessage,
                    retryable: false,
                    occurredAt: new Date(this.now()).toISOString(),
                  },
                }
              : {}),
          },
          !settlesStaleStart,
        );
        // Host-queued prompts enter the transcript at dispatch. A send its
        // setup ended never dispatches, so its prompt is kept with its end.
        const setupPrompts =
          tab && mutation?.type === 'end-setup-held'
            ? mutation.requests
                .filter(
                  (request) =>
                    !tab.messages.some(
                      (message) => message.id === request.userMessageId,
                    ),
                )
                .map((request) => buildUserMessage(request, this.now()))
            : [];
        const ended =
          tab && setupEnds.length > 0
            ? recordUnacceptedTurnEnds(
                { ...tab, messages: [...tab.messages, ...setupPrompts] },
                reconciled,
                setupEnds,
                this.now(),
              )
            : undefined;
        // Dequeue is provisional: authentication or dispatch admission may
        // still return the row to the queue. Only the admitted prompt's
        // transcript write retires its plan review.
        const mutations: ChatCoreMutation[] = [
          {
            type: 'runtime.patched',
            chatId: scope.chatId,
            runtime: ended?.runtime ?? reconciled,
          },
          ...setupPrompts.map(
            (message): ChatCoreMutation => ({
              type: 'message.upserted',
              chatId: scope.chatId,
              message,
            }),
          ),
          ...(ended?.mutations ?? []),
        ];
        if (mutation?.type === 'agent-send-accepted') {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === scope.chatId,
          );
          if (!tab || (tab.inputDelivery && !isInputLedger(tab.inputDelivery)))
            throw new Error('Agent input ledger is unavailable');
          const ledger = tab.inputDelivery ?? {
            version: 1 as const,
            epoch: 0,
            rows: [],
          };
          if (
            !ledger.rows.some(
              (row) => row.id === mutation.request.userMessageId,
            )
          ) {
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: tab.id,
              patch: {
                inputDelivery: {
                  ...ledger,
                  rows: [
                    ...ledger.rows,
                    {
                      id: mutation.request.userMessageId,
                      revision: 1,
                      createdAt: Date.parse(mutation.acceptance.acceptedAt),
                      state: 'queued',
                      text: mutation.request.text,
                      payload: structuredClone(mutation.request),
                      settingsKey: inputSettingsKey(tab),
                      attempts: [],
                    },
                  ],
                },
              },
            });
          }
        }
        if (mutation?.type === 'restore-input') {
          const tab = current.tabsFile.tabs.find((t) => t.id === scope.chatId);
          const ledger = tab?.inputDelivery;
          const row = ledger?.rows.find((r) => r.id === mutation.rowId);
          if (
            !isInputLedger(ledger) ||
            ledger.epoch !== mutation.epoch ||
            !row ||
            (!['cancelled', 'editing'].includes(row.state) &&
              !(mutation.allowUncertain === true && row.state === 'uncertain'))
          )
            throw new Error('The input is no longer available to queue');
          if (mutation.continuation) {
            const continuation = validOrdinaryContinuation(ledger, row);
            if (
              !continuation ||
              continuation.attemptId !== mutation.continuation.attemptId ||
              continuation.epoch !== mutation.continuation.epoch
            )
              throw new Error('The input is no longer available to queue');
          }
          mutations.push({
            type: 'tab.metadata_patched',
            tabId: scope.chatId,
            patch: {
              inputDelivery: {
                ...ledger,
                rows: ledger.rows.map((r) => {
                  if (r.id !== row.id) return r;
                  const {
                    ordinaryContinuation: _ordinaryContinuation,
                    ...rowWithoutContinuation
                  } = r;
                  void _ordinaryContinuation;
                  return {
                    ...rowWithoutContinuation,
                    state: 'queued',
                    revision: r.revision + 1,
                    text: mutation.request.text,
                    payload: mutation.request,
                    ...(mutation.ordinaryOnly === true
                      ? { ordinaryOnly: true }
                      : {}),
                    draft: undefined,
                    queueIntent: undefined,
                  };
                }),
              },
            },
          });
        }
        const restoredAsyncQuestionId =
          mutation?.type === 'edit' || mutation?.type === 'restore-input'
            ? mutation.restoredAsyncQuestionId
            : mutation?.type === 'cancel'
              ? mutation.request.asyncQuestionId
              : undefined;
        if (restoredAsyncQuestionId) {
          mutations.push(
            ...reopenAsyncQuestionMutations(
              current.tabsFile.pendingQuestions,
              scope.chatId,
              restoredAsyncQuestionId,
            ),
          );
        }
        if (mutation?.type === 'edit') {
          const editedTab = current.tabsFile.tabs.find(
            (tab) => tab.id === scope.chatId,
          );
          const ledger = editedTab?.inputDelivery;
          if (
            isInputLedger(ledger) &&
            ledger.rows.some(
              (row) =>
                row.id === mutation.request.userMessageId &&
                row.payload.agentSenderProvenance &&
                row.state !== 'picked-up',
            )
          ) {
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: scope.chatId,
              patch: {
                inputDelivery: {
                  ...ledger,
                  rows: ledger.rows.map((row) =>
                    row.id === mutation.request.userMessageId &&
                    row.state !== 'picked-up'
                      ? {
                          ...row,
                          revision: row.revision + 1,
                          state: 'queued',
                          text: mutation.request.text,
                          payload: {
                            ...mutation.request,
                            agentSent: row.payload.agentSent,
                            agentSenderProvenance:
                              row.payload.agentSenderProvenance,
                            hiddenContext: row.payload.hiddenContext,
                          },
                        }
                      : row,
                  ),
                },
              },
            });
          }
          const existingMessage = current.tabsFile.tabs
            .find((tab) => tab.id === scope.chatId)
            ?.messages.find(
              (message) => message.id === mutation.request.userMessageId,
            );
          // Local host-queued prompts enter the transcript at dispatch. An
          // edit must only update a prompt that was already persisted.
          if (existingMessage) {
            mutations.push({
              type: 'message.upserted',
              chatId: scope.chatId,
              message: buildUserMessage(
                mutation.request,
                existingMessage.timestamp,
              ),
            });
          }
        } else if (mutation?.type === 'settle-agent-input') {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === scope.chatId,
          );
          const ledger = tab?.inputDelivery;
          const userMessageId = mutation.request.userMessageId;
          if (
            tab &&
            isInputLedger(ledger) &&
            ledger.rows.some(
              (row) =>
                row.id === userMessageId &&
                row.state === 'queued' &&
                row.payload.agentSenderProvenance !== undefined,
            )
          ) {
            const now = this.now();
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: scope.chatId,
              patch: {
                inputDelivery: {
                  ...ledger,
                  rows: ledger.rows.map((row) =>
                    row.id === userMessageId
                      ? {
                          ...row,
                          revision: row.revision + 1,
                          state: 'cancelled',
                          reason: mutation.reason,
                          attempts: row.attempts.map((attempt) =>
                            attempt.pickedUpAt === undefined
                              ? {
                                  ...attempt,
                                  withdrawnAt: attempt.withdrawnAt ?? now,
                                  turnOutcome: 'failed',
                                  turnSettledAt: now,
                                }
                              : attempt,
                          ),
                        }
                      : row,
                  ),
                },
              },
            });
            // The dropped input never runs: end its turn so watchers bound to
            // it settle, unless dispatch already recorded that turn's end.
            if (
              tab.turnEnds?.[userMessageId] === undefined &&
              tab.unacceptedTurnEnds?.[userMessageId] === undefined
            ) {
              mutations.push(
                recordUnacceptedTurnEnd(
                  tab,
                  userMessageId,
                  'failed',
                  this.now(),
                ),
              );
              settledAgentInputEnd = true;
            }
          }
        } else if (mutation?.type === 'cancel') {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === scope.chatId,
          );
          const ledger = tab?.inputDelivery;
          const agentRow = isInputLedger(ledger)
            ? ledger.rows.find(
                (row) =>
                  row.id === mutation.request.userMessageId &&
                  row.payload.agentSenderProvenance !== undefined,
              )
            : undefined;
          // An agent acceptance row must settle on every cancel, or active-input
          // lookups keep reporting the removed input as pending.
          if (
            (mutation.lastErrorMessage || agentRow) &&
            isInputLedger(tab?.inputDelivery)
          ) {
            const now = this.now();
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: scope.chatId,
              patch: {
                inputDelivery: {
                  ...tab.inputDelivery,
                  rows: tab.inputDelivery.rows.map((row) =>
                    row.id === mutation.request.userMessageId &&
                    row.state !== 'picked-up'
                      ? {
                          ...row,
                          revision: row.revision + 1,
                          state: 'cancelled',
                          reason: mutation.agentSendRefusalCode
                            ? `agent_send:${mutation.agentSendRefusalCode}`
                            : (mutation.lastErrorMessage ?? 'cancelled'),
                          attempts: row.attempts.map((attempt) =>
                            attempt.pickedUpAt === undefined
                              ? {
                                  ...attempt,
                                  withdrawnAt: attempt.withdrawnAt ?? now,
                                  turnOutcome: 'cancelled',
                                  turnSettledAt: now,
                                }
                              : attempt,
                          ),
                        }
                      : row,
                  ),
                },
              },
            });
          }
          mutations.push(
            {
              type: 'message.removed',
              chatId: scope.chatId,
              messageId: mutation.request.userMessageId,
            },
            ...(tab
              ? [
                  recordUnacceptedTurnEnd(
                    tab,
                    mutation.request.userMessageId,
                    'cancelled',
                    this.now(),
                  ),
                ]
              : []),
          );
        }
        return mutations;
      },
      {
        ...(mutation?.type !== 'end-setup-held' && mutation?.commandResult
          ? {
              source: 'renderer-command',
              mutationId:
                mutation.type === 'agent-send-accepted'
                  ? `${mutation.commandResult.commandId}:agent-send-accepted`
                  : mutation.commandResult.commandId,
              commandResult: mutation.commandResult,
            }
          : { source: 'automation' }),
        ...(setupEnds.length > 0 ? { checkpoint: true } : {}),
        chatIds: [scope.chatId],
      },
    );
    if (mutation?.type === 'cancel' && commit.applied) {
      this.deliverUnacceptedTurnEnd(
        scope,
        { chatId: scope.chatId, userMessageId: mutation.request.userMessageId },
        'cancelled',
        'Cancelled',
      );
    }
    if (
      mutation?.type === 'settle-agent-input' &&
      settledAgentInputEnd &&
      commit.applied
    ) {
      this.deliverUnacceptedTurnEnd(
        scope,
        { chatId: scope.chatId, userMessageId: mutation.request.userMessageId },
        'failed',
        mutation.reason,
      );
    }
    if (commit.applied) deliverSetupEnds();
  }

  public endDiscardedQueuedTurns(
    target: ChatScopeKey & { chatId: string },
    requests: readonly Pick<ChatSendMessageRequest, 'userMessageId'>[],
  ): void {
    for (const request of requests) {
      this.deliverUnacceptedTurnEnd(
        target,
        { chatId: target.chatId, userMessageId: request.userMessageId },
        'cancelled',
        'Cancelled',
      );
    }
  }

  /** Trusted rejected-startup fallback when transcript error recording failed. */
  public async settleRejectedStartup(
    target: ChatScopeKey & { chatId: string },
    message: string,
  ): Promise<void> {
    const snapshot = await this.repository.getState(target, {
      chatIds: [target.chatId],
    });
    const observed = snapshot.runtimeByChatId[target.chatId];
    if (observed?.status !== 'starting') return;
    const userMessageId = observed.activeTurn?.userMessageId;
    if (
      userMessageId &&
      (await this.repository.hasMutation(
        target,
        `${target.chatId}:${userMessageId}:accepted`,
      ))
    )
      return;
    await this.repository.transactWith(
      target,
      (current) => {
        const runtime = current.runtimeByChatId[target.chatId];
        // Acceptance or another commit after the observation must never be
        // overwritten by startup rollback. Ordinary close guards still apply.
        if (
          current.tabsFile.revision !== snapshot.tabsFile.revision ||
          runtime?.status !== 'starting'
        )
          return [];
        return [
          {
            type: 'runtime.patched',
            chatId: target.chatId,
            runtime: runtimeForEvent(
              runtime,
              { type: 'error', error: message },
              this.now(),
            ),
          },
        ];
      },
      { source: 'automation', chatIds: [target.chatId] },
    );
  }

  public async removeUnacceptedUserPrompt(
    input: ChatScopeKey & {
      chatId: string;
      userMessageId: string;
    },
  ): Promise<void> {
    await this.repository.transactWith(
      input,
      (current) => {
        const message = current.tabsFile.tabs
          .find((tab) => tab.id === input.chatId)
          ?.messages.find((candidate) => candidate.id === input.userMessageId);
        if (!message) return [];
        return [
          {
            type: 'message.removed',
            chatId: input.chatId,
            messageId: input.userMessageId,
          },
        ];
      },
      {
        source: 'automation',
        mutationId: `${input.chatId}:${input.userMessageId}:prompt-rejected`,
        chatIds: [input.chatId],
      },
    );
  }

  public async replaceCompatibilityTabs(
    scope: ChatScopeKey,
    tabsFile: ChatTabsFile,
    options?: {
      changedTabIds?: readonly string[];
      removedTabIds?: readonly string[];
      activeTabId?: string;
      authoritative?: boolean;
      beforePublish?: () => void;
      preparePublish?: () => Promise<void>;
    },
  ): Promise<ChatTabsFile> {
    const state = await this.repository.replaceCompatibilityTabs(
      scope,
      tabsFile,
      {
        ...(options?.changedTabIds
          ? { changedTabIds: options.changedTabIds }
          : {}),
        ...(options?.removedTabIds
          ? { removedTabIds: options.removedTabIds }
          : {}),
        ...(options?.activeTabId ? { activeTabId: options.activeTabId } : {}),
        ...(options?.authoritative ? { authoritative: true } : {}),
        ...(options?.beforePublish
          ? { beforePublish: options.beforePublish }
          : {}),
        ...(options?.preparePublish
          ? { preparePublish: options.preparePublish }
          : {}),
        source: 'migration',
        additionalTabMutations: (tab, current): ChatCoreMutation[] => {
          if (options?.authoritative) return [];
          const runtime = current.runtimeByChatId[tab.id];
          const dispatching = runtime?.queuedMessages?.find(
            (row) =>
              row.dispatching === true &&
              row.request.userMessageId === runtime.activeTurn?.userMessageId &&
              tab.messages.some(
                (message) =>
                  message.role === 'user' &&
                  message.id === row.request.userMessageId,
              ),
          );
          if (!runtime || !dispatching) return [];
          // Portal commits its admitted prompt before the provider event.
          // Consume the dispatch marker with that write, so replaying an old
          // compatibility snapshot cannot retire a replacement review.
          return [
            ...retireSupersededPlanExitMutations(
              current.tabsFile.tabs.find((previous) => previous.id === tab.id),
            ),
            {
              type: 'runtime.patched',
              chatId: tab.id,
              runtime: {
                ...runtime,
                queuedMessageIds: runtime.queuedMessageIds.filter(
                  (id) => id !== dispatching.id,
                ),
                queuedMessages: (runtime.queuedMessages ?? []).filter(
                  (row) => row.id !== dispatching.id,
                ),
              },
            },
          ];
        },
      },
    );
    return state.tabsFile;
  }

  /** Commit recovery metadata and its one transcript row under the canonical lease. */
  public async compareAndSetMcpActivation(
    scope: McpActivationScope,
    expected: McpActivationRecord | undefined,
    next: McpActivationRecord,
  ): Promise<boolean> {
    const record = mcpActivationRecordSchema.parse(next);
    const messageId = mcpActivationMessageId(record.originatingMessageId);
    let updated = false;
    await this.repository.transactWith(
      scope,
      (current, _revision, context) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === scope.chatId,
        );
        if (
          !tab ||
          tab.kind === 'file' ||
          tab.readOnly ||
          !isDeepStrictEqual(
            readMcpActivationRecord(tab.mcpActivation),
            expected,
          )
        )
          return [];
        const removed =
          context.hasRemovedMessage(messageId, scope.chatId) ||
          context.hasRemovedMessage(record.originatingMessageId, scope.chatId);
        // A removed task cannot restart. Its existing attempt must still be
        // cancellable and admission must remain reconcilable after a crash.
        if (
          removed &&
          (!expected ||
            expected.activationId !== record.activationId ||
            expected.attemptId !== record.attemptId ||
            expected.originatingMessageId !== record.originatingMessageId ||
            !['cancelled', 'failed', 'completed'].includes(record.phase))
        )
          return [];
        const mutations: ChatCoreMutation[] = [
          {
            type: 'tab.metadata_patched',
            tabId: scope.chatId,
            patch: { mcpActivation: record },
          },
        ];
        if (!removed) {
          const previous = tab.messages.find(
            (message) => message.id === messageId,
          );
          mutations.push({
            type: 'message.upserted',
            chatId: scope.chatId,
            message: {
              id: messageId,
              role: 'system',
              timestamp: previous?.timestamp ?? this.now(),
              blocks: [{ type: 'mcp_activation', record }],
            },
          });
        }
        updated = true;
        return mutations;
      },
      {
        source: 'migration',
        chatIds: [scope.chatId],
        messageAnchor: {
          messageId,
          fallbackMessageId: record.originatingMessageId,
        },
      },
    );
    return updated;
  }

  /** Atomically update one compatibility tab against the latest canonical state. */
  public async updateCompatibilityTab(
    scope: ChatScopeKey,
    chatId: string,
    update: (
      tab: PersistedChatTab,
      runtime: ChatRuntimeState | undefined,
    ) => PersistedChatTab | null,
    mutationId?: string,
    options?: { metadataOnly?: boolean },
  ): Promise<{ tabsFile: ChatTabsFile; updated: boolean }> {
    let updated = false;
    const commit = await this.repository.transactWith(
      scope,
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        if (!tab) return [];
        const nextTab = update(tab, current.runtimeByChatId[chatId]);
        if (!nextTab) return [];
        updated = true;
        return [{ type: 'tab.created', tab: nextTab }];
      },
      {
        ...{
          source: 'migration',
          ...(mutationId ? { mutationId } : {}),
        },
        ...(options?.metadataOnly
          ? {}
          : { chatIds: [chatId], fullTranscript: true }),
      },
    );
    return { tabsFile: commit.state.tabsFile, updated };
  }

  /** Atomically merge a compatibility tabs file against canonical state. */
  public async updateCompatibilityTabs(
    scope: ChatScopeKey,
    update: (tabsFile: ChatTabsFile) => ChatTabsFile,
    mutationId?: string,
    transcriptChatIds?: readonly string[],
  ): Promise<ChatTabsFile> {
    const commit = await this.repository.transactWith(
      scope,
      (current) => {
        const incoming = update(current.tabsFile);
        const currentById = new Map(
          current.tabsFile.tabs.map((tab) => [tab.id, tab]),
        );
        const mutations: ChatCoreMutation[] = incoming.tabs
          .filter((tab) => !isDeepStrictEqual(currentById.get(tab.id), tab))
          .map((tab) => ({ type: 'tab.created' as const, tab }));
        if (mutations.length > 0) {
          mutations.push({
            type: 'tab.order_changed',
            tabIds: incoming.tabs.map(({ id }) => id),
          });
          mutations.push({
            type: 'tab.active_changed',
            activeTabId: incoming.activeTabId,
            ...(incoming.lastActiveEditableChatId
              ? { lastActiveEditableChatId: incoming.lastActiveEditableChatId }
              : {}),
            ...(incoming.lastActiveChatProvider
              ? { lastActiveChatProvider: incoming.lastActiveChatProvider }
              : {}),
          });
        }
        if (incoming.pendingQuestions !== undefined) {
          const remaining = new Map(
            (current.tabsFile.pendingQuestions ?? []).map((question) => [
              question.requestId,
              question,
            ]),
          );
          for (const question of incoming.pendingQuestions) {
            if (!isDeepStrictEqual(remaining.get(question.requestId), question))
              mutations.push({ type: 'pending_question.upserted', question });
            remaining.delete(question.requestId);
          }
          for (const question of Array.from(remaining.values()))
            mutations.push({
              type: 'pending_question.removed',
              requestId: question.requestId,
              chatId: question.chatId,
            });
        }
        return mutations;
      },
      {
        source: 'migration',
        ...(mutationId ? { mutationId } : {}),
        ...(transcriptChatIds ? { chatIds: transcriptChatIds } : {}),
      },
    );
    return commit.state.tabsFile;
  }

  /** Retire a review before its tracked plan is revised in the plan store. */
  public async retirePlanReview(request: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    planId: string;
    expectedUserMessageId?: string;
    isCurrent: () => boolean;
  }): Promise<boolean> {
    let retired = false;
    const commit = await this.repository.transactWith(
      { projectId: request.projectId, worktreeId: request.worktreeId },
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        if (
          !tab ||
          tab.kind === 'file' ||
          !tab.planMode ||
          tab.trackedPlanSource !== 'opencode' ||
          tab.trackedPlanId !== request.planId ||
          !request.isCurrent() ||
          (request.expectedUserMessageId !== undefined &&
            current.runtimeByChatId[request.chatId]?.activeTurn
              ?.userMessageId !== request.expectedUserMessageId)
        )
          return [];
        const pendingSystemInstructions = tab.pendingSystemInstructions?.filter(
          (instruction) =>
            instruction.id !== `plan-file-location:${request.planId}`,
        );
        retired = true;
        return [
          {
            type: 'tab.created',
            tab: {
              ...tab,
              pendingPlanExit: undefined,
              pendingPlanExitRequestId: undefined,
              trackedPlanId: undefined,
              trackedPlanSource: undefined,
              trackedPlanReviewStatus: undefined,
              latestRevisionNumber: undefined,
              hasOutstandingProposal: false,
              pendingSystemInstructions: pendingSystemInstructions?.length
                ? pendingSystemInstructions
                : undefined,
            },
          },
        ];
      },
      {
        source: 'provider',
        mutationId: `retire-plan-review-${this.createId()}`,
      },
    );
    return commit.applied && retired;
  }

  /** Persist every durable field that the renderer projects for plan review. */
  public async commitPlanExit(
    event: PlanExitRequestEvent,
    guard?: {
      requirePlanMode?: boolean;
      expectedUserMessageId?: string;
      isCurrent?: () => boolean;
    },
  ): Promise<boolean> {
    const commit = await this.repository.transactWith(
      { projectId: event.projectId, worktreeId: event.worktreeId },
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === event.chatId,
        );
        if (!tab || tab.kind === 'file' || tab.readOnly)
          throw new Error('The plan chat is no longer available.');
        if (
          event.turnUserMessageId !== undefined &&
          current.runtimeByChatId[event.chatId]?.activeTurn?.userMessageId !==
            event.turnUserMessageId
        )
          throw new Error('The plan turn has been superseded.');
        if (guard?.isCurrent && !guard.isCurrent()) return [];
        if (guard?.requirePlanMode && !tab.planMode) return [];
        if (
          guard?.expectedUserMessageId !== undefined &&
          current.runtimeByChatId[event.chatId]?.activeTurn?.userMessageId !==
            guard.expectedUserMessageId
        )
          return [];
        return [
          {
            type: 'tab.created',
            tab: {
              ...tab,
              pendingPlanExit: {
                ...event.toolInput,
                ...(event.source ? { source: event.source } : {}),
                ...(event.reviewMode ? { reviewMode: event.reviewMode } : {}),
              },
              pendingPlanExitRequestId: event.requestId,
              pendingSystemInstructions: event.pendingSystemInstructions?.length
                ? event.pendingSystemInstructions
                : undefined,
              trackedPlanReviewStatus: 'pending',
              ...(event.reviewMode === 'proposal'
                ? { hasOutstandingProposal: true }
                : {}),
              ...(event.planId ? { trackedPlanId: event.planId } : {}),
              ...(event.source ? { trackedPlanSource: event.source } : {}),
              ...(event.revisionNumber !== undefined
                ? { latestRevisionNumber: event.revisionNumber }
                : {}),
              attentionDismissedAt: undefined,
            },
          },
        ];
      },
      {
        source: 'provider',
        mutationId: `plan-exit-${event.requestId}`,
      },
    );
    return commit.state.tabsFile.tabs.some(
      (tab) =>
        tab.id === event.chatId &&
        tab.pendingPlanExitRequestId === event.requestId,
    );
  }

  public async consumeTranscript<T>(
    scope: ChatScopeKey,
    chatId: string,
    fullOutputs: boolean,
    consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
    options?: TranscriptConsumeOptions,
  ): Promise<T> {
    return this.repository.consumeTranscript(
      scope,
      chatId,
      fullOutputs,
      consume,
      options,
    );
  }

  /** Search-only preview projection; the repository releases its scope writer
   * before the consumer builds text from pinned transcript handles.
   */
  public async consumeTranscriptPreview<T>(
    scope: ChatScopeKey,
    chatId: string,
    consume: (
      messages: AsyncIterable<PersistedChatMessage>,
      descriptor: TranscriptDescriptor,
      read: TranscriptPreviewRead,
    ) => Promise<T>,
    isCurrent?: () => boolean,
    options?: TranscriptPreviewOptions,
  ): Promise<T> {
    return this.repository.consumeTranscriptPreview(
      scope,
      chatId,
      consume,
      isCurrent,
      options,
    );
  }

  /**
   * Chat search's incremental in-flight text: the rows a chat's in-progress
   * turn changed since a transcript revision, from the delta journal in
   * memory. Undefined when only a full preview read can answer.
   */
  public activeTurnDelta(
    scope: ChatScopeKey,
    chatId: string,
    since: number,
  ): ReturnType<ChatStateRepositoryPort['activeTurnDelta']> {
    return this.repository.activeTurnDelta(scope, chatId, since);
  }

  /** An accepted send to the chat is between acceptance and host exposure. */
  public isDispatchInFlight(
    target: ChatScopeKey & { chatId: string },
  ): boolean {
    return this.dispatchesInFlight.has(
      chatRuntimeHostKey(target, target.chatId),
    );
  }

  /** The scope's revision, read behind every commit admitted before the call. */
  public getCommittedRevision(scope: ChatScopeKey): Promise<number> {
    return this.repository.getRevision(scope);
  }

  public async getCompatibilityTabs(
    scope: ChatScopeKey,
    selection: ChatReadSelection = {},
  ): Promise<ChatTabsFile> {
    return (await this.repository.getState(scope, selection)).tabsFile;
  }

  /** Committed watcher evidence without host recovery or transcript projection. */
  public async getCommittedWatcherSnapshot(
    scope: ChatScopeKey,
  ): Promise<ChatStateSnapshot> {
    const state = await this.repository.getState(scope, { chatIds: [] });
    const { getChatQueueService } = await import('./chat-queue-service');
    const runtimeByChatId: ChatStateSnapshot['runtimeByChatId'] = {};
    for (const [chatId, runtime] of Object.entries(state.runtimeByChatId)) {
      runtimeByChatId[chatId] = projectChatRuntime(runtime);
    }
    return {
      schemaVersion: 1,
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      revision: state.tabsFile.revision ?? 0,
      tabsFile: state.tabsFile,
      // Archived chats leave live tabs; eligibility only needs retained tabs.
      archives: [],
      runtimeByChatId,
      queue: getChatQueueService().getWorktreeSnapshots(
        scope.projectId,
        scope.worktreeId,
      ),
    };
  }

  /** Trusted adapter for the deprecated renderer-snapshot archive channel. */
  public async archiveCompatibilityTab(
    scope: ChatScopeKey,
    entry: ArchivedChatEntry,
  ): Promise<ArchivedChatsFile> {
    const commit = await this.repository.transactWith(
      scope,
      (current) => {
        const currentTab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === entry.tab.id,
        );
        if (!currentTab) {
          throw new Error(`Unknown compatibility archive tab: ${entry.tab.id}`);
        }
        const completedAt = Number.isFinite(Date.parse(entry.archivedAt))
          ? Date.parse(entry.archivedAt)
          : this.now();
        const messages = settlePersistedInterruptedMessages(
          currentTab.messages,
          completedAt,
          current.runtimeByChatId[currentTab.id],
        );
        const finalizedTab =
          messages === currentTab.messages
            ? currentTab
            : { ...currentTab, messages };
        return [
          { type: 'tab.removed', tabId: currentTab.id },
          {
            type: 'archive.upserted',
            entry: {
              ...entry,
              tab: finalizedTab,
              turnFence: archiveTurnFence(
                finalizedTab,
                this.turnHandoff.getState({
                  ...scope,
                  chatId: currentTab.id,
                }) ?? current.runtimeByChatId[currentTab.id]?.turn,
                completedAt,
              ),
              turnCount: countTurns(finalizedTab),
            },
          },
        ];
      },
      {
        ...{
          source: 'migration',
          mutationId: `legacy-archive:${entry.tab.id}:${entry.archivedAt}`,
          checkpoint: true,
        },
        chatIds: [entry.tab.id],
      },
    );
    return commit.state.archivesFile;
  }

  public async getCompatibilityArchives(
    scope: ChatScopeKey,
    selection: ChatReadSelection = {},
  ): Promise<ArchivedChatsFile> {
    return (await this.repository.getState(scope, selection)).archivesFile;
  }

  /** Authoritative eligibility includes retained archives; no caller-text fallback. */
  public async getInitialChatTitlePrompt(
    scope: ChatScopeKey,
    chatId: string,
  ): Promise<string | null> {
    const settledKey = initialTitleChatKey(scope, chatId);
    if (this.settledInitialTitleChats.has(settledKey)) return null;
    const state = await this.repository.getState(scope, { chatIds: [chatId] });
    const tab =
      state.tabsFile.tabs.find((candidate) => candidate.id === chatId) ??
      state.archivesFile.archived.find((entry) => entry.tab.id === chatId)?.tab;
    if (!tab) return null;
    if (!isInitialChatTitleEligible(tab)) {
      if (tab.automaticTitleState !== 'pending') {
        this.settledInitialTitleChats.add(settledKey);
      }
      return null;
    }
    return this.repository.consumeTranscript(
      scope,
      chatId,
      false,
      async (messages) => {
        for await (const message of messages) {
          if (
            message.role !== 'user' ||
            message.hidden === true ||
            message.parentToolUseId ||
            message.parentBlockId ||
            message.userMessageSource === 'deferred_tools_reload' ||
            message.userMessageSource === 'immediate_turn_restart'
          )
            continue;
          return message.blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim();
        }
        return null;
      },
    );
  }

  /** Returns true only after the first title is durably committed. Errors propagate. */
  public async commitInitialChatTitle(
    scope: ChatScopeKey,
    chatId: string,
    description: string,
  ): Promise<boolean> {
    const title = description.trim();
    if (!title) return false;
    const commit = await this.repository.transactWith(
      scope,
      (current) => {
        const live = current.tabsFile.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        const archived = live
          ? undefined
          : current.archivesFile.archived.find(
              (entry) => entry.tab.id === chatId,
            );
        const tab = live ?? archived?.tab;
        if (!tab || !isInitialChatTitleEligible(tab)) return [];
        if (live)
          return [
            {
              type: 'tab.metadata_patched',
              tabId: chatId,
              patch: { description: title, automaticTitleState: 'closed' },
            },
          ];
        if (!archived) return [];
        return [
          {
            type: 'archive.upserted',
            entry: {
              ...archived,
              tab: {
                ...archived.tab,
                description: title,
                automaticTitleState: 'closed',
              },
            },
          },
        ];
      },
      { source: 'automation', chatIds: [chatId] },
    );
    if (commit.applied) {
      this.settledInitialTitleChats.add(initialTitleChatKey(scope, chatId));
    }
    return commit.applied;
  }

  /**
   * Persist generated chat metadata regardless of whether the chat is still
   * live, including retained transcripts. Compatibility writer only: it
   * ignores naming state, so initial naming must use `commitInitialChatTitle`.
   */
  /**
   * The provider-switch seed was delivered: a turn whose prompt carried it was
   * accepted by the provider (CAN-6445). Only then is the pending flag
   * cleared, never when a session id is recorded, which can happen before the
   * seed is read.
   */
  public async consumeProviderSwitchSeed(
    scope: ChatScopeKey,
    chatId: string,
  ): Promise<void> {
    await this.repository.transactWith(
      scope,
      (current) => {
        const liveTab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        if (liveTab?.providerSwitchSeedPending !== true) return [];
        const { providerSwitchSeedPending: consumed, ...next } = liveTab;
        void consumed;
        return [
          {
            type: 'tab.metadata_patched' as const,
            tabId: chatId,
            patch: buildTabMetadataPatch(liveTab, next),
          },
        ];
      },
      { source: 'provider' },
    );
  }

  public async updateChatDescription(
    scope: ChatScopeKey,
    chatId: string,
    description: string,
  ): Promise<void> {
    await this.repository.transactWith(
      scope,
      (current) => {
        const liveTab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        if (liveTab) {
          return liveTab.description === description
            ? []
            : [
                {
                  type: 'tab.created' as const,
                  tab: { ...liveTab, description },
                },
              ];
        }
        const archived = current.archivesFile.archived.find(
          (entry) => entry.tab.id === chatId,
        );
        if (!archived || archived.tab.description === description) {
          return [];
        }
        return [
          {
            type: 'archive.upserted' as const,
            entry: {
              ...archived,
              tab: { ...archived.tab, description },
            },
          },
        ];
      },
      { source: 'automation' },
    );
  }

  public async replaceCompatibilityState(
    scope: ChatScopeKey,
    tabsFile: ChatTabsFile,
    archivesFile: ArchivedChatsFile,
  ): Promise<void> {
    const loaded = await this.repository.getState(scope);
    if (
      tabsFile.tabs.length === 0 &&
      archivesFile.archived.length === 0 &&
      loaded.tabsFile.tabs.length === 0 &&
      loaded.archivesFile.archived.length === 0
    ) {
      return;
    }
    this.turnHandoff.invalidateScope(scope);
    await this.repository.transactWith(
      scope,
      (current) => {
        const mutations: ChatCoreMutation[] = [];
        const incomingTabIds = new Set(tabsFile.tabs.map((tab) => tab.id));
        for (const tab of current.tabsFile.tabs) {
          if (!incomingTabIds.has(tab.id)) {
            mutations.push({ type: 'tab.removed', tabId: tab.id });
          }
        }
        for (const tab of tabsFile.tabs) {
          const retained =
            current.tabsFile.tabs.find(
              (candidate) => candidate.id === tab.id,
            ) ??
            current.archivesFile.archived.find(
              (entry) => entry.tab.id === tab.id,
            )?.tab;
          mutations.push({
            type: 'tab.created',
            tab: {
              ...tab,
              ...(retained?.automaticTitleState
                ? { automaticTitleState: retained.automaticTitleState }
                : {}),
            },
            replaceTranscript: true,
          });
        }
        if (tabsFile.tabs.length > 0) {
          mutations.push({
            type: 'tab.order_changed',
            tabIds: tabsFile.tabs.map((tab) => tab.id),
          });
          mutations.push({
            type: 'tab.active_changed',
            activeTabId: incomingTabIds.has(tabsFile.activeTabId)
              ? tabsFile.activeTabId
              : tabsFile.tabs[0].id,
            ...(tabsFile.lastActiveEditableChatId
              ? {
                  lastActiveEditableChatId: tabsFile.lastActiveEditableChatId,
                }
              : {}),
            ...(tabsFile.lastActiveChatProvider
              ? { lastActiveChatProvider: tabsFile.lastActiveChatProvider }
              : {}),
          });
        }
        const incomingQuestions = new Set(
          (tabsFile.pendingQuestions ?? []).map(
            (question) => question.requestId,
          ),
        );
        for (const question of current.tabsFile.pendingQuestions ?? []) {
          if (!incomingQuestions.has(question.requestId)) {
            mutations.push({
              type: 'pending_question.removed',
              requestId: question.requestId,
              chatId: question.chatId,
            });
          }
        }
        for (const question of tabsFile.pendingQuestions ?? []) {
          mutations.push({ type: 'pending_question.upserted', question });
        }
        const incomingArchiveIds = new Set(
          archivesFile.archived.map((entry) => entry.tab.id),
        );
        for (const entry of current.archivesFile.archived) {
          if (!incomingArchiveIds.has(entry.tab.id)) {
            mutations.push({
              type: 'archive.removed',
              archiveEntryId: entry.tab.id,
              chatId: entry.tab.id,
            });
          }
        }
        for (const entry of [...archivesFile.archived].reverse()) {
          const retained =
            current.tabsFile.tabs.find((tab) => tab.id === entry.tab.id) ??
            current.archivesFile.archived.find(
              (candidate) => candidate.tab.id === entry.tab.id,
            )?.tab;
          mutations.push({
            type: 'archive.upserted',
            entry: {
              ...entry,
              tab: {
                ...entry.tab,
                ...(retained?.automaticTitleState
                  ? { automaticTitleState: retained.automaticTitleState }
                  : {}),
              },
            },
            replaceTranscript: true,
          });
        }
        return mutations;
      },
      { source: 'import', checkpoint: true, fullTranscript: true },
    );
  }

  public async replaceCompatibilityArchives(
    scope: ChatScopeKey,
    archivesFile: ArchivedChatsFile,
    options: { authoritative?: boolean } = {},
  ): Promise<ArchivedChatsFile> {
    const commit = await this.repository.transactWith(
      scope,
      (current, _revision, transaction) => {
        const mutations: ChatCoreMutation[] = [];
        const freshCompatibilitySnapshot =
          archivesFile.revision !== undefined &&
          archivesFile.revision === current.archivesFile.revision;
        const incomingArchiveIds = new Set(
          archivesFile.archived.map((entry) => entry.tab.id),
        );
        const currentById = new Map(
          current.archivesFile.archived.map((entry) => [entry.tab.id, entry]),
        );
        if (freshCompatibilitySnapshot || options.authoritative) {
          for (const entry of current.archivesFile.archived) {
            if (!incomingArchiveIds.has(entry.tab.id)) {
              mutations.push({
                type: 'archive.removed',
                archiveEntryId: entry.tab.id,
                chatId: entry.tab.id,
              });
            }
          }
        }
        for (const entry of [...archivesFile.archived].reverse()) {
          if (
            !currentById.has(entry.tab.id) &&
            options.authoritative !== true &&
            transaction.hasRemovedArchiveEntry(entry.tab.id)
          ) {
            continue;
          }
          const canonical = currentById.get(entry.tab.id);
          let next =
            freshCompatibilitySnapshot ||
            options.authoritative === true ||
            !canonical
              ? entry
              : canonical;
          // Main owns naming state, so even an authoritative snapshot keeps
          // the canonical value; a stale archive entry cannot reopen naming.
          if (canonical?.tab.automaticTitleState) {
            next = {
              ...next,
              tab: {
                ...next.tab,
                automaticTitleState: canonical.tab.automaticTitleState,
              },
            };
          }
          if (canonical && options.authoritative !== true) {
            const tab = { ...next.tab };
            if (
              Object.prototype.propertyIsEnumerable.call(next.tab, 'messages')
            ) {
              // V2 keeps unselected canonical rows on disk. Omitting them from
              // this upsert preserves them without hydrating the transcript.
              const retained = Object.prototype.propertyIsEnumerable.call(
                canonical.tab,
                'messages',
              )
                ? canonical.tab.messages.filter(isMcpActivationMessage)
                : [];
              tab.messages = mergePersistedMessagesById(
                retained,
                next.tab.messages.filter(
                  (message) => !isMcpActivationMessage(message),
                ),
              );
            }
            for (const key of [
              'mcpActivation',
              'inputDelivery',
              'trackedPlanImplementation',
              'lastAcceptedUserMessageId',
              'unacceptedTurnEnds',
              'turnEnds',
              'rootTurnInputIds',
              'reducedRootTerminalTurnIds',
              'interruptedTurns',
              'autoArchiveTurnId',
            ] as const) {
              if (canonical.tab[key] === undefined) delete tab[key];
              else Object.assign(tab, { [key]: canonical.tab[key] });
            }
            next = { ...next, tab };
          }
          // The fence is host metadata no compatibility file carries.
          if (canonical?.turnFence && !next.turnFence)
            next = { ...next, turnFence: canonical.turnFence };
          mutations.push({
            type: 'archive.upserted',
            ...(options.authoritative
              ? { replaceTranscript: true as const }
              : {}),
            entry: next,
          });
        }
        return mutations;
      },
      {
        source: 'import',
        checkpoint: true,
        fullTranscript: options.authoritative === true,
      },
    );
    return commit.state.archivesFile;
  }

  public async readCompatibilityArchive(
    scope: ChatScopeKey,
    chatId: string,
    fullTranscript = true,
  ): Promise<ArchivedChatEntry | null> {
    const state = await this.repository.getState(scope, {
      chatIds: [chatId],
      fullTranscript,
      pageOnly: !fullTranscript,
    });
    return (
      state.archivesFile.archived.find((entry) => entry.tab.id === chatId) ??
      null
    );
  }

  public async removeCompatibilityArchive(
    scope: ChatScopeKey,
    chatId: string,
  ): Promise<ArchivedChatEntry | null> {
    let removed: ArchivedChatEntry | null = null;
    await this.repository.transactWith(
      scope,
      (current) => {
        removed =
          current.archivesFile.archived.find(
            (entry) => entry.tab.id === chatId,
          ) ?? null;
        return removed
          ? [
              {
                type: 'archive.removed' as const,
                archiveEntryId: chatId,
                chatId,
              },
            ]
          : [];
      },
      { source: 'migration', checkpoint: true },
    );
    return removed;
  }

  public async copyStorageChats(
    source: ChatScopeKey,
    destination: ChatScopeKey,
    tabsFile: ChatTabsFile,
    archivesFile: ArchivedChatsFile = { version: 1, archived: [] },
    sourceChatIds?: Readonly<Record<string, string>>,
    transformMessage?: ChatStorageImportOptions['transformMessage'],
    throughMessageIds?: ChatStorageImportOptions['throughMessageIds'],
    beforePublish?: ChatStorageImportOptions['beforePublish'],
    preparePublish?: ChatStorageImportOptions['preparePublish'],
  ): Promise<void> {
    await this.repository.copyChats(
      source,
      destination,
      { tabsFile, archivesFile },
      sourceChatIds,
      transformMessage,
      throughMessageIds,
      beforePublish,
      preparePublish,
    );
  }

  public async captureStorageScope(
    scope: ChatScopeKey,
    destination: ChatStorageV2,
    allowDuringScopeDeletion = false,
    captureExecutor?: (
      source: ChatStorageV2,
      destination: ChatStorageV2,
    ) => Promise<void>,
  ): Promise<void> {
    await this.repository.captureScope(
      scope,
      destination,
      allowDuringScopeDeletion,
      captureExecutor,
    );
  }

  public async importStorageScope(
    scope: ChatScopeKey,
    source: ChatStorageV2,
    tabsFile: ChatTabsFile,
    archivesFile: ArchivedChatsFile,
    options: ChatStorageImportOptions = {},
  ): Promise<void> {
    this.turnHandoff.invalidateScope(scope);
    await this.repository.importScope(
      scope,
      source,
      { tabsFile, archivesFile },
      options,
    );
  }

  public flushScope(projectId: string, worktreeId: string): Promise<void> {
    return this.repository.flushScope({ projectId, worktreeId });
  }

  public flushScopeForArchivedContainerCaptureDuringDeletion(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    return this.repository.flushScope(
      { projectId, worktreeId },
      { allowDuringScopeDeletion: true },
    );
  }

  public async drain(): Promise<void> {
    this.draining = true;
    try {
      await this.turnHandoff.flushAll();
      await this.repository.drainAll();
    } finally {
      // Stay installed: a late caller must reach this drained repository.
      this.disposeTurnHandoff();
      if (chatStateService === this) {
        setTurnLifecycleSink(null);
        setTurnLifecycleEndedLookup(null);
      }
      this.unsubscribeStorageDiagnostics();
      this.uninstallScopeResidencyHook();
    }
  }

  /**
   * Admit a scope-local operation before its first asynchronous preparation.
   * Deletion closes admission first, then waits for every admitted operation
   * so none can create a provider session after the cleanup sweep.
   */
  public async runWithScopeActivity<T>(
    scope: ChatScopeKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lifecycleKey = chatScopeLifecycleKey(scope);
    const inheritedLeases = (this.scopeActivityLeases.getStore() ?? []).filter(
      (lease) => lease.active,
    );
    if (this.isScopeDeletionBlocking(lifecycleKey)) {
      throw new ChatScopeDeletingError();
    }
    this.activeScopeOperations.set(
      lifecycleKey,
      (this.activeScopeOperations.get(lifecycleKey) ?? 0) + 1,
    );
    const lease: ScopeActivityLease = { lifecycleKey, active: true };
    try {
      return await this.scopeActivityLeases.run(
        [...inheritedLeases, lease],
        operation,
      );
    } finally {
      lease.active = false;
      const remaining = (this.activeScopeOperations.get(lifecycleKey) ?? 1) - 1;
      if (remaining > 0) {
        this.activeScopeOperations.set(lifecycleKey, remaining);
      } else {
        this.activeScopeOperations.delete(lifecycleKey);
        const waiters = this.scopeOperationDrainWaiters.get(lifecycleKey);
        this.scopeOperationDrainWaiters.delete(lifecycleKey);
        waiters?.forEach((resolve) => resolve());
      }
    }
  }

  private isScopeDeletionBlocking(lifecycleKey: string): boolean {
    if (!this.deletingScopeIds.has(lifecycleKey)) {
      return false;
    }
    return !(this.scopeActivityLeases.getStore() ?? []).some(
      (lease) => lease.active && lease.lifecycleKey === lifecycleKey,
    );
  }

  private waitForScopeActivityDrain(lifecycleKey: string): Promise<void> {
    if (!this.activeScopeOperations.has(lifecycleKey)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiters =
        this.scopeOperationDrainWaiters.get(lifecycleKey) ?? new Set();
      waiters.add(resolve);
      this.scopeOperationDrainWaiters.set(lifecycleKey, waiters);
    });
  }

  /**
   * Keep service-level command paths closed while an outer cleanup still needs
   * repository writes (for example, provider teardown event commits). Nested
   * callers are ref-counted so an inner deletion fence cannot release the
   * outer lifecycle boundary early.
   */
  public async runWithScopeDeletionLifecycle<T>(
    scope: ChatScopeKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lifecycleKey = chatScopeLifecycleKey(scope);
    this.deletingScopeIds.set(
      lifecycleKey,
      (this.deletingScopeIds.get(lifecycleKey) ?? 0) + 1,
    );
    try {
      await this.waitForScopeActivityDrain(lifecycleKey);
      return await operation();
    } finally {
      const remaining = (this.deletingScopeIds.get(lifecycleKey) ?? 1) - 1;
      if (remaining <= 0) {
        this.deletingScopeIds.delete(lifecycleKey);
      } else {
        this.deletingScopeIds.set(lifecycleKey, remaining);
      }
    }
  }

  /**
   * Keep every mutating chat path and repository write closed for the full
   * lifetime of a larger scope cleanup.
   */
  public async runWithScopeDeletion<T>(
    scope: ChatScopeKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runWithScopeDeletionLifecycle(scope, async () => {
      return this.repository.runWithScopeDeletion(scope, async () => {
        return operation();
      });
    });
  }

  /** Remove only a new tab whose unstarted contents still belong to this send. */
  public async rollbackUnstartedCoworkTab(
    scope: ChatScopeKey,
    chatId: string,
    messageIds: readonly string[],
    allowDuringScopeDeletion = false,
  ): Promise<void> {
    await this.repository.transactWith(
      scope,
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        if (
          !tab ||
          current.runtimeByChatId[chatId]?.activeTurn ||
          tab.messages.some((message) => !messageIds.includes(message.id)) ||
          (tab.inputDelivery !== undefined &&
            (!isInputLedger(tab.inputDelivery) ||
              tab.inputDelivery.rows.length > 0))
        )
          return [];
        return [{ type: 'tab.removed', tabId: chatId }];
      },
      {
        source: 'migration',
        mutationId: randomUUID(),
        chatIds: [chatId],
        allowDuringScopeDeletion,
      },
    );
  }

  /**
   * Commit removal of every canonical entity, then drain the scope and delete
   * its snapshots, backups, journal, and recovery sidecars. Callers destroy
   * provider sessions before entering this boundary.
   */
  public async deleteScope(scope: ChatScopeKey): Promise<void> {
    await this.runWithScopeDeletion(scope, async () => {
      const removedTabIds = new Set<string>();
      await this.repository.transactWith(
        scope,
        (current) => {
          for (const tab of current.tabsFile.tabs) removedTabIds.add(tab.id);
          return [
            ...current.tabsFile.tabs.map(
              (tab): ChatCoreMutation => ({
                type: 'tab.removed',
                tabId: tab.id,
              }),
            ),
            ...current.archivesFile.archived.map(
              (entry): ChatCoreMutation => ({
                type: 'archive.removed',
                archiveEntryId: entry.tab.id,
                chatId: entry.tab.id,
              }),
            ),
          ];
        },
        {
          source: 'migration',
          mutationId: `scope-delete:${scope.projectId}:${scope.worktreeId}`,
          checkpoint: true,
          allowDuringScopeDeletion: true,
        },
      );
      await this.repository.deleteEmptyScope(scope);
      const key = `${scope.projectId}\u0000${scope.worktreeId}`;
      const active = this.activeChatTabsProjections.get(key);
      if (
        active?.generation === (this.projectionGenerationByScope.get(key) ?? 0)
      ) {
        active.projection.changedTabIds.forEach((id) => removedTabIds.add(id));
        active.projection.removedTabIds.forEach((id) => removedTabIds.add(id));
      }
      this.scopesAwaitingProjectionReadmission
        .get(key)
        ?.forEach((id) => removedTabIds.add(id));
      this.scopesAwaitingProjectionReadmission.set(key, removedTabIds);
    });
  }

  private async createTab(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    file: boolean,
    canCommitCreate?: () => boolean,
    preserveActiveTab?: true,
  ): Promise<ChatCommandResult> {
    const command = envelope.command;
    const tabId = 'tabId' in command ? command.tabId : '';
    const createdAt = new Date(this.now()).toISOString();
    const invalidSeed =
      command.type === 'chat.create_tab' &&
      command.seedTab !== undefined &&
      (command.seedTab.id !== command.tabId ||
        !isPersistedChatTab(command.seedTab));
    if (invalidSeed) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(envelope, revision, 'rejected', {
        reason: 'The seeded chat tab is invalid or has a mismatched id',
      });
    }
    const tab =
      file && command.type === 'chat.create_file_tab'
        ? createPersistedFileTab({
            id: command.tabId,
            filePath: command.filePath,
            createdAt,
            ...(command.title ? { title: command.title } : {}),
            ...(command.viewMode ? { viewMode: command.viewMode } : {}),
            ...(command.pinned ? { pinned: true } : {}),
          })
        : command.type === 'chat.create_tab'
          ? persistedChatTabFromCreateCommand(
              command,
              createdAt,
              scope.projectId,
            )
          : undefined;
    if (!tab) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(envelope, revision, 'rejected');
    }
    const starter = command.type === 'chat.create_tab' && command.starter;
    let existingChatId: string | undefined;
    const commit = await this.repository.transactWith(
      scope,
      (current, _revision, context) => {
        if (canCommitCreate?.() === false)
          throw new ChatSendAuthorizationRevokedError(
            'The paired session no longer authorizes this chat creation.',
          );
        existingChatId = undefined;
        if (current.tabsFile.tabs.some((candidate) => candidate.id === tabId)) {
          return [];
        }
        if (context.hasRemovedTab(tabId)) {
          return [];
        }
        if (starter) {
          existingChatId = current.tabsFile.tabs.find(
            (candidate) => (candidate.kind ?? 'chat') === 'chat',
          )?.id;
          if (existingChatId !== undefined) return [];
        }
        const mutations: ChatCoreMutation[] = [{ type: 'tab.created', tab }];
        if (
          (!preserveActiveTab || !current.tabsFile.activeTabId) &&
          (command.type !== 'chat.create_file_tab' ||
            command.activate !== false)
        )
          mutations.push({ type: 'tab.active_changed', activeTabId: tab.id });
        return mutations;
      },
      {
        source: 'renderer-command',
        mutationId: envelope.commandId,
        commandResult: {
          commandId: envelope.commandId,
          outcome: 'applied',
          entityId: tab.id,
        },
        ...expectedRevisionOption(envelope),
        ...(canCommitCreate
          ? {
              beforePublish: (): void => {
                if (!canCommitCreate())
                  throw new ChatSendAuthorizationRevokedError(
                    'The paired session no longer authorizes this chat creation.',
                  );
              },
            }
          : {}),
      },
    );
    const tabExists = commit.state.tabsFile.tabs.some(
      (candidate) => candidate.id === tabId,
    );
    if (!tabExists && existingChatId !== undefined) {
      // The starter is unnecessary: the scope already has this chat.
      return commandResult(envelope, commit.revision, 'already_applied', {
        entityId: existingChatId,
        reason: 'The scope already has a chat',
      });
    }
    const outcome: ChatCommandResult['outcome'] = !tabExists
      ? 'not_found'
      : commit.applied
        ? 'applied'
        : 'already_applied';
    return commandResult(
      envelope,
      commit.revision,
      outcome,
      outcome === 'not_found'
        ? { reason: 'The tab id is tombstoned' }
        : { entityId: tab.id },
    );
  }

  private async importSession(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.import_session' }>,
  ): Promise<ChatCommandResult> {
    const state = await this.repository.getState(scope);
    const { targetChatId, source } = command;
    if (state.tabsFile.tabs.some((tab) => tab.id === targetChatId)) {
      return commandResult(
        envelope,
        state.tabsFile.revision ?? 0,
        'already_applied',
        { entityId: targetChatId },
      );
    }
    if (await this.repository.hasRemovedTab(scope, targetChatId)) {
      return commandResult(
        envelope,
        state.tabsFile.revision ?? 0,
        'not_found',
        {
          reason: 'The imported chat id is tombstoned',
        },
      );
    }
    if (source.kind !== 'transcript') {
      return commandResult(envelope, state.tabsFile.revision ?? 0, 'rejected', {
        reason:
          'Session export imports must first be resolved by the trusted main import adapter',
      });
    }

    const parsed = parseAgentTranscriptLines(
      source.content.split(/\r?\n/),
      source.providerType,
      { closeOpenTurnAtEnd: true },
    );
    if (parsed.messages.length === 0) {
      return commandResult(envelope, state.tabsFile.revision ?? 0, 'rejected', {
        reason: 'The transcript did not contain any valid chat messages',
      });
    }
    const now = this.now();
    const tab: PersistedChatTab = {
      ...createPersistedChatTab({
        id: targetChatId,
        title: 'Imported chat',
        createdAt: new Date(now).toISOString(),
        providerType: parsed.providerType ?? source.providerType,
      }),
      ...newChatPluginDefaultsStamp(scope.projectId),
      messages: parsed.messages,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      ...(parsed.agentUsage ? { agentUsage: parsed.agentUsage } : {}),
    };
    this.turnHandoff.invalidate({ ...scope, chatId: targetChatId });
    return this.commit(
      scope,
      envelope,
      [
        { type: 'tab.created', tab },
        { type: 'tab.active_changed', activeTabId: targetChatId },
        {
          type: 'runtime.patched',
          chatId: targetChatId,
          runtime: {
            status: 'completed',
            queuedMessageIds: [],
            lastActivityAt: now,
            turn: serializeChatTurnState(initialChatTurnState()),
          },
        },
      ],
      { entityId: targetChatId },
    );
  }

  private async commit(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    mutations: ChatCoreMutation[],
    details: Partial<Pick<ChatCommandResult, 'entityId' | 'messageId'>> = {},
  ): Promise<ChatCommandResult> {
    try {
      const commit = await this.repository.transact(scope, mutations, {
        ...{
          source: 'renderer-command',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
            ...details,
          },
          ...expectedRevisionOption(envelope),
        },
        fullTranscript: mutations.some(
          (mutation) => mutation.type === 'messages.replaced',
        ),
      });
      // A retained mutation id with an evicted receipt replays as a no-op.
      return commandResult(
        envelope,
        commit.revision,
        commit.applied ? 'applied' : 'already_applied',
        details,
      );
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        {
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async commitExistingTabCommand(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    tabId: string,
    mutations: ChatCoreMutation[],
  ): Promise<ChatCommandResult> {
    const state = await this.repository.getState(scope);
    if (!state.tabsFile.tabs.some((tab) => tab.id === tabId)) {
      return commandResult(envelope, state.tabsFile.revision ?? 0, 'not_found');
    }
    return this.commit(scope, envelope, mutations, { entityId: tabId });
  }

  private async activateTab(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    tabId: string,
  ): Promise<ChatCommandResult> {
    let outcome: ChatCommandResult['outcome'] = 'applied';
    try {
      const commit = await this.repository.transactWith(
        scope,
        (current) => {
          const target = current.tabsFile.tabs.find((tab) => tab.id === tabId);
          if (!target) {
            outcome = 'not_found';
            return [];
          }
          const currentActive = current.tabsFile.tabs.find(
            (tab) => tab.id === current.tabsFile.activeTabId,
          );
          const lastActiveEditableChatId = isEditablePersistedChatTab(target)
            ? target.id
            : isEditablePersistedChatTab(currentActive)
              ? currentActive?.id
              : current.tabsFile.lastActiveEditableChatId;
          const lastActiveChatProvider =
            persistedTabProvider(target) ??
            persistedTabProvider(currentActive) ??
            current.tabsFile.lastActiveChatProvider;
          return [
            {
              type: 'tab.active_changed',
              activeTabId: tabId,
              ...(lastActiveEditableChatId ? { lastActiveEditableChatId } : {}),
              ...(lastActiveChatProvider ? { lastActiveChatProvider } : {}),
            },
          ];
        },
        {
          source: 'renderer-command',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
            entityId: tabId,
          },
          ...expectedRevisionOption(envelope),
        },
      );
      if (!commit.applied && outcome === 'applied') {
        outcome = 'already_applied';
      }
      return commandResult(envelope, commit.revision, outcome, {
        entityId: tabId,
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async patchTabSettings(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.patch_tab_settings' }>,
  ): Promise<ChatCommandResult> {
    // Trusted callers bypass IPC validation, and a patch the core schema
    // rejects falls through to this port.
    if (Object.prototype.hasOwnProperty.call(command.patch, 'approvalMode')) {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
        {
          reason: 'Approval mode changes only through chat.set_approval_mode.',
        },
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(command.patch, 'autoArchiveTurnId')
    )
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
        { reason: 'Main records the turn that owns the auto-archive marker.' },
      );
    // Commit the chat's pending turn state first, so a marker set while idle
    // can only be adopted by a turn that starts after it (CAN-6014).
    if (command.patch.autoArchive === true)
      await this.turnHandoff
        .flush({ ...scope, chatId: command.tabId })
        .catch((error: unknown) => {
          logMainProcessWarn(
            '[chat-state] Turn state could not commit before an auto-archive marker:',
            error instanceof Error ? error.message : String(error),
          );
        });
    let outcome: ChatCommandResult['outcome'] = 'applied';
    try {
      const commit = await this.repository.transactWith(
        scope,
        (current) => {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === command.tabId,
          );
          if (!tab) {
            outcome = 'not_found';
            return [];
          }
          const link = command.patch.trackedPlanImplementation;
          if (link !== undefined && link !== null) {
            const prior = tab.trackedPlanImplementation;
            if (
              !TrackedPlanImplementationInputSchema.safeParse(link).success ||
              !prior ||
              prior.planId !== link.planId ||
              prior.revisionNumber !== link.revisionNumber ||
              prior.userMessageId !== link.userMessageId ||
              prior.startedAt !== link.startedAt
            ) {
              outcome = 'rejected';
              return [];
            }
          }
          if (
            command.expectedPendingPlanExitRequestId !== undefined &&
            (tab.pendingPlanExitRequestId !==
              command.expectedPendingPlanExitRequestId ||
              (tab.pendingPlanExit?.source === 'opencode' &&
                current.runtimeByChatId[command.tabId]?.activeTurn !==
                  undefined))
          ) {
            // A revision is saved before its new review request. The old
            // request must not approve that revision during publication.
            outcome = 'conflict';
            return [];
          }
          if (
            command.expectedPendingPlanExitRequestId !== undefined &&
            (command.patch.pendingPlanExit === null ||
              command.patch.pendingPlanExitRequestId === null ||
              command.patch.planMode === false ||
              command.patch.trackedPlanReviewStatus === 'approved' ||
              command.patch.trackedPlanReviewStatus === 'dismissed') &&
            isPlanProposal({
              ...tab.pendingPlanExit,
              source: tab.pendingPlanExit?.source ?? tab.trackedPlanSource,
            }) &&
            ['starting', 'streaming', 'awaiting_input', 'completing'].includes(
              current.runtimeByChatId[command.tabId]?.status ?? 'idle',
            )
          ) {
            outcome = 'conflict';
            return [];
          }
          if (
            command.expectedPluginSelections !== undefined &&
            !isDeepStrictEqual(
              normalizePluginSelections(tab.pluginSelections),
              normalizePluginSelections(command.expectedPluginSelections),
            )
          ) {
            outcome = 'conflict';
            return [];
          }
          return [
            {
              type: 'tab.metadata_patched',
              tabId: command.tabId,
              patch: {
                ...command.patch,
                ...autoArchiveOwnerPatch(
                  command.patch.autoArchive,
                  this.turnHandoff.getState({ ...scope, chatId: tab.id }) ??
                    current.runtimeByChatId[tab.id]?.turn,
                ),
                ...(command.patch.customTitle?.trim() ||
                (command.patch.customTitle === null && tab.customTitle?.trim())
                  ? { automaticTitleState: 'closed' as const }
                  : {}),
              },
            },
          ];
        },
        {
          source: 'renderer-command',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
            entityId: command.tabId,
          },
          ...expectedRevisionOption(envelope),
        },
      );
      if (!commit.applied && outcome === 'applied') {
        outcome = 'already_applied';
      }
      return commandResult(envelope, commit.revision, outcome, {
        entityId: command.tabId,
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async setApprovalMode(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.set_approval_mode' }>,
  ): Promise<ChatCommandResult> {
    let outcome: ChatCommandResult['outcome'] = 'applied';
    try {
      const commit = await this.repository.transactWith(
        scope,
        (current) => {
          if (!current.tabsFile.tabs.some((tab) => tab.id === command.tabId)) {
            outcome = 'not_found';
            return [];
          }
          return [
            {
              type: 'tab.metadata_patched',
              tabId: command.tabId,
              patch: { approvalMode: command.approvalMode },
            },
          ];
        },
        {
          source: 'renderer-command',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
            entityId: command.tabId,
          },
          ...expectedRevisionOption(envelope),
        },
      );
      if (!commit.applied && outcome === 'applied') {
        outcome = 'already_applied';
      }
      return commandResult(envelope, commit.revision, outcome, {
        entityId: command.tabId,
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async patchWholeTab(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    tabId: string,
    patch: (
      tab: PersistedChatTab,
      runtime?: ChatRuntimeState,
    ) => PersistedChatTab,
  ): Promise<ChatCommandResult> {
    try {
      const commit = await this.repository.transactWith(
        scope,
        (current) => {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === tabId,
          );
          return tab
            ? [
                {
                  type: 'tab.created',
                  tab: patch(tab, current.runtimeByChatId[tabId]),
                },
              ]
            : [];
        },
        {
          ...{
            source: 'renderer-command',
            mutationId: envelope.commandId,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'applied',
              entityId: tabId,
            },
            ...expectedRevisionOption(envelope),
          },
          chatIds: [tabId],
        },
      );
      if (
        !commit.state.tabsFile.tabs.some((candidate) => candidate.id === tabId)
      ) {
        // Read/attention clears are idempotent desired-state patches. A view
        // can acknowledge a renderer-created starter tab just before the
        // trusted send materializes it in main; absence already satisfies the
        // clear and must not be treated as a destructive stale-entity conflict.
        return commandResult(envelope, commit.revision, 'already_applied');
      }
      return commandResult(envelope, commit.revision, 'applied', {
        entityId: tabId,
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async setModel(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
  ): Promise<ChatCommandResult> {
    const command = envelope.command;
    if (command.type !== 'chat.set_model') {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
      );
    }
    if (command.autoRoutedMessageId !== undefined) {
      validateId(command.autoRoutedMessageId, 'auto-routed message id');
    }
    if (command.notice) {
      validateId(command.notice.id, 'model change notice id');
      if (
        !Number.isFinite(command.notice.timestamp) ||
        !command.notice.text.trim()
      ) {
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          'rejected',
          { reason: 'Invalid model change notice' },
        );
      }
    }
    return this.patchWholeTab(
      scope,
      envelope,
      command.tabId,
      (tab, runtime) => {
        const currentProvider =
          tab.providerType ??
          (tab.model ? getProviderForModel(tab.model) : command.providerType);
        const currentHarness =
          tab.executionHarness ??
          (currentProvider === 'opencode' ? 'opencode' : undefined) ??
          (tab.model ? getExecutionHarnessForModel(tab.model) : undefined);
        const targetHarness = resolveChatModelChangeHarness(
          tab,
          command.model,
          command.executionHarness,
        );
        const started =
          hasChatContinuationSession(tab) ||
          tab.messages.length > 0 ||
          (runtime?.queuedMessageIds.length ?? 0) > 0 ||
          Boolean(
            runtime &&
            [
              'queued',
              'starting',
              'streaming',
              'awaiting_input',
              'completing',
            ].includes(runtime.status),
          );
        if (
          command.executionHarness !== undefined ||
          targetHarness === 'opencode'
        ) {
          if (
            !targetHarness ||
            !supportsChatHarnessChoice(command.model, targetHarness)
          ) {
            throw new Error(
              'This model does not support the selected harness.',
            );
          }
          const autoStartingFirstTurn =
            command.preserveModelSelectionMode === true &&
            tab.sdkSessionId === undefined &&
            tab.messages.length === 1 &&
            runtime?.status === 'starting';
          // A started chat changes harness only with its provider, where
          // the pair switches in place (CAN-6445).
          if (
            !autoStartingFirstTurn &&
            started &&
            currentHarness !== targetHarness &&
            !canSwitchProviderInPlace(currentProvider, command.providerType)
          ) {
            throw new Error('Start a new chat to change its harness.');
          }
        }
        if (
          targetHarness === 'opencode' &&
          command.providerType !== 'opencode'
        ) {
          throw new Error(
            'The selected provider does not match the OpenCode harness.',
          );
        }
        if (
          currentHarness === 'opencode' &&
          started &&
          (targetHarness !== 'opencode' ||
            isNativeOpenCodeSelection(tab.model) !==
              isNativeOpenCodeSelection(command.model))
        ) {
          throw new Error(
            'Start a new chat to change the OpenCode billing selection.',
          );
        }
        const harnessChanged =
          currentHarness !== undefined &&
          targetHarness !== undefined &&
          currentHarness !== targetHarness;
        const leavesTerminalMode =
          isTerminalBackedInterfaceMode(tab.interfaceMode) &&
          !isTerminalBackedInterfaceMode(
            command.settings
              ? (command.settings.interfaceMode ?? undefined)
              : tab.interfaceMode,
          );
        const next: PersistedChatTab = {
          ...tab,
          model: command.model,
          providerType: command.providerType,
          modelExplicitlyChosen: true,
          messages:
            command.notice &&
            !tab.messages.some((message) => message.id === command.notice?.id)
              ? [
                  ...tab.messages,
                  {
                    id: command.notice.id,
                    role: 'system',
                    timestamp: command.notice.timestamp,
                    blocks: [{ type: 'text', text: command.notice.text }],
                  },
                ]
              : tab.messages,
          ...(command.autoRoutedMessageId !== undefined
            ? {
                autoRoutedModels: {
                  ...tab.autoRoutedModels,
                  [command.autoRoutedMessageId]: command.model,
                },
              }
            : {}),
        };
        if (command.preserveModelSelectionMode !== true) {
          delete next.modelSelectionMode;
        }
        if (currentProvider !== command.providerType) {
          delete next.modelConfig;
          delete next.thinkingLevel;
          delete next.codexFastModeEnabled;
          delete next.interfaceMode;
          if (currentProvider === 'codex') {
            // Keep the requested Codex speed while the chat runs another
            // provider, in this same durable command, so returning to Codex
            // restores the user's choice instead of the provider default.
            const retainedCodexSpeed = readCodexSpeedRecord(
              tab.modelConfig,
              tab.codexFastModeEnabled,
            );
            if (retainedCodexSpeed === undefined) {
              delete next.retainedCodexSpeed;
            } else {
              next.retainedCodexSpeed = retainedCodexSpeed;
            }
          } else if (command.providerType === 'codex') {
            // Returning to Codex consumes the retained speed atomically. The
            // model-change path restores it into `settings`, which replaces
            // this below; a settings-less change (such as a Remote Control
            // model pick) restores it here instead of dropping it.
            if (isCodexSpeed(tab.retainedCodexSpeed)) {
              next.modelConfig = withCodexSpeed(
                undefined,
                tab.retainedCodexSpeed,
              );
            }
            delete next.retainedCodexSpeed;
          }
          // The harness is pinned only while a conversation stays on the same
          // provider family. A cross-provider model change (including an
          // organization-policy fallback) must let the next send resolve and
          // persist the new model's harness; retaining the old pin would route a
          // visibly Claude model through Codex, or vice versa. A pick that names
          // the new model's harness pins that one.
          if (command.executionHarness !== undefined && targetHarness) {
            next.executionHarness = targetHarness;
            next.executionHarnessExplicitlyChosen = true;
          } else {
            delete next.executionHarness;
          }
          // The outgoing provider's session is parked, never deleted, so
          // switching back can resume it (CAN-6445).
          applyProviderSwitchToSession(
            tab,
            next,
            currentProvider,
            command.providerType,
          );
        } else if (harnessChanged) {
          resetSessionForHarnessChange(tab, next);
        } else if (leavesTerminalMode) {
          delete next.sdkSessionId;
          delete next.globalInstructionsSnapshot;
          delete next.codexReconstructionSeedId;
          delete next.claudeForkSessionOnNextSend;
          delete next.claudeTerminal;
        }
        if (
          targetHarness === 'cursor' ||
          command.providerType === 'cursor' ||
          targetHarness === 'copilot' ||
          targetHarness === 'antigravity' ||
          command.providerType === 'copilot' ||
          command.providerType === 'antigravity' ||
          targetHarness === 'opencode' ||
          command.providerType === 'opencode'
        ) {
          // Cursor bills only through the connected Cursor account. Clear the
          // incompatible routing in the same durable command as the model so no
          // caller-dependent follow-up patch can leave a Cursor tab routed to
          // AI Credits, which the provider rejects on every send.
          delete next.aiCreditsRouting;
          delete next.subscriptionBillingOverride;
          delete next.billingExplicitlyChosen;
        }
        if (command.settings) {
          const settingsModelConfig = canonicalizeAgentModelConfig(
            command.settings.modelConfig,
          );
          next.thinkingLevel = command.settings.thinkingLevel;
          next.modelConfig = settingsModelConfig;
          // The deprecated alias only projects the stored speed.
          next.codexFastModeEnabled =
            settingsModelConfig.fastMode ??
            command.settings.codexFastModeEnabled;
          if (command.settings.interfaceMode) {
            next.interfaceMode = command.settings.interfaceMode;
          } else {
            delete next.interfaceMode;
          }
        }
        if (targetHarness === 'opencode') {
          next.executionHarness = 'opencode';
          next.executionHarnessExplicitlyChosen = true;
        } else if (tab.messages.length === 0) {
          if (
            command.executionHarness !== undefined ||
            (tab.model === command.model &&
              tab.executionHarnessExplicitlyChosen === true)
          ) {
            next.executionHarness = targetHarness;
            next.executionHarnessExplicitlyChosen = true;
          } else {
            delete next.executionHarness;
            delete next.executionHarnessExplicitlyChosen;
          }
        }
        return next;
      },
    );
  }

  private async sendMessage(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    options: TrustedChatCommandExecutionOptions = {},
    asyncAnswer?: { questionId: string; answers: McpQuestionAnswer[] },
  ): Promise<ChatCommandResult> {
    const originalCommand = envelope.command;
    const command =
      originalCommand.type === 'chat.send_message' &&
      options.agentSent !== undefined
        ? { ...originalCommand, agentSent: options.agentSent }
        : originalCommand;
    if (command.type !== 'chat.send_message') {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
      );
    }
    validateId(command.chatId, 'chatId');
    validateId(command.userMessageId, 'userMessageId');
    const release = this.holdDispatch(
      chatRuntimeHostKey(scope, command.chatId),
    );
    return withLegacyChatMessageCommand(
      envelope,
      () =>
        this.sendAcceptedMessage(
          scope,
          envelope,
          command,
          options,
          asyncAnswer,
        ),
      undefined,
      options,
    ).finally(release);
  }

  /**
   * Whether this message was admitted and its turn waits for its worktree's
   * Git setup before it dispatches.
   */
  public isAwaitingWorktreeSetup(
    target: ChatScopeKey & { chatId: string; userMessageId: string },
  ): boolean {
    return this.heldSends.has(awaitingSetupKey(target, target));
  }

  /**
   * Mark a chat's turn as being dispatched by this process, so a snapshot read
   * meanwhile cannot settle its runtime as interrupted by an app restart.
   * Callers outside the send command (hook, rebase, builtin chats) hold this
   * until the provider owns the turn.
   */
  public holdRuntimeHost(
    target: ChatScopeKey & { chatId: string },
  ): () => void {
    return this.holdDispatch(chatRuntimeHostKey(target, target.chatId));
  }

  private holdDispatch(runtimeHostKey: string): () => void {
    this.dispatchesInFlight.set(
      runtimeHostKey,
      (this.dispatchesInFlight.get(runtimeHostKey) ?? 0) + 1,
    );
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const remaining = (this.dispatchesInFlight.get(runtimeHostKey) ?? 1) - 1;
      if (remaining > 0) {
        this.dispatchesInFlight.set(runtimeHostKey, remaining);
      } else {
        this.dispatchesInFlight.delete(runtimeHostKey);
      }
    };
  }

  /**
   * Whether an async answer crossed into durable delivery ownership. A failed
   * inspection is conservative: failure cannot prove that the provider never
   * accepted the already-claimed input.
   */
  private async hasDurableAsyncAnswerOwnership(
    scope: ChatScopeKey,
    chatId: string,
    userMessageId: string,
  ): Promise<boolean> {
    try {
      const current = await this.repository.getState(scope, {
        chatIds: [chatId],
      });
      const tab = current.tabsFile.tabs.find(
        (candidate) => candidate.id === chatId,
      );
      const ledger = tab?.inputDelivery;
      const row = isInputLedger(ledger)
        ? ledger.rows.find(
            (candidate) =>
              candidate.id === userMessageId ||
              candidate.payload.userMessageId === userMessageId,
          )
        : undefined;
      // Even a cancelled row can own a queue-restoration or user-edit handoff;
      // only the absence of a durable row proves no claim crossed this boundary.
      if (row) return true;
      if (tab?.messages.some((message) => message.id === userMessageId))
        return true;
      const runtime = current.runtimeByChatId[chatId];
      return (
        runtime?.queuedMessageIds.includes(userMessageId) === true ||
        runtime?.queuedMessages?.some(
          (message) =>
            message.request.userMessageId === userMessageId &&
            message.admitting !== true,
        ) === true
      );
    } catch {
      return true;
    }
  }

  /** Remove only the transient acceptance marker, never a durable queue row. */
  private async retireAsyncAnswerAdmission(
    scope: ChatScopeKey,
    chatId: string,
    userMessageId: string,
    mutationId: string,
  ): Promise<void> {
    await this.repository.transactWith(
      scope,
      (current): ChatCoreMutation[] => {
        const runtime = current.runtimeByChatId[chatId];
        const next = removeAdmittingRuntimeEntry(runtime, userMessageId);
        return next && next !== runtime
          ? [{ type: 'runtime.patched', chatId, runtime: next }]
          : [];
      },
      {
        source: 'renderer-command',
        mutationId,
        chatIds: [chatId],
      },
    );
  }

  private async sendAcceptedMessage(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<
      ChatCommandEnvelope['command'],
      { type: 'chat.send_message' }
    >,
    options: TrustedChatCommandExecutionOptions,
    asyncAnswer?: { questionId: string; answers: McpQuestionAnswer[] },
  ): Promise<ChatCommandResult> {
    const key = JSON.stringify([
      scope.projectId,
      scope.worktreeId,
      command.chatId,
      command.userMessageId,
    ]);
    // The transcript no longer fences a queued row. Serialize acceptance of
    // the same stable message identity until its row or durable queue entry
    // exists, including callers retrying with a different command identity.
    let previous = this.acceptedSendsInFlight.get(key);
    while (previous) {
      try {
        await previous;
      } catch {
        // A failed reservation does not prevent a later canonical retry.
      }
      previous = this.acceptedSendsInFlight.get(key);
    }
    const send = this.sendAcceptedMessageOnce(
      scope,
      envelope,
      command,
      options,
      asyncAnswer,
    );
    this.acceptedSendsInFlight.set(key, send);
    try {
      return await send;
    } finally {
      if (this.acceptedSendsInFlight.get(key) === send)
        this.acceptedSendsInFlight.delete(key);
    }
  }

  private async sendAcceptedMessageOnce(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<
      ChatCommandEnvelope['command'],
      { type: 'chat.send_message' }
    >,
    options: ChatCommandExecutionOptions,
    asyncAnswer?: { questionId: string; answers: McpQuestionAnswer[] },
  ): Promise<ChatCommandResult> {
    const implementation = command.trackedPlanImplementation;
    if (
      implementation !== undefined &&
      (!TrackedPlanImplementationInputSchema.safeParse(implementation)
        .success ||
        implementation.userMessageId !== command.userMessageId ||
        (command.planReviewApproval &&
          (command.planReviewApproval.planId !== implementation.planId ||
            command.planReviewApproval.revisionNumber !==
              implementation.revisionNumber)))
    )
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
        { reason: 'Invalid plan implementation identity.' },
      );
    const trustedRequest: ChatSendMessageRequest = {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: command.chatId,
      userMessageId: command.userMessageId,
      text: command.text,
      agentSent: command.agentSent,
      agentSenderProvenance: command.agentSenderProvenance,
      hiddenContext: command.hiddenContext,
      agentSendSetup: command.agentSendSetup,
    };
    if (command.agentSendSetup) await agentSendTargetReadiness(trustedRequest);
    if (command.turnOverride) {
      // D2: only a pipeline send carries per-turn settings, whoever dispatches it.
      const provenance = parseAgentSenderProvenance(
        command.agentSenderProvenance,
      );
      if (provenance?.sender.kind !== 'pipeline')
        throw new AgentSenderContextError(
          'validation_failed',
          'Only a pipeline send carries per-turn settings.',
        );
      // D11: an agent-originated run never changes the target's authority.
      if (
        'agentOrigin' in provenance &&
        provenance.agentOrigin &&
        changesAuthority(command.turnOverride)
      )
        throw new AgentSenderContextError(
          'authorization_conflict',
          'An agent-originated run cannot change the target chat’s model, plan mode, plugins or approvals.',
        );
    }
    if (command.automationDispatch) {
      // An automation's own send (CAN-4549), or a step in a run an
      // automation started (CAN-4551): the sender names the automation.
      const sender = parseAgentSenderProvenance(
        command.agentSenderProvenance,
      )?.sender;
      if (sender?.kind !== 'pipeline' || sender.automationId === undefined)
        throw new AgentSenderContextError(
          'validation_failed',
          'Only an automation’s own send carries automation dispatch facts.',
        );
    }
    command = withTurnOverrideTabSettings(command);
    if (
      command.agentSent ||
      command.agentSenderProvenance ||
      command.hiddenContext ||
      command.agentSendSetup
    )
      await revalidateAgentSenderRequest(trustedRequest);
    const stateBeforeAuthorization = await this.repository.getState(scope, {
      chatIds: [command.chatId],
    });
    const tabBeforeAuthorization = stateBeforeAuthorization.tabsFile.tabs.find(
      (candidate) => candidate.id === command.chatId,
    );
    // Settle the model, including one stored on the chat, before authorization
    // judges it and before the prompt is committed. Auto picks its own model,
    // except for a turn whose override names one.
    const storedModel =
      tabBeforeAuthorization?.kind === 'file'
        ? undefined
        : tabBeforeAuthorization?.model;
    const admissionTab =
      tabBeforeAuthorization && tabBeforeAuthorization.kind !== 'file'
        ? tabWithSendModel(tabBeforeAuthorization, command)
        : undefined;
    const sendModel =
      command.turnOverride?.model === undefined &&
      (command.modelSelectionMode ??
        tabBeforeAuthorization?.modelSelectionMode) === 'auto'
        ? undefined
        : await this.resolveSendModel(
            {
              ...scope,
              chatId: command.chatId,
              executionHarness:
                command.turnOverride?.executionHarness ??
                (command.turnOverride?.model
                  ? getExecutionHarnessForModel(command.turnOverride.model)
                  : admissionTab?.executionHarness),
            },
            storedModel,
            command.turnOverride?.model ?? command.model,
          );
    const requestedCommand = command;
    if (sendModel !== undefined) {
      command =
        command.turnOverride?.model !== undefined
          ? {
              ...command,
              turnOverride: { ...command.turnOverride, model: sendModel },
            }
          : {
              ...command,
              model: sendModel,
              providerType:
                getProviderForModel(sendModel) ?? command.providerType,
            };
    }
    if (
      tabBeforeAuthorization &&
      tabBeforeAuthorization.kind !== 'file' &&
      tabBeforeAuthorization.readOnly !== true &&
      !tabBeforeAuthorization.messages.some(
        (message) => message.id === command.userMessageId,
      )
    ) {
      await this.authorizeSend({
        ...scope,
        tab: tabWithSendModel(tabBeforeAuthorization, command),
        ...(command.agentSenderProvenance || implementation
          ? { allowTrustedTerminal: true }
          : {}),
      });
    }
    const pendingPlanReviewApproval =
      command.planReviewApproval &&
      !tabBeforeAuthorization?.messages.some(
        (message) => message.id === command.userMessageId,
      )
        ? command.planReviewApproval
        : undefined;
    if (pendingPlanReviewApproval) {
      if (
        asyncAnswer ||
        command.planMode === true ||
        options.canCommitSend?.() === false ||
        !matchesOpenCodePlanReview(
          tabBeforeAuthorization,
          stateBeforeAuthorization.runtimeByChatId[command.chatId],
          pendingPlanReviewApproval,
        )
      ) {
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          'rejected',
          {
            reason:
              'The plan review changed or the chat is busy. Review the current proposal before implementing it.',
          },
        );
      }
      // The plan store records the explicit review first. It grants no chat
      // permissions: the revision lock and canonical transaction below recheck
      // the saved plan, request and live pairing before accepting the message.
      if (
        !(await this.approvePlanReview({
          ...scope,
          chatId: command.chatId,
          planId: pendingPlanReviewApproval.planId,
          revisionNumber: pendingPlanReviewApproval.revisionNumber,
          approvedAt: new Date(this.now()).toISOString(),
        }))
      ) {
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          'rejected',
          {
            reason:
              'The saved plan changed. Request a new proposal before implementing it.',
          },
        );
      }
    }
    const admissionDefault = chatSendAdmissionCheck({
      ...scope,
      chatId: command.chatId,
      userMessageId: command.userMessageId,
    })
      ? await readAdmissionDefault(scope)
      : undefined;
    const timestamp = this.now();
    const firstMessageTitle = initialChatTitle(command.text);
    const newChatStartedWatcherFiredAt = new Date(timestamp).toISOString();
    let startsNewTrackedChat = false;
    let startsHeldTurn = false;
    let admissionCheck: ChatSendAdmissionCheck | undefined;
    let admittedApproval: ChatSendAdmittedApproval | undefined;
    let precommitResult:
      | {
          outcome: 'not_found' | 'already_applied' | 'rejected';
          reason?: string;
        }
      | undefined;
    let acceptedRequest: ChatSendMessageRequest | undefined;
    let implementationSource: PersistedChatTab['trackedPlanSource'];
    let previousPlanTracking: ChatTabMetadataPatch | undefined;
    const commitSend = (): Promise<ChatStateCommit> =>
      this.repository.transactWith(
        scope,
        (current, _revision, transaction) => {
          if (options.portalSend) {
            const receipt = transaction.getPortalSendReceipt(
              command.userMessageId,
            );
            if (receipt) {
              precommitResult = matchesPortalSendReceipt(
                receipt,
                options.portalSend,
              )
                ? { outcome: 'already_applied' }
                : {
                    outcome: 'rejected',
                    reason:
                      'The logical portal send payload or target has changed.',
                  };
              return [];
            }
          }
          const persistedTab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === command.chatId,
          );
          if (!persistedTab || persistedTab.kind === 'file') {
            precommitResult = { outcome: 'not_found' };
            return [];
          }
          // A model change that landed after the stored model was read wins
          // over a pin taken from it.
          const tab = tabWithSendModel(
            persistedTab,
            requestedCommand.model === undefined &&
              persistedTab.model !== storedModel
              ? requestedCommand
              : command,
          );
          if (tab.readOnly) {
            precommitResult = {
              outcome: 'rejected',
              reason: 'Target chat is readonly',
            };
            return [];
          }
          const question = asyncAnswer
            ? (current.tabsFile.pendingQuestions ?? []).find(
                (candidate) =>
                  candidate.chatId === tab.id &&
                  candidate.requestId === asyncAnswer.questionId,
              )
            : undefined;
          if (asyncAnswer && (!question || question.answeredAt !== undefined)) {
            precommitResult = {
              outcome: question ? 'already_applied' : 'not_found',
            };
            return [];
          }
          const priorImplementation = tab.trackedPlanImplementation;
          if (
            implementation &&
            priorImplementation?.userMessageId === command.userMessageId
          ) {
            precommitResult = {
              outcome:
                priorImplementation.planId === implementation.planId &&
                priorImplementation.revisionNumber ===
                  implementation.revisionNumber &&
                priorImplementation.startedAt === implementation.startedAt
                  ? 'already_applied'
                  : 'rejected',
            };
            return [];
          }
          if (
            (tab.messages.some(({ id }) => id === command.userMessageId) &&
              // Core precommits an agent's message before it is accepted.
              !command.agentSenderProvenance) ||
            current.runtimeByChatId[tab.id]?.queuedMessages?.some(
              ({ request }) => request.userMessageId === command.userMessageId,
            ) ||
            (isInputLedger(tab.inputDelivery) &&
              tab.inputDelivery.rows.some(
                (row) => row.payload.userMessageId === command.userMessageId,
              ))
          ) {
            precommitResult = options.portalSend
              ? {
                  outcome: 'rejected',
                  reason:
                    'The message has no matching logical portal send receipt.',
                }
              : { outcome: 'already_applied' };
            return [];
          }
          if (implementation) {
            const runtime = current.runtimeByChatId[tab.id];
            const busy =
              [
                'starting',
                'streaming',
                'awaiting_input',
                'completing',
                'queued',
              ].includes(runtime?.status ?? 'idle') ||
              (runtime?.queuedMessages?.length ?? 0) > 0;
            const anotherAttempt = current.tabsFile.tabs.some((candidate) => {
              const link = candidate.trackedPlanImplementation;
              const live = current.runtimeByChatId[candidate.id];
              return (
                link?.planId === implementation.planId &&
                link.revisionNumber === implementation.revisionNumber &&
                !link.outcome &&
                (live?.activeTurn?.userMessageId === link.userMessageId ||
                  live?.queuedMessages?.some(
                    ({ request }) =>
                      request.userMessageId === link.userMessageId,
                  ))
              );
            });
            if (
              busy ||
              anotherAttempt ||
              tab.providerType === 'cursor' ||
              tab.executionHarness === 'cursor' ||
              implementationSource === undefined ||
              command.planMode === true ||
              asyncAnswer
            ) {
              precommitResult = {
                outcome: 'rejected',
                reason:
                  'The plan implementation target is unavailable or busy.',
              };
              return [];
            }
          }
          if (options.canCommitSend?.() === false) {
            precommitResult = {
              outcome: 'rejected',
              reason: 'The paired session no longer authorizes this send.',
            };
            return [];
          }
          if (transaction.hasRemovedMessage(command.userMessageId)) {
            precommitResult = {
              outcome: 'not_found',
              reason: 'The message id is tombstoned',
            };
            return [];
          }
          admissionCheck = chatSendAdmissionCheck({
            ...scope,
            chatId: tab.id,
            userMessageId: command.userMessageId,
          });
          const admissionRefusal = admissionCheck?.(tab);
          if (admissionRefusal !== undefined) {
            precommitResult = { outcome: 'rejected', reason: admissionRefusal };
            return [];
          }
          admittedApproval = admissionCheck
            ? admittedApprovalOf(tab, admissionDefault)
            : undefined;
          startsNewTrackedChat =
            tab.newChatStartedWatcherFiredAt === undefined &&
            (tab.newChatStartedWatcherPending === true ||
              tab.messages.length === 0);
          const approval = command.planReviewApproval;
          if (
            approval &&
            (asyncAnswer ||
              command.planMode === true ||
              !matchesOpenCodePlanReview(
                tab,
                current.runtimeByChatId[tab.id],
                approval,
              ))
          ) {
            precommitResult = {
              outcome: 'rejected',
              reason:
                'The plan review changed or the chat is busy. Review the current proposal before implementing it.',
            };
            return [];
          }
          // Optional additive metadata on the retained answered question lets
          // every native prompt builder recover the answer after durable dequeue,
          // even builders that do not echo the request's asyncQuestionId.
          const answeredQuestion:
            | (PersistedPendingQuestion & { answerUserMessageId: string })
            | undefined =
            question && asyncAnswer
              ? {
                  ...question,
                  answers: asyncAnswer.answers,
                  answeredAt: timestamp,
                  answerUserMessageId: command.userMessageId,
                }
              : undefined;
          const acceptanceMutations: ChatCoreMutation[] = [
            ...(tab !== persistedTab
              ? [{ type: 'tab.created' as const, tab }]
              : []),
            ...(answeredQuestion
              ? [
                  {
                    type: 'pending_question.upserted' as const,
                    question: answeredQuestion,
                  },
                ]
              : []),
            ...(tab.messages.length === 0 &&
            hasPlaceholderChatTitle(tab.title) &&
            tab.title !== firstMessageTitle
              ? [
                  {
                    type: 'tab.created' as const,
                    tab: {
                      ...tab,
                      title: firstMessageTitle,
                      automaticTitleState:
                        tab.automaticTitleState === 'closed'
                          ? ('closed' as const)
                          : ('pending' as const),
                    },
                  },
                ]
              : []),
            ...(command.selectedRepoId !== undefined ||
            command.modelConfig !== undefined ||
            command.planMode !== undefined ||
            command.codexProposalMode !== undefined ||
            command.modelSelectionMode !== undefined
              ? [
                  {
                    type: 'tab.metadata_patched' as const,
                    tabId: tab.id,
                    patch: {
                      ...(command.selectedRepoId !== undefined
                        ? { selectedRepoId: command.selectedRepoId }
                        : {}),
                      ...(command.modelConfig !== undefined
                        ? { modelConfig: command.modelConfig }
                        : {}),
                      ...(command.planMode !== undefined
                        ? { planMode: command.planMode }
                        : {}),
                      ...(command.codexProposalMode !== undefined
                        ? { proposalMode: command.codexProposalMode }
                        : {}),
                      ...(command.modelSelectionMode !== undefined
                        ? { modelSelectionMode: command.modelSelectionMode }
                        : {}),
                    },
                  },
                ]
              : []),
            ...(approval
              ? [
                  {
                    type: 'tab.metadata_patched' as const,
                    tabId: tab.id,
                    patch: {
                      planMode: false,
                      pendingPlanExit: null,
                      pendingPlanExitRequestId: null,
                      trackedPlanReviewStatus: 'approved' as const,
                      hasOutstandingProposal: false,
                    },
                  },
                ]
              : []),
            ...(startsNewTrackedChat
              ? [
                  {
                    type: 'tab.metadata_patched' as const,
                    tabId: tab.id,
                    patch: {
                      newChatStartedWatcherPending: null,
                      newChatStartedWatcherFiredAt,
                    },
                  },
                ]
              : []),
          ];
          if (implementation)
            previousPlanTracking = {
              trackedPlanImplementation: tab.trackedPlanImplementation ?? null,
              trackedPlanId: tab.trackedPlanId ?? null,
              trackedPlanSource: tab.trackedPlanSource ?? null,
              trackedPlanReviewStatus: tab.trackedPlanReviewStatus ?? null,
              latestRevisionNumber: tab.latestRevisionNumber ?? null,
            };
          if (implementation)
            acceptanceMutations.push({
              type: 'tab.metadata_patched',
              tabId: tab.id,
              patch: {
                trackedPlanId: implementation.planId,
                trackedPlanSource: implementationSource,
                latestRevisionNumber: implementation.revisionNumber,
                trackedPlanReviewStatus: 'approved',
                trackedPlanImplementation: implementation,
              },
            });
          // An unchanged title/settings send still needs a durable command
          // receipt. Without this fence an empty transaction is unapplied and
          // the send would disappear before real queue admission.
          if (acceptanceMutations.length === 0) {
            acceptanceMutations.push({
              type: 'tab.metadata_patched',
              tabId: tab.id,
              patch: {},
            });
          }
          const acceptedTab = acceptanceMutations
            .reduce(applyMutation, current)
            .tabsFile.tabs.find((candidate) => candidate.id === tab.id);
          if (!acceptedTab || acceptedTab.kind === 'file') {
            throw new Error(
              `Accepted chat ${tab.id} is missing from its transaction`,
            );
          }
          const request = {
            ...admittedSendRequest(scope, command, acceptedTab, {
              startsNewTrackedChat,
              asyncAnswer,
            }),
            ...(admittedApproval ? { admittedApproval } : {}),
          };
          acceptedRequest = request;
          const runtime = current.runtimeByChatId[tab.id] ?? {
            status: 'idle' as const,
            queuedMessageIds: [],
          };
          // Only a send that starts the chat's turn before any setup holds the
          // chat can become the turn a worktree setup holds.
          startsHeldTurn =
            !asyncAnswer &&
            !['starting', 'streaming', 'awaiting_input', 'completing'].includes(
              runtime.status,
            ) &&
            !this.setupHolds.has(chatRuntimeHostKey(scope, tab.id));
          acceptanceMutations.push({
            type: 'runtime.patched',
            chatId: tab.id,
            runtime: {
              ...runtime,
              queuedMessages: [
                ...(runtime.queuedMessages ?? []),
                {
                  id: `admission:${command.userMessageId}`,
                  request,
                  origin: envelope.origin ?? 'desktop',
                  enqueuedAtMs: timestamp,
                  admitting: true,
                },
              ],
            },
          });
          return acceptanceMutations;
        },
        {
          ...{
            source: 'renderer-command',
            mutationId: command.agentSenderProvenance
              ? `${envelope.commandId}:agent-send-input`
              : envelope.commandId,
            ...(!command.agentSenderProvenance
              ? {
                  commandResult: {
                    commandId: envelope.commandId,
                    outcome: 'applied' as const,
                    entityId: command.chatId,
                    messageId: command.userMessageId,
                    ...(options.portalSend
                      ? { portalSend: options.portalSend }
                      : {}),
                  },
                }
              : {}),
            ...expectedRevisionOption(envelope),
          },
          chatIds: [command.chatId],
          ...(options.canCommitSend
            ? {
                beforePublish: (): void => {
                  if (options.canCommitSend?.() === false)
                    throw new ChatSendAuthorizationRevokedError();
                },
              }
            : {}),
        },
      );

    // The plan lock is held only through canonical acceptance, never provider
    // dispatch. Plan edits cannot race the revision check and this commit.
    const commitImplementation = (): Promise<
      { accepted: false } | { accepted: true; result: ChatStateCommit }
    > =>
      implementation &&
      tabBeforeAuthorization?.trackedPlanImplementation?.userMessageId !==
        command.userMessageId
        ? this.withPlanImplementationRevision(
            {
              ...scope,
              chatId: command.chatId,
              planId: implementation.planId,
              revisionNumber: implementation.revisionNumber,
              approvedAt: new Date(timestamp).toISOString(),
            },
            async (source) => {
              implementationSource = source;
              return commitSend();
            },
          )
        : commitSend().then((result) => ({ accepted: true as const, result }));
    const guardedCommit = pendingPlanReviewApproval
      ? await this.withPlanReviewRevision(
          {
            ...scope,
            chatId: command.chatId,
            planId: pendingPlanReviewApproval.planId,
            revisionNumber: pendingPlanReviewApproval.revisionNumber,
            approvedAt: new Date(timestamp).toISOString(),
          },
          async () => {
            implementationSource = 'opencode';
            return commitSend();
          },
        )
      : await commitImplementation();
    if (!guardedCommit.accepted) {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
        {
          reason:
            'The saved plan changed. Request a new proposal before implementing it.',
        },
      );
    }
    const commit = guardedCommit.result;

    if (precommitResult) {
      return commandResult(envelope, commit.revision, precommitResult.outcome, {
        messageId: command.userMessageId,
        ...(precommitResult.reason ? { reason: precommitResult.reason } : {}),
      });
    }

    const canonical = commit.state.tabsFile.tabs.find(
      (candidate) => candidate.id === command.chatId,
    );
    if (!canonical) {
      throw new Error(
        `Committed chat ${command.chatId} is missing from canonical state`,
      );
    }
    if (!commit.applied && !command.agentSenderProvenance) {
      return commandResult(envelope, commit.revision, 'already_applied', {
        entityId: command.chatId,
        messageId: command.userMessageId,
      });
    }
    // A replayed agent send's input committed in an earlier attempt, so its
    // builder did not run again; rebuild the request from canonical state.
    const request =
      acceptedRequest ??
      (command.agentSenderProvenance
        ? {
            ...admittedSendRequest(scope, command, canonical, {
              startsNewTrackedChat,
              asyncAnswer,
            }),
            ...(admittedApproval ? { admittedApproval } : {}),
          }
        : undefined);
    if (!request)
      throw new Error(
        `Accepted chat request ${command.userMessageId} is missing`,
      );
    const setupHold = asyncAnswer
      ? undefined
      : (this.setupHolds.get(chatRuntimeHostKey(scope, command.chatId)) ??
        this.beginSetupHold(scope, command.chatId));
    if (setupHold) {
      await setupHold.acquired;
      // The held turn shows as starting, its prompt committed, until setup
      // ends; later sends queue behind it through admission. A setup that
      // already ended waits for this commit, so it still settles this turn.
      // `installing` resolves only once the committed turn owns the hold.
      const installing =
        startsHeldTurn && setupHold.owner === undefined
          ? this.commitAdmittedPrompt(
              scope,
              envelope,
              command,
              timestamp,
              undefined,
              { cancelledBeforeDispatch: false, startsTurn: true },
            ).then((installed) => {
              if (installed)
                this.holdTurnForSetup(setupHold, {
                  key: awaitingSetupKey(scope, command),
                  scope,
                  command,
                  timestamp,
                  dispatch: {
                    kind: 'admitted',
                    envelope,
                    command,
                    revision: commit.revision,
                    startsNewTrackedChat,
                    admissionCheck,
                  },
                });
              return installed;
            })
          : undefined;
      if (installing) setupHold.installing = installing;
      if (installing && (await installing)) {
        await setupHold.acquired;
        return commandResult(envelope, commit.revision, 'applied', {
          entityId: command.chatId,
          messageId: command.userMessageId,
        });
      }
    }
    return this.dispatchAdmitted(
      scope,
      envelope,
      command,
      commit.revision,
      {
        request,
        timestamp,
        installedStartingRuntime: false,
        previousPlanTracking,
      },
      asyncAnswer,
    );
  }

  /**
   * Holds a desktop send for its worktree's pending Git setup, as an admitted
   * Portal or agent send is held. The chat's first send becomes the turn the
   * setup holds: its prompt (`userMessage`) commits now with a `starting`
   * runtime, and its request dispatches unchanged once setup is ready
   * (`'held'`). A send while the chat is already held waits for the hold and
   * then goes to the chat queue through `submit`, which the hold awaits
   * before it ends, so the row stays queued behind the held turn
   * (`'queued-behind-hold'`); one whose hold ended without the setup becoming
   * ready throws `WorktreeSetupEndedError` instead of dispatching. With no
   * pending setup the send is submitted as usual (`'dispatch-now'`). A held
   * send can fail after this returns, by its dispatch failing or its setup
   * ending, so `onHeldDispatchFailed` then does what the caller's own
   * failure handling would.
   */
  public async holdLocalSendForWorktreeSetup(
    request: ChatSendMessageRequest,
    userMessage: (timestamp: number) => PersistedChatMessage,
    submit: () => Promise<void>,
    onHeldDispatchFailed?: () => Promise<void>,
  ): Promise<'dispatch-now' | 'held' | 'queued-behind-hold'> {
    const { chatId, userMessageId } = request;
    const dispatchNow = async (): Promise<'dispatch-now'> => {
      await submit();
      return 'dispatch-now';
    };
    // An agent send that waits for its target's setup keeps its queue path.
    if (request.agentSendSetup) return dispatchNow();
    const scope = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
    };
    const key = chatRuntimeHostKey(scope, chatId);
    const existing = this.setupHolds.get(key);
    if (existing) {
      // This row may land before the first send's turn owns the hold. That
      // is safe: settling awaits `installing` before it reads the owner, and
      // the release dispatches an owner first. If installing fails, the first
      // send fails to its caller and this row stays queued behind the hold,
      // released or ended with the setup like any other.
      await existing.acquired;
      return this.submitBehindSetupHold(existing, submit);
    }
    const hold = this.beginSetupHold(scope, chatId);
    if (!hold) return dispatchNow();
    await hold.acquired;
    if (hold.owner !== undefined)
      return this.submitBehindSetupHold(hold, submit);
    const timestamp = this.now();
    // A setup that already ended waits for this commit, so it still settles
    // this turn. `installing` resolves only once the committed turn owns the
    // hold, so settling never sees a committed turn without its owner.
    const installing = this.ensureChatForTrustedSend(request)
      .then(() =>
        this.commitHeldLocalPrompt(
          scope,
          request,
          userMessage(timestamp),
          timestamp,
        ),
      )
      .then((installed) => {
        if (installed)
          this.holdTurnForSetup(hold, {
            key: awaitingSetupKey(scope, { chatId, userMessageId }),
            scope,
            command: { chatId, userMessageId },
            timestamp,
            dispatch: {
              kind: 'local',
              request,
              onDispatchFailed: onHeldDispatchFailed,
            },
          });
        return installed;
      });
    hold.installing = installing;
    // Another send installed its turn first; this one queues behind it.
    if (!(await installing)) return this.submitBehindSetupHold(hold, submit);
    await hold.acquired;
    return 'held';
  }

  /**
   * Queues a desktop send behind a chat's held turn. Its row is written while
   * the hold waits for it, so a setup that fails meanwhile still takes the
   * row and ends it with the held turn; a hold that already ended that way
   * refuses the send instead.
   */
  private async submitBehindSetupHold(
    hold: SetupHold,
    submit: () => Promise<void>,
  ): Promise<'queued-behind-hold'> {
    if (hold.outcome !== undefined && hold.outcome !== 'ready')
      throw new WorktreeSetupEndedError(hold.outcome);
    const submitting = submit();
    hold.submitting.add(submitting);
    try {
      await submitting;
    } finally {
      hold.submitting.delete(submitting);
    }
    return 'queued-behind-hold';
  }

  /**
   * Commits a held desktop send's prompt with its turn's `starting` runtime,
   * as `commitAdmittedPrompt` does for a held admitted send. The prompt
   * commit at dispatch then finds the message and keeps one copy. Returns
   * whether it installed that runtime.
   */
  private async commitHeldLocalPrompt(
    scope: ChatScopeKey,
    request: ChatSendMessageRequest,
    message: PersistedChatMessage,
    timestamp: number,
  ): Promise<boolean> {
    let installed = false;
    await this.repository.transactWith(
      scope,
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        if (!tab || tab.kind === 'file' || tab.readOnly) {
          throw new Error('Target chat no longer accepts this message');
        }
        const runtime = current.runtimeByChatId[tab.id];
        if (
          tab.messages.some(({ id }) => id === request.userMessageId) ||
          (runtime !== undefined &&
            ['starting', 'streaming', 'awaiting_input', 'completing'].includes(
              runtime.status,
            ))
        )
          return [];
        installed = true;
        return [
          { type: 'message.upserted', chatId: tab.id, message },
          {
            type: 'runtime.patched',
            chatId: tab.id,
            runtime: {
              ...runtime,
              status: 'starting',
              queuedMessageIds: runtime?.queuedMessageIds ?? [],
              activeTurn: {
                userMessageId: request.userMessageId,
                startedAt: timestamp,
              },
              lastActivityAt: timestamp,
            },
          },
        ];
      },
      {
        source: 'renderer-command',
        mutationId: `${request.chatId}:${request.userMessageId}:setup-held`,
        chatIds: [request.chatId],
      },
    );
    return installed;
  }

  /**
   * Starts holding a chat's sends for its worktree's pending Git setup, or
   * returns undefined when no setup is pending. Sends admitted meanwhile
   * queue behind the hold in the chat queue, where they show and can be
   * cancelled as queued input.
   */
  private beginSetupHold(
    scope: ChatScopeKey,
    chatId: string,
  ): SetupHold | undefined {
    const setup = this.awaitWorktreeSetup(scope);
    if (!setup) return undefined;
    const key = chatRuntimeHostKey(scope, chatId);
    const target = { ...scope, chatId };
    const releaseDispatch = this.holdDispatch(key);
    const hold: SetupHold = {
      scope,
      chatId,
      acquired: this.worktreeSetupQueue.hold(target).catch((error: unknown) => {
        logMainProcessWarn(
          `[chat-state] Could not hold the chat queue for worktree setup for ${scope.projectId}/${scope.worktreeId}/${chatId}:`,
          error,
        );
      }),
      owner: undefined,
      submitting: new Set(),
    };
    this.setupHolds.set(key, hold);
    void setup
      .catch((): WorktreeGitSetupOutcome => 'failed')
      .then((outcome) => this.settleSetupHold(hold, outcome))
      .catch((error: unknown) => {
        logMainProcessWarn(
          `[chat-state] A send held for worktree setup did not settle for ${scope.projectId}/${scope.worktreeId}/${chatId}:`,
          error,
        );
      })
      .finally(() => {
        hold.owner?.preparation?.finish();
        if (hold.owner) this.heldSends.delete(hold.owner.key);
        if (this.setupHolds.get(key) === hold) this.setupHolds.delete(key);
        releaseDispatch();
      });
    return hold;
  }

  /** Makes a send that starts the chat's turn the turn the setup holds. */
  private holdTurnForSetup(
    hold: SetupHold,
    admitted: Omit<HeldSend, 'preparation' | 'state'>,
  ): void {
    const { scope, command } = admitted;
    const held: HeldSend = {
      ...admitted,
      preparation: beginChatTurnPreparation({
        ...scope,
        chatId: command.chatId,
        userMessageId: command.userMessageId,
        onCancel: () => this.settleHeldSend(held, 'cancelled'),
      }),
      state: 'held',
    };
    hold.owner = held;
    this.heldSends.set(held.key, held);
    const target = { ...scope, chatId: command.chatId };
    hold.acquired = hold.acquired
      .then(() => this.worktreeSetupQueue.hold(target, command.userMessageId))
      .catch((error: unknown) => {
        logMainProcessWarn(
          `[chat-state] Could not hold the chat queue for worktree setup for ${scope.projectId}/${scope.worktreeId}/${command.chatId}:`,
          error,
        );
      });
  }

  /**
   * Ends a chat's setup hold. When setup is ready the held turn dispatches
   * ahead of the sends queued behind it, which then run in order; when it
   * failed or was cancelled, the held turn and every queued send end that
   * way: one commit takes the queued sends off the queue and records their
   * ends (`reconcileHostQueue`), so none is ever durably without both its
   * queue row and its end. A shutdown leaves them all for startup
   * reconciliation.
   */
  private async settleSetupHold(
    hold: SetupHold,
    outcome: WorktreeGitSetupOutcome,
  ): Promise<void> {
    hold.outcome = outcome;
    await hold.acquired;
    // `installing` resolves only after a committed turn owns the hold
    // (`holdTurnForSetup`), which extends `acquired` with that turn's queue
    // hold; it lands before the hold ends.
    await hold.installing?.catch(() => false);
    await hold.acquired;
    // Rows of sends admitted behind the held turn land before the hold
    // takes or releases them.
    await Promise.allSettled(hold.submitting);
    if (this.draining) return;
    const target = { ...hold.scope, chatId: hold.chatId };
    const key = chatRuntimeHostKey(hold.scope, hold.chatId);
    const owner = hold.owner;
    if (outcome !== 'ready') {
      if (owner) {
        // A held desktop send that setup ended never ran, so its admission
        // is undone, as when its dispatch fails; one the user stopped stays.
        const undoesAdmission = owner.state === 'held';
        await this.settleHeldSend(owner, outcome);
        if (undoesAdmission) await this.undoHeldLocalAdmission(owner);
      }
      await this.untilSettled(hold, async () => {
        await this.worktreeSetupQueue.takeHeld(target, outcome);
        await this.worktreeSetupQueue.release(target);
      });
      if (this.setupHolds.get(key) === hold) this.setupHolds.delete(key);
      return;
    }
    try {
      if (owner) await this.dispatchHeldTurn(hold, owner);
    } finally {
      await this.untilSettled(hold, () =>
        this.worktreeSetupQueue.release(target),
      );
      if (!this.draining && this.setupHolds.get(key) === hold)
        this.setupHolds.delete(key);
    }
  }

  /**
   * Runs a step that ends a chat's setup hold until it succeeds, retrying
   * with backoff, so a step that cannot persist (taking the held sends off
   * the queue, releasing the queue's hold) leaves the chat held, its sends
   * queued and none dispatched, rather than stuck behind a hold nothing
   * releases. A shutdown stops retrying and leaves the hold for startup
   * reconciliation.
   */
  private async untilSettled(
    hold: SetupHold,
    step: () => Promise<void>,
  ): Promise<void> {
    for (let attempt = 0; !this.draining; attempt += 1) {
      try {
        await step();
        return;
      } catch (error) {
        logMainProcessWarn(
          `[chat-state] Could not end the worktree setup hold of ${hold.scope.projectId}/${hold.scope.worktreeId}/${hold.chatId}; retrying:`,
          error,
        );
      }
      await new Promise<void>((resolve) => {
        this.schedule(
          resolve,
          Math.min(1_000 * 2 ** attempt, 30_000),
        ).unref?.();
      });
    }
  }

  /**
   * Dispatches the turn a setup held once setup is ready, if it is still the
   * chat's live, unstopped turn and its send's admission still holds.
   */
  private async dispatchHeldTurn(
    hold: SetupHold,
    held: HeldSend,
  ): Promise<void> {
    if (held.state !== 'held') return;
    const { scope, command } = held;
    await this.worktreeSetupQueue.release(
      { ...scope, chatId: command.chatId },
      { firstUserMessageId: command.userMessageId },
    );
    const committed = await this.repository.hasMessage(
      scope,
      command.chatId,
      command.userMessageId,
    );
    const { dispatch } = held;
    const admissionDefault =
      dispatch.kind === 'admitted' && dispatch.admissionCheck
        ? await readAdmissionDefault(scope)
        : undefined;
    const state = await this.repository.getState(scope, {
      chatIds: [command.chatId],
    });
    if (held.state !== 'held' || this.draining) return;
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === command.chatId,
    );
    const runtime = state.runtimeByChatId[command.chatId];
    const ownsRuntime =
      runtime?.activeTurn?.userMessageId === command.userMessageId;
    if (
      held.preparation?.cancelled === true ||
      !tab ||
      tab.kind === 'file' ||
      tab.readOnly === true ||
      !committed ||
      (ownsRuntime && !UNFINISHED_RUNTIME_STATUSES.includes(runtime.status))
    ) {
      await this.settleHeldSend(held, 'cancelled');
      return;
    }
    const key = chatRuntimeHostKey(hold.scope, hold.chatId);
    if (dispatch.kind === 'local') {
      held.state = 'dispatching';
      if (this.setupHolds.get(key) === hold) this.setupHolds.delete(key);
      // Through the chat queue's submit, as every desktop send: the queue
      // releases the hold for exactly this send. Its prompt and starting
      // runtime are already committed (`commitHeldLocalPrompt`), so the
      // pre-dispatch commit an immediate submit runs is deliberately a
      // no-op here, and the dispatch's own prompt commit keeps the one
      // message.
      try {
        await this.dispatch(dispatch.request, 'desktop', () =>
          Promise.resolve(),
        );
      } catch (error) {
        // The send's caller already returned, so a dispatch no provider
        // accepted ends its committed starting turn here, as failed, and
        // undoes the caller's admission. The hold itself still settles.
        logMainProcessWarn(
          `[chat-state] A send held for worktree setup could not dispatch for ${scope.projectId}/${scope.worktreeId}/${command.chatId}:`,
          error,
        );
        if (
          !(await this.repository.hasMutation(
            scope,
            `${command.chatId}:${command.userMessageId}:accepted`,
          ))
        ) {
          await this.endUnacceptedTurn(
            scope,
            command,
            held.timestamp,
            'failed',
            error instanceof Error ? error.message : String(error),
          );
        }
        await this.undoHeldLocalAdmission(held);
      }
      return;
    }
    const admissionRefusal = dispatch.admissionCheck?.(tab);
    if (admissionRefusal !== undefined) {
      await this.settleHeldSend(held, 'failed', admissionRefusal);
      return;
    }
    const admittedCommand = dispatch.command;
    // A pipeline override's model commits again over a change made during
    // setup, as at acceptance: host routing and the session follow the chat.
    const routedTab = admittedCommand.turnOverride
      ? await this.commitTurnOverrideModel(scope, admittedCommand, tab)
      : tab;
    const request = {
      ...admittedSendRequest(scope, admittedCommand, routedTab, {
        startsNewTrackedChat: dispatch.startsNewTrackedChat,
      }),
      ...(dispatch.admissionCheck
        ? { admittedApproval: admittedApprovalOf(tab, admissionDefault) }
        : {}),
    };
    held.state = 'dispatching';
    if (this.setupHolds.get(key) === hold) this.setupHolds.delete(key);
    await this.dispatchAdmitted(
      scope,
      dispatch.envelope,
      admittedCommand,
      dispatch.revision,
      {
        request,
        timestamp: held.timestamp,
        installedStartingRuntime: ownsRuntime,
        acknowledged: true,
      },
    );
  }

  /**
   * Commits a queued pipeline send's override model to its chat when the chat
   * moved off it while the send waited, so host routing follows the override.
   */
  public async commitTurnOverrideModelFor(
    request: ChatSendMessageRequest,
  ): Promise<void> {
    const override = request.turnOverride;
    const { userMessageId } = request;
    if (
      userMessageId === undefined ||
      (override?.model === undefined && override?.providerType === undefined)
    )
      return;
    const scope = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
    };
    const state = await this.repository.getState(scope, {
      chatIds: [request.chatId],
    });
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === request.chatId,
    );
    if (!tab || tab.kind === 'file') return;
    await this.commitTurnOverrideModel(
      scope,
      {
        chatId: request.chatId,
        userMessageId,
        model: override.model,
        providerType: override.providerType,
      },
      tab,
    );
  }

  /** The chat with its send's model committed, when the chat has moved off it. */
  private async commitTurnOverrideModel(
    scope: ChatScopeKey,
    command: Pick<
      SendMessageCommand,
      'chatId' | 'userMessageId' | 'model' | 'providerType'
    >,
    tab: PersistedChatTab,
  ): Promise<PersistedChatTab> {
    if (tabWithSendModel(tab, command) === tab) return tab;
    const commit = await this.repository.transactWith(
      scope,
      (current) => {
        const latest = current.tabsFile.tabs.find(
          (candidate) => candidate.id === command.chatId,
        );
        if (!latest || latest.kind === 'file') return [];
        const next = tabWithSendModel(latest, command);
        return next === latest ? [] : [{ type: 'tab.created', tab: next }];
      },
      {
        source: 'automation',
        mutationId: `${command.chatId}:${command.userMessageId}:override-model`,
        chatIds: [command.chatId],
      },
    );
    const committed = commit.state.tabsFile.tabs.find(
      (candidate) => candidate.id === command.chatId,
    );
    return committed && committed.kind !== 'file' ? committed : tab;
  }

  /** Runs a held desktop send's `onHeldDispatchFailed`, logging a failure. */
  private async undoHeldLocalAdmission(held: HeldSend): Promise<void> {
    if (held.dispatch.kind !== 'local') return;
    const { scope, command } = held;
    await held.dispatch.onDispatchFailed?.().catch((undoError: unknown) => {
      logMainProcessWarn(
        `[chat-state] Could not undo the admission of a held send for ${scope.projectId}/${scope.worktreeId}/${command.chatId}:`,
        undoError,
      );
    });
  }

  private async settleHeldSend(
    held: HeldSend,
    outcome: 'cancelled' | 'failed',
    reason: string = WORKTREE_SETUP_FAILED,
  ): Promise<void> {
    if (held.state !== 'held') return;
    held.state = 'settled';
    await this.endUnacceptedTurn(
      held.scope,
      held.command,
      held.timestamp,
      outcome,
      reason,
    );
  }

  /**
   * Ends a turn no provider accepted. One commit records how it ended on its
   * chat (`unacceptedTurnEnds`, which turnOutcome reports) and, while no
   * other turn runs the chat, in the chat's runtime. Its terminal event is
   * delivered only once that commit is durable, or once the chat itself is
   * gone. A commit that fails is retried with backoff; until one succeeds
   * the turn stays as durable state last recorded it, which startup
   * recovery records as interrupted if none ever does.
   */
  private async endUnacceptedTurn(
    scope: ChatScopeKey,
    command: { chatId: string; userMessageId: string },
    startedAt: number,
    outcome: 'cancelled' | 'failed',
    reason: string,
    attempt = 0,
  ): Promise<void> {
    const occurredAt = this.now();
    const endKey = awaitingSetupKey(scope, command);
    this.unrecordedTurnEnds.add(endKey);
    let acceptedMeanwhile = false;
    try {
      await this.repository.transactWith(
        scope,
        (current) => {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === command.chatId,
          );
          if (!tab) return [];
          if (
            attempt > 0 &&
            tab.lastAcceptedUserMessageId === command.userMessageId
          ) {
            acceptedMeanwhile = true;
            return [];
          }
          const runtime = current.runtimeByChatId[command.chatId];
          const ended = recordUnacceptedTurnEnds(
            tab,
            runtime,
            [
              {
                userMessageId: command.userMessageId,
                startedAt,
                outcome,
                reason,
              },
            ],
            occurredAt,
          );
          return [
            ...ended.mutations,
            ...(ended.runtime !== undefined && ended.runtime !== runtime
              ? [
                  {
                    type: 'runtime.patched' as const,
                    chatId: command.chatId,
                    runtime: ended.runtime,
                  },
                ]
              : []),
          ];
        },
        {
          source: 'provider',
          mutationId: unacceptedTurnMutationId(command, outcome),
          checkpoint: true,
          chatIds: [command.chatId],
        },
      );
    } catch (error) {
      logMainProcessWarn(
        `[chat-state] Could not record how an unaccepted turn ended for ${scope.projectId}/${scope.worktreeId}/${command.chatId}:`,
        error,
      );
      if (!this.draining && attempt < UNACCEPTED_TURN_END_RETRIES) {
        const retry = this.schedule(
          () => {
            void this.endUnacceptedTurn(
              scope,
              command,
              startedAt,
              outcome,
              reason,
              attempt + 1,
            );
          },
          Math.min(1_000 * 2 ** attempt, 30_000),
        );
        retry.unref?.();
      }
      return;
    }
    this.unrecordedTurnEnds.delete(endKey);
    if (acceptedMeanwhile) return;
    this.deliverUnacceptedTurnEnd(scope, command, outcome, reason);
  }

  private deliverUnacceptedTurnEnd(
    scope: ChatScopeKey,
    command: { chatId: string; userMessageId: string },
    outcome: 'cancelled' | 'failed',
    reason: string,
    marker: Record<string, true> = { canopy_turn_unaccepted: true },
  ): void {
    void this.notifyTurnTerminal({
      ...scope,
      chatId: command.chatId,
      userMessageId: command.userMessageId,
      outcome,
      data: {
        type: 'result',
        is_error: outcome === 'failed',
        result: outcome === 'failed' ? reason : 'Cancelled',
        canopy_turn_user_message_id: command.userMessageId,
        ...marker,
      },
    }).catch((error: unknown) => {
      logMainProcessWarn(
        `[chat-state] Could not deliver the end of an unaccepted turn for ${scope.projectId}/${scope.worktreeId}/${command.chatId}:`,
        error,
      );
    });
  }

  private async settleHeldSendsOfChat(
    scope: ChatScopeKey,
    chatId: string,
  ): Promise<void> {
    const runtimeHostKey = chatRuntimeHostKey(scope, chatId);
    await Promise.all(
      Array.from(this.heldSends.values())
        .filter(
          (held) =>
            chatRuntimeHostKey(held.scope, held.command.chatId) ===
            runtimeHostKey,
        )
        .map((held) => this.settleHeldSend(held, 'cancelled')),
    );
  }

  /**
   * Commits an admitted send's prompt, with its turn's starting runtime when
   * the send starts a turn: at immediate admission, or when a worktree setup
   * holds the turn. Returns whether it installed that runtime.
   */
  private async commitAdmittedPrompt(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: SendMessageCommand,
    timestamp: number,
    asyncAnswer:
      | { questionId: string; answers: McpQuestionAnswer[] }
      | undefined,
    options: { cancelledBeforeDispatch: boolean; startsTurn: boolean },
  ): Promise<boolean> {
    let installed = false;
    await this.repository.transactWith(
      scope,
      (current, _revision, transaction) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === command.chatId,
        );
        if (
          !tab ||
          tab.kind === 'file' ||
          tab.readOnly ||
          transaction.hasRemovedMessage(command.userMessageId)
        ) {
          throw new Error('Target chat no longer accepts this message');
        }
        const runtime = current.runtimeByChatId[tab.id];
        const runtimeAfterAdmission = removeAdmittingRuntimeEntry(
          runtime,
          command.userMessageId,
        );
        const hasAdmittingEntry = runtimeAfterAdmission !== runtime;
        if (tab.messages.some(({ id }) => id === command.userMessageId)) {
          return runtimeAfterAdmission && hasAdmittingEntry
            ? [
                {
                  type: 'runtime.patched',
                  chatId: tab.id,
                  runtime: runtimeAfterAdmission,
                },
              ]
            : [];
        }
        const turnAlreadyActive =
          runtime !== undefined &&
          ['starting', 'streaming', 'awaiting_input', 'completing'].includes(
            runtime.status,
          );
        installed =
          options.startsTurn &&
          !options.cancelledBeforeDispatch &&
          !asyncAnswer &&
          !turnAlreadyActive;
        // An automation's own send (CAN-4549) keeps its banner directly ahead
        // of the prompt; the dispatch funnels skip it once the prompt exists.
        const automationBanner = command.automationDispatch
          ? buildAutomationInfoMessage(
              automationDispatchRequestFields(command.automationDispatch),
              command.userMessageId,
              tab.messages,
              timestamp,
            )
          : null;
        const mutations: ChatCoreMutation[] = [
          ...(automationBanner &&
          !tab.messages.some(({ id }) => id === automationBanner.id)
            ? [
                {
                  type: 'message.upserted' as const,
                  chatId: tab.id,
                  message: automationBanner,
                },
              ]
            : []),
          {
            type: 'message.upserted',
            chatId: tab.id,
            message: {
              ...buildUserMessage(command, timestamp),
              ...(asyncAnswer
                ? {
                    blocks: [
                      {
                        type: 'text',
                        text: command.text,
                        asyncQuestionAnswer: {
                          requestId: asyncAnswer.questionId,
                          startsTurn: options.startsTurn,
                          answers: asyncAnswer.answers,
                        },
                      },
                    ],
                  }
                : {}),
            },
          },
        ];
        if (installed) {
          if (!command.planReviewApproval)
            mutations.push(...retireSupersededPlanExitMutations(tab));
          const nextRuntime: ChatRuntimeState = {
            ...runtimeAfterAdmission,
            status: 'starting',
            queuedMessageIds: runtime?.queuedMessageIds ?? [],
            activeTurn: {
              userMessageId: command.userMessageId,
              startedAt: timestamp,
            },
            lastActivityAt: timestamp,
          };
          mutations.push({
            type: 'runtime.patched',
            chatId: tab.id,
            runtime: nextRuntime,
          });
        } else if (runtimeAfterAdmission && hasAdmittingEntry) {
          mutations.push({
            type: 'runtime.patched',
            chatId: tab.id,
            runtime: runtimeAfterAdmission,
          });
        }
        return mutations;
      },
      {
        source: 'renderer-command',
        mutationId: `${envelope.commandId}:immediate-prompt`,
        chatIds: [command.chatId],
      },
    );
    return installed;
  }

  private async dispatchAdmitted(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: SendMessageCommand,
    revision: number,
    admitted: {
      request: ChatSendMessageRequest;
      timestamp: number;
      installedStartingRuntime: boolean;
      acknowledged?: boolean;
      previousPlanTracking?: ChatTabMetadataPatch;
    },
    asyncAnswer?: { questionId: string; answers: McpQuestionAnswer[] },
  ): Promise<ChatCommandResult> {
    const { request, timestamp } = admitted;
    let { installedStartingRuntime } = admitted;
    const commitImmediatePrompt = async (options: {
      cancelledBeforeDispatch: boolean;
      startsTurn: boolean;
    }): Promise<void> => {
      if (
        await this.commitAdmittedPrompt(
          scope,
          envelope,
          command,
          timestamp,
          asyncAnswer,
          options,
        )
      )
        installedStartingRuntime = true;
    };
    try {
      // Answers use the same queue-aware dispatch hook as every other input.
      // It owns active-session delivery and calls the prompt commit only after
      // immediate admission; ChatStateService never reaches into a session.
      await this.dispatch(
        request,
        envelope.origin ?? 'desktop',
        commitImmediatePrompt,
      );
      if (asyncAnswer) {
        await this.retireAsyncAnswerAdmission(
          scope,
          command.chatId,
          command.userMessageId,
          `${envelope.commandId}:answer-admission-retired`,
        );
      }
    } catch (error) {
      if (isAgentSenderContextError(error)) {
        // Dispatch can refuse an agent send after its input was committed.
        // Reject atomically before surfacing the typed refusal to the sender.
        if (!asyncAnswer && command.agentSenderProvenance) {
          await this.repository.transactWith(
            scope,
            (current) => [
              ...(current.tabsFile.tabs
                .find((candidate) => candidate.id === command.chatId)
                ?.messages.some(
                  (message) => message.id === command.userMessageId,
                )
                ? [
                    {
                      type: 'message.removed' as const,
                      chatId: command.chatId,
                      messageId: command.userMessageId,
                    },
                  ]
                : []),
              // Clear only a turn this send still owns, keeping queued payloads;
              // a newer send may have started or queued during authorization.
              ...((): ChatCoreMutation[] => {
                const runtime = current.runtimeByChatId[command.chatId];
                if (
                  !installedStartingRuntime ||
                  runtime?.activeTurn?.userMessageId !== command.userMessageId
                )
                  return [];
                const {
                  activeTurn: _ownedTurn,
                  error: _error,
                  ...rest
                } = runtime;
                void _ownedTurn;
                void _error;
                return [
                  {
                    type: 'runtime.patched' as const,
                    chatId: command.chatId,
                    runtime: {
                      ...rest,
                      status: 'idle' as const,
                      lastActivityAt: this.now(),
                    },
                  },
                ];
              })(),
            ],
            {
              source: 'renderer-command',
              mutationId: `${envelope.commandId}:agent-send-rejected`,
              commandResult: {
                commandId: envelope.commandId,
                outcome: 'rejected',
                reason: error.message,
              },
              chatIds: [command.chatId],
            },
          );
        }
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (asyncAnswer) {
        if (
          await this.hasDurableAsyncAnswerOwnership(
            scope,
            command.chatId,
            command.userMessageId,
          )
        ) {
          // A queue/input-delivery owner or a committed prompt is now the only
          // copy allowed to settle this answer. Preserve the answered question
          // even when the claim's later settlement failed.
          let rejectedRevision = revision;
          try {
            const retained = await this.repository.transactWith(
              scope,
              (current): ChatCoreMutation[] => {
                const tab = current.tabsFile.tabs.find(
                  (candidate) => candidate.id === command.chatId,
                );
                if (!tab) return [];
                const mutations: ChatCoreMutation[] = [
                  {
                    type: 'tab.metadata_patched',
                    tabId: tab.id,
                    patch: {},
                  },
                ];
                const runtime = current.runtimeByChatId[tab.id];
                const nextRuntime = removeAdmittingRuntimeEntry(
                  runtime,
                  command.userMessageId,
                );
                if (nextRuntime && nextRuntime !== runtime) {
                  mutations.push({
                    type: 'runtime.patched',
                    chatId: tab.id,
                    runtime: nextRuntime,
                  });
                }
                return mutations;
              },
              {
                source: 'renderer-command',
                mutationId: `${envelope.commandId}:answer-delivery-failed`,
                commandResult: {
                  commandId: envelope.commandId,
                  outcome: 'rejected',
                  reason,
                },
                chatIds: [command.chatId],
              },
            );
            rejectedRevision = retained.revision;
          } catch {
            // The original accepted receipt and delivery evidence remain
            // authoritative if recording the failure result also fails.
          }
          return commandResult(envelope, rejectedRevision, 'rejected', {
            reason,
          });
        }
        const rollback = await this.repository.transactWith(
          scope,
          (current) => {
            const question = current.tabsFile.pendingQuestions?.find(
              (candidate) =>
                candidate.requestId === asyncAnswer.questionId &&
                candidate.chatId === command.chatId,
            );
            const mutations: ChatCoreMutation[] = [];
            if (question?.answeredAt === timestamp) {
              const {
                answeredAt: _answeredAt,
                answers: _answers,
                ...pending
              } = question;
              void _answeredAt;
              void _answers;
              mutations.push(
                { type: 'pending_question.upserted', question: pending },
                {
                  type: 'message.removed',
                  chatId: command.chatId,
                  messageId: command.userMessageId,
                },
              );
            }
            const runtime = current.runtimeByChatId[command.chatId];
            const runtimeAfterAdmission = removeAdmittingRuntimeEntry(
              runtime,
              command.userMessageId,
            );
            if (runtimeAfterAdmission && runtimeAfterAdmission !== runtime) {
              mutations.push({
                type: 'runtime.patched',
                chatId: command.chatId,
                runtime: runtimeAfterAdmission,
              });
            }
            return mutations;
          },
          {
            source: 'renderer-command',
            mutationId: `${envelope.commandId}:answer-rejected`,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'rejected',
              reason,
            },
          },
        );
        // An unknown transport failure must not trigger a second delivery or
        // settle the still-running provider. Keep the form for explicit retry.
        return commandResult(envelope, rollback.revision, 'rejected', {
          reason,
        });
      }
      if (!installedStartingRuntime && admitted.acknowledged !== true) {
        const rollback = await this.repository.transactWith(
          scope,
          (current): ChatCoreMutation[] => {
            const tab = current.tabsFile.tabs.find(
              (candidate) => candidate.id === command.chatId,
            );
            if (!tab) return [];
            const mutations: ChatCoreMutation[] = tab.messages.some(
              (message) => message.id === command.userMessageId,
            )
              ? [
                  {
                    type: 'message.removed',
                    chatId: command.chatId,
                    messageId: command.userMessageId,
                  },
                ]
              : // Deferred rows do not exist to remove. Still write the rejected
                // command receipt rather than leaving acceptance recorded as applied.
                [{ type: 'tab.metadata_patched', tabId: tab.id, patch: {} }];
            // A refusal is not an accepted retry. Restore only while this
            // registration still owns the slot; never roll back a newer turn.
            if (
              admitted.previousPlanTracking &&
              tab.trackedPlanImplementation?.userMessageId ===
                command.userMessageId
            )
              mutations.push({
                type: 'tab.metadata_patched',
                tabId: tab.id,
                patch: admitted.previousPlanTracking,
              });
            const runtime = current.runtimeByChatId[tab.id];
            const runtimeAfterAdmission = removeAdmittingRuntimeEntry(
              runtime,
              command.userMessageId,
            );
            if (runtimeAfterAdmission && runtimeAfterAdmission !== runtime) {
              mutations.push({
                type: 'runtime.patched',
                chatId: tab.id,
                runtime: runtimeAfterAdmission,
              });
            }
            return mutations;
          },
          {
            source: 'renderer-command',
            mutationId: `${envelope.commandId}:queue-rejected`,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'rejected',
              reason,
            },
            chatIds: [command.chatId],
          },
        );
        return commandResult(envelope, rollback.revision, 'rejected', {
          reason,
        });
      }
      if (
        await this.repository.hasMutation(
          scope,
          `${command.chatId}:${command.userMessageId}:accepted`,
        )
      ) {
        await this.transactWithTurnHandoff(
          scope,
          (current) => {
            const runtime = current.runtimeByChatId[command.chatId];
            if (
              runtime !== undefined &&
              runtime.activeTurn?.userMessageId !== command.userMessageId &&
              UNFINISHED_RUNTIME_STATUSES.includes(runtime.status)
            )
              return [];
            const failedRuntime: ChatRuntimeState = {
              status: 'failed',
              queuedMessageIds: runtime?.queuedMessageIds ?? [],
              ...(runtime?.queuedMessages
                ? { queuedMessages: runtime.queuedMessages }
                : {}),
              ...(runtime?.turn !== undefined ? { turn: runtime.turn } : {}),
              activeTurn: {
                userMessageId: command.userMessageId,
                startedAt: timestamp,
              },
              lastActivityAt: this.now(),
              error: {
                code: 'provider_error',
                message: reason,
                retryable: true,
                occurredAt: new Date(this.now()).toISOString(),
              },
            };
            const tab = current.tabsFile.tabs.find(
              (candidate) => candidate.id === command.chatId,
            );
            // The host settles this turn, so it records the turn's end too.
            const turnEnds = tab
              ? settleTurnEnds(
                  tab.turnEnds,
                  runtime,
                  failedRuntime,
                  command.userMessageId,
                  this.now(),
                )
              : undefined;
            return [
              ...(tab && turnEnds && turnEnds !== tab.turnEnds
                ? [
                    {
                      type: 'tab.metadata_patched' as const,
                      tabId: tab.id,
                      patch: { turnEnds },
                    },
                  ]
                : []),
              {
                type: 'runtime.patched',
                chatId: command.chatId,
                runtime: failedRuntime,
              },
              ...settleRefusedAgentInput(tab, command.userMessageId, reason),
            ];
          },
          {
            source: 'provider',
            mutationId: `${envelope.commandId}:dispatch-failed`,
            checkpoint: true,
            chatIds: [command.chatId],
          },
        );
      } else {
        await this.endUnacceptedTurn(
          scope,
          command,
          timestamp,
          'failed',
          reason,
        );
        if (command.agentSenderProvenance)
          await this.repository.transactWith(
            scope,
            (current) =>
              settleRefusedAgentInput(
                current.tabsFile.tabs.find(
                  (candidate) => candidate.id === command.chatId,
                ),
                command.userMessageId,
                reason,
              ),
            {
              source: 'provider',
              mutationId: `${envelope.commandId}:agent-input-refused`,
              chatIds: [command.chatId],
            },
          );
      }
    }
    return commandResult(envelope, revision, 'applied', {
      entityId: command.chatId,
      messageId: command.userMessageId,
    });
  }

  private async commitTerminalInitialPrompt(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
  ): Promise<ChatCommandResult> {
    const command = envelope.command;
    if (command.type !== 'chat.commit_terminal_initial_prompt') {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
      );
    }
    validateId(command.chatId, 'chatId');
    validateId(command.userMessageId, 'userMessageId');
    validateId(command.turnTimerMessageId, 'turnTimerMessageId');
    const snapshot = await this.repository.getState(scope, {
      chatIds: [command.chatId],
    });
    const snapshotTab = snapshot.tabsFile.tabs.find(
      (tab) => tab.id === command.chatId,
    );
    const trustedInput = snapshotTab
      ? retainedTerminalAgentInput(snapshotTab, command.userMessageId)
      : undefined;
    if (trustedInput) await revalidateAgentSenderRequest(trustedInput);
    const timestamp = this.now();
    const firstMessageTitle = initialChatTitle(command.text);
    let precommitResult:
      | 'not_found'
      | 'already_applied'
      | 'rejected'
      | undefined;
    const commit = await this.repository.transactWith(
      scope,
      (current, _revision, transaction) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === command.chatId,
        );
        if (!tab || tab.kind === 'file') {
          precommitResult = 'not_found';
          return [];
        }
        if (tab.readOnly) {
          precommitResult = 'rejected';
          return [];
        }
        if (tab.messages.some(({ id }) => id === command.userMessageId)) {
          precommitResult = 'already_applied';
          return [];
        }
        if (
          transaction.hasRemovedMessage(command.userMessageId) ||
          transaction.hasRemovedMessage(command.turnTimerMessageId)
        ) {
          precommitResult = 'not_found';
          return [];
        }
        const consumedIds = new Set(command.pendingSystemInstructionIds ?? []);
        const pendingSystemInstructions =
          tab.pendingSystemInstructions?.filter(
            (instruction) => !consumedIds.has(instruction.id),
          ) ?? [];
        const mutations: ChatCoreMutation[] = [];
        if (trustedInput && isInputLedger(tab.inputDelivery)) {
          mutations.push({
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              inputDelivery: {
                ...tab.inputDelivery,
                rows: tab.inputDelivery.rows.map((row) =>
                  row.id === command.userMessageId
                    ? { ...row, state: 'picked-up', revision: row.revision + 1 }
                    : row,
                ),
              },
            },
          });
        }
        if (
          tab.messages.length === 0 &&
          hasPlaceholderChatTitle(tab.title) &&
          tab.title !== firstMessageTitle
        ) {
          mutations.push({
            type: 'tab.created',
            tab: {
              ...tab,
              title: firstMessageTitle,
              automaticTitleState:
                tab.automaticTitleState === 'closed' ? 'closed' : 'pending',
            },
          });
        }
        mutations.push(
          {
            type: 'message.upserted',
            chatId: tab.id,
            message: buildUserMessage(trustedInput ?? command, timestamp),
          },
          {
            type: 'message.upserted',
            chatId: tab.id,
            message: {
              id: command.turnTimerMessageId,
              role: 'system',
              timestamp,
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: timestamp,
                  completedAt: null,
                },
              ],
            },
          },
        );
        if (
          consumedIds.size > 0 &&
          pendingSystemInstructions.length !==
            (tab.pendingSystemInstructions?.length ?? 0)
        ) {
          mutations.push({
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              pendingSystemInstructions:
                pendingSystemInstructions.length > 0
                  ? pendingSystemInstructions
                  : null,
            },
          });
        }
        return mutations;
      },
      {
        ...{
          source: 'terminal',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
            entityId: command.chatId,
            messageId: command.userMessageId,
          },
        },
        chatIds: [command.chatId],
      },
    );
    if (precommitResult) {
      return commandResult(envelope, commit.revision, precommitResult, {
        entityId: command.chatId,
        messageId: command.userMessageId,
      });
    }
    return commandResult(
      envelope,
      commit.revision,
      commit.applied ? 'applied' : 'already_applied',
      { entityId: command.chatId, messageId: command.userMessageId },
    );
  }

  private async queueCommand(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
  ): Promise<ChatCommandResult> {
    // See getState(): queue-service is loaded lazily to break its chat-state
    // port initialization cycle, not as a performance deferral.
    const { getChatQueueService, QUEUE_ENTRY_REVISION_CONFLICT_REASON } =
      await import('./chat-queue-service');
    const queue = getChatQueueService();
    const command = envelope.command;
    if (
      command.type !== 'chat.edit_queued_message' &&
      command.type !== 'chat.move_queued_message' &&
      command.type !== 'chat.cancel_queued_message' &&
      command.type !== 'chat.steer_queued_message' &&
      command.type !== 'chat.force_queued_message' &&
      command.type !== 'chat.set_queued_message_edit_lock'
    ) {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
      );
    }
    const chatId = command.chatId;
    const durableCommandResult = {
      commandId: envelope.commandId,
      outcome: 'applied' as const,
      entityId: chatId,
      ...(command.type === 'chat.steer_queued_message' &&
      command.agentSteeringActor
        ? { agentSteeringActor: command.agentSteeringActor }
        : {}),
    };
    // Do not hold the repository's per-scope serializer while queue.force()
    // cancels and settles a provider turn: settlement re-enters this service
    // to commit the terminal provider event for the same scope.
    await this.repository.assertExpectedRevision(
      scope,
      expectedRevisionForCommand(envelope),
    );
    const guard =
      command.queuedMessageRevision === undefined
        ? undefined
        : { entryRevision: command.queuedMessageRevision };
    const guardArgs: [] | [ChatQueueEntryGuard] = guard ? [guard] : [];
    let queueResult: 'applied' | 'not_found' | 'busy' | 'conflict';
    if (command.type === 'chat.edit_queued_message') {
      queueResult = await queue.edit(
        {
          ...scope,
          chatId: command.chatId,
          entryId: command.queuedMessageId,
          text: command.text,
          ...(command.fileReferences
            ? { fileReferences: command.fileReferences }
            : {}),
          ...(command.attachmentPaths
            ? { attachmentPaths: command.attachmentPaths }
            : {}),
          ...(command.attachmentPromptContexts
            ? { attachmentPromptContexts: command.attachmentPromptContexts }
            : {}),
          ...(command.inputMode ? { inputMode: command.inputMode } : {}),
        },
        durableCommandResult,
        envelope.origin === 'portal' ? 'preserve' : 'replace',
        guard,
      );
    } else if (command.type === 'chat.move_queued_message') {
      queueResult = await queue.move(
        { ...scope, chatId: command.chatId },
        command.queuedMessageId,
        command.beforeQueuedMessageId,
        durableCommandResult,
        ...guardArgs,
      );
    } else if (command.type === 'chat.cancel_queued_message') {
      queueResult = await queue.cancel(
        { ...scope, chatId: command.chatId },
        command.queuedMessageId,
        durableCommandResult,
        ...guardArgs,
      );
    } else if (command.type === 'chat.steer_queued_message') {
      queueResult = await queue.steer(
        { ...scope, chatId: command.chatId },
        command.queuedMessageId,
        durableCommandResult,
        ...guardArgs,
      );
    } else if (command.type === 'chat.set_queued_message_edit_lock') {
      // A lease, not a queue change: no receipt is written (CAN-4112 D7).
      try {
        queueResult = await queue.setEditLock(
          { ...scope, chatId: command.chatId },
          command.queuedMessageId,
          command.locked,
          command.acquisitionId,
          guard,
        );
      } catch (error) {
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          'rejected',
          {
            reason:
              error instanceof Error && error.message
                ? error.message
                : 'This message is no longer available to edit.',
          },
        );
      }
    } else {
      queueResult = await queue.force(
        { ...scope, chatId: command.chatId },
        command.queuedMessageId,
        durableCommandResult,
        ...guardArgs,
      );
    }
    if (queueResult === 'conflict')
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'conflict',
        { reason: QUEUE_ENTRY_REVISION_CONFLICT_REASON },
      );
    if (queueResult !== 'applied') {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        queueResult === 'not_found' ? 'not_found' : 'rejected',
        queueResult !== 'busy'
          ? undefined
          : command.type === 'chat.move_queued_message'
            ? {
                reason:
                  'The queue cannot be reordered while a message is being edited or dispatched',
              }
            : { reason: 'The queued message is currently being dispatched' },
      );
    }
    return commandResult(
      envelope,
      await this.repository.getRevision(scope),
      'applied',
      { entityId: chatId },
    );
  }

  private async answerQuestion(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    dismiss: boolean,
    options: TrustedChatCommandExecutionOptions,
  ): Promise<ChatCommandResult> {
    const command = envelope.command;
    if (
      command.type !== 'chat.answer_question' &&
      command.type !== 'chat.dismiss_question'
    ) {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
      );
    }
    let question: PersistedPendingQuestion | undefined;
    let noOpOutcome: 'not_found' | 'already_applied' | 'rejected' | undefined;
    try {
      const state = await this.repository.getState(scope);
      if (!dismiss && command.type === 'chat.answer_question') {
        const pending = state.tabsFile.pendingQuestions?.find(
          (candidate) =>
            candidate.chatId === command.chatId &&
            candidate.requestId === command.questionId,
        );
        if (pending?.delivery === 'async') {
          if (pending.answeredAt !== undefined)
            return commandResult(
              envelope,
              await this.repository.getRevision(scope),
              'already_applied',
            );
          // Use the stored question text and ids, never caller-supplied labels.
          if (command.answers.length !== pending.questions.length)
            throw new Error('Answer every question before submitting');
          const answers = pending.questions.map((question, index) => {
            const answer = command.answers[index];
            if (
              !answer ||
              (answer.questionId !== undefined &&
                answer.questionId !== question.id) ||
              answer.selectedOptions.length > 1 ||
              answer.selectedOptions.some(
                (option) => !question.options.includes(option),
              ) ||
              (!answer.selectedOptions.length && !answer.freeformText?.trim())
            )
              throw new Error('Invalid question answer');
            return {
              ...answer,
              questionId: question.id,
              question: question.question,
            };
          });
          return await this.sendMessage(
            scope,
            {
              ...envelope,
              command: {
                type: 'chat.send_message',
                chatId: command.chatId,
                userMessageId: `answer-${envelope.commandId}`,
                text: formatAskUserAnswers(answers),
                ...(options.agentSent ? { agentSent: options.agentSent } : {}),
              },
            },
            options,
            { questionId: pending.requestId, answers },
          );
        }
      }
      const pauseQuestion = (state.tabsFile.pendingQuestions ?? []).find(
        (candidate) =>
          candidate.chatId === command.chatId &&
          (candidate.requestId === command.questionId ||
            candidate.toolUseId === command.questionId),
      );
      this.observeTurnPause({
        ...scope,
        chatId: command.chatId,
        type: 'PauseClosed',
        ownerKind: 'question',
        ownerId: pauseQuestion?.requestId ?? command.questionId,
        atMs: this.now(),
      });
      const commit = await this.transactWithTurnHandoff(
        scope,
        (current) => {
          const currentQuestion = (
            current.tabsFile.pendingQuestions ?? []
          ).find(
            (candidate) =>
              candidate.chatId === command.chatId &&
              (candidate.requestId === command.questionId ||
                candidate.toolUseId === command.questionId),
          );
          question = currentQuestion;
          if (!currentQuestion) {
            noOpOutcome = 'not_found';
            return [];
          }
          if (
            command.type === 'chat.answer_question' &&
            isAskUserRequestCancelled(currentQuestion.requestId)
          ) {
            noOpOutcome = 'rejected';
            return [];
          }
          if (currentQuestion.answeredAt !== undefined) {
            noOpOutcome = 'already_applied';
            return [];
          }
          if (command.type === 'chat.answer_question') {
            const error = validateQuestionControlAnswers(
              currentQuestion.questions,
              command.answers,
            );
            if (error) throw new Error(error);
          }
          const persistedAnswers =
            command.type === 'chat.answer_question'
              ? command.answers.map((answer, index) => {
                  const suppliedQuestionId =
                    typeof answer.questionId === 'string' &&
                    answer.questionId.length > 0
                      ? answer.questionId
                      : undefined;
                  const matchedQuestion = suppliedQuestionId
                    ? currentQuestion.questions.find(
                        (candidate) => candidate.id === suppliedQuestionId,
                      )
                    : currentQuestion.questions[index];
                  const persistedAnswer =
                    typeof matchedQuestion?.id === 'string' &&
                    matchedQuestion.id.length > 0
                      ? { ...answer, questionId: matchedQuestion.id }
                      : answer;
                  if (!answer.freeformText) {
                    return persistedAnswer;
                  }
                  if (
                    matchedQuestion !== undefined &&
                    matchedQuestion.secret !== true
                  ) {
                    return persistedAnswer;
                  }
                  return { ...persistedAnswer, freeformText: '[hidden]' };
                })
              : [];
          return dismiss && currentQuestion.delivery !== 'async'
            ? [
                {
                  type: 'pending_question.removed' as const,
                  requestId: currentQuestion.requestId,
                  chatId: currentQuestion.chatId,
                },
              ]
            : [
                {
                  type: 'pending_question.upserted' as const,
                  question: {
                    ...currentQuestion,
                    answers: persistedAnswers,
                    answeredAt: this.now(),
                    ...(dismiss ? { dismissedAt: this.now() } : {}),
                  },
                },
              ];
        },
        {
          source: 'renderer-command',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
          },
          ...expectedRevisionOption(envelope),
          chatIds: [command.chatId],
        },
      );
      if (noOpOutcome) {
        return commandResult(envelope, commit.revision, noOpOutcome, {
          ...(question ? { entityId: question.requestId } : {}),
        });
      }
      if (!question) {
        return commandResult(envelope, commit.revision, 'rejected');
      }
      if (commit.applied) {
        if (question.delivery === 'async')
          return commandResult(envelope, commit.revision, 'applied', {
            entityId: question.requestId,
          });
        if (dismiss) rejectRequest(question.requestId, 'cancelled');
        else if (command.type === 'chat.answer_question') {
          const answeredBy =
            options.answeredByPerson === true && !options.agentSent
              ? 'person'
              : 'agent';
          resolveRequest(
            question.requestId,
            command.answers.map((answer) => ({ ...answer, answeredBy })),
          );
        }
      }
      return commandResult(envelope, commit.revision, 'applied', {
        entityId: question.requestId,
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async closeTab(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    tabId: string,
    mode: 'archive' | 'discard_empty' | 'discard',
  ): Promise<ChatCommandResult> {
    let outcome: ChatCommandResult['outcome'] = 'applied';
    let reason: string | undefined;
    let result: ChatCommandResult;
    try {
      const chatCloseBlockReason = await this.getChatCloseBlockReasonChecker();
      const archivedAt = mode === 'archive' ? this.now() : undefined;
      const archivedAtIso =
        archivedAt === undefined
          ? undefined
          : new Date(archivedAt).toISOString();
      const commit = await this.repository.transactWith(
        scope,
        (state) => {
          const tab = state.tabsFile.tabs.find(
            (candidate) => candidate.id === tabId,
          );
          if (!tab) {
            outcome = 'not_found';
            return [];
          }
          const runtime = state.runtimeByChatId[tabId];
          const runtimeActive =
            runtime !== undefined &&
            [
              'queued',
              'starting',
              'streaming',
              'awaiting_input',
              'completing',
            ].includes(runtime.status);
          const blockReason = chatCloseBlockReason(
            scope.projectId,
            scope.worktreeId,
            tabId,
          );
          const hasOtherActiveWork =
            runtimeActive ||
            (isInputLedger(tab.inputDelivery) &&
              tab.inputDelivery.rows.some((row) =>
                ['sending', 'pending', 'cancelling'].includes(row.state),
              )) ||
            (runtime?.queuedMessageIds.length ?? 0) > 0 ||
            tab.pendingPlanExit !== undefined;
          if (hasOtherActiveWork || blockReason !== null) {
            outcome = 'rejected';
            reason =
              blockReason === 'background'
                ? BACKGROUND_WORK_CHAT_REFUSAL
                : 'The chat cannot be closed while it has active, queued, or pending plan work';
            return [];
          }
          if (mode === 'discard_empty' && tab.messages.length > 0) {
            outcome = 'rejected';
            reason = 'Only a deliberately blank starter can be discarded';
            return [];
          }
          if (
            mode === 'discard' &&
            !isHardDeleteChatScope(scope.projectId, scope.worktreeId)
          ) {
            outcome = 'rejected';
            reason =
              'Only sentinel scopes that never archive can discard a used chat';
            return [];
          }
          const mutations: ChatCoreMutation[] = [
            { type: 'tab.removed', tabId },
          ];
          if (archivedAt !== undefined && archivedAtIso !== undefined) {
            const messages = settlePersistedInterruptedMessages(
              tab.messages,
              archivedAt,
              runtime,
            );
            const finalizedTab =
              messages === tab.messages ? tab : { ...tab, messages };
            mutations.push({
              type: 'archive.upserted',
              entry: {
                tab: finalizedTab,
                archivedAt: archivedAtIso,
                turnFence: archiveTurnFence(
                  finalizedTab,
                  this.turnHandoff.getState({ ...scope, chatId: tabId }) ??
                    runtime?.turn,
                  archivedAt,
                ),
                turnCount: countTurns(finalizedTab),
                ...('unread' in envelope.command && envelope.command.unread
                  ? { unread: true }
                  : {}),
              },
            });
          }
          const closeCommand =
            envelope.command.type === 'chat.close_tab'
              ? envelope.command
              : undefined;
          const replacementTabId =
            closeCommand?.replacementTab?.tabId ??
            closeCommand?.replacementTabId;
          if (replacementTabId && state.tabsFile.tabs.length === 1) {
            const replacementCommand = closeCommand?.replacementTab ?? {
              type: 'chat.create_tab' as const,
              tabId: replacementTabId,
            };
            const replacement = persistedChatTabFromCreateCommand(
              replacementCommand,
              new Date(this.now()).toISOString(),
              scope.projectId,
            );
            mutations.push(
              { type: 'tab.created', tab: replacement },
              { type: 'tab.active_changed', activeTabId: replacement.id },
            );
          } else if (state.tabsFile.activeTabId === tabId) {
            const remainingTabs = state.tabsFile.tabs.filter(
              (candidate) => candidate.id !== tabId,
            );
            const successor = remainingTabs[remainingTabs.length - 1];
            if (successor) {
              const rememberedEditableTab = rememberedEditableTabAfterClose(
                remainingTabs,
                successor.id,
                state.tabsFile.lastActiveEditableChatId,
              );
              mutations.push({
                type: 'tab.active_changed',
                activeTabId: successor.id,
                ...(rememberedEditableTab
                  ? { lastActiveEditableChatId: rememberedEditableTab.id }
                  : {}),
              });
              // An unread archive (auto-archive) has no evidence anyone saw
              // the chat, so neither is its successor marked seen (CAN-6014).
              const archivedUnread =
                envelope.command.type === 'chat.archive_tab' &&
                envelope.command.unread === true;
              if (successor.kind !== 'file' && !archivedUnread) {
                mutations.push({
                  type: 'tab.metadata_patched',
                  tabId: successor.id,
                  patch: {
                    unread: false,
                    attentionDismissedAt: this.now(),
                  },
                });
              }
            }
          }
          return mutations;
        },
        {
          ...{
            source: 'renderer-command',
            mutationId: envelope.commandId,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'applied',
              entityId: tabId,
              ...(archivedAtIso ? { archivedAt: archivedAtIso } : {}),
            },
            ...expectedRevisionOption(envelope),
          },
          chatIds: [tabId],
        },
      );
      result = commandResult(envelope, commit.revision, outcome, {
        ...(reason ? { reason } : {}),
        ...(outcome === 'applied' ? { entityId: tabId } : {}),
        ...(outcome === 'applied' && archivedAtIso
          ? { archivedAt: archivedAtIso }
          : {}),
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      result = commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
    if (result.outcome === 'applied') {
      await this.settleHeldSendsOfChat(scope, tabId);
      const keepSession =
        envelope.command.type === 'chat.archive_tab' &&
        envelope.command.keepSession === true;
      if (keepSession) {
        // session-manager owns provider sessions that call back into this
        // service, so resolve it only after the archive commit is complete.
        const [
          { markChatSessionIdle },
          { releaseArchivedChatSessionWhenIdle },
        ] = await Promise.all([
          import('../agents/session-manager'),
          import('../lib/archived-chat-session-release'),
        ]);
        markChatSessionIdle(scope.projectId, scope.worktreeId, tabId);
        releaseArchivedChatSessionWhenIdle({ ...scope, chatId: tabId }, this);
      } else {
        const target = { ...scope, chatId: tabId };
        try {
          await this.cleanupSession(target);
        } catch (error) {
          const retry = this.schedule(() => {
            void this.cleanupSession(target).catch((retryError: unknown) => {
              logMainProcessWarn(
                `[chat-state] Provider cleanup retry failed for ${scope.projectId}/${scope.worktreeId}/${tabId}:`,
                retryError,
              );
            });
          }, 1_000);
          retry.unref?.();
          logMainProcessWarn(
            `[chat-state] Provider cleanup failed; scheduled retry for ${scope.projectId}/${scope.worktreeId}/${tabId}:`,
            error,
          );
        }
      }
    }
    return result;
  }

  private async closeTabs(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.close_tabs' }>,
  ): Promise<ChatCommandResult> {
    const cleanupIds: string[] = [];
    let outcome: ChatCommandResult['outcome'] = 'applied';
    let reason: string | undefined;
    let resultEntityId: string | undefined = command.targets[0]?.tabId;
    let result: ChatCommandResult;
    try {
      const chatCloseBlockReason = await this.getChatCloseBlockReasonChecker();
      const archivedAt = this.now();
      const archivedAtIso = command.targets.some(
        (target) => target.mode === 'archive',
      )
        ? new Date(archivedAt).toISOString()
        : undefined;
      const commit = await this.repository.transactWith(
        scope,
        (state) => {
          const targetIds = new Set<string>();
          const mutations: ChatCoreMutation[] = [];
          cleanupIds.length = 0;

          for (const target of command.targets) {
            if (targetIds.has(target.tabId)) {
              outcome = 'rejected';
              reason = 'A tab can appear only once in a bulk close';
              resultEntityId = undefined;
              return [];
            }
            targetIds.add(target.tabId);
            const tab = state.tabsFile.tabs.find(
              (candidate) => candidate.id === target.tabId,
            );
            if (!tab) {
              outcome = 'not_found';
              resultEntityId = target.tabId;
              return [];
            }
            const runtime = state.runtimeByChatId[target.tabId];
            const runtimeActive =
              runtime !== undefined &&
              [
                'queued',
                'starting',
                'streaming',
                'awaiting_input',
                'completing',
              ].includes(runtime.status);
            const blockReason = chatCloseBlockReason(
              scope.projectId,
              scope.worktreeId,
              target.tabId,
            );
            const hasOtherActiveWork =
              runtimeActive ||
              (isInputLedger(tab.inputDelivery) &&
                tab.inputDelivery.rows.some((row) =>
                  ['sending', 'pending', 'cancelling'].includes(row.state),
                )) ||
              (runtime?.queuedMessageIds.length ?? 0) > 0 ||
              tab.pendingPlanExit !== undefined;
            if (hasOtherActiveWork || blockReason !== null) {
              outcome = 'rejected';
              reason =
                blockReason === 'background'
                  ? BACKGROUND_WORK_CHAT_REFUSAL
                  : 'The chat cannot be closed while it has active, queued, or pending plan work';
              resultEntityId = target.tabId;
              return [];
            }
            if (target.mode === 'discard_empty' && tab.messages.length > 0) {
              outcome = 'rejected';
              reason = 'Only a deliberately blank starter can be discarded';
              resultEntityId = target.tabId;
              return [];
            }
            if (
              target.mode === 'discard' &&
              !isHardDeleteChatScope(scope.projectId, scope.worktreeId)
            ) {
              outcome = 'rejected';
              reason =
                'Only sentinel scopes that never archive can discard a used chat';
              resultEntityId = target.tabId;
              return [];
            }

            mutations.push({ type: 'tab.removed', tabId: target.tabId });
            if (target.mode === 'archive') {
              const messages = settlePersistedInterruptedMessages(
                tab.messages,
                archivedAt,
                runtime,
              );
              const finalizedTab =
                messages === tab.messages ? tab : { ...tab, messages };
              mutations.push({
                type: 'archive.upserted',
                entry: {
                  tab: finalizedTab,
                  archivedAt: new Date(archivedAt).toISOString(),
                  turnFence: archiveTurnFence(
                    finalizedTab,
                    this.turnHandoff.getState({
                      ...scope,
                      chatId: target.tabId,
                    }) ?? runtime?.turn,
                    archivedAt,
                  ),
                  turnCount: countTurns(finalizedTab),
                },
              });
            }
            cleanupIds.push(target.tabId);
          }

          const replacementTabId =
            command.replacementTab?.tabId ?? command.replacementTabId;
          if (
            replacementTabId &&
            targetIds.size === state.tabsFile.tabs.length
          ) {
            const replacementCommand = command.replacementTab ?? {
              type: 'chat.create_tab' as const,
              tabId: replacementTabId,
            };
            const replacement = persistedChatTabFromCreateCommand(
              replacementCommand,
              new Date(this.now()).toISOString(),
              scope.projectId,
            );
            mutations.push(
              { type: 'tab.created', tab: replacement },
              { type: 'tab.active_changed', activeTabId: replacement.id },
            );
          } else if (targetIds.has(state.tabsFile.activeTabId)) {
            const previousActiveIndex = state.tabsFile.tabs.findIndex(
              (candidate) => candidate.id === state.tabsFile.activeTabId,
            );
            const remainingTabs = state.tabsFile.tabs.filter(
              (candidate) => !targetIds.has(candidate.id),
            );
            const successor =
              remainingTabs[
                Math.min(previousActiveIndex, remainingTabs.length - 1)
              ];
            if (successor) {
              const rememberedEditableTab = rememberedEditableTabAfterClose(
                remainingTabs,
                successor.id,
                state.tabsFile.lastActiveEditableChatId,
              );
              mutations.push({
                type: 'tab.active_changed',
                activeTabId: successor.id,
                ...(rememberedEditableTab
                  ? { lastActiveEditableChatId: rememberedEditableTab.id }
                  : {}),
              });
              if (successor.kind !== 'file') {
                mutations.push({
                  type: 'tab.metadata_patched',
                  tabId: successor.id,
                  patch: {
                    unread: false,
                    attentionDismissedAt: this.now(),
                  },
                });
              }
            }
          }
          return mutations;
        },
        {
          ...{
            source: 'renderer-command',
            mutationId: envelope.commandId,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'applied',
              ...(command.targets[0]?.tabId
                ? { entityId: command.targets[0].tabId }
                : {}),
              ...(archivedAtIso ? { archivedAt: archivedAtIso } : {}),
            },
            ...expectedRevisionOption(envelope),
          },
          chatIds: command.targets.map((target) => target.tabId),
        },
      );
      result = commandResult(envelope, commit.revision, outcome, {
        ...(reason ? { reason } : {}),
        ...(resultEntityId ? { entityId: resultEntityId } : {}),
        ...(outcome === 'applied' && archivedAtIso
          ? { archivedAt: archivedAtIso }
          : {}),
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      result = commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
    if (result.outcome === 'applied') {
      for (const chatId of cleanupIds) {
        await this.settleHeldSendsOfChat(scope, chatId);
        const cleanupTarget = { ...scope, chatId };
        try {
          await this.cleanupSession(cleanupTarget);
        } catch (error) {
          const retry = this.schedule(() => {
            void this.cleanupSession(cleanupTarget).catch(
              (retryError: unknown) => {
                logMainProcessWarn(
                  `[chat-state] Provider cleanup retry failed for ${scope.projectId}/${scope.worktreeId}/${chatId}:`,
                  retryError,
                );
              },
            );
          }, 1_000);
          retry.unref?.();
          logMainProcessWarn(
            `[chat-state] Provider cleanup failed; scheduled retry for ${scope.projectId}/${scope.worktreeId}/${chatId}:`,
            error,
          );
        }
      }
    }
    return result;
  }

  private async restoreArchive(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.restore_archive' }>,
  ): Promise<ChatCommandResult> {
    let outcome: ChatCommandResult['outcome'] = 'applied';
    const targetTabId = command.targetTabId ?? command.archiveEntryId;
    this.turnHandoff.invalidate({ ...scope, chatId: command.archiveEntryId });
    this.turnHandoff.invalidate({ ...scope, chatId: targetTabId });
    try {
      const commit = await this.repository.transactWith(
        scope,
        (current) => {
          const entry = current.archivesFile.archived.find(
            (candidate) => candidate.tab.id === command.archiveEntryId,
          );
          if (!entry) {
            outcome = current.tabsFile.tabs.some(
              (tab) => tab.id === targetTabId,
            )
              ? 'already_applied'
              : 'not_found';
            return [];
          }
          if (current.tabsFile.tabs.some((tab) => tab.id === targetTabId)) {
            outcome = 'conflict';
            return [];
          }
          const {
            autoArchive: _autoArchive,
            autoArchiveTurnId: _autoArchiveTurnId,
            ...restoredTab
          } = entry.tab;
          void _autoArchive;
          void _autoArchiveTurnId;
          return [
            {
              type: 'archive.removed',
              archiveEntryId: entry.tab.id,
              chatId: entry.tab.id,
            },
            {
              type: 'tab.created',
              tab: { ...restoredTab, id: targetTabId },
              ...(targetTabId !== entry.tab.id
                ? { transcriptSourceChatId: entry.tab.id }
                : {}),
            },
            {
              type: 'runtime.patched',
              chatId: targetTabId,
              runtime: {
                status: 'idle',
                queuedMessageIds: [],
                turn: serializeChatTurnState(initialChatTurnState()),
              },
            },
            { type: 'tab.active_changed', activeTabId: targetTabId },
          ];
        },
        {
          ...{
            source: 'renderer-command',
            mutationId: envelope.commandId,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'applied',
              entityId: targetTabId,
            },
            ...expectedRevisionOption(envelope),
          },
          chatIds: [command.archiveEntryId],
          fullTranscript: targetTabId !== command.archiveEntryId,
        },
      );
      if (!commit.applied && outcome === 'applied') {
        outcome = 'already_applied';
      }
      return commandResult(envelope, commit.revision, outcome, {
        entityId: targetTabId,
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async markAllArchivesRead(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
  ): Promise<ChatCommandResult> {
    const state = await this.repository.getState(scope);
    const mutations: ChatCoreMutation[] = state.archivesFile.archived
      .filter((entry) => entry.unread)
      .map((entry) => ({
        type: 'archive.read_state_changed' as const,
        archiveEntryId: entry.tab.id,
        chatId: entry.tab.id,
        unread: false,
      }));
    if (mutations.length === 0) {
      return commandResult(
        envelope,
        state.tabsFile.revision ?? 0,
        'already_applied',
      );
    }
    return this.commit(scope, envelope, mutations);
  }

  private async forkTab(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.fork_tab' }>,
  ): Promise<ChatCommandResult> {
    if (
      command.destinationTab !== undefined &&
      (command.destinationTab.id !== command.targetTabId ||
        command.destinationTab.messages.length !== 0 ||
        !isPersistedChatTab(command.destinationTab))
    ) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(envelope, revision, 'rejected', {
        reason: 'The continuation destination metadata is invalid',
      });
    }
    let tombstonedTarget = false;
    let missingSourceOrAnchor = false;
    const commit = await this.repository.transactWith(
      scope,
      (current, _revision, transaction) => {
        if (transaction.hasRemovedTab(command.targetTabId)) {
          tombstonedTarget = true;
          return [];
        }
        if (
          current.tabsFile.tabs.some(
            (candidate) => candidate.id === command.targetTabId,
          )
        ) {
          return [];
        }
        const source = current.tabsFile.tabs.find(
          (tab) => tab.id === command.sourceTabId,
        );
        if (!source) {
          missingSourceOrAnchor = true;
          return [];
        }
        const atIndex = command.atMessageId
          ? source.messages.findIndex(
              (message) => message.id === command.atMessageId,
            )
          : source.messages.length - 1;
        if (atIndex < 0) {
          missingSourceOrAnchor = true;
          return [];
        }
        // Fork construction belongs to this serialized snapshot. Building it
        // before transactWith lets a concurrent source mutation produce a
        // stale fork even though creation itself is journal-atomic.
        const truncated = atIndex < source.messages.length - 1;
        const forkTitleLabel =
          source.customTitle?.trim() ||
          source.description?.trim() ||
          source.title.trim() ||
          'Chat';
        const forkAnchorMessageId =
          command.atMessageId ?? source.messages[atIndex]?.id;
        let fork: PersistedChatTab = {
          ...structuredClone(source),
          id: command.targetTabId,
          title: forkTitleLabel.startsWith('Fork: ')
            ? forkTitleLabel
            : `Fork: ${forkTitleLabel}`,
          createdAt: new Date(this.now()).toISOString(),
          messages:
            command.cloneMode === 'continuation'
              ? closeOpenPersistedTurnTimers(
                  structuredClone(source.messages.slice(0, atIndex + 1)),
                  this.now(),
                )
              : settlePersistedForkMessages(
                  structuredClone(source.messages.slice(0, atIndex + 1)),
                  this.now(),
                ),
          newChatStartedWatcherPending: true,
          forkedFrom: {
            projectId: scope.projectId,
            worktreeId: scope.worktreeId,
            chatId: source.id,
            ...(forkAnchorMessageId
              ? { atMessageId: forkAnchorMessageId }
              : {}),
          },
        };
        if (command.destinationTab) {
          const canonicalMessages = fork.messages;
          fork = {
            ...fork,
            ...structuredClone(command.destinationTab),
            id: command.targetTabId,
            messages: canonicalMessages,
          };
        }
        // A derived creation title does not transfer the user-owned override.
        delete fork.customTitle;
        delete fork.mcpActivation;
        // The source chat's parked provider sessions stay its own (CAN-6445).
        delete fork.providerSessions;
        delete fork.automaticTitleState;
        // Session AI Credits routing covered the source chat's usage limit;
        // a fork starts on its normal billing. Persistent routing and the
        // subscription choice are durable chat settings and carry over
        // (CAN-4200).
        if (fork.aiCreditsRouting?.scope === 'session') {
          delete fork.aiCreditsRouting;
        }
        // The latest response can be beyond a historical fork's cutoff.
        // Match the optimistic renderer clone in this durable snapshot,
        // including when destination metadata supplied its own usage state.
        if (truncated && fork.usage) {
          delete fork.usage.cursorReportedUsage;
          if (fork.usage.reportedTurnUsage !== undefined)
            fork.usage.reportedTurnUsage = null;
          if (fork.usage.opencodeReportedUsage) {
            delete fork.usage.opencodeReportedUsage;
            fork.usage.contextTokens = 0;
            fork.usage.contextWindow = 0;
          }
        }
        const forkSource = structuredClone(source);
        if (truncated && isInputLedger(forkSource.inputDelivery)) {
          const anchorTimestamp = source.messages[atIndex]?.timestamp;
          forkSource.inputDelivery = {
            ...forkSource.inputDelivery,
            rows: forkSource.inputDelivery.rows.filter(
              (row) =>
                anchorTimestamp !== undefined &&
                row.createdAt <= anchorTimestamp,
            ),
          };
        }
        fork.inputDelivery = detachInputDelivery(
          forkSource,
          { ...scope, chatId: fork.id },
          () => randomUUID(),
        );
        delete fork.newChatStartedWatcherFiredAt;
        delete fork.adhocMigrationSource;
        delete fork.sharedRun;
        delete fork.pendingRevertAttachmentPath;
        delete fork.scheduledSendDraft;
        delete fork.readOnly;
        delete fork.staleSessionDetected;
        delete fork.llmProviderUsageLimitBanner;
        delete fork.dismissedLlmProviderUsageLimitBannerKey;
        delete fork.attentionDismissedAt;
        delete fork.autoArchive;
        delete fork.autoArchiveTurnId;
        delete fork.unread;
        delete fork.unreadMarkedManually;
        delete fork.codexReconstructionSeedId;
        delete fork.claudeTerminal;
        const providerType =
          source.providerType ??
          (source.model ? getProviderForModel(source.model) : 'claude');
        const carriedSdkSessionId =
          command.sourceSdkSessionId ?? source.sdkSessionId;
        // Every ordinary Claude fork is a snapshot: even a whole-history fork
        // can sit unsent while the source advances. Carry the source session
        // only with the last kept chain entry as `resumeSessionAt`. Explicit
        // continuation/import flows use cloneMode='continuation' instead.
        // Legacy transcripts without a chain entry start fresh, and fresh
        // provenance propagates through later forks.
        const claudeFork =
          command.cloneMode !== 'continuation' && providerType === 'claude';
        const forkRequiresResumePoint =
          claudeFork && carriedSdkSessionId !== undefined;
        const sourceStartsFresh =
          carriedSdkSessionId === undefined &&
          (truncated || source.forkedFrom?.modelContext === 'fresh');
        const forkResumePoint = forkRequiresResumePoint
          ? resolveClaudeForkResumePoint(
              fork.messages,
              fork.messages[fork.messages.length - 1]?.id,
            )
          : undefined;
        if (
          claudeFork &&
          carriedSdkSessionId &&
          (!forkRequiresResumePoint || forkResumePoint !== undefined)
        ) {
          fork.sdkSessionId = carriedSdkSessionId;
          fork.claudeForkSessionOnNextSend = true;
          if (forkRequiresResumePoint && fork.forkedFrom) {
            fork.forkedFrom = {
              ...fork.forkedFrom,
              resumePointRequired: true,
            };
          }
        } else {
          delete fork.sdkSessionId;
          delete fork.claudeForkSessionOnNextSend;
          if (
            claudeFork &&
            (forkRequiresResumePoint || sourceStartsFresh) &&
            fork.forkedFrom
          ) {
            fork.forkedFrom = { ...fork.forkedFrom, modelContext: 'fresh' };
          }
        }
        if (providerType === 'opencode') {
          clearOpenCodeForkPlanReview(fork);
        }
        if (
          providerType === 'opencode' &&
          command.cloneMode !== 'continuation'
        ) {
          // The copied canonical snapshot determines context, not renderer metadata.
          fork.forkedFrom = {
            projectId: scope.projectId,
            worktreeId: scope.worktreeId,
            chatId: source.id,
            ...(forkAnchorMessageId
              ? { atMessageId: forkAnchorMessageId }
              : {}),
          };
          prepareOpenCodeVisibleFork(fork);
          delete fork.pendingSystemInstructions;
        }
        if (command.syncWarning) {
          const timestamp = this.now();
          fork.messages.push({
            id: `${command.targetTabId}-terminal-sync-warning`,
            role: 'system',
            timestamp,
            blocks: [
              {
                type: 'claude_terminal_sync_warning',
                timestamp,
                message: command.syncWarning,
              },
            ],
          });
        }
        return [
          {
            type: 'tab.created' as const,
            tab: fork,
            transcriptSourceChatId: source.id,
          },
          { type: 'tab.active_changed' as const, activeTabId: fork.id },
        ];
      },
      {
        ...{
          source: 'renderer-command',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
            entityId: command.targetTabId,
          },
          ...expectedRevisionOption(envelope),
        },
        chatIds: [command.sourceTabId],
        fullTranscript: true,
      },
    );
    if (tombstonedTarget) {
      return commandResult(envelope, commit.revision, 'not_found', {
        entityId: command.targetTabId,
        reason: 'The fork target id is tombstoned',
      });
    }
    if (missingSourceOrAnchor) {
      return commandResult(envelope, commit.revision, 'not_found');
    }
    const targetExists = commit.state.tabsFile.tabs.some(
      (candidate) => candidate.id === command.targetTabId,
    );
    return commandResult(
      envelope,
      commit.revision,
      !targetExists
        ? 'not_found'
        : commit.applied
          ? 'applied'
          : 'already_applied',
      { entityId: command.targetTabId },
    );
  }

  private async resetToPoint(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.reset_to_point' }>,
  ): Promise<ChatCommandResult> {
    const state = await this.repository.getState(scope, {
      chatIds: [command.chatId],
      fullTranscript: true,
    });
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === command.chatId,
    );
    if (!tab)
      return commandResult(envelope, state.tabsFile.revision ?? 0, 'not_found');
    const index = tab.messages.findIndex(
      (message) => message.id === command.userMessageId,
    );
    if (index < 0)
      return commandResult(envelope, state.tabsFile.revision ?? 0, 'not_found');
    const messages = tab.messages.slice(0, index + 1);
    const removedMessages = tab.messages.slice(index + 1);
    const removedMessageIds = removedMessages.map((message) => message.id);
    const removedAsyncQuestionIds = new Set(
      removedMessages.flatMap((message) =>
        message.blocks.flatMap((block) =>
          block.type === 'text' && block.asyncQuestion
            ? [block.asyncQuestion.requestId]
            : [],
        ),
      ),
    );
    const pendingQuestionRemovals = (state.tabsFile.pendingQuestions ?? [])
      .filter(
        (question) =>
          question.chatId === tab.id &&
          removedAsyncQuestionIds.has(question.requestId),
      )
      .map((question) => ({
        type: 'pending_question.removed' as const,
        requestId: question.requestId,
        chatId: tab.id,
      }));
    this.turnHandoff.invalidate({ ...scope, chatId: tab.id });
    // A parked provider session holds the history this reset removes, so it
    // can no longer be resumed (CAN-6445). Switching back starts fresh with
    // the rewritten transcript as its seed.
    const { providerSessions: removedParkedSessions, ...withoutParked } = tab;
    const parkedSessionRemoval: ChatCoreMutation[] = removedParkedSessions
      ? [
          {
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: buildTabMetadataPatch(tab, withoutParked),
          },
        ]
      : [];
    return this.commit(
      scope,
      envelope,
      [
        {
          type: 'messages.replaced',
          chatId: tab.id,
          messages,
          removedMessageIds,
        },
        ...parkedSessionRemoval,
        ...pendingQuestionRemovals,
        {
          type: 'runtime.patched',
          chatId: tab.id,
          runtime: {
            status: 'idle',
            queuedMessageIds: [],
            turn: serializeChatTurnState(initialChatTurnState()),
          },
        },
      ],
      { entityId: tab.id },
    );
  }

  private startCommitWait(commit: ChatStateCommit): ChatWaitOperation {
    return startChatWaitOperation({
      name: 'chat_state.publish_commit',
      scope: { projectId: commit.projectId, worktreeId: commit.worktreeId },
      queueDepth: 0,
      bounded: true,
      record: this.recordDiagnostic,
    });
  }

  /** `wait` is the repository's timing, started when publication was reserved. */
  private async publishCommit(
    commit: ChatStateCommit,
    wait: ChatWaitOperation = this.startCommitWait(commit),
  ): Promise<void> {
    wait.phase('commit_projection');
    try {
      const publicationCompleted = await this.publishCommitStages(commit, wait);
      wait.finish(publicationCompleted ? 'completed' : 'failed');
    } catch (error) {
      wait.finish('failed');
      throw error;
    }
  }

  private async publishCommitStages(
    commit: ChatStateCommit,
    wait: ChatWaitOperation,
  ): Promise<boolean> {
    const projectionScopeKey = `${commit.projectId}\u0000${commit.worktreeId}`;
    const readmissionRemovedTabIds =
      this.scopesAwaitingProjectionReadmission.get(projectionScopeKey);
    if (readmissionRemovedTabIds) {
      // Revisions restart on readmission; retain deletion deltas while fencing
      // observers and retries from the previous incarnation.
      this.scopesAwaitingProjectionReadmission.delete(projectionScopeKey);
      const abandoned = this.pendingChatTabsProjections.get(projectionScopeKey);
      if (abandoned) {
        abandoned.changedTabIds.forEach((id) =>
          readmissionRemovedTabIds.add(id),
        );
        abandoned.removedTabIds.forEach((id) =>
          readmissionRemovedTabIds.add(id),
        );
        this.pendingChatTabsProjections.delete(projectionScopeKey);
      }
      this.projectionGenerationByScope.set(
        projectionScopeKey,
        (this.projectionGenerationByScope.get(projectionScopeKey) ?? 0) + 1,
      );
      this.latestProjectionCommitRevisionByScope.delete(projectionScopeKey);
      this.runningChatTabsProjections.delete(projectionScopeKey);
      this.activeChatTabsProjections.delete(projectionScopeKey);
      this.chatTabsProjectionFailures.delete(projectionScopeKey);
    }
    this.latestProjectionCommitRevisionByScope.set(
      projectionScopeKey,
      Math.max(
        this.latestProjectionCommitRevisionByScope.get(projectionScopeKey) ?? 0,
        commit.revision,
      ),
    );
    const changedTabIds = new Set<string>();
    const removedTabIds = new Set<string>();
    for (const mutation of commit.record.mutations) {
      switch (mutation.type) {
        case 'tab.created':
          changedTabIds.add(mutation.tab.id);
          break;
        case 'archive.upserted': {
          const archivedScope = {
            projectId: commit.projectId,
            worktreeId: commit.worktreeId,
            chatId: mutation.entry.tab.id,
          };
          // An archive-only update keeps a fresh start staged for the restore;
          // the check runs against this entry's fence, so a new one drops it.
          if (
            !isFreshArchivedStart(
              mutation.entry,
              this.turnHandoff.getState(archivedScope),
            )
          )
            this.turnHandoff.invalidate(archivedScope);
          this.persistedBackgroundSnapshotRequests.delete(
            JSON.stringify([
              commit.projectId,
              commit.worktreeId,
              mutation.entry.tab.id,
            ]),
          );
          break;
        }
        case 'tab.metadata_patched':
          changedTabIds.add(mutation.tabId);
          break;
        case 'message.upserted':
        case 'message.removed':
        case 'messages.replaced':
        case 'runtime.patched':
          changedTabIds.add(mutation.chatId);
          break;
        case 'pending_question.upserted':
          this.pendingQuestionScopes.set(mutation.question.requestId, {
            projectId: commit.projectId,
            worktreeId: commit.worktreeId,
            chatId: mutation.question.chatId,
          });
          changedTabIds.add(mutation.question.chatId);
          break;
        case 'pending_question.removed':
          this.pendingQuestionScopes.delete(mutation.requestId);
          clearAskUserRequestCancellation(mutation.requestId);
          changedTabIds.add(mutation.chatId);
          break;
        case 'tab.removed':
          this.turnHandoff.invalidate({
            projectId: commit.projectId,
            worktreeId: commit.worktreeId,
            chatId: mutation.tabId,
          });
          this.persistedBackgroundSnapshotRequests.delete(
            JSON.stringify([
              commit.projectId,
              commit.worktreeId,
              mutation.tabId,
            ]),
          );
          changedTabIds.delete(mutation.tabId);
          removedTabIds.add(mutation.tabId);
          break;
        default:
          break;
      }
    }
    publishForeignChatActivity({
      projectId: commit.projectId,
      worktreeId: commit.worktreeId,
      tabs: commit.state.tabsFile.tabs.filter((tab): boolean =>
        changedTabIds.has(tab.id),
      ),
      runtimeByChatId: commit.state.runtimeByChatId,
      removedTabIds: Array.from(removedTabIds),
    });
    const delta = {
      changedTabIds: Array.from(changedTabIds),
      removedTabIds: Array.from(removedTabIds),
    };
    wait.phase('required_materialization');
    let publicationCompleted = true;
    try {
      await ensureChatTabsRequiredDurability(
        commit.projectId,
        commit.worktreeId,
        commit.state.tabsFile,
        delta,
        commit.revision,
      );
    } catch (error) {
      publicationCompleted = false;
      wait.failPhase();
      const retry = this.schedule(() => {
        void (async (): Promise<void> => {
          try {
            await ensureChatTabsRequiredDurability(
              commit.projectId,
              commit.worktreeId,
              commit.state.tabsFile,
              delta,
              commit.revision,
            );
          } catch (retryError) {
            logMainProcessWarn(
              `[chat-state] Required durability retry failed at revision ${commit.revision}:`,
              retryError,
            );
          }
        })();
      }, 100);
      retry.unref?.();
      logMainProcessWarn(
        `[chat-state] Required durability failed; scheduled retry at revision ${commit.revision}:`,
        error,
      );
    }
    const transcriptResetChatIds =
      commit.transcriptResets === undefined
        ? new Set(
            commit.record.mutations.flatMap((mutation) =>
              mutation.type === 'messages.replaced' ||
              mutation.type === 'message.removed'
                ? [mutation.chatId]
                : [],
            ),
          )
        : new Set(commit.transcriptResets);
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: this.createId(),
      occurredAt: commit.record.occurredAt,
      projectId: commit.projectId,
      worktreeId: commit.worktreeId,
      baseRevision: commit.baseRevision,
      revision: commit.revision,
      changes: [
        ...projectChatStateChanges(commit.record.mutations, {
          snapshot: commit.state,
        }),
        ...(commit.cardChanges ?? []),
        ...commit.state.tabsFile.tabs.flatMap((tab) =>
          tab.transcript && changedTabIds.has(tab.id)
            ? [
                {
                  type: 'transcript.updated' as const,
                  chatId: tab.id,
                  transcript: tab.transcript,
                  reset: transcriptResetChatIds.has(tab.id),
                },
              ]
            : [],
        ),
      ],
    };
    // An advance that changed nothing a window shows still carries a change:
    // its chat's unchanged transcript descriptor. Applying it is a no-op, and
    // the event keeps subscribers' revision chain whole, so they do not
    // resync (`ChatStateCommit.advancedChatIds`).
    if (event.changes.length === 0)
      for (const tab of commit.state.tabsFile.tabs)
        if (tab.transcript && commit.advancedChatIds?.includes(tab.id))
          event.changes.push({
            type: 'transcript.updated',
            chatId: tab.id,
            transcript: tab.transcript,
            reset: false,
          });
    wait.phase('subscriber_publication');
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        publicationCompleted = false;
        const retry = setTimeout(() => {
          try {
            if (this.listeners.has(listener)) listener(event);
          } catch {
            // Projection retries remain isolated from canonical state.
          }
        }, 100);
        retry.unref?.();
      }
    }
    this.queueChatTabsProjection(commit, delta, readmissionRemovedTabIds);
    return publicationCompleted;
  }

  private queueChatTabsProjection(
    commit: ChatStateCommit,
    delta: ChatTabsWriteDelta,
    readmissionRemovedTabIds?: ReadonlySet<string>,
  ): void {
    const key = `${commit.projectId}\u0000${commit.worktreeId}`;
    let pending = this.pendingChatTabsProjections.get(key);
    if (!pending) {
      pending = {
        projectId: commit.projectId,
        worktreeId: commit.worktreeId,
        revision: commit.revision,
        data: commit.state.tabsFile,
        changedTabIds: new Set(),
        removedTabIds: new Set(),
        changedTabs: new Map(),
      };
      this.pendingChatTabsProjections.set(key, pending);
    }
    pending.revision = commit.revision;
    pending.data = commit.state.tabsFile;
    readmissionRemovedTabIds?.forEach((id) => {
      pending.changedTabIds.delete(id);
      pending.changedTabs.delete(id);
      pending.removedTabIds.add(id);
    });
    const tabsById = new Map(
      commit.state.tabsFile.tabs.map((tab) => [tab.id, tab]),
    );
    for (const id of delta.changedTabIds) {
      pending.removedTabIds.delete(id);
      pending.changedTabIds.add(id);
      const tab = tabsById.get(id);
      if (tab) pending.changedTabs.set(id, tab);
      else pending.changedTabs.delete(id);
    }
    for (const id of delta.removedTabIds) {
      pending.changedTabIds.delete(id);
      pending.changedTabs.delete(id);
      pending.removedTabIds.add(id);
    }
    if (!this.runningChatTabsProjections.has(key)) {
      queueMicrotask(() => void this.drainChatTabsProjections(key));
    }
  }

  private async drainChatTabsProjections(key: string): Promise<void> {
    const generation = this.projectionGenerationByScope.get(key) ?? 0;
    if (this.runningChatTabsProjections.has(key)) return;
    this.runningChatTabsProjections.set(key, generation);
    try {
      let pending = this.pendingChatTabsProjections.get(key);
      while (pending) {
        if ((this.projectionGenerationByScope.get(key) ?? 0) !== generation)
          return;
        this.pendingChatTabsProjections.delete(key);
        if (
          (this.latestProjectionCommitRevisionByScope.get(key) ?? 0) >
          pending.revision
        ) {
          const newer = this.pendingChatTabsProjections.get(key);
          if (!newer) {
            this.pendingChatTabsProjections.set(key, pending);
            return;
          }
          this.mergeChatTabsProjectionDeltas(pending, newer);
          pending = newer;
          continue;
        }
        const projection = pending;
        const data = {
          ...projection.data,
          tabs: projection.data.tabs.map(
            (tab) => projection.changedTabs.get(tab.id) ?? tab,
          ),
        };
        const delta = {
          changedTabIds: Array.from(projection.changedTabIds),
          removedTabIds: Array.from(projection.removedTabIds),
        };
        const active = { generation, projection };
        this.activeChatTabsProjections.set(key, active);
        try {
          await notifyChatTabsMaterialized(
            projection.projectId,
            projection.worktreeId,
            data,
            delta,
            projection.revision,
            () =>
              (this.projectionGenerationByScope.get(key) ?? 0) === generation &&
              this.latestProjectionCommitRevisionByScope.get(key) ===
                projection.revision,
          );
          if ((this.projectionGenerationByScope.get(key) ?? 0) !== generation)
            return;
          this.chatTabsProjectionFailures.delete(key);
          if (
            (this.latestProjectionCommitRevisionByScope.get(key) ?? 0) >
            projection.revision
          ) {
            // A stale observer may skip its late nudges without throwing.
            const newer = this.pendingChatTabsProjections.get(key);
            if (newer) {
              this.mergeChatTabsProjectionDeltas(projection, newer);
            } else {
              this.pendingChatTabsProjections.set(key, projection);
              return;
            }
          }
        } catch (error) {
          if ((this.projectionGenerationByScope.get(key) ?? 0) !== generation)
            return;
          const newer = this.pendingChatTabsProjections.get(key);
          if (newer) {
            this.mergeChatTabsProjectionDeltas(projection, newer);
          } else {
            this.pendingChatTabsProjections.set(key, projection);
          }
          const failures = (this.chatTabsProjectionFailures.get(key) ?? 0) + 1;
          this.chatTabsProjectionFailures.set(key, failures);
          const delay = Math.min(100 * 2 ** Math.min(failures - 1, 9), 30_000);
          const retry = this.schedule(() => {
            if ((this.projectionGenerationByScope.get(key) ?? 0) === generation)
              void this.drainChatTabsProjections(key);
          }, delay);
          retry.unref?.();
          logMainProcessWarn(
            `[chat-state] Auxiliary projection failed at revision ${projection.revision}; retry scheduled:`,
            error,
          );
          return;
        } finally {
          if (this.activeChatTabsProjections.get(key) === active)
            this.activeChatTabsProjections.delete(key);
        }
        pending = this.pendingChatTabsProjections.get(key);
      }
    } finally {
      if (this.runningChatTabsProjections.get(key) === generation)
        this.runningChatTabsProjections.delete(key);
    }
  }

  private mergeChatTabsProjectionDeltas(
    older: PendingChatTabsProjection,
    newer: PendingChatTabsProjection,
  ): void {
    for (const id of Array.from(older.changedTabIds)) {
      if (newer.changedTabIds.has(id) || newer.removedTabIds.has(id)) continue;
      newer.changedTabIds.add(id);
      const tab = older.changedTabs.get(id);
      if (tab) newer.changedTabs.set(id, tab);
    }
    for (const id of Array.from(older.removedTabIds)) {
      if (newer.changedTabIds.has(id) || newer.removedTabIds.has(id)) continue;
      newer.removedTabIds.add(id);
    }
  }
}

let chatStateService: ChatStateService | undefined;

function forwardTurnLifecycle(event: ChatTurnLifecycleEvent): void {
  try {
    chatStateService?.observeTurnLifecycle(event);
  } catch {
    // This is an observational sink, including when replaced by a test spy.
  }
}

function lookupEndedTurn(scope: ChatTurnStateScope, turnId: string): boolean {
  return chatStateService?.hasEndedTurn(scope, turnId) === true;
}

let unbindTurnOwnership: (() => void) | undefined;

/** One sink, always forwarding to the current service, never to a stale one. */
function replaceChatStateService(next: ChatStateService | undefined): void {
  if (chatStateService !== next) {
    unbindTurnOwnership?.();
    unbindTurnOwnership = undefined;
    chatStateService?.disposeTurnHandoff();
  }
  chatStateService = next;
  if (next && !unbindTurnOwnership)
    unbindTurnOwnership = bindChatTurnOwnership(next, (scope) =>
      next.loadCommittedTurnState(scope),
    );
  // The background publisher loads with the Claude session module or the
  // first persisted background snapshot request, and activates then.
  setTurnLifecycleSink(next ? forwardTurnLifecycle : null);
  setTurnLifecycleEndedLookup(next ? lookupEndedTurn : null);
}

export function getChatStateService(): ChatStateService {
  if (!chatStateService) {
    const service = new ChatStateService({
      claudeToolNames: new Set([
        CANOPY_INJECTED_TOOL_REGISTRY.show_visual.claudeToolName,
      ]),
      codexToolNames: new Set([
        CANOPY_INJECTED_TOOL_REGISTRY.show_visual.codexToolName,
      ]),
      cursorToolUse: hasTrustedVisualToolUse,
    });
    replaceChatStateService(service);
    // Lazy for the same initialization cycle as `recordDiagnostic` above.
    installChatTranscriptRewriteDiagnosticSink((record): void => {
      void import('../observability/ingest')
        .then(({ getExecutionObservabilityIngest }) => {
          getExecutionObservabilityIngest().recordAppDiagnostic(record);
        })
        .catch(() => {
          // A rewrite diagnostic never changes a committed transaction.
        });
    });
    installChatTranscriptRewriteRateDiagnosticSink((record): void => {
      void import('../observability/ingest')
        .then(({ getExecutionObservabilityIngest }) => {
          getExecutionObservabilityIngest().recordAppDiagnostic(record);
        })
        .catch(() => {
          // A rewrite diagnostic never changes a committed transaction.
        });
    });
    return service;
  }
  return chatStateService;
}

/**
 * Drop the singleton so the next `getChatStateService()` builds a fresh one,
 * or install `next` (a service built with test-specific repository options).
 */
export function resetChatStateServiceForTests(next?: ChatStateService): void {
  replaceChatStateService(next);
}

/** Main-only watcher producer reads; never an interface command port. */
export function readChatWatcherSnapshot(
  target: ChatScopeKey,
): Promise<ChatStateSnapshot> {
  return getChatStateService().getState(target);
}

export function consumeChatWatcherTranscript<T>(
  target: ChatScopeKey & { chatId: string },
  consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
): Promise<T> {
  return getChatStateService().consumeTranscript(
    target,
    target.chatId,
    false,
    consume,
  );
}
