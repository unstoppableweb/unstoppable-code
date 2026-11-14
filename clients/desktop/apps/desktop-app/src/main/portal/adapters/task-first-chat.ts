import {
  isCodexSpeed,
  isThinkingLevel,
  normalizeAgentModelConfig,
  resolveKnownModel,
  type AgentModelConfig,
  type ChatCommandExecutionOptions,
  type ChatCommandRequest,
  type ChatCommandResult,
} from '@canopy/desktop-shared/types';
import {
  isChatTabPluginSelections,
  normalizePluginSelections,
} from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  isPortalChatAgentProviderType,
  type PortalTaskFirstChat,
  type PortalTaskFirstChatResult,
} from '@canopy/protocol/portal';
import { validateId } from '../../lib/validation';
import type { PortalAdapterContext } from './types';
import { resolveRemoteCreateTabSeed } from './chat-adapter';

const MODEL_CONFIG_KEYS = new Set(['thinkingLevel', 'speed', 'fastMode']);
const FIRST_CHAT_KEYS = new Set([
  'chatId',
  'userMessageId',
  'text',
  'planMode',
  'model',
  'providerType',
  'modelConfig',
  'pluginSelections',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseModelConfig(value: unknown): AgentModelConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('modelConfig must be an object.');
  if (Object.keys(value).some((key) => !MODEL_CONFIG_KEYS.has(key))) {
    throw new Error('modelConfig contains an unsupported field.');
  }
  if (
    (value.thinkingLevel !== undefined &&
      !isThinkingLevel(value.thinkingLevel)) ||
    (value.speed !== undefined && !isCodexSpeed(value.speed)) ||
    (value.fastMode !== undefined && typeof value.fastMode !== 'boolean') ||
    (value.speed !== undefined &&
      value.fastMode !== undefined &&
      value.fastMode !== (value.speed === 'fast'))
  ) {
    throw new Error('modelConfig contains an invalid value.');
  }
  return normalizeAgentModelConfig(value);
}

/** Validate an untrusted first-chat payload before it reaches the chat service. */
export function parseTaskFirstChat(value: unknown): PortalTaskFirstChat {
  if (!isRecord(value)) throw new Error('firstChat must be an object.');
  if (Object.keys(value).some((key) => !FIRST_CHAT_KEYS.has(key))) {
    throw new Error('firstChat contains an unsupported field.');
  }
  if (typeof value.chatId !== 'string') {
    throw new Error('firstChat.chatId must be an id.');
  }
  if (typeof value.userMessageId !== 'string') {
    throw new Error('firstChat.userMessageId must be an id.');
  }
  validateId(value.chatId, 'chatId');
  validateId(value.userMessageId, 'userMessageId');
  if (typeof value.text !== 'string' || value.text.trim().length === 0) {
    throw new Error('firstChat.text must not be blank.');
  }
  if (
    value.model !== undefined &&
    (typeof value.model !== 'string' || value.model.trim().length === 0)
  ) {
    throw new Error('firstChat.model must be a model id.');
  }
  if (
    value.providerType !== undefined &&
    !isPortalChatAgentProviderType(value.providerType)
  ) {
    throw new Error('firstChat.providerType is not supported.');
  }
  if (value.providerType !== undefined && value.model === undefined) {
    throw new Error('firstChat.providerType requires firstChat.model.');
  }
  if (value.planMode !== undefined && typeof value.planMode !== 'boolean') {
    throw new Error('firstChat.planMode must be a boolean.');
  }
  const modelConfig = parseModelConfig(value.modelConfig);
  if (
    value.pluginSelections !== undefined &&
    !isChatTabPluginSelections(value.pluginSelections)
  ) {
    throw new Error('firstChat.pluginSelections is invalid.');
  }
  if (isRecord(value.pluginSelections)) {
    const { collectionIds, bundleIds } = value.pluginSelections;
    for (const ids of [collectionIds, bundleIds]) {
      if (
        Array.isArray(ids) &&
        ids.some((id) => typeof id !== 'string' || id.trim().length === 0)
      ) {
        throw new Error(
          'firstChat.pluginSelections contains an empty identifier.',
        );
      }
    }
  }
  const pluginSelections =
    value.pluginSelections === undefined
      ? undefined
      : normalizePluginSelections(value.pluginSelections);

  return {
    chatId: value.chatId,
    userMessageId: value.userMessageId,
    text: value.text,
    ...(value.planMode === undefined ? {} : { planMode: value.planMode }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.providerType === undefined
      ? {}
      : { providerType: value.providerType }),
    ...(modelConfig === undefined ? {} : { modelConfig }),
    ...(pluginSelections === undefined ? {} : { pluginSelections }),
  };
}

function dispatchChatCommand(
  context: PortalAdapterContext,
  request: ChatCommandRequest,
  options: ChatCommandExecutionOptions,
): Promise<ChatCommandResult> {
  if (context.dispatchChatCommand) {
    return context.dispatchChatCommand(request, options);
  }
  if (context.chatStatePort) {
    return context.chatStatePort.command(request, options);
  }
  throw new Error('Chat state is unavailable for the first task message.');
}

function requireCommittedResult(
  result: ChatCommandResult,
  action: string,
): void {
  if (result.outcome !== 'applied' && result.outcome !== 'already_applied') {
    throw new Error(result.reason ?? `Could not ${action}.`);
  }
}

async function readDelivery(
  workspaceId: string,
  worktreeId: string,
  chatId: string,
  userMessageId: string,
): Promise<'queued' | 'started'> {
  const target = { projectId: workspaceId, worktreeId, chatId };
  try {
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    if (
      getChatStateService().isAwaitingWorktreeSetup({
        ...target,
        userMessageId,
      })
    ) {
      return 'queued';
    }
  } catch {
    // Fall through to the same queue check used by the existing Portal send.
  }
  try {
    const { getChatQueueService } =
      await import('../../services/chat-queue-service');
    const queue = getChatQueueService();
    return queue.holdsUserMessage(target, userMessageId) &&
      queue.runningTurnUserMessageId(target) !== userMessageId
      ? 'queued'
      : 'started';
  } catch {
    return 'started';
  }
}

/** Create and send the client-minted first chat for a newly created task. */
export async function createTaskFirstChat(input: {
  commandId: string;
  workspaceId: string;
  worktreeId: string;
  firstChat: PortalTaskFirstChat;
  context: PortalAdapterContext;
}): Promise<PortalTaskFirstChatResult> {
  validateId(input.workspaceId, 'workspaceId');
  validateId(input.worktreeId, 'worktreeId');
  const firstChat = parseTaskFirstChat(input.firstChat);
  const requested =
    firstChat.model === undefined
      ? undefined
      : {
          model: resolveKnownModel(firstChat.model) ?? firstChat.model,
          ...(firstChat.providerType === undefined
            ? {}
            : { providerType: firstChat.providerType }),
        };
  const seed = await resolveRemoteCreateTabSeed(input.workspaceId, requested);
  if ('noDispatchableModel' in seed) {
    throw new Error('No model is available for a new chat.');
  }
  const createOptions: ChatCommandExecutionOptions = {
    ...(input.context.canMutateResources
      ? { canCommitCreate: input.context.canMutateResources }
      : {}),
  };
  const createRequest: ChatCommandRequest = {
    schemaVersion: 1,
    commandId: `${input.commandId}:first-chat:tab`,
    projectId: input.workspaceId,
    worktreeId: input.worktreeId,
    origin: 'portal',
    command: {
      type: 'chat.create_tab',
      tabId: firstChat.chatId,
      ...seed,
      ...(firstChat.planMode === undefined
        ? {}
        : { planMode: firstChat.planMode }),
      ...(firstChat.modelConfig === undefined
        ? {}
        : { modelConfig: firstChat.modelConfig }),
      ...(firstChat.pluginSelections === undefined
        ? {}
        : { pluginSelections: firstChat.pluginSelections }),
    },
  };
  const createResult = await dispatchChatCommand(
    input.context,
    createRequest,
    createOptions,
  );
  requireCommittedResult(createResult, 'create the first chat tab');

  const sendOptions: ChatCommandExecutionOptions = {
    ...(input.context.canReadAssets
      ? { canCommitSend: input.context.canReadAssets }
      : {}),
  };
  const sendRequest: ChatCommandRequest = {
    schemaVersion: 1,
    commandId: `${input.commandId}:first-chat:send`,
    projectId: input.workspaceId,
    worktreeId: input.worktreeId,
    origin: 'portal',
    command: {
      type: 'chat.send_message',
      chatId: firstChat.chatId,
      userMessageId: firstChat.userMessageId,
      text: firstChat.text,
      ...(input.context.origin ? { agentSent: input.context.origin } : {}),
      ...(firstChat.model === undefined ? {} : { model: firstChat.model }),
      ...(firstChat.providerType === undefined
        ? {}
        : { providerType: firstChat.providerType }),
      ...(firstChat.modelConfig === undefined
        ? {}
        : { modelConfig: firstChat.modelConfig }),
      ...(firstChat.planMode === undefined
        ? {}
        : { planMode: firstChat.planMode }),
    },
  };
  const sendResult = await dispatchChatCommand(
    input.context,
    sendRequest,
    sendOptions,
  );
  requireCommittedResult(sendResult, 'send the first task message');
  const delivery = await readDelivery(
    input.workspaceId,
    input.worktreeId,
    firstChat.chatId,
    firstChat.userMessageId,
  );
  return {
    chatId: firstChat.chatId,
    userMessageId: firstChat.userMessageId,
    delivery,
  };
}
