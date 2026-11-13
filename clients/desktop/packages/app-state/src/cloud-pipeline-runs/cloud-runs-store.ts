import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  CLOUD_PIPELINE_RUN_TARGET_ID,
  WORKER_PIPELINE_TERMINAL_STATUSES,
  WorkerPipelineExecutionGetResultSchema,
  WorkerPipelineExecutionListResultSchema,
  type CanopyErrorPayload,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionListResult,
  type WorkerPipelineExecutionView,
} from '@canopy/protocol/canopy-core';
import type { CoreCoworkInvoker } from '../core-cowork/invoker';
import { cloudErrorOf, requestCloud } from './request';

/**
 * The signed-in account's cloud workflow runs (CAN-6326, plan CP-38), read
 * from the web core's `worker.pipeline.execution.list` (CAN-6214) through
 * the host's invoker: the renderer relay on desktop, the web core
 * connection on web (CP-39). Each run carries its detail projection, so rows
 * can say who started it.
 *
 * The list has no push of its own; while a surface holds it, it is read
 * again on a timer, sooner while a run is active. An open run's detail is
 * live over its events stream instead (see `cloud-run-session.ts`).
 */

/** One page; the web core's default. */
export const CLOUD_RUNS_PAGE_LIMIT = 50;
/** How soon the list is read again while a run is active, and otherwise. */
export const CLOUD_RUNS_ACTIVE_REFRESH_MS = 10_000;
export const CLOUD_RUNS_IDLE_REFRESH_MS = 60_000;
/** The most active runs from older pages one refresh reads again. */
export const CLOUD_RUNS_OLDER_ACTIVE_REFRESH_MAX = 20;

const TERMINAL: ReadonlySet<string> = new Set(
  WORKER_PIPELINE_TERMINAL_STATUSES,
);

export function isTerminalCloudRun(
  execution: Pick<WorkerPipelineExecution, 'status'>,
): boolean {
  return TERMINAL.has(execution.status);
}

export interface CloudPipelineRunsState {
  /** Newest first, as the web core lists them. */
  readonly runs: readonly WorkerPipelineExecutionView[];
  /** Where the next older page starts; `null` once every run is listed. */
  readonly nextCursor: string | null;
  /** The first read has settled, listed or failed. */
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  /** The last read failed; the runs listed before it are kept. */
  readonly error: CanopyErrorPayload | null;
}

export interface CloudPipelineRunsStore extends StoreApi<CloudPipelineRunsState> {
  /** Reads the newest page again, keeping older pages already loaded. */
  refresh(): Promise<void>;
  /** Reads the next older page. */
  loadMore(): Promise<void>;
  /** Patches one run from a read, an event or a control; a new run goes first. */
  upsert(view: WorkerPipelineExecutionView): void;
  /**
   * Lists the runs and keeps them current while at least one holder keeps
   * the returned release. Holders share one timer.
   */
  retain(): () => void;
  /**
   * Forgets every run, as when the signed-in account changes: reads started
   * before it are dropped, and a held list reads the new account's runs.
   */
  reset(): void;
  /**
   * Stops the timer for good: a release or a read that lands later
   * schedules nothing, and a later retain keeps nothing current. Explicit
   * reads still work.
   */
  dispose(): void;
}

export interface CloudPipelineRunsStoreOptions {
  readonly invoker: CoreCoworkInvoker;
  readonly setTimer?: (callback: () => void, ms: number) => Timer;
  readonly clearTimer?: (timer: Timer) => void;
}

type Timer = ReturnType<typeof setTimeout>;

const startedAt = (view: WorkerPipelineExecutionView): number =>
  Date.parse(view.execution.startedAt);

/**
 * The newest page over what was listed before: a run on the page replaces
 * its old entry, and older entries stay only when the page did not reach
 * back to them (more pages follow) and the page overlaps them. A page with
 * no run in common may have left a gap after it, so the older entries are
 * dropped and the page's own cursor reads them again.
 */
export function mergeCloudRunsPage(
  current: readonly WorkerPipelineExecutionView[],
  page: readonly WorkerPipelineExecutionView[],
  pageIsLast: boolean,
): {
  readonly runs: readonly WorkerPipelineExecutionView[];
  /** Older entries were kept, so the cursor already loaded still applies. */
  readonly keptOlder: boolean;
} {
  const listed = new Set(page.map((view) => view.execution.executionId));
  const oldest = page[page.length - 1];
  const overlaps = current.some((view) =>
    listed.has(view.execution.executionId),
  );
  const older =
    pageIsLast || oldest === undefined || !overlaps
      ? []
      : current.filter(
          (view) =>
            !listed.has(view.execution.executionId) &&
            startedAt(view) <= startedAt(oldest),
        );
  return { runs: [...page, ...older], keptOlder: older.length > 0 };
}

