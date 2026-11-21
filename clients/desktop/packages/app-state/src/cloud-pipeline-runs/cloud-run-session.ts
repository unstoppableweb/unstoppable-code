import type { z } from 'zod';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  CORE_PIPELINE_ARTIFACT_READ_LENGTH_MAX,
  CORE_PIPELINE_STEP_LOG_READ_LIMIT_MAX,
  CanopyErrorPayloadSchema,
  CanopyStreamCursorSchema,
  CorePipelineArtifactReadResultSchema,
  CorePipelineStepLogReadResultSchema,
  CostCloudRunGetResultSchema,
  WorkerPipelineControlResultSchema,
  WorkerPipelineExecutionEventsItemSchema,
  WorkerPipelineExecutionGetResultSchema,
  WorkerPipelineExecutionResultSchema,
  isCanopySnapshotRequiredError,
  type CanopyErrorPayload,
  type CanopyStreamCursor,
  type CorePipelineArtifactReadResult,
  type CorePipelineStepLogEntry,
  type CorePipelineStepLogReadResult,
  type WorkerPipelineArtifact,
  type WorkerPipelineControlResult,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionView,
  type WorkerPipelinePauseResponse,
} from '@canopy/protocol/canopy-core';
import type {
  CoreCoworkInvoker,
  CoreCoworkStream,
} from '../core-cowork/invoker';
import { isTerminalCloudRun } from './cloud-runs-store';
import { cloudErrorOf, isOutcomeUnknown, requestCloud } from './request';

/**
 * One open cloud run (CAN-6326): its detail, live over the web core's
 * `worker.pipeline.execution.events` push, a step's full log read by
 * position with `core.pipeline.execution.stepLog.read` instead of the
 * bounded output the events carry, its saved reports through
 * `core.pipeline.execution.artifact.read`, what it was charged through
 * `core.cost.cloudRun.get` (CAN-6881), and every CAN-4141 control.
 *
 * Output and gap items only say there is more to read: the log itself is
 * always read by index, so a line is never shown twice or out of order.
 */

/** The most log lines one view keeps before Load more asks for the rest. */
export const CLOUD_RUN_LOG_LINES_MAX = 20_000;
/** The most bytes one report read keeps. */
export const CLOUD_RUN_ARTIFACT_BYTES_MAX = 16 * 1024 * 1024;
/** How long events are gathered before the detail is read again. */
const DETAIL_REREAD_MS = 250;
/**
 * How often an open run's cost is read again (CAN-6881): its model calls
 * settle as it runs, and its sandbox is settled after it ends, with no
 * status change to read it on.
 */
export const CLOUD_RUN_COST_REREAD_MS = 60_000;
/**
 * How often the child runs a run's steps started are read again while any
 * has not ended (CAN-6868): a child's events go to its own stream, so a
 * child that pauses or ends while its parent waits changes nothing the
 * parent's stream sends; a read that failed is tried again then too.
 */
export const CLOUD_RUN_CHILD_REREAD_MS = 10_000;
/** A step's statuses after which it starts no child. */
const STEP_ENDED: ReadonlySet<string> = new Set([
  'success',
  'failure',
  'cancelled',
  'skipped',
]);
/** Stream reopens in a row that may fail before the run reads offline. */
const STREAM_REOPENS_MAX = 3;
const STREAM_REOPEN_MS = 2_000;
/** A stream open this long was healthy; its end starts the count again. */
const STREAM_HEALTHY_MS = 30_000;

export type CloudPipelineRunControl =
  | 'cancel'
  | 'resume'
  | 'retry'
  | 'rerun'
  | 'matrix-retry'
  | 'variant-cancel';

export interface CloudPipelineRunLog {
  /** The physical job: a matrix variant's own id. */
  readonly jobId: string;
  readonly stepId: string;
  /** In index order; an index the run recorded without its text is skipped. */
  readonly entries: readonly CorePipelineStepLogEntry[];
  /** Where the next read starts. */
  readonly nextIndex: number;
  /** The run ended and every line was read. */
  readonly complete: boolean;
  readonly loading: boolean;
  /** More lines may follow than this view keeps; Load more reads them. */
  readonly capped: boolean;
  readonly error: CanopyErrorPayload | null;
}

