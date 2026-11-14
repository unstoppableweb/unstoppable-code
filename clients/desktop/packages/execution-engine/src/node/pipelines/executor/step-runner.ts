import { parseSendAgentMessageInputs } from '@canopy/execution-engine/pipelines/host-send-agent-message';
import type { PipelineAgentModelConfig } from '@canopy/execution-engine/types/pipeline';
import { resolvePipelineAgentAliasRoute } from '@canopy/pipeline-interop/agent-alias-model';
import { isSelectableAgentOverrideModel } from '@canopy/execution-engine/model-catalog';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import { backgroundExecutionDeniedMessage } from '@canopy/execution-engine/lib/automation-context-copy';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import {
  effectiveClaudeConfigDir,
  isSameClaudePath,
  type ClaudeModAdmissionLaunch,
} from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import type { ResourceContextInput } from '@canopy/execution-engine/lib/resource-context-policy';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  ChildPipelineAuthorization,
  ResolvedChildPipeline,
} from './child-pipeline-resolver';
import { requireHeadlessHarness } from '@canopy/execution-engine/model-harnesses';
import type { ModelHarnessInvocation } from '@canopy/execution-engine/types/model-harnesses';
import {
  isShutdownSignal,
  readShutdownAgentMetadata,
} from '@canopy/execution-engine/node/pipelines/executor/shutdown-recovery';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { resolveAnthropicMockEnvOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import { isPathInside } from '@canopy/execution-engine/node/lib/path-safety';
import { stepTimedOutMessage } from '@canopy/execution-engine/node/pipelines/step-timeout';
import {
  redactSecrets,
  redactSerializedJsonLine,
} from '@canopy/execution-engine/lib/redaction';
import {
  // Whitespace-insensitive matching that preserves every unmatched byte. The
  // verbatim helpers these replaced gave durable copies strictly weaker
  // protection than the inline field they mirror.
  redactNormalizedPreservingFormat as redactWorkerSecretValues,
  redactNormalizedStructuredValue as redactWorkerStructuredValue,
} from '../../../builtin-actions/agent-prompt/logic';
import {
  appendUserOverallPreferencesBlock,
  buildPipelineGlobalInstructionsBlock,
} from '@canopy/execution-engine/lib/global-instructions';
import { killChildProcessGroup } from '@canopy/execution-engine/node/lib/process-kill';
import { getPipelineExecutionPluginRuntimeDir } from '@canopy/execution-engine/node/lib/paths';
import { resolvePlugins } from '../../plugins/plugin-resolver';
import { validatePauseInputRequest } from '@canopy/execution-engine/pipelines/pause-input-validation';
import { executionContextSatisfies } from '@canopy/execution-engine/pipelines/scope';
import {
  brandEnvCandidates,
  brandEnvName,
  getBrandEnv,
  setBrandEnv,
} from '@canopy/execution-engine/brand/env';
import { BRAND } from '@canopy/brand/current';
import {
  getBundledBinDir,
  getBundledClaudeBinaryPath,
  getBundledCodexBinaryPath,
  getBundledRtkBinaryPath,
  getBundledRgBinaryPath,
  getEnhancedEnv,
  getLoginShellPath,
  getRtkManagedEnv,
} from '@canopy/execution-engine/node/pipelines/config-paths';
import { resolveChildPipeline } from './child-pipeline-resolver';
import { hostPortTakesAction, runHostAction } from './host-action-runner';
import {
  resolveActionRuntime,
  type ResolvedActionRuntime,
} from '../action-resolver';
import {
  getExecutionCheckoutRoot,
  inferExecutionScope,
  resolvePipelineTarget,
} from './pipeline-target-resolver';
import type {
  ActionRuns,
  Pipeline,
  PipelineExecutionScope,
  PipelineModelAlias,
  PipelineModelAliasDefaults,
  PipelineModelAliasPreference,
  PipelineTriggerType,
  PipelineStatusReason,
  AgentRecoveryCheckpoint,
  ResolvedPipelineExecutionTarget,
  PipelinePackageCapabilityOverlay,
} from '@canopy/execution-engine/types/pipeline';
import type { AgentActionFailureMetadata } from '@canopy/execution-engine/agent-failures';
import { getTriggerTypes } from '@canopy/execution-engine/types/pipeline';
import { BASE_BRANCH_MANAGED_ENV_KEYS } from '@canopy/execution-engine/pipelines/base-branch-env';
import {
  buildExpressionAssets,
  buildExpressionContext,
  cascadeEnv,
  inputsToEnv,
  parseOutputFile,
  type ExpressionCanopyContext,
  type ExpressionJobState,
} from './execution-context';
import {
  evaluateCondition,
  interpolateExpression,
} from './expression-evaluator';
import { interpolateNormalizedStep } from './step-interpolation';
import { buildModelRegistrySnapshot } from '@canopy/execution-engine/node/pipelines/executor/model-registry-snapshot';
import {
  normalizePipeline,
  resolvePipelineModelAlias,
} from '@canopy/execution-engine/node/pipelines/executor/normalize-pipeline';
import {
  DEFAULT_CLAUDE_MODEL,
  getConfiguredSupportedThinkingLevelsMap,
  getExecutionHarnessForModel,
  getModelSource,
  getEffectiveSupportedThinkingLevelsForModel,
  getProviderForModel,
  resolveModelAlias,
} from '@canopy/execution-engine/model-catalog';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/protocol/chat-targets';
import { mcpHttpAuthTargetKey } from '@canopy/execution-engine/lib/mcp-http-auth';
import { isGatewayOnlyModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import {
  readCodexSpeedRecord,
  mergeAgentModelConfig,
} from '@canopy/execution-engine/lib/codex-speed';
import type {
  AgentModelConfig,
  ChatTabPluginSelections,
} from '@canopy/execution-engine/execution-types';
import type { AgentProviderType } from '@canopy/agent-transcript';
import type { ModelHarness } from '@canopy/execution-engine/types/model-harnesses';
import type { UsageInitiationSource } from '@canopy/execution-engine/types/observability';
import { AGENT_MODEL_PREFIX } from '@canopy/execution-engine/types/agent-models';
import type {
  AgentPromptWorkerPermission,
  ClaudeModAdmissionContext,
  CodexPromptRunnerResult,
  ExecutionEvent,
  ExecutionState,
  ExecutionRuntime,
  NormalizedStep,
  PauseInputRequest,
  PipelineAgentModelAliasResolution,
  PipelineAiCreditsRoutingContext,
  PipelineAiCreditsRoutingOverride,
  PipelineLedgerAttempt,
  PipelineLedgerSubprocessTools,
  PipelineModelPolicyScope,
  PipelineStepNotification,
  ReportOutputs,
  SpawnedProcessResult as CompletedProcessResult,
  SpawnedProcessRunOptions,
  SpawnedProcessSpec as ProcessSpec,
  StepPostProcessContext,
  StepOutputEvent,
  StepOutputLogPosition,
  StepResult,
} from './types';
import {
  commitWholeStepLog,
  invalidateStepLogGeneration,
  openAppendingStepLogCursor,
  resetStepLogForPositionedWriter,
  type StepLogPositionCursor,
} from '@canopy/execution-engine/node/pipelines/executor/step-log-positions';
import {
  applyPlanPromptRequirement,
  parseMaxTurns,
  parseBooleanInput,
  parsePermissionPreset,
  parseSettingSources,
  parseStructuredSchema,
  parseThinkingEffort,
  READ_ONLY_TOOLS,
  redactNormalizedText,
  resolvePrompt,
  validateStructuredOutputInputs,
  type PermissionPreset,
} from '../../../builtin-actions/agent-prompt/logic';
import type {
  LogFormatHint,
  PipelineAgentChatAddress,
  PipelineAssetExecutionContext,
  PipelineExecutionInitiator,
  PipelineScalar,
  ResolvedPipelinePluginCollectionSnapshot,
} from '@canopy/execution-engine/types/pipeline';
import { resolveClaudeCompatibleInvocation as resolveSharedClaudeCompatibleInvocation } from '@canopy/execution-engine/node/ollama/claude-compatible';
import { findExecutableOnPath } from '@canopy/execution-engine/node/lib/path-lookup';
import {
  buildCmdCommandLine,
  wrapWindowsCommandShim,
} from '@canopy/execution-engine/node/lib/windows-process';
import { getDefaultShellTypeForCurrentProcess } from '@canopy/execution-engine/node/pipelines/default-shell';
import { sanitizeCodexSpawnEnvironment } from '../../codex-runtime/profile';
import {
  SecretValueRedactor,
  type RecordStoreFactory,
} from './spawned-process';
import { SurrogatePairGuard } from '@canopy/execution-engine/node/pipelines/executor/surrogate-safe-text';
import { trackLateStorageCleanup } from '@canopy/execution-engine/node/pipelines/executor/record-store';
import {
  appendPipelineLedgerInstructions,
  openPipelineLedgerAttempt,
  pipelineLedgerAttemptIdentity,
  pipelineLedgerAttemptOutcome,
  resolvePipelineLedgerAgent,
  resolvePipelineLedgerTarget,
} from './pipeline-ledger';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { MAX_NESTED_STEP_DEPTH } from './nesting-limit';

const FORCE_KILL_DELAY_MS = 5_000;
const DEFAULT_AGENT_TERMINAL_RESULT_GRACE_MS = 30_000;
const DEFAULT_AGENT_SETTING_SOURCES: readonly SettingSource[] = [
  'user',
  'project',
  'local',
];
export const PIPELINE_OUTPUT_ENV_KEY = 'PIPELINE_OUTPUT';
export const PIPELINE_JOB_RESTART_OUTPUT_KEY = 'PIPELINE_JOB_RESTART';
export const PAUSE_OUTPUT_KEYS = brandEnvCandidates('PAUSE');
export const INPUT_REQUEST_OUTPUT_KEYS = brandEnvCandidates('INPUT_REQUEST');
export const JOB_RESTART_OUTPUT_KEYS = [
  PIPELINE_JOB_RESTART_OUTPUT_KEY,
  ...brandEnvCandidates('JOB_RESTART'),
];
export const REPORT_OUTPUT_KEYS = brandEnvCandidates('OUTPUT_REPORT');
export const REPORT_JSON_OUTPUT_KEYS = brandEnvCandidates('OUTPUT_REPORT_JSON');
export const NOTIFICATION_OUTPUT_KEYS = brandEnvCandidates('NOTIFICATION');
export const PAUSE_OUTPUT_KEY = PAUSE_OUTPUT_KEYS[0] ?? brandEnvName('PAUSE');
export const INPUT_REQUEST_OUTPUT_KEY =
  INPUT_REQUEST_OUTPUT_KEYS[0] ?? brandEnvName('INPUT_REQUEST');
export const JOB_RESTART_OUTPUT_KEY = PIPELINE_JOB_RESTART_OUTPUT_KEY;
export const REPORT_OUTPUT_KEY =
  REPORT_OUTPUT_KEYS[0] ?? brandEnvName('OUTPUT_REPORT');
export const REPORT_JSON_OUTPUT_KEY =
  REPORT_JSON_OUTPUT_KEYS[0] ?? brandEnvName('OUTPUT_REPORT_JSON');
export const NOTIFICATION_OUTPUT_KEY =
  NOTIFICATION_OUTPUT_KEYS[0] ?? brandEnvName('NOTIFICATION');

const SENSITIVE_ENV_SUFFIXES = [
  '_KEY',
  '_TOKEN',
  '_SECRET',
  '_PASSWORD',
  '_CREDENTIALS',
];
const EXECUTOR_MANAGED_ENV_KEYS = new Set<string>([
  ...BASE_BRANCH_MANAGED_ENV_KEYS,
  ...brandEnvCandidates('PIPELINE_AGENT_HARNESS'),
]);

/**
 * Reserved step-output key the executor sets to `'true'` when a model-aware
 * agent action's LLM traffic was routed through the AI Credits gateway proxy.
 * Consumed by desktop observability (`syncPipelineStep`) so routed pipeline
 * turns are not mis-attributed to a native provider subscription account.
 */
export const AI_CREDITS_ROUTED_OUTPUT_KEY = 'canopy_ai_credits_routed';
/** Persisted proof that this exact step used an organization-owned gateway. */
export const MODEL_GATEWAY_ROUTED_OUTPUT_KEY = 'canopy_model_gateway_routed';
/**
 * Set when the step's agent went through the account proxy (CAN-4030), so
 * desktop observability credits no native account with it.
 */
export const ACCOUNT_PROXY_ROUTED_OUTPUT_KEY = 'canopy_account_proxy_routed';
/**
 * The broker route the step's agent used through the account proxy, so
 * desktop observability can record which accounts served it (CAN-4021). An
 * opaque route id; never an account name.
 */
export const ACCOUNT_PROXY_SESSION_OUTPUT_KEY = 'canopy_account_proxy_session';

function accountProxyRouteOutputs(
  routeSessionId: string | undefined,
): Record<string, string> {
  return {
    [ACCOUNT_PROXY_ROUTED_OUTPUT_KEY]: 'true',
    ...(routeSessionId
      ? { [ACCOUNT_PROXY_SESSION_OUTPUT_KEY]: routeSessionId }
      : {}),
  };
}

export function stepRequestedPause(outputs: Record<string, string>): boolean {
  const value = firstOutputValue(outputs, PAUSE_OUTPUT_KEYS)
    ?.trim()
    .toLowerCase();
  return value === 'true' || value === '1';
}

export function stepRequestedRestart(outputs: Record<string, string>): boolean {
  const value = firstOutputValue(outputs, JOB_RESTART_OUTPUT_KEYS)
    ?.trim()
    .toLowerCase();
  return value === 'true' || value === '1';
}

export function extractReportOutputs(
  outputs: Record<string, string>,
): ReportOutputs | undefined {
  const reportOutputs: ReportOutputs = {};

  const reportFile = firstOutputValue(outputs, REPORT_OUTPUT_KEYS);
  const reportJsonFile = firstOutputValue(outputs, REPORT_JSON_OUTPUT_KEYS);

  if (reportFile) {
    reportOutputs.report_file = reportFile;
  }

  if (reportJsonFile) {
    reportOutputs.report_json_file = reportJsonFile;
  }

  if (!reportOutputs.report_file && !reportOutputs.report_json_file) {
    return undefined;
  }

  return reportOutputs;
}

export function extractInputRequest(
  outputs: Record<string, string>,
): { request: PauseInputRequest } | { error: string } | undefined {
  const raw = firstOutputValue(outputs, INPUT_REQUEST_OUTPUT_KEYS);
  if (!raw) {
    return undefined;
  }

  try {
    const request = validatePauseInputRequest(JSON.parse(raw));
    return request
      ? { request }
      : { error: 'request-input metadata failed validation' };
  } catch {
    return { error: 'request-input metadata is not valid JSON' };
  }
}

function isNotificationRecord(
  value: unknown,
): value is PipelineStepNotification {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, 'title') === 'string' &&
    typeof Reflect.get(value, 'body') === 'string'
  );
}

export function extractNotificationOutputs(
  outputs: Record<string, string>,
):
  | { notifications: PipelineStepNotification[] }
  | { error: string }
  | undefined {
  const raw = firstOutputValue(outputs, NOTIFICATION_OUTPUT_KEYS);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isNotificationRecord(parsed)) {
      return { error: 'notification metadata failed validation' };
    }
    return {
      notifications: [
        {
          title: parsed.title,
          body: parsed.body,
        },
      ],
    };
  } catch {
    return { error: 'notification metadata is not valid JSON' };
  }
}

export function sanitizeReportOutputKeys(
  outputs: Record<string, string>,
): Record<string, string> {
  return sanitizeOutputKeys(outputs, [
    ...REPORT_OUTPUT_KEYS,
    ...REPORT_JSON_OUTPUT_KEYS,
  ]);
}

export function sanitizePauseOutputKeys(
  outputs: Record<string, string>,
): Record<string, string> {
  return sanitizeOutputKeys(outputs, PAUSE_OUTPUT_KEYS);
}

export function sanitizeRestartOutputKeys(
  outputs: Record<string, string>,
): Record<string, string> {
  return sanitizeOutputKeys(outputs, JOB_RESTART_OUTPUT_KEYS);
}

export function sanitizeNotificationOutputKeys(
  outputs: Record<string, string>,
): Record<string, string> {
  return sanitizeOutputKeys(outputs, NOTIFICATION_OUTPUT_KEYS);
}

function firstOutputValue(
  outputs: Record<string, string>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = outputs[key];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function sanitizeOutputKeys(
  outputs: Record<string, string>,
  keys: string[],
): Record<string, string> {
  const sanitized = { ...outputs };
  for (const key of keys) {
    delete sanitized[key];
  }
  return sanitized;
}

const AGENT_FAILURE_OUTPUT_KEYS = [
  'agent_failure_metadata_file',
  'agent_failure_transcript_file',
];
const RECOVERABLE_REASON_KINDS = new Set([
  'provider_authentication_required',
  'provider_usage_limit',
  'provider_temporarily_unavailable',
]);
const RECOVERABLE_REASON_CODES = new Set([
  'authentication_failed',
  'unauthorized',
  'oauth_organization_forbidden',
  'http_401',
  'rate_limit',
  'usage_limit_exceeded',
  'credits_depleted',
  'http_429',
  'model_capacity',
  'server_overloaded',
  'internal_server_error',
  'http_5xx',
  'connection_failed',
  'stream_disconnected',
  'provider_timeout',
]);

function sanitizeAgentFailureOutputKeys(
  outputs: Record<string, string>,
): Record<string, string> {
  return sanitizeOutputKeys(outputs, AGENT_FAILURE_OUTPUT_KEYS);
}

export function sanitizePauseControlOutputKeys(
  outputs: Record<string, string>,
): Record<string, string> {
  return sanitizeOutputKeys(outputs, [
    ...PAUSE_OUTPUT_KEYS,
    ...INPUT_REQUEST_OUTPUT_KEYS,
  ]);
}

function buildBrandManagedEnv(
  values: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [suffix, value] of Object.entries(values)) {
    setBrandEnv(env, suffix, value);
  }
  return env;
}

function buildStepManagedEnv(
  values: Record<string, string>,
): Record<string, string> {
  const env = buildBrandManagedEnv(values);
  const outputFile = values.OUTPUT;
  if (outputFile !== undefined) {
    env[PIPELINE_OUTPUT_ENV_KEY] = outputFile;
  }
  return env;
}

export function buildBundledBinaryEnv(): Record<string, string> {
  const values: Record<string, string> = {
    CLAUDE_BINARY_PATH: getBundledClaudeBinaryPath(),
    CODEX_BINARY_PATH: getBundledCodexBinaryPath(),
    RG_BINARY_PATH: getBundledRgBinaryPath(),
    RTK_BINARY_PATH: getBundledRtkBinaryPath(),
  };
  return buildBrandManagedEnv(values);
}

function buildExecutionMetadataEnv(
  options: RunStepOptions,
): Record<string, string> {
  return buildBrandManagedEnv({
    EXECUTION_ID: options.executionId,
    PIPELINE_ID: options.pipelineId ?? '',
    EVENT_NAME: options.canopy?.event_name ?? '',
    ...buildPipelineAssetEnvValues(options.pipelineAssets),
  });
}

/**
 * Brand env suffixes for the run's asset context: `ASSET_<ID>` per declared
 * asset, `ASSETS_DIR` and `PIPELINE_DATA_DIR`. A dir main did not resolve is
 * omitted rather than set empty.
 */
export function buildPipelineAssetEnvValues(
  pipelineAssets: PipelineAssetExecutionContext | undefined,
): Record<string, string> {
  if (!pipelineAssets) return {};
  const values: Record<string, string> = {};
  for (const [id, assetPath] of Object.entries(pipelineAssets.asset_paths)) {
    values[`ASSET_${id.toUpperCase()}`] = assetPath;
  }
  if (pipelineAssets.assets_dir !== undefined) {
    values.ASSETS_DIR = pipelineAssets.assets_dir;
  }
  if (pipelineAssets.pipeline_data_dir !== undefined) {
    values.PIPELINE_DATA_DIR = pipelineAssets.pipeline_data_dir;
  }
  return values;
}

/** The secret values step output masks (CAN-5095: also a daemon run's Ledger masking). */
export function getSecretValues(
  secretEnv: Record<string, string> | undefined,
): string[] {
  return Object.values(secretEnv ?? {}).filter((value) => value.length >= 6);
}

/** Env vars allowlisted into pipeline subprocesses for the Claude mock redirect. */
const CLAUDE_MOCK_PASSTHROUGH_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

/**
 * Force the Claude mock-redirect env vars into the safe pipeline-subprocess env,
 * overriding the sensitive-suffix filter (`ANTHROPIC_AUTH_TOKEN` ends in
 * `_TOKEN`). The Claude-backed builtin action subprocess otherwise takes no SDK
 * `env`, so without this passthrough it would hit the real Anthropic endpoint.
 *
 * Pure (no gate, reads only from the supplied `sourceEnv`) so it is
 * unit-testable directly. Only copies a key when present in `sourceEnv`;
 * mutates and returns `safe`.
 */
export function applyClaudeMockPipelineEnv(
  safe: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
): Record<string, string> {
  // Only redirect when a mock base url is actually configured for this run.
  if (!sourceEnv.ANTHROPIC_BASE_URL?.trim()) {
    return safe;
  }
  for (const key of CLAUDE_MOCK_PASSTHROUGH_KEYS) {
    const value = sourceEnv[key];
    if (value !== undefined) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Whether an inherited variable looks like a credential a step must not get
 * by inheritance: its value is the one `inherited` holds, under a sensitive
 * suffix. A value the user configured differently still passes.
 */
export function isInheritedSensitiveEnv(
  key: string,
  value: string,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const upper = key.toUpperCase();
  return (
    inherited[key] === value &&
    SENSITIVE_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix))
  );
}

function buildSafeProcessEnv(
  source?: Readonly<Record<string, string>>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    source ??
      getEnhancedEnv({ environment: false, includeCanopySecrets: false }),
  )) {
    if (value === undefined) continue;
    if (EXECUTOR_MANAGED_ENV_KEYS.has(key)) {
      continue;
    }
    if (isInheritedSensitiveEnv(key, value)) continue;
    safe[key] = value;
  }
  // Propagate model IDs and aliases so action subprocesses can validate
  // and resolve models without needing Electron's app.getAppPath().
  for (const [key, value] of Object.entries(buildModelRegistrySnapshot()))
    setBrandEnv(safe, key, value);
  if (source?.PATH !== undefined) {
    // A supplied base environment brings the PATH its core resolved.
    safe.PATH = source.PATH;
  } else {
    const loginPath = getLoginShellPath();
    safe.PATH = loginPath;
    const binDir = getBundledBinDir();
    if (binDir) {
      safe.PATH = loginPath ? `${binDir}${path.delimiter}${loginPath}` : binDir;
    }
  }
  // UI-automation seam: translate the harness mock LLM base URL into the
  // Anthropic SDK env vars consumed by Claude-backed builtin action
  // subprocesses. The `__CANOPY_E2E__` gate and mock markers live inside the
  // shared helper, which production bundles fold to `return undefined`.
  const mockEnvOverride = resolveAnthropicMockEnvOverride();
  if (mockEnvOverride) {
    applyClaudeMockPipelineEnv(safe, mockEnvOverride);
  }
  return safe;
}

/**
 * Build the process spec used for Node-based steps and actions.
 *
 * In Electron runtimes `process.execPath` points at the Electron binary, so
 * we force child processes into Node compatibility mode. In SEA builds there
 * is no usable embedded Node runtime, so we fall back to `node` on PATH.
 */
function getNodeProcessSpec(
  args: string[],
  override?: ExecutionRuntime['nodeProcess'],
): ProcessSpec {
  if (override) {
    return {
      command: override.command,
      args,
      ...(override.env ? { env: { ...override.env } } : {}),
    };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require('node:sea') as { isSea: () => boolean };
    if (sea.isSea()) {
      return {
        command: 'node',
        args,
      };
    }
  } catch {
    // node:sea module not available — not a SEA build.
  }

  if (process.versions.electron) {
    return {
      command: process.execPath,
      args,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
      },
    };
  }

  return {
    command: process.execPath,
    args,
  };
}

export interface RunStepOptions {
  executionId: string;
  jobId: string;
  jobName?: string;
  step: NormalizedStep;
  cwd: string;
  env: Record<string, string>;
  pipelineFileDir?: string;
  /** In-memory file source locator, independent of the execution target. */
  pipelineSource?: { cwd: string; filePath: string };
  /** In-memory inherited provenance for inline children; never sourced from YAML. */
  inlinePipelineResource?: ResourceContextInput['resource'];
  /** Sensitive env vars merged at spawn time only — never persisted. */
  secretEnv?: Record<string, string>;
  runtime: ExecutionRuntime;
  repoPath?: string;
  executionCheckoutRoot?: string | null;
  scope?: PipelineExecutionScope;
  target?: ResolvedPipelineExecutionTarget;
  modelConfig?: AgentModelConfig;
  signal: AbortSignal;
  parentStepId?: string;
  depth?: number;
  attempt?: number;
  iteration?: number;
  recovery?: number;
  recoveryCheckpoint?: AgentRecoveryCheckpoint;
  childId?: string;
  resumeChildExecutionId?: string;
  resumeChildReasonIds?: string[];
  jobContext?: ExpressionJobState;
  canopy?: ExpressionCanopyContext;
  /** Resolved asset paths and data dirs; inherited by child runs. */
  pipelineAssets?: PipelineAssetExecutionContext;
  onStepOutput?: (event: StepOutputEvent) => void;
  onEvent?: (event: ExecutionEvent) => void;
  projectId?: string;
  worktreeId?: string;
  initiationSource?: UsageInitiationSource;
  initiator?: PipelineExecutionInitiator;
  agentOrigin?: PipelineAgentChatAddress;
  executionContext?: string;
  childPipelineAuthorizations?: readonly ChildPipelineAuthorization[];
  allowUnverifiedForegroundChildren?: boolean;
  agentTerminalMode?: boolean;
  pipelineId?: string;
  pipelineName?: string;
  planId?: string;
  resolvedPluginCollections?: Record<
    string,
    ResolvedPipelinePluginCollectionSnapshot
  >;
  modelAliases?: readonly PipelineModelAlias[];
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
  onStepPostProcess?: (ctx: StepPostProcessContext) => void | Promise<void>;
  onLogMetadataResolved?: (metadata: StepLogMetadata) => Promise<void>;
  /**
   * Called just before the step spawns each process, so the memory admission
   * gate times its settle window from the process start (CAN-6325).
   */
  onProcessStart?: () => void;
  onRunningStepPatch?: (
    stepId: string,
    patch: Partial<StepResult>,
  ) => Promise<void>;
  pipelinePackageOverlay?: PipelinePackageCapabilityOverlay;
  /** The job as the pipeline declares it; defaults to `jobId`. */
  logicalJobId?: string;
  /** The Ledger agent session the step's recovery checkpoint resumes. */
  ledgerAgentSessionId?: string;
  /** The Ledger agent session of the attempt a job retry replaces. */
  ledgerPredecessorAgentSessionId?: string;
}

type AgentTerminalResultStatus = 'success' | 'failure';

interface FinalizeProcessOptions {
  preserveForceKillTimer?: boolean;
}

export interface StepLogMetadata {
  log_format_hint?: LogFormatHint;
  agent_provider?: AgentProviderType;
  agent_harness?:
    | 'claude'
    | 'codex'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode';
  agent_model?: string;
  agent_runtime_model?: string;
  agent_model_config?: PipelineAgentModelConfig;
  model_alias?: string;
  model_alias_name?: string;
  model_alias_plugin_collection_ids?: string[];
}

const CLAUDE_ONLY_AGENT_ACTIONS = new Set([
  'builtin/agent-loop',
  'builtin/plan-with-review',
  'builtin/quality-gate',
  'builtin/router',
]);

const MODEL_AWARE_AGENT_ACTIONS = new Set([
  'builtin/agent-prompt',
  'builtin/agent-resume',
]);

/** Bundled node actions that invoke the Claude SDK directly. */
const DIRECT_CLAUDE_PROVIDER_ACTIONS = new Set([
  'builtin/agent-loop',
  'builtin/plan-with-review',
  'builtin/quality-gate',
  'builtin/router',
  'builtin/condenser',
  'builtin/parallel-agents',
  'builtin/git-commit-push',
  'builtin/github-create-pr',
]);

