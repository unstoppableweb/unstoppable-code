import {
  APP_SHUTDOWN,
  pauseInterruptedExecution,
} from '@canopy/execution-engine/node/pipelines/executor/shutdown-recovery';
import {
  beginExecutionPause,
  endExecutionPause,
} from '@canopy/execution-engine/node/pipelines/executor/execution-pause-clock';
import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import { normalizeAgentModelConfig } from '@canopy/execution-engine/execution-types';
import type { UsageInitiationSource } from '@canopy/execution-engine/types/observability';
import {
  brandEnvCandidates,
  setBrandEnv,
} from '@canopy/execution-engine/brand/env';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import {
  buildExpressionAssets,
  buildExpressionContext,
  buildExpressionCanopyIdentity,
  cascadeEnv,
  getNormalizedTriggerInputDefs,
  mergePipelineInputs,
  resolvePipelineInputs,
  type ExpressionCanopyContext,
  type ExpressionNeedsState,
} from './execution-context';
import {
  evaluateCondition,
  evaluateTemplateValue,
  interpolateExpression,
  referencesPhysicalJobContext,
} from './expression-evaluator';
import {
  clearPhysicalJobBlockers,
  CURRENT_EXECUTION_STATE_VERSION,
  clearExecutionCancellation,
  isExecutionStateWriteRefusal,
  findResumePoint,
  isExecutionCancellationRequested,
  loadExecutionState,
  prepareActiveExecutionResume,
  prepareExecutionResume,
  prepareMatrixJobRetryState,
  prepareRetryState,
  requestExecutionCancellation,
  recoverInterruptedState,
  saveExecutionState,
} from './execution-state';
import { runJob } from './job-runner';
import {
  commitMatrixExpansion,
  isJobGroupTerminal,
  materializeInitialJobs,
  mergeGroupOutputs,
  rematerializeJobDefinitions,
  refreshAllJobGroups,
  refreshJobGroup,
} from '@canopy/execution-engine/node/pipelines/executor/job-scheduler';
import {
  applyPauseResponses,
  sortPauseCheckpoints,
} from '@canopy/execution-engine/node/pipelines/executor/pause-checkpoints';
import { isStepTerminal } from './retry-utils';
import { normalizePipeline } from '@canopy/execution-engine/node/pipelines/executor/normalize-pipeline';
import { getDefaultShellTypeForCurrentProcess } from '@canopy/execution-engine/node/pipelines/default-shell';
import { MAX_ITERATIONS_LIMIT } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  expandStaticMatrix,
  MAX_MATRIX_VARIANTS,
  resolveMatrixDefinition,
} from '@canopy/execution-engine/pipelines/matrix';
import { stripBaseBranchEnv } from '@canopy/execution-engine/pipelines/base-branch-env';
import {
  executionContextSatisfies,
  normalizePipelineScopes,
} from '@canopy/execution-engine/pipelines/scope';
import {
  filterModelAliasPreferencesToPipeline,
  normalizeExecutionModelAliasPreferences,
  resolveExecutionModelAliasPreferences,
} from './model-alias-preferences';
import { resolveExecutionPluginCollections } from './plugin-collection-resolution';
import {
  buildPipelinePackageOverlay,
  copyPipelinePackageExecutionSnapshot,
  loadPipelinePackageExecutionOverlay,
  snapshotPipelinePackageForExecution,
} from '@canopy/execution-engine/node/pipelines/package-runtime';
import type {
  CanopyEventData,
  CanopyEventInput,
  ExecutionEvent,
  ExecutionHandle,
  ExecutionOptions,
  ExecutionPlanPersistenceHooks,
  ExecutionRerunContext,
  ExecutionRunPlanPersistence,
  ExecutionRuntime,
  ExecutionState,
  JobResult,
  NormalizedPipeline,
  ReportOutputs,
  StepOutputEvent,
} from './types';
import type {
  PipelineExecutionScope,
  PipelineModelAliasPreference,
  PipelineStatusReason,
  PipelineInputValue,
  MatrixContext,
  PipelinePauseResponse,
  PipelineAssetExecutionContext,
  PipelinePackageCapabilityOverlay,
  RetryMatrixJobRequest,
  ResolvedPipelineExecutionTarget,
} from '@canopy/execution-engine/types/pipeline';

export class MatrixExecutorInactiveError extends Error {
  constructor(executionId: string) {
    super(`Execution "${executionId}" is no longer active in this process`);
    this.name = 'MatrixExecutorInactiveError';
  }
}
import {
  defaultTargetForExecution,
  getExecutionCheckoutRoot,
  inferExecutionScope,
  validateResolvedExecutionTarget,
} from './pipeline-target-resolver';
import { validatePipelineScopes } from './pipeline-scope-validation';
import { createPipelineStepDrain } from './step-drain';
import { pipelineCapacityGateFor } from './capacity-gate';
import {
  claimPipelineOwner,
  pipelineOwnerFence,
  pipelineOwnerFields,
} from '@canopy/execution-engine/node/pipelines/executor/owner-fence';
import {
  consumedStatusReasonIds,
  notePipelineLedgerResuming,
} from './pipeline-ledger';

const EXTERNAL_CANCEL_POLL_MS = 250;

function formatScopes(scopes: readonly PipelineExecutionScope[]): string {
  return scopes.join(', ');
}

async function validateExecutionScopeAndTarget(
  pipelineId: string,
  normalizedPipeline: NormalizedPipeline,
  options: ExecutionOptions,
): Promise<{
  scope: PipelineExecutionScope;
  target: ResolvedPipelineExecutionTarget;
}> {
  const scope = inferExecutionScope(options);
  const target =
    options.target ?? defaultTargetForExecution(scope, options.cwd, options);
  if (!executionContextSatisfies(normalizedPipeline.scope, scope)) {
    throw new Error(
      `Workflow "${pipelineId}" cannot run in scope "${scope}"; supported scopes: ${formatScopes(normalizedPipeline.scope)}`,
    );
  }
  await validateResolvedExecutionTarget(options.runtime, target);
  return { scope, target };
}

function cwdForResolvedTarget(
  target: ResolvedPipelineExecutionTarget,
  fallbackCwd: string,
): string {
  return target.scope === 'global' ? fallbackCwd : target.path;
}

function repoPathForReplayTarget(
  target: ResolvedPipelineExecutionTarget,
  explicitRepoPath: string | undefined,
  persistedRepoPath: string | undefined,
): string | undefined {
  if (target.scope === 'worktree') {
    return explicitRepoPath ?? persistedRepoPath ?? target.path;
  }
  return explicitRepoPath ?? persistedRepoPath;
}

/** Recover only the original selected target of a legacy top-level execution. */
function replayExecutionCheckoutRoot(
  state: ExecutionState,
  options: Pick<ExecutionOptions, 'executionCheckoutRoot'>,
): string | null {
  if (
    state.execution_checkout_root !== undefined &&
    state.execution_checkout_root !== null
  )
    return state.execution_checkout_root;
  if (options.executionCheckoutRoot !== undefined)
    return options.executionCheckoutRoot;
  // A child's target may have been narrowed by with.cwd. Explicit null marks
  // an unknown boundary, rather than a legacy record that can be recovered.
  if (
    state.execution_checkout_root === undefined &&
    !state.parent_execution_id &&
    state.target &&
    state.target.scope !== 'global'
  )
    return state.target.path;
  return null;
}

async function resolveReplayScopeAndTarget(
  state: ExecutionState,
  options: Pick<
    ExecutionOptions,
    'runtime' | 'cwd' | 'scope' | 'projectId' | 'worktreeId'
  >,
  run: { executionId: string; parentExecutionId: string | undefined },
): Promise<{
  scope: PipelineExecutionScope;
  target: ResolvedPipelineExecutionTarget;
  cwd: string;
}> {
  const scope =
    state.scope ??
    inferExecutionScope({
      scope: options.scope,
      projectId: state.project_id ?? options.projectId,
      worktreeId: state.worktree_id ?? options.worktreeId,
    });
  const target =
    state.target ??
    defaultTargetForExecution(scope, options.cwd, {
      projectId: state.project_id ?? options.projectId,
      worktreeId: state.worktree_id ?? options.worktreeId,
    });
  const pipelineScopes = normalizePipelineScopes(
    Reflect.get(state.pipeline_snapshot, 'scope'),
    `Pipeline "${state.pipeline_id}"`,
  );
  if (!executionContextSatisfies(pipelineScopes, scope)) {
    throw new Error(
      `Workflow "${state.pipeline_id}" cannot run in scope "${scope}"; supported scopes: ${formatScopes(pipelineScopes)}`,
    );
  }
  await validateResolvedExecutionTarget(options.runtime, target);
  return {
    scope,
    target,
    cwd: await resolveTopLevelGlobalCwd({
      scope,
      target,
      parentExecutionId: run.parentExecutionId,
      projectId: state.project_id,
      worktreeId: state.worktree_id,
      executionsDir: options.runtime.executionsDir,
      executionId: run.executionId,
      globalWorkspaceDir: state.global_workspace_dir,
      cwd: cwdForResolvedTarget(target, options.cwd),
    }),
  };
}

function getExecutionOutputDir(
  executionsDir: string,
  executionId: string,
): string {
  return path.join(executionsDir, executionId);
}

/**
 * Working folder of a top-level run with no project: `workspace/` inside the
 * execution directory, deleted with it.
 */
export function getGlobalExecutionWorkspaceDir(
  executionsDir: string,
  executionId: string,
): string {
  return path.join(
    getExecutionOutputDir(executionsDir, executionId),
    'workspace',
  );
}

interface TopLevelGlobalRunFacts {
  scope?: PipelineExecutionScope;
  parentExecutionId?: string;
  projectId?: string;
  worktreeId?: string;
  target?: ResolvedPipelineExecutionTarget;
}

/**
 * Whether a run gets its own scratch folder. Shared by main and the executor
 * so both compute the same `cwd`. Global children keep the parent's folder.
 */
export function isTopLevelGlobalRun(facts: TopLevelGlobalRunFacts): boolean {
  return (
    facts.scope === 'global' &&
    facts.parentExecutionId === undefined &&
    !facts.projectId &&
    !facts.worktreeId &&
    (facts.target === undefined || facts.target.scope === 'global')
  );
}

/**
 * The scratch folder of a top-level global run, without creating it: the
 * host's kept workspace when it named one (CAN-6317), else one inside the
 * execution folder.
 */
function topLevelGlobalWorkspaceDir(
  facts: TopLevelGlobalRunFacts & {
    executionsDir: string;
    executionId: string;
    globalWorkspaceDir?: string;
  },
): string | undefined {
  if (!isTopLevelGlobalRun(facts)) return undefined;
  return (
    facts.globalWorkspaceDir ??
    getGlobalExecutionWorkspaceDir(facts.executionsDir, facts.executionId)
  );
}

