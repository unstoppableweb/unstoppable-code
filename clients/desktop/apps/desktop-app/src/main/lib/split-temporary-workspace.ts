import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { W5CommitOptions } from './w5-commit-scope';
import type { W5KeyedAttempt } from './w5-keyed-operation';
import {
  runW5BoundaryOperation,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import { W5RevisionConflictError } from './w5-commit-log-file-store';
import {
  admitW5Composition,
  checkW5CompositionRevisions,
  decodeW5CompositionOutcome,
} from './w5-composition-operation';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  SPLIT_ITEM_SUMMARY_TITLE_LIMIT,
  WORKSPACE_ROOT_REPO_ID,
  type MultiRepoSidebarItem,
  type SingleRepoSidebarItem,
  type SplitTemporaryWorkspaceItemSummary,
  type SplitTemporaryWorkspaceItemSummaryEntry,
  type SplitTemporaryWorkspacePreviewRepo,
  type SplitTemporaryWorkspacePreviewRequest,
  type SplitTemporaryWorkspacePreviewResponse,
  type SplitTemporaryWorkspaceRemovalMode,
  type SplitTemporaryWorkspaceCompleteEvent,
  type SplitTemporaryWorkspaceRequest,
  type SplitTemporaryWorkspaceResponse,
  type SplitTemporaryWorkspaceResultEntry,
  type SplitTemporaryWorkspaceSelection,
  type WorkspaceRepoData,
  type WorktreeData,
  type WorktreeGitFailedEvent,
  type WorktreeGitReadyEvent,
  type WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import {
  analyzeSplitWorktreeItems,
  deleteSplitPipelineExecutions,
  finalizeSplitChatsAndPlansMigration,
  hasSplitWorktreeStoredItems,
  migrateSplitChatsAndPlans,
  migrateSplitPipelineExecutions,
  restoreSplitExecutionSnapshots,
  restoreSplitExecutionSnapshotsForTarget,
  undoSplitChatsAndPlansMigration,
  undoSplitChatsAndPlansTargetMigration,
  type SplitItemsMigrationTarget,
  type SplitItemsMigrationUndo,
  type SplitWorktreeRepoItems,
} from './split-temporary-workspace-items';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { stableStringify } from '@canopy/desktop-shared/lib/stable-hash';
import {
  allocateAdhocDestinationWorktreeId,
  assertNoActiveWorktreeWork,
  findWorkspace,
  reverseMovedCheckouts,
} from './adhoc-combine-core';
import { getCurrentBranch, getGitCommonDir, moveWorktree } from './git';
import {
  discardLedgerMoveIntent,
  LEDGER_INTENT_REFUSING_WAIT_MS,
  notifyLedgerContainerMoved,
  recordLedgerMoveIntent,
  type LedgerContainerIncarnation,
} from '../ledger/lifecycle';
import { worktreeLedgerIncarnation } from '../ledger/lifecycle-containers';
import {
  getWorktreeDir,
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
} from './paths';
import { pathExists } from './fs-utils';
import { safeRemoveWorktree } from './safe-remove-worktree';
import { validateId } from './validation';
import {
  reserveSplitDestinationRecord,
  removeSplitDestinationRecord,
  markSplitRecoveryRecord,
  promoteSplitDestinationRecord,
  recordSplitArchiveDestination,
  removeSplitCreatedWorkspace,
} from './split-temporary-workspace-records';
import { readWorkspaceConfig } from './workspace-persistence';
import {
  acquireSplitDestinationWorkspaceLeases,
  findOrCreateSingleRepoWorkspaceForRepo,
  listWorkspaceItems,
  withSplitDestinationWorkspaceCreationLock,
} from './workspace-service';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  type WorktreeArchiveLiveServices,
} from './worktree-service';
import {
  acquireSplitDestinationWorktreeClaim,
  acquireSplitLock,
  acquireWorkspaceArchiveRetentionLease,
  releaseSplitDestinationWorktreeClaim,
  releaseSplitLock,
} from '../services/split-lock-service';
import {
  beginWorktreeGitSetup,
  settleWorktreeGitSetup,
} from './worktree-git-setup';
import {
  settleAll,
  settleEach,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

interface SplitSourceContext {
  workspace: MultiRepoSidebarItem;
  worktree: WorktreeData;
  repos: WorkspaceRepoData[];
}

/**
 * Load and validate the split source: the workspace must be a temporary
 * multi-repo workspace and the worktree must exist with git setup complete.
 * Split is intentionally unavailable for permanent workspaces — their repo
 * sets are durable configuration, not a transient combination to dissolve.
 */
async function loadSplitSourceContext(
  workspaceId: string,
  worktreeId: string,
  readOnly = false,
): Promise<SplitSourceContext> {
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  const items = await listWorkspaceItems({
    includeEmptyTemporary: true,
    ...(readOnly ? { persistRemovalCleanup: false } : {}),
  });
  const workspace = findWorkspace(items, workspaceId);
  if (!workspace || workspace.type !== 'multi-repo') {
    throw new Error(`Project ${workspaceId} is not a multi-repo project`);
  }
  if (workspace.temporary !== true) {
    throw new Error(
      'Split project is only available for temporary multi-repo projects',
    );
  }
  const worktree = workspace.worktrees.find((entry) => entry.id === worktreeId);
  if (!worktree) {
    throw new Error(`Worktree ${worktreeId} not found`);
  }
  if (worktree.setupPhase === 'git-pending') {
    throw new Error('Cannot split while worktree setup is pending.');
  }
  if (worktree.status === 'done') {
    throw new Error('Cannot split a completed worktree.');
  }
  const config = await readWorkspaceConfig(workspaceId);
  const repos = config.repos.filter(
    (repo) => repo.id !== WORKSPACE_ROOT_REPO_ID,
  );
  if (repos.length === 0) {
    throw new Error(`Project ${workspaceId} has no repos to split`);
  }
  return { workspace, worktree, repos };
}

/**
 * Preview-time destination resolutions, keyed
 * `${workspaceId}/${worktreeId}/${repoId}`. Identity matching shells out to
 * git per candidate workspace, which is the slow part of both the preview and
 * the split's fast phase — the preview caches what it resolved so the split
 * confirm (which follows within the modal's lifetime) can reuse it after a
 * cheap re-validation instead of re-running the full matching. `null` records
 * "no existing destination". Entries expire so stale resolutions never
 * outlive the modal session that produced them.
 */
const previewDestinationCache = new Map<
  string,
  { destinationWorkspaceId: string | null; resolvedAt: number }
>();
const PREVIEW_DESTINATION_CACHE_TTL_MS = 5 * 60 * 1000;

function previewCacheKey(
  workspaceId: string,
  worktreeId: string,
  repoId: string,
): string {
  return `${workspaceId}/${worktreeId}/${repoId}`;
}

async function resolveDestinationByFullMatch(
  repo: WorkspaceRepoData,
  readOnly = false,
): Promise<SingleRepoSidebarItem | undefined> {
  const items = await listWorkspaceItems({
    includeEmptyTemporary: true,
    ...(readOnly ? { persistRemovalCleanup: false } : {}),
  });
  const singleRepoItems = items.filter(
    (item): item is SingleRepoSidebarItem => item.type === 'single-repo',
  );
  const exact = singleRepoItems.find((item) => item.repoPath === repo.repoPath);
  if (exact) {
    return exact;
  }
  const sourceCommonDir = await getGitCommonDir(repo.repoPath);
  for (const item of singleRepoItems) {
    const itemCommonDir = await getGitCommonDir(item.repoPath).catch(
      () => null,
    );
    if (itemCommonDir === sourceCommonDir) {
      return item;
    }
  }
  return undefined;
}

/**
 * Match an existing single-repo workspace for a child repo: exact repo path
 * first, then canonical Git common directory (covers paths re-attached through
 * symlinks without treating two separate clones of one remote as the same
 * repository). When a
 * fresh preview resolution exists for the `(source, repo)` pair it is reused
 * after re-validating that the workspace still exists as a single-repo item —
 * a cache hit skips the per-workspace git identity calls entirely.
 */
async function findExistingDestinationWorkspace(
  repo: WorkspaceRepoData,
  cacheContext?: {
    workspaceId: string;
    worktreeId: string;
    reuseNegativeResult?: boolean;
    readOnly?: boolean;
  },
): Promise<SingleRepoSidebarItem | undefined> {
  const cacheKey = cacheContext
    ? previewCacheKey(
        cacheContext.workspaceId,
        cacheContext.worktreeId,
        repo.id,
      )
    : undefined;
  if (cacheKey) {
    const cached = previewDestinationCache.get(cacheKey);
    if (
      cached &&
      Date.now() - cached.resolvedAt <= PREVIEW_DESTINATION_CACHE_TTL_MS
    ) {
      if (
        cached.destinationWorkspaceId === null &&
        cacheContext?.reuseNegativeResult !== false
      ) {
        return undefined;
      }
      const items = await listWorkspaceItems({
        includeEmptyTemporary: true,
        ...(cacheContext?.readOnly ? { persistRemovalCleanup: false } : {}),
      });
      const cachedItem = items.find(
        (item): item is SingleRepoSidebarItem =>
          item.type === 'single-repo' &&
          item.id === cached.destinationWorkspaceId,
      );
      if (
        cachedItem &&
        (cachedItem.repoPath === repo.repoPath ||
          (await settleAll([
            getGitCommonDir(cachedItem.repoPath),
            getGitCommonDir(repo.repoPath),
          ])
            .then(
              ([cachedCommonDir, sourceCommonDir]) =>
                cachedCommonDir === sourceCommonDir,
            )
            .catch(() => false)))
      ) {
        return cachedItem;
      }
      // The cached workspace disappeared — fall through to a full match.
    }
  }

  const resolved = await resolveDestinationByFullMatch(
    repo,
    cacheContext?.readOnly,
  );
  if (cacheKey) {
    previewDestinationCache.set(cacheKey, {
      destinationWorkspaceId: resolved?.id ?? null,
      resolvedAt: Date.now(),
    });
  }
  return resolved;
}

/**
 * Removal mode for a child repo. Deletion retention is always on, so removal
 * always archives into the destination workspace (a repo without an existing
 * destination workspace archives under the default retention window).
 */
function resolveRemovalMode(): SplitTemporaryWorkspaceRemovalMode {
  return 'archive';
}

function toItemSummary(
  entries: SplitTemporaryWorkspaceItemSummaryEntry[],
): SplitTemporaryWorkspaceItemSummary {
  return {
    count: entries.length,
    entries: entries.slice(0, SPLIT_ITEM_SUMMARY_TITLE_LIMIT),
  };
}

function repoItemSummaries(items: SplitWorktreeRepoItems | undefined): {
  chats: SplitTemporaryWorkspaceItemSummary;
  pipelines: SplitTemporaryWorkspaceItemSummary;
  plans: SplitTemporaryWorkspaceItemSummary;
} {
  return {
    // The chat list is live chats followed by archived chats (marked so the
    // tooltip renders an archive icon). Open file tabs migrate with the repo
    // too, but are editor state — intentionally not counted here.
    chats: toItemSummary([
      ...(items?.chatTabs.map((tab) => ({ title: tab.title })) ?? []),
      ...(items?.archivedChats.map((entry) => ({
        title: entry.tab.title,
        archived: true,
      })) ?? []),
    ]),
    pipelines: toItemSummary(
      items?.executions.map((execution) => ({
        title: execution.pipeline_name ?? execution.pipeline_id,
      })) ?? [],
    ),
    plans: toItemSummary(
      items?.plans.map((plan) => ({ title: plan.title })) ?? [],
    ),
  };
}

function orderedSplitItems(items: SplitWorktreeRepoItems): object {
  const byId = <T extends { id: string }>(entries: T[]): T[] =>
    [...entries].sort((left, right) => left.id.localeCompare(right.id));
  return {
    chatTabs: byId(items.chatTabs),
    fileTabs: byId(items.fileTabs),
    archivedChats: [...items.archivedChats].sort((left, right) =>
      left.tab.id.localeCompare(right.tab.id),
    ),
    executions: byId(items.executions),
    plans: byId(items.plans),
    attachmentNames: [...(items.attachmentNames ?? [])].sort(),
  };
}

function buildSplitPreviewRevision(input: {
  request: SplitTemporaryWorkspacePreviewRequest;
  repos: SplitTemporaryWorkspacePreviewRepo[];
  root: SplitTemporaryWorkspacePreviewResponse['root'];
  analysis: Awaited<ReturnType<typeof analyzeSplitWorktreeItems>>;
}): string {
  const canonical = {
    workspaceId: input.request.workspaceId,
    worktreeId: input.request.worktreeId,
    repos: [...input.repos]
      .sort((left, right) => left.repoId.localeCompare(right.repoId))
      .map((repo) => ({
        ...repo,
        items: orderedSplitItems(
          input.analysis.perRepo.get(repo.repoId) ?? {
            chatTabs: [],
            fileTabs: [],
            archivedChats: [],
            executions: [],
            plans: [],
            attachmentNames: [],
          },
        ),
      })),
    root: {
      ...input.root,
      items: orderedSplitItems(input.analysis.root),
    },
  };
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

type SplitItemAnalysis = Awaited<ReturnType<typeof analyzeSplitWorktreeItems>>;

interface PreparedSplitPreview {
  response: SplitTemporaryWorkspacePreviewResponse;
  destinations: Map<string, SingleRepoSidebarItem | undefined>;
}

async function resolveSplitDestinations(
  request: SplitTemporaryWorkspacePreviewRequest,
  repos: WorkspaceRepoData[],
  options?: { reuseNegativeResults?: boolean; readOnly?: boolean },
): Promise<Map<string, SingleRepoSidebarItem | undefined>> {
  const destinations = new Map<string, SingleRepoSidebarItem | undefined>();
  for (const repo of repos) {
    destinations.set(
      repo.id,
      await findExistingDestinationWorkspace(repo, {
        workspaceId: request.workspaceId,
        worktreeId: request.worktreeId,
        reuseNegativeResult: options?.reuseNegativeResults,
        readOnly: options?.readOnly,
      }),
    );
  }
  return destinations;
}

function prepareSplitPreview(
  request: SplitTemporaryWorkspacePreviewRequest,
  repos: WorkspaceRepoData[],
  analysis: SplitItemAnalysis,
  destinations: Map<string, SingleRepoSidebarItem | undefined>,
): PreparedSplitPreview {
  const previewRepos: SplitTemporaryWorkspacePreviewRepo[] = [];
  for (const repo of repos) {
    const destination = destinations.get(repo.id);
    previewRepos.push({
      repoId: repo.id,
      repoName: repo.name,
      repoPath: repo.repoPath,
      ...(destination ? { destinationWorkspaceId: destination.id } : {}),
      destinationWorkspaceName: destination?.name ?? repo.name,
      removalMode: resolveRemovalMode(),
      ...repoItemSummaries(analysis.perRepo.get(repo.id)),
    });
  }
  const rootSummaries = repoItemSummaries(analysis.root);
  const attachments = toItemSummary(
    (analysis.root.attachmentNames ?? []).map((name) => ({ title: name })),
  );
  const root = {
    // The split inventory can prove which managed stores are present, but it
    // cannot prove that the worktree root contains no unmanaged user files.
    // Teardown removes that directory recursively, so always surface a root
    // disposition and require explicit approval when it will be deleted.
    present: true,
    // Deletion retention is always on, so the root can always be archived.
    canArchive: true,
    ...rootSummaries,
    attachments,
  };
  const response = {
    previewRevision: buildSplitPreviewRevision({
      request,
      repos: previewRepos,
      root,
      analysis,
    }),
    repos: previewRepos,
    root,
  };
  return { response, destinations };
}

export async function previewSplitTemporaryWorkspaceWorktree(
  request: SplitTemporaryWorkspacePreviewRequest,
): Promise<SplitTemporaryWorkspacePreviewResponse> {
  const { repos } = await loadSplitSourceContext(
    request.workspaceId,
    request.worktreeId,
  );
  const analysis = await analyzeSplitWorktreeItems(
    request.workspaceId,
    request.worktreeId,
    repos,
  );
  const destinations = await resolveSplitDestinations(request, repos);
  return prepareSplitPreview(request, repos, analysis, destinations).response;
}

/**
 * `git worktree move` with a short retry. Background split moves can race
 * transient git activity in the same checkouts — most commonly the diff-stats
 * refresh the split modal itself triggers, whose `git diff` may briefly hold
 * `index.lock` — and a lock-contention failure here would needlessly roll the
 * whole split back. Contention clears in well under a second.
 */
async function moveWorktreeWithRetry(
  repoPath: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  const maxAttempts = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await moveWorktree(repoPath, fromPath, toPath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => {
          setTimeout(resolve, 250 * attempt);
        });
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface PlannedSplitRepo {
  repo: WorkspaceRepoData;
  selection: SplitTemporaryWorkspaceSelection;
  removalMode: SplitTemporaryWorkspaceRemovalMode;
  destination?: SingleRepoSidebarItem;
  destinationWorktreeId?: string;
  /** Source checkout path, captured once during planning. */
  sourcePath: string;
}

export interface SplitTemporaryWorkspaceExecutionHooks {
  /** Consumes approval against the exact locked plan execution will follow. */
  consumeDestructiveApproval?: (
    preview: SplitTemporaryWorkspacePreviewResponse,
  ) => void;
  liveServices?: WorktreeArchiveLiveServices;
  /**
   * Fired once per split destination worktree after its checkout move lands
   * and its reserved `git-pending` row flips ready. The IPC layer forwards
   * this as a normal `worktree:git-ready` broadcast so queued chats flush
   * through the existing deferred-creation plumbing.
   */
  onSplitWorktreeReady?: (event: WorktreeGitReadyEvent) => void;
  /** Marks a retained destination reservation as failed and recoverable. */
  onSplitWorktreeFailed?: (event: WorktreeGitFailedEvent) => void;
  /** Fired exactly once when the background phase settles (success or not). */
  onComplete?: (event: SplitTemporaryWorkspaceCompleteEvent) => void;
}

interface SplitDestinationReservation {
  workspaceId: string;
  worktreeId: string;
  createdAt: string;
  fallbackWorktree?: WorktreeData;
}

function buildSplitRecoveryReservations(
  planned: PlannedSplitRepo[],
  sourceWorktree: WorktreeData,
  reservations: SplitDestinationReservation[],
): SplitDestinationReservation[] {
  const recovery = new Map(
    reservations.map((reservation) => [
      `${reservation.workspaceId}/${reservation.worktreeId}`,
      reservation,
    ]),
  );
  for (const plan of planned) {
    if (
      !plan.destination ||
      plan.destinationWorktreeId === undefined ||
      (plan.selection === 'remove' && plan.removalMode === 'delete')
    ) {
      continue;
    }
    const key = `${plan.destination.id}/${plan.destinationWorktreeId}`;
    const existing = recovery.get(key);
    recovery.set(key, {
      ...(existing ?? {
        workspaceId: plan.destination.id,
        worktreeId: plan.destinationWorktreeId,
        createdAt: sourceWorktree.createdAt,
      }),
      fallbackWorktree: {
        id: plan.destinationWorktreeId,
        branchName: sourceWorktree.branchName ?? plan.destinationWorktreeId,
        createdAt: sourceWorktree.createdAt,
        ...(sourceWorktree.label ? { label: sourceWorktree.label } : {}),
        ...(sourceWorktree.trackedRepoBaseBranches?.[plan.repo.id]
          ? {
              trackedBaseBranch:
                sourceWorktree.trackedRepoBaseBranches[plan.repo.id],
            }
          : {}),
      },
    });
  }
  return Array.from(recovery.values());
}

/**
 * Split destinations are `git-pending` rows like deferred creates, so a send
 * into one waits on the same Git setup record. Ready and failed lifecycle
 * events settle it.
 */
function withSplitDestinationGitSetup(
  hooks: SplitTemporaryWorkspaceExecutionHooks | undefined,
): SplitTemporaryWorkspaceExecutionHooks {
  return {
    ...hooks,
    onSplitWorktreeReady: (event): void => {
      settleWorktreeGitSetup(event.projectId, event.worktreeId, 'ready');
      hooks?.onSplitWorktreeReady?.(event);
    },
    onSplitWorktreeFailed: (event): void => {
      settleWorktreeGitSetup(event.projectId, event.worktreeId, 'failed');
      hooks?.onSplitWorktreeFailed?.(event);
    },
  };
}

/** Settles destinations no lifecycle event reached, such as rolled-back ones. */
function cancelUnsettledSplitDestinationGitSetups(
  reservations: readonly SplitDestinationReservation[],
): void {
  for (const reserved of reservations) {
    settleWorktreeGitSetup(
      reserved.workspaceId,
      reserved.worktreeId,
      'cancelled',
    );
  }
}

async function rollbackFastPhaseReservations(
  reservations: SplitDestinationReservation[],
  hooks?: SplitTemporaryWorkspaceExecutionHooks,
): Promise<unknown[]> {
  const rollbackErrors: unknown[] = [];
  for (const reserved of [...reservations].reverse()) {
    try {
      await removeSplitDestinationRecord({
        source: 'temporary_split',
        ...reserved,
      });
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
      const message = `Split rollback could not remove destination reservation ${reserved.workspaceId}/${reserved.worktreeId}; it was retained for recovery.`;
      try {
        hooks?.onSplitWorktreeFailed?.({
          projectId: reserved.workspaceId,
          worktreeId: reserved.worktreeId,
          error: message,
          healthIssue: {
            status: 'broken',
            code: 'git-error',
            message,
            checkedAt: new Date().toISOString(),
            worktreePath: getWorkspaceWorktreeDir(
              reserved.workspaceId,
              reserved.worktreeId,
            ),
            gitError:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
          },
        });
      } catch {
        // Lifecycle delivery must not replace the rollback failure itself.
      }
    }
  }
  return rollbackErrors;
}

async function markSplitRecoveryReservations(
  reservations: SplitDestinationReservation[],
  hooks: SplitTemporaryWorkspaceExecutionHooks | undefined,
  migrationError: Error,
): Promise<unknown[]> {
  const markingErrors: unknown[] = [];
  for (const reserved of reservations) {
    const message = `Split migration rollback was incomplete for ${reserved.workspaceId}/${reserved.worktreeId}. Destination data was retained for recovery.`;
    const healthIssue: WorktreeHealthIssue = {
      status: 'broken',
      code: 'git-error',
      message,
      checkedAt: new Date().toISOString(),
      worktreePath: getWorktreeDir(reserved.workspaceId, reserved.worktreeId),
      gitError: migrationError.message,
    };
    try {
      await markSplitRecoveryRecord({
        source: 'temporary_split',
        ...reserved,
        fallbackWorktree: reserved.fallbackWorktree ?? {
          id: reserved.worktreeId,
          branchName: reserved.worktreeId,
          createdAt: reserved.createdAt,
        },
        healthIssue,
      });
    } catch (markingError) {
      markingErrors.push(markingError);
    }
    try {
      hooks?.onSplitWorktreeFailed?.({
        projectId: reserved.workspaceId,
        worktreeId: reserved.worktreeId,
        error: message,
        healthIssue,
      });
    } catch {
      // Lifecycle delivery must not replace the migration rollback failure.
    }
  }
  return markingErrors;
}

function splitFastPhaseRollbackError(
  error: unknown,
  rollbackErrors: unknown[],
): Error {
  const primaryMessage = error instanceof Error ? error.message : String(error);
  const rollbackMessage = rollbackErrors
    .map((rollbackError) =>
      rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError),
    )
    .join('; ');
  const combined = new Error(
    `${primaryMessage} Reservation rollback was incomplete; retained destinations were marked failed for recovery. ${rollbackMessage}`,
  );
  combined.name = 'SplitReservationRollbackError';
  return combined;
}

/** Worktrees with a split currently in flight, keyed `workspaceId/worktreeId`. */
const inFlightSplits = new Set<string>();
const activeSplitLifecycles = new Set<Promise<void>>();
const destinationAllocationLocks = new Map<string, Promise<void>>();
const claimedDestinationWorktreeIds = new Map<string, Set<string>>();
const SPLIT_BACKGROUND_DRAIN_TIMEOUT_MS = 10_000;
let splitShutdownStarted = false;

interface DestinationWorktreeClaim {
  workspaceId: string;
  worktreeId: string;
}

async function withDestinationAllocationLock<T>(
  workspaceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous =
    destinationAllocationLocks.get(workspaceId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  destinationAllocationLocks.set(workspaceId, next);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (destinationAllocationLocks.get(workspaceId) === next) {
      destinationAllocationLocks.delete(workspaceId);
    }
  }
}

function getDestinationWorktreeClaims(workspaceId: string): Set<string> {
  const existing = claimedDestinationWorktreeIds.get(workspaceId);
  if (existing) {
    return existing;
  }
  const created = new Set<string>();
  claimedDestinationWorktreeIds.set(workspaceId, created);
  return created;
}

function releaseDestinationWorktreeClaims(
  claims: DestinationWorktreeClaim[],
): void {
  for (const claim of claims) {
    const workspaceClaims = claimedDestinationWorktreeIds.get(
      claim.workspaceId,
    );
    workspaceClaims?.delete(claim.worktreeId);
    releaseSplitDestinationWorktreeClaim(claim.workspaceId, claim.worktreeId);
    if (workspaceClaims?.size === 0) {
      claimedDestinationWorktreeIds.delete(claim.workspaceId);
    }
  }
}

/** Refuse new split transactions once app shutdown has begun. */
export function beginSplitTemporaryWorkspaceShutdown(): void {
  splitShutdownStarted = true;
}

/** Whether a source worktree is held by a complete split lifecycle. */
export function isSplitTemporaryWorkspaceInFlight(
  workspaceId: string,
  worktreeId: string,
): boolean {
  return inFlightSplits.has(`${workspaceId}/${worktreeId}`);
}

/** Await active split mutations during graceful shutdown, with a hard bound. */
export async function drainSplitTemporaryWorkspaceBackgroundPhases(
  timeoutMs = SPLIT_BACKGROUND_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    while (activeSplitLifecycles.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return;
      }
      const pending = Array.from(activeSplitLifecycles);
      // Bounded shutdown drain: past the deadline, quit leaves the split's own recovery to the next launch; remove when graceful shutdown drains W5 work without a deadline
      const timedOut = await Promise.race([
        settleEach(pending).then(() => false),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(resolve, remainingMs, true);
          timeout.unref?.();
        }),
      ]);
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (timedOut) {
        return;
      }
    }
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** Whether a split destination contains records that rollback must preserve. */
async function workspaceContainsRollbackData(
  workspaceId: string,
  rollbackTargets: SplitItemsMigrationTarget[],
  ownClaimIds: ReadonlySet<string>,
): Promise<boolean> {
  const activeClaims = claimedDestinationWorktreeIds.get(workspaceId);
  const activeClaimIds = activeClaims ? Array.from(activeClaims) : [];
  if (activeClaimIds.some((claimId) => !ownClaimIds.has(claimId))) {
    return true;
  }
  const worktreeIds = new Set(
    rollbackTargets
      .filter((target) => target.destinationWorkspaceId === workspaceId)
      .map((target) => target.destinationWorktreeId),
  );
  for (const claimId of activeClaimIds) {
    worktreeIds.add(claimId);
  }
  for (const worktreeId of Array.from(worktreeIds)) {
    if (await hasSplitWorktreeStoredItems(workspaceId, worktreeId)) {
      return true;
    }
  }
  return false;
}

