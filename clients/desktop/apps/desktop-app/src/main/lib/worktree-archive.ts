import {
  withArchiveFailureTelemetry,
  type ArchiveTrigger,
  type ArchiveFailureTelemetryOptions,
} from './archive-failure-telemetry';
import { WorktreeArchiveRefusedError } from './worktree-archive-refusal';
import {
  assertNoDestructiveRecovery,
  assertNoLegacyArchiveRecovery,
  readDestructiveRecovery,
  findCompletedDestructiveArchive,
  destructiveArchiveOutcomeSchema,
} from './w5-destructive-recovery';
import { z } from 'zod';
import {
  checkW5ExpectedRevision,
  runW5BoundaryOperation,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import {
  W5RevisionConflictError,
  type W5CommitOptions,
} from './w5-commit-log-file-store';
import {
  admitLifecycleJournals,
  type W5KeyedAttempt,
} from './w5-keyed-operation';
import { access } from 'node:fs/promises';
import type {
  ArchiveWorktreeResponse,
  ArchivedContainerManifest,
  CheckWorktreeRemovalAdmissionRequest,
  CheckWorktreeRemovalAdmissionResponse,
} from '@canopy/desktop-shared/types';
import { assertWorktreeCanBeRemoved } from '../agents/background-work';
import {
  assertNotSplitDestinationWorktreeClaimed,
  assertNotSplitLocked,
} from '../services/split-lock-service';
import { listArchivedContainerManifests } from './archived-containers';
import { isWorktreeArchiveSourceUnavailable } from './archived-container-recovery';
import { recordWorktreeCrudTelemetry } from './desktop-telemetry';
import { getWorkspaceWorktreeDir } from './paths';
import { validateId } from './validation';
import {
  WorkspaceTargetAutoArchiveExcludedError,
  withWorkspaceTargetAutoArchiveLease,
  withWorkspaceTargetAutoArchiveTeardown,
} from './workspace-target-exclusion';
import {
  isWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
} from './workspace-persistence';
import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from './worktree-live-cleanup';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  findWorktreeArchiveSourceRefusal,
  WORKTREE_ARCHIVE_SOURCE_UNAVAILABLE_MESSAGE,
} from './worktree-service';

/** The caller of an archive, recorded in worktree CRUD telemetry. */
export type WorktreeArchiveSource =
  | 'single_repo'
  | 'multi_repo'
  | 'portal'
  | 'workspace_delete'
  /** A registered archive or Delete wire call (W7b-2a/2b). */
  | 'desktop_canopy_client';

export interface WorktreeArchiveRequest {
  expectedRevision?: number;
  workspaceId: string;
  worktreeId: string;
  source: WorktreeArchiveSource;
  archiveTrigger?: ArchiveTrigger;
  /** Refuse unless the project is of this kind (the IPC channels are per kind). */
  expectedKind?: 'single-repo' | 'multi-repo';
  /** The incarnation the caller saw; a repeat matches only that one. */
  expectedCreatedAt?: string;
  expectedBranchName?: string;
  deleteBranch?: boolean;
  /** Commit the retained archive with retention locking already enabled. */
  lockAfterArchive?: boolean;
  /** Delete without retention only when the worktree path is missing. */
  deleteWithoutRetentionIfMissing?: boolean;
  remainingWorktreeOrder?: readonly string[];
  expectedRemainingWorktreeOrder?: readonly string[];
  /** Single-repo only: must match the project's repository. */
  repoPath?: string;
  /**
   * Run the configured teardown scripts inside the archive, under an
   * exclusive lease that keeps new runtimes out of the worktree; a failure
   * message names this operation. A worktree already being deleted or
   * starting a runtime is refused as `busy`.
   */
  teardownOperation?: string;
}

export type WorktreeArchiveOutcome = ArchiveWorktreeResponse & {
  /**
   * `already-archived`: the worktree was archived or deleted before, so this
   * call had no effect (CAN-3799 B5).
   */
  status: 'archived' | 'already-archived';
};

