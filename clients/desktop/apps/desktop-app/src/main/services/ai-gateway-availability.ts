import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { accountUsesDeviceModelGateway } from '@canopy/desktop-shared/lib/org-model-gateway';
import { getFeatureFlagService } from '../feature-flags';
import { peekCanopyCloudAccount } from '../lib/canopy-cloud-account-store';
import { hasCachedLocalModelGatewayConfig } from '../lib/local-model-gateway-store';

/**
 * Whether AI gateway settings are offered on this computer, for the person
 * and for agents alike: the flag decides who can set a gateway up, and a
 * gateway already routing stays reachable without it (routing ignores the
 * flag). That is the account's projected Personal gateway, or this device's
 * saved gateway while the account names no Personal organization. Reads only
 * cached state; hosted gateway operations are also gated by the web.
 */
export function aiGatewaySettingsAvailable(): boolean {
  if (
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.key,
    )
  )
    return true;
  const account = peekCanopyCloudAccount();
  return accountUsesDeviceModelGateway(account)
    ? hasCachedLocalModelGatewayConfig()
    : account?.personalModelGateway !== undefined;
}
