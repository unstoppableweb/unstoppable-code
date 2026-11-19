/**
 * Pure display helpers shared by every digest surface (account list, account
 * detail, org list, org detail, and both preference cards). Kept free of React
 * so the server components can format periods without pulling a client bundle.
 */

import {
  DEFAULT_DIGEST_PREFERENCES as SHARED_DEFAULT_DIGEST_PREFERENCES,
  DIGEST_DAILY_DESCRIPTION,
  digestMonthlyDescription,
  digestWeeklyDescription,
  type DigestPreferences,
} from '@canopy/protocol/digests';

export {
  digestPreferencesDescription,
  type DigestPreferencesScope,
} from '@canopy/protocol/digests';

/**
 * Cadence values as they come off the API (the Prisma `DigestCadence` enum).
 * `ON_DEMAND` rows are never a *preference* — they are minted by the user's own
 * request — but they do appear in the archive list, so the display union
 * carries all four.
 */
export type DigestCadenceKey = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ON_DEMAND';

/**
 * The three independently opt-in-able cadences, in escalating period order.
 * `ON_DEMAND` is deliberately absent: it has no toggle, only a request form.
 *
 * Descriptions are functions of the anchors because "Every Monday" is only
 * true at the default anchor. The strings themselves live in
 * `@canopy/protocol/digests` so the desktop settings surface renders the same
 * copy without importing from `apps/web`.
 */
export const DIGEST_CADENCES: ReadonlyArray<{
  key: Exclude<DigestCadenceKey, 'ON_DEMAND'>;
  /** Preference field on the API payload. */
  field: 'daily' | 'weekly' | 'monthly';
  label: string;
  describe: (preferences: DigestPreferencesValue) => string;
}> = [
  {
    key: 'DAILY',
    field: 'daily',
    label: 'Daily',
    describe: () => DIGEST_DAILY_DESCRIPTION,
  },
  {
    key: 'WEEKLY',
    field: 'weekly',
    label: 'Weekly',
    describe: (preferences) =>
      digestWeeklyDescription(preferences.weeklyAnchorDay),
  },
  {
    key: 'MONTHLY',
    field: 'monthly',
    label: 'Monthly',
    describe: (preferences) =>
      digestMonthlyDescription(preferences.monthlyAnchorDay),
  },
];

/**
 * Client-side view of the preferences payload. Aliased to the shared wire
 * contract rather than re-declared, so an added field cannot be silently
 * dropped by the card's parse step the way a hand-copied interface allowed.
 */
export type DigestPreferencesValue = DigestPreferences;

/**
 * Matches `DEFAULT_DIGEST_PREFERENCES` server-side: digests are opt-in, so an
 * absent row means every cadence is off, anchored to Monday and the 1st. Used
 * as the initial state before the first fetch resolves.
 */
export const DEFAULT_DIGEST_PREFERENCES: DigestPreferencesValue =
  SHARED_DEFAULT_DIGEST_PREFERENCES;

const CADENCE_LABELS: Readonly<Record<DigestCadenceKey, string>> = {
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  ON_DEMAND: 'On demand',
};

function isDigestCadenceKey(value: string): value is DigestCadenceKey {
  return Object.prototype.hasOwnProperty.call(CADENCE_LABELS, value);
}

/** Human label for a cadence, falling back to the raw value for safety. */
export function cadenceLabel(cadence: string): string {
  return isDigestCadenceKey(cadence) ? CADENCE_LABELS[cadence] : cadence;
}

/**
 * Render an AI credit amount for display.
 *
 * Credits are stored as `Decimal(12,6)` and one generated report usually costs
 * a fraction of a credit, so a whole-number render would report every report as
 * "0 credits". Two decimals keeps the cost legible without printing six digits
 * of ledger precision, and an amount that rounds away to nothing renders as
 * `<0.01` rather than claiming the report was free.
 */
export function formatCredits(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0 && value > 0) return '<0.01 credits';
  const amount = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2);
  return `${amount} ${rounded === 1 ? 'credit' : 'credits'}`;
}

/**
 * Periods are computed and stored in UTC, so they must be *formatted* in UTC
 * too. Formatting a UTC midnight boundary in the viewer's local zone shifts a
 * western-hemisphere reader back a day and makes "Mar 3 – Mar 9" render as
 * "Mar 2 – Mar 8".
 */
function formatUtcDay(iso: string, withYear: boolean): string {
  return new Date(iso).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/**
 * Label for a digest's covered period. `periodEnd` is exclusive (the instant
 * the period rolls over), so the last *covered* day is one millisecond earlier
 * — printing `periodEnd` directly would advertise a day the digest does not
 * describe.
 */
export function formatDigestPeriod(
  periodStart: string,
  periodEnd: string,
): string {
  const startDate = new Date(periodStart);
  const lastCoveredDay = new Date(new Date(periodEnd).getTime() - 1);
  const sameYear =
    startDate.getUTCFullYear() === lastCoveredDay.getUTCFullYear();
  const sameDay =
    sameYear &&
    startDate.getUTCMonth() === lastCoveredDay.getUTCMonth() &&
    startDate.getUTCDate() === lastCoveredDay.getUTCDate();

  if (sameDay) {
    return formatUtcDay(periodStart, true);
  }
  return `${formatUtcDay(periodStart, !sameYear)} – ${formatUtcDay(
    lastCoveredDay.toISOString(),
    true,
  )}`;
}
