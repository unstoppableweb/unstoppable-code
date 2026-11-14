import { createHash, randomBytes } from 'node:crypto';
import { constants, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CanopyClientError } from '../errors';
import type { DaemonOwnerCredential } from './daemon-owner';
import type { CanopyRuntimeDescriptorSource } from './daemon-ports';
import { canopyConnectError } from './endpoint';
import type {
  CanopyDaemonBeforeSpawn,
  CanopyDaemonLaunchOptions,
} from './launcher';
import type {
  CanopyDaemonSupervisor,
  CanopySpawnedDaemon,
  CanopyStartupClaimPort,
} from './launcher-ports';

type Environment = Readonly<Record<string, string | undefined>>;

/** Structural subset of core-runtime's `PlatformSupervisionServices`. */
export interface CanopyDaemonHostSupervision {
  childEnvironment(request: {
    readonly source: Environment;
  }): Readonly<Record<string, string>>;
  inspectProcess(request: {
    readonly pid: number;
    readonly signal?: AbortSignal;
  }): Promise<
    | { readonly state: 'running'; readonly startIdentity: string }
    | { readonly state: 'absent' | 'unverifiable' }
  >;
}

/** Host-only structural ownership port; native handles stay inside the platform adapter. */
export interface CanopyOwnedDaemonChild extends CanopySpawnedDaemon {
  commit(signal?: AbortSignal): void;
  terminate(signal?: AbortSignal): Promise<void>;
}
export interface CanopyOwnedDaemonChildren {
  spawn(request: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly stdin?: string;
  }): Promise<CanopyOwnedDaemonChild>;
}

export interface CanopyDaemonMigrationLaunch {
  spawn(
    request: Parameters<CanopyOwnedDaemonChildren['spawn']>[0],
    auth: { readonly secret: string; readonly dataRootHash: string },
    signal: AbortSignal,
  ): Promise<CanopyOwnedDaemonChild>;
}

/** Trusted host inputs only; never renderer- or operation-supplied. */
export interface CanopyDaemonHostLaunchOptions {
  /** Absolute canonical data root. */
  readonly dataRoot: string;
  readonly runtimeMode: 'prod' | 'rc' | 'dev';
  readonly secureStorageLayout?: string;
  /** Absolute, already-resolved daemon executable; the only one spawned. */
  readonly executable: string;
  readonly platform: 'darwin' | 'win32' | 'linux';
  readonly supervision: CanopyDaemonHostSupervision;
  readonly ownedChildren?: CanopyOwnedDaemonChildren;
  /** Electron main's private launcher adapter; absent for CLI and every generic host. */
  readonly migration?: CanopyDaemonMigrationLaunch;
  /** Electron main only (CAN-5771): every spawn hands the daemon a fresh owner secret on stdin. */
  readonly ownerCredential?: DaemonOwnerCredential;
  /** Every spawn from this launch opens the W5 host; see the launcher's `w5Host`. */
  readonly w5Host?: boolean;
  /** Shared by every attach-or-start on this launch, so each spawn runs it. */
  readonly beforeSpawn?: CanopyDaemonBeforeSpawn;
  /** Child allowlist plus explicit storage overrides, resolved against the host cwd. */
  readonly environmentSource: Environment;
  readonly claim?: CanopyStartupClaimPort;
  /** Creates and verifies the private runtime directory before each descriptor read. */
  readonly prepareRuntime: (signal: AbortSignal) => Promise<void>;
  /** The only endpoint a descriptor may name. */
  readonly expectedEndpoint: {
    readonly kind: 'socket' | 'pipe';
    readonly path: string;
  };
  /** Rejects unless the file is private to this user. */
  readonly verifyPrivateFile: (
    filePath: string,
    signal: AbortSignal,
  ) => Promise<void>;
}

export type CanopyDaemonHostLaunch = Omit<
  CanopyDaemonLaunchOptions<never>,
  'attach' | 'dispose' | 'signal'
> & {
  /** The host guards transport setup with the same directory identity as discovery. */
  readonly verifyRuntime: (signal: AbortSignal) => Promise<void>;
};

/** Value-free marker: the claim handle follows on stdin, never in argv or env. */
export const CANOPY_DAEMON_CLAIM_HANDOFF_ENV = 'CANOPY_DAEMON_CLAIM_HANDOFF';
/** The handoff marker whose stdin payload also carries an owner secret (CAN-5771). */
export const CANOPY_DAEMON_OWNER_HANDOFF = 'stdin-owner-v1';
const MAX_HANDOFF_BYTES = 4096;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILE_OBSERVATIONS = 3;
const FORCED_STOP_MS = 2_000;
const TOKEN_NAME =
  /^core-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.token$/;

const failure = (message: string): CanopyClientError =>
  canopyConnectError('failed_precondition', message);

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

const absent = (error: unknown): boolean => field(error, 'code') === 'ENOENT';

