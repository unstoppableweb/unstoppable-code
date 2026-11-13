import type { RedeemedExecutionSecrets } from '@canopy/core-runtime/node/execution-secrets';
import {
  PipelineDrainTimeoutError,
  pipelineCheckpointFailedError,
  pipelineControlFailedError,
  pipelineExecutionNotFoundError,
  pipelineLaunchUnavailableError,
  pipelineStartFailedError,
  type PipelineControlRequest,
  type PipelineExecutionObserver,
  type PipelineExecutionWorker,
} from '@canopy/core-runtime/node/pipeline';
import type { WorkerPipelineControlOutcome } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  cancelPipelineExecution,
  executePipeline,
  listExecutionSummaries,
  loadExecutionState,
  rerunPipelineExecution,
  resumePipeline,
  retryMatrixJobExecution,
  retryPipelineExecution,
  type ExecutionEvent,
  type ExecutionHandle,
  type ExecutionOptions,
  type StepOutputEvent,
} from '@canopy/execution-engine/node/pipelines/executor';
import { requestExecutionCancellation } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import type { ExecutionRuntime } from '@canopy/execution-engine/node/pipelines/executor/types';
import type {
  ExecutionState,
  Pipeline,
} from '@canopy/execution-engine/types/pipeline';
import { recoverOrphanedPipelineExecutions } from '@canopy/execution-engine/node/pipelines/executor/crash-recovery';
import {
  projectPipelineExecution,
  projectPipelineExecutionView,
} from '@canopy/execution-engine/node/pipelines/execution-projection';
import { listPipelineExecutionPage } from '@canopy/execution-engine/node/pipelines/execution-list';
import { getDaemonPipelineExecutionHandle } from './daemon-pipeline-execution';
import type {
  DaemonPipelineLaunch,
  DaemonPipelineStartResult,
} from './daemon-pipeline-route';
export {
  definitionSourceOf,
  projectPipelineExecution,
} from '@canopy/execution-engine/node/pipelines/execution-projection';
import {
  getActiveExecutionHandle,
  getInProcessPipelineExecutionCount,
  pauseAllActivePipelineExecutions,
} from './pipeline-execution-registry';

/*
 * The desktop's local pipeline worker (CAN-4140): `worker.pipeline.execution.*`
 * over the existing Electron execution runtime. Core's start path resolves,
 * authorizes and admits a run, stages its launch here, then dispatches the
 * start through the local worker. The launch keeps what the executor needs
 * that is not portable yet (public environment, packages, observers); secrets
 * are redeemed bindings. The daemon route replaces the staged launch (CAN-5086).
 */

/** What core prepared for one execution: the admitted snapshot and options. */
export interface PipelineLaunch {
  readonly pipeline: Pipeline;
  readonly options: ExecutionOptions;
  /** The host-local launch for the daemon, when the start's route took it (CAN-5086). */
  readonly daemon?: DaemonPipelineLaunch;
}

/** What one recovery control did on the host. */
export interface PipelineControlSettlement {
  readonly outcome: WorkerPipelineControlOutcome;
  readonly state: ExecutionState;
}

/**
 * What core prepared for one recovery control (CAN-4141): the host side of
 * the existing entry point, which still holds what isn't portable yet (the
 * public environment, working folder and observers). It acts on the
 * command it is given, which is the dispatched one.
 */
export type PipelineControlLaunch = (
  control: PipelineControlRequest,
  signal: AbortSignal,
  secrets: RedeemedExecutionSecrets,
) => Promise<PipelineControlSettlement>;

/** Host-side results of a dispatched request, for the legacy callers. */
interface HostCapture {
  handle?: ExecutionHandle;
  state?: ExecutionState;
  error?: unknown;
}

/** A settled cancel, numbered so a caller reads only one it waited for. */
interface CancelCapture extends HostCapture {
  readonly sequence: number;
}

/**
 * Subscribers of each execution. They outlive one executor handle: a resume
 * runs on a new handle, which `attachPipelineHandle` joins them to, and a
 * durable cancel of a paused execution, which no handle reports, reaches
 * them from the cancel.
 */
