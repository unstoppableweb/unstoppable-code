import { flushDirectorySync } from '@canopy/core-platform/directory-flush';
import {
  ensurePrivateLockDirectorySync,
  withOwnerLockFileSync,
} from '@canopy/core-platform/owner-lock-file';
import type { DaemonPipelineDefinitionSourcesLoader } from '@canopy/core-runtime/node/pipeline/daemon';
import {
  createPipelineDefinitionStore,
  createStoredPipelineDefinitionPort,
  createStoredPipelineDefinitionWriter,
} from '@canopy/core-runtime/node/pipeline/store';
import { createDaemonPipelineDefinitionStoreEnvironment } from '@canopy/core-runtime/node/pipeline/store/daemon';
import {
  STORAGE_OWNERSHIP,
  type StorageOwnershipRow,
} from '@canopy/core-runtime/storage';
import { daemonBundledPipelinesDir } from './execution-hosts';

/** What the daemon's definitions compose from: its rows and sources. */
export interface DaemonPipelineDefinitionComposition {
  readonly ownership: readonly StorageOwnershipRow[];
  readonly sources: DaemonPipelineDefinitionSourcesLoader;
}

/**
 * The production composition of `core.pipeline.definition.*` (CAN-7522): the
 * compiled ownership rows and the bundled and user sources over the daemon's
 * own data root. The compiled rows keep pipeline_definitions with Electron
 * main and the CLI, so the daemon composes nothing from it and never calls
 * its loader. Its writes claim the daemon under the compiled rows, never rows
 * a caller passes, so they commit only once a release's compiled rows hand
 * the daemon the definitions. The store is built on the first call.
 */
export function productionPipelineDefinitions(options: {
  /** The canonical data root the daemon checked at startup. */
  readonly dataRoot: string;
  /** The bundled definitions folder; the one staged beside the daemon by default. */
  readonly bundledPipelinesDir?: string;
}): DaemonPipelineDefinitionComposition {
  return {
    ownership: STORAGE_OWNERSHIP,
    sources: () => {
      const store = createPipelineDefinitionStore(
        createDaemonPipelineDefinitionStoreEnvironment({
          dataRoot: options.dataRoot,
          bundledPipelinesDir:
            options.bundledPipelinesDir ?? daemonBundledPipelinesDir(),
          lock: { ensurePrivateLockDirectorySync, withOwnerLockFileSync },
          flushDirectorySync,
        }),
      );
      return Promise.resolve({
        ports: [createStoredPipelineDefinitionPort(store)],
        writer: createStoredPipelineDefinitionWriter(store),
        dataRoot: options.dataRoot,
      });
    },
  };
}
