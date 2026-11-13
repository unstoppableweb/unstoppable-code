import { isUtf8 } from 'node:buffer';
import {
  lstat,
  open,
  opendir,
  readFile,
  readlink,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { hostPlatformOperatingSystem } from '../platform-services';

import type { NativeColdProcess } from './types';
import {
  classifyLinuxColdTarget,
  createLinuxColdPathMapper,
  type LinuxColdPathIdentity,
} from './linux-mounts';

import {
  linuxColdMembership,
  linuxColdDevice,
  type LinuxColdTreeEntry,
} from './linux-membership';

interface LinuxFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Test seam only: installed observation always uses the real /proc mount. */
export interface LinuxColdIO {
  readonly pin: (
    path: string,
  ) => Promise<LinuxFileIdentity & { readonly mountId: string }>;
  readonly entry: (path: string) => Promise<LinuxColdTreeEntry>;
  readonly text: (path: string) => Promise<string>;
  readonly link: (path: string) => Promise<string>;
  readonly list: (path: string) => Promise<readonly string[]>;
  readonly identity: (path: string) => Promise<LinuxFileIdentity>;
}
const nativeIO: LinuxColdIO = {
  pin: async (file) => {
    // Linux O_PATH pins the object without opening its contents or a device driver.
    const handle = await open(file, 0x200000);
    try {
      const identity = await handle.stat({ bigint: true });
      const info = await nativeIO.text(`/proc/self/fdinfo/${handle.fd}`);
      const rows = info.split('\n').filter((row) => row.startsWith('mnt_id:'));
      const mountId =
        rows.length === 1
          ? /^mnt_id:\s+(0|[1-9]\d*)$/.exec(rows[0] ?? '')?.[1]
          : undefined;
      // Internal shmem may report mount 0; only disjoint memfd references bypass mountinfo.
      if (mountId === undefined)
        throw new Error('Incomplete proc reference mount identity');
      return { dev: identity.dev, ino: identity.ino, mountId };
    } finally {
      await handle.close();
    }
  },
  entry: (file) => lstat(file, { bigint: true }),
  identity: (file) => stat(file, { bigint: true }),
  text: async (path): Promise<string> => {
    const bytes = await readFile(path, { signal: AbortSignal.timeout(4000) });
    if (bytes.length > 32 * 1024 * 1024 || !isUtf8(bytes))
      throw new Error('Incomplete proc text');
    return bytes.toString('utf8');
  },
  link: async (path): Promise<string> => {
    const bytes = await readlink(path, { encoding: 'buffer' });
    if (!isUtf8(bytes)) throw new Error('Unrepresentable proc path');
    return bytes.toString('utf8');
  },
  list: async (path): Promise<readonly string[]> => {
    const names: string[] = [];
    const directory = await opendir(path);
    for await (const entry of directory) {
      // Replacement characters cannot establish lossless filename evidence.
      if (entry.name.includes('\ufffd') || names.length >= 100_000)
        throw new Error('Incomplete proc or installation directory');
      names.push(entry.name);
    }
    return names;
  },
};

function boundedIO(io: LinuxColdIO): LinuxColdIO {
  const deadline = performance.now() + 30_000;
  async function bounded<T>(read: () => Promise<T>): Promise<T> {
    if (performance.now() >= deadline)
      throw new Error('Proc observation deadline exceeded');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Proc observation deadline exceeded')),
            Math.min(4000, deadline - performance.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    pin: (file) => bounded(() => io.pin(file)),
    entry: (file) => bounded(() => io.entry(file)),
    text: (file) => bounded(() => io.text(file)),
    link: (file) => bounded(() => io.link(file)),
    list: (file) => bounded(() => io.list(file)),
    identity: (file) => bounded(() => io.identity(file)),
  };
}

interface Stat {
  readonly comm: string;
  readonly parentPid: number;
  readonly startIdentity: string;
  readonly dead: boolean;
}
type LinuxNamespace = 'mnt' | 'user' | 'pid';
export interface LinuxColdRefusal {
  readonly pid: number | null;
  readonly comm: string | null;
  readonly executable: string | null;
  readonly uids: readonly number[] | null;
  readonly executableReadFailure?: string | null;
  readonly dumpable: '0' | '1' | '2' | 'not-exported' | 'unavailable';
  readonly reason: string;
  readonly differingNamespaces: readonly LinuxNamespace[];
  readonly cgroup: string | null;
  readonly cause: unknown;
}

class LinuxColdProcessRaceError extends Error {}
class LinuxColdProcessChurnError extends Error {
  declare readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}
class LinuxColdProcessEvidenceError extends Error {
  declare readonly cause: unknown;

  constructor(cause: unknown) {
    super(inspectionFailure(cause));
    this.cause = cause;
  }
}

function hasCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    cause.code === code
  );
}
function processChurn(cause: unknown): boolean {
  return cause instanceof LinuxColdProcessChurnError;
}

function churnCandidate(cause: unknown): boolean {
  return (
    cause instanceof LinuxColdProcessRaceError ||
    cause instanceof LinuxColdNamespaceRaceError ||
    hasCode(cause, 'ENOENT') ||
    hasCode(cause, 'ESRCH')
  );
}

