import { AgentModelSelectionError } from '@canopy/execution-engine/lib/agent-model-selection';
import {
  getAgentModelSelectionId,
  getExecutionHarnessForModel,
  isAgentModel,
  isInheritingAgentModel,
  resolveKnownModel,
  resolveModelAlias,
  type AgentProviderType,
  type ChatCommand,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import type { AgentExecutionHarness } from '@canopy/protocol/models';
import { supportsChatHarnessChoice } from '@canopy/desktop-shared/lib/chat-model-selection';
import { AgentChatSendError } from './send-orchestration';
import { pinInheritingAgentToDestination } from '../agents/agent-default-model';
import {
  resolveAgentModelRuntime,
  type ResolvedAgentModelRuntime,
} from '../agents/agent-model-runtime';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { isCursorRuntimeAvailable } from '../cursor/runtime-availability';
import { isCopilotRuntimeAvailable } from '../copilot/runtime-availability';
import { isOpenCodeRuntimeAvailable } from '../opencode/runtime-availability';

/** A model selection checked against its creation target. */
export interface CreationModelSelection {
  /** The id the new chat stores: a route for an Agent on the default model. */
  model: ChatModel;
  agentId?: string;
  /**
   * The harness the action named for the new chat, checked against the
   * model's chat harness options; absent when the model's own harness runs.
   */
  executionHarness?: AgentExecutionHarness;
  fromDestinationDefault: boolean;
}

type CreateTabSeed = Omit<
  Extract<ChatCommand, { type: 'chat.create_tab' }>,
  'type' | 'tabId'
>;

/**
 * Check an explicitly selected model against the target project and work
 * owner, as `setStandaloneChatModel` and the turn would, before anything is
 * allocated. Throws a typed refusal; never writes an entry, tab or input.
 */
export async function resolveCreationModelSelection(
  requested: string,
  target: { projectId: string; taskId: string },
  options: {
    /** A harness the action named; must be one the model offers a chat. */
    executionHarness?: AgentExecutionHarness;
  } = {},
): Promise<CreationModelSelection> {
  const known = resolveKnownModel(requested);
  if (!known)
    throw new AgentChatSendError(
      'not_found',
      `Model ${requested} is not available. Use models.list to choose a model.`,
    );
  if (
    options.executionHarness !== undefined &&
    !supportsChatHarnessChoice(known, options.executionHarness)
  )
    throw new AgentChatSendError(
      'validation_failed',
      `Model ${requested} does not run on the ${options.executionHarness} harness. Use its harnessChoices from models.list, or omit executionHarness.`,
    );
  // Naming the model's own harness chooses nothing, as it does for
  // chat.create: the chat is not pinned, so later model changes move it.
  const executionHarness =
    options.executionHarness === getExecutionHarnessForModel(known)
      ? undefined
      : options.executionHarness;
  let model: ChatModel;
  try {
    model = await pinInheritingAgentToDestination(known, target.projectId);
  } catch (error) {
    throw error instanceof AgentModelSelectionError &&
      error.code === 'destination_default_unavailable'
      ? new AgentChatSendError(
          'target_not_ready',
          'The target project has no default model for this Agent.',
        )
      : new AgentChatSendError(
          'validation_failed',
          error instanceof Error ? error.message : 'The model is invalid.',
        );
  }
  // Dry run of the turn's resolution: the Agent exists, its install context
  // and shared owner still authorize this project, and its base can run.
  let runtime: ResolvedAgentModelRuntime;
  try {
    runtime = await resolveAgentModelRuntime({
      model,
      projectId: target.projectId,
    });
  } catch (error) {
    if (error instanceof AgentModelSelectionError)
      throw new AgentChatSendError('validation_failed', error.message);
    throw new AgentChatSendError(
      'not_found',
      isAgentModel(model)
        ? 'The selected Agent is not available in the target project.'
        : `Model ${requested} is not available. Use models.list to choose a model.`,
    );
  }
  try {
    // A named harness is the runtime the chat runs on; its connection is
    // checked in place of the model's own.
    await assertRunnableForTargetOwner(
      model,
      executionHarness === undefined
        ? runtime
        : { ...runtime, executionHarness },
      target,
    );
  } catch (error) {
    if (error instanceof AgentChatSendError) throw error;
    throw new AgentChatSendError(
      'target_not_ready',
      'The model could not be checked for the target project. Nothing was created; retry later.',
    );
  }
  return {
    model,
    fromDestinationDefault: isInheritingAgentModel(known),
    ...(isAgentModel(model)
      ? { agentId: getAgentModelSelectionId(model) }
      : {}),
    ...(executionHarness === undefined ? {} : { executionHarness }),
  };
}

/** Runtime connection, policy and gateway checks for the target work owner. */
async function assertRunnableForTargetOwner(
  model: ChatModel,
  { providerType, executionHarness, runtimeModel }: ResolvedAgentModelRuntime,
  target: { projectId: string; taskId: string },
): Promise<void> {
  for (const [runtimeId, label, isAvailable] of [
    ['cursor', 'Cursor', isCursorRuntimeAvailable],
    ['copilot', 'Copilot', isCopilotRuntimeAvailable],
    ['opencode', 'OpenCode', isOpenCodeRuntimeAvailable],
  ] as const) {
    if (
      (providerType === runtimeId || executionHarness === runtimeId) &&
      !(await isAvailable())
    )
      throw new AgentChatSendError(
        'target_not_ready',
        `${label} is not connected in the desktop app.`,
      );
  }
  const workOwner = await resolveAiCreditsScopeOwner({
    kind: 'work',
    projectId: target.projectId,
    worktreeId: target.taskId,
  });
  // An unknown owner would widen the policy and gateway checks to any org.
  if (!workOwner)
    throw new AgentChatSendError(
      'target_not_ready',
      'The owner of the target project could not be read. Nothing was created; retry later.',
    );
  if (await isModelBlockedByStoredPolicy(runtimeModel, workOwner))
    throw new AgentChatSendError(
      'validation_failed',
      'This model is blocked by your organization policy.',
    );
  const gateway = await checkModelGatewayRoute(model, workOwner);
  if (!gateway.ok)
    throw new AgentChatSendError('validation_failed', gateway.message);
}

/**
 * The new tab's seed for a checked selection: the explicit-model seed, with no
 * `defaultStampModel`. A route pinned to the target default takes that
 * default's own seed (model config, confirmed billing lane) with the route
 * swapped in, so it starts exactly as a default chat on its base would.
 */
export async function resolveCreationModelSeed(
  projectId: string,
  model: ChatModel,
  fromDestinationDefault = false,
  /**
   * The provider a named harness runs the chat on. The seed then carries that
   * provider and its defaults, so the harness pin that follows changes no
   * provider and keeps the seeded settings.
   */
  providerType?: AgentProviderType,
): Promise<CreateTabSeed | { noDispatchableModel: string }> {
  const { resolveRemoteCreateTabSeed } =
    await import('../portal/adapters/chat-adapter');
  const route = parseAgentRouteModelId(model);
  if (route && fromDestinationDefault && !providerType) {
    const defaults = await resolveRemoteCreateTabSeed(projectId);
    if (
      !('noDispatchableModel' in defaults) &&
      defaults.model !== undefined &&
      resolveModelAlias(defaults.model) === resolveModelAlias(route.baseModel)
    ) {
      const { defaultStampModel, ...seed } = defaults;
      void defaultStampModel;
      return { ...seed, model };
    }
  }
  return resolveRemoteCreateTabSeed(projectId, {
    model,
    ...(providerType === undefined ? {} : { providerType }),
  });
}
