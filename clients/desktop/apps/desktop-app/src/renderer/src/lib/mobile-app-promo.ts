import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { isCanopyCloudConnected } from './canopy-cloud';
import type { MobileAppStoreLink } from '@canopy/ui-shared/components/StoreBadgeLink';
import {
  APPLE_APP_STORE_BADGE_DATA_URI,
  GOOGLE_PLAY_BADGE_DATA_URI,
} from '@canopy/ui-shared/assets/store-badges';
import { getBrandMobileApps } from './brand';

/** Everything the desktop mobile-app surfaces need in order to decide. */
export interface MobileAppPromoState {
  /** Declared store listings, as badge links. Empty when the brand has none. */
  links: MobileAppStoreLink[];
  /** A real cloud account that is not a device-scoped guest. */
  signedIn: boolean;
  /** An iOS/Android device token exists for the account. */
  activated: boolean;
  /**
   * Deliberate download surfaces (the Remote Control modal section). Shown to a
   * signed-in non-guest account whenever the brand declares listings, and never
   * suppressed by activation or the snooze, because the user went looking for
   * it.
   *
   * **`signedIn` is a deliberate gate, and it changed.** This section used to
   * render in the disconnected and guest states too, on the reasoning that the
   * user opened the modal looking for exactly this. In practice those are the
   * two states where the modal is already asking for something else: both carry
   * their own primary CTA ("Sign in to enable Remote Control", "Start free
   * trial"), and a pair of store badges directly beneath is a second call to
   * action pulling toward an app the account cannot pair with until it signs
   * up. The install story is not lost — the modal subtitle names the mobile app
   * for every visitor, guests included.
   *
   * So the rule is now uniform: every desktop mobile placement requires a
   * signed-in, non-guest account. What still separates this from
   * {@link MobileAppPromoState.showPromotional} is activation and the snooze,
   * neither of which suppresses a surface the user deliberately opened.
   */
  showPermanent: boolean;
  /**
   * Promotional surfaces (the home card and the CTA banner). Suppressed once
   * the account activates mobile, while snoozed, and for guests.
   */
  showPromotional: boolean;
}

export interface ResolveMobileAppPromoInput {
  account: CanopyCloudAccountPublicState | null;
  /** Live probe result. Treat an unresolved probe as "not activated". */
  activated: boolean;
  /**
   * Whether the activation probe has actually answered. Defaults to `true` so
   * existing callers that cannot observe the probe are unaffected.
   *
   * This gates the promotional surfaces because `activated` defaults to `false`
   * and the account load resolves faster than the probe: without it, an
   * already-activated user renders the card and banner for the gap between the
   * two, so the promo visibly flashes on and off at every app start.
   */
  activationResolved?: boolean;
  /** ISO-8601 deadline from `PreferencesData.mobileInstallCueSnoozedUntil`. */
  snoozedUntil?: string;
  /** Injected for tests. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Whether an account may see any activation-gated promotional surface.
 *
 * Exported so the activation probe can be skipped for accounts that can never
 * render one, without restating the predicate at the call site. Keeping the one
 * definition here is the point: the docblock on {@link resolveMobileAppPromo}
 * promises this gate cannot drift from `RemoteControlModal`'s, and a second
 * hand-written copy in a hook is exactly how that promise would quietly break.
 */
export function isMobileAppPromoEligibleAccount(
  account: CanopyCloudAccountPublicState | null,
): boolean {
  return isCanopyCloudConnected(account) && !isGuestAccount(account);
}

/** Whether an ISO deadline is still in the future. */
function isSnoozed(snoozedUntil: string | undefined, now: number): boolean {
  if (!snoozedUntil) {
    return false;
  }
  const deadline = Date.parse(snoozedUntil);
  if (Number.isNaN(deadline)) {
    return false;
  }
  return deadline > now;
}

/**
 * Pure resolver for every desktop mobile-app promotion surface.
 *
 * `signedIn` is `isCanopyCloudConnected(account) && !isGuestAccount(account)` —
 * the exact pair `RemoteControlModal` uses, so the modal's gate and this one
 * cannot drift. `GuestUpgradeNudge` gates on *guest* and these surfaces gate on
 * *signed-in non-guest*, so the two are mutually exclusive by construction.
 */
export function resolveMobileAppPromo({
  account,
  activated,
  activationResolved = true,
  snoozedUntil,
  now = Date.now(),
}: ResolveMobileAppPromoInput): MobileAppPromoState {
  const mobileApps = getBrandMobileApps();
  const links: MobileAppStoreLink[] = [];
  if (mobileApps?.appStoreUrl) {
    links.push({
      store: 'apple-app-store',
      url: mobileApps.appStoreUrl,
      badgeSrc: APPLE_APP_STORE_BADGE_DATA_URI,
    });
  }
  if (mobileApps?.playStoreUrl) {
    links.push({
      store: 'google-play',
      url: mobileApps.playStoreUrl,
      badgeSrc: GOOGLE_PLAY_BADGE_DATA_URI,
    });
  }

  const signedIn = isMobileAppPromoEligibleAccount(account);
  const declared = links.length > 0;

  return {
    links,
    signedIn,
    activated,
    showPermanent: declared && signedIn,
    showPromotional:
      declared &&
      signedIn &&
      activationResolved &&
      !activated &&
      !isSnoozed(snoozedUntil, now),
  };
}
