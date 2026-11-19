import { bumpGlobalPluginDefaultsRevision } from '../plugins/plugin-defaults-revision';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import { broadcastPreferencesChanged } from '../lib/preferences-broadcast';
import { sendToAllWindows } from '../lib/window-send';

export const INSTALLED_ITEMS_CHANGED_CHANNEL = 'installed-items:changed';
export function notifyInstalledItemsChanged(): void {
  bumpGlobalPluginDefaultsRevision();
  refreshInvocableInventoryAfterMutation('installed-items');
  broadcastPreferencesChanged();
  notifyDesktopInventoryChanged(['installed_items']);
  sendToAllWindows(INSTALLED_ITEMS_CHANGED_CHANNEL);
}
