import type {
  InstalledItemSnapshot,
  InstalledItemMutationResult,
  SetInstalledItemStatusRequest,
  UninstallInstalledItemRequest,
} from '@canopy/protocol/installed-items';
import { REMOTE_IPC_CHANNELS } from '@canopy/protocol/remote-control/channels';

/** Remote Control reaches these through the portable adapter (CAN-7442). */
export const INSTALLED_ITEM_CHANNELS = {
  LIST_STATUS: REMOTE_IPC_CHANNELS.installedItemsListStatus,
  SET_STATUS: REMOTE_IPC_CHANNELS.installedItemsSetStatus,
  UNINSTALL: REMOTE_IPC_CHANNELS.installedItemsUninstall,
  CHANGED: REMOTE_IPC_CHANNELS.installedItemsChanged,
} as const;

export interface InstalledItemsAPI {
  listStatus(): Promise<InstalledItemSnapshot>;
  setStatus(
    request: SetInstalledItemStatusRequest,
  ): Promise<InstalledItemMutationResult>;
  uninstall(
    request: UninstallInstalledItemRequest,
  ): Promise<InstalledItemMutationResult>;
  onChanged(callback: () => void): () => void;
}
