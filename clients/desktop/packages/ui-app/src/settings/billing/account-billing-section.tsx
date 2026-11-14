'use client';

import { Badge } from '@canopy/ui-shared/components/Badge';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import type { AiCreditsLedgerEntry } from '@canopy/protocol';
import {
  organizationBillingPath,
  type SettingsPaymentOwner,
} from '@canopy/protocol/billing';
import { planDisplayNameFromKey } from '@canopy/protocol/settings/billing-plan-catalog';
import {
  formatCardLabel,
  formatCredits,
  formatDate,
  formatExpiry,
  formatMonthDay,
  formatUsd,
} from '@canopy/ui-shared/lib';
import {
  Stack,
  BillingHistoryTable as SharedBillingHistoryTable,
  BusyLabel,
  Button,
  buttonClassName,
  CreditLedgerTable as SharedCreditLedgerTable,
  EmptyStateRow,
  ErrorBanner,
  Heading,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { BillingCardBodySkeleton } from './billing-card-body-skeleton';
import { CreditsUsedThisPeriod } from './credits-used-this-period';
import { InvoicesSection, INVOICES_PAGE_LIMIT } from './invoices-section';
import { trialBadgeLabel } from './trial-badge-label';
import { subscriptionPlanBadge } from './subscription-plan-badge';
import { AutoTopUpSummary } from './auto-top-up-summary';
import {
  useBillingSettingsSlots,
  type BillingSettingsIntentTarget,
} from './billing-settings-slots';
import { SettingsCreditPoolSubscription } from './settings-credit-pool-subscription';
import { PRO_PLAN_KEY } from './org-plan-ladder';
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
  SettingsLink,
  useSettingsBrand,
  useSettingsClient,
  useSettingsPrivacy,
  useSettingsSearchParams,
  useSettingsWorkspaceContext,
} from '../host';
import { withPrivacyClass } from '../account/privacy-class';
import { SETTINGS_LOAD_ERROR_COPY, useSettingsErrorCopy } from '../errors';
import { getCreditsBalance, getCreditsLedger } from '../organization/team-api';
import {
  isCancellationLapsed,
  type AccountBillingOrg,
  type BillingChrome,
  type BillingSummary,
  type BillingSummaryPaymentMethod,
  type ChargeHistoryItem,
  type CreditsSummary,
  type InvoicePage,
} from '@canopy/protocol/settings/billing';
import type { SettingsFailure } from '../errors';
import { Divider } from '@canopy/ui-shared/components';

const HISTORY_LOAD_MORE_ERROR = 'Unable to load more history.';

/** The personal wallet: account billing never pays for an organization. */
const PERSONAL_OWNER: SettingsPaymentOwner = { kind: 'personal' };

/** Shareable personal invoice detail URL. */
function accountInvoiceHref(invoice: { id: string }): string {
  return `/account/billing/invoices/${encodeURIComponent(invoice.id)}`;
}

type Status = 'loading' | 'ready' | 'error';

/* -------------------------------------------------------------------------- */
/* BillingSection container                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Account-page billing panel (CAN-1035 / T15). Self-fetches the user's
 * {@link BillingSummary} plus the first page of charge history, then renders a
 * plan card, a Stripe-backed payment-method card (only when a publishable key
 * is configured), and a paged billing-history table. Mirrors the self-fetching
 * `loading` / `ready` / `error` pattern used by the sibling account panels.
 *
 * When an organization *actively covers* the user (`orgCovered`), the personal
 * plan / payment-method flow is replaced by an org-covers-billing panel: a
 * personal card would be misleading, since the org (not the individual) is
 * responsible for the subscription. In that case the summary (for the saved card
 * that funds the member's own AI-credit top-ups) and the charge history (for the
 * transparency transactions card below the credits wallet, on the rare occasion a
 * covered member has real USD charges) are still fetched — both supplementary, so
 * failures are swallowed rather than erroring the panel — while the personal plan
 * card itself is skipped.
 * `orgCovered` is resolved server-side by `resolvePersonalBillingCoverage`,
 * the same rule the renewal sweep bills by: a member with a live personal
 * subscription is covered only by a PAID org, and a member with no personal plan
 * by any live org (trial included). A member of a lapsed/non-paying org, or a
 * trial-org member whose personal renewal is still billed (ECW-9231), is *not*
 * covered and still sees the personal plan — keeping the "no personal payment
 * method is required" copy honest.
 */
