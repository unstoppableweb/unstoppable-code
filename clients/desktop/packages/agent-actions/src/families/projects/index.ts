import {
  agentActionIdempotencyKey,
  agentActionToolResult,
  missingScopeResponse,
  portErrorResponse,
  runIdempotentWrite,
} from '../../action-support';
import type { AgentActionLimitKind } from '../../limits';
import type {
  AgentProjectBotPort,
  AgentProjectWrites,
} from '../../port/project-bot-port';
import type { AgentJson } from '../../response';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionDispatchOutput,
  type AgentActionFamily,
  type AgentActionFamilyJsonSchema,
} from '../../surface/family';
import type { BotAction } from '../bots/actions';
import {
  PROJECT_ACTION_TYPES,
  PROJECT_DISCOVERY_CURSOR_MAX,
  PROJECT_DISCOVERY_ID_MAX,
  PROJECT_DISCOVERY_PAGE_SIZE_MAX,
  PROJECT_DISCOVERY_TEXT_MAX,
  projectActionSchema,
  type ProjectAction,
  type ProjectWriteAction,
} from './actions';
import { PROJECT_ACTION_CATALOG } from './catalog';
import { MAX_SEND_INLINE_WATCHERS } from './messages';

export {
  PROJECT_ACTION_TYPES,
  PROJECT_DISCOVERY_TYPES,
  PROJECT_READ_TYPES,
  PROJECT_WRITE_TYPES,
  projectActionSchema,
  type ProjectAction,
  type ProjectActionType,
  type ProjectWriteAction,
} from './actions';
export { PROJECT_ACTION_CATALOG } from './catalog';

const ID: AgentJson = {
  type: 'string',
  minLength: 1,
  maxLength: PROJECT_DISCOVERY_ID_MAX,
};

/** A DispatchAction conditional: these action types require these fields. */
export function requireFieldsFor(
  types: readonly string[],
  required: string[],
): AgentJson {
  return {
    if: { properties: { type: { enum: [...types] } }, required: ['type'] },
    then: { required },
  };
}

/**
 * Advertised payload fields shared by the project and bot read actions. The
 * composed DispatchAction schema applies one definition per name to every
 * family, so names other actions also take (`query`, `pageSize`, `projectId`)
 * stay type-only; each family's strict schema enforces its own limits.
 */
export const PROJECT_READ_JSON_PROPERTIES: Record<string, AgentJson> = {
  taskId: {
    ...ID,
    description:
      'Canonical task target from task discovery: optional for list_task_chats, required for reads.',
  },
  chatId: {
    ...ID,
    description: 'Canonical chat ID from chat discovery.',
  },
  query: {
    type: 'string',
    description: `Project and bot actions: 1–${PROJECT_DISCOVERY_TEXT_MAX} characters, a metadata search for discovery or a literal case-insensitive visible-text search for read_history.`,
  },
  roles: {
    type: 'array',
    minItems: 1,
    items: { type: 'string', enum: ['user', 'assistant'] },
    description: 'Optional unique role filter for read_history.',
  },
  pageSize: {
    type: 'integer',
    description: `Discovery: 1–${PROJECT_DISCOVERY_PAGE_SIZE_MAX}, default 50. read_history: 1–100, default 20.`,
  },
  cursor: {
    type: 'string',
    minLength: 1,
    maxLength: PROJECT_DISCOVERY_CURSOR_MAX,
    description: 'Opaque continuation cursor from the previous page.',
  },
  order: { type: 'string', enum: ['asc', 'desc'] },
  text: {
    type: 'string',
    description:
      'Project and bot sends and schedules: the nonblank message, sent with its whitespace.',
  },
  watchers: {
    type: 'array',
    maxItems: MAX_SEND_INLINE_WATCHERS,
    items: {
      type: 'object',
      properties: {
        label: { type: 'string', maxLength: 160 },
        followUpInstruction: { type: 'string', maxLength: 8000 },
        allowDuplicate: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    description: `Project and bot sends: up to ${String(MAX_SEND_INLINE_WATCHERS)} completion watchers that notify this chat.`,
  },
  initialMessage: {
    type: 'string',
    description: 'Creation: the nonblank first message of the new chat.',
  },
};

/** The projects family's share of the advertised DispatchAction payload. */
export const projectDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    projectId: {
      type: 'string',
      description:
        'Explicit canonical project target from projects.list, for projects.* actions only.',
    },
    ...PROJECT_READ_JSON_PROPERTIES,
    queueForSetup: {
      type: 'boolean',
      description:
        'projects.send_message to a code task: hold the input until setup finishes.',
    },
    queuedMessageId: {
      type: 'string',
      description:
        'projects.steer_queued_message: the queued input ID from a queued send receipt.',
    },
    runAt: {
      type: 'string',
      description:
        'projects.schedule_message: an ISO instant with Z or an explicit offset.',
    },
    attachments: {
      type: 'object',
      description:
        'projects.schedule_message: typed fileReferences, attachmentPaths and attachmentPromptContexts.',
    },
  },
  allOf: [
    requireFieldsFor(
      ['projects.list_tasks', 'projects.list_task_chats'],
      ['projectId'],
    ),
    requireFieldsFor(
      ['projects.send_message'],
      ['projectId', 'taskId', 'chatId', 'text'],
    ),
    requireFieldsFor(
      ['projects.steer_queued_message'],
      ['projectId', 'taskId', 'chatId', 'queuedMessageId'],
    ),
    requireFieldsFor(
      ['projects.schedule_message'],
      ['projectId', 'taskId', 'chatId', 'text', 'runAt'],
    ),
    requireFieldsFor(['projects.create_task'], ['projectId']),
    requireFieldsFor(['projects.create_task_chat'], ['projectId', 'taskId']),
    requireFieldsFor(
      [
        'projects.get_last_user_message',
        'projects.get_last_agent_response',
        'projects.read_history',
      ],
      ['projectId', 'taskId', 'chatId'],
    ),
  ],
};

