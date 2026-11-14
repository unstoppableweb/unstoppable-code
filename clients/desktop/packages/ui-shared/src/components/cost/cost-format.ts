import {
  COST_BILLING_BASES,
  COST_SOURCES,
  type CostBillingBasis,
  type CostSource,
  type CostTotals,
} from '@canopy/protocol/cost-view';
import { formatCredits } from '../../lib/billing-format';
import { formatCost } from '../../lib/format-usage';
import {
  COST_BILLING_COLORS,
  COST_SOURCE_COLORS,
} from '../../lib/usage-series-colors';

export type CostDimension = 'source' | 'billing';

export interface CostSegment {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

export const COST_SOURCE_LABELS: Readonly<Record<CostSource, string>> = {
  chat: 'Chat turns',
  pipeline: 'Workflow steps',
  subagents: 'Subagents',
  delegations: 'Delegations',
  background: 'Background',
};

export const COST_BILLING_LABELS: Readonly<Record<CostBillingBasis, string>> = {
  subscription: 'Subscription',
  ai_credits: 'AI Credits',
  account_proxy: 'Account proxy',
  api_key: 'API key',
  org_gateway: 'Organization gateway',
  local: 'Local',
  unknown: 'Unknown',
};

export const COST_NOT_TIED_LABEL = 'Not tied to a chat';
export const COST_NOT_PRICED_LABEL = 'Not priced';
/** An included subagent whose turn is still running has no share yet. */
export const COST_PRICED_AT_TURN_END_LABEL = 'Priced when the turn ends';

/** True while an included item waits for its turn's cost. */
export function isCostItemPending(item: {
  readonly inclusion: 'included' | 'additional';
  readonly status?: string;
  readonly usd?: number;
}): boolean {
  return (
    item.inclusion === 'included' &&
    item.status === 'running' &&
    item.usd === undefined
  );
}

/** What an attributed item with no amount shows in place of one. */
export function unpricedCostItemLabel(item: {
  readonly inclusion: 'included' | 'additional';
  readonly status?: string;
  readonly usd?: number;
}): string {
  return isCostItemPending(item)
    ? COST_PRICED_AT_TURN_END_LABEL
    : COST_NOT_PRICED_LABEL;
}

/** formatCost, except zero reads `$0.00` (formatCost prints under a cent to four places). */
export function formatCostAmount(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  return formatCost(usd);
}

/**
 * The units a host shows cost in (CAN-6180). `usd` is every amount in US
 * dollars. `credits` shows AI Credits work as credits at the ledger's burn
 * rate, with USD alongside; a credits-only account (CAN-5028) sees credits
 * for every amount and never USD.
 */
export type CostCurrency =
  | { readonly kind: 'usd' }
  | {
      readonly kind: 'credits';
      /** US dollars per AI Credit, as the ledger debits them. */
      readonly usdPerCredit: number;
      readonly creditsOnly: boolean;
    };

export const USD_COST_CURRENCY: CostCurrency = { kind: 'usd' };

/**
 * `4 credits`, `1 credit`, up to two decimals. A nonzero amount under 0.01
 * credits keeps two significant digits (`0.002 credits`), so real spend
 * never reads as zero, as formatCost keeps sub-cent dollars.
 */
export function formatCostCredits(usd: number, usdPerCredit: number): string {
  const credits =
    Number.isFinite(usd) && usd > 0 && usdPerCredit > 0
      ? usd / usdPerCredit
      : 0;
  const label =
    credits > 0 && credits < 0.01
      ? credits.toLocaleString(undefined, { maximumSignificantDigits: 2 })
      : formatCredits(credits);
  return `${label} ${label === '1' ? 'credit' : 'credits'}`;
}

/**
 * An amount in the host's units. When `billedOnlyToAiCredits`, it reads in
 * credits with USD alongside (`4 credits · $0.60`); otherwise in USD. A
 * credits-only account reads every amount in credits.
 *
 * Whether an amount is all AI Credits is a fact about its billing, never a
 * comparison of amounts: a total and its billing buckets are rounded
 * separately, so comparing them reads float noise as other spend. Decide it
 * from a billing split with `billedOnlyToAiCredits`, or from an item's own
 * billing basis.
 */
export function formatCostAmountIn(
  usd: number,
  currency: CostCurrency,
  billedOnlyToAiCredits = false,
): string {
  if (currency.kind === 'usd') return formatCostAmount(usd);
  if (currency.creditsOnly)
    return formatCostCredits(usd, currency.usdPerCredit);
  return billedOnlyToAiCredits && usd > 0
    ? `${formatCostCredits(usd, currency.usdPerCredit)} · ${formatCostAmount(usd)}`
    : formatCostAmount(usd);
}

/** A legend or bar part in the host's units: the AI Credits part reads in credits. */
export function formatCostSegmentIn(
  segment: Pick<CostSegment, 'key' | 'value'>,
  currency: CostCurrency,
): string {
  return formatCostAmountIn(
    segment.value,
    currency,
    segment.key === 'ai_credits',
  );
}

/**
 * formatCostTotal in the host's units; `Not priced` stays as it is. A row
 * without a billing split (a model row) reads in USD, or in credits for a
 * credits-only account.
 */
export function formatCostTotalIn(
  totals: Pick<CostTotals, 'usd' | 'notPricedCount'> & {
    readonly byBilling?: CostTotals['byBilling'];
  },
  currency: CostCurrency,
): string {
  if (totals.usd === 0 && totals.notPricedCount > 0)
    return COST_NOT_PRICED_LABEL;
  return formatCostAmountIn(
    totals.usd,
    currency,
    totals.byBilling !== undefined && billedOnlyToAiCredits(totals.byBilling),
  );
}

/**
 * Whether a billing split is all AI Credits: AI Credits has spend and no
 * other billing does. The one place a split decides credits versus USD.
 */
export function billedOnlyToAiCredits(
  byBilling: CostTotals['byBilling'],
): boolean {
  return (
    byBilling.ai_credits > 0 &&
    Object.entries(byBilling).every(
      ([billing, amount]) => billing === 'ai_credits' || amount <= 0,
    )
  );
}

/** A total for display: `Not priced` when usd is 0 and notPricedCount > 0; otherwise formatCostAmount(usd). */
export function formatCostTotal(totals: {
  readonly usd: number;
  readonly notPricedCount: number;
}): string {
  if (totals.usd === 0 && totals.notPricedCount > 0) {
    return COST_NOT_PRICED_LABEL;
  }
  return formatCostAmount(totals.usd);
}

/** Whole percent of total: '0%' when total <= 0, '<1%' for a nonzero share under 1%, else Math.round. */
export function formatCostShare(value: number, total: number): string {
  if (total <= 0) return '0%';
  const share = (value / total) * 100;
  if (share > 0 && share < 1) return '<1%';
  return `${Math.round(share)}%`;
}

/** Segments in COST_SOURCES order (optionally only `sources`), with labels and COST_SOURCE_COLORS. Zero values are kept (components skip them). */
export function costSourceSegments(
  bySource: Readonly<Record<CostSource, number>>,
  sources?: readonly CostSource[],
): CostSegment[] {
  return (sources ?? COST_SOURCES).map((source) => ({
    key: source,
    label: COST_SOURCE_LABELS[source],
    value: bySource[source],
    color: COST_SOURCE_COLORS[source],
  }));
}

/** Segments in COST_BILLING_BASES order with labels and COST_BILLING_COLORS. */
export function costBillingSegments(
  byBilling: Readonly<Record<CostBillingBasis, number>>,
): CostSegment[] {
  return COST_BILLING_BASES.map((basis) => ({
    key: basis,
    label: COST_BILLING_LABELS[basis],
    value: byBilling[basis],
    color: COST_BILLING_COLORS[basis],
  }));
}

/** costSourceSegments(totals.bySource) or costBillingSegments(totals.byBilling). */
export function costTotalsSegments(
  totals: Pick<CostTotals, 'bySource' | 'byBilling'>,
  dimension: CostDimension,
): CostSegment[] {
  return dimension === 'source'
    ? costSourceSegments(totals.bySource)
    : costBillingSegments(totals.byBilling);
}

/** Bar scale 0..1: value / max, 0 when max <= 0, clamped. */
export function costBarScale(value: number, max: number): number {
  if (max <= 0) return 0;
  const scale = value / max;
  return Number.isNaN(scale) ? 0 : Math.min(Math.max(scale, 0), 1);
}

interface IsoDayParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function isoDayParts(iso: string): IsoDayParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function parseCostDate(iso: string): Date | null {
  const parts = isoDayParts(iso);
  if (parts !== null) {
    const date = new Date(0);
    date.setHours(0, 0, 0, 0);
    date.setFullYear(parts.year, parts.month - 1, parts.day);
    return date;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const timestampDate = /^(\d{4}-\d{2}-\d{2})(?=T)/.exec(iso);
  if (
    timestampDate?.[1] !== undefined &&
    isoDayParts(timestampDate[1]) === null
  ) {
    return null;
  }
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** `Oct 1` from an ISO day ('2026-10-01') or ISO timestamp, in the local calendar, en-US short month; an ISO day must not shift by time zone (parse its parts). Returns null for unparsable input. */
export function formatCostDay(iso: string): string | null {
  const parts = isoDayParts(iso);
  if (parts !== null) {
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = parseCostDate(iso);
  if (date === null) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Freshness copy: null updatedAt -> null; under 1 min -> 'Updated just now'; under 60 min -> 'Updated N min ago'; under 24 h -> 'Updated N hr ago'; else 'Updated Oct 6'. */
export function formatCostUpdated(
  updatedAt: string | null,
  now: number,
): string | null {
  if (updatedAt === null) return null;
  const updated = parseCostDate(updatedAt);
  if (updated === null) return null;

  const elapsedMs = now - updated.getTime();
  if (elapsedMs < 60_000) return 'Updated just now';

  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) return `Updated ${elapsedMinutes} min ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Updated ${elapsedHours} hr ago`;

  const day = formatCostDay(updatedAt);
  return day === null ? null : `Updated ${day}`;
}

function hasSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** A run's start: 'Today 9:12 AM', 'Yesterday 4:31 PM', else 'Oct 6 4:31 PM' (en-US, numeric hour, 2-digit minute). */
export function formatCostRunStart(startedAt: string, now: number): string {
  const started = parseCostDate(startedAt);
  if (started === null) return startedAt;

  const current = new Date(now);
  let dayLabel: string;
  if (hasSameLocalDay(started, current)) {
    dayLabel = 'Today';
  } else {
    const yesterday = new Date(current);
    yesterday.setDate(yesterday.getDate() - 1);
    dayLabel = hasSameLocalDay(started, yesterday)
      ? 'Yesterday'
      : (formatCostDay(startedAt) ?? startedAt);
  }
  const timeLabel = started.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${dayLabel} ${timeLabel}`;
}
