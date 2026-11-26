import { matchesRecordedDirectoryIdentity } from '@canopy/core-runtime/node/w5/recorded-directory-identity';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { recordMetadataWork } from '@canopy/desktop-shared/node/work-counters';
import {
  archiveRecoveryStore,
  assertNoArchiveResolution,
  readArchiveRecoveryHolds,
} from './archive-recovery-refs';
import {
  isCompletedTurnDiffCleanup,
  inspectCompletedTurnDiffCleanup,
} from './archive-turn-diff-cleanup';
import type {
  WorktreeRecoveryListParams,
  WorktreeRecoveryListResult,
} from '@canopy/protocol/canopy-core';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  readArchiveJournalOperations,
  type ArchiveJournalOperation,
} from './stranded-archive-journals';
import { validateId } from './validation';
import {
  unavailableWorktreeRecovery,
  worktreeRecoveryStoppingPoint,
  type WorktreeRecoveryAction,
  type WorktreeRecoveryDescription,
  type WorktreeRecoveryRequest,
  type WorktreeRecoveryAsset,
} from '@canopy/protocol/remote-control/shell/worktree-recovery';
import type { WorktreeDiscardDescription } from '@canopy/protocol/remote-control/shell/worktree-discard';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { hasWorkspaceDeletionLease } from '../services/split-lock-service';
import { destructiveFailureRecord } from './destructive-failure-context';
import {
  canAdmitInterruptedArchive,
  canFinishArchiveCleanup,
  canResumeFailedChildArchive,
  canResumeInterruptedArchive,
  hasUnverifiableProjectIdentity,
  inFlightDestructiveOperationIds,
  isRecoveryProjectUnreplaced,
  isUnverifiableReleaseCandidate,
  isDestructiveRecoveryOwnerless,
  needsDestructiveRecovery,
  isVerifiedProtectedPathIdentity,
  journalDirectoryUnreadable,
  areOwnedPathsUnreplaced,
  readBlockingDestructiveRecoveries,
  filterBlockingDestructiveRecoveries,
  readDirectoryStatIdentity,
  type DestructiveRecoveryRecord,
} from './w5-destructive-recovery';
import { findWorktreeArchiveSourceRefusal } from './worktree-service';
import {
  assertWorktreeDiscardAdmitted,
  assertWorktreeRemovalAdmitted,
} from './worktree-discard-admission';
import { admitArchiveResolutionOffer } from './worktree-archive-resolution-admission';
import { checkArchiveFinishAdmission } from './worktree-recovery-finish-admission';
import type { ArchiveRecoveryReceipt } from '@canopy/desktop-shared/node/archive-recovery-store';
import { readArchivedContainerManifestIncludingExpired } from './archived-containers';
import {
  getArchivedContainerDir,
  getArchivedContainerChatsPath,
  getWorkspaceWorktreeDir,
  getWorktreeDataDir,
} from './paths';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from './workspace-persistence';
import { isWritableScope } from './read-only-scope';
import {
  readArchivedContainerRecoveryJournal,
  readConfiguredWorktreeSourceCandidates,
} from './archived-container-recovery';
import {
  isArchivedContainerSnapshotRef,
  inspectArchivedContainerSnapshotRef,
  readArchivedGitStagedDescriptor,
} from './archived-container-git';
import type {
  ArchivedContainerManifestV2,
  WorkspaceConfigFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';

export interface WorktreeRecoveryContext extends WorktreeRecoveryRequest {
  workspaceId: string;
  worktreeId: string;
}

/** Preserve structured failure evidence before any best-effort secondary read. */
export function recoveryFromRefusal(
  request: WorktreeRecoveryContext,
  error?: unknown,
): WorktreeRecoveryDescription {
  const check =
    error instanceof W5CommitRefusedError &&
    typeof error.details.check === 'string'
      ? error.details.check
      : 'unknown';
  const description = unavailableWorktreeRecovery(
    {
      workspaceId: request.workspaceId,
      worktreeId: request.worktreeId,
      createdAt: request.expectedCreatedAt,
    },
    request,
    check,
  );
  if (
    check === 'unreadable-entry' ||
    check === 'journal-directory-unreadable'
  ) {
    description.code = 'external.worktree_recovery_unreadable';
    description.destination = {
      kind: 'journal-review',
      reason:
        check === 'unreadable-entry'
          ? 'unreadable-entry'
          : 'directory-unreadable',
    };
  }
  if (check === 'legacy-journal-unreadable')
    description.code = 'external.worktree_recovery_unreadable';
  const record = destructiveFailureRecord(error);
  if (record) projectJournal(description, record, request);
  else if (
    error instanceof W5CommitRefusedError &&
    typeof error.details.operationId === 'string' &&
    (error.details.operation === 'workspace-delete' ||
      error.details.operation === 'worktree-archive' ||
      error.details.operation === 'worktree-delete')
  ) {
    description.evidence = {
      kind: 'journal',
      operation: error.details.operation,
      operationId: error.details.operationId,
      attribution: 'unknown',
    };
  }
  return description;
}

function projectJournal(
  description: WorktreeRecoveryDescription,
  record: DestructiveRecoveryRecord,
  request: WorktreeRecoveryContext,
): void {
  description.evidence = {
    kind: 'journal',
    operation: record.operation,
    operationId: record.operationId,
    attribution:
      record.workspaceId !== request.workspaceId ||
      record.worktreeId !== request.worktreeId
        ? 'other'
        : !record.createdAt || !request.expectedCreatedAt
          ? 'unknown'
          : record.createdAt === request.expectedCreatedAt
            ? 'subject'
            : 'other',
  };
  description.stoppingPoint = worktreeRecoveryStoppingPoint(record.steps);
}

async function directoryFact(path: string): Promise<WorktreeRecoveryAsset> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? { presence: 'present', verification: 'unverified' }
      : { presence: 'unknown', verification: 'unknown' };
  } catch (error) {
    return typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
      ? { presence: 'absent', verification: 'unknown' }
      : { presence: 'unknown', verification: 'unknown' };
  }
}

