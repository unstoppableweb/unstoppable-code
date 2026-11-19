import type { AgentProjectBotPort } from '../../port/project-bot-port';
import {
  defineAgentActionFamily,
  type AgentActionFamily,
  type AgentActionFamilyJsonSchema,
} from '../../surface/family';
import {
  dispatchProjectBotAction,
  PROJECT_READ_JSON_PROPERTIES,
  requireFieldsFor,
} from '../projects';
import { PROJECT_DISCOVERY_ID_MAX } from '../projects/actions';
import { BOT_ACTION_TYPES, botActionSchema, type BotAction } from './actions';
import { BOT_ACTION_CATALOG, BOT_REGISTRY_ACTION_CATALOG } from './catalog';

export {
  APP_ADVISOR_BOT_ID,
  BOT_ACTION_TYPES,
  botActionSchema,
  type BotAction,
  type BotActionType,
} from './actions';
export { BOT_ACTION_CATALOG } from './catalog';

/** The bots family's share of the advertised DispatchAction payload. */
export const botDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    botId: {
      type: 'string',
      minLength: 1,
      maxLength: PROJECT_DISCOVERY_ID_MAX,
      description:
        'Public bot ID from bots.list, such as app_advisor; never an internal project ID.',
    },
    ...PROJECT_READ_JSON_PROPERTIES,
  },
  allOf: [
    requireFieldsFor(['bots.list_tasks', 'bots.list_task_chats'], ['botId']),
    requireFieldsFor(
      ['bots.send_message'],
      ['botId', 'taskId', 'chatId', 'text'],
    ),
    requireFieldsFor(['bots.create_task'], ['botId']),
    requireFieldsFor(
      ['bots.create_task_chat'],
      ['botId', 'taskId', 'initialMessage'],
    ),
    requireFieldsFor(
      [
        'bots.get_last_user_message',
        'bots.get_last_agent_response',
        'bots.read_history',
      ],
      ['botId', 'taskId', 'chatId'],
    ),
  ],
};

const botRegistryDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  ...botDispatchJsonSchema,
  properties: {
    ...botDispatchJsonSchema.properties,
    pinnedToProjectId: {
      type: 'string',
      minLength: 1,
      maxLength: PROJECT_DISCOVERY_ID_MAX,
      description: 'Filter bots to those pinned to this canonical project ID.',
    },
  },
};

/**
 * The bot actions: discovery of bots, their tasks and chats, and bounded
 * reads of one chat. Hosts offer them only while the caller's bot access is
 * on and recheck it on every call.
 */
export function createBotActionFamily<H>(
  port: AgentProjectBotPort<H>,
): AgentActionFamily<H> {
  return defineAgentActionFamily<H, BotAction>({
    id: 'bots',
    types: BOT_ACTION_TYPES,
    // Explicit bot targets: the envelope strips no scope field.
    targetFields: [],
    catalog: (_brand, capabilities) =>
      capabilities?.botsRegistry === true
        ? BOT_REGISTRY_ACTION_CATALOG
        : BOT_ACTION_CATALOG,
    supportedTypes: (capabilities) =>
      BOT_ACTION_TYPES.filter((type) =>
        capabilities.actionTypes.includes(type),
      ),
    actionSchema: botActionSchema,
    dispatchJsonSchema: (capabilities) =>
      capabilities?.botsRegistry === true
        ? botRegistryDispatchJsonSchema
        : botDispatchJsonSchema,
    dispatch: (action, call) => dispatchProjectBotAction(action, port, call),
  });
}
