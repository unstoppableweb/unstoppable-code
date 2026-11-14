import {
  archiveRecoveryStore,
  readArchiveRecoveryHolds,
  assertNoArchiveResolution,
} from './archive-recovery-refs';
import {
  deleteArchiveRecoveryRefs,
  qualifyArchiveRecoveryRefDeletion,
} from './archived-container-git';
import { settleArchiveRecovery } from './archive-recovery-settlement';
import type { DestructiveRecoveryRecord } from './w5-destructive-recovery';
import { ArchiveRecoveryRefusedError } from '@canopy/desktop-shared/node/archive-recovery-store';
import { rememberDestructiveFailure } from './destructive-failure-context';
import {
  setArchiveFailurePhase,
  withArchiveFailureTelemetry,
} from './archive-failure-telemetry';
import { WorkspaceDeletionRefusedError } from './workspace-deletion-refusal';
export {
  WorkspaceDeletionRefusedError,
  type WorkspaceDeletionRefusal,
} from './workspace-deletion-refusal';
import {
  assertFailedChildArchivesResumed,
  prepareArchiveRecoveryCleanup,
  qualifyArchiveRecoveryCleanupParent,
  acknowledgeArchiveRecoveryCleanup,
  completeSupersededChildArchives,
  isStepFreeDestructiveFailure,
  readInFlightWorktreeDestructiveOperations,
  resumableDestructiveStep,
  runStepFreeChildLifecycles,
  withDestructiveLifecycle,
  withExclusiveLifecycleJournalAccess,
  withdrawInterruptedWorkspaceDeletion,
  destructiveStep,
  markDestructiveCleanupRequired,
  destructiveCleanup,
  protectDestructivePath,
  retryDeletedWorkspaceSearchCleanup,
} from './w5-destructive-recovery';
import { z } from 'zod';
import {
  checkW5ExpectedRevision,
  runW5BoundaryOperation,
  w5ExpectedRevision,
  type W5BoundaryOptions,
  type W5WireCall,
} from './w5-boundary-operation';
import {
  withW5Commit,
  desktopW5FileStore,
  W5RevisionConflictError,
  type W5CommitOptions,
} from './w5-commit-log-file-store';
import { afterW5Apply } from './w5-commit-scope';
import {
  admitLifecycleJournals,
  type W5KeyedAttempt,
} from './w5-keyed-operation';
import { rm } from 'node:fs/promises';
import { CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import {
  COWORK_HOME_WORKTREE_ID,
  isDefaultCoworkWorkspaceId,
  STANDALONE_CHAT_PROJECT_ID,
  type ArchivedContainerManifest,
  type ArchivedGitState,
  type SidebarItem,
  type SidebarItemsFile,
} from '@canopy/desktop-shared/types';
import {
  assertWorkspaceCanBeRemoved,
  assertWorktreeCanBeRemoved,
} from '../agents/background-work';
import {
  assertNoLiveDelegationsInWorkspace,
  assertNoLiveDelegationsInWorktree,
  LiveDelegationsError,
} from '../agents/delegation/activity';
import { destroyWorktreeSessions } from '../agents/session-manager';
import {
  captureLedgerWorkspaceIncarnations,
  notifyLedgerWorkspaceDeleted,
  type LedgerWorkspaceCapture,
} from '../ledger/lifecycle';
import { listWorkEntryIds } from './cowork-work-entries';
import { deleteCoworkWorkspace } from './cowork-workspace-crud';
import { recordWorkspaceCrudTelemetry } from './desktop-telemetry';
import { w5RecordReadPaths, getDefaultReposDir } from './paths';
import { isPathInside } from './path-safety';
import { cleanupUnreferencedRepoShadows } from './repo-shadow';
import { syncCodeGraphBaseRepositories } from './code-graph-base-manager';
import {
  cancelCodeGraphReadsForWorkspace,
  fenceCodeGraphReadsForWorkspace,
} from '../code-graph/read-runner';
import {
  readAllSidebarItems,
  readWorkspaceIndexEntry,
  getWorkspaceIndexRepository,
} from './sidebar-items';
import {
  applyWorkspaceIndexRemoval,
  applyWorkspaceRecordsRemoval,
} from './workspace-record-decision-port';
import {
  removeWorkspaceNonW5Children,
  removeWorkspaceDirectoryAfterRecordRemoval,
} from './w5-workspace-directory-removal';
import { readWorkspaceConfigDetailed } from './workspace-persistence';
import { getSidebarItemsPreserveWorkspaceIds } from './sidebar-items-preservation';
import { validateId } from './validation';
import { getChatSearchService } from '../chat-search/service';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import { publishWorktreeLifecycleChange } from './worktree-lifecycle-signals';
import {
  acquireWorkspaceDeletionLease,
  SplitLockError,
} from '../services/split-lock-service';
import { projectPluginDefaultsWritten } from '../plugins/project-plugin-defaults-cache';
import { reconcileWorkspaceRemovalPluginDefaults } from './workspace-plugin-defaults';
import {
  listArchivedContainerManifests,
  listArchivedContainerManifestsStrict,
  withArchivedWorkspaceOperationLock,
} from './archived-containers';
import {
  readArchivedGitStagedDescriptor,
  releaseArchivedGitState,
} from './archived-container-git';
import {
  finishArchivedContainerRecovery,
  isArchivedContainerGitCleanupBlocked,
  readProjectWorktreeRegistrations,
  removeProjectWorktreeRegistrations,
  verifyArchivedContainerRecoveryFinish,
  type ProjectWorktreeRegistrations,
} from './archived-container-recovery';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import {
  archiveWorkspaceWorktrees,
  assertWorkspaceWorktreesHaveNoLegacyArchiveRecovery,
  hasWorkspaceWorktreeWithUnavailableSource,
  WorktreeArchiveRefusedError,
} from './worktree-archive';
import {
  settleAll,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

const cleanupReceiptSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done') }),
  z.object({ status: z.literal('skipped') }),
  z.object({
    status: z.literal('failed'),
    error: z.unknown().transform(() => ({ name: 'Error' })),
  }),
]);
const workspaceDeletionReceiptSchema = z.object({
  workspaceId: z.string(),
  removed: z.enum(['cowork', 'unindexed', 'code']),
  cleanup: z.object({
    archivedGitRefs: cleanupReceiptSchema,
    chatSearchRows: cleanupReceiptSchema,
    managedRepository: cleanupReceiptSchema,
    // Receipts recorded before CAN-385 have no skill suggestion step.
    skillSuggestions: cleanupReceiptSchema.default({ status: 'skipped' }),
  }),
});

