import { createHash, randomBytes } from 'node:crypto';
import { readSync } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import type {
  PlatformOperatingSystem,
  PlatformOwnedChild,
  PlatformOwnedChildServices,
} from '@canopy/core-runtime';
import type {
  LinuxMigrationCapture,
  WindowsMigrationCapture,
} from '@canopy/core-runtime/node/vault';

/** Staged beside the daemon host; built from `packages/core-platform/native/owned-child`. */
export const OWNED_CHILD_FILE = 'core-owned-child.node';

/** The launcher's private byte channel; Windows connects rather than inheriting it. */
export type OwnedChildChannel = ByteChannel;

export interface OwnedChildLaunch {
  readonly child: PlatformOwnedChild;
  readonly channel: OwnedChildChannel;
}

export interface OwnedChildServices extends PlatformOwnedChildServices {
  /**
   * As `spawn`, plus a private launcher channel. Darwin and Linux use fd 3; Windows
   * delivers a channel locator header before the bounded stdin payload. This
   * establishes process custody only, never migration admission.
   */
  spawnWithChannel(request: SpawnRequest): Promise<OwnedChildLaunch>;
}

type ChannelPeerRefusal =
  | 'not_running'
  | 'no_frame'
  | 'not_connected'
  | 'pid_mismatch'
  | 'pidversion_changed';

/** The spawned root as the last user of its channel end; host-only. */
export type ChannelPeer =
  | {
      readonly state: 'peer';
      readonly pid: number;
      readonly pidversion: number;
      readonly token: Buffer;
    }
  | { readonly state: 'refused'; readonly reason: ChannelPeerRefusal };

export type OwnedChildErrorCode =
  | 'capability_unavailable'
  | 'unavailable'
  | 'failed_precondition'
  | 'invalid_argument';

/** Closed native-failure reason; `code` alone cannot tell a missing addon from a blocked one. */
export type OwnedChildErrorReason = 'load_failed' | 'native_unknown';

/** Fixed messages only: no paths, arguments, environment, or handoff content. */
export class OwnedChildError extends Error {
  override readonly name = 'OwnedChildError';
  readonly code: OwnedChildErrorCode;
  readonly reason?: OwnedChildErrorReason;
  nativeDiagnostic?: { readonly stage: string; readonly win32: number };

  constructor(
    code: OwnedChildErrorCode,
    message: string,
    reason?: OwnedChildErrorReason,
  ) {
    super(message);
    this.code = code;
    if (reason) this.reason = reason;
  }
}

type SpawnRequest = Parameters<PlatformOwnedChildServices['spawn']>[0];
type Exit = Awaited<PlatformOwnedChild['exited']>;
type Observation =
  | { readonly state: 'running' }
  | { readonly state: 'lost' }
  | ({ readonly state: 'exited' } & Exit);

/** The native addon. Results are `unknown` and validated here. */
interface OwnedChildNative {
  spawn(
    executable: string,
    argv: readonly string[],
    environment: readonly string[],
    stdin: string | null,
  ): unknown;
  observe(handle: object): unknown;
  stopGroup(handle: object): unknown;
  members(handle: object): unknown;
  release(handle: object): unknown;
  commit(handle: object): unknown;
  rollbackSync(handle: object): unknown;
  rollbackUndelivered(): unknown;
}

/** Launcher-channel calls; an addon without them still serves `spawn`. */
interface OwnedChildChannelNative {
  spawnChannel(
    ...args: [...Parameters<OwnedChildNative['spawn']>, nonce?: string]
  ): unknown;
  channelRead(handle: object, max: number): unknown;
  channelWrite(handle: object, bytes: Uint8Array): unknown;
  channelPeer(handle: object): unknown;
  channelClose(handle: object): unknown;
}

interface WindowsChannelNative extends OwnedChildChannelNative {
  connectLauncher(pid: number, creationTime: bigint, nonce: string): unknown;
}

function hasWindowsChannel(
  value: OwnedChildNative,
): value is OwnedChildNative & WindowsChannelNative {
  return (
    hasChannel(value) && typeof field(value, 'connectLauncher') === 'function'
  );
}

const CHANNEL_METHODS = [
  'spawnChannel',
  'channelRead',
  'channelWrite',
  'channelPeer',
  'channelClose',
];

const METHODS = [
  'spawn',
  'observe',
  'stopGroup',
  'members',
  'release',
  'commit',
  'rollbackSync',
  'rollbackUndelivered',
];
const MAX_STDIN_BYTES = 4096;
const CLEANUP_DEADLINE_MS = 2_000;
const STOP_POLL_MS = 10;
const OWNED_POLL_MS = 20;
const COMMITTED_POLL_MS = 250;

const UNSUPPORTED = 'Owned child processes are unavailable on this host.';
const INVALID = 'Owned child request is invalid.';
const LOST = 'Owned child ownership was lost.';
const UNCONFIRMED = 'Owned child cleanup did not complete.';
const COMMITTED = 'Owned child is committed and cannot be stopped.';
const STOPPING = 'Owned child is stopping and cannot be committed.';
const EXITED = 'Owned child exited before commit.';
const NATIVE_ERRORS: Readonly<
  Record<string, readonly [OwnedChildErrorCode, string]>
> = {
  ERR_OWNED_CHILD_CHANNEL_UNSUPPORTED: [
    'capability_unavailable',
    'Linux launcher channels require stale-sender pidfds and pidfs.',
  ],
  ERR_OWNED_CHILD_ARGUMENT: ['invalid_argument', INVALID],
  ERR_OWNED_CHILD_SPAWN: [
    'failed_precondition',
    'Owned child could not be started.',
  ],
  ERR_OWNED_CHILD_COMMITTED: ['failed_precondition', COMMITTED],
  ERR_OWNED_CHILD_EXITED: ['failed_precondition', EXITED],
  // Windows: kill-on-close could not be cleared; the child stays owned.
  ERR_OWNED_CHILD_COMMIT: [
    'failed_precondition',
    'Owned child could not be committed.',
  ],
  ERR_OWNED_CHILD_LOST: ['unavailable', LOST],
  ERR_OWNED_CHILD_CLEANUP: ['unavailable', UNCONFIRMED],
};

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

const fail = (
  code: OwnedChildErrorCode,
  message: string,
  reason?: OwnedChildErrorReason,
): OwnedChildError => new OwnedChildError(code, message, reason);

