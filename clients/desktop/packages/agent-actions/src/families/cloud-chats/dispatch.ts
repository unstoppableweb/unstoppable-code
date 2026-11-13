import type { AgentActionResponse } from '../../response';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionFamily,
} from '../../surface/family';
import {
  CLOUD_CHAT_ACTION_TYPES,
  cloudChatActionSchema,
  type CloudChatAction,
} from './actions';
import { cloudChatActionCatalog } from './catalog';

/**
 * Host-owned reads of the cloud chats a window already shows. This port
 * grants no access to the web core: it answers from what the window loaded.
 */
export interface CloudChatsPort<H> {
  list(call: AgentActionCall<H>): Promise<AgentActionResponse<string>>;
  open(
    input: { chatId: string },
    call: AgentActionCall<H>,
  ): Promise<AgentActionResponse<string>>;
}

export function dispatchCloudChatsAction<H>(
  action: CloudChatAction,
  port: CloudChatsPort<H>,
  call: AgentActionCall<H>,
): Promise<AgentActionResponse<string>> {
  return action.type === 'cloud_chats.list'
    ? port.list(call)
    : port.open({ chatId: action.chatId }, call);
}

export function createCloudChatsActionFamily<H>(
  port: CloudChatsPort<H>,
): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'cloud-chats',
    types: CLOUD_CHAT_ACTION_TYPES,
    actionSchema: cloudChatActionSchema,
    catalog: () => cloudChatActionCatalog,
    supportedTypes: (capabilities) =>
      CLOUD_CHAT_ACTION_TYPES.filter((type) =>
        capabilities.actionTypes.includes(type),
      ),
    dispatch: (action, call) => dispatchCloudChatsAction(action, port, call),
  });
}
