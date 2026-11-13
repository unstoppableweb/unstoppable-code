import { portErrorResponse } from '../../action-support';
import type { AgentPipelineExecutionsPort } from '../../port/pipeline-executions-port';
import type { AgentActionHostCapabilities } from '../../surface/capabilities';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionDispatchOutput,
  type AgentActionFamily,
} from '../../surface/family';
import {
  PIPELINE_EXECUTIONS_ACTION_TYPES,
  pipelineExecutionActionSchema,
  type PipelineExecutionAction,
} from './actions';
import {
  pipelineExecutionsActionCatalogFor,
  pipelineExecutionsDispatchJsonSchema,
} from './catalog';

export {
  CLOUD_PIPELINE_EXECUTION_TYPES,
  PIPELINE_EXECUTIONS_ACTION_TYPES,
  pipelineExecutionActionSchema,
  type PipelineExecutionAction,
  type PipelineExecutionsActionType,
} from './actions';
export {
  CLOUD_RUN_CHAIN_UNSUPPORTED,
  CLOUD_RUN_MATRIX_RETRY_UNSUPPORTED,
  CLOUD_RUN_RETRY_UNSUPPORTED,
  CLOUD_RUN_VARIANT_CANCEL_UNSUPPORTED,
  cancelCloudRun,
  cloudRunPauseKey,
  getCloudRun,
  listCloudRuns,
  CLOUD_RUN_WATCH_TRACKED_MAX,
  listCloudRunsStartedSince,
  lookAtLaterCloudRuns,
  lookAtWatchedCloudRun,
  lookAtWatchedCloudRuns,
  readCloudRun,
  resumeCloudRun,
  type CloudRunAccess,
  type CloudRunTerminalStatus,
  type CloudRunWatchFilter,
  type CloudRunWatchLook,
} from './cloud-runs';
export {
  PIPELINE_EXECUTION_ACTION_CATALOG,
  PIPELINE_EXECUTION_CHAIN_ACTION_CATALOG,
  pipelineExecutionsDispatchJsonSchema,
} from './catalog';

function route<H>(
  port: AgentPipelineExecutionsPort<H>,
  action: PipelineExecutionAction,
  call: AgentActionCall<H>,
): Promise<AgentActionDispatchOutput> {
  switch (action.type) {
    case 'pipeline.execution_list':
    case 'pipeline.execution_list_for_worktree':
      return port.list(action, call);
    case 'pipeline.execution_get':
      return port.get(action, call);
    case 'pipeline.execution_cancel':
      return port.cancel(action, call);
    case 'pipeline.execution_resume':
      return port.resume(action, call);
    case 'pipeline.execution_retry':
      return port.retry(action, call);
    case 'pipeline.execution_retry_matrix_job':
      return port.retryMatrixJob(action, call);
    case 'pipeline.execution_cancel_matrix_variant':
      return port.cancelMatrixVariant(action, call);
    case 'pipeline.execution_chain':
      return port.chain(action, call);
  }
}

/**
 * The pipeline execution actions (CAN-6339): list, read and control the
 * runs the calling chat reaches. Desktop binds them to its executions; a
 * host that starts runs only in the cloud (`pipelineRunLocations`)
 * advertises the cloud rows and binds them to its cloud runs. Chat
 * surfaces hide Orchestrator's `projectId` and `worktreeId` fields.
 */
export function createPipelineExecutionsActionFamily<H>(options: {
  port: AgentPipelineExecutionsPort<H>;
  capabilities?: Pick<AgentActionHostCapabilities, 'pipelineRunLocations'>;
}): AgentActionFamily<H> {
  const capabilities = options.capabilities ?? {};
  return defineAgentActionFamily({
    id: 'pipeline-executions',
    types: PIPELINE_EXECUTIONS_ACTION_TYPES,
    actionSchema: pipelineExecutionActionSchema,
    supportedTypes: () => PIPELINE_EXECUTIONS_ACTION_TYPES,
    catalog: () => pipelineExecutionsActionCatalogFor(capabilities),
    hiddenFields: ['projectId', 'worktreeId'],
    dispatchJsonSchema: pipelineExecutionsDispatchJsonSchema,
    dispatch: async (action, call): Promise<AgentActionDispatchOutput> => {
      try {
        return await route(options.port, action, call);
      } catch (error) {
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}
