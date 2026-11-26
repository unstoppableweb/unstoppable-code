'use client';

import type { JSX, ReactNode, RefObject } from 'react';
import {
  resolveCreditsPrompt,
  type CreditsPromptOwner,
  type CreditsPurchaseMode,
} from '@canopy/app-state/billing/credits';
import {
  creditsPromptCopy,
  DialogModal,
  ErrorBanner,
  GuestModelGateContent,
  guestModelGateCopy,
  LoadingSpinner,
  MODEL_LIBRARY_UNLOCK_COPY,
  modelLibraryUnlockTitle,
  modelLibraryWaitingInBrowserBody,
  type GuestModelGateSubject,
  Button,
} from '@canopy/ui-shared/components';

/**
 * The model unlock dialog (Card B). Every host that tells someone a model is
 * locked renders it: desktop's model recovery modal and the web's guest
 * sign-in gate and cloud model-library recovery.
 *
 * The host says who is looking (`guest`), whose wallet pays (`owner`), how it
 * takes a purchase (`purchase.mode`) and how far the purchase has got
 * (`progress`). The dialog asks {@link resolveCreditsPrompt} (condition
 * `model_locked`) whether this is a sign-in, an admin's purchase or the
 * viewer's own, and renders that step. Nothing here branches on which host
 * renders it; the host keeps its own purchase and sign-in transport.
 *
 * Each step offers only its ways forward. The close button and a click
 * outside the dialog dismiss it, so no step adds a Cancel or Not now.
 */

/** Opening failed. Shared by the first purchase and Start a new purchase. */
const OPEN_FAILED_COPY = 'We couldn’t open your browser. Try again.';

/**
 * How far the unlock purchase has got. Data only: each step's action is a
 * handler prop of the dialog.
 */
export type UnlockDialogProgress =
  /** Nothing started: offer the purchase. */
  | { readonly kind: 'offer' }
  /** Checkout opened, but the host cannot follow it: no check, no model. */
  | { readonly kind: 'opened' }
  /**
   * Checkout is open and the host is following it. `checking`: the host's
   * Check again ({@link UnlockDialogProps.onCheckNow}) is running.
   */
  | { readonly kind: 'waiting'; readonly checking: boolean }
  /**
   * The host stopped following it. The payment may still be in progress, so
   * nothing calls it failed; the way past it is an explicit new purchase.
   */
  | {
      readonly kind: 'timed-out';
      readonly checking: boolean;
      /** A new purchase is opening. */
      readonly opening: boolean;
      /** The last new purchase could not open. */
      readonly newPurchaseFailed: boolean;
    }
  /** Unlocked. `applying`: the host is selecting the model now. */
  | { readonly kind: 'confirmed'; readonly applying: boolean }
  /** Unlocked, but the model was not selected; offer the selection again. */
  | { readonly kind: 'apply-failed'; readonly busy: boolean };

/** The purchase the dialog offers, through the host's purchase action. */
export interface UnlockDialogPurchase {
  /** How this host takes a purchase (`useCreditsPurchase(owner).mode`). */
  readonly mode: CreditsPurchaseMode;
  /** Starts the purchase. Without it the dialog offers none. */
  readonly onStart?: () => void;
  /** The purchase is opening. */
  readonly opening?: boolean;
  /** The last purchase could not open. */
  readonly openFailed?: boolean;
}

/** A guest's sign-in, the only way forward for a guest. */
export interface UnlockDialogGuest {
  /**
   * The gated model and what unlocks it. `access` says whether a purchase
   * follows sign-in; the dialog drops the purchase from the copy when no
   * purchase could follow.
   */
  readonly subject: GuestModelGateSubject;
  /**
   * The host's sign-in control (a link on the web, a button on desktop).
   */
  readonly renderSignIn: (label: string) => ReactNode;
  /** A guest model the host can select right now instead. */
  readonly fallback?: {
    readonly label: string;
    readonly onActivate: () => void;
  };
  /** The fallback is being selected: the dialog can't be dismissed. */
  readonly busy?: boolean;
  readonly error?: string | null;
  /** Focus starts on the sign-in. */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
}

