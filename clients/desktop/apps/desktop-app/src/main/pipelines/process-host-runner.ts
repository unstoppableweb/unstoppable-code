import { randomUUID } from 'node:crypto';
import type { ExecutionHostProcess } from '@canopy/desktop-shared/node/execution-host/port';
import type {
  ExecutionResourceMonitor,
  ExecutionResourceRegistrationHandle,
  SpawnedProcessResult,
  SpawnedProcessRunOptions,
  SpawnedProcessSpec,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { killProcessGroupByPid } from '@canopy/execution-engine/node/lib/process-kill';
import type {
  PipelineProcessHostRequest,
  PipelineProcessHostResponse,
} from './process-host-protocol';
import { getExecutionHostPort } from '../execution-host/utility-process-host';

const WORKER_ENTRY_FILENAME = 'pipeline-process-host-worker.js';
const WORKER_SERVICE_NAME = 'pipeline-process-host';
const SHUTDOWN_WAIT_MS = 6_000;
const FORCED_EXIT_CLEANUP_WAIT_MS = 6_000;

interface PendingRun {
  child: ExecutionHostProcess;
  options: SpawnedProcessRunOptions;
  monitor?: ExecutionResourceMonitor;
  resourceHandle: ExecutionResourceRegistrationHandle | null;
  abortListener: () => void;
  resolve: (result: SpawnedProcessResult) => void;
  reject: (error: Error) => void;
}

interface WorkerExitState {
  child: ExecutionHostProcess;
  promise: Promise<void>;
  resolve: () => void;
}

interface TrackedCleanupProcess {
  child: ExecutionHostProcess;
  pid: number;
}

let worker: ExecutionHostProcess | null = null;
let workerExitState: WorkerExitState | null = null;
let shuttingDown = false;
const pending = new Map<string, PendingRun>();
const cleanupProcesses = new Map<string, TrackedCleanupProcess>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isResponse(value: unknown): value is PipelineProcessHostResponse {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'shutdown-complete') return true;
  return (
    (value.type === 'started' ||
      value.type === 'output' ||
      value.type === 'result' ||
      value.type === 'error' ||
      value.type === 'cleanup-complete') &&
    typeof value.requestId === 'string'
  );
}

function post(
  child: ExecutionHostProcess,
  message: PipelineProcessHostRequest,
): void {
  child.postMessage(message);
}

function cleanupPending(requestId: string): PendingRun | undefined {
  const record = pending.get(requestId);
  if (!record) return undefined;
  pending.delete(requestId);
  record.options.signal.removeEventListener('abort', record.abortListener);
  record.resourceHandle?.unregister();
  return record;
}

function rejectPending(requestIds: readonly string[], message: string): void {
  for (const requestId of requestIds) {
    cleanupPending(requestId)?.reject(new Error(message));
  }
}

function registerResource(record: PendingRun, pid: number): void {
  const resource = record.options.resource;
  if (!resource || record.resourceHandle) return;
  record.resourceHandle =
    record.monitor?.registerProcess({
      id: `pipeline-step:${resource.executionId}:${resource.jobId}${resource.childId ? `:${resource.childId}` : ''}:${resource.stepId}:${String(resource.attempt)}:${String(pid)}`,
      groupId: 'pipelines',
      kind: 'pipeline-step',
      label: resource.label,
      pid,
      processGroupId: pid,
      startedAt: new Date().toISOString(),
      metadata: {
        type: 'pipeline',
        pipeline: {
          executionId: resource.executionId,
          pipelineId: resource.pipelineId,
          pipelineName: resource.pipelineName,
          jobId: resource.jobId,
          ...(resource.childId ? { childId: resource.childId } : {}),
          stepId: resource.stepId,
          attempt: resource.attempt,
          iteration: resource.iteration,
        },
      },
    }) ?? null;
}

async function terminateTrackedProcessGroups(
  child: ExecutionHostProcess,
): Promise<void> {
  const tracked = Array.from(cleanupProcesses.entries()).filter(
    ([, process]) => process.child === child,
  );
  const pids = Array.from(new Set(tracked.map(([, process]) => process.pid)));
  await Promise.allSettled(
    pids.map((actionPid) => killProcessGroupByPid(actionPid, 'SIGKILL')),
  );
  for (const [requestId, process] of tracked) {
    if (cleanupProcesses.get(requestId) === process) {
      cleanupProcesses.delete(requestId);
    }
  }
}

function handleMessage(source: ExecutionHostProcess, message: unknown): void {
  // Execution hosts emit the posted payload directly. Test doubles and some
  // MessageEvent-shaped adapters wrap it in `{ data }`. Check the protocol
  // object first because an output response itself intentionally has a `data`
  // field; blindly unwrapping that field drops every live stdout/stderr event.
  const payload = isResponse(message)
    ? message
    : isRecord(message) && 'data' in message
      ? message.data
      : message;
  if (!isResponse(payload)) return;
  if (payload.type === 'shutdown-complete') return;

  if (payload.type === 'cleanup-complete') {
    const cleanupProcess = cleanupProcesses.get(payload.requestId);
    if (cleanupProcess?.child === source) {
      cleanupProcesses.delete(payload.requestId);
    }
    return;
  }
  const record = pending.get(payload.requestId);
  if (!record || record.child !== source) return;
  if (payload.type === 'started') {
    cleanupProcesses.set(payload.requestId, {
      child: source,
      pid: payload.pid,
    });
    registerResource(record, payload.pid);
  } else if (payload.type === 'output') {
    record.options.onOutput?.(payload.stream, payload.data);
  } else if (payload.type === 'result') {
    cleanupPending(payload.requestId)?.resolve(payload.result);
  } else if (payload.type === 'error') {
    cleanupPending(payload.requestId)?.reject(new Error(payload.message));
  }
}

