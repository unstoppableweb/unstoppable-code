import {
  CoreWorktreeCommandResultSchema,
  type CanopyWorkspaceScope,
  type CoreWorktree,
  type CoreWorktreeCommandResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  CoreWorkspaceLifecycleCall,
  CoreWorkspaceLifecycleHost,
  CoreWorktreeCreated,
} from '@canopy/core-runtime/node/workspace/lifecycle-commands';
import {
  CoreLifecycleRefusedError,
  type CoreLifecycleRefusalShape,
} from '@canopy/core-runtime/node/workspace/lifecycle-wire-errors';
import { w5DaemonReceiptCaller } from '@canopy/core-runtime/node/w5/workspace-metadata/receipt-caller';
import type { W5RevisionEligibility } from '@canopy/core-runtime/node/w5/commit-log/eligibility';
import { isArchivedContainerExpired } from '@canopy/desktop-shared/lib/archive-retention';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  IPC_CHANNELS,
  type ArchivedContainerManifest,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { LiveDelegationsError } from '../agents/delegation/activity';
import {
  createCoreWorkspaceAdapter,
  createCoreWorkspaceReadSnapshots,
  type CoreWorkspaceReadDetail,
} from '../canopy-runtime/core-workspace-adapter';
import { coreWorkspaceResourceKey } from '../canopy-runtime/core-workspace-read-provenance';
import {
  answerWorkspaceLifecycleProjection,
  takeWorkspaceLifecycleProjection,
} from '../canopy-runtime/workspace-lifecycle-dispatch';
import { SplitLockError } from '../services/split-lock-service';
import {
  removeCachedWorkspaceDiffStats,
  removeCachedWorktreeDiffStats,
} from '../services/worktree-diff-stats-cache';
import { restoreArchivedContainer } from './archived-container-restore';
import { listArchivedContainerManifests } from './archived-containers';
import { recordWorktreeCrudTelemetry } from './desktop-telemetry';
import { logMainProcessWarn } from './main-process-logging';
import { assertSharedMultiRepoWorkReady } from './org-shared-multi-repo-readiness';
import { isWritableScope } from './read-only-scope';
import { getWorkspaceIndexRepository } from './sidebar-items';
import { W5RevisionConflictError } from './w5-commit-log-file-store';
import {
  findCompletedDestructiveArchive,
  readDestructiveRecovery,
} from './w5-destructive-recovery';
import { sendToAllWindows } from './window-send';
import { createWorkspace } from './workspace-creation';
import { WorkspaceCreationRefusedError } from './workspace-creation-refusal';
import {
  deleteWorkspace,
  WorkspaceDeletionRefusedError,
  type WorkspaceDeletionRefusal,
} from './workspace-deletion';
import {
  isWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceConfigDetailed,
} from './workspace-persistence';
import {
  archiveWorktree,
  deleteWorktree,
  WorktreeArchiveRefusedError,
  type WorktreeArchiveRefusal,
} from './worktree-archive';
import { createWorktreeFromSelection } from './worktree-creation';
import {
  resolveWorktreeCreationSelection,
  WorktreeCreationRefusedError,
  type WorktreeCreationWorkspaceKind,
} from './worktree-creation-selection';

/*
 * The desktop host behind the registered lifecycle commands: the creates
 * (W7b-3, CAN-5551) and archive, workspace delete and archive restore
 * (W7b-2a, CAN-5550), plus worktree Delete (W7b-2b, CAN-5575).
 * An IPC projection's call runs the host request its
 * projection carries, unchanged (`workspace-lifecycle-dispatch.ts`). Any
 * other admitted caller is a wire call: it is addressed before any effect
 * (and, keyed, before any reservation, RR5), its keyed receipts name its
 * principal (A13), the host derives the owner (always personal: B7), the
 * kind, the paths and the lifecycle, and it runs the same typed Electron
 * boundaries. Nothing runs on the daemon.
 */

const WIRE_SOURCE = 'desktop_canopy_client';

const INVALID: CoreLifecycleRefusalShape = {
  kind: 'invalid_argument',
  retry: 'never',
};
const INVALID_STATE: CoreLifecycleRefusalShape = {
  kind: 'failed_precondition',
  retry: 'never',
  code: 'invalidState',
};
const INVALID_STATE_REFRESH: CoreLifecycleRefusalShape = {
  ...INVALID_STATE,
  retry: 'refresh',
};
const NOT_FOUND: CoreLifecycleRefusalShape = {
  kind: 'not_found',
  retry: 'never',
  code: 'notFound',
};

function refusal(
  reason: string,
  message: string,
  shape: CoreLifecycleRefusalShape,
  hostError?: unknown,
): CoreLifecycleRefusedError {
  return new CoreLifecycleRefusedError(
    reason,
    message,
    { code: 'invalidState', ...shape },
    hostError,
  );
}

