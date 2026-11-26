import { CLOUD_ACCOUNT_AUTHORITY_COMPOSITION_SELECTED } from '@canopy/core-runtime/node/cloud-account/activation';
import { cloudAccountEndpointAuthority } from '@canopy/protocol/canopy-core';
import { BRAND } from '@canopy/brand/current';
import { getCanopyCloudBaseUrl } from './config';
import {
  readCanopyCloudAccountWithStatus,
  peekCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import {
  isCanopyCloudSessionExpired,
  subscribeCanopyCloudSessionStatus,
} from './session-status';
import {
  createDaemonCloudAccountRoute,
  followAppCloudAccount,
  type DaemonCloudAccountClient,
} from './daemon-account-route';

/**
 * The app's daemon account provisioning (CAN-6997): every sign-in change of
 * this app reaches the daemons it is connected to, after the app's own store
 * committed it. Nothing here runs before account authority is selected.
 */
export const daemonCloudAccountRoute = createDaemonCloudAccountRoute({
  selected: CLOUD_ACCOUNT_AUTHORITY_COMPOSITION_SELECTED,
  credentialRejected: (apiKey) => {
    const current = peekCanopyCloudAccount();
    return current?.apiKey === apiKey && isCanopyCloudSessionExpired(current);
  },
  endpointAuthority: () =>
    cloudAccountEndpointAuthority({
      baseUrl: getCanopyCloudBaseUrl(),
      wellKnownNamespace: BRAND.web.wellKnownNamespace,
      apiNamespace: BRAND.web.apiNamespace,
    }),
  current: async () => {
    const read = await readCanopyCloudAccountWithStatus();
    // An unreadable store provisions nothing rather than a sign-out.
    if (read.status !== 'ok') throw read.error;
    return read.entry;
  },
});

if (CLOUD_ACCOUNT_AUTHORITY_COMPOSITION_SELECTED)
  followAppCloudAccount(daemonCloudAccountRoute, {
    subscribeCommits: subscribeCanopyCloudAccountChanges,
    subscribeSessionStatus: subscribeCanopyCloudSessionStatus,
    peek: peekCanopyCloudAccount,
  });

/** Whether launch admission may describe account routes as daemon-served. */
export function isDaemonCloudAccountAuthorityActive(
  client: DaemonCloudAccountClient,
): boolean {
  return daemonCloudAccountRoute.provisioned(client);
}

/** Settles verification before launch, without gating the client's sign-in. */
export function daemonCloudAccountAdmissionIdentity(
  client: DaemonCloudAccountClient,
): Promise<string | undefined> {
  return daemonCloudAccountRoute.admissionIdentity(client);
}
