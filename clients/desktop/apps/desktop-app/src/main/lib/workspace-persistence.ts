import { withW5RepositoryLock } from './w5-repository-locks';
import { withW5Commit, type W5CommitOptions } from './w5-commit-log-file-store';
import { deferUntilW5ReadViewCloses } from './w5-read-view';
import { afterW5Apply, afterW5Commit, onW5Abort } from './w5-commit-scope';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  publishSidebarItemGroupsChanged,
  type SidebarGroupRegistryReconciliation,
} from './sidebar-item-groups';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { markForeignPipelineResultsSeen } from '../services/foreign-activity-sources';
import {
  normalizeWorkspaceOwner,
  normalizeWorkspaceDetachedOwner,
  normalizeWorkspaceOwnershipTransfer,
} from '@canopy/desktop-shared/lib/workspace-owner';
import type {
  ChatHookAction,
  ChatTabPluginSelections,
  CommandHookAction,
  CoworkWorkspaceSettings,
  HookAction,
  HookOverrides,
  PipelineHookAction,
  PluginSelectionTombstones,
  StandaloneProjectPreset,
  WorkspaceConfigFile,
  WorkspaceOwnerBinding,
  WorkspaceOwnershipTransfer,
  WorkspaceDetachedOwner,
  WorkspaceRepoData,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { isThinkingLevel } from '@canopy/desktop-shared/types';
import { normalizeHookInputMap } from '@canopy/desktop-shared/hooks';
import { normalizeWorkspacePlanDetection } from '@canopy/protocol/plan-detection';
import {
  CloudProjectBindingSchema,
  type CloudProjectBinding,
} from '@canopy/protocol/memory-sync';
import type { WorkspaceCloudBindingCompare } from './worktree-record-decisions';
import {
  isChatTabPluginSelections,
  normalizePluginSelections,
} from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  normalizePluginSelectionTombstones,
  pluginSelectionsEqual,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import { normalizeScriptInputMap } from '@canopy/desktop-shared/scripts';
import { validateWorkspaceTemplateStarterPrompts } from '@canopy/protocol/workspace-templates';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import { CANOPY_IN_PROCESS_WORKER_TARGET_ID } from '@canopy/protocol/canopy-core';
import {
  WORKSPACE_MANIFEST_KEYS,
  WORKSPACE_MANIFEST_REPOSITORY_KEYS,
  type WorkspaceManifestKey,
  type WorkspaceManifestRepositoryKey,
} from '@canopy/core-runtime/node/w5/workspace-metadata/manifest-keys';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import {
  getWorkspaceConfigPath,
  getWorkspaceWorktreesFilePath,
  getWorktreeDiscoveryFilePath,
} from './paths';
import { normalizeLegacyScriptFields } from './script-config';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import { publishWorktreeListWrite } from './worktree-lifecycle-signals';
import { desktopW5FileStore } from './w5-commit-log-file-store';
import {
  W5AuthorityUnreachableError,
  w5NamedUnreadable,
  type PersistedFileAuthority,
  type W5NamedUnreadableError,
} from './w5-file-store';
import {
  diffWorktreePipelineResultsSeen,
  markWorktreePipelineResultsSeen,
} from './worktree-pipeline-results-seen';
import {
  createWorktreeListRepository,
  parseWorktreeList,
  WorktreeRegistryUnreadableError,
  type WorktreeListRead,
} from './worktree-list-repository';
import {
  createWorkspaceManifestRepository,
  WorkspaceConfigUnreadableError,
  type WorkspaceManifestRead,
  type WorkspaceManifestRepository,
} from './workspace-manifest-repository';
import {
  WORKSPACE_MANIFEST_STORAGE,
  WORKTREE_LIST_STORAGE,
  withStorageAdmission,
} from './w5-storage';
import {
  ACCOUNT_MCP_REF_LOADER_WAIT,
  normalizeAccountMcpSelections,
  normalizeAccountMcpTombstones,
} from '../mcp/account-catalog';
import {
  projectPluginDefaultsWritten,
  projectPluginLayerChanged,
  readThroughProjectPluginDefaults,
  type ProjectPluginDefaults,
} from '../plugins/project-plugin-defaults-cache';
import { logMainProcessWarn } from './main-process-logging';
import { runW5PreEffectUnit } from './w5-pre-effect-retry';
import { addOrganizationSourceHookBindings } from './source-hook-context-bindings';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';
import { notifyWorkspaceMemoryBindingChanged } from './workspace-memory-binding-events';
import {
  inMcpRefRewritePhase,
  recordMcpRefRewriteFailure,
} from '../mcp/server-ref-rewrite-outcome';

export { WorkspaceConfigUnreadableError } from './workspace-manifest-repository';
export { WorktreeRegistryUnreadableError } from './worktree-list-repository';
export type { PersistedFileAuthority } from './w5-file-store';

type RawWorkspaceRepoData = Partial<
  Record<WorkspaceManifestRepositoryKey, unknown>
>;

export interface WorktreeRegistryWriteOptions {
  /** Decide this list replacement under the existing lock, before post-write effects. */
  w5Commit?: W5CommitOptions;
  groupMutation?: boolean;
  requireAuthoritativeRead?: boolean;
  /** Refuse a mutation that is not allowed to create the registry. */
  requireExistingRead?: boolean;
  /** Refuse to initialize a list for an operation on an existing workspace. */
  requireExistingList?: boolean;
  /** Exact removed incarnations a composition rollback may restore. */
  restoreWorktrees?: readonly Pick<WorktreeData, 'id' | 'createdAt'>[];
  /** Allows a locked read decision without replacing the list. */
  shouldWrite?: () => boolean;
  /**
   * Publish a removal's recently-removed markers only after the write, so a
   * failed removal stays retryable with the row still visible.
   */
  markRemovedAfterWrite?: boolean;
  sidebarItemGroupId?: string;
  newItemId?: string;
  afterWrite?: () => Promise<void>;
}

type WorktreeRegistryReconciler = (
  workspaceId: string,
  current: WorktreeData[],
  next: WorktreeData[],
  options?: WorktreeRegistryWriteOptions,
  /**
   * Ids of rows on disk this version cannot read. The write keeps them, so
   * their sidebar-group membership must be kept too (CAN-3803).
   */
  retainedItemIds?: readonly string[],
) => Promise<SidebarGroupRegistryReconciliation<WorktreeData>>;

let worktreeRegistryReconciler: WorktreeRegistryReconciler | undefined;

/** Host initialization installs membership policy without moving this writer. */
export function setWorktreeRegistryReconciler(
  reconciler: WorktreeRegistryReconciler,
): void {
  worktreeRegistryReconciler = reconciler;
}

type RawWorkspaceConfigFile = Partial<Record<WorkspaceManifestKey, unknown>>;

const rawWorkspaceManifestRepository = createWorkspaceManifestRepository({
  store: desktopW5FileStore,
  filePath: (workspaceId) => getWorkspaceConfigPath(workspaceId),
  storage: WORKSPACE_MANIFEST_STORAGE,
  // Every manifest field this version reads; any other field is kept.
  knownFields: new Set(WORKSPACE_MANIFEST_KEYS),
  knownRepoFields: new Set(WORKSPACE_MANIFEST_REPOSITORY_KEYS),
});

const workspaceManifestRepository: WorkspaceManifestRepository = {
  ...rawWorkspaceManifestRepository,
  serialize: (workspaceId, work) =>
    withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
      rawWorkspaceManifestRepository.serialize(workspaceId, work),
    ),
  replace: (workspaceId, config, previous) =>
    withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
      rawWorkspaceManifestRepository.replace(workspaceId, config, previous),
    ),
  replaceDocument: (workspaceId, document, previous) =>
    withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
      rawWorkspaceManifestRepository.replaceDocument(
        workspaceId,
        document,
        previous,
      ),
    ),
};

/** The desktop's `workspace.json` repository (CAN-3800). */
export function getWorkspaceManifestRepository(): WorkspaceManifestRepository {
  return workspaceManifestRepository;
}

/** Every worktree row field this version reads; any other field is kept. */
const WORKTREE_ROW_FIELDS: Record<keyof WorktreeData, true> = {
  replica: true,
  id: true,
  branchName: true,
  createdAt: true,
  restoredFromFilesOnlyArchiveId: true,
  pinned: true,
  lastTouchedAt: true,
  pendingArchiveBranchDeletion: true,
  pendingArchiveBranchDeletions: true,
  discovery: true,
  branchPromptSent: true,
  status: true,
  label: true,
  labelSource: true,
  labelProvisional: true,
  seenPipelineExecutionIds: true,
  trackedBaseBranch: true,
  trackedRepoBaseBranches: true,
  lastKnownPrStatus: true,
  pausedHookKeys: true,
  branchGroupingOverride: true,
  branchGroupingParentWorktreeId: true,
  chatBadges: true,
  healthIssue: true,
  hidden: true,
  setupPhase: true,
  creation: true,
  includedRepoIds: true,
  splitRecoveryRequired: true,
  compatibilitySymlinks: true,
  adhocTransitionSource: true,
};

const worktreeListRepository = createWorktreeListRepository({
  store: desktopW5FileStore,
  filePath: (workspaceId) => getWorkspaceWorktreesFilePath(workspaceId),
  discoveryFilePath: getWorktreeDiscoveryFilePath,
  storage: WORKTREE_LIST_STORAGE,
  knownRowFields: new Set(Object.keys(WORKTREE_ROW_FIELDS)),
  async localReplicaContext(workspaceId) {
    const read = await readWorkspaceConfigDetailed(workspaceId);
    // Missing/degraded configuration cannot establish repository membership.
    // Keep a never-recorded row unchanged until its existing writer knows it.
    if (read.authority !== 'ok') return undefined;
    return {
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      repoIds: read.config.repos.map((repo) => repo.id),
    };
  },
});

// Failed membership writes still invalidate the registry that already committed.
// Drain after releasing its owner lock, before another queued mutation starts.
const failedWorktreeWriteInvalidations = new Set<string>();
const recentWorktreesSelfWrites = new Map<string, number>();
const lastWorktreesSelfWriteContent = new Map<string, string>();
const WORKTREES_SELF_WRITE_WINDOW_MS = 2_000;
// The commit-log worker installs the file before main learns it applied, so
// the watcher sees the echo while the write is still in flight.
const inFlightWorktreesSelfWrites = new Map<string, number>();
// Keep stale-snapshot tombstones for the process lifetime. The key includes
// createdAt, so a newly-created worktree can reuse the same animal id without
// being filtered, while delayed renderer saves cannot resurrect archived rows.
const recentlyRemovedWorktrees = new Set<string>();

function isReconciliationRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorktreesFileReconciliationSnapshot(
  content: string,
): WorktreeData[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (
    !isReconciliationRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.worktrees)
  ) {
    return null;
  }
  const rows: WorktreeData[] = [];
  for (const row of parsed.worktrees) {
    if (
      !isReconciliationRecord(row) ||
      typeof row.id !== 'string' ||
      typeof row.branchName !== 'string' ||
      typeof row.createdAt !== 'string'
    ) {
      return null;
    }
    // Reconciliation only consumes identity + creation time; construct the
    // narrow shape explicitly instead of casting the raw parsed rows.
    rows.push({
      id: row.id,
      branchName: row.branchName,
      createdAt: row.createdAt,
    });
  }
  return rows;
}

function worktreeRemovalKey(
  workspaceId: string,
  worktreeId: string,
  createdAt: string,
): string {
  return `${workspaceId}/${worktreeId}/${createdAt}`;
}

function markWorktreeRecentlyRemoved(
  workspaceId: string,
  worktreeId: string,
  createdAt: string,
): void {
  markWorktreeRecentlyRemovedAt(workspaceId, worktreeId, createdAt);
}

export function markWorkspaceWorktreeRecentlyRemoved(
  workspaceId: string,
  worktreeId: string,
  createdAt: string,
): void {
  markWorktreeRecentlyRemovedAt(workspaceId, worktreeId, createdAt);
}

/**
 * Whether this process removed the worktree from the list (an archive or a
 * deletion without retention). Without `createdAt`, any incarnation counts.
 */
export function isWorkspaceWorktreeRecentlyRemoved(
  workspaceId: string,
  worktreeId: string,
  createdAt?: string,
): boolean {
  if (createdAt !== undefined) {
    return recentlyRemovedWorktrees.has(
      worktreeRemovalKey(workspaceId, worktreeId, createdAt),
    );
  }
  const prefix = worktreeRemovalKey(workspaceId, worktreeId, '');
  return Array.from(recentlyRemovedWorktrees).some((key) =>
    key.startsWith(prefix),
  );
}

/** @internal - exposed for testing only */
/** Marks a list write in flight; the returned release is idempotent. */
function beginWorktreesSelfWrite(workspaceId: string): () => void {
  inFlightWorktreesSelfWrites.set(
    workspaceId,
    (inFlightWorktreesSelfWrites.get(workspaceId) ?? 0) + 1,
  );
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const remaining = (inFlightWorktreesSelfWrites.get(workspaceId) ?? 1) - 1;
    if (remaining > 0) inFlightWorktreesSelfWrites.set(workspaceId, remaining);
    else inFlightWorktreesSelfWrites.delete(workspaceId);
  };
}

export const workspacePersistenceTestExports: {
  markWorktreeRecentlyRemoved: typeof markWorktreeRecentlyRemoved;
  beginWorktreesSelfWrite: typeof beginWorktreesSelfWrite;
} = {
  markWorktreeRecentlyRemoved,
  beginWorktreesSelfWrite,
};

function markWorktreeRecentlyRemovedAt(
  workspaceId: string,
  worktreeId: string,
  createdAt: string,
): void {
  const key = worktreeRemovalKey(workspaceId, worktreeId, createdAt);
  if (recentlyRemovedWorktrees.has(key)) return;
  recentlyRemovedWorktrees.add(key);
  // A refused W5 decision keeps the row, so its tombstone must not outlive it.
  onW5Abort(() => recentlyRemovedWorktrees.delete(key));
}

function filterRecentlyRemovedWorktrees(
  workspaceId: string,
  worktrees: WorktreeData[],
): WorktreeData[] {
  let changed = false;
  const filtered = worktrees.filter((worktree) => {
    const removed = recentlyRemovedWorktrees.has(
      worktreeRemovalKey(workspaceId, worktree.id, worktree.createdAt),
    );
    if (removed) {
      changed = true;
    }
    return !removed;
  });
  return changed ? filtered : worktrees;
}

async function withWorktreeFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withW5RepositoryLock(
    { kind: 'list', path: filePath },
    async (): Promise<T> => {
      try {
        return await fn();
      } finally {
        if (failedWorktreeWriteInvalidations.delete(filePath))
          await afterW5Commit(notifyPortalStructureChanged);
      }
    },
  );
}

/** Removes only the two W5 records; directory cleanup belongs to the caller. */
export function removeWorkspaceRecords(
  workspaceId: string,
  options?: { deferPluginDefaultsRefresh?: true },
): Promise<void> {
  const removalCommit: W5CommitOptions = {
    operation: 'w5.workspace_records.remove',
  };
  return withStorageAdmission(
    [WORKSPACE_MANIFEST_STORAGE, WORKTREE_LIST_STORAGE],
    () =>
      serializeWorkspaceConfig(workspaceId, () =>
        withWorktreeFileLock(getWorkspaceWorktreesFilePath(workspaceId), () =>
          withW5Commit(removalCommit, async () => {
            const manifest = await desktopW5FileStore.read(
              getWorkspaceConfigPath(workspaceId),
            );
            const list = await desktopW5FileStore.read(
              getWorkspaceWorktreesFilePath(workspaceId),
            );
            if (manifest.state === 'unreadable')
              throw new WorkspaceConfigUnreadableError(manifest.error);
            if (list.state === 'unreadable')
              throw new WorktreeRegistryUnreadableError(list.error);
            const release = beginWorktreesSelfWrite(workspaceId);
            onW5Abort(release);
            try {
              await workspaceManifestRepository.remove(workspaceId);
              await worktreeListRepository.remove(workspaceId);
            } catch (error) {
              release();
              throw error;
            }
            await afterW5Apply(() => {
              recentWorktreesSelfWrites.set(workspaceId, Date.now());
              lastWorktreesSelfWriteContent.delete(workspaceId);
              release();
              if (!options?.deferPluginDefaultsRefresh)
                projectPluginDefaultsWritten({
                  configPath: getWorkspaceConfigPath(workspaceId),
                  workspaceId,
                  layerChanged: manifest.state === 'present',
                });
              failedWorktreeWriteInvalidations.delete(
                getWorkspaceWorktreesFilePath(workspaceId),
              );
            });
          }),
        ),
      ),
  );
}

/**
 * Authority of a worktree list read: `partial` when the list was readable but
 * rows this version cannot read were left out, so an id missing from it is
 * not proof that the worktree is gone (CAN-3803).
 */
export type WorktreeListAuthority = PersistedFileAuthority | 'partial';

/** Why `read` failed, so a refusal can name it (CAN-5531). */
function readError(read: WorktreeListRead): Error | undefined {
  return read.authority === 'unreadable' ? read.error : undefined;
}

/** One locked read: its rows and authority, plus the read a write reuses. */
async function readWorkspaceWorktreesFileDetailed(
  workspaceId: string,
): Promise<{
  worktrees: WorktreeData[];
  authority: WorktreeListAuthority;
  read: WorktreeListRead;
}> {
  const read = await worktreeListRepository.read(workspaceId);
  return read.authority === 'ok'
    ? {
        worktrees: read.worktrees,
        authority: read.complete ? 'ok' : 'partial',
        read,
      }
    : { worktrees: [], authority: read.authority, read };
}

function writeWorkspaceWorktreesFile(
  ...args: Parameters<typeof writeAdmittedWorktreesFile>
): Promise<WorktreeData[]> {
  // Before the group pre-write, so a refusal needs no rollback.
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    writeAdmittedWorktreesFile(...args),
  );
}

async function writeAdmittedWorktreesFile(
  workspaceId: string,
  worktrees: WorktreeData[],
  options?: WorktreeRegistryWriteOptions,
  /** The read this write is built from, made under the same lock. */
  previousRead?: WorktreeListRead,
): Promise<WorktreeData[]> {
  const filePath = getWorkspaceWorktreesFilePath(workspaceId);
  if (options?.sidebarItemGroupId && !worktreeRegistryReconciler)
    throw new Error('Sidebar item group service is not initialized');
  // Every write is built from a read of the list under this lock; rewriting
  // one that could not be read would drop its rows (CAN-3803).
  const previous =
    previousRead ?? (await worktreeListRepository.read(workspaceId));
  if (previous.authority === 'unreadable')
    throw new WorktreeRegistryUnreadableError(previous.error);
  let reconciliation:
    | SidebarGroupRegistryReconciliation<WorktreeData>
    | undefined;
  if (worktreeRegistryReconciler) {
    reconciliation = await worktreeRegistryReconciler(
      workspaceId,
      previous.authority === 'ok' ? previous.worktrees : [],
      worktrees,
      options,
      previous.authority === 'ok' ? previous.unreadableRowIds : [],
    );
    worktrees = reconciliation.rows;
  }
  // Browser retirement and other registry readers do not take this writer's
  // in-process lock. Never expose a truncated or partially written registry.
  let prepared = false;
  let serialized: string;
  let releaseSelfWrite = (): void => undefined;
  try {
    await reconciliation?.beforeWrite?.();
    prepared = true;
    // A staged write stays in flight until its scope applies or aborts.
    releaseSelfWrite = beginWorktreesSelfWrite(workspaceId);
    onW5Abort(releaseSelfWrite);
    const replaceWorktreeList = (): Promise<string> =>
      worktreeListRepository.replace(workspaceId, worktrees, previous);
    serialized = options?.w5Commit
      ? await withW5Commit(options.w5Commit, replaceWorktreeList)
      : await replaceWorktreeList();
  } catch (error) {
    releaseSelfWrite();
    if (prepared && reconciliation?.rollback) {
      try {
        await reconciliation.rollback();
      } catch (rollbackError) {
        throw Object.assign(
          new Error('Registry write and group rollback failed'),
          { errors: [error, rollbackError] },
        );
      }
    }
    throw error;
  }
  // Group reconciliation writes a snapshot taken under the list lock, so it
  // must finish before that lock is released to a concurrent group change.
  // The list is already applied: record it as ours even if reconciliation fails.
  const reconcileAfterWrite = reconciliation?.afterWrite;
  await afterW5Apply(async (): Promise<void> => {
    recentWorktreesSelfWrites.set(workspaceId, Date.now());
    lastWorktreesSelfWriteContent.set(workspaceId, serialized);
    releaseSelfWrite();
    if (!reconcileAfterWrite) return;
    try {
      await reconcileAfterWrite();
    } catch (error) {
      failedWorktreeWriteInvalidations.add(filePath);
      schedulePortalStructuralSync();
      throw error;
    }
  });
  await afterW5Commit(async (): Promise<void> => {
    // Every durable worktree-list mutation (create/archive/update/reorder,
    // desktop- or portal-initiated) funnels through this writer, so this is the
    // one shared point that keeps a connected portal session current (CAN-1304).
    try {
      await options?.afterWrite?.();
      publishSidebarItemGroupsChanged(workspaceId);
    } catch (error) {
      failedWorktreeWriteInvalidations.add(filePath);
      throw error;
    } finally {
      schedulePortalStructuralSync();
      publishWorktreeListWrite(
        previous.authority === 'ok' ? previous.worktrees : [],
        worktrees,
      );
    }
  });
  // Return the identity that this write actually recorded, including initial
  // replicas. No second disk read or raw replica JSON reaches compatibility callers.
  const committed = parseWorktreeList(serialized, workspaceId);
  if (committed.authority !== 'ok') throw new WorktreeRegistryUnreadableError();
  const replicas = new Map(
    committed.worktrees.map((row) => [row.id, row.replica]),
  );
  return worktrees.map((row) => ({ ...row, replica: replicas.get(row.id) }));
}