const WORKSPACE_REFUSALS: Readonly<
  Record<WorkspaceCreationRefusedError['reason'], CoreLifecycleRefusalShape>
> = {
  'name-required': INVALID,
  'invalid-path': INVALID,
  'invalid-remote': INVALID,
  'missing-folder': INVALID_STATE,
  'not-a-repository': INVALID_STATE,
  'not-a-manifest': INVALID_STATE,
  'not-importable': INVALID_STATE,
  'already-tracked': { kind: 'already_exists', retry: 'never' },
};

const WORKTREE_REFUSALS: Readonly<
  Record<WorktreeCreationRefusedError['reason'], CoreLifecycleRefusalShape>
> = {
  'invalid-branch-name': INVALID,
  'invalid-selection': INVALID,
  'invalid-repository-selection': INVALID,
  'branch-not-found': { kind: 'not_found', retry: 'never' },
  'base-not-found': { kind: 'not_found', retry: 'never' },
  'branch-reserved': { ...INVALID_STATE, retry: 'refresh' },
  'checkout-reserved': { ...INVALID_STATE, retry: 'refresh' },
  'branch-checked-out': { ...INVALID_STATE, retry: 'refresh' },
  'base-task-detached': INVALID_STATE,
  'read-only-scope': INVALID_STATE,
  'unsupported-workspace': INVALID_STATE,
};

const ARCHIVE_REFUSALS: Readonly<
  Record<WorktreeArchiveRefusal, CoreLifecycleRefusalShape>
> = {
  'unsupported-workspace': INVALID_STATE,
  'kind-mismatch': INVALID_STATE,
  'not-found': NOT_FOUND,
  busy: INVALID_STATE_REFRESH,
  'source-unavailable': INVALID_STATE_REFRESH,
};

const DELETION_REFUSALS: Readonly<
  Record<WorkspaceDeletionRefusal, CoreLifecycleRefusalShape>
> = {
  protected: INVALID_STATE,
  'configuration-unavailable': INVALID_STATE_REFRESH,
  'not-single-repo': INVALID_STATE,
  'not-cowork': INVALID_STATE,
  'git-cleanup-pending': INVALID_STATE_REFRESH,
  'archive-recovery-unverified': INVALID_STATE,
  'source-unavailable': INVALID_STATE_REFRESH,
  'archive-in-progress': INVALID_STATE_REFRESH,
};

/** A boundary's own refusal, typed for the wire; others pass. */
function wireRefusal(error: unknown): unknown {
  if (error instanceof WorkspaceCreationRefusedError)
    return new CoreLifecycleRefusedError(
      error.reason,
      error.message,
      WORKSPACE_REFUSALS[error.reason],
      error,
    );
  if (error instanceof WorktreeCreationRefusedError)
    return new CoreLifecycleRefusedError(
      error.reason,
      error.message,
      WORKTREE_REFUSALS[error.reason],
      error,
    );
  if (error instanceof WorktreeArchiveRefusedError)
    return refusal(
      error.reason,
      error.message,
      ARCHIVE_REFUSALS[error.reason],
      error,
    );
  if (error instanceof WorkspaceDeletionRefusedError)
    return refusal(
      error.reason,
      error.message,
      DELETION_REFUSALS[error.reason],
      error,
    );
  // Live delegates, close-blocking work and a running split hold it.
  if (error instanceof LiveDelegationsError || error instanceof SplitLockError)
    return refusal('busy', error.message, INVALID_STATE_REFRESH, error);
  return error;
}

async function asWireCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw wireRefusal(error);
  }
}

/**
 * The worktree's workspace kind, from the index, before the create: the kind
 * is part of the create's fingerprint, so this runs ahead of the receipt
 * lookup. Unknown, duplicated and Cowork workspaces are refused with no key.
 */
async function worktreeWorkspaceKind(
  workspaceId: string,
): Promise<WorktreeCreationWorkspaceKind> {
  const { entries, authority } = await getWorkspaceIndexRepository().read();
  if (authority === 'unreadable')
    throw new CoreLifecycleRefusedError(
      'index-unavailable',
      "Couldn't create this worktree because the project list couldn't be read. Try again.",
      { ...INVALID_STATE, retry: 'refresh' },
    );
  const rows = entries.filter((entry) => entry.id === workspaceId);
  const [row, ...more] = rows;
  if (more.length > 0)
    throw new CoreLifecycleRefusedError(
      'duplicate-workspace',
      `More than one project is stored as ${workspaceId}. Repair the project list and try again.`,
      INVALID,
    );
  if (!row)
    throw new CoreLifecycleRefusedError(
      'not-found',
      `Project ${workspaceId} not found.`,
      { kind: 'not_found', retry: 'never', code: 'notFound' },
    );
  if (row.type === 'cowork')
    throw new CoreLifecycleRefusedError(
      'cowork-project',
      'A Cowork project has no worktrees.',
      INVALID_STATE,
    );
  return row.type;
}