export function createCloudPipelineRunsStore({
  invoker,
  setTimer = (callback, ms): Timer => setTimeout(callback, ms),
  clearTimer = (timer): void => clearTimeout(timer),
}: CloudPipelineRunsStoreOptions): CloudPipelineRunsStore {
  const initial: CloudPipelineRunsState = {
    runs: [],
    nextCursor: null,
    loaded: false,
    loading: false,
    loadingMore: false,
    error: null,
  };
  const store = createStore<CloudPipelineRunsState>(() => initial);
  // Bumped by reset; a read answers only the epoch it started in.
  let epoch = 0;
  // Bumped whenever the cursor is replaced rather than kept, so a Load more
  // that started from the old cursor can't append past the new list.
  let cursorGeneration = 0;
  let refreshing: Promise<void> | null = null;
  let holders = 0;
  let timer: Timer | null = null;
  let disposed = false;

  const list = (cursor?: string): Promise<WorkerPipelineExecutionListResult> =>
    requestCloud(
      invoker,
      'worker.pipeline.execution.list',
      {
        scope: { targetId: CLOUD_PIPELINE_RUN_TARGET_ID },
        detail: true,
        limit: CLOUD_RUNS_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      },
      WorkerPipelineExecutionListResultSchema,
    );

  const schedule = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (disposed || holders === 0) return;
    const active = store
      .getState()
      .runs.some((view) => !isTerminalCloudRun(view.execution));
    timer = setTimer(
      () => {
        timer = null;
        void refresh();
      },
      active ? CLOUD_RUNS_ACTIVE_REFRESH_MS : CLOUD_RUNS_IDLE_REFRESH_MS,
    );
  };

  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing;
    store.setState({ loading: true });
    const started = epoch;
    refreshing = (async (): Promise<void> => {
      try {
        const page = await list();
        if (started !== epoch) return;
        const current = store.getState();
        const { runs, keptOlder } = mergeCloudRunsPage(
          current.runs,
          page.executions,
          page.nextCursor === null,
        );
        if (!keptOlder) cursorGeneration += 1;
        store.setState({
          runs,
          nextCursor: keptOlder ? current.nextCursor : page.nextCursor,
          // A Load more the new cursor dropped is no longer loading.
          ...(keptOlder ? {} : { loadingMore: false }),
          loaded: true,
          loading: false,
          error: null,
        });
        await refreshOlderActive(started, page.executions.length);
      } catch (error) {
        if (started !== epoch) return;
        store.setState({
          loaded: true,
          loading: false,
          error: cloudErrorOf(error),
        });
      } finally {
        // A reset dropped this read and may have started another.
        if (started === epoch) {
          refreshing = null;
          schedule();
        }
      }
    })();
    return refreshing;
  };

  /**
   * Reads again the active runs kept from older pages, which the newest
   * page doesn't carry, so their status doesn't stand still.
   */
  const refreshOlderActive = async (
    started: number,
    fromIndex: number,
  ): Promise<void> => {
    const active = store
      .getState()
      .runs.slice(fromIndex)
      .filter((view) => !isTerminalCloudRun(view.execution))
      .slice(0, CLOUD_RUNS_OLDER_ACTIVE_REFRESH_MAX);
    const views = await Promise.all(
      active.map((view) =>
        requestCloud(
          invoker,
          'worker.pipeline.execution.get',
          { executionId: view.execution.executionId, detail: true },
          WorkerPipelineExecutionGetResultSchema,
        ).catch(() => null),
      ),
    );
    if (started !== epoch) return;
    for (const view of views) if (view !== null) upsertQuietly(view);
  };

  const loadMore = async (): Promise<void> => {
    const { nextCursor, loadingMore } = store.getState();
    if (nextCursor === null || loadingMore) return;
    store.setState({ loadingMore: true });
    const started = epoch;
    const generation = cursorGeneration;
    const current = (): boolean =>
      started === epoch && generation === cursorGeneration;
    try {
      const page = await list(nextCursor);
      if (!current()) return;
      const listed = new Set(
        store.getState().runs.map((view) => view.execution.executionId),
      );
      store.setState({
        runs: [
          ...store.getState().runs,
          ...page.executions.filter(
            (view) => !listed.has(view.execution.executionId),
          ),
        ],
        nextCursor: page.nextCursor,
        loadingMore: false,
        error: null,
      });
    } catch (error) {
      if (!current()) return;
      store.setState({ loadingMore: false, error: cloudErrorOf(error) });
    }
  };

  const upsertQuietly = (view: WorkerPipelineExecutionView): void => {
    const runs = store.getState().runs;
    const index = runs.findIndex(
      (entry) => entry.execution.executionId === view.execution.executionId,
    );
    // A summary-only view keeps the detail already listed.
    const merged =
      index === -1 || view.detail !== undefined
        ? view
        : { ...view, detail: runs[index]?.detail };
    store.setState({
      runs:
        index === -1
          ? [merged, ...runs]
          : runs.map((entry, at) => (at === index ? merged : entry)),
    });
  };

  const upsert = (view: WorkerPipelineExecutionView): void => {
    upsertQuietly(view);
    schedule();
  };

  return {
    ...store,
    refresh,
    loadMore,
    upsert,
    retain: (): (() => void) => {
      if (disposed) return (): void => {};
      holders += 1;
      if (holders === 1) void refresh();
      let released = false;
      return (): void => {
        if (released || disposed) return;
        released = true;
        holders -= 1;
        if (holders === 0) schedule();
      };
    },
    reset: (): void => {
      epoch += 1;
      refreshing = null;
      store.setState(initial);
      if (holders > 0) void refresh();
      else schedule();
    },
    dispose: (): void => {
      disposed = true;
      holders = 0;
      schedule();
    },
  };
}