/** The caller of a deletion, recorded in workspace CRUD telemetry. */
export type WorkspaceDeletionSource =
  | 'multi_repo_workspace_delete'
  | 'single_repo_project_delete'
  | 'portal'
  | 'org-member-multi-repo-create'
  | 'shared_container_fork'
  | 'chat_project_delete'
  /** A registered `core.workspace.delete` wire call (W7b-2a). */
  | 'desktop_canopy_client';

/** At most one project-kind admission; the two contradict each other. */
type WorkspaceDeletionKindAdmission =
  | {
      /**
       * The single-repo project deletion (`project:delete`, CAN-3799 B6):
       * refuse any other kind of project, refuse while its configuration is
       * unreadable, and also remove its repository when the app created it
       * under the managed repos directory. A user's repository is never
       * deleted.
       */
      singleRepoProject?: boolean;
      coworkProject?: never;
    }
  | {
      /**
       * The chat project deletion (`chat-project:delete`, W6c2 P1(a), routed
       * here by G1): refuse a code project or an unindexed id as "Chat
       * project not found" before any effect.
       */
      coworkProject?: boolean;
      singleRepoProject?: never;
    };

export type WorkspaceDeletionRequest = W5BoundaryOptions & {
  workspaceId: string;
  source: WorkspaceDeletionSource;
  /**
   * CAN-5337: the operation id of an interrupted deletion the user confirmed
   * superseding (`describeProjectDeletionDiscard`). Honored only for an
   * unkeyed user deletion; an older host ignores it and refuses as before.
   */
  supersedeInterruptedDeletion?: string;
} & WorkspaceDeletionKindAdmission;

/** One cleanup step that runs after the deletion has committed. */
export type WorkspaceCleanupResult =
  | { status: 'done' }
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown };

export interface WorkspaceDeletionOutcome {
  workspaceId: string;
  /** What the deletion removed; `unindexed` when no index entry existed. */
  removed: 'cowork' | 'code' | 'unindexed';
  /**
   * Post-commit cleanup. A failed step never fails the committed deletion,
   * so callers see it here (each failure is also logged).
   */
  cleanup: {
    archivedGitRefs: WorkspaceCleanupResult;
    chatSearchRows: WorkspaceCleanupResult;
    managedRepository: WorkspaceCleanupResult;
    /** Repeat-task skill suggestion fingerprints and private suggestions. */
    skillSuggestions: WorkspaceCleanupResult;
  };
}

/**
 * Rebuildable data purged outside the destructive journal: its failure stays
 * in the receipt and never requires manual recovery (CAN-4962).
 */
const UNJOURNALED_CLEANUP: keyof WorkspaceDeletionOutcome['cleanup'] =
  'skillSuggestions';

/** The deletion removes every archive with its retained files (CAN-5011). */
const DISCARDING_ARCHIVE = { discardingArchive: true } as const;

const GIT_CLEANUP_PENDING_REFUSAL =
  'Git registration cleanup is still pending. Retry after the source repository is available.';
const CONFIGURATION_UNAVAILABLE_REFUSAL =
  'Cannot delete this project while its configuration is unavailable. Reload and try again.';

/**
 * The typed in-process workspace deletion boundary (CAN-3809). Every
 * deletion of a whole workspace goes through it: the renderer
 * (`workspace:delete`, `project:delete`), the browser Remote Control portal
 * (`portal.workspace.delete`) and rollbacks of org project creation and
 * shared-container forks, so the surfaces cannot drift on how a workspace is
 * torn down. Admission checks run before anything destructive; a failure
 * before the index commit leaves the workspace and its retained archives
 * recoverable. Optional revisions guard admission and index removal; keyed
 * attempts retain their reservation until final cleanup returns (CAN-3805).
 *
 * Cowork workspaces route through the dedicated delete/detach logic
 * (`destroyWorktreeSessions` + `deleteCoworkWorkspace`) so observability,
 * browser, and attachment cleanup fire, and so an external
 * (`externalPath`-backed) workspace is detached rather than having its attached
 * folder mistaken for Canopy-owned data. All other workspace types remove the
 * top-level sidebar entry first, then remove the persisted workspace directory
 * (worktree checkouts, chats, summaries). The explicit index deletion bypasses
 * transient-load preservation for only the requested workspace id.
 *
 * `telemetrySource` distinguishes the caller (e.g. `multi_repo_workspace_delete`
 * for the renderer, `portal` for the browser Remote Control) in CRUD telemetry.
 */
export async function deleteWorkspace(
  request: WorkspaceDeletionRequest,
  wire?: W5WireCall,
): Promise<WorkspaceDeletionOutcome> {
  return withArchiveFailureTelemetry(
    {
      workspaceId: request.workspaceId,
      archiveTrigger: USER_DELETION_SOURCES.has(request.source)
        ? 'project-deletion'
        : 'internal-rollback',
    },
    () => deleteWorkspaceAdmitted(request, wire),
  );
}

