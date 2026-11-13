import { buildPipelineSecretBindings } from '../execution-secrets/bindings';
import type { RedeemedExecutionSecrets } from '@canopy/core-runtime/node/execution-secrets';
import { authorizePipelineReplay } from './pipeline-replay-authorization';
import { pipelineSpeedError } from './codex-speed';
import { randomUUID } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import type {
  WorkerPipelineControlOutcome,
  WorkerPipelineExecutionResumeParams,
} from '@canopy/protocol/canopy-core';
import type { BrowserWindow } from 'electron';
import {
  loadExecutionState,
  type ExecutionOptions,
  type ExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor';
import type { PipelineScalar } from '@canopy/execution-engine/types/pipeline';
import { resolveEnvironmentForRuntime } from '@canopy/desktop-shared/lib/user-environment';
import { readPreferencesFile } from '../lib/preferences-store';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { readEnvironmentConfig } from '../lib/user-environment-store';
import { getCachedClaudeAuthStatusObserved } from '../auth/provider-auth-state';
import { getEffectiveClaudeWorkerModePreferences } from '../lib/claude-tui-workers';
import { getResourceMonitorService } from '../resource-monitor';
import { buildPipelinePreferenceEnv } from './preference-env';
import { getPipelineAdvisorService } from './pipeline-advisor';
import {
  getActiveExecutionHandle,
  hasActiveExecution,
  releaseExecutionReservation,
  reserveExecution,
  trackExecution,
} from './pipeline-execution-registry';
import { buildPipelineBaseBranchEnv } from './worktree-base-branch-env';
import { cancelPendingTransientRetryTimer } from './transient-error-retry-scheduler';
import {
  controlPipelineThroughLocalWorker,
  followExecutionHandle,
} from './pipeline-worker-dispatch';
import {
  pipelineExecutorControls,
  readStoredPipelineExecution,
} from './pipeline-worker-host';

export interface ResumePipelineExecutionFromMainRequest {
  executionId: string;
  statusReasonIds?: string[];
  inputAnswers?: Record<string, PipelineScalar>;
  pauseResponses?: ExecutionOptions['pauseResponses'];
  inputs?: ExecutionOptions['inputs'];
  repoPath?: string;
  cwd?: string;
  env?: Record<string, string>;
  allowStaleNoop?: boolean;
  transientRetryOwnToken?: number;
  initiationSource: 'user' | 'automation' | 'portal';
  /**
   * Opts a trusted caller into changing attribution for the remaining
   * execution. Internal recovery callers leave this unset so a user-started
   * run stays attended across retries and maintenance resumes.
   */
  persistInitiationSource?: boolean;
  portalCommandId?: string;
  getWindow: () => BrowserWindow | null;
  onEvent?: ExecutionOptions['onEvent'];
  onStepOutput?: ExecutionOptions['onStepOutput'];
}

export type ResumePipelineExecutionFromMainResult =
  | { status: 'started'; state: ExecutionState }
  | { status: 'stale-noop'; state: ExecutionState }
  | { status: 'already-running'; state: ExecutionState };

const STATUS_REASON_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function exists(target: string, directory = false): Promise<boolean> {
  try {
    if (directory) return (await stat(target)).isDirectory();
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveStoredCwd(state: ExecutionState): Promise<string> {
  if (state.target?.scope === 'directory') {
    if (await exists(state.target.path, true)) return state.target.path;
    throw new Error(
      `Directory target path does not exist: ${state.target.path}`,
    );
  }
  if (state.target?.scope === 'worktree') {
    if (await exists(state.target.path, true)) return state.target.path;
    throw new Error(
      `Worktree target "${state.target.workspace_id}/${state.target.worktree_id}" no longer exists`,
    );
  }
  if (state.project_id && state.worktree_id) {
    try {
      const cwd = resolveWorktreeCwd(state.project_id, state.worktree_id);
      if (await exists(cwd)) return cwd;
    } catch {
      if (state.scope === 'worktree') {
        throw new Error(
          `Worktree target "${state.project_id}/${state.worktree_id}" no longer exists`,
        );
      }
    }
  }
  return state.cwd;
}

async function runtimeEnvironment(workspaceId?: string): Promise<{
  env: Record<string, string>;
}> {
  try {
    const { data } = await readEnvironmentConfig();
    const resolved = resolveEnvironmentForRuntime(data, {
      runtime: 'pipeline',
      ...(workspaceId ? { workspaceId } : {}),
    });
    return {
      env: resolved.publicApplied,
    };
  } catch {
    return { env: {} };
  }
}

async function terminalMode(
  preferred: 'canopy' | 'terminal',
): Promise<boolean> {
  if (preferred !== 'terminal') return false;
  return (
    await getCachedClaudeAuthStatusObserved('pipeline-terminal-mode', {
      forceRefresh: true,
    })
  ).authenticated;
}

const RESUME_OUTCOMES = {
  started: 'started',
  'stale-noop': 'stale_noop',
  'already-running': 'already_running',
} as const satisfies Record<
  ResumePipelineExecutionFromMainResult['status'],
  WorkerPipelineControlOutcome
>;

function resumeStatusOf(
  outcome: WorkerPipelineControlOutcome,
): ResumePipelineExecutionFromMainResult['status'] {
  if (outcome === 'stale_noop') return 'stale-noop';
  if (outcome === 'already_running') return 'already-running';
  return 'started';
}

/**
 * Resume a paused execution, answering its pending inputs. Core records the
 * resume and dispatches it to the local worker as
 * `worker.pipeline.execution.resume` (CAN-4141); the pauses and answers it
 * runs are the dispatched command's.
 */
export async function resumePipelineExecutionFromMain(
  request: ResumePipelineExecutionFromMainRequest,
): Promise<ResumePipelineExecutionFromMainResult> {
  validateStatusReasonIds(request.statusReasonIds);
  const params: WorkerPipelineExecutionResumeParams = {
    requestId: request.portalCommandId ?? randomUUID(),
    executionId: request.executionId,
    ...(request.statusReasonIds
      ? { statusReasonIds: request.statusReasonIds }
      : {}),
    ...(request.pauseResponses?.length
      ? {
          pauseResponses: request.pauseResponses.map((response) => ({
            ...(response.checkpoint_id !== undefined
              ? { checkpointId: response.checkpoint_id }
              : {}),
            jobId: response.job_id,
            stepId: response.step_id,
            ...(response.answers ? { answers: response.answers } : {}),
          })),
        }
      : {}),
    ...(request.allowStaleNoop ? { allowStaleNoop: true } : {}),
    initiationSource: request.initiationSource,
    ...(request.persistInitiationSource
      ? { persistInitiationSource: true }
      : {}),
  };
  const state = await readStoredPipelineExecution(request.executionId);
  const secretBindings = await buildPipelineSecretBindings({
    workspaceId: state?.project_id,
  });
  const settled = await controlPipelineThroughLocalWorker(
    { operation: 'worker.pipeline.execution.resume', params },
    async (control, _signal, secrets) => {
      if (control.operation !== 'worker.pipeline.execution.resume')
        throw new Error('Unexpected workflow control.');
      const command = control.params;
      const result = await resumeOnLocalWorker(
        {
          ...request,
          statusReasonIds: command.statusReasonIds,
          pauseResponses: command.pauseResponses?.map((response) => ({
            ...(response.checkpointId !== undefined
              ? { checkpoint_id: response.checkpointId }
              : {}),
            job_id: response.jobId,
            step_id: response.stepId,
            ...(response.answers ? { answers: response.answers } : {}),
          })),
          allowStaleNoop: command.allowStaleNoop,
          initiationSource: command.initiationSource,
          persistInitiationSource: command.persistInitiationSource,
        },
        secrets,
      );
      return { outcome: RESUME_OUTCOMES[result.status], state: result.state };
    },
    request.initiationSource === 'automation' ? 'automation' : 'client',
    secretBindings,
  );
  return { status: resumeStatusOf(settled.outcome), state: settled.state };
}

function validateStatusReasonIds(statusReasonIds: string[] | undefined): void {
  if (statusReasonIds) {
    if (statusReasonIds.length === 0) {
      throw new Error('statusReasonIds must contain at least one reason ID');
    }
    if (new Set(statusReasonIds).size !== statusReasonIds.length) {
      throw new Error('statusReasonIds must not contain duplicate reason IDs');
    }
    if (
      statusReasonIds.some(
        (reasonId) => !STATUS_REASON_ID_PATTERN.test(reasonId),
      )
    ) {
      throw new Error('statusReasonIds contains a malformed reason ID');
    }
  }
}

/** The local worker's side of a resume: the entry point as it always ran. */
async function resumeOnLocalWorker(
  request: ResumePipelineExecutionFromMainRequest,
  secrets: RedeemedExecutionSecrets,
): Promise<ResumePipelineExecutionFromMainResult> {
  cancelPendingTransientRetryTimer(
    request.executionId,
    request.transientRetryOwnToken,
  );
  // Defer the runtime to break the canopy-tools/worktree-actions ->
  // pipeline-resume-service -> execution-runtime -> canopy-tools/worktree-actions
  // initialization cycle during unrelated main-process module loads.
  const { createElectronExecutionRuntime } =
    await import('./execution-runtime');
  const runtime = createElectronExecutionRuntime(request.getWindow);
  runtime.resourceMonitor = getResourceMonitorService();
  const state = await loadExecutionState(
    request.executionId,
    runtime.executionsDir,
  );
  if (!state) throw new Error(`Execution "${request.executionId}" not found`);
  const speedError = pipelineSpeedError(state.model_config);
  if (speedError) throw new Error(speedError);
  const continuationInitiationSource = request.persistInitiationSource
    ? request.initiationSource
    : state.initiation_source;

  if (hasActiveExecution(request.executionId)) {
    const active = getActiveExecutionHandle(request.executionId);
    if (active?.resumePaused) {
      const activeState = active.getState();
      const activeSpeedError = pipelineSpeedError(activeState.model_config);
      if (activeSpeedError) throw new Error(activeSpeedError);
      const hasPauseResponses = (request.pauseResponses?.length ?? 0) > 0;
      let activeReasonIds =
        request.statusReasonIds ??
        (hasPauseResponses
          ? []
          : activeState.status_reasons
              .filter((reason) => reason.kind !== 'input_required')
              .map((reason) => reason.id));
      if (request.allowStaleNoop && request.statusReasonIds) {
        const currentIds = new Set(
          activeState.status_reasons.map((reason) => reason.id),
        );
        if (activeState.shutdown_checkpoint) {
          currentIds.add(activeState.shutdown_checkpoint.id);
        }
        activeReasonIds = activeReasonIds.filter((id) => currentIds.has(id));
        if (activeReasonIds.length === 0 && !hasPauseResponses) {
          return { status: 'stale-noop', state: activeState };
        }
      }
      if (activeReasonIds.length === 0 && !hasPauseResponses) {
        return { status: 'already-running', state: activeState };
      }
      const authorization = await authorizePipelineReplay(activeState);
      const resumedJobIds = new Set<string>();
      for (const reasonId of activeReasonIds) {
        const reason = activeState.status_reasons.find(
          (candidate) => candidate.id === reasonId,
        );
        if (reason) resumedJobIds.add(reason.source.job_id);
      }
      for (const response of request.pauseResponses ?? []) {
        resumedJobIds.add(response.job_id);
      }
      const resumedJobsSettledOrPaused = (
        candidateState: ExecutionState,
      ): boolean =>
        resumedJobIds.size > 0 &&
        Array.from(resumedJobIds).every((jobId) => {
          const jobStatus = candidateState.jobs[jobId]?.status;
          if (
            jobStatus === 'success' ||
            jobStatus === 'failure' ||
            jobStatus === 'cancelled' ||
            jobStatus === 'skipped'
          ) {
            return true;
          }
          return (
            candidateState.pending_pauses?.some(
              (checkpoint) => checkpoint.job_id === jobId,
            ) === true ||
            candidateState.status_reasons.some(
              (reason) => reason.source.job_id === jobId,
            )
          );
        });
      let observerDisposer: (() => void) | undefined;
      let observersRemoved = false;
      const removeObservers = (): void => {
        if (observersRemoved) return;
        observersRemoved = true;
        observerDisposer?.();
      };
      if (request.onEvent || request.onStepOutput) {
        if (!active.addObservers) {
          throw new Error(
            `Execution "${request.executionId}" cannot attach resume observers`,
          );
        }
        const onEvent: NonNullable<ExecutionOptions['onEvent']> = (event) => {
          try {
            request.onEvent?.(event);
          } finally {
            if (
              event.state.status === 'success' ||
              event.state.status === 'failure' ||
              event.state.status === 'cancelled' ||
              resumedJobsSettledOrPaused(event.state) ||
              (resumedJobIds.size === 0 && event.type === 'execution.paused')
            ) {
              removeObservers();
            }
          }
        };
        observerDisposer = active.addObservers({
          onEvent,
          onStepOutput: request.onStepOutput,
        });
      }
      try {
        const resumedState = authorization
          ? await active.resumePaused(
              activeReasonIds,
              request.pauseResponses,
              continuationInitiationSource,
              request.portalCommandId,
              authorization,
            )
          : request.portalCommandId
            ? await active.resumePaused(
                activeReasonIds,
                request.pauseResponses,
                continuationInitiationSource,
                request.portalCommandId,
              )
            : await active.resumePaused(
                activeReasonIds,
                request.pauseResponses,
                continuationInitiationSource,
              );
        if (
          resumedState.status === 'success' ||
          resumedState.status === 'failure' ||
          resumedState.status === 'cancelled' ||
          resumedJobsSettledOrPaused(resumedState)
        ) {
          removeObservers();
        }
        return { status: 'started', state: resumedState };
      } catch (error) {
        removeObservers();
        throw error;
      }
    }
    return { status: 'already-running', state: active?.getState() ?? state };
  }
  let selectedReasonIds = request.statusReasonIds;
  if (request.allowStaleNoop && request.statusReasonIds?.length) {
    const activeIds = new Set(state.status_reasons.map((reason) => reason.id));
    if (state.shutdown_checkpoint) {
      activeIds.add(state.shutdown_checkpoint.id);
    }
    selectedReasonIds = request.statusReasonIds.filter((id) =>
      activeIds.has(id),
    );
    if (selectedReasonIds.length === 0) {
      return { status: 'stale-noop', state };
    }
  }
  if (
    request.allowStaleNoop &&
    (state.status === 'success' ||
      state.status === 'failure' ||
      state.status === 'cancelled')
  ) {
    return { status: 'stale-noop', state };
  }

  const resource = getResourceMonitorService().reservePipelineExecutionStart();
  let ownsExecutionReservation = false;
  try {
    reserveExecution(request.executionId);
    ownsExecutionReservation = true;
    const preferences = await readPreferencesFile();
    const cwd = request.cwd ?? (await resolveStoredCwd(state));
    const baseBranchEnv = await buildPipelineBaseBranchEnv({
      cwd,
      projectId: state.project_id,
      worktreeId: state.worktree_id,
    });
    const runtimeEnv = await runtimeEnvironment(state.project_id);
    const authorization = await authorizePipelineReplay(state);
    const handle = await pipelineExecutorControls.resume(request.executionId, {
      ...authorization,
      cwd,
      statusReasonIds: selectedReasonIds,
      inputAnswers: request.inputAnswers,
      pauseResponses: request.pauseResponses,
      inputs: request.inputs,
      repoPath: request.repoPath,
      initiationSource: continuationInitiationSource,
      ...(request.portalCommandId
        ? { portalCommandId: request.portalCommandId }
        : {}),
      agentTerminalMode: await terminalMode(
        getEffectiveClaudeWorkerModePreferences(preferences).pipelinesMode,
      ),
      env: {
        ...runtimeEnv.env,
        ...(await buildPipelinePreferenceEnv(preferences)),
        ...baseBranchEnv,
        ...(request.env ?? {}),
      },
      secretEnv: Object.keys(secrets.env).length ? secrets.env : undefined,
      runtime,
      onEvent: request.onEvent,
      onStepOutput: request.onStepOutput,
    });
    trackExecution(handle);
    followExecutionHandle(handle);
    ownsExecutionReservation = false;
    getPipelineAdvisorService().watchExecution({
      handle,
      runtime,
      getWindow: request.getWindow,
    });
    return { status: 'started', state: handle.getState() };
  } catch (error) {
    if (ownsExecutionReservation) {
      releaseExecutionReservation(request.executionId);
    }
    throw error;
  } finally {
    resource.release();
  }
}
