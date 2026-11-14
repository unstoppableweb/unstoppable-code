import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  PlatformProcessInspection,
  PlatformSecureFileServices,
} from '@canopy/core-runtime';
import { hostOperatingSystem } from './host-platform';
import {
  decodeMaintenanceRecord,
  decodeMemberRecord,
  encodeMaintenanceRecord,
  maintenanceOwnerLiveness,
  memberLiveness,
  W5_RECORD_MAX_BYTES,
  type W5MaintenanceRecord,
  type W5ProcessLiveness,
} from './w5-maintenance-records';

export type W5HostCohortRefusal =
  /** Registration: a live or unprovable maintenance record. */
  | 'maintenance-held'
  /** Registration: the private runtime directory is unavailable. */
  | 'runtime-unavailable'
  /** Backstop: this process runs read-only because it could not register. */
  | 'cohort-unavailable'
  /** Registration: this process holds maintenance for a root. */
  | 'maintenance-process'
  /** Backstop under tests: a shared W5 write before registration. */
  | 'unregistered-writer'
  /** Maintenance: a member is live or unprovable. */
  | 'host-active'
  /** Maintenance: an earlier record or the member list is unprovable. */
  | 'cohort-ambiguous'
  /** Maintenance: this host has no qualified maintenance exclusion. */
  | 'platform-unsupported';

const MESSAGES: Record<W5HostCohortRefusal, string> = {
  'maintenance-held':
    'Data maintenance is running. Try again when it finishes.',
  'runtime-unavailable':
    "The data folder's runtime folder isn't private or can't be created. Check that you own the data folder, then try again.",
  'cohort-unavailable':
    "This command can only read the data folder, so it can't make this change. Run it with write access to the data folder.",
  'maintenance-process': 'A maintenance process cannot register as a host.',
  'unregistered-writer':
    'A shared W5 write ran before this process registered its host.',
  'host-active': 'Another process is using the data folder.',
  'cohort-ambiguous':
    "Data maintenance couldn't confirm which processes use the data folder.",
  'platform-unsupported': 'Data maintenance is not available on this system.',
};

export class W5HostCohortRefusedError extends Error {
  constructor(
    readonly reason: W5HostCohortRefusal,
    /** The failure behind a `runtime-unavailable` refusal. */
    readonly underlying?: unknown,
    /** Set when only filesystem write access stopped registration. */
    readonly unwritable?: W5HostCohortUnwritable,
  ) {
    super(MESSAGES[reason]);
    this.name = 'W5HostCohortRefusedError';
  }
}

/** The path a sandboxed or read-only process could not create or write. */
export interface W5HostCohortUnwritable {
  readonly path: string;
  readonly code: 'EACCES' | 'EPERM' | 'EROFS';
}

/** Platform supervision's `inspectProcess`, as a plain function. */
export type W5ProcessInspector = (
  pid: number,
  signal?: AbortSignal,
) => Promise<PlatformProcessInspection>;

const RECORD = 'w5-maintenance.json';

const MEMBER = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/;

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

function isWindows(): boolean {
  return hostOperatingSystem() === 'win32';
}

let hostInspector: Promise<W5ProcessInspector> | undefined;

/**
 * Loaded only when a maintenance record exists, which is rare, keeping
 * core-platform and `ps` off the startup path.
 */
function inspectorFor(
  inspect?: W5ProcessInspector,
): Promise<W5ProcessInspector> {
  if (inspect) return Promise.resolve(inspect);
  hostInspector ??= Promise.all([
    import('./platform-services'),
    import('./endpoints'),
  ]).then(([platform, endpoints]) => {
    const services = platform.hostPlatformServices(
      endpoints.createPlatformEndpointServices(
        platform.hostPlatformOperatingSystem(),
      ),
    );
    return (
      pid: number,
      signal?: AbortSignal,
    ): Promise<PlatformProcessInspection> =>
      services.supervision.inspectProcess({ pid, signal });
  });
  return hostInspector;
}

/** Bounded read of a private record; `null` when absent. */
async function readRecord(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > W5_RECORD_MAX_BYTES) return '';
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

