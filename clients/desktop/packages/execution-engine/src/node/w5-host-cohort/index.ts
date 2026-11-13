import { observeStoragePathSync } from '@canopy/core-platform/storage-path-observation';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  PlatformProcessInspection,
  PlatformSecureFileServices,
} from '@canopy/core-runtime';
import { ensureW5PrivateRuntimeDirectory } from '@canopy/core-platform/w5-process-file-lock';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  decodeMaintenanceRecord,
  decodeMemberRecord,
  encodeMaintenanceRecord,
  encodeMemberRecord,
  maintenanceOwnerLiveness,
  memberLiveness,
  W5_RECORD_MAX_BYTES,
  type W5HostKind,
  type W5MaintenanceRecord,
  type W5ProcessLiveness,
} from './records';

/*
 * TRANSITIONAL (CAN-3797 W11): a cross-process cohort of legacy W5 hosts per
 * canonical data root, so offline maintenance can refuse while any of them
 * lives. Storage admission stays process-local. Remove when the W5 rows move
 * to `daemon` and the legacy writers are deleted (CAN-3795 / CAN-3802).
 * Assumes a local filesystem with ordered directory operations, like the
 * startup claim.
 */

export { W5_START_MATCH_WINDOW_MS, type W5HostKind } from './records';

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

export type W5HostRegistration =
  | { readonly kind: 'registered' }
  /** Read-only: every shared W5 write in this process refuses. */
  | ({ readonly kind: 'read-only' } & W5HostCohortUnwritable);

/** Platform supervision's `inspectProcess`, as a plain function. */
export type W5ProcessInspector = (
  pid: number,
  signal?: AbortSignal,
) => Promise<PlatformProcessInspection>;

/** Test seams; production composition passes none. */
export interface W5HostRegistrationOptions {
  readonly inspect?: W5ProcessInspector;
  /** Back-off before each retry while maintenance is held. */
  readonly retryDelaysMs?: readonly number[];
  readonly dataRoot: string;
  readonly hostKind: W5HostKind;
  readonly signal?: AbortSignal;
  /**
   * CLI only: when write access alone stops registration (a sandbox or a
   * read-only data folder), continue read-only instead of refusing.
   */
  readonly readOnlyWhenUnwritable?: boolean;
}

interface Membership {
  readonly root: string;
  /** null where registration is a no-op (win32). */
  readonly file: string | null;
}

const RECORD = 'w5-maintenance.json';
const MEMBER = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/;
const TEMPORARY = /^\.[0-9a-f-]{36}\.([1-9]\d*)\.tmp$/;
const DEFAULT_RETRY_DELAYS_MS = [25, 100, 250];

const byRequested = new Map<string, Membership>();
const byCanonical = new Map<string, Membership>();
const registering = new Map<string, Promise<Membership>>();
const registeringCanonical = new Map<string, Promise<Membership>>();
/** Requested and canonical spellings of roots this process reads only. */
const readOnlyRoots = new Set<string>();
let maintenanceHolds = 0;
// Captured at module load, close to process start: a later wall-clock step
// would move a late estimate outside the `ps` match window.
const START_ESTIMATE_MS = Math.round(Date.now() - process.uptime() * 1000);

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

/**
 * Rethrows a create or write failure, typed; access errors may degrade.
 * `path` names the directory being created or written into.
 */
