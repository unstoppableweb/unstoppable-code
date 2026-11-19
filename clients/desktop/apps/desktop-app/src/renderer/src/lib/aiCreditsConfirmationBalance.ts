import type { CreditsBalanceReading } from '@canopy/app-state/billing/credits';
import { resolveAiCreditsFundingSource } from '@canopy/desktop-shared/lib/ai-credits-funding';
import type {
  AiCreditsScopeRequest,
  CanopyCloudAiCreditsState,
} from '@canopy/desktop-shared/types';

/**
 * One balance read behind a post-purchase confirmation: the unlock notice
 * (CAN-5027) and the usage-limit arrival notice (CAN-5160). Each flow keeps
 * its own retry, budget, and completion policy; this owns only the request
 * and how a response classifies.
 *
 * - `usable`: a finite, positive personal balance, in `credits`.
 * - `definitive`: pool metadata. Never describe it as the buyer's wallet.
 * - `retry`: no read, a failed read, or nothing usable yet.
 *
 * `response` is the raw answer when one arrived, so a caller can apply a
 * stricter policy (such as a zero baseline) of its own.
 */
export type AiCreditsConfirmationBalanceOutcome =
  | 'usable'
  | 'definitive'
  | 'retry';

export interface AiCreditsConfirmationBalanceRead {
  readonly outcome: AiCreditsConfirmationBalanceOutcome;
  readonly credits: number | null;
  readonly response: CanopyCloudAiCreditsState | null;
}

export type AiCreditsConfirmationBalanceLoader = (
  scope: AiCreditsScopeRequest,
) => Promise<CanopyCloudAiCreditsState>;

/** The balance bridge, when this build exposes it. */
export function aiCreditsConfirmationBalanceLoader(): AiCreditsConfirmationBalanceLoader | null {
  const load = window.api?.loadCanopyCloudAiCredits;
  return typeof load === 'function' ? load : null;
}

export function classifyAiCreditsConfirmationBalance(
  response: CanopyCloudAiCreditsState,
): AiCreditsConfirmationBalanceRead {
  const retry = { outcome: 'retry', credits: null, response } as const;
  if (!response.connected || response.noUdAccount) return retry;
  if (response.error !== null || response.balance === null) return retry;
  // Pool metadata is definitive even if an older server also supplies a
  // positive number. Never describe it as the buyer's personal wallet.
  if (
    response.balance.orgPool ||
    response.balance.orgFundingAvailable === true
  ) {
    return { outcome: 'definitive', credits: null, response };
  }
  const funding = resolveAiCreditsFundingSource(response);
  if (funding.kind !== 'personal' || !Number.isFinite(funding.credits)) {
    return retry;
  }
  return { outcome: 'usable', credits: funding.credits, response };
}

/** Read and classify once. A thrown or rejected read is a `retry`. */
export async function readAiCreditsConfirmationBalance(
  load: AiCreditsConfirmationBalanceLoader,
  scope: AiCreditsScopeRequest,
): Promise<AiCreditsConfirmationBalanceRead> {
  try {
    return classifyAiCreditsConfirmationBalance(await load(scope));
  } catch {
    return { outcome: 'retry', credits: null, response: null };
  }
}

/**
 * A comparable reading of the buyer's own wallet. `personalBalanceReading`
 * answers `null` for anything that is not a personal balance, including a
 * zero one behind pool metadata. Unlike `usable`, a zero balance is a
 * reading: it is the usual starting point of a first purchase.
 */
export type PersonalBalanceReading = CreditsBalanceReading;

export function personalBalanceReading(
  response: CanopyCloudAiCreditsState | null,
): PersonalBalanceReading | null {
  if (response === null) return null;
  if (!response.connected || response.noUdAccount || response.error !== null)
    return null;
  const { balance } = response;
  if (balance === null) return null;
  // Pool metadata means this field cannot be read as the buyer's own wallet
  // funding this chat, whatever its sign.
  if (
    (balance.orgPool ?? null) !== null ||
    balance.orgFundingAvailable === true
  )
    return null;
  if (typeof balance.credits !== 'number' || !Number.isFinite(balance.credits))
    return null;
  return {
    credits: balance.credits,
    source: balance.source,
    email: balance.email,
  };
}
