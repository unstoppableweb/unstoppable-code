import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  STORAGE_OWNERSHIP,
  StorageOutcomeUnknownError,
  assertAdmittedWriter,
  assertStorageWriteAllowed,
  type StorageOwnershipRow,
} from '../../../storage';
import { validateId } from '../../identifiers';
import { createDurableAtomicInstall, renameWithRetry } from './atomic-install';
import type { PipelineAssetEnvironment } from './assets';

/** The module the daemon's pipeline asset writes claim for admission. */
export const DAEMON_PIPELINE_ASSETS_MODULE =
  'packages/core-runtime/src/node/pipeline/store/daemon-assets.ts';

/** `<dataRoot>/pipeline-data/<id>/assets`, as Electron main lays it out. */
export function pipelineAssetsDir(dataRoot: string, id: string): string {
  validateId(id, 'pipeline data id');
  return join(dataRoot, 'pipeline-data', id, 'assets');
}

/** `<dataRoot>/pipeline-data/<id>/assets.json`. */
export function pipelineAssetsManifestPath(
  dataRoot: string,
  id: string,
): string {
  validateId(id, 'pipeline data id');
  return join(dataRoot, 'pipeline-data', id, 'assets.json');
}

export interface DaemonPipelineAssetEnvironmentOptions {
  /** The data root the daemon checked at startup. */
  readonly dataRoot: string;
  /** core-platform's directory flush. */
  readonly flushDirectorySync: (directory: string) => void;
  /** Trusted composition only; defaults to the compiled ownership rows. */
  readonly ownership?: readonly StorageOwnershipRow[];
}

/**
 * Pipeline assets over the daemon's own data root (CAN-7058): Electron
 * main's layout and modes, installed through the daemon's own durable
 * install. Every install is refused before anything is written unless both
 * `pipeline_definitions` and `pipeline_data` name the daemon, and each file
 * install admits its claim first. Dormant: nothing in production builds a
 * store over it.
 */
export function createDaemonPipelineAssetEnvironment(
  options: DaemonPipelineAssetEnvironmentOptions,
): PipelineAssetEnvironment {
  const ownership = options.ownership ?? STORAGE_OWNERSHIP;
  const install = createDurableAtomicInstall(options.flushDirectorySync);
  const claim = {
    namespace: 'pipeline_data' as const,
    writer: 'daemon' as const,
    module: DAEMON_PIPELINE_ASSETS_MODULE,
    ...(options.ownership && { ownership: options.ownership }),
  };
  const admit = (): void => {
    assertAdmittedWriter(
      claim.namespace,
      claim.writer,
      claim.module,
      ownership,
    );
  };
  const assetsDir = (id: string): string =>
    pipelineAssetsDir(options.dataRoot, id);
  return {
    assetsDir,
    manifestPath: (id) => pipelineAssetsManifestPath(options.dataRoot, id),
    assertWritable: () => {
      assertStorageWriteAllowed('pipeline_definitions', 'daemon', ownership);
      assertStorageWriteAllowed('pipeline_data', 'daemon', ownership);
    },
    createAssetFolder: (id, relativeFolder) => {
      admit();
      // Only the asset dir itself gets its parents; every other folder is
      // created alone, and an existing one fails with EEXIST.
      mkdirSync(
        resolve(assetsDir(id), ...relativeFolder.split('/')),
        relativeFolder === '.' ? { recursive: true } : {},
      );
      return Promise.resolve();
    },
    writeAssetFile: (id, relativePath, bytes, mode) => {
      install(
        resolve(assetsDir(id), ...relativePath.split('/')),
        bytes,
        claim,
        mode,
      );
      return Promise.resolve();
    },
    moveAssetFile: (id, fromRelativePath, toRelativePath) => {
      admit();
      const destination = resolve(assetsDir(id), ...toRelativePath.split('/'));
      renameWithRetry(
        resolve(assetsDir(id), ...fromRelativePath.split('/')),
        destination,
      );
      try {
        options.flushDirectorySync(dirname(destination));
      } catch (error) {
        throw new StorageOutcomeUnknownError('directory_flush', error);
      }
      return Promise.resolve();
    },
    removeAssetFolder: (id, relativeFolder) => {
      admit();
      rmSync(resolve(assetsDir(id), ...relativeFolder.split('/')), {
        recursive: true,
        force: true,
      });
      return Promise.resolve();
    },
    writeManifest: (id, text) => {
      const manifestPath = pipelineAssetsManifestPath(options.dataRoot, id);
      mkdirSync(dirname(manifestPath), { recursive: true });
      install(manifestPath, text, claim);
      return Promise.resolve();
    },
  };
}