function refuseCreate(error: unknown, path: string): never {
  if (error instanceof W5HostCohortRefusedError) throw error;
  const code = errorCode(error);
  throw new W5HostCohortRefusedError(
    'runtime-unavailable',
    error,
    code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
      ? { path, code }
      : undefined,
  );
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
  hostInspector ??= import('@canopy/core-platform').then((platform) => {
    const services = platform.hostPlatformServices(
      platform.createPlatformEndpointServices(
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

/**
 * Owner and mode only, so startup spawns nothing: a Darwin ACL needs a probe.
 * Maintenance verifies `runtime` and `hosts` through the platform helper,
 * ACLs included, before it trusts the member list.
 */
async function ensureRuntimeDirectory(path: string): Promise<void> {
  try {
    await ensureW5PrivateRuntimeDirectory(path);
  } catch (error) {
    refuseCreate(error, path);
  }
}

/**
 * Checked parent first: a create that fails, and so may degrade to
 * read-only, only ever happens inside a verified directory.
 */
async function prepareRuntime(
  root: string,
): Promise<{ runtime: string; hosts: string }> {
  const runtime = join(root, 'runtime');
  const hosts = join(runtime, 'hosts');
  await ensureRuntimeDirectory(runtime);
  await ensureRuntimeDirectory(hosts);
  return { runtime, hosts };
}

function isProcessAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
}

/** Off the startup path: only `kill(pid, 0)` → ESRCH proves a member departed. */
async function pruneDepartedMembers(hosts: string): Promise<void> {
  for (const name of await readdir(hosts)) {
    const temporary = TEMPORARY.exec(name);
    if (temporary) {
      if (isProcessAbsent(Number(temporary[1])))
        await unlinkIfPresent(join(hosts, name));
      continue;
    }
    if (!MEMBER.test(name)) continue;
    const text = await readRecord(join(hosts, name));
    const record = text === null ? null : decodeMemberRecord(text);
    if (record && record.pid !== process.pid && isProcessAbsent(record.pid))
      await unlinkIfPresent(join(hosts, name));
  }
}

/** Unreadable records refuse; an undecodable one reads as unknown. */
async function readMaintenanceLiveness(
  runtime: string,
  inspect: W5ProcessInspector | undefined,
  signal?: AbortSignal,
): Promise<MaintenanceState> {
  try {
    return await maintenanceLiveness(runtime, inspect, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new W5HostCohortRefusedError('runtime-unavailable', error);
  }
}

/** True when no maintenance record is live, unknown or unreadable. */
async function maintenanceClear(
  runtime: string,
  options: W5HostRegistrationOptions,
): Promise<boolean> {
  const state = await readMaintenanceLiveness(
    runtime,
    options.inspect,
    options.signal,
  );
  return state.kind === 'absent' || state.liveness === 'departed';
}

/** The back-off before the next attempt, or `maintenance-held`. */
async function backOff(
  options: W5HostRegistrationOptions,
  attempt: number,
): Promise<void> {
  const wait = (options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS)[attempt];
  if (wait === undefined)
    throw new W5HostCohortRefusedError('maintenance-held');
  await delay(wait, undefined, { signal: options.signal });
}

async function admit(
  root: string,
  options: W5HostRegistrationOptions,
): Promise<Membership> {
  const paths = await prepareRuntime(root);
  const text = encodeMemberRecord({
    pid: process.pid,
    startEstimateMs: START_ESTIMATE_MS,
    hostKind: options.hostKind,
  });
  for (let attempt = 0; ; attempt += 1) {
    options.signal?.throwIfAborted();
    // Write intent first; maintenance writes its record before listing us.
    const file = join(paths.hosts, `${randomUUID()}.json`);
    await publishExclusive(file, text).catch((error: unknown) =>
      refuseCreate(error, paths.hosts),
    );
    let admitted = false;
    try {
      admitted = await maintenanceClear(paths.runtime, options);
    } finally {
      // Withdrawn before any back-off, so maintenance never waits on us.
      if (!admitted) await unlinkIfPresent(file).catch(() => undefined);
    }
    if (admitted) {
      const membership: Membership = { root, file };
      byCanonical.set(root, membership);
      // Detached: pruning never delays admission.
      void pruneDepartedMembers(paths.hosts).catch(() => undefined);
      return membership;
    }
    await backOff(options, attempt);
  }
}

async function register(
  requested: string,
  options: W5HostRegistrationOptions,
): Promise<Membership> {
  await mkdir(requested, { recursive: true, mode: 0o700 }).catch(
    (error: unknown) => refuseCreate(error, requested),
  );
  let root: string;
  try {
    root = observeStoragePathSync(requested).canonicalPath;
  } catch (error) {
    return refuseCreate(error, requested);
  }
  const existing = byCanonical.get(root);
  if (existing) return existing;
  // Two spellings of one root registering at once share one member file.
  let pending = registeringCanonical.get(root);
  if (!pending) {
    pending = admit(root, options).finally(() =>
      registeringCanonical.delete(root),
    );
    registeringCanonical.set(root, pending);
  }
  return pending;
}

/**
 * The CLI's degraded path. No member file can be written, so the process
 * only reads: it still refuses while a maintenance record is live, unknown
 * or unreadable, and the atomic-file backstop refuses its shared writes. Any
 * `runtime` or `hosts` that exists was verified before the failed create.
 */
async function continueReadOnly(
  requested: string,
  unwritable: W5HostCohortUnwritable,
  options: W5HostRegistrationOptions,
): Promise<W5HostRegistration> {
  const root = observeStoragePathSync(requested).canonicalPath;
  for (let attempt = 0; ; attempt += 1) {
    options.signal?.throwIfAborted();
    if (await maintenanceClear(join(root, 'runtime'), options)) break;
    await backOff(options, attempt);
  }
  readOnlyRoots.add(requested);
  readOnlyRoots.add(root);
  return { kind: 'read-only', ...unwritable };
}

/**
 * Registers this process for `dataRoot` before any W5 call and keeps the
 * membership until process death (or `leaveW5HostCohortSync`). Idempotent per
 * canonical root; a no-op on win32, where maintenance refuses instead.
 */
export async function registerW5Host(
  options: W5HostRegistrationOptions,
): Promise<W5HostRegistration> {
  const requested = resolve(options.dataRoot);
  if (maintenanceHolds > 0)
    throw new W5HostCohortRefusedError('maintenance-process');
  if (isWindows()) {
    byRequested.set(requested, { root: requested, file: null });
    return { kind: 'registered' };
  }
  if (byRequested.has(requested)) return { kind: 'registered' };
  let pending = registering.get(requested);
  if (!pending) {
    pending = register(requested, options).finally(() =>
      registering.delete(requested),
    );
    registering.set(requested, pending);
  }
  try {
    byRequested.set(requested, await pending);
  } catch (error) {
    if (
      !options.readOnlyWhenUnwritable ||
      !(error instanceof W5HostCohortRefusedError) ||
      !error.unwritable
    )
      throw error;
    return continueReadOnly(requested, error.unwritable, options);
  }
  return { kind: 'registered' };
}

/**
 * The atomic-file backstop for shared (`desktop_cli`) W5 writes: the process
 * must be registered for its own data root. Tests fail; production registers
 * that root late, which still refuses while maintenance is held. Remove with
 * the cohort.
 */
export async function ensureW5HostMembership(): Promise<void> {
  if (isWindows()) {
    if (maintenanceHolds > 0)
      throw new W5HostCohortRefusedError('maintenance-process');
    return;
  }
  // Lazy: atomic-file imports this module, and its importers must not load
  // canopy-paths (or their mocks of it) at module load.
  const { getCanopyDataDir } = await import('../../canopy-paths');
  const requested = resolve(getCanopyDataDir());
  if (byRequested.has(requested)) return;
  const root = observeStoragePathSync(requested).canonicalPath;
  const canonical = byCanonical.get(root);
  if (canonical) {
    byRequested.set(requested, canonical);
    return;
  }
  // No lazy retry: a read-only process stays read-only.
  if (readOnlyRoots.has(requested) || readOnlyRoots.has(root))
    throw new W5HostCohortRefusedError('cohort-unavailable');
  if (process.env.NODE_ENV === 'test')
    throw new W5HostCohortRefusedError('unregistered-writer');
  await registerW5Host({ dataRoot: requested, hostKind: 'lazy-writer' });
}

/**
 * CLI only, on a natural event-loop exit (`beforeExit`): the drained loop is
 * the evidence that no W5 I/O is in flight. Electron relies on process death.
 */
export function leaveW5HostCohortSync(): void {
  const memberships = Array.from(new Set(byCanonical.values()));
  byCanonical.clear();
  byRequested.clear();
  for (const { file } of memberships) {
    if (!file) continue;
    try {
      unlinkSync(file);
    } catch {
      // A remaining file is pruned once this process is gone.
    }
  }
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
}

export interface W5MaintenanceExclusion {
  /** True while the record still names this exclusion's token. */
  isHeld(): Promise<boolean>;
  /** Removes the record if it still names this token; I/O failures throw. */
  release(): Promise<void>;
}

/** Advisory pre-check only. RX2 rechecks under exclusion; this never prunes. */
export async function listW5HostPeers(options: {
  readonly dataRoot: string;
  readonly inspect: W5ProcessInspector;
  readonly secureFiles: Pick<PlatformSecureFileServices, 'permissions'>;
  readonly signal?: AbortSignal;
}): Promise<readonly string[]> {
  const runtime = join(options.dataRoot, 'runtime');
  const hosts = join(runtime, 'hosts');
  let names: string[];
  try {
    names = await readdir(hosts);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw new W5HostCohortRefusedError('cohort-ambiguous', error);
  }
  for (const path of [runtime, hosts]) {
    if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
      throw new W5HostCohortRefusedError('cohort-ambiguous');
    const permission = await options.secureFiles.permissions({
      path,
      kind: 'directory',
      mode: 'owner-only',
      action: 'verify',
    });
    if (permission.state !== 'private')
      throw new W5HostCohortRefusedError('cohort-ambiguous');
  }
  const peers: string[] = [];
  for (const name of names.filter((name) => !name.startsWith('.')).sort()) {
    const text = MEMBER.test(name) ? await readRecord(join(hosts, name)) : '';
    if (text === null) continue;
    const record = decodeMemberRecord(text);
    if (!record) {
      peers.push('unknown');
      continue;
    }
    if (record.pid === process.pid) continue;
    const inspected = await inspectSafely(
      options.inspect,
      record.pid,
      options.signal,
    );
    const liveness = inspected ? memberLiveness(record, inspected) : 'unknown';
    if (liveness === 'live') peers.push(record.hostKind);
    else if (liveness === 'unknown') peers.push('unknown');
  }
  return peers;
}

/** Read-only offline preflight: reuse the maintenance record and liveness policy. */
export async function inspectW5MaintenanceOwner(options: {
  readonly dataRoot: string;
  readonly inspect: W5ProcessInspector;
  readonly secureFiles: Pick<PlatformSecureFileServices, 'permissions'>;
}): Promise<boolean> {
  const runtime = join(options.dataRoot, 'runtime');
  try {
    const stat = await lstat(runtime);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(runtime)) !== runtime
    )
      throw new W5HostCohortRefusedError('cohort-ambiguous');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  if (
    (
      await options.secureFiles.permissions({
        path: runtime,
        kind: 'directory',
        mode: 'owner-only',
        action: 'verify',
      })
    ).state !== 'private'
  )
    throw new W5HostCohortRefusedError('cohort-ambiguous');
  const state = await maintenanceLiveness(runtime, options.inspect);
  return state.kind === 'present' && state.liveness !== 'departed';
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
  if (
    byCanonical.has(dataRoot) ||
    (isWindows() && byRequested.has(dataRoot)) ||
    registering.size > 0 ||
    readOnlyRoots.size > 0
  )
    throw new W5HostCohortRefusedError('host-active');
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

  maintenanceHolds += 1;
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
    maintenanceHolds -= 1;
    throw error;
  }
  let released = false;
  return {
    isHeld: async (): Promise<boolean> => !released && (await isHeld()),
    release: async (): Promise<void> => {
      if (released) return;
      await release();
      released = true;
      maintenanceHolds -= 1;
    },
  };
}
