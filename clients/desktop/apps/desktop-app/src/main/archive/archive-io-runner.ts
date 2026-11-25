import { sanitizedDestructiveCode } from '../lib/destructive-failure-context';
import { classifyError } from '@canopy/protocol/app-errors/classification';
import { archiveErrorWithFrames } from '../lib/archive-error-frames';
import * as path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import { killProcessGroupByPid } from '@canopy/execution-engine/node/lib/process-kill';
import {
  ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE,
  ARCHIVE_IO_GIT_TIMEOUT_CODE,
  ARCHIVE_IO_PROTOCOL_VERSION,
  isArchiveIoResult,
  isArchiveIoResponse,
  type ArchiveIoOperationRequest,
  type ArchiveIoOperationType,
  type ArchiveIoResponse,
  type ArchiveIoResultMap,
} from './archive-io-protocol';
import { getObservabilityService } from '../observability';

const WORKER_ENTRY_FILENAME = 'archive-io-worker.js';
const WORKER_SERVICE_NAME = 'archive-io';
const STARTUP_TIMEOUT_MS = 10_000;
const REQUEST_ADMISSION_TIMEOUT_MS = 10_000;
const SHUTDOWN_WAIT_MS = 6_000;
const FORCED_CLEANUP_WAIT_MS = 6_000;

export const ARCHIVE_IO_INTERRUPTED_MESSAGE =
  'Archive work was interrupted. Retry the operation.';

interface WorkerState {
  child: UtilityProcess;
  generation: number;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  exit: Promise<void>;
  resolveExit(): void;
}

interface PendingRequest {
  child: UtilityProcess;
  generation: number;
  request: ArchiveIoOperationRequest;
  childPids: Set<number>;
  result?: unknown;
  error?: Error;
  cleanupComplete: boolean;
  queuedAt: number;
  startedAt?: number;
  workerPid?: number;
  admissionTimer?: NodeJS.Timeout;
  resolveResult(value: unknown): void;
  reject(error: Error): void;
}

let workerState: WorkerState | null = null;
const retiredWorkers = new Set<WorkerState>();
let nextGeneration = 1;
let shuttingDown = false;
const pending = new Map<string, PendingRequest>();
const operations = new Map<
  string,
  Promise<ArchiveIoResultMap[ArchiveIoOperationType]>
>();

function recordArchiveIoDiagnostic(
  request: ArchiveIoOperationRequest,
  fields: {
    stage: 'queued' | 'started' | 'progress' | 'failed' | 'finished';
    generation?: number;
    workerPid?: number;
    queueWaitMs?: number;
    durationMs?: number;
    progressStage?: string;
    files?: number;
    bytes?: number;
    childCleanup?: 'not-required' | 'cooperative' | 'forced';
    outcome?: 'succeeded' | 'failed' | 'interrupted';
    errorCode?: string;
  },
): void {
  try {
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'archive_io_operation',
      sessionKey: request.operationId,
      projectId: request.projectId,
      worktreeId: request.containerId,
      chatId: '',
      providerType: 'unknown',
      archiveIoRequestId: request.requestId,
      archiveIoOperationId: request.operationId,
      archiveIoOperationType: request.type,
      archiveIoStage: fields.stage,
      archiveIoWorkerGeneration: fields.generation,
      archiveIoWorkerPid: fields.workerPid,
      archiveIoQueueWaitMs: fields.queueWaitMs,
      archiveIoDurationMs: fields.durationMs,
      archiveIoProgressStage: fields.progressStage,
      archiveIoFileCount: fields.files,
      archiveIoByteCount: fields.bytes,
      archiveIoChildCleanup: fields.childCleanup,
      archiveIoOutcome: fields.outcome,
      archiveIoErrorCode: fields.errorCode,
    });
  } catch {
    // Diagnostics must never change archive behavior.
  }
}

function operationKey(request: ArchiveIoOperationRequest): string {
  return `${request.type}\0${request.operationId}`;
}

function post(child: UtilityProcess, message: unknown): void {
  child.postMessage(message);
}

