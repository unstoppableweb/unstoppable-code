import { dirname, join, resolve } from 'node:path';
import type * as WorkerThreads from 'node:worker_threads';
import { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';

/*
 * A real core-runtime W5 commit-log host for suites outside desktop main.
 * Jest runs TypeScript sources, so the worker entry runs through tsx: mock
 * `node:worker_threads` with `createTsxWorkerThreads()` before importing.
 */

export function createTsxWorkerThreads(): typeof WorkerThreads {
  const actual = jest.requireActual<typeof WorkerThreads>(
    'node:worker_threads',
  );
  class TsxWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      const [filename, options] = args;
      // tsx's CommonJS hooks resolve workspace subpaths that name a directory.
      super(filename, { ...options, execArgv: ['--require', 'tsx/cjs'] });
    }
  }
  return { ...actual, Worker: TsxWorker };
}

/** A host over `root`, whose log sits in `logDirectory`. */
export function startW5TestCommitLogHost(options: {
  readonly root: string;
  readonly logDirectory: string;
}): W5CommitLogHost {
  const repositoryRoot = resolve(__dirname, '../../../../../../..');
  // Match the native CI addon override and build-owned-child.mjs default output.
  const confinementAddon =
    process.platform === 'win32'
      ? resolve(
          repositoryRoot,
          process.env.CANOPY_OWNED_CHILD_ADDON ||
            `.cache/native-owned-child/win32-${process.arch}/core-owned-child.node`,
        )
      : undefined;
  return new W5CommitLogHost({
    dbPath: join(options.logDirectory, 'commit-log.sqlite'),
    root: options.root,
    dataRoot: dirname(options.root),
    workerEntry: join(__dirname, 'w5-commit-log-test-worker.ts'),
    confinementAddon,
  });
}
