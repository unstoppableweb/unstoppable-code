import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import {
  useSettingsBootstrap,
  useSettingsStoreApi,
} from '@canopy/app-state/settings';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  replayBlockClassFor,
  HOSTED_SETTINGS_PAGE_REPLAY_PRIVACY,
} from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import { hostedSettingsPageKey } from '@canopy/desktop-instrumentation/posthog-routes';
import {
  settingsRouteToPath,
  type AccountSettingsPage,
  type AccountSettingsRoute,
  type SettingsErrorCode,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import {
  AccountSettingsFrame,
  HostedSettingsErrorState,
  HostedSettingsPage,
  HostedSettingsPageContent,
  HostedSettingsRouteLoading,
  preloadOrganizationTabPages,
  SettingsPageNoticeProvider,
} from '@canopy/ui-app/settings/pages';
import { openAuthenticatedCloudPage } from '@/lib/openAuthenticatedCloudPage';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
// Imported here, inside the hosted content chunk, so the device sections
// load with hosted pages rather than with the overlay.
import { AccountDeviceSettings } from './AccountDeviceSettings';
import { HostedSettingsHostFailureNotice } from './HostedSettingsHostFailureNotice';
import {
  useHostedSettingsAccount,
  useHostedSettingsPersistedNavModel,
} from './desktop-settings-host-context';
import {
  hostedSettingsRouteKey,
  type HostedSettingsLocation,
} from './hosted-settings-location';
import {
  hostedSettingsOrganizationId,
  hostedSettingsRedirect,
} from './hosted-settings-model';
import { startHostedSettingsSignIn } from './hosted-settings-sign-in';

/**
 * Bootstrap failures that end the hosted session or rule the server out:
 * cached content is removed rather than left on screen behind them. An
 * identity mismatch between the bootstrap viewer and the desktop account is
 * reported by main as `expired`.
 */
const BLOCKING_BOOTSTRAP_CODES: ReadonlySet<SettingsErrorCode> =
  new Set<SettingsErrorCode>([
    'expired',
    'unauthenticated',
    'unsupported_server',
  ]);

function openOrganizations(): void {
  useNavigationStore
    .getState()
    .openAccountOrganizationSettings({ scope: 'organizations' });
}

/**
 * Signed out, the sign-in is the "Signed in on this computer" card on the
 * hosted Account page, so the signed-out state's Sign in goes there and
 * never leaves the app.
 */
function openAccountSignIn(): void {
  useNavigationStore
    .getState()
    .openAccountOrganizationSettings({ scope: 'account', page: 'account' });
}

/**
 * Account pages whose "On this computer" sections always render, so signed
 * out they show only those sections. Public profile's section is flag-gated
 * and the rest have none, so those keep the signed-out state.
 */
const SIGNED_OUT_DEVICE_PAGES: ReadonlySet<AccountSettingsPage> =
  new Set<AccountSettingsPage>(['account', 'notifications', 'integrations']);

type AccountScopeShellState =
  | 'loading'
  | 'signed_out'
  | 'error'
  | 'unavailable'
  | 'ready';

/**
 * Free access before the bootstrap says: the account's persisted rail entry,
 * else the renderer's flag snapshot, so the Billing page's title does not
 * flip to "AI Credits" once the bootstrap lands. (A bootstrap from an earlier
 * Settings open is already in the store.)
 */
function useFreeAccessFallback(): boolean {
  const persisted = useHostedSettingsPersistedNavModel();
  const flag = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyFreeAccessEnabled.key),
  );
  return persisted?.account.freeAccess ?? flag;
}

/**
 * An account page in every state: the account frame with this computer's
 * sections after it, around the host state or the shared page. One frame
 * stays mounted from loading to ready (or failed), so the header never moves.
 * The replay-classified wrapper encloses the frame in every state, so the
 * device sections are classified with the page they sit on. The wrapper's
 * test id names whether the shared page is showing.
 */