/** Where focus returns when the dialog closes. Defaults to the opener. */
export interface UnlockDialogFocusRestore {
  readonly ref?: RefObject<HTMLElement | null>;
  readonly when?: () => boolean;
}

export interface UnlockDialogProps {
  /** Present when the viewer is a guest: the dialog is the sign-in gate. */
  readonly guest?: UnlockDialogGuest;
  /** Whose wallet unlocks the model. */
  readonly owner: CreditsPromptOwner;
  readonly purchase: UnlockDialogPurchase;
  readonly progress: UnlockDialogProgress;
  /** The billing rollout is on for this viewer. Defaults to `true`. */
  readonly billingEnabled?: boolean;
  /** The model the dialog names; the generic unlock copy without one. */
  readonly modelLabel?: string;
  /** Check again while the purchase is followed or timed out. */
  readonly onCheckNow?: () => void;
  /**
   * Start a new purchase after the host stopped following one. Offered only
   * while `purchase.mode` can take a purchase.
   */
  readonly onNewPurchase?: () => void;
  /** Select the model again after a confirmed unlock that didn't land. */
  readonly onRetrySelection?: () => void;
  readonly onDismiss: () => void;
  /** Hidden, not unmounted, while another surface owns the screen. */
  readonly hidden?: boolean;
  readonly ownerDocument?: Document;
  readonly restoreFocus?: UnlockDialogFocusRestore;
  /** The dialog's test id. */
  readonly dataTestId: string;
  /** Prefix for the test ids of the dialog's parts. */
  readonly testIdPrefix: string;
}

export interface UnlockDialogFrameProps {
  readonly title: string;
  readonly children: ReactNode;
  /** The dialog's actions, stacked full width. */
  readonly actions?: ReactNode;
  readonly onDismiss: () => void;
  readonly hidden?: boolean;
  readonly ownerDocument?: Document;
  readonly dataTestId: string;
}

/**
 * The dialog every unlock and model recovery step renders in: a title, the
 * message and the actions stacked full width. Exported for a host's own
 * model recovery steps (a provider sign-in, a new chat), so every step a
 * locked model can open shares one frame.
 */
export function UnlockDialogFrame({
  title,
  children,
  actions,
  onDismiss,
  hidden = false,
  ownerDocument,
  dataTestId,
}: UnlockDialogFrameProps): JSX.Element {
  return (
    <DialogModal
      onClose={onDismiss}
      title={title}
      maxWidth="sm"
      // `hidden` keeps the subtree mounted underneath another surface.
      overlayClassName={hidden ? 'hidden' : ''}
      dataTestId={dataTestId}
      ownerDocument={ownerDocument}
    >
      <div className="flex flex-col gap-4">
        <div className="text-s leading-relaxed fg-secondary">{children}</div>
        {actions ? (
          <div className="flex flex-col gap-2 pointer-coarse:gap-4">
            {actions}
          </div>
        ) : null}
      </div>
    </DialogModal>
  );
}

