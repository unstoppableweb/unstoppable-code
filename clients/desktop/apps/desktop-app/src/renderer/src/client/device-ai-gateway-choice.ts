import type { DeviceAiGatewayChoicePort } from '@canopy/ui-app/settings/host';
import { SettingsOperationError } from '@canopy/protocol/settings';
import type { LocalModelGatewayResult } from '@canopy/desktop-shared/types';

async function settle<T>(
  result: Promise<LocalModelGatewayResult<T>>,
): Promise<T> {
  const response = await result;
  if (!response.ok) throw new SettingsOperationError(response.error);
  return response.value;
}

/**
 * The sign-in choice between the account's AI gateway and the one set up on
 * this computer while signed out, which main keeps until the user decides.
 */
export const desktopDeviceAiGatewayChoice: DeviceAiGatewayChoicePort = {
  read: () => settle(window.api.localModelGateway.readMigrationChoice()),
  choose: async (decision, accountRevision) => {
    await settle(
      window.api.localModelGateway.chooseMigration(decision, accountRevision),
    );
  },
};
