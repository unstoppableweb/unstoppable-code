/**
 * CAN-4764 — the in-chat out-of-credits recovery copy, shared by the desktop
 * no-billing-source banner and the web cloud credit recovery notice. Each
 * host keeps choosing which arm applies; only the words live here.
 *
 * The credit term's casing differs per host on purpose ("AI Credits" on
 * desktop, "AI credits" on web), so each string keeps the casing its host
 * shows today.
 */

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
  'Contact your org admin to increase your spend quota.';

/** The title while a queued message waits on credits. */
export const MESSAGE_QUEUED_TITLE = 'Message queued';

/** The message while a queued message waits on credits. */
export const QUEUED_MESSAGE_RETAINED_COPY =
  'Your queued message is still saved. Add credits, then click Try again.';

/** Saved queue status while the account needs credits. */
export const CREDIT_HELD_MESSAGE_WARNING_COPY =
  'Your queued message is still saved. Add credits to continue.';

/** The web recovery notice's title. */
export const OUT_OF_CREDITS_TITLE = "You're out of AI credits";

/** What happened to the user's message, so they know nothing was lost. */
export function retainedMessageCopy(
  origin: 'composer' | 'queue' | 'create',
): string {
  if (origin === 'queue') {
    return QUEUED_MESSAGE_RETAINED_COPY;
  }
  if (origin === 'create') {
    return 'Nothing was sent. Add credits, then try again.';
  }
  return 'Your message is still in the composer. Add credits, then send it again.';
}

/**
 * CAN-4769 — web chat is paid-only, so the recovery notice and the signed-out
 * entry name the two ways to keep going: buy credits, or bring a Claude or
 * ChatGPT subscription to the desktop app. Split so the host renders "desktop
 * app" as a link. `leadWithoutPurchase` is for someone who cannot buy, so the
 * line never tells them to.
 */
export const PAID_ACCESS_ALTERNATIVE_COPY = {
  lead: 'Buy credits, or use the ',
  leadWithoutPurchase: 'Or use the ',
  link: 'desktop app',
  tail: ' with your Claude or ChatGPT subscription.',
} as const;

/** The organization's model policy allows nothing the user can run. */
export const POLICY_ONLY_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: 'No model available',
  message: `Your organization's model policy doesn't allow any model you can run right now, so ask your organization admin to allow a model you can use.`,
};

/** The organization only allows models paid for with AI Credits. */
export function creditsOnlyDeadEndCopy(appName: string): CreditsRecoveryCopy {
  return {
    title: 'AI Credits required',
    message: `Your organization only allows models that require ${appName} AI Credits.`,
  };
}

/** Every model the organization allows needs a billing source. */
export const POLICY_BILLING_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: 'No model available',
  message: `Your organization's allowed models all need a billing source you don't have yet.`,
};

/** No available model can be paid for. */
export const DISPATCH_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: 'No billing source',
  message: 'No available model can be paid for right now.',
};

/** A turn already failed because AI Credits didn't cover it. */
export function failedTurnCopy(appName: string): CreditsRecoveryCopy {
  return {
    title: 'Message not sent',
    message: `Your ${appName} AI Credits didn't cover that message.`,
  };
}

/**
 * CAN-4766 — the action that connects a provider account, on every recovery
 * surface that offers it. It names only the current model's provider.
 */
export function connectProviderLabel(providerLabel: string): string {
  return `Connect ${providerLabel}`;
}

/** Before sending: no provider connected and no AI Credits to fall back on. */
export function notSignedInCopy({
  appName,
  providerLabel,
}: {
  readonly appName: string;
  readonly providerLabel: string;
}): CreditsRecoveryCopy {
  return {
    title: `Not connected to ${providerLabel}`,
    message: `You have no ${appName} AI Credits to cover this chat either.`,
  };
}
