import {
  formatAgentRouteModelId,
  AGENT_MODEL_PREFIX,
  isValidSharedAgentModelId,
  parseAgentRouteModelId,
} from '@canopy/protocol/agents';

export function selectedAgentId(
  selection: string | undefined,
): string | undefined {
  if (!selection) return undefined;
  return (
    parseAgentRouteModelId(selection)?.agentId ??
    (isValidSharedAgentModelId(selection) ? selection : undefined)
  );
}

export function isConcreteSelectedModel(
  model: string | undefined,
): model is string {
  return (
    model !== undefined &&
    model.trim().length > 0 &&
    model !== 'auto' &&
    model !== 'default' &&
    !model.startsWith(AGENT_MODEL_PREFIX) &&
    !model.startsWith('$')
  );
}

/** A stored route is explicit, including a destination-pinned default. */
export function changeSelectedAgent(
  selection: string | undefined,
  agentId: string | undefined,
  effectiveModel: string | undefined,
): string | undefined {
  const previousAgent = selectedAgentId(selection);
  if (agentId === previousAgent) return selection;
  const override = selection && parseAgentRouteModelId(selection)?.baseModel;
  if (!agentId)
    return changeSelectedModel(undefined, override || effectiveModel);
  if (!isValidSharedAgentModelId(agentId))
    throw new Error('Invalid agent selection');
  const concrete = override || (!previousAgent ? selection : undefined);
  return concrete ? changeSelectedModel(agentId, concrete) : agentId;
}

export function changeSelectedModel(
  selection: string | undefined,
  model: string | undefined,
): string | undefined {
  const agentId = selectedAgentId(selection);
  if (model === undefined) return agentId;
  if (!isConcreteSelectedModel(model)) {
    throw new Error('Choose a concrete model');
  }
  return agentId ? formatAgentRouteModelId(agentId, model) : model;
}