interface Subscriber {
  readonly observer: PipelineExecutionObserver;
  readonly handles: Map<ExecutionHandle, () => void>;
}
const subscribers = new Map<string, Set<Subscriber>>();

function attachSubscriber(
  subscriber: Subscriber,
  handle: ExecutionHandle,
): void {
  if (subscriber.handles.has(handle) || !handle.addObservers) return;
  const { observer } = subscriber;
  subscriber.handles.set(
    handle,
    // A handle also carries its nested runs' events; those are theirs.
    handle.addObservers({
      onEvent: (event) => {
        if (event.executionId !== handle.id) return;
        observer.onExecution(event.type, projectPipelineExecution(event.state));
      },
      onStepOutput: (event) => {
        if (event.executionId !== handle.id) return;
        observer.onOutput({
          jobId: event.jobId,
          stepId: event.stepId,
          attempt: event.attempt,
          ...(event.iteration !== undefined && { iteration: event.iteration }),
          stream: event.stream,
          text: event.data,
        });
      },
    }),
  );
}

/** Handles whose nested runs' events reach those runs' subscribers. */
const routed = new WeakSet<ExecutionHandle>();

/** Subscribers of a nested run that no handle of its own reports to. */
function nestedSubscribers(executionId: string): Subscriber[] {
  return Array.from(subscribers.get(executionId) ?? []).filter((subscriber) =>
    Array.from(subscriber.handles.keys()).every(
      (own) => own.id !== executionId,
    ),
  );
}

/**
 * A nested run starts inside its parent's step, with no handle here; its
 * events arrive on the parent's handle, so deliver them to its own
 * subscribers.
 */
function routeNestedRuns(handle: ExecutionHandle): void {
  if (routed.has(handle) || !handle.addObservers) return;
  routed.add(handle);
  handle.addObservers({
    onEvent: (event) => {
      if (event.executionId === handle.id) return;
      for (const { observer } of nestedSubscribers(event.executionId))
        observer.onExecution(event.type, projectPipelineExecution(event.state));
    },
    onStepOutput: (event) => {
      if (event.executionId === handle.id) return;
      for (const { observer } of nestedSubscribers(event.executionId))
        observer.onOutput({
          jobId: event.jobId,
          stepId: event.stepId,
          attempt: event.attempt,
          ...(event.iteration !== undefined && { iteration: event.iteration }),
          stream: event.stream,
          text: event.data,
        });
    },
  });
}

/** Join an execution's subscribers to a handle that runs it, such as a resume's. */
export function attachPipelineHandle(handle: ExecutionHandle): void {
  routeNestedRuns(handle);
  for (const subscriber of Array.from(subscribers.get(handle.id) ?? []))
    attachSubscriber(subscriber, handle);
}

/**
 * How the desktop's windows, watchers and observers see the executions this
 * worker runs, whichever caller started them (CAN-4142).
 */
export interface PipelineExecutionFanOut {
  /** Every execution event, nested runs' included, as the executor reports it. */
  onEvent(event: ExecutionEvent): void;
  onStepOutput(event: StepOutputEvent): void;
  /**
   * Each pause as reported, and each terminal outcome once, in the state
   * the execution store settled it with.
   */
  onSettled(event: ExecutionEvent): void;
}

let fanOut: PipelineExecutionFanOut | null = null;

export function setPipelineExecutionFanOut(
  next: PipelineExecutionFanOut,
): void {
  fanOut = next;
}

/** The outcome each execution last settled with, the oldest dropped first. */
const settledOutcomes = new Map<string, string>();
const SETTLED_OUTCOMES_MAX = 256;

function outcomeKey(state: ExecutionState): string {
  return `${state.status}:${state.completed_at ?? ''}`;
}

/**
 * The state an ended execution settled with: the stored terminal state wins
 * over the one a handle reported, as it does for `get`, since a forced
 * cancel persists its outcome while the handle still runs.
 */
async function canonicalTerminalState(
  state: ExecutionState,
  executionsDir: string | undefined,
): Promise<ExecutionState> {
  const stored = await loadExecutionState(
    state.id,
    executionsDir ?? (await monitoredRuntime()).executionsDir,
  ).catch(() => null);
  return stored && TERMINAL_STATUSES.has(stored.status) ? stored : state;
}

