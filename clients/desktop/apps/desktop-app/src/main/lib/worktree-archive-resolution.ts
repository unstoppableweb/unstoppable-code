import {
  settleArchiveRecovery,
  type ArchiveRecoverySettlementPorts,
} from './archive-recovery-settlement';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ArchiveRecoveryRefusedError,
  classifyArchiveRecovery,
  type ArchiveRecoveryReceipt,
  type ArchiveRecoveryPreparation,
} from '@canopy/desktop-shared/node/archive-recovery-store';
import { journalSchema } from '@canopy/desktop-shared/node/w5-destructive-journal';
import type {
  WorktreeRecoveryResolveParams,
  WorktreeRecoveryResolveResult,
} from '@canopy/protocol/canopy-core';
import { assertWorktreeCanBeRemoved } from '../agents/background-work';
import {
  assertNotSplitDestinationWorktreeClaimed,
  assertNotSplitLocked,
  hasWorkspaceDeletionLease,
} from '../services/split-lock-service';
import { readArchiveJournalOperations } from './stranded-archive-journals';
import { describeWorktreeRecovery } from './worktree-recovery-description';
import { archiveRecoveryStore } from './archive-recovery-refs';
import {
  inspectArchiveRecoveryRepositories,
  deleteArchiveRecoveryRefs,
  qualifyArchiveRecoveryRefDeletion,
  readArchivedGitStagedDescriptor,
} from './archived-container-git';
import { withArchivedContainerOperationLock } from './archived-containers';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from './workspace-persistence';
import { assertWritableScope } from './read-only-scope';
import { validateId } from './validation';
import {
  areOwnedPathsUnreplaced,
  isDestructiveRecoveryOwnerless,
  isRecoveryProjectUnreplaced,
  readBlockingDestructiveRecoveries,
  isVerifiedProtectedPathIdentity,
  readDirectoryStatIdentity,
  statIdentityOf,
  withExclusiveLifecycleJournalAccess,
} from './w5-destructive-recovery';
import { getWorkspaceWorktreeDir } from './paths';
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

