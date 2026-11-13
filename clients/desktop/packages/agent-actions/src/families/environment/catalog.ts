import { THINKING_LEVELS } from '@canopy/protocol/thinking';
import type { AgentActionBrand } from '../../brand';
import type { AgentActionCatalogEntry } from '../../catalog/types';
import type { AgentJson } from '../../response';
import type { AgentChatCreatePlacement } from '../../surface/capabilities';
import type { AgentActionFamilyJsonSchema } from '../../surface/family';
import {
  ENVIRONMENT_CHAT_CREATE_PLACEMENTS,
  ENVIRONMENT_MAX_CURSOR_LENGTH,
  ENVIRONMENT_MAX_ID_LENGTH,
  ENVIRONMENT_MAX_INLINE_WATCHERS,
  ENVIRONMENT_MAX_LABEL_LENGTH,
  ENVIRONMENT_MAX_MESSAGE_LENGTH,
  ENVIRONMENT_MAX_PAGE_SIZE,
  type EnvironmentActionType,
} from './actions';

type EnvironmentCatalogEntry = AgentActionCatalogEntry<
  EnvironmentActionType,
  { type: EnvironmentActionType; [field: string]: AgentJson }
>;

const UNMESSAGEABLE_NOTE =
  'A chat with messageable: false cannot receive chat.send_message (for example, it runs in a terminal session). Sending to it fails with invalid_target; do not retry. Start a chat with chat.create instead.';

const LIMIT_FIELD = {
  name: 'limit',
  type: 'number',
  required: false,
  description: `Maximum rows to return, 1-${ENVIRONMENT_MAX_PAGE_SIZE}.`,
};

const CURSOR_FIELD = {
  name: 'cursor',
  type: 'string',
  required: false,
  description: 'nextCursor from the previous page.',
};

const WATCHERS_FIELD = {
  name: 'watchers',
  type: 'array',
  required: false,
  description: `Up to ${ENVIRONMENT_MAX_INLINE_WATCHERS} watchers armed with the message: each { label?, followUpInstruction? } notifies this chat when the target chat finishes the turn this action starts.`,
};

/** The environment actions' catalog rows for one brand. */
export function environmentActionCatalog(
  brand: AgentActionBrand,
): readonly EnvironmentCatalogEntry[] {
  return [
    {
      type: 'workspace.get',
      category: 'workspace',
      summary: `Read the current ${brand.displayName} workspace: its id, name, kind, and repositories.`,
      fields: [],
      example: { type: 'workspace.get' },
      keywords: ['workspace', 'project', 'current', 'repositories', 'repo'],
    },
    {
      type: 'worktree.list',
      category: 'worktree',
      summary:
        'List the worktrees in the current workspace and mark the current one.',
      fields: [LIMIT_FIELD, CURSOR_FIELD],
      example: { type: 'worktree.list', limit: 20 },
      keywords: ['worktree', 'worktrees', 'branch', 'task', 'tasks', 'list'],
    },
    {
      type: 'chat.list',
      category: 'chat',
      summary:
        'List chats in a worktree of the current workspace with their state and model.',
      fields: [
        {
          name: 'inWorktreeId',
          type: 'string',
          required: false,
          description:
            'Worktree id from worktree.list. Defaults to the current worktree.',
        },
        {
          name: 'includeArchived',
          type: 'boolean',
          required: false,
          description: 'Include archived chats. Defaults to false.',
        },
        LIMIT_FIELD,
        CURSOR_FIELD,
      ],
      example: { type: 'chat.list' },
      keywords: ['chat', 'chats', 'tabs', 'conversations', 'list', 'running'],
      notes: [UNMESSAGEABLE_NOTE],
    },
    {
      type: 'chat.get',
      category: 'chat',
      summary:
        'Read one chat in the current workspace, including its latest response.',
      fields: [
        {
          name: 'chatId',
          type: 'string',
          required: true,
          description: 'Chat id from chat.list.',
        },
      ],
      example: { type: 'chat.get', chatId: 'chat-id' },
      keywords: ['chat', 'get', 'read', 'status', 'response', 'result'],
      notes: [UNMESSAGEABLE_NOTE],
    },
    {
      type: 'chat.create',
      category: 'chat',
      summary:
        'Start an independent chat with a first message, in the current worktree or a new one.',
      fields: [
        {
          name: 'message',
          type: 'string',
          required: true,
          description: 'First user message of the new chat.',
        },
        {
          name: 'placement',
          type: 'string',
          required: false,
          description:
            'current (default) starts the chat in this worktree; new_worktree starts it in a new worktree.',
        },
        {
          name: 'model',
          type: 'string',
          required: false,
          description:
            'Model id from models.list. Defaults to the default model.',
        },
        {
          name: 'thinkingLevel',
          type: 'string',
          required: false,
          description: `Thinking level the model supports: ${THINKING_LEVELS.join(', ')}.`,
        },
        {
          name: 'title',
          type: 'string',
          required: false,
          description: 'Chat title.',
        },
        WATCHERS_FIELD,
      ],
      example: {
        type: 'chat.create',
        message: 'Review the open pull request and summarize the risks.',
        watchers: [{ label: 'Review finished' }],
      },
      additionalExamples: [
        {
          type: 'chat.create',
          message: 'Prototype the parser in a separate branch.',
          placement: 'new_worktree',
        },
      ],
      keywords: [
        'chat',
        'create',
        'new',
        'start',
        'spawn',
        'agent',
        'parallel',
        'delegate',
        'worktree',
      ],
      notes: [
        'The new chat is independent: it does not report back unless a watcher is armed.',
      ],
    },
    {
      type: 'chat.send_message',
      category: 'chat',
      summary: 'Send a user message to another chat in the current workspace.',
      fields: [
        {
          name: 'chatId',
          type: 'string',
          required: true,
          description:
            'Chat id from chat.list. Not the current chat, and not a chat with messageable: false.',
        },
        {
          name: 'message',
          type: 'string',
          required: true,
          description: 'Message text.',
        },
        WATCHERS_FIELD,
      ],
      example: {
        type: 'chat.send_message',
        chatId: 'chat-id',
        message: 'Also cover the migration path.',
      },
      keywords: ['chat', 'send', 'message', 'reply', 'follow', 'up', 'tell'],
    },
    {
      type: 'models.list',
      category: 'models',
      summary: 'List the models new chats can use and the default model.',
      fields: [],
      example: { type: 'models.list' },
      keywords: ['models', 'model', 'list', 'thinking', 'default'],
    },
  ];
}

