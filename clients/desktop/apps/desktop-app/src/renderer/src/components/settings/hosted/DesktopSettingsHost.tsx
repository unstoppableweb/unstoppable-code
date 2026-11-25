import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type JSX,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type {
  AccountOrganizationSettingsClient,
  SettingsNavigationPort,
  SettingsSelectionStorage,
} from '@canopy/app-core/settings';
import {
  useOptionalCanopyClient,
  useOrgProjectsStoreApi,
} from '@canopy/app-state';
import {
  SettingsStoreProvider,
  useOptionalSettingsStoreApi,
  useSettingsStoreApi,
  type SettingsBootstrapEntry,
} from '@canopy/app-state/settings';
import type {
  AccountOrganizationSettingsApi,
  CanopyApi,
} from '@canopy/desktop-shared/types';
import {
  settingsRouteToPath,
  type SettingsBootstrap,
} from '@canopy/protocol/settings';
import { AI_CREDIT_TOP_UP_FEE_PERCENT } from '@canopy/protocol/settings/top-up-fee-default';
import {
  SettingsHostProvider,
  type SettingsBrand,
  type SettingsImageProps,
  type SettingsLinkProps,
  type SettingsLogger,
  type SettingsRouter,
  type SettingsSearchParams,
  type SettingsUiHost,
  type SettingsWorkspaceContext,
} from '@canopy/ui-app/settings/host';
import { CreditsPurchaseProvider } from '@canopy/ui-app/credits';
import {
  OrganizationSettingsSlotsProvider,
  type OrganizationPromotionDialogProps,
  type OrganizationSettingsSlots,
} from '@canopy/ui-app/settings/organization/organization-settings-slots';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import { useCanopyCloudAccountState } from '@/hooks/useCanopyCloudAccountState';
import { useCanopyOrgProjectsEnabled } from '@/hooks/useCanopyOrgProjectsEnabled';
import { brand } from '@/lib/brand';
import { openAuthenticatedCloudPage } from '@/lib/openAuthenticatedCloudPage';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { selectOrganizationWhenListed } from '@/lib/selectOrganizationWhenListed';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContext } from '@/stores/workspaceContextStore';
import { DesktopDataSharingOptIn } from '../DesktopDataSharingOptIn';
import { DesktopAiGatewayConnectionKey } from './DesktopAiGatewayConnectionKey';
import { desktopDeviceAiGatewayChoice } from '@/client/device-ai-gateway-choice';
import { useDesktopAiGatewayDeviceKey } from './useDesktopAiGatewayDeviceKey';
import { useDesktopAiGatewayDeviceUse } from './useDesktopAiGatewayDeviceUse';
import { createDesktopOrgProjectSetupSlot } from './desktopOrgProjectSetupSlot';
import { createDesktopProjectLocalSetupSlot } from '@/lib/projectLocalSetup';
import {
  DesktopSettingsHostContext,
  activateHostedSettingsAnchor,
  followHostedSettingsHref,
  hostedSettingsAccountFrom,
  openHostedSettingsExternalUrl,
  useDesktopSettingsHostContext,
  type DesktopSettingsHostContextValue,
  type HostedSettingsAccount,
} from './desktop-settings-host-context';
import {
  hostedSettingsPathname,
  hostedSettingsSearchParams,
  resolveHostedSettingsHref,
  type HostedSettingsLocation,
} from './hosted-settings-location';
import {
  parsePersistedSettingsNavModel,
  persistedSettingsNavModelFrom,
  SETTINGS_NAV_MODEL_ACCOUNT_STORAGE_KEY,
  SETTINGS_NAV_MODEL_STORAGE_PREFIX,
  type PersistedSettingsNavModel,
} from './hosted-settings-model';
import { withInvitationResponseAnnouncements } from './invitation-response-announcements';

/**
 * The desktop host for shared account and organization settings UI
 * (CAN-4386). It implements `SettingsUiHost` over the IPC settings client,
 * the navigation store and the preload bridge, and owns one shared settings
 * store per Settings session and signed-in account.
 *
 * Links and router calls that name a settings page stay inside the Settings
 * overlay; every other destination opens through the authenticated portal boundary when same-origin,
 * or the guarded external-open path otherwise. The renderer never chooses a request URL: data goes
 * through the fixed operation table.
 */