/**
 * Run one explicit-target action on the host. The call must carry the
 * trusted caller scope; the host authorizes the target itself.
 */
export async function dispatchProjectBotAction<H>(
  action: ProjectAction | BotAction,
  port: AgentProjectBotPort<H>,
  call: AgentActionCall<H>,
): Promise<AgentActionDispatchOutput> {
  if (!call.scope) return missingScopeResponse(call, action.type);
  try {
    return {
      ...(await port.dispatch(action, call)),
      requestId: call.toolUseId ?? '',
    };
  } catch (error) {
    return portErrorResponse(call, action.type, error);
  }
}

/**
 * The limits kind each project write reserves under. Steering and scheduling
 * deliver an input, so they count as sends; creations spawn work, so the
 * limits also check their depth.
 */
const PROJECT_WRITE_LIMIT_KIND: Record<
  ProjectWriteAction['type'],
  AgentActionLimitKind
> = {
  'projects.send_message': 'chat.send_message',
  'projects.steer_queued_message': 'chat.send_message',
  'projects.schedule_message': 'chat.send_message',
  'projects.create_task': 'chat.create',
  'projects.create_task_chat': 'chat.create',
};

/** The action, when it is one of the project writes. */
function projectWrite(action: ProjectAction): ProjectWriteAction | null {
  switch (action.type) {
    case 'projects.send_message':
    case 'projects.steer_queued_message':
    case 'projects.schedule_message':
    case 'projects.create_task':
    case 'projects.create_task_chat':
      return action;
    default:
      return null;
  }
}

/**
 * One project write behind the host's receipts and limits, keyed like the
 * environment writes by the calling chat, actor, turn and tool call.
 */
async function dispatchProjectWrite<H>(
  action: ProjectWriteAction,
  writes: AgentProjectWrites<H>,
  call: AgentActionCall<H>,
): Promise<AgentActionDispatchOutput> {
  if (!call.scope) return missingScopeResponse(call, action.type);
  const idempotencyKey = agentActionIdempotencyKey(action.type, call, action);
  try {
    return await runIdempotentWrite({
      receipts: writes.receipts,
      limits: writes.limits,
      kind: PROJECT_WRITE_LIMIT_KIND[action.type],
      call,
      idempotencyKey,
      payload: action,
      prepare: async () => {
        const callerDepth = await writes.callerDepth(call);
        return {
          ok: true,
          parentDepth: callerDepth,
          write: async ({ uncertain }) =>
            agentActionToolResult({
              requestId: call.toolUseId ?? '',
              ...(await writes.write(action, call, {
                idempotencyKey,
                uncertain,
                callerDepth,
              })),
            }),
        };
      },
    });
  } catch (error) {
    return portErrorResponse(call, action.type, error);
  }
}

/**
 * The explicit-target project actions: discovery of projects, tasks and
 * chats, bounded reads of one chat, and the writes. Targets are canonical
 * IDs, kept through the dispatch envelope; the host authorizes them per
 * call. With `writes`, the project writes run behind the host's receipts
 * and limits (see {@link AgentProjectWrites}); without it, the port
 * dispatches them as it does every other action.
 */
export function createProjectActionFamily<H>(
  port: AgentProjectBotPort<H>,
  writes?: AgentProjectWrites<H>,
): AgentActionFamily<H> {
  return defineAgentActionFamily<H, ProjectAction>({
    id: 'projects',
    types: PROJECT_ACTION_TYPES,
    targetFields: ['projectId'],
    catalog: () => PROJECT_ACTION_CATALOG,
    supportedTypes: (capabilities) =>
      PROJECT_ACTION_TYPES.filter((type) =>
        capabilities.actionTypes.includes(type),
      ),
    actionSchema: projectActionSchema,
    dispatchJsonSchema: projectDispatchJsonSchema,
    dispatch: (action, call) => {
      const write = writes === undefined ? null : projectWrite(action);
      return write === null || writes === undefined
        ? dispatchProjectBotAction(action, port, call)
        : dispatchProjectWrite(write, writes, call);
    },
  });
}