export function wasRecentWorktreesSelfWrite(workspaceId: string): boolean {
  if (inFlightWorktreesSelfWrites.has(workspaceId)) {
    return true;
  }
  const timestamp = recentWorktreesSelfWrites.get(workspaceId);
  if (timestamp === undefined) {
    return false;
  }
  if (Date.now() - timestamp <= WORKTREES_SELF_WRITE_WINDOW_MS) {
    return true;
  }
  recentWorktreesSelfWrites.delete(workspaceId);
  return false;
}

/**
 * Whether `content` is byte-identical to the last worktrees.json payload this
 * process wrote for the workspace. When true, a file-watcher event carries no
 * new information for the renderer (main-initiated writes already notify it
 * through their own IPC responses/events), so the watcher can drop it instead
 * of triggering a redundant silent projects reload. An external write (the
 * CLI appending a worktree) produces different content and is never matched.
 */
export function isWorktreesSelfWriteContent(
  workspaceId: string,
  content: string,
): boolean {
  return lastWorktreesSelfWriteContent.get(workspaceId) === content;
}

/**
 * Forget the self-write fingerprint for a workspace. The watcher calls this
 * as soon as it observes genuinely external content: from that point the
 * retained payload describes "the last thing the desktop ever wrote", not the
 * write an echo could belong to, so keeping it would misclassify a later
 * byte-exact external revert (desktop A → CLI B → CLI A) as a self-write
 * echo. Also used when a workspace's watcher is torn down, so neither map
 * retains entries for removed workspaces.
 */
export function clearWorktreesSelfWriteTracking(workspaceId: string): void {
  recentWorktreesSelfWrites.delete(workspaceId);
  lastWorktreesSelfWriteContent.delete(workspaceId);
}

export async function readWorkspaceConfig(
  workspaceId: string,
): Promise<WorkspaceConfigFile> {
  return (await readWorkspaceConfigDetailed(workspaceId)).config;
}

const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfigFile = {
  version: 1,
  type: 'multi-repo',
  repos: [],
  alwaysShow: true,
};

/**
 * The `core.workspace.update` manifest fields as stored, before the read
 * replaces a missing or malformed value with its default.
 */
export type StoredWorkspaceManifestFields = Readonly<
  Partial<Record<'itemSortMode' | 'alwaysShow' | 'startPage', unknown>>
>;

interface WorkspaceConfigDetail {
  config: WorkspaceConfigFile;
  authority: PersistedFileAuthority;
  ownerMalformed: boolean;
  memoryMalformed: boolean;
  /** Present only when `authority` is `ok`. */
  storedFields?: StoredWorkspaceManifestFields;
  /** The named reason an unreadable manifest could not be read (CAN-5531, CAN-5542). */
  unserved?: W5NamedUnreadableError;
}

/** {@link readWorkspaceConfig} plus read authority and owner validity. */
export async function readWorkspaceConfigDetailed(
  workspaceId: string,
): Promise<WorkspaceConfigDetail> {
  return (await readWorkspaceConfigState(workspaceId)).detail;
}

/** The normalized config together with the manifest read it came from. */
async function readWorkspaceConfigState(workspaceId: string): Promise<{
  detail: WorkspaceConfigDetail;
  manifest: WorkspaceManifestRead;
}> {
  const manifest = await workspaceManifestRepository.read(workspaceId);
  return { detail: await normalizeWorkspaceConfig(manifest), manifest };
}

async function normalizeWorkspaceConfig(
  manifest: WorkspaceManifestRead,
): Promise<WorkspaceConfigDetail> {
  if (manifest.authority !== 'ok') {
    const unserved =
      manifest.authority === 'unreadable'
        ? w5NamedUnreadable(manifest.error)
        : undefined;
    return {
      config: { ...DEFAULT_WORKSPACE_CONFIG, repos: [] },
      authority: manifest.authority,
      ownerMalformed: false,
      memoryMalformed: false,
      ...(unserved ? { unserved } : {}),
    };
  }
  try {
    const parsed: RawWorkspaceConfigFile = manifest.document;
    {
      const type = normalizeWorkspaceType(parsed);
      const config: WorkspaceConfigFile = {
        ...(typeof parsed.privateMemory === 'boolean'
          ? { privateMemory: parsed.privateMemory }
          : {}),
        privateMemoryManagedBy:
          parsed.privateMemoryManagedBy === 'organization'
            ? 'organization'
            : undefined,
        version: 1,
        personalCatalogId:
          typeof parsed.personalCatalogId === 'string' &&
          personalCatalogIdSchema.safeParse(parsed.personalCatalogId).success
            ? parsed.personalCatalogId
            : undefined,
        cloudBinding: readCloudBinding(manifest.document),
        type,
        repoPath:
          typeof parsed.repoPath === 'string' ? parsed.repoPath : undefined,
        repos: Array.isArray(parsed.repos)
          ? parsed.repos
              .map((repo) => normalizeWorkspaceRepo(repo))
              .filter((repo): repo is WorkspaceRepoData => repo !== null)
          : [],
        // Manual order is the default; only an explicit opt-in to recency is
        // persisted, so a missing value (including every workspace written
        // while recency was the default) reads as manual.
        itemSortMode:
          parsed.itemSortMode === 'last-updated' ? 'last-updated' : 'manual',
        externalPath:
          typeof parsed.externalPath === 'string'
            ? parsed.externalPath
            : typeof parsed.folderPath === 'string'
              ? parsed.folderPath
              : undefined,
        cowork:
          type === 'cowork'
            ? normalizeCoworkSettings(parsed.cowork)
            : undefined,
        defaultPluginSelections:
          parsed.defaultPluginSelections === undefined
            ? undefined
            : normalizePluginSelections(parsed.defaultPluginSelections),
        sharedTemplatePublicationKey:
          typeof parsed.sharedTemplatePublicationKey === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            parsed.sharedTemplatePublicationKey,
          )
            ? parsed.sharedTemplatePublicationKey
            : undefined,
        sharedTemplateExternalId:
          typeof parsed.sharedTemplateExternalId === 'string' &&
          parsed.sharedTemplateExternalId.trim().length > 0
            ? parsed.sharedTemplateExternalId
            : undefined,
        sharedTemplateContentHash:
          typeof parsed.sharedTemplateContentHash === 'string' &&
          /^[a-f0-9]{64}$/.test(parsed.sharedTemplateContentHash)
            ? parsed.sharedTemplateContentHash
            : undefined,
        installedFromTemplateExternalId:
          typeof parsed.installedFromTemplateExternalId === 'string' &&
          parsed.installedFromTemplateExternalId.trim().length > 0
            ? parsed.installedFromTemplateExternalId
            : undefined,
        installedFromTemplateContentHash:
          typeof parsed.installedFromTemplateContentHash === 'string' &&
          /^[a-f0-9]{64}$/.test(parsed.installedFromTemplateContentHash)
            ? parsed.installedFromTemplateContentHash
            : undefined,
        // Curated Blueprint seed provenance. Unlike an install it carries no
        // content hash: a seed is a one-time copy, not a tracked lineage.
        seededFromBlueprintExternalId:
          typeof parsed.seededFromBlueprintExternalId === 'string' &&
          parsed.seededFromBlueprintExternalId.trim().length > 0
            ? parsed.seededFromBlueprintExternalId
            : undefined,
        disabledGlobalPluginSelections: normalizePluginSelectionTombstones(
          parsed.disabledGlobalPluginSelections,
        ),
        sourceRepoPath:
          typeof parsed.sourceRepoPath === 'string'
            ? parsed.sourceRepoPath
            : undefined,
        scripts: normalizeLegacyScriptFields(parsed),
        hooks: normalizeUnknownHookMap(parsed.hooks),
        suppressedRepoIds: normalizeSuppressedRepoIds(parsed.suppressedRepoIds),
        // Retirement requires explicit true to keep an empty temporary
        // combination. Preserve absence here instead of reviving it on read.
        alwaysShow:
          typeof parsed.alwaysShow === 'boolean'
            ? parsed.alwaysShow
            : type === 'multi-repo' && parsed.temporary === true
              ? undefined
              : true,
        owner: normalizeWorkspaceOwner(parsed.owner),
        detachedOwner: normalizeWorkspaceDetachedOwner(parsed.detachedOwner),
        ownershipTransfer: normalizeWorkspaceOwnershipTransfer(
          parsed.ownershipTransfer,
        ),
        recommendedPluginOptOutKeys: normalizeStringList(
          parsed.recommendedPluginOptOutKeys,
        ),
        temporary:
          type === 'multi-repo' && typeof parsed.temporary === 'boolean'
            ? parsed.temporary
            : undefined,
        planDetection: normalizeWorkspacePlanDetection(parsed.planDetection),
        archiveRetentionDays:
          parsed.archiveRetentionDays === null ||
          (typeof parsed.archiveRetentionDays === 'number' &&
            Number.isInteger(parsed.archiveRetentionDays) &&
            parsed.archiveRetentionDays >= 0 &&
            parsed.archiveRetentionDays <= MAX_ARCHIVE_RETENTION_DAYS)
            ? parsed.archiveRetentionDays
            : undefined,
        autoArchiveDays:
          parsed.autoArchiveDays === null ||
          (typeof parsed.autoArchiveDays === 'number' &&
            Number.isInteger(parsed.autoArchiveDays) &&
            parsed.autoArchiveDays >= 1 &&
            parsed.autoArchiveDays <= MAX_ARCHIVE_RETENTION_DAYS)
            ? parsed.autoArchiveDays
            : undefined,
        autoArchiveDeleteBranch:
          typeof parsed.autoArchiveDeleteBranch === 'boolean'
            ? parsed.autoArchiveDeleteBranch
            : undefined,
        ...(parsed.startPage === null || isProjectStartPage(parsed.startPage)
          ? { startPage: parsed.startPage }
          : {}),
        ...(type === 'multi-repo'
          ? {
              temporarySourceWorkspaceIds: normalizeStringList(
                parsed.temporarySourceWorkspaceIds,
              ),
              temporaryRepoIdentityKeys: normalizeStringList(
                parsed.temporaryRepoIdentityKeys,
              ),
            }
          : {}),
      };
      return {
        config: await withAccountMcpRefs(config),
        authority: 'ok',
        ownerMalformed:
          parsed.owner !== undefined && config.owner === undefined,
        memoryMalformed:
          (parsed.privateMemory !== undefined &&
            typeof parsed.privateMemory !== 'boolean') ||
          (parsed.privateMemoryManagedBy !== undefined &&
            parsed.privateMemoryManagedBy !== 'organization') ||
          (parsed.privateMemoryManagedBy === 'organization' &&
            typeof parsed.privateMemory !== 'boolean'),
        storedFields: {
          itemSortMode: parsed.itemSortMode,
          alwaysShow: parsed.alwaysShow,
          startPage: parsed.startPage,
        },
      };
    }
  } catch {
    // A shape the normalizers reject: the default, reported as unreadable.
  }
  return {
    config: { ...DEFAULT_WORKSPACE_CONFIG, repos: [] },
    authority: 'unreadable',
    ownerMalformed: false,
    memoryMalformed: false,
  };
}