export {
  WorktreeArchiveRefusedError,
  type WorktreeArchiveRefusal,
} from './worktree-archive-refusal';

function archivedThisIncarnation(
  manifest: ArchivedContainerManifest,
  worktreeId: string,
  expectedCreatedAt: string | undefined,
): boolean {
  const original = manifest.originalWorktree;
  return (
    original?.id === worktreeId &&
    (expectedCreatedAt === undefined ||
      original.createdAt === expectedCreatedAt)
  );
}

async function checkoutExists(
  workspaceId: string,
  worktreeId: string,
): Promise<boolean> {
  try {
    await access(getWorkspaceWorktreeDir(workspaceId, worktreeId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a worktree that is no longer in the list was archived before: a
 * retained archive holds it, or this process deleted it without retention.
 * Unreadable or incomplete archive directories are skipped.
 */
async function wasArchived(request: WorktreeArchiveRequest): Promise<boolean> {
  if (
    isWorkspaceWorktreeRecentlyRemoved(
      request.workspaceId,
      request.worktreeId,
      request.expectedCreatedAt,
    )
  ) {
    return true;
  }
  const manifests = await listArchivedContainerManifests(request.workspaceId);
  return manifests.some((manifest) =>
    archivedThisIncarnation(
      manifest,
      request.worktreeId,
      request.expectedCreatedAt,
    ),
  );
}

/**
 * Run an archive with the configured teardown scripts, as Auto Delete does:
 * the lease refuses a worktree that is starting a runtime or already being
 * deleted, and keeps new runtimes out until the archive ends, while the
 * teardown it owns may still start its scripts.
 */
async function archiveWithTeardown(
  workspaceId: string,
  worktreeId: string,
  multiRepo: boolean,
  operation: string,
  archive: (
    runAutoArchiveTeardown: () => Promise<void>,
  ) => Promise<ArchiveWorktreeResponse>,
): Promise<ArchiveWorktreeResponse> {
  try {
    return await withWorkspaceTargetAutoArchiveLease(
      workspaceId,
      worktreeId,
      () =>
        archive(() =>
          withWorkspaceTargetAutoArchiveTeardown(
            workspaceId,
            worktreeId,
            async () => {
              // Loaded on use, as Auto Delete does: the script runner is heavy.
              const { runAutoArchiveTeardown } =
                await import('./auto-archive-teardown');
              await runAutoArchiveTeardown(
                workspaceId,
                worktreeId,
                multiRepo,
                operation,
              );
            },
          ),
        ),
    );
  } catch (error) {
    if (error instanceof WorkspaceTargetAutoArchiveExcludedError) {
      throw new WorktreeArchiveRefusedError(
        'busy',
        'A worktree is busy. Retry after it finishes.',
      );
    }
    throw error;
  }
}

/**
 * The typed in-process worktree archive boundary (CAN-3811), behind the
 * renderer's single- and multi-repo archive channels and the Portal's
 * `portal.worktree.archive`. It checks the project kind, the split and
 * delegation safeguards, and whether the worktree still exists before any
 * effect, then runs the desktop archive lifecycle with live cleanup: a
 * retained container unless the caller asked for a deletion without
 * retention. A repeat of a completed archive succeeds with no effect, and an
 * unknown worktree is refused (CAN-3799 B5). An optional row revision applies
 * only to the first transition (CAN-3805); restore stays on the archive.
 */
export function archiveWorktree(
  request: WorktreeArchiveRequest,
  telemetry?: ArchiveFailureTelemetryOptions,
): Promise<WorktreeArchiveOutcome> {
  return withArchiveFailureTelemetry(
    {
      ...request,
      archiveTrigger:
        request.archiveTrigger ??
        (request.source === 'workspace_delete' ? 'project-deletion' : 'manual'),
    },
    () =>
      archiveWorktreeTransition(request, {
        operation: 'core.worktree.archive',
      }),
    telemetry,
  );
}

/** Explicit keyed deletion; existing internal callers keep no container. */
export interface WorktreeDeleteRequest
  extends Omit<WorktreeArchiveRequest, 'lockAfterArchive'>, W5BoundaryOptions {
  /** P-1(i): retain an unlocked container, as the desktop Delete button does. */
  retainAsArchivedContainer?: boolean;
}

const archiveOutcomeSchema = destructiveArchiveOutcomeSchema.extend({
  status: z.enum(['archived', 'already-archived']),
});

/** A wire call addresses only after receipt lookup and before reservation. */
export interface WorktreeDeleteWireCall {
  readonly caller: string;
  readonly archiveTrigger?: ArchiveTrigger;
  readonly idempotencyKey: string;
  readonly parameters: unknown;
  readonly resolveRequest: () => Promise<WorktreeDeleteRequest>;
}

export async function deleteWorktree(
  input: WorktreeDeleteRequest | WorktreeDeleteWireCall,
): Promise<WorktreeArchiveOutcome> {
  let addressed = 'resolveRequest' in input ? undefined : input;
  return withArchiveFailureTelemetry(
    () =>
      addressed
        ? {
            ...addressed,
            archiveTrigger:
              addressed.archiveTrigger ??
              (addressed.source === 'workspace_delete'
                ? 'project-deletion'
                : 'manual'),
          }
        : { archiveTrigger: input.archiveTrigger },
    () =>
      deleteWorktreeAdmitted(input, (request) => {
        addressed = request;
      }),
  );
}

async function deleteWorktreeAdmitted(
  input: WorktreeDeleteRequest | WorktreeDeleteWireCall,
  onAddressed: (request: WorktreeDeleteRequest) => void,
): Promise<WorktreeArchiveOutcome> {
  const direct = 'resolveRequest' in input ? undefined : input;
  const wire = 'resolveRequest' in input ? input : undefined;
  let admitted: WorktreeDeleteRequest | undefined;
  const validate = (request: WorktreeDeleteRequest): void => {
    validateId(request.workspaceId, 'workspaceId');
    validateId(request.worktreeId, 'worktreeId');
  };
  if (direct) validate(direct);
  const parameters = (request: WorktreeDeleteRequest): unknown => {
    const {
      expectedRevision: _revision,
      idempotencyKey: _key,
      archiveTrigger: _trigger,
      ...rest
    } = request;
    void _revision;
    void _key;
    void _trigger;
    return rest;
  };
  return runW5BoundaryOperation(
    {
      operation: 'core.worktree.delete',
      caller:
        'resolveRequest' in input
          ? input.caller
          : `desktop-host:${input.source}`,
      idempotencyKey: input.idempotencyKey,
      parameters:
        'resolveRequest' in input ? input.parameters : parameters(input),
      ...(wire && {
        admit: async (): Promise<void> => {
          admitted = await wire.resolveRequest();
          onAddressed(admitted);
          validate(admitted);
        },
      }),
      isPreEffectRefusal: (error) =>
        error instanceof WorktreeArchiveRefusedError ||
        error instanceof W5RevisionConflictError,
    },
    (outcome) => archiveOutcomeSchema.parse(outcome),
    async (options, attempt) => {
      const request = direct ?? admitted;
      if (!request) throw new Error('Worktree deletion was not addressed.');
      return withArchiveFailureTelemetry(
        {
          ...request,
          archiveTrigger:
            request.archiveTrigger ??
            (request.source === 'workspace_delete'
              ? 'project-deletion'
              : 'manual'),
        },
        async () => {
          const {
            expectedRevision,
            retainAsArchivedContainer,
            idempotencyKey: _key,
            ...fields
          } = request;
          void _key;
          const pending = await admitLifecycleJournals(attempt, () =>
            readDestructiveRecovery(request.workspaceId, request.worktreeId),
          );
          // Retained repeats skip a stale revision: the transition checks it
          // only while the live incarnation is still present (A3(a)).
          if (
            retainAsArchivedContainer !== true &&
            (!pending || pending.state === 'completed')
          ) {
            await checkW5ExpectedRevision(
              {
                kind: 'worktree',
                workspaceId: request.workspaceId,
                worktreeId: request.worktreeId,
              },
              expectedRevision,
            );
          }
          return archiveWorktreeTransition(
            { ...fields, expectedRevision },
            options,
            attempt,
            retainAsArchivedContainer ?? false,
          );
        },
        { telemetryParent: 'inherit' },
      );
    },
  );
}

async function archiveWorktreeTransition(
  request: WorktreeArchiveRequest,
  w5Commit: W5CommitOptions,
  attempt?: W5KeyedAttempt,
  retainAsArchivedContainer?: boolean,
): Promise<WorktreeArchiveOutcome> {
  const { workspaceId, worktreeId } = request;
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  for (const order of [
    request.remainingWorktreeOrder,
    request.expectedRemainingWorktreeOrder,
  ]) {
    order?.forEach((id, index) => {
      validateId(id, `worktree order[${index}]`);
    });
  }

  // Read-only journal refusals release a keyed reservation; the locked
  // service's own refusals follow its fences and keep it.
  const journals = <T>(read: () => Promise<T>): Promise<T> =>
    admitLifecycleJournals(attempt, read);
  const unfinished = await journals(() =>
    readDestructiveRecovery(workspaceId, worktreeId),
  );
  const needsCleanupRecovery =
    unfinished !== null && unfinished.state !== 'completed';
  // The locked service validates recovery before any effects; ordinary admission
  // and completed-outcome replay keep the existing refusal behavior.
  if (!needsCleanupRecovery)
    await journals(() => assertNoDestructiveRecovery(workspaceId, worktreeId));
  const recovery = await journals(() =>
    findCompletedDestructiveArchive(
      workspaceId,
      worktreeId,
      request.expectedCreatedAt,
    ),
  );
  const { config, authority } = await readWorkspaceConfigDetailed(workspaceId);
  // An unreadable config reads as a default multi-repo one, so only an
  // authoritative read decides the kind; otherwise the caller's channel does,
  // and the archive lifecycle reports the unreadable config itself.
  const kind =
    authority === 'ok' ? config.type : (request.expectedKind ?? config.type);
  if (kind === 'cowork') {
    throw new WorktreeArchiveRefusedError(
      'unsupported-workspace',
      'Cannot archive a worktree in a cowork project.',
    );
  }
  if (request.expectedKind !== undefined && kind !== request.expectedKind) {
    throw new WorktreeArchiveRefusedError(
      'kind-mismatch',
      'Cannot archive the worktree because the project is not the expected kind.',
    );
  }
  const rows = await readWorkspaceWorktrees(workspaceId, {
    persistRemovalCleanup: false,
  });
  const current = rows.find((worktree) => worktree.id === worktreeId);
  if (!current && !needsCleanupRecovery) {
    // A row can leave the list while its checkout stays, as a needs-repair
    // rollback does; the archive lifecycle still tears that checkout down.
    if (!(await checkoutExists(workspaceId, worktreeId))) {
      if (recovery || (await wasArchived(request))) {
        return {
          ...(recovery?.state === 'completed'
            ? archiveOutcomeSchema.parse({
                ...destructiveArchiveOutcomeSchema.parse(recovery.outcome),
                status: 'already-archived',
              })
            : { success: true, warnings: [] }),
          status: 'already-archived',
        };
      }
      throw new WorktreeArchiveRefusedError('not-found', 'Worktree not found.');
    }
  } else if (
    request.expectedCreatedAt !== undefined &&
    current?.createdAt !== request.expectedCreatedAt &&
    !needsCleanupRecovery &&
    (recovery || (await wasArchived(request)))
  ) {
    // The caller's incarnation is archived; a newer one under the same id is
    // left alone.
    return {
      ...(recovery?.state === 'completed'
        ? archiveOutcomeSchema.parse({
            ...destructiveArchiveOutcomeSchema.parse(recovery.outcome),
            status: 'already-archived',
          })
        : { success: true, warnings: [] }),
      status: 'already-archived',
    };
  }

  if (
    current &&
    request.expectedCreatedAt !== undefined &&
    current.createdAt !== request.expectedCreatedAt
  ) {
    throw new WorktreeArchiveRefusedError(
      'not-found',
      `Worktree ${worktreeId} changed after archive was requested`,
    );
  }

  // The guards apply only to a call that runs the archive lifecycle: a retry
  // for an archived incarnation has no effect, whatever a newer one is doing.
  // Split PR lockdown: removing the checkout under a running or review-phase
  // split would strand the split map and its branches.
  // Read-only refusals release a keyed reservation for a retry.
  const admit = (check: () => void): void =>
    attempt ? attempt.validate(check) : check();
  admit(() => {
    assertNotSplitLocked(workspaceId, worktreeId, 'archiving the worktree');
    assertNotSplitDestinationWorktreeClaimed(
      workspaceId,
      worktreeId,
      'archiving the worktree',
    );
    // Live delegates or close-blocking background work keep the worktree.
    assertWorktreeCanBeRemoved(workspaceId, worktreeId);
  });

  // Archive journals may advance the row during teardown. The caller revision
  // guards the first transition, before those internal operations and effects.
  if (!needsCleanupRecovery)
    await checkW5ExpectedRevision(
      { kind: 'worktree', workspaceId, worktreeId },
      request.expectedRevision,
    );
  const options = {
    archiveTrigger:
      request.archiveTrigger ??
      (request.source === 'workspace_delete' ? 'project-deletion' : 'manual'),
    w5Commit: {
      ...w5Commit,
      expectedRevisions: w5ExpectedRevision(
        { kind: 'worktree', workspaceId, worktreeId },
        needsCleanupRecovery ? undefined : request.expectedRevision,
      ),
    },
    ...(retainAsArchivedContainer === undefined
      ? {}
      : { retainAsArchivedContainer }),
    workspaceId,
    worktreeId,
    expectedCreatedAt: request.expectedCreatedAt ?? current?.createdAt,
    ...(request.expectedBranchName !== undefined
      ? { expectedBranchName: request.expectedBranchName }
      : {}),
    ...(request.deleteBranch !== undefined
      ? { deleteBranch: request.deleteBranch }
      : {}),
    ...(request.lockAfterArchive !== undefined
      ? { lockAfterArchive: request.lockAfterArchive }
      : {}),
    ...(request.deleteWithoutRetentionIfMissing !== undefined
      ? {
          deleteWithoutRetentionIfMissing:
            request.deleteWithoutRetentionIfMissing,
        }
      : {}),
    ...(request.remainingWorktreeOrder !== undefined
      ? { remainingWorktreeOrder: request.remainingWorktreeOrder }
      : {}),
    ...(request.expectedRemainingWorktreeOrder !== undefined
      ? {
          expectedRemainingWorktreeOrder:
            request.expectedRemainingWorktreeOrder,
        }
      : {}),
    sourceAdmission: 'required' as const,
    observabilityMode: 'live-service' as const,
    liveServices: {
      cleanupLiveState: cleanupLiveWorktreeState,
      purgeObservabilityData: purgeLiveWorktreeObservabilityData,
    },
  };
  const archive = (
    runAutoArchiveTeardown?: () => Promise<void>,
  ): Promise<ArchiveWorktreeResponse> => {
    // After the teardown lease is admitted: a busy refusal touches nothing.
    const teardown = runAutoArchiveTeardown ? { runAutoArchiveTeardown } : {};
    return kind === 'multi-repo'
      ? archiveMultiRepoWorktree(
          { ...options, ...teardown },
          { telemetryParent: 'inherit' },
        )
      : archiveSingleRepoWorktree(
          {
            ...options,
            ...teardown,
            ...(request.repoPath !== undefined
              ? { repoPath: request.repoPath }
              : {}),
          },
          { telemetryParent: 'inherit' },
        );
  };
  const { teardownOperation } = request;
  const response =
    teardownOperation === undefined
      ? await archive()
      : await archiveWithTeardown(
          workspaceId,
          worktreeId,
          kind === 'multi-repo',
          teardownOperation,
          archive,
        );
  recordWorktreeCrudTelemetry({
    action: 'archive',
    workspaceId,
    source: request.source,
  });
  return { status: 'archived', ...response };
}

/**
 * The source admission {@link archiveWorktree} and {@link deleteWorktree} run
 * (CAN-5158), read-only, for several worktrees at once, so the renderer can
 * refuse before its own removal effects (CAN-5333). It reserves nothing: the
 * archive admits again. Other refusals stay with the archive.
 */
export async function checkWorktreeRemovalAdmission(
  request: CheckWorktreeRemovalAdmissionRequest,
): Promise<CheckWorktreeRemovalAdmissionResponse> {
  const { workspaceId, worktreeIds } = request;
  validateId(workspaceId, 'workspaceId');
  worktreeIds.forEach((id, index) => {
    validateId(id, `worktreeIds[${index}]`);
  });
  if (worktreeIds.length === 0) return { status: 'admitted' };
  const { config, authority } = await readWorkspaceConfigDetailed(workspaceId);
  // The same kind decision as the archive transition.
  const kind =
    authority === 'ok' ? config.type : (request.expectedKind ?? config.type);
  if (kind === 'cowork') return { status: 'admitted' };
  const refused = await findWorktreeArchiveSourceRefusal(
    workspaceId,
    worktreeIds,
    kind,
  );
  return refused === undefined
    ? { status: 'admitted' }
    : {
        status: 'refused',
        worktreeId: refused,
        reason: 'source-unavailable',
        message: WORKTREE_ARCHIVE_SOURCE_UNAVAILABLE_MESSAGE,
      };
}

/**
 * Read-only admission for {@link archiveWorkspaceWorktrees} (CAN-4985):
 * whether a worktree it would archive needs a source repository that Git
 * cannot open.
 */
export async function hasWorkspaceWorktreeWithUnavailableSource(
  workspaceId: string,
  kind: 'single-repo' | 'multi-repo',
): Promise<boolean> {
  const available = new Set<string>();
  for (const worktree of await readWorkspaceWorktrees(workspaceId, {
    persistRemovalCleanup: false,
  })) {
    if (
      await isWorktreeArchiveSourceUnavailable(
        workspaceId,
        worktree,
        kind,
        available,
      )
    )
      return true;
  }
  return false;
}

/**
 * Read-only admission for {@link archiveWorkspaceWorktrees} (CAN-4985): each
 * archive refuses an interrupted legacy archive before its lifecycle, and so
 * does this, for every worktree at once. A later worktree's refusal would
 * otherwise follow an earlier one's effects and leave the deletion's journal
 * requiring recovery.
 */
export async function assertWorkspaceWorktreesHaveNoLegacyArchiveRecovery(
  workspaceId: string,
): Promise<void> {
  for (const worktree of await readWorkspaceWorktrees(workspaceId, {
    persistRemovalCleanup: false,
  }))
    await assertNoLegacyArchiveRecovery(workspaceId, worktree.id, {
      admitMissingCheckoutCapture: true,
      readOnly: true,
    });
}

/**
 * Archive every worktree still in a code project's list before the project is
 * deleted (CAN-3799 B2), with its teardown scripts, live cleanup and a
 * retained archive, as an archive from the app does. A failure stops the
 * deletion before anything else is removed; worktrees archived before it stay
 * restorable. A worktree that left the list meanwhile is skipped.
 */
export async function archiveWorkspaceWorktrees(
  workspaceId: string,
  kind: 'single-repo' | 'multi-repo',
): Promise<void> {
  for (const worktree of await readWorkspaceWorktrees(workspaceId)) {
    try {
      await archiveWorktree(
        {
          workspaceId,
          worktreeId: worktree.id,
          source: 'workspace_delete',
          expectedKind: kind,
          expectedCreatedAt: worktree.createdAt,
          teardownOperation: 'Project deletion',
        },
        { telemetryParent: 'inherit' },
      );
    } catch (error) {
      if (
        error instanceof WorktreeArchiveRefusedError &&
        error.reason === 'not-found'
      ) {
        continue;
      }
      throw error;
    }
  }
}
