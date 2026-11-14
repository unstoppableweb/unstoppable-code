import { withW5RepositoryLocks } from './w5-repository-locks';
import {
  commitW5BoundaryStep,
  w5CompositionLocks,
} from './w5-composition-operation';
import {
  afterW5Commit,
  afterW5Apply,
  outsideW5CommitScope,
} from './w5-commit-scope';
import {
  removeWorkspaceNonW5Children,
  removeWorkspaceDirectoryAfterRecordRemoval,
} from './w5-workspace-directory-removal';
import type {
  MultiRepoSidebarItem,
  WorkspaceRepoData,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { w5RecordReadPaths } from './paths';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { IdentifierValidationError, validateId } from './validation';
import { WorkspaceIndexUnreadableError } from './workspace-index-repository';
import { WorkspaceConfigUnreadableError } from './workspace-persistence';
import { WorktreeRegistryUnreadableError } from './worktree-list-repository';
import {
  WORKSPACE_INDEX_STORAGE,
  WORKSPACE_MANIFEST_STORAGE,
  WORKTREE_LIST_STORAGE,
  withStorageAdmission,
} from './w5-storage';
import {
  compositionIdentityChanged,
  CompositionRecordRefusedError,
  isSameIncarnation,
  type CompositionRecordRefusal,
} from './worktree-record-decision-apply';
import {
  applyWorkspaceIndexDecision,
  applyWorkspaceIndexRemoval,
  applyWorkspaceRecordsRemoval,
  applyWorkspaceManifestDecision,
  applyWorktreeListRemoval,
  applyWorktreeListUpdate,
} from './workspace-record-decision-port';
import type {
  CompositionSourceFields,
  WorktreeIncarnation,
} from './worktree-record-decisions';

export {
  buildDestinationWorktree,
  CompositionRecordRefusedError,
  mapTrackedRepoBaseBranches,
  type CompositionRecordRefusal,
} from './worktree-record-decision-apply';

/** CAN-3823 part A: in-process records only; Git and item movement stay in the callers. */
export type CompositionRecordSource =
  | 'workspace_combine'
  | 'existing_worktree_join';
interface CompositionRequest {
  source: CompositionRecordSource;
  workspaceId: string;
}
function refuse(
  reason: CompositionRecordRefusal,
  message: string,
): CompositionRecordRefusedError {
  return new CompositionRecordRefusedError(reason, message);
}
function admitId(value: string, label: string): void {
  try {
    validateId(value, label);
  } catch (error) {
    if (error instanceof IdentifierValidationError)
      throw refuse('invalid-request', error.message);
    throw error;
  }
}
function admit(
  workspaceId: string,
  source: string,
  allowed: readonly string[],
): void {
  if (!allowed.includes(source))
    throw refuse('invalid-request', 'Unknown workspace composition source');
  admitId(workspaceId, 'workspaceId');
}
const COMBINE_SOURCES: readonly CompositionRecordSource[] = [
  'workspace_combine',
  'existing_worktree_join',
];
export type CompositionRowIdentity = WorktreeIncarnation;
function admitRow(row: CompositionRowIdentity): void {
  admitId(row.id, 'worktreeId');
  if (!row.createdAt?.trim())
    throw refuse('invalid-request', 'Invalid composition worktree identity');
}
function incarnation(row: CompositionRowIdentity): WorktreeIncarnation {
  return { id: row.id, createdAt: row.createdAt };
}
async function listWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof WorktreeRegistryUnreadableError)
      throw refuse('worktrees-unavailable', error.message);
    throw error;
  }
}
async function manifestWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError)
      throw refuse('configuration-unavailable', error.message);
    throw error;
  }
}
const EXISTING_LIST = {
  requireAuthoritativeRead: true,
  requireExistingList: true,
};
// A failed composition removal stays retryable with its row still visible.
const EXISTING_LIST_REMOVAL = { ...EXISTING_LIST, markRemovedAfterWrite: true };

