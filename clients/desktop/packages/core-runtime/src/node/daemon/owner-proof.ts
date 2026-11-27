import { Buffer } from 'node:buffer';
import {
  canopyOwnerProofMatches,
  createCanopyDesktopPeerProof,
  createCanopyOwnerProof,
} from '@canopy/core-transport';

/** Verifies `client.ownerProof` in `core.runtime.initialize` (CAN-5771). */
export interface CanopyOwnerProofVerifier {
  /** True only for a proof made with this daemon's owner secret for `connectionId`. */
  verify(connectionId: string, proof: string): boolean;
  /**
   * True only for a `client.desktopPeerProof` made with this daemon's owner
   * secret for `connectionId`. An owner proof never passes.
   */
  verifyPeer(connectionId: string, proof: string): boolean;
}

const OWNER_SECRET_BYTES = 32;
const OWNER_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The daemon's verifier over its owner secret. Copies the secret; the caller
 * zero-fills its own buffer. Never logs, serializes or exposes the secret.
 */
export function createCanopyOwnerProofVerifier(options: {
  readonly secret: Uint8Array;
  readonly dataRootHash: string;
}): CanopyOwnerProofVerifier & { dispose(): void } {
  const secret = Buffer.from(options.secret);
  const { dataRootHash } = options;
  let disposed = false;
  const matches = (
    create: typeof createCanopyOwnerProof,
    connectionId: string,
    proof: string,
  ): boolean =>
    !disposed &&
    secret.length === OWNER_SECRET_BYTES &&
    connectionId.length > 0 &&
    OWNER_PROOF_PATTERN.test(proof) &&
    canopyOwnerProofMatches(create(secret, connectionId, dataRootHash), proof);
  const verifier = {
    verify(connectionId: string, proof: string): boolean {
      return matches(createCanopyOwnerProof, connectionId, proof);
    },
    verifyPeer(connectionId: string, proof: string): boolean {
      return matches(createCanopyDesktopPeerProof, connectionId, proof);
    },
    dispose(): void {
      disposed = true;
      secret.fill(0);
    },
    toJSON(): never {
      throw new Error('An owner proof verifier is not serializable.');
    },
    [Symbol.for('nodejs.util.inspect.custom')](): string {
      return '[CanopyOwnerProofVerifier]';
    },
  };
  return verifier;
}
