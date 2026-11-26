'use client';

import { useCallback, useEffect, useState, type JSX } from 'react';
import type { AiCreditsLedgerEntry } from '@canopy/protocol';
import type { SettingsPaymentOwner } from '@canopy/protocol/billing';
import {
  formatCardLabel,
  formatDate,
  formatExpiry,
} from '@canopy/ui-shared/lib';
import {
  AI_CREDITS_LABEL,
  Stack,
  BillingHistoryTable as SharedBillingHistoryTable,
  BusyLabel,
  Button,
  CreditLedgerTable as SharedCreditLedgerTable,
  EmptyStateRow,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { SettingsCard } from '@canopy/ui-shared/components/settings/SettingsCard';
import { BillingCardBodySkeleton } from './billing-card-body-skeleton';
import { InvoicesSection, INVOICES_PAGE_LIMIT } from './invoices-section';
import { WalletAutoTopUp } from './auto-top-up-summary';
import {
  BalanceSurface,
  type BalanceSurfaceOwner,
} from '../../credits/BalanceSurface';
import {
  useBillingSettingsSlots,
  type BillingSettingsIntentTarget,
} from './billing-settings-slots';
import { SettingsCreditPoolSubscription } from './settings-credit-pool-subscription';
import {
  PaymentArea,
  PaymentAreaCta,
  PaymentAreaNotice,
  paymentCaptureAvailable,
  usePaymentAreaMode,
} from './PaymentArea';
import {
  useSettingsBrand,
  useSettingsClient,
  useSettingsPrivacy,
  useSettingsWorkspaceContext,
} from '../host';
import { withPrivacyClass } from '../account/privacy-class';
import { SETTINGS_LOAD_ERROR_COPY, useSettingsErrorCopy } from '../errors';
import { getCreditsBalance, getCreditsLedger } from '../organization/team-api';
import type {
  BillingSummary,
  BillingSummaryPaymentMethod,
  ChargeHistoryItem,
  CreditsSummary,
  InvoicePage,
} from '@canopy/protocol/settings/billing';
import type { SettingsFailure } from '../errors';
import { Divider } from '@canopy/ui-shared/components';

const HISTORY_LOAD_MORE_ERROR = "Couldn't load more history.";

/** The personal wallet: account billing never pays for an organization. */
const PERSONAL_OWNER: SettingsPaymentOwner = { kind: 'personal' };
const PERSONAL_BALANCE_OWNER: BalanceSurfaceOwner = { kind: 'personal' };

/** Shareable personal invoice detail URL. */
function accountInvoiceHref(invoice: { id: string }): string {
  return `/account/billing/invoices/${encodeURIComponent(invoice.id)}`;
}

type Status = 'loading' | 'ready' | 'error';

/* -------------------------------------------------------------------------- */
/* BillingSection container                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Account-page billing panel. Self-fetches the user's {@link BillingSummary}
 * (for the saved card) plus the first page of charge history, then renders the
 * personal AI credits wallet and, when it carries anything, the billing-history
 * card with the payment method, invoices and USD transactions. There are no
 * subscription plans, so no plan card renders and org membership does not
 * change this page: every user has a personal wallet.
 */
export function BillingSection(): JSX.Element {
  const client = useSettingsClient();
  const slots = useBillingSettingsSlots();
  const paymentMode = usePaymentAreaMode();
  // Card capture is possible inline (Stripe configured) or through the web
  // handoff; this replaces the old "Stripe key present" predicate.
  const paymentsAvailable = paymentCaptureAvailable(paymentMode);
  const viewerId = useSettingsWorkspaceContext().accountKey;
  // The one-shot top-up or payment modal intent this page was opened with,
  // read by the host's intent controller once the data it gates on is ready.
  const [intentTarget, setIntentTarget] =
    useState<BillingSettingsIntentTarget | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  // The first summary read finished (either way): the intent can be decided.
  const [summarySettled, setSummarySettled] = useState(false);
  const [charges, setCharges] = useState<ChargeHistoryItem[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [creditsReloadSignal, setCreditsReloadSignal] = useState(0);

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

  useEffect(() => {
    // Defer the initial load out of the synchronous effect body so the fetch's
    // setState does not trigger a cascading render (mirrors SecurityPanel).
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, 0);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [refresh]);

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

  // A payment-method intent opens the card modal. A retired subscription
  // intent (sent by shipped builds) opens nothing.
  const openCardRequestId =
    intentTarget?.kind === 'payment-method' ? intentTarget.requestId : null;

  const hasSavedCard = summary?.paymentMethod != null;
  // The grouped billing-history card is hidden unless it carries real value —
  // a saved card on file or at least one USD charge. A configured Stripe key
  // alone does not show an empty "Add card" shell; the first card is captured
  // by the credit top-up flow. When the card IS shown, the payment subcard
  // still renders so a card can be added or managed alongside existing history.
  // A card intent shows the card even when it is otherwise empty, so the modal
  // opens from its own subcard.
  const showBillingCard =
    hasSavedCard ||
    charges.length > 0 ||
    (openCardRequestId !== null && paymentsAvailable);
  const showPaymentSubcard = paymentsAvailable || hasSavedCard;
  // A plain stack, not a card: `gap-6` matches the gutter the account layout
  // gives sibling cards elsewhere, and matches the org Billing subtab exactly.
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
          on top of the wrapper's `gap-6` and leave a lopsided gutter. */}
        <ErrorBanner
          errorSource="billing-section"
          className=""
          error={
            status !== 'error'
              ? null
              : (error?.copy ?? SETTINGS_LOAD_ERROR_COPY)
          }
          details={error?.details}
          onRetry={retryLoad}
        />

        {/* Personal AI-credits wallet. Self-loads its own credits balance. */}
        <AiCreditsCard
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

/** The wallet's subtitle: credits are the only way to pay for AI models. */
const CREDITS_SUBTITLE = 'Use them for AI models. Buy more anytime.';

/**
 * The account "AI credits wallet" card. Self-loads the personal
 * {@link CreditsSummary} plus the first ledger page, then renders the balance
 * (in credits — the ledger's own unit, not a USD figure that would read as a
 * refundable cash balance), the plain-text month-to-date consumption line, the
 * shared "Buy AI Credits" button with the no-saved-card fallback, the shared
 * {@link AutoTopUpControls}, and the credit ledger. Personal credits are
 * usage-based, so this renders even for org-covered users.
 *
 * The saved card that funds these top-ups no longer lives here — it moved to the
 * grouped payment + billing card below the wallet (its honest home now that it
 * sits alongside the real USD charges). The host's inline billing UI (or the
 * web handoff) owns the shared "Buy AI Credits" flow's card capture.
 */
function AiCreditsCard({
  intentTarget,
  reloadSignal,
}: {
  /** The page's top-up or automatic top-up intent, once read. */
  intentTarget: BillingSettingsIntentTarget | null;
  /** Bumped by "Check again" and browser return: reload silently. */
  reloadSignal: number;
}): JSX.Element | null {
  const client = useSettingsClient();
  const slots = useBillingSettingsSlots();
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
  // immediate refetch after "Buy AI Credits" usually races (and loses to) the
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
        title={AI_CREDITS_LABEL}
        subtitle={CREDITS_SUBTITLE}
        testId="billing-ai-credits"
      >
        {children}
      </SettingsCard>
    </>
  );

  if (status === 'loading') {
    return shell(<BillingCardBodySkeleton />);
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

  return shell(
    <BalanceSurface
      density="card"
      summary={summary}
      owner={PERSONAL_BALANCE_OWNER}
      testIdPrefix=""
      purchase={
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
                {({ trigger }) => trigger}
              </slots.CreditsTopUp>
            ) : null
          }
        />
      }
      autoTopUp={
        <WalletAutoTopUp
          owner={PERSONAL_OWNER}
          summary={summary}
          canManage
          onSaved={reloadAfterAutoTopUp}
          brandName={brandName}
          openAdjustRequestId={
            intentTarget?.kind === 'auto-top-up' ? intentTarget.requestId : null
          }
        />
      }
    >
      <CreditsLedgerTable entries={entries} />
    </BalanceSurface>,
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
                No card on file. Add one to fund AI Credits top-ups.
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
    <div className="pt-4" data-testid="billing-ai-credits-ledger">
      <p className="text-s font-medium fg-primary">Activity</p>
      {entries.length === 0 ? (
        <EmptyStateRow title="No activity yet." />
      ) : (
        <div className="pt-2">
          <SharedCreditLedgerTable entries={entries} formatDate={formatDate} />
        </div>
      )}
    </div>
  );
}