// As paths.ts `isFullyQualified`: drive or UNC only. Kept import-free, because
// native host-exit suites load this module directly under Node type stripping.
const WIN32_FULLY_QUALIFIED =
  /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![?.][\\/])[^\\/]+[\\/]+[^\\/])/;
/** Hosts with an owned-child backend. */
const SPAWN_HOSTS: ReadonlySet<PlatformOperatingSystem> =
  new Set<PlatformOperatingSystem>(['darwin', 'linux', 'win32']);
/** Package-internal: a drive/UNC path on win32, an absolute path on POSIX. */
export const fullyQualified = (
  os: PlatformOperatingSystem,
  value: string,
): boolean =>
  !value.includes('\0') &&
  (os === 'win32'
    ? WIN32_FULLY_QUALIFIED.test(value)
    : path.posix.isAbsolute(value));

function isNative(value: unknown): value is OwnedChildNative {
  return METHODS.every((method) => typeof field(value, method) === 'function');
}

/** Windows execution launch; an addon without it still serves `spawn`. */
interface OwnedChildLaunchNative {
  launch(
    executable: string,
    argv: readonly string[],
    environment: readonly string[],
    cwd: string,
    nonce: string,
    stdinPipe: boolean,
  ): unknown;
  resume(handle: object): unknown;
}

function hasLaunch(
  value: OwnedChildNative,
): value is OwnedChildNative & OwnedChildLaunchNative {
  return (
    typeof field(value, 'launch') === 'function' &&
    typeof field(value, 'resume') === 'function'
  );
}

function hasChannel(
  value: OwnedChildNative,
): value is OwnedChildNative & OwnedChildChannelNative {
  return CHANNEL_METHODS.every(
    (method) => typeof field(value, method) === 'function',
  );
}

const CHANNEL_CLOSED = 'Owned child channel is closed.';
const CHANNEL_BUSY = 'Owned child channel is already in use.';
const PEER_REFUSALS: readonly ChannelPeerRefusal[] = [
  'not_running',
  'no_frame',
  'not_connected',
  'pid_mismatch',
  'pidversion_changed',
];
const AUDIT_TOKEN_BYTES = 32;

/** Peer capture per channel; module-private so no other module can mint one. */
const peers = new WeakMap<OwnedChildChannel, () => ChannelPeer>();

function parsePeer(value: unknown): ChannelPeer {
  const state = field(value, 'state');
  const reason = PEER_REFUSALS.find((item) => item === field(value, 'reason'));
  if (state === 'refused' && reason) return { state, reason };
  const pid = field(value, 'pid');
  const pidversion = field(value, 'pidversion');
  const token = field(value, 'token');
  if (
    state === 'peer' &&
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    typeof pidversion === 'number' &&
    Number.isSafeInteger(pidversion) &&
    Buffer.isBuffer(token) &&
    token.byteLength === AUDIT_TOKEN_BYTES
  )
    return { state, pid, pidversion, token };
  throw fail('unavailable', LOST);
}

/**
 * The spawned root's identity as the last user of its channel end. Meaningful
 * only after the root's first frame. Package-internal: peer identity checks
 * its code; this is never exported from the package.
 */
export function channelPeer(channel: OwnedChildChannel): ChannelPeer {
  const capture = peers.get(channel);
  if (!capture) throw fail('invalid_argument', INVALID);
  return capture();
}

function createChannel(
  native: OwnedChildChannelNative,
  handle: object,
  os: PlatformOperatingSystem = 'darwin',
): OwnedChildChannel {
  const channel = createPolledChannel(
    {
      read: (max) => native.channelRead(handle, max),
      write: (bytes) => native.channelWrite(handle, bytes),
      close: () => native.channelClose(handle),
    },
    {
      closed: () => fail('unavailable', CHANNEL_CLOSED),
      busy: () => fail('failed_precondition', CHANNEL_BUSY),
    },
  );
  if (os === 'linux') {
    linuxPeers.set(channel, () => native.channelPeer(handle));
    if (hasLinuxImage(native))
      linuxImages.set(channel, () =>
        captureLinuxImage(native, handle, channel),
      );
    return channel;
  }
  if (os === 'win32') {
    windowsPeers.set(channel, () => native.channelPeer(handle));
    if (hasWindowsImage(native))
      windowsImages.set(channel, () =>
        captureWindowsImage(native, handle, channel),
      );
    return channel;
  }
  peers.set(channel, () => {
    try {
      return parsePeer(native.channelPeer(handle));
    } catch (error) {
      const code = field(error, 'code');
      // A closed channel or a reaped root has no peer to describe.
      if (code === 'ERR_OWNED_CHILD_CHANNEL')
        return { state: 'refused', reason: 'not_connected' };
      if (code === 'ERR_OWNED_CHILD_HANDLE')
        return { state: 'refused', reason: 'not_running' };
      throw error instanceof OwnedChildError
        ? error
        : fail('unavailable', LOST);
    }
  });
  return channel;
}

/** Linux sender-attributed byte custody, not executable or migration evidence. */
export type LinuxChannelPeer =
  | {
      readonly state: 'connected';
      readonly pid: number;
      readonly uid: number;
      readonly gid: number;
    }
  | { readonly state: 'refused' };

const linuxPeers = new WeakMap<ByteChannel, () => unknown>();

export function linuxChannelPeer(channel: ByteChannel): LinuxChannelPeer {
  const capture = linuxPeers.get(channel);
  if (!capture) throw fail('invalid_argument', INVALID);
  let result: unknown;
  try {
    result = capture();
  } catch {
    return { state: 'refused' };
  }
  if (field(result, 'state') === 'refused') return { state: 'refused' };
  const pid = field(result, 'pid');
  const uid = field(result, 'uid');
  const gid = field(result, 'gid');
  if (
    field(result, 'state') === 'connected' &&
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    pid <= 0x7fffffff &&
    typeof uid === 'number' &&
    Number.isSafeInteger(uid) &&
    uid >= 0 &&
    uid < 0xffffffff &&
    typeof gid === 'number' &&
    Number.isSafeInteger(gid) &&
    gid >= 0 &&
    gid < 0xffffffff
  )
    return { state: 'connected', pid, uid, gid };
  throw fail('unavailable', LOST);
}

interface LinuxImageNative extends OwnedChildChannelNative {
  linuxMigrationImage(handle: object): unknown;
  linuxMigrationCurrent(handle: object): unknown;
  linuxMigrationClose(handle: object): unknown;
}
function hasLinuxImage(
  native: OwnedChildChannelNative,
): native is LinuxImageNative {
  return [
    'linuxMigrationImage',
    'linuxMigrationCurrent',
    'linuxMigrationClose',
  ].every((name) => typeof field(native, name) === 'function');
}
const linuxImages = new WeakMap<
  ByteChannel,
  () => LinuxMigrationCapture | null
