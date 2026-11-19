import type { WorktreeData } from '@canopy/desktop-shared/types';
import {
  removeWorkspaceWorktrees,
  updateWorkspaceWorktree,
  updateWorkspaceWorktrees,
} from './workspace-persistence';
import { refuseWorktreeCreation } from './worktree-creation-selection';
import {
  applyReservedWorktreeRecordTo,
  applyWorktreeCreationReservationTo,
  applyWorktreeCreationSetupTo,
  removesReservedWorktree,
  type WorktreeCreationRecordRefusal,
} from './worktree-record-decision-apply';
import type {
  ReservedWorktreeTarget,
  WorktreeCreationPromoteDecision,
  WorktreeCreationReservationDecision,
  WorktreeCreationReservationOutcome,
  WorktreeCreationReservationPreconditions,
  WorktreeCreationReservationRemovalDecision,
  WorktreeCreationSetupDecision,
  WorktreeRecordTarget,
} from './worktree-record-decisions';

// The worktree creation members of `W5RecordDecisionPort` (W6b), applied
// through the list writers the records used, unchanged. Kept apart so the
// other ports' importers do not load it.

/** Thrown inside the locked update, so the refused write never happens. */
function refuse(refusal: WorktreeCreationRecordRefusal): never {
  if (refusal.reason === 'checkout-reserved')
    refuseWorktreeCreation(
      'checkout-reserved',
      'Checkout path is already in use',
    );
  refuseWorktreeCreation(
    'branch-reserved',
    `Branch name "${refusal.branchName}" is already in use or invalid`,
  );
}

/**
 * Leads the list with a reserved row under the list lock, in the create's
 * reservation step. Only a fully readable list proves the id, branch and
 * checkouts free; the row joins its sidebar group in the same write.
 */
export async function applyWorktreeCreationReservation(
  workspaceId: string,
  decision: WorktreeCreationReservationDecision,
  preconditions: WorktreeCreationReservationPreconditions,
  onAdmitted?: () => void,
  options?: { persistCollisionCleanup?: false },
): Promise<WorktreeCreationReservationOutcome> {
  // Set by the updater, which runs under the list lock.
  const pass: WorktreeCreationReservationOutcome = { status: 'reserved' };
  const { expectedRevision } = preconditions;
  await updateWorkspaceWorktrees(
    workspaceId,
    (rows) => {
      const next = applyWorktreeCreationReservationTo(rows, decision);
      if ('refusal' in next) refuse(next.refusal);
      pass.status = next.status;
      // Keyed collisions must not reconcile groups or persist filtered tombstones:
      // a later candidate's no-effect failure may release the same key.
      if (
        next.status !== 'collision' ||
        options?.persistCollisionCleanup !== false
      )
        onAdmitted?.();
      return next.worktrees;
    },
    {
      requireAuthoritativeRead: true,
      shouldWrite:
        options?.persistCollisionCleanup === false
          ? (): boolean => pass.status !== 'collision'
          : undefined,
      sidebarItemGroupId: decision.sidebarItemGroupId,
      newItemId: decision.worktree.id,
      w5Commit: {
        operation: 'core.worktree.create',
        expectedRevisions:
          expectedRevision === undefined
            ? undefined
            : [
                {
                  resource: { kind: 'worktrees', workspaceId },
                  revision: expectedRevision,
                },
              ],
      },
    },
  );
  return pass;
}

/** Applies a setup record to the reserved incarnation under the list lock. */
export async function applyReservedWorktreeRecord(
  target: ReservedWorktreeTarget,
  decision: WorktreeCreationSetupDecision,
): Promise<boolean> {
  // Set by the updater, which runs under the list lock.
  const pass = { updated: false };
  await updateWorkspaceWorktrees(
    target.workspaceId,
    (rows) => {
      const next = applyReservedWorktreeRecordTo(
        rows,
        { id: target.worktreeId, createdAt: target.createdAt },
        decision,
      );
      if ('refusal' in next) refuse(next.refusal);
      pass.updated = next.updated;
      return next.worktrees;
    },
    // Only a complete existing list can prove the reservation is stale.
    { requireAuthoritativeRead: true, requireExistingList: true },
  );
  return pass.updated;
}

/** Promotes the row at the id, as a create that enforces no reservation did. */
export function applyWorktreeSetupRecord(
  target: WorktreeRecordTarget,
  decision: WorktreeCreationPromoteDecision,
): Promise<boolean> {
  return updateWorkspaceWorktree(target.workspaceId, target.worktreeId, (row) =>
    applyWorktreeCreationSetupTo(row, decision),
  );
}

/** Removes the reserved incarnation under the list lock, tombstoning it. */
export async function applyReservedWorktreeRemoval(
  target: ReservedWorktreeTarget,
  decision: WorktreeCreationReservationRemovalDecision,
): Promise<boolean> {
  const reserved = { id: target.worktreeId, createdAt: target.createdAt };
  const shouldRemove = (row: WorktreeData): boolean =>
    removesReservedWorktree(row, reserved);
  const removed = decision.remainingWorktreeOrder
    ? await removeWorkspaceWorktrees(
        target.workspaceId,
        shouldRemove,
        decision.remainingWorktreeOrder,
        decision.expectedRemainingWorktreeOrder,
      )
    : await removeWorkspaceWorktrees(target.workspaceId, shouldRemove);
  return removed.length > 0;
}
