import type {
  WorktreeRecoveryListParams,
  WorktreeRecoveryListResult,
} from '@canopy/protocol/canopy-core';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readArchiveJournalOperations } from './stranded-archive-journals';
import { validateId } from './validation';
import {
  unavailableWorktreeRecovery,
  worktreeRecoveryStoppingPoint,
  type WorktreeRecoveryDescription,
  type WorktreeRecoveryRequest,
  type WorktreeRecoveryAsset,
} from '@canopy/protocol/portal/worktree-recovery';
import type { WorktreeDiscardDescription } from '@canopy/protocol/portal/worktree-discard';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { assertWorktreeCanBeRemoved } from '../agents/background-work';
import {
  assertNotSplitLocked,
  hasWorkspaceDeletionLease,
  assertNotSplitDestinationWorktreeClaimed,
} from '../services/split-lock-service';
import { destructiveFailureRecord } from './destructive-failure-context';
import {
  canAdmitInterruptedArchive,
  canFinishArchiveCleanup,
  canResumeFailedChildArchive,
  canResumeInterruptedArchive,
  isRecoveryProjectUnreplaced,
  isDestructiveRecoveryOwnerless,
  isVerifiedProtectedPathIdentity,
  journalDirectoryUnreadable,
  areOwnedPathsUnreplaced,
  readBlockingDestructiveRecoveries,
  readDirectoryStatIdentity,
  statIdentityOf,
  type DestructiveRecoveryRecord,
} from './w5-destructive-recovery';
import { findWorktreeArchiveSourceRefusal } from './worktree-service';
import { readArchivedContainerManifestIncludingExpired } from './archived-containers';
import {
  getArchivedContainerDir,
  getArchivedContainerChatsPath,
  getWorkspaceWorktreeDir,
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
  buildArchivedContainerSnapshotRef,
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
        captured.snapshotRef !==
          buildArchivedContainerSnapshotRef(
            workspaceId,
            worktreeId,
            source.repoId,
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
): Promise<WorktreeRecoveryDescription> {
  return describeWorktreeRecoveryFromInspection(request, discard, error);
}

async function describeWorktreeRecoveryFromInspection(
  request: WorktreeRecoveryContext,
  discard: WorktreeDiscardDescription | undefined,
  error?: unknown,
  inspection?: Awaited<ReturnType<typeof readArchiveJournalOperations>>,
): Promise<WorktreeRecoveryDescription> {
  const description = recoveryFromRefusal(request, error);
  if (description.destination.kind === 'journal-review') return description;
  // Discard admission is independent of lifecycle evidence and row presence.
  description.actions.discard =
    request.expectedCreatedAt !== null &&
    discard?.workspaceId === request.workspaceId &&
    discard.worktreeId === request.worktreeId &&
    discard.createdAt === request.expectedCreatedAt &&
    discard.status === 'discardable'
      ? { eligible: true }
      : { eligible: false, reason: 'not-admitted' };
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
    )
      return description;
    if (record.operation !== 'worktree-archive' || record.state === 'active') {
      diagnosis.check =
        record.state === 'active' ? 'raw-active' : 'not-archive';
      return description;
    }
    if (!isDestructiveRecoveryOwnerless(record)) {
      diagnosis.check = 'operation-owned';
      return description;
    }
    if (hasWorkspaceDeletionLease(request.workspaceId)) {
      diagnosis.check = 'project-deletion-pending';
      return description;
    }
    for (const entry of scan.operations) {
      for (const deletion of entry.records) {
        if (
          deletion.workspaceId !== request.workspaceId ||
          deletion.operation !== 'workspace-delete' ||
          deletion.state === 'completed'
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
        diagnosis.check = 'project-deletion-pending';
        return description;
      }
    }
    const { workspaceId, worktreeId, expectedCreatedAt } = request;
    if (!expectedCreatedAt) return description;
    const list = await readWorkspaceWorktreesDetailed(workspaceId, {
      persistRemovalCleanup: false,
    });
    if (list.authority !== 'ok') return description;
    const row = list.worktrees.find((entry) => entry.id === worktreeId);
    if (row && row.createdAt !== expectedCreatedAt) return description;
    if (!(await isRecoveryProjectUnreplaced(record))) {
      diagnosis.check = 'identity-unverified';
      return description;
    }

    // Owned paths must still identify this incarnation before claiming its files.
    const checkout = getWorkspaceWorktreeDir(workspaceId, worktreeId);
    const checkoutIdentity = await readDirectoryStatIdentity(checkout).catch(
      () => undefined,
    );
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
      statIdentityOf(owned.identity) === checkoutIdentity
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
    const matchingManifest =
      manifest &&
      (manifest.version === 2 || manifest.version === 3) &&
      manifest.kind === 'worktree' &&
      manifest.createdAt === expectedCreatedAt &&
      manifest.originalWorktree.createdAt === expectedCreatedAt
        ? manifest
        : null;
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
    )
      return description;
    if (matchingManifest?.version === 2)
      description.retained.gitSnapshot = await snapshotFacts(
        workspaceId,
        worktreeId,
        row ?? matchingManifest.originalWorktree,
        config.config,
        matchingManifest,
      );

    if (record.state === 'completed') {
      diagnosis.verdict = record.cleanupRequired ? 'cleanup-debt' : 'refused';
      diagnosis.check = record.cleanupRequired
        ? 'completed-cleanup-required'
        : 'already-completed';
      return description;
    }
    assertNotSplitLocked(workspaceId, worktreeId, 'archiving the worktree');
    assertNotSplitDestinationWorktreeClaimed(
      workspaceId,
      worktreeId,
      'archiving the worktree',
    );
    assertWorktreeCanBeRemoved(workspaceId, worktreeId);
    const blocking = await readBlockingDestructiveRecoveries(
      workspaceId,
      worktreeId,
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
      await findWorktreeArchiveSourceRefusal(
        workspaceId,
        [worktreeId],
        config.config.type,
      )
    )
      return description;
    if (
      matchingManifest &&
      (await canFinishArchiveCleanup(
        record,
        expectedCreatedAt,
        matchingManifest.version,
      ))
    ) {
      diagnosis.verdict = row ? 'finish-tail' : 'finish-journal';
      diagnosis.check = 'committed-cleanup-only';
    } else if (!manifest) {
      if (!(await areOwnedPathsUnreplaced(record))) {
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
        git?.teardown ||
        quarantine.presence !== 'absent' ||
        (staged &&
          (staged.createdAt !== expectedCreatedAt ||
            staged.phase !== 'captured' ||
            (checkoutIdentity !== null &&
              staged.identity !== checkoutIdentity)))
      ) {
        diagnosis.check = 'quarantine-unqualified';
      } else if (
        row &&
        description.retained.checkout.verification === 'verified'
      ) {
        diagnosis.verdict = 'keep-worktree';
        diagnosis.check = 'pre-quarantine-listed-live';
      } else if (!row && checkoutIdentity === null) {
        diagnosis.verdict = 'release';
        diagnosis.check = 'pre-quarantine-row-and-checkout-absent';
      } else diagnosis.check = 'mixed-or-unverified-occupancy';
    }
    // Execution still uses the current slot. Historical diagnosis must not authorize overwriting it.
    if (operation.slot !== 'same-operation') return description;
    // Desktop/Portal Delete also retains an unlocked archive. Intent is not the lifecycle operation.
    if (
      row &&
      (await canAdmitInterruptedArchive(record, {
        operation: 'worktree-archive',
        worktreeId,
        createdAt: expectedCreatedAt,
      }))
    ) {
      description.actions.retry = { eligible: true };
      description.code = 'external.worktree_recovery_retryable';
      if (diagnosis.verdict === 'refused') {
        diagnosis.verdict = 'retry';
        diagnosis.check = 'existing-retry-admission';
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
    // Retain facts already observed, but withdraw actions on an incomplete read.
    description.actions.retry = { eligible: false, reason: 'unavailable' };
    description.actions.finishArchive = {
      eligible: false,
      reason: 'unavailable',
    };
    if (description.code === 'external.worktree_recovery_retryable')
      description.code = 'external.worktree_recovery_required';
  }
  return description;
}

/** Live operation enumeration is independent of the cold W5 ownership gate and canonical rows. */
export async function listWorktreeRecovery(
  request: WorktreeRecoveryListParams,
): Promise<WorktreeRecoveryListResult> {
  const scan = await readArchiveJournalOperations(request.workspaceId);
  if (!scan.readable)
    return { entries: [], check: 'journal-evidence-unreadable' };
  const entries: WorktreeRecoveryDescription[] = [];
  for (const operation of scan.operations) {
    // A completed/delete representative must not hide a conflicting archive copy.
    const record = operation.records.find(
      (entry) =>
        entry.workspaceId === request.workspaceId &&
        entry.operation === 'worktree-archive' &&
        entry.worktreeId &&
        (entry.state !== 'completed' || entry.cleanupRequired) &&
        (!request.operationId || entry.operationId === request.operationId),
    );
    if (!record?.worktreeId) continue;
    entries.push(
      await describeWorktreeRecoveryFromInspection(
        {
          workspaceId: request.workspaceId,
          worktreeId: record.worktreeId,
          expectedCreatedAt: record.createdAt ?? null,
          intent: 'archive',
          operationId: record.operationId,
        },
        undefined,
        undefined,
        scan,
      ),
    );
  }
  return { entries, check: 'ok' };
}
