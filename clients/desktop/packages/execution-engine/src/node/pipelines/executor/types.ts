import type { RepositoryPolicyScope } from '@canopy/execution-engine/node/lib/repository-policy';
import type { LedgerGlobalOwner } from '@canopy/protocol/canopy-core';
import type { ResourceContextInput } from '@canopy/execution-engine/lib/resource-context-policy';
import type { PipelineResourceParent } from './child-pipeline-resolver';
import type { ChildPipelineAuthorization } from './child-pipeline-resolver';
import type {
  CanopyEventInput,
  ExecutionEvent,
  ExecutionState,
  PipelineAgentAuthor,
  PipelineAgentChatAddress,
  PipelineChatSendRecord,
  PipelineExecutionInitiator,
  PipelineRunTarget,
  PipelineExecutionScope,
  PipelinePluginCollection,
  NormalizedStep,
  NormalizedPipeline,
  Pipeline,
  PipelineModelAliasPreference,
  PipelinePluginCollectionPreference,
  PipelinePreferenceLocator,
  PipelineScalar,
  PipelinePauseResponse,
  PipelineTriggerType,
  PipelineTriggerSource,
  ResolvedPipelineExecutionTarget,
  ResolvedPipelinePluginCollectionSnapshot,
  SharedPipelineExecutionSource,
  CuratedPipelineExecutionSource,
  PipelinePackageCapabilityOverlay,
  PipelinePackageManifestV1,
  SpawnedProcessRunner,
  StepOutputEvent,
} from '@canopy/execution-engine/types/pipeline';
import type {
  AgentAuditLinkTarget,
  UsageInitiationSource,
} from '@canopy/execution-engine/types/observability';
import type {
  AgentModelConfig,
  ChatTabPluginSelections,
  AppAdvisorInlineWatcherSetup,
  AppAdvisorWatcherDestination,
  CreateTrackedPlanRequest,
  ResourceGroupId,
  ResourceMetadata,
  ResourceProcessKind,
  UpdateTrackedPlanRequest,
} from '@canopy/execution-engine/execution-types';
import type { ApprovalMode } from '@canopy/execution-engine/types/approvals';
import type { ChatModel } from '@canopy/execution-engine/types/chat-models';
import type { PersistedChatMessage } from '@canopy/agent-transcript';
import type { ThinkingLevel } from '@canopy/execution-engine/types/thinking';
import type {
  ModelHarness,
  ModelHarnessInvocation,
} from '@canopy/execution-engine/types/model-harnesses';
import type { PipelineShareInstallPin } from '@canopy/protocol/pipelines';
import type {
  MoveToGroupInputs,
  PipelineHostActionId,
  PipelineHostFailureReason,
} from '@canopy/execution-engine/pipelines/host-actions';
import type { CreateWorktreeInputs } from '@canopy/execution-engine/pipelines/host-create-worktree';
import type {
  CreateBotEntryInputs,
  CreateProjectEntryInputs,
} from '@canopy/execution-engine/pipelines/host-create-entry';
import type { ResolvedSendAgentMessageInputs } from '@canopy/execution-engine/pipelines/host-send-agent-message';
import type { WaitForAgentReplyInputs } from '@canopy/execution-engine/pipelines/host-wait-for-agent-reply';
import type { CodexConfig } from '@canopy/execution-engine/lib/codex-model-config';
import type { AgentActionFailureMetadata } from '@canopy/execution-engine/agent-failures';
import type { HelperUsage } from '@canopy/execution-engine/lib/helper-usage';
import type { PermissionPreset } from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { JsonValue } from '../../codex-runtime/generated/serde_json/JsonValue';
import type { ClaudeModAdmissionInput } from '@canopy/execution-engine/node/plugins/claude-mod-admission';

/** Host-resolved policy and ambient inputs; step-selected roots are added later. */
export type ClaudeModAdmissionContext = Omit<
  ClaudeModAdmissionInput,
  'selectedPlugins'
>;
export type {
  AgentRecoveryAttempt,
  AgentRecoveryCheckpoint,
  CanopyEventData,
  CanopyEventInput,
  CanopyReplayEventData,
  ExecutionEvent,
  ExecutionRerunContext,
  ExecutionState,
  ExecutionSummary,
  IterationSnapshot,
  JobResult,
  NormalizedJob,
  NormalizedPipeline,
  NormalizedStep,
  PauseInputField,
  PauseInputRequest,
  PipelinePauseCheckpoint,
  PipelinePauseResponse,
  PipelineHookTriggerSource,
  PipelineStatusReason,
  PipelineStatusReasonCode,
  PipelineStatusReasonKind,
  PipelineStatusReasonSummary,
  PipelineQueueEvent,
  PipelineTriggerSource,
  PlanReadyEventData,
  PlanReadyEventInput,
  PlanReadyReplayData,
  QueuedPipelineExecutionEntry,
  ReportOutputs,
  RetryAttempt,
  ResumeExecutionSelection,
  SharedPipelineExecutionSource,
  CuratedPipelineExecutionSource,
  SpawnedProcessResourceOptions,
  SpawnedProcessResult,
  SpawnedProcessRunOptions,
  SpawnedProcessRunner,
  SpawnedProcessSpec,
  StepConclusion,
  StepLogLocator,
  StepLogReadOptions,
  StepLogReadResult,
  StepOutputEvent,
  StepOutputLogPosition,
  StepResult,
  TaskReadyEventData,
  TaskReadyEventInput,
  TaskReadyReplayData,
} from '@canopy/execution-engine/types/pipeline';

export interface ExecutionLifecycleHooks {
  onExecutionStart?(state: ExecutionState): void;
  onExecutionSettled?(state: ExecutionState): void;
}

export interface PipelineModelPolicyScope {
  projectId?: string;
  worktreeId?: string;
  executionContext?: string;
}

export interface StepPostProcessContext {
  step: NormalizedStep;
  outputs: Record<string, string>;
  notifications?: PipelineStepNotification[];
  projectId?: string;
  worktreeId?: string;
  /** Which run, job and attempt the step belongs to (CAN-6739). */
  executionId?: string;
  jobId?: string;
  attempt?: number;
  iteration?: number;
  /** 0 for a step of the run's own jobs; deeper inside a composite action. */
  depth?: number;
}

export interface PipelineStepNotification {
  title: string;
  body: string;
}