/** Composes launcher inputs; the caller adds attach, dispose, and its signal. */
export function createCanopyDaemonHostLaunch(
  options: CanopyDaemonHostLaunchOptions,
): CanopyDaemonHostLaunch {
  const { dataRoot, executable, platform, supervision } = options;
  const { expectedEndpoint } = options;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(dataRoot) || !paths.isAbsolute(executable))
    throw canopyConnectError(
      'invalid_argument',
      'Host paths must be absolute.',
    );
  const runtime = paths.join(dataRoot, 'runtime');
  let runtimeIdentity: { dev: number; ino: number } | undefined;
  async function verifyRuntime(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const missing = (): never => {
      signal.throwIfAborted();
      throw failure('Core runtime directory is unavailable.');
    };
    const stat = await lstat(runtime).catch(missing);
    if (
      !stat.isDirectory() ||
      (await realpath(runtime).catch(missing)) !== runtime ||
      (runtimeIdentity &&
        (runtimeIdentity.dev !== stat.dev || runtimeIdentity.ino !== stat.ino))
    )
      throw failure('Core runtime directory was replaced.');
    runtimeIdentity ??= { dev: stat.dev, ino: stat.ino };
    signal.throwIfAborted();
  }
  async function prepare(signal: AbortSignal): Promise<void> {
    try {
      if (runtimeIdentity) await verifyRuntime(signal);
      await options.prepareRuntime(signal);
      await verifyRuntime(signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof CanopyClientError) throw error;
      throw failure('Core runtime directory validation failed.');
    }
  }

  /** A private, non-symlink, bounded regular file, or `null` when absent. Never unlinks. */
  async function readPrivate(
    file: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_FILE_OBSERVATIONS; attempt++) {
      signal.throwIfAborted();
      const before = await lstat(file, { bigint: true }).catch((error) => {
        if (absent(error)) return null;
        throw error;
      });
      if (before === null) return null;
      if (before.isSymbolicLink())
        throw failure('Core runtime file is a symbolic link.');
      try {
        try {
          await options.verifyPrivateFile(file, signal);
        } catch {
          signal.throwIfAborted();
          const current = await lstat(file, { bigint: true }).catch((error) => {
            if (absent(error)) return null;
            throw error;
          });
          // Publication can unlink the verifier's open inode. Revalidate the new path.
          if (
            current === null ||
            current.dev !== before.dev ||
            current.ino !== before.ino
          )
            continue;
          throw failure('Core runtime file is exposed.');
        }
        signal.throwIfAborted();
        const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
        const handle = await open(file, flags);
        try {
          const stat = await handle.stat({ bigint: true });
          // Never read a replacement that the permission check did not validate.
          if (stat.dev !== before.dev || stat.ino !== before.ino) continue;
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
            throw failure('Core runtime file is not a bounded regular file.');
          return await handle.readFile({ encoding: 'utf8', signal });
        } finally {
          await handle.close();
        }
      } catch (error) {
        signal.throwIfAborted();
        if (absent(error)) continue;
        throw error;
      }
    }
    // Churn is not absence: neither spawn from it nor call a live token missing.
    signal.throwIfAborted();
    throw failure('Core runtime file changed during read.');
  }

  const isOwnToken = (ref: unknown): ref is string =>
    typeof ref === 'string' &&
    paths.dirname(ref) === runtime &&
    TOKEN_NAME.test(paths.basename(ref));

  const descriptor: CanopyRuntimeDescriptorSource = {
    async read(signal) {
      await prepare(signal);
      const text = await readPrivate(paths.join(runtime, 'core.json'), signal);
      await verifyRuntime(signal);
      if (text === null) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw failure('Core runtime descriptor is malformed.');
      }
      // Foreign references fail closed before any token read or connect.
      const endpoint = field(raw, 'endpoint');
      if (
        field(endpoint, 'kind') !== expectedEndpoint.kind ||
        field(endpoint, 'path') !== expectedEndpoint.path ||
        !isOwnToken(field(raw, 'tokenRef'))
      )
        throw failure('Core runtime descriptor names a foreign reference.');
      return raw;
    },
    async readToken(tokenRef, signal) {
      if (!isOwnToken(tokenRef))
        throw failure('Core token reference is foreign.');
      await prepare(signal);
      const secret = await readPrivate(tokenRef, signal);
      await verifyRuntime(signal);
      if (secret === null || !/^[0-9a-f]{64}$/.test(secret))
        throw failure('Core token is missing or malformed.');
      return secret;
    },
  };

  const owned = new WeakMap<
    CanopySpawnedDaemon,
    {
      child: CanopyOwnedDaemonChild;
      removeAbort: () => void;
    }
  >();

  const supervisor: CanopyDaemonSupervisor = {
    async inspectProcess(pid, signal) {
      const observed = await supervision.inspectProcess({ pid, signal });
      if (observed.state === 'running')
        return { startIdentity: observed.startIdentity };
      if (observed.state === 'absent') return null;
      throw canopyConnectError(
        'capability_unavailable',
        'Core process identity is unverifiable on this host.',
      );
    },

    async spawnDaemon(command) {
      command.signal.throwIfAborted();
      await prepare(command.signal);
      if (command.executable !== executable)
        throw failure('Core executable is not the trusted host executable.');
      const { claimHandle } = command;
      const migrationAuth = options.migration
        ? {
            secret: randomBytes(32).toString('hex'),
            dataRootHash: createHash('sha256').update(dataRoot).digest('hex'),
          }
        : undefined;
      const ownerCredential = migrationAuth
        ? undefined
        : options.ownerCredential;
      const handoff = migrationAuth
        ? JSON.stringify({ claim: claimHandle ?? null, auth: migrationAuth })
        : ownerCredential
          ? JSON.stringify({
              claim: claimHandle ?? null,
              owner: { secret: ownerCredential.rotate() },
            })
          : claimHandle && JSON.stringify(claimHandle);
      if (handoff && Buffer.byteLength(handoff) > MAX_HANDOFF_BYTES)
        throw failure('Core startup claim handoff is too large.');
      const env: Record<string, string> = {
        ...supervision.childEnvironment({ source: options.environmentSource }),
        ...(handoff
          ? {
              [CANOPY_DAEMON_CLAIM_HANDOFF_ENV]: migrationAuth
                ? 'stdin-migration-v1'
                : ownerCredential
                  ? CANOPY_DAEMON_OWNER_HANDOFF
                  : 'stdin-v1',
            }
          : {}),
      };
      for (const name of ['CANOPY_DATA_DIR', 'CANOPY_SECURE_DATA_DIR']) {
        const values = Object.entries(options.environmentSource)
          .filter(
            ([key, value]) =>
              (platform === 'win32' ? key.toUpperCase() : key) === name &&
              value !== undefined,
          )
          .map(([, value]) => value);
        if (new Set(values).size > 1)
          throw failure('Conflicting storage override environment values.');
        const value = values[0]?.trim();
        // Owned children need not inherit the launcher's working directory.
        if (value) env[name] = paths.resolve(value);
      }
      const children = options.ownedChildren;
      if (!children)
        throw canopyConnectError(
          'capability_unavailable',
          'Core child ownership is unavailable.',
        );
      const spawnRequest = {
        executable,
        args: command.args,
        environment: env,
        ...(handoff ? { stdin: handoff } : {}),
      };
      const child = await (
        options.migration && migrationAuth
          ? options.migration.spawn(spawnRequest, migrationAuth, command.signal)
          : children.spawn(spawnRequest)
      ).catch((error: unknown) => {
        if (field(error, 'code') === 'unavailable')
          throw Object.assign(
            canopyConnectError('unavailable', 'Core cleanup failed.'),
            {
              cleanupUnconfirmed: true,
            },
          );
        throw field(error, 'code') === 'capability_unavailable'
          ? canopyConnectError(
              'capability_unavailable',
              'Core child ownership is unavailable.',
            )
          : failure('Core executable could not be started.');
      });
      ownerCredential?.recordSpawn({ pid: child.pid });
      const daemon: CanopySpawnedDaemon = {
        pid: child.pid,
        exited: child.exited,
      };
      const abort = (): void => {
        // The launcher joins this same idempotent cleanup and reports any failure.
        void child
          .terminate(AbortSignal.timeout(FORCED_STOP_MS))
          .catch(() => undefined);
      };
      const removeAbort = (): void =>
        command.signal.removeEventListener('abort', abort);
      owned.set(daemon, { child, removeAbort });
      command.signal.addEventListener('abort', abort, { once: true });
      if (command.signal.aborted) abort();
      return daemon;
    },

    commitDaemon(daemon, signal) {
      const state = owned.get(daemon);
      if (!state) throw failure('Core process is not owned by this host.');
      state.child.commit(signal);
      state.removeAbort();
    },

    async terminateDaemon(daemon, signal) {
      const state = owned.get(daemon);
      if (!state) throw failure('Core process is not owned by this host.');
      try {
        await state.child.terminate(signal);
        state.removeAbort();
      } catch {
        throw canopyConnectError(
          'unavailable',
          'Core process cleanup could not be confirmed.',
        );
      }
    },
  };

  return {
    verifyRuntime: prepare,
    dataRoot,
    dataRootHash: createHash('sha256').update(dataRoot).digest('hex'),
    runtimeMode: options.runtimeMode,
    secureStorageLayout: options.secureStorageLayout,
    daemon: {
      executable,
      ...(options.migration && { migrationChannel: true }),
      ...(options.w5Host && { w5Host: true }),
    },
    ...(options.beforeSpawn && { beforeSpawn: options.beforeSpawn }),
    ports: {
      descriptor,
      supervisor,
      ...(options.claim ? { claim: options.claim } : {}),
    },
    platform,
  };
}