/** A complete file appears atomically, never replacing one (`EEXIST`). */
async function publishExclusive(target: string, text: string): Promise<void> {
  const temporary = join(
    dirname(target),
    `.${randomUUID()}.${process.pid}.tmp`,
  );
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  try {
    await link(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function inspectSafely(
  inspect: W5ProcessInspector,
  pid: number,
  signal?: AbortSignal,
): Promise<PlatformProcessInspection | null> {
  try {
    return await inspect(pid, signal);
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

type MaintenanceState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly liveness: W5ProcessLiveness };

async function maintenanceLiveness(
  runtime: string,
  inspect: W5ProcessInspector | undefined,
  signal?: AbortSignal,
): Promise<MaintenanceState> {
  const text = await readRecord(join(runtime, RECORD));
  if (text === null) return { kind: 'absent' };
  const record = decodeMaintenanceRecord(text);
  if (!record) return { kind: 'present', liveness: 'unknown' };
  const inspection = await inspectSafely(
    await inspectorFor(inspect),
    record.pid,
    signal,
  );
  return {
    kind: 'present',
    liveness: inspection
      ? maintenanceOwnerLiveness(record, inspection)
      : 'unknown',
  };
}

export interface W5MaintenanceExclusionOptions {
  /** Canonical root whose private runtime directory the caller verified. */
  readonly dataRoot: string;
  readonly inspect: W5ProcessInspector;
  /** Proves `runtime/hosts` private, ACLs included. */
  readonly secureFiles: Pick<PlatformSecureFileServices, 'permissions'>;
  readonly owner: { readonly pid: number; readonly startIdentity: string };
  /** Offline migration only: coordination plus repeated native cold snapshots. */
  readonly offlineMigration?: () => Promise<void>;
  readonly signal?: AbortSignal;
  /** Trusted bootstrap only: this process has no running W5 worker yet. */
  readonly allowCurrentHost?: boolean;
}

export interface W5MaintenanceExclusion {
  /** True while the record still names this exclusion's token. */
  isHeld(): Promise<boolean>;
  /** Removes the record if it still names this token; I/O failures throw. */
  release(): Promise<void>;
}

/** Only claim holders write the record, so a departed one may be replaced. */
async function publishMaintenanceRecord(
  runtime: string,
  text: string,
  inspect: W5ProcessInspector,
  signal?: AbortSignal,
): Promise<void> {
  const recordPath = join(runtime, RECORD);
  try {
    await publishExclusive(recordPath, text);
    return;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  const existing = await maintenanceLiveness(runtime, inspect, signal);
  if (existing.kind === 'present' && existing.liveness !== 'departed')
    throw new W5HostCohortRefusedError('cohort-ambiguous');
  const temporary = join(runtime, `.${randomUUID()}.${process.pid}.tmp`);
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  try {
    await rename(temporary, recordPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Prunes proven-departed members; true while any other member may live. */
async function anyMemberMayLive(
  hosts: string,
  options: W5MaintenanceExclusionOptions,
): Promise<boolean> {
  let entries: string[] = [];
  try {
    entries = await readdir(hosts);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  // A list another user could edit proves nothing about its members.
  const listed = entries.filter((name) => !name.startsWith('.'));
  if (listed.length === 0) return false;
  const permission = await options.secureFiles.permissions({
    path: hosts,
    kind: 'directory',
    mode: 'owner-only',
    action: 'verify',
  });
  if (permission.state !== 'private')
    throw new W5HostCohortRefusedError('cohort-ambiguous');
  let blocked = false;
  // Dot names are staging files or OS metadata, never members.
  for (const name of listed) {
    const path = join(hosts, name);
    const text = MEMBER.test(name) ? await readRecord(path) : '';
    if (text === null) continue;
    const record = decodeMemberRecord(text);
    if (record?.pid === process.pid && options.allowCurrentHost) continue;
    const inspection = record
      ? await inspectSafely(options.inspect, record.pid, options.signal)
      : null;
    if (
      record &&
      inspection &&
      memberLiveness(record, inspection) === 'departed'
    )
      await unlinkIfPresent(path);
    else blocked = true;
  }
  return blocked;
}

/**
 * Call only while holding the startup claim. Never waits. On refusal the
 * record is already withdrawn; the caller releases the claim.
 */
export async function acquireW5MaintenanceExclusion(
  options: W5MaintenanceExclusionOptions,
): Promise<W5MaintenanceExclusion> {
  if (isWindows() && !options.offlineMigration)
    throw new W5HostCohortRefusedError('platform-unsupported');
  await options.offlineMigration?.();
  const { dataRoot, owner, signal } = options;
  const runtime = join(dataRoot, 'runtime');
  const recordPath = join(runtime, RECORD);
  const record: W5MaintenanceRecord = { ...owner, token: randomUUID() };
  async function names(): Promise<boolean> {
    const text = await readRecord(recordPath);
    const current = text === null ? null : decodeMaintenanceRecord(text);
    return (
      current?.token === record.token &&
      current.pid === record.pid &&
      current.startIdentity === record.startIdentity
    );
  }
  const isHeld = (): Promise<boolean> => names().catch(() => false);
  // Unlike isHeld, an unreadable record fails the release.
  async function release(): Promise<void> {
    if (await names()) await unlink(recordPath);
  }

  try {
    await publishMaintenanceRecord(
      runtime,
      encodeMaintenanceRecord(record),
      options.inspect,
      signal,
    );
    await options.offlineMigration?.();
    if (await anyMemberMayLive(join(runtime, 'hosts'), options))
      throw new W5HostCohortRefusedError('host-active');
    if (!(await isHeld()))
      throw new W5HostCohortRefusedError('cohort-ambiguous');
  } catch (error) {
    // A record this process cannot remove stays live until it exits.
    await release().catch(() => undefined);
    throw error;
  }
  let released = false;
  return {
    isHeld: async (): Promise<boolean> => !released && (await isHeld()),
    release: async (): Promise<void> => {
      if (released) return;
      await release();
      released = true;
    },
  };
}