/**
 * Actions whose manifest carries `log_format_hint: agent` so that agent-step
 * *counting* recognizes them, but which fan work out to child agents instead of
 * producing their own agent transcript. Their stdout is an aggregate JSON
 * report, not provider stream-JSON.
 *
 * The hint is therefore deliberately not propagated onto the step *result*:
 * doing so would make the observability service open a `pipeline_agent_turn`
 * audit entry that can never be filled (0 messages, 0 tokens, $0 — which then
 * scores as a real agent turn), and would make the renderer try to parse the
 * aggregate log as an agent transcript. Counting is unaffected because it
 * matches on the action ref (`BUNDLED_AGENT_ACTION_REFS`), not on this field.
 */
const FANOUT_AGENT_ACTIONS = new Set(['builtin/parallel-agents']);

const AGENT_MODEL_SYNTHETIC_PLUGIN_COLLECTION_PREFIX =
  '__canopy_agent_model__:';

function getTsxCommand(
  runtime: Pick<ExecutionRuntime, 'nodeProcess' | 'tsxCli'>,
): ProcessSpec {
  const { nodeProcess } = runtime;
  // A runtime that stages its own tsx runs it on its own Node (CAN-6316 G1).
  if (runtime.tsxCli) return getNodeProcessSpec([runtime.tsxCli], nodeProcess);
  const localCli = findLocalNodeModuleFile(
    ['tsx', 'dist', 'cli.mjs'],
    [process.cwd(), __dirname],
  );

  if (localCli) {
    return getNodeProcessSpec([localCli], nodeProcess);
  }

  return {
    command: hostOperatingSystem() === 'win32' ? 'tsx.cmd' : 'tsx',
    args: [],
  };
}

function getAgentTerminalResultGraceMs(): number {
  const raw = getBrandEnv(process.env, 'AGENT_TERMINAL_RESULT_GRACE_MS');
  if (!raw) {
    return DEFAULT_AGENT_TERMINAL_RESULT_GRACE_MS;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_AGENT_TERMINAL_RESULT_GRACE_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseAgentTerminalResultLine(
  line: string,
): AgentTerminalResultStatus | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  if (parsed.type !== 'result') {
    return undefined;
  }

  const subtype =
    typeof parsed.subtype === 'string' ? parsed.subtype : undefined;
  if (subtype) {
    return subtype === 'success' ? 'success' : 'failure';
  }

  return parsed.is_error === false ? 'success' : 'failure';
}

function findLocalNodeModuleFile(
  relativeSegments: string[],
  startDirs: string[],
): string | undefined {
  const visited = new Set<string>();

  for (const startDir of startDirs) {
    let currentDir = path.resolve(startDir);
    while (!visited.has(currentDir)) {
      visited.add(currentDir);
      const candidate = path.join(
        currentDir,
        'node_modules',
        ...relativeSegments,
      );
      if (fs.existsSync(candidate)) {
        return candidate;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  return undefined;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}

export function getStepLogFilePath(
  runtime: ExecutionRuntime,
  executionId: string,
  jobId: string,
  stepId: string,
  attempt = 0,
  iteration = 1,
  recovery = 0,
  childId?: string,
): string {
  const attemptSuffix = attempt > 0 ? `--attempt${attempt}` : '';
  const iterationSuffix = iteration > 1 ? `--iter${iteration}` : '';
  const recoverySuffix = recovery > 0 ? `--recovery${recovery}` : '';
  const childSegment = childId ? `--${sanitizePathSegment(childId)}` : '';
  return path.join(
    runtime.executionsDir,
    executionId,
    'logs',
    `${sanitizePathSegment(jobId)}${childSegment}--${sanitizePathSegment(stepId)}${attemptSuffix}${iterationSuffix}${recoverySuffix}.log`,
  );
}

async function ensureLogFile(
  runtime: ExecutionRuntime,
  executionId: string,
  jobId: string,
  stepId: string,
  attempt = 0,
  iteration = 1,
  recovery = 0,
  childId?: string,
): Promise<string> {
  const logDir = path.join(runtime.executionsDir, executionId, 'logs');
  await fsp.mkdir(logDir, { recursive: true });
  const logFile = getStepLogFilePath(
    runtime,
    executionId,
    jobId,
    stepId,
    attempt,
    iteration,
    recovery,
    childId,
  );
  // A rerun of the same identity truncates the previous content, so readers
  // must stop joining events against the previous generation first.
  invalidateStepLogGeneration(logFile);
  await fsp.writeFile(logFile, '', 'utf8');
  return logFile;
}

async function readOutputMap(
  filePath: string,
): Promise<Record<string, string>> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return parseOutputFile(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function createProcessFiles(
  runtime: ExecutionRuntime,
  executionId: string,
  jobId: string,
  stepId: string,
): Promise<{ tempDir: string; outputFile: string; envFile: string }> {
  const tempDir = path.join(
    runtime.tempRootDir,
    sanitizePathSegment(executionId),
    sanitizePathSegment(jobId),
    `${sanitizePathSegment(stepId)}-${randomUUID()}`,
  );
  await fsp.mkdir(tempDir, { recursive: true });

  return {
    tempDir,
    outputFile: path.join(tempDir, `${BRAND.internalName}-output.txt`),
    envFile: path.join(tempDir, `${BRAND.internalName}-env.txt`),
  };
}

async function writeInlineScript(
  tempDir: string,
  shell: NormalizedStep['shell'],
  content: string,
): Promise<string> {
  const extension =
    shell === 'python'
      ? 'py'
      : shell === 'pwsh' || shell === 'powershell'
        ? 'ps1'
        : shell === 'cmd'
          ? 'cmd'
          : shell === 'tsx'
            ? 'ts'
            : shell === 'node'
              ? 'mjs'
              : 'sh';
  const scriptPath = path.join(tempDir, `inline-step.${extension}`);
  await fsp.writeFile(scriptPath, content, 'utf8');
  return scriptPath;
}

export function getPythonProcessSpec(scriptPath: string): ProcessSpec {
  if (hostOperatingSystem() === 'win32') {
    if (findExecutableOnPath('py.exe')) {
      return { command: 'py.exe', args: ['-3', scriptPath] };
    }
    return { command: 'python.exe', args: [scriptPath] };
  }

  return { command: 'python3', args: [scriptPath] };
}

export function getPowerShellProcessSpec(
  shell: 'pwsh' | 'powershell',
  scriptPath: string,
): ProcessSpec {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ];

  if (hostOperatingSystem() === 'win32') {
    if (shell === 'pwsh') {
      const command = findExecutableOnPath('pwsh.exe');
      if (!command) {
        throw new Error(
          'Step requested shell: pwsh but PowerShell 7+ (pwsh.exe) is not on PATH.',
        );
      }
      return { command, args, scriptPath };
    }

    const command = findExecutableOnPath('powershell.exe') ?? 'powershell.exe';
    return { command, args, scriptPath };
  }

  const command = findExecutableOnPath(shell) ?? shell;
  return { command, args, scriptPath };
}

function getCmdProcessSpec(scriptPath: string): ProcessSpec {
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', buildCmdCommandLine(scriptPath)],
    scriptPath,
  };
}

async function buildRunProcessSpec(
  step: NormalizedStep,
  tempDir: string,
  runtime: Pick<ExecutionRuntime, 'nodeProcess' | 'tsxCli'>,
): Promise<ProcessSpec> {
  const { nodeProcess } = runtime;
  if (!step.run) {
    throw new Error(`Step "${step.id}" is missing a run command`);
  }

  switch (step.shell) {
    case 'bash':
    case 'sh':
      return {
        command: step.shell,
        args: ['-c', step.run],
      };
    case 'python': {
      const scriptPath = await writeInlineScript(tempDir, step.shell, step.run);
      return {
        ...getPythonProcessSpec(scriptPath),
        scriptPath,
      };
    }
    case 'pwsh':
    case 'powershell': {
      const scriptPath = await writeInlineScript(tempDir, step.shell, step.run);
      return getPowerShellProcessSpec(step.shell, scriptPath);
    }
    case 'cmd': {
      const scriptPath = await writeInlineScript(tempDir, step.shell, step.run);
      return getCmdProcessSpec(scriptPath);
    }
    case 'node': {
      const scriptPath = await writeInlineScript(tempDir, step.shell, step.run);
      return {
        ...getNodeProcessSpec([scriptPath], nodeProcess),
        scriptPath,
      };
    }
    case 'tsx': {
      const scriptPath = await writeInlineScript(tempDir, step.shell, step.run);
      const tsx = getTsxCommand(runtime);
      return {
        ...tsx,
        args: [...tsx.args, scriptPath],
        scriptPath,
      };
    }
    default:
      throw new Error(`Unsupported shell "${String(step.shell)}"`);
  }
}

function resolveActionInputs(
  action: ResolvedActionRuntime,
  step: NormalizedStep,
): Record<string, string> {
  const result: Record<string, string> = {};
  const definitions = action.definition.inputs ?? {};
  const provided = step.with ?? {};

  for (const [name, input] of Object.entries(definitions)) {
    const value = provided[name] ?? input.default;
    if (value === undefined && input.required) {
      throw new Error(`Action input "${name}" is required for "${step.uses}"`);
    }
    if (value !== undefined) {
      result[name] = String(value);
    }
  }

  for (const [name, value] of Object.entries(provided)) {
    if (result[name] === undefined) {
      result[name] = String(value);
    }
  }

  return result;
}

function isPlainObject(
  value: unknown,
): value is Record<string, string | number | boolean | null> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseChildPipelineInputs(
  raw: string | undefined,
): Record<string, string> {
  if (!raw?.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('run-pipeline inputs must be valid JSON');
  }

  if (!isPlainObject(parsed)) {
    throw new Error('run-pipeline inputs must be a JSON object');
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => {
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new Error(
          'run-pipeline inputs must contain only string, number, or boolean values',
        );
      }
      return [key, String(value)];
    }),
  );
}

function buildNestedStepId(
  parentStepId: string,
  childJobId: string,
  childStepId: string,
): string {
  return `${parentStepId}/${childJobId}/${childStepId}`;
}

function resolveChildCwd(
  parentCwd: string,
  rawChildCwd: string | undefined,
): string {
  if (!rawChildCwd?.trim()) {
    return parentCwd;
  }

  const resolvedCwd = path.resolve(parentCwd, rawChildCwd);
  if (path.isAbsolute(rawChildCwd) || !isPathInside(parentCwd, resolvedCwd)) {
    throw new Error(`Invalid child cwd "${rawChildCwd}"`);
  }
  return resolvedCwd;
}

export function buildNestedPipelineOutputs(
  state: ExecutionState,
): Record<string, string> {
  const nestedOutputs = Object.fromEntries(
    Object.entries(state.jobs).map(([jobId, job]) => [
      jobId,
      job.outputs ?? {},
    ]),
  );
  const flattenedOutputs = Object.fromEntries(
    Object.entries(nestedOutputs).flatMap(([jobId, outputs]) =>
      Object.entries(outputs).map(([name, value]) => [
        `${jobId}.${name}`,
        value,
      ]),
    ),
  );

  const flattened: Record<string, string> = {
    status: state.status,
    outputs: JSON.stringify(nestedOutputs),
    ...flattenedOutputs,
  };

  if (state.report_outputs?.report_file) {
    flattened[REPORT_OUTPUT_KEY] = state.report_outputs.report_file;
  }

  if (state.report_outputs?.report_json_file) {
    flattened[REPORT_JSON_OUTPUT_KEY] = state.report_outputs.report_json_file;
  }

  return flattened;
}

function isPipelineTriggerType(value: string): value is PipelineTriggerType {
  return (
    value === 'dispatch' ||
    value === 'plan_ready' ||
    value === 'task_ready' ||
    value === 'workflow'
  );
}

function extractTriggerType(
  canopy: ExpressionCanopyContext | undefined,
): PipelineTriggerType | undefined {
  if (!canopy) {
    return undefined;
  }
  if (isPipelineTriggerType(canopy.event_name)) {
    return canopy.event_name;
  }
  return undefined;
}

function resolveChildEventName(
  pipeline: Pipeline,
  canopy: ExpressionCanopyContext | undefined,
): PipelineTriggerType | undefined {
  const inheritedTrigger = extractTriggerType(canopy);
  const childTriggers = getTriggerTypes(pipeline.on);
  if (inheritedTrigger && childTriggers.includes(inheritedTrigger)) {
    return inheritedTrigger;
  }
  // A child that declares only `workflow` runs as `workflow`, so its inputs
  // resolve from `on.workflow.inputs` rather than an undeclared `dispatch`.
  if (
    !childTriggers.includes('dispatch') &&
    childTriggers.includes('workflow')
  ) {
    return 'workflow';
  }
  return undefined;
}

async function runNestedPipelineAction(
  action: ResolvedActionRuntime,
  options: RunStepOptions & {
    resolvedCwd: string;
    logFile: string;
    logMetadata: StepLogMetadata;
  },
): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const inputValues = resolveActionInputs(action, options.step);
  if (
    inputValues.cwd?.trim() &&
    options.step.target?.scope === 'directory' &&
    options.step.target.path?.trim()
  ) {
    throw new Error(
      'run-pipeline cannot define both with.cwd and target.path; use target.path',
    );
  }
  if (
    options.executionContext !== undefined &&
    parseWorkspaceContext(options.executionContext)?.kind === 'organization' &&
    options.childPipelineAuthorizations === undefined &&
    options.allowUnverifiedForegroundChildren !== true
  ) {
    throw new Error(backgroundExecutionDeniedMessage('unsupported-target'));
  }
  const childInputs = parseChildPipelineInputs(inputValues.inputs);
  const getProjectPipelinesDirCandidates = (repoPath: string): string[] =>
    options.runtime.getProjectPipelinesDirCandidates?.(repoPath) ?? [
      options.runtime.getProjectPipelinesDir(repoPath),
    ];
  const parentRequest = {
    pipelineId: options.pipelineId,
    projectId: options.projectId,
    cwd: options.repoPath ?? options.resolvedCwd,
    pipelineFileDir: options.pipelineFileDir,
    ...(options.pipelineSource
      ? { pipelineSource: options.pipelineSource }
      : {}),
  };
  const parentResource =
    options.inlinePipelineResource ??
    (options.executionContext === undefined
      ? await options.runtime.resolvePipelineContextResource?.(parentRequest)
      : await options.runtime.resolvePipelineContextResource?.(
          parentRequest,
          options.executionContext,
        ));
  const { pipeline, pipelineId, pipelineFileDir, preferenceLocator, packaged } =
    await resolveChildPipeline({
      resolvePipelineResource:
        options.executionContext === undefined
          ? options.runtime.resolvePipelineResource
          : async (
              reference,
              parent,
              file,
            ): Promise<ResolvedChildPipeline | undefined> =>
              options.runtime.resolvePipelineResource?.(
                reference,
                parent,
                file,
                undefined,
                options.executionContext,
              ),
      parent: parentResource,
      ...(options.childPipelineAuthorizations === undefined
        ? {}
        : { authorizations: options.childPipelineAuthorizations }),
      pipelineRef: inputValues.pipeline,
      pipelineYaml: inputValues.pipeline_yaml,
      cwd: options.resolvedCwd,
      pipelineFileDir: options.pipelineFileDir,
      repoPath: options.pipelineSource?.cwd ?? options.repoPath,
      getProjectPipelinesDirCandidates,
      packageOverlay: options.pipelinePackageOverlay,
    });
  const parentScope =
    options.scope ??
    inferExecutionScope({
      projectId: options.projectId,
      worktreeId: options.worktreeId,
    });
  // An explicit worktree target is where expressions can name another owner's
  // project; an inherited target is the parent run's own. It is checked by id
  // before resolution, so a missing target fails exactly like another owner's
  // and nothing of the other owner's is read. A legacy `with.cwd` path is not
  // a workspace id and is not owner-checked here.
  const requestedTarget = options.step.target;
  if (requestedTarget?.scope === 'worktree') {
    await options.runtime.pipelineOwnership?.authorizeTarget({
      executionContext: options.executionContext,
      target: {
        scope: 'worktree',
        workspace_id: requestedTarget.workspace_id,
        worktree_id: requestedTarget.worktree.id,
      },
    });
  }
  let resolvedTarget = await resolvePipelineTarget(options.runtime, {
    parent: {
      cwd: options.resolvedCwd,
      scope: parentScope,
      target: options.target,
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      repoPath: options.repoPath,
    },
    requested: options.step.target ?? { scope: 'inherit' },
  });
  const executionCheckoutRoot =
    options.step.target && options.step.target.scope !== 'inherit'
      ? getExecutionCheckoutRoot(resolvedTarget)
      : getExecutionCheckoutRoot(options);
  if (
    inputValues.cwd?.trim() &&
    resolvedTarget.scope !== 'global' &&
    resolvedTarget.target.scope !== 'global'
  ) {
    const legacyCwd = resolveChildCwd(resolvedTarget.cwd, inputValues.cwd);
    const legacyTarget: ResolvedPipelineExecutionTarget =
      resolvedTarget.target.scope === 'worktree'
        ? { ...resolvedTarget.target, path: legacyCwd }
        : { scope: 'directory', path: legacyCwd };
    resolvedTarget = {
      ...resolvedTarget,
      cwd: legacyCwd,
      target: legacyTarget,
      repoPath:
        resolvedTarget.target.scope === 'worktree'
          ? resolvedTarget.repoPath
          : legacyCwd,
    };
  }
  // Recheck child ownership against the final target, including step overrides.
  // Packaged children live in the package cache, not a project root; they are
  // owned by the parent, so only the parent is rechecked against the target.
  if (parentResource) {
    const childFile =
      preferenceLocator?.type === 'file' && !packaged
        ? {
            cwd:
              options.pipelineSource?.cwd ??
              options.repoPath ??
              options.resolvedCwd,
            filePath: preferenceLocator.value,
          }
        : undefined;
    if (options.executionContext === undefined)
      await options.runtime.resolvePipelineResource?.(
        pipelineId,
        parentResource,
        childFile,
        resolvedTarget,
      );
    else
      await options.runtime.resolvePipelineResource?.(
        pipelineId,
        parentResource,
        childFile,
        resolvedTarget,
        options.executionContext,
      );
  }
  const normalizedChildPipeline = normalizePipeline(pipeline, {
    defaultShell: getDefaultShellTypeForCurrentProcess(),
  });
  if (
    !executionContextSatisfies(
      normalizedChildPipeline.scope,
      resolvedTarget.scope,
    )
  ) {
    throw new Error(
      `Step "${options.step.id}" in job "${options.jobId}" targets scope "${resolvedTarget.scope}" but child workflow "${pipelineId}" supports [${normalizedChildPipeline.scope.join(', ')}]`,
    );
  }
  const parentStepId = options.parentStepId ?? options.step.id;
  await fsp.appendFile(
    options.logFile,
    `[run-pipeline] starting ${pipelineId}\n`,
    'utf8',
  );

  const { executePipeline, resumePipeline } =
    await import('./pipeline-executor');
  const effectiveIteration = options.iteration ?? 1;
  const childExecutionOptions = {
    cwd: resolvedTarget.cwd,
    executionCheckoutRoot,
    pipelineId,
    scope: resolvedTarget.scope,
    target: resolvedTarget.target,
    env: options.env,
    secretEnv: options.secretEnv,
    inputs: childInputs,
    ...(parentResource && !inputValues.pipeline?.trim()
      ? { inlinePipelineResource: parentResource }
      : {}),
    pipelineFileDir,
    ...(parentResource && preferenceLocator?.type === 'file'
      ? {
          pipelineSource: {
            cwd:
              options.pipelineSource?.cwd ??
              options.repoPath ??
              options.resolvedCwd,
            filePath: preferenceLocator.value,
          },
        }
      : {}),
    repoPath: resolvedTarget.repoPath,
    runtime: options.runtime,
    pipelinePackageOverlay: options.pipelinePackageOverlay,
    // Children read the root run's assets and data dir (decision 11).
    ...(options.pipelineAssets
      ? {
          assetPaths: options.pipelineAssets.asset_paths,
          ...(options.pipelineAssets.pipeline_data_dir === undefined
            ? {}
            : { pipelineDataDir: options.pipelineAssets.pipeline_data_dir }),
          ...(options.pipelineAssets.assets_dir === undefined
            ? {}
            : { assetsDir: options.pipelineAssets.assets_dir }),
        }
      : {}),
    depth: (options.depth ?? 0) + 1,
    eventName: resolveChildEventName(pipeline, options.canopy),
    eventData: options.canopy?.event,
    parentExecutionId: options.executionId,
    parentStepId: parentStepId,
    parentAttempt: options.attempt,
    parentIteration: effectiveIteration,
    projectId: resolvedTarget.projectId,
    worktreeId: resolvedTarget.worktreeId,
    initiationSource: options.initiationSource,
    initiator: options.initiator,
    // A parent's origin wins over the child's own author.
    agentOrigin:
      options.agentOrigin ??
      (preferenceLocator?.type === 'stored' &&
      preferenceLocator.source === 'user'
        ? options.runtime.pipelineOwnership?.readAgentAuthor(preferenceLocator)
            ?.chat
        : undefined),
    ...(options.childPipelineAuthorizations === undefined
      ? {}
      : { childPipelineAuthorizations: options.childPipelineAuthorizations }),
    ...(options.allowUnverifiedForegroundChildren
      ? { allowUnverifiedForegroundChildren: true }
      : {}),
    ...(options.executionContext === undefined
      ? {}
      : { executionContext: options.executionContext }),
    planId: options.planId,
    pipelinePreferenceLocator: preferenceLocator,
    modelConfig: options.modelConfig,
    onEvent: options.onEvent,
    onStepOutput: options.onStepOutput
      ? (event: StepOutputEvent): void => {
          // Built field by field so the child's `logPosition` is dropped: its
          // offsets index the child execution's log, not any file this
          // re-identified event names.
          const projectedEvent: StepOutputEvent = {
            executionId: options.executionId,
            jobId: options.jobId,
            jobName: options.jobName ?? options.jobId,
            stepId: buildNestedStepId(parentStepId, event.jobId, event.stepId),
            stepName: buildNestedStepId(
              parentStepId,
              event.jobId,
              event.stepName,
            ),
            attempt: options.attempt ?? 0,
            iteration: effectiveIteration,
            ...('recovery' in event ? { recovery: event.recovery } : {}),
            stream: event.stream,
            data: event.data,
          };
          options.onStepOutput?.(projectedEvent);
        }
      : undefined,
  };
  const resumeChildExecutionId = options.resumeChildReasonIds?.length
    ? options.resumeChildExecutionId
    : undefined;
  const childExecutionId = resumeChildExecutionId ?? randomUUID();
  await options.onRunningStepPatch?.(parentStepId, {
    child_execution_id: childExecutionId,
  });
  const childHandle = resumeChildExecutionId
    ? await resumePipeline(resumeChildExecutionId, {
        ...childExecutionOptions,
        statusReasonIds: options.resumeChildReasonIds,
      })
    : await executePipeline(pipeline, {
        ...childExecutionOptions,
        executionId: childExecutionId,
      });

  const cancelChild = (): void => {
    void (isShutdownSignal(options.signal) && childHandle.pauseForShutdown
      ? childHandle.pauseForShutdown()
      : childHandle.cancel());
  };
  options.signal.addEventListener('abort', cancelChild, { once: true });
  if (options.signal.aborted) cancelChild();

  try {
    const childState = await childHandle.waitForCompletion();
    const outputs = buildNestedPipelineOutputs(childState);
    await fsp.appendFile(
      options.logFile,
      `[run-pipeline] completed ${pipelineId} with ${childState.status}\n`,
      'utf8',
    );

    return createStepResult({
      ...options.logMetadata,
      status:
        childState.status === 'paused'
          ? 'paused'
          : childState.status === 'failure'
            ? 'failure'
            : childState.status === 'cancelled'
              ? 'cancelled'
              : 'success',
      conclusion:
        childState.status === 'paused'
          ? undefined
          : childState.status === 'failure'
            ? 'failure'
            : childState.status === 'cancelled'
              ? 'cancelled'
              : 'success',
      outcome:
        childState.status === 'paused'
          ? undefined
          : childState.status === 'failure'
            ? 'failure'
            : childState.status === 'cancelled'
              ? 'cancelled'
              : 'success',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      outputs,
      dynamic_env: {},
      log_file: options.logFile,
      child_execution_id: childState.id,
      pause_reasons:
        childState.status === 'paused'
          ? childState.status_reasons.map((reason) => ({
              ...reason,
              id: randomUUID(),
              source: {
                job_id: options.jobId,
                step_id: parentStepId,
                attempt: options.attempt ?? 0,
                iteration: effectiveIteration,
                child_execution_id: childState.id,
                child_reason_id: reason.id,
              },
            }))
          : undefined,
      error:
        childState.status === 'failure'
          ? 'Child workflow failed'
          : childState.status === 'cancelled'
            ? 'Child workflow cancelled'
            : undefined,
    });
  } finally {
    options.signal.removeEventListener('abort', cancelChild);
  }
}

/**
 * Seams on the INLINE host.
 *
 * The utility host has the same two; covering only that one and calling the
 * result "both hosts" is how this one went untested. Production leaves them
 * unset and gets the real threshold and `SpillingRecordStore`.
 */
export interface InlineHostStorageSeams {
  /** Retained-line size above which a record moves to private storage. */
  spillAfterChars?: number;
  /** The store a record is assembled in, so failures can be injected. */
  createRecordStore?: RecordStoreFactory;
}

async function runSpawnedProcess(
  processSpec: ProcessSpec,
  options: SpawnedProcessRunOptions &
    InlineHostStorageSeams & { runtime: ExecutionRuntime },
): Promise<CompletedProcessResult> {
  const spawnedProcessRunner = options.runtime.spawnedProcessRunner;
  if (spawnedProcessRunner) {
    try {
      return await spawnedProcessRunner(processSpec, options);
    } catch (error) {
      return {
        status: options.signal.aborted ? 'cancelled' : 'failure',
        conclusion: options.signal.aborted ? 'cancelled' : 'failure',
        outcome: options.signal.aborted ? 'cancelled' : 'failure',
        exit_code: options.signal.aborted ? undefined : 1,
        error: error instanceof Error ? error.message : String(error),
        outputs: {},
        dynamic_env: {},
        log_file: options.logFile,
      };
    }
  }

  return runSpawnedProcessInline(processSpec, options);
}

/**
 * The INLINE host: the implementation used when no spawned-process runner is
 * injected, which is the CLI's production path.
 *
 * Exported so it can be driven directly. It and the utility host are two
 * separate wirings of the same redactor, and covering one of them and calling
 * the result "both hosts" is how this one went untested.
 */
