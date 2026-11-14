import { AGENT_DELEGATION_INPUT_LIMITS } from '@canopy/protocol/delegation';
import type {
  DelegationAgentChoice,
  DelegationModelChoice,
  DelegationModelDiscovery,
} from '@canopy/protocol/delegation/discovery';
import {
  formatAgentRouteModelId,
  parseAgentRouteModelId,
} from '@canopy/protocol/agents';

const MAX_MODELS = 96;
const MAX_AGENTS = 96;
const MAX_AGENT_MODEL_CHECKS = 512;

/** No vendor unions, native handles, credentials or billing fallbacks cross this seam. */
export async function discoverDelegationModels(options: {
  modelIds: readonly string[];
  agents?: readonly { agentId: string; label: string }[];
  preferredModelId?: string;
  inspect: (id: string) => Promise<DelegationModelChoice>;
  /** Agent-specific admission only; model availability is inspected once above. */
  canRunAgent?: (
    agentId: string,
    model: DelegationModelChoice,
  ) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<DelegationModelDiscovery> {
  const checkCancelled = (): void => {
    if (options.signal?.aborted) throw new Error('Model discovery cancelled');
  };
  checkCancelled();
  const ids = Array.from(new Set(options.modelIds));
  const boundedIds = ids.slice(0, MAX_MODELS);
  const preferredRoute = parseAgentRouteModelId(options.preferredModelId ?? '');
  const preferredBase = preferredRoute?.baseModel ?? options.preferredModelId;
  if (
    preferredBase &&
    ids.includes(preferredBase) &&
    !boundedIds.includes(preferredBase)
  ) {
    boundedIds[boundedIds.length - 1] = preferredBase;
  }
  const models: DelegationModelChoice[] = [];
  for (const id of boundedIds) {
    checkCancelled();
    const model = await options.inspect(id);
    // Explicit allowlist prevents accidental projection of host routing secrets.
    models.push({
      modelId: id,
      label: model.label,
      harnessId: model.harnessId,
      runtimeKind: model.runtimeKind,
      supportedThinkingLevels: [...model.supportedThinkingLevels],
      capabilities: [...model.capabilities],
      availability: model.availability,
      authState: model.authState,
      ...(model.disabledReason ? { disabledReason: model.disabledReason } : {}),
    });
  }
  const uniqueAgents = Array.from(
    new Map(
      (options.agents ?? []).map((agent) => [agent.agentId, agent]),
    ).values(),
  );
  // Spend the bounded Agent budget on the parent's selected route first.
  const preferredAgent = uniqueAgents.find(
    (agent) => agent.agentId === preferredRoute?.agentId,
  );
  const orderedAgents = preferredAgent
    ? [
        preferredAgent,
        ...uniqueAgents.filter((agent) => agent !== preferredAgent),
      ]
    : uniqueAgents;
  const orderedModels = [...models].sort(
    (a, b) =>
      Number(b.modelId === preferredBase) - Number(a.modelId === preferredBase),
  );
  const agents: DelegationAgentChoice[] = [];
  let checks = 0;
  let truncated =
    ids.length > models.length || uniqueAgents.length > MAX_AGENTS;
  for (const agent of orderedAgents.slice(0, MAX_AGENTS)) {
    if (checks >= MAX_AGENT_MODEL_CHECKS) {
      truncated = true;
      break;
    }
    const runnableModels: string[] = [];
    for (const model of orderedModels) {
      checkCancelled();
      if (
        model.availability === 'unavailable' ||
        formatAgentRouteModelId(agent.agentId, model.modelId).length >
          AGENT_DELEGATION_INPUT_LIMITS.idCharacters
      )
        continue;
      if (checks >= MAX_AGENT_MODEL_CHECKS) {
        truncated = true;
        break;
      }
      checks++;
      // Fail closed when a host has no Agent admission port.
      if (await options.canRunAgent?.(agent.agentId, model))
        runnableModels.push(model.modelId);
    }
    agents.push({
      agentId: agent.agentId,
      label: agent.label,
      models: runnableModels,
    });
  }
  const preferredAgentChoice = agents.find(
    (agent) => agent.agentId === preferredRoute?.agentId,
  );
  const preferredAgentAvailable =
    preferredRoute &&
    preferredAgentChoice?.models.includes(preferredRoute.baseModel) &&
    models.some(
      (model) =>
        model.modelId === preferredRoute.baseModel &&
        model.availability === 'available',
    );
  const recommendedModelId =
    preferredAgentAvailable && preferredRoute
      ? formatAgentRouteModelId(
          preferredRoute.agentId,
          preferredRoute.baseModel,
        )
      : (
          models.find(
            (model) =>
              model.modelId === options.preferredModelId &&
              model.availability === 'available',
          ) ?? models.find((model) => model.availability === 'available')
        )?.modelId;
  return {
    models,
    ...(options.agents ? { agents } : {}),
    ...(recommendedModelId ? { recommendedModelId } : {}),
    truncated,
  };
}
