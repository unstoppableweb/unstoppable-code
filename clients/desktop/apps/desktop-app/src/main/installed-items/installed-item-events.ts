import { bumpGlobalPluginDefaultsRevision } from '../plugins/plugin-defaults-revision';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import { broadcastPreferencesChanged } from '../lib/preferences-broadcast';
import { sendToAllWindows } from '../lib/window-send';
import { INSTALLED_ITEM_CHANNELS } from '@canopy/desktop-shared/types/installed-items';

// Sent to every window, including the main window whose pushes Remote
// Control forwards to controllers.
export const INSTALLED_ITEMS_CHANGED_CHANNEL = INSTALLED_ITEM_CHANNELS.CHANGED;
export function notifyInstalledItemsChanged(): void {
  bumpGlobalPluginDefaultsRevision();
  refreshInvocableInventoryAfterMutation('installed-items');
  broadcastPreferencesChanged();
  notifyDesktopInventoryChanged(['installed_items']);
  sendToAllWindows(INSTALLED_ITEMS_CHANGED_CHANNEL);
}