async function stagedCopyFact(
  workspaceId: string,
  worktreeId: string,
  recovery: { payloadId: string; source: 'retained' | 'partial' | 'absent' },
): Promise<WorktreeRecoveryAsset> {
  const fact = await directoryFact(
    join(
      getArchivedContainerDir(workspaceId, worktreeId),
      'recovery-files',
      recovery.payloadId,
    ),
  );
  return fact.presence === 'present' && recovery.source === 'partial'
    ? { presence: 'partial', verification: 'unverified' }
    : fact;
}

async function snapshotFacts(
  workspaceId: string,
  worktreeId: string,
  row: WorktreeData,
  config: WorkspaceConfigFile,
  manifest: ArchivedContainerManifestV2,
): Promise<WorktreeRecoveryAsset> {
  try {
    const sources = await readConfiguredWorktreeSourceCandidates(
      workspaceId,
      row,
      config,
    );
    const repositories: NonNullable<WorktreeRecoveryAsset['repositories']> = [];
    for (const source of sources) {
      const captured = manifest.gitState.repositories.find(
        (entry) => entry.repoId === source.repoId,
      );
      if (
        !captured ||
        captured.referenceRepoPath !== source.referenceRepoPath ||
        !isArchivedContainerSnapshotRef(
          workspaceId,
          worktreeId,
          source.repoId,
          captured.snapshotRef,
        )
      ) {
        repositories.push({
          repoId: source.repoId,
          presence: 'unknown',
          verification: 'unknown',
        });
        continue;
      }
      try {
        const observed = await inspectArchivedContainerSnapshotRef({
          repoPath: source.referenceRepoPath,
          refName: captured.snapshotRef,
          expectedCommit: captured.worktreeSnapshotCommit,
        });
        repositories.push({
          repoId: source.repoId,
          presence:
            observed.ref === 'expected' && observed.commitPresent
              ? 'present'
              : observed.ref === 'absent' && !observed.commitPresent
                ? 'absent'
                : 'unknown',
          verification:
            observed.ref === 'expected' && observed.commitPresent
              ? 'verified'
              : 'unknown',
        });
      } catch {
        repositories.push({
          repoId: source.repoId,
          presence: 'unknown',
          verification: 'unknown',
        });
      }
    }
    const saved = repositories.filter(
      (entry) => entry.presence === 'present',
    ).length;
    return {
      presence:
        saved === 0
          ? repositories.length > 0 &&
            repositories.every((entry) => entry.presence === 'absent')
            ? 'absent'
            : 'unknown'
          : saved === repositories.length
            ? 'present'
            : 'partial',
      verification:
        saved > 0 && saved === repositories.length ? 'verified' : 'unknown',
      repositories,
    };
  } catch {
    return { presence: 'unknown', verification: 'unknown' };
  }
}

/**
 * Independent of discard eligibility and row presence. A failed inspection keeps
 * the original reason and unknown facts, never permission to remove anything.
 */
