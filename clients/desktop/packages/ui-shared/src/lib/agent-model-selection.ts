import {
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
