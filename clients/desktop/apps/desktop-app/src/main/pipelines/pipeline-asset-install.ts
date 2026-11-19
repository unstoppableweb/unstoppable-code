import { mkdir, readFile, rm } from 'node:fs/promises';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import * as path from 'node:path';
import type { PipelinePackageResource } from '@canopy/protocol/pipelines';
import {
  createPipelineAssetStore,
  type PipelineAssetEnvironment,
  type PipelineAssetInstallPlan,
  type PipelineAssetsManifestV1,
} from '@canopy/core-runtime/node/pipeline/store';
import type { AutomationPipelineAssetChanges } from '@canopy/desktop-shared/types';
import {
  getPipelineAssetsDir,
  getPipelineAssetsManifestPath,
} from '../lib/paths';
import { renameWithRetry } from '../lib/atomic-file';
import { writeStoreFileDurably } from '../lib/durable-store-write';
import { logMainProcessWarn } from '../lib/main-process-logging';

/**
 * Installs an automation package's `file_asset` resources into the data dir
 * of the local pipeline that declared them, and records what it wrote in
 * `assets.json`. The package cache keeps the reviewed, immutable copy; the
 * asset dir is the recipient's working copy. Electron-main compatibility path
 * for `core.initiatedWork` installs, over the portable asset store
 * (CAN-7058).
 */

export type {
  PipelineAssetFileWrite,
  PipelineAssetInstallPlan,
  PipelineAssetsManifestV1,
} from '@canopy/core-runtime/node/pipeline/store';

/** Electron main's asset files under its data root, installed durably. */
export const pipelineAssetEnvironment: PipelineAssetEnvironment = {
  assetsDir: getPipelineAssetsDir,
  manifestPath: getPipelineAssetsManifestPath,
  createAssetFolder: async (localPipelineId, relativeFolder) => {
    const assetsDir = getPipelineAssetsDir(localPipelineId);
    // Only the asset dir itself gets its parents; every other folder is
    // created alone, and an existing one fails with EEXIST.
    await mkdir(
      path.resolve(assetsDir, ...relativeFolder.split('/')),
      relativeFolder === '.' ? { recursive: true } : {},
    );
  },
  writeAssetFile: async (localPipelineId, relativePath, bytes, mode) => {
    const destination = path.resolve(
      getPipelineAssetsDir(localPipelineId),
      ...relativePath.split('/'),
    );
    await writeStoreFileDurably(
      destination,
      bytes,
      mode === undefined ? {} : { mode },
    );
  },
  moveAssetFile: async (localPipelineId, fromRelativePath, toRelativePath) => {
    const assetsDir = getPipelineAssetsDir(localPipelineId);
    const destination = path.resolve(assetsDir, ...toRelativePath.split('/'));
    await renameWithRetry(
      path.resolve(assetsDir, ...fromRelativePath.split('/')),
      destination,
    );
    try {
      await flushDirectory(path.dirname(destination));
    } catch (error) {
      logMainProcessWarn(
        '[storage] Pipeline asset installed, but its folder flush failed',
        error,
      );
    }
  },
  removeAssetFolder: async (localPipelineId, relativeFolder) => {
    await rm(
      path.resolve(
        getPipelineAssetsDir(localPipelineId),
        ...relativeFolder.split('/'),
      ),
      { recursive: true, force: true },
    );
  },
  writeManifest: async (localPipelineId, text) => {
    const manifestPath = getPipelineAssetsManifestPath(localPipelineId);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeStoreFileDurably(manifestPath, text);
  },
};

const store = createPipelineAssetStore(pipelineAssetEnvironment);

/** Reads a file from a verified package cache directory by its sha256. */
export function packageCacheBlobReader(
  packagePath: string,
): (sha256: string) => Promise<Uint8Array> {
  return (sha256) => readFile(path.join(packagePath, 'blobs', sha256));
}

/** The recorded install hashes, or an empty record when none are readable. */
export function readPipelineAssetsManifest(
  localPipelineId: string,
): Promise<PipelineAssetsManifestV1> {
  return store.readManifest(localPipelineId);
}

/**
 * What installing the package's `file_asset` resources into a local
 * pipeline would write, without writing. `seed` writes only files that are
 * missing; `replace` overwrites. `assets.json` then records the hash of
 * every file install wrote (for `seed`, a file left in place keeps the hash
 * an earlier install recorded, or its own when it already matches).
 */
export function planPipelineAssetInstall(input: {
  localPipelineId: string;
  /** The package's `file_asset` resources for this pipeline. */
  resources: readonly PipelinePackageResource[];
}): Promise<PipelineAssetInstallPlan> {
  return store.plan(input);
}

/**
 * Copy each `file_asset` resource from the cached package into
 * `getPipelineAssetsDir(localPipelineId)/<assetId>`, as
 * {@link planPipelineAssetInstall} plans, then write `assets.json`.
 * `beforeWrite` receives the plan before the first write, so an install can
 * keep what it replaces (CAN-5677).
 * Idempotent: a retry writes the same bytes and the same record.
 */
export function installPipelineAssets(input: {
  localPipelineId: string;
  /** The verified cache directory of the package. */
  packagePath: string;
  /** The package's `file_asset` resources for this pipeline. */
  resources: readonly PipelinePackageResource[];
  beforeWrite?: (plan: PipelineAssetInstallPlan) => Promise<void>;
}): Promise<PipelineAssetsManifestV1> {
  const { packagePath, ...rest } = input;
  return store.install({
    ...rest,
    readBlob: packageCacheBlobReader(packagePath),
  });
}

/**
 * What {@link installPipelineAssets} would do to the files already in a
 * local pipeline's asset dirs, without writing. A file counts as edited here
 * when it differs from the hash `assets.json` recorded for it, or when
 * install never recorded it. Files that already match the share are left
 * out.
 */
export function previewPipelineAssetChanges(input: {
  localPipelineId: string;
  resources: readonly PipelinePackageResource[];
}): Promise<AutomationPipelineAssetChanges[]> {
  return store.preview(input);
}
