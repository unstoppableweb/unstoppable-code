/**
 * Host-neutral shapes the AI Credits purchase state works with. Each host's
 * own types (desktop's `AiCreditsScopeRequest`, `ChatBannerTarget`) are
 * structurally compatible, so a host passes its values straight through.
 */

/** The work an AI Credits read or purchase is about. */
export interface CreditsWorkScope {
  readonly kind: 'work';
  readonly projectId: string;
  readonly worktreeId?: string;
  readonly chatId?: string;
}

/** Owner context for a credits read: the navigation context, or a work item. */
export type CreditsScopeRequest =
  | { readonly kind: 'navigation' }
  | CreditsWorkScope;

/** One chat's complete work identity. */
export interface CreditsChatTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/** What the last explicit Check again concluded. */
export type CreditsCheckFeedbackKind = 'uncovered' | 'check-failed';

/**
 * A comparable reading of the buyer's own wallet: the balance plus the
 * source and email that make two readings comparable. A zero balance is a
 * reading: it is the usual starting point of a first purchase.
 */
export interface CreditsBalanceReading {
  readonly credits: number;
  readonly source: string;
  readonly email: string;
}

/** What an account re-read found. */
export type CreditsAccountIdentity =
  | { readonly kind: 'account'; readonly key: string }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unreadable' };

/**
 * Reads the saved account's identity. A rejection is a failed read. `null`
 * from the getter means this host cannot read the account at all.
 */
export type CreditsAccountIdentityReader =
  () => Promise<CreditsAccountIdentity>;