>();

/** Host-only L2 observation. Forged/remote wrappers never enter this WeakMap. */
export function captureLinuxMigrationPeer(
  channel: ByteChannel,
): LinuxMigrationCapture | null {
  try {
    return linuxImages.get(channel)?.() ?? null;
  } catch {
    return null;
  }
}

function linuxImageDigest(fd: number): string {
  const hash = createHash('sha256');
  const bytes = Buffer.alloc(64 * 1024);
  let offset = 0;
  for (;;) {
    const count = readSync(fd, bytes, 0, bytes.length, offset);
    if (!count) return `sha256:${hash.digest('hex')}`;
    hash.update(bytes.subarray(0, count));
    offset += count;
  }
}

function captureLinuxImage(
  native: LinuxImageNative,
  handle: object,
  channel: ByteChannel,
): LinuxMigrationCapture | null {
  const value = native.linuxMigrationImage(handle);
  if (field(value, 'state') !== 'captured') return null;
  let retained = false;
  try {
    const peer = linuxChannelPeer(channel);
    const fd = field(value, 'fd');
    const role = field(value, 'role');
    const startTime = field(value, 'startTime');
    const bootId = field(value, 'bootId');
    const fileId = field(value, 'fileId');
    const command = field(value, 'command');
    const localPid = field(value, 'localPid');
    const localParentPid = field(value, 'localParentPid');
    const parentPid = field(value, 'parentPid');
    const pid = (v: unknown): v is number =>
      typeof v === 'number' &&
      Number.isSafeInteger(v) &&
      v > 1 &&
      v <= 0x7fffffff;
    if (
      peer.state !== 'connected' ||
      peer.pid !== field(value, 'pid') ||
      typeof fd !== 'number' ||
      !Number.isSafeInteger(fd) ||
      fd < 0 ||
      (role !== 'launcher' && role !== 'daemon') ||
      typeof startTime !== 'string' ||
      !/^[1-9][0-9]*$/.test(startTime) ||
      typeof bootId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId) ||
      typeof fileId !== 'string' ||
      !/^[0-9]+:[0-9]+$/.test(fileId) ||
      !Buffer.isBuffer(command) ||
      command.length < 2 ||
      command[command.length - 1] !== 0 ||
      !pid(localPid) ||
      !pid(localParentPid) ||
      !pid(parentPid)
    )
      return null;
    const text = command.toString('utf8');
    // Refuse lossy argument decoding, never compare two replacement strings.
    if (!Buffer.from(text).equals(command)) return null;
    const argv = Object.freeze(text.slice(0, -1).split('\0'));
    const digest = linuxImageDigest(fd);
    if (native.linuxMigrationCurrent(handle) !== true) return null;
    let closed = false;
    retained = true;
    return Object.freeze({
      role,
      identity: Object.freeze({
        os: 'linux' as const,
        pid: peer.pid,
        bootId,
        startTime,
        continuity: 'process-instance' as const,
      }),
      localPid,
      localParentPid,
      parentPid,
      fileId,
      digest,
      argv,
      current(): boolean {
        try {
          if (closed || native.linuxMigrationCurrent(handle) !== true)
            return false;
          const current = linuxChannelPeer(channel);
          return (
            current.state === 'connected' &&
            current.pid === peer.pid &&
            linuxImageDigest(fd) === digest &&
            native.linuxMigrationCurrent(handle) === true
          );
        } catch {
          return false;
        }
      },
      close(): void {
        if (closed) return;
        closed = true;
        try {
          native.linuxMigrationClose(handle);
        } catch {
          /* Channel already released its pins. */
        }
      },
    });
  } finally {
    if (!retained) native.linuxMigrationClose(handle);
  }
}

/** L1 qualifier only, requiring Linux pidfs and stale-sender SCM_PIDFD. No production composition calls this. */
export function connectLinuxLauncherChannel(
  nativePath: string,
  launcherPid: number,
): ByteChannel {
  if (process.platform !== 'linux')
    throw fail('capability_unavailable', UNSUPPORTED);
  if (
    !Number.isSafeInteger(launcherPid) ||
    launcherPid <= 1 ||
    launcherPid > 0x7fffffff
  )
    throw fail('invalid_argument', INVALID);
  const native = loadNative('linux', nativePath);
  const connect = field(native, 'connectLinuxLauncher');
  if (!hasChannel(native) || typeof connect !== 'function')
    throw fail('capability_unavailable', UNSUPPORTED);
  const result: unknown = call(() =>
    Reflect.apply(connect, native, [launcherPid]),
  );
  const handle = field(result, 'handle');
  if (typeof handle !== 'object' || handle === null)
    throw fail('unavailable', LOST);
  return createChannel(native, handle, 'linux');
}

/** Native channel custody only; not a shared migration-evidence variant. */
export type WindowsChannelPeer =
  | {
      readonly state: 'connected';
      readonly pid: number;
      readonly creationTime: bigint;
    }
  | { readonly state: 'refused' };

const windowsPeers = new WeakMap<ByteChannel, () => unknown>();

export function windowsChannelPeer(channel: ByteChannel): WindowsChannelPeer {
  const capture = windowsPeers.get(channel);
  if (!capture) throw fail('invalid_argument', INVALID);
  let result: unknown;
  try {
    result = capture();
  } catch {
    return { state: 'refused' };
  }
  const pid = field(result, 'pid');
  const creationTime = field(result, 'creationTime');
  if (field(result, 'state') === 'refused') return { state: 'refused' };
  if (
    field(result, 'state') === 'connected' &&
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    typeof creationTime === 'bigint' &&
    creationTime > 0n &&
    creationTime <= 0xffffffffffffffffn
  )
    return { state: 'connected', pid, creationTime };
  throw fail('unavailable', LOST);
}

interface WindowsImageNative extends OwnedChildChannelNative {
  channelImage(handle: object): unknown;
  imageCurrent(pin: object): unknown;
  imageClose(pin: object): unknown;
}
function hasWindowsImage(
  native: OwnedChildChannelNative,
): native is WindowsImageNative {
  return ['channelImage', 'imageCurrent', 'imageClose'].every(
    (name) => typeof field(native, name) === 'function',
  );
}
const windowsImages = new WeakMap<
  ByteChannel,
  () => WindowsMigrationCapture | null