async function resolveTopLevelGlobalCwd(
  facts: TopLevelGlobalRunFacts & {
    executionsDir: string;
    executionId: string;
    globalWorkspaceDir?: string;
    cwd: string;
  },
): Promise<string> {
  const workspaceDir = topLevelGlobalWorkspaceDir(facts);
  if (workspaceDir === undefined) return facts.cwd;
  await fsp.mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

async function cleanupExecutionTempDir(
  state: ExecutionState,
  runtime: ExecutionRuntime,
): Promise<void> {
  const ownedDir = path.join(runtime.tempRootDir, state.id);
  const planPath = getEventPlanPath(state.event_data);
  if (planPath?.startsWith(ownedDir + path.sep)) {
    return;
  }
  await fsp.rm(ownedDir, { recursive: true, force: true }).catch(() => {});
}

async function hashFile(filePath: string): Promise<string | undefined> {
  try {
    const content = await fsp.readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return undefined;
  }
}

function getEventPlanPath(
  eventData: CanopyEventData | undefined,
): string | undefined {
  return eventData?.plan_ready?.plan_path ?? eventData?.task_ready?.plan_path;
}

async function hashPlanFile(
  state: ExecutionState,
): Promise<string | undefined> {
  const planPath = getEventPlanPath(state.event_data);
  if (!planPath) {
    return undefined;
  }
  return hashFile(planPath);
}

function cloneState(state: ExecutionState): ExecutionState {
  return structuredClone(state);
}

function recordPortalCommandReceipt(
  state: ExecutionState,
  commandId: string | undefined,
): void {
  if (!commandId) return;
  const previous = (state.portal_command_ids ?? []).filter(
    (candidate) => candidate !== commandId,
  );
  state.portal_command_ids = [...previous, commandId];
}

async function loadSharedPipelineSnapshotFromCache(
  state: Pick<ExecutionState, 'id' | 'shared_pipeline_source'>,
): Promise<Pipeline> {
  const cachedPipelinePath = state.shared_pipeline_source?.cachedPipelinePath;
  if (!cachedPipelinePath) {
    throw new Error(
      `Execution "${state.id}" cannot replay its shared workflow because the cached snapshot metadata is missing`,
    );
  }

  let rawPipeline: string;
  try {
    rawPipeline = await fsp.readFile(cachedPipelinePath, 'utf8');
  } catch {
    throw new Error(
      `Execution "${state.id}" cannot replay its shared workflow because the cached snapshot file is unavailable`,
    );
  }

  return parsePipelineText(rawPipeline);
}

export { isKnownOrphanedExecution } from '@canopy/execution-engine/node/pipelines/executor/owner-fence';

function isJobTerminal(job: JobResult): boolean {
  return ['success', 'failure', 'cancelled', 'skipped'].includes(job.status);
}

function markJobSkipped(state: ExecutionState, jobId: string): void {
  const job = state.jobs[jobId];
  const normalizedJob = state.job_definitions[jobId];
  job.status = 'skipped';
  job.outcome = 'skipped';
  job.conclusion = 'skipped';
  job.completed_at = new Date().toISOString();

  for (const step of normalizedJob.steps) {
    if (job.steps[step.id]?.status === 'pending') {
      job.steps[step.id] = {
        status: 'skipped',
        conclusion: 'skipped',
        outcome: 'skipped',
        outputs: {},
        dynamic_env: {},
        completed_at: new Date().toISOString(),
      };
    }
  }
}

function markPendingJobsSkipped(state: ExecutionState): void {
  for (const jobId of Object.keys(state.job_definitions)) {
    const job = state.jobs[jobId];
    if (job.status === 'pending') {
      markJobSkipped(state, jobId);
    }
  }
}

function resolveJobMaxIterations(
  jobId: string,
  job: NormalizedPipeline['jobs'][string],
  context: ReturnType<typeof buildExpressionContext>,
): number | undefined {
  if (!job.max_iterations_expression) {
    return job.max_iterations;
  }

  const resolved = interpolateExpression(
    job.max_iterations_expression,
    context,
  ).trim();
  const parsed = Number(resolved);

  if (
    !resolved ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_ITERATIONS_LIMIT
  ) {
    throw new Error(
      `Job "${jobId}" resolved invalid max_iterations "${resolved}": must be 0-${MAX_ITERATIONS_LIMIT}`,
    );
  }

  return parsed;
}

function markRemainingJobsCancelled(state: ExecutionState): void {
  for (const [jobId, normalizedJob] of Object.entries(state.job_definitions)) {
    const job = state.jobs[jobId];
    if (isJobTerminal(job)) {
      continue;
    }

    job.status = 'cancelled';
    job.outcome = 'cancelled';
    job.conclusion = 'cancelled';
    const completedAt = new Date().toISOString();
    job.completed_at = completedAt;

    for (const step of normalizedJob.steps) {
      const currentStep = job.steps[step.id];
      if (currentStep && !isStepTerminal(currentStep)) {
        const recoveryHistory = currentStep.agent_recovery_history?.map(
          (attempt) =>
            attempt.status === 'running'
              ? {
                  ...attempt,
                  status: 'cancelled' as const,
                  completed_at: new Date().toISOString(),
                }
              : attempt,
        );
        job.steps[step.id] = {
          status: 'cancelled',
          conclusion: 'cancelled',
          outcome: 'cancelled',
          outputs: {},
          dynamic_env: {},
          completed_at: new Date().toISOString(),
          ...(recoveryHistory?.length
            ? { agent_recovery_history: recoveryHistory }
            : {}),
          recovery_count: currentStep.recovery_count,
        };
      }
    }
  }
}

function markPendingInputStepsCancelled(state: ExecutionState): void {
  const completedAt = new Date().toISOString();
  for (const job of Object.values(state.jobs)) {
    if (job.status !== 'paused') continue;
    for (const [stepId, step] of Object.entries(job.steps)) {
      if (!step.input_request && !step.pause_requested) continue;
      job.steps[stepId] = {
        status: 'cancelled',
        conclusion: 'cancelled',
        outcome: 'cancelled',
        outputs: {},
        dynamic_env: {},
        completed_at: completedAt,
      };
    }
  }
  state.pending_pauses = [];
}

function syncPendingPauseForJob(
  state: ExecutionState,
  physicalJobId: string,
): void {
  const job = state.jobs[physicalJobId];
  const definition = state.job_definitions[physicalJobId];
  if (!job || !definition) return;
  const pausedStep = Object.entries(job.steps).find(
    ([, step]) => step.input_request || step.pause_requested,
  );
  if (job.status !== 'paused' || !pausedStep) {
    state.pending_pauses = state.pending_pauses.filter(
      (checkpoint) => checkpoint.job_id !== physicalJobId,
    );
    return;
  }
  const [stepId, step] = pausedStep;
  const existing = state.pending_pauses.find(
    (checkpoint) =>
      checkpoint.job_id === physicalJobId && checkpoint.step_id === stepId,
  );
  const reason = state.status_reasons.find(
    (candidate) =>
      candidate.source.job_id === physicalJobId &&
      candidate.source.step_id === stepId &&
      (candidate.kind === 'input_required' ||
        candidate.kind === 'action_paused'),
  );
  const checkpoint = {
    id: existing?.id ?? randomUUID(),
    kind: step.input_request ? ('input' as const) : ('action' as const),
    job_id: physicalJobId,
    logical_job_id: definition.logical_job_id,
    step_id: stepId,
    attempt: reason?.source.attempt ?? job.retry_count ?? 0,
    iteration: reason?.source.iteration ?? job.iteration_count ?? 1,
    detected_at:
      existing?.detected_at ?? reason?.detected_at ?? new Date().toISOString(),
    ...(step.input_request ? { request: step.input_request } : {}),
  };
  state.pending_pauses = [
    ...state.pending_pauses.filter(
      (candidate) => candidate.job_id !== physicalJobId,
    ),
    checkpoint,
  ];
}

function buildCanopyFromState(state: ExecutionState): ExpressionCanopyContext {
  const pipelineDataDir = state.pipeline_assets?.pipeline_data_dir;
  return {
    event_name: state.event_name ?? 'dispatch',
    event: state.event_data ?? {},
    ...buildExpressionCanopyIdentity({
      projectId: state.project_id,
      worktreeId: state.worktree_id,
      executionContext: state.execution_context,
      initiator: state.initiator,
    }),
    ...(pipelineDataDir === undefined
      ? {}
      : { pipeline_data_dir: pipelineDataDir }),
  };
}

/** The asset context main resolved for this run, when it resolved one. */
function pipelineAssetContextFromOptions(
  options: Pick<
    ExecutionOptions,
    'assetPaths' | 'pipelineDataDir' | 'assetsDir'
  >,
): PipelineAssetExecutionContext | undefined {
  if (
    options.assetPaths === undefined &&
    options.pipelineDataDir === undefined &&
    options.assetsDir === undefined
  ) {
    return undefined;
  }
  return {
    asset_paths: { ...(options.assetPaths ?? {}) },
    ...(options.pipelineDataDir === undefined
      ? {}
      : { pipeline_data_dir: options.pipelineDataDir }),
    ...(options.assetsDir === undefined
      ? {}
      : { assets_dir: options.assetsDir }),
  };
}

async function materializeEventData(
  eventData: CanopyEventInput | undefined,
  executionsDir: string,
  executionId: string,
): Promise<CanopyEventData> {
  if (!eventData) {
    return {};
  }
  const planReady = eventData.plan_ready;
  if (planReady) {
    if (planReady.plan_path) {
      return {
        plan_ready: {
          plan_path: planReady.plan_path,
          ...(planReady.planId ? { planId: planReady.planId } : {}),
        },
      };
    }
    if (!planReady.plan_text) {
      return {};
    }
    const planDir = getExecutionOutputDir(executionsDir, executionId);
    await fsp.mkdir(planDir, { recursive: true });
    const planPath = path.join(planDir, 'plan.md');
    await fsp.writeFile(planPath, planReady.plan_text, 'utf8');
    return {
      plan_ready: {
        plan_path: planPath,
        ...(planReady.planId ? { planId: planReady.planId } : {}),
      },
    };
  }

  const taskReady = eventData.task_ready;
  if (!taskReady) {
    return {};
  }
  if (!taskReady.task_path && !taskReady.task_text) {
    throw new Error('task_ready event requires either task_text or task_path');
  }

  const outputDir = getExecutionOutputDir(executionsDir, executionId);
  await fsp.mkdir(outputDir, { recursive: true });

  let taskPath = taskReady.task_path;
  if (!taskPath) {
    const taskText = taskReady.task_text;
    if (!taskText) {
      throw new Error(
        'task_ready event requires either task_text or task_path',
      );
    }
    taskPath = path.join(outputDir, 'task.md');
    await fsp.writeFile(taskPath, taskText, 'utf8');
  }

  const planPath =
    taskReady.plan_path && taskReady.plan_path.trim().length > 0
      ? taskReady.plan_path
      : path.join(outputDir, 'plan.md');

  return {
    task_ready: {
      task_path: taskPath,
      plan_path: planPath,
    },
  };
}

async function buildRerunContext(
  eventData: CanopyEventInput | undefined,
): Promise<ExecutionRerunContext | undefined> {
  const planReady = eventData?.plan_ready;
  if (planReady) {
    if (planReady.plan_text) {
      return {
        event_data: {
          plan_ready: {
            plan_text: planReady.plan_text,
          },
        },
      };
    }

    if (!planReady.plan_path) {
      return undefined;
    }

    try {
      const planText = await fsp.readFile(planReady.plan_path, 'utf8');
      return {
        event_data: {
          plan_ready: {
            plan_text: planText,
          },
        },
      };
    } catch {
      // Plan file unavailable — proceed without rerun metadata
      return undefined;
    }
  }

  const taskReady = eventData?.task_ready;
  if (!taskReady) {
    return undefined;
  }

  if (taskReady.task_text) {
    return {
      event_data: {
        task_ready: {
          task_text: taskReady.task_text,
        },
      },
    };
  }

  if (!taskReady.task_path) {
    return undefined;
  }

  try {
    const taskText = await fsp.readFile(taskReady.task_path, 'utf8');
    return {
      event_data: {
        task_ready: {
          task_text: taskText,
        },
      },
    };
  } catch {
    // Task file unavailable — proceed without rerun metadata
    return undefined;
  }
}

async function derivePlanContent(
  eventData: CanopyEventInput | undefined,
): Promise<string | null> {
  const planReady = eventData?.plan_ready;
  if (!planReady) {
    return null;
  }

  if (planReady.plan_text) {
    return planReady.plan_text;
  }

  if (!planReady.plan_path) {
    return null;
  }

  try {
    return await fsp.readFile(planReady.plan_path, 'utf8');
  } catch {
    return null;
  }
}

interface ExecutionPlanArtifact {
  content: string;
  path: string;
}

async function readExecutionPlanArtifact(
  state: Pick<ExecutionState, 'event_data' | 'plan_hash_after'>,
): Promise<ExecutionPlanArtifact | null> {
  if (state.plan_hash_after === undefined) {
    return null;
  }

  const planPath = getEventPlanPath(state.event_data);
  if (!planPath) {
    return null;
  }

  try {
    const content = await fsp.readFile(planPath, 'utf8');
    return {
      content,
      path: planPath,
    };
  } catch {
    return null;
  }
}

async function resolvePlanIdForExecution(
  executionId: string,
  options: ExecutionOptions,
): Promise<string | undefined> {
  if (options.planId) {
    await linkExecutionToExistingPlan(executionId, options.planId, options);
    return options.planId;
  }

  const inheritedPlanId = options.eventData?.plan_ready?.planId;
  if (inheritedPlanId) {
    await linkExecutionToExistingPlan(executionId, inheritedPlanId, options);
    return inheritedPlanId;
  }

  const runPlans = options.runtime.runPlanPersistence;
  if (
    options.eventName !== 'plan_ready' ||
    (!runPlans && (!options.projectId || !options.worktreeId))
  ) {
    return undefined;
  }

  const content = await derivePlanContent(options.eventData);
  if (!content) {
    return undefined;
  }

  // An owner that can't keep the plan now doesn't stop the run: its end
  // keeps the plan it wrote (keepRunPlanFromExecution).
  if (runPlans) {
    return (
      await runPlans.createPlan({ content, starting: true }).catch(() => null)
    )?.id;
  }
  if (!options.projectId || !options.worktreeId) {
    return undefined;
  }
  const planPersistence = await resolvePlanPersistence(options.runtime);
  const trackedPlan = await planPersistence.createTrackedPlan({
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    source: 'pipeline',
    content,
    reviewStatus: 'approved',
    linkedExecutionId: executionId,
  });
  return trackedPlan.id;
}

// Link an execution to its already-tracked plan as soon as the run starts.
// "Implemented" plans really mean "implementation started", so the link (and the
// derived implementationStartedAt telemetry signal) should appear in the web
// feed while the pipeline is still active rather than only once it settles. The
// terminal-state upsert remains the fallback and still handles final approval
// and content changes. Linking is idempotent — the persistence layer dedupes
// execution ids — and is a no-op when the plan no longer exists locally.
async function linkExecutionToExistingPlan(
  executionId: string,
  planId: string,
  options: ExecutionOptions,
): Promise<void> {
  const runPlans = options.runtime.runPlanPersistence;
  if (runPlans) {
    // A link the owner refuses or can't record doesn't stop the run, as a
    // tracked plan that no longer exists doesn't.
    await runPlans
      .updatePlan({ planId, approve: false, starting: true })
      .catch(() => undefined);
    return;
  }
  if (!options.projectId || !options.worktreeId) {
    return;
  }

  const planPersistence = await resolvePlanPersistence(options.runtime);
  await planPersistence.updateTrackedPlan({
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    planId,
    linkedExecutionId: executionId,
  });
}

async function resolvePlanPersistence(
  runtime: ExecutionRuntime,
): Promise<ExecutionPlanPersistenceHooks> {
  if (runtime.planPersistence) {
    return runtime.planPersistence;
  }

  return import('@canopy/execution-engine/node/lib/plan-persistence');
}

/**
 * The terminal plan upsert for a run whose owner keeps its plan (CAN-6327),
 * as `upsertTrackedPlanFromExecution` does it for desktop's tracked plans:
 * a run with no plan keeps the one it wrote, and a run with one records
 * what it changed and approves it.
 */
async function keepRunPlanFromExecution(
  state: ExecutionState,
  runPlans: ExecutionRunPlanPersistence,
): Promise<void> {
  const artifact = await readExecutionPlanArtifact(state);
  if (!state.planId) {
    if (!artifact) {
      return;
    }
    const kept = await runPlans.createPlan({ content: artifact.content });
    if (kept) {
      state.planId = kept.id;
    }
    return;
  }

  const planWasModified =
    state.plan_hash_before !== undefined &&
    state.plan_hash_after !== undefined &&
    state.plan_hash_before !== state.plan_hash_after;
  await runPlans.updatePlan({
    planId: state.planId,
    ...(planWasModified && artifact ? { content: artifact.content } : {}),
    approve: true,
  });
}

async function upsertTrackedPlanFromExecution(
  state: ExecutionState,
  runtime: ExecutionRuntime,
): Promise<void> {
  if (runtime.runPlanPersistence) {
    await keepRunPlanFromExecution(state, runtime.runPlanPersistence);
    return;
  }
  if (!state.project_id || !state.worktree_id) {
    return;
  }

  const artifact = await readExecutionPlanArtifact(state);
  if (!state.planId) {
    if (!artifact) {
      return;
    }

    const planPersistence = await resolvePlanPersistence(runtime);
    const trackedPlan = await planPersistence.createTrackedPlan({
      projectId: state.project_id,
      worktreeId: state.worktree_id,
      source: 'pipeline',
      content: artifact.content,
      reviewStatus: 'approved',
      linkedExecutionId: state.id,
    });
    state.planId = trackedPlan.id;
    return;
  }

  const planPersistence = await resolvePlanPersistence(runtime);

  const planWasModified =
    state.plan_hash_before !== undefined &&
    state.plan_hash_after !== undefined &&
    state.plan_hash_before !== state.plan_hash_after;
  const approvedAt = new Date().toISOString();

  if (planWasModified && artifact) {
    await planPersistence.updateTrackedPlan({
      projectId: state.project_id,
      worktreeId: state.worktree_id,
      planId: state.planId,
      content: artifact.content,
      source: 'pipeline',
      reviewStatus: 'approved',
      approvedAt,
      dismissedAt: null,
      linkedExecutionId: state.id,
    });
    return;
  }

  await planPersistence.updateTrackedPlan({
    projectId: state.project_id,
    worktreeId: state.worktree_id,
    planId: state.planId,
    source: 'pipeline',
    reviewStatus: 'approved',
    approvedAt,
    dismissedAt: null,
    linkedExecutionId: state.id,
  });
}

function stripExecutorManagedEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const next: Record<string, string> = {};
  const outputDirEnvNames = new Set(brandEnvCandidates('OUTPUT_DIR'));
  for (const [key, value] of Object.entries(env ?? {})) {
    if (outputDirEnvNames.has(key) || value === undefined) {
      continue;
    }

    next[key] = value;
  }

  return next;
}