async function deleteWorkspaceAdmitted(
  request: WorkspaceDeletionRequest,
  wire?: W5WireCall,
): Promise<WorkspaceDeletionOutcome> {
  const { workspaceId } = request;
  validateId(workspaceId, 'workspaceId');
  if (isDefaultCoworkWorkspaceId(workspaceId)) {
    throw new WorkspaceDeletionRefusedError(
      'protected',
      // Straight from the shared label rather than via
      // `cowork-workspace-crud`, which consumers of this module mock.
      `The ${CHAT_UNIT_LABEL_PLURAL} project cannot be deleted`,
    );
  }
  const { expectedRevision, idempotencyKey, ...parameters } = request;
  return runW5BoundaryOperation(
    {
      operation: 'core.workspace.delete',
      caller: wire?.caller ?? `desktop-host:${request.source}`,
      idempotencyKey,
      parameters,
      ...(wire?.admit && { admit: wire.admit }),
      isPreEffectRefusal: (error) =>
        error instanceof WorkspaceDeletionRefusedError ||
        error instanceof ArchiveRecoveryRefusedError ||
        error instanceof WorktreeArchiveRefusedError ||
        error instanceof LiveDelegationsError ||
        error instanceof SplitLockError ||
        error instanceof W5RevisionConflictError ||
        isStepFreeDestructiveFailure(error),
    },
    (outcome) => workspaceDeletionReceiptSchema.parse(outcome),
    (options, attempt) =>
      serializeWorkspaceMutation(async () => {
        await checkW5ExpectedRevision(
          { kind: 'workspace', workspaceId },
          expectedRevision,
        );
        if (USER_DELETION_SOURCES.has(request.source))
          await admitProjectDeletionArchiveResolutions(workspaceId);
        const superseded = request.supersedeInterruptedDeletion;
        // Anything but an operation id refuses as it would without it.
        if (
          typeof superseded === 'string' &&
          z.string().uuid().safeParse(superseded).success &&
          idempotencyKey === undefined &&
          USER_DELETION_SOURCES.has(request.source)
        )
          await withdrawInterruptedWorkspaceDeletion(
            workspaceId,
            superseded,
            () => isWorkspaceIndexed(workspaceId),
          );
        await admitLifecycleJournals(attempt, () =>
          assertNoStrandedRecoveryOrArchive(
            workspaceId,
            USER_DELETION_SOURCES.has(request.source),
          ),
        );
        return withDestructiveLifecycle(
          {
            operation: 'workspace-delete',
            trigger: USER_DELETION_SOURCES.has(request.source)
              ? 'project-deletion'
              : 'internal-rollback',
            workspaceId,
            beforeEffects: attempt?.beforeEffects,
            projectOutcome: (result) =>
              workspaceDeletionReceiptSchema.parse(result),
          },
          async () => {
            const outcome = await deleteWorkspaceSerialized(
              request,
              options,
              attempt,
            );
            if (
              Object.entries(outcome.cleanup).some(
                ([name, step]) =>
                  name !== UNJOURNALED_CLEANUP && step.status === 'failed',
              )
            )
              markDestructiveCleanupRequired();
            return outcome;
          },
        );
      }),
  );
}

/** Explicit deletion abandons only intents whose protected sources still own every effect. */
async function admitProjectDeletionArchiveResolutions(
  workspaceId: string,
): Promise<void> {
  const store = archiveRecoveryStore();
  for (const receipt of await store.list(workspaceId)) {
    if (receipt.cancelled || receipt.stage === 'completed') continue;
    try {
      if (!(await store.inspect(receipt)).effectFree) continue;
      // Co-owner qualification can take shared journal access; the workspace queue protects refs.
      await qualifyArchiveRecoveryRefDeletion(receipt);
      await withExclusiveLifecycleJournalAccess(async () => {
        await store.normalize(workspaceId, receipt.operationId);
        await store.cancel(receipt);
      });
    } catch (cause) {
      throw new ArchiveRecoveryRefusedError(
        `Archive resolution ${receipt.operationId} could not be safely cancelled before project deletion.`,
        cause,
      );
    }
  }
  await assertNoArchiveResolution(workspaceId);
}

/**
 * CAN-4977: a worktree archive or delete this process is still running
 * refuses step-free and retryably; its journal is `active`, not stranded. Any
 * stranded journal of the project still refuses `recovery-required` first,
 * except a failed child archive of an earlier deletion that the worktree
 * archives of a user deletion resume (CAN-4993).
 */
async function assertNoStrandedRecoveryOrArchive(
  workspaceId: string,
  archivesWorktrees: boolean,
): Promise<void> {
  const [inFlight] = await readInFlightWorktreeDestructiveOperations(
    workspaceId,
    archivesWorktrees ? 'workspace-delete' : undefined,
  );
  if (inFlight) {
    const error = new WorkspaceDeletionRefusedError(
      'archive-in-progress',
      `A worktree in this project is still being ${
        inFlight.operation === 'worktree-delete' ? 'deleted' : 'archived'
      }. Retry after it finishes.`,
    );
    rememberDestructiveFailure(error, inFlight);
    throw error;
  }
}

/** {@link deleteWorkspace} for callers that only need it to finish. */
export async function deleteWorkspaceById(
  workspaceId: string,
  source: WorkspaceDeletionSource,
  options: Pick<WorkspaceDeletionRequest, 'supersedeInterruptedDeletion'> = {},
): Promise<void> {
  await deleteWorkspace({ workspaceId, source, ...options });
}

/** The index reads cleanly and still lists the project (CAN-5316 otherwise). */
export async function isWorkspaceIndexed(
  workspaceId: string,
): Promise<boolean> {
  const index = await getWorkspaceIndexRepository().read();
  return (
    index.authority === 'ok' &&
    index.entries.some((entry) => entry.id === workspaceId)
  );
}

/**
 * CAN-5337: a user deletion's read-only admission checks other than its
 * lifecycle journals and its worktrees' sources and archives, in their order,
 * for the project-level discard description. Throws the deletion's own
 * refusal; resolves with the project's kind. CAN-5338: with
 * `blockedArchives`, a retained archive whose recovery refuses the deletion
 * is collected there instead.
 */
