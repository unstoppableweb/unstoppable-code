import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanopyRuntimeDescriptorSchema } from '@canopy/protocol/canopy-core';
import { assertCanopyDaemonEndpointStale } from '../daemon/binding';
import type {
  PlatformEndpointPathIdentity,
  PlatformNamedPipeAddress,
  PlatformServices,
  PlatformUnixSocketAddress,
} from '../../platform/platform-services';
import { isErrnoException } from './maintenance-guards';
import { W5MaintenanceRefusedError } from './maintenance-types';

/** Shared by W5 maintenance and the exclusive offline maintenance window. */
export interface W5EndpointDescriptorProof {
  /** Refuses `endpoint-unavailable` unless a refused socket is proven stale. */
  requireStaleSocket(
    address: PlatformUnixSocketAddress,
    identity: PlatformEndpointPathIdentity,
  ): Promise<void>;
  /** `runtime/core.json`, or undefined when absent; never repairs or removes it. */
  readDescriptor(): Promise<Buffer | undefined>;
  /**
   * Refuses `endpoint-unavailable` for a descriptor that is not this root's
   * core endpoint, `identity-unprovable` while its owner is unverifiable, and
   * `liveOwner` (default `identity-unprovable`) while it is live.
   */
  verifyDescriptor(descriptorBytes: Buffer | undefined): Promise<void>;
}

function refuse(
  reason: 'endpoint-unavailable' | 'identity-unprovable' | 'host-active',
): never {
  throw new W5MaintenanceRefusedError(reason);
}

/** Decisions only: callers hold the startup claim and own any unlink. */
export function createW5EndpointDescriptorProof(options: {
  readonly runtime: string;
  /** The `core` endpoint address the descriptor must name. */
  readonly address: PlatformUnixSocketAddress | PlatformNamedPipeAddress;
  readonly platform: Pick<PlatformServices, 'supervision' | 'secureFiles'>;
  readonly recoveredEndpointBind?: boolean;
  /** The exclusive window reports a live daemon as `host-active`. */
  readonly liveOwner?: 'identity-unprovable' | 'host-active';
  readonly signal?: AbortSignal;
}): W5EndpointDescriptorProof {
  const { runtime, address, platform, recoveredEndpointBind, signal } = options;
  const liveOwner = options.liveOwner ?? 'identity-unprovable';
  const descriptorPath = join(runtime, 'core.json');
  return {
    async requireStaleSocket(socketAddress, identity) {
      try {
        await assertCanopyDaemonEndpointStale({
          descriptorPath,
          address: socketAddress,
          identity,
          supervision: platform.supervision,
          recoveredEndpointBind,
          signal,
        });
      } catch {
        signal?.throwIfAborted();
        refuse('endpoint-unavailable');
      }
    },
    async readDescriptor() {
      let descriptorBytes: Buffer | undefined;
      try {
        const stat = await lstat(descriptorPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
          refuse('endpoint-unavailable');
        const permissions = await platform.secureFiles.permissions({
          path: descriptorPath,
          kind: 'file',
          mode: 'owner-only',
          action: 'verify',
        });
        if (permissions.state !== 'private') refuse('endpoint-unavailable');
        descriptorBytes = await readFile(descriptorPath);
      } catch (error) {
        if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
      }
      return descriptorBytes;
    },
    async verifyDescriptor(descriptorBytes) {
      if (!descriptorBytes) return;
      let raw: unknown;
      try {
        raw = JSON.parse(descriptorBytes.toString('utf8'));
      } catch {
        refuse('endpoint-unavailable');
      }
      const descriptor = CanopyRuntimeDescriptorSchema.safeParse(raw);
      if (
        !descriptor.success ||
        descriptor.data.endpoint.path !== address.path ||
        descriptor.data.endpoint.kind !==
          (address.kind === 'unix-socket' ? 'socket' : 'pipe')
      )
        refuse('endpoint-unavailable');
      const owner = await platform.supervision.inspectProcess({
        pid: descriptor.data.pid,
        signal,
      });
      if (owner.state === 'unverifiable') refuse('identity-unprovable');
      if (
        owner.state === 'running' &&
        owner.startIdentity === descriptor.data.startIdentity
      )
        refuse(liveOwner);
    },
  };
}
