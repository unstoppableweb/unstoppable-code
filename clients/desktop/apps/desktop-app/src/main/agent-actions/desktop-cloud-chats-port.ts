import {
  dispatchCloudChatsAction,
  type CloudChatsPort,
} from '@canopy/agent-actions/families/cloud-chats/dispatch';
import type { CloudChatAction } from '@canopy/agent-actions/families/cloud-chats/actions';
import type { AgentActionResponse } from '@canopy/agent-actions';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import { presentAppAdvisorAction } from '../app-advisor/presentation-tools';
import type { AppAdvisorToolRuntime } from '../app-advisor/runtime';

/**
 * App Advisor's cloud chats port (CAN-5974). The main window answers through
 * its presentation lease, from the cloud chats its sidebar already loaded
 * from the web core; nothing here reaches the web core.
 */
export function dispatchDesktopCloudChats(
  action: CloudChatAction,
  runtime: AppAdvisorToolRuntime,
  options: {
    requestId: string;
    expectedUiRevision?: number;
    boundTools?: readonly InterfaceToolName[];
    signal?: AbortSignal;
  },
): Promise<AgentActionResponse<string>> {
  const present = async (
    presented: CloudChatAction,
  ): Promise<AppAdvisorActionResponse> =>
    presentAppAdvisorAction({
      action: presented,
      requestId: options.requestId,
      ...(options.expectedUiRevision !== undefined
        ? { expectedUiRevision: options.expectedUiRevision }
        : {}),
      destination: runtime.watcherDestination,
      boundTools: options.boundTools ?? (await runtime.boundInterfaceTools()),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  const port: CloudChatsPort<AppAdvisorToolRuntime> = {
    list: () => present({ type: 'cloud_chats.list' }),
    open: (input) => present({ type: 'cloud_chats.open', ...input }),
  };
  return dispatchCloudChatsAction(action, port, {
    host: runtime,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
