import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PIPELINE_ASSET_ID_PATTERN } from '@canopy/pipeline-interop/assets';
import {
  CAPABILITY_FILE_SHA256_PATTERN,
  isSafeCapabilityRelativePath,
} from '@canopy/protocol/capability-files';
import type {
  PipelineAssetInstallMode,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';

/** `<data>/pipeline-data/<id>/assets.json`. */
export interface PipelineAssetsManifestV1 {
  version: 1;
  assets: Record<
    string,
    {
      installMode: PipelineAssetInstallMode;
      /** sha256 of each file install wrote, by asset-relative path. */
      files: Record<string, string>;
    }
  >;
}

/** A file an install writes, under the asset dir. */
export interface PipelineAssetFileWrite {
  /** `<assetId>/<path>`, relative to the pipeline's asset dir. */
  path: string;
  sha256: string;
  executable: boolean;
}

/**
 * What an install is about to write into a local pipeline's asset dir,
 * worked out before its first write.
 */
export interface PipelineAssetInstallPlan {
  files: PipelineAssetFileWrite[];
  /**
   * Every folder it makes sure of, relative to the asset dir (`.` is the
   * asset dir itself), parents first.
   */
  directories: string[];
  /** The ones of {@link directories} that do not exist yet. */
  createdDirectories: string[];
  manifest: PipelineAssetsManifestV1;
  /** The `assets.json` it writes. */
  manifestText: string;
}

/** How installing changes the files one packaged asset put on this computer. */
export interface PipelineAssetChanges {
  assetId: string;
  installMode: PipelineAssetInstallMode;
  /** Missing here, so install writes them. Asset-relative paths. */
  added: string[];
  /** The share changed them and install overwrites them (`replace`). */
  updated: string[];
  /** Edited here since they were installed, and install overwrites them (`replace`). */
  overwritten: string[];
  /** Differ from the share and stay as they are here (`seed`). */
  kept: string[];
}

/**
 * Where a host keeps a local pipeline's assets and how it writes them. Each
 * write names the pipeline and an asset-relative path, so a host resolves
 * the location itself. An install stages every file in a fresh folder under
 * the asset dir, then moves each one into place.
 */
export interface PipelineAssetEnvironment {
  /** `<data>/pipeline-data/<id>/assets`, for reads. */
  readonly assetsDir: (localPipelineId: string) => string;
  /** `<data>/pipeline-data/<id>/assets.json`, for reads. */
  readonly manifestPath: (localPipelineId: string) => string;
  /**
   * Refuses, before anything is written, when this host may not write the
   * pipeline's assets. Electron main admits its writes at each install.
   */
  readonly assertWritable?: () => void;
  /**
   * Creates one folder under the asset dir, never its parents, and fails
   * with EEXIST when anything is already there. `.` is the asset dir, whose
   * own parents the host creates.
   */
  readonly createAssetFolder: (
    localPipelineId: string,
    relativeFolder: string,
  ) => Promise<void>;
  /** Installs one file atomically and durably, with `mode` when it must stay executable. */
  readonly writeAssetFile: (
    localPipelineId: string,
    relativePath: string,
    bytes: Uint8Array,
    mode: number | undefined,
  ) => Promise<void>;
  /** Renames a staged file over its destination, then flushes the destination folder. */
  readonly moveAssetFile: (
    localPipelineId: string,
    fromRelativePath: string,
    toRelativePath: string,
  ) => Promise<void>;
  /** Removes a staging folder and everything in it. */
  readonly removeAssetFolder: (
    localPipelineId: string,
    relativeFolder: string,
  ) => Promise<void>;
  /** Installs `assets.json`, creating its folder. */
  readonly writeManifest: (
    localPipelineId: string,
    text: string,
  ) => Promise<void>;
}

/** The pipeline asset store over a host's environment (CAN-7058). */
export interface PipelineAssetStore {
  /** The recorded install hashes, or an empty record when none are readable. */
  readonly readManifest: (
    localPipelineId: string,
  ) => Promise<PipelineAssetsManifestV1>;
  /**
   * What installing the package's `file_asset` resources would write,
   * without writing. `seed` writes only missing files; `replace` overwrites.
   */
  readonly plan: (input: {
    localPipelineId: string;
    resources: readonly PipelinePackageResource[];
  }) => Promise<PipelineAssetInstallPlan>;
  /**
   * Copies each `file_asset` resource from the cached package as
   * {@link plan} plans, then writes `assets.json`. A newer manifest and a
   * cached file that fails verification are refused. `beforeWrite` receives
   * the plan before the first write. Idempotent.
   */
  readonly install: (input: {
    localPipelineId: string;
    /**
     * The cached package's file with this sha256, from the host's package
     * cache. The store verifies every file it returns before writing.
     */
    readBlob: (sha256: string) => Promise<Uint8Array>;
    resources: readonly PipelinePackageResource[];
    beforeWrite?: (plan: PipelineAssetInstallPlan) => Promise<void>;
  }) => Promise<PipelineAssetsManifestV1>;
  /** What an install would do to the files already here, without writing. */
  readonly preview: (input: {
    localPipelineId: string;
    resources: readonly PipelinePackageResource[];
  }) => Promise<PipelineAssetChanges[]>;
}

const LINK_MESSAGE =
  "This workflow's supporting files include a link, so they can't be updated safely. Remove the link and install the automation again.";

const NEWER_MANIFEST_MESSAGE =
  'The supporting files of this workflow were saved by a newer version of the app. Update the app and try again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstallMode(value: unknown): value is PipelineAssetInstallMode {
  return value === 'seed' || value === 'replace';
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function parseAssetsManifest(value: unknown): PipelineAssetsManifestV1 {
  const empty: PipelineAssetsManifestV1 = { version: 1, assets: {} };
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.assets))
    return empty;
  const assets: PipelineAssetsManifestV1['assets'] = {};
  for (const [assetId, entry] of Object.entries(value.assets)) {
    if (!isRecord(entry) || !isInstallMode(entry.installMode)) continue;
    if (!isRecord(entry.files)) continue;
    const files: Record<string, string> = {};
    for (const [relativePath, sha256] of Object.entries(entry.files)) {
      if (typeof sha256 === 'string') files[relativePath] = sha256;
    }
    assets[assetId] = { installMode: entry.installMode, files };
  }
  return { version: 1, assets };
}