export function describeWorktreeRecovery(
  request: WorktreeRecoveryContext,
  discard: WorktreeDiscardDescription | undefined,
  error?: unknown,
  resolutionInspection: 'metadata' | 'contents' = 'contents',
): Promise<WorktreeRecoveryDescription> {
  return describeWorktreeRecoveryFromInspection(
    request,
    discard,
    resolutionInspection,
    error,
  );
}

async function discardAction(
  request: WorktreeRecoveryContext,
  discard: WorktreeDiscardDescription | undefined,
  readReceipts: () => Promise<ArchiveRecoveryReceipt[]>,
): Promise<WorktreeRecoveryDescription['actions']['discard']> {
  if (discard?.refusal?.reason === 'evidence-unreadable')
    return { eligible: false, reason: 'unavailable' };
  if (
    request.expectedCreatedAt === null ||
    discard?.workspaceId !== request.workspaceId ||
    discard.worktreeId !== request.worktreeId ||
    discard.createdAt !== request.expectedCreatedAt ||
    discard.status !== 'discardable'
  )
    return { eligible: false, reason: 'not-admitted' };
  try {
    assertWorktreeDiscardAdmitted(request.workspaceId, request.worktreeId);
    await assertNoArchiveResolution(
      request.workspaceId,
      request.worktreeId,
      undefined,
      readReceipts,
    );
    return { eligible: true };
  } catch {
    return { eligible: false, reason: 'not-admitted' };
  }
}

/**
 * CAN-7014: whether a single, consistent, readable record may be moved aside.
 * CAN-7284 owns multi-copy admission and a durable per-operation intent record.
 * Journal facts only, so a running agent or another gate never withdraws it.
 * A project deletion's child stays for the parent's resume, as does a record
 * bound to unfinished Keep/Release. Execution re-checks it under the journal lock.
 */
export async function setAsideAction(
  request: Pick<WorktreeRecoveryContext, 'workspaceId' | 'worktreeId'>,
  operation: ArchiveJournalOperation,
  operations: readonly ArchiveJournalOperation[],
): Promise<WorktreeRecoveryAction> {
  const { workspaceId, worktreeId } = request;
  const refused: WorktreeRecoveryAction = {
    eligible: false,
    reason: 'not-admitted',
  };
  if (
    operation.copies !== 1 ||
    !operation.consistent ||
    !operation.records.some(needsDestructiveRecovery) ||
    !operation.records.every(
      (record) =>
        record.operation === 'worktree-archive' &&
        record.workspaceId === workspaceId &&
        record.worktreeId === worktreeId &&
        record.parentOperation === undefined &&
        isDestructiveRecoveryOwnerless(record),
    ) ||
    inFlightDestructiveOperationIds().has(operation.record.operationId) ||
    !isWritableScope(workspaceId) ||
    hasWorkspaceDeletionLease(workspaceId) ||
    operations.some((entry) =>
      entry.records.some(
        (record) =>
          record.workspaceId === workspaceId &&
          record.operation === 'workspace-delete' &&
          (record.state !== 'completed' || record.cleanupRequired),
      ),
    )
  )
    return refused;
  try {
    const receipt = await archiveRecoveryStore().read(
      workspaceId,
      operation.record.operationId,
    );
    return receipt && !receipt.cancelled && receipt.stage !== 'completed'
      ? refused
      : { eligible: true };
  } catch {
    return { eligible: false, reason: 'unavailable' };
  }
}

