import type {
  WorktreeRecoveryFinishParams,
  WorktreeRecoveryFinishResult,
} from '@canopy/protocol/canopy-core';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { logMainProcessWarn } from './main-process-logging';
import { destructiveFailureCode } from './destructive-failure-context';
import { BrowserRetirementTimeoutError } from './browser-retirement-deadline';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import { assertWritableScope } from './read-only-scope';
import {
  readArchiveJournalOperations,
  type ArchiveJournalOperation,
} from './stranded-archive-journals';
import { validateId } from './validation';
import { exactArchiveJournal } from './w5-destructive-recovery';
import { listWorktreeRecovery } from './worktree-recovery-description';
import {
  finishInterruptedArchiveCleanup,
  runWithWorktreeArchiveDeletionLifecycle,
} from './worktree-service';
import {
  readArchivedContainerManifestIncludingExpired,
  withArchivedWorkspaceOperationLock,
} from './archived-containers';

class FinishRefused extends W5CommitRefusedError {
  constructor(readonly check: string) {
    super('recovery-required', 'Archive Finish was refused.', {
      phase: 'archive-journal',
      check,
    });
  }
}

async function readAdmittedFinishOperation(
  request: WorktreeRecoveryFinishParams,
): Promise<ArchiveJournalOperation> {
  const diagnosis = await listWorktreeRecovery({
    workspaceId: request.workspaceId,
    operationId: request.operationId,
  });
  const verdict = diagnosis.entries[0]?.diagnosis;
  if (
    diagnosis.check !== 'ok' ||
    !verdict ||
    verdict.revision !== request.revision ||
    !['finish-tail', 'finish-journal', 'cleanup-debt'].includes(verdict.verdict)
  )
    throw new FinishRefused(
      verdict?.revision !== request.revision
        ? 'review-changed'
        : (verdict?.check ?? 'not-admitted'),
    );
  const snapshot = await readArchiveJournalOperations(request.workspaceId);
  const operation = snapshot.operations.find(
    (entry) => entry.record.operationId === request.operationId,
  );
  if (
    !snapshot.readable ||
    !operation?.consistent ||
    operation.revision !== request.revision
  )
    throw new FinishRefused('review-changed');
  if (
    operation.record.state === 'completed' &&
    !operation.record.steps.some(
      (step) =>
        step.phase === 'deferred-browser-retirement' ||
        (step.phase === 'turn-diff-cleanup' && step.state !== 'done'),
    )
  )
    throw new FinishRefused('unknown-cleanup-debt');
  return operation;
}

/** Core-owned Finish only: no withdrawal, reset, snapshot release or generic archive replay. */
export function finishWorktreeRecovery(
  request: WorktreeRecoveryFinishParams,
): Promise<WorktreeRecoveryFinishResult> {
  validateId(request.workspaceId, 'workspaceId');
  assertWritableScope(request.workspaceId);
  return serializeWorkspaceMutation(async () => {
    // Resolve the opaque address before taking a target-specific lifecycle fence.
    const initial = await readArchiveJournalOperations(request.workspaceId);
    const target = initial.operations.find(
      (entry) => entry.record.operationId === request.operationId,
    );
    const worktreeId = target?.record.worktreeId;
    if (!initial.readable || !target || !worktreeId)
      return { status: 'refused', check: 'journal-evidence-unavailable' };
    validateId(worktreeId, 'worktreeId');
    let executionStarted = false;
    try {
      // Retirement and runtime-preparation cancellation cannot be rolled back.
      await readAdmittedFinishOperation(request);
      return await runWithWorktreeArchiveDeletionLifecycle(
        request.workspaceId,
        worktreeId,
        (onLiveSessionsDestroyed, onArchiveDeletionCommitted) =>
          withArchivedWorkspaceOperationLock(request.workspaceId, async () => {
            // Revalidate after acquiring the execution fences; preflight is not a lease.
            const operation = await readAdmittedFinishOperation(request);
            executionStarted = true;
            const result = await finishInterruptedArchiveCleanup(
              {
                workspaceId: request.workspaceId,
                worktreeId,
                expectedCreatedAt: operation.record.createdAt,
                exactJournal: exactArchiveJournal(
                  operation.record,
                  operation.names,
                ),
                w5Commit: { operation: 'core.worktree.recovery.finish' },
              },
              onLiveSessionsDestroyed,
              onArchiveDeletionCommitted,
            );
            if (!result || operation.record.state !== 'completed')
              throw new Error('Archive Finish did not complete.');
            const manifest =
              await readArchivedContainerManifestIncludingExpired(
                request.workspaceId,
                worktreeId,
              );
            return {
              status: operation.record.cleanupRequired
                ? 'cleanup-pending'
                : 'finished',
              operationId: request.operationId,
              cleanupRequired: operation.record.cleanupRequired === true,
              gitCleanupPending:
                manifest?.version === 3 &&
                manifest.recovery.gitCleanupPending === true,
            };
          }),
      );
    } catch (error) {
      logMainProcessWarn('Archive Finish stopped', {
        code: destructiveFailureCode(error),
        check:
          error instanceof W5CommitRefusedError
            ? error.details.check
            : undefined,
      });
      if (error instanceof FinishRefused)
        return { status: 'refused', check: error.check };
      if (error instanceof W5CommitRefusedError)
        return {
          status: executionStarted ? 'interrupted' : 'refused',
          check:
            typeof error.details.check === 'string'
              ? error.details.check
              : 'storage-admission',
        };
      if (error instanceof BrowserRetirementTimeoutError)
        return { status: 'interrupted', check: 'browser-retirement-timeout' };
      return { status: 'interrupted', check: 'finish-interrupted' };
    }
  });
}
