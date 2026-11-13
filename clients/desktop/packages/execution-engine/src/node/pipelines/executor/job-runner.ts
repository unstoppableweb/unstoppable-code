import type { ResourceContextInput } from '@canopy/execution-engine/lib/resource-context-policy';
import type { ChildPipelineAuthorization } from './child-pipeline-resolver';
import {
  buildExpressionAssets,
  buildExpressionContext,
  cascadeEnv,
  inputsToEnv,
  rehydrateJobContext,
  type ExpressionAssetsContext,
  type ExpressionCanopyContext,
  type ExpressionJobState,
  type ExpressionNeedsState,
} from './execution-context';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  evaluateCondition,
  interpolateExpression,
} from './expression-evaluator';
import { interpolateNormalizedStep } from './step-interpolation';
import {
  createPendingStep,
  isStepTerminal,
  snapshotIterationAttempt,
  snapshotRetryAttempt,
} from './retry-utils';
import {
  extractInputRequest,
  extractReportOutputs,
  getStepLogFilePath,
  runStep,
  sanitizePauseControlOutputKeys,
  sanitizeReportOutputKeys,
  sanitizeRestartOutputKeys,
  stepRequestedPause,
  stepRequestedRestart,
  type StepLogMetadata,
} from './step-runner';
import type {
  ExecutionEvent,
  ExecutionRuntime,
  JobResult,
  NormalizedJob,
  NormalizedPipeline,
  StepOutputEvent,
  StepResult,
} from './types';
import type {
  PipelineAgentChatAddress,
  PipelineExecutionInitiator,
  PipelineExecutionScope,
  PipelineModelAlias,
  PipelineModelAliasPreference,
  PipelineInputValue,
  MatrixContext,
  ResolvedPipelineExecutionTarget,
  ResolvedPipelinePluginCollectionSnapshot,
  PipelineStatusReason,
  PipelinePackageCapabilityOverlay,
  PipelinePackageBinding,
  PipelineAssetExecutionContext,
} from '@canopy/execution-engine/types/pipeline';
import type { AgentModelConfig } from '@canopy/execution-engine/execution-types';
import type { UsageInitiationSource } from '@canopy/execution-engine/types/observability';
import { setBrandEnv } from '@canopy/execution-engine/brand/env';
import { filterPipelinePackageOverlayForStep } from '@canopy/execution-engine/node/pipelines/package-runtime';
import { recordedLedgerAgentSession } from './pipeline-ledger';
import { isPipelineHostWaitStep, type PipelineStepDrain } from './step-drain';
import {
  pipelineStepMemoryEstimate,
  type PipelineCapacityGate,
  type PipelineStepActionFacts,
} from './capacity-gate';
import { resolveActionRuntime } from '../action-resolver';

export interface RunJobOptions {
  executionId: string;
  jobId: string;
  pipeline: NormalizedPipeline;
  job: NormalizedJob;
  jobResult: JobResult;
  cwd: string;
  env: Record<string, string>;
  pipelineFileDir?: string;
  /** In-memory file source locator, independent of the execution target. */
  pipelineSource?: { cwd: string; filePath: string };
  /** In-memory inherited provenance for inline children; never sourced from YAML. */
  inlinePipelineResource?: ResourceContextInput['resource'];
  secretEnv?: Record<string, string>;
  runtime: ExecutionRuntime;
  repoPath?: string;
  executionCheckoutRoot?: string | null;
  scope?: PipelineExecutionScope;
  target?: ResolvedPipelineExecutionTarget;
  modelConfig?: AgentModelConfig;
  depth?: number;
  needs: Record<string, ExpressionNeedsState>;
  inputs: Record<string, PipelineInputValue>;
  canopy?: ExpressionCanopyContext;
  /** Resolved asset paths and data dirs; inherited by child runs. */
  pipelineAssets?: PipelineAssetExecutionContext;
  signal: AbortSignal;
  saveState: () => Promise<void>;
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
  resolvedPluginCollections?: Record<
    string,
    ResolvedPipelinePluginCollectionSnapshot
  >;
  modelAliases?: readonly PipelineModelAlias[];
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
  onStatusReason?: (reason: PipelineStatusReason) => void | Promise<void>;
  matrix?: MatrixContext;
  childId?: string;
  pipelinePackageOverlay?: PipelinePackageCapabilityOverlay;
  pipelinePackageBindings?: PipelinePackageBinding[];
  pipelinePackageLogicalJobId?: string;
  /** Holds new steps while the run drains for a checkpoint (CAN-6199). */
  stepDrain?: PipelineStepDrain;
  /**
   * Holds a step that would start while its host's memory is tight
   * (CAN-6325). `keepChatReserve` leaves the chats' share free for a run
   * that shares its worktree with them.
   */
  capacity?: {
    readonly gate: PipelineCapacityGate;
    readonly keepChatReserve: boolean;
  };
}

