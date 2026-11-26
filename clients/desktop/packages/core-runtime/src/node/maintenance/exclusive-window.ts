import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  PlatformServices,
  PlatformSocketProbeResult,
  PlatformUnixSocketAddress,
} from '../../platform/platform-services';
import type { StorageWriterPrincipal } from '../../storage/writer-authority';
import type { EndpointRepairClaimPort } from '../daemon/repair';
import { createW5EndpointDescriptorProof } from '../w5/endpoint-descriptor-proof';
import type {
  W5MaintenanceDependencies,
  W5MaintenanceExclusion,
  W5MaintenancePresence,
} from '../w5/maintenance';
import { W5MaintenanceRefusedError } from '../w5/maintenance-types';

/**
 * D23: the most a window may stay held, including any daemon wait the caller
 * spends before calling. Callers start their own `signal` before that wait.
 */
export const EXCLUSIVE_MAINTENANCE_CAP_MS = 120_000;

/** Writers that join W5 root presence, so presence EXCLUSIVE stops them. */
const PRESENCE_PRINCIPALS: ReadonlySet<StorageWriterPrincipal> = new Set([
  'electron_main',
  'desktop_cli',
  'daemon',
]);

export type ExclusiveMaintenanceRefusal =
  | 'invalid-request'
  /** Windows has no root presence qualification yet (CAN-4732, CAN-4929). */
  | 'platform-unsupported'
  /** This process already joined, or is joining, root presence. */
  | 'caller-admitted'
  /** A target declares a writer that root presence does not stop. */
  | 'writer-unexcluded'
  | 'runtime-unavailable'
  | 'identity-unprovable'
  /** A held claim, live endpoint or owner, busy presence or live record. */
  | 'host-active'
  | 'claim-ambiguous'
  | 'endpoint-unavailable'
  | 'cohort-ambiguous'
  /** A target root is unreadable or unmounted; never treated as empty. */
  | 'root-unavailable'
  /** A target root's identity changed while the window was held. */
  | 'root-changed'
  | 'hold-lost'
  /** The caller's signal or the cap fired before `op` or in `assertHeld`. */
  | 'aborted'
  /** A mutating `op` failed, so every hold is kept. */
  | 'outcome-uncertain'
  | 'release-uncertain';

export class ExclusiveMaintenanceRefusedError extends Error {
  readonly reason: ExclusiveMaintenanceRefusal;
  /** Advisory host labels for `host-active`, from the host cohort only. */
  readonly peers: readonly string[];
  /** The window kept its holds; the calling process must exit to free them. */
  readonly held: boolean;
  readonly underlying: unknown;
  constructor(
    reason: ExclusiveMaintenanceRefusal,
    details: {
      readonly cause?: unknown;
      readonly peers?: readonly string[];
      readonly held?: boolean;
    } = {},
  ) {
    super(`Exclusive offline maintenance refused (${reason}).`);
    this.name = 'ExclusiveMaintenanceRefusedError';
    this.reason = reason;
    this.underlying = details.cause;
    this.peers = details.peers ?? [];
    this.held = details.held ?? false;
  }
}

/** Read-only access that target descriptors enumerate their roots through. */
export interface OfflineReadPort {
  /** Undefined when the file is absent. */
  readFile(path: string): Promise<Uint8Array | undefined>;
  /** Undefined when the directory is absent. */
  readDirectory(path: string): Promise<readonly string[] | undefined>;
}

/** One storage row, or named subpaths of it (D18). */
export interface ExclusiveMaintenanceTargetKey {
  readonly row: string;
  readonly subpaths?: readonly string[];
}

export interface ExclusiveMaintenanceTargetRoot {
  /** Absolute and normalized. */
  readonly path: string;
  /**
   * `data`: under the data root, canonical, absent allowed. `external`: a
   * user folder such as a Cowork root, pinned by real path and inode (D19).
   */
  readonly placement: 'data' | 'external';
}

/** The part of a store's maintenance descriptor the window consumes. */
export interface ExclusiveMaintenanceTarget {
  readonly key: ExclusiveMaintenanceTargetKey;
  /** Every principal that writes the target. */
  readonly principals: readonly StorageWriterPrincipal[];
  roots(
    read: OfflineReadPort,
  ): Promise<readonly ExclusiveMaintenanceTargetRoot[]>;
}

