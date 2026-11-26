import { assertWorktreeCanBeRemoved } from '../agents/background-work';
import {
  assertNotSplitDestinationWorktreeClaimed,
  assertNotSplitLocked,
} from '../services/split-lock-service';

/** Shared read-only admission for recovery offers and Discard's live rechecks. */
export function assertWorktreeDiscardAdmitted(
  workspaceId: string,
  worktreeId: string,
): void {
  assertWorktreeRemovalAdmitted(
    workspaceId,
    worktreeId,
    'discarding the worktree',
  );
}

/** Shared live-resource gate; each writer retains its execution-time recheck. */
export function assertWorktreeRemovalAdmitted(
  workspaceId: string,
  worktreeId: string,
  activity: string,
): void {
  assertNotSplitLocked(workspaceId, worktreeId, activity);
  assertNotSplitDestinationWorktreeClaimed(workspaceId, worktreeId, activity);
  assertWorktreeCanBeRemoved(workspaceId, worktreeId);
}