/** Whether something exists at `target`, without following a symlink. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function fileSha256(target: string): Promise<string | undefined> {
  try {
    const stats = await lstat(target);
    if (!stats.isFile()) return undefined;
    return createHash('sha256')
      .update(await readFile(target))
      .digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Refuses an install that would write through a link: the pipeline's data
 * folder, its asset dir, or any folder or file the install writes. Both
 * hosts write a temporary file beside the destination and rename it, so a
 * linked folder would place the file wherever the link points.
 */
async function refuseLinks(
  assetsRoot: string,
  relativePaths: readonly string[],
): Promise<void> {
  const targets = [
    path.dirname(assetsRoot),
    ...relativePaths.map((relativePath) =>
      relativePath === '.'
        ? assetsRoot
        : path.resolve(assetsRoot, ...relativePath.split('/')),
    ),
  ];
  for (const target of targets) {
    let isLink: boolean;
    try {
      isLink = (await lstat(target)).isSymbolicLink();
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    if (isLink) throw new Error(LINK_MESSAGE);
  }
}

/** A name as macOS and Windows compare it: case-folded and NFC-normalized. */
function filesystemKey(relativePath: string): string {
  return relativePath.normalize('NFC').toLowerCase().normalize('NFC');
}

/**
 * Refuses a package where two files, a file and a folder, or two spellings
 * of one folder would land on the same name on a case-insensitive or
 * normalizing filesystem, so a later file can't overwrite an earlier one and
 * the package installs the same way on every system.
 */
function refuseCollisions(
  filePaths: readonly string[],
  folderPaths: readonly string[],
): void {
  const seen = new Map<string, string>();
  for (const name of filePaths) {
    const key = filesystemKey(name);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      throw new Error(
        `The automation package has two files with the same name (${earlier} and ${name}).`,
      );
    }
    seen.set(key, name);
  }
  const folders = new Map<string, string>();
  for (const folder of folderPaths) {
    const key = filesystemKey(folder);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      throw new Error(
        `The automation package has a file and a folder with the same name (${earlier}).`,
      );
    }
    // Two spellings of one folder would be two folders on some systems and
    // one on others, so the package couldn't install the same way everywhere.
    const spelled = folders.get(key);
    if (spelled !== undefined && spelled !== folder) {
      throw new Error(
        `The automation package has two folders with the same name (${spelled} and ${folder}).`,
      );
    }
    folders.set(key, folder);
  }
}

/** Refuses unless `target` is a real folder, not a link or a file. */
async function assertRealFolder(target: string): Promise<void> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error(LINK_MESSAGE);
}

/**
 * Creates one folder unless it is already there, then refuses unless it is a
 * real folder.
 */