export async function assertWorkspaceDeletableBesideItsWorktrees(
  workspaceId: string,
  blockedArchives?: Set<string>,
): Promise<SidebarItem['type'] | undefined> {
  assertNoLiveDelegationsInWorkspace(workspaceId);
  assertNoLiveDelegationsInWorktree(STANDALONE_CHAT_PROJECT_ID, workspaceId);
  assertWorkspaceCanBeRemoved(workspaceId);
  assertWorktreeCanBeRemoved(STANDALONE_CHAT_PROJECT_ID, workspaceId);
  // Taken and released at once: refuses as a held split or deletion would.
  acquireWorkspaceDeletionLease(workspaceId)();
  const { kind, sidebarItems } = await readDeletionTarget({
    workspaceId,
    source: 'portal',
  });
  if (kind === 'single-repo')
    admitSingleRepoProjectDeletion(
      workspaceId,
      sidebarItems,
      sidebarItems.items.find((item) => item.id === workspaceId),
      kind,
    );
  await assertArchivedRecoveriesCanFinish(workspaceId, blockedArchives);
  if (kind === 'single-repo' || kind === 'multi-repo')
    await assertWorkspaceWorktreesHaveNoLegacyArchiveRecovery(workspaceId);
  return kind;
}

/**
 * CAN-5337: the strict reads {@link deleteWorkspaceWithLease} makes of the
 * retained archives after any discards, read-only. Skips the `discarded`
 * archive-root entries, which the discards remove first. Throws as the
 * deletion would.
 */
export async function assertRetainedArchivesReadable(
  workspaceId: string,
  discarded: ReadonlySet<string>,
): Promise<void> {
  for (const manifest of await listArchivedContainerManifestsStrict(
    workspaceId,
    discarded,
  ))
    if (manifest.version === 3)
      await readArchivedGitStagedDescriptor(workspaceId, manifest.id, {
        readOnly: true,
      });
}

/** Host-only manual repair; never repeats canonical deletion, Git or directory removal. */
export async function retryWorkspaceDeletionSearchCleanup(request: {
  source: 'manual_repair';
  workspaceId: string;
  operationId: string;
}): Promise<void> {
  validateId(request.workspaceId, 'workspaceId');
  await serializeWorkspaceMutation(() =>
    withArchivedWorkspaceOperationLock(request.workspaceId, async () => {
      const index = await getWorkspaceIndexRepository().read();
      if (
        (index.authority !== 'ok' && index.authority !== 'absent') ||
        index.entries.some((entry) => entry.id === request.workspaceId)
      )
        throw new WorkspaceDeletionRefusedError(
          'configuration-unavailable',
          'Cannot verify that this project was deleted. Inspect its index before retrying cleanup.',
        );
      await retryDeletedWorkspaceSearchCleanup(
        request.workspaceId,
        request.operationId,
        () => getChatSearchService().deleteWorkspaceDocs(request.workspaceId),
      );
    }),
  );
}

async function deleteWorkspaceSerialized(
  request: WorkspaceDeletionRequest,
  options: W5CommitOptions,
  attempt?: W5KeyedAttempt,
): Promise<WorkspaceDeletionOutcome> {
  const { workspaceId } = request;
  // Read-only admission refusals release a keyed reservation for a retry.
  const admit = (check: () => void): void =>
    attempt ? attempt.validate(check) : check();
  // In-app deletion is refused while any chat in the workspace has queued,
  // starting or running delegates or close-blocking background work; the user
  // stops them first. A Cowork chat can still be keyed to the standalone-chat
  // sentinel (W6c2 B1(a)). Delegates are checked in both scopes first so their
  // refusal copy keeps precedence over the background-work refusal.
  admit(() => {
    assertNoLiveDelegationsInWorkspace(workspaceId);
    assertNoLiveDelegationsInWorktree(STANDALONE_CHAT_PROJECT_ID, workspaceId);
    assertWorkspaceCanBeRemoved(workspaceId);
    assertWorktreeCanBeRemoved(STANDALONE_CHAT_PROJECT_ID, workspaceId);
  });
  // Defer the scheduler-backed service until a workspace deletion is actually
  // requested; ordinary workspace reads do not need watcher lifecycle state.
  const { getAppAdvisorWatcherService } =
    await import('../app-advisor/watchers');
  let releaseDeletionLease = (): void => {};
  admit(() => {
    releaseDeletionLease = acquireWorkspaceDeletionLease(workspaceId);
  });
  let watchersFenced = false;
  let workspaceRemoved = false;
  try {
    // Read-only admission precedes watcher cancellation and child archives.
    const deletionTarget = await readDeletionTarget(request);
    await assertArchivedRecoveriesCanFinish(workspaceId);
    const { kind } = deletionTarget;
    const archivedKind =
      USER_DELETION_SOURCES.has(request.source) &&
      (kind === 'single-repo' || kind === 'multi-repo')
        ? kind
        : undefined;
    if (archivedKind) {
      // The archives' own refusal comes first, as in each archive. It is
      // read-only, so a keyed request is released for a retry after repair.
      await assertWorkspaceWorktreesHaveNoLegacyArchiveRecovery(
        workspaceId,
      ).catch((error: unknown) => {
        throw attempt && error instanceof Error
          ? attempt.validationError(error)
          : error;
      });
      await assertWorktreeSourcesAvailable(workspaceId, archivedKind);
    } else if (USER_DELETION_SOURCES.has(request.source))
      // Admission let them through for archives this deletion does not run.
      // Read-only, so a keyed request is released for a retry after repair.
      await assertFailedChildArchivesResumed(
        workspaceId,
        'workspace-delete',
      ).catch((error: unknown) => {
        throw attempt && error instanceof Error
          ? attempt.validationError(error)
          : error;
      });
    // Set before the call: the fence goes up before cancellation can fail.
    watchersFenced = true;
    await getAppAdvisorWatcherService().cancelLocalWorkspace(workspaceId);
    setArchiveFailurePhase('project-cleanup');
    if (archivedKind) {
      // Every client gets the cleanup of an archive from the app (CAN-3799
      // B2): teardown scripts, live sessions and Git worktree registrations.
      // The app's own deletion archives first, so this finds what is left,
      // such as a deletion from the Portal. Admission runs first, and the
      // archives run before the archive lock: each drains the worktree's
      // activity, and an activity touch waits for that lock. A failed archive
      // refuses the deletion step-free (CAN-4993), earlier archives stay
      // restorable, and a retry resumes a failed archive it can redo.
      await runStepFreeChildLifecycles(async () => {
        await archiveWorkspaceWorktrees(workspaceId, archivedKind);
        await assertFailedChildArchivesResumed(workspaceId, 'workspace-delete');
      });
    }
    const outcome = await withArchivedWorkspaceOperationLock(workspaceId, () =>
      deleteWorkspaceWithLease(request, options),
    );
    workspaceRemoved = true;
    await getAppAdvisorWatcherService().commitLocalWorkspaceCancellation(
      workspaceId,
    );
    return outcome;
  } catch (error) {
    // A refusal before cancellation must not release a concurrent holder's fence.
    if (watchersFenced && !workspaceRemoved) {
      await getAppAdvisorWatcherService().releaseLocalWorkspaceFence(
        workspaceId,
      );
    }
    throw error;
  } finally {
    releaseDeletionLease();
  }
}

