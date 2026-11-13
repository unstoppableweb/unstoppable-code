'use client';

import { useState, type JSX } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { X } from '@canopy/ui-shared/icons/AppIcons';
import type { BillingChrome } from '@canopy/protocol/settings/billing';
import { SettingsLink } from '../host/settings-host';

/**
 * Whole days remaining until an ISO instant, clamped at zero. Mirrors the
 * ceil logic in {@link import('./trial-badge-label').trialDaysLeft} so the
 * banner's "< 7 days" cutoff stays consistent with the account/org trial badges.
 */
function daysUntil(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000));
}

/**
 * Human-friendly trial end date, e.g. "August 1, 2026". Formatted in `UTC` on
 * purpose: this is a `'use client'` component that is still server-rendered for
 * the initial HTML, so a locale/runtime-relative timezone would format
 * differently on the server (UTC) than during client hydration (the viewer's
 * local zone) and trip a React hydration mismatch for an `endsAt` near a day
 * boundary. Pinning the zone keeps SSR and hydration identical.
 */
function formatEndsAt(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(ms));
}

/** Only surface as a real nudge when the trial is close to lapsing. */
const TRIAL_ENDING_THRESHOLD_DAYS = 7;

export interface TrialEndingBannerProps {
  billing: BillingChrome;
}

/**
 * App-wide nudge shown across every authenticated route (including the compact
 * Portal chrome) when a user's trial is about to lapse and they have no card on
 * file. Trial/plan/payment state is server-resolved and passed in as a prop (no
 * client fetch), so the banner never flashes in and out during hydration.
 *
 * Renders nothing unless the trial is active, ends in under a week, and no
 * payment method is saved. Dismissal is session-local (component state) and
 * intentionally not persisted, so it reappears on reload and stays a real nudge.
 */
export function TrialEndingBanner({
  billing,
}: TrialEndingBannerProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);

  const trial = billing.trial;
  // Guard against an unparseable `endsAt`: without this, `daysUntil` clamps to
  // 0 (< 7), which would surface a banner with an empty "ends ." date label.
  const endsAtValid = trial != null && !Number.isNaN(Date.parse(trial.endsAt));
  // Free app access has no trial to end and no plan to keep. The chrome
  // already clears `trial` then; this guard keeps the banner off even if a
  // future chrome field carries one.
  const shouldShow =
    !dismissed &&
    billing.freeAccess !== true &&
    trial?.active === true &&
    endsAtValid &&
    daysUntil(trial.endsAt) < TRIAL_ENDING_THRESHOLD_DAYS &&
    !billing.hasPaymentMethod;

  if (!shouldShow || !trial) {
    return null;
  }

  const endsAtLabel = formatEndsAt(trial.endsAt);
  const planLabel = billing.planDisplayName
    ? `your ${billing.planDisplayName} features`
    : 'your plan features';

  return (
    <div
      data-testid="trial-ending-banner"
      className="flex w-full items-center justify-center gap-x-3 gap-y-1 border-b bg-accent-subtle px-4 py-2 text-s fg-primary"
    >
      <p className="text-center">
        Your trial ends {endsAtLabel}. Add a payment method to keep {planLabel}.{' '}
        <SettingsLink
          href="/account"
          className="font-medium fg-accent-strong underline underline-offset-2 hover:no-underline"
        >
          Add payment method
        </SettingsLink>{' '}
        <span aria-hidden="true" className="fg-secondary">
          ·
        </span>{' '}
        <SettingsLink
          href="/pricing"
          className="font-medium fg-accent-strong underline underline-offset-2 hover:no-underline"
        >
          View plans
        </SettingsLink>
      </p>
      <Button
        type="button"
        variant="ghost"
        size="compact"
        iconOnly
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        data-settings-control="dismiss"
        className="-my-1"
      >
        <X size={16} aria-hidden="true" />
      </Button>
    </div>
  );
}
