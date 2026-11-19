import type {
  CopilotAuthorityRecord,
  CopilotGrantHead,
} from '@canopy/core-runtime/node/vault';
import type {
  CopilotHostSelection,
  CopilotSelectionIdentity,
} from '@canopy/protocol/copilot-selection';

type Phase =
  | 'disabled'
  | 'creating'
  | 'prepared'
  | 'selected'
  | 'removing'
  | 'cancelling'
  | 'cancelled';
type Operation = Pick<CopilotSelectionIdentity, 'operationId' | 'epoch'>;
function equal(a: unknown, b: unknown): boolean {
  function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, ordered(value)]),
      );
    return value;
  }
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}
function cancellation(
  completed: CopilotAuthorityRecord['completed'],
  successor: Operation | undefined,
): boolean {
  return (
    !!successor &&
    completed?.kind === 'delete' &&
    completed.operationId === `${successor.operationId}:cancel` &&
    completed.epoch === successor.epoch
  );
}
function selectedPin(
  selected: CopilotHostSelection,
  head: CopilotGrantHead,
): boolean {
  return (
    selected.pinGeneration === head.pinGeneration &&
    equal(selected.pin?.ref, head.pin.ref) &&
    !!selected.pin &&
    selected.pin.revision <= head.pin.revision
  );
}