async function describeWorktreeRecoveryFromInspection(
  request: WorktreeRecoveryContext,
  discard: WorktreeDiscardDescription | undefined,
  resolutionInspection: 'metadata' | 'contents',
  error?: unknown,
  inspection?: Awaited<ReturnType<typeof readArchiveJournalOperations>>,
  assertReceiptsNormalizable: () => Promise<void> = () =>
    archiveRecoveryStore().assertWorkspaceNormalizable(request.workspaceId),
  readReceipts: () => Promise<ArchiveRecoveryReceipt[]> = () =>
    readArchiveRecoveryHolds(request.workspaceId),
  readBlockingInspection: () => Promise<DestructiveRecoveryRecord[]> = () =>
    readBlockingDestructiveRecoveries(request.workspaceId, undefined, true),
): Promise<WorktreeRecoveryDescription> {
  const description = recoveryFromRefusal(request, error);
  if (description.destination.kind === 'journal-review') return description;
  // Discard admission is independent of lifecycle evidence and row presence.
  description.actions.discard = await discardAction(
    request,
    discard,
    readReceipts,
  );
  try {
    validateId(request.workspaceId, 'workspaceId');
    validateId(request.worktreeId, 'worktreeId');
    const scan =
      inspection ?? (await readArchiveJournalOperations(request.workspaceId));
    if (!scan.readable) {
      if (scan.directoryUnreadable)
        return recoveryFromRefusal(request, journalDirectoryUnreadable());
      description.check = 'journal-evidence-unreadable';
      description.code = 'external.worktree_recovery_unreadable';
      description.destination = {
        kind: 'journal-review',
        reason: 'unreadable-entry',
      };
      description.actions.discard = { eligible: false, reason: 'unavailable' };
      description.actions.retry = { eligible: false, reason: 'unavailable' };
      return description;
    }
    const operationId =
      request.operationId ??
      (error instanceof W5CommitRefusedError
        ? error.details.operationId
        : undefined) ??
      (description.evidence.kind === 'journal'
        ? description.evidence.operationId
        : undefined);
    const operation =
      operationId !== undefined
        ? scan.operations.find(
            (entry) => entry.record.operationId === operationId,
          )
        : scan.operations.find(
            (entry) =>
              (entry.slot === 'same-operation' || !entry.consistent) &&
              entry.records.some(
                (record) =>
                  record.workspaceId === request.workspaceId &&
                  record.worktreeId === request.worktreeId,
              ),
          );
    if (!operation) return description;
    const { record } = operation;
    const diagnosis: NonNullable<WorktreeRecoveryDescription['diagnosis']> = {
      operationId: record.operationId,
      revision: operation.revision,
      copies: operation.copies,
      slot: operation.slot,
      rawState: record.state,
      verdict: 'refused',
      check: 'not-admitted',
    };
    description.diagnosis = diagnosis;
    if (
      description.evidence.kind === 'journal' &&
      description.evidence.operationId !== record.operationId
    ) {
      diagnosis.check = 'operation-evidence-conflict';
      return description;
    }
    // Before every shape and removal gate below, so no early return withdraws it.
    description.actions.setAside = await setAsideAction(
      request,
      operation,
      scan.operations,
    );
    if (!operation.consistent) {
      diagnosis.check = 'conflicting-journal-copies';
      return description;
    }
    if (
      description.evidence.kind === 'unknown' ||
      description.evidence.attribution === 'unknown'
    )
      projectJournal(description, record, request);
    if (
      description.evidence.kind !== 'journal' ||
      description.evidence.attribution !== 'subject'
    ) {
      diagnosis.check =
        record.workspaceId !== request.workspaceId ||
        record.worktreeId !== request.worktreeId
          ? 'operation-subject-mismatch'
          : !record.createdAt || !request.expectedCreatedAt
            ? 'created-at-missing'
            : 'other-incarnation';
      return description;
    }
    // q-26 2a: an ownerless `active` journal is a crash; it reads as recovery-required.
    if (
      record.operation !== 'worktree-archive' ||
      (record.state === 'active' && !isDestructiveRecoveryOwnerless(record))
    ) {
      diagnosis.check =
        record.state === 'active' ? 'raw-active' : 'not-archive';
      return description;
    }
    if (!isDestructiveRecoveryOwnerless(record)) {
      diagnosis.check = 'operation-owned';
      return description;
    }
    if (isCompletedTurnDiffCleanup(record)) {
      const cleanup = await inspectCompletedTurnDiffCleanup(
        operation,
        readReceipts,
        scan,
      );
      if (cleanup.eligible) {
        const refused = await checkArchiveFinishAdmission(
          operation,
          readReceipts,
        );
        if (refused) {
          diagnosis.check = refused;
          return description;
        }
        // Retained manifests keep the existing Finish diagnosis below.
        description.check = 'completed-turn-diff-cleanup';
        diagnosis.verdict = 'cleanup-debt';
        diagnosis.check = 'completed-turn-diff-cleanup';
        description.retained.checkout = {
          presence: 'absent',
          verification: 'unknown',
        };
        return description;
      }
      diagnosis.check = cleanup.check;
    }
    if (hasWorkspaceDeletionLease(request.workspaceId)) {
      diagnosis.check = 'project-deletion-pending';
      return description;
    }
    let recordedDeletionPending = false;
    for (const entry of scan.operations) {
      for (const deletion of entry.records) {
        if (
          deletion.workspaceId !== request.workspaceId ||
          deletion.operation !== 'workspace-delete' ||
          (deletion.state === 'completed' && !deletion.cleanupRequired)
        )
          continue;
        // A different incarnation is not pending here; execution admission is checked below.
        if (
          entry.consistent &&
          deletion.directoryIdentity &&
          record.directoryIdentity &&
          /^\d+:\d+:\d+(?:\.\d+)?(?::[a-f0-9-]{36})?$/.test(
            deletion.directoryIdentity,
          ) &&
          !(await isRecoveryProjectUnreplaced(deletion))
        )
          continue;
        recordedDeletionPending = true;
      }
    }
    const { workspaceId, worktreeId, expectedCreatedAt } = request;
    if (!expectedCreatedAt) {
      diagnosis.check = 'created-at-missing';
      return description;
    }
    const list = await readWorkspaceWorktreesDetailed(workspaceId, {
      persistRemovalCleanup: false,
    });
    if (list.authority !== 'ok') {
      diagnosis.check = 'list-unreadable';
      return description;
    }
    const row = list.worktrees.find((entry) => entry.id === worktreeId);
    if (row && row.createdAt !== expectedCreatedAt) {
      diagnosis.check = 'other-incarnation';
      return description;
    }
    // A listed unverifiable row keeps Discard; only an unlisted one may reach Release.
    const unverifiable = hasUnverifiableProjectIdentity(record);
    if (
      unverifiable
        ? row || !isUnverifiableReleaseCandidate(record)
        : !(await isRecoveryProjectUnreplaced(record))
    ) {
      diagnosis.check = 'identity-unverified';
      return description;
    }

    // Owned paths must still identify this incarnation before claiming its files.
    const checkout = getWorkspaceWorktreeDir(workspaceId, worktreeId);
    const checkoutIdentity = await readDirectoryStatIdentity(checkout).catch(
      () => undefined,
    );
    if (unverifiable && checkoutIdentity !== null) {
      diagnosis.check = 'identity-unverified';
      return description;
    }
    const owned = record.ownedPaths.find((entry) => entry.path === checkout);
    if (checkoutIdentity === null)
      description.retained.checkout = {
        presence: 'absent',
        verification: 'unknown',
      };
    else if (
      checkoutIdentity !== undefined &&
      owned?.identity &&
      isVerifiedProtectedPathIdentity(owned.identity) &&
      matchesRecordedDirectoryIdentity(
        owned.identity,
        checkoutIdentity,
        hostOperatingSystem(),
      )
    )
      description.retained.checkout = {
        presence: 'present',
        verification: 'verified',
      };

    const manifest = await readArchivedContainerManifestIncludingExpired(
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
    });
    // An unverifiable committed archive stays refused: its manifest's files are unproven.
    if (unverifiable && manifest) {
      diagnosis.check = 'identity-unverified';
      return description;
    }
    const matchingManifest =
      manifest &&
      (manifest.version === 2 || manifest.version === 3) &&
      manifest.kind === 'worktree' &&
      manifest.createdAt === expectedCreatedAt &&
      manifest.originalWorktree.createdAt === expectedCreatedAt
        ? manifest
        : null;
    const blockingInspection = await readBlockingInspection();
    // Finish retains its admission policy; Keep/Release use W5's current pending-deletion classification.
    if (
      matchingManifest
        ? recordedDeletionPending
        : (await filterBlockingDestructiveRecoveries(blockingInspection)).some(
            (entry) => entry.operation === 'workspace-delete',
          )
    ) {
      diagnosis.check = 'project-deletion-pending';
      return description;
    }
    if (matchingManifest) {
      description.retained.committedArchive = {
        presence: 'present',
        verification: 'unverified',
      };
      description.code = 'external.worktree_recovery_cleanup';
      // A manifest is not verification of its files, snapshots or chats.
      if (matchingManifest.version === 3)
        description.retained.stagedCopy = await stagedCopyFact(
          workspaceId,
          worktreeId,
          matchingManifest.recovery,
        );
      try {
        const chats = await lstat(
          getArchivedContainerChatsPath(workspaceId, worktreeId),
        );
        if (chats.isFile() && !chats.isSymbolicLink())
          description.retained.chats = {
            presence: 'present',
            verification: 'unverified',
          };
      } catch {
        // A missing projection does not establish that canonical chats are gone.
      }
    }

    const staged = await readArchivedContainerRecoveryJournal(
      workspaceId,
      worktreeId,
    );
    if (!matchingManifest && staged?.createdAt === expectedCreatedAt)
      description.retained.stagedCopy = await stagedCopyFact(
        workspaceId,
        worktreeId,
        staged.recovery,
      );

    const config = await readWorkspaceConfigDetailed(workspaceId);
    if (
      config.authority !== 'ok' ||
      config.config.type === 'cowork' ||
      !isWritableScope(workspaceId)
    ) {
      diagnosis.check =
        config.authority !== 'ok'
          ? 'configuration-unreadable'
          : config.config.type === 'cowork'
            ? 'unsupported-workspace'
            : 'read-only-scope';
      return description;
    }
    if (matchingManifest?.version === 2)
      description.retained.gitSnapshot = await snapshotFacts(
        workspaceId,
        worktreeId,
        row ?? matchingManifest.originalWorktree,
        config.config,
        matchingManifest,
      );

    assertWorktreeRemovalAdmitted(
      workspaceId,
      worktreeId,
      'archiving the worktree',
    );
    const blocking = (
      await filterBlockingDestructiveRecoveries(
        blockingInspection,
        worktreeId,
        true,
      )
    ).filter(
      (entry) =>
        matchingManifest ||
        entry.operation !== 'workspace-delete' ||
        entry.state !== 'completed',
    );
    const targetCopies = blocking.filter(
      (entry) => entry.operationId === record.operationId,
    );
    // The reread can observe a newer copy that the validated snapshot lacked.
    if (
      targetCopies.length !== operation.copies ||
      targetCopies.some((entry) => !isDeepStrictEqual(entry, record))
    ) {
      const [firstCopy] = targetCopies;
      const check =
        firstCopy !== undefined &&
        targetCopies.some((entry) => !isDeepStrictEqual(entry, firstCopy))
          ? 'conflicting-journal-copies'
          : 'inspection-incomplete';
      diagnosis.check = check;
      description.check = check;
      return description;
    }
    if (blocking.some((entry) => entry.operationId !== record.operationId)) {
      diagnosis.check = 'stranded-journal-scan';
      description.check = 'stranded-journal-scan';
      return description;
    }
    if (
      !matchingManifest &&
      (await findWorktreeArchiveSourceRefusal(
        workspaceId,
        [worktreeId],
        config.config.type,
      ))
    ) {
      diagnosis.check = 'source-refused';
      return description;
    }
    if (
      matchingManifest &&
      (await canFinishArchiveCleanup(
        record,
        expectedCreatedAt,
        matchingManifest.version,
      ))
    ) {
      const refused = await checkArchiveFinishAdmission(
        operation,
        readReceipts,
      );
      if (refused) {
        diagnosis.check = refused;
        return description;
      }
      diagnosis.verdict =
        record.state === 'completed'
          ? record.cleanupRequired && !row
            ? 'cleanup-debt'
            : 'refused'
          : row
            ? 'finish-tail'
            : 'finish-journal';
      diagnosis.check =
        record.state === 'completed'
          ? record.cleanupRequired
            ? 'completed-cleanup-required'
            : 'already-completed'
          : 'committed-cleanup-only';
    } else if (!manifest && record.state !== 'completed') {
      if (
        !(await areOwnedPathsUnreplaced(
          record,
          unverifiable
            ? getWorktreeDataDir(workspaceId, worktreeId)
            : undefined,
        ))
      ) {
        diagnosis.check = 'identity-unverified';
        return description;
      }
      // A failed/pending rename is not proof of pre-quarantine, even if its paths vanished.
      const preQuarantine = new Set([
        'teardown-script',
        'live-state-teardown',
        'retained-payload-capture',
        'git-capture',
        'provider-capture',
        'file-quarantine',
      ]);
      const git = await readArchivedGitStagedDescriptor(
        workspaceId,
        worktreeId,
        { recoveryOnly: true, readOnly: true },
      );
      const quarantine = await directoryFact(
        join(dirname(checkout), `.${basename(checkout)}.archive-quarantine`),
      );
      if (
        !record.steps.every((step) => preQuarantine.has(step.phase)) ||
        (unverifiable ? git !== null : git?.teardown) ||
        quarantine.presence !== 'absent' ||
        (staged &&
          (staged.createdAt !== expectedCreatedAt ||
            staged.phase !== 'captured' ||
            (checkoutIdentity !== null &&
              !matchesRecordedDirectoryIdentity(
                staged.identity,
                checkoutIdentity,
                hostOperatingSystem(),
              ))))
      ) {
        diagnosis.check = unverifiable
          ? 'identity-unverified'
          : 'quarantine-unqualified';
      } else if (
        (row && description.retained.checkout.verification === 'verified') ||
        (!row && checkoutIdentity === null)
      ) {
        try {
          // Resolution normalizes every receipt, not just this operation's.
          await assertReceiptsNormalizable();
          try {
            await admitArchiveResolutionOffer(
              operation,
              row ? 'keep-worktree' : 'release',
              resolutionInspection,
              readReceipts,
              { journals: scan, blocking: blockingInspection },
            );
            diagnosis.verdict = row ? 'keep-worktree' : 'release';
            diagnosis.check = row
              ? 'pre-quarantine-listed-live'
              : 'pre-quarantine-row-and-checkout-absent';
          } catch {
            diagnosis.check = 'resolution-not-admitted';
          }
        } catch {
          diagnosis.check = 'recovery-receipts-unreadable';
        }
      } else diagnosis.check = 'mixed-or-unverified-occupancy';
    }
    if (record.state === 'completed' || record.cleanupRepair !== undefined) {
      if (diagnosis.check === 'not-admitted')
        diagnosis.check =
          record.state === 'completed'
            ? 'already-completed'
            : 'cleanup-repair-pending';
      description.actions.retry = { eligible: false, reason: 'not-admitted' };
      description.actions.finishArchive = {
        eligible: false,
        reason: 'not-admitted',
      };
      return description;
    }
    // Execution still uses the current slot. Historical diagnosis must not authorize overwriting it.
    if (operation.slot !== 'same-operation') {
      diagnosis.check = 'slot-not-current';
      return description;
    }
    // Desktop/Portal Delete also retains an unlocked archive. Intent is not the lifecycle operation.
    if (
      row &&
      (await canAdmitInterruptedArchive(record, {
        operation: 'worktree-archive',
        worktreeId,
        createdAt: expectedCreatedAt,
      }))
    ) {
      try {
        await assertNoArchiveResolution(
          workspaceId,
          worktreeId,
          undefined,
          readReceipts,
        );
        description.actions.retry = { eligible: true };
        description.code = 'external.worktree_recovery_retryable';
        if (diagnosis.verdict === 'refused') {
          diagnosis.verdict = 'retry';
          diagnosis.check = 'existing-retry-admission';
        }
      } catch {
        description.actions.retry = { eligible: false, reason: 'not-admitted' };
      }
    } else
      description.actions.retry = { eligible: false, reason: 'not-admitted' };
    // The service takes this route only after standalone/child redo is excluded.
    if (
      matchingManifest &&
      !canResumeInterruptedArchive(record) &&
      !canResumeFailedChildArchive(record) &&
      (row ||
        record.steps.some(
          (entry) => entry.phase === 'canonical-row-removal',
        )) &&
      (await canFinishArchiveCleanup(
        record,
        expectedCreatedAt,
        matchingManifest.version,
      ))
    )
      description.actions.finishArchive = { eligible: true };
    else
      description.actions.finishArchive = {
        eligible: false,
        reason: 'not-admitted',
      };
  } catch (inspectionError) {
    if (description.diagnosis) {
      description.diagnosis.verdict = 'refused';
      description.diagnosis.check = 'inspection-incomplete';
    }
    const unreadable = recoveryFromRefusal(request, inspectionError);
    if (unreadable.destination.kind === 'journal-review') return unreadable;
    // Set aside rests on journal facts alone; only a journal read failure withdraws it.
    if (unreadable.code === 'external.worktree_recovery_unreadable')
      description.actions.setAside = { eligible: false, reason: 'unavailable' };
    // Retain facts already observed, but withdraw actions on an incomplete read.
    description.actions.retry = { eligible: false, reason: 'unavailable' };
    description.actions.finishArchive = {
      eligible: false,
      reason: 'unavailable',
    };
    if (description.code === 'external.worktree_recovery_retryable')
      description.code = 'external.worktree_recovery_required';
  }
  if (description.diagnosis?.verdict === 'keep-worktree')
    description.actions.keepWorktree = { eligible: true };
  return description;
}

