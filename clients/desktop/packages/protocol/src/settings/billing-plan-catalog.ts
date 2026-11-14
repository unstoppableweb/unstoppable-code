/**
 * The typed mirror of the seeded billing plan catalog and the pure display
 * helpers read from it (plan names, ranks, owner scope, the cheapest tier for a
 * capability), plus the automatic top-up defaults.
 *
 * Moved from `apps/web/src/lib/billing/catalog.ts`, which re-exports every
 * symbol here (its migration drift test still guards {@link BILLING_PLAN_SEED}).
 * Browser-safe: shared settings UI reads plan names and tiers on both hosts.
 */

import {
  BILLING_PLAN_KEYS,
  DEFAULT_DAILY_DRIP_CAP_CREDITS,
  type BillingCapability,
  type BillingPlanKey,
  type PaidBillingPlanKey,
} from '../billing/index';

/**
 * BURN / observed-cost valuation ONLY: $0.15 of actual gateway USD cost = 1
 * credit. This is the global consumption-debit rate (gateway cost → credits
 * debited) and the basis for `getBalance().balanceUsd`, and the rate the cost
 * views show AI Credits work in (CAN-6180). It is intentionally DISTINCT from
 * the per-tier SALE price (dollars paid → credits granted for allotments +
 * top-ups), which lives on `billing_plans.credit_price_usd` — see
 * `creditPriceUsdForPlanKey`. Do NOT use this constant for the grant/sale path.
 */
export const AI_CREDIT_USD_PER_CREDIT: number = 0.15;

/**
 * Default per-refill increment (USD) used when auto-top-up is enabled without an
 * explicit `amountUsd`. The auto-top-up UX (CAN-1040 / T17) deliberately hides
 * this tuning field; on first enable the engine falls back to this catalog
 * default so it has a valid charge amount without asking the user. Must sit
 * inside `[AI_CREDIT_TOP_UP_MIN_USD, AI_CREDIT_TOP_UP_MAX_USD]`.
 */
export const AI_CREDIT_AUTO_TOP_UP_DEFAULT_AMOUNT_USD: number = 25;

/**
 * Default low-balance trigger (in credits) used when auto-top-up is enabled
 * without an explicit `thresholdCredits`. Hidden from the auto-top-up UX
 * (CAN-1040 / T17); the engine fires a refill once the spendable balance drops
 * below this many credits.
 */
export const AI_CREDIT_AUTO_TOP_UP_DEFAULT_THRESHOLD_CREDITS: number = 10;

/**
 * Default monthly auto-top-up spend cap (USD) armed when a user enables
 * auto-top-up from the wallet UI without an explicit cap. We deliberately do NOT
 * default to unlimited (CAN-1040 feedback): the first-enable experience sets a
 * sane ceiling the user can raise or clear from "Adjust limit".
 */
export const AI_CREDIT_AUTO_TOP_UP_DEFAULT_MONTHLY_CAP_USD: number = 500;

/**
 * Org credit-pool variant of {@link AI_CREDIT_AUTO_TOP_UP_DEFAULT_MONTHLY_CAP_USD}.
 * Higher because it covers a whole team rather than one person.
 */
export const AI_CREDIT_AUTO_TOP_UP_DEFAULT_ORG_MONTHLY_CAP_USD: number = 1000;

/**
 * Hidden legacy tier keys (G10, CAN-1544). These exist only so migrated ECW
 * subscriptions have a real `billing_plans` row to point at; they are
 * `visibility = HIDDEN`, never on the public pricing page, and intentionally
 * absent from every public-tier guard ({@link BILLING_PLAN_KEYS},
 * {@link isBillingPlanKey}, {@link isPaidBillingPlanKey}, {@link billingPlanRank},
 * {@link planKeyOwnerScope}) so they are not purchasable or ranked.
 */
export type LegacyBillingPlanKey = `legacy-${'starter' | 'pro' | 'ultra'}`;

/** Any plan key — native public or hidden legacy. */
export type AnyBillingPlanKey = BillingPlanKey | LegacyBillingPlanKey;

/** Billing model for a plan: flat price or per-seat. */
export type BillingPlanModel = 'FLAT' | 'PER_SEAT';

/**
 * Typed mirror of a seeded `billing_plans` row. Only the columns needed by
 * TypeScript callers are modelled here; the DB row carries additional
 * bookkeeping columns (visibility, active, timestamps, id, description).
 */
export interface BillingPlanSeed<K extends string = BillingPlanKey> {
  key: K;
  displayName: string;
  billingModel: BillingPlanModel;
  monthlyPriceUsd: number;
  creditAllotmentCredits: number;
  /** Per-tier SALE price of one AI credit in USD (grant/sale path, not burn). */
  creditPriceUsd: number;
  dailyDripCapCredits: number;
  capabilities: readonly BillingCapability[];
  sortOrder: number;
}

