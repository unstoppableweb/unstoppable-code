'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import {
  buildDesktopBillingDeepLink,
  type BillingTopUpIntent,
} from '@canopy/protocol/billing';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import {
  Button,
  buttonClassName,
  DialogFormField,
  DialogModal,
  ErrorBanner,
  MODEL_LIBRARY_UNLOCK_COPY,
  SegmentedControl,
  TextInput,
  ValueRow,
  ValueRows,
} from '@canopy/ui-shared/components';
import { formatCredits } from '@canopy/ui-shared/lib';
import type { BillingClient } from '@canopy/app-core';
import { PaymentMethodCapture } from './PaymentMethodCapture';
import {
  TOP_UP_ERROR,
  TopUpCheckout,
  type TopUpAuthentication,
  type TopUpCheckoutDeps,
  type TopUpCheckoutState,
} from '@canopy/app-state/billing';

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

import {
  BILLING_TOP_UP_MAX_USD as AI_CREDIT_TOP_UP_MAX_USD,
  BILLING_TOP_UP_MIN_USD as AI_CREDIT_TOP_UP_MIN_USD,
  computeTopUpChargeBreakdown,
} from '@canopy/protocol/billing';
import { getBrowserStripe } from './stripe-browser';
import type { BillingPaymentMethodSummary as PaymentMethodSummary } from '@canopy/protocol/billing';

export interface TopUpSheetProps {
  readonly billing: BillingClient;
  readonly contextKey: string;
  readonly feePercent: number;
  readonly appName: string;
  readonly deepLinkScheme: string;
  /** Omit for the personal wallet; present for an org credit pool. */
  orgId?: string;
  /** Stripe publishable key, or `null` when Stripe is unconfigured. */
  publishableKey: string | null;
  /** Mint a SetupIntent for the correct (account vs org) surface. */
  createSetupIntent: () => Promise<{ clientSecret: string }>;
  /** Confirm the saved card for the correct (account vs org) surface. */
  confirmPaymentMethod: (
    setupIntentId: string,
  ) => Promise<PaymentMethodSummary>;
  /**
   * The owner's effective per-credit SALE price (USD), used to preview
   * "you'll receive ~N credits". Omit when unknown; the dialog falls back to
   * the free list price.
   */
  creditPriceUsd?: number;
  /** Prefix for test ids — `''` (account) or `'team-'` (org). */
  testIdPrefix?: string;
  /**
   * Why the dialog opened. It may preselect an amount and change the copy; it
   * never submits a payment, which only the pay button does.
   */
  intent?: BillingTopUpIntent;
  /** The owner's model-library access, refetched. Unlock checkouts only. */
  fetchAccess?: () => Promise<ModelLibraryAccess | undefined>;
  /** Bumped when something suggests the owner's state moved; a hint only. */
  refreshSignal?: number;
  /** The server confirmed the payment: refresh the balance and ledger. */
  onPaid: () => void;
  /** The refetched access answered `unlocked`. */
  onUnlocked?: () => void;
  /** Payment, credits, and any requested library access are confirmed. */
  onComplete?: () => void;
  onClose: () => void;
}

const AMOUNT_CHIPS_USD: readonly number[] = [5, 20, 50, 100];
const CUSTOM_AMOUNT = 'custom';

/**
 * The amount segment that reads as chosen: a preset when the field holds a
 * valid preset, Custom when it holds anything else, and none for a preset
 * outside the allowed range.
 */
function amountChoice(parsed: number, valid: boolean): string | null {
  if (!AMOUNT_CHIPS_USD.some((amount) => amount === parsed))
    return CUSTOM_AMOUNT;
  return valid ? String(parsed) : null;
}

const AUTHENTICATION_ERROR =
  'Your bank did not confirm the payment. Check its status before trying again.';
const PROCESSING_COPY = 'Your payment is processing. This can take a minute.';
const CONFIRMING_COPY = 'Payment received. Confirming access…';
const ACCESS_DELAYED_COPY =
  "Payment received. Access is taking longer than usual to update. You won't be charged again.";
const PAID_COPY = 'Payment received.';

// Shown in each breakdown value cell before the entered amount is valid. The
// breakdown box renders unconditionally (with these placeholders) so the
// dialog's height stays fixed as the amount crosses the valid/invalid
// threshold — an appearing/disappearing box made the dialog jump while typing.
const BREAKDOWN_PLACEHOLDER = '—';