function unwrapResponse(message: unknown): ArchiveIoResponse | null {
  if (isArchiveIoResponse(message)) return message;
  if (
    typeof message === 'object' &&
    message !== null &&
    'data' in message &&
    isArchiveIoResponse(message.data)
  ) {
    return message.data;
  }
  return null;
}

function settlePending(requestId: string): void {
  const record = pending.get(requestId);
  if (!record || !record.cleanupComplete) return;
  if (!record.error && record.result === undefined) return;
  pending.delete(requestId);
  if (record.admissionTimer) clearTimeout(record.admissionTimer);
  if (record.error) record.reject(record.error);
  else record.resolveResult(record.result);
}

function finishCleanup(
  record: PendingRequest,
  childCleanup: 'not-required' | 'cooperative' | 'forced',
): void {
  record.cleanupComplete = true;
  recordArchiveIoDiagnostic(record.request, {
    stage: 'finished',
    generation: record.generation,
    workerPid: record.workerPid,
    durationMs:
      record.startedAt === undefined
        ? undefined
        : Date.now() - record.startedAt,
    childCleanup,
    outcome: record.error ? 'failed' : 'succeeded',
  });
  settlePending(record.request.requestId);
}

function handleMessage(state: WorkerState, message: unknown): void {
  const response = unwrapResponse(message);
  if (!response || workerState?.generation !== state.generation) return;
  if (response.type === 'ready') {
    state.resolveReady();
    return;
  }
  if (response.type === 'shutdown-complete') return;
  const record = pending.get(response.requestId);
  if (
    !record ||
    record.child !== state.child ||
    record.generation !== state.generation
  ) {
    return;
  }
  if (record.admissionTimer) {
    clearTimeout(record.admissionTimer);
    record.admissionTimer = undefined;
  }
  if (response.type === 'child-started') {
    record.childPids.add(response.pid);
  } else if (response.type === 'child-exited') {
    record.childPids.delete(response.pid);
  } else if (response.type === 'result') {
    if (response.operationType !== record.request.type) {
      record.error = new Error(ARCHIVE_IO_INTERRUPTED_MESSAGE);
    } else {
      record.result = response.result;
    }
  } else if (response.type === 'error') {
    record.error = archiveErrorWithFrames(
      response.message,
      response.frames ?? [],
    );
    if (response.code === ARCHIVE_IO_GIT_TIMEOUT_CODE) {
      Object.assign(record.error, { code: 'ETIMEDOUT', killed: true });
    } else if (response.code === ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE) {
      Object.assign(record.error, { code: response.code });
    } else {
      const diagnostic = sanitizedDestructiveCode(response.failureCode);
      const code =
        response.code === 'ARCHIVE_IO_FAILED' &&
        diagnostic !== 'unknown' &&
        diagnostic !== 'Error' &&
        // Transport control classifications must come from the transport itself.
        !diagnostic.startsWith('ARCHIVE_IO_')
          ? diagnostic
          : sanitizedDestructiveCode(response.code);
      if (code !== 'unknown') Object.assign(record.error, { code });
      if (code === 'external.removal_not_permitted')
        classifyError(record.error, code);
    }
    recordArchiveIoDiagnostic(record.request, {
      stage: 'failed',
      generation: record.generation,
      workerPid: record.workerPid,
      durationMs:
        record.startedAt === undefined
          ? undefined
          : Date.now() - record.startedAt,
      outcome:
        response.code === 'ARCHIVE_IO_FAILED' ||
        response.code === ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE
          ? 'failed'
          : 'interrupted',
      errorCode: response.code,
    });
  } else if (response.type === 'cleanup-complete') {
    if (record.childPids.size > 0) {
      record.error = new Error(ARCHIVE_IO_INTERRUPTED_MESSAGE);
      const pids = Array.from(record.childPids);
      void Promise.allSettled(
        pids.map((pid) => killProcessGroupByPid(pid, 'SIGKILL')),
      ).then(() => {
        for (const pid of pids) record.childPids.delete(pid);
        finishCleanup(record, 'forced');
      });
      return;
    }
    finishCleanup(record, response.childCleanup);
    return;
  } else if (response.type === 'started') {
    record.startedAt = Date.now();
    record.workerPid = response.workerPid;
    recordArchiveIoDiagnostic(record.request, {
      stage: 'started',
      generation: record.generation,
      workerPid: response.workerPid,
      queueWaitMs: record.startedAt - record.queuedAt,
    });
  } else if (response.type === 'progress') {
    recordArchiveIoDiagnostic(record.request, {
      stage: 'progress',
      generation: record.generation,
      workerPid: record.workerPid,
      progressStage: response.stage,
      files: response.files,
      bytes: response.bytes,
    });
  }
  settlePending(response.requestId);
}