function resolveSettingsApi(): AccountOrganizationSettingsApi | null {
  if (typeof window === 'undefined') return null;
  const api: Partial<CanopyApi> | undefined = window.api;
  return api?.accountOrganizationSettings ?? null;
}

function trimOrigin(base: string | null | undefined): string {
  return base ? base.replace(/\/+$/, '') : '';
}

/** The web origin main is configured with, resolved once per mount. */
function useConfiguredWebOrigin(): string {
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    let cancelled = false;
    const api: Partial<CanopyApi> | undefined = window.api;
    const read = api?.getCanopyCloudBaseUrl;
    if (typeof read !== 'function') return undefined;
    void read()
      .then((base) => {
        if (!cancelled) setOrigin(trimOrigin(base));
      })
      .catch(() => {
        // No configured cloud: links that leave Settings open nothing.
      });
    return (): void => {
      cancelled = true;
    };
  }, []);
  return origin;
}

/**
 * How long the pointer rests on (or focus stays at) a settings link before its
 * page data is read ahead, so sweeping across the rail reads nothing.
 */
const SETTINGS_LINK_PREFETCH_INTENT_MS = 150;

/**
 * `next/link`'s prefetch, for the overlay: after a short hover or focus on a
 * link to a settings page, read that page's data into the shared store. The
 * store skips routes it already holds or is reading, and drops failures, so
 * the visit reads again and reports its own error.
 */
function useSettingsLinkPrefetch(
  href: string,
  enabled: boolean,
): {
  readonly start: () => void;
  readonly cancel: () => void;
} {
  const { webOrigin } = useDesktopSettingsHostContext();
  const store = useOptionalSettingsStoreApi();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = (): void => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    const pending = timer;
    return (): void => {
      if (pending.current !== null) clearTimeout(pending.current);
    };
  }, []);
  const start = (): void => {
    if (!enabled || store === null || timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const state = store.getState();
      if (state.accountId === null) return;
      const current = useNavigationStore.getState().settingsHostedLocation;
      const target = resolveHostedSettingsHref(
        href,
        webOrigin,
        current === null ? '/' : hostedSettingsPathname(current.route),
      );
      if (target.kind === 'settings')
        void state.prefetch(target.location.route);
    }, SETTINGS_LINK_PREFETCH_INTENT_MS);
  };
  return { start, cancel };
}

/** `next/link`'s subset over an anchor that never navigates the renderer. */
export function DesktopSettingsLink(props: SettingsLinkProps): JSX.Element {
  const {
    href,
    prefetch,
    replace,
    scroll,
    children,
    onClick,
    onAuxClick,
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur,
    target,
    ...anchorProps
  } = props;
  // Scroll restoration and window targets are browser concerns; the overlay
  // resets its own scroll per destination. Prefetch is on unless a link
  // opts out, as with `next/link`.
  void scroll;
  const { account, webOrigin } = useDesktopSettingsHostContext();
  const location = useCurrentHostedLocation();
  const intent = useSettingsLinkPrefetch(href, prefetch !== false);
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    intent.cancel();
    onClick?.(event);
    if (event.defaultPrevented) return;
    activateHostedSettingsAnchor(
      event,
      { account, webOrigin, location },
      { replace: replace === true },
    );
  };
  const handleAuxClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    onAuxClick?.(event);
    if (event.defaultPrevented) return;
    activateHostedSettingsAnchor(event, { account, webOrigin, location });
    // Suppress native auxiliary navigation, including unsupported buttons.
    event.preventDefault();
  };
  return (
    <a
      {...anchorProps}
      href={href}
      target={target}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      onPointerEnter={(event: PointerEvent<HTMLAnchorElement>) => {
        onPointerEnter?.(event);
        intent.start();
      }}
      onPointerLeave={(event: PointerEvent<HTMLAnchorElement>) => {
        onPointerLeave?.(event);
        intent.cancel();
      }}
      onFocus={(event: FocusEvent<HTMLAnchorElement>) => {
        onFocus?.(event);
        intent.start();
      }}
      onBlur={(event: FocusEvent<HTMLAnchorElement>) => {
        onBlur?.(event);
        intent.cancel();
      }}
    >
      {children}
    </a>
  );
}

