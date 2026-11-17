import { dirname } from 'node:path';
import type { MessagePort } from 'node:worker_threads';
import {
  recoverW5CommitLog,
  type W5DurabilityPort,
  type W5RecoveryReport,
  type W5ProcessFileLock,
} from './apply';
import type { W5ConfinedFileReaderSource } from './capture-contract';
import { W5CommitLog } from './commit-log';
import { anchorW5CaptureRoot, ensureW5DataRoot } from './data-root';
import {
  isW5CommitLogRequest,
  isW5CommitLogWorkerData,
  readW5CommitLogRequestId,
  type W5CommitLogRequest,
  type W5CommitLogResponse,
  type W5CommitLogStartupMessage,
} from './worker-contract';
import {
  MALFORMED_REQUEST_MESSAGE,
  W5CommitLogRequestHandler,
  toW5CommitLogWorkerError,
} from './worker-requests';

/*
 * The W5 commit log worker: a thread inside its host process that holds the
 * commit log's only connection, so synchronous SQLite stays off the host's
 * event loop (CAN-3805). It opens the log, runs launch recovery, reports
 * `ready` or `openFailed`, and then runs writes one at a time in the order
 * they arrive, so commits and their file writes never interleave; reads run
 * beside them (CAN-5589, `W5CommitLogRequestHandler.dispatch`).
 *
 * The host stops it with `Worker.terminate()`. Node closes the connection as
 * it tears down the thread, which releases the exclusive lock for the next
 * opener; a commit whose files were not yet written is finished by the next
 * worker's recovery.
 *
 * Launch heals log only commit ID and operation locally. Error messages are fixed text or the commit log's own,
 * which carry no file contents. Each host's worker entry supplies its
 * durability, trusted OS and, on win32, its handle-confined reader; this body
 * reads no platform.
 */

export interface W5CommitLogWorkerHost {
  /** The host's durable writes and folder syncs. */
  readonly durability: W5DurabilityPort;
  /** Host filesystem exclusion, composed at the execution owner. */
  readonly processLock?: W5ProcessFileLock;
  /** Trusted host OS, for capture; never taken from a request. */
  readonly os: NodeJS.Platform | null;
  /** win32: the host's handle-confined capture reads; without it capture refuses. */
  readonly confinedReader?: W5ConfinedFileReaderSource;
}

const INVALID_CONFIGURATION_MESSAGE =
  'The W5 commit log worker was started without a database path and root';
const UNSENDABLE_RESULT_MESSAGE = 'The W5 commit log result could not be sent';

function respond(port: MessagePort, response: W5CommitLogResponse): void {
  try {
    port.postMessage(response);
  } catch {
    // A result that cannot be cloned must still answer its request.
    port.postMessage({
      id: response.id,
      ok: false,
      error: { kind: 'failed', message: UNSENDABLE_RESULT_MESSAGE },
    } satisfies W5CommitLogResponse);
  }
}

async function answer(
  worker: W5CommitLogRequestHandler,
  request: W5CommitLogRequest,
): Promise<W5CommitLogResponse> {
  try {
    return {
      id: request.id,
      ok: true,
      result: await worker.dispatch(request),
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: toW5CommitLogWorkerError(error),
    };
  }
}

function listen(port: MessagePort, worker: W5CommitLogRequestHandler): void {
  port.on('message', (message: unknown): void => {
    if (isW5CommitLogRequest(message)) {
      // The handler orders writes and runs reads beside them.
      void answer(worker, message).then((response) => respond(port, response));
      return;
    }
    // Answer a malformed request that has an id, so the caller fails at
    // once instead of waiting for its timeout.
    const id = readW5CommitLogRequestId(message);
    if (id !== undefined) {
      respond(port, {
        id,
        ok: false,
        error: { kind: 'malformed', message: MALFORMED_REQUEST_MESSAGE },
      });
    }
  });
}

function report(port: MessagePort, message: W5CommitLogStartupMessage): void {
  port.postMessage(message);
}

/** Runs the worker on `port` with the host's `workerData`. */
export async function runW5CommitLogWorker(
  port: MessagePort,
  data: unknown,
  host: W5CommitLogWorkerHost,
): Promise<void> {
  if (!isW5CommitLogWorkerData(data)) {
    report(port, {
      type: 'openFailed',
      error: { kind: 'malformed', message: INVALID_CONFIGURATION_MESSAGE },
    });
    return;
  }
  let log: W5CommitLog;
  let recovery: W5RecoveryReport;
  let captureRoot: string | undefined;
  try {
    // Creates and exclusively locks the log. Another holder fails the open
    // with WRITER_UNAVAILABLE, having written nothing.
    log = W5CommitLog.open(data.dbPath);
  } catch (error) {
    // Without a listener the thread then exits on its own.
    report(port, {
      type: 'openFailed',
      error: toW5CommitLogWorkerError(error),
    });
    return;
  }
  try {
    // Before any request, so no change is committed over one an earlier
    // process committed but did not finish writing, and none lands outside
    // a root that does not exist yet. After the open, which creates the
    // database's folder.
    await ensureW5DataRoot(
      data.root,
      host.durability.syncDirectory,
      data.dataRoot === undefined
        ? {}
        : { dataRoot: data.dataRoot, dbFolder: dirname(data.dbPath) },
    );
    recovery = await recoverW5CommitLog(log, {
      root: data.root,
      durability: host.durability,
      processLock: host.processLock,
      healCleanConflictOperations:
        data.healCleanConflictOperations === undefined
          ? undefined
          : new Set(data.healCleanConflictOperations),
      onAbandoned: (entry) =>
        process.stderr.write(
          `W5 launch abandoned clean conflict: commit ${entry.commitId}, ${entry.operation}\n`,
        ),
    });
    const details = log.listRecoveryRequiredCommitDiagnostics();
    if (details.length > 0) recovery.recoveryRequiredDetails = details;
    // Before `ready`, so before any capture; the host pins the first one.
    captureRoot = await anchorW5CaptureRoot(data.root, data.captureRoot);
  } catch (error) {
    log.close();
    report(port, {
      type: 'openFailed',
      error: toW5CommitLogWorkerError(error),
    });
    return;
  }
  // Listening keeps the thread, and so the connection and its lock, alive
  // until the host terminates it.
  listen(
    port,
    new W5CommitLogRequestHandler(
      log,
      { ...data, ...(captureRoot !== undefined && { captureRoot }) },
      recovery,
      host.durability,
      host.os,
      host.confinedReader,
      host.processLock,
    ),
  );
  report(port, {
    type: 'ready',
    ...(captureRoot !== undefined && { captureRoot }),
  });
}
