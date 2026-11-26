'use client';

import type { JSX } from 'react';
import { useSettingsSearchParams } from '../host';
import { DigestPreferencesSection } from './digest-preferences-section';
import { InstallUpdateEmailsSection } from './install-update-emails-section';
import { PushPreferencesSection } from './push-preferences-section';
import { Notice } from '@canopy/ui-shared/primitives/Notice';

/**
 * `/account/notifications`: how the product reaches out to the viewer. Hosts
 * the work digest cadence toggles and the push notification opt-in. Both
 * cards load their own state; the digest card additionally hides itself
 * when the digests flag is off, which it learns from the API's 404.
 */
// `account.notifications` page data is empty, so the page takes no props
// (it still satisfies the registry's `SettingsPageProps` component type).
export function NotificationsPage(): JSX.Element {
  // The unsubscribe endpoint redirects here with `?digestUnsubscribed=1` after
  // a confirmed opt-out. Without this the redirect landed on an unchanged page
  // and the user got no acknowledgement that anything happened.
  const params = useSettingsSearchParams();
  const unsubscribed = params.get('digestUnsubscribed') === '1';
  const installUpdatesNotice = installUpdatesUnsubscribedNotice(
    params.get('installUpdatesUnsubscribed'),
  );

  return (
    <div
      className="flex flex-col gap-6"
      data-testid="account-notifications-page"
    >
      {unsubscribed && (
        <Notice intent="neutral" data-testid="digest-unsubscribed-notice">
          You have been unsubscribed. You can turn work digests back on below at
          any time.
        </Notice>
      )}
      {installUpdatesNotice && (
        <Notice
          intent="neutral"
          data-testid="install-updates-unsubscribed-notice"
        >
          {installUpdatesNotice}
        </Notice>
      )}
      <DigestPreferencesSection />
      <InstallUpdateEmailsSection />
      <PushPreferencesSection />
    </div>
  );
}

function installUpdatesUnsubscribedNotice(scope: string | null): string | null {
  if (scope === 'item') {
    return "You won't get any more update emails about that item. Emails about your other installs keep coming.";
  }
  if (scope === 'all') {
    return "You've turned off update emails for things you installed. You can turn them back on below anytime.";
  }
  return null;
}
