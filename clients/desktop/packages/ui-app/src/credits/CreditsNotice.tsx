'use client';

import type { JSX, ReactNode, Ref } from 'react';
import { useOptionalCanopyClient } from '@canopy/app-state';
import {
  resolveCreditsPrompt,
  type CreditsCheckFeedbackKind,
  type CreditsPrompt,
  type CreditsPromptCondition,
  type CreditsPromptOwner,
  type CreditsPromptViewer,
  type CreditsPurchaseMode,
} from '@canopy/app-state/billing/credits';
import type { ProviderChoicePrimary } from '@canopy/app-state/provider-choice';
import type { SettingsPaymentOwner } from '@canopy/protocol/billing';
import type { SettingsPaymentHandoffIntent } from '@canopy/protocol/settings/payment-handoff';
import {
  AI_CREDITS_GUEST_PURCHASE_LABEL,
  AI_CREDITS_HANDOFF_COPY,
  AI_CREDITS_PURCHASE_LABEL,
  AI_CREDITS_REOPEN_BILLING_LABEL,
  AiCreditsArrivedNotice,
  AiCreditsStopLine,
  ButtonLink,
  CreditsRecoveryNotice,
  DESKTOP_APP_ALTERNATIVE_LABEL,
  creditsPromptCopy,
  ModelUnlockConfirmedNotice,
  ModelUnlockPendingNotice,
  NoticeButton,
  retainedMessageCopy,
  UsageLimitNotice,
  type NoticeActionsPlacement,
} from '@canopy/ui-shared/components';
import { TimeslotIcon } from '@canopy/ui-shared/icons/AppIcons';
import { DESKTOP_DOWNLOAD_PATH } from '../external-agents/paths';
import { providerChoicePrimaryLabel } from '../providers/provider-choice-primary';
import { ProviderChoiceContinueMenu } from '../providers/ProviderChoiceContinueMenu';
import {
  useCreditsPurchase,
  type CreditsCheckoutOptions,
  type CreditsPurchaseStart,
} from './CreditsPurchaseProvider';

/**
 * The one AI Credits notice (Card A). Every surface that tells someone their
 * work needs AI Credits renders it: the composer's usage-limit and
 * no-billing-source notices, the queued-message notice, the advanced-model
 * unlock's waiting and confirmed notices, and the transcript's stop line on
 * desktop; the cloud chat's out-of-credits and held first message notices,
 * the Portal's usage-limit notice and the cloud terminal's out-of-credits
 * notice on the web.
 *
 * The host says what happened (`condition`), whose wallet pays (`owner`) and
 * where the notice sits (`placement`). The notice asks
 * {@link resolveCreditsPrompt} who it is for and which actions it offers, and
 * picks its frame from the condition and the purchase's progress. Its words
 * come from the shared copy table (`creditsPromptCopy`), keyed by the same
 * reason and audience the prompt resolves. Its parts
 * (`UsageLimitNotice`, `CreditsRecoveryNotice`, `AiCreditsArrivedNotice`,
 * `AiCreditsCheckFeedback`'s copy, `AiCreditsStopLine` and the model unlock
 * notices) are internal to it. They stay exported from `@canopy/ui-shared`
 * only for the desktop components lab, the desktop purchase control's Check
 * again feedback and the Portal's transcript replays.
 *
 * Purchases start through the shared action ({@link useCreditsPurchase}),
 * unless the host keeps a purchase control of its own (`purchase.kind ===
 * 'host'`): a tracked browser hand-off whose Check again and arrival record
 * live with the host. Nothing here branches on which host renders it.
 *
 * Recovery offers provider choice (`providerChoice`): on a usage limit, out
 * of credits, no billing source or a held message, the notice shows one
 * provider-choice control ("Switch provider", "Choose provider", or a
 * Continue menu offering "Continue with X" and Choose provider) and no
 * purchase or contact-admin line; both move to the credits row of the
 * provider list the control opens. A purchase started from that row comes
 * back here as `pending`, with the host's `completion` controls, and the
 * notice then shows only those two buttons. Without
 * `providerChoice` the notice still sells, which the recorded exceptions
 * (the cloud terminal and the web new-task funding notice) rely on.
 *
 * A host whose work could instead run on the desktop app opts in to
 * `desktopAlternative`: the notice then links to the desktop download as a
 * secondary action, only where the client can offer it
 * (`capabilities.desktopDownload`, never on desktop).
 */