async function classifyChurn(
  io: LinuxColdIO,
  pid: number,
  boot: string,
  startIdentity: string | undefined,
  cause: unknown,
  thread?: string,
): Promise<unknown> {
  if (!churnCandidate(cause)) return cause;
  // Seal failed lifecycle checks: a later catch or diagnostic exit cannot forgive evidence.
  const refusal = new LinuxColdProcessEvidenceError(cause);
  const churn = (): Error =>
    new LinuxColdProcessChurnError(inspectionFailure(cause), cause);
  try {
    await io.identity(`/proc/${pid}`);
  } catch (error) {
    return hasCode(error, 'ENOENT') ? churn() : refusal;
  }
  try {
    const current = parseStat(await io.text(`/proc/${pid}/stat`), pid, boot);
    if (startIdentity && current.startIdentity !== startIdentity)
      return churn();
    if (thread && !current.dead) {
      try {
        await io.identity(thread);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) return refusal;
        // A missing target path is not churn: prove the task gone and its process still live.
        try {
          await io.identity(`/proc/${pid}`);
        } catch (error) {
          return hasCode(error, 'ENOENT') ? churn() : refusal;
        }
        const after = parseStat(await io.text(`/proc/${pid}/stat`), pid, boot);
        if (!after.dead || after.startIdentity !== current.startIdentity)
          return churn();
      }
    }
  } catch {
    // An unreadable recheck cannot establish that the inspected instance disappeared.
  }
  return refusal;
}

class LinuxNamespaceInspectionError extends Error {
  constructor(readonly differingNamespaces: readonly LinuxNamespace[]) {
    super('Process namespace cannot be inspected in host scope');
  }
}

class LinuxColdNamespaceRaceError extends LinuxNamespaceInspectionError {}

export class LinuxColdInspectionError extends Error {
  override readonly name = 'LinuxColdInspectionError';
  readonly code = 'inspection-incomplete';
  readonly refusals: readonly LinuxColdRefusal[];
  readonly failure: unknown;
  constructor(
    refusals: readonly LinuxColdRefusal[],
    /** Diagnostic classifications only; never a complete cold snapshot. */
    readonly classifiedProcesses: readonly NativeColdProcess[] = [],
  ) {
    const sorted = [...refusals].sort(
      (left, right) => (left.pid ?? Infinity) - (right.pid ?? Infinity),
    );
    super(
      `Incomplete Linux cold inspection: ${sorted
        .map(
          (row) =>
            `pid=${row.pid ?? 'unknown'} comm=${JSON.stringify(row.comm)} exe=${JSON.stringify(row.executable)} uids(real:effective:saved:fs)=${row.uids?.join(':') ?? 'unavailable'} exeReadFailure=${JSON.stringify(row.executableReadFailure ?? null)} dumpable=${row.dumpable} reason=${JSON.stringify(row.reason)} namespaces=${JSON.stringify(row.differingNamespaces)} cgroup=${JSON.stringify(row.cgroup)}`,
        )
        .join('; ')}`,
    );
    this.refusals = sorted;
    this.failure = sorted[0]?.cause;
  }
  get pid(): number | null {
    return this.refusals[0]?.pid ?? null;
  }
  get comm(): string | null {
    return this.refusals[0]?.comm ?? null;
  }
  get uids(): readonly number[] | null {
    return this.refusals[0]?.uids ?? null;
  }
  get dumpable(): LinuxColdRefusal['dumpable'] {
    return this.refusals[0]?.dumpable ?? 'unavailable';
  }
}

function inspectionFailure(cause: unknown): string {
  // Native errors can cross the Jest/VM realm without instanceof Error identity.
  if (typeof cause === 'object' && cause !== null) {
    if ('message' in cause && typeof cause.message === 'string')
      return cause.message;
    if ('code' in cause && typeof cause.code === 'string')
      return `${cause.code}: ${'path' in cause && typeof cause.path === 'string' ? cause.path : 'proc read denied'}`;
  }
  return 'Unknown inspection failure';
}

async function diagnosed<T>(
  io: LinuxColdIO,
  read: () => Promise<T>,
  targetPid: number | null = null,
): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    if (cause instanceof LinuxColdInspectionError) throw cause;
    const evidence =
      cause instanceof LinuxColdProcessEvidenceError ? cause.cause : cause;
    const failedPath =
      typeof evidence === 'object' &&
      evidence !== null &&
      'path' in evidence &&
      typeof evidence.path === 'string'
        ? evidence.path
        : '';
    const match = /^\/proc\/([1-9]\d*)\//.exec(failedPath);
    // A referenced pathname may belong to another PID, not the process being inspected.
    const pid = targetPid ?? (match ? Number(match[1]) : null);
    let comm: string | null = null;
    let executable: string | null = null;
    let executableReadFailure: string | null = null;
    let uids: readonly number[] | null = null;
    let dumpable: LinuxColdRefusal['dumpable'] = 'unavailable';
    let cgroup: string | null = null;
    if (pid !== null) {
      try {
        executable = await io.link(`/proc/${pid}/exe`);
      } catch (error) {
        executableReadFailure = inspectionFailure(error);
      }
      try {
        const stat = await io.text(`/proc/${pid}/stat`);
        const end = stat.lastIndexOf(')');
        if (stat.startsWith(`${pid} (`) && end > 0)
          comm = stat.slice(stat.indexOf('(') + 1, end);
      } catch {
        /* Racy or restricted diagnostics never establish absence. */
      }
      try {
        const status = await io.text(`/proc/${pid}/status`);
        uids = principal(status);
        const value = /^Dumpable:\s+([012])\s*$/m.exec(status)?.[1];
        // Modern kernels no longer expose Dumpable in /proc/<pid>/status.
        dumpable =
          value === '0' || value === '1' || value === '2'
            ? value
            : 'not-exported';
      } catch {
        /* Preserve the original refusal if diagnostic status is unavailable. */
      }
      try {
        cgroup = await io.text(`/proc/${pid}/cgroup`);
      } catch {
        /* Cgroup diagnostics cannot make a restricted process inspectable. */
      }
    }
    throw new LinuxColdInspectionError([
      {
        pid,
        comm,
        executable,
        uids,
        executableReadFailure,
        dumpable,
        cgroup,
        cause,
        reason: inspectionFailure(cause),
        differingNamespaces:
          evidence instanceof LinuxNamespaceInspectionError
            ? evidence.differingNamespaces
            : [],
      },
    ]);
  }
}
function parseStat(text: string, pid: number, boot: string): Stat {
  const close = text.lastIndexOf(')');
  const fields = text
    .slice(close + 2)
    .trimEnd()
    .split(' ');
  const [state = '', parent = '', start = ''] = [
    fields[0],
    fields[1],
    fields[19],
  ];
  if (
    !text.startsWith(`${pid} (`) ||
    text[close + 1] !== ' ' ||
    !/^[RSDZTWtXxKPI]$/.test(state) ||
    !/^(0|[1-9]\d*)$/.test(parent) ||
    !Number.isSafeInteger(Number(parent)) ||
    !/^(0|[1-9]\d{0,19})$/.test(start)
  )
    throw new Error('Malformed proc identity');
  return {
    comm: text.slice(text.indexOf('(') + 1, close),
    parentPid: Number(parent),
    startIdentity: `linux:v1:${pid}:${boot}:${start}`,
    dead: /^[ZXx]$/.test(state),
  };
}

