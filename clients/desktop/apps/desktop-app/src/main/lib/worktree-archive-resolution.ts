import {
  admitResolution,
  readArchiveResolutionPreparation,
} from './worktree-archive-resolution-admission';
import {
  settleArchiveRecovery,
  type ArchiveRecoverySettlementPorts,
} from './archive-recovery-settlement';
import {
  ArchiveRecoveryRefusedError,
  type ArchiveRecoveryReceipt,
} from '@canopy/desktop-shared/node/archive-recovery-store';
import type {
  WorktreeRecoveryResolveParams,
  WorktreeRecoveryResolveResult,
} from '@canopy/protocol/canopy-core';
import { hasWorkspaceDeletionLease } from '../services/split-lock-service';
import { readArchiveJournalOperations } from './stranded-archive-journals';
import { describeWorktreeRecovery } from './worktree-recovery-description';
import { archiveRecoveryStore } from './archive-recovery-refs';
import {
  deleteArchiveRecoveryRefs,
  qualifyArchiveRecoveryRefDeletion,
} from './archived-container-git';
import { withArchivedContainerOperationLock } from './archived-containers';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import { assertWritableScope } from './read-only-scope';
import { validateId } from './validation';
import {
  readBlockingDestructiveRecoveries,
  withExclusiveLifecycleJournalAccess,
} from './w5-destructive-recovery';
import { withW5Commit } from './w5-commit-log-file-store';

async function requireResolutionAdmission<T>(
  admit: () => T | Promise<T>,
): Promise<T> {
  try {
    return await admit();
  } catch (cause) {
    throw new ArchiveRecoveryRefusedError(
      'Archive resolution is not admitted.',
      cause,
    );
  }
}

function resultOf(
  receipt: ArchiveRecoveryReceipt,
): WorktreeRecoveryResolveResult {
  return {
    status:
      receipt.action === 'keep-worktree'
        ? 'worktree-kept'
        : 'attempt-withdrawn',
    operationId: receipt.operationId,
    holdId: receipt.operationId,
    retainedSnapshots: receipt.repositories.reduce(
      (count, repository) => count + repository.refs.length,
      0,
    ),
    retainedPayload: receipt.staging !== null,
  };
}

