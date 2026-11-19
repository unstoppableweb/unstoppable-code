import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StorageOwnershipRow } from '../../../storage';
import { createDurableAtomicInstall } from './atomic-install';
import type { PipelineLocalMetadataEnvironment } from './local-metadata';

/** The module the daemon's local metadata writes claim for admission. */
export const DAEMON_PIPELINE_LOCAL_METADATA_MODULE =
  'packages/core-runtime/src/node/pipeline/store/daemon-local-metadata.ts';

/** Where a data root keeps the pipeline local metadata file. */
export function pipelineLocalMetadataPath(dataRoot: string): string {
  return join(dataRoot, 'pipeline-local-metadata.json');
}

export interface DaemonPipelineLocalMetadataEnvironmentOptions {
  /** The data root the daemon checked at startup. */
  readonly dataRoot: string;
  /** core-platform's directory flush. */
  readonly flushDirectorySync: (directory: string) => void;
  /** Trusted composition only; defaults to the compiled ownership rows. */
  readonly ownership?: readonly StorageOwnershipRow[];
}

/**
 * The pipeline local metadata file over the daemon's own data root
 * (CAN-7057): Electron main's layout and mode, and the daemon's own
 * durable install, whose claim the rows must admit before anything is
 * written. Dormant: nothing in production builds a store over it.
 */
export function createDaemonPipelineLocalMetadataEnvironment(
  options: DaemonPipelineLocalMetadataEnvironmentOptions,
): PipelineLocalMetadataEnvironment {
  const filePath = (): string => pipelineLocalMetadataPath(options.dataRoot);
  const install = createDurableAtomicInstall(options.flushDirectorySync);
  return {
    location: filePath,
    stat: () => statSync(filePath()),
    readText: () => readFileSync(filePath(), 'utf8'),
    install: (data) => {
      mkdirSync(dirname(filePath()), { recursive: true });
      install(
        filePath(),
        data,
        {
          namespace: 'pipeline_local_metadata',
          writer: 'daemon',
          module: DAEMON_PIPELINE_LOCAL_METADATA_MODULE,
          ...(options.ownership && { ownership: options.ownership }),
        },
        0o600,
      );
    },
    warn: (message) => {
      process.stderr.write(`[pipeline-local-metadata] ${message}\n`);
    },
  };
}
