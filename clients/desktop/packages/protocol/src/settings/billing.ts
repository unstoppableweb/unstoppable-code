/**
 * Non-payment billing read contracts for hosted settings: the plan summary,
 * charge history, invoices, AI-credit summary (including the automatic top-up
 * SETTINGS it carries) and the ledger.
 *
 * Moved from `apps/web/src/lib/billing-api-contracts.ts`, which re-exports
 * every symbol here. Financial request contracts (setup intents, card
 * mutation, charging, automatic top-up mutation, subscription mutation and
 * plan-change quotes) deliberately stay in web: hosted settings never carries
 * them. These wire types mirror the web service DTOs rather than importing
 * them, so Prisma enums and server-only modules stay out of browser bundles.
 */

import {
  isBillingCapability,
  type BillingCapability,
  type BillingPresentation,
  type EntitlementSource,
} from '../billing/index';
import type { OrgTeamsLapseReason } from './organization';
import type {
  AiCreditsLedgerEntry,
  AiCreditsLedgerPage,
  AiCreditsOrgPoolFunding,
  AiCreditsSource,
} from '../llm-gateway/index';

/* -------------------------------------------------------------------------- */
/* Route paths                                                                */
/* -------------------------------------------------------------------------- */

/*
 * Paths below are relative to the backend API base, NOT to the site origin:
 * the `/api` segment lives in web `lib/backend-api/base.ts` alone so a split
 * deployment can point them at a separate backend origin. Web passes them to
 * `fetchBackendUrl()`; the hosted settings table prefixes `/api` itself.
 */
/** Personal billing READ route paths (all gated by `requireBillingApiEnabled`). */
export const ACCOUNT_BILLING_READ_ROUTES = {
  /** `GET` — the user's `BillingSummary`. */
  summary: '/account/billing',
  /** `GET` (cursor-paged) — the user's charge history. */
  history: '/account/billing/history',
  /** `GET` (cursor-paged) — the user's derived billing-period invoices. */
  invoices: '/account/billing/invoices',
  /** `GET` — the personal AI-credits `CreditsSummary`. */
  credits: '/account/billing/credits',
  /** `GET` (cursor-paged) — the personal AI-credit ledger. */
  creditsLedger: '/account/billing/credits/ledger',
} as const;

