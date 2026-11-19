import type { ChatTurnPhase } from '@canopy/protocol/remote-control/shell';
import type { PersistedChatTurnState } from '@canopy/agent-transcript/turn';

/** Receipt-time and durable canonical state are independent admission fences. */
export interface TurnCanonicalView {
  readonly generation: number;
  readonly state: PersistedChatTurnState;
}

/** The gate owns a host operation, not an independently classified provider turn. */
export interface TurnOwnershipRecord {
  readonly kind: 'dispatch' | 'stop';
  readonly token: symbol;
  readonly userMessageId?: string;
  readonly turnId?: string;
  readonly operationEpoch: number;
  readonly reason: 'awaiting-start' | 'awaiting-commit';
}

/** Retained even when a received start and end leave no current foreground. */
export interface TurnLifecycleOwnership {
  readonly turnId: string;
  readonly generation: number;
  readonly transition: 'start' | 'binding' | 'end';
  readonly inputIds: readonly string[];
}

export interface TurnAdmissionInputs {
  readonly knowledge: 'unknown' | 'loading' | 'known';
  readonly receipt?: TurnCanonicalView;
  readonly committed?: TurnCanonicalView;
  readonly unacknowledgedLifecycle: readonly TurnLifecycleOwnership[];
  readonly dispatchOwners: readonly TurnOwnershipRecord[];
  readonly stopOwners: readonly TurnOwnershipRecord[];
  /** Exempts only this host reservation, never canonical or lifecycle ownership. */
  readonly callerToken?: symbol;
}

export type TurnAdmissionBlocker =
  | { readonly kind: 'receipt-foreground'; readonly turnId: string }
  | { readonly kind: 'committed-foreground'; readonly turnId: string }
  | {
      readonly kind: 'unacknowledged-lifecycle';
      readonly ownership: TurnLifecycleOwnership;
    }
  | { readonly kind: 'dispatch' | 'stop'; readonly owner: TurnOwnershipRecord };

export type TurnAdmissionVerdict =
  | {
      readonly kind: 'allow';
      readonly receiptGeneration: number;
      readonly committedGeneration: number;
    }
  | { readonly kind: 'wait'; readonly reason: 'unknown' | 'loading' }
  | {
      readonly kind: 'blocked';
      readonly blockers: readonly TurnAdmissionBlocker[];
    };

/** A caller can exclude its reservation, never canonical provider ownership. */
export function evaluateTurnAdmission(
  inputs: TurnAdmissionInputs,
): TurnAdmissionVerdict {
  if (inputs.knowledge !== 'known') {
    return { kind: 'wait', reason: inputs.knowledge };
  }
  if (!inputs.receipt || !inputs.committed) {
    return { kind: 'wait', reason: 'unknown' };
  }
  const blockers: TurnAdmissionBlocker[] = [];
  if (inputs.receipt.state.current) {
    blockers.push({
      kind: 'receipt-foreground',
      turnId: inputs.receipt.state.current.id,
    });
  }
  if (inputs.committed.state.current) {
    blockers.push({
      kind: 'committed-foreground',
      turnId: inputs.committed.state.current.id,
    });
  }
  for (const ownership of inputs.unacknowledgedLifecycle) {
    blockers.push({ kind: 'unacknowledged-lifecycle', ownership });
  }
  for (const owner of inputs.dispatchOwners) {
    if (owner.token !== inputs.callerToken)
      blockers.push({ kind: 'dispatch', owner });
  }
  for (const owner of inputs.stopOwners) {
    if (owner.token !== inputs.callerToken)
      blockers.push({ kind: 'stop', owner });
  }
  return blockers.length > 0
    ? { kind: 'blocked', blockers }
    : {
        kind: 'allow',
        receiptGeneration: inputs.receipt.generation,
        committedGeneration: inputs.committed.generation,
      };
}

export function createTurnOwnershipRecord(
  input: Omit<TurnOwnershipRecord, 'reason'>,
): TurnOwnershipRecord {
  return {
    ...input,
    reason:
      input.kind === 'dispatch' && !input.turnId
        ? 'awaiting-start'
        : 'awaiting-commit',
  };
}

export function bindTurnOwnershipRecord(
  owner: TurnOwnershipRecord,
  turnId: string,
): TurnOwnershipRecord {
  return { ...owner, turnId, reason: 'awaiting-commit' };
}

/** Stale callbacks must match the captured token AND operation epoch. */
export function matchesTurnOwnershipRecord(
  owner: TurnOwnershipRecord,
  token: symbol,
  operationEpoch: number,
): boolean {
  return owner.token === token && owner.operationEpoch === operationEpoch;
}

export type ChatTurnReservation = {
  /**
   * `dispatch`: an admission is handing a prompt to the provider.
   * `stop`: Stop is unwinding and its untagged terminal releases the gate.
   */
  readonly kind: 'dispatch' | 'stop';
  readonly owner: symbol;
};

export interface ChatTurnPhaseInputs {
  hasActiveProviderTurn: boolean;
  hasPendingProviderContinuation: boolean;
  hasBackgroundWork: boolean;
  /**
   * The host queue gate is armed for a turn that has not delivered its
   * terminal. A provider can report idle while that turn is still open: before
   * it marks an accepted prompt active, while it waits on an approval or a
   * question, and before its result is committed. The gate covers all three.
   */
  hostGateArmed: boolean;
  reservation?: ChatTurnReservation;
}

export interface CodexTurnRecoveryInputs {
  readonly hostGateArmed: boolean;
  readonly turnUserMessageId?: string;
  readonly hasActiveProviderTurn: boolean;
  readonly hasPendingProviderContinuation: boolean;
  readonly hasPendingUserDecision: boolean;
  readonly dispatchInFlight: boolean;
  /** True only for a recovery operation other than the caller's own reservation. */
  readonly hasRecoveryInFlight: boolean;
  readonly hasReservation: boolean;
  readonly holdsTurn: boolean;
  readonly hasMatchingTerminal: boolean;
  readonly canonicalTurnOpen: boolean;
}

/** Whether an idle Codex harness turn gate still needs synthetic settlement. */
export function canRecoverCodexTurn(inputs: CodexTurnRecoveryInputs): boolean {
  return (
    inputs.hostGateArmed &&
    inputs.turnUserMessageId !== undefined &&
    !inputs.hasActiveProviderTurn &&
    !inputs.hasPendingProviderContinuation &&
    !inputs.hasPendingUserDecision &&
    !inputs.dispatchInFlight &&
    !inputs.hasRecoveryInFlight &&
    !inputs.hasReservation &&
    !inputs.holdsTurn &&
    !inputs.hasMatchingTerminal &&
    inputs.canonicalTurnOpen
  );
}

export function readChatTurnPhase(
  inputs: ChatTurnPhaseInputs,
  operationOwner?: symbol,
): { turnPhase: ChatTurnPhase; hasForegroundProviderWork: boolean } {
  const hasForegroundProviderWork =
    inputs.hasActiveProviderTurn || inputs.hasPendingProviderContinuation;
  const hasOtherOperationReservation =
    inputs.reservation !== undefined &&
    inputs.reservation.owner !== operationOwner;

  if (
    hasForegroundProviderWork ||
    hasOtherOperationReservation ||
    inputs.hostGateArmed
  ) {
    return { turnPhase: 'foreground', hasForegroundProviderWork };
  }

  if (inputs.hasBackgroundWork) {
    return { turnPhase: 'background', hasForegroundProviderWork: false };
  }

  return { turnPhase: 'idle', hasForegroundProviderWork: false };
}
