import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  createBranchObserver,
  type BranchCheckout,
  type BranchCheckoutListing,
  type BranchObserver,
  type BranchObserverPorts,
  type BranchReadyWorktree,
  type GitHeadWatchHandle,
} from '@canopy/core-runtime/node';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import { runWithGitRequestContext } from '@canopy/desktop-shared/node/git-request-context';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
  type SidebarItemsFile,
  type WorktreeBranchChangedEvent,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type { CoreWorkspaceReadDetail } from '../canopy-runtime/core-workspace-adapter';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { getCurrentBranchDisplayName, getGitHeadWatchState } from './git';
import {
  logMainProcessDebug,
  logMainProcessInfo,
  logMainProcessWarn,
} from './main-process-logging';
import { getWorkspaceWorktreeDir } from './paths';
import { getSidebarItemsPreserveWorkspaceIds } from './sidebar-items-preservation';
import { invalidateWorktreeStats } from './worktree-service';
import { observeWorktreeGit } from './worktree-git-observations';
import { registerWorktreeGitReadyHook } from './worktree-git-ready-hooks';
import {
  subscribeWorktreeLifecycleChanges,
  worktreeLifecycleSequence,
} from './worktree-lifecycle-signals';
import { WorktreeRecordRefusedError } from './worktree-repair';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import { sendToWindow } from './window-send';
import { workspaceStorageUnavailable } from './workspace-storage-availability';

// Main's composition of the core-runtime branch observer (CAN-4899): the
// observer owns watch policy; this module supplies desktop paths, Git reads,
// the `internal.worktree.git.observe` writer and the renderer push.

interface DesktopBranchCheckout extends BranchCheckout {
  repoPath: string;
}

type BranchRecordOutcome =
  | 'recorded'
  | 'unchanged'
  | 'not-found'
  | 'refused'
  | 'failed';

const LIST_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-branch-observer',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: ['core.worktree.read'],
};

const WATCH_CALLER: CanopyCallerDescriptor = {
  ...LIST_CALLER,
  grants: ['worker.filesystem.read'],
};

interface ActiveObserver {
  observer: BranchObserver;
  startEnrollment(): void;
  dispose(): void;
}

let active: ActiveObserver | null = null;

