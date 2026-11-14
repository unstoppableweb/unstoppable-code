import { renameWithRetry } from './rename-with-retry';
import {
  admitStorageWrite,
  type StorageAdmissionTarget,
} from './storage-admission';
import {
  admittedStorageRowForPath,
  admittedStorageRowForWrite,
  isAdmittedStorageCandidate,
  type AdmittedStorageNamespace,
  type AdmittedWriterTarget,
} from './admitted-storage-paths';
import {
  assertAdmittedWriter,
  assertStorageWriteAllowed,
  ensureFolderChainDurable,
  folderIdentityOf,
  STORAGE_OWNERSHIP,
  StorageOutcomeUnknownError,
  StorageWriteRefusedError,
  type ConfirmedFolders,
  type FolderChainPorts,
  type FolderIdentity,
} from '@canopy/core-runtime/storage';
import {
  flushDirectory,
  flushDirectorySync,
} from '@canopy/core-platform/directory-flush';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { ensureW5RootPresence } from '../w5-root-presence';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export { renameWithRetry };
export type { AdmittedWriterTarget };

export interface AtomicFileWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  /** Install only when the destination is absent. */
  overwrite?: boolean;
  /**
   * Sync the complete file before installing it, then flush its directory
   * (`syncDirectory`), and resolve only after both. A failed directory flush
   * after the install rejects with `StorageOutcomeUnknownError`.
   */
  durable?: boolean;
  /**
   * Runs once the temporary file is complete, just before it is installed,
   * and again before each rename retry; a rejection removes it and installs
   * nothing. A writer whose admission
   * can end while the file is written checks it again here (CAN-6198).
   */
  beforeInstall?: () => Promise<void>;
  /** A W5 write: ownership-checked, and admitted by its operation. */
  storage?: StorageAdmissionTarget;
  /**
   * A write to a row with `admittedWriters`, by one of them. The writer
   * refuses any other write whose path names such a row.
   */
  admittedWriter?: AdmittedWriterTarget;
}

export type AtomicFileStorage = NonNullable<AtomicFileWriteOptions['storage']>;

/**
 * Flush a folder so entries created, renamed or removed in it persist. On
 * Windows this is `WINDOWS_DIRECTORY_FLUSH_LABEL`'s API-level flush. Rejects
 * with a typed `DirectoryFlushError`, never a silent no-op.
 */
export async function syncDirectory(directoryPath: string): Promise<void> {
  await flushDirectory(directoryPath);
}

/**
 * Sync every regular file under `root`, then flush each folder from the
 * deepest up and finally `root`'s parent, so a copied tree survives power loss
 * before its source is removed. Links are not followed. Rejects on the first
 * failure; a caller keeps its source then.
 */