function deliverSettled(event: ExecutionEvent): void {
  const key = outcomeKey(event.state);
  if (settledOutcomes.get(event.executionId) === key) return;
  settledOutcomes.delete(event.executionId);
  settledOutcomes.set(event.executionId, key);
  for (const id of Array.from(settledOutcomes.keys())) {
    if (settledOutcomes.size <= SETTLED_OUTCOMES_MAX) break;
    settledOutcomes.delete(id);
  }
  fanOut?.onSettled(event);
}

/** Where a reported state came from, for {@link settlePipelineExecutionEvent}. */
export interface SettledEventSource {
  /** The execution store the execution lives in, when the caller knows it. */
  readonly executionsDir?: string;
  /** The state is the one the store settled, as a cancel's is. */
  readonly stored?: boolean;
}

/**
 * Hand a pause or terminal event to the fan-out's settled channel. A
 * terminal outcome is delivered once, in its canonical state: a cancel's
 * broadcast and the cancelled handle's own report are one outcome.
 */
export async function settlePipelineExecutionEvent(
  event: ExecutionEvent,
  source: SettledEventSource = {},
): Promise<void> {
  if (!TERMINAL_STATUSES.has(event.state.status)) {
    if (event.type === 'execution.paused') fanOut?.onSettled(event);
    return;
  }
  if (source.stored) {
    deliverSettled(event);
    return;
  }
  const state = await canonicalTerminalState(event.state, source.executionsDir);
  deliverSettled(state === event.state ? event : { ...event, state });
}

/** A daemon run's event, through the same fan-out as an in-process run's (CAN-5086). */
export function deliverDaemonPipelineEvent(
  event: ExecutionEvent,
  source: SettledEventSource,
): void {
  deliverEvent(event, source);
}

/** A daemon run's step output, through the desktop fan-out (CAN-5086). */
export function deliverDaemonPipelineOutput(event: StepOutputEvent): void {
  try {
    fanOut?.onStepOutput(event);
  } catch {
    // Reported by the observer itself.
  }
}

function deliverEvent(event: ExecutionEvent, source: SettledEventSource): void {
  // An observer's failure never reaches the executor or the cancel.
  try {
    fanOut?.onEvent(event);
  } catch {
    // Reported by the observer itself.
  }
  void settlePipelineExecutionEvent(event, source).catch(() => undefined);
}

/**
 * The options a launch runs with: the desktop fan-out sees every event
 * first, then the caller's own observers do.
 */
function withFanOut<
  Options extends Pick<
    ExecutionOptions,
    'onEvent' | 'onStepOutput' | 'runtime'
  >,
>(options: Options): Options {
  const { onEvent, onStepOutput } = options;
  const executionsDir = options.runtime.executionsDir;
  return {
    ...options,
    onEvent: (event) => {
      deliverEvent(event, { executionsDir });
      onEvent?.(event);
    },
    onStepOutput: (event) => {
      try {
        fanOut?.onStepOutput(event);
      } catch {
        // Reported by the observer itself.
      }
      onStepOutput?.(event);
    },
  };
}

/**
 * The executor's recovery entry points, for the launches of the controls
 * core dispatches to this worker (CAN-4141). Each runs with the desktop
 * fan-out, as a start does.
 */
export const pipelineExecutorControls = {
  resume: (
    executionId: string,
    options: Parameters<typeof resumePipeline>[1],
  ): ReturnType<typeof resumePipeline> =>
    resumePipeline(executionId, withFanOut(options)),
  retry: (
    executionId: string,
    options: Parameters<typeof retryPipelineExecution>[1],
  ): ReturnType<typeof retryPipelineExecution> =>
    retryPipelineExecution(executionId, withFanOut(options)),
  retryMatrixJob: (
    request: Parameters<typeof retryMatrixJobExecution>[0],
    options: Parameters<typeof retryMatrixJobExecution>[1],
  ): ReturnType<typeof retryMatrixJobExecution> =>
    retryMatrixJobExecution(request, withFanOut(options)),
  rerun: (
    executionId: string,
    options: Parameters<typeof rerunPipelineExecution>[1],
  ): ReturnType<typeof rerunPipelineExecution> =>
    rerunPipelineExecution(executionId, withFanOut(options)),
};

