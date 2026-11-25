import { isDeepStrictEqual } from 'node:util';
import type {
  SidebarItem,
  SidebarItemsFile,
  SidebarItemsSaveOptions,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { markForeignPipelineResultsSeen } from '../services/foreign-activity-sources';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import {
  admitSidebarItems,
  readAllSidebarItemsSnapshot,
  validatePreservedWorkspaceId,
  WorkspaceIndexUnreadableError,
} from './sidebar-items';
import { IdentifierValidationError, validateId } from './validation';
import {
  reorderWorkspaces,
  updateWorkspaceMetadata,
  WorkspaceMetadataRefusedError,
  type WorkspaceMetadataPatch,
} from './workspace-metadata';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
  WorktreeRegistryUnreadableError,
} from './workspace-persistence';
import { applyWorktreeListUpdate } from './workspace-record-decision-port';
import {
  diffWorktreePipelineResultsSeen,
  type WorktreePipelineResultsSeenChange,
} from './worktree-pipeline-results-seen';
import {
  updateWorktree,
  WorktreeUpdateRefusedError,
  type WorktreeMetadataPatch,
} from './worktree-update';

export interface SidebarSaveRequest {
  source: 'projects_save';
  items: SidebarItem[];
  options?: SidebarItemsSaveOptions;
  /** Host-held projection delivered to this window, never a writer option. */
  previousItems?: readonly SidebarItem[];
  /**
   * Each workspace's metadata update (D10): the IPC projection of the
   * registered `core.workspace.update`; defaults to the in-process command.
   */
  updateWorkspaceMetadata?: typeof updateWorkspaceMetadata;
  /**
   * Each worktree's patch: the IPC projection of the registered
   * `core.worktree.update` (W7b-1b); defaults to the in-process command.
   */
  updateWorktree?: typeof updateWorktree;
}

export type SidebarSaveRefusal = 'invalid-request' | 'index-unavailable';

export class SidebarSaveRefusedError extends Error {
  constructor(
    readonly reason: SidebarSaveRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'SidebarSaveRefusedError';
  }
}

function metadataPatch(
  incoming: SidebarItem,
  before: SidebarItem,
  current: SidebarItem,
): WorkspaceMetadataPatch {
  const patch: WorkspaceMetadataPatch = {};
  // Only client-editable metadata is admitted. Scripts, repositories, ownership,
  // Cowork settings and all observer/lifecycle fields already have their own
  // commands; their presence in a display projection is not an edit.
  if (incoming.name !== before.name && incoming.name !== current.name)
    patch.name = incoming.name;
  if (incoming.color !== before.color && incoming.color !== current.color)
    patch.color = incoming.color;
  if (
    incoming.collapsed !== before.collapsed &&
    incoming.collapsed !== current.collapsed
  )
    patch.collapsed = incoming.collapsed;
  if (
    Boolean(incoming.pinned) !== Boolean(before.pinned) &&
    Boolean(incoming.pinned) !== Boolean(current.pinned)
  )
    patch.pinned = incoming.pinned === true;
  if (
    (incoming.itemSortMode ?? 'manual') !== (before.itemSortMode ?? 'manual') &&
    (incoming.itemSortMode ?? 'manual') !== (current.itemSortMode ?? 'manual')
  )
    patch.itemSortMode = incoming.itemSortMode ?? 'manual';
  if (
    (incoming.alwaysShow !== false) !== (before.alwaysShow !== false) &&
    (incoming.alwaysShow !== false) !== (current.alwaysShow !== false)
  )
    patch.alwaysShow = incoming.alwaysShow !== false;
  if (
    incoming.type !== 'cowork' &&
    before.type !== 'cowork' &&
    current.type !== 'cowork'
  ) {
    if (
      !isDeepStrictEqual(
        incoming.activitySectionOrder ?? [],
        before.activitySectionOrder ?? [],
      ) &&
      !isDeepStrictEqual(
        incoming.activitySectionOrder ?? [],
        current.activitySectionOrder ?? [],
      )
    )
      patch.activitySectionOrder = incoming.activitySectionOrder ?? [];
    if (
      !isDeepStrictEqual(incoming.startPage, before.startPage) &&
      !isDeepStrictEqual(incoming.startPage, current.startPage)
    ) {
      patch.startPage =
        incoming.startPage === undefined
          ? { kind: 'inherit' }
          : { kind: 'set', startPage: incoming.startPage };
    }
  }
  return patch;
}