export interface ExecutionPlanPersistenceHooks {
  createTrackedPlan(request: CreateTrackedPlanRequest): Promise<{ id: string }>;
  updateTrackedPlan(request: UpdateTrackedPlanRequest): Promise<unknown>;
}

/**
 * Plan persistence the run's owner answers (CAN-6327): a pipeline host raises
 * each call as an `owner.plan.*` request. The owner knows the run's scope,
 * so a run without a worktree, such as a global cloud run, keeps its plan
 * too. Used in place of `planPersistence` when present.
 */
export interface ExecutionRunPlanPersistence {
  /**
   * Keeps the run's plan; null when its owner keeps none for this run.
   * `starting`: made while the run starts, which waits for it.
   */
  createPlan(request: {
    content: string;
    starting?: true;
  }): Promise<{ id: string } | null>;
  /**
   * Links the run to its plan, records `content` as a revision when given,
   * and approves the plan when the run ended.
   */
  updatePlan(request: {
    planId: string;
    content?: string;
    approve: boolean;
    starting?: true;
  }): Promise<void>;
}

export interface PipelinePluginCollectionResolution {
  snapshots: Record<string, ResolvedPipelinePluginCollectionSnapshot>;
}

export interface ClaudeCompatibleInvocation {
  providerType: 'claude' | 'ollama';
  sdkModel?: string;
  envOverride?: Record<string, string>;
}

/**
 * Per-step context for AI Credits routing (ECW-9091 review round 7). These
 * fields keep a pipeline step's routing decision aligned with the environment,
 * intent, and lifetime of the step that will actually run.
 */
export interface PipelineAiCreditsRoutingContext {
  checkpointProxyQuota?: boolean;
  signal?: AbortSignal;
  requiredAccountProxyConnectionId?: string;
  /**
   * Workspace whose Canopy Environments assignments apply. Required for the
   * user-supplied-credential guard to read the same environment the step spawns
   * with — a workspace assignment REPLACES the global one, so resolving without
   * it can miss a per-workspace provider key and bill credits around it.
   */
  workspaceId?: string;
  /** Worktree whose branch name is attached to routed requests. */
  worktreeId?: string;
  /**
   * Whether an absent native login may route this step through AI Credits.
   * `false` for unattended triggers (scheduled automations, hooks) so a run with
   * no user present cannot silently spend a credits-only user's balance.
   */
  allowNoNativeAuthFallback?: boolean;
  /**
   * Parent-owned loopback route for this provider-backed step. When present,
   * the host must broker provider credentials instead of returning a reusable
   * account token in the worker's environment, and the executor releases the
   * route as soon as its provider invocation settles.
   */
  routeSessionId?: string;
  /**
   * The run's persisted `execution_context` (`personal` / `org:<uuid>`), from
   * which the host resolves the owner of the step's model traffic. Absent for
   * runs that never captured one; the host then resolves in Personal.
   */
  executionContext?: string;
}

/**
 * Plain-data AI Credits routing override for a pipeline step, resolved by the
 * main-process runtime bridge and injected into the action subprocess env.
 * Deliberately serializable — the executor lives in `desktop-shared/node` and
 * cannot import the Electron routing module, so routing crosses the boundary as
 * data (see `execution-runtime.ts`).
 */
export interface PipelineAiCreditsRoutingOverride {
  provider: 'claude' | 'codex';
  /** Gateway model slug to run the step under. */
  model: string;
  /** Provider env; terminal workers and Codex use parent-owned loopback routes. */
  env: Record<string, string>;
  /** True when this exact invocation uses an organization-owned gateway. */
  modelGatewayRouted?: boolean;
  /**
   * True when the step goes to the account proxy instead (CAN-4020): billed
   * to a proxy account, with the native model id.
   */
  accountProxyRouted?: boolean;
  accountProxyConnectionId?: string;
  /** Thread-scoped Codex provider block (Codex only). */
  codexConfig?: CodexConfig;
}

export interface PipelineAgentModelAliasResolution {
  agentId: string;
  name: string;
  base: string;
  instructions?: string;
  pluginSelections?: ChatTabPluginSelections;
}

export interface ClaudeCompatibleInvocationOptions {
  providerType?: 'claude' | 'ollama';
  ensureRunningReason?:
    | 'chat'
    | 'helper'
    | 'pipeline'
    | 'settings-refresh'
    | 'pull';
  assertInstalled?: boolean;
}

export interface ModelHarnessInvocationOptions {
  checkpointProxyQuota?: boolean;
  signal?: AbortSignal;
  requiredAccountProxyConnectionId?: string;
  harness?: ModelHarness;
  routeSessionId?: string;
  workspaceId?: string;
  worktreeId?: string;
  allowNoNativeAuthFallback?: boolean;
  /** See {@link PipelineAiCreditsRoutingContext.executionContext}. */
  executionContext?: string;
}

