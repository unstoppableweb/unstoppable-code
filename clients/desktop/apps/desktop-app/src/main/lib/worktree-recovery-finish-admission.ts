import type { ArchiveRecoveryReceipt } from '@canopy/desktop-shared/node/archive-recovery-store';
import {
  findBlockingArchiveResolution,
  readArchiveRecoveryHolds,
} from './archive-recovery-refs';
import type { ArchiveJournalOperation } from './stranded-archive-journals';

/** Shared read-only prerequisites; the lifecycle still rechecks its cleanup shape. */
export async function checkArchiveFinishAdmission(
  operation: ArchiveJournalOperation,
  readReceipts: () => Promise<ArchiveRecoveryReceipt[]> = () =>
    readArchiveRecoveryHolds(operation.record.workspaceId),
): Promise<
  | 'recovery-receipts-unreadable'
  | 'resolution-pending'
  | 'unknown-cleanup-debt'
  | null
> {
  // Finish's exact list must be readable, even when the selected journal has no receipt.
  try {
    if (
      findBlockingArchiveResolution(
        await readReceipts(),
        operation.record.worktreeId,
      )
    )
      return 'resolution-pending';
  } catch {
    return 'recovery-receipts-unreadable';
  }
  if (
    operation.record.state === 'completed' &&
    !operation.record.steps.some(
      (step) =>
        step.phase === 'deferred-browser-retirement' ||
        (step.phase === 'turn-diff-cleanup' && step.state !== 'done'),
    )
  )
    return 'unknown-cleanup-debt';
  return null;
}