function isUninspectableUserManager(
  stat: Stat,
  ids: readonly number[],
  cgroup: string,
  uid: number,
): boolean {
  return (
    !stat.dead &&
    stat.comm === 'systemd' &&
    stat.parentPid === 1 &&
    ids.length === 4 &&
    ids.every((id) => id === uid) &&
    cgroup ===
      `0::/user.slice/user-${uid}.slice/user@${uid}.service/init.scope\n`
  );
}

async function userManager(
  pid: number,
  uid: number,
  boot: string,
  io: LinuxColdIO,
): Promise<NativeColdProcess | null> {
  try {
    const directory = `/proc/${pid}`;
    const before = parseStat(await io.text(`${directory}/stat`), pid, boot);
    if (
      !isUninspectableUserManager(
        before,
        principal(await io.text(`${directory}/status`)),
        await io.text(`${directory}/cgroup`),
        uid,
      )
    )
      return null;
    const after = parseStat(await io.text(`${directory}/stat`), pid, boot);
    if (
      before.startIdentity !== after.startIdentity ||
      !isUninspectableUserManager(
        after,
        principal(await io.text(`${directory}/status`)),
        await io.text(`${directory}/cgroup`),
        uid,
      )
    )
      return null;
    return {
      pid,
      parentPid: 1,
      startIdentity: before.startIdentity,
      scope: 'linux-user-manager',
      executable: before.comm,
      paths: [],
    };
  } catch {
    return null;
  }
}

async function userManagerPam(
  pid: number,
  uid: number,
  boot: string,
  io: LinuxColdIO,
  managers: ReadonlyMap<number, NativeColdProcess>,
): Promise<NativeColdProcess | null> {
  try {
    const directory = `/proc/${pid}`;
    const before = parseStat(await io.text(`${directory}/stat`), pid, boot);
    const manager = managers.get(before.parentPid);
    if (!manager || before.dead || before.comm !== '(sd-pam)') return null;
    const expected = `0::/user.slice/user-${uid}.slice/user@${uid}.service/init.scope\n`;
    const qualifies = async (stat: Stat): Promise<boolean> =>
      !stat.dead &&
      stat.comm === '(sd-pam)' &&
      stat.parentPid === manager.pid &&
      stat.startIdentity === before.startIdentity &&
      principal(await io.text(`${directory}/status`)).every(
        (id) => id === uid,
      ) &&
      (await io.text(`${directory}/cgroup`)) === expected &&
      (await userManager(manager.pid, uid, boot, io))?.startIdentity ===
        manager.startIdentity;
    if (
      !(await qualifies(before)) ||
      !(await qualifies(
        parseStat(await io.text(`${directory}/stat`), pid, boot),
      ))
    )
      return null;
    return {
      pid,
      parentPid: manager.pid,
      startIdentity: before.startIdentity,
      scope: 'linux-user-manager',
      executable: before.comm,
      paths: [],
    };
  } catch {
    return null;
  }
}