/**
 * What the Ledger must retire once the workspace is gone: every incarnation
 * the workspace holds, read before the deletion. Reads only when the Ledger
 * database exists, waits a bounded time, and never fails the deletion.
 */
async function captureLedgerContents(
  workspaceId: string,
  archivedManifests: readonly ArchivedContainerManifest[],
): Promise<LedgerWorkspaceCapture | null> {
  try {
    return await captureLedgerWorkspaceIncarnations(
      workspaceId,
      archivedManifests,
    );
  } catch {
    // Startup reconciliation retires the scopes of a deleted workspace.
    return null;
  }
}

/**
 * Tells the Ledger that the captured workspace was deleted, so its scopes
 * retire unless their containers moved elsewhere first. Call only after the
 * deletion commits. The participant returns at once and never throws.
 */
function notifyLedgerOfWorkspaceDeletion(
  capture: LedgerWorkspaceCapture | null,
): void {
  try {
    notifyLedgerWorkspaceDeleted(capture);
  } catch {
    // A defect in the participant must not fail a committed deletion;
    // startup reconciliation settles the scopes.
  }
}

/**
 * The admission checks of a single-repo project deletion, run before
 * anything destructive. Returns the repository to remove after the commit
 * when the app created it under the managed repos directory.
 */
/**
 * The deletions a user asked for, which archive the project's worktrees first
 * (CAN-3799 B2). A rollback removes a project its own operation just created,
 * whose scripts never had the user's consent to run.
 */
const USER_DELETION_SOURCES: ReadonlySet<WorkspaceDeletionSource> =
  new Set<WorkspaceDeletionSource>([
    'multi_repo_workspace_delete',
    'single_repo_project_delete',
    'portal',
    'chat_project_delete',
    'desktop_canopy_client',
  ]);

/** Read what the deletion removes and run its admission checks. */
async function readDeletionTarget(request: WorkspaceDeletionRequest): Promise<{
  sidebarItems: SidebarItemsFile;
  kind: SidebarItem['type'] | undefined;
  managedRepoPath: string | undefined;
}> {
  const { workspaceId } = request;
  const [indexEntry, sidebarItems] = await settleAll([
    readWorkspaceIndexEntry(workspaceId),
    readAllSidebarItems({ persistRemovalCleanup: false }),
  ]);
  const target = sidebarItems.items.find((item) => item.id === workspaceId);
  const kind = target?.type ?? indexEntry?.type;
  // Refused before any effect; the pre-G1 chat-project route refused only
  // after tearing down sessions.
  if (request.coworkProject && kind !== 'cowork')
    throw new WorkspaceDeletionRefusedError(
      'not-cowork',
      'Chat project not found',
    );
  // Its `externalPath` is unknown, so the Cowork deletion's overlap guard
  // could not protect the attached folder (CAN-4975).
  if (
    kind === 'cowork' &&
    (await readWorkspaceConfigDetailed(workspaceId)).authority === 'unreadable'
  )
    throw new WorkspaceDeletionRefusedError(
      'configuration-unavailable',
      CONFIGURATION_UNAVAILABLE_REFUSAL,
    );
  if (kind === 'single-repo' || kind === 'multi-repo') {
    // Store-level admission matches removal: corrupt JSON is still removable.
    const records = await settleAll([
      desktopW5FileStore.read(w5RecordReadPaths.manifest(workspaceId)),
      desktopW5FileStore.read(w5RecordReadPaths.worktrees(workspaceId)),
    ]);
    if (records.some((record) => record.state === 'unreadable'))
      throw new WorkspaceDeletionRefusedError(
        'configuration-unavailable',
        CONFIGURATION_UNAVAILABLE_REFUSAL,
      );
  }
  const managedRepoPath = request.singleRepoProject
    ? admitSingleRepoProjectDeletion(workspaceId, sidebarItems, target, kind)
    : undefined;
  return { sidebarItems, kind, managedRepoPath };
}

/**
 * Refuse step-free when the `retained-git-cleanup` step could not finish a
 * retained version-3 archive's recovery; its failure leaves a
 * recovery-required journal that freezes the project. CAN-4994: the finish
 * step's own checks before its first effect, so a changed checkout refuses
 * once the failure repeats under the archive lock. The deletion discards the
 * archive, so its retained payload goes unverified and an unusable recovery
 * journal admits it (CAN-5011).
 * R-V3(ii) (CAN-4963): then its Git registration cleanup; a Git or filesystem
 * failure during inspection refuses too, as the locked step's walk fails the
 * same way. Both refusals are retryable. An unreadable listing admits, and the
 * locked strict listing reports its own error.
 */
async function assertArchivedRecoveriesCanFinish(
  workspaceId: string,
  blocked?: Set<string>,
): Promise<void> {
  let manifests: ArchivedContainerManifest[];
  try {
    manifests = await listArchivedContainerManifests(workspaceId);
  } catch {
    return;
  }
  for (const listed of manifests) {
    if (listed.version !== 3 || !listed.recovery.gitCleanupPending) continue;
    try {
      const manifest = await verifiedPendingRecovery(workspaceId, listed);
      if (manifest && (await isArchivedContainerGitCleanupBlocked(manifest)))
        throw new WorkspaceDeletionRefusedError(
          'git-cleanup-pending',
          GIT_CLEANUP_PENDING_REFUSAL,
        );
    } catch (error) {
      // CAN-5338: collected for the discard description; its own refusal.
      if (!blocked || !(error instanceof WorkspaceDeletionRefusedError))
        throw error;
      blocked.add(listed.id);
    }
  }
}