/**
 * The Ledger agent session of the attempt a job retry replaces: the step's
 * session in the latest retry snapshot, when it ran with Ledger tools. A new
 * iteration is a new identity, not a retry, so it has none.
 */
function retriedLedgerAgentSession(
  jobResult: JobResult,
  stepId: string,
): { ledgerPredecessorAgentSessionId?: string } {
  const history = jobResult.retry_history ?? [];
  const previous = recordedLedgerAgentSession(
    history[history.length - 1]?.steps[stepId],
  );
  return previous === undefined
    ? {}
    : { ledgerPredecessorAgentSessionId: previous };
}

/** What a step's action manifest declares, for its memory estimate. */
function stepActionFacts(
  options: RunJobOptions,
  step: NormalizedJob['steps'][number],
): PipelineStepActionFacts | undefined {
  if (!step.uses || step.uses === 'builtin/run-pipeline') return undefined;
  try {
    const action = resolveActionRuntime(
      step.uses,
      options.runtime,
      options.repoPath,
      options.pipelinePackageOverlay,
    );
    if (!action) return undefined;
    return {
      runsUsing: action.definition.runs.using,
      ...(action.definition.log_format_hint === undefined
        ? {}
        : { logFormatHint: action.definition.log_format_hint }),
    };
  } catch {
    // The step runner reports an action it can't read; estimate a shell step.
    return undefined;
  }
}

function createSkippedStepResult(): StepResult {
  return {
    status: 'skipped',
    conclusion: 'skipped',
    outcome: 'skipped',
    outputs: {},
    dynamic_env: {},
    completed_at: new Date().toISOString(),
  };
}

function createCancelledStepResult(): StepResult {
  return {
    status: 'cancelled',
    conclusion: 'cancelled',
    outcome: 'cancelled',
    outputs: {},
    dynamic_env: {},
    completed_at: new Date().toISOString(),
  };
}

function buildJobContext(
  retryCount: number,
  maxRetries: number,
): ExpressionJobState {
  return {
    is_retry: retryCount > 0,
    retry_count: retryCount,
    max_retries: maxRetries,
  };
}

function buildRetryEnvVars(
  jobContext: ExpressionJobState,
  currentIteration: number,
  maxIterations: number,
): Record<string, string> {
  const effectiveIteration =
    Number.isFinite(currentIteration) && currentIteration > 0
      ? currentIteration
      : 1;
  const effectiveMaxIterations =
    Number.isFinite(maxIterations) && maxIterations > 0 ? maxIterations : 1;
  const env: Record<string, string> = {};
  setBrandEnv(env, 'JOB_IS_RETRY', jobContext.is_retry ? 'true' : 'false');
  setBrandEnv(env, 'JOB_RETRY_COUNT', String(jobContext.retry_count));
  setBrandEnv(env, 'JOB_MAX_RETRIES', String(jobContext.max_retries));
  setBrandEnv(env, 'JOB_ITERATION', String(effectiveIteration));
  setBrandEnv(env, 'JOB_MAX_ITERATIONS', String(effectiveMaxIterations));
  return env;
}