/** What a run was charged, as its ledger records it (CAN-6881). */
export interface CloudPipelineRunCost {
  /** Null until read, and while the web core serves no run cost. */
  readonly view: z.output<typeof CostCloudRunGetResultSchema> | null;
  /** The web core doesn't serve a run's cost: nothing is shown. */
  readonly unavailable: boolean;
}

/** Where the events stream stands. */
export type CloudPipelineRunLiveState =
  | 'connecting'
  | 'live'
  | 'ended'
  | 'offline';

export interface CloudPipelineRunSessionState {
  readonly executionId: string;
  readonly view: WorkerPipelineExecutionView | null;
  readonly loading: boolean;
  /** The run could not be read. */
  readonly error: CanopyErrorPayload | null;
  readonly live: CloudPipelineRunLiveState;
  readonly log: CloudPipelineRunLog | null;
  /** Controls in flight. */
  readonly pending: Readonly<Partial<Record<CloudPipelineRunControl, true>>>;
  /** The last control's refusal, in the cloud's words. */
  readonly controlError: string | null;
  /**
   * A control of this run may have been applied though it failed (CAN-7196):
   * set while any of its keyed calls is unknown, cleared only by a result.
   */
  readonly controlUnknown: boolean;
  readonly cost: CloudPipelineRunCost;
  /**
   * The child runs its `run-pipeline` steps started (CAN-6868), by
   * execution id, as each was last read: its workflow name and status. A
   * child that could not be read yet is absent.
   */
  readonly children: Readonly<Record<string, WorkerPipelineExecution>>;
}

export interface CloudPipelineRunArtifactContent {
  readonly artifact: WorkerPipelineArtifact;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly text: string;
  /** The report is larger than this read keeps. */
  readonly truncated: boolean;
}

export interface CloudPipelineRunSession extends StoreApi<CloudPipelineRunSessionState> {
  /** Reads the run and follows its events until `close`. */
  open(): void;
  close(): void;
  /** Closed: answers that arrive now belong to a detail that went away. */
  isClosed(): boolean;
  /** Reads one step's log from its first line. */
  selectStep(jobId: string, stepId: string): void;
  /** Reads past the lines this view keeps. */
  loadMoreLog(): void;
  readArtifact(
    artifact: WorkerPipelineArtifact,
  ): Promise<CloudPipelineRunArtifactContent>;
  cancel(): Promise<void>;
  /** Resumes the run, answering its pending input requests when given. */
  resume(
    pauseResponses?: readonly WorkerPipelinePauseResponse[],
  ): Promise<void>;
  /** Runs the failed work again in place. */
  retry(): Promise<void>;
  /** Starts the pinned snapshot over as a new run; resolves with its id. */
  rerun(): Promise<string>;
  retryMatrixJob(
    jobId: string,
    mode: 'all' | 'failed' | 'variants',
    variantJobIds?: readonly string[],
  ): Promise<void>;
  cancelMatrixVariant(jobId: string, variantJobId: string): Promise<void>;
}

export interface CloudPipelineRunSessionOptions {
  readonly invoker: CoreCoworkInvoker;
  readonly executionId: string;
  /** Called with every newer read of the run, for the list to follow. */
  readonly onView?: (view: WorkerPipelineExecutionView) => void;
  readonly randomId?: () => string;
  /** Shared across sessions; the session keeps its own when absent. */
  readonly controlKeys?: CloudRunControlKeys;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => Timer;
  readonly clearTimer?: (timer: Timer) => void;
}

type Timer = ReturnType<typeof setTimeout>;

export interface UnsettledIds {
  readonly requestId: string;
  readonly newExecutionId?: string;
}

/**
 * The ids of each control whose outcome is unknown, by run, method and
 * params. Hosts share one between every session of an account, so a control
 * sent again from another surface (a row, then the run's detail) replays.
 */
export type CloudRunControlKeys = Map<string, UnsettledIds>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Frame =
  | { kind: 'item'; cursor: CanopyStreamCursor; item: unknown }
  | { kind: 'end'; error: CanopyErrorPayload | null };

