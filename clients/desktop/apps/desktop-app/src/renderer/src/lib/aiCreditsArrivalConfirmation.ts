import {
  CREDITS_ARRIVAL_READ_OFFSETS_MS,
  CREDITS_ARRIVAL_READ_TIMEOUT_MS,
  createCreditsArrivalStore,
  selectCreditsArrivalEvidence,
  selectCreditsArrivalForChat,
  selectRoutedCreditsArrivalForChat,
  type CreditsArrival,
  type CreditsArrivalBalanceRead,
  type CreditsArrivalBalanceReader,
  type CreditsArrivalEvidence,
  type CreditsArrivalHandoff,
  type CreditsArrivalState,
} from '@canopy/app-state/billing/credits';
import type { AiCreditsScopeRequest } from '@canopy/desktop-shared/types';
import { desktopCreditsAccountIdentityReader } from '@/lib/aiCreditsAccountIdentity';
import {
  aiCreditsConfirmationBalanceLoader,
  personalBalanceReading,
  readAiCreditsConfirmationBalance,
  type AiCreditsConfirmationBalanceRead,
} from '@/lib/aiCreditsConfirmationBalance';
import type { ChatBannerTarget } from '@/stores/aiCreditsBannerStore';

/**
 * The arrival confirmation after credits bought from a chat banner: the
 * usage-limit banner or the No billing source banner (CAN-5160).
 *
 * This renderer's instance of the shared arrival store; its lifecycle rules
 * live with the store in `@canopy/app-state/billing/credits`. This module
 * binds the desktop's account and balance bridges and keeps the names the
 * chat surfaces use.
 */

/**
 * The surface whose Buy AI Credits click started the hand-off. `model-picker`
 * covers the picker's billing toggle and the recovery dialog it opens; they
 * have no notice of their own, so the No billing source banner, which every
 * composer mounts, confirms their purchases too.
 */
export type AiCreditsArrivalOrigin =
  | 'usage-limit'
  | 'no-billing-source'
  | 'model-picker';

export type AiCreditsArrival = CreditsArrival<AiCreditsArrivalOrigin>;
export type AiCreditsArrivalEvidence = CreditsArrivalEvidence;
export type AiCreditsArrivalHandoff = CreditsArrivalHandoff;
type AiCreditsArrivalState = CreditsArrivalState<AiCreditsArrivalOrigin>;

/** Read offsets from the first attempt's start. Never overlapping. */
export const AI_CREDITS_ARRIVAL_READ_OFFSETS_MS =
  CREDITS_ARRIVAL_READ_OFFSETS_MS;
/** A read that has not answered by then ends the budget. */
export const AI_CREDITS_ARRIVAL_READ_TIMEOUT_MS =
  CREDITS_ARRIVAL_READ_TIMEOUT_MS;

function arrivalBalanceRead(
  read: AiCreditsConfirmationBalanceRead,
): CreditsArrivalBalanceRead {
  return {
    outcome: read.outcome,
    reading: personalBalanceReading(read.response),
  };
}

/** The balance bridge, classified for the arrival's reads. */
function desktopArrivalBalanceReader(): CreditsArrivalBalanceReader | null {
  const load = aiCreditsConfirmationBalanceLoader();
  if (load === null) return null;
  return (scope): Promise<CreditsArrivalBalanceRead> =>
    readAiCreditsConfirmationBalance(load, scope).then(arrivalBalanceRead);
}

const arrivalStore = createCreditsArrivalStore<AiCreditsArrivalOrigin>({
  accountIdentityReader: desktopCreditsAccountIdentityReader,
  balanceReader: desktopArrivalBalanceReader,
});

export const useAiCreditsArrivalStore = arrivalStore.useStore;

/**
 * Start tracking a hand-off for a chat's work scope, reading the baseline
 * balance at once without waiting for it. Null for a scope with no chat, or
 * when this build cannot read the account.
 */
export function beginAiCreditsArrivalHandoff(
  scope: AiCreditsScopeRequest | undefined,
  origin: AiCreditsArrivalOrigin,
  purchaseScopeKey?: string,
): AiCreditsArrivalHandoff | null {
  return arrivalStore.beginHandoff(scope, origin, purchaseScopeKey);
}

/** Clear one record: dismissal, or a credit action the user took from it. */
export function clearAiCreditsArrival(handoffId: string): void {
  arrivalStore.clear(handoffId);
}

/** The banner routed this record's chat through credits. */
export function markAiCreditsArrivalRouted(handoffId: string): void {
  arrivalStore.markRouted(handoffId);
}

/** Retire this chat's confirmation before a user action, even while hidden. */
export function clearAiCreditsArrivalForChat(target: ChatBannerTarget): void {
  arrivalStore.clearForChat(target);
}

/** Hide account-bound state while identity is rechecked. */
export function suspendAiCreditsArrivalAccount(): void {
  arrivalStore.suspendAccount();
}

/** Bring records in line with the saved account. */
export function reconcileAiCreditsArrivalAccount(
  accountKey: string | null,
): void {
  arrivalStore.reconcileAccount(accountKey);
}

/** Whether an account change has anything here to reconcile. */
export function hasAiCreditsArrivalSession(): boolean {
  return arrivalStore.hasSession();
}

/** The unrouted record the notice shows for this chat and banner, or null. */
export function selectAiCreditsArrivalForChat(
  state: AiCreditsArrivalState,
  target: ChatBannerTarget | null,
  origin: AiCreditsArrivalOrigin | readonly AiCreditsArrivalOrigin[],
): AiCreditsArrival | null {
  return selectCreditsArrivalForChat(state, target, origin);
}

/** The routed record the card shows for this work identity, or null. */
export function selectRoutedAiCreditsArrivalForChat(
  state: AiCreditsArrivalState,
  target: ChatBannerTarget | null,
): AiCreditsArrival | null {
  return selectRoutedCreditsArrivalForChat(state, target);
}

/** The final evidence for exactly this record, or null while reading. */
export function selectAiCreditsArrivalEvidence(
  state: AiCreditsArrivalState,
  handoffId: string | undefined,
): AiCreditsArrivalEvidence | null {
  return selectCreditsArrivalEvidence(state, handoffId);
}