export async function runSpawnedProcessInline(
  processSpec: ProcessSpec,
  options: SpawnedProcessRunOptions &
    InlineHostStorageSeams & { runtime?: ExecutionRuntime },
): Promise<CompletedProcessResult> {
  if (options.signal.aborted) {
    return {
      status: 'cancelled',
      conclusion: 'cancelled',
      outcome: 'cancelled',
      outputs: {},
      dynamic_env: {},
      log_file: options.logFile,
    };
  }

  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(options.logFile, { flags: 'a' });
    const logStreamFinished = finished(logStream);
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let agentTerminalTimer: NodeJS.Timeout | undefined;
    let agentTerminalLineBuffer = '';
    const timers: { timeout?: NodeJS.Timeout } = {};
    let child: ReturnType<typeof spawn> | undefined;
    let resourceHandle: { unregister(): void } | null = null;
    const stdoutRedactor = new SecretValueRedactor(
      options.secretValues ?? [],
      options.spillAfterChars,
      options.createRecordStore,
    );
    let redactionFailure: Error | undefined;
    /**
     * Runs redaction so a failure becomes THIS step's failure rather than an
     * uncaught error out of a `data` callback or the finalize flush. Output is
     * never continued unmasked and the failure is never swallowed.
     */
    /**
     * Pauses the child's streams while the log write queue is saturated and
     * resumes on drain. Retention for a line being assembled is O(line); this
     * keeps a fast producer from also growing the queued-write set on top of it,
     * and keeps bulk writing off the event loop's critical path.
     */
    /**
     * Independent pause reasons over one pair of pipes.
     *
     * The log sink draining must not resume a child another reason still needs
     * held — the previous single-flag version let one drain callback override a
     * different, still-saturated queue. A child resumes only when NO reason
     * holds it.
     */
    const pauseReasons = new Set<string>();
    /**
     * Set once the step is being STOPPED (cancelled or past its deadline).
     *
     * A paused pipe never reaches EOF, so the child's `close` never fires —
     * and a pipe paused on a stalled `mkdtemp` stayed paused until the
     * filesystem answered, holding a cancelled step open indefinitely. Once
     * terminating, every hold is released and further holds are ignored: the
     * only reader that matters now is the one draining the pipe to EOF.
     */
    let terminating = false;
    const beginTermination = (): void => {
      terminating = true;
      pauseReasons.clear();
      child?.stdout?.resume();
      child?.stderr?.resume();
    };
    const holdChild = (reason: string): void => {
      if (terminating) return;
      pauseReasons.add(reason);

      child?.stdout?.pause();
      child?.stderr?.pause();
    };
    const releaseChild = (reason: string): void => {
      pauseReasons.delete(reason);
      if (pauseReasons.size > 0) return;
      child?.stdout?.resume();
      child?.stderr?.resume();
    };
    /**
     * Every output site goes through this.
     *
     * Each write is encoded to UTF-8 on its own, so a surrogate pair split
     * across two writes reached the saved file as two replacement characters
     * while concatenating the live fragments still looked perfect. Holding a
     * trailing lone high surrogate back until the next write keeps both copies
     * correct AND identical.
     */
    const pairGuards: Record<'stdout' | 'stderr', SurrogatePairGuard> = {
      stdout: new SurrogatePairGuard(),
      stderr: new SurrogatePairGuard(),
    };
    /**
     * Set when the step settles. Storage work that outlives a cancelled or
     * timed-out step is still owned and still cleaned up, but none of it may
     * reach the output of a step whose caller has already been answered.
     */
    let outputSealed = false;
    /** Stored completions currently emitting, per stream. */
    const storedInFlight: Record<'stdout' | 'stderr', number> = {
      stdout: 0,
      stderr: 0,
    };
    /**
     * Streams whose output ends at a stored record because the step is being
     * stopped while that record is still owned by storage.
     *
     * Stopping resumes the pipes so the child can reach EOF, and the redactor
     * holds everything that arrives behind an unfinished stored record. That
     * hold must not grow for as long as a slow replay or a child ignoring
     * SIGTERM keeps it going, and the finalizer already ends such a stream at
     * the record boundary. Deciding it here, once, keeps the two consistent:
     * nothing after the record is published, however the timing falls.
     */
    const endedAtRecord: Record<'stdout' | 'stderr', boolean> = {
      stdout: false,
      stderr: false,
    };
    const acceptsOutput = (
      stream: 'stdout' | 'stderr',
      redactor: SecretValueRedactor,
    ): boolean => {
      if (outputSealed || endedAtRecord[stream]) return false;
      if (
        terminating &&
        (storedInFlight[stream] > 0 ||
          redactor.completionInProgress ||
          redactor.hasStoredWork)
      ) {
        endedAtRecord[stream] = true;
        return false;
      }
      return true;
    };
    const writeOut = (stream: 'stdout' | 'stderr', text: string): void => {
      if (outputSealed || text.length === 0) return;

      const safe = pairGuards[stream].take(text);
      if (safe.length === 0) return;
      applyOutputBackpressure(logStream.write(safe));
      options.onOutput?.(stream, safe);
    };
    /** Releases a genuinely unpaired trailing surrogate at the very end. */
    const flushPairGuards = (): void => {
      for (const stream of ['stdout', 'stderr'] as const) {
        const trailing = pairGuards[stream].flush();
        if (trailing.length === 0) continue;
        logStream.write(trailing);
        options.onOutput?.(stream, trailing);
      }
    };
    let logSinkHeld = false;
    const applyOutputBackpressure = (queueAccepted: boolean): void => {
      // Attach at most ONE drain listener while the sink is held. A record
      // that emits in many pieces produces many refused writes before a single
      // drain fires, and one listener per refusal accumulated them on the log
      // stream (a MaxListenersExceededWarning, and a growing callback list).
      if (queueAccepted || !child || logSinkHeld) return;
      logSinkHeld = true;
      holdChild('log-sink');
      logStream.once('drain', () => {
        logSinkHeld = false;
        releaseChild('log-sink');
      });
    };
    /**
     * Delivers a stored record's masked output in order.
     *
     * The pipes are held until the replay resolves, which keeps output ordered
     * AND cannot deadlock: replaying storage progresses without further input,
     * unlike the retained-line pause this replaces.
     */
    /**
     * In-flight stored drains, so finalization waits for them.
     *
     * Without this the write raced `logStream.end()`: the data handler had
     * already CLAIMED the completion, so the finalizer's own sweep found
     * nothing to wait for, and a record that resolved after the stream closed
     * was silently dropped — a whole record of output lost with a `success`
     * result.
     */
    let storedDrains: Promise<void> = Promise.resolve();
    /** When the step's declared budget ends; finalization still honours it. */
    let deadlineAt = Number.POSITIVE_INFINITY;
    /**
     * Waits for a saturated record store to drain before letting the child
     * write more, and turns a storage-write failure into THIS step's failure.
     */
    const drainStorageWrites = (
      redactor: SecretValueRedactor,
      stream: 'stdout' | 'stderr',
    ): void => {
      const pending = redactor.takePendingDrain();
      if (!pending) return;
      const reason = `storage-${stream}`;
      holdChild(reason);
      const settle = pending
        .catch((error: unknown) => {
          redactionFailure ??=
            error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          releaseChild(reason);
        });
      storedDrains = storedDrains.then(() => settle);
    };
    const drainStored = (
      redactor: SecretValueRedactor,
      stream: 'stdout' | 'stderr',
    ): void => {
      drainStorageWrites(redactor, stream);
      const pending = redactor.takePendingCompletion();
      if (!pending) return;
      const reason = `stored-${stream}`;
      holdChild(reason);
      storedInFlight[stream] += 1;
      const settle = pending((text) => {
        writeOut(stream, text);
      })
        .catch((error: unknown) => {
          // A storage or transformation failure fails THIS step through the
          // existing precedence; it never degrades to unprocessed output.
          redactionFailure ??=
            error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          storedInFlight[stream] -= 1;
          releaseChild(reason);
        });
      // Declared before it is chained. `.then` callbacks run on a later
      // microtask, so the previous order was not a live defect — but it read
      // as one, and a future refactor that inlined the chain would make it one.
      storedDrains = storedDrains.then(() => settle);
    };
    const guardRedaction = (redact: () => string): string => {
      if (redactionFailure) return '';
      try {
        return redact();
      } catch (error) {
        redactionFailure =
          error instanceof Error ? error : new Error(String(error));
        // Only a child that is still RUNNING gets escalated. The final flush
        // happens inside `finalize`, which runs after `child.on('close')` has
        // already cleared the force-kill timer — so a failure there armed a
        // fresh 5-second timer that nothing would ever clear. It held the
        // event loop open past the end of the step (jest's delayed-exit
        // warning) and then sent SIGKILL to an exited process group, which is
        // a recycled-PID hazard rather than a no-op.
        if (child && child.exitCode === null && child.signalCode === null) {
          killChildProcessGroup(child, 'SIGTERM');
          scheduleForceKill(child);
        }
        return '';
      }
    };
    const stderrRedactor = new SecretValueRedactor(
      options.secretValues ?? [],
      options.spillAfterChars,
      options.createRecordStore,
    );
    const scheduleForceKill = (
      target: ReturnType<typeof spawn>,
      forceKillOptions?: { unref?: boolean },
    ): void => {
      if (forceKillTimer) {
        return;
      }
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        killChildProcessGroup(target, 'SIGKILL');
      }, FORCE_KILL_DELAY_MS);
      if (forceKillOptions?.unref) {
        forceKillTimer.unref?.();
      }
    };

    const onAbort = (): void => {
      if (!child) return;
      beginTermination();
      killChildProcessGroup(child, 'SIGTERM');
      scheduleForceKill(child);
    };

    const finalize = async (
      partial: Omit<
        CompletedProcessResult,
        'outputs' | 'dynamic_env' | 'log_file'
      >,
      finalizeOptions?: FinalizeProcessOptions,
    ): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      if (timers.timeout) {
        clearTimeout(timers.timeout);
      }
      if (forceKillTimer && !finalizeOptions?.preserveForceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
      if (agentTerminalTimer) {
        clearTimeout(agentTerminalTimer);
      }
      options.signal.removeEventListener('abort', onAbort);
      child?.stdout?.unpipe(logStream);
      child?.stderr?.unpipe(logStream);
      // A step that is being STOPPED settles without waiting on storage; a step
      // that finished normally waits for every byte — but never past its own
      // deadline or a cancellation, because a filesystem call that does not
      // return must not hold the caller forever. Either way the storage stays
      // owned: whatever is not awaited here is tracked and cleaned up late.
      let abandon =
        partial.status === 'cancelled' || timedOut || options.signal.aborted;
      let abandonedAs: 'cancelled' | 'timeout' | undefined;
      let stopWatching: () => void = () => undefined;
      const abandonment = new Promise<'cancelled' | 'timeout'>((resolve) => {
        const onCancel = (): void => {
          resolve('cancelled');
        };
        options.signal.addEventListener('abort', onCancel, { once: true });
        const budget = setTimeout(
          () => {
            resolve('timeout');
          },
          Math.max(0, Math.min(deadlineAt - Date.now(), 2_147_483_647)),
        );
        stopWatching = (): void => {
          clearTimeout(budget);
          options.signal.removeEventListener('abort', onCancel);
        };
      });
      const untilAbandoned = async (
        work: Promise<unknown>,
      ): Promise<boolean> => {
        if (abandon) return false;
        const winner = await Promise.race([
          work.then(
            () => 'done' as const,
            () => 'done' as const,
          ),
          abandonment,
        ]);
        if (winner === 'done') return true;
        abandon = true;
        abandonedAs = winner;
        return false;
      };
      const streams = [
        [stdoutRedactor, 'stdout'],
        [stderrRedactor, 'stderr'],
      ] as const;
      // A stored record still in flight must land BEFORE the final flush, or
      // its bytes would follow the tail that comes after them.
      const sweepStoredRecords = async (): Promise<void> => {
        for (const [redactor, stream] of streams) {
          if (abandon) return;
          const pending = redactor.takePendingCompletion();
          if (!pending) continue;
          storedInFlight[stream] += 1;
          const run = pending((text) => {
            writeOut(stream, text);
          })
            .catch((error: unknown) => {
              // A failure after the step settled cannot change its result;
              // before that, it fails the step like any masking failure.
              if (abandon) return;
              redactionFailure ??=
                error instanceof Error ? error : new Error(String(error));
            })
            .finally(() => {
              storedInFlight[stream] -= 1;
            });
          if (!(await untilAbandoned(run))) trackLateStorageCleanup(run);
        }
      };
      // Any drain already in flight must land BEFORE the final flush, or its
      // bytes would be written after `logStream.end()` and silently dropped.
      if (await untilAbandoned(storedDrains.catch(() => undefined)))
        // Records finished during the run land before the tail that follows
        // them...
        await sweepStoredRecords();
      for (const [redactor, stream] of streams) {
        // A stream whose record is still owned by storage cannot have its
        // tail emitted without that record, so a stopped step ends its output
        // at the record boundary instead of publishing bytes out of order.
        if (
          abandon &&
          (endedAtRecord[stream] ||
            storedInFlight[stream] > 0 ||
            redactor.hasStoredWork)
        )
          continue;
        writeOut(
          stream,
          guardRedaction(() => redactor.flush()),
        );
      }
      // ...and `flush()` itself finishes the record a child left unterminated,
      // so its completion has to be swept too. Sweeping only before the flush
      // dropped that record entirely while the step reported success.
      await sweepStoredRecords();
      if (!abandon) flushPairGuards();
      outputSealed = true;
      logStream.end();
      try {
        await logStreamFinished;
      } catch {
        // Preserve the original process result even if flushing the log fails.
      }
      // Storage is released on every exit path — success, failure,
      // cancellation, timeout and abnormal child exit. A disposal still waiting
      // on uninterruptible filesystem work is tracked rather than awaited past
      // the caller's cancellation or deadline.
      const disposal = Promise.all([
        storedDrains.catch(() => undefined),
        stdoutRedactor.disposeStorage(),
        stderrRedactor.disposeStorage(),
      ]);
      trackLateStorageCleanup(disposal);
      if (!abandon) await Promise.race([disposal, abandonment]);
      stopWatching();
      if (abandonedAs === 'timeout')
        partial = {
          ...partial,
          status: 'failure',
          conclusion: 'failure',
          outcome: 'failure',
          error: stepTimedOutMessage(options.timeout_minutes * 60_000),
        };
      else if (abandonedAs === 'cancelled')
        partial = {
          ...partial,
          status: 'cancelled',
          conclusion: 'cancelled',
          outcome: 'cancelled',
        };
      resourceHandle?.unregister();

      let outputs: Record<string, string> = {};
      let dynamic_env: Record<string, string> = {};
      /** A real (non-ENOENT) failure to read the declared output/env maps. */
      let outputReadFailure: Error | undefined;
      try {
        [outputs, dynamic_env] = await Promise.all([
          readOutputMap(options.outputFile),
          readOutputMap(options.envFile),
        ]);
      } catch (error) {
        outputs = {};
        dynamic_env = {};
        outputReadFailure =
          error instanceof Error ? error : new Error(String(error));
      }

      // Precedence, because this catch used to return BEFORE the redaction
      // check and so could report success for a step whose output was never
      // masked as promised: a broken masking promise outranks an unreadable
      // output map, since output may already have been streamed. Either one
      // fails the step; neither may report success. A cancelled step stays
      // cancelled and carries the reason instead of being relabelled.
      const requiredFailure = redactionFailure ?? outputReadFailure;
      if (requiredFailure) {
        resolve({
          ...partial,
          status: partial.status === 'cancelled' ? 'cancelled' : 'failure',
          exit_code: partial.exit_code ?? 1,
          error: requiredFailure.message,
          outputs,
          dynamic_env,
          log_file: options.logFile,
        });
        return;
      }

      resolve({
        ...partial,
        outputs,
        dynamic_env,
        log_file: options.logFile,
      });
    };

    const scheduleAgentTerminalWatchdog = (
      status: AgentTerminalResultStatus,
    ): void => {
      if (
        !child ||
        settled ||
        agentTerminalTimer ||
        options.agentTerminalResultGraceMs === undefined
      ) {
        return;
      }

      agentTerminalTimer = setTimeout(() => {
        void (async (): Promise<void> => {
          if (!child || settled) {
            return;
          }

          const outputs = await readOutputMap(options.outputFile).catch(
            (): Record<string, string> => ({}),
          );
          const hasActionOutputs = Object.keys(outputs).length > 0;

          killChildProcessGroup(child, 'SIGTERM');
          scheduleForceKill(child, { unref: true });

          if (status === 'success' && hasActionOutputs) {
            await finalize(
              {
                status: 'success',
                conclusion: 'success',
                outcome: 'success',
                exit_code: 0,
              },
              { preserveForceKillTimer: true },
            );
            return;
          }

          await finalize(
            {
              status: 'failure',
              conclusion: 'failure',
              outcome: 'failure',
              error:
                status === 'success'
                  ? `Agent emitted a terminal result but did not exit within ${options.agentTerminalResultGraceMs} ms before writing action outputs`
                  : `Agent emitted a terminal error result but did not exit within ${options.agentTerminalResultGraceMs} ms`,
            },
            { preserveForceKillTimer: true },
          );
        })();
      }, options.agentTerminalResultGraceMs);
      agentTerminalTimer.unref?.();
    };

    const observeAgentTerminalOutput = (chunk: Buffer | string): string => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (
        options.agentTerminalResultGraceMs === undefined ||
        agentTerminalTimer
      ) {
        return text;
      }

      agentTerminalLineBuffer += text;
      const lines = agentTerminalLineBuffer.split(/\r?\n/);
      agentTerminalLineBuffer = lines.pop() ?? '';
      if (agentTerminalLineBuffer.length > 16_384) {
        agentTerminalLineBuffer = agentTerminalLineBuffer.slice(-16_384);
      }

      for (const line of lines) {
        const status = parseAgentTerminalResultLine(line);
        if (status) {
          scheduleAgentTerminalWatchdog(status);
          break;
        }
      }

      return text;
    };

    try {
      const spawnSpec = wrapWindowsCommandShim(processSpec);
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: options.cwd,
        env: { ...options.env, ...processSpec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows drops piped output for detached children; taskkill /t still
        // lets us terminate the process tree without CREATE_NEW_PROCESS_GROUP.
        detached: hostOperatingSystem() !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      void finalize({
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        exit_code: 1,
        error: String(error),
      });
      return;
    }

    resourceHandle =
      typeof child.pid === 'number' && options.resource
        ? (options.runtime?.resourceMonitor?.registerProcess({
            id: `pipeline-step:${options.resource.executionId}:${options.resource.jobId}:${options.resource.stepId}:${String(options.resource.attempt)}:${String(child.pid)}`,
            groupId: 'pipelines',
            kind: 'pipeline-step',
            label: options.resource.label,
            pid: child.pid,
            processGroupId: child.pid,
            startedAt: new Date().toISOString(),
            metadata: {
              type: 'pipeline',
              pipeline: {
                executionId: options.resource.executionId,
                pipelineId: options.resource.pipelineId,
                pipelineName: options.resource.pipelineName,
                jobId: options.resource.jobId,
                stepId: options.resource.stepId,
                attempt: options.resource.attempt,
                iteration: options.resource.iteration,
              },
            },
          }) ?? null)
        : null;

    deadlineAt = Date.now() + options.timeout_minutes * 60_000;
    timers.timeout = setTimeout(() => {
      if (!child) {
        return;
      }
      timedOut = true;
      beginTermination();
      killChildProcessGroup(child, 'SIGTERM');
      scheduleForceKill(child);
    }, options.timeout_minutes * 60_000);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      observeAgentTerminalOutput(chunk);
      if (!acceptsOutput('stdout', stdoutRedactor)) return;
      const text = guardRedaction(() => stdoutRedactor.redactChunk(chunk));
      writeOut('stdout', text);
      drainStored(stdoutRedactor, 'stdout');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (!acceptsOutput('stderr', stderrRedactor)) return;
      const text = guardRedaction(() => stderrRedactor.redactChunk(chunk));
      writeOut('stderr', text);
      drainStored(stderrRedactor, 'stderr');
    });

    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
    }

    child.on('error', async (error) => {
      await finalize({
        status: options.signal.aborted ? 'cancelled' : 'failure',
        conclusion: options.signal.aborted ? 'cancelled' : 'failure',
        outcome: options.signal.aborted ? 'cancelled' : 'failure',
        error: String(error),
      });
    });

    child.on('close', async (code) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }

      if (options.signal.aborted) {
        await finalize({
          status: 'cancelled',
          conclusion: 'cancelled',
          outcome: 'cancelled',
        });
        return;
      }

      if (timedOut) {
        await finalize({
          status: 'failure',
          conclusion: 'failure',
          outcome: 'failure',
          error: stepTimedOutMessage(options.timeout_minutes * 60_000),
          exit_code: code ?? undefined,
        });
        return;
      }

      if (code === 0) {
        await finalize({
          status: 'success',
          conclusion: 'success',
          outcome: 'success',
          exit_code: 0,
        });
        return;
      }

      await finalize({
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        exit_code: code ?? undefined,
        error: `Process exited with code ${code ?? 'unknown'}`,
      });
    });
  });
}

async function postProcessSpawnedResult(
  result: CompletedProcessResult,
  options: RunStepOptions,
): Promise<CompletedProcessResult> {
  const notificationResult = extractNotificationOutputs(result.outputs);
  if (notificationResult && 'error' in notificationResult) {
    return {
      ...result,
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      exit_code: result.exit_code ?? 1,
      error: notificationResult.error,
      outputs: sanitizeNotificationOutputKeys(result.outputs),
    };
  }

  await Promise.resolve(
    options.onStepPostProcess?.({
      step: options.step,
      outputs: result.outputs,
      notifications: notificationResult?.notifications,
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      executionId: options.executionId,
      jobId: options.jobId,
      attempt: options.attempt ?? 0,
      iteration: options.iteration ?? 0,
      depth: options.depth ?? 0,
    }),
  ).catch(() => {});

  return {
    ...result,
    outputs: sanitizeNotificationOutputKeys(result.outputs),
  };
}

function isAgentFailureMetadata(
  value: unknown,
  allowUnclassified = false,
): value is AgentActionFailureMetadata {
  if (!isRecord(value)) return false;
  const metadata = value;
  const classification = isRecord(metadata.classification)
    ? metadata.classification
    : null;
  return (
    metadata.version === 1 &&
    (metadata.provider === 'claude' ||
      metadata.provider === 'codex' ||
      metadata.provider === 'ollama' ||
      metadata.provider === 'cursor' ||
      metadata.provider === 'copilot' ||
      metadata.provider === 'opencode' ||
      metadata.provider === 'antigravity') &&
    (metadata.agent_harness === undefined ||
      metadata.agent_harness === 'claude' ||
      metadata.agent_harness === 'codex' ||
      metadata.agent_harness === 'cursor' ||
      metadata.agent_harness === 'copilot' ||
      metadata.agent_harness === 'opencode' ||
      metadata.agent_harness === 'antigravity') &&
    typeof metadata.had_agent_activity === 'boolean' &&
    typeof metadata.message === 'string' &&
    (metadata.session_id === undefined ||
      typeof metadata.session_id === 'string') &&
    (metadata.transcript_file === undefined ||
      typeof metadata.transcript_file === 'string') &&
    (allowUnclassified ||
      (Boolean(classification) &&
        typeof classification?.kind === 'string' &&
        RECOVERABLE_REASON_KINDS.has(classification.kind) &&
        typeof classification.code === 'string' &&
        RECOVERABLE_REASON_CODES.has(classification.code) &&
        classification.provider === metadata.provider &&
        (classification.account_scope === 'native' ||
          classification.account_scope === 'ai_credits' ||
          classification.account_scope === 'local') &&
        typeof classification.diagnostic_message === 'string' &&
        (classification.model === undefined ||
          typeof classification.model === 'string') &&
        (classification.resets_at === undefined ||
          typeof classification.resets_at === 'string')))
  );
}

function failurePathIsAllowed(
  filePath: string,
  tempDir: string,
  executionDir: string,
): boolean {
  return (
    path.isAbsolute(filePath) &&
    (isPathInside(tempDir, filePath) || isPathInside(executionDir, filePath))
  );
}

export async function buildAgentRecoveryStepResult(options: {
  result: CompletedProcessResult;
  step: NormalizedStep;
  tempDir: string;
  executionDir: string;
  attempt: number;
  iteration: number;
  jobId: string;
  stepId: string;
  model?: string;
  childId?: string;
  shutdown?: boolean;
  crashed?: boolean;
  /**
   * This run continued a checkpoint whose session already holds work. A
   * failure here, even before any new activity, must keep continuing that
   * session rather than restart the step and repeat the earlier work.
   */
  priorAgentActivity?: boolean;
  /**
   * The step ran through the account proxy (CAN-4030). A proxy account's
   * sign-in or limit is not the user's own login. A quota failure pauses only
   * with its captured connection identity; authentication never uses native
   * account recovery.
   */
  accountProxyRouted?: boolean;
  accountProxyConnectionId?: string;
}): Promise<Partial<StepResult> | null> {
  if (
    (options.result.status !== 'failure' &&
      !(options.shutdown && options.result.status === 'cancelled')) ||
    (options.step.uses !== 'builtin/agent-prompt' &&
      options.step.uses !== 'builtin/agent-resume')
  ) {
    return null;
  }
  const metadataFile = options.crashed
    ? undefined
    : options.result.outputs.agent_failure_metadata_file;
  if (
    (!metadataFile && !options.shutdown) ||
    (metadataFile &&
      !failurePathIsAllowed(
        metadataFile,
        options.tempDir,
        options.executionDir,
      ))
  )
    return null;
  try {
    const parsed: unknown =
      options.shutdown && !metadataFile
        ? await readShutdownAgentMetadata(
            options.result.log_file,
            options.step,
            options.model,
          )
        : metadataFile
          ? JSON.parse(await fsp.readFile(metadataFile, 'utf8'))
          : null;
    if (!isAgentFailureMetadata(parsed, options.shutdown)) return null;
    const metadata = parsed;
    // A crash can precede the final output flush. Absence of logged activity is
    // not proof the provider did nothing, so never replay a crashed agent turn.
    if (options.crashed) metadata.had_agent_activity = true;
    if (options.priorAgentActivity) metadata.had_agent_activity = true;
    const transcriptFile =
      metadata.transcript_file ??
      options.result.outputs.agent_failure_transcript_file;
    if (
      transcriptFile &&
      !failurePathIsAllowed(
        transcriptFile,
        options.tempDir,
        options.executionDir,
      )
    ) {
      return null;
    }
    if (
      !options.shutdown &&
      metadata.had_agent_activity &&
      !metadata.session_id
    ) {
      return {
        outputs: sanitizeAgentFailureOutputKeys(options.result.outputs),
        error:
          'Agent recovery invariant failed: provider activity was captured without a resumable session ID',
      };
    }
    const detectedAt = new Date().toISOString();
    const reasonId = randomUUID();
    let durableTranscriptFile = transcriptFile;
    if (transcriptFile && !isPathInside(options.executionDir, transcriptFile)) {
      const recoveryDir = path.join(options.executionDir, 'recovery');
      await fsp.mkdir(recoveryDir, { recursive: true });
      durableTranscriptFile = path.join(
        recoveryDir,
        `${sanitizePathSegment(options.jobId)}--${sanitizePathSegment(
          options.stepId,
        )}--${reasonId}.jsonl`,
      );
      await fsp.copyFile(transcriptFile, durableTranscriptFile);
    }
    const classification = options.shutdown
      ? {
          kind: 'app_shutdown' as const,
          code: 'app_shutdown' as const,
          provider: metadata.provider,
          account_scope: metadata.classification?.account_scope,
          model: options.model,
          resets_at: undefined,
          diagnostic_message:
            'Application stopped. Resume this step after restart.',
        }
      : metadata.classification;
    if (!classification) return null;
    if (
      options.accountProxyRouted &&
      !options.shutdown &&
      classification.kind !== 'provider_temporarily_unavailable' &&
      !(
        classification.kind === 'provider_usage_limit' &&
        options.accountProxyConnectionId
      )
    ) {
      return null;
    }
    const harness =
      metadata.agent_harness ??
      (metadata.provider === 'codex' ? 'codex' : 'claude');
    const diagnosticMessage = redactSecrets(
      classification.diagnostic_message.trim(),
    ).slice(0, 2000);
    const reason: PipelineStatusReason = {
      id: reasonId,
      kind: classification.kind,
      code: classification.code,
      provider: classification.provider,
      agent_harness: harness,
      account_scope: classification.account_scope,
      ...(options.accountProxyConnectionId
        ? { account_proxy_connection_id: options.accountProxyConnectionId }
        : {}),
      ...((classification.model ?? options.model)
        ? { model: classification.model ?? options.model }
        : {}),
      detected_at: detectedAt,
      ...(classification.resets_at
        ? { resets_at: classification.resets_at }
        : {}),
      ...(diagnosticMessage ? { diagnostic_message: diagnosticMessage } : {}),
      source: {
        job_id: options.jobId,
        step_id: options.stepId,
        attempt: options.attempt,
        iteration: options.iteration,
      },
    };
    return {
      status: 'paused',
      conclusion: undefined,
      outcome: undefined,
      outputs: sanitizeAgentFailureOutputKeys(options.result.outputs),
      dynamic_env: {},
      error:
        options.shutdown && metadata.had_agent_activity && !metadata.session_id
          ? 'The interrupted agent has no saved session ID. Automatic resume is unavailable.'
          : redactSecrets(metadata.message).slice(0, 2000),
      pause_reason: reason,
      ...(metadata.had_agent_activity && !metadata.session_id
        ? {}
        : {
            agent_recovery: {
              version: 2,
              reason_id: reasonId,
              ...(options.accountProxyConnectionId
                ? {
                    account_proxy_connection_id:
                      options.accountProxyConnectionId,
                  }
                : {}),
              action:
                options.step.uses === 'builtin/agent-resume'
                  ? 'agent-resume'
                  : 'agent-prompt',
              provider: metadata.provider,
              harness,
              step_id: options.stepId,
              ...(metadata.session_id
                ? { session_id: metadata.session_id }
                : {}),
              had_agent_activity: metadata.had_agent_activity,
              strategy: metadata.had_agent_activity
                ? 'continue_session'
                : 'restart_step',
              recovery_count: 0,
              paused_at: detectedAt,
              ...(durableTranscriptFile
                ? { transcript_file: durableTranscriptFile }
                : {}),
              failure_message: redactSecrets(metadata.message).slice(0, 2000),
            },
          }),
      recovery_count: 0,
    };
  } catch {
    return null;
  }
}

