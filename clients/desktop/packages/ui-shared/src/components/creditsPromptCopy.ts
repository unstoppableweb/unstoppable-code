import { APP_ERROR_CATALOG } from '@canopy/protocol/app-errors';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import { formatCredits } from '../lib/billing-format';

/**
 * Every word an AI Credits prompt says, in one place: the purchase, its
 * checkout hand-off, the recovery notices, the advanced-model unlock and the
 * usage-limit model switch. Desktop and web render the same strings, so each
 * path names the same step the same way.
 *
 * Credits are one provider among peers. Every action that starts a purchase
 * says {@link AI_CREDITS_PURCHASE_LABEL}; a guest's says
 * {@link AI_CREDITS_GUEST_PURCHASE_LABEL}. A purchase verb never takes the
 * product term, and recovery and unlock copy say "credits" in lowercase.
 * Billing and balance text keeps the product term "AI Credits"
 * (docs/ux-writing/labels.md#ai-credits-purchases).
 *
 * {@link creditsPromptCopy} keys the purchase action and default message by
 * the reason and audience `resolveCreditsPrompt` (`@canopy/app-state`)
 * returns. The named constants below are the table's parts, and stay exported
 * for hosts that compose a line themselves.
 *
 * Titles carry no full stop; `Notice` and the hosts that join a title and
 * message add it.
 */

// ---------------------------------------------------------------------------
// Purchase and checkout hand-off
// ---------------------------------------------------------------------------

/** The purchase action on every surface, and the checkout's title. */
export const AI_CREDITS_PURCHASE_LABEL = 'Buy credits';

/**
 * CAN-4766 — the purchase action a guest sees. A guest can't buy before
 * signing in, so no guest action carries the bare purchase label.
 */
export const AI_CREDITS_GUEST_PURCHASE_LABEL = 'Sign in to buy credits';

/** The re-read after checkout, on every surface. */
export const AI_CREDITS_CHECK_AGAIN_LABEL = 'Check again';

/** Reopens the browser checkout while a purchase is in progress. */
export const AI_CREDITS_REOPEN_BILLING_LABEL = 'Reopen billing';

/**
 * While checkout is open in the browser, and after a Check again that found
 * nothing (`uncovered`) or could not read the balance (`checkFailed`).
 */
export const AI_CREDITS_HANDOFF_COPY = {
  waiting: {
    title: 'Finish checkout in your browser',
    message: 'Your credits show up here once the payment goes through.',
  },
  uncovered: {
    title: 'No credits yet',
    message: "If you've paid, they may still be on the way.",
  },
  // The notice's Check again button is the next step, so no message.
  checkFailed: {
    title: "Couldn't check your balance",
    message: '',
  },
} as const;

/** One copy entry as a single sentence pair, for hosts without a title slot. */
export function aiCreditsHandoffSentence(entry: {
  readonly title: string;
  readonly message: string;
}): string {
  return entry.message === ''
    ? `${entry.title}.`
    : `${entry.title}. ${entry.message}`;
}

/** Paid, but the credits haven't arrived yet (docs/ux-writing/sign-in.md). */
export const AI_CREDITS_PROCESSING_TITLE = 'Payment received';
export const AI_CREDITS_PROCESSING_MESSAGE =
  "Your credits are still processing. You won't be charged again.";
export const AI_CREDITS_PROCESSING_COPY = `${AI_CREDITS_PROCESSING_TITLE}. ${AI_CREDITS_PROCESSING_MESSAGE}`;

/**
 * What the transcript says where a message stopped because nothing could pay
 * for it. The composer's banner is where the user chooses a provider, so the
 * transcript only explains the stop and offers no action of its own.
 */
export const AI_CREDITS_STOP_COPY =
  'Message not sent. This chat needs a provider.';

// ---------------------------------------------------------------------------
// Recovery (CAN-4764): out of credits, held messages, dead ends
// ---------------------------------------------------------------------------

/** A recovery notice's state (the title) and what follows it on the line. */
export interface CreditsRecoveryCopy {
  readonly title: string;
  readonly message: string;
}

/**
 * Copy for an org member whose org carries the credit-pool capability but has no
 * spendable headroom right now. They cannot buy credits themselves, so every
 * banner shows this instead of a purchase CTA.
 */
export const CONTACT_ORG_ADMIN_COPY =
  'Ask an org admin to raise your spending limit.';

/** The title while a queued message waits on credits. */
export const MESSAGE_QUEUED_TITLE = 'Message queued';

