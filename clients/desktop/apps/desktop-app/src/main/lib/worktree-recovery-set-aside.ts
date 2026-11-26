import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  WorktreeRecoverySetAsideParams,
  WorktreeRecoverySetAsideResult,
} from '@canopy/protocol/canopy-core';
import { LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN } from '@canopy/protocol/remote-control/shell/lifecycle-journal';
import { worktreeRecoveryOfferedActions } from '@canopy/protocol/remote-control/shell/worktree-recovery';
import { getCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import { inspectDestructiveJournals } from '@canopy/desktop-shared/node/w5-destructive-journal';
import { hasWorkspaceDeletionLease } from '../services/split-lock-service';
import { archiveRecoveryStore } from './archive-recovery-refs';
import { withArchivedContainerOperationLock } from './archived-containers';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import { logMainProcessWarn } from './main-process-logging';
import {
  getW5DestructiveLifecycleDir,
  getW5QuarantinedLifecycleDir,
} from './paths';
import { assertWritableScope } from './read-only-scope';
import { readArchiveJournalOperations } from './stranded-archive-journals';
import { validateId } from './validation';
import { withW5Commit } from './w5-commit-log-file-store';
import {
  inFlightDestructiveOperationIds,
  isDestructiveRecoveryOwnerless,
  needsDestructiveRecovery,
  withExclusiveLifecycleJournalAccess,
} from './w5-destructive-recovery';
import {
  LifecycleJournalQuarantineRefusedError,
  type LifecycleJournalMoveProgress,
  portableLifecycleJournalLocationLabel,
  setAsideReadableLifecycleJournalFile,
} from './w5-lifecycle-journal-quarantine';
import { listWorktreeRecovery } from './worktree-recovery-description';
import { describeWorktreeDiscard } from './worktree-discard';

type Refusal = Extract<
  WorktreeRecoverySetAsideResult,
  { status: 'refused' }
>['check'];

class SetAsideRefused extends Error {
  constructor(readonly check: Refusal) {
    super(`Set aside was refused: ${check}.`);
    this.name = 'SetAsideRefused';
  }
}

/**
 * CAN-7014, user-only: atomically renames one reviewed, consistent, readable,
 * ownerless archive record into its scoped lifecycle-journal quarantine hold.
 * CAN-7284 owns multi-copy Set aside and a durable per-operation intent record.
 * Nothing else moves or is deleted: saved files, Git snapshots and retained
 * archives stay where they are. Undo is a manual put-back while the app is
 * quit. The existing CAN-5335 entry point keeps refusing readable records.
 */
export async function setAsideWorktreeRecovery(
  request: WorktreeRecoverySetAsideParams,
): Promise<WorktreeRecoverySetAsideResult> {
  validateId(request.workspaceId, 'workspaceId');
  assertWritableScope(request.workspaceId);
  const { workspaceId, operationId } = request;
  const progress: LifecycleJournalMoveProgress = { renamed: false };
  try {
    return await serializeWorkspaceMutation(async () => {
      const scan = await readArchiveJournalOperations(workspaceId);
      if (!scan.readable) throw new SetAsideRefused('evidence-unreadable');
      const reviewed = scan.operations.find(
        (entry) => entry.record.operationId === operationId,
      );
      if (!reviewed || reviewed.revision !== request.revision)
        throw new SetAsideRefused('revision-changed');
      if (reviewed.copies !== 1 || !reviewed.consistent)
        throw new SetAsideRefused('not-eligible');
      const worktreeId = reviewed.record.worktreeId;
      if (!worktreeId) throw new SetAsideRefused('not-eligible');
      validateId(worktreeId, 'worktreeId');
      return await withArchivedContainerOperationLock(
        workspaceId,
        worktreeId,
        () =>
          withW5Commit(
            { operation: 'core.worktree.recovery.setAside' },
            async () => {
              if (await hasUnfinishedResolution(workspaceId, operationId))
                throw new SetAsideRefused('resolution-pending');
              // Outside journal access: the scan's shared access waits on exclusive access.
              const listed = await listWorktreeRecovery(
                { workspaceId, operationId },
                describeWorktreeDiscard,
                'contents',
              );
              const entry = listed.entries[0];
              if (listed.check === 'journal-evidence-unreadable')
                throw new SetAsideRefused('evidence-unreadable');
              if (entry?.diagnosis?.revision !== request.revision)
                throw new SetAsideRefused('revision-changed');
              // Match Check again's exact check, not passive list metadata.
              // Unrelated receipt damage cannot withdraw this journal-only move.
              if (
                !worktreeRecoveryOfferedActions(entry, {
                  canResolve: true,
                  canSetAside: true,
                }).includes('set-aside')
              )
                throw new SetAsideRefused('not-eligible');
              return withExclusiveLifecycleJournalAccess(async () => {
                const inspection =
                  await inspectDestructiveJournals(getCanopyDataDir());
                if (
                  inspection.issues.some(
                    (issue) =>
                      issue.path === 'w5/destructive-lifecycles' ||
                      LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN.test(
                        basename(issue.path),
                      ),
                  )
                )
                  throw new SetAsideRefused('evidence-unreadable');
                const copies = inspection.records.filter(
                  (record) => record.record.operationId === operationId,
                );
                const [copy] = reviewed.rawSources;
                const [current] = copies;
                if (
                  !copy ||
                  !current ||
                  copies.length !== 1 ||
                  current.name !== copy.name
                )
                  throw new SetAsideRefused('revision-changed');
                const running = inFlightDestructiveOperationIds();
                if (
                  !needsDestructiveRecovery(current.record) ||
                  running.has(operationId) ||
                  hasWorkspaceDeletionLease(workspaceId) ||
                  inspection.records.some(
                    ({ record }) =>
                      record.workspaceId === workspaceId &&
                      record.operation === 'workspace-delete' &&
                      (record.state !== 'completed' || record.cleanupRequired),
                  ) ||
                  !isDestructiveRecoveryOwnerless(current.record)
                )
                  throw new SetAsideRefused('not-eligible');
                if (await hasUnfinishedResolution(workspaceId, operationId))
                  throw new SetAsideRefused('resolution-pending');
                const contents = await readFile(
                  join(getW5DestructiveLifecycleDir(), copy.name),
                ).catch((error: unknown) => {
                  if (
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error &&
                    error.code === 'ENOENT'
                  )
                    return null;
                  throw error;
                });
                if (!contents?.equals(copy.bytes))
                  throw new SetAsideRefused('revision-changed');
                // One rename carries the retention hold; no partial multi-copy move.
                const quarantinedName =
                  await setAsideReadableLifecycleJournalFile(
                    copy.name,
                    copy.bytes,
                    progress,
                  );
                return {
                  status: 'set-aside' as const,
                  operationId,
                  quarantinedNames: [quarantinedName],
                  putBackCopies: [{ originalName: copy.name, quarantinedName }],
                  journalLocationLabel: portableLifecycleJournalLocationLabel(
                    getW5DestructiveLifecycleDir(),
                  ),
                  quarantineLocationLabel:
                    portableLifecycleJournalLocationLabel(
                      getW5QuarantinedLifecycleDir(),
                    ),
                };
              });
            },
          ),
      );
    });
  } catch (error) {
    const reservationName =
      error instanceof LifecycleJournalQuarantineRefusedError
        ? error.reservationName
        : undefined;
    if (progress.renamed || reservationName) {
      logMainProcessWarn('Archive record set aside was interrupted', {
        workspaceId,
        operationId,
        renamed: progress.renamed,
        error,
      });
      return {
        status: 'interrupted',
        operationId,
        check: 'unconfirmed',
        ...(progress.renamed && progress.moved
          ? {
              moved: {
                ...progress.moved,
                journalLocationLabel: portableLifecycleJournalLocationLabel(
                  getW5DestructiveLifecycleDir(),
                ),
                quarantineLocationLabel: portableLifecycleJournalLocationLabel(
                  getW5QuarantinedLifecycleDir(),
                ),
              },
            }
          : {}),
        ...(reservationName
          ? {
              reservation: {
                quarantinedName: reservationName,
                quarantineLocationLabel: portableLifecycleJournalLocationLabel(
                  getW5QuarantinedLifecycleDir(),
                ),
              },
            }
          : {}),
      };
    }
    if (error instanceof SetAsideRefused)
      return { status: 'refused', operationId, check: error.check };
    logMainProcessWarn('Archive record set aside was refused', {
      workspaceId,
      operationId,
      error,
    });
    // Nothing was moved. A changed or vanished copy means the review is stale.
    return {
      status: 'refused',
      operationId,
      check:
        error instanceof LifecycleJournalQuarantineRefusedError &&
        (error.reason === 'changed' || error.reason === 'missing')
          ? 'revision-changed'
          : 'not-eligible',
    };
  }
}

async function hasUnfinishedResolution(
  workspaceId: string,
  operationId: string,
): Promise<boolean> {
  const receipt = await archiveRecoveryStore()
    .read(workspaceId, operationId)
    .catch(() => {
      throw new SetAsideRefused('not-eligible');
    });
  return (
    receipt !== null && !receipt.cancelled && receipt.stage !== 'completed'
  );
}