export interface JoinedWorktreeRecord extends CompositionRequest {
  worktreeId: string;
  sourceWorktree: WorktreeData;
  consumedWorktrees?: readonly WorktreeData[];
  repoIdRewrites: Record<string, string>;
  compatibilitySymlinks: NonNullable<WorktreeData['compatibilitySymlinks']>;
  transition: NonNullable<WorktreeData['adhocTransitionSource']>;
  joinedTrackedBranches?: WorktreeData['trackedRepoBaseBranches'];
}
export interface JoinedWorktreeUndo extends CompositionRowRequest {
  /** Absent when this operation appended a new row. */
  before?: WorktreeData;
  written: WorktreeData;
}
export interface JoinedWorktreeOutcome {
  worktree: WorktreeData;
  /** A retry that wrote nothing has nothing to undo. */
  undo?: JoinedWorktreeUndo;
}
/** Records the destination once. A retry keeps its current fields and never duplicates it. */
export async function recordJoinedWorktree(
  request: JoinedWorktreeRecord,
): Promise<JoinedWorktreeOutcome> {
  admit(request.workspaceId, request.source, COMBINE_SOURCES);
  const identity = {
    id: request.worktreeId,
    createdAt: request.sourceWorktree.createdAt,
  };
  admitRow(identity);
  const { worktrees: rows, recorded } = await listWrite(() =>
    applyWorktreeListUpdate(
      request.workspaceId,
      {
        kind: 'composition.join.record',
        worktreeId: request.worktreeId,
        sourceWorktree: request.sourceWorktree,
        consumedWorktrees: request.consumedWorktrees,
        repoIdRewrites: request.repoIdRewrites,
        compatibilitySymlinks: request.compatibilitySymlinks,
        transition: request.transition,
        joinedTrackedBranches: request.joinedTrackedBranches,
      },
      EXISTING_LIST,
    ),
  );
  const committed = rows.find((row) => isSameIncarnation(row, identity));
  if (!committed) throw compositionIdentityChanged(identity.id);
  return {
    worktree: committed,
    undo: recorded && {
      source: request.source,
      workspaceId: request.workspaceId,
      worktree: identity,
      before: recorded.before,
      written: recorded.written,
    },
  };
}

/** Undo only the appended incarnation or the composition fields of a reservation extended here. */
export async function undoJoinedWorktree(
  request: JoinedWorktreeUndo,
): Promise<void> {
  admit(request.workspaceId, request.source, COMBINE_SOURCES);
  admitRow(request.worktree);
  const { before } = request;
  if (!before) {
    await removeCompositionWorktree(request);
    return;
  }
  await listWrite(() =>
    applyWorktreeListUpdate(
      request.workspaceId,
      {
        kind: 'composition.join.undo',
        worktree: incarnation(request.worktree),
        before,
        written: request.written,
      },
      EXISTING_LIST,
    ),
  );
}

export interface CompositionRowRequest extends CompositionRequest {
  worktree: CompositionRowIdentity;
}
export interface RemovedCompositionRows {
  rows: WorktreeData[];
  /** Identity-only anchors read under the removal lock; never a state snapshot. */
  order: string[];
}
/** Removes only the consumed incarnation and returns exactly the row removed under the lock. */
export async function removeCompositionWorktree(
  request: CompositionRowRequest,
): Promise<RemovedCompositionRows> {
  admit(request.workspaceId, request.source, COMBINE_SOURCES);
  admitRow(request.worktree);
  return listWrite(() =>
    applyWorktreeListRemoval(
      request.workspaceId,
      {
        kind: 'composition.row.remove',
        worktree: incarnation(request.worktree),
      },
      EXISTING_LIST_REMOVAL,
    ),
  );
}
export interface CompositionRowsRestore extends CompositionRequest {
  rows: readonly WorktreeData[];
  order?: readonly string[];
}
/** Adds back only removed rows; current rows, fields and order survive rollback. */
export async function restoreCompositionWorktrees(
  request: CompositionRowsRestore,
): Promise<void> {
  admit(request.workspaceId, request.source, COMBINE_SOURCES);
  request.rows.forEach(admitRow);
  await listWrite(() =>
    applyWorktreeListUpdate(
      request.workspaceId,
      {
        kind: 'composition.rows.restore',
        rows: request.rows,
        order: request.order,
      },
      { ...EXISTING_LIST, restoreWorktrees: request.rows },
    ),
  );
}

