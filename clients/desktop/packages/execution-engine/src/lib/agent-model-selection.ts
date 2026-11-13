import {
  AGENT_MODEL_PREFIX,
  isAgentDefaultBaseModel,
} from '@canopy/protocol/agents';
import { isSyntacticallyValidModelId } from './model-id';

export type AgentBaseModelChoice =
  | {
      kind: 'resolved';
      model: string;
      source: 'explicit' | 'agent-default' | 'destination-default';
    }
  | { kind: 'needs-destination-default' }
  | { kind: 'invalid'; reason: 'invalid_model' | 'nested_agent' };

/** One precedence rule for execution and catalog projection. Invalid choices never fall back. */
export function resolveAgentBaseModel(
  input: {
    explicitModel?: string;
    agentDefaultModel: string;
    destinationDefaultModel?: string;
  },
  canonicalize: (model: string) => string,
): AgentBaseModelChoice {
  const source =
    input.explicitModel !== undefined
      ? 'explicit'
      : !isAgentDefaultBaseModel(input.agentDefaultModel)
        ? 'agent-default'
        : 'destination-default';
  const selected =
    source === 'explicit'
      ? input.explicitModel
      : source === 'agent-default'
        ? input.agentDefaultModel
        : input.destinationDefaultModel;
  if (selected === undefined) return { kind: 'needs-destination-default' };
  let model: string;
  try {
    model = canonicalize(selected);
  } catch {
    return { kind: 'invalid', reason: 'invalid_model' };
  }
  if (model.startsWith(AGENT_MODEL_PREFIX))
    return { kind: 'invalid', reason: 'nested_agent' };
  if (
    !isSyntacticallyValidModelId(model) ||
    isAgentDefaultBaseModel(model) ||
    model === 'auto'
  ) {
    return { kind: 'invalid', reason: 'invalid_model' };
  }
  return { kind: 'resolved', model, source };
}

export type AgentModelSelectionErrorCode =
  | 'model_unavailable'
  | 'destination_default_unavailable'
  | 'harness_unavailable'
  | 'plugins_incompatible'
  | 'policy_blocked'
  | 'agent_unavailable';

/** Only these safe admission messages may cross generic host error boundaries. */
export class AgentModelSelectionError extends Error {
  constructor(
    readonly code: AgentModelSelectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentModelSelectionError';
  }
}
