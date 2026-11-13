import * as path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import type {
  ChatSearchQueryRequest,
  ChatSearchResult,
} from '@canopy/desktop-shared/types';
import type {
  ChatSearchQueryWorkerRequest,
  ChatSearchQueryWorkerResponse,
} from './query-worker';

interface PendingQuery {
  payload: ChatSearchQueryWorkerRequest;
  resolve: (results: ChatSearchResult[]) => void;
  reject: (error: Error) => void;
  child: UtilityProcess | null;
  watchdog: NodeJS.Timeout | null;
  settled: boolean;
}

const WORKER_ENTRY_FILENAME = 'chat-search-query-worker.js';
const WORKER_SERVICE_NAME = 'chat-search-query';
const QUERY_TIMEOUT_MS = 30_000;

declare global {
  var __CANOPY_E2E_CHAT_SEARCH_WORKER_RUNS__: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkerResponse(
  value: unknown,
): value is ChatSearchQueryWorkerResponse {
  return (
    isRecord(value) &&
    typeof value.ok === 'boolean' &&
    (value.ok
      ? Array.isArray(value.results)
      : typeof value.message === 'string')
  );
}

export class ChatSearchQueryRunner {
  private readonly queue: PendingQuery[] = [];
  private readonly liveChildren = new Set<UtilityProcess>();
  private active: PendingQuery | null = null;
  private closed = false;

  run(
    dbPath: string,
    request: ChatSearchQueryRequest,
    now?: number,
    offset?: number,
  ): Promise<ChatSearchResult[]> {
    if (this.closed) {
      return Promise.reject(new Error('Chat-search query worker is closed.'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        payload: { dbPath, request, now, offset },
        resolve,
        reject,
        child: null,
        watchdog: null,
        settled: false,
      });
      this.pump();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('Chat-search query worker was canceled.');
    for (const pending of this.queue.splice(0)) pending.reject(error);
    if (this.active) this.rejectActive(error);
    this.liveChildren.forEach((child) => {
      try {
        child.kill();
      } catch {
        // The one-shot worker may already have exited.
      }
    });
  }

  private pump(): void {
    if (this.closed || this.active) return;
    const pending = this.queue.shift();
    if (!pending) return;
    this.active = pending;

    if (__CANOPY_E2E__) {
      globalThis.__CANOPY_E2E_CHAT_SEARCH_WORKER_RUNS__ =
        (globalThis.__CANOPY_E2E_CHAT_SEARCH_WORKER_RUNS__ ?? 0) + 1;
      if (process.env.CANOPY_E2E_FORCE_CHAT_SEARCH_WORKER_FAILURE === '1') {
        this.rejectActive(
          new Error('E2E forced chat-search query worker failure.'),
        );
        return;
      }
    }

    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(
        path.join(__dirname, WORKER_ENTRY_FILENAME),
        [],
        { serviceName: WORKER_SERVICE_NAME },
      );
    } catch (error) {
      this.rejectActive(
        new Error(
          `Failed to spawn chat-search query worker: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
    pending.child = child;
    this.liveChildren.add(child);
    pending.watchdog = setTimeout(() => {
      this.rejectActive(
        new Error(`Chat-search query worker exceeded ${QUERY_TIMEOUT_MS} ms.`),
      );
    }, QUERY_TIMEOUT_MS);
    pending.watchdog.unref?.();

    child.on('message', (message: unknown) => {
      if (this.active !== pending || pending.settled) return;
      const payload =
        isRecord(message) && 'data' in message ? message.data : message;
      if (!isWorkerResponse(payload)) {
        this.rejectActive(
          new Error('Chat-search query worker returned a malformed response.'),
        );
      } else if (!payload.ok) {
        this.rejectActive(new Error(payload.message));
      } else {
        this.resolveActive(payload.results);
      }
    });
    child.on('exit', (code: number) => {
      this.liveChildren.delete(child);
      if (this.active === pending && !pending.settled) {
        this.rejectActive(
          new Error(
            `Chat-search query worker exited (code ${code}) before responding.`,
          ),
        );
      }
    });

    try {
      child.postMessage(pending.payload);
    } catch (error) {
      this.rejectActive(
        new Error(
          `Failed to post chat-search query request: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  private finishActive(): PendingQuery | null {
    const pending = this.active;
    if (!pending || pending.settled) return null;
    pending.settled = true;
    if (pending.watchdog) clearTimeout(pending.watchdog);
    pending.watchdog = null;
    this.active = null;
    return pending;
  }

  private resolveActive(results: ChatSearchResult[]): void {
    const pending = this.finishActive();
    if (!pending) return;
    pending.resolve(results);
    this.pump();
  }

  private rejectActive(error: Error): void {
    const pending = this.finishActive();
    if (!pending) return;
    try {
      pending.child?.kill();
    } catch {
      // The one-shot worker may already have exited.
    }
    pending.reject(error);
    this.pump();
  }
}
