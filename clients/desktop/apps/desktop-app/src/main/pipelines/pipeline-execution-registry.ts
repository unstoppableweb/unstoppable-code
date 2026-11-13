import type { ExecutionLease } from '@canopy/core-runtime';
import type { ExecutionHandle } from '@canopy/execution-engine/node/pipelines/executor';
import { getExecutionAccounting } from '../execution-accounting';
import {
  getFollowedDaemonPipelineExecutionHandles,
  onDaemonPipelineMirrorsChange,
} from './daemon-pipeline-execution';

interface ReservedExecution {
  kind: 'reserved';
  owner: 'pipeline-start' | 'matrix-variant-cancellation';
}

interface RunningExecution {
  kind: 'running';
  handle: ExecutionHandle;
}

type ActiveExecution = ReservedExecution | RunningExecution;

let shutdownStarted = false;

const activeExecutions = new Map<string, ActiveExecution>();
// Every reserved or running execution holds a core accounting lease, so core
// counts it against the pipeline limit until the entry leaves the registry.
const executionLeases = new Map<string, ExecutionLease>();
const activeCountListeners = new Set<(count: number) => void>();
const shutdownPauseTasks = new Map<string, Promise<void>>();
const timedOutShutdownReservations = new Set<string>();
const DEFAULT_CANCEL_TIMEOUT_MS = 8_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Daemon runs main follows (CAN-5086) are active work too: they count, take
 * a lease and keep their worktree busy. Shutdown never pauses or cancels them.
 */
function followedDaemonRuns(): ExecutionHandle[] {
  return getFollowedDaemonPipelineExecutionHandles().filter(
    (handle) => !activeExecutions.has(handle.id),
  );
}

function syncExecutionLeases(): void {
  const active = new Set([
    ...activeExecutions.keys(),
    ...followedDaemonRuns().map((handle) => handle.id),
  ]);
  active.forEach((executionId): void => {
    if (!executionLeases.has(executionId)) {
      executionLeases.set(
        executionId,
        getExecutionAccounting().track('pipeline', executionId),
      );
    }
  });
  executionLeases.forEach((lease, executionId): void => {
    if (!active.has(executionId)) {
      lease.release();
      executionLeases.delete(executionId);
    }
  });
}

function notifyActiveCountChange(): void {
  syncExecutionLeases();
  const count = getActivePipelineExecutionCount();
  for (const listener of Array.from(activeCountListeners)) {
    listener(count);
  }
}

function mutateActiveExecutions(fn: () => void): void {
  try {
    fn();
  } finally {
    notifyActiveCountChange();
  }
}

function pauseExecutionForShutdown(handle: ExecutionHandle): Promise<void> {
  const existing = shutdownPauseTasks.get(handle.id);
  if (existing) return existing;
  const task = (async (): Promise<void> => {
    if (!handle.pauseForShutdown)
      throw new Error('Pipeline executor cannot checkpoint shutdown');
    await handle.pauseForShutdown();
  })();
  shutdownPauseTasks.set(handle.id, task);
  void task.catch(() => undefined);
  return task;
}

export function trackExecution(
  handle: ExecutionHandle,
  onSettled?: () => void,
  reservationId: string = handle.id,
): void {
  mutateActiveExecutions((): void => {
    const reservation = activeExecutions.get(reservationId);
    const acceptsTimedOutReservation =
      timedOutShutdownReservations.delete(reservationId);
    if (
      !acceptsTimedOutReservation &&
      (reservation?.kind !== 'reserved' ||
        reservation.owner !== 'pipeline-start')
    ) {
      throw new Error(
        `Execution "${reservationId}" does not have a pipeline start reservation`,
      );
    }
    if (handle.id !== reservationId && activeExecutions.has(handle.id)) {
      throw new Error(`Execution "${handle.id}" is already active`);
    }
    activeExecutions.delete(reservationId);
    activeExecutions.set(handle.id, { kind: 'running', handle });
  });

  if (shutdownStarted) void pauseExecutionForShutdown(handle);

  const settled = (): void => {
    mutateActiveExecutions((): void => {
      activeExecutions.delete(handle.id);
    });
    onSettled?.();
  };
  void handle.waitForCompletion().then(settled, settled);
}

export function tryReserveExecution(
  executionId: string,
  owner: ReservedExecution['owner'] = 'pipeline-start',
): boolean {
  if (shutdownStarted && owner === 'pipeline-start') return false;
  let reserved = false;
  mutateActiveExecutions((): void => {
    if (activeExecutions.has(executionId)) {
      return;
    }
    activeExecutions.set(executionId, { kind: 'reserved', owner });
    reserved = true;
  });
  return reserved;
}

