import { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type OrgProjectOwnershipChangedEvent,
} from '@canopy/desktop-shared/types';
import { sendToWebContents } from '../lib/web-contents-send';
import { logMainProcessError } from '../lib/main-process-logging';

/** Both materialization and access-loss reuse the existing ownership event. */
export function broadcastOrgProjectOwnershipChanged(
  event: OrgProjectOwnershipChangedEvent,
): void {
  let failed = false;
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed())
        sendToWebContents(
          window.webContents,
          IPC_CHANNELS.orgProjectsOwnershipChanged,
          event,
        );
    } catch (error) {
      failed = true;
      logMainProcessError(
        'Could not deliver workspace ownership change:',
        error,
      );
    }
  }
  if (failed)
    throw new Error('Workspace ownership change delivery is incomplete');
}