async function terminateTrackedChildren(state: WorkerState): Promise<void> {
  const pids = new Set<number>();
  for (const record of Array.from(pending.values())) {
    if (
      record.child === state.child &&
      record.generation === state.generation
    ) {
      for (const pid of Array.from(record.childPids)) pids.add(pid);
    }
  }
  await Promise.allSettled(
    Array.from(pids, (pid) => killProcessGroupByPid(pid, 'SIGKILL')),
  );
}

function createWorkerState(): WorkerState {
  const child = utilityProcess.fork(
    path.join(__dirname, WORKER_ENTRY_FILENAME),
    [],
    { serviceName: WORKER_SERVICE_NAME },
  );
  let resolveReady = (): void => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveExit = (): void => undefined;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const state: WorkerState = {
    child,
    generation: nextGeneration++,
    ready,
    resolveReady,
    rejectReady,
    exit,
    resolveExit,
  };
  child.on('message', (message) => {
    if (!unwrapResponse(message)) {
      void terminateTrackedChildren(state);
      try {
        child.kill();
      } catch {
        // The exit handler remains authoritative for request rejection.
      }
      return;
    }
    handleMessage(state, message);
  });
  child.once('exit', () => {
    void (async (): Promise<void> => {
      if (workerState === state) workerState = null;
      state.rejectReady(new Error(ARCHIVE_IO_INTERRUPTED_MESSAGE));
      await terminateTrackedChildren(state);
      for (const [requestId, record] of Array.from(pending.entries())) {
        if (record.child === child && record.generation === state.generation) {
          pending.delete(requestId);
          if (record.admissionTimer) clearTimeout(record.admissionTimer);
          recordArchiveIoDiagnostic(record.request, {
            stage: 'failed',
            generation: record.generation,
            workerPid: record.workerPid,
            durationMs:
              record.startedAt === undefined
                ? undefined
                : Date.now() - record.startedAt,
            outcome: 'interrupted',
            errorCode: 'ARCHIVE_IO_WORKER_EXITED',
          });
          record.reject(new Error(ARCHIVE_IO_INTERRUPTED_MESSAGE));
        }
      }
      state.resolveExit();
      retiredWorkers.delete(state);
    })();
  });
  return state;
}

