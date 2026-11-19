'use client';

import { ItemStateMarksProvider } from '@canopy/ui-shared/components';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type JSX,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  customizeSharedWithMeNewCount,
  customizeSharedWithMeSeenMarker,
  customizeSharedWithMeShares,
  type CustomizeSharedWithMeShare,
  DEFAULT_CUSTOMIZE_DISCOVERY_FILTERS,
  type CustomizeDiscoveryFilters,
} from '@canopy/ui-shared/lib/customize-discovery';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib';

/**
 * New Customize (CAN-6809, the `customize-discovery` Labs experiment).
 *
 * Each host resolves whether it is on its own way (desktop from main's Labs
 * snapshot, Portal from the account's choice on the server) and mounts this
 * provider above every Customize surface. It also holds the filter menu's
 * state, so the filters outlive a tab change (a route change on Portal) and
 * the toolbar and the list read one value. Without a provider New Customize
 * is off, so a host that never wires it keeps today's Customize.
 */
interface CustomizeDiscoveryState {
  readonly enabled: boolean;
  readonly filters: CustomizeDiscoveryFilters;
  readonly setFilters: Dispatch<SetStateAction<CustomizeDiscoveryFilters>>;
  /** Marketplace source labels the listed entries carry. */
  readonly sourceOptions: readonly string[];
  readonly setSourceOptions: (options: readonly string[]) => void;
  /** Shared with me (CAN-6810): the list shows only shares from others. */
  readonly sharedWithMe: boolean;
  readonly setSharedWithMe: Dispatch<SetStateAction<boolean>>;
  /** Shares from others the list last published, for the counter. */
  /**
   * Adds the shares from others a list carries to the counter's registry for
   * `scope` (the host's context). A list may be one search result or page,
   * so it only adds; a new scope starts over.
   */
  readonly publishShares: (
    scope: string,
    shares: readonly CustomizeSharedWithMeShare[],
  ) => void;
  /** Shares since the viewer last opened Shared with me; 0 until read. */
  readonly sharedNewCount: number;
}

const NO_SOURCES: readonly string[] = Object.freeze([]);
interface SharedRegistry {
  readonly scope: string | null;
  readonly shares: readonly CustomizeSharedWithMeShare[];
}

const EMPTY_REGISTRY: SharedRegistry = Object.freeze({
  scope: null,
  shares: Object.freeze([]),
});

/**
 * When the viewer last opened Shared with me, as epoch milliseconds. Local to
 * this browser or desktop app: a best-effort hint, so an unreadable store
 * reads as never opened and a failed write only leaves the count showing.
 */
export const CUSTOMIZE_SHARED_WITH_ME_SEEN_KEY =
  'canopy:customize-discovery:shared-with-me-seen:v1';

