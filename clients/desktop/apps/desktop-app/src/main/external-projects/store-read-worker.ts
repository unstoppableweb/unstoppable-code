import { parentPort, workerData } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import {
  MAX_STORE_DB_BYTES,
  StoreMissingError,
  StoreSchemaError,
  StoreTooLargeError,
  withSqliteSnapshot,
} from './sqlite-snapshot';
import { isRecord } from '../lib/type-guards';
import {
  isStoreWorkerRequest,
  STORE_READ_RETRY_WITHIN_MS,
  type OpenCodeSessionsRequest,
  type OpenCodeSnapshotRequest,
  type StoreReadRequest,
  type StoreReadResponse,
  type StoreWorkerMessage,
  type T3CodeSnapshotRequest,
  type T3CodeThreadsRequest,
} from './store-read-contract';
import { readOpenCodeSessions, readOpenCodeSnapshot } from './opencode-store';
import { readT3CodeSnapshot, readT3CodeThreads } from './t3code-store';

interface StoreReaders<Snapshot, Detail> {
  snapshot(db: DatabaseSync, request: Snapshot): unknown;
  detail(db: DatabaseSync, request: Detail): unknown;
}

/**
 * Pure per-store readers, one registry so the worker owns all dispatch. A
 * store with no entry answers `error` until its adapter registers here.
 */
const readers: {
  t3code?: StoreReaders<T3CodeSnapshotRequest, T3CodeThreadsRequest>;
  opencode?: StoreReaders<OpenCodeSnapshotRequest, OpenCodeSessionsRequest>;
} = {
  t3code: {
    snapshot: (db) => readT3CodeSnapshot(db),
    detail: (db, request) => readT3CodeThreads(db, request.threadIds),
  },
  opencode: {
    snapshot: (db, request) => readOpenCodeSnapshot(db, request.maxSessions),
    detail: (db, request) => readOpenCodeSessions(db, request.sessionIds),
  },
};

function readerFor(
  request: StoreReadRequest,
): ((db: DatabaseSync) => unknown) | undefined {
  if (request.store === 't3code') {
    const reader = readers.t3code;
    if (!reader) return undefined;
    return request.mode === 'snapshot'
      ? (db): unknown => reader.snapshot(db, request)
      : (db): unknown => reader.detail(db, request);
  }
  const reader = readers.opencode;
  if (!reader) return undefined;
  return request.mode === 'snapshot'
    ? (db): unknown => reader.snapshot(db, request)
    : (db): unknown => reader.detail(db, request);
}

/** Maps a thrown reader or snapshot failure onto the wire's error codes. */
function failure(error: unknown): StoreReadResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof StoreMissingError)
    return { ok: false, code: 'missing', message };
  if (error instanceof StoreTooLargeError)
    return { ok: false, code: 'too-large', message };
  if (error instanceof StoreSchemaError)
    return { ok: false, code: 'schema', message };
  return { ok: false, code: 'error', message };
}

async function read(
  request: StoreReadRequest,
  tmpRoot: string | undefined,
): Promise<StoreReadResponse> {
  const reader = readerFor(request);
  if (!reader)
    return {
      ok: false,
      code: 'error',
      message: `No reader for store ${request.store}.`,
    };
  try {
    const data = await withSqliteSnapshot(
      request.dbPath,
      {
        maxBytes: MAX_STORE_DB_BYTES,
        tmpRoot,
        retryWithinMs: STORE_READ_RETRY_WITHIN_MS,
      },
      reader,
    );
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Reads provider SQLite stores off the main thread; holds no connection between requests. */
function run(): void {
  const port = parentPort;
  if (!port) return;
  // The runner owns this directory and removes it if it must terminate the worker.
  const data: unknown = workerData;
  const tmpRoot =
    isRecord(data) && typeof data.tmpRoot === 'string'
      ? data.tmpRoot
      : undefined;
  const send = (message: StoreWorkerMessage): void => port.postMessage(message);
  port.on('message', (input: unknown): void => {
    if (!isStoreWorkerRequest(input)) {
      send({ kind: 'fatal', error: 'Invalid store read request' });
      return;
    }
    const { id, request } = input;
    void read(request, tmpRoot).then((response) =>
      send({ kind: 'result', id, response }),
    );
  });
  send({ kind: 'ready' });
}
run();