>();

/** Host-only W2 capture; a caller cannot manufacture a W1 channel wrapper. */
export function captureWindowsMigrationPeer(
  channel: ByteChannel,
): WindowsMigrationCapture | null {
  try {
    return windowsImages.get(channel)?.() ?? null;
  } catch {
    // W1 may already have released its launch record after the peer exited.
    return null;
  }
}

function captureWindowsImage(
  native: WindowsImageNative,
  handle: object,
  channel: ByteChannel,
): WindowsMigrationCapture | null {
  const value = native.channelImage(handle);
  const pin = field(value, 'pin');
  if (typeof pin !== 'object' || pin === null) return null;
  let retained = false;
  try {
    const peer = windowsChannelPeer(channel);
    const role = field(value, 'role');
    const digest = field(value, 'digest');
    const fileId = field(value, 'fileId');
    const commandLine = field(value, 'commandLine');
    const publisher = field(value, 'publisher');
    const certificateDigest = field(value, 'certificateDigest');
    const localPid = field(value, 'localPid');
    const localParentPid = field(value, 'localParentPid');
    const parentPid = field(value, 'parentPid');
    const pid = (v: unknown): v is number =>
      typeof v === 'number' &&
      Number.isSafeInteger(v) &&
      v > 0 &&
      v <= 0xffffffff;
    if (
      peer.state !== 'connected' ||
      peer.pid !== field(value, 'pid') ||
      peer.creationTime !== field(value, 'creationTime') ||
      (role !== 'launcher' && role !== 'daemon') ||
      typeof digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(digest) ||
      typeof fileId !== 'string' ||
      !/^[0-9a-f]{24}$/.test(fileId) ||
      typeof commandLine !== 'string' ||
      !commandLine ||
      commandLine.includes('\0') ||
      !pid(localPid) ||
      !pid(localParentPid) ||
      !pid(parentPid)
    )
      return null;
    const signing =
      field(value, 'signing') === 'valid' &&
      typeof publisher === 'string' &&
      typeof certificateDigest === 'string' &&
      /^sha256:[0-9a-f]{64}$/.test(certificateDigest)
        ? { status: 'valid' as const, publisher, certificateDigest }
        : {
            status: 'invalid' as const,
            publisher: null,
            certificateDigest: null,
          };
    retained = true;
    let closed = false;
    return Object.freeze({
      role,
      identity: Object.freeze({
        os: 'win32' as const,
        pid: peer.pid,
        creationTime: peer.creationTime,
      }),
      localPid,
      localParentPid,
      parentPid,
      fileId,
      digest,
      commandLine,
      signing: Object.freeze(signing),
      current(): boolean {
        if (closed || native.imageCurrent(pin) !== true) return false;
        const current = windowsChannelPeer(channel);
        return (
          current.state === 'connected' &&
          current.pid === peer.pid &&
          current.creationTime === peer.creationTime
        );
      },
      close(): void {
        closed = true;
        native.imageClose(pin);
      },
    });
  } finally {
    if (!retained) native.imageClose(pin);
  }
}

const WINDOWS_CONNECT_STAGES: ReadonlySet<string> = new Set([
  'allocation',
  'open',
  'server_pid',
  'server_mismatch',
  'mode',
  'process',
  'creation_time',
  'process_exited',
  'delivery',
]);

/**
 * Host-only W1 primitive. The header comes from the child's private stdin,
 * not a control request. No production composition calls this on Windows.
 */
export function connectWindowsLauncherChannel(
  nativePath: string,
  header: string,
): ByteChannel {
  if (process.platform !== 'win32')
    throw fail('capability_unavailable', UNSUPPORTED);
  const match =
    /^canopy-launcher-v1 ([1-9][0-9]{0,9}) ([1-9][0-9]{0,19}) ([0-9a-f]{32})\n$/.exec(
      header,
    );
  if (!match) throw fail('invalid_argument', INVALID);
  const pid = Number(match[1]);
  const ticks = BigInt(match[2]);
  if (pid <= 1 || pid > 0xffffffff || ticks > 0xffffffffffffffffn)
    throw fail('invalid_argument', INVALID);
  const native = loadNative('win32', nativePath);
  if (!hasWindowsChannel(native))
    throw fail('capability_unavailable', UNSUPPORTED);
  let handle: unknown;
  try {
    handle = native.connectLauncher(pid, ticks, match[3] ?? '');
  } catch (error) {
    const mapped = fail(
      'unavailable',
      'Launcher channel could not be connected.',
    );
    const stage = field(error, 'stage');
    const win32 = field(error, 'win32');
    if (
      typeof stage === 'string' &&
      WINDOWS_CONNECT_STAGES.has(stage) &&
      typeof win32 === 'number' &&
      Number.isSafeInteger(win32) &&
      win32 >= 0 &&
      win32 <= 0xffffffff
    )
      mapped.nativeDiagnostic = { stage, win32 };
    throw mapped;
  }
  if (typeof handle !== 'object' || handle === null)
    throw fail('unavailable', LOST);
  return createChannel(native, handle, 'win32');
}

/** Loads the addon from an explicit path; anything else fails closed. */
function loadNative(
  os: PlatformOperatingSystem,
  file: string,
): OwnedChildNative {
  const module = { exports: {} };
  if (!fullyQualified(os, file))
    throw fail('capability_unavailable', UNSUPPORTED);
  try {
    process.dlopen(module, file);
  } catch {
    throw fail('capability_unavailable', UNSUPPORTED, 'load_failed');
  }
  if (!isNative(module.exports))
    throw fail('capability_unavailable', UNSUPPORTED);
  return module.exports;
}

/**
 * The addon's `SetThreadExecutionState` call (win32 only), for power. The
 * returned function reports whether Windows accepted the state.
 */
export function loadExecutionState(
  os: PlatformOperatingSystem,
  nativePath: string,
): (systemRequired: boolean) => boolean {
  if (os !== 'win32') throw fail('capability_unavailable', UNSUPPORTED);
  const native = loadNative(os, nativePath);
  const set = field(native, 'setExecutionState');
  if (typeof set !== 'function')
    throw fail('capability_unavailable', UNSUPPORTED);
  return (systemRequired) =>
    call((): unknown => Reflect.apply(set, native, [systemRequired])) === true;
}

/**
 * The addon's handle-confined W5 capture read (win32 only, CAN-5202). Its
 * results and errors are unvalidated; `w5-confined-read.ts` checks them.
 */
