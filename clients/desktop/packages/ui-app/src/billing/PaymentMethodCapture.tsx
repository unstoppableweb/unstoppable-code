'use client';

import { useEffect, useMemo, useState, type FormEvent, type JSX } from 'react';
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import type { StripePaymentElementChangeEvent } from '@stripe/stripe-js';
import { Button, DialogModal, ErrorBanner } from '@canopy/ui-shared/components';
import type { BillingPaymentMethodSummary as PaymentMethodSummary } from '@canopy/protocol/billing';
import { BILLING_CARD_DECLINED_ERROR } from '@canopy/app-state/billing';
import { getBrowserStripe } from './stripe-browser';
import { buildStripeAppearance } from './stripe-appearance';

const SETUP_ERROR = 'Unable to start card setup.';
const SAVE_ERROR = 'Unable to save card.';
const INCOMPLETE_ERROR = 'Card setup did not complete. Please try again.';

/** The HTTP status a failed confirm call carries, when it has one. */
function failureStatus(failure: unknown): number | null {
  if (
    typeof failure !== 'object' ||
    failure === null ||
    !('status' in failure)
  ) {
    return null;
  }
  return typeof failure.status === 'number' ? failure.status : null;
}

type Status = 'loading' | 'ready' | 'error';

export interface PaymentMethodModalProps {
  /** Stripe publishable key — callers only mount this when Stripe is configured. */
  publishableKey: string;
  /** Mint a SetupIntent for the account/org; returns its client secret. */
  createSetupIntent: () => Promise<{ clientSecret: string }>;
  /**
   * Confirm the succeeded SetupIntent server-side and return the saved card.
   * Each surface binds its own account- vs org-scoped endpoint here.
   */
  confirmPaymentMethod: (
    setupIntentId: string,
  ) => Promise<PaymentMethodSummary>;
  onClose: () => void;
  onSaved: (summary: PaymentMethodSummary) => void;
  /** Modal heading. Defaults to "Add payment method". */
  title?: string;
  /**
   * Submit button label. Defaults to "Save card" (a pure card save). Immediate-
   * charge subscribe flows pass e.g. "Pay $29.00" so the user sees they are
   * being charged now, not just saving a card.
   */
  submitLabel?: string;
  /** Submit label while the confirm is in flight. Defaults to "Saving…". */
  submittingLabel?: string;
  /** Test id for the modal shell; distinguishes the account vs org instance. */
  dataTestId?: string;
}

/**
 * The single Stripe card-capture modal shared by the account billing section
 * (CAN-1035) and the org Billing tab (CAN-1036). It owns the SetupIntent mint,
 * the themed `<Elements>` + `<PaymentElement>`, and the confirm flow; the two
 * surfaces differ only in which endpoints they hit, injected via
 * {@link PaymentMethodModalProps.createSetupIntent} and
 * {@link PaymentMethodModalProps.confirmPaymentMethod}. Keeping one component
 * means the two "add a card" experiences cannot drift apart.
 */
export function PaymentMethodModal({
  onClose,
  title = 'Add payment method',
  dataTestId = 'billing-payment-method-modal',
  ...capture
}: PaymentMethodModalProps): JSX.Element {
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={title}
      dataTestId={dataTestId}
      maxWidth="md"
    >
      <PaymentMethodCapture {...capture} onCancel={onClose} />
    </DialogModal>
  );
}

export interface PaymentMethodCaptureProps extends Pick<
  PaymentMethodModalProps,
  | 'publishableKey'
  | 'createSetupIntent'
  | 'confirmPaymentMethod'
  | 'onSaved'
  | 'submitLabel'
  | 'submittingLabel'
> {
  onCancel: () => void;
}

/**
 * The card form on its own, without a dialog around it: the SetupIntent mint,
 * the themed `<Elements>` + `<PaymentElement>`, and the confirm. The modal
 * above is this in a dialog; the top-up checkout renders it in place of its
 * amount step, so a missing card is fixed on the screen that found it.
 */
