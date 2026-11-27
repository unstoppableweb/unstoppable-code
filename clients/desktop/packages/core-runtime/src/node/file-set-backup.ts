import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';

/*
 * Copy, digest and compare the files of one storage namespace, for backups
 * of file-backed stores (CAN-5340). The namespace is one data-root-relative
 * file or folder; a folder copy keeps every file and folder below it, except
 * the top-level names the caller excludes.
 */

export type FileSetBackupErrorCode =
  | 'BACKUP_UNVERIFIED'
  | 'NOT_QUIESCED'
  | 'NEWER_STATE'
  | 'OWNER_RECORD'
  | 'NOT_REQUIRED_BEFORE_FLIP';

export class FileSetBackupError extends Error {
  public readonly code: FileSetBackupErrorCode;

  public constructor(code: FileSetBackupErrorCode, message: string) {
    super(message);
    this.name = 'FileSetBackupError';
    this.code = code;
  }
}

export interface FileSetFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** What a namespace holds: nothing, one file, or a folder tree. */
export type FileSetManifest =
  | { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly bytes: number; readonly sha256: string }
  | {
      readonly kind: 'directory';
      readonly directories: readonly string[];
      readonly files: readonly FileSetFile[];
    };

/**
 * A catch handler that answers `fallback` when the path doesn't exist and
 * rethrows every other error, so a path that can't be read never reads as
 * empty or absent.
 */
export function whenMissing<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    if (
      error !== null &&
      typeof error === 'object' &&
      Reflect.get(error, 'code') === 'ENOENT'
    )
      return fallback;
    throw error;
  };
}

function hostPath(root: string, relative: string): string {
  return join(root, ...relative.split(posix.sep));
}

async function fileEntry(
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(path);
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function notRegular(path: string): FileSetBackupError {
  return new FileSetBackupError(
    'BACKUP_UNVERIFIED',
    `${path} is neither a regular file nor a folder.`,
  );
}

/**
 * The namespace at `path`. Symbolic links and special files are refused, so
 * a copy never follows a link out of the namespace.
 */
export async function fileSetManifest(
  path: string,
  exclude: readonly string[] = [],
): Promise<FileSetManifest> {
  const stats = await lstat(path).catch(whenMissing(undefined));
  if (stats === undefined) return { kind: 'absent' };
  if (stats.isFile()) return { kind: 'file', ...(await fileEntry(path)) };
  if (!stats.isDirectory()) throw notRegular(path);
  const directories: string[] = [];
  const files: FileSetFile[] = [];
  const walk = async (relative: string): Promise<void> => {
    const names = (await readdir(hostPath(path, relative))).sort();
    for (const name of names) {
      if (relative === '' && exclude.includes(name)) continue;
      const child = relative === '' ? name : `${relative}/${name}`;
      const absolute = hostPath(path, child);
      const entry = await lstat(absolute);
      if (entry.isDirectory()) {
        directories.push(child);
        await walk(child);
      } else if (entry.isFile())
        files.push({ path: child, ...(await fileEntry(absolute)) });
      else throw notRegular(absolute);
    }
  };
  await walk('');
  return { kind: 'directory', directories, files };
}

/** The sha256 of a manifest's canonical form. */
export function fileSetDigest(manifest: FileSetManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

/**
 * Flushes a file's contents to disk. `writeHandle` is the host fact that the
 * flush needs a handle opened for writing: Windows `FlushFileBuffers` refuses
 * a read-only one.
 */
export async function syncFile(
  path: string,
  writeHandle: boolean,
): Promise<void> {
  const handle = await open(path, writeHandle ? 'r+' : 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Copies the namespace at `source`, as `manifest` describes it, to `target`,
 * which must not exist, and flushes every copied file ({@link syncFile}).
 * Returns the folders the caller must flush, deepest first.
 */
export async function copyFileSet(
  source: string,
  target: string,
  manifest: FileSetManifest,
  writeHandle: boolean,
): Promise<readonly string[]> {
  if (manifest.kind === 'absent') return [];
  await mkdir(dirname(target), { recursive: true });
  if (manifest.kind === 'file') {
    await copyFile(source, target);
    await syncFile(target, writeHandle);
    return [dirname(target)];
  }
  await mkdir(target);
  const folders = [target];
  for (const directory of manifest.directories) {
    await mkdir(hostPath(target, directory));
    folders.push(hostPath(target, directory));
  }
  for (const file of manifest.files) {
    await copyFile(hostPath(source, file.path), hostPath(target, file.path));
    await syncFile(hostPath(target, file.path), writeHandle);
  }
  return [...folders.reverse(), dirname(target)];
}

/** Whether anything, a dangling symlink included, occupies the path. */
export async function isOccupied(path: string): Promise<boolean> {
  return (await lstat(path).catch(whenMissing(undefined))) !== undefined;
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * The host path of a data-root-relative path. Its nearest existing ancestor
 * must resolve inside the data root, so a symlinked folder cannot carry a
 * copy elsewhere.
 */
export async function resolveInsideDataRoot(
  dataRoot: string,
  relative: string,
): Promise<string> {
  const leaves = (): FileSetBackupError =>
    new FileSetBackupError(
      'BACKUP_UNVERIFIED',
      'The backup path leaves the data root.',
    );
  const root = await realpath(dataRoot);
  const target = resolve(root, ...relative.split(posix.sep));
  if (!target.startsWith(`${root}${sep}`)) throw leaves();
  let ancestor = dirname(target);
  while (!(await isOccupied(ancestor))) ancestor = dirname(ancestor);
  if (!isInside(root, await realpath(ancestor))) throw leaves();
  return target;
}