/** The conditions where provider choice replaces the purchase. */
const PROVIDER_CHOICE_CONDITIONS: ReadonlySet<CreditsPromptCondition> =
  new Set<CreditsPromptCondition>([
    'quota_limit',
    'out_of_credits',
    'no_billing_source',
    'queued_held',
  ]);

/** The notice's single provider-choice button. */
export interface CreditsNoticeProviderChoice {
  readonly primary: ProviderChoicePrimary;
  /** The `continue-with` source's display name. */
  readonly providerName: string;
  /** "Continue with X": acts as choosing that row in the list would. */
  readonly onContinue: () => void;
  /** "Switch provider" / "Choose provider": opens the provider list. */
  readonly onSwitchProvider: () => void;
  /** Disables the button while its action runs, so it acts once. */
  readonly busy?: boolean;
  readonly testId?: string;
}

/** Where a notice sits. The composer stack sets the notice's own shape. */
export type CreditsNoticePlacement =
  | 'composer'
  | 'transcript'
  | 'terminal'
  | 'card';

/** Whose wallet pays: the prompt's owner, plus the organization to pay. */
export type CreditsNoticeOwner =
  | { readonly kind: 'personal' }
  | {
      readonly kind: 'organization';
      /** The organization a purchase pays; omitted when not known. */
      readonly organizationId?: string;
      readonly canFund: boolean;
      readonly creditPool: boolean;
    }
  | { readonly kind: 'unknown' };

/** Reopen billing during a hand-off, wired to the host's hand-off. */
export interface CreditsNoticeReopenBilling {
  /** Absent until the host's hand-off reports its controls. */
  readonly onReopen?: () => void;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly testId?: string;
}

/** An unlock purchase's own check, polled by the host. */
export interface CreditsNoticeCheckNow {
  readonly timedOut: boolean;
  readonly checking: boolean;
  readonly onCheckNow: () => void;
}

/** A purchase for this wallet is in progress. */
export interface CreditsNoticePending {
  /** The last Check again verdict, or `null` while simply waiting. */
  readonly feedback: CreditsCheckFeedbackKind | null;
  readonly reopenBilling?: CreditsNoticeReopenBilling;
  /** The advanced-model unlock's check (`model_locked` only). */
  readonly checkNow?: CreditsNoticeCheckNow;
}

/** Credits bought from this notice arrived. */
export interface CreditsNoticeArrival {
  readonly addedCredits: number | null;
  readonly balanceCredits: number | null;
}

/** Who starts the purchase this notice offers. */
export type CreditsNoticePurchase =
  /**
   * The shared purchase action, for this notice's owner. It has no Check
   * again, so a hand-off in progress (`pending`) shows no purchase control.
   */
  | {
      readonly kind: 'shared';
      /** A guest's sign-in, which comes before any purchase. */
      readonly onSignIn?: () => void;
      readonly testId?: string;
      /**
       * What the purchase is for. Defaults to a top-up for the condition,
       * with no source.
       */
      readonly intent?: SettingsPaymentHandoffIntent;
      /** The inline checkout's options, such as its account and callbacks. */
      readonly checkout?: CreditsCheckoutOptions;
      /** The purchase started, with the checkout it opened, if any. */
      readonly onStart?: (started: CreditsPurchaseStart) => void;
    }
  /**
   * A purchase control the host keeps, such as a tracked browser hand-off.
   * It renders for the prompt's purchase, Check again and sign-in actions.
   */
  | {
      readonly kind: 'host';
      readonly mode: CreditsPurchaseMode;
      readonly control: ReactNode;
    }
  /** Another control on screen offers the purchase; this notice offers none. */
  | { readonly kind: 'elsewhere' };