/**
 * The project layer a chat's plugin resolution inherits: this workspace's
 * default plugins and the global defaults it turned off. Served from memory
 * after the first read; every write of `workspace.json` invalidates it.
 */
export function readProjectPluginDefaults(
  workspaceId: string,
): Promise<ProjectPluginDefaults> {
  return readThroughProjectPluginDefaults(
    getWorkspaceConfigPath(workspaceId),
    async () => {
      const { config, authority } =
        await readWorkspaceConfigDetailed(workspaceId);
      return {
        defaults: {
          defaultPluginSelections: config.defaultPluginSelections,
          disabledGlobalPluginSelections: config.disabledGlobalPluginSelections,
        },
        cacheable: authority !== 'unreadable',
      };
    },
  );
}

/** Legacy `account:<connectionId>` MCP refs read as `{ serverKey, configId }`. */
async function withAccountMcpRefs(
  config: WorkspaceConfigFile,
): Promise<WorkspaceConfigFile> {
  try {
    const [defaultPluginSelections, disabledGlobalPluginSelections] =
      await settleAll([
        normalizeAccountMcpSelections(
          config.defaultPluginSelections,
          undefined,
          ACCOUNT_MCP_REF_LOADER_WAIT,
        ),
        normalizeAccountMcpTombstones(
          config.disabledGlobalPluginSelections,
          ACCOUNT_MCP_REF_LOADER_WAIT,
        ),
      ]);
    return {
      ...config,
      defaultPluginSelections,
      disabledGlobalPluginSelections,
    };
  } catch {
    return config;
  }
}

const personalCatalogIdSchema = z.string().uuid();

/**
 * How a config write treats `owner` and `ownershipTransfer`. Ownership is
 * main-owned (CAN-3415): an ordinary write — a sidebar save from a renderer
 * that has not reloaded yet, or any read-modify-write that started before a
 * conversion — keeps what an authoritative read of `workspace.json` holds, so
 * it can never undo a conversion or a move back. Only code that binds a
 * workspace passes `replace`; a missing file takes the caller's values either
 * way, as a new workspace must. No write replaces an unreadable file
 * (CAN-3563): it is refused with {@link WorkspaceConfigUnreadableError}.
 */
export type WorkspaceConfigOwnershipWrite = 'preserve' | 'replace';

export async function writeWorkspaceConfig(
  workspaceId: string,
  config: WorkspaceConfigFile,
  options?: { ownership?: WorkspaceConfigOwnershipWrite },
): Promise<void> {
  await serializeWorkspaceConfig(workspaceId, () =>
    writeWorkspaceConfigSerialized(
      workspaceId,
      config,
      options?.ownership ?? 'preserve',
    ),
  );
}

/**
 * Bind inherited organization hooks inside the existing owner/config write
 * queue. Returns the owner the hooks were bound under so overlay filtering
 * cannot disagree with a concurrent ownership change.
 */
export async function ensureOrganizationSourceHookBindings(args: {
  workspaceId: string;
  source: HookOverrides | undefined;
  local: HookOverrides | undefined;
  owner: WorkspaceOwnerBinding | undefined;
  repoId?: string;
}): Promise<{
  hooks: HookOverrides | undefined;
  owner: WorkspaceOwnerBinding | undefined;
}> {
  const unchanged = { hooks: args.local, owner: args.owner };
  if (
    !args.owner ||
    addOrganizationSourceHookBindings(
      args.source,
      args.local,
      args.owner.organizationId,
    ) === args.local
  )
    return unchanged;
  const { getFeatureFlagService } = await import('../feature-flags');
  if (
    !getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    )
  )
    return unchanged;
  let result = unchanged;
  await serializeWorkspaceConfig(args.workspaceId, async (): Promise<void> => {
    const detail = await readWorkspaceConfigDetailed(args.workspaceId);
    if (detail.authority !== 'ok' || detail.ownerMalformed) return;
    const config = detail.config;
    const scope =
      args.repoId === undefined
        ? config
        : config.repos.find((repo) => repo.id === args.repoId);
    if (!scope) return;
    result = { hooks: scope.hooks, owner: config.owner };
    if (!config.owner) return;
    const bound = addOrganizationSourceHookBindings(
      args.source,
      scope.hooks,
      config.owner.organizationId,
    );
    if (bound === scope.hooks) return;
    result = { hooks: bound, owner: config.owner };
    // A query's read view refuses writes; the binding is written as it closes.
    if (
      deferUntilW5ReadViewCloses(() =>
        ensureOrganizationSourceHookBindings(args),
      )
    )
      return;
    scope.hooks = bound;
    await writeWorkspaceConfigSerialized(args.workspaceId, config, 'preserve');
  });
  return result;
}

export interface WorkspaceOwnership {
  detachedOwner?: WorkspaceDetachedOwner;
  owner?: WorkspaceOwnerBinding;
  ownershipTransfer?: WorkspaceOwnershipTransfer;
}

export type WorkspaceOwnershipRead =
  | ({
      authority: 'ok';
      type: WorkspaceConfigFile['type'];
    } & WorkspaceOwnership)
  | { authority: 'absent' | 'unreadable' };

/**
 * Authoritative ownership of one workspace. A malformed owner is reported as
 * unreadable rather than Personal: converting over it would overwrite a
 * binding nobody can read.
 */
export async function readWorkspaceOwnership(
  workspaceId: string,
): Promise<WorkspaceOwnershipRead> {
  const detail = await readWorkspaceConfigDetailed(workspaceId);
  if (detail.authority !== 'ok') return { authority: detail.authority };
  if (detail.ownerMalformed) return { authority: 'unreadable' };
  return {
    authority: 'ok',
    type: detail.config.type,
    owner: detail.config.owner,
    ownershipTransfer: detail.config.ownershipTransfer,
    detachedOwner: detail.config.detachedOwner,
  };
}

export type WorkspaceOwnershipUpdate =
  | 'written'
  | 'declined'
  | 'absent'
  | 'unreadable';

/**
 * The single writer of an existing workspace's ownership (CAN-3415). `update`
 * sees the authoritative current ownership inside the per-workspace write
 * queue and returns the replacement, or `null` to leave the file alone, so a
 * caller's precondition and its write cannot be separated by another writer.
 * Everything else in `workspace.json` is kept.
 */
export async function updateWorkspaceOwnership(
  workspaceId: string,
  update: (
    current: Extract<WorkspaceOwnershipRead, { authority: 'ok' }>,
  ) => WorkspaceOwnership | null,
): Promise<WorkspaceOwnershipUpdate> {
  const outcome: { value: WorkspaceOwnershipUpdate } = { value: 'unreadable' };
  await serializeWorkspaceConfig(workspaceId, async (): Promise<void> => {
    const detail = await readWorkspaceConfigDetailed(workspaceId);
    if (detail.authority === 'absent') {
      outcome.value = 'absent';
      return;
    }
    if (detail.authority !== 'ok' || detail.ownerMalformed) return;
    const next = update({
      authority: 'ok',
      type: detail.config.type,
      owner: detail.config.owner,
      ownershipTransfer: detail.config.ownershipTransfer,
      detachedOwner: detail.config.detachedOwner,
    });
    if (next === null) {
      outcome.value = 'declined';
      return;
    }
    await writeWorkspaceConfigSerialized(
      workspaceId,
      {
        ...detail.config,
        owner: next.owner,
        ownershipTransfer: next.ownershipTransfer,
        ...(Object.prototype.hasOwnProperty.call(next, 'detachedOwner')
          ? { detachedOwner: next.detachedOwner }
          : {}),
      },
      'replace',
    );
    outcome.value = 'written';
  });
  if (outcome.value === 'written') notifyPortalStructureChanged();
  return outcome.value;
}

/**
 * `cloudBinding` (CAN-5190) is deliberately not a known manifest key: every
 * config writer, of this version or any other, keeps it exactly as stored, and
 * only {@link updateWorkspaceCloudBinding} changes it. A value this version
 * cannot parse reads as unbound and is still kept.
 */