/**
 * An organization's shared multi-repo project admits no new work until its
 * setup is ready; the boundary's own check throws untyped errors, so the wire
 * runs it first (the boundary repeats it, also before the receipt lookup).
 */
async function admitSharedProject(workspaceId: string): Promise<void> {
  try {
    await assertSharedMultiRepoWorkReady(workspaceId);
  } catch (error) {
    throw new CoreLifecycleRefusedError(
      'shared-project-not-ready',
      "This shared project isn't ready for new worktrees yet. Try again once its setup finishes.",
      { ...INVALID_STATE, retry: 'refresh' },
      error,
    );
  }
}

/**
 * Main's own canonical writes wake no file watcher and no IPC answer reaches
 * the renderer, so a wire lifecycle change asks every window to reload projects.
 * Best-effort: the change has committed, so a failed send never changes its
 * answer.
 */
function announceWorkspaceChange(workspaceId: string): void {
  try {
    sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, { workspaceId });
  } catch (error) {
    logMainProcessWarn('Workspace lifecycle renderer refresh failed', error);
  }
}

/** Indexed code workspaces, once each, or a refusal the read would make. */
async function indexedWorkspaceIds(): Promise<string[]> {
  const { entries, authority } = await getWorkspaceIndexRepository().read();
  if (authority === 'unreadable')
    throw refusal(
      'index-unavailable',
      "The project list couldn't be read. Try again.",
      INVALID_STATE_REFRESH,
    );
  return [
    ...new Set(
      entries
        .filter((entry) => entry.type !== 'cowork')
        .map((entry) => entry.id),
    ),
  ];
}

/** RR5: the workspace is in the index exactly once. */
async function admitWorkspace(workspaceId: string): Promise<void> {
  const { entries, authority } = await getWorkspaceIndexRepository().read();
  if (authority === 'unreadable')
    throw refusal(
      'index-unavailable',
      "The project list couldn't be read. Try again.",
      INVALID_STATE_REFRESH,
    );
  const rows = entries.filter((entry) => entry.id === workspaceId).length;
  if (rows > 1)
    throw refusal(
      'duplicate-workspace',
      `More than one project is stored as ${workspaceId}. Repair the project list and try again.`,
      { kind: 'invalid_argument', retry: 'never' },
    );
  if (rows === 0)
    throw refusal('not-found', `Project ${workspaceId} not found.`, NOT_FOUND);
}

interface ReadWorktree {
  readonly projection: CoreWorktree;
  readonly eligibility: W5RevisionEligibility;
}

const UNVERIFIED: W5RevisionEligibility = {
  status: 'unverified',
  reason: 'evidence-unavailable',
};

/**
 * The worktree as `core.worktree.get` reads it for this scope, with its
 * revision's eligibility: the same resolution, ambiguity refusal and
 * withheld revisions (A4). Undefined when the read finds no such row.
 */
async function readWorktree(
  worktreeId: string,
  scope: CanopyWorkspaceScope | undefined,
): Promise<ReadWorktree | undefined> {
  let detail: CoreWorkspaceReadDetail | undefined;
  const snapshots = createCoreWorkspaceReadSnapshots();
  const adapter = createCoreWorkspaceAdapter(
    undefined,
    {
      captureSidebar: () => {},
      captureConfig: () => {},
      captureWorktrees: () => {},
      captureWorktree: (_row: WorktreeData, captured) => {
        detail = captured;
      },
    },
    snapshots,
  );
  try {
    const projection = await adapter['core.worktree.get'](
      { worktreeId, ...(scope !== undefined && { scope }) },
      undefined,
    );
    const key = coreWorkspaceResourceKey({
      kind: 'worktree',
      workspaceId: projection.workspaceId,
      worktreeId,
    });
    const eligibility =
      detail?.provenance?.resources.find(
        ({ resource }) => coreWorkspaceResourceKey(resource) === key,
      )?.eligibility ?? UNVERIFIED;
    return { projection, eligibility };
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.payload.kind === 'not_found'
    )
      return undefined;
    throw error;
  } finally {
    snapshots.close();
  }
}

/** A revision the read withholds for a reason other than having none. */
function isWithheld(eligibility: W5RevisionEligibility): boolean {
  return (
    eligibility.status !== 'eligible' && eligibility.reason !== 'no-revision'
  );
}