export function BillingSection({
  orgs = [],
  orgCovered = false,
  chrome = null,
  freeAccess = false,
}: {
  orgs?: AccountBillingOrg[];
  orgCovered?: boolean;
  /** Resolved billing chrome for the subscription pill (same source as the
   * sidebar account menu's plan pill), or null when billing chrome is
   * unavailable. */
  chrome?: BillingChrome | null;
  /**
   * Server-resolved free app access (CAN-3926). There is no subscription, so
   * neither "Subscription plan" variant renders (the personal plan card with
   * its upgrade CTA and trial nudge, or the org-coverage card with its
   * "Manage organization billing" links), and the AI credits wallet leads the
   * page. The payment method and receipts stay in the billing-history card.
   */
  freeAccess?: boolean;
}): JSX.Element {
  const client = useSettingsClient();
  const slots = useBillingSettingsSlots();
  const paymentMode = usePaymentAreaMode();
  // Card capture is possible inline (Stripe configured) or through the web
  // handoff; this replaces the old "Stripe key present" predicate.
  const paymentsAvailable = paymentCaptureAvailable(paymentMode);
  const viewerId = useSettingsWorkspaceContext().accountKey;
  const queryPlanKey = useSettingsSearchParams().get('plan');
  // The one-shot top-up or payment modal intent this page was opened with,
  // read by the host's intent controller once the data it gates on is ready.
  const [intentTarget, setIntentTarget] =
    useState<BillingSettingsIntentTarget | null>(null);
  const intentPlanKey =
    intentTarget?.kind === 'subscription' && intentTarget.plan !== undefined
      ? intentTarget.plan
      : queryPlanKey;
  const [status, setStatus] = useState<Status>('loading');
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  // The first summary read finished (either way): the intent can be decided.
  const [summarySettled, setSummarySettled] = useState(false);
  const [charges, setCharges] = useState<ChargeHistoryItem[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [creditsReloadSignal, setCreditsReloadSignal] = useState(0);
  const planCardRef = useRef<HTMLElement | null>(null);

  const reloadSummary = useCallback(async (): Promise<void> => {
    try {
      const body = await client.read('account.billing.summary', {});
      setSummary(body);
    } finally {
      setSummarySettled(true);
    }
  }, [client]);

  const loadHistoryPage = useCallback(async (): Promise<void> => {
    const historyBody = await client.read('account.billing.charges', {});
    setCharges(historyBody.charges);
    setHistoryCursor(historyBody.nextCursor);
  }, [client]);

  // Stable per client: `InvoicesSection` loads its first page from an effect
  // keyed on this callback, and owns the copy and logging for its failures.
  const loadAccountInvoicePage = useCallback(
    (cursor: string | null): Promise<InvoicePage> =>
      client.read('account.billing.invoices', {
        limit: INVOICES_PAGE_LIMIT,
        cursor,
      }),
    [client],
  );

  const errorCopy = useSettingsErrorCopy('billing:account-summary');
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      await reloadSummary();
      await loadHistoryPage();
      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setError(errorCopy.loadFailure(err));
    }
  }, [reloadSummary, loadHistoryPage, errorCopy]);

  /** Retry a failed first load: back to the skeleton, then read again. */
  const retryLoad = useCallback((): void => {
    setStatus('loading');
    void refresh();
  }, [refresh]);

  // Org coverage only changes the page while it has a plan tile to replace.
  // With free access there is none, so the personal summary is the payment
  // method's only source and its failure is reported like anyone else's.
  const coverageView = orgCovered && !freeAccess;

  useEffect(() => {
    // Defer the initial load out of the synchronous effect body so the fetch's
    // setState does not trigger a cascading render (mirrors SecurityPanel).
    const timeoutId = window.setTimeout(() => {
      // Org-covered users see the coverage panel instead of a personal plan, but
      // we still fetch two supplementary things for them: the summary (for the
      // saved card that funds their own AI-credit top-ups) and the charge
      // history (so any real USD charges — rare for a covered member, but
      // possible — surface in the transactions card below the credits wallet).
      // Both are swallowed on failure so a covered user never shows a personal
      // error panel.
      if (coverageView) {
        void reloadSummary().catch(() => undefined);
        void loadHistoryPage().catch(() => undefined);
      } else {
        void refresh();
      }
    }, 0);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [refresh, reloadSummary, loadHistoryPage, coverageView]);

  const handleCardSaved = useCallback((): void => {
    // Refetch the summary so the payment-method card reflects the new card. A
    // failed refetch leaves the previous summary in place rather than erroring
    // the whole panel.
    void reloadSummary().catch(() => undefined);
  }, [reloadSummary]);

  const loadMoreHistory = useCallback(async (): Promise<void> => {
    if (!historyCursor) return;
    setHistoryError(null);
    try {
      const body = await client.read('account.billing.charges', {
        cursor: historyCursor,
      });
      setCharges((prev) => [...prev, ...body.charges]);
      setHistoryCursor(body.nextCursor);
    } catch {
      // Surface a lightweight, retryable error instead of silently swallowing
      // the failure — the "Load more" button re-enables so the user can retry.
      setHistoryError(HISTORY_LOAD_MORE_ERROR);
    }
  }, [client, historyCursor]);

  /** "Check again" and browser return: re-read wallet, card and activity. */
  const refreshAuthoritative = useCallback((): void => {
    void reloadSummary().catch(() => undefined);
    void loadHistoryPage().catch(() => undefined);
    setCreditsReloadSignal((current) => current + 1);
  }, [reloadSummary, loadHistoryPage]);

  // A subscription intent without a plan opens the update-card modal when the
  // plan needs a working card; otherwise the plan card is brought into view
  // and nothing opens. A payment-method intent opens the card modal.
  const subscriptionNeedsCard =
    intentTarget?.kind === 'subscription' &&
    intentTarget.plan === undefined &&
    summary !== null &&
    billingSummaryNeedsPaymentMethod(summary);
  const openCardRequestId =
    intentTarget?.kind === 'payment-method' || subscriptionNeedsCard
      ? intentTarget.requestId
      : null;
  const focusPlanCard =
    intentTarget?.kind === 'subscription' && !subscriptionNeedsCard;
  useEffect(() => {
    if (!focusPlanCard) return;
    const card = planCardRef.current;
    if (card !== null && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ block: 'center' });
    }
  }, [focusPlanCard]);

  const hasSavedCard = summary?.paymentMethod != null;
  // Mirror the org billing tab: the grouped billing-history card is hidden
  // unless it carries real value — a saved card on file or at least one USD
  // charge. A configured Stripe key alone no longer shows an empty "Add card"
  // shell; the first card is captured via the plan CTA or the credit top-up
  // flow. When the card IS shown, the payment subcard still renders so a card
  // can be added or managed alongside existing history.
  // A card intent shows the card even when it is otherwise empty, so the modal
  // opens from its own subcard.
  const showBillingCard =
    hasSavedCard ||
    charges.length > 0 ||
    (openCardRequestId !== null && paymentsAvailable);
  const showPaymentSubcard = paymentsAvailable || hasSavedCard;
  // A plain stack, not a card: an outer card around these three only wrapped a
  // heading ("Billing") that the tab the viewer clicked already says, and pushed
  // every real card down a level into `border`-on-`bg-card` subcards that read
  // as secondary to the peers on Account and Security. `gap-6` matches the
  // gutter the account layout gives sibling cards elsewhere, and matches the org
  // Billing subtab exactly.
  return (
    <PaymentArea
      owner={PERSONAL_OWNER}
      canManage
      refresh={refreshAuthoritative}
    >
      <div
        className="flex flex-col gap-6"
        data-testid="account-billing-section"
      >
        {slots !== null ? (
          <slots.IntentController
            viewerId={viewerId}
            owner={PERSONAL_OWNER}
            canManageBilling
            dataReady={summarySettled}
            onTarget={setIntentTarget}
          />
        ) : null}
        <PaymentAreaNotice testId="billing-payment-handoff" />
        {/* Empty `className` on purpose: the default is `mb-4`, which would stack
          on top of the wrapper's `gap-6` and leave a lopsided gutter. Suppressed
          for covered users, whose personal-summary failure is deliberately
          swallowed. */}
        <ErrorBanner
          errorSource="billing-section"
          className=""
          error={
            coverageView || status !== 'error'
              ? null
              : (error?.copy ?? SETTINGS_LOAD_ERROR_COPY)
          }
          details={error?.details}
          onRetry={retryLoad}
        />

        {freeAccess ? null : orgCovered ? (
          <OrgCoverageCard
            orgs={orgs}
            chrome={chrome}
            summary={summary}
            onChanged={handleCardSaved}
            cardRef={planCardRef}
          />
        ) : status === 'error' ? null : (
          /* On failure the `ErrorBanner` above is the single voice. Rendering the
           card too would show two messages for one failure ("We couldn't load
           your billing details…" and "No plan details available."). */
          <PlanCard
            summary={status === 'ready' ? summary : null}
            loading={status === 'loading'}
            paymentsAvailable={paymentsAvailable}
            onCardMutated={handleCardSaved}
            intentPlanKey={intentPlanKey}
            cardRef={planCardRef}
          />
        )}

        {/* Personal AI-credits wallet. Shown regardless of org coverage: credits
          are usage-based and independent of seat coverage, so an org-covered
          user still has a personal wallet. Self-loads its own credits balance. */}
        <AiCreditsCard
          freeAccess={freeAccess}
          intentTarget={intentTarget}
          reloadSignal={creditsReloadSignal}
        />

        {showBillingCard && (
          <BillingHistoryCard
            paymentMethod={summary?.paymentMethod ?? null}
            showPaymentSubcard={showPaymentSubcard}
            paymentsAvailable={paymentsAvailable}
            onCardMutated={handleCardSaved}
            openCardRequestId={openCardRequestId}
            charges={charges}
            hasMore={historyCursor !== null}
            onLoadMore={loadMoreHistory}
            loadMoreError={historyError}
            loadInvoicePage={loadAccountInvoicePage}
          />
        )}
      </div>
    </PaymentArea>
  );
}

