import { renameWithRetry } from './rename-with-retry';
import {
  admitStorageWrite,
  type StorageAdmissionTarget,
} from './storage-admission';
import {
  admittedStorageRowForSyncWrite,
  admittedStorageRowForWrite,
  isAdmittedStorageCandidate,
  OWNERSHIP_OVERRIDE_NAMESPACE,
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
  type StorageOwnershipRow,
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
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  type FileHandle,
  chmod,
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
   * nothing. Receives the staged path so a caller can identify its own install
   * for post-await compensation. A writer whose admission
   * can end while the file is written checks it again here (CAN-6198).
   */
  beforeInstall?: (temporaryPath: string) => Promise<void>;
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
      await flushFile(target, info.mode);
    }
  };
  await flushTree(root);
  await flushDirectory(dirname(resolve(root)));
}

async function flushFile(target: string, mode: number): Promise<void> {
  const windows = hostOperatingSystem() === 'win32';
  // Windows flushes only through a handle opened for writing, which a
  // read-only file refuses: lift the attribute just for the open. The open
  // handle keeps its write access, so the mode goes back before the flush.
  // shortcut: a crash between the two chmods, or a failed restoring chmod,
  // leaves the file writable (Windows only; the attribute, never data), and a
  // retry can't tell. Closing it needs each caller's recovery record to keep
  // the mode.
  const readOnly = windows && (mode & 0o200) === 0;
  const original = mode & 0o7777;
  if (readOnly) await chmod(target, original | 0o200);
  let handle: FileHandle;
  try {
    handle = await open(target, windows ? 'r+' : 'r');
  } catch (error) {
    if (readOnly) await chmod(target, original);
    throw error;
  }
  try {
    if (readOnly) await chmod(target, original);
    await handle.sync();
  } finally {
    await handle.close();
  }
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

/**
 * The rows that decide an admitted write: the compiled ones, or the caller's
 * for pipeline_definitions only. Any other namespace carrying its own rows
 * is refused before anything is written.
 */
function admittedOwnership(
  admitted: AdmittedWriterTarget,
): readonly StorageOwnershipRow[] {
  if (admitted.ownership === undefined) return STORAGE_OWNERSHIP;
  if (admitted.namespace !== OWNERSHIP_OVERRIDE_NAMESPACE)
    throw new StorageWriteRefusedError(
      admitted.namespace,
      admitted.writer,
      'unadmitted_writer',
    );
  return admitted.ownership;
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
 * root, which it cannot load synchronously, legacy rows check file shapes in
 * any folder. New terminal rows use the already-registered data root instead.
 */
export function writeFileAtomicallySync(
  targetPath: string,
  data: string | Uint8Array,
  options?: AtomicFileWriteSyncOptions,
): void {
  assertAdmittedRow(
    admittedStorageRowForSyncWrite(targetPath, realpathSync.native),
    options?.admittedWriter,
    'undeclared',
  );
  const admitted = options?.admittedWriter;
  if (admitted) {
    assertAdmittedWriter(
      admitted.namespace,
      admitted.writer,
      admitted.module,
      admittedOwnership(admitted),
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
      admittedOwnership(admitted),
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
    await options?.beforeInstall?.(tempPath);
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
        ...(options?.beforeInstall && {
          beforeRetry: async (): Promise<void> => {
            await options.beforeInstall?.(tempPath);
          },
        }),
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
