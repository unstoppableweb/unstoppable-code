import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { findLabsExperimentForPage } from '@canopy/desktop-shared/lib/labs-experiments';
import {
  NAVIGATION_PAGE_MAP,
  type NavigationPage,
} from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  type ClientFeatureFlagKey,
} from '@canopy/protocol/feature-flags';
import { getDevPageDef } from '@/components/pages/dev-pages';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  ensureLabsExperimentsSubscription,
  isLabsExperimentEnabled,
  useLabsExperimentsStore,
} from '@/stores/labsExperimentsStore';

/**
 * The one renderer-owned answer to "can this desktop page be shown right
 * now?". Navigation, the page host, the sidebar, the command palette, the App
 * Advisor dispatcher, and the UI snapshot all read it, so a page that is
 * switched off is refused the same way everywhere.
 *
 * This gates desktop pages only. It is not an authorization boundary for
 * backend operations.
 */

/** Where a refused navigation lands: the New task page. */
export const NAVIGATION_FALLBACK_PAGE = 'home' satisfies NavigationPage;

/**
 * Why a page is unavailable. `experiment` means a Labs experiment that owns
 * the page is off (Settings → Labs).
 */
export type PageUnavailableReason = 'feature-flag' | 'dev-only' | 'experiment';

export interface PageUnavailable {
  readonly available: false;
  readonly page: NavigationPage;
  /** Display name used in refusal copy. */
  readonly label: string;
  readonly reason: PageUnavailableReason;
}

export type PageAvailability =
  | { readonly available: true; readonly page: NavigationPage }
  | PageUnavailable;

interface FeatureFlagPageGate {
  readonly label: string;
  readonly flag: ClientFeatureFlagKey;
}

/**
 * Pages behind a client feature flag. Read through the flag store's
 * `isEnabled`, so the unconfigured and configured-but-unavailable defaults
 * stay whatever the flag declares.
 */
const FEATURE_FLAG_PAGE_GATES: Partial<
  Record<NavigationPage, FeatureFlagPageGate>
> = {
  workers: {
    label: 'Claude workers',
    flag: CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key,
  },
  feed: {
    label: 'Feed',
    flag: CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
  },
  'cloud-chat': {
    label: 'Cloud chats',
    flag: CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key,
  },
};

/**
 * Whether `page`'s client feature flag, if it has one, is on. Settings uses it
 * to leave out a page experiment whose page the flag would still refuse.
 */
export function isPageFeatureFlagGateOpen(page: NavigationPage): boolean {
  const flagGate = FEATURE_FLAG_PAGE_GATES[page];
  return !flagGate || useFeatureFlagsStore.getState().isEnabled(flagGate.flag);
}

/** Compatibility aliases are valid navigation payloads but not pages to list. */
const COMPATIBILITY_ALIAS_PAGES: ReadonlySet<NavigationPage> =
  new Set<NavigationPage>(['mcp-account-connections', 'environments']);

export function getPageAvailability(page: NavigationPage): PageAvailability {
  const flagGate = FEATURE_FLAG_PAGE_GATES[page];
  if (flagGate && !isPageFeatureFlagGateOpen(page)) {
    return {
      available: false,
      page,
      label: flagGate.label,
      reason: 'feature-flag',
    };
  }
  const devPage = getDevPageDef(page);
  if (devPage && !devPage.enabled()) {
    return {
      available: false,
      page,
      label: devPage.label,
      reason: 'dev-only',
    };
  }
  const experiment = getPageExperimentGate(page);
  if (experiment) {
    return {
      available: false,
      page,
      label: experiment.name,
      reason: 'experiment',
    };
  }
  return { available: true, page };
}

/**
 * The Labs experiment that owns `page` while main reports it off. Pages are
 * owned by registry entries and, in E2E builds, by fixture entries that only
 * main's snapshot carries. Before a ready snapshot, registered pages are
 * refused: a missing snapshot never means unrestricted access.
 */
function getPageExperimentGate(
  page: NavigationPage,
): { readonly name: string } | null {
  const { snapshot } = useLabsExperimentsStore.getState();
  const entry =
    snapshot?.experiments.find((candidate) => candidate.pages.includes(page)) ??
    findLabsExperimentForPage(page);
  if (!entry || isLabsExperimentEnabled(snapshot, entry.id)) return null;
  return entry;
}

export function isPageAvailable(page: NavigationPage): boolean {
  return getPageAvailability(page).available;
}

/**
 * Every page that can be shown right now, in `NAVIGATION_PAGE_MAP` order.
 * Compatibility aliases are left out: they open another destination instead.
 */
export function listAvailablePages(): NavigationPage[] {
  return Object.values(NAVIGATION_PAGE_MAP).filter(
    (page) => !COMPATIBILITY_ALIAS_PAGES.has(page) && isPageAvailable(page),
  );
}

/** The page a navigation request lands on: itself, or the fallback. */
export function resolveNavigationTarget(page: NavigationPage): NavigationPage {
  return isPageAvailable(page) ? page : NAVIGATION_FALLBACK_PAGE;
}

/** Refusal copy for a page the policy has already found unavailable. */
export function formatPageUnavailableMessage(
  unavailable: Pick<PageUnavailable, 'label' | 'reason'>,
): string {
  switch (unavailable.reason) {
    case 'feature-flag':
      return `The ${unavailable.label} page isn't available right now.`;
    case 'dev-only':
      return `The ${unavailable.label} page isn't enabled in this build or development configuration.`;
    case 'experiment':
      return `The ${unavailable.label} page is switched off. Turn it on in Settings → Labs.`;
  }
}

// Page availability reads two stores: feature flags and Labs experiments.
// Hooks subscribe to both so a change in either re-evaluates the policy.
function subscribePolicyInputs(onChange: () => void): () => void {
  const unsubscribeFlags = useFeatureFlagsStore.subscribe(onChange);
  const unsubscribeLabs = useLabsExperimentsStore.subscribe(onChange);
  return (): void => {
    unsubscribeFlags();
    unsubscribeLabs();
  };
}

function useLabsExperimentsHydration(): void {
  useEffect(() => {
    ensureLabsExperimentsSubscription();
  }, []);
}

/**
 * Reactive `isPageAvailable`. Re-evaluates on every feature-flag and Labs
 * snapshot; dev-page gates only change on reload, as before.
 */
export function useIsPageAvailable(page: NavigationPage): boolean {
  useLabsExperimentsHydration();
  const read = (): boolean => isPageAvailable(page);
  // The same read serves static renders, which have no server state.
  return useSyncExternalStore(subscribePolicyInputs, read, read);
}

/** Reactive `getPageAvailability` with a stable result between changes. */
export function usePageAvailability(page: NavigationPage): PageAvailability {
  const available = useIsPageAvailable(page);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `available` is the invalidation key
  return useMemo(() => getPageAvailability(page), [page, available]);
}

/** Reactive `listAvailablePages` with a stable array between changes. */
export function useAvailablePages(): readonly NavigationPage[] {
  useLabsExperimentsHydration();
  const key = useSyncExternalStore(subscribePolicyInputs, () =>
    listAvailablePages().join('|'),
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the invalidation key
  return useMemo(() => listAvailablePages(), [key]);
}