function deniedProcessRead(cause: unknown, pid: number): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause.code === 'EACCES' || cause.code === 'EPERM') &&
    'path' in cause &&
    typeof cause.path === 'string' &&
    cause.path.startsWith(`/proc/${pid}/`)
  );
}
function principal(text: string): readonly number[] {
  const rows = text.split('\n').filter((line) => line.startsWith('Uid:'));
  const row = rows[0];
  const match = row && /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(row);
  if (rows.length !== 1 || !match) throw new Error('Incomplete proc principal');
  const ids = match.slice(1).map(Number);
  if (!ids.every(Number.isSafeInteger))
    throw new Error('Invalid proc principal');
  return ids;
}
function isSameUserProcess(uids: readonly number[], uid: number): boolean {
  return uids.includes(uid);
}
function same(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, at) => value === right[at])
  );
}
async function entries(
  io: LinuxColdIO,
  path: string,
): Promise<readonly string[]> {
  const names = await io.list(path);
  if (names.length > 100_000 || new Set(names).size !== names.length)
    throw new Error('Incomplete proc directory');
  return [...names].sort();
}
function absolute(target: string): string {
  if (!target.startsWith('/')) throw new Error('Unrecognized proc path');
  return target.replace(/ \(deleted\)$/, '');
}
async function crashHelperInstallation(
  io: LinuxColdIO,
  image: string,
  root = '',
): Promise<readonly string[] | undefined> {
  const executable = absolute(image);
  if (
    !['chrome_crashpad_handler', 'crashpad_handler'].includes(
      path.posix.basename(executable),
    )
  )
    return undefined;
  if (image.endsWith(' (deleted)'))
    throw new Error(
      `Crash helper executable is deleted: exe=${JSON.stringify(image)}`,
    );
  const names = await entries(io, `${root}${path.posix.dirname(executable)}`);
  if (!names.includes(path.posix.basename(executable)))
    throw new Error('Crash helper missing from executable directory');
  return names;
}
function descriptor(target: string): string | null {
  switch (classifyLinuxColdTarget(target)) {
    case 'path':
      return absolute(target);
    case 'kernel-object':
      return null;
    case 'unrecognized':
      throw new Error('Unrecognized proc descriptor');
  }
}
function linuxDevice(dev: bigint): string {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return `${major}:${minor}`;
}
async function assertPathIdentity(
  io: LinuxColdIO,
  reference: string,
  file: string,
): Promise<void> {
  const pinned = await io.identity(reference);
  const current = await io.identity(file);
  if (pinned.dev !== current.dev || pinned.ino !== current.ino)
    throw new Error(
      `Linux path no longer names the observed object: path=${JSON.stringify(file)}`,
    );
}
function mappedFiles(text: string): readonly {
  readonly file: string;
  readonly device: string;
  readonly inode: bigint;
}[] {
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const match =
        /^[a-f0-9]+-[a-f0-9]+ [r-][w-][x-][ps] [a-f0-9]+ ([a-f0-9]+):([a-f0-9]+) (\d+)(?:\s+(.*))?$/.exec(
          line,
        );
      if (!match) throw new Error('Incomplete proc mappings');
      const name = match[4] ?? '';
      if (
        !name ||
        name.startsWith('anon_inode:') ||
        (name.startsWith('[') && name.endsWith(']'))
      )
        return [];
      if (!name.startsWith('/') && match[3] === '0') return [];
      if (!name.startsWith('/'))
        throw new Error(
          `Unrecognized proc mapping (inode=${match[3]}, first=${name.charCodeAt(0)}, length=${name.length})`,
        );
      // Escaped maps names are ambiguous with literal backslashes; mapping refuses them.
      return [
        {
          file: name,
          device: `${BigInt(`0x${match[1]}`)}:${BigInt(`0x${match[2]}`)}`,
          inode: BigInt(match[3] ?? ''),
        },
      ];
    });
}
async function bootId(io: LinuxColdIO): Promise<string> {
  const boot = (await io.text('/proc/sys/kernel/random/boot_id')).trimEnd();
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(boot))
    throw new Error('Incomplete proc boot identity');
  return boot.toLowerCase();
}

async function assertHostNamespace(
  io: LinuxColdIO,
  thread: string,
  allowPrivateMount = false,
): Promise<string> {
  const differingNamespaces: LinuxNamespace[] = [];
  const namespaces: readonly LinuxNamespace[] = ['mnt', 'user', 'pid'];
  const observed: string[] = [];
  for (const namespace of namespaces) {
    const value = await io.link(`${thread}/ns/${namespace}`);
    observed.push(value);
    if (value !== (await io.link(`/proc/self/ns/${namespace}`)))
      differingNamespaces.push(namespace);
  }
  if (differingNamespaces.some((kind) => kind !== 'mnt' || !allowPrivateMount))
    throw new LinuxNamespaceInspectionError(differingNamespaces);
  if ((await io.link(`${thread}/root`)) !== '/')
    throw new Error('Process root cannot be inspected in host scope');
  return JSON.stringify(observed);
}

type LinuxMembership = Awaited<ReturnType<typeof linuxColdMembership>>;