/** No layout box; React bubbling includes anchors rendered through portals. */
export function DesktopSettingsAnchorBoundary({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const { account, webOrigin } = useDesktopSettingsHostContext();
  const location = useCurrentHostedLocation();
  const activate = (event: MouseEvent<HTMLDivElement>): void => {
    activateHostedSettingsAnchor(event, { account, webOrigin, location });
  };
  return (
    <div
      style={{ display: 'contents' }}
      onClick={activate}
      onAuxClick={activate}
    >
      {children}
    </div>
  );
}

const FILL_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
};

/** `next/image`'s subset over a plain `<img>`. */
function DesktopSettingsImage({
  src,
  alt,
  width,
  height,
  fill,
  sizes,
  className,
  style,
  unoptimized,
  priority,
  referrerPolicy,
  onError,
  'data-testid': testId,
}: SettingsImageProps): JSX.Element {
  // Desktop has no image optimizer, so every image is unoptimized.
  void unoptimized;
  return (
    <img
      src={src}
      alt={alt}
      width={fill ? undefined : width}
      height={fill ? undefined : height}
      sizes={sizes}
      className={className}
      style={fill ? { ...FILL_STYLE, ...style } : style}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      referrerPolicy={referrerPolicy}
      onError={onError}
      data-testid={testId}
    />
  );
}

const SELECTION_STORAGE_PREFIX = 'canopy:settings:browsed-organization:';

/**
 * Account-scoped persistence of the browsed organization. The shared store
 * validates every restored value against the current bootstrap, so a value
 * from another account or a lost membership is never used.
 */
function createDesktopSettingsSelectionStorage(): SettingsSelectionStorage {
  const keyFor = (accountId: string): string =>
    `${SELECTION_STORAGE_PREFIX}${accountId}`;
  return {
    readOrganizationId(accountId): string | null {
      try {
        return window.localStorage.getItem(keyFor(accountId));
      } catch {
        return null;
      }
    },
    writeOrganizationId(accountId, organizationId): void {
      try {
        if (organizationId === null)
          window.localStorage.removeItem(keyFor(accountId));
        else window.localStorage.setItem(keyFor(accountId), organizationId);
      } catch {
        // Storage unavailable: selection simply is not remembered.
      }
    },
  };
}

/** Account-scoped persistence of the rail-relevant bootstrap bits. */
interface DesktopSettingsNavModelStorage {
  read(accountId: string): PersistedSettingsNavModel | null;
  /** The entry of the account that wrote last, before the account is read. */
  readLastAccount(): PersistedSettingsNavModel | null;
  /** Fold a bootstrap that arrived into the account's entry. */
  write(accountId: string, bootstrap: SettingsBootstrap): void;
  /** Forget which account wrote last, on sign-out. */
  forgetLastAccount(): void;
}

/**
 * The rail's last-known rows per account, so Settings first paints the rows
 * the bootstrap will confirm. An unparseable entry, or one written for
 * another account, reads as missing and is overwritten by the next write.
 */
