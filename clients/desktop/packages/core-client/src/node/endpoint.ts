import type { CanopyFramedAuthOptions } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import type { CanopyErrorKind } from '@canopy/protocol/canopy-core';

import { CANOPY_CONNECTION_DEFAULTS } from '../delivery';
import { CanopyClientError } from '../errors';

interface CanopyPathEndpoint<K extends 'socket' | 'pipe'> {
  readonly kind: K;
  /** Unix socket path, or a local `\\.\pipe\` / `\\?\pipe\` name on Windows. */
  readonly path: string;
  readonly auth: CanopyFramedAuthOptions;
  readonly maxFrameBytes?: number;
}

export type CanopyClientEndpoint =
  | CanopyPathEndpoint<'socket'>
  | CanopyPathEndpoint<'pipe'>
  | {
      readonly kind: 'inMemory';
      /** An authenticated connection; the connector takes ownership. */
      readonly connection: CanopyFramedConnection;
    };

/** The largest delay a Node timer honors. */
export const MAX_CANOPY_CONNECT_TIMEOUT_MS = 2_147_483_647;
const LOCAL_PIPE_NAME = /^\\\\[.?]\\pipe\\.+$/i;

/** Messages never include the endpoint path or auth material. */
export function canopyConnectError(
  kind: CanopyErrorKind,
  message: string,
  details?: Readonly<Record<string, string | number>>,
): CanopyClientError {
  return new CanopyClientError({
    kind,
    message,
    retry:
      kind === 'unavailable' ? { kind: 'same_request' } : { kind: 'never' },
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  });
}

/** Defaults to the shared connect timeout; otherwise an integer from 1 to the timer maximum. */
export function validateCanopyTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined)
    return CANOPY_CONNECTION_DEFAULTS.connectTimeoutMs;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_CANOPY_CONNECT_TIMEOUT_MS
  )
    throw canopyConnectError(
      'invalid_argument',
      `timeoutMs must be an integer from 1 to ${MAX_CANOPY_CONNECT_TIMEOUT_MS}.`,
    );
  return timeoutMs;
}

/** Checks the platform first, then the path and frame cap, without any I/O. */
export function validateCanopyEndpoint(
  endpoint: CanopyClientEndpoint,
  platform: NodeJS.Platform = process.platform,
): void {
  if (endpoint.kind === 'inMemory') return;
  if ((endpoint.kind === 'pipe') !== (platform === 'win32'))
    throw canopyConnectError(
      'capability_unavailable',
      'Use a named pipe endpoint on Windows and a socket elsewhere.',
    );
  if (endpoint.path.length === 0)
    throw canopyConnectError('invalid_argument', 'Endpoint path is empty.');
  if (endpoint.kind === 'pipe' && !LOCAL_PIPE_NAME.test(endpoint.path))
    throw canopyConnectError(
      'invalid_argument',
      'Pipe endpoints must be local named pipes with a name.',
    );
  const { maxFrameBytes = 1 } = endpoint;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1)
    throw canopyConnectError(
      'invalid_argument',
      'maxFrameBytes must be a positive integer.',
    );
}
