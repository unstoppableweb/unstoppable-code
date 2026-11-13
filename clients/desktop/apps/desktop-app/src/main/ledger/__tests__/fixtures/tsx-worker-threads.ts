import { once } from 'node:events';
import { join } from 'node:path';
import type * as WorkerThreads from 'node:worker_threads';

/*
 * `node:worker_threads` for tests that run the real Ledger storage worker.
 * Jest runs TypeScript sources, so the worker entry runs through tsx; the app
 * starts the bundled `ledger-storage-worker.js` instead. Use it as a module
 * mock factory:
 *
 *   jest.mock('node:worker_threads', () =>
 *     jest
 *       .requireActual<typeof TsxWorkerThreads>('./fixtures/tsx-worker-threads')
 *       .createTsxWorkerThreads(),
 *   );
 */

/**
 * tsx's CommonJS hooks. Under `--import tsx` a worker entry loads as an ES
 * module, and tsx's ES module resolver cannot load workspace subpaths such as
 * `@canopy/desktop-shared/node/ledger` that name a directory.
 */
export const TSX_EXEC_ARGV: readonly string[] = ['--require', 'tsx/cjs'];

/** A worker a test started, with its exit code once it has exited. */
export interface StartedWorker {
  readonly filename: string | URL;
  readonly workerData: unknown;
  readonly exited: Promise<void>;
  /** Arms an entry-INSERT barrier and resolves once the worker reaches it. */
  pauseNextEntryInsert(): Promise<void>;
  exitCode: number | undefined;
  workersStartedAtExit: number | undefined;
  termination: { active: boolean; sqliteCall: number | undefined } | undefined;
}

/** Every worker started in this test file, in start order. */
export const startedWorkers: StartedWorker[] = [];

export function createTsxWorkerThreads({
  observeSqliteCalls = false,
}: { observeSqliteCalls?: boolean } = {}): typeof WorkerThreads {
  const actual = jest.requireActual<typeof WorkerThreads>(
    'node:worker_threads',
  );
  class TsxWorker extends actual.Worker {
    private readonly started: StartedWorker;
    private readonly sqliteCallState: Int32Array | undefined;

    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      const [filename, options] = args;
      const sqliteCallState = observeSqliteCalls
        ? new Int32Array(
            new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT),
          )
        : undefined;
      const pauseChannel = observeSqliteCalls
        ? new actual.MessageChannel()
        : undefined;
      const data: unknown = options?.workerData;
      super(filename, {
        ...options,
        workerData: sqliteCallState
          ? {
              ...(typeof data === 'object' && data !== null ? data : {}),
              sqliteCallState,
              sqlitePausePort: pauseChannel?.port2,
            }
          : data,
        ...(pauseChannel
          ? {
              transferList: [
                ...(options?.transferList ?? []),
                pauseChannel.port2,
              ],
            }
          : {}),
        execArgv: [
          ...TSX_EXEC_ARGV,
          ...(sqliteCallState
            ? ['--require', join(__dirname, 'observe-sqlite-call.ts')]
            : []),
        ],
      });
      let markExited = (): void => undefined;
      const exited = new Promise<void>((resolve) => {
        markExited = resolve;
      });
      const started: StartedWorker = {
        filename,
        workerData: options?.workerData,
        exited,
        async pauseNextEntryInsert(): Promise<void> {
          if (!sqliteCallState || !pauseChannel) {
            throw new Error('SQLite observation is disabled');
          }
          const reached = once(pauseChannel.port1, 'message');
          Atomics.store(sqliteCallState, 1, 1);
          await Promise.race([
            reached,
            exited.then(() => {
              throw new Error(
                'Storage worker exited before its entry INSERT barrier',
              );
            }),
          ]);
        },
        exitCode: undefined,
        workersStartedAtExit: undefined,
        termination: undefined,
      };
      this.started = started;
      this.sqliteCallState = sqliteCallState;
      this.once('exit', (exitCode: number): void => {
        started.exitCode = exitCode;
        started.workersStartedAtExit = startedWorkers.length;
        pauseChannel?.port1.close();
        markExited();
      });
      startedWorkers.push(started);
    }

    override terminate(): Promise<number> {
      this.started.termination = {
        active: this.threadId !== -1,
        sqliteCall: this.sqliteCallState
          ? Atomics.load(this.sqliteCallState, 0)
          : undefined,
      };
      return super.terminate();
    }
  }
  return { ...actual, Worker: TsxWorker };
}