function createDesktopSettingsNavModelStorage(): DesktopSettingsNavModelStorage {
  const keyFor = (accountId: string): string =>
    `${SETTINGS_NAV_MODEL_STORAGE_PREFIX}${accountId}`;
  const read = (accountId: string): PersistedSettingsNavModel | null => {
    try {
      return parsePersistedSettingsNavModel(
        window.localStorage.getItem(keyFor(accountId)),
        accountId,
      );
    } catch {
      return null;
    }
  };
  return {
    read,
    readLastAccount(): PersistedSettingsNavModel | null {
      try {
        const accountId = window.localStorage.getItem(
          SETTINGS_NAV_MODEL_ACCOUNT_STORAGE_KEY,
        );
        return accountId === null ? null : read(accountId);
      } catch {
        return null;
      }
    },
    write(accountId, bootstrap): void {
      try {
        window.localStorage.setItem(
          keyFor(accountId),
          JSON.stringify(
            persistedSettingsNavModelFrom(
              accountId,
              bootstrap,
              read(accountId),
            ),
          ),
        );
        window.localStorage.setItem(
          SETTINGS_NAV_MODEL_ACCOUNT_STORAGE_KEY,
          accountId,
        );
      } catch {
        // Storage unavailable: the next restart draws the flag defaults.
      }
    },
    forgetLastAccount(): void {
      try {
        window.localStorage.removeItem(SETTINGS_NAV_MODEL_ACCOUNT_STORAGE_KEY);
      } catch {
        // Storage unavailable: nothing is remembered.
      }
    },
  };
}

/** Bootstraps loaded per account, keyed by requested organization id. */
type SettingsBootstrapCache = Map<
  string,
  Readonly<Record<string, SettingsBootstrap>>
>;

/** The keys whose bootstrap became ready with new data. */
function arrivedBootstraps(
  current: Readonly<Record<string, SettingsBootstrapEntry>>,
  previous: Readonly<Record<string, SettingsBootstrapEntry>>,
): Array<readonly [string, SettingsBootstrap]> {
  return Object.entries(current).flatMap(([key, entry]) => {
    if (entry.status !== 'ready' || entry.data === null) return [];
    const before = previous[key];
    if (before?.status === 'ready' && before.data === entry.data) return [];
    const arrived: readonly [string, SettingsBootstrap] = [key, entry.data];
    return [arrived];
  });
}

/**
 * Remembers every bootstrap the session's store loads: in memory for the
 * next Settings open, and persisted for the next app start.
 */
function SettingsBootstrapMemory({
  cache,
  navModelStorage,
}: {
  readonly cache: SettingsBootstrapCache;
  readonly navModelStorage: DesktopSettingsNavModelStorage;
}): null {
  const store = useSettingsStoreApi();
  useEffect(() => {
    const accountId = store.getState().accountId;
    if (accountId === null) return undefined;
    const remember = (
      current: Readonly<Record<string, SettingsBootstrapEntry>>,
      previous: Readonly<Record<string, SettingsBootstrapEntry>>,
    ): void => {
      for (const [key, data] of arrivedBootstraps(current, previous)) {
        cache.set(accountId, { ...cache.get(accountId), [key]: data });
        navModelStorage.write(accountId, data);
      }
    };
    remember(store.getState().bootstraps, {});
    return store.subscribe((state, previous) => {
      if (state.bootstraps !== previous.bootstraps)
        remember(state.bootstraps, previous.bootstraps);
    });
  }, [store, cache, navModelStorage]);
  return null;
}

function createSettingsLogger(scope: string): SettingsLogger {
  // Shared settings code may describe people in `meta`; keep it out of the
  // app-events log and record only the scoped message.
  const report = (message: string): void =>
    reportRendererConsoleError(`[settings:${scope}] ${message}`);
  return {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: report,
    error: report,
  };
}

function useCurrentHostedLocation(): HostedSettingsLocation | null {
  return useNavigationStore((state) => state.settingsHostedLocation);
}

function useDesktopSettingsRouter(): SettingsRouter {
  const { account, webOrigin } = useDesktopSettingsHostContext();
  const location = useCurrentHostedLocation();
  const store = useOptionalSettingsStoreApi();
  return useMemo<SettingsRouter>(
    () => ({
      push: (href): void =>
        followHostedSettingsHref(href, { account, webOrigin, location }),
      replace: (href): void =>
        followHostedSettingsHref(
          href,
          { account, webOrigin, location },
          { replace: true },
        ),
      refresh: (): void => {
        const location = useNavigationStore.getState().settingsHostedLocation;
        if (store === null || location === null) return;
        const state = store.getState();
        // A refresh follows a change (a rename, a role change), so what a
        // hover prefetched for another tab may be stale.
        state.dropPrefetches();
        void state.loadPage(location.route, { force: true });
        void state.loadBootstrap(
          location.route.scope === 'organization'
            ? location.route.organizationId
            : null,
          { force: true },
        );
      },
      back: (): void =>
        useNavigationStore.getState().backAccountOrganizationSettings(),
    }),
    [store, account, webOrigin, location],
  );
}