/**
 * The message while a queued message waits on credits. It names no button,
 * because the notices that show it differ in what they offer.
 */
const QUEUED_MESSAGE_WAITING_COPY = 'It sends once you have credits.';

/** The same, for an org member who can't buy: an admin funds the pool. */
const QUEUED_MESSAGE_ORG_WAITING_COPY =
  'It sends once your organization has credits.';

/** The same, on a notice whose button reads Choose provider. */
const QUEUED_MESSAGE_CHOOSE_PROVIDER_COPY = `${QUEUED_MESSAGE_WAITING_COPY} Buy them under Choose provider.`;

/** Queue status while the account needs credits, where nothing else is known. */
export const CREDIT_HELD_MESSAGE_WARNING_COPY = QUEUED_MESSAGE_WAITING_COPY;

/**
 * A held queued message's line. `orgFunds`: an org member whose admin buys
 * the credits. `chooseProvider`: the notice's own button reads Choose
 * provider, and its list holds the purchase.
 */
export function queuedMessageCopy({
  orgFunds,
  chooseProvider,
}: {
  readonly orgFunds: boolean;
  readonly chooseProvider: boolean;
}): string {
  if (orgFunds) return QUEUED_MESSAGE_ORG_WAITING_COPY;
  return chooseProvider
    ? QUEUED_MESSAGE_CHOOSE_PROVIDER_COPY
    : QUEUED_MESSAGE_WAITING_COPY;
}

/** The out-of-credits recovery notice's title. */
export const OUT_OF_CREDITS_TITLE = "You're out of credits";

/**
 * What happened to the user's message, so they know nothing was lost. The
 * notice's purchase button carries the action, so the line doesn't repeat
 * it. `canBuy: false` (an org member whose admin funds the pool, or billing
 * off) only says the message is safe: no line tells someone to buy who can't.
 */
export function retainedMessageCopy(
  origin: 'composer' | 'create' | 'first',
  { canBuy = true }: { readonly canBuy?: boolean } = {},
): string {
  if (origin === 'first') {
    // A new cloud worktree held its first message until setup could pay.
    return canBuy
      ? 'Your first message is saved, so try it again after you buy more.'
      : 'Your first message is saved.';
  }
  if (origin === 'create') {
    return canBuy
      ? 'Nothing was sent, so try again after you buy more.'
      : 'Nothing was sent.';
  }
  return canBuy
    ? 'Your message is saved, so send it again after you buy more.'
    : 'Your message is saved.';
}

/** The title of every state where this chat has nothing that can pay. */
const NO_PROVIDER_TITLE = 'This chat needs a provider';

/** The organization's model policy allows nothing the user can run. */
export const POLICY_ONLY_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: 'No model allowed',
  message:
    'Your organization blocks every model you can use. Ask an org admin to allow one.',
};

/** The organization only allows models paid for with credits. */
export const CREDITS_ONLY_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: 'This chat needs credits',
  message: 'Your organization allows only models that run on credits.',
};

/**
 * Every model the organization allows needs a provider or credits the user
 * doesn't have yet. It names no provider: the constant has none to name.
 */
export const POLICY_BILLING_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: NO_PROVIDER_TITLE,
  message:
    'Connect one or buy credits to use a model your organization allows.',
};

/**
 * Before sending: nothing this chat can use will pay for it, whether no
 * provider is connected, the chat's provider is signed out, or no available
 * model can be paid for. Keep the twin sentences in `buildNoBillingSourceError`
 * and `buildSignedOutNoBillingSourceError` (`@canopy/desktop-shared`, which
 * this package may not import) the same by hand.
 */
export const NO_PROVIDER_COPY: CreditsRecoveryCopy = {
  title: NO_PROVIDER_TITLE,
  message: 'Choose one to send your message.',
};

/**
 * A turn already failed because nothing could pay for it. It never says the
 * person's credits ran short: many who see it never had any.
 */
export const FAILED_TURN_COPY: CreditsRecoveryCopy = {
  title: 'Message not sent',
  message: 'This chat needs a provider. Choose one, then send it again.',
};

/**
 * The message for {@link NO_PROVIDER_COPY} or {@link FAILED_TURN_COPY} when
 * exactly one source is ready. `continueLabel` is that source's button text
 * (`continueWithLabel`), so credits read "credits".
 */
