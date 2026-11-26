import type {
  CanopyErrorPayload,
  CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';
import {
  CLOUD_SANDBOX_SLEEPING_REASON,
  isCloudSandboxNotAwakeCode,
} from '@canopy/protocol/cloud-session/sandbox-status';
import type { WEB_CORE_AUTHORITY_ID } from '@canopy/protocol/authority-qualified-id';

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

/** A refused secret submission's field: an env-name shaped value key or a top-level field. */
const SECRET_REFUSAL_FIELD =
  /^(?:values\.[A-Z_][A-Z0-9_]{0,63}|values|action|submissionId|body)$/;
/** Agentic Core's reason codes for a refused secret submission. */
const SECRET_REFUSAL_REASON = /^[a-z][a-z_]{0,63}$/;

/**
 * The parts of an error's `details` that cross the relay to the renderer:
 * that a cloud chat's sandbox is not awake (CAN-6543), and which field of a
 * cloud secret submission Agentic Core refused and why (agent secret
 * requests), so the form can say which value to fix. Only enumerated values,
 * a boolean and pattern-checked names: `reason` must be the sleeping reason,
 * or `field` an env-name shaped key with a snake_case reason code, which can
 * never hold a value; an invalid `wakeAllowed` or `cloudCode` is dropped,
 * not coerced. Every other key stays behind. Main and the preload both apply
 * it.
 */
export function relayableErrorDetails(
  details: unknown,
): CanopyErrorPayload['details'] | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const field: unknown = Reflect.get(details, 'field');
  const reason: unknown = Reflect.get(details, 'reason');
  if (
    typeof field === 'string' &&
    typeof reason === 'string' &&
    SECRET_REFUSAL_FIELD.test(field) &&
    SECRET_REFUSAL_REASON.test(reason)
  )
    return { field, reason };
  if (reason !== CLOUD_SANDBOX_SLEEPING_REASON) return undefined;
  const wakeAllowed: unknown = Reflect.get(details, 'wakeAllowed');
  const cloudCode: unknown = Reflect.get(details, 'cloudCode');
  return {
    reason: CLOUD_SANDBOX_SLEEPING_REASON,
    ...(typeof wakeAllowed === 'boolean' ? { wakeAllowed } : {}),
    ...(isCloudSandboxNotAwakeCode(cloudCode) ? { cloudCode } : {}),
  };
}

/** The one non-local authority the relay can reach; absent means the local core. */
export type CanopyCoreRelayAuthority = typeof WEB_CORE_AUTHORITY_ID;

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
  // The session's account and advertised revisions (CAN-6828).
  | { kind: 'describe' }
);

export type CanopyCoreRelayReply =
  | { ok: true; value: unknown }
  | { ok: false; error: CanopyErrorPayload };

export interface CanopyCoreRelayApi {
  invoke(request: CanopyCoreRelayRequest): Promise<CanopyCoreRelayReply>;
}