function useDesktopSettingsPathname(): string {
  const location = useCurrentHostedLocation();
  return location === null ? '' : hostedSettingsPathname(location.route);
}

function useDesktopSettingsSearchParams(): SettingsSearchParams {
  const location = useCurrentHostedLocation();
  return useMemo(() => hostedSettingsSearchParams(location), [location]);
}

function useDesktopSettingsNavigation(): SettingsNavigationPort {
  const { account, webOrigin } = useDesktopSettingsHostContext();
  const location = useCurrentHostedLocation();
  return useMemo<SettingsNavigationPort>(
    () => ({
      navigate: (route): void =>
        useNavigationStore.getState().openAccountOrganizationSettings(route),
      replaceQuery: (route): void =>
        useNavigationStore
          .getState()
          .openAccountOrganizationSettings(route, { replace: true }),
      back: (): void =>
        useNavigationStore.getState().backAccountOrganizationSettings(),
      href: settingsRouteToPath,
      openExternal: (href): void => {
        void openHostedSettingsExternalUrl(href, {
          account,
          webOrigin,
          location,
        });
      },
      // Provider linking completes in the browser, where the callback lands:
      // open the web Security page signed in as this account.
      openOAuth: (): void => openAuthenticatedCloudPage('/account/security'),
    }),
    [account, webOrigin, location],
  );
}

const DESKTOP_SETTINGS_BRAND: SettingsBrand = {
  id: brand.id,
  displayName: brand.displayName,
  internalName: brand.internalName,
};

function useDesktopSettingsBrand(): SettingsBrand {
  return DESKTOP_SETTINGS_BRAND;
}

function useDesktopSettingsScrollElement(): HTMLElement | null {
  return useDesktopSettingsHostContext().scrollElementRef.current;
}

function useDesktopTopUpFeePercent(): number {
  return AI_CREDIT_TOP_UP_FEE_PERCENT;
}

function useDesktopSettingsWorkspaceContext(): SettingsWorkspaceContext {
  const { account } = useDesktopSettingsHostContext();
  const enabled = useCanopyOrgProjectsEnabled();
  const workspaceContext = useWorkspaceContext();
  const accountKey = account.status === 'signed_in' ? account.accountId : null;
  return useMemo(
    () => ({
      enabled,
      accountKey,
      workspaceContext,
      selectOrganization: selectOrganizationWhenListed,
    }),
    [enabled, accountKey, workspaceContext],
  );
}

function createDesktopSettingsHost(
  client: AccountOrganizationSettingsClient,
  storage: SettingsSelectionStorage,
  webOrigin: string,
): SettingsUiHost {
  return {
    client,
    Link: DesktopSettingsLink,
    Image: DesktopSettingsImage,
    storage,
    privacy: {
      blockClassName: REPLAY_BLOCK_CLASS,
      maskClassName: REPLAY_MASK_CLASS,
    },
    webOrigin: (): string => webOrigin,
    logger: createSettingsLogger,
    useRouter: useDesktopSettingsRouter,
    usePathname: useDesktopSettingsPathname,
    useSearchParams: useDesktopSettingsSearchParams,
    useNavigation: useDesktopSettingsNavigation,
    useBrand: useDesktopSettingsBrand,
    useScrollElement: useDesktopSettingsScrollElement,
    useTopUpFeePercent: useDesktopTopUpFeePercent,
    useWorkspaceContext: useDesktopSettingsWorkspaceContext,
    // Gateway keys live in this computer's secure storage.
    AiGatewayConnectionKey: DesktopAiGatewayConnectionKey,
    deviceAiGatewayChoice: desktopDeviceAiGatewayChoice,
    useAiGatewayDeviceKey: useDesktopAiGatewayDeviceKey,
    useAiGatewayDeviceUse: useDesktopAiGatewayDeviceUse,
  };
}

