/**
 * Archived containers store — archived worktrees (code workspaces) and
 * archived work entries (cowork / App Advisor) retained by the archive &
 * retention feature.
 *
 * All reads and mutations go through the typed transport surface at
 * `window.api.archivedContainers`; this store never touches archive files or
 * re-implements main-process retention/restore rules. Summaries are cached
 * per workspace in `byWorkspace`, and a single idempotent subscription to
 * `archived-containers:changed` keeps the cache and the authoritative
 * sidebar data fresh when the main process archives, restores, deletes, or
 * expires a container in the background.
 */
import { create } from 'zustand';
import {
  ARCHIVED_CONTAINER_CHANGES_MAX_EXPLORABLE_RECORDS,
  type ArchivedContainerKind,
  type ArchivedContainerPullRequestRepoStatus,
  type ArchivedContainerReadChangeDiffResponse,
  type ArchivedContainerRestoreResponse,
  type ArchivedContainerSummary,
  type ArchivedContainerViewerTab,
  type ArchivedContainersChangedEvent,
  type ChangedFileInfo,
} from '@canopy/desktop-shared/types';
import { isWebCoreScope } from '@/lib/chat-authority';

/**
 * Stable empty list for per-workspace selectors. Never allocate `[]` inside a
 * Zustand/useShallow selector — a fresh array each snapshot loops
 * `useSyncExternalStore` (React #185) and blank-pages the app.
 */
export const EMPTY_ARCHIVED_CONTAINERS: readonly ArchivedContainerSummary[] =
  Object.freeze<ArchivedContainerSummary[]>([]);

export interface ArchivedContainerViewerState {
  workspaceId: string;
  containerId: string;
  tab: ArchivedContainerViewerTab;
  selectedChatId?: string;
  selectedPlanId?: string;
}

export interface OpenArchivedViewerOptions {
  tab?: ArchivedContainerViewerTab;
  chatId?: string;
  planId?: string;
}

/**
 * The workspace-scoped "Archived and deleted" overview page. Opening a
 * container viewer always sets this too, so the viewer's Back lands on the
 * list rather than on whatever live surface sat underneath.
 */
export interface ArchivedContainersOverviewState {
  workspaceId: string;
}

/**
 * A removal that has been confirmed in the UI but whose retained container
 * has not been committed by main yet. The live row disappears immediately;
 * this placeholder keeps the "Archived and deleted" list and counters in
 * step so the removal feels instant while capture, Git teardown, and
 * cleanup run in the background. Cleared as soon as the container shows up
 * in a workspace load (or when the removal fails).
 */
export interface PendingArchivedContainer {
  workspaceId: string;
  containerId: string;
  kind: ArchivedContainerKind;
  /** Worktree label or work-entry title; falls back to the branch name. */
  name: string;
  /** Worktree branch, so the placeholder can use the branch display name. */
  branchName?: string;
  /** Where it will land: Deleted (retention window) or Archived (kept). */
  state: 'deleted' | 'archived';
  startedAt: number;
}

/** Stable empty pending list for selectors. */
export const EMPTY_PENDING_ARCHIVED_CONTAINERS: readonly PendingArchivedContainer[] =
  Object.freeze<PendingArchivedContainer[]>([]);

/** Pending placeholders older than this are dropped on the next load. */
const PENDING_ARCHIVED_CONTAINER_MAX_AGE_MS = 15 * 60_000;

/** Outcome of an Empty trash run (permanent deletion of every Deleted item). */
export interface EmptyArchivedTrashResult {
  deletedIds: string[];
  failedIds: string[];
  /** True when the run stopped between items because cancel was requested. */
  cancelled: boolean;
  /** Deleted items still present because the run was cancelled first. */
  remainingIds: string[];
}

/**
 * An in-flight Empty trash run. Deletion happens one container at a time;
 * `cancelRequested` is honored BETWEEN items — the item currently being
 * removed always finishes, so a cancel can never leave a half-deleted
 * archive behind.
 */
export interface EmptyArchivedTrashRun {
  workspaceId: string;
  total: number;
  completed: number;
  cancelRequested: boolean;
}

export interface LoadArchivedContainersOptions {
  /**
   * If a request is already in flight, wait for it and then issue one more
   * authoritative read instead of reusing its potentially stale result.
   */
  trailing?: boolean;
  /** Propagate listing failures to callers that require an authoritative read. */
  strict?: boolean;
}

export interface ArchivedOverviewRequestOutcome {
  requestId: string;
  confirmationOpened: boolean;
}

interface E2eArchivedContainersLoadBarrier {
  claimed: boolean;
  reached: Promise<void>;
  resolveReached: () => void;
  release: Promise<void>;
  resolveRelease: () => void;
  completed: Promise<void>;
  resolveCompleted: () => void;
}

interface E2eArchivedContainersTestApi {
  holdNextLoadAfterRead: () => void;
  loadForWorkspace: (workspaceId: string) => void;
  waitForHeldLoad: () => Promise<void>;
  releaseHeldLoad: () => Promise<void>;
  disableChangedRefresh: () => void;
  getListReadCount: () => number;
  getTrailingLoadRequestCount: () => number;
  /**
   * Pause the next Empty trash run after its first item has been deleted,
   * before it moves on to the next one — the exact point where cancel is
   * honored — so automation can observe the running button and cancel it.
   */
  holdNextEmptyTrashBetweenItems: () => void;
  waitForHeldEmptyTrash: () => Promise<void>;
  releaseHeldEmptyTrash: () => void;
  /**
   * Pause the next worktree / work-entry removal right after its pending
   * placeholder is registered and before main is asked to capture it, so
   * automation can observe the instant placeholder row and counters.
   */
  holdNextPendingRemoval: () => void;
  waitForHeldPendingRemoval: () => Promise<void>;
  releaseHeldPendingRemoval: () => void;
  getPendingContainerCount: (workspaceId: string) => number;
}

interface E2ePendingRemovalBarrier {
  claimed: boolean;
  reached: Promise<void>;
  resolveReached: () => void;
  release: Promise<void>;
  resolveRelease: () => void;
}

let e2ePendingRemovalBarrier: E2ePendingRemovalBarrier | null = null;

/**
 * Removal paths call this right after `registerPendingContainer`. It only
 * waits when E2E automation armed `holdNextPendingRemoval`; otherwise it
 * resolves immediately.
 */