function runBranchWatcherGit<T>(callback: () => Promise<T>): Promise<T> {
  return runWithGitRequestContext(
    { source: 'branch-watcher', requestId: randomUUID() },
    callback,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectWorktreeCheckouts(
  workspaceId: string,
  workspaceKind: 'single-repo' | 'multi-repo',
  worktree: Pick<WorktreeData, 'id' | 'branchName'>,
): Promise<DesktopBranchCheckout[]> {
  const worktreePath = getWorkspaceWorktreeDir(workspaceId, worktree.id);
  if (workspaceKind === 'single-repo') {
    return [
      {
        workspaceId,
        worktreeId: worktree.id,
        fileRootId: workspaceId,
        repoPath: worktreePath,
        persistedBranchName: worktree.branchName,
      },
    ];
  }
  const repoEntries = await listWorkspaceWorktreeRepoEntries(
    workspaceId,
    worktreePath,
  ).catch((error: unknown) => {
    logMainProcessWarn('Worktree branch watcher repos unavailable', {
      key: `${workspaceId}/${worktree.id}`,
      error: describeError(error),
    });
    return [];
  });
  // Child repos of a multi-repo worktree keep no branch of their own.
  return repoEntries.map((repo) => ({
    workspaceId,
    worktreeId: worktree.id,
    repoId: repo.repoId,
    fileRootId: repo.repoId,
    repoPath: repo.repoPath,
    persistedBranchName:
      repo.repoId === WORKSPACE_ROOT_REPO_ID ? worktree.branchName : null,
  }));
}

/** A `projects:load` read, taken before its `projects-loaded` publish. */
export interface LoadedProjectionOffer {
  /** `worktreeLifecycleSequence()` captured before the read began. */
  sequence: number;
  /** Never stale: a stale load offers nothing. */
  file: SidebarItemsFile;
  authority?: CoreWorkspaceReadDetail;
}

let offered: LoadedProjectionOffer | undefined;

/** The observer's next listing reuses it unless a list changed since. */
export function offerLoadedProjection(offer: LoadedProjectionOffer): void {
  if (active) offered = offer;
}

function takeLoadedProjection(): LoadedProjectionOffer | undefined {
  const offer = offered;
  offered = undefined;
  return offer?.sequence === worktreeLifecycleSequence() ? offer : undefined;
}

async function listCheckouts(
  dispatcher: DesktopCanopyDispatcher,
): Promise<BranchCheckoutListing<DesktopBranchCheckout>> {
  const offer = takeLoadedProjection();
  const { legacyResult, legacyAuthority } = offer
    ? { legacyResult: offer.file, legacyAuthority: offer.authority }
    : await dispatcher.queryWorktreeListForLegacyIpc(
        {},
        { caller: LIST_CALLER },
      );
  // Per-workspace faults use preservedWorkspaceIds without blocking healthy enrollment.
  if (legacyAuthority?.indexAuthority === 'unreadable') {
    throw workspaceStorageUnavailable();
  }
  if (Array.isArray(legacyResult))
    throw new Error('Unscoped worktree projection was not captured.');
  const checkouts: DesktopBranchCheckout[] = [];
  const pendingWorktrees: Array<{ workspaceId: string; worktreeId: string }> =
    [];
  for (const item of legacyResult.items) {
    if (item.type === 'cowork' || isRetiredTemporaryWorkspace(item)) continue;
    for (const worktree of item.worktrees) {
      // A checkout still being created has no HEAD yet; git-ready starts it.
      if (worktree.setupPhase === 'git-pending') {
        pendingWorktrees.push({
          workspaceId: item.id,
          worktreeId: worktree.id,
        });
        continue;
      }
      checkouts.push(
        ...(await collectWorktreeCheckouts(item.id, item.type, worktree)),
      );
    }
  }
  return {
    checkouts,
    pendingWorktrees,
    preservedWorkspaceIds: new Set([
      ...getSidebarItemsPreserveWorkspaceIds(legacyResult),
      ...(legacyAuthority?.worktreePreserveWorkspaceIds ?? []),
    ]),
  };
}

function toOperationError(error: unknown): CanopyOperationError {
  return error instanceof CanopyOperationError
    ? error
    : new CanopyOperationError(
        {
          kind: 'internal',
          message: 'The HEAD watch could not attach.',
          retry: { kind: 'never' },
        },
        error,
      );
}

function createDesktopPorts(
  dispatcher: DesktopCanopyDispatcher,
  getWindow: () => BrowserWindow | null,
): BranchObserverPorts<DesktopBranchCheckout> {
  return {
    listCheckouts: () => listCheckouts(dispatcher),
    listReadyWorktreeCheckouts: (target: BranchReadyWorktree) =>
      collectWorktreeCheckouts(target.workspaceId, target.workspaceKind, {
        id: target.worktreeId,
        branchName: target.branchName,
      }),
    readStartBranch: async (checkout) =>
      (await runBranchWatcherGit(() => getGitHeadWatchState(checkout.repoPath)))
        .branchName,
    readBranch: (checkout) =>
      runBranchWatcherGit(() => getCurrentBranchDisplayName(checkout.repoPath)),
    record: (observation) =>
      recordWorktreeBranchChange(
        {
          projectId: observation.workspaceId,
          worktreeId: observation.worktreeId,
          branchName: observation.branchName,
          ...(observation.repoId ? { repoId: observation.repoId } : {}),
        },
        getWindow,
      ),
    watchHead: async (checkout, listener): Promise<GitHeadWatchHandle> => {
      let opened: Awaited<
        ReturnType<DesktopCanopyDispatcher['openGitHeadWatchForBranchObserver']>
      >;
      try {
        opened = await dispatcher.openGitHeadWatchForBranchObserver(
          {
            scope: {
              workspaceId: checkout.workspaceId,
              worktreeId: checkout.worktreeId,
            },
            fileRootId: checkout.fileRootId,
          },
          {
            caller: WATCH_CALLER,
            onFrame: (frame): void => {
              if (frame.kind === 'item') listener.onChange();
              else listener.onEnd(frame.error);
            },
          },
        );
        await opened.attached;
      } catch (error) {
        throw toOperationError(error);
      }
      const { handle } = opened;
      return { close: () => handle.close() };
    },
    log: {
      debug: logMainProcessDebug,
      info: logMainProcessInfo,
      warn: logMainProcessWarn,
    },
  };
}

/**
 * Records `internal.worktree.git.observe`. The renderer is told about the
 * branch either way, so a failed or refused write is dropped here.
 */
async function persistBranchChange(
  event: WorktreeBranchChangedEvent,
): Promise<BranchRecordOutcome> {
  return observeWorktreeGit({
    kind: 'branch',
    workspaceId: event.projectId,
    worktreeId: event.worktreeId,
    branchName: event.branchName,
    ...(event.repoId ? { repoId: event.repoId } : {}),
  }).then(
    (outcome) => outcome.status,
    (error: unknown) =>
      error instanceof WorktreeRecordRefusedError ? 'refused' : 'failed',
  );
}

/**
 * Records a checkout's branch and tells the renderer. The observer calls it
 * on a branch change, and the branch namer calls it after its own rename so
 * the sidebar does not depend on a watch being attached. Both fire within
 * moments of the rename, so recording the same branch twice keeps the name.
 * The observer already holds it, so its next HEAD event is a no-op. Like any
 * branch observation, the second write still clears a recorded PR status.
 */
export async function recordWorktreeBranchChange(
  event: WorktreeBranchChangedEvent,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  active?.observer.noteRecorded({
    workspaceId: event.projectId,
    worktreeId: event.worktreeId,
    branchName: event.branchName,
    ...(event.repoId ? { repoId: event.repoId } : {}),
  });
  invalidateWorktreeStats(event.projectId, event.worktreeId);
  const outcome = await persistBranchChange(event);
  // A dropped write leaves the sidebar on the old name until the next start.
  const log =
    outcome === 'failed' || outcome === 'refused'
      ? logMainProcessWarn
      : logMainProcessDebug;
  log('Worktree branch recorded', {
    key: `${event.projectId}/${event.worktreeId}/${event.repoId ?? 'root'}`,
    outcome,
  });

  const window = getWindow();
  if (!window) {
    return;
  }
  sendToWindow(window, IPC_CHANNELS.worktreeBranchChanged, event);
}

export interface WorktreeBranchObserverOptions {
  dispatcher: DesktopCanopyDispatcher;
  getWindow: () => BrowserWindow | null;
}

/**
 * Starts main's branch observer once the runtime accepts calls. Git-ready
 * starts a checkout's watch at any time. Membership enrollment starts at the
 * first `projects:load`, or at `startWorktreeBranchEnrollment()` if that comes
 * first; lifecycle signals, later loads included, then reread membership on a
 * debounce. A load offers its own read first, so its sync lists without
 * another read unless a list write or membership signal landed after the
 * read began.
 */
export function startWorktreeBranchObserver(
  options: WorktreeBranchObserverOptions,
): void {
  stopWorktreeBranchWatchers();
  const observer = createBranchObserver(
    createDesktopPorts(options.dispatcher, options.getWindow),
  );
  let enrolled = false;
  const startEnrollment = (): void => {
    if (enrolled) return;
    enrolled = true;
    void observer.sync();
  };
  const unsubscribe = subscribeWorktreeLifecycleChanges((change) => {
    if (enrolled) observer.requestSync();
    else if (change === 'projects-loaded') startEnrollment();
  });
  const unregisterGitReady = registerWorktreeGitReadyHook((event) =>
    observer.ensureWorktree({
      workspaceId: event.projectId,
      worktreeId: event.worktreeId,
      workspaceKind: event.workspaceKind,
      branchName: event.branchName,
    }),
  );
  active = {
    observer,
    startEnrollment,
    dispose(): void {
      unsubscribe();
      unregisterGitReady();
      observer.stop();
    },
  };
}

/** Main's fallback trigger when no `projects:load` arrives after first paint. */
export function startWorktreeBranchEnrollment(): void {
  active?.startEnrollment();
}

/** Closes every HEAD stream; quit runs it before the runtime drains. */
export function stopWorktreeBranchWatchers(): void {
  const current = active;
  active = null;
  offered = undefined;
  current?.dispose();
}
