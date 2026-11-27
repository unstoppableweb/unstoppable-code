import type { AiCreditsBalance, WorkOwner } from '@canopy/protocol/llm-gateway';
import type { CanopyCloudAiCreditsState } from '../types';

/** Fail closed against an older server that reports another org's pool. */
export function scopeAiCreditsBalanceToWorkOwner(
  balance: AiCreditsBalance,
  owner: WorkOwner | undefined,
): AiCreditsBalance {
  if (
    owner?.kind !== 'organization' ||
    balance.orgPool?.orgId !== owner.organizationId
  ) {
    return {
      ...balance,
      eligible: balance.credits > 0,
      orgPool: null,
      orgFundingAvailable: false,
    };
  }
  return balance;
}

/**
 * Who is actually paying for the current AI-Credits session.
 *
 * Returns data, not copy: no user-visible strings live here, so formatting stays
 * at the single rendering site and this file stays off the shared user-facing
 * branding scan.
 *
 * The "never show `0 credits`" invariant is structural rather than a rendering
 * convention: `personal` only exists when `credits > 0`, so no JSX branch can
 * reach a zero personal balance.
 */
export type AiCreditsFundingSource =
  | { kind: 'personal'; credits: number }
  | { kind: 'org-pool'; orgName: string }
  /**
   * Connected with no error, a numeric personal balance at or below 0 and no
   * org pool: nothing can pay. Readers must not claim the session is "paid
   * with AI Credits" for this kind. Carries no number, so the "never show
   * `0 credits`" invariant still holds.
   */
  | { kind: 'empty' }
  | { kind: 'unknown' };

/**
 * Resolve which source funds this session from the AI-credits state the banner,
 * the sidebar and the Usage card already load — no new IPC, no per-org fan-out.
 *
 * Rules, in order:
 * - No state / not connected / transient error / no UD account / null balance →
 *   `unknown` (nothing trustworthy to say).
 * - Personal wallet has credits → `personal`.
 * - Personal wallet is empty but the server named the org pool the gateway would
 *   debit next → `org-pool`.
 * - A numeric personal balance at or below 0 with no org pool → `empty`.
 * - Otherwise → `unknown`. Note `orgPool` is optional on the wire (older servers
 *   omit it), so a missing value is treated exactly like an absent pool.
 */
export function resolveAiCreditsFundingSource(
  state: CanopyCloudAiCreditsState | null,
): AiCreditsFundingSource {
  if (!state || !state.connected || state.noUdAccount || state.error) {
    return { kind: 'unknown' };
  }
  const balance = state.balance;
  if (!balance) {
    return { kind: 'unknown' };
  }
  const credits = balance.credits;
  if (typeof credits === 'number' && credits > 0) {
    return { kind: 'personal', credits };
  }
  const orgName = balance.orgPool?.orgName;
  if (typeof orgName === 'string' && orgName.length > 0) {
    return { kind: 'org-pool', orgName };
  }
  if (typeof credits === 'number' && !balance.orgPool) {
    return { kind: 'empty' };
  }
  return { kind: 'unknown' };
}