function recoveryCheckpointForStep(
  options: Pick<RunStepOptions, 'recoveryCheckpoint' | 'parentStepId' | 'step'>,
): AgentRecoveryCheckpoint | undefined {
  const checkpoint = options.recoveryCheckpoint;
  if (!checkpoint) return undefined;
  const stepId = options.parentStepId ?? options.step.id;
  if (checkpoint.step_id) {
    return checkpoint.step_id === stepId ? checkpoint : undefined;
  }
  // Legacy checkpoints did not identify the nested step. They remain valid
  // for top-level recovery, but cannot safely be applied to every sibling in
  // a composite replay.
  return options.parentStepId ? undefined : checkpoint;
}

function normalizeCompositeSteps(
  parentStep: NormalizedStep,
  steps: Pipeline['jobs'][string]['steps'],
): NormalizedStep[] {
  const normalized = normalizePipeline(
    {
      name: 'Composite Action',
      on: 'dispatch',
      defaults: {
        run: {
          shell: parentStep.shell,
          working_directory: parentStep.working_directory,
        },
      },
      jobs: {
        composite: {
          timeout_minutes: parentStep.timeout_minutes,
          steps,
        },
      },
    },
    {
      defaultShell: getDefaultShellTypeForCurrentProcess(),
    },
  );

  return normalized.jobs.composite.steps;
}

function createStepResult(
  partial: Partial<StepResult> & Pick<StepResult, 'status'>,
): StepResult {
  return {
    status: partial.status,
    conclusion: partial.conclusion,
    outcome: partial.outcome,
    outputs: partial.outputs ?? {},
    dynamic_env: partial.dynamic_env ?? {},
    started_at: partial.started_at,
    completed_at: partial.completed_at,
    exit_code: partial.exit_code,
    error: partial.error,
    log_file: partial.log_file,
    resolved_run: partial.resolved_run,
    log_format_hint: partial.log_format_hint,
    agent_provider: partial.agent_provider,
    agent_harness: partial.agent_harness,
    agent_model: partial.agent_model,
    agent_runtime_model: partial.agent_runtime_model,
    agent_model_config: partial.agent_model_config,
    model_alias: partial.model_alias,
    model_alias_name: partial.model_alias_name,
    model_alias_plugin_collection_ids:
      partial.model_alias_plugin_collection_ids,
    agentTerminalMode: partial.agentTerminalMode,
    workerId: partial.workerId,
    workerQueued: partial.workerQueued,
    agent_recovery: partial.agent_recovery,
    agent_recovery_history: partial.agent_recovery_history,
    recovery_count: partial.recovery_count,
    pause_reason: partial.pause_reason,
    pause_reasons: partial.pause_reasons,
    child_execution_id: partial.child_execution_id,
    selected_child_reason_ids: partial.selected_child_reason_ids,
  };
}

function resolveExplicitAgentModel(
  value: PipelineScalar | undefined,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return resolveModelAlias(trimmed);
}