function withExecutionOutputDirEnv(
  env: Record<string, string | undefined> | undefined,
  executionOutputDir: string,
): Record<string, string> {
  const next: Record<string, string | undefined> = { ...(env ?? {}) };
  setBrandEnv(next, 'OUTPUT_DIR', executionOutputDir);
  return Object.fromEntries(
    Object.entries(next).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function stripReplayManagedEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  return stripExecutorManagedEnv(stripBaseBranchEnv(env ?? {}));
}

function collectReportOutputs(
  state: ExecutionState,
): ReportOutputs | undefined {
  let merged: ReportOutputs | undefined;

  for (const job of Object.values(state.jobs)) {
    if (job.report_outputs) {
      merged = {
        ...merged,
        ...job.report_outputs,
      };
    }
  }

  return merged;
}

export function findPendingInput(
  state: ExecutionState,
): ExecutionState['pending_input'] | undefined {
  return findPendingInputs(state)[0];
}

export function findPendingInputs(
  state: ExecutionState,
): NonNullable<ExecutionState['pending_input']>[] {
  if (state.pending_pauses) {
    return state.pending_pauses.flatMap((checkpoint) =>
      checkpoint.request
        ? [
            {
              job_id: checkpoint.job_id,
              step_id: checkpoint.step_id,
              request: checkpoint.request,
            },
          ]
        : [],
    );
  }
  if (state.pending_input) return [state.pending_input];
  return Object.entries(state.jobs).flatMap(([jobId, job]) =>
    job.status === 'paused'
      ? Object.entries(job.steps).flatMap(([stepId, step]) =>
          step.input_request
            ? [
                {
                  job_id: jobId,
                  step_id: stepId,
                  request: step.input_request,
                },
              ]
            : [],
        )
      : [],
  );
}

export function formatPendingInputCheckpoint(
  _state: ExecutionState,
  input: NonNullable<ExecutionState['pending_input']>,
): string {
  return `${input.job_id}.${input.step_id}`;
}

export function cancelRecoveredExecutionState(
  state: ExecutionState,
): ExecutionState {
  const cancelledState = recoverInterruptedState(state);
  markRemainingJobsCancelled(cancelledState);
  refreshAllJobGroups(cancelledState);
  cancelledState.report_outputs = collectReportOutputs(cancelledState);
  cancelledState.status = 'cancelled';
  cancelledState.completed_at = new Date().toISOString();
  endExecutionPause(cancelledState, cancelledState.completed_at);
  cancelledState.pending_input = undefined;
  cancelledState.pending_pauses = [];
  cancelledState.status_reasons = [];
  return cancelledState;
}

export function groupJobsByTier(
  normalizedPipeline: NormalizedPipeline,
): string[][] {
  const jobIds = Object.keys(normalizedPipeline.jobs);
  const remainingNeeds = new Map(
    jobIds.map((jobId) => [
      jobId,
      new Set(normalizedPipeline.jobs[jobId].needs),
    ]),
  );
  const emitted = new Set<string>();
  const tiers: string[][] = [];

  while (emitted.size < jobIds.length) {
    const tier = jobIds.filter((jobId) => {
      const needs = remainingNeeds.get(jobId);
      return !emitted.has(jobId) && needs !== undefined && needs.size === 0;
    });

    if (tier.length === 0) {
      throw new Error('Unable to determine pipeline execution tiers');
    }

    tiers.push(tier);
    for (const jobId of tier) {
      emitted.add(jobId);
      for (const needs of Array.from(remainingNeeds.values())) {
        needs.delete(jobId);
      }
    }
  }

  return tiers;
}

export function createInitialState(
  normalizedPipeline: NormalizedPipeline,
  options: ExecutionOptions,
  executionId: string,
  resolvedInputs: Record<string, PipelineInputValue> = {},
  materializedEventData?: CanopyEventData,
  rerunContext?: ExecutionRerunContext,
  rerunSourceId?: string,
): ExecutionState {
  const executionOutputDir = getExecutionOutputDir(
    options.runtime.executionsDir,
    executionId,
  );
  const materializedJobs = materializeInitialJobs(normalizedPipeline);
  const pipelineAssets = pipelineAssetContextFromOptions(options);
  return {
    version: CURRENT_EXECUTION_STATE_VERSION,
    id: executionId,
    pipeline_id: options.pipelineId,
    pipeline_snapshot: normalizedPipeline,
    status: 'pending',
    status_reasons: [],
    jobs: materializedJobs.jobs,
    job_definitions: materializedJobs.jobDefinitions,
    job_groups: materializedJobs.jobGroups,
    pending_pauses: [],
    started_at: new Date().toISOString(),
    ...pipelineOwnerFields(),
    cwd: options.cwd,
    scope: options.scope,
    target: options.target,
    env: withExecutionOutputDirEnv(options.env, executionOutputDir),
    inputs: { ...resolvedInputs },
    pipeline_file_dir: options.pipelineFileDir,
    ...(pipelineAssets === undefined
      ? {}
      : { pipeline_assets: pipelineAssets }),
    event_name: options.eventName ?? 'dispatch',
    event_data: materializedEventData,
    model_config: normalizeAgentModelConfig(options.modelConfig),
    repo_path: options.repoPath,
    execution_checkout_root: getExecutionCheckoutRoot(options),
    ...(options.globalWorkspaceDir === undefined
      ? {}
      : { global_workspace_dir: options.globalWorkspaceDir }),
    project_id: options.projectId,
    worktree_id: options.worktreeId,
    planId: options.planId,
    rerun_context: rerunContext,
    rerun_source_id: rerunSourceId,
    parent_execution_id: options.parentExecutionId,
    parent_step_id: options.parentStepId,
    parent_attempt: options.parentAttempt,
    parent_iteration: options.parentIteration,
    trigger_source: options.triggerSource,
    initiation_source: options.initiationSource,
    ...(options.initiator === undefined
      ? {}
      : { initiator: options.initiator }),
    ...(options.agentOrigin === undefined
      ? {}
      : { agent_origin: options.agentOrigin }),
    ...(options.executionContext === undefined
      ? {}
      : { execution_context: options.executionContext }),
    ...(options.childPipelineAuthorizations === undefined
      ? {}
      : { child_pipeline_authorizations: options.childPipelineAuthorizations }),
    pipeline_preference_locator: options.pipelinePreferenceLocator,
    plugin_collection_preferences: options.pluginCollectionPreferences,
    model_alias_preferences: resolveExecutionModelAliasPreferences(
      normalizedPipeline,
      options,
    ),
    shared_pipeline_source: options.sharedPipelineSource,
    curated_pipeline_source: options.curatedPipelineSource,
  };
}

export function createPipelineExecutionId(): string {
  return randomUUID();
}

function overlayModelAliasPreferences(
  normalizedPipeline: NormalizedPipeline,
  basePreferences: Record<string, PipelineModelAliasPreference> | undefined,
  draftPreferences: unknown,
): Record<string, PipelineModelAliasPreference> | undefined {
  return filterModelAliasPreferencesToPipeline(normalizedPipeline, {
    ...normalizeExecutionModelAliasPreferences(basePreferences),
    ...normalizeExecutionModelAliasPreferences(draftPreferences),
  });
}

export function buildNeedsContext(
  state: ExecutionState,
  jobId: string,
  normalizedPipeline: NormalizedPipeline,
): Record<string, ExpressionNeedsState> {
  return Object.fromEntries(
    normalizedPipeline.jobs[jobId].needs.map((dependencyId) => {
      const group = state.job_groups[dependencyId];
      return [
        dependencyId,
        {
          outputs: mergeGroupOutputs(state, dependencyId),
          result: group?.conclusion,
          ...(group?.kind === 'matrix'
            ? {
                children: group.variant_job_ids.map((physicalJobId) => {
                  const child = state.jobs[physicalJobId];
                  const definition = state.job_definitions[physicalJobId];
                  return {
                    job_id: physicalJobId,
                    matrix: structuredClone(definition?.matrix?.values ?? {}),
                    status: child?.status ?? 'pending',
                    result: child?.conclusion,
                    conclusion: child?.conclusion,
                    outcome: child?.outcome,
                    outputs: { ...(child?.outputs ?? {}) },
                  };
                }),
              }
            : {}),
        },
      ];
    }),
  );
}

function executeState(
  state: ExecutionState,
  options: Omit<ExecutionOptions, 'pipelineId' | 'executionId'> & {
    executionId?: string;
  },
): ExecutionHandle {
  const normalizedPipeline = state.pipeline_snapshot;
  const abortController = new AbortController();
  const currentState = state;
  let completionResolve!: (state: ExecutionState) => void;
  let completionReject!: (error: unknown) => void;
  const completionPromise = new Promise<ExecutionState>((resolve, reject) => {
    completionResolve = resolve;
    completionReject = reject;
  });
  const eventObservers = new Set<NonNullable<ExecutionOptions['onEvent']>>();
  const stepOutputObservers = new Set<
    NonNullable<ExecutionOptions['onStepOutput']>
  >();
  if (options.onEvent) eventObservers.add(options.onEvent);
  if (options.onStepOutput) stepOutputObservers.add(options.onStepOutput);
  const dispatchExecutionEvent = (event: ExecutionEvent): void => {
    eventObservers.forEach((observer) => observer(event));
  };
  const dispatchStepOutput = (event: StepOutputEvent): void => {
    stepOutputObservers.forEach((observer) => observer(event));
  };

  const emitEvent = (
    type: ExecutionEvent['type'],
    snapshot: ExecutionState,
  ): void => {
    dispatchExecutionEvent({
      executionId: snapshot.id,
      type,
      state: cloneState(snapshot),
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * The owner fence closed (CAN-6198): this incarnation's lease lapsed or a
   * newer one took the run. The loop stops and writes nothing more; the
   * newer incarnation runs the work again from what was saved.
   */
  const ownerFence = pipelineOwnerFence().fenced;
  let fenced = false;
  let persistQueue = Promise.resolve();
  const persistState = (
    type: ExecutionEvent['type'] = 'execution.updated',
    mutator?: () => void,
  ): Promise<void> => {
    persistQueue = persistQueue.then(async () => {
      mutator?.();
      const snapshot = cloneState(currentState);
      await saveExecutionState(snapshot, options.runtime.executionsDir);
      // A save admitted before the fence closed reports nothing (CAN-6198).
      if (!fenced) emitEvent(type, snapshot);
    });
    return persistQueue;
  };
  const stateWriter = {
    persist: (
      mutator?: () => void,
      type: 'execution.updated' = 'execution.updated',
    ): Promise<void> => persistState(type, mutator),
    flush: (): Promise<void> => persistQueue,
  };

  const recordStatusReason = (reason: PipelineStatusReason): void => {
    if (
      reason.source.child_execution_id &&
      reason.source.child_reason_id &&
      currentState.status_reasons.some(
        (existing) =>
          existing.source.child_execution_id ===
            reason.source.child_execution_id &&
          existing.source.child_reason_id === reason.source.child_reason_id,
      )
    ) {
      return;
    }
    currentState.status_reasons = [
      ...currentState.status_reasons.filter(
        (existing) => existing.id !== reason.id,
      ),
      reason,
    ].sort(
      (left, right) =>
        left.detected_at.localeCompare(right.detected_at) ||
        left.source.job_id.localeCompare(right.source.job_id) ||
        left.source.step_id.localeCompare(right.source.step_id) ||
        left.id.localeCompare(right.id),
    );
  };

  let acceptingLiveResumes = true;
  const liveResumeRequests = new Set<Promise<ExecutionState>>();
  const activeLiveJobRuns = new Map<string, Promise<void>>();
  const pendingLiveJobRuns = new Set<Promise<void>>();
  const activePhysicalRuns = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  const activeMatrixGroupSlots = new Map<string, Set<string>>();
  type MatrixGroupSlotWaiter = () => void;
  const matrixGroupSlotWaiters = new Map<string, Set<MatrixGroupSlotWaiter>>();
  const notifyMatrixGroupSlotAvailable = (logicalJobId: string): void => {
    const waiters = matrixGroupSlotWaiters.get(logicalJobId);
    if (!waiters) return;
    matrixGroupSlotWaiters.delete(logicalJobId);
    const pendingWaiters: MatrixGroupSlotWaiter[] = Array.from(waiters);
    pendingWaiters.forEach((wake) => wake());
  };
  const acquireMatrixGroupSlot = async (
    logicalJobId: string,
    physicalJobId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    while (!signal.aborted) {
      const active =
        activeMatrixGroupSlots.get(logicalJobId) ?? new Set<string>();
      activeMatrixGroupSlots.set(logicalJobId, active);
      if (active.has(physicalJobId)) return true;
      const group = currentState.job_groups[logicalJobId];
      const maxParallel = Math.max(
        1,
        group?.resolved_max_parallel ?? group?.variant_job_ids.length ?? 1,
      );
      if (active.size < maxParallel) {
        active.add(physicalJobId);
        return true;
      }
      await new Promise<void>((resolve) => {
        const waiters =
          matrixGroupSlotWaiters.get(logicalJobId) ??
          new Set<MatrixGroupSlotWaiter>();
        const onAbort = (): void => {
          waiters.delete(wake);
          resolve();
        };
        const wake = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        waiters.add(wake);
        matrixGroupSlotWaiters.set(logicalJobId, waiters);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }
    return false;
  };
  const releaseMatrixGroupSlot = (
    logicalJobId: string,
    physicalJobId: string,
  ): void => {
    const active = activeMatrixGroupSlots.get(logicalJobId);
    active?.delete(physicalJobId);
    if (active?.size === 0) activeMatrixGroupSlots.delete(logicalJobId);
    notifyMatrixGroupSlotAvailable(logicalJobId);
  };
  let shutdownJobs: Set<string> | undefined;
  let authenticationPause:
    | { attemptId: string; existingReasons: Set<string> }
    | undefined;
  /** Reasons that predate an owner-loss pause; the rest it relabels (CAN-6102). */
  let ownerLossPause: { existingReasons: Set<string> } | undefined;
  /**
   * A graceful checkpoint for a host rollover (CAN-6199): the reasons that
   * predate it, which it leaves alone, and when its drain gives up waiting.
   */
  let rolloverPause:
    | {
        existingReasons: Set<string>;
        deadlineAt: number;
        timer: ReturnType<typeof setTimeout>;
        onCheckpoint: (() => void)[];
        stopped: boolean;
      }
    | undefined;
  const stepDrain = createPipelineStepDrain();
  const capacityGate = pipelineCapacityGateFor(options.runtime.resourceMonitor);
  /** Stops the run's remaining work; its interrupted jobs pause once they stop. */
  const stopAtCheckpoint = (): void => {
    const nonTerminalJobs = new Set(
      Object.entries(currentState.jobs)
        .filter(([, job]) => !isJobTerminal(job))
        .map(([id]) => id),
    );
    acceptingLiveResumes = false;
    if (nonTerminalJobs.size === 0) return;
    shutdownJobs = nonTerminalJobs;
    abortController.abort(APP_SHUTDOWN);
  };
  const checkpointRollover = (): void => {
    if (!rolloverPause || rolloverPause.stopped) return;
    rolloverPause.stopped = true;
    clearTimeout(rolloverPause.timer);
    // Even once the run stopped taking live resumes: a live-resumed job may
    // still wait in the drain. Its work stops before its callers' cleanup runs.
    if (!abortController.signal.aborted) stopAtCheckpoint();
    for (const stop of rolloverPause.onCheckpoint) stop();
  };
  /** The drain's end: whatever still runs then is checkpointed (CAN-6199). */
  const rolloverDeadline = (ms: number): ReturnType<typeof setTimeout> =>
    setTimeout(checkpointRollover, ms);
  const settleRollover = (): void => {
    if (rolloverPause) clearTimeout(rolloverPause.timer);
    stepDrain.release();
  };
  void completionPromise.then(settleRollover, settleRollover);
  const abortExecution = (): void => {
    acceptingLiveResumes = false;
    abortController.abort();
  };
  const stopFenced = (): void => {
    fenced = true;
    abortExecution();
  };

  const runJobResult = (
    jobId: string,
    normalizedJob: ExecutionState['job_definitions'][string],
    jobResult: JobResult,
    needs: Record<string, ExpressionNeedsState>,
    signal: AbortSignal,
    matrix?: MatrixContext,
    saveState: () => Promise<void> = persistState,
  ): Promise<JobResult> =>
    runJob({
      executionId: currentState.id,
      jobId,
      pipeline: normalizedPipeline,
      job: normalizedJob,
      jobResult,
      cwd: currentState.cwd,
      env: cascadeEnv(
        currentState.env,
        normalizedPipeline.env,
        normalizedJob.env,
      ),
      pipelineFileDir: currentState.pipeline_file_dir,
      ...(options.pipelineSource
        ? { pipelineSource: options.pipelineSource }
        : {}),
      ...(options.inlinePipelineResource
        ? { inlinePipelineResource: options.inlinePipelineResource }
        : {}),
      secretEnv: options.secretEnv,
      runtime: options.runtime,
      repoPath: currentState.repo_path,
      executionCheckoutRoot: currentState.execution_checkout_root ?? null,
      scope: currentState.scope,
      target: currentState.target,
      modelConfig: currentState.model_config,
      depth: options.depth,
      needs,
      inputs: currentState.inputs,
      canopy: buildCanopyFromState(currentState),
      pipelineAssets: currentState.pipeline_assets,
      signal,
      saveState,
      onStepOutput: dispatchStepOutput,
      onEvent: dispatchExecutionEvent,
      projectId: currentState.project_id,
      worktreeId: currentState.worktree_id,
      initiationSource: currentState.initiation_source,
      initiator: currentState.initiator,
      agentOrigin: currentState.agent_origin,
      ...((options.childPipelineAuthorizations ??
        currentState.child_pipeline_authorizations) === undefined
        ? {}
        : {
            childPipelineAuthorizations:
              options.childPipelineAuthorizations ??
              currentState.child_pipeline_authorizations,
          }),
      ...(options.allowUnverifiedForegroundChildren
        ? { allowUnverifiedForegroundChildren: true }
        : {}),
      ...(currentState.execution_context === undefined
        ? {}
        : { executionContext: currentState.execution_context }),
      agentTerminalMode: options.agentTerminalMode,
      pipelineId: currentState.pipeline_id,
      pipelineName: currentState.pipeline_snapshot.name,
      resolvedPluginCollections: currentState.resolved_plugin_collections,
      modelAliases: currentState.pipeline_snapshot.model_aliases,
      modelAliasPreferences: currentState.model_alias_preferences,
      onStatusReason: recordStatusReason,
      matrix,
      pipelinePackageOverlay: options.pipelinePackageOverlay,
      pipelinePackageBindings: currentState.pipeline_package_snapshot?.bindings,
      pipelinePackageLogicalJobId:
        'logical_job_id' in normalizedJob
          ? normalizedJob.logical_job_id
          : jobId,
      stepDrain,
      ...(capacityGate
        ? {
            capacity: {
              gate: capacityGate,
              // A worktree run shares its sandbox with the worktree's chats.
              keepChatReserve: currentState.scope === 'worktree',
            },
          }
        : {}),
    });
  const applyMatrixFailFast = async (
    logicalJobId: string,
    failedJobId: string,
  ): Promise<void> => {
    const failedJob = currentState.jobs[failedJobId];
    const group = currentState.job_groups[logicalJobId];
    if (failedJob?.conclusion !== 'failure' || !group?.fail_fast) return;

    const completedAt = new Date().toISOString();
    for (const siblingId of group.variant_job_ids) {
      if (siblingId === failedJobId) continue;
      const sibling = currentState.jobs[siblingId];
      if (!sibling || isJobTerminal(sibling)) continue;
      activePhysicalRuns.get(siblingId)?.controller.abort();
      sibling.status = 'cancelled';
      sibling.outcome = 'cancelled';
      sibling.conclusion = 'cancelled';
      sibling.completed_at = completedAt;
      for (const step of Object.values(sibling.steps)) {
        if (isStepTerminal(step)) continue;
        step.status = 'cancelled';
        step.outcome = 'cancelled';
        step.conclusion = 'cancelled';
        step.completed_at = completedAt;
      }
      clearPhysicalJobBlockers(currentState, siblingId);
    }
    currentState.pending_pauses = currentState.pending_pauses.filter(
      (checkpoint) => checkpoint.logical_job_id !== logicalJobId,
    );
    refreshJobGroup(currentState, logicalJobId);
    await persistState();
  };
  const runLiveResumedJob = (jobId: string): Promise<void> => {
    const existing = activeLiveJobRuns.get(jobId);
    if (existing) return existing;
    const job = currentState.jobs[jobId];
    const normalizedJob = currentState.job_definitions[jobId];
    if (!job || !normalizedJob) {
      return Promise.reject(
        new Error(`Cannot resume missing pipeline job "${jobId}"`),
      );
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([abortController.signal, controller.signal]);
    const savePhysicalState = async (): Promise<void> => {
      syncPendingPauseForJob(currentState, jobId);
      refreshJobGroup(currentState, normalizedJob.logical_job_id);
      sortPauseCheckpoints(currentState);
      await persistState();
    };
    const run = (async (): Promise<void> => {
      const acquired = await acquireMatrixGroupSlot(
        normalizedJob.logical_job_id,
        jobId,
        signal,
      );
      if (!acquired) return;
      try {
        const needs = buildNeedsContext(
          currentState,
          normalizedJob.logical_job_id,
          normalizedPipeline,
        );
        await runJobResult(
          jobId,
          normalizedJob,
          job,
          needs,
          signal,
          normalizedJob.matrix?.values,
          savePhysicalState,
        );
        await applyMatrixFailFast(normalizedJob.logical_job_id, jobId);
      } finally {
        releaseMatrixGroupSlot(normalizedJob.logical_job_id, jobId);
      }
    })();
    const trackedRun: Promise<void> = run.finally(() => {
      if (activeLiveJobRuns.get(jobId) === trackedRun) {
        activeLiveJobRuns.delete(jobId);
      }
      activePhysicalRuns.delete(jobId);
      syncPendingPauseForJob(currentState, jobId);
      refreshJobGroup(currentState, normalizedJob.logical_job_id);
    });
    activePhysicalRuns.set(jobId, { controller, promise: trackedRun });
    activeLiveJobRuns.set(jobId, trackedRun);
    pendingLiveJobRuns.add(trackedRun);
    return trackedRun;
  };

  const drainLiveResumes = async (settleFailures: boolean): Promise<void> => {
    while (liveResumeRequests.size > 0 || pendingLiveJobRuns.size > 0) {
      // Invalid or stale resume requests are reported to their caller without
      // failing an otherwise healthy execution. They still need to settle
      // before finalization because accepted requests can enqueue job runs.
      await Promise.allSettled(Array.from(liveResumeRequests));
      const pendingRuns = Array.from(pendingLiveJobRuns);
      const results = await Promise.allSettled(pendingRuns);
      for (const run of pendingRuns) {
        pendingLiveJobRuns.delete(run);
      }
      if (!settleFailures) {
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        if (failure) {
          throw failure.reason instanceof Error
            ? failure.reason
            : new Error(String(failure.reason));
        }
      }
    }
  };

  const resumePausedJobs = async (
    statusReasonIds: readonly string[],
    pauseResponses: readonly PipelinePauseResponse[] = [],
    initiationSource?: UsageInitiationSource,
    portalCommandId?: string,
    authorization?: Pick<
      ExecutionOptions,
      'executionContext' | 'childPipelineAuthorizations' | 'secretEnv'
    >,
  ): Promise<ExecutionState> => {
    const staleStatusReasonId = statusReasonIds.find(
      (id) => !currentState.status_reasons.some((reason) => reason.id === id),
    );
    if (staleStatusReasonId) {
      throw new Error(
        `Status reason "${staleStatusReasonId}" is stale or does not belong to execution "${currentState.id}"`,
      );
    }
    const reasonsBeforeResume = [...currentState.status_reasons];
    const responseLocators = new Set(
      pauseResponses.map(
        (response) => `${response.job_id}\0${response.step_id}`,
      ),
    );
    const selectedInputReasonWithoutResponse = statusReasonIds
      .map((id) =>
        currentState.status_reasons.find(
          (reason) => reason.id === id && reason.kind === 'input_required',
        ),
      )
      .find(
        (reason) =>
          reason !== undefined &&
          !responseLocators.has(
            `${reason.source.job_id}\0${reason.source.step_id}`,
          ),
      );
    if (selectedInputReasonWithoutResponse) {
      throw new Error(
        `Cannot resume "${currentState.id}": execution is waiting for input answers`,
      );
    }
    const selectedJobIds = new Set<string>();
    const pauseReasonIds = new Set(
      currentState.status_reasons
        .filter(
          (reason) =>
            reason.kind === 'input_required' || reason.kind === 'action_paused',
        )
        .map((reason) => reason.id),
    );
    const explicitPauseLocators = new Set(
      pauseResponses.map(
        (response) => `${response.job_id}\0${response.step_id}`,
      ),
    );
    const implicitActionPauseResponses = statusReasonIds.flatMap((id) => {
      const reason = currentState.status_reasons.find(
        (candidate) =>
          candidate.id === id && candidate.kind === 'action_paused',
      );
      if (!reason) return [];
      const checkpoint = currentState.pending_pauses.find(
        (candidate) =>
          candidate.job_id === reason.source.job_id &&
          candidate.step_id === reason.source.step_id &&
          candidate.kind === 'action',
      );
      if (
        !checkpoint ||
        explicitPauseLocators.has(`${checkpoint.job_id}\0${checkpoint.step_id}`)
      ) {
        return [];
      }
      return [
        {
          checkpoint_id: checkpoint.id,
          job_id: checkpoint.job_id,
          step_id: checkpoint.step_id,
        },
      ];
    });
    const allPauseResponses = [
      ...pauseResponses,
      ...implicitActionPauseResponses,
    ];
    if (allPauseResponses.length > 0) {
      const applied = applyPauseResponses(currentState, allPauseResponses);
      for (const jobId of applied.selectedJobIds) {
        currentState.jobs[jobId] = applied.state.jobs[jobId];
        selectedJobIds.add(jobId);
      }
      currentState.pending_pauses = applied.state.pending_pauses;
      currentState.status_reasons = applied.state.status_reasons;
    }

    if (statusReasonIds.length > 0) {
      const providerReasonIds = statusReasonIds.filter(
        (id) => !pauseReasonIds.has(id),
      );
      if (providerReasonIds.length > 0) {
        const prepared = prepareActiveExecutionResume(currentState, {
          statusReasonIds: providerReasonIds,
        });
        for (const reason of currentState.status_reasons) {
          if (providerReasonIds.includes(reason.id)) {
            selectedJobIds.add(reason.source.job_id);
            currentState.jobs[reason.source.job_id] =
              prepared.jobs[reason.source.job_id];
          }
        }
        currentState.pending_pauses = prepared.pending_pauses;
        currentState.status_reasons = prepared.status_reasons;
      }
    }
    await persistState('execution.updated', () => {
      if (authorization?.executionContext !== undefined) {
        currentState.execution_context = authorization.executionContext;
      }
      if (authorization?.childPipelineAuthorizations !== undefined) {
        currentState.child_pipeline_authorizations =
          authorization.childPipelineAuthorizations;
        options.childPipelineAuthorizations =
          authorization.childPipelineAuthorizations;
      }
      if (initiationSource !== undefined) {
        currentState.initiation_source = initiationSource;
      }
      recordPortalCommandReceipt(currentState, portalCommandId);
    });
    // The resume is saved: agents paused on the checkpoints it consumed run
    // again, so the host stops offering them as Ledger owners.
    await notePipelineLedgerResuming(
      options.runtime.pipelineLedger,
      currentState.id,
      consumedStatusReasonIds(reasonsBeforeResume, currentState.status_reasons),
    );
    if (abortController.signal.aborted) {
      throw new Error(
        `Execution "${currentState.id}" was cancelled before its paused jobs could resume`,
      );
    }
    // Secrets are never persisted: the resumed and later jobs read them here.
    if (authorization?.secretEnv !== undefined)
      options.secretEnv = authorization.secretEnv;
    for (const jobId of Array.from(selectedJobIds)) {
      void runLiveResumedJob(jobId).catch(() => undefined);
    }
    return cloneState(currentState);
  };

  const handle: ExecutionHandle = {
    id: currentState.id,
    cancel: async () => {
      abortExecution();
      return completionPromise;
    },
    pauseForAuthentication: async (attemptId) => {
      authenticationPause = {
        attemptId,
        existingReasons: new Set(
          currentState.status_reasons.map((reason) => reason.id),
        ),
      };
      if (!handle.pauseForShutdown) throw new Error('Pipeline cannot pause.');
      return handle.pauseForShutdown();
    },
    pauseForOwnerLoss: async () => {
      // A pause already under way keeps its own reason.
      if (
        acceptingLiveResumes &&
        !abortController.signal.aborted &&
        !rolloverPause
      )
        ownerLossPause ??= {
          existingReasons: new Set(
            currentState.status_reasons.map((reason) => reason.id),
          ),
        };
      if (!handle.pauseForShutdown) throw new Error('Pipeline cannot pause.');
      return handle.pauseForShutdown();
    },
    pauseForRollover: async ({ drainMs, onCheckpoint }) => {
      if (!acceptingLiveResumes || abortController.signal.aborted)
        return completionPromise;
      const deadlineAt = Date.now() + drainMs;
      if (rolloverPause) {
        // A second checkpoint joins the first; it may only bring it forward.
        if (rolloverPause.stopped) {
          onCheckpoint?.();
          return completionPromise;
        }
        if (onCheckpoint) rolloverPause.onCheckpoint.push(onCheckpoint);
        if (deadlineAt < rolloverPause.deadlineAt) {
          clearTimeout(rolloverPause.timer);
          rolloverPause.deadlineAt = deadlineAt;
          rolloverPause.timer = rolloverDeadline(drainMs);
        }
        return completionPromise;
      }
      rolloverPause = {
        existingReasons: new Set(
          currentState.status_reasons.map((reason) => reason.id),
        ),
        deadlineAt,
        timer: rolloverDeadline(drainMs),
        onCheckpoint: onCheckpoint ? [onCheckpoint] : [],
        stopped: false,
      };
      stepDrain.drain(checkpointRollover);
      return completionPromise;
    },
    pauseForShutdown: async () => {
      if (acceptingLiveResumes && !abortController.signal.aborted)
        stopAtCheckpoint();
      return completionPromise;
    },
    getState: () => cloneState(currentState),
    cancelMatrixVariant: async (jobId, variantJobId) => {
      if (!acceptingLiveResumes || abortController.signal.aborted) {
        throw new MatrixExecutorInactiveError(currentState.id);
      }
      const group = currentState.job_groups[jobId];
      if (!group) {
        throw new Error(`Execution "${currentState.id}" has no job "${jobId}"`);
      }
      if (group.kind !== 'matrix') {
        throw new Error(`Job "${jobId}" is not a matrix job`);
      }
      if (!group.variant_job_ids.includes(variantJobId)) {
        throw new Error(`Job "${jobId}" has no variant "${variantJobId}"`);
      }
      const variant = currentState.jobs[variantJobId];
      if (isJobTerminal(variant)) return cloneState(currentState);

      let executorBecameInactive = false;
      let activeRun:
        | { controller: AbortController; promise: Promise<void> }
        | undefined;
      await persistState('execution.updated', () => {
        if (!acceptingLiveResumes || abortController.signal.aborted) {
          executorBecameInactive = true;
          return;
        }
        const currentVariant = currentState.jobs[variantJobId];
        if (!currentVariant || isJobTerminal(currentVariant)) return;
        activeRun = activePhysicalRuns.get(variantJobId);
        activeRun?.controller.abort();
        const completedAt = new Date().toISOString();
        currentVariant.status = 'cancelled';
        currentVariant.outcome = 'cancelled';
        currentVariant.conclusion = 'cancelled';
        currentVariant.completed_at = completedAt;
        for (const step of Object.values(currentVariant.steps)) {
          if (isStepTerminal(step)) continue;
          step.status = 'cancelled';
          step.outcome = 'cancelled';
          step.conclusion = 'cancelled';
          step.completed_at = completedAt;
        }
        clearPhysicalJobBlockers(currentState, variantJobId);
        refreshJobGroup(currentState, jobId);
      });
      if (executorBecameInactive) {
        throw new MatrixExecutorInactiveError(currentState.id);
      }
      await activeRun?.promise;
      await stateWriter.flush();
      return cloneState(currentState);
    },
    addObservers: (observers) => {
      if (observers.onEvent) eventObservers.add(observers.onEvent);
      if (observers.onStepOutput) {
        stepOutputObservers.add(observers.onStepOutput);
      }
      return (): void => {
        if (observers.onEvent) eventObservers.delete(observers.onEvent);
        if (observers.onStepOutput) {
          stepOutputObservers.delete(observers.onStepOutput);
        }
      };
    },
    resumePaused: (
      statusReasonIds,
      pauseResponses,
      initiationSource,
      portalCommandId,
      authorization,
    ) => {
      // A run draining for a checkpoint starts no new work (CAN-6199).
      if (
        !acceptingLiveResumes ||
        abortController.signal.aborted ||
        rolloverPause
      ) {
        return Promise.reject(
          new Error(
            `Execution "${currentState.id}" is no longer accepting paused-job resumes`,
          ),
        );
      }
      const request = resumePausedJobs(
        statusReasonIds,
        pauseResponses,
        initiationSource,
        portalCommandId,
        authorization,
      );
      const trackedRequest: Promise<ExecutionState> = request.finally(() => {
        liveResumeRequests.delete(trackedRequest);
      });
      liveResumeRequests.add(trackedRequest);
      return trackedRequest;
    },
    waitForCompletion: () => completionPromise,
  };
  const resourceHandle =
    options.runtime.resourceMonitor?.registerWorkItem({
      id: `pipeline-execution:${currentState.id}`,
      groupId: 'pipelines',
      kind: 'pipeline-execution',
      label: currentState.pipeline_snapshot.name,
      metadata: {
        type: 'pipeline',
        pipeline: {
          executionId: currentState.id,
          pipelineId: currentState.pipeline_id,
          pipelineName: currentState.pipeline_snapshot.name,
        },
      },
    }) ?? null;

  options.runtime.lifecycle?.onExecutionStart?.(currentState);

  void (async (): Promise<void> => {
    let externalCancelPoll: NodeJS.Timeout | undefined;
    let cancelCheckInFlight = false;
    const stopExternalCancelPolling = (): void => {
      if (externalCancelPoll) {
        clearInterval(externalCancelPoll);
        externalCancelPoll = undefined;
      }
    };
    const pollForExternalCancellation = async (): Promise<void> => {
      if (cancelCheckInFlight || abortController.signal.aborted) {
        return;
      }
      cancelCheckInFlight = true;
      try {
        if (
          await isExecutionCancellationRequested(
            currentState.id,
            options.runtime.executionsDir,
          )
        ) {
          abortExecution();
        }
      } catch {
        // A failed read is retried on the next cancellation tick.
      } finally {
        cancelCheckInFlight = false;
      }
    };

    try {
      if (ownerFence.aborted) stopFenced();
      else ownerFence.addEventListener('abort', stopFenced, { once: true });
      externalCancelPoll = setInterval(() => {
        void pollForExternalCancellation();
      }, EXTERNAL_CANCEL_POLL_MS);
      void pollForExternalCancellation();

      currentState.status = 'running';
      currentState.completed_at = undefined;
      endExecutionPause(currentState);
      await persistState('execution.started');

      const logicalJobIds = Object.keys(normalizedPipeline.jobs);
      const dependenciesTerminal = (logicalJobId: string): boolean =>
        normalizedPipeline.jobs[logicalJobId].needs.every((dependencyId) =>
          isJobGroupTerminal(currentState.job_groups[dependencyId]),
        );

      const expandDynamicGroup = async (
        logicalJobId: string,
      ): Promise<void> => {
        const logicalJob = normalizedPipeline.jobs[logicalJobId];
        const group = currentState.job_groups[logicalJobId];
        if (!logicalJob.strategy?.dynamic || group.expansion !== 'pending') {
          return;
        }
        const needs = buildNeedsContext(
          currentState,
          logicalJobId,
          normalizedPipeline,
        );
        const context = buildExpressionContext({
          env: cascadeEnv(
            currentState.env,
            normalizedPipeline.env,
            logicalJob.env,
          ),
          inputs: currentState.inputs,
          needs,
          canopy: buildCanopyFromState(currentState),
          assets: buildExpressionAssets(
            currentState.pipeline_assets?.asset_paths,
          ),
          matrix: {},
        });
        try {
          const source = logicalJob.strategy.matrix;
          const resolved =
            typeof source === 'string'
              ? evaluateTemplateValue(source, context)
              : Object.fromEntries(
                  Object.entries(source).map(([key, value]) => [
                    key,
                    typeof value === 'string'
                      ? evaluateTemplateValue(value, context)
                      : structuredClone(value),
                  ]),
                );
          const definition = resolveMatrixDefinition(logicalJobId, resolved);
          const combinations = expandStaticMatrix(logicalJobId, {
            matrix: definition,
            dynamic: false,
          });
          const existingVariants = Object.values(
            currentState.job_groups,
          ).reduce(
            (count, candidate) =>
              count +
              (candidate.kind === 'matrix'
                ? candidate.variant_job_ids.length
                : 0),
            0,
          );
          if (existingVariants + combinations.length > MAX_MATRIX_VARIANTS) {
            throw new Error(
              `Matrix expansion would exceed the execution limit of ${String(MAX_MATRIX_VARIANTS)} variants`,
            );
          }
          commitMatrixExpansion(currentState, logicalJobId, combinations);
        } catch (error) {
          group.expansion = 'failure';
          group.status = 'failure';
          group.outcome = 'failure';
          group.conclusion = 'failure';
          group.error = error instanceof Error ? error.message : String(error);
          group.completed_at = new Date().toISOString();
        }
        await persistState();
      };

      const runPhysicalJob = async (physicalJobId: string): Promise<void> => {
        const existing = activePhysicalRuns.get(physicalJobId);
        if (existing) return existing.promise;
        const jobResult = currentState.jobs[physicalJobId];
        const definition = currentState.job_definitions[physicalJobId];
        if (
          !jobResult ||
          !definition ||
          isJobTerminal(jobResult) ||
          jobResult.status === 'paused' ||
          abortController.signal.aborted
        ) {
          return;
        }
        const logicalJobId = definition.logical_job_id;
        const logicalJob = normalizedPipeline.jobs[logicalJobId];
        const needs = buildNeedsContext(
          currentState,
          logicalJobId,
          normalizedPipeline,
        );
        const dependenciesSatisfied = logicalJob.needs.every(
          (dependencyId) => needs[dependencyId]?.result === 'success',
        );
        const hasDependencyFailure = logicalJob.needs.some(
          (dependencyId) => needs[dependencyId]?.result === 'failure',
        );
        const expressionContext = buildExpressionContext({
          env: cascadeEnv(
            currentState.env,
            normalizedPipeline.env,
            definition.env,
          ),
          inputs: currentState.inputs,
          needs,
          job: {
            is_retry: (jobResult.retry_count ?? 0) > 0,
            retry_count: jobResult.retry_count ?? 0,
            max_retries: definition.max_retries,
          },
          canopy: buildCanopyFromState(currentState),
          assets: buildExpressionAssets(
            currentState.pipeline_assets?.asset_paths,
          ),
          matrix: definition.matrix?.values ?? {},
        });
        const conditionFunctions = {
          always: (): boolean => true,
          success: (): boolean => dependenciesSatisfied,
          failure: (): boolean => hasDependencyFailure,
          cancelled: (): boolean => abortController.signal.aborted,
        };
        if (
          !evaluateCondition(
            definition.if,
            expressionContext,
            conditionFunctions,
          ) ||
          (!definition.if && !dependenciesSatisfied)
        ) {
          markJobSkipped(currentState, physicalJobId);
          refreshJobGroup(currentState, logicalJobId);
          await persistState();
          return;
        }

        const resolvedMaxIterations = resolveJobMaxIterations(
          physicalJobId,
          definition,
          expressionContext,
        );
        let resolvedContinueOnError = definition.continue_on_error;
        if (definition.continue_on_error_expression) {
          const value = evaluateTemplateValue(
            definition.continue_on_error_expression,
            expressionContext,
          );
          if (typeof value !== 'boolean') {
            throw new Error(
              `Job "${physicalJobId}" continue_on_error must resolve to a boolean`,
            );
          }
          resolvedContinueOnError = value;
        }
        const resolvedDefinition = {
          ...definition,
          name: interpolateExpression(definition.name, expressionContext),
          env: Object.fromEntries(
            Object.entries(definition.env ?? {}).map(([key, value]) => [
              key,
              typeof value === 'string'
                ? interpolateExpression(value, expressionContext)
                : value,
            ]),
          ),
          continue_on_error: resolvedContinueOnError,
          ...(resolvedMaxIterations === undefined
            ? {}
            : { max_iterations: resolvedMaxIterations }),
        };
        currentState.job_definitions[physicalJobId] = resolvedDefinition;
        if (resolvedMaxIterations === 0) {
          markJobSkipped(currentState, physicalJobId);
          refreshJobGroup(currentState, logicalJobId);
          await persistState();
          return;
        }

        const controller = new AbortController();
        const signal = AbortSignal.any([
          abortController.signal,
          controller.signal,
        ]);
        const run = (async (): Promise<void> => {
          const acquired = await acquireMatrixGroupSlot(
            logicalJobId,
            physicalJobId,
            signal,
          );
          if (!acquired) return;
          try {
            if (signal.aborted || isJobTerminal(jobResult)) return;
            jobResult.status =
              jobResult.status === 'pending' ? 'queued' : jobResult.status;
            const savePhysicalState = async (): Promise<void> => {
              syncPendingPauseForJob(currentState, physicalJobId);
              refreshJobGroup(currentState, logicalJobId);
              sortPauseCheckpoints(currentState);
              await persistState();
            };
            await persistState();
            await runJobResult(
              physicalJobId,
              resolvedDefinition,
              jobResult,
              needs,
              signal,
              definition.matrix?.values,
              savePhysicalState,
            );

            await applyMatrixFailFast(logicalJobId, physicalJobId);
          } finally {
            releaseMatrixGroupSlot(logicalJobId, physicalJobId);
          }
        })();
        const trackedRun = run.finally(() => {
          if (activePhysicalRuns.get(physicalJobId)?.promise === trackedRun) {
            activePhysicalRuns.delete(physicalJobId);
          }
          syncPendingPauseForJob(currentState, physicalJobId);
          refreshJobGroup(currentState, logicalJobId);
        });
        activePhysicalRuns.set(physicalJobId, {
          controller,
          promise: trackedRun,
        });
        await trackedRun;
      };

      const failInvalidPendingGroup = (logicalJobId: string): boolean => {
        const group = currentState.job_groups[logicalJobId];
        if (
          group?.expansion !== 'pending' ||
          normalizedPipeline.jobs[logicalJobId]?.strategy?.dynamic
        ) {
          return false;
        }
        group.expansion = 'failure';
        group.status = 'failure';
        group.outcome = 'failure';
        group.conclusion = 'failure';
        group.error = `Job "${logicalJobId}" cannot expand because it has no dynamic matrix strategy`;
        group.completed_at = new Date().toISOString();
        return true;
      };

      const runLogicalGroup = async (logicalJobId: string): Promise<void> => {
        const logicalJob = normalizedPipeline.jobs[logicalJobId];
        const pendingGroup = currentState.job_groups[logicalJobId];
        if (failInvalidPendingGroup(logicalJobId)) {
          await persistState();
          return;
        }
        if (
          logicalJob.strategy?.dynamic &&
          pendingGroup?.expansion === 'pending'
        ) {
          const needs = buildNeedsContext(
            currentState,
            logicalJobId,
            normalizedPipeline,
          );
          const dependenciesSatisfied = logicalJob.needs.every(
            (dependencyId) => needs[dependencyId]?.result === 'success',
          );
          const hasDependencyFailure = logicalJob.needs.some(
            (dependencyId) => needs[dependencyId]?.result === 'failure',
          );
          const canEvaluateConditionBeforeExpansion =
            logicalJob.if !== undefined &&
            !referencesPhysicalJobContext(logicalJob.if);
          const shouldSkip = logicalJob.if
            ? canEvaluateConditionBeforeExpansion &&
              !evaluateCondition(
                logicalJob.if,
                buildExpressionContext({
                  env: cascadeEnv(
                    currentState.env,
                    normalizedPipeline.env,
                    logicalJob.env,
                  ),
                  inputs: currentState.inputs,
                  needs,
                  canopy: buildCanopyFromState(currentState),
                  assets: buildExpressionAssets(
                    currentState.pipeline_assets?.asset_paths,
                  ),
                  matrix: {},
                }),
                {
                  always: (): boolean => true,
                  success: (): boolean => dependenciesSatisfied,
                  failure: (): boolean => hasDependencyFailure,
                  cancelled: (): boolean => abortController.signal.aborted,
                },
              )
            : !dependenciesSatisfied;
          if (shouldSkip) {
            pendingGroup.status = 'skipped';
            pendingGroup.outcome = 'skipped';
            pendingGroup.conclusion = 'skipped';
            pendingGroup.completed_at = new Date().toISOString();
            await persistState();
            return;
          }
        }
        await expandDynamicGroup(logicalJobId);
        const group = currentState.job_groups[logicalJobId];
        if (group.expansion !== 'expanded' || isJobGroupTerminal(group)) return;
        const runnable = group.variant_job_ids.filter((physicalJobId) => {
          const job = currentState.jobs[physicalJobId];
          return job && !isJobTerminal(job) && job.status !== 'paused';
        });
        const maxParallel = Math.max(
          1,
          Math.min(
            group.resolved_max_parallel ?? runnable.length,
            runnable.length,
          ),
        );
        let cursor = 0;
        let workerFailure: { reason: unknown } | undefined;
        const workers = Array.from({ length: maxParallel }, async () => {
          while (
            cursor < runnable.length &&
            !abortController.signal.aborted &&
            !workerFailure
          ) {
            const physicalJobId = runnable[cursor++];
            try {
              await runPhysicalJob(physicalJobId);
            } catch (error) {
              if (!workerFailure) {
                workerFailure = { reason: error };
                abortExecution();
                for (const activeRun of Array.from(
                  activePhysicalRuns.values(),
                )) {
                  activeRun.controller.abort();
                }
              }
            }
          }
        });
        await Promise.all(workers);
        if (workerFailure) {
          await drainLiveResumes(true);
          throw workerFailure.reason;
        }
        refreshJobGroup(currentState, logicalJobId);
      };

      while (!abortController.signal.aborted) {
        refreshAllJobGroups(currentState);
        const invalidPendingGroups = logicalJobIds.filter((logicalJobId) => {
          const group = currentState.job_groups[logicalJobId];
          return Boolean(
            group &&
            !isJobGroupTerminal(group) &&
            group.expansion === 'pending' &&
            dependenciesTerminal(logicalJobId) &&
            !normalizedPipeline.jobs[logicalJobId]?.strategy?.dynamic,
          );
        });
        invalidPendingGroups.forEach(failInvalidPendingGroup);
        if (invalidPendingGroups.length > 0) {
          await persistState();
        }
        const runnableGroups = logicalJobIds.filter((logicalJobId) => {
          const group = currentState.job_groups[logicalJobId];
          if (
            !group ||
            isJobGroupTerminal(group) ||
            !dependenciesTerminal(logicalJobId)
          ) {
            return false;
          }
          if (group.expansion === 'pending') {
            return Boolean(
              normalizedPipeline.jobs[logicalJobId]?.strategy?.dynamic,
            );
          }
          return group.variant_job_ids.some((physicalJobId) => {
            const job = currentState.jobs[physicalJobId];
            return job && !isJobTerminal(job) && job.status !== 'paused';
          });
        });
        if (runnableGroups.length === 0) break;
        const groupResults = await Promise.allSettled(
          runnableGroups.map(runLogicalGroup),
        );
        for (const result of groupResults) {
          if (result.status === 'rejected') throw result.reason;
        }
        await drainLiveResumes(false);
      }

      // Close the resume gate before the final drain so no new recovery work
      // can be accepted after the executor has decided to finalize.
      acceptingLiveResumes = false;
      await drainLiveResumes(abortController.signal.aborted);

      if (fenced) {
        completionResolve(cloneState(currentState));
        return;
      }

      currentState.plan_hash_after = await hashPlanFile(currentState);

      if (shutdownJobs) {
        pauseInterruptedExecution(currentState, shutdownJobs);
        if (ownerLossPause && !authenticationPause) {
          const { existingReasons } = ownerLossPause;
          for (const reason of currentState.status_reasons)
            if (
              !existingReasons.has(reason.id) &&
              reason.kind === 'app_shutdown'
            ) {
              reason.kind = 'owner_lost';
              reason.code = 'owner_lost';
            }
        }
        if (rolloverPause && !ownerLossPause && !authenticationPause) {
          const { existingReasons } = rolloverPause;
          for (const reason of currentState.status_reasons)
            if (
              !existingReasons.has(reason.id) &&
              reason.kind === 'app_shutdown'
            ) {
              reason.kind = 'host_rollover';
              reason.code = 'host_rollover';
            }
        }
        if (authenticationPause) {
          const { attemptId, existingReasons } = authenticationPause;
          const added = currentState.status_reasons.filter(
            (reason) =>
              !existingReasons.has(reason.id) && reason.kind === 'app_shutdown',
          );
          for (const reason of added) {
            reason.kind = 'provider_sign_in';
            reason.code = 'provider_sign_in';
            reason.authentication_attempt_id = attemptId;
          }
          currentState.authentication_pause = {
            attempt_id: attemptId,
            reason_ids: [
              ...added.map((reason) => reason.id),
              ...(currentState.shutdown_checkpoint
                ? [currentState.shutdown_checkpoint.id]
                : []),
            ],
          };
        }
        refreshAllJobGroups(currentState);
        currentState.report_outputs = collectReportOutputs(currentState);
        await persistState('execution.paused');
        await clearExecutionCancellation(
          currentState.id,
          options.runtime.executionsDir,
        ).catch(() => undefined);
        completionResolve(cloneState(currentState));
        return;
      }

      if (abortController.signal.aborted) {
        currentState.pending_pauses = [];
        markRemainingJobsCancelled(currentState);
        refreshAllJobGroups(currentState);
        currentState.report_outputs = collectReportOutputs(currentState);
        currentState.status = 'cancelled';
        currentState.completed_at = new Date().toISOString();
        endExecutionPause(currentState, currentState.completed_at);
        currentState.pending_input = undefined;
        currentState.status_reasons = [];
        await upsertTrackedPlanFromExecution(
          currentState,
          options.runtime,
        ).catch(() => {});
        await persistState('execution.cancelled');
        await clearExecutionCancellation(
          currentState.id,
          options.runtime.executionsDir,
        ).catch(() => undefined);
        completionResolve(cloneState(currentState));
        return;
      }

      const pausedJobs = Object.values(currentState.jobs).some(
        (job) => job.status === 'paused',
      );
      if (pausedJobs) {
        const pendingInputs = findPendingInputs(currentState);
        sortPauseCheckpoints(currentState);
        currentState.report_outputs = collectReportOutputs(currentState);
        currentState.status = 'paused';
        currentState.completed_at = undefined;
        beginExecutionPause(currentState);
        currentState.pending_input =
          pendingInputs.length === 1 ? pendingInputs[0] : undefined;
        await persistState('execution.paused');
        await clearExecutionCancellation(
          currentState.id,
          options.runtime.executionsDir,
        ).catch(() => undefined);
        completionResolve(cloneState(currentState));
        return;
      }

      refreshAllJobGroups(currentState);
      const failedJobs = Object.values(currentState.job_groups).some(
        (group) => group.conclusion === 'failure',
      );
      if (failedJobs) {
        markPendingJobsSkipped(currentState);
        refreshAllJobGroups(currentState);
        currentState.report_outputs = collectReportOutputs(currentState);
        currentState.status = 'failure';
        currentState.completed_at = new Date().toISOString();
        endExecutionPause(currentState, currentState.completed_at);
        currentState.pending_input = undefined;
        currentState.status_reasons = [];
        await upsertTrackedPlanFromExecution(
          currentState,
          options.runtime,
        ).catch(() => {});
        await persistState('execution.completed');
        await clearExecutionCancellation(
          currentState.id,
          options.runtime.executionsDir,
        ).catch(() => undefined);
        completionResolve(cloneState(currentState));
        return;
      }
      const cancelledJobs = Object.values(currentState.job_groups).some(
        (group) => group.conclusion === 'cancelled',
      );
      if (cancelledJobs) {
        markPendingJobsSkipped(currentState);
        refreshAllJobGroups(currentState);
        currentState.report_outputs = collectReportOutputs(currentState);
        currentState.status = 'cancelled';
        currentState.completed_at = new Date().toISOString();
        endExecutionPause(currentState, currentState.completed_at);
        currentState.pending_input = undefined;
        currentState.status_reasons = [];
        await upsertTrackedPlanFromExecution(
          currentState,
          options.runtime,
        ).catch(() => {});
        await persistState('execution.cancelled');
        await clearExecutionCancellation(
          currentState.id,
          options.runtime.executionsDir,
        ).catch(() => undefined);
        completionResolve(cloneState(currentState));
        return;
      }

      currentState.report_outputs = collectReportOutputs(currentState);
      currentState.status = 'success';
      currentState.completed_at = new Date().toISOString();
      endExecutionPause(currentState, currentState.completed_at);
      currentState.pending_input = undefined;
      currentState.status_reasons = [];
      await upsertTrackedPlanFromExecution(currentState, options.runtime).catch(
        () => {},
      );
      await persistState('execution.completed');
      await clearExecutionCancellation(
        currentState.id,
        options.runtime.executionsDir,
      ).catch(() => undefined);
      completionResolve(cloneState(currentState));
    } catch (error) {
      if (fenced) {
        completionResolve(cloneState(currentState));
        return;
      }
      currentState.plan_hash_after = await hashPlanFile(currentState).catch(
        () => undefined,
      );
      currentState.report_outputs = collectReportOutputs(currentState);
      currentState.error =
        error instanceof Error ? error.message : String(error);
      currentState.status = 'failure';
      currentState.completed_at = new Date().toISOString();
      endExecutionPause(currentState, currentState.completed_at);
      currentState.pending_input = undefined;
      currentState.status_reasons = [];
      await upsertTrackedPlanFromExecution(currentState, options.runtime).catch(
        () => {},
      );
      await persistState('execution.failed').catch(() => {});
      await clearExecutionCancellation(
        currentState.id,
        options.runtime.executionsDir,
      ).catch(() => {});
      completionReject(error);
    } finally {
      // Preserve the existing lifecycle contract: completion waiters observe
      // resource cleanup and onExecutionSettled before their promise resumes.
      // The serialized writer may yield even when it has no queued work.
      resourceHandle?.unregister();
      stopExternalCancelPolling();
      ownerFence.removeEventListener('abort', stopFenced);
      // A fenced run did not settle: the incarnation that took it owns its
      // lifecycle and its temporary files.
      if (!fenced)
        options.runtime.lifecycle?.onExecutionSettled?.(currentState);
      await stateWriter.flush().catch(() => {});
      if (!fenced && currentState.status !== 'paused') {
        await cleanupExecutionTempDir(currentState, options.runtime);
      }
    }
  })();

  return handle;
}

export async function executePipeline(
  pipeline: Pipeline,
  options: ExecutionOptions,
): Promise<ExecutionHandle> {
  const pipelineToExecute = options.pipelineOverride ?? pipeline;
  const normalizedPipeline = normalizePipeline(pipelineToExecute, {
    defaultShell: getDefaultShellTypeForCurrentProcess(),
  });
  const validationPackageOverlay =
    options.pipelinePackageOverlay ??
    (options.pipelinePackage
      ? buildPipelinePackageOverlay(
          options.pipelinePackage.digest,
          options.pipelinePackage.cachedPackagePath,
          options.pipelinePackage.manifest,
        )
      : undefined);
  await validatePipelineScopes({
    pipeline: pipelineToExecute,
    pipelineId: options.pipelineId,
    cwd: options.cwd,
    pipelineFileDir: options.pipelineFileDir,
    repoPath: options.repoPath,
    packageOverlay: validationPackageOverlay,
    runtime: options.runtime,
    defaultShell: getDefaultShellTypeForCurrentProcess(),
  });
  const resolvedExecution = await validateExecutionScopeAndTarget(
    options.pipelineId,
    normalizedPipeline,
    options,
  );
  const executionId = options.executionId ?? createPipelineExecutionId();
  const globalWorkspaceDir = topLevelGlobalWorkspaceDir({
    scope: resolvedExecution.scope,
    target: resolvedExecution.target,
    parentExecutionId: options.parentExecutionId,
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    executionsDir: options.runtime.executionsDir,
    executionId,
    globalWorkspaceDir: options.globalWorkspaceDir,
  });
  const executionOptions: ExecutionOptions = {
    ...options,
    scope: resolvedExecution.scope,
    target: resolvedExecution.target,
    cwd: globalWorkspaceDir ?? options.cwd,
  };
  const pluginCollectionState = await resolveExecutionPluginCollections(
    normalizedPipeline,
    executionOptions,
  );
  const activeEventName = executionOptions.eventName ?? 'dispatch';
  const resolvedInputs = resolvePipelineInputs(
    getNormalizedTriggerInputDefs(normalizedPipeline, activeEventName),
    executionOptions.inputs,
  );
  const planId = await resolvePlanIdForExecution(executionId, executionOptions);
  const rerunContext = await buildRerunContext(executionOptions.eventData);
  const materializedEventData = await materializeEventData(
    executionOptions.eventData
      ? {
          ...executionOptions.eventData,
          ...(executionOptions.eventData.plan_ready
            ? {
                plan_ready: {
                  ...executionOptions.eventData.plan_ready,
                  ...(planId ? { planId } : {}),
                },
              }
            : {}),
        }
      : executionOptions.eventData,
    executionOptions.runtime.executionsDir,
    executionId,
  );
  await fsp.mkdir(
    getExecutionOutputDir(executionOptions.runtime.executionsDir, executionId),
    { recursive: true },
  );
  // Created with the execution directory, once the start can no longer fail
  // validation.
  if (globalWorkspaceDir !== undefined)
    await fsp.mkdir(globalWorkspaceDir, { recursive: true });
  const state = createInitialState(
    normalizedPipeline,
    {
      ...executionOptions,
      planId,
      pluginCollectionPreferences: pluginCollectionState?.preferences,
    },
    executionId,
    resolvedInputs,
    materializedEventData,
    rerunContext,
  );
  state.resolved_plugin_collections = pluginCollectionState?.snapshots;
  if (executionOptions.pipelinePackage) {
    state.pipeline_package_snapshot = await snapshotPipelinePackageForExecution(
      {
        ...executionOptions.pipelinePackage,
        executionDirectory: getExecutionOutputDir(
          executionOptions.runtime.executionsDir,
          executionId,
        ),
      },
    );
    executionOptions.pipelinePackageOverlay = buildPipelinePackageOverlay(
      executionOptions.pipelinePackage.digest,
      state.pipeline_package_snapshot.cachedPackagePath,
      executionOptions.pipelinePackage.manifest,
    );
  }
  state.plan_hash_before = await hashPlanFile(state);
  await saveExecutionState(state, executionOptions.runtime.executionsDir, {
    cancellation: 'clear_before',
  });
  await executionOptions.beforeStart?.(cloneState(state));
  return executeState(state, executionOptions);
}

export async function resumePipeline(
  executionId: string,
  options: Omit<ExecutionOptions, 'pipelineId' | 'executionId'> & {
    pipelineId?: string;
  },
): Promise<ExecutionHandle> {
  const loadedState = await loadExecutionState(
    executionId,
    options.runtime.executionsDir,
  );
  if (!loadedState) {
    throw new Error(`Execution "${executionId}" not found`);
  }

  if (['success', 'failure', 'cancelled'].includes(loadedState.status)) {
    throw new Error(
      `Execution "${executionId}" cannot be resumed because it is ${loadedState.status}`,
    );
  }

  const explicitStatusReasonIds = options.statusReasonIds;
  if (explicitStatusReasonIds) {
    if (explicitStatusReasonIds.length === 0) {
      throw new Error(
        'statusReasonIds must be omitted or contain at least one ID',
      );
    }
    if (
      new Set(explicitStatusReasonIds).size !== explicitStatusReasonIds.length
    ) {
      throw new Error('statusReasonIds must not contain duplicate IDs');
    }
    const activeStatusReasonIds = new Set(
      loadedState.status_reasons.map((reason) => reason.id),
    );
    if (loadedState.shutdown_checkpoint)
      activeStatusReasonIds.add(loadedState.shutdown_checkpoint.id);
    const staleId = explicitStatusReasonIds.find(
      (id) => !activeStatusReasonIds.has(id),
    );
    if (staleId) {
      throw new Error(
        `Status reason "${staleId}" is stale or does not belong to execution "${executionId}"`,
      );
    }
  }

  let pauseResponses = options.pauseResponses ?? [];
  const structuredPauses = loadedState.pending_pauses.filter(
    (checkpoint) => checkpoint.request,
  );
  if (options.inputAnswers !== undefined) {
    if (structuredPauses.length !== 1) {
      throw new Error(
        structuredPauses.length === 0
          ? `Cannot resume "${executionId}": execution is not waiting for input`
          : `Cannot resume "${executionId}": inputAnswers is ambiguous; provide pauseResponses for each checkpoint`,
      );
    }
    const checkpoint = structuredPauses[0];
    pauseResponses = [
      ...pauseResponses,
      {
        checkpoint_id: checkpoint.id,
        job_id: checkpoint.job_id,
        step_id: checkpoint.step_id,
        answers: options.inputAnswers,
      },
    ];
  }
  const explicitPauseLocators = new Set(
    pauseResponses.map((response) => `${response.job_id}\0${response.step_id}`),
  );
  const selectedStatusReasonIds = options.statusReasonIds?.length
    ? new Set(options.statusReasonIds)
    : null;
  const selectedInputReasonWithoutResponse = selectedStatusReasonIds
    ? loadedState.status_reasons.find(
        (reason) =>
          reason.kind === 'input_required' &&
          selectedStatusReasonIds.has(reason.id) &&
          !explicitPauseLocators.has(
            `${reason.source.job_id}\0${reason.source.step_id}`,
          ),
      )
    : undefined;
  if (selectedInputReasonWithoutResponse) {
    throw new Error(
      `Cannot resume "${executionId}": execution is waiting for input answers`,
    );
  }
  const selectedActionPauseLocators = selectedStatusReasonIds
    ? new Set(
        loadedState.status_reasons
          .filter(
            (reason) =>
              reason.kind === 'action_paused' &&
              selectedStatusReasonIds.has(reason.id),
          )
          .map((reason) => `${reason.source.job_id}\0${reason.source.step_id}`),
      )
    : null;
  const implicitActionPauseResponses = loadedState.pending_pauses
    .filter((checkpoint) => {
      if (checkpoint.kind !== 'action') return false;
      const locator = `${checkpoint.job_id}\0${checkpoint.step_id}`;
      if (explicitPauseLocators.has(locator)) return false;
      if (selectedActionPauseLocators !== null) {
        return selectedActionPauseLocators.has(locator);
      }
      return pauseResponses.length === 0 && structuredPauses.length === 0;
    })
    .map((checkpoint) => ({
      checkpoint_id: checkpoint.id,
      job_id: checkpoint.job_id,
      step_id: checkpoint.step_id,
    }));
  pauseResponses = [...pauseResponses, ...implicitActionPauseResponses];
  if (
    pauseResponses.length === 0 &&
    structuredPauses.length > 0 &&
    !options.statusReasonIds?.length
  ) {
    throw new Error(
      `Cannot resume "${executionId}": execution is waiting for input answers`,
    );
  }
  if (pauseResponses.length > 0) {
    const applied = applyPauseResponses(loadedState, pauseResponses);
    Object.assign(loadedState, applied.state);
  }

  const mergedInputs = mergePipelineInputs(
    getNormalizedTriggerInputDefs(
      loadedState.pipeline_snapshot,
      loadedState.event_name ?? 'dispatch',
    ) ?? loadedState.pipeline_snapshot.inputs,
    loadedState.inputs,
    options.inputs,
  );
  const replayTarget = await resolveReplayScopeAndTarget(loadedState, options, {
    executionId,
    parentExecutionId: loadedState.parent_execution_id,
  });
  const remainingStatusReasonIds = explicitStatusReasonIds?.filter((id) =>
    loadedState.status_reasons.some((reason) => reason.id === id),
  );
  const recoveredState = prepareExecutionResume(loadedState, {
    ...(remainingStatusReasonIds?.length
      ? { statusReasonIds: remainingStatusReasonIds }
      : {}),
    ...((explicitStatusReasonIds !== undefined || pauseResponses.length > 0) &&
    !remainingStatusReasonIds?.length
      ? { selectDefaultStatusReasons: false }
      : {}),
  });
  recoveredState.pending_input =
    recoveredState.pending_pauses.length === 1 &&
    recoveredState.pending_pauses[0].request
      ? {
          job_id: recoveredState.pending_pauses[0].job_id,
          step_id: recoveredState.pending_pauses[0].step_id,
          request: recoveredState.pending_pauses[0].request,
        }
      : undefined;
  await fsp.mkdir(
    getExecutionOutputDir(options.runtime.executionsDir, executionId),
    { recursive: true },
  );
  recoveredState.cwd = replayTarget.cwd;
  recoveredState.scope = replayTarget.scope;
  recoveredState.target = replayTarget.target;
  recoveredState.execution_checkout_root = replayExecutionCheckoutRoot(
    loadedState,
    options,
  );
  claimPipelineOwner(recoveredState);
  recoveredState.env = withExecutionOutputDirEnv(
    {
      ...stripReplayManagedEnv(loadedState.env),
      ...stripExecutorManagedEnv(options.env),
    },
    getExecutionOutputDir(options.runtime.executionsDir, executionId),
  );
  recoveredState.inputs = mergedInputs;
  recoveredState.repo_path = repoPathForReplayTarget(
    replayTarget.target,
    options.repoPath,
    loadedState.repo_path,
  );
  recoveredState.project_id =
    replayTarget.target.scope === 'worktree'
      ? replayTarget.target.workspace_id
      : loadedState.project_id;
  recoveredState.worktree_id =
    replayTarget.target.scope === 'worktree'
      ? replayTarget.target.worktree_id
      : loadedState.worktree_id;
  recoveredState.planId = loadedState.planId;
  recoveredState.initiation_source =
    options.initiationSource ?? loadedState.initiation_source;
  recoveredState.initiator = options.initiator ?? loadedState.initiator;
  recoveredState.agent_origin = options.agentOrigin ?? loadedState.agent_origin;
  findResumePoint(recoveredState);
  const pipelinePackageOverlay = await loadPipelinePackageExecutionOverlay(
    recoveredState.pipeline_package_snapshot,
  );
  if (options.executionContext !== undefined) {
    recoveredState.execution_context = options.executionContext;
  }
  if (options.childPipelineAuthorizations !== undefined) {
    recoveredState.child_pipeline_authorizations =
      options.childPipelineAuthorizations;
  }
  recordPortalCommandReceipt(recoveredState, options.portalCommandId);
  await saveExecutionState(recoveredState, options.runtime.executionsDir, {
    cancellation: 'clear_before',
  });
  // The resume is saved: agents paused on the checkpoints it consumed run
  // again, so the host stops offering them as Ledger owners. A nested
  // pipeline's checkpoints are consumed when its own resume runs.
  await notePipelineLedgerResuming(
    options.runtime.pipelineLedger,
    executionId,
    consumedStatusReasonIds(
      loadedState.status_reasons,
      recoveredState.status_reasons,
    ),
  );
  return executeState(recoveredState, {
    ...options,
    cwd: replayTarget.cwd,
    scope: replayTarget.scope,
    target: replayTarget.target,
    pipelinePackageOverlay,
  });
}

export async function retryPipelineExecution(
  executionId: string,
  options: Omit<
    ExecutionOptions,
    | 'pipelineId'
    | 'executionId'
    | 'inputs'
    | 'eventName'
    | 'eventData'
    | 'projectId'
    | 'worktreeId'
    | 'parentExecutionId'
    | 'parentStepId'
    | 'parentAttempt'
  >,
): Promise<ExecutionHandle> {
  const loadedState = await loadExecutionState(
    executionId,
    options.runtime.executionsDir,
  );
  if (!loadedState) {
    throw new Error(`Execution "${executionId}" not found`);
  }

  let retrySourceState = loadedState;
  if (loadedState.shared_pipeline_source) {
    const pipelineSnapshot = normalizePipeline(
      await loadSharedPipelineSnapshotFromCache(loadedState),
      { defaultShell: getDefaultShellTypeForCurrentProcess() },
    );
    retrySourceState = {
      ...loadedState,
      pipeline_snapshot: pipelineSnapshot,
      job_definitions: rematerializeJobDefinitions(
        loadedState,
        pipelineSnapshot,
      ),
    };
  }
  const replayTarget = await resolveReplayScopeAndTarget(
    retrySourceState,
    options,
    { executionId, parentExecutionId: loadedState.parent_execution_id },
  );
  const retryState = prepareRetryState(retrySourceState);
  await fsp.mkdir(
    getExecutionOutputDir(options.runtime.executionsDir, executionId),
    { recursive: true },
  );
  retryState.cwd = replayTarget.cwd;
  retryState.scope = replayTarget.scope;
  retryState.target = replayTarget.target;
  retryState.execution_checkout_root = replayExecutionCheckoutRoot(
    loadedState,
    options,
  );
  claimPipelineOwner(retryState);
  retryState.env = withExecutionOutputDirEnv(
    {
      ...stripReplayManagedEnv(loadedState.env),
      ...stripExecutorManagedEnv(options.env),
    },
    getExecutionOutputDir(options.runtime.executionsDir, executionId),
  );
  retryState.repo_path = repoPathForReplayTarget(
    replayTarget.target,
    options.repoPath,
    loadedState.repo_path,
  );
  retryState.project_id =
    replayTarget.target.scope === 'worktree'
      ? replayTarget.target.workspace_id
      : loadedState.project_id;
  retryState.worktree_id =
    replayTarget.target.scope === 'worktree'
      ? replayTarget.target.worktree_id
      : loadedState.worktree_id;
  retryState.planId = loadedState.planId;
  retryState.plan_hash_before = await hashPlanFile(retryState);
  const pipelinePackageOverlay = await loadPipelinePackageExecutionOverlay(
    retryState.pipeline_package_snapshot,
  );
  recordPortalCommandReceipt(retryState, options.portalCommandId);
  if (options.executionContext !== undefined)
    retryState.execution_context = options.executionContext;
  if (options.initiator !== undefined) retryState.initiator = options.initiator;
  if (options.agentOrigin !== undefined)
    retryState.agent_origin = options.agentOrigin;
  if (options.childPipelineAuthorizations !== undefined)
    retryState.child_pipeline_authorizations =
      options.childPipelineAuthorizations;
  await saveExecutionState(retryState, options.runtime.executionsDir, {
    cancellation: 'clear_before',
  });
  return executeState(retryState, {
    ...options,
    executionId,
    cwd: replayTarget.cwd,
    scope: replayTarget.scope,
    target: replayTarget.target,
    pipelinePackageOverlay,
  });
}

export async function retryMatrixJobExecution(
  request: RetryMatrixJobRequest,
  options: Omit<
    ExecutionOptions,
    | 'pipelineId'
    | 'executionId'
    | 'inputs'
    | 'eventName'
    | 'eventData'
    | 'projectId'
    | 'worktreeId'
    | 'parentExecutionId'
    | 'parentStepId'
    | 'parentAttempt'
  >,
): Promise<ExecutionHandle> {
  const loadedState = await loadExecutionState(
    request.executionId,
    options.runtime.executionsDir,
  );
  if (!loadedState) {
    throw new Error(`Execution "${request.executionId}" not found`);
  }
  const replayTarget = await resolveReplayScopeAndTarget(loadedState, options, {
    executionId: request.executionId,
    parentExecutionId: loadedState.parent_execution_id,
  });
  const retryState = prepareMatrixJobRetryState(loadedState, request);
  retryState.cwd = replayTarget.cwd;
  retryState.scope = replayTarget.scope;
  retryState.target = replayTarget.target;
  retryState.execution_checkout_root = replayExecutionCheckoutRoot(
    loadedState,
    options,
  );
  claimPipelineOwner(retryState);
  retryState.env = withExecutionOutputDirEnv(
    {
      ...stripReplayManagedEnv(loadedState.env),
      ...stripExecutorManagedEnv(options.env),
    },
    getExecutionOutputDir(options.runtime.executionsDir, request.executionId),
  );
  retryState.repo_path = repoPathForReplayTarget(
    replayTarget.target,
    options.repoPath,
    loadedState.repo_path,
  );
  retryState.plan_hash_before = await hashPlanFile(retryState);
  if (options.executionContext !== undefined)
    retryState.execution_context = options.executionContext;
  if (options.initiator !== undefined) retryState.initiator = options.initiator;
  if (options.agentOrigin !== undefined)
    retryState.agent_origin = options.agentOrigin;
  if (options.childPipelineAuthorizations !== undefined)
    retryState.child_pipeline_authorizations =
      options.childPipelineAuthorizations;
  await saveExecutionState(retryState, options.runtime.executionsDir, {
    cancellation: 'clear_before',
  });
  const pipelinePackageOverlay = await loadPipelinePackageExecutionOverlay(
    retryState.pipeline_package_snapshot,
  );
  return executeState(retryState, {
    ...options,
    executionId: request.executionId,
    cwd: replayTarget.cwd,
    scope: replayTarget.scope,
    target: replayTarget.target,
    pipelinePackageOverlay,
  });
}

function assertRerunnableExecution(state: ExecutionState): void {
  if (state.parent_execution_id) {
    throw new Error('Only root executions can be rerun');
  }

  if (!['success', 'failure', 'cancelled'].includes(state.status)) {
    throw new Error(
      `Execution "${state.id}" cannot be rerun because it is ${state.status}`,
    );
  }

  if (
    state.event_name === 'plan_ready' &&
    !state.rerun_context?.event_data?.plan_ready?.plan_text
  ) {
    throw new Error(
      `Execution "${state.id}" cannot be rerun because its original plan input was not preserved`,
    );
  }

  if (
    state.event_name === 'task_ready' &&
    !state.rerun_context?.event_data?.task_ready?.task_text
  ) {
    throw new Error(
      `Execution "${state.id}" cannot be rerun because its original task input was not preserved`,
    );
  }

  if (state.inputs_persisted === false) {
    throw new Error(
      `Execution "${state.id}" cannot be rerun because its original inputs were not preserved`,
    );
  }
}

function buildRerunEventInput(
  state: ExecutionState,
): CanopyEventInput | undefined {
  if (state.event_name === 'task_ready') {
    const taskText = state.rerun_context?.event_data?.task_ready?.task_text;
    if (!taskText) {
      throw new Error(
        `Execution "${state.id}" cannot be rerun because its original task input was not preserved`,
      );
    }

    return {
      task_ready: {
        task_text: taskText,
      },
    };
  }

  if (state.event_name !== 'plan_ready') {
    return undefined;
  }

  const planText = state.rerun_context?.event_data?.plan_ready?.plan_text;
  if (!planText) {
    throw new Error(
      `Execution "${state.id}" cannot be rerun because its original plan input was not preserved`,
    );
  }

  return {
    plan_ready: {
      plan_text: planText,
    },
  };
}

export async function rerunPipelineExecution(
  sourceExecutionId: string,
  options: Omit<
    ExecutionOptions,
    | 'pipelineId'
    | 'executionId'
    | 'inputs'
    | 'eventName'
    | 'eventData'
    | 'projectId'
    | 'worktreeId'
    | 'parentExecutionId'
    | 'parentStepId'
    | 'parentAttempt'
  > & {
    executionId?: string;
    pipelineOverride?: Pipeline;
    sharedPipelineSource?: ExecutionState['shared_pipeline_source'];
  },
): Promise<ExecutionHandle> {
  const sourceState = await loadExecutionState(
    sourceExecutionId,
    options.runtime.executionsDir,
  );
  if (!sourceState) {
    throw new Error(`Execution "${sourceExecutionId}" not found`);
  }

  assertRerunnableExecution(sourceState);

  const executionId = options.executionId ?? randomUUID();
  const rerunEventInput = buildRerunEventInput(sourceState);
  const rerunPipelineSnapshot = options.pipelineOverride
    ? normalizePipeline(options.pipelineOverride, {
        defaultShell: getDefaultShellTypeForCurrentProcess(),
      })
    : sourceState.pipeline_snapshot;
  const executionOutputDir = getExecutionOutputDir(
    options.runtime.executionsDir,
    executionId,
  );
  // Probe before the replay target creates a global run's scratch folder.
  let outputDirExisted = false;
  if (
    !options.sharedPipelineSource &&
    !options.pipelineOverride &&
    sourceState.shared_pipeline_source
  ) {
    try {
      await fsp.stat(executionOutputDir);
      outputDirExisted = true;
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
  }
  const replayTarget = await resolveReplayScopeAndTarget(
    {
      ...sourceState,
      pipeline_snapshot: rerunPipelineSnapshot,
    },
    options,
    // A rerun is a new top-level run with its own folder.
    { executionId, parentExecutionId: undefined },
  );
  const materializedEventData = await materializeEventData(
    rerunEventInput,
    options.runtime.executionsDir,
    executionId,
  );
  await fsp.mkdir(executionOutputDir, { recursive: true });
  let sharedPipelineSource = options.sharedPipelineSource;
  if (
    !sharedPipelineSource &&
    !options.pipelineOverride &&
    sourceState.shared_pipeline_source
  ) {
    const cachedPipelinePath = path.join(
      executionOutputDir,
      'shared-pipeline.yaml',
    );
    try {
      await fsp.copyFile(
        sourceState.shared_pipeline_source.cachedPipelinePath,
        cachedPipelinePath,
      );
    } catch {
      if (!outputDirExisted)
        await fsp.rm(executionOutputDir, { recursive: true, force: true });
      throw new Error(
        `Execution "${sourceExecutionId}" cannot rerun because its shared workflow snapshot is unavailable`,
      );
    }
    sharedPipelineSource = {
      ...sourceState.shared_pipeline_source,
      cachedPipelinePath,
    };
  }
  const state = createInitialState(
    rerunPipelineSnapshot,
    {
      ...options,
      pipelineId: sourceState.pipeline_id,
      executionContext:
        options.executionContext ?? sourceState.execution_context,
      childPipelineAuthorizations:
        options.childPipelineAuthorizations ??
        sourceState.child_pipeline_authorizations,
      cwd: replayTarget.cwd,
      scope: replayTarget.scope,
      target: replayTarget.target,
      executionCheckoutRoot: replayExecutionCheckoutRoot(sourceState, options),
      // A rerun works in the source run's kept workspace (CAN-6317).
      ...(sourceState.global_workspace_dir === undefined
        ? {}
        : { globalWorkspaceDir: sourceState.global_workspace_dir }),
      env: {
        ...stripReplayManagedEnv(sourceState.env),
        ...stripExecutorManagedEnv(options.env),
      },
      repoPath: repoPathForReplayTarget(
        replayTarget.target,
        options.repoPath,
        sourceState.repo_path,
      ),
      modelConfig:
        options.modelConfig !== undefined
          ? options.modelConfig
          : sourceState.model_config,
      eventName: sourceState.event_name,
      projectId:
        replayTarget.target.scope === 'worktree'
          ? replayTarget.target.workspace_id
          : sourceState.project_id,
      worktreeId:
        replayTarget.target.scope === 'worktree'
          ? replayTarget.target.worktree_id
          : sourceState.worktree_id,
      initiationSource:
        options.initiationSource ?? sourceState.initiation_source,
      initiator: options.initiator ?? sourceState.initiator,
      agentOrigin: options.agentOrigin ?? sourceState.agent_origin,
      planId: sourceState.planId,
      runtime: options.runtime,
      sharedPipelineSource,
      curatedPipelineSource: sourceState.curated_pipeline_source,
      // A rerun keeps the source run's asset paths unless main resolved them
      // again for this run.
      ...(pipelineAssetContextFromOptions(options) === undefined &&
      sourceState.pipeline_assets
        ? {
            assetPaths: sourceState.pipeline_assets.asset_paths,
            pipelineDataDir: sourceState.pipeline_assets.pipeline_data_dir,
            assetsDir: sourceState.pipeline_assets.assets_dir,
          }
        : {}),
    },
    executionId,
    sourceState.inputs,
    materializedEventData,
    sourceState.rerun_context,
    sourceState.id,
  );
  state.pipeline_preference_locator = sourceState.pipeline_preference_locator;
  state.plugin_collection_preferences =
    sourceState.plugin_collection_preferences;
  state.resolved_plugin_collections = sourceState.resolved_plugin_collections;
  state.model_alias_preferences =
    options.modelAliasPreferences !== undefined
      ? overlayModelAliasPreferences(
          rerunPipelineSnapshot,
          sourceState.model_alias_preferences,
          options.modelAliasPreferences,
        )
      : sourceState.model_alias_preferences;
  if (options.pipelinePackage) {
    state.pipeline_package_snapshot = await snapshotPipelinePackageForExecution(
      {
        ...options.pipelinePackage,
        executionDirectory: getExecutionOutputDir(
          options.runtime.executionsDir,
          executionId,
        ),
      },
    );
  } else if (sourceState.pipeline_package_snapshot) {
    state.pipeline_package_snapshot =
      await copyPipelinePackageExecutionSnapshot({
        snapshot: sourceState.pipeline_package_snapshot,
        executionDirectory: getExecutionOutputDir(
          options.runtime.executionsDir,
          executionId,
        ),
      });
  }
  state.plan_hash_before = await hashPlanFile(state);
  let pipelinePackageOverlay: PipelinePackageCapabilityOverlay | undefined;
  try {
    pipelinePackageOverlay = await loadPipelinePackageExecutionOverlay(
      state.pipeline_package_snapshot,
    );
  } catch (error) {
    await fsp.rm(
      getExecutionOutputDir(options.runtime.executionsDir, executionId),
      {
        recursive: true,
        force: true,
      },
    );
    throw error;
  }
  await saveExecutionState(state, options.runtime.executionsDir, {
    cancellation: 'clear_before',
  });
  return executeState(state, {
    ...options,
    executionId,
    cwd: replayTarget.cwd,
    scope: replayTarget.scope,
    target: replayTarget.target,
    pipelinePackageOverlay,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cancelPipelineExecution(
  executionId: string,
  runtime: ExecutionRuntime,
  options?: { allowRecoveredFallback?: boolean },
): Promise<ExecutionState> {
  const loadedState = await loadExecutionState(
    executionId,
    runtime.executionsDir,
  );
  if (!loadedState) {
    throw new Error(`Execution "${executionId}" not found`);
  }

  if (loadedState.status === 'cancelled') {
    await clearExecutionCancellation(executionId, runtime.executionsDir);
    return loadedState;
  }

  if (loadedState.status === 'success' || loadedState.status === 'failure') {
    await clearExecutionCancellation(executionId, runtime.executionsDir);
    return loadedState;
  }

  if (loadedState.status === 'paused' || loadedState.status === 'pending') {
    const cancelledState = cloneState(loadedState);
    markPendingInputStepsCancelled(cancelledState);
    markRemainingJobsCancelled(cancelledState);
    refreshAllJobGroups(cancelledState);
    cancelledState.report_outputs = collectReportOutputs(cancelledState);
    cancelledState.status = 'cancelled';
    cancelledState.completed_at = new Date().toISOString();
    // Cancelling from `paused` closes the open pause window, so the run's
    // final duration never bills the wait as work.
    endExecutionPause(cancelledState, cancelledState.completed_at);
    cancelledState.pending_input = undefined;
    cancelledState.status_reasons = [];
    try {
      await saveExecutionState(cancelledState, runtime.executionsDir, {
        cancellation: 'clear_after',
        durable: true,
      });
      runtime.lifecycle?.onExecutionStart?.(loadedState);
      runtime.lifecycle?.onExecutionSettled?.(cancelledState);
      await cleanupExecutionTempDir(cancelledState, runtime);
      return cancelledState;
    } catch (error) {
      if (!isExecutionStateWriteRefusal(error, 'owned_by_other_process'))
        throw error;
    }
  }

  await requestExecutionCancellation(executionId, runtime.executionsDir);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(EXTERNAL_CANCEL_POLL_MS);
    const currentState = await loadExecutionState(
      executionId,
      runtime.executionsDir,
    );
    if (!currentState) {
      throw new Error(`Execution "${executionId}" not found`);
    }
    if (
      currentState.status === 'cancelled' ||
      currentState.status === 'success' ||
      currentState.status === 'failure'
    ) {
      await clearExecutionCancellation(executionId, runtime.executionsDir);
      return currentState;
    }
  }

  const latestState = await loadExecutionState(
    executionId,
    runtime.executionsDir,
  );
  if (!latestState) {
    throw new Error(`Execution "${executionId}" not found`);
  }

  if (latestState.status === 'running' || latestState.status === 'pending') {
    if (options?.allowRecoveredFallback === false) {
      // Archive teardown requires proof that the owning executor settled. Keep
      // both its running state and durable cancellation marker intact so the
      // live executor retains authority to publish its eventual terminal state.
      throw new Error(
        `Execution "${executionId}" did not settle after cancellation`,
      );
    }
    // A running owner in another live process keeps authority over its state.
    // Its durable cancellation request stays in place; once that process exits,
    // orphan recovery or a later cancel settles the run. An owner in this process
    // may still be force-finalized after the cooperative window.
    const cancelledState = cancelRecoveredExecutionState(latestState);
    try {
      await saveExecutionState(cancelledState, runtime.executionsDir, {
        cancellation: 'clear_after',
        durable: true,
      });
    } catch (error) {
      if (isExecutionStateWriteRefusal(error, 'owned_by_other_process'))
        return latestState;
      throw error;
    }
    runtime.lifecycle?.onExecutionStart?.(latestState);
    runtime.lifecycle?.onExecutionSettled?.(cancelledState);
    await cleanupExecutionTempDir(cancelledState, runtime);
    return cancelledState;
  }

  await clearExecutionCancellation(executionId, runtime.executionsDir);
  return latestState;
}