/** The model unlock dialog; see the module comment. */
export function UnlockDialog({
  guest,
  owner,
  purchase,
  progress,
  billingEnabled = true,
  modelLabel,
  onCheckNow,
  onNewPurchase,
  onRetrySelection,
  onDismiss,
  hidden = false,
  ownerDocument,
  restoreFocus,
  dataTestId,
  testIdPrefix,
}: UnlockDialogProps): JSX.Element {
  const prompt = resolveCreditsPrompt({
    billingEnabled,
    viewer: guest === undefined ? 'signed-in' : 'guest',
    owner,
    condition: 'model_locked',
    purchaseMode: purchase.mode,
    pending: progress.kind === 'waiting' || progress.kind === 'timed-out',
  });
  const copy = creditsPromptCopy(prompt.reason, prompt.audience);
  const id = (part: string): string => `${testIdPrefix}-${part}`;

  if (guest !== undefined) {
    const busy = guest.busy === true;
    // Signing in to buy what can't be bought here would be a dead end: the
    // gate then asks for the account alone.
    const subject: GuestModelGateSubject =
      'copy' in guest.subject ||
      guest.subject.access !== 'needs_sign_in_then_purchase' ||
      prompt.primary === 'sign-in'
        ? guest.subject
        : { ...guest.subject, access: 'needs_sign_in' };
    return (
      <DialogModal
        inset="flush"
        onClose={onDismiss}
        title={guestGateTitle(subject, guest.fallback?.label)}
        maxWidth="sm"
        overlayClassName={hidden ? 'hidden' : ''}
        dataTestId={dataTestId}
        ownerDocument={ownerDocument}
        trapFocus
        {...(guest.initialFocusRef === undefined
          ? {}
          : { initialFocusRef: guest.initialFocusRef })}
        {...(restoreFocus?.ref === undefined
          ? {}
          : { restoreFocusRef: restoreFocus.ref })}
        {...(restoreFocus?.when === undefined
          ? {}
          : { restoreFocusWhen: restoreFocus.when })}
        closeButtonDisabled={busy}
        closeOnBackdrop={!busy}
        closeOnEscape={!busy}
      >
        <GuestModelGateContent
          subject={subject}
          {...(guest.fallback === undefined
            ? {}
            : { fallback: guest.fallback })}
          dataTestId={testIdPrefix}
          bodyTestId={id('needs-account')}
          busy={busy}
          error={guest.error ?? null}
          renderSignIn={guest.renderSignIn}
        />
      </DialogModal>
    );
  }

  const frame = (
    body: ReactNode,
    actions?: ReactNode,
    title: string = modelLibraryUnlockTitle(modelLabel),
  ): JSX.Element => (
    <UnlockDialogFrame
      title={title}
      onDismiss={onDismiss}
      hidden={hidden}
      dataTestId={dataTestId}
      {...(ownerDocument === undefined ? {} : { ownerDocument })}
      {...(actions === undefined ? {} : { actions })}
    >
      {body}
    </UnlockDialogFrame>
  );
  const checkNowButton = (
    checking: boolean,
    primary: boolean,
  ): JSX.Element | null =>
    onCheckNow === undefined ? null : (
      <Button
        size="compact"
        variant={primary ? 'primary' : 'secondary'}
        className="w-full"
        data-testid={id('unlock-check-now')}
        loading={checking}
        spinnerTestId={id('unlock-check-now-spinner')}
        loadingLabel={MODEL_LIBRARY_UNLOCK_COPY.checkingAction}
        onClick={onCheckNow}
      >
        {MODEL_LIBRARY_UNLOCK_COPY.checkNowAction}
      </Button>
    );

  // A confirmed unlock outranks every purchase step: the purchase landed.
  switch (progress.kind) {
    case 'apply-failed':
      // Confirmed, but the model did not land. The unlock stands, so the
      // title says so rather than offering it again; only the selection is
      // offered again.
      return frame(
        <span role="status" data-testid={id('unlock-apply-failed')}>
          {modelLabel === undefined
            ? MODEL_LIBRARY_UNLOCK_COPY.selectionFailed
            : `We couldn’t switch to ${modelLabel} just now.`}
        </span>,
        <Button
          size="compact"
          variant="primary"
          className="w-full"
          data-testid={id('unlock-use-model')}
          loading={progress.busy}
          spinnerTestId={id('unlock-use-model-spinner')}
          onClick={onRetrySelection}
        >
          {modelLabel === undefined
            ? MODEL_LIBRARY_UNLOCK_COPY.retrySelection
            : `Use ${modelLabel}`}
        </Button>,
        MODEL_LIBRARY_UNLOCK_COPY.confirmed,
      );
    case 'confirmed':
      // The host is applying the model and will close the dialog, or there
      // was nothing left to apply and the dialog's close is all that's left.
      return frame(
        <span
          role="status"
          data-testid={id('unlock-confirmed')}
          className="flex items-center gap-2"
        >
          {progress.applying && (
            <LoadingSpinner
              dataTestId={id('unlock-confirmed-spinner')}
              decorative
            />
          )}
          {MODEL_LIBRARY_UNLOCK_COPY.confirmed}
        </span>,
      );
    default:
      break;
  }

  // The work belongs to an organization this viewer cannot fund. A personal
  // purchase would not unlock it, so none is offered.
  if (prompt.primary === 'contact-admin') {
    return frame(
      <span data-testid={id('unlock-contact-admin')}>{copy.message}</span>,
    );
  }

  switch (progress.kind) {
    case 'timed-out': {
      // Check again stays for the purchase already started; a new one is
      // offered only while this host can still take a purchase.
      const newPurchase = prompt.canPurchase && onNewPurchase !== undefined;
      return frame(
        <span
          data-testid={id('unlock-timed-out')}
          className="flex flex-col gap-2"
        >
          <span role="status" className="flex flex-col gap-1">
            <span className="fg-primary">
              {MODEL_LIBRARY_UNLOCK_COPY.timedOutTitle}
            </span>
            <span>{MODEL_LIBRARY_UNLOCK_COPY.timedOutBody}</span>
          </span>
          {newPurchase ? (
            <span data-testid={id('unlock-new-purchase-help')}>
              {MODEL_LIBRARY_UNLOCK_COPY.newPurchaseHelp}
            </span>
          ) : null}
          {progress.newPurchaseFailed ? (
            <ErrorBanner
              errorSource="model-recovery-unlock-failed"
              error={OPEN_FAILED_COPY}
              className=""
              testId={id('unlock-failed')}
            />
          ) : null}
        </span>,
        <>
          {checkNowButton(progress.checking, true)}
          {newPurchase ? (
            <Button
              size="compact"
              variant="secondary"
              className="w-full"
              data-testid={id('unlock-new-purchase')}
              loading={progress.opening}
              spinnerTestId={id('unlock-new-purchase-spinner')}
              onClick={onNewPurchase}
            >
              {MODEL_LIBRARY_UNLOCK_COPY.newPurchaseAction}
            </Button>
          ) : null}
        </>,
      );
    }
    case 'waiting':
      // Closing does not cancel: the purchase is in the browser, and the
      // host still applies the model where it started once it completes.
      return frame(
        <span role="status" data-testid={id('unlock-waiting')}>
          {modelLibraryWaitingInBrowserBody(modelLabel)}
        </span>,
        checkNowButton(progress.checking, false) ?? undefined,
      );
    case 'opened':
      // A purchase the host cannot read back promises no model and offers
      // no check that could never report success.
      return frame(
        <span role="status" data-testid={id('unlock-waiting')}>
          {modelLibraryWaitingInBrowserBody()}
        </span>,
      );
    default:
      break;
  }

  const onStart = purchase.onStart;
  return frame(
    <span data-testid={id('unlock')} className="flex flex-col gap-2">
      <span>{copy.message}</span>
      {purchase.openFailed === true ? (
        <ErrorBanner
          errorSource="model-recovery-unlock-failed"
          error={OPEN_FAILED_COPY}
          className=""
          testId={id('unlock-failed')}
        />
      ) : null}
    </span>,
    prompt.primary === 'buy' && onStart !== undefined ? (
      <Button
        size="compact"
        variant="primary"
        className="w-full"
        data-testid={id('unlock-purchase')}
        loading={purchase.opening === true}
        spinnerTestId={id('unlock-purchase-spinner')}
        onClick={onStart}
      >
        {copy.action}
      </Button>
    ) : undefined,
  );
}

/** The gate's title, from the same copy its body uses. */
function guestGateTitle(
  subject: GuestModelGateSubject,
  fallbackLabel: string | undefined,
): string {
  return 'copy' in subject
    ? subject.copy.title
    : guestModelGateCopy({
        ...subject,
        ...(fallbackLabel === undefined ? {} : { fallbackLabel }),
      }).title;
}
