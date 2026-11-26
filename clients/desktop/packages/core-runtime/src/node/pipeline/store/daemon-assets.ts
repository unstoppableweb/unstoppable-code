import { mkdirSync, rmSync } from 'node:fs';
import { lstat, mkdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  STORAGE_OWNERSHIP,
  StorageOutcomeUnknownError,
  assertAdmittedWriter,
  assertStorageWriteAllowed,
  isStorageOutcomeUnknownError,
  type StorageOwnershipRow,
} from '../../../storage';
import { pruneDamagedCopies } from '../../damaged-copies';
import { assertRowWritable } from '../../storage-records';
import { validateId } from '../../identifiers';
import {
  createDurableAtomicInstall,
  renameWithRetry,
  type DurableInstallClaim,
} from './atomic-install';
import type { PipelineAssetEnvironment } from './assets';
import type {
  PipelineInstallJournalEnvironment,
  PipelineInstallJournalRecord,
} from './install-journal';

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

/** Why the daemon refused an install journal write (CAN-7058). */
export type DaemonInstallJournalRefusal =
  | 'outside_root'
  | 'dotdot_segment'
  | 'root_target'
  | 'cross_root_rename'
  | 'link_on_path'
  | 'unsafe_id';

/** A refused daemon install journal write; it never names a path. */
export class DaemonInstallJournalWriteRefusedError extends Error {
  readonly reason: DaemonInstallJournalRefusal;

  constructor(reason: DaemonInstallJournalRefusal) {
    super(`Refused a pipeline install journal write (${reason})`);
    this.name = 'DaemonInstallJournalWriteRefusedError';
    this.reason = reason;
  }
}

/** The journal's two stores, each under its own folder of the data root. */
type JournalNamespace = 'pipeline_install_intents' | 'pipeline_data';

interface JournalRoot {
  readonly namespace: JournalNamespace;
  readonly folder: string;
}

/** The ids the definitions store accepts; one plain folder name. */
const STORED_PIPELINE_ID = /^[A-Za-z0-9_-]+$/;

export interface DaemonPipelineInstallJournalEnvironmentOptions<TReceipt> {
  /** The data root the daemon checked at startup. */
  readonly dataRoot: string;
  /** core-platform's directory flush. */
  readonly flushDirectorySync: (directory: string) => void;
  /** Trusted composition only; defaults to the compiled ownership rows. */
  readonly ownership?: readonly StorageOwnershipRow[];
  /** The daemon's definitions store, written under its own writer. */
  readonly definitions: PipelineInstallJournalEnvironment<
    TReceipt,
    PipelineInstallJournalRecord
  >['definitions'];
  readonly pipelineService: PipelineInstallJournalEnvironment<
    TReceipt,
    PipelineInstallJournalRecord
  >['pipelineService'];
  readonly deleteUserPipelineLocalMetadata: (definitionId: string) => void;
  readonly isInstallReceipt: (value: unknown) => value is TReceipt;
  readonly warn: (message: string, context?: unknown) => void;
}

/**
 * The install journal's environment over the daemon's own data root
 * (CAN-7058). Nothing is written unless `pipeline_definitions`,
 * `pipeline_data` and `pipeline_install_intents` all name the daemon, and
 * every write admits its claim first. Each path must sit inside
 * `pipeline-install-intents/` or `pipeline-data/`, a whole store folder is
 * never removed or renamed, a rename stays within one store, and no folder
 * on the way to a removal, rename or write may be a link. It has no install
 * records, receipts or shared-item ledger, so the journal leaves records
 * that need them for Electron main. Dormant: nothing in production builds a
 * journal over it.
 */