/**
 * The pending archive once its recovery verifies, or null when it is no
 * longer pending. Unlocked, a concurrent restore or purge can fail the check,
 * so only a failure that repeats under the archive lock refuses.
 */
async function verifiedPendingRecovery(
  workspaceId: string,
  listed: Extract<ArchivedContainerManifest, { version: 3 }>,
): Promise<Extract<ArchivedContainerManifest, { version: 3 }> | null> {
  try {
    await verifyArchivedContainerRecoveryFinish(listed, DISCARDING_ARCHIVE);
    return listed;
  } catch {
    // Confirmed under the lock below.
  }
  return withArchivedWorkspaceOperationLock(workspaceId, async () => {
    let current: ArchivedContainerManifest | undefined;
    try {
      current = (await listArchivedContainerManifests(workspaceId)).find(
        (manifest) => manifest.id === listed.id,
      );
    } catch {
      return null;
    }
    if (current?.version !== 3 || !current.recovery.gitCleanupPending)
      return null;
    try {
      await verifyArchivedContainerRecoveryFinish(current, DISCARDING_ARCHIVE);
    } catch (error) {
      throw new WorkspaceDeletionRefusedError(
        'archive-recovery-unverified',
        "An archived worktree's recovery files couldn't be verified. Preserve its archive and recovery journal, and retry after repair.",
        error,
      );
    }
    return current;
  });
}

/**
 * CAN-4985: refuse step-free when a live worktree's archive needs a source
 * repository that Git cannot open. That archive fails after its teardown, or
 * leaves Git registration cleanup pending for the locked step; either leaves
 * a recovery-required journal that freezes the project. Retryable.
 */
async function assertWorktreeSourcesAvailable(
  workspaceId: string,
  kind: 'single-repo' | 'multi-repo',
): Promise<void> {
  if (await hasWorkspaceWorktreeWithUnavailableSource(workspaceId, kind))
    throw new WorkspaceDeletionRefusedError(
      'source-unavailable',
      "A source repository for this project's worktrees is unavailable. Retry after it is available.",
    );
}

function admitSingleRepoProjectDeletion(
  workspaceId: string,
  sidebarItems: SidebarItemsFile,
  target: SidebarItem | undefined,
  kind: SidebarItem['type'] | undefined,
): string | undefined {
  if (getSidebarItemsPreserveWorkspaceIds(sidebarItems).includes(workspaceId)) {
    throw new WorkspaceDeletionRefusedError(
      'configuration-unavailable',
      CONFIGURATION_UNAVAILABLE_REFUSAL,
    );
  }
  // An unindexed id keeps its existing outcome: only its data directory goes.
  if (kind !== undefined && kind !== 'single-repo') {
    throw new WorkspaceDeletionRefusedError(
      'not-single-repo',
      'Only a single-repository project can be deleted this way.',
    );
  }
  const reposDir = getDefaultReposDir();
  return target?.type === 'single-repo' &&
    target.repoPath !== reposDir &&
    isPathInside(reposDir, target.repoPath)
    ? target.repoPath
    : undefined;
}

async function removeManagedRepository(
  repoPath: string | undefined,
): Promise<WorkspaceCleanupResult> {
  if (repoPath === undefined) return { status: 'skipped' };
  try {
    await destructiveCleanup('managed-repository-removal', () =>
      rm(repoPath, { recursive: true, force: true }),
    );
    return { status: 'done' };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to remove the managed project repository:', error);
    return { status: 'failed', error };
  }
}

/** Parent commit proof, not live-project admission, grants cleanup of the exact adopted holds. */
export async function settleWorkspaceArchiveRecoveryCleanup(
  record: DestructiveRecoveryRecord,
): Promise<void> {
  if (!record.archiveRecoveryCleanup?.length) return;
  record = await qualifyArchiveRecoveryCleanupParent(record);
  if (!record.archiveRecoveryCleanup?.some((entry) => !entry.done)) return;
  if (
    record.operation !== 'workspace-delete' ||
    record.worktreeId !== undefined
  )
    throw new ArchiveRecoveryRefusedError(
      'Invalid archive recovery cleanup parent.',
    );
  const removal = record.steps.find(
    (step) => step.phase === 'canonical-index-removal',
  );
  if (!removal) return; // No canonical removal was attempted: preserve every hold.
  if (removal.state !== 'done') {
    // An unacknowledged W5 commit is proven only by both canonical records being absent.
    const index = await getWorkspaceIndexRepository().read();
    if (
      (index.authority !== 'ok' && index.authority !== 'absent') ||
      index.entries.some((entry) => entry.id === record.workspaceId)
    )
      return;
    if (
      (await readWorkspaceConfigDetailed(record.workspaceId)).authority !==
      'absent'
    )
      return;
  }
  const store = archiveRecoveryStore();
  const failures: { operationId: string; error: unknown }[] = [];
  for (const member of record.archiveRecoveryCleanup) {
    if (member.done) continue;
    try {
      await store.normalize(record.workspaceId, member.operationId);
      const receipt = await store.read(record.workspaceId, member.operationId);
      if (!receipt || receipt.revision !== member.revision)
        throw new ArchiveRecoveryRefusedError(
          `Adopted hold ${member.operationId} changed or disappeared.`,
        );
      await settleArchiveRecovery(receipt, 'committed-parent', {
        store,
        qualifyRefs: qualifyArchiveRecoveryRefDeletion,
        deleteRefs: deleteArchiveRecoveryRefs,
        admitResolution: () => {
          throw new Error('Parent cannot resolve unfinished receipts.');
        },
        admitDeletion: () => {
          throw new Error('Committed parent must not re-admit.');
        },
        withdraw: () => {
          throw new Error('Parent cannot withdraw source journals.');
        },
      });
      await acknowledgeArchiveRecoveryCleanup(record, member.operationId);
    } catch (error) {
      failures.push({ operationId: member.operationId, error });
    }
  }
  if (failures.length)
    throw Object.assign(
      new Error(
        `Archive recovery cleanup remains incomplete for ${failures.map(({ operationId }) => operationId).join(', ')}.`,
      ),
      { failures },
    );
}