function resetJobForRetry(job: NormalizedJob, jobResult: JobResult): void {
  jobResult.status = 'pending';
  jobResult.outcome = undefined;
  jobResult.conclusion = undefined;
  jobResult.completed_at = undefined;
  jobResult.outputs = {};
  jobResult.report_outputs = undefined;
  jobResult.iteration_count = 1;
  jobResult.iteration_history = undefined;
  jobResult.steps = Object.fromEntries(
    job.steps.map((step) => [step.id, createPendingStep()]),
  );
}

function resetJobForRestart(job: NormalizedJob, jobResult: JobResult): void {
  jobResult.status = 'pending';
  jobResult.outcome = undefined;
  jobResult.conclusion = undefined;
  jobResult.completed_at = undefined;
  jobResult.outputs = {};
  jobResult.report_outputs = undefined;
  jobResult.steps = Object.fromEntries(
    job.steps.map((step) => [step.id, createPendingStep()]),
  );
}

function buildStepFunctions(
  steps: Record<string, { outcome?: string; conclusion?: string }>,
  signal: AbortSignal,
): {
  success: () => boolean;
  failure: () => boolean;
  cancelled: () => boolean;
  always: () => boolean;
} {
  return {
    success: () =>
      Object.values(steps).every(
        (step) => step.outcome !== 'failure' && step.conclusion !== 'cancelled',
      ),
    failure: () =>
      Object.values(steps).some((step) => step.outcome === 'failure'),
    cancelled: () =>
      signal.aborted ||
      Object.values(steps).some((step) => step.conclusion === 'cancelled'),
    always: () => true,
  };
}

function finalizeJobResult(
  job: NormalizedJob,
  jobResult: JobResult,
  stepStates: Record<
    string,
    { outputs: Record<string, string>; outcome?: string; conclusion?: string }
  >,
  env: Record<string, string>,
  needs: Record<string, ExpressionNeedsState>,
  inputs: Record<string, PipelineInputValue>,
  jobContext: ExpressionJobState,
  canopy?: ExpressionCanopyContext,
  matrix?: MatrixContext,
  assets?: ExpressionAssetsContext,
): void {
  jobResult.outputs = Object.fromEntries(
    Object.entries(job.outputs ?? {}).map(([name, expression]) => [
      name,
      interpolateExpression(
        expression,
        buildExpressionContext({
          env,
          inputs,
          steps: stepStates,
          needs,
          job: jobContext,
          canopy,
          matrix,
          assets,
        }),
      ),
    ]),
  );

  const hasFailure = Object.values(stepStates).some(
    (step) => step.outcome === 'failure',
  );
  const isFinalAttempt = jobContext.retry_count >= jobContext.max_retries;
  jobResult.outcome = hasFailure ? 'failure' : 'success';
  jobResult.conclusion =
    hasFailure && job.continue_on_error && isFinalAttempt
      ? 'success'
      : jobResult.outcome;
  // status mirrors the job's own outcome; conclusion may still be "success"
  // due to continue_on_error and is used for downstream dependency gating.
  jobResult.status = jobResult.outcome;
  jobResult.completed_at = new Date().toISOString();
}

