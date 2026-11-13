import type { PipelineRunAction } from '../families/pipelines/actions';
import type { AgentJson } from '../response';
import type { AgentActionCall } from '../surface/family';

/**
 * Why a host refused to start a pipeline run:
 *
 * - `not_found`: no pipeline the caller may run has this id. Owned
 *   definitions outside the caller's reach are reported the same way.
 * - `invalid_target`: the run can't start where it was asked to, such as a
 *   plan or task path outside the caller's task, or a missing run mode.
 * - `unsupported_scope`: the pipeline does not declare the requested scope.
 * - `owner_unavailable`: the run's owner can't be confirmed or the account
 *   is no longer a member of it.
 * - `unsupported_watchers`: inline watchers can't be armed for this run.
 * - `execution_failed`: the executor refused or failed to start the run.
 */
export const PIPELINE_RUN_REJECTION_REASONS = [
  'not_found',
  'invalid_target',
  'unsupported_scope',
  'owner_unavailable',
  'unsupported_watchers',
  'execution_failed',
] as const;

export type AgentPipelineRunRejectionReason =
  (typeof PIPELINE_RUN_REJECTION_REASONS)[number];

/** A started run as a caller may see it; never a host path. */
export interface AgentPipelineRunExecution {
  executionId: string;
  pipelineId: string;
  pipelineName: string;
  /** Execution status right after the start. */
  executionStatus: string;
  executionScope: 'global' | 'directory' | 'worktree';
  /** Serialized owner the run is filed under (`personal` / `org:<uuid>`). */
  owner?: string;
  projectId?: string;
  worktreeId?: string;
  eventName: string;
  startedAt: string;
  /**
   * `cloud` for a run started in the cloud (CAN-6187): `executionId` is then
   * the cloud run's operation id and `executionStatus` its admission.
   */
  location?: 'cloud';
}

export type AgentPipelineRunResult =
  | {
      status: 'started';
      execution: AgentPipelineRunExecution;
      /** Host artifact receipts for the run, when it has a task to show. */
      agentArtifacts?: AgentJson;
      /** Outcome of arming the requested inline watchers. */
      inlineWatcherSetup?: AgentJson;
    }
  | {
      status: 'rejected';
      reason: AgentPipelineRunRejectionReason;
      message: string;
    };

/**
 * The backend `pipeline.run` starts runs on. The family validates the
 * payload, including the global-run restrictions, before calling it; the
 * host resolves the caller's task and owner from trusted context, never
 * from the payload, and starts exactly one run per call.
 */
export interface AgentPipelinesPort<H> {
  run(
    request: PipelineRunAction,
    call: AgentActionCall<H>,
  ): Promise<AgentPipelineRunResult>;
}