async function deleteWorkspaceWithLease(
  request: WorkspaceDeletionRequest,
  options: W5CommitOptions,
): Promise<WorkspaceDeletionOutcome> {
  const { workspaceId, source: telemetrySource } = request;
  const { kind, managedRepoPath } = await readDeletionTarget(request);
  if (managedRepoPath) await protectDestructivePath(managedRepoPath);
  // One record commit for both branches; the Cowork branch commits it through
  // `deleteCoworkWorkspace`. The commit, lock and revisions stay host-side.
  async function removeDeletedWorkspaceIndexEntry(): Promise<void> {
    await applyWorkspaceIndexRemoval(workspaceId, {
      kind: 'workspace.delete.index',
    });
    // Deletion owns the refresh, including its post-commit failure paths.
    await applyWorkspaceRecordsRemoval(
      workspaceId,
      { kind: 'workspace.delete.records' },
      { deferPluginDefaultsRefresh: true },
    );
  }
  async function commitIndexRemoval(): Promise<void> {
    let recordsApplied = false;
    let recordsStaged = false;
    try {
      await destructiveStep(
        'canonical-index-removal',
        async () => {
          // Keep confirmed superseding of interrupted index removals unchanged.
          if (kind !== 'cowork')
            await removeWorkspaceNonW5Children(workspaceId);
          await withW5Commit(
            {
              ...options,
              locks: [
                { kind: 'index', path: w5RecordReadPaths.index() },
                {
                  kind: 'manifest',
                  path: w5RecordReadPaths.manifest(workspaceId),
                },
                {
                  kind: 'list',
                  path: w5RecordReadPaths.worktrees(workspaceId),
                },
              ],
              expectedRevisions: w5ExpectedRevision(
                { kind: 'workspace', workspaceId },
                request.expectedRevision,
              ),
            },
            async () => {
              await afterW5Apply(() => {
                recordsApplied = true;
              });
              await removeDeletedWorkspaceIndexEntry();
              recordsStaged = true;
            },
          );
        },
        true,
      );
    } catch (error) {
      // Publication or the step's completion save can reject a durable removal.
      if (recordsApplied)
        projectPluginDefaultsWritten({
          configPath: w5RecordReadPaths.manifest(workspaceId),
          workspaceId,
          layerChanged: true,
        });
      else if (recordsStaged)
        reconcileWorkspaceRemovalPluginDefaults(workspaceId);
      throw error;
    }
  }
  // Capture the retained Git state while manifests are still readable, but do
  // not release any refs until the parent deletion has committed. A failed
  // teardown must leave every retained container recoverable.
  const archivedManifests =
    await listArchivedContainerManifestsStrict(workspaceId);
  const recoveryHolds = (await readArchiveRecoveryHolds(workspaceId)).filter(
    (receipt) => !receipt.cancelled && receipt.retention !== 'deleted',
  );
  const recoveryCleanup = await prepareArchiveRecoveryCleanup(recoveryHolds);
  const archivedGitStates: ArchivedGitState[] = [];
  for (const manifest of archivedManifests) {
    if (manifest.version === 2) {
      archivedGitStates.push(manifest.gitState);
      continue;
    }
    if (manifest.version === 3) {
      if (manifest.recovery.gitCleanupPending) {
        // The archive's recovery journal records the finish step's progress,
        // so a failure before the deletion's own effects refuses step-free
        // and a retry resumes it (CAN-5011).
        await resumableDestructiveStep('retained-git-cleanup', async () => {
          await finishArchivedContainerRecovery(manifest, DISCARDING_ARCHIVE);
          if (manifest.recovery.gitCleanupPending)
            throw new WorkspaceDeletionRefusedError(
              'git-cleanup-pending',
              GIT_CLEANUP_PENDING_REFUSAL,
            );
        });
      }
      const staged = await readArchivedGitStagedDescriptor(
        workspaceId,
        manifest.id,
      );
      if (staged && staged.repositories.length > 0) {
        archivedGitStates.push({
          version: 1,
          diffFormatVersion: 1,
          repositories: staged.repositories,
        });
      }
    }
  }
  const ledgerContents = await captureLedgerContents(
    workspaceId,
    archivedManifests,
  );
  // Unregistered once the directory removal takes their checkouts (CAN-5011).
  let worktreeRegistrations: ProjectWorktreeRegistrations | undefined;
  if (kind === 'cowork') {
    // Live agent sessions key (workspaceId, workEntryId, chatId) — tear down
    // every entry's sessions plus the legacy pre-entry 'home' slot.
    for (const worktreeId of [
      ...(await listWorkEntryIds(workspaceId)),
      COWORK_HOME_WORKTREE_ID,
    ]) {
      await destructiveStep('session-teardown', () =>
        destroyWorktreeSessions(workspaceId, worktreeId),
      );
    }
    // Then the compatibility standalone-chat sentinel keying (W6c2 B1(a)).
    await destructiveStep('session-teardown', () =>
      destroyWorktreeSessions(STANDALONE_CHAT_PROJECT_ID, workspaceId),
    );
    await destructiveStep('cowork-deletion', () =>
      deleteCoworkWorkspace(workspaceId, { commitIndexRemoval }),
    );
  } else {
    worktreeRegistrations = await readProjectWorktreeRegistrations(workspaceId);
    // Defer browser lifecycle/session initialization until the non-cowork
    // deletion path executes; ordinary workspace planning must stay lightweight.
    const {
      prepareWorkspaceBrowserRetirement,
      commitTaskBrowserRetirement,
      abortTaskBrowserRetirement,
    } = await import('../browser/browser-profile-lifecycle');
    const browserRetirements =
      await prepareWorkspaceBrowserRetirement(workspaceId);
    // The project directory holds every worktree's graph.db, and an idle code
    // graph read worker keeps a read-only connection to it for minutes. Stop
    // them all (and refuse new ones) before non-W5 cleanup and the sidebar
    // commit, so an open graph.db (EBUSY/EPERM on Windows) cannot fail after the
    // project has already left the sidebar.
    const releaseCodeGraphReadFence =
      fenceCodeGraphReadsForWorkspace(workspaceId);
    let ownerCommitted = false;
    try {
      await cancelCodeGraphReadsForWorkspace(workspaceId);
      await commitIndexRemoval();
      ownerCommitted = true;
      for (const entry of browserRetirements)
        await destructiveStep('browser-retirement', () =>
          commitTaskBrowserRetirement(workspaceId, entry.worktreeId),
        );
      await destructiveStep('workspace-directory-removal', () =>
        removeWorkspaceDirectoryAfterRecordRemoval(workspaceId),
      );
    } catch (error) {
      if (!ownerCommitted)
        for (const entry of browserRetirements)
          await abortTaskBrowserRetirement(entry.operationId);
      throw error;
    } finally {
      if (ownerCommitted)
        projectPluginDefaultsWritten({
          configPath: w5RecordReadPaths.manifest(workspaceId),
          workspaceId,
          layerChanged: true,
        });
      releaseCodeGraphReadFence();
    }
  }
  // The deletion has committed: the index entry and the workspace directory,
  // with its Work Entries and archives, are gone.
  notifyLedgerOfWorkspaceDeletion(ledgerContents);
  try {
    await completeSupersededChildArchives(workspaceId, 'workspace-delete');
  } catch (error) {
    // Their journals stay recovery-required for a project that is gone.
    // eslint-disable-next-line no-console
    console.error('Failed to complete superseded archive journals:', error);
  }
  if (worktreeRegistrations)
    await removeProjectWorktreeRegistrations(worktreeRegistrations);
  const managedRepository = await removeManagedRepository(managedRepoPath);
  let archivedGitRefs: WorkspaceCleanupResult = { status: 'done' };
  if (recoveryCleanup) {
    await destructiveCleanup('archive-recovery-holds', () =>
      settleWorkspaceArchiveRecoveryCleanup(recoveryCleanup),
    ).catch((error: unknown) => {
      archivedGitRefs = { status: 'failed', error };
    });
  }

  for (const gitState of archivedGitStates) {
    await destructiveCleanup('archived-git-refs', () =>
      releaseArchivedGitState(gitState),
    ).catch((error: unknown) => {
      // The workspace deletion is already durable. Ref cleanup is best-effort
      // and releaseArchivedGitState re-pins earlier refs on partial failure.
      // eslint-disable-next-line no-console
      console.error(
        'Failed to release archived Git refs after deletion.',
        error,
      );
      if (archivedGitRefs.status === 'done')
        archivedGitRefs = { status: 'failed', error };
    });
  }
  let chatSearchRows: WorkspaceCleanupResult = { status: 'done' };
  try {
    await destructiveCleanup('chat-search-rows', () =>
      getChatSearchService().deleteWorkspaceDocs(workspaceId),
    );
  } catch (error) {
    // The workspace removal is already durable and the index is rebuildable;
    // a failed row cleanup must not turn a successful deletion into an error.
    // eslint-disable-next-line no-console
    console.error('Failed to remove workspace chat search rows:', error);
    chatSearchRows = { status: 'failed', error };
  }
  let skillSuggestions: WorkspaceCleanupResult = { status: 'done' };
  try {
    // Outside the destructive journal: this data is rebuildable, so a failed
    // purge must not leave the deletion marked for manual recovery.
    // Deferred: the suggestion module is only needed after a deletion.
    const { purgeSkillSuggestionsForWorkspace } =
      await import('../skill-suggestions');
    await purgeSkillSuggestionsForWorkspace(workspaceId);
  } catch (error) {
    // Rebuildable local data: a failed purge never fails the deletion.
    // eslint-disable-next-line no-console
    console.error('Failed to remove workspace skill suggestion data:', error);
    skillSuggestions = { status: 'failed', error };
  }
  recordWorkspaceCrudTelemetry({
    action: 'delete',
    workspaceId,
    source: telemetrySource,
  });
  // Deletion removes the workspace directory without rewriting the index (it
  // self-heals on the next read), so the shared index-write hook never fires;
  // push the portal overview refresh explicitly (CAN-1304).
  schedulePortalStructuralSync();
  publishWorktreeLifecycleChange('workspace-deleted');

  // Best-effort, non-blocking: reap repo shadows for repos no remaining
  // workspace references. Re-read sidebar items after deletion so the deleted
  // workspace's repos no longer count as referenced.
  try {
    const remainingSidebarItems = await readAllSidebarItems();
    const { items: remainingItems } = remainingSidebarItems;
    syncCodeGraphBaseRepositories(
      remainingItems,
      new Set(getSidebarItemsPreserveWorkspaceIds(remainingSidebarItems)),
    );
    trackDetachedWork(() =>
      cleanupUnreferencedRepoShadows(
        collectReferencedRepoPaths(remainingItems),
      ).catch(() => undefined),
    );
  } catch (error) {
    // The workspace is already deleted; reading the remaining projects and
    // starting the shadow reap are follow-up, so a failure here never fails
    // the deletion. Log it so it is not invisible.
    // eslint-disable-next-line no-console
    console.error(
      'Failed to start repo shadow cleanup after workspace deletion:',
      error,
    );
  }
  return {
    workspaceId,
    removed:
      kind === 'cowork' ? 'cowork' : kind === undefined ? 'unindexed' : 'code',
    cleanup: {
      archivedGitRefs,
      chatSearchRows,
      managedRepository,
      skillSuggestions,
    },
  };
}

function collectReferencedRepoPaths(items: SidebarItem[]): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (item.type === 'single-repo') {
      paths.push(item.repoPath);
    } else if (item.type === 'multi-repo') {
      if (item.sourceRepoPath) {
        paths.push(item.sourceRepoPath);
      }
      for (const repo of item.repos) {
        paths.push(repo.repoPath);
      }
    }
  }
  return paths;
}
