import path from 'node:path';

export interface LinuxColdPathIdentity {
  /** Mountinfo superblock major:minor, not stat st_dev. */
  readonly device: string;
  readonly path: string;
}
interface LinuxColdPathMapper {
  (file: string): LinuxColdPathIdentity;
  readonly hasMount: (mountId: string) => boolean;
  readonly reference: (
    file: string,
    statDevice: string,
    mountId: string,
  ) => LinuxColdPathIdentity;
  readonly affected: (root: string) => readonly LinuxColdPathIdentity[];
  readonly mapping: (
    file: string,
    device: string,
    statDevice: string,
  ) => readonly LinuxColdPathIdentity[];
}
interface Mount {
  readonly id: string;
  readonly parentId: string;
  readonly order: number;
  readonly point: string;
  readonly root: string | null;
  readonly device: string;
  readonly filesystem: string;
}

export function classifyLinuxColdTarget(
  target: string,
): 'path' | 'kernel-object' | 'unrecognized' {
  if (target.startsWith('/')) return 'path';
  if (
    /^(socket|pipe|mnt|net|pid|pid_for_children|user|uts|ipc|cgroup|time|time_for_children):\[\d+\]$/.test(
      target,
    ) ||
    /^anon_inode:.+$/.test(target)
  )
    return 'kernel-object';
  return 'unrecognized';
}