function readCloudBinding(
  document: Readonly<Record<string, unknown>>,
): CloudProjectBinding | undefined {
  const parsed = CloudProjectBindingSchema.safeParse(document.cloudBinding);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The single writer of a workspace's `cloudBinding` (CAN-5190). `decide` sees
 * the authoritative manifest inside the per-workspace write queue and returns
 * the replacement binding (`undefined` removes it), or `null` to leave the
 * file alone. Only that key changes: the rest of the stored document is
 * written back as read. A missing manifest is never created.
 */
export async function updateWorkspaceCloudBinding(
  workspaceId: string,
  decide: WorkspaceCloudBindingCompare,
): Promise<WorkspaceOwnershipUpdate> {
  const outcome: { value: WorkspaceOwnershipUpdate } = {
    value: 'unreadable',
  };
  await serializeWorkspaceConfig(workspaceId, async (): Promise<void> => {
    const { detail, manifest } = await readWorkspaceConfigState(workspaceId);
    if (manifest.authority === 'absent') {
      outcome.value = 'absent';
      return;
    }
    if (
      manifest.authority !== 'ok' ||
      detail.authority !== 'ok' ||
      detail.ownerMalformed
    )
      return;
    const next = decide({
      type: detail.config.type,
      owner: detail.config.owner,
      personalCatalogId: detail.config.personalCatalogId,
      temporary: detail.config.temporary === true,
      cloudBinding: detail.config.cloudBinding,
      suppressedRepoIds: detail.config.suppressedRepoIds ?? [],
    });
    if (next === null) {
      outcome.value = 'declined';
      return;
    }
    const suppressed = next.suppressedRepoIds;
    const document = Object.fromEntries(
      Object.entries(manifest.document).filter(
        ([key]) =>
          key !== 'cloudBinding' &&
          (suppressed === undefined || key !== 'suppressedRepoIds'),
      ),
    );
    if (next.cloudBinding !== undefined)
      document.cloudBinding = CloudProjectBindingSchema.parse(
        next.cloudBinding,
      );
    if (suppressed !== undefined && suppressed.length > 0)
      document.suppressedRepoIds = [...suppressed];
    await workspaceManifestRepository.replaceDocument(
      workspaceId,
      document,
      manifest,
    );
    outcome.value = 'written';
  });
  if (outcome.value === 'written')
    notifyWorkspaceMemoryBindingChanged(workspaceId);
  return outcome.value;
}

export async function ensurePersonalCatalogId(
  workspaceId: string,
  allowed: () => Promise<boolean>,
): Promise<string | undefined> {
  let id: string | undefined;
  await serializeWorkspaceConfig(workspaceId, async (): Promise<void> => {
    const detail = await readWorkspaceConfigDetailed(workspaceId);
    if (
      detail.authority !== 'ok' ||
      detail.ownerMalformed ||
      detail.config.owner ||
      detail.config.temporary
    )
      return;
    if (!(await allowed())) return;
    id = detail.config.personalCatalogId;
    if (id) return;
    id = randomUUID();
    await writeWorkspaceConfigSerialized(
      workspaceId,
      { ...detail.config, personalCatalogId: id },
      'preserve',
    );
  });
  return id;
}

function serializeWorkspaceConfig<T>(
  workspaceId: string,
  work: () => Promise<T>,
): Promise<T> {
  return workspaceManifestRepository.serialize(workspaceId, work);
}

/** Refuses a write over an unreadable `workspace.json` (CAN-3563). */
async function refuseUnreadableWorkspaceConfig(
  manifest: WorkspaceManifestRead,
): Promise<never> {
  const cause =
    manifest.authority === 'unreadable' ? manifest.error : undefined;
  // An unreachable authority never showed the file unreadable (CAN-5542).
  if (!(cause instanceof W5AuthorityUnreachableError))
    await recordWorkspaceConfigWriteRefused();
  throw new WorkspaceConfigUnreadableError(cause);
}

async function recordWorkspaceConfigWriteRefused(): Promise<void> {
  try {
    const { getObservabilityService } = await import('../observability');
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'workspace_config_write_refused',
      reason: 'unreadable',
    });
  } catch {
    // Diagnostics are best effort; the refusal itself protects the config.
  }
}

/** What {@link updateWorkspaceConfig} read, inside its write queue. */
export interface WorkspaceConfigUpdateRead {
  /** `absent` means the config passed to `update` is the default one. */
  authority: 'ok' | 'absent';
  ownerMalformed: boolean;
  memoryMalformed: boolean;
}

/**
 * The guarded read-modify-write of one workspace's `workspace.json`. Reads
 * the file inside the per-workspace write queue, lets `update` change that
 * config in place (throw to abort), and writes it back, so no other writer
 * can land between the read and the write. Fields `update` leaves alone keep
 * their on-disk values.
 *
 * The plain reader falls back to a default config with no repositories when
 * the file cannot be read (truncated, corrupt, permission denied, or an I/O
 * error such as EMFILE). Writing that default back would erase the project's
 * repositories and settings (CAN-3563), so an unreadable file is left as it
 * is and the update is refused with {@link WorkspaceConfigUnreadableError}.
 * An absent file still reads as the default config; `update` sees which one
 * it got in its second argument, so a typed command can refuse to create a
 * manifest or to write over a malformed owner or memory policy.
 */
export async function updateWorkspaceConfig<T>(
  workspaceId: string,
  update: (
    config: WorkspaceConfigFile,
    read: WorkspaceConfigUpdateRead,
  ) => T | Promise<T>,
  options?: {
    ownership?: WorkspaceConfigOwnershipWrite;
    /**
     * Decides from `update`'s result whether to write; omitted, the update
     * is always written. Lets a sweep that changed nothing leave the file,
     * and a missing workspace, untouched.
     */
    shouldWrite?: (result: T) => boolean;
  },
): Promise<T> {
  return serializeWorkspaceConfig(workspaceId, async (): Promise<T> => {
    const { detail, manifest } = await readWorkspaceConfigState(workspaceId);
    const { config, authority, ownerMalformed, memoryMalformed } = detail;
    if (authority === 'unreadable')
      return refuseUnreadableWorkspaceConfig(manifest);
    const result = await update(config, {
      authority,
      ownerMalformed,
      memoryMalformed,
    });
    if (options?.shouldWrite && !options.shouldWrite(result)) return result;
    await writeWorkspaceConfigSerialized(
      workspaceId,
      config,
      options?.ownership ?? 'preserve',
    );
    return result;
  });
}
type ProjectPluginDefaultsChangeHandler = (
  workspaceId: string,
  previousDefaults: ChatTabPluginSelections | undefined,
  previousProjectTombstones: PluginSelectionTombstones | undefined,
) => Promise<void>;

let beforeProjectPluginDefaultsChange:
  | ProjectPluginDefaultsChangeHandler
  | undefined;

export const PROJECT_PLUGIN_DEFAULTS_NORMALIZATION_FAILED =
  "Couldn't change this project's default plugins because some of its chats couldn't be updated first. Try again.";

/**
 * Registers the work that must finish before a workspace's
 * `defaultPluginSelections` change on disk (the one-time chat normalization
 * against the defaults being replaced). The handler runs inside this
 * workspace's config write chain, so it must never write this workspace's
 * config itself.
 */
export function setBeforeProjectPluginDefaultsChangeHandler(
  handler: ProjectPluginDefaultsChangeHandler | undefined,
): void {
  beforeProjectPluginDefaultsChange = handler;
}

function writeWorkspaceConfigSerialized(
  ...args: Parameters<typeof writeAdmittedWorkspaceConfig>
): Promise<void> {
  // Before chat normalization for a defaults change.
  return withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
    writeAdmittedWorkspaceConfig(...args),
  );
}