export function createDaemonPipelineInstallJournalEnvironment<TReceipt>(
  options: DaemonPipelineInstallJournalEnvironmentOptions<TReceipt>,
): PipelineInstallJournalEnvironment<TReceipt, PipelineInstallJournalRecord> {
  const ownership = options.ownership ?? STORAGE_OWNERSHIP;
  const install = createDurableAtomicInstall(options.flushDirectorySync);
  const dataRoot = resolve(options.dataRoot);
  const intentsRoot: JournalRoot = {
    namespace: 'pipeline_install_intents',
    folder: join(dataRoot, 'pipeline-install-intents'),
  };
  const dataStoreRoot: JournalRoot = {
    namespace: 'pipeline_data',
    folder: join(dataRoot, 'pipeline-data'),
  };
  const roots = [intentsRoot, dataStoreRoot];
  const refuse = (reason: DaemonInstallJournalRefusal): never => {
    throw new DaemonInstallJournalWriteRefusedError(reason);
  };
  const claim = (namespace: JournalNamespace): DurableInstallClaim => ({
    namespace,
    writer: 'daemon' as const,
    module: DAEMON_PIPELINE_ASSETS_MODULE,
    ...(options.ownership && { ownership: options.ownership }),
  });
  const admit = (namespace: JournalNamespace): void => {
    assertAdmittedWriter(
      namespace,
      'daemon',
      DAEMON_PIPELINE_ASSETS_MODULE,
      ownership,
    );
  };
  /** The store a path belongs to; refuses any other path. */
  const rootOf = (target: string): JournalRoot => {
    if (target.split(/[\\/]+/).includes('..')) refuse('dotdot_segment');
    if (!isAbsolute(target)) refuse('outside_root');
    const resolved = resolve(target);
    const root = roots.find(
      ({ folder }) => resolved === folder || resolved.startsWith(folder + sep),
    );
    return root ?? refuse('outside_root');
  };
  /** Like `rootOf`, for a path that must be inside its store, not the store. */
  const entryOf = (target: string): JournalRoot => {
    const root = rootOf(target);
    if (resolve(target) === root.folder) refuse('root_target');
    return root;
  };
  /**
   * The store folder and every folder down to `folder` must be real folders,
   * and `folder` must still resolve inside the store, so nothing reaches
   * outside through a link. A missing folder holds nothing to follow.
   */
  const assertRealFolders = async (
    root: JournalRoot,
    folder: string,
  ): Promise<void> => {
    let current = root.folder;
    let deepest: string | undefined;
    const segments = relative(root.folder, resolve(folder))
      .split(sep)
      .filter(Boolean);
    for (const segment of ['', ...segments]) {
      if (segment) current = join(current, segment);
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (
          error !== null &&
          typeof error === 'object' &&
          Reflect.get(error, 'code') === 'ENOENT'
        )
          break;
        throw error;
      }
      if (stats.isSymbolicLink() || !stats.isDirectory())
        refuse('link_on_path');
      deepest = current;
    }
    // The deepest folder that exists must still resolve inside the store.
    if (deepest === undefined) return;
    const [realRoot, realFolder] = await Promise.all([
      realpath(root.folder),
      realpath(deepest),
    ]);
    if (realFolder !== realRoot && !realFolder.startsWith(realRoot + sep))
      refuse('link_on_path');
  };
  /** Admits a write of `target` inside its store, through real folders. */
  const admitEntry = async (target: string): Promise<JournalNamespace> => {
    const root = entryOf(target);
    await assertRealFolders(root, dirname(resolve(target)));
    admit(root.namespace);
    return root.namespace;
  };
  const assetsDir = (definitionId: string): string => {
    if (!STORED_PIPELINE_ID.test(definitionId)) refuse('unsafe_id');
    return join(dataStoreRoot.folder, definitionId, 'assets');
  };
  const removals = new Map<string, 'undone' | 'deleted'>();
  return {
    getPipelineInstallIntentsDir: () => intentsRoot.folder,
    getDataDir: () => dataRoot,
    getPipelineAssetsDir: assetsDir,
    getPipelineAssetsManifestPath: (definitionId) =>
      join(dirname(assetsDir(definitionId)), 'assets.json'),
    assertWritable: () => {
      assertStorageWriteAllowed('pipeline_definitions', 'daemon', ownership);
      assertStorageWriteAllowed('pipeline_data', 'daemon', ownership);
      assertStorageWriteAllowed(
        'pipeline_install_intents',
        'daemon',
        ownership,
      );
      return assertRowWritable(dataRoot, 'pipeline_install_intents', 'daemon');
    },
    createDirectoryDurably: async (directoryPath) => {
      const root = rootOf(directoryPath);
      admit(root.namespace);
      // Nothing is created through a folder on the way that is a link.
      await assertRealFolders(root, directoryPath);
      await mkdir(resolve(directoryPath), { recursive: true });
      await assertRealFolders(root, directoryPath);
      try {
        options.flushDirectorySync(dirname(root.folder));
        options.flushDirectorySync(root.folder);
      } catch (error) {
        throw new StorageOutcomeUnknownError('directory_flush', error);
      }
    },
    syncDirectory: (directoryPath) => {
      rootOf(directoryPath);
      options.flushDirectorySync(directoryPath);
      return Promise.resolve();
    },
    writeFileAtomically: async (targetPath, data, writeOptions) => {
      const namespace = await admitEntry(targetPath);
      install(resolve(targetPath), data, claim(namespace), writeOptions.mode);
    },
    writeStoreFileDurably: async (targetPath, data, writeOptions) => {
      const namespace = await admitEntry(targetPath);
      try {
        install(resolve(targetPath), data, claim(namespace), writeOptions.mode);
      } catch (error) {
        if (!isStorageOutcomeUnknownError(error)) throw error;
        // Installed, as Electron main's store write counts it: every later
        // read sees it. Only its survival across power loss is unconfirmed.
        options.warn(
          '[storage] Store file installed, but its folder flush failed',
          { namespace, stage: error.stage },
        );
      }
    },
    definitions: options.definitions,
    pipelineService: options.pipelineService,
    deleteUserPipelineLocalMetadata: options.deleteUserPipelineLocalMetadata,
    isInstallReceipt: options.isInstallReceipt,
    noteDefinitionRemoved: (definitionId, removal) => {
      removals.set(definitionId, removal);
    },
    definitionRemoval: (definitionId) => removals.get(definitionId),
    warn: options.warn,
    setTimeout: (run, waitMs) => setTimeout(run, waitMs),
    clearTimeout: (timer) => {
      clearTimeout(timer);
    },
    removePath: async (target, removeOptions) => {
      await admitEntry(target);
      await rm(resolve(target), removeOptions);
    },
    removeEmptyFolder: async (folder) => {
      await admitEntry(folder);
      await rmdir(resolve(folder));
    },
    renamePath: async (source, destination) => {
      const from = entryOf(source);
      const to = entryOf(destination);
      if (from.namespace !== to.namespace) refuse('cross_root_rename');
      await admitEntry(source);
      await admitEntry(destination);
      await rename(resolve(source), resolve(destination));
    },
    makeFolder: async (folder, folderOptions) => {
      await admitEntry(folder);
      await mkdir(resolve(folder), folderOptions);
    },
    pruneDamagedCopies: async (names) => {
      const root = rootOf(names.directory);
      await assertRealFolders(root, names.directory);
      admit(root.namespace);
      return pruneDamagedCopies(names);
    },
  };
}
