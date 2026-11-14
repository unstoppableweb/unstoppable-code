import type {
  ExternalProjectImportInviteState,
  ExternalProjectProvider,
} from '@canopy/desktop-shared/types';
import { readPreferencesFile } from '../lib/preferences-store';
import { readAllSidebarItems } from '../lib/sidebar-items';
import {
  markExternalProjectInviteShown,
  readExternalProjectImportLedger,
} from './ledger';
import { detectProviderStorePresenceByProvider } from './provider-presence';

/**
 * One-time invitation for installs that finished onboarding before the bulk
 * project import existed (CAN-2439). Fresh installs meet the flow inside the
 * onboarding wizard instead, and any scan (from the wizard, Settings, or the
 * checklist) retires the invite because the user has already seen the flow.
 *
 * The invite only fires when a provider store holds evidence that did not
 * come from Canopy itself (see `provider-presence.ts`), so a user who never
 * ran Claude Code or Codex on their own is not nudged toward an empty scan.
 */

/**
 * Presence is asked for by every entry point that mounts (the invite host,
 * Home's Getting started module, the onboarding wizard), often at the same
 * moment. One bounded probe per process every few minutes is plenty: a
 * provider store appearing mid-session is picked up on the next window.
 */
const PRESENCE_TTL_MS = 5 * 60 * 1000;

type ProviderPresence = Record<ExternalProjectProvider, boolean>;

let presenceCache: { value: ProviderPresence; checkedAt: number } | null = null;
let presenceInFlight: Promise<ProviderPresence> | null = null;

export function readProviderPresenceByProvider(): Promise<ProviderPresence> {
  if (presenceCache && Date.now() - presenceCache.checkedAt < PRESENCE_TTL_MS) {
    return Promise.resolve(presenceCache.value);
  }
  if (presenceInFlight) return presenceInFlight;
  presenceInFlight = attachedCoworkFolders()
    .then((extraExcludedRoots) =>
      detectProviderStorePresenceByProvider({ extraExcludedRoots }),
    )
    .then((value) => {
      presenceCache = { value, checkedAt: Date.now() };
      return value;
    })
    .finally(() => {
      presenceInFlight = null;
    });
  return presenceInFlight;
}

export async function hasAnyProviderStore(): Promise<boolean> {
  return Object.values(await readProviderPresenceByProvider()).some(Boolean);
}

/**
 * External folders attached as Cowork projects are Canopy's own cwd, so a
 * Claude project directory created for one is not evidence of provider use.
 */
async function attachedCoworkFolders(): Promise<string[]> {
  try {
    const { items } = await readAllSidebarItems();
    return items.flatMap((item) =>
      item.type === 'cowork' && item.externalPath ? [item.externalPath] : [],
    );
  } catch {
    return [];
  }
}

/** Test-only: forget the memoized probe result. */
export function resetProviderPresenceCacheForTests(): void {
  presenceCache = null;
  presenceInFlight = null;
}

export async function readExternalProjectImportInvite(): Promise<ExternalProjectImportInviteState> {
  // The ledger is a small local file; consult it before the (memoized)
  // presence probe so a retired invite decides without any provider I/O.
  const ledger = await readExternalProjectImportLedger();
  const retired =
    ledger.inviteShownAt !== null ||
    ledger.lastScanAt !== null ||
    Object.keys(ledger.imports).length > 0;
  // A retired invite never probes: entry points that need presence for
  // their own gate ask through `external-projects:provider-presence`.
  if (retired) return { show: false, providerStoresPresent: false };
  const providerStoresPresent = await hasAnyProviderStore();
  if (!providerStoresPresent) {
    return { show: false, providerStoresPresent };
  }
  const preferences = await readPreferencesFile().catch(() => null);
  const onboarded =
    Array.isArray(preferences?.onboardingCompleted) &&
    preferences.onboardingCompleted.length > 0;
  if (onboarded) {
    // Retire before answering so a second window asking at the same moment
    // already sees a retired invite; the renderer's acknowledgement is then
    // a harmless repeat. Strictly once per install, not once per window.
    await markExternalProjectInviteShown().catch(() => undefined);
  }
  return { show: onboarded, providerStoresPresent };
}