export function readyProviderMessage(
  continueLabel: string,
  { failedTurn }: { readonly failedTurn: boolean },
): string {
  return failedTurn
    ? `${continueLabel}, then send it again.`
    : `${continueLabel}, or choose another.`;
}

/**
 * CAN-4766 — the action that connects a provider account, on every recovery
 * surface that offers it. It names only the current model's provider.
 */
export function connectProviderLabel(providerLabel: string): string {
  return `Connect ${providerLabel}`;
}

/** An organization pool with nothing in it yet, for someone who can fund it. */
export const EMPTY_CREDIT_POOL_COPY: CreditsRecoveryCopy = {
  title: 'No credits yet',
  message: 'Buy credits so your team can use AI features.',
};

// ---------------------------------------------------------------------------
// Advanced-model unlock
// ---------------------------------------------------------------------------

/** An access value that still locks advanced models. */
export type LockedModelLibraryAccess = Exclude<ModelLibraryAccess, 'unlocked'>;

/**
 * A locked model row's hint, by access value: the remedy, read as the row's
 * description and in its hover details. Sentence case with no full stop, like
 * the row's other text. The row's visible cue is the shorter
 * {@link MODEL_LIBRARY_UNLOCK_LABELS}.
 */
export const MODEL_LIBRARY_UNLOCK_HINTS: Readonly<
  Record<LockedModelLibraryAccess, string>
> = {
  needs_sign_in: 'Unlock by signing in',
  needs_sign_in_then_purchase: 'Unlock by signing in and buying credits',
  needs_purchase: 'Unlock by buying credits',
};

// Names no minimum price and no model families or providers (CAN-7493), so it
// stays true when the checkout minimum or the catalog changes.
const PURCHASE_SCOPE_BODY = 'Advanced models use credits.';

/**
 * Recovery copy. "Advanced models", never "every model": provider, policy, and
 * funding restrictions still apply after a purchase. Nothing here promises the
 * unlock is permanent, because a lost chargeback can revoke it.
 */
export const MODEL_LIBRARY_UNLOCK_COPY = {
  title: 'Unlock advanced models',
  purchaseBody: `${PURCHASE_SCOPE_BODY} We'll switch to your model once you've paid.`,
  // Billing links and proxy recovery can open checkout without a pending model.
  purchaseBodyWithoutSelection: PURCHASE_SCOPE_BODY,
  guestBody: 'Sign in, then buy credits.',
  purchaseAction: AI_CREDITS_PURCHASE_LABEL,
  signInAction: 'Sign in',
  /** The row label when a purchase follows sign-in. */
  signInThenPurchaseLabel: AI_CREDITS_GUEST_PURCHASE_LABEL,
  dismissAction: 'Not now',
  confirmed: 'Advanced models are unlocked.',
  selectionFailed: "Couldn't select your model.",
  retrySelection: 'Try again',
  waitingInBrowser: `${AI_CREDITS_HANDOFF_COPY.waiting.title}. We'll check when the payment goes through.`,
  pendingTitle: AI_CREDITS_HANDOFF_COPY.waiting.title,
  timedOutTitle: 'We stopped checking for your payment',
  timedOutBody: `Your purchase may still be in progress. ${AI_CREDITS_CHECK_AGAIN_LABEL} once it's complete.`,
  newPurchaseHelp: "Starting a new purchase won't cancel the previous one.",
  dismissHelp:
    "Dismissing this notice stops tracking this purchase. It won't cancel your purchase.",
  checkNowAction: AI_CREDITS_CHECK_AGAIN_LABEL,
  checkingAction: 'Checking…',
  newPurchaseAction: 'Start a new purchase',
  dismissPaymentAction: 'Dismiss payment notice',
  proxyRefusalTitle: 'This model needs credits',
  proxyRefusalBody:
    'Choose a provider that offers this model, then send your message again.',
  /**
   * The in-chat confirmation after a confirmed unlock (CAN-5027). The number
   * is the refreshed available balance, never the amount purchased or
   * charged; without a usable balance the notice says `confirmed` instead.
   */
  confirmedCredits: (credits: number): string =>
    `You have ${formatCredits(credits)} AI Credits.`,
  /** Only while the chat's current model is the one the unlock was for. */
  confirmedModelSelected: (modelLabel: string): string =>
    `${modelLabel} is selected. Send your message again.`,
  dismissConfirmation: 'Dismiss unlock confirmation',
} as const;

