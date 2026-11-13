import type { PlaneQualifiedName } from '../../names';

/**
 * Cloud pipeline runs (CAN-6085, plan CP-22): the operations a client needs
 * from the web core before it may offer "Run on: Cloud". Callers gate on
 * these operations being available in the web core's
 * `core.runtime.manifest.get`, never on runtime kind; a host whose manifest
 * does not report them (desktop alone, canopy-server) offers no cloud runs.
 *
 * The web core serves each of them behind its cloud pipelines rollout flag
 * (`apps/web/src/lib/web-core/cloud-pipeline-runs.ts`), from a map keyed by
 * this list. The start (CAN-6187) is the first; CP-21 (CAN-6214) adds the
 * reads, live events, cancel and recovery controls of a cloud run. An empty
 * group is never available.
 */
export const CORE_PIPELINE_CLOUD_RUN_OPERATIONS = [
  'core.pipeline.execution.start',
  'worker.pipeline.execution.get',
  'worker.pipeline.execution.list',
  'worker.pipeline.execution.events',
  'worker.pipeline.execution.cancel',
  'core.pipeline.execution.stepLog.read',
  'core.pipeline.execution.artifact.read',
  'worker.pipeline.execution.resume',
  'worker.pipeline.execution.retry',
  'worker.pipeline.matrixJob.retry',
  'worker.pipeline.matrixVariant.cancel',
] as const satisfies readonly PlaneQualifiedName[];

export type CorePipelineCloudRunOperation =
  (typeof CORE_PIPELINE_CLOUD_RUN_OPERATIONS)[number];

/**
 * The web core's cloud execution target (`cloud_sandbox_worker` in
 * `execution-targets.yaml`, ADR 31). A manual run carries it as
 * `scope.targetId` to run in the cloud (decision P6); without it the run
 * stays on this computer. A list scoped to it lists cloud runs.
 */
export const CLOUD_PIPELINE_RUN_TARGET_ID = 'cloud_sandbox_worker';