/**
 * Remove workspaces created for a failed split only after their sidebar
 * records have been read and persisted successfully. A sidebar failure must
 * preserve the backing directories so persisted entries never point at
 * deleted workspace data.
 */
async function removeCreatedWorkspaces(
  createdWorkspaceIds: string[],
  options?: {
    preserveRollbackData?: boolean;
    rollbackTargets?: SplitItemsMigrationTarget[];
    ownClaims?: DestinationWorktreeClaim[];
  },
): Promise<string[]> {
  if (createdWorkspaceIds.length === 0) {
    return [];
  }
  return withSplitDestinationWorkspaceCreationLock(async () => {
    const preserved: string[] = [];
    for (const workspaceId of createdWorkspaceIds) {
      const ownClaimIds = new Set(
        (options?.ownClaims ?? [])
          .filter((claim) => claim.workspaceId === workspaceId)
          .map((claim) => claim.worktreeId),
      );
      await withDestinationAllocationLock(workspaceId, async () => {
        const persistedWorktreeIds = new Set(ownClaimIds);
        for (const target of options?.rollbackTargets ?? []) {
          if (target.destinationWorkspaceId === workspaceId) {
            persistedWorktreeIds.add(target.destinationWorktreeId);
          }
        }
        const removed = await removeSplitCreatedWorkspace({
          source: 'temporary_split',
          workspaceId,
          worktreeIds: Array.from(persistedWorktreeIds),
          containsRollbackData: () =>
            workspaceContainsRollbackData(
              workspaceId,
              options?.preserveRollbackData
                ? (options.rollbackTargets ?? [])
                : [],
              ownClaimIds,
            ),
        });
        if (!removed) preserved.push(workspaceId);
      });
    }
    return preserved;
  });
}

