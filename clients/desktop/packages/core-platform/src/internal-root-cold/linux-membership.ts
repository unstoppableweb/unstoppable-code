import path from 'node:path';
import { getHeapStatistics } from 'node:v8';
import type { LinuxColdIO } from './linux';
import type {
  createLinuxColdPathMapper,
  LinuxColdPathIdentity,
} from './linux-mounts';

export interface LinuxColdTreeEntry {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
}

// Memory guard for metadata and identity indexes, not a directory-name limit.
const LINUX_COLD_CENSUS_ENTRY_CAP = 4_000_000;
// ~0.4 KiB/entry measured at 2M; budget 512 B and leave half the heap for the host/GC.
const CENSUS_BYTES_PER_ENTRY = 512;
const APPLY_METADATA_HEADROOM = 4096;

export interface LinuxColdCensusOptions {
  /** Before the first journal: reserve a second copy of every affected tree. */
  readonly predictApplyPeak?: boolean;
  readonly sourceRoot?: string;
  readonly replicaRoots?: readonly string[];
  readonly onProgress?: (
    phase: 'census' | 'recheck',
    completed: number,
  ) => void;
  /** Test seam: may only lower the installed memory guard. */
  readonly entryCap?: number;
}

export class LinuxColdCensusError extends Error {}

function remember<Device>(
  index: Map<Device, Set<bigint>>,
  device: Device,
  inode: bigint,
): void {
  let inodes = index.get(device);
  if (!inodes) {
    inodes = new Set();
    index.set(device, inodes);
  }
  inodes.add(inode);
}
function metadata(entry: LinuxColdTreeEntry): LinuxColdTreeEntry {
  return {
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    ctimeNs: entry.ctimeNs,
    mtimeNs: entry.mtimeNs,
  };
}

function key(dev: bigint | string, ino: bigint): string {
  return `${dev}:${ino}`;
}
export function linuxColdDevice(dev: bigint): string {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return `${major}:${minor}`;
}
function under(file: string, root: string): boolean {
  return file === root || file.startsWith(root === '/' ? '/' : `${root}/`);
}
function equal(left: LinuxColdTreeEntry, right: LinuxColdTreeEntry): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

