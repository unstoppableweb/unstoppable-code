import type { AgentActionResponse } from '../../response';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionFamily,
} from '../../surface/family';
import {
  SLACK_THREAD_ACTION_TYPES,
  slackThreadActionSchema,
  type SlackThreadAction,
} from './actions';
import { slackThreadActionCatalog } from './catalog';

/**
 * Host-owned reads of the Slack thread behind the current Slack tab's
 * request (CAN-7749). The host takes the tab from the call's runtime, never
 * from the model, and refuses outside a Slack tab.
 */
export interface SlackThreadPort<H> {
  read(
    input: { cursor?: string },
    call: AgentActionCall<H>,
  ): Promise<AgentActionResponse<string>>;
  openFile(
    input: { handle: string },
    call: AgentActionCall<H>,
  ): Promise<AgentActionResponse<string>>;
}

export function dispatchSlackThreadAction<H>(
  action: SlackThreadAction,
  port: SlackThreadPort<H>,
  call: AgentActionCall<H>,
): Promise<AgentActionResponse<string>> {
  if (action.type === 'slack_thread.read') {
    return port.read(
      action.cursor === undefined ? {} : { cursor: action.cursor },
      call,
    );
  }
  return port.openFile({ handle: action.handle }, call);
}

export function createSlackThreadActionFamily<H>(
  port: SlackThreadPort<H>,
): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'slack-thread',
    types: SLACK_THREAD_ACTION_TYPES,
    actionSchema: slackThreadActionSchema,
    catalog: () => slackThreadActionCatalog,
    supportedTypes: (capabilities) =>
      SLACK_THREAD_ACTION_TYPES.filter((type) =>
        capabilities.actionTypes.includes(type),
      ),
    dispatch: (action, call) => dispatchSlackThreadAction(action, port, call),
  });
}