function revisionUnverified(
  eligibility: W5RevisionEligibility,
  message: string,
  hostError?: unknown,
): CoreLifecycleRefusedError {
  return refusal(
    'revision-unverified',
    message,
    eligibility.status === 'unverified' && eligibility.reason === 'pending'
      ? INVALID_STATE_REFRESH
      : INVALID_STATE,
    hostError,
  );
}

/**
 * DP-1: a worktree whose read has no revision is archived with `0`; any
 * other withheld revision is refused, without naming the stored one.
 */
function admitRevision(
  eligibility: W5RevisionEligibility,
  message = "This worktree's revision can't be verified yet, so it wasn't archived.",
): void {
  if (isWithheld(eligibility)) throw revisionUnverified(eligibility, message);
}

/**
 * The eligibility the matching read reports for a workspace's or its list's
 * revision: `core.workspace.get`, or `core.worktree.list` scoped to it.
 */
async function readRevisionEligibility(
  resource:
    | { kind: 'workspace'; workspaceId: string }
    | { kind: 'worktrees'; workspaceId: string },
): Promise<W5RevisionEligibility> {
  let detail: CoreWorkspaceReadDetail | undefined;
  const captured = (_result: unknown, read?: CoreWorkspaceReadDetail): void => {
    detail = read;
  };
  const snapshots = createCoreWorkspaceReadSnapshots();
  const adapter = createCoreWorkspaceAdapter(
    undefined,
    {
      captureSidebar: () => {},
      captureConfig: captured,
      captureWorktrees: captured,
      captureWorktree: () => {},
    },
    snapshots,
  );
  try {
    const { workspaceId } = resource;
    if (resource.kind === 'workspace')
      await adapter['core.workspace.get']({ workspaceId }, undefined);
    else
      await adapter['core.worktree.list'](
        { scope: { workspaceId } },
        undefined,
      );
  } catch {
    return UNVERIFIED;
  } finally {
    snapshots.close();
  }
  const key = coreWorkspaceResourceKey(resource);
  return (
    detail?.provenance?.resources.find(
      (entry) => coreWorkspaceResourceKey(entry.resource) === key,
    )?.eligibility ?? UNVERIFIED
  );
}

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof W5RevisionConflictError ||
    (error instanceof W5CommitRefusedError &&
      error.reason === 'revision-conflict')
  );
}

/**
 * DP-1's refusal for a keyed command's revision: a conflict against a
 * revision the read withholds is one no refresh resolves, so it is refused
 * `revision-unverified` instead. A conflict is a pre-effect refusal, so the
 * key is already released.
 */
async function withVerifiableRevision<T>(
  resource: Parameters<typeof readRevisionEligibility>[0],
  message: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isRevisionConflict(error)) throw error;
    const eligibility = await readRevisionEligibility(resource);
    if (isWithheld(eligibility))
      throw revisionUnverified(eligibility, message, error);
    throw error;
  }
}

function resultUnavailable(): CoreLifecycleRefusedError {
  return refusal(
    'result-unavailable',
    "This worktree's details can't be returned here, so nothing was changed.",
    { kind: 'capability_unavailable', retry: 'never' },
  );
}

/** The command result of an archived worktree. */
function archivedResult(
  worktree: Omit<CoreWorktree, 'state'>,
): CoreWorktreeCommandResult {
  const { revision: _revision, ...fields } = worktree;
  void _revision;
  const result = CoreWorktreeCommandResultSchema.safeParse({
    ...fields,
    state: 'archived',
  });
  if (!result.success) throw resultUnavailable();
  return result.data;
}

/** The read projection of a retained container's worktree. */
function retainedWorktree(
  manifest: ArchivedContainerManifest,
  worktree: WorktreeData,
): Omit<CoreWorktree, 'state'> {
  return {
    worktreeId: worktree.id,
    workspaceId: manifest.projectId,
    name: worktree.label || worktree.branchName,
    baseBranch: worktree.trackedBaseBranch ?? null,
    branch: worktree.branchName,
    createdAt: worktree.createdAt,
  };
}

/**
 * The workspaces a repeat may name, admitted as `core.worktree.get` admits
 * its scope (A4): a scope the read refuses as not found names none, so its
 * refusal is never turned into a repeat.
 */
async function repeatWorkspaceIds(
  worktreeId: string,
  scope: CanopyWorkspaceScope | undefined,
): Promise<string[]> {
  if (scope?.worktreeId !== undefined && scope.worktreeId !== worktreeId)
    return [];
  const indexed = await indexedWorkspaceIds();
  const ids =
    scope?.workspaceId !== undefined
      ? indexed.filter((id) => id === scope.workspaceId)
      : indexed;
  const organizationId = scope?.organizationId;
  if (organizationId === undefined) return ids;
  const owned: string[] = [];
  for (const id of ids) {
    const { config } = await readWorkspaceConfigDetailed(id);
    if (config.owner?.organizationId === organizationId) owned.push(id);
  }
  return owned;
}