/**
 * A field is an edit only when the save differs from both the window's
 * delivered projection and the stored row: targeted commands and observers
 * change these fields without refreshing the delivered projection, and
 * replaying them would revert newer values (and a base would clear a merge
 * retarget's grouping parent).
 */
function worktreePatch(
  incoming: WorktreeData,
  before: WorktreeData,
  current: WorktreeData,
): WorktreeMetadataPatch {
  const patch: WorktreeMetadataPatch = {};
  const edited = <T>(read: (row: WorktreeData) => T): boolean =>
    !isDeepStrictEqual(read(incoming), read(before)) &&
    !isDeepStrictEqual(read(incoming), read(current));
  if (edited((row) => row.label)) patch.label = incoming.label ?? null;
  if (edited((row) => row.hidden === true))
    patch.hidden = incoming.hidden === true;
  if (edited((row) => row.pinned === true))
    patch.pinned = incoming.pinned === true;
  if (edited((row) => row.branchGroupingOverride))
    patch.branchGroupingOverride = incoming.branchGroupingOverride ?? null;
  if (edited((row) => row.trackedBaseBranch))
    patch.trackedBaseBranch = incoming.trackedBaseBranch ?? null;
  const bases: Record<string, string | null> = {};
  for (const repoId of Array.from(
    new Set([
      ...Object.keys(incoming.trackedRepoBaseBranches ?? {}),
      ...Object.keys(before.trackedRepoBaseBranches ?? {}),
    ]),
  )) {
    if (edited((row) => row.trackedRepoBaseBranches?.[repoId]))
      bases[repoId] = incoming.trackedRepoBaseBranches?.[repoId] ?? null;
  }
  if (Object.keys(bases).length) patch.trackedRepoBaseBranches = bases;
  return patch;
}

export interface SidebarPipelineResultsSeenRequest {
  source: 'projects_save';
  workspaceId: string;
  worktreeId: string;
  createdAt: string;
  change: WorktreePipelineResultsSeenChange;
}

/** Applies only the seen/unseen delta to the same incarnation under its lock. */
export async function recordSidebarPipelineResultsSeen(
  request: SidebarPipelineResultsSeenRequest,
): Promise<void> {
  if (request.source !== 'projects_save' || !request.createdAt)
    throw new SidebarSaveRefusedError(
      'invalid-request',
      'Invalid sidebar pipeline results change',
    );
  validateId(request.workspaceId, 'workspaceId');
  validateId(request.worktreeId, 'worktreeId');
  const { newlySeen } = await applyWorktreeListUpdate(
    request.workspaceId,
    {
      kind: 'pipelineResults.markSeen',
      worktree: { id: request.worktreeId, createdAt: request.createdAt },
      seen: request.change.seen,
      unseen: request.change.unseen,
    },
    { requireAuthoritativeRead: true, requireExistingList: true },
  );
  if (newlySeen.length)
    markForeignPipelineResultsSeen(
      request.workspaceId,
      request.worktreeId,
      newlySeen,
    );
}

/**
 * CAN-3818 part B: `projects:save` is a compatibility projection over typed
 * in-process commands, never a create, delete or whole-sidebar writer. The
 * host's last delivered projection supplies edit intent without a revision;
 * comparing it to current disk state alone cannot distinguish a stale seen
 * set from an explicit clear. Without a delivered projection only additive
 * seen changes are safe. Revisions/receipts remain CAN-3805.
 */
