import { isSelectableAgentOverrideModel } from '@canopy/execution-engine/model-catalog';
import {
  AgentModelSelectionError,
  resolveAgentBaseModel,
} from '@canopy/execution-engine/lib/agent-model-selection';
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
  executionHarness?: ModelHarness;
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

  // Keep the requested route for identity and persistence; only execution uses its concrete base.
  const route = parseAgentRouteModelId(options.model);
  const agentId = route?.agentId ?? options.model;
  const agent = await getAgentModel(agentId, options.projectId);
  if (!agent) {
    throw new AgentModelSelectionError(
      'agent_unavailable',
      `Agent model "${agentId}" is not defined. Open Agents to create or import it, or choose another model.`,
    );
  }
  const inheritsDefault = isAgentDefaultBaseModel(agent.baseModel);
  if (inheritsDefault && !route && !options.inheritDefaultFrom) {
    throw new Error(
      `Agent "${agent.name}" uses the default model, but this chat has no model yet. Choose the Agent again or choose another model.`,
    );
  }
  let choice = resolveAgentBaseModel(
    { explicitModel: route?.baseModel, agentDefaultModel: agent.baseModel },
    resolveModelAlias,
  );
  if (choice.kind === 'needs-destination-default') {
    choice = resolveAgentBaseModel(
      {
        agentDefaultModel: agent.baseModel,
        destinationDefaultModel: await resolveAgentDestinationDefaultModel(
          options.inheritDefaultFrom?.projectId,
        ),
      },
      resolveModelAlias,
    );
  }
  if (
    choice.kind !== 'resolved' ||
    !(route
      ? isSelectableAgentOverrideModel(choice.model)
      : isBaseModelSelectableForAgent(choice.model))
  ) {
    throw new AgentModelSelectionError(
      'model_unavailable',
      `Agent "${agent.name}" cannot run on model "${route?.baseModel ?? agent.baseModel}" because that model is not selectable. Choose another model.`,
    );
  }
  const baseModel = choice.model;
  const executionHarness =
    options.executionHarness ?? getExecutionHarnessForModel(baseModel);
  if (!executionHarness) {
    throw new AgentModelSelectionError(
      'harness_unavailable',
      `The execution harness for model "${baseModel}" is not available here.`,
    );
  }

  if (route) {
    const { agentModelPluginIncompatibility } =
      await import('../plugins/agent-model-compatibility');
    const reason = await agentModelPluginIncompatibility(
      agent.pluginSelections,
      executionHarness,
      options.projectId,
    );
    if (reason)
      throw new AgentModelSelectionError(
        'plugins_incompatible',
        `Agent "${agent.name}" cannot run on model "${baseModel}": ${reason} Choose another model or edit the Agent.`,
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
    pluginSelections: agent.pluginSelections
      ? mergePluginSelections(options.pluginSelections, agent.pluginSelections)
      : options.pluginSelections,
  };
}
