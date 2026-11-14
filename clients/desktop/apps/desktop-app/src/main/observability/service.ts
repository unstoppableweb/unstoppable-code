import { mergeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';
import type { OpenCodeUpdateDiagnostics } from '@canopy/desktop-shared/node/opencode/update-diagnostics';
import type { DelegationMetric } from '../agents/delegation/metrics';
import {
  isClaudeChildFrame,
  isRootAgentContinuationEvent,
  isTerminalChatEventData,
} from '../lib/chat-turn-audit';
import {
  isAgentDelegationTranscript,
  type AgentDelegationTranscript,
  type AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import { randomUUID } from 'node:crypto';
import { parseCursorReportedUsage } from '@canopy/agent-transcript/lib/cursor-usage';
import type { PersistedChatTurnState } from '@canopy/agent-transcript/turn';
import { isAssistantPatch } from '@canopy/agent-transcript/lib/assistant-snapshot';
import { Buffer } from 'node:buffer';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import type { CodeGraphBuildTimings } from '@canopy/desktop-shared/types/code-graph';
import type { BrowserDownloadSource } from '@canopy/execution-engine/types/browser';
import type { CodeGraphReadFailure } from '@canopy/desktop-shared/types/code-graph-tools';
import { sanitizeAppDiagnosticRecord } from './app-diagnostic-privacy';
import type {
  RendererDiagnosticsSummary,
  RemotePushSummary,
} from '@canopy/execution-engine/types/observability';
import {
  TURN_DISPATCH_PHASES,
  type TurnDispatchPhase,
} from '../lib/turn-dispatch-timing';
import type { RemoteRelayStoppedDiagnostic } from '../remote-control/diagnostics';
import type { RelayClientDiagnostic } from '../remote-control/transport/relay-client';
import type { SessionClosedEvent } from '../remote-control/transport/session-manager';
import { CANOPY_AUTH_FAILURE_EVENT_TYPE } from '@canopy/protocol/auth-recovery';
import {
  ChatTurnFailureEvidence,
  type ChatTurnFailure,
} from './chat-turn-failure';
import {
  CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE,
  CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE,
} from '@canopy/agent-transcript/types';
import {
  labelForPlanKey,
  MAX_TELEMETRY_TURN_DURATION_MS,
  normalizePlanKey,
  subscriptionLabelForPlanType,
} from '@canopy/protocol/telemetry';
import type { AgentAuditInterfaceToolCall } from '@canopy/protocol/observability';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  getExecutionHarnessForModel,
  getGatewayModelEntries,
  getModelSource,
  type AgentAuditChatMode,
  type ChatCommand,
  type AgentAuditEntry,
  type AgentAuditEventType,
  type AgentAuditHistoryRequest,
  type AgentAuditHistoryResponse,
  type AgentModelConfig,
  type AgentAuditTranscriptRequest,
  type AgentAuditTranscriptResponse,
  type AgentAuditTranscriptInjectedPromptRecord,
  type AgentAuditStatus,
  type AgentAuditAccountProxyUsage,
  type AgentAuditTranscriptSyntheticPromptRecord,
  type AgentObservabilitySnapshot,
  type AgentObservabilityUpdateEvent,
  type AgentProviderType,
  type AssistantMode,
  type AgentTranscriptInjectedPrompt,
  type ChatInternalRow,
  type ChatModel,
  type AgentUsageOverview,
  type ApprovalCheck,
  type ApprovalRuleScope,
  type FileReference,
  type ProviderRateLimitSnapshot,
  type ResourcePressureLevel,
  type ProviderUsageErrorInfo,
  type ProviderUsageSummary,
  type RetainedAccountUsageSnapshot,
  type ChatTurnUsageEvent,
  type PlanUsageEvent,
  type UsageInitiationSource,
  type UsageMetricEvent,
  type UsageMetricsRequest,
  type UsageMetricsResponse,
  type UsageMetricsViewRequest,
  type UsageMetricsViewResponse,
  type UsageTabSummaryRequest,
  type UsageTabSummaryResponse,
  type SharedContainerPublicationErrorReason,
  type SharedContainerPublicationStatus,
  type SharedContainerReplicaPurgeReason,
  type SharedContainerTrackingChange,
  type UsageTimeseriesRequest,
  type UsageTimeseriesResponse,
  type OrgProjectLinksUnknownReason,
  type OrgProjectConversionErrorCode,
} from '@canopy/desktop-shared/types';
import { isInternalChatRequest } from '@canopy/desktop-shared/lib/internal-chat-row';
import { getCodeReviewTargetSync } from '../lib/code-review-registry';
import { getPlanExploreTargetSync } from '../lib/plan-explore-registry';
import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import type {
  OrgProjectAutoConversionEvent,
  OrgProjectAutoConversionSkipReason,
  OrgProjectMigrationPassEvent,
} from '../services/org-project-auto-conversion';
import { createDesktopInstrumentationOperationKey } from '@canopy/desktop-instrumentation';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { bucketEntries } from '@canopy/desktop-shared/lib/auditTimeBucket';
import { getToolCategory } from '@canopy/desktop-shared/lib/turn-utils';
import {
  computeAccountKey,
  normalizeRetainedAccountSnapshot,
  pruneRetainedAccountSnapshots,
} from '@canopy/desktop-shared/lib/account-usage-snapshots';
import { codexServiceTierForModelConfig } from '@canopy/execution-engine/lib/codex-model-config';
import {
  classifyUsageFetchErrorMessage,
  classifyUsageFetchHttpStatus,
} from '@canopy/desktop-shared/lib/usage-fetch-error';
import { observeClaudeRateLimitWindows } from './claude-rate-limit-event';
import { ClaudeUsageFetchGate } from './claude-usage-fetch-gate';
import {
  parseClaudeUsageDetails,
  type ClaudeUsageDetails,
} from '@canopy/desktop-shared/lib/provider-usage-parsers';
import {
  classifySubscriptionUsage,
  subscriptionUsageLimits,
} from '@canopy/desktop-shared/lib/subscription-usage';
import { recordNativeSubscriptionRestored } from '../agents/native-account-change';
import type { AccountProxyUsageSnapshot } from '@canopy/desktop-shared/types/account-proxy';
import { AccountProxyQuotaUsage } from './account-proxy-quota-usage';
import type * as AccountProxyUsagePorts from '../account-proxy/service';
import type {
  AccountProxyUsageInventoryEntry,
  AccountProxyUsageReadResult,
} from '../account-proxy/usage';
import {
  parseGetAccountRateLimitsPayload,
  parseGetAccountResponsePayload,
} from '../codex/app-server-client';
import {
  codexLongContextThreshold,
  computeCodexObservedCost,
  type CodexObservedCostInput,
} from '../openai-pricing/cost-calculator';
import {
  CodexSubagentUsageTracker,
  isCodexSubagentThreadStarted,
  MAX_CODEX_SUBAGENTS_PER_ENTRY,
} from './codex-subagent-usage';
import { finalizeModelRoutingSavings } from '@canopy/desktop-shared/lib/model-routing-savings';
import {
  benchmarkModelRoutingUsage,
  priceModelRoutingUsage,
} from '@canopy/protocol/model-routing';
import type { GetAccountRateLimitsResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/GetAccountRateLimitsResponse';
import type { GetAccountResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/GetAccountResponse';
import type {
  ExecutionState,
  StepResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  ACCOUNT_PROXY_ROUTED_OUTPUT_KEY,
  ACCOUNT_PROXY_SESSION_OUTPUT_KEY,
  AI_CREDITS_ROUTED_OUTPUT_KEY,
  MODEL_GATEWAY_ROUTED_OUTPUT_KEY,
} from '@canopy/execution-engine/node/pipelines/executor/step-runner';
import {
  getAgentObservabilityAppEventsDayFilePath,
  getAgentObservabilityAppEventsDir,
  getAgentObservabilityAuditDayFilePath,
  getAgentObservabilityAuditDir,
  getAgentObservabilitySessionEventsDayFilePath,
  getAgentObservabilitySessionEventsDir,
  getAgentObservabilitySnapshotPath,
  getAgentObservabilityTranscriptDayDir,
  getAgentObservabilityTranscriptFilePath,
  getAgentObservabilityTranscriptIndexDayFilePath,
  getAgentObservabilityTranscriptIndexDir,
  getAgentObservabilityTranscriptsDir,
  getAgentObservabilityUsageEventsDayFilePath,
  getAgentObservabilityUsageEventsDir,
} from '../lib/paths';
import { buildStandaloneChatLinkTarget } from '../lib/standalone-link-target';
import type {
  ClaudeOauthCredentialsReadFailureReason,
  ClaudeOauthCredentialsReadFailureSource,
} from '../auth/claude-oauth-credentials';
import { PLAN_MODE_DEVELOPER_INSTRUCTIONS } from '../codex/plan-mode-instructions';
import type { TranscriptIndexRecord } from './types';
import {
  mayPruneAuditDayFile,
  notifyAuditEntryEnqueued,
  sameAuditDayFileIdentity,
  type AuditEntryEnqueueCause,
} from './audit-stream-hooks';
import { appendJsonlLines } from './jsonl-append';
import {
  buildAuditDayWindow,
  buildUsageMetricsResponse,
  compareEntries,
  computeCountsTimeseries,
  computeDistributionTimeseries,
  computeMetricsView,
  computeTabSummary,
  countPlanUsageEvent,
  defaultTokens,
  defaultToolCounts,
  entryMatchesWorktree,
  getRetentionCutoffTime,
  isAuditFileInsideWindow,
  isRecord,
  isStartedAtInsideRange,
  isUsageEventInsideRange,
  isUsageEventWithinRetention,
  isValidIsoTimestamp,
  labelForEventType,
  matchesHistoryRequest,
  matchesUsageMetricsRequest,
  normalizeAuditEntry,
  normalizeUsageMetricEvent,
  observedModelIdentity,
  readArray,
  readBoolean,
  readNumber,
  readRecord,
  readString,
  retainedDayStartTime,
  safeJsonParse,
  toDelegationStatisticsEvent,
  toIsoDay,
  upsertUsageEventById,
  USAGE_EVENT_RETENTION_DAYS,
  type CanonicalChatTurnDuration,
  type ObservabilityInstrumentationPort,
  type ObservabilityOperationName,
  type ObservabilityPricingState,
  type StatisticsEvent,
} from '@canopy/core-runtime/observability';
import { ManagedDelegationCapture } from './managed-delegation-capture';
import {
  getClaudeSessionCostLedger,
  readClaudeRunningTotals,
  readClaudeMainLoopUsage,
} from './claude-session-cost-ledger';
import { runCostHistoryRepair } from './cost-history-repair';
import type { AccountProxyResponse } from '../account-proxy/attribution';
import {
  addAccountProxyResponse,
  mergeAccountProxyUsages,
} from './account-proxy-usage';
import {
  billingBasisAtEntryStart,
  claudeContextEndTokens,
  mergeAuditContextUsage,
  normalizeAuditContextUsage,
  recordAuditCompaction,
  ClaudeTaskUsageTracker,
} from './capture-fields';
import {
  getNestedRootPipelineExecutionId,
  type PipelineExecutionLineage,
} from '../pipelines/root-pipeline-execution';
import {
  purgePersistedWorktreeObservabilityData,
  purgePersistedWorktreeSessionDiagnostics,
} from './worktree-cleanup';
import type { DesktopObservabilityHost } from './host';
import type {
  ProviderAccountIdentity,
  ProviderBillingAccountKind,
} from '../auth/provider-auth-state';
import { CLAUDE_SYNTHETIC_MODEL_SENTINEL } from '../lib/claude-synthetic';
import { skillSuggestionTurnRecorder } from '../skill-suggestions/turn-recorder';
import type {
  CloudOAuthDiagnosticOutcome,
  CloudOAuthDiagnosticStage,
  CloudOAuthFailureClass,
  CloudOAuthProviderError,
} from './types';

const RECENT_ENTRY_LIMIT = 200;
/** CAN-5828: interface tool call provenance kept per audit entry. */
const INTERFACE_TOOL_CALLS_PER_ENTRY = 64;
/** Delivered calls awaiting settlement whose entry is remembered. */
const INTERFACE_TOOL_CALL_BINDINGS = 1_024;
// Every chat kind whose waits pause the canonical turn reducer (CAN-5096,
// CAN-5827 for App Advisor and the Pipeline Editor).
const CANONICAL_DURATION_EVENT_TYPES: ReadonlySet<AgentAuditEventType> =
  new Set([
    'worktree_chat',
    'standalone_chat',
    'worktree_plan_chat',
    'app_advisor',
    'pipeline_editor',
  ]);

/** The chat turn a plan usage event is counted on. */
interface PlanUsageTarget {
  entry: AgentAuditEntry;
  open: boolean;
}
const MAX_RETAINED_PIPELINE_ENTRIES = 256;
const MAX_CODEX_SUBAGENT_CHAT_STATES = 128;
const MAX_CODEX_PIPELINE_SUBAGENT_TRACKERS = 128;

// Typed as a full record so a new provider must be listed before it compiles.
const TRACKED_PIPELINE_PROVIDERS: Readonly<Record<AgentProviderType, true>> = {
  claude: true,
  codex: true,
  ollama: true,
  cursor: true,
  opencode: true,
  copilot: true,
  antigravity: true,
};

// Persisted execution state can carry a provider from a newer app version.
function isTrackedPipelineProvider(value: string): value is AgentProviderType {
  return Object.prototype.hasOwnProperty.call(
    TRACKED_PIPELINE_PROVIDERS,
    value,
  );
}

function isOrganizationGatewayModel(model: string | undefined): boolean {
  if (!model) return false;
  return getGatewayModelEntries().some(
    (entry) =>
      entry.origin === 'org-gateway' &&
      (entry.modelId === model || entry.gatewayId === model),
  );
}

function usedOrganizationGateway(entry: {
  model?: string;
  aiCreditsRouted?: boolean;
}): boolean {
  return (
    entry.aiCreditsRouted === true && isOrganizationGatewayModel(entry.model)
  );
}

const FLUSH_DEBOUNCE_MS = 400;
const FLUSH_MAX_PENDING_AGE_MS = 2_000;
const FLUSH_BYTE_TRIGGER = 256 * 1024;
const APPEND_BATCH_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_MARKER_RESERVATION_BYTES = 512;
// Delegation records may use this much of a turn's file; root records keep the rest.
const TRANSCRIPT_DELEGATION_MAX_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_DELEGATION_STATUS_RESERVATION_BYTES = 256 * 1024;
const CHAT_TURN_OPERATION_NAME = 'canopy.chat_turn';
const AGENT_TASK_OPERATION_NAME = 'canopy.agent_task';
const CLAUDE_INTERACTIVE_USAGE_FRESHNESS_MS = 30_000;
const CLAUDE_BACKGROUND_USAGE_FRESHNESS_MS = 180_000;
const CLAUDE_USAGE_REFRESH_DEBOUNCE_MS = 30_000;
const CLAUDE_USAGE_REFRESH_MAX_WAIT_MS = 5 * 60_000;

function normalizeClaudeAccountKey(email: string | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function claudeE2EFreshnessOverrideMs(): number | null {
  if (!__CANOPY_E2E__) return null;
  const configured = process.env.CANOPY_E2E_CLAUDE_USAGE_FRESHNESS_MS;
  if (configured === undefined) return null;
  const parsed = Number(configured);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function claudeUsageFreshnessMs(background: boolean): number {
  return (
    claudeE2EFreshnessOverrideMs() ??
    (background
      ? CLAUDE_BACKGROUND_USAGE_FRESHNESS_MS
      : CLAUDE_INTERACTIVE_USAGE_FRESHNESS_MS)
  );
}

function claudeUsageRefreshDelayMs(maxWait: boolean): number {
  return (
    claudeE2EFreshnessOverrideMs() ??
    (maxWait
      ? CLAUDE_USAGE_REFRESH_MAX_WAIT_MS
      : CLAUDE_USAGE_REFRESH_DEBOUNCE_MS)
  );
}

function claudePatchedWindowKey(
  accountKey: string | null,
  snapshot: ProviderRateLimitSnapshot,
): string {
  return JSON.stringify([accountKey, claudeSubscriptionWindowKey(snapshot)]);
}

function claudeSubscriptionWindowKey(
  snapshot: ProviderRateLimitSnapshot,
): string | undefined {
  const { limitId, scope } = snapshot;
  if (limitId === 'session') return 'five_hour';
  if (limitId === 'weekly_all') return 'seven_day';
  if (
    limitId?.startsWith('weekly_scoped:') ||
    limitId?.startsWith('seven_day_')
  ) {
    const model = (scope?.model?.id ?? scope?.model?.displayName)
      ?.trim()
      .toLowerCase();
    const family = model?.match(/sonnet|opus|haiku|fable/)?.[0] ?? model;
    const surface = scope?.surface?.trim().toLowerCase().replace(/[ _-]/g, '');
    if (family || surface)
      return JSON.stringify(['seven_day', family ?? null, surface ?? null]);
  }
  return limitId;
}

/** Unknown resets remain required; known elapsed windows cannot block a fresh read. */
function claudeSubscriptionWindowPending(
  snapshot: ProviderRateLimitSnapshot,
  nowMs: number,
): boolean {
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window) => window !== undefined,
  );
  return (
    windows.length === 0 ||
    windows.some((window) => {
      const value = window.resetsAt;
      if (value === undefined) return true;
      const reset =
        typeof value === 'number'
          ? value < 1_000_000_000_000
            ? value * 1000
            : value
          : Date.parse(value);
      return !Number.isFinite(reset) || reset > nowMs;
    })
  );
}

interface AuditContextWorkspaceResolvers {
  codeReview: (scopeKey: string) => { projectId: string } | null;
  planExplore: (planId: string) => { projectId: string } | null;
}

const DEFAULT_AUDIT_CONTEXT_WORKSPACE_RESOLVERS: AuditContextWorkspaceResolvers =
  {
    codeReview: getCodeReviewTargetSync,
    planExplore: getPlanExploreTargetSync,
  };

export function resolveAuditContextWorkspaceId(
  entry: Pick<AgentAuditEntry, 'projectId' | 'worktreeId'>,
  resolvers: AuditContextWorkspaceResolvers = DEFAULT_AUDIT_CONTEXT_WORKSPACE_RESOLVERS,
): string | undefined {
  if (!entry.worktreeId) return undefined;
  if (entry.projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    return resolvers.codeReview(entry.worktreeId)?.projectId;
  }
  if (entry.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    return resolvers.planExplore(entry.worktreeId)?.projectId;
  }
  return undefined;
}

const REMOTE_APP_DIAGNOSTIC_KINDS = new Set<AppDiagnosticRecord['kind']>([
  'renderer_process_gone',
  'renderer_did_fail_load',
  'renderer_unresponsive',
  'resource_guard_blocked_chat',
  'resource_guard_blocked_pipeline',
  'child_process_gone',
  'desktop_instrumentation_init_failed',
  'provider_auth_probe_failed',
  'cloud_oauth_login_failed',
  'main_uncaught_exception',
  'main_unhandled_rejection',
]);

/** Kinds whose `error` holds a described main-process error (name and stack
 * frames, no message), so the remote exception keeps its type and frames. */
const MAIN_PROCESS_ERROR_KINDS = new Set<AppDiagnosticRecord['kind']>([
  'main_uncaught_exception',
  'main_unhandled_rejection',
]);

function buildAppDiagnosticError(
  event: AppDiagnosticRecord,
  message: string,
): Error {
  const error = new Error(message);
  if (!MAIN_PROCESS_ERROR_KINDS.has(event.kind) || !event.error) return error;
  const [head = '', ...frames] = event.error.split('\n');
  error.name = head.replace(/ \[[^\]]*\]$/, '') || 'Error';
  error.stack = [`${error.name}: ${message}`, ...frames].join('\n');
  return error;
}

const NON_ERROR_CLOUD_OAUTH_OUTCOMES = new Set<CloudOAuthDiagnosticOutcome>([
  'cancelled',
  'replaced',
  'timeout',
]);

interface PendingAutonomousTurn {
  id: string;
  startedAtMs: number;
  userMessageId?: string;
  /** No longer current at receipt; its frames may still be arriving. */
  ended: boolean;
}

interface OpenAuditEntry {
  entry: AgentAuditEntry;
  providerAccountIdentity: ProviderAccountIdentity | null;
  billingAccountKind: ProviderBillingAccountKind;
  /** The account proxy served this turn, so no native account is credited. */
  accountProxyRouted?: boolean;
  /**
   * A pipeline step's account counts by broker route: a step that paused
   * and resumed has a route for each run, under the same entry.
   */
  accountProxyRoutes?: Map<string, AgentAuditAccountProxyUsage>;
  seenCodexItems: Set<string>;
  seenBillableToolItemIds: Set<string>;
  cursorMessages?: Map<string, CursorAuditMessage>;
  usageObserved: boolean;
  pendingClaudePrCreateToolUses: Map<string, string>;
  seenManualPrCreateKeys: Set<string>;
  currentPauseStartedAtMs?: number;
  pausedDurationMs: number;
  /**
   * The canonical turn reducer's durations for this chat turn, by canonical
   * turn id (CAN-5096). A tools reload continues the entry as a second
   * canonical turn, so the entry's duration is their sum.
   */
  canonicalDurations?: Map<string, { durationMs: number; pausedMs: number }>;
  seenCompactionIds: Set<string>;
  contextEndTokens?: number;
  /**
   * Legacy/fallback terminal usage keyed by provider turn id. Used only when
   * Codex did not provide a cumulative thread snapshot for that turn.
   */
  codexTurnTokenUsage?: Map<string, CodexTurnTokenUsage>;
  /** Latest cumulative snapshot per provider thread. */
  codexCumulativeTokenUsage?: Map<string, CodexTurnTokenUsage>;
  /** Provider turns already accounted from cumulative snapshots. */
  codexCumulativeUsageTurnIds?: Set<string>;
  /**
   * The part of `entry.tokens` from requests whose own input passed the
   * model's long-context threshold. Set only when every request of the entry
   * was observed here, so pricing can apply the long rate per request.
   * shortcut: in memory only, so an entry revived after a restart is priced
   * on its summed input; persist it on the entry if that case matters.
   */
  codexLongContextTokens?: CodexTurnTokenUsage;
  /** Whether the split's first request, the one a model switch's cache miss falls on, was long-context. */
  codexFirstRequestLongContext?: boolean;
  /** Root provider turn currently eligible for streamed token accounting. */
  codexActiveProviderTurn?: { threadId: string; turnId: string };
  /** Provider-native child usage; chat state survives turns, pipeline state does not. */
  codexSubagentUsageTracker?: CodexSubagentUsageTracker;
  /** The last `builtin/agent-loop` iteration seen for a pipeline step. */
  agentLoopIteration?: number;
  /** Chat turns only: who started the turn, sent as `trigger_type`. */
  turnTrigger?: UsageInitiationSource;
  /** Chat turns only: events that may explain why the turn failed. */
  failureEvidence?: ChatTurnFailureEvidence;
}

/** Per-turn identities only; never retain another copy of streamed content. */
interface CursorAuditMessage {
  revision: number;
  counted: boolean;
  blocks: Map<number, { type: 'text' | 'thinking'; counted: boolean }>;
  toolUseIds: Set<string>;
}

interface CodexTurnTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
}

/** The entry's per-request long-context split, as costing takes it. */
function codexLongContextCostInput(
  openEntry: OpenAuditEntry,
): Pick<CodexObservedCostInput, 'longContextTokens'> {
  const split = openEntry.codexLongContextTokens;
  return split
    ? {
        longContextTokens: {
          input: split.inputTokens ?? 0,
          output: split.outputTokens ?? 0,
          cacheReadInputTokens: split.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: 0,
        },
      }
    : {};
}

/** The long-context split with the benchmark's cache adjustment applied. */
function benchmarkLongContextCostInput(
  openEntry: OpenAuditEntry,
  cacheMissContextTokens: number | undefined,
): Pick<CodexObservedCostInput, 'longContextTokens'> {
  const longContext = codexLongContextCostInput(openEntry);
  const split = longContext.longContextTokens;
  // A model switch misses the cache on the turn's first request, so the
  // adjustment belongs to the split only when that request was long-context.
  if (!split || !openEntry.codexFirstRequestLongContext) return longContext;
  const usage = benchmarkModelRoutingUsage(
    {
      input: split.input,
      output: split.output,
      cacheReadInput: split.cacheReadInputTokens,
      cacheCreationInput: split.cacheCreationInputTokens,
    },
    cacheMissContextTokens,
  );
  return {
    longContextTokens: {
      ...split,
      cacheReadInputTokens: usage.cacheReadInput,
      cacheCreationInputTokens: usage.cacheCreationInput,
    },
  };
}

function hasCodexTokenUsage(usage: CodexTurnTokenUsage): boolean {
  return Object.values(usage).some((value) => value !== undefined);
}

function addCodexTokenUsage(
  total: CodexTurnTokenUsage,
  increment: CodexTurnTokenUsage,
): CodexTurnTokenUsage {
  return {
    inputTokens: (total.inputTokens ?? 0) + (increment.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (increment.outputTokens ?? 0),
    cacheReadInputTokens:
      (total.cacheReadInputTokens ?? 0) + (increment.cacheReadInputTokens ?? 0),
    reasoningOutputTokens:
      (total.reasoningOutputTokens ?? 0) +
      (increment.reasoningOutputTokens ?? 0),
  };
}

function codexCumulativeTokenUsageDelta(
  current: CodexTurnTokenUsage,
  previous: CodexTurnTokenUsage,
): CodexTurnTokenUsage | null {
  const fields: Array<keyof CodexTurnTokenUsage> = [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'reasoningOutputTokens',
  ];
  if (
    fields.some(
      (field) =>
        current[field] !== undefined &&
        previous[field] !== undefined &&
        current[field] < previous[field],
    )
  ) {
    return null;
  }
  return {
    inputTokens: Math.max(
      0,
      (current.inputTokens ?? previous.inputTokens ?? 0) -
        (previous.inputTokens ?? 0),
    ),
    outputTokens: Math.max(
      0,
      (current.outputTokens ?? previous.outputTokens ?? 0) -
        (previous.outputTokens ?? 0),
    ),
    cacheReadInputTokens: Math.max(
      0,
      (current.cacheReadInputTokens ?? previous.cacheReadInputTokens ?? 0) -
        (previous.cacheReadInputTokens ?? 0),
    ),
    reasoningOutputTokens: Math.max(
      0,
      (current.reasoningOutputTokens ?? previous.reasoningOutputTokens ?? 0) -
        (previous.reasoningOutputTokens ?? 0),
    ),
  };
}

/** The cost history repair starts after start-up settles, like the cost index. */
const COST_HISTORY_REPAIR_DELAY_MS = 60_000;
const COST_HISTORY_REPAIR_MAX_ATTEMPTS = 10;

type RefreshableUsageProvider = Extract<
  AgentProviderType,
  'claude' | 'codex' | 'cursor' | 'copilot'
>;

type MergedUsageRefreshProvider = Extract<
  RefreshableUsageProvider,
  'claude' | 'codex'
>;

interface MergedUsageRefresh {
  version: number;
  done: Promise<void>;
}

class CodexRateLimitsReadError extends Error {
  constructor(
    message: string,
    readonly account: GetAccountResponse,
  ) {
    super(message);
    this.name = 'CodexRateLimitsReadError';
  }
}

interface CodexUsageMonitor {
  readAccount(refreshToken: boolean): Promise<GetAccountResponse>;
  readRateLimits(): Promise<GetAccountRateLimitsResponse>;
  dispose(): void;
}

export interface TranscriptSeedOptions {
  provider: AgentProviderType;
  originalText: string;
  submittedText: string;
  fileReferences?: FileReference[];
  planMode: boolean;
  injectedPrompts?: AgentTranscriptInjectedPrompt[];
  userMessageId?: string;
  steering?: { startsTurn: boolean; rootUserMessageId?: string };
  /** Local observability markers; intentionally not part of shared API DTOs. */
  internalRow?: ChatInternalRow;
  managedDelegationDeliveryId?: string;
}

export interface ChatTranscriptStartOptions {
  projectId: string;
  worktreeId: string;
  chatId: string;
  provider: AgentProviderType;
  sdkSessionId?: string;
  originalUserText: string;
  submittedText: string;
  fileReferences?: FileReference[];
  planMode: boolean;
  systemPromptAppend?: string;
  injectedPrompts?: AgentTranscriptInjectedPrompt[];
  orgMemoryBlock?: string;
  isStandalone: boolean;
  /**
   * Renderer-minted per-turn user message id for this turn. Recorded on the
   * audit entry so turn-level feedback (CAN-1521) can correlate a rating with
   * the turn it rates. Absent for surfaces with no renderer message id.
   */
  userMessageId?: string;
  /** Local observability markers; intentionally not part of shared API DTOs. */
  internalRow?: ChatInternalRow;
  managedDelegationDeliveryId?: string;
  /** Resolved cowork workspace id used to build standalone-chat navigation. */
  standaloneProjectId?: string;
  assistantMode?: AssistantMode;
  initiationSource?: UsageInitiationSource;
  selectedRepoId?: string;
  workspaceLabel?: string;
  repoId?: string;
  repoLabel?: string;
  /**
   * Which chat surface executes this turn. `'terminal'` covers the managed
   * Claude Code terminal (both `'claude-code'` and `'auto'` interface
   * modes). Defaults to `'canopy'`.
   */
  chatMode?: AgentAuditChatMode;
  /**
   * An explicit, user-authored turn that may count toward repeat-task skill
   * suggestions (CAN-385). Unset for helpers, App Advisor, the Pipeline
   * Editor, terminal chats, continuations and hidden-context turns.
   */
  skillSuggestionEligible?: boolean;
}

interface TranscriptSidecarState {
  key: string;
  request: AgentAuditTranscriptRequest;
  path: string;
  providerHint: AgentProviderType;
  queuedLines: string[];
  queuedBytes: number;
  budget: TranscriptSidecarBudget;
  firstAppendSucceeded: boolean;
  closed: boolean;
  injectedPrompts: AgentTranscriptInjectedPrompt[];
  finalizedEntry?: AgentAuditEntry;
  delegationRunGeneration?: number;
  delegationItems?: AgentDelegationTranscript['transcript'];
  delegationContentSuppressed?: boolean;
  delegationStatus?: AgentDelegationTranscript['snapshot']['status'];
}

interface TranscriptSidecarBudget {
  persistedBytes: number;
  queuedBytes: number;
  delegationBytes: number;
  truncated: boolean;
  projectId?: string;
  worktreeId?: string;
}

function sameDelegationTranscriptItem(
  left: AgentDelegationTranscriptItem | undefined,
  right: AgentDelegationTranscriptItem,
): boolean {
  if (
    !left ||
    left.type !== right.type ||
    left.id !== right.id ||
    left.sequence !== right.sequence ||
    left.occurredAt !== right.occurredAt
  )
    return false;
  if (right.type === 'tool')
    return (
      left.type === 'tool' &&
      left.toolName === right.toolName &&
      left.input === right.input &&
      left.output === right.output &&
      left.isError === right.isError
    );
  return left.type !== 'tool' && left.text === right.text;
}

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
  /**
   * Enriched plan/tier string from `checkClaudeAuthStatusObserved`
   * (`enrichClaudePlanTypeWithTier`), e.g. `default_claude_max_20x` or
   * `team-premium`. Preferred over the coarse `subscriptionType` when labeling.
   */
  planType?: string;
}

type ClaudeUsageDetailsReadResult =
  | {
      status: 'success';
      details: ClaudeUsageDetails;
    }
  | {
      status: 'failure';
      error: string;
      errorInfo: ProviderUsageErrorInfo;
      /** Present only for an HTTP 429 from the Claude usage endpoint. */
      retryAfter?: string | null;
    };

interface ClaudeUsageFieldPatch<T> {
  value: T;
  at: number;
  order: number;
}

interface ClaudeUsageWindowPatch {
  accountKey: string | null;
  usedPercent?: ClaudeUsageFieldPatch<number>;
  resetsAt?: ClaudeUsageFieldPatch<string>;
}

/** The counts one crash-dump retention sweep pass records. */
export interface AppDiagnosticCrashDumpSweepCounts {
  /** Dump files the sweep found. */
  listed: number;
  /** Dumps discarded because the crash-dump filter attributed them elsewhere. */
  discardedForeign: number;
  /** Dumps deleted for exceeding the retention age or count. */
  deletedByRetention: number;
  /** Dumps left in place. */
  kept: number;
  /** Files the sweep could not inspect or delete. */
  errors: number;
}

export interface AppDiagnosticRecord {
  version: 1;
  timestamp: string;
  kind:
    | 'renderer_process_gone'
    | 'renderer_reload_scheduled'
    | 'renderer_reload_started'
    | 'renderer_reload_finished'
    | 'renderer_did_fail_load'
    /**
     * Settings → Labs → "Open windows faster": main moved the
     * renderer's origin-keyed storage between `file://` and the renderer
     * scheme before loading, or that copy failed. Origins, outcome and key
     * counts only; never keys or values.
     */
    | 'renderer_origin_storage_migrated'
    | 'renderer_origin_storage_migration_failed'
    /**
     * A window could not load over the renderer scheme, so the launch went
     * back to `file://` and turned the experiment off. Reason and Chromium
     * error text only.
     */
    | 'renderer_code_cache_scheme_fallback'
    | 'renderer_console_error'
    | 'renderer_console_warning'
    | 'renderer_unresponsive'
    | 'renderer_responsive'
    | 'resource_pressure_warning'
    | 'resource_pressure_critical'
    /**
     * The Electron main thread missed its event-loop timer for at least one
     * second, or ran at a 99th-percentile delay of at least 200 ms, within one
     * sampling window. Numeric delays plus code-graph queue counts only.
     */
    | 'main_event_loop_stall'
    | 'renderer_frame_summary'
    | 'remote_push_summary'
    /**
     * Remote control's relay connection on this computer opened, closed or
     * could not get a token; durations, counts and close codes only. See
     * `remoteRelayConnection`.
     */
    | 'remote_relay_connection'
    /** An encrypted remote session ended; see `remoteSessionClosed`. */
    | 'remote_session_closed'
    /** Remote control stopped its relay connection; see `remoteRelayStopped`. */
    | 'remote_relay_stopped'
    | 'resource_guard_blocked_chat'
    | 'resource_guard_blocked_pipeline'
    | 'resource_codex_idle_suspended'
    | 'resource_codex_app_server_stopped'
    | 'resource_codex_app_server_suspend_skipped'
    /**
     * One owner's Codex notification admission (its durable chat commit)
     * stayed pending, or the shared app-server stdout was paused at the
     * retained-frame byte cap, for at least 5 seconds. Durations, counts and
     * bytes only; never message content, prompts, paths, or thread ids. Not
     * worktree-scoped: the pooled app-server is shared across chats.
     */
    | 'codex_app_server_stdout_hold'
    /**
     * A Codex `thread/resume` was rejected because the app-server was still
     * closing that thread, and the connection waited to retry it. An outcome,
     * a duration and counts only; never a thread id.
     */
    | 'codex_app_server_thread_close_wait'
    /**
     * The Codex app-server did not answer a JSON-RPC request within its
     * deadline. The protocol method name, durations and counts only.
     */
    | 'codex_app_server_request_timeout'
    /**
     * The shared Codex app-server was terminated to stop one chat's turn. The
     * trigger and counts of other chats recovered or failed only.
     */
    | 'codex_app_server_shared_restart'
    /**
     * A Codex `thread/resume` was refused because another app-server process
     * held the thread's writer, and the pool tried to free it. An outcome and
     * a duration only.
     */
    | 'codex_app_server_writer_handoff'
    /**
     * The chat transcript planner rewrote a chat's whole committed history
     * because an upsert patched or a removal deleted committed rows, or a
     * commit mixed committed and active rows, materialized a run, or replaced
     * existing committed row data. Rate-limited to one record per
     * chat per minute with a suppressed count. Counts, bytes and block type
     * names only; the chat key is an opaque digest. Never message ids, text,
     * paths, or workspace, worktree or chat ids.
     */
    | 'chat_transcript_full_rewrite'
    /** Device-local, content-free rewrite rate alert: an opaque chat key and counts. */
    | 'chat_transcript_rewrite_rate_exceeded'
    /**
     * The Codex marketplace staging janitor reclaimed leaked
     * `marketplace-{add,upgrade,backup}-*` checkouts. Counts only, never
     * paths or marketplace names, so "did staging stop accumulating?" is
     * answerable from app-events instead of by hand on a user's disk. Not
     * worktree-scoped: the Codex state directory is account-wide.
     */
    | 'codex_marketplace_staging_swept'
    | 'resource_monitor_config_warning'
    | 'wake_lock_acquired'
    | 'wake_lock_released'
    | 'wake_lock_started'
    | 'wake_lock_stopped'
    | 'wake_lock_error'
    | 'desktop_instrumentation_init_failed'
    | 'main_unhandled_rejection'
    | 'main_uncaught_exception'
    | 'startup_background_task_failed'
    | 'portal_oversized_event_dropped'
    | 'portal_outbox_overflow_trimmed'
    | 'portal_channel_stalled'
    | 'portal_structural_sync_failed'
    | 'child_process_gone'
    /**
     * Report-only: one foreign crash-dump filter classification per record.
     * The verdict and its reason, the location rule's shadow verdict, and the
     * executable's base name only when either verdict discards. Never a path.
     */
    | 'crash_dump_filter_verdict'
    /**
     * One pass of the local crash-dump retention sweep. Counts only, never a
     * path or file name.
     */
    | 'crash_dump_sweep'
    | 'telemetry_upload_failed'
    /**
     * The telemetry outbox gave up on a batch after a bounded run of
     * consecutive server rejections (CAN-3106). Previously an unpersistable or
     * persistently-refused batch re-armed its 60s timer forever, so the queue
     * never drained and the failure was invisible past the first upload
     * diagnostic. No worktree id, per the app-diagnostics boundary.
     */
    | 'telemetry_upload_abandoned'
    | 'implicit_plan_approval_failed'
    | 'provider_auth_probe_failed'
    /**
     * Cursor discovery could not read the per-model options listing
     * (`cursor/list_available_models`), so thinking support stays unknown and
     * the composer hides the effort control for every Cursor model. Carries
     * the method and error message only; no model names, paths, or ids.
     */
    | 'cursor_model_listing_unavailable'
    | 'cloud_oauth_login_stage'
    | 'cloud_oauth_login_failed'
    | 'cloud_oauth_callback_rejected'
    | 'shared_run_comments_registry_unreadable'
    /**
     * The server refused a "shared with me" listing for one organization
     * because that org's Teams entitlement has lapsed (CAN-2551). Benign and
     * expected: the desktop deliberately queries EVERY organization, including
     * ones it believes are lapsed, because that 403 is what drives the replica
     * purge — so this fires on every listing for any lapsed org, not only on a
     * stale local snapshot. `listing-diagnostics.ts` therefore records it at
     * most once per org per 5-minute window, which keeps a persistently lapsed
     * account from flooding app-events. Never worktree-scoped — a
     * shared-container listing is account/org-wide.
     */
    | 'shared_container_listing_blocked'
    /**
     * A transient cloud or network failure prevented one organization's
     * shared-container listing from completing. Recorded with bounded
     * deduplication and without server response prose.
     */
    | 'shared_container_listing_unavailable'
    /**
     * Purging replicas of organizations a refreshed account snapshot no longer
     * lists failed before the account was saved. The snapshot (capabilities,
     * memberships, billing states, enforced settings) is saved anyway and the
     * purge is retried by the next refresh. Carries the local error message
     * only; never a worktree id.
     */
    | 'shared_container_org_reconcile_deferred'
    /**
     * A new organization copy of a shared container failed unexpectedly
     * (CAN-4781). Carries the stable refusal code when there is one and the
     * error names, codes and frames of the failure, its cause and every
     * member of an incomplete rollback; never a message, path or id.
     */
    | 'shared_container_org_fork_failed'
    /**
     * The org-enforced telemetry policy could not be read (locked keychain,
     * unavailable `safeStorage`, corrupt account file). The read fails through
     * to "nothing enforced", so the entire CLIENT-side half of enforcement is
     * off for the session — the server backstop still rejects prohibited
     * ingest, but without this the local gate goes down with no trace. Never
     * worktree-scoped: the policy is account-wide.
     */
    | 'telemetry_enforcement_read_failed'
    | 'model_policy_read_failed'
    | 'model_gateway_read_failed'
    | 'model_enforcement_owner_unknown'
    /**
     * Preparing a Blueprint's capabilities (adding marketplaces, installing
     * plugins, writing custom skills) threw, so the curated seed degraded to a
     * project with no selections. The create deliberately still succeeds —
     * "unmet requirements warn, never block" — which is exactly why the failure
     * needs a trace: without one, a real regression in template resolution is
     * indistinguishable from an ordinary offline run. Carries the error message
     * only, never a workspace or worktree id.
     */
    | 'blueprint_template_prep_failed'
    /**
     * A sidebar save was refused because the workspace index could not be
     * read; rewriting it would have dropped every project (CAN-3329).
     */
    | 'workspace_index_write_refused'
    /**
     * An Agent Ledger lifecycle step (archive, delete, purge, restore, move,
     * external removal, workspace deletion, the intent journal, or startup
     * reconciliation) did not complete. Archive, restore and deletion never
     * wait on it beyond a bounded intent write; the next startup pass settles
     * the scope. `reason` is `<operation>: <reason code>` only: never
     * workspace, worktree, entry or ledger ids, paths, or entry text.
     */
    | 'ledger_lifecycle_failed'
    /**
     * Agent Ledger sync stopped short (LD01, LD02, LD10): a scope needs
     * repair, the mirror refused the account, a deleted scope was purged
     * before its outbox drained, a merged guest's scopes could not move, or
     * a pass failed unexpectedly. `reason` is `<code>: <reason code or
     * count>` only, and repeats at most every ten minutes: never workspace,
     * worktree, entry or ledger ids, paths, or entry text. A network failure
     * is retried and never recorded.
     */
    | 'ledger_sync_failed'
    /**
     * Ledger-publishable Summary snapshots that can no longer publish (LD06).
     * `reason` is one of:
     * - `aged_out: <count>`: the 50-entry summary history dropped them
     *   before they published;
     * - `aged_out_unverified: <count>`: their receipts could not be read;
     * - `rejected: <count>`: the Ledger rejected their projection;
     * - `journal_replaced: 1`: a summary file that did not parse was
     *   replaced, with whatever it held;
     * - `journal_unreadable: 1` / `journal_future_version: 1`: a write was
     *   skipped to keep a file it could not read or a newer app wrote;
     * - `journal_entries_dropped: <count>`: a write dropped history entries
     *   that did not validate;
     * - `provenance_stripped: <count>` (or `_unverified`): a write kept
     *   snapshots unpublishable because their provenance did not validate.
     * Counts only, never workspace, worktree or snapshot ids, or summary
     * text.
     */
    | 'ledger_summary_publication_gap'
    /**
     * A read-modify-write of a workspace's `workspace.json` was refused
     * because the file could not be read; writing the default config back
     * would have erased its repositories and settings (CAN-3563).
     */
    | 'workspace_config_write_refused'
    | 'org_default_chats_provision_failed'
    /**
     * The server refused, or could not be reached for, a move of a
     * checkout's uploaded activity to its organization (CAN-3418, CAN-3517
     * repair). Previously swallowed, so a move refused on every launch was
     * invisible (CAN-3601). `reason` is the server's code (`not_personal`,
     * `repository_mismatch`, ...), `http_<status>`, or `network`; carries
     * the error message only, never workspace or project ids.
     */
    | 'org_project_activity_move_failed'
    /**
     * A LaunchDarkly start failed or timed out, so flags stay on their
     * enabled-but-unavailable fallback (or this process's last live values)
     * until the next retry (CAN-3511). One record per failed attempt; the
     * backoff caps at ten minutes. Carries the SDK error message only.
     */
    | 'feature_flags_unavailable'
    /** A LaunchDarkly start succeeded after one or more failed attempts. */
    | 'feature_flags_recovered'
    /**
     * Telemetry sync should be running but is not (CAN-3512): the oldest
     * queued item has waited past the stall threshold with no upload since.
     * `reason` is `queue_stalled`. One record per pause in this process;
     * counts and timestamps only, never worktree ids.
     */
    | 'telemetry_sync_paused'
    /** A `telemetry_sync_paused` condition cleared; `reason` is the old one. */
    | 'telemetry_sync_resumed'
    /**
     * An organization's one-time automatic conversion pass (hybrid model)
     * started on first sight of the membership, or completed. Organization
     * id and counts only; never workspace ids, names or paths.
     */
    | 'org_project_migration_pass'
    /**
     * Canonical chat storage's work across every scope over roughly one
     * minute, recorded only when some scope was active. Counts, bytes and
     * durations only: the per-scope breakdown carries worktree ids, so it is a
     * `chat_storage_diagnostic` session event instead.
     */
    | 'chat_storage_activity_summary'
    /**
     * The startup sweep reaped a hosted CLI that a crashed run left running
     * and that no chat owned (`reason` `previous_run`). PID and uptime only;
     * chat-owned survivors are session diagnostics instead.
     */
    | 'claude_process_untracked'
    | 'before_quit'
    | 'runtime_cleanup_stage';
  /** `claude_process_untracked` only: the reaped process. */
  claudeProcessId?: number;
  /** Shutdown stage identifiers and timing only; never work identities or raw errors. */
  cleanupStage?: string;
  cleanupStatus?: 'started' | 'completed' | 'failed' | 'stalled' | 'timed_out';
  cleanupElapsedMs?: number;
  reason?: string;
  exitCode?: number | null;
  processType?: string;
  /** `child_process_gone` only: Electron's utility `serviceName`. */
  serviceName?: string;
  /** `child_process_gone` only: Electron's process `name`. */
  processName?: string;
  /** `crash_dump_filter_verdict` only. */
  crashDumpVerdict?: 'process' | 'discard';
  crashDumpVerdictReason?: string;
  crashDumpLocationVerdict?: 'process' | 'discard';
  crashDumpExecutableName?: string;
  /** `crash_dump_sweep` only: non-negative counts for one sweep pass. */
  crashDumpSweep?: AppDiagnosticCrashDumpSweepCounts;
  rendererSurface?: 'main_window' | 'app_advisor_window';
  error?: string;
  sourceId?: string;
  lineNumber?: number;
  memoryRssBytes?: number;
  mainHeapUsedBytes?: number;
  mainHeapTotalBytes?: number;
  mainHeapLimitBytes?: number;
  mainRssBytes?: number;
  mainExternalBytes?: number;
  mainArrayBufferBytes?: number;
  cpuPercent?: number;
  /** `renderer_frame_summary` only; local, content-free window aggregates. */
  rendererSummary?: RendererDiagnosticsSummary;
  /** `remote_push_summary` only; local per-session aggregate without identity. */
  remotePushSummary?: RemotePushSummary;
  /** `remote_relay_connection` only; no device, account or token. */
  remoteRelayConnection?: RelayClientDiagnostic;
  /** `remote_session_closed` only; no device or session identifier. */
  remoteSessionClosed?: SessionClosedEvent;
  /** `remote_relay_stopped` only; no account key or device identifier. */
  remoteRelayStopped?: RemoteRelayStoppedDiagnostic;
  /** `main_event_loop_stall` only: the sampling window length. */
  eventLoopWindowMs?: number;
  /** `main_event_loop_stall` only: delays beyond the sampling interval. */
  eventLoopDelayMaxMs?: number;
  eventLoopDelayP99Ms?: number;
  eventLoopDelayP50Ms?: number;
  /** `main_event_loop_stall` only: code-graph generation queue at record time. */
  runningCodeGraphBuildCount?: number;
  queuedCodeGraphBuildCount?: number;
  /**
   * `main_event_loop_stall` only, and local only. Share of the window the main
   * thread was busy (0–1), and how it was measured: `main-thread-cpu` in
   * Electron's main process, where libuv's loop accounting is unavailable.
   */
  eventLoopUtilization?: number;
  eventLoopUtilizationSource?: 'libuv' | 'main-thread-cpu';
  /**
   * `main_event_loop_stall` only, local only: latency of a trivial `fs.stat`
   * issued every two seconds through libuv's thread pool. Rising values mean
   * full syncs are starving the pool. `Count` probes completed in the window;
   * `PendingMs` is the age of one still unfinished when it closed.
   */
  threadPoolProbeCount?: number;
  threadPoolProbeP50Ms?: number;
  threadPoolProbeP99Ms?: number;
  threadPoolProbeMaxMs?: number;
  threadPoolProbePendingMs?: number;
  /**
   * Agent turns running at record time (`main_event_loop_stall`, local only).
   * Kept apart from `activeChatTurnCount`, which the resource diagnostics
   * record from the chat-turn guard.
   */
  activeTurnCount?: number;
  /**
   * Chat-storage commits in the record's window: the stall window for
   * `main_event_loop_stall`, the summary window for
   * `chat_storage_activity_summary`.
   */
  chatStorageCommitCount?: number;
  /** `chat_storage_activity_summary` only: aggregate over every scope. */
  chatStorageWindowMs?: number;
  chatStorageScopeCount?: number;
  chatStorageMutationCount?: number;
  chatStorageBytesWritten?: number;
  chatStorageFileSyncCount?: number;
  chatStorageDirectorySyncCount?: number;
  chatStorageCommitMsTotal?: number;
  chatStorageCommitMsMax?: number;
  chatStorageQueueWaitMsMax?: number;
  pressureLevel?: ResourcePressureLevel;
  processCount?: number;
  suspendedCodexPoolCount?: number;
  /**
   * `resource_pressure_critical` only: idle Claude-harness sessions whose
   * release was requested. Each releases after a short quiet period unless
   * activity resumes.
   */
  idleClaudeSessionReleaseCount?: number;
  sweptRemoved?: number;
  sweptStagingRemoved?: number;
  sweptBackupRemoved?: number;
  sweptUnmatched?: number;
  stoppedCodexAppServerCount?: number;
  skippedReason?: 'minimum-process-lifetime' | 'pressure-backoff';
  processUptimeMs?: number;
  retryAfterMs?: number;
  /** `codex_app_server_stdout_hold` only: which hold was long. */
  holdKind?: 'owner-admission' | 'stdout-byte-cap';
  /** `codex_app_server_stdout_hold` only: how the hold ended. */
  holdOutcome?: 'released' | 'detached' | 'failed' | 'discarded';
  /** `codex_app_server_stdout_hold` only. */
  holdDurationMs?: number;
  /** `codex_app_server_stdout_hold` only: peak retained frames. */
  queuedFrameCount?: number;
  /** `codex_app_server_stdout_hold` only: peak retained wire bytes. */
  queuedFrameBytes?: number;
  /** `codex_app_server_stdout_hold` only: a JSON-RPC response was retained. */
  responseQueued?: boolean;
  /** `codex_app_server_thread_close_wait` only: how the wait ended. */
  closeWaitOutcome?: 'resumed' | 'exhausted' | 'aborted' | 'failed';
  /** `codex_app_server_thread_close_wait` only. */
  closeWaitDurationMs?: number;
  /** `codex_app_server_thread_close_wait` only: `thread/resume` retries. */
  closeWaitRetryCount?: number;
  /** `codex_app_server_thread_close_wait` only: `thread/closed` was seen. */
  closedNotificationObserved?: boolean;
  /** `codex_app_server_request_timeout` only: the JSON-RPC method name. */
  requestMethod?: string;
  /** `codex_app_server_request_timeout` only: the deadline that elapsed. */
  requestTimeoutMs?: number;
  /** `codex_app_server_request_timeout` only: other owners with live work. */
  busyPeerCount?: number;
  /** `codex_app_server_request_timeout` only: requests still pending. */
  pendingRequestCount?: number;
  /** `codex_app_server_request_timeout` only: stdout was at the byte cap. */
  stdoutPaused?: boolean;
  /** `codex_app_server_shared_restart` only: why the process was stopped. */
  restartTrigger?:
    | 'turn-cancelled'
    | 'session-destroyed'
    | 'turn-start-timeout'
    | 'other';
  /** `codex_app_server_shared_restart` only: peers sent to recovery. */
  recoveredPeerCount?: number;
  /** `codex_app_server_shared_restart` only: peers failed instead. */
  failedPeerCount?: number;
  /** `codex_app_server_writer_handoff` only: how the handoff ended. */
  writerHandoffOutcome?: 'released' | 'holder-busy' | 'no-local-holder';
  /** `codex_app_server_writer_handoff` only. */
  writerHandoffDurationMs?: number;
  /** Rewrite diagnostics only: opaque digest correlating one chat. */
  chatTranscriptRewriteChatKey?: string;
  /** `chat_transcript_rewrite_rate_exceeded` only: its rolling window in milliseconds. */
  chatTranscriptRewriteRateWindowMs?: number;
  /** `chat_transcript_rewrite_rate_exceeded` only: bytes needed to trigger it. */
  chatTranscriptRewriteRateThresholdBytes?: number;
  /** `chat_transcript_rewrite_rate_exceeded` only: committed bytes in the window. */
  chatTranscriptRewriteRateCommittedBytes?: number;
  /** `chat_transcript_rewrite_rate_exceeded` only: rewrite count in the window. */
  chatTranscriptRewriteRateRewrites?: number;
  /** `chat_transcript_rewrite_rate_exceeded` only: sorted distinct reasons. */
  chatTranscriptRewriteRateReasons?: string[];
  /** `chat_transcript_full_rewrite` only: committed rows before the rewrite. */
  chatTranscriptRewriteCommittedRows?: number;
  /** `chat_transcript_full_rewrite` only: committed JSONL bytes before it. */
  chatTranscriptRewriteCommittedBytes?: number;
  /** JSONL bytes written by the replacement, excluding a cloned prefix. */
  chatTranscriptRewriteBytesWritten?: number;
  /** Serialized operation duration through publication/indexes, excluding queue wait. */
  chatTranscriptRewriteDurationMs?: number;
  /** Transcript write-rate warnings only: opaque scope digest, never raw ids. */
  chatTranscriptWriteScopeDigest?: string;
  chatTranscriptWriteRateBytesPerSecond?: number;
  chatTranscriptWriteRateThresholdBytesPerSecond?: number;
  chatTranscriptWriteRateObservedMs?: number;
  chatTranscriptWriteRateSampleCount?: number;
  /** `chat_transcript_full_rewrite` only: committed rows patched in place. */
  chatTranscriptRewritePatchedRows?: number;
  /** `chat_transcript_full_rewrite` only: committed rows removed. */
  chatTranscriptRewriteRemovedRows?: number;
  /** `chat_transcript_full_rewrite` only: sorted block types, at most 8. */
  chatTranscriptRewritePatchedBlockTypes?: string[];
  /** `chat_transcript_full_rewrite` only: the rewrite kept a live tail. */
  chatTranscriptRewriteActiveTail?: boolean;
  /** `chat_transcript_full_rewrite` only: rewrites suppressed since the last record. */
  chatTranscriptRewriteSuppressedCount?: number;
  trigger?:
    | 'idle-timeout'
    | 'critical-pressure'
    | 'external-auth-change'
    | 'thread-budget'
    | 'final-owner-release'
    | 'runtime-shutdown'
    | 'unresponsive-thread-request'
    | 'writer-handoff';
  appProcessId?: number;
  codexAppServerProcessId?: number;
  activeChatTurnCount?: number;
  activePipelineExecutionCount?: number;
  holderCount?: number;
  holderKey?: string;
  blockerId?: number;
  enabled?: boolean;
  portalEventType?: string;
  bytes?: number;
  thresholdBytes?: number;
  droppedCount?: number;
  droppedChatEventCount?: number;
  droppedRangeCount?: number;
  /**
   * Superseded portal snapshots reclaimed from the outbox (a newer snapshot
   * for the same scope+target was queued behind them). Not loss: reported so
   * a reclaimed pileup is distinguishable from dropped state.
   */
  coalescedSnapshotCount?: number;
  /** `portal_outbox_overflow_trimmed` only: budget that forced the drops. */
  trimReason?: 'count' | 'bytes';
  /** `portal_outbox_overflow_trimmed` only: dropped events by type. */
  droppedEventTypes?: Record<string, number>;
  /** `portal_outbox_overflow_trimmed` only: dropped split-snapshot chunks. */
  droppedChunkCount?: number;
  /** `portal_outbox_overflow_trimmed` only: state requests dropped whole. */
  droppedCommandGroupCount?: number;
  /**
   * `portal_outbox_overflow_trimmed` only: queued completions of dropped
   * state requests replaced with retryable failures.
   */
  failedCommandCount?: number;
  maxEvents?: number;
  maxBytes?: number;
  /**
   * HTTP status for a `telemetry_upload_failed` diagnostic (null when the
   * failure had no status, e.g. a network/timeout error).
   */
  telemetryUploadStatus?: number | null;
  /**
   * Resolved share scope for a `telemetry_upload_failed` diagnostic. Scope is a
   * non-worktree-scoped string ('private' | 'team' | 'organization'); no
   * worktree id is stored here, honoring the app-diagnostics boundary.
   */
  telemetryShareScope?: string;
  /**
   * `telemetry_upload_abandoned` only: how many consecutive server rejections
   * the batch accumulated before the outbox dropped it.
   */
  telemetryConsecutiveServerRejections?: number;
  /**
   * `telemetry_upload_abandoned` only: when the first rejection in that
   * unbroken run was observed, so the abandoned window is reconstructable.
   */
  telemetryFirstRejectionAt?: string;
  /**
   * Privacy-bounded Cloud OAuth diagnostics. These fields must never contain
   * raw OAuth state, authorization codes, PKCE verifiers, tokens, or callback
   * URLs. The loopback port and client device id remain local-only.
   */
  cloudOAuthStage?: CloudOAuthDiagnosticStage;
  cloudOAuthOutcome?: CloudOAuthDiagnosticOutcome;
  cloudOAuthFailureClass?: CloudOAuthFailureClass;
  cloudOAuthHttpStatus?: number | null;
  cloudOAuthProviderError?: CloudOAuthProviderError;
  cloudOAuthDurationMs?: number;
  cloudOAuthCorrelationId?: string;
  cloudOAuthPlatform?: NodeJS.Platform;
  cloudOAuthAppVersion?: string | null;
  cloudOAuthLoopbackPort?: number;
  cloudOAuthClientDeviceId?: string;
  /**
   * Organization whose shared-container listing was refused, for a
   * `shared_container_listing_blocked` or
   * `shared_container_listing_unavailable` diagnostic. An organization id is
   * account-scoped, not worktree-scoped, so it is allowed in app-events.
   */
  sharedContainerOrganizationId?: string;
  /** `feature_flags_*` only: consecutive failed LaunchDarkly starts. */
  featureFlagFailedAttempts?: number;
  /**
   * `feature_flags_unavailable` only: `unavailable_fallback` when every flag is
   * on its in-code fallback, `last_live` when this process keeps live values.
   */
  featureFlagValuesSource?: 'unavailable_fallback' | 'last_live';
  /** `feature_flags_recovered` only: time since the first failed start. */
  featureFlagOutageMs?: number;
  /** `feature_flags_recovered` only: what started the successful attempt. */
  featureFlagRecoveryTrigger?:
    | 'backoff'
    | 'window_focus'
    | 'power_resume'
    | 'context_refresh';
  /** `telemetry_sync_paused` only: queued items waiting to upload. */
  telemetrySyncPendingCount?: number;
  /** `telemetry_sync_paused` only: age of the oldest dated queued item. */
  telemetrySyncOldestPendingAgeMs?: number | null;
  /** `telemetry_sync_paused` only: last successful upload, null if never. */
  telemetrySyncLastSyncedAt?: string | null;
  /** `telemetry_sync_resumed` only: how long the pause lasted. */
  telemetrySyncPausedMs?: number;
  /** `org_project_migration_pass` only. */
  orgProjectMigrationPassOutcome?: OrgProjectMigrationPassEvent['outcome'];
  /** `org_project_migration_pass` only: account-scoped, not worktree-scoped. */
  orgProjectMigrationPassOrganizationId?: string;
  /** `org_project_migration_pass` `started` only: workspaces it may move. */
  orgProjectMigrationPassWorkspaceCount?: number;
  /** `org_project_migration_pass` `completed` only. */
  orgProjectMigrationPassCompletion?: Extract<
    OrgProjectMigrationPassEvent,
    { outcome: 'completed' }
  >['completion'];
}

/** One code-graph generation, as recorded by a `code_graph_build` event. */
export type CodeGraphBuildDiagnosticFailureReason =
  | 'timeout'
  | 'canceled'
  | 'unavailable'
  | 'worker-exit'
  | 'spawn-failed'
  | 'post-failed'
  | 'malformed-response'
  | 'worker-response'
  | 'unknown'
  | CodeGraphReadFailure;

export interface CodeGraphBuildDiagnosticDetail {
  scope: 'worktree' | 'base';
  /** Why the generation ran, e.g. `worktree-created` or `shadow-maintenance`. */
  trigger: string;
  outcome: 'success' | 'failure' | 'deferred';
  /** Failures only: the generation stage that failed. */
  failureStage?: string;
  /** Existing coalesced `BuildRecord.id`; absent when admission never happened. */
  attemptId?: string;
  /** Bounded classification only; never a raw worker error or SQL message. */
  failureReason?: CodeGraphBuildDiagnosticFailureReason;
  /** Build worker queue wait measured at actual dispatch, when available. */
  queueWaitMs?: number;
  /**
   * Worktree builds: the queue class the worker build used. `first-build`
   * marks a worktree that had no completed graph yet.
   */
  queuePriority?: 'agent' | 'first-build' | 'worktree';
  /** Base builds: the repository the shadow graph covers. */
  repoId?: string;
  /** Main's wall time for the whole generation, from request to settlement. */
  totalMs: number;
  filesScanned?: number;
  filesParsed?: number;
  factsChanged?: boolean;
  /**
   * The worker's timings, including the prelude main measured before the
   * worker started. The same values persist in the graph's metadata.
   */
  timings?: CodeGraphBuildTimings;
  /** Worktree builds: the fingerprint read after the build, and its write. */
  endFingerprintMs?: number;
  fingerprintPersistMs?: number;
  /** Metadata persistence is ancillary after a successful graph publication. */
  fingerprintPersistOutcome?: 'persisted' | 'unstable' | 'busy' | 'error';
  fingerprintPersistFailure?: CodeGraphReadFailure;
  /** Base builds: main's rename-and-manifest publication of the generation. */
  installMs?: number;
}

export interface CodeGraphReadDiagnosticRepository {
  repoId: string;
  state: 'ready' | 'pending' | 'missing' | 'error';
  readFailure?: CodeGraphReadFailure;
  fileCount?: number;
  symbolCount?: number;
  edgeCount?: number;
}

/** Bounded local aggregate for one code-graph read kind; never sent remotely. */
export type CodeGraphReadDiagnosticDetail = {
  kind: string;
  outcome: 'success' | 'error' | 'timeout' | 'canceled';
  requestCount: number;
  queueDurationMsTotal: number;
  queueDurationMsMax: number;
  executionDurationMsTotal: number;
  executionDurationMsMax: number;
  failureCounts: Partial<Record<CodeGraphReadFailure, number>>;
  repositories?: CodeGraphReadDiagnosticRepository[];
  /** Repository outcomes omitted by the local 64-repository cap. */
  omittedRepositoryCount?: number;
  /** New diagnostic keys dropped by the local per-window key cap. */
  omittedKeyCount?: number;
};

export interface SessionDiagnosticRecord {
  /** Fixed ACP kinds and saturated counts, no provider payloads. Local only. */
  opencodeUpdates?: OpenCodeUpdateDiagnostics;
  opencodeRuntimeVersion?: string;
  /** Bounded Claude fallback outcome; no provider text or response body. */
  claudeAiCredits402Outcome?: 'inferred_no_billing_source' | 'unmatched';
  turnUserMessageId?: string;
  version: 1;
  timestamp: string;
  kind:
    | 'opencode_ignored_updates'
    | 'managed_delegation'
    | 'session_registered'
    | 'session_unregistered'
    | 'session_replaced'
    | 'session_recreate_deferred'
    | 'message_queued'
    | 'turn_active'
    | 'turn_idle'
    | 'phase_slow'
    | 'chat_event_undelivered'
    | 'chat_event_dropped'
    | 'chat_input_delivery_outcome'
    | 'claude_event_receipt_backlog'
    /**
     * Provider contract runtime guard (turn-state phase 43a): an SDK frame the
     * lifecycle tables don't classify (once per session and label), a missing
     * `session_state_changed` gate (once per CLI process), and the harness
     * version a process reports. Bounded identifiers only, never payload text.
     */
    | 'provider_contract_unknown_event'
    | 'provider_contract_gate_missing'
    | 'provider_harness_version'
    /**
     * Turn-state phase 43c: a committed turn state disagrees with its timer
     * rows (an open timer with no running turn, or two open timers). Once per
     * chat and invariant; ids and counts only.
     */
    | 'turn_state_invariant_violation'
    /**
     * Host reconciliation is waiting on a chat whose received turn state
     * keeps failing to commit. Once per stall; ids only.
     */
    | 'turn_state_commit_stalled'
    | 'chat_queue_gate_stale'
    | 'chat_queue_drain_declined'
    | 'chat_wait_phase'
    | 'ask_user_request_undelivered'
    | 'codex_process_started'
    | 'codex_process_exit'
    | 'codex_process_error'
    | 'codex_process_recovery'
    | 'ingestion_lag'
    | 'terminal_transcript_sync_start'
    | 'terminal_transcript_sync_end'
    | 'terminal_transcript_sync_failure'
    | 'terminal_turn_active'
    | 'terminal_turn_idle'
    | 'terminal_turn_diff_capture_open_failure'
    | 'terminal_compaction_appended'
    /**
     * A chat's Claude CLI under the Claude process host: started (the host
     * reported its PID), exited, or untracked, which means killed by the
     * owner consistency check or reaped at startup from a previous run.
     * `pid` and `sessionInstanceId` identify the process and its session.
     */
    | 'claude_process_started'
    | 'claude_process_exited'
    | 'claude_process_untracked'
    | 'claude_terminal_first_output'
    | 'claude_terminal_process_exit'
    | 'claude_terminal_process_error'
    | 'claude_terminal_workspace_trust_error'
    | 'shared_run_reshare_failed'
    | 'approval_decision'
    | 'approval_stale_deny_observed'
    | 'browser_download_started'
    | 'browser_download_finished'
    | 'browser_upload_requested'
    | 'browser_upload_decided'
    | 'browser_upload_attached'
    | 'shared_run_comment_poll_failed'
    | 'portal_snapshot_timing'
    | 'portal_outbox_upload_latency'
    | 'worktree_stats_timing'
    | 'model_policy_refused'
    | 'resource_context_denied'
    /**
     * Main could not tell whether Personal workspaces link to the current
     * organization's catalog. The record uses empty session identifiers and
     * carries only a bounded reason, never paths, names, or workspace ids.
     */
    | 'org_project_links_unknown'
    /**
     * Automatic Personal-to-organization project conversion (CAN-3416): one
     * record per conversion, per refusal, and per skip decision (skips once
     * per workspace and reason per session). `projectId` is the converted
     * workspace; `worktreeId` and `chatId` are empty. Carries organization
     * and organization-project ids and bounded codes, never paths, names or
     * repository URLs.
     */
    | 'org_project_auto_conversion'
    | 'background_execution_context_rebound'
    /**
     * A Claude point-in-time fork resume (`resumeSessionAt`) was refused by
     * the CLI and the turn was retried once as a fresh session. The retry init
     * is tagged so persisted fork provenance discloses the lost model context.
     */
    | 'claude_fork_resume_point_rejected'
    | 'claude_ai_credits_402'
    | 'codex_gateway_proxy_retry'
    | 'codex_gateway_proxy_failed'
    | 'codex_gateway_no_billing_source'
    | 'chat_storage_diagnostic'
    | 'chat_command_failed'
    | 'empty_turn_completion'
    | 'auth_resume_outcome'
    | 'shared_container_publish_transition'
    | 'shared_container_preview_failure'
    | 'shared_container_replica_purged'
    | 'shared_container_tracking_changed'
    | 'telemetry_target_dropped_cross_org'
    | 'telemetry_target_dropped_ownership_unknown'
    | 'archive_io_operation'
    /**
     * A finalized audit entry's duration exceeded
     * {@link MAX_TELEMETRY_TURN_DURATION_MS} (7 days) — a stale `startedAt`, an
     * entry that was never finalized, or a bogus provider-supplied
     * `duration_ms`. The locally recorded value is kept for audit-trail
     * fidelity and the telemetry mapper omits it from the wire; this is the
     * root-cause instrumentation that says WHICH of those produced it
     * (CAN-3106). Worktree/chat-scoped, so it belongs in session-events.
     */
    | 'implausible_turn_duration'
    | 'turn_dispatch_slow'
    /**
     * One code-graph generation (a worktree build, or a workspace-shadow base
     * build with an empty `worktreeId`): its outcome and phase timings from
     * the queue through publication. Local only; nothing is reported
     * remotely.
     */
    | 'code_graph_build'
    /** Bounded local read-worker aggregate; not an app event or remote metric. */
    | 'code_graph_read'
    /**
     * The full text of a main-process `unhandledRejection` or
     * `uncaughtException`, whose global app-events record keeps only the
     * error's name, code and stack frames. The text can quote worktree or chat
     * identifiers, so it belongs here. Unscoped: its ids are empty.
     */
    | 'main_error_detail';
  /** `main_error_detail` only: the app-events record it details. */
  mainErrorKind?: 'main_unhandled_rejection' | 'main_uncaught_exception';
  /** Bounded diagnostic reason; never resource content or provenance. */
  reason?:
    | 'context-mismatch'
    | 'access-removed'
    | 'unknown-provenance'
    | 'missing-dependency'
    | 'unsupported-target'
    | OrgProjectLinksUnknownReason
    | 'request-failed';
  /** `resource_context_denied` only: safe display identity for the refused capability. */
  resourceKind?: 'plugin' | 'skill' | 'mcp';
  /** `resource_context_denied` only: bounded to 200 characters at the producer. */
  resourceName?: string;
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  providerType: AgentProviderType | 'cursor' | 'unknown';
  /** `turn_dispatch_slow` only: elapsed prompt-to-provider time, without text. */
  totalMs?: number;
  /** `session_recreate_deferred` only: why recreation waits; names, never values. */
  recreateReasons?: string[];
  /** `turn_dispatch_slow` only: provider handoff or first output milestone. */
  endpoint?: 'enqueued' | 'first_event';
  /** `turn_dispatch_slow` only: bounded phase durations, without content. */
  phases?: Array<{ phase: TurnDispatchPhase; elapsedMs: number }>;
  /**
   * Names the registered provider session instance: session lifecycle kinds
   * and the `claude_process_*` kinds carry it.
   */
  sessionInstanceId?: string;
  /** `claude_process_*` only: the delegated run whose CLI this is. */
  delegationId?: string;
  /**
   * `claude_process_untracked` only: its owning session instance was no
   * longer registered, or the CLI survived a previous run.
   */
  claudeProcessUntrackedReason?: 'owner_unregistered' | 'previous_run';
  model?: ChatModel;
  delegationMetric?: DelegationMetric;
  turnActive?: boolean;
  /** Transient host-gate evidence; never request or provider content. */
  queueGateSource?:
    | 'adopted-provider-activity'
    | 'queued-dispatch'
    | 'immediate-dispatch'
    | 'stop-preparation'
    | 'revived-root';
  queueGateOwnerId?: string;
  queueGateAgeMs?: number;
  /** Content-free local wait timing; phases and operation names are fixed by callers. */
  waitOperationId?: string;
  waitOperation?: string;
  waitScope?: {
    projectId?: string;
    worktreeId?: string;
    taskId?: string;
    chatId?: string;
    botId?: string;
  };
  waitPhase?: string;
  /** Phase owned when a recovery flag was acquired or released. */
  waitAwaitingPhase?: string;
  /** Time since recovery ownership was claimed, excluding pre-claim checks. */
  waitRecoveryElapsedMs?: number;
  waitStartedAtMs?: number;
  waitElapsedMs?: number;
  waitQueueDepth?: number;
  waitQueueOwnerOperationId?: string;
  waitQueueOwnerOperation?: string;
  waitOutcome?: 'stalled' | 'completed' | 'failed' | 'released';
  waitOwnerTokenId?: string;
  waitOperationEpoch?: number;
  waitGateOwnerInputId?: string;
  waitProjectInventoryCalls?: number;
  waitPhaseDurationsMs?: Record<string, number>;
  /** Why a non-empty queue stood down and what will wake it. */
  queueDrainGuard?:
    | 'provider-foreground'
    | 'host-gate'
    | 'reservation'
    | 'dispatch-in-flight'
    | 'recovery-in-flight'
    | 'edit-locked-head'
    | 'auth-pause'
    | 'backlog-wait-failed'
    | 'background-work';
  queueDrainRetryAtMs?: number;
  queueDrainWakeEvent?:
    | 'provider-terminal-or-session-activity'
    | 'gate-reconcile'
    | 'reservation-released'
    | 'dispatch-finalizer'
    | 'recovery-finalizer'
    | 'head-edit-unlocked'
    | 'authentication-resumed'
    | 'native-background-work-ended';
  turnCount?: number;
  pendingMessageCount?: number;
  /** Names of incompatible options only; never their values. */
  changedOptions?: string[];
  /** `org_project_auto_conversion` only (CAN-3416). */
  orgProjectAutoConversionOutcome?: OrgProjectAutoConversionEvent['outcome'];
  orgProjectAutoConversionReason?:
    | OrgProjectAutoConversionSkipReason
    | OrgProjectConversionErrorCode;
  /** Whether a later trigger retries a failed conversion. */
  orgProjectAutoConversionRetry?: 'later' | 'never-this-session';
  orgProjectAutoConversionOrganizationId?: string;
  /** Organization project (tracked workspace) external id. */
  orgProjectAutoConversionProjectId?: string;
  /** `ambiguous-organizations` only: how many organizations matched. */
  orgProjectAutoConversionOrganizationCount?: number;
  /** Ownership-change repair of an unattended executable item (CAN-3543). */
  backgroundExecutionRebindItemType?: 'automation' | 'watcher' | 'hook';
  backgroundExecutionRebindItemId?: string;
  backgroundExecutionRebindPreviousContext?: string;
  backgroundExecutionRebindNextContext?: string;
  backgroundExecutionRebindReason?:
    | 'ownership-change'
    | 'startup-repair'
    | 'runtime-mismatch';
  activeBackgroundTaskCount?: number;
  lastEventType?: string;
  lastActivityAt?: number;
  terminal?: boolean;
  sendFailureReason?:
    | 'no_window'
    | 'window_destroyed'
    | 'webcontents_destroyed'
    | 'webcontents_crashed'
    | 'frame_destroyed'
    | 'frame_detached'
    | 'render_frame_disposed';
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderrTail?: string;
  stderrTruncated?: boolean;
  uptimeMs?: number | null;
  codexClientCount?: number;
  codexActiveTurnCount?: number;
  recoveryScheduled?: boolean;
  recoveryStatus?: 'succeeded' | 'failed';
  recoveryStrategy?:
    | 'restarted'
    | 'reconciled'
    | 'reattached'
    | 'replayed'
    | 'continued';
  /** `ingestion_lag` only: one content-free per-session lag transition. */
  outcome?: 'entered' | 'drained' | 'aborted';
  lagMs?: number;
  peakLagMs?: number;
  episodeMs?: number;
  thresholdMs?: number;
  /** `ingestion_lag`: which stream lagged; `browser_download_*`: who started it. */
  source?: 'provider' | 'receipt' | BrowserDownloadSource;
  /**
   * `ingestion_lag` without `outcome`: periodic, content-free admission window.
   * Latency runs from provider receipt (router admission when unavailable) to
   * settlement: persisted, ignored or failed, not necessarily durable success.
   * Backlog covers routed active + waiting events; upstream provider queue
   * depth remains in provider-specific diagnostics.
   */
  admissionLatencyP50Ms?: number;
  admissionLatencyP95Ms?: number;
  admissionSampleCount?: number;
  admissionReceiptSampleCount?: number;
  admissionWindowMs?: number;
  backlogDepth?: number;
  backlogPeakDepth?: number;
  backlogOldestAgeMs?: number;
  error?: string;
  eventType?: string;
  /** `chat_event_dropped`: the gate that dropped a provider event. */
  chatEventDropGate?:
    | 'router_stamp_mismatch'
    | 'router_no_route'
    | 'router_stale_codex_root_error'
    | 'router_deferred_tools_suppressed'
    | 'turn_root_refused'
    | 'turn_revival_refused'
    | 'worktree_turn_ineligible'
    | 'claude_prelude_without_turn'
    | 'codex_root_completion_stale'
    | 'codex_root_output_stale'
    | 'canonical_admission_rejected';
  /** `chat_event_dropped`: a short fixed reason code, never provider text. */
  chatEventDropReason?: string;
  /** `chat_input_delivery_outcome`: one record per attempt, at its first settlement. */
  inputAttemptId?: string;
  inputGeneration?: string;
  inputOrigin?: 'typed' | 'watcher' | 'answer' | 'internal';
  inputDeliveryOutcome?:
    | 'picked-up'
    | 'rejected-requeued'
    | 'rejected-final'
    | 'withdrawn'
    | 'unknown-timeout'
    | 'unknown-transport'
    | 'unknown-restart'
    | 'history-delivered'
    | 'history-not-delivered';
  /** Elapsed from the attempt's creation to each phase that was observed. */
  inputPhaseTimingsMs?: {
    admitted?: number;
    pickedUp?: number;
    withdrawn?: number;
    completed?: number;
    uncertain?: number;
  };
  /** A refusal or failure kind and its bounded code; never provider or error text. */
  inputErrorClass?: 'refusal' | 'timeout' | 'transport' | 'restart';
  inputErrorCode?: string;
  /** The fixed summary for that code. */
  inputErrorSummary?: string;
  /** `claude_event_receipt_backlog`: the receipt queue filled; counts only. */
  claudeReceiptQueueDepth?: number;
  /** The unclassified frame or missing gate, as a bounded identifier. */
  providerContractEvent?: string;
  /** The provider harness version a process reported, bounded. */
  providerHarnessVersion?: string;
  /** `turn_state_invariant_violation`: which invariant the commit broke. */
  turnStateInvariant?: 'settled_runtime_open_timer' | 'two_open_timers';
  /** `turn_state_invariant_violation`: the chat's open timer rows. */
  openTimerCount?: number;
  claudeReceiptOldestWaitMs?: number;
  /** The Canopy turn the dropped event was tagged with. */
  eventTurnUserMessageId?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  phase?: string;
  elapsedMs?: number;
  archiveIoRequestId?: string;
  archiveIoOperationId?: string;
  archiveIoOperationType?: string;
  archiveIoStage?: 'queued' | 'started' | 'progress' | 'failed' | 'finished';
  archiveIoWorkerGeneration?: number;
  archiveIoWorkerPid?: number;
  archiveIoQueueWaitMs?: number;
  archiveIoDurationMs?: number;
  archiveIoProgressStage?: string;
  archiveIoFileCount?: number;
  archiveIoByteCount?: number;
  archiveIoChildCleanup?: 'not-required' | 'cooperative' | 'forced';
  archiveIoOutcome?: 'succeeded' | 'failed' | 'interrupted';
  archiveIoErrorCode?: string;
  codexGatewayAttemptCount?: number;
  codexGatewayUpstreamStatus?: number;
  codexGatewayFailureCode?: string;
  codexGatewayRetryReason?: string;
  codexGatewayErrorCode?: string;
  codexGatewayRouteRef?: string;
  codexGatewayCorrelationId?: string;
  codexGatewayNoBillingSourceClassified?: boolean;
  /**
   * `chat_command_failed` only: the revisioned chat command that did not
   * commit. `rejected` means main durably refused it; `threw` means the
   * command escaped the service with an error. Both surface the same
   * “couldn’t save this chat change” banner, which otherwise leaves no
   * trace of which command failed or why.
   */
  chatCommandType?: ChatCommand['type'];
  chatCommandId?: string;
  chatCommandOutcome?: 'rejected' | 'threw';
  /** `empty_turn_completion` only: the user message anchoring the empty turn. */
  emptyCompletionTurnUserMessageId?: string;
  /** Provider-reported elapsed time, when available. */
  emptyCompletionDurationMs?: number;
  chatStorageKind?:
    | 'journal_loaded'
    | 'journal_growth'
    | 'transcript_bearing_mutation'
    | 'checkpoint_aborted'
    | 'checkpoint_starvation'
    | 'checkpoint_forced'
    | 'checkpoint_completed'
    | 'artifact_maintenance_failed'
    | 'transcript_preview_close_failed'
    | 'legacy_chat_revision_gap_recovered'
    /** A delta-journal record from a newer build stopped the scope's load. */
    | 'delta_journal_newer_format'
    /** An unacknowledged delta-journal tail excluded from replay. */
    | 'delta_journal_torn_tail_dropped'
    /** The scope moved to the delta journal (manifest version 3). */
    | 'delta_journal_promoted'
    /** Promotion failed; the scope stays version 2. */
    | 'delta_journal_promotion_failed'
    /** The scope returned to version 2 storage. */
    | 'delta_journal_demoted'
    /** Demotion failed; the scope stays version 3 and is retried. */
    | 'delta_journal_demotion_failed'
    /** The scope moved from format 3 to format 4 (manifest version 4). */
    | 'format4_promoted'
    /** A format 4 promotion attempt failed; the scope stays format 3. */
    | 'format4_promotion_failed'
    /** Every format 4 promotion retry is spent until the next process. */
    | 'format4_promotion_exhausted'
    /** About one minute of one scope's canonical storage work. */
    | 'activity_summary';
  chatStorageAuthority?: 'v1' | 'v2';
  /**
   * `activity_summary` only: the scope's canonical chat-storage work over
   * `chatStorageWindowMs`. Commit durations run from the scope's commit queue
   * admission to its applied indexes; `QueueWait` is the wait for the scope's
   * previous transaction.
   */
  chatStorageWindowMs?: number;
  chatStorageCommitCount?: number;
  chatStorageMutationCount?: number;
  chatStorageBytesWritten?: number;
  chatStorageFileSyncCount?: number;
  chatStorageDirectorySyncCount?: number;
  chatStorageCommitMsTotal?: number;
  chatStorageCommitMsMax?: number;
  chatStorageQueueWaitMsMax?: number;
  /** `code_graph_build` only. */
  codeGraphBuild?: CodeGraphBuildDiagnosticDetail;
  /** `code_graph_read` only. Local aggregate, bounded by the read recorder. */
  codeGraphRead?: CodeGraphReadDiagnosticDetail;
  chatStorageJournalBytes?: number;
  chatStorageRecordBytes?: number;
  chatStorageRecordCount?: number;
  chatStorageMaxRecordBytes?: number;
  chatStorageMeanRecordBytes?: number;
  chatStorageCheckpointDurationMs?: number;
  chatStorageCheckpointAbortCount?: number;
  /**
   * `delta_journal_torn_tail_dropped` only: why the journal tail was not a
   * frame (`incomplete` or `checksum_mismatch`).
   */
  chatStorageJournalTailReason?: 'incomplete' | 'checksum_mismatch';
  /**
   * `artifact_maintenance_failed` only: the failure's category, never its
   * message.
   */
  chatStorageMaintenanceReason?:
    | 'io'
    | 'capacity'
    | 'pending_replay'
    | 'invalid_sidecar'
    | 'unknown';
  /**
   * `delta_journal_torn_tail_dropped` only: base name of the quarantine copy
   * in the scope directory. Never a path or content.
   */
  chatStorageJournalQuarantineFile?: string;
  /**
   * `legacy_chat_revision_gap_recovered` only: the legacy v1 revision chain
   * the migration recovered across (revisions and counts, never content).
   */
  chatStorageGapExpectedRevision?: number;
  chatStorageGapFoundRevision?: number;
  chatStorageGapNewestRevision?: number;
  chatStorageGapTabsRevision?: number;
  chatStorageGapArchiveRevision?: number;
  chatStorageGapStaleComponent?: 'tabs' | 'archives' | 'journal';
  chatStorageGapSkippedMutationCount?: number;
  /**
   * `implausible_turn_duration` only (CAN-3106). `implausibleDurationMs` is the
   * finalized, pause-adjusted value; the remaining fields are the inputs that
   * produced it, so a 57-day "turn" can be attributed to a stale `startedAt`,
   * an unfinalized entry, or a provider-supplied `duration_ms` without
   * guessing.
   */
  implausibleDurationMs?: number;
  implausibleDurationStartedAt?: string;
  implausibleDurationCompletedAt?: string;
  implausibleDurationPausedMs?: number;
  implausibleDurationProviderSupplied?: boolean;
  /**
   * `auth_resume_outcome` only: how the attempt to re-drive a turn that an
   * authentication failure stopped ended (CAN-1814).
   *
   * Every outcome was previously invisible — `resumeChatAfterAuthRecovery`
   * swallowed dispatch failures in a bare `catch {}` and its caller `void`ed the
   * statuses — so a resume that silently never happened looked identical to one
   * that was never attempted.
   */
  authResumeStatus?:
    | 'resumed'
    | 'requires-explicit-retry'
    | 'chat-busy'
    | 'dispatch-failed';
  /** `auth_resume_outcome` only: `auto` is Canopy deciding, `user` is a retry. */
  authResumeTrigger?: 'auto' | 'user';
  /** `auth_resume_outcome` only: dependency ids the stopped turn was blocked on. */
  authResumeDependencyIds?: string[];
  /**
   * `shared_container_publish_transition` only (CAN-2551). The publisher UI was
   * reduced to one quiet line, so the detailed transitions an owner used to
   * read on screen are recorded here instead. Publishing is worktree-scoped,
   * which is why this is a session diagnostic and not an app event - global
   * `app-events/` must never carry a worktree id.
   */
  sharedContainerId?: string;
  sharedContainerOrganizationId?: string;
  sharedContainerType?: SharedContainerType;
  sharedContainerPublishFrom?: SharedContainerPublicationStatus | 'none';
  sharedContainerPublishTo?: SharedContainerPublicationStatus;
  sharedContainerRevision?: number;
  sharedContainerPublishErrorReason?: SharedContainerPublicationErrorReason;
  /**
   * `shared_container_replica_purged` only. A recipient's viewer closing is
   * indistinguishable from a bug unless the teardown says why, so every purge
   * records the reason main acted on. The reason deliberately stays off the
   * IPC broadcast itself - the renderer decides on scope alone.
   */
  sharedContainerPurgeReason?: SharedContainerReplicaPurgeReason;
  /**
   * `shared_container_tracking_changed` only. An open recipient viewer that
   * stops receiving the publisher's updates looks exactly like one the
   * recipient closed, so every arm and release of its live tracking is
   * recorded, with the cause of a release folded into the value. Open/close
   * frequency only - never per pull or per realtime signal.
   */
  sharedContainerTrackingChange?: SharedContainerTrackingChange;
  importedEventCount?: number;
  transcriptPath?: string;
  compactionAppended?: boolean;
  /** `approval_decision` only: the resolved decision for the check. */
  decision?: 'allow' | 'deny';
  /** `approval_decision` only: the rule scope the decision resolved through. */
  scope?: ApprovalRuleScope | 'once';
  /** `approval_decision` only: the kind of the approval target that was checked. */
  targetKind?: ApprovalCheck['kind'];
  /**
   * `approval_decision` only: what actually produced the decision. Without it
   * a `scope: 'once'` allow conflates the user clicking "Allow once" with a
   * policy-driven auto-approval, which is precisely the distinction an audit
   * trail of privileged actions has to keep (CAN-3083). Absent on entries
   * written before the field existed; treat that as `'prompt'`. Safety policy
   * denials use `'safety-rule'`, never an attribution to the user.
   */
  approvalDecisionSource?: 'prompt' | 'mode-widened' | 'safety-rule';
  /**
   * `approval_stale_deny_observed` only: a deny rule now matches a prompt that
   * is still standing in the renderer. `promptForDecision` honours the user's
   * click without re-consulting rules, so if they press Allow the deny rule is
   * bypassed. Pre-existing behaviour (CAN-3083 is simply the first code that
   * can observe it); recorded rather than acted on. The hazard, and why this
   * change deliberately observes it without fixing it, are written up under
   * "Stale deny rules" in `docs/tool-approvals.md`; this counter is the
   * evidence that would justify acting on it.
   */
  approvalStaleDenyRequestId?: string;
  portalCommandId?: string;
  portalSnapshotStage?:
    | 'command_received'
    | 'snapshot_build_started'
    | 'snapshot_section_completed'
    | 'snapshot_build_completed'
    | 'snapshot_event_posted'
    | 'snapshot_event_dropped'
    | 'snapshot_queued'
    | 'snapshot_dequeued'
    | 'snapshot_coalesced'
    | 'snapshot_drained';
  portalSnapshotSection?:
    | 'workspaces_list'
    | 'worktrees'
    | 'standalone_chats'
    | 'chat_summaries'
    | 'activity_summary'
    | 'plans'
    | 'scripts'
    | 'hooks'
    | 'mcp'
    | 'pipelines'
    | 'files'
    | 'diff'
    | 'pr'
    | 'summary';
  portalSnapshotScope?: string;
  portalSnapshotEntityCount?: number;
  /** `snapshot_event_dropped` only: budget that forced the outbox trim. */
  portalSnapshotDropReason?: 'count' | 'bytes';
  /** `snapshot_event_dropped` only: types of the dropped delivery group. */
  portalSnapshotDroppedEventTypes?: string[];
  /** `snapshot_event_dropped` only: split-snapshot chunks dropped with it. */
  portalSnapshotDroppedChunkCount?: number;
  portalSnapshotRequestClass?: 'foreground' | 'background';
  portalSnapshotQueueDepth?: number;
  portalSnapshotActiveCount?: number;
  portalOutboxBatchSize?: number;
  portalOutboxQueueDepthAfterSelection?: number;
  portalOutboxOldestEventAgeMs?: number;
  portalOutboxBatchTimestamp?: string;
  portalOutboxMeanEnqueueToAckMs?: number;
  portalOutboxMaxEnqueueToAckMs?: number;
  portalOutboxEventCount?: number;
  portalOutboxSelected?: boolean;
  portalOutboxControlOnly?: boolean;
  diffStatsElapsedMs?: number;
  worktreeStatsSkipFetch?: boolean;
  worktreeStatsMode?: 'full' | 'diff_only';
  worktreeStatsOutcome?: 'success' | 'failure';
}

function getOperationNameForAuditKey(key: string): ObservabilityOperationName {
  return key.startsWith('chat:')
    ? CHAT_TURN_OPERATION_NAME
    : AGENT_TASK_OPERATION_NAME;
}

function mapAuditStatusToFailureReason(
  status: AgentAuditStatus,
): 'error' | 'abandoned' | 'other' {
  if (status === 'failure') {
    return 'error';
  }
  if (status === 'cancelled' || status === 'interrupted') {
    return 'abandoned';
  }
  return 'other';
}

interface ChatTurnOperationContext {
  trigger: UsageInitiationSource;
  failure?: ChatTurnFailure;
  subAgentFailure?: ChatTurnFailure;
}

/**
 * A failed turn always carries a category; an abandoned one only when a cause
 * was seen, so a plain cancel is not reported as a failure. A sub-agent
 * failure is reported on any outcome.
 */
function resolveChatTurnFailures(
  openEntry: OpenAuditEntry,
  status: AgentAuditStatus,
  error: string | undefined,
  options: { setupFailure?: boolean } | undefined,
): { failure?: ChatTurnFailure; subAgentFailure?: ChatTurnFailure } {
  const { failure, subAgentFailure } = (
    openEntry.failureEvidence ?? new ChatTurnFailureEvidence()
  ).classify({
    provider: openEntry.entry.provider,
    ...(error === undefined ? {} : { error }),
  });
  const rootFailure: ChatTurnFailure | undefined =
    status === 'success'
      ? undefined
      : (failure ??
        (status === 'failure'
          ? { category: options?.setupFailure ? 'setup' : 'other' }
          : undefined));
  return {
    ...(rootFailure ? { failure: rootFailure } : {}),
    ...(subAgentFailure ? { subAgentFailure } : {}),
  };
}

/**
 * Whether the daily drip was blocked, off, or already spent when a turn ran
 * out of credits (CAN-4633). Routing reads the balance at most 30 seconds
 * before dispatch, so main's latest read describes this turn's wallet.
 */
function noCreditsGrantContext(host: DesktopObservabilityHost): {
  daily_credit_grant_status?: string;
} {
  const status = host.dailyCreditGrantStatus();
  return status === undefined ? {} : { daily_credit_grant_status: status };
}

function buildAuditOperationContext(
  host: DesktopObservabilityHost,
  entry: AgentAuditEntry,
  status?: AgentAuditStatus,
  chatTurn?: ChatTurnOperationContext,
): Record<string, string | number | boolean | null | undefined> {
  return {
    ...(chatTurn ? { trigger_type: chatTurn.trigger } : {}),
    ...(chatTurn?.failure
      ? { failure_category: chatTurn.failure.category }
      : {}),
    ...(chatTurn?.failure?.detail
      ? { failure_detail: chatTurn.failure.detail }
      : {}),
    ...(chatTurn?.failure?.category === 'no_credits'
      ? noCreditsGrantContext(host)
      : {}),
    ...(chatTurn?.subAgentFailure
      ? { sub_agent_failure_category: chatTurn.subAgentFailure.category }
      : {}),
    event_type: entry.eventType,
    provider: entry.provider,
    status,
    // `model` is the model that served the turn; `requested_model` is the
    // selection the turn started with. The allowlist keeps the latter on
    // chat turns only.
    model: entry.model,
    requested_model: entry.requestedModel,
    has_transcript: entry.hasTranscript,
    // Always present so PostHog can split credits turns from own-account
    // turns; organization gateway turns are routed through AI credits too.
    is_ai_credits_routed: entry.aiCreditsRouted === true,
    tool_use_count: entry.toolUseCount,
    sub_agent_count: entry.subAgentCount,
    message_count: entry.messageCount,
    duration_ms: entry.durationMs,
    total_cost_usd: entry.totalCostUsd,
  };
}

function startAuditOperation(
  host: DesktopObservabilityHost,
  key: string,
  entry: AgentAuditEntry,
): void {
  host.instrumentation.startOperation(getOperationNameForAuditKey(key), {
    operationKey: createDesktopInstrumentationOperationKey(key),
    context: buildAuditOperationContext(host, entry),
  });
}

function finishAuditOperation(
  host: DesktopObservabilityHost,
  key: string,
  entry: AgentAuditEntry,
  status: AgentAuditStatus,
  chatTurn?: ChatTurnOperationContext,
): void {
  const operationOptions = {
    operationKey: createDesktopInstrumentationOperationKey(key),
    context: buildAuditOperationContext(host, entry, status, chatTurn),
  };
  const operationName = getOperationNameForAuditKey(key);

  if (status === 'success') {
    host.instrumentation.succeedOperation(operationName, operationOptions);
    return;
  }

  host.instrumentation.failOperation(
    operationName,
    mapAuditStatusToFailureReason(status),
    operationOptions,
  );
}

function reportAppDiagnosticToDesktopInstrumentation(
  instrumentation: ObservabilityInstrumentationPort,
  event: AppDiagnosticRecord,
): void {
  // Expected sign-in outcomes (cancelled, replaced, timed out, or access
  // denied at the provider) stay local; only real failures are errors.
  const isNonErrorCloudOAuthOutcome =
    event.kind === 'cloud_oauth_login_failed' &&
    ((event.cloudOAuthOutcome !== undefined &&
      NON_ERROR_CLOUD_OAUTH_OUTCOMES.has(event.cloudOAuthOutcome)) ||
      (event.cloudOAuthOutcome === 'provider_error' &&
        event.cloudOAuthProviderError === 'access_denied'));
  if (isNonErrorCloudOAuthOutcome) {
    return;
  }

  if (!REMOTE_APP_DIAGNOSTIC_KINDS.has(event.kind)) {
    return;
  }

  const rendererProcessGone = event.kind === 'renderer_process_gone';
  const rendererCrashReason =
    rendererProcessGone && typeof event.reason === 'string'
      ? event.reason.replace(/^app_advisor_window:/, '')
      : undefined;
  const rendererCrashed =
    rendererProcessGone && rendererCrashReason !== 'clean-exit';
  const errorMessage = rendererProcessGone
    ? `${BRAND.displayName} renderer process gone: ${rendererCrashReason ?? 'unknown'}`
    : `${BRAND.displayName} desktop diagnostic: ${event.kind}`;

  instrumentation.captureError(buildAppDiagnosticError(event, errorMessage), {
    context: {
      // Synthetic diagnostics are all `Error`s whose stack is this reporting
      // path, and main frames shift every build, so group them by kind.
      // Main-process exceptions keep PostHog's frame-based grouping.
      ...(!MAIN_PROCESS_ERROR_KINDS.has(event.kind) && {
        $exception_fingerprint: `app-diagnostic:${event.kind}`,
      }),
      kind: event.kind,
      reason: event.reason,
      exit_code: event.exitCode,
      process_type: event.processType,
      service_name: event.serviceName,
      process_name: event.processName,
      renderer_surface: event.rendererSurface,
      renderer_crash_reason: rendererCrashReason,
      renderer_crashed: rendererCrashed,
      pressure_level: event.pressureLevel,
      memory_rss_bytes: event.memoryRssBytes,
      main_heap_used_bytes: event.mainHeapUsedBytes,
      main_heap_total_bytes: event.mainHeapTotalBytes,
      main_heap_limit_bytes: event.mainHeapLimitBytes,
      main_rss_bytes: event.mainRssBytes,
      main_external_bytes: event.mainExternalBytes,
      main_array_buffer_bytes: event.mainArrayBufferBytes,
      cpu_percent: event.cpuPercent,
      active_chat_turn_count: event.activeChatTurnCount,
      active_pipeline_execution_count: event.activePipelineExecutionCount,
      cloud_oauth_stage: event.cloudOAuthStage,
      cloud_oauth_outcome: event.cloudOAuthOutcome,
      cloud_oauth_failure_class: event.cloudOAuthFailureClass,
      cloud_oauth_http_status: event.cloudOAuthHttpStatus,
      cloud_oauth_provider_error: event.cloudOAuthProviderError,
      cloud_oauth_duration_ms: event.cloudOAuthDurationMs,
      cloud_oauth_correlation_id: event.cloudOAuthCorrelationId,
      cloud_oauth_platform: event.cloudOAuthPlatform,
      cloud_oauth_app_version: event.cloudOAuthAppVersion,
    },
  });
}

function isPersistedTranscriptContentLine(line: string): boolean {
  const parsed = safeJsonParse(line);
  if (!parsed) {
    return false;
  }

  return (
    parsed.type !== 'canopy_transcript_truncated' &&
    parsed.type !== 'canopy_injected_prompt'
  );
}

function writeObservabilityError(message: string, error: unknown): void {
  const details =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n${details}\n`);
}

/** A chat's audit metadata, without any per-turn counters or outcome. */
function chatEntryMetadata(
  entry: AgentAuditEntry,
): Omit<
  AgentAuditEntry,
  | 'id'
  | 'status'
  | 'startedAt'
  | 'tokens'
  | 'messageCount'
  | 'assistantMessageCount'
  | 'toolUseCount'
  | 'subAgentCount'
  | 'toolCounts'
  | 'hasTranscript'
> {
  return {
    eventType: entry.eventType,
    provider: entry.provider,
    label: entry.label,
    ...(entry.modelSource ? { modelSource: entry.modelSource } : {}),
    ...(entry.executionHarness
      ? { executionHarness: entry.executionHarness }
      : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
    ...(entry.modelRouting ? { modelRouting: entry.modelRouting } : {}),
    ...(entry.serviceTier ? { serviceTier: entry.serviceTier } : {}),
    ...(entry.aiCreditsRouted ? { aiCreditsRouted: true } : {}),
    ...(entry.modelGatewayRouted ? { modelGatewayRouted: true } : {}),
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(entry.worktreeId ? { worktreeId: entry.worktreeId } : {}),
    ...(entry.contextWorkspaceId
      ? { contextWorkspaceId: entry.contextWorkspaceId }
      : {}),
    ...(entry.repoId ? { repoId: entry.repoId } : {}),
    ...(entry.repoLabel ? { repoLabel: entry.repoLabel } : {}),
    ...(entry.chatId ? { chatId: entry.chatId } : {}),
    ...(entry.sdkSessionId ? { sdkSessionId: entry.sdkSessionId } : {}),
    ...(entry.chatMode ? { chatMode: entry.chatMode } : {}),
    ...(entry.linkTarget ? { linkTarget: entry.linkTarget } : {}),
  };
}

function buildTranscriptRequest(
  entry: Pick<AgentAuditEntry, 'id' | 'eventType' | 'startedAt'>,
): AgentAuditTranscriptRequest {
  return {
    id: entry.id,
    eventType: entry.eventType,
    startedAt: entry.startedAt,
  };
}

function buildSyntheticPromptRecord(
  options: TranscriptSeedOptions,
): AgentAuditTranscriptSyntheticPromptRecord {
  const record: AgentAuditTranscriptSyntheticPromptRecord = {
    type: 'canopy_user_prompt',
    provider: options.provider,
    original_text: options.originalText,
    submitted_text: options.submittedText,
    plan_mode: options.planMode,
    ...(options.userMessageId
      ? { user_message_id: options.userMessageId }
      : {}),
    ...(options.steering ? { steering: options.steering } : {}),
  };
  if ((options.fileReferences?.length ?? 0) > 0) {
    record.file_references = options.fileReferences;
  }
  if (isInternalChatRequest(options)) {
    record.canopy_hidden = true;
  }
  return record;
}

function buildInjectedPrompts(
  options: ChatTranscriptStartOptions,
): AgentTranscriptInjectedPrompt[] {
  const prompts: AgentTranscriptInjectedPrompt[] = [];

  if (options.systemPromptAppend) {
    const appliesForClaude = options.provider === 'claude';
    const appliesForCodex =
      options.provider === 'codex' && !options.sdkSessionId;

    if (appliesForClaude || appliesForCodex) {
      prompts.push({
        kind: 'system_prompt_append',
        provider: options.provider,
        applicationCondition:
          options.provider === 'claude'
            ? 'claude_system_prompt_append_each_turn'
            : 'codex_first_turn_without_session_id',
        text: options.systemPromptAppend,
      });
    }
  }

  if (options.injectedPrompts) {
    prompts.push(...options.injectedPrompts);
  }

  if (options.planMode && options.provider === 'codex') {
    prompts.push({
      kind: 'plan_mode_developer_instructions',
      provider: 'codex',
      applicationCondition: 'plan_mode_enabled',
      text: PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    });
  }

  if (options.orgMemoryBlock) {
    prompts.push({
      kind: 'org_memory',
      provider: options.provider,
      applicationCondition: 'org_memory_enabled_for_turn',
      text: options.orgMemoryBlock,
    });
  }

  return prompts;
}

function buildInjectedPromptRecord(
  prompt: AgentTranscriptInjectedPrompt,
): AgentAuditTranscriptInjectedPromptRecord {
  const record: AgentAuditTranscriptInjectedPromptRecord = {
    type: 'canopy_injected_prompt',
    kind: prompt.kind,
    provider: prompt.provider,
    application_condition: prompt.applicationCondition,
    text: prompt.text,
  };
  if (prompt.deferredToolsReload) {
    record.deferred_tools_reload = {
      enabled_resources: prompt.deferredToolsReload.enabledResources,
    };
  }
  return record;
}

function injectedPromptResourcesKey(
  prompt: AgentTranscriptInjectedPrompt,
): string {
  return JSON.stringify(
    (prompt.deferredToolsReload?.enabledResources ?? [])
      .map((resource) => ({
        ref: resource.ref,
        kind: resource.kind,
      }))
      .sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) ||
          left.ref.localeCompare(right.ref),
      ),
  );
}

function buildTranscriptTruncationMarker(): Record<string, unknown> {
  return {
    type: 'canopy_transcript_truncated',
    max_bytes: TRANSCRIPT_MAX_BYTES,
  };
}

function createEmptyProviderUsage(
  provider: AgentProviderType,
): ProviderUsageSummary {
  return {
    provider,
    authState: 'unknown',
    hasRemainingLimits: false,
  };
}

function readCodexEventTurnId(
  event: Record<string, unknown>,
): string | undefined {
  const turn = isRecord(event.turn) ? event.turn : null;
  return (
    readString(event, 'turn_id') ??
    readString(event, 'turnId') ??
    (turn ? readString(turn, 'id') : undefined)
  );
}

export function commandLooksLikePrCreate(command: string): boolean {
  return splitCommandSegments(command).some((segment) => {
    const tokens = tokenizeCommandSegment(segment);
    let tokenIndex = 0;

    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[tokenIndex] ?? '')) {
      tokenIndex += 1;
    }

    const executable = tokens[tokenIndex];
    if (!executable || (executable !== 'gh' && !executable.endsWith('/gh'))) {
      return false;
    }
    tokenIndex += 1;

    while (tokens[tokenIndex]?.startsWith('-')) {
      const option = tokens[tokenIndex];
      tokenIndex += 1;
      if (
        option &&
        !option.includes('=') &&
        tokens[tokenIndex] &&
        tokens[tokenIndex] !== 'pr' &&
        !tokens[tokenIndex].startsWith('-')
      ) {
        tokenIndex += 1;
      }
    }

    return (
      tokens[tokenIndex] === 'pr' &&
      (tokens[tokenIndex + 1] === 'create' || tokens[tokenIndex + 1] === 'new')
    );
  });
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let segmentStart = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ';' || char === '&' || char === '|' || char === '\n') {
      segments.push(command.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }

  segments.push(command.slice(segmentStart));
  return segments;
}

function tokenizeCommandSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of segment.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function extractGitHubPrUrl(text: string): {
  prNumber: number;
  prUrl: string;
} | null {
  const match = text.match(
    /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/,
  );
  if (!match?.[0] || !match[1]) {
    return null;
  }
  const prNumber = Number.parseInt(match[1], 10);
  return Number.isFinite(prNumber) ? { prNumber, prUrl: match[0] } : null;
}

function repoLabelFromPrUrl(prUrl: string): string | undefined {
  return prUrl.match(
    /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/,
  )?.[1];
}

function sanitizeEntryIdPart(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
}

function collectText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => collectText(item)).join('\n');
  }
  if (!isRecord(value)) {
    return '';
  }

  return [value.text, value.content, value.output, value.aggregated_output]
    .map((item) => collectText(item))
    .filter((item) => item.length > 0)
    .join('\n');
}

function buildCodexAccountUsageSummary(
  account: GetAccountResponse,
): Pick<
  ProviderUsageSummary,
  'authState' | 'accountEmail' | 'accountLabel' | 'subscriptionLabel'
> {
  return {
    authState: account.account
      ? 'authenticated'
      : account.requiresOpenaiAuth
        ? 'unauthenticated'
        : 'unknown',
    accountEmail:
      account.account?.type === 'chatgpt'
        ? toOptionalString(account.account.email)
        : undefined,
    accountLabel:
      account.account?.type === 'chatgpt'
        ? toOptionalString(account.account.email)
        : account.account?.type === 'apiKey'
          ? 'API key'
          : undefined,
    subscriptionLabel:
      account.account?.type === 'chatgpt'
        ? codexSubscriptionLabel(account.account.planType)
        : undefined,
  };
}

function isCodexInvalidatedOAuthError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return (
    message.includes('token_revoked') ||
    message.toLowerCase().includes('invalidated oauth token')
  );
}

function toIsoStringFromEpoch(value: number | null): string | undefined {
  if (value === null || !Number.isFinite(value)) {
    return undefined;
  }

  const normalizedValue = value < 1_000_000_000_000 ? value * 1000 : value;
  const parsed = new Date(normalizedValue);
  const timestamp = parsed.getTime();
  return Number.isFinite(timestamp) ? parsed.toISOString() : undefined;
}

function toOptionalString(
  value: string | null | undefined,
): string | undefined {
  return value ?? undefined;
}

function isClaudeEventShape(data: Record<string, unknown>): boolean {
  const type = readString(data, 'type');
  return (
    type === 'system' ||
    type === 'assistant' ||
    type === 'user' ||
    type === 'result' ||
    type === 'conversation_reset' ||
    type === 'error'
  );
}

function isCodexEventShape(data: Record<string, unknown>): boolean {
  const type = readString(data, 'type');
  return (
    type === 'thread.started' ||
    type === 'thread.token_usage.updated' ||
    type === 'thread.subagent_token_usage.updated' ||
    type === 'turn.started' ||
    type === 'turn.completed' ||
    type === 'turn.failed' ||
    type === 'item.started' ||
    type === 'item.updated' ||
    type === 'item.completed' ||
    type === 'item.plan.delta' ||
    type === 'error'
  );
}

function isCodexSubagentEvent(data: Record<string, unknown>): boolean {
  return (
    data.type === 'thread.subagent_token_usage.updated' ||
    (data.type === 'thread.started' && isCodexSubagentThreadStarted(data)) ||
    (data.type === 'item.started' &&
      isRecord(data.item) &&
      readString(data.item, 'type') === 'collab_agent_tool_call' &&
      readString(data.item, 'tool') === 'spawnAgent')
  );
}

function isSyntheticCodexErrorResult(data: Record<string, unknown>): boolean {
  return (
    data.type === 'result' &&
    data.is_error === true &&
    data.subtype === 'codex_error' &&
    typeof data.result === 'string'
  );
}

async function readClaudeAuthStatus(
  host: DesktopObservabilityHost,
): Promise<ClaudeAuthStatus | null> {
  try {
    const status = await host.claude.checkAuthStatus('usage-refresh');
    const detailParts = status.detail?.match(/^(.*?)\s+\((.*)\)$/);
    return {
      loggedIn: status.authenticated,
      authMethod: detailParts?.[1] ?? status.detail ?? undefined,
      email: status.accountLabel ?? undefined,
      subscriptionType: detailParts?.[2],
      planType: status.planType ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the friendly full subscription label for the Claude Usage card. Picks
 * the richest available raw plan string — preferring the enriched tier
 * (`planType`, which distinguishes Max 5x/20x and Team/Team Premium) over the
 * coarse `subscriptionType` and the raw `rateLimitTier` — then runs it through
 * the shared catalog so it renders as e.g. `Claude Max 20x`. Unknown strings
 * fall through to a title-cased passthrough, so nothing is silently dropped.
 */
function claudeSubscriptionLabel(
  authStatus: ClaudeAuthStatus | null,
  usageDetails: ClaudeUsageDetails | null,
): string | undefined {
  const rawPlan =
    authStatus?.planType ??
    authStatus?.subscriptionType ??
    usageDetails?.rateLimitTier;
  return rawPlan
    ? labelForPlanKey(normalizePlanKey('claude', rawPlan))
    : undefined;
}

/**
 * Friendly Codex/ChatGPT subscription label, or undefined when the plan type is
 * absent or unrecognized. Mirrors `claudeSubscriptionLabel`'s guard so a
 * `chatgpt` account with a null or `'unknown'` plan type renders a clean card
 * instead of an editorialized `ChatGPT Unknown` suffix.
 */
function codexSubscriptionLabel(
  rawPlanType: string | null | undefined,
): string | undefined {
  return subscriptionLabelForPlanType('codex', rawPlanType) ?? undefined;
}

/**
 * Resolve the Claude usage endpoint. Production always uses the real Anthropic
 * URL; under the build-time E2E gate (Doc 6 §3, Doc 11) it points at the mock
 * server's `/api/oauth/usage`. Dead-code-eliminated from production.
 */
function resolveClaudeUsageUrl(): string {
  if (__CANOPY_E2E__) {
    const mockBaseUrl = process.env.CANOPY_MOCK_LLM_BASE_URL;
    if (mockBaseUrl) {
      return `${mockBaseUrl.replace(/\/+$/, '')}/api/oauth/usage`;
    }
  }
  return 'https://api.anthropic.com/api/oauth/usage';
}

function claudeCredentialFailureMessage(
  reason: ClaudeOauthCredentialsReadFailureReason,
  source: ClaudeOauthCredentialsReadFailureSource | undefined,
): string {
  switch (reason) {
    case 'credential_not_found':
      if (source === 'credentials_file') {
        return 'Claude credentials were not found in the Claude Code config directory. Sign in to Claude Code, then refresh.';
      }
      return process.platform === 'win32'
        ? 'Claude credentials were not found in the Windows Claude config or legacy Credential Manager. Sign in to Claude Code from Windows (a WSL-only login is stored separately), then refresh.'
        : 'Claude credentials were not found in the system credential store. Sign in to Claude Code, then refresh.';
    case 'credential_read_failed':
      if (source === 'credentials_file') {
        return 'Could not read the Claude Code credentials file. Check its permissions or sign in to Claude Code again, then refresh.';
      }
      return process.platform === 'win32'
        ? 'Could not read Claude credentials from Windows Credential Manager. Sign in to Claude Code from Windows again, then refresh.'
        : 'Could not read Claude credentials from the system credential store. Sign in to Claude Code again, then refresh.';
    case 'credential_parse_failed':
      if (source === 'credentials_file') {
        return 'The Claude Code credentials file is invalid or unreadable. Sign in to Claude Code again, then refresh.';
      }
      return 'The stored Claude credential is invalid or unreadable. Sign in to Claude Code again, then refresh.';
    case 'credential_expired':
      return 'The stored Claude credential has expired. Run Claude Code to renew it, then refresh.';
    case 'username_unavailable':
      return 'Could not determine the operating-system account used to store Claude credentials.';
    case 'unsupported_platform':
      return 'Live Claude usage is unavailable on this platform.';
  }
}

/**
 * Kind counterpart of {@link claudeCredentialFailureMessage}: credential
 * store failures are auth problems (signing in again rewrites the stored
 * credential), while a platform without a supported store can never provide
 * live usage and an unreadable OS username is environmental, not fixable by
 * re-auth.
 */
function claudeCredentialFailureKind(
  reason: ClaudeOauthCredentialsReadFailureReason,
): ProviderUsageErrorInfo['kind'] {
  switch (reason) {
    case 'credential_not_found':
    case 'credential_read_failed':
    case 'credential_parse_failed':
    case 'credential_expired':
      return 'auth';
    case 'username_unavailable':
      return 'unknown';
    case 'unsupported_platform':
      return 'unsupported';
  }
}

function claudeUsageFailure(
  kind: ProviderUsageErrorInfo['kind'],
  message: string,
  detail?: string,
  retryAfter?: string | null,
): ClaudeUsageDetailsReadResult {
  return {
    status: 'failure',
    error: message,
    errorInfo: {
      kind,
      ...(kind === 'rate_limited' ? {} : { message }),
      ...(detail ? { detail } : {}),
    },
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

async function readClaudeUsageDetails(
  host: DesktopObservabilityHost,
): Promise<ClaudeUsageDetailsReadResult> {
  const credentialResult = await host.claude.readOauthCredentials();
  if (credentialResult.status === 'failure') {
    return claudeUsageFailure(
      claudeCredentialFailureKind(credentialResult.reason),
      claudeCredentialFailureMessage(
        credentialResult.reason,
        credentialResult.source,
      ),
    );
  }

  try {
    const response = await fetch(resolveClaudeUsageUrl(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credentialResult.credentials.accessToken}`,
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
    });
    if (!response.ok) {
      const signInAgain = response.status === 401 || response.status === 403;
      const rateLimited = response.status === 429;
      return claudeUsageFailure(
        classifyUsageFetchHttpStatus(response.status),
        signInAgain
          ? `Claude rejected the stored credential (HTTP ${response.status}). Sign in to Claude Code again, then refresh.`
          : `Claude usage request failed (HTTP ${response.status}).`,
        `GET /api/oauth/usage responded ${response.status} ${response.statusText}`,
        rateLimited ? response.headers.get('retry-after') : undefined,
      );
    }

    const raw = await response.text();
    const parsed = safeJsonParse(raw);
    if (!parsed) {
      return claudeUsageFailure(
        'service',
        'Claude usage returned an unreadable response.',
      );
    }

    return {
      status: 'success',
      details: parseClaudeUsageDetails(
        parsed,
        credentialResult.credentials.rateLimitTier,
      ),
    };
  } catch (error) {
    return claudeUsageFailure(
      'network',
      'Could not reach the Claude usage service.',
      error instanceof Error ? error.message : undefined,
    );
  }
}

export interface PipelineExecutionStateSyncInput {
  id: ExecutionState['id'];
  parent_execution_id?: ExecutionState['parent_execution_id'];
  pipeline_id: ExecutionState['pipeline_id'];
  pipeline_snapshot: Pick<ExecutionState['pipeline_snapshot'], 'name'>;
  project_id?: ExecutionState['project_id'];
  worktree_id?: ExecutionState['worktree_id'];
  model_config?: ExecutionState['model_config'];
  jobs: ExecutionState['jobs'];
}

/**
 * Iteration number for a retry attempt's *final* (non-historical) steps.
 *
 * A `RetryAttempt` snapshot carries no `iteration_count` (unlike the live job),
 * so it must be derived from the recorded history. Derive it from the highest
 * explicit `iteration` rather than `history.length + 1`: a `CANOPY_JOB_RESTART`
 * resets `iteration_count`, so numbering is not guaranteed contiguous or
 * 1-based, and a length-based guess could collide with an earlier iteration's
 * observability key and silently merge two iterations' audit entries.
 */
function finalIterationForAttempt(
  iterationHistory: readonly { iteration: number }[] | undefined,
): number {
  if (!iterationHistory || iterationHistory.length === 0) {
    return 1;
  }
  const highest = iterationHistory.reduce(
    (max, snapshot) => Math.max(max, snapshot.iteration),
    0,
  );
  return Math.max(1, highest) + 1;
}

/** Bounds the responses held for chats whose turn ended; see revival. */
const MAX_HELD_ACCOUNT_PROXY_RESPONSES = 256;
const MAX_HELD_ACCOUNT_PROXY_CHATS = 200;

function buildPipelineStepObservabilityKey(options: {
  executionId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  iteration?: number;
}): string {
  const iteration = Math.max(1, options.iteration ?? 1);
  return `pipeline:${options.executionId}/${options.jobId}/${options.stepId}/${String(options.attempt)}${iteration >= 2 ? `/i${String(iteration)}` : ''}`;
}

interface SerializedObservabilitySnapshot {
  text: string;
  usageTimestampSpan: { start: number; end: number } | null;
}

function serializedSnapshotForComparison(
  snapshot: AgentObservabilitySnapshot,
): SerializedObservabilitySnapshot {
  const text = JSON.stringify(snapshot, null, 2);
  // Only the direct usage.updatedAt value is volatile. Match the exact
  // top-level JSON layout and encoded value; an unexpected shape must take
  // the normal write path rather than accidentally ignore retained content.
  const marker = '\n  "usage": {\n    "updatedAt": ';
  const markerAt = text.indexOf(marker);
  if (markerAt < 0 || text.indexOf(marker, markerAt + marker.length) >= 0) {
    return { text, usageTimestampSpan: null };
  }
  const start = markerAt + marker.length;
  const encodedTimestamp = JSON.stringify(snapshot.usage.updatedAt);
  const end = start + encodedTimestamp.length;
  if (
    text.slice(start, end) !== encodedTimestamp ||
    (text[end] !== ',' && text[end] !== '\n')
  ) {
    return { text, usageTimestampSpan: null };
  }
  return { text, usageTimestampSpan: { start, end } };
}

function sameSnapshotContent(
  previous: SerializedObservabilitySnapshot | null,
  current: SerializedObservabilitySnapshot,
): boolean {
  const previousSpan = previous?.usageTimestampSpan;
  const currentSpan = current.usageTimestampSpan;
  if (!previous || !previousSpan || !currentSpan) return false;
  return (
    previous.text.slice(0, previousSpan.start) ===
      current.text.slice(0, currentSpan.start) &&
    previous.text.slice(previousSpan.end) ===
      current.text.slice(currentSpan.end)
  );
}

function snapshotFileIdentity(info: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function snapshotOwnedFileIdentity(info: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}): string {
  // Rename can update ctime. These fields identify the staged inode and its
  // written contents across that rename; retain destination ctime afterward.
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
}

function withoutCommittedEntries<T>(
  pending: T[],
  committed: readonly T[],
): T[] {
  const remainingCounts = new Map<T, number>();
  for (const entry of committed) {
    remainingCounts.set(entry, (remainingCounts.get(entry) ?? 0) + 1);
  }
  return pending.filter((entry) => {
    const count = remainingCounts.get(entry) ?? 0;
    if (count === 0) return true;
    remainingCounts.set(entry, count - 1);
    return false;
  });
}

function estimatePendingRecordBytes(value: unknown): number {
  const seen = new Set<object>();
  let visited = 0;
  const estimate = (current: unknown, depth: number): number => {
    visited += 1;
    if (visited > 64 || depth > 4) return FLUSH_BYTE_TRIGGER;
    if (typeof current === 'string') {
      return Math.min(FLUSH_BYTE_TRIGGER, current.length * 3);
    }
    if (
      typeof current === 'bigint' ||
      typeof current === 'function' ||
      typeof current === 'symbol'
    ) {
      return FLUSH_BYTE_TRIGGER;
    }
    if (current === null || typeof current !== 'object') return 16;
    if (seen.has(current)) return FLUSH_BYTE_TRIGGER;
    seen.add(current);
    try {
      if (
        !Array.isArray(current) &&
        Object.getPrototypeOf(current) !== Object.prototype
      ) {
        return FLUSH_BYTE_TRIGGER;
      }
      let bytes = 64;
      // Enumerate lazily and inspect descriptors, so enqueue never evaluates
      // arbitrary diagnostic getters or materializes every child value.
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor)) return FLUSH_BYTE_TRIGGER;
        bytes += key.length * 3 + estimate(descriptor.value, depth + 1);
        if (bytes >= FLUSH_BYTE_TRIGGER) return FLUSH_BYTE_TRIGGER;
      }
      return bytes;
    } catch {
      return FLUSH_BYTE_TRIGGER;
    }
  };
  return Math.min(FLUSH_BYTE_TRIGGER, estimate(value, 0));
}

export function sanitizeTurnDispatchSlowDiagnostic(
  event: SessionDiagnosticRecord,
): SessionDiagnosticRecord {
  if (event.kind !== 'turn_dispatch_slow') return event;
  const phases: NonNullable<SessionDiagnosticRecord['phases']> = [];
  for (const phase of event.phases ?? []) {
    if (
      !TURN_DISPATCH_PHASES.includes(phase.phase) ||
      !Number.isFinite(phase.elapsedMs)
    ) {
      continue;
    }
    phases.push({
      phase: phase.phase,
      elapsedMs: Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(0, Math.round(phase.elapsedMs)),
      ),
    });
  }
  return {
    version: event.version,
    timestamp: event.timestamp,
    kind: event.kind,
    sessionKey: event.sessionKey,
    projectId: event.projectId,
    worktreeId: event.worktreeId,
    chatId: event.chatId,
    providerType: event.providerType,
    totalMs:
      typeof event.totalMs === 'number' && Number.isFinite(event.totalMs)
        ? Math.min(
            Number.MAX_SAFE_INTEGER,
            Math.max(0, Math.round(event.totalMs)),
          )
        : 0,
    endpoint: event.endpoint === 'first_event' ? 'first_event' : 'enqueued',
    phases: phases.slice(0, TURN_DISPATCH_PHASES.length),
  };
}

export class ObservabilityService {
  private readonly listeners = new Set<
    (event: AgentObservabilityUpdateEvent) => void
  >();
  private readonly openEntries = new Map<string, OpenAuditEntry>();
  /** CAN-5828: the audit entry each delivered interface tool call belongs to. */
  private readonly interfaceToolCallEntryIds = new Map<string, string>();
  /** Canonical turn state, not raw items, decides undispatched turns' entries. */
  private turnStateAudit = false;
  /** Each chat's autonomous turns awaiting their first root output. */
  private readonly pendingAutonomousTurns = new Map<
    string,
    PendingAutonomousTurn[]
  >();
  /** The last autonomous turn each chat opened an entry for. */
  private readonly openedAutonomousTurnIds = new Map<string, string>();
  private readonly codexSubagentUsageByChat = new Map<
    string,
    CodexSubagentUsageTracker
  >();
  private readonly codexPipelineSubagentTrackerKeys = new Set<string>();
  private readonly claudeQueryIds = new Set<string>();
  private readonly claudeTaskTrackers = new Map<
    string,
    ClaudeTaskUsageTracker
  >();
  private readonly transcriptStates = new Map<string, TranscriptSidecarState>();
  private readonly transcriptBudgets = new Map<
    string,
    TranscriptSidecarBudget
  >();
  private readonly retiringTranscriptStates = new Set<TranscriptSidecarState>();
  private pendingTranscriptIndexRecords: TranscriptIndexRecord[] = [];
  private readonly finalizedPipelineStepKeys = new Set<string>();
  private readonly pipelineOutputBuffers = new Map<string, string>();
  private droppedPipelineOutputChunks = 0;
  private droppedPipelineOutputBytes = 0;
  private recentEntries: AgentAuditEntry[] = [];
  private pendingPersistedEntries: AgentAuditEntry[] = [];
  private pendingUsageMetricEvents: UsageMetricEvent[] = [];
  private readonly hydratedChatTurnTokensByAuditEntryId = new Map<
    string,
    AgentAuditEntry['tokens']
  >();
  private readonly hydratedChatTurnCostByAuditEntryId = new Map<
    string,
    number | null
  >();
  private chatTurnUsageStartsByAuditEntryId = new Map<
    string,
    ChatTurnUsageEvent
  >();
  private pendingAppDiagnostics: AppDiagnosticRecord[] = [];
  private pendingSessionDiagnostics: SessionDiagnosticRecord[] = [];
  // Earlier-process entries have no transcript state; reopening one corrupts it.
  private readonly finalizedChatEntryIdsInProcess = new Set<string>();
  private usageProviders = {
    claude: createEmptyProviderUsage('claude'),
    codex: createEmptyProviderUsage('codex'),
  };
  private readonly claudeUsageFetchGate: ClaudeUsageFetchGate<ClaudeUsageDetailsReadResult>;
  private readonly claudeUsageReadOrderByResult = new WeakMap<
    ClaudeUsageDetailsReadResult,
    number
  >();
  private readonly claudeUsageWindowPatches = new Map<
    string,
    ClaudeUsageWindowPatch
  >();
  private readonly claudeLatestSuccessfulReadOrderByAccount = new Map<
    string | null,
    number
  >();
  private readonly claudePublishedSuccessfulReadOrderByAccount = new Map<
    string | null,
    number
  >();
  private claudeUsageEventOrder = 0;
  private claudeUsageAuthDisagreement = false;
  private claudeUsageRefreshDebounce: {
    trailing: ReturnType<typeof setTimeout> | null;
    maxWait: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private unsubscribeOpenCodeAccounts: (() => void) | null = null;
  private copilotUsage: ProviderUsageSummary | null = null;
  private unsubscribeCopilotUsage: (() => void) | null = null;
  private unsubscribeAccountProxyResponses: (() => void) | null = null;
  /**
   * Proxied responses of a chat whose turn had already ended, by audit key,
   * kept in case a late event reopens that turn.
   */
  private readonly closedTurnAccountProxyResponses = new Map<
    string,
    AccountProxyResponse[]
  >();
  private copilotUsageRefresh: {
    controller: AbortController;
    done: Promise<void>;
  } | null = null;
  private cursorUsage: ProviderUsageSummary | null = null;
  private unsubscribeCursorRollout: (() => void) | null = null;
  private cursorUsageRefresh: {
    controller: AbortController;
    done: Promise<void>;
  } | null = null;
  private retainedAccountSnapshots = new Map<
    string,
    RetainedAccountUsageSnapshot
  >();
  private retentionDays = 7;
  private retentionDaysLoadPromise: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private flushWindowStartedAt: number | null = null;
  private scheduledWriteBytes = 0;
  private persistedSnapshot: SerializedObservabilitySnapshot | null = null;
  private persistedSnapshotIdentity: string | null = null;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private readonly pendingFinalizedTranscriptAppends = new Set<Promise<void>>();
  private readonly managedDelegationCapture: ManagedDelegationCapture;
  private readonly pipelineExecutionLineage = new Map<
    string,
    PipelineExecutionLineage
  >();
  private readonly observedTaskEntryIdsByKey = new Map<string, string>();
  /** Pipeline task rows can outlive the bounded recent list while lineage loads. */
  private readonly retainedPipelineEntriesByKey = new Map<
    string,
    AgentAuditEntry
  >();
  private readonly managedDelegationAuditEntriesById = new Map<
    string,
    AgentAuditEntry
  >();
  /**
   * Plan usage event ids already counted on some audit entry, rebuilt from
   * the stored `planEvents.eventIds` on start. Unlike the bounded recent
   * entries, it still knows an id after its turn has been evicted.
   */
  private readonly countedPlanUsageEventIds = new Set<string>();
  private storedStateLoad: Promise<void> | null = null;
  /**
   * Plan events recorded while `start()` loads that index. They are counted
   * once it is complete, so a replay during start-up is still recognized.
   */
  private plansAwaitingCountedIds: Array<{
    event: PlanUsageEvent;
    target: PlanUsageTarget | null;
  }> | null = null;
  private readonly loadedManagedDelegationAuditDays = new Set<string>();
  private readonly managedDelegationEntryIdsUpdatedInProcess =
    new Set<string>();
  private started = false;
  private disposing = false;
  private costHistoryRepairTimer: ReturnType<typeof setTimeout> | null = null;
  private codexMonitor: CodexUsageMonitor | null = null;
  private readonly providerUsageRefreshes = new Map<
    RefreshableUsageProvider,
    Promise<void>
  >();
  private readonly pendingProviderUsageRefreshes =
    new Set<RefreshableUsageProvider>();
  private readonly mergedProviderUsageRefreshes = new Map<
    MergedUsageRefreshProvider,
    MergedUsageRefresh
  >();
  private readonly providerUsageRefreshVersions: Record<
    RefreshableUsageProvider,
    number
  > = {
    claude: 0,
    codex: 0,
    cursor: 0,
    copilot: 0,
  };

  private readonly accountProxyQuotaUsage: AccountProxyQuotaUsage;
  private accountProxyUsagePorts: typeof AccountProxyUsagePorts | null = null;
  private accountProxyUsageInitialization: Promise<void> | null = null;
  private unsubscribeAccountProxyInventory: (() => void) | null = null;

  constructor(private readonly host: DesktopObservabilityHost) {
    this.accountProxyQuotaUsage = new AccountProxyQuotaUsage({
      inventory: (): readonly AccountProxyUsageInventoryEntry[] =>
        this.accountProxyUsagePorts?.getAccountProxyUsageInventory() ?? [],
      read: async (target, signal): Promise<AccountProxyUsageReadResult> => {
        signal.throwIfAborted();
        const ports = this.accountProxyUsagePorts;
        if (!ports) throw new Error('Account proxy inventory unavailable');
        return ports.fetchAccountProxyUsage(target, signal);
      },
      changed: (): void => {
        this.emit({ type: 'usage', usage: this.buildUsageOverview() });
        void this.accountProxyUsagePorts
          ?.publishAccountProxyStatus()
          .catch(() => undefined);
      },
    });
    this.claudeUsageFetchGate = new ClaudeUsageFetchGate({
      now: (): number => Date.now(),
      onRateLimited: ({ cooldownMs }): void => {
        logMainProcessWarn(
          '[observability] Claude usage request rate limited',
          { cooldownMs, reason: 'http_429' },
        );
      },
    });
    this.managedDelegationCapture = new ManagedDelegationCapture({
      onUpsert: (entry): void => {
        this.enqueueAuditEntry(entry);
        this.upsertRecentEntry(entry);
      },
      recordedEntry: (id): AgentAuditEntry | undefined =>
        this.recentEntries.find((entry) => entry.id === id),
      codexPricing: (): ObservabilityPricingState =>
        this.host.pricing.current(),
      nativeAccountKind: (provider): ProviderBillingAccountKind | undefined =>
        provider === 'codex' || provider === 'claude'
          ? this.host.accounts.peekBillingAccountKind(provider)
          : undefined,
    });
    // Turns can start before the service's own start finishes loading.
    this.unsubscribeAccountProxyResponses = this.host.accountProxy.onResponse(
      (response): void => {
        this.observeAccountProxyResponse(response);
      },
    );
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    // Hold plan events from the first await, while dispose() can wait.
    this.plansAwaitingCountedIds = [];
    this.storedStateLoad = this.loadStoredStateAndCountPlans();
    await this.storedStateLoad;
    await this.refreshUsageAdapters();
    this.emitSnapshot();
    this.scheduleCostHistoryRepair();
  }

  private async startHostServices(): Promise<void> {
    void this.initializeAccountProxyUsage().catch(() => undefined);
    await getClaudeSessionCostLedger()
      .load()
      .catch(() => undefined);
    let cursorEnabled = this.host.cursor.isEnabled();
    let copilotEnabled = this.host.copilot.isEnabled();
    this.unsubscribeCursorRollout = this.host.onFeatureFlagsChanged(() => {
      if (this.disposing) return;
      const enabled = this.host.cursor.isEnabled();
      if (enabled !== cursorEnabled) {
        cursorEnabled = enabled;
        if (enabled) void this.refreshCursorUsage();
        else this.invalidateCursorUsage();
      }
      const nextCopilotEnabled = this.host.copilot.isEnabled();
      if (nextCopilotEnabled !== copilotEnabled) {
        copilotEnabled = nextCopilotEnabled;
        if (copilotEnabled) void this.refreshCopilotUsage();
        else this.invalidateCopilotUsage();
      }
    });
    this.unsubscribeCopilotUsage = this.host.copilot.onUsageChanged(
      (ready): void => {
        this.invalidateCopilotUsage();
        if (ready && !this.disposing) void this.refreshCopilotUsage();
      },
    );
    this.unsubscribeOpenCodeAccounts = this.host.openCode.onAccountsChanged(
      (): void => {
        if (!this.disposing)
          this.emit({ type: 'usage', usage: this.buildUsageOverview() });
      },
    );
    this.host.pricing.prewarm();
  }

  /**
   * Loads the stored entries and counted plan ids, then counts the plan
   * events held meanwhile. `dispose()` waits for it so none are lost.
   */
  private async loadStoredStateAndCountPlans(): Promise<void> {
    try {
      await this.startHostServices();
      await this.loadRetentionDaysFromPreferences();
      const hydration = await this.loadSnapshotFromDisk();
      await this.recoverInterruptedEntries(
        hydration.recoveryCandidates,
        hydration.snapshotMtimeMs,
      );
      for (const entry of this.recentEntries) {
        this.rememberCountedPlanUsageEventIds(entry);
      }
      await this.pruneOldDayFiles();
      await this.loadCountedPlanUsageEventIds();
    } finally {
      const awaiting = this.plansAwaitingCountedIds ?? [];
      this.plansAwaitingCountedIds = null;
      // One object per turn, so two held events for it add up.
      const pinnedById = new Map<string, PlanUsageTarget>();
      for (const { event, target } of awaiting) {
        // An event no turn matched when it arrived is not counted, as before.
        if (!target) continue;
        const pinned = pinnedById.get(target.entry.id) ?? target;
        pinnedById.set(pinned.entry.id, pinned);
        this.applyPlanUsageEventToAuditEntry(event, pinned);
      }
      if (awaiting.length > 0) this.scheduleFlush();
    }
  }

  /**
   * Runs the one-time cost history repair in the background, after start-up
   * work settles. Waits for the OpenAI price list so old Codex delegations
   * are not marked repaired while still unpriced.
   */
  private scheduleCostHistoryRepair(attempt = 0): void {
    this.costHistoryRepairTimer = setTimeout((): void => {
      this.costHistoryRepairTimer = null;
      if (this.disposing) return;
      if (!this.host.pricing.current().payload) {
        if (attempt < COST_HISTORY_REPAIR_MAX_ATTEMPTS)
          this.scheduleCostHistoryRepair(attempt + 1);
        return;
      }
      const auditDir = getAgentObservabilityAuditDir();
      void runCostHistoryRepair({
        auditDir,
        transcriptIndexDir: getAgentObservabilityTranscriptIndexDir(),
        markerPath: join(dirname(auditDir), 'cost-history-repair.json'),
        codexPricing: (): ObservabilityPricingState =>
          this.host.pricing.current(),
        append: (entry): void => this.appendCostRepair(entry),
        transcriptPathFor: (entry): string | undefined =>
          entry.hasTranscript === true
            ? getAgentObservabilityTranscriptFilePath(
                buildTranscriptRequest(entry),
              )
            : undefined,
        commit: (): Promise<void> => this.commitCostRepairs(),
        isCancelled: (): boolean => this.disposing,
      }).catch((): void => {
        /* No marker is written on failure, so the next start retries. */
      });
    }, COST_HISTORY_REPAIR_DELAY_MS);
    this.costHistoryRepairTimer.unref?.();
  }

  /**
   * Applies a repaired cost only when the live entry still matches the
   * scanned snapshot, so a turn that moved on keeps its newer state.
   */
  private appendCostRepair(repaired: AgentAuditEntry): void {
    const live = this.recentEntries.find((entry) => entry.id === repaired.id);
    if (
      live !== undefined &&
      (live.status !== repaired.status ||
        live.completedAt !== repaired.completedAt ||
        (live.totalCostUsd ?? 0) !==
          (repaired.costRepair?.previousTotalCostUsd ?? 0))
    ) {
      return;
    }
    if (live === undefined) {
      this.enqueueAuditEntry(repaired);
      return;
    }
    // Take only the repaired cost fields; the live entry may hold newer
    // metadata (plan events, context) recorded while the repair ran.
    const merged: AgentAuditEntry = {
      ...live,
      ...(repaired.totalCostUsd === undefined
        ? {}
        : { totalCostUsd: repaired.totalCostUsd }),
      ...(repaired.sdkCumulativeCostUsd === undefined
        ? {}
        : { sdkCumulativeCostUsd: repaired.sdkCumulativeCostUsd }),
      ...(repaired.costDerivation === undefined
        ? {}
        : { costDerivation: repaired.costDerivation }),
      ...(repaired.modelUsage === undefined
        ? {}
        : { modelUsage: repaired.modelUsage }),
      ...(repaired.observedCost === undefined
        ? {}
        : { observedCost: repaired.observedCost }),
      ...(repaired.serviceTier === undefined
        ? {}
        : { serviceTier: repaired.serviceTier }),
      ...(repaired.costRepair === undefined
        ? {}
        : { costRepair: repaired.costRepair }),
    };
    this.enqueueAuditEntry(merged);
    this.upsertRecentEntry(merged);
  }

  private async commitCostRepairs(): Promise<void> {
    const pendingRepair = (): boolean =>
      this.pendingPersistedEntries.some(
        (entry) => entry.costRepair !== undefined,
      );
    await this.flush();
    // The first flush may only await a write that began before the repairs.
    if (pendingRepair()) await this.flush();
    if (pendingRepair()) {
      throw new Error('Cost history repair entries were not written');
    }
  }

  subscribe(
    listener: (event: AgentObservabilityUpdateEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** Current usage overview without copying the audit history. */
  getUsageOverview(): AgentUsageOverview {
    return this.buildUsageOverview();
  }

  loadSnapshot(): AgentObservabilitySnapshot {
    return { ...this.loadAuditOverview(), usage: this.buildUsageOverview() };
  }

  /** The snapshot without provider account usage, which stays host-fed. */
  loadAuditOverview(): Omit<AgentObservabilitySnapshot, 'usage'> {
    return {
      version: 1,
      historicalMode: 'forward-only',
      retentionDays: this.retentionDays,
      recentEntries: [...this.recentEntries].sort(compareEntries),
    };
  }

  async loadHistory(
    request: AgentAuditHistoryRequest,
  ): Promise<AgentAuditHistoryResponse> {
    await this.loadRetentionDaysFromPreferences();

    const limit = Math.min(200, Math.max(1, request.limit ?? 50));

    const auditDir = getAgentObservabilityAuditDir();
    let filenames: string[] = [];
    try {
      filenames = await readdir(auditDir);
    } catch {
      // No audit directory yet.
    }

    const auditDayWindow = buildAuditDayWindow(
      request.startDate,
      request.endDate,
    );
    const sortedFiles = filenames
      .filter((name) => isAuditFileInsideWindow(name, auditDayWindow))
      .sort((left, right) => right.localeCompare(left));

    const cursor = request.cursor;
    const persistedEntries = new Map<string, AgentAuditEntry>();

    for (const filename of sortedFiles) {
      try {
        const contents = await readFile(
          getAgentObservabilityAuditDayFilePath(
            filename.replace(/\.jsonl$/, ''),
          ),
          'utf8',
        );
        for (const line of contents.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            continue;
          }
          const parsed = safeJsonParse(trimmed);
          if (!parsed) {
            continue;
          }
          const entry = normalizeAuditEntry(parsed);
          if (entry && this.isEntryWithinRetention(entry)) {
            persistedEntries.set(entry.id, entry);
          }
        }
      } catch {
        // Ignore corrupt day files.
      }

      const deduped = new Map<string, AgentAuditEntry>(persistedEntries);
      for (const entry of this.recentEntries) {
        deduped.set(entry.id, entry);
      }
      const matchCount = Array.from(deduped.values()).filter((entry) =>
        matchesHistoryRequest(entry, request),
      ).length;
      const neededCount =
        cursor === undefined ? limit : limit + persistedEntries.size;
      const cursorLoaded = cursor === undefined || persistedEntries.has(cursor);
      if (matchCount >= neededCount && cursorLoaded) {
        break;
      }
    }

    const deduped = new Map<string, AgentAuditEntry>(persistedEntries);
    for (const entry of this.recentEntries) {
      deduped.set(entry.id, entry);
    }

    const filtered = Array.from(deduped.values())
      .filter((entry) => matchesHistoryRequest(entry, request))
      .sort(compareEntries);

    const startIndex =
      cursor === undefined
        ? 0
        : Math.max(0, filtered.findIndex((entry) => entry.id === cursor) + 1);
    const entries = filtered
      .slice(startIndex, startIndex + limit)
      .map((entry): AgentAuditEntry => {
        const contextWorkspaceId = resolveAuditContextWorkspaceId(entry);
        return contextWorkspaceId === undefined
          ? entry
          : { ...entry, contextWorkspaceId };
      });
    const nextCursor =
      startIndex + limit < filtered.length
        ? filtered[startIndex + limit - 1]?.id
        : undefined;

    return { entries, nextCursor };
  }

  async loadUsageTimeseries(
    request: UsageTimeseriesRequest,
  ): Promise<UsageTimeseriesResponse> {
    const dataset = request.dataset ?? { kind: 'tokens' };
    if (dataset.kind === 'tokens') {
      await this.loadRetentionDaysFromPreferences();
      const auditDir = getAgentObservabilityAuditDir();
      let filenames: string[] = [];
      try {
        filenames = await readdir(auditDir);
      } catch {
        // No audit directory yet.
      }
      const auditDayWindow = buildAuditDayWindow(
        request.startDate,
        request.endDate,
      );
      const sortedFiles = filenames
        .filter((name) => isAuditFileInsideWindow(name, auditDayWindow))
        .sort((left, right) => left.localeCompare(right));
      const entriesById = new Map<string, AgentAuditEntry>();
      for (const filename of sortedFiles) {
        try {
          const contents = await readFile(
            getAgentObservabilityAuditDayFilePath(
              filename.replace(/\.jsonl$/, ''),
            ),
            'utf8',
          );
          for (const line of contents.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            const parsed = safeJsonParse(trimmed);
            if (!parsed) continue;
            const entry = normalizeAuditEntry(parsed);
            if (
              entry &&
              this.isEntryWithinRetention(entry) &&
              isStartedAtInsideRange(
                entry.startedAt,
                request.startDate,
                request.endDate,
              )
            ) {
              entriesById.set(entry.id, entry);
            }
          }
        } catch {
          // Ignore corrupt day files.
        }
      }
      for (const entry of this.recentEntries) {
        if (this.isEntryWithinRetention(entry)) {
          entriesById.set(entry.id, entry);
        }
      }
      return {
        kind: 'tokens',
        buckets: bucketEntries(
          Array.from(entriesById.values()),
          request.bucket,
          {
            startDate: request.startDate,
            endDate: request.endDate,
          },
        ),
      };
    }

    const usageEvents = await this.loadUsageEventsInWindow(
      request.startDate,
      request.endDate,
      {
        // Token tab counts intentionally hydrate older chat-turn events that
        // predate inline usage-event token persistence.
        hydrateChatTurnTokens:
          dataset.kind === 'tab-counts' && dataset.tab === 'tokens',
        hydrateChatTurnCost:
          dataset.kind === 'tab-counts' && dataset.tab === 'cost',
      },
    );
    // The charts add the same delegation spend as the summary and table.
    const events =
      dataset.tab === 'cost' || dataset.tab === 'tokens'
        ? [
            ...usageEvents,
            ...(await this.loadManagedDelegationStatisticsEvents()),
          ]
        : usageEvents;

    if (dataset.kind === 'tab-counts') {
      return {
        kind: 'tab-counts',
        buckets: computeCountsTimeseries(
          {
            tab: dataset.tab,
            series: dataset.series,
            bucket: request.bucket,
            startDate: request.startDate,
            endDate: request.endDate,
          },
          events,
        ),
      };
    }

    return {
      kind: 'tab-distribution',
      buckets: computeDistributionTimeseries(
        {
          tab: dataset.tab,
          metric: dataset.metric,
          bucket: request.bucket,
          startDate: request.startDate,
          endDate: request.endDate,
        },
        events,
      ),
    };
  }

  private async loadUsageEventsInWindow(
    startDate?: string,
    endDate?: string,
    options: {
      hydrateChatTurnTokens?: boolean;
      hydrateChatTurnCost?: boolean;
    } = {},
  ): Promise<UsageMetricEvent[]> {
    await this.loadRetentionDaysFromPreferences();

    const usageDir = getAgentObservabilityUsageEventsDir();
    let filenames: string[] = [];
    try {
      filenames = await readdir(usageDir);
    } catch {
      const pendingById = new Map<string, UsageMetricEvent>();
      for (const event of this.pendingUsageMetricEvents) {
        upsertUsageEventById(pendingById, event);
      }
      return Array.from(pendingById.values());
    }

    const dayWindow = buildAuditDayWindow(startDate, endDate);
    const eventsById = new Map<string, UsageMetricEvent>();

    const sortedFiles = filenames
      .filter((name) => isAuditFileInsideWindow(name, dayWindow))
      .sort((left, right) => left.localeCompare(right));

    for (const filename of sortedFiles) {
      const day = filename.replace(/\.jsonl$/, '');
      try {
        const contents = await readFile(
          getAgentObservabilityUsageEventsDayFilePath(day),
          'utf8',
        );
        for (const line of contents.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const parsed = safeJsonParse(trimmed);
          const event = parsed ? normalizeUsageMetricEvent(parsed) : null;
          if (!event || !isUsageEventWithinRetention(event)) continue;
          upsertUsageEventById(eventsById, event);
        }
      } catch {
        // skip corrupt day files
      }
    }

    for (const event of this.pendingUsageMetricEvents) {
      if (isUsageEventWithinRetention(event)) {
        upsertUsageEventById(eventsById, event);
      }
    }

    if (options.hydrateChatTurnTokens || options.hydrateChatTurnCost) {
      await this.hydrateChatTurnAuditFields(eventsById, startDate, endDate, {
        tokens: options.hydrateChatTurnTokens === true,
        cost: options.hydrateChatTurnCost === true,
      });
    }

    return Array.from(eventsById.values());
  }

  private async hydrateChatTurnAuditFields(
    eventsById: Map<string, UsageMetricEvent>,
    startDate?: string,
    endDate?: string,
    fields: { tokens: boolean; cost: boolean } = { tokens: true, cost: true },
  ): Promise<void> {
    const missingAuditEntryIds = new Set<string>();
    for (const [eventId, event] of Array.from(eventsById.entries())) {
      if (
        event.type === 'chat_turn_completed' &&
        event.auditEntryId &&
        !event.tokens &&
        fields.tokens
      ) {
        const cachedTokens = this.hydratedChatTurnTokensByAuditEntryId.get(
          event.auditEntryId,
        );
        if (cachedTokens) {
          const currentEvent = eventsById.get(eventId);
          const baseEvent =
            currentEvent?.type === 'chat_turn_completed' ? currentEvent : event;
          eventsById.set(eventId, {
            ...baseEvent,
            tokens: cachedTokens,
          });
        } else {
          missingAuditEntryIds.add(event.auditEntryId);
        }
      }
      if (
        event.type === 'chat_turn_completed' &&
        event.auditEntryId &&
        event.totalCostUsd === undefined &&
        event.observedCost?.totalUsd === undefined &&
        fields.cost
      ) {
        const cachedCost = this.hydratedChatTurnCostByAuditEntryId.get(
          event.auditEntryId,
        );
        if (cachedCost !== undefined) {
          if (cachedCost !== null) {
            const currentEvent = eventsById.get(eventId);
            const baseEvent =
              currentEvent?.type === 'chat_turn_completed'
                ? currentEvent
                : event;
            eventsById.set(eventId, {
              ...baseEvent,
              totalCostUsd: cachedCost,
            });
          }
        } else {
          missingAuditEntryIds.add(event.auditEntryId);
        }
      }
    }

    if (missingAuditEntryIds.size === 0) {
      return;
    }

    const entriesById = await this.loadAuditEntriesForChatTurnHydration(
      missingAuditEntryIds,
      startDate,
      endDate,
    );
    for (const auditEntryId of Array.from(missingAuditEntryIds)) {
      const entry = entriesById.get(auditEntryId);
      if (entry) {
        this.hydratedChatTurnTokensByAuditEntryId.set(
          auditEntryId,
          entry.tokens,
        );
        this.hydratedChatTurnCostByAuditEntryId.set(
          auditEntryId,
          entry.totalCostUsd ?? entry.observedCost?.totalUsd ?? null,
        );
      }
    }

    for (const [eventId, event] of Array.from(eventsById.entries())) {
      if (
        event.type !== 'chat_turn_completed' ||
        !event.auditEntryId ||
        event.tokens ||
        !fields.tokens
      ) {
        continue;
      }
      const entry = entriesById.get(event.auditEntryId);
      if (entry) {
        eventsById.set(eventId, {
          ...event,
          tokens: entry.tokens,
        });
      }
    }

    for (const [eventId, event] of Array.from(eventsById.entries())) {
      if (
        event.type !== 'chat_turn_completed' ||
        !event.auditEntryId ||
        event.totalCostUsd !== undefined ||
        event.observedCost?.totalUsd !== undefined ||
        !fields.cost
      ) {
        continue;
      }
      const entry = entriesById.get(event.auditEntryId);
      const totalCostUsd = entry?.totalCostUsd ?? entry?.observedCost?.totalUsd;
      if (totalCostUsd !== undefined) {
        eventsById.set(eventId, {
          ...event,
          totalCostUsd,
        });
      }
    }
  }

  private async loadAuditEntriesForChatTurnHydration(
    auditEntryIds: ReadonlySet<string>,
    startDate?: string,
    endDate?: string,
  ): Promise<Map<string, AgentAuditEntry>> {
    const entriesById = new Map<string, AgentAuditEntry>();
    for (const entry of this.recentEntries) {
      if (
        auditEntryIds.has(entry.id) &&
        this.isEntryWithinRetention(entry) &&
        isStartedAtInsideRange(entry.startedAt, startDate, endDate)
      ) {
        entriesById.set(entry.id, entry);
      }
    }

    if (entriesById.size === auditEntryIds.size) {
      return entriesById;
    }

    const auditDir = getAgentObservabilityAuditDir();
    let filenames: string[] = [];
    try {
      filenames = await readdir(auditDir);
    } catch {
      return entriesById;
    }

    const auditDayWindow = buildAuditDayWindow(startDate, endDate);
    const sortedFiles = filenames
      .filter((name) => isAuditFileInsideWindow(name, auditDayWindow))
      .sort((left, right) => left.localeCompare(right));

    for (const filename of sortedFiles) {
      if (entriesById.size === auditEntryIds.size) {
        break;
      }
      const day = filename.replace(/\.jsonl$/, '');
      try {
        const contents = await readFile(
          getAgentObservabilityAuditDayFilePath(day),
          'utf8',
        );
        this.cacheManagedDelegationAuditDay(day, contents);
        for (const line of contents.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const parsed = safeJsonParse(trimmed);
          if (!parsed) continue;
          const entry = normalizeAuditEntry(parsed);
          if (
            entry &&
            auditEntryIds.has(entry.id) &&
            this.isEntryWithinRetention(entry) &&
            isStartedAtInsideRange(entry.startedAt, startDate, endDate)
          ) {
            entriesById.set(entry.id, entry);
          }
        }
      } catch {
        // Ignore corrupt day files.
      }
    }

    return entriesById;
  }

  async loadUsageMetrics(
    request: UsageMetricsRequest,
  ): Promise<UsageMetricsResponse> {
    await this.loadRetentionDaysFromPreferences();

    const usageDir = getAgentObservabilityUsageEventsDir();
    let filenames: string[] = [];
    try {
      filenames = await readdir(usageDir);
    } catch {
      // No usage-event directory yet.
    }

    const window = buildAuditDayWindow(request.startDate, request.endDate);
    const eventsById = new Map<string, UsageMetricEvent>();
    const addEvent = (event: UsageMetricEvent): void => {
      if (
        !isUsageEventWithinRetention(event) ||
        !isUsageEventInsideRange(event, request.startDate, request.endDate)
      ) {
        return;
      }
      if (!matchesUsageMetricsRequest(event, request)) {
        return;
      }
      upsertUsageEventById(eventsById, event);
    };

    const sortedFiles = filenames
      .filter((name) => isAuditFileInsideWindow(name, window))
      .sort((left, right) => left.localeCompare(right));

    for (const filename of sortedFiles) {
      const day = filename.replace(/\.jsonl$/, '');
      try {
        const contents = await readFile(
          getAgentObservabilityUsageEventsDayFilePath(day),
          'utf8',
        );
        for (const line of contents.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            continue;
          }
          const parsed = safeJsonParse(trimmed);
          const event = parsed ? normalizeUsageMetricEvent(parsed) : null;
          if (event) {
            addEvent(event);
          }
        }
      } catch {
        // Ignore corrupt or disappearing day files.
      }
    }

    for (const event of this.pendingUsageMetricEvents) {
      addEvent(event);
    }

    return buildUsageMetricsResponse(
      Array.from(eventsById.values()),
      request,
      this.retentionDays,
    );
  }

  async loadUsageTabSummary(
    request: UsageTabSummaryRequest,
  ): Promise<UsageTabSummaryResponse> {
    const usageEvents = await this.loadUsageEventsInWindow(
      undefined,
      undefined,
      {
        hydrateChatTurnTokens: request.tab === 'tokens',
        hydrateChatTurnCost: request.tab === 'cost',
      },
    );
    const events =
      request.tab === 'cost' || request.tab === 'tokens'
        ? [
            ...usageEvents,
            ...(await this.loadManagedDelegationStatisticsEvents()),
          ]
        : usageEvents;
    return computeTabSummary(request.tab, events);
  }

  async loadUsageMetricsView(
    request: UsageMetricsViewRequest,
  ): Promise<UsageMetricsViewResponse> {
    const usageEvents = await this.loadUsageEventsInWindow(
      undefined,
      undefined,
      {
        hydrateChatTurnTokens: request.tab === 'tokens',
        hydrateChatTurnCost: request.tab === 'cost',
      },
    );
    const events =
      request.tab === 'cost' || request.tab === 'tokens'
        ? [
            ...usageEvents,
            ...(await this.loadManagedDelegationStatisticsEvents()),
          ]
        : usageEvents;
    return computeMetricsView(request, events);
  }

  private async loadManagedDelegationStatisticsEvents(): Promise<
    StatisticsEvent[]
  > {
    const entriesById = new Map(this.managedDelegationAuditEntriesById);
    const auditDir = getAgentObservabilityAuditDir();
    let filenames: string[] = [];
    try {
      filenames = await readdir(auditDir);
    } catch {
      // Pending and recent entries below remain queryable without disk.
    }

    const sortedFiles = filenames
      .filter((name) => isAuditFileInsideWindow(name, {}))
      .sort((left, right) => left.localeCompare(right));
    for (const filename of sortedFiles) {
      const day = filename.replace(/\.jsonl$/, '');
      if (this.loadedManagedDelegationAuditDays.has(day)) continue;
      try {
        const contents = await readFile(
          getAgentObservabilityAuditDayFilePath(day),
          'utf8',
        );
        this.cacheManagedDelegationAuditDay(day, contents);
        this.managedDelegationAuditEntriesById.forEach((entry) => {
          if (this.isEntryWithinRetention(entry)) {
            entriesById.set(entry.id, entry);
          }
        });
      } catch {
        // Ignore corrupt or disappearing audit day files.
      }
    }

    for (const entry of this.pendingPersistedEntries) {
      if (
        entry.eventType === 'managed_delegation' &&
        this.isEntryWithinRetention(entry)
      ) {
        entriesById.set(entry.id, entry);
      }
    }
    for (const entry of this.recentEntries) {
      if (
        entry.eventType === 'managed_delegation' &&
        this.isEntryWithinRetention(entry)
      ) {
        entriesById.set(entry.id, entry);
      }
    }

    return Array.from(entriesById.values())
      .filter((entry) => this.isEntryWithinRetention(entry))
      .map((entry) => toDelegationStatisticsEvent(entry))
      .filter((event): event is NonNullable<typeof event> => event !== null);
  }

  private cacheManagedDelegationAuditDay(day: string, contents: string): void {
    const dayEntriesById = new Map<string, AgentAuditEntry>();
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = safeJsonParse(trimmed);
      const entry = parsed ? normalizeAuditEntry(parsed) : null;
      if (entry?.eventType === 'managed_delegation') {
        dayEntriesById.set(entry.id, entry);
      }
    }
    dayEntriesById.forEach((entry, id) => {
      if (!this.managedDelegationEntryIdsUpdatedInProcess.has(id)) {
        this.managedDelegationAuditEntriesById.set(id, entry);
      }
    });
    this.loadedManagedDelegationAuditDays.add(day);
  }

  async loadTranscript(
    request: AgentAuditTranscriptRequest,
  ): Promise<AgentAuditTranscriptResponse> {
    for (const openTranscript of Array.from(this.transcriptStates.values())) {
      if (
        openTranscript.request.id === request.id &&
        openTranscript.request.eventType === request.eventType &&
        openTranscript.request.startedAt === request.startedAt
      ) {
        await this.flush();
        break;
      }
    }

    const transcriptPath = getAgentObservabilityTranscriptFilePath(request);
    let contents: string;
    try {
      contents = await readFile(transcriptPath, 'utf8');
    } catch {
      return { type: 'not_available' };
    }

    const rawLines = contents.split('\n');
    const lines: string[] = [];
    let providerHint: AgentProviderType | undefined;
    let truncated = false;
    let storedBytes = Buffer.byteLength(contents, 'utf8');
    const injectedPrompts: AgentTranscriptInjectedPrompt[] = [];

    for (let index = 0; index < rawLines.length; index += 1) {
      const line = rawLines[index];
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const parsed = safeJsonParse(trimmed);
      if (!parsed) {
        continue;
      }

      if (parsed.type === 'canopy_transcript_truncated') {
        truncated = true;
        storedBytes -= Buffer.byteLength(`${trimmed}\n`, 'utf8');
        continue;
      }

      if (parsed.type === 'canopy_injected_prompt') {
        const provider = readString(parsed, 'provider');
        const kind = readString(parsed, 'kind');
        const applicationCondition = readString(
          parsed,
          'application_condition',
        );
        const text = readString(parsed, 'text');
        const validKind =
          kind === 'system_prompt_append' ||
          kind === 'plan_mode_developer_instructions' ||
          kind === 'org_memory';
        const validCondition =
          applicationCondition === 'claude_system_prompt_append_each_turn' ||
          applicationCondition === 'codex_first_turn_without_session_id' ||
          applicationCondition === 'helper_task_system_prompt' ||
          applicationCondition === 'pipeline_step_system_prompt' ||
          applicationCondition === 'plan_mode_enabled' ||
          applicationCondition === 'org_memory_enabled_for_turn';
        if (
          (provider === 'claude' ||
            provider === 'codex' ||
            provider === 'ollama' ||
            provider === 'cursor' ||
            provider === 'opencode') &&
          validKind &&
          validCondition &&
          text
        ) {
          injectedPrompts.push({
            kind,
            provider,
            applicationCondition,
            text,
          });
        }
        storedBytes -= Buffer.byteLength(`${trimmed}\n`, 'utf8');
        continue;
      }

      if (parsed.type === 'canopy_user_prompt') {
        const provider = readString(parsed, 'provider');
        if (
          provider === 'claude' ||
          provider === 'codex' ||
          provider === 'ollama' ||
          provider === 'cursor' ||
          provider === 'opencode'
        ) {
          providerHint = provider;
        }
      }

      lines.push(trimmed);
    }

    if (lines.length === 0) {
      return { type: 'not_available' };
    }

    const fallbackRecentEntry = this.recentEntries.find(
      (entry) => entry.id === request.id,
    );
    const dedupedInjectedPrompts = injectedPrompts.filter(
      (prompt, index, prompts) =>
        prompts.findIndex(
          (candidate) =>
            candidate.kind === prompt.kind &&
            candidate.provider === prompt.provider &&
            candidate.applicationCondition === prompt.applicationCondition &&
            candidate.text === prompt.text,
        ) === index,
    );
    const openTranscript = Array.from(this.transcriptStates.values()).find(
      (state) =>
        state.request.id === request.id &&
        state.request.eventType === request.eventType &&
        state.request.startedAt === request.startedAt,
    );

    return {
      type: 'success',
      lines,
      providerHint: providerHint ?? fallbackRecentEntry?.provider,
      truncation: {
        truncated,
        maxBytes: TRANSCRIPT_MAX_BYTES,
        storedBytes: Math.max(0, storedBytes),
      },
      injectedPrompts:
        dedupedInjectedPrompts.length > 0
          ? dedupedInjectedPrompts
          : (openTranscript?.injectedPrompts ?? []),
    };
  }

  /**
   * The active audit-retention window in days. Exposed so callers that build on
   * audit data (e.g. run sharing) can explain *why* a session has no entries
   * rather than reporting a bare absence.
   */
  getRetentionDays(): number {
    return this.retentionDays;
  }

  setRetentionDays(days: number): void {
    this.retentionDays = days;
    this.recentEntries = this.recentEntries.filter((entry) =>
      this.isEntryWithinRetention(entry),
    );
    this.scheduleFlush();
    void this.pruneOldDayFiles();
    this.emit({ type: 'retention', retentionDays: days });
    this.emitSnapshot();
  }

  recordAppDiagnostic(event: AppDiagnosticRecord): void {
    // `app-events/` and the error reports forwarded to PostHog are global: no
    // worktree or chat identifier may reach either, whatever the caller
    // assembled.
    const sanitized = sanitizeAppDiagnosticRecord(event);
    reportAppDiagnosticToDesktopInstrumentation(
      this.host.instrumentation,
      sanitized,
    );
    this.pendingAppDiagnostics.push(sanitized);
    this.scheduleFlush(estimatePendingRecordBytes(sanitized));
  }

  recordSessionDiagnostic(event: SessionDiagnosticRecord): void {
    const sanitizedEvent = sanitizeTurnDispatchSlowDiagnostic(event);
    this.pendingSessionDiagnostics.push(sanitizedEvent);
    this.scheduleFlush(estimatePendingRecordBytes(sanitizedEvent));
  }

  recordUsageMetricEvent(event: UsageMetricEvent): void {
    if (
      event.type === 'plan_created' ||
      event.type === 'plan_updated' ||
      event.type === 'plan_approved'
    ) {
      if (this.plansAwaitingCountedIds) {
        // Pin the turn now: a later turn may be current when it is counted.
        this.plansAwaitingCountedIds.push({
          event,
          target: this.findPlanUsageTarget(event),
        });
      } else {
        this.applyPlanUsageEventToAuditEntry(event);
      }
    }
    this.pendingUsageMetricEvents.push(event);
    this.emit({ type: 'usage', usage: this.buildUsageOverview() });
    this.scheduleFlush(estimatePendingRecordBytes(event));
  }

  private rememberCountedPlanUsageEventIds(entry: AgentAuditEntry): void {
    for (const id of entry.planEvents?.eventIds ?? []) {
      this.countedPlanUsageEventIds.add(id);
    }
  }

  /**
   * Reads the counted ids from every stored audit line, and restores plan
   * counts a stale snapshot is missing so a skipped replay loses nothing.
   */
  private async loadCountedPlanUsageEventIds(): Promise<void> {
    let filenames: string[];
    try {
      filenames = await readdir(getAgentObservabilityAuditDir());
    } catch {
      return;
    }
    const storedPlanEvents = new Map<
      string,
      NonNullable<AgentAuditEntry['planEvents']>
    >();
    for (const filename of filenames.sort()) {
      if (!filename.endsWith('.jsonl')) continue;
      let contents: string;
      try {
        contents = await readFile(
          getAgentObservabilityAuditDayFilePath(
            filename.replace(/\.jsonl$/, ''),
          ),
          'utf8',
        );
      } catch {
        continue;
      }
      for (const line of contents.split('\n')) {
        if (!line.includes('"eventIds"')) continue;
        const entry = normalizeAuditEntry(safeJsonParse(line));
        if (!entry?.planEvents) continue;
        this.rememberCountedPlanUsageEventIds(entry);
        storedPlanEvents.set(entry.id, entry.planEvents);
      }
    }
    const heldTargets = (this.plansAwaitingCountedIds ?? []).flatMap(
      ({ target }) => (target ? [target.entry] : []),
    );
    for (const entry of [...this.recentEntries, ...heldTargets]) {
      const stored = storedPlanEvents.get(entry.id);
      const storedIds = stored?.eventIds ?? [];
      const loadedIds = entry.planEvents?.eventIds ?? [];
      if (
        stored &&
        storedIds.length > loadedIds.length &&
        loadedIds.every((id) => storedIds.includes(id))
      ) {
        entry.planEvents = { ...stored, eventIds: [...storedIds] };
      }
    }
  }

  private applyPlanUsageEventToAuditEntry(
    event: PlanUsageEvent,
    pinned?: PlanUsageTarget | null,
  ): void {
    if (event.type === 'plan_updated') {
      return;
    }
    // A replay may target a newer turn than the one that counted it.
    if (this.countedPlanUsageEventIds.has(event.id)) return;

    // A pinned turn that has since left the recent entries is still counted.
    const target = pinned
      ? (this.findPlanUsageTarget({
          ...event,
          auditEntryId: pinned.entry.id,
        }) ?? { entry: pinned.entry, open: false })
      : this.findPlanUsageTarget(event);
    if (!target || !countPlanUsageEvent(target.entry, event)) return;
    this.countedPlanUsageEventIds.add(event.id);
    // Late transcript publication rewrites the turn from its own copy.
    for (const state of [
      ...Array.from(this.transcriptStates.values()),
      ...Array.from(this.retiringTranscriptStates),
    ]) {
      if (state.finalizedEntry?.id === target.entry.id) {
        state.finalizedEntry.planEvents = target.entry.planEvents;
      }
    }

    if (target.open) {
      this.upsertRecentEntry(target.entry);
      this.enqueueAuditEntry(target.entry);
    } else {
      this.enqueueAuditEntry(target.entry);
      this.upsertRecentEntry(target.entry);
    }
  }

  /** The chat turn a plan event belongs to: its explicit entry, else the current one. */
  private findPlanUsageTarget(event: PlanUsageEvent): PlanUsageTarget | null {
    const isChatTurnEntry = (entry: AgentAuditEntry): boolean =>
      entry.eventType === 'worktree_chat' ||
      entry.eventType === 'standalone_chat' ||
      entry.eventType === 'app_advisor' ||
      entry.eventType === 'pipeline_editor' ||
      entry.eventType === 'worktree_plan_chat';
    const matchesScope = (entry: AgentAuditEntry): boolean =>
      isChatTurnEntry(entry) &&
      entry.projectId === event.workspaceId &&
      entry.worktreeId === event.worktreeId &&
      entry.chatId === event.chatId;

    let matchedOpenEntry: OpenAuditEntry | undefined;
    if (event.auditEntryId) {
      matchedOpenEntry = Array.from(this.openEntries.values()).find(
        (openEntry) =>
          openEntry.entry.id === event.auditEntryId &&
          matchesScope(openEntry.entry),
      );
    } else if (event.chatId && event.worktreeId) {
      matchedOpenEntry = Array.from(this.openEntries.entries()).find(
        ([key, openEntry]) =>
          key.startsWith('chat:') && matchesScope(openEntry.entry),
      )?.[1];
    }

    const recentEntry = event.auditEntryId
      ? this.recentEntries.find(
          (entry) => entry.id === event.auditEntryId && matchesScope(entry),
        )
      : this.recentEntries.filter(matchesScope).sort(compareEntries)[0];
    if (matchedOpenEntry) return { entry: matchedOpenEntry.entry, open: true };
    return recentEntry ? { entry: recentEntry, open: false } : null;
  }

  recordCreatedPullRequest(options: {
    projectId: string;
    worktreeId: string;
    repoId?: string;
    repoLabel?: string;
    provider: AgentProviderType;
    prNumber: number;
    prUrl: string;
  }): void {
    const timestamp = new Date().toISOString();
    const repoLabel = options.repoLabel ?? repoLabelFromPrUrl(options.prUrl);
    const repoKey = options.repoId ?? repoLabel ?? 'repo';
    const entry: AgentAuditEntry = {
      id: [
        'pr-created',
        options.projectId,
        options.worktreeId,
        repoKey,
        String(options.prNumber),
        timestamp,
      ]
        .map(sanitizeEntryIdPart)
        .filter(Boolean)
        .join(':'),
      eventType: 'pr_generation',
      status: 'success',
      provider: options.provider,
      label: 'PR Created',
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      tokens: defaultTokens(),
      messageCount: 0,
      assistantMessageCount: 0,
      toolUseCount: 0,
      subAgentCount: 0,
      toolCounts: defaultToolCounts(),
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      repoId: options.repoId,
      repoLabel,
      hasTranscript: false,
    };

    this.enqueueAuditEntry(entry);
    this.upsertRecentEntry(entry);
  }

  private getOrCreateCodexSubagentChatTracker(
    key: string,
  ): CodexSubagentUsageTracker | undefined {
    const existing = this.codexSubagentUsageByChat.get(key);
    if (existing) {
      this.codexSubagentUsageByChat.delete(key);
      this.codexSubagentUsageByChat.set(key, existing);
      return existing;
    }

    while (
      this.codexSubagentUsageByChat.size >= MAX_CODEX_SUBAGENT_CHAT_STATES
    ) {
      const oldestIdleKey = Array.from(
        this.codexSubagentUsageByChat.keys(),
      ).find((candidate) => !this.openEntries.has(candidate));
      if (oldestIdleKey === undefined) return undefined;
      this.codexSubagentUsageByChat.delete(oldestIdleKey);
    }

    const tracker = new CodexSubagentUsageTracker();
    this.codexSubagentUsageByChat.set(key, tracker);
    return tracker;
  }

  private updateCodexSubagentAudit(openEntry: OpenAuditEntry): void {
    const tracker = openEntry.codexSubagentUsageTracker;
    if (!tracker) return;
    const subagents = tracker.toAuditUsages({
      serviceTier: openEntry.entry.serviceTier,
      pricingState: this.host.pricing.current(),
      allowCost: openEntry.entry.modelGatewayRouted !== true,
    });
    if (subagents.length > 0) {
      openEntry.entry.subagents = subagents;
    } else {
      delete openEntry.entry.subagents;
    }
  }

  startChatTurn(
    options: ChatTranscriptStartOptions & {
      model?: string;
      agentId?: string;
      /**
       * The selection the turn started with; pass it when it differs from
       * `model` (an Agent id, for example). Defaults to `model`, so every
       * chat entry with a model records it. Set once here; the served-model
       * overwrites of `model` never touch it.
       */
      requestedModel?: string;
      modelSource?: AgentAuditEntry['modelSource'];
      executionHarness?: AgentAuditEntry['executionHarness'];
      serviceTier?: string;
      aiCreditsRouted?: boolean;
      /**
       * The account proxy serves the turn (CAN-4020). Its billing basis stays
       * unknown until proxy accounting lands (CAN-4022).
       */
      accountProxyRouted?: boolean;
      modelRouting?: AgentAuditEntry['modelRouting'];
      /**
       * Who started the turn for analytics, when that differs from the
       * `initiationSource` that drives dispatch behavior.
       */
      turnTrigger?: UsageInitiationSource;
    },
  ): void {
    const key = `chat:${options.projectId}/${options.worktreeId}/${options.chatId}`;
    if (this.openEntries.has(key)) {
      this.finalizeOpenEntry(key, 'interrupted', 'Superseded by a new turn');
    }
    // A dispatched turn supersedes wakes whose output has not arrived.
    this.pendingAutonomousTurns.delete(key);
    // A new turn closes the last one for good.
    this.closedTurnAccountProxyResponses.delete(key);
    const providerSnapshot = this.captureProviderStartSnapshot(
      options.provider,
      options.accountProxyRouted === true,
    );

    const startedAt = new Date().toISOString();
    const isPlanExplore = options.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID;
    const eventType: AgentAuditEventType =
      options.assistantMode === 'app-advisor'
        ? 'app_advisor'
        : options.assistantMode === 'pipeline-editor'
          ? 'pipeline_editor'
          : isPlanExplore
            ? 'worktree_plan_chat'
            : options.isStandalone
              ? 'standalone_chat'
              : 'worktree_chat';
    const timestampId = `${key}:${startedAt}`;
    // Very short consecutive turns may start in the same millisecond.
    const auditId = this.recentEntries.some((entry) => entry.id === timestampId)
      ? `${timestampId}:${randomUUID()}`
      : timestampId;
    const codexSubagentUsageTracker =
      options.provider === 'codex'
        ? this.getOrCreateCodexSubagentChatTracker(key)
        : undefined;
    codexSubagentUsageTracker?.beginEntry();
    const requestedModel = options.requestedModel ?? options.model;
    const entry: AgentAuditEntry = {
      id: auditId,
      eventType,
      status: 'running',
      provider: options.provider,
      billingBasis: billingBasisAtEntryStart(
        options.provider,
        providerSnapshot.billingAccountKind,
        options.aiCreditsRouted === true,
        usedOrganizationGateway(options),
        options.accountProxyRouted === true,
      ),
      modelSource:
        options.modelSource ??
        (options.model ? getModelSource(options.model) : undefined),
      executionHarness:
        options.executionHarness ??
        (options.model
          ? getExecutionHarnessForModel(options.model)
          : options.provider === 'codex'
            ? 'codex'
            : 'claude'),
      label: labelForEventType(eventType),
      startedAt,
      ...observedModelIdentity({
        model: options.model,
        requestedModel,
        agentId: options.agentId,
      }),
      ...(requestedModel !== undefined ? { requestedModel } : {}),
      serviceTier: options.serviceTier,
      ...(options.aiCreditsRouted ? { aiCreditsRouted: true } : {}),
      ...(options.modelRouting ? { modelRouting: options.modelRouting } : {}),
      ...(usedOrganizationGateway(options) ? { modelGatewayRouted: true } : {}),
      tokens: defaultTokens(),
      messageCount: 0,
      assistantMessageCount: 0,
      toolUseCount: 0,
      subAgentCount: 0,
      hasTranscript: false,
      toolCounts: defaultToolCounts(),
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      repoId: options.repoId,
      repoLabel: options.repoLabel,
      chatId: options.chatId,
      ...(options.userMessageId
        ? { userMessageId: options.userMessageId }
        : {}),
      chatMode: options.chatMode ?? 'canopy',
      linkTarget:
        eventType === 'app_advisor'
          ? {
              page: 'main',
              kind: 'app-advisor',
              chatId: options.chatId,
            }
          : eventType === 'pipeline_editor'
            ? {
                page: 'main',
                kind: 'pipeline-editor',
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                chatId: options.chatId,
              }
            : isPlanExplore
              ? // The plan-explore chat lives inside the Explore modal under the
                // synthetic plan-explore scope, which is not a navigable
                // worktree-chat target, so it carries no Inspect link.
                undefined
              : options.isStandalone
                ? buildStandaloneChatLinkTarget(
                    options.standaloneProjectId ?? options.worktreeId,
                    options.chatId,
                  )
                : {
                    page: 'main',
                    kind: 'worktree-chat',
                    projectId: options.projectId,
                    worktreeId: options.worktreeId,
                    chatId: options.chatId,
                  },
    };

    if (codexSubagentUsageTracker) {
      const subagents = codexSubagentUsageTracker.toAuditUsages({
        serviceTier: entry.serviceTier,
        pricingState: this.host.pricing.current(),
        allowCost: entry.modelGatewayRouted !== true,
      });
      if (subagents.length > 0) entry.subagents = subagents;
    }

    if (options.sdkSessionId) {
      entry.sdkSessionId = options.sdkSessionId;
    }

    this.openEntries.set(key, {
      entry,
      providerAccountIdentity: providerSnapshot.providerAccountIdentity,
      billingAccountKind: providerSnapshot.billingAccountKind,
      ...(options.accountProxyRouted ? { accountProxyRouted: true } : {}),
      turnTrigger: options.turnTrigger ?? options.initiationSource ?? 'unknown',
      seenCodexItems: new Set<string>(),
      seenBillableToolItemIds: new Set<string>(),
      usageObserved: false,
      pendingClaudePrCreateToolUses: new Map<string, string>(),
      seenManualPrCreateKeys: new Set<string>(),
      pausedDurationMs: 0,
      seenCompactionIds: new Set<string>(),
      ...(codexSubagentUsageTracker ? { codexSubagentUsageTracker } : {}),
    });
    skillSuggestionTurnRecorder.begin(key, entry.id, options);
    if (entry.provider === 'claude') {
      this.claudeTaskTrackers.get(key)?.applyPending(entry);
    }
    this.initializeTranscriptState(key, entry);
    this.seedTranscript(key, {
      provider: options.provider,
      originalText: options.originalUserText,
      submittedText: options.submittedText,
      fileReferences: options.fileReferences,
      planMode: options.planMode,
      internalRow: options.internalRow,
      managedDelegationDeliveryId: options.managedDelegationDeliveryId,
      injectedPrompts: buildInjectedPrompts(options),
    });
    startAuditOperation(this.host, key, entry);
    this.upsertRecentEntry(entry);

    const startedUsageEvent: ChatTurnUsageEvent = {
      version: 1,
      id: `chat-turn-started:${entry.id}`,
      type: 'chat_turn_started',
      timestamp: startedAt,
      workspaceId: options.projectId,
      workspaceLabel: options.workspaceLabel,
      worktreeId: options.worktreeId,
      repoId: options.repoId,
      repoLabel: options.repoLabel,
      provider: options.provider,
      initiationSource: options.initiationSource ?? 'unknown',
      chatId: options.chatId,
      auditEntryId: entry.id,
      model: entry.model,
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
      turnStartedAt: startedAt,
    };
    this.chatTurnUsageStartsByAuditEntryId.set(entry.id, startedUsageEvent);
    this.recordUsageMetricEvent(startedUsageEvent);
  }

  /** One SDK query can span several user turns; its session totals survive teardown. */
  beginClaudeQuery(
    queryId: string,
    startedFrom?: { sessionId: string; fork: boolean },
  ): void {
    this.claudeQueryIds.add(queryId);
    getClaudeSessionCostLedger().beginQuery(
      queryId,
      startedFrom?.sessionId.trim() ? startedFrom : undefined,
    );
  }

  endClaudeQuery(queryId: string): void {
    this.claudeQueryIds.delete(queryId);
    getClaudeSessionCostLedger().endQuery(queryId);
  }

  private recordClaudeResultCost(
    key: string,
    entry: AgentAuditEntry,
    data: Record<string, unknown>,
  ): boolean {
    const sessionId = readString(data, 'session_id')?.trim();
    const totals = readClaudeRunningTotals(data);
    // Terminal-worker synthetic results have no session identity and keep
    // their existing direct-assignment accounting outside the session ledger.
    if (!sessionId || !totals) return false;
    const cost = getClaudeSessionCostLedger().recordResult(key, {
      sessionId,
      totals,
      mainLoopUsage: readClaudeMainLoopUsage(data),
      mainModel: entry.model,
    });
    entry.sdkSessionId = sessionId;
    entry.totalCostUsd = (entry.totalCostUsd ?? 0) + cost.costUsd;
    entry.sdkCumulativeCostUsd = cost.cumulativeCostUsd;
    if (entry.costDerivation !== 'estimated_unknown_baseline') {
      entry.costDerivation = cost.derivation;
    }
    const merged = new Map(
      (entry.modelUsage ?? []).map((usage) => [usage.model, { ...usage }]),
    );
    for (const usage of cost.modelUsage) {
      const previous = merged.get(usage.model);
      merged.set(
        usage.model,
        previous
          ? {
              ...usage,
              inputTokens: previous.inputTokens + usage.inputTokens,
              outputTokens: previous.outputTokens + usage.outputTokens,
              cacheReadInputTokens:
                previous.cacheReadInputTokens + usage.cacheReadInputTokens,
              cacheCreationInputTokens:
                previous.cacheCreationInputTokens +
                usage.cacheCreationInputTokens,
              webSearchRequests:
                (previous.webSearchRequests ?? 0) +
                (usage.webSearchRequests ?? 0),
              costUsd: previous.costUsd + usage.costUsd,
            }
          : { ...usage },
      );
    }
    entry.modelUsage = Array.from(merged.values());
    return true;
  }

  /** Called only after the canonical ledger has committed a correlated pickup. */
  observeSteeringInput(
    options: Pick<
      ChatTranscriptStartOptions,
      | 'projectId'
      | 'worktreeId'
      | 'chatId'
      | 'provider'
      | 'userMessageId'
      | 'originalUserText'
      | 'submittedText'
      | 'fileReferences'
      | 'planMode'
      | 'initiationSource'
      | 'internalRow'
      | 'managedDelegationDeliveryId'
    > & { startsTurn: boolean },
  ): void {
    const key = `chat:${options.projectId}/${options.worktreeId}/${options.chatId}`;
    if (!options.startsTurn) {
      // In-turn pickup extends the existing prompt stream, never its root identity.
      if (this.openEntries.has(key))
        this.seedTranscript(key, {
          provider: options.provider,
          originalText: options.originalUserText,
          submittedText: options.submittedText,
          fileReferences: options.fileReferences,
          planMode: options.planMode,
          userMessageId: options.userMessageId,
          internalRow: options.internalRow,
          managedDelegationDeliveryId: options.managedDelegationDeliveryId,
          steering: {
            startsTurn: false,
            rootUserMessageId: this.openEntries.get(key)?.entry.userMessageId,
          },
        });
      return;
    }
    const previous =
      this.openEntries.get(key)?.entry ??
      this.recentEntries.find((entry) => entry.id.startsWith(`${key}:`));
    this.startChatTurn({
      ...options,
      model: previous?.model,
      agentId: previous?.agentId,
      // An entry written before `requestedModel` existed has none, so its
      // steer inherits the served model as the requested one.
      requestedModel: previous?.requestedModel ?? previous?.model,
      modelSource: previous?.modelSource,
      executionHarness: previous?.executionHarness,
      serviceTier: previous?.serviceTier,
      aiCreditsRouted: previous?.aiCreditsRouted,
      sdkSessionId: previous?.sdkSessionId,
      isStandalone: previous?.eventType === 'standalone_chat',
      standaloneProjectId:
        previous?.linkTarget?.kind === 'standalone-chat'
          ? previous.linkTarget.projectId
          : undefined,
      assistantMode:
        previous?.eventType === 'app_advisor'
          ? 'app-advisor'
          : previous?.eventType === 'pipeline_editor'
            ? 'pipeline-editor'
            : undefined,
      repoId: previous?.repoId,
      repoLabel: previous?.repoLabel,
      chatMode: previous?.chatMode,
    });
  }

  private matchingChatAuditEntry(
    key: string,
    projectId: string,
    worktreeId: string,
    chatId: string,
    userMessageId?: string,
  ): { entry: AgentAuditEntry; openEntry?: OpenAuditEntry } | undefined {
    const openEntry = this.openEntries.get(key);
    if (
      openEntry &&
      (!userMessageId || openEntry.entry.userMessageId === userMessageId)
    ) {
      return { entry: openEntry.entry, openEntry };
    }
    const matches = this.recentEntries
      .filter(
        (entry) =>
          entry.projectId === projectId &&
          entry.worktreeId === worktreeId &&
          entry.chatId === chatId &&
          (userMessageId === undefined ||
            entry.userMessageId === userMessageId),
      )
      .sort(compareEntries);
    const entry = matches[0];
    return entry ? { entry } : undefined;
  }

  private persistCapturedFieldUpdate(
    entry: AgentAuditEntry,
    isOpen: boolean,
  ): void {
    if (!isOpen) this.enqueueAuditEntry(entry);
    this.upsertRecentEntry(entry);
  }

  private observeCanopyContextSnapshot(
    key: string,
    projectId: string,
    worktreeId: string,
    chatId: string,
    data: Record<string, unknown>,
  ): void {
    const context = normalizeAuditContextUsage(data.context);
    if (!context) return;
    const userMessageId = readString(data, 'userMessageId');
    const target = this.matchingChatAuditEntry(
      key,
      projectId,
      worktreeId,
      chatId,
      userMessageId,
    );
    if (!target) return;
    const providerEndTokens = target.openEntry?.contextEndTokens;
    const latestContext =
      providerEndTokens === undefined
        ? context
        : { ...context, endTokens: providerEndTokens };
    mergeAuditContextUsage(target.entry, latestContext);
    this.persistCapturedFieldUpdate(
      target.entry,
      target.openEntry !== undefined,
    );
  }

  private observeCanopyCompaction(
    key: string,
    projectId: string,
    worktreeId: string,
    chatId: string,
    data: Record<string, unknown>,
  ): void {
    const id = readString(data, 'id');
    const at = readString(data, 'at');
    if (!id || !at || !isValidIsoTimestamp(at)) return;
    const triggerValue = readString(data, 'trigger');
    const trigger: 'auto' | 'manual' | 'unknown' =
      triggerValue === 'auto' || triggerValue === 'manual'
        ? triggerValue
        : 'unknown';
    const rawPreTokens = readNumber(data, 'preTokens');
    const preTokens =
      rawPreTokens !== undefined &&
      Number.isSafeInteger(rawPreTokens) &&
      rawPreTokens >= 0
        ? rawPreTokens
        : undefined;
    const target = this.matchingChatAuditEntry(
      key,
      projectId,
      worktreeId,
      chatId,
    );
    if (!target) return;
    const compaction = {
      at,
      trigger,
      ...(preTokens === undefined ? {} : { preTokens }),
    };
    const seenIds = target.openEntry?.seenCompactionIds ?? new Set<string>();
    if (!recordAuditCompaction(target.entry, id, compaction, seenIds)) return;
    this.appendTranscriptRecord(key, {
      type: 'canopy_compaction',
      id,
      at,
      trigger,
      ...(preTokens === undefined ? {} : { preTokens }),
    });
    this.persistCapturedFieldUpdate(
      target.entry,
      target.openEntry !== undefined,
    );
  }

  observeChatEvent(
    projectId: string,
    worktreeId: string,
    chatId: string,
    data: unknown,
  ): void {
    const key = `chat:${projectId}/${worktreeId}/${chatId}`;
    if (!isRecord(data)) {
      return;
    }
    skillSuggestionTurnRecorder.observe(key, data);

    if (data.type === 'canopy_context_snapshot') {
      this.observeCanopyContextSnapshot(
        key,
        projectId,
        worktreeId,
        chatId,
        data,
      );
      return;
    }

    if (data.type === 'canopy_compaction') {
      this.observeCanopyCompaction(key, projectId, worktreeId, chatId, data);
      return;
    }

    if (
      data.type === 'canopy_delegation' &&
      isAgentDelegationTranscript(data.delegation)
    ) {
      const child = data.delegation;
      const ownedKey = `${key}:delegation:${child.delegationId}`;
      let owned = this.transcriptStates.get(ownedKey);
      const openParent = this.openEntries.get(key)?.entry;
      // An autonomous wake reports the previous prompt's message id as the
      // parent, so a run created after the open turn started belongs to it.
      const launchedInOpenTurn =
        openParent !== undefined &&
        child.createdAt >= Date.parse(openParent.startedAt);
      const matchedParentEntry =
        (openParent?.userMessageId === child.parentTurnId || launchedInOpenTurn
          ? openParent
          : undefined) ??
        this.recentEntries.find(
          (candidate) =>
            candidate.projectId === projectId &&
            candidate.worktreeId === worktreeId &&
            candidate.chatId === chatId &&
            candidate.userMessageId === child.parentTurnId,
        );
      // A parent id no entry records (Claude's turn id before any prompt was
      // dispatched) keeps the open-turn compatibility path.
      const parentEntry = matchedParentEntry ?? openParent;
      const ownedEntry =
        owned?.delegationRunGeneration === child.runGeneration
          ? owned.finalizedEntry
          : undefined;
      const replay = data.canopy_replay === true;
      const lineageEntry = replay
        ? (matchedParentEntry ?? owned?.finalizedEntry)
        : (ownedEntry ?? parentEntry);
      this.managedDelegationCapture.observe(
        {
          projectId,
          worktreeId,
          chatId,
          userMessageId: child.parentTurnId,
          ...(lineageEntry?.pipelineExecutionId
            ? { parentPipelineExecutionId: lineageEntry.pipelineExecutionId }
            : {}),
          ...(lineageEntry?.rootPipelineExecutionId
            ? { rootPipelineExecutionId: lineageEntry.rootPipelineExecutionId }
            : {}),
        },
        child,
      );
      // Retained snapshots can settle managed audit entries after a restart,
      // but are not live output belonging in any parent transcript.
      if (replay) return;
      const entry = ownedEntry ?? parentEntry;
      if (!entry) return;
      if (!owned || owned.delegationRunGeneration !== child.runGeneration) {
        // A retained delegation can launch another generation from a new
        // parent turn. Keep any queued old writes on their original sidecar.
        this.initializeTranscriptState(ownedKey, entry);
        owned = this.transcriptStates.get(ownedKey);
        if (!owned) return;
        owned.firstAppendSucceeded = entry.hasTranscript;
        owned.delegationRunGeneration = child.runGeneration;
      }
      owned.finalizedEntry = { ...entry };
      owned.closed = !['pending', 'running'].includes(child.snapshot.status);
      const priorItems = owned.delegationItems;
      if (owned.closed) delete owned.delegationItems;

      // Once content no longer fits the delegation share, record status only.
      const statusOnlyRecord = {
        ...data,
        delegation: { ...child, transcriptMode: 'patch', transcript: [] },
      };
      if (owned.delegationContentSuppressed) {
        if (owned.delegationStatus !== child.snapshot.status) {
          if (
            this.enqueueTranscriptRecord(
              owned,
              statusOnlyRecord,
              'delegation-status',
            )
          ) {
            owned.delegationStatus = child.snapshot.status;
          }
        }
        this.releaseClosedTranscriptState(owned);
        return;
      }

      const priorById = new Map(priorItems?.map((item) => [item.id, item]));
      const changedItems =
        priorItems && child.snapshot.status === 'running'
          ? child.transcript.filter(
              (item) =>
                !sameDelegationTranscriptItem(priorById.get(item.id), item),
            )
          : undefined;
      const persisted =
        changedItems === undefined
          ? data
          : {
              ...data,
              delegation: {
                ...child,
                transcriptMode: 'patch',
                transcript: changedItems,
              },
            };
      const statusOnly =
        changedItems === undefined
          ? child.transcriptMode === 'patch' && child.transcript.length === 0
          : changedItems.length === 0;
      const admitted = this.enqueueTranscriptRecord(
        owned,
        persisted,
        statusOnly ? 'delegation-status' : 'delegation-content',
      );
      if (admitted) {
        owned.delegationStatus = child.snapshot.status;
        if (!owned.closed && !statusOnly) {
          owned.delegationItems = child.transcript;
        }
      } else if (!owned.budget.truncated && !statusOnly) {
        owned.delegationContentSuppressed = true;
        if (owned.delegationStatus !== child.snapshot.status) {
          if (
            this.enqueueTranscriptRecord(
              owned,
              statusOnlyRecord,
              'delegation-status',
            )
          ) {
            owned.delegationStatus = child.snapshot.status;
          }
        }
      }
      this.releaseClosedTranscriptState(owned);
      return;
    }

    const idleCodexEvent =
      data.type === 'codex' && isRecord(data.event) ? data.event : undefined;
    const openEntryForCodexEvent = this.openEntries.get(key);
    if (
      idleCodexEvent &&
      isCodexSubagentEvent(idleCodexEvent) &&
      (!openEntryForCodexEvent ||
        (openEntryForCodexEvent.entry.provider !== 'codex' &&
          openEntryForCodexEvent.entry.executionHarness !== 'codex'))
    ) {
      // Native child events may arrive after a turn closes or during an
      // unrelated provider's turn. Keep them pending without reviving a chat
      // or relabeling/mutating that provider's audit entry.
      this.observeIdleCodexSubagentEvent(key, idleCodexEvent);
      return;
    }

    if (!this.openEntries.has(key)) {
      if (!this.turnStateAudit) {
        if (isRootAgentContinuationEvent(data)) this.reviveChatTurn(key);
      } else if (isRootAgentContinuationEvent(data)) {
        this.openAutonomousTurnEntry(key);
      } else if (
        data.type !== 'codex' &&
        isTerminalChatEventData(data) &&
        this.pendingAutonomousTurns.get(key)?.[0]?.ended === true
      ) {
        // A turn that ended with no root output still sends its terminal.
        this.pendingAutonomousTurns.get(key)?.shift();
      }
    }

    const openEntry = this.openEntries.get(key);
    if (!openEntry) {
      // A late Claude child frame never reopens a completed entry, but its
      // output still belongs in that entry's transcript.
      if (isClaudeChildFrame(data))
        void this.appendFinalizedChatTranscriptRecord(
          projectId,
          worktreeId,
          chatId,
          data,
        ).catch((): void => undefined);
      const previous = this.recentEntries.find((entry) =>
        entry.id.startsWith(`${key}:`),
      );
      if (
        (previous?.provider === 'claude' || this.claudeQueryIds.has(key)) &&
        (data.type === 'system' || data.type === 'conversation_reset')
      ) {
        this.observeClaudeEvent(key, data, 'claude');
      }
      return;
    }
    const provider = openEntry.entry.provider;

    openEntry.failureEvidence ??= new ChatTurnFailureEvidence();
    openEntry.failureEvidence.observe(
      data,
      openEntry.entry.sdkSessionId ||
        openEntry.codexActiveProviderTurn?.threadId ||
        undefined,
    );

    // Provider-agnostic and ahead of the provider dispatch, because a
    // structured auth failure is Canopy's own event: it matches neither
    // `isClaudeEventShape` nor `isCodexEventShape` nor the normalized `error`
    // branch below, so without this it was dropped here and the web Portal —
    // which reconstructs a shared run from this sidecar's JSONL — could never
    // replay one, whatever `parseAgentTranscriptLines` allowlists (CAN-1814).
    // Deliberately scoped to this one type so nothing else changes shape.
    if (data.type === CANOPY_AUTH_FAILURE_EVENT_TYPE) {
      this.appendTranscriptRecord(key, data);
      return;
    }

    // Where the account proxy moved the chat to another account (CAN-4021):
    // kept in the sidecar so a replayed transcript shows the line too.
    if (data.type === CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE) {
      this.appendTranscriptRecord(key, data);
      return;
    }

    // Keep actual Claude launch skips in sidecar replays without recording
    // plugin paths or admission digests.
    if (data.type === CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE) {
      this.appendTranscriptRecord(key, data);
      return;
    }

    if (provider === 'claude' && data.type === 'rate_limit_event') {
      this.observeClaudeRateLimitEvent(key, data);
      return;
    }

    if (
      (provider === 'claude' || provider === 'ollama') &&
      isClaudeEventShape(data)
    ) {
      this.appendTranscriptRecord(key, data);
      this.observeClaudeEvent(key, data, provider);
      return;
    }

    if (provider === 'claude' || provider === 'ollama') {
      return;
    }

    // Codex emits this Canopy-owned compatibility envelope when the runtime
    // fails before (or instead of) a native turn.failed event. Preserve only
    // the validated failure shape so transcript replayers can surface the
    // durable error without widening the Codex sidecar allowlist.
    if (provider === 'codex' && isSyntheticCodexErrorResult(data)) {
      this.appendTranscriptRecord(key, data);
      return;
    }

    if (
      provider === 'cursor' ||
      provider === 'copilot' ||
      provider === 'antigravity' ||
      provider === 'opencode'
    ) {
      if (data.type === 'canopy_cursor_usage') {
        const reported = parseCursorReportedUsage(data.usage);
        if (data.usage === null || reported) {
          this.appendTranscriptRecord(key, {
            type: 'canopy_cursor_usage',
            provider: 'cursor',
            usage: reported ?? null,
          });
        }
        return;
      }
      if (data.type === 'canopy_assistant_patch') {
        if (data.provider === provider && isAssistantPatch(data)) {
          this.appendTranscriptRecord(key, data);
          if (data.role !== 'system') this.observeCursorPatch(openEntry, data);
        }
        return;
      }
      if (data.type === 'result') {
        if (
          typeof data.is_error === 'boolean' &&
          typeof data.result === 'string'
        ) {
          this.appendTranscriptRecord(key, data);
          if (provider === 'copilot' || provider === 'opencode')
            this.observeClaudeEvent(key, data, provider);
        }
        return;
      }
      // Cursor shares only the normalized session-init and error paths below.
      if (data.type !== 'system' && data.type !== 'error') return;
    }

    if (data.type === 'codex' && isRecord(data.event)) {
      this.appendTranscriptRecord(key, data.event);
      return;
    }

    if (data.type === 'system' && data.subtype === 'init') {
      const sessionId = readString(data, 'session_id');
      if (sessionId) {
        openEntry.entry.sdkSessionId = sessionId;
        this.upsertRecentEntry(openEntry.entry);
      }
      return;
    }

    if (data.type === 'error') {
      const message = readString(data, 'error') ?? readString(data, 'message');
      if (!message) {
        return;
      }

      const normalizedEvent: Record<string, unknown> = {
        type: 'error',
        message,
        ...(provider === 'cursor' ||
        provider === 'copilot' ||
        provider === 'antigravity' ||
        provider === 'opencode'
          ? { provider, error: message }
          : {}),
      };
      this.appendTranscriptRecord(key, normalizedEvent);
    }
  }

  private recordManualPrGenerationFromCommand(
    openEntry: OpenAuditEntry,
    commandKey: string,
    command: string,
    output: string,
    exitCode?: number,
  ): void {
    if (!commandLooksLikePrCreate(command)) {
      return;
    }
    if (typeof exitCode === 'number' && exitCode !== 0) {
      return;
    }

    const pr = extractGitHubPrUrl(output);
    if (!pr) {
      return;
    }

    const dedupeKey = pr.prUrl || commandKey;
    if (openEntry.seenManualPrCreateKeys.has(dedupeKey)) {
      return;
    }
    openEntry.seenManualPrCreateKeys.add(dedupeKey);

    const sourceEntry = openEntry.entry;
    const timestamp = new Date().toISOString();
    const repoLabel = sourceEntry.repoLabel ?? repoLabelFromPrUrl(pr.prUrl);
    const entry: AgentAuditEntry = {
      // Build a bounded id from the stable, short PR number rather than the
      // slugified full PR URL. `sourceEntry.id` is already long, and appending a
      // ~100-char URL slug pushed the result past the 128-char telemetry
      // `clientTurnId` limit. A bare PR number is not unique across repos
      // (different repos in the same worktree routinely share PR numbers), so we
      // also include the short `repoLabel` (owner/repo) to avoid cross-repo
      // collisions when two repos produce a PR in the same chat turn from the
      // same `sourceEntry`. When `repoLabel` is unavailable we fall back to the
      // full PR URL, which is unique per repo; the mapping-layer `clampId`
      // remains the bounding safety net. `seenManualPrCreateKeys` still keys on
      // the full `dedupeKey` for dedupe fidelity.
      id: `${sourceEntry.id}:manual-pr:${repoLabel ?? pr.prUrl}:${pr.prNumber}`,
      eventType: 'pr_generation',
      status: 'success',
      provider: sourceEntry.provider,
      label: 'PR Created',
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      model: sourceEntry.model,
      ...(sourceEntry.agentId ? { agentId: sourceEntry.agentId } : {}),
      tokens: defaultTokens(),
      messageCount: 0,
      assistantMessageCount: 0,
      toolUseCount: 0,
      subAgentCount: 0,
      toolCounts: defaultToolCounts(),
      projectId: sourceEntry.projectId,
      worktreeId: sourceEntry.worktreeId,
      repoId: sourceEntry.repoId,
      repoLabel,
      chatId: sourceEntry.chatId,
      sdkSessionId: sourceEntry.sdkSessionId,
      hasTranscript: false,
      linkTarget:
        sourceEntry.projectId && sourceEntry.worktreeId && sourceEntry.chatId
          ? {
              page: 'main',
              kind: 'worktree-chat',
              projectId: sourceEntry.projectId,
              worktreeId: sourceEntry.worktreeId,
              chatId: sourceEntry.chatId,
            }
          : undefined,
    };

    this.enqueueAuditEntry(entry);
    this.upsertRecentEntry(entry);
  }

  private observeCursorPatch(
    openEntry: OpenAuditEntry,
    data: Record<string, unknown>,
  ): void {
    const messageId = readString(data, 'messageId');
    const revision = readNumber(data, 'revision');
    if (!messageId || revision === undefined) return;
    const messages = (openEntry.cursorMessages ??= new Map<
      string,
      CursorAuditMessage
    >());
    let message = messages.get(messageId);
    if (!message) {
      message = {
        revision: 0,
        counted: false,
        blocks: new Map(),
        toolUseIds: new Set(),
      };
      messages.set(messageId, message);
    }
    if (revision <= message.revision) return;
    message.revision = revision;
    let changed = false;
    for (const patch of readArray(data, 'patches') ?? []) {
      if (!isRecord(patch)) continue;
      const index = readNumber(patch, 'index');
      if (index === undefined) continue;
      const block = readRecord(patch, 'block');
      if (block && !message.counted) {
        message.counted = true;
        openEntry.entry.assistantMessageCount += 1;
        changed = true;
      }
      const type = block ? readString(block, 'type') : undefined;
      if (type === 'text' || type === 'thinking') {
        if (message.blocks.get(index)?.type !== type)
          message.blocks.set(index, { type, counted: false });
      } else if (block) {
        message.blocks.delete(index);
        const toolUseId = readString(block, 'toolUseId');
        if (
          type === 'tool_use' &&
          toolUseId &&
          !message.toolUseIds.has(toolUseId)
        ) {
          message.toolUseIds.add(toolUseId);
          const display = readRecord(block, 'display') ?? block;
          this.countToolUse(
            openEntry.entry,
            readString(display, 'toolName') ?? 'unknown',
            readString(display, 'input') ?? '',
          );
          changed = true;
        }
      }
      const tracked = message.blocks.get(index);
      const text =
        (block ? readString(block, 'text') : readString(patch, 'appendText')) ??
        '';
      if (
        tracked &&
        !tracked.counted &&
        (tracked.type === 'thinking' ? text.trim().length > 0 : text.length > 0)
      ) {
        tracked.counted = true;
        if (tracked.type === 'text') openEntry.entry.messageCount += 1;
        else openEntry.entry.toolCounts.thinking += 1;
        changed = true;
      }
    }
    if (changed) this.upsertRecentEntry(openEntry.entry);
  }

  observeClaudeEvent(
    key: string,
    data: Record<string, unknown>,
    provider: 'claude' | 'ollama' | 'copilot' | 'opencode' | 'antigravity',
  ): void {
    const openEntry = this.openEntries.get(key);
    if (provider === 'claude' && data.type === 'conversation_reset') {
      getClaudeSessionCostLedger().noteConversationReset(key);
    }
    if (provider === 'claude' && data.type === 'system') {
      const subtype = readString(data, 'subtype');
      if (
        subtype === 'task_started' ||
        subtype === 'task_progress' ||
        subtype === 'task_notification'
      ) {
        let tracker = this.claudeTaskTrackers.get(key);
        if (!tracker) {
          tracker = new ClaudeTaskUsageTracker();
          this.claudeTaskTrackers.set(key, tracker);
          if (this.claudeTaskTrackers.size > 256) {
            const oldest = this.claudeTaskTrackers.keys().next().value;
            if (oldest !== undefined) this.claudeTaskTrackers.delete(oldest);
          }
        }
        if (
          tracker.observe(openEntry?.entry, data) &&
          openEntry &&
          subtype === 'task_notification'
        ) {
          this.enqueueAuditEntry(openEntry.entry, 'subagent_ended');
        }
      }
    }
    if (!openEntry) {
      return;
    }

    openEntry.entry.provider = provider;

    switch (data.type) {
      case 'system': {
        const sessionId = readString(data, 'session_id');
        if (sessionId) {
          openEntry.entry.sdkSessionId = sessionId;
        }
        if (readString(data, 'subtype') === 'compact_boundary') {
          const metadata = isRecord(data.compact_metadata)
            ? data.compact_metadata
            : {};
          const triggerValue =
            readString(metadata, 'trigger') ?? readString(metadata, 'reason');
          const trigger =
            triggerValue === 'auto' || triggerValue === 'manual'
              ? triggerValue
              : 'unknown';
          const atCandidate = readString(data, 'timestamp');
          const at =
            atCandidate && isValidIsoTimestamp(atCandidate)
              ? atCandidate
              : new Date().toISOString();
          const rawPreTokens =
            readNumber(metadata, 'pre_tokens') ??
            readNumber(metadata, 'preTokens');
          const preTokens =
            rawPreTokens !== undefined &&
            Number.isSafeInteger(rawPreTokens) &&
            rawPreTokens >= 0
              ? rawPreTokens
              : undefined;
          const eventId =
            readString(data, 'uuid') ??
            `claude-compact:${openEntry.entry.id}:${at}`;
          if (
            recordAuditCompaction(
              openEntry.entry,
              eventId,
              {
                at,
                trigger,
                ...(preTokens === undefined ? {} : { preTokens }),
              },
              openEntry.seenCompactionIds,
            )
          ) {
            this.upsertRecentEntry(openEntry.entry);
          }
        }
        break;
      }
      case 'assistant': {
        const message = isRecord(data.message) ? data.message : null;
        const content = Array.isArray(message?.content) ? message.content : [];
        const parentToolUseId = readString(data, 'parent_tool_use_id');
        const messageModel = message ? readString(message, 'model') : undefined;
        if (
          provider === 'claude' &&
          !parentToolUseId &&
          message &&
          isRecord(message.usage)
        ) {
          const endTokens = claudeContextEndTokens(message.usage);
          if (endTokens !== undefined) {
            openEntry.contextEndTokens = endTokens;
          }
        }
        if (content.length === 0) {
          break;
        }

        openEntry.entry.assistantMessageCount += 1;
        const model = messageModel;
        if (model && model !== CLAUDE_SYNTHETIC_MODEL_SENTINEL) {
          openEntry.entry.model = model;
        }

        for (const contentBlock of content) {
          if (!isRecord(contentBlock)) {
            continue;
          }
          const blockType = readString(contentBlock, 'type');
          if (blockType === 'text' && readString(contentBlock, 'text')) {
            openEntry.entry.messageCount += 1;
            continue;
          }
          if (
            blockType === 'thinking' &&
            (readString(contentBlock, 'thinking') ?? '').trim().length > 0
          ) {
            openEntry.entry.toolCounts.thinking += 1;
            continue;
          }
          if (blockType === 'tool_use') {
            const toolName = readString(contentBlock, 'name') ?? 'unknown';
            const inputValue = contentBlock.input;
            const input =
              typeof inputValue === 'string'
                ? inputValue
                : JSON.stringify(inputValue ?? {});
            this.countToolUse(openEntry.entry, toolName, input);
            const commandText = isRecord(inputValue)
              ? readString(inputValue, 'command')
              : input;
            const toolUseId = readString(contentBlock, 'id');
            if (
              toolUseId &&
              (toolName === 'Bash' ||
                toolName === 'bash' ||
                // Windows Claude sessions expose `PowerShell` in place of
                // `Bash`; `gh pr create` looks the same either way.
                toolName === 'PowerShell') &&
              commandText &&
              commandLooksLikePrCreate(commandText)
            ) {
              openEntry.pendingClaudePrCreateToolUses.set(
                toolUseId,
                commandText,
              );
            }
          }
        }
        break;
      }
      case 'user': {
        const message = isRecord(data.message) ? data.message : data;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const contentBlock of content) {
          if (!isRecord(contentBlock)) {
            continue;
          }
          if (readString(contentBlock, 'type') !== 'tool_result') {
            continue;
          }
          const toolUseId = readString(contentBlock, 'tool_use_id');
          if (!toolUseId) {
            continue;
          }
          const command =
            openEntry.pendingClaudePrCreateToolUses.get(toolUseId);
          if (!command) {
            continue;
          }
          if (readBoolean(contentBlock, 'is_error') === true) {
            openEntry.pendingClaudePrCreateToolUses.delete(toolUseId);
            continue;
          }
          this.recordManualPrGenerationFromCommand(
            openEntry,
            toolUseId,
            command,
            collectText(contentBlock.content ?? contentBlock),
          );
          openEntry.pendingClaudePrCreateToolUses.delete(toolUseId);
        }
        break;
      }
      case 'result': {
        const usage = isRecord(data.usage) ? data.usage : null;
        const accumulateUsage =
          provider === 'claude' &&
          Boolean(readString(data, 'session_id')?.trim());
        if (usage) {
          openEntry.entry.tokens.input =
            (accumulateUsage ? openEntry.entry.tokens.input : 0) +
            (readNumber(usage, 'input_tokens') ?? 0);
          openEntry.entry.tokens.output =
            (accumulateUsage ? openEntry.entry.tokens.output : 0) +
            (readNumber(usage, 'output_tokens') ?? 0);
          openEntry.entry.tokens.cacheReadInputTokens =
            (accumulateUsage
              ? openEntry.entry.tokens.cacheReadInputTokens
              : 0) + (readNumber(usage, 'cache_read_input_tokens') ?? 0);
          openEntry.entry.tokens.cacheCreationInputTokens =
            (accumulateUsage
              ? openEntry.entry.tokens.cacheCreationInputTokens
              : 0) + (readNumber(usage, 'cache_creation_input_tokens') ?? 0);
          const contextWindowTokens =
            readNumber(usage, 'context_window') ??
            readNumber(data, 'context_window');
          if (
            provider === 'claude' &&
            openEntry.contextEndTokens !== undefined &&
            contextWindowTokens !== undefined
          ) {
            const context = normalizeAuditContextUsage({
              endTokens: openEntry.contextEndTokens,
              windowTokens: contextWindowTokens,
            });
            if (context) mergeAuditContextUsage(openEntry.entry, context);
          }
        }
        if (provider === 'antigravity' && usage) {
          // The native turn reports reasoning as a subset of output, and its
          // counters are per prompt. Keep the provider and do not add it twice.
          openEntry.entry.tokens.reasoningOutputTokens = readNumber(
            usage,
            'reasoning_tokens',
          );
        }
        const recorded =
          provider === 'claude' &&
          this.recordClaudeResultCost(key, openEntry.entry, data);
        const totalCostUsd = readNumber(data, 'total_cost_usd');
        if (!recorded && typeof totalCostUsd === 'number') {
          openEntry.entry.totalCostUsd = totalCostUsd;
        }
        const durationMs = readNumber(data, 'duration_ms');
        if (typeof durationMs === 'number') {
          openEntry.entry.durationMs = durationMs;
        }
        break;
      }
      default:
        break;
    }

    this.upsertRecentEntry(openEntry.entry);
  }

  private observeCodexThreadEvent(
    openEntry: OpenAuditEntry,
    event: Record<string, unknown>,
  ): void {
    const threadId = readString(event, 'thread_id');
    if (isCodexSubagentThreadStarted(event)) {
      openEntry.codexSubagentUsageTracker?.observeThreadStarted(event);
      this.updateCodexSubagentAudit(openEntry);
      return;
    }
    if (threadId && !openEntry.entry.sdkSessionId) {
      openEntry.entry.sdkSessionId = threadId;
    }
  }

  private formatCodexFileChangeLines(item: Record<string, unknown>): string {
    if (!Array.isArray(item.changes)) {
      return '';
    }
    return item.changes
      .map((changeValue) => {
        if (!isRecord(changeValue)) {
          return '';
        }
        const kind = readString(changeValue, 'kind') ?? 'edit';
        const pathValue = readString(changeValue, 'path') ?? '';
        return `${kind}: ${pathValue}`;
      })
      .filter((line) => line.length > 0)
      .join('\n');
  }

  private observeCodexStartedItem(
    openEntry: OpenAuditEntry,
    item: Record<string, unknown>,
  ): void {
    const itemId = readString(item, 'id') ?? '';
    if (itemId.length > 0 && openEntry.seenCodexItems.has(itemId)) {
      return;
    }

    const itemType = readString(item, 'type') ?? '';
    if (itemType === 'command_execution') {
      openEntry.seenCodexItems.add(itemId);
      this.countToolUse(
        openEntry.entry,
        'command',
        readString(item, 'command') ?? '',
      );
      return;
    }
    if (itemType === 'web_search') {
      openEntry.seenCodexItems.add(itemId);
      this.countToolUse(
        openEntry.entry,
        'web_search',
        readString(item, 'query') ?? '',
      );
      return;
    }
    if (itemType === 'file_change') {
      openEntry.seenCodexItems.add(itemId);
      this.countToolUse(
        openEntry.entry,
        'file_change',
        this.formatCodexFileChangeLines(item),
      );
      return;
    }
    if (itemType === 'dynamic_tool_call' || itemType === 'dynamicToolCall') {
      openEntry.seenCodexItems.add(itemId);
      this.countToolUse(
        openEntry.entry,
        readString(item, 'tool') ?? 'unknown',
        JSON.stringify(item.arguments ?? {}),
      );
      return;
    }
    if (itemType === 'collab_agent_tool_call') {
      openEntry.seenCodexItems.add(itemId);
      if (readString(item, 'tool') === 'spawnAgent') {
        openEntry.entry.toolUseCount += 1;
        openEntry.entry.subAgentCount += 1;
        openEntry.entry.toolCounts.agent += 1;
        openEntry.codexSubagentUsageTracker?.observeSpawnItem(item);
        this.updateCodexSubagentAudit(openEntry);
      }
    }
  }

  private observeCodexCompletedItem(
    openEntry: OpenAuditEntry,
    item: Record<string, unknown>,
    event: Record<string, unknown>,
    options: { billableHostedTools?: boolean } = {},
  ): void {
    const itemId = readString(item, 'id') ?? '';
    const itemType = readString(item, 'type') ?? '';
    if (
      itemType === 'collab_agent_tool_call' &&
      readString(item, 'tool') === 'spawnAgent'
    ) {
      // Receiver ids and the requested model can arrive only on completion.
      // Counters stay with item.started; this records child metadata only.
      openEntry.codexSubagentUsageTracker?.observeSpawnItem(item);
      this.updateCodexSubagentAudit(openEntry);
      return;
    }
    if (itemType === 'context_compaction') {
      if (!itemId) return;
      const sessionId =
        readString(event, 'thread_id') ??
        openEntry.entry.sdkSessionId ??
        'unknown';
      const atCandidate =
        readString(event, 'timestamp') ?? readString(event, 'completed_at');
      const at =
        atCandidate && isValidIsoTimestamp(atCandidate)
          ? atCandidate
          : new Date().toISOString();
      const rawPreTokens =
        readNumber(item, 'pre_tokens') ?? readNumber(item, 'preTokens');
      const preTokens =
        rawPreTokens !== undefined &&
        Number.isSafeInteger(rawPreTokens) &&
        rawPreTokens >= 0
          ? rawPreTokens
          : undefined;
      if (
        recordAuditCompaction(
          openEntry.entry,
          `codex-context-compaction:${sessionId}:${itemId}`,
          {
            at,
            trigger: 'unknown',
            ...(preTokens === undefined ? {} : { preTokens }),
          },
          openEntry.seenCompactionIds,
        )
      ) {
        this.upsertRecentEntry(openEntry.entry);
      }
      return;
    }
    if (itemType === 'web_search' && itemId.length > 0) {
      if (
        options.billableHostedTools === true &&
        !openEntry.seenBillableToolItemIds.has(itemId)
      ) {
        openEntry.seenBillableToolItemIds.add(itemId);
        openEntry.entry.billableToolCounts = {
          ...openEntry.entry.billableToolCounts,
          openAiWebSearchCalls:
            (openEntry.entry.billableToolCounts?.openAiWebSearchCalls ?? 0) + 1,
        };
      }
      return;
    }
    if (
      itemId.length > 0 &&
      openEntry.seenCodexItems.has(itemId) &&
      (itemType === 'agent_message' || itemType === 'reasoning')
    ) {
      return;
    }

    if (itemType === 'agent_message' || itemType === 'plan') {
      if (itemId.length > 0) {
        openEntry.seenCodexItems.add(itemId);
      }
      const text = readString(item, 'text') ?? '';
      if (text.trim().length > 0) {
        openEntry.entry.assistantMessageCount += 1;
        openEntry.entry.messageCount += 1;
      }
      return;
    }
    if (itemType === 'command_execution') {
      this.recordManualPrGenerationFromCommand(
        openEntry,
        itemId || readString(item, 'command') || 'codex-command',
        readString(item, 'command') ?? '',
        readString(item, 'aggregated_output') ?? '',
        readNumber(item, 'exit_code'),
      );
      return;
    }
    if (itemType === 'reasoning') {
      if (itemId.length > 0) {
        openEntry.seenCodexItems.add(itemId);
      }
      const text = readString(item, 'text') ?? '';
      if (text.trim().length > 0) {
        openEntry.entry.toolCounts.thinking += 1;
      }
    }
  }

  private observeCodexItemEvent(
    openEntry: OpenAuditEntry,
    event: Record<string, unknown>,
  ): void {
    const item = isRecord(event.item) ? event.item : null;
    if (!item) {
      return;
    }
    if (event.type === 'item.started') {
      this.observeCodexStartedItem(openEntry, item);
      return;
    }
    this.observeCodexCompletedItem(openEntry, item, event, {
      billableHostedTools: event.type === 'item.completed',
    });
  }

  private observeCodexPlanDelta(
    openEntry: OpenAuditEntry,
    event: Record<string, unknown>,
  ): void {
    if ((readString(event, 'text') ?? '').trim().length > 0) {
      openEntry.entry.assistantMessageCount = Math.max(
        1,
        openEntry.entry.assistantMessageCount,
      );
    }
  }

  /**
   * Live token accounting from streamed `thread.token_usage.updated` records
   * (the pipeline runners project these from raw app-server notifications).
   *
   * Codex `tokenUsage.last` is one upstream response completion, while
   * `tokenUsage.total` is a cumulative thread snapshot. A provider turn can
   * contain several responses, and one audit entry can contain several turns,
   * so audit totals advance by the cumulative snapshot delta. A cumulative
   * reset starts a new epoch and contributes the latest response once.
   *
   * Older projected records without cumulative fields retain the turn-keyed
   * replacement behavior as a compatibility fallback.
   */
  private observeCodexTokenUsage(
    openEntry: OpenAuditEntry,
    event: Record<string, unknown>,
  ): void {
    const threadId =
      readString(event, 'thread_id') ?? readString(event, 'threadId') ?? '';
    const turnId = readCodexEventTurnId(event) ?? '';
    const activeTurn = openEntry.codexActiveProviderTurn;
    if (
      !activeTurn ||
      activeTurn.threadId !== threadId ||
      activeTurn.turnId !== turnId
    ) {
      return;
    }
    const usage = isRecord(event.usage) ? event.usage : null;
    if (!usage) {
      return;
    }
    const contextTokens = readNumber(usage, 'context_tokens');
    const contextWindowTokens = readNumber(usage, 'context_window');
    if (contextTokens !== undefined && contextWindowTokens !== undefined) {
      const context = normalizeAuditContextUsage({
        endTokens: contextTokens,
        windowTokens: contextWindowTokens,
      });
      if (context) {
        openEntry.contextEndTokens = context.endTokens;
        mergeAuditContextUsage(openEntry.entry, context);
      }
    }
    const latestUsage: CodexTurnTokenUsage = {
      inputTokens: readNumber(usage, 'input_tokens'),
      outputTokens: readNumber(usage, 'output_tokens'),
      cacheReadInputTokens: readNumber(usage, 'cached_input_tokens'),
      reasoningOutputTokens: readNumber(usage, 'reasoning_output_tokens'),
    };
    const cumulativeUsage: CodexTurnTokenUsage = {
      inputTokens: readNumber(usage, 'cumulative_input_tokens'),
      outputTokens: readNumber(usage, 'cumulative_output_tokens'),
      cacheReadInputTokens: readNumber(usage, 'cumulative_cached_input_tokens'),
      reasoningOutputTokens: readNumber(
        usage,
        'cumulative_reasoning_output_tokens',
      ),
    };
    if (
      !hasCodexTokenUsage(latestUsage) &&
      !hasCodexTokenUsage(cumulativeUsage)
    ) {
      return;
    }

    if (hasCodexTokenUsage(cumulativeUsage)) {
      const cumulativeByThread = (openEntry.codexCumulativeTokenUsage ??=
        new Map<string, CodexTurnTokenUsage>());
      const previous = cumulativeByThread.get(threadId);
      const increment = previous
        ? (codexCumulativeTokenUsageDelta(cumulativeUsage, previous) ??
          latestUsage)
        : hasCodexTokenUsage(latestUsage)
          ? latestUsage
          : cumulativeUsage;
      // OpenAI bills the long-context rate per request: `latestUsage` is this
      // one request, so its input decides where its tokens go. The split only
      // starts on an entry with no earlier usage, so it covers every request.
      const firstRequest =
        openEntry.codexLongContextTokens === undefined &&
        openEntry.entry.tokens.input === 0 &&
        openEntry.entry.tokens.output === 0;
      if (firstRequest) openEntry.codexLongContextTokens = {};
      const threshold = codexLongContextThreshold(
        openEntry.entry.model,
        this.host.pricing.current(),
      );
      if (openEntry.codexLongContextTokens !== undefined) {
        if (threshold === undefined) {
          // Pricing isn't loaded (or the model has no rule), so this request
          // can't be classified: an incomplete split must not be trusted, and
          // pricing falls back to the summed input.
          delete openEntry.codexLongContextTokens;
        } else if ((latestUsage.inputTokens ?? 0) > threshold) {
          if (firstRequest) openEntry.codexFirstRequestLongContext = true;
          openEntry.codexLongContextTokens = addCodexTokenUsage(
            openEntry.codexLongContextTokens,
            increment,
          );
        }
      }
      const updated = addCodexTokenUsage(
        {
          inputTokens: openEntry.entry.tokens.input,
          outputTokens: openEntry.entry.tokens.output,
          cacheReadInputTokens: openEntry.entry.tokens.cacheReadInputTokens,
          reasoningOutputTokens: openEntry.entry.tokens.reasoningOutputTokens,
        },
        increment,
      );
      openEntry.entry.tokens.input = updated.inputTokens ?? 0;
      openEntry.entry.tokens.output = updated.outputTokens ?? 0;
      openEntry.entry.tokens.cacheReadInputTokens =
        updated.cacheReadInputTokens ?? 0;
      openEntry.entry.tokens.reasoningOutputTokens =
        updated.reasoningOutputTokens ?? 0;
      openEntry.entry.tokens.cacheCreationInputTokens = 0;
      cumulativeByThread.set(threadId, cumulativeUsage);
      (openEntry.codexCumulativeUsageTurnIds ??= new Set<string>()).add(turnId);
      openEntry.usageObserved = true;
      return;
    }

    this.observeCodexFallbackTurnUsage(openEntry, event, latestUsage);
  }

  private observeCodexFallbackTurnUsage(
    openEntry: OpenAuditEntry,
    event: Record<string, unknown>,
    usage: CodexTurnTokenUsage,
  ): void {
    if (!hasCodexTokenUsage(usage)) {
      return;
    }
    // Usage records without an id share one compatibility bucket, preserving
    // the historical single-turn overwrite behavior.
    const turnId = readCodexEventTurnId(event) ?? '';
    const perTurnUsage = (openEntry.codexTurnTokenUsage ??= new Map<
      string,
      CodexTurnTokenUsage
    >());
    const previous = perTurnUsage.get(turnId);
    const updated = {
      inputTokens: usage.inputTokens ?? previous?.inputTokens,
      outputTokens: usage.outputTokens ?? previous?.outputTokens,
      cacheReadInputTokens:
        usage.cacheReadInputTokens ?? previous?.cacheReadInputTokens,
      reasoningOutputTokens:
        usage.reasoningOutputTokens ?? previous?.reasoningOutputTokens,
    };
    perTurnUsage.set(turnId, updated);

    // Adjust only this compatibility bucket so cumulative contributions from
    // other provider turns and threads remain intact.
    openEntry.entry.tokens.input +=
      (updated.inputTokens ?? 0) - (previous?.inputTokens ?? 0);
    openEntry.entry.tokens.output +=
      (updated.outputTokens ?? 0) - (previous?.outputTokens ?? 0);
    openEntry.entry.tokens.cacheReadInputTokens +=
      (updated.cacheReadInputTokens ?? 0) -
      (previous?.cacheReadInputTokens ?? 0);
    openEntry.entry.tokens.cacheCreationInputTokens = 0;
    openEntry.entry.tokens.reasoningOutputTokens =
      (openEntry.entry.tokens.reasoningOutputTokens ?? 0) +
      (updated.reasoningOutputTokens ?? 0) -
      (previous?.reasoningOutputTokens ?? 0);
    openEntry.usageObserved = true;
  }

  private observeCodexTurnResult(
    openEntry: OpenAuditEntry,
    event: Record<string, unknown>,
  ): void {
    const usage = isRecord(event.usage) ? event.usage : null;
    if (!usage) {
      return;
    }
    const inputTokens = readNumber(usage, 'input_tokens');
    const outputTokens = readNumber(usage, 'output_tokens');
    const cacheReadInputTokens = readNumber(usage, 'cached_input_tokens');
    const reasoningOutputTokens = readNumber(usage, 'reasoning_output_tokens');
    const hasObservedUsage =
      inputTokens !== undefined ||
      outputTokens !== undefined ||
      cacheReadInputTokens !== undefined ||
      reasoningOutputTokens !== undefined;

    const turnId = readCodexEventTurnId(event) ?? '';
    const cumulativeTurns = openEntry.codexCumulativeUsageTurnIds;
    const alreadyObservedCumulatively =
      cumulativeTurns?.has(turnId) === true ||
      cumulativeTurns?.has('') === true;
    if (hasObservedUsage && !alreadyObservedCumulatively) {
      this.observeCodexFallbackTurnUsage(openEntry, event, {
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        reasoningOutputTokens,
      });
    }
  }

  private observeCodexError(
    openEntry: OpenAuditEntry,
    event: Record<string, unknown>,
  ): void {
    const message = readString(event, 'message');
    if (message) {
      openEntry.entry.error = message;
    }
  }

  private observeCodexTurnStarted(
    openEntry: OpenAuditEntry,
    event: Record<string, unknown>,
  ): void {
    const turnId = readCodexEventTurnId(event);
    if (!turnId) {
      return;
    }
    const threadId =
      readString(event, 'thread_id') ?? readString(event, 'threadId') ?? '';
    if (
      openEntry.entry.sdkSessionId &&
      threadId &&
      threadId !== openEntry.entry.sdkSessionId
    ) {
      return;
    }
    openEntry.codexActiveProviderTurn = {
      threadId,
      turnId,
    };
  }

  private clearCodexActiveTurn(
    openEntry: OpenAuditEntry,
    event: Record<string, unknown>,
  ): void {
    const activeTurn = openEntry.codexActiveProviderTurn;
    const turnId = readCodexEventTurnId(event) ?? '';
    const threadId =
      readString(event, 'thread_id') ?? readString(event, 'threadId') ?? '';
    if (activeTurn?.turnId === turnId && activeTurn.threadId === threadId) {
      openEntry.codexActiveProviderTurn = undefined;
    }
  }

  private observeIdleCodexSubagentEvent(
    key: string,
    event: Record<string, unknown>,
  ): void {
    if (!key.startsWith('chat:')) return;
    const tracker = this.getOrCreateCodexSubagentChatTracker(key);
    if (!tracker) return;

    if (
      event.type === 'thread.started' &&
      isCodexSubagentThreadStarted(event)
    ) {
      tracker.observeThreadStarted(event);
      return;
    }
    if (event.type === 'item.started' && isRecord(event.item)) {
      tracker.observeSpawnItem(event.item);
      return;
    }
    if (event.type === 'thread.subagent_token_usage.updated') {
      tracker.observeUsageEvent(event);
    }
  }

  observeCodexEvent(key: string, event: Record<string, unknown>): void {
    const openEntry = this.openEntries.get(key);
    if (
      !openEntry ||
      (isCodexSubagentEvent(event) &&
        openEntry.entry.provider !== 'codex' &&
        openEntry.entry.executionHarness !== 'codex')
    ) {
      this.observeIdleCodexSubagentEvent(key, event);
      return;
    }

    if (event.type !== 'error') {
      openEntry.entry.provider = 'codex';
    }

    switch (event.type) {
      case 'thread.started':
        this.observeCodexThreadEvent(openEntry, event);
        break;
      case 'thread.subagent_token_usage.updated':
        openEntry.codexSubagentUsageTracker?.observeUsageEvent(event);
        this.updateCodexSubagentAudit(openEntry);
        break;
      case 'turn.started':
        this.observeCodexTurnStarted(openEntry, event);
        break;
      case 'thread.token_usage.updated':
        this.observeCodexTokenUsage(openEntry, event);
        break;
      case 'item.started':
      case 'item.completed':
        this.observeCodexItemEvent(openEntry, event);
        break;
      case 'item.plan.delta':
        this.observeCodexPlanDelta(openEntry, event);
        break;
      case 'turn.completed':
      case 'turn.failed':
        this.observeCodexTurnResult(openEntry, event);
        this.clearCodexActiveTurn(openEntry, event);
        break;
      case 'error':
        this.observeCodexError(openEntry, event);
        break;
      default:
        break;
    }

    this.upsertRecentEntry(openEntry.entry);
  }

  /** From now on canonical turn state decides undispatched turns' entries. */
  enableTurnStateAudit(): void {
    this.turnStateAudit = true;
  }

  /**
   * Receipt turn state announces each autonomous turn, such as a wake, before
   * its provider frames arrive. A dispatched Claude turn starts autonomous
   * until it binds to its prompt, and a stopped turn delivers nothing more,
   * so neither keeps its place.
   */
  observeTurnState(
    scope: { projectId: string; worktreeId: string; chatId: string },
    state: Pick<PersistedChatTurnState, 'current' | 'lastEnded'>,
  ): void {
    const key = `chat:${scope.projectId}/${scope.worktreeId}/${scope.chatId}`;
    const { current, lastEnded } = state;
    const pending = (this.pendingAutonomousTurns.get(key) ?? [])
      .filter((turn) =>
        [current, lastEnded].every(
          (record) =>
            record?.id !== turn.id ||
            (record.origin === 'autonomous' && record.outcome !== 'cancelled'),
        ),
      )
      .map((turn) => ({
        ...turn,
        ended: turn.ended || turn.id !== current?.id,
      }));
    if (
      current?.origin === 'autonomous' &&
      current.id !== this.openedAutonomousTurnIds.get(key) &&
      !pending.some((turn) => turn.id === current.id)
    ) {
      const userMessageId = current.userMessageId ?? current.inputIds?.[0];
      pending.push({
        id: current.id,
        startedAtMs: current.startedAtMs,
        ...(userMessageId ? { userMessageId } : {}),
        ended: false,
      });
    }
    // Bounded: a dispatch clears the rest.
    if (pending.length > 0)
      this.pendingAutonomousTurns.set(key, pending.slice(-4));
    else this.pendingAutonomousTurns.delete(key);
  }

  completeChatTurn(
    projectId: string,
    worktreeId: string,
    chatId: string,
    status: AgentAuditStatus,
    error?: string,
    /**
     * `setupFailure`: the turn failed before its provider ran, so an
     * unrecognized failure is reported as `setup` rather than `other`.
     */
    options?: { setupFailure?: boolean },
  ): void {
    this.finalizeOpenEntry(
      `chat:${projectId}/${worktreeId}/${chatId}`,
      status,
      error,
      options,
    );
  }

  pauseChatTurn(projectId: string, worktreeId: string, chatId: string): void {
    const openEntry = this.openEntries.get(
      `chat:${projectId}/${worktreeId}/${chatId}`,
    );
    if (!openEntry || openEntry.currentPauseStartedAtMs !== undefined) {
      return;
    }
    openEntry.currentPauseStartedAtMs = Date.now();
  }

  resumeChatTurn(projectId: string, worktreeId: string, chatId: string): void {
    const openEntry = this.openEntries.get(
      `chat:${projectId}/${worktreeId}/${chatId}`,
    );
    if (!openEntry || openEntry.currentPauseStartedAtMs === undefined) {
      return;
    }
    openEntry.pausedDurationMs += Math.max(
      0,
      Date.now() - openEntry.currentPauseStartedAtMs,
    );
    openEntry.currentPauseStartedAtMs = undefined;
  }

  recordCanonicalTurnDuration(
    projectId: string,
    worktreeId: string,
    chatId: string,
    turn: CanonicalChatTurnDuration,
  ): void {
    const key = `chat:${projectId}/${worktreeId}/${chatId}`;
    const openEntry = this.openEntries.get(key);
    if (
      !openEntry ||
      !CANONICAL_DURATION_EVENT_TYPES.has(openEntry.entry.eventType) ||
      !Number.isFinite(turn.durationMs) ||
      turn.durationMs < 0 ||
      !Number.isFinite(turn.pausedMs) ||
      turn.pausedMs < 0
    ) {
      return;
    }
    const sameMessage =
      turn.userMessageId !== undefined &&
      openEntry.entry.userMessageId === turn.userMessageId;
    const sameAutonomousTurn =
      openEntry.entry.autonomous === true &&
      this.openedAutonomousTurnIds.get(key) === turn.turnId;
    if (!sameMessage && !sameAutonomousTurn) return;
    openEntry.canonicalDurations ??= new Map();
    openEntry.canonicalDurations.set(turn.turnId, {
      durationMs: turn.durationMs,
      pausedMs: turn.pausedMs,
    });
  }

  noteInterfaceToolCallDelivered(
    projectId: string,
    worktreeId: string,
    chatId: string,
    callId: string,
  ): void {
    const openEntry = this.openEntries.get(
      `chat:${projectId}/${worktreeId}/${chatId}`,
    );
    if (!openEntry) return;
    const bound = this.interfaceToolCallEntryIds;
    if (bound.size >= INTERFACE_TOOL_CALL_BINDINGS) {
      const oldest = bound.keys().next();
      if (!oldest.done) bound.delete(oldest.value);
    }
    bound.set(callId, openEntry.entry.id);
  }

  recordInterfaceToolCall(
    projectId: string,
    worktreeId: string,
    chatId: string,
    call: AgentAuditInterfaceToolCall,
  ): void {
    const entryId = this.interfaceToolCallEntryIds.get(call.callId);
    this.interfaceToolCallEntryIds.delete(call.callId);
    const openEntry = this.openEntries.get(
      `chat:${projectId}/${worktreeId}/${chatId}`,
    );
    // Only the entry that was open when the call was delivered records it;
    // a later turn of the chat never does, even one started in the same ms.
    if (!openEntry || openEntry.entry.id !== entryId) return;
    const calls = (openEntry.entry.interfaceToolCalls ??= []);
    if (calls.length < INTERFACE_TOOL_CALLS_PER_ENTRY) calls.push({ ...call });
  }

  seedTranscript(key: string, options: TranscriptSeedOptions): void {
    const transcriptState = this.transcriptStates.get(key);
    if (!transcriptState) {
      return;
    }

    this.enqueueTranscriptRecord(
      transcriptState,
      buildSyntheticPromptRecord(options),
    );

    for (const prompt of options.injectedPrompts ?? []) {
      const alreadyTracked = transcriptState.injectedPrompts.some(
        (existingPrompt) =>
          existingPrompt.kind === prompt.kind &&
          existingPrompt.provider === prompt.provider &&
          existingPrompt.applicationCondition === prompt.applicationCondition &&
          existingPrompt.text === prompt.text,
      );
      if (!alreadyTracked) {
        transcriptState.injectedPrompts.push(prompt);
        this.enqueueTranscriptRecord(
          transcriptState,
          buildInjectedPromptRecord(prompt),
        );
      }
    }
  }

  recordInjectedPromptForOpenChatTurn(
    projectId: string,
    worktreeId: string,
    chatId: string,
    prompt: AgentTranscriptInjectedPrompt,
  ): void {
    const key = `chat:${projectId}/${worktreeId}/${chatId}`;
    let transcriptState = this.transcriptStates.get(key);
    if (!transcriptState) {
      this.reviveChatTurn(key);
      transcriptState = this.transcriptStates.get(key);
    }
    if (!transcriptState) {
      return;
    }
    const alreadyTracked = transcriptState.injectedPrompts.some(
      (existingPrompt) =>
        existingPrompt.kind === prompt.kind &&
        existingPrompt.provider === prompt.provider &&
        existingPrompt.applicationCondition === prompt.applicationCondition &&
        existingPrompt.text === prompt.text &&
        injectedPromptResourcesKey(existingPrompt) ===
          injectedPromptResourcesKey(prompt),
    );
    if (alreadyTracked) {
      return;
    }
    transcriptState.injectedPrompts.push(prompt);
    this.enqueueTranscriptRecord(
      transcriptState,
      buildInjectedPromptRecord(prompt),
    );
  }

  appendTranscriptRecord(key: string, payload: unknown): void {
    const transcriptState = this.transcriptStates.get(key);
    if (transcriptState) {
      this.enqueueTranscriptRecord(transcriptState, payload);
    }

    const openEntry = this.openEntries.get(key);
    if (
      openEntry &&
      isRecord(payload) &&
      (openEntry.entry.provider === 'codex' ||
        (readString(payload, 'type') !== 'error' && isCodexEventShape(payload)))
    ) {
      this.observeCodexEvent(key, payload);
    }
  }

  appendFinalizedChatTranscriptRecord(
    projectId: string,
    worktreeId: string,
    chatId: string,
    payload: unknown,
  ): Promise<void> {
    const trackedAppend = this.appendFinalizedChatTranscriptRecordInternal(
      projectId,
      worktreeId,
      chatId,
      payload,
    ).finally(() => {
      this.pendingFinalizedTranscriptAppends.delete(trackedAppend);
    });
    this.pendingFinalizedTranscriptAppends.add(trackedAppend);
    return trackedAppend;
  }

  private async appendFinalizedChatTranscriptRecordInternal(
    projectId: string,
    worktreeId: string,
    chatId: string,
    payload: unknown,
  ): Promise<void> {
    const key = `chat:${projectId}/${worktreeId}/${chatId}`;
    let transcriptState = this.transcriptStates.get(key);
    if (!transcriptState) {
      const finalizedEntry = this.recentEntries.find(
        (entry) => entry.id.startsWith(`${key}:`) && entry.status !== 'running',
      );
      if (!finalizedEntry) {
        return;
      }

      const request = buildTranscriptRequest(finalizedEntry);
      const path = getAgentObservabilityTranscriptFilePath(request);
      const persistedBytes = await stat(path)
        .then((stats) => stats.size)
        .catch(() => 0);

      transcriptState = this.transcriptStates.get(key);
      if (!transcriptState) {
        const budget = this.transcriptBudgets.get(path) ?? {
          persistedBytes,
          queuedBytes: 0,
          delegationBytes: 0,
          truncated: false,
          projectId,
          worktreeId,
        };
        this.transcriptBudgets.set(path, budget);
        const restoredState: TranscriptSidecarState = {
          key,
          request,
          path,
          providerHint: finalizedEntry.provider,
          queuedLines: [],
          queuedBytes: 0,
          budget,
          firstAppendSucceeded: finalizedEntry.hasTranscript === true,
          closed: true,
          injectedPrompts: [],
          finalizedEntry: { ...finalizedEntry },
        };
        this.transcriptStates.set(key, restoredState);
        this.retiringTranscriptStates.add(restoredState);
        transcriptState = restoredState;
      }
    }

    this.enqueueTranscriptRecord(transcriptState, payload);
  }

  /**
   * A wake's first root output opens its own entry with the chat's metadata
   * and fresh counters. Its terminal frame closes it, as a dispatched turn's
   * does, so the entry keeps the terminal's usage and cost.
   */
  private openAutonomousTurnEntry(key: string): void {
    const turn = this.pendingAutonomousTurns.get(key)?.shift();
    if (!turn) return;
    const previous = this.recentEntries.find((entry) =>
      entry.id.startsWith(`${key}:`),
    );
    if (!previous) return;
    const startedAt = new Date(turn.startedAtMs).toISOString();
    const entry: AgentAuditEntry = {
      ...chatEntryMetadata(previous),
      id: `${key}:${startedAt}:${turn.id}`,
      status: 'running',
      startedAt,
      tokens: defaultTokens(),
      messageCount: 0,
      assistantMessageCount: 0,
      toolUseCount: 0,
      subAgentCount: 0,
      toolCounts: defaultToolCounts(),
      hasTranscript: false,
      autonomous: true,
      ...(turn.userMessageId ? { userMessageId: turn.userMessageId } : {}),
    };
    const accountProxyRouted = previous.billingBasis === 'account_proxy';
    // A new turn closes the last one for good.
    this.closedTurnAccountProxyResponses.delete(key);
    const providerSnapshot = this.captureProviderStartSnapshot(
      entry.provider,
      accountProxyRouted,
    );
    const codexSubagentUsageTracker =
      entry.provider === 'codex'
        ? this.getOrCreateCodexSubagentChatTracker(key)
        : undefined;
    codexSubagentUsageTracker?.beginEntry();
    this.openEntries.set(key, {
      entry,
      providerAccountIdentity: providerSnapshot.providerAccountIdentity,
      billingAccountKind: providerSnapshot.billingAccountKind,
      ...(accountProxyRouted ? { accountProxyRouted: true } : {}),
      // A wake continues on its own, with no new prompt from anyone.
      turnTrigger: 'automation',
      seenCodexItems: new Set<string>(),
      seenBillableToolItemIds: new Set<string>(),
      usageObserved: false,
      pendingClaudePrCreateToolUses: new Map<string, string>(),
      seenManualPrCreateKeys: new Set<string>(),
      pausedDurationMs: 0,
      seenCompactionIds: new Set<string>(),
      ...(codexSubagentUsageTracker ? { codexSubagentUsageTracker } : {}),
    });
    this.openedAutonomousTurnIds.set(key, turn.id);
    if (entry.provider === 'claude') {
      this.claudeTaskTrackers.get(key)?.applyPending(entry);
    }
    this.initializeTranscriptState(key, entry);
    startAuditOperation(this.host, key, entry);
    this.upsertRecentEntry(entry);
  }

  private reviveChatTurn(key: string): void {
    const existingEntry = this.recentEntries.find(
      (entry) => entry.id.startsWith(`${key}:`) && entry.status !== 'running',
    );
    if (
      !existingEntry ||
      !this.finalizedChatEntryIdsInProcess.has(existingEntry.id)
    ) {
      return;
    }

    const entry: AgentAuditEntry = {
      ...existingEntry,
      status: 'running',
    };
    delete entry.completedAt;
    delete entry.error;

    const billingAccountKind: ProviderBillingAccountKind =
      entry.billingBasis === 'subscription'
        ? 'subscription'
        : entry.billingBasis === 'api_key'
          ? 'api_key'
          : 'unknown';
    const codexSubagentUsageTracker =
      entry.provider === 'codex'
        ? this.getOrCreateCodexSubagentChatTracker(key)
        : undefined;
    codexSubagentUsageTracker?.beginEntry(entry.subagents ?? []);

    this.openEntries.set(key, {
      entry,
      providerAccountIdentity: null,
      billingAccountKind,
      ...(entry.billingBasis === 'account_proxy'
        ? { accountProxyRouted: true }
        : {}),
      seenCodexItems: new Set<string>(),
      seenBillableToolItemIds: new Set<string>(),
      usageObserved: false,
      pendingClaudePrCreateToolUses: new Map<string, string>(),
      seenManualPrCreateKeys: new Set<string>(),
      pausedDurationMs: 0,
      seenCompactionIds: new Set<string>(),
      ...(codexSubagentUsageTracker ? { codexSubagentUsageTracker } : {}),
    });
    // Responses the reopened turn sent before the event that reopened it.
    for (const response of this.closedTurnAccountProxyResponses.get(key) ??
      []) {
      entry.accountProxy = addAccountProxyResponse(
        entry.accountProxy,
        response,
      );
    }
    this.closedTurnAccountProxyResponses.delete(key);

    const transcriptState = this.transcriptStates.get(key);
    if (transcriptState) {
      transcriptState.closed = false;
      transcriptState.finalizedEntry = undefined;
    } else {
      this.initializeTranscriptState(key, entry);
    }

    this.upsertRecentEntry(entry);
  }

  private initializeTranscriptState(key: string, entry: AgentAuditEntry): void {
    const previous = this.transcriptStates.get(key);
    if (previous && previous.queuedLines.length > 0) {
      // Keep the closed sidecar reachable until its queued/in-flight append
      // finishes, even if a new root starts before the scheduled flush.
      previous.closed = true;
      delete previous.delegationItems;
      this.retiringTranscriptStates.add(previous);
    }
    const request = buildTranscriptRequest(entry);
    const transcriptPath = getAgentObservabilityTranscriptFilePath(request);
    const budget = this.transcriptBudgets.get(transcriptPath) ?? {
      persistedBytes: 0,
      queuedBytes: 0,
      delegationBytes: 0,
      truncated: false,
      projectId: entry.projectId,
      worktreeId: entry.worktreeId,
    };
    this.transcriptBudgets.set(transcriptPath, budget);
    const transcriptState: TranscriptSidecarState = {
      key,
      request,
      path: transcriptPath,
      providerHint: entry.provider,
      queuedLines: [],
      queuedBytes: 0,
      budget,
      firstAppendSucceeded: false,
      closed: false,
      injectedPrompts: [],
    };

    this.transcriptStates.set(key, transcriptState);
  }

  private enqueueTranscriptRecord(
    transcriptState: TranscriptSidecarState,
    payload: unknown,
    delegationRecord?: 'delegation-content' | 'delegation-status',
  ): boolean {
    if (transcriptState.budget.truncated) {
      this.releaseClosedTranscriptState(transcriptState);
      return false;
    }

    const line = JSON.stringify(payload);
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8');
    const totalBytes =
      transcriptState.budget.persistedBytes +
      transcriptState.budget.queuedBytes +
      lineBytes;
    if (
      totalBytes >
      TRANSCRIPT_MAX_BYTES - TRANSCRIPT_MARKER_RESERVATION_BYTES
    ) {
      if (!delegationRecord) {
        this.enqueueTranscriptTruncationMarker(transcriptState);
        this.scheduleFlush();
      }
      return false;
    }
    if (delegationRecord) {
      const delegationLimit =
        delegationRecord === 'delegation-status'
          ? TRANSCRIPT_DELEGATION_MAX_BYTES
          : TRANSCRIPT_DELEGATION_MAX_BYTES -
            TRANSCRIPT_DELEGATION_STATUS_RESERVATION_BYTES;
      if (
        transcriptState.budget.delegationBytes + lineBytes >
        delegationLimit
      ) {
        return false;
      }
    }

    transcriptState.queuedLines.push(line);
    transcriptState.queuedBytes += lineBytes;
    transcriptState.budget.queuedBytes += lineBytes;
    if (delegationRecord) {
      transcriptState.budget.delegationBytes += lineBytes;
    }
    this.scheduleFlush(lineBytes);
    return true;
  }

  private releaseClosedTranscriptState(
    transcriptState: TranscriptSidecarState,
  ): void {
    if (!transcriptState.closed) return;
    delete transcriptState.delegationItems;
    if (transcriptState.queuedLines.length > 0) return;
    this.retiringTranscriptStates.delete(transcriptState);
    if (this.transcriptStates.get(transcriptState.key) === transcriptState) {
      this.transcriptStates.delete(transcriptState.key);
    }
  }

  private enqueueTranscriptTruncationMarker(
    transcriptState: TranscriptSidecarState,
  ): void {
    if (transcriptState.budget.truncated) {
      return;
    }

    transcriptState.budget.truncated = true;
    const markerLine = JSON.stringify(buildTranscriptTruncationMarker());
    const markerBytes = Buffer.byteLength(`${markerLine}\n`, 'utf8');
    if (
      transcriptState.budget.persistedBytes +
        transcriptState.budget.queuedBytes +
        markerBytes >
      TRANSCRIPT_MAX_BYTES
    ) {
      return;
    }

    transcriptState.queuedLines.push(markerLine);
    transcriptState.queuedBytes += markerBytes;
    transcriptState.budget.queuedBytes += markerBytes;
  }

  private markTranscriptAvailable(
    transcriptState: TranscriptSidecarState,
  ): void {
    if (transcriptState.firstAppendSucceeded) {
      return;
    }

    transcriptState.firstAppendSucceeded = true;
    const openEntry = this.openEntries.get(transcriptState.key);
    if (openEntry && !transcriptState.closed) {
      if (!openEntry.entry.hasTranscript) {
        openEntry.entry.hasTranscript = true;
        this.enqueueTranscriptIndexRecord(openEntry.entry, transcriptState);
        this.upsertRecentEntry(openEntry.entry);
      }
      return;
    }

    if (!transcriptState.finalizedEntry) {
      return;
    }

    if (!transcriptState.finalizedEntry.hasTranscript) {
      // A late plan/context/lineage upsert may precede the first sidecar write.
      // Preserve that newer audit snapshot when publishing transcript availability.
      const latestEntry = this.recentEntries.find(
        (entry) => entry.id === transcriptState.finalizedEntry?.id,
      );
      if (latestEntry) transcriptState.finalizedEntry = { ...latestEntry };
      transcriptState.finalizedEntry.hasTranscript = true;
      this.enqueueTranscriptIndexRecord(
        transcriptState.finalizedEntry,
        transcriptState,
      );
      this.enqueueAuditEntry(transcriptState.finalizedEntry);
      this.upsertRecentEntry(transcriptState.finalizedEntry);
    }
  }

  private enqueueTranscriptIndexRecord(
    entry: AgentAuditEntry,
    transcriptState: TranscriptSidecarState,
  ): void {
    if (
      entry.eventType === 'standalone_chat' ||
      entry.eventType === 'app_advisor' ||
      !entry.projectId ||
      !entry.worktreeId
    ) {
      return;
    }

    const record: TranscriptIndexRecord = {
      version: 1,
      projectId: entry.projectId,
      worktreeId: entry.worktreeId,
      entryId: entry.id,
      eventType: entry.eventType,
      startedAt: entry.startedAt,
      transcriptPath: transcriptState.path,
    };
    this.pendingTranscriptIndexRecords.push(record);
    this.scheduleFlush(estimatePendingRecordBytes(record));
  }

  startObservedTask(key: string, entry: AgentAuditEntry): void {
    if (this.openEntries.has(key)) {
      this.finalizeOpenEntry(key, 'interrupted', 'Superseded by a new task');
    }
    const providerSnapshot = this.captureProviderStartSnapshot(entry.provider);
    const rootPipelineExecutionId = entry.pipelineExecutionId
      ? this.rootPipelineExecutionIdFor(entry.pipelineExecutionId)
      : undefined;
    const observedEntry: AgentAuditEntry = {
      ...entry,
      ...observedModelIdentity(entry),
      ...(entry.modelGatewayRouted === true || usedOrganizationGateway(entry)
        ? { modelGatewayRouted: true }
        : {}),
      modelSource:
        entry.modelSource ??
        (entry.model ? getModelSource(entry.model) : undefined),
      executionHarness:
        entry.executionHarness ??
        (entry.model
          ? getExecutionHarnessForModel(entry.model)
          : entry.provider === 'codex'
            ? 'codex'
            : 'claude'),
      billingBasis: billingBasisAtEntryStart(
        entry.provider,
        providerSnapshot.billingAccountKind,
        entry.aiCreditsRouted === true,
        entry.modelGatewayRouted === true || usedOrganizationGateway(entry),
      ),
      ...(!entry.rootPipelineExecutionId && rootPipelineExecutionId
        ? { rootPipelineExecutionId }
        : {}),
    };

    if (key.startsWith('pipeline:')) {
      this.finalizedPipelineStepKeys.delete(key);
    }

    const codexSubagentUsageTracker =
      observedEntry.provider === 'codex' &&
      observedEntry.eventType === 'pipeline_agent_turn' &&
      this.codexPipelineSubagentTrackerKeys.size <
        MAX_CODEX_PIPELINE_SUBAGENT_TRACKERS
        ? new CodexSubagentUsageTracker({
            historyLimit: MAX_CODEX_SUBAGENTS_PER_ENTRY,
          })
        : undefined;
    // A restored step keeps the child usage it already recorded.
    codexSubagentUsageTracker?.beginEntry(observedEntry.subagents ?? []);
    if (codexSubagentUsageTracker) {
      this.codexPipelineSubagentTrackerKeys.add(key);
    }

    this.openEntries.set(key, {
      entry: observedEntry,
      providerAccountIdentity: providerSnapshot.providerAccountIdentity,
      billingAccountKind: providerSnapshot.billingAccountKind,
      seenCodexItems: new Set<string>(),
      seenBillableToolItemIds: new Set<string>(),
      usageObserved: false,
      pendingClaudePrCreateToolUses: new Map<string, string>(),
      seenManualPrCreateKeys: new Set<string>(),
      pausedDurationMs: 0,
      seenCompactionIds: new Set<string>(),
      ...(codexSubagentUsageTracker ? { codexSubagentUsageTracker } : {}),
    });
    this.observedTaskEntryIdsByKey.set(key, observedEntry.id);
    if (
      observedEntry.pipelineExecutionId &&
      (observedEntry.eventType === 'pipeline_agent_turn' ||
        observedEntry.eventType === 'pipeline_advisor')
    ) {
      this.retainedPipelineEntriesByKey.set(key, observedEntry);
      while (
        this.retainedPipelineEntriesByKey.size > MAX_RETAINED_PIPELINE_ENTRIES
      ) {
        const oldestKey = this.retainedPipelineEntriesByKey.keys().next().value;
        if (oldestKey === undefined) break;
        this.retainedPipelineEntriesByKey.delete(oldestKey);
      }
    }
    if (observedEntry.provider === 'claude') {
      this.claudeTaskTrackers.get(key)?.applyPending(observedEntry);
    }
    this.initializeTranscriptState(key, observedEntry);
    startAuditOperation(this.host, key, observedEntry);
    this.upsertRecentEntry(observedEntry);
  }

  /**
   * Records the model that actually served a chat turn when the session
   * swapped it after dispatch (a credits-routed Codex turn whose picked native
   * model becomes the credits gateway model). `requestedModel` keeps the
   * selection the turn started with. Like `updateObservedTask`, only
   * `modelGatewayRouted` is recomputed: the swap never runs on an
   * organization gateway route, so `billingBasis` cannot change here.
   */
  setChatTurnServedModel(sessionKey: string, model: string): void {
    const openEntry = this.openEntries.get(`chat:${sessionKey}`);
    if (!openEntry || openEntry.entry.model === model) {
      return;
    }
    const nextEntry: AgentAuditEntry = { ...openEntry.entry, model };
    Object.assign(nextEntry, observedModelIdentity(nextEntry));
    if (usedOrganizationGateway(nextEntry)) {
      nextEntry.modelGatewayRouted = true;
    } else {
      delete nextEntry.modelGatewayRouted;
    }
    openEntry.entry = nextEntry;
    this.upsertRecentEntry(openEntry.entry);
    this.enqueueAuditEntry(openEntry.entry);
  }

  /**
   * Records the route a chat session actually applied once it settles: the
   * turn's audit entry starts from the decision made when the session was
   * created, and the proxy may have stopped being ready before spawn.
   */
  setChatTurnAccountProxyRouted(sessionKey: string, routed: boolean): void {
    const openEntry = this.openEntries.get(`chat:${sessionKey}`);
    if (!openEntry || (openEntry.accountProxyRouted === true) === routed) {
      return;
    }
    this.applyAccountProxyRoute(openEntry, routed);
  }

  /**
   * One proxied response of a chat session: its open turn records the account
   * that served it (CAN-4021). Subagents in the chat's own process share its
   * route, so their requests count for the turn too.
   */
  private observeAccountProxyResponse(response: AccountProxyResponse): void {
    const key = `chat:${response.sessionId}`;
    const openEntry = this.openEntries.get(key);
    if (!openEntry) {
      this.holdClosedTurnAccountProxyResponse(key, response);
      return;
    }
    openEntry.entry.accountProxy = addAccountProxyResponse(
      openEntry.entry.accountProxy,
      response,
    );
  }

  private holdClosedTurnAccountProxyResponse(
    key: string,
    response: AccountProxyResponse,
  ): void {
    const held = this.closedTurnAccountProxyResponses.get(key) ?? [];
    // Map order is insertion order; re-inserting marks the chat most recent.
    this.closedTurnAccountProxyResponses.delete(key);
    if (held.length < MAX_HELD_ACCOUNT_PROXY_RESPONSES) held.push(response);
    this.closedTurnAccountProxyResponses.set(key, held);
    while (
      this.closedTurnAccountProxyResponses.size > MAX_HELD_ACCOUNT_PROXY_CHATS
    ) {
      const oldest = this.closedTurnAccountProxyResponses.keys().next().value;
      if (oldest === undefined) break;
      this.closedTurnAccountProxyResponses.delete(oldest);
    }
  }

  /**
   * The account proxy served this task, found out after it started (a
   * helper's route, a pipeline step's outputs). Its billing basis stays
   * unknown and no native account is credited until proxy accounting lands
   * (CAN-4022).
   */
  markObservedTaskAccountProxyRouted(key: string): void {
    const openEntry = this.openEntries.get(key);
    if (!openEntry) return;
    this.applyAccountProxyRoute(openEntry, true);
  }

  private applyAccountProxyRoute(
    openEntry: OpenAuditEntry,
    routed: boolean,
  ): void {
    const providerSnapshot = this.captureProviderStartSnapshot(
      openEntry.entry.provider,
      routed,
    );
    openEntry.accountProxyRouted = routed;
    openEntry.providerAccountIdentity =
      providerSnapshot.providerAccountIdentity;
    openEntry.billingAccountKind = providerSnapshot.billingAccountKind;
    openEntry.entry.billingBasis = billingBasisAtEntryStart(
      openEntry.entry.provider,
      providerSnapshot.billingAccountKind,
      openEntry.entry.aiCreditsRouted === true,
      openEntry.entry.modelGatewayRouted === true ||
        usedOrganizationGateway(openEntry.entry),
      routed,
    );
  }

  updateObservedTask(
    key: string,
    patch: Partial<
      Pick<
        AgentAuditEntry,
        | 'sdkSessionId'
        | 'model'
        | 'agentId'
        | 'provider'
        | 'modelSource'
        | 'executionHarness'
        | 'chatMode'
        | 'serviceTier'
        | 'aiCreditsRouted'
        | 'modelGatewayRouted'
        | 'attempt'
        | 'rootPipelineExecutionId'
      >
    >,
  ): void {
    const openEntry = this.openEntries.get(key);
    if (!openEntry) {
      const auditEntryId =
        this.observedTaskEntryIdsByKey.get(key) ??
        this.recentEntries.find((entry) => entry.id.startsWith(`${key}:`))?.id;
      const recentEntry = auditEntryId
        ? this.recentEntries.find((entry) => entry.id === auditEntryId)
        : undefined;
      const retainedEntry = this.retainedPipelineEntriesByKey.get(key);
      const previousEntry = recentEntry ?? retainedEntry;
      if (!previousEntry) return;
      const nextEntry: AgentAuditEntry = { ...previousEntry, ...patch };
      Object.assign(nextEntry, observedModelIdentity(nextEntry));
      this.enqueueAuditEntry(nextEntry);
      this.upsertRecentEntry(nextEntry);
      if (retainedEntry) {
        this.retainedPipelineEntriesByKey.set(key, nextEntry);
      }
      return;
    }
    if (
      patch.provider !== undefined &&
      patch.provider !== openEntry.entry.provider
    ) {
      const providerSnapshot = this.captureProviderStartSnapshot(
        patch.provider,
        openEntry.accountProxyRouted === true,
      );
      openEntry.providerAccountIdentity =
        providerSnapshot.providerAccountIdentity;
      openEntry.billingAccountKind = providerSnapshot.billingAccountKind;
    }
    const nextEntry: AgentAuditEntry = {
      ...openEntry.entry,
      ...patch,
    };
    Object.assign(nextEntry, observedModelIdentity(nextEntry));
    if (
      patch.modelGatewayRouted === undefined &&
      (patch.model !== undefined || patch.aiCreditsRouted !== undefined)
    ) {
      if (usedOrganizationGateway(nextEntry)) {
        nextEntry.modelGatewayRouted = true;
      } else {
        delete nextEntry.modelGatewayRouted;
      }
    }
    openEntry.entry = nextEntry;
    if (this.retainedPipelineEntriesByKey.has(key)) {
      this.retainedPipelineEntriesByKey.set(key, nextEntry);
    }
    this.upsertRecentEntry(openEntry.entry);
    this.enqueueAuditEntry(openEntry.entry);
  }

  finalizeObservedTask(
    key: string,
    status: AgentAuditStatus,
    error?: string,
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      totalCostUsd?: number;
      messageCount?: number;
      assistantMessageCount?: number;
      reasoningOutputTokens?: number;
    },
  ): void {
    if (usage) {
      const openEntry = this.openEntries.get(key);
      if (openEntry) {
        const entry = openEntry.entry;
        const ledgerRecorded =
          entry.provider === 'claude' && entry.costDerivation !== undefined;
        if (!ledgerRecorded && typeof usage.inputTokens === 'number') {
          entry.tokens.input = usage.inputTokens;
        }
        if (!ledgerRecorded && typeof usage.outputTokens === 'number') {
          entry.tokens.output = usage.outputTokens;
        }
        if (!ledgerRecorded && typeof usage.cacheReadInputTokens === 'number') {
          entry.tokens.cacheReadInputTokens = usage.cacheReadInputTokens;
        }
        if (
          !ledgerRecorded &&
          typeof usage.cacheCreationInputTokens === 'number'
        ) {
          entry.tokens.cacheCreationInputTokens =
            usage.cacheCreationInputTokens;
        }
        if (
          !ledgerRecorded &&
          typeof usage.reasoningOutputTokens === 'number'
        ) {
          entry.tokens.reasoningOutputTokens = usage.reasoningOutputTokens;
        }
        if (
          typeof usage.inputTokens === 'number' ||
          typeof usage.outputTokens === 'number' ||
          typeof usage.cacheReadInputTokens === 'number' ||
          typeof usage.cacheCreationInputTokens === 'number' ||
          typeof usage.reasoningOutputTokens === 'number'
        ) {
          openEntry.usageObserved = true;
        }
        if (!ledgerRecorded && typeof usage.totalCostUsd === 'number') {
          entry.totalCostUsd = usage.totalCostUsd;
        }
        if (typeof usage.messageCount === 'number') {
          entry.messageCount = usage.messageCount;
        }
        if (typeof usage.assistantMessageCount === 'number') {
          entry.assistantMessageCount = usage.assistantMessageCount;
        }
      }
    }
    this.finalizeOpenEntry(key, status, error);
  }

  interruptMatchingEntries(prefix: string): void {
    for (const key of Array.from(this.openEntries.keys())) {
      if (key.startsWith(prefix)) {
        this.finalizeOpenEntry(key, 'interrupted', 'Session interrupted');
      }
    }
  }

  async purgeWorktreeData(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.enqueuePersistenceTask(async (): Promise<void> => {
      await this.runFlush();

      const chatKeyPrefix = `chat:${projectId}/${worktreeId}/`;
      const transcriptPaths = new Set<string>();
      if (this.plansAwaitingCountedIds) {
        this.plansAwaitingCountedIds = this.plansAwaitingCountedIds.filter(
          ({ event }) =>
            event.workspaceId !== projectId || event.worktreeId !== worktreeId,
        );
      }
      for (const key of Array.from(this.claudeTaskTrackers.keys())) {
        if (key.startsWith(chatKeyPrefix)) this.claudeTaskTrackers.delete(key);
      }
      for (const state of Array.from(this.retiringTranscriptStates)) {
        if (state.key.startsWith(chatKeyPrefix))
          this.retiringTranscriptStates.delete(state);
      }

      for (const [key, openEntry] of Array.from(this.openEntries.entries())) {
        if (!entryMatchesWorktree(openEntry.entry, projectId, worktreeId)) {
          continue;
        }

        transcriptPaths.add(
          getAgentObservabilityTranscriptFilePath(
            buildTranscriptRequest(openEntry.entry),
          ),
        );
        this.openEntries.delete(key);
        this.pipelineOutputBuffers.delete(key);
        this.transcriptStates.delete(key);
        if (key.startsWith('pipeline:')) {
          this.finalizedPipelineStepKeys.delete(key);
          this.codexPipelineSubagentTrackerKeys.delete(key);
        }
      }

      for (const key of Array.from(this.codexSubagentUsageByChat.keys())) {
        if (key.startsWith(chatKeyPrefix)) {
          this.codexSubagentUsageByChat.delete(key);
        }
      }

      for (const [key, transcriptState] of Array.from(
        this.transcriptStates.entries(),
      )) {
        if (
          !key.startsWith(chatKeyPrefix) &&
          (transcriptState.budget.projectId !== projectId ||
            transcriptState.budget.worktreeId !== worktreeId)
        )
          continue;
        transcriptPaths.add(transcriptState.path);
        this.transcriptStates.delete(key);
        this.pipelineOutputBuffers.delete(key);
        if (key.startsWith('pipeline:')) {
          this.finalizedPipelineStepKeys.delete(key);
        }
      }
      for (const [path, budget] of Array.from(
        this.transcriptBudgets.entries(),
      )) {
        if (budget.projectId !== projectId || budget.worktreeId !== worktreeId)
          continue;
        transcriptPaths.add(path);
        this.transcriptBudgets.delete(path);
      }

      this.pendingPersistedEntries = this.pendingPersistedEntries.filter(
        (entry) => !entryMatchesWorktree(entry, projectId, worktreeId),
      );
      this.pendingSessionDiagnostics = this.pendingSessionDiagnostics.filter(
        (entry) => !entryMatchesWorktree(entry, projectId, worktreeId),
      );
      // Usage metrics intentionally survive worktree archive/deletion so
      // deletion outcomes remain computable after worktree-scoped data is gone.
      this.recentEntries = this.recentEntries.filter(
        (entry) => !entryMatchesWorktree(entry, projectId, worktreeId),
      );
      await Promise.all(
        Array.from(transcriptPaths, (path) =>
          rm(path, { force: true }).catch(() => {}),
        ),
      );
      await purgePersistedWorktreeObservabilityData(projectId, worktreeId);
      await this.runFlush();
    });

    this.emitSnapshot();
  }

  /**
   * The persisted-only worktree purge, serialized with this service's writes.
   * It also drops the worktree's session diagnostics not yet written, so they
   * are not appended after the purge; live audit state is left to its owner.
   */
  async purgePersistedWorktreeData(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    await this.enqueuePersistenceTask(async (): Promise<void> => {
      this.pendingSessionDiagnostics = this.pendingSessionDiagnostics.filter(
        (entry) => !entryMatchesWorktree(entry, projectId, worktreeId),
      );
      await purgePersistedWorktreeObservabilityData(projectId, worktreeId);
    });
  }

  /**
   * Removes the session diagnostics of a worktree purged before an operation
   * on it finished. Its pending records always go; its persisted session
   * events are rewritten only when some of the operation's `records` were
   * already written. Audit and transcript data are left alone.
   */
  async purgeLateWorktreeSessionDiagnostics(
    projectId: string,
    worktreeId: string,
    waitOperationId: string,
    records: number,
  ): Promise<void> {
    await this.enqueuePersistenceTask(async (): Promise<void> => {
      const unwritten = this.pendingSessionDiagnostics.filter(
        (entry) => entry.waitOperationId === waitOperationId,
      ).length;
      this.pendingSessionDiagnostics = this.pendingSessionDiagnostics.filter(
        (entry) => !entryMatchesWorktree(entry, projectId, worktreeId),
      );
      if (unwritten < records)
        await purgePersistedWorktreeSessionDiagnostics(projectId, worktreeId);
    });
  }

  syncPipelineExecutionState(state: PipelineExecutionStateSyncInput): void {
    const lineage: PipelineExecutionLineage = {
      id: state.id,
      ...(state.parent_execution_id === undefined
        ? {}
        : { parent_execution_id: state.parent_execution_id }),
    };
    this.pipelineExecutionLineage.set(state.id, lineage);
    this.refreshPipelineRootIds();

    for (const [jobId, job] of Object.entries(state.jobs)) {
      for (const historicalAttempt of job.retry_history ?? []) {
        for (const iteration of historicalAttempt.iteration_history ?? []) {
          for (const [stepId, stepValue] of Object.entries(iteration.steps)) {
            this.syncPipelineStep({
              executionId: state.id,
              pipelineId: state.pipeline_id,
              pipelineName: state.pipeline_snapshot.name,
              projectId: state.project_id,
              worktreeId: state.worktree_id,
              jobId,
              stepId,
              attempt: historicalAttempt.attempt,
              iteration: iteration.iteration,
              step: stepValue,
              modelConfig: mergeAgentModelConfig(
                state.model_config,
                stepValue.agent_model_config ?? {},
              ),
            });
          }
        }
        for (const [stepId, stepValue] of Object.entries(
          historicalAttempt.steps,
        )) {
          this.syncPipelineStep({
            executionId: state.id,
            pipelineId: state.pipeline_id,
            pipelineName: state.pipeline_snapshot.name,
            projectId: state.project_id,
            worktreeId: state.worktree_id,
            jobId,
            stepId,
            attempt: historicalAttempt.attempt,
            iteration: finalIterationForAttempt(
              historicalAttempt.iteration_history,
            ),
            step: stepValue,
            modelConfig: mergeAgentModelConfig(
              state.model_config,
              stepValue.agent_model_config ?? {},
            ),
          });
        }
      }

      const currentAttempt = job.retry_count ?? 0;
      for (const iteration of job.iteration_history ?? []) {
        for (const [stepId, stepValue] of Object.entries(iteration.steps)) {
          this.syncPipelineStep({
            executionId: state.id,
            pipelineId: state.pipeline_id,
            pipelineName: state.pipeline_snapshot.name,
            projectId: state.project_id,
            worktreeId: state.worktree_id,
            jobId,
            stepId,
            attempt: currentAttempt,
            iteration: iteration.iteration,
            step: stepValue,
            modelConfig: mergeAgentModelConfig(
              state.model_config,
              stepValue.agent_model_config ?? {},
            ),
          });
        }
      }
      // At an iteration boundary the executor persists an intermediate state in
      // which `iteration_count` has already advanced to N+1 while `job.steps`
      // still holds iteration N's terminal results: `job-runner.ts` pushes the
      // snapshot into `iteration_history`, advances the count, sets
      // `status: 'restarting'` and calls `saveState()` BEFORE
      // `resetJobForRestart` clears `job.steps`. Every save emits
      // `execution.updated` into this method, so syncing the live steps in that
      // window would key iteration N's already-recorded result to iteration N+1
      // and mint a phantom terminal entry with no usage — which
      // `getAgentWorkByUser` counts as a real agent turn.
      //
      // Nothing is lost by skipping: those results were just snapshotted above,
      // and `resetJobForRestart` clears `job.steps` immediately afterward.
      //
      // This keys on the status string, so it depends on nothing rewriting a
      // `restarting` job's status while leaving the duplicated `job.steps` in
      // place. `markRemainingJobsCancelled` rewrites non-terminal jobs to
      // `cancelled`, but none of its call sites can observe a live `restarting`
      // job today. If that changes, this guard and its twin in
      // `pipeline-usage-events.ts` must become structural (compare the last
      // `iteration_history` entry against `job.steps`) rather than status-based.
      if (job.status !== 'restarting') {
        for (const [stepId, stepValue] of Object.entries(job.steps)) {
          this.syncPipelineStep({
            executionId: state.id,
            pipelineId: state.pipeline_id,
            pipelineName: state.pipeline_snapshot.name,
            projectId: state.project_id,
            worktreeId: state.worktree_id,
            jobId,
            stepId,
            attempt: currentAttempt,
            iteration: job.iteration_count,
            step: stepValue,
            modelConfig: mergeAgentModelConfig(
              state.model_config,
              stepValue.agent_model_config ?? {},
            ),
          });
        }
      }
    }
  }

  private rootPipelineExecutionIdFor(executionId: string): string | undefined {
    const state = this.pipelineExecutionLineage.get(executionId);
    if (!state || state.parent_execution_id === undefined) return undefined;
    const parentChain: PipelineExecutionLineage[] = [];
    const visited = new Set([state.id]);
    let parentExecutionId: string | undefined = state.parent_execution_id;
    while (parentExecutionId !== undefined) {
      if (visited.has(parentExecutionId)) return undefined;
      visited.add(parentExecutionId);
      const parent = this.pipelineExecutionLineage.get(parentExecutionId);
      if (!parent) return undefined;
      parentChain.push(parent);
      parentExecutionId = parent.parent_execution_id;
    }
    return getNestedRootPipelineExecutionId(state, parentChain);
  }

  private refreshPipelineRootIds(): void {
    const openEntryIds = new Set<string>();
    for (const [key, openEntry] of Array.from(this.openEntries.entries())) {
      const entry = openEntry.entry;
      if (
        (entry.eventType !== 'pipeline_agent_turn' &&
          entry.eventType !== 'pipeline_advisor') ||
        !entry.pipelineExecutionId
      ) {
        continue;
      }
      openEntryIds.add(entry.id);
      const rootPipelineExecutionId = this.rootPipelineExecutionIdFor(
        entry.pipelineExecutionId,
      );
      if (
        rootPipelineExecutionId &&
        rootPipelineExecutionId !== entry.rootPipelineExecutionId
      ) {
        entry.rootPipelineExecutionId = rootPipelineExecutionId;
        if (this.retainedPipelineEntriesByKey.has(key)) {
          this.retainedPipelineEntriesByKey.set(key, entry);
        }
        this.upsertRecentEntry(entry);
      }
    }

    for (const entry of this.recentEntries) {
      if (
        openEntryIds.has(entry.id) ||
        (entry.eventType !== 'pipeline_agent_turn' &&
          entry.eventType !== 'pipeline_advisor') ||
        !entry.pipelineExecutionId
      ) {
        continue;
      }
      const rootPipelineExecutionId = this.rootPipelineExecutionIdFor(
        entry.pipelineExecutionId,
      );
      if (
        !rootPipelineExecutionId ||
        rootPipelineExecutionId === entry.rootPipelineExecutionId
      ) {
        continue;
      }
      const updatedEntry = { ...entry, rootPipelineExecutionId };
      this.enqueueAuditEntry(updatedEntry);
      this.upsertRecentEntry(updatedEntry);
      for (const [key, retainedEntry] of Array.from(
        this.retainedPipelineEntriesByKey.entries(),
      )) {
        if (retainedEntry.id === updatedEntry.id) {
          this.retainedPipelineEntriesByKey.set(key, updatedEntry);
        }
      }
    }

    const recentEntryIds = new Set(this.recentEntries.map((entry) => entry.id));
    for (const [key, entry] of Array.from(
      this.retainedPipelineEntriesByKey.entries(),
    )) {
      if (
        openEntryIds.has(entry.id) ||
        recentEntryIds.has(entry.id) ||
        (entry.eventType !== 'pipeline_agent_turn' &&
          entry.eventType !== 'pipeline_advisor') ||
        !entry.pipelineExecutionId
      ) {
        continue;
      }
      const rootPipelineExecutionId = this.rootPipelineExecutionIdFor(
        entry.pipelineExecutionId,
      );
      if (
        !rootPipelineExecutionId ||
        rootPipelineExecutionId === entry.rootPipelineExecutionId
      ) {
        continue;
      }
      const updatedEntry = { ...entry, rootPipelineExecutionId };
      this.retainedPipelineEntriesByKey.set(key, updatedEntry);
      this.enqueueAuditEntry(updatedEntry);
      this.upsertRecentEntry(updatedEntry);
    }
  }

  /** Content-free counters for output that cannot be matched to a live step. */
  getPipelineOutputDiagnostics(): {
    droppedOutputChunks: number;
    droppedOutputBytes: number;
  } {
    return {
      droppedOutputChunks: this.droppedPipelineOutputChunks,
      droppedOutputBytes: this.droppedPipelineOutputBytes,
    };
  }

  observePipelineOutput(event: {
    executionId: string;
    jobId: string;
    stepId: string;
    attempt: number;
    iteration?: number;
    data: string;
  }): void {
    const key = buildPipelineStepObservabilityKey(event);
    const openEntry = this.openEntries.get(key);
    if (!openEntry) {
      this.droppedPipelineOutputChunks += 1;
      this.droppedPipelineOutputBytes += Buffer.byteLength(event.data, 'utf8');
      this.pipelineOutputBuffers.delete(key);
      return;
    }

    const buffered = this.pipelineOutputBuffers.get(key) ?? '';
    const normalized = `${buffered}${event.data}`
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const trailingFragment = normalized.endsWith('\n')
      ? ''
      : (lines.pop() ?? '');
    if (trailingFragment.length > 0) {
      this.pipelineOutputBuffers.set(key, trailingFragment);
    } else {
      this.pipelineOutputBuffers.delete(key);
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const parsed = safeJsonParse(trimmed);
      if (!parsed) {
        continue;
      }

      if (
        (parsed.type === 'agent_loop_event' ||
          typeof readNumber(parsed, 'iteration') === 'number') &&
        isRecord(parsed.event)
      ) {
        const normalizedEvent: Record<string, unknown> =
          parsed.type === 'agent_loop_event'
            ? parsed
            : {
                type: 'agent_loop_event',
                iteration: readNumber(parsed, 'iteration'),
                event: parsed.event,
              };
        this.appendTranscriptRecord(key, normalizedEvent);
        const iteration = readNumber(normalizedEvent, 'iteration');
        if (
          iteration !== undefined &&
          iteration !== openEntry.agentLoopIteration
        ) {
          openEntry.agentLoopIteration = iteration;
          // Each iteration is a fresh query whose running total starts at 0.
          if (openEntry.entry.provider === 'claude') {
            getClaudeSessionCostLedger().noteConversationReset(key);
          }
        }
        this.observeClaudeEvent(
          key,
          parsed.event,
          openEntry.entry.provider === 'ollama' ? 'ollama' : 'claude',
        );
        continue;
      }
      if (
        openEntry.entry.provider === 'opencode' ||
        openEntry.entry.provider === 'antigravity' ||
        openEntry.entry.provider === 'copilot'
      ) {
        const provider = openEntry.entry.provider;
        if (parsed.type === 'canopy_assistant_patch') {
          if (parsed.provider === provider && isAssistantPatch(parsed)) {
            this.appendTranscriptRecord(key, parsed);
            if (parsed.role !== 'system')
              this.observeCursorPatch(openEntry, parsed);
          }
        } else if (isClaudeEventShape(parsed)) {
          this.appendTranscriptRecord(key, parsed);
          this.observeClaudeEvent(key, parsed, provider);
        }
        continue;
      }
      if (openEntry.entry.provider === 'cursor') {
        // Cursor pipeline steps stream the same tagged
        // canopy_assistant_patch/canopy_cursor_usage lines as interactive
        // Cursor chat (cursor-prompt-runner.ts's `emit`), but this pipeline
        // ingestion path previously had no case for them, so a Cursor step's
        // transcript, message/tool counts, and token usage were all silently
        // dropped. The event handling below follows observeChatEvent's Cursor
        // branch, but deliberately does MORE than it: this path also applies
        // the turn's token counters to the entry, which the chat branch does
        // not. That asymmetry is intentional and documented in
        // docs/cursor-chat.md — a pipeline step is exactly one bounded turn,
        // so its latest response snapshot IS the step's total, whereas an
        // interactive chat spans many turns, forks, and resumes that one
        // snapshot cannot represent. It includes
        // the branch's explicit handling of the Claude-shaped
        // `result`/`system` (init)/`error` lines Cursor's headless host also
        // emits — those
        // types satisfy isClaudeEventShape below, which would otherwise
        // reset entry.provider back to 'claude' via observeClaudeEvent.
        if (parsed.type === 'canopy_cursor_usage') {
          const reported = parseCursorReportedUsage(parsed.usage);
          if (parsed.usage === null || reported) {
            this.appendTranscriptRecord(key, {
              type: 'canopy_cursor_usage',
              provider: 'cursor',
              usage: reported ?? null,
            });
          }
          if (reported) {
            // Cursor reports the latest snapshot for the turn, not a delta
            // (see CursorReportedUsage), so the audit tokens are SET to the
            // newest report rather than accumulated, mirroring how
            // usageToHelperUsage uses only the turn's last usage event.
            //
            // Cursor's `inputTokens` already includes cache reads/writes
            // (parseCursorReportedUsage enforces
            // `cacheReadTokens + cacheWriteTokens <= inputTokens`), unlike
            // Claude, where input and cache are independent counters. Codex
            // is actually the same shape as Cursor here (OpenAI's
            // `input_tokens` also includes the cached portion — see
            // `openai-pricing/cost-calculator.ts`'s `uncachedInput`
            // subtraction), but that pre-existing behavior is out of scope
            // for this fix. The Usage page sums input + output + cache into
            // one total for every provider, so storing the raw inputTokens
            // here would double-count the cached portion; store the
            // non-cached remainder instead so the shared total formula
            // stays correct.
            const cachePortion =
              (reported.cacheReadTokens ?? 0) +
              (reported.cacheWriteTokens ?? 0);
            openEntry.entry.tokens.input = reported.inputTokens - cachePortion;
            openEntry.entry.tokens.output = reported.outputTokens;
            if (reported.cacheReadTokens !== undefined) {
              openEntry.entry.tokens.cacheReadInputTokens =
                reported.cacheReadTokens;
            }
            if (reported.cacheWriteTokens !== undefined) {
              openEntry.entry.tokens.cacheCreationInputTokens =
                reported.cacheWriteTokens;
            }
            this.upsertRecentEntry(openEntry.entry);
          }
          continue;
        }
        if (parsed.type === 'canopy_assistant_patch') {
          if (parsed.provider === 'cursor' && isAssistantPatch(parsed)) {
            this.appendTranscriptRecord(key, parsed);
            if (parsed.role !== 'system')
              this.observeCursorPatch(openEntry, parsed);
          }
          continue;
        }
        if (parsed.type === 'result') {
          if (
            typeof parsed.is_error === 'boolean' &&
            typeof parsed.result === 'string'
          ) {
            this.appendTranscriptRecord(key, parsed);
          }
          continue;
        }
        if (parsed.type === 'system' && parsed.subtype === 'init') {
          const sessionId = readString(parsed, 'session_id');
          if (sessionId) {
            openEntry.entry.sdkSessionId = sessionId;
            this.upsertRecentEntry(openEntry.entry);
          }
          continue;
        }
        if (parsed.type === 'error') {
          const message =
            readString(parsed, 'error') ?? readString(parsed, 'message');
          if (message) {
            this.appendTranscriptRecord(key, {
              type: 'error',
              message,
              provider: 'cursor',
              error: message,
            });
          }
          continue;
        }
      }
      if (
        parsed.type === 'agent_loop_iteration' ||
        parsed.type === 'canopy_user_prompt' ||
        parsed.type === 'canopy_injected_prompt' ||
        parsed.type === 'claude_terminal_projected_messages' ||
        parsed.type === 'canopy_transcript_truncated'
      ) {
        this.appendTranscriptRecord(key, parsed);
        continue;
      }
      if (isCodexEventShape(parsed)) {
        this.appendTranscriptRecord(key, parsed);
        continue;
      }
      if (isClaudeEventShape(parsed)) {
        this.appendTranscriptRecord(key, parsed);
        this.observeClaudeEvent(
          key,
          parsed,
          openEntry.entry.provider === 'ollama' ? 'ollama' : 'claude',
        );
      }
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }

    this.flushWindowStartedAt = null;
    this.scheduledWriteBytes = 0;

    // A thrown persistence task is a failure until runFlush explicitly
    // reports otherwise; never arm an automatic retry for an unknown error.
    let failed = true;
    const flushPromise = this.enqueuePersistenceTask(
      async (): Promise<void> => {
        failed = await this.runFlush();
      },
    );
    this.flushPromise = flushPromise;
    try {
      await flushPromise;
    } finally {
      if (this.flushPromise === flushPromise) {
        this.flushPromise = null;
        if (this.flushWindowStartedAt !== null) {
          if (!this.hasPendingWrites()) {
            this.flushWindowStartedAt = null;
            this.scheduledWriteBytes = 0;
          } else if (!failed && !this.disposing) {
            this.scheduleFlush();
          }
        }
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    await this.storedStateLoad?.catch((): void => undefined);
    if (this.costHistoryRepairTimer) {
      clearTimeout(this.costHistoryRepairTimer);
      this.costHistoryRepairTimer = null;
    }
    this.clearClaudeUsageRefreshDebounce();
    this.managedDelegationCapture.dispose();
    this.claudeTaskTrackers.clear();
    this.unsubscribeCursorRollout?.();
    this.unsubscribeCursorRollout = null;
    this.invalidateCursorUsage();
    this.unsubscribeCopilotUsage?.();
    this.unsubscribeCopilotUsage = null;
    this.unsubscribeOpenCodeAccounts?.();
    this.unsubscribeOpenCodeAccounts = null;
    this.unsubscribeAccountProxyResponses?.();
    this.unsubscribeAccountProxyResponses = null;
    this.unsubscribeAccountProxyInventory?.();
    this.unsubscribeAccountProxyInventory = null;
    this.accountProxyQuotaUsage.dispose();
    const copilotRefresh = this.copilotUsageRefresh?.done;
    this.invalidateCopilotUsage();
    await copilotRefresh;
    for (const key of Array.from(this.openEntries.keys())) {
      this.finalizeOpenEntry(key, 'interrupted', 'Application shutdown');
    }
    this.codexSubagentUsageByChat.clear();
    this.codexPipelineSubagentTrackerKeys.clear();
    for (const queryId of Array.from(this.claudeQueryIds))
      this.endClaudeQuery(queryId);
    await getClaudeSessionCostLedger()
      .flush()
      .catch(() => undefined);
    this.codexMonitor?.dispose();
    this.codexMonitor = null;
    await Promise.allSettled(
      Array.from(this.pendingFinalizedTranscriptAppends),
    );
    await this.flush();
  }

  private enqueuePersistenceTask<T>(task: () => Promise<T>): Promise<T> {
    const runTask = this.persistenceQueue.then(task, task);
    this.persistenceQueue = runTask.then(
      (): void => undefined,
      (): void => undefined,
    );
    return runTask;
  }

  private syncPipelineStep(options: {
    executionId: string;
    pipelineId: string;
    pipelineName: string;
    projectId?: string;
    worktreeId?: string;
    jobId: string;
    stepId: string;
    attempt: number;
    iteration?: number;
    step: StepResult;
    modelConfig?: AgentModelConfig;
  }): void {
    const key = buildPipelineStepObservabilityKey(options);
    const status = options.step.status;
    const isTerminalStatus =
      status === 'success' ||
      status === 'failure' ||
      status === 'cancelled' ||
      status === 'skipped';
    const provider = options.step.agent_provider;
    const logFormatHint = options.step.log_format_hint;
    const identity = observedModelIdentity({
      model:
        options.step.agent_runtime_model ??
        options.step.agent_model_config?.baseModel ??
        options.step.agent_model,
      agentId: options.step.agent_model_config?.agentId,
      requestedModel:
        options.step.agent_model_config?.requestedModel ??
        options.step.agent_model,
    });
    const model = identity.model;
    const shouldTrack =
      provider === undefined
        ? logFormatHint === 'agent'
        : isTrackedPipelineProvider(provider);

    if (!shouldTrack) {
      return;
    }

    const startedAt = options.step.started_at ?? new Date().toISOString();
    if (!this.openEntries.has(key)) {
      // The in-process finalized set is only a fast path. On restart the
      // canonical audit row may have a different startedAt from the executor's
      // eventual StepResult (metadata was published before that timestamp).
      // Match the whole stable step key, including attempt and iteration,
      // rather than inventing a second, empty row for terminal replay.
      // shortcut: restart deduplication sees only the recent 200 audit entries,
      // upgrade to a compact durable identity index when older terminal replay
      // needs deduplication; do not scan audit days on the startup hot path.
      const recorded =
        this.retainedPipelineEntriesByKey.get(key) ??
        this.recentEntries.find(
          (entry) =>
            entry.eventType === 'pipeline_agent_turn' &&
            entry.id.startsWith(`${key}:`),
        );
      if (isTerminalStatus && recorded && recorded.status !== 'running') {
        this.finalizedPipelineStepKeys.add(key);
        this.observedTaskEntryIdsByKey.set(key, recorded.id);
        return;
      }
      if (isTerminalStatus && this.finalizedPipelineStepKeys.has(key)) {
        return;
      }

      const entry: AgentAuditEntry = {
        id: `${key}:${startedAt}`,
        eventType: 'pipeline_agent_turn',
        status: 'running',
        // Legacy agent steps omit the provider; explicit unknown values were
        // rejected above and must never acquire Claude account metadata.
        provider: provider ?? 'claude',
        modelSource: model ? getModelSource(model) : undefined,
        executionHarness:
          options.step.agent_harness ??
          (model ? getExecutionHarnessForModel(model) : undefined),
        label: labelForEventType('pipeline_agent_turn'),
        startedAt,
        ...identity,
        serviceTier:
          options.step.agent_harness === 'codex' || provider === 'codex'
            ? codexServiceTierForModelConfig(options.modelConfig)
            : undefined,
        tokens: defaultTokens(),
        messageCount: 0,
        assistantMessageCount: 0,
        toolUseCount: 0,
        subAgentCount: 0,
        hasTranscript: false,
        toolCounts: defaultToolCounts(),
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        pipelineId: options.pipelineId,
        pipelineName: options.pipelineName,
        pipelineExecutionId: options.executionId,
        jobId: options.jobId,
        stepId: options.stepId,
        attempt: options.attempt,
        linkTarget: {
          page: 'pipelines',
          kind: 'pipeline-execution',
          pipelineExecutionId: options.executionId,
        },
      };
      if (recorded) {
        Object.assign(entry, recorded, { status: 'running' });
        delete entry.completedAt;
        delete entry.error;
        // Earlier versions recorded agent-hinted Copilot steps as Claude. The
        // step's explicit provider wins, without the other account's stamp.
        if (provider !== undefined && entry.provider !== provider) {
          entry.provider = provider;
          delete entry.providerAccountKey;
          delete entry.providerAccountEmail;
          delete entry.providerPlanType;
        }
      }
      if (entry.provider === 'claude') {
        // builtin/agent-resume's resolved input is not in StepResult. Its
        // returned session_id reuses the earlier attempt's durable ledger row.
        const resumeSessionId = options.step.agent_recovery?.session_id?.trim();
        this.beginClaudeQuery(
          key,
          resumeSessionId
            ? { sessionId: resumeSessionId, fork: false }
            : undefined,
        );
      }
      this.startObservedTask(key, entry);
    }

    const openEntry = this.openEntries.get(key);
    if (!openEntry) {
      return;
    }

    if (model) {
      Object.assign(openEntry.entry, identity);
    }
    if (options.step.agent_harness === 'codex' || provider === 'codex') {
      openEntry.entry.serviceTier = codexServiceTierForModelConfig(
        options.modelConfig,
      );
    }

    if (options.step.outputs[AI_CREDITS_ROUTED_OUTPUT_KEY] === 'true') {
      openEntry.entry.aiCreditsRouted = true;
    }
    if (options.step.outputs[MODEL_GATEWAY_ROUTED_OUTPUT_KEY] === 'true') {
      openEntry.entry.modelGatewayRouted = true;
    }
    if (options.step.outputs[ACCOUNT_PROXY_ROUTED_OUTPUT_KEY] === 'true') {
      this.markObservedTaskAccountProxyRouted(key);
      // Each attempt has a route of its own, so the route's whole count is
      // the step's.
      const routeSessionId =
        options.step.outputs[ACCOUNT_PROXY_SESSION_OUTPUT_KEY];
      const usage = routeSessionId
        ? this.host.accountProxy.sessionUsage(routeSessionId)
        : null;
      if (routeSessionId && usage) {
        // Reading a route again replaces its count, never adds to it.
        const routes =
          openEntry.accountProxyRoutes ??
          new Map<string, AgentAuditAccountProxyUsage>();
        routes.delete(routeSessionId);
        routes.set(routeSessionId, usage);
        openEntry.accountProxyRoutes = routes;
        openEntry.entry.accountProxy = mergeAccountProxyUsages(
          Array.from(routes.values()),
        );
      }
    }

    const outputSessionId = options.step.outputs.session_id?.trim();
    if (outputSessionId) {
      openEntry.entry.sdkSessionId = outputSessionId;
    }

    if (isTerminalStatus) {
      const error = options.step.error;
      const completedAt = options.step.completed_at;
      if (completedAt) {
        openEntry.entry.completedAt = completedAt;
      }
      const mappedStatus: AgentAuditStatus =
        status === 'success'
          ? 'success'
          : status === 'failure'
            ? 'failure'
            : status === 'cancelled'
              ? 'cancelled'
              : 'interrupted';
      this.finalizeOpenEntry(key, mappedStatus, error);
    }
  }

  private countToolUse(
    entry: AgentAuditEntry,
    toolName: string,
    input: string,
  ): void {
    if (
      toolName === 'EnterPlanMode' ||
      toolName === 'ExitPlanMode' ||
      toolName === 'TaskOutput'
    ) {
      return;
    }

    entry.toolUseCount += 1;
    if (toolName === 'Task' || toolName === 'Agent') {
      if (entry.provider !== 'claude') entry.subAgentCount += 1;
      entry.toolCounts.agent += 1;
      return;
    }

    if (toolName === 'file_change') {
      const lines = input
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      if (lines.length === 0) {
        entry.toolCounts.fileEdit += 1;
        return;
      }
      for (const line of lines) {
        const match = line.match(/^(\w+):\s*.+$/);
        const kind = match?.[1]?.toLowerCase();
        if (kind === 'delete') {
          entry.toolCounts.fileDelete += 1;
        } else if (kind === 'add' || kind === 'create') {
          entry.toolCounts.fileAdd += 1;
        } else {
          entry.toolCounts.fileEdit += 1;
        }
      }
      return;
    }

    const category = getToolCategory(toolName);
    entry.toolCounts[category] += 1;
  }

  private finalizeOpenEntry(
    key: string,
    status: AgentAuditStatus,
    error?: string,
    options?: { setupFailure?: boolean },
  ): void {
    const openEntry = this.openEntries.get(key);
    if (!openEntry) {
      return;
    }

    this.updateCodexSubagentAudit(openEntry);
    openEntry.codexSubagentUsageTracker?.endEntry();
    this.openEntries.delete(key);
    if (key.startsWith('chat:')) {
      this.finalizedChatEntryIdsInProcess.add(openEntry.entry.id);
      skillSuggestionTurnRecorder.complete(key, openEntry.entry.id, status);
    }
    if (!key.startsWith('chat:') && openEntry.entry.provider === 'claude') {
      this.endClaudeQuery(key);
      this.claudeTaskTrackers.delete(key);
    }
    this.pipelineOutputBuffers.delete(key);
    if (key.startsWith('pipeline:')) {
      this.finalizedPipelineStepKeys.add(key);
      this.codexPipelineSubagentTrackerKeys.delete(key);
    }
    openEntry.entry.status = status;
    openEntry.entry.completedAt =
      openEntry.entry.completedAt ?? new Date().toISOString();
    const completedAtMs = new Date(openEntry.entry.completedAt).getTime();
    const startedAtMs = new Date(openEntry.entry.startedAt).getTime();
    const openPauseMs =
      openEntry.currentPauseStartedAtMs === undefined
        ? 0
        : Math.max(0, completedAtMs - openEntry.currentPauseStartedAtMs);
    // The canonical turn reducer is the one source of a chat turn's duration
    // (CAN-5096); the audit's own pause tally is the fallback when no
    // matching canonical record reached this entry.
    const canonical =
      key.startsWith('chat:') && openEntry.canonicalDurations
        ? Array.from(openEntry.canonicalDurations.values()).reduce(
            (sum, turn) => ({
              durationMs: sum.durationMs + turn.durationMs,
              pausedMs: sum.pausedMs + turn.pausedMs,
            }),
            { durationMs: 0, pausedMs: 0 },
          )
        : undefined;
    const pausedDurationMs =
      canonical?.pausedMs ?? openEntry.pausedDurationMs + openPauseMs;
    const providerSuppliedDuration = openEntry.entry.durationMs !== undefined;
    const rawDurationMs =
      openEntry.entry.durationMs ?? Math.max(0, completedAtMs - startedAtMs);
    openEntry.entry.durationMs =
      canonical?.durationMs ?? Math.max(0, rawDurationMs - pausedDurationMs);
    // Keep the locally recorded value for audit-trail fidelity — the wire
    // mapper is what omits it — but leave a trail naming the inputs, because a
    // multi-day duration is always a bug somewhere upstream and we could not
    // tell a stale `startedAt` from a bogus provider `duration_ms` after the
    // fact (CAN-3106).
    if (
      openEntry.entry.durationMs > MAX_TELEMETRY_TURN_DURATION_MS &&
      openEntry.entry.projectId &&
      openEntry.entry.worktreeId
    ) {
      this.recordSessionDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'implausible_turn_duration',
        sessionKey: key,
        projectId: openEntry.entry.projectId,
        worktreeId: openEntry.entry.worktreeId,
        chatId: openEntry.entry.chatId ?? '',
        providerType: openEntry.entry.provider,
        eventType: openEntry.entry.eventType,
        implausibleDurationMs: openEntry.entry.durationMs,
        implausibleDurationStartedAt: openEntry.entry.startedAt,
        implausibleDurationCompletedAt: openEntry.entry.completedAt,
        implausibleDurationPausedMs: pausedDurationMs,
        implausibleDurationProviderSupplied: providerSuppliedDuration,
      });
    }
    if (error) {
      openEntry.entry.error = error;
    }

    this.stampProviderAccountIdentity(
      openEntry.entry,
      openEntry.providerAccountIdentity,
    );
    if (openEntry.entry.billingBasis !== undefined) {
      openEntry.entry.billingBasis = billingBasisAtEntryStart(
        openEntry.entry.provider,
        openEntry.billingAccountKind,
        openEntry.entry.aiCreditsRouted === true,
        openEntry.entry.modelGatewayRouted === true ||
          usedOrganizationGateway(openEntry.entry),
        openEntry.accountProxyRouted === true,
      );
    }

    if (openEntry.entry.modelGatewayRouted === true) {
      delete openEntry.entry.totalCostUsd;
      delete openEntry.entry.observedCost;
    }

    if (
      openEntry.entry.provider === 'codex' &&
      openEntry.entry.modelGatewayRouted !== true &&
      // A restored or revived entry's estimate predates any new usage.
      (openEntry.entry.observedCost === undefined || openEntry.usageObserved)
    ) {
      const observedCost = computeCodexObservedCost(
        {
          model: openEntry.entry.model,
          serviceTier: openEntry.entry.serviceTier,
          usageObserved: openEntry.usageObserved,
          tokens: openEntry.entry.tokens,
          billableToolCounts: openEntry.entry.billableToolCounts,
          ...codexLongContextCostInput(openEntry),
        },
        this.host.pricing.current(),
      );
      openEntry.entry.observedCost = observedCost;
      if (typeof observedCost.totalUsd === 'number') {
        openEntry.entry.totalCostUsd = observedCost.totalUsd;
      } else {
        delete openEntry.entry.totalCostUsd;
      }
    }

    if (openEntry.entry.modelRouting !== undefined) {
      const attribution = openEntry.entry.modelRouting;
      // The benchmark stays on one model, so it reads any context a switch
      // made the selected model re-read uncached from its warm cache instead.
      const benchmarkUsage = benchmarkModelRoutingUsage(
        {
          input: openEntry.entry.tokens.input,
          output: openEntry.entry.tokens.output,
          cacheReadInput: openEntry.entry.tokens.cacheReadInputTokens,
          cacheCreationInput: openEntry.entry.tokens.cacheCreationInputTokens,
        },
        attribution.cacheMissContextTokens,
      );
      const benchmarkTokens = {
        ...openEntry.entry.tokens,
        cacheReadInputTokens: benchmarkUsage.cacheReadInput,
        cacheCreationInputTokens: benchmarkUsage.cacheCreationInput,
      };
      let benchmark:
        | {
            status: 'priced';
            costUsd: number;
            pricingRevision: string;
          }
        | { status: 'unpriced_model' }
        | undefined;
      if (
        attribution.benchmarkModelId !== undefined &&
        (openEntry.entry.executionHarness === 'codex' ||
          openEntry.entry.provider === 'codex')
      ) {
        const pricingState = this.host.pricing.current();
        const benchmarkCost = computeCodexObservedCost(
          {
            model: attribution.benchmarkModelId,
            serviceTier: openEntry.entry.serviceTier,
            usageObserved: openEntry.usageObserved,
            tokens: benchmarkTokens,
            billableToolCounts: openEntry.entry.billableToolCounts,
            // The same requests ran on the benchmark, so the same ones are
            // long, with the same cache adjustment as the totals.
            ...benchmarkLongContextCostInput(
              openEntry,
              attribution.cacheMissContextTokens,
            ),
          },
          pricingState,
        );
        benchmark =
          benchmarkCost.status === 'priced' &&
          benchmarkCost.totalUsd !== undefined &&
          pricingState.payload !== undefined
            ? {
                status: 'priced',
                costUsd: benchmarkCost.totalUsd,
                pricingRevision: `openai-v1:${pricingState.payload.source.fetchedAt}`,
              }
            : { status: 'unpriced_model' };
      } else if (attribution.benchmarkModelId !== undefined) {
        const benchmarkCost = priceModelRoutingUsage(
          attribution.benchmarkModelId,
          benchmarkUsage,
        );
        benchmark =
          benchmarkCost.status === 'priced'
            ? {
                status: 'priced',
                costUsd: benchmarkCost.costUsd,
                pricingRevision: benchmarkCost.pricingRevision,
              }
            : benchmarkCost;
      }
      openEntry.entry.modelRouting = finalizeModelRoutingSavings({
        attribution,
        usageComplete: openEntry.usageObserved,
        ...(openEntry.entry.totalCostUsd !== undefined
          ? { selectedExecutionCostUsd: openEntry.entry.totalCostUsd }
          : {}),
        // Desktop provider telemetry reprices observed usage locally. It is an
        // API-equivalent estimate even when the provider request ran through
        // AI Credits; only the cloud billing receipt owns `gateway_actual`.
        // The shared finalizer therefore records AI Credits desktop turns as
        // incomparable instead of publishing a false actual-cost claim.
        selectedCostBasis: 'api_equivalent',
        ...(benchmark ? { benchmark } : {}),
      });
    }

    finishAuditOperation(
      this.host,
      key,
      openEntry.entry,
      status,
      key.startsWith('chat:')
        ? {
            trigger: openEntry.turnTrigger ?? 'unknown',
            ...resolveChatTurnFailures(openEntry, status, error, options),
          }
        : undefined,
    );

    const transcriptState = this.transcriptStates.get(key);
    if (transcriptState) {
      transcriptState.closed = true;
      transcriptState.finalizedEntry = { ...openEntry.entry };
    }

    this.recordChatTurnCompletedUsageEvent(openEntry.entry);
    this.enqueueAuditEntry(openEntry.entry);
    this.upsertRecentEntry(openEntry.entry);
    this.scheduleTerminalProviderUsageRefresh(openEntry.entry);
    void this.flush();
  }

  /**
   * Snapshot the provider identity at entry-start and then fire-and-forget a
   * cache warm for future entries. The snapshot is generation-bound to the
   * turn: a passive account transition may preserve the active session while
   * replacing the global auth cache.
   */
  private captureProviderStartSnapshot(
    provider: AgentProviderType,
    accountProxyRouted = false,
  ): {
    providerAccountIdentity: ProviderAccountIdentity | null;
    billingAccountKind: ProviderBillingAccountKind;
  } {
    // A proxy account served the turn, not the user's own login.
    if (accountProxyRouted) {
      return { providerAccountIdentity: null, billingAccountKind: 'unknown' };
    }
    if (provider === 'claude' || provider === 'codex') {
      const providerAccountIdentity = this.host.accounts.peekIdentity(provider);
      const billingAccountKind =
        this.host.accounts.peekBillingAccountKind(provider);
      this.host.accounts.warmIdentity(provider, 'audit-entry-start');
      return { providerAccountIdentity, billingAccountKind };
    }
    return {
      providerAccountIdentity: null,
      billingAccountKind: 'unknown',
    };
  }

  /**
   * Stamp the entry-start provider subscription snapshot at finalize time.
   * Skips AI-Credits-routed runs (those are billed to UD credits, not a native
   * subscription) and entries already stamped. When the auth cache was not
   * filled at entry-start, the entry stays unattributed rather than risking
   * attribution to an account observed during the turn.
   */
  private stampProviderAccountIdentity(
    entry: AgentAuditEntry,
    identity: ProviderAccountIdentity | null,
  ): void {
    if (entry.aiCreditsRouted === true) {
      return;
    }
    if (entry.providerAccountKey !== undefined) {
      return;
    }
    if (!identity) {
      return;
    }
    entry.providerAccountKey = identity.providerAccountKey;
    entry.providerAccountEmail = identity.accountEmail;
    if (identity.planType) {
      entry.providerPlanType = identity.planType;
    }
  }

  private recordChatTurnCompletedUsageEvent(entry: AgentAuditEntry): void {
    if (
      entry.eventType !== 'worktree_chat' &&
      entry.eventType !== 'standalone_chat' &&
      entry.eventType !== 'app_advisor' &&
      entry.eventType !== 'pipeline_editor'
    ) {
      return;
    }
    if (!entry.projectId || !entry.worktreeId || !entry.chatId) {
      return;
    }

    const startedEvent = this.chatTurnUsageStartsByAuditEntryId.get(entry.id);
    const completedAt = entry.completedAt ?? new Date().toISOString();
    const completedEvent: ChatTurnUsageEvent = {
      version: 1,
      id: `chat-turn-completed:${entry.id}`,
      type: 'chat_turn_completed',
      timestamp: completedAt,
      workspaceId: entry.projectId,
      workspaceLabel: startedEvent?.workspaceLabel,
      worktreeId: entry.worktreeId,
      repoId: entry.repoId ?? startedEvent?.repoId,
      repoLabel: entry.repoLabel ?? startedEvent?.repoLabel,
      provider: entry.provider,
      initiationSource:
        startedEvent?.initiationSource ??
        (entry.eventType === 'app_advisor' ? 'app_advisor' : 'unknown'),
      chatId: entry.chatId,
      auditEntryId: entry.id,
      model: entry.model ?? startedEvent?.model,
      ...((entry.agentId ?? startedEvent?.agentId)
        ? { agentId: entry.agentId ?? startedEvent?.agentId }
        : {}),
      turnStartedAt: entry.startedAt,
      turnCompletedAt: completedAt,
      turnDurationMs: entry.durationMs,
      tokens: entry.tokens,
      totalCostUsd: entry.totalCostUsd,
      observedCost: entry.observedCost,
      toolUseCount: entry.toolUseCount,
      toolCounts: entry.toolCounts,
      status: entry.status,
      error: entry.error,
    };
    this.recordUsageMetricEvent(completedEvent);
    this.chatTurnUsageStartsByAuditEntryId.delete(entry.id);
  }

  private scheduleTerminalProviderUsageRefresh(entry: AgentAuditEntry): void {
    const provider = entry.provider;
    if (
      !this.started ||
      this.disposing ||
      (entry.eventType !== 'worktree_chat' &&
        entry.eventType !== 'standalone_chat' &&
        entry.eventType !== 'app_advisor') ||
      (provider !== 'claude' &&
        provider !== 'codex' &&
        provider !== 'cursor' &&
        provider !== 'copilot')
    ) {
      return;
    }

    if (provider === 'claude') {
      if (
        entry.billingBasis !== undefined &&
        entry.billingBasis !== 'subscription'
      ) {
        return;
      }
      this.scheduleClaudeUsageRefresh();
      return;
    }

    this.pendingProviderUsageRefreshes.add(provider);
    if (this.providerUsageRefreshes.has(provider)) {
      return;
    }

    this.runProviderUsageRefresh(provider);
  }

  private runProviderUsageRefresh(
    provider: RefreshableUsageProvider,
    claudeFreshnessMs?: number,
  ): void {
    const refreshPromise = (async (): Promise<void> => {
      while (
        !this.disposing &&
        this.pendingProviderUsageRefreshes.delete(provider)
      ) {
        // Each completed turn requests a refresh. Codex keeps its existing
        // newer-read behavior; Claude's account gate may join an HTTP read or
        // satisfy this from fresh timing while the newest auth version owns
        // publication.
        await this.startProviderUsageRefresh(provider, claudeFreshnessMs).catch(
          (): void => undefined,
        );
      }

      if (this.disposing) {
        this.pendingProviderUsageRefreshes.delete(provider);
      }
    })().finally((): void => {
      this.providerUsageRefreshes.delete(provider);
      if (this.disposing) {
        this.pendingProviderUsageRefreshes.delete(provider);
        return;
      }
      if (this.pendingProviderUsageRefreshes.has(provider)) {
        this.runProviderUsageRefresh(provider, claudeFreshnessMs);
      }
    });

    this.providerUsageRefreshes.set(provider, refreshPromise);
  }

  private scheduleClaudeUsageRefresh(): void {
    const trailingDelayMs = claudeUsageRefreshDelayMs(false);
    const maxWaitMs = claudeUsageRefreshDelayMs(true);
    let debounce = this.claudeUsageRefreshDebounce;
    if (debounce === null) {
      debounce = { trailing: null, maxWait: null };
      this.claudeUsageRefreshDebounce = debounce;
    }
    if (debounce.trailing !== null) clearTimeout(debounce.trailing);
    debounce.trailing = setTimeout(
      () => this.flushClaudeUsageRefreshDebounce(),
      trailingDelayMs,
    );
    if (debounce.maxWait === null) {
      debounce.maxWait = setTimeout(
        () => this.flushClaudeUsageRefreshDebounce(),
        maxWaitMs,
      );
    }
  }

  private flushClaudeUsageRefreshDebounce(): void {
    const debounce = this.claudeUsageRefreshDebounce;
    if (debounce === null) return;
    if (debounce.trailing !== null) clearTimeout(debounce.trailing);
    if (debounce.maxWait !== null) clearTimeout(debounce.maxWait);
    this.claudeUsageRefreshDebounce = null;
    if (this.disposing) {
      this.pendingProviderUsageRefreshes.delete('claude');
      return;
    }
    this.pendingProviderUsageRefreshes.add('claude');
    if (!this.providerUsageRefreshes.has('claude')) {
      this.runProviderUsageRefresh('claude', claudeUsageFreshnessMs(true));
    }
  }

  private clearClaudeUsageRefreshDebounce(): void {
    const debounce = this.claudeUsageRefreshDebounce;
    if (debounce !== null) {
      if (debounce.trailing !== null) clearTimeout(debounce.trailing);
      if (debounce.maxWait !== null) clearTimeout(debounce.maxWait);
      this.claudeUsageRefreshDebounce = null;
    }
    this.pendingProviderUsageRefreshes.delete('claude');
  }

  private upsertRecentEntry(entry: AgentAuditEntry): void {
    const nextEntries = this.recentEntries.filter(
      (existingEntry) => existingEntry.id !== entry.id,
    );
    nextEntries.push({ ...entry });
    nextEntries.sort(compareEntries);
    this.recentEntries = nextEntries.slice(0, RECENT_ENTRY_LIMIT);
    this.emit({ type: 'entries', entries: [entry] });
  }

  private recordActiveAccountSnapshot(summary: ProviderUsageSummary): void {
    if (summary.authState !== 'authenticated') {
      return;
    }
    const accountKey = computeAccountKey(
      summary.provider,
      summary.accountEmail,
      summary.subscriptionLabel,
    );
    if (!accountKey) {
      return;
    }
    if (!summary.rateLimits) {
      return;
    }
    this.retainedAccountSnapshots.set(accountKey, {
      provider: summary.provider,
      accountKey,
      accountEmail: summary.accountEmail,
      accountLabel: summary.accountLabel,
      subscriptionLabel: summary.subscriptionLabel,
      rateLimits: summary.rateLimits,
      capturedAt: new Date().toISOString(),
    });
    const pruned = pruneRetainedAccountSnapshots(
      Array.from(this.retainedAccountSnapshots.values()),
      Date.now(),
    );
    this.retainedAccountSnapshots = new Map(
      pruned.map((snapshot) => [snapshot.accountKey, snapshot]),
    );
  }

  private buildUsageOverview(): AgentUsageOverview {
    const accountSnapshots = pruneRetainedAccountSnapshots(
      Array.from(this.retainedAccountSnapshots.values()),
      Date.now(),
    );
    return {
      updatedAt: new Date().toISOString(),
      openCodeAccounts: this.host.openCode.peekAccounts(),
      providers: [
        { ...this.usageProviders.claude },
        { ...this.usageProviders.codex },
        ...(this.host.copilot.isEnabled() && this.copilotUsage
          ? [{ ...this.copilotUsage }]
          : []),
        ...(this.host.cursor.isEnabled() && this.cursorUsage
          ? [{ ...this.cursorUsage }]
          : []),
      ],
      accountSnapshots: accountSnapshots.filter(
        (snapshot) =>
          snapshot.provider !== 'cursor' || this.host.cursor.isEnabled(),
      ),
    };
  }

  private emit(event: AgentObservabilityUpdateEvent): void {
    for (const listener of Array.from(this.listeners)) {
      listener(event);
    }
  }

  private emitSnapshot(): void {
    this.emit({ type: 'snapshot', snapshot: this.loadSnapshot() });
  }

  private enqueueAuditEntry(
    entry: AgentAuditEntry,
    cause?: AuditEntryEnqueueCause,
  ): void {
    const pending = { ...entry };
    this.pendingPersistedEntries.push(pending);
    // A held plan event counts on the latest version of its pinned turn.
    for (const held of this.plansAwaitingCountedIds ?? []) {
      if (held.target?.entry.id === entry.id && held.target.entry !== entry) {
        held.target = { entry: { ...entry }, open: false };
      }
    }
    if (pending.eventType === 'managed_delegation') {
      this.managedDelegationAuditEntriesById.set(pending.id, pending);
      this.managedDelegationEntryIdsUpdatedInProcess.add(pending.id);
    }
    this.scheduleFlush(estimatePendingRecordBytes(pending));
    notifyAuditEntryEnqueued(pending, cause);
  }

  private scheduleFlush(addedBytes = 0): void {
    const now = Date.now();
    this.flushWindowStartedAt ??= now;
    this.scheduledWriteBytes += addedBytes;
    // The in-flight flush drains new records in its own bounded batches.
    // Keep one pending window without arming timers whose callbacks would all
    // await the same held write.
    if (this.flushPromise) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    const maxAgeRemaining = Math.max(
      0,
      this.flushWindowStartedAt + FLUSH_MAX_PENDING_AGE_MS - now,
    );
    const delay =
      this.scheduledWriteBytes >= FLUSH_BYTE_TRIGGER
        ? 0
        : Math.min(FLUSH_DEBOUNCE_MS, maxAgeRemaining);
    const timer = setTimeout(() => {
      void this.flush();
    }, delay);
    if (
      typeof timer === 'object' &&
      timer !== null &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref();
    }
    this.flushTimer = timer;
  }

  private async loadSnapshotFromDisk(): Promise<{
    recoveryCandidates: AgentAuditEntry[];
    snapshotMtimeMs: number;
  }> {
    const snapshotPath = getAgentObservabilitySnapshotPath();
    const entriesBeforeRead = [...this.recentEntries];
    try {
      const raw = await readFile(snapshotPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return { recoveryCandidates: [], snapshotMtimeMs: 0 };
      }

      const recentEntries = Array.isArray(parsed.recentEntries)
        ? parsed.recentEntries
            .map((value) => normalizeAuditEntry(value))
            .filter((value): value is AgentAuditEntry => value !== null)
        : [];
      recentEntries.sort(compareEntries);
      const retainedRestoredEntries = recentEntries
        .filter((entry) => this.isEntryWithinRetention(entry))
        .slice(0, RECENT_ENTRY_LIMIT);
      const entriesAtHydration = [...this.recentEntries];
      const memoryIds = new Set(
        [...entriesBeforeRead, ...entriesAtHydration].map((entry) => entry.id),
      );
      const mergedEntriesById = new Map(
        retainedRestoredEntries.map((entry) => [entry.id, entry]),
      );
      for (const entry of entriesAtHydration) {
        mergedEntriesById.set(entry.id, entry);
      }
      this.recentEntries = Array.from(mergedEntriesById.values())
        .filter((entry) => this.isEntryWithinRetention(entry))
        .sort(compareEntries)
        .slice(0, RECENT_ENTRY_LIMIT);
      const recoveryCandidates = retainedRestoredEntries.filter(
        (entry) =>
          entry.status === 'running' &&
          entry.eventType !== 'pipeline_agent_turn' &&
          entry.eventType !== 'managed_delegation' &&
          !memoryIds.has(entry.id) &&
          !this.isOpenEntryId(entry.id),
      );

      const usage = isRecord(parsed.usage) ? parsed.usage : null;
      const rawSnapshots =
        usage && Array.isArray(usage.accountSnapshots)
          ? usage.accountSnapshots
          : [];
      const hydrated = rawSnapshots
        .map((value) => normalizeRetainedAccountSnapshot(value))
        .filter(
          (value): value is RetainedAccountUsageSnapshot => value !== null,
        );
      const prunedHydrated = pruneRetainedAccountSnapshots(
        hydrated,
        Date.now(),
      );
      this.retainedAccountSnapshots = new Map(
        prunedHydrated.map((snapshot) => [snapshot.accountKey, snapshot]),
      );
      if (recoveryCandidates.length === 0) {
        return { recoveryCandidates, snapshotMtimeMs: 0 };
      }

      const snapshotStats = await stat(snapshotPath).catch(() => undefined);
      const stillRecoverable = recoveryCandidates.filter((entry) =>
        this.getRecoverableRunningEntry(entry.id),
      );
      return {
        recoveryCandidates: stillRecoverable,
        snapshotMtimeMs: snapshotStats?.mtimeMs ?? Date.now(),
      };
    } catch {
      return { recoveryCandidates: [], snapshotMtimeMs: 0 };
    }
  }

  private isOpenEntryId(id: string): boolean {
    return Array.from(this.openEntries.values()).some(
      (openEntry) => openEntry.entry.id === id,
    );
  }

  private getRecoverableRunningEntry(id: string): AgentAuditEntry | undefined {
    if (this.isOpenEntryId(id)) return undefined;
    return this.recentEntries.find(
      (entry) => entry.id === id && entry.status === 'running',
    );
  }

  private async recoverInterruptedEntries(
    candidates: readonly AgentAuditEntry[],
    snapshotMtimeMs: number,
  ): Promise<void> {
    if (candidates.length === 0) return;

    const candidateIdsByDay = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      const day = toIsoDay(candidate.startedAt);
      const ids = candidateIdsByDay.get(day) ?? new Set<string>();
      ids.add(candidate.id);
      candidateIdsByDay.set(day, ids);
    }

    const lastJournalRows = new Map<string, AgentAuditEntry>();
    for (const [day, candidateIds] of Array.from(candidateIdsByDay.entries())) {
      let contents = '';
      try {
        contents = await readFile(
          getAgentObservabilityAuditDayFilePath(day),
          'utf8',
        );
      } catch {
        // A missing or unreadable day file means there is no journal row to adopt.
      }
      const stillRecoverableIds = new Set<string>();
      candidateIds.forEach((id) => {
        if (this.getRecoverableRunningEntry(id)) {
          stillRecoverableIds.add(id);
        }
      });
      for (const line of contents.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const parsed = safeJsonParse(trimmed);
        const entry = parsed ? normalizeAuditEntry(parsed) : null;
        if (entry && stillRecoverableIds.has(entry.id)) {
          lastJournalRows.set(entry.id, entry);
        }
      }
    }

    const toSettle: AgentAuditEntry[] = [];
    for (const candidate of candidates) {
      if (!this.getRecoverableRunningEntry(candidate.id)) continue;
      const journalEntry = lastJournalRows.get(candidate.id);
      if (journalEntry && journalEntry.status !== 'running') {
        this.upsertRecentEntry(journalEntry);
        continue;
      }
      toSettle.push(candidate);
    }

    for (const candidate of toSettle) {
      let transcriptMtimeMs: number | undefined;
      const liveEntry = this.getRecoverableRunningEntry(candidate.id);
      if (!liveEntry) continue;
      if (liveEntry.hasTranscript) {
        const transcriptPath = getAgentObservabilityTranscriptFilePath(
          buildTranscriptRequest(liveEntry),
        );
        transcriptMtimeMs = await stat(transcriptPath)
          .then((stats) => stats.mtimeMs)
          .catch(() => undefined);
      }
      const currentEntry = this.getRecoverableRunningEntry(candidate.id);
      if (!currentEntry) continue;
      const startedAtMs = Date.parse(currentEntry.startedAt);
      const completedAtMs = Math.max(
        startedAtMs,
        transcriptMtimeMs ?? snapshotMtimeMs,
      );
      const settled: AgentAuditEntry = {
        ...currentEntry,
        status: 'interrupted',
        error: 'Application stopped before the turn finished',
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
      };
      this.enqueueAuditEntry(settled);
      this.upsertRecentEntry(settled);
    }
  }

  private initializeAccountProxyUsage(): Promise<void> {
    if (this.accountProxyUsageInitialization) {
      return this.accountProxyUsageInitialization;
    }
    this.accountProxyUsageInitialization = this.host.accountProxy
      .loadUsagePorts()
      .then((ports): void => {
        if (this.disposing) return;
        this.accountProxyUsagePorts = ports;
        this.unsubscribeAccountProxyInventory =
          ports.onAccountProxyInventoryChanged((): void =>
            this.accountProxyQuotaUsage.reconcile(),
          );
        this.accountProxyQuotaUsage.reconcile();
      });
    return this.accountProxyUsageInitialization;
  }

  /** Canonical per-account quota projection; never performs I/O. */
  public getAccountProxyUsage(
    connectionId: string,
    authIndex: string,
  ): AccountProxyUsageSnapshot | undefined {
    return this.accountProxyQuotaUsage.get(connectionId, authIndex);
  }

  /** Explicit provider quota read, separate from inventory/recovery refreshes. */
  public async refreshAccountProxyUsage(
    options: {
      readonly interactive?: boolean;
      readonly provider?: 'claude' | 'codex';
    } = {},
  ): Promise<void> {
    await this.initializeAccountProxyUsage();
    if (!this.disposing) await this.accountProxyQuotaUsage.refresh(options);
  }

  /**
   * Refresh one provider's usage on request. Claude defaults to a newer,
   * versioned auth check, then keys HTTP single-flight and 30-second freshness
   * by normalized account email; a changed account bypasses freshness so the
   * canonical summary is refreshed. Portal's `joinInFlight` path joins the
   * newest merged auth/read refresh. Codex keeps its default supersede and
   * `joinInFlight` behavior without Claude's gate; Cursor reads remain
   * single-flight.
   */
  async refreshProviderUsage(
    provider: AgentProviderType,
    options: { joinInFlight?: boolean } = {},
  ): Promise<void> {
    switch (provider) {
      case 'claude':
      case 'codex':
        await (options.joinInFlight
          ? this.joinProviderUsageRefresh(provider)
          : this.startMergedProviderUsageRefresh(provider));
        break;
      case 'cursor':
        await this.refreshCursorUsage();
        break;
      case 'copilot':
        await this.refreshCopilotUsage();
        break;
      case 'opencode':
        await (
          await import('../opencode/connection')
        ).refreshOpenCodeAccounts();
        break;
      default:
        throw new Error(
          `Unknown provider type in refreshProviderUsage: ${String(provider)}`,
        );
    }
  }

  private startProviderUsageRefresh(
    provider: RefreshableUsageProvider,
    claudeFreshnessMs?: number,
  ): Promise<void> {
    switch (provider) {
      case 'claude':
        return this.refreshClaudeUsage(
          claudeFreshnessMs ?? claudeUsageFreshnessMs(false),
        );
      case 'codex':
        return this.refreshCodexUsage();
      case 'cursor':
        return this.refreshCursorUsage();
      case 'copilot':
        return this.refreshCopilotUsage(true);
    }
  }

  /**
   * Joins only the newest merged auth/read refresh. Claude auth checks remain
   * versioned before entering its per-account HTTP gate; Codex app-server
   * notifications and desktop refreshes retain their existing supersede
   * behavior. Main has no Claude account-change notification, so desktop
   * refresh after login starts the newer auth check.
   */
  private joinProviderUsageRefresh(
    provider: MergedUsageRefreshProvider,
  ): Promise<void> {
    const inFlight = this.mergedProviderUsageRefreshes.get(provider);
    if (
      inFlight &&
      this.isCurrentProviderUsageRefresh(provider, inFlight.version)
    ) {
      return inFlight.done;
    }
    return this.startMergedProviderUsageRefresh(provider);
  }

  /** Starts a newer auth/versioned refresh that later Portal requests join. */
  private startMergedProviderUsageRefresh(
    provider: MergedUsageRefreshProvider,
  ): Promise<void> {
    const done = this.startProviderUsageRefresh(provider);
    const refresh: MergedUsageRefresh = {
      version: this.providerUsageRefreshVersions[provider],
      done,
    };
    this.mergedProviderUsageRefreshes.set(provider, refresh);
    const settle = (): void => {
      if (this.mergedProviderUsageRefreshes.get(provider) === refresh) {
        this.mergedProviderUsageRefreshes.delete(provider);
      }
    };
    void done.then(settle, settle);
    return done;
  }

  private async refreshUsageAdapters(): Promise<void> {
    // Optional managed harness probes must not delay app startup.
    void this.refreshCursorUsage();
    void this.refreshCopilotUsage();
    await Promise.all([
      this.refreshClaudeUsage(),
      this.refreshCodexUsage(),
    ]).catch(() => {});
  }

  /** Clear immediately on connection changes; an older fetch cannot republish. */
  invalidateCursorUsage(): void {
    this.beginProviderUsageRefresh('cursor');
    this.cursorUsageRefresh?.controller.abort();
    this.cursorUsageRefresh = null;
    this.cursorUsage = null;
    if (!this.disposing)
      this.emit({ type: 'usage', usage: this.buildUsageOverview() });
  }

  private refreshCursorUsage(): Promise<void> {
    if (this.disposing) return Promise.resolve();
    if (!this.host.cursor.isEnabled()) {
      this.invalidateCursorUsage();
      return Promise.resolve();
    }
    if (this.cursorUsageRefresh) return this.cursorUsageRefresh.done;
    const version = this.beginProviderUsageRefresh('cursor');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(45_000),
    ]);
    const done = this.host
      .readPreferences()
      .then(async (preferences): Promise<ProviderUsageSummary | null> => {
        if (!preferences.cursorEnabled || signal.aborted) return null;
        return this.host.cursor.readUsage(signal);
      })
      .then((summary): void => {
        if (
          this.disposing ||
          !this.isCurrentProviderUsageRefresh('cursor', version)
        )
          return;
        this.cursorUsage = summary;
        if (summary) this.recordActiveAccountSnapshot(summary);
        this.emit({ type: 'usage', usage: this.buildUsageOverview() });
      })
      .catch((): void => {
        if (
          this.disposing ||
          !this.isCurrentProviderUsageRefresh('cursor', version)
        )
          return;
        this.cursorUsage = {
          provider: 'cursor',
          authState: 'unknown',
          hasRemainingLimits: false,
          errorInfo: { kind: 'service' },
        };
        this.emit({ type: 'usage', usage: this.buildUsageOverview() });
      })
      .finally((): void => {
        if (this.cursorUsageRefresh?.controller === controller)
          this.cursorUsageRefresh = null;
      });
    this.cursorUsageRefresh = { controller, done };
    return done;
  }

  /** Invalidate before changing accounts; cancelled reads cannot republish. */
  invalidateCopilotUsage(): void {
    const hadUsage = this.copilotUsage !== null;
    this.beginProviderUsageRefresh('copilot');
    this.copilotUsageRefresh?.controller.abort();
    this.copilotUsageRefresh = null;
    this.copilotUsage = null;
    if (hadUsage && !this.disposing)
      this.emit({ type: 'usage', usage: this.buildUsageOverview() });
  }

  private refreshCopilotUsage(fresh = false): Promise<void> {
    if (this.disposing) return Promise.resolve();
    if (!this.host.copilot.isEnabled()) {
      this.invalidateCopilotUsage();
      return Promise.resolve();
    }
    if (this.copilotUsageRefresh && !fresh)
      return this.copilotUsageRefresh.done;
    this.copilotUsageRefresh?.controller.abort();
    const version = this.beginProviderUsageRefresh('copilot');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(45_000),
    ]);
    const current = (): boolean =>
      !this.disposing && this.isCurrentProviderUsageRefresh('copilot', version);
    const done = this.host
      .readPreferences()
      .then(async (preferences): Promise<ProviderUsageSummary | null> => {
        if (!preferences.copilotEnabled || signal.aborted) return null;
        return this.host.copilot.readUsage(signal);
      })
      .then((summary): void => {
        if (!current() || summary === this.copilotUsage) return;
        this.copilotUsage = summary;
        this.emit({ type: 'usage', usage: this.buildUsageOverview() });
      })
      .catch((): void => {
        if (!current()) return;
        this.copilotUsage = {
          provider: 'copilot',
          authState: 'error',
          hasRemainingLimits: false,
          errorInfo: { kind: 'service' },
          lastUpdatedAt: new Date().toISOString(),
        };
        this.emit({ type: 'usage', usage: this.buildUsageOverview() });
      })
      .finally((): void => {
        if (this.copilotUsageRefresh?.controller === controller)
          this.copilotUsageRefresh = null;
      });
    this.copilotUsageRefresh = { controller, done };
    return done;
  }

  private async refreshClaudeUsage(
    freshnessMs = claudeUsageFreshnessMs(false),
  ): Promise<void> {
    const refreshVersion = this.beginProviderUsageRefresh('claude');
    const authStatus = await readClaudeAuthStatus(this.host);
    if (
      this.disposing ||
      !this.isCurrentProviderUsageRefresh('claude', refreshVersion)
    ) {
      return;
    }

    if (authStatus?.loggedIn !== true) {
      // Match passive auth transitions: one disagreeing probe must not erase
      // signed-in usage while a usable provider credential is still present.
      const previousSummary = this.usageProviders.claude;
      if (
        previousSummary.authState === 'authenticated' &&
        !this.claudeUsageAuthDisagreement
      ) {
        const credentialResult = await this.host.claude.readOauthCredentials();
        if (
          this.disposing ||
          !this.isCurrentProviderUsageRefresh('claude', refreshVersion)
        ) {
          return;
        }
        if (credentialResult.status === 'success') {
          this.claudeUsageAuthDisagreement = true;
          return;
        }
      }
      this.claudeUsageAuthDisagreement = false;
      this.publishClaudeUsageSummary({
        provider: 'claude',
        authState: authStatus === null ? 'unknown' : 'unauthenticated',
        accountEmail: authStatus?.email,
        accountLabel: authStatus?.email,
        authMethod: authStatus?.authMethod,
        subscriptionLabel: claudeSubscriptionLabel(authStatus, null),
        hasRemainingLimits: false,
      });
      return;
    }

    this.claudeUsageAuthDisagreement = false;
    const accountKey = normalizeClaudeAccountKey(authStatus.email);
    const currentSummary = this.usageProviders.claude;
    const currentSummaryMatchesAccount =
      currentSummary.authState === 'authenticated' &&
      normalizeClaudeAccountKey(currentSummary.accountEmail) === accountKey;
    const hasUnpublishedSuccessfulRead =
      (this.claudeLatestSuccessfulReadOrderByAccount.get(accountKey) ?? 0) !==
      (this.claudePublishedSuccessfulReadOrderByAccount.get(accountKey) ?? 0);
    const gateResult = await this.claudeUsageFetchGate.run(
      accountKey,
      currentSummaryMatchesAccount && !hasUnpublishedSuccessfulRead
        ? freshnessMs
        : 0,
      async (): Promise<ClaudeUsageDetailsReadResult> => {
        const readOrder = ++this.claudeUsageEventOrder;
        const result = await readClaudeUsageDetails(this.host);
        this.claudeUsageReadOrderByResult.set(result, readOrder);
        return result;
      },
      (result) => {
        if (result.status === 'success') {
          this.claudeLatestSuccessfulReadOrderByAccount.set(
            accountKey,
            this.claudeUsageReadOrderByResult.get(result) ?? 0,
          );
          return { status: 'success' };
        }

        if ('retryAfter' in result) {
          return {
            status: 'failure',
            rateLimited: true,
            retryAfter: result.retryAfter,
          };
        }

        return { status: 'failure' };
      },
    );

    if (
      this.disposing ||
      !this.isCurrentProviderUsageRefresh('claude', refreshVersion)
    ) {
      return;
    }

    if (gateResult.kind === 'fresh') {
      return;
    }
    if (gateResult.kind === 'cooldown') {
      this.publishClaudeCooldownSummary(
        authStatus,
        accountKey,
        gateResult.retryAt,
      );
      return;
    }

    const previousSummary = this.usageProviders.claude;
    const sameAccount =
      normalizeClaudeAccountKey(previousSummary.accountEmail) === accountKey;
    const usageResult = gateResult.value;
    const usageDetails =
      usageResult.status === 'success' ? usageResult.details : null;
    const usageError =
      usageResult.status === 'failure' ? usageResult.error : undefined;
    const usageErrorInfo =
      usageResult.status === 'failure' ? usageResult.errorInfo : undefined;
    const authenticationFailure = usageErrorInfo?.kind === 'auth';
    const retainedFailure =
      usageResult.status === 'failure' && sameAccount && !authenticationFailure;
    const readOrder = this.claudeUsageReadOrderByResult.get(usageResult) ?? 0;
    const rateLimits =
      usageDetails === null
        ? retainedFailure
          ? previousSummary.rateLimits
          : undefined
        : this.mergeClaudeUsageWithSdkPatches(
            usageDetails.rateLimits,
            sameAccount ? previousSummary.rateLimits : undefined,
            accountKey,
            gateResult.startedAt,
            readOrder,
          );
    const lastUpdatedAt =
      usageDetails !== null
        ? new Date().toISOString()
        : retainedFailure
          ? previousSummary.lastUpdatedAt
          : undefined;
    const errorInfo =
      usageErrorInfo === undefined
        ? undefined
        : {
            ...usageErrorInfo,
            ...(gateResult.retryAt === undefined
              ? {}
              : { retryAt: new Date(gateResult.retryAt).toISOString() }),
          };

    this.publishClaudeUsageSummary({
      provider: 'claude',
      authState: 'authenticated',
      accountEmail: authStatus.email,
      accountLabel: authStatus.email,
      authMethod: authStatus.authMethod,
      subscriptionLabel: claudeSubscriptionLabel(authStatus, usageDetails),
      hasRemainingLimits:
        usageDetails !== null
          ? (rateLimits?.length ?? 0) > 0
          : retainedFailure
            ? previousSummary.hasRemainingLimits
            : false,
      ...(rateLimits === undefined ? {} : { rateLimits }),
      ...(lastUpdatedAt === undefined ? {} : { lastUpdatedAt }),
      ...(usageError === undefined ? {} : { error: usageError }),
      ...(errorInfo === undefined ? {} : { errorInfo }),
    });
    if (usageResult.status === 'success') {
      this.claudePublishedSuccessfulReadOrderByAccount.set(
        accountKey,
        readOrder,
      );
      this.clearClaudePatchesCoveredByRead(
        accountKey,
        readOrder,
        usageResult.details.rateLimits,
      );
      // Only this completed successful HTTP read can restore subscription
      // allowance. Cached, failed and 429 snapshots retain displayed numbers
      // but are never recovery evidence. Requiring coverage of prior known
      // windows avoids treating a partial five-hour response as proof that an
      // omitted weekly or model-scoped limit recovered.
      const fetchedSubscriptionLimits = subscriptionUsageLimits({
        provider: 'claude',
        rateLimits: usageResult.details.rateLimits,
      });
      const previousSubscriptionLimits = subscriptionUsageLimits({
        provider: 'claude',
        rateLimits: sameAccount ? previousSummary.rateLimits : undefined,
      }).filter((limit) =>
        claudeSubscriptionWindowPending(limit, gateResult.startedAt),
      );
      const coversKnownWindows = previousSubscriptionLimits.every(
        (previousLimit) =>
          previousLimit.limitId !== undefined &&
          fetchedSubscriptionLimits.some(
            (fetchedLimit) =>
              claudeSubscriptionWindowKey(fetchedLimit) ===
                claudeSubscriptionWindowKey(previousLimit) &&
              (previousLimit.primary === undefined ||
                fetchedLimit.primary !== undefined) &&
              (previousLimit.secondary === undefined ||
                fetchedLimit.secondary !== undefined),
          ),
      );
      if (
        accountKey !== null &&
        coversKnownWindows &&
        classifySubscriptionUsage({
          provider: 'claude',
          rateLimits: usageResult.details.rateLimits,
        }).status === 'available' &&
        classifySubscriptionUsage({
          provider: 'claude',
          rateLimits,
        }).status === 'available'
      ) {
        const observationOrder = this.claudeUsageEventOrder;
        await recordNativeSubscriptionRestored(
          'claude',
          accountKey,
          gateResult.startedAt,
          () =>
            !this.disposing &&
            this.isCurrentProviderUsageRefresh('claude', refreshVersion) &&
            this.claudeUsageEventOrder === observationOrder &&
            this.usageProviders.claude.authState === 'authenticated' &&
            normalizeClaudeAccountKey(
              this.usageProviders.claude.accountEmail,
            ) === accountKey,
        );
      }
    }
  }

  private publishClaudeUsageSummary(summary: ProviderUsageSummary): void {
    const priorAccountKey = normalizeClaudeAccountKey(
      this.usageProviders.claude.accountEmail,
    );
    const nextAccountKey = normalizeClaudeAccountKey(summary.accountEmail);
    if (
      priorAccountKey !== nextAccountKey ||
      summary.authState !== 'authenticated' ||
      summary.rateLimits === undefined
    ) {
      this.claudeUsageWindowPatches.clear();
    }
    this.usageProviders.claude = summary;
    this.recordActiveAccountSnapshot(summary);
    this.emit({ type: 'usage', usage: this.buildUsageOverview() });
  }

  private publishClaudeCooldownSummary(
    authStatus: ClaudeAuthStatus,
    accountKey: string | null,
    retryAt: number,
  ): void {
    const currentSummary = this.usageProviders.claude;
    const canRetain =
      currentSummary.authState === 'authenticated' &&
      normalizeClaudeAccountKey(currentSummary.accountEmail) === accountKey;
    const message = 'Claude usage request failed (HTTP 429).';
    this.publishClaudeUsageSummary({
      ...(canRetain ? currentSummary : createEmptyProviderUsage('claude')),
      provider: 'claude',
      authState: 'authenticated',
      accountEmail: authStatus.email,
      accountLabel: authStatus.email,
      authMethod: authStatus.authMethod,
      subscriptionLabel: claudeSubscriptionLabel(authStatus, null),
      hasRemainingLimits: canRetain && currentSummary.hasRemainingLimits,
      ...(canRetain && currentSummary.rateLimits !== undefined
        ? { rateLimits: currentSummary.rateLimits }
        : {}),
      ...(canRetain && currentSummary.lastUpdatedAt !== undefined
        ? { lastUpdatedAt: currentSummary.lastUpdatedAt }
        : {}),
      error: message,
      errorInfo: {
        kind: 'rate_limited',
        detail: 'GET /api/oauth/usage responded 429',
        retryAt: new Date(retryAt).toISOString(),
      },
    });
  }

  private mergeClaudeUsageWithSdkPatches(
    fetched: ProviderRateLimitSnapshot[],
    previous: readonly ProviderRateLimitSnapshot[] | undefined,
    accountKey: string | null,
    startedAt: number,
    readOrder: number,
  ): ProviderRateLimitSnapshot[] {
    const isNewer = (
      patch: ClaudeUsageFieldPatch<number | string> | undefined,
    ): boolean =>
      patch !== undefined &&
      (patch.at > startedAt ||
        (patch.at === startedAt && patch.order > readOrder));
    const merged: ProviderRateLimitSnapshot[] = fetched.map((snapshot) => {
      if (snapshot.limitId === undefined) return snapshot;
      const patch = this.claudeUsageWindowPatches.get(
        claudePatchedWindowKey(accountKey, snapshot),
      );
      if (patch === undefined) return snapshot;
      const usedPercent = patch.usedPercent;
      const resetsAt = patch.resetsAt;
      const applyUsedPercent =
        usedPercent !== undefined &&
        (snapshot.primary?.usedPercent === undefined || isNewer(usedPercent));
      const applyResetsAt =
        resetsAt !== undefined &&
        (snapshot.primary?.resetsAt === undefined || isNewer(resetsAt));
      if (!applyUsedPercent && !applyResetsAt) return snapshot;
      return {
        ...snapshot,
        primary: {
          ...snapshot.primary,
          ...(applyUsedPercent ? { usedPercent: usedPercent.value } : {}),
          ...(applyResetsAt ? { resetsAt: resetsAt.value } : {}),
        },
      };
    });
    const fetchedIds = new Set(fetched.map(claudeSubscriptionWindowKey));
    const previousWindows = subscriptionUsageLimits({
      provider: 'claude',
      rateLimits: previous,
    });
    for (let index = 0; index < previousWindows.length; index += 1) {
      const snapshot = previousWindows[index];
      if (
        snapshot === undefined ||
        snapshot.limitId === undefined ||
        fetchedIds.has(claudeSubscriptionWindowKey(snapshot)) ||
        !claudeSubscriptionWindowPending(snapshot, startedAt)
      )
        continue;
      // Keep omitted windows until a confirmed reset or equivalent replacement;
      // repeated partial reads alone are never recovery evidence.
      merged.splice(Math.min(index, merged.length), 0, snapshot);
      fetchedIds.add(claudeSubscriptionWindowKey(snapshot));
    }
    return merged;
  }

  private clearClaudePatchesCoveredByRead(
    accountKey: string | null,
    readOrder: number,
    fetched: ProviderRateLimitSnapshot[],
  ): void {
    for (const snapshot of fetched) {
      if (snapshot.limitId === undefined) continue;
      const key = claudePatchedWindowKey(accountKey, snapshot);
      const patch = this.claudeUsageWindowPatches.get(key);
      if (patch?.accountKey !== accountKey) continue;
      if (
        patch.usedPercent !== undefined &&
        patch.usedPercent.order <= readOrder &&
        snapshot.primary?.usedPercent !== undefined
      )
        delete patch.usedPercent;
      if (
        patch.resetsAt !== undefined &&
        patch.resetsAt.order <= readOrder &&
        snapshot.primary?.resetsAt !== undefined
      )
        delete patch.resetsAt;
      if (patch.usedPercent === undefined && patch.resetsAt === undefined)
        this.claudeUsageWindowPatches.delete(key);
    }
  }

  private observeClaudeRateLimitEvent(
    key: string,
    data: Record<string, unknown>,
  ): void {
    const openEntry = this.openEntries.get(key);
    const summary = this.usageProviders.claude;
    if (
      openEntry?.entry.provider !== 'claude' ||
      openEntry.entry.billingBasis !== 'subscription' ||
      summary.authState !== 'authenticated' ||
      summary.rateLimits === undefined
    ) {
      return;
    }

    const entryAccountKey = normalizeClaudeAccountKey(
      openEntry.providerAccountIdentity?.accountEmail,
    );
    const summaryAccountKey = normalizeClaudeAccountKey(summary.accountEmail);
    if (
      entryAccountKey === null ||
      summaryAccountKey === null ||
      entryAccountKey !== summaryAccountKey
    ) {
      return;
    }

    const info = readRecord(data, 'rate_limit_info');
    if (info === null) return;
    const observation = observeClaudeRateLimitWindows(summary.rateLimits, info);
    if (observation === null) return;

    const order = ++this.claudeUsageEventOrder;
    const at = Date.now();
    for (const window of observation.windows) {
      const snapshot = summary.rateLimits.find(
        (limit) => limit.limitId === window.limitId,
      );
      if (snapshot === undefined) continue;
      const patchKey = claudePatchedWindowKey(summaryAccountKey, snapshot);
      const prior = this.claudeUsageWindowPatches.get(patchKey);
      this.claudeUsageWindowPatches.set(patchKey, {
        ...prior,
        accountKey: summaryAccountKey,
        ...(window.usedPercent === undefined
          ? {}
          : { usedPercent: { value: window.usedPercent, at, order } }),
        ...(window.resetsAt === undefined
          ? {}
          : { resetsAt: { value: window.resetsAt, at, order } }),
      });
    }
    // Unchanged observations still fence older HTTP reads without a UI update.
    const patched = observation.rateLimits;
    if (patched === null) return;
    this.usageProviders.claude = {
      ...summary,
      hasRemainingLimits: patched.length > 0,
      rateLimits: patched,
    };
    this.emit({ type: 'usage', usage: this.buildUsageOverview() });
  }

  private async refreshCodexUsage(): Promise<void> {
    const refreshVersion = this.beginProviderUsageRefresh('codex');
    try {
      const sources = await this.readCodexUsageSources(refreshVersion);
      if (!sources) {
        return;
      }
      const { account, rateLimits } = sources;
      const bucketSnapshots = rateLimits?.rateLimitsByLimitId
        ? Object.values(rateLimits.rateLimitsByLimitId).filter(
            (value): value is NonNullable<typeof value> => value !== undefined,
          )
        : [];
      const snapshots =
        bucketSnapshots.length > 0
          ? bucketSnapshots
          : rateLimits
            ? [rateLimits.rateLimits]
            : [];

      if (!this.isCurrentProviderUsageRefresh('codex', refreshVersion)) {
        return;
      }
      this.usageProviders.codex = {
        ...this.usageProviders.codex,
        ...buildCodexAccountUsageSummary(account),
        hasRemainingLimits: snapshots.length > 0,
        rateLimits: snapshots.map((snapshot) => ({
          limitId: toOptionalString(snapshot.limitId),
          limitName: toOptionalString(snapshot.limitName),
          planType: toOptionalString(snapshot.planType),
          primary: snapshot.primary
            ? {
                usedPercent: snapshot.primary.usedPercent ?? undefined,
                resetsAt: toIsoStringFromEpoch(snapshot.primary.resetsAt),
                windowDurationMins:
                  snapshot.primary.windowDurationMins ?? undefined,
              }
            : undefined,
          secondary: snapshot.secondary
            ? {
                usedPercent: snapshot.secondary.usedPercent ?? undefined,
                resetsAt: toIsoStringFromEpoch(snapshot.secondary.resetsAt),
                windowDurationMins:
                  snapshot.secondary.windowDurationMins ?? undefined,
              }
            : undefined,
          credits: snapshot.credits
            ? {
                remainingUsd:
                  snapshot.credits.balance !== null
                    ? Number.parseFloat(snapshot.credits.balance)
                    : undefined,
              }
            : undefined,
        })),
        lastUpdatedAt: new Date().toISOString(),
        error: undefined,
        errorInfo: undefined,
      };
      this.recordActiveAccountSnapshot(this.usageProviders.codex);
      this.emit({ type: 'usage', usage: this.buildUsageOverview() });
    } catch (error) {
      if (!this.isCurrentProviderUsageRefresh('codex', refreshVersion)) {
        return;
      }
      const accountSummary =
        error instanceof CodexRateLimitsReadError
          ? buildCodexAccountUsageSummary(error.account)
          : {
              authState: 'unknown' as const,
              accountEmail: undefined,
              accountLabel: undefined,
              subscriptionLabel: undefined,
            };
      const rawMessage =
        error instanceof Error
          ? error.message
          : 'Failed to read Codex account state';
      this.usageProviders.codex = {
        ...this.usageProviders.codex,
        ...accountSummary,
        hasRemainingLimits: false,
        rateLimits: undefined,
        error: rawMessage,
        // The Codex app-server relays upstream HTTP failures as opaque
        // JSON-RPC error strings, so the kind is classified from the message
        // and the raw text is preserved as the diagnostics detail.
        errorInfo: {
          kind: classifyUsageFetchErrorMessage(rawMessage),
          detail: rawMessage,
        },
        lastUpdatedAt: new Date().toISOString(),
      };
      this.emit({ type: 'usage', usage: this.buildUsageOverview() });
    }
  }

  /**
   * Read the Codex account + rate-limit sources. Production reads them from the
   * codex app-server (JSON-RPC `account/read` + `account/rateLimits/read`).
   * Under the build-time E2E gate (Doc 6 §3, Doc 11) it fetches the mock
   * server's control-plane endpoints instead — the app-server is NOT redirected
   * by the model base URL, so this seam is required. The gate is inlined at the
   * call site and the shared control-plane client is internally gated, so the
   * branch and every mock string literal are dead-code-eliminated from
   * production builds. A runtime env var can never reach it in a shipped app.
   */
  private async readCodexUsageSources(refreshVersion: number): Promise<{
    account: GetAccountResponse;
    rateLimits: GetAccountRateLimitsResponse | null;
  } | null> {
    if (__CANOPY_E2E__) {
      const mockOrigin = this.host.e2e.mockLlmOrigin();
      if (!mockOrigin) {
        throw new Error(
          'E2E Codex usage probe requires CANOPY_MOCK_LLM_BASE_URL.',
        );
      }
      const accountPayload = await this.host.e2e.fetchControlPlaneRecord(
        mockOrigin,
        '/__mock/codex/account',
      );
      const account = parseGetAccountResponsePayload(accountPayload);
      if (!account) {
        throw new Error('Invalid mock Codex account payload');
      }
      // The app-server's rate-limit method requires a Codex account. Once
      // account/read has authoritatively confirmed there is none, asking for
      // rate limits can only produce an authentication error and needlessly
      // contend with the auth/account-change probes that let the user recover.
      if (account.account === null) {
        return { account, rateLimits: null };
      }
      const rateLimitsPayload = await this.host.e2e.fetchControlPlaneRecord(
        mockOrigin,
        '/__mock/codex/ratelimits',
      );
      const rateLimits = parseGetAccountRateLimitsPayload(rateLimitsPayload);
      if (!rateLimits) {
        throw new Error('Invalid mock Codex rate-limit payload');
      }
      return { account, rateLimits };
    }

    const client = this.getCodexMonitor();
    const account = await client.readAccount(false);
    if (account.account === null) {
      return { account, rateLimits: null };
    }
    try {
      return { account, rateLimits: await client.readRateLimits() };
    } catch (error) {
      if (!isCodexInvalidatedOAuthError(error)) {
        throw new CodexRateLimitsReadError(
          error instanceof Error
            ? error.message
            : 'Failed to fetch Codex rate limits',
          account,
        );
      }

      if (!this.isCurrentProviderUsageRefresh('codex', refreshVersion)) {
        return null;
      }

      this.resetCodexMonitor(client);
      const retryClient = this.getCodexMonitor();
      const retryAccount = await retryClient.readAccount(false);
      try {
        return {
          account: retryAccount,
          rateLimits: await retryClient.readRateLimits(),
        };
      } catch (retryError) {
        throw new CodexRateLimitsReadError(
          retryError instanceof Error
            ? retryError.message
            : 'Failed to fetch Codex rate limits',
          retryAccount,
        );
      }
    }
  }

  private beginProviderUsageRefresh(
    provider: RefreshableUsageProvider,
  ): number {
    this.providerUsageRefreshVersions[provider] += 1;
    return this.providerUsageRefreshVersions[provider];
  }

  private isCurrentProviderUsageRefresh(
    provider: RefreshableUsageProvider,
    refreshVersion: number,
  ): boolean {
    return this.providerUsageRefreshVersions[provider] === refreshVersion;
  }

  private getCodexMonitor(): CodexUsageMonitor {
    if (this.codexMonitor) {
      return this.codexMonitor;
    }

    const admin = this.host.codexAdmin();
    const unsubscribes: Array<() => void> = [];
    const monitor: CodexUsageMonitor = {
      readAccount: async (refreshToken): Promise<GetAccountResponse> => {
        const response = await admin.request('account/read', { refreshToken });
        const parsed = parseGetAccountResponsePayload(response);
        if (!parsed) {
          throw new Error(
            'Codex app-server returned an invalid account payload',
          );
        }
        return parsed;
      },
      readRateLimits: async (): Promise<GetAccountRateLimitsResponse> => {
        const response = await admin.request(
          'account/rateLimits/read',
          undefined,
        );
        const parsed = parseGetAccountRateLimitsPayload(response);
        if (!parsed) {
          throw new Error(
            'Codex app-server returned an invalid rate limits payload',
          );
        }
        return parsed;
      },
      dispose: (): void => {
        for (const unsubscribe of unsubscribes.splice(0)) {
          unsubscribe();
        }
      },
    };
    unsubscribes.push(
      admin.onAccountUpdated(() => {
        this.resetCodexMonitor(monitor);
        void this.refreshCodexUsage();
      }),
      admin.onRateLimitsUpdated(() => {
        void this.refreshCodexUsage();
      }),
    );
    this.codexMonitor = monitor;
    return monitor;
  }

  private resetCodexMonitor(expected?: CodexUsageMonitor): void {
    if (!this.codexMonitor) {
      return;
    }
    if (expected && this.codexMonitor !== expected) {
      return;
    }
    const monitor = this.codexMonitor;
    this.codexMonitor = null;
    monitor.dispose();
  }

  private hasPendingTranscriptWrites(): boolean {
    return [
      ...Array.from(this.transcriptStates.values()),
      ...Array.from(this.retiringTranscriptStates),
    ].some((state) => state.queuedLines.length > 0);
  }

  private hasPendingDiagnosticWrites(): boolean {
    return (
      this.pendingAppDiagnostics.length > 0 ||
      this.pendingSessionDiagnostics.length > 0
    );
  }

  /**
   * While start-up holds plan events, their usage events wait too, so a crash
   * cannot store an event whose plan count was never written.
   */
  private holdsUsageMetricWrites(): boolean {
    return (this.plansAwaitingCountedIds?.length ?? 0) > 0;
  }

  private hasPendingUsageMetricWrites(): boolean {
    return (
      !this.holdsUsageMetricWrites() && this.pendingUsageMetricEvents.length > 0
    );
  }

  private hasPendingTranscriptIndexWrites(): boolean {
    return this.pendingTranscriptIndexRecords.length > 0;
  }

  private hasPendingWrites(): boolean {
    return (
      this.hasPendingTranscriptWrites() ||
      this.pendingPersistedEntries.length > 0 ||
      this.hasPendingUsageMetricWrites() ||
      this.hasPendingTranscriptIndexWrites() ||
      this.hasPendingDiagnosticWrites()
    );
  }

  private async flushTranscriptSidecars(): Promise<boolean> {
    const pendingTranscriptStates = Array.from(
      new Set([
        ...Array.from(this.retiringTranscriptStates),
        ...Array.from(this.transcriptStates.values()),
      ]),
    ).filter((state) => {
      this.releaseClosedTranscriptState(state);
      return state.queuedLines.length > 0;
    });
    if (pendingTranscriptStates.length === 0) {
      return false;
    }

    try {
      for (const transcriptState of pendingTranscriptStates) {
        const capturedCount = transcriptState.queuedLines.length;
        let cursor = 0;
        let committedBytes = 0;
        try {
          await mkdir(dirname(transcriptState.path), { recursive: true });
          while (cursor < capturedCount) {
            const lines: string[] = [];
            let batchBytes = 0;
            for (let index = cursor; index < capturedCount; index += 1) {
              const line = transcriptState.queuedLines[index];
              if (line === undefined) break;
              const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8');
              if (
                lines.length > 0 &&
                batchBytes + lineBytes > APPEND_BATCH_MAX_BYTES
              ) {
                break;
              }
              // Keep a single oversized JSONL line in one append request.
              // The sidecar producer caps the complete transcript at 8 MiB.
              lines.push(line);
              batchBytes += lineBytes;
              if (batchBytes >= APPEND_BATCH_MAX_BYTES) break;
            }
            if (lines.length === 0) break;
            await appendJsonlLines(
              transcriptState.path,
              `${lines.join('\n')}\n`,
            );
            cursor += lines.length;
            committedBytes += batchBytes;
            if (lines.some((line) => isPersistedTranscriptContentLine(line))) {
              this.markTranscriptAvailable(transcriptState);
            }
          }
        } finally {
          if (cursor > 0) {
            // New lines may arrive during append; remove only the captured
            // prefix whose append calls succeeded, once per state.
            transcriptState.queuedLines.splice(0, cursor);
            transcriptState.budget.persistedBytes += committedBytes;
            transcriptState.budget.queuedBytes = Math.max(
              0,
              transcriptState.budget.queuedBytes - committedBytes,
            );
            transcriptState.queuedBytes = Math.max(
              0,
              transcriptState.queuedBytes - committedBytes,
            );
          }
          this.releaseClosedTranscriptState(transcriptState);
        }
      }
      return false;
    } catch (error) {
      writeObservabilityError(
        '[observability] failed to append transcript sidecars',
        error,
      );
      return true;
    }
  }

  private async flushJsonlQueue<T>(options: {
    pending: () => T[];
    replacePending: (entries: T[]) => void;
    directory: string;
    dayFor: (entry: T) => string;
    pathForDay: (day: string) => string;
    errorMessage: string;
  }): Promise<boolean> {
    const captured = [...options.pending()];
    if (captured.length === 0) return false;
    const byDay = new Map<string, T[]>();
    for (const entry of captured) {
      const day = options.dayFor(entry);
      const dayEntries = byDay.get(day) ?? [];
      dayEntries.push(entry);
      byDay.set(day, dayEntries);
    }
    const committed: T[] = [];
    try {
      await mkdir(options.directory, { recursive: true });
      for (const [day, entries] of Array.from(byDay)) {
        let cursor = 0;
        let lookahead: { line: string; bytes: number } | undefined;
        while (cursor < entries.length) {
          const lines: string[] = [];
          let batchBytes = 0;
          while (cursor + lines.length < entries.length) {
            let candidate = lookahead;
            if (!candidate) {
              const entry = entries[cursor + lines.length];
              const serialized = JSON.stringify(entry);
              if (serialized === undefined) {
                throw new Error('Cannot serialize observability JSONL record');
              }
              const line = `${serialized}\n`;
              candidate = { line, bytes: Buffer.byteLength(line, 'utf8') };
            }
            if (
              lines.length > 0 &&
              batchBytes + candidate.bytes > APPEND_BATCH_MAX_BYTES
            ) {
              lookahead = candidate;
              break;
            }
            // A single oversized record gets its own append request, so its
            // size is the effective floor for this batch target.
            lines.push(candidate.line);
            batchBytes += candidate.bytes;
            lookahead = undefined;
            if (batchBytes >= APPEND_BATCH_MAX_BYTES) break;
          }
          await appendJsonlLines(options.pathForDay(day), lines.join(''));
          for (let index = 0; index < lines.length; index += 1) {
            const entry = entries[cursor + index];
            if (entry !== undefined) committed.push(entry);
          }
          cursor += lines.length;
        }
      }
      return false;
    } catch (error) {
      writeObservabilityError(options.errorMessage, error);
      return true;
    } finally {
      if (committed.length > 0) {
        options.replacePending(
          withoutCommittedEntries(options.pending(), committed),
        );
      }
    }
  }

  private async flushAuditQueue(): Promise<boolean> {
    return this.flushJsonlQueue({
      pending: () => this.pendingPersistedEntries,
      replacePending: (entries) => {
        this.pendingPersistedEntries = entries;
      },
      directory: getAgentObservabilityAuditDir(),
      dayFor: (entry) => toIsoDay(entry.startedAt),
      pathForDay: getAgentObservabilityAuditDayFilePath,
      errorMessage: '[observability] failed to append audit entries',
    });
  }

  async flushUsageMetricEvents(): Promise<boolean> {
    return this.enqueuePersistenceTask(() => this.flushUsageMetricQueue());
  }

  private async flushUsageMetricQueue(): Promise<boolean> {
    if (this.holdsUsageMetricWrites()) return false;
    return this.flushJsonlQueue({
      pending: () => this.pendingUsageMetricEvents,
      replacePending: (entries) => {
        this.pendingUsageMetricEvents = entries;
      },
      directory: getAgentObservabilityUsageEventsDir(),
      dayFor: (event) => toIsoDay(event.timestamp),
      pathForDay: getAgentObservabilityUsageEventsDayFilePath,
      errorMessage: '[observability] failed to append usage metric events',
    });
  }

  private async flushTranscriptIndexRecords(): Promise<boolean> {
    return this.flushJsonlQueue({
      pending: () => this.pendingTranscriptIndexRecords,
      replacePending: (entries) => {
        this.pendingTranscriptIndexRecords = entries;
      },
      directory: getAgentObservabilityTranscriptIndexDir(),
      dayFor: (entry) => toIsoDay(entry.startedAt),
      pathForDay: getAgentObservabilityTranscriptIndexDayFilePath,
      errorMessage: '[observability] failed to append transcript index records',
    });
  }

  private async flushAppDiagnostics(): Promise<boolean> {
    return this.flushJsonlQueue({
      pending: () => this.pendingAppDiagnostics,
      replacePending: (entries) => {
        this.pendingAppDiagnostics = entries;
      },
      directory: getAgentObservabilityAppEventsDir(),
      dayFor: (entry) => toIsoDay(entry.timestamp),
      pathForDay: getAgentObservabilityAppEventsDayFilePath,
      errorMessage: '[observability] failed to append app diagnostics',
    });
  }

  private async flushSessionDiagnostics(): Promise<boolean> {
    return this.flushJsonlQueue({
      pending: () => this.pendingSessionDiagnostics,
      replacePending: (entries) => {
        this.pendingSessionDiagnostics = entries;
      },
      directory: getAgentObservabilitySessionEventsDir(),
      dayFor: (entry) => toIsoDay(entry.timestamp),
      pathForDay: getAgentObservabilitySessionEventsDayFilePath,
      errorMessage: '[observability] failed to append session diagnostics',
    });
  }

  private async flushDiagnostics(): Promise<boolean> {
    const appFailed = await this.flushAppDiagnostics();
    const sessionFailed = await this.flushSessionDiagnostics();
    return appFailed || sessionFailed;
  }

  private async flushSnapshot(): Promise<void> {
    const snapshotPath = getAgentObservabilitySnapshotPath();
    const snapshot = this.loadSnapshot();
    // Native account labels are volatile and must never be restored from disk.
    delete snapshot.usage.openCodeAccounts;
    // Rollout visibility affects renderer payloads, not retained account data.
    snapshot.usage.accountSnapshots = pruneRetainedAccountSnapshots(
      Array.from(this.retainedAccountSnapshots.values()),
      Date.now(),
    );
    const serializedSnapshot = serializedSnapshotForComparison(snapshot);
    if (
      this.persistedSnapshotIdentity &&
      sameSnapshotContent(this.persistedSnapshot, serializedSnapshot)
    ) {
      try {
        const current = snapshotFileIdentity(
          await stat(snapshotPath, { bigint: true }),
        );
        if (current === this.persistedSnapshotIdentity) return;
      } catch {
        // A missing or unverifiable destination must be restored by this
        // write, even when the in-memory snapshot content is unchanged.
      }
    }
    const tempPath = `${snapshotPath}.tmp`;
    try {
      await mkdir(dirname(snapshotPath), { recursive: true });
      await writeFile(tempPath, serializedSnapshot.text, 'utf8');
      let stagedIdentity: string | null = null;
      try {
        stagedIdentity = snapshotOwnedFileIdentity(
          await stat(tempPath, { bigint: true }),
        );
      } catch {
        // The replacement can still succeed; leave no-op identity unknown.
      }
      await rename(tempPath, snapshotPath);
      this.persistedSnapshot = serializedSnapshot;
      this.persistedSnapshotIdentity = null;
      if (stagedIdentity) {
        try {
          const destination = await stat(snapshotPath, { bigint: true });
          if (snapshotOwnedFileIdentity(destination) === stagedIdentity) {
            this.persistedSnapshotIdentity = snapshotFileIdentity(destination);
          }
        } catch {
          // A later flush will retry when the new destination cannot be
          // verified as the file we staged.
        }
      }
    } catch (error) {
      this.persistedSnapshotIdentity = null;
      writeObservabilityError(
        '[observability] failed to write snapshot',
        error,
      );
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }

  private async runFlush(): Promise<boolean> {
    while (true) {
      const transcriptFailed = await this.flushTranscriptSidecars();
      const auditFailed = await this.flushAuditQueue();
      const usageMetricFailed = await this.flushUsageMetricQueue();
      const transcriptIndexFailed = await this.flushTranscriptIndexRecords();
      const diagnosticsFailed = await this.flushDiagnostics();
      await this.flushSnapshot();

      if (
        transcriptFailed ||
        auditFailed ||
        usageMetricFailed ||
        transcriptIndexFailed ||
        diagnosticsFailed
      )
        return true;
      if (!this.hasPendingWrites()) return false;
    }
  }

  private isEntryWithinRetention(entry: AgentAuditEntry): boolean {
    return (
      new Date(entry.startedAt).getTime() >=
      getRetentionCutoffTime(this.retentionDays)
    );
  }

  private async loadRetentionDaysFromPreferences(): Promise<void> {
    if (this.retentionDaysLoadPromise) {
      await this.retentionDaysLoadPromise;
      return;
    }

    this.retentionDaysLoadPromise = this.host
      .readAuditRetentionDays()
      .then((days) => {
        if (days !== undefined) this.retentionDays = days;
      })
      .catch(() => {})
      .finally(() => {
        this.retentionDaysLoadPromise = null;
      });

    await this.retentionDaysLoadPromise;
  }

  private async pruneOldDayFiles(): Promise<void> {
    const auditDir = getAgentObservabilityAuditDir();
    let filenames: string[] = [];
    try {
      filenames = await readdir(auditDir);
    } catch {
      filenames = [];
    }

    const cutoffTime = getRetentionCutoffTime(this.retentionDays);
    const retentionDays = this.retentionDays;

    await Promise.all(
      filenames
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (filename) => {
          const day = filename.replace(/\.jsonl$/, '');
          const fileDayTime = retainedDayStartTime(day);
          if (fileDayTime === null || fileDayTime >= cutoffTime) {
            return;
          }
          // A reader of the audit stream may still need this file.
          const decision = await mayPruneAuditDayFile({
            dayFilename: filename,
            fileDayTime,
            cutoffTime,
            retentionDays,
          });
          if (!decision.prune) {
            return;
          }
          const filePath = getAgentObservabilityAuditDayFilePath(day);
          const verified = decision.verified;
          if (verified === undefined) {
            await rm(filePath, { force: true });
            return;
          }
          // The guard runs outside the persistence queue, since a refresh it
          // waits for may flush observability. Delete inside the queue, and
          // only the file the reader consumed: an entry appended since keeps it.
          await this.enqueuePersistenceTask(async (): Promise<void> => {
            const current = await stat(filePath);
            if (
              !sameAuditDayFileIdentity(verified, {
                size: current.size,
                mtimeMs: current.mtimeMs,
                ino: current.ino,
              })
            ) {
              return;
            }
            await rm(filePath, { force: true });
          });
        }),
    ).catch(() => {});

    const usageEventsDir = getAgentObservabilityUsageEventsDir();
    let usageEventDays: string[] = [];
    try {
      usageEventDays = await readdir(usageEventsDir);
    } catch {
      usageEventDays = [];
    }

    const usageEventCutoffTime =
      Date.now() - USAGE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    await Promise.all(
      usageEventDays
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (filename) => {
          const day = filename.replace(/\.jsonl$/, '');
          const fileDayTime = retainedDayStartTime(day);
          if (fileDayTime === null || fileDayTime >= usageEventCutoffTime) {
            return;
          }
          await rm(getAgentObservabilityUsageEventsDayFilePath(day), {
            force: true,
          });
        }),
    ).catch(() => {});

    const appEventsDir = getAgentObservabilityAppEventsDir();
    let appEventDays: string[] = [];
    try {
      appEventDays = await readdir(appEventsDir);
    } catch {
      appEventDays = [];
    }

    await Promise.all(
      appEventDays
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (filename) => {
          const day = filename.replace(/\.jsonl$/, '');
          const fileDayTime = retainedDayStartTime(day);
          if (fileDayTime === null || fileDayTime >= cutoffTime) {
            return;
          }
          await rm(getAgentObservabilityAppEventsDayFilePath(day), {
            force: true,
          });
        }),
    ).catch(() => {});

    const sessionEventsDir = getAgentObservabilitySessionEventsDir();
    let sessionEventDays: string[] = [];
    try {
      sessionEventDays = await readdir(sessionEventsDir);
    } catch {
      sessionEventDays = [];
    }

    await Promise.all(
      sessionEventDays
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (filename) => {
          const day = filename.replace(/\.jsonl$/, '');
          const fileDayTime = retainedDayStartTime(day);
          if (fileDayTime === null || fileDayTime >= cutoffTime) {
            return;
          }
          await rm(getAgentObservabilitySessionEventsDayFilePath(day), {
            force: true,
          });
        }),
    ).catch(() => {});

    const transcriptsDir = getAgentObservabilityTranscriptsDir();
    let transcriptDays: string[] = [];
    try {
      transcriptDays = await readdir(transcriptsDir);
    } catch {
      transcriptDays = [];
    }

    await Promise.all(
      transcriptDays.map(async (day) => {
        const directoryDayTime = retainedDayStartTime(day);
        if (directoryDayTime === null || directoryDayTime >= cutoffTime) {
          return;
        }
        await rm(getAgentObservabilityTranscriptDayDir(day), {
          force: true,
          recursive: true,
        });
      }),
    ).catch(() => {});

    const transcriptIndexDir = getAgentObservabilityTranscriptIndexDir();
    let transcriptIndexDays: string[] = [];
    try {
      transcriptIndexDays = await readdir(transcriptIndexDir);
    } catch {
      transcriptIndexDays = [];
    }

    await Promise.all(
      transcriptIndexDays
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (filename) => {
          const day = filename.replace(/\.jsonl$/, '');
          const fileDayTime = retainedDayStartTime(day);
          if (fileDayTime === null || fileDayTime >= cutoffTime) {
            return;
          }
          await rm(getAgentObservabilityTranscriptIndexDayFilePath(day), {
            force: true,
          });
        }),
    ).catch(() => {});
  }
}
