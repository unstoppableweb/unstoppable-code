import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/*
 * The runner's own folder archive (CAN-6317), which pipeline data and run
 * handoffs (CAN-6376) move in: a magic line, then one entry per folder and
 * regular file, each a JSON header line and, for a file, its bytes and a
 * newline. Paths are relative and use `/`. Only folders and regular files
 * are kept: a symbolic link or other special file is left out when packing
 * and refused when unpacking, so an archive can never reach outside its
 * folder. The web core stores it unread.
 */

const ENTRY_MAX = 20_000;
const ENTRY_PATH_MAX = 1024;

export interface ArchiveEntry {
  readonly path: string;
  readonly type: 'dir' | 'file';
  readonly mode: number;
  readonly bytes?: Buffer;
}

/** One kind of archive: its magic line, its limit and how it refuses. */
export interface ArchiveFormat {
  readonly magic: Buffer;
  readonly maxBytes: number;
  readonly refuse: {
    /** Over `maxBytes`. */
    readonly tooLarge: () => Error;
    /** More than the entry limit. */
    readonly tooManyEntries: () => Error;
    /** A path packing found that no unpack would accept. */
    readonly unkeepablePath: (entryPath: string) => Error;
    /** Bytes that are not an archive of this kind. */
    readonly invalid: () => Error;
  };
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A relative path that stays inside its folder, in the host's separators, or null. */
export function safeArchivePath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length > ENTRY_PATH_MAX
  )
    return null;
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\') ||
        segment.includes('\u0000'),
    )
  )
    return null;
  return segments.join(path.sep);
}

/** Packs a folder's folders and regular files, in a stable order. */
export async function packArchive(
  root: string,
  format: ArchiveFormat,
): Promise<Buffer> {
  const parts: Buffer[] = [format.magic];
  let size = format.magic.byteLength;
  let entries = 0;
  const add = (entry: ArchiveEntry): void => {
    entries += 1;
    if (entries > ENTRY_MAX) throw format.refuse.tooManyEntries();
    const header = Buffer.from(
      `${JSON.stringify({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        ...(entry.bytes && { size: entry.bytes.byteLength }),
      })}\n`,
    );
    parts.push(header);
    size += header.byteLength;
    if (entry.bytes) {
      parts.push(entry.bytes, Buffer.from('\n'));
      size += entry.bytes.byteLength + 1;
    }
    if (size > format.maxBytes) throw format.refuse.tooLarge();
  };
  const walk = async (relative: string): Promise<void> => {
    const names = (await readdir(path.join(root, relative))).sort();
    for (const name of names) {
      const entryPath = relative === '' ? name : `${relative}/${name}`;
      // Refused here rather than saved as an archive no restore accepts.
      if (safeArchivePath(entryPath) === null)
        throw format.refuse.unkeepablePath(entryPath.slice(0, 200));
      const absolute = path.join(root, entryPath);
      const stats = await lstat(absolute);
      if (stats.isDirectory()) {
        add({ path: entryPath, type: 'dir', mode: stats.mode & 0o777 });
        await walk(entryPath);
      } else if (stats.isFile()) {
        if (size + stats.size > format.maxBytes) throw format.refuse.tooLarge();
        add({
          path: entryPath,
          type: 'file',
          mode: stats.mode & 0o777,
          bytes: await readFile(absolute),
        });
      }
    }
  };
  await walk('');
  return Buffer.concat(parts, size);
}

/** The archive's entries, every path checked; throws `refuse.invalid` otherwise. */
export function parseArchive(
  bytes: Buffer,
  format: ArchiveFormat,
): ArchiveEntry[] {
  const invalid = format.refuse.invalid;
  const { magic } = format;
  if (!bytes.subarray(0, magic.byteLength).equals(magic)) throw invalid();
  const entries: ArchiveEntry[] = [];
  let at = magic.byteLength;
  while (at < bytes.byteLength) {
    if (entries.length >= ENTRY_MAX) throw invalid();
    const end = bytes.indexOf(0x0a, at);
    if (end < 0) throw invalid();
    let header: unknown;
    try {
      header = JSON.parse(bytes.subarray(at, end).toString('utf8'));
    } catch {
      throw invalid();
    }
    at = end + 1;
    if (header === null || typeof header !== 'object') throw invalid();
    const type: unknown = Reflect.get(header, 'type');
    const mode: unknown = Reflect.get(header, 'mode');
    const entryPath = safeArchivePath(Reflect.get(header, 'path'));
    if (
      entryPath === null ||
      (type !== 'dir' && type !== 'file') ||
      typeof mode !== 'number' ||
      !Number.isInteger(mode) ||
      mode < 0 ||
      mode > 0o777
    )
      throw invalid();
    if (type === 'dir') {
      entries.push({ path: entryPath, type, mode });
      continue;
    }
    const size: unknown = Reflect.get(header, 'size');
    if (
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size < 0 ||
      at + size + 1 > bytes.byteLength ||
      bytes[at + size] !== 0x0a
    )
      throw invalid();
    entries.push({
      path: entryPath,
      type,
      mode,
      bytes: bytes.subarray(at, at + size),
    });
    at += size + 1;
  }
  return entries;
}

/** Writes parsed entries into a new folder; the caller swaps or copies it in. */
export async function unpackArchive(
  entries: readonly ArchiveEntry[],
  into: string,
): Promise<void> {
  await mkdir(into, { recursive: true });
  for (const entry of entries) {
    const target = path.join(into, entry.path);
    // Owner-writable, so the next run and the next export can use it.
    const mode = entry.mode | 0o600;
    if (entry.type === 'dir') {
      await mkdir(target, { recursive: true, mode: mode | 0o700 });
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.bytes ?? Buffer.alloc(0), { mode });
    }
  }
}
