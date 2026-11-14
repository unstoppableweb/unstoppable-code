import { useEffect } from 'react';
import { showDeviceAiGatewayConflictToast } from '@/lib/deviceAiGatewayConflict';

/**
 * Shows the sign-in conflict toast whenever main reports that the account
 * kept its own AI gateway. Mounted once in the app shell; renders nothing.
 */
export function DeviceAiGatewayConflictNotice(): null {
  useEffect(
    () =>
      window.api.localModelGateway.onMigrationConflict(
        showDeviceAiGatewayConflictToast,
      ),
    [],
  );
  return null;
}