async function executeJobAttempt(
  options: RunJobOptions,
  jobContext: ExpressionJobState,
  attempt: number,
  iterationStartedAt: string,
): Promise<JobResult> {
  const retryEnv = buildRetryEnvVars(
    jobContext,
    options.jobResult.iteration_count ?? 1,
    options.job.max_iterations ?? 1,
  );
  const pipelineInputEnv = inputsToEnv(options.inputs);
  const rehydrated = rehydrateJobContext(options.job, options.jobResult);
  const stepStates = rehydrated.steps;
  const accumulatedDynamicEnv = { ...rehydrated.dynamicEnv };

  const cancelRemainingSteps = async (): Promise<JobResult> => {
    for (const remainingStep of options.job.steps) {
      if (!isStepTerminal(options.jobResult.steps[remainingStep.id])) {
        options.jobResult.steps[remainingStep.id] = createCancelledStepResult();
      }
    }
    options.jobResult.status = 'cancelled';
    options.jobResult.outcome = 'cancelled';
    options.jobResult.conclusion = 'cancelled';
    options.jobResult.completed_at = new Date().toISOString();
    await options.saveState();
    return options.jobResult;
  };

  for (const step of options.job.steps) {
    // A step that would start waits while the run drains for a checkpoint,
    // and counts as running from then until it ends.
    let leaveDrain = isStepTerminal(options.jobResult.steps[step.id])
      ? undefined
      : await options.stepDrain?.admit(
          options.signal,
          isPipelineHostWaitStep(step),
        );
    if (options.signal.aborted) {
      leaveDrain?.();
      return cancelRemainingSteps();
    }

    const existingStep = options.jobResult.steps[step.id];
    if (isStepTerminal(existingStep)) {
      continue;
    }
    const recoveryCheckpoint = existingStep?.agent_recovery;
    const recoveryNumber = recoveryCheckpoint
      ? (existingStep.recovery_count ?? recoveryCheckpoint.recovery_count)
      : 0;

    const expressionEnv = cascadeEnv(
      options.env,
      retryEnv,
      accumulatedDynamicEnv,
    );
    const expressionContext = buildExpressionContext({
      env: expressionEnv,
      inputs: options.inputs,
      steps: stepStates,
      needs: options.needs,
      job: jobContext,
      canopy: options.canopy,
      matrix: options.matrix,
      assets: buildExpressionAssets(options.pipelineAssets?.asset_paths),
    });
    const shouldRun = evaluateCondition(
      step.if,
      expressionContext,
      buildStepFunctions(stepStates, options.signal),
    );

    if (!shouldRun) {
      leaveDrain?.();
      options.jobResult.steps[step.id] = createSkippedStepResult();
      stepStates[step.id] = {
        outputs: {},
        outcome: 'skipped',
        conclusion: 'skipped',
      };
      await options.saveState();
      continue;
    }

    // A step that would start waits while its host's memory is tight. While
    // it waits it counts to the drain as a wait, not a running step, so a
    // checkpoint never waits on it; and it never holds memory while the
    // drain holds it, so other runs' steps can still finish.
    let leaveCapacity: (() => void) | undefined;
    const estimateBytes = options.capacity
      ? pipelineStepMemoryEstimate(step, stepActionFacts(options, step))
      : 0;
    if (options.capacity && estimateBytes > 0) {
      const hostWait = isPipelineHostWaitStep(step);
      leaveDrain?.();
      leaveDrain = undefined;
      while (!options.signal.aborted) {
        const leaveWait = options.stepDrain?.wait();
        const admitted = await options.capacity.gate.admit(
          options.signal,
          {
            estimateBytes,
            keepChatReserve: options.capacity.keepChatReserve,
          },
          () => {
            options.jobResult.steps[step.id] = {
              ...(options.jobResult.steps[step.id] ?? createPendingStep()),
              status: 'waiting_for_capacity',
            };
            options.jobResult.status = 'waiting_for_capacity';
            // The step's next save reports any failure.
            void options.saveState().catch(() => undefined);
          },
        );
        leaveWait?.();
        if (!admitted) break;
        if (!options.stepDrain?.isDraining()) {
          leaveCapacity = admitted;
          leaveDrain = await options.stepDrain?.admit(options.signal, hostWait);
          break;
        }
        // The drain holds it: give the memory back while it waits there,
        // and ask again if the drain lets it go without stopping the run.
        admitted();
        const leaveHeld = await options.stepDrain.admit(
          options.signal,
          hostWait,
        );
        if (options.signal.aborted) {
          leaveDrain = leaveHeld;
          break;
        }
        leaveHeld();
      }
      // A cancel while it waited has already settled the step and its job.
      const heldStep = options.jobResult.steps[step.id];
      if (heldStep?.status === 'waiting_for_capacity')
        options.jobResult.steps[step.id] = { ...heldStep, status: 'pending' };
      if (options.jobResult.status === 'waiting_for_capacity')
        options.jobResult.status = 'running';
      if (options.signal.aborted) {
        leaveDrain?.();
        leaveCapacity?.();
        return cancelRemainingSteps();
      }
    }
    const leaveStep = (): void => {
      leaveDrain?.();
      leaveCapacity?.();
    };

    // Whatever ends the step, including a throw before it runs, releases
    // its drain and capacity shares.
    let stepResult: StepResult;
    try {
      const interpolatedStep = interpolateNormalizedStep(
        step,
        expressionContext,
      );
      let resolvedStep = interpolatedStep;
      if (recoveryCheckpoint?.strategy === 'continue_session') {
        const sessionId = recoveryCheckpoint.session_id;
        if (!sessionId) {
          throw new Error(
            `Agent recovery checkpoint for "${options.jobId}.${step.id}" is missing its provider session ID`,
          );
        }
        resolvedStep = {
          ...interpolatedStep,
          uses: 'builtin/agent-resume',
          run: undefined,
          with: {
            ...(interpolatedStep.with ?? {}),
            session_id: sessionId,
            prompt: 'Continue',
            prompt_file: '',
          },
        };
      }
      const logFile = getStepLogFilePath(
        options.runtime,
        options.executionId,
        options.jobId,
        step.id,
        attempt,
        options.jobResult.iteration_count ?? 1,
        recoveryNumber,
        options.childId,
      );

      // Resuming a checkpoint keeps the Ledger agent session it paused with.
      const resumedLedgerAgentSession = recoveryCheckpoint
        ? recordedLedgerAgentSession(existingStep)
        : undefined;
      options.jobResult.steps[step.id] = {
        status: 'running',
        outputs: {},
        dynamic_env: {},
        started_at: new Date().toISOString(),
        log_file: logFile,
        resolved_run: resolvedStep.run,
        ...(recoveryCheckpoint
          ? {
              agent_recovery: recoveryCheckpoint,
              agent_recovery_history: existingStep.agent_recovery_history,
              recovery_count: recoveryNumber,
              ...(resumedLedgerAgentSession
                ? { ledger_agent_session_id: resumedLedgerAgentSession }
                : {}),
            }
          : {}),
        child_execution_id: existingStep?.child_execution_id,
        selected_child_reason_ids: existingStep?.selected_child_reason_ids,
      };
      await options.saveState();

      stepResult = await runStep({
        executionId: options.executionId,
        jobId: options.jobId,
        jobName: options.job.name ?? options.jobId,
        step: resolvedStep,
        cwd: options.cwd,
        env: cascadeEnv(
          options.env,
          pipelineInputEnv,
          retryEnv,
          accumulatedDynamicEnv,
          resolvedStep.env,
        ),
        pipelineFileDir: options.pipelineFileDir,
        ...(options.pipelineSource
          ? { pipelineSource: options.pipelineSource }
          : {}),
        ...(options.inlinePipelineResource
          ? { inlinePipelineResource: options.inlinePipelineResource }
          : {}),
        secretEnv: options.secretEnv,
        runtime: options.runtime,
        repoPath: options.repoPath,
        executionCheckoutRoot: options.executionCheckoutRoot,
        scope: options.scope,
        target: options.target,
        modelConfig: options.modelConfig,
        signal: options.signal,
        depth: options.depth,
        attempt,
        iteration: options.jobResult.iteration_count ?? 1,
        recovery: recoveryNumber,
        recoveryCheckpoint,
        logicalJobId: options.pipelinePackageLogicalJobId ?? options.jobId,
        ...(resumedLedgerAgentSession
          ? { ledgerAgentSessionId: resumedLedgerAgentSession }
          : {}),
        // A retry restarts at iteration 1; later iterations are new agents.
        ...(recoveryCheckpoint === undefined &&
        (options.jobResult.iteration_count ?? 1) === 1
          ? retriedLedgerAgentSession(options.jobResult, step.id)
          : {}),
        childId: options.childId,
        resumeChildExecutionId: existingStep?.child_execution_id,
        resumeChildReasonIds: existingStep?.selected_child_reason_ids,
        jobContext,
        canopy: options.canopy,
        pipelineAssets: options.pipelineAssets,
        onStepOutput: options.onStepOutput,
        onEvent: options.onEvent,
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        initiationSource: options.initiationSource,
        initiator: options.initiator,
        agentOrigin: options.agentOrigin,
        ...(options.childPipelineAuthorizations === undefined
          ? {}
          : {
              childPipelineAuthorizations: options.childPipelineAuthorizations,
            }),
        ...(options.allowUnverifiedForegroundChildren
          ? { allowUnverifiedForegroundChildren: true }
          : {}),
        ...(options.executionContext === undefined
          ? {}
          : { executionContext: options.executionContext }),
        agentTerminalMode: options.agentTerminalMode,
        pipelineId: options.pipelineId,
        pipelineName: options.pipelineName,
        resolvedPluginCollections: options.resolvedPluginCollections,
        modelAliases: options.modelAliases,
        modelAliasPreferences: options.modelAliasPreferences,
        onStepPostProcess: options.runtime.onStepPostProcess,
        onLogMetadataResolved: async (
          metadata: StepLogMetadata,
        ): Promise<void> => {
          Object.assign(options.jobResult.steps[step.id], metadata);
          await options.saveState();
        },
        onRunningStepPatch: async (patchStepId, patch): Promise<void> => {
          Object.assign(options.jobResult.steps[patchStepId], patch);
          await options.saveState();
        },
        ...(options.pipelinePackageOverlay
          ? {
              pipelinePackageOverlay: options.pipelinePackageBindings
                ? filterPipelinePackageOverlayForStep(
                    options.pipelinePackageOverlay,
                    options.pipelinePackageBindings,
                    options.pipelinePackageLogicalJobId ?? options.jobId,
                    step.id,
                  )
                : options.pipelinePackageOverlay,
            }
          : {}),
      });
    } finally {
      leaveStep();
    }

    if (recoveryCheckpoint) {
      const recoveryTranscriptFile = stepResult.outputs.transcript_file;
      if (
        stepResult.status === 'success' &&
        recoveryCheckpoint.transcript_file &&
        typeof recoveryTranscriptFile === 'string'
      ) {
        try {
          const [beforeRecovery, recovered] = await Promise.all([
            readFile(recoveryCheckpoint.transcript_file, 'utf8'),
            readFile(recoveryTranscriptFile, 'utf8'),
          ]);
          const combinedTranscriptFile = path.join(
            path.dirname(recoveryTranscriptFile),
            `${path.basename(recoveryTranscriptFile, path.extname(recoveryTranscriptFile))}--combined.jsonl`,
          );
          await writeFile(
            combinedTranscriptFile,
            `${beforeRecovery.trimEnd()}\n${recovered.trimStart()}`,
            'utf8',
          );
          stepResult.outputs = {
            ...stepResult.outputs,
            transcript_file: combinedTranscriptFile,
          };
        } catch {
          // A missing transcript should not turn a successful provider recovery
          // into a failed pipeline step. The individual recovery log remains.
        }
      }
      const history = [...(existingStep.agent_recovery_history ?? [])];
      const activeAttempt = history[history.length - 1];
      if (activeAttempt?.status === 'running') {
        activeAttempt.completed_at = new Date().toISOString();
        activeAttempt.log_file = stepResult.log_file;
        activeAttempt.status =
          stepResult.status === 'paused'
            ? 'paused'
            : stepResult.status === 'success'
              ? 'success'
              : stepResult.status === 'cancelled'
                ? 'cancelled'
                : 'failure';
      }
      stepResult.agent_recovery_history = history;
      stepResult.recovery_count = recoveryNumber;
      if (stepResult.status === 'paused' && stepResult.agent_recovery) {
        stepResult.agent_recovery.recovery_count = recoveryNumber;
      } else {
        delete stepResult.agent_recovery;
      }
    }

    if (
      stepResult.status === 'paused' &&
      stepResult.agent_recovery &&
      stepResult.pause_reason
    ) {
      options.jobResult.steps[step.id] = stepResult;
      options.jobResult.status = 'paused';
      options.jobResult.completed_at = undefined;
      options.jobResult.outcome = undefined;
      options.jobResult.conclusion = undefined;
      await options.onStatusReason?.(stepResult.pause_reason);
      await options.saveState();
      return options.jobResult;
    }
    if (stepResult.status === 'paused' && stepResult.pause_reasons?.length) {
      options.jobResult.steps[step.id] = stepResult;
      options.jobResult.status = 'paused';
      options.jobResult.completed_at = undefined;
      options.jobResult.outcome = undefined;
      options.jobResult.conclusion = undefined;
      for (const reason of stepResult.pause_reasons) {
        await options.onStatusReason?.(reason);
      }
      await options.saveState();
      return options.jobResult;
    }

    if (stepResult.outcome === 'failure' && step.continue_on_error) {
      stepResult.status = 'success';
      stepResult.conclusion = 'success';
    }

    options.jobResult.steps[step.id] = stepResult;
    const reportOutputs = extractReportOutputs(stepResult.outputs);
    if (reportOutputs) {
      stepResult.outputs = sanitizeReportOutputKeys(stepResult.outputs);
      stepResult.report_outputs = reportOutputs;
      options.jobResult.steps[step.id] = stepResult;
      options.jobResult.report_outputs = {
        ...options.jobResult.report_outputs,
        ...reportOutputs,
      };
    }
    stepStates[step.id] = {
      outputs: stepResult.outputs,
      outcome: stepResult.outcome,
      conclusion: stepResult.conclusion,
    };
    Object.assign(accumulatedDynamicEnv, stepResult.dynamic_env);

    if (
      stepResult.conclusion === 'success' &&
      stepRequestedPause(stepResult.outputs)
    ) {
      const inputRequestResult = extractInputRequest(stepResult.outputs);
      const sanitizedOutputs = sanitizePauseControlOutputKeys(
        stepResult.outputs,
      );
      stepResult.outputs = sanitizedOutputs;
      if (inputRequestResult && 'error' in inputRequestResult) {
        stepResult.status = 'failure';
        stepResult.conclusion = 'failure';
        stepResult.outcome = 'failure';
        stepResult.error = inputRequestResult.error;
        delete stepResult.input_request;
        options.jobResult.steps[step.id] = stepResult;
        stepStates[step.id] = {
          outputs: sanitizedOutputs,
          outcome: stepResult.outcome,
          conclusion: stepResult.conclusion,
        };
      } else {
        stepResult.pause_requested = true;
        if (inputRequestResult) {
          stepResult.input_request = inputRequestResult.request;
        } else {
          delete stepResult.input_request;
        }
        options.jobResult.steps[step.id] = stepResult;
        stepStates[step.id] = {
          outputs: sanitizedOutputs,
          outcome: stepResult.outcome,
          conclusion: stepResult.conclusion,
        };
        options.jobResult.status = 'paused';
        options.jobResult.completed_at = undefined;
        options.jobResult.outcome = undefined;
        options.jobResult.conclusion = undefined;
        await options.onStatusReason?.({
          id: randomUUID(),
          kind: inputRequestResult ? 'input_required' : 'action_paused',
          code: inputRequestResult
            ? 'input_requested'
            : 'action_requested_pause',
          detected_at: new Date().toISOString(),
          source: {
            job_id: options.jobId,
            step_id: step.id,
            attempt,
            iteration: options.jobResult.iteration_count ?? 1,
          },
        });
        await options.saveState();
        return options.jobResult;
      }
    }

    if (
      stepResult.conclusion === 'success' &&
      stepRequestedRestart(stepResult.outputs)
    ) {
      const sanitizedOutputs = sanitizeRestartOutputKeys(stepResult.outputs);
      stepResult.outputs = sanitizedOutputs;
      options.jobResult.steps[step.id] = stepResult;
      stepStates[step.id] = {
        outputs: sanitizedOutputs,
        outcome: stepResult.outcome,
        conclusion: stepResult.conclusion,
      };

      const iteration = options.jobResult.iteration_count ?? 1;
      const maxIterations = options.job.max_iterations ?? 1;
      if (iteration >= maxIterations) {
        await options.saveState();
        continue;
      }

      const iterationCompletedAt = new Date().toISOString();
      options.jobResult.iteration_history ??= [];
      options.jobResult.iteration_history.push(
        snapshotIterationAttempt(
          options.jobResult,
          iteration,
          iterationStartedAt,
          iterationCompletedAt,
        ),
      );
      options.jobResult.iteration_count = iteration + 1;
      options.jobResult.status = 'restarting';
      options.jobResult.completed_at = undefined;
      options.jobResult.outcome = undefined;
      options.jobResult.conclusion = undefined;
      await options.saveState();
      return options.jobResult;
    }

    await options.saveState();

    if (stepResult.conclusion === 'cancelled') {
      for (const remainingStep of options.job.steps) {
        if (!isStepTerminal(options.jobResult.steps[remainingStep.id])) {
          options.jobResult.steps[remainingStep.id] =
            createCancelledStepResult();
        }
      }
      options.jobResult.status = 'cancelled';
      options.jobResult.outcome = 'cancelled';
      options.jobResult.conclusion = 'cancelled';
      options.jobResult.completed_at = new Date().toISOString();
      await options.saveState();
      return options.jobResult;
    }

    if (stepResult.outcome === 'failure' && !step.continue_on_error) {
      finalizeJobResult(
        options.job,
        options.jobResult,
        stepStates,
        cascadeEnv(options.env, retryEnv, accumulatedDynamicEnv),
        options.needs,
        options.inputs,
        jobContext,
        options.canopy,
        options.matrix,
        buildExpressionAssets(options.pipelineAssets?.asset_paths),
      );
      await options.saveState();
      return options.jobResult;
    }
  }

  finalizeJobResult(
    options.job,
    options.jobResult,
    stepStates,
    cascadeEnv(options.env, retryEnv, accumulatedDynamicEnv),
    options.needs,
    options.inputs,
    jobContext,
    options.canopy,
    options.matrix,
    buildExpressionAssets(options.pipelineAssets?.asset_paths),
  );
  await options.saveState();
  return options.jobResult;
}

