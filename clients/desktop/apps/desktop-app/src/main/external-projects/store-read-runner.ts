import { Worker } from 'node:worker_threads';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isStoreWorkerMessage,
  STORE_READ_REQUEST_TIMEOUT_MS,
  type StoreReadRequest,
  type StoreReadResponse,
} from './store-read-contract';

const STARTUP_TIMEOUT_MS = 10_000;

interface Pending {
  id: number;
  request: StoreReadRequest;
  signal: AbortSignal | undefined;
  resolve: (response: StoreReadResponse) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

function abortError(): Error {
  const error = new Error('Store read aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Main-side handle for the store read worker. One request runs at a time, the
 * worker is unref'd so it never holds the app open, and it starts on first use.
 * A crashed or timed-out worker rejects its request and is replaced on the next
 * read: an import is a user action worth retrying, unlike a background index.
 * Each worker gets a scratch directory the runner owns and removes after the
 * worker is gone: terminating a worker mid-copy skips the snapshot's own
 * cleanup, and the copy can be as large as the store itself.
 */
export class StoreReadRunner {
  private worker: Worker | undefined;
  private workerDirectory: string | undefined;
  private discarding: Promise<void> = Promise.resolve();
  private ready = false;
  private readonly queue: Pending[] = [];
  private active: Pending | undefined;
  private nextId = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly entry = join(
      __dirname,
      'external-projects-store-read-worker.js',
    ),
    private readonly tmpRoot = tmpdir(),
  ) {}

  read(
    request: StoreReadRequest,
    signal?: AbortSignal,
  ): Promise<StoreReadResponse> {
    if (this.closed)
      return Promise.reject(new Error('Store read runner closed'));
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        id: ++this.nextId,
        request,
        signal,
        resolve,
        reject,
        onAbort: (): void => this.abort(pending),
      };
      signal?.addEventListener('abort', pending.onAbort, { once: true });
      this.queue.push(pending);
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const error = new Error('Store read runner closed');
    this.settleAll(error);
    this.discardWorker();
    await this.discarding;
  }

  private abort(pending: Pending): void {
    if (this.active === pending) {
      // The worker cannot cancel a copy in progress; drop it and start fresh.
      this.fail(abortError());
      return;
    }
    const index = this.queue.indexOf(pending);
    if (index < 0) return;
    this.queue.splice(index, 1);
    pending.reject(abortError());
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    if (!this.worker) {
      this.spawn();
      return;
    }
    if (!this.ready) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.arm(STORE_READ_REQUEST_TIMEOUT_MS, 'request');
    try {
      this.worker.postMessage({ id: next.id, request: next.request });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private spawn(): void {
    const directory = mkdtempSync(join(this.tmpRoot, 'canopy-store-worker-'));
    let worker: Worker;
    try {
      worker = new Worker(this.entry, {
        name: 'external-projects-store-read',
        workerData: { tmpRoot: directory },
      });
    } catch (error) {
      void rm(directory, { recursive: true, force: true });
      throw error;
    }
    this.workerDirectory = directory;
    worker.unref();
    this.worker = worker;
    this.ready = false;
    this.arm(STARTUP_TIMEOUT_MS, 'startup');
    worker.on('message', (message: unknown): void => {
      if (worker === this.worker) this.receive(message);
    });
    worker.on('error', (error): void => {
      if (worker === this.worker) this.fail(error);
    });
    worker.on('exit', (code): void => {
      if (worker === this.worker)
        this.fail(new Error(`Store read worker exited (${code})`));
    });
  }

  private receive(input: unknown): void {
    if (!isStoreWorkerMessage(input)) {
      this.fail(new Error('Malformed store read response'));
      return;
    }
    if (input.kind === 'fatal') {
      this.fail(new Error(input.error));
      return;
    }
    if (input.kind === 'ready') {
      if (this.ready) return;
      this.ready = true;
      this.clearTimer();
      this.pump();
      return;
    }
    const pending = this.active;
    if (!pending || pending.id !== input.id) {
      this.fail(new Error('Unexpected store read response'));
      return;
    }
    this.active = undefined;
    this.clearTimer();
    this.detach(pending);
    pending.resolve(input.response);
    this.pump();
  }

  /**
   * Fails the in-flight request and retires the worker; queued reads get a
   * fresh one. With nothing in flight the worker died before it could serve
   * (a bad entry, say), so queued reads fail too instead of respawning forever.
   */
  private fail(error: Error): void {
    const active = this.active;
    this.active = undefined;
    if (active) {
      this.detach(active);
      active.reject(error);
    } else {
      this.settleAll(error);
    }
    this.clearTimer();
    this.discardWorker();
    if (!this.closed) this.pump();
  }

  private settleAll(error: Error): void {
    const active = this.active;
    this.active = undefined;
    const all = active
      ? [active, ...this.queue.splice(0)]
      : this.queue.splice(0);
    for (const pending of all) {
      this.detach(pending);
      pending.reject(error);
    }
  }

  /** Retires the worker now; `discarding` settles once it is gone and its directory removed. */
  private discardWorker(): void {
    const worker = this.worker;
    const directory = this.workerDirectory;
    this.worker = undefined;
    this.workerDirectory = undefined;
    this.ready = false;
    this.clearTimer();
    if (!worker) return;
    const done = (async (): Promise<void> => {
      await worker.terminate().catch((): void => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
    })().catch((): void => undefined);
    this.discarding = Promise.all([this.discarding, done]).then(
      (): void => undefined,
    );
  }

  private detach(pending: Pending): void {
    pending.signal?.removeEventListener('abort', pending.onAbort);
  }

  private arm(ms: number, phase: string): void {
    this.clearTimer();
    this.timer = setTimeout(
      (): void =>
        this.fail(new Error(`Store read worker timed out (${phase})`)),
      ms,
    );
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
