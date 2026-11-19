import type { AgentActionCall } from '../surface/family';

/**
 * This computer's "Sync lists to the web" switch, as an agent sees it.
 * `pausedReason` is set while the switch is on but uploads are held back;
 * `deleteStatus` reports the background removal of this computer's synced
 * lists from the web after the switch was turned off.
 */
export type AgentInventorySyncState = {
  enabled: boolean;
  allowIncoming: boolean;
  signedIn: boolean;
  syncing: boolean;
  pausedReason: 'allow_incoming_off' | null;
  deleteStatus: 'idle' | 'pending' | 'failed';
};

export type AgentInventorySyncWriteResult = {
  changed: boolean;
  stateAtCommit: AgentInventorySyncState;
};

export interface AgentInventorySyncPort<H> {
  getState(call: AgentActionCall<H>): Promise<AgentInventorySyncState>;
  /**
   * Turning the switch off removes this computer's lists from the web, so a
   * port must ask the person every time, whatever the chat's approval mode
   * or saved rules, and fail closed when it can't ask.
   */
  setEnabled(
    request: { enabled: boolean },
    call: AgentActionCall<H>,
  ): Promise<AgentInventorySyncWriteResult>;
}