/**
 * Build the destination worktree record for a split child repo. The branch is
 * read from the moved checkout; the created-at timestamp and label carry over
 * from the source multi-repo worktree so the split result reads as the same
 * line of work. Multi-repo per-repo base-branch overrides collapse to the
 * single-repo `trackedBaseBranch`.
 */
async function buildSplitWorktreeRecord(
  sourceWorktree: WorktreeData,
  repo: WorkspaceRepoData,
  worktreeId: string,
  checkoutPath: string,
): Promise<WorktreeData> {
  const branchName =
    (await getCurrentBranch(checkoutPath).catch(() => null)) ??
    sourceWorktree.branchName ??
    worktreeId;
  const trackedBaseBranch = sourceWorktree.trackedRepoBaseBranches?.[repo.id];
  return {
    id: worktreeId,
    branchName,
    createdAt: sourceWorktree.createdAt,
    ...(sourceWorktree.label ? { label: sourceWorktree.label } : {}),
    ...(sourceWorktree.status ? { status: sourceWorktree.status } : {}),
    ...(trackedBaseBranch ? { trackedBaseBranch } : {}),
  };
}

/** Why a split did not commit: its Ledger mapping could not be saved. */
const LEDGER_SPLIT_NOT_SAVED_MESSAGE = "Couldn't split the project. Try again.";

