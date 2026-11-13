import type { AgentActionCatalogEntry } from '../../catalog/types';
import {
  agentActionError,
  agentActionIdempotencyKey,
  agentActionResult,
  agentActionToolResult,
  missingScopeResponse,
  portErrorResponse,
  runIdempotentWrite,
  type AgentWritePreparation,
} from '../../action-support';
import type {
  AgentChatControlPort,
  AgentChatControlTarget,
} from '../../port/chat-control-port';
import {
  AgentPortError,
  type AgentEnvironmentPort,
} from '../../port/environment-port';
import type { AgentActionReceiptStore } from '../../receipts';
import type { AgentJson } from '../../response';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionDispatchOutput,
  type AgentActionFamily,
  type AgentActionFamilyJsonSchema,
} from '../../surface/family';
import type { AgentActionToolResult } from '../../tools/definition';
import { ENVIRONMENT_MAX_ID_LENGTH } from '../environment/actions';
import {
  CHAT_CONTROL_ACTION_TYPES,
  chatControlActionSchema,
  type ChatControlAction,
  type ChatControlActionType,
} from './actions';

export {
  CHAT_CONTROL_ACTION_TYPES,
  chatControlActionSchema,
  type ChatControlAction,
  type ChatControlActionType,
} from './actions';

const SELF_TARGET: Record<ChatControlActionType, string> = {
  'chat.interrupt': 'A chat cannot interrupt itself.',
  'chat.cancel': 'A chat cannot cancel itself.',
  'chat.archive': 'A chat cannot archive itself.',
};

const UNCERTAIN_INTERRUPT = (chatId: string): string =>
  `An earlier attempt of this call may already have interrupted chat ${chatId}, and a turn running now may be a later one, so it is not interrupted again. Check it with chat.get, and make a new chat.interrupt call if it should still stop.`;

const STILL_RUNNING = (chatId: string): string =>
  `Chat ${chatId} is still running. Stop it with chat.cancel first, then archive it.`;

/**
 * `chat.interrupt`, `chat.cancel` and `chat.archive`: stop or archive
 * another chat of the calling chat's workspace, as its owner would from the
 * chat's own controls. The target is resolved through the environment port,
 * so it obeys the same workspace scope as `chat.get` and
 * `chat.send_message`. Each write is keyed and recorded in the receipt
 * store, so a retried tool call replays its original result. None of them
 * starts work, so they take no limits reservation.
 */
