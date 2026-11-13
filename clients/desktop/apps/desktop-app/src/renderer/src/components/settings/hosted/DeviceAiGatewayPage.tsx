import { useMemo, type JSX } from 'react';
import {
  CenteredLoadingSpinner,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { SettingsHostProvider } from '@canopy/ui-app/settings/host';
import { AiGatewayEditor } from '@canopy/ui-app/settings/ai-gateway/AiGatewayEditor';
import {
  personalGatewayEditorConfig,
  usePersonalAiGatewayAdapter,
} from '@canopy/ui-app/settings/ai-gateway/ai-gateway-adapter';
import { createDeviceAiGatewaySettingsClient } from '@/client/device-ai-gateway-settings-client';
import {
  refreshLocalModelGateway,
  useLocalModelGateway,
} from '@/hooks/useLocalModelGateway';
import type { LocalModelGatewayState } from '@canopy/desktop-shared/types';
import { useDesktopStandaloneSettingsHost } from './DesktopSettingsHost';

/**
 * The AI gateway page while the account names no Personal organization
 * (signed out or a guest): the same shared editor as the account page, over
 * this device's gateway. Its config and key stay on this computer; signing in
 * moves them to an account that has no gateway yet.
 */
export function DeviceAiGatewayPage(): JSX.Element {
  const device = useLocalModelGateway();
  if (device === undefined) return <CenteredLoadingSpinner />;
  if (device === null)
    return (
      <ErrorBanner
        error="Couldn't load your AI gateway. Try again."
        onRetry={refreshLocalModelGateway}
      />
    );
  // The editor reads its config once. Remount when the gateway is set up or
  // removed elsewhere (first run, the agent), not on its own saves.
  const configured = device.gateway?.baseUrl ? 'configured' : 'empty';
  return (
    <DeviceAiGatewayEditor
      key={`${device.organizationId}/${configured}`}
      device={device}
    />
  );
}

function DeviceAiGatewayEditor({
  device,
}: {
  readonly device: LocalModelGatewayState;
}): JSX.Element {
  const client = useMemo(createDeviceAiGatewaySettingsClient, []);
  const host = useDesktopStandaloneSettingsHost(client);
  const adapter = usePersonalAiGatewayAdapter(client, device.organizationId);
  return (
    <SettingsHostProvider host={host}>
      <div data-testid="device-ai-gateway-page">
        <AiGatewayEditor
          adapter={adapter}
          initial={personalGatewayEditorConfig(device.gateway)}
        />
      </div>
    </SettingsHostProvider>
  );
}