function readSharedSeenMarker(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(
      CUSTOMIZE_SHARED_WITH_ME_SEEN_KEY,
    );
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeSharedSeenMarker(value: number): void {
  try {
    globalThis.localStorage?.setItem(
      CUSTOMIZE_SHARED_WITH_ME_SEEN_KEY,
      String(value),
    );
  } catch {
    // Best-effort: the count keeps showing until a write succeeds.
  }
}

/** Merges shares into a registry; the same object when nothing changed. */
function mergeShares(
  current: SharedRegistry,
  scope: string,
  shares: readonly CustomizeSharedWithMeShare[],
): SharedRegistry {
  if (current.scope !== scope) return { scope, shares: [...shares] };
  const byId = new Map(current.shares.map((share) => [share.id, share]));
  let changed = false;
  for (const share of shares) {
    const known = byId.get(share.id);
    if (known !== undefined && known.sharedSince === share.sharedSince)
      continue;
    byId.set(share.id, share);
    changed = true;
  }
  return changed ? { scope, shares: [...byId.values()] } : current;
}

const CustomizeDiscoveryContext = createContext<CustomizeDiscoveryState>({
  enabled: false,
  filters: DEFAULT_CUSTOMIZE_DISCOVERY_FILTERS,
  setFilters: () => undefined,
  sourceOptions: NO_SOURCES,
  setSourceOptions: () => undefined,
  sharedWithMe: false,
  setSharedWithMe: () => undefined,
  publishShares: () => undefined,
  sharedNewCount: 0,
});

function sameOptions(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function CustomizeDiscoveryProvider({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const [filters, setFiltersState] = useState<CustomizeDiscoveryFilters>(
    DEFAULT_CUSTOMIZE_DISCOVERY_FILTERS,
  );
  // Attention is no longer a status to pick (Sergii's QA): those items lead
  // the Installed list instead, so a saved or passed "attention" reads Any.
  const setFilters = useCallback<
    Dispatch<SetStateAction<CustomizeDiscoveryFilters>>
  >((action): void => {
    setFiltersState((current) => {
      const next = typeof action === 'function' ? action(current) : action;
      return next.status === 'attention' ? { ...next, status: 'any' } : next;
    });
  }, []);
  const [sourceOptions, setSourceOptionsState] =
    useState<readonly string[]>(NO_SOURCES);
  const setSourceOptions = useCallback((options: readonly string[]): void => {
    setSourceOptionsState((current) =>
      sameOptions(current, options) ? current : options,
    );
  }, []);
  const [sharedWithMe, setSharedWithMe] = useState(false);
  const [registry, setRegistry] = useState<SharedRegistry>(EMPTY_REGISTRY);
  const publishShares = useCallback(
    (scope: string, shares: readonly CustomizeSharedWithMeShare[]): void => {
      setRegistry((current) => mergeShares(current, scope, shares));
    },
    [],
  );
  const sharedShares = registry.shares;
  // Read after mount, so the server render and hydration agree; `undefined`
  // until then hides the count instead of flashing every share as new.
  const [sharedSeen, setSharedSeen] = useState<number | null | undefined>(
    undefined,
  );
  useEffect(() => {
    if (enabled) setSharedSeen(readSharedSeenMarker());
  }, [enabled]);
  // Opening Shared with me clears the count, and shares that arrive while it
  // is open count as seen too.
  useEffect(() => {
    if (!enabled || !sharedWithMe) return;
    const marker = customizeSharedWithMeSeenMarker(sharedShares, Date.now());
    writeSharedSeenMarker(marker);
    setSharedSeen(marker);
  }, [enabled, sharedWithMe, sharedShares]);
  const sharedNewCount =
    !enabled || sharedSeen === undefined || sharedWithMe
      ? 0
      : customizeSharedWithMeNewCount(sharedShares, sharedSeen);
  const value = useMemo(
    (): CustomizeDiscoveryState => ({
      enabled,
      filters,
      setFilters,
      sourceOptions,
      setSourceOptions,
      sharedWithMe: enabled && sharedWithMe,
      setSharedWithMe,
      publishShares,
      sharedNewCount,
    }),
    [
      enabled,
      filters,
      sourceOptions,
      setSourceOptions,
      sharedWithMe,
      publishShares,
      sharedNewCount,
    ],
  );
  return (
    <CustomizeDiscoveryContext.Provider value={value}>
      <ItemStateMarksProvider enabled={enabled}>
        {children}
      </ItemStateMarksProvider>
    </CustomizeDiscoveryContext.Provider>
  );
}

/** The one switch every New Customize change reads. */
export function useCustomizeDiscoveryEnabled(): boolean {
  return useContext(CustomizeDiscoveryContext).enabled;
}

/** The filter menu's state, shared by the toolbar and the list. */
export function useCustomizeDiscoveryFilters(): {
  readonly filters: CustomizeDiscoveryFilters;
  readonly setFilters: Dispatch<SetStateAction<CustomizeDiscoveryFilters>>;
} {
  const { filters, setFilters } = useContext(CustomizeDiscoveryContext);
  return { filters, setFilters };
}

/** The marketplaces Source offers, as the list last published them. */
export function useCustomizeDiscoverySourceOptions(): readonly string[] {
  return useContext(CustomizeDiscoveryContext).sourceOptions;
}

/** Publishes the marketplaces the list's entries carry, for Source. */
export function usePublishCustomizeDiscoverySourceOptions(
  options: readonly string[] | null,
): void {
  const { setSourceOptions } = useContext(CustomizeDiscoveryContext);
  useEffect(() => {
    if (options !== null) setSourceOptions(options);
  }, [options, setSourceOptions]);
}

/** Shared with me (CAN-6810): the toggle and its counter. */
export function useCustomizeSharedWithMe(): {
  readonly active: boolean;
  readonly setActive: Dispatch<SetStateAction<boolean>>;
  readonly newCount: number;
} {
  const { sharedWithMe, setSharedWithMe, sharedNewCount } = useContext(
    CustomizeDiscoveryContext,
  );
  return {
    active: sharedWithMe,
    setActive: setSharedWithMe,
    newCount: sharedNewCount,
  };
}

/**
 * Publishes the shares from others the list's entries carry, for the counter.
 * `scope` is the host's context; entries from a search or one page only add.
 */
export function usePublishCustomizeSharedWithMe(
  entries: readonly UnifiedPluginEntry[] | null,
  scope: string,
): void {
  const { publishShares } = useContext(CustomizeDiscoveryContext);
  const shares = useMemo(
    () => (entries === null ? null : customizeSharedWithMeShares(entries)),
    [entries],
  );
  useEffect(() => {
    if (shares !== null) publishShares(scope, shares);
  }, [shares, scope, publishShares]);
}