function toFrame(value: unknown): Frame {
  if (!isRecord(value)) return { kind: 'end', error: null };
  if (value.kind === 'item') {
    const cursor = CanopyStreamCursorSchema.safeParse(value.cursor);
    if (cursor.success)
      return { kind: 'item', cursor: cursor.data, item: value.item };
  }
  const error = CanopyErrorPayloadSchema.safeParse(value.error);
  return { kind: 'end', error: error.success ? error.data : null };
}

/** Base64 to bytes without Node's Buffer, so the browser reads it too. */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function createCloudPipelineRunSession({
  invoker,
  executionId,
  onView,
  randomId = (): string => crypto.randomUUID(),
  controlKeys = new Map(),
  now = (): number => Date.now(),
  setTimer = (callback, ms): Timer => setTimeout(callback, ms),
  clearTimer = (timer): void => clearTimeout(timer),
}: CloudPipelineRunSessionOptions): CloudPipelineRunSession {
  const store = createStore<CloudPipelineRunSessionState>(() => ({
    executionId,
    view: null,
    loading: false,
    error: null,
    live: 'connecting',
    log: null,
    pending: {},
    controlError: null,
    controlUnknown: false,
    cost: { view: null, unavailable: false },
    children: {},
  }));
  let opened = false;
  let closed = false;
  let stream: CoreCoworkStream | null = null;
  let cursor: CanopyStreamCursor | null = null;
  let rereadTimer: Timer | null = null;
  let reopenTimer: Timer | null = null;
  // Each selected step's reads carry its generation; a newer selection
  // leaves the older reads' answers unused.
  let logGeneration = 0;
  let logReading = false;
  let logAgain = false;
  // Detail reads overlap (open, events, controls); only a newer one applies.
  let detailRequested = 0;
  let detailApplied = 0;
  let following = false;
  const unsettled = controlKeys;

  // The run's cost is read when the run opens, whenever its status changes,
  // and every CLOUD_RUN_COST_REREAD_MS while the session is open, so charges
  // settled after the run ended show too; only a newer read applies.
  let costRequested = 0;
  let costStatus: string | null = null;
  let costTimer: Timer | null = null;
  const scheduleCost = (): void => {
    if (closed || costTimer !== null || store.getState().cost.unavailable)
      return;
    costTimer = setTimer(() => {
      costTimer = null;
      void readCost();
    }, CLOUD_RUN_COST_REREAD_MS);
  };
  const readCost = async (): Promise<void> => {
    const seq = ++costRequested;
    try {
      const view = await requestCloud(
        invoker,
        'core.cost.cloudRun.get',
        { executionId },
        CostCloudRunGetResultSchema,
      );
      if (closed || seq !== costRequested) return;
      store.setState({ cost: { view, unavailable: false } });
    } catch (error) {
      if (closed || seq !== costRequested) return;
      // A web core that serves no run cost shows none; any other failure
      // keeps what was shown, and the next status change reads it again.
      if (cloudErrorOf(error).kind === 'capability_unavailable')
        store.setState({ cost: { view: null, unavailable: true } });
    } finally {
      scheduleCost();
    }
  };

  /** The child reads in flight, by execution id. */
  const childReads = new Set<string>();
  /**
   * Children the web core answered `not_found` for after their step had
   * ended: most likely never started (refused), so not read again on the
   * timer, only once more with each newer detail. The runner names a child
   * before its record exists, so a miss while its step runs counts for
   * nothing, and any successful read clears the mark.
   */
  const childrenMissing = new Set<string>();
  // Bumped as a newer detail clears the misses: a miss from a read sent
  // before it is stale, and that child is read again instead.
  let missGeneration = 0;
  let childTimer: Timer | null = null;
  const scheduleChildren = (): void => {
    if (closed || childTimer !== null) return;
    childTimer = setTimer(() => {
      childTimer = null;
      const view = store.getState().view;
      if (view !== null) readChildren(view);
    }, CLOUD_RUN_CHILD_REREAD_MS);
  };

  /**
   * Reads each child run a step of `view` names that is not known to have
   * ended: its name and status show under the step that started it. Runs
   * as the run's own view changes, and every CLOUD_RUN_CHILD_REREAD_MS
   * while a child has not been read as ended.
   */
  const readChildren = (view: WorkerPipelineExecutionView): void => {
    const known = store.getState().children;
    let anyOpen = false;
    for (const job of view.detail?.jobs ?? [])
      for (const variant of job.variants)
        for (const step of variant.steps) {
          const childId = step.childExecutionId;
          if (
            childId === null ||
            (childrenMissing.has(childId) && STEP_ENDED.has(step.status))
          )
            continue;
          const read = known[childId];
          if (read !== undefined && isTerminalCloudRun(read)) continue;
          anyOpen = true;
          if (childReads.has(childId)) continue;
          childReads.add(childId);
          // Only a read sent after its step ended can show the child never
          // started; one sent while it ran may come before its record.
          const stepEnded = STEP_ENDED.has(step.status);
          const generation = missGeneration;
          void requestCloud(
            invoker,
            'worker.pipeline.execution.get',
            { executionId: childId },
            WorkerPipelineExecutionGetResultSchema,
          )
            .then((child) => {
              if (closed) return;
              childrenMissing.delete(childId);
              store.setState({
                children: {
                  ...store.getState().children,
                  [childId]: child.execution,
                },
              });
            })
            // An unreadable child stays as it was until it is read again.
            .catch((error: unknown) => {
              if (
                stepEnded &&
                generation === missGeneration &&
                cloudErrorOf(error).kind === 'not_found'
              )
                childrenMissing.add(childId);
            })
            .finally(() => {
              childReads.delete(childId);
              const current = store.getState().view;
              if (!closed && generation !== missGeneration && current !== null)
                readChildren(current);
            });
        }
    if (anyOpen) scheduleChildren();
  };

  const setView = (view: WorkerPipelineExecutionView): void => {
    if (view.execution.status !== costStatus) {
      costStatus = view.execution.status;
      if (!store.getState().cost.unavailable) void readCost();
    }
    const current = store.getState().view;
    // A summary-only view keeps the detail already read.
    const next =
      view.detail === undefined && current?.detail !== undefined
        ? { ...view, detail: current.detail }
        : view;
    // A newer detail may come with a child recorded after its step ended:
    // each child missed so far is read once more.
    if (
      view.detail !== undefined &&
      view.detail.revision !== current?.detail?.revision
    ) {
      childrenMissing.clear();
      missGeneration += 1;
    }
    store.setState({ view: next, error: null });
    onView?.(next);
    readChildren(next);
  };

  const readDetail = async (): Promise<void> => {
    const seq = ++detailRequested;
    try {
      const view = await requestCloud(
        invoker,
        'worker.pipeline.execution.get',
        { executionId, detail: true },
        WorkerPipelineExecutionGetResultSchema,
      );
      if (closed || seq < detailApplied) return;
      detailApplied = seq;
      setView(view);
    } catch (error) {
      // A read that fails after the run was shown keeps what was shown.
      if (!closed && store.getState().view === null)
        store.setState({ error: cloudErrorOf(error) });
    } finally {
      if (!closed && seq === detailRequested)
        store.setState({ loading: false });
    }
  };

  const scheduleReread = (): void => {
    if (closed || rereadTimer !== null) return;
    rereadTimer = setTimer(() => {
      rereadTimer = null;
      void readDetail();
    }, DETAIL_REREAD_MS);
  };

  /** Reads the selected log forward until it is caught up or capped. */
  const readLog = async (generation: number): Promise<void> => {
    if (logReading) {
      logAgain = true;
      return;
    }
    logReading = true;
    try {
      do {
        logAgain = false;
        for (;;) {
          const log = store.getState().log;
          if (closed || generation !== logGeneration || log === null) return;
          if (log.entries.length >= CLOUD_RUN_LOG_LINES_MAX) {
            store.setState({ log: { ...log, capped: true, loading: false } });
            return;
          }
          store.setState({ log: { ...log, loading: true } });
          let page: CorePipelineStepLogReadResult;
          try {
            page = await requestCloud(
              invoker,
              'core.pipeline.execution.stepLog.read',
              {
                executionId,
                jobId: log.jobId,
                stepId: log.stepId,
                fromIndex: log.nextIndex,
                limit: CORE_PIPELINE_STEP_LOG_READ_LIMIT_MAX,
              },
              CorePipelineStepLogReadResultSchema,
            );
          } catch (error) {
            const current = store.getState().log;
            if (generation === logGeneration && current !== null)
              store.setState({
                log: { ...current, loading: false, error: cloudErrorOf(error) },
              });
            return;
          }
          const current = store.getState().log;
          if (closed || generation !== logGeneration || current === null)
            return;
          const advanced = page.nextIndex > current.nextIndex;
          store.setState({
            log: {
              ...current,
              entries: [...current.entries, ...page.entries],
              nextIndex: Math.max(current.nextIndex, page.nextIndex),
              complete: page.complete,
              loading: false,
              capped: false,
              error: null,
            },
          });
          if (page.complete || !advanced || page.entries.length === 0) break;
        }
      } while (logAgain && !closed && generation === logGeneration);
    } finally {
      logReading = false;
      // A read asked for while another selection's read ran starts now.
      if (logAgain && !closed) {
        logAgain = false;
        void readLog(logGeneration);
      }
    }
  };

  const onEvent = (raw: unknown): void => {
    const item = WorkerPipelineExecutionEventsItemSchema.safeParse(raw);
    if (!item.success) return;
    const event = item.data;
    if (event.kind === 'execution') {
      const current = store.getState().view;
      setView({ execution: event.execution, detail: current?.detail });
      scheduleReread();
      // A step may have started or ended: its log may have more.
      const log = store.getState().log;
      if (log !== null && !log.complete) void readLog(logGeneration);
      return;
    }
    const log = store.getState().log;
    if (log === null || log.capped) return;
    if (
      event.kind === 'gap' ||
      (event.kind === 'output' &&
        event.jobId === log.jobId &&
        event.stepId === log.stepId)
    )
      void readLog(logGeneration);
  };

  const ended = (): boolean => {
    const execution = store.getState().view?.execution;
    return execution !== undefined && isTerminalCloudRun(execution);
  };

  /** Waits out a reopen's backoff; false once closed meanwhile. */
  const backOff = async (failures: number): Promise<boolean> => {
    await new Promise<void>((resolve) => {
      reopenTimer = setTimer(resolve, STREAM_REOPEN_MS * failures);
    });
    reopenTimer = null;
    return !closed;
  };

  const follow = async (): Promise<void> => {
    // Failed opens and streams that end early, in a row. Only a stream that
    // stayed open a while resets the count, so one that fails right after
    // its snapshot can't reopen without end.
    let failures = 0;
    const failed = async (): Promise<boolean> => {
      failures += 1;
      if (failures >= STREAM_REOPENS_MAX) {
        store.setState({ live: 'offline' });
        return false;
      }
      store.setState({ live: 'connecting' });
      return backOff(failures);
    };
    while (!closed) {
      try {
        stream = await invoker.openStream('worker.pipeline.execution.events', {
          executionId,
          cursor,
        });
      } catch (error) {
        const payload = cloudErrorOf(error);
        if (isCanopySnapshotRequiredError(payload) && cursor !== null)
          cursor = null;
        else if (payload.retry.kind === 'never') {
          store.setState({ live: 'offline' });
          return;
        }
        if (!(await failed())) return;
        continue;
      }
      if (closed) {
        void stream.close().catch(() => undefined);
        return;
      }
      const openedAt = now();
      store.setState({ live: 'live' });
      let error: CanopyErrorPayload | null = null;
      for (;;) {
        const next = await stream.next();
        if (closed) return;
        const frame: Frame = next.done
          ? { kind: 'end', error: null }
          : toFrame(next.value);
        if (frame.kind === 'end') {
          error = frame.error;
          break;
        }
        cursor = frame.cursor;
        onEvent(frame.item);
      }
      void stream.close().catch(() => undefined);
      stream = null;
      if (now() - openedAt >= STREAM_HEALTHY_MS) failures = 0;
      if (error !== null && isCanopySnapshotRequiredError(error)) {
        cursor = null;
        if (!(await failed())) return;
        continue;
      }
      // The stream ends with the run; read it once more for its last detail.
      await readDetail();
      if (ended()) {
        store.setState({ live: 'ended' });
        return;
      }
      if (!(await failed())) return;
    }
  };

  /** Follows the run's events unless a follow is already running. */
  const startFollowing = (): void => {
    if (following || closed) return;
    following = true;
    store.setState({ live: 'connecting' });
    void follow().finally(() => {
      following = false;
    });
  };

  const withControl = async <T>(
    control: CloudPipelineRunControl,
    run: () => Promise<T>,
  ): Promise<T> => {
    store.setState({
      pending: { ...store.getState().pending, [control]: true },
      controlError: null,
    });
    try {
      return await run();
    } catch (error) {
      store.setState({ controlError: cloudErrorOf(error).message });
      throw error;
    } finally {
      const rest = { ...store.getState().pending };
      delete rest[control];
      store.setState({ pending: rest });
    }
  };

  /** This session's keyed calls whose outcome is unknown. */
  const unknownKeys = new Set<string>();
  const markUnknown = (key: string, unknown: boolean): void => {
    if (unknown) unknownKeys.add(key);
    else unknownKeys.delete(key);
    store.setState({ controlUnknown: unknownKeys.size > 0 });
  };

  /**
   * A keyed call. Its ids are kept while its outcome is unknown, so sending
   * the same control again replays it instead of acting twice (a second
   * Start over would record a second run); a settled call drops them.
   */
  const keyed = async <Result>(
    method: string,
    params: Record<string, unknown>,
    send: (ids: UnsettledIds) => Promise<Result>,
    options: { readonly newExecution?: boolean } = {},
  ): Promise<Result> => {
    const key = `${method}\u0000${JSON.stringify(params)}`;
    // Ids already kept mean an earlier send of this call ended unknown: it
    // stays unknown whatever this one is answered (CAN-7196), so only a
    // result drops them.
    const earlier = unsettled.get(key);
    const ids = earlier ?? {
      requestId: randomId(),
      ...(options.newExecution === true ? { newExecutionId: randomId() } : {}),
    };
    unsettled.set(key, ids);
    try {
      const result = await send(ids);
      unsettled.delete(key);
      markUnknown(key, false);
      return result;
    } catch (error) {
      const unknown = earlier !== undefined || isOutcomeUnknown(error);
      if (!unknown) unsettled.delete(key);
      markUnknown(key, unknown);
      throw error;
    }
  };

  /** A keyed control: its request id is also its idempotency key. */
  const control = (
    method: string,
    params: Record<string, unknown>,
    options: { readonly newExecution?: boolean } = {},
  ): Promise<WorkerPipelineControlResult> =>
    keyed(
      method,
      params,
      (ids) =>
        requestCloud(
          invoker,
          method,
          {
            ...params,
            requestId: ids.requestId,
            ...(ids.newExecutionId === undefined
              ? {}
              : { newExecutionId: ids.newExecutionId }),
            _meta: { idempotencyKey: ids.requestId },
          },
          WorkerPipelineControlResultSchema,
        ),
      options,
    );

  const applyControl = (execution: WorkerPipelineExecution): void => {
    if (execution.executionId !== executionId) return;
    setView({ execution, detail: store.getState().view?.detail });
    scheduleReread();
    // Try again and resume run an ended run again under the same id; its
    // events stream ended with it, so follow the run again.
    if (!isTerminalCloudRun(execution)) startFollowing();
  };

  return {
    ...store,
    open: (): void => {
      if (opened || closed) return;
      opened = true;
      store.setState({ loading: true });
      void readDetail();
      startFollowing();
    },
    isClosed: (): boolean => closed,
    close: (): void => {
      if (closed) return;
      closed = true;
      if (rereadTimer !== null) clearTimer(rereadTimer);
      if (reopenTimer !== null) clearTimer(reopenTimer);
      if (costTimer !== null) clearTimer(costTimer);
      if (childTimer !== null) clearTimer(childTimer);
      rereadTimer = null;
      reopenTimer = null;
      costTimer = null;
      childTimer = null;
      const current = stream;
      stream = null;
      if (current) void current.close().catch(() => undefined);
    },
    selectStep: (jobId, stepId): void => {
      const log = store.getState().log;
      if (log !== null && log.jobId === jobId && log.stepId === stepId) return;
      logGeneration += 1;
      store.setState({
        log: {
          jobId,
          stepId,
          entries: [],
          nextIndex: 0,
          complete: false,
          loading: true,
          capped: false,
          error: null,
        },
      });
      void readLog(logGeneration);
    },
    loadMoreLog: (): void => {
      const log = store.getState().log;
      if (log === null) return;
      // Past the cap, the view keeps the newest lines it reads.
      store.setState({
        log: {
          ...log,
          entries: log.entries.slice(-CLOUD_RUN_LOG_LINES_MAX / 2),
          capped: false,
          error: null,
        },
      });
      void readLog(logGeneration);
    },
    readArtifact: async (
      artifact,
    ): Promise<CloudPipelineRunArtifactContent> => {
      const read = (offset: number): Promise<CorePipelineArtifactReadResult> =>
        requestCloud(
          invoker,
          'core.pipeline.execution.artifact.read',
          {
            executionId,
            artifact,
            offset,
            length: CORE_PIPELINE_ARTIFACT_READ_LENGTH_MAX,
          },
          CorePipelineArtifactReadResultSchema,
        );
      const first = await read(0);
      const chunks: Uint8Array[] = [decodeBase64(first.data)];
      let offset = chunks[0]?.length ?? 0;
      let eof = first.eof;
      while (!eof && offset > 0 && offset < CLOUD_RUN_ARTIFACT_BYTES_MAX) {
        const next = await read(offset);
        const bytes = decodeBase64(next.data);
        if (bytes.length === 0) break;
        chunks.push(bytes);
        offset += bytes.length;
        eof = next.eof;
      }
      const joined = new Uint8Array(offset);
      let at = 0;
      for (const chunk of chunks) {
        joined.set(chunk, at);
        at += chunk.length;
      }
      return {
        artifact: first.artifact,
        contentType: first.contentType,
        sizeBytes: first.sizeBytes,
        text: new TextDecoder().decode(joined),
        truncated: !eof,
      };
    },
    cancel: (): Promise<void> =>
      withControl('cancel', async () => {
        const method = 'worker.pipeline.execution.cancel';
        const result = await keyed(method, { executionId }, (ids) =>
          requestCloud(
            invoker,
            method,
            { executionId, _meta: { idempotencyKey: ids.requestId } },
            WorkerPipelineExecutionResultSchema,
          ),
        );
        applyControl(result.execution);
      }),
    resume: (pauseResponses): Promise<void> =>
      withControl('resume', async () => {
        const result = await control('worker.pipeline.execution.resume', {
          executionId,
          initiationSource: 'user',
          ...(pauseResponses === undefined || pauseResponses.length === 0
            ? {}
            : { pauseResponses }),
        });
        applyControl(result.execution);
      }),
    retry: (): Promise<void> =>
      withControl('retry', async () => {
        const result = await control('worker.pipeline.execution.retry', {
          executionId,
          mode: 'failed_only',
          initiationSource: 'user',
        });
        applyControl(result.execution);
      }),
    rerun: (): Promise<string> =>
      withControl('rerun', async () => {
        const result = await control(
          'worker.pipeline.execution.retry',
          { executionId, mode: 'from_start', initiationSource: 'user' },
          { newExecution: true },
        );
        onView?.({ execution: result.execution });
        return result.execution.executionId;
      }),
    retryMatrixJob: (jobId, mode, variantJobIds): Promise<void> =>
      withControl('matrix-retry', async () => {
        const result = await control('worker.pipeline.matrixJob.retry', {
          executionId,
          jobId,
          mode,
          ...(variantJobIds === undefined || variantJobIds.length === 0
            ? {}
            : { variantJobIds }),
        });
        applyControl(result.execution);
      }),
    cancelMatrixVariant: (jobId, variantJobId): Promise<void> =>
      withControl('variant-cancel', async () => {
        const result = await control('worker.pipeline.matrixVariant.cancel', {
          executionId,
          jobId,
          variantJobId,
        });
        applyControl(result.execution);
      }),
  };
}
