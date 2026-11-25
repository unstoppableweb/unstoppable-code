import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useLocalModelGateway } from '@/hooks/useLocalModelGateway';

/**
 * Whether the signed-out AI gateway page is offered: the flag decides who can
 * set a device gateway up, and one already saved stays visible and
 * switchable without it (or before the flag answers), because routing
 * ignores the flag. Signed in, the account's settings bootstrap decides.
 */
export function useDeviceAiGatewaySettingsAvailable(): boolean {
  const flag = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.key),
  );
  const device = useLocalModelGateway();
  return flag || Boolean(device?.gateway?.baseUrl);
}