/** One trusted channel's receipt continuity, not a second credential or preferences writer. */
export function createCopilotSetupLineage(): {
  interrupt(): void;
  active(): boolean;
  revision(): number;
  current(): CopilotHostSelection | undefined;
  ownsPredecessor(selected: CopilotHostSelection): boolean;
  stale(
    selected: CopilotHostSelection,
    authority: CopilotAuthorityRecord,
  ): boolean;
  observe(next: CopilotHostSelection | null): boolean;
  preparing(
    identity: CopilotSelectionIdentity,
    generation: string | null,
  ): void;
  prepared(
    identity: CopilotSelectionIdentity,
    saved: CopilotHostSelection | undefined,
  ): boolean;
  admit(
    selected: CopilotHostSelection,
    enabled: boolean | undefined,
    authority: CopilotAuthorityRecord,
    retired: Operation,
  ): boolean;
} {
  let receipt: CopilotHostSelection | undefined;
  let proposed: CopilotHostSelection | undefined;
  let predecessor: CopilotHostSelection | undefined;
  let successor: Operation | undefined;
  let successorIdentity: CopilotSelectionIdentity | undefined;
  let successorReceipt: CopilotHostSelection | undefined;
  let phase: Phase = 'disabled';
  let revision = 0;
  let sequence = -1;
  let interrupted = false;

  function transition(
    previous: CopilotHostSelection,
    next: CopilotHostSelection,
  ): boolean {
    if (equal(previous, next)) return true;
    if (
      equal(previous.identity, next.identity) &&
      previous.pinGeneration === next.pinGeneration
    ) {
      return (
        (previous.state === 'prepared' &&
          previous.pin === null &&
          next.state === 'selected' &&
          next.pin !== null) ||
        (next.state === 'disabled' && equal(previous.pin, next.pin))
      );
    }
    return (
      previous.state === 'disabled' &&
      next.state === 'prepared' &&
      next.pin === null &&
      !!successorIdentity &&
      equal(next.identity, successorIdentity) &&
      equal(previous, predecessor)
    );
  }
  function preparing(
    identity: CopilotSelectionIdentity,
    generation: string | null,
  ): void {
    if (interrupted) throw new Error('Copilot setup lineage interrupted.');
    const previous = proposed ?? receipt;
    if (successorIdentity && equal(identity, successorIdentity)) return;
    if (
      !previous ||
      previous.state !== 'disabled' ||
      previous.pinGeneration !== generation ||
      identity.origin !== 'setup'
    )
      throw new Error('Copilot setup predecessor unavailable.');
    predecessor = previous;
    successor = { operationId: identity.operationId, epoch: identity.epoch };
    successorIdentity = structuredClone(identity);
    successorReceipt = undefined;
    phase = 'creating';
  }
  return {
    interrupt() {
      interrupted = true;
    },
    active: () => !!receipt,
    revision: () => revision,
    current: () => proposed ?? receipt,
    ownsPredecessor: (selected) =>
      !interrupted &&
      selected.state === 'disabled' &&
      equal(selected, proposed ?? receipt),
    stale: (selected, authority) =>
      authority.sequence < sequence ||
      (!!proposed && !equal(proposed, selected) && equal(receipt, selected)),
    observe(next) {
      revision++;
      if (interrupted) return false;
      const previous = proposed ?? receipt;
      if (!previous) return true;
      if (!next || !transition(previous, next)) return false;
      proposed = next;
      if (successorIdentity && equal(next.identity, successorIdentity))
        successorReceipt = next;
      return true;
    },
    preparing,
    prepared(identity, saved) {
      if (interrupted) return false;
      // beforeSave is proposed, not durable acknowledgement. A failed prepare may leave P intact.
      if (
        !!saved &&
        equal(saved, predecessor) &&
        successorIdentity &&
        equal(identity, successorIdentity) &&
        phase === 'creating'
      )
        proposed = undefined;
      return true;
    },
    admit(selected, enabled, authority, retired) {
      if (interrupted) return false;
      if (authority.sequence < sequence) return false;
      const head = authority.head;
      const mutation = authority.mutation;
      let nextPhase: Phase | undefined;
      const witness = authority.setupLineage;
      let nextSuccessor = successor ?? witness?.successor;
      let nextIdentity = successorIdentity;
      const previous = proposed ?? receipt;
      const trustedPredecessor =
        predecessor ?? (!receipt ? witness?.predecessor : undefined);
      const survivingPredecessor =
        !!trustedPredecessor && equal(selected, trustedPredecessor);
      if (
        previous &&
        !transition(previous, selected) &&
        !survivingPredecessor &&
        !equal(selected, successorReceipt)
      )
        return false;
      const retiredImport =
        selected.identity.origin === 'import' &&
        selected.identity.operationId === retired.operationId &&
        selected.identity.epoch === retired.epoch;

      if (
        head &&
        selected.identity.origin === 'setup' &&
        equal(selected.identity, {
          operationId: head.operationId,
          epoch: head.epoch,
          origin: head.origin,
          account: head.account,
        }) &&
        selectedPin(selected, head)
      ) {
        if (selected.state === 'selected' && enabled === true)
          nextPhase = 'selected';
        else if (
          selected.state === 'disabled' &&
          enabled === false &&
          authority.removal?.epoch === head.epoch
        )
          nextPhase = 'removing';
      } else if (!head && mutation?.origin === 'setup') {
        const cancelled =
          nextSuccessor ??
          (selected.identity.origin === 'setup'
            ? selected.identity
            : undefined);
        const cancellingDelete =
          mutation.kind === 'delete' &&
          !!cancelled &&
          mutation.operationId === `${cancelled.operationId}:cancel` &&
          mutation.epoch === cancelled.epoch;
        if (mutation.kind === 'create' || cancellingDelete) {
          const identity: CopilotSelectionIdentity =
            mutation.kind === 'create'
              ? {
                  operationId: mutation.operationId,
                  epoch: mutation.epoch,
                  account: mutation.account,
                  origin: 'setup',
                }
              : {
                  operationId: cancelled?.operationId ?? '',
                  epoch: mutation.epoch,
                  account: mutation.account,
                  origin: 'setup',
                };
          if (
            successor &&
            !equal(successor, {
              operationId: identity.operationId,
              epoch: identity.epoch,
            }) &&
            phase !== 'disabled' &&
            phase !== 'cancelled'
          )
            return false;
          nextSuccessor = {
            operationId: identity.operationId,
            epoch: identity.epoch,
          };
          nextIdentity = identity;
          if (equal(selected.identity, identity)) {
            if (
              selected.state === 'prepared' &&
              enabled === false &&
              selected.pin === null
            )
              nextPhase = mutation.cancelling ? 'cancelling' : 'prepared';
            else if (
              selected.state === 'selected' &&
              enabled === true &&
              equal(selected.pin, mutation.committed)
            )
              nextPhase = mutation.cancelling ? 'cancelling' : 'prepared';
            else if (
              selected.state === 'disabled' &&
              enabled === false &&
              (mutation.cancelling || cancellingDelete)
            )
              nextPhase = 'cancelling';
          } else if (
            selected.state === 'disabled' &&
            enabled === false &&
            (survivingPredecessor ||
              (!receipt && !trustedPredecessor && retiredImport) ||
              equal(selected, receipt))
          ) {
            nextPhase = mutation.cancelling ? 'cancelling' : 'creating';
          }
        }
      } else if (
        !head &&
        !mutation &&
        selected.state === 'disabled' &&
        enabled === false &&
        authority.completed?.kind === 'delete'
      ) {
        const cancelled =
          nextSuccessor ??
          (selected.identity.origin === 'setup'
            ? selected.identity
            : undefined);
        if (
          cancellation(authority.completed, cancelled) &&
          (survivingPredecessor ||
            // Live continuity only; after a restart P4's witness names the exact survivor.
            (!!previous &&
              cancelled?.operationId === selected.identity.operationId &&
              cancelled.epoch === selected.identity.epoch))
        )
          nextPhase = 'cancelled';
        else if (
          witness?.phase === 'retired' &&
          witness.successor.operationId === authority.completed.operationId &&
          witness.successor.epoch === authority.completed.epoch &&
          // P4 committed this exact receipt with the delete; an epoch match is not identity.
          equal(selected, witness.predecessor) &&
          (retiredImport || selected.identity.origin === 'setup')
        )
          nextPhase = 'disabled';
      }
      if (!nextPhase) return false;
      // Commit only a revalidated durable snapshot. Observation never acknowledges a save.
      receipt = selected;
      proposed = undefined;
      phase = nextPhase;
      sequence = authority.sequence;
      successor = nextSuccessor;
      successorIdentity = nextIdentity;
      if (
        selected.state === 'disabled' &&
        (phase === 'disabled' ||
          phase === 'cancelled' ||
          phase === 'creating' ||
          (phase === 'cancelling' && !predecessor))
      )
        predecessor = selected;
      if (successorIdentity && equal(selected.identity, successorIdentity))
        successorReceipt = selected;
      return true;
    },
  };
}
export type CopilotSetupLineage = ReturnType<typeof createCopilotSetupLineage>;
