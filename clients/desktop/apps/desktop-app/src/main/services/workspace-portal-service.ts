import { projectSidebarItemGroups } from './sidebar-item-groups-service';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import { getPrMergeProgress } from './pr-merge-progress';
import {
  readAllSidebarItemsSnapshot,
  type SidebarItemsSnapshot,
} from '../lib/sidebar-items';
import { runW5ReadView } from '../lib/w5-commit-log-file-store';
import { workspaceStorageUnavailable } from '../lib/workspace-storage-availability';
import { isWorkspaceTargetRemovalPending } from '../lib/workspace-target-exclusion';
import { readPreferencesFile } from '../lib/preferences-store';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import { notificationSpaceIdFor } from '../lib/space-notification-gate';
import { getCachedWorktreeDiffStats } from './worktree-diff-stats-cache';
import {
  readProjectAvatarUrl,
  retainProjectAvatarRepoPaths,
} from './project-avatar-cache';
import {
  readProjectRepositoryIdentity,
  retainProjectRepositoryRepoPaths,
} from './project-repository-identity-cache';
import { getSplitPrRuntimeProjection } from './split-pr-runtime-projection';
import { isSplitLocked } from './split-lock-service';
import {
  applyBranchDisplayMappings,
  mergeMappingsWithBuiltins,
} from '@canopy/desktop-shared/lib/branch-display-mapping';
import {
  NEW_WORKTREE_DISPLAY_NAME,
  isDefaultWorktreeBranchName,
} from '@canopy/desktop-shared/lib/default-worktree-branch';
import {
  resolveTrackedBaseBranchFallback,
  resolveWorktreeGroupingParentId,
} from '@canopy/desktop-shared/lib/worktree-grouping';
import {
  resolveArchiveRetentionDays,
  resolveAutoArchiveDays,
} from '@canopy/desktop-shared/lib/archive-retention';
import type {
  BranchDisplayMapping,
  WorktreeStatsRequestSource,
} from '@canopy/desktop-shared/types';
import type {
  PortalEntityEnvelope,
  PortalSessionShellState,
  PortalTarget,
  SidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { performance } from 'node:perf_hooks';
import {
  getWorktreeRuntimeStatuses,
  type WorktreeRuntimeStatus,
} from './worktree-runtime-status-service';

interface WorktreeDiffStats {
  insertions: number;
  deletions: number;
}

function diffStatsMapKey(workspaceId: string, worktreeId: string): string {
  // Both ids match /^[a-z0-9][a-z0-9-]*$/, so a ':' separator is collision-free.
  return `${workspaceId}:${worktreeId}`;
}

function runtimeStatusMapKey(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}\0${worktreeId}`;
}

/**
 * Project only process-lifetime cached diff stats. A miss stays absent rather
 * than becoming a misleading zero; population is scheduled separately and is
 * never awaited by snapshot construction.
 */
function readCachedWorktreeDiffStats(
  items: SidebarItem[],
  target?: PortalTarget,
): Map<string, WorktreeDiffStats> {
  const map = new Map<string, WorktreeDiffStats>();
  for (const item of items) {
    if (item.type !== 'single-repo' && item.type !== 'multi-repo') continue;
    if (target?.workspaceLocalId && target.workspaceLocalId !== item.id) {
      continue;
    }
    for (const worktree of item.worktrees) {
      if (target?.worktreeLocalId && target.worktreeLocalId !== worktree.id) {
        continue;
      }
      const stats = getCachedWorktreeDiffStats(item.id, worktree.id);
      if (stats) {
        // Strip cache metadata (refreshedAt/generation) so only the two
        // protocol-contract integers reach the serialized diffStats payload.
        map.set(diffStatsMapKey(item.id, worktree.id), {
          insertions: stats.insertions,
          deletions: stats.deletions,
        });
      }
    }
  }

  return map;
}

function readString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Map the persisted `WorktreeData.setupPhase` (which is two-state:
 * `'git-pending' | 'git-ready'` or absent) to the portal's richer four-
 * state vocabulary. Running setup / teardown live in runtime-only state on
 * the desktop and are not reflected in `WorktreeData`; the portal field
 * therefore stays `'idle'` for ready worktrees and `'git-pending'` for
 * worktrees mid-Phase-A creation. The richer `running-setup` /
 * `running-teardown` values are emitted from runtime callers that wire the
 * Portal-side event stream later; this projection only covers the
 * persisted persisted-state subset.
 */
function projectSetupPhase(
  setupPhase: WorktreeData['setupPhase'],
): 'idle' | 'git-pending' | 'running-setup' | 'running-teardown' | undefined {
  if (setupPhase === 'git-pending') return 'git-pending';
  return undefined;
}

function projectHealthIssue(
  healthIssue: WorktreeData['healthIssue'],
): { status: 'broken'; reason?: string } | undefined {
  if (!healthIssue) return undefined;
  return { status: 'broken', reason: healthIssue.message };
}

function projectWorktreeActivityAt(
  worktree: WorktreeData,
  runtimeStatus: WorktreeRuntimeStatus | undefined,
): string | undefined {
  const durableActivityAt =
    worktree.lastTouchedAt &&
    Number.isFinite(Date.parse(worktree.lastTouchedAt))
      ? worktree.lastTouchedAt
      : worktree.createdAt;
  let latest: string | undefined;
  let latestMs: number | undefined;
  for (const timestamp of [durableActivityAt, runtimeStatus?.lastActivityAt]) {
    if (!timestamp) continue;
    const parsed = Date.parse(timestamp);
    if (
      Number.isFinite(parsed) &&
      (latestMs === undefined || parsed > latestMs)
    ) {
      latest = timestamp;
      latestMs = parsed;
    }
  }
  return latest;
}

/** The server id web and mobile use to read and change this space's
 * notification choice (CAN-3615); omitted until the space is registered. */
export function notificationSpaceProjection(scope: {
  projectId: string;
  worktreeId: string;
}): { notificationSpaceId?: string } {
  const notificationSpaceId = notificationSpaceIdFor(scope);
  return notificationSpaceId ? { notificationSpaceId } : {};
}

export function projectWorktreeSnapshot(input: {
  workspaceLocalId: string;
  worktree: WorktreeData;
  siblingWorktrees: WorktreeData[];
  projectType: 'single-repo' | 'multi-repo';
  /** Sidebar position of this worktree within its workspace. */
  order?: number;
  /**
   * Merged branch-display mappings (user preference + builtins). When set,
   * the entity label carries the same human-friendly branch name the desktop
   * sidebar renders, so the portal does not show raw branch names.
   */
  branchDisplayMappings?: BranchDisplayMapping[];
  /** Latest aggregate diff stats for this worktree, when computed. */
  diffStats?: WorktreeDiffStats;
  /** Main-process chat runtime state for this worktree. */
  runtimeStatus?: WorktreeRuntimeStatus;
}): PortalSessionShellState['worktrees'][number] {
  const worktreeRecord = input.worktree as unknown as Record<string, unknown>;
  const branch =
    readString(worktreeRecord, ['branchName', 'branch']) ?? input.worktree.id;
  const explicitLabel = readString(worktreeRecord, [
    'displayName',
    'name',
    'label',
    'title',
  ]);
  const mappedLabel =
    input.branchDisplayMappings && branch !== input.worktree.id
      ? applyBranchDisplayMappings(branch, input.branchDisplayMappings)
      : undefined;
  const label =
    explicitLabel ??
    (isDefaultWorktreeBranchName(branch, input.worktree.id)
      ? NEW_WORKTREE_DISPLAY_NAME
      : mappedLabel !== branch
        ? mappedLabel
        : undefined);
  // Resolved once and used twice: the grouping parent needs it, and clients
  // that render a `branch › base` summary need it projected (CAN-2521) —
  // otherwise the base half only appears once a PR exists.
  const trackedBaseBranch = resolveTrackedBaseBranchFallback(
    input.projectType,
    input.worktree,
  );
  const branchGroupingParentWorktreeId = resolveWorktreeGroupingParentId(
    input.worktree,
    input.siblingWorktrees,
    trackedBaseBranch,
  );

  return {
    localId: input.worktree.id,
    workspaceLocalId: input.workspaceLocalId,
    branch,
    ...(label && label !== branch && label !== input.worktree.id
      ? { label }
      : {}),
    ...(typeof input.order === 'number' ? { order: input.order } : {}),
    status: input.worktree.status,
    createdAt: input.worktree.createdAt,
    hidden: input.worktree.hidden,
    ...(input.worktree.pinned === true ? { pinned: true } : {}),
    ...(branchGroupingParentWorktreeId
      ? { branchGroupingParentWorktreeId }
      : {}),
    ...(trackedBaseBranch ? { trackedBaseBranch } : {}),
    healthIssue: projectHealthIssue(input.worktree.healthIssue),
    pausedHookKeys: input.worktree.pausedHookKeys,
    ...notificationSpaceProjection({
      projectId: input.workspaceLocalId,
      worktreeId: input.worktree.id,
    }),
    // Portal exposes membership only; preserve unknown membership by omitting
    // its badge state rather than projecting it as a negative answer.
    lastKnownPrStatus: input.worktree.lastKnownPrStatus
      ? {
          ...input.worktree.lastKnownPrStatus,
          repos: input.worktree.lastKnownPrStatus.repos.map((repo) => {
            if (!repo.status) return { ...repo, status: null };
            const { mergeQueue, ...status } = repo.status;
            return {
              ...repo,
              status: {
                ...status,
                ...(mergeQueue && typeof mergeQueue.inQueue === 'boolean'
                  ? {
                      mergeQueue: {
                        inQueue: mergeQueue.inQueue,
                        ...(mergeQueue.position !== undefined
                          ? { position: mergeQueue.position }
                          : {}),
                        ...(mergeQueue.phase !== undefined
                          ? { phase: mergeQueue.phase }
                          : {}),
                      },
                    }
                  : {}),
              },
            };
          }),
        }
      : null,
    ...getPrMergeProgress(input.workspaceLocalId, input.worktree.id),
    ...(input.diffStats ? { diffStats: input.diffStats } : {}),
    ...input.runtimeStatus,
    lastActivityAt: projectWorktreeActivityAt(
      input.worktree,
      input.runtimeStatus,
    ),
    ...getSplitPrRuntimeProjection(input.workspaceLocalId, input.worktree.id),
    splitPrLocked: isSplitLocked(input.workspaceLocalId, input.worktree.id),
    ...(projectSetupPhase(input.worktree.setupPhase)
      ? { setupPhase: projectSetupPhase(input.worktree.setupPhase) }
      : {}),
    // TODO: wire isDiscovering when discovery activity becomes observable
    // outside the renderer.
  };
}

function worktreeToPortalEntity(
  input: Parameters<typeof projectWorktreeSnapshot>[0],
  snapshot: PortalSessionShellState['worktrees'][number],
): PortalEntityEnvelope {
  const { localId, workspaceLocalId, branch, ...payload } = snapshot;
  return {
    entityType: 'worktree',
    localId,
    parentLocalId: workspaceLocalId,
    payload: {
      ...payload,
      workspaceLocalId,
      branch,
      worktreeLocalId: localId,
      branchName: branch,
      // `payload` already carries the RESOLVED `trackedBaseBranch` from
      // `projectWorktreeSnapshot` (which falls back to
      // `trackedRepoBaseBranches` for multi-repo worktrees). Re-assigning the
      // raw record field here overwrote that with `undefined` in exactly the
      // fallback case, stripping the base branch back out of the entity and
      // losing the breadcrumb for worktrees without a PR (CAN-2521).
      trackedRepoBaseBranches: input.worktree.trackedRepoBaseBranches,
    },
  };
}

interface PortalSidebarPreferences {
  branchDisplayMappings: BranchDisplayMapping[];
  hiddenWorkspaceIds: Set<string>;
  groupChildBranchesWithBase: boolean;
}

function workspaceToPortalEntity(
  workspace: PortalSessionShellState['workspaces'][number],
): PortalEntityEnvelope {
  const { localId, ...payload } = workspace;
  return {
    entityType: 'workspace',
    localId,
    payload,
  };
}

/**
 * A worktree whose removal has started is already gone from the surface that
 * started it. Every projection drops it here, before order and grouping are
 * derived, so the remaining rows stay contiguous and never nest under it.
 */
function withoutPendingRemovals(
  workspaceId: string,
  worktrees: WorktreeData[],
): WorktreeData[] {
  return worktrees.filter(
    (worktree) => !isWorkspaceTargetRemovalPending(workspaceId, worktree.id),
  );
}

function withoutPendingRemovalRows(
  items: readonly SidebarItem[],
): SidebarItem[] {
  return items.map(
    (item): SidebarItem =>
      item.type === 'cowork'
        ? item
        : {
            ...item,
            worktrees: withoutPendingRemovals(item.id, item.worktrees),
          },
  );
}

async function loadPortalSidebarPreferences(): Promise<PortalSidebarPreferences> {
  try {
    const preferences = await readPreferencesFile();
    return {
      branchDisplayMappings: mergeMappingsWithBuiltins(
        preferences.branchDisplayMappings ?? [],
      ),
      hiddenWorkspaceIds: new Set(
        preferences.worktreeFilterHiddenWorkspaceIds ?? [],
      ),
      groupChildBranchesWithBase: preferences.groupChildBranchesWithBase,
    };
  } catch {
    return {
      branchDisplayMappings: mergeMappingsWithBuiltins([]),
      hiddenWorkspaceIds: new Set(),
      groupChildBranchesWithBase: true,
    };
  }
}

export async function listWorkspacePortalEntities(
  target?: PortalTarget,
  options?: {
    /** Discovery already captured by the enclosing session snapshot. */
    sidebarSnapshot?: SidebarItemsSnapshot;
    includeDiffStats?: boolean;
    statsSource?: WorktreeStatsRequestSource;
    onTiming?: (section: 'workspaces_list' | 'worktrees', ms: number) => void;
    onWorkspace?: (
      workspace: PortalSessionShellState['workspaces'][number],
    ) => void;
    onWorktree?: (
      worktree: PortalSessionShellState['worktrees'][number],
    ) => void;
  },
): Promise<PortalEntityEnvelope[]> {
  const workspaceListStartedAt = performance.now();
  const sidebarSnapshot =
    options?.sidebarSnapshot ??
    (await runW5ReadView({ files: [], discoverWorkspaces: true }, (view) => {
      if (view.status === 'uncaptured' && view.error) throw view.error;
      return readAllSidebarItemsSnapshot();
    }));
  if (sidebarSnapshot.indexAuthority === 'unreadable')
    throw workspaceStorageUnavailable(sidebarSnapshot.indexUnserved);
  const { items: persistedItems } = sidebarSnapshot.file;
  // Decided on the persisted rows: a temporary workspace whose last worktree
  // is still being removed is not retired yet.
  const retiredWorkspaceIds = new Set(
    persistedItems.filter(isRetiredTemporaryWorkspace).map((item) => item.id),
  );
  const requestedItems = withoutPendingRemovalRows(persistedItems);
  const entities: PortalEntityEnvelope[] = [];
  const {
    branchDisplayMappings,
    hiddenWorkspaceIds,
    groupChildBranchesWithBase,
  } = await loadPortalSidebarPreferences();
  options?.onTiming?.(
    'workspaces_list',
    performance.now() - workspaceListStartedAt,
  );
  const worktreesStartedAt = performance.now();
  const diffStatsByWorktree =
    options?.includeDiffStats === false
      ? new Map<string, WorktreeDiffStats>()
      : readCachedWorktreeDiffStats(requestedItems, target);
  const runtimeStatuses = await getWorktreeRuntimeStatuses(
    requestedItems.flatMap((item) =>
      item.type === 'single-repo' || item.type === 'multi-repo'
        ? item.worktrees.map((worktree) => ({
            workspaceId: item.id,
            worktree,
          }))
        : [],
    ),
    target,
  );
  // A removal can start during the reads above. Nothing below awaits, so
  // filtering again here projects every row, its order, and its grouping from
  // one reading of the marks.
  const items = withoutPendingRemovalRows(requestedItems);

  // Every single-repo project this pass projects; an unscoped pass prunes
  // the avatar and repository identity caches to exactly these after the loop.
  const avatarRepoPaths = new Set<string>();
  const repositoryIdentityRepoPaths = new Set<string>();

  for (const item of items) {
    if (target?.workspaceLocalId && target.workspaceLocalId !== item.id) {
      continue;
    }
    // Same rule as the projects IPC: a temporary workspace with no worktree
    // and no retained container is gone from every sidebar list.
    if (retiredWorkspaceIds.has(item.id)) {
      continue;
    }

    // Grouped against the persisted registry rows, as registry writers do,
    // including a worktree whose removal is still pending.
    const persistedItem = persistedItems.find(
      (candidate) => candidate.id === item.id,
    );
    const itemGroups = await projectSidebarItemGroups(
      { workspaceLocalId: item.id },
      persistedItem && persistedItem.type !== 'cowork'
        ? {
            worktrees: persistedItem.worktrees,
            groupChildBranchesWithBase,
          }
        : undefined,
    );
    if (item.type === 'cowork') {
      const workspace: PortalSessionShellState['workspaces'][number] = {
        localId: item.id,
        ...(itemGroups === undefined ? {} : { itemGroups }),
        name: item.name,
        type: 'cowork',
        // Desktop cowork is repoless AND flat: its chats live in
        // `standaloneChats`, not `worktrees`. Cloud is the repoless-but-tree
        // case, and it is projected in the browser (REG-2819).
        layout: 'flat',
        color: item.color,
        order: item.order,
        collapsed: item.collapsed,
        itemSortMode:
          item.itemSortMode === 'last-updated' ? 'last-updated' : 'manual',
        ...(hiddenWorkspaceIds.has(item.id) ? { hidden: true } : {}),
        ...(item.alwaysShow === false ? { alwaysShow: false } : {}),
        ...(item.owner
          ? {
              owner: {
                type: 'organization' as const,
                organizationId: item.owner.organizationId,
                projectId: item.owner.projectId,
              },
            }
          : {}),
        repos: [],
        ...(item.archivedContainerCount === undefined
          ? {}
          : { archivedContainerCount: item.archivedContainerCount }),
        archiveRetentionDays: resolveArchiveRetentionDays(
          'cowork',
          item.archiveRetentionDays,
        ),
        ...(item.autoArchiveDays !== undefined
          ? {
              autoArchiveDays: resolveAutoArchiveDays(
                'cowork',
                item.archiveRetentionDays,
                item.autoArchiveDays,
              ),
            }
          : {}),
      };
      options?.onWorkspace?.(workspace);
      entities.push(workspaceToPortalEntity(workspace));
      continue;
    }

    if (item.type === 'single-repo') {
      // Cached and never awaited: a miss projects no avatar and republishes
      // the snapshot once the origin remote has been read.
      const avatarUrl = readProjectAvatarUrl(item.repoPath);
      const repositoryIdentity = readProjectRepositoryIdentity(
        item.id,
        item.repoPath,
      );
      avatarRepoPaths.add(item.repoPath);
      repositoryIdentityRepoPaths.add(item.repoPath);
      const workspace: PortalSessionShellState['workspaces'][number] = {
        localId: item.id,
        ...(itemGroups === undefined ? {} : { itemGroups }),
        name: item.name,
        rootPath: item.repoPath,
        type: 'single-repo',
        layout: 'tree',
        color: item.color,
        ...(avatarUrl === undefined ? {} : { avatarUrl }),
        ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
        order: item.order,
        collapsed: item.collapsed,
        itemSortMode:
          item.itemSortMode === 'last-updated' ? 'last-updated' : 'manual',
        ...(hiddenWorkspaceIds.has(item.id) ? { hidden: true } : {}),
        ...(item.alwaysShow === false ? { alwaysShow: false } : {}),
        ...(item.owner
          ? {
              owner: {
                type: 'organization' as const,
                organizationId: item.owner.organizationId,
                projectId: item.owner.projectId,
              },
            }
          : {}),
        repos: [],
        archiveRetentionDays: resolveArchiveRetentionDays(
          'single-repo',
          item.archiveRetentionDays,
        ),
        autoArchiveDays: resolveAutoArchiveDays(
          'single-repo',
          item.archiveRetentionDays,
          item.autoArchiveDays,
        ),
        ...(item.activitySectionOrder
          ? { activitySectionOrder: item.activitySectionOrder }
          : {}),
      };
      options?.onWorkspace?.(workspace);
      entities.push(workspaceToPortalEntity(workspace));

      for (let index = 0; index < item.worktrees.length; index += 1) {
        const worktree = item.worktrees[index];
        if (target?.worktreeLocalId && target.worktreeLocalId !== worktree.id) {
          continue;
        }
        const worktreeInput = {
          workspaceLocalId: item.id,
          worktree,
          siblingWorktrees: item.worktrees,
          projectType: item.type,
          order: index,
          branchDisplayMappings,
          diffStats: diffStatsByWorktree.get(
            diffStatsMapKey(item.id, worktree.id),
          ),
          runtimeStatus: runtimeStatuses.get(
            runtimeStatusMapKey(item.id, worktree.id),
          ),
        };
        const worktreeSnapshot = projectWorktreeSnapshot(worktreeInput);
        options?.onWorktree?.(worktreeSnapshot);
        entities.push(worktreeToPortalEntity(worktreeInput, worktreeSnapshot));
      }
      continue;
    }

    if (item.type === 'multi-repo') {
      const repositoryPath = item.sourceRepoPath;
      const repositoryIdentity = repositoryPath
        ? readProjectRepositoryIdentity(item.id, repositoryPath)
        : undefined;
      if (repositoryPath) repositoryIdentityRepoPaths.add(repositoryPath);
      const workspace: PortalSessionShellState['workspaces'][number] = {
        localId: item.id,
        ...(itemGroups === undefined ? {} : { itemGroups }),
        name: item.name,
        rootPath:
          'rootPath' in item && typeof item.rootPath === 'string'
            ? item.rootPath
            : undefined,
        type: 'multi-repo',
        layout: 'tree',
        color: item.color,
        ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
        order: item.order,
        collapsed: item.collapsed,
        itemSortMode:
          item.itemSortMode === 'last-updated' ? 'last-updated' : 'manual',
        ...(item.temporary === true ? { temporary: true } : {}),
        ...(hiddenWorkspaceIds.has(item.id) ? { hidden: true } : {}),
        ...(item.alwaysShow === false ? { alwaysShow: false } : {}),
        ...(item.owner
          ? {
              owner: {
                type: 'organization' as const,
                organizationId: item.owner.organizationId,
                projectId: item.owner.projectId,
              },
            }
          : {}),
        repos: item.repos.map((repo) => ({
          id: repo.id,
          name: repo.name,
          repoPath: repo.repoPath,
        })),
        archiveRetentionDays: resolveArchiveRetentionDays(
          'multi-repo',
          item.archiveRetentionDays,
        ),
        autoArchiveDays: resolveAutoArchiveDays(
          'multi-repo',
          item.archiveRetentionDays,
          item.autoArchiveDays,
        ),
        ...(item.activitySectionOrder
          ? { activitySectionOrder: item.activitySectionOrder }
          : {}),
      };
      options?.onWorkspace?.(workspace);
      entities.push(workspaceToPortalEntity(workspace));

      for (let index = 0; index < item.worktrees.length; index += 1) {
        const worktree = item.worktrees[index];
        if (target?.worktreeLocalId && target.worktreeLocalId !== worktree.id) {
          continue;
        }
        const worktreeInput = {
          workspaceLocalId: item.id,
          worktree,
          siblingWorktrees: item.worktrees,
          projectType: item.type,
          order: index,
          branchDisplayMappings,
          diffStats: diffStatsByWorktree.get(
            diffStatsMapKey(item.id, worktree.id),
          ),
          runtimeStatus: runtimeStatuses.get(
            runtimeStatusMapKey(item.id, worktree.id),
          ),
        };
        const worktreeSnapshot = projectWorktreeSnapshot(worktreeInput);
        options?.onWorktree?.(worktreeSnapshot);
        entities.push(worktreeToPortalEntity(worktreeInput, worktreeSnapshot));
      }
    }
  }

  // Only a pass over every workspace names every live project; a scoped one
  // would prune the projects it skipped.
  if (!target?.workspaceLocalId) {
    retainProjectAvatarRepoPaths(avatarRepoPaths);
    retainProjectRepositoryRepoPaths(repositoryIdentityRepoPaths);
  }
  options?.onTiming?.('worktrees', performance.now() - worktreesStartedAt);
  return entities;
}

export async function getWorkspacePortalWorktreeEntity(
  workspaceId: string,
  worktreeId: string,
  runtimeStatus: WorktreeRuntimeStatus,
): Promise<PortalEntityEnvelope | null> {
  if (isWorkspaceTargetRemovalPending(workspaceId, worktreeId)) return null;
  const [persistedWorktrees, preferences] = await Promise.all([
    readWorkspaceWorktrees(workspaceId),
    loadPortalSidebarPreferences(),
  ]);
  // Re-checked after the read: a removal can start while it is in flight.
  // Order and grouping come from the same filtered list the snapshot uses.
  const worktrees = withoutPendingRemovals(workspaceId, persistedWorktrees);
  const order = worktrees.findIndex((worktree) => worktree.id === worktreeId);
  if (order < 0) return null;
  const worktree = worktrees[order];
  if (!worktree) return null;

  const cachedDiffStats = getCachedWorktreeDiffStats(workspaceId, worktreeId);
  const diffStats = cachedDiffStats
    ? {
        insertions: cachedDiffStats.insertions,
        deletions: cachedDiffStats.deletions,
      }
    : undefined;

  const worktreeInput: Parameters<typeof projectWorktreeSnapshot>[0] = {
    workspaceLocalId: workspaceId,
    worktree,
    siblingWorktrees: worktrees,
    projectType: worktrees.some(
      (candidate) => candidate.trackedRepoBaseBranches,
    )
      ? 'multi-repo'
      : 'single-repo',
    order,
    branchDisplayMappings: preferences.branchDisplayMappings,
    diffStats,
    runtimeStatus,
  };
  return worktreeToPortalEntity(
    worktreeInput,
    projectWorktreeSnapshot(worktreeInput),
  );
}

export async function getWorkspacePortalWorktreeRuntimeStatus(
  workspaceId: string,
  worktreeId: string,
): Promise<WorktreeRuntimeStatus> {
  const worktrees = await readWorkspaceWorktrees(workspaceId);
  const worktree = worktrees.find((candidate) => candidate.id === worktreeId);
  if (!worktree) return {};
  const statuses = await getWorktreeRuntimeStatuses(
    [{ workspaceId, worktree }],
    { workspaceLocalId: workspaceId, worktreeLocalId: worktreeId },
  );
  return statuses.get(runtimeStatusMapKey(workspaceId, worktreeId)) ?? {};
}
