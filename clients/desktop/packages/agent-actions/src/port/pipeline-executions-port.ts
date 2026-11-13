import type { PipelineExecutionAction } from '../families/pipeline-executions/actions';
import type {
  AgentActionCall,
  AgentActionDispatchOutput,
} from '../surface/family';

type Action<T extends PipelineExecutionAction['type']> = Extract<
  PipelineExecutionAction,
  { type: T }
>;

/**
 * The backend the pipeline execution actions read and control runs on. The
 * family validates each payload first; the host decides which runs the
 * calling chat reaches (desktop: its task's runs and the global runs it
 * started; cloud: the cloud runs its task started) and answers any other
 * as `not_found`. Each member answers the action's whole response.
 */
export interface AgentPipelineExecutionsPort<H> {
  list(
    action: Action<
      'pipeline.execution_list' | 'pipeline.execution_list_for_worktree'
    >,
    call: AgentActionCall<H>,
  ): Promise<AgentActionDispatchOutput>;
  get(
    action: Action<'pipeline.execution_get'>,
    call: AgentActionCall<H>,
  ): Promise<AgentActionDispatchOutput>;
  cancel(
    action: Action<'pipeline.execution_cancel'>,
    call: AgentActionCall<H>,
  ): Promise<AgentActionDispatchOutput>;
  resume(
    action: Action<'pipeline.execution_resume'>,
    call: AgentActionCall<H>,
  ): Promise<AgentActionDispatchOutput>;
  retry(
    action: Action<'pipeline.execution_retry'>,
    call: AgentActionCall<H>,
  ): Promise<AgentActionDispatchOutput>;
  retryMatrixJob(
    action: Action<'pipeline.execution_retry_matrix_job'>,
    call: AgentActionCall<H>,
  ): Promise<AgentActionDispatchOutput>;
  cancelMatrixVariant(
    action: Action<'pipeline.execution_cancel_matrix_variant'>,
    call: AgentActionCall<H>,
  ): Promise<AgentActionDispatchOutput>;
  chain(
    action: Action<'pipeline.execution_chain'>,
    call: AgentActionCall<H>,
  ): Promise<AgentActionDispatchOutput>;
}
