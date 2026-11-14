import { isRecord } from '../lib/type-guards';

/**
 * Private main/worker boundary for reading SQLite-backed provider stores. The
 * worker copies and opens the database; main only sees typed responses.
 */

/**
 * How long main waits for one store read before it terminates the worker. A
 * 512 MiB store copy plus a full read is slow on a spinning disk.
 */
export const STORE_READ_REQUEST_TIMEOUT_MS = 120_000;

/**
 * The worker retries a failed snapshot read only when the first attempt took
 * at most this long, so the retry fits in the request's time and a slow
 * failure returns its typed error instead of a terminated worker.
 */
export const STORE_READ_RETRY_WITHIN_MS = STORE_READ_REQUEST_TIMEOUT_MS / 3;

export interface T3CodeSnapshotRequest {
  store: 't3code';
  dbPath: string;
  mode: 'snapshot';
}
export interface T3CodeThreadsRequest {
  store: 't3code';
  dbPath: string;
  mode: 'threads';
  threadIds: string[];
}
export interface OpenCodeSnapshotRequest {
  store: 'opencode';
  dbPath: string;
  mode: 'snapshot';
  maxSessions: number;
}
export interface OpenCodeSessionsRequest {
  store: 'opencode';
  dbPath: string;
  mode: 'sessions';
  sessionIds: string[];
}

export type StoreReadRequest =
  | T3CodeSnapshotRequest
  | T3CodeThreadsRequest
  | OpenCodeSnapshotRequest
  | OpenCodeSessionsRequest;

export type StoreReadErrorCode = 'missing' | 'too-large' | 'schema' | 'error';

export type StoreReadResponse =
  | { ok: true; data: unknown }
  | { ok: false; code: StoreReadErrorCode; message: string };

export interface StoreWorkerRequest {
  id: number;
  request: StoreReadRequest;
}

export type StoreWorkerMessage =
  | { kind: 'ready' }
  | { kind: 'result'; id: number; response: StoreReadResponse }
  | { kind: 'fatal'; error: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function isStoreReadRequest(value: unknown): value is StoreReadRequest {
  if (!isRecord(value) || typeof value.dbPath !== 'string') return false;
  if (value.store === 't3code')
    return (
      value.mode === 'snapshot' ||
      (value.mode === 'threads' && isStringArray(value.threadIds))
    );
  if (value.store === 'opencode')
    return (
      (value.mode === 'snapshot' &&
        typeof value.maxSessions === 'number' &&
        Number.isInteger(value.maxSessions) &&
        value.maxSessions > 0) ||
      (value.mode === 'sessions' && isStringArray(value.sessionIds))
    );
  return false;
}

export function isStoreWorkerRequest(
  value: unknown,
): value is StoreWorkerRequest {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    Number.isInteger(value.id) &&
    value.id > 0 &&
    isStoreReadRequest(value.request)
  );
}

export function isStoreReadResponse(
  value: unknown,
): value is StoreReadResponse {
  if (!isRecord(value)) return false;
  if (value.ok === true) return 'data' in value;
  return (
    value.ok === false &&
    typeof value.message === 'string' &&
    (value.code === 'missing' ||
      value.code === 'too-large' ||
      value.code === 'schema' ||
      value.code === 'error')
  );
}

export function isStoreWorkerMessage(
  value: unknown,
): value is StoreWorkerMessage {
  if (!isRecord(value)) return false;
  if (value.kind === 'ready') return true;
  if (value.kind === 'fatal') return typeof value.error === 'string';
  return (
    value.kind === 'result' &&
    typeof value.id === 'number' &&
    isStoreReadResponse(value.response)
  );
}
