import type { ExecutionSecretGrantHandle } from '@canopy/core-runtime/node/execution-secrets';
import { getDesktopExecutionSecrets } from '../execution-secrets/owner';
import {
  DAEMON_PIPELINE_CONTROL_REFUSED_MESSAGE,
  getDaemonPipelineExecutionHandle,
} from './daemon-pipeline-execution';
import { claimDaemonPipelineRoute } from './daemon-pipeline-route-context';
import { randomUUID } from 'node:crypto';
import type { PipelineControlRequest } from '@canopy/core-runtime/node/pipeline';
import {
  WORKER_PIPELINE_INITIATION_SOURCES,
  WORKER_PIPELINE_SWEEP_MAX,
  type ExecutionSecretBinding,
  type OperationOrigin,
  type OperationOwner,
  type WorkerPipelineExecutionStartParams,
} from '@canopy/protocol/canopy-core';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  ExecutionHandle,
  ExecutionOptions,
} from '@canopy/execution-engine/node/pipelines/executor';
import type {
  ExecutionState,
  Pipeline,
} from '@canopy/execution-engine/types/pipeline';
import {
  getDesktopCanopyRuntime,
  peekDesktopCanopyRuntime,
} from '../canopy-runtime/desktop-runtime-access';
import {
  attachPipelineHandle,
  definitionSourceOf,
  stagePipelineLaunch,
  pipelineCancelMark,
  readPipelineCancelCapture,
  readStoredPipelineExecution,
  stagePipelineControl,
  takePipelineRecoveryCapture,
  type PipelineControlLaunch,
  type PipelineControlSettlement,
} from './pipeline-worker-host';

/*
 * The start and cancel chokepoints of every desktop caller reach the local
 * pipeline worker here (CAN-4140): core records the run, then dispatches
 * `worker.pipeline.execution.start` or `.cancel` through the local worker.
 * Legacy callers keep their results: the live handle, the full cancelled
 * state and the executor's own error come back from the in-process host.
 */

const LOCAL_PRINCIPAL = 'local-desktop-user';
function initiationSourceOf(
  options: ExecutionOptions,
): WorkerPipelineExecutionStartParams['initiationSource'] {
  return (
    WORKER_PIPELINE_INITIATION_SOURCES.find(
      (candidate) => candidate === options.initiationSource,
    ) ?? 'unknown'
  );
}

function originOf(options: ExecutionOptions): OperationOrigin {
  const source = options.initiationSource;
  return source === 'hook' || source === 'automation'
    ? { kind: source, sourceId: options.pipelineId }
    : { kind: 'client', sourceId: LOCAL_PRINCIPAL };
}

function ownerOf(owner: string | undefined): OperationOwner {
  const context = owner === undefined ? null : parseWorkspaceContext(owner);
  return context?.kind === 'organization'
    ? { kind: 'organization', id: context.organizationId }
    : { kind: 'principal', id: LOCAL_PRINCIPAL };
}

/**
 * Every handle that runs an execution, a start's or a resume's, carries its
 * event subscribers and its core run record.
 */
export function followExecutionHandle(handle: ExecutionHandle): void {
  attachPipelineHandle(handle);
  peekDesktopCanopyRuntime()?.pipelineRuns.reattach(handle.id);
}

/**
 * Start a run core has admitted and authorized: `options.executionId` and
 * its resolved owner (`executionContext`) are required. Resolves with the
 * executor's live handle.
 */