function cancelEventType(
  status: ExecutionState['status'],
): ExecutionEvent['type'] | null {
  if (status === 'cancelled') return 'execution.cancelled';
  return status === 'success' || status === 'failure'
    ? 'execution.updated'
    : null;
}

/**
 * Every cancel goes through this worker, whichever client sent it, so its
 * settled state reaches the fan-out here, once per cancel.
 */
function broadcastCancel(state: ExecutionState): void {
  const type = cancelEventType(state.status);
  if (type === null) return;
  deliverEvent(
    {
      executionId: state.id,
      type,
      state,
      timestamp: new Date().toISOString(),
    },
    { stored: true },
  );
}

function notifySubscribers(executionId: string, state: ExecutionState): void {
  const listening = Array.from(subscribers.get(executionId) ?? []);
  if (listening.length === 0 || !TERMINAL_STATUSES.has(state.status)) return;
  // A notification's failure never fails the cancel.
  try {
    const execution = projectPipelineExecution(state);
    for (const { observer } of listening)
      observer.onExecution('execution.cancelled', execution);
  } catch {
    return;
  }
}

const launches = new Map<string, PipelineLaunch>();
const captures = new Map<string, HostCapture>();
/** Cancels in flight; a concurrent cancel of the same execution joins one. */
const cancelling = new Map<
  string,
  { readonly sequence: number; readonly capture: Promise<CancelCapture> }
>();
/** The latest settled cancel of each execution, the oldest dropped first. */
const cancelled = new Map<string, CancelCapture>();
const CANCEL_CAPTURES_MAX = 256;
let cancelSequence = 0;
/**
 * Handles this worker started, until they settle. The start path registers
 * a handle in the active registry only after the start returns, and core
 * watches the run from the start's reply.
 */
const started = new Map<string, ExecutionHandle>();

function liveHandle(executionId: string): ExecutionHandle | undefined {
  return (
    getActiveExecutionHandle(executionId) ??
    started.get(executionId) ??
    getDaemonPipelineExecutionHandle(executionId)
  );
}

/**
 * Stage a launch for the next start of `executionId`. The worker takes it
 * once; `take` returns what that start produced and forgets the launch.
 */
export function stagePipelineLaunch(
  executionId: string,
  launch: PipelineLaunch,
): { take(): HostCapture } {
  launches.set(executionId, launch);
  captures.delete(executionId);
  return {
    take: (): HostCapture => {
      launches.delete(executionId);
      const capture = captures.get(executionId) ?? {};
      captures.delete(executionId);
      return capture;
    },
  };
}

const controlLaunches = new Map<string, PipelineControlLaunch>();
interface ControlCapture {
  settlement?: PipelineControlSettlement;
  error?: unknown;
}
const controlCaptures = new Map<string, ControlCapture>();

/**
 * Stage the launch of the control dispatched as `requestId`. The worker
 * takes it once; `take` returns what it produced and forgets the launch. A
 * control core replayed from its record never runs its launch again.
 */
export function stagePipelineControl(
  requestId: string,
  launch: PipelineControlLaunch,
): { take(): ControlCapture } {
  controlLaunches.set(requestId, launch);
  controlCaptures.delete(requestId);
  return {
    take: (): ControlCapture => {
      controlLaunches.delete(requestId);
      const capture = controlCaptures.get(requestId) ?? {};
      controlCaptures.delete(requestId);
      return capture;
    },
  };
}

/** What a startup sweep or shutdown checkpoint left on the host. */
interface RecoveryCapture {
  /** The sweep's per-execution messages, which may name host paths. */
  errors?: string[];
  /** The checkpoint's own error. */
  error?: unknown;
}
const recoveryCaptures = new Map<string, RecoveryCapture>();

/** The host-side outcome of the sweep or checkpoint dispatched as `requestId`. */
export function takePipelineRecoveryCapture(
  requestId: string,
): RecoveryCapture {
  const capture = recoveryCaptures.get(requestId) ?? {};
  recoveryCaptures.delete(requestId);
  return capture;
}

