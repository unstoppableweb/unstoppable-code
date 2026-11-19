import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pruneDamagedCopiesSync } from '../../damaged-copies';
import { createDurableAtomicInstall } from './atomic-install';
import type {
  PipelineDefinitionStoreEnvironment,
  StoredPipelineLock,
} from './definitions-store';

/** The module the daemon's definitions writes claim for admission. */
export const DAEMON_PIPELINE_DEFINITION_STORE_MODULE =
  'packages/core-runtime/src/node/pipeline/store/definitions-store.ts';

export interface DaemonPipelineDefinitionStoreEnvironmentOptions {
  /** The data root the daemon checked at startup. */
  readonly dataRoot: string;
  /** The packaged daemon's bundled definitions folder. */
  readonly bundledPipelinesDir: string;
  /** core-platform's owner lock, the one Electron main and the CLI take. */
  readonly lock: StoredPipelineLock;
  /** core-platform's directory flush. */
  readonly flushDirectorySync: (directory: string) => void;
}

/**
 * The definitions store's environment over the daemon's own data root
 * (CAN-5092): the same layout and lock file as Electron main's, its own
 * durable install, and the daemon as the default writer. Dormant: nothing
 * in production builds a store over it.
 */
export function createDaemonPipelineDefinitionStoreEnvironment(
  options: DaemonPipelineDefinitionStoreEnvironmentOptions,
): PipelineDefinitionStoreEnvironment {
  const userDir = (): string => join(options.dataRoot, 'pipelines');
  const install = createDurableAtomicInstall(options.flushDirectorySync);
  return {
    userPipelinesDir: userDir,
    userPipelineIndexPath: () => join(userDir(), 'index.json'),
    bundledPipelinesDir: () => options.bundledPipelinesDir,
    withWriterLock: (operation, lockOptions) => {
      const directory = join(options.dataRoot, 'locks', 'pipeline-definitions');
      options.lock.ensurePrivateLockDirectorySync(directory);
      return options.lock.withOwnerLockFileSync(
        join(directory, 'writer.lock'),
        operation,
        lockOptions,
      );
    },
    installUserFile: (fileName, data, claim) => {
      install(join(userDir(), fileName), data, claim);
    },
    removeUserFile: (fileName) => {
      unlinkSync(join(userDir(), fileName));
    },
    flushUserDirectory: () => {
      options.flushDirectorySync(userDir());
    },
    ensureUserDirectory: () => {
      try {
        mkdirSync(userDir(), { recursive: true });
        return true;
      } catch {
        return false;
      }
    },
    pruneDamagedIndexCopies: () => {
      pruneDamagedCopiesSync(join(userDir(), 'index.json'));
    },
    defaultWriter: () => 'daemon',
    writerModule: DAEMON_PIPELINE_DEFINITION_STORE_MODULE,
  };
}