/** Live operation enumeration is independent of the cold W5 ownership gate and canonical rows. */
export async function listWorktreeRecovery(
  request: WorktreeRecoveryListParams,
  // Presentation supplies sidebar admission; Finish needs only the diagnosis reads.
  describeDiscard?: (
    workspaceId: string,
    worktreeId: string,
    options: {
      recovery: WorktreeRecoveryRequest;
      includeRecoveryDiagnosis: false;
    },
  ) => Promise<WorktreeDiscardDescription>,
  // Set aside opts in to exact contents for its selected operation.
  resolutionInspection: 'metadata' | 'contents' = 'metadata',
): Promise<WorktreeRecoveryListResult> {
  recordMetadataWork('recovery.list');
  // CAN-6948: a running archive is `active` on disk but needs no review. An
  // owner joins before its first save and leaves after its last, so sampling
  // both sides of the scan misses no archive that ran during it.
  const running = new Set(inFlightDestructiveOperationIds());
  const scan = await readArchiveJournalOperations(request.workspaceId);
  for (const id of inFlightDestructiveOperationIds()) running.add(id);
  const entries: WorktreeRecoveryDescription[] = [];
  let discardRows:
    | ReturnType<typeof readWorkspaceWorktreesDetailed>
    | undefined;
  // Share success and refusal only within this list, never across calls.
  let receiptPreflight: Promise<void> | undefined;
  let receipts: Promise<ArchiveRecoveryReceipt[]> | undefined;
  let blockingInspection: Promise<DestructiveRecoveryRecord[]> | undefined;
  const readBlockingInspection = (): Promise<DestructiveRecoveryRecord[]> => {
    // Offers share evidence only for this refresh; writers still rescan under fences.
    blockingInspection ??= readBlockingDestructiveRecoveries(
      request.workspaceId,
      undefined,
      true,
    );
    return blockingInspection;
  };
  const readReceipts = (): Promise<ArchiveRecoveryReceipt[]> => {
    receipts ??= readArchiveRecoveryHolds(request.workspaceId);
    return receipts;
  };
  const assertReceiptsNormalizable = (): Promise<void> => {
    receiptPreflight ??= archiveRecoveryStore().assertWorkspaceNormalizable(
      request.workspaceId,
    );
    return receiptPreflight;
  };
  for (const operation of scan.operations) {
    // A caller that names the operation still gets its description.
    if (!request.operationId && running.has(operation.record.operationId))
      continue;
    // A completed/delete representative must not hide a conflicting archive copy.
    const record = operation.records.find(
      (entry) =>
        entry.workspaceId === request.workspaceId &&
        entry.operation === 'worktree-archive' &&
        entry.worktreeId &&
        needsDestructiveRecovery(entry) &&
        (!request.operationId || entry.operationId === request.operationId),
    );
    if (!record?.worktreeId) continue;
    const context: WorktreeRecoveryContext = {
      workspaceId: request.workspaceId,
      worktreeId: record.worktreeId,
      expectedCreatedAt: record.createdAt ?? null,
      intent: 'archive',
      operationId: record.operationId,
    };
    const description = await describeWorktreeRecoveryFromInspection(
      context,
      undefined,
      resolutionInspection,
      undefined,
      scan,
      assertReceiptsNormalizable,
      readReceipts,
      readBlockingInspection,
    );
    entries.push(description);
    if (
      !describeDiscard ||
      !scan.readable ||
      !operation.consistent ||
      operation.slot !== 'same-operation' ||
      !record.createdAt ||
      description.destination.kind !== 'recovery'
    )
      continue;
    try {
      discardRows ??= readWorkspaceWorktreesDetailed(request.workspaceId, {
        persistRemovalCleanup: false,
      });
      const list = await discardRows;
      if (
        list.authority !== 'ok' ||
        !list.worktrees.some(
          (row) =>
            row.id === record.worktreeId && row.createdAt === record.createdAt,
        )
      )
        continue;
      const discard = await describeDiscard(
        request.workspaceId,
        record.worktreeId,
        {
          includeRecoveryDiagnosis: false,
          recovery: {
            intent: context.intent,
            expectedCreatedAt: context.expectedCreatedAt,
            operationId: context.operationId,
          },
        },
      );
      description.actions.discard = await discardAction(
        context,
        discard,
        readReceipts,
      );
    } catch {
      description.actions.discard = { eligible: false, reason: 'unavailable' };
    }
  }
  try {
    const resolutions = (await readReceipts())
      .filter(
        (receipt) =>
          !receipt.cancelled &&
          (!request.operationId || receipt.operationId === request.operationId),
      )
      .map((receipt) => ({
        operationId: receipt.operationId,
        worktreeId: receipt.worktreeId,
        createdAt: receipt.createdAt,
        action: receipt.action,
        revision: receipt.revision,
        stage: receipt.stage,
        retention: receipt.retention,
        retainedSnapshots:
          receipt.retention === 'deleted'
            ? 0
            : receipt.repositories.reduce(
                (total, repository) => total + repository.refs.length,
                0,
              ),
        retainedPayload:
          receipt.retention !== 'deleted' && receipt.staging !== null,
      }));
    return {
      entries,
      resolutions,
      check: scan.readable ? 'ok' : 'journal-evidence-unreadable',
    };
  } catch {
    return {
      entries,
      check: scan.readable ? 'ok' : 'journal-evidence-unreadable',
      unreadableEvidence: 'receipts',
    };
  }
}
