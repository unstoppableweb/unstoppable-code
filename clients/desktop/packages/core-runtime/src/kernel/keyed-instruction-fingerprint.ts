import { createHash } from 'node:crypto';
import { stableStringify } from '@canopy/protocol/plans';
import type { WorkerExecutorReplay } from '../runtime/worker-executor-receipts';

/** SHA-256 over parameters with sorted object keys; array order is semantic. */
export function fingerprintKeyedInstructionParams(params: unknown): string {
  return createHash('sha256')
    .update(stableStringify(params) ?? 'null')
    .digest('base64url');
}

/**
 * 128 bits, so a collision only refuses a new key and never runs an old one.
 * Encoding 16 bytes, instead of slicing a longer digest, keeps each
 * remembered key a flat 22-character string: a slice would hold its parent
 * string, doubling the memory a full set of 1,048,576 keys takes.
 */
export function digestKeyedInstructionKey(key: string): string {
  return createHash('sha256')
    .update(key)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

/** Replay for `operations`, bound to `fingerprintKeyedInstructionParams`. */
export function keyedInstructionReplay(
  operations: ReadonlySet<string>,
): WorkerExecutorReplay {
  return {
    operations,
    fingerprint: fingerprintKeyedInstructionParams,
    keyDigest: digestKeyedInstructionKey,
  };
}
