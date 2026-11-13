import { DatabaseSync } from 'node:sqlite';
import type { ParentPort } from 'electron';
import type { ChatSearchQueryRequest } from '@canopy/desktop-shared/types';
import { queryChatSearchDatabase } from './query';

const BUSY_TIMEOUT_MS = 5000;

export interface ChatSearchQueryWorkerRequest {
  dbPath: string;
  request: ChatSearchQueryRequest;
  now?: number;
  offset?: number;
}

export type ChatSearchQueryWorkerResponse =
  | { ok: true; results: ReturnType<typeof queryChatSearchDatabase> }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkerRequest(
  value: unknown,
): value is ChatSearchQueryWorkerRequest {
  return (
    isRecord(value) &&
    typeof value.dbPath === 'string' &&
    isRecord(value.request) &&
    typeof value.request.query === 'string' &&
    (value.request.limit === undefined ||
      typeof value.request.limit === 'number') &&
    (value.now === undefined || typeof value.now === 'number') &&
    (value.offset === undefined || typeof value.offset === 'number')
  );
}

/**
 * Opens the index read-only. The main process owns the file and is the only
 * writer, so this worker must never run schema initialization or the
 * delete-and-rebuild recovery in `openChatSearchDatabase()` — a transient lock
 * against the main process's live connection would otherwise destroy the user's
 * index and return a valid-but-empty in-memory database, silently reporting no
 * results. Every failure here becomes an explicit rejection that
 * `queryResponsive()` converts to a bounded empty response without projecting
 * the oversized page on Electron main.
 */
export function executeChatSearchQuery(
  request: ChatSearchQueryWorkerRequest,
): ChatSearchQueryWorkerResponse {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(request.dbPath, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    return {
      ok: true,
      results: queryChatSearchDatabase(
        db,
        request.request,
        request.now,
        request.offset,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

function respondOnce(parentPort: ParentPort, payload: unknown): void {
  const response = isWorkerRequest(payload)
    ? executeChatSearchQuery(payload)
    : { ok: false as const, message: 'Malformed chat-search query request.' };
  try {
    parentPort.postMessage(response);
  } finally {
    process.exit(0);
  }
}

const workerParentPort: ParentPort | undefined = process.parentPort;
if (workerParentPort) {
  workerParentPort.once('message', (event: unknown): void => {
    respondOnce(
      workerParentPort,
      isRecord(event) && 'data' in event ? event.data : undefined,
    );
  });
}