export async function startPipelineThroughLocalWorker(
  pipeline: Pipeline,
  options: ExecutionOptions & {
    executionId: string;
    executionContext: string;
    secretBindings: readonly ExecutionSecretBinding[];
  },
): Promise<ExecutionHandle> {
  const { executionId, executionContext, secretBindings } = options;
  const grant = getDesktopExecutionSecrets().stage(
    { operation: 'worker.pipeline.execution.start', key: executionId },
    secretBindings,
  );
  // CAN-5086: only a start the `pipelines:execute` handler routed may go to the daemon.
  const route = claimDaemonPipelineRoute()
    ? await import('./daemon-pipeline-route')
    : null;
  const built = route
    ? await route.buildDaemonPipelineLaunch(pipeline, options)
    : null;
  if (route && built && !built.ok)
    route.noteDaemonPipelineIneligible(built.reason);
  const staged = stagePipelineLaunch(executionId, {
    pipeline,
    options,
    ...(built?.ok && { daemon: built.launch }),
  });
  let result: Awaited<
    ReturnType<
      ReturnType<typeof getDesktopCanopyRuntime>['pipelineRuns']['start']
    >
  >;
  let capture: ReturnType<typeof staged.take>;
  try {
    result = await getDesktopCanopyRuntime().pipelineRuns.start({
      params: {
        executionId,
        ...(secretBindings.length ? { secrets: [...secretBindings] } : {}),
        pipelineId: options.pipelineId,
        definitionSource: definitionSourceOf(options.pipelinePreferenceLocator),
        runScope:
          options.scope ??
          (options.worktreeId !== undefined ? 'worktree' : 'directory'),
        workspaceId: options.projectId ?? null,
        worktreeId: options.worktreeId ?? null,
        owner: executionContext,
        initiationSource: initiationSourceOf(options),
      },
      origin: originOf(options),
      owner: ownerOf(executionContext),
    });
  } finally {
    capture = staged.take();
    grant.revoke();
  }
  if (result.status === 'completed' && capture.handle) return capture.handle;
  if (capture.error instanceof Error) throw capture.error;
  throw new Error(
    result.status === 'completed'
      ? 'The workflow run could not start.'
      : (result.error?.message ?? 'The workflow run could not start.'),
  );
}

/**
 * Cancel an execution through core and the local worker, resolving with the
 * full cancelled state; the executor's own error is rethrown as it was.
 */
export async function cancelPipelineThroughLocalWorker(
  executionId: string,
): Promise<ExecutionState> {
  let result: Awaited<
    ReturnType<
      ReturnType<typeof getDesktopCanopyRuntime>['pipelineRuns']['cancel']
    >
  >;
  const mark = pipelineCancelMark(executionId);
  try {
    result = await getDesktopCanopyRuntime().pipelineRuns.cancel(
      executionId,
      LOCAL_PRINCIPAL,
    );
  } catch (error) {
    const failed = readPipelineCancelCapture(executionId, mark);
    throw failed.error instanceof Error ? failed.error : error;
  }
  // A completed cancel's state is the latest one, even when this call joined
  // a cancel that settled before its mark; only a failure must be this one's.
  const capture = readPipelineCancelCapture(
    executionId,
    result.status === 'completed' ? -1 : mark,
  );
  if (result.status === 'completed' && capture.state) return capture.state;
  if (capture.error instanceof Error) throw capture.error;
  throw new Error(
    result.status === 'completed'
      ? 'The workflow run could not be cancelled.'
      : (result.error?.message ?? 'The workflow run could not be cancelled.'),
  );
}

/**
 * Archive teardown's cancel through core's run records: stop the
 * execution's live processes within the worker's bounded wait. Rejects when
 * the run is still stopping; its cancel request and running state stay for
 * a later retry.
 */
export async function drainPipelineThroughLocalWorker(
  executionId: string,
): Promise<void> {
  const result = await getDesktopCanopyRuntime().pipelineRuns.cancel(
    executionId,
    LOCAL_PRINCIPAL,
    'drain',
  );
  if (
    result.status === 'completed' ||
    (result.status === 'failed' &&
      result.error?.code === 'worker.pipeline.executionNotFound')
  )
    return;
  throw new Error(
    result.error?.message ?? 'The workflow run could not be stopped.',
  );
}

/**
 * Run a recovery control (CAN-4141) through core and the local worker: core
 * records it under the execution's run, or a run of its own, then dispatches
 * it keyed by `requestId`. `launch` is the entry point's host side, which
 * acts on the dispatched command. Legacy callers keep their results: the
 * full state comes back, and the entry point's own error is rethrown.
 */
