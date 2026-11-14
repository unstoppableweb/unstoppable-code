import type {
  CanopyErrorPayload,
  CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';
import {
  CLOUD_SANDBOX_SLEEPING_REASON,
  isCloudSandboxNotAwakeCode,
} from '@canopy/protocol/cloud-session/sandbox-status';

/**
 * Keyed instructions this host serves without a retained outcome (CAN-4733).
 * A same-key replay acts again, so the relay never directs one for these.
 */
const UNRETAINED_KEYED_METHODS: ReadonlySet<string> = new Set([
  'worker.filesystem.file.write',
  'worker.filesystem.directory.create',
  'worker.filesystem.entry.delete',
  'worker.filesystem.entry.copy',
  'worker.filesystem.entry.move',
]);

/** A failure's retry as the relay answers it for `method`. */
export function relayRetryFor(
  method: string | undefined,
  retry: CanopyRetryDirective,
): CanopyRetryDirective {
  return retry.kind === 'same_idempotency_key' &&
    method !== undefined &&
    UNRETAINED_KEYED_METHODS.has(method)
    ? { kind: 'never' }
    : retry;
}

/**
 * The one part of an error's `details` that crosses the relay to the
 * renderer: that a cloud chat's sandbox is not awake (CAN-6543). Only
 * enumerated values and a boolean, each checked against the protocol's
 * constants: `reason` must be the sleeping reason or nothing passes, and an
 * invalid `wakeAllowed` or `cloudCode` is dropped, not coerced. Every other
 * key stays behind. Main and the preload both apply it.
 */
export function relayableErrorDetails(
  details: unknown,
): CanopyErrorPayload['details'] | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  if (Reflect.get(details, 'reason') !== CLOUD_SANDBOX_SLEEPING_REASON)
    return undefined;
  const wakeAllowed: unknown = Reflect.get(details, 'wakeAllowed');
  const cloudCode: unknown = Reflect.get(details, 'cloudCode');
  return {
    reason: CLOUD_SANDBOX_SLEEPING_REASON,
    ...(typeof wakeAllowed === 'boolean' ? { wakeAllowed } : {}),
    ...(isCloudSandboxNotAwakeCode(cloudCode) ? { cloudCode } : {}),
  };
}

/** The one non-local authority the relay can reach; absent means the local core. */
export type CanopyCoreRelayAuthority = 'web-core';

/** One channel; stream reads pull one frame at a time to bound renderer delivery. */
export type CanopyCoreRelayRequest = {
  authority?: CanopyCoreRelayAuthority;
} & (
  | {
      kind: 'request' | 'openStream';
      method: string;
      params: Record<string, unknown>;
    }
  | { kind: 'readStream' | 'closeStream'; subscriptionId: string }
  | { kind: 'close' }
);

export type CanopyCoreRelayReply =
  | { ok: true; value: unknown }
  | { ok: false; error: CanopyErrorPayload };

export interface CanopyCoreRelayApi {
  invoke(request: CanopyCoreRelayRequest): Promise<CanopyCoreRelayReply>;
}