/**
 * A locked model row's visible cue, by access value, in the trailing slot
 * where an unlocked row's `AI Credits` tag sits (docs/design/interaction.md,
 * Picker cues). Each names the action activating the row starts, in the
 * purchase labels' words (docs/ux-writing/labels.md#ai-credits-purchases),
 * so a locked row never reads like a usable one. The longer
 * {@link MODEL_LIBRARY_UNLOCK_HINTS} stay in the row's details: "Unlock by
 * buying AI Credits" would crowd the model name in the default 304px picker.
 */
export const MODEL_LIBRARY_UNLOCK_LABELS: Readonly<
  Record<LockedModelLibraryAccess, string>
> = {
  needs_sign_in: MODEL_LIBRARY_UNLOCK_COPY.signInAction,
  needs_sign_in_then_purchase:
    MODEL_LIBRARY_UNLOCK_COPY.signInThenPurchaseLabel,
  needs_purchase: MODEL_LIBRARY_UNLOCK_COPY.purchaseAction,
};

/**
 * The purchase dialog title: names the model being unlocked, or falls back to
 * the generic title when no display label is known.
 */
export function modelLibraryUnlockTitle(modelLabel?: string): string {
  const label = modelLabel?.trim();
  return label ? `Unlock ${label}` : MODEL_LIBRARY_UNLOCK_COPY.title;
}

/**
 * The recovery dialog's line while checkout is open in the browser. Says that
 * Close does not cancel, and names the model only when the host knows it; an
 * unknown model gets the generic unlock rather than a raw ID.
 */
export function modelLibraryWaitingInBrowserBody(modelLabel?: string): string {
  return modelLabel === undefined
    ? `${AI_CREDITS_HANDOFF_COPY.waiting.title}. Closing this dialog won't cancel your purchase. We'll unlock advanced models once the payment goes through.`
    : `${AI_CREDITS_HANDOFF_COPY.waiting.title}. Closing this dialog won't cancel your purchase. We'll switch to ${modelLabel} in the chat where you started the purchase once the payment goes through.`;
}

/** The composer notice's line while the purchase is pending. */
export function modelLibraryPendingBody(modelLabel?: string): string {
  return modelLabel === undefined
    ? "We'll unlock advanced models once the payment goes through."
    : `We'll switch to ${modelLabel} once the payment goes through.`;
}

// ---------------------------------------------------------------------------
// The table: reason × audience
// ---------------------------------------------------------------------------

/**
 * Why a prompt asks about AI Credits. Mirrors `CreditsPromptReason` in
 * `@canopy/app-state`, which this display package can't import; a resolved
 * prompt's `reason` is assignable to it, so a new reason fails the hosts'
 * typecheck until it has copy here.
 */
export type CreditsCopyReason =
  | 'out_of_credits'
  | 'quota_limit'
  | 'no_billing_source'
  | 'model_locked'
  | 'queued_held'
  | 'own_key_limit'
  | 'top_up';

/** Who a prompt is for. Mirrors `CreditsPromptAudience` in `@canopy/app-state`. */
export type CreditsCopyAudience = 'buyer' | 'guest' | 'org-member' | 'unknown';

/** What one reason says to one audience. */
export interface CreditsPromptCopy {
  /**
   * The action that starts a purchase, or `null` when this audience can't
   * start one here. Shown only when the resolved prompt offers it.
   */
  readonly action: string | null;
  /**
   * The message when the host has none of its own. Absent where every host
   * writes its own line (a usage limit names its provider and reset).
   */
  readonly message?: string;
}

/**
 * The own-key compute cap's sentence (CAN-7502): free compute for a person's
 * own keys is monthly, and only credits pay past it.
 */
export const OWN_KEY_LIMIT_COPY =
  "This month's free compute for your own keys is used up.";

/** The cap's sentence with the day it resets, as the host formats it. */
export function ownKeyLimitMessage(resetDay: string | null): string {
  return resetDay === null
    ? OWN_KEY_LIMIT_COPY
    : `${OWN_KEY_LIMIT_COPY} It resets on ${resetDay}.`;
}

const BUYER: CreditsPromptCopy = { action: AI_CREDITS_PURCHASE_LABEL };
const GUEST: CreditsPromptCopy = { action: AI_CREDITS_GUEST_PURCHASE_LABEL };
/** The contact-admin line is the notice's own, beside any message. */
const ORG_MEMBER: CreditsPromptCopy = { action: null };

const CREDITS_PROMPT_COPY: Readonly<
  Record<
    CreditsCopyReason,
    Readonly<Record<CreditsCopyAudience, CreditsPromptCopy>>
  >
