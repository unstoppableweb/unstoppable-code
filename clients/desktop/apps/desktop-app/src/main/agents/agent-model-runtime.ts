import {
  getExecutionHarnessForModel,
  isAgentModel,
  isBaseModelSelectableForAgent,
  requireProviderForModel,
  resolveModelAlias,
  type AgentProviderType,
  type ChatModel,
  type ChatTabPluginSelections,
  type ModelHarness,
} from '@canopy/desktop-shared/types';
import {
  isAgentDefaultBaseModel,
  parseAgentRouteModelId,
  type AgentModelDefinition,
} from '@canopy/execution-engine/types/agent-models';
import { mergePluginSelections } from '../lib/plugin-selection-utils';
import { resolveAgentDestinationDefaultModel } from './agent-default-model';
import { getAgentModel } from './agent-model-store';

export interface ResolvedAgentModelRuntime {
  selectedModel: ChatModel;
  runtimeModel: ChatModel;
  providerType: AgentProviderType;
  executionHarness: ModelHarness;
  agent?: AgentModelDefinition;
  systemPromptAppend: string | undefined;
  pluginSelections: ChatTabPluginSelections | undefined;
}

function appendAgentInstructions(
  existing: string | undefined,
  instructions: string,
): string | undefined {
  const trimmed = instructions.trim();
  if (!trimmed) {
    return existing;
  }
  const agentBlock = `You are now a user defined agent with these additional instructions: ${trimmed}`;
  return existing ? `${existing}\n\n${agentBlock}` : agentBlock;
}

export async function resolveAgentModelRuntime(options: {
  model: ChatModel;
  projectId?: string;
  systemPromptAppend?: string;
  pluginSelections?: ChatTabPluginSelections;
  providerType?: AgentProviderType;
  /**
   * Opt-in for callers that retain their own route (delegation, discovery):
   * the workspace whose default a bare inheriting Agent runs on. Chats pin a
   * route id instead, so their turns never re-resolve the default.
   */
  inheritDefaultFrom?: { projectId?: string };
}): Promise<ResolvedAgentModelRuntime> {
  if (!isAgentModel(options.model)) {
    const providerType =
      options.providerType ?? requireProviderForModel(options.model);
    const executionHarness = getExecutionHarnessForModel(options.model);
    if (!executionHarness) {
      throw new Error(
        `No execution harness is available for model "${String(options.model)}".`,
      );
    }
    return {
      selectedModel: options.model,
      runtimeModel: options.model,
      providerType,
      executionHarness,
      systemPromptAppend: options.systemPromptAppend,
      pluginSelections: options.pluginSelections,
    };
  }

  // A chat route id carries the base its chat resolved for an inheriting
  // Agent; later Settings changes must not reroute that chat.
  const route = parseAgentRouteModelId(options.model);
  const agentId = route?.agentId ?? options.model;
  const agent = await getAgentModel(agentId, options.projectId);
  if (!agent) {
    throw new Error(
      `Agent model "${agentId}" is not defined. Open Agents to create or import it, or choose another model.`,
    );
  }
  const inheritsDefault = isAgentDefaultBaseModel(agent.baseModel);
  if (inheritsDefault && !route && !options.inheritDefaultFrom) {
    throw new Error(
      `Agent "${agent.name}" uses the default model, but this chat has no model yet. Choose the Agent again or choose another model.`,
    );
  }
  // A route only supplies the base of an inheriting Agent; a pinned Agent keeps
  // its own base whatever route id names it.
  const selectedBaseModel = !inheritsDefault
    ? agent.baseModel
    : (route?.baseModel ??
      (await resolveAgentDestinationDefaultModel(
        options.inheritDefaultFrom?.projectId,
      )));
  const baseModel = resolveModelAlias(selectedBaseModel);
  if (isAgentModel(baseModel)) {
    throw new Error(
      `Agent "${agent.name}" uses the default model, but the default model is an Agent. Choose a provider model as the default in Settings, or choose a base model for this Agent.`,
    );
  }
  if (!isBaseModelSelectableForAgent(baseModel)) {
    throw new Error(
      `Agent "${agent.name}" uses unavailable base model "${String(baseModel)}". Edit the Agent or choose another model.`,
    );
  }

  const executionHarness = getExecutionHarnessForModel(baseModel);
  if (!executionHarness) {
    throw new Error(
      `No execution harness is available for Agent base model "${String(baseModel)}".`,
    );
  }

  return {
    selectedModel: options.model,
    runtimeModel: baseModel,
    providerType: requireProviderForModel(baseModel),
    executionHarness,
    agent,
    systemPromptAppend: appendAgentInstructions(
      options.systemPromptAppend,
      agent.instructions,
    ),
    pluginSelections: mergePluginSelections(
      options.pluginSelections,
      agent.pluginSelections,
    ),
  };
}
