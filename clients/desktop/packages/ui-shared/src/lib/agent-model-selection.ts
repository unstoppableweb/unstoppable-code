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

/**
 * Why a model preset row is disabled in a model picker: its base model is not
 * registered on the paired desktop. The shared picker and the Remote Control
 * picker show the same reason, so both read it from here.
 */
export const UNAVAILABLE_MODEL_PRESET_REASON =
  "This model preset is unavailable because its base model isn't registered on the desktop app.";
