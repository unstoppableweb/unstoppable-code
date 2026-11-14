/**
 * The capability package a run bound to a send step, for the chat the step
 * starts: a shared workflow's packaged skills and plugins, bound to its send
 * step when it was shared (a converted chat automation's local `chat_plugins`
 * selections and the commands its message invokes).
 *
 * The executor hands each agent step its part of the run's package. A host
 * step's part names files on this machine, so it never crosses the worker
 * boundary; the send reads it here from the run's own verified snapshot, the
 * same snapshot and bindings the executor uses.
 */
import path from 'node:path';
import type { PipelineHostActionCaller } from '@canopy/execution-engine/node/pipelines/executor/types';
import type { PipelinePackageCapabilityOverlay } from '@canopy/execution-engine/types/pipeline';
import { logMainProcessWarn } from '../lib/main-process-logging';

export type RunSendPackageCaller = Pick<
  PipelineHostActionCaller,
  'executionId' | 'jobId' | 'stepId' | 'childId'
>;

/**
 * The send step's part of its run's package, or `undefined` when the run has
 * no package or binds nothing to the step. Throws when the run's package is
 * no longer intact, as a run's agent steps fail on it.
 */
export async function runSendPackageOverlay(
  caller: RunSendPackageCaller,
): Promise<PipelinePackageCapabilityOverlay | undefined> {
  // A composite's child step has no binding of its own.
  if (caller.childId !== undefined) return undefined;
  const [
    { loadExecutionState },
    {
      filterPipelinePackageOverlayForStep,
      loadPipelinePackageExecutionOverlay,
    },
  ] = await Promise.all([
    import('@canopy/execution-engine/node/pipelines/executor/execution-state'),
    import('@canopy/execution-engine/node/pipelines/package-runtime'),
  ]);
  const { getDataDir } = await import('../lib/paths');
  const state = await loadExecutionState(
    caller.executionId,
    path.join(getDataDir(), 'pipeline-executions'),
  ).catch(() => null);
  if (state === null) {
    logMainProcessWarn(
      'Sent without a run package; the run could not be read',
      {
        operation: 'run-send-package-overlay',
      },
    );
    return undefined;
  }
  const snapshot = state.pipeline_package_snapshot;
  if (snapshot === undefined) return undefined;
  const overlay = await loadPipelinePackageExecutionOverlay(snapshot);
  if (overlay === undefined) return undefined;
  // A matrix variant binds under its job's id in the YAML.
  const jobId =
    state.job_definitions[caller.jobId]?.logical_job_id ?? caller.jobId;
  return filterPipelinePackageOverlayForStep(
    overlay,
    snapshot.bindings,
    jobId,
    caller.stepId,
  );
}