export async function syncTreeDurably(root: string): Promise<void> {
  const flushTree = async (target: string): Promise<void> => {
    const info = await lstat(target);
    if (info.isDirectory()) {
      for (const name of await readdir(target)) {
        await flushTree(join(target, name));
      }
      await flushDirectory(target);
    } else if (info.isFile()) {
      // Windows flushes only through a handle opened for writing.
      const handle = await open(
        target,
        hostOperatingSystem() === 'win32' ? 'r+' : 'r',
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  };
  await flushTree(root);
  await flushDirectory(dirname(resolve(root)));
}

/** Folders this process confirmed durable (`ensureFolderChainDurable`). */
const confirmedFolders: ConfirmedFolders = new Map();

async function folderIdentity(folder: string): Promise<FolderIdentity> {
  const stats = await stat(folder, { bigint: true });
  if (!stats.isDirectory()) {
    throw Object.assign(new Error(`ENOTDIR: not a directory, ${folder}`), {
      code: 'ENOTDIR',
    });
  }
  return folderIdentityOf(stats);
}

const folderChainPorts: FolderChainPorts = {
  mkdir: (folder) => mkdir(folder, { recursive: true }),
  identity: folderIdentity,
  dirname,
  flush: flushDirectory,
};

/**
 * Creates `directoryPath` if missing and makes it durable up to `dataRoot`:
 * every folder from it to the data root has its entry flushed, the data
 * root's parent last, unless this process already confirmed it. Nothing
 * above that parent is flushed: Windows refuses a standard user the handle
 * its flush needs on `C:\Users` and `C:\`. A failure rejects (a flush with
 * `DirectoryFlushError`) and a later call retries it. Calls run one at a
 * time in the process.
 */
export function createDirectoryDurably(
  directoryPath: string,
  options: { readonly dataRoot: string },
): Promise<void> {
  const target = resolve(directoryPath);
  const dataRoot = resolve(options.dataRoot);
  const run = directoryCreation.then(() =>
    ensureFolderChainDurable([target], folderChainPorts, {
      dataRoot,
      confirmed: confirmedFolders,
    }),
  );
  directoryCreation = run.catch(() => undefined);
  return run;
}

let directoryCreation: Promise<void> = Promise.resolve();

/** Refuses a write whose path names a curated row it was not admitted to. */
function assertAdmittedRow(
  row: AdmittedStorageNamespace | undefined,
  admitted: AdmittedWriterTarget | undefined,
  declaredWriter: string,
): void {
  if (row !== undefined && row !== admitted?.namespace) {
    throw new StorageWriteRefusedError(
      row,
      declaredWriter,
      'unadmitted_writer',
    );
  }
}

function outcomeUnknown(
  error: unknown,
  admitted: AdmittedWriterTarget | undefined,
): StorageOutcomeUnknownError {
  return new StorageOutcomeUnknownError(
    'directory_flush',
    error,
    admitted?.namespace,
  );
}

function temporarySiblingPath(targetPath: string): string {
  return join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

export type AtomicFileWriteSyncOptions = Pick<
  AtomicFileWriteOptions,
  'encoding' | 'mode' | 'durable' | 'admittedWriter'
>;

const RENAME_SYNC_RETRY_DELAYS_MS = [10, 20, 40, 80] as const;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Retry transient sharing violations; never deletes the destination. */
function renameWithRetrySync(source: string, target: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      const code: unknown =
        error !== null && typeof error === 'object'
          ? Reflect.get(error, 'code')
          : undefined;
      const delay = RENAME_SYNC_RETRY_DELAYS_MS[attempt];
      if (
        delay === undefined ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(String(code))
      ) {
        throw error;
      }
      sleepSync(delay);
    }
  }
}

/**
 * Synchronous `writeFileAtomically` without storage admission: a complete
 * sibling file is renamed over `targetPath`. For exit paths that cannot
 * await, and for small, rare read-modify-writes that must stay synchronous so
 * no other writer in the process interleaves. It blocks the calling thread,
 * including `fsync` when `durable` and short sleeps between rename retries.
 * It writes a row with `admittedWriters` only as one of them; without the data
 * root, which it cannot load synchronously, it checks file shapes in any folder.
 */
export function writeFileAtomicallySync(
  targetPath: string,
  data: string | Uint8Array,
  options?: AtomicFileWriteSyncOptions,
): void {
  assertAdmittedRow(
    admittedStorageRowForPath(targetPath, null),
    options?.admittedWriter,
    'undeclared',
  );
  const admitted = options?.admittedWriter;
  if (admitted) {
    assertAdmittedWriter(
      admitted.namespace,
      admitted.writer,
      admitted.module,
      STORAGE_OWNERSHIP,
    );
  }
  const tempPath = temporarySiblingPath(targetPath);
  let installed = false;
  try {
    const fd = openSync(tempPath, 'wx', options?.mode);
    try {
      writeFileSync(fd, data, { encoding: options?.encoding });
      if (options?.mode !== undefined) {
        try {
          fchmodSync(fd, options.mode);
        } catch {
          // As in the asynchronous writer, the creation mode already applies.
        }
      }
      if (options?.durable === true) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetrySync(tempPath, targetPath);
    installed = true;
  } finally {
    if (!installed) {
      try {
        unlinkSync(tempPath);
      } catch {
        // The temporary file may never have been created.
      }
    }
  }
  if (options?.durable !== true) return;
  try {
    flushDirectorySync(dirname(targetPath));
  } catch (error) {
    throw outcomeUnknown(error, undefined);
  }
}

/** Write a complete sibling file, then atomically install it at `targetPath`. */
export async function writeFileAtomically(
  targetPath: string,
  data: string | Uint8Array,
  options?: AtomicFileWriteOptions,
): Promise<void> {
  const storage = options?.storage;
  const admitted = options?.admittedWriter;
  if (storage && admitted) {
    throw new TypeError('A write is either a W5 write or an admitted write');
  }
  // Only a curated row's file name waits for the data root; every other
  // write keeps starting its ownership check synchronously.
  if (isAdmittedStorageCandidate(targetPath)) {
    assertAdmittedRow(
      await admittedStorageRowForWrite(targetPath),
      admitted,
      storage?.writer ?? 'undeclared',
    );
  }
  if (admitted) {
    assertAdmittedWriter(
      admitted.namespace,
      admitted.writer,
      admitted.module,
      STORAGE_OWNERSHIP,
    );
    return installFile(targetPath, data, options);
  }
  if (!storage) return installFile(targetPath, data, options);
  assertStorageWriteAllowed(
    storage.namespace,
    storage.writer,
    STORAGE_OWNERSHIP,
  );
  return admitStorageWrite(storage, async () => {
    // Non-W5 CLI sinks still keep permanent root presence; canonical W5 sinks
    // were refused by ownership above and can never write through this path.
    if (storage.writer === 'desktop_cli') await ensureW5RootPresence();
    return installFile(targetPath, data, options);
  });
}

async function installFile(
  targetPath: string,
  data: string | Uint8Array,
  options?: AtomicFileWriteOptions,
): Promise<void> {
  const tempPath = temporarySiblingPath(targetPath);
  let installed = false;
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    handle = await open(tempPath, 'wx', options?.mode);
    try {
      await handle.writeFile(data, options?.encoding);
      if (options?.mode !== undefined) {
        await handle.chmod(options.mode).catch(() => undefined);
      }
      if (options?.durable === true) await handle.sync();
    } finally {
      await handle.close();
      handle = null;
    }
    await options?.beforeInstall?.();
    if (options?.overwrite === false) {
      // A same-directory hard link atomically publishes the already-complete
      // temporary file without replacing a destination created by another
      // writer. This is supported by the local filesystems used on macOS and
      // Windows; callers can handle EEXIST as a compare-and-install loss.
      await link(tempPath, targetPath);
      await unlink(tempPath).catch(() => undefined);
    } else {
      await renameWithRetry(tempPath, targetPath, {
        // Each retry checks again: the backoff can outlast an admission.
        ...(options?.beforeInstall && { beforeRetry: options.beforeInstall }),
      });
    }
    installed = true;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (!installed) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
  if (options?.durable !== true) return;
  try {
    await flushDirectory(dirname(targetPath));
  } catch (error) {
    throw outcomeUnknown(error, options.admittedWriter);
  }
}