/**
 * Settings host ports for one shared settings control shown outside the
 * Settings overlay, such as first run's AI gateway setup. It has no settings
 * store, so only controls that read the client and host ports belong here.
 */
export function useDesktopStandaloneSettingsHost(
  client: AccountOrganizationSettingsClient,
): SettingsUiHost {
  const webOrigin = useConfiguredWebOrigin();
  const storage = useMemo(createDesktopSettingsSelectionStorage, []);
  return useMemo(
    () => createDesktopSettingsHost(client, storage, webOrigin),
    [client, storage, webOrigin],
  );
}

// Opened from the Personal header's invite, never part of the first screen:
// the shared Create a team dialog loads only when one opens.
const LazyDesktopSettingsPromotionDialog = lazy(() =>
  import('./DesktopSettingsPromotionDialog').then((module) => ({
    default: module.DesktopSettingsPromotionDialog,
  })),
);

function DesktopSettingsPromotionDialogSlot(
  props: OrganizationPromotionDialogProps,
): JSX.Element {
  return (
    <Suspense fallback={null}>
      <LazyDesktopSettingsPromotionDialog {...props} />
    </Suspense>
  );
}

/**
 * Desktop's inline pieces for the shared organization pages. Personal-to-team
 * promotion and data-sharing opt-ins run in place; paid-seat invites have no
 * seat charge slot, so they continue on the web. The Projects page's local
 * setup reads the org projects store, which lives in the client provider,
 * so it joins per store. The project editor's scripts and hooks read the
 * project's checkout on this computer (CAN-6239).
 */
function useDesktopOrganizationSettingsSlots(): OrganizationSettingsSlots {
  const orgProjectsStore = useOrgProjectsStoreApi();
  return useMemo(
    (): OrganizationSettingsSlots => ({
      PromotionDialog: DesktopSettingsPromotionDialogSlot,
      DataSharingOptIn: DesktopDataSharingOptIn,
      orgProjectLocalSetup: createDesktopOrgProjectSetupSlot(orgProjectsStore),
      projectLocalSetup: createDesktopProjectLocalSetupSlot(),
    }),
    [orgProjectsStore],
  );
}

/**
 * Main's `settings.open` requests (agent actions and App Advisor) open the
 * hosted route. Main validated the route and the membership before sending.
 */
function useHostedSettingsOpenRequests(
  settingsApi: AccountOrganizationSettingsApi | null,
): void {
  useEffect(() => {
    if (settingsApi === null) return undefined;
    return settingsApi.onOpenRequest((route) => {
      useNavigationStore.getState().openAccountOrganizationSettings(route);
    });
  }, [settingsApi]);
}

/**
 * An account change while Settings shows an organization page leaves hosted
 * settings for the local section underneath: the organization belonged to
 * the previous account. Account pages stay put, with the previous account's
 * Back history dropped, so disconnecting on Account shows its sign-in card
 * rather than jumping to General; the new account's
 * store still starts empty because the store is keyed by account. Signing
 * in from the signed-out state keeps the destination, so the sign-in
 * recovery lands where the user asked to go.
 */
function useResetHostedDestinationOnAccountChange(
  account: HostedSettingsAccount,
): void {
  const accountId = account.status === 'signed_in' ? account.accountId : null;
  const previous = useRef<string | null>(accountId);
  useEffect(() => {
    if (account.status === 'loading') return;
    const before = previous.current;
    previous.current = accountId;
    if (before === null || before === accountId) return;
    const navigation = useNavigationStore.getState();
    if (navigation.settingsHostedLocation === null) return;
    if (navigation.settingsHostedLocation.route.scope === 'organization') {
      navigation.showLocalSettingsSection();
      return;
    }
    // Back must not return to the previous account's pages.
    useNavigationStore.setState({ settingsHostedHistory: [] });
  }, [account.status, accountId]);
}

export interface DesktopHostedSettingsProviderProps {
  readonly client: AccountOrganizationSettingsClient;
  /**
   * Changes with each Settings session, so every open starts from fresh
   * hosted data and no organization preselected.
   */
  readonly sessionKey: number;
  /** The overlay's content scroll container. */
  readonly scrollElementRef: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}

