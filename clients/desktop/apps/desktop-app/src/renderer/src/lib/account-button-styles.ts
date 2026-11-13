/**
 * Shared styling for the account settings tiles (Claude / Codex / Cursor /
 * GitHub / Canopy Cloud / Unstoppable Domains): the tile surface and its three
 * button weights, so the primary tile action (Change account / Login / Manage
 * / Connect) never reads the same as a secondary/destructive action
 * (Disconnect) or a neutral one (Cancel).
 *
 * All buttons are the same compact size (`px-3 py-1 text-xs`) so they align
 * cleanly; the weight difference is fill vs. outline + text color.
 */

/** The account tile surface every provider card sits in. */
export const ACCOUNT_CARD_CLASS = 'rounded-lg border bg-card p-5';

/**
 * Primary tile action: a filled secondary-surface button — the prominent CTA
 * (Change account / Login / Manage / Connect / Set up).
 */
export const ACCOUNT_BUTTON_PRIMARY =
  'rounded-md border bg-secondary px-3 py-1 text-xs font-medium fg-primary transition-colors hover:bg-accent-subtle hover:fg-accent-strong disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Secondary / destructive tile action (Disconnect): a quiet outline button with
 * muted text that turns destructive on hover. Reads as a real button but never
 * competes with the primary CTA.
 */
export const ACCOUNT_BUTTON_SECONDARY =
  'rounded-md border px-3 py-1 text-xs font-medium fg-secondary transition-colors hover:border-line-destructive hover:fg-destructive disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Neutral tile action (Cancel): an outline button in primary ink that neither
 * competes with the primary CTA nor hints at a destructive outcome.
 */
export const ACCOUNT_BUTTON_QUIET =
  'rounded-md border px-3 py-1 text-xs font-medium fg-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60';
