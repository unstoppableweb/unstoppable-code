import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  CanopyRuntimeDescriptorSchema,
  type CanopyRuntimeDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  PlatformEndpointListener,
  PlatformNamedPipeAddress,
  PlatformServices,
  PlatformUnixSocketAddress,
} from '../../platform/platform-services';
import type { DaemonStartupClaimPort } from '../../platform/startup-claim';

export interface CanopyDaemonEndpointOptions {
  readonly dataRoot: string;
  readonly platform: PlatformServices;
  readonly claims: DaemonStartupClaimPort;
  /** Caller retains the claim until descriptor publication completes. */
  readonly claimHandle: object;
  /**
   * The claim replaced a departed holder that marked a bind (CAN-3935), so an
   * unpublished socket at the path is that holder's and may be unlinked.
   */
  readonly recoveredEndpointBind?: boolean;
}

export interface CanopyDaemonEndpointBinding {
  readonly listener: PlatformEndpointListener<
    PlatformUnixSocketAddress | PlatformNamedPipeAddress
  >;
  /** POSIX receipt; the publisher (CAN-3934) must record it in the descriptor. */
  readonly socketIdentity?: CanopyRuntimeDescriptor['socketIdentity'];
}

/** Missing or invalid is undefined; an unreadable descriptor cannot be ruled out, so it throws. */
async function publishedDescriptor(
  path: string,
): Promise<CanopyRuntimeDescriptor | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined;
    throw new Error('Stale owner unproven; offline repair required.');
  }
  try {
    return CanopyRuntimeDescriptorSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Binds under an already-held claim; the caller owns claim release and discovery publication. */
export async function bindCanopyDaemonEndpoint({
  dataRoot,
  platform,
  claims,
  claimHandle,
  recoveredEndpointBind = false,
}: CanopyDaemonEndpointOptions): Promise<CanopyDaemonEndpointBinding> {
  if (!isAbsolute(dataRoot) || (await realpath(dataRoot)) !== dataRoot)
    throw new Error('Canonical data root required.');
  const directory = platform.paths.runtimeDirectory({ dataRoot });
  if (directory !== join(dataRoot, 'runtime'))
    throw new Error('Foreign runtime directory.');
  const claim = await claims.identity(claimHandle);
  if (!claim || claim.dataRoot !== dataRoot)
    throw new Error('Foreign startup claim.');
  for (const path of [dataRoot, directory]) {
    const permissions = await platform.secureFiles.permissions({
      path,
      kind: 'directory',
      action: 'verify',
      mode: 'owner-only',
    });
    if (permissions.state !== 'private')
      throw new Error('Runtime permissions are not private.');
  }
  const endpoints = platform.endpoints;
  if (endpoints.semantics === 'filesystem-socket') {
    const address = endpoints.address({ dataRoot, endpointName: 'core' });
    const observed = await endpoints.probe(address);
    if (observed.state === 'live') throw new Error('Endpoint is live.');
    if (observed.state === 'ambiguous')
      throw new Error('Endpoint identity is ambiguous.');
    if (observed.state === 'refused') {
      // Refusal also occurs with a live full backlog; it is never owner-death proof.
      const previous = await publishedDescriptor(join(directory, 'core.json'));
      // Owner death alone could authorize unlinking a later listener's live socket.
      const published =
        previous?.endpoint.kind === 'socket' &&
        previous.endpoint.path === address.path &&
        previous.socketIdentity?.device === String(observed.identity.device) &&
        previous.socketIdentity.inode === String(observed.identity.inode);
      if (published) {
        const owner = await platform.supervision.inspectProcess({
          pid: previous.pid,
        });
        if (
          owner.state === 'unverifiable' ||
          (owner.state === 'running' &&
            owner.startIdentity === previous.startIdentity)
        )
          throw new Error('Stale owner unproven; offline repair required.');
      } else if (!recoveredEndpointBind) {
        throw new Error(
          previous
            ? 'Foreign endpoint; offline repair required.'
            : 'Stale owner unproven; offline repair required.',
        );
      }
      // Otherwise only the departed marker's lineage could bind here, and it never published.
    }
    if (
      observed.state === 'refused' &&
      (await endpoints.unlinkStale({
        address,
        expected: observed.identity,
        claim,
      })) === 'changed'
    )
      throw new Error('Stale endpoint changed.');
    // The path is empty or proven stale: any socket bound after this marker is this lineage's.
    if (
      claims.markEndpointBind &&
      !(await claims.markEndpointBind(claimHandle))
    )
      throw new Error('Startup claim unavailable.');
    const bound = await endpoints.bind(address);
    if (bound.kind !== 'bound') throw new Error('Endpoint is in use.');
    return {
      listener: bound.listener,
      socketIdentity: {
        device: String(bound.identity.device),
        inode: String(bound.identity.inode),
      },
    };
  }
  const address = endpoints.address({ dataRoot, endpointName: 'core' });
  const bound = await endpoints.bind(address);
  if (bound.kind !== 'bound') throw new Error('Endpoint is in use.');
  return { listener: bound.listener };
}
