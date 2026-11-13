import {
  createCorePipelineDefinitionHandlers,
  pipelineDefinitionError,
  type CorePipelineDefinitionHandlers,
  type CorePipelineDefinitionHost,
  type PipelineDefinitionService,
} from '@canopy/core-runtime/node/pipeline';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { createPipelineDefinitionReplayStore } from '../pipelines/pipeline-definition-replay-store';
import { consumeAgentPlace, type AgentPlace } from './agent-place';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

let desktopService: Promise<PipelineDefinitionService> | undefined;

// Loaded on the first call: the sources import the pipeline, cloud and
// sidebar modules, which import back into the runtime.
export const desktopPipelineDefinitionHost: CorePipelineDefinitionHost = {
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  replays: createPipelineDefinitionReplayStore(),
  load: () => {
    desktopService ??=
      import('../pipelines/core-pipeline-definition-sources').then((module) =>
        module.createDesktopPipelineDefinitionService(),
      );
    return desktopService;
  },
};

/**
 * Which of `definitionIds` an agent calling from `place` may not see
 * (CAN-4551); without a place, every owned workflow.
 */
export type AgentHiddenPipelines = (
  definitionIds: readonly string[],
  place: AgentPlace | undefined,
) => Promise<ReadonlySet<string>>;

const desktopAgentHiddenPipelines: AgentHiddenPipelines = async (
  definitionIds,
  place,
) => {
  const { agentHiddenOwnedPipelineIds } =
    await import('../automations/owned-pipeline');
  // Without the calling chat's place, no project grants access.
  return agentHiddenOwnedPipelineIds(definitionIds, {
    projectId: place?.workspaceId ?? '',
    worktreeId: place?.worktreeId ?? '',
  });
};

/** Agents call core as `mcp` principals; the window and Portal never do. */
const isAgentCaller = (caller: CanopyCallerDescriptor): boolean =>
  caller.interfaceKind === 'mcp';

/**
 * Which ids an agent caller may not see, checked against the place main set
 * for the dispatch (CAN-6032). The call's `scope` names the sources to read,
 * never the agent's place; an agent read without a place sees no owned
 * workflow.
 */
async function hiddenForCaller(
  hiddenFromAgents: AgentHiddenPipelines,
  caller: CanopyCallerDescriptor,
  definitionIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (!isAgentCaller(caller)) return new Set();
  return hiddenFromAgents(definitionIds, consumeAgentPlace(caller));
}

/**
 * `core.pipeline.definition.*` handlers over the desktop's sources. Pipelines
 * an Orchestrator automation owns stay hidden from agent callers as missing,
 * exactly as from the agent tools before (CAN-4551, CAN-5991); the window
 * still reads them.
 */
export function createCorePipelineDefinitionAdapter(
  host: CorePipelineDefinitionHost = desktopPipelineDefinitionHost,
  hiddenFromAgents: AgentHiddenPipelines = desktopAgentHiddenPipelines,
): CorePipelineDefinitionHandlers {
  const handlers = createCorePipelineDefinitionHandlers(host);
  const list = handlers.queries['core.pipeline.definition.list'];
  const get = handlers.queries['core.pipeline.definition.get'];
  return {
    ...handlers,
    queries: {
      ...handlers.queries,
      'core.pipeline.definition.get': async (params, context) => {
        if (
          (
            await hiddenForCaller(hiddenFromAgents, context.caller, [
              params.definitionId,
            ])
          ).has(params.definitionId)
        )
          throw pipelineDefinitionError(
            'core.pipeline.definitionNotFound',
            `Workflow not found: ${params.definitionId}`,
          );
        return get(params, context);
      },
      'core.pipeline.definition.list': async (params, context) => {
        const result = await list(params, context);
        const hidden = await hiddenForCaller(
          hiddenFromAgents,
          context.caller,
          result.items.map((item) => item.definitionId),
        );
        return hidden.size === 0
          ? result
          : {
              ...result,
              items: result.items.filter(
                (item) => !hidden.has(item.definitionId),
              ),
            };
      },
    },
  };
}