function absolute(file: string): string {
  if (
    !file.startsWith('/') ||
    file.includes('\\') ||
    /[\0\ufffd\ud800-\udfff]/u.test(file) ||
    file.endsWith(' (deleted)') ||
    path.posix.normalize(file) !== file ||
    (file !== '/' && file.endsWith('/'))
  )
    throw new Error(`Unmappable Linux cold path: path=${JSON.stringify(file)}`);
  return file;
}
function decode(file: string): string {
  if (/\\(?!040|011|012|134)/.test(file))
    throw new Error(`Undecodable mount path: path=${JSON.stringify(file)}`);
  return file.replace(/\\(040|011|012|134)/g, (_all, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}
function under(file: string, root: string): boolean {
  return file === root || file.startsWith(root === '/' ? '/' : `${root}/`);
}

/** Same-namespace filesystem coordinates; realpath alone cannot collapse bind mounts. */
export function createLinuxColdPathMapper(
  mountInfo: string,
): LinuxColdPathMapper {
  if (!mountInfo.endsWith('\n') || mountInfo.length > 32 * 1024 * 1024)
    throw new Error('Incomplete Linux mountinfo: path="/proc/self/mountinfo"');
  const mounts: Mount[] = [];
  const ids = new Set<string>();
  const points = new Set<string>();
  for (const line of mountInfo.slice(0, -1).split('\n')) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    const [id = '', parent = '', device = '', root = '', point = ''] = fields;
    if (
      separator < 6 ||
      fields.length !== separator + 4 ||
      fields.some((field) => !field || /[\s\0]/.test(field)) ||
      !/^[1-9]\d*$/.test(id) ||
      !/^\d+$/.test(parent) ||
      !/^\d+:\d+$/.test(device) ||
      ids.has(id)
    )
      throw new Error(
        `Malformed Linux mountinfo: path=${JSON.stringify(line)}`,
      );
    ids.add(id);
    const decoded = absolute(decode(point));
    const decodedRoot = decode(root);
    points.add(decoded);
    mounts.push({
      id,
      parentId: parent,
      order: mounts.length,
      point: decoded,
      // nsfs bind mounts expose namespace handles, not filesystem subtrees.
      root:
        classifyLinuxColdTarget(decodedRoot) === 'kernel-object'
          ? null
          : absolute(decodedRoot),
      device: device
        .split(':')
        .map((part) => BigInt(part).toString())
        .join(':'),
      filesystem: fields[separator + 1] ?? '',
    });
  }
  const byId = new Map(mounts.map((mount) => [mount.id, mount]));
  const anchored = new Map<string, boolean>();
  function hasRoot(mount: Mount): boolean {
    const pending: Mount[] = [];
    const seen = new Set<string>();
    let current = mount;
    let valid: boolean;
    for (;;) {
      const cached = anchored.get(current.id);
      if (cached !== undefined) {
        valid = cached;
        break;
      }
      if (seen.has(current.id)) {
        valid = false;
        break;
      }
      seen.add(current.id);
      pending.push(current);
      const parent = byId.get(current.parentId);
      if (!parent) {
        valid = current.point === '/';
        break;
      }
      if (!under(current.point, parent.point)) {
        valid = false;
        break;
      }
      current = parent;
    }
    for (const entry of pending) anchored.set(entry.id, valid);
    return valid;
  }
  const unresolved = mounts.filter((mount) => !hasRoot(mount));
  const roots = mounts.filter(
    (mount) => mount.point === '/' && !byId.has(mount.parentId),
  );
  const children = new Map<string, Mount[]>();
  for (const mount of mounts) {
    const siblings = children.get(mount.parentId) ?? [];
    siblings.push(mount);
    children.set(mount.parentId, siblings);
  }
  for (const siblings of children.values()) {
    // Enter a covering ancestor first; later same-point siblings cover earlier ones.
    siblings.sort(
      (left, right) =>
        left.point.length - right.point.length || right.order - left.order,
    );
  }
  function visible(file: string): Mount {
    absolute(file);
    const unknown = unresolved.find((mount) => under(file, mount.point));
    if (unknown || roots.some((root) => root.parentId !== roots[0]?.parentId))
      throw new Error(
        `Undecidable Linux mount visibility: path=${JSON.stringify(file)} mount=${JSON.stringify(unknown?.point ?? '/')}`,
      );
    const root = roots[roots.length - 1];
    if (!root)
      throw new Error(
        `No Linux mount for cold path: path=${JSON.stringify(file)}`,
      );
    let current: Mount = root;
    for (;;) {
      if (current.root === null) return current;
      const child: Mount | undefined = children
        .get(current.id)
        ?.find((mount) => under(file, mount.point));
      if (!child) return current;
      current = child;
    }
  }
  function coordinate(mount: Mount, file: string): LinuxColdPathIdentity {
    if (mount.root === null)
      throw new Error(
        `Kernel object mount cannot map a filesystem path: path=${JSON.stringify(file)} mount=${JSON.stringify(mount.point)}`,
      );
    const relative = file.slice(mount.point === '/' ? 1 : mount.point.length);
    return {
      device: mount.device,
      path: path.posix.join(mount.root, relative),
    };
  }
  const mapPath = (file: string): LinuxColdPathIdentity =>
    coordinate(visible(file), file);
  return Object.assign(mapPath, {
    hasMount: (mountId: string): boolean => byId.has(mountId),
    reference: (
      file: string,
      statDevice: string,
      mountId: string,
    ): LinuxColdPathIdentity => {
      absolute(file);
      const mount = byId.get(mountId);
      if (
        !mount ||
        !hasRoot(mount) ||
        !under(file, mount.point) ||
        (mount.filesystem !== 'btrfs' && mount.device !== statDevice)
      )
        throw new Error(
          `Unresolved Linux reference mount: path=${JSON.stringify(file)} mount=${mountId}`,
        );
      return coordinate(mount, file);
    },
    mapping: (
      file: string,
      device: string,
      statDevice: string,
    ): readonly LinuxColdPathIdentity[] => {
      const mount = visible(file);
      if (
        mount.device !== device ||
        (mount.filesystem !== 'btrfs' && statDevice !== device)
      )
        throw new Error(
          `Linux mapping no longer names the observed object: path=${JSON.stringify(file)}`,
        );
      const result = [coordinate(mount, file)];
      if (mount.filesystem !== 'btrfs') return result;
      // maps has no mount ID; per-subvolume inodes cannot disambiguate covered positions.
      for (const entry of mounts) {
        if (entry.device !== device || !under(file, entry.point)) continue;
        const candidate = coordinate(entry, file);
        if (!result.some((identity) => identity.path === candidate.path))
          result.push(candidate);
      }
      return result;
    },
    affected: (root: string): readonly LinuxColdPathIdentity[] => {
      const result = [mapPath(root)];
      for (const point of points) {
        if (point === root || !under(point, root)) continue;
        const mount = visible(point);
        if (mount.point === point) result.push(coordinate(mount, point));
      }
      return result;
    },
  });
}