async function writeAdmittedWorkspaceConfig(
  workspaceId: string,
  config: WorkspaceConfigFile,
  ownership: WorkspaceConfigOwnershipWrite,
): Promise<void> {
  const filePath = getWorkspaceConfigPath(workspaceId);
  const { detail: previous, manifest } =
    await readWorkspaceConfigState(workspaceId);
  // An atomic replace needs no read permission, so nothing else stops a
  // write over a file this process cannot read. Whatever the caller built,
  // it was not built from that file: replacing it would drop every field
  // the caller does not carry, such as `ownershipTransfer` (CAN-3563).
  if (previous.authority === 'unreadable')
    return refuseUnreadableWorkspaceConfig(manifest);
  const existing =
    config.personalCatalogId === undefined || ownership === 'preserve'
      ? previous
      : null;
  const ownershipSource =
    ownership === 'preserve' && existing?.authority === 'ok'
      ? existing.config
      : config;
  const detachedOwner =
    previous.authority === 'ok' &&
    (ownership === 'preserve' ||
      !Object.prototype.hasOwnProperty.call(config, 'detachedOwner'))
      ? previous.config.detachedOwner
      : config.detachedOwner;
  const payload: WorkspaceConfigFile = {
    privateMemory: config.privateMemory ?? previous.config.privateMemory,
    privateMemoryManagedBy:
      ownershipSource.owner !== undefined
        ? (config.privateMemoryManagedBy ??
          previous.config.privateMemoryManagedBy)
        : undefined,
    version: 1,
    personalCatalogId:
      config.personalCatalogId ?? existing?.config.personalCatalogId,
    type: config.type,
    repoPath: config.repoPath,
    repos: config.repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      repoPath: repo.repoPath,
      source: repo.source,
      manifestUrl: repo.manifestUrl,
      scripts: normalizeScriptInputMap(repo.scripts),
      hooks: normalizeHookInputMap(repo.hooks),
    })),
    itemSortMode:
      config.itemSortMode === 'last-updated' ? 'last-updated' : undefined,
    externalPath: config.externalPath,
    cowork: config.type === 'cowork' ? config.cowork : undefined,
    defaultPluginSelections:
      config.defaultPluginSelections === undefined
        ? undefined
        : await normalizeAccountMcpSelections(
            normalizePluginSelections(config.defaultPluginSelections),
            undefined,
            ACCOUNT_MCP_REF_LOADER_WAIT,
          ),
    sharedTemplatePublicationKey: config.sharedTemplatePublicationKey,
    sharedTemplateExternalId: config.sharedTemplateExternalId,
    sharedTemplateContentHash: config.sharedTemplateContentHash,
    installedFromTemplateExternalId: config.installedFromTemplateExternalId,
    installedFromTemplateContentHash: config.installedFromTemplateContentHash,
    seededFromBlueprintExternalId: config.seededFromBlueprintExternalId,
    disabledGlobalPluginSelections: await normalizeAccountMcpTombstones(
      normalizePluginSelectionTombstones(config.disabledGlobalPluginSelections),
      ACCOUNT_MCP_REF_LOADER_WAIT,
    ),
    sourceRepoPath: config.sourceRepoPath,
    scripts: normalizeScriptInputMap(config.scripts),
    hooks: normalizeHookInputMap(config.hooks),
    suppressedRepoIds: normalizeSuppressedRepoIds(config.suppressedRepoIds),
    alwaysShow: config.alwaysShow,
    owner: normalizeWorkspaceOwner(ownershipSource.owner),
    detachedOwner: normalizeWorkspaceDetachedOwner(detachedOwner),
    ownershipTransfer: normalizeWorkspaceOwnershipTransfer(
      ownershipSource.ownershipTransfer,
    ),
    recommendedPluginOptOutKeys: normalizeStringList(
      config.recommendedPluginOptOutKeys,
    ),
    temporary:
      config.type === 'multi-repo' && config.temporary === true
        ? true
        : undefined,
    planDetection: normalizeWorkspacePlanDetection(config.planDetection),
    archiveRetentionDays:
      config.archiveRetentionDays === null ||
      (typeof config.archiveRetentionDays === 'number' &&
        Number.isInteger(config.archiveRetentionDays) &&
        config.archiveRetentionDays >= 0 &&
        config.archiveRetentionDays <= MAX_ARCHIVE_RETENTION_DAYS)
        ? config.archiveRetentionDays
        : undefined,
    autoArchiveDays:
      config.autoArchiveDays === null ||
      (typeof config.autoArchiveDays === 'number' &&
        Number.isInteger(config.autoArchiveDays) &&
        config.autoArchiveDays >= 1 &&
        config.autoArchiveDays <= MAX_ARCHIVE_RETENTION_DAYS)
        ? config.autoArchiveDays
        : undefined,
    autoArchiveDeleteBranch:
      typeof config.autoArchiveDeleteBranch === 'boolean'
        ? config.autoArchiveDeleteBranch
        : undefined,
    ...(config.startPage === null || isProjectStartPage(config.startPage)
      ? { startPage: config.startPage }
      : {}),
    ...(config.type === 'multi-repo'
      ? {
          temporarySourceWorkspaceIds: normalizeStringList(
            config.temporarySourceWorkspaceIds,
          ),
          temporaryRepoIdentityKeys: normalizeStringList(
            config.temporaryRepoIdentityKeys,
          ),
        }
      : {}),
  };
  const defaultsChanged = !pluginSelectionsEqual(
    normalizePluginSelections(previous.config.defaultPluginSelections),
    normalizePluginSelections(payload.defaultPluginSelections),
  );
  if (defaultsChanged) {
    try {
      await inMcpRefRewritePhase('normalization', async () =>
        beforeProjectPluginDefaultsChange?.(
          workspaceId,
          previous.config.defaultPluginSelections,
          previous.config.disabledGlobalPluginSelections,
        ),
      );
    } catch (error) {
      logMainProcessWarn(
        '[workspace-persistence] project default normalization failed',
        { workspaceId, error },
      );
      throw recordMcpRefRewriteFailure(
        new Error(PROJECT_PLUGIN_DEFAULTS_NORMALIZATION_FAILED),
        'normalization',
      );
    }
  }
  const layerChanged =
    defaultsChanged || projectPluginLayerChanged(previous.config, payload);
  try {
    // Sidebar loads and other readers do not take this writer's queue. Never
    // expose a truncated file: a reader would fall back to a default config
    // with no repositories, and a later save would persist it (CAN-3563).
    await workspaceManifestRepository.replace(workspaceId, payload, manifest);
  } catch (error) {
    throw recordMcpRefRewriteFailure(error, 'manifestCommit');
  } finally {
    await afterW5Commit(() =>
      projectPluginDefaultsWritten({
        configPath: filePath,
        workspaceId,
        layerChanged,
      }),
    );
  }
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    entries.push(normalized);
  }

  return entries.length > 0 ? entries : undefined;
}

export async function readWorkspaceWorktrees(
  workspaceId: string,
  options?: { persistRemovalCleanup?: false },
): Promise<WorktreeData[]> {
  return (await readWorkspaceWorktreesDetailed(workspaceId, options)).worktrees;
}

/** {@link readWorkspaceWorktrees} plus the authority of that same read. */
export async function readWorkspaceWorktreesDetailed(
  workspaceId: string,
  /** Revisioned admission must not repair a list before checking its precondition. */
  options?: {
    persistRemovalCleanup?: false;
    /** Durable admission includes tombstoned rows and never persists cleanup. */
    includeRecentlyRemoved?: true;
  },
): Promise<{
  worktrees: WorktreeData[];
  /** Unchanged by removal filtering, which these ids record instead. */
  authority: WorktreeListAuthority;
  /** Rows this process removed that the read left out, when any. */
  recentlyRemovedWorktreeIds?: string[];
  /** The named reason an unreadable list could not be read (CAN-5531, CAN-5542). */
  unserved?: W5NamedUnreadableError;
}> {
  const filePath = getWorkspaceWorktreesFilePath(workspaceId);
  // A21′: read-repair is effect-free, so a conflicting routed write reruns
  // the locked read (W6g). The commit label stays `w5.worktree_list.write`.
  return runW5PreEffectUnit('internal.repository.write', () =>
    readRepairingWorktrees(workspaceId, filePath, options),
  );
}

function readRepairingWorktrees(
  workspaceId: string,
  filePath: string,
  options:
    | { persistRemovalCleanup?: false; includeRecentlyRemoved?: true }
    | undefined,
): ReturnType<typeof readWorkspaceWorktreesDetailed> {
  return withWorktreeFileLock(filePath, async () => {
    const { worktrees, authority, read } =
      await readWorkspaceWorktreesFileDetailed(workspaceId);
    const unserved = w5NamedUnreadable(readError(read));
    // An unreadable read has no rows to filter, so it keeps its reason below.
    const named = unserved ? { unserved } : {};
    if (options?.includeRecentlyRemoved)
      return { worktrees, authority, ...named };
    const filteredWorktrees = filterRecentlyRemovedWorktrees(
      workspaceId,
      worktrees,
    );
    if (filteredWorktrees === worktrees)
      return { worktrees, authority, ...named };
    if (
      options?.persistRemovalCleanup !== false &&
      // Re-read after closure so cleanup cannot overwrite a newer list.
      !deferUntilW5ReadViewCloses(() =>
        readWorkspaceWorktreesDetailed(workspaceId, options),
      )
    ) {
      await writeWorkspaceWorktreesFile(
        workspaceId,
        filteredWorktrees,
        undefined,
        read,
      );
    }
    const kept = new Set(filteredWorktrees);
    return {
      worktrees: filteredWorktrees,
      authority,
      recentlyRemovedWorktreeIds: worktrees
        .filter((worktree) => !kept.has(worktree))
        .map((worktree) => worktree.id),
    };
  });
}

/**
 * One read of the list that takes no lock, filters no tombstones and never
 * writes. For backend readers that may run inside another task's lock
 * context (the Ledger lifecycle, CAN-5478). There the locked read waits on a
 * held list, refuses the lock order, or throws once an inherited commit scope
 * has finished.
 */
export async function readWorkspaceWorktreesUnlocked(
  workspaceId: string,
): Promise<{ worktrees: WorktreeData[]; authority: WorktreeListAuthority }> {
  const { worktrees, authority } =
    await readWorkspaceWorktreesFileDetailed(workspaceId);
  return { worktrees, authority };
}

export async function isWorkspaceWorktreeCurrent(
  workspaceId: string,
  worktreeId: string,
  expectedCreatedAt?: string,
): Promise<boolean> {
  const createdAt = await getWorkspaceWorktreeCreatedAt(
    workspaceId,
    worktreeId,
  );
  if (createdAt === null) {
    return false;
  }
  return expectedCreatedAt === undefined
    ? true
    : createdAt === expectedCreatedAt;
}

export async function getWorkspaceWorktreeCreatedAt(
  workspaceId: string,
  worktreeId: string,
): Promise<string | null> {
  const worktrees = await readWorkspaceWorktrees(workspaceId);
  const worktree = worktrees.find((entry) => entry.id === worktreeId);
  return worktree?.createdAt ?? null;
}

export async function writeWorkspaceWorktrees(
  workspaceId: string,
  worktrees: WorktreeData[],
): Promise<void> {
  const filePath = getWorkspaceWorktreesFilePath(workspaceId);
  await withWorktreeFileLock(filePath, async () => {
    const filteredWorktrees = filterRecentlyRemovedWorktrees(
      workspaceId,
      worktrees,
    );
    const current = await readWorkspaceWorktreesFileDetailed(workspaceId);
    const currentWorktrees = filterRecentlyRemovedWorktrees(
      workspaceId,
      current.worktrees,
    );
    const reconciledWorktrees = preserveCanonicalWorktreeOrder(
      filteredWorktrees,
      currentWorktrees,
    );
    const seen = markSavedPipelineResultsSeen(
      preserveMainOwnedWorktreeMetadata(reconciledWorktrees, currentWorktrees),
      currentWorktrees,
    );
    const badgeReconciledWorktrees = seen.worktrees;
    const worktreesToWrite = badgeReconciledWorktrees.some(
      (worktree) => worktree.setupPhase === 'git-pending',
    )
      ? preservePromotedWorktreePhases(
          badgeReconciledWorktrees,
          currentWorktrees,
        )
      : badgeReconciledWorktrees;
    await writeWorkspaceWorktreesFile(
      workspaceId,
      worktreesToWrite,
      undefined,
      current.read,
    );
    // Announce only what the commit above made durable.
    await afterW5Commit(() => {
      for (const [worktreeId, newlySeen] of seen.newlySeen) {
        markForeignPipelineResultsSeen(workspaceId, worktreeId, newlySeen);
      }
    });
  });
  await afterW5Commit(notifyPortalStructureChanged);
}

/**
 * Applies each saved row's seen pipeline executions as
 * `internal.worktree.pipelineResults.markSeen` (CAN-3821): the snapshot is
 * diffed against the committed row and the change is applied to that row,
 * in the same write. Returns the newly seen executions per row for the
 * post-commit announcement. The diff is against the committed row, not the
 * snapshot's read, so a stale save can still unmark executions (F4) until
 * the `projects:save` adapter carries the revision it read (CAN-3818).
 */