async function observeRootBoundThread(
  io: LinuxColdIO,
  directory: string,
  thread: string,
  membership: LinuxMembership,
  hostMapper: ReturnType<typeof createLinuxColdPathMapper>,
  inspectOpenFiles: boolean,
): Promise<{
  readonly executable: string;
  readonly installation: readonly string[] | undefined;
  readonly affected: boolean;
}> {
  const mounts = await io.text(`${thread}/mountinfo`);
  const mapper = createLinuxColdPathMapper(mounts);
  const root = await io.identity(`${thread}/root`);
  let affected = false;
  const references = new Map<
    string,
    {
      readonly target: string;
      readonly identity:
        | (LinuxFileIdentity & { readonly mountId: string })
        | null;
    }
  >();
  const mappingReferences = new Map<
    string,
    LinuxFileIdentity & { readonly mountId: string }
  >();
  async function mappingReference(
    file: string,
    device: string,
    inode: bigint,
    rawAddress: string,
  ): Promise<void> {
    const [start = '', end = ''] = rawAddress.split('-');
    const address = `${BigInt(`0x${start}`).toString(16)}-${BigInt(`0x${end}`).toString(16)}`;
    // map_files exists only at process level, including for non-main threads.
    const referencePath = `${directory}/map_files/${address}`;
    const pinned = await io.pin(referencePath);
    mappingReferences.set(referencePath, pinned);
    if (pinned.ino !== inode) throw new Error('Proc mapping identity changed');
    const referenceMapper = mapper.hasMount(pinned.mountId)
      ? mapper
      : hostMapper;
    const coordinate = referenceMapper.reference(
      file,
      linuxColdDevice(pinned.dev),
      pinned.mountId,
    );
    if (coordinate.device !== device)
      throw new Error('Proc mapping device changed');
    affected ||= membership.object(pinned) || membership.coordinate(coordinate);
  }
  async function reference(name: string): Promise<string> {
    const target = await io.link(name);
    if (!descriptor(target)) {
      references.set(name, { target, identity: null });
      return target;
    }
    const identity = await io.pin(name);
    references.set(name, { target, identity });
    affected ||= membership.object(identity);
    // Internal shmem has no filesystem pathname; a disjoint device cannot belong to the target trees.
    if (
      target.startsWith('/memfd:') &&
      target.endsWith(' (deleted)') &&
      !membership.objectDevice(identity.dev)
    )
      return target;
    const file = absolute(target);
    // A deleted dentry has no pathname stat; its live proc reference and mount coordinates remain evidence.
    // Snap children can inherit descriptors from host mounts absent in their new namespace.
    const inherited = !mapper.hasMount(identity.mountId);
    const coordinate = (inherited ? hostMapper : mapper).reference(
      file,
      linuxColdDevice(identity.dev),
      identity.mountId,
    );
    affected ||= membership.coordinate(coordinate);
    if (!target.endsWith(' (deleted)')) {
      const current = await io.identity(
        inherited ? file : `${thread}/root${file}`,
      );
      if (identity.dev !== current.dev || identity.ino !== current.ino)
        throw new Error(
          `Linux path no longer names the observed object: path=${JSON.stringify(file)}`,
        );
    }
    return target;
  }
  const image = await reference(`${thread}/exe`);
  if (!image.startsWith('/')) throw new Error('Unrecognized proc executable');
  const installation = await crashHelperInstallation(
    io,
    image,
    `${thread}/root`,
  );
  const cwd = await reference(`${thread}/cwd`);
  if (!cwd.startsWith('/')) throw new Error('Unrecognized proc cwd');
  const fds = inspectOpenFiles ? await entries(io, `${thread}/fd`) : [];
  for (const fd of fds) {
    if (!/^\d+$/.test(fd)) throw new Error('Malformed proc descriptor');
    await reference(`${thread}/fd/${fd}`);
  }
  const maps = inspectOpenFiles ? await io.text(`${thread}/maps`) : '';
  if (maps && !maps.endsWith('\n')) throw new Error('Incomplete proc mappings');
  for (const line of maps.split('\n').filter(Boolean)) {
    const match =
      /^[a-f0-9]+-[a-f0-9]+ [r-][w-][x-][ps] [a-f0-9]+ ([a-f0-9]+):([a-f0-9]+) (\d+)(?:\s+(.*))?$/.exec(
        line,
      );
    if (!match) throw new Error('Incomplete proc mappings');
    const device = `${BigInt(`0x${match[1]}`)}:${BigInt(`0x${match[2]}`)}`;
    const inode = BigInt(match[3] ?? '');
    const file = match[4] ?? '';
    if (inode === 0n) {
      if (device !== '0:0' || file.startsWith('/'))
        throw new Error('Incomplete anonymous mapping identity');
      continue;
    }
    if (!file.startsWith('/')) {
      if (
        file &&
        !file.startsWith('anon_inode:') &&
        !(file.startsWith('[') && file.endsWith(']'))
      )
        throw new Error('Unrecognized proc mapping');
      // Pathless collisions remain ambiguous; btrfs superblock/inode is not a file identity.
      affected ||= membership.mapping(device, inode);
      continue;
    }
    const name = absolute(file);
    if (file.endsWith(' (deleted)')) {
      // Disjoint superblocks cannot hold target objects, including anonymous shmem.
      if (!membership.mappingDevice(device)) continue;
      await mappingReference(name, device, inode, line.split(' ')[0] ?? '');
    } else {
      const current = await io.identity(`${thread}/root${name}`);
      if (current.ino !== inode)
        throw new Error(
          `Linux mapping no longer names the observed object: path=${JSON.stringify(file)}`,
        );
      const objectAffected = membership.object(current);
      const candidates = mapper.mapping(
        name,
        device,
        linuxColdDevice(current.dev),
      );
      const coordinateAffected = candidates.some(membership.coordinate);
      affected ||= objectAffected || coordinateAffected;
      // Btrfs pathname stat can name a covering subvolume with the same inode.
      if (
        !objectAffected &&
        !coordinateAffected &&
        membership.mapping(device, inode)
      )
        await mappingReference(name, device, inode, line.split(' ')[0] ?? '');
    }
  }
  if (inspectOpenFiles && maps !== (await io.text(`${thread}/maps`)))
    throw new LinuxColdProcessRaceError('Proc mappings changed');
  if (inspectOpenFiles && !same(fds, await entries(io, `${thread}/fd`)))
    throw new LinuxColdProcessRaceError('Proc descriptor set changed');
  for (const [name, previous] of mappingReferences) {
    const current = await io.pin(name);
    if (
      current.mountId !== previous.mountId ||
      current.dev !== previous.dev ||
      current.ino !== previous.ino
    )
      throw new LinuxColdProcessRaceError('Proc mapping reference changed');
  }
  for (const [name, previous] of references) {
    if ((await io.link(name)) !== previous.target)
      throw new LinuxColdProcessRaceError('Proc reference changed');
    if (previous.identity) {
      const current = await io.pin(name);
      if (
        current.mountId !== previous.identity.mountId ||
        current.dev !== previous.identity.dev ||
        current.ino !== previous.identity.ino
      )
        throw new LinuxColdProcessRaceError('Proc reference identity changed');
    }
  }
  const afterRoot = await io.identity(`${thread}/root`);
  if (
    root.dev !== afterRoot.dev ||
    root.ino !== afterRoot.ino ||
    mounts !== (await io.text(`${thread}/mountinfo`))
  )
    throw new LinuxColdProcessRaceError(
      'Process mount table or root changed during observation',
    );
  if (
    installation &&
    !same(
      installation,
      (await crashHelperInstallation(io, image, `${thread}/root`)) ?? [],
    )
  )
    throw new Error(
      'Crash helper executable directory changed during observation',
    );
  return { executable: absolute(image), installation, affected };
}

async function observe(
  pid: number,
  boot: string,
  io: LinuxColdIO,
  selfPid: number,
  mountInfo: string,
  mapPath: ReturnType<typeof createLinuxColdPathMapper>,
  membership?: LinuxMembership,
): Promise<NativeColdProcess> {
  let before: Stat | undefined;
  try {
    before = parseStat(await io.text(`/proc/${pid}/stat`), pid, boot);
    return await observeProcess(
      pid,
      boot,
      io,
      selfPid,
      mountInfo,
      mapPath,
      before,
      membership,
    );
  } catch (cause) {
    throw await classifyChurn(io, pid, boot, before?.startIdentity, cause);
  }
}

