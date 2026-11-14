'use client';

import { Badge } from '@canopy/ui-shared/components/Badge';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  BillingHistoryTable as SharedBillingHistoryTable,
  BusyLabel,
  Button,
  CreditLedgerTable as SharedCreditLedgerTable,
  EmptyState,
  ErrorBanner,
  Fact,
  FactList,
  Heading,
  Stack,
} from '@canopy/ui-shared/components';
import {
  formatCardLabel,
  formatCredits,
  formatExpiry,
  formatMonthDay,
  formatUsd,
} from '@canopy/ui-shared/lib';
import type { AiCreditsLedgerEntry } from '@canopy/protocol';
import type { SettingsPaymentOwner } from '@canopy/protocol/billing';
import {
  lowestPlanNameWithCapability,
  planDisplayNameFromKey,
} from '@canopy/protocol/settings/billing-plan-catalog';
import {
  isCancellationLapsed,
  type BillingSummary,
  type ChargeHistoryItem,
  type CreditsSummary,
  type InvoicePage,
  type PaymentMethodSummary,
} from '@canopy/protocol/settings/billing';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { formatPlanDate } from '@canopy/protocol/settings/plan-display';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  BillingCardBodySkeleton,
  BillingTransactionsSkeleton,
} from './billing-card-body-skeleton';
import { CreditsUsedThisPeriod } from './credits-used-this-period';
import { InvoicesSection, INVOICES_PAGE_LIMIT } from './invoices-section';
import { trialBadgeLabel } from './trial-badge-label';
import { AutoTopUpSummary } from './auto-top-up-summary';
import {
  useBillingSettingsSlots,
  type BillingSettingsIntentTarget,
} from './billing-settings-slots';
import { SettingsCreditPoolSubscription } from './settings-credit-pool-subscription';
import { ENTRY_ORG_PLAN_KEY } from './org-plan-ladder';
import {
  PaymentArea,
  PaymentAreaCta,
  PaymentAreaNotice,
  billingSummaryNeedsPaymentMethod,
  paymentCaptureAvailable,
  subscriptionRecoveryIntent,
  usePaymentAreaMode,
} from './PaymentArea';
import {
  useSettingsBrand,
  useSettingsClient,
  useSettingsPrivacy,
  useSettingsSearchParams,
  useSettingsWorkspaceContext,
} from '../host';
import { useSettingsLoadFailure } from '../errors';
import { withPrivacyClass } from '../account/privacy-class';
import {
  getCreditsBalance,
  getCreditsLedger,
  getOrgBillingSummary,
  getOrgChargeHistory,
  getOrgInvoices,
} from '../organization/team-api';
import type { SettingsFailure } from '../errors';
import { Divider } from '@canopy/ui-shared/components';

interface TeamBillingSectionProps {
  detail: OrganizationDetail;
  /** Invalidate page and persistent navigation after a successful mutation. */
  onBillingChanged?: () => void;
  /**
   * Server-resolved free app access (CAN-3926). There is no subscription to
   * show, so the "Subscription plan" card (level and trial pills, seat math,
   * next charge, upgrade CTAs, and the subscription menu) is omitted and the
   * AI credit pool leads the page. Payment method and receipts stay in the
   * billing-history card, which loads on its own.
   */
  freeAccess?: boolean;
}