export function loadConfinedRead(
  os: PlatformOperatingSystem,
  nativePath: string,
): (root: string, components: readonly string[], maxBytes: number) => unknown {
  if (os !== 'win32') throw fail('capability_unavailable', UNSUPPORTED);
  const native = loadNative(os, nativePath);
  const read = field(native, 'readConfinedFile');
  if (typeof read !== 'function')
    throw fail('capability_unavailable', UNSUPPORTED);
  return (root, components, maxBytes): unknown => {
    const result: unknown = Reflect.apply(read, native, [
      root,
      components,
      maxBytes,
    ]);
    return result;
  };
}

/**
 * The addon's Recycle Bin move (win32 only, CAN-4726). Its result is
 * unvalidated; `trash/windows.ts` checks it.
 */
export function loadRecycleItem(
  os: PlatformOperatingSystem,
  nativePath: string,
): (path: string) => Promise<unknown> {
  if (os !== 'win32') throw fail('capability_unavailable', UNSUPPORTED);
  const native = loadNative(os, nativePath);
  const recycle = field(native, 'recycleItem');
  if (typeof recycle !== 'function')
    throw fail('capability_unavailable', UNSUPPORTED);
  return (path): Promise<unknown> =>
    Promise.resolve().then((): unknown =>
      Reflect.apply(recycle, native, [path]),
    );
}

/** Runs a native call, replacing its error with a fixed typed one. */
function call(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    const code = field(error, 'code');
    const mapped = typeof code === 'string' ? NATIVE_ERRORS[code] : undefined;
    throw mapped
      ? fail(...mapped)
      : fail('unavailable', LOST, 'native_unknown');
  }
}

function signalName(value: unknown): string | null {
  if (typeof value !== 'number') return null;
  const found = Object.entries(constants.signals).find(([, n]) => n === value);
  return found?.[0] ?? `SIG${value}`;
}

function parseObservation(value: unknown): Observation {
  const state = field(value, 'state');
  if (state === 'running' || state === 'lost') return { state };
  const code = field(value, 'code');
  if (state === 'exited' && (code === null || Number.isInteger(code)))
    return {
      state,
      code: typeof code === 'number' ? code : null,
      signal: signalName(field(value, 'signal')),
    };
  throw fail('unavailable', LOST);
}

const unsafe = (value: string): boolean => value.includes('\0');

function nativeRequest(
  os: PlatformOperatingSystem,
  request: SpawnRequest,
  withChannel = false,
): Parameters<OwnedChildNative['spawn']> {
  const { executable, args, environment, stdin } = request;
  const win32 = os === 'win32';
  const strings = (values: unknown): values is string[] =>
    Array.isArray(values) &&
    values.every((value) => typeof value === 'string' && !unsafe(value));
  const entries: [string, unknown][] =
    typeof environment === 'object' && environment !== null
      ? Object.entries(environment)
      : [['', undefined]];
  // An unusable entry becomes '\0', which fails the string check below.
  const pairs = entries.map(([key, value]) =>
    key === '' || key.includes('=') || typeof value !== 'string'
      ? '\0'
      : `${key}=${value}`,
  );
  // Windows treats names that differ only in case as one variable.
  const names = entries.map(([key]) => (win32 ? key.toUpperCase() : key));
  const valid =
    typeof executable === 'string' &&
    fullyQualified(os, executable) &&
    strings(args) &&
    strings(pairs) &&
    new Set(names).size === names.length &&
    (stdin === undefined ||
      ((!win32 || withChannel) &&
        typeof stdin === 'string' &&
        !unsafe(stdin) &&
        Buffer.byteLength(stdin) <= MAX_STDIN_BYTES));
  if (!valid) throw fail('invalid_argument', INVALID);
  return [executable, [executable, ...args], pairs, stdin ?? null];
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects with the signal's reason once aborted; the work itself continues. */
export function bounded<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let abort = (): void => undefined;
  const aborted = new Promise<void>((resolve) => {
    abort = resolve;
    signal.addEventListener('abort', abort, { once: true });
  }).then((): never => {
    signal.throwIfAborted();
    throw fail('unavailable', UNCONFIRMED);
  });
  return Promise.race([work, aborted]).finally(() =>
    signal.removeEventListener('abort', abort),
  );
}

/**
 * A launcher-channel end. The descriptor stays native; bytes only. Shared
 * with peer identity's daemon end.
 */
export interface ByteChannel {
  /** The next available bytes, or `null` once the peer has closed its end. */
  read(signal?: AbortSignal): Promise<Uint8Array | null>;
  /** Resolves once every byte is written. Aborting after a partial write closes the channel. */
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** Idempotent. */
  close(): void;
}

/** One nonblocking native end. Results are `unknown` and validated here. */
interface NativeChannelEnd {
  readonly read: (max: number) => unknown;
  readonly write: (bytes: Uint8Array) => unknown;
  readonly close: () => unknown;
}

interface ChannelErrors {
  readonly closed: () => Error;
  readonly busy: () => Error;
}

/** Matches the addons' per-call bound. */
const MAX_CHANNEL_CHUNK = 64 * 1024;
// Idle polls back off to the cap, so a long-pending read costs about 20
// wakeups a second; any progress resets the interval.
const CHANNEL_POLL_MIN_MS = 2;
const CHANNEL_POLL_MAX_MS = 50;
const nextPoll = (ms: number): number => Math.min(ms * 2, CHANNEL_POLL_MAX_MS);

/**
 * Polls a nonblocking native end. One read and one write may be pending at a
 * time; a second concurrent call of either kind is refused.
 */