export async function controlPipelineThroughLocalWorker(
  control: PipelineControlRequest,
  launch: PipelineControlLaunch,
  origin: 'client' | 'automation',
  secretBindings: readonly ExecutionSecretBinding[],
): Promise<PipelineControlSettlement> {
  // A run the daemon executes takes no recovery control until it settles (D10).
  if (getDaemonPipelineExecutionHandle(control.params.executionId))
    throw new Error(DAEMON_PIPELINE_CONTROL_REFUSED_MESSAGE);
  const { executionId, requestId } = control.params;
  const stored = await readStoredPipelineExecution(executionId).catch(
    () => null,
  );
  let grant: ExecutionSecretGrantHandle | undefined;
  if (
    control.operation === 'worker.pipeline.execution.resume' ||
    control.operation === 'worker.pipeline.execution.retry' ||
    control.operation === 'worker.pipeline.matrixJob.retry'
  ) {
    // The app takes the run over: its own post-process runs the commit hooks
    // from here, so first claim what the daemon left unclaimed (CAN-6012 D3).
    const [
      { drainDaemonCommitHooksBeforeTakeover },
      { createElectronExecutionRuntime },
    ] = await Promise.all([
      import('./daemon-pipeline-route'),
      import('./execution-runtime'),
    ]);
    await drainDaemonCommitHooksBeforeTakeover(
      executionId,
      createElectronExecutionRuntime().executionsDir,
    );
    if (secretBindings.length) control.params.secrets = [...secretBindings];
    grant = getDesktopExecutionSecrets().stage(
      { operation: control.operation, key: requestId },
      secretBindings,
    );
  } else if (secretBindings.length)
    throw new Error('This control takes no secrets.');
  const staged = stagePipelineControl(requestId, launch);
  let result: Awaited<
    ReturnType<
      ReturnType<typeof getDesktopCanopyRuntime>['pipelineRuns']['control']
    >
  >;
  let capture: ReturnType<typeof staged.take>;
  try {
    result = await getDesktopCanopyRuntime().pipelineRuns.control({
      control,
      origin:
        origin === 'automation'
          ? { kind: 'automation', sourceId: executionId }
          : { kind: 'client', sourceId: LOCAL_PRINCIPAL },
      owner: ownerOf(stored?.execution_context),
    });
  } finally {
    capture = staged.take();
    grant?.revoke();
  }
  if (result.status === 'completed') {
    if (capture.settlement) return capture.settlement;
    // Core answered from its record of an earlier dispatch of this key.
    const state = await readStoredPipelineExecution(
      result.execution.executionId,
    );
    if (state) return { outcome: result.outcome, state };
  }
  if (capture.error instanceof Error) throw capture.error;
  throw new Error(
    result.status === 'completed'
      ? 'The workflow run could not be changed.'
      : (result.error?.message ?? 'The workflow run could not be changed.'),
  );
}

/**
 * The startup orphan sweep through core and the local worker (CAN-4141):
 * pause the executions among `executionIds` that a process left running when
 * it exited, in batches the worker accepts. Resolves with the sweep's
 * messages for executions it could not recover, which a later startup
 * retries.
 */
export async function sweepOrphanedPipelinesThroughLocalWorker(
  executionIds: readonly string[],
): Promise<string[]> {
  const errors: string[] = [];
  for (
    let start = 0;
    start < executionIds.length;
    start += WORKER_PIPELINE_SWEEP_MAX
  )
    errors.push(
      ...(await sweepBatch(
        executionIds.slice(start, start + WORKER_PIPELINE_SWEEP_MAX),
      )),
    );
  return errors;
}

async function sweepBatch(executionIds: readonly string[]): Promise<string[]> {
  const requestId = randomUUID();
  let result: Awaited<
    ReturnType<
      ReturnType<typeof getDesktopCanopyRuntime>['pipelineRuns']['sweep']
    >
  >;
  try {
    result = await getDesktopCanopyRuntime().pipelineRuns.sweep(
      executionIds,
      requestId,
    );
  } catch (error) {
    takePipelineRecoveryCapture(requestId);
    throw error;
  }
  const capture = takePipelineRecoveryCapture(requestId);
  if (result.status === 'completed') return capture.errors ?? [];
  throw new Error(
    result.error?.message ??
      'Interrupted workflow runs could not be recovered.',
  );
}

/**
 * The shutdown checkpoint through core and the local worker (CAN-4141):
 * close admission and pause every live execution so it resumes after the
 * restart. The checkpoint's own error is rethrown.
 */
export async function checkpointPipelinesThroughLocalWorker(): Promise<void> {
  const requestId = randomUUID();
  let result: Awaited<
    ReturnType<
      ReturnType<typeof getDesktopCanopyRuntime>['pipelineRuns']['checkpoint']
    >
  >;
  try {
    result = await getDesktopCanopyRuntime().pipelineRuns.checkpoint(requestId);
  } catch (error) {
    takePipelineRecoveryCapture(requestId);
    throw error;
  }
  const capture = takePipelineRecoveryCapture(requestId);
  if (result.status === 'completed') return;
  if (capture.error instanceof Error) throw capture.error;
  throw new Error(
    result.error?.message ?? 'Some workflow runs could not be paused.',
  );
}
