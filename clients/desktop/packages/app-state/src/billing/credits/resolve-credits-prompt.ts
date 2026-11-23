import type { CreditsPurchaseMode } from './openers';
import type { CreditsCheckFeedbackKind } from './types';

/**
 * Why a surface is asking about AI Credits.
 *
 * - `out_of_credits`: a turn could not be paid for (the No billing source
 *   notice, a credit refusal in the transcript, the web recovery notice).
 * - `quota_limit`: a provider usage limit, with credits as the way past it.
 * - `no_billing_source`: nothing this chat can run has a billing source.
 * - `model_locked`: an advanced model needs a purchase (or sign-in) first.
 * - `queued_held`: a queued message waits on credits.
 * - `own_key_limit`: a send on the person's own key or gateway at 0 credits,
 *   past this month's own-key compute allowance (CAN-7502). Only credits can
 *   pay now, so it offers the purchase and no provider choice.
 */
export type CreditsPromptCondition =
  | 'out_of_credits'
  | 'quota_limit'
  | 'no_billing_source'
  | 'model_locked'
  | 'queued_held'
  | 'own_key_limit';

/**
 * Why a prompt is resolved: one of the {@link CreditsPromptCondition}s, or
 * `top_up`, a balance surface offering its wallet a purchase with nothing
 * gone wrong (the billing wallet and pool cards).
 */
export type CreditsPromptReason = CreditsPromptCondition | 'top_up';

/**
 * Who is looking. `guest` covers a guest credential and no credential at
 * all: neither can buy before signing in. `unknown` is an account that
 * could not be read.
 */
export type CreditsPromptViewer = 'guest' | 'signed-in' | 'unknown';

/** Who pays for the work, from the work's owner and the viewer's role. */
export type CreditsPromptOwner =
  | { readonly kind: 'personal' }
  | {
      readonly kind: 'organization';
      /** Only the organization's owner can fund its pool. */
      readonly canFund: boolean;
      /**
       * The organization carries the credit-pool capability, so its members
       * spend its pool rather than their own balance.
       */
      readonly creditPool: boolean;
    }
  /** The owner read did not resolve or was inconclusive. */
  | { readonly kind: 'unknown' };

export interface CreditsPromptState {
  /** The billing rollout is on for this viewer. */
  readonly billingEnabled: boolean;
  readonly viewer: CreditsPromptViewer;
  readonly owner: CreditsPromptOwner;
  readonly condition: CreditsPromptReason;
  readonly purchaseMode: CreditsPurchaseMode;
  /** A purchase for this wallet is already in progress. */
  readonly pending: boolean;
  /** The last Check again verdict of the pending purchase, if any. */
  readonly pendingFeedback?: CreditsCheckFeedbackKind | null;
  /**
   * Offer the purchase even though the owner read was inconclusive, for a
   * surface whose prompt exists BECAUSE that read failed and has no other
   * action (desktop's No billing source fallback).
   */
  readonly purchaseOnUnknownOwner?: boolean;
}

/** Who the prompt is for. */
export type CreditsPromptAudience =
  /** Can buy for this wallet. */
  | 'buyer'
  /** Must sign in before buying. */
  | 'guest'
  /** An organization member who cannot fund its pool. */
  | 'org-member'
  /** The account or owner could not be established. */
  | 'unknown';

/** One action a prompt offers. */
export type CreditsPromptAction =
  | 'buy'
  | 'sign-in'
  | 'check-again'
  | 'reopen-billing'
  | 'contact-admin'
  | 'retry-queued'
  | 'none';

export interface CreditsPrompt {
  readonly reason: CreditsPromptReason;
  readonly audience: CreditsPromptAudience;
  /** A purchase can start from here, now or once a pending one ends. */
  readonly canPurchase: boolean;
  readonly pending: boolean;
  readonly primary: CreditsPromptAction;
  readonly secondary?: CreditsPromptAction;
}

function prompt(
  state: CreditsPromptState,
  audience: CreditsPromptAudience,
  canPurchase: boolean,
  primary: CreditsPromptAction,
  secondary?: CreditsPromptAction,
): CreditsPrompt {
  return {
    reason: state.condition,
    audience,
    canPurchase,
    pending: state.pending && canPurchase,
    primary,
    ...(secondary !== undefined ? { secondary } : {}),
  };
}

/**
 * The one decision every AI Credits prompt makes: who it is for, whether a
 * purchase can start, and which actions it offers. Pure; each host supplies
 * the facts it already reads and renders the result in its own placement.
 *
 * The rules, in order, and where each comes from:
 *
 * 1. A guest signs in first and never sees the bare purchase action
 *    (`AI_CREDITS_GUEST_PURCHASE_LABEL`; desktop routes every purchase
 *    through the connect gate, `useGetAiCreditsAction` / `unlockModels`).
 *    Only while billing is on: signing in to buy what can't be bought is a
 *    dead end.
 * 2. Billing off, or a host that cannot take a purchase, offers no purchase
 *    (web `projectCloudCreditRecovery(…, billingEnabled && canFundOwner)`).
 * 3. An unreadable account or owner offers nothing: a failed read is not
 *    evidence of an empty wallet (`resolveAiCreditsCoverage(null)`), unless
 *    the surface exists because that read failed
 *    (`handoffOnInconclusiveRead`).
 * 4. An organization member who can't fund a pooled organization contacts
 *    the admin instead (`showContactAdmin`, `CONTACT_ORG_ADMIN_COPY`). For a
 *    locked model any organization owner the viewer can't fund contacts the
 *    admin, pooled or not (`openUnlockCheckout`'s `canFundOrganization`).
 *    A member of an organization without a pool buys personal credits.
 * 5. A purchase already in progress offers Check again instead of a second
 *    checkout, and Reopen billing except after a failed check
 *    (`GetAiCreditsCta`'s hand-off state, CAN-5534 / CAN-5162). An inline
 *    checkout has no browser to return from, so its pending state keeps the
 *    purchase action.
 * 6. A queued message offers Try again beside the purchase
 *    (`QUEUED_MESSAGE_RETAINED_COPY`).
 */
export function resolveCreditsPrompt(state: CreditsPromptState): CreditsPrompt {
  if (state.viewer === 'guest') {
    return state.billingEnabled && state.purchaseMode !== 'unavailable'
      ? prompt(state, 'guest', false, 'sign-in')
      : prompt(state, 'guest', false, 'none');
  }
  if (state.viewer === 'unknown') {
    return prompt(state, 'unknown', false, 'none');
  }
  const { owner } = state;
  if (owner.kind === 'organization' && !owner.canFund) {
    if (owner.creditPool || state.condition === 'model_locked') {
      return prompt(state, 'org-member', false, 'contact-admin');
    }
  }
  if (!state.billingEnabled || state.purchaseMode === 'unavailable') {
    return prompt(
      state,
      owner.kind === 'unknown' ? 'unknown' : 'buyer',
      false,
      'none',
    );
  }
  if (owner.kind === 'unknown' && state.purchaseOnUnknownOwner !== true) {
    return prompt(state, 'unknown', false, 'none');
  }
  const audience: CreditsPromptAudience =
    owner.kind === 'unknown' ? 'unknown' : 'buyer';
  if (state.pending && state.purchaseMode === 'handoff') {
    return state.pendingFeedback === 'check-failed'
      ? prompt(state, audience, true, 'check-again')
      : prompt(state, audience, true, 'check-again', 'reopen-billing');
  }
  if (state.condition === 'queued_held') {
    return prompt(state, audience, true, 'buy', 'retry-queued');
  }
  return prompt(state, audience, true, 'buy');
}
