// Lease-free building blocks for handing startup to a daemon-hosted W5 store
// (GB12, CAN-5543): probe what is published, classify what it serves, and
// wait out a daemon that cannot serve it. Hosts compose the sequence.
import { CANOPY_CLIENT_PROTOCOL_VERSIONS, CanopyClientError } from '../errors';
import type { CanopyEffectiveManifest } from '../types';
import type {
  CanopyDaemonProcessInspector,
  CanopyRuntimeDescriptor,
  CanopyRuntimeDescriptorSource,
} from './daemon-ports';
import {
  canopyDaemonRefusalError,
  canopyLaunchStepDetails,
} from './daemon-refusal';
import {
  classifyCanopyDescriptor,
  type CanopyDescriptorState,
} from './descriptor';
import {
  canopyConnectError,
  validateCanopyTimeout,
  type CanopyClientEndpoint,
} from './endpoint';
import { Deadline, fixed, ignore, typed } from './launch-deadline';

/**
 * The daemon's W5 host health check (`apps/core-daemon/src/w5-host-health.ts`).
 * Its `reason` is an untyped extension field; only these values are known.
 */
export const CANOPY_DAEMON_W5_HOST_CHECK = 'core.daemon.w5-commit-log';
const WRITER_UNAVAILABLE = 'writer_unavailable';

export interface CanopyDaemonCapabilityInput {
  /** The operations the host needs, by name: for example its definition maps. */
  readonly required: Readonly<Record<string, { readonly version: number }>>;
  /** The connection's effective manifest from `core.runtime.initialize`. */
  readonly manifest: Pick<CanopyEffectiveManifest, 'has'>;
  /**
   * `core.runtime.manifest.get` operations (lease-free). Required: calls carry
   * no version, so only this read catches RC and prod skew.
   */
  readonly operations: readonly {
    readonly name: string;
    readonly version: number;
    readonly available: boolean;
  }[];
  /** `core.runtime.health.get` checks; only diagnose why nothing is served. */
  readonly checks?: readonly {
    readonly name: string;
    readonly status: 'pass' | 'warn' | 'fail';
    readonly [extension: string]: unknown;
  }[];
}

export type CanopyDaemonCapability =
  | { readonly kind: 'accept' }
  /** Serves none of them; wait until it is gone, then refuse `peer_held`. */
  | { readonly kind: 'wait' }
  | {
      readonly kind: 'refuse';
      readonly refusal: 'writer_held' | 'version_skew';
    };

/**
 * Pure. Decides on the operations served, never on `runtime.state`: a W5
 * daemon degraded by an unrelated check still serves them.
 */
export function classifyCanopyDaemonCapability(
  input: CanopyDaemonCapabilityInput,
): CanopyDaemonCapability {
  const required = Object.entries(input.required);
  if (required.length === 0)
    throw canopyConnectError(
      'invalid_argument',
      'At least one required operation is needed.',
    );
  const served = required.filter(([name]) =>
    input.manifest.has('operations', name),
  );
  if (served.length === 0) {
    const w5 = input.checks?.find(
      (c) => c.name === CANOPY_DAEMON_W5_HOST_CHECK,
    );
    // A writer-held daemon holds leases or is ours: it will not go idle.
    return w5 && w5.status !== 'pass' && w5.reason === WRITER_UNAVAILABLE
      ? { kind: 'refuse', refusal: 'writer_held' }
      : { kind: 'wait' };
  }
  const skew: CanopyDaemonCapability = {
    kind: 'refuse',
    refusal: 'version_skew',
  };
  if (served.length < required.length) return skew;
  const matches = required.every(([name, { version }]) =>
    input.operations.some(
      (op) => op.name === name && op.available && op.version === version,
    ),
  );
  return matches ? { kind: 'accept' } : skew;
}

interface DiscoveryPorts {
  readonly descriptor: CanopyRuntimeDescriptorSource;
  readonly supervisor: CanopyDaemonProcessInspector;
}

export type CanopyDaemonProbe<T> =
  | Extract<CanopyDescriptorState, { kind: 'absent' | 'stale' }>
  | {
      /** `unreachable`: live but refused the connection, as while stopping. */
      readonly kind: 'incompatible' | 'unreachable';
      readonly descriptor: CanopyRuntimeDescriptor;
    }
  | {
      readonly kind: 'live';
      readonly descriptor: CanopyRuntimeDescriptor;
      /** The caller classifies and closes it. */
      readonly value: T;
    };