export interface CompositionSourceUndo extends CompositionRowRequest {
  before: CompositionSourceFields;
  written: CompositionSourceFields;
}
export interface CompositionSourceRecord extends CompositionRowRequest {
  trackedBranches?: WorktreeData['trackedRepoBaseBranches'];
  compatibilitySymlinks: NonNullable<WorktreeData['compatibilitySymlinks']>;
  transition: NonNullable<WorktreeData['adhocTransitionSource']>;
}
/** Marks the source's absorption of the joined worktree; other row fields stay current. */
export async function recordCompositionSource(
  request: CompositionSourceRecord,
): Promise<CompositionSourceUndo> {
  admit(request.workspaceId, request.source, COMBINE_SOURCES);
  admitRow(request.worktree);
  const { recorded } = await listWrite(() =>
    applyWorktreeListUpdate(
      request.workspaceId,
      {
        kind: 'composition.source.record',
        worktree: incarnation(request.worktree),
        trackedBranches: request.trackedBranches,
        compatibilitySymlinks: request.compatibilitySymlinks,
        transition: request.transition,
      },
      EXISTING_LIST,
    ),
  );
  if (!recorded)
    throw refuse('not-found', `Worktree ${request.worktree.id} not found`);
  return {
    source: request.source,
    workspaceId: request.workspaceId,
    worktree: request.worktree,
    before: recorded.before,
    written: recorded.written,
  };
}
/** Compare each owned value before undoing it; competing edits of that field survive too. */
export async function undoCompositionSource(
  request: CompositionSourceUndo,
): Promise<void> {
  admit(request.workspaceId, request.source, COMBINE_SOURCES);
  admitRow(request.worktree);
  await listWrite(() =>
    applyWorktreeListUpdate(
      request.workspaceId,
      {
        kind: 'composition.source.undo',
        worktree: incarnation(request.worktree),
        before: request.before,
        written: request.written,
      },
      EXISTING_LIST,
    ),
  );
}

export interface CompositionRepositoriesUndo extends CompositionRequest {
  repositories: readonly WorkspaceRepoData[];
}
/** Undoes repository adds by their allocated id and path, without restoring an old manifest. */
export async function undoCompositionRepositories(
  request: CompositionRepositoriesUndo,
): Promise<void> {
  admit(request.workspaceId, request.source, COMBINE_SOURCES);
  for (const repo of request.repositories) admitId(repo.id, 'repoId');
  await manifestWrite(() =>
    applyWorkspaceManifestDecision(request.workspaceId, {
      kind: 'composition.repositories.undo',
      repositories: request.repositories,
    }),
  );
}

export interface TemporaryCompositionCreate {
  source: 'temporary_workspace_create';
  workspace: MultiRepoSidebarItem;
}
/**
 * Seeds only absent artifacts. Creating a temporary project never empties an
 * existing list. Admits the list and the manifest it creates under its lock.
 */
export function createTemporaryCompositionRecords(
  ...args: Parameters<typeof createTemporaryCompositionRecordsAdmitted>
): Promise<void> {
  return withStorageAdmission(
    [WORKTREE_LIST_STORAGE, WORKSPACE_MANIFEST_STORAGE],
    () => createTemporaryCompositionRecordsAdmitted(...args),
  );
}