export interface ExecutionRuntime {
  resolvePipelineContextResource?: (
    parent: PipelineResourceParent,
    executionContext?: string,
  ) => Promise<ResourceContextInput['resource'] | undefined>;
  resolvePipelineResource?: (
    reference: string,
    parent?: ResourceContextInput['resource'],
    file?: { cwd: string; filePath: string },
    target?: ResolvePipelineTargetResult,
    executionContext?: string,
  ) => Promise<ResolvedChildPipeline | undefined>;
  executionsDir: string;
  tempRootDir: string;
  bundledActionsDir: string;
  getProjectActionsDir(repoPath: string): string;
  getProjectActionsDirCandidates?(repoPath: string): string[];
  getProjectPipelinesDir(repoPath: string): string;
  getProjectPipelinesDirCandidates?(repoPath: string): string[];
  resourceMonitor?: ExecutionResourceMonitor;
  /**
   * Optional host for leaf action processes. Electron supplies an off-main
   * utility-process implementation; the CLI and tests use the local fallback.
   */
  spawnedProcessRunner?: SpawnedProcessRunner;
  /**
   * The environment a step starts from in place of this process's own
   * (`getEnhancedEnv({ environment: false })`). A daemon pipeline host sets it
   * from the start's `_execution.childEnvironment` (CAN-5086).
   */
  processEnvironment?: Readonly<Record<string, string>>;
  /** How `node` steps and node actions start, in place of the built-in choice. */
  nodeProcess?: {
    readonly command: string;
    readonly env?: Readonly<Record<string, string>>;
  };
  /**
   * The tsx CLI (`tsx/dist/cli.mjs`) `tsx` steps and actions start with on
   * `nodeProcess`, in place of the built-in lookup. A cloud runner stages its
   * own, and the daemon classifier admits tsx steps only with one
   * (CAN-6316 G1).
   */
  tsxCli?: string;
  lifecycle?: ExecutionLifecycleHooks;
  onStepPostProcess?: (ctx: StepPostProcessContext) => void | Promise<void>;
  planPersistence?: ExecutionPlanPersistenceHooks;
  /** The run's owner keeps its plan (CAN-6327); replaces `planPersistence`. */
  runPlanPersistence?: ExecutionRunPlanPersistence;
  resolvePipelinePluginCollections?: (
    collections: readonly PipelinePluginCollection[] | undefined,
    preferences: Record<string, PipelinePluginCollectionPreference>,
  ) => Promise<PipelinePluginCollectionResolution>;
  /** Resolve fresh Claude Mod policy for one agent launch at its effective cwd. */
  resolveClaudeModAdmissionContext?: (request: {
    cwd: string;
    settingSources: readonly SettingSource[];
    /** The step env's CLAUDE_CONFIG_DIR, when the pipeline sets one. */
    claudeConfigDir?: string;
  }) => Promise<ClaudeModAdmissionContext | undefined>;
  /** `scope` names the step's workspace, whose default an inheriting Agent takes. */
  resolvePipelineAgentModelAlias?: (
    agentId: string,
    scope?: PipelineModelPolicyScope,
  ) => Promise<PipelineAgentModelAliasResolution | null>;
  /**
   * Organization model-policy gate consulted before any agent step runs.
   *
   * REQUIRED on purpose. While this was optional, omitting it type-checked
   * fine and silently disabled the step-runner guard entirely — the CLI
   * runtime shipped that way, so every `apps/desktop-cli` pipeline run
   * executed agent steps against org-blocked models with no enforcement and
   * no `model_policy_refused` diagnostic. Making it required turns an
   * omission into a compile error, so any runtime that genuinely cannot
   * evaluate the policy has to say so explicitly (return `false` with a
   * comment explaining why) instead of inheriting an invisible exemption.
   */
  isModelBlockedByOrgPolicy: (
    modelId: string,
    scope: PipelineModelPolicyScope,
  ) => Promise<boolean>;
  /**
   * Whether any organization on the current account is actively enforcing a
   * model policy — independent of whether some specific id passes it.
   *
   * Exists because {@link isModelBlockedByOrgPolicy} cannot answer this. That
   * predicate returns `false` both for "no policy exists at all" and for "a
   * policy exists and it approved this id", and the step-runner gate has to
   * treat those two cases differently: when a step names no model it probes
   * `DEFAULT_CLAUDE_MODEL` as a stand-in for whatever the provider would pick
   * on its own, and it must PIN that id into the step's inputs so the model
   * that was checked is the model that actually runs — otherwise the provider's
   * own default can drift to an id the org never reviewed and the gate
   * under-refuses. Pinning unconditionally would instead force
   * `DEFAULT_CLAUDE_MODEL` onto every unnamed-model step for users under no
   * policy at all, so the pin must be scoped to policed runs.
   *
   * The only way to extract that signal from the blocked-check alone is to
   * probe an id that can never appear in a reviewed snapshot and read the
   * refusal as "a policy is active" — the unreviewable-sentinel trick that was
   * already found and removed from this gate as a bug (it also refused for orgs
   * that had reviewed everything). Hence a first-class member instead.
   *
   * REQUIRED for the same reason as {@link isModelBlockedByOrgPolicy}: an
   * optional hook turns a missing implementation into a silent, invisible
   * behavior difference. A runtime that genuinely cannot evaluate the policy
   * has to return `false` explicitly and say why.
   */
  isOrgModelPolicyActive: (scope: PipelineModelPolicyScope) => Promise<boolean>;
  /**
   * Best-effort refusal diagnostic. Stays optional because it only records
   * observability for a refusal the required gate above has already made;
   * an absent implementation cannot weaken enforcement.
   */
  recordModelPolicyRefusal?: (context: {
    executionId: string;
    jobId: string;
    stepId: string;
    projectId?: string;
    worktreeId?: string;
    modelId: string;
  }) => void;
  resolveClaudeCompatibleInvocation?: (
    model: ChatModel | undefined,
    options?: ClaudeCompatibleInvocationOptions,
  ) => Promise<ClaudeCompatibleInvocation>;
  /** Provider-neutral, per-invocation model/harness resolution. */
  resolveModelHarnessInvocation?: (
    model: ChatModel | undefined,
    options?: ModelHarnessInvocationOptions,
  ) => Promise<ModelHarnessInvocation>;
  /**
   * Resolve AI Credits gateway routing for a pipeline step's model according
   * to the global routing mode. Returns plain data injected into the action
   * subprocess env, or `null` for the native path. Provided only by the
   * Electron runtime bridge; absent runtimes (tests, headless without cloud)
   * skip routing.
   */
  resolveAiCreditsRouting?: (
    model: string | undefined,
    provider: 'claude' | 'codex',
    context?: PipelineAiCreditsRoutingContext,
  ) => Promise<PipelineAiCreditsRoutingOverride | null>;
  /** Release an owned AI Credits route after its provider invocation settles. */
  releaseAiCreditsRouting?: (routeSessionId: string) => void | Promise<void>;
  agentPromptWorker?: AgentPromptWorkerRunner;
  codexPromptRunner?: CodexPromptRunner;
  cursorPromptRunner?: CursorPromptRunner;
  copilotPromptRunner?: CopilotPromptRunner;
  opencodePromptRunner?: OpenCodePromptRunner;
  antigravityPromptRunner?: AntigravityPromptRunner;
  resolvePipelineTarget?: (
    request: ResolvePipelineTargetRequest,
  ) => Promise<ResolvePipelineTargetResult>;
  /**
   * The Agent Ledger tools of desktop-run agent steps. Only the desktop host
   * supplies it; without it (the CLI, tests) agent steps get no Ledger tools.
   */
  pipelineLedger?: PipelineLedgerPort;
  /**
   * Host steps (`runs.using: host`), supplied by the desktop app, the daemon
   * pipeline host and the routed CLI. Without it (the legacy CLI, tests) a
   * host step runs its declared Node `runs.fallback`, or fails with
   * `needs_desktop` when it has none. A step whose action the port doesn't
   * declare in `support` does the same, failing with `needs_host` instead.
   */
  pipelineHostActions?: PipelineHostActions;
  /**
   * The run owner's checks on `run-pipeline` targets and stored-pipeline
   * agent authors. Only the desktop host supplies it; without it (the CLI,
   * tests) targets are not owner-checked.
   */
  pipelineOwnership?: PipelineOwnershipPort;
}

