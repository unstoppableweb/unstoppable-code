import {
  AI_CREDITS_GUEST_PURCHASE_LABEL,
  MODEL_LIBRARY_UNLOCK_COPY,
} from './creditsPromptCopy';

/**
 * The reassurance clause guest-facing sign-in prompts close on: nothing
 * already built is at risk. Shared so the desktop prompts and the guest model
 * gate on every host say it the same way.
 */
export const GUEST_WORK_PRESERVED_COPY =
  'Your guest work comes with you, nothing is lost.';

export interface GuestModelGateCopyInput {
  /** Display label of the gated model the guest picked. */
  readonly modelLabel: string;
  /**
   * Product name, resolved by the host at call time. The copy no longer
   * names the product (CAN-7493); the field stays while hosts still pass it.
   */
  readonly appName: string;
  /** Defaults to `needs_sign_in`. */
  readonly access?: 'needs_sign_in' | 'needs_sign_in_then_purchase';
  /**
   * Allowlist label of a guest model the host can select right now.
   *
   * Pass it only when the host also renders a working action for it: the
   * body's "right now" sentence and the fallback action are derived from this
   * one value so neither can appear without the other.
   */
  readonly fallbackLabel?: string;
  /**
   * CAN-4769 — web chat is paid-only, so the web gate also names the desktop
   * app with the visitor's own subscription. Desktop omits it.
   */
  readonly subscriptionAlternative?: boolean;
}

/** The sentence `subscriptionAlternative` appends to the gate body. */
export const GUEST_MODEL_GATE_SUBSCRIPTION_ALTERNATIVE_COPY =
  'Or use the desktop app with your Claude or ChatGPT subscription.';

export interface GuestModelGateCopy {
  readonly title: string;
  readonly body: string;
  readonly signInAction: string;
  /** Present exactly when a fallback label was supplied. */
  readonly fallbackAction?: string;
}

/**
 * CAN-4703 — copy for the guest model gate.
 *
 * The plain gate says the model needs an account and, when the host can
 * select one, names the guest model available right now. The purchase variant
 * names both requirements up front, because signing in alone does not unlock
 * that model, and its action says the guest signs in to buy: hosts route it
 * through sign-in straight to checkout. It may still offer a guest model that
 * is usable right now.
 *
 * The gate never says "free" (CAN-7493): beside a model it reads as a promise
 * about usage, and web chats use AI Credits. It also never names the product,
 * which avoids a/an errors with brand names.
 */
export function guestModelGateCopy({
  modelLabel,
  access = 'needs_sign_in',
  fallbackLabel,
  subscriptionAlternative = false,
}: GuestModelGateCopyInput): GuestModelGateCopy {
  const withAlternative = (body: string): string =>
    subscriptionAlternative
      ? `${body} ${GUEST_MODEL_GATE_SUBSCRIPTION_ALTERNATIVE_COPY}`
      : body;
  // The sentence and the action come from one value, so neither can appear
  // without the other.
  const fallback =
    fallbackLabel === undefined
      ? undefined
      : {
          sentence: `As a guest you can use ${fallbackLabel} right now.`,
          action: `Use ${fallbackLabel}`,
        };
  const withFallback =
    fallback === undefined ? {} : { fallbackAction: fallback.action };
  const fallbackSentence = fallback?.sentence;

  if (access === 'needs_sign_in_then_purchase') {
    const requirement = `Using ${modelLabel} requires an account and a purchase of AI Credits.`;
    return {
      title: MODEL_LIBRARY_UNLOCK_COPY.title,
      body: withAlternative(
        fallbackSentence === undefined
          ? requirement
          : `${requirement} ${fallbackSentence}`,
      ),
      signInAction: AI_CREDITS_GUEST_PURCHASE_LABEL,
      ...withFallback,
    };
  }

  const accountSentence = `${modelLabel} needs an account.`;
  return {
    title: `Sign in to use ${modelLabel}`,
    body: withAlternative(
      fallbackSentence === undefined
        ? `${accountSentence} ${GUEST_WORK_PRESERVED_COPY}`
        : `${accountSentence} ${fallbackSentence}`,
    ),
    signInAction: `Sign in to use ${modelLabel}`,
    ...withFallback,
  };
}
