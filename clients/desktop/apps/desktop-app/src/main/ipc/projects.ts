import { sourceChangeGit } from '../canopy-runtime/worker-git-worktree-adapter';
import {
  W5_PROJECTION_ONLY_READ,
  withW5ProjectionOnlyRead,
} from '../lib/w5-fallback-read';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { projectedSourceCompositionCommands } from '../canopy-runtime/source-composition-dispatch';
import {
  IPC_CHANNELS,
  type DeleteProjectRequest,
  type ProjectApplySourceChangesRequest,
  type ProjectApplySourceChangesResponse,
  type SaveDefaultPluginsRequest,
  type SidebarItem,
  type SidebarItemsFile,
  type SidebarItemsSaveOptions,
  type ReorderWorkspacesRequest,
  type SetTrackedBaseBranchRequest,
  type UpdateWorkspaceMetadataRequest,
} from '@canopy/desktop-shared/types';
import {
  hasVisibleWorkspaceContent,
  isRetiredTemporaryWorkspace,
} from '@canopy/desktop-shared/lib/workspace-visibility';
import { applySourceChanges } from '../lib/workspace-source-changes';
import { assertStartPageFeatureEnabled } from '../lib/start-page-feature-flag';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { sendToWindow } from '../lib/window-send';
import { reconcileGitPendingWorktrees } from '../lib/worktree-boot-recovery';
import {
  admitSidebarItems,
  readAllSidebarItems,
  resolveWorktreeEffectiveFor,
  validatePreservedWorkspaceId,
} from '../lib/sidebar-items';
import { ProjectsReloadRequiredError } from '../lib/sidebar-save-errors';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import { recordMetadataWork } from '@canopy/desktop-shared/node/work-counters';
import { saveSidebarItems } from '../lib/sidebar-save-adapter';
import {
  projectedWorkspaceGuardedCommands,
  type ProjectedWorkspaceGuardedCommands,
} from '../canopy-runtime/workspace-guarded-dispatch';
import { readPreferencesFile } from '../lib/preferences-store';
import { getSidebarItemsPreserveWorkspaceIds } from '../lib/sidebar-items-preservation';
import { syncTrackedWorktrees as syncTrackedGitHubWorktrees } from '../lib/github-poller';
import { repairExistingWorkspaceRootWorktrees } from '../lib/workspace-source-control';
import {
  publishWorktreeLifecycleChange,
  worktreeLifecycleSequence,
} from '../lib/worktree-lifecycle-signals';
import {
  offerLoadedProjection,
  type LoadedProjectionOffer,
} from '../lib/worktree-branch-watcher';
import { syncWorktreesFileWatchers } from '../lib/worktrees-file-watcher';
import { reconcileExternalWorktreeSnapshot } from '../lib/worktree-registry-reconciliation';
import {
  startPolling,
  syncTrackedWorkspaces,
} from '../lib/workspace-reference-repo-poller';
import { recordWorkspaceCrudTelemetry } from '../lib/desktop-telemetry';
import {
  startCodeGraphBaseManager,
  syncCodeGraphBaseRepositories,
} from '../lib/code-graph-base-manager';
import { backfillMissingWorktreeChatBadges } from '../lib/chat-badge-sync';
import { registerIpcHandler } from './register';
import {
  projectedWorkspaceMetadataCommands,
  type ProjectedWorkspaceMetadataCommands,
} from '../canopy-runtime/workspace-metadata-dispatch';
import { projectedWorkspaceLifecycleCommands } from '../canopy-runtime/workspace-lifecycle-dispatch';
import { recordRealisticStartupPerformanceEvent } from '../lib/realistic-startup-performance';
import { WorktreeUpdateRefusedError } from '../lib/worktree-update';
import { serializeChatProjectOperation } from '../lib/chat-project-operation-queue';
import { deleteWorkspace } from '../lib/workspace-deletion';
import { saveDefaultPluginsAndVisibility } from '../lib/workspace-default-plugins-save';
import {
  detachedWorkCallback,
  settleAll,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function isVisibleSidebarItem(item: SidebarItem): boolean {
  return !isRetiredTemporaryWorkspace(item);
}

function getFailedWorkspaceIds(
  sidebarItems: Pick<SidebarItemsFile, 'warnings' | 'preservedWorkspaceIds'>,
): ReadonlySet<string> {
  return new Set(getSidebarItemsPreserveWorkspaceIds(sidebarItems));
}

function rootRepairWorkspaceIds(items: readonly SidebarItem[]): string[] {
  return items.flatMap((item) =>
    item.type === 'multi-repo' && item.sourceRepoPath ? [item.id] : [],
  );
}

interface RootRepairBatch {
  workspaceIds: readonly string[];
  /** The newest load's read; older batches it replaced publish none. */
  offer: LoadedProjectionOffer;
  settled: Array<() => void>;
}

/**
 * Repairs source-backed workspace roots off the `projects:load` response
 * path, then publishes `projects-loaded`, so the branch observer syncs only
 * after repair, as when loads awaited it. Single-flight: a load during a
 * batch replaces the queued one, and each batch publishes when it settles.
 * The returned promise settles once a batch at least as new has published.
 */
function createRootRepairQueue(): (
  workspaceIds: readonly string[],
  offer: LoadedProjectionOffer,
) => Promise<void> {
  let queued: RootRepairBatch | undefined;
  let running = false;
  const publishLoaded = (offer: LoadedProjectionOffer): void => {
    offerLoadedProjection(offer);
    publishWorktreeLifecycleChange('projects-loaded');
  };
  const drain = async (): Promise<void> => {
    try {
      for (let batch = queued; batch; batch = queued) {
        queued = undefined;
        try {
          await settleAll(
            batch.workspaceIds.map((workspaceId) =>
              repairExistingWorkspaceRootWorktrees(workspaceId).catch(() => {}),
            ),
          );
          publishLoaded(batch.offer);
        } finally {
          batch.settled.forEach((settle) => settle());
        }
      }
    } finally {
      running = false;
    }
  };
  return (workspaceIds, offer) =>
    new Promise<void>((resolve) => {
      if (!running && workspaceIds.length === 0) {
        publishLoaded(offer);
        resolve();
        return;
      }
      queued = {
        workspaceIds,
        offer,
        settled: [...(queued?.settled ?? []), resolve],
      };
      if (running) return;
      running = true;
      // The drain serves later loads too, so it holds no load's admission.
      detachedWorkCallback(drain)();
    });
}

const FIRST_PROJECTS_LOAD_MAIN_OBSERVER_KEY =
  '__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__';

type FirstProjectsLoadMainObserver = (
  event: IpcMainInvokeEvent | undefined,
  stage: string,
  details: Record<string, unknown>,
) => unknown;

const FIRST_PROJECTS_LOAD_ERROR_CODES = [
  'ENOENT',
  'EACCES',
  'EPERM',
  'EIO',
  'ETIMEDOUT',
  'ECONNRESET',
  'ERR_IPC_CHANNEL_CLOSED',
] as const;
type FirstProjectsLoadErrorCode =
  (typeof FIRST_PROJECTS_LOAD_ERROR_CODES)[number];

function isFirstProjectsLoadErrorCode(
  value: unknown,
): value is FirstProjectsLoadErrorCode {
  return (
    typeof value === 'string' &&
    FIRST_PROJECTS_LOAD_ERROR_CODES.some((candidate) => candidate === value)
  );
}

function isFirstProjectsLoadMainObserver(
  value: unknown,
): value is FirstProjectsLoadMainObserver {
  return typeof value === 'function';
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

let projectsLoadRequestOrdinal = 0;

function getFirstProjectsLoadMainObserver():
  | FirstProjectsLoadMainObserver
  | undefined {
  if (!__CANOPY_E2E__) return undefined;
  try {
    const observer: unknown = Reflect.get(
      globalThis,
      FIRST_PROJECTS_LOAD_MAIN_OBSERVER_KEY,
    );
    return isFirstProjectsLoadMainObserver(observer) ? observer : undefined;
  } catch {
    return undefined;
  }
}

function classifyFirstProjectsLoadError(error: unknown): {
  errorKind:
    | 'error'
    | 'type-error'
    | 'range-error'
    | 'syntax-error'
    | 'non-error'
    | 'unknown';
  errorCode?:
    | 'ENOENT'
    | 'EACCES'
    | 'EPERM'
    | 'EIO'
    | 'ETIMEDOUT'
    | 'ECONNRESET'
    | 'ERR_IPC_CHANNEL_CLOSED'
    | 'unknown';
} {
  try {
    const errorKind =
      error instanceof TypeError
        ? 'type-error'
        : error instanceof RangeError
          ? 'range-error'
          : error instanceof SyntaxError
            ? 'syntax-error'
            : error instanceof Error
              ? 'error'
              : error === null ||
                  [
                    'string',
                    'number',
                    'boolean',
                    'bigint',
                    'undefined',
                  ].includes(typeof error)
                ? 'non-error'
                : 'unknown';
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
      return { errorKind };
    }
    const code: unknown = 'code' in error ? error.code : undefined;
    return {
      errorKind,
      ...(typeof code === 'string'
        ? {
            errorCode: isFirstProjectsLoadErrorCode(code) ? code : 'unknown',
          }
        : {}),
    };
  } catch {
    return { errorKind: 'unknown' };
  }
}

function projectFirstProjectsLoadItems(
  items: readonly SidebarItem[],
  warnings: SidebarItemsFile['warnings'],
): Record<string, unknown> {
  const workspaceIds: string[] = [];
  const worktreeIds: string[] = [];
  let invalidIdCount = 0;
  let workspaceInspectedCount = 0;
  let worktreeInspectedCount = 0;
  let worktreeOmittedCount = 0;
  let worktreeOmittedCountAvailable = true;
  const safeId = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length <= 128 &&
    /^[a-z0-9._-]+$/i.test(value);
  try {
    for (
      let index = 0;
      index < items.length &&
      workspaceIds.length < 8 &&
      workspaceInspectedCount < 16;
      index++
    ) {
      workspaceInspectedCount++;
      let item: SidebarItem | undefined;
      try {
        item = items[index];
      } catch {
        invalidIdCount++;
        continue;
      }
      if (!item) continue;
      if (safeId(item.id)) workspaceIds.push(item.id);
      else invalidIdCount++;
      const worktrees = 'worktrees' in item ? item.worktrees : [];
      const inspectedBeforeItem = worktreeInspectedCount;
      for (
        let worktreeIndex = 0;
        worktreeIndex < worktrees.length &&
        worktreeIds.length < 32 &&
        worktreeInspectedCount < 64;
        worktreeIndex++
      ) {
        worktreeInspectedCount++;
        let id: unknown;
        try {
          id = worktrees[worktreeIndex]?.id;
        } catch {
          invalidIdCount++;
          continue;
        }
        if (safeId(id)) worktreeIds.push(id);
        else invalidIdCount++;
      }
      worktreeOmittedCount += Math.max(
        0,
        worktrees.length - (worktreeInspectedCount - inspectedBeforeItem),
      );
    }
  } catch {
    invalidIdCount++;
    worktreeOmittedCountAvailable = false;
  }
  const workspaceOmittedCount = Math.max(
    0,
    items.length - workspaceInspectedCount,
  );
  if (workspaceOmittedCount > 0) worktreeOmittedCountAvailable = false;
  const warningIdentities: Array<Record<string, string>> = [];
  let warningInspectedCount = 0;
  let remainingWarningWorkspaceIds = Math.max(0, 8 - workspaceIds.length);
  try {
    for (
      let index = 0;
      index < (warnings?.length ?? 0) &&
      warningIdentities.length < 8 &&
      warningInspectedCount < 16;
      index++
    ) {
      warningInspectedCount++;
      const warning = warnings?.[index];
      if (!warning) continue;
      const identity: Record<string, string> = {};
      if (remainingWarningWorkspaceIds > 0 && safeId(warning.workspaceId)) {
        identity.workspaceId = warning.workspaceId;
        remainingWarningWorkspaceIds--;
      } else if (!safeId(warning.workspaceId)) invalidIdCount++;
      if (
        warning.code === 'invalid-canopy-json' ||
        warning.code === 'workspace-load-failed'
      )
        identity.code = warning.code;
      warningIdentities.push(identity);
    }
  } catch {
    invalidIdCount++;
  }
  const warningCount = warnings?.length ?? 0;
  return {
    itemCount: items.length,
    workspaceIds,
    worktreeIds,
    warningCount,
    warningIdentities,
    invalidIdCount,
    workspaceInspectedCount,
    workspaceOmittedCount,
    worktreeInspectedCount,
    ...(worktreeOmittedCountAvailable ? { worktreeOmittedCount } : {}),
    worktreeOmittedCountAvailable,
    warningInspectedCount,
    warningOmittedCount: Math.max(0, warningCount - warningInspectedCount),
    truncated:
      workspaceOmittedCount > 0 ||
      worktreeOmittedCount > 0 ||
      warningCount > warningInspectedCount ||
      worktreeIds.length === 32,
    worktreeCountAvailable: false,
  };
}

function observeFirstProjectsLoadMain(
  observer: FirstProjectsLoadMainObserver | undefined,
  event: IpcMainInvokeEvent | undefined,
  stage: string,
  details: () => Record<string, unknown>,
): void {
  if (!observer || getFirstProjectsLoadMainObserver() !== observer) return;
  try {
    const result = observer(event, stage, details());
    if (isPromiseLike(result)) {
      trackDetachedWork(() => Promise.resolve(result).catch(() => undefined));
    }
  } catch {
    /* E2E observation must never enter the product error path. */
  }
}

/**
 * CAN-6933: local sidebar reads no longer resolve each worktree's own scripts
 * and hooks. A remote-control session still receives them in today's shape,
 * because a paired mobile build falls back to the project's scripts when a
 * worktree has no entry (CAN-6962 moves it to the per-worktree read).
 */
function withRemoteWorktreeEffective(
  load: (event: IpcMainInvokeEvent) => Promise<SidebarItemsFile>,
): (event: IpcMainInvokeEvent) => Promise<SidebarItemsFile> {
  return async (event) => {
    const result = await load(event);
    if (!event?.sender || resolveRemoteBridgeSender(event.sender) === null)
      return result;
    recordMetadataWork('projectsLoad.remote');
    const items = await settleAll(
      result.items.map(async (item) =>
        item.type === 'cowork'
          ? item
          : {
              ...item,
              worktreeEffective: await resolveWorktreeEffectiveFor(
                item.id,
                'remote.projects-load',
              ).catch(() => undefined),
            },
      ),
    );
    return { ...result, items };
  };
}

export function registerProjectHandlers(
  getWindow: () => BrowserWindow | null,
  dispatcher: DesktopCanopyDispatcher,
  resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor,
): void {
  const deliveredSidebarItems = new WeakMap<
    IpcMainInvokeEvent['sender'],
    readonly SidebarItem[]
  >();
  const projectsLoadGenerations = new WeakMap<
    IpcMainInvokeEvent['sender'],
    number
  >();
  const needsReload = new WeakSet<IpcMainInvokeEvent['sender']>();
  const refuseUntilReloaded = (event: IpcMainInvokeEvent): void => {
    if (event?.sender && needsReload.has(event.sender))
      throw new ProjectsReloadRequiredError();
  };
  const markNeedsReload = (
    event: IpcMainInvokeEvent,
    generation: number,
  ): void => {
    if (
      !event?.sender ||
      projectsLoadGenerations.get(event.sender) !== generation
    )
      return;
    needsReload.add(event.sender);
    deliveredSidebarItems.delete(event.sender);
  };
  startPolling(getWindow, dispatcher);
  recordRealisticStartupPerformanceEvent('startup:github-poller:started');
  startCodeGraphBaseManager();
  let didReconcileGitPendingWorktrees = false;
  let didScheduleChatBadgeBackfill = false;
  let startupRecoveryWork: Promise<void> = Promise.resolve();
  let startupBadgeWork: Promise<void> = Promise.resolve();
  let startupRecoverySequence = getElectronDaemonHealth().getRecoverySequence();
  const repairRootsThenPublish = createRootRepairQueue();
  const reconcileExternalSnapshot = (
    workspaceId: string,
    worktrees: Parameters<typeof reconcileExternalWorktreeSnapshot>[1],
  ): void => {
    // The async body handles cleanup errors, but a synchronous throw before
    // its first await would otherwise become an unhandled rejection.
    trackDetachedWork(() =>
      reconcileExternalWorktreeSnapshot(workspaceId, worktrees).catch(() => {
        // Reconciliation is retried on the next watcher event; never crash main.
      }),
    );
  };

  registerIpcHandler(
    IPC_CHANNELS.projectsLoad,
    withRemoteWorktreeEffective(async (event: IpcMainInvokeEvent) => {
      const generation = event?.sender
        ? (projectsLoadGenerations.get(event.sender) ?? 0) + 1
        : 0;
      if (event?.sender) projectsLoadGenerations.set(event.sender, generation);
      const recoverySequence = getElectronDaemonHealth().getRecoverySequence();
      if (recoverySequence !== startupRecoverySequence) {
        startupRecoverySequence = recoverySequence;
        didReconcileGitPendingWorktrees = false;
        didScheduleChatBadgeBackfill = false;
      }
      const observer = __CANOPY_E2E__
        ? getFirstProjectsLoadMainObserver()
        : undefined;
      const requestOrdinal = observer
        ? ++projectsLoadRequestOrdinal
        : undefined;
      if (__CANOPY_E2E__)
        observeFirstProjectsLoadMain(
          observer,
          event,
          'projects-load-main-entered',
          () => ({
            requestOrdinal,
            reconciliationAlreadyAttempted: didReconcileGitPendingWorktrees,
          }),
        );
      try {
        // Authenticated once, before any await: `senderFrame` is null once the
        // page navigates, so a late re-check refuses a request sent while trusted.
        const caller = resolveCaller(event);
        const sequence = worktreeLifecycleSequence();
        const { legacyResult: refreshed, legacyAuthority } =
          await withW5ProjectionOnlyRead(W5_PROJECTION_ONLY_READ, () =>
            dispatcher.queryWorkspaceListForLegacyIpc({}, { caller }),
          );
        // A stale projection may only be delivered, never reconciled or remembered.
        if (refreshed.stale) {
          markNeedsReload(event, generation);
          return {
            ...refreshed,
            items: refreshed.items.filter(isVisibleSidebarItem),
          };
        }
        const refreshedItems = refreshed.items.filter(isVisibleSidebarItem);
        const refreshedFailedWorkspaceIds = getFailedWorkspaceIds(refreshed);
        syncTrackedGitHubWorktrees(refreshedItems, refreshedFailedWorkspaceIds);
        syncTrackedWorkspaces(refreshedItems, refreshedFailedWorkspaceIds);
        syncCodeGraphBaseRepositories(
          refreshedItems,
          refreshedFailedWorkspaceIds,
        );
        // Repair writes only checkouts, which the projection does not read.
        // Main's branch observer lists from this read after repair unless a
        // list write or membership signal landed after the read began.
        const rootsRepaired = repairRootsThenPublish(
          rootRepairWorkspaceIds(refreshedItems),
          {
            sequence,
            file: refreshed,
            ...(legacyAuthority ? { authority: legacyAuthority } : {}),
          },
        );
        if (!didReconcileGitPendingWorktrees) {
          didReconcileGitPendingWorktrees = true;
          // Recovery may copy an interrupted archive for minutes. It owns its
          // existing lifecycle locks and publishes changes when it finishes;
          // loading the project inventory must not wait for that maintenance.
          const previous = startupRecoveryWork;
          trackDetachedWork(() => {
            // A recovery reload must not overlap an archive still being copied
            // or the root repair this load started.
            startupRecoveryWork = previous
              .then(() => rootsRepaired)
              .then(() => reconcileGitPendingWorktrees(getWindow))
              .catch((error: unknown): void => {
                const message =
                  error instanceof Error ? error.message : String(error);
                process.stderr.write(
                  `[worktree-boot-recovery] Startup recovery failed: ${message}\n`,
                );
              });
            return startupRecoveryWork;
          });
        }
        // Watcher events go to the main window, so only the rows it applies
        // (its current load, not a remote bridge's) are known to it.
        const mainWindow = getWindow();
        const deliveredToWindow =
          event?.sender !== undefined &&
          mainWindow !== null &&
          !mainWindow.isDestroyed() &&
          mainWindow.webContents === event.sender &&
          projectsLoadGenerations.get(event.sender) === generation;
        syncWorktreesFileWatchers(
          refreshedItems,
          getWindow,
          refreshedFailedWorkspaceIds,
          reconcileExternalSnapshot,
          deliveredToWindow,
        );
        if (!didScheduleChatBadgeBackfill) {
          didScheduleChatBadgeBackfill = true;
          // Background trickle deriving chatBadges for legacy worktrees so the
          // renderer can skip eager transcript hydration for them next launch.
          const previous = startupBadgeWork;
          const backfill = (): Promise<void> =>
            backfillMissingWorktreeChatBadges(refreshedItems);
          trackDetachedWork(() => {
            startupBadgeWork = previous.then(backfill, backfill);
            return startupBadgeWork;
          });
        }
        const response = {
          ...refreshed,
          items: refreshedItems,
        };
        if (__CANOPY_E2E__)
          observeFirstProjectsLoadMain(
            observer,
            event,
            'projects-load-main-resolved',
            () => ({
              requestOrdinal,
              ...projectFirstProjectsLoadItems(
                refreshedItems,
                refreshed.warnings,
              ),
            }),
          );
        // The renderer discards superseded loads; their edit baselines must too.
        if (
          event?.sender &&
          projectsLoadGenerations.get(event.sender) === generation
        ) {
          deliveredSidebarItems.set(event.sender, response.items);
          needsReload.delete(event.sender);
        }
        return response;
      } catch (error) {
        const legacyError =
          error instanceof CanopyOperationError &&
          error.runtimeCause instanceof Error
            ? error.runtimeCause
            : error;
        if (__CANOPY_E2E__)
          observeFirstProjectsLoadMain(
            observer,
            event,
            'projects-load-main-rejected',
            () => ({
              requestOrdinal,
              ...classifyFirstProjectsLoadError(legacyError),
            }),
          );
        throw legacyError;
      }
    }),
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeEffectiveGet,
    async (
      _event: IpcMainInvokeEvent,
      request: { projectId?: unknown; worktreeIds?: unknown },
    ) => {
      const projectId = request?.projectId;
      validateId(projectId, 'projectId');
      const requested = request?.worktreeIds;
      let worktreeIds: string[] | undefined;
      if (Array.isArray(requested)) {
        worktreeIds = [];
        for (const id of requested) {
          validateId(id, 'worktreeId');
          worktreeIds.push(id);
        }
      }
      return resolveWorktreeEffectiveFor(
        projectId,
        'worktree.effective',
        worktreeIds,
      );
    },
  );

  const metadataCommands = (
    event: IpcMainInvokeEvent,
  ): ProjectedWorkspaceMetadataCommands =>
    projectedWorkspaceMetadataCommands({
      dispatcher,
      caller: resolveCaller(event),
    });
  const guardedCommands = (
    event: IpcMainInvokeEvent,
  ): ProjectedWorkspaceGuardedCommands =>
    projectedWorkspaceGuardedCommands({
      dispatcher,
      caller: resolveCaller(event),
    });

  registerIpcHandler(
    IPC_CHANNELS.workspaceUpdateMetadata,
    async (event, request: UpdateWorkspaceMetadataRequest): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      await metadataCommands(event).updateMetadata({
        workspaceId: request.workspaceId,
        patch: {
          name: request.name,
          color: request.color,
          pinned: request.pinned,
          itemSortMode: request.itemSortMode,
        },
        source: 'desktop_canopy_client',
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceReorder,
    async (event, request: ReorderWorkspacesRequest): Promise<void> => {
      validateId(request.activeWorkspaceId, 'activeWorkspaceId');
      validateId(request.overWorkspaceId, 'overWorkspaceId');
      const [{ items }, preferences] = await settleAll([
        readAllSidebarItems(),
        readPreferencesFile(),
      ]);
      const hiddenWorkspaceIds = new Set(
        preferences.worktreeFilterHiddenWorkspaceIds ?? [],
      );
      const visibleWorkspaceIds = items
        .filter((item) => {
          if (hiddenWorkspaceIds.has(item.id)) return false;
          if (item.alwaysShow !== false) return true;
          return hasVisibleWorkspaceContent(item);
        })
        .map((item) => item.id);
      await metadataCommands(event).reorder({
        visibleWorkspaceIds,
        activeWorkspaceId: request.activeWorkspaceId,
        overWorkspaceId: request.overWorkspaceId,
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeSetTrackedBaseBranch,
    async (event, request: SetTrackedBaseBranchRequest): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.worktreeId, 'worktreeId');
      // Source-backed workspaces address the workspace root through the
      // synthetic `WORKSPACE_ROOT_REPO_ID`, which is not a plain slug.
      validateOptionalRepoId(request.repoId, 'repoId');
      // `null` is a deliberate clear, not a missing value: the renderer's
      // in-memory clear has to reach disk through this channel too, because a
      // wholesale `saveProjects()` can no longer carry the removal past
      // `preserveMainOwnedWorktreeMetadata`. The `core.worktree.update`
      // boundary persists a scalar clear as `null`, drops a cleared
      // repository's entry, and clears the merge-retarget grouping parent.
      const baseBranch = request.baseBranch;
      try {
        await guardedCommands(event).updateWorktree({
          workspaceId: request.workspaceId,
          worktreeId: request.worktreeId,
          patch:
            request.repoId === undefined
              ? { trackedBaseBranch: baseBranch }
              : { trackedRepoBaseBranches: { [request.repoId]: baseBranch } },
        });
      } catch (error) {
        if (
          error instanceof WorktreeUpdateRefusedError &&
          error.reason === 'not-found'
        ) {
          throw new Error(
            `Worktree "${request.worktreeId}" was not found in project "${request.workspaceId}".`,
          );
        }
        throw error;
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.projectsSave,
    async (event, items: SidebarItem[], options?: SidebarItemsSaveOptions) => {
      refuseUntilReloaded(event);
      // Legacy and duplicate rows this window was delivered are admitted and
      // preserved, so they never block saving the other projects (CAN-7357).
      // An early refusal only: the adapter's check inside the queue, against
      // the same delivered snapshot, decides what is preserved.
      admitSidebarItems(
        items,
        event?.sender ? deliveredSidebarItems.get(event.sender) : undefined,
      );
      options?.preserveWorkspaceIds?.forEach(validatePreservedWorkspaceId);
      // Resolved before any write, so an untrusted sender changes nothing.
      const commands = metadataCommands(event);
      const worktreeCommands = guardedCommands(event);
      return serializeChatProjectOperation(async () => {
        refuseUntilReloaded(event);
        const previousItems = event?.sender
          ? deliveredSidebarItems.get(event.sender)
          : undefined;
        const result = await saveSidebarItems({
          source: 'projects_save',
          items,
          options,
          previousItems,
          updateWorkspaceMetadata: (update) => commands.updateMetadata(update),
          updateWorktree: (update) => worktreeCommands.updateWorktree(update),
        });
        const preservedWorkspaceIds = getFailedWorkspaceIds(result);
        // The store ignores the save response and retains its submitted view.
        // Keep that view as the next edit baseline, not the newer disk
        // projection, except for workspaces this save preserved: their edits
        // were not applied, so they keep the baseline they were edited from.
        if (event?.sender) {
          // Every delivered row per id, so a duplicate-id row stays delivered
          // as often as it was and stays preserved on the next save.
          const previousById = new Map<string, SidebarItem[]>();
          for (const item of previousItems ?? [])
            previousById.set(item.id, [
              ...(previousById.get(item.id) ?? []),
              item,
            ]);
          const restored = new Set<string>();
          deliveredSidebarItems.set(
            event.sender,
            items.flatMap((item) => {
              if (!preservedWorkspaceIds.has(item.id)) return [item];
              if (restored.has(item.id)) return [];
              restored.add(item.id);
              return previousById.get(item.id) ?? [];
            }),
          );
        }
        syncTrackedWorkspaces(result.items, preservedWorkspaceIds);
        syncCodeGraphBaseRepositories(result.items, preservedWorkspaceIds);
        publishWorktreeLifecycleChange('projects-saved');
        syncWorktreesFileWatchers(
          result.items,
          getWindow,
          preservedWorkspaceIds,
          reconcileExternalSnapshot,
        );
        recordWorkspaceCrudTelemetry({
          action: 'save',
          source: 'projects_save',
        });
        return result;
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.projectSaveDefaultPlugins,
    async (event, request: SaveDefaultPluginsRequest) => {
      validateId(request.projectId, 'project id');
      const commands = guardedCommands(event);
      // Ordered with the other project operations, as before; only this
      // project's manifest is written.
      return serializeChatProjectOperation(() =>
        saveDefaultPluginsAndVisibility(request, 'project_settings', (update) =>
          commands.updatePlugins(update),
        ),
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.projectApplySourceChanges,
    async (
      event,
      request: ProjectApplySourceChangesRequest,
    ): Promise<ProjectApplySourceChangesResponse> => {
      validateId(request.projectId, 'projectId');
      if (request.startPage !== undefined) {
        assertStartPageFeatureEnabled();
      }
      if (request.target.mode === 'existing') {
        validateId(request.target.worktreeId, 'worktreeId');
      }

      return projectedSourceCompositionCommands({
        dispatcher,
        caller: resolveCaller(event),
      }).applySourceChanges(request.projectId, request, () =>
        applySourceChanges({
          kind: 'project',
          git: sourceChangeGit(
            request.projectId,
            dispatcher,
            resolveCaller(event),
          ),
          source: 'project_settings',
          request,
          getWindow,
          onApplied: (applied) => {
            const window = getWindow();
            if (!window) {
              return;
            }
            sendToWindow(
              window,
              IPC_CHANNELS.projectSourceChangesApplied,
              applied,
            );
          },
        }),
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.projectDelete,
    async (event, request: DeleteProjectRequest): Promise<void> => {
      validateId(request.projectId, 'projectId');
      if (request.supersedeInterruptedDeletion !== undefined)
        validateId(
          request.supersedeInterruptedDeletion,
          'supersedeInterruptedDeletion',
        );
      // The full workspace deletion (CAN-3799 B6): it refuses anything but a
      // single-repo project and also removes an app-created managed repo.
      const outcome = await projectedWorkspaceLifecycleCommands({
        dispatcher,
        caller: resolveCaller(event),
      }).deleteWorkspace({ workspaceId: request.projectId }, () =>
        deleteWorkspace({
          workspaceId: request.projectId,
          source: 'single_repo_project_delete',
          singleRepoProject: true,
          supersedeInterruptedDeletion: request.supersedeInterruptedDeletion,
          discardPendingRecovery: request.discardPendingRecovery,
        }),
      );
      // This channel has always failed when the managed repository could not
      // be removed; keep that visible although the project itself is gone.
      const repository = outcome.cleanup.managedRepository;
      if (repository.status === 'failed') {
        throw repository.error instanceof Error
          ? repository.error
          : new Error(String(repository.error));
      }
    },
  );
}