export interface HeldTargetRoot {
  readonly key: ExclusiveMaintenanceTargetKey;
  readonly placement: 'data' | 'external';
  readonly declaredPath: string;
  /** The real path `op` uses. */
  readonly path: string;
  readonly state: 'present' | 'absent';
}

export interface ExclusiveMaintenanceWindow {
  readonly dataRoot: string;
  readonly roots: readonly HeldTargetRoot[];
  /**
   * The caller's signal combined with the window's cap. `op` must honour it:
   * the window never preempts `op`, and its check after `op` ignores it.
   */
  readonly signal: AbortSignal;
  /** Call after each step; refuses unless every hold and root is unchanged. */
  assertHeld(): Promise<void>;
}

export interface ExclusiveMaintenanceDependencies extends Pick<
  W5MaintenanceDependencies,
  'acquirePresence' | 'acquireExclusion'
> {
  readonly claims: EndpointRepairClaimPort;
  readonly platform: Pick<
    PlatformServices,
    'supervision' | 'secureFiles' | 'endpoints'
  >;
  /** True while this process holds or is joining root presence for the root. */
  callerJoinedPresence(dataRoot: string): Promise<boolean>;
  readonly read: OfflineReadPort;
  /** `listW5HostPeers`; never `listW5RootPresencePeers`, which prunes. */
  listHostPeers?(): Promise<readonly string[]>;
}

export interface ExclusiveMaintenanceOptions {
  /** Canonical data root. */
  readonly dataRoot: string;
  readonly targets: readonly ExclusiveMaintenanceTarget[];
  readonly os: 'darwin' | 'linux' | 'win32';
  readonly deps: ExclusiveMaintenanceDependencies;
  readonly signal?: AbortSignal;
  /**
   * An `op` that may write. A failed or uncertain mutating window keeps every
   * hold and its process must exit (D17); a read-only one always releases.
   */
  readonly mutating: boolean;
}

// Kept reachable so collection never closes a hold a mutating window kept.
const retainedHolds = new Set<object>();

function refuse(reason: ExclusiveMaintenanceRefusal, cause?: unknown): never {
  throw new ExclusiveMaintenanceRefusedError(reason, { cause });
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

function isInside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
}

function targetKeyText(key: ExclusiveMaintenanceTargetKey): string {
  return JSON.stringify([key.row, [...(key.subpaths ?? [])].sort()]);
}

function validateTargets(targets: readonly ExclusiveMaintenanceTarget[]): void {
  if (!targets.length) refuse('invalid-request');
  const keys = new Set<string>();
  for (const target of targets) {
    const key = targetKeyText(target.key);
    if (!target.key.row || keys.has(key) || !target.principals.length)
      refuse('invalid-request');
    keys.add(key);
    if (target.principals.some((writer) => !PRESENCE_PRINCIPALS.has(writer)))
      refuse('writer-unexcluded');
  }
}

interface PinnedRoot {
  readonly held: HeldTargetRoot;
  /** The inode checked again by every held-check. */
  readonly identityPath: string;
  readonly dev: number;
  readonly ino: number;
}

async function nearestExisting(path: string): Promise<string> {
  for (let current = dirname(path); ; current = dirname(current)) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' || dirname(current) === current)
        throw error;
    }
  }
}