/** A requested worktree, checked by id before it is resolved. */
export interface PipelineOwnershipWorktreeTarget {
  scope: 'worktree';
  workspace_id: string;
  worktree_id: string;
}

/** Host-owned ownership policy the executor consults for child runs. */
export interface PipelineOwnershipPort {
  /** Refuse a run-pipeline worktree target another owner holds. Throws a non-disclosing Error. */
  authorizeTarget(args: {
    executionContext: string | undefined;
    target: PipelineOwnershipWorktreeTarget | ResolvedPipelineExecutionTarget;
  }): Promise<void>;
  readAgentAuthor(
    locator: PipelinePreferenceLocator,
  ): PipelineAgentAuthor | undefined;
}

/**
 * The Ledger an agent attempt records to: the task its execution runs in, or,
 * for a global or directory run, its owner's global (workflow) Ledger. The
 * owner is the execution's persisted one, never the project's organization or
 * the selected sidebar context.
 */
export type PipelineLedgerTarget =
  | { kind: 'task'; projectId: string; worktreeId: string }
  | { kind: 'global'; owner: LedgerGlobalOwner };

/** The agent attempt a step's Ledger tools speak for. */
export interface PipelineLedgerAttemptRequest {
  executionId: string;
  pipelineId?: string;
  pipelineName?: string;
  /** The Ledger the attempt's entries go to. */
  target: PipelineLedgerTarget;
  /**
   * The workspace the execution runs in, when it has one, for its approval
   * policy and run navigation. A directory run has a workspace but no task,
   * so it records globally and keeps its project's deny rules.
   */
  projectId?: string;
  /** The worktree the execution runs in, when it has one. */
  worktreeId?: string;
  /** The job as it ran; each matrix variant is its own physical job. */
  physicalJobId: string;
  /** The job as the pipeline declares it. */
  logicalJobId: string;
  jobName: string;
  stepId: string;
  stepName: string;
  /** 1-based; each job retry is a new attempt. */
  attempt: number;
  iteration: number;
  /**
   * The agent session the host minted for the run this attempt resumes from
   * its recovery checkpoint. Absent for any other run (a first run, a retry,
   * a new iteration), which gets a new session from the host.
   */
  resumedAgentSessionId?: string;
  /** The agent session of the attempt this retry replaces. */
  predecessorAgentSessionId?: string;
  /** The recovery checkpoint this run resumes. */
  checkpointId?: string;
  harness: 'claude' | 'codex' | 'opencode';
  model?: string;
  thinkingEffort?: string;
  permissionPreset: PermissionPreset;
  /**
   * The step's configured secret values. The host masks them out of every
   * Ledger entry the agent writes; they are never logged or persisted.
   */
  secretValues?: readonly string[];
}

/** How an attempt's Ledger tools ended. */
export type PipelineLedgerAttemptOutcome =
  | { kind: 'settled' }
  /** Paused with a recovery checkpoint the same agent session resumes. */
  | { kind: 'paused'; checkpointId: string; pausedAt: string };

/** An agent step run as an action subprocess reaches the host through this. */
export interface PipelineLedgerSubprocessTools {
  /** Claude SDK `mcpServers` entries serving the attempt's Ledger tools. */
  readonly mcpServers: Record<string, JsonValue>;
  /** The tool names the subprocess's queries allow without a prompt. */
  readonly allowedTools: readonly string[];
  /** Values the step masks in its output (the route's token). */
  readonly secretValues: readonly string[];
}

/** One agent attempt's open Ledger tools. */
export interface PipelineLedgerAttempt {
  /** Host runners (Codex, Claude workers) find the attempt's tools by it. */
  readonly attemptKey: string;
  /**
   * The attempt's agent session, its Ledger actor: the resumed run's, or one
   * the host minted. The executor records it on the step.
   */
  readonly agentSessionId: string;
  /** The Ledger block for the agent's system instructions. */
  readonly instructions: string;
  /**
   * Registers the attempt's route for a Claude action subprocess running in
   * `cwd`, whose Ledger calls pass the step's approval policy.
   */
  openSubprocessTools(cwd: string): Promise<PipelineLedgerSubprocessTools>;
  /**
   * Revokes the attempt's caller binding and route. Idempotent. A pause with
   * a resumable checkpoint leaves the agent assignable until a resume
   * consumes that checkpoint or its execution is cancelled.
   */
  close(outcome: PipelineLedgerAttemptOutcome): void;
}

export interface PipelineLedgerPort {
  /** Null when the Ledger is not exposed to the attempt. */
  openAttempt(
    request: PipelineLedgerAttemptRequest,
  ): Promise<PipelineLedgerAttempt | null>;
  /**
   * An execution's resume is saved and its jobs are about to run: the agents
   * paused on these recovery checkpoints stop being assignable owners. IDs
   * without a paused agent are ignored. Called for every execution that
   * resumes, nested pipelines included, and only after its resume validated.
   */
  noteResuming(
    executionId: string,
    checkpointIds: readonly string[],
  ): Promise<void>;
}

/** The step a host action request comes from. */
export interface PipelineHostActionCaller {
  executionId: string;
  pipelineId?: string;
  pipelineName?: string;
  jobId: string;
  stepId: string;
  /**
   * The executor's 0-based job attempt (the first run is 0, unlike the
   * Ledger's 1-based attempt); each job retry is a new attempt and acts again.
   */
  attempt: number;
  iteration: number;
  childId?: string;
  idempotencyKey: string;
  /** The execution's usage-attribution and owner context (`RunStepOptions.executionContext`). */
  executionContext?: string;
  initiationSource?: UsageInitiationSource;
  /** The execution's `agent_origin`: the agent whose rules apply to an agent-originated run. */
  agentOrigin?: PipelineAgentChatAddress;
  /** The execution's trusted initiator; a sent message's title names an automation from it. */
  initiator?: PipelineExecutionInitiator;
}