function markSavedPipelineResultsSeen(
  incomingWorktrees: WorktreeData[],
  currentWorktrees: WorktreeData[],
): { worktrees: WorktreeData[]; newlySeen: Array<[string, string[]]> } {
  const currentById = new Map(
    currentWorktrees.map((worktree) => [worktree.id, worktree]),
  );
  const newlySeen: Array<[string, string[]]> = [];
  const worktrees = incomingWorktrees.map((incoming) => {
    const current = currentById.get(incoming.id);
    const committed: WorktreeData = { ...incoming };
    if (current?.seenPipelineExecutionIds !== undefined) {
      committed.seenPipelineExecutionIds = current.seenPipelineExecutionIds;
    } else {
      delete committed.seenPipelineExecutionIds;
    }
    const outcome = markWorktreePipelineResultsSeen(
      committed,
      diffWorktreePipelineResultsSeen(current, incoming),
    );
    if (outcome.newlySeen.length > 0) {
      newlySeen.push([incoming.id, outcome.newlySeen]);
    }
    return outcome.worktree;
  });
  return { worktrees, newlySeen };
}

/**
 * Metadata persisted by main-process observers or targeted commands survives a
 * wholesale renderer save whose snapshot predates the observer write.
 */
function preserveMainOwnedWorktreeMetadata(
  incomingWorktrees: WorktreeData[],
  currentWorktrees: WorktreeData[],
): WorktreeData[] {
  const currentById = new Map(
    currentWorktrees.map((worktree) => [worktree.id, worktree]),
  );
  return incomingWorktrees.map((incomingWorktree) => {
    const current = currentById.get(incomingWorktree.id);
    if (!current) {
      return incomingWorktree;
    }
    return {
      ...incomingWorktree,
      replica: current.replica,
      creation: current.creation,
      // Only main's targeted Git setup write can promote a pending checkout.
      ...(current.setupPhase === 'git-pending'
        ? { setupPhase: current.setupPhase }
        : {}),
      // Activity is written by main-process observers. A renderer snapshot
      // loaded before the latest touch must never move the inactivity
      // watermark backward or erase it.
      lastTouchedAt: current.lastTouchedAt,
      // Pinning is a targeted main-process mutation. Preserve both the true
      // marker and its deliberate absence across stale whole-list saves.
      pinned: current.pinned,
      // Visibility, labels and grouping have targeted mutations too. Keep
      // deliberate clears authoritative, just like pinning and tracked bases.
      hidden: current.hidden,
      label: current.label,
      labelSource: current.labelSource,
      labelProvisional: current.labelProvisional,
      branchGroupingOverride: current.branchGroupingOverride,
      ...(current.chatBadges !== undefined
        ? { chatBadges: current.chatBadges }
        : {}),
      // Hook pause/resume uses targeted writes. A stale sidebar save must not
      // undo a pause or resurrect keys removed by an explicit resume.
      pausedHookKeys: current.pausedHookKeys,
      // Targeted/main-process base writes own the scalar value, including an
      // absent value for worktrees that have never selected a tracked base.
      trackedBaseBranch: current.trackedBaseBranch,
      // Unlike the scalar value (whose explicit clear is `null`), clearing the
      // final per-repo override removes this property. Keep that absence
      // authoritative too, otherwise an older renderer snapshot can resurrect
      // the map immediately after the targeted IPC cleared it.
      trackedRepoBaseBranches: current.trackedRepoBaseBranches,
      // A targeted retarget also removes grouping. Keep both the current value
      // and its absence authoritative against a stale renderer snapshot.
      branchGroupingParentWorktreeId: current.branchGroupingParentWorktreeId,
    };
  });
}

/**
 * Wholesale full-file saves (e.g. the renderer persisting the entire sidebar
 * via `writeAllSidebarItems`) trust a caller-supplied snapshot. If that snapshot
 * predates an entry that was appended directly to `worktrees.json` in the main
 * process — as the Split PR engine does when it creates child worktrees during a
 * multi-minute run — a naive full-file overwrite silently drops the newer rows.
 *
 * Snapshot order is not an order mutation: keep the current registry's entire
 * live order, merging incoming fields by id, then append genuinely new rows.
 * Removed rows have already been tombstone-filtered from both inputs. Explicit
 * reorder/grouping operations use `updateWorkspaceWorktrees` under this same
 * lock; archive restore uses `restoreWorkspaceWorktrees` instead.
 */
function preserveCanonicalWorktreeOrder(
  incomingWorktrees: WorktreeData[],
  currentWorktrees: WorktreeData[],
): WorktreeData[] {
  const incomingById = new Map(
    incomingWorktrees.map((worktree) => [worktree.id, worktree]),
  );
  const currentIds = new Set(currentWorktrees.map((worktree) => worktree.id));
  return [
    ...currentWorktrees.map(
      (current) => incomingById.get(current.id) ?? current,
    ),
    ...incomingWorktrees.filter((incoming) => !currentIds.has(incoming.id)),
  ];
}

export async function restoreWorkspaceWorktrees(
  workspaceId: string,
  worktrees: WorktreeData[],
): Promise<void> {
  const filePath = getWorkspaceWorktreesFilePath(workspaceId);
  await withWorktreeFileLock(filePath, async () => {
    for (const worktree of worktrees) {
      recentlyRemovedWorktrees.delete(
        worktreeRemovalKey(workspaceId, worktree.id, worktree.createdAt),
      );
    }
    await writeWorkspaceWorktreesFile(workspaceId, worktrees);
  });
}

function preservePromotedWorktreePhases(
  incomingWorktrees: WorktreeData[],
  currentWorktrees: WorktreeData[],
): WorktreeData[] {
  const currentById = new Map(
    currentWorktrees.map((worktree) => [worktree.id, worktree]),
  );

  return incomingWorktrees.map((incomingWorktree) => {
    const currentWorktree = currentById.get(incomingWorktree.id);
    if (
      incomingWorktree.setupPhase !== 'git-pending' ||
      currentWorktree?.setupPhase !== 'git-ready'
    ) {
      return incomingWorktree;
    }

    const nextWorktree: WorktreeData = {
      ...incomingWorktree,
      branchName: currentWorktree.branchName,
      setupPhase: 'git-ready',
    };

    if (currentWorktree.trackedBaseBranch !== undefined) {
      nextWorktree.trackedBaseBranch = currentWorktree.trackedBaseBranch;
    }
    if (currentWorktree.trackedRepoBaseBranches !== undefined) {
      nextWorktree.trackedRepoBaseBranches =
        currentWorktree.trackedRepoBaseBranches;
    }
    if (currentWorktree.healthIssue !== undefined) {
      nextWorktree.healthIssue = currentWorktree.healthIssue;
    } else {
      delete nextWorktree.healthIssue;
    }

    return nextWorktree;
  });
}

export async function updateWorkspaceWorktrees(
  workspaceId: string,
  updater: (
    worktrees: WorktreeData[],
    read?: {
      authority: WorktreeListAuthority;
      /** The named reason an unreadable list could not be read (CAN-5531, CAN-5542). */
      unserved?: W5NamedUnreadableError;
    },
  ) => WorktreeData[] | Promise<WorktreeData[]>,
  options?: WorktreeRegistryWriteOptions,
): Promise<WorktreeData[]> {
  const filePath = getWorkspaceWorktreesFilePath(workspaceId);
  let changed = false;
  const worktrees = await withWorktreeFileLock(filePath, async () => {
    const detailed = await readWorkspaceWorktreesFileDetailed(workspaceId);
    // A partial read leaves out rows, so it cannot prove what a caller that
    // needs the whole registry (such as a group mutation) would change.
    if (
      (options?.requireAuthoritativeRead &&
        (detailed.authority === 'unreadable' ||
          detailed.authority === 'partial')) ||
      ((options?.requireExistingRead || options?.requireExistingList) &&
        detailed.authority === 'absent')
    )
      throw new WorktreeRegistryUnreadableError(readError(detailed.read));
    const rawWorktrees = detailed.worktrees;
    const currentWorktrees = filterRecentlyRemovedWorktrees(
      workspaceId,
      rawWorktrees,
    );

    const unserved = w5NamedUnreadable(readError(detailed.read));
    const updatedWorktrees = await updater(currentWorktrees, {
      authority: detailed.authority,
      ...(unserved ? { unserved } : {}),
    });
    const restorable = options?.restoreWorktrees ?? [];
    const nextWorktrees = restorable.length
      ? updatedWorktrees.filter(
          (row) =>
            restorable.some(
              (identity) =>
                identity.id === row.id && identity.createdAt === row.createdAt,
            ) ||
            !recentlyRemovedWorktrees.has(
              worktreeRemovalKey(workspaceId, row.id, row.createdAt),
            ),
        )
      : filterRecentlyRemovedWorktrees(workspaceId, updatedWorktrees);
    if (
      (options?.shouldWrite && !options.shouldWrite()) ||
      (nextWorktrees === currentWorktrees && currentWorktrees === rawWorktrees)
    ) {
      await options?.afterWrite?.();
      await afterW5Commit(() => publishSidebarItemGroupsChanged(workspaceId));
      return currentWorktrees;
    }

    const persisted = await writeWorkspaceWorktreesFile(
      workspaceId,
      nextWorktrees,
      options,
      detailed.read,
    );
    for (const row of persisted) {
      if (
        restorable.some(
          (identity) =>
            identity.id === row.id && identity.createdAt === row.createdAt,
        )
      )
        recentlyRemovedWorktrees.delete(
          worktreeRemovalKey(workspaceId, row.id, row.createdAt),
        );
    }
    changed = true;
    return persisted;
  });
  if (changed) await afterW5Commit(notifyPortalStructureChanged);
  return worktrees;
}

export async function updateWorkspaceWorktree(
  workspaceId: string,
  worktreeId: string,
  updater: (worktree: WorktreeData) => WorktreeData,
): Promise<boolean> {
  let found = false;
  let changed = false;

  await updateWorkspaceWorktrees(workspaceId, (worktrees) => {
    if (worktrees.length === 0) {
      return worktrees;
    }

    const nextWorktrees = worktrees.map((worktree) => {
      if (worktree.id !== worktreeId) {
        return worktree;
      }

      found = true;
      const updatedWorktree = updater(worktree);
      if (updatedWorktree !== worktree) {
        changed = true;
      }
      return updatedWorktree;
    });
    return found && changed ? nextWorktrees : worktrees;
  });

  return found || changed;
}