async function observeProcess(
  pid: number,
  boot: string,
  io: LinuxColdIO,
  selfPid: number,
  mountInfo: string,
  mapPath: ReturnType<typeof createLinuxColdPathMapper>,
  before: Stat,
  membership?: LinuxMembership,
): Promise<NativeColdProcess> {
  const directory = `/proc/${pid}`;
  const uid = principal(await io.text(`${directory}/status`));
  const paths = new Set<string>();
  const mappingCandidates = new Map<string, LinuxColdPathIdentity>();
  function addPath(file: string): void {
    if (!paths.has(file)) {
      mapPath(file);
      paths.add(file);
    }
  }
  let privateAffected = false;
  let rootBoundObserved = false;
  let executableRoot: string | undefined;
  let executable: string | null = null;
  let executableDirectoryEntries: readonly string[] | undefined;
  const tasks = await entries(io, `${directory}/task`);
  if (
    !tasks.includes(String(pid)) ||
    tasks.some((task) => !/^[1-9]\d*$/.test(task))
  )
    throw new LinuxColdProcessRaceError('Incomplete proc threads');
  async function inspectThread(task: string): Promise<void> {
    const thread = `${directory}/task/${task}`;
    const started = parseStat(
      await io.text(`${thread}/stat`),
      Number(task),
      boot,
    );
    if (started.dead) return;
    const namespace = await assertHostNamespace(
      io,
      thread,
      Boolean(membership),
    );
    async function recheckNamespace(): Promise<void> {
      if (
        namespace !==
        (await assertHostNamespace(io, thread, Boolean(membership)))
      )
        throw new LinuxColdNamespaceRaceError(['mnt']);
    }
    try {
      if (membership) {
        const observed = await observeRootBoundThread(
          io,
          directory,
          thread,
          membership,
          mapPath,
          pid !== selfPid,
        );
        rootBoundObserved = true;
        privateAffected ||= observed.affected;
        executable = observed.executable;
        executableDirectoryEntries = observed.installation;
        executableRoot = `${thread}/root`;
        const finished = parseStat(
          await io.text(`${thread}/stat`),
          Number(task),
          boot,
        );
        if (
          finished.startIdentity !== started.startIdentity ||
          finished.dead ||
          finished.parentPid !== started.parentPid
        )
          throw new LinuxColdProcessRaceError(
            'Process instance changed during observation',
          );
        await recheckNamespace();
        return;
      }
      executableRoot = undefined;
      const image = await io.link(`${thread}/exe`);
      executable = absolute(image);
      const installation = await crashHelperInstallation(io, image);
      executableDirectoryEntries = installation;
      mapPath(image);
      await assertPathIdentity(io, `${thread}/exe`, image);
      const cwd = await io.link(`${thread}/cwd`);
      addPath(cwd);
      await assertPathIdentity(io, `${thread}/cwd`, cwd);
      if (pid !== selfPid) {
        const fds = await entries(io, `${thread}/fd`);
        const targets = new Map<string, string>();
        for (const fd of fds) {
          if (!/^\d+$/.test(fd)) throw new Error('Malformed proc descriptor');
          const target = await io.link(`${thread}/fd/${fd}`);
          targets.set(fd, target);
          const file = descriptor(target);
          if (file) {
            addPath(target);
            await assertPathIdentity(io, `${thread}/fd/${fd}`, target);
          }
        }
        // ELF segments repeat a pathname; validate every receipt against one stat per thread.
        const mappedIdentities = new Map<string, LinuxFileIdentity>();
        for (const mapped of mappedFiles(await io.text(`${thread}/maps`))) {
          addPath(mapped.file);
          let current = mappedIdentities.get(mapped.file);
          if (!current) {
            current = await io.identity(mapped.file);
            mappedIdentities.set(mapped.file, current);
          }
          // maps/mountinfo use superblock devices; btrfs stat uses subvolume devices.
          if (current.ino !== mapped.inode)
            throw new Error(
              `Linux mapping no longer names the observed object: path=${JSON.stringify(mapped.file)}`,
            );
          for (const candidate of mapPath.mapping(
            mapped.file,
            mapped.device,
            linuxDevice(current.dev),
          ))
            mappingCandidates.set(
              JSON.stringify([candidate.device, candidate.path]),
              candidate,
            );
        }
        if (!same(fds, await entries(io, `${thread}/fd`)))
          throw new LinuxColdProcessRaceError('Proc descriptor set changed');
        for (const [fd, target] of targets) {
          if ((await io.link(`${thread}/fd/${fd}`)) !== target)
            throw new Error('Proc descriptor changed');
        }
      }
      const finished = parseStat(
        await io.text(`${thread}/stat`),
        Number(task),
        boot,
      );
      if (
        finished.startIdentity !== started.startIdentity ||
        finished.dead ||
        (await io.link(`${thread}/exe`)) !== image ||
        (await io.link(`${thread}/cwd`)) !== cwd
      )
        throw new LinuxColdProcessRaceError(
          'Process instance changed during observation',
        );
      if (
        installation &&
        !same(installation, (await crashHelperInstallation(io, image)) ?? [])
      )
        throw new Error(
          'Crash helper executable directory changed during observation',
        );
    } catch (error) {
      const failure = await classifyChurn(
        io,
        pid,
        boot,
        before.startIdentity,
        error,
        thread,
      );
      try {
        await recheckNamespace();
      } catch (scopeError) {
        // Scope diagnostics must not turn non-churn evidence into retryable churn.
        if (membership && !processChurn(failure) && churnCandidate(scopeError))
          throw failure;
        throw scopeError;
      }
      throw failure;
    }
    await recheckNamespace();
  }
  for (const task of tasks) {
    try {
      await inspectThread(task);
    } catch (cause) {
      throw await classifyChurn(
        io,
        pid,
        boot,
        before.startIdentity,
        cause,
        `${directory}/task/${task}`,
      );
    }
  }
  const after = parseStat(await io.text(`${directory}/stat`), pid, boot);
  if (
    before.startIdentity !== after.startIdentity ||
    before.dead !== after.dead ||
    before.parentPid !== after.parentPid ||
    !same(tasks, await entries(io, `${directory}/task`)) ||
    uid.join(':') !== principal(await io.text(`${directory}/status`)).join(':')
  )
    throw new LinuxColdProcessRaceError(
      'Process instance or principal changed during observation',
    );
  return {
    pid,
    scope: 'same-user',
    comm: before.comm,
    linuxMountInfo: mountInfo,
    ...(rootBoundObserved && membership
      ? {
          linuxPrivateMountUse: {
            roots: membership.roots,
            affected: privateAffected,
          },
        }
      : {}),
    ...(executableRoot ? { linuxExecutableRoot: executableRoot } : {}),
    linuxMappingCandidates: [...mappingCandidates.values()],
    parentPid: before.parentPid,
    startIdentity: before.startIdentity,
    executable,
    ...(executableDirectoryEntries ? { executableDirectoryEntries } : {}),
    paths: [...paths],
  };
}