/** Normalized default-card shape shared by the summary + confirm responses. */
interface CardDisplay {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/**
 * Org Billing subtab, rendered as three sibling first-level cards rather than
 * one card holding three: "Subscription plan" (level + trial pills, seat math,
 * next-billing date, and an OWNER "Get Business" upgrade CTA that charges
 * immediately), "AI credit pool", and "Billing history", which still hosts the
 * saved payment method as a genuine subcard. Each carries the icon + title +
 * subtitle shell its peers on the other Settings subtabs use, so nothing here
 * sits a level below an equivalent card on, say, Policies.
 *
 * OWNER can add or replace the payment method; ADMIN sees a read-only summary.
 * The billing-history card (and its payment method) is hidden when empty — no
 * Stripe key, no card, no charges.
 *
 * With free access on (CAN-3926) the subtab is "AI Credits": the plan card is
 * omitted, so the AI credit pool comes first and billing history follows.
 */
export function TeamBillingSection({
  detail,
  onBillingChanged,
  freeAccess = false,
}: TeamBillingSectionProps): JSX.Element {
  const orgId = detail.id;
  const isOwner = detail.viewerRole === 'OWNER';
  const client = useSettingsClient();
  const slots = useBillingSettingsSlots();
  const paymentMode = usePaymentAreaMode();
  // Card capture is possible inline (Stripe configured) or through the web
  // handoff; this replaces the old "Stripe key present" predicate.
  const paymentsAvailable = paymentCaptureAvailable(paymentMode);
  const brandName = useSettingsBrand().displayName;
  const viewerId = useSettingsWorkspaceContext().accountKey;
  // `/checkout?plan=<key>` forwards the pricing-page intent here as
  // `?plan=<key>`, so the upgrade CTA can open its confirm dialog on arrival
  // instead of leaving the viewer to re-find the button.
  const queryPlanKey = useSettingsSearchParams().get('plan');
  // The one-shot top-up or payment modal intent this page was opened with,
  // read by the host's intent controller once the summary has loaded.
  const [intentTarget, setIntentTarget] =
    useState<BillingSettingsIntentTarget | null>(null);
  const intentPlanKey =
    intentTarget?.kind === 'subscription' && intentTarget.plan !== undefined
      ? intentTarget.plan
      : queryPlanKey;
  const owner = useOrganizationOwner(orgId);

  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [card, setCard] = useState<CardDisplay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [creditsReloadSignal, setCreditsReloadSignal] = useState(0);
  const [historyReloadSignal, setHistoryReloadSignal] = useState(0);
  const planCardRef = useRef<HTMLElement | null>(null);
  const loadError = useSettingsLoadFailure('billing:organization-summary');

  const loadSummary = useCallback(
    async (options?: { silent?: boolean }): Promise<void> => {
      if (!options?.silent) {
        setLoading(true);
      }
      setError(null);
      try {
        const next = await getOrgBillingSummary(client, orgId);
        setSummary(next);
        setCard(next.paymentMethod);
      } catch (err) {
        setError(loadError(err));
      } finally {
        setLoading(false);
      }
    },
    [client, orgId, loadError],
  );

  // Initial load / reload on org switch. Genuine external sync whose success
  // path calls setState (see the `set-state-in-effect` rule note).
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const handleCardSaved = (next: PaymentMethodSummary): void => {
    // Optimistically show the freshly saved card, then reload the full summary
    // so plan/coverage details stay consistent with the new payment method.
    setCard(next);
    onBillingChanged?.();
    void loadSummary();
  };

  const handleCardRemoved = (): void => {
    // Optimistically clear the card, then reload so plan/coverage details stay
    // consistent with the removed payment method.
    setCard(null);
    onBillingChanged?.();
    void loadSummary();
  };

  const handleSubscriptionChanged = async (): Promise<void> => {
    onBillingChanged?.();
    await loadSummary();
  };

  /** "Check again" and browser return: re-read plan, card, pool and history. */
  const refreshAuthoritative = useCallback((): void => {
    void loadSummary({ silent: true });
    setCreditsReloadSignal((current) => current + 1);
    setHistoryReloadSignal((current) => current + 1);
  }, [loadSummary]);

  // A subscription intent without a plan opens the update-card modal when the
  // plan needs a working card; otherwise the plan card is brought into view
  // and nothing opens. A payment-method intent opens the card modal.
  const subscriptionNeedsCard =
    intentTarget?.kind === 'subscription' &&
    intentTarget.plan === undefined &&
    summary !== null &&
    billingSummaryNeedsPaymentMethod(summary);
  const openCardRequestId =
    isOwner &&
    (intentTarget?.kind === 'payment-method' || subscriptionNeedsCard)
      ? intentTarget.requestId
      : null;
  const focusPlanCard =
    intentTarget?.kind === 'subscription' && !subscriptionNeedsCard;
  useEffect(() => {
    if (!focusPlanCard) return;
    const planCard = planCardRef.current;
    if (planCard !== null && typeof planCard.scrollIntoView === 'function') {
      planCard.scrollIntoView({ block: 'center' });
    }
  }, [focusPlanCard]);

  // A plain stack, not a card: since Billing became a subtab of its own, an
  // outer card around these three only wrapped a heading ("Billing") that the
  // subtab already says, and pushed every real card down a level into
  // `border`-on-`bg-card` subcards that read as secondary to the peers on every
  // other settings subtab. The three below are now first-level cards with the
  // same icon + title + subtitle shell those peers use, so `gap-6` here matches
  // the spacing the settings container gives sibling cards elsewhere.
  return (
    <PaymentArea
      owner={owner}
      canManage={isOwner}
      refresh={refreshAuthoritative}
    >
      <div className="flex flex-col gap-6" data-testid="team-billing-section">
        {slots !== null ? (
          <slots.IntentController
            viewerId={viewerId}
            owner={owner}
            canManageBilling={isOwner}
            dataReady={!loading}
            onTarget={setIntentTarget}
          />
        ) : null}
        <PaymentAreaNotice testId="team-billing-payment-handoff" />
        {/* Empty `className` on purpose: the default is `mb-4`, which would stack
            on top of the wrapper's `gap-6` and leave a lopsided gutter under the
            banner. */}
        <ErrorBanner
          errorSource="team-billing-load"
          className=""
          error={error?.copy}
          details={error?.details}
          onRetry={() => void loadSummary()}
        />

        {freeAccess ? null : (
          <PlanCard
            summary={summary}
            loading={loading}
            orgId={orgId}
            isOwner={isOwner}
            paymentsAvailable={paymentsAvailable}
            intentPlanKey={intentPlanKey}
            onSubscribed={handleCardSaved}
            onSubscriptionChanged={handleSubscriptionChanged}
            cardRef={planCardRef}
          />
        )}
        <AiCreditPoolCard
          orgId={orgId}
          owner={owner}
          isOwner={isOwner}
          brandName={brandName}
          freeAccess={freeAccess}
          intentTarget={intentTarget}
          reloadSignal={creditsReloadSignal}
        />
        <BillingHistoryCard
          orgId={orgId}
          isOwner={isOwner}
          card={card}
          paymentsAvailable={paymentsAvailable}
          onSaved={handleCardSaved}
          onRemoved={handleCardRemoved}
          openCardRequestId={openCardRequestId}
          reloadSignal={historyReloadSignal}
        />
      </div>
    </PaymentArea>
  );
}

/** A stable explicit owner for this organization's wallet. */
function useOrganizationOwner(orgId: string): SettingsPaymentOwner {
  const [owner, setOwner] = useState<SettingsPaymentOwner>(() => ({
    kind: 'organization',
    organizationId: orgId,
  }));
  if (owner.kind !== 'organization' || owner.organizationId !== orgId) {
    setOwner({ kind: 'organization', organizationId: orgId });
  }
  return owner;
}

interface PlanCardProps {
  summary: BillingSummary | null;
  loading: boolean;
  orgId: string;
  isOwner: boolean;
  /** Card capture is possible (inline Stripe, or the web handoff). */
  paymentsAvailable: boolean;
  /** `?plan=<key>` upgrade intent forwarded by `/checkout`, when present. */
  intentPlanKey: string | null;
  /** Refresh the summary after a successful immediate-charge subscribe. */
  onSubscribed: (summary: PaymentMethodSummary) => void;
  /**
   * Re-fetch the summary after a cancel / resume. Distinct from `onSubscribed`,
   * which also carries a freshly saved card to show optimistically — a
   * cancellation touches no payment method.
   */
  onSubscriptionChanged: () => void | Promise<void>;
  /** Brought into view by a subscription intent. */
  cardRef: RefObject<HTMLElement | null>;
}

/**
 * The org plan card, aligned with the individual billing page: a "Subscription
 * plan" heading with the plan name as a level pill next to the trial pill, the
 * seats / due / next-billing detail grid, and — top-right, for an OWNER who is
 * not yet an active paid subscriber — a primary "Get Business" upgrade CTA that
 * charges immediately (Part A `subscribeAndCharge`).
 */
function PlanCard({
  summary,
  loading,
  orgId,
  isOwner,
  paymentsAvailable,
  intentPlanKey,
  onSubscribed,
  onSubscriptionChanged,
  cardRef,
}: PlanCardProps): JSX.Element {
  const slots = useBillingSettingsSlots();
  if (summary === null) {
    return (
      <section
        ref={cardRef}
        className={SETTINGS_CARD_CLASS}
        data-testid="team-billing-plan-card"
      >
        <div className={SETTINGS_CARD_GROUP_CLASS}>
          <div className="flex items-start gap-3">
            <Stack gap="tight" className="min-w-0 flex-1">
              <Heading level={2} variant="section">
                Subscription plan
              </Heading>
              {loading ? (
                <BillingCardBodySkeleton body="plan" />
              ) : (
                <p className="text-s fg-secondary">
                  No plan details available.
                </p>
              )}
            </Stack>
          </div>
        </div>
      </section>
    );
  }

  const planName = summary.plan?.displayName ?? 'Free';
  const trialActive = summary.trial?.active ?? false;
  // Matches the subscribe CTA's label (the entry org tier) so the trial nudge
  // points at the exact button the user needs to click.
  const upgradePlanName =
    planDisplayNameFromKey(ENTRY_ORG_PLAN_KEY) ?? 'Business';
  // The org's trial ran out and nothing replaced it (CAN-2311). Distinct from a
  // plain Free org in the copy only — the `Free` pill above is unchanged — but
  // the distinction is the whole point: "Free" describes the tier, while this
  // says the team's features are GONE and names what brings them back. Requires
  // `plan === null`, so an org that subscribed after its trial reads as a normal
  // paid plan rather than being told its trial ended.
  // Holds the FORMATTED end date rather than a boolean, so the copy below has
  // the value in hand without a re-narrowing dance inside the template.
  const trialEndedOn =
    !trialActive &&
    summary.plan === null &&
    summary.trialEndedAt !== null &&
    summary.trialEndedAt !== undefined
      ? formatPlanDate(summary.trialEndedAt)
      : null;
  // Named from the capability, not a hardcoded tier, so a catalog change that
  // moves `teams` to a different plan updates this copy for free.
  const restorePlanName =
    lowestPlanNameWithCapability('teams') ?? upgradePlanName;
  // The lapse sentence, phrased for the reason the org ACTUALLY lost coverage.
  //
  // `trialEndedOn` alone cannot decide this: `trialEndedAt` is set for any org
  // past its trial window, and `LIVE_STATUSES` excludes `CANCELED`, so an org
  // that trialed in January, subscribed, paid for eleven months and cancelled
  // in December satisfies every condition above. Driving the copy off the date
  // told that customer their TRIAL ended and pointed them at a plan they
  // already bought. Same false-copy bug `lapseReason` was introduced to kill on
  // the server side; this card just was not reading the field.
  // Driven off `lapseReason` DIRECTLY, not gated behind `trialEndedOn`.
  //
  // Gating on the date made the `payment_failed` branch dead code, on the one
  // page that can fix it. `trialEndedOn` requires `summary.plan === null`, but
  // `billing-summary-service`'s `LIVE_STATUSES` INCLUDES `PAST_DUE` — so a
  // declined-card org still resolves a live subscription and a named plan,
  // leaving `trialEndedOn` null and short-circuiting the whole switch. Meanwhile
  // `lapseReason` is `'payment_failed'` precisely because
  // `ORG_LIVE_SUBSCRIPTION_STATUSES` EXCLUDES `PAST_DUE`. The two status sets
  // disagree on `PAST_DUE` by design, so the date can never be the gate for a
  // past-due org. `team-page` also suppresses its own lapsed notice on this tab
  // on the grounds that this card renders the lapse — which was false for
  // exactly this case, leaving a past-due owner with no explanation anywhere.
  //
  // `trialEndedOn` is still what supplies the DATE, so it stays required inside
  // the `trial_ended` branch only.
  const lapseSentence = ((): string | null => {
    if (summary.lapseReason === null || summary.lapseReason === undefined) {
      return null;
    }
    switch (summary.lapseReason) {
      case 'payment_failed':
        // No plan name: the remedy is a working card, not a purchase.
        return "Your last payment failed. Your team's features are paused until the payment method is updated.";
      case 'subscription_ended':
        return `Your subscription has ended. Your team's features are paused until you subscribe to ${restorePlanName}.`;
      case 'trial_ended':
        // Only this branch needs the date, and only this branch requires the
        // org to have no live plan.
        return trialEndedOn === null
          ? `Your team's features are paused until you subscribe to ${restorePlanName}.`
          : `Your trial ended on ${trialEndedOn}. Your team's features are paused until you subscribe to ${restorePlanName}.`;
      default:
        // Reason unresolved: stay cause-free rather than inventing one.
        return `Your team's features are paused until you subscribe to ${restorePlanName}.`;
    }
  })();
  const seatCount = summary.seatCount;
  const pendingCancellation = summary.pendingCancellation ?? null;
  // A quoted end date that has already elapsed must never render as a future
  // promise. The server cancels a lapsed row immediately now, but a flagged
  // TRIALING row past its trial end (or an ACTIVE row still waiting on the
  // hourly renewal sweep) can still reach this card.
  const pendingCancellationLapsed =
    pendingCancellation !== null &&
    isCancellationLapsed(pendingCancellation.effectiveAt);
  const perSeat =
    seatCount && seatCount > 0 && summary.nextBillingAmountUsd !== null
      ? summary.nextBillingAmountUsd / seatCount
      : null;
  // An admin-granted complimentary plan is an ordinary ACTIVE row priced at
  // $0. Rendering its "N seats × $0.00 / Next charge $0.00" reads like a
  // billing bug, so the price rows collapse to a single "Complimentary" line
  // and the next billing date (there is never a charge) is hidden.
  const complimentary = summary.complimentary === true;
  // What a host without inline checkout may recover on the web, if anything.
  const recovery = subscriptionRecoveryIntent(summary, ENTRY_ORG_PLAN_KEY);

  return (
    <section
      ref={cardRef}
      className={SETTINGS_CARD_CLASS}
      data-testid="team-billing-plan-card"
    >
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 items-stretch justify-between gap-3">
            <Stack gap="item" className="min-w-0">
              <Stack gap="group">
                <Stack gap="tight">
                  <div className="flex flex-wrap items-center gap-2">
                    <Heading level={2} variant="section">
                      Subscription plan
                    </Heading>
                    <Badge data-testid="team-billing-plan-pill">
                      {planName}
                    </Badge>
                    {trialActive && summary.trial ? (
                      <Badge
                        tone="warning"
                        data-testid="team-billing-trial-chip"
                      >
                        {trialBadgeLabel(summary.trial.endsAt)}
                      </Badge>
                    ) : null}
                  </div>

                  {lapseSentence !== null ? (
                    <p
                      className="text-s fg-secondary"
                      data-testid="team-billing-trial-ended-notice"
                    >
                      {lapseSentence}
                    </p>
                  ) : (
                    <p className="text-s fg-secondary">
                      {trialActive &&
                      summary.paymentMethod === null &&
                      isOwner &&
                      paymentsAvailable
                        ? `You're on a free trial — nothing's due yet. Upgrade to ${upgradePlanName} to lock in your team's access.`
                        : "Your team's plan, seats, and next payment."}
                    </p>
                  )}
                </Stack>

                <FactList
                  layout="stacked"
                  columns={2}
                  size="s"
                  rowGap="2"
                  columnGap="2"
                  labelTone="secondary"
                >
                  {complimentary ? (
                    <>
                      {seatCount !== null && seatCount > 0 ? (
                        <Fact label="Seats" dataTestId="team-billing-seats">
                          {seatCount} seat{seatCount === 1 ? '' : 's'}
                        </Fact>
                      ) : null}
                      <Fact
                        label="Price"
                        dataTestId="team-billing-complimentary"
                      >
                        Complimentary
                      </Fact>
                    </>
                  ) : null}
                  {!complimentary && seatCount !== null && perSeat !== null ? (
                    <Fact label="Seats">
                      {seatCount} seat{seatCount === 1 ? '' : 's'} ×{' '}
                      {formatUsd(perSeat)}
                    </Fact>
                  ) : null}
                  {!complimentary && summary.nextBillingAmountUsd !== null ? (
                    <Fact label={trialActive ? 'Monthly cost' : 'Next charge'}>
                      {formatUsd(summary.nextBillingAmountUsd)}
                    </Fact>
                  ) : null}
                  {/* A pending cancellation REPLACES the next-billing row: there is
                  no next charge, and a silently-canceling plan that still
                  advertises a billing date is the single most common
                  cancellation support ticket. During a trial the countdown pill
                  conveys the timing, so the plain "Next billing date" is hidden
                  and the amount above reads as the monthly cost. */}
                  {pendingCancellation !== null ? (
                    <Fact
                      label={
                        pendingCancellationLapsed ? 'Status' : 'Cancels on'
                      }
                      valueTone="secondary"
                      dataTestId="team-billing-cancels-on"
                    >
                      {pendingCancellationLapsed
                        ? 'Canceling'
                        : formatPlanDate(pendingCancellation.effectiveAt)}
                    </Fact>
                  ) : !trialActive &&
                    !complimentary &&
                    summary.nextBillingDate !== null ? (
                    <Fact label="Next billing date">
                      {formatPlanDate(summary.nextBillingDate)}
                    </Fact>
                  ) : null}
                </FactList>
              </Stack>

              {pendingCancellation !== null ? (
                <p
                  className="text-xs fg-secondary"
                  data-testid="team-billing-pending-cancel-notice"
                >
                  {pendingCancellationLapsed
                    ? 'Your plan is ending. Access will end shortly.'
                    : `Your plan stays active until ${formatPlanDate(
                        pendingCancellation.effectiveAt,
                      )}. You can resume any time before then.`}
                </p>
              ) : null}

              {summary.coverageNotes.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {summary.coverageNotes.map((note, index) => (
                    <li key={index} className="text-xs fg-secondary">
                      {note}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Stack>

            {/* The menu pins to the TOP of this column and the CTA to the bottom
              (`mt-auto`), so they sit at opposite corners instead of side by
              side. A filled button with a bare "…" glued to its right reads as a
              split button, promising the menu holds variants of that button — it
              holds Cancel subscription. Diagonal separation kills that reading
              without spending a divider or a full-width footer row on it. */}
            <div className="flex shrink-0 flex-col items-end gap-3">
              {/* Owner-gated to match the subscribe CTA rather than the page's
                broader OWNER/ADMIN view gate — canceling team billing stops
                funding every member's seat, so it is an owner action. */}
              {isOwner && slots !== null ? (
                <slots.SubscriptionActionsMenu
                  scope="org"
                  orgId={orgId}
                  summary={summary}
                  onChanged={onSubscriptionChanged}
                />
              ) : null}

              {/* At most one of these renders — the two predicates are
                complements. `mt-auto` drops whichever one it is to the bottom of
                the card even when the menu above is absent. */}
              <div className="mt-auto" data-testid="team-billing-plan-action">
                {isOwner ? (
                  <PaymentAreaCta
                    action="subscription"
                    offered={recovery !== null}
                    plan={recovery?.plan}
                    testId="team-billing-manage-billing-on-web"
                    inline={
                      slots !== null ? (
                        <>
                          {slots.publishableKey ? (
                            <slots.OrganizationPlanSubscribeCta
                              summary={summary}
                              organizationId={orgId}
                              onSubscribed={onSubscribed}
                              intentPlanKey={intentPlanKey}
                            />
                          ) : null}
                          {/* The paid-subscriber half of the CTA split. Not
                            gated on the Stripe key: this path captures no
                            card, only the org's existing payment method,
                            which the quote reports on. */}
                          <slots.OrganizationPlanUpgradeCta
                            summary={summary}
                            organizationId={orgId}
                            intentPlanKey={intentPlanKey}
                            onChanged={onSubscriptionChanged}
                          />
                        </>
                      ) : null
                    }
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

interface PaymentMethodSubcardProps {
  orgId: string;
  isOwner: boolean;
  card: CardDisplay | null;
  paymentsAvailable: boolean;
  onSaved: (summary: PaymentMethodSummary) => void;
  onRemoved: () => void;
  openCardRequestId: string | null;
}

/**
 * A `Visa ····4242` label, or a neutral fallback when the brand/last4 are not
 * both present (e.g. a non-card PM). Mirrors the account-page card formatting.
 */
function cardLabel(card: CardDisplay): string {
  if (card.brand && card.last4) {
    return formatCardLabel(card.brand, card.last4);
  }
  return card.last4 ? `···· ${card.last4}` : 'Card on file';
}

/**
 * The saved-card subcard rendered inside the billing-history card (a `bg-muted`
 * block alongside the USD charge history, mirroring the individual page's
 * `SavedCardSection`). OWNER can add a card (primary CTA) or Edit / Delete the
 * card on file via the icon affordances; Add/Edit open the shared themed capture
 * modal (bare card save — no `planKey`, so it never converts a trial), and
 * Delete confirms first. Non-owners (and environments without a Stripe
 * publishable key) see the card read-only.
 */
function PaymentMethodSubcard({
  orgId,
  isOwner,
  card,
  paymentsAvailable,
  onSaved,
  onRemoved,
  openCardRequestId,
}: PaymentMethodSubcardProps): JSX.Element {
  const slots = useBillingSettingsSlots();
  const paymentMode = usePaymentAreaMode();
  const { blockClassName } = useSettingsPrivacy();
  const hasCard = card !== null && card.last4 !== null;
  const canManage = isOwner && paymentsAvailable;

  const layout = (actions: ReactNode, after: ReactNode): JSX.Element => (
    <div>
      <div className="pb-4" data-testid="team-billing-payment-method-card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-s font-medium fg-primary">Payment method</p>
            {hasCard && card ? (
              <p
                className={withPrivacyClass(
                  'mt-1 text-s fg-primary',
                  blockClassName,
                )}
                data-testid="team-billing-card-summary"
              >
                {cardLabel(card)}
                {card.expMonth !== null && card.expYear !== null
                  ? `, exp ${formatExpiry(card.expMonth, card.expYear)}`
                  : ''}
              </p>
            ) : (
              <p className="mt-1 text-s fg-secondary">No card on file.</p>
            )}
          </div>

          {actions}
        </div>

        {after}
      </div>
      <Divider />
    </div>
  );

  if (!canManage) return layout(null, null);
  if (paymentMode.kind === 'handoff') {
    return layout(
      <PaymentAreaCta
        action="payment-method"
        hasCard={hasCard}
        testId="team-billing-manage-payment-method"
      />,
      null,
    );
  }
  if (slots === null) return layout(null, null);
  return (
    <slots.OrganizationPaymentMethodActions
      organizationId={orgId}
      hasCard={hasCard}
      cardLabel={card ? cardLabel(card) : null}
      onSaved={onSaved}
      onRemoved={onRemoved}
      openRequestId={openCardRequestId}
    >
      {({ actions, after }) => layout(actions, after)}
    </slots.OrganizationPaymentMethodActions>
  );
}

interface BillingHistoryCardProps {
  orgId: string;
  isOwner: boolean;
  card: CardDisplay | null;
  paymentsAvailable: boolean;
  onSaved: (summary: PaymentMethodSummary) => void;
  onRemoved: () => void;
  /** Opens the owner's card modal once (a payment-method intent). */
  openCardRequestId: string | null;
  /** Bumped by "Check again" and browser return: reload the first page. */
  reloadSignal: number;
}

/**
 * The grouped billing-history card: the saved payment method as a `bg-muted`
 * subcard, then the USD transactions table under a "Transactions" subheader. The
 * whole card is hidden unless it has real value — a card on file, at least one
 * charge, or an error. A configured Stripe key alone does NOT force it to show,
 * so an org that has never billed (trial, no card, no charges) shows nothing
 * here; the first card is added via the plan CTA or the credit top-up flow.
 */
function BillingHistoryCard({
  orgId,
  isOwner,
  card,
  paymentsAvailable,
  onSaved,
  onRemoved,
  openCardRequestId,
  reloadSignal,
}: BillingHistoryCardProps): JSX.Element {
  const client = useSettingsClient();
  const [charges, setCharges] = useState<ChargeHistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  // The page whose read failed, so Retry repeats that read: the first page,
  // or the "Load more" page after it.
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const loadError = useSettingsLoadFailure('billing:organization-history');

  const loadPage = useCallback(
    async (cursor: string | null): Promise<void> => {
      if (cursor === null) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);
      try {
        const page = await getOrgChargeHistory(
          client,
          orgId,
          cursor === null ? {} : { cursor },
        );
        setCharges((prev) =>
          cursor === null ? page.charges : [...prev, ...page.charges],
        );
        setNextCursor(page.nextCursor);
      } catch (err) {
        setFailedCursor(cursor);
        setError(loadError(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [client, orgId, loadError],
  );

  useEffect(() => {
    void loadPage(null);
  }, [loadPage, reloadSignal]);

  // Invoices own their paging state inside `InvoicesSection`; this card only
  // supplies the org-scoped fetcher and href builder. Both are memoized on
  // `orgId` so the section's first-page effect does not refire every render.
  const loadInvoicePage = useCallback(
    (cursor: string | null): Promise<InvoicePage> =>
      getOrgInvoices(client, orgId, { limit: INVOICES_PAGE_LIMIT, cursor }),
    [client, orgId],
  );
  const invoiceHref = useCallback(
    (invoice: { id: string }): string =>
      `/organization/${encodeURIComponent(orgId)}/billing/invoices/${encodeURIComponent(invoice.id)}`,
    [orgId],
  );

  const hasCard = card !== null && card.last4 !== null;
  const showTransactions = charges.length > 0;
  // Only show this card when it carries real value: a card on file, at least one
  // charge, or an error. A configured Stripe key alone is NOT enough — an org
  // that has never billed (trial, no card, no charges) shows nothing here rather
  // than an empty "Add card" shell, since the first card is captured via the
  // plan CTA or the credit top-up flow. While the first charge page is still
  // loading we can't yet know it's empty, so the card simply stays hidden until
  // content is confirmed instead of flashing a placeholder.
  // A card intent shows the card even when it is otherwise empty, so the modal
  // opens from its own subcard.
  const showCard =
    hasCard ||
    showTransactions ||
    error !== null ||
    (openCardRequestId !== null && paymentsAvailable);
  // When the card is shown, still surface the payment subcard so a card can be
  // managed or (re)added alongside existing history.
  const showPaymentSubcard = paymentsAvailable || hasCard;

  if (!showCard) {
    return <></>;
  }

  return (
    <SettingsCard
      title="Billing history"
      subtitle="Past payments and receipts for this organization, in USD."
      testId="team-billing-history-card"
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner
          errorSource="billing-history-card"
          className=""
          error={error?.copy}
          details={error?.details}
          onRetry={() => void loadPage(failedCursor)}
        />

        {showPaymentSubcard ? (
          <PaymentMethodSubcard
            orgId={orgId}
            isOwner={isOwner}
            card={card}
            paymentsAvailable={paymentsAvailable}
            onSaved={onSaved}
            onRemoved={onRemoved}
            openCardRequestId={openCardRequestId}
          />
        ) : null}

        <InvoicesSection
          loadPage={loadInvoicePage}
          hrefFor={invoiceHref}
          testId="team-billing-invoices"
        />

        {loading && !showTransactions ? (
          <BillingTransactionsSkeleton />
        ) : showTransactions ? (
          <div data-testid="team-billing-transactions">
            <p className="text-s font-medium fg-primary">Transactions</p>
            <div className="mt-2">
              <SharedBillingHistoryTable
                charges={charges}
                formatDate={formatPlanDate}
              />
            </div>
            {nextCursor !== null ? (
              <Button
                size="compact"
                disabled={loadingMore}
                aria-busy={loadingMore}
                onClick={() => void loadPage(nextCursor)}
                data-testid="team-billing-history-load-more"
                className="mt-3"
              >
                <BusyLabel busy={loadingMore}>Load more</BusyLabel>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}

/* -------------------------------------------------------------------------- */
/* AiCreditPoolCard — org shared credit pool (CAN-1040 / T17)                 */
/* -------------------------------------------------------------------------- */

/**
 * The pool's subtitle with free access on. A turn spends the member's own
 * wallet first and then the pool of the organization that owns the work
 * (CAN-3463); there is no seat quota in between.
 */
const FREE_ACCESS_POOL_SUBTITLE =
  "Shared credits for this organization's work, used after a member's own credits run out.";

/**
 * The org "AI credit pool" card. Self-loads the org {@link CreditsSummary} plus
 * the first ledger page, then renders the pool balance, per-seat allotment math,
 * the credit ledger, and (for OWNER) a manual "Buy credits" button. Both OWNER
 * and ADMIN see the shared {@link AutoTopUpControls}: OWNER can manage it, ADMIN
 * sees it read-only (`canManage=false` → disabled toggle, no "Adjust limit", no
 * top-up). MEMBER never reaches this tab.
 */
function AiCreditPoolCard({
  orgId,
  owner,
  isOwner,
  brandName,
  freeAccess,
  intentTarget,
  reloadSignal,
}: {
  orgId: string;
  owner: SettingsPaymentOwner;
  isOwner: boolean;
  brandName: string;
  /** Free access has no seats or plan quota, so the subtitle names neither. */
  freeAccess: boolean;
  /** The page's top-up or automatic top-up intent, once read. */
  intentTarget: BillingSettingsIntentTarget | null;
  /** Bumped by "Check again" and browser return: reload silently. */
  reloadSignal: number;
}): JSX.Element {
  const client = useSettingsClient();
  const slots = useBillingSettingsSlots();
  const paymentMode = usePaymentAreaMode();
  const [summary, setSummary] = useState<CreditsSummary | null>(null);
  const [entries, setEntries] = useState<AiCreditsLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const loadError = useSettingsLoadFailure('billing:organization-credits');

  const load = useCallback(
    async (options?: { silent?: boolean }): Promise<void> => {
      // A `silent` refresh (realtime signal / post-purchase) refetches in place
      // without flashing the loading skeleton over the already-rendered pool.
      if (!options?.silent) {
        setLoading(true);
      }
      setError(null);
      try {
        const [nextSummary, ledger] = await Promise.all([
          getCreditsBalance(client, orgId),
          getCreditsLedger(client, orgId),
        ]);
        setSummary(nextSummary);
        setEntries(ledger.entries);
      } catch (err) {
        setError(loadError(err));
      } finally {
        setLoading(false);
      }
    },
    [client, orgId, loadError],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // "Check again" and browser return re-read the authoritative pool.
  useEffect(() => {
    if (reloadSignal === 0) return;
    void load({ silent: true });
  }, [load, reloadSignal]);

  // The credit top-up grant lands asynchronously on the Stripe webhook, so the
  // immediate refetch after "Buy credits" usually races (and loses to) the
  // webhook. Subscribe to `credit.pool` signals so the pool updates live the
  // moment the webhook grants the credits; a signal (or a post-error reconnect)
  // triggers a silent refetch of the authoritative balance + ledger. When the
  // realtime stream is gated off the subscription reports `disabled` and the
  // manual/post-purchase refetch remains the fallback — never worse than before.
  // A signal is also the only hint an open checkout gets that a processing
  // payment settled or the model library unlocked. It is passed on as a
  // counter: a reason to read again, never the answer.
  const [checkoutRefreshSignal, setCheckoutRefreshSignal] = useState(0);
  const refreshFromSignal = useCallback((): void => {
    void load({ silent: true });
    setCheckoutRefreshSignal((current) => current + 1);
  }, [load]);
  // Without inline billing UI (desktop), the host's settings client carries
  // the same signals.
  const creditPoolSubscription =
    slots !== null ? (
      <slots.CreditPoolSubscription
        organizationId={orgId}
        onSignal={refreshFromSignal}
        onReconnect={refreshFromSignal}
      />
    ) : (
      <SettingsCreditPoolSubscription
        organizationId={orgId}
        onSignal={refreshFromSignal}
        onReconnect={refreshFromSignal}
      />
    );

  const reloadAfterAutoTopUp = useCallback((): Promise<void> => load(), [load]);

  // "Not set up yet" vs. "drained to zero after setup": a pool that has never
  // seen a single ledger entry has genuinely never been funded, so it gets the
  // welcoming empty state. Once any credit has been purchased/granted/used the
  // ledger is non-empty, so a balance that later returns to $0 keeps the normal
  // balance + activity view instead of reverting to the empty state.
  const neverFunded =
    summary !== null && summary.balanceCredits === 0 && entries.length === 0;

  const renderCard = (
    topUpButton: ReactNode,
    topUpDialog: ReactNode,
  ): JSX.Element => (
    <SettingsCard
      title="AI credit pool"
      subtitle={
        freeAccess
          ? FREE_ACCESS_POOL_SUBTITLE
          : 'Shared credits your team draws on after a member uses up the AI quota included with their seat.'
      }
      testId="team-billing-ai-credits"
    >
      <>
        {/* Default `mb-4` kept: the banner sits above the body content and
            owns the gutter below itself, since the card body wrapper already
            supplies the gutter above. */}
        <ErrorBanner
          errorSource="team-billing-change-payment"
          error={error?.copy}
          details={error?.details}
          onRetry={() => void load()}
        />
        {topUpDialog}

        {loading ? (
          <BillingCardBodySkeleton body="credits" />
        ) : summary === null ? (
          <p className="text-s fg-secondary">No AI credit details available.</p>
        ) : neverFunded ? (
          <EmptyState
            title="No AI credits yet"
            subtitle={`Buy credits to let your team use ${brandName}'s AI features.`}
            action={topUpButton ?? undefined}
          />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-lg font-semibold fg-primary">
                  {`${formatCredits(summary.balanceCredits)} credits`}
                </p>
              </div>
              {topUpButton}
            </div>

            <CreditsUsedThisPeriod
              summary={summary}
              testId="team-billing-ai-credits-used"
            />

            {slots !== null ? (
              <slots.AutoTopUpControls
                owner={owner}
                settings={summary.autoTopUp}
                monthlySpentUsd={summary.monthlySpentUsd}
                monthlyResetAt={formatMonthDay(summary.monthlyResetAt, {
                  timeZone: 'UTC',
                })}
                canManage={isOwner}
                onSaved={reloadAfterAutoTopUp}
                brandName={brandName}
                orgVariant
                testIdPrefix="team-"
                openAdjustRequestId={
                  intentTarget?.kind === 'auto-top-up'
                    ? intentTarget.requestId
                    : null
                }
              />
            ) : paymentMode.kind === 'handoff' ? (
              <AutoTopUpSummary
                settings={summary.autoTopUp}
                monthlySpentUsd={summary.monthlySpentUsd}
                monthlyResetAt={formatMonthDay(summary.monthlyResetAt, {
                  timeZone: 'UTC',
                })}
                brandName={brandName}
                orgVariant
                testIdPrefix="team-"
                action={
                  isOwner ? (
                    <PaymentAreaCta
                      action="auto-top-up"
                      testId="team-billing-manage-auto-top-up"
                    />
                  ) : null
                }
              />
            ) : null}

            <div className="mt-4" data-testid="team-billing-ai-credits-ledger">
              <p className="text-s font-medium fg-primary">Credit activity</p>
              {entries.length === 0 ? (
                <EmptyState
                  title="No credit activity yet."
                  subtitle="Purchases and usage appear here once the pool is active."
                />
              ) : (
                <div className="mt-2">
                  <SharedCreditLedgerTable
                    entries={entries}
                    formatDate={formatPlanDate}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </>
    </SettingsCard>
  );

  if (paymentMode.kind === 'handoff') {
    return (
      <>
        {creditPoolSubscription}
        {renderCard(
          isOwner ? (
            <PaymentAreaCta
              action="top-up"
              testId="team-billing-buy-credits-handoff"
            />
          ) : null,
          null,
        )}
      </>
    );
  }
  if (slots === null) return renderCard(null, null);

  // The trigger moves between the empty state and the balance row, and the
  // card swaps to its skeleton on a full reload, so the checkout itself is
  // rendered at a position none of that moves.
  return (
    <>
      {creditPoolSubscription}
      <slots.CreditsTopUp
        owner={owner}
        creditPriceUsd={summary?.creditPriceUsd}
        onToppedUp={() => void load({ silent: true })}
        testIdPrefix="team-"
        variant="secondary"
        intent={
          isOwner && intentTarget?.kind === 'top-up'
            ? intentTarget.intent
            : null
        }
        refreshSignal={checkoutRefreshSignal}
      >
        {({ trigger, dialog }) =>
          renderCard(isOwner ? trigger : null, isOwner ? dialog : null)
        }
      </slots.CreditsTopUp>
    </>
  );
}