export function createChatControlActionFamily<H>(options: {
  environment: AgentEnvironmentPort<H>;
  port: AgentChatControlPort<H>;
  receipts: AgentActionReceiptStore<H>;
}): AgentActionFamily<H> {
  const { environment, port, receipts } = options;

  async function run(
    action: ChatControlAction,
    target: AgentChatControlTarget,
    archived: boolean,
    call: AgentActionCall<H>,
  ): Promise<AgentJson> {
    // An archived chat runs nothing, and a host need not reach its session
    // to say so.
    switch (action.type) {
      case 'chat.interrupt':
        return archived
          ? { chatId: target.chatId, interrupted: false }
          : { ...(await port.interrupt(target, call)) };
      case 'chat.cancel':
        return archived
          ? { chatId: target.chatId, interrupted: false, cancelledQueued: 0 }
          : { ...(await port.cancel(target, call)) };
      case 'chat.archive':
        return { ...(await port.archive(target, call)) };
    }
  }

  return defineAgentActionFamily<H, ChatControlAction>({
    id: 'chat-control',
    types: CHAT_CONTROL_ACTION_TYPES,
    actionSchema: chatControlActionSchema,
    supportedTypes: () => CHAT_CONTROL_ACTION_TYPES,
    catalog: chatControlActionCatalog,
    dispatchJsonSchema: chatControlDispatchJsonSchema,
    dispatch: async (action, call): Promise<AgentActionDispatchOutput> => {
      const scope = call.scope;
      if (!scope) return missingScopeResponse(call, action.type);
      if (action.chatId === scope.chatId)
        return agentActionError(
          call,
          'invalid_target',
          SELF_TARGET[action.type],
        );
      try {
        const chat = await environment.getChat(
          { scope: { workspaceId: scope.workspaceId }, chatId: action.chatId },
          call,
        );
        if (!chat)
          return agentActionError(
            call,
            'not_found',
            `Chat ${action.chatId} was not found.`,
          );
        // The host may resolve another spelling of an id (case, padding) to
        // the same chat, so the resolved id is checked as well.
        if (chat.chatId === scope.chatId)
          return agentActionError(
            call,
            'invalid_target',
            SELF_TARGET[action.type],
          );
        if (chat.workspaceId !== scope.workspaceId)
          return agentActionError(
            call,
            'invalid_target',
            `Chat ${action.chatId} is not in the current workspace.`,
          );
        const idempotencyKey = agentActionIdempotencyKey(
          action.type,
          call,
          action,
        );
        return await runIdempotentWrite({
          receipts,
          limits: null,
          kind: action.type,
          call,
          idempotencyKey,
          payload: action,
          prepare: (): Promise<AgentWritePreparation> => {
            // State that can change after the write is checked only for a
            // new write, so a replay never fails because the chat moved on.
            if (
              action.type === 'chat.archive' &&
              (chat.state === 'running' || chat.state === 'queued')
            )
              return Promise.resolve({
                ok: false,
                response: agentActionError(
                  call,
                  'invalid_target',
                  STILL_RUNNING(action.chatId),
                ),
              });
            return Promise.resolve({
              ok: true,
              parentDepth: 0,
              write: async (attempt): Promise<AgentActionToolResult> => {
                // An interrupt names no turn: it stops whichever runs. After
                // an unknown outcome the turn it stopped may have been
                // followed by a queued one, so a retry must not run again.
                if (action.type === 'chat.interrupt' && attempt.uncertain)
                  throw new AgentPortError(
                    'execution_failed',
                    UNCERTAIN_INTERRUPT(action.chatId),
                  );
                return agentActionToolResult(
                  agentActionResult(
                    call,
                    action.type,
                    await run(
                      action,
                      {
                        chatId: chat.chatId,
                        worktreeId: chat.worktreeId,
                        idempotencyKey,
                      },
                      chat.state === 'archived',
                      call,
                    ),
                  ),
                );
              },
            });
          },
        });
      } catch (error) {
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}

const CHAT_ID_FIELD = {
  name: 'chatId',
  type: 'string',
  required: true,
  description:
    'Chat id from chat.list, or one chat.create returned. Never the calling chat.',
};

export function chatControlActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'chat.interrupt',
      category: 'chat',
      summary:
        "Stop another chat's running turn in the current workspace, as its Stop button does. Messages queued behind that turn still run afterwards.",
      fields: [CHAT_ID_FIELD],
      example: { type: 'chat.interrupt', chatId: 'chat-id' },
      keywords: ['chat', 'stop', 'interrupt', 'halt', 'abort', 'turn'],
      notes: [
        "Returns interrupted: false when the chat had no running turn. The stop is recorded as yours, not the user's.",
        'Use chat.cancel instead to also drop the messages queued behind the turn. Do not send a "stop" message: it queues behind the running turn.',
      ],
    },
    {
      type: 'chat.cancel',
      category: 'chat',
      summary:
        'Cancel all work in another chat of the current workspace: drop the messages queued in it, then stop its running turn, so it goes idle.',
      fields: [CHAT_ID_FIELD],
      example: { type: 'chat.cancel', chatId: 'chat-id' },
      keywords: [
        'chat',
        'cancel',
        'stop',
        'abort',
        'queued',
        'queue',
        'kill',
        'terminate',
      ],
      notes: [
        'Returns how many queued messages were dropped (cancelledQueued) and whether a running turn was stopped (interrupted).',
        'Use this when the user asks to stop or cancel chats you started. The chat stays open, and you can message it again later.',
      ],
    },
    {
      type: 'chat.archive',
      category: 'chat',
      summary:
        'Archive another idle chat of the current workspace, as closing it would. The user can restore it from the archived chats.',
      fields: [CHAT_ID_FIELD],
      example: { type: 'chat.archive', chatId: 'chat-id' },
      keywords: ['chat', 'archive', 'close', 'remove', 'clean up', 'tidy'],
      notes: [
        'A running chat is refused: stop it with chat.cancel first. Returns archived: false when the chat was already archived.',
        "Archive only chats the user asked you to archive or chats you started. Archiving a task's first chat archives the task with its other chats; a host refuses it when that would archive this chat too.",
      ],
    },
  ];
}

export const chatControlDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    chatId: {
      type: 'string',
      minLength: 1,
      maxLength: ENVIRONMENT_MAX_ID_LENGTH,
    },
  },
  allOf: CHAT_CONTROL_ACTION_TYPES.map(
    (type): AgentJson => ({
      if: { properties: { type: { const: type } }, required: ['type'] },
      then: { required: ['chatId'] },
    }),
  ),
};
