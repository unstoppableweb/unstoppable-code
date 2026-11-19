import type { JSX } from 'react';
import { RemoteControlMobileAppPromo } from '@canopy/ui-shared/components/RemoteControlMobileAppPromo';
import type { MobileAppStore } from '@canopy/ui-shared/components/StoreBadgeLink';
import { brandText } from '@/lib/brand';
import { useMobileAppPromo } from '@/hooks/useMobileAppPromo';

/**
 * Mobile app install story inside the Remote Control modal.
 *
 * This is a **deliberate download surface**: the user opened the modal looking
 * for exactly this, so it is never suppressed by activation or the snooze. It
 * is suppressed when the brand declares no listings, and for signed-out and
 * guest accounts — the two states where the modal is already asking the user to
 * sign in or start a trial, and a second CTA under that ask only splits it. See
 * `showPermanent` in `lib/mobile-app-promo.ts`; the modal subtitle names the
 * mobile app in those states instead.
 *
 * Appended once, unconditionally, as the last child of the modal body. Every
 * block above it is state-conditional, so one placement covers the connected
 * states without duplicating into branches, and the body's `space-y-4` gives
 * separation for free. Placing it first would put a promo above the primary
 * connect flow.
 */
export function RemoteControlMobileAppsCta(): JSX.Element | null {
  const { links, showPermanent } = useMobileAppPromo();

  const openStore = (_store: MobileAppStore, url: string): void => {
    void window.api.browser.openExternal({ url });
  };

  return (
    <RemoteControlMobileAppPromo
      data-testid="remote-control-mobile-apps-cta"
      brandDisplayName={brandText.appName}
      links={links}
      visible={showPermanent}
      activation={{ kind: 'callback', onActivate: openStore }}
    />
  );
}