/* -------------------------------------------------------------------------- */
/* BillingHistoryCard                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The billing-history card: the saved card as a solid subcard (its honest home
 * now that it sits alongside the real USD charges), the invoices list, then the
 * transactions table under its own "Transactions" subheader. The transactions
 * block only renders when there is at least one charge; most org-covered
 * members will have none.
 *
 * {@link SavedCardSection} stays a genuine subcard — it is the one nested thing
 * on this tab, mirroring `PaymentMethodSubcard` on the org side.
 */
function BillingHistoryCard({
  paymentMethod,
  showPaymentSubcard,
  paymentsAvailable,
  onCardMutated,
  openCardRequestId,
  charges,
  hasMore,
  onLoadMore,
  loadMoreError,
  loadInvoicePage,
}: {
  paymentMethod: BillingSummaryPaymentMethod | null;
  showPaymentSubcard: boolean;
  paymentsAvailable: boolean;
  onCardMutated: () => void;
  openCardRequestId: string | null;
  charges: ChargeHistoryItem[];
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  loadMoreError: string | null;
  loadInvoicePage: (cursor: string | null) => Promise<InvoicePage>;
}): JSX.Element {
  return (
    <SettingsCard
      title="Billing history"
      subtitle="Charges billed to your card in USD."
      // Namespaced: a bare `billing-history-card` would prefix-collide with the
      // `billing-history-card-${charge.id}` row IDs that the shared
      // `BillingHistoryTable` emits inside this very card.
      testId="account-billing-history-card"
    >
      <div className="flex flex-col gap-4">
        {showPaymentSubcard && (
          <SavedCardSection
            paymentMethod={paymentMethod}
            paymentsAvailable={paymentsAvailable}
            onCardMutated={onCardMutated}
            openCardRequestId={openCardRequestId}
          />
        )}
        <InvoicesSection
          loadPage={loadInvoicePage}
          hrefFor={accountInvoiceHref}
          testId="billing-invoices"
        />
        {charges.length > 0 && (
          <BillingTransactions
            charges={charges}
            hasMore={hasMore}
            onLoadMore={onLoadMore}
            loadMoreError={loadMoreError}
          />
        )}
      </div>
    </SettingsCard>
  );
}