/** Target observation for native qualification, not complete cold admission. */
export async function observeLinuxColdProcess(
  pid: number,
  io?: LinuxColdIO,
  roots: readonly string[] = [],
): Promise<NativeColdProcess> {
  if (!io && hostPlatformOperatingSystem() !== 'linux')
    throw new Error('Linux proc required');
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error('Invalid proc PID');
  const operations = boundedIO(io ?? nativeIO);
  return diagnosed(
    operations,
    async () => {
      const mounts = await operations.text('/proc/self/mountinfo');
      const mapPath = createLinuxColdPathMapper(mounts);
      const membership = roots.length
        ? await linuxColdMembership(operations, roots, mapPath)
        : undefined;
      const row = await observe(
        pid,
        await bootId(operations),
        operations,
        process.pid,
        mounts,
        mapPath,
        membership,
      );
      await membership?.recheck();
      if (mounts !== (await operations.text('/proc/self/mountinfo')))
        throw new Error('Linux mountinfo changed: path="/proc/self/mountinfo"');
      return row;
    },
    pid,
  );
}

interface LinuxColdSnapshotOptions {
  readonly io?: LinuxColdIO;
  readonly uid?: number;
  readonly roots?: readonly string[];
}

/** q-46(c): bounded fresh snapshots for churn; live unreadable processes still refuse. */
export async function observeLinuxColdProcesses(
  options: LinuxColdSnapshotOptions = {},
): Promise<readonly NativeColdProcess[]> {
  if (!options.io && hostPlatformOperatingSystem() !== 'linux')
    throw new Error('Linux proc required');
  const io = boundedIO(options.io ?? nativeIO);
  for (let attempt = 0; ; attempt++) {
    try {
      return await observeLinuxColdProcessSnapshot(options, io);
    } catch (error) {
      if (
        !options.roots?.length ||
        attempt >= 2 ||
        !(error instanceof LinuxColdInspectionError) ||
        !error.refusals.every((row) => processChurn(row.cause))
      )
        throw error;
    }
  }
}

