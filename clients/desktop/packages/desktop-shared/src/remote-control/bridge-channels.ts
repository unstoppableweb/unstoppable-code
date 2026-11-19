import type { CoworkFolderMissing } from '@canopy/protocol/canopy-core';
import type { RemoteOperationFailure } from '@canopy/protocol/remote-control';

/**
 * Private channels between the controlled computer's main process and the
 * hidden bridge window that replays a controller's IPC calls through the
 * real handlers. Never exposed to app renderers.
 */
export const REMOTE_BRIDGE_CHANNELS = {
  ready: 'remote-bridge:ready',
  invoke: 'remote-bridge:invoke',
  post: 'remote-bridge:post',
  result: 'remote-bridge:result',
} as const;

export interface RemoteBridgeInvokeMessage {
  id: number;
  channel: string;
  args: unknown[];
}

export interface RemoteBridgePostMessage {
  channel: string;
  args: unknown[];
}

export type RemoteBridgeResultMessage =
  | { id: number; ok: true; value: unknown }
  | {
      id: number;
      ok: false;
      message: string;
      coworkFolderMissing?: CoworkFolderMissing;
      operationFailure?: RemoteOperationFailure;
    };