/* -------------------------------------------------------------------------- */
/* OrgCoverageCard                                                             */
/* -------------------------------------------------------------------------- */

/** The organization billing links: Settings capsules, secondary like every page action. */
const ORG_BILLING_LINK_CLASS = buttonClassName({ size: 'compact' });

/**
 * The manageable org whose billing link is emphasized, or null when none is
 * (CAN-3465). A sole manageable org is the answer outright. With several, it
 * is the organization selected in the navigation context, when the viewer can
 * manage that one. Otherwise nothing says which org the viewer means, so none
 * is emphasized and the caller lists them all equally.
 */
function resolveEmphasizedBillingOrg(
  manageable: readonly AccountBillingOrg[],
  selectedOrganizationId: string | null,
): AccountBillingOrg | null {
  const [sole] = manageable;
  if (manageable.length === 1 && sole) return sole;
  if (selectedOrganizationId === null) return null;
  const selectedId = selectedOrganizationId.toLowerCase();
  return manageable.find((org) => org.id.toLowerCase() === selectedId) ?? null;
}

/**
 * Shown on the account billing panel when the user belongs to one or more
 * organizations. Instead of a personal plan / add-card flow (which would imply
 * the individual pays), it states that the organization is responsible for
 * billing.
 *
 * Members who can manage an org's billing (OWNER / ADMIN) get a link to that
 * org's billing page. Which link is emphasized is decided by
 * {@link resolveEmphasizedBillingOrg} and never guessed: with no emphasized org
 * every manageable org is an equal secondary CTA under "Organizations you
 * manage"; with one, it is the single primary CTA and the rest are secondary
 * CTAs under "Other organizations". Orgs the user cannot manage are listed as
 * bullets (a manageable org is already represented by its CTA, and a single org
 * is named in the intro).
 */
