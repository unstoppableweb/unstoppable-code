import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  CanopyErrorKind,
  CanopyErrorPayload,
  CanopyOperationCode,
  CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';
import {
  relayableErrorDetails,
  relayRetryFor,
  type CanopyCoreRelayApi,
  type CanopyCoreRelayReply,
  type CanopyCoreRelayRequest,
} from '../../shared/canopy-core-relay';

// A type-checked kind table instead of the protocol barrel's schemas, which the preload bundle does not need.
const ERROR_KINDS: Readonly<Record<CanopyErrorKind, true>> = {
  invalid_argument: true,
  unauthenticated: true,
  permission_denied: true,
  not_found: true,
  already_exists: true,
  conflict: true,
  failed_precondition: true,
  capability_unavailable: true,
  cancelled: true,
  deadline_exceeded: true,
  unavailable: true,
  resource_exhausted: true,
  internal: true,
};

const INVALID_REPLY: CanopyErrorPayload = {
  kind: 'internal',
  message: 'The relay returned an invalid reply.',
  retry: { kind: 'never' },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isErrorKind(value: unknown): value is CanopyErrorKind {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(ERROR_KINDS, value)
  );
}

// Mirrors the protocol name grammar; main already validated the code.
const OPERATION_CODE = /^(core|worker)(\.[a-z][A-Za-z0-9]*){2,}$/;
function isOperationCode(value: unknown): value is CanopyOperationCode {
  return typeof value === 'string' && OPERATION_CODE.test(value);
}

function toRetry(value: unknown): CanopyRetryDirective {
  if (!isRecord(value)) return { kind: 'never' };
  const delayMs =
    typeof value.delayMs === 'number' ? { delayMs: value.delayMs } : {};
  if (value.kind === 'same_request' || value.kind === 'same_idempotency_key')
    return { kind: value.kind, ...delayMs };
  if (value.kind === 'after_refresh' && typeof value.resource === 'string')
    return { kind: 'after_refresh', resource: value.resource, ...delayMs };
  return { kind: 'never' };
}

/**
 * Main sends validated, redacted payloads; this only re-shapes the untyped IPC
 * result, keeping the same allowlisted `details` main does.
 */
function toError(value: unknown): CanopyErrorPayload {
  if (!isRecord(value) || !isErrorKind(value.kind)) return INVALID_REPLY;
  if (typeof value.message !== 'string' || value.message.length === 0)
    return INVALID_REPLY;
  const details = relayableErrorDetails(value.details);
  return {
    kind: value.kind,
    message: value.message,
    retry: toRetry(value.retry),
    ...(isOperationCode(value.code) ? { code: value.code } : {}),
    ...(details === undefined ? {} : { details }),
  };
}

function toReply(reply: unknown): CanopyCoreRelayReply {
  if (isRecord(reply) && reply.ok === true && 'value' in reply)
    return { ok: true, value: reply.value };
  if (isRecord(reply) && reply.ok === false)
    return { ok: false, error: toError(reply.error) };
  return { ok: false, error: INVALID_REPLY };
}

/** IPC rejection can lose a committed result; retain a supplied mutation key. */
function lostReplyRetry(request: CanopyCoreRelayRequest): CanopyRetryDirective {
  if (request.kind === 'request') {
    const meta = request.params._meta;
    if (
      isRecord(meta) &&
      typeof meta.idempotencyKey === 'string' &&
      meta.idempotencyKey.length > 0
    )
      return relayRetryFor(request.method, { kind: 'same_idempotency_key' });
  }
  return { kind: 'never' };
}

/** Forwards every relay request on one channel; main validates and authorizes it. */
export function createCanopyCoreRelayApi(
  ipc: Pick<IpcRenderer, 'invoke'>,
): CanopyCoreRelayApi {
  return {
    invoke: async (request): Promise<CanopyCoreRelayReply> => {
      try {
        const reply: unknown = await ipc.invoke(
          IPC_CHANNELS.canopyCoreRelay,
          request,
        );
        return toReply(reply);
      } catch {
        return {
          ok: false,
          error: {
            kind: 'unavailable',
            message: 'The relay is unavailable.',
            retry: lostReplyRetry(request),
          },
        };
      }
    },
  };
}