export function reserveExecution(executionId: string): void {
  if (!tryReserveExecution(executionId)) {
    throw new Error(`Execution "${executionId}" is already active`);
  }
}

export function releaseExecutionReservation(
  executionId: string,
  owner: ReservedExecution['owner'] = 'pipeline-start',
): void {
  timedOutShutdownReservations.delete(executionId);
  mutateActiveExecutions((): void => {
    const activeExecution = activeExecutions.get(executionId);
    if (
      activeExecution?.kind === 'reserved' &&
      activeExecution.owner === owner
    ) {
      activeExecutions.delete(executionId);
    }
  });
}

export function hasActiveExecution(executionId: string): boolean {
  return activeExecutions.has(executionId);
}

export function isExecutionReservedBy(
  executionId: string,
  owner: ReservedExecution['owner'],
): boolean {
  const activeExecution = activeExecutions.get(executionId);
  return (
    activeExecution?.kind === 'reserved' && activeExecution.owner === owner
  );
}

export function getActiveExecutionHandle(
  executionId: string,
): ExecutionHandle | undefined {
  const activeExecution = activeExecutions.get(executionId);
  return activeExecution?.kind === 'running'
    ? activeExecution.handle
    : undefined;
}

function inProcessExecutionHandles(): ExecutionHandle[] {
  const handles: ExecutionHandle[] = [];
  activeExecutions.forEach((activeExecution): void => {
    if (activeExecution.kind === 'running') {
      handles.push(activeExecution.handle);
    }
  });
  return handles;
}

export function getActivePipelineExecutionHandles(): ExecutionHandle[] {
  return [...inProcessExecutionHandles(), ...followedDaemonRuns()];
}

async function cancelWithTimeout(
  handle: ExecutionHandle,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      handle.cancel(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function cancelAllActivePipelineExecutions(
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
  const cancellations: Promise<void>[] = [];

  activeExecutions.forEach((_activeExecution, executionId): void => {
    const handle = getActiveExecutionHandle(executionId);
    if (!handle) {
      return;
    }

    cancellations.push(cancelWithTimeout(handle, timeoutMs));
  });

  return Promise.allSettled(cancellations).then(() => undefined);
}

export function hasActivePipelineExecutions(): boolean {
  return getActivePipelineExecutionCount() > 0;
}

export function getActivePipelineExecutionCount(): number {
  return activeExecutions.size + followedDaemonRuns().length;
}

/** The executions a shutdown checkpoint pauses: the in-process ones. */
export function getInProcessPipelineExecutionCount(): number {
  return activeExecutions.size;
}

export function subscribeToActiveCountChange(
  listener: (count: number) => void,
): () => void {
  activeCountListeners.add(listener);
  return (): void => {
    activeCountListeners.delete(listener);
  };
}

/** Close admission before stopping handles, including starts already holding a reservation. */
export async function pauseAllActivePipelineExecutions(
  options: { reservationDrainTimeoutMs?: number } = {},
): Promise<void> {
  shutdownStarted = true;
  if (activeExecutions.size === 0) return;
  const timeoutMs =
    options.reservationDrainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  const drained = new Promise<void>((resolve, reject) => {
    let finished = false;
    let unsubscribe = (): void => undefined;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      unsubscribe();
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    unsubscribe = subscribeToActiveCountChange(() => {
      if (activeExecutions.size === 0) {
        finish();
      }
    });
    const timeout = setTimeout(() => {
      mutateActiveExecutions((): void => {
        activeExecutions.forEach((activeExecution, executionId) => {
          if (activeExecution.kind === 'reserved') {
            activeExecutions.delete(executionId);
            timedOutShutdownReservations.add(executionId);
          }
        });
      });
      if (activeExecutions.size > 0) {
        finish(
          new Error(
            'Timed out waiting for active pipeline executions to checkpoint',
          ),
        );
      } else {
        finish();
      }
    }, timeoutMs);
  });
  inProcessExecutionHandles().forEach((handle) =>
    pauseExecutionForShutdown(handle),
  );
  await drained;
  const pauseResults = await Promise.allSettled(shutdownPauseTasks.values());
  const pauseFailures = pauseResults.filter(
    (result) => result.status === 'rejected',
  );
  if (pauseFailures.length > 0) {
    throw new Error(
      `Failed to checkpoint active pipeline executions: ${pauseFailures
        .map((result) => String(result.reason))
        .join('; ')}`,
    );
  }
}

onDaemonPipelineMirrorsChange(notifyActiveCountChange);