/** Qualifies original resource admission only while its effects remain unperformed. */
async function admitResolution(receipt: ArchiveRecoveryReceipt): Promise<void> {
  const record = journalSchema.parse(receipt.sourceRecord);
  const { workspaceId, worktreeId } = receipt;
  if (
    record.operationId !== receipt.operationId ||
    record.workspaceId !== workspaceId ||
    record.worktreeId !== worktreeId ||
    record.createdAt !== receipt.createdAt ||
    record.operation !== 'worktree-archive' ||
    record.state !== 'recovery-required' ||
    !isDestructiveRecoveryOwnerless(record)
  )
    throw new Error('Source archive is not ownerless stranded evidence.');
  assertWritableScope(workspaceId);
  assertNotSplitLocked(workspaceId, worktreeId, 'resolving the archive');
  assertNotSplitDestinationWorktreeClaimed(
    workspaceId,
    worktreeId,
    'resolving the archive',
  );
  assertWorktreeCanBeRemoved(workspaceId, worktreeId);
  const scan = await readArchiveJournalOperations(workspaceId);
  if (!scan.readable || hasWorkspaceDeletionLease(workspaceId))
    throw new Error('Project deletion or unreadable journal evidence.');
  if (
    (await readBlockingDestructiveRecoveries(workspaceId, worktreeId)).some(
      (other) => other.operationId !== receipt.operationId,
    )
  )
    throw new Error('Another destructive operation is pending.');
  const source = scan.operations.find(
    (operation) => operation.record.operationId === receipt.operationId,
  );
  if (!source && !['withdrawal-intent', 'withdrawn'].includes(receipt.stage))
    throw new Error('Source journal disappeared before withdrawal intent.');
  if (
    source &&
    !['withdrawal-intent', 'withdrawn'].includes(receipt.stage) &&
    source.copies !== receipt.copies.length
  )
    throw new Error('Source journal copy set changed before withdrawal.');
  if (
    source &&
    (!source.consistent ||
      source.sources.some(
        (copy) =>
          !receipt.copies.some((expected) => isDeepStrictEqual(copy, expected)),
      ))
  )
    throw new Error('Source archive changed.');
  if (
    !(await isRecoveryProjectUnreplaced(record)) ||
    !(await areOwnedPathsUnreplaced(record))
  )
    throw new Error('Archive identity changed.');
  const list = await readWorkspaceWorktreesDetailed(workspaceId, {
    persistRemovalCleanup: false,
  });
  if (list.authority !== 'ok')
    throw new Error('Canonical worktree inventory is unreadable.');
  const row = list.worktrees.find((entry) => entry.id === worktreeId);
  const checkout = getWorkspaceWorktreeDir(workspaceId, worktreeId);
  const quarantine = join(
    dirname(checkout),
    `.${basename(checkout)}.archive-quarantine`,
  );
  const quarantinePresent = await lstat(quarantine).then(
    () => true,
    (error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return false;
      throw error;
    },
  );
  if (quarantinePresent)
    throw new Error('Archive quarantine occupancy changed.');
  const identity = await readDirectoryStatIdentity(checkout);
  const expected = record.ownedPaths.find(
    (owned) => owned.path === checkout,
  )?.identity;
  if (receipt.action === 'keep-worktree') {
    if (
      !row ||
      row.createdAt !== receipt.createdAt ||
      identity === null ||
      !expected ||
      !isVerifiedProtectedPathIdentity(expected) ||
      statIdentityOf(expected) !== identity
    )
      throw new Error('Keep requires the original listed live checkout.');
  } else if (row || identity !== null)
    throw new Error('Release requires authoritative row and checkout absence.');
  const config = await readWorkspaceConfigDetailed(workspaceId);
  if (config.authority !== 'ok' || config.config.type === 'cowork')
    throw new Error('Project repositories are unavailable.');
  const repositories = await inspectArchiveRecoveryRepositories({
    workspaceId,
    containerId: worktreeId,
    workspaceType: config.config.type,
  });
  if (!isDeepStrictEqual(repositories, receipt.repositories))
    throw new Error('Retained Git evidence changed or became unavailable.');
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
                );
                if (
                  diagnosis.diagnosis?.verdict !== request.action ||
                  diagnosis.diagnosis.revision !== request.revision
                )
                  throw new ArchiveRecoveryRefusedError(
                    'Archive resolution is not admitted.',
                  );
                if (
                  (await store.list(request.workspaceId)).some(
                    (entry) =>
                      entry.worktreeId === worktreeId &&
                      classifyArchiveRecovery(entry).worktreeFence,
                  )
                )
                  throw new ArchiveRecoveryRefusedError(
                    'Another archive resolution is pending.',
                  );
                const config = await readWorkspaceConfigDetailed(
                  request.workspaceId,
                );
                if (
                  config.authority !== 'ok' ||
                  config.config.type === 'cowork'
                )
                  throw new ArchiveRecoveryRefusedError(
                    'Project repositories are unavailable.',
                  );
                const repositories = await inspectArchiveRecoveryRepositories({
                  workspaceId: request.workspaceId,
                  containerId: worktreeId,
                  workspaceType: config.config.type,
                });
                const descriptor = await readArchivedGitStagedDescriptor(
                  request.workspaceId,
                  worktreeId,
                  { readOnly: true, recoveryOnly: true },
                );
                for (const captured of descriptor?.repositories ?? []) {
                  if (
                    !repositories.some(
                      (repository) =>
                        repository.referenceRepoPath ===
                          captured.referenceRepoPath &&
                        repository.refs.some(
                          (ref) =>
                            ref.name === captured.snapshotRef &&
                            ref.objectId === captured.worktreeSnapshotCommit,
                        ),
                    )
                  )
                    throw new ArchiveRecoveryRefusedError(
                      'Staged snapshots cannot be verified.',
                    );
                }
                const preparation: ArchiveRecoveryPreparation = {
                  ...request,
                  action,
                  worktreeId,
                  createdAt: operation.record.createdAt,
                  copies: operation.sources,
                  sourceRecord: operation.record,
                  repositories,
                  capture:
                    descriptor?.status === 'ready'
                      ? 'complete'
                      : descriptor
                        ? 'partial'
                        : repositories.some(
                              (repository) => repository.refs.length > 0,
                            )
                          ? 'unpublished'
                          : 'none',
                };
                if (cancelled) {
                  await settlementPorts.admitResolution({
                    ...preparation,
                    version: 1,
                    stage: 'prepared',
                    staging: cancelled.staging,
                  });
                  await settlementPorts.qualifyRefs(cancelled);
                }
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
