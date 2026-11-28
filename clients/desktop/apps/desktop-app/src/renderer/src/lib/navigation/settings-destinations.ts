import type { DesktopSettingsDeepLinkSection } from '@canopy/protocol/share-deep-link';
import { settingsRouteToPath } from '@canopy/protocol/settings';
import type { SettingsRoute } from '@canopy/protocol/settings';
import type { SettingsSection } from '@/components/settings/SettingsNav';
import {
  hostedSettingsOpenable,
  openHostedSettingsPath,
  useHostedSettingsAvailable,
} from '@/components/settings/hosted/hosted-settings-availability';
import { resolveHostedSettingsHref } from '@/components/settings/hosted/hosted-settings-location';
import {
  openAuthenticatedCloudPage,
  openAuthenticatedCloudPageReported,
} from '@/lib/openAuthenticatedCloudPage';
import { useNavigationStore } from '@/stores/navigationStore';

/**
 * Account and organization destinations inside Settings, with two
 * fallbacks for when hosted settings are not openable in this window. Each
 * helper reads availability when called, so callers never pin a layout.
 *
 * - Settings that moved to the hosted account pages fall back to the local
 *   section that owned the content before.
 * - Pages that only exist hosted (billing, members, organization pages)
 *   fall back to the web, signed in.
 */
export interface SettingsDestinationOptions {
  /** Element id the destination scrolls to once it renders. */
  readonly scrollTo?: string;
}

type HostedAccountPage =
  | 'account'
  | 'integrations'
  | 'notifications'
  | 'profile';

function openSettingsDestination(
  hostedPage: HostedAccountPage,
  localSection: SettingsSection,
  options: SettingsDestinationOptions,
): void {
  const navigation = useNavigationStore.getState();
  const { scrollTo } = options;
  if (hostedSettingsOpenable()) {
    const route: SettingsRoute = { scope: 'account', page: hostedPage };
    if (scrollTo === undefined) {
      navigation.openAccountOrganizationSettings(route);
    } else {
      navigation.openAccountOrganizationSettings(route, { scrollTo });
    }
    return;
  }
  if (scrollTo === undefined) {
    navigation.openSettings(localSection);
  } else {
    navigation.openSettings(localSection, { scrollTo });
  }
}

/** The cloud account sign-in, guest merge and recovery row. */
export function openCloudAccountSettings(
  options: SettingsDestinationOptions = {},
): void {
  openSettingsDestination('account', 'account', options);
}

/** GitHub and Linear on this computer. */
export function openIntegrationSettings(
  options: SettingsDestinationOptions = {},
): void {
  openSettingsDestination('integrations', 'account', options);
}

/** In-app, OS and promotional notification settings. */
export function openNotificationSettings(
  options: SettingsDestinationOptions = {},
): void {
  openSettingsDestination('notifications', 'notifications', options);
}

/** The personal-catalog sync switch. */
export function openPersonalCatalogSettings(
  options: SettingsDestinationOptions = {},
): void {
  openSettingsDestination('profile', 'privacy', options);
}

/**
 * Where copy should send someone for the cloud account or GitHub and
 * Linear, matching the rail they will see. A hook so the copy follows the
 * rail when the hosted client changes after first render.
 */
export function useSettingsLocationLabel(
  kind: 'account' | 'integrations',
): string {
  if (!useHostedSettingsAvailable()) return 'Settings → Accounts';
  return kind === 'account' ? 'Settings → Account' : 'Settings → Integrations';
}

// ---------------------------------------------------------------------------
// Hosted pages with a web fallback
// ---------------------------------------------------------------------------

/** Where an account or organization page opened. */
export type SettingsOpenResult = 'settings' | 'web';

/**
 * Runs an in-app open, reporting whether it opened. An open that throws
 * counts as not opened, so the caller falls back instead of leaving a click
 * that does nothing.
 */
function openedInApp(open: () => boolean): boolean {
  try {
    return open();
  } catch {
    return false;
  }
}

/**
 * The in-app half of {@link openSettingsPathOrWeb}, with no web fallback:
 * opens a web account or organization settings path inside Settings and
 * returns `true`, or returns `false` when hosted settings are not openable in
 * this window, the path is not a settings page, or the open throws. For
 * callers whose fallback is something other than the signed-in web page,
 * such as a chat link that keeps its ordinary link routing.
 */
export function openSettingsPathInApp(path: string): boolean {
  return openedInApp(
    () => hostedSettingsOpenable() && openHostedSettingsPath(path),
  );
}

/**
 * Whether {@link openSettingsPathInApp} would open `path` inside Settings,
 * without opening anything, for callers that must commit to the answer
 * before they navigate.
 */
export function settingsPathOpensInApp(path: string): boolean {
  return openedInApp(
    () =>
      hostedSettingsOpenable() &&
      resolveHostedSettingsHref(path, '', '/').kind === 'settings',
  );
}

/**
 * Open a web account or organization settings path
 * (`/account/billing`, `/organization/<id>/members`): inside
 * Settings when hosted settings are openable in this window, otherwise
 * signed in on the web. Non-settings paths (`/chat`), settings
 * paths the hosted parser rejects (unknown or malformed pages) and an in-app
 * open that throws open the web, exactly once. The parser does not check page flags;
 * hosted Settings redirects hidden organization tabs after it opens.
 *
 * Returns where it went so callers can close a dialog on `'settings'` or
 * refresh when someone returns from the web.
 */
export function openSettingsPathOrWeb(path: string): SettingsOpenResult {
  if (openSettingsPathInApp(path)) return 'settings';
  openAuthenticatedCloudPage(path);
  return 'web';
}

/**
 * {@link openSettingsPathOrWeb} for call sites that build a
 * {@link SettingsRoute}. In-app it opens the route directly, without
 * re-parsing a path, so `subtab` and `factId` survive. Like the path form it
 * does not check page flags; callers only pass routes that are always shown
 * or already filtered by the account rail's flags.
 */
export function openAccountOrganizationPage(
  route: SettingsRoute,
): SettingsOpenResult {
  if (
    openedInApp(() => {
      if (!hostedSettingsOpenable()) return false;
      useNavigationStore.getState().openAccountOrganizationSettings(route);
      return true;
    })
  ) {
    return 'settings';
  }
  openAuthenticatedCloudPage(settingsRouteToPath(route));
  return 'web';
}

/**
 * Opens the Settings section the desktop host delivers. Organizations
 * (CAN-5111, from the invite lander) is a hosted page, so without hosted
 * settings in this window it opens the signed-in web list instead.
 */
export function openSettingsDeepLink(
  section: DesktopSettingsDeepLinkSection | 'approvals',
): void {
  if (section !== 'organizations') {
    useNavigationStore.getState().openSettings(section);
    return;
  }
  openAccountOrganizationPage({ scope: 'organizations' });
}

/**
 * {@link openSettingsPathOrWeb}, reporting whether a page actually opened.
 * `'settings'` resolves immediately. The web branch awaits the signed-in
 * hand-off and resolves `'failed'` when it does not open, with no
 * unauthenticated fallback, so callers can say the page could not open.
 * Never rejects: an in-app open that throws falls back to the web like the
 * other helpers, so `'failed'` always means the web hand-off failed.
 */
export async function openSettingsPathOrWebReported(
  path: string,
): Promise<SettingsOpenResult | 'failed'> {
  if (openSettingsPathInApp(path)) return 'settings';
  return (await openAuthenticatedCloudPageReported(path)) ? 'web' : 'failed';
}