/** An execution's stored state, as the store holds it now. */
export async function readStoredPipelineExecution(
  executionId: string,
): Promise<ExecutionState | null> {
  return loadExecutionState(
    executionId,
    (await monitoredRuntime()).executionsDir,
  );
}

/**
 * A mark to pass to {@link readPipelineCancelCapture} before cancelling
 * `executionId`; a cancel already in flight, which this one will join, counts.
 */
export function pipelineCancelMark(executionId: string): number {
  const inFlight = cancelling.get(executionId);
  return inFlight === undefined ? cancelSequence : inFlight.sequence - 1;
}

/**
 * The full state and original error of the latest cancel of `executionId`
 * that started after `mark`. Every caller that joined that cancel reads it.
 */
export function readPipelineCancelCapture(
  executionId: string,
  mark: number,
): HostCapture {
  const capture = cancelled.get(executionId);
  return capture !== undefined && capture.sequence > mark ? capture : {};
}

function runCancel(executionId: string): Promise<CancelCapture> {
  const existing = cancelling.get(executionId);
  if (existing) return existing.capture;
  cancelSequence += 1;
  const sequence = cancelSequence;
  const pending = cancelExecution(executionId).then(
    (state): CancelCapture => ({ sequence, state }),
    (error: unknown): CancelCapture => ({ sequence, error }),
  );
  const settled = pending.then((capture) => {
    cancelling.delete(executionId);
    cancelled.delete(executionId);
    cancelled.set(executionId, capture);
    if (capture.state) {
      notifySubscribers(executionId, capture.state);
      broadcastCancel(capture.state);
    }
    for (const key of Array.from(cancelled.keys())) {
      if (cancelled.size <= CANCEL_CAPTURES_MAX) break;
      cancelled.delete(key);
    }
    return capture;
  });
  cancelling.set(executionId, { sequence, capture: settled });
  return settled;
}

const TERMINAL_STATUSES: ReadonlySet<ExecutionState['status']> = new Set<
  ExecutionState['status']
>(['success', 'failure', 'cancelled']);

/** The stored state, or the live handle's while the run isn't terminal. */
async function currentState(
  executionId: string,
  executionsDir: string,
): Promise<ExecutionState | null> {
  const stored = await loadExecutionState(executionId, executionsDir);
  // A forced cancel persists a terminal state while the handle still runs.
  return stored && TERMINAL_STATUSES.has(stored.status)
    ? stored
    : (liveHandle(executionId)?.getState() ?? stored);
}

/*
 * The execution runtime, resource monitor and Ledger load on first use: the
 * pipeline handlers import this module through the dispatch path, and the
 * runtime's module graph is large.
 */
async function monitoredRuntime(): Promise<ExecutionOptions['runtime']> {
  const [{ createElectronExecutionRuntime }, { getResourceMonitorService }] =
    await Promise.all([
      import('./execution-runtime'),
      import('../resource-monitor'),
    ]);
  const runtime = createElectronExecutionRuntime();
  runtime.resourceMonitor = getResourceMonitorService();
  return runtime;
}

export function nestedPipelineExecutionIds(state: ExecutionState): string[] {
  const ids = new Set<string>();
  for (const job of Object.values(state.jobs)) {
    for (const step of Object.values(job.steps)) {
      if (step.child_execution_id) ids.add(step.child_execution_id);
    }
  }
  for (const reason of state.status_reasons) {
    if (reason.source.child_execution_id) {
      ids.add(reason.source.child_execution_id);
    }
  }
  return Array.from(ids);
}

/** How long a drain waits for a live run's processes to stop. */
const DRAIN_TIMEOUT_MS = 10_000;

function withinDrainWindow<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new PipelineDrainTimeoutError()),
      DRAIN_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Archive teardown's cancel: stop the execution's live processes and wait
 * for them, never writing a terminal state itself. `null` when the
 * execution is gone.
 */