function pagedPath(
  base: string,
  opts?: { limit?: number; cursor?: string | null },
): string {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) {
    params.set('limit', String(opts.limit));
  }
  if (opts?.cursor) {
    params.set('cursor', opts.cursor);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/** Build the paged history URL with optional `limit` / `cursor` query params. */
export function billingHistoryPath(opts?: {
  limit?: number;
  cursor?: string | null;
}): string {
  return pagedPath(ACCOUNT_BILLING_READ_ROUTES.history, opts);
}

/** Build the paged invoices URL with optional `limit` / `cursor` query params. */
export function billingInvoicesPath(opts?: {
  limit?: number;
  cursor?: string | null;
}): string {
  return pagedPath(ACCOUNT_BILLING_READ_ROUTES.invoices, opts);
}

/* -------------------------------------------------------------------------- */
/* Wire types — mirror the service DTOs                                       */
/* -------------------------------------------------------------------------- */

/** Plan pricing model. Mirrors the service `BillingModel`. */
export type BillingModel = 'FLAT' | 'PER_SEAT';

/** Live subscription status. Mirrors the service `BillingLiveStatus`. */
export type BillingLiveStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';

/** Current plan display. Mirrors `BillingSummaryPlan`. */
export interface BillingSummaryPlan {
  key: string;
  displayName: string;
  billingModel: BillingModel;
}

/** Cached default-card display on a summary. Mirrors `BillingSummaryPaymentMethod`. */
export interface BillingSummaryPaymentMethod {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** Active trial window from entitlements. */
export interface BillingSummaryTrial {
  active: boolean;
  endsAt: string;
}

/**
 * An organization the signed-in account belongs to, resolved server-side and
 * passed into the account billing panel. When the user is a member of any org,
 * the panel shows that the org is responsible for billing instead of a personal
 * payment-method / add-card flow. `canManageBilling` is true for members who can
 * open the org billing page (OWNER / ADMIN) and gates the "Manage billing" CTA.
 */
export interface AccountBillingOrg {
  id: string;
  name: string;
  canManageBilling: boolean;
}

/**
 * A pending cancellation on a live subscription. Mirrors the service
 * `PendingCancellationSummary`.
 *
 * A pending-cancel subscription stays `ACTIVE` (or `TRIALING`) until the renewal
 * sweep transitions it, so `BillingSummary.status` alone cannot express this.
 */
export interface PendingCancellation {
  /** ISO date the plan ends and access stops. */
  effectiveAt: string;
  /** ISO date the cancellation was recorded, when known. */
  requestedAt: string | null;
}

/**
 * True when a quoted cancellation end date has already elapsed.
 *
 * Shared by every surface that renders a pending cancellation, so none of them
 * can promise access "until" a date in the past. The server cancels a lapsed
 * subscription immediately (`cancellation-service.ts`), but a short window
 * still exists — a flagged `TRIALING` row past its trial end, or an `ACTIVE`
 * row between period end and the hourly renewal sweep.
 *
 * Invalid / unparseable dates are treated as NOT lapsed: the callers use this
 * to swap in a dateless variant, and an unparseable string is already handled
 * by the normal formatting path.
 *
 * SSR NOTE: the `now` default is read at call time, so a caller rendered on both
 * the server and the client can in principle straddle `effectiveAt` and produce
 * a hydration mismatch. `now` is injectable precisely so a caller that needs a
 * deterministic first paint CAN pin it. Every current caller accepts the
 * sub-second boundary window knowingly; React keeps the client copy.
 */
export function isCancellationLapsed(effectiveAt: string, now?: Date): boolean {
  const end = new Date(effectiveAt).getTime();
  if (Number.isNaN(end)) {
    return false;
  }
  return end <= (now ?? new Date()).getTime();
}

/** The account billing summary. Mirrors the service `BillingSummary`. */
export interface BillingSummary {
  plan: BillingSummaryPlan | null;
  status: BillingLiveStatus | null;
  trial: BillingSummaryTrial | null;
  nextBillingDate: string | null;
  nextBillingAmountUsd: number | null;
  /**
   * USD amount to subscribe to the default paid tier (Pro) now — the "Pay $X"
   * figure for the account CTA when `nextBillingAmountUsd` is null (free user).
   * Optional/omittable so pre-field payloads stay valid; null for orgs.
   */
  upgradeChargeUsd?: number | null;
  seatCount: number | null;
  paymentMethod: BillingSummaryPaymentMethod | null;
  walletBalanceUsd: number;
  capabilities: BillingCapability[];
  coverageNotes: string[];
  /**
   * Set when the live subscription is flagged to end at period close.
   *
   * Optional/omittable so payloads serialized before this field existed still
   * narrow cleanly through `isBillingSummary`; treat `undefined` as "no pending
   * cancellation".
   */
  pendingCancellation?: PendingCancellation | null;
  /**
   * True when the live subscription is an admin-granted complimentary plan.
   * Optional so payloads from servers that predate the field still narrow;
   * treat `undefined` as `false`.
   */
  complimentary?: boolean;
  /**
   * When an organization's trial ended (org path only). Mirrors the service
   * `BillingSummary.trialEndedAt`; optional so personal and pre-field
   * payloads still narrow.
   */
  trialEndedAt?: string | null;
  /**
   * Why an organization lost coverage, or null while it has coverage (org
   * path only). Mirrors the service `BillingSummary.lapseReason`.
   */
  lapseReason?: OrgTeamsLapseReason | null;
}

/**
 * A single billing charge. Mirrors the service `ChargeHistoryItem`. The Prisma
 * `BillingChargeKind` / `BillingChargeStatus` enums are represented as strings
 * to keep this module free of server-only imports.
 */
export interface ChargeHistoryItem {
  id: string;
  kind: string;
  status: string;
  amountUsd: number;
  /**
   * Σ of this charge's SUCCEEDED reversals (`refund-service.ts`). `0` for the
   * overwhelming majority of rows.
   *
   * `status` alone cannot describe a PARTIAL refund, since a charge only flips
   * to `REFUNDED` once reversals cover the full amount.
   *
   * OPTIONAL on the wire: during a rolling deploy a new bundle can be served
   * by an old pod that never emits it. Absent means "old server, no refund
   * data" and consumers default to `0`. `null` is admitted for the same reason
   * `isOptionalNumber` accepts it.
   */
  amountRefundedUsd?: number | null;
  currency: string;
  description: string | null;
  seatCount: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  createdAt: string;
}

/** A cursor-paged slice of charge history. Mirrors the service `ChargePage`. */
export interface ChargePage {
  charges: ChargeHistoryItem[];
  nextCursor: string | null;
}

/**
 * Honest billing status for an invoice window. Mirrors `InvoiceStatus` in
 * `@canopy/ui-shared/lib/invoice-display`, whose exhaustive label map is the
 * display source of truth; a web unit test keeps the two lists identical.
 * Protocol cannot import the display package, so the list is declared here.
 */
export const INVOICE_STATUSES = [
  'PAID',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'NO_CHARGES',
  'DUE',
  'FREE_TRIAL',
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Narrow a wire value to a known {@link InvoiceStatus}. */
export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return INVOICE_STATUSES.some((status) => status === value);
}

/**
 * One derived billing-period invoice row. Mirrors the service
 * `InvoiceListItem` (`invoice-service.ts`). Invoices are derived at read time
 * from charge cycle bounds — there is no `BillingInvoice` table.
 */
export interface InvoiceListItem {
  /** `YYYY-MM-DD` (UTC) — the shareable URL segment. */
  id: string;
  /** `INV-YYYYMMDD` — a derived display string. */
  number: string;
  issuedAt: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: InvoiceStatus;
  /**
   * The in-progress period — the UI shows a `Current` badge instead of status,
   * except `DUE`, which renders beside it.
   */
  isCurrent: boolean;
  totalUsd: number;
  amountPaidUsd: number;
  /** Optional on the wire for the same rolling-deploy reason as `ChargeHistoryItem`. */
  amountRefundedUsd?: number | null;
  lineItemCount: number;
  cardBrand: string | null;
  cardLast4: string | null;
}

/** A cursor-paged slice of invoices. Mirrors the service `InvoicePage`. */
export interface InvoicePage {
  invoices: InvoiceListItem[];
  nextCursor: string | null;
}

/** One charge on an invoice document. Mirrors the service `InvoiceLineItem`. */
export interface InvoiceLineItem {
  /** Charge `externalId`. */
  id: string;
  kind: string;
  status: string;
  description: string | null;
  quantity: number | null;
  unitPriceUsd: number | null;
  /** GROSS; reversals are disclosed per line and settled in the totals. */
  amountUsd: number;
  amountRefundedUsd: number;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  /** The one date the UI formats LOCALLY, matching Transactions. */
  chargedAt: string;
  cardBrand: string | null;
  cardLast4: string | null;
}

/** Who an invoice is addressed to. Mirrors the service `InvoiceBillTo`. */
export interface InvoiceBillTo {
  kind: 'user' | 'organization';
  name: string;
  email: string | null;
}

/** One `(reason, modelVersion)` usage group. Mirrors `InvoiceCreditUsageGroup`. */
export interface InvoiceCreditUsageGroup {
  key: string;
  label: string;
  reason: string;
  modelVersion: string | null;
  entryCount: number;
  creditsUsed: number;
}

/** Non-`USAGE` ledger activity by transaction type. Mirrors `InvoiceCreditAddedGroup`. */
export interface InvoiceCreditAddedGroup {
  transactionType: string;
  label: string;
  entryCount: number;
  /** Signed: grants/purchases are positive, expirations negative. */
  creditsAdded: number;
}

/** Informational credit activity for one invoice period. Never USD. */
export interface InvoiceCreditActivity {
  usageGroups: InvoiceCreditUsageGroup[];
  totalUsedCredits: number;
  addedGroups: InvoiceCreditAddedGroup[];
  totalAddedCredits: number;
}

/**
 * The shareable invoice document for one billing period. Mirrors the service
 * `InvoiceDetail`. There is no detail API route: the page loader (and the
 * hosted `settings.pageData` read) produce it.
 */
export interface InvoiceDetail {
  id: string;
  number: string;
  issuedAt: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: InvoiceStatus;
  isCurrent: boolean;
  billTo: InvoiceBillTo;
  lineItems: InvoiceLineItem[];
  subtotalUsd: number;
  /** Literal 0 — Canopy collects no tax today. */
  taxUsd: number;
  totalUsd: number;
  amountPaidUsd: number;
  amountRefundedUsd: number;
  /** Informational ONLY; never folded into the USD totals. */
  credits: InvoiceCreditActivity;
}

/**
 * The plan pill and coverage chrome the account billing page shows. Mirrors
 * the web `BillingChrome` (`lib/billing/billing-chrome.ts`, a server module).
 */
export interface BillingChrome {
  planDisplayName: string | null;
  trial: { active: boolean; endsAt: string } | null;
  hasPaymentMethod: boolean;
  planKey?: string | null;
  source?: EntitlementSource;
  displayPlan?: {
    key: string;
    displayName: string;
    source: EntitlementSource;
  } | null;
  billingPresentation?: BillingPresentation | null;
  pendingCancellation?: PendingCancellation | null;
  /** @deprecated Retained for shipped clients, which require it; the server always sends `true`. */
  freeAccess?: boolean;
}

/**
 * Card display fields returned after a confirm. Mirrors the service
 * `PaymentMethodSummary` (all fields nullable, unlike the non-null summary card).
 * Display only; the confirm request itself stays in web.
 */
export interface PaymentMethodSummary {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/* -------------------------------------------------------------------------- */
/* AI-credits wire types (CAN-1040 / T17)                                     */
/* -------------------------------------------------------------------------- */

/** Remaining spendable credits bucketed by origin. Mirrors `ConsumptionSplit`. */
export interface CreditsConsumptionSplit {
  dripCredits: string;
  allotmentCredits: string;
  purchasedCredits: string;
}

/** Auto-top-up settings (read). Mirrors the service `AutoTopUpSettings`. */
export interface CreditsAutoTopUpSettings {
  enabled: boolean;
  amountUsd: number | null;
  thresholdCredits: number | null;
  maxMonthlyUsd: number | null;
  disabledReason: string | null;
}

/**
 * Which rule produced the "credits used" window. Mirrors the service
 * `CreditsSummaryUsageWindowKind`. Append-only: `isCreditsSummary` rejects a
 * kind not listed here, so a kind is never renamed or reused.
 *
 * - `billing-cycle`: the live subscription (or covering org) cycle.
 * - `calendar-month`: the UTC month, for an account with no subscription.
 * - `rolling-30-days`: the 30 days ending now, while free access is on.
 */
export const CREDITS_USAGE_PERIOD_KINDS = [
  'billing-cycle',
  'calendar-month',
  'rolling-30-days',
] as const;

export type CreditsUsagePeriodKind =
  (typeof CREDITS_USAGE_PERIOD_KINDS)[number];

/**
 * AI-credits wallet / pool summary. Mirrors the service `CreditsSummary`
 * (`credits-summary-service.ts`). `seatCount` / `perSeatAllotmentCredits` are
 * present only on the org pool summary.
 */
export interface CreditsSummary {
  balanceCredits: number;
  balanceUsd: number;
  /**
   * Per-credit SALE price (USD) the owner pays when buying credits, so the
   * top-up modal can preview "you'll receive ~N credits". Optional on the wire:
   * an older server omits it, so consumers MUST default a missing value to the
   * free list price ($0.60).
   */
  creditPriceUsd?: number;
  split: CreditsConsumptionSplit;
  allotmentTotalCredits: number;
  /**
   * @deprecated Retired daily free-credit cap, always `0` (CAN-4771). Kept
   * because shipped clients require it. The server also still sends a retired
   * `dailyDrip` object that current clients ignore.
   */
  dailyDripCapCredits: number;
  nextRefillAt: string | null;
  nextAllotmentAt: string | null;
  autoTopUp: CreditsAutoTopUpSettings;
  monthlySpentUsd: number;
  /** Credits consumed in the current billing period (Σ USAGE debits). */
  usedThisCycleCredits: number;
  /** Start of the window `usedThisCycleCredits` is measured over (ISO). */
  usagePeriodStart: string;
  /** End of that window (ISO), or null for the calendar-month fallback. */
  usagePeriodEnd: string | null;
  /** Which rule produced the window — drives the copy. */
  usagePeriodKind: CreditsUsagePeriodKind;
  /** ISO start of next month — the auto-top-up spend meter's CALENDAR reset. */
  monthlyResetAt: string;
  activeSource: AiCreditsSource;
  udLinked: boolean;
  /** Eligible org pool covering an empty personal wallet, when present. */
  orgPool?: AiCreditsOrgPoolFunding | null;
  seatCount?: number;
  perSeatAllotmentCredits?: number;
}

/** A cursor-paged slice of AI-credit ledger history. Mirrors `AiCreditsLedgerPage`. */
export type CreditsLedgerPage = AiCreditsLedgerPage;

/* -------------------------------------------------------------------------- */
/* Runtime type guards                                                        */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

/**
 * A number that may be entirely ABSENT from the payload.
 *
 * Used for fields added after a wire contract shipped. During a rolling deploy a
 * new client bundle can be served by a pod still running the previous release,
 * so a hard `typeof x === 'number'` on a newly added field would fail the whole
 * guard and blank the surface it feeds. Treat absent as "old server" and let the
 * consumer default it.
 */
function isOptionalNumber(value: unknown): value is number | null | undefined {
  // `== null` covers BOTH undefined and an explicit null.
  return value == null || typeof value === 'number';
}

function isBillingSummaryPlan(value: unknown): value is BillingSummaryPlan {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.displayName === 'string' &&
    (value.billingModel === 'FLAT' || value.billingModel === 'PER_SEAT')
  );
}

function isBillingSummaryPaymentMethod(
  value: unknown,
): value is BillingSummaryPaymentMethod {
  return (
    isRecord(value) &&
    typeof value.brand === 'string' &&
    typeof value.last4 === 'string' &&
    typeof value.expMonth === 'number' &&
    typeof value.expYear === 'number'
  );
}

const BILLING_LIVE_STATUSES: ReadonlySet<string> = new Set([
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
]);

/** Narrow a wire value to a {@link BillingLiveStatus}. */
export function isBillingLiveStatus(
  value: unknown,
): value is BillingLiveStatus {
  return typeof value === 'string' && BILLING_LIVE_STATUSES.has(value);
}

function isBillingSummaryTrial(value: unknown): value is BillingSummaryTrial {
  return (
    isRecord(value) &&
    typeof value.active === 'boolean' &&
    typeof value.endsAt === 'string'
  );
}

function isPendingCancellation(value: unknown): value is PendingCancellation {
  return (
    isRecord(value) &&
    typeof value.effectiveAt === 'string' &&
    isNullableString(value.requestedAt)
  );
}

export function isBillingSummary(value: unknown): value is BillingSummary {
  return (
    isRecord(value) &&
    (value.pendingCancellation === undefined ||
      value.pendingCancellation === null ||
      isPendingCancellation(value.pendingCancellation)) &&
    (value.plan === null || isBillingSummaryPlan(value.plan)) &&
    (value.status === null || isBillingLiveStatus(value.status)) &&
    (value.trial === null || isBillingSummaryTrial(value.trial)) &&
    isNullableString(value.nextBillingDate) &&
    isNullableNumber(value.nextBillingAmountUsd) &&
    (value.upgradeChargeUsd === undefined ||
      isNullableNumber(value.upgradeChargeUsd)) &&
    (value.complimentary === undefined ||
      typeof value.complimentary === 'boolean') &&
    isNullableNumber(value.seatCount) &&
    (value.paymentMethod === null ||
      isBillingSummaryPaymentMethod(value.paymentMethod)) &&
    typeof value.walletBalanceUsd === 'number' &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isBillingCapability) &&
    Array.isArray(value.coverageNotes) &&
    value.coverageNotes.every((n) => typeof n === 'string')
  );
}

function isChargeHistoryItem(value: unknown): value is ChargeHistoryItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.status === 'string' &&
    typeof value.amountUsd === 'number' &&
    isOptionalNumber(value.amountRefundedUsd) &&
    typeof value.currency === 'string' &&
    isNullableString(value.description) &&
    isNullableNumber(value.seatCount) &&
    isNullableString(value.periodStart) &&
    isNullableString(value.periodEnd) &&
    isNullableString(value.cardBrand) &&
    isNullableString(value.cardLast4) &&
    typeof value.createdAt === 'string'
  );
}