export async function awaitPendingRemovalHoldForE2e(): Promise<void> {
  const barrier = e2ePendingRemovalBarrier;
  if (barrier === null || barrier.claimed) return;
  barrier.claimed = true;
  barrier.resolveReached();
  await barrier.release;
  e2ePendingRemovalBarrier = null;
}

declare global {
  interface Window {
    __canopyArchivedContainersTestApi?: E2eArchivedContainersTestApi;
  }
}

/**
 * Paged changed-file list for the mounted archived Changes explorer.
 *
 * The list is scoped to one archive identity and is reset whenever the
 * explorer unmounts or the identity changes — it is a mounted-view working
 * set, never a global cache. `requestId` invalidates in-flight responses so
 * switching archives (or resetting) can never apply a stale page.
 */
export interface ArchivedChangesListState {
  workspaceId: string;
  containerId: string;
  /** First-page lifecycle. `error` only ever describes a failed first page. */
  status: 'loading' | 'success' | 'error';
  /** Files across all appended pages, in backend-authoritative order. */
  files: ChangedFileInfo[];
  /** Real changed-file total from the list response (may exceed the cap). */
  totalCount: number;
  nextCursor: string | null;
  /** True when totalCount exceeds the 50,000-record exploration cap. */
  truncated: boolean;
  /** In-flight next-page guard; dedupes rapid scroll-triggered fetches. */
  loadingMore: boolean;
  /**
   * A next-page fetch failed. Loaded pages are kept; the explorer offers a
   * retry that resumes from the same cursor instead of restarting the list.
   */
  loadMoreError: boolean;
  /** Monotonic token tying async completions to the state that issued them. */
  requestId: number;
}

/**
 * How long a live pull-request refresh stays fresh. Re-selecting the same
 * archive inside this window reuses the cached result instead of hitting
 * GitHub again.
 */
export const ARCHIVED_PULL_REQUEST_STATUS_TTL_MS = 5 * 60_000;

/** Cached archives to retain; the least recently fetched entry is evicted. */
const MAX_TRACKED_PULL_REQUEST_STATUSES = 25;

/**
 * On-demand live pull-request state for one archive.
 *
 * The archive-time capture on the summary is immutable and always available;
 * this is the strictly optional "what does GitHub say right now" overlay,
 * fetched only when an archive is opened. A failed refresh is not an error the
 * viewer surfaces — it simply keeps rendering the captured state.
 */
export interface ArchivedPullRequestStatusEntry {
  status: 'loading' | 'success' | 'error';
  repos: ArchivedContainerPullRequestRepoStatus[];
  /** Epoch ms of the last successful refresh; 0 until one completes. */
  fetchedAt: number;
}

/** Cache key for {@link ArchivedContainersState.pullRequestStatusByContainer}. */
export function archivedPullRequestStatusKey(
  workspaceId: string,
  containerId: string,
): string {
  return `${workspaceId}:${containerId}`;
}

interface ArchivedContainersState {
  /** Archived-container summaries keyed by workspace/project id. */
  byWorkspace: Record<string, ArchivedContainerSummary[]>;
  /** Workspaces whose summaries have been fetched at least once. */
  loadedWorkspaces: Record<string, boolean>;
  /** Workspaces with an archive-summary request currently in flight. */
  loadingWorkspaces: Record<string, boolean>;
  /** Open read-only viewer, or null when closed. */
  viewer: ArchivedContainerViewerState | null;
  /**
   * Open "Archived and deleted" overview page, or null. Stays set while a
   * viewer is open on top of it so Back returns to the list.
   */
  overview: ArchivedContainersOverviewState | null;
  /**
   * Changed-file list for the currently mounted archived Changes explorer,
   * or null when no explorer is mounted.
   */
  changesList: ArchivedChangesListState | null;
  /**
   * TTL-bounded live pull-request state keyed by
   * {@link archivedPullRequestStatusKey}. Unlike `changesList` this survives
   * viewer unmounts so re-opening an archive inside the TTL costs nothing.
   */
  pullRequestStatusByContainer: Record<string, ArchivedPullRequestStatusEntry>;
  /**
   * Container pinned by an in-flight `restore()`. While set, the viewer-auto-
   * close in `loadForWorkspace` skips this container so the "Restoring…"
   * viewer stays up until the caller navigates to the restored destination
   * and closes it — otherwise the summary refresh inside `restore()` (or the
   * debounced changed-event flush) closes the viewer onto whatever is
   * underneath (usually the Home surface) seconds before navigation lands.
   */
  restoringContainer: { workspaceId: string; containerId: string } | null;
  /** In-flight Empty trash run, or null. At most one runs at a time. */
  emptyTrashRun: EmptyArchivedTrashRun | null;
  /** Workspace whose visible Empty trash confirmation is requested. */
  emptyTrashConfirmationWorkspaceId: string | null;
  /** Latest correlated popout overview command outcome. */
  lastArchivedOverviewRequest: ArchivedOverviewRequestOutcome | null;
  /** Removals awaiting their retained container, keyed by workspace id. */
  pendingByWorkspace: Record<string, PendingArchivedContainer[]>;

