/**
 * Shared copy for the guest sign-in CTAs.
 *
 * The sidebar guest pill, the account-menu sign-in row, and the cloud-connect
 * gate title all render the same short label, and the two long-form blurbs are
 * the only places the benefit is spelled out. They were hand-maintained
 * literals in four files and had already drifted apart; keeping them here is
 * what stops that from happening again.
 *
 * Tone rule for anything added here: lead with the outcome the guest gets, not
 * the name of the feature that delivers it. A capability name means nothing to
 * someone who has never seen the capability, and "sync" on its own is an
 * undifferentiated safety benefit every tool claims.
 *
 * Second tone rule, learned from the subtitle that used to live here ("Your 5
 * free AI credits are already available."): never state a perk as something the
 * guest has ALREADY been given. On a conversion surface that is an argument
 * against converting. State it as what the account keeps giving them. (The
 * daily free AI Credits used to be that row in `DEFAULT_CLOUD_AUTH_BENEFITS`;
 * the row is gone because free daily credits are no longer offered (CAN-4762
 * onward), so signing in does not deliver them.)
 *
 * Third tone rule, and the expensive one: the perk named here must be something
 * the guest does not already have. An earlier version of the sign-in label
 * offered free Codex, which a guest can already get on any funded ledger
 * (leftover or purchased credits) — `loadAiCreditsRoutingContext` has no guest
 * exclusion, and the OpenAI forward route admits on a funded ledger with no
 * `isAnonymous` check. Free daily credits are no longer offered to guests or
 * signed-in free accounts (CAN-4762 onward), so signing in grants no credits
 * either. A CTA that asks
 * for a signup in exchange for something the reader already has is worse than
 * a vague one. Check the gate before writing the promise.
 */

import { GUEST_WORK_PRESERVED_COPY } from '@canopy/ui-shared';
import { brandText } from './brand';

/**
 * Short label shared by the sidebar guest pill, the account-menu sign-in row,
 * and the title of the cloud-connect gate those two open. Same on every brand.
 *
 * Deliberately general. Per the tone rules above it must not promise a perk a
 * guest already has, and a brand-specific promise (the mobile app) would be
 * wrong for builds that ship none.
 *
 * Both surfaces render it in a fixed-height single-line row that truncates, so
 * keep any replacement short: the sidebar pill has ~164px for the label at the
 * 220px minimum sidebar width, and the account menu has ~176px at
 * its current `w-56`. The menu's budget is the binding one — that dropdown is a
 * fixed width and does not grow with the sidebar, so a label that overflows it
 * is elided for every user, at every window size, forever.
 *
 * This label is also the accessible name of both controls, so an elided one is
 * not merely ugly: a voice-control user cannot speak a label they cannot read
 * in full (WCAG 2.5.3, Label in Name). `guest-sign-in-cta-fit.spec.mjs` asserts
 * it fits; run it after changing this string.
 */
export const GUEST_SIGN_IN_CTA_LABEL: string = 'Sign in for more';

/**
 * The reassurance clause every guest-facing sign-in prompt closes on: nothing
 * already built is at risk.
 *
 * Shared because it is the one sentence that appears verbatim across four
 * surfaces — the Remote Control pairing card, the sign-in gate that card opens,
 * `ShareAgentModal`, and `ShareAutomationModal` — and four hand-maintained
 * copies are precisely the drift this module exists to prevent. All four
 * compose from here; a partial extraction would be worse than none, because
 * editing this constant would silently desynchronize the holdouts while
 * creating the appearance of single-sourcing.
 *
 * The guest model gate closes on it too, on every host, which is why the
 * sentence itself lives in `@canopy/ui-shared`.
 *
 * {@link GUEST_UPGRADE_NUDGE_BODY} closes on a shorter "Your guest work comes
 * with you." so the nudge banner stays brief; it carries the same promise.
 */
export const GUEST_WORK_PRESERVED: string = GUEST_WORK_PRESERVED_COPY;

/**
 * Body of the motivated-moment upgrade nudge shown to a consented guest after
 * they have gotten value from the app. Names the outcome (reaching your agents
 * from another device) rather than the feature that provides it, and closes by
 * reassuring that guest work is not at risk.
 *
 * It says nothing about free AI Credits. It used to claim "Your free AI Credits
 * already work", which stopped being true once free daily credits were no
 * longer offered (CAN-4762 onward), and per the second tone rule a perk the
 * guest already has is an argument against signing in anyway.
 */
export const GUEST_UPGRADE_NUDGE_BODY: string =
  'Sign in to sync your work across devices, and check on your agents from your phone or any browser. Your guest work comes with you.';

// ---------------------------------------------------------------------------
// CAN-3026 — the guest model gate.
//
// A guest may only run the cheap allowlisted models (`GUEST_ALLOWED_MODELS`)
// where Canopy pays for the inference. Picking anything else raises a sign-in
// prompt instead of committing the model.
//
// The gate's title, body, and actions are `guestModelGateCopy` in
// `@canopy/ui-shared` (CAN-4703), shared with the web gate. They say the
// model needs an account and, when the host can select one, name the guest
// model the user can run right now. They never say "free" (CAN-7493).
//
// Per the third tone rule above: this must NOT offer free AI Credits as the
// perk. Free daily credits are no longer offered to guests or signed-in
// accounts (CAN-4762 onward), so the thing the account actually unlocks here
// is the expensive hosted model itself — say that.
// ---------------------------------------------------------------------------

/**
 * Title of the shared cloud-connect gate opened from the guest model gate.
 * Matches `ShareRunModal`'s so the same modal never announces itself two ways.
 *
 * A FUNCTION, not a module-level const, for the same reason `brandText` exposes
 * getters: `brand.ts` re-evaluates the brand runtime lazily "so test setups
 * that swap the brand runtime module see the new values without import-order
 * surprises". Capturing `brandText.appName` at module evaluation defeated that
 * — it pinned whichever brand happened to be loaded when this module was first
 * imported, and forced consumers' tests to mock `brandText` purely to survive
 * the import. Every other export in this file already reads it at call time.
 */
export function guestModelGateTitle(): string {
  return `Sign in to ${brandText.appName} Cloud`;
}

/**
 * Success toast fired when the guest connects. Signing in closes the gate
 * immediately, so this is the only confirmation the user gets.
 */
export function guestModelGateToast(modelLabel: string): string {
  return `You're all set. ${modelLabel} is ready to use.`;
}