/**
 * The environment actions' DispatchAction payload properties. Without a
 * placement (no chat.create) `placement` is omitted: an empty `enum` is not
 * valid JSON Schema.
 */
export function environmentDispatchJsonSchema(
  placements: readonly AgentChatCreatePlacement[],
): AgentActionFamilyJsonSchema {
  const requireFor = (
    type: EnvironmentActionType,
    required: string[],
  ): AgentJson => ({
    if: { properties: { type: { const: type } }, required: ['type'] },
    then: { required },
  });
  const offered = ENVIRONMENT_CHAT_CREATE_PLACEMENTS.filter((placement) =>
    placements.includes(placement),
  );
  const id: AgentJson = {
    type: 'string',
    minLength: 1,
    maxLength: ENVIRONMENT_MAX_ID_LENGTH,
  };
  const message: AgentJson = {
    type: 'string',
    minLength: 1,
    maxLength: ENVIRONMENT_MAX_MESSAGE_LENGTH,
  };
  const label: AgentJson = {
    type: 'string',
    minLength: 1,
    maxLength: ENVIRONMENT_MAX_LABEL_LENGTH,
  };
  return {
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: ENVIRONMENT_MAX_PAGE_SIZE,
      },
      cursor: {
        type: 'string',
        minLength: 1,
        maxLength: ENVIRONMENT_MAX_CURSOR_LENGTH,
      },
      inWorktreeId: id,
      includeArchived: { type: 'boolean' },
      chatId: id,
      message,
      ...(offered.length > 0
        ? { placement: { type: 'string', enum: offered } }
        : {}),
      model: id,
      thinkingLevel: { type: 'string', enum: [...THINKING_LEVELS] },
      title: label,
      watchers: {
        type: 'array',
        minItems: 1,
        maxItems: ENVIRONMENT_MAX_INLINE_WATCHERS,
        items: {
          type: 'object',
          properties: {
            label,
            followUpInstruction: message,
          },
          additionalProperties: false,
        },
      },
    },
    allOf: [
      requireFor('chat.get', ['chatId']),
      requireFor('chat.create', ['message']),
      requireFor('chat.send_message', ['chatId', 'message']),
    ],
  };
}