  loadForWorkspace: (
    workspaceId: string,
    options?: LoadArchivedContainersOptions,
  ) => Promise<void>;
  openViewer: (
    workspaceId: string,
    containerId: string,
    options?: OpenArchivedViewerOptions,
  ) => void;
  /**
   * Dismiss the page-like archive surfaces entirely (viewer AND overview).
   * Called from every live-target navigation, so it is idempotent.
   */
  closeViewer: () => void;
  /** Open the workspace-scoped overview page (closing any open viewer). */
  openOverview: (workspaceId: string) => void;
  /** Close the overview page (and any viewer stacked on it). */
  closeOverview: () => void;
  /**
   * The viewer's Back: close only the viewer and land on the overview list
   * for the same workspace.
   */
  closeViewerToOverview: () => void;
  /**
   * Permanently delete every "Deleted" (unlocked) container in the workspace,
   * one at a time so a single failure never aborts the rest. "Archived"
   * (locked) containers are never touched. Resolves when the run finishes or
   * stops at a cancel checkpoint; progress is published on `emptyTrashRun`.
   */
  emptyTrash: (workspaceId: string) => Promise<EmptyArchivedTrashResult>;
  /** Open the user-controlled Empty trash confirmation for a workspace. */
  requestEmptyTrashConfirmation: (workspaceId: string) => void;
  recordArchivedOverviewRequest: (
    outcome: ArchivedOverviewRequestOutcome,
  ) => void;
  /** Close the Empty trash confirmation without deleting anything. */
  dismissEmptyTrashConfirmation: () => void;
  /**
   * Ask the running Empty trash to stop before its next item. The item being
   * deleted right now still completes; nothing is ever left half-removed.
   */
  cancelEmptyTrash: () => void;
  /**
   * Announce a confirmed removal before main has committed its container.
   * Also makes sure the workspace's summaries are loaded, so counters can
   * be derived from store data plus this placeholder without double
   * counting once the container lands.
   */
  registerPendingContainer: (
    pending: Omit<PendingArchivedContainer, 'startedAt'>,
  ) => void;
  /** Drop a placeholder (removal failed or was rolled back). */
  clearPendingContainer: (workspaceId: string, containerId: string) => void;
  /**
   * Start (or restart) the changed-file list for one archive identity.
   * Resets any prior list state and fetches the first page.
   */
  openChanges: (workspaceId: string, containerId: string) => void;
  /**
   * Fetch the next page for the current list. No-ops while a page is in
   * flight, after a terminal cursor, past the 50,000-record exploration cap,
   * or while a next-page failure is waiting on an explicit retry.
   */
  loadMoreChanges: () => void;
  /**
   * Retry from the appropriate failed state: a failed first page restarts
   * the list; a failed next page resumes from the same cursor without
   * discarding successfully loaded pages.
   */
  retryChanges: () => void;
  /** Drop the changed-file list (explorer unmount / identity change). */
  resetChanges: () => void;
  /**
   * Typed per-file diff read for the mounted explorer. The caller owns
   * caching (mounted-view only); this helper never stores responses.
   */
  readChangeDiff: (
    workspaceId: string,
    containerId: string,
    repoId: string,
    filePath: string,
  ) => Promise<ArchivedContainerReadChangeDiffResponse>;
  /**
   * Refresh live pull-request state for one archive, on demand. No-ops while a
   * refresh is in flight or while the cached result is still inside
   * {@link ARCHIVED_PULL_REQUEST_STATUS_TTL_MS}, so repeatedly opening the same
   * archive issues at most one GitHub round-trip per TTL window.
   */
  ensurePullRequestStatus: (workspaceId: string, containerId: string) => void;
  selectTab: (tab: ArchivedContainerViewerTab) => void;
  selectChat: (chatId: string | undefined) => void;
  selectPlan: (planId: string | undefined) => void;
  /**
   * Restore the container. Surfacing warnings and navigating to the returned
   * destination ids is the caller's responsibility; the store refreshes the
   * workspace summaries plus authoritative sidebar data while keeping the
   * viewer pinned open (`restoringContainer`) so the caller controls the
   * single close-onto-destination transition.
   */
  restore: (
    workspaceId: string,
    containerId: string,
  ) => Promise<ArchivedContainerRestoreResponse | null>;
  /** Permanently delete the container. Returns false on failure. */
  deletePermanently: (
    workspaceId: string,
    containerId: string,
  ) => Promise<boolean>;
  /**
   * After the container was removed some other way (CAN-5338: a retained
   * archive discard): closes its viewer and reloads, as a deletion does.
   */
  settleDeleted: (workspaceId: string, containerId: string) => Promise<void>;
  /**
   * Lock (exempt from retention cleanup) or unlock the container. Unlocking
   * restarts the retention window from the unlock time. Returns the updated
   * summary, or null on failure.
   */
  setLocked: (
    workspaceId: string,
    containerId: string,
    locked: boolean,
  ) => Promise<ArchivedContainerSummary | null>;
}

/**
 * Refresh authoritative workspace/sidebar data after an archive mutation so
 * `archivedContainerCount`, temporary-workspace visibility, and cowork
 * work-entry lists match the main process. Both sidebar sources are refreshed
 * best-effort because the changed event only carries a workspace id, not a
 * surface kind. Lazy imports avoid a module cycle (projectsStore is large and
 * transitively imports sidebar components).
 */
async function refreshAuthoritativeSidebarData(
  changedWorkspaceIds: readonly string[] = [],
): Promise<void> {
  try {
    const [
      { useProjectsStore },
      { useStandaloneChatStore },
      { usePipelineRunsStore },
    ] = await Promise.all([
      import('./projectsStore'),
      import('./standaloneChatStore'),
      import('./pipelineRunsStore'),
    ]);
    // Refresh global workflow statuses in the background so archive actions
    // do not block on sequential Advisor snapshot reads across local history.
    void usePipelineRunsStore
      .getState()
      .refreshGlobalPipelineStatusesKeepingSeen();
    await Promise.all([
      useProjectsStore
        .getState()
        .loadProjects({ silent: true })
        .catch(() => undefined),
      useStandaloneChatStore
        .getState()
        .loadChatProjects()
        .catch(() => undefined),
    ]);
    const standaloneState = useStandaloneChatStore.getState();
    const coworkWorkspaceIds = changedWorkspaceIds.filter((workspaceId) =>
      standaloneState.chatProjects.some(
        (project) => project.id === workspaceId,
      ),
    );
    await Promise.all(
      coworkWorkspaceIds.map((workspaceId) =>
        (standaloneState.activeChatProjectId === workspaceId
          ? standaloneState.refreshWorkEntries(workspaceId)
          : standaloneState.loadSidebarProjectEntries(workspaceId)
        ).catch(() => undefined),
      ),
    );
  } catch {
    // Sidebar refresh is best-effort; the next authoritative push wins.
  }
}

/**
 * Monotonic token for changed-file page fetches. Every fetch stamps the list
 * state with its token; completions apply only while the stamp still matches,
 * so resets/identity switches simply orphan in-flight responses.
 */
let changesRequestSeq = 0;

function changedFileKey(file: ChangedFileInfo): string {
  return `${file.repoId ?? ''}\0${file.path}`;
}

