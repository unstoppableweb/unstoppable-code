import {
  offerWorktreeDiscard,
  offerLifecycleJournalQuarantine,
} from '@canopy/app-state';
import {
  WorktreeArchiveRefusalError,
  WorktreeRemovalRefusedError,
} from '@/lib/worktreeRemovalAdmission';

/**
 * CAN-5336: hands a single-row removal refusal to the discard host instead
 * of a toast. The source pre-check's refusal carries no description, so the
 * host describes it and falls back to the refusal's toast when nothing can be
 * discarded. Returns whether the error was such a refusal.
 */
export function offerDiscardForRefusal(
  error: unknown,
  target: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly worktreeName: string;
    readonly retry: () => void;
  },
): boolean {
  if (
    !(error instanceof WorktreeRemovalRefusedError) &&
    !(error instanceof WorktreeArchiveRefusalError)
  )
    return false;
  if (
    error instanceof WorktreeArchiveRefusalError &&
    error.recovery?.destination.kind === 'journal-review'
  ) {
    offerLifecycleJournalQuarantine(
      undefined,
      error.recovery.destination.reason,
    );
    return true;
  }
  offerWorktreeDiscard({
    workspaceId: target.projectId,
    worktreeId: target.worktreeId,
    worktreeName: target.worktreeName,
    message: error.message,
    ...(error instanceof WorktreeArchiveRefusalError
      ? {
          description: error.discard,
          ...(error.recovery ? { recovery: error.recovery } : {}),
          ...(error.removal ? { removal: error.removal } : {}),
        }
      : {}),
    retry: target.retry,
  });
  return true;
}
