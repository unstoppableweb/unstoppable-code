import { allowsCloudAccount, allowsTelemetrySharing } from '@canopy/app-core';
import { useOptionalCanopyClient } from '@canopy/app-state';

/**
 * Whether this host offers hosted-account Sign in and Sign out. Off in a
 * local-only build through the `cloudAccount` capability, where account
 * surfaces drop their Sign in rows. Absent a client provider the
 * capability's default (allowed) applies.
 */
export function useCloudAccountAvailable(): boolean {
  const client = useOptionalCanopyClient();
  return client === null || allowsCloudAccount(client.capabilities);
}

/**
 * Whether this host shares usage data and syncs activity with hosted
 * services. Off in a local-only build through the `telemetrySharing`
 * capability, where Privacy shows no sharing controls. Absent a client
 * provider the capability's default (allowed) applies.
 */
export function useTelemetrySharingAvailable(): boolean {
  const client = useOptionalCanopyClient();
  return client === null || allowsTelemetrySharing(client.capabilities);
}
