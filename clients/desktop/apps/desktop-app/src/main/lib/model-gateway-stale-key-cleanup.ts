import { createHash } from 'node:crypto';
import { normalizeModelGatewayBaseUrl } from '@canopy/protocol/canopy-server';
import { normalizeUuid } from '@canopy/protocol/workspace-owner';
import {
  peekCanopyCloudAccount,
  peekCanopyCloudAccountId,
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
  subscribeCanopyCloudAccountConfirmations,
  type CanopyCloudAccountEntry,
} from './canopy-cloud-account-store';
import { logMainProcessWarn } from './main-process-logging';

export interface StaleGatewayEndpoint {
  accountId: string;
  organizationId: string;
  /** Fingerprint of the URL the gateway left; see {@link gatewayUrlFingerprint}. */
  baseUrlFingerprint: string;
}

type GatewayEntry = Pick<
  CanopyCloudAccountEntry,
  | 'account'
  | 'personalOrganizationId'
  | 'personalModelGatewayConfig'
  | 'organizationModelGatewayConfigs'
>;

/**
 * The fingerprint the account reports for an organization gateway's URL: the
 * lowercase hex SHA-256 of the normalized URL, or null for an unusable URL.
 */
export function gatewayUrlFingerprint(baseUrl: string): string | null {
  const normalized = normalizeModelGatewayBaseUrl(baseUrl);
  return normalized === null
    ? null
    : createHash('sha256').update(normalized).digest('hex');
}

/**
 * Each organization's saved gateway URL fingerprint, as the configuration
 * fields of `entry` report it. An entry cached before those fields reports
 * none, so the first refresh after an upgrade deletes nothing.
 */
function savedFingerprints(entry: GatewayEntry): Map<string, string> {
  const fingerprints = new Map<string, string>();
  const personal = entry.personalModelGatewayConfig;
  const personalId = normalizeUuid(personal?.organizationId);
  const personalFingerprint = personal?.baseUrl
    ? gatewayUrlFingerprint(personal.baseUrl)
    : null;
  if (personalId && personalFingerprint)
    fingerprints.set(personalId, personalFingerprint);
  entry.organizationModelGatewayConfigs?.forEach((config) => {
    const id = normalizeUuid(config.organizationId);
    if (id && config.configured && config.baseUrlFingerprint)
      fingerprints.set(id, config.baseUrlFingerprint);
  });
  return fingerprints;
}

/**
 * The URL fingerprint `next` reports for an organization: a string, `null`
 * when it reports no gateway there, or `undefined` when it cannot say (an
 * older server).
 */
export function reportedGatewayFingerprint(
  next: GatewayEntry,
  organizationId: string,
): string | null | undefined {
  if (organizationId === normalizeUuid(next.personalOrganizationId)) {
    const config = next.personalModelGatewayConfig;
    if (!config) return undefined;
    return config.baseUrl ? gatewayUrlFingerprint(config.baseUrl) : null;
  }
  const configs = next.organizationModelGatewayConfigs;
  if (!configs) return undefined;
  const config = configs.find(
    (candidate) => normalizeUuid(candidate.organizationId) === organizationId,
  );
  return config?.configured ? (config.baseUrlFingerprint ?? null) : null;
}

/**
 * Keys this computer should delete when the account moves from `previous` to
 * `next`: for each gateway the account reports as removed or moved, the keys
 * saved for the URL it left. Turning a gateway off keeps its URL, and so its
 * keys. Only an observed move counts, so a key saved for a gateway that is
 * still being set up, before its URL reaches the account, is never deleted.
 */
export function planStaleGatewayKeyCleanup(
  previous: GatewayEntry | null,
  next: GatewayEntry | null,
): StaleGatewayEndpoint[] {
  const accountId = next?.account?.id.trim();
  if (!previous || !next || !accountId) return [];
  if (previous.account?.id.trim() !== accountId) return [];
  const stale: StaleGatewayEndpoint[] = [];
  savedFingerprints(previous).forEach((baseUrlFingerprint, organizationId) => {
    const reported = reportedGatewayFingerprint(next, organizationId);
    if (reported !== undefined && reported !== baseUrlFingerprint)
      stale.push({ accountId, organizationId, baseUrlFingerprint });
  });
  return stale;
}

async function clearStaleEndpoint(
  endpoint: StaleGatewayEndpoint,
): Promise<void> {
  const { clearModelGatewayCredentialForRemovedGateway } =
    await import('../ipc/settings');
  await clearModelGatewayCredentialForRemovedGateway(
    endpoint.organizationId,
    endpoint.accountId,
    endpoint.baseUrlFingerprint,
  );
}

async function initialEntry(): Promise<CanopyCloudAccountEntry | null> {
  if (peekCanopyCloudAccountId() !== undefined) return peekCanopyCloudAccount();
  const read = await readCanopyCloudAccountWithStatus();
  return read.status === 'ok' ? read.entry : null;
}

/**
 * Delete keys for gateways the account stops reporting at their saved URL,
 * whichever device or the web made the change. Compares each account update
 * with the one before it, starting from the stored account: the account cache
 * persists the last configuration it saw, so a change made while the app was
 * closed is seen at the first refresh. A clear that fails is tried again at
 * the next account update or confirmed refresh; the clear itself keeps the key
 * if the gateway has come back to that URL by then.
 */
export function startModelGatewayStaleKeyCleanup(
  clear: (endpoint: StaleGatewayEndpoint) => Promise<void> = clearStaleEndpoint,
): () => void {
  let latest: Promise<GatewayEntry | null> = initialEntry().catch(() => null);
  const pending = new Map<string, StaleGatewayEndpoint>();
  const attempt = async (
    endpoints: readonly StaleGatewayEndpoint[],
  ): Promise<void> => {
    for (const endpoint of endpoints) {
      const key = JSON.stringify([
        endpoint.accountId,
        endpoint.organizationId,
        endpoint.baseUrlFingerprint,
      ]);
      try {
        await clear(endpoint);
        pending.delete(key);
      } catch (error) {
        pending.set(key, endpoint);
        logMainProcessWarn('[model-gateway] Stale gateway key clear failed', {
          organizationId: endpoint.organizationId,
          errorName:
            error instanceof Error ? error.constructor.name : typeof error,
        });
      }
    }
  };
  const unsubscribeChanges = subscribeCanopyCloudAccountChanges((next) => {
    latest = latest.then(async (previous) => {
      await attempt([
        ...pending.values(),
        ...planStaleGatewayKeyCleanup(previous, next),
      ]);
      return next;
    });
  });
  const unsubscribeConfirmations = subscribeCanopyCloudAccountConfirmations(
    () => {
      if (pending.size === 0) return;
      latest = latest.then(async (previous) => {
        await attempt([...pending.values()]);
        return previous;
      });
    },
  );
  return (): void => {
    unsubscribeChanges();
    unsubscribeConfirmations();
  };
}