async function createFolderIfMissing(
  environment: PipelineAssetEnvironment,
  localPipelineId: string,
  relativeFolder: string,
  target: string,
): Promise<void> {
  try {
    await environment.createAssetFolder(localPipelineId, relativeFolder);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  await assertRealFolder(target);
}

/** The validated asset id of a `file_asset` resource. */
function fileAssetId(resource: PipelinePackageResource): string {
  const assetId = resource.assetId;
  if (
    resource.kind !== 'file_asset' ||
    assetId === undefined ||
    !PIPELINE_ASSET_ID_PATTERN.test(assetId)
  ) {
    throw new Error('The automation package has an invalid file resource.');
  }
  return assetId;
}

/** Where a packaged asset file goes under its asset dir; refuses escapes. */
function assetFileDestination(assetRoot: string, entryPath: string): string {
  if (!isSafeCapabilityRelativePath(entryPath)) {
    throw new Error('The automation package has an unsafe file path.');
  }
  const destination = path.resolve(assetRoot, ...entryPath.split('/'));
  const relative = path.relative(assetRoot, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `The automation package has an unsafe file path (${entryPath}).`,
    );
  }
  return destination;
}

/** The folder chain from the asset dir down to `relativeDir`, parents first. */
function folderChain(relativeDir: string): string[] {
  const chain = ['.'];
  if (relativeDir === '.') return chain;
  const segments = relativeDir.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    chain.push(segments.slice(0, index).join('/'));
  }
  return chain;
}

/**
 * The pipeline asset store's read, plan, install and preview policy over a
 * host's environment (CAN-7058). The package cache keeps the reviewed,
 * immutable copy; the asset dir is the recipient's working copy.
 */