export async function saveSidebarItems(
  request: SidebarSaveRequest,
): Promise<SidebarItemsFile> {
  let admitted: ReadonlySet<string>;
  try {
    if (request.source !== 'projects_save')
      throw new SidebarSaveRefusedError(
        'invalid-request',
        'Unknown sidebar save source',
      );
    // Delivered legacy and duplicate-id rows are admitted but never written
    // (CAN-7357): the targeted writers address a workspace by a valid, unique
    // id. They are skipped below and reported in `preservedWorkspaceIds`.
    admitted = admitSidebarItems(
      request.items,
      request.previousItems,
    ).preserveIds;
    request.options?.preserveWorkspaceIds?.forEach(
      validatePreservedWorkspaceId,
    );
  } catch (error) {
    if (error instanceof IdentifierValidationError)
      throw new SidebarSaveRefusedError('invalid-request', error.message);
    throw error;
  }
  // Pick only D10's declared options. Private repository options are discarded.
  const preserve = new Set([
    ...(request.options?.preserveWorkspaceIds ?? []),
    ...admitted,
  ]);
  const replaceOrder = request.options?.replaceWorkspaceOrder === true;
  return serializeWorkspaceMutation(async () => {
    const snapshot = await readAllSidebarItemsSnapshot();
    if (snapshot.indexAuthority === 'unreadable')
      throw new SidebarSaveRefusedError(
        'index-unavailable',
        new WorkspaceIndexUnreadableError(snapshot.indexUnserved).message,
      );
    const currentById = new Map(
      snapshot.file.items.map((item) => [item.id, item]),
    );
    const beforeById = new Map(
      request.previousItems?.map((item) => [item.id, item]),
    );
    const incomingIds = new Set(request.items.map((item) => item.id));
    const indexedIds = new Set(snapshot.indexedWorkspaceIds);
    for (const id of Array.from(indexedIds))
      if (!incomingIds.has(id)) preserve.add(id);
    for (const incoming of request.items) {
      const current = currentById.get(incoming.id);
      if (!current || preserve.has(incoming.id)) {
        if (indexedIds.has(incoming.id)) preserve.add(incoming.id);
        continue;
      }
      const config = await readWorkspaceConfigDetailed(incoming.id);
      const list =
        incoming.type === 'cowork'
          ? undefined
          : await readWorkspaceWorktreesDetailed(incoming.id);
      if (
        config.authority !== 'ok' ||
        (list && list.authority !== 'ok') ||
        incoming.type !== current.type
      ) {
        preserve.add(incoming.id);
        continue;
      }
      try {
        const before = beforeById.get(incoming.id) ?? current;
        const patch = metadataPatch(incoming, before, current);
        if (Object.keys(patch).length)
          await (request.updateWorkspaceMetadata ?? updateWorkspaceMetadata)({
            workspaceId: incoming.id,
            patch,
            source: 'projects_save',
          });
        if (incoming.type === 'cowork' || current.type === 'cowork') continue;
        const delivered = beforeById.get(incoming.id);
        for (const worktree of incoming.worktrees) {
          const stored = list?.worktrees.find(
            (row) =>
              row.id === worktree.id && row.createdAt === worktree.createdAt,
          );
          if (!stored) continue;
          const previous =
            delivered && delivered.type !== 'cowork'
              ? delivered.worktrees.find(
                  (row) =>
                    row.id === worktree.id &&
                    row.createdAt === worktree.createdAt,
                )
              : undefined;
          if (previous) {
            const patch = worktreePatch(worktree, previous, stored);
            if (Object.keys(patch).length)
              await (request.updateWorktree ?? updateWorktree)({
                workspaceId: incoming.id,
                worktreeId: worktree.id,
                expectedCreatedAt: worktree.createdAt,
                patch,
              });
          }
          const change = diffWorktreePipelineResultsSeen(
            previous ?? stored,
            worktree,
          );
          if (!previous) change.unseen = [];
          if (change.seen.length || change.unseen.length)
            await recordSidebarPipelineResultsSeen({
              source: 'projects_save',
              workspaceId: incoming.id,
              worktreeId: worktree.id,
              createdAt: worktree.createdAt,
              change,
            });
        }
      } catch (error) {
        if (
          error instanceof WorktreeRegistryUnreadableError ||
          (error instanceof WorktreeUpdateRefusedError &&
            error.reason === 'not-found') ||
          (error instanceof WorkspaceMetadataRefusedError &&
            ['not-found', 'configuration-unavailable'].includes(error.reason))
        ) {
          preserve.add(incoming.id);
          continue;
        }
        throw error;
      }
    }
    if (replaceOrder)
      await reorderWorkspaces({
        source: 'projects_save',
        workspaceOrder: request.items
          .filter((item) => indexedIds.has(item.id) && !preserve.has(item.id))
          .map((item) => item.id),
      });
    const committed = await readAllSidebarItemsSnapshot();
    for (const id of committed.indexedWorkspaceIds)
      if (!committed.file.items.some((item) => item.id === id))
        preserve.add(id);
    const preservedWorkspaceIds = committed.indexedWorkspaceIds.filter((id) =>
      preserve.has(id),
    );
    return {
      ...committed.file,
      items: committed.file.items.filter((item) => !preserve.has(item.id)),
      ...(preservedWorkspaceIds.length ? { preservedWorkspaceIds } : {}),
    };
  });
}