export async function drainPipelineExecution(
  executionId: string,
  runtime: ExecutionRuntime,
): Promise<ExecutionState | null> {
  const handle = getActiveExecutionHandle(executionId);
  if (handle) {
    await requestExecutionCancellation(executionId, runtime.executionsDir);
    // The handle resolves only after the executor has aborted and awaited
    // its child processes. If this bounded wait expires, leave both the
    // durable cancellation marker and running state intact: the still-live
    // handle owns eventual settlement, and a later archive retry must not
    // mistake a force-written terminal snapshot for a completed drain.
    return withinDrainWindow(handle.cancel());
  }
  // Nested pipeline executions do not have renderer registry handles, and a
  // just-settled execution may lose its handle after the summary scan.
  // Re-read first so that race is already drained; otherwise use the
  // executor's durable cancellation path, which polls the marker before
  // applying its bounded recovered-execution fallback.
  const current = await loadExecutionState(executionId, runtime.executionsDir);
  if (!current || TERMINAL_STATUSES.has(current.status)) return current;
  return cancelPipelineExecution(executionId, runtime, {
    allowRecoveredFallback: false,
  });
}

/**
 * Cancel one execution as the desktop always has: retire its paused agents
 * as Ledger owners first, ask a live handle to stop, then take the durable
 * cancellation path, which force-finalizes a wedged run after its bounded
 * cooperative window.
 */
async function cancelExecution(executionId: string): Promise<ExecutionState> {
  const runtime = await monitoredRuntime();
  const { retireLedgerPipelineExecutionTree } =
    await import('../ledger/pipeline-agent-owners');
  await retireLedgerPipelineExecutionTree(executionId, async (id) => {
    const state = await loadExecutionState(id, runtime.executionsDir);
    return state === null ? [] : nestedPipelineExecutionIds(state);
  });
  if (getDaemonPipelineExecutionHandle(executionId)) {
    const { cancelPipelineInDaemon } = await import('./daemon-pipeline-route');
    await cancelPipelineInDaemon(executionId, 'finalize');
    const stored = await loadExecutionState(executionId, runtime.executionsDir);
    if (!stored) throw new Error(`Execution "${executionId}" not found`);
    return stored;
  }
  const active = getActiveExecutionHandle(executionId);
  if (active) void active.cancel().catch(() => undefined);
  return cancelPipelineExecution(executionId, runtime);
}

