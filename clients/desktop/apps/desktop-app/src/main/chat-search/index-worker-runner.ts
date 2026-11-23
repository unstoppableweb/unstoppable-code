import { Worker } from 'node:worker_threads';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { IndexWorkerRequest } from './index-worker-contract';
import { isIndexWorkerResponse } from './index-worker-contract';

interface Pending {
  request: IndexWorkerRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * The runner refused a request because it is closing or its queue is full.
 * The runner has not failed, and the request says nothing about its source.
 */
export class ChatSearchIndexWorkerUnavailableError extends Error {
  override readonly name = 'ChatSearchIndexWorkerUnavailableError';
}

/** One bounded FIFO and one SQLite connection; failure never falls back to blocking main. */
export class ChatSearchIndexWorkerRunner {
  readonly ready: Promise<string>;
  private readonly worker: Worker;
  private resolveReady: (path: string) => void = (): void => undefined;
  private rejectReady: (error: Error) => void = (): void => undefined;
  private readonly pending: Pending[] = [];
  private active: Pending | undefined;
  private nextId = 0;
  private readyPath: string | undefined;
  private failure: Error | undefined;
  private closing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private exited = false;
  private temporaryDirectory: string | undefined;
  private temporaryCleanup: Promise<void> | undefined;

  constructor(
    dbPath: string,
    entry = join(__dirname, 'chat-search-index-worker.js'),
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch((): void => undefined);
    this.worker = new Worker(entry, {
      workerData: { dbPath },
      name: 'chat-search-index',
    });
    this.worker.unref();
    this.armTimeout('startup');
    this.worker.on('message', (message: unknown): void =>
      this.receive(message),
    );
    this.worker.on('error', (error): void => this.fail(error));
    this.worker.on('exit', (code): void => {
      this.exited = true;
      void this.cleanupTemporaryDirectory();
      if (!this.closing || this.active || this.pending.length)
        this.fail(new Error(`Search index worker exited (${code})`));
    });
  }

  /** True once the worker failed; every later request is rejected. */
  hasFailed(): boolean {
    return this.failure !== undefined;
  }

  run(
    method: IndexWorkerRequest['method'],
    args: unknown[] = [],
  ): Promise<unknown> {
    const rejection =
      this.failure ??
      (this.closing && method !== 'close'
        ? new ChatSearchIndexWorkerUnavailableError(
            'Search index worker is closing',
          )
        : method !== 'close' && this.pending.length >= 256
          ? new ChatSearchIndexWorkerUnavailableError(
              'Search index worker queue is full',
            )
          : undefined);
    if (rejection) {
      const rejected = Promise.reject(rejection);
      void rejected.catch((): void => undefined);
      return rejected;
    }
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.push({
        request: { id: ++this.nextId, method, args },
        resolve,
        reject,
      });
      this.pump();
    });
    // Some legacy notification callers deliberately fire and forget derived work.
    // Awaiting callers still receive rejection and cannot publish a successful fingerprint.
    void result.catch((): void => undefined);
    return result;
  }

  private receive(input: unknown): void {
    if (!isIndexWorkerResponse(input)) {
      this.fail(new Error('Malformed search index response'));
      return;
    }
    const message = input;
    if (
      message.kind === 'ready' &&
      typeof message.dbPath === 'string' &&
      !this.readyPath
    ) {
      this.readyPath = message.dbPath;
      this.captureTemporaryDirectory(message.dbPath);
      this.clearTimeout();
      this.resolveReady(message.dbPath);
      this.pump();
      return;
    }
    if (message.kind === 'fatal') {
      this.fail(new Error(String(message.error)));
      return;
    }
    if (
      message.kind !== 'result' ||
      message.id !== this.active?.request.id ||
      typeof message.ok !== 'boolean'
    ) {
      this.fail(new Error('Unexpected search index response'));
      return;
    }
    if (!message.ok) {
      this.fail(new Error(message.error));
      return;
    }
    const pending = this.active;
    this.active = undefined;
    this.clearTimeout();
    pending?.resolve(message.value);
    this.pump();
  }

  private pump(): void {
    if (!this.readyPath || this.failure || this.active) return;
    this.active = this.pending.shift();
    if (!this.active) return;
    this.armTimeout(this.active.request.method);
    try {
      this.worker.postMessage(this.active.request);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private armTimeout(phase: string): void {
    this.clearTimeout();
    this.timer = setTimeout(
      (): void =>
        this.fail(new Error(`Search index worker timed out (${phase})`)),
      30_000,
    );
    this.timer.unref();
  }
  private clearTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private captureTemporaryDirectory(dbPath: string): void {
    const directory = dirname(dbPath);
    if (
      basename(dbPath) === 'index.sqlite' &&
      basename(directory).startsWith('canopy-search-index-') &&
      resolve(dirname(directory)) === resolve(tmpdir())
    ) {
      this.temporaryDirectory = directory;
    }
  }
  private cleanupTemporaryDirectory(): Promise<void> {
    if (this.temporaryCleanup) return this.temporaryCleanup;
    const directory = this.temporaryDirectory;
    this.temporaryDirectory = undefined;
    if (!directory) return Promise.resolve();
    this.temporaryCleanup = rm(directory, {
      recursive: true,
      force: true,
    }).catch((): void => {
      // The worker owns only a disposable derived index. A host-level cleanup
      // failure must not replace the original worker failure or shutdown result.
    });
    return this.temporaryCleanup;
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.clearTimeout();
    this.rejectReady(error);
    this.active?.reject(error);
    this.active = undefined;
    for (const pending of this.pending.splice(0)) pending.reject(error);
    void this.worker.terminate().catch((): void => undefined);
    // eslint-disable-next-line no-console
    console.error('Search indexing stopped:', error.message);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.run('close'),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            (): void => reject(new Error('Search index shutdown timed out')),
            5000,
          );
        }),
      ]);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (deadline) clearTimeout(deadline);
      this.clearTimeout();
      if (!this.exited) {
        let terminationDeadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          this.worker.terminate().catch((): void => undefined),
          new Promise<void>((resolve) => {
            terminationDeadline = setTimeout(resolve, 1000);
          }),
        ]);
        if (terminationDeadline) clearTimeout(terminationDeadline);
      }
      await this.cleanupTemporaryDirectory();
    }
  }
}