/**
 * Where the split worktree's line of work continues, for the Ledger. A split
 * that keeps exactly one repository moves the worktree there, so its scope
 * follows and keeps its ledger. A split into several repositories is
 * ambiguous, so the scope stays with the source, and the source teardown
 * archives or retires it, rather than guessing: null then.
 */
function ledgerSplitMove(
  workspaceId: string,
  source: WorktreeData,
  kept: readonly WorktreeGitReadyEvent[],
): {
  readonly from: LedgerContainerIncarnation;
  readonly to: LedgerContainerIncarnation;
} | null {
  if (kept.length !== 1) return null;
  const [destination] = kept;
  return {
    from: worktreeLedgerIncarnation(workspaceId, source),
    // Every destination row keeps the source's creation time.
    to: worktreeLedgerIncarnation(destination.projectId, {
      id: destination.worktreeId,
      createdAt: source.createdAt,
    }),
  };
}

/**
 * Durably records the split's move before promotion commits the destination,
 * since the destination ID may be suffixed and the source teardown later
 * removes the source row. False when a Ledger exists but the mapping could
 * not be saved: the split must then roll back, and can be retried.
 */
async function recordLedgerIntentOfSplitMove(
  move: ReturnType<typeof ledgerSplitMove>,
): Promise<boolean> {
  if (move === null) return true;
  try {
    const recording = await recordLedgerMoveIntent(move.from, move.to, {
      waitMs: LEDGER_INTENT_REFUSING_WAIT_MS,
    });
    return recording !== 'not_durable';
  } catch {
    return false;
  }
}

/** Forgets the recorded move of a split that rolled back. */
function discardLedgerIntentOfSplitMove(
  move: ReturnType<typeof ledgerSplitMove>,
): void {
  if (move === null) return;
  try {
    discardLedgerMoveIntent(move.from, move.to);
  } catch {
    // The startup pass drops an intent whose move never committed.
  }
}

/**
 * Tells the Ledger that the split committed, once promotion committed every
 * kept destination and before the source teardown. Never fails the split.
 */
function notifyLedgerOfSplitMove(
  move: ReturnType<typeof ledgerSplitMove>,
): void {
  if (move === null) return;
  try {
    notifyLedgerContainerMoved(move.from, move.to);
  } catch {
    // The participant never throws. A defect in it must not fail a committed
    // split; startup reconciliation settles the scope.
  }
}

/** Planned result entry for a repo, used for both the fast response and the
 * final completion event. */
function plannedResultEntry(
  plan: PlannedSplitRepo,
): SplitTemporaryWorkspaceResultEntry {
  if (plan.selection === 'remove' && plan.removalMode === 'delete') {
    return {
      repoId: plan.repo.id,
      repoName: plan.repo.name,
      disposition: 'deleted',
    };
  }
  if (plan.selection === 'remove') {
    return {
      repoId: plan.repo.id,
      repoName: plan.repo.name,
      disposition: 'archived',
      ...(plan.destination
        ? { destinationWorkspaceId: plan.destination.id }
        : {}),
    };
  }
  return {
    repoId: plan.repo.id,
    repoName: plan.repo.name,
    disposition: 'split',
    ...(plan.destination
      ? { destinationWorkspaceId: plan.destination.id }
      : {}),
    ...(plan.destinationWorktreeId !== undefined
      ? { destinationWorktreeId: plan.destinationWorktreeId }
      : {}),
  };
}

function buildNavigationTarget(
  results: SplitTemporaryWorkspaceResultEntry[],
): SplitTemporaryWorkspaceResponse['navigationTarget'] {
  const firstSplit = results.find((entry) => entry.disposition === 'split');
  const firstArchived = results.find(
    (entry) => entry.disposition === 'archived',
  );
  if (
    firstSplit &&
    firstSplit.destinationWorkspaceId !== undefined &&
    firstSplit.destinationWorktreeId !== undefined
  ) {
    return {
      kind: 'worktree',
      workspaceId: firstSplit.destinationWorkspaceId,
      worktreeId: firstSplit.destinationWorktreeId,
    };
  }
  if (firstArchived && firstArchived.destinationWorkspaceId !== undefined) {
    return {
      kind: 'workspace',
      workspaceId: firstArchived.destinationWorkspaceId,
    };
  }
  return { kind: 'home' };
}

/**
 * Split a temporary multi-repo workspace worktree back into per-repo
 * single-repo worktrees.
 *
 * Two-phase: the returned promise resolves after the FAST phase — validation,
 * destination-workspace resolution/creation, and reservation of each split
 * destination worktree as a `setupPhase: 'git-pending'` row (so the renderer
 * can show the destinations immediately and queue chats against them, exactly
 * like deferred worktree creation). The SLOW phase (checkout moves, archive/
 * delete removals, source teardown) continues in the background:
 *
 * 1. Move — relocate kept and to-be-archived checkouts into their
 *    destinations. Reversible: any failure reverses the moves, removes the
 *    reserved rows and freshly created workspaces, and completes with
 *    `success: false`.
 * 2. Ready — after every checkout move and pipeline-execution migration has
 *    settled, flip all kept destination rows ready and fire
 *    `onSplitWorktreeReady` (which settles the destination's Git setup, so
 *    main releases sends it held).
 * 3. Finalize — hard-delete `delete` removals, archive `archive` removals in
 *    their destination workspace (a failed archive degrades to a kept split
 *    worktree rather than losing the checkout).
 * 4. Teardown — archive the now-empty source worktree without container
 *    retention, which also reports the empty temporary workspace for removal.
 * 5. Complete — fire `onComplete` with the final results and warnings.
 */