export interface CanopyDaemonProbeOptions<T> {
  readonly secureStorageLayout?: string;
  /** 64 lowercase hex characters, echoed by the transport handshake. */
  readonly dataRootHash: string;
  readonly ports: DiscoveryPorts;
  /**
   * Connects and initializes only; it must not lease, so the daemon's idle
   * grace keeps running. `unavailable` reports the daemon `unreachable`.
   */
  readonly connect: (
    endpoint: CanopyClientEndpoint,
    setup: { readonly timeoutMs: number; readonly signal: AbortSignal },
  ) => Promise<T>;
  /** Closes a value `connect` produced after the probe already failed. */
  readonly dispose: (value: T) => void | PromiseLike<void>;
  readonly protocolVersions?: readonly number[];
  /** Defaults to 30000 ms. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function versionsOf(options: {
  readonly protocolVersions?: readonly number[];
}): readonly number[] {
  const versions = options.protocolVersions ?? CANOPY_CLIENT_PROTOCOL_VERSIONS;
  if (
    versions.length === 0 ||
    !versions.every((v) => Number.isSafeInteger(v) && v > 0)
  )
    throw canopyConnectError(
      'invalid_argument',
      'Protocol versions must be positive integers.',
    );
  return versions;
}

/** Reads and classifies the descriptor, then connects to a live daemon. Never claims, spawns, or leases. */
export async function probeCanopyDaemon<T>(
  options: CanopyDaemonProbeOptions<T>,
): Promise<CanopyDaemonProbe<T>> {
  if (!/^[0-9a-f]{64}$/.test(options.dataRootHash))
    throw canopyConnectError(
      'invalid_argument',
      'dataRootHash must be 64 lowercase hex characters.',
    );
  const protocolVersions = versionsOf(options);
  const timeoutMs = validateCanopyTimeout(options.timeoutMs ?? 30_000);
  const { descriptor: source, supervisor } = options.ports;
  const deadline = new Deadline(timeoutMs, options.signal);
  try {
    const state = await deadline.run(
      (signal) =>
        classifyCanopyDescriptor({
          source,
          supervisor,
          protocolVersions,
          secureStorageLayout: options.secureStorageLayout,
          signal,
        }),
      typed('Core discovery failed.'),
    );
    if (state.kind === 'absent' || state.kind === 'stale') return state;
    const { descriptor } = state;
    if (state.kind === 'incompatible')
      return { kind: 'incompatible', descriptor };
    const secret = await deadline.run(
      (signal) => source.readToken(descriptor.tokenRef, signal),
      fixed('Core token read failed.', canopyLaunchStepDetails('read_token')),
    );
    const { kind, path } = descriptor.endpoint;
    const auth = { secret, dataRootHash: options.dataRootHash };
    try {
      const value = await deadline.run(
        (signal) =>
          options.connect(
            { kind, path, auth },
            { timeoutMs: deadline.remainingMs(), signal },
          ),
        typed('Core probe failed.'),
        (pending) => void pending.then(options.dispose).then(ignore, ignore),
      );
      return { kind: 'live', descriptor, value };
    } catch (error) {
      if (
        deadline.failure ||
        !(error instanceof CanopyClientError) ||
        error.payload.kind !== 'unavailable'
      )
        throw error;
      return { kind: 'unreachable', descriptor };
    }
  } finally {
    deadline.dispose();
  }
}

export interface CanopyDaemonReleaseWaitOptions {
  readonly ports: DiscoveryPorts;
  /** The refused daemon; once its PID and start identity stop publishing, the wait ends. */
  readonly descriptor: CanopyRuntimeDescriptor;
  readonly protocolVersions?: readonly number[];
  /** Defaults to 45000 ms: the daemon's 30 s idle grace, its stop, and slack. */
  readonly timeoutMs?: number;
  /** Fixed re-read interval; defaults to 250 ms. */
  readonly probeIntervalMs?: number;
  readonly signal?: AbortSignal;
}

const isSame = (
  a: CanopyRuntimeDescriptor,
  b: CanopyRuntimeDescriptor,
): boolean => a.pid === b.pid && a.startIdentity === b.startIdentity;

/**
 * Re-reads the descriptor, never connecting, until the refused daemon is gone.
 * Resolves with what replaced it, which the caller probes again; a daemon
 * still published at the bound refuses `peer_held`.
 */
export async function waitForCanopyDaemonRelease(
  options: CanopyDaemonReleaseWaitOptions,
): Promise<CanopyDescriptorState> {
  const protocolVersions = versionsOf(options);
  const timeoutMs = validateCanopyTimeout(options.timeoutMs ?? 45_000);
  const probeMs = validateCanopyTimeout(options.probeIntervalMs ?? 250);
  const { descriptor: source, supervisor } = options.ports;
  const deadline = new Deadline(timeoutMs, options.signal);
  try {
    for (;;) {
      const state = await deadline.run(
        (signal) =>
          classifyCanopyDescriptor({
            source,
            supervisor,
            protocolVersions,
            signal,
          }),
        typed('Core discovery failed.'),
      );
      if (state.kind === 'absent' || state.kind === 'stale') return state;
      if (!isSame(state.descriptor, options.descriptor)) return state;
      await deadline.sleep(probeMs);
    }
  } catch (error) {
    const { failure } = deadline;
    if (failure === error && failure?.payload.kind === 'deadline_exceeded')
      throw canopyDaemonRefusalError(
        'peer_held',
        'Another core is still running and cannot serve this app.',
      );
    throw error;
  } finally {
    deadline.dispose();
  }
}
