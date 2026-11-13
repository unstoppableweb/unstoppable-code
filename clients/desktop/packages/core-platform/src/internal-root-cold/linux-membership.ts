import path from 'node:path';
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
  const objects = new Set<string>();
  const objectDevices = new Set<bigint>();
  const mappingDevices = new Set<string>();
  const mappings = new Set<string>();
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
    if (nodes.size >= 100_000)
      throw new Error('Linux target census exceeds bound');
    const entry = await io.entry(file);
    nodes.set(file, entry);
    objects.add(key(entry.dev, entry.ino));
    objectDevices.add(entry.dev);
    mappingDevices.add(mapPath(file).device);
    mappings.add(key(mapPath(file).device, entry.ino));
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
          absent.set(root, { parent, entry: parentEntry });
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
    object: (identity) => objects.has(key(identity.dev, identity.ino)),
    objectDevice: (device) => objectDevices.has(device),
    mappingDevice: (device) => mappingDevices.has(device),
    mapping: (device, inode) => mappings.has(key(device, inode)),
    coordinate: (identity) =>
      coordinates.some(
        (root) =>
          root.device === identity.device && under(identity.path, root.path),
      ),
    recheck: async () => {
      for (const [file, before] of absent) {
        try {
          await io.entry(file);
        } catch (error) {
          if (!missing(error)) throw error;
          if (!equal(before.entry, await io.entry(before.parent)))
            throw new Error(
              `Linux target ancestor changed: path=${JSON.stringify(file)}`,
            );
          continue;
        }
        throw new Error(`Linux target appeared: path=${JSON.stringify(file)}`);
      }
      for (const [file, entry] of nodes) {
        if (!equal(entry, await io.entry(file)))
          throw new Error(`Linux target changed: path=${JSON.stringify(file)}`);
        const children = directories.get(file);
        if (
          children &&
          JSON.stringify(children) !== JSON.stringify(await names(file))
        )
          throw new Error(
            `Linux target directory changed: path=${JSON.stringify(file)}`,
          );
      }
    },
  };
}
