import type { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
  createCanopyDesktopPeerProof,
  createCanopyOwnerProof,
} from '@canopy/core-transport';

/**
 * The daemon owner credential a launcher holds (CAN-5771): one fresh secret
 * per spawn, handed to that daemon on stdin, never stored or sent. Only
 * Electron main creates one.
 */
export interface DaemonOwnerCredential {
  /** A new secret for the next spawn, as 64 lowercase hex; the previous one is zero-filled. */
  rotate(): string;
  /** The spawn the current secret went to. */
  recordSpawn(daemon: { readonly pid: number }): void;
  /** The pid of the last recorded spawn, or null. */
  spawnedPid(): number | null;
  /** `createCanopyOwnerProof` with the current secret; throws when there is none. */
  prove(connectionId: string, dataRootHash: string): string;
  /** `createCanopyDesktopPeerProof` with the current secret; throws when there is none. */
  provePeer(connectionId: string, dataRootHash: string): string;
  /**
   * The desktop peer proof for this launch's ordinary connections, only once
   * a spawn was recorded: a launch that attached sends none.
   */
  peerProof(
    dataRootHash: string,
  ): ((connectionId: string) => string) | undefined;
}

const OWNER_SECRET_BYTES = 32;

export function createDaemonOwnerCredential(): DaemonOwnerCredential {
  let secret: Buffer | null = null;
  let pid: number | null = null;
  const credential = {
    rotate(): string {
      secret?.fill(0);
      secret = randomBytes(OWNER_SECRET_BYTES);
      pid = null;
      return secret.toString('hex');
    },
    recordSpawn(daemon: { readonly pid: number }): void {
      pid = daemon.pid;
    },
    spawnedPid(): number | null {
      return pid;
    },
    prove(connectionId: string, dataRootHash: string): string {
      if (!secret) throw new Error('No daemon owner secret was created.');
      return createCanopyOwnerProof(secret, connectionId, dataRootHash);
    },
    provePeer(connectionId: string, dataRootHash: string): string {
      if (!secret) throw new Error('No daemon owner secret was created.');
      return createCanopyDesktopPeerProof(secret, connectionId, dataRootHash);
    },
    peerProof(
      dataRootHash: string,
    ): ((connectionId: string) => string) | undefined {
      return pid === null
        ? undefined
        : (connectionId): string => {
            if (!secret) throw new Error('No daemon owner secret was created.');
            return createCanopyDesktopPeerProof(
              secret,
              connectionId,
              dataRootHash,
            );
          };
    },
    toJSON(): never {
      throw new Error('A daemon owner credential is not serializable.');
    },
    [Symbol.for('nodejs.util.inspect.custom')](): string {
      return '[DaemonOwnerCredential]';
    },
  };
  return credential;
}