async function fetchChangesPage(
  set: (
    updater: (
      state: ArchivedContainersState,
    ) => Partial<ArchivedContainersState>,
  ) => void,
  get: () => ArchivedContainersState,
  requestId: number,
  cursor: string | undefined,
): Promise<void> {
  const issued = get().changesList;
  if (issued === null || issued.requestId !== requestId) {
    return;
  }
  const { workspaceId, containerId } = issued;
  try {
    const response = await window.api.archivedContainers.listChanges({
      projectId: workspaceId,
      containerId,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    set((state) => {
      const current = state.changesList;
      if (current === null || current.requestId !== requestId) {
        return {};
      }
      // Defensive de-duplication: a page must never repeat files that an
      // earlier page already delivered (backend ordering is authoritative,
      // so duplicates would only come from a cursor bug — drop them).
      const seen = new Set(current.files.map(changedFileKey));
      const appended = response.files.filter(
        (file) => !seen.has(changedFileKey(file)),
      );
      const files =
        appended.length > 0 ? [...current.files, ...appended] : current.files;
      const capReached =
        files.length >= ARCHIVED_CONTAINER_CHANGES_MAX_EXPLORABLE_RECORDS;
      return {
        changesList: {
          ...current,
          status: 'success',
          files,
          totalCount: response.totalCount,
          nextCursor: capReached ? null : response.nextCursor,
          truncated: response.truncated,
          loadingMore: false,
          loadMoreError: false,
        },
      };
    });
  } catch {
    set((state) => {
      const current = state.changesList;
      if (current === null || current.requestId !== requestId) {
        return {};
      }
      // A failed first page is a list-level error; a failed next page keeps
      // the loaded pages and waits for an explicit retry.
      if (current.status === 'loading') {
        return {
          changesList: { ...current, status: 'error', loadingMore: false },
        };
      }
      return {
        changesList: { ...current, loadingMore: false, loadMoreError: true },
      };
    });
  }
}

/**
 * Keep the pull-request cache bounded: drop the least recently fetched entries
 * once the map would exceed {@link MAX_TRACKED_PULL_REQUEST_STATUSES}. The key
 * about to be written is always retained.
 */
function evictStalePullRequestStatuses(
  entries: Record<string, ArchivedPullRequestStatusEntry>,
  keepKey: string,
): Record<string, ArchivedPullRequestStatusEntry> {
  const keys = Object.keys(entries);
  if (
    keys.length + (keepKey in entries ? 0 : 1) <=
    MAX_TRACKED_PULL_REQUEST_STATUSES
  ) {
    return entries;
  }
  const evictable = keys
    .filter((key) => key !== keepKey)
    .sort((left, right) => entries[left].fetchedAt - entries[right].fetchedAt);
  const dropCount =
    keys.length +
    (keepKey in entries ? 0 : 1) -
    MAX_TRACKED_PULL_REQUEST_STATUSES;
  const next: Record<string, ArchivedPullRequestStatusEntry> = { ...entries };
  for (const key of evictable.slice(0, dropCount)) {
    delete next[key];
  }
  return next;
}

interface InFlightWorkspaceLoad {
  raw: Promise<void>;
  settled: Promise<void>;
}

const inFlightWorkspaceLoads = new Map<string, InFlightWorkspaceLoad>();
let e2eArchivedContainersLoadBarrier: E2eArchivedContainersLoadBarrier | null =
  null;

interface E2eEmptyTrashBarrier {
  claimed: boolean;
  reached: Promise<void>;
  resolveReached: () => void;
  release: Promise<void>;
  resolveRelease: () => void;
}
let e2eEmptyTrashBarrier: E2eEmptyTrashBarrier | null = null;

/** E2E-only pause between two Empty trash items (see the test API). */
async function waitAtE2eEmptyTrashBarrier(): Promise<void> {
  if (!__CANOPY_E2E__) return;
  const barrier = e2eEmptyTrashBarrier;
  if (!barrier || barrier.claimed) return;
  barrier.claimed = true;
  barrier.resolveReached();
  await barrier.release;
  if (e2eEmptyTrashBarrier === barrier) {
    e2eEmptyTrashBarrier = null;
  }
}
let e2eArchivedContainersListReadCount = 0;
let e2eArchivedContainersTrailingLoadRequestCount = 0;

async function waitAtE2eArchivedContainersLoadBarrier(): Promise<E2eArchivedContainersLoadBarrier | null> {
  if (!__CANOPY_E2E__) return null;
  const barrier = e2eArchivedContainersLoadBarrier;
  if (!barrier || barrier.claimed) return null;
  barrier.claimed = true;
  barrier.resolveReached();
  await barrier.release;
  return barrier;
}

const ARCHIVED_CONTAINER_SUMMARY_FIELDS = [
  'version',
  'id',
  'kind',
  'projectId',
  'name',
  'label',
  'createdAt',
  'archivedAt',
  'retentionDays',
  'expiresAt',
  'lockedAt',
  'chatCount',
  'archivedChatCount',
  'executionCount',
  'branchName',
  'workspaceType',
] as const satisfies readonly (keyof ArchivedContainerSummary)[];

function areArchivedContainerSummariesEqual(
  previous: ArchivedContainerSummary[] | undefined,
  next: ArchivedContainerSummary[],
): boolean {
  if (previous === undefined || previous.length !== next.length) {
    return false;
  }
  return previous.every((previousSummary, index) => {
    const nextSummary = next[index];
    if (nextSummary === undefined) {
      return false;
    }
    const scalarFieldsEqual = ARCHIVED_CONTAINER_SUMMARY_FIELDS.every(
      (key) => previousSummary[key] === nextSummary[key],
    );
    const previousRestoredTo = previousSummary.restoredTo;
    const nextRestoredTo = nextSummary.restoredTo;
    const previousDiskUsage = previousSummary.diskUsage;
    const nextDiskUsage = nextSummary.diskUsage;
    return (
      scalarFieldsEqual &&
      previousRestoredTo?.kind === nextRestoredTo?.kind &&
      previousRestoredTo?.id === nextRestoredTo?.id &&
      previousRestoredTo?.restoredAt === nextRestoredTo?.restoredAt &&
      previousRestoredTo?.createdAt === nextRestoredTo?.createdAt &&
      previousDiskUsage?.totalBytes === nextDiskUsage?.totalBytes &&
      previousDiskUsage?.computedAt === nextDiskUsage?.computedAt
    );
  });
}

export const useArchivedContainersStore = create<ArchivedContainersState>(
  (set, get) => ({
    byWorkspace: {},
    loadedWorkspaces: {},
    loadingWorkspaces: {},
    viewer: null,
    overview: null,
    changesList: null,
    pullRequestStatusByContainer: {},
    restoringContainer: null,
    emptyTrashRun: null,
    emptyTrashConfirmationWorkspaceId: null,
    lastArchivedOverviewRequest: null,
    pendingByWorkspace: {},

    openChanges: (workspaceId, containerId): void => {
      const requestId = ++changesRequestSeq;
      set({
        changesList: {
          workspaceId,
          containerId,
          status: 'loading',
          files: [],
          totalCount: 0,
          nextCursor: null,
          truncated: false,
          loadingMore: false,
          loadMoreError: false,
          requestId,
        },
      });
      void fetchChangesPage(set, get, requestId, undefined);
    },

    loadMoreChanges: (): void => {
      const current = get().changesList;
      if (
        current === null ||
        current.status !== 'success' ||
        current.loadingMore ||
        current.loadMoreError ||
        current.nextCursor === null ||
        current.files.length >=
          ARCHIVED_CONTAINER_CHANGES_MAX_EXPLORABLE_RECORDS
      ) {
        return;
      }
      const requestId = ++changesRequestSeq;
      set({ changesList: { ...current, loadingMore: true, requestId } });
      void fetchChangesPage(set, get, requestId, current.nextCursor);
    },

    retryChanges: (): void => {
      const current = get().changesList;
      if (current === null) {
        return;
      }
      if (current.status === 'error') {
        get().openChanges(current.workspaceId, current.containerId);
        return;
      }
      if (
        current.status === 'success' &&
        current.loadMoreError &&
        current.nextCursor !== null
      ) {
        const requestId = ++changesRequestSeq;
        set({
          changesList: {
            ...current,
            loadingMore: true,
            loadMoreError: false,
            requestId,
          },
        });
        void fetchChangesPage(set, get, requestId, current.nextCursor);
      }
    },

    resetChanges: (): void => {
      // Bump the token so orphaned in-flight completions can never re-apply.
      changesRequestSeq += 1;
      if (get().changesList !== null) {
        set({ changesList: null });
      }
    },

    readChangeDiff: (
      workspaceId,
      containerId,
      repoId,
      filePath,
    ): Promise<ArchivedContainerReadChangeDiffResponse> =>
      window.api.archivedContainers.readChangeDiff({
        projectId: workspaceId,
        containerId,
        repoId,
        filePath,
      }),

    ensurePullRequestStatus: (workspaceId, containerId): void => {
      const key = archivedPullRequestStatusKey(workspaceId, containerId);
      const existing = get().pullRequestStatusByContainer[key];
      if (existing?.status === 'loading') {
        return;
      }
      if (
        existing?.status === 'success' &&
        Date.now() - existing.fetchedAt < ARCHIVED_PULL_REQUEST_STATUS_TTL_MS
      ) {
        return;
      }
      set((state) => ({
        pullRequestStatusByContainer: {
          ...evictStalePullRequestStatuses(
            state.pullRequestStatusByContainer,
            key,
          ),
          [key]: {
            status: 'loading',
            repos: existing?.repos ?? [],
            fetchedAt: existing?.fetchedAt ?? 0,
          },
        },
      }));
      void window.api.archivedContainers
        .refreshPullRequests({ projectId: workspaceId, containerId })
        .then((response) => {
          set((state) => ({
            pullRequestStatusByContainer: {
              ...state.pullRequestStatusByContainer,
              [key]: {
                status: 'success',
                repos: response.repos,
                fetchedAt: Date.now(),
              },
            },
          }));
        })
        .catch(() => {
          // The captured archive-time state stays on screen; keep whatever a
          // previous successful refresh produced rather than blanking it.
          set((state) => {
            const current = state.pullRequestStatusByContainer[key];
            return {
              pullRequestStatusByContainer: {
                ...state.pullRequestStatusByContainer,
                [key]: {
                  status: 'error',
                  repos: current?.repos ?? [],
                  fetchedAt: current?.fetchedAt ?? 0,
                },
              },
            };
          });
        });
    },

    loadForWorkspace: (workspaceId, options): Promise<void> => {
      // A cloud project keeps no archive on this computer; its More page reads
      // the web core instead (CAN-6511).
      if (isWebCoreScope(workspaceId)) return Promise.resolve();
      if (__CANOPY_E2E__ && options?.trailing === true) {
        e2eArchivedContainersTrailingLoadRequestCount += 1;
      }
      const existingLoad = inFlightWorkspaceLoads.get(workspaceId);
      if (existingLoad !== undefined) {
        if (options?.trailing === true) {
          return existingLoad.settled.then(() => {
            // The normal completion handler removes this entry first. Keep
            // the guard for deterministic ordering in alternate runtimes.
            if (inFlightWorkspaceLoads.get(workspaceId) === existingLoad) {
              inFlightWorkspaceLoads.delete(workspaceId);
            }
            return get().loadForWorkspace(workspaceId, {
              ...(options?.strict === true ? { strict: true } : {}),
            });
          });
        }
        return options?.strict === true
          ? existingLoad.raw
          : existingLoad.settled;
      }

      const rawLoad = (async (): Promise<void> => {
        let heldE2eBarrier: E2eArchivedContainersLoadBarrier | null = null;
        set((state) => {
          if (state.loadingWorkspaces[workspaceId] === true) {
            return state;
          }
          return {
            loadingWorkspaces: {
              ...state.loadingWorkspaces,
              [workspaceId]: true,
            },
          };
        });
        try {
          if (__CANOPY_E2E__) {
            e2eArchivedContainersListReadCount += 1;
          }
          const summaries = await window.api.archivedContainers.list({
            projectId: workspaceId,
          });
          heldE2eBarrier = await waitAtE2eArchivedContainersLoadBarrier();
          set((state) => {
            const previousSummaries = state.byWorkspace[workspaceId];
            if (
              state.loadedWorkspaces[workspaceId] === true &&
              areArchivedContainerSummariesEqual(
                previousSummaries,
                summaries,
              ) &&
              (state.pendingByWorkspace[workspaceId] ?? []).every(
                (entry) =>
                  !summaries.some(
                    (summary) => summary.id === entry.containerId,
                  ) &&
                  Date.now() - entry.startedAt <
                    PENDING_ARCHIVED_CONTAINER_MAX_AGE_MS,
              )
            ) {
              return state;
            }
            const viewer = state.viewer;
            const pinnedByRestore =
              viewer !== null &&
              state.restoringContainer !== null &&
              state.restoringContainer.workspaceId === viewer.workspaceId &&
              state.restoringContainer.containerId === viewer.containerId;
            const viewerStillPresent =
              viewer === null ||
              pinnedByRestore ||
              viewer.workspaceId !== workspaceId ||
              summaries.some((summary) => summary.id === viewer.containerId);
            // Placeholders whose container has landed (or that have gone
            // stale) retire with this authoritative read.
            const now = Date.now();
            const pending = state.pendingByWorkspace[workspaceId];
            const remainingPending = pending?.filter(
              (entry) =>
                !summaries.some(
                  (summary) => summary.id === entry.containerId,
                ) &&
                now - entry.startedAt < PENDING_ARCHIVED_CONTAINER_MAX_AGE_MS,
            );
            const pendingByWorkspace =
              pending === undefined ||
              remainingPending === undefined ||
              remainingPending.length === pending.length
                ? state.pendingByWorkspace
                : remainingPending.length === 0
                  ? Object.fromEntries(
                      Object.entries(state.pendingByWorkspace).filter(
                        ([key]) => key !== workspaceId,
                      ),
                    )
                  : {
                      ...state.pendingByWorkspace,
                      [workspaceId]: remainingPending,
                    };
            return {
              byWorkspace: { ...state.byWorkspace, [workspaceId]: summaries },
              loadedWorkspaces: {
                ...state.loadedWorkspaces,
                [workspaceId]: true,
              },
              pendingByWorkspace,
              // Close the viewer when its container disappeared (restored
              // elsewhere, expired, or permanently deleted).
              viewer: viewerStillPresent ? viewer : null,
            };
          });
        } finally {
          heldE2eBarrier?.resolveCompleted();
          if (e2eArchivedContainersLoadBarrier === heldE2eBarrier) {
            e2eArchivedContainersLoadBarrier = null;
          }
          set((state) => {
            if (state.loadingWorkspaces[workspaceId] !== true) {
              return state;
            }
            const loadingWorkspaces = { ...state.loadingWorkspaces };
            delete loadingWorkspaces[workspaceId];
            return { loadingWorkspaces };
          });
        }
      })();

      const inFlightLoad: InFlightWorkspaceLoad = {
        raw: rawLoad,
        settled: rawLoad.catch(() => undefined),
      };
      inFlightWorkspaceLoads.set(workspaceId, inFlightLoad);
      void inFlightLoad.settled.then(() => {
        if (inFlightWorkspaceLoads.get(workspaceId) === inFlightLoad) {
          inFlightWorkspaceLoads.delete(workspaceId);
        }
      });
      return options?.strict === true ? rawLoad : inFlightLoad.settled;
    },

    openViewer: (workspaceId, containerId, options): void => {
      set({
        viewer: {
          workspaceId,
          containerId,
          tab: options?.tab ?? 'chats',
          selectedChatId: options?.chatId,
          selectedPlanId: options?.planId,
        },
        // The overview always sits beneath a viewer so Back lands on the
        // workspace's list, whichever entry point opened the container.
        overview: { workspaceId },
      });
      if (get().loadedWorkspaces[workspaceId] !== true) {
        void get().loadForWorkspace(workspaceId);
      }
    },

    closeViewer: (): void => {
      // Idempotent: called from every live-target navigation (selectWorktree),
      // so a no-op close must not churn subscribers.
      if (
        get().viewer !== null ||
        get().overview !== null ||
        get().restoringContainer !== null ||
        get().emptyTrashConfirmationWorkspaceId !== null
      ) {
        set({
          viewer: null,
          overview: null,
          restoringContainer: null,
          emptyTrashConfirmationWorkspaceId: null,
        });
        get().resetChanges();
      }
    },

    openOverview: (workspaceId): void => {
      const { viewer, overview } = get();
      if (
        viewer === null &&
        overview !== null &&
        overview.workspaceId === workspaceId
      ) {
        // Already showing this list: re-clicking the sidebar link just
        // refreshes rather than churning subscribers.
        void get().loadForWorkspace(workspaceId);
        return;
      }
      set({
        viewer: null,
        overview: { workspaceId },
        restoringContainer: null,
        emptyTrashConfirmationWorkspaceId: null,
      });
      get().resetChanges();
      void get().loadForWorkspace(workspaceId);
    },

    closeOverview: (): void => {
      if (
        get().viewer !== null ||
        get().overview !== null ||
        get().emptyTrashConfirmationWorkspaceId !== null
      ) {
        set({
          viewer: null,
          overview: null,
          restoringContainer: null,
          emptyTrashConfirmationWorkspaceId: null,
        });
        get().resetChanges();
      }
    },

    closeViewerToOverview: (): void => {
      const viewer = get().viewer;
      if (viewer === null) {
        return;
      }
      set({
        viewer: null,
        restoringContainer: null,
        overview: get().overview ?? { workspaceId: viewer.workspaceId },
      });
      get().resetChanges();
    },

    emptyTrash: async (workspaceId): Promise<EmptyArchivedTrashResult> => {
      set({ emptyTrashConfirmationWorkspaceId: null });
      const deletedItems = (get().byWorkspace[workspaceId] ?? []).filter(
        (entry) => entry.lockedAt === undefined,
      );
      const deletedIds: string[] = [];
      const failedIds: string[] = [];
      let cancelled = false;
      if (get().emptyTrashRun !== null) {
        // One run at a time; a second click while running is the cancel.
        return {
          deletedIds,
          failedIds,
          cancelled: false,
          remainingIds: deletedItems.map((entry) => entry.id),
        };
      }
      set({
        emptyTrashRun: {
          workspaceId,
          total: deletedItems.length,
          completed: 0,
          cancelRequested: false,
        },
      });
      try {
        for (let index = 0; index < deletedItems.length; index += 1) {
          const entry = deletedItems[index];
          if (index > 0) {
            // Cancel checkpoint: only between items, never mid-delete.
            await waitAtE2eEmptyTrashBarrier();
            if (get().emptyTrashRun?.cancelRequested === true) {
              cancelled = true;
              break;
            }
          }
          try {
            const result = await window.api.archivedContainers.delete({
              projectId: workspaceId,
              containerId: entry.id,
              onlyIfDeleted: true,
            });
            if (result.deleted) {
              deletedIds.push(entry.id);
            }
          } catch {
            failedIds.push(entry.id);
          }
          set((state) =>
            state.emptyTrashRun === null
              ? state
              : {
                  emptyTrashRun: {
                    ...state.emptyTrashRun,
                    completed: state.emptyTrashRun.completed + 1,
                  },
                },
          );
        }
        const viewer = get().viewer;
        if (
          viewer?.workspaceId === workspaceId &&
          deletedIds.includes(viewer.containerId)
        ) {
          // The viewer's container is gone; land on the overview list.
          set({ viewer: null, restoringContainer: null });
          get().resetChanges();
        }
        await get().loadForWorkspace(workspaceId, {
          trailing: true,
          strict: true,
        });
        await refreshAuthoritativeSidebarData([workspaceId]);
      } finally {
        set({ emptyTrashRun: null });
      }
      const handled = new Set([...deletedIds, ...failedIds]);
      const authoritativeIds = new Set(
        (get().byWorkspace[workspaceId] ?? []).map((entry) => entry.id),
      );
      return {
        deletedIds,
        failedIds,
        cancelled,
        remainingIds: deletedItems
          .map((entry) => entry.id)
          .filter((id) => !handled.has(id) && authoritativeIds.has(id)),
      };
    },

    cancelEmptyTrash: (): void => {
      const run = get().emptyTrashRun;
      if (run === null || run.cancelRequested) return;
      set({ emptyTrashRun: { ...run, cancelRequested: true } });
    },

    requestEmptyTrashConfirmation: (workspaceId): void => {
      set({ emptyTrashConfirmationWorkspaceId: workspaceId });
    },

    recordArchivedOverviewRequest: (outcome): void => {
      set({ lastArchivedOverviewRequest: outcome });
    },

    dismissEmptyTrashConfirmation: (): void => {
      if (get().emptyTrashConfirmationWorkspaceId !== null) {
        set({ emptyTrashConfirmationWorkspaceId: null });
      }
    },

    registerPendingContainer: (pending): void => {
      const entry: PendingArchivedContainer = {
        ...pending,
        startedAt: Date.now(),
      };
      set((state) => {
        const current = state.pendingByWorkspace[pending.workspaceId] ?? [];
        return {
          pendingByWorkspace: {
            ...state.pendingByWorkspace,
            [pending.workspaceId]: [
              ...current.filter(
                (existing) => existing.containerId !== pending.containerId,
              ),
              entry,
            ],
          },
        };
      });
      // Counters read store data plus placeholders; load the summaries now
      // (they still lack the new container) so the sidebar's snapshot count
      // stops being the source of truth before the container lands.
      if (get().loadedWorkspaces[pending.workspaceId] !== true) {
        void get().loadForWorkspace(pending.workspaceId);
      }
    },

    clearPendingContainer: (workspaceId, containerId): void => {
      set((state) => {
        const current = state.pendingByWorkspace[workspaceId];
        if (current === undefined) return state;
        const remaining = current.filter(
          (entry) => entry.containerId !== containerId,
        );
        if (remaining.length === current.length) return state;
        if (remaining.length === 0) {
          const pendingByWorkspace = { ...state.pendingByWorkspace };
          delete pendingByWorkspace[workspaceId];
          return { pendingByWorkspace };
        }
        return {
          pendingByWorkspace: {
            ...state.pendingByWorkspace,
            [workspaceId]: remaining,
          },
        };
      });
    },

    selectTab: (tab): void => {
      const viewer = get().viewer;
      if (viewer === null || viewer.tab === tab) {
        return;
      }
      set({
        viewer: {
          ...viewer,
          tab,
          selectedChatId: undefined,
          selectedPlanId: undefined,
        },
      });
    },

    selectChat: (chatId): void => {
      const viewer = get().viewer;
      if (viewer === null) {
        return;
      }
      set({ viewer: { ...viewer, selectedChatId: chatId } });
    },

    selectPlan: (planId): void => {
      const viewer = get().viewer;
      if (viewer === null) {
        return;
      }
      set({ viewer: { ...viewer, selectedPlanId: planId } });
    },

    restore: async (
      workspaceId,
      containerId,
    ): Promise<ArchivedContainerRestoreResponse | null> => {
      // Pin the viewer for the whole restore + navigation window; the
      // caller's closeViewer() (after selecting the restored destination)
      // clears it, so the user sees one transition: viewer → destination.
      set({ restoringContainer: { workspaceId, containerId } });
      try {
        const result = await window.api.archivedContainers.restore({
          projectId: workspaceId,
          containerId,
        });
        await get().loadForWorkspace(workspaceId);
        await refreshAuthoritativeSidebarData([workspaceId]);
        const stillPresent =
          get().byWorkspace[workspaceId]?.some(
            (entry) => entry.id === containerId,
          ) ?? false;
        if (stillPresent) {
          // Partial restore: the viewer intentionally stays open, so release
          // the pin — a later background expiry/delete must close it again.
          set({ restoringContainer: null });
        }
        return result;
      } catch {
        set({ restoringContainer: null });
        return null;
      }
    },

    setLocked: async (
      workspaceId,
      containerId,
      locked,
    ): Promise<ArchivedContainerSummary | null> => {
      let updated: ArchivedContainerSummary;
      try {
        updated = await window.api.archivedContainers.setLocked({
          projectId: workspaceId,
          containerId,
          locked,
        });
      } catch {
        return null;
      }
      // Swap the returned summary in place; the broadcast-driven refresh will
      // reconcile anything else in the background.
      set((state) => {
        const summaries = state.byWorkspace[workspaceId];
        if (summaries === undefined) return state;
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: summaries.map((entry) =>
              entry.id === containerId ? updated : entry,
            ),
          },
        };
      });
      return updated;
    },

    deletePermanently: async (workspaceId, containerId): Promise<boolean> => {
      try {
        await window.api.archivedContainers.delete({
          projectId: workspaceId,
          containerId,
        });
      } catch {
        return false;
      }
      await get().settleDeleted(workspaceId, containerId);
      return true;
    },

    settleDeleted: async (workspaceId, containerId): Promise<void> => {
      const viewer = get().viewer;
      if (
        viewer?.workspaceId === workspaceId &&
        viewer.containerId === containerId
      ) {
        set({ viewer: null, restoringContainer: null });
      }
      await get().loadForWorkspace(workspaceId);
      await refreshAuthoritativeSidebarData([workspaceId]);
    },
  }),
);

