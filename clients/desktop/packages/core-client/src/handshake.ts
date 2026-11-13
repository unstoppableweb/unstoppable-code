import {
  CoreRuntimeInitializeParamsSchema,
  CoreRuntimeInitializeResultSchema,
  type CanopySchemaOutput,
} from '@canopy/protocol/canopy-core';

import { CanopyClientError, MAX_ERROR_MESSAGE_LENGTH } from './errors';
import type {
  CanopyEffectiveManifest,
  CanopyManifestKind,
  CanopyRuntimeIdentity,
} from './types';

type InitializeParams = CanopySchemaOutput<
  typeof CoreRuntimeInitializeParamsSchema
>;
type InitializeRuntime = CanopySchemaOutput<
  typeof CoreRuntimeInitializeResultSchema
>['runtime'];

const RESTART_OR_UPDATE = 'Restart the daemon or update this client.';
const VERSION_MISMATCH_CODE = 'core.runtime.invalidState';
const MAX_LISTED_VERSIONS = 8;

/** Diagnostic-only: negotiation always uses the full lists. */
function listVersions(versions: readonly number[]): string {
  const listed = versions.slice(0, MAX_LISTED_VERSIONS).join(', ');
  const omitted = versions.length - MAX_LISTED_VERSIONS;
  return omitted > 0 ? `${listed}, and ${omitted} more` : listed;
}

export interface CanopyInitializeParamsInput {
  readonly clientName: string;
  readonly clientVersion: string;
  readonly protocolVersions: readonly number[];
  readonly clientCapabilities: readonly string[];
  /** Largest reply this client reassembles from message parts, if any. */
  readonly maxMessageBytes?: number;
  /** `client.ownerProof` for a daemon owner session (CAN-5771). */
  readonly ownerProof?: string;
}

export interface CanopyAcceptedInitialize {
  readonly runtime: InitializeRuntime;
  readonly identity: CanopyRuntimeIdentity;
  readonly manifest: CanopyEffectiveManifest;
  /** Largest request the daemon reassembles from message parts, if it said. */
  readonly peerMaxMessageBytes: number | null;
}

function failure(
  kind: 'invalid_argument' | 'failed_precondition' | 'internal',
  message: string,
  code?: typeof VERSION_MISMATCH_CODE,
): CanopyClientError {
  return new CanopyClientError({
    kind,
    message,
    ...(code ? { code } : {}),
    retry: { kind: 'never' },
  });
}

export function buildCanopyInitializeParams(
  options: CanopyInitializeParamsInput,
): InitializeParams {
  const parsed = CoreRuntimeInitializeParamsSchema.safeParse({
    client: {
      name: options.clientName,
      version: options.clientVersion,
      protocolVersions: [...options.protocolVersions],
      capabilities: [...options.clientCapabilities],
      ...(options.maxMessageBytes !== undefined && {
        maxMessageBytes: options.maxMessageBytes,
      }),
      ...(options.ownerProof !== undefined && {
        ownerProof: options.ownerProof,
      }),
    },
  });
  if (!parsed.success)
    throw failure(
      'invalid_argument',
      'Invalid core.runtime.initialize client parameters: offer at least one positive integer protocol version.',
    );
  return parsed.data;
}

function versionMismatch(
  offered: readonly number[],
  detail: string,
): CanopyClientError {
  return failure(
    'failed_precondition',
    `Protocol version mismatch: ${detail} (client offers ${listVersions(offered)}). ${RESTART_OR_UPDATE}`,
    VERSION_MISMATCH_CODE,
  );
}

function createManifest(
  lists: Record<CanopyManifestKind, readonly string[]>,
): CanopyEffectiveManifest {
  // The closure snapshot is unreachable; public sets are separate copies, so
  // mutating them never changes `has`.
  const snapshot = new Map<string, ReadonlySet<string>>([
    ['operations', new Set(lists.operations)],
    ['events', new Set(lists.events)],
    ['streams', new Set(lists.streams)],
  ]);
  return Object.freeze({
    operations: new Set(lists.operations),
    events: new Set(lists.events),
    streams: new Set(lists.streams),
    has: (kind: CanopyManifestKind, name: string): boolean =>
      snapshot.get(kind)?.has(name) ?? false,
  });
}

/** Strictly validates a canonical `core.runtime.initialize` result. */
export function acceptCanopyInitializeResult(
  result: unknown,
  options: {
    readonly protocolVersions: readonly number[];
    readonly connectionId: string;
  },
): CanopyAcceptedInitialize {
  const parsed = CoreRuntimeInitializeResultSchema.safeParse(result);
  if (!parsed.success)
    throw failure(
      'internal',
      'core.runtime.initialize returned a malformed result: it must carry runtime.buildVersion and capabilities.operations, events, and streams.',
    );
  const { runtime, selectedProtocolVersion, capabilities, limits } =
    parsed.data;
  const offered = [...options.protocolVersions];
  if (!offered.includes(selectedProtocolVersion))
    throw versionMismatch(
      offered,
      `daemon selected unoffered version ${selectedProtocolVersion}`,
    );
  if (!runtime.protocolVersions.includes(selectedProtocolVersion))
    throw versionMismatch(
      offered,
      `daemon selected version ${selectedProtocolVersion} outside its advertised ${listVersions(runtime.protocolVersions)}`,
    );
  const identity: CanopyRuntimeIdentity = Object.freeze({
    connectionId: options.connectionId,
    authorityId: runtime.authorityId,
    runtimeId: runtime.runtimeId,
    hostId: runtime.hostId,
    daemonEpoch: runtime.daemonEpoch,
    profile: runtime.profile,
    buildVersion: runtime.buildVersion,
    protocolVersion: selectedProtocolVersion,
  });
  return {
    runtime: Object.freeze({
      ...runtime,
      protocolVersions: [...runtime.protocolVersions],
    }),
    identity,
    manifest: createManifest(capabilities),
    peerMaxMessageBytes:
      typeof limits.maxMessageBytes === 'number' &&
      Number.isSafeInteger(limits.maxMessageBytes) &&
      limits.maxMessageBytes > 0
        ? limits.maxMessageBytes
        : null,
  };
}

/**
 * Adds restart/update guidance to a daemon-reported version mismatch. Auth and
 * every other kind pass through unchanged.
 */
export function toCanopyInitializeError(
  error: CanopyClientError,
  protocolVersions: readonly number[],
): CanopyClientError {
  const { payload } = error;
  if (
    payload.kind !== 'failed_precondition' ||
    !/protocol version/i.test(payload.message) ||
    /restart the daemon or update/i.test(payload.message)
  )
    return error;
  const suffix = ` (client offers ${listVersions(protocolVersions)}). ${RESTART_OR_UPDATE}`;
  return new CanopyClientError({
    ...payload,
    message:
      payload.message.slice(0, MAX_ERROR_MESSAGE_LENGTH - suffix.length) +
      suffix,
  });
}