export interface CreditsNoticeProps {
  readonly condition: CreditsPromptCondition;
  /** Approved billing-refusal copy, independent of host purchase mechanics. */
  readonly outOfCredits?: boolean;
  readonly canConnectClaude?: boolean;
  readonly orgPoolUnavailable?: boolean;
  readonly owner: CreditsNoticeOwner;
  readonly placement: CreditsNoticePlacement;
  /**
   * The host's own actions, before the credits actions: an alternative such
   * as connecting a provider or resuming at the reset.
   */
  readonly secondaryAction?: ReactNode;
  /**
   * Offer the desktop app as another way to keep going: a secondary link to
   * the desktop download, after `secondaryAction`. Shown only when the
   * client has the `desktopDownload` capability. Opt in only where the work
   * could run on a desktop instead (a cloud chat), never on a notice about
   * a paired desktop. Defaults to `false`.
   */
  readonly desktopAlternative?: boolean;
  /** Called when the desktop app link is chosen, before it navigates. */
  readonly onDesktopAlternative?: () => void;
  /** Defaults to `signed-in`. */
  readonly viewer?: CreditsPromptViewer;
  /** The billing rollout is on for this viewer. Defaults to `true`. */
  readonly billingEnabled?: boolean;
  /** See `CreditsPromptState.purchaseOnUnknownOwner`. */
  readonly purchaseOnUnknownOwner?: boolean;
  /**
   * The host's coverage read says a purchase would help. `false` offers none,
   * except to finish one already in progress. Defaults to `true`.
   */
  readonly purchaseNeeded?: boolean;
  /**
   * Add the line telling an organization member to ask an admin. Defaults to
   * the prompt's own answer.
   */
  readonly contactAdmin?: boolean;
  readonly pending?: CreditsNoticePending | null;
  readonly arrived?: CreditsNoticeArrival | null;
  /** Defaults to the shared purchase action. */
  readonly purchase?: CreditsNoticePurchase;
  /**
   * Offer provider choice in place of the purchase; see the module comment.
   * Ignored outside the recovery conditions.
   */
  readonly providerChoice?: CreditsNoticeProviderChoice;
  /**
   * The host's controls that finish a purchase started from the provider
   * list (Check again), rendered only while `pending` is set and
   * `providerChoice` is on.
   */
  readonly completion?: ReactNode;
  /** The limited provider (`quota_limit`). */
  readonly provider?: 'claude' | 'codex';
  /** The model a purchase unlocks (`model_locked`). */
  readonly modelLabel?: string;
  /** The state, ahead of the message; a hand-off names its own step. */
  readonly title?: ReactNode;
  /** The message; a hand-off and a held message have their own. */
  readonly children?: ReactNode;
  /**
   * Supporting copy after the message. Out of credits it runs on in the same
   * paragraph, after any contact-admin sentence.
   */
  readonly detail?: ReactNode;
  /** Replaces the frame's icon, such as a spinner while the host works. */
  readonly icon?: ReactNode;
  /** The host's spacing around the notice. */
  readonly className?: string;
  /**
   * Defaults to below during a hand-off and beside a guest's sign-in, and
   * trailing otherwise.
   */
  readonly actionsPlacement?: NoticeActionsPlacement;
  /** Group the actions in one element, with an optional test id. */
  readonly actionsGroup?: { readonly testId?: string };
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  readonly dismissTestId?: string;
  readonly contactAdminTestId?: string;
  readonly tabIndex?: number;
  readonly ref?: Ref<HTMLDivElement>;
  readonly 'data-testid'?: string;
}

/** The handoff step a waiting purchase shows in place of its condition. */
function handoffCopy(feedback: CreditsCheckFeedbackKind | null): {
  readonly title: string;
  readonly message: string;
} {
  switch (feedback) {
    case 'uncovered':
      return AI_CREDITS_HANDOFF_COPY.uncovered;
    case 'check-failed':
      return AI_CREDITS_HANDOFF_COPY.checkFailed;
    default:
      return AI_CREDITS_HANDOFF_COPY.waiting;
  }
}