function ensureWorker(): ExecutionHostProcess {
  if (shuttingDown) throw new Error('Pipeline process host is shutting down.');
  if (worker) return worker;

  const child = getExecutionHostPort().launch({
    entry: WORKER_ENTRY_FILENAME,
    serviceName: WORKER_SERVICE_NAME,
  });
  worker = child;
  let resolveExit = (): void => undefined;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const exitState: WorkerExitState = {
    child,
    promise: exitPromise,
    resolve: resolveExit,
  };
  workerExitState = exitState;
  child.on('message', (message) => handleMessage(child, message));
  child.once('exit', (code) => {
    void (async (): Promise<void> => {
      if (worker === child) worker = null;
      const failedRequestIds = Array.from(pending.entries())
        .filter(([, record]) => record.child === child)
        .map(([requestId]) => requestId);
      await terminateTrackedProcessGroups(child);
      rejectPending(
        failedRequestIds,
        `Pipeline process host exited before completing its work (code ${code}).`,
      );
      exitState.resolve();
      if (workerExitState === exitState) workerExitState = null;
    })();
  });
  return child;
}

export function runPipelineProcessInExecutionHost(
  processSpec: SpawnedProcessSpec,
  options: SpawnedProcessRunOptions,
  monitor?: ExecutionResourceMonitor,
): Promise<SpawnedProcessResult> {
  if (options.signal.aborted) {
    return Promise.resolve({
      status: 'cancelled',
      conclusion: 'cancelled',
      outcome: 'cancelled',
      outputs: {},
      dynamic_env: {},
      log_file: options.logFile,
    });
  }

  return new Promise((resolve, reject) => {
    let child: ExecutionHostProcess;
    try {
      child = ensureWorker();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const requestId = randomUUID();
    const abortListener = (): void => {
      if (pending.has(requestId) && worker === child) {
        post(child, { type: 'cancel', requestId });
      }
    };
    pending.set(requestId, {
      child,
      options,
      monitor,
      resourceHandle: null,
      abortListener,
      resolve,
      reject,
    });
    options.signal.addEventListener('abort', abortListener, { once: true });
    const serializableOptions = {
      cwd: options.cwd,
      env: options.env,
      timeout_minutes: options.timeout_minutes,
      logFile: options.logFile,
      outputFile: options.outputFile,
      envFile: options.envFile,
      ...(options.agentTerminalResultGraceMs === undefined
        ? {}
        : { agentTerminalResultGraceMs: options.agentTerminalResultGraceMs }),
      ...(options.secretValues === undefined
        ? {}
        : { secretValues: options.secretValues }),
    };
    try {
      post(child, {
        type: 'run',
        requestId,
        ...(options.resource?.childId
          ? { childId: options.resource.childId }
          : {}),
        processSpec,
        options: serializableOptions,
      });
    } catch (error) {
      cleanupPending(requestId)?.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }
    if (options.signal.aborted) abortListener();
  });
}

export async function shutdownPipelineProcessHost(): Promise<void> {
  shuttingDown = true;
  const child = worker;
  const exitState = workerExitState;
  if (!child) {
    if (!exitState) return;
    let cleanupTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      exitState.promise,
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, FORCED_EXIT_CLEANUP_WAIT_MS);
        cleanupTimer.unref?.();
      }),
    ]);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    return;
  }
  try {
    post(child, { type: 'shutdown' });
  } catch {
    // The exit path below rejects pending runs and completes cleanup.
  }
  const exit =
    exitState?.child === child ? exitState.promise : Promise.resolve();
  let gracefulTimer: NodeJS.Timeout | undefined;
  const exitedGracefully = await Promise.race([
    exit.then(() => true),
    new Promise<boolean>((resolve) => {
      gracefulTimer = setTimeout(() => resolve(false), SHUTDOWN_WAIT_MS);
      gracefulTimer.unref?.();
    }),
  ]);
  if (gracefulTimer) clearTimeout(gracefulTimer);
  if (exitedGracefully) return;

  try {
    child.kill();
  } catch {
    // Best-effort bounded shutdown.
  }
  let cleanupTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    exit,
    new Promise<void>((resolve) => {
      cleanupTimer = setTimeout(resolve, FORCED_EXIT_CLEANUP_WAIT_MS);
      cleanupTimer.unref?.();
    }),
  ]);
  if (cleanupTimer) clearTimeout(cleanupTimer);
}

export function resetPipelineProcessHostForTests(): void {
  worker = null;
  workerExitState = null;
  shuttingDown = false;
  pending.clear();
  cleanupProcesses.clear();
}