/**
 * The four plans, as the effective catalog looks after the seed INSERT and the
 * 20260712000000_reprice_billing_plans + 20260718000000_grant_remote_control_capability
 * + 20260719000000_add_credit_price_and_reprice + 20260720000000_enable_daily_drip
 * + 20260728000000_add_enterprise_tier_and_uniform_credit_price
 * + 20260902000000_raise_daily_drip_cap_to_25
 * + 20261020000000_lower_daily_drip_cap_to_10
 * + 20261104180000_zero_daily_drip_cap UPDATEs — keep this mirror in sync with
 * that end state.
 *
 * Economics (the two conversions are now split apart):
 *   - `creditPriceUsd` is the per-tier SALE price (dollars paid → credits
 *     granted for allotments + top-ups): free/no-plan $0.60, and a uniform
 *     $0.20/credit across every paid tier (Pro / Business / Enterprise). The
 *     per-tier column is kept so tiers can diverge later; today they all share
 *     the $0.20 sale price. Burn / consumption (gateway cost → credits debited)
 *     uses the global $0.15 valuation in {@link AI_CREDIT_USD_PER_CREDIT}, NOT
 *     this.
 *   - `creditAllotmentCredits` is the included monthly credit grant, sized so its
 *     dollar-value at the $0.20 sale price meets-or-exceeds the plan's monthly
 *     price: 0 / 100 credits (= $20, covering the $19 Pro tier) / 150 credits per
 *     seat (= $30, covering the $29 Business seat) / 250 credits per seat (= $50,
 *     covering the $49 Enterprise seat).
 *   - `dailyDripCapCredits` = {@link DEFAULT_DAILY_DRIP_CAP_CREDITS} (0) for all
 *     native and legacy plans: free AI credits are retired (CAN-4763), so no
 *     user, guest, or external read is granted a daily drip. Business is
 *     per-seat at $29/seat and Enterprise is per-seat at $49/seat (mirroring
 *     the Business capabilities plus a display-only $100k annual-commitment
 *     bullet). Changing the daily amount means updating both the constant and
 *     the `billing_plans.daily_drip_cap_credits` value on every native and
 *     legacy plan row, via a data migration (see
 *     `20260902000000_raise_daily_drip_cap_to_25`,
 *     `20261020000000_lower_daily_drip_cap_to_10` and
 *     `20261104180000_zero_daily_drip_cap`): the desktop main placeholder reads
 *     the constant, while the actual drip grant, balance, and web pricing read
 *     the row.
 * This mirror is native-only (`free` / `individual` / `business` /
 * `enterprise`). The hidden legacy tiers (G10, CAN-1544) live in
 * {@link LEGACY_BILLING_PLAN_SEED} and are seeded by the
 * 20260721000000_seed_hidden_legacy_plans migration; they never appear here so
 * the public-tier code paths that read BILLING_PLAN_SEED stay native-only.
 */
export const BILLING_PLAN_SEED: readonly BillingPlanSeed[] = [
  {
    key: 'free',
    displayName: 'Free',
    billingModel: 'FLAT',
    monthlyPriceUsd: 0,
    creditAllotmentCredits: 0,
    creditPriceUsd: 0.6,
    dailyDripCapCredits: DEFAULT_DAILY_DRIP_CAP_CREDITS,
    capabilities: [],
    sortOrder: 0,
  },
  {
    key: 'individual',
    displayName: 'Pro',
    billingModel: 'FLAT',
    monthlyPriceUsd: 19,
    creditAllotmentCredits: 100,
    creditPriceUsd: 0.2,
    dailyDripCapCredits: DEFAULT_DAILY_DRIP_CAP_CREDITS,
    capabilities: ['data_sync_control', 'priority_support', 'remote_control'],
    sortOrder: 1,
  },
  {
    key: 'business',
    displayName: 'Business',
    billingModel: 'PER_SEAT',
    monthlyPriceUsd: 29,
    creditAllotmentCredits: 150,
    creditPriceUsd: 0.2,
    dailyDripCapCredits: DEFAULT_DAILY_DRIP_CAP_CREDITS,
    capabilities: [
      'data_sync_control',
      'teams',
      'org_credit_pool',
      'remote_control',
      // Data-sharing enforcement: Business gets the "ZDR-lite" posture (no
      // conversation text, no derived prose, no plans) but not metadata, which
      // is the prerequisite for the other three and stays Enterprise-only.
      'enforce_sharing_transcripts',
      'enforce_sharing_plans',
      'enforce_sharing_summaries',
    ],
    sortOrder: 2,
  },
  {
    key: 'enterprise',
    displayName: 'Enterprise',
    billingModel: 'PER_SEAT',
    monthlyPriceUsd: 49,
    creditAllotmentCredits: 250,
    creditPriceUsd: 0.2,
    dailyDripCapCredits: DEFAULT_DAILY_DRIP_CAP_CREDITS,
    // Business + full data-sharing enforcement. This is Enterprise's FIRST
    // functional entitlement over Business: `enforce_sharing_metadata` is the
    // prerequisite scope, so only Enterprise can lock an org down completely.
    capabilities: [
      'data_sync_control',
      'teams',
      'org_credit_pool',
      'remote_control',
      'enforce_sharing_transcripts',
      'enforce_sharing_plans',
      'enforce_sharing_summaries',
      'enforce_sharing_metadata',
      'enforce_model_policy',
      'custom_model_gateway',
    ],
    sortOrder: 3,
  },
] as const;