/** The newest retained container of this incarnation of the worktree. */
async function findRetainedWorktree(
  workspaceId: string,
  worktreeId: string,
  expectedCreatedAt: string | undefined,
): Promise<Omit<CoreWorktree, 'state'> | undefined> {
  let manifests: ArchivedContainerManifest[];
  try {
    manifests = await listArchivedContainerManifests(workspaceId);
  } catch {
    return undefined;
  }
  // Newest first: the latest archive of this incarnation.
  const manifest = manifests.find(
    (entry) =>
      entry.kind === 'worktree' &&
      entry.originalWorktree?.id === worktreeId &&
      (expectedCreatedAt === undefined ||
        entry.originalWorktree.createdAt === expectedCreatedAt),
  );
  return manifest?.originalWorktree
    ? retainedWorktree(manifest, manifest.originalWorktree)
    : undefined;
}

async function hasUnfinishedArchive(
  workspaceId: string,
  worktreeId: string,
  expectedCreatedAt: string | undefined,
): Promise<boolean> {
  const record = await readDestructiveRecovery(workspaceId, worktreeId);
  return (
    record !== null &&
    record.state !== 'completed' &&
    (expectedCreatedAt === undefined ||
      record.createdAt === undefined ||
      record.createdAt === expectedCreatedAt)
  );
}

async function wasRemoved(
  workspaceId: string,
  worktreeId: string,
  expectedCreatedAt: string | undefined,
): Promise<boolean> {
  return (
    isWorkspaceWorktreeRecentlyRemoved(
      workspaceId,
      worktreeId,
      expectedCreatedAt,
    ) ||
    (await findCompletedDestructiveArchive(
      workspaceId,
      worktreeId,
      expectedCreatedAt,
    ).catch(() => null)) !== null
  );
}

/**
 * A workspace whose journal or retained container a repeat would act on or
 * answer from. A removal alone is only ever refused, so it names none.
 */
interface RepeatTarget {
  readonly workspaceId: string;
  readonly unfinished: boolean;
  readonly retained: Omit<CoreWorktree, 'state'> | undefined;
}

async function findRepeatTarget(
  workspaceId: string,
  worktreeId: string,
  expectedCreatedAt: string | undefined,
): Promise<RepeatTarget | undefined> {
  const unfinished = await hasUnfinishedArchive(
    workspaceId,
    worktreeId,
    expectedCreatedAt,
  );
  const retained = await findRetainedWorktree(
    workspaceId,
    worktreeId,
    expectedCreatedAt,
  );
  return unfinished || retained
    ? { workspaceId, unfinished, retained }
    : undefined;
}

/**
 * An archive can publish its container and remove the row before a later
 * cleanup step fails. The boundary owns that journal: it finishes the cleanup
 * or refuses `recovery-required`, as an in-process retry does. Another
 * incarnation's journal is left to its own repeat.
 */
async function resumeUnfinishedArchive(
  workspaceId: string,
  worktreeId: string,
  expectedCreatedAt: string | undefined,
  archiveTrigger: 'agent' | 'manual',
): Promise<void> {
  if (!isWritableScope(workspaceId))
    throw refusal(
      'read-only-scope',
      'This project is read-only here.',
      INVALID_STATE,
    );
  await asWireCall(() =>
    archiveWorktree({
      workspaceId,
      worktreeId,
      source: WIRE_SOURCE,
      archiveTrigger,
      ...(expectedCreatedAt !== undefined && { expectedCreatedAt }),
      lockAfterArchive: true,
    }),
  );
  removeCachedWorktreeDiffStats(workspaceId, worktreeId);
}

/**
 * B5 as amended by A6(a) (DP-2): a repeat answers the retained container's
 * worktree once its archive's cleanup has finished. A worktree removed
 * without retention has no name or branch left to project and is refused;
 * one never archived is not found. RR5: the one target across journals and
 * retained containers is resolved, and an ambiguous one refused, before any
 * cleanup resumes.
 */
