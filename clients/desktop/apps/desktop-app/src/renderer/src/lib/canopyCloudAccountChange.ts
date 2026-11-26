import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { clearRecentUserVisibleError } from '@canopy/ui-shared/lib';

/**
 * Why `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT` fired, as an additive
 * `CustomEvent` detail (CAN-4061). A plain legacy `Event` reads as `unknown`.
 *
 * - `identity`: sign-in, sign-out, or account/credential replacement.
 * - `same-account-refresh`: account data refreshed; identity confirmed.
 * - `refresh-failed`: the re-probe failed with no evidence of a change.
 */
export type CanopyCloudAccountChangeReason =
  | 'identity'
  | 'same-account-refresh'
  | 'refresh-failed';

/** Omit `reason` only when it is genuinely unknown. */
export function announceCanopyCloudAccountChanged(
  reason?: CanopyCloudAccountChangeReason,
): void {
  window.dispatchEvent(
    reason === undefined
      ? new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT)
      : new CustomEvent(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, {
          detail: { reason },
        }),
  );
}

export function readCanopyCloudAccountChangeReason(
  event: Event,
): CanopyCloudAccountChangeReason | 'unknown' {
  if (!(event instanceof CustomEvent)) return 'unknown';
  const detail: unknown = event.detail;
  const reason: unknown =
    typeof detail === 'object' && detail !== null
      ? Reflect.get(detail, 'reason')
      : undefined;
  return reason === 'identity' ||
    reason === 'same-account-refresh' ||
    reason === 'refresh-failed'
    ? reason
    : 'unknown';
}

/** Whether account-scoped caches must drop what this notification may have orphaned. */
export function mayChangeCanopyCloudIdentity(event: Event): boolean {
  const reason = readCanopyCloudAccountChangeReason(event);
  return reason === 'identity' || reason === 'unknown';
}

/**
 * Stable identity of an authoritative read; `null` when it proves none.
 * `createdAt` is the sign-in session: logins restamp it, re-probes keep it.
 */
export function canopyCloudAccountIdentity(
  state: CanopyCloudAccountPublicState | null | undefined,
): string | null {
  if (!state || (state.read !== undefined && state.read !== 'ok')) return null;
  if (!state.hasApiKey) return 'signed-out';
  const accountId = state.account?.id ?? null;
  const serverApiKeyId = state.serverApiKeyId ?? null;
  if (accountId === null && serverApiKeyId === null) return null;
  return JSON.stringify([
    state.authMode,
    state.credentialSource,
    accountId,
    serverApiKeyId,
    state.createdAt ?? null,
  ]);
}

// Fences a refresh that straddled an identity notification in this window.
// Other windows are fenced by comparing both ends against main's account.
let identityGeneration = 0;

if (
  typeof window !== 'undefined' &&
  typeof window.addEventListener === 'function'
) {
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, (event): void => {
    if (mayChangeCanopyCloudIdentity(event)) {
      identityGeneration += 1;
      clearRecentUserVisibleError();
    }
  });
}

type RefreshedReason = CanopyCloudAccountChangeReason | undefined;

export type CanopyCloudAccountRefreshOutcome =
  | {
      readonly status: 'refreshed';
      /** `undefined`: an intervening identity notification fenced the result. */
      readonly reason: RefreshedReason;
      readonly account: CanopyCloudAccountPublicState;
    }
  | {
      readonly status: 'failed';
      /** `identity` when a confirmed stored identity cannot be matched to the start. */
      readonly reason: 'identity' | 'refresh-failed';
    };

function readStoredIdentity(): Promise<string | null> {
  return Promise.resolve()
    .then(() => window.api.loadCanopyCloudAccount())
    .then(canopyCloudAccountIdentity, () => null);
}

function mayHaveChanged(before: string | null, after: string | null): boolean {
  return after !== null && before !== after;
}

/**
 * Re-probe via `refreshCanopyCloudEnforcedSettings` and classify the result
 * against the identity that started it. Never rejects; does not announce.
 */
export async function refreshCanopyCloudAccountData(): Promise<CanopyCloudAccountRefreshOutcome> {
  const generation = identityGeneration;
  const before = await readStoredIdentity();
  let account: CanopyCloudAccountPublicState;
  try {
    account = await window.api.refreshCanopyCloudEnforcedSettings();
  } catch {
    const stored = await readStoredIdentity();
    return {
      status: 'failed',
      reason: mayHaveChanged(before, stored) ? 'identity' : 'refresh-failed',
    };
  }
  const after = canopyCloudAccountIdentity(account);
  const reason: RefreshedReason = mayHaveChanged(before, after)
    ? 'identity'
    : generation !== identityGeneration
      ? undefined
      : before !== null && after !== null
        ? 'same-account-refresh'
        : 'refresh-failed';
  return { status: 'refreshed', reason, account };
}

/** Re-probe and always announce, so subscribers re-read even on failure. */
export async function refreshAndAnnounceCanopyCloudAccount(): Promise<void> {
  const outcome = await refreshCanopyCloudAccountData();
  announceCanopyCloudAccountChanged(outcome.reason);
}
