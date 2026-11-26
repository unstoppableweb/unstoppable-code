'use client';

import type { JSX } from 'react';
import { buttonClassName } from '@canopy/ui-shared/components';
import { PageHeader } from '@canopy/ui-shared/primitives/PageHeader';
import { SettingsLink, useSettingsPathname } from '../host';
import {
  accountNavItem,
  matchAccountNavKey,
} from '../navigation/account-nav-items';

/**
 * Names the current account page with the same label the settings rail marks
 * current, so the two cannot disagree. Detail routes keep their page's name
 * (`/account/billing/invoices/<id>` is "AI Credits"); a route the rail cannot
 * place falls back to "Account".
 *
 * A page's sole action sits here, beside its name, so the content below holds
 * only its own rows. Only the Digests archive has one: its cadence settings.
 *
 * The external-agent consent and confirmation pages name the action in their
 * own heading, so they render no account header.
 */
export function AccountPageHeader(): JSX.Element | null {
  const pathname = useSettingsPathname();
  if (
    pathname === '/account/external-agents/consent' ||
    pathname.startsWith('/account/external-agents/confirm/')
  ) {
    return null;
  }
  const item = accountNavItem(matchAccountNavKey(pathname) ?? 'account');
  return (
    <PageHeader
      inset="none"
      headingLevel="h1"
      reserveActions
      title={item.label}
      description={item.description}
      actions={
        pathname === '/account/digests' ? (
          <SettingsLink
            href="/account/notifications"
            className={buttonClassName({
              variant: 'secondary',
              size: 'compact',
            })}
            data-testid="account-digest-settings-link"
          >
            Digest settings
          </SettingsLink>
        ) : undefined
      }
    />
  );
}