async function pinRoot(
  dataRoot: string,
  key: ExclusiveMaintenanceTargetKey,
  root: ExclusiveMaintenanceTargetRoot,
): Promise<PinnedRoot> {
  const declaredPath = root.path;
  if (
    !isAbsolute(declaredPath) ||
    resolve(declaredPath) !== declaredPath ||
    (root.placement === 'data' && !isInside(dataRoot, declaredPath))
  )
    refuse('invalid-request');
  const pin = async (
    identityPath: string,
    path: string,
    state: 'present' | 'absent',
  ): Promise<PinnedRoot> => {
    const stat = await lstat(identityPath);
    if (!stat.isDirectory()) refuse('root-unavailable');
    return {
      held: { key, placement: root.placement, declaredPath, path, state },
      identityPath,
      dev: stat.dev,
      ino: stat.ino,
    };
  };
  try {
    if (root.placement === 'external') {
      // An unmounted folder reads as absent; it is unavailable, never empty.
      const real = await realpath(declaredPath);
      return await pin(real, real, 'present');
    }
    let stat: Stats | undefined;
    try {
      stat = await lstat(declaredPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    if (stat) {
      if ((await realpath(declaredPath)) !== declaredPath)
        refuse('root-unavailable');
      return await pin(declaredPath, declaredPath, 'present');
    }
    // An absent data root stays absent; its nearest parent must not escape.
    const parent = await nearestExisting(declaredPath);
    if (!isInside(dataRoot, parent) || (await realpath(parent)) !== parent)
      refuse('root-unavailable');
    return await pin(parent, declaredPath, 'absent');
  } catch (error) {
    if (error instanceof ExclusiveMaintenanceRefusedError) throw error;
    refuse('root-unavailable', error);
  }
}

async function rootUnchanged(pinned: PinnedRoot): Promise<boolean> {
  try {
    const { held } = pinned;
    if (held.placement === 'external') {
      if ((await realpath(held.declaredPath)) !== held.path) return false;
    } else if (held.state === 'absent') {
      // `op` may create an absent root; its pinned parent must stay put.
      if ((await realpath(pinned.identityPath)) !== pinned.identityPath)
        return false;
    } else if ((await realpath(held.path)) !== held.path) return false;
    const current = await lstat(pinned.identityPath);
    return (
      current.isDirectory() &&
      current.dev === pinned.dev &&
      current.ino === pinned.ino
    );
  } catch {
    return false;
  }
}

function exclusionRefusal(error: unknown): ExclusiveMaintenanceRefusal {
  const reason: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'reason')
      : undefined;
  return reason === 'host-active'
    ? 'host-active'
    : reason === 'platform-unsupported'
      ? 'platform-unsupported'
      : 'cohort-ambiguous';
}

/**
 * CAN-4498: a store-neutral exclusive offline window over the W5 stack, with
 * no lock of its own. Order: platform, caller, data root and runtime, startup
 * claim, endpoint, descriptor, root presence EXCLUSIVE, the CAN-3797
 * maintenance record, then target roots. Refuses, never waits. A refusal
 * leaves no hold and changes no store byte. Never unlinks an endpoint (D3).
 * Callable only before this process joins root presence; inert until a
 * launch slot calls it (CAN-4735 PR 7).
 */
export async function withExclusiveOfflineMaintenance<T>(
  options: ExclusiveMaintenanceOptions,
  op: (window: ExclusiveMaintenanceWindow) => Promise<T>,
): Promise<T> {
  const { dataRoot, os, deps, mutating } = options;
  const targets = [...options.targets];
  const { platform, claims } = deps;
  const endpoints = platform.endpoints;
  // EAGLE 4: Windows stays in process; refuse before touching anything.
  if (os === 'win32' || endpoints.semantics !== 'filesystem-socket')
    refuse('platform-unsupported');
  validateTargets(targets);
  const signal = AbortSignal.any([
    AbortSignal.timeout(EXCLUSIVE_MAINTENANCE_CAP_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  const checkAborted = (): void => {
    if (signal.aborted) refuse('aborted', signal.reason);
  };
  checkAborted();
  // Advisory only, read after every hold is released.
  const hostPeers = async (): Promise<readonly string[]> =>
    deps.listHostPeers
      ? deps.listHostPeers().catch((): readonly string[] => ['unknown'])
      : [];
  // Presence only: before admission Electron legitimately holds the delete gate.
  const joined = await deps.callerJoinedPresence(dataRoot).catch(() => true);
  if (joined) refuse('caller-admitted');

  const runtime = join(dataRoot, 'runtime');
  async function privateDirectory(path: string): Promise<Stats> {
    const stat = await lstat(path);
    if ((await realpath(path)) !== path || !stat.isDirectory())
      refuse('runtime-unavailable');
    const permission = await platform.secureFiles.permissions({
      path,
      kind: 'directory',
      mode: 'owner-only',
      action: 'verify',
    });
    if (permission.state !== 'private') refuse('runtime-unavailable');
    return stat;
  }
  let runtimeIdentity: Stats;
  try {
    if (!isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot)
      refuse('runtime-unavailable');
    await privateDirectory(dataRoot);
    runtimeIdentity = await privateDirectory(runtime);
  } catch (error) {
    refuse('runtime-unavailable', error);
  }
  const self = await platform.supervision
    .inspectProcess({ pid: process.pid, signal })
    .catch((error: unknown) => refuse('identity-unprovable', error));
  if (self.state !== 'running') refuse('identity-unprovable');
  checkAborted();

  const acquisition = await claims
    .tryAcquire(signal, { recoverDeparted: true })
    .catch((): { readonly kind: 'ambiguous' } => ({ kind: 'ambiguous' }));
  if (acquisition.kind !== 'acquired') {
    checkAborted();
    if (acquisition.kind === 'ambiguous') refuse('claim-ambiguous');
    throw new ExclusiveMaintenanceRefusedError('host-active', {
      peers: await hostPeers(),
    });
  }
  const { handle } = acquisition;
  // An unpublished bind marker is only the next daemon start's to recover.
  const inheritedBind = acquisition.recovered?.endpointBound === true;
  let preserveEndpointBind = inheritedBind;
  let presence: W5MaintenancePresence | undefined;
  let exclusion: W5MaintenanceExclusion | undefined;
  let opStarted = false;
  let succeeded = false;
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  const pinned: PinnedRoot[] = [];

  async function assertHeld(): Promise<void> {
    checkAborted();
    await verifyHolds();
  }

  // Holds and roots only: an `op` that returned under verified holds has a
  // certain outcome even if the cap or the caller aborted meanwhile.
  async function verifyHolds(): Promise<void> {
    try {
      const current = await privateDirectory(runtime);
      if (
        current.dev !== runtimeIdentity.dev ||
        current.ino !== runtimeIdentity.ino
      )
        refuse('hold-lost');
      const claim = await claims.identity(handle);
      if (
        claim?.dataRoot !== dataRoot ||
        !presence?.isHeld() ||
        !(await exclusion?.isHeld())
      )
        refuse('hold-lost');
    } catch (error) {
      if (
        error instanceof ExclusiveMaintenanceRefusedError &&
        error.reason === 'hold-lost'
      )
        throw error;
      refuse('hold-lost', error);
    }
    for (const root of pinned)
      if (!(await rootUnchanged(root))) refuse('root-changed');
  }

  async function proveEndpointStopped(
    address: PlatformUnixSocketAddress,
    expected?: PlatformSocketProbeResult,
  ): Promise<PlatformSocketProbeResult> {
    if (endpoints.semantics !== 'filesystem-socket')
      refuse('platform-unsupported');
    const proof = createW5EndpointDescriptorProof({
      runtime,
      address,
      platform,
      liveOwner: 'host-active',
      signal,
    });
    let probe: PlatformSocketProbeResult;
    try {
      probe = await endpoints.probe(address);
    } catch (error) {
      checkAborted();
      refuse('endpoint-unavailable', error);
    }
    if (probe.state === 'live') refuse('host-active');
    if (
      probe.state === 'ambiguous' ||
      (expected !== undefined &&
        (probe.state !== expected.state ||
          (probe.state === 'refused' &&
            expected.state === 'refused' &&
            (probe.identity.device !== expected.identity.device ||
              probe.identity.inode !== expected.identity.inode))))
    )
      refuse('endpoint-unavailable');
    if (probe.state === 'absent') preserveEndpointBind = false;
    try {
      if (probe.state === 'refused') {
        if (inheritedBind) refuse('endpoint-unavailable');
        await proof.requireStaleSocket(address, probe.identity);
      }
      await proof.verifyDescriptor(await proof.readDescriptor());
    } catch (error) {
      checkAborted();
      if (error instanceof ExclusiveMaintenanceRefusedError) throw error;
      refuse(
        error instanceof W5MaintenanceRefusedError &&
          (error.reason === 'identity-unprovable' ||
            error.reason === 'host-active')
          ? error.reason
          : 'endpoint-unavailable',
        error,
      );
    }
    return probe;
  }

  async function releaseAll(): Promise<{
    readonly released: boolean;
    readonly held: boolean;
  }> {
    const keep = mutating && opStarted && !succeeded;
    if (keep) {
      for (const hold of [presence, exclusion, handle])
        if (hold) retainedHolds.add(hold);
      return { released: false, held: true };
    }
    let exclusionReleased = true;
    try {
      await exclusion?.release();
    } catch {
      exclusionReleased = false;
    }
    // A record this process cannot remove may name a half-written store.
    if (!exclusionReleased && mutating && opStarted) {
      for (const hold of [presence, exclusion, handle])
        if (hold) retainedHolds.add(hold);
      return { released: false, held: true };
    }
    let presenceClosed = true;
    try {
      presence?.close();
    } catch {
      presenceClosed = false;
    }
    let claimReleased = false;
    try {
      const result = await claims.release(handle, { preserveEndpointBind });
      claimReleased =
        result === 'released' ||
        (preserveEndpointBind && result === 'not_owner');
    } catch {
      claimReleased = false;
    }
    return {
      released: exclusionReleased && presenceClosed && claimReleased,
      held: false,
    };
  }

  try {
    checkAborted();
    let address: PlatformUnixSocketAddress;
    try {
      if (endpoints.semantics !== 'filesystem-socket')
        refuse('platform-unsupported');
      address = endpoints.address({ dataRoot, endpointName: 'core' });
    } catch (error) {
      if (error instanceof ExclusiveMaintenanceRefusedError) throw error;
      refuse('runtime-unavailable', error);
    }
    const probe = await proveEndpointStopped(address);
    try {
      presence = await deps.acquirePresence(dataRoot);
    } catch (error) {
      refuse('host-active', error);
    }
    try {
      exclusion = await deps.acquireExclusion({
        dataRoot,
        owner: { pid: process.pid, startIdentity: self.startIdentity },
        inspect: async (pid, inspectionSignal) =>
          platform.supervision.inspectProcess({
            pid,
            signal: inspectionSignal,
          }),
        secureFiles: platform.secureFiles,
        signal,
      });
    } catch (error) {
      checkAborted();
      refuse(exclusionRefusal(error), error);
    }
    // The claim fences daemon starts; this re-check needs no unlink.
    await proveEndpointStopped(address, probe);
    for (const target of targets) {
      let roots: readonly ExclusiveMaintenanceTargetRoot[];
      try {
        roots = await target.roots(deps.read);
      } catch (error) {
        checkAborted();
        refuse('root-unavailable', error);
      }
      for (const root of roots)
        pinned.push(await pinRoot(dataRoot, target.key, root));
    }
    await assertHeld();
    opStarted = true;
    const result = await op(
      Object.freeze({
        dataRoot,
        roots: Object.freeze(pinned.map((root) => root.held)),
        signal,
        assertHeld,
      }),
    );
    await verifyHolds();
    succeeded = true;
    outcome = { ok: true, value: result };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const failure = outcome.ok ? undefined : outcome.error;
  const { released, held } = await releaseAll().catch(() => ({
    released: false,
    held: false,
  }));
  if (held) {
    // The caller sees the kept hold whatever `op` threw.
    throw new ExclusiveMaintenanceRefusedError(
      failure === undefined
        ? 'release-uncertain'
        : failure instanceof ExclusiveMaintenanceRefusedError
          ? failure.reason
          : 'outcome-uncertain',
      {
        cause:
          failure instanceof ExclusiveMaintenanceRefusedError
            ? (failure.underlying ?? failure)
            : failure,
        held,
      },
    );
  }
  if (!released)
    throw new ExclusiveMaintenanceRefusedError('release-uncertain', {
      cause: failure,
    });
  if (outcome.ok) return outcome.value;
  if (
    failure instanceof ExclusiveMaintenanceRefusedError &&
    failure.reason === 'host-active'
  )
    throw new ExclusiveMaintenanceRefusedError('host-active', {
      cause: failure.underlying,
      peers: await hostPeers(),
    });
  throw failure;
}