function promptOwnerOf(owner: CreditsNoticeOwner): CreditsPromptOwner {
  return owner.kind === 'organization'
    ? {
        kind: 'organization',
        canFund: owner.canFund,
        creditPool: owner.creditPool,
      }
    : owner;
}

/**
 * The wallet a notice's purchase pays, from its owner: `null` while it can't
 * be known. A member who can't fund an organization without a pool buys
 * personal credits, as {@link resolveCreditsPrompt}'s rule 4 offers them.
 * Exported so a host's provider-choice credits row pays the same wallet the
 * notice's own purchase would.
 */
export function creditsNoticePaymentOwner(
  owner: CreditsNoticeOwner,
): SettingsPaymentOwner | null {
  if (owner.kind === 'personal') return { kind: 'personal' };
  if (owner.kind !== 'organization') return null;
  if (!owner.canFund && !owner.creditPool) return { kind: 'personal' };
  return owner.organizationId === undefined
    ? null
    : { kind: 'organization', organizationId: owner.organizationId };
}

/** One AI Credits notice; see the module comment. */
export function CreditsNotice({
  purchase: requested,
  desktopAlternative = false,
  onDesktopAlternative,
  ...rest
}: CreditsNoticeProps): JSX.Element {
  const desktopDownload =
    useOptionalCanopyClient()?.capabilities.desktopDownload === true;
  const props: CreditsNoticeBaseProps = {
    ...rest,
    desktopAlternativeControl:
      desktopAlternative && desktopDownload ? (
        <ButtonLink
          href={DESKTOP_DOWNLOAD_PATH}
          variant="secondary"
          size="sm"
          onClick={onDesktopAlternative}
          data-testid={`${rest['data-testid'] ?? 'credits-notice'}-desktop-app`}
        >
          {DESKTOP_APP_ALTERNATIVE_LABEL}
        </ButtonLink>
      ) : null,
  };
  const purchase = requested ?? { kind: 'shared' };
  if (purchase.kind === 'shared')
    return <SharedPurchaseCreditsNotice {...props} purchase={purchase} />;
  return (
    <CreditsNoticeView
      {...props}
      purchaseMode={purchase.kind === 'host' ? purchase.mode : 'unavailable'}
      purchaseControl={purchase.kind === 'host' ? purchase.control : null}
      checkAgainControl={purchase.kind === 'host' ? purchase.control : null}
      signInControl={purchase.kind === 'host' ? purchase.control : null}
    />
  );
}

/** The notice's props once its host-level options are resolved. */
interface CreditsNoticeBaseProps extends Omit<
  CreditsNoticeProps,
  'purchase' | 'desktopAlternative' | 'onDesktopAlternative'
> {
  /** The desktop app link, when the host opted in and the client offers it. */
  readonly desktopAlternativeControl: ReactNode;
}

/** A notice whose purchase starts through the shared purchase action. */
function SharedPurchaseCreditsNotice({
  purchase,
  ...props
}: CreditsNoticeBaseProps & {
  readonly purchase: Extract<CreditsNoticePurchase, { kind: 'shared' }>;
}): JSX.Element {
  const paymentOwner = creditsNoticePaymentOwner(props.owner);
  const action = useCreditsPurchase(paymentOwner);
  const testId = purchase.testId ?? 'credits-notice-purchase';
  const reason =
    props.condition === 'model_locked' ? 'unlock_models' : 'credits';
  return (
    <CreditsNoticeView
      {...props}
      // Unknown until the host answers whether a purchase can open. A
      // signed-in viewer with no wallet to pay (an organization whose id is
      // missing) can't start one; a guest's sign-in needs no wallet.
      purchaseMode={
        paymentOwner === null && props.viewer !== 'guest'
          ? 'unavailable'
          : (action.mode ?? 'unavailable')
      }
      // The shared action has no Check again: a hand-off in progress offers
      // no second checkout here.
      checkAgainControl={null}
      purchaseControl={
        <NoticeButton
          variant="primary"
          onClick={(): void => {
            const started = action.start(
              purchase.intent ?? { kind: 'top-up', reason },
              purchase.checkout,
            );
            purchase.onStart?.(started);
          }}
          data-testid={testId}
        >
          {AI_CREDITS_PURCHASE_LABEL}
        </NoticeButton>
      }
      signInControl={
        purchase.onSignIn === undefined ? null : (
          <NoticeButton
            variant="primary"
            onClick={purchase.onSignIn}
            data-testid={`${testId}-sign-in`}
          >
            {AI_CREDITS_GUEST_PURCHASE_LABEL}
          </NoticeButton>
        )
      }
    />
  );
}