export const desktopPipelineWorker: PipelineExecutionWorker = {
  async start(params, signal, secrets, _execution) {
    // Host-local launches are a daemon worker's; this worker runs only the launch core staged (CAN-5086).
    void _execution;
    const launch = launches.get(params.executionId);
    if (!launch) throw pipelineLaunchUnavailableError();
    launches.delete(params.executionId);
    const capture: HostCapture = {};
    captures.set(params.executionId, capture);
    if (launch.daemon) {
      let routed: DaemonPipelineStartResult;
      try {
        routed = await (
          await import('./daemon-pipeline-route')
        ).startPipelineInDaemon({
          params,
          launch: launch.daemon,
          secrets,
          options: launch.options,
        });
      } catch (error) {
        capture.error = error;
        throw error instanceof CanopyOperationError
          ? error
          : pipelineStartFailedError(error);
      }
      if (routed.kind === 'daemon') {
        capture.handle = routed.handle;
        attachPipelineHandle(routed.handle);
        return projectPipelineExecution(routed.handle.getState());
      }
    }
    let handle: ExecutionHandle;
    try {
      handle = await executePipeline(
        launch.pipeline,
        withFanOut({
          ...launch.options,
          secretEnv: Object.keys(secrets.env).length ? secrets.env : undefined,
        }),
      );
    } catch (error) {
      capture.error = error;
      throw pipelineStartFailedError(error);
    }
    capture.handle = handle;
    attachPipelineHandle(handle);
    // Core cancelled the start while the executor was starting it.
    if (signal.aborted) void handle.cancel().catch(() => undefined);
    const state = handle.getState();
    if (!TERMINAL_STATUSES.has(state.status) && handle.addObservers) {
      started.set(params.executionId, handle);
      // A paused or ended run is read from the store, not this handle.
      const release = handle.addObservers({
        onEvent: (event) => {
          if (event.state.status === 'running') return;
          release();
          if (started.get(params.executionId) === handle)
            started.delete(params.executionId);
        },
      });
    }
    return projectPipelineExecution(state);
  },
  async control(request, signal, secrets) {
    const { requestId, executionId } = request.params;
    const prepared = controlLaunches.get(requestId);
    if (!prepared) throw pipelineLaunchUnavailableError();
    controlLaunches.delete(requestId);
    const capture: ControlCapture = {};
    controlCaptures.set(requestId, capture);
    if (signal.aborted) {
      capture.error = new Error('The workflow control was cancelled.');
      throw pipelineControlFailedError(capture.error);
    }
    let settlement: PipelineControlSettlement;
    try {
      settlement = await prepared(request, signal, secrets);
    } catch (error) {
      capture.error = error;
      if (
        error instanceof Error &&
        error.message === `Execution "${executionId}" not found`
      )
        throw pipelineExecutionNotFoundError();
      throw pipelineControlFailedError(error);
    }
    capture.settlement = settlement;
    // Core cancelled the control while its host side was starting the run.
    if (signal.aborted && settlement.outcome === 'started')
      void getActiveExecutionHandle(settlement.state.id)
        ?.cancel()
        .catch(() => undefined);
    return {
      outcome: settlement.outcome,
      execution: projectPipelineExecution(settlement.state),
    };
  },
  async sweep({ requestId, executionIds }) {
    const errors = await recoverOrphanedPipelineExecutions(
      executionIds,
      (await monitoredRuntime()).executionsDir,
    );
    recoveryCaptures.set(requestId, { errors });
    return { failureCount: errors.length };
  },
  async checkpoint({ requestId }) {
    const checkpointedCount = getInProcessPipelineExecutionCount();
    try {
      await pauseAllActivePipelineExecutions();
    } catch (error) {
      recoveryCaptures.set(requestId, { error });
      throw pipelineCheckpointFailedError(error);
    }
    return { checkpointedCount };
  },
  async get(executionId) {
    const state = await currentState(
      executionId,
      (await monitoredRuntime()).executionsDir,
    );
    return state === null ? null : projectPipelineExecution(state);
  },
  async inspect(executionId) {
    const state = await currentState(
      executionId,
      (await monitoredRuntime()).executionsDir,
    );
    return state === null
      ? null
      : projectPipelineExecutionView(state, { detail: true });
  },
  async list(query) {
    const { executionsDir } = await monitoredRuntime();
    return listPipelineExecutionPage(
      await listExecutionSummaries(executionsDir),
      (executionId) => currentState(executionId, executionsDir),
      query,
    );
  },
  async cancel(executionId, mode) {
    if (mode === 'drain') {
      if (getDaemonPipelineExecutionHandle(executionId)) {
        const { cancelPipelineInDaemon } =
          await import('./daemon-pipeline-route');
        return cancelPipelineInDaemon(executionId, 'drain');
      }
      const drained = await drainPipelineExecution(
        executionId,
        await monitoredRuntime(),
      );
      if (!drained) throw pipelineExecutionNotFoundError();
      return projectPipelineExecution(drained);
    }
    const capture = await runCancel(executionId);
    if (capture.state) return projectPipelineExecution(capture.state);
    const { error } = capture;
    if (
      error instanceof Error &&
      error.message === `Execution "${executionId}" not found`
    )
      throw pipelineExecutionNotFoundError();
    throw error instanceof Error
      ? error
      : new Error('The workflow run could not be cancelled.');
  },
  observe(executionId, observer: PipelineExecutionObserver) {
    const subscriber: Subscriber = { observer, handles: new Map() };
    const set = subscribers.get(executionId) ?? new Set<Subscriber>();
    set.add(subscriber);
    subscribers.set(executionId, set);
    const handle = liveHandle(executionId);
    if (handle) attachSubscriber(subscriber, handle);
    return (): void => {
      for (const detach of Array.from(subscriber.handles.values())) detach();
      subscriber.handles.clear();
      set.delete(subscriber);
      if (set.size === 0 && subscribers.get(executionId) === set)
        subscribers.delete(executionId);
    };
  },
};