/** Complete metadata-only census; names and identities must still agree after /proc inspection. */
export async function linuxColdMembership(
  io: LinuxColdIO,
  roots: readonly string[],
  mapPath: ReturnType<typeof createLinuxColdPathMapper>,
  options: LinuxColdCensusOptions = {},
): Promise<{
  readonly roots: readonly string[];
  readonly object: (identity: {
    readonly dev: bigint;
    readonly ino: bigint;
  }) => boolean;
  readonly objectDevice: (device: bigint) => boolean;
  readonly mappingDevice: (device: string) => boolean;
  readonly mapping: (device: string, inode: bigint) => boolean;
  readonly coordinate: (identity: LinuxColdPathIdentity) => boolean;
  readonly recheck: () => Promise<void>;
}> {
  const installedCap = Math.min(
    LINUX_COLD_CENSUS_ENTRY_CAP,
    Math.floor(
      getHeapStatistics().heap_size_limit / (2 * CENSUS_BYTES_PER_ENTRY),
    ),
  );
  const cap = options.entryCap ?? installedCap;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > installedCap)
    throw new LinuxColdCensusError('Invalid Linux census memory guard');
  const objects = new Map<bigint, Set<bigint>>();
  const objectDevices = new Set<bigint>();
  const mappingDevices = new Set<string>();
  const mappings = new Map<string, Set<bigint>>();
  const nodes = new Map<string, LinuxColdTreeEntry>();
  const absent = new Map<
    string,
    { readonly parent: string; readonly entry: LinuxColdTreeEntry }
  >();
  function missing(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    );
  }
  const directories = new Map<string, readonly string[]>();
  let currentRoot = roots[0] ?? '/';
  let sourceEntries = 0;
  let replicaEntries = 0;
  let otherEntries = 0;
  function admit(file: string, missing = false): void {
    if (options.sourceRoot && under(file, options.sourceRoot)) sourceEntries++;
    else if (
      !missing &&
      options.replicaRoots?.some((root) => under(file, root))
    )
      replicaEntries++;
    else otherEntries++;
    const completed = nodes.size + absent.size;
    const reached = completed + 1;
    // Existing replicas consume the reservation; they are not another future copy.
    const applyPeak = options.predictApplyPeak
      ? sourceEntries * 2 +
        otherEntries * 2 +
        Math.max(0, replicaEntries - sourceEntries) +
        APPLY_METADATA_HEADROOM
      : reached;
    if (reached > cap || applyPeak > cap)
      throw new LinuxColdCensusError(
        `Linux target census memory guard: root=${JSON.stringify(currentRoot)} completed=${completed} reached=${reached} applyPeak=${applyPeak} cap=${cap}`,
      );
  }
  function failure(error: unknown, file = currentRoot): LinuxColdCensusError {
    if (error instanceof LinuxColdCensusError) return error;
    const root = roots.find((root) => under(file, root)) ?? file;
    return new LinuxColdCensusError(
      `Linux target census incomplete: root=${JSON.stringify(root)} completed=${nodes.size + absent.size} cap=${cap}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const coordinates = roots.flatMap((root) => mapPath.affected(root));
    for (const coordinate of coordinates) mappingDevices.add(coordinate.device);
    async function names(file: string): Promise<readonly string[]> {
      const entries = await io.list(file);
      if (
        entries.some(
          (name) =>
            !name ||
            name === '.' ||
            name === '..' ||
            name.includes('/') ||
            /[\0\ufffd\ud800-\udfff]/u.test(name),
        ) ||
        new Set(entries).size !== entries.length
      )
        throw new Error(
          `Incomplete Linux target directory: path=${JSON.stringify(file)}`,
        );
      return [...entries].sort();
    }
    async function visit(
      file: string,
      ancestors: ReadonlySet<string>,
    ): Promise<void> {
      if (nodes.has(file)) return;
      const entry = metadata(await io.entry(file));
      admit(file);
      nodes.set(file, entry);
      remember(objects, entry.dev, entry.ino);
      objectDevices.add(entry.dev);
      const device = mapPath(file).device;
      mappingDevices.add(device);
      remember(mappings, device, entry.ino);
      options.onProgress?.('census', nodes.size + absent.size);
      if ((entry.mode & 0o170000n) !== 0o040000n) return;
      const identity = key(entry.dev, entry.ino);
      if (ancestors.has(identity))
        throw new Error(
          `Cyclic Linux target directory: path=${JSON.stringify(file)}`,
        );
      const children = await names(file);
      directories.set(file, children);
      for (const child of children)
        await visit(
          path.posix.join(file, child),
          new Set([...ancestors, identity]),
        );
      if (!equal(entry, await io.entry(file)))
        throw new Error(`Linux target changed: path=${JSON.stringify(file)}`);
    }
    for (const root of roots) {
      currentRoot = root;
      mapPath(root);
      let entry: LinuxColdTreeEntry;
      try {
        entry = await io.entry(root);
      } catch (error) {
        if (!missing(error)) throw error;
        let parent = path.posix.dirname(root);
        for (;;) {
          try {
            const parentEntry = await io.entry(parent);
            if ((parentEntry.mode & 0o170000n) !== 0o040000n)
              throw new Error('Linux target ancestor is not a directory');
            objectDevices.add(parentEntry.dev);
            if (!absent.has(root)) admit(root, true);
            absent.set(root, { parent, entry: metadata(parentEntry) });
            options.onProgress?.('census', nodes.size + absent.size);
            break;
          } catch (failure) {
            if (!missing(failure) || parent === '/') throw failure;
            parent = path.posix.dirname(parent);
          }
        }
        continue;
      }
      if ((entry.mode & 0o170000n) !== 0o040000n)
        throw new Error(
          `Linux target is not a directory: path=${JSON.stringify(root)}`,
        );
      await visit(root, new Set());
    }
    return {
      roots: [...roots],
      object: (identity) =>
        objects.get(identity.dev)?.has(identity.ino) ?? false,
      objectDevice: (device) => objectDevices.has(device),
      mappingDevice: (device) => mappingDevices.has(device),
      mapping: (device, inode) => mappings.get(device)?.has(inode) ?? false,
      coordinate: (identity) =>
        coordinates.some(
          (root) =>
            root.device === identity.device && under(identity.path, root.path),
        ),
      recheck: async () => {
        let current = currentRoot;
        try {
          let completed = 0;
          for (const [file, before] of absent) {
            current = file;
            try {
              await io.entry(file);
            } catch (error) {
              if (!missing(error)) throw error;
              if (!equal(before.entry, await io.entry(before.parent)))
                throw new Error(
                  `Linux target ancestor changed: path=${JSON.stringify(file)}`,
                );
              options.onProgress?.('recheck', ++completed);
              continue;
            }
            throw new Error(
              `Linux target appeared: path=${JSON.stringify(file)}`,
            );
          }
          for (const [file, entry] of nodes) {
            current = file;
            if (!equal(entry, await io.entry(file)))
              throw new Error(
                `Linux target changed: path=${JSON.stringify(file)}`,
              );
            const children = directories.get(file);
            if (
              children &&
              JSON.stringify(children) !== JSON.stringify(await names(file))
            )
              throw new Error(
                `Linux target directory changed: path=${JSON.stringify(file)}`,
              );
            options.onProgress?.('recheck', ++completed);
          }
        } catch (error) {
          throw failure(error, current);
        }
      },
    };
  } catch (error) {
    throw failure(error);
  }
}
