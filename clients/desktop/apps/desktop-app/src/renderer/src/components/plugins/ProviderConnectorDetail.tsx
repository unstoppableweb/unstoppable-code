import type { JSX } from 'react';
import {
  ProviderConnectorDetail as ProviderConnectorDetailCore,
  type ProviderConnectorDetailProps as CoreProps,
} from '@canopy/ui-app';
import { brandText } from '@/lib/brand';
import { useIsPageAvailable } from '@/lib/navigation/page-availability';
import { useNavigationStore } from '@/stores/navigationStore';
import { McpServerLogo } from '../shared/McpServerLogo';

type ProviderConnectorDetailProps = Omit<
  CoreProps,
  | 'appName'
  | 'onOpenProviderSettings'
  | 'onManageConnections'
  | 'McpServerLogoComponent'
> & {
  /**
   * Fires once the provider's connector settings opened for a route, before
   * the link is confirmed. An integration card uses it to install the plugin
   * folded into it as soon as the user starts down this route (REG-3033).
   */
  onConnectStarted?: () => void;
};

/** Desktop host for the shared connector detail: brand name + settings IPC. */
export function ProviderConnectorDetail({
  onConnectStarted,
  ...props
}: ProviderConnectorDetailProps): JSX.Element {
  const canManageConnections = useIsPageAvailable('plugins');
  const navigate = useNavigationStore((state) => state.navigate);
  return (
    <ProviderConnectorDetailCore
      {...props}
      appName={brandText.appName}
      onManageConnections={
        canManageConnections
          ? () => navigate('mcp-account-connections')
          : undefined
      }
      // Resolves remote catalog artwork, matching the connector's card.
      McpServerLogoComponent={McpServerLogo}
      onOpenProviderSettings={async (request) => {
        await window.mcpServers.openProviderConnectorSettings(request);
        onConnectStarted?.();
      }}
    />
  );
}
