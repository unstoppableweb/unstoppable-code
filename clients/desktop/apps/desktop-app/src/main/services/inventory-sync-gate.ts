/**
 * The inventory sync gate (CAN-5986). Desktop inventory pushes only while
 * Allow incoming and this device's inventory sync switch are both on; the
 * service itself waits for cloud credentials. No feature flag and no Labs
 * switch is read. Main applies it from the Remote Control state at start-up
 * and on every state change, and the gate stays closed until the first
 * state read.
 *
 * Allow incoming off pauses uploads and keeps the server documents. Only the
 * confirmed switch deletes them (see `DesktopInventorySyncService.optOut`).
 *
 * The gate also reports a three-state upload status (CAN-7262), so the
 * service can tell the web a computer is paused: `off` (switch off),
 * `paused` (switch on, Allow incoming off) or `syncing` (both on). It is
 * never a boolean, so "switch off" is never read as "unpaused".
 */
import type { RemoteInventorySyncChange } from '../remote-control/remote-control-service';
import type {
  DesktopInventoryDeleteHooks,
  DesktopInventoryDeleteStatus,
  DesktopInventoryUploadStatus,
} from './desktop-inventory-sync-service';

export interface InventorySyncGateInputs {
  allowIncoming: boolean;
  inventorySyncEnabled: boolean;
}

interface InventorySyncGatedService {
  setGateOpen(open: boolean): void;
  setUploadStatus(status: DesktopInventoryUploadStatus): void;
}

export function inventoryUploadStatus(
  inputs: InventorySyncGateInputs,
): DesktopInventoryUploadStatus {
  if (!inputs.inventorySyncEnabled) return 'off';
  return inputs.allowIncoming ? 'syncing' : 'paused';
}

export function applyInventorySyncGate(
  inputs: InventorySyncGateInputs,
  service: InventorySyncGatedService,
): void {
  service.setGateOpen(inputs.allowIncoming && inputs.inventorySyncEnabled);
  service.setUploadStatus(inventoryUploadStatus(inputs));
}

/** The Remote Control side of the opt-out delete, as main wires it. */
export interface InventorySyncRemoteControl {
  /** Every key form a pending delete may be saved under; empty signed out. */
  inventoryAccountKeys(): readonly string[];
  clearInventoryDeletePending(accountKeys: readonly string[]): Promise<void>;
  setInventoryDeleteStatus(status: DesktopInventoryDeleteStatus): void;
}

/**
 * The delete hooks main gives the inventory service: the signed-in
 * account's every key form (remembered forms included, so a delete queued
 * under either form matches), and the marker and status back into Remote
 * Control. `remoteControl` is null before Remote Control starts.
 */
export function inventorySyncDeleteHooks(
  remoteControl: () => InventorySyncRemoteControl | null,
): DesktopInventoryDeleteHooks {
  return {
    currentAccountKeys: (): readonly string[] =>
      remoteControl()?.inventoryAccountKeys() ?? [],
    onDeleteSucceeded: async (
      accountKeys: readonly string[],
    ): Promise<void> => {
      await remoteControl()?.clearInventoryDeletePending(accountKeys);
    },
    onDeleteStatusChanged: (status): void => {
      remoteControl()?.setInventoryDeleteStatus(status);
    },
  };
}

interface InventorySyncSettingTarget extends InventorySyncGatedService {
  restorePendingDelete(accountKeys: readonly string[]): void;
  optIn(keepDeleteFor: readonly string[]): Promise<void>;
  optOut(accountKeys: readonly string[]): Promise<void>;
}

/**
 * Applies one inventory sync setting change from Remote Control: the first
 * settings read opens or closes the gate and restores a persisted delete;
 * a user change opts in or out.
 */
export function applyInventorySyncSettingChange(
  change: RemoteInventorySyncChange,
  inventory: InventorySyncSettingTarget,
  logError: (message: string, error: unknown) => void,
): void {
  if (change.cause === 'loaded') {
    applyInventorySyncGate(change, inventory);
    inventory.restorePendingDelete(change.deletePendingForUserIds);
    return;
  }
  if (change.inventorySyncEnabled) {
    void inventory
      .optIn(change.deletePendingForUserIds)
      .catch((error: unknown) => {
        logError('Inventory sync could not resume', error);
      });
    return;
  }
  void inventory
    .optOut(change.deletePendingForUserIds)
    .catch((error: unknown) => {
      logError('Inventory sync opt-out failed', error);
    });
}
