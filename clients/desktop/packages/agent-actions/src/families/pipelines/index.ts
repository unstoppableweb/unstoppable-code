import {
  agentActionError,
  agentActionIdempotencyKey,
  agentActionResult,
  agentActionToolResult,
  portErrorResponse,
  runIdempotentWrite,
  type AgentWritePreparation,
} from '../../action-support';
import type {
  AgentPipelineRunRejectionReason,
  AgentPipelineRunResult,
  AgentPipelinesPort,
} from '../../port/pipelines-port';
import type { AgentActionReceiptStore } from '../../receipts';
import type { AgentActionErrorCode, AgentJson } from '../../response';
import type { AgentActionHostCapabilities } from '../../surface/capabilities';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionDispatchOutput,
  type AgentActionFamily,
} from '../../surface/family';
import type { AgentActionToolResult } from '../../tools/definition';
import { PIPELINES_ACTION_TYPES, pipelineRunActionSchema } from './actions';
import {
  cloudPipelinesDispatchJsonSchema,
  pipelineRunsCloudOnly,
  pipelinesActionCatalogFor,
  pipelinesDispatchJsonSchema,
} from './catalog';

export {
  APP_ADVISOR_PIPELINE_RUN_TARGET_MESSAGE,
  appAdvisorPipelineRunActionSchema,
  GLOBAL_PIPELINE_RUN_MODE_MESSAGE,
  GLOBAL_PIPELINE_RUN_TARGET_MESSAGE,
  GLOBAL_PIPELINE_RUN_WATCHERS_MESSAGE,
  PIPELINE_RUN_MAX_WATCHERS,
  PIPELINE_RUN_MODES,
  PIPELINES_ACTION_TYPES,
  pipelineRunActionSchema,
  pipelineRunWatcherSchema,
  type AppAdvisorPipelineRunAction,
  type PipelineRunAction,
  type PipelineRunLocation,
  type PipelineRunWatcher,
} from './actions';
export {
  appAdvisorPipelinesActionCatalog,
  pipelinesActionCatalog,
  pipelinesActionCatalogFor,
  pipelinesDispatchJsonSchema,
} from './catalog';

const REJECTION_CODES: Readonly<
  Record<AgentPipelineRunRejectionReason, AgentActionErrorCode>
> = {
  not_found: 'not_found',
  invalid_target: 'invalid_target',
  unsupported_scope: 'invalid_target',
  owner_unavailable: 'authorization_conflict',
  unsupported_watchers: 'invalid_payload',
  execution_failed: 'execution_failed',
};

function runResultJson(
  result: Extract<AgentPipelineRunResult, { status: 'started' }>,
): AgentJson {
  const { execution } = result;
  return {
    status: 'started',
    execution: {
      executionId: execution.executionId,
      pipelineId: execution.pipelineId,
      pipelineName: execution.pipelineName,
      executionStatus: execution.executionStatus,
      executionScope: execution.executionScope,
      owner: execution.owner ?? null,
      projectId: execution.projectId ?? null,
      worktreeId: execution.worktreeId ?? null,
      eventName: execution.eventName,
      startedAt: execution.startedAt,
      ...(execution.location !== undefined
        ? { location: execution.location }
        : {}),
    },
    ...(result.agentArtifacts !== undefined
      ? { agentArtifacts: result.agentArtifacts }
      : {}),
    ...(result.inlineWatcherSetup !== undefined
      ? { inlineWatcherSetup: result.inlineWatcherSetup }
      : {}),
  };
}

/**
 * A start that did not run: the attempt is abandoned instead of recorded, so
 * a rejection can be retried and an uncertain key stays uncertain.
 */
class PipelineRunRejected extends Error {
  constructor(readonly response: AgentActionToolResult) {
    super('pipeline.run rejected');
    this.name = 'PipelineRunRejected';
  }
}

const UNCERTAIN_RUN_MESSAGE =
  'An earlier attempt of this call may have started the run. Check the Runs list, and use a new call to start another.';

function pipelineRunResponse(
  call: AgentActionCall<unknown>,
  result: AgentPipelineRunResult,
): AgentActionToolResult {
  if (result.status === 'rejected') {
    return agentActionToolResult(
      agentActionError(call, REJECTION_CODES[result.reason], result.message, {
        result: { status: 'rejected', reason: result.reason },
      }),
    );
  }
  return agentActionToolResult(
    agentActionResult(call, 'pipeline.run', runResultJson(result)),
  );
}

/**
 * `pipeline.run`: start one pipeline run where the calling chat is, or with
 * `scope: 'global'` in a scratch folder with no project. The payload never
 * names a project, task, or owner; the host takes them from the call. A
 * global run accepts only a dispatch with no task inputs or watchers, which
 * the schema refuses before the port runs. Repeated delivery of one tool
 * call returns its recorded run; a rejection is not recorded, and a call
 * whose earlier attempt may have started a run refuses instead of starting
 * another. A new tool call starts a new run. Runs
 * are not counted against the agent action limits. A host that starts runs
 * only in the cloud (`pipelineRunLocations`) advertises the cloud row.
 */
export function createPipelinesActionFamily<H>(options: {
  port: AgentPipelinesPort<H>;
  receipts: AgentActionReceiptStore<H>;
  capabilities?: Pick<AgentActionHostCapabilities, 'pipelineRunLocations'>;
}): AgentActionFamily<H> {
  const capabilities = options.capabilities ?? {};
  return defineAgentActionFamily({
    id: 'pipelines',
    types: PIPELINES_ACTION_TYPES,
    actionSchema: pipelineRunActionSchema,
    supportedTypes: () => PIPELINES_ACTION_TYPES,
    catalog: () => pipelinesActionCatalogFor(capabilities),
    dispatchJsonSchema: pipelineRunsCloudOnly(capabilities)
      ? cloudPipelinesDispatchJsonSchema
      : pipelinesDispatchJsonSchema,
    dispatch: async (action, call): Promise<AgentActionDispatchOutput> => {
      try {
        return await runIdempotentWrite({
          receipts: options.receipts,
          limits: null,
          kind: 'pipeline.run',
          call,
          idempotencyKey: agentActionIdempotencyKey(action.type, call, action),
          payload: action,
          prepare: (): Promise<AgentWritePreparation> =>
            Promise.resolve({
              ok: true,
              parentDepth: 0,
              write: async (attempt): Promise<AgentActionToolResult> => {
                // An earlier attempt may have started a run; never start
                // another under the same call.
                if (attempt.uncertain)
                  throw new PipelineRunRejected(
                    agentActionToolResult(
                      agentActionError(
                        call,
                        'execution_failed',
                        UNCERTAIN_RUN_MESSAGE,
                      ),
                    ),
                  );
                const result = await options.port.run(action, call);
                const response = pipelineRunResponse(call, result);
                if (result.status === 'rejected')
                  throw new PipelineRunRejected(response);
                return response;
              },
            }),
        });
      } catch (error) {
        if (error instanceof PipelineRunRejected) return error.response;
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}
