import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { CanopyQueryOptions } from '@canopy/core-runtime';
import { resolveChatModelChangeHarness } from '@canopy/desktop-shared/lib/chat-model-selection';
import { RpcPublicError } from '../transport/rpc-peer';
import {
  getProviderForModel,
  isModelHarness,
  resolveKnownModel,
  type AgentProviderType,
  type ChatCommandExecutionOptions,
  type ChatCommandRequest,
  type ChatCommandResult,
  type ChatStateCommandPort,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../../canopy-runtime/core-chat-command-adapter';
import { getActiveDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { respondToChatQuestion } from '../../chat-questions/respond';
import {
  getChatStateCommandPort,
  validateChatCommandRequest,
} from '../../ipc/chat-state';
import {
  remoteCreateTabModelRefusal,
  remoteCreateTabNoModelMessage,
  resolveRemoteCreateTabSeed,
  sendReceiptFields,
} from './remote-chat-create';
import {
  createHostedChatDispatcher,
  type HostedChatAttribution,
} from './hosted-chat-dispatch';
import {
  createHostedOrchestratorDesktop,
  isSlackConversationsChat,
  readSlackTurnStatus,
  type HostedOrchestratorChatReads,
} from './hosted-orchestrator-desktop';

/**
 * The desktop wiring of the hosted chat dispatcher (CAN-5985): main's trusted
 * chat dispatch, Portal's create seed and preflight, and Portal's question
 * settlement. Loaded on a hosted session's first chat command.
 */

function chatPort(): ChatStateCommandPort {
  const port = getChatStateCommandPort();
  if (!port)
    throw new RpcPublicError(
      'The chat state service is temporarily unavailable.',
    );
  return port;
}

const orchestratorReadOptions: CanopyQueryOptions = {
  caller: {
    principalId: 'local-desktop-user',
    clientInstanceId: 'hosted-slack-orchestrator',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['core.chat.read'],
  },
};

const orchestratorChatReads: HostedOrchestratorChatReads = {
  getState: async ({ projectId, worktreeId }) => {
    const { legacyResult } =
      await getActiveDesktopRuntime().queryChatStateForLegacyIpc(
        { scope: { workspaceId: projectId, worktreeId } },
        orchestratorReadOptions,
      );
    return legacyResult;
  },
  transcriptPage: async ({ projectId, worktreeId, chatId, before }) => {
    const { legacyResult } =
      await getActiveDesktopRuntime().queryChatTranscriptPageForLegacyIpc(
        { scope: { workspaceId: projectId, worktreeId, chatId }, before },
        orchestratorReadOptions,
      );
    return legacyResult;
  },
};

/** A hosted session acts under its hosted root, with chat write only. */
function hostedCaller(
  attribution: HostedChatAttribution,
): CanopyCallerDescriptor {
  return {
    principalId: `remote-device:${attribution.rootDeviceId}`,
    clientInstanceId: `hosted-session:${attribution.sessionDeviceId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['core.chat.write'],
  };
}

function dispatch(
  request: ChatCommandRequest,
  attribution: HostedChatAttribution,
  options?: ChatCommandExecutionOptions,
): Promise<ChatCommandResult> {
  return dispatchTrustedChatCommand(request, {
    ...createChatCommandDispatchOptions(
      chatPort(),
      getActiveDesktopRuntime(),
      hostedCaller(attribution),
    ),
    ...(options === undefined ? {} : { executionOptions: options }),
  });
}

const AGENT_PROVIDER_TYPES: Record<AgentProviderType, true> = {
  claude: true,
  codex: true,
  ollama: true,
  cursor: true,
  opencode: true,
  copilot: true,
  antigravity: true,
};

function isAgentProviderType(value: unknown): value is AgentProviderType {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(AGENT_PROVIDER_TYPES, value)
  );
}

const OPENCODE_PROVIDER_REFUSAL =
  'The selected provider does not match the OpenCode harness.';

/**
 * One chat's persisted tab, read through the chat state port as the
 * pending-question lookup does (the core chat boundary forbids reaching the
 * chat state service directly). Only a model change reads it.
 */
async function hostedChatTab(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<PersistedChatTab | undefined> {
  const state = await chatPort().getState({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
  });
  return state.tabsFile.tabs.find((tab) => tab.id === target.chatId);
}

function knownModel(model: string): string {
  return resolveKnownModel(model) ?? model;
}

export const dispatchHostedChatCommandOnDesktop = createHostedChatDispatcher({
  validate: (request) => validateChatCommandRequest(request),
  dispatch,
  createSeed: async (projectId, model) => {
    const seed = await resolveRemoteCreateTabSeed(
      projectId,
      model === undefined ? undefined : { model: knownModel(model) },
    ).catch(() => null);
    if (seed === null) {
      return {
        refusal:
          'The default model could not be loaded. Try creating the chat again.',
      };
    }
    return 'noDispatchableModel' in seed
      ? { refusal: remoteCreateTabNoModelMessage(seed.noDispatchableModel) }
      : seed;
  },
  // A harness or provider outside the known set is refused by the chat
  // command validation. A model change is checked on the harness it will
  // apply to this tab (an OpenCode chat, or an explicitly chosen harness on
  // the same model, keeps its own), read from the tab alone.
  modelRefusal: async (target, model, change) => {
    const resolved = knownModel(model);
    if (change === undefined)
      return remoteCreateTabModelRefusal(target, { model: resolved });
    const harness = resolveChatModelChangeHarness(
      await hostedChatTab(target),
      resolved,
      isModelHarness(change.executionHarness)
        ? change.executionHarness
        : undefined,
    );
    // The apply path refuses this pair; say why before anything changes.
    if (harness === 'opencode' && change.providerType !== 'opencode')
      return OPENCODE_PROVIDER_REFUSAL;
    return remoteCreateTabModelRefusal(target, {
      model: resolved,
      executionHarness: harness,
      ...(isAgentProviderType(change.providerType)
        ? { providerType: change.providerType }
        : {}),
    });
  },
  // Undefined for a gateway or custom model, whose provider only its chooser
  // knows; `chat.set_model` then keeps the requested provider.
  modelProvider: (model) => getProviderForModel(knownModel(model)),
  pendingQuestion: async (scope, chatId, questionId) =>
    (await chatPort().getState(scope)).tabsFile.pendingQuestions?.find(
      (question) =>
        question.requestId === questionId && question.chatId === chatId,
    ),
  answerQuestion: (request) =>
    respondToChatQuestion({
      scope: request.scope,
      chatId: request.chatId,
      questionId: request.questionId,
      response: { kind: 'answer', answers: request.answers },
      commandId: request.commandId,
      origin: 'portal',
      port: chatPort(),
      executionOptions: { agentSent: request.attribution.sender },
      dispatch: (next, options) => dispatch(next, request.attribution, options),
    }),
  orchestrator: createHostedOrchestratorDesktop({
    chatPort: () => orchestratorChatReads,
    dispatch,
  }),
  sendDelivery: async (target, userMessageId) => {
    const { delivery } = await sendReceiptFields(target, userMessageId);
    return delivery === undefined ? {} : { delivery };
  },
});

/**
 * A Slack session's Orchestrator reads (CAN-7604). The hosted policy already
 * admitted the exact `{ chatId, userMessageId }` status request.
 */
export const hostedSlackOrchestratorReads = {
  readsChat: isSlackConversationsChat,
  turnStatus: (request: unknown): Promise<unknown> => {
    const chatId: unknown = Reflect.get(Object(request), 'chatId');
    const userMessageId: unknown = Reflect.get(
      Object(request),
      'userMessageId',
    );
    if (typeof chatId !== 'string' || typeof userMessageId !== 'string')
      return Promise.reject(
        new RpcPublicError('The turn status request was not valid.'),
      );
    return readSlackTurnStatus(orchestratorChatReads, {
      chatId,
      userMessageId,
    });
  },
};