export function isChargePage(value: unknown): value is ChargePage {
  return (
    isRecord(value) &&
    Array.isArray(value.charges) &&
    value.charges.every(isChargeHistoryItem) &&
    isNullableString(value.nextCursor)
  );
}

function isInvoiceListItem(value: unknown): value is InvoiceListItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.number === 'string' &&
    typeof value.issuedAt === 'string' &&
    typeof value.periodStart === 'string' &&
    typeof value.periodEnd === 'string' &&
    typeof value.currency === 'string' &&
    isInvoiceStatus(value.status) &&
    typeof value.isCurrent === 'boolean' &&
    typeof value.totalUsd === 'number' &&
    typeof value.amountPaidUsd === 'number' &&
    isOptionalNumber(value.amountRefundedUsd) &&
    typeof value.lineItemCount === 'number' &&
    isNullableString(value.cardBrand) &&
    isNullableString(value.cardLast4)
  );
}

export function isInvoicePage(value: unknown): value is InvoicePage {
  return (
    isRecord(value) &&
    Array.isArray(value.invoices) &&
    value.invoices.every(isInvoiceListItem) &&
    isNullableString(value.nextCursor)
  );
}

export function isPaymentMethodSummary(
  value: unknown,
): value is PaymentMethodSummary {
  return (
    isRecord(value) &&
    isNullableString(value.brand) &&
    isNullableString(value.last4) &&
    isNullableNumber(value.expMonth) &&
    isNullableNumber(value.expYear)
  );
}