/**
 * The hidden legacy tiers (G10, CAN-1544), frozen by CAN-1537. These mirror the
 * three HIDDEN rows seeded by 20260721000000_seed_hidden_legacy_plans so
 * migrated ECW subscriptions can resolve a plan/price/name. They are addressable
 * (seedable + productKey-derivable via {@link productKeyFromPlanKey} + price/name
 * resolvable via {@link creditPriceUsdForPlanKey} / {@link planDisplayNameFromKey})
 * yet stay invisible to every public-tier guard. `displayName` deliberately uses
 * the plain tier name — `legacy-pro` reads `Pro`, colliding with native
 * `individual`'s display name by design (the `legacy-` marker lives only on the
 * key / productKey). Sanity: allotment × creditPriceUsd = monthlyPriceUsd.
 */
export const LEGACY_BILLING_PLAN_SEED: readonly BillingPlanSeed<LegacyBillingPlanKey>[] =
  [
    {
      key: 'legacy-starter',
      displayName: 'Starter',
      billingModel: 'FLAT',
      monthlyPriceUsd: 20,
      creditAllotmentCredits: 40,
      creditPriceUsd: 0.5,
      dailyDripCapCredits: DEFAULT_DAILY_DRIP_CAP_CREDITS,
      capabilities: ['data_sync_control'],
      sortOrder: 100,
    },
    {
      key: 'legacy-pro',
      displayName: 'Pro',
      billingModel: 'FLAT',
      monthlyPriceUsd: 50,
      creditAllotmentCredits: 125,
      creditPriceUsd: 0.4,
      dailyDripCapCredits: DEFAULT_DAILY_DRIP_CAP_CREDITS,
      capabilities: ['data_sync_control'],
      sortOrder: 101,
    },
    {
      key: 'legacy-ultra',
      displayName: 'Ultra',
      billingModel: 'FLAT',
      monthlyPriceUsd: 99,
      creditAllotmentCredits: 330,
      creditPriceUsd: 0.3,
      dailyDripCapCredits: DEFAULT_DAILY_DRIP_CAP_CREDITS,
      capabilities: ['data_sync_control'],
      sortOrder: 102,
    },
  ] as const;

/**
 * Every seeded plan row — native public plus hidden legacy — for the resolution
 * helpers (price / display name) that must resolve legacy keys too. The covariant
 * read of `key` makes both seed arrays assignable to the widened element type, so
 * no `as` cast is needed. The public-tier guards intentionally do NOT read this
 * list; they stay on {@link BILLING_PLAN_SEED}.
 */
const ALL_BILLING_PLAN_SEEDS: readonly BillingPlanSeed<AnyBillingPlanKey>[] = [
  ...BILLING_PLAN_SEED,
  ...LEGACY_BILLING_PLAN_SEED,
];

/** In-code default credit SALE price for a plan key (free list price fallback). */
const FREE_LIST_CREDIT_PRICE_USD = 0.6;

/**
 * The in-code default per-tier credit SALE price (USD/credit) for a plan key,
 * read from {@link ALL_BILLING_PLAN_SEEDS} (native public plus hidden legacy
 * tiers, so migrated ECW subscriptions resolve too). Falls back to the free list
 * price ($0.60) for an unknown key / no plan. This is only the in-code default;
 * the `billing_plans.credit_price_usd` DB column stays authoritative at runtime
 * (config-as-data, editable via SQL / admin without a deploy).
 */
export function creditPriceUsdForPlanKey(key: string): number {
  return (
    ALL_BILLING_PLAN_SEEDS.find((plan) => plan.key === key)?.creditPriceUsd ??
    FREE_LIST_CREDIT_PRICE_USD
  );
}

/**
 * The in-code included monthly AI-credit allotment for a plan key, read from
 * {@link ALL_BILLING_PLAN_SEEDS} (native public plus hidden legacy tiers). `0`
 * for an unknown key / no plan.
 *
 * PER SEAT for a `PER_SEAT` plan (Business grants 150 credits per seat, not 150
 * for the whole org) — multiply by the seat count for an org total. Like
 * {@link creditPriceUsdForPlanKey} this is only the in-code default; the
 * `billing_plans.credit_allotment_credits` DB column stays authoritative at
 * grant time. It is read by display copy that must name the concrete number a
 * subscriber is about to lose (the cancellation confirmation), never by the
 * grant path.
 */