export function createPolledChannel(
  end: NativeChannelEnd,
  errors: ChannelErrors,
): ByteChannel {
  let closed = false;
  let reading = false;
  let writing = false;

  const native = (run: () => unknown): unknown => {
    if (closed) throw errors.closed();
    try {
      return run();
    } catch {
      close();
      throw errors.closed();
    }
  };

  function close(): void {
    if (closed) return;
    closed = true;
    try {
      end.close();
    } catch {
      /* already released with its owner */
    }
  }

  async function read(signal?: AbortSignal): Promise<Uint8Array | null> {
    signal?.throwIfAborted();
    if (reading) throw errors.busy();
    reading = true;
    let wait = CHANNEL_POLL_MIN_MS;
    try {
      for (;;) {
        const result = native(() => end.read(MAX_CHANNEL_CHUNK));
        if (result === null) return null;
        if (!(result instanceof Uint8Array)) {
          close();
          throw errors.closed();
        }
        if (result.byteLength > 0) return result;
        await delay(wait);
        wait = nextPoll(wait);
        signal?.throwIfAborted();
      }
    } finally {
      reading = false;
    }
  }

  async function write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (writing) throw errors.busy();
    writing = true;
    let offset = 0;
    let wait = CHANNEL_POLL_MIN_MS;
    try {
      while (offset < bytes.byteLength) {
        const chunk = bytes.subarray(offset, offset + MAX_CHANNEL_CHUNK);
        const written = native(() => end.write(chunk));
        if (
          typeof written !== 'number' ||
          !Number.isSafeInteger(written) ||
          written < 0 ||
          written > chunk.byteLength
        ) {
          close();
          throw errors.closed();
        }
        offset += written;
        if (offset >= bytes.byteLength) return;
        if (written > 0) wait = CHANNEL_POLL_MIN_MS;
        else {
          await delay(wait);
          wait = nextPoll(wait);
        }
        if (signal?.aborted) {
          // A partial frame leaves the stream unusable.
          if (offset > 0) close();
          signal.throwIfAborted();
        }
      }
    } finally {
      writing = false;
    }
  }

  return Object.freeze({ read, write, close });
}

/**
 * Synchronous rollbacks for owned trees the host could exit past.
 * `process.exit()` skips addon teardown and every pending timer, so the
 * `exit` listener is the last point at which a tree can still be stopped. It
 * is installed only while something is held. Package-internal: execution
 * processes hold their POSIX groups here too.
 */
export interface ExitCustody {
  /** Holds `rollback` until the returned release runs; a second release is a no-op. */
  hold(rollback: () => void): () => void;
}

export function createExitCustody(): ExitCustody {
  const held = new Set<() => void>();
  const onExit = (): void => {
    for (const rollback of Array.from(held)) {
      try {
        rollback();
      } catch {
        // One failed rollback must not skip the others.
      }
    }
  };
  return {
    hold(rollback) {
      // A distinct entry per hold, so one rollback may be held twice.
      const entry = (): void => rollback();
      if (held.size === 0) process.on('exit', onExit);
      held.add(entry);
      return () => {
        if (held.delete(entry) && held.size === 0) process.off('exit', onExit);
      };
    },
  };
}

/** Undecided children are rolled back at host exit, through `custody`. */
interface Owner {
  readonly native: OwnedChildNative;
  readonly custody: ExitCustody;
}

const observeRecord = (native: OwnedChildNative, handle: object): Observation =>
  parseObservation(call(() => native.observe(handle)));

const releaseStoppedGroup = (
  native: OwnedChildNative,
  handle: object,
): boolean =>
  call(() => {
    try {
      return native.release(handle);
    } catch (error) {
      // An incomplete group listing is not lost ownership. Retry within the
      // cleanup deadline, retaining the unreaped root until absence is proven.
      if (field(error, 'code') === 'ERR_OWNED_CHILD_ENUMERATION') return false;
      throw error;
    }
  }) === true;

/**
 * The one stop path for held records, daemon roots and launched execution
 * children alike: stops the group (or job) until the root is reaped and no
 * member remains, within the cleanup deadline.
 */
async function stopRecord(
  native: OwnedChildNative,
  handle: object,
  observe: () => Observation,
): Promise<void> {
  const deadline = performance.now() + CLEANUP_DEADLINE_MS;
  for (;;) {
    const observation = observe();
    if (observation.state === 'lost') throw fail('unavailable', LOST);
    // Reaping is refused while any group member remains.
    if (observation.state === 'exited' && releaseStoppedGroup(native, handle))
      return;
    call(() => native.stopGroup(handle));
    if (performance.now() >= deadline) throw fail('unavailable', UNCONFIRMED);
    await delay(STOP_POLL_MS);
  }
}

function createChild(
  owner: Owner,
  handle: object,
  pid: number,
): PlatformOwnedChild {
  const { native } = owner;
  let state: 'owned' | 'committed' | 'released' = 'owned';
  let stopRequested = false;
  let stopping: Promise<void> | undefined;
  let exitObserved = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: { resolve: (exit: Exit) => void; reject: (error: Error) => void };
  const exited = new Promise<Exit>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Consumers may never await `exited`; a lost root must not crash the host.
  exited.catch(() => undefined);

  const observe = (): Observation => {
    const observation = observeRecord(native, handle);
    if (
      observation.state === 'exited' &&
      !exitObserved &&
      state !== 'committed'
    ) {
      exitObserved = true;
      settle.resolve({ code: observation.code, signal: observation.signal });
    }
    if (observation.state === 'lost') settle.reject(fail('unavailable', LOST));
    return observation;
  };

  const rollbackOnExit = (): void => {
    let cleaned = false;
    try {
      cleaned = call(() => native.rollbackSync(handle)) === true;
    } catch {
      cleaned = false;
    }
    if (cleaned) state = 'released';
    else if (state === 'owned') process.stderr.write(`${UNCONFIRMED}\n`);
  };
  const releaseCustody = owner.custody.hold(rollbackOnExit);

  // A committed root is reaped once it exits; it no longer keeps the host alive.
  const releaseCommitted = (observation: Exit): void => {
    try {
      if (call(() => native.release(handle)) !== true)
        throw fail('unavailable', LOST);
      state = 'released';
      settle.resolve({ code: observation.code, signal: observation.signal });
    } catch {
      settle.reject(fail('unavailable', LOST));
    }
  };

  const poll = (): void => {
    timer = undefined;
    let observation: Observation;
    try {
      observation = observe();
    } catch (error) {
      settle.reject(error instanceof Error ? error : fail('unavailable', LOST));
      return;
    }
    if (observation.state === 'lost') return;
    if (observation.state === 'exited') {
      if (state === 'committed') releaseCommitted(observation);
      return;
    }
    schedule();
  };

  // Owned polling stays referenced: the host cannot exit past an undecided child.
  function schedule(): void {
    if (state === 'released') return;
    const committed = state === 'committed';
    timer = setTimeout(poll, committed ? COMMITTED_POLL_MS : OWNED_POLL_MS);
    if (committed) timer.unref();
  }

  async function stop(): Promise<void> {
    await stopRecord(native, handle, observe);
    state = 'released';
    releaseCustody();
    if (timer) clearTimeout(timer);
  }

  const child: PlatformOwnedChild = {
    pid,
    exited,
    commit(signal) {
      signal?.throwIfAborted();
      if (state === 'committed') return;
      if (state === 'released' || stopRequested)
        throw fail('failed_precondition', STOPPING);
      // A root that exited before commit leaves its group for terminate().
      if (exitObserved) throw fail('failed_precondition', EXITED);
      call(() => native.commit(handle));
      state = 'committed';
      releaseCustody();
      timer?.unref();
    },
    terminate(signal) {
      if (signal?.aborted)
        return Promise.resolve().then(() => signal.throwIfAborted());
      if (state === 'committed')
        return Promise.reject(fail('failed_precondition', COMMITTED));
      if (state === 'released') return Promise.resolve();
      // Once requested, commit is refused for good. Concurrent callers share
      // one attempt; a failed attempt may be retried.
      stopRequested = true;
      stopping ??= stop().finally(() => {
        stopping = undefined;
      });
      return bounded(stopping, signal);
    },
  };
  schedule();
  return Object.freeze(child);
}

