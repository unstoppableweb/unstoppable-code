import type { JSX } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { Notice } from './Notice';

export interface SyncedInventoryPausedNoticeProps {
  /** The synced computer's name; `null` or blank reads "this computer". */
  readonly deviceName: string | null;
}

/**
 * The copy for a synced inventory whose desktop holds its uploads back
 * (CAN-7262). The web counterpart of the desktop's `INVENTORY_SYNC_PAUSED`
 * helper in Settings → Remote Control (`RemoteAccessTab.tsx`).
 */
export function syncedInventoryPausedMessage(
  deviceName: string | null,
): string {
  const name = deviceName?.trim() ? deviceName.trim() : 'this computer';
  return `Lists from ${name} may be out of date. Syncing is paused while ${REMOTE_CONTROL_LABEL} is off.`;
}

/**
 * Says the lists shown came from a computer that has paused syncing, so they
 * may be out of date. Mounted only where synced (not live) lists are shown.
 * The computer name is plain text and may be up to 256 characters, so the
 * copy wraps anywhere rather than widening a menu or dialog.
 */
export function SyncedInventoryPausedNotice({
  deviceName,
}: SyncedInventoryPausedNoticeProps): JSX.Element {
  return (
    <Notice
      intent="neutral"
      role="none"
      data-testid="synced-inventory-paused-notice"
    >
      <span className="min-w-0 break-words">
        {syncedInventoryPausedMessage(deviceName)}
      </span>
    </Notice>
  );
}
