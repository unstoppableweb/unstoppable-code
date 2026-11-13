import type { CanopyClientStreamFrame } from '@canopy/core-client';
import type {
  WorkerPipelineExecution,
  WorkerPipelineExecutionEventsItem,
} from '@canopy/protocol/canopy-core';
import { loadExecutionState } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import type { BrowserWindow } from 'electron';
import {
  DaemonCommitHookFollower,
  type DaemonCommitHookScope,
} from './daemon-pipeline-commit-hooks';
import type {
  ExecutionHandle,
  ExecutionLifecycleHooks,
  ExecutionOptions,
  PipelineHostActions,
  PipelineStepNotification,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import type { PortableHostRunContext } from '@canopy/desktop-shared/node/pipelines/host-request-apply';
import type {
  ExecutionEvent,
  ExecutionState,
  StepOutputEvent,
} from '@canopy/execution-engine/types/pipeline';

export const DAEMON_PIPELINE_CONTROL_REFUSED_MESSAGE =
  'This workflow run is running in the background service. Wait for it to pause or finish, or cancel it.';

export interface DaemonPipelineEventsSubscription {
  close(): void;
}

export type DaemonPipelineEventsFrame = CanopyClientStreamFrame<
  WorkerPipelineExecutionEventsItem,
  object
>;

interface DaemonPipelineExecutionHandleOptions {
  executionId: string;
  initialState: ExecutionState;
  executionsDir: string;
  /**
   * Opens `worker.pipeline.execution.events`; `onFrame` gets each item or
   * end. Without it the mirror follows the run through the store only.
   */
  openEvents?: (
    onFrame: (frame: DaemonPipelineEventsFrame) => void,
  ) => Promise<DaemonPipelineEventsSubscription>;
  cancel(): Promise<WorkerPipelineExecution>;
  /** The desktop fan-out (`deliverDaemonPipelineEvent`, `deliverDaemonPipelineOutput`). */
  deliverEvent(event: ExecutionEvent): void;
  deliverOutput(event: StepOutputEvent): void;
  /** Shows a step's desktop notification, as an in-process run's post-process does (CAN-5868). */
  deliverNotification?(notification: PipelineStepNotification): void;
  /** `sweepOrphanedPipelinesThroughLocalWorker([executionId])`. */
  sweep(executionId: string): Promise<void>;
  /** Main's run lifecycle (wake lock, telemetry), as an in-process run calls it. */
  lifecycle?: ExecutionLifecycleHooks;
  /** The first reopen's delay; each later one doubles, up to 30 s. */
  reopenDelayMs?: number;
  /** CAN-5771: what Electron main applies this run's host steps with; set for owner-bound runs. */
  hostSteps?: {
    readonly context: Omit<PortableHostRunContext, 'executionsDir'>;
    readonly actions: PipelineHostActions;
  };
  /** The launch was owner-bound (CAN-5771 host steps, CAN-5095 model steps). */
  ownerBound?: boolean;
  /** Closes the run's model-step owner context with its final state (CAN-5095 D16). */
  detachOwner?: (finalState: ExecutionState | null) => Promise<void>;
  /**
   * The run's worktree, for its `git-commit-push` precommit-failure hook,
   * which Electron main runs from the stored outputs (CAN-6012 D3).
   */
  commitHooks?: {
    readonly scope: DaemonCommitHookScope;
    readonly getWindow?: () => BrowserWindow | null;
  };
}

type Observers = {
  onEvent?: ExecutionOptions['onEvent'];
  onStepOutput?: ExecutionOptions['onStepOutput'];
};

function eventType(value: string): ExecutionEvent['type'] {
  switch (value) {
    case 'execution.started':
    case 'execution.paused':
    case 'execution.updated':
    case 'execution.completed':
    case 'execution.cancelled':
    case 'execution.failed':
      return value;
    default:
      return 'execution.updated';
  }
}

const TERMINAL: ReadonlySet<ExecutionState['status']> = new Set<
  ExecutionState['status']
>(['success', 'failure', 'cancelled']);

function isSettled(state: ExecutionState): boolean {
  return state.status === 'paused' || TERMINAL.has(state.status);
}

/** The lifecycle event a settled state ends with, as the executor emits it. */
function settledEvent(state: ExecutionState): ExecutionEvent['type'] {
  switch (state.status) {
    case 'paused':
      return 'execution.paused';
    case 'success':
      return 'execution.completed';
    case 'cancelled':
      return 'execution.cancelled';
    default:
      return 'execution.failed';
  }
}

/** A projection status the run has not paused or ended in. */
const UNSETTLED_PROJECTION: ReadonlySet<string> = new Set([
  'pending',
  'running',
]);

/**
 * How long a settled mirror keeps its stream for the notifications still on
 * it (CAN-5868); the frame with the settled status ends it sooner.
 */
const DRAIN_MS = 10_000;

const REOPEN_DELAY_MS = 1_000;
const MAX_REOPEN_DELAY_MS = 30_000;
const REOPEN_ATTEMPTS = 3;

const registry = new Map<string, DaemonPipelineExecutionHandle>();
const registryListeners = new Set<() => void>();

function notifyRegistryChange(): void {
  for (const listener of Array.from(registryListeners)) listener();
}

/**
 * Electron main's mirror of a run the daemon executes (CAN-5086 D12): one
 * `worker.pipeline.execution.events` subscription, each lifecycle item
 * reloaded from the shared execution store and handed to the desktop
 * fan-out. It is not in the active registry, so quitting the app never
 * pauses it: the run keeps going in the daemon.
 */
export class DaemonPipelineExecutionHandle implements ExecutionHandle {
  readonly id: string;

  private state: ExecutionState;

  private readonly observers = new Set<Observers>();

  private subscription: DaemonPipelineEventsSubscription | null = null;

  /** Settled, with the stream kept open for its remaining notifications. */
  private draining = false;

  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  private drainReopened = false;

  private settled = false;

  private following = false;

  private reopened = 0;

  /** The daemon's pipeline host is not running it: follow the store only (CAN-5869). */
  private storeOnly: boolean;

  private queue: Promise<void> = Promise.resolve();

  private readonly completion: Promise<ExecutionState>;

  /** The `git-commit-push` attempts this follower has handled (CAN-6012 D3). */
  private readonly commitHooks: DaemonCommitHookFollower | undefined;

  private resolveCompletion: (state: ExecutionState) => void = () => undefined;

  constructor(private readonly options: DaemonPipelineExecutionHandleOptions) {
    this.id = options.executionId;
    this.state = options.initialState;
    this.storeOnly = options.openEvents === undefined;
    this.commitHooks =
      options.commitHooks &&
      new DaemonCommitHookFollower({
        executionId: options.executionId,
        executionsDir: options.executionsDir,
        scope: options.commitHooks.scope,
        ...(options.commitHooks.getWindow && {
          getWindow: options.commitHooks.getWindow,
        }),
      });
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  /**
   * Starts following the run once the start is recorded and its observers
   * attached; a run that already settled ends with its lifecycle event.
   */
  follow(options: { readonly resumed?: boolean } = {}): void {
    if (this.settled || this.following) return;
    this.following = true;
    this.runCommitHooks();
    // Main follows after the daemon started the run, so it starts the run's
    // lifecycle itself, as an in-process run's first event does; a run an
    // earlier launch already started is only resumed.
    if (!options.resumed) {
      this.options.lifecycle?.onExecutionStart?.(this.state);
      this.deliver('execution.started');
    }
    if (!isSettled(this.state)) {
      this.open();
      return;
    }
    this.deliver(settledEvent(this.state));
    // A run that settled before main followed it may have notified first.
    if (options.resumed) this.settle();
    else this.settleAndCollect();
  }

  getState(): ExecutionState {
    return this.state;
  }

  get hostSteps(): DaemonPipelineExecutionHandleOptions['hostSteps'] {
    return this.options.hostSteps;
  }

  get ownerBound(): boolean {
    return this.options.ownerBound === true;
  }

  get executionsDir(): string {
    return this.options.executionsDir;
  }

  async cancel(): Promise<ExecutionState> {
    await this.options.cancel();
    return this.reload();
  }

  addObservers(observers: Observers): () => void {
    this.observers.add(observers);
    return (): void => {
      this.observers.delete(observers);
    };
  }

  waitForCompletion(): Promise<ExecutionState> {
    return this.completion;
  }

  /** Whether the run has not paused or ended yet. */
  isFollowing(): boolean {
    return !this.settled;
  }

  private open(): void {
    const { openEvents } = this.options;
    if (this.storeOnly || !openEvents) {
      this.enqueue(() => this.onDropped());
      return;
    }
    openEvents((frame) => this.enqueue(() => this.onFrame(frame))).then(
      (subscription) => {
        if (this.settled && !this.draining) subscription.close();
        else this.subscription = subscription;
      },
      () => this.enqueue(() => this.onDropped()),
    );
  }

  /** Items are handled one at a time, in arrival order. */
  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch(() => undefined);
  }

  private async reload(): Promise<ExecutionState> {
    const stored = await loadExecutionState(
      this.id,
      this.options.executionsDir,
    ).catch(() => null);
    if (stored) this.state = stored;
    this.runCommitHooks();
    return this.state;
  }

  /** In the background: a hook never holds up the run's events. */
  private runCommitHooks(): void {
    void this.commitHooks?.scan(this.state);
  }

  private deliver(type: ExecutionEvent['type']): void {
    const event: ExecutionEvent = {
      executionId: this.id,
      type,
      state: this.state,
      timestamp: new Date().toISOString(),
    };
    this.options.deliverEvent(event);
    for (const observer of Array.from(this.observers))
      observer.onEvent?.(event);
  }

  private async onFrame(frame: DaemonPipelineEventsFrame): Promise<void> {
    if (this.settled) {
      // Notifications already on the stream still show once the run settled.
      if (frame.kind === 'item' && frame.item.kind === 'notification')
        this.notify(frame.item);
      // A stream that ended in an error is a drop, retried once.
      else if (frame.kind === 'end' && frame.outcome !== 'completed')
        await this.onDropped();
      else if (
        frame.kind === 'end' ||
        (frame.item.kind === 'execution' &&
          !UNSETTLED_PROJECTION.has(frame.item.execution.status))
      )
        this.closeStream();
      return;
    }
    if (frame.kind === 'end') {
      if (frame.error?.code === 'worker.pipeline.hostLost') {
        await this.options.sweep(this.id).catch(() => undefined);
        await this.reload();
        this.deliver(
          isSettled(this.state)
            ? settledEvent(this.state)
            : 'execution.updated',
        );
        this.settle();
        return;
      }
      // A clean end before the run settled: the daemon's pipeline host is
      // not running it, so reopening would only read the store again.
      if (frame.outcome === 'completed' && frame.error === null)
        this.storeOnly = true;
      await this.onDropped();
      return;
    }
    const { item } = frame;
    if (item.kind === 'execution') {
      await this.reload();
      if (isSettled(this.state)) {
        this.deliver(settledEvent(this.state));
        // The store can be ahead of the stream: keep it for what precedes
        // the item that carries the settled status.
        this.settle({
          drain: UNSETTLED_PROJECTION.has(item.execution.status),
        });
        return;
      }
      // The run's start was delivered when main began following it.
      if (item.event !== 'execution.started')
        this.deliver(eventType(item.event));
      return;
    }
    if (item.kind === 'notification') {
      this.notify(item);
      return;
    }
    if (item.kind === 'output') {
      const job = this.state.jobs[item.jobId];
      const snapshotJob = this.state.pipeline_snapshot.jobs[item.jobId];
      const snapshotStep = snapshotJob?.steps.find(
        (step) => step.id === item.stepId,
      );
      const event: StepOutputEvent = {
        executionId: this.id,
        jobId: item.jobId,
        jobName: snapshotJob?.name ?? item.jobId,
        stepId: item.stepId,
        stepName: snapshotStep?.name ?? item.stepId,
        // The item's own labels; a daemon that predates them leaves the
        // job's current ones.
        attempt: item.attempt ?? job?.retry_count ?? 0,
        iteration: item.iteration ?? job?.iteration_count ?? 1,
        stream: item.stream,
        data: item.text,
      };
      this.options.deliverOutput(event);
      for (const observer of Array.from(this.observers))
        observer.onStepOutput?.(event);
    }
  }

  private notify(item: { title: string; body: string }): void {
    this.options.deliverNotification?.({ title: item.title, body: item.body });
  }

  private closeStream(): void {
    this.draining = false;
    if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    this.subscription?.close();
    this.subscription = null;
  }

  /** The stream ended or the session dropped before the run settled. */
  private async onDropped(): Promise<void> {
    if (this.settled) {
      const reopen = this.draining && !this.drainReopened;
      this.subscription = null;
      if (!reopen) {
        this.closeStream();
        return;
      }
      // A drain stream that dropped is opened once more.
      this.drainReopened = true;
      this.open();
      return;
    }
    this.subscription = null;
    await this.reload();
    if (isSettled(this.state)) {
      this.deliver(settledEvent(this.state));
      // It may have notified while the stream was down.
      this.settleAndCollect();
      return;
    }
    if (this.reopened >= REOPEN_ATTEMPTS) {
      // The daemon may be gone: the sweep settles a run whose owner exited,
      // and a run still owned stays followed, counted and cancellable.
      await this.options.sweep(this.id).catch(() => undefined);
      await this.reload();
      if (isSettled(this.state)) {
        this.deliver(settledEvent(this.state));
        this.settle();
        return;
      }
    }
    const delay = Math.min(
      (this.options.reopenDelayMs ?? REOPEN_DELAY_MS) * 2 ** this.reopened,
      MAX_REOPEN_DELAY_MS,
    );
    this.reopened += 1;
    setTimeout(() => {
      if (!this.settled) this.open();
    }, delay).unref?.();
  }

  /**
   * Settles, then opens a stream for the notifications the daemon kept for
   * the run (CAN-5868), when the daemon can serve one.
   */
  private settleAndCollect(): void {
    const drain = !this.storeOnly && this.options.openEvents !== undefined;
    this.settle({ drain });
    if (drain) this.open();
  }

  private settle(options: { readonly drain?: boolean } = {}): void {
    if (this.settled) return;
    this.settled = true;
    if (options.drain) {
      this.draining = true;
      this.drainTimer = setTimeout(() => this.closeStream(), DRAIN_MS);
      this.drainTimer.unref?.();
    } else this.closeStream();
    if (registry.get(this.id) === this) {
      registry.delete(this.id);
      notifyRegistryChange();
    }
    if (this.following)
      this.options.lifecycle?.onExecutionSettled?.(this.state);
    void this.options.detachOwner?.(this.state).catch(() => undefined);
    // Loaded lazily: the owner settlement module imports this one.
    void import('./daemon-pipeline-owner')
      .then((owner) => owner.abortDaemonPipelineHostCalls(this.id))
      .catch(() => undefined);
    this.resolveCompletion(this.state);
  }
}

export function isDaemonPipelineExecutionHandle(
  handle: ExecutionHandle,
): handle is DaemonPipelineExecutionHandle {
  return handle instanceof DaemonPipelineExecutionHandle;
}

export function registerDaemonPipelineExecution(
  handle: DaemonPipelineExecutionHandle,
): void {
  if (!handle.isFollowing()) return;
  registry.set(handle.id, handle);
  notifyRegistryChange();
}

/** The daemon runs main follows that have not paused or ended. */
export function getFollowedDaemonPipelineExecutionHandles(): DaemonPipelineExecutionHandle[] {
  return Array.from(registry.values());
}

/** Observes mirrors registering and settling. */
export function onDaemonPipelineMirrorsChange(
  listener: () => void,
): () => void {
  registryListeners.add(listener);
  return (): void => {
    registryListeners.delete(listener);
  };
}

/** Whether a followed daemon run's launch was owner-bound (CAN-5771). */
export function hasOwnerBoundDaemonPipelineRuns(): boolean {
  for (const handle of registry.values()) if (handle.ownerBound) return true;
  return false;
}

export function getDaemonPipelineExecutionHandle(
  executionId: string,
): DaemonPipelineExecutionHandle | undefined {
  return registry.get(executionId);
}
