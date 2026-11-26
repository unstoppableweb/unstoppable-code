import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  type ConfirmedFolders,
  ensureFolderChainDurable,
  type FolderChainPorts,
  folderIdentityOf,
} from '../../storage/folder-chain-durability';
import { StorageOutcomeUnknownError } from '../../storage/outcome-unknown';
import { damagedCopyPath, pruneDamagedCopies } from '../damaged-copies';

/*
 * The v1 file-annotations state file of one worktree. Electron main is its
 * only writer: the host resolves the file's path with its canonical helper and
 * owns the one engine that writes it (CAN-4104).
 */

const writeLocks = new Map<string, Promise<void>>();

/** Serializes read-modify-write cycles on one state file in this process. */
export async function withAnnotationStateLock<T>(
  statePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = writeLocks.get(statePath) ?? Promise.resolve();
  let release = (): void => undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(statePath, next);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(statePath) === next) {
      writeLocks.delete(statePath);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  // Not `instanceof Error`: fs errors can come from another realm.
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** The state file's bytes, or null before the first write. */
export async function readAnnotationStateBytes(
  statePath: string,
): Promise<Buffer | null> {
  try {
    return await readFile(statePath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/** The raw state text, or null before the first write. */
export async function readAnnotationStateText(
  statePath: string,
): Promise<string | null> {
  return (await readAnnotationStateBytes(statePath))?.toString('utf8') ?? null;
}

/**
 * Keeps a copy of a state file's bytes beside it (`<file>.damaged-<ms>`), and
 * only the newest few copies. The bytes are written as they were read, so a
 * file that is not valid UTF-8 is copied exactly. Best effort: answers
 * whether the copy was written, and never throws.
 */
export async function keepDamagedAnnotationStateCopy(
  statePath: string,
  content: Uint8Array,
  dataRoot: string,
  flush?: AnnotationFolderFlush,
): Promise<boolean> {
  try {
    await writeAnnotationStateText(
      damagedCopyPath(statePath),
      content,
      dataRoot,
      flush,
    );
  } catch {
    return false;
  }
  await pruneDamagedCopies(statePath);
  return true;
}

/** A host's folder flush: rejects when the folder's entries may not persist. */
export type AnnotationFolderFlush = (directoryPath: string) => Promise<unknown>;

/**
 * The default folder flush, a POSIX `fsync`; any open, flush or close failure
 * rejects. Windows refuses to flush a read-only handle, so a Windows host
 * passes its own (the desktop passes core-platform's `flushDirectory`).
 */
async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
}

/** Folders this process confirmed durable (`ensureFolderChainDurable`). */
const confirmedFolders: ConfirmedFolders = new Map();

const folderChainPorts: Omit<FolderChainPorts, 'flush'> = {
  mkdir: (folder) => mkdir(folder, { recursive: true }),
  identity: async (folder) => {
    const stats = await stat(folder, { bigint: true });
    if (!stats.isDirectory()) {
      throw Object.assign(new Error(`ENOTDIR: not a directory, ${folder}`), {
        code: 'ENOTDIR',
      });
    }
    return folderIdentityOf(stats);
  },
  dirname,
};

/**
 * Replaces the state file atomically and durably (CAN-4735). Its folder is
 * made durable up to `dataRoot` first, the complete temporary file is synced
 * before it is renamed over the state file, and the folder is flushed after,
 * so an acknowledged write survives a crash. A flush that fails after the
 * rename rejects with `StorageOutcomeUnknownError`: the new content is
 * visible, but either version may remain after a crash. All async.
 */
export async function writeAnnotationStateText(
  statePath: string,
  content: string | Uint8Array,
  dataRoot: string,
  flush: AnnotationFolderFlush = syncDirectory,
): Promise<void> {
  const directory = dirname(statePath);
  const ports: FolderChainPorts = { ...folderChainPorts, flush };
  await ensureFolderChainDurable([resolve(directory)], ports, {
    dataRoot: resolve(dataRoot),
    confirmed: confirmedFolders,
  });
  const tempPath = join(directory, `.file-annotations-${randomUUID()}.tmp`);
  try {
    const handle = await open(tempPath, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, statePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  try {
    await flush(directory);
  } catch (cause) {
    throw new StorageOutcomeUnknownError(
      'directory_flush',
      cause,
      'file_annotations',
    );
  }
}