export function creditAllotmentCreditsForPlanKey(key: string): number {
  return (
    ALL_BILLING_PLAN_SEEDS.find((plan) => plan.key === key)
      ?.creditAllotmentCredits ?? 0
  );
}

/**
 * Ordinal rank of a plan key within the catalog (`free` < `individual` <
 * `business`), used to compare tiers for upgrade/downgrade decisions on the
 * pricing page. Returns `-1` for an unknown key so callers treat it as below
 * every real tier. Derived from {@link BILLING_PLAN_KEYS} order — no hardcoded
 * per-key rank — so a catalog reshuffle keeps the ordering coherent.
 */
export function billingPlanRank(key: string): number {
  return BILLING_PLAN_KEYS.findIndex((candidate) => candidate === key);
}

/**
 * Human display name for a plan key (e.g. `individual` → `Pro`, `business` →
 * `Business`), read from the seeded catalog. `null` for an unknown key. Used to
 * enrich AI-credit ledger descriptions so a user can see which plan (and, for an
 * org seat, which org) funded a credit grant.
 */
export function planDisplayNameFromKey(key: string): string | null {
  return (
    ALL_BILLING_PLAN_SEEDS.find((plan) => plan.key === key)?.displayName ?? null
  );
}

/**
 * Cheapest PAID tier granting each capability, by `sortOrder`. Built once from
 * the module constant rather than re-sorted per call, because the upgrade CTA
 * that reads it is resolved per row on every render of the data-sharing card.
 *
 * Paid tiers only, deliberately: `free` has `sortOrder: 0`, so a capability
 * ever granted to it would render the CTA "Upgrade to Free". A free tier is
 * not an upgrade, and a capability the free tier already grants does not gate
 * anything, so neither is a CTA worth naming.
 *
 * Native tiers only too: {@link LEGACY_BILLING_PLAN_SEED} is excluded because a
 * hidden legacy tier is not a plan anyone can upgrade INTO.
 */
const CHEAPEST_PLAN_NAME_BY_CAPABILITY: ReadonlyMap<BillingCapability, string> =
  ((): Map<BillingCapability, string> => {
    const byCapability = new Map<BillingCapability, string>();
    for (const plan of [...BILLING_PLAN_SEED].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    )) {
      if (plan.monthlyPriceUsd <= 0) {
        continue;
      }
      for (const capability of plan.capabilities) {
        if (!byCapability.has(capability)) {
          byCapability.set(capability, plan.displayName);
        }
      }
    }
    return byCapability;
  })();

/**
 * Display name of the cheapest paid tier that grants `capability`, or `null`
 * when no paid tier does.
 *
 * The upgrade CTA on a capability-gated control has to name a tier that
 * actually unlocks it, and it must keep naming the right one when a capability
 * moves down the catalog (`enforce_sharing_metadata` is Enterprise-only today,
 * but nothing about that is permanent) — a hardcoded "upgrade to Enterprise"
 * string in a component would keep pointing at Enterprise long after Business
 * started including the capability.
 *
 * Scope of that guarantee: {@link BILLING_PLAN_SEED} is a static mirror of the
 * seeded catalog, guarded against the migrations by a drift test, while the
 * `covered` flag the CTA sits beside comes from the LIVE entitlements read. A
 * capability regranted by SQL / the admin API without a matching migration
 * therefore moves coverage without moving this name. Migration-driven changes
 * stay consistent; ad-hoc ones do not.
 */
export function lowestPlanNameWithCapability(
  capability: BillingCapability,
): string | null {
  return CHEAPEST_PLAN_NAME_BY_CAPABILITY.get(capability) ?? null;
}

/** The account owner type a paid plan may be held by. */
export type PlanOwnerScope = 'user' | 'org';

/**
 * The account owner type a paid plan is meant for, derived from its billing
 * model: a `PER_SEAT` plan (e.g. `business`) is org-only, while a `FLAT` paid
 * plan (e.g. `individual`) is for a personal account. Data-derived from the
 * seeded `billingModel` (no hardcoded key), so a new tier inherits the correct
 * scope purely from its catalog row. A key with no seed row defaults to `user`
 * (the least-privileged scope). This is the single source of truth the confirm
 * path uses to reject an owner-incompatible tier — e.g. a personal account may
 * never be granted the per-seat `business` plan.
 */
export function planKeyOwnerScope(key: PaidBillingPlanKey): PlanOwnerScope {
  const seed = BILLING_PLAN_SEED.find((plan) => plan.key === key);
  return seed?.billingModel === 'PER_SEAT' ? 'org' : 'user';
}