/** Free / no-plan list price, the fallback when no effective price is known. */
const FREE_LIST_CREDIT_PRICE_USD = 0.6;

/** The desktop return link keeps an `<a href>` and wears the primary Button. */
const PRIMARY_LINK_CLASS = buttonClassName({
  variant: 'primary',
  size: 'compact',
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * One dialog's state and callbacks. Reopening the same account/owner restores
 * its unresolved payment identity; closing fences the abandoned callbacks.
 */
function useTopUpCheckout({
  billing,
  contextKey,
  publishableKey,
  intent,
  fetchAccess,
  onPaid,
  onUnlocked,
}: Pick<
  TopUpSheetProps,
  | 'billing'
  | 'contextKey'
  | 'orgId'
  | 'publishableKey'
  | 'intent'
  | 'fetchAccess'
  | 'onPaid'
  | 'onUnlocked'
>): { checkout: TopUpCheckout; state: TopUpCheckoutState } {
  const reason = intent?.reason ?? 'credits';
  const source = intent?.source;
  const deps = useMemo(
    (): TopUpCheckoutDeps => ({
      contextKey,
      reason,
      ...(source === undefined ? {} : { source }),
      topUp: (input) => billing.topUp(input),
      authenticate: async (clientSecret): Promise<TopUpAuthentication> => {
        const stripe =
          publishableKey === null
            ? null
            : await getBrowserStripe(publishableKey);
        if (!stripe) return { ok: false, message: TOP_UP_ERROR };
        const result = await stripe.confirmCardPayment(clientSecret);
        return result.error
          ? {
              ok: false,
              message: result.error.message ?? AUTHENTICATION_ERROR,
            }
          : { ok: true };
      },
      ...(reason === 'unlock_models' && fetchAccess ? { fetchAccess } : {}),
      newRequestId: () => crypto.randomUUID(),
      attemptStorage: {
        getItem: (key) => window.sessionStorage.getItem(key),
        setItem: (key, value) => window.sessionStorage.setItem(key, value),
        removeItem: (key) => window.sessionStorage.removeItem(key),
      },
      wait,
      onPaid,
      ...(onUnlocked ? { onUnlocked } : {}),
    }),
    [
      billing,
      contextKey,
      fetchAccess,
      onPaid,
      onUnlocked,
      publishableKey,
      reason,
      source,
    ],
  );
  // One checkout for this dialog's life, with an owner-bound attempt journal.
  const [checkout] = useState(() => new TopUpCheckout(deps));
  useEffect(() => {
    checkout.setDeps(deps);
  }, [checkout, deps]);
  useEffect(() => (): void => checkout.close(), [checkout]);
  const state = useSyncExternalStore(
    checkout.subscribe,
    checkout.getState,
    checkout.getState,
  );
  return { checkout, state };
}

/**
 * The AI credits checkout: the amount, the card when one is missing, and what
 * happened to the payment. Shared by the billing pages' "Buy credits" button
 * and by the chat composer's model unlock, which differ only in the intent
 * they open it with.
 */
export function TopUpSheet({
  billing,
  contextKey,
  feePercent,
  appName,
  deepLinkScheme,
  orgId,
  publishableKey,
  createSetupIntent,
  confirmPaymentMethod,
  creditPriceUsd = FREE_LIST_CREDIT_PRICE_USD,
  testIdPrefix = '',
  intent,
  fetchAccess,
  refreshSignal,
  onPaid,
  onUnlocked,
  onComplete,
  onClose,
}: TopUpSheetProps): JSX.Element {
  const unlock = intent?.reason === 'unlock_models';
  // A model id alone on a billing link has no consumer to apply it. Chat
  // recovery supplies the callback; desktop supplies a correlated return.
  const canSelectModel =
    intent?.modelId !== undefined &&
    (onUnlocked !== undefined ||
      (intent.source === 'desktop' && intent.requestId !== undefined));

  const { checkout, state } = useTopUpCheckout({
    billing,
    contextKey,
    orgId,
    publishableKey,
    intent,
    fetchAccess,
    onPaid,
    onUnlocked,
  });
  const [value, setValue] = useState(String(intent?.amountUsd ?? 20));
  const customRef = useRef<HTMLInputElement | null>(null);
  const amountId = useId();
  const tid = (suffix: string): string => `${testIdPrefix}${suffix}`;

  useEffect(() => {
    if (refreshSignal !== undefined) checkout.refresh();
  }, [checkout, refreshSignal]);

  // Completion includes the webhook's credit grant, separately from settlement.
  const settledPlainPurchase = !unlock && state.status === 'complete';
  useEffect(() => {
    if (settledPlainPurchase) onClose();
  }, [onClose, settledPlainPurchase]);
  useEffect(() => {
    if (state.status === 'complete') onComplete?.();
  }, [onComplete, state.status]);

  const parsed = Number.parseFloat(value);
  const valid =
    Number.isFinite(parsed) &&
    parsed >= AI_CREDIT_TOP_UP_MIN_USD &&
    parsed <= AI_CREDIT_TOP_UP_MAX_USD;

  // Deterministic integer-cents breakdown, identical to the server's Stripe
  // math (`computeTopUpChargeBreakdown`), so the displayed total matches the
  // amount actually charged. Null until the entered base amount is valid.
  const breakdown = valid
    ? computeTopUpChargeBreakdown(Math.round(parsed * 100), feePercent)
    : null;

  // Estimated credits granted. The grant lands on the pre-fee BASE amount at
  // the owner's sale price, so preview off `breakdown.baseCents`, not the
  // fee-inclusive total. Approximate ("~") because the authoritative grant
  // happens on the Stripe webhook.
  const estimatedCredits =
    breakdown && creditPriceUsd > 0
      ? breakdown.baseCents / 100 / creditPriceUsd
      : null;

  const working =
    state.status === 'submitting' || state.status === 'authenticating';
  const total = breakdown ? formatUsd(breakdown.totalCents / 100) : null;
  const payLabel =
    total === null
      ? 'Buy credits'
      : unlock
        ? `Pay ${total} and unlock`
        : `Pay ${total}`;

  const close = useCallback((): void => {
    if (!working) {
      checkout.close();
      onClose();
    }
  }, [checkout, onClose, working]);

  const desktopReturnHref = useMemo((): string | null => {
    if (
      !state.unlocked ||
      intent?.source !== 'desktop' ||
      intent.requestId === undefined
    ) {
      return null;
    }
    try {
      return buildDesktopBillingDeepLink(
        {
          requestId: intent.requestId,
          ...(intent.modelId === undefined ? {} : { modelId: intent.modelId }),
          ...(intent.chatId === undefined ? {} : { chatId: intent.chatId }),
        },
        deepLinkScheme,
      );
    } catch {
      return null;
    }
  }, [deepLinkScheme, intent, state.unlocked]);

  const outcome =
    state.status === 'processing'
      ? PROCESSING_COPY
      : state.status === 'confirming_credits' ||
          state.status === 'credits_delayed'
        ? 'Payment received. Your AI credits are still processing. You won’t be charged again.'
        : state.status === 'confirming_access'
          ? CONFIRMING_COPY
          : state.status === 'access_delayed'
            ? ACCESS_DELAYED_COPY
            : state.status === 'complete'
              ? state.unlocked
                ? MODEL_LIBRARY_UNLOCK_COPY.confirmed
                : PAID_COPY
              : null;

  return (
    <DialogModal
      inset="flush"
      title={unlock ? MODEL_LIBRARY_UNLOCK_COPY.title : 'Buy AI credits'}
      subtitle={
        unlock
          ? canSelectModel
            ? MODEL_LIBRARY_UNLOCK_COPY.purchaseBody
            : MODEL_LIBRARY_UNLOCK_COPY.purchaseBodyWithoutSelection
          : `Enter an amount between $${AI_CREDIT_TOP_UP_MIN_USD} and $${AI_CREDIT_TOP_UP_MAX_USD}.`
      }
      maxWidth={state.status === 'needs_card' ? 'md' : 'sm'}
      dataTestId={tid('credits-top-up-modal')}
      onClose={close}
    >
      {state.status === 'needs_card' && publishableKey ? (
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-testid={tid('credits-top-up-card')}
        >
          <PaymentMethodCapture
            publishableKey={publishableKey}
            createSetupIntent={createSetupIntent}
            confirmPaymentMethod={confirmPaymentMethod}
            submitLabel={
              total === null ? undefined : `Save card and pay ${total}`
            }
            onCancel={() => checkout.cancelCard()}
            onSaved={() => checkout.cardSaved()}
          />
        </div>
      ) : outcome !== null ? (
        <div className="flex flex-col gap-4 p-6">
          <p
            className="text-s fg-primary"
            role="status"
            data-testid={tid('credits-top-up-outcome')}
          >
            {outcome}
          </p>
          <ErrorBanner
            errorSource="credits-top-up-load"
            className=""
            error={state.error}
          />
          <div className="flex items-center justify-end gap-2">
            {state.status === 'processing' ||
            state.status === 'credits_delayed' ||
            state.status === 'access_delayed' ? (
              <Button
                type="button"
                size="compact"
                onClick={() => checkout.refresh()}
                data-testid={tid('credits-top-up-recheck')}
              >
                Check again
              </Button>
            ) : null}
            {desktopReturnHref !== null ? (
              <a
                href={desktopReturnHref}
                data-testid={tid('credits-top-up-desktop-return')}
                className={PRIMARY_LINK_CLASS}
              >
                {`Back to ${appName}`}
              </a>
            ) : null}
            <Button
              type="button"
              size="compact"
              onClick={close}
              data-testid={tid('credits-top-up-done')}
            >
              {state.status === 'complete' ? 'Done' : 'Close'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-6">
          <SegmentedControl
            label="Amount"
            shape="capsule"
            width="content"
            disabled={working}
            value={amountChoice(parsed, valid)}
            options={[
              ...AMOUNT_CHIPS_USD.map((amount) => ({
                value: String(amount),
                label: `$${amount}`,
                dataTestId: tid(`credits-top-up-amount-${amount}`),
              })),
              {
                value: CUSTOM_AMOUNT,
                label: 'Custom',
                dataTestId: tid('credits-top-up-amount-custom'),
              },
            ]}
            onChange={(next) => {
              if (next === CUSTOM_AMOUNT) {
                customRef.current?.focus();
                customRef.current?.select();
                return;
              }
              setValue(next);
            }}
          />
          <DialogFormField label="Amount (USD)" htmlFor={amountId}>
            <TextInput
              ref={customRef}
              id={amountId}
              density="settings"
              leading="$"
              type="number"
              min={AI_CREDIT_TOP_UP_MIN_USD}
              max={AI_CREDIT_TOP_UP_MAX_USD}
              step="0.01"
              inputMode="decimal"
              value={value}
              disabled={working}
              onChange={(e) => setValue(e.target.value)}
            />
          </DialogFormField>
          <ErrorBanner
            errorSource="credits-top-up-submit"
            className=""
            error={
              state.error ||
              (state.status === 'needs_card' ? TOP_UP_ERROR : null)
            }
          />
          <ValueRows dataTestId={tid('credits-top-up-breakdown')}>
            <ValueRow
              label="Credits"
              value={
                breakdown
                  ? formatUsd(breakdown.baseCents / 100)
                  : BREAKDOWN_PLACEHOLDER
              }
            />
            <ValueRow
              label={`Service fee (${feePercent}%)`}
              value={
                breakdown
                  ? formatUsd(breakdown.feeCents / 100)
                  : BREAKDOWN_PLACEHOLDER
              }
            />
            <ValueRow
              label="Total charged"
              value={total ?? BREAKDOWN_PLACEHOLDER}
              valueTestId={tid('credits-top-up-total')}
            />
            <ValueRow
              label="You'll receive"
              value={
                estimatedCredits !== null
                  ? `~${formatCredits(estimatedCredits)} credits`
                  : BREAKDOWN_PLACEHOLDER
              }
              valueTestId={tid('credits-top-up-estimate')}
            />
          </ValueRows>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              size="compact"
              disabled={working}
              onClick={close}
            >
              {unlock ? MODEL_LIBRARY_UNLOCK_COPY.dismissAction : 'Cancel'}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="compact"
              disabled={working || !valid || state.paid}
              onClick={() => checkout.submit(parsed)}
              data-testid={tid('credits-top-up-confirm')}
            >
              {state.status === 'authenticating'
                ? 'Confirming with your bank…'
                : working
                  ? 'Processing…'
                  : payLabel}
            </Button>
          </div>
        </div>
      )}
    </DialogModal>
  );
}
