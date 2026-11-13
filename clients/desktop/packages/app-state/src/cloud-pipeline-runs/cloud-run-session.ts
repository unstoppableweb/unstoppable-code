import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  CORE_PIPELINE_ARTIFACT_READ_LENGTH_MAX,
  CORE_PIPELINE_STEP_LOG_READ_LIMIT_MAX,
  CanopyErrorPayloadSchema,
  CanopyStreamCursorSchema,
  CorePipelineArtifactReadResultSchema,
  CorePipelineStepLogReadResultSchema,
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
import { cloudErrorOf, requestCloud } from './request';

/**
 * One open cloud run (CAN-6326): its detail, live over the web core's
 * `worker.pipeline.execution.events` push, a step's full log read by
 * position with `core.pipeline.execution.stepLog.read` instead of the
 * bounded output the events carry, its saved reports through
 * `core.pipeline.execution.artifact.read`, and every CAN-4141 control.
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

/** Kinds after which the web core may have recorded the call anyway. */
const UNCERTAIN_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'unavailable',
  'deadline_exceeded',
  // A call cut off by its deadline: the client closes it as `cancelled`.
  'cancelled',
  'internal',
]);

function isUncertainOutcome(payload: CanopyErrorPayload): boolean {
  return (
    payload.retry.kind === 'same_idempotency_key' ||
    UNCERTAIN_KINDS.has(payload.kind)
  );
}

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

  const setView = (view: WorkerPipelineExecutionView): void => {
    const current = store.getState().view;
    // A summary-only view keeps the detail already read.
    const next =
      view.detail === undefined && current?.detail !== undefined
        ? { ...view, detail: current.detail }
        : view;
    store.setState({ view: next, error: null });
    onView?.(next);
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
    const ids = unsettled.get(key) ?? {
      requestId: randomId(),
      ...(options.newExecution === true ? { newExecutionId: randomId() } : {}),
    };
    unsettled.set(key, ids);
    try {
      const result = await send(ids);
      unsettled.delete(key);
      return result;
    } catch (error) {
      if (!isUncertainOutcome(cloudErrorOf(error))) unsettled.delete(key);
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
      rereadTimer = null;
      reopenTimer = null;
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