/** Core policy; worker primitives keep evidence, vacate staging and retire exact journal copies. */
export async function resolveWorktreeArchive(
  request: WorktreeRecoveryResolveParams,
): Promise<WorktreeRecoveryResolveResult> {
  validateId(request.workspaceId, 'workspaceId');
  const store = archiveRecoveryStore();
  let receipt: ArchiveRecoveryReceipt | null = null;
  const settlementPorts: ArchiveRecoverySettlementPorts = {
    store,
    admitResolution: (selected: ArchiveRecoveryReceipt) =>
      requireResolutionAdmission(() => admitResolution(selected)),
    admitDeletion: () =>
      requireResolutionAdmission(async () => {
        if (
          hasWorkspaceDeletionLease(request.workspaceId) ||
          (await readBlockingDestructiveRecoveries(request.workspaceId)).some(
            (record) => record.operation === 'workspace-delete',
          )
        )
          throw new Error('Project deletion is pending.');
      }),
    qualifyRefs: qualifyArchiveRecoveryRefDeletion,
    deleteRefs: deleteArchiveRecoveryRefs,
    withdraw: (selected: ArchiveRecoveryReceipt) =>
      withExclusiveLifecycleJournalAccess(() =>
        store.withdrawJournals(selected),
      ),
  };
  try {
    await requireResolutionAdmission(() =>
      assertWritableScope(request.workspaceId),
    );
    return await serializeWorkspaceMutation(async () => {
      await withExclusiveLifecycleJournalAccess(() =>
        store.normalizeWorkspace(request.workspaceId),
      );
      receipt = await store.read(request.workspaceId, request.operationId);
      if (request.action === 'delete-hold') {
        if (
          !receipt ||
          receipt.revision !== request.revision ||
          receipt.stage !== 'completed'
        )
          throw new ArchiveRecoveryRefusedError(
            'The reviewed recovery hold changed.',
          );
        const selected = receipt;
        return withArchivedContainerOperationLock(
          request.workspaceId,
          selected.worktreeId,
          () =>
            withW5Commit(
              { operation: 'core.worktree.recovery.resolve' },
              async () => {
                receipt = await settleArchiveRecovery(
                  selected,
                  'delete-hold',
                  settlementPorts,
                );
                return {
                  status: 'hold-deleted' as const,
                  operationId: receipt.operationId,
                };
              },
            ),
        );
      }
      // Cancelled intents must pass the full current diagnosis before atomic replacement.
      const cancelled = receipt?.cancelled ? receipt : null;
      if (cancelled) receipt = null;
      if (
        receipt &&
        (receipt.retention !== undefined ||
          receipt.revision !== request.revision ||
          receipt.action !== request.action)
      )
        throw new ArchiveRecoveryRefusedError('Resolution intent changed.');
      if (receipt?.stage === 'completed') return resultOf(receipt);

      const action = request.action;
      const scan = receipt
        ? { readable: true, operations: [] }
        : await readArchiveJournalOperations(request.workspaceId);
      if (!scan.readable)
        throw new ArchiveRecoveryRefusedError(
          'Journal evidence is unreadable.',
        );
      const operation = scan.operations.find(
        (entry) => entry.record.operationId === request.operationId,
      );
      const worktreeId = receipt?.worktreeId ?? operation?.record.worktreeId;
      if (!worktreeId)
        throw new ArchiveRecoveryRefusedError(
          'No exact archive operation exists.',
        );
      return withArchivedContainerOperationLock(
        request.workspaceId,
        worktreeId,
        () =>
          withW5Commit(
            { operation: 'core.worktree.recovery.resolve' },
            async () => {
              if (!receipt) {
                if (
                  !operation?.consistent ||
                  operation.revision !== request.revision ||
                  !operation.record.createdAt
                )
                  throw new ArchiveRecoveryRefusedError(
                    'The reviewed source copy set changed.',
                  );
                const diagnosis = await describeWorktreeRecovery(
                  {
                    workspaceId: request.workspaceId,
                    worktreeId,
                    expectedCreatedAt: operation.record.createdAt,
                    intent: 'archive',
                    operationId: request.operationId,
                  },
                  undefined,
                  undefined,
                  'metadata',
                );
                if (
                  diagnosis.diagnosis?.verdict !== request.action ||
                  diagnosis.diagnosis.revision !== request.revision
                )
                  throw new ArchiveRecoveryRefusedError(
                    'Archive resolution is not admitted.',
                  );
                const preparation = await readArchiveResolutionPreparation(
                  operation,
                  action,
                  undefined,
                  'metadata',
                );
                if (cancelled) {
                  await settlementPorts.admitResolution({
                    ...preparation,
                    version: 1,
                    stage: 'prepared',
                    staging: cancelled.staging,
                  });
                  await settlementPorts.qualifyRefs(cancelled);
                }
                // Read-only preflights above; prepare is the single exact-content gate before effects.
                receipt = await store.prepare(preparation);
              }
              receipt = await settleArchiveRecovery(
                receipt,
                'resolve',
                settlementPorts,
              );
              return resultOf(receipt);
            },
          ),
      );
    });
  } catch (error) {
    // Receipt and source evidence remain discoverable. Never report withdrawal as removal.
    const saved = await store
      .read(request.workspaceId, request.operationId)
      .catch(() => null);
    const resumable =
      !(error instanceof ArchiveRecoveryRefusedError) &&
      saved !== null &&
      !saved.cancelled &&
      saved.revision === request.revision &&
      (request.action === 'delete-hold'
        ? saved.retention === 'deleting'
        : saved.action === request.action &&
          saved.retention === undefined &&
          saved.stage !== 'completed');
    return {
      status: resumable ? 'interrupted' : 'refused',
      operationId: request.operationId,
      check: resumable ? 'resume-exact-resolution' : 'resolution-not-admitted',
    };
  }
}