if (__CANOPY_E2E__) {
  window.__canopyArchivedContainersTestApi = {
    holdNextLoadAfterRead: (): void => {
      if (e2eArchivedContainersLoadBarrier !== null) {
        throw new Error(
          'An archived-container load is already held for E2E automation.',
        );
      }
      let resolveReached = (): void => undefined;
      let resolveRelease = (): void => undefined;
      let resolveCompleted = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        resolveReached = resolve;
      });
      const release = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      const completed = new Promise<void>((resolve) => {
        resolveCompleted = resolve;
      });
      e2eArchivedContainersLoadBarrier = {
        claimed: false,
        reached,
        resolveReached,
        release,
        resolveRelease,
        completed,
        resolveCompleted,
      };
    },
    loadForWorkspace: (workspaceId): void => {
      void useArchivedContainersStore.getState().loadForWorkspace(workspaceId);
    },
    waitForHeldLoad: async (): Promise<void> => {
      const barrier = e2eArchivedContainersLoadBarrier;
      if (!barrier) {
        throw new Error(
          'No archived-container load is held for E2E automation.',
        );
      }
      await barrier.reached;
    },
    releaseHeldLoad: async (): Promise<void> => {
      const barrier = e2eArchivedContainersLoadBarrier;
      if (!barrier?.claimed) {
        throw new Error(
          'No archived-container load has reached the E2E hold point.',
        );
      }
      barrier.resolveRelease();
      await barrier.completed;
    },
    disableChangedRefresh: (): void => {
      resetArchivedContainersSubscriptionForTest();
    },
    getListReadCount: (): number => e2eArchivedContainersListReadCount,
    getTrailingLoadRequestCount: (): number =>
      e2eArchivedContainersTrailingLoadRequestCount,
    holdNextPendingRemoval: (): void => {
      if (e2ePendingRemovalBarrier !== null) {
        throw new Error('A removal is already held for E2E automation.');
      }
      let resolveReached = (): void => undefined;
      let resolveRelease = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        resolveReached = resolve;
      });
      const release = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      e2ePendingRemovalBarrier = {
        claimed: false,
        reached,
        resolveReached,
        release,
        resolveRelease,
      };
    },
    waitForHeldPendingRemoval: async (): Promise<void> => {
      const barrier = e2ePendingRemovalBarrier;
      if (!barrier) {
        throw new Error('No removal is held for E2E automation.');
      }
      await barrier.reached;
    },
    releaseHeldPendingRemoval: (): void => {
      const barrier = e2ePendingRemovalBarrier;
      if (!barrier?.claimed) {
        throw new Error('No removal has reached the E2E hold point.');
      }
      barrier.resolveRelease();
    },
    getPendingContainerCount: (workspaceId): number =>
      useArchivedContainersStore.getState().pendingByWorkspace[workspaceId]
        ?.length ?? 0,
    holdNextEmptyTrashBetweenItems: (): void => {
      if (e2eEmptyTrashBarrier !== null) {
        throw new Error(
          'An Empty trash run is already held for E2E automation.',
        );
      }
      let resolveReached = (): void => undefined;
      let resolveRelease = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        resolveReached = resolve;
      });
      const release = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      e2eEmptyTrashBarrier = {
        claimed: false,
        reached,
        resolveReached,
        release,
        resolveRelease,
      };
    },
    waitForHeldEmptyTrash: async (): Promise<void> => {
      const barrier = e2eEmptyTrashBarrier;
      if (!barrier) {
        throw new Error('No Empty trash run is held for E2E automation.');
      }
      await barrier.reached;
    },
    releaseHeldEmptyTrash: (): void => {
      const barrier = e2eEmptyTrashBarrier;
      if (!barrier?.claimed) {
        throw new Error('No Empty trash run has reached the E2E hold point.');
      }
      barrier.resolveRelease();
    },
  };
}

