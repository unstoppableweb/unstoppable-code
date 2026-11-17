/**
 * Copy for the first-run account row (CAN-4762, CAN-4765): the way into AI
 * Credits, shown to every user beside Claude and Codex. What it offers
 * before a state is known is `CREDITS_ROW_DESCRIPTION`, shared with the
 * Switch provider dialog. AI Credits are
 * bought, never granted, so nothing here says "free".
 */

/**
 * Shown once the account has spendable AI Credits, in the same shape as the
 * provider rows' ready sentence.
 */
export const FIRST_RUN_ACCOUNT_READY = 'AI Credits are ready in your chats.';

/** Shown while the host reads whether an account is signed in. */
export const FIRST_RUN_ACCOUNT_CHECKING = 'Checking sign-in…';

/** Who is signed in when the account has no email to show. */
export const FIRST_RUN_ACCOUNT_SIGNED_IN = 'Signed in';

/** The action for a guest or a user who is not signed in. It only signs in. */
export const FIRST_RUN_ACCOUNT_CONNECT_LABEL = 'Connect';

/** The action for a signed-in account with credits: sign in as someone else. */
export const FIRST_RUN_ACCOUNT_CHANGE_LABEL = 'Change account';

/** The account action while the browser sign-in is open. */
export const FIRST_RUN_ACCOUNT_WAITING_LABEL = 'Waiting for browser…';