export function createPipelineAssetStore(
  environment: PipelineAssetEnvironment,
): PipelineAssetStore {
  const readManifest = async (
    localPipelineId: string,
  ): Promise<PipelineAssetsManifestV1> => {
    try {
      const raw = await readFile(
        environment.manifestPath(localPipelineId),
        'utf8',
      );
      const value: unknown = JSON.parse(raw);
      return parseAssetsManifest(value);
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || error instanceof SyntaxError)
        return { version: 1, assets: {} };
      throw error;
    }
  };

  const plan: PipelineAssetStore['plan'] = async (input) => {
    const assetsRoot = environment.assetsDir(input.localPipelineId);
    const previous = await readManifest(input.localPipelineId);
    const manifest: PipelineAssetsManifestV1 = {
      version: 1,
      assets: { ...previous.assets },
    };
    const files: PipelineAssetFileWrite[] = [];
    const folders = new Set<string>();
    const packageFiles: string[] = [];
    const packageFolders = new Set<string>();
    for (const resource of input.resources) {
      const assetId = fileAssetId(resource);
      const installMode = resource.installMode ?? 'seed';
      const assetRoot = path.join(assetsRoot, assetId);
      const previousFiles = previous.assets[assetId]?.files ?? {};
      const assetFiles: Record<string, string> = {};
      // An asset with no files (empty, or every file withheld) still installs
      // its folder, so runs resolve it here instead of the author's path.
      folderChain(assetId).forEach((folder) => folders.add(folder));
      for (const tree of resource.trees) {
        for (const entry of tree.entries) {
          const destination = assetFileDestination(assetRoot, entry.path);
          packageFiles.push(`${assetId}/${entry.path}`);
          folderChain(path.posix.dirname(`${assetId}/${entry.path}`)).forEach(
            (folder) => packageFolders.add(folder),
          );
          if (installMode === 'seed' && (await pathExists(destination))) {
            const kept =
              previousFiles[entry.path] ??
              ((await fileSha256(destination)) === entry.sha256
                ? entry.sha256
                : undefined);
            if (kept !== undefined) assetFiles[entry.path] = kept;
            continue;
          }
          const relativePath = `${assetId}/${entry.path}`;
          folderChain(path.posix.dirname(relativePath)).forEach((folder) =>
            folders.add(folder),
          );
          files.push({
            path: relativePath,
            sha256: entry.sha256,
            executable: entry.mode === 'execute',
          });
          assetFiles[entry.path] = entry.sha256;
        }
      }
      manifest.assets[assetId] = { installMode, files: assetFiles };
    }
    refuseCollisions(packageFiles, Array.from(packageFolders));
    const directories = Array.from(folders);
    await refuseLinks(assetsRoot, [
      ...directories,
      ...files.map((file) => file.path),
    ]);
    const createdDirectories: string[] = [];
    for (const folder of directories) {
      if (!(await pathExists(path.resolve(assetsRoot, folder))))
        createdDirectories.push(folder);
    }
    return {
      files,
      directories,
      createdDirectories,
      manifest,
      manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
    };
  };

  const install: PipelineAssetStore['install'] = async (input) => {
    environment.assertWritable?.();
    const installPlan = await plan(input);
    try {
      const raw: unknown = JSON.parse(
        await readFile(environment.manifestPath(input.localPipelineId), 'utf8'),
      );
      if (
        isRecord(raw) &&
        typeof raw.version === 'number' &&
        Number.isFinite(raw.version) &&
        raw.version > 1
      ) {
        throw new Error(NEWER_MANIFEST_MESSAGE);
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError))
        throw error;
    }
    // Every cached file is verified before the first write, so a tampered
    // file leaves nothing behind. The package caps total bytes at 32 MiB.
    const verified: { file: PipelineAssetFileWrite; bytes: Uint8Array }[] = [];
    for (const file of installPlan.files) {
      const bytes = CAPABILITY_FILE_SHA256_PATTERN.test(file.sha256)
        ? await input.readBlob(file.sha256)
        : undefined;
      if (
        bytes === undefined ||
        createHash('sha256').update(bytes).digest('hex') !== file.sha256
      ) {
        throw new Error(
          `The cached package file ${file.path} failed verification. Install the automation again.`,
        );
      }
      verified.push({ file, bytes });
    }
    await input.beforeWrite?.(installPlan);
    const id = input.localPipelineId;
    const assetsRoot = environment.assetsDir(id);
    const at = (relative: string): string =>
      relative === '.'
        ? assetsRoot
        : path.resolve(assetsRoot, ...relative.split('/'));
    // The asset dir and the folder above it must be real folders.
    const pipelineFolder = path.dirname(assetsRoot);
    if (await pathExists(pipelineFolder))
      await assertRealFolder(pipelineFolder);
    await createFolderIfMissing(environment, id, '.', at('.'));
    await assertRealFolder(pipelineFolder);
    // Every destination folder exists, created one at a time, and is a real
    // folder before anything is staged.
    for (const folder of installPlan.directories) {
      if (folder === '.') continue;
      await createFolderIfMissing(environment, id, folder, at(folder));
    }
    // Each file is staged in a fresh folder inside its own destination
    // folder, then renamed beside it. The staged copy and its destination
    // share every folder above them, so a folder swapped for a link after
    // staging takes the staged copy with it, and the rename fails instead of
    // writing through the link.
    const token = `.install-${randomUUID()}`;
    const stagingOf = (folder: string): string =>
      folder === '.' ? token : `${folder}/${token}`;
    const stagedPathOf = (relativePath: string): string =>
      `${stagingOf(path.posix.dirname(relativePath))}/${path.posix.basename(relativePath)}`;
    const fileFolders = Array.from(
      new Set(verified.map(({ file }) => path.posix.dirname(file.path))),
    );
    const staged: string[] = [];
    try {
      for (const folder of fileFolders) {
        await environment.createAssetFolder(id, stagingOf(folder));
        staged.push(stagingOf(folder));
        await assertRealFolder(at(folder));
        await assertRealFolder(at(stagingOf(folder)));
      }
      for (const { file, bytes } of verified) {
        // A script the analyzer accepted as executable stays runnable.
        await environment.writeAssetFile(
          id,
          stagedPathOf(file.path),
          bytes,
          file.executable ? 0o755 : undefined,
        );
      }
      // Nothing moves until every destination checks out again.
      for (const folder of installPlan.directories)
        await assertRealFolder(at(folder));
      for (const { file } of verified) {
        let stats;
        try {
          stats = await lstat(at(file.path));
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue;
          throw error;
        }
        if (!stats.isFile()) throw new Error(LINK_MESSAGE);
      }
      for (const { file } of verified) {
        await environment.moveAssetFile(id, stagedPathOf(file.path), file.path);
      }
    } finally {
      for (const folder of staged)
        await environment.removeAssetFolder(id, folder);
    }
    await environment.writeManifest(
      input.localPipelineId,
      installPlan.manifestText,
    );
    return installPlan.manifest;
  };

  const preview: PipelineAssetStore['preview'] = async (input) => {
    const assetsRoot = environment.assetsDir(input.localPipelineId);
    const previous = await readManifest(input.localPipelineId);
    const changes: PipelineAssetChanges[] = [];
    for (const resource of input.resources) {
      const assetId = fileAssetId(resource);
      const installMode = resource.installMode ?? 'seed';
      const assetRoot = path.join(assetsRoot, assetId);
      const recordedFiles = previous.assets[assetId]?.files ?? {};
      const change: PipelineAssetChanges = {
        assetId,
        installMode,
        added: [],
        updated: [],
        overwritten: [],
        kept: [],
      };
      for (const tree of resource.trees) {
        for (const entry of tree.entries) {
          const current = await fileSha256(
            assetFileDestination(assetRoot, entry.path),
          );
          if (current === undefined) {
            change.added.push(entry.path);
          } else if (current === entry.sha256) {
            continue;
          } else if (installMode === 'seed') {
            change.kept.push(entry.path);
          } else if (current === recordedFiles[entry.path]) {
            change.updated.push(entry.path);
          } else {
            change.overwritten.push(entry.path);
          }
        }
      }
      changes.push(change);
    }
    return changes;
  };

  return { readManifest, plan, install, preview };
}