/**
 * A held record's tree: held until it is stopped, or its root has exited and
 * no member remains. `observe` is the record's only observer.
 */
interface HeldTree {
  /**
   * Releases the record once the root has exited and the tree is empty, and
   * reports whether it is released. Never signals.
   */
  settle(): boolean;
  /** As PlatformOwnedChild.terminate, through the same stop path as roots. */
  stop(signal?: AbortSignal): Promise<void>;
  readonly released: boolean;
}

function heldTree(
  owner: Owner,
  handle: object,
  observe: () => Observation,
): HeldTree {
  const { native } = owner;
  let released = false;
  let stopping: Promise<void> | undefined;
  const releaseCustody = owner.custody.hold(() => {
    if (released) return;
    try {
      if (call(() => native.rollbackSync(handle)) === true) return;
    } catch {
      /* reported below */
    }
    process.stderr.write(`${UNCONFIRMED}\n`);
  });
  const done = (): void => {
    released = true;
    releaseCustody();
  };
  return {
    settle(): boolean {
      if (released) return true;
      // A stop under way is the record's only releaser until it settles.
      if (stopping) return false;
      if (observe().state !== 'exited' || !releaseStoppedGroup(native, handle))
        return false;
      done();
      return true;
    },
    stop(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted)
        return Promise.resolve().then(() => signal.throwIfAborted());
      if (released) return Promise.resolve();
      stopping ??= stopRecord(native, handle, observe)
        .then(done)
        .finally(() => {
          stopping = undefined;
        });
      return bounded(stopping, signal);
    },
    get released(): boolean {
      return released;
    },
  };
}

/** An execution child for the launcher; executables and `cwd` fully qualified. */
export interface LaunchRequest {
  /** The file CreateProcessW starts. */
  readonly executable: string;
  /** The child's argv, argv[0] included. */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The complete child environment; nothing is inherited. */
  readonly environment: Readonly<Record<string, string>>;
  /** A stdin pipe; NUL otherwise. */
  readonly stdin: boolean;
}

/**
 * A Windows execution child created suspended inside its owned job, so no
 * descendant can start outside it. Package-internal.
 */
export interface LaunchedTree {
  readonly pid: number;
  /** Named pipes the caller connects to, as their only client, before `resume`. */
  readonly pipes: {
    readonly stdin: string | null;
    readonly stdout: string;
    readonly stderr: string;
  };
  /**
   * Runs the child. Throws `failed_precondition` unless this process is the
   * client of every pipe; the caller then stops the tree, which ends the
   * child before it ran.
   */
  resume(): void;
  /**
   * The root's exit, polled from `resume`, or seen by a stop or settle.
   * Rejects with `unavailable` when ownership is lost. A tree its owner
   * stopped reports SIGKILL and no code.
   */
  readonly exited: Promise<Exit>;
  /**
   * Releases the record once the root has exited and the tree is empty, and
   * reports whether it is released. Never signals.
   */
  settle(): boolean;
  /** As PlatformOwnedChild.terminate, through the same stop path as roots. */
  stop(signal?: AbortSignal): Promise<void>;
}

function launchedTree(
  owner: Owner & { readonly native: OwnedChildLaunchNative },
  handle: object,
  pid: number,
  pipes: LaunchedTree['pipes'],
): LaunchedTree {
  const { native } = owner;
  let exitSeen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: { resolve: (exit: Exit) => void; reject: (error: Error) => void };
  const exited = new Promise<Exit>((resolve, reject) => {
    settle = { resolve, reject };
  });
  exited.catch(() => undefined);
  const observe = (): Observation => {
    const observation = observeRecord(native, handle);
    if (observation.state === 'exited' && !exitSeen) {
      exitSeen = true;
      settle.resolve({ code: observation.code, signal: observation.signal });
    }
    if (observation.state === 'lost') settle.reject(fail('unavailable', LOST));
    return observation;
  };
  const tree = heldTree(owner, handle, observe);
  // Referenced, as Node's own child handles are, until the exit is seen.
  const poll = (): void => {
    timer = undefined;
    if (exitSeen || tree.released) return;
    try {
      if (observe().state === 'running')
        timer = setTimeout(poll, OWNED_POLL_MS);
    } catch (error) {
      settle.reject(error instanceof Error ? error : fail('unavailable', LOST));
    }
  };
  return Object.freeze({
    pid,
    pipes,
    resume(): void {
      call(() => native.resume(handle));
      timer ??= setTimeout(poll, OWNED_POLL_MS);
    },
    exited,
    settle: (): boolean => tree.settle(),
    stop: (signal?: AbortSignal): Promise<void> => tree.stop(signal),
  });
}

/** Package-internal: Windows execution children started inside owned jobs. */
export interface JobLauncher {
  /** Loads the addon; throws `capability_unavailable` when launching is unavailable. */
  ready(): void;
  /** Creates the child suspended inside an owned job. */
  launch(request: LaunchRequest): LaunchedTree;
}

interface OwnedChildHost extends JobLauncher {
  readonly services: OwnedChildServices;
}

