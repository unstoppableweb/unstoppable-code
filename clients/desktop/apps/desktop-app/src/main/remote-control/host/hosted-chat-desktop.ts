import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { RpcPublicError } from '../transport/rpc-peer';
import {
  resolveKnownModel,
  type ChatCommandExecutionOptions,
  type ChatCommandRequest,
  type ChatCommandResult,
  type ChatStateCommandPort,
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
  modelRefusal: (target, model) =>
    remoteCreateTabModelRefusal(target, { model: knownModel(model) }),
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
  sendDelivery: async (target, userMessageId) => {
    const { delivery } = await sendReceiptFields(target, userMessageId);
    return delivery === undefined ? {} : { delivery };
  },
});
