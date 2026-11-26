import {
  matchesRecordedDirectoryIdentity,
  matchesRecordedRepositoryIdentity,
} from '@canopy/core-runtime/node/w5/recorded-directory-identity';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
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
import { assertWorktreeRemovalAdmitted } from './worktree-discard-admission';
import { hasWorkspaceDeletionLease } from '../services/split-lock-service';
import {
  type ArchiveJournalOperation,
  readArchiveJournalOperations,
} from './stranded-archive-journals';
import {
  archiveRecoveryStore,
  readArchiveRecoveryHolds,
} from './archive-recovery-refs';
import {
  inspectArchiveRecoveryRepositories,
  qualifyArchiveRecoveryRefDeletion,
  readArchivedGitStagedDescriptor,
} from './archived-container-git';
import { readArchivedContainerManifestIncludingExpired } from './archived-containers';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from './workspace-persistence';
import { assertWritableScope } from './read-only-scope';
import {
  areOwnedPathsUnreplaced,
  hasUnverifiableProjectIdentity,
  isDestructiveRecoveryOwnerless,
  isRecoveryProjectUnreplaced,
  isUnverifiableReleaseCandidate,
  readBlockingDestructiveRecoveries,
  isVerifiedProtectedPathIdentity,
  readDirectoryStatIdentity,
  filterBlockingDestructiveRecoveries,
  type DestructiveRecoveryRecord,
} from './w5-destructive-recovery';
import { getWorkspaceWorktreeDir, getWorktreeDataDir } from './paths';

export interface ArchiveResolutionOfferInspection {
  journals: Awaited<ReturnType<typeof readArchiveJournalOperations>>;
  blocking: readonly DestructiveRecoveryRecord[];
}

/** Qualifies original resource admission only while its effects remain unperformed. */
export async function admitResolution(
  receipt: ArchiveRecoveryReceipt,
): Promise<void> {
  await admitResolutionInspection(receipt, inspectArchiveRecoveryRepositories);
}

async function admitResolutionInspection(
  receipt: ArchiveRecoveryReceipt,
  inspectRepositories: typeof inspectArchiveRecoveryRepositories,
  offerInspection?: ArchiveResolutionOfferInspection,
): Promise<void> {
  const record = journalSchema.parse(receipt.sourceRecord);
  const { workspaceId, worktreeId } = receipt;
  if (
    record.operationId !== receipt.operationId ||
    record.workspaceId !== workspaceId ||
    record.worktreeId !== worktreeId ||
    record.createdAt !== receipt.createdAt ||
    record.operation !== 'worktree-archive' ||
    // An ownerless `active` journal is a crash (CAN-7014, q-26 2a).
    (record.state !== 'recovery-required' && record.state !== 'active') ||
    !isDestructiveRecoveryOwnerless(record)
  )
    throw new Error('Source archive is not ownerless stranded evidence.');
  assertWritableScope(workspaceId);
  assertWorktreeRemovalAdmitted(
    workspaceId,
    worktreeId,
    'resolving the archive',
  );
  const scan =
    offerInspection?.journals ??
    (await readArchiveJournalOperations(workspaceId));
  if (!scan.readable || hasWorkspaceDeletionLease(workspaceId))
    throw new Error('Project deletion or unreadable journal evidence.');
  if (
    (
      await (offerInspection
        ? filterBlockingDestructiveRecoveries(
            offerInspection.blocking,
            worktreeId,
          )
        : readBlockingDestructiveRecoveries(workspaceId, worktreeId))
    ).some((other) => other.operationId !== receipt.operationId)
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
  const unverifiable = hasUnverifiableProjectIdentity(record);
  if (
    (unverifiable
      ? receipt.action !== 'release' || !isUnverifiableReleaseCandidate(record)
      : !(await isRecoveryProjectUnreplaced(record))) ||
    !(await areOwnedPathsUnreplaced(
      record,
      unverifiable ? getWorktreeDataDir(workspaceId, worktreeId) : undefined,
    ))
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
      !matchesRecordedDirectoryIdentity(
        expected,
        identity,
        hostOperatingSystem(),
      )
    )
      throw new Error('Keep requires the original listed live checkout.');
  } else if (row || identity !== null)
    throw new Error('Release requires authoritative row and checkout absence.');
  if (
    unverifiable &&
    ((await readArchivedContainerManifestIncludingExpired(
      workspaceId,
      worktreeId,
    ).catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return null;
      throw error;
    })) !== null ||
      (await readArchivedGitStagedDescriptor(workspaceId, worktreeId, {
        readOnly: true,
        recoveryOnly: true,
      })) !== null)
  )
    throw new Error('Unverifiable archive release requires no capture.');
  const config = await readWorkspaceConfigDetailed(workspaceId);
  if (config.authority !== 'ok' || config.config.type === 'cowork')
    throw new Error('Project repositories are unavailable.');
  const repositories = await inspectRepositories({
    workspaceId,
    containerId: worktreeId,
    workspaceType: config.config.type,
  });
  if (
    repositories.length !== receipt.repositories.length ||
    !receipt.repositories.every((saved, index) => {
      const live = repositories[index];
      return (
        live !== undefined &&
        matchesRecordedRepositoryIdentity(
          saved.identity,
          live.identity,
          hostOperatingSystem(),
        ) &&
        isDeepStrictEqual({ ...saved, identity: live.identity }, live)
      );
    })
  )
    throw new Error('Retained Git evidence changed or became unavailable.');
}