function isAiCreditsSource(value: unknown): value is AiCreditsSource {
  return value === 'unstoppable' || value === 'canopy';
}

function isCreditsConsumptionSplit(
  value: unknown,
): value is CreditsConsumptionSplit {
  return (
    isRecord(value) &&
    typeof value.dripCredits === 'string' &&
    typeof value.allotmentCredits === 'string' &&
    typeof value.purchasedCredits === 'string'
  );
}

function isCreditsAutoTopUpSettings(
  value: unknown,
): value is CreditsAutoTopUpSettings {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    isNullableNumber(value.amountUsd) &&
    isNullableNumber(value.thresholdCredits) &&
    isNullableNumber(value.maxMonthlyUsd) &&
    isNullableString(value.disabledReason)
  );
}

function isCreditsUsagePeriodKind(
  value: unknown,
): value is CreditsUsagePeriodKind {
  return CREDITS_USAGE_PERIOD_KINDS.some((kind) => kind === value);
}

export function isCreditsSummary(value: unknown): value is CreditsSummary {
  return (
    isRecord(value) &&
    typeof value.balanceCredits === 'number' &&
    typeof value.balanceUsd === 'number' &&
    (value.creditPriceUsd === undefined ||
      typeof value.creditPriceUsd === 'number') &&
    isCreditsConsumptionSplit(value.split) &&
    typeof value.allotmentTotalCredits === 'number' &&
    typeof value.dailyDripCapCredits === 'number' &&
    isNullableString(value.nextRefillAt) &&
    isNullableString(value.nextAllotmentAt) &&
    isCreditsAutoTopUpSettings(value.autoTopUp) &&
    typeof value.monthlySpentUsd === 'number' &&
    typeof value.usagePeriodStart === 'string' &&
    isNullableString(value.usagePeriodEnd) &&
    isCreditsUsagePeriodKind(value.usagePeriodKind) &&
    typeof value.monthlyResetAt === 'string' &&
    isAiCreditsSource(value.activeSource) &&
    typeof value.udLinked === 'boolean' &&
    (value.orgPool === undefined ||
      value.orgPool === null ||
      (isRecord(value.orgPool) &&
        typeof value.orgPool.orgId === 'string' &&
        typeof value.orgPool.orgName === 'string')) &&
    (value.seatCount === undefined || typeof value.seatCount === 'number') &&
    (value.perSeatAllotmentCredits === undefined ||
      typeof value.perSeatAllotmentCredits === 'number')
  );
}

export function isCreditsAutoTopUpSettingsResponse(
  value: unknown,
): value is CreditsAutoTopUpSettings {
  return isCreditsAutoTopUpSettings(value);
}

/**
 * Structural guard for one customer-facing ledger row.
 *
 * CAN-2300 — the checked field set is exactly the customer contract and must
 * stay that way: `description` is a safe display string, and the privileged
 * audit fields (`internalReason`, `transactionType`, `grantedByAdminId`) live
 * only on the staff read. The guard is intentionally non-exhaustive about extra
 * keys, so it neither requires nor blesses them; do not widen it to accept the
 * admin shape on a customer surface.
 */
function isCreditsLedgerEntry(value: unknown): value is AiCreditsLedgerEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.credits === 'number' &&
    (value.source === undefined || typeof value.source === 'string') &&
    (value.description === undefined || typeof value.description === 'string')
  );
}

export function isCreditsLedgerPage(
  value: unknown,
): value is CreditsLedgerPage {
  return (
    isRecord(value) &&
    typeof value.email === 'string' &&
    Array.isArray(value.entries) &&
    value.entries.every(isCreditsLedgerEntry) &&
    (value.nextCursor === undefined || typeof value.nextCursor === 'string')
  );
}