export type PipelineHostActionRequest =
  | { action: 'move-to-group'; inputs: MoveToGroupInputs }
  | { action: 'create-worktree'; inputs: CreateWorktreeInputs }
  | { action: 'create-project-entry'; inputs: CreateProjectEntryInputs }
  | { action: 'create-bot-entry'; inputs: CreateBotEntryInputs }
  | { action: 'send-agent-message'; inputs: ResolvedSendAgentMessageInputs }
  | { action: 'wait-for-agent-reply'; inputs: WaitForAgentReplyInputs };

/**
 * `chatSend` is the message a step sent. A failure carries it too when the
 * message was accepted before the step failed (a refused steer), so a
 * delivered message is never hidden.
 */
export type PipelineHostActionResult =
  | {
      status: 'success';
      outputs: Record<string, string>;
      chatSend?: PipelineChatSendRecord;
    }
  | {
      status: 'failure';
      failureReason: PipelineHostFailureReason;
      error: string;
      outputs: Record<string, string>;
      chatSend?: PipelineChatSendRecord;
    };

/** In-process execution controls; not a portable DTO or IPC contract. */
export interface PipelineHostActionControls {
  /** Epoch ms when the executor withdraws the call. */
  deadlineAt: number;
  /** `<executionsDir>/<executionId>/host/<sha256(idempotencyKey)>`; the host may create it. */
  artifactsDir: string;
  /**
   * Registered before the first async effect; on timeout the executor
   * returns the finalizer's result instead of a generic timeout. A finalizer
   * that resolves `undefined` counts as none: the step ends as a plain
   * timeout (a daemon host step whose owner had no finalizer, CAN-5771).
   */
  registerTimeoutFinalizer(
    finalize: () => Promise<PipelineHostActionResult | undefined>,
  ): void;
}

/**
 * The host actions a port answers (CAN-6082). The executor raises only these;
 * any other host step runs its Node `runs.fallback`, or fails with
 * `needs_host` when it has none.
 */
export interface PipelineHostActionSupport {
  /** The host as the `needs_host` message names it, such as "the desktop app". */
  readonly hostName: string;
  readonly actions: ReadonlySet<PipelineHostActionId>;
}

/** Worker-to-core request: the executor raises it, the host applies policy. */
export interface PipelineHostActions {
  /**
   * What the port answers. Every executor-facing host port declares it;
   * omitted (an in-process host behind such a port, or a test port), the
   * port answers every host action.
   */
  readonly support?: PipelineHostActionSupport;
  /**
   * Resolves with a typed result; throws only for unexpected host errors,
   * which fail the step with the message and no `failure_reason`.
   */
  run(
    request: PipelineHostActionRequest,
    caller: PipelineHostActionCaller,
    signal: AbortSignal,
    controls?: PipelineHostActionControls,
  ): Promise<PipelineHostActionResult>;
}

export interface ResolvePipelineTargetRequest {
  parent: {
    cwd: string;
    scope: PipelineExecutionScope;
    target?: ResolvedPipelineExecutionTarget;
    projectId?: string;
    worktreeId?: string;
    repoPath?: string;
  };
  requested: PipelineRunTarget;
}

export interface ResolvePipelineTargetResult {
  cwd: string;
  scope: PipelineExecutionScope;
  target: ResolvedPipelineExecutionTarget;
  projectId?: string;
  worktreeId?: string;
  repoPath?: string;
}