function createOwnedChildHost(options: {
  readonly os: PlatformOperatingSystem;
  readonly nativePath: string;
}): OwnedChildHost {
  const { os, nativePath } = options;
  let native: OwnedChildNative | undefined;
  const custody = createExitCustody();
  let undelivered = false;
  // Native records survive a failed handle construction until host cleanup.
  const keepUndelivered = (error: unknown): void => {
    if (
      !(error instanceof OwnedChildError) ||
      error.code !== 'unavailable' ||
      undelivered ||
      !native
    )
      return;
    undelivered = true;
    const loaded = native;
    custody.hold(() => {
      try {
        if (call(() => loaded.rollbackUndelivered()) === true) return;
      } catch {
        /* reported below */
      }
      process.stderr.write(`${UNCONFIRMED}\n`);
    });
  };
  // Native calls are synchronous; a throw keeps undelivered records held.
  const retaining = (run: () => unknown): unknown => {
    try {
      return call(run);
    } catch (error) {
      keepUndelivered(error);
      throw error;
    }
  };
  const delivered = (result: unknown, expected?: number): object => {
    const handle = field(result, 'handle');
    const pid = field(result, 'pid');
    if (
      typeof handle !== 'object' ||
      handle === null ||
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      (expected !== undefined && pid !== expected)
    )
      throw fail('unavailable', LOST);
    return handle;
  };
  const spawnNow = (
    request: SpawnRequest,
    withChannel: boolean,
  ): { child: PlatformOwnedChild; channel?: OwnedChildChannel } => {
    const supported = SPAWN_HOSTS.has(os);
    if (!supported) throw fail('capability_unavailable', UNSUPPORTED);
    const args = nativeRequest(os, request, withChannel);
    const loaded = (native ??= loadNative(os, nativePath));
    const channelNative = hasChannel(loaded) ? loaded : undefined;
    if (withChannel && !channelNative)
      throw fail('capability_unavailable', UNSUPPORTED);
    const result = retaining(() =>
      withChannel && channelNative
        ? os === 'win32'
          ? channelNative.spawnChannel(...args, randomBytes(16).toString('hex'))
          : channelNative.spawnChannel(...args)
        : loaded.spawn(...args),
    );
    const handle = delivered(result);
    const pid = Number(field(result, 'pid'));
    const child = createChild({ native: loaded, custody }, handle, pid);
    return withChannel && channelNative
      ? { child, channel: createChannel(channelNative, handle, os) }
      : { child };
  };
  const services: OwnedChildServices = {
    // Native spawn is synchronous; any throw becomes the rejection.
    spawn: (request) =>
      new Promise((resolve) => resolve(spawnNow(request, false).child)),
    spawnWithChannel: (request) =>
      new Promise((resolve) => {
        const { child, channel } = spawnNow(request, true);
        if (!channel) throw fail('unavailable', LOST);
        resolve({ child, channel });
      }),
  };
  const launcher = (): OwnedChildNative & OwnedChildLaunchNative => {
    if (os !== 'win32') throw fail('capability_unavailable', UNSUPPORTED);
    const loaded = (native ??= loadNative(os, nativePath));
    if (!hasLaunch(loaded)) throw fail('capability_unavailable', UNSUPPORTED);
    return loaded;
  };
  return {
    services: Object.freeze(services),
    ready(): void {
      launcher();
    },
    launch(request: LaunchRequest): LaunchedTree {
      const loaded = launcher();
      const { executable, argv, cwd, environment, stdin } = request;
      const [file, args, pairs] = nativeRequest(os, {
        executable,
        args: argv,
        environment,
      });
      if (!fullyQualified(os, cwd) || typeof stdin !== 'boolean')
        throw fail('invalid_argument', INVALID);
      const result = retaining(() =>
        loaded.launch(
          file,
          args.slice(1),
          pairs,
          cwd,
          randomBytes(16).toString('hex'),
          stdin,
        ),
      );
      const handle = delivered(result);
      const pipe = (key: string): string | null => {
        const value = field(result, key);
        if (value === null || typeof value === 'string') return value;
        throw fail('unavailable', LOST);
      };
      const [stdinPipe, stdoutPipe, stderrPipe] = [
        pipe('stdin'),
        pipe('stdout'),
        pipe('stderr'),
      ];
      if (
        stdoutPipe === null ||
        stderrPipe === null ||
        (stdinPipe === null) === stdin
      )
        throw fail('unavailable', LOST);
      return launchedTree(
        { native: loaded, custody },
        handle,
        Number(field(result, 'pid')),
        { stdin: stdinPipe, stdout: stdoutPipe, stderr: stderrPipe },
      );
    },
  };
}

/**
 * Owned daemon roots for startup rollback, on Darwin and Linux (a process
 * group held by its unreaped root) and Windows (a kill-on-close job held with
 * the root's process handle). `spawnWithChannel` supports Darwin, Linux and Windows;
 * other hosts reject it with `capability_unavailable`. Executables and the addon
 * path must be fully qualified for `os`; ordinary Windows `spawn` refuses
 * `stdin`. The addon loads on first spawn.
 */
export function createOwnedChildServices(options: {
  readonly os: PlatformOperatingSystem;
  readonly nativePath: string;
}): OwnedChildServices {
  return createOwnedChildHost(options).services;
}

/**
 * Windows execution children, held and stopped exactly like daemon roots: one
 * kill-on-close job per child that forbids breakaway, which the child is
 * created suspended inside, so no descendant can start outside it. Other
 * hosts and an addon without `launch` report `capability_unavailable`.
 * Package-internal: execution processes use it.
 */
export function createJobLauncher(options: {
  readonly os: PlatformOperatingSystem;
  readonly nativePath: string;
}): JobLauncher {
  const host = createOwnedChildHost(options);
  return Object.freeze({
    ready: (): void => host.ready(),
    launch: (request: LaunchRequest): LaunchedTree => host.launch(request),
  });
}

/** Host-injected offline filesystem custody; absent/stale addons fail closed. */
export function loadMigrationFilesystem(
  nativePath: string,
): (
  action:
    | 'inspect'
    | 'mkdir'
    | 'copy'
    | 'finish'
    | 'read'
    | 'remove'
    | 'replace',
  path: string,
  other?: string,
) => unknown {
  const native = loadNative('win32', nativePath);
  const operation = field(native, 'migrationFilesystem');
  if (typeof operation !== 'function')
    throw fail('capability_unavailable', UNSUPPORTED);
  return (action, path, other): unknown =>
    Reflect.apply(
      operation,
      native,
      other === undefined ? [action, path] : [action, path, other],
    );
}

/** Linux directory publication has no safe plain-Node no-replace equivalent. */
export function loadMigrationRenameNoReplace(
  nativePath: string,
): (from: string, to: string, identity: string) => void {
  const native = loadNative('linux', nativePath);
  const operation = field(native, 'migrationRenameNoReplace');
  if (typeof operation !== 'function')
    throw fail('capability_unavailable', UNSUPPORTED);
  return (from, to, identity): void => {
    if (Reflect.apply(operation, native, [from, to, identity]) !== true)
      throw fail('failed_precondition', UNCONFIRMED);
  };
}