async function ensureWorker(): Promise<WorkerState> {
  if (shuttingDown) throw new Error(ARCHIVE_IO_INTERRUPTED_MESSAGE);
  const state = workerState ?? createWorkerState();
  workerState = state;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      state.ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(ARCHIVE_IO_INTERRUPTED_MESSAGE)),
          STARTUP_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    return state;
  } catch (error) {
    try {
      state.child.kill();
    } catch {
      // The exit handler owns request rejection and descendant cleanup.
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function runArchiveIoRequest<T extends ArchiveIoOperationType>(
  request: Extract<ArchiveIoOperationRequest, { type: T }>,
  signal?: AbortSignal,
): Promise<ArchiveIoResultMap[T]> {
  const key = operationKey(request);
  const joined = operations.get(key);
  if (joined) {
    return joined.then((result) => {
      if (!isArchiveIoResult(request.type, result)) {
        throw new Error(ARCHIVE_IO_INTERRUPTED_MESSAGE);
      }
      return result;
    });
  }
  const queuedAt = Date.now();
  recordArchiveIoDiagnostic(request, { stage: 'queued' });
  let requestAdmitted = false;
  const running = (async (): Promise<ArchiveIoResultMap[T]> => {
    const state = await ensureWorker();
    if (signal?.aborted) throw new Error('Archive I/O request cancelled.');
    return new Promise<ArchiveIoResultMap[T]>((resolve, reject) => {
      const abort = (): void => {
        if (workerState !== state || !pending.has(request.requestId)) return;
        post(state.child, {
          version: ARCHIVE_IO_PROTOCOL_VERSION,
          type: 'cancel',
          requestId: request.requestId,
          operationId: request.operationId,
        });
      };
      const finishResolve = (value: ArchiveIoResultMap[T]): void => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      };
      const finishReject = (error: Error): void => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      };
      const record: PendingRequest = {
        child: state.child,
        generation: state.generation,
        request,
        childPids: new Set(),
        cleanupComplete: false,
        queuedAt,
        resolveResult: (value: unknown): void => {
          if (!isArchiveIoResult(request.type, value)) {
            finishReject(new Error(ARCHIVE_IO_INTERRUPTED_MESSAGE));
            return;
          }
          finishResolve(value);
        },
        reject: finishReject,
      };
      pending.set(request.requestId, record);
      requestAdmitted = true;
      signal?.addEventListener('abort', abort, { once: true });
      try {
        post(state.child, request);
        record.admissionTimer = setTimeout(() => {
          if (pending.get(request.requestId) !== record) return;
          if (workerState === state) {
            retiredWorkers.add(state);
            workerState = null;
          }
          const affected = Array.from(pending.values()).filter(
            (candidate) =>
              candidate.child === state.child &&
              candidate.generation === state.generation,
          );
          for (const candidate of affected) {
            if (candidate.admissionTimer) {
              clearTimeout(candidate.admissionTimer);
              candidate.admissionTimer = undefined;
            }
          }
          let killFailed = false;
          try {
            killFailed = state.child.kill() === false;
          } catch {
            killFailed = true;
          }
          void terminateTrackedChildren(state);
          for (const candidate of affected) {
            recordArchiveIoDiagnostic(candidate.request, {
              stage: 'failed',
              generation: state.generation,
              outcome: 'interrupted',
              errorCode: killFailed
                ? 'ARCHIVE_IO_ADMISSION_KILL_FAILED'
                : 'ARCHIVE_IO_ADMISSION_TIMEOUT',
            });
          }
          // The exit handler rejects these requests only after every tracked
          // child is gone, keeping archive lifecycle locks held until then.
        }, REQUEST_ADMISSION_TIMEOUT_MS);
        record.admissionTimer.unref?.();
      } catch {
        pending.delete(request.requestId);
        if (record.admissionTimer) clearTimeout(record.admissionTimer);
        finishReject(new Error(ARCHIVE_IO_INTERRUPTED_MESSAGE));
      }
      if (signal?.aborted) abort();
    });
  })()
    .catch((error: unknown) => {
      if (!requestAdmitted) {
        recordArchiveIoDiagnostic(request, {
          stage: 'failed',
          outcome: 'interrupted',
          errorCode: 'ARCHIVE_IO_TRANSPORT_FAILED',
        });
      }
      throw error;
    })
    .finally(() => {
      if (operations.get(key) === running) operations.delete(key);
    });
  operations.set(key, running);
  return running;
}

async function waitBounded(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return completed;
}

export async function shutdownArchiveIoRunner(): Promise<void> {
  shuttingDown = true;
  const states = new Set(retiredWorkers);
  if (workerState) states.add(workerState);
  await Promise.all(
    Array.from(states, async (state) => {
      try {
        post(state.child, {
          version: ARCHIVE_IO_PROTOCOL_VERSION,
          type: 'shutdown',
        });
      } catch {
        // Exit cleanup below is still authoritative.
      }
      if (await waitBounded(state.exit, SHUTDOWN_WAIT_MS)) return;
      try {
        state.child.kill();
      } catch {
        // Best effort; terminateTrackedChildren remains bounded by the exit path.
      }
      await terminateTrackedChildren(state);
      await waitBounded(state.exit, FORCED_CLEANUP_WAIT_MS);
    }),
  );
}

export function resetArchiveIoRunnerForTests(): void {
  for (const record of Array.from(pending.values())) {
    if (record.admissionTimer) clearTimeout(record.admissionTimer);
  }
  workerState = null;
  retiredWorkers.clear();
  nextGeneration = 1;
  shuttingDown = false;
  pending.clear();
  operations.clear();
}
