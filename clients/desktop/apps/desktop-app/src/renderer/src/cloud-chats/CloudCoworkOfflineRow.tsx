import type { JSX } from 'react';
import { SidebarOfflineRow } from '@canopy/ui-app/sidebar';
import type { CloudCoworkSidebarModel } from './useCloudCoworkSidebar';

/**
 * The one row cloud projects leave while the web core is offline (CAN-4185
 * D7). Online cloud projects are rows of the shared sidebar list (CAN-6099).
 */
export function CloudCoworkOfflineRow({
  model,
}: {
  model: CloudCoworkSidebarModel;
}): JSX.Element | null {
  if (model.status !== 'offline') return null;
  return (
    <SidebarOfflineRow
      label="Cloud chats are offline"
      onReconnect={model.reconnect}
      data-testid="sidebar-cloud-cowork-offline"
      reconnectTestId="sidebar-cloud-cowork-reconnect"
    />
  );
}
