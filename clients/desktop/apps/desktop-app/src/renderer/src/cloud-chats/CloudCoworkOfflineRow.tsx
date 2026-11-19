import type { JSX } from 'react';
import { SidebarOfflineRow } from '@canopy/ui-app/sidebar';
import type { CloudCoworkSidebarModel } from './useCloudCoworkSidebar';

/**
 * The row cloud projects show while the web core is offline (CAN-4185 D7).
 * Cloud projects are rows of the shared sidebar list (CAN-6099); offline, the
 * ones last listed stay there, as on the web (CAN-6374).
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