export function PaymentMethodCapture({
  publishableKey,
  createSetupIntent,
  confirmPaymentMethod,
  onCancel,
  onSaved,
  submitLabel = 'Save card',
  submittingLabel = 'Saving…',
}: PaymentMethodCaptureProps): JSX.Element {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const stripePromise = useMemo(
    () => getBrowserStripe(publishableKey),
    [publishableKey],
  );
  // Theme the embedded PaymentElement to the current app theme. Computed once
  // when the form opens (it is short-lived, so a live theme switch mid-add is
  // not worth re-subscribing to).
  const appearance = useMemo(() => buildStripeAppearance(), []);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const { clientSecret: secret } = await createSetupIntent();
        if (!cancelled) {
          setClientSecret(secret);
          setStatus('ready');
        }
      } catch {
        if (!cancelled) {
          setStatus('error');
          setError(SETUP_ERROR);
        }
      }
    };
    void run();
    return (): void => {
      cancelled = true;
    };
    // createSetupIntent is a stable closure supplied by the caller; re-minting on
    // an identity change would double-charge the SetupIntent flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {status === 'loading' && (
        <p className="px-6 pb-6 pt-4 text-s fg-secondary">
          Loading payment form…
        </p>
      )}
      {status === 'error' && (
        <div className="px-6 pb-6 pt-4">
          <ErrorBanner
            errorSource="payment-method-capture"
            error={error}
            className=""
          />
        </div>
      )}
      {status === 'ready' && clientSecret && (
        <Elements stripe={stripePromise} options={{ clientSecret, appearance }}>
          <PaymentForm
            confirmPaymentMethod={confirmPaymentMethod}
            onSaved={onSaved}
            onCancel={onCancel}
            submitLabel={submitLabel}
            submittingLabel={submittingLabel}
          />
        </Elements>
      )}
    </>
  );
}

interface PaymentFormProps {
  confirmPaymentMethod: (
    setupIntentId: string,
  ) => Promise<PaymentMethodSummary>;
  onSaved: (summary: PaymentMethodSummary) => void;
  onCancel: () => void;
  submitLabel: string;
  submittingLabel: string;
}

function PaymentForm({
  confirmPaymentMethod,
  onSaved,
  onCancel,
  submitLabel,
  submittingLabel,
}: PaymentFormProps): JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await stripe.confirmSetup({
        elements,
        redirect: 'if_required',
      });
      if (result.error) {
        setError(result.error.message ?? SAVE_ERROR);
        setSubmitting(false);
        return;
      }
      const setupIntent = result.setupIntent;
      if (!setupIntent || setupIntent.status !== 'succeeded') {
        setError(INCOMPLETE_ERROR);
        setSubmitting(false);
        return;
      }
      const summary = await confirmPaymentMethod(setupIntent.id);
      onSaved(summary);
    } catch (err) {
      // An immediate charge the issuer refused (402) gets the decline copy;
      // anything else the fixed fallback. The server's own text is never
      // shown.
      setError(
        failureStatus(err) === 402 ? BILLING_CARD_DECLINED_ERROR : SAVE_ERROR,
      );
      setSubmitting(false);
    }
  };

  // A banner left by an earlier failed submit describes a form state that no
  // longer exists once Stripe reports the element complete, e.g. a Link card
  // picked and SMS-verified after Pay was pressed too early (CAN-3714). Drop it
  // then; keep it while the form is incomplete so an unfinished card or a
  // failed Link verification still reads as blocked.
  const handleElementChange = (
    event: StripePaymentElementChangeEvent,
  ): void => {
    if (event.complete) {
      setError(null);
    }
  };

  // The Stripe card form (with Link + save-info) can exceed the modal's 80vh
  // cap, so the field region scrolls while the action row stays pinned as a
  // footer. `min-h-0` on the form + scroll region lets them shrink below content
  // height inside DialogModal's `overflow-hidden` flex column so the inner
  // region — not the whole modal — is what scrolls.
  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6 pt-4">
        <PaymentElement onChange={handleElementChange} />
        <ErrorBanner errorSource="payment-form" error={error} className="" />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t px-6 py-4">
        <Button
          type="submit"
          variant="primary"
          size="compact"
          disabled={!stripe || !elements || submitting}
          data-testid="billing-payment-method-submit"
        >
          {submitting ? submittingLabel : submitLabel}
        </Button>
        <Button
          type="button"
          size="compact"
          onClick={onCancel}
          disabled={submitting}
          data-testid="billing-payment-method-cancel"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