export async function runJob(options: RunJobOptions): Promise<JobResult> {
  const maxRetries = options.job.max_retries ?? 0;
  const retryHistory = [...(options.jobResult.retry_history ?? [])];
  let attempt = Math.max(
    options.jobResult.retry_count ?? 0,
    retryHistory.length,
  );
  if (
    options.jobResult.iteration_count === undefined ||
    options.jobResult.iteration_count < 1
  ) {
    options.jobResult.iteration_count = 1;
  }
  const finalAttempt = Math.max(maxRetries, attempt);

  options.jobResult.started_at ??= new Date().toISOString();

  let attemptStartedAt: string | undefined;

  for (; attempt <= finalAttempt; attempt += 1) {
    attemptStartedAt ??= new Date().toISOString();
    const iterationStartedAt = new Date().toISOString();
    const jobContext = buildJobContext(attempt, maxRetries);
    options.jobResult.retry_count = attempt;
    options.jobResult.retry_history = retryHistory;
    options.jobResult.status = 'running';
    options.jobResult.completed_at = undefined;
    await options.saveState();

    const result = await executeJobAttempt(
      options,
      jobContext,
      attempt,
      iterationStartedAt,
    );

    if (result.status === 'paused') {
      return result;
    }

    if (result.status === 'restarting') {
      resetJobForRestart(options.job, result);
      result.retry_count = attempt;
      result.retry_history = retryHistory;
      await options.saveState();
      // Undo the loop increment — restarts should not consume retry attempts
      attempt -= 1;
      continue; // attemptStartedAt intentionally preserved across iteration restarts
    }

    if (result.conclusion !== 'failure' || attempt === finalAttempt) {
      return result;
    }

    retryHistory.push(snapshotRetryAttempt(result, attempt, attemptStartedAt));
    resetJobForRetry(options.job, result);
    result.retry_count = attempt + 1;
    result.retry_history = retryHistory;
    attemptStartedAt = undefined; // reset for next retry attempt
    await options.saveState();
  }

  return options.jobResult;
}
