import type { JSX } from 'react';
import {
  ClaudeConnectorRoutingGuidance,
  type ClaudeConnectorSettingsRoute,
} from '@canopy/ui-app';
import { brandText } from '@/lib/brand';
import { useIsPageAvailable } from '@/lib/navigation/page-availability';
import { useNavigationStore } from '@/stores/navigationStore';

export function ClaudeConnectorRoutingSettingNote({
  route,
}: {
  route: ClaudeConnectorSettingsRoute;
}): JSX.Element {
  const canManageConnections = useIsPageAvailable('plugins');
  const navigate = useNavigationStore((state) => state.navigate);
  return (
    <ClaudeConnectorRoutingGuidance
      appName={brandText.appName}
      route={route}
      onManageConnections={
        canManageConnections
          ? () => navigate('mcp-account-connections')
          : undefined
      }
    />
  );
}
