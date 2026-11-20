import {
  isDeviceRelayInstallId,
  type DeviceRelayTokenRequest,
} from '@canopy/protocol/device-relay';

async function readInstallIdOrNull(
  readInstallId: () => Promise<string>,
): Promise<string | null> {
  try {
    // `await` inside the try also catches a reader that throws synchronously.
    return await readInstallId();
  } catch {
    return null;
  }
}

/**
 * The relay token request body. Carries the install ID the catalog stores as
 * `WorkspaceInstance.deviceId`, so web can show this computer online from
 * relay presence (CAN-7214). The ID is sent only when UUID-shaped, lowercased;
 * a failed or legacy-shaped read omits it and never fails the fetch.
 */
export async function buildRelayTokenRequest(
  deviceId: string,
  readInstallId: () => Promise<string>,
): Promise<DeviceRelayTokenRequest> {
  const installId = await readInstallIdOrNull(readInstallId);
  return isDeviceRelayInstallId(installId)
    ? { deviceId, installId: installId.toLowerCase() }
    : { deviceId };
}