function AccountScopeShell({
  route,
  state,
  freeAccess,
  children,
}: {
  readonly route: AccountSettingsRoute;
  readonly state: AccountScopeShellState;
  readonly freeAccess: boolean;
  readonly children?: ReactNode;
}): JSX.Element {
  const pageKey = hostedSettingsPageKey(route);
  return (
    <div
      key={pageKey}
      // A flex column at least as tall as the scroller, so the frame's column
      // can stretch under the header.
      className={`flex min-h-full flex-col ${replayBlockClassFor(
        HOSTED_SETTINGS_PAGE_REPLAY_PRIVACY[pageKey],
      )}`}
      data-testid={
        state === 'ready' ? 'hosted-settings-content' : 'hosted-settings-frame'
      }
      data-hosted-settings-state={state === 'ready' ? undefined : state}
      data-hosted-settings-page={pageKey}
    >
      <AccountSettingsFrame
        freeAccess={freeAccess}
        after={<AccountDeviceSettings page={route.page} />}
      >
        {children}
      </AccountSettingsFrame>
    </div>
  );
}

/**
 * The frame around a non-account hosted page, keyed by the page it shows so
 * the replay classification mounts with the content it classifies. The
 * shared page passes the route it shows: while it holds the previous tab in
 * place, the frame is still that tab's.
 */
function renderHostedPageFrame(
  route: SettingsRoute,
  content: ReactNode,
): ReactNode {
  const pageKey = hostedSettingsPageKey(route);
  return (
    <div
      key={pageKey}
      className={`flex min-h-full flex-col ${replayBlockClassFor(
        HOSTED_SETTINGS_PAGE_REPLAY_PRIVACY[pageKey],
      )}`}
      data-testid="hosted-settings-content"
      data-hosted-settings-page={pageKey}
    >
      {content}
    </div>
  );
}

/**
 * A non-account route before its bootstrap is known: the route's loading
 * skeleton. An organization tab already draws its organization header and
 * page header where the page will, so nothing moves when the page arrives.
 */
function HostedRouteLoading({
  route,
}: {
  readonly route: SettingsRoute;
}): JSX.Element {
  return (
    // The same flex column as the page's frame, so the column sits where it
    // will once the page loads.
    <div className="flex min-h-full flex-col">
      <HostedSettingsRouteLoading route={route} />
    </div>
  );
}