async function observeLinuxColdProcessSnapshot(
  options: LinuxColdSnapshotOptions,
  io: LinuxColdIO,
): Promise<readonly NativeColdProcess[]> {
  return diagnosed(
    io,
    async () => {
      const uid = options.uid ?? process.getuid?.();
      if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
        throw new Error('Linux principal required');
      const mounts = await io.text('/proc/self/mountinfo');
      const mapPath = createLinuxColdPathMapper(mounts);
      const membership = options.roots?.length
        ? await linuxColdMembership(io, options.roots, mapPath)
        : undefined;
      const proc = mounts
        .split('\n')
        .filter((line) => line.split(' ')[4] === '/proc');
      if (
        proc.length !== 1 ||
        !proc[0]?.includes(' - proc ') ||
        /(?:^|[, ])hidepid=(?!0(?:[, ]|$))/.test(proc[0])
      )
        throw new Error('Unrestricted host proc mount required');
      const boot = await bootId(io);
      const pids = (await entries(io, '/proc')).filter((name) =>
        /^[1-9]\d*$/.test(name),
      );
      if (!pids.includes(String(process.pid)))
        throw new Error('Incomplete proc process table');
      const rows: NativeColdProcess[] = [];
      const principals = new Map<number, string>();
      const managers = new Map<number, NativeColdProcess>();
      const denied: { readonly pid: number; readonly cause: unknown }[] = [];
      const refusals = new Map<number | null, LinuxColdRefusal>();
      async function markExited(pid: number): Promise<boolean> {
        if (!options.roots?.length || pid === process.pid) return false;
        const previous = refusals.get(pid);
        if (previous && !processChurn(previous.cause)) return false;
        try {
          await io.identity(`/proc/${pid}`);
          return false;
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) return false;
        }
        const exited: NativeColdProcess = {
          pid,
          scope: 'exited',
          parentPid: null,
          startIdentity: null,
          executable: null,
          paths: [],
        };
        const at = rows.findIndex((row) => row.pid === pid);
        if (at < 0) rows.push(exited);
        else rows[at] = exited;
        principals.delete(pid);
        managers.delete(pid);
        refusals.delete(pid);
        return true;
      }
      async function collect(
        read: () => Promise<void>,
        pid: number | null,
      ): Promise<void> {
        try {
          await diagnosed(io, read, pid);
        } catch (error) {
          if (!(error instanceof LinuxColdInspectionError)) throw error;
          for (const row of error.refusals) {
            const cause =
              row.pid !== null && row.pid === pid
                ? await classifyChurn(
                    io,
                    row.pid,
                    boot,
                    rows.find((observed) => observed.pid === pid)
                      ?.startIdentity ?? undefined,
                    row.cause,
                  )
                : row.cause;
            if (
              row.pid !== null &&
              row.pid === pid &&
              processChurn(cause) &&
              (await markExited(row.pid))
            )
              continue;
            const previous = refusals.get(row.pid);
            if (
              !previous ||
              (processChurn(previous.cause) && !processChurn(cause))
            )
              refusals.set(row.pid, { ...row, cause });
          }
        }
      }
      for (const value of pids) {
        const pid = Number(value);
        await collect(async () => {
          if (!Number.isSafeInteger(pid)) throw new Error('Invalid proc PID');
          const observedUid = principal(await io.text(`/proc/${pid}/status`));
          principals.set(pid, observedUid.join(':'));
          if (!isSameUserProcess(observedUid, uid)) return;
          // File access follows fsuid, even when euid differs (q-49 B).
          if (observedUid[3] !== uid) {
            const identity = parseStat(
              await io.text(`/proc/${pid}/stat`),
              pid,
              boot,
            );
            rows.push({
              pid,
              scope: 'linux-root-principal',
              parentPid: identity.parentPid,
              startIdentity: identity.startIdentity,
              comm: identity.comm,
              executable: null,
              paths: [],
            });
            return;
          }
          try {
            rows.push(
              await observe(
                pid,
                boot,
                io,
                process.pid,
                mounts,
                mapPath,
                membership,
              ),
            );
          } catch (cause) {
            if (!deniedProcessRead(cause, pid)) throw cause;
            const manager = await userManager(pid, uid, boot, io);
            if (manager) {
              rows.push(manager);
              managers.set(pid, manager);
            } else denied.push({ pid, cause });
          }
        }, pid);
      }
      // Resolve children after all managers, independent of PID enumeration order.
      for (const { pid, cause } of denied) {
        await collect(async () => {
          const pam = await userManagerPam(pid, uid, boot, io, managers);
          if (!pam) throw cause;
          rows.push(pam);
        }, pid);
      }
      for (const [pid, ids] of principals) {
        await collect(async () => {
          if (ids !== principal(await io.text(`/proc/${pid}/status`)).join(':'))
            throw new LinuxColdProcessRaceError(
              'Proc principal changed during observation',
            );
        }, pid);
      }
      // Recheck identity even for early rows: a reused PID is never a cold result.
      for (const row of rows) {
        if (row.scope === 'exited') continue;
        await collect(async () => {
          if (row.executableDirectoryEntries) {
            const image = await io.link(`/proc/${row.pid}/exe`);
            let installation: readonly string[] | undefined;
            try {
              installation = await crashHelperInstallation(
                io,
                image,
                row.linuxExecutableRoot,
              );
            } catch (cause) {
              // Only this task's projected directory can use its lifecycle evidence.
              throw await classifyChurn(
                io,
                row.pid,
                boot,
                row.startIdentity ?? undefined,
                cause,
                row.linuxExecutableRoot
                  ? path.posix.dirname(row.linuxExecutableRoot)
                  : undefined,
              );
            }
            if (
              image !== row.executable ||
              !same(row.executableDirectoryEntries, installation ?? [])
            )
              throw new Error(
                'Crash helper installation changed during observation',
              );
          }
          if (row.scope === 'linux-user-manager') {
            const repeated =
              row.executable === 'systemd'
                ? await userManager(row.pid, uid, boot, io)
                : await userManagerPam(row.pid, uid, boot, io, managers);
            if (repeated?.startIdentity !== row.startIdentity)
              throw new Error(
                'User manager qualification changed during observation',
              );
          }
          if (
            parseStat(await io.text(`/proc/${row.pid}/stat`), row.pid, boot)
              .startIdentity !== row.startIdentity
          )
            throw new LinuxColdProcessRaceError(
              'Proc PID reused during observation',
            );
        }, row.pid);
      }
      await collect(async () => {
        const current = (await entries(io, '/proc')).filter((name) =>
          /^[1-9]\d*$/.test(name),
        );
        if (options.roots?.length) {
          for (const pid of pids) {
            if (!current.includes(pid) && !(await markExited(Number(pid))))
              throw new LinuxColdProcessRaceError(
                'Proc process set changed during observation',
              );
          }
        }
        const expected = pids.filter(
          (pid) =>
            !rows.some(
              (row) => row.pid === Number(pid) && row.scope === 'exited',
            ),
        );
        if (!same(expected, current))
          throw new LinuxColdProcessChurnError(
            'Proc process set changed during observation',
          );
        if (boot !== (await bootId(io)))
          throw new LinuxColdProcessRaceError('Proc boot identity changed');
      }, null);
      for (const row of rows) {
        if (row.scope !== 'exited') continue;
        await collect(async () => {
          if (!(await markExited(row.pid)))
            throw new LinuxColdProcessChurnError(
              'Exited proc PID reappeared during observation',
            );
        }, row.pid);
      }
      await collect(async () => {
        if (mounts !== (await io.text('/proc/self/mountinfo')))
          throw new Error(
            'Linux mountinfo changed: path="/proc/self/mountinfo"',
          );
      }, process.pid);
      await collect(async () => {
        await membership?.recheck();
      }, process.pid);
      if (refusals.size) {
        throw new LinuxColdInspectionError(
          [...refusals.values()],
          rows.filter((row) => !refusals.has(row.pid)),
        );
      }
      return rows.map((row) => ({ ...row, linuxMountInfo: mounts }));
    },
    process.pid,
  );
}
