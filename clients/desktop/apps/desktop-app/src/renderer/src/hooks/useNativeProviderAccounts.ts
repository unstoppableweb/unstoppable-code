import { useEffect, useState } from 'react';
import type { PreferencesData } from '@canopy/desktop-shared/types';

export type NativeProviderAccounts = NonNullable<
  PreferencesData['nativeProviderAccounts']
>;

let lastReadAccounts: NativeProviderAccounts = {};

/**
 * The main-owned record of each billed provider's last confirmed native
 * account (CAN-4200). Main records a `changedAt` when a different account
 * signs in and broadcasts a preferences change, so this re-reads then.
 *
 * Returns the last read's record (`{}` before the first) until this mount's
 * read lands, and keeps it when the read fails: the record only ends stale
 * "just this time" routing early, and main applies the same rule to the
 * billing decision regardless of what the composer shows.
 */
export function useNativeProviderAccounts(): NativeProviderAccounts {
  const [accounts, setAccounts] =
    useState<NativeProviderAccounts>(lastReadAccounts);

  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        // Optional access throughout: lab and test mounts render the composer
        // without the full preload bridge.
        const preferences = await window.api?.loadPreferences?.();
        const next = preferences?.nativeProviderAccounts ?? {};
        // The last read seeds the next mount, and an equal answer keeps the
        // held record: a switch remounts the composer, which rendered it
        // twice more when the read answered.
        if (JSON.stringify(next) !== JSON.stringify(lastReadAccounts)) {
          lastReadAccounts = next;
        }
        if (!cancelled) {
          setAccounts(lastReadAccounts);
        }
      } catch {
        // Keep the last value; a failed read must not revert routing.
      }
    };
    void read();
    const unsubscribe = window.api?.onPreferencesChanged?.(() => {
      void read();
    });
    return (): void => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return accounts;
}