function SignedInHostedSettingsContent({
  location,
}: {
  readonly location: HostedSettingsLocation;
}): JSX.Element {
  const store = useSettingsStoreApi();
  const freeAccessFallback = useFreeAccessFallback();
  const route = location.route;
  const organizationId = hostedSettingsOrganizationId(route);
  const bootstrap = useSettingsBootstrap(organizationId);
  const redirect =
    bootstrap.status === 'ready' && bootstrap.data !== null
      ? hostedSettingsRedirect(location, bootstrap.data)
      : null;

  const redirectRef = useRef(redirect);
  redirectRef.current = redirect;
  const redirectKey =
    redirect === null
      ? null
      : `${hostedSettingsRouteKey(redirect.route)}#${redirect.notice ?? ''}`;
  useEffect(() => {
    const target = redirectRef.current;
    if (target === null) return;
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings(target.route, {
        replace: true,
        ...(target.notice === undefined ? {} : { notice: target.notice }),
      });
  }, [redirectKey]);

  const retry = (): void => {
    const state = store.getState();
    void state.loadBootstrap(organizationId, { force: true });
    void state.loadPage(route, { force: true });
  };
  const openOnWeb = (): void =>
    openAuthenticatedCloudPage(settingsRouteToPath(route));

  const accountRoute = route.scope === 'account' ? route : null;
  const freeAccess = bootstrap.data?.account.freeAccess ?? freeAccessFallback;
  const recovery = {
    onSignIn: startHostedSettingsSignIn,
    onOpenOrganizations: openOrganizations,
    onOpenOnWeb: openOnWeb,
  };
  // Shown inside the page, below its header (the Organizations list after a
  // lost-access redirect, or a failed host action), so the header keeps its
  // place.
  // The host failure shows in every state, the lost-access one included, so
  // a sign-in started from that recovery still reports its failure.
  const notice =
    location.notice === 'access-lost' ? (
      <>
        <HostedSettingsHostFailureNotice location={location} />
        <HostedSettingsErrorState code="forbidden" />
      </>
    ) : (
      <HostedSettingsHostFailureNotice location={location} />
    );

  const error = bootstrap.status === 'error' ? bootstrap.error : null;
  const blockingError =
    error !== null &&
    (bootstrap.data === null || BLOCKING_BOOTSTRAP_CODES.has(error.code))
      ? error
      : null;
  const errorState =
    blockingError === null ? null : (
      <HostedSettingsErrorState
        code={blockingError.code}
        onRetry={retry}
        // An ended hosted session re-mints on the next explicit action; a
        // missing credential needs a real sign-in.
        onSignIn={
          blockingError.code === 'expired' ? retry : startHostedSettingsSignIn
        }
        onOpenOrganizations={openOrganizations}
        onOpenOnWeb={openOnWeb}
      />
    );
  const loading = bootstrap.data === null || redirect !== null;

  // Entering an organization loads the chunks behind its tabs, so moving
  // between them waits only on page data.
  const organizationTabs =
    bootstrap.data?.organization?.id === organizationId
      ? bootstrap.data?.organization?.visibleTabs
      : undefined;
  useEffect(() => {
    if (organizationId === null || organizationTabs === undefined) return;
    preloadOrganizationTabPages(organizationId, organizationTabs);
  }, [organizationId, organizationTabs]);

  if (accountRoute !== null) {
    // Integrations is always in the desktop rail for this computer's GitHub
    // and Linear rows. With the server's Integrations off, the shared page
    // would report lost access, so only the device sections show.
    const unavailable =
      bootstrap.data !== null &&
      accountRoute.page === 'integrations' &&
      !bootstrap.data.account.integrationsEnabled;
    const state: AccountScopeShellState =
      errorState !== null
        ? 'error'
        : loading
          ? 'loading'
          : unavailable
            ? 'unavailable'
            : 'ready';
    return (
      <SettingsPageNoticeProvider notice={notice}>
        <AccountScopeShell
          route={accountRoute}
          state={state}
          freeAccess={freeAccess}
        >
          {state === 'error' ? (
            errorState
          ) : state === 'loading' ? (
            <HostedSettingsRouteLoading route={accountRoute} />
          ) : state === 'ready' ? (
            <HostedSettingsPageContent route={route} recovery={recovery} />
          ) : null}
        </AccountScopeShell>
      </SettingsPageNoticeProvider>
    );
  }

  // A sign-in started from the blocking error keeps its failure beside it.
  if (errorState !== null)
    return (
      <>
        <HostedSettingsHostFailureNotice location={location} />
        {errorState}
      </>
    );
  if (loading) return <HostedRouteLoading route={route} />;
  return (
    // Not keyed by page: the shared page keys `renderHostedPageFrame` by the
    // page it shows, and stays mounted across tabs so it can hold the
    // previous tab while the next one loads.
    <SettingsPageNoticeProvider notice={notice}>
      <HostedSettingsPage
        route={route}
        freeAccess={freeAccess}
        recovery={recovery}
        renderFrame={renderHostedPageFrame}
      />
    </SettingsPageNoticeProvider>
  );
}

export interface HostedSettingsContentProps {
  readonly location: HostedSettingsLocation;
}

/**
 * The hosted destination's content area: the host state while the account
 * or bootstrap is unknown or failed, otherwise the shared page for the route.
 * Account pages render one account frame in every state, with this
 * computer's sections after it, so those work signed out and while hosted
 * data loads or fails. Local settings panels never depend on it.
 */
export function HostedSettingsContent({
  location,
}: HostedSettingsContentProps): JSX.Element {
  const account = useHostedSettingsAccount();
  const freeAccessFallback = useFreeAccessFallback();
  const route = location.route;
  if (account.status === 'loading') {
    if (route.scope !== 'account') return <HostedRouteLoading route={route} />;
    return (
      <AccountScopeShell
        route={route}
        state="loading"
        freeAccess={freeAccessFallback}
      >
        <HostedSettingsRouteLoading route={route} />
      </AccountScopeShell>
    );
  }
  if (account.status === 'signed_out') {
    if (route.scope !== 'account')
      return (
        <HostedSettingsErrorState
          code="signed_out"
          onSignIn={openAccountSignIn}
        />
      );
    // Where this computer's sections fill the page, they lead it with no
    // sign-in prompt (the Account device card is the sign-in). Pages with
    // nothing on this computer keep the prompt rather than render empty.
    return (
      <AccountScopeShell route={route} state="signed_out" freeAccess={false}>
        {SIGNED_OUT_DEVICE_PAGES.has(route.page) ? null : (
          <HostedSettingsErrorState
            code="signed_out"
            onSignIn={openAccountSignIn}
          />
        )}
      </AccountScopeShell>
    );
  }
  return <SignedInHostedSettingsContent location={location} />;
}