> = {
  out_of_credits: {
    buyer: BUYER,
    guest: GUEST,
    'org-member': ORG_MEMBER,
    unknown: BUYER,
  },
  quota_limit: {
    buyer: BUYER,
    guest: GUEST,
    'org-member': ORG_MEMBER,
    unknown: BUYER,
  },
  no_billing_source: {
    buyer: BUYER,
    guest: GUEST,
    'org-member': ORG_MEMBER,
    unknown: BUYER,
  },
  model_locked: {
    buyer: { ...BUYER, message: MODEL_LIBRARY_UNLOCK_COPY.purchaseBody },
    guest: { ...GUEST, message: MODEL_LIBRARY_UNLOCK_COPY.guestBody },
    // A personal purchase would not unlock the organization's work.
    'org-member': { action: null, message: CONTACT_ORG_ADMIN_COPY },
    unknown: { ...BUYER, message: MODEL_LIBRARY_UNLOCK_COPY.purchaseBody },
  },
  // The line names no button: a held message's notice may carry none
  // (CAN-6860). `CreditsNotice` names Choose provider when it shows one.
  queued_held: {
    buyer: { ...BUYER, message: QUEUED_MESSAGE_WAITING_COPY },
    guest: { ...GUEST, message: QUEUED_MESSAGE_WAITING_COPY },
    'org-member': { action: null, message: QUEUED_MESSAGE_ORG_WAITING_COPY },
    unknown: { ...BUYER, message: QUEUED_MESSAGE_WAITING_COPY },
  },
  // The cap gets one sentence and the purchase; the host adds the reset day.
  own_key_limit: {
    buyer: { ...BUYER, message: OWN_KEY_LIMIT_COPY },
    guest: { ...GUEST, message: OWN_KEY_LIMIT_COPY },
    'org-member': { action: null, message: OWN_KEY_LIMIT_COPY },
    unknown: { ...BUYER, message: OWN_KEY_LIMIT_COPY },
  },
  top_up: {
    buyer: BUYER,
    guest: GUEST,
    'org-member': ORG_MEMBER,
    unknown: BUYER,
  },
};

/** What a prompt for `reason` says to `audience`; see the module comment. */
export function creditsPromptCopy(
  reason: CreditsCopyReason,
  audience: CreditsCopyAudience,
): CreditsPromptCopy {
  return CREDITS_PROMPT_COPY[reason][audience];
}

/** Approved recovery copy; hosts express connection capability through actions. */
export function outOfAiCreditsCopy(
  canConnectClaude: boolean,
  orgPoolUnavailable = false,
): { title: string; message: string } {
  return {
    title: APP_ERROR_CATALOG['external.ai_credits_required'].copy.title,
    message: orgPoolUnavailable
      ? canConnectClaude
        ? "Your organization's credits aren't available. Buy your own, connect Claude, or ask an org admin."
        : "Your organization's credits aren't available. Buy your own, or ask an org admin."
      : canConnectClaude
        ? 'Buy more, or connect Claude.'
        : // The notice's purchase button is the next step, so no message.
          '',
  };
}

// ---------------------------------------------------------------------------
// Web pre-send funding gate (CAN-7493)
// ---------------------------------------------------------------------------

/** The held-send row when the viewer's wallet owes a known amount. */
export function sendFundingShortfallMessage(owed: string): string {
  return `You're ${owed} short. ${AI_CREDITS_PURCHASE_LABEL} to send this.`;
}

/** A held send whose funding read failed. The draft stays in the composer. */
export const SEND_FUNDING_READ_FAILED_TITLE = "Couldn't check your credits";
export const SEND_FUNDING_READ_FAILED_MESSAGE = 'Your message is still here.';

/** A held send whose checkout closed with no payment. */
export const SEND_FUNDING_CHECKOUT_CLOSED_MESSAGE = `Your message is still here. ${AI_CREDITS_PURCHASE_LABEL} to send it.`;

/** A held send whose owner the viewer can't buy credits for. */
export const SEND_FUNDING_PURCHASE_UNAVAILABLE_MESSAGE =
  "Buying credits isn't available right now.";

/**
 * The desktop app as the other way to keep going: the secondary action on a
 * web credits notice and the subscription rows of web's provider list, which
 * only the desktop app can connect.
 */
export const DESKTOP_APP_ALTERNATIVE_LABEL = 'Use the desktop app';
