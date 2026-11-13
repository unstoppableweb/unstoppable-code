import {
  getAgentModelSelectionId,
  isAgentModel,
  isInheritingAgentModel,
  resolveKnownModel,
  resolveModelAlias,
  type ChatCommand,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import { AgentChatSendError } from './send-orchestration';
import { pinInheritingAgentToDestination } from '../agents/agent-default-model';
import {
  resolveAgentModelRuntime,
  type ResolvedAgentModelRuntime,
} from '../agents/agent-model-runtime';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';
import { NoDispatchableModelError } from '../lib/default-model-lane-resolver';
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
}

type CreateTabSeed = Omit<
  Extract<ChatCommand, { type: 'chat.create_tab' }>,
  'type' | 'tabId'
>;

/**
 * Check an explicitly selected model against the target project and work
 * owner, as `setStandaloneChatModel` and the turn would, before anything is
 * allocated. Throws a typed refusal; never writes an entry, tab or input.
 * `acceptAgentRoute` is for an automation's own chat (CAN-5379), whose route
 * the automations service already resolved, as its native send ran it.
 */
export async function resolveCreationModelSelection(
  requested: string,
  target: { projectId: string; taskId: string },
  options: { acceptAgentRoute?: boolean } = {},
): Promise<CreationModelSelection> {
  const known = resolveKnownModel(requested);
  if (!known)
    throw new AgentChatSendError(
      'not_found',
      `Model ${requested} is not available. Use models.list to choose a model.`,
    );
  // models.list lists Agents by bare id. A route would let the caller choose an
  // inheriting Agent's base instead of the target default.
  const route = parseAgentRouteModelId(known);
  if (route && options.acceptAgentRoute !== true)
    throw new AgentChatSendError(
      'validation_failed',
      `Choose the Agent itself (${route.agentId}) instead of "${known}"; the target project decides its model.`,
    );
  let model: ChatModel;
  try {
    model = await pinInheritingAgentToDestination(known, target.projectId);
  } catch (error) {
    throw error instanceof NoDispatchableModelError
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
  } catch {
    throw new AgentChatSendError(
      'not_found',
      isAgentModel(model)
        ? 'The selected Agent is not available in the target project.'
        : `Model ${requested} is not available. Use models.list to choose a model.`,
    );
  }
  try {
    await assertRunnableForTargetOwner(model, runtime, target);
  } catch (error) {
    if (error instanceof AgentChatSendError) throw error;
    throw new AgentChatSendError(
      'target_not_ready',
      'The model could not be checked for the target project. Nothing was created; retry later.',
    );
  }
  return {
    model,
    ...(isAgentModel(model)
      ? { agentId: getAgentModelSelectionId(model) }
      : {}),
  };
}

/** Runtime connection, policy and gateway checks for the target work owner. */
async function assertRunnableForTargetOwner(
  model: ChatModel,
  { providerType, executionHarness }: ResolvedAgentModelRuntime,
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
  if (await isModelBlockedByStoredPolicy(model, workOwner))
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
): Promise<CreateTabSeed | { noDispatchableModel: string }> {
  const { resolveRemoteCreateTabSeed } =
    await import('../portal/adapters/chat-adapter');
  const route = parseAgentRouteModelId(model);
  if (route && isInheritingAgentModel(route.agentId)) {
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
  return resolveRemoteCreateTabSeed(projectId, { model });
}
