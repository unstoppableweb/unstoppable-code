import { useEffect, useState } from 'react';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isConclusiveAccountRead } from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { PROJECT_IDENTITY_CAPABILITY } from '@canopy/protocol/memory-sync';

/**
 * Whether a saved Canopy Cloud credential currently resolves to account
 * metadata — i.e. whether an authenticated cloud request can be made at all.
 *
 *  - `oauth_desktop` credential → usable when account metadata resolved
 *  - manual / legacy API key → usable when account metadata resolved
 *  - guest device credential → usable; it authenticates like a real account
 *
 * Guests are deliberately INCLUDED here, unlike {@link useCanopyCloudConnected}.
 * The distinction matters for surfaces that report whether cloud work can
 * proceed (telemetry sync uploads with a guest credential exactly as it does
 * with a real one) rather than whether a real Unstoppable Domains identity is
 * linked.
 */
function hasResolvedCloudCredential(
  account: CanopyCloudAccountPublicState,
): boolean {
  if (!account.account) return false;
  if (account.credentialSource === 'oauth_desktop') return true;
  return (
    account.authMode === 'api_key' ||
    account.credentialSource === 'manual' ||
    isGuestAccount(account) ||
    (account.hasApiKey && !account.authMode && !account.credentialSource)
  );
}

/**
 * Whether a saved Canopy Cloud credential currently resolves to a REAL account.
 * Mirrors the connection logic in `CanopyCloudAccountSection` so a sibling
 * surface (the standalone AI Credits card) can gate on the same signal without
 * being nested inside the account section.
 */
function isConnected(account: CanopyCloudAccountPublicState): boolean {
  // A guest holds a device credential but reads as "not connected" for the
  // real-account surfaces this hook gates (it is offered separately via the
  // guest signal). Exclude it here so a normalized guest — `authMode: 'guest'`
  // with `credentialSource: 'manual'` — is not misread as a manual connection.
  if (isGuestAccount(account)) return false;
  return hasResolvedCloudCredential(account);
}

/**
 * Shared account-state tracker behind the two hooks below. Returns `null` while
 * the initial load is in flight so callers can avoid flashing a disconnected
 * prompt for an already-linked user, then `true`/`false` once resolved.
 * Re-reads whenever a sign-in / sign-out elsewhere broadcasts
 * `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT`.
 *
 * `predicate` must be referentially stable (a module-level function), and
 * `fallback` a primitive.
 */
function useCloudAccountPredicate<T extends boolean | string>(
  predicate: (account: CanopyCloudAccountPublicState) => T,
  /** Settled value when the account cannot be read conclusively. */
  fallback: T | null,
): T | null {
  const [value, setValue] = useState<T | null>(null);

  useEffect(() => {
    let active = true;
    let readGeneration = 0;
    const loadAccount = window.api?.loadCanopyCloudAccount;
    if (typeof loadAccount !== 'function') {
      setValue(fallback);
      return (): void => {
        active = false;
      };
    }

    const refresh = (): void => {
      const generation = ++readGeneration;
      if (fallback === null) setValue(null);
      void loadAccount()
        .then((account) => {
          if (!active || generation !== readGeneration) return;
          if (!isConclusiveAccountRead(account)) {
            setValue((previous) => previous ?? fallback);
            return;
          }
          setValue(predicate(account));
        })
        .catch(() => {
          if (active && generation === readGeneration) {
            setValue((previous) => previous ?? fallback);
          }
        });
    };

    refresh();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    return (): void => {
      active = false;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    };
  }, [fallback, predicate]);

  return value;
}

/**
 * Tracks the Canopy Cloud connection state for surfaces rendered outside the
 * account section. Returns `null` while the initial account load is in flight
 * so callers can avoid flashing a disconnected prompt for an already-linked
 * user, then `true`/`false` once resolved. Re-loads whenever a sign-in /
 * sign-out elsewhere broadcasts `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT`.
 */
export function useCanopyCloudConnected(): boolean | null {
  return useCloudAccountPredicate(isConnected, false);
}

/**
 * Tracks whether an authenticated cloud request can currently be made at all,
 * guests included — the signal a surface wants when it reports whether cloud
 * WORK can proceed rather than whether a real identity is linked.
 *
 * Used by Settings → Privacy so the activity-sharing status line can say
 * "Not connected" instead of replaying a stale successful sync: main defers a
 * credential-less flush WITHOUT recording an upload error, so `lastSyncedAt`
 * alone reads as healthy while the queue silently grows.
 *
 * An inconclusive initial secure-store read settles to `false`; after a
 * conclusive read, transient failures retain the last-known value so this
 * status remains aligned with the account card until the next conclusive read.
 */
export function useCanopyCloudCredentialUsable(): boolean | null {
  return useCloudAccountPredicate(hasResolvedCloudCredential, false);
}

function hasProjectIdentity(account: CanopyCloudAccountPublicState): boolean {
  return (
    isConnected(account) &&
    account.capabilities.includes(PROJECT_IDENTITY_CAPABILITY)
  );
}

/**
 * Whether the signed-in account has cloud project identity (CAN-5190), which
 * the Link to cloud project menu entry needs. `null` while the account loads.
 */
export function useCanopyProjectIdentityAvailable(): boolean | null {
  return useCloudAccountPredicate(hasProjectIdentity, false);
}

/** A real account's id, or `guest` for a guest or signed-out viewer. */
export function tryItAccountKey(
  account: CanopyCloudAccountPublicState,
): string {
  return isConnected(account) && account.account
    ? `account:${account.account.id}`
    : 'guest';
}

export interface TryItAccountState {
  /** `loading` until the first account read settles; never signed out. */
  status: 'loading' | 'guest' | 'signed-in';
  /** Scopes recoverable Try it launches; `guest` for guest and signed-out. */
  accountId: string | null;
}

/**
 * The detail-page Try it / Install CTA's account input (CAN-4359): signed in
 * means a real account, as {@link useCanopyCloudConnected} reads it, and the
 * account id scopes launch recovery so one account never reuses another's.
 */
export function useTryItAccount(): TryItAccountState {
  const key = useCloudAccountPredicate<string>(tryItAccountKey, null);
  if (key === null) return { status: 'loading', accountId: null };
  return key === 'guest'
    ? { status: 'guest', accountId: 'guest' }
    : { status: 'signed-in', accountId: key };
}

/**
 * The signed-in account's id, `''` for a guest or signed-out viewer, and
 * `null` while the account loads. A Personal project's cloud binding counts
 * only under this account (CAN-7766 matches projects across computers by it).
 */
function cloudAccountId(account: CanopyCloudAccountPublicState): string {
  return isConnected(account) && account.account ? account.account.id : '';
}

export function useCanopyCloudAccountId(): string | null {
  return useCloudAccountPredicate<string>(cloudAccountId, '');
}