export interface AgentPromptWorkerPermission {
  permissionMode?: 'plan' | 'bypassPermissions';
  allowDangerouslySkipPermissions?: boolean;
  /**
   * The set of built-in tools that exist for the session (maps to the CLI
   * `--tools` flag). This is how read-only is enforced: omitting Edit/Write/Bash
   * makes mutation impossible by construction, independent of permission mode,
   * so it composes safely with `bypassPermissions`. `[]` disables all built-ins.
   * Leave undefined to expose the full built-in set.
   */
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface AgentPromptWorkerRequest {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  schema?: Record<string, unknown>;
  /**
   * When set (the `builtin/agent-resume` action), the worker resumes this
   * existing Claude session instead of starting a new one, and no system prompt
   * is appended.
   */
  resumeSessionId?: string;
  model?: ChatModel;
  thinkingLevel?: ThinkingLevel;
  permission?: AgentPromptWorkerPermission;
  /** Explicit Canopy policy for the unattended worker's approval hook. */
  approvalMode?: ApprovalMode;
  settingSources?: SettingSource[];
  maxTurns?: number;
  mcpServers?: Record<string, unknown>;
  claudeEnvOverride?: Record<string, string>;
  /** The step's open Ledger attempt; the worker's route serves its tools. */
  ledgerAttemptKey?: string;
  /** Parent-owned AI Credits route to revoke as soon as this worker settles. */
  aiCreditsRouteSessionId?: string;
  projectId?: string;
  worktreeId?: string;
  executionId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  childId?: string;
  stepLabel: string;
  signal?: AbortSignal;
  linkTarget?: AgentAuditLinkTarget;
  onWorkerStarted?: (workerId: string) => void | Promise<void>;
  /**
   * Fired if the worker waits on the concurrency cap before launching. Lets the
   * step surface a "queued" state (and a live "View worker" jump to the queued
   * card) instead of appearing to run while it actually waits for a slot.
   */
  onWorkerQueued?: (workerId: string) => void | Promise<void>;
}

export type AgentPromptWorkerResult =
  | {
      status: 'success';
      workerId: string;
      sessionId: string;
      rawText: string;
      structured?: unknown;
      transcript: string;
      proposedPlan?: string;
      projectedMessages?: PersistedChatMessage[];
    }
  | {
      status: 'failure' | 'cancelled';
      workerId?: string;
      transcript: string;
      projectedMessages?: PersistedChatMessage[];
      failure: AgentActionFailureMetadata;
    };

export interface AgentPromptWorkerRunner {
  runAgentPrompt(
    request: AgentPromptWorkerRequest,
  ): Promise<AgentPromptWorkerResult>;
}

export interface CodexPromptRunnerRequest {
  cwd: string;
  prompt: string;
  /** Effective pipeline environment captured for this execution. */
  environment: Record<string, string>;
  systemPrompt?: string;
  schema?: Record<string, JsonValue>;
  resumeSessionId?: string;
  model?: ChatModel;
  harnessInvocation?: ModelHarnessInvocation;
  thinkingLevel?: ThinkingLevel;
  fastMode: boolean;
  totalTimeoutMs: number;
  permissionPreset: PermissionPreset;
  pluginSelections?: ChatTabPluginSelections;
  packageOverlay?: PipelinePackageCapabilityOverlay;
  projectId?: string;
  worktreeId?: string;
  /**
   * Whether an absent native login may route this step through AI Credits.
   *
   * Codex agent-prompt/agent-resume steps short-circuit in `maybeRunCodexPrompt`
   * BEFORE `resolveActionAiCreditsEnv`, so they never see
   * `buildStepAiCreditsRoutingContext` and resolve their own routing inside the
   * host runner. Without this field that path silently ignored the unattended
   * opt-out, letting an automation- or hook-triggered pipeline spend a
   * credits-only user's balance (ECW-9091 review round 9). Populated from the
   * same helper as the generic seam so the two cannot drift again.
   */
  allowNoNativeAuthFallback?: boolean;
  /** The step's open Ledger attempt; the thread's dynamic tools serve it. */
  ledgerAttemptKey?: string;
  /** See {@link PipelineAiCreditsRoutingContext.executionContext}. */
  executionContext?: string;
  executionId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  childId?: string;
  stepLabel: string;
  signal?: AbortSignal;
  linkTarget?: AgentAuditLinkTarget;
  /**
   * Fired once per transcript JSONL line (without trailing newline) as the
   * turn streams, so the executor can forward live step output instead of
   * waiting for the turn to resolve. The streamed lines are always a prefix
   * of the final result's `transcript`; the executor emits only the
   * not-yet-streamed remainder when the runner resolves.
   */
  onTranscriptLine?: (line: string) => void;
}

export type CodexPromptRunnerResult =
  | {
      status: 'success';
      sessionId: string;
      rawText: string;
      structured?: unknown;
      transcript: string;
      proposedPlan?: string;
      usage: HelperUsage;
      aiCreditsRouted?: boolean;
      modelGatewayRouted?: boolean;
    }
  | {
      status: 'failure' | 'cancelled';
      transcript: string;
      failure: AgentActionFailureMetadata;
      aiCreditsRouted?: boolean;
      modelGatewayRouted?: boolean;
    };

export interface CodexPromptRunner {
  runCodexPrompt(
    request: CodexPromptRunnerRequest,
  ): Promise<CodexPromptRunnerResult>;
}

export interface CursorPromptRunnerRequest {
  cwd: string;
  /** Host-selected execution checkout, separate from the effective step cwd.
   * Optional for unmigrated native adapters; required by host-text delivery.
   */
  repositoryPolicyScope?: RepositoryPolicyScope;
  prompt: string;
  /** Effective pipeline environment captured for this execution. */
  environment: Record<string, string>;
  systemPrompt?: string;
  schema?: Record<string, JsonValue>;
  resumeSessionId?: string;
  model: ChatModel;
  totalTimeoutMs: number;
  /**
   * When the step's budget started, as an epoch ms reading taken at the host
   * runner's TRUE entry.
   *
   * Without it the shared runner started the clock at its own first line, which
   * on the desktop path is already after the connection probe and the full
   * runtime digest (`getManagedCursorRuntime` → `installer.verify()`, a
   * SHA-256 of the unpacked tree, globally serialized across steps). A fan-out
   * of N Cursor steps could therefore spend N serialized digests before any
   * prompt ran, with none of it charged against `timeout_minutes`. Omitted
   * means "start now", which is what a caller with no setup wants.
   */
  budgetStartedAt?: number;
  permissionPreset: PermissionPreset;
  /** Accepted for parity; this release warns and ignores them on Cursor. */
  pluginSelections?: ChatTabPluginSelections;
  packageOverlay?: PipelinePackageCapabilityOverlay;
  /** Only field of this group the desktop runner reads (spawn profile). */
  projectId?: string;
  /** Root of pipeline executions, so the CLI conversation profile persists across resume. */
  executionsDir: string;
  executionId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  childId?: string;
  signal?: AbortSignal;
  /**
   * The step's configured secret values. Each streamed text delta is its own
   * transcript line, and tool values are JSON strings nested inside a line, so
   * the executor's per-line masking cannot see a value split between deltas or
   * blocks, or escaped inside a tool value. The runner masks those first.
   */
  secretValues?: readonly string[];
  onTranscriptLine?: (line: string) => void;
}

/** Same result union as Codex so the executor's result mapping is shared. */
export type CursorPromptRunnerResult = CodexPromptRunnerResult;

export interface CursorPromptRunner {
  runCursorPrompt(
    request: CursorPromptRunnerRequest,
  ): Promise<CursorPromptRunnerResult>;
}

export interface CopilotPromptRunnerRequest extends CursorPromptRunnerRequest {
  thinkingLevel?: ThinkingLevel;
}
export type CopilotPromptRunnerResult = CodexPromptRunnerResult;
export interface CopilotPromptRunner {
  runCopilotPrompt(
    request: CopilotPromptRunnerRequest,
  ): Promise<CopilotPromptRunnerResult>;
}

export interface OpenCodePromptRunnerRequest extends CursorPromptRunnerRequest {
  thinkingLevel?: ThinkingLevel;
  /** Captured pipeline scope, never the current navigation selection. */
  worktreeId?: string;
  executionContext?: string;
  /** The step's open Ledger attempt; the app's MCP route serves its tools. */
  ledgerAttemptKey?: string;
}
export type OpenCodePromptRunnerResult = CodexPromptRunnerResult;
export interface OpenCodePromptRunner {
  runOpenCodePrompt(
    request: OpenCodePromptRunnerRequest,
  ): Promise<OpenCodePromptRunnerResult>;
}

export interface ExecutionResourceRegistration {
  id: string;
  groupId: ResourceGroupId;
  kind: ResourceProcessKind;
  label: string;
  pid?: number;
  processGroupId?: number;
  startedAt?: string;
  metadata?: ResourceMetadata;
}

export interface ExecutionResourceRegistrationHandle {
  update(update: Partial<ExecutionResourceRegistration>): void;
  unregister(): void;
}

/**
 * How much memory a host can still give new pipeline steps (CAN-6325): a
 * cloud sandbox's, or the share of the machine a desktop host allows itself.
 */
export interface ExecutionMemoryReading {
  /** Bytes new work may still take before memory is tight; 0 or less is tight. */
  readonly availableBytes: number;
  /** The whole budget the reading is out of. */
  readonly totalBytes: number;
  /** When it was measured, in epoch milliseconds. */
  readonly sampledAt: number;
  /** Bytes kept for chats that share this host; worktree runs leave them free. */
  readonly chatReserveBytes?: number;
}

export interface ExecutionResourceMonitor {
  registerProcess(
    registration: ExecutionResourceRegistration,
  ): ExecutionResourceRegistrationHandle;
  registerWorkItem(
    registration: ExecutionResourceRegistration,
  ): ExecutionResourceRegistrationHandle;
  /**
   * The host's memory, read before each step starts and while one waits.
   * Without it, or when it answers undefined, steps start without waiting.
   */
  readMemory?(): Promise<ExecutionMemoryReading | undefined>;
}

export interface ExecutionOptions {
  cwd: string;
  pipelineId: string;
  /**
   * Execution scope for this run. Optional/additive; when omitted the
   * executor treats the run as `directory`.
   */
  scope?: PipelineExecutionScope;
  /**
   * Resolved execution target for this run (persisted onto `ExecutionState`).
   * Optional/additive; when omitted the run uses `cwd` as a `directory`
   * target.
   */
  target?: ResolvedPipelineExecutionTarget;
  /** Host-selected checkout boundary; null means unavailable on retained execution. */
  executionCheckoutRoot?: string | null;
  /**
   * The folder a top-level global run works in, kept by its host from one
   * run to the next (CAN-6317). Without it the run gets `workspace/` inside
   * its execution folder. Persisted, so replays work in the same folder.
   */
  globalWorkspaceDir?: string;
  env?: Record<string, string>;
  /** Sensitive env vars merged at child-process spawn time only — never persisted to ExecutionState. */
  secretEnv?: Record<string, string>;
  inputs?: Record<string, string>;
  inputAnswers?: Record<string, PipelineScalar>;
  pauseResponses?: PipelinePauseResponse[];
  statusReasonIds?: string[];
  pipelineFileDir?: string;
  /**
   * Resolved directory per declared asset id, read as
   * `${{ assets.<id>.path }}`. Main resolves these before the run starts;
   * child runs inherit the root run's values.
   */
  assetPaths?: Record<string, string>;
  /** Per-pipeline state dir, read as `${{ canopy.pipeline_data_dir }}`. */
  pipelineDataDir?: string;
  /** Installed asset root (`<data>/pipeline-data/<key>/assets`). */
  assetsDir?: string;
  /** In-memory file source locator, independent of the execution target. */
  pipelineSource?: { cwd: string; filePath: string };
  /** In-memory inherited provenance for inline children; never sourced from YAML. */
  inlinePipelineResource?: ResourceContextInput['resource'];
  repoPath?: string;
  runtime: ExecutionRuntime;
  executionId?: string;
  depth?: number;
  eventName?: PipelineTriggerType;
  eventData?: CanopyEventInput;
  modelConfig?: AgentModelConfig;
  projectId?: string;
  worktreeId?: string;
  /** Optional chat context for caller-side telemetry. Not persisted to execution state. */
  chatId?: string;
  /** Main-process receipt for an accepted in-place Portal control. */
  portalCommandId?: string;
  planId?: string;
  /**
   * Main-process hook invoked after the initial execution state is persisted
   * and before the asynchronous pipeline runner starts emitting lifecycle
   * events.
   */
  beforeStart?: (state: ExecutionState) => void | Promise<void>;
  onEvent?: (event: ExecutionEvent) => void;
  onStepOutput?: (event: StepOutputEvent) => void;
  parentExecutionId?: string;
  parentStepId?: string;
  parentAttempt?: number;
  parentIteration?: number;
  /**
   * Locator identifying this pipeline's saved-default entry (if any).
   * - Bundled/user-stored pipelines:
   *   `{ type: 'stored', source: 'bundled' | 'user', value: pipelineId }`
   * - File-backed project/CLI pipelines: `{ type: 'file', value: absolutePath }`
   * - Inline pipelines: omitted
   */
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  /**
   * Unsaved per-collection preferences (draft overrides from the trigger
   * modal or CLI flags). When present, these take precedence over stored
   * prefs at execution time.
   */
  pluginCollectionPreferences?: Record<
    string,
    PipelinePluginCollectionPreference
  >;
  /**
   * Unsaved per-alias model preferences (draft overrides from the trigger
   * modal, CLI flags, or automation config). When present, these overlay
   * stored per-pipeline preferences at execution time. May carry `reset`
   * markers (run-scoped tombstones). Only trusted after the backend's
   * `sanitizeRendererExecuteOptions` allow-lists it.
   */
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
  /**
   * Identifies the shared Canopy Cloud source for this execution. Set by
   * callers whenever the launched pipeline's `info.source === 'shared'`. The
   * executor uses this to fetch + cache a snapshot of the raw pipeline into
   * the execution directory and persist `shared_pipeline_source` on the
   * resulting `ExecutionState`.
   */
  sharedPipeline?: {
    serverId: string;
    remoteId: string;
    /** Present for installed automations; rechecked before every execution. */
    installPin?: PipelineShareInstallPin;
  };
  /**
   * Main-process-only execution metadata describing the already-fetched
   * shared snapshot that should be persisted into `ExecutionState`.
   */
  sharedPipelineSource?: SharedPipelineExecutionSource;
  curatedPipelineSource?: CuratedPipelineExecutionSource;
  /**
   * Main-process-only normalized pipeline override used for rerun/start-over
   * flows that must execute a fresh shared snapshot rather than the persisted
   * source execution's pipeline snapshot.
   */
  pipelineOverride?: Pipeline;
  /**
   * Attribution for the upstream trigger that produced this execution.
   * Persisted onto `ExecutionState.trigger_source` so renderers can show
   * hook attribution alongside the run.
   */
  triggerSource?: PipelineTriggerSource;
  /**
   * Usage-attribution surface for this execution. Stored on ExecutionState so
   * lifecycle events can record pipeline usage without inferring from trigger
   * names such as plan_ready/task_ready.
   */
  executionContext?: string;
  childPipelineAuthorizations?: readonly ChildPipelineAuthorization[];
  /** Fresh attended dispatch only; never persisted or reconstructed for replay. */
  allowUnverifiedForegroundChildren?: boolean;
  initiationSource?: UsageInitiationSource;
  /** Trusted record of who started the run; persisted as `initiator`. */
  initiator?: PipelineExecutionInitiator;
  /** Agent chat whose admission rules apply; persisted as `agent_origin`. */
  agentOrigin?: PipelineAgentChatAddress;
  agentTerminalMode?: boolean;
  /** Main-process-only package input captured into the execution directory. */
  pipelinePackage?: {
    digest: string;
    rawPipeline: string;
    manifest: PipelinePackageManifestV1;
    cachedPackagePath: string;
  };
  /** Transient verified overlay reconstructed from the persisted snapshot. */
  pipelinePackageOverlay?: PipelinePackageCapabilityOverlay;
  /**
   * App Advisor watcher setup requested by a pipeline launch surface. The
   * execution id and pipeline target are supplied by the main-process pipeline
   * handler once the initial execution state exists.
   */
  appAdvisorPipelineWatchers?: Array<{
    destination: AppAdvisorWatcherDestination;
    watcher: AppAdvisorInlineWatcherSetup;
  }>;
}

export type ExecutePipelineRequestOptions = Pick<
  ExecutionOptions,
  | 'pipelineId'
  | 'scope'
  | 'target'
  | 'env'
  | 'inputs'
  | 'repoPath'
  | 'eventName'
  | 'eventData'
  | 'modelConfig'
  | 'projectId'
  | 'worktreeId'
  | 'chatId'
  | 'planId'
  | 'pipelinePreferenceLocator'
  | 'pluginCollectionPreferences'
  | 'modelAliasPreferences'
  | 'sharedPipeline'
  | 'triggerSource'
  | 'initiationSource'
  | 'initiator'
  | 'agentOrigin'
  | 'executionContext'
  | 'childPipelineAuthorizations'
  | 'agentTerminalMode'
  | 'appAdvisorPipelineWatchers'
> & {
  /**
   * Working directory of a project or directory run. Must be absent on a
   * top-level global run; main supplies its scratch folder.
   */
  cwd?: string;
  /**
   * Owner a person chose for a global run of an unowned definition:
   * `personal` or `org:<uuid>`. Valid only with `scope: 'global'`; main
   * validates it and never trusts it over a saved owner.
   */
  requestedOwner?: string;
  pipelineFilePath?: string;
};

/**
 * Resolution result for a child pipeline launched via `builtin/run-pipeline`.
 * Child pipelines must carry an explicit `PipelinePreferenceLocator`;
 * identity is never derived implicitly from `pipelineId` or a file basename.
 *
 *   - stored ref resolved from user/bundled indexes
 *       -> `{ type: 'stored', source, value: ref }`
 *   - relative/discovered file reference        -> `{ type: 'file', value: absolutePath }`
 *   - inline child YAML                         -> `preferenceLocator` omitted
 */
export interface ResolvedChildPipeline {
  pipeline: Pipeline;
  pipelineId: string;
  pipelineFileDir?: string;
  preferenceLocator?: PipelinePreferenceLocator;
}

export interface ExecutionHandle {
  id: string;
  cancel(): Promise<ExecutionState>;
  /** Stop active work and retain checkpoints for explicit resume after app restart. */
  pauseForShutdown?(): Promise<ExecutionState>;
  pauseForAuthentication?(attemptId: string): Promise<ExecutionState>;
  /** As {@link pauseForShutdown}, recording `owner_lost`: a remote owner is gone (CAN-6102). */
  pauseForOwnerLoss?(): Promise<ExecutionState>;
  /** As {@link pauseForShutdown}, recording `core_lost`: its daemon core is gone (CAN-6481). */
  pauseForCoreLoss?(): Promise<ExecutionState>;
  /**
   * A graceful {@link pauseForShutdown} recording `host_rollover`, so the
   * run's host can roll over (CAN-6199): no new step starts, running steps
   * may finish until `drainMs` has passed, and the rest pauses at once when
   * only host waits such as `wait-for-agent-reply` are left running. A host
   * wait pauses as resumable; its replay waits on the same turn.
   * `onCheckpoint` runs as the run's remaining work is stopped. A second
   * call joins the first, moving its deadline only earlier.
   */
  pauseForRollover?(options: {
    readonly drainMs: number;
    readonly onCheckpoint?: () => void;
  }): Promise<ExecutionState>;
  getState(): ExecutionState;
  /** Add observers to an execution that was already active when a caller attached. */
  addObservers?(observers: {
    onEvent?: ExecutionOptions['onEvent'];
    onStepOutput?: ExecutionOptions['onStepOutput'];
  }): () => void;
  /**
   * Resume selected paused jobs without restarting running sibling jobs.
   * `authorization.secretEnv`, when given, replaces the run's secrets for
   * the work that starts after the resume, as a cloud runner's resume
   * redeems them again (CAN-6103).
   */
  resumePaused?(
    statusReasonIds: readonly string[],
    pauseResponses?: readonly PipelinePauseResponse[],
    initiationSource?: UsageInitiationSource,
    portalCommandId?: string,
    authorization?: Pick<
      ExecutionOptions,
      'executionContext' | 'childPipelineAuthorizations' | 'secretEnv'
    >,
  ): Promise<ExecutionState>;
  /** Abort and settle exactly one physical matrix variant. */
  cancelMatrixVariant?(
    jobId: string,
    variantJobId: string,
  ): Promise<ExecutionState>;
  waitForCompletion(): Promise<ExecutionState>;
}

export type PipelineLike = Pipeline | NormalizedPipeline;

export interface AntigravityPromptRunnerRequest extends CursorPromptRunnerRequest {
  thinkingLevel?: ThinkingLevel;
}
export type AntigravityPromptRunnerResult = CodexPromptRunnerResult;
export interface AntigravityPromptRunner {
  runAntigravityPrompt(
    request: AntigravityPromptRunnerRequest,
  ): Promise<AntigravityPromptRunnerResult>;
}
