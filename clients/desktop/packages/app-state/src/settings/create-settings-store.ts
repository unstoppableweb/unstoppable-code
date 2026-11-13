import { create } from 'zustand';
import type {
  AccountOrganizationSettingsClient,
  SettingsSelectionStorage,
} from '@canopy/app-core/settings';
import {
  SettingsOperationError,
  settingsBootstrapHasOrganization,
  settingsRouteToPath,
  type OrganizationDetail,
  type SettingsBootstrap,
  type SettingsErrorPayload,
  type SettingsPageData,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import {
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../client-store-lifecycle';

/**
 * Shared hosted-settings state: the bootstrap, a per-route page cache, the
 * browsed organization and its account-scoped persistence.
 *
 * One store exists per settings client and account generation. Replacing the
 * client or signing in as someone else disposes the store; responses that
 * arrive after disposal, or for a superseded request, are dropped so one
 * identity's data never lands in another's store.
 *
 * Refetches merge into the cache entry without clearing it first, so a
 * mounted page keeps rendering (and keeps its in-progress drafts, which live
 * in component state) while fresh data loads.
 */

export type SettingsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SettingsBootstrapEntry {
  readonly status: SettingsLoadStatus;
  readonly data: SettingsBootstrap | null;
  readonly error: SettingsErrorPayload | null;
}

export interface SettingsPageEntry {
  readonly status: SettingsLoadStatus;
  readonly data: SettingsPageData | null;
  readonly error: SettingsErrorPayload | null;
  /** Bumps on every applied response, so views can key refreshed data. */
  readonly revision: number;
}

/**
 * How an organization's Members invite runs on a host that confirms seat
 * charges on the web: `inline` (no paid seat can be added) or `handoff`.
 */
export type SettingsSeatChargeMode = 'inline' | 'handoff';

export interface SettingsStoreState {
  readonly accountId: string | null;
  /** Keyed by the requested organization id, `''` for none. */
  readonly bootstraps: Readonly<Record<string, SettingsBootstrapEntry>>;
  /** Keyed by {@link settingsRouteKey}. */
  readonly pages: Readonly<Record<string, SettingsPageEntry>>;
  /**
   * The organization the viewer is browsing in settings, validated against
   * bootstrap membership. Never derived from membership order.
   */
  readonly selectedOrganizationId: string | null;
  /**
   * The last invite seat-charge check per organization id, so returning to
   * Members does not swap its header action while billing is read again.
   * Cleared by any member or billing change and by {@link refresh}.
   */
  readonly seatCharges: Readonly<Record<string, SettingsSeatChargeMode>>;
  /**
   * The last known detail per organization id, from any organization tab's
   * page data or a change a tab made, so a tab that is still loading can draw
   * the organization header. Overwritten by every newer detail.
   */
  readonly organizationDetails: Readonly<Record<string, OrganizationDetail>>;
  /** Bumps on every {@link refresh}, so views can drop what they held. */
  readonly refreshGeneration: number;
  /** Load (or refetch, with `force`) the bootstrap for an organization. */
  loadBootstrap(
    organizationId?: string | null,
    options?: { force?: boolean },
  ): Promise<void>;
  /** Load (or refetch, with `force`) a route's first-screen data. */
  loadPage(route: SettingsRoute, options?: { force?: boolean }): Promise<void>;
  /**
   * Read a route's data ahead of a likely visit (hover or focus). Skipped
   * when the route has data or a read in flight. A failure is dropped
   * without an error state; the visit reads again. A visit that starts
   * while the prefetch is in flight reuses its response.
   */
  prefetch(route: SettingsRoute): Promise<void>;
  /** Seed a route from server-rendered data without fetching. */
  hydratePage(route: SettingsRoute, data: SettingsPageData): void;
  /**
   * Refetch cached routes (all, or one) and the bootstraps, keeping current
   * data visible until the new data arrives.
   */
  refresh(route?: SettingsRoute): Promise<void>;
  /** Drop cached data for a route so the next mount refetches from scratch. */
  evict(route: SettingsRoute): void;
  /**
   * Forget what hover prefetches read, after a change that may have made it
   * stale: prefetches in flight no longer apply, and pages only a prefetch
   * filled (never visited) are dropped so a visit reads again. A visit that
   * already adopted an in-flight prefetch still applies it, so the caller
   * force-reloads the page on screen.
   */
  dropPrefetches(): void;
  /** Remember an organization's invite seat-charge check. */
  rememberSeatCharge(
    organizationId: string,
    mode: SettingsSeatChargeMode,
  ): void;
  /** Forget an organization's invite seat-charge check. */
  forgetSeatCharge(organizationId: string): void;
  /** Remember changed detail in the header and any cached Members page. */
  rememberOrganizationDetail(
    organizationId: string,
    detail: OrganizationDetail,
  ): void;
  /** Browse an organization (or none). Persists per account. */
  selectOrganization(organizationId: string | null): void;
  /**
   * The persisted organization for this account, when the bootstrap still
   * lists it. Clears a stale persisted value.
   */
  restoreOrganization(bootstrap: SettingsBootstrap): string | null;
}

export type SettingsStore = ClientStore<SettingsStoreState>;

export interface CreateSettingsStoreOptions {
  /** The signed-in account, `null` when signed out. Scopes persistence. */
  readonly accountId: string | null;
  readonly storage?: SettingsSelectionStorage;
  /**
   * Bootstraps this account loaded earlier (an earlier Settings session),
   * keyed by requested organization id, `''` for none. They render at once
   * but stay `idle`, so the first load still reads the server and replaces
   * them in one step. Ignored when signed out.
   */
  readonly initialBootstraps?: Readonly<Record<string, SettingsBootstrap>>;
  /**
   * The route Settings opens on. An organization route browses its
   * organization from creation, so that organization's bootstrap is
   * requested on the first render rather than after an effect selects it.
   */
  readonly initialRoute?: SettingsRoute | null;
}

const IDLE_BOOTSTRAP: SettingsBootstrapEntry = {
  status: 'idle',
  data: null,
  error: null,
};

/** Stable cache key for a route: its canonical web path. */
export function settingsRouteKey(route: SettingsRoute): string {
  return settingsRouteToPath(route);
}

function bootstrapKey(organizationId: string | null | undefined): string {
  return organizationId ?? '';
}

/** Earlier bootstraps as `idle` entries: shown, but still read on first load. */
function seededBootstraps(
  bootstraps: Readonly<Record<string, SettingsBootstrap>> | undefined,
): Readonly<Record<string, SettingsBootstrapEntry>> {
  if (bootstraps === undefined) return {};
  const entries: Record<string, SettingsBootstrapEntry> = {};
  for (const [key, data] of Object.entries(bootstraps))
    entries[key] = { status: 'idle', data, error: null };
  return entries;
}

/**
 * The organization detail a page carries, for the header cache. Organization
 * tabs carry it directly and memory pages through their optional `team`;
 * drill-downs, the list and account pages carry none. The memory fact
 * page's own `detail` is a fact, not an organization.
 */
function organizationDetailOf(
  page: SettingsPageData,
): OrganizationDetail | null {
  switch (page.kind) {
    case 'organization.feed':
    case 'organization.feedItem':
    case 'organization.statistics':
    case 'organization.digests':
    case 'organization.members':
    case 'organization.groups':
    case 'organization.projects':
    case 'organization.settings':
      return page.data.detail;
    case 'organization.memory.facts':
    case 'organization.memory.graph':
    case 'organization.memory.ops':
    case 'organization.memory.fact':
      return page.data.team?.detail ?? null;
    case 'organization.list':
    case 'organization.digest':
    case 'organization.member':
    case 'organization.memberDigest':
    case 'organization.invoice':
    case 'account.account':
    case 'account.profile':
    case 'account.digests':
    case 'account.digest':
    case 'account.notifications':
    case 'account.integrations':
    case 'account.ai-gateway':
    case 'account.plugins':
    case 'account.mcp':
    case 'account.security':
    case 'account.billing':
    case 'account.invoice':
    case 'account.labs':
    case 'account.appearance':
      return null;
  }
}

/** The details map with a page's organization detail, if it carries one. */
function withOrganizationDetail(
  details: Readonly<Record<string, OrganizationDetail>>,
  page: SettingsPageData,
): Readonly<Record<string, OrganizationDetail>> {
  const detail = organizationDetailOf(page);
  if (detail === null || details[detail.id] === detail) return details;
  return { ...details, [detail.id]: detail };
}

/** Portable error description for any rejection a client produced. */
export function settingsErrorPayloadFrom(error: unknown): SettingsErrorPayload {
  if (error instanceof SettingsOperationError) return error.toPayload();
  return { code: 'failed' };
}

export function createSettingsStore(
  client: AccountOrganizationSettingsClient,
  options: CreateSettingsStoreOptions,
): SettingsStore {
  const { accountId, storage, initialBootstraps, initialRoute } = options;
  const initialOrganizationId =
    accountId !== null && initialRoute?.scope === 'organization'
      ? initialRoute.organizationId
      : null;
  // The same persistence `selectOrganization` would have written.
  if (initialOrganizationId !== null && accountId !== null)
    storage?.writeOrganizationId(accountId, initialOrganizationId);
  let disposed = false;
  // Latest request token per cache key. A response applies only while its
  // token is still the latest, so an older, slower response never replaces a
  // newer one.
  const bootstrapTokens = new Map<string, number>();
  const pageTokens = new Map<string, number>();
  const pageRoutes = new Map<string, SettingsRoute>();
  // Prefetch reads in flight per cache key; a visit adopts one rather than
  // reading the same route again.
  const prefetches = new Map<string, Promise<SettingsPageData>>();
  // Each prefetch's request token, so a refresh drops only the keys a
  // prefetch still owns, not one a visit has since taken over.
  const prefetchTokens = new Map<string, number>();
  // Pages a prefetch filled that no visit has used yet.
  const prefetchedOnly = new Set<string>();
  let nextToken = 0;

  const store = create<SettingsStoreState>()((set, get) => {
    const loadBootstrap = async (
      organizationId?: string | null,
      loadOptions: { force?: boolean } = {},
    ): Promise<void> => {
      if (disposed) return;
      const key = bootstrapKey(organizationId);
      const current = get().bootstraps[key];
      if (
        !loadOptions.force &&
        current !== undefined &&
        (current.status === 'loading' || current.status === 'ready')
      )
        return;
      const token = ++nextToken;
      bootstrapTokens.set(key, token);
      set((state) => ({
        bootstraps: {
          ...state.bootstraps,
          [key]: {
            status: 'loading',
            data: state.bootstraps[key]?.data ?? null,
            error: null,
          },
        },
      }));
      try {
        const data = await client.read(
          'settings.bootstrap',
          organizationId ? { organizationId } : {},
        );
        if (disposed || bootstrapTokens.get(key) !== token) return;
        set((state) => ({
          bootstraps: {
            ...state.bootstraps,
            [key]: { status: 'ready', data, error: null },
          },
        }));
      } catch (error) {
        if (disposed || bootstrapTokens.get(key) !== token) return;
        set((state) => ({
          bootstraps: {
            ...state.bootstraps,
            [key]: {
              status: 'error',
              data: state.bootstraps[key]?.data ?? null,
              error: settingsErrorPayloadFrom(error),
            },
          },
        }));
      }
    };

    const applyPage = (key: string, data: SettingsPageData): void => {
      set((state) => ({
        pages: {
          ...state.pages,
          [key]: {
            status: 'ready',
            data,
            error: null,
            revision: (state.pages[key]?.revision ?? 0) + 1,
          },
        },
        organizationDetails: withOrganizationDetail(
          state.organizationDetails,
          data,
        ),
      }));
    };

    const loadPage = async (
      route: SettingsRoute,
      loadOptions: { force?: boolean } = {},
    ): Promise<void> => {
      if (disposed) return;
      const key = settingsRouteKey(route);
      pageRoutes.set(key, route);
      prefetchedOnly.delete(key);
      const current = get().pages[key];
      if (
        !loadOptions.force &&
        current !== undefined &&
        (current.status === 'loading' || current.status === 'ready')
      )
        return;
      const token = ++nextToken;
      pageTokens.set(key, token);
      set((state) => {
        const previous = state.pages[key];
        return {
          pages: {
            ...state.pages,
            [key]: {
              status: 'loading',
              data: previous?.data ?? null,
              error: null,
              revision: previous?.revision ?? 0,
            },
          },
        };
      });
      try {
        const pending = loadOptions.force ? undefined : prefetches.get(key);
        const data =
          pending === undefined
            ? await client.read('settings.pageData', { route })
            : await pending.catch(() =>
                client.read('settings.pageData', { route }),
              );
        if (disposed || pageTokens.get(key) !== token) return;
        applyPage(key, data);
      } catch (error) {
        if (disposed || pageTokens.get(key) !== token) return;
        const payload = settingsErrorPayloadFrom(error);
        set((state) => {
          const previous = state.pages[key];
          // Known access loss removes protected content immediately rather
          // than leaving stale data on screen behind an error.
          const keepData =
            payload.code !== 'forbidden' &&
            payload.code !== 'not_found' &&
            payload.code !== 'expired' &&
            payload.code !== 'unauthenticated';
          return {
            pages: {
              ...state.pages,
              [key]: {
                status: 'error',
                data: keepData ? (previous?.data ?? null) : null,
                error: payload,
                revision: previous?.revision ?? 0,
              },
            },
          };
        });
      }
    };

    return {
      accountId,
      bootstraps: accountId === null ? {} : seededBootstraps(initialBootstraps),
      pages: {},
      selectedOrganizationId: initialOrganizationId,
      seatCharges: {},
      organizationDetails: {},
      refreshGeneration: 0,
      loadBootstrap,
      loadPage,
      async prefetch(route): Promise<void> {
        if (disposed) return;
        const key = settingsRouteKey(route);
        const current = get().pages[key];
        if (
          prefetches.has(key) ||
          (current !== undefined &&
            (current.data !== null || current.status === 'loading'))
        )
          return;
        // A prefetch is the latest request for its key until a visit or
        // another load supersedes it; only then does it apply.
        const token = ++nextToken;
        pageTokens.set(key, token);
        const request = client.read('settings.pageData', { route });
        prefetches.set(key, request);
        prefetchTokens.set(key, token);
        try {
          const data = await request;
          if (disposed || pageTokens.get(key) !== token) return;
          pageRoutes.set(key, route);
          applyPage(key, data);
          prefetchedOnly.add(key);
        } catch {
          // Dropped on purpose: a visit reads again and reports its own error.
        } finally {
          if (prefetches.get(key) === request) {
            prefetches.delete(key);
            prefetchTokens.delete(key);
          }
        }
      },
      hydratePage(route, data): void {
        if (disposed) return;
        const key = settingsRouteKey(route);
        pageRoutes.set(key, route);
        pageTokens.set(key, ++nextToken);
        prefetchedOnly.delete(key);
        applyPage(key, data);
      },
      async refresh(route): Promise<void> {
        if (disposed) return;
        // A prefetch sent before the refresh may carry stale data.
        get().dropPrefetches();
        set((state) => ({
          seatCharges: {},
          refreshGeneration: state.refreshGeneration + 1,
        }));
        // Seeded bootstraps never requested this session stay as they are.
        const bootstrapKeys = Object.entries(get().bootstraps).flatMap(
          ([key, entry]) => (entry.status === 'idle' ? [] : [key]),
        );
        const routes =
          route !== undefined
            ? [route]
            : Object.keys(get().pages).flatMap((key) => {
                const cached = pageRoutes.get(key);
                return cached === undefined ? [] : [cached];
              });
        await Promise.all([
          ...bootstrapKeys.map((key) =>
            loadBootstrap(key === '' ? null : key, { force: true }),
          ),
          ...routes.map((cached) => loadPage(cached, { force: true })),
        ]);
      },
      evict(route): void {
        const key = settingsRouteKey(route);
        pageTokens.delete(key);
        // A prefetch in flight would bring the evicted data back. A visit
        // already in flight is dropped too; the next visit reads again.
        prefetches.delete(key);
        prefetchTokens.delete(key);
        prefetchedOnly.delete(key);
        set((state) => {
          if (!(key in state.pages)) return state;
          const pages = { ...state.pages };
          delete pages[key];
          return { pages };
        });
      },
      dropPrefetches(): void {
        // A visit that already took a key over keeps its own token, and the
        // organization details a prefetch wrote stay until a visit's read
        // replaces them; the caller force-reloads the page on screen.
        prefetchTokens.forEach((token, key) => {
          if (pageTokens.get(key) === token) pageTokens.delete(key);
        });
        prefetches.clear();
        prefetchTokens.clear();
        if (prefetchedOnly.size === 0) return;
        const dropped = Array.from(prefetchedOnly);
        prefetchedOnly.clear();
        for (const key of dropped) pageTokens.delete(key);
        set((state) => {
          const pages = { ...state.pages };
          for (const key of dropped) delete pages[key];
          return { pages };
        });
      },
      rememberSeatCharge(organizationId, mode): void {
        if (disposed || get().seatCharges[organizationId] === mode) return;
        set((state) => ({
          seatCharges: { ...state.seatCharges, [organizationId]: mode },
        }));
      },
      forgetSeatCharge(organizationId): void {
        set((state) => {
          if (!(organizationId in state.seatCharges)) return state;
          const seatCharges = { ...state.seatCharges };
          delete seatCharges[organizationId];
          return { seatCharges };
        });
      },
      rememberOrganizationDetail(organizationId, detail): void {
        if (disposed || get().organizationDetails[organizationId] === detail)
          return;
        set((state) => {
          const pages = { ...state.pages };
          for (const [key, page] of Object.entries(pages)) {
            if (
              page.data?.kind !== 'organization.members' ||
              page.data.data.detail.id !== organizationId
            )
              continue;
            // A confirmed mutation supersedes this cached Members projection
            // and any older page read still in flight.
            pageTokens.set(key, ++nextToken);
            pages[key] = {
              ...page,
              status: 'ready',
              error: null,
              data: { ...page.data, data: { ...page.data.data, detail } },
              revision: page.revision + 1,
            };
          }
          return {
            pages,
            organizationDetails: {
              ...state.organizationDetails,
              [organizationId]: detail,
            },
          };
        });
      },
      selectOrganization(organizationId): void {
        if (disposed) return;
        set({ selectedOrganizationId: organizationId });
        if (accountId !== null)
          storage?.writeOrganizationId(accountId, organizationId);
      },
      restoreOrganization(bootstrap): string | null {
        if (accountId === null || storage === undefined) return null;
        const persisted = storage.readOrganizationId(accountId);
        if (persisted === null) return null;
        if (settingsBootstrapHasOrganization(bootstrap, persisted))
          return persisted;
        storage.writeOrganizationId(accountId, null);
        return null;
      },
    };
  });

  return Object.assign(store, {
    [CLIENT_STORE_DISPOSE]: (): void => {
      disposed = true;
      bootstrapTokens.clear();
      pageTokens.clear();
      pageRoutes.clear();
      prefetches.clear();
      prefetchTokens.clear();
      prefetchedOnly.clear();
    },
  });
}

/** The bootstrap entry for an organization, `idle` until requested. */
export function selectSettingsBootstrap(
  state: SettingsStoreState,
  organizationId: string | null | undefined,
): SettingsBootstrapEntry {
  return state.bootstraps[bootstrapKey(organizationId)] ?? IDLE_BOOTSTRAP;
}
