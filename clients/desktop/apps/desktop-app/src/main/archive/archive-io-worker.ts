import { destructiveFailureCode } from '../lib/destructive-failure-context';
import { archiveErrorFrames } from '../lib/archive-error-frames';
import type { ParentPort } from 'electron';
import type { FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { sep } from 'node:path';
import { executeArchiveIoRequest } from './archive-io-engine';
import {
  ArchiveGitCommandError,
  ArchiveGitRecoveryRequiredError,
} from './archive-git-operations';
import {
  ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE,
  ARCHIVE_IO_GIT_TIMEOUT_CODE,
  ARCHIVE_IO_PROTOCOL_VERSION,
  isArchiveIoRequest,
  isMeasurementRequest,
  type ArchiveIoOperationRequest,
  type ArchiveIoResponse,
} from './archive-io-protocol';

interface QueuedRequest {
  request: ArchiveIoOperationRequest;
  controller: AbortController;
}

interface ActiveRequest extends QueuedRequest {
  promise: Promise<void>;
}

interface ArchiveIoE2eFileSyncConfig {
  workspaceRoot: string;
  observationPath: string;
}

interface ArchiveIoE2eFileSyncObservation {
  flushedFiles: number;
  rejectedReadOnlyFlushes: number;
  quarantineSharingViolations: number;
}

let archiveIoE2eFileSyncInstalled = false;

function installArchiveIoE2eFileSyncInstrumentation(): void {
  if (
    archiveIoE2eFileSyncInstalled ||
    typeof __CANOPY_E2E__ === 'undefined' ||
    !__CANOPY_E2E__
  ) {
    return;
  }
  const raw = process.env.CANOPY_E2E_ARCHIVE_FILE_SYNC_OBSERVATION;
  if (!raw) return;
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.workspaceRoot !== 'string' ||
    typeof parsed.observationPath !== 'string'
  ) {
    throw new Error('Invalid archive I/O E2E file-sync configuration.');
  }
  archiveIoE2eFileSyncInstalled = true;
  const config: ArchiveIoE2eFileSyncConfig = {
    workspaceRoot: parsed.workspaceRoot,
    observationPath: parsed.observationPath,
  };
  const fs = process.getBuiltinModule('node:fs/promises');
  const syncFs = process.getBuiltinModule('node:fs');
  const originalOpen = fs.open;
  const originalRename = fs.rename;
  const observation: ArchiveIoE2eFileSyncObservation = {
    flushedFiles: 0,
    rejectedReadOnlyFlushes: 0,
    quarantineSharingViolations: 0,
  };
  const persist = (): void => {
    syncFs.writeFileSync(
      config.observationPath,
      JSON.stringify(observation),
      'utf8',
    );
  };
  persist();
  fs.rename = async (
    ...args: Parameters<typeof originalRename>
  ): Promise<void> => {
    if (
      String(args[1]).endsWith('.archive-quarantine') &&
      observation.quarantineSharingViolations === 0
    ) {
      observation.quarantineSharingViolations += 1;
      persist();
      throw Object.assign(
        new Error('Transient Windows quarantine sharing violation'),
        { code: 'EBUSY' },
      );
    }
    return originalRename(...args);
  };
  fs.open = async (
    ...args: Parameters<typeof originalOpen>
  ): Promise<FileHandle> => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(config.workspaceRoot + sep)) {
      const sync = handle.sync.bind(handle);
      handle.sync = async (): Promise<void> => {
        if ((await handle.stat()).isFile()) {
          if (args[1] === 'r') {
            observation.rejectedReadOnlyFlushes += 1;
            persist();
            throw Object.assign(
              new Error('EPERM: operation not permitted, fsync'),
              { code: 'EPERM', syscall: 'fsync' },
            );
          }
          observation.flushedFiles += 1;
          persist();
        }
        await sync();
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function startArchiveIoWorker(
  parentPort: ParentPort,
  exitProcess: (code: number) => void = (code) => process.exit(code),
): void {
  // Electron patches `fs` in utility processes too, treating `*.asar` files as
  // read-only folders. Archive I/O removes, copies, and measures checkouts
  // that can contain them (for example `node_modules/electron`), so every fs
  // call here must see them as plain files; otherwise recursive removal
  // leaves them behind and fails with ENOTEMPTY. This is process-wide, which
  // is safe only because the worker bundle's runtime requires are all Node
  // builtins: a dependency loaded from inside app.asar would stop resolving.
  process.noAsar = true;
  installArchiveIoE2eFileSyncInstrumentation();
  const highPriorityQueue: QueuedRequest[] = [];
  const measurementQueue: QueuedRequest[] = [];
  const known = new Map<string, QueuedRequest>();
  let active: ActiveRequest | null = null;
  let shuttingDown = false;

  const post = (response: ArchiveIoResponse): void => {
    parentPort.postMessage(response);
  };

  const drain = (): void => {
    if (active || shuttingDown) return;
    const queued = highPriorityQueue.shift() ?? measurementQueue.shift();
    if (!queued) return;
    const { request, controller } = queued;
    const childPids = new Set<number>();
    let hadChildren = false;
    const promise = (async (): Promise<void> => {
      post({
        version: ARCHIVE_IO_PROTOCOL_VERSION,
        type: 'started',
        requestId: request.requestId,
        operationId: request.operationId,
        workerPid: process.pid,
      });
      try {
        const result = await executeArchiveIoRequest(
          request,
          controller.signal,
          {
            progress: (stage, counts) =>
              post({
                version: ARCHIVE_IO_PROTOCOL_VERSION,
                type: 'progress',
                requestId: request.requestId,
                stage,
                ...counts,
              }),
            child: {
              started: (pid) => {
                hadChildren = true;
                childPids.add(pid);
                post({
                  version: ARCHIVE_IO_PROTOCOL_VERSION,
                  type: 'child-started',
                  requestId: request.requestId,
                  pid,
                });
              },
              exited: (pid, code, signal) => {
                childPids.delete(pid);
                post({
                  version: ARCHIVE_IO_PROTOCOL_VERSION,
                  type: 'child-exited',
                  requestId: request.requestId,
                  pid,
                  code,
                  signal,
                });
              },
            },
          },
        );
        post({
          version: ARCHIVE_IO_PROTOCOL_VERSION,
          type: 'result',
          requestId: request.requestId,
          operationType: request.type,
          result,
        });
      } catch (error) {
        // Capture V8 call sites before anything can format the stack.
        const frames = controller.signal.aborted
          ? undefined
          : archiveErrorFrames(error)
              .filter((frame) => frame.length <= 4096)
              .slice(0, 64);
        post({
          version: ARCHIVE_IO_PROTOCOL_VERSION,
          type: 'error',
          requestId: request.requestId,
          code: controller.signal.aborted
            ? 'ARCHIVE_IO_CANCELLED'
            : error instanceof ArchiveGitCommandError && error.timedOut
              ? ARCHIVE_IO_GIT_TIMEOUT_CODE
              : error instanceof ArchiveGitRecoveryRequiredError
                ? ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE
                : 'ARCHIVE_IO_FAILED',
          message: error instanceof Error ? error.message : String(error),
          failureCode: controller.signal.aborted
            ? undefined
            : destructiveFailureCode(error),
          // Bounded optional diagnostics, independent of the local message.
          frames,
        });
      } finally {
        // Engine operations do not complete their promise until every child
        // exit has been observed. Keep the explicit set as a fail-closed guard
        // against a future engine operation violating that contract.
        if (childPids.size > 0) {
          post({
            version: ARCHIVE_IO_PROTOCOL_VERSION,
            type: 'error',
            requestId: request.requestId,
            code: 'ARCHIVE_IO_CHILD_STILL_RUNNING',
            message: 'Archive I/O child cleanup did not complete.',
          });
        }
        post({
          version: ARCHIVE_IO_PROTOCOL_VERSION,
          type: 'cleanup-complete',
          requestId: request.requestId,
          childCleanup:
            childPids.size > 0
              ? 'forced'
              : hadChildren
                ? 'cooperative'
                : 'not-required',
        });
        known.delete(request.operationId);
        active = null;
        drain();
      }
    })();
    active = { ...queued, promise };
  };

  const enqueue = (request: ArchiveIoOperationRequest): void => {
    if (shuttingDown) {
      post({
        version: ARCHIVE_IO_PROTOCOL_VERSION,
        type: 'error',
        requestId: request.requestId,
        code: 'ARCHIVE_IO_SHUTTING_DOWN',
        message: 'Archive I/O worker is shutting down.',
      });
      post({
        version: ARCHIVE_IO_PROTOCOL_VERSION,
        type: 'cleanup-complete',
        requestId: request.requestId,
        childCleanup: 'not-required',
      });
      return;
    }
    if (known.has(request.operationId)) {
      post({
        version: ARCHIVE_IO_PROTOCOL_VERSION,
        type: 'error',
        requestId: request.requestId,
        code: 'ARCHIVE_IO_DUPLICATE_OPERATION',
        message: 'Duplicate archive I/O operation.',
      });
      post({
        version: ARCHIVE_IO_PROTOCOL_VERSION,
        type: 'cleanup-complete',
        requestId: request.requestId,
        childCleanup: 'not-required',
      });
      return;
    }
    const queued = { request, controller: new AbortController() };
    known.set(request.operationId, queued);
    (isMeasurementRequest(request) ? measurementQueue : highPriorityQueue).push(
      queued,
    );
    post({
      version: ARCHIVE_IO_PROTOCOL_VERSION,
      type: 'accepted',
      requestId: request.requestId,
    });
    drain();
  };

  const cancel = (requestId: string, operationId: string): void => {
    const queued = known.get(operationId);
    if (!queued || queued.request.requestId !== requestId) return;
    queued.controller.abort();
    for (const queue of [highPriorityQueue, measurementQueue]) {
      const index = queue.indexOf(queued);
      if (index !== -1) {
        queue.splice(index, 1);
        known.delete(operationId);
        post({
          version: ARCHIVE_IO_PROTOCOL_VERSION,
          type: 'error',
          requestId,
          code: 'ARCHIVE_IO_CANCELLED',
          message: 'Archive I/O request cancelled.',
        });
        post({
          version: ARCHIVE_IO_PROTOCOL_VERSION,
          type: 'cleanup-complete',
          requestId,
          childCleanup: 'not-required',
        });
        break;
      }
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const queued of [...highPriorityQueue, ...measurementQueue]) {
      queued.controller.abort();
      known.delete(queued.request.operationId);
      post({
        version: ARCHIVE_IO_PROTOCOL_VERSION,
        type: 'error',
        requestId: queued.request.requestId,
        code: 'ARCHIVE_IO_SHUTTING_DOWN',
        message: 'Archive I/O worker is shutting down.',
      });
      post({
        version: ARCHIVE_IO_PROTOCOL_VERSION,
        type: 'cleanup-complete',
        requestId: queued.request.requestId,
        childCleanup: 'not-required',
      });
    }
    highPriorityQueue.length = 0;
    measurementQueue.length = 0;
    active?.controller.abort();
    await active?.promise;
    post({ version: ARCHIVE_IO_PROTOCOL_VERSION, type: 'shutdown-complete' });
    exitProcess(0);
  };

  parentPort.on('message', (event: unknown): void => {
    const payload = isRecord(event) && 'data' in event ? event.data : event;
    if (!isArchiveIoRequest(payload)) {
      if (
        isRecord(payload) &&
        typeof payload.requestId === 'string' &&
        payload.requestId.length > 0
      ) {
        post({
          version: ARCHIVE_IO_PROTOCOL_VERSION,
          type: 'error',
          requestId: payload.requestId,
          code: 'ARCHIVE_IO_INVALID_REQUEST',
          message: 'Archive I/O worker received an invalid request.',
        });
        post({
          version: ARCHIVE_IO_PROTOCOL_VERSION,
          type: 'cleanup-complete',
          requestId: payload.requestId,
          childCleanup: 'not-required',
        });
      }
      return;
    }
    if (payload.type === 'shutdown') {
      void shutdown();
    } else if (payload.type === 'cancel') {
      cancel(payload.requestId, payload.operationId);
    } else {
      enqueue(payload);
    }
  });

  post({
    version: ARCHIVE_IO_PROTOCOL_VERSION,
    type: 'ready',
    workerPid: process.pid,
  });
}

const workerParentPort: ParentPort | undefined = process.parentPort;
if (workerParentPort) startArchiveIoWorker(workerParentPort);