interface CreditsNoticeViewProps extends CreditsNoticeBaseProps {
  readonly purchaseMode: CreditsPurchaseMode;
  /** Renders for the purchase action. */
  readonly purchaseControl: ReactNode;
  /** Renders for Check again on a hand-off in progress. */
  readonly checkAgainControl: ReactNode;
  /** Renders for a guest's sign-in. */
  readonly signInControl: ReactNode;
}

/** Which purchase action a prompt shows, if any. */
function purchaseActionOf(
  prompt: CreditsPrompt,
  purchaseNeeded: boolean,
): 'purchase' | 'check-again' | 'sign-in' | null {
  if (prompt.primary === 'sign-in') return 'sign-in';
  if (prompt.primary !== 'buy' && prompt.primary !== 'check-again') return null;
  // A purchase in progress keeps its controls whatever coverage now says.
  if (!purchaseNeeded && !prompt.pending) return null;
  return prompt.primary === 'check-again' ? 'check-again' : 'purchase';
}

/**
 * The hand-off's buttons, and a guest's long `Sign in to buy credits`, get
 * their own row, so the copy keeps the full width.
 */
function defaultActionsPlacement(
  handoff: boolean,
  purchaseAction: ReturnType<typeof purchaseActionOf>,
  control: ReactNode,
): NoticeActionsPlacement {
  const guestSignIn = purchaseAction === 'sign-in' && control != null;
  return handoff || guestSignIn ? 'below' : 'trailing';
}