async function createTemporaryCompositionRecordsAdmitted(
  request: TemporaryCompositionCreate,
): Promise<void> {
  const { workspace } = request;
  admit(workspace.id, request.source, ['temporary_workspace_create']);
  const stageTemporaryCompositionRecords = (): Promise<WorktreeData[]> =>
    withW5RepositoryLocks(
      [
        { kind: 'manifest', path: w5RecordReadPaths.manifest(workspace.id) },
        { kind: 'list', path: w5RecordReadPaths.worktrees(workspace.id) },
      ],
      async () =>
        (
          await listWrite(() =>
            applyWorktreeListUpdate(
              workspace.id,
              {
                kind: 'composition.temporary.create',
                manifest: {
                  kind: 'composition.temporary.manifest',
                  repos: workspace.repos,
                  temporarySourceWorkspaceIds:
                    workspace.temporarySourceWorkspaceIds,
                  temporaryRepoIdentityKeys:
                    workspace.temporaryRepoIdentityKeys,
                },
              },
              { requireAuthoritativeRead: true },
            ),
          )
        ).worktrees,
    );
  await commitW5BoundaryStep(
    {
      operation: 'core.workspace.create',
    },
    [
      { kind: 'manifest', path: w5RecordReadPaths.manifest(workspace.id) },
      { kind: 'list', path: w5RecordReadPaths.worktrees(workspace.id) },
    ],
    stageTemporaryCompositionRecords,
  );
}
/** Indexes the temporary project without saving any other project's metadata. */
export async function indexTemporaryCompositionWorkspace(
  request: TemporaryCompositionCreate,
): Promise<void> {
  const { workspace } = request;
  admit(workspace.id, request.source, ['temporary_workspace_create']);
  try {
    await applyWorkspaceIndexDecision({
      kind: 'composition.temporary.index',
      entry: {
        id: workspace.id,
        name: workspace.name,
        type: workspace.type,
        color: workspace.color,
        collapsed: workspace.collapsed,
      },
    });
    await afterW5Commit(notifyPortalStructureChanged);
  } catch (error) {
    if (error instanceof WorkspaceIndexUnreadableError)
      throw refuse('index-unavailable', error.message);
    throw error;
  }
}
export interface CompositionDestinationCleanup {
  source: CompositionRecordSource | 'temporary_workspace_create';
  workspaceId: string;
}
/** The existing failed-create cleanup, with a targeted index removal (F8). */
export async function cleanupCompositionDestination(
  request: CompositionDestinationCleanup,
): Promise<void> {
  admit(request.workspaceId, request.source, [
    ...COMBINE_SOURCES,
    'temporary_workspace_create',
  ]);
  // As before, a refused index cleanup does not prevent the directory cleanup.
  await applyWorkspaceIndexRemoval(request.workspaceId, {
    kind: 'composition.destination.cleanup',
  }).catch(() => undefined);
  const removeDestinationRecords = async (): Promise<void> => {
    await outsideW5CommitScope(() =>
      removeWorkspaceNonW5Children(request.workspaceId),
    );
    await applyWorkspaceRecordsRemoval(request.workspaceId, {
      kind: 'composition.destination.records',
    });
    await afterW5Apply(() =>
      removeWorkspaceDirectoryAfterRecordRemoval(request.workspaceId),
    );
  };
  await withStorageAdmission(
    [WORKSPACE_MANIFEST_STORAGE, WORKTREE_LIST_STORAGE],
    () =>
      commitW5BoundaryStep(
        { operation: 'core.workspace.create' },
        w5CompositionLocks({
          manifests: [request.workspaceId],
          lists: [request.workspaceId],
        }),
        removeDestinationRecords,
      ),
  ).catch(() => undefined);
}

export interface TemporaryCompositionPromotion {
  source: 'temporary_promote';
  workspaceId: string;
  name: string;
  sourceRepoPath: string;
}
/**
 * Promotes only this project's index entry and the composition fields of its
 * manifest. Admits both: the index entry is renamed inside the manifest queue.
 */
export function promoteCompositionWorkspace(
  ...args: Parameters<typeof promoteCompositionWorkspaceAdmitted>
): Promise<void> {
  return withStorageAdmission(
    [WORKSPACE_MANIFEST_STORAGE, WORKSPACE_INDEX_STORAGE],
    () => promoteCompositionWorkspaceAdmitted(...args),
  );
}

async function promoteCompositionWorkspaceAdmitted(
  request: TemporaryCompositionPromotion,
): Promise<void> {
  admit(request.workspaceId, request.source, ['temporary_promote']);
  if (!request.name.trim())
    throw refuse('invalid-request', 'Project name is required');
  const stageCompositionPromotion = (): Promise<void> =>
    withW5RepositoryLocks(
      [
        { kind: 'index', path: w5RecordReadPaths.index() },
        {
          kind: 'manifest',
          path: w5RecordReadPaths.manifest(request.workspaceId),
        },
      ],
      () =>
        manifestWrite(() =>
          applyWorkspaceManifestDecision(request.workspaceId, {
            kind: 'composition.promote',
            sourceRepoPath: request.sourceRepoPath,
            index: {
              kind: 'composition.promote.index',
              workspaceId: request.workspaceId,
              name: request.name.trim(),
            },
          }),
        ),
    );
  await commitW5BoundaryStep(
    {
      operation: 'core.workspace.composition.promote',
    },
    [
      { kind: 'index', path: w5RecordReadPaths.index() },
      {
        kind: 'manifest',
        path: w5RecordReadPaths.manifest(request.workspaceId),
      },
    ],
    stageCompositionPromotion,
  );
  await afterW5Commit(notifyPortalStructureChanged);
}