let unsubscribeChanged: (() => void) | null = null;

// A retention sweep broadcasts one changed event per purged container;
// coalesce the bursts so K expiries trigger one refresh round, not K full
// sidebar reloads.
const CHANGED_REFRESH_DEBOUNCE_MS = 250;
const pendingChangedWorkspaceIds = new Set<string>();
let changedRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function flushArchivedContainersChanged(): void {
  changedRefreshTimer = null;
  const workspaceIds = Array.from(pendingChangedWorkspaceIds);
  pendingChangedWorkspaceIds.clear();
  const state = useArchivedContainersStore.getState();
  for (const workspaceId of workspaceIds) {
    // Only workspaces someone has looked at need a summary refresh; the
    // authoritative sidebar refresh keeps counts/rows correct everywhere else
    // (including background expiry of a never-expanded subgroup).
    if (
      state.loadedWorkspaces[workspaceId] === true ||
      state.viewer?.workspaceId === workspaceId
    ) {
      void state.loadForWorkspace(workspaceId);
    }
  }
  void refreshAuthoritativeSidebarData(workspaceIds);
}

function handleArchivedContainersChanged(
  event: ArchivedContainersChangedEvent,
): void {
  pendingChangedWorkspaceIds.add(event.workspaceId);
  if (changedRefreshTimer === null) {
    changedRefreshTimer = setTimeout(
      flushArchivedContainersChanged,
      CHANGED_REFRESH_DEBOUNCE_MS,
    );
  }
}

/**
 * Idempotently subscribe to `archived-containers:changed` for the lifetime of
 * the app so background expiry updates the UI without user interaction.
 */
export function ensureArchivedContainersSubscription(): void {
  if (unsubscribeChanged !== null) {
    return;
  }
  // Isolated renderer/test hosts may expose a partial preload bridge.
  if (typeof window.api?.archivedContainers?.onChanged !== 'function') {
    return;
  }
  unsubscribeChanged = window.api.archivedContainers.onChanged(
    handleArchivedContainersChanged,
  );
}

/** Test-only: drop the changed-event subscription so hosts can re-subscribe. */
export function resetArchivedContainersSubscriptionForTest(): void {
  unsubscribeChanged?.();
  unsubscribeChanged = null;
  if (changedRefreshTimer !== null) {
    clearTimeout(changedRefreshTimer);
    changedRefreshTimer = null;
  }
  pendingChangedWorkspaceIds.clear();
}