async function repeatArchive(
  worktreeId: string,
  workspaceIds: readonly string[],
  expectedCreatedAt: string | undefined,
  archiveTrigger: 'agent' | 'manual',
): Promise<CoreWorktreeCommandResult> {
  const targets: RepeatTarget[] = [];
  for (const workspaceId of workspaceIds) {
    const target = await findRepeatTarget(
      workspaceId,
      worktreeId,
      expectedCreatedAt,
    );
    if (target) targets.push(target);
  }
  if (targets.length > 1)
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'Workspace scope required for ambiguous worktree ID.',
      retry: { kind: 'never' },
    });
  const [target] = targets;
  if (target?.unfinished) {
    await resumeUnfinishedArchive(
      target.workspaceId,
      worktreeId,
      expectedCreatedAt,
      archiveTrigger,
    );
    const resumed = await findRetainedWorktree(
      target.workspaceId,
      worktreeId,
      expectedCreatedAt,
    );
    if (resumed) {
      const result = archivedResult(resumed);
      announceWorkspaceChange(target.workspaceId);
      return result;
    }
  } else if (target?.retained) return archivedResult(target.retained);
  for (const workspaceId of workspaceIds)
    if (await wasRemoved(workspaceId, worktreeId, expectedCreatedAt))
      throw refusal(
        'removed-without-retention',
        // Also after its archive was restored or discarded: none is kept.
        'This worktree was removed and no archive of it is kept.',
        NOT_FOUND,
      );
  throw new CanopyOperationError({
    kind: 'not_found',
    code: 'core.worktree.notFound',
    message: 'Worktree not found.',
    retry: { kind: 'never' },
  });
}

/** Unscoped deletes include retained and removed incarnations in addressing. */
async function resolveDeletedWorktreeWorkspace(
  worktreeId: string,
  scope: CanopyWorkspaceScope | undefined,
  expectedCreatedAt: string | undefined,
): Promise<string> {
  // The read and repeat search run only for a new key, after receipt lookup.
  if (scope?.workspaceId !== undefined) return scope.workspaceId;
  const read = await readWorktree(worktreeId, scope);
  if (read) return read.projection.workspaceId;
  const matches: string[] = [];
  for (const workspaceId of await repeatWorkspaceIds(worktreeId, scope))
    if (
      (await findRepeatTarget(workspaceId, worktreeId, expectedCreatedAt)) ||
      (await wasRemoved(workspaceId, worktreeId, expectedCreatedAt))
    )
      matches.push(workspaceId);
  if (matches.length > 1)
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'Workspace scope required for ambiguous worktree ID.',
      retry: { kind: 'never' },
    });
  const [workspaceId] = matches;
  if (workspaceId === undefined)
    throw refusal('not-found', 'Worktree not found.', NOT_FOUND);
  return workspaceId;
}

/** New-key admission only: repeats never resume an unkeyed archive here. */
async function admitWorktreeDelete(
  workspaceId: string,
  input: Parameters<CoreWorkspaceLifecycleHost['deleteWorktree']>[0],
): Promise<string | undefined> {
  const read = await readWorktree(input.worktreeId, {
    ...input.scope,
    workspaceId,
  });
  if (!isWritableScope(workspaceId))
    throw refusal(
      'read-only-scope',
      'This project is read-only here.',
      INVALID_STATE,
    );
  if (
    read &&
    (input.expectedCreatedAt === undefined ||
      input.expectedCreatedAt === read.projection.createdAt)
  ) {
    admitRevision(
      read.eligibility,
      "This worktree's revision can't be verified yet, so it wasn't deleted.",
    );
    // Pin the incarnation across reservation and lifecycle admission, even
    // when the wire caller supplied only its logical ID.
    return read.projection.createdAt;
  }
  // Reuse the read's scope admission for missing rows too (A4).
  if (
    !(await repeatWorkspaceIds(input.worktreeId, input.scope)).includes(
      workspaceId,
    )
  )
    throw refusal('not-found', 'Worktree not found.', NOT_FOUND);
  const repeat = await findRepeatTarget(
    workspaceId,
    input.worktreeId,
    input.expectedCreatedAt,
  );
  if (repeat) {
    if (input.expectedCreatedAt !== undefined) return input.expectedCreatedAt;
    if (!repeat.retained) return undefined;
    const { createdAt } = repeat.retained;
    if (typeof createdAt !== 'string') throw resultUnavailable();
    return createdAt;
  }
  if (await wasRemoved(workspaceId, input.worktreeId, input.expectedCreatedAt))
    throw refusal(
      'removed-without-retention',
      'This worktree was removed and no archive of it is kept.',
      NOT_FOUND,
    );
  throw refusal('not-found', 'Worktree not found.', NOT_FOUND);
}

async function admitArchive(
  workspaceId: string,
  archiveId: string,
): Promise<void> {
  await admitWorkspace(workspaceId);
  const manifest = (await listArchivedContainerManifests(workspaceId)).find(
    (entry) => entry.id === archiveId,
  );
  if (!manifest)
    throw refusal('archive-not-found', 'Archive not found.', NOT_FOUND);
  if (isArchivedContainerExpired(manifest, Date.now()))
    throw refusal('expired', 'This archive has expired.', {
      ...INVALID_STATE,
      code: 'expired',
    });
  // A work entry restores into the Cowork registry, which no wire read serves.
  if (manifest.kind !== 'worktree')
    throw refusal(
      'work-entry-archive',
      "A chat project's archive can't be restored here yet.",
      { kind: 'capability_unavailable', retry: 'never' },
    );
}