function OrgCoverageCard({
  orgs,
  chrome,
  summary,
  onChanged,
  cardRef,
}: {
  orgs: AccountBillingOrg[];
  chrome: BillingChrome | null;
  /**
   * The viewer's PERSONAL summary, fetched for covered users too. Null until it
   * lands (or when it failed, which is swallowed for covered users).
   */
  summary: BillingSummary | null;
  /** Re-fetch the personal summary after a cancel / resume. */
  onChanged: () => void;
  /** Brought into view by a subscription intent. */
  cardRef: RefObject<HTMLElement | null>;
}): JSX.Element {
  const slots = useBillingSettingsSlots();
  const { blockClassName } = useSettingsPrivacy();
  const { workspaceContext } = useSettingsWorkspaceContext();
  const single = orgs.length === 1;
  const [soleOrg] = orgs;
  const manageable = orgs.filter((org) => org.canManageBilling);
  const primary = resolveEmphasizedBillingOrg(
    manageable,
    workspaceContext.kind === 'organization'
      ? workspaceContext.organizationId
      : null,
  );
  const otherManageable = manageable.filter((org) => org.id !== primary?.id);
  const listedOrgs = single ? [] : orgs.filter((org) => !org.canManageBilling);
  const personalPending = summary?.pendingCancellation ?? null;
  const subscriptionBadge = subscriptionPlanBadge(chrome);
  // A lapsed end date must never be rendered as a future promise. The server
  // now cancels a lapsed row immediately, but a flagged TRIALING row past its
  // trial end (or an ACTIVE row awaiting the hourly sweep) can still land here.
  const personalPendingLapsed =
    personalPending !== null &&
    isCancellationLapsed(personalPending.effectiveAt);
  // It *replaces* `PlanCard`, so it lands at the same level and carries the same
  // shell — the grouped box and the `h2` heading. The old
  // `mt-4` is gone: the stack's `gap-6` owns spacing between cards now.
  return (
    <section
      ref={cardRef}
      className={SETTINGS_CARD_CLASS}
      data-testid="billing-org-coverage"
    >
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <div className="flex items-start gap-3">
          <Stack gap="group" className="min-w-0 flex-1">
            <Stack gap="item">
              <div className="flex items-start justify-between gap-3">
                <Stack gap="inline" className="min-w-0">
                  <Stack gap="tight">
                    <div className="flex flex-wrap items-center gap-2">
                      <Heading level={2} variant="section">
                        Subscription plan
                      </Heading>
                      {subscriptionBadge !== null && (
                        <Badge
                          tone={subscriptionBadge.tone}
                          data-testid="billing-plan-pill"
                        >
                          {subscriptionBadge.label}
                        </Badge>
                      )}
                    </div>
                    <p
                      className={withPrivacyClass(
                        'text-s fg-secondary',
                        single ? blockClassName : '',
                      )}
                    >
                      {single && soleOrg !== undefined
                        ? `Your seat is covered by ${soleOrg.name}, so no personal payment method is required for your plan.`
                        : 'Your seat is covered by your organization, so no personal payment method is required for your plan.'}
                    </p>
                  </Stack>
                  {personalPending !== null ? (
                    <p
                      className="text-xs fg-secondary"
                      data-testid="billing-org-coverage-cancels-on"
                    >
                      {personalPendingLapsed
                        ? 'Your personal plan is ending. Access will end shortly.'
                        : `Your personal plan cancels on ${formatDate(
                            personalPending.effectiveAt,
                          )}. You can resume any time before then.`}
                    </p>
                  ) : null}
                </Stack>
                {/* A covered member normally has no personal plan and therefore no
                menu. This branch replaces `PlanCard` entirely, so without the
                menu here a user holding a REDUNDANT personal plan (the case
                `buildCoverageNotes` already flags) would have no cancel path at
                all. The menu self-suppresses when there is no live personal
                subscription, which is exactly the "don't show it to plain org
                members" rule. */}
                {summary !== null && slots !== null ? (
                  <slots.SubscriptionActionsMenu
                    scope="user"
                    summary={summary}
                    onChanged={onChanged}
                  />
                ) : null}
              </div>
              {listedOrgs.length > 0 && (
                <ul className="list-disc flex flex-col gap-1 pl-5">
                  {listedOrgs.map((org) => (
                    <li
                      key={org.id}
                      className={withPrivacyClass(
                        'text-s fg-primary',
                        blockClassName,
                      )}
                    >
                      {org.name}
                    </li>
                  ))}
                </ul>
              )}
            </Stack>
            {primary && (
              <div>
                <SettingsLink
                  href={organizationBillingPath(primary.id)}
                  data-testid="billing-org-primary-cta"
                  className={withPrivacyClass(
                    ORG_BILLING_LINK_CLASS,
                    single ? '' : blockClassName,
                  )}
                >
                  {single
                    ? 'Manage organization billing'
                    : `Manage ${primary.name} billing`}
                </SettingsLink>
              </div>
            )}
            {otherManageable.length > 0 && (
              <Stack gap="inline">
                <p className="text-xs font-medium fg-secondary">
                  {primary ? 'Other organizations' : 'Organizations you manage'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {otherManageable.map((org) => (
                    <SettingsLink
                      key={org.id}
                      href={organizationBillingPath(org.id)}
                      data-testid="billing-org-secondary-cta"
                      className={withPrivacyClass(
                        ORG_BILLING_LINK_CLASS,
                        blockClassName,
                      )}
                    >
                      {`Manage ${org.name} billing`}
                    </SettingsLink>
                  ))}
                </div>
              </Stack>
            )}
          </Stack>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* PlanCard                                                                    */
/* -------------------------------------------------------------------------- */

interface PlanCardProps {
  /**
   * `null` while the summary is still loading. The card owns that state itself
   * so the stack above stays a flat list of cards rather than growing ad-hoc
   * `<p>` branches beside them. The stack suppresses this card entirely on a
   * load failure, so `null` here never means "errored".
   */
  summary: BillingSummary | null;
  loading: boolean;
  /** Card capture is possible (inline Stripe, or the web handoff). */
  paymentsAvailable: boolean;
  /** Refresh the summary after a successful subscribe. */
  onCardMutated: () => void;
  intentPlanKey: string | null;
  /** Brought into view by a subscription intent. */
  cardRef: RefObject<HTMLElement | null>;
}

/**
 * The plan card owns the *plan* only: plan/trial + next billing on the left, and
 * an explicit "Upgrade to Pro" subscribe CTA on the right for users not already
 * on a paid personal plan. The saved card is no longer shown or managed here —
 * it lives in {@link AiCreditsCard} (its honest home, since the card funds AI
 * credit top-ups). This keeps one clear place to subscribe (plan) and one clear
 * place to view/manage the card (credits) — see CAN-1035 / the card-vs-plan
 * decoupling.
 */
function PlanCard({
  summary,
  loading,
  paymentsAvailable,
  onCardMutated,
  intentPlanKey,
  cardRef,
}: PlanCardProps): JSX.Element {
  const slots = useBillingSettingsSlots();
  if (summary === null) {
    return (
      <section
        ref={cardRef}
        className={SETTINGS_CARD_CLASS}
        data-testid="billing-plan-card"
      >
        <div className={SETTINGS_CARD_GROUP_CLASS}>
          <div className="flex items-start gap-3">
            <Stack gap="tight" className="min-w-0 flex-1">
              <Heading level={2} variant="section">
                Subscription plan
              </Heading>
              {/* The failure MESSAGE is the stack's `ErrorBanner` above, so this
                branch stays a neutral placeholder rather than repeating it. */}
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

  const { plan, trial, nextBillingAmountUsd, nextBillingDate, seatCount } =
    summary;
  const pendingCancellation = summary.pendingCancellation ?? null;
  // An admin-granted complimentary plan is an ACTIVE $0 row. "Next billing:
  // $0.00 on …" reads like a billing bug, so it shows "Complimentary" instead
  // (mirrors the org billing tab).
  const complimentary = summary.complimentary === true;
  // See `personalPendingLapsed` above: a quoted end date that has already
  // elapsed is swapped for dateless copy rather than promising access "until"
  // a day in the past.
  const pendingCancellationLapsed =
    pendingCancellation !== null &&
    isCancellationLapsed(pendingCancellation.effectiveAt);
  const proName = planDisplayNameFromKey(PRO_PLAN_KEY) ?? 'Pro';
  // Mirror the org billing tab: while trialing with no card, swap the generic
  // description for a reassuring nudge that points at the "Get Pro" CTA (which
  // charges immediately to lock the plan in).
  const showTrialNudge =
    (trial?.active ?? false) &&
    summary.paymentMethod === null &&
    paymentsAvailable;
  // What a host without inline checkout may recover on the web, if anything.
  const recovery = subscriptionRecoveryIntent(summary, PRO_PLAN_KEY);

  return (
    <section
      ref={cardRef}
      className={SETTINGS_CARD_CLASS}
      data-testid="billing-plan-card"
    >
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <Stack gap="inline" className="min-w-0">
              <Stack gap="tight">
                <div className="flex flex-wrap items-center gap-2">
                  <Heading level={2} variant="section">
                    Subscription plan
                  </Heading>
                  <Badge data-testid="billing-plan-pill">
                    {plan ? plan.displayName : 'Free'}
                  </Badge>
                  {trial?.active && (
                    <Badge tone="warning">
                      {trialBadgeLabel(trial.endsAt)}
                    </Badge>
                  )}
                  {seatCount !== null && seatCount > 0 && (
                    <span className="text-xs fg-secondary">
                      {`${seatCount} ${seatCount === 1 ? 'seat' : 'seats'}`}
                    </span>
                  )}
                </div>

                <p className="text-xs fg-secondary">
                  {showTrialNudge
                    ? `You're on a free trial — nothing's due yet. Upgrade to ${proName} to lock in your access.`
                    : 'Your plan and next payment.'}
                </p>
              </Stack>

              {/* A pending cancellation REPLACES the next-billing line: there is no
              next charge, and a silently-canceling plan that still advertises a
              billing date is the single most common cancellation support ticket.
              While trialing, the countdown pill + the nudge above already convey
              the timing, so the plain "Next billing" line is redundant. */}
              {pendingCancellation !== null ? (
                <Stack gap="tight">
                  <p
                    className="text-s fg-secondary"
                    data-testid="billing-cancels-on"
                  >
                    {pendingCancellationLapsed
                      ? 'Canceling'
                      : `Cancels on ${formatDate(
                          pendingCancellation.effectiveAt,
                        )}`}
                  </p>
                  <p
                    className="text-xs fg-secondary"
                    data-testid="billing-pending-cancel-notice"
                  >
                    {pendingCancellationLapsed
                      ? 'Your plan is ending. Access will end shortly.'
                      : `Your plan stays active until ${formatDate(
                          pendingCancellation.effectiveAt,
                        )}. You can resume any time before then.`}
                  </p>
                </Stack>
              ) : complimentary ? (
                <p
                  className="text-s fg-secondary"
                  data-testid="billing-complimentary"
                >
                  Complimentary
                </p>
              ) : (
                !(trial?.active ?? false) &&
                nextBillingAmountUsd !== null &&
                nextBillingDate !== null && (
                  <p className="text-s fg-secondary">
                    {`Next billing: ${formatUsd(
                      nextBillingAmountUsd,
                    )} on ${formatDate(nextBillingDate)}`}
                  </p>
                )
              )}

              {summary.coverageNotes.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {summary.coverageNotes.map((note) => (
                    <li key={note} className="text-xs fg-secondary">
                      {note}
                    </li>
                  ))}
                </ul>
              )}
            </Stack>

            <div className="flex shrink-0 items-center gap-2">
              <PaymentAreaCta
                action="subscription"
                offered={recovery !== null}
                plan={recovery?.plan}
                testId="billing-manage-billing-on-web"
                inline={
                  slots !== null ? (
                    <>
                      {slots.publishableKey && (
                        <slots.PersonalPlanSubscribeCta
                          summary={summary}
                          onSubscribed={onCardMutated}
                          intentPlanKey={intentPlanKey}
                        />
                      )}
                      <slots.SubscriptionActionsMenu
                        scope="user"
                        summary={summary}
                        onChanged={onCardMutated}
                      />
                    </>
                  ) : null
                }
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* BillingTransactions                                                        */
/* -------------------------------------------------------------------------- */

interface BillingTransactionsProps {
  charges: ChargeHistoryItem[];
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  loadMoreError: string | null;
}

/**
 * The USD transactions table, rendered under a "Transactions" subheader inside
 * the grouped billing-history card (below the card title and the saved-card
 * subcard). The parent only mounts this when there is at least one charge, so
 * there is no empty state here.
 */
function BillingTransactions({
  charges,
  hasMore,
  onLoadMore,
  loadMoreError,
}: BillingTransactionsProps): JSX.Element {
  const [loadingMore, setLoadingMore] = useState(false);

  const handleLoadMore = async (): Promise<void> => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      await onLoadMore();
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Stack gap="item" data-testid="billing-history">
      <Stack gap="inline">
        <p className="text-s font-medium fg-primary">Transactions</p>
        <div>
          <SharedBillingHistoryTable
            charges={charges}
            formatDate={formatDate}
          />
        </div>
        <ErrorBanner
          errorSource="billing-transactions-load-more"
          error={loadMoreError}
        />
      </Stack>
      {hasMore && (
        <Button
          size="compact"
          onClick={() => void handleLoadMore()}
          disabled={loadingMore}
          aria-busy={loadingMore}
          className="self-start"
        >
          <BusyLabel busy={loadingMore}>Load more</BusyLabel>
        </Button>
      )}
    </Stack>
  );
}

/* -------------------------------------------------------------------------- */
/* AiCreditsCard — personal AI-credits wallet (CAN-1040 / T17)                */
/* -------------------------------------------------------------------------- */

/**
 * The wallet's subtitle with free access on: there is no monthly plan
 * allotment to draw down first, so it names only the credits themselves.
 */
const FREE_ACCESS_CREDITS_SUBTITLE = 'Credits for AI models. Buy more anytime.';

/**
 * The account "AI credits wallet" card. Self-loads the personal
 * {@link CreditsSummary} plus the first ledger page, then renders the balance
 * (in credits — the ledger's own unit, not a USD figure that would read as a
 * refundable cash balance), the plain-text month-to-date consumption line, the
 * shared "Buy credits" button with the no-saved-card fallback, the shared
 * {@link AutoTopUpControls}, and the credit ledger. Personal credits are
 * usage-based, so this renders even for org-covered users.
 *
 * The saved card that funds these top-ups no longer lives here — it moved to the
 * grouped payment + billing card below the wallet (its honest home now that it
 * sits alongside the real USD charges). The host's inline billing UI (or the
 * web handoff) owns the shared "Buy credits" flow's card capture.
 */
function AiCreditsCard({
  freeAccess = false,
  intentTarget,
  reloadSignal,
}: {
  /** Free access has no plan quota, so the subtitle names none. */
  freeAccess?: boolean;
  /** The page's top-up or automatic top-up intent, once read. */
  intentTarget: BillingSettingsIntentTarget | null;
  /** Bumped by "Check again" and browser return: reload silently. */
  reloadSignal: number;
}): JSX.Element | null {
  const client = useSettingsClient();
  const slots = useBillingSettingsSlots();
  const paymentsHandoff = usePaymentAreaMode().kind === 'handoff';
  const brandName = useSettingsBrand().displayName;
  const [status, setStatus] = useState<Status>('loading');
  const [summary, setSummary] = useState<CreditsSummary | null>(null);
  const [entries, setEntries] = useState<AiCreditsLedgerEntry[]>([]);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const errorCopy = useSettingsErrorCopy('billing:account-credits');

  const load = useCallback(
    async (options?: { silent?: boolean }): Promise<void> => {
      try {
        setError(null);
        const [nextSummary, ledger] = await Promise.all([
          getCreditsBalance(client),
          getCreditsLedger(client),
        ]);
        setSummary(nextSummary);
        setEntries(ledger.entries);
        setStatus('ready');
      } catch (err) {
        // A `silent` refetch (realtime signal / post-purchase) that fails keeps
        // the already-rendered summary in place rather than flipping the whole
        // card to the error state — the stream and manual refetch remain the
        // fallback, so the card is never worse than before.
        if (!options?.silent) {
          setStatus('error');
          setError(errorCopy.loadFailure(err));
        }
      }
    },
    [client, errorCopy],
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [load]);

  // "Check again" and browser return re-read the authoritative wallet.
  useEffect(() => {
    if (reloadSignal === 0) return;
    void load({ silent: true });
  }, [load, reloadSignal]);

  // The credit top-up grant lands asynchronously on the Stripe webhook, so the
  // immediate refetch after "Buy credits" usually races (and loses to) the
  // webhook. Subscribe to the personal `credit.pool` stream so the balance and
  // ledger update live the moment the webhook grants credits; a signal (or a
  // post-error reconnect) triggers a silent refetch of the authoritative
  // balance. When the realtime stream is gated off the subscription reports
  // `disabled` and the manual/post-purchase refetch remains the fallback.
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
        onSignal={refreshFromSignal}
        onReconnect={refreshFromSignal}
      />
    ) : (
      <SettingsCreditPoolSubscription
        onSignal={refreshFromSignal}
        onReconnect={refreshFromSignal}
      />
    );

  const reloadAfterAutoTopUp = useCallback((): Promise<void> => load(), [load]);

  // The old `<h3>AI credits</h3>` disappears into the card title — it was only
  // a subheading because the card used to be nested inside the Billing wrapper.
  const shell = (children: JSX.Element): JSX.Element => (
    <>
      {creditPoolSubscription}
      <SettingsCard
        title="AI credits"
        subtitle={
          freeAccess
            ? FREE_ACCESS_CREDITS_SUBTITLE
            : 'Credits you draw on after using up the AI quota included with your plan.'
        }
        testId="billing-ai-credits"
      >
        {children}
      </SettingsCard>
    </>
  );

  if (status === 'loading') {
    return shell(<BillingCardBodySkeleton body="credits" />);
  }

  if (status === 'error' || summary === null) {
    // Rendered INSIDE the card rather than replacing it, matching the org
    // credit-pool card: the title/subtitle still orient the viewer while the
    // balance is unavailable.
    return shell(
      <ErrorBanner
        errorSource="ai-credits-card"
        className=""
        error={error?.copy ?? SETTINGS_LOAD_ERROR_COPY}
        details={error?.details}
        onRetry={() => {
          setStatus('loading');
          void load();
        }}
      />,
    );
  }

  const monthlyResetAt = formatMonthDay(summary.monthlyResetAt, {
    timeZone: 'UTC',
  });

  return shell(
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The account page shows only the personal wallet. Which org pool
              covers a turn depends on the org that owns that work (CAN-3463),
              so there is no single account-wide "Covered by" payer to name. */}
          <p className="text-lg font-semibold fg-primary">
            {`${formatCredits(summary.balanceCredits)} credits`}
          </p>
        </div>
        <PaymentAreaCta
          action="top-up"
          testId="billing-buy-credits-handoff"
          inline={
            slots !== null ? (
              <slots.CreditsTopUp
                owner={PERSONAL_OWNER}
                creditPriceUsd={summary.creditPriceUsd}
                onToppedUp={() => void load({ silent: true })}
                testIdPrefix=""
                variant="secondary"
                intent={
                  intentTarget?.kind === 'top-up' ? intentTarget.intent : null
                }
                refreshSignal={checkoutRefreshSignal}
              >
                {({ trigger, dialog }) => (
                  <>
                    {trigger}
                    {dialog}
                  </>
                )}
              </slots.CreditsTopUp>
            ) : null
          }
        />
      </div>

      <CreditsUsedThisPeriod
        summary={summary}
        testId="billing-ai-credits-used"
      />

      {slots !== null ? (
        <slots.AutoTopUpControls
          owner={PERSONAL_OWNER}
          settings={summary.autoTopUp}
          monthlySpentUsd={summary.monthlySpentUsd}
          monthlyResetAt={monthlyResetAt}
          canManage
          onSaved={reloadAfterAutoTopUp}
          brandName={brandName}
          openAdjustRequestId={
            intentTarget?.kind === 'auto-top-up' ? intentTarget.requestId : null
          }
        />
      ) : paymentsHandoff ? (
        <AutoTopUpSummary
          settings={summary.autoTopUp}
          monthlySpentUsd={summary.monthlySpentUsd}
          monthlyResetAt={monthlyResetAt}
          brandName={brandName}
          action={
            <PaymentAreaCta
              action="auto-top-up"
              testId="billing-manage-auto-top-up"
            />
          }
        />
      ) : null}

      <CreditsLedgerTable entries={entries} />
    </>,
  );
}

/* -------------------------------------------------------------------------- */
/* SavedCardSection — saved card display + management (payment + billing card) */
/* -------------------------------------------------------------------------- */

/**
 * The saved-card subcard rendered inside the grouped billing-history card below
 * the AI-credits wallet: the card label ("Visa ····4242, exp 12/30") framed as
 * the payment method, plus the Add / Edit / Remove affordances (via
 * the host's payment-method actions). It reads as a solid subcard (`bg-muted`),
 * mirroring the auto-top-up subcard. Sitting alongside the USD charge history
 * makes its purpose self-evident, so no "Used for…" qualifier is needed. Shown
 * for every user (covered or not). When Stripe is unconfigured, the card is
 * shown read-only (no management) and, if there is no card at all, nothing
 * renders.
 */
function SavedCardSection({
  paymentMethod,
  paymentsAvailable,
  onCardMutated,
  openCardRequestId,
}: {
  paymentMethod: BillingSummaryPaymentMethod | null;
  paymentsAvailable: boolean;
  onCardMutated: () => void;
  openCardRequestId: string | null;
}): JSX.Element | null {
  const slots = useBillingSettingsSlots();
  const { blockClassName } = useSettingsPrivacy();
  const cardLabelClass = withPrivacyClass('text-s fg-primary', blockClassName);
  const cardLabel = paymentMethod
    ? `${formatCardLabel(
        paymentMethod.brand,
        paymentMethod.last4,
      )}, exp ${formatExpiry(paymentMethod.expMonth, paymentMethod.expYear)}`
    : null;

  // Without Stripe we cannot capture or remove a card. Still surface the saved
  // card read-only if one exists; render nothing when there is also no card.
  if (!paymentsAvailable) {
    if (!cardLabel) return null;
    return (
      <div>
        <div
          className="pb-4 flex flex-col gap-1"
          data-testid="billing-payment-method"
        >
          <p className="text-s font-medium fg-primary">Payment method</p>
          <p className={cardLabelClass}>{cardLabel}</p>
        </div>
        <Divider />
      </div>
    );
  }

  return (
    <div>
      <div className="pb-4" data-testid="billing-payment-method">
        <div className="flex items-start justify-between gap-3">
          <Stack gap="tight" className="min-w-0">
            <p className="text-s font-medium fg-primary">Payment method</p>
            {cardLabel ? (
              <p className={cardLabelClass}>{cardLabel}</p>
            ) : (
              <p className="text-s fg-secondary">
                No card on file. Add one to fund AI credit top-ups.
              </p>
            )}
          </Stack>
          <PaymentAreaCta
            action="payment-method"
            hasCard={paymentMethod !== null}
            testId="billing-manage-payment-method"
            inline={
              slots !== null ? (
                <slots.PersonalPaymentMethodActions
                  paymentMethod={paymentMethod}
                  onCardMutated={onCardMutated}
                  openRequestId={openCardRequestId}
                />
              ) : null
            }
          />
        </div>
      </div>
      <Divider />
    </div>
  );
}

/** Compact ledger table for the AI-credits card; empty-state when no activity. */
function CreditsLedgerTable({
  entries,
}: {
  entries: AiCreditsLedgerEntry[];
}): JSX.Element {
  return (
    <div className="mt-4" data-testid="billing-ai-credits-ledger">
      <p className="text-s font-medium fg-primary">Credit activity</p>
      {entries.length === 0 ? (
        <EmptyStateRow title="No credit activity yet." />
      ) : (
        <div className="mt-2">
          <SharedCreditLedgerTable entries={entries} formatDate={formatDate} />
        </div>
      )}
    </div>
  );
}