function resolveStepPluginCollectionIds(step: NormalizedStep): string[] {
  if (
    step.uses !== 'builtin/agent-prompt' &&
    step.uses !== 'builtin/agent-resume'
  ) {
    return [];
  }
  const raw = step.with?.plugin_collection_id;
  if (typeof raw !== 'string') {
    return [];
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? [trimmed] : [];
}

function appendAgentSystemPrompt(
  existing: string | undefined,
  instructions: string,
): string | undefined {
  const trimmed = instructions.trim();
  if (!trimmed) {
    return existing;
  }
  const block = `You are now a user defined agent with these additional instructions: ${trimmed}`;
  return existing?.trim() ? `${existing}\n\n${block}` : block;
}

interface ResolvedPipelineModelInputs {
  inputValues: Record<string, string>;
  selectedModel?: string;
  runtimeModel?: string;
  aliasId?: string;
  aliasName?: string;
  agentId?: string;
  agentModelOverride?: boolean;
  aliasPluginCollectionIds: string[];
  syntheticSelectionsByCollectionId?: Record<string, ChatTabPluginSelections>;
}

function isRuntimeBaseModelAvailable(model: string): boolean {
  return isSelectableAgentOverrideModel(model);
}

function preferenceToDefaults(
  preference: PipelineModelAliasPreference | undefined,
): PipelineModelAliasDefaults | undefined {
  if (!preference || preference.mode === 'reset') {
    return undefined;
  }
  if (preference.mode === 'agent') {
    return {
      agent_id: preference.agent_id,
      ...(preference.base !== undefined ? { base: preference.base } : {}),
    };
  }
  return {
    base: preference.base,
    ...(preference.instructions !== undefined
      ? { instructions: preference.instructions }
      : {}),
    ...(preference.plugin_collection_id
      ? { plugin_collection_id: preference.plugin_collection_id }
      : {}),
  };
}

function assertPipelineRuntimeModelIsNotAgentModel(model: string): void {
  const resolvedModel = resolveModelAlias(model);
  if (resolvedModel.startsWith(AGENT_MODEL_PREFIX)) {
    throw new Error(
      `Agent model IDs are not supported directly in workflow steps. Define a model_aliases entry with defaults.agent_id: ${resolvedModel} and use the alias id in with.model.`,
    );
  }
}

async function resolveAgentAliasInputs(options: {
  aliasId: string;
  aliasName: string;
  agentId: string;
  inputValues: Record<string, string>;
  runtime: ExecutionRuntime;
  scope?: PipelineModelPolicyScope;
}): Promise<ResolvedPipelineModelInputs> {
  const { aliasId, aliasName, agentId, inputValues, runtime } = options;
  if (!runtime.resolvePipelineAgentModelAlias) {
    throw new Error(
      `Workflow model alias "${aliasId}" references Agent "${agentId}", but Agent resolution is unavailable in this runtime.`,
    );
  }
  const resolution = await runtime.resolvePipelineAgentModelAlias(
    agentId,
    options.scope,
  );
  if (!resolution) {
    throw new Error(
      `Workflow model alias "${aliasId}" references Agent "${agentId}", but that Agent is not available locally.`,
    );
  }
  if (!isRuntimeBaseModelAvailable(resolution.base)) {
    throw new Error(
      `Workflow model alias "${aliasId}" references Agent "${agentId}", but Agent "${resolution.name}" uses unavailable base model "${resolution.base}". Edit the Agent or choose another model.`,
    );
  }
  const systemPrompt = appendAgentSystemPrompt(
    inputValues.system_prompt,
    resolution.instructions ?? '',
  );
  const syntheticId = `${AGENT_MODEL_SYNTHETIC_PLUGIN_COLLECTION_PREFIX}${resolution.agentId}`;
  return {
    inputValues: {
      ...inputValues,
      model: resolution.base,
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
    },
    selectedModel: aliasId,
    runtimeModel: resolution.base,
    aliasId,
    aliasName,
    agentId: resolution.agentId,
    agentModelOverride: parseAgentRouteModelId(agentId) !== null,
    aliasPluginCollectionIds: resolution.pluginSelections ? [syntheticId] : [],
    syntheticSelectionsByCollectionId: resolution.pluginSelections
      ? { [syntheticId]: resolution.pluginSelections }
      : undefined,
  };
}

export async function resolvePipelineModelInputs(options: {
  step: NormalizedStep;
  inputValues: Record<string, string>;
  modelAliases?: readonly PipelineModelAlias[];
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
  runtime: ExecutionRuntime;
  scope?: PipelineModelPolicyScope;
}): Promise<ResolvedPipelineModelInputs> {
  const { step, inputValues } = options;
  if (!step.uses || !MODEL_AWARE_AGENT_ACTIONS.has(step.uses)) {
    return { inputValues, aliasPluginCollectionIds: [] };
  }
  const selectedModel = inputValues.model?.trim();
  if (!selectedModel) {
    return { inputValues, aliasPluginCollectionIds: [] };
  }

  const alias = options.modelAliases?.find(
    (candidate) => candidate.id === selectedModel,
  );
  if (alias) {
    const preferenceDefaults = preferenceToDefaults(
      options.modelAliasPreferences?.[alias.id],
    );
    const defaults = preferenceDefaults ?? alias.defaults;
    if (!defaults) {
      throw new Error(
        `Workflow model alias "${alias.id}" requires a model configuration, but no run preference or workflow default was provided. Configure the alias in the dispatch modal or automation settings.`,
      );
    }
    if ('agent_id' in defaults) {
      return resolveAgentAliasInputs({
        aliasId: alias.id,
        aliasName: alias.name,
        agentId: resolvePipelineAgentAliasRoute(defaults),
        inputValues,
        runtime: options.runtime,
        ...(options.scope ? { scope: options.scope } : {}),
      });
    }
    assertPipelineRuntimeModelIsNotAgentModel(defaults.base);
    const systemPrompt = appendAgentSystemPrompt(
      inputValues.system_prompt,
      defaults.instructions ?? '',
    );
    return {
      inputValues: {
        ...inputValues,
        model: defaults.base,
        ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
      },
      selectedModel: alias.id,
      runtimeModel: defaults.base,
      aliasId: alias.id,
      aliasName: alias.name,
      aliasPluginCollectionIds: defaults.plugin_collection_id
        ? [defaults.plugin_collection_id]
        : [],
    };
  }

  // Built-in `$` aliases (`$cheap`/`$fast`/`$default-codex`) are rewritten at
  // normalization time only for values authored literally in the pipeline
  // YAML. A dispatch-supplied input value (`--input model=$cheap`) reaches the
  // executor as the raw alias string, so resolve it here too; an unknown
  // `$...` id throws the normalizer's "Unknown pipeline model alias" error
  // instead of reaching the provider as a bogus model id.
  const resolvedModel = resolveModelAlias(
    resolvePipelineModelAlias(selectedModel),
  );
  assertPipelineRuntimeModelIsNotAgentModel(resolvedModel);
  return {
    inputValues:
      resolvedModel === selectedModel
        ? inputValues
        : { ...inputValues, model: resolvedModel },
    selectedModel,
    runtimeModel: resolvedModel,
    aliasPluginCollectionIds: [],
  };
}

/**
 * Whether plugin selections add anything. The Agent store gives every Agent
 * selections, empty when it adds no plugins (CAN-5832).
 */
export function pipelinePluginSelectionsAddPlugins(
  selections: ChatTabPluginSelections | undefined,
): boolean {
  return (
    selections !== undefined &&
    (selections.collectionIds.length > 0 ||
      (selections.bundleIds?.length ?? 0) > 0 ||
      selections.skillRefs.length > 0 ||
      selections.pluginRefs.length > 0 ||
      (selections.mcpServerRefs?.length ?? 0) > 0)
  );
}

/** What a workflow model alias names for a run before its steps (CAN-5832). */
export interface PipelineModelAliasTarget {
  /** The base model the alias's steps run on. */
  readonly base: string;
  /** The alias adds plugins: an inline plugin collection or an Agent's plugins. */
  readonly plugins: boolean;
  /** It names an Agent, whose base model each step resolves again. */
  readonly agent: boolean;
  /**
   * Where those plugins come from (CAN-6168): the Agent's selections, or the
   * alias's inline collection id. An Agent's selections are here even when
   * they add no plugin, so the launch sees the MCP auth overrides they carry.
   */
  readonly pluginSource?:
    | { readonly kind: 'agent'; readonly selections: ChatTabPluginSelections }
    | { readonly kind: 'collection'; readonly collectionId: string };
}

/**
 * Resolves `alias` with the precedence an agent step uses
 * ({@link resolvePipelineModelInputs}): the run preference, then the
 * workflow default; an Agent through `resolveAgent`. Null when the step
 * would fail to resolve it, so a caller can leave such a run in process.
 */
export async function resolvePipelineModelAliasTarget(
  alias: PipelineModelAlias,
  preference: PipelineModelAliasPreference | undefined,
  resolveAgent: (
    agentId: string,
  ) => Promise<PipelineAgentModelAliasResolution | null>,
): Promise<PipelineModelAliasTarget | null> {
  const defaults = preferenceToDefaults(preference) ?? alias.defaults;
  if (!defaults) return null;
  if ('agent_id' in defaults) {
    const resolution = await resolveAgent(
      resolvePipelineAgentAliasRoute(defaults),
    );
    if (!resolution || !isRuntimeBaseModelAvailable(resolution.base))
      return null;
    const plugins = pipelinePluginSelectionsAddPlugins(
      resolution.pluginSelections,
    );
    return {
      base: resolution.base,
      plugins,
      agent: true,
      ...(resolution.pluginSelections && {
        pluginSource: {
          kind: 'agent' as const,
          selections: resolution.pluginSelections,
        },
      }),
    };
  }
  if (resolveModelAlias(defaults.base).startsWith(AGENT_MODEL_PREFIX))
    return null;
  return {
    base: defaults.base,
    plugins: Boolean(defaults.plugin_collection_id),
    agent: false,
    ...(defaults.plugin_collection_id && {
      pluginSource: {
        kind: 'collection' as const,
        collectionId: defaults.plugin_collection_id.trim(),
      },
    }),
  };
}

/**
 * Resolves a host step's `model` input as the agent steps do, for a chat send.
 *
 * A pipeline alias uses the run preference, then its default. An Agent alias
 * sends the Agent's model id (`defaults.agent_id`, already `agent_model_…`);
 * desktop main validates and authorizes it. An alias that carries
 * `instructions` or a plugin collection is refused, since a chat message has
 * nowhere to put them. Anything else resolves `$` and global aliases; a raw
 * Agent model id is refused as agent steps refuse it, and an unknown name
 * passes through for the host to validate. Errors name the alias only.
 */
export function resolveHostStepModel(options: {
  value: string;
  modelAliases?: readonly PipelineModelAlias[];
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
}): string {
  const alias = options.modelAliases?.find(
    (candidate) => candidate.id === options.value,
  );
  if (alias) {
    const defaults =
      preferenceToDefaults(options.modelAliasPreferences?.[alias.id]) ??
      alias.defaults;
    if (!defaults) {
      throw new Error(
        `Workflow model alias "${alias.id}" requires a model configuration, but no run preference or workflow default was provided. Configure the alias in the dispatch modal or automation settings.`,
      );
    }
    if ('agent_id' in defaults) {
      return resolvePipelineAgentAliasRoute(defaults);
    }
    if (defaults.instructions?.trim() || defaults.plugin_collection_id) {
      throw new Error(
        `Model alias "${alias.id}" sets instructions or plugins, which a chat message can't carry.`,
      );
    }
    assertPipelineRuntimeModelIsNotAgentModel(defaults.base);
    return defaults.base;
  }
  const resolvedModel = resolveModelAlias(
    resolvePipelineModelAlias(options.value),
  );
  assertPipelineRuntimeModelIsNotAgentModel(resolvedModel);
  return resolvedModel;
}

/**
 * Declared action input that carries a model id into a provider SDK call.
 *
 * The org-policy gate used to look only for an input literally named `model`,
 * which let two shipped Claude-backed actions run completely ungated:
 * `builtin/git-commit-push` takes `commit_model` and `builtin/github-create-pr`
 * takes `pr_model`. Both are reachable from the bundled
 * `implementation-autopilot` preset, so a step could send an org-blocked model
 * real repository content with no refusal and no `model_policy_refused`
 * diagnostic. The gate now probes every declared key in this table.
 */
interface ModelInputKeySpec {
  /** Manifest input name. */
  input: string;
  /**
   * Brand env preference the action's runner falls back to when the input is
   * absent. `apps/desktop-app/src/main/pipelines/preference-env.ts` injects it
   * into the execution env, and `cascadeEnv` carries it down to
   * `RunStepOptions.env`, so the effective value is visible from here.
   */
  preferenceEnvSuffix?: string;
  /** Hardcoded default in the action's runner when nothing else names a model. */
  runnerDefault?: string;
  /**
   * The action whose runner resolution `preferenceEnvSuffix` + `runnerDefault`
   * mirror exactly. Only that action gets the probed id pinned back into its
   * inputs; a third-party action that happens to declare the same input name is
   * still probed, but never rewritten.
   */
  pinForAction?: string;
}

const MODEL_INPUT_KEY_SPECS: readonly ModelInputKeySpec[] = [
  // `builtin/agent-prompt` and the direct-provider node actions. There is no
  // documented fallback to mirror: `agent-prompt/runner.ts` passes
  // `model: undefined` through and the provider picks its own default.
  { input: 'model' },
  {
    // packages/desktop-shared/src/builtin-actions/git-commit-push/runner.ts
    input: 'commit_model',
    preferenceEnvSuffix: 'PREF_COMMIT_GENERATION_MODEL',
    runnerDefault: 'haiku',
    pinForAction: 'builtin/git-commit-push',
  },
  {
    // packages/desktop-shared/src/builtin-actions/github-create-pr/runner.ts
    input: 'pr_model',
    preferenceEnvSuffix: 'PREF_PR_GENERATION_MODEL',
    runnerDefault: 'sonnet',
    pinForAction: 'builtin/github-create-pr',
  },
];

/** How a probed model id was determined, which decides the refusal wording. */
type ModelPolicyProbeSource = 'step' | 'action-default' | 'provider-default';

interface ModelPolicyProbe {
  /** Manifest input name this probe covers. */
  input: string;
  /** Real, reviewable model id handed to the org-policy gate. */
  probeModel: string;
  /** Id shown in the refusal message (the alias id when one was used). */
  displayModel: string;
  source: ModelPolicyProbeSource;
  /**
   * Write `probeModel` back into the action inputs before the step runs, so
   * the id that was checked is the id that actually runs. Only ever set while
   * an org policy is actively enforcing — see `collectModelPolicyProbes`.
   */
  pin: boolean;
}

/**
 * Resolve a raw model string against the *pipeline's* `model_aliases` before
 * probing it.
 *
 * `isModelBlocked` already resolves global aliases, but pipeline aliases live
 * on the execution options and only `MODEL_AWARE_AGENT_ACTIONS` get them
 * resolved by `resolvePipelineModelInputs`. Composite actions forward
 * `model: ${{ inputs.model }}` to a nested `builtin/agent-prompt`, so the outer
 * step can legitimately carry a pipeline alias id — probing that raw string
 * would miss the reviewed snapshot and refuse even for an org that approved the
 * alias's base model.
 *
 * An alias that cannot be resolved (no run preference and no pipeline default,
 * or an Agent this runtime cannot look up) falls back to the raw id, which
 * fails closed under an active policy and reaches the existing "requires a
 * model configuration" error otherwise.
 */
async function resolvePipelineAliasProbeModel(options: {
  value: string;
  modelAliases?: readonly PipelineModelAlias[];
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
  runtime: ExecutionRuntime;
  scope?: PipelineModelPolicyScope;
}): Promise<string> {
  const alias = options.modelAliases?.find(
    (candidate) => candidate.id === options.value,
  );
  if (!alias) {
    return options.value;
  }
  const defaults =
    preferenceToDefaults(options.modelAliasPreferences?.[alias.id]) ??
    alias.defaults;
  if (!defaults) {
    return options.value;
  }
  if ('agent_id' in defaults) {
    const resolution = await options.runtime.resolvePipelineAgentModelAlias?.(
      resolvePipelineAgentAliasRoute(defaults),
      options.scope,
    );
    return resolution?.base ?? options.value;
  }
  return defaults.base;
}

/**
 * Where an Agent alias's inherited default is read for a probe: a send step's
 * destination, as the host resolves it (an Orchestrator chat for any bot),
 * else the run's own scope. A converted chat automation runs with no project,
 * so without this an inheriting Agent would be probed as the worktree
 * default, not the default of where the message goes (CAN-5479).
 */
function aliasProbeScope(
  uses: string | undefined,
  rawInputValues: Record<string, string>,
  scope: PipelineModelPolicyScope,
): PipelineModelPolicyScope {
  if (uses !== 'builtin/send-agent-message') return scope;
  const projectId = rawInputValues.project_id?.trim();
  const destination =
    projectId ||
    (rawInputValues.bot_id?.trim() ? APP_ADVISOR_PROJECT_ID : undefined);
  if (!destination) return scope;
  return {
    projectId: destination,
    ...(scope.executionContext
      ? { executionContext: scope.executionContext }
      : {}),
  };
}

/**
 * Build one probe per model-carrying input the resolved action declares.
 *
 * Effective value per key, mirroring the action runner's own precedence:
 * the step's interpolated input, then the brand preference env var the runner
 * reads, then the runner's hardcoded default, and finally `DEFAULT_CLAUDE_MODEL`
 * when none of those exist. Probing the default rather than skipping the key is
 * deliberate: skipping is exactly what let `commit_model` / `pr_model` through.
 *
 * A step input that is present but blank is treated the way the runners treat
 * it — `INPUT_* ?? PREF_*` uses the blank string, so the preference is skipped
 * and the hardcoded default wins.
 *
 * Every pin — the `provider-default` one and the `pinForAction` ones alike — is
 * gated on `runtime.isOrgModelPolicyActive()`, so an unpoliced run resolves its
 * models exactly as it did before the gate existed.
 *
 * When nothing names a model AND an org policy is actively enforcing, the
 * probed `DEFAULT_CLAUDE_MODEL` is pinned back into the inputs. Probing it
 * without pinning it is a guess about what the provider would have chosen, and
 * the guess can under-refuse: the reviewed snapshot is an allowlist frozen at
 * last save, so if the provider's own default drifts to a newer id, that id is
 * unreviewed by construction and would have run behind a passing probe.
 */
async function collectModelPolicyProbes(options: {
  action: ResolvedActionRuntime;
  uses: string | undefined;
  rawInputValues: Record<string, string>;
  resolved: ResolvedPipelineModelInputs;
  env: Record<string, string>;
  modelAliases?: readonly PipelineModelAlias[];
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
  runtime: ExecutionRuntime;
  scope: PipelineModelPolicyScope;
}): Promise<ModelPolicyProbe[]> {
  const declaredInputs = options.action.definition.inputs ?? {};
  const probes: ModelPolicyProbe[] = [];
  const aliasScope = aliasProbeScope(
    options.uses,
    options.rawInputValues,
    options.scope,
  );
  // Resolved at most once per step, and only when a key could actually be
  // pinned — a step whose action declares no pinnable model input must not pay
  // for an extra account read.
  let orgPolicyActive: Promise<boolean> | undefined;
  const isOrgPolicyActive = (): Promise<boolean> => {
    orgPolicyActive ??= options.runtime.isOrgModelPolicyActive(options.scope);
    return orgPolicyActive;
  };

  for (const spec of MODEL_INPUT_KEY_SPECS) {
    if (!Object.prototype.hasOwnProperty.call(declaredInputs, spec.input)) {
      continue;
    }

    // Only the two builtin actions whose `INPUT_* ?? PREF_* ?? default` chain
    // this table mirrors are candidates for a write-back, and even there the
    // pin is scoped to policed runs.
    //
    // The mirror is close but not exact, so pinning is NOT behaviour-preserving
    // in general: (1) the preference is read from `options.env`, while the
    // runner's env is `{...buildSafeProcessEnv(), ...options.env, ...}`, so a
    // CLI user who exported `<BRAND>_PREF_*` in their shell (the CLI never
    // calls `buildPipelinePreferenceEnv`) previously had it honored and would
    // otherwise get the hardcoded runner default pinned over it; and (2) a
    // named value that is a pipeline `model_aliases` id is probed — and would
    // be pinned — as the alias base, where the runner previously received the
    // raw id. Those divergences can only matter while a policy is enforcing,
    // which is exactly what the pin exists to close, so gating it on
    // `isOrgModelPolicyActive()` keeps unpoliced runs byte-identical at no cost.
    const pinnable =
      spec.pinForAction !== undefined && options.uses === spec.pinForAction;

    if (spec.input === 'model' && options.resolved.runtimeModel) {
      // `resolvePipelineModelInputs` already resolved pipeline aliases and
      // Agent ids for the model-aware agent actions.
      probes.push({
        input: spec.input,
        probeModel: options.resolved.runtimeModel,
        displayModel:
          options.resolved.selectedModel ?? options.resolved.runtimeModel,
        source: 'step',
        pin: false,
      });
      continue;
    }

    const rawValue = options.rawInputValues[spec.input];
    const namedValue = rawValue?.trim();
    if (namedValue) {
      probes.push({
        input: spec.input,
        probeModel: await resolvePipelineAliasProbeModel({
          value: namedValue,
          modelAliases: options.modelAliases,
          modelAliasPreferences: options.modelAliasPreferences,
          runtime: options.runtime,
          scope: aliasScope,
        }),
        displayModel: namedValue,
        source: 'step',
        pin: pinnable ? await isOrgPolicyActive() : false,
      });
      continue;
    }

    const preferenceValue =
      rawValue === undefined && spec.preferenceEnvSuffix
        ? getBrandEnv(options.env, spec.preferenceEnvSuffix)?.trim()
        : undefined;
    const derivedValue = preferenceValue || spec.runnerDefault;
    if (derivedValue) {
      probes.push({
        input: spec.input,
        probeModel: await resolvePipelineAliasProbeModel({
          value: derivedValue,
          modelAliases: options.modelAliases,
          modelAliasPreferences: options.modelAliasPreferences,
          runtime: options.runtime,
          scope: aliasScope,
        }),
        displayModel: derivedValue,
        source: 'action-default',
        pin: pinnable ? await isOrgPolicyActive() : false,
      });
      continue;
    }

    // A host step that names no model leaves the choice to the host (a chat
    // send keeps the chat's model or gets the user's policy-checked default),
    // so there is no provider default to probe; a named host-step model is
    // still probed above.
    if (options.action.definition.runs.using === 'host') {
      continue;
    }

    // Nothing names a model and the action documents no fallback, so the
    // provider picks its own default. `DEFAULT_CLAUDE_MODEL` is a real,
    // reviewable id: an org that approved its catalog still runs, and an org
    // that did not approve the default still refuses. Under an active policy it
    // is also pinned, so the checked id is the id that runs instead of a guess
    // at the provider's own (drifting, possibly unreviewed) default. With no
    // policy active nothing is pinned and the step resolves exactly as before.
    //
    // `builtin/agent-resume` is intentionally included. Its runner has a
    // dedicated no-model branch (`actionMode === 'resume' && !env.INPUT_MODEL`
    // in `builtin-actions/agent-prompt/runner.ts`) that resumes a Claude
    // session without sending any model, so the thread silently continues on
    // whatever model it was started with — an id this gate never saw and the
    // org may never have reviewed. Under an active policy the pin deliberately
    // overrides that branch: the resumed turn runs on the checked id instead,
    // which is the fail-closed choice and is visible in the step's
    // `agent_model` metadata. Resume itself is unaffected — the runner still
    // resumes `INPUT_SESSION_ID`, exactly as it does for a resume step that
    // names its model explicitly. Unpoliced resumes keep the no-model branch.
    probes.push({
      input: spec.input,
      probeModel: DEFAULT_CLAUDE_MODEL,
      displayModel: DEFAULT_CLAUDE_MODEL,
      source: 'provider-default',
      pin: await isOrgPolicyActive(),
    });
  }

  return probes;
}

export function mergePipelinePluginSelections(
  base: ChatTabPluginSelections | undefined,
  extra: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections | undefined {
  if (!base) return extra;
  if (!extra) return base;
  const seenCollections = new Set<string>();
  const collectionIds: string[] = [];
  for (const id of [...base.collectionIds, ...extra.collectionIds]) {
    if (!id || seenCollections.has(id)) continue;
    seenCollections.add(id);
    collectionIds.push(id);
  }
  const skillRefs = [...base.skillRefs];
  for (const ref of extra.skillRefs) {
    if (
      !skillRefs.some(
        (entry) =>
          entry.sourceId === ref.sourceId && entry.skillName === ref.skillName,
      )
    ) {
      skillRefs.push(ref);
    }
  }
  const pluginRefs = [...base.pluginRefs];
  for (const ref of extra.pluginRefs) {
    if (
      !pluginRefs.some(
        (entry) =>
          entry.marketplaceId === ref.marketplaceId &&
          entry.pluginName === ref.pluginName,
      )
    ) {
      pluginRefs.push(ref);
    }
  }
  const mcpServerRefs = [...(base.mcpServerRefs ?? [])];
  for (const ref of extra.mcpServerRefs ?? []) {
    if (
      !mcpServerRefs.some(
        (entry) =>
          entry.serverId === ref.serverId && entry.configId === ref.configId,
      )
    ) {
      mcpServerRefs.push(ref);
    }
  }
  const mcpHttpAuthPreferences = new Map(
    (base.mcpHttpAuthPreferences ?? []).map((entry) => [
      mcpHttpAuthTargetKey(entry.target),
      entry,
    ]),
  );
  for (const entry of extra.mcpHttpAuthPreferences ?? []) {
    mcpHttpAuthPreferences.set(mcpHttpAuthTargetKey(entry.target), entry);
  }
  return {
    collectionIds,
    skillRefs,
    pluginRefs,
    ...(mcpServerRefs.length > 0 ? { mcpServerRefs } : {}),
    ...(mcpHttpAuthPreferences.size > 0
      ? { mcpHttpAuthPreferences: Array.from(mcpHttpAuthPreferences.values()) }
      : {}),
  };
}

/**
 * The CLAUDE_CONFIG_DIR a step's child gets: the child env spreads `secretEnv`
 * and then `env`, so `env` wins.
 */
function stepClaudeConfigDir(options: RunStepOptions): string | undefined {
  return (
    options.env?.CLAUDE_CONFIG_DIR ??
    options.secretEnv?.CLAUDE_CONFIG_DIR ??
    stepBaseEnv(options).CLAUDE_CONFIG_DIR
  );
}

/**
 * The base a step's child env is built on: the run's own environment when the
 * start supplied one (a daemon run's, CAN-5086), else this process's.
 * buildSafeProcessEnv adds no user variables to either.
 */
function stepBaseEnv(
  options: RunStepOptions,
): Readonly<Record<string, string | undefined>> {
  return options.runtime.processEnvironment ?? process.env;
}

/** Compare a child env's CLAUDE_CONFIG_DIR with the folder admission read. */
function sameClaudeConfigDir(
  childEnv: Record<string, string | undefined>,
  inspected: string | undefined,
  cwd: string,
): boolean {
  return isSameClaudePath(
    effectiveClaudeConfigDir(childEnv.CLAUDE_CONFIG_DIR, cwd, childEnv.HOME),
    effectiveClaudeConfigDir(inspected, cwd, childEnv.HOME),
  );
}

function stepHome(options: RunStepOptions): string | undefined {
  return (
    options.env?.HOME ?? options.secretEnv?.HOME ?? stepBaseEnv(options).HOME
  );
}

/**
 * Only a Terminal-mode worker hands standalone MCP servers to Claude; an SDK
 * step never loads them (CAN-6277). A host with no such worker, such as the
 * background service's pipeline host, so never reads their files or the
 * credentials they hold (CAN-6011).
 */
function withoutUnusedMcpServerRefs(
  selections: ChatTabPluginSelections,
  runtime: ExecutionRuntime,
): ChatTabPluginSelections {
  if (runtime.agentPromptWorker || !selections.mcpServerRefs?.length)
    return selections;
  return { ...selections, mcpServerRefs: [] };
}

async function materializePluginCollectionRuntime(
  options: RunStepOptions & {
    effectiveCwd: string;
    settingSources: readonly SettingSource[];
    logFile: string;
    agentProvider?: AgentProviderType;
    pluginCollectionIds?: string[];
    syntheticSelectionsByCollectionId?: Record<string, ChatTabPluginSelections>;
    legacyExtraPluginSelections?: ChatTabPluginSelections;
  },
): Promise<{
  env: Record<string, string>;
  mcpServers: Record<string, unknown>;
  hasLocalClaudePlugins: boolean;
  selections?: ChatTabPluginSelections;
  claudeModAdmission?: ClaudeModAdmissionLaunch;
  claudeModAdmissionConfigDir?: string;
}> {
  const collectionIds = options.pluginCollectionIds ?? [
    ...resolveStepPluginCollectionIds(options.step),
  ];
  const shouldResolveClaudeRuntime =
    options.agentProvider !== 'codex' &&
    options.agentProvider !== 'cursor' &&
    options.agentProvider !== 'copilot' &&
    options.agentProvider !== 'opencode' &&
    options.agentProvider !== 'antigravity';
  const claudeModAdmissionContext: ClaudeModAdmissionContext | undefined =
    shouldResolveClaudeRuntime
      ? await options.runtime.resolveClaudeModAdmissionContext?.({
          cwd: options.effectiveCwd,
          settingSources: options.settingSources,
          // Always the folder the step child uses, so admission and the child
          // never resolve it from different environments.
          claudeConfigDir: effectiveClaudeConfigDir(
            stepClaudeConfigDir(options),
            options.effectiveCwd,
            stepHome(options),
          ),
        })
      : undefined;
  if (
    collectionIds.length === 0 &&
    !options.legacyExtraPluginSelections &&
    !options.syntheticSelectionsByCollectionId &&
    !options.pipelinePackageOverlay &&
    !claudeModAdmissionContext
  ) {
    return { env: {}, mcpServers: {}, hasLocalClaudePlugins: false };
  }

  let selections: ChatTabPluginSelections | undefined;
  for (const collectionId of collectionIds) {
    const snapshot = options.resolvedPluginCollections?.[collectionId];
    const synthetic = options.syntheticSelectionsByCollectionId?.[collectionId];
    if (!snapshot && !synthetic) {
      throw new Error(
        `Plugin collection "${collectionId}" was not resolved for this execution.`,
      );
    }
    if (snapshot) {
      for (const warning of snapshot.missingOptionalDefaults ?? []) {
        await fsp.appendFile(
          options.logFile,
          `[plugin-collection] ${warning.warning}\n`,
          'utf8',
        );
      }
      selections = mergePipelinePluginSelections(
        selections,
        snapshot.selections,
      );
    }
    if (synthetic) {
      selections = mergePipelinePluginSelections(selections, synthetic);
    }
  }
  selections = mergePipelinePluginSelections(
    selections,
    options.legacyExtraPluginSelections,
  );

  const rootDir = getPipelineExecutionPluginRuntimeDir(
    options.runtime.executionsDir,
    options.executionId,
    options.jobId,
    options.parentStepId ?? options.step.id,
    options.childId,
  );
  const runtimeDirs = {
    rootDir,
    claudePluginDir: path.join(rootDir, 'claude-sdk-plugin'),
  };
  // Codex and Cursor steps never run the Claude SDK, so resolving Claude
  // plugins/skills/MCP servers for them is both wasted work and wrong: a
  // Cursor step with a resolved plugin_collection_id must fall straight
  // through to maybeRunAccountProviderPrompt's own PLUGIN_WARNING (the `selections`
  // merge above still carries the collection through for that warning).
  const claudeRuntime = shouldResolveClaudeRuntime
    ? resolvePlugins(
        withoutUnusedMcpServerRefs(
          selections ?? {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
          options.runtime,
        ),
        options.projectId ?? 'pipeline',
        options.worktreeId ?? options.executionId,
        options.parentStepId ?? options.step.id,
        {
          purpose: 'claude-session',
          // Pipeline steps have no interactive OAuth UX or long-lived proxy
          // session; HTTP MCP auth falls back to provider-side handling for v1.
          runtimeDirs,
          packageOverlay: options.pipelinePackageOverlay,
          claudeModAdmissionContext,
          claudeModAdmissionCwd: options.effectiveCwd,
          claudeModAdmissionSettingSources: options.settingSources,
        },
      )
    : undefined;
  for (const warning of claudeRuntime?.warnings ?? []) {
    await fsp.appendFile(
      options.logFile,
      `[plugin-collection] ${warning}\n`,
      'utf8',
    );
  }

  const env = {
    ...(claudeRuntime
      ? {
          [brandEnvName('CLAUDE_SDK_PLUGINS')]: JSON.stringify(
            claudeRuntime.sdkPlugins.map((plugin) => plugin.path),
          ),
        }
      : {}),
  };
  return {
    env,
    mcpServers: claudeRuntime?.mcpServers ?? {},
    hasLocalClaudePlugins: (claudeRuntime?.sdkPlugins.length ?? 0) > 0,
    ...(claudeRuntime?.claudeModAdmission
      ? {
          claudeModAdmission: claudeRuntime.claudeModAdmission,
          ...(claudeModAdmissionContext?.claudeConfigDir
            ? {
                claudeModAdmissionConfigDir:
                  claudeModAdmissionContext.claudeConfigDir,
              }
            : {}),
        }
      : {}),
    ...(selections ? { selections } : {}),
  };
}

function reportToolAllowName(): string {
  return `mcp__${BRAND.tools.namespace}__ReportStructuredResult`;
}

function mapWorkerPermission(
  preset: PermissionPreset,
  structured: boolean,
): AgentPromptWorkerPermission {
  const reportTool = structured ? [reportToolAllowName()] : [];
  switch (preset) {
    case 'read_only':
      // Read-only by construction: only the read-only built-ins exist. The
      // Canopy hook continues to govern any selected MCP tools.
      return {
        tools: [...READ_ONLY_TOOLS],
        allowedTools: [...READ_ONLY_TOOLS, ...reportTool],
      };
    case 'dangerous_all':
      return {
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      };
    case 'plan':
      // Plan mode is its own read-only, non-prompting mode (and structured
      // output is rejected for plan, so it is always text-mode here).
      return { permissionMode: 'plan' };
    case 'none':
    default:
      // No built-in tools at all — the agent can only reason and report.
      return {
        tools: [],
        allowedTools: reportTool,
      };
  }
}

async function writeWorkerAgentOutputs(options: {
  tempDir: string;
  logFile: string;
  sessionId: string;
  transcript: string;
  rawText: string;
  // Redacted separately by the caller from the ORIGINAL (pre-redaction)
  // rawText, not derived here from the already-redacted `rawText` above —
  // see the callers' comment for why normalizing an already-redacted string
  // can reconstitute a secret whose whitespace differs from the agent's
  // raw echo.
  textResponse: string;
  structured?: unknown;
  proposedPlan?: string;
}): Promise<Record<string, string>> {
  const outputDir = path.join(options.tempDir, 'worker-agent-output');
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(options.logFile, options.transcript, 'utf8');
  const textFile = path.join(outputDir, 'text-response.txt');
  await fsp.writeFile(textFile, options.rawText, 'utf8');
  const outputs: Record<string, string> = {
    session_id: options.sessionId,
    transcript_file: options.logFile,
    text_response: options.textResponse,
    text_response_file: textFile,
  };
  if (options.structured !== undefined) {
    const json = JSON.stringify(options.structured);
    const jsonFile = path.join(outputDir, 'json-response.json');
    await fsp.writeFile(
      jsonFile,
      `${JSON.stringify(options.structured, null, 2)}\n`,
      'utf8',
    );
    outputs.json_response = json;
    outputs.json_response_file = jsonFile;
  }
  if (options.proposedPlan) {
    const planFile = path.join(outputDir, 'proposed-plan.md');
    await fsp.writeFile(planFile, `${options.proposedPlan}\n`, 'utf8');
    outputs.proposed_plan_file = planFile;
  }
  return outputs;
}

/**
 * Fast mode for a host-run Codex agent step. An explicit step `fast_mode`
 * keeps its boolean meaning (true → Fast, false → Regular) and wins over the
 * run's model config. Pipelines cannot run Ultra fast, so a step that would
 * otherwise run under an Ultra fast run config is rejected before the agent
 * launches instead of silently running at another speed.
 */
function resolveCodexStepFastMode(
  rawFastMode: string | undefined,
  runModelConfig: AgentModelConfig | undefined,
): boolean {
  if (
    (rawFastMode === undefined || rawFastMode.trim().length === 0) &&
    readCodexSpeedRecord(runModelConfig) === 'ultrafast'
  ) {
    throw new Error(
      'Workflows do not support Ultra fast. Set fast_mode on this step, or run the workflow with Regular or Fast.',
    );
  }
  return parseBooleanInput(rawFastMode, 'fast_mode', false);
}

async function maybeRunCodexPrompt(options: {
  runStepOptions: RunStepOptions;
  inputValues: Record<string, string>;
  pluginCollectionRuntime: {
    selections?: ChatTabPluginSelections;
  };
  effectiveCwd: string;
  tempDir: string;
  logFile: string;
  startedAt: string;
  stepId: string;
  attempt: number;
  iteration: number;
  logMetadata: StepLogMetadata;
  /** The step's open Ledger attempt; the host serves it on the thread. */
  ledgerAttempt?: PipelineLedgerAttempt | null;
}): Promise<StepResult | null> {
  const {
    runStepOptions,
    inputValues,
    pluginCollectionRuntime,
    effectiveCwd,
    tempDir,
    logFile,
    startedAt,
    stepId,
    attempt,
    iteration,
    logMetadata,
    ledgerAttempt,
  } = options;
  const isResume = runStepOptions.step.uses === 'builtin/agent-resume';
  if (runStepOptions.step.uses !== 'builtin/agent-prompt' && !isResume) {
    return null;
  }
  const resolvedModel = resolveExplicitAgentModel(inputValues.model);
  if (!resolvedModel) {
    return null;
  }
  const harness =
    recoveryCheckpointForStep(runStepOptions)?.harness ??
    getExecutionHarnessForModel(resolvedModel);
  if (harness !== 'codex') return null;
  const runner = runStepOptions.runtime.codexPromptRunner;
  if (!runner) {
    throw new Error(
      'Codex pipeline actions require a host Codex runtime; no runner was configured.',
    );
  }
  const fastMode = resolveCodexStepFastMode(
    inputValues.fast_mode,
    runStepOptions.modelConfig,
  );
  const rawSessionId = isResume ? inputValues.session_id?.trim() : undefined;
  const resumeSessionId = rawSessionId || undefined;
  if (isResume && !resumeSessionId) {
    throw new Error('session_id is required for builtin/agent-resume');
  }
  const schema = parseStructuredSchema(inputValues.structured_output_schema);
  const parsedPermissionPreset = parsePermissionPreset(
    inputValues.permission_preset,
  );
  // Only an EXPLICITLY authored `permission_preset: none` is a routing error.
  // `inputValues` cannot answer that question: `resolveActionInputs`
  // materializes every declared `default:`, and the shipped
  // `resources/actions/agent-prompt|agent-resume/action.yml` declare
  // `default: none`, so `inputValues.permission_preset` is the literal string
  // "none" for every step that never mentioned the input. Reading the authored
  // `step.with` keeps the explicit-vs-defaulted distinction this guard needs.
  //
  // Fragility to watch: a composite action that declares `default: none` and
  // forwards `permission_preset` would materialize "none" into the NESTED
  // step's `with`, re-breaking this test one level down. No shipped composite
  // does today (coder/qa-fixer default dangerous_all, discovery/
  // requirements-from-task default read_only).
  const authoredPermissionPreset =
    runStepOptions.step.with?.permission_preset === undefined ||
    runStepOptions.step.with?.permission_preset === null
      ? undefined
      : String(runStepOptions.step.with.permission_preset).trim();
  if (
    parsedPermissionPreset === 'none' &&
    authoredPermissionPreset === 'none'
  ) {
    throw new Error(
      'permission_preset "none" is not supported on the Codex harness because that runtime cannot disable native tools. Assign the model to the Claude harness or choose a different permission preset.',
    );
  }
  // A DEFAULTED `none` must not silently become the most permissive sandbox:
  // `codexSandboxForPermission` maps 'none' -> workspace-write (more permissive
  // than read_only) and pairs it with approvalPolicy 'never'. The action's own
  // documentation tells Codex authors to pick read_only or dangerous_all, so
  // fall back to read_only rather than granting unattended workspace write to a
  // step whose declared intent was "no tools at all". An explicit `none` still
  // throws above, so this only affects steps that never authored the input.
  const permissionPreset =
    parsedPermissionPreset === 'none' ? 'read_only' : parsedPermissionPreset;
  validateStructuredOutputInputs(permissionPreset, schema);
  const prompt = applyPlanPromptRequirement(
    await resolvePrompt({
      prompt: inputValues.prompt,
      promptFile: inputValues.prompt_file,
    }),
    permissionPreset,
  );
  const transcriptLog = await openHostRunnerTranscriptLog({
    runStepOptions,
    logFile,
    stepId,
    attempt,
    iteration,
  });
  const routingContext = buildStepAiCreditsRoutingContext(runStepOptions);
  let streamedTranscriptLength = 0;
  /** A required transcript transformation/persistence failure, recorded
   * because the runners' `pushTranscriptLine` swallows callback exceptions. */
  let transcriptFailure: Error | undefined;
  let result: CodexPromptRunnerResult;
  let harnessInvocation: ModelHarnessInvocation | undefined;
  let transcriptSecretValues: readonly string[] = [];
  try {
    harnessInvocation = runStepOptions.runtime.resolveModelHarnessInvocation
      ? await runStepOptions.runtime.resolveModelHarnessInvocation(
          resolvedModel,
          {
            harness,
            ...routingContext,
          },
        )
      : undefined;
    // Constructed only after `harnessInvocation` resolves, and includes its
    // `envOverride` alongside `runStepOptions.secretEnv`, so this stays in
    // sync with the `secretValues` passed to `finishHostRunnerStep` below.
    // `resolveAiCreditsRoutingOverride`'s `env` is always `{}` for Codex today
    // (see `buildCodexProxyConfig` in `ai-credits-routing.ts`: the app-server
    // child gets only an opaque loopback route, and the parent injects the
    // real bearer token upstream — the token itself never reaches this
    // process's env), so there is nothing live to redact from `envOverride`
    // yet. This is seam-symmetry/defense-in-depth against that changing, not
    // a fix for a currently reachable leak.
    transcriptSecretValues = [
      ...getSecretValues(runStepOptions.secretEnv),
      ...getSecretValues(harnessInvocation?.envOverride ?? {}),
    ];
    result = await runner.runCodexPrompt({
      cwd: effectiveCwd,
      prompt,
      environment: sanitizeCodexSpawnEnvironment({
        ...runStepOptions.env,
        ...runStepOptions.secretEnv,
      }),
      systemPrompt: inputValues.system_prompt,
      schema,
      resumeSessionId,
      model: resolvedModel,
      ...(harnessInvocation ? { harnessInvocation } : {}),
      thinkingLevel: parseThinkingEffort(inputValues.thinking_effort),
      fastMode,
      totalTimeoutMs: runStepOptions.step.timeout_minutes * 60_000,
      permissionPreset,
      pluginSelections: pluginCollectionRuntime.selections,
      packageOverlay: runStepOptions.pipelinePackageOverlay,
      projectId: runStepOptions.projectId,
      worktreeId: runStepOptions.worktreeId,
      // Same source as the generic seam, so this path and
      // `resolveActionAiCreditsEnv` can never disagree about attendedness.
      allowNoNativeAuthFallback: routingContext.allowNoNativeAuthFallback,
      ...(ledgerAttempt ? { ledgerAttemptKey: ledgerAttempt.attemptKey } : {}),
      ...(routingContext.executionContext !== undefined
        ? { executionContext: routingContext.executionContext }
        : {}),
      executionId: runStepOptions.executionId,
      jobId: runStepOptions.jobId,
      stepId,
      attempt,
      childId: runStepOptions.childId,
      stepLabel: runStepOptions.step.name ?? stepId,
      signal: runStepOptions.signal,
      linkTarget: {
        page: 'pipelines',
        kind: 'pipeline-execution',
        projectId: runStepOptions.projectId,
        worktreeId: runStepOptions.worktreeId,
        pipelineExecutionId: runStepOptions.executionId,
      },
      onTranscriptLine: (line) => {
        // The count advances here so the not-yet-streamed remainder boundary stays
        // right even when the work below fails; the line is consumed either way.
        // What was wrong was treating the whole callback as best-effort:
        // `pushTranscriptLine` swallows whatever this throws, so a failed masking or
        // durable append silently dropped the record AND left the step reporting
        // success. Masking and the log append are required and recorded; only the
        // live emission is best-effort.
        streamedTranscriptLength += line.length + 1;
        try {
          // Every host-runner transcript line is a single, complete
          // `JSON.stringify` result (never a partial line split across
          // calls), so this matches against each string token's DECODED value
          // and splices the mask back in at the ORIGINAL serialized offsets,
          // rather than matching the raw serialized text — see
          // `redactSerializedJsonLine`'s doc comment for why that's required
          // to avoid corrupting the JSON. Nothing is re-serialized, so a line
          // with no match is passed through byte-for-byte.
          const redacted = `${redactSerializedJsonLine(line, transcriptSecretValues)}\n`;
          const logPosition = transcriptLog.append(redacted);
          try {
            transcriptLog.emit(redacted, logPosition);
          } catch {
            /* Live step output is a UI stream: best-effort by design. */
          }
        } catch (error) {
          transcriptFailure ??=
            error instanceof Error ? error : new Error(String(error));
        }
      },
    });
  } finally {
    if (routingContext.routeSessionId) {
      await runStepOptions.runtime.releaseAiCreditsRouting?.(
        routingContext.routeSessionId,
      );
    }
  }

  return finishHostRunnerStep({
    runStepOptions,
    result,
    accountProxyRouted: harnessInvocation?.accountProxyRouted === true,
    accountProxyConnectionId: harnessInvocation?.accountProxyConnectionId,
    accountProxySessionId: routingContext.routeSessionId,
    resolvedModel,
    streamedTranscriptLength,
    transcriptFailure: () => transcriptFailure,
    transcriptLog,
    tempDir,
    logFile,
    startedAt,
    stepId,
    attempt,
    iteration,
    logMetadata,
    // The exact same value set `onTranscriptLine` above used, including
    // `harnessInvocation.envOverride` alongside `runStepOptions.secretEnv`
    // (see that comment for why `envOverride` is always `{}` for Codex
    // today — defense-in-depth, not an active leak).
    secretValues: transcriptSecretValues,
  });
}

/**
 * The transcript log of one host-runner step (`maybeRunCodexPrompt` and
 * `maybeRunCursorPrompt`): one serialized append chain plus live emission.
 */
interface HostRunnerTranscriptLog {
  /**
   * Queues `chunk` behind every earlier append and returns the byte range it
   * will occupy. Emission may happen before the append lands; the chain is the
   * file's only writer, so readers only ever see a prefix of it.
   */
  append(chunk: string): StepOutputLogPosition | undefined;
  /** Emits already-appended bytes as a live step output event. */
  emit(data: string, logPosition?: StepOutputLogPosition): void;
  /** Resolves once every queued append landed; rethrows the first failure. */
  awaitLog(): Promise<void>;
}

/**
 * Opens a host runner's transcript log. The transcript owns the whole file,
 * so it is truncated here — dropping setup lines such as plugin-collection
 * warnings exactly as the first transcript write used to — and every chunk is
 * positioned from offset zero. A failed truncation is recorded like a failed
 * append (the step fails once the log is awaited) and leaves events
 * unpositioned.
 */
async function openHostRunnerTranscriptLog(options: {
  runStepOptions: RunStepOptions;
  logFile: string;
  stepId: string;
  attempt: number;
  iteration: number;
}): Promise<HostRunnerTranscriptLog> {
  const { runStepOptions, logFile, stepId, attempt, iteration } = options;
  const recovery = runStepOptions.recovery ?? 0;
  let logWriteError: Error | undefined;
  const recordLogWriteError = (error: unknown): void => {
    logWriteError ??= error instanceof Error ? error : new Error(String(error));
    // Positions claimed after a failed write no longer describe the file.
    invalidateStepLogGeneration(logFile);
  };
  let positions: StepLogPositionCursor | undefined;
  try {
    positions = await resetStepLogForPositionedWriter(logFile);
  } catch (error) {
    recordLogWriteError(error);
  }
  let logWrite: Promise<void> = Promise.resolve();
  return {
    append(chunk: string): StepOutputLogPosition | undefined {
      const logPosition = positions?.claim(chunk);
      logWrite = logWrite
        .then(() => fsp.appendFile(logFile, chunk, 'utf8'))
        .catch(recordLogWriteError);
      return logPosition;
    },
    emit(data: string, logPosition?: StepOutputLogPosition): void {
      runStepOptions.onStepOutput?.({
        executionId: runStepOptions.executionId,
        jobId: runStepOptions.jobId,
        jobName: runStepOptions.jobName ?? runStepOptions.jobId,
        stepId,
        stepName: runStepOptions.step.name ?? stepId,
        attempt,
        iteration,
        ...(recovery > 0 ? { recovery } : {}),
        stream: 'stdout',
        data,
        ...(logPosition ? { logPosition } : {}),
      });
    },
    async awaitLog(): Promise<void> {
      await logWrite;
      if (logWriteError) {
        throw logWriteError;
      }
    },
  };
}

/**
 * Shared result mapping for the host-runner interceptors (`maybeRunCodexPrompt`
 * and `maybeRunAccountProviderPrompt`): flush the not-yet-streamed transcript remainder,
 * await the pending log write, then map the runner's result to a cancelled,
 * failed-with-recovery, or successful `StepResult`.
 */
async function finishHostRunnerStep(options: {
  runStepOptions: RunStepOptions;
  result: CodexPromptRunnerResult;
  /** The step ran through the account proxy; see `buildAgentRecoveryStepResult`. */
  accountProxyRouted?: boolean;
  accountProxyConnectionId?: string;
  /** The broker route the proxied step used; see the session output key. */
  accountProxySessionId?: string;
  resolvedModel: string;
  streamedTranscriptLength: number;
  /**
   * Reads back a required transcript transformation/persistence failure the
   * caller's `onTranscriptLine` recorded. It cannot throw from there: the
   * runners' `pushTranscriptLine` swallows callback exceptions by design so a
   * dead UI stream cannot abort a turn. A masking or durable-append failure is
   * not that, and must not leave the step reporting success.
   */
  transcriptFailure?: () => Error | undefined;
  transcriptLog: HostRunnerTranscriptLog;
  tempDir: string;
  logFile: string;
  startedAt: string;
  stepId: string;
  attempt: number;
  iteration: number;
  logMetadata: StepLogMetadata;
  /**
   * MUST be the exact same value set the caller used for `onTranscriptLine`
   * — not just `runStepOptions.secretEnv`. A caller with an
   * AI-Credits-routed harness invocation (Codex) also includes
   * `harnessInvocation.envOverride`'s values there and here, so both
   * surfaces stay symmetric; passing a narrower set here than was used to
   * redact the streamed lines (or vice versa) reopens exactly the gap this
   * redaction exists to close. The transcript log's already-streamed
   * portion is already redacted via `onTranscriptLine`/`transcriptLog`,
   * but the not-yet-streamed remainder below and
   * `result.rawText`/`result.structured`/`result.proposedPlan` reach
   * `writeWorkerAgentOutputs` untouched otherwise — this is what redacts
   * them.
   */
  secretValues: readonly string[];
}): Promise<StepResult> {
  const {
    runStepOptions,
    result,
    resolvedModel,
    streamedTranscriptLength,
    transcriptLog,
    tempDir,
    logFile,
    startedAt,
    stepId,
    attempt,
    iteration,
    logMetadata,
    secretValues,
  } = options;

  // Streamed lines are a prefix of the resolved transcript, so only the
  // not-yet-streamed remainder is persisted and emitted here. Runners that
  // never stream fall back to one whole-transcript emission. `result.transcript`
  // always ends with exactly one trailing `\n` (see `runCliCodexPrompt`/
  // `runCursorPromptWithDriver`'s `${transcript.join('\n')}\n`), so splitting
  // on `\n` yields whole lines plus one trailing empty segment, which is left
  // untouched (nothing to redact, and re-joining must reproduce it exactly).
  const transcriptRemainder = result.transcript.slice(streamedTranscriptLength);
  const remainderLines = transcriptRemainder.split('\n');
  const redactedRemainder = remainderLines
    .map((line, index) =>
      index === remainderLines.length - 1 && line.length === 0
        ? line
        : redactSerializedJsonLine(line, secretValues),
    )
    .join('\n');
  if (redactedRemainder.length > 0) {
    const logPosition = transcriptLog.append(redactedRemainder);
    transcriptLog.emit(redactedRemainder, logPosition);
  }
  await transcriptLog.awaitLog();
  const recordedTranscriptFailure = options.transcriptFailure?.();
  if (recordedTranscriptFailure && result.status === 'success') {
    return createStepResult({
      ...logMetadata,
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      exit_code: 1,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      error: recordedTranscriptFailure.message,
      outputs: {},
      dynamic_env: {},
      log_file: logFile,
    });
  }
  if (result.status !== 'success') {
    // The agent's own terminal error text (a Cursor/Codex turn failure
    // message, or a JSON-parse error embedding a snippet of malformed
    // structured output) can echo a pipeline secret the same way
    // rawText/structured/proposedPlan can, but unlike those it was not
    // covered by the redaction fix above — it reaches agent-failure.json and
    // the step's `error` output unredacted otherwise.
    const redactedFailureMessage = redactWorkerSecretValues(
      result.failure.message,
      secretValues,
    );
    if (
      result.status === 'cancelled' &&
      !isShutdownSignal(runStepOptions.signal)
    ) {
      return createStepResult({
        ...logMetadata,
        status: 'cancelled',
        conclusion: 'cancelled',
        outcome: 'cancelled',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        error: redactedFailureMessage,
        outputs: {
          ...(result.aiCreditsRouted
            ? { [AI_CREDITS_ROUTED_OUTPUT_KEY]: 'true' }
            : {}),
          ...(result.modelGatewayRouted
            ? { [MODEL_GATEWAY_ROUTED_OUTPUT_KEY]: 'true' }
            : {}),
          ...(options.accountProxyRouted
            ? accountProxyRouteOutputs(options.accountProxySessionId)
            : {}),
        },
        dynamic_env: {},
        log_file: logFile,
      });
    }
    const metadataFile = path.join(tempDir, 'agent-failure.json');
    // `classification.diagnostic_message` is derived from the same
    // agent-authored error/transcript text as `message` above (see
    // classifyAgentFailure's `events`/`error` inputs) and reaches this same
    // durable file; classifyAgentFailure only applies shape-based
    // redactSecrets(), which by design cannot catch an arbitrary
    // pipeline-configured secret value, so it needs the same value-based
    // redaction applied here.
    const redactedClassification = result.failure.classification
      ? {
          ...result.failure.classification,
          diagnostic_message: redactWorkerSecretValues(
            result.failure.classification.diagnostic_message,
            secretValues,
          ),
        }
      : undefined;
    await fsp.writeFile(
      metadataFile,
      `${JSON.stringify(
        {
          ...result.failure,
          message: redactedFailureMessage,
          ...(redactedClassification
            ? { classification: redactedClassification }
            : {}),
          transcript_file: logFile,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const failedResult: CompletedProcessResult = {
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      exit_code: 1,
      error: redactedFailureMessage,
      outputs: {
        agent_failure_metadata_file: metadataFile,
        agent_failure_transcript_file: logFile,
      },
      dynamic_env: {},
      log_file: logFile,
    };
    const agentRecoveryResult = await buildAgentRecoveryStepResult({
      result: failedResult,
      shutdown: isShutdownSignal(runStepOptions.signal),
      step: runStepOptions.step,
      tempDir,
      executionDir: path.join(
        runStepOptions.runtime.executionsDir,
        runStepOptions.executionId,
      ),
      attempt,
      iteration,
      jobId: runStepOptions.jobId,
      stepId,
      model: resolvedModel,
      childId: runStepOptions.childId,
      priorAgentActivity:
        recoveryCheckpointForStep(runStepOptions)?.had_agent_activity === true,
      accountProxyRouted: options.accountProxyRouted === true,
      accountProxyConnectionId: options.accountProxyConnectionId,
    });
    return createStepResult({
      ...logMetadata,
      ...failedResult,
      ...(agentRecoveryResult ?? {}),
      outputs: {
        ...(agentRecoveryResult?.outputs ?? failedResult.outputs),
        ...(result.aiCreditsRouted
          ? { [AI_CREDITS_ROUTED_OUTPUT_KEY]: 'true' }
          : {}),
        ...(result.modelGatewayRouted
          ? { [MODEL_GATEWAY_ROUTED_OUTPUT_KEY]: 'true' }
          : {}),
        ...(options.accountProxyRouted
          ? accountProxyRouteOutputs(options.accountProxySessionId)
          : {}),
      },
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });
  }
  // `transcriptLog.append`/`awaitLog` above already wrote the full redacted
  // transcript to `logFile` in order, so reading it back is the same value
  // the in-memory accumulation used to hold, without each caller needing its
  // own accumulator variable.
  // awaitLog() has resolved every queued write, so the file is complete here;
  // keep this read after that await.
  const redactedTranscript = await fsp.readFile(logFile, 'utf8');
  const redactedWorkerRawText = redactWorkerSecretValues(
    result.rawText,
    secretValues,
  );
  const outputs = await writeWorkerAgentOutputs({
    tempDir,
    logFile,
    sessionId: result.sessionId,
    transcript: redactedTranscript,
    rawText: redactedWorkerRawText,
    // A multi-line secret echoed verbatim only exact-matches before
    // normalizing collapses its internal newlines, while a secret whose
    // internal whitespace the agent reformatted only exact-matches after
    // normalizing reconstitutes it. `redactNormalizedText` closes both in
    // one pass by matching the normalized text against the value list
    // expanded with each value's own normalized form, rather than
    // sequential redact passes that can leak when two configured values
    // share a whitespace-differing prefix/suffix (see its doc comment).
    textResponse: redactNormalizedText(result.rawText, secretValues),
    structured: redactWorkerStructuredValue(result.structured, secretValues),
    proposedPlan:
      result.proposedPlan === undefined
        ? undefined
        : redactWorkerSecretValues(result.proposedPlan, secretValues),
  });
  return createStepResult({
    ...logMetadata,
    status: 'success',
    conclusion: 'success',
    outcome: 'success',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    outputs: {
      ...outputs,
      ...(result.aiCreditsRouted
        ? { [AI_CREDITS_ROUTED_OUTPUT_KEY]: 'true' }
        : {}),
      ...(result.modelGatewayRouted
        ? { [MODEL_GATEWAY_ROUTED_OUTPUT_KEY]: 'true' }
        : {}),
      ...(options.accountProxyRouted
        ? accountProxyRouteOutputs(options.accountProxySessionId)
        : {}),
    },
    dynamic_env: {},
    log_file: logFile,
  });
}

/**
 * Cursor's pipeline seam, mirroring `maybeRunCodexPrompt`: intercepts
 * `builtin/agent-prompt`/`builtin/agent-resume` before the generic action
 * path when the resolved harness is `cursor`, and shares
 * `finishHostRunnerStep` for the result mapping. Cursor has no fast tier, no
 * host-side thinking control, and bills only through the Cursor account, so
 * (unlike Codex) there is no `harnessInvocation`, `thinkingLevel`,
 * `fastMode`, or `allowNoNativeAuthFallback` on the request, and an authored
 * `permission_preset: none` is honored rather than rejected — Cursor's hook
 * can deny every tool, so `none` is a real, supportable preset there.
 */
const CURSOR_RECOVERY_MODEL_MISSING =
  'This step paused while running on Cursor, and its model no longer resolves. Set its model to a Cursor model, then resume.';

async function maybeRunAccountProviderPrompt(options: {
  runStepOptions: RunStepOptions;
  inputValues: Record<string, string>;
  pluginCollectionRuntime: {
    selections?: ChatTabPluginSelections;
  };
  effectiveCwd: string;
  tempDir: string;
  logFile: string;
  startedAt: string;
  stepId: string;
  attempt: number;
  iteration: number;
  logMetadata: StepLogMetadata;
  /** The step's Ledger attempt; only the OpenCode host serves its tools. */
  ledgerAttempt?: PipelineLedgerAttempt | null;
}): Promise<StepResult | null> {
  const {
    runStepOptions,
    inputValues,
    pluginCollectionRuntime,
    effectiveCwd,
    tempDir,
    logFile,
    startedAt,
    stepId,
    attempt,
    iteration,
    logMetadata,
    ledgerAttempt,
  } = options;
  const isResume = runStepOptions.step.uses === 'builtin/agent-resume';
  if (runStepOptions.step.uses !== 'builtin/agent-prompt' && !isResume) {
    return null;
  }
  const resolvedModel = resolveExplicitAgentModel(inputValues.model);
  const checkpointHarness = recoveryCheckpointForStep(runStepOptions)?.harness;
  if (!resolvedModel) {
    // Recovery replays the step's own `with` block, so a Cursor checkpoint
    // has no model only when the step's model expression now evaluates empty.
    // Declining here would hand a Cursor session to the generic Claude runner.
    if (
      checkpointHarness === 'cursor' ||
      checkpointHarness === 'copilot' ||
      checkpointHarness === 'opencode' ||
      checkpointHarness === 'antigravity'
    )
      throw new Error(
        checkpointHarness === 'cursor'
          ? CURSOR_RECOVERY_MODEL_MISSING
          : checkpointHarness === 'antigravity'
            ? 'This step paused on Google. Select its Google subscription model before resuming.'
            : checkpointHarness === 'opencode'
              ? 'This step paused on OpenCode. Select its OpenCode model before resuming.'
              : 'This step paused on Copilot. Select its Copilot model before resuming.',
      );
    return null;
  }
  const harness =
    checkpointHarness ?? getExecutionHarnessForModel(resolvedModel);
  if (
    harness !== 'cursor' &&
    harness !== 'copilot' &&
    harness !== 'opencode' &&
    harness !== 'antigravity'
  )
    return null;
  const runPrompt =
    harness === 'antigravity'
      ? runStepOptions.runtime.antigravityPromptRunner?.runAntigravityPrompt.bind(
          runStepOptions.runtime.antigravityPromptRunner,
        )
      : harness === 'opencode'
        ? runStepOptions.runtime.opencodePromptRunner?.runOpenCodePrompt.bind(
            runStepOptions.runtime.opencodePromptRunner,
          )
        : harness === 'copilot'
          ? runStepOptions.runtime.copilotPromptRunner?.runCopilotPrompt.bind(
              runStepOptions.runtime.copilotPromptRunner,
            )
          : runStepOptions.runtime.cursorPromptRunner?.runCursorPrompt.bind(
              runStepOptions.runtime.cursorPromptRunner,
            );
  if (!runPrompt) {
    throw new Error(
      `${harness === 'antigravity' ? 'Google' : harness === 'opencode' ? 'OpenCode' : harness === 'copilot' ? 'Copilot' : 'Cursor'} pipeline actions require a host ${harness === 'antigravity' ? 'Google' : harness === 'opencode' ? 'OpenCode' : harness === 'copilot' ? 'Copilot' : 'Cursor'} runtime; no runner was configured.`,
    );
  }
  const rawSessionId = isResume ? inputValues.session_id?.trim() : undefined;
  const resumeSessionId = rawSessionId || undefined;
  if (isResume && !resumeSessionId) {
    throw new Error('session_id is required for builtin/agent-resume');
  }
  const schema = parseStructuredSchema(inputValues.structured_output_schema);
  // Unlike Codex, Cursor's hook can deny every tool, so an authored `none` is
  // honored rather than rejected or coerced to `read_only`.
  const permissionPreset = parsePermissionPreset(inputValues.permission_preset);
  validateStructuredOutputInputs(permissionPreset, schema);
  const prompt = applyPlanPromptRequirement(
    await resolvePrompt({
      prompt: inputValues.prompt,
      promptFile: inputValues.prompt_file,
    }),
    permissionPreset,
  );
  const transcriptSecretValues = getSecretValues(runStepOptions.secretEnv);
  let streamedTranscriptLength = 0;
  /** A required transcript transformation/persistence failure, recorded
   * because the runners' `pushTranscriptLine` swallows callback exceptions. */
  let transcriptFailure: Error | undefined;
  const transcriptLog = await openHostRunnerTranscriptLog({
    runStepOptions,
    logFile,
    stepId,
    attempt,
    iteration,
  });
  const executionCheckoutRoot = getExecutionCheckoutRoot(runStepOptions);
  const result = await runPrompt({
    cwd: effectiveCwd,
    repositoryPolicyScope:
      runStepOptions.target?.scope === 'global' ||
      runStepOptions.scope === 'global'
        ? { kind: 'rootless' }
        : executionCheckoutRoot == null
          ? undefined
          : { kind: 'checkout', root: executionCheckoutRoot },
    prompt,
    environment: { ...runStepOptions.env, ...runStepOptions.secretEnv },
    systemPrompt: inputValues.system_prompt,
    schema,
    resumeSessionId,
    model: resolvedModel,
    ...(harness === 'antigravity' ||
    harness === 'opencode' ||
    harness === 'copilot'
      ? { thinkingLevel: parseThinkingEffort(inputValues.thinking_effort) }
      : {}),
    totalTimeoutMs: runStepOptions.step.timeout_minutes * 60_000,
    permissionPreset,
    pluginSelections: pluginCollectionRuntime.selections,
    packageOverlay: runStepOptions.pipelinePackageOverlay,
    projectId: runStepOptions.projectId,
    ...(harness === 'opencode'
      ? {
          worktreeId: runStepOptions.worktreeId,
          executionContext: runStepOptions.executionContext,
          ...(ledgerAttempt
            ? { ledgerAttemptKey: ledgerAttempt.attemptKey }
            : {}),
        }
      : {}),
    executionsDir: runStepOptions.runtime.executionsDir,
    executionId: runStepOptions.executionId,
    jobId: runStepOptions.jobId,
    stepId,
    attempt,
    childId: runStepOptions.childId,
    signal: runStepOptions.signal,
    secretValues: transcriptSecretValues,
    onTranscriptLine: (line) => {
      // The count advances here so the not-yet-streamed remainder boundary stays
      // right even when the work below fails; the line is consumed either way.
      // What was wrong was treating the whole callback as best-effort:
      // `pushTranscriptLine` swallows whatever this throws, so a failed masking or
      // durable append silently dropped the record AND left the step reporting
      // success. Masking and the log append are required and recorded; only the
      // live emission is best-effort.
      streamedTranscriptLength += line.length + 1;
      try {
        // Every host-runner transcript line is a single, complete
        // `JSON.stringify` result (never a partial line split across calls),
        // so this matches against each string token's DECODED value and
        // splices the mask back in at the ORIGINAL serialized offsets, rather
        // than matching the raw serialized text — see
        // `redactSerializedJsonLine`'s doc comment for why that's required to
        // avoid corrupting the JSON. Nothing is re-serialized, so a line with
        // no match is passed through byte-for-byte.
        const redacted = `${redactSerializedJsonLine(line, transcriptSecretValues)}\n`;
        const logPosition = transcriptLog.append(redacted);
        try {
          transcriptLog.emit(redacted, logPosition);
        } catch {
          /* Live step output is a UI stream: best-effort by design. */
        }
      } catch (error) {
        transcriptFailure ??=
          error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  return finishHostRunnerStep({
    runStepOptions,
    result,
    resolvedModel,
    streamedTranscriptLength,
    transcriptFailure: () => transcriptFailure,
    transcriptLog,
    tempDir,
    logFile,
    startedAt,
    stepId,
    attempt,
    iteration,
    logMetadata,
    // The exact same value set `onTranscriptLine` above used. Unlike the
    // in-process worker/standalone subprocess seams, this omits an
    // AI-Credits routing credential: `resolveActionAiCreditsEnv` returns
    // `empty` for `provider === 'cursor'`, so there is no such secret value
    // to redact on this path.
    secretValues: transcriptSecretValues,
  });
}

async function maybeRunAgentPromptWorker(options: {
  action: ResolvedActionRuntime;
  /** The step ran through the account proxy; see `buildAgentRecoveryStepResult`. */
  accountProxyRouted?: boolean;
  accountProxyConnectionId?: string;
  runStepOptions: RunStepOptions;
  inputValues: Record<string, string>;
  pluginCollectionRuntime: {
    env: Record<string, string>;
    mcpServers: Record<string, unknown>;
    hasLocalClaudePlugins: boolean;
    selections?: ChatTabPluginSelections;
    claudeModAdmission?: ClaudeModAdmissionLaunch;
  };
  effectiveCwd: string;
  tempDir: string;
  logFile: string;
  startedAt: string;
  stepId: string;
  attempt: number;
  iteration: number;
  logMetadata: StepLogMetadata;
  claudeEnvOverride?: Record<string, string>;
  aiCreditsRouteSessionId?: string;
  secretValues?: readonly string[];
  /** The step's open Ledger attempt; the worker's route serves it. */
  ledgerAttempt?: PipelineLedgerAttempt | null;
}): Promise<StepResult | null> {
  const {
    runStepOptions,
    inputValues,
    pluginCollectionRuntime,
    effectiveCwd,
    tempDir,
    logFile,
    startedAt,
    stepId,
    attempt,
    iteration,
    logMetadata,
    claudeEnvOverride,
    aiCreditsRouteSessionId,
    secretValues = [],
    ledgerAttempt,
  } = options;
  const isResume = runStepOptions.step.uses === 'builtin/agent-resume';
  if (
    (runStepOptions.step.uses !== 'builtin/agent-prompt' && !isResume) ||
    !runStepOptions.agentTerminalMode ||
    !runStepOptions.runtime.agentPromptWorker
  ) {
    return null;
  }
  const resolvedModel = resolveExplicitAgentModel(inputValues.model);
  // Worker mode is Claude-only. A resume with no explicit model continues the
  // (Claude) session it was given, mirroring the SDK runner which tries Claude
  // first for model-less resume; an explicit non-Claude model bails to the SDK.
  if (
    resolvedModel &&
    (recoveryCheckpointForStep(runStepOptions)?.harness ??
      getExecutionHarnessForModel(resolvedModel)) !== 'claude'
  ) {
    return null;
  }
  // Resume continues an existing on-disk Claude session via `--resume`, so a
  // valid prior session id is required; without one, fall back to the SDK (whose
  // runner emits the canonical "session_id is required" error).
  const rawSessionId =
    isResume && typeof inputValues.session_id === 'string'
      ? inputValues.session_id.trim()
      : '';
  const resumeSessionId = rawSessionId.length > 0 ? rawSessionId : undefined;
  if (isResume && !resumeSessionId) {
    return null;
  }
  if (pluginCollectionRuntime.hasLocalClaudePlugins) {
    return null;
  }
  if (runStepOptions.signal.aborted) {
    return createStepResult({
      ...logMetadata,
      status: 'cancelled',
      conclusion: 'cancelled',
      outcome: 'cancelled',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      outputs: {},
      dynamic_env: {},
      log_file: logFile,
      agentTerminalMode: true,
    });
  }

  const schema = parseStructuredSchema(inputValues.structured_output_schema);
  const requestedMaxTurns = parseMaxTurns(inputValues.max_turns);
  const maxTurns = schema ? Math.max(requestedMaxTurns, 2) : requestedMaxTurns;
  const thinkingLevel = parseThinkingEffort(inputValues.thinking_effort);
  const settingSources = parseSettingSources(inputValues.setting_sources);
  const permissionPreset = parsePermissionPreset(inputValues.permission_preset);
  validateStructuredOutputInputs(permissionPreset, schema);
  const prompt = applyPlanPromptRequirement(
    await resolvePrompt({
      prompt: inputValues.prompt,
      promptFile: inputValues.prompt_file,
    }),
    permissionPreset,
  );
  const result = await runStepOptions.runtime.agentPromptWorker.runAgentPrompt({
    cwd: effectiveCwd,
    prompt,
    // Global Instructions (Instructions settings), pipelines section — terminal
    // worker mode composes the block here; subprocess mode composes it inside
    // the agent-prompt runner from INPUT_SYSTEM_PROMPT + the same env var.
    systemPrompt: isResume
      ? inputValues.system_prompt
      : appendPipelineLedgerInstructions(
          appendUserOverallPreferencesBlock(
            inputValues.system_prompt,
            buildPipelineGlobalInstructionsBlock(
              getBrandEnv(
                runStepOptions.env,
                'PREF_GLOBAL_INSTRUCTIONS_PIPELINES',
              ),
              {
                harness: resolvedModel
                  ? (getProviderForModel(resolvedModel) ?? 'claude')
                  : 'claude',
                model: resolvedModel ?? '',
              },
            ),
          ),
          ledgerAttempt,
        ),
    schema,
    resumeSessionId,
    model: resolvedModel,
    thinkingLevel,
    permission: mapWorkerPermission(permissionPreset, schema !== undefined),
    // Built-in presets do not constrain selected MCP servers. Keep those
    // calls under restrictive approval handling unless the pipeline author
    // explicitly selected the blanket dangerous_all posture.
    approvalMode: permissionPreset === 'dangerous_all' ? 'full-access' : 'auto',
    settingSources,
    maxTurns,
    mcpServers: pluginCollectionRuntime.mcpServers,
    // The worker terminal decides admission itself, in its own environment
    // (the step's decision read the Node step child's config folder). It
    // only runs with no local Claude plugins, so nothing selected is lost.
    claudeEnvOverride,
    ...(ledgerAttempt ? { ledgerAttemptKey: ledgerAttempt.attemptKey } : {}),
    aiCreditsRouteSessionId,
    projectId: runStepOptions.projectId,
    worktreeId: runStepOptions.worktreeId,
    executionId: runStepOptions.executionId,
    jobId: runStepOptions.jobId,
    stepId,
    attempt,
    childId: runStepOptions.childId,
    stepLabel: runStepOptions.step.name ?? stepId,
    signal: runStepOptions.signal,
    linkTarget: {
      page: 'pipelines',
      kind: 'pipeline-execution',
      projectId: runStepOptions.projectId,
      worktreeId: runStepOptions.worktreeId,
      pipelineExecutionId: runStepOptions.executionId,
    },
    onWorkerStarted: async (workerId) => {
      await runStepOptions.onRunningStepPatch?.(stepId, {
        workerId,
        agentTerminalMode: true,
        workerQueued: false,
      });
    },
    onWorkerQueued: async (workerId) => {
      await runStepOptions.onRunningStepPatch?.(stepId, {
        workerId,
        agentTerminalMode: true,
        workerQueued: true,
      });
    },
  });
  // The Claude in-process worker's `result.transcript` is itself
  // `JSON.stringify`'d JSONL built by `normalizeClaudeTerminalTranscriptToSdkJsonl`
  // / `serializeTranscript` upstream (`claude-worker-session-service.ts`),
  // exactly like the Codex/Cursor host-runner interceptors' transcript
  // lines — each line is a complete, whole `JSON.stringify` result (never a
  // partial line; `agent-prompt.test.ts` pins that for multi-line and
  // terminal-control text, and every failure path sends ''), so this matches against each string token's DECODED
  // value and splices the mask back in at that token's ORIGINAL serialized
  // offsets, rather than matching the raw serialized text; a
  // raw substring pass here (even one expanded with escaped variants) can
  // coincidentally match part of the JSON's own escape sequences or
  // structural delimiters and corrupt otherwise-valid JSON — see
  // `redactSerializedJsonLine`'s doc comment. `result.transcript` always
  // ends with exactly one trailing `\n` (see `serializeTranscript`), so the
  // final empty segment from splitting on `\n` is left untouched.
  const transcriptWorkerLines = result.transcript.split('\n');
  const redactedTranscript = transcriptWorkerLines
    .map((line, index) =>
      index === transcriptWorkerLines.length - 1 && line.length === 0
        ? line
        : redactSerializedJsonLine(line, secretValues),
    )
    .join('\n');
  const recovery = runStepOptions.recovery ?? 0;
  const workerOutputIdentity = {
    executionId: runStepOptions.executionId,
    jobId: runStepOptions.jobId,
    jobName: runStepOptions.jobName ?? runStepOptions.jobId,
    stepId,
    stepName: runStepOptions.step.name ?? stepId,
    attempt,
    iteration,
    ...(recovery > 0 ? { recovery } : {}),
  };
  if (result.status !== 'success') {
    invalidateStepLogGeneration(logFile);
    await fsp.writeFile(logFile, redactedTranscript, 'utf8');
    const logPosition = commitWholeStepLog(logFile, redactedTranscript);
    if (redactedTranscript.length > 0) {
      runStepOptions.onStepOutput?.({
        ...workerOutputIdentity,
        stream: 'stdout',
        data: redactedTranscript,
        logPosition,
      });
    }
    // Mirrors finishHostRunnerStep's redaction of the same two fields on the
    // Codex/Cursor host-runner path: result.failure.message and
    // classification.diagnostic_message are agent-authored text that can echo
    // a pipeline secret, and classifyAgentFailure only applies shape-based
    // redactSecrets() to the diagnostic message, which by design cannot catch
    // an arbitrary configured secret value.
    const redactedFailureMessage = redactWorkerSecretValues(
      result.failure.message,
      secretValues,
    );
    if (
      result.status === 'cancelled' &&
      !isShutdownSignal(runStepOptions.signal)
    ) {
      return createStepResult({
        ...logMetadata,
        status: 'cancelled',
        conclusion: 'cancelled',
        outcome: 'cancelled',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        error: redactedFailureMessage,
        log_file: logFile,
        agentTerminalMode: true,
        workerId: result.workerId,
      });
    }
    const metadataFile = path.join(tempDir, 'agent-failure.json');
    const redactedClassification = result.failure.classification
      ? {
          ...result.failure.classification,
          diagnostic_message: redactWorkerSecretValues(
            result.failure.classification.diagnostic_message,
            secretValues,
          ),
        }
      : undefined;
    const metadata = {
      ...result.failure,
      message: redactedFailureMessage,
      ...(redactedClassification
        ? { classification: redactedClassification }
        : {}),
      transcript_file: logFile,
    };
    await fsp.writeFile(
      metadataFile,
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    );
    const failedResult: CompletedProcessResult = {
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      exit_code: 1,
      error: redactedFailureMessage,
      outputs: {
        agent_failure_metadata_file: metadataFile,
        agent_failure_transcript_file: logFile,
      },
      dynamic_env: {},
      log_file: logFile,
    };
    const recoveryResult = await buildAgentRecoveryStepResult({
      result: failedResult,
      shutdown: isShutdownSignal(runStepOptions.signal),
      step: runStepOptions.step,
      tempDir,
      executionDir: path.join(
        runStepOptions.runtime.executionsDir,
        runStepOptions.executionId,
      ),
      attempt,
      iteration: runStepOptions.iteration ?? 1,
      jobId: runStepOptions.jobId,
      stepId,
      model: logMetadata.agent_model,
      childId: runStepOptions.childId,
      priorAgentActivity:
        recoveryCheckpointForStep(runStepOptions)?.had_agent_activity === true,
      accountProxyRouted: options.accountProxyRouted === true,
      accountProxyConnectionId: options.accountProxyConnectionId,
    });
    const publicOutputs = sanitizeAgentFailureOutputKeys(failedResult.outputs);
    return createStepResult({
      ...failedResult,
      ...(recoveryResult ?? {}),
      outputs: recoveryResult?.outputs ?? publicOutputs,
      ...logMetadata,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      agentTerminalMode: true,
      workerId: result.workerId,
    });
  }
  const redactedWorkerRawText = redactWorkerSecretValues(
    result.rawText,
    secretValues,
  );
  // The worker never streamed into this log, so replacing it with the whole
  // transcript starts a new generation.
  invalidateStepLogGeneration(logFile);
  const outputs = await writeWorkerAgentOutputs({
    tempDir,
    logFile,
    sessionId: result.sessionId,
    transcript: redactedTranscript,
    rawText: redactedWorkerRawText,
    // A multi-line secret echoed verbatim only exact-matches before
    // normalizing collapses its internal newlines, while a secret whose
    // internal whitespace the agent reformatted only exact-matches after
    // normalizing reconstitutes it. `redactNormalizedText` closes both in
    // one pass by matching the normalized text against the value list
    // expanded with each value's own normalized form, rather than
    // sequential redact passes that can leak when two configured values
    // share a whitespace-differing prefix/suffix (see its doc comment).
    textResponse: redactNormalizedText(result.rawText, secretValues),
    structured: redactWorkerStructuredValue(result.structured, secretValues),
    proposedPlan:
      result.proposedPlan === undefined
        ? undefined
        : redactWorkerSecretValues(result.proposedPlan, secretValues),
  });
  const transcriptPosition = commitWholeStepLog(logFile, redactedTranscript);
  if (redactedTranscript.length > 0) {
    runStepOptions.onStepOutput?.({
      ...workerOutputIdentity,
      stream: 'stdout',
      data: redactedTranscript,
      logPosition: transcriptPosition,
    });
  }
  if ((result.projectedMessages?.length ?? 0) > 0) {
    // `redactWorkerStructuredValue` already redacts every real leaf value
    // and key structurally, and `type` below is a fixed literal, never
    // agent-authored data — so nothing here can still carry an unredacted
    // secret. Do NOT run a second `redactWorkerSecretValues` pass over the
    // JSON.stringify'd result: a configured secret can be a literal
    // substring of the *serialized* text (spanning real leaf content and
    // JSON structural characters like a closing quote, comma, or key) without
    // being the value or key of any actual leaf, so a naive substring pass
    // here can corrupt the JSON's syntax or silently swallow a property that
    // was never actually a match — a transport-breaking bug, not a security
    // fix, since the structural pass has already covered every real leak
    // surface.
    const redactedProjectedMessages = redactWorkerStructuredValue(
      result.projectedMessages,
      secretValues,
    );
    // Emitted but never persisted, so it carries no log position.
    runStepOptions.onStepOutput?.({
      ...workerOutputIdentity,
      stream: 'stdout',
      data: `${JSON.stringify({
        type: 'claude_terminal_projected_messages',
        messages: redactedProjectedMessages,
      })}\n`,
    });
  }
  return createStepResult({
    ...logMetadata,
    status: 'success',
    conclusion: 'success',
    outcome: 'success',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    outputs,
    dynamic_env: {},
    log_file: logFile,
    agentTerminalMode: true,
    workerId: result.workerId,
  });
}

function resolveStepLogMetadata(
  step: NormalizedStep,
  action?: ResolvedActionRuntime,
  resolvedInputValues?: Record<string, string>,
  selectedModelOverride?: string,
  modelAliasName?: string,
  modelAliasPluginCollectionIds?: string[],
): StepLogMetadata {
  const logFormatHint =
    step.log_format_hint ?? action?.definition.log_format_hint;
  if (logFormatHint === undefined) {
    return {};
  }

  // Fan-out wrappers are counted as agent work by action ref, but emit an
  // aggregate report rather than a transcript, so they must not advertise
  // `agent` on the step result. See FANOUT_AGENT_ACTIONS.
  if (step.uses && FANOUT_AGENT_ACTIONS.has(step.uses)) {
    return {};
  }

  const metadata: StepLogMetadata = {
    log_format_hint: logFormatHint,
  };

  if (logFormatHint !== 'agent' || !step.uses || !action) {
    return metadata;
  }

  const inputValues = resolvedInputValues ?? resolveActionInputs(action, step);
  if (MODEL_AWARE_AGENT_ACTIONS.has(step.uses)) {
    const agentModel = resolveExplicitAgentModel(inputValues.model);
    if (agentModel !== undefined) {
      metadata.agent_model = selectedModelOverride ?? agentModel;
      if (selectedModelOverride && selectedModelOverride !== agentModel) {
        metadata.agent_runtime_model = agentModel;
      }
      const source = getModelSource(agentModel);
      metadata.agent_provider =
        source === 'ollama'
          ? 'ollama'
          : source === 'codex-managed'
            ? 'codex'
            : source === 'claude-managed'
              ? 'claude'
              : getProviderForModel(agentModel);
      const executionHarness = getExecutionHarnessForModel(agentModel);
      // Cursor is headless-capable through its own host runner
      // (`maybeRunAccountProviderPrompt`), unlike the chat-only harness
      // `requireHeadlessHarness` otherwise rejects.
      metadata.agent_harness =
        executionHarness === 'cursor' ||
        executionHarness === 'copilot' ||
        executionHarness === 'opencode' ||
        executionHarness === 'antigravity'
          ? executionHarness
          : requireHeadlessHarness(executionHarness);
      if (selectedModelOverride && modelAliasName) {
        metadata.model_alias = selectedModelOverride;
        metadata.model_alias_name = modelAliasName;
        if (modelAliasPluginCollectionIds?.length) {
          metadata.model_alias_plugin_collection_ids =
            modelAliasPluginCollectionIds;
        }
      }
    }
    if (metadata.agent_provider === 'codex' && inputValues.fast_mode?.trim()) {
      metadata.agent_model_config = {
        fastMode: parseBooleanInput(inputValues.fast_mode, 'fast_mode', false),
      };
    }
    return metadata;
  }

  if (CLAUDE_ONLY_AGENT_ACTIONS.has(step.uses)) {
    metadata.agent_provider = 'claude';
    metadata.agent_harness = 'claude';
  }

  return metadata;
}

async function resolveActionOllamaEnv(
  step: NormalizedStep,
  action: ResolvedActionRuntime | undefined,
  runtime: ExecutionRuntime,
  resolvedInputValues?: Record<string, string>,
  // Ollama only ever routes through the Claude harness; a Cursor-managed
  // captured harness (from a recovery checkpoint) falls through the
  // `harness !== 'claude'` guard below like any other non-Claude harness.
  capturedHarness?: ModelHarness,
): Promise<Record<string, string>> {
  if (!action || !step.uses || !MODEL_AWARE_AGENT_ACTIONS.has(step.uses)) {
    return {};
  }

  const inputValues = resolvedInputValues ?? resolveActionInputs(action, step);
  const agentModel = resolveExplicitAgentModel(inputValues.model);
  if (!agentModel || getModelSource(agentModel) !== 'ollama') {
    return {};
  }
  const harness = capturedHarness ?? getExecutionHarnessForModel(agentModel);
  if (harness !== 'claude') {
    return {};
  }

  if (runtime.resolveModelHarnessInvocation) {
    const invocation = await runtime.resolveModelHarnessInvocation(agentModel, {
      harness,
    });
    return invocation.envOverride ?? {};
  }

  const resolveInvocation =
    runtime.resolveClaudeCompatibleInvocation ??
    resolveSharedClaudeCompatibleInvocation;
  const invocation = await resolveInvocation(agentModel, {
    ensureRunningReason: 'pipeline',
    assertInstalled: true,
  });
  return invocation.envOverride ?? {};
}

/**
 * Pure builder that turns a resolved AI Credits routing override into the
 * subprocess env layer + secret values. Kept separate from the async action
 * resolution so it is directly unit-testable (mirrors `applyClaudeMockPipelineEnv`).
 *
 * The returned `env` MUST be merged *after* `buildSafeProcessEnv()` so direct
 * gateway credentials and broker auth placeholders survive the sensitive-key
 * sanitizer. It carries the proxy env, a brand-managed model-override var, and
 * — for Codex — the provider-config JSON the action subprocess parses back.
 * `secretValues` carries any value-bearing direct credentials for log redaction;
 * parent-brokered terminal workers receive no reusable account credential.
 */
export function buildAiCreditsActionEnv(
  override: PipelineAiCreditsRoutingOverride,
): { env: Record<string, string>; secretValues: string[] } {
  const env: Record<string, string> = { ...override.env };
  setBrandEnv(env, 'AI_CREDITS_MODEL', override.model);
  if (override.provider === 'codex' && override.codexConfig) {
    setBrandEnv(
      env,
      'AI_CREDITS_CODEX_CONFIG',
      JSON.stringify(override.codexConfig),
    );
  }
  return { env, secretValues: getSecretValues(override.env) };
}

/**
 * Triggers that run with no user present, so a step must not spend AI Credits
 * merely because there is no native login (ECW-9091 review round 7). Everything
 * else — including an unset source — keeps the interactive default, so a
 * credits-only user running a pipeline by hand is unaffected.
 */
const UNATTENDED_INITIATION_SOURCES: ReadonlySet<string> = new Set([
  'automation',
  'hook',
]);

/**
 * Build the per-step AI Credits routing context: which workspace's Environments
 * apply, whether this trigger may fall back to credits without a native login,
 * and the parent-owned route that must be revoked when the provider invocation
 * settles.
 */
function buildStepAiCreditsRoutingContext(
  options: RunStepOptions,
): PipelineAiCreditsRoutingContext {
  const routeSessionId = `pipeline:${options.executionId}:${options.jobId}${options.childId ? `:${options.childId}` : ''}:${options.step.id}:${options.attempt ?? 1}:${options.iteration ?? 1}:${options.recovery ?? 0}`;
  return {
    ...(options.projectId !== undefined
      ? { workspaceId: options.projectId }
      : {}),
    ...(options.worktreeId !== undefined
      ? { worktreeId: options.worktreeId }
      : {}),
    allowNoNativeAuthFallback: !(
      options.initiationSource !== undefined &&
      UNATTENDED_INITIATION_SOURCES.has(options.initiationSource)
    ),
    routeSessionId,
    signal: options.signal,
    ...(options.step.uses && MODEL_AWARE_AGENT_ACTIONS.has(options.step.uses)
      ? { checkpointProxyQuota: true }
      : {}),
    ...(recoveryCheckpointForStep(options)?.account_proxy_connection_id
      ? {
          requiredAccountProxyConnectionId:
            recoveryCheckpointForStep(options)?.account_proxy_connection_id,
        }
      : {}),
    ...(options.executionContext !== undefined
      ? { executionContext: options.executionContext }
      : {}),
  };
}

/**
 * Resolve gateway routing for every bundled provider-backed action step.
 * Returns empty when routing does not apply (native path), the runtime has no
 * routing bridge (tests/headless), or the step is not provider-backed;
 * otherwise delegates to {@link buildAiCreditsActionEnv}.
 *
 * Exported only for direct unit testing (mirrors `resolvePipelineModelInputs`
 * below) — every production call site still goes through the one call in
 * `runStep`.
 */
export async function resolveActionAiCreditsEnv(
  step: NormalizedStep,
  action: ResolvedActionRuntime | undefined,
  runtime: ExecutionRuntime,
  resolvedInputValues?: Record<string, string>,
  context?: PipelineAiCreditsRoutingContext,
  capturedHarness?: 'claude' | 'codex',
  routingProbe?: ModelPolicyProbe,
): Promise<{
  env: Record<string, string>;
  secretValues: string[];
  routed: boolean;
  modelGatewayRouted: boolean;
  /** The step owns an account proxy route, released like an AI Credits one. */
  accountProxyRouted: boolean;
  accountProxyConnectionId?: string;
  model?: string;
  modelInput?: string;
}> {
  const empty: {
    env: Record<string, string>;
    secretValues: string[];
    routed: boolean;
    modelGatewayRouted: boolean;
    accountProxyRouted: boolean;
  } = {
    env: {},
    secretValues: [],
    routed: false,
    modelGatewayRouted: false,
    accountProxyRouted: false,
  };
  if (!action || !step.uses) {
    return empty;
  }
  const modelAware = MODEL_AWARE_AGENT_ACTIONS.has(step.uses);
  const directClaude = DIRECT_CLAUDE_PROVIDER_ACTIONS.has(step.uses);
  if (!modelAware && !directClaude) return empty;

  const inputValues = resolvedInputValues ?? resolveActionInputs(action, step);
  const agentModel =
    routingProbe?.probeModel ?? resolveExplicitAgentModel(inputValues.model);
  const gatewayOnly = agentModel ? isGatewayOnlyModel(agentModel) : false;
  const modelHarness = agentModel
    ? getExecutionHarnessForModel(agentModel)
    : undefined;
  // Both non-Claude harnesses, not just Codex. The `codex` half is pre-existing;
  // `cursor` was missing, so a direct-Claude action authored with a Cursor model
  // handed that model straight to the Claude SDK and failed downstream with
  // whatever the SDK made of an unknown name. The design doc credited
  // `getModelProviderInput` with guarding these actions, but that helper has
  // exactly one caller (`agent-prompt/runner.ts`), which the executor
  // intercepts first — so nothing was guarding them.
  if (
    directClaude &&
    (modelHarness === 'codex' ||
      modelHarness === 'cursor' ||
      modelHarness === 'copilot' ||
      modelHarness === 'opencode' ||
      modelHarness === 'antigravity')
  ) {
    const harnessLabel =
      modelHarness === 'codex'
        ? 'Codex'
        : modelHarness === 'antigravity'
          ? 'Google'
          : modelHarness === 'opencode'
            ? 'OpenCode'
            : modelHarness === 'copilot'
              ? 'Copilot'
              : 'Cursor';
    throw new Error(
      `Action "${step.uses}" runs directly on the Claude harness and cannot use the ${harnessLabel}-harness model "${agentModel}". Choose a Claude-harness model for this action.`,
    );
  }
  if (!runtime.resolveAiCreditsRouting) {
    if (gatewayOnly) {
      throw new Error(
        `Model "${agentModel}" requires AI Credits, but this runtime cannot route AI Credits requests.`,
      );
    }
    return empty;
  }
  const provider = directClaude
    ? 'claude'
    : (capturedHarness ??
      modelHarness ??
      (routingProbe?.source === 'provider-default' ? 'claude' : undefined));
  if (!provider) {
    return empty;
  }
  // Cursor bills only through the user's own Cursor account; there is no
  // AI-credits routing concept for it. Every other call site already keeps
  // 'cursor' out of `capturedHarness` (see :3809/:4579/:4703), but `provider`
  // can still resolve to 'cursor' via `modelHarness`/`routingProbe` here, and
  // `requireHeadlessHarness` throws for 'cursor' — treat it as "no routing"
  // instead, matching those call sites' cursor handling.
  if (
    provider === 'cursor' ||
    provider === 'copilot' ||
    provider === 'antigravity' ||
    provider === 'opencode'
  ) {
    return empty;
  }
  const override = await runtime.resolveAiCreditsRouting(
    agentModel,
    requireHeadlessHarness(provider),
    context,
  );
  if (!override) {
    if (gatewayOnly) {
      throw new Error(
        `Model "${agentModel}" requires AI Credits, but no usable AI Credits route is available.`,
      );
    }
    return empty;
  }
  if (override.accountProxyRouted) {
    // The proxy serves the model the step asked for; nothing here is AI
    // Credits, so the step keeps its native model and thinking levels.
    return {
      ...empty,
      env: { ...override.env },
      secretValues: getSecretValues(override.env),
      accountProxyRouted: true,
      accountProxyConnectionId: override.accountProxyConnectionId,
    };
  }
  const resolved = buildAiCreditsActionEnv(override);
  const routeThinkingLevels = getConfiguredSupportedThinkingLevelsMap();
  const effectiveModel = agentModel ?? override.model;
  routeThinkingLevels[effectiveModel] = [
    ...getEffectiveSupportedThinkingLevelsForModel(
      effectiveModel,
      true,
      provider,
    ),
  ];
  setBrandEnv(
    resolved.env,
    'MODEL_THINKING_LEVELS',
    JSON.stringify(routeThinkingLevels),
  );
  return {
    ...resolved,
    routed: true,
    modelGatewayRouted: override.modelGatewayRouted === true,
    accountProxyRouted: false,
    model: override.model,
    ...(directClaude && routingProbe ? { modelInput: routingProbe.input } : {}),
  };
}

function buildModelAliasDiagnosticEnv(
  resolvedInputs: ResolvedPipelineModelInputs,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (resolvedInputs.selectedModel) {
    setBrandEnv(env, 'PIPELINE_SELECTED_MODEL', resolvedInputs.selectedModel);
  }
  if (resolvedInputs.runtimeModel) {
    setBrandEnv(env, 'PIPELINE_RUNTIME_MODEL', resolvedInputs.runtimeModel);
  }
  if (resolvedInputs.aliasId) {
    setBrandEnv(env, 'PIPELINE_MODEL_ALIAS', resolvedInputs.aliasId);
  }
  if (resolvedInputs.aliasPluginCollectionIds.length > 0) {
    setBrandEnv(
      env,
      'PIPELINE_MODEL_ALIAS_PLUGIN_COLLECTION_IDS',
      resolvedInputs.aliasPluginCollectionIds.join(','),
    );
  }
  return env;
}

async function runCompositeAction(
  action: ResolvedActionRuntime,
  options: RunStepOptions & {
    resolvedCwd: string;
    logFile: string;
    outputFile: string;
    envFile: string;
    logMetadata: StepLogMetadata;
  },
): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const inputValues = resolveActionInputs(action, options.step);
  const compositeRuns = action.definition.runs;
  if (compositeRuns.using !== 'composite') {
    throw new Error(`Action "${options.step.uses}" is not composite`);
  }
  const compositeEnv = cascadeEnv(options.env, inputsToEnv(inputValues), {
    ...buildStepManagedEnv({
      ACTION_PATH: action.actionDir,
      OUTPUT: options.outputFile,
      ENV: options.envFile,
    }),
    ...buildBundledBinaryEnv(),
    ...buildExecutionMetadataEnv(options),
    ...getRtkManagedEnv(),
  });

  const normalizedSteps = normalizeCompositeSteps(
    options.step,
    compositeRuns.steps,
  );
  const stepContext: Record<
    string,
    { outputs: Record<string, string>; outcome?: string; conclusion?: string }
  > = {};
  const dynamicEnv: Record<string, string> = {};

  const buildCompositeOutputs = (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(action.definition.outputs ?? {}).map(([name, output]) => [
        name,
        output.value
          ? interpolateExpression(
              output.value,
              buildExpressionContext({
                env: cascadeEnv(compositeEnv, dynamicEnv),
                inputs: inputValues,
                steps: stepContext,
                job: options.jobContext,
                canopy: options.canopy,
                assets: buildExpressionAssets(
                  options.pipelineAssets?.asset_paths,
                ),
              }),
            )
          : '',
      ]),
    );

  for (const nestedStep of normalizedSteps) {
    const expressionContext = buildExpressionContext({
      env: cascadeEnv(compositeEnv, dynamicEnv),
      inputs: inputValues,
      steps: stepContext,
      job: options.jobContext,
      canopy: options.canopy,
      assets: buildExpressionAssets(options.pipelineAssets?.asset_paths),
    });

    const shouldRun = evaluateCondition(nestedStep.if, expressionContext, {
      success: () =>
        Object.values(stepContext).every((step) => step.outcome !== 'failure'),
      failure: () =>
        Object.values(stepContext).some((step) => step.outcome === 'failure'),
      cancelled: () =>
        options.signal.aborted ||
        Object.values(stepContext).some(
          (step) => step.conclusion === 'cancelled',
        ),
      always: () => true,
    });

    if (!shouldRun) {
      stepContext[nestedStep.id] = {
        outputs: {},
        outcome: 'skipped',
        conclusion: 'skipped',
      };
      await fsp.appendFile(
        options.logFile,
        `[skip] ${nestedStep.id}\n`,
        'utf8',
      );
      continue;
    }

    const resolvedNestedStep = interpolateNormalizedStep(
      nestedStep,
      expressionContext,
    );

    await fsp.appendFile(options.logFile, `[run] ${nestedStep.id}\n`, 'utf8');
    const nestedResult = await runStep({
      ...options,
      step: resolvedNestedStep,
      env: cascadeEnv(compositeEnv, dynamicEnv, resolvedNestedStep.env),
      parentStepId: `${options.step.id}/${nestedStep.id}`,
      depth: (options.depth ?? 0) + 1,
      jobContext: options.jobContext,
    });

    stepContext[nestedStep.id] = {
      outputs: nestedResult.outputs,
      outcome: nestedResult.outcome,
      conclusion: nestedResult.conclusion,
    };
    Object.assign(dynamicEnv, nestedResult.dynamic_env);

    if (nestedResult.status === 'paused') {
      const agentRecovery = nestedResult.agent_recovery
        ? {
            ...nestedResult.agent_recovery,
            had_agent_activity: false,
            strategy: 'restart_step' as const,
          }
        : undefined;
      if (agentRecovery) delete agentRecovery.session_id;
      const pauseReason = nestedResult.pause_reason
        ? {
            ...nestedResult.pause_reason,
            source: {
              ...nestedResult.pause_reason.source,
              step_id: options.step.id,
            },
          }
        : undefined;
      return createStepResult({
        ...nestedResult,
        ...options.logMetadata,
        status: 'paused',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        outputs: buildCompositeOutputs(),
        dynamic_env: dynamicEnv,
        log_file: options.logFile,
        pause_reason: pauseReason,
        pause_reasons: pauseReason ? [pauseReason] : undefined,
        agent_recovery: agentRecovery,
      });
    }

    if (nestedResult.conclusion === 'cancelled') {
      return createStepResult({
        ...options.logMetadata,
        status: 'cancelled',
        conclusion: 'cancelled',
        outcome: 'cancelled',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        outputs: buildCompositeOutputs(),
        dynamic_env: dynamicEnv,
        log_file: options.logFile,
      });
    }

    if (nestedResult.outcome === 'failure' && !nestedStep.continue_on_error) {
      return createStepResult({
        ...options.logMetadata,
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        outputs: buildCompositeOutputs(),
        dynamic_env: dynamicEnv,
        error: nestedResult.error,
        log_file: options.logFile,
      });
    }

    if (
      nestedResult.conclusion === 'success' &&
      stepRequestedPause(nestedResult.outputs)
    ) {
      const inputRequestResult = extractInputRequest(nestedResult.outputs);
      const sanitizedOutputs = sanitizePauseControlOutputKeys(
        nestedResult.outputs,
      );
      stepContext[nestedStep.id] = {
        outputs: sanitizedOutputs,
        outcome: nestedResult.outcome,
        conclusion: nestedResult.conclusion,
      };

      if (inputRequestResult && 'error' in inputRequestResult) {
        return createStepResult({
          ...options.logMetadata,
          status: 'failure',
          conclusion: 'failure',
          outcome: 'failure',
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          outputs: buildCompositeOutputs(),
          dynamic_env: dynamicEnv,
          error: inputRequestResult.error,
          log_file: options.logFile,
        });
      }

      return createStepResult({
        ...options.logMetadata,
        status: 'success',
        conclusion: 'success',
        outcome: 'success',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        outputs: {
          ...buildCompositeOutputs(),
          [PAUSE_OUTPUT_KEY]: 'true',
          ...(inputRequestResult
            ? {
                [INPUT_REQUEST_OUTPUT_KEY]: JSON.stringify(
                  inputRequestResult.request,
                ),
              }
            : {}),
        },
        dynamic_env: dynamicEnv,
        log_file: options.logFile,
      });
    }

    if (
      nestedResult.conclusion === 'success' &&
      stepRequestedRestart(nestedResult.outputs)
    ) {
      const sanitizedOutputs = sanitizeRestartOutputKeys(nestedResult.outputs);
      stepContext[nestedStep.id] = {
        outputs: sanitizedOutputs,
        outcome: nestedResult.outcome,
        conclusion: nestedResult.conclusion,
      };

      return createStepResult({
        ...options.logMetadata,
        status: 'success',
        conclusion: 'success',
        outcome: 'success',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        outputs: {
          ...buildCompositeOutputs(),
          [JOB_RESTART_OUTPUT_KEY]: 'true',
        },
        dynamic_env: dynamicEnv,
        log_file: options.logFile,
      });
    }
  }

  const outputs = buildCompositeOutputs();

  return createStepResult({
    ...options.logMetadata,
    status: 'success',
    conclusion: 'success',
    outcome: 'success',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    outputs,
    dynamic_env: dynamicEnv,
    log_file: options.logFile,
  });
}

/** A step's open Ledger attempt, shared by `runStep` and its body. */
interface StepLedgerState {
  attempt: PipelineLedgerAttempt | null;
}

export async function runStep(options: RunStepOptions): Promise<StepResult> {
  const ledger: StepLedgerState = { attempt: null };
  let result: StepResult | undefined;
  try {
    result = await runStepBody(options, ledger);
    // The attempt's session is recorded, so resuming its checkpoint keeps it.
    return ledger.attempt === null
      ? result
      : { ...result, ledger_agent_session_id: ledger.attempt.agentSessionId };
  } finally {
    // The attempt's route and binding end with its run. A pause revokes them
    // as well; only resuming the same checkpoint opens them again.
    ledger.attempt?.close(pipelineLedgerAttemptOutcome(result));
  }
}

/**
 * Opens the Agent Ledger tools of an agent step's attempt when the host
 * exposes them: one of the five agent actions, on a route with tool support,
 * with a host Ledger route, recording to its task or its owner's global
 * Ledger. Null otherwise (`resolvePipelineLedgerAgent` names why), and then
 * the step runs exactly as it would without the Ledger.
 */
async function openStepLedgerAttempt(
  options: RunStepOptions,
  facts: {
    logMetadata: StepLogMetadata;
    inputValues: Record<string, string>;
    recoveryCheckpoint: AgentRecoveryCheckpoint | undefined;
    stepId: string;
    attempt: number;
    iteration: number;
  },
): Promise<PipelineLedgerAttempt | null> {
  const port = options.runtime.pipelineLedger;
  const { projectId, worktreeId } = options;
  const target = resolvePipelineLedgerTarget({
    projectId,
    worktreeId,
    executionContext: options.executionContext,
  });
  const model =
    facts.logMetadata.agent_model ??
    resolveExplicitAgentModel(facts.inputValues.model);
  const agent = resolvePipelineLedgerAgent({
    uses: options.step.uses,
    harness: facts.logMetadata.agent_harness,
    provider: facts.logMetadata.agent_provider,
    model,
    permissionPresetInput: facts.inputValues.permission_preset,
    hostRoute: port !== undefined,
    target,
  });
  if (agent.kind === 'excluded' || port === undefined || target === undefined) {
    return null;
  }
  const checkpoint = facts.recoveryCheckpoint;
  const identity = pipelineLedgerAttemptIdentity({
    resumedAgentSessionId:
      checkpoint === undefined ? undefined : options.ledgerAgentSessionId,
    checkpoint,
    predecessorAgentSessionId:
      checkpoint === undefined
        ? options.ledgerPredecessorAgentSessionId
        : undefined,
  });
  const thinkingEffort = facts.inputValues.thinking_effort?.trim();
  // The agent can echo a configured secret into an entry; the host masks it.
  const secretValues = getSecretValues(options.secretEnv);
  const attempt = await openPipelineLedgerAttempt(port, {
    executionId: options.executionId,
    ...(options.pipelineId ? { pipelineId: options.pipelineId } : {}),
    ...(options.pipelineName ? { pipelineName: options.pipelineName } : {}),
    target,
    ...(projectId ? { projectId } : {}),
    ...(worktreeId ? { worktreeId } : {}),
    physicalJobId: options.childId
      ? `${options.jobId}:${options.childId}`
      : options.jobId,
    logicalJobId: options.logicalJobId ?? options.jobId,
    jobName: options.jobName ?? options.jobId,
    stepId: facts.stepId,
    stepName: options.step.name ?? facts.stepId,
    // The job's retry count is zero-based; Ledger attempts start at 1.
    attempt: facts.attempt + 1,
    iteration: facts.iteration,
    ...identity,
    harness: agent.harness,
    ...(model ? { model } : {}),
    ...(thinkingEffort ? { thinkingEffort } : {}),
    permissionPreset: agent.permissionPreset,
    ...(secretValues.length > 0 ? { secretValues } : {}),
  });
  if (attempt === null) return null;
  // Saved with the running step, so a checkpoint rebuilt after a crash keeps
  // the session. A composite's nested steps share the parent's record.
  if (!options.parentStepId) {
    await options
      .onRunningStepPatch?.(facts.stepId, {
        ledger_agent_session_id: attempt.agentSessionId,
      })
      .catch((): void => undefined);
  }
  return attempt;
}

/**
 * The attempt's route for a Claude action subprocess, with the Ledger block
 * for its queries. Undefined when there is no attempt or the route cannot be
 * registered; the step then runs without Ledger tools.
 */
async function openLedgerSubprocessTools(
  attempt: PipelineLedgerAttempt | null,
  cwd: string,
): Promise<
  | (PipelineLedgerSubprocessTools & { readonly instructions: string })
  | undefined
> {
  if (attempt === null) return undefined;
  try {
    const tools = await attempt.openSubprocessTools(cwd);
    return { ...tools, instructions: attempt.instructions };
  } catch {
    return undefined;
  }
}

/**
 * The runtime a step's action actually uses. A bundled host action with a
 * Node fallback runs as `node` when the runtime's host port doesn't take it:
 * there is no port, or the port doesn't declare the action (CAN-6082). With
 * a port that takes it, or without a fallback, it stays `host`.
 */
function effectiveRunsUsing(
  action: ResolvedActionRuntime,
  runtime: Pick<ExecutionRuntime, 'pipelineHostActions' | 'bundledActionsDir'>,
): ActionRuns['using'] {
  const runs = action.definition.runs;
  if (
    runs.using === 'host' &&
    runs.fallback !== undefined &&
    !hostPortTakesAction(action, runtime)
  ) {
    return runs.fallback.using;
  }
  return runs.using;
}

async function runStepBody(
  options: RunStepOptions,
  ledger: StepLedgerState,
): Promise<StepResult> {
  const currentDepth = options.depth ?? 0;
  if (currentDepth >= MAX_NESTED_STEP_DEPTH) {
    return createStepResult({
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      error: `Nested workflow or composite action depth exceeds maximum depth of ${MAX_NESTED_STEP_DEPTH}`,
    });
  }

  const startedAt = new Date().toISOString();
  const effectiveCwd = options.step.working_directory
    ? path.resolve(options.cwd, options.step.working_directory)
    : options.cwd;

  if (
    path.isAbsolute(options.step.working_directory ?? '') ||
    !isPathInside(options.cwd, effectiveCwd)
  ) {
    return createStepResult({
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      error: `Invalid working_directory "${options.step.working_directory}"`,
    });
  }

  const stepId = options.parentStepId ?? options.step.id;
  const recoveryCheckpoint = recoveryCheckpointForStep(options);
  const attempt = options.attempt ?? 0;
  const iteration = options.iteration ?? 1;
  const recovery = options.recovery ?? 0;
  /**
   * Positions the spawned-process writers' chunks. Both hosts write each chunk
   * to the log and emit exactly those bytes, in order, through `onOutput`
   * (the utility host batches only contiguous same-stream chunks), so offsets
   * are the base plus the bytes emitted so far. Opened right before the process
   * starts, after every unemitted setup line was appended.
   */
  let spawnedLogPositions: StepLogPositionCursor | undefined;
  const onOutput = options.onStepOutput
    ? (stream: StepOutputEvent['stream'], data: string): void => {
        const logPosition = spawnedLogPositions?.claim(data);
        options.onStepOutput?.({
          executionId: options.executionId,
          jobId: options.jobId,
          jobName: options.jobName ?? options.jobId,
          stepId,
          stepName: options.step.name ?? stepId,
          attempt,
          iteration,
          recovery: recovery || undefined,
          stream,
          data,
          ...(logPosition ? { logPosition } : {}),
        });
      }
    : undefined;
  const [{ tempDir, outputFile, envFile }, logFile] = await Promise.all([
    createProcessFiles(
      options.runtime,
      options.executionId,
      options.jobId,
      stepId,
    ),
    ensureLogFile(
      options.runtime,
      options.executionId,
      options.jobId,
      stepId,
      attempt,
      iteration,
      recovery,
      options.childId,
    ),
  ]);
  let logMetadata: StepLogMetadata = {};

  try {
    if (options.step.run) {
      const processSpec = await buildRunProcessSpec(
        options.step,
        tempDir,
        options.runtime,
      );
      if (onOutput) {
        spawnedLogPositions = await openAppendingStepLogCursor(logFile);
      }
      options.onProcessStart?.();
      const result = await runSpawnedProcess(processSpec, {
        cwd: effectiveCwd,
        env: {
          ...buildSafeProcessEnv(options.runtime.processEnvironment),
          ...options.secretEnv,
          ...options.env,
          ...buildStepManagedEnv({
            OUTPUT: outputFile,
            ENV: envFile,
            LOG_FILE: logFile,
          }),
          ...buildBundledBinaryEnv(),
          ...buildExecutionMetadataEnv(options),
          ...getRtkManagedEnv(),
        },
        runtime: options.runtime,
        signal: options.signal,
        timeout_minutes: options.step.timeout_minutes,
        logFile,
        outputFile,
        envFile,
        secretValues: getSecretValues(options.secretEnv),
        onOutput,
        resource: {
          executionId: options.executionId,
          pipelineId: options.pipelineId,
          pipelineName: options.pipelineName,
          jobId: options.jobId,
          stepId,
          attempt,
          iteration,
          childId: options.childId,
          label: `${options.jobId} / ${stepId}`,
        },
      });

      const postProcessedResult = await postProcessSpawnedResult(
        result,
        options,
      );

      return createStepResult({
        ...postProcessedResult,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        resolved_run: options.step.run,
      });
    }

    const action = resolveActionRuntime(
      options.step.uses ?? '',
      options.runtime,
      options.repoPath,
      options.pipelinePackageOverlay,
    );
    if (!action) {
      logMetadata = resolveStepLogMetadata(options.step, action ?? undefined);
      if (
        options.onLogMetadataResolved &&
        Object.keys(logMetadata).length > 0
      ) {
        await options.onLogMetadataResolved(logMetadata);
      }
      return createStepResult({
        ...logMetadata,
        status: options.step.skip_on_missing_action ? 'skipped' : 'failure',
        conclusion: options.step.skip_on_missing_action ? 'skipped' : 'failure',
        outcome: options.step.skip_on_missing_action ? 'skipped' : 'failure',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        error: options.step.skip_on_missing_action
          ? undefined
          : `Unable to resolve action "${options.step.uses}"`,
        log_file: logFile,
      });
    }

    const rawInputValues = resolveActionInputs(action, options.step);
    let resolvedAgentInputs = await resolvePipelineModelInputs({
      step: options.step,
      inputValues: rawInputValues,
      modelAliases: options.modelAliases,
      modelAliasPreferences: options.modelAliasPreferences,
      runtime: options.runtime,
      scope: {
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
      },
    });
    // Gate on the model the step will ACTUALLY run on, not just on the two
    // alias-resolving agent actions, and not just on an input named `model`.
    //
    // Only `MODEL_AWARE_AGENT_ACTIONS` get pipeline alias resolution, but many
    // other builtin actions (`quality-gate`, `router`, `condenser`,
    // `plan-with-review`, `agent-loop`, `parallel-agents`, ...) declare a
    // `model` input and hand it straight to the provider SDK, and two more
    // (`git-commit-push`, `github-create-pr`) name theirs `commit_model` /
    // `pr_model`. `collectModelPolicyProbes` covers every declared key.
    //
    // Probes that pass are pinned back into the inputs so the id the gate
    // checked is the id that runs. Every pin is gated on
    // `runtime.isOrgModelPolicyActive()`, and applies to:
    //  - keys whose effective value is reproduced from the action runner's own
    //  `INPUT_* ?? PREF_* ?? default` chain (`commit_model`, `pr_model`),
    //  closing the drift between the id the gate resolved and the id the
    //  subprocess would recompute from a different env; and
    //  - the `provider-default` probe (`DEFAULT_CLAUDE_MODEL`). Unpinned, that
    //  probe is only a guess at what the provider would pick; if the provider
    //  default drifts to a newer id, that id is unreviewed by construction
    //  (the snapshot is an allowlist frozen at last save) and the step would
    //  run on it behind a passing check.
    // With no policy active nothing is ever pinned, so an unpoliced run is
    // byte-identical to its pre-gate behavior.
    const policyProbes = await collectModelPolicyProbes({
      action,
      uses: options.step.uses,
      rawInputValues,
      resolved: resolvedAgentInputs,
      env: options.env,
      modelAliases: options.modelAliases,
      modelAliasPreferences: options.modelAliasPreferences,
      runtime: options.runtime,
      scope: {
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
        ...(options.executionContext
          ? { executionContext: options.executionContext }
          : {}),
      },
    });
    for (const probe of policyProbes) {
      if (
        !(await options.runtime.isModelBlockedByOrgPolicy(probe.probeModel, {
          ...(options.projectId ? { projectId: options.projectId } : {}),
          ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
          ...(options.executionContext
            ? { executionContext: options.executionContext }
            : {}),
        }))
      ) {
        continue;
      }
      options.runtime.recordModelPolicyRefusal?.({
        executionId: options.executionId,
        jobId: options.jobId,
        stepId: options.step.id,
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
        modelId: probe.probeModel,
      });
      throw new Error(
        probe.source === 'step'
          ? `Model "${probe.displayModel}" is blocked by your organization policy.`
          : probe.source === 'action-default'
            ? `Step "${options.step.id}" does not specify "${probe.input}", and your organization has not approved "${probe.displayModel}", the model action "${options.step.uses}" falls back to. Set an explicit "${probe.input}" input for this step.`
            : `Step "${options.step.id}" does not specify a model, and your organization has not approved the default model "${DEFAULT_CLAUDE_MODEL}". Set an explicit "${probe.input}" input for this step.`,
      );
    }
    const pinnedModelInputs: Record<string, string> = {};
    for (const probe of policyProbes) {
      if (probe.pin) {
        pinnedModelInputs[probe.input] = probe.probeModel;
      }
    }
    if (Object.keys(pinnedModelInputs).length > 0) {
      resolvedAgentInputs = {
        ...resolvedAgentInputs,
        inputValues: {
          ...resolvedAgentInputs.inputValues,
          ...pinnedModelInputs,
        },
      };
    }
    logMetadata = resolveStepLogMetadata(
      options.step,
      action,
      resolvedAgentInputs.inputValues,
      resolvedAgentInputs.selectedModel,
      resolvedAgentInputs.aliasName,
      resolvedAgentInputs.aliasPluginCollectionIds,
    );
    if (resolvedAgentInputs.agentId) {
      logMetadata.agent_model_config = {
        ...mergeAgentModelConfig(
          options.modelConfig,
          logMetadata.agent_model_config ?? {},
        ),
        agentId: resolvedAgentInputs.agentId,
        baseModel: resolvedAgentInputs.runtimeModel,
      };
    }
    if (recoveryCheckpoint?.harness && logMetadata.agent_model) {
      logMetadata.agent_harness =
        recoveryCheckpoint.harness === 'cursor' ||
        recoveryCheckpoint.harness === 'copilot' ||
        recoveryCheckpoint.harness === 'opencode' ||
        recoveryCheckpoint.harness === 'antigravity'
          ? recoveryCheckpoint.harness
          : requireHeadlessHarness(recoveryCheckpoint.harness);
    }

    if (options.onLogMetadataResolved && Object.keys(logMetadata).length > 0) {
      await options.onLogMetadataResolved(logMetadata);
    }

    const effectiveScope =
      options.scope ??
      inferExecutionScope({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
      });
    if (!executionContextSatisfies(action.definition.scopes, effectiveScope)) {
      throw new Error(
        `Step "${options.step.id}" in job "${options.jobId}" uses action "${options.step.uses}" which does not support execution scope "${effectiveScope}"`,
      );
    }

    const runsUsing = effectiveRunsUsing(action, options.runtime);

    if (options.step.target && runsUsing !== 'pipeline') {
      throw new Error(
        `Step "${options.step.id}" in job "${options.jobId}" defines target but action "${options.step.uses}" is not a workflow action`,
      );
    }

    if (runsUsing === 'composite') {
      return await runCompositeAction(action, {
        ...options,
        resolvedCwd: effectiveCwd,
        logFile,
        outputFile,
        envFile,
        logMetadata,
      });
    }

    if (runsUsing === 'pipeline') {
      return await runNestedPipelineAction(action, {
        ...options,
        resolvedCwd: effectiveCwd,
        logFile,
        logMetadata,
      });
    }

    // Once taken, the host path is final: a refusal or error never falls back.
    if (runsUsing === 'host') {
      return await runHostAction(action, {
        step: options.step,
        runtime: options.runtime,
        signal: options.signal,
        executionId: options.executionId,
        jobId: options.jobId,
        stepId,
        attempt,
        iteration,
        childId: options.childId,
        pipelineId: options.pipelineId,
        pipelineName: options.pipelineName,
        executionContext: options.executionContext,
        initiationSource: options.initiationSource,
        agentOrigin: options.agentOrigin,
        initiator: options.initiator,
        cwd: effectiveCwd,
        resolveModel: async (value) => {
          const route = resolveHostStepModel({
            value,
            modelAliases: options.modelAliases,
            modelAliasPreferences: options.modelAliasPreferences,
          });
          const alias = options.modelAliases?.find(
            (candidate) => candidate.id === value,
          );
          const defaults = alias
            ? (preferenceToDefaults(
                options.modelAliasPreferences?.[alias.id],
              ) ?? alias.defaults)
            : undefined;
          if (alias && defaults && 'agent_id' in defaults) {
            const parsed = parseAgentRouteModelId(route);
            logMetadata.model_alias = alias.id;
            logMetadata.model_alias_name = alias.name;
            const parsedSend = parseSendAgentMessageInputs(rawInputValues);
            const settings = parsedSend.ok ? parsedSend.value.settings : {};
            logMetadata.agent_model_config = {
              ...mergeAgentModelConfig(options.modelConfig, {
                ...logMetadata.agent_model_config,
                ...(settings.thinkingEffort !== undefined
                  ? { thinkingLevel: settings.thinkingEffort }
                  : {}),
                ...(settings.fastMode !== undefined
                  ? { fastMode: settings.fastMode }
                  : {}),
                ...(settings.speed !== undefined
                  ? { speed: settings.speed }
                  : {}),
              }),
              agentId: parsed?.agentId ?? route,
              requestedModel: route,
              ...(parsed ? { baseModel: parsed.baseModel } : {}),
            };
            await options.onLogMetadataResolved?.(logMetadata);
          }
          return route;
        },
        pluginCollectionSelections: (id) => {
          const snapshot = options.resolvedPluginCollections?.[id];
          return snapshot?.chatSelections ?? snapshot?.selections;
        },
        inputValues: rawInputValues,
        logFile,
        logMetadata,
      });
    }

    const ollamaEnv = await resolveActionOllamaEnv(
      options.step,
      action,
      options.runtime,
      resolvedAgentInputs.inputValues,
      // Not `requireHeadlessHarness`: a Cursor checkpoint is headless here and
      // would be rejected outright. `resolveActionOllamaEnv` returns `{}` for
      // every non-Claude harness anyway.
      recoveryCheckpoint?.harness,
    );
    const settingSources =
      parseSettingSources(resolvedAgentInputs.inputValues.setting_sources) ??
      DEFAULT_AGENT_SETTING_SOURCES;
    const usesTerminalWorker =
      options.agentTerminalMode &&
      options.runtime.agentPromptWorker &&
      (options.step.uses === 'builtin/agent-prompt' ||
        (options.step.uses === 'builtin/agent-resume' &&
          resolvedAgentInputs.inputValues.session_id?.trim()));
    if (
      resolvedAgentInputs.agentModelOverride &&
      !usesTerminalWorker &&
      (recoveryCheckpoint?.harness ??
        getExecutionHarnessForModel(resolvedAgentInputs.runtimeModel ?? '')) ===
        'claude' &&
      Object.values(
        resolvedAgentInputs.syntheticSelectionsByCollectionId ?? {},
      ).some((selections) => (selections.mcpServerRefs?.length ?? 0) > 0)
    ) {
      throw new Error(
        "This workflow cannot load the Agent's selected MCP servers. Choose another model or run it with a terminal worker.",
      );
    }
    const pluginCollectionRuntime = await materializePluginCollectionRuntime({
      ...options,
      effectiveCwd,
      settingSources,
      logFile,
      agentProvider: logMetadata.agent_provider,
      pluginCollectionIds: [
        ...resolveStepPluginCollectionIds(options.step),
        ...resolvedAgentInputs.aliasPluginCollectionIds,
      ],
      syntheticSelectionsByCollectionId:
        resolvedAgentInputs.syntheticSelectionsByCollectionId,
    });
    const selectedAgentModel = resolveExplicitAgentModel(
      resolvedAgentInputs.inputValues.model,
    );
    if (
      selectedAgentModel &&
      isGatewayOnlyModel(selectedAgentModel) &&
      !options.runtime.resolveAiCreditsRouting
    ) {
      throw new Error(
        `Model "${selectedAgentModel}" requires AI Credits, but this runtime cannot route AI Credits requests.`,
      );
    }
    ledger.attempt = await openStepLedgerAttempt(options, {
      logMetadata,
      inputValues: resolvedAgentInputs.inputValues,
      recoveryCheckpoint,
      stepId,
      attempt,
      iteration,
    });
    const codexResult = await maybeRunCodexPrompt({
      runStepOptions: { ...options, recoveryCheckpoint },
      inputValues: resolvedAgentInputs.inputValues,
      pluginCollectionRuntime,
      effectiveCwd,
      tempDir,
      logFile,
      startedAt,
      stepId,
      attempt,
      iteration,
      logMetadata,
      ledgerAttempt: ledger.attempt,
    });
    if (codexResult) {
      return codexResult;
    }
    const cursorResult = await maybeRunAccountProviderPrompt({
      runStepOptions: { ...options, recoveryCheckpoint },
      ledgerAttempt: ledger.attempt,
      inputValues: resolvedAgentInputs.inputValues,
      pluginCollectionRuntime,
      effectiveCwd,
      tempDir,
      logFile,
      startedAt,
      stepId,
      attempt,
      iteration,
      logMetadata,
    });
    if (cursorResult) {
      return cursorResult;
    }
    const aiCreditsRoutingContext = buildStepAiCreditsRoutingContext(options);
    let aiCredits: Awaited<ReturnType<typeof resolveActionAiCreditsEnv>>;
    try {
      aiCredits = await resolveActionAiCreditsEnv(
        options.step,
        action,
        options.runtime,
        resolvedAgentInputs.inputValues,
        aiCreditsRoutingContext,
        // maybeRunAccountProviderPrompt already had first refusal on this step and
        // refuses a Cursor checkpoint it cannot resume, so a Cursor
        // checkpoint only reaches here on an action it does not handle. The
        // generic runner has no AI-credits concept for Cursor (it bills only
        // through the Cursor account), so treat it as "no captured harness"
        // instead of letting requireHeadlessHarness reject it outright, as
        // the other cursor-aware call sites do.
        recoveryCheckpoint?.harness === 'cursor' ||
          recoveryCheckpoint?.harness === 'copilot' ||
          recoveryCheckpoint?.harness === 'antigravity' ||
          recoveryCheckpoint?.harness === 'opencode'
          ? undefined
          : requireHeadlessHarness(recoveryCheckpoint?.harness),
        policyProbes[0],
      );
    } catch (error) {
      if (aiCreditsRoutingContext.routeSessionId) {
        await options.runtime.releaseAiCreditsRouting?.(
          aiCreditsRoutingContext.routeSessionId,
        );
      }
      throw error;
    }
    const ownsRoute = aiCredits.routed || aiCredits.accountProxyRouted;
    const workerRouteSessionId = ownsRoute
      ? aiCreditsRoutingContext.routeSessionId
      : undefined;
    let workerResult: StepResult | null;
    try {
      workerResult = await maybeRunAgentPromptWorker({
        action,
        accountProxyRouted: aiCredits.accountProxyRouted,
        accountProxyConnectionId: aiCredits.accountProxyConnectionId,
        runStepOptions: { ...options, recoveryCheckpoint },
        inputValues:
          aiCredits.model &&
          options.step.uses &&
          MODEL_AWARE_AGENT_ACTIONS.has(options.step.uses)
            ? { ...resolvedAgentInputs.inputValues, model: aiCredits.model }
            : resolvedAgentInputs.inputValues,
        pluginCollectionRuntime,
        effectiveCwd,
        tempDir,
        logFile,
        startedAt,
        stepId,
        attempt,
        iteration,
        logMetadata,
        claudeEnvOverride: { ...ollamaEnv, ...aiCredits.env },
        aiCreditsRouteSessionId: aiCreditsRoutingContext.routeSessionId,
        secretValues: [
          ...getSecretValues(options.secretEnv),
          ...aiCredits.secretValues,
        ],
        ledgerAttempt: ledger.attempt,
      });
    } catch (error) {
      if (workerRouteSessionId) {
        await options.runtime.releaseAiCreditsRouting?.(workerRouteSessionId);
      }
      throw error;
    }
    if (workerResult) {
      if (workerRouteSessionId) {
        await options.runtime.releaseAiCreditsRouting?.(workerRouteSessionId);
      }
      return aiCredits.routed
        ? {
            ...workerResult,
            outputs: {
              ...workerResult.outputs,
              [AI_CREDITS_ROUTED_OUTPUT_KEY]: 'true',
              ...(aiCredits.modelGatewayRouted
                ? { [MODEL_GATEWAY_ROUTED_OUTPUT_KEY]: 'true' }
                : {}),
            },
          }
        : aiCredits.accountProxyRouted
          ? {
              ...workerResult,
              outputs: {
                ...workerResult.outputs,
                ...accountProxyRouteOutputs(
                  aiCreditsRoutingContext.routeSessionId,
                ),
              },
            }
          : workerResult;
    }
    const fallbackRouteSessionId = ownsRoute
      ? aiCreditsRoutingContext.routeSessionId
      : undefined;
    try {
      // Same value set passed to `runSpawnedProcess`'s `secretValues` below
      // (which redacts this subprocess's stdout/stderr as they stream). The
      // subprocess itself cannot tell a "secret" env var's value apart from
      // an ordinary one once `secretEnv` is merged into its `process.env`
      // alongside `env`, so the exact value list also travels via
      // `AGENT_SECRET_VALUES` — the Claude/Ollama agent-prompt runner reads
      // it back (`parseAgentSecretValuesEnv`) to redact the rawText/
      // structured/proposedPlan it writes directly to output files, which
      // bypass the stdout-level redaction entirely.
      const ledgerSubprocess = await openLedgerSubprocessTools(
        ledger.attempt,
        effectiveCwd,
      );
      const stepSecretValues = [
        ...getSecretValues(options.secretEnv),
        ...aiCredits.secretValues,
        ...(ledgerSubprocess?.secretValues ?? []),
      ];
      const runtimeEnv = {
        ...buildSafeProcessEnv(options.runtime.processEnvironment),
        ...ollamaEnv,
        ...options.secretEnv,
        ...options.env,
        ...inputsToEnv(
          aiCredits.model && aiCredits.modelInput
            ? {
                ...resolvedAgentInputs.inputValues,
                [aiCredits.modelInput]: aiCredits.model,
              }
            : resolvedAgentInputs.inputValues,
        ),
        ...(logMetadata.agent_harness
          ? buildBrandManagedEnv({
              PIPELINE_AGENT_HARNESS: logMetadata.agent_harness,
            })
          : {}),
        ...buildModelAliasDiagnosticEnv(resolvedAgentInputs),
        ...pluginCollectionRuntime.env,
        // AI Credits routing carries a reusable credential. Apply its trusted
        // endpoint and token after every pipeline-controlled env layer so a
        // pipeline cannot redirect the token to an attacker-controlled host.
        ...aiCredits.env,
        ...buildStepManagedEnv({
          OUTPUT: outputFile,
          ENV: envFile,
          LOG_FILE: logFile,
          ACTION_PATH: action.actionDir,
          PIPELINE_AGENT_RECOVERY: 'true',
        }),
        // After every pipeline-controlled layer, so a step cannot point its
        // agent at another route. The action hands it to its Claude queries
        // as MCP configuration and withholds it from their environment.
        ...(ledgerSubprocess
          ? buildBrandManagedEnv({
              PIPELINE_LEDGER_TOOLS: JSON.stringify({
                mcpServers: ledgerSubprocess.mcpServers,
                allowedTools: ledgerSubprocess.allowedTools,
                instructions: ledgerSubprocess.instructions,
              }),
            })
          : {}),
        // `DIRECT_CLAUDE_PROVIDER_ACTIONS` also invoke the Claude SDK
        // directly in this same subprocess and write agent-authored text
        // straight to output files (bypassing the stdout-level
        // `SecretValueRedactor` the same way `MODEL_AWARE_AGENT_ACTIONS` do)
        // — each of their runners reads this back via
        // `parseAgentSecretValuesEnv` to redact before writing. This gate used
        // to cover only `MODEL_AWARE_AGENT_ACTIONS`,
        // leaving every direct-Claude action's own output unredacted even
        // though `secretEnv` (above) was already reaching their process.
        //
        // The aggregate stays in this action process. Everything the action
        // starts — the Claude CLI and its tools (`buildQueryOptions` passes an
        // explicit `env`), the agent loop's check command, and helpers built
        // on `getEnhancedEnv` — gets the environment without it
        // (`withoutAgentSecretValues`); each value stays available under its
        // own configured name, as `secretEnv` already provides. Output masking
        // also matches each value's JSON-escaped forms, so a value that is
        // printed escaped is still masked (`withJsonEscapedVariants`).
        ...(options.step.uses &&
        (MODEL_AWARE_AGENT_ACTIONS.has(options.step.uses) ||
          DIRECT_CLAUDE_PROVIDER_ACTIONS.has(options.step.uses))
          ? buildBrandManagedEnv({
              AGENT_SECRET_VALUES: JSON.stringify(stepSecretValues),
            })
          : {}),
        ...buildBundledBinaryEnv(),
        ...buildExecutionMetadataEnv(options),
        ...getRtkManagedEnv(),
      };
      // Only the host hands an action a Ledger route; a value a pipeline set
      // itself never reaches the action.
      if (!ledgerSubprocess) {
        for (const name of brandEnvCandidates('PIPELINE_LEDGER_TOOLS')) {
          delete runtimeEnv[name];
        }
      }
      if (options.runtime.resolveClaudeModAdmissionContext) {
        for (const name of brandEnvCandidates('CLAUDE_MOD_ADMISSION')) {
          delete runtimeEnv[name];
        }
        if (pluginCollectionRuntime.claudeModAdmission) {
          // Admission read ambient plugins from one config folder; refuse a
          // step whose final env would point Claude at another.
          if (
            !sameClaudeConfigDir(
              runtimeEnv,
              pluginCollectionRuntime.claudeModAdmissionConfigDir,
              effectiveCwd,
            )
          ) {
            throw new Error(
              'Claude Mod admission checked a different Claude config folder than this step uses.',
            );
          }
          // Pipeline env merges come after getEnhancedEnv()'s filter.
          delete runtimeEnv.CLAUDE_CODE_PLUGIN_DIRS;
          setBrandEnv(
            runtimeEnv,
            'CLAUDE_MOD_ADMISSION',
            JSON.stringify(pluginCollectionRuntime.claudeModAdmission),
          );
        }
      }
      let processSpec: ProcessSpec;
      if (runsUsing === 'node') {
        processSpec = getNodeProcessSpec(
          [action.mainPath ?? ''],
          options.runtime.nodeProcess,
        );
      } else if (runsUsing === 'python') {
        processSpec = getPythonProcessSpec(action.mainPath ?? '');
      } else {
        const tsxProcessSpec = getTsxCommand(options.runtime);
        processSpec = {
          ...tsxProcessSpec,
          args: [...tsxProcessSpec.args, action.mainPath ?? ''],
        };
      }

      if (onOutput) {
        spawnedLogPositions = await openAppendingStepLogCursor(logFile);
      }
      options.onProcessStart?.();
      const result = await runSpawnedProcess(processSpec, {
        cwd: effectiveCwd,
        env: runtimeEnv,
        runtime: options.runtime,
        signal: options.signal,
        timeout_minutes: options.step.timeout_minutes,
        agentTerminalResultGraceMs:
          logMetadata.log_format_hint === 'agent'
            ? getAgentTerminalResultGraceMs()
            : undefined,
        logFile,
        outputFile,
        envFile,
        secretValues: stepSecretValues,
        onOutput,
        resource: {
          executionId: options.executionId,
          pipelineId: options.pipelineId,
          pipelineName: options.pipelineName,
          jobId: options.jobId,
          stepId,
          attempt,
          iteration,
          childId: options.childId,
          label: `${options.jobId} / ${stepId}`,
        },
      });

      const postProcessedResult = await postProcessSpawnedResult(
        result,
        options,
      );
      const agentRecoveryResult = await buildAgentRecoveryStepResult({
        result: postProcessedResult,
        shutdown: isShutdownSignal(options.signal),
        step: options.step,
        tempDir,
        executionDir: path.join(
          options.runtime.executionsDir,
          options.executionId,
        ),
        attempt,
        iteration,
        jobId: options.jobId,
        stepId,
        model: logMetadata.agent_model,
        childId: options.childId,
        priorAgentActivity:
          recoveryCheckpointForStep(options)?.had_agent_activity === true,
        accountProxyRouted: aiCredits.accountProxyRouted,
        accountProxyConnectionId: aiCredits.accountProxyConnectionId,
      });
      const publicOutputs = sanitizeAgentFailureOutputKeys(
        postProcessedResult.outputs,
      );

      return createStepResult({
        ...postProcessedResult,
        ...(agentRecoveryResult ?? {}),
        outputs: aiCredits.routed
          ? {
              ...(agentRecoveryResult?.outputs ?? publicOutputs),
              [AI_CREDITS_ROUTED_OUTPUT_KEY]: 'true',
              ...(aiCredits.modelGatewayRouted
                ? { [MODEL_GATEWAY_ROUTED_OUTPUT_KEY]: 'true' }
                : {}),
            }
          : aiCredits.accountProxyRouted
            ? {
                ...(agentRecoveryResult?.outputs ?? publicOutputs),
                ...accountProxyRouteOutputs(
                  aiCreditsRoutingContext.routeSessionId,
                ),
              }
            : (agentRecoveryResult?.outputs ?? publicOutputs),
        ...logMetadata,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
    } finally {
      if (fallbackRouteSessionId) {
        await options.runtime.releaseAiCreditsRouting?.(fallbackRouteSessionId);
      }
    }
  } catch (error) {
    return createStepResult({
      status: options.signal.aborted ? 'cancelled' : 'failure',
      conclusion: options.signal.aborted ? 'cancelled' : 'failure',
      outcome: options.signal.aborted ? 'cancelled' : 'failure',
      ...logMetadata,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      error: String(error),
      log_file: logFile,
    });
  }
}
