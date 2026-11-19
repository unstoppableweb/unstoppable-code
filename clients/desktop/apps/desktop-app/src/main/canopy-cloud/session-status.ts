import {
  CloudAccountSessionStatus,
  type CloudAccountSessionProbe,
} from '@canopy/core-runtime/node/cloud-account';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import type { CanopyCloudAccountEntry } from '../lib/canopy-cloud-account-store';

/** Process-local fences. Neither these tokens nor credentials cross IPC. */
export type CanopyCloudSessionProbe = CloudAccountSessionProbe;

type Credential = Pick<
  CanopyCloudAccountEntry,
  'apiKey' | 'authMode' | 'credentialSource' | 'serverApiKeyId'
> & { accountId?: string };

const status = new CloudAccountSessionStatus<
  CanopyCloudAccountEntry,
  Credential
>(
  (entry) =>
    entry.apiKey.trim().length > 0 && !isGuestAccount(entry)
      ? {
          apiKey: entry.apiKey,
          authMode: entry.authMode,
          credentialSource: entry.credentialSource,
          serverApiKeyId: entry.serverApiKeyId,
          accountId: entry.account?.id,
        }
      : null,
  (rejected, current) =>
    rejected.apiKey === current.apiKey &&
    rejected.authMode === current.authMode &&
    rejected.credentialSource === current.credentialSource &&
    rejected.serverApiKeyId === current.serverApiKeyId &&
    rejected.accountId === current.accountId,
);

export function beginCanopyCloudSessionProbe(): CanopyCloudSessionProbe {
  return status.begin();
}

export function isCurrentCanopyCloudSessionProbe(
  probe: CanopyCloudSessionProbe,
): boolean {
  return status.isCurrent(probe);
}

export function isCanopyCloudSessionProbeSuperseded(
  probe: CanopyCloudSessionProbe,
): boolean {
  return status.isSuperseded(probe);
}

/** Called only inside the account store's matched, serialized boundary. */
export function recordCanopyCloudSessionProbe(
  probe: CanopyCloudSessionProbe,
  entry: CanopyCloudAccountEntry,
  outcome: 'accepted' | 'rejected',
): void {
  status.record(probe, entry, outcome);
}

/** After readable credential state changes, including same-key replacement. */
export function resetCanopyCloudSessionCredential(): void {
  status.resetCredential();
}

export function isCanopyCloudSessionExpired(
  entry: CanopyCloudAccountEntry | null,
): boolean {
  return status.isExpired(entry);
}

export function subscribeCanopyCloudSessionStatus(
  listener: () => void,
): () => void {
  return status.addListener(listener);
}