/** Writers defer exact payload admission to prepare; selected-entry checks keep contents mode. */
export async function readArchiveResolutionPreparation(
  operation: ArchiveJournalOperation,
  action: ArchiveRecoveryPreparation['action'],
  readReceipts?: () => Promise<ArchiveRecoveryReceipt[]>,
  mode: 'metadata' | 'contents' = 'contents',
): Promise<ArchiveRecoveryPreparation> {
  return readResolutionPreparation(operation, action, mode, readReceipts);
}

/** Passive offers use metadata; selected-entry rechecks verify exact contents. */
export async function admitArchiveResolutionOffer(
  operation: ArchiveJournalOperation,
  action: ArchiveRecoveryPreparation['action'],
  mode: 'metadata' | 'contents',
  readReceipts?: () => Promise<ArchiveRecoveryReceipt[]>,
  inspection?: ArchiveResolutionOfferInspection,
): Promise<void> {
  await readResolutionPreparation(
    operation,
    action,
    mode,
    readReceipts,
    inspection,
  );
}

async function readResolutionPreparation(
  operation: ArchiveJournalOperation,
  action: ArchiveRecoveryPreparation['action'],
  mode: 'metadata' | 'contents',
  readReceipts: () => Promise<ArchiveRecoveryReceipt[]> = () =>
    readArchiveRecoveryHolds(operation.record.workspaceId),
  offerInspection?: ArchiveResolutionOfferInspection,
): Promise<ArchiveRecoveryPreparation> {
  const { workspaceId, worktreeId, createdAt } = operation.record;
  if (!worktreeId || !createdAt || !operation.consistent)
    throw new ArchiveRecoveryRefusedError('Source archive is not qualified.');
  if (
    (await readReceipts()).some(
      (entry) =>
        entry.worktreeId === worktreeId &&
        classifyArchiveRecovery(entry).worktreeFence,
    )
  )
    throw new ArchiveRecoveryRefusedError(
      'Another archive resolution is pending.',
    );
  const config = await readWorkspaceConfigDetailed(workspaceId);
  if (config.authority !== 'ok' || config.config.type === 'cowork')
    throw new ArchiveRecoveryRefusedError(
      'Project repositories are unavailable.',
    );
  const repositories = await inspectArchiveRecoveryRepositories({
    workspaceId,
    containerId: worktreeId,
    workspaceType: config.config.type,
  });
  const descriptor = await readArchivedGitStagedDescriptor(
    workspaceId,
    worktreeId,
    { readOnly: true, recoveryOnly: true },
  );
  for (const captured of descriptor?.repositories ?? []) {
    if (
      !repositories.some(
        (repository) =>
          repository.referenceRepoPath === captured.referenceRepoPath &&
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
    workspaceId,
    operationId: operation.record.operationId,
    revision: operation.revision,
    action,
    worktreeId,
    createdAt,
    copies: operation.sources,
    sourceRecord: operation.record,
    repositories,
    capture:
      descriptor?.status === 'ready'
        ? 'complete'
        : descriptor
          ? 'partial'
          : repositories.some((repository) => repository.refs.length > 0)
            ? 'unpublished'
            : 'none',
  };
  // Reuse preparation's namespace snapshot; settlement rechecks before effects.
  await admitResolutionInspection(
    {
      ...preparation,
      version: 1,
      stage: 'prepared',
      staging: null,
    },
    (): Promise<typeof repositories> => Promise.resolve(repositories),
    offerInspection,
  );
  const { existing } =
    mode === 'metadata'
      ? await archiveRecoveryStore().readOfferPreparation(preparation)
      : await archiveRecoveryStore().readAdmittedPreparation(preparation);
  if (existing?.cancelled) await qualifyArchiveRecoveryRefDeletion(existing);
  return preparation;
}