function receiptCaller(
  call: CoreWorkspaceLifecycleCall,
  source: string,
): string {
  return w5DaemonReceiptCaller(call.caller.principalId, source);
}

export const desktopWorkspaceLifecycleHost: CoreWorkspaceLifecycleHost = {
  async createWorkspace(request, call) {
    const projection = takeWorkspaceLifecycleProjection(
      'core.workspace.create',
    );
    if (projection) return answerWorkspaceLifecycleProjection(projection);
    if (request.kind === 'unserved') throw request.refusal;
    try {
      const { workspace } = await createWorkspace({
        source: 'desktop_canopy_client',
        variant:
          request.workspaceKind === 'single_repo'
            ? { kind: 'new-single-repo', name: request.name }
            : { kind: 'new-multi-repo', name: request.name },
        idempotencyKey: call.idempotencyKey,
        receiptCaller: receiptCaller(call, 'workspace-create'),
      });
      announceWorkspaceChange(workspace.id);
      return {
        workspaceId: workspace.id,
        name: workspace.name,
        kind:
          workspace.type === 'single-repo'
            ? 'single_repo'
            : workspace.type === 'multi-repo'
              ? 'multi_repo'
              : 'cowork',
      };
    } catch (error) {
      throw wireRefusal(error);
    }
  },
  async importWorkspace(request) {
    const projection = takeWorkspaceLifecycleProjection(
      'core.workspace.import',
    );
    if (projection) return answerWorkspaceLifecycleProjection(projection);
    throw request.refusal;
  },
  async createWorktree(request, call): Promise<CoreWorktreeCreated> {
    const projection = takeWorkspaceLifecycleProjection('core.worktree.create');
    if (projection) return answerWorkspaceLifecycleProjection(projection);
    if (request.kind === 'unserved') throw request.refusal;
    const { workspaceId } = request;
    try {
      const workspaceKind = await worktreeWorkspaceKind(workspaceId);
      if (workspaceKind === 'multi-repo') await admitSharedProject(workspaceId);
      let replayed = false;
      const outcome = await createWorktreeFromSelection({
        workspaceId,
        workspaceKind,
        ...resolveWorktreeCreationSelection(
          {
            branchName: request.branch,
            existingBranch: request.existingBranch,
            suggestedBranch: request.suggestedBranch,
            baseBranch: request.baseBranch,
            baseWorktreeId: request.baseWorktreeId,
          },
          workspaceKind,
        ),
        ...(request.includedRepositoryIds !== undefined && {
          includedRepoIds: [...request.includedRepositoryIds],
        }),
        ...(request.sidebarItemGroupId !== undefined && {
          sidebarItemGroupId: request.sidebarItemGroupId,
        }),
        idempotencyKey: call.idempotencyKey,
        receiptCaller: receiptCaller(call, 'worktree-create'),
        onKeyedReplay: () => {
          replayed = true;
        },
        // Git setup finishes before the answer; no setup script runs on the
        // wire (as no teardown does, D-4(a)), and a root that needs repair
        // is answered, never repaired.
        deferGitSetup: false,
        surfaceNeedsRepairInResponse: true,
        startPostCreateSetup: false,
      });
      if (!replayed)
        recordWorktreeCrudTelemetry({
          action: 'create',
          workspaceId,
          source: 'desktop_canopy_client',
        });
      announceWorkspaceChange(workspaceId);
      return outcome.status === 'created'
        ? {
            workspaceId,
            worktreeId: outcome.record.worktreeId,
            branchName: outcome.record.branchName,
            setupPhase: outcome.record.setupPhase,
            status: 'completed',
          }
        : {
            workspaceId,
            worktreeId: outcome.worktreeId,
            branchName: outcome.branchName,
            setupPhase: 'git-pending',
            status: 'failed',
          };
    } catch (error) {
      throw wireRefusal(error);
    }
  },
  async archiveWorktree(input, call) {
    const projected = takeWorkspaceLifecycleProjection('core.worktree.archive');
    if (projected) return answerWorkspaceLifecycleProjection(projected);
    const read = await readWorktree(input.worktreeId, input.scope);
    if (!read)
      return repeatArchive(
        input.worktreeId,
        await repeatWorkspaceIds(input.worktreeId, input.scope),
        input.expectedCreatedAt,
        call.caller.interfaceKind === 'mcp' ? 'agent' : 'manual',
      );
    const { projection } = read;
    const { workspaceId } = projection;
    // The caller's incarnation was archived; a newer one is left alone.
    if (
      input.expectedCreatedAt !== undefined &&
      projection.createdAt !== input.expectedCreatedAt
    )
      return repeatArchive(
        input.worktreeId,
        [workspaceId],
        input.expectedCreatedAt,
        call.caller.interfaceKind === 'mcp' ? 'agent' : 'manual',
      );
    if (!isWritableScope(workspaceId))
      throw refusal(
        'read-only-scope',
        'This project is read-only here.',
        INVALID_STATE,
      );
    admitRevision(read.eligibility);
    const result = archivedResult(projection);
    // D-4(a): no teardown; an archive keeps a locked container (A5).
    await asWireCall(() =>
      archiveWorktree({
        workspaceId,
        worktreeId: input.worktreeId,
        source: WIRE_SOURCE,
        archiveTrigger:
          call.caller.interfaceKind === 'mcp' ? 'agent' : 'manual',
        expectedRevision: input.expectedRevision,
        expectedCreatedAt: projection.createdAt,
        lockAfterArchive: true,
      }),
    );
    removeCachedWorktreeDiffStats(workspaceId, input.worktreeId);
    announceWorkspaceChange(workspaceId);
    return result;
  },
  async deleteWorktree(input, call) {
    const projected = takeWorkspaceLifecycleProjection('core.worktree.delete');
    if (projected) return answerWorkspaceLifecycleProjection(projected);
    const { expectedRevision, ...parameters } = input;
    let changedWorkspaceId: string | undefined;
    await asWireCall(() =>
      deleteWorktree({
        caller: receiptCaller(call, WIRE_SOURCE),
        archiveTrigger:
          call.caller.interfaceKind === 'mcp' ? 'agent' : 'manual',
        idempotencyKey: call.idempotencyKey,
        parameters,
        resolveRequest: async () => {
          const workspaceId = await resolveDeletedWorktreeWorkspace(
            input.worktreeId,
            input.scope,
            input.expectedCreatedAt,
          );
          const expectedCreatedAt = await admitWorktreeDelete(
            workspaceId,
            input,
          );
          changedWorkspaceId = workspaceId;
          return {
            workspaceId,
            worktreeId: input.worktreeId,
            source: WIRE_SOURCE,
            archiveTrigger:
              call.caller.interfaceKind === 'mcp' ? 'agent' : 'manual',
            expectedRevision,
            ...(expectedCreatedAt !== undefined && {
              expectedCreatedAt,
            }),
            retainAsArchivedContainer: true,
            deleteWithoutRetentionIfMissing: true,
          };
        },
      }),
    );
    if (changedWorkspaceId !== undefined) {
      removeCachedWorktreeDiffStats(changedWorkspaceId, input.worktreeId);
      announceWorkspaceChange(changedWorkspaceId);
    }
  },
  async deleteWorkspace(input, call) {
    const projected = takeWorkspaceLifecycleProjection('core.workspace.delete');
    if (projected) return answerWorkspaceLifecycleProjection(projected);
    await asWireCall(() =>
      withVerifiableRevision(
        { kind: 'workspace', workspaceId: input.workspaceId },
        "This project's revision can't be verified yet.",
        () =>
          deleteWorkspace(
            {
              workspaceId: input.workspaceId,
              source: WIRE_SOURCE,
              expectedRevision: input.expectedRevision,
              idempotencyKey: call.idempotencyKey,
            },
            {
              caller: receiptCaller(call, WIRE_SOURCE),
              admit: () => admitWorkspace(input.workspaceId),
            },
          ),
      ),
    );
    removeCachedWorkspaceDiffStats(input.workspaceId);
    announceWorkspaceChange(input.workspaceId);
  },
  async restoreArchive(input, call) {
    const projected = takeWorkspaceLifecycleProjection(
      'core.archive.container.restore',
    );
    if (projected) return answerWorkspaceLifecycleProjection(projected);
    const response = await asWireCall(() =>
      withVerifiableRevision(
        { kind: 'worktrees', workspaceId: input.workspaceId },
        "This project's worktree list revision can't be verified yet.",
        () =>
          restoreArchivedContainer(
            input.workspaceId,
            input.archiveId,
            {
              expectedRevision: input.expectedRevision,
              idempotencyKey: call.idempotencyKey,
            },
            {
              caller: receiptCaller(call, 'archive-container-restore'),
              admit: () => admitArchive(input.workspaceId, input.archiveId),
            },
          ),
      ),
    );
    announceWorkspaceChange(input.workspaceId);
    return {
      restoredScope: {
        workspaceId: input.workspaceId,
        worktreeId:
          response.kind === 'worktree'
            ? response.restoredWorktreeId
            : response.restoredEntryId,
      },
    };
  },
};