async function splitTemporaryWorkspaceWorktreeAdmitted(
  request: SplitTemporaryWorkspaceRequest,
  hooks: SplitTemporaryWorkspaceExecutionHooks | undefined,
  commit: W5CommitOptions,
  attempt: W5KeyedAttempt | undefined,
  complete: (
    result: SplitTemporaryWorkspaceResponse,
  ) => Promise<SplitTemporaryWorkspaceResponse>,
): Promise<SplitTemporaryWorkspaceResponse> {
  if (splitShutdownStarted) {
    throw new Error('Cannot split a project while the app is shutting down.');
  }
  const inFlightKey = `${request.workspaceId}/${request.worktreeId}`;
  if (inFlightSplits.has(inFlightKey)) {
    throw new Error('A split is already in progress for this worktree.');
  }
  let resolveLifecycle: () => void = () => {};
  const lifecycle = new Promise<void>((resolve) => {
    resolveLifecycle = resolve;
  });
  let lifecycleSettled = false;
  const settleLifecycle = (): void => {
    if (lifecycleSettled) {
      return;
    }
    lifecycleSettled = true;
    activeSplitLifecycles.delete(lifecycle);
    resolveLifecycle();
  };
  activeSplitLifecycles.add(lifecycle);
  inFlightSplits.add(inFlightKey);
  let lockAcquired = false;
  let backgroundStarted = false;
  const destinationClaims: DestinationWorktreeClaim[] = [];
  const destinationWorkspaceLeaseReleases: Array<() => void> = [];
  const reservedRecords: SplitDestinationReservation[] = [];
  try {
    acquireSplitLock(request.workspaceId, request.worktreeId);
    lockAcquired = true;
    const { worktree, repos } = await loadSplitSourceContext(
      request.workspaceId,
      request.worktreeId,
      !!commit.expectedRevisions || !!attempt,
    );
    await assertNoActiveWorktreeWork(request.workspaceId, request.worktreeId, {
      activeChats: 'Stop active chats before splitting this project.',
      runningScripts:
        'Wait for running scripts, such as setup, to finish before splitting this project.',
      runningPipelines:
        'Wait for running or paused workflow executions to finish before splitting this project.',
      blockedPipelineStatuses: new Set<ExecutionSummary['status']>([
        'running',
        'paused',
      ]),
    });
    const analysis = await analyzeSplitWorktreeItems(
      request.workspaceId,
      request.worktreeId,
      repos,
    );
    destinationWorkspaceLeaseReleases.push(
      await acquireSplitDestinationWorkspaceLeases(
        repos.map((repo) => repo.repoPath),
      ),
    );
    const destinations = await resolveSplitDestinations(request, repos, {
      // The repository-identity lease is now held, so a cached preview miss is
      // no longer authoritative. Refresh it to ensure approval covers the
      // destination execution will actually use.
      reuseNegativeResults: false,
      readOnly: !!commit.expectedRevisions || !!attempt,
    });
    const destinationWorkspaceIds = Array.from(
      new Set(
        Array.from(destinations.values())
          .map((destination) => destination?.id)
          .filter((id): id is string => id !== undefined),
      ),
    );
    for (const workspaceId of destinationWorkspaceIds) {
      destinationWorkspaceLeaseReleases.push(
        acquireWorkspaceArchiveRetentionLease(workspaceId),
      );
    }
    const preparedPreview = prepareSplitPreview(
      request,
      repos,
      analysis,
      destinations,
    );
    hooks?.consumeDestructiveApproval?.(preparedPreview.response);
    const rootAction: 'archive' | 'delete' =
      request.rootAction === 'archive' ? 'archive' : 'delete';
    const rootPresent = preparedPreview.response.root.present;
    if (
      rootPresent &&
      rootAction === 'archive' &&
      !preparedPreview.response.root.canArchive
    ) {
      throw new Error(
        'Project root items cannot be retained because deletion retention is unavailable. Choose Delete instead.',
      );
    }

    const warnings: string[] = [];
    const createdWorkspaceIds: string[] = [];
    // Fast phase: plan, create missing destination workspaces, and reserve
    // split destination rows. A failure here aborts before any checkout has
    // moved, with created workspaces and reserved rows rolled back.
    const planned: PlannedSplitRepo[] = [];
    try {
      for (const repo of repos) {
        const selection: SplitTemporaryWorkspaceSelection =
          request.selections[repo.id] === 'remove' ? 'remove' : 'split';
        const sourcePath = getWorkspaceWorktreeRepoDir(
          request.workspaceId,
          request.worktreeId,
          repo.id,
        );
        let destination = preparedPreview.destinations.get(repo.id);
        const previewRepo = preparedPreview.response.repos.find(
          (entry) => entry.repoId === repo.id,
        );
        if (!previewRepo) {
          throw new Error(`Split plan is missing repo ${repo.id}.`);
        }
        const removalMode = previewRepo.removalMode;
        const plan: PlannedSplitRepo = {
          repo,
          selection,
          removalMode,
          destination,
          sourcePath,
        };
        planned.push(plan);
        const needsDestination =
          selection === 'split' ||
          (selection === 'remove' && removalMode === 'archive');
        if (!needsDestination) {
          continue;
        }
        if (!(await pathExists(sourcePath))) {
          throw new Error(
            `Cannot split this project because the checkout for repo "${repo.name}" is missing. No source data was changed.`,
          );
        }
        if (!destination) {
          attempt?.beforeEffects();
          const resolved = await findOrCreateSingleRepoWorkspaceForRepo(
            repo.repoPath,
            repo.name,
            { splitDestinationLeaseHeld: true, commit },
          );
          if (!resolved.created) {
            throw new Error(
              `The destination for repo "${repo.name}" changed after the split preview. Reopen the Split project dialog and review the updated destination.`,
            );
          }
          destination = resolved.workspace;
          createdWorkspaceIds.push(destination.id);
          destinationWorkspaceLeaseReleases.push(
            acquireWorkspaceArchiveRetentionLease(destination.id),
          );
          plan.destination = destination;
        }
        // Every surviving destination (split AND archive removal) gets its
        // worktree id and durable recovery row before repo-owned stores move.
        // Archive removals use a hidden row during the live transaction; boot
        // recovery exposes it if the process exits before archival commits.
        const destinationWorkspace = destination;
        await withDestinationAllocationLock(
          destinationWorkspace.id,
          async () => {
            const claimedIds = getDestinationWorktreeClaims(
              destinationWorkspace.id,
            );
            const destinationWorktreeId =
              await allocateAdhocDestinationWorktreeId(
                destinationWorkspace.id,
                request.worktreeId,
                claimedIds,
              );
            acquireSplitDestinationWorktreeClaim(
              destinationWorkspace.id,
              destinationWorktreeId,
            );
            claimedIds.add(destinationWorktreeId);
            destinationClaims.push({
              workspaceId: destinationWorkspace.id,
              worktreeId: destinationWorktreeId,
            });
            plan.destinationWorktreeId = destinationWorktreeId;
            const reservation: WorktreeData = {
              id: destinationWorktreeId,
              branchName: worktree.branchName ?? destinationWorktreeId,
              createdAt: worktree.createdAt,
              setupPhase: 'git-pending',
              splitRecoveryRequired: true,
              ...(selection === 'remove' ? { hidden: true } : {}),
              ...(worktree.label ? { label: worktree.label } : {}),
              ...(worktree.trackedRepoBaseBranches?.[repo.id]
                ? {
                    trackedBaseBranch:
                      worktree.trackedRepoBaseBranches[repo.id],
                  }
                : {}),
            };
            await reserveSplitDestinationRecord(
              {
                source: 'temporary_split',
                workspaceId: destinationWorkspace.id,
                worktree: reservation,
              },
              commit,
            );
            reservedRecords.push({
              workspaceId: destinationWorkspace.id,
              worktreeId: destinationWorktreeId,
              createdAt: reservation.createdAt,
            });
            beginWorktreeGitSetup(
              destinationWorkspace.id,
              destinationWorktreeId,
            );
          },
        );
      }
    } catch (error) {
      const rollbackErrors = await rollbackFastPhaseReservations(
        reservedRecords,
        hooks,
      );
      if (rollbackErrors.length === 0) {
        await removeCreatedWorkspaces(createdWorkspaceIds, {
          ownClaims: destinationClaims,
        });
      } else {
        throw splitFastPhaseRollbackError(error, rollbackErrors);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    // Migrate repo-owned chats and tracked plans to their destinations now
    // (fast JSON work) so they are already on disk when the renderer selects
    // a destination worktree. Self-undoing on failure; a failure aborts the
    // split with reservations and created workspaces rolled back.
    const targets = buildItemMigrationTargets(planned);
    const recoveryReservations = buildSplitRecoveryReservations(
      planned,
      worktree,
      reservedRecords,
    );
    const hardDeleteRepoIds = new Set(
      planned
        .filter(
          (plan) =>
            plan.selection === 'remove' && plan.removalMode === 'delete',
        )
        .map((plan) => plan.repo.id),
    );
    const hardDeleteExecutionsByRepo = new Map(
      Array.from(hardDeleteRepoIds).map((repoId) => [
        repoId,
        analysis.perRepo.get(repoId)?.executions ?? [],
      ]),
    );
    let itemsUndo: SplitItemsMigrationUndo;
    try {
      attempt?.beforeEffects();
      itemsUndo = await migrateSplitChatsAndPlans({
        workspaceId: request.workspaceId,
        worktreeId: request.worktreeId,
        analysis,
        targets,
        hardDeleteRepoIds,
      });
    } catch (error) {
      const rollbackFailed =
        error instanceof Error &&
        error.name === 'SplitItemsMigrationRollbackError';
      if (rollbackFailed) {
        const markingErrors = await markSplitRecoveryReservations(
          recoveryReservations,
          hooks,
          error,
        );
        if (markingErrors.length > 0) {
          const markingDetails = markingErrors
            .map((markingError) =>
              markingError instanceof Error
                ? markingError.message
                : String(markingError),
            )
            .join('; ');
          throw new Error(
            `${error.message} Some retained destinations could not be marked for recovery: ${markingDetails}`,
          );
        }
      } else {
        const rollbackErrors = await rollbackFastPhaseReservations(
          reservedRecords,
          hooks,
        );
        if (rollbackErrors.length === 0) {
          await removeCreatedWorkspaces(createdWorkspaceIds, {
            ownClaims: destinationClaims,
          });
        } else {
          throw splitFastPhaseRollbackError(error, rollbackErrors);
        }
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    let completionEmitted = false;
    const backgroundHooks: SplitTemporaryWorkspaceExecutionHooks = {
      ...hooks,
      onComplete: (event): void => {
        if (completionEmitted) {
          return;
        }
        completionEmitted = true;
        try {
          hooks?.onComplete?.(event);
        } catch {
          // Completion delivery must not reject the tracked background phase.
        }
      },
    };
    const plannedResults = planned.map(plannedResultEntry);
    const response = await complete({
      success: true,
      results: plannedResults,
      warnings: [...warnings],
      navigationTarget: buildNavigationTarget(plannedResults),
    });

    // Background phase — never awaited by the IPC caller.
    backgroundStarted = true;
    const backgroundPhase = runSplitBackgroundPhase({
      request,
      worktree,
      planned,
      warnings,
      createdWorkspaceIds,
      reservedRecords,
      recoveryReservations,
      destinationClaims,
      targets,
      itemsUndo,
      hardDeleteExecutionsByRepo,
      rootAction,
      rootPresent,
      hooks: backgroundHooks,
    }).catch((error: unknown) => {
      backgroundHooks.onComplete?.({
        workspaceId: request.workspaceId,
        worktreeId: request.worktreeId,
        success: false,
        results: [],
        warnings,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    trackDetachedWork(() =>
      backgroundPhase.finally(() => {
        cancelUnsettledSplitDestinationGitSetups(reservedRecords);
        releaseDestinationWorktreeClaims(destinationClaims);
        for (const release of destinationWorkspaceLeaseReleases.reverse()) {
          release();
        }
        inFlightSplits.delete(inFlightKey);
        if (lockAcquired) {
          releaseSplitLock(request.workspaceId, request.worktreeId);
        }
        settleLifecycle();
      }),
    );

    return response;
  } finally {
    if (!backgroundStarted) {
      cancelUnsettledSplitDestinationGitSetups(reservedRecords);
      releaseDestinationWorktreeClaims(destinationClaims);
      for (const release of destinationWorkspaceLeaseReleases.reverse()) {
        release();
      }
      inFlightSplits.delete(inFlightKey);
      if (lockAcquired) {
        releaseSplitLock(request.workspaceId, request.worktreeId);
      }
      settleLifecycle();
    }
  }
}

export type WorkspaceSplitRequest = SplitTemporaryWorkspaceRequest &
  W5BoundaryOptions;
const splitOutcomeSchema = z.object({
  success: z.boolean(),
  results: z.array(
    z.object({
      repoId: z.string(),
      repoName: z.string(),
      disposition: z.enum(['split', 'archived', 'deleted']),
      destinationWorkspaceId: z.string().optional(),
      destinationWorktreeId: z.string().optional(),
    }),
  ),
  warnings: z.array(z.string()),
  navigationTarget: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('worktree'),
      workspaceId: z.string(),
      worktreeId: z.string(),
    }),
    z.object({ kind: z.literal('workspace'), workspaceId: z.string() }),
    z.object({ kind: z.literal('home') }),
  ]),
});

/** The key describes foreground acceptance; background completion keeps its events. */
export function splitTemporaryWorkspaceWorktree(
  request: WorkspaceSplitRequest,
  hooks?: SplitTemporaryWorkspaceExecutionHooks,
): Promise<SplitTemporaryWorkspaceResponse> {
  return runW5BoundaryOperation(
    {
      operation: 'core.workspace.composition.split',
      caller: 'desktop-host:composition-split',
      idempotencyKey: request.idempotencyKey,
      parameters: {
        workspaceId: request.workspaceId,
        worktreeId: request.worktreeId,
        selections: request.selections,
        rootAction: request.rootAction ?? 'delete',
        previewRevision: request.previewRevision,
        destructiveApprovalToken: request.destructiveApprovalToken,
      },
      recheckAtOutcome: true,
      isPreEffectRefusal: (error) => error instanceof W5RevisionConflictError,
    },
    (outcome) => decodeW5CompositionOutcome(splitOutcomeSchema, outcome),
    async (commit, attempt, complete) => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.worktreeId, 'worktreeId');
      commit.expectedRevisions = w5ExpectedRevision(
        { kind: 'workspace', workspaceId: request.workspaceId },
        request.expectedRevision,
      );
      if (commit.expectedRevisions?.length)
        await checkW5CompositionRevisions(commit);
      return admitW5Composition(attempt, () =>
        splitTemporaryWorkspaceWorktreeAdmitted(
          request,
          withSplitDestinationGitSetup(hooks),
          commit,
          attempt,
          complete,
        ),
      );
    },
  );
}

/** Item-migration targets: every surviving destination (split or archive). */
function buildItemMigrationTargets(
  planned: PlannedSplitRepo[],
): SplitItemsMigrationTarget[] {
  const targets: SplitItemsMigrationTarget[] = [];
  for (const plan of planned) {
    if (
      !plan.destination ||
      plan.destinationWorktreeId === undefined ||
      (plan.selection === 'remove' && plan.removalMode === 'delete')
    ) {
      continue;
    }
    targets.push({
      repoId: plan.repo.id,
      destinationWorkspaceId: plan.destination.id,
      destinationWorktreeId: plan.destinationWorktreeId,
      oldCheckoutPath: plan.sourcePath,
      newCheckoutPath: getWorkspaceWorktreeDir(
        plan.destination.id,
        plan.destinationWorktreeId,
      ),
    });
  }
  return targets;
}

async function runSplitBackgroundPhase(args: {
  request: SplitTemporaryWorkspaceRequest;
  worktree: WorktreeData;
  planned: PlannedSplitRepo[];
  warnings: string[];
  createdWorkspaceIds: string[];
  reservedRecords: SplitDestinationReservation[];
  recoveryReservations: SplitDestinationReservation[];
  destinationClaims: DestinationWorktreeClaim[];
  targets: SplitItemsMigrationTarget[];
  itemsUndo: SplitItemsMigrationUndo;
  hardDeleteExecutionsByRepo: Map<string, ExecutionSummary[]>;
  rootAction: 'archive' | 'delete';
  rootPresent: boolean;
  hooks?: SplitTemporaryWorkspaceExecutionHooks;
}): Promise<void> {
  const {
    request,
    worktree,
    planned,
    warnings,
    createdWorkspaceIds,
    reservedRecords,
    recoveryReservations,
    destinationClaims,
    targets,
    itemsUndo,
    hardDeleteExecutionsByRepo,
    rootAction,
    rootPresent,
    hooks,
  } = args;

  const complete = (event: SplitTemporaryWorkspaceCompleteEvent): void => {
    try {
      hooks?.onComplete?.(event);
    } catch {
      // Event delivery must never crash the background phase.
    }
  };

  let executionSnapshots = new Map<string, ExecutionState>();

  // Stage 1: reversible checkout moves for kept (split) repos.
  const moved: Array<{ repoPath: string; oldPath: string; newPath: string }> =
    [];
  const readyEvents: WorktreeGitReadyEvent[] = [];
  const rollbackReversibleStage = async (error: unknown): Promise<void> => {
    const rollbackErrors: unknown[] = [];
    await reverseMovedCheckouts(moved, rollbackErrors);
    await undoSplitChatsAndPlansMigration(itemsUndo).catch((rollbackError) =>
      rollbackErrors.push(rollbackError),
    );
    await restoreSplitExecutionSnapshots(executionSnapshots).catch(
      (rollbackError) => rollbackErrors.push(rollbackError),
    );

    const preservedReservations: SplitDestinationReservation[] = [];
    if (rollbackErrors.length === 0) {
      for (const reserved of [...reservedRecords].reverse()) {
        const containsData = await hasSplitWorktreeStoredItems(
          reserved.workspaceId,
          reserved.worktreeId,
        ).catch(() => true);
        if (containsData) {
          preservedReservations.push(reserved);
          continue;
        }
        await removeSplitDestinationRecord({
          source: 'temporary_split',
          ...reserved,
        }).catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
    } else {
      preservedReservations.push(...reservedRecords);
    }
    const reservationsToMark =
      rollbackErrors.length > 0 ? recoveryReservations : preservedReservations;
    if (reservationsToMark.length > 0) {
      const markingErrors = await markSplitRecoveryReservations(
        reservationsToMark,
        hooks,
        error instanceof Error ? error : new Error(String(error)),
      );
      rollbackErrors.push(...markingErrors);
    }
    if (preservedReservations.length > 0) {
      warnings.push(
        rollbackErrors.length > 0
          ? 'Destination worktree reservations were retained because rollback did not fully restore the source state.'
          : 'Some destination worktrees were retained because they contain data created after the split started.',
      );
    }
    if (rollbackErrors.length === 0) {
      try {
        const preservedWorkspaceIds = await removeCreatedWorkspaces(
          createdWorkspaceIds,
          {
            preserveRollbackData: true,
            rollbackTargets: targets,
            ownClaims: destinationClaims,
          },
        );
        if (preservedWorkspaceIds.length > 0) {
          warnings.push(
            'Some newly created destination projects were retained because they contain data created after the split started.',
          );
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      warnings.push(
        'Rollback did not fully restore the split state; destination metadata and data were retained for recovery.',
      );
    }
    complete({
      workspaceId: request.workspaceId,
      worktreeId: request.worktreeId,
      success: false,
      results: [],
      warnings,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  try {
    for (const plan of planned) {
      if (
        plan.selection !== 'split' ||
        !plan.destination ||
        plan.destinationWorktreeId === undefined
      ) {
        continue;
      }
      const destinationPath = getWorkspaceWorktreeDir(
        plan.destination.id,
        plan.destinationWorktreeId,
      );
      await mkdir(dirname(destinationPath), { recursive: true });
      await moveWorktreeWithRetry(
        plan.repo.repoPath,
        plan.sourcePath,
        destinationPath,
      );
      moved.push({
        repoPath: plan.repo.repoPath,
        oldPath: plan.sourcePath,
        newPath: destinationPath,
      });
      const branchName =
        (await getCurrentBranch(destinationPath).catch(() => null)) ??
        worktree.branchName ??
        plan.destinationWorktreeId;
      const readyWorktreeId = plan.destinationWorktreeId;
      readyEvents.push({
        projectId: plan.destination.id,
        worktreeId: readyWorktreeId,
        branchName,
      });
    }
  } catch (error) {
    await rollbackReversibleStage(error);
    return;
  }

  // Re-home repo-owned pipeline executions before the ready events so the
  // destination worktrees hydrate with their runs. Ordinary failures restore
  // the executions to the source and roll back the reversible split stage.
  try {
    executionSnapshots = await migrateSplitPipelineExecutions({
      workspaceId: request.workspaceId,
      worktreeId: request.worktreeId,
      targets,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'SplitExecutionMigrationRollbackError'
    ) {
      const markingErrors = await markSplitRecoveryReservations(
        recoveryReservations,
        hooks,
        error,
      );
      warnings.push(
        'Workflow execution migration rollback was incomplete; destination state was retained and source teardown was stopped.',
      );
      if (markingErrors.length > 0) {
        warnings.push(
          `Some retained destinations could not be marked for recovery: ${markingErrors
            .map((markingError) =>
              markingError instanceof Error
                ? markingError.message
                : String(markingError),
            )
            .join('; ')}`,
        );
      }
      complete({
        workspaceId: request.workspaceId,
        worktreeId: request.worktreeId,
        success: false,
        results: [],
        warnings,
        error: error.message,
      });
      return;
    }
    warnings.push(
      'Workflow execution migration failed; the split was rolled back before source teardown.',
    );
    await rollbackReversibleStage(error);
    return;
  }

  // All reversible moves and execution migrations settled. Promote every
  // reservation before publishing any ready event so consumers cannot use a
  // destination while a later reservation can still force rollback.
  const ledgerMove = ledgerSplitMove(
    request.workspaceId,
    worktree,
    readyEvents,
  );
  let ledgerMoveRecorded = false;
  try {
    // Durable before promotion commits the destination; without it the
    // split rolls back rather than leave the mapping only in memory.
    ledgerMoveRecorded = true;
    if (!(await recordLedgerIntentOfSplitMove(ledgerMove))) {
      throw new Error(LEDGER_SPLIT_NOT_SAVED_MESSAGE);
    }
    for (const event of readyEvents) {
      await promoteSplitDestinationRecord({
        source: 'temporary_split',
        workspaceId: event.projectId,
        worktreeId: event.worktreeId,
        createdAt: worktree.createdAt,
        branchName: event.branchName,
      });
    }
  } catch (error) {
    if (ledgerMoveRecorded) discardLedgerIntentOfSplitMove(ledgerMove);
    await rollbackReversibleStage(error);
    return;
  }

  // Reservation promotion is the last operation that can roll the reversible
  // stage back. The Ledger learns of the move now, before the source teardown
  // below removes the source row.
  notifyLedgerOfSplitMove(ledgerMove);

  // Only now is it safe to discard the source attachment backup; cleanup
  // failure leaves a recoverable duplicate and must not undo promoted
  // destinations or delete their surviving attachment copies.
  try {
    await finalizeSplitChatsAndPlansMigration(itemsUndo);
  } catch (error) {
    warnings.push(
      `The temporary attachment backup could not be removed and was retained for recovery: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  for (const event of readyEvents) {
    try {
      hooks?.onSplitWorktreeReady?.(event);
    } catch {
      // Event delivery must never crash the background phase.
    }
  }

  // Stage 2: irreversible removals. Failures degrade with warnings — a
  // failed archive keeps the split worktree; a failed delete leaves the
  // checkout for the source teardown below.
  const results: SplitTemporaryWorkspaceResultEntry[] = [];
  const restorePendingArchiveTargets = async (
    startIndex: number,
  ): Promise<void> => {
    for (const pendingPlan of planned.slice(startIndex)) {
      if (
        pendingPlan.selection !== 'remove' ||
        pendingPlan.removalMode !== 'archive'
      ) {
        continue;
      }
      const pendingTarget = targets.find(
        (candidate) => candidate.repoId === pendingPlan.repo.id,
      );
      if (!pendingTarget) {
        warnings.push(
          `Archive migration target for unprocessed repo "${pendingPlan.repo.name}" was not found during source restoration.`,
        );
        continue;
      }
      try {
        await settleAll([
          undoSplitChatsAndPlansTargetMigration(itemsUndo, pendingTarget),
          restoreSplitExecutionSnapshotsForTarget(
            executionSnapshots,
            pendingTarget,
          ),
        ]);
        await removeSplitDestinationRecord({
          source: 'temporary_split',
          workspaceId: pendingTarget.destinationWorkspaceId,
          worktreeId: pendingTarget.destinationWorktreeId,
          createdAt: worktree.createdAt,
        });
      } catch (restorationError) {
        const recoveryReservation =
          recoveryReservations.find(
            (reservation) =>
              reservation.workspaceId ===
                pendingTarget.destinationWorkspaceId &&
              reservation.worktreeId === pendingTarget.destinationWorktreeId,
          ) ?? buildSplitRecoveryReservations([pendingPlan], worktree, [])[0];
        const normalizedError =
          restorationError instanceof Error
            ? restorationError
            : new Error(String(restorationError));
        const markingErrors = recoveryReservation
          ? await markSplitRecoveryReservations(
              [recoveryReservation],
              hooks,
              normalizedError,
            )
          : [new Error('Archive recovery reservation was not found.')];
        warnings.push(
          `Migrated data for unprocessed repo "${pendingPlan.repo.name}" could not be fully restored to the source; its destination was retained for recovery: ${normalizedError.message}`,
        );
        if (markingErrors.length > 0) {
          warnings.push(
            `The retained archive destination for repo "${pendingPlan.repo.name}" could not be marked for recovery: ${markingErrors
              .map((markingError) =>
                markingError instanceof Error
                  ? markingError.message
                  : String(markingError),
              )
              .join('; ')}`,
          );
        }
      }
    }
  };
  for (let planIndex = 0; planIndex < planned.length; planIndex += 1) {
    const plan = planned[planIndex];
    if (!plan) {
      continue;
    }
    if (plan.selection === 'remove' && plan.removalMode === 'delete') {
      if (await pathExists(plan.sourcePath)) {
        try {
          await safeRemoveWorktree(
            plan.repo.repoPath,
            plan.sourcePath,
            'split-temporary-workspace-delete',
          );
        } catch (error) {
          warnings.push(
            `Repo "${plan.repo.name}" could not be deleted directly; source teardown will retry: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      try {
        await deleteSplitPipelineExecutions(
          hardDeleteExecutionsByRepo.get(plan.repo.id) ?? [],
        );
      } catch (error) {
        await restorePendingArchiveTargets(planIndex + 1);
        complete({
          workspaceId: request.workspaceId,
          worktreeId: request.worktreeId,
          success: false,
          results,
          warnings,
          error: `Could not delete workflow records for removed repository "${plan.repo.name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return;
      }
      results.push(plannedResultEntry(plan));
      continue;
    }
    if (plan.selection === 'remove') {
      const target = targets.find(
        (candidate) => candidate.repoId === plan.repo.id,
      );
      if (!target) {
        complete({
          workspaceId: request.workspaceId,
          worktreeId: request.worktreeId,
          success: false,
          results,
          warnings,
          error: `Archive migration target for repo "${plan.repo.name}" was not found.`,
        });
        return;
      }
      const archived = await archiveRemovedRepo({
        worktree,
        plan,
        target,
        itemsUndo,
        executionSnapshots,
      });
      warnings.push(...archived.warnings);
      if (archived.result) {
        results.push(archived.result);
      }
      if (archived.readyEvent) {
        try {
          hooks?.onSplitWorktreeReady?.(archived.readyEvent);
        } catch {
          // Event delivery must never crash the background phase.
        }
      }
      if (archived.recoveryError) {
        const recoveryReservation =
          recoveryReservations.find(
            (reservation) =>
              reservation.workspaceId === target.destinationWorkspaceId &&
              reservation.worktreeId === target.destinationWorktreeId,
          ) ?? buildSplitRecoveryReservations([plan], worktree, [])[0];
        const markingErrors = recoveryReservation
          ? await markSplitRecoveryReservations(
              [recoveryReservation],
              hooks,
              archived.recoveryError,
            )
          : [new Error('Archive recovery reservation was not found.')];
        if (markingErrors.length > 0) {
          warnings.push(
            `The retained archive destination could not be marked for recovery: ${markingErrors
              .map((markingError) =>
                markingError instanceof Error
                  ? markingError.message
                  : String(markingError),
              )
              .join('; ')}`,
          );
        }
      }
      if (archived.fatalError) {
        await restorePendingArchiveTargets(planIndex + 1);
        complete({
          workspaceId: request.workspaceId,
          worktreeId: request.worktreeId,
          success: false,
          results,
          warnings,
          error: archived.fatalError,
        });
        return;
      }
      continue;
    }
    results.push(plannedResultEntry(plan));
  }

  // Stage 3: tear down the source worktree. Repo-owned items already moved
  // to their destinations, so the source stores now hold only root-tied
  // chats/plans/executions plus the attachments dir — with `rootAction:
  // 'archive'` the teardown captures exactly those into an archived entry of
  // the temporary workspace; with `delete` (default) they are removed. The
  // multi-repo archive path tolerates missing child directories, sweeps
  // leftovers, removes the worktree record, and reports the now-empty
  // temporary workspace (kept alive when a root archive container remains).
  try {
    const teardown = await archiveMultiRepoWorktree({
      archiveTrigger: 'split',
      workspaceId: request.workspaceId,
      worktreeId: request.worktreeId,
      observabilityMode: hooks?.liveServices
        ? 'live-service'
        : 'persisted-only',
      liveServices: hooks?.liveServices,
      retainAsArchivedContainer: rootPresent && rootAction === 'archive',
      requireArchivedContainer: rootPresent && rootAction === 'archive',
      lockAfterArchive: rootPresent && rootAction === 'archive',
      captureWorkspaceRootFiles: rootPresent && rootAction === 'archive',
      restoreScope:
        rootPresent && rootAction === 'archive'
          ? 'workspace-root-only'
          : undefined,
    });
    warnings.push(...teardown.warnings);
    complete({
      workspaceId: request.workspaceId,
      worktreeId: request.worktreeId,
      success: true,
      results,
      warnings,
      ...(rootPresent
        ? {
            rootDisposition:
              rootAction === 'archive'
                ? ('archived' as const)
                : ('deleted' as const),
          }
        : {}),
      ...(teardown.removedTemporaryWorkspaceId
        ? {
            removedTemporaryWorkspaceId: teardown.removedTemporaryWorkspaceId,
            removedTemporaryWorkspaceName:
              teardown.removedTemporaryWorkspaceName,
          }
        : {}),
    });
  } catch (error) {
    // Split/archive/delete outcomes above are real and kept; only the source
    // teardown failed, so surface that while the source row stays visible for
    // a retry via its own Archive/Delete action.
    complete({
      workspaceId: request.workspaceId,
      worktreeId: request.worktreeId,
      success: false,
      results,
      warnings,
      error: `Split destinations were created, but tearing down the source worktree failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

/**
 * Archive-removal for one repo: persist a transient destination row, move the
 * checkout in, then run the normal single-repo archive so the container lands
 * in the destination workspace. A move/archive failure after the checkout
 * moved degrades to a kept split worktree (with a ready event) instead of
 * losing the checkout.
 */
async function archiveRemovedRepo(params: {
  worktree: WorktreeData;
  plan: PlannedSplitRepo;
  target: SplitItemsMigrationTarget;
  itemsUndo: SplitItemsMigrationUndo;
  executionSnapshots: Map<string, ExecutionState>;
}): Promise<{
  result?: SplitTemporaryWorkspaceResultEntry;
  warnings: string[];
  readyEvent?: WorktreeGitReadyEvent;
  fatalError?: string;
  /** Present when destination state survived an incomplete source rollback. */
  recoveryError?: Error;
}> {
  const { worktree, plan, target, itemsUndo, executionSnapshots } = params;
  const warnings: string[] = [];
  const destination = plan.destination;
  const destinationWorktreeId = plan.destinationWorktreeId;
  if (!destination || destinationWorktreeId === undefined) {
    warnings.push(
      `No destination project for repo "${plan.repo.name}"; it was skipped.`,
    );
    return {
      warnings,
      fatalError: `Archive destination for repo "${plan.repo.name}" is unavailable.`,
    };
  }

  let movedIn = false;
  const rollbackTargetItems = async (): Promise<void> => {
    await settleAll([
      undoSplitChatsAndPlansTargetMigration(itemsUndo, target),
      restoreSplitExecutionSnapshotsForTarget(executionSnapshots, target),
    ]);
  };
  try {
    const destinationPath = getWorkspaceWorktreeDir(
      destination.id,
      destinationWorktreeId,
    );
    await mkdir(dirname(destinationPath), { recursive: true });
    await moveWorktreeWithRetry(
      plan.repo.repoPath,
      plan.sourcePath,
      destinationPath,
    );
    movedIn = true;
    const record = await buildSplitWorktreeRecord(
      worktree,
      plan.repo,
      destinationWorktreeId,
      destinationPath,
    );
    await recordSplitArchiveDestination({
      source: 'temporary_split',
      workspaceId: destination.id,
      worktree: record,
    });
    const archiveResponse = await archiveSingleRepoWorktree({
      archiveTrigger: 'split',
      workspaceId: destination.id,
      worktreeId: destinationWorktreeId,
      observabilityMode: 'persisted-only',
      retainAsArchivedContainer: true,
      requireArchivedContainer: true,
      lockAfterArchive: true,
    });
    warnings.push(...archiveResponse.warnings);
    return {
      result: {
        repoId: plan.repo.id,
        repoName: plan.repo.name,
        disposition: 'archived',
        destinationWorkspaceId: destination.id,
      },
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const destinationPath = getWorkspaceWorktreeDir(
      destination.id,
      destinationWorktreeId,
    );
    if (movedIn && (await pathExists(destinationPath))) {
      // The checkout survived. Before reporting a live split, make the row
      // durable even when the original failure came from the first write.
      try {
        const record = await buildSplitWorktreeRecord(
          worktree,
          plan.repo,
          destinationWorktreeId,
          destinationPath,
        );
        await recordSplitArchiveDestination({
          source: 'temporary_split',
          workspaceId: destination.id,
          worktree: record,
        });
        warnings.push(
          `Failed to archive repo "${plan.repo.name}" in project "${destination.name}"; it was kept as a worktree instead: ${message}`,
        );
        return {
          result: {
            repoId: plan.repo.id,
            repoName: plan.repo.name,
            disposition: 'split',
            destinationWorkspaceId: destination.id,
            destinationWorktreeId,
          },
          warnings,
          readyEvent: {
            projectId: destination.id,
            worktreeId: destinationWorktreeId,
            branchName: record.branchName,
          },
        };
      } catch (persistenceError) {
        const persistenceMessage =
          persistenceError instanceof Error
            ? persistenceError.message
            : String(persistenceError);
        try {
          await moveWorktreeWithRetry(
            plan.repo.repoPath,
            destinationPath,
            plan.sourcePath,
          );
          await rollbackTargetItems();
        } catch (rollbackError) {
          const rollbackMessage =
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError);
          const fatalError = `Repo "${plan.repo.name}" moved, but its destination row could not be persisted (${persistenceMessage}) and rollback failed (${rollbackMessage}). Source teardown was stopped to preserve recoverable data.`;
          return {
            warnings,
            fatalError,
            recoveryError: new Error(fatalError),
          };
        }
        return {
          warnings,
          fatalError: `Repo "${plan.repo.name}" could not be archived because its destination row was not durable: ${persistenceMessage}. Its checkout and migrated items were restored to the source worktree.`,
        };
      }
    }
    if (movedIn) {
      // The archive removed the checkout before throwing. Do not reinterpret
      // the explicit Archive request as a successful deletion, and do not
      // tear down the source's remaining data.
      try {
        await rollbackTargetItems();
      } catch (rollbackError) {
        const rollbackMessage =
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
        const fatalError = `Archive of repo "${plan.repo.name}" did not complete after removing its checkout (${message}), and migrated-item rollback failed (${rollbackMessage}). Source teardown was stopped to preserve recoverable data.`;
        return {
          warnings,
          fatalError,
          recoveryError: new Error(fatalError),
        };
      }
      return {
        warnings,
        fatalError: `Archive of repo "${plan.repo.name}" did not complete after removing its checkout: ${message}. Migrated items were restored and source teardown was stopped.`,
      };
    }
    // The checkout never left the source. Restore every item type for this
    // target and stop before the source teardown can turn Archive into Delete.
    try {
      await rollbackTargetItems();
      await removeSplitDestinationRecord({
        source: 'temporary_split',
        workspaceId: destination.id,
        worktreeId: destinationWorktreeId,
        createdAt: worktree.createdAt,
      });
    } catch (rollbackError) {
      const rollbackMessage =
        rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
      const fatalError = `Failed to archive repo "${plan.repo.name}" in project "${destination.name}" (${message}), and migrated-item rollback failed (${rollbackMessage}). Source teardown was stopped to preserve recoverable data.`;
      return {
        warnings,
        fatalError,
        recoveryError: new Error(fatalError),
      };
    }
    return {
      warnings,
      fatalError: `Failed to archive repo "${plan.repo.name}" in project "${destination.name}": ${message}. Its checkout and migrated items remain with the source worktree.`,
    };
  }
}