function CreditsNoticeView({
  condition,
  outOfCredits = false,
  canConnectClaude = false,
  orgPoolUnavailable = false,
  owner,
  placement,
  secondaryAction,
  desktopAlternativeControl,
  viewer = 'signed-in',
  billingEnabled = true,
  purchaseOnUnknownOwner = false,
  purchaseNeeded = true,
  contactAdmin,
  pending = null,
  arrived = null,
  provider = 'claude',
  modelLabel,
  title,
  children,
  detail,
  icon,
  className,
  actionsPlacement,
  actionsGroup,
  onDismiss,
  dismissLabel,
  dismissTestId,
  contactAdminTestId,
  tabIndex,
  ref,
  'data-testid': testId,
  purchaseMode,
  purchaseControl,
  checkAgainControl,
  signInControl,
  providerChoice: requestedChoice,
  completion,
}: CreditsNoticeViewProps): JSX.Element {
  if (placement === 'transcript') {
    // The transcript only says why the chat stopped; the composer's notice
    // is where the person chooses how to pay.
    return <AiCreditsStopLine {...(testId ? { dataTestId: testId } : {})} />;
  }
  if (condition === 'model_locked') {
    if (arrived !== null) {
      return (
        <ModelUnlockConfirmedNotice
          {...(arrived.balanceCredits !== null
            ? { credits: arrived.balanceCredits }
            : {})}
          {...(arrived.addedCredits !== null
            ? { addedCredits: arrived.addedCredits }
            : {})}
          {...(modelLabel !== undefined ? { modelLabel } : {})}
          onDismiss={onDismiss ?? noop}
          {...(testId ? { testId } : {})}
        />
      );
    }
    if (pending?.checkNow !== undefined) {
      return (
        <ModelUnlockPendingNotice
          phase={pending.checkNow.timedOut ? 'timed-out' : 'waiting'}
          {...(modelLabel === undefined ? {} : { modelLabel })}
          checking={pending.checkNow.checking}
          onCheckNow={pending.checkNow.onCheckNow}
          {...(onDismiss === undefined ? {} : { onDismiss })}
          {...(testId ? { dataTestId: testId } : {})}
        />
      );
    }
  }

  const prompt = resolveCreditsPrompt({
    billingEnabled,
    viewer,
    owner: promptOwnerOf(owner),
    condition,
    purchaseMode,
    pending: pending !== null,
    pendingFeedback: pending?.feedback ?? null,
    purchaseOnUnknownOwner,
  });
  const copy = creditsPromptCopy(prompt.reason, prompt.audience);
  const providerChoice =
    requestedChoice !== undefined && PROVIDER_CHOICE_CONDITIONS.has(condition)
      ? requestedChoice
      : null;
  const purchaseAction =
    providerChoice !== null ? null : purchaseActionOf(prompt, purchaseNeeded);
  // A purchase from the provider list is pending: the notice keeps two
  // buttons, the provider choice and the host's Check again. The host's
  // alternative (Connect, Resume at) and Reopen billing step aside; Reopen
  // billing moves to the list's credits row.
  const choicePending =
    providerChoice !== null && pending !== null && completion != null;
  const choiceVariant = choicePending ? 'secondary' : 'primary';
  const control =
    providerChoice !== null ? (
      <>
        {providerChoice.primary.kind === 'continue-with' ? (
          <ProviderChoiceContinueMenu
            continueLabel={providerChoicePrimaryLabel(
              providerChoice.primary,
              providerChoice.providerName,
            )}
            onContinue={providerChoice.onContinue}
            onChooseProvider={providerChoice.onSwitchProvider}
            variant={choiceVariant}
            busy={providerChoice.busy === true}
            {...(providerChoice.testId !== undefined
              ? { testId: providerChoice.testId }
              : {})}
          />
        ) : (
          <NoticeButton
            // Mid-purchase Check again leads; switching steps back.
            variant={choiceVariant}
            onClick={providerChoice.onSwitchProvider}
            busy={providerChoice.busy === true}
            data-testid={providerChoice.testId}
          >
            {providerChoicePrimaryLabel(
              providerChoice.primary,
              providerChoice.providerName,
            )}
          </NoticeButton>
        )}
        {/* The single primary sits last: Check again while a purchase from
            the provider list is pending. */}
        {pending !== null && completion}
      </>
    ) : purchaseAction === null ? null : (
      {
        purchase: purchaseControl,
        'check-again': checkAgainControl,
        'sign-in': signInControl,
      }[purchaseAction]
    );
  // The hand-off's step shows only beside the control that finishes it.
  const step =
    providerChoice !== null
      ? pending
      : purchaseAction !== 'sign-in' && control != null && prompt.pending
        ? pending
        : null;
  // A failed check is retried with Check again, never Reopen billing, on
  // either branch (resolveCreditsPrompt's rule).
  const reopen =
    step !== null &&
    !choicePending &&
    (providerChoice !== null
      ? step.feedback !== 'check-failed'
      : prompt.secondary === 'reopen-billing')
      ? (step.reopenBilling ?? null)
      : null;
  const shownSecondary = choicePending ? null : secondaryAction;
  const shownDesktopAlternative = choicePending
    ? null
    : desktopAlternativeControl;
  const hasActions =
    shownSecondary != null ||
    shownDesktopAlternative != null ||
    reopen !== null ||
    control != null;
  const actionItems = (
    <>
      {shownSecondary}
      {shownDesktopAlternative}
      {reopen !== null && (
        <NoticeButton
          variant="secondary"
          onClick={(): void => reopen.onReopen?.()}
          busy={reopen.pending}
          disabled={reopen.onReopen === undefined || reopen.disabled}
          // Keep focus where it was (often the composer), like the CTA.
          onMouseDown={(e): void => e.preventDefault()}
          data-testid={reopen.testId}
        >
          {AI_CREDITS_REOPEN_BILLING_LABEL}
        </NoticeButton>
      )}
      {control}
    </>
  );
  const actions = hasActions ? (
    actionsGroup !== undefined ? (
      <span data-testid={actionsGroup.testId} className="contents">
        {actionItems}
      </span>
    ) : (
      actionItems
    )
  ) : undefined;
  const actionProps =
    actions === undefined
      ? {}
      : {
          actions,
          actionsPlacement:
            actionsPlacement ??
            defaultActionsPlacement(step !== null, purchaseAction, control),
        };
  const shared = {
    ...(ref !== undefined ? { ref } : {}),
    ...(testId !== undefined ? { 'data-testid': testId } : {}),
    ...(tabIndex !== undefined ? { tabIndex } : {}),
    ...(onDismiss !== undefined ? { onDismiss } : {}),
    ...(dismissTestId !== undefined ? { dismissTestId } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(className !== undefined ? { className } : {}),
  };
  const detailProps = detail !== undefined ? { detail } : {};

  if (arrived !== null) {
    return (
      <AiCreditsArrivedNotice
        {...shared}
        {...detailProps}
        addedCredits={arrived.addedCredits}
        balanceCredits={arrived.balanceCredits}
        {...(dismissLabel !== undefined ? { dismissLabel } : {})}
        {...actionProps}
      >
        {children}
      </AiCreditsArrivedNotice>
    );
  }

  const stepCopy = step !== null ? handoffCopy(step.feedback) : null;
  if (condition === 'quota_limit') {
    return (
      <UsageLimitNotice
        {...shared}
        {...detailProps}
        provider={provider}
        // Mid-purchase the step the person is on replaces the limit they
        // already acted on, as on every purchase path.
        {...(stepCopy !== null && step !== null
          ? {
              purchaseStep: {
                title: stepCopy.title,
                failed: step.feedback === 'check-failed',
              },
            }
          : {})}
        {...(dismissLabel !== undefined ? { dismissLabel } : {})}
        {...actionProps}
      >
        {children ?? stepCopy?.message}
      </UsageLimitNotice>
    );
  }

  // Waiting on a purchase is not a warning; only a failed check is.
  const waiting = step !== null && step.feedback !== 'check-failed';
  const recoveryTitle = title ?? stepCopy?.title;
  return (
    <CreditsRecoveryNotice
      {...shared}
      outOfCredits={outOfCredits && providerChoice === null && step === null}
      canConnectClaude={canConnectClaude}
      orgPoolUnavailable={orgPoolUnavailable}
      // A detail sentence, so the admin sentence joins it rather than
      // replacing it. Both run on after the message in one paragraph.
      {...(detail !== undefined ? { detailLines: [detail] } : {})}
      intent={waiting ? 'neutral' : 'attention'}
      {...(waiting
        ? { icon: <TimeslotIcon size={16} aria-hidden="true" /> }
        : {})}
      {...(recoveryTitle !== undefined ? { title: recoveryTitle } : {})}
      {...(dismissLabel !== undefined ? { dismissLabel } : {})}
      // With provider choice the admin line is the credits row's.
      contactAdmin={
        providerChoice !== null
          ? false
          : (contactAdmin ?? prompt.primary === 'contact-admin')
      }
      {...(contactAdminTestId !== undefined ? { contactAdminTestId } : {})}
      {...actionProps}
    >
      {children ??
        (condition === 'queued_held'
          ? providerChoice !== null
            ? // Nothing on the notice buys, so the line only says it's saved.
              retainedMessageCopy('queue', { canBuy: false })
            : copy.message
          : stepCopy?.message)}
    </CreditsRecoveryNotice>
  );
}

function noop(): void {}