/** Hosted settings store, host ports and lifecycle for the Settings overlay. */
export function DesktopHostedSettingsProvider({
  client,
  sessionKey,
  scrollElementRef,
  children,
}: DesktopHostedSettingsProviderProps): JSX.Element {
  const { account: cloudAccount } = useCanopyCloudAccountState();
  const account = hostedSettingsAccountFrom(cloudAccount);
  const accountId = account.status === 'signed_in' ? account.accountId : null;
  const webOrigin = useConfiguredWebOrigin();
  const settingsApi = useMemo(resolveSettingsApi, []);
  // One storage adapter per Settings session: the shared store is created per
  // client, account and storage, so a new session starts a fresh store.
  const storage = useMemo(createDesktopSettingsSelectionStorage, [sessionKey]);
  const navModelStorage = useMemo(createDesktopSettingsNavModelStorage, [
    sessionKey,
  ]);
  // Read once per session and account: drawn only until a bootstrap lands.
  // Settings opened right after launch can render before the account is
  // read; the account that wrote last is the best guess until then.
  const persistedNavModel = useMemo(() => {
    if (accountId !== null) return navModelStorage.read(accountId);
    return account.status === 'loading'
      ? navModelStorage.readLastAccount()
      : null;
  }, [navModelStorage, accountId, account.status]);
  // The bootstraps earlier sessions loaded, so a reopen first paints the
  // last-known rail; each new store still reads them again.
  const [bootstrapCache] = useState<SettingsBootstrapCache>(() => new Map());
  useEffect(() => {
    if (account.status !== 'signed_out') return;
    bootstrapCache.clear();
    navModelStorage.forgetLastAccount();
  }, [account.status, bootstrapCache, navModelStorage]);
  const initialBootstraps =
    accountId === null ? undefined : bootstrapCache.get(accountId);
  // A deep link's organization is browsed from the store's creation.
  const initialRoute = useNavigationStore(
    (state) => state.settingsHostedLocation?.route ?? null,
  );
  const settingsClient = useMemo(
    () => withInvitationResponseAnnouncements(client),
    [client],
  );
  const host = useMemo(
    () => createDesktopSettingsHost(settingsClient, storage, webOrigin),
    [settingsClient, storage, webOrigin],
  );
  const context = useMemo<DesktopSettingsHostContextValue>(
    () => ({
      account,
      webOrigin,
      scrollElementRef,
      settingsApi,
      persistedNavModel,
    }),
    // `account` is a fresh object per render; its identity is status + id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      account.status,
      accountId,
      webOrigin,
      scrollElementRef,
      settingsApi,
      persistedNavModel,
    ],
  );
  const organizationSlots = useDesktopOrganizationSettingsSlots();
  const canopyClient = useOptionalCanopyClient();
  useHostedSettingsOpenRequests(settingsApi);
  useResetHostedDestinationOnAccountChange(account);
  return (
    <DesktopSettingsHostContext.Provider value={context}>
      <SettingsStoreProvider
        client={settingsClient}
        accountId={accountId}
        storage={storage}
        initialBootstraps={initialBootstraps}
        initialRoute={initialRoute}
      >
        <SettingsBootstrapMemory
          cache={bootstrapCache}
          navModelStorage={navModelStorage}
        />
        <SettingsHostProvider host={host}>
          {/* Payment CTAs hand off through the client's `creditsHandoff`,
              for the account Settings shows. */}
          <CreditsPurchaseProvider
            client={canopyClient}
            accountId={settingsApi === null ? null : accountId}
          >
            <OrganizationSettingsSlotsProvider slots={organizationSlots}>
              <DesktopSettingsAnchorBoundary>
                {children}
              </DesktopSettingsAnchorBoundary>
            </OrganizationSettingsSlotsProvider>
          </CreditsPurchaseProvider>
        </SettingsHostProvider>
      </SettingsStoreProvider>
    </DesktopSettingsHostContext.Provider>
  );
}