export function reorderWorktreesById(
  worktrees: WorktreeData[],
  worktreeOrder: readonly string[] | undefined,
): WorktreeData[] {
  if (!worktreeOrder || worktreeOrder.length === 0) {
    return worktrees;
  }

  const worktreeById = new Map(
    worktrees.map((worktree) => [worktree.id, worktree]),
  );
  const ordered: WorktreeData[] = [];
  const addedIds = new Set<string>();
  for (const worktreeId of worktreeOrder) {
    const worktree = worktreeById.get(worktreeId);
    if (!worktree || addedIds.has(worktreeId)) {
      continue;
    }
    ordered.push(worktree);
    addedIds.add(worktreeId);
  }
  for (const worktree of worktrees) {
    if (!addedIds.has(worktree.id)) {
      ordered.push(worktree);
    }
  }

  return ordered.every((worktree, index) => worktree === worktrees[index])
    ? worktrees
    : ordered;
}

export async function removeWorkspaceWorktrees(
  workspaceId: string,
  shouldRemove: (worktree: WorktreeData) => boolean,
  remainingWorktreeOrder?: readonly string[],
  expectedRemainingWorktreeOrder?: readonly string[],
  options?: Pick<
    WorktreeRegistryWriteOptions,
    'requireAuthoritativeRead' | 'requireExistingList' | 'markRemovedAfterWrite'
  >,
): Promise<WorktreeData[]> {
  const filePath = getWorkspaceWorktreesFilePath(workspaceId);
  return withWorktreeFileLock(filePath, async () => {
    const {
      worktrees: rawWorktrees,
      read,
      authority,
    } = await readWorkspaceWorktreesFileDetailed(workspaceId);
    if (
      (options?.requireAuthoritativeRead &&
        (authority === 'unreadable' || authority === 'partial')) ||
      (options?.requireExistingList && authority === 'absent')
    )
      throw new WorktreeRegistryUnreadableError(readError(read));
    const currentWorktrees = filterRecentlyRemovedWorktrees(
      workspaceId,
      rawWorktrees,
    );

    const removedWorktrees: WorktreeData[] = [];
    const currentRemainingWorktrees = currentWorktrees.filter((worktree) => {
      const remove = shouldRemove(worktree);
      if (remove) {
        removedWorktrees.push(worktree);
      }
      return !remove;
    });
    const currentRemainingOrder = currentRemainingWorktrees.map(
      (worktree) => worktree.id,
    );
    const canApplyRequestedOrder =
      !expectedRemainingWorktreeOrder ||
      (expectedRemainingWorktreeOrder.length === currentRemainingOrder.length &&
        expectedRemainingWorktreeOrder.every(
          (worktreeId, index) => worktreeId === currentRemainingOrder[index],
        ));
    const remainingWorktrees = canApplyRequestedOrder
      ? reorderWorktreesById(currentRemainingWorktrees, remainingWorktreeOrder)
      : currentRemainingWorktrees;

    if (removedWorktrees.length === 0) {
      if (currentWorktrees !== rawWorktrees) {
        await writeWorkspaceWorktreesFile(
          workspaceId,
          currentWorktrees,
          undefined,
          read,
        );
      }
      return [];
    }

    if (!options?.markRemovedAfterWrite) {
      for (const worktree of removedWorktrees) {
        markWorktreeRecentlyRemovedAt(
          workspaceId,
          worktree.id,
          worktree.createdAt,
        );
      }
    }

    await writeWorkspaceWorktreesFile(
      workspaceId,
      remainingWorktrees,
      undefined,
      read,
    );

    if (options?.markRemovedAfterWrite) {
      for (const worktree of removedWorktrees) {
        markWorktreeRecentlyRemovedAt(
          workspaceId,
          worktree.id,
          worktree.createdAt,
        );
      }
    }

    return removedWorktrees;
  });
}

function normalizeWorkspaceRepo(repo: unknown): WorkspaceRepoData | null {
  if (!isRecord(repo)) {
    return null;
  }

  const rawRepo: RawWorkspaceRepoData = repo;
  if (
    typeof rawRepo.id !== 'string' ||
    typeof rawRepo.name !== 'string' ||
    typeof rawRepo.repoPath !== 'string'
  ) {
    return null;
  }

  const source =
    rawRepo.source === 'local' || rawRepo.source === 'manifest'
      ? rawRepo.source
      : undefined;

  return {
    id: rawRepo.id,
    name: rawRepo.name,
    repoPath: rawRepo.repoPath,
    source,
    manifestUrl:
      typeof rawRepo.manifestUrl === 'string' ? rawRepo.manifestUrl : undefined,
    scripts: normalizeLegacyScriptFields(rawRepo),
    hooks: normalizeUnknownHookMap(rawRepo.hooks),
  };
}

function normalizeSuppressedRepoIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const repoIds = value.filter((repoId): repoId is string => {
    return typeof repoId === 'string' && repoId.length > 0;
  });

  return repoIds.length > 0 ? repoIds : undefined;
}

function normalizeWorkspaceType(
  config: RawWorkspaceConfigFile,
): WorkspaceConfigFile['type'] {
  if (
    config.type === 'single-repo' ||
    config.type === 'multi-repo' ||
    config.type === 'cowork'
  ) {
    return config.type;
  }

  if (typeof config.repoPath === 'string') {
    return 'single-repo';
  }

  return 'multi-repo';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes an untrusted `unknown` value into a {@link CoworkWorkspaceSettings}
 * object, keeping only recognized/well-typed fields. Exported so callers
 * outside this module (e.g. the standalone-chat export/import-project bundle
 * reshape) can validate a portable `cowork-workspace.json` manifest's
 * `cowork` block the same way `readWorkspaceConfig` validates the persisted
 * `workspace.json` field.
 */
export function normalizeCoworkSettings(
  value: unknown,
): CoworkWorkspaceSettings | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const settings: CoworkWorkspaceSettings = {};
  if (typeof value.createdAt === 'string') {
    settings.createdAt = value.createdAt;
  }
  if (typeof value.description === 'string') {
    settings.description = value.description;
  }
  if (typeof value.defaultModel === 'string') {
    settings.defaultModel = value.defaultModel;
  }
  if (typeof value.defaultPresetId === 'string') {
    settings.defaultPresetId = value.defaultPresetId;
  }
  if (Array.isArray(value.presets)) {
    settings.presets = value.presets.filter(isStandaloneProjectPreset);
  }
  // Absent stays absent (the composer falls back to the generic pool) while an
  // explicit `[]` is preserved as a deliberate "show no starters"; the two are
  // not collapsed. Dropping the key here silently reverted every seeded and
  // hand-edited starter set on the next read-modify-write.
  if (value.starterPrompts !== undefined) {
    const parsed = validateWorkspaceTemplateStarterPrompts(
      value.starterPrompts,
    );
    if (parsed.ok) {
      settings.starterPrompts = parsed.starterPrompts;
    }
  }
  if (isProjectStartPage(value.startPage)) {
    settings.startPage = value.startPage;
  }
  // Legacy keys (`projectPinnedContext`, `ui`, `searchIndexingEnabled`) may
  // still exist in persisted files; they are intentionally ignored here.
  if (value.archiveRetentionDays === null) {
    settings.archiveRetentionDays = null;
  } else if (
    typeof value.archiveRetentionDays === 'number' &&
    Number.isInteger(value.archiveRetentionDays) &&
    value.archiveRetentionDays >= 0 &&
    value.archiveRetentionDays <= MAX_ARCHIVE_RETENTION_DAYS
  ) {
    settings.archiveRetentionDays = value.archiveRetentionDays;
  }
  if (value.autoArchiveDays === null) {
    settings.autoArchiveDays = null;
  } else if (
    typeof value.autoArchiveDays === 'number' &&
    Number.isInteger(value.autoArchiveDays) &&
    value.autoArchiveDays >= 1 &&
    value.autoArchiveDays <= MAX_ARCHIVE_RETENTION_DAYS
  ) {
    settings.autoArchiveDays = value.autoArchiveDays;
  }
  return settings;
}

function isStandaloneProjectPreset(
  value: unknown,
): value is StandaloneProjectPreset {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isRecord(value.pluginSelections)
  );
}

function isCommandHookAction(value: unknown): value is CommandHookAction {
  return (
    isRecord(value) &&
    value.type === 'command' &&
    typeof value.command === 'string'
  );
}

function isChatHookAction(value: unknown): value is ChatHookAction {
  return (
    isRecord(value) &&
    value.type === 'chat' &&
    typeof value.prompt === 'string' &&
    value.prompt.trim().length > 0 &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.thinking === undefined ||
      (typeof value.thinking === 'string' &&
        isThinkingLevel(value.thinking))) &&
    (value.pluginSelections === undefined ||
      isChatTabPluginSelections(value.pluginSelections)) &&
    (value.allowChatConcurrency === undefined ||
      typeof value.allowChatConcurrency === 'boolean')
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, entry]) => key.trim().length > 0 && typeof entry === 'string',
    )
  );
}

function isPipelineHookAction(value: unknown): value is PipelineHookAction {
  return (
    isRecord(value) &&
    value.type === 'pipeline' &&
    (value.source === 'bundled' ||
      value.source === 'local' ||
      value.source === 'project' ||
      value.source === 'curated') &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    (value.inputs === undefined || isStringRecord(value.inputs)) &&
    (value.allowPipelineConcurrency === undefined ||
      typeof value.allowPipelineConcurrency === 'boolean')
  );
}

/** A hook action the stored read keeps. */
export function isStoredHookAction(action: unknown): action is HookAction {
  return (
    isCommandHookAction(action) ||
    isChatHookAction(action) ||
    isPipelineHookAction(action)
  );
}

function normalizeUnknownHookMap(value: unknown): HookOverrides | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const hooks: Record<string, HookAction[] | null | undefined> = {};
  for (const [triggerName, rawActions] of Object.entries(value)) {
    if (rawActions === null || rawActions === undefined) {
      hooks[triggerName] = rawActions;
      continue;
    }
    if (!Array.isArray(rawActions)) {
      continue;
    }

    hooks[triggerName] = rawActions.filter(isStoredHookAction);
  }

  return normalizeHookInputMap(hooks);
}
