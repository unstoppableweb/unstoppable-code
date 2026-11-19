/**
 * The Electron IPC rejection carrier for app errors and daemon failure
 * semantics. Main encodes; the desktop preload and the portable CanopyClient
 * adapter (`@canopy/ipc-canopy-client`) restore. Browser-safe.
 */
import type { AppError } from './types';
import type { CoworkFolderMissing } from '../canopy-core/core/workspace/cowork-folder';
import type {
  CanopyErrorKind,
  CanopyRetryDirective,
} from '../canopy-core/errors';
import type { CanopyOperationCode } from '../canopy-core/names';

/**
 * A daemon failure's machine semantics, carried beside `AppError` because they
 * decide what may safely happen next, and AppError recovery only presents it.
 * Excludes the payload's message and details, which stable redaction removes.
 */
export interface IpcOperationFailure {
  status: CanopyErrorKind;
  code?: CanopyOperationCode;
  retry: CanopyRetryDirective;
  effects?: 'none' | 'unknown';
}

export const IPC_APP_ERROR_NAME = 'CanopyIpcAppError';
export const IPC_APP_ERROR_MAX_KEY_LENGTH = 16_384;

export class IpcAppErrorRejection extends Error {
  override readonly name = IPC_APP_ERROR_NAME;
  declare readonly cause: unknown;

  constructor(
    legacy: string,
    appError: AppError | undefined,
    cause: unknown,
    operationFailure?: IpcOperationFailure,
    coworkFolderMissing?: CoworkFolderMissing,
  ) {
    super(
      JSON.stringify({
        v: 1,
        appError,
        legacy,
        operationFailure,
        coworkFolderMissing,
      }),
    );
    Object.defineProperty(this, 'cause', { value: cause, configurable: true });
  }
}

export interface DecodedIpcAppError {
  channel: string;
  legacy: string;
  appError: unknown;
  operationFailure: unknown;
  coworkFolderMissing: unknown;
}

export function formatIpcLegacyError(channel: string, legacy: string): string {
  return `Error invoking remote method '${channel}': ${legacy}`;
}

/** Registered channels contain no quote or line break. Match the complete
 * Electron wrapper, never a carrier-like substring inside a legacy message. */
export function decodeIpcAppError(
  message: unknown,
): DecodedIpcAppError | undefined {
  if (typeof message !== 'string') return undefined;
  const match =
    /^Error invoking remote method '([^'\r\n]+)': CanopyIpcAppError: (\{[^]*\})$/.exec(
      message,
    );
  if (!match || match[0] !== message) return undefined;
  try {
    const payload: unknown = JSON.parse(match[2]);
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload) ||
      !('v' in payload) ||
      payload.v !== 1 ||
      !('legacy' in payload) ||
      typeof payload.legacy !== 'string'
    )
      return undefined;
    return {
      channel: match[1],
      legacy: payload.legacy,
      appError: 'appError' in payload ? payload.appError : undefined,
      coworkFolderMissing:
        'coworkFolderMissing' in payload
          ? payload.coworkFolderMissing
          : undefined,
      operationFailure:
        'operationFailure' in payload ? payload.operationFailure : undefined,
    };
  } catch {
    return undefined;
  }
}

export function safeErrorProperty(value: unknown, key: PropertyKey): unknown {
  try {
    if (
      (typeof value === 'object' && value !== null) ||
      typeof value === 'function'
    )
      return Reflect.get(value, key);
  } catch {
    // Untrusted thrown values may have throwing accessors.
  }
  return undefined;
}

export function safeLegacyErrorText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'Error: Unrecognized error value';
  }
}

/**
 * The decoded carrier `appError` on a restored rejection: non-enumerable, so
 * the error's message and enumerable shape stay the legacy ones. The value is
 * unvalidated wire data; `toAppError` validates it on read.
 */
export const IPC_RESTORED_APP_ERROR = Symbol.for('canopy.ipcRestoredAppError');

/**
 * Keep the shape `resolve` returns on a rejected invoke's `Error` under
 * {@link IPC_RESTORED_APP_ERROR}, for a host that resolves it out of band (the
 * desktop renderer: Electron's context bridge drops custom Error properties).
 * A no-op for a non-Error, an error that already carries one, or a missing
 * value; a throwing resolver is ignored, so the original rejection always
 * propagates.
 */
export function attachRestoredIpcAppError(
  error: unknown,
  resolve: () => unknown,
): void {
  if (!(error instanceof Error)) return;
  if (safeErrorProperty(error, IPC_RESTORED_APP_ERROR) !== undefined) return;
  try {
    const appError = resolve();
    if (appError === undefined) return;
    Object.defineProperty(error, IPC_RESTORED_APP_ERROR, {
      value: appError,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  } catch {
    // Keeping the shape is best effort; the rejection still propagates.
  }
}

/**
 * Restore an invoke rejection: a carrier becomes the legacy
 * `Error invoking remote method '<channel>': <legacy>` error the renderer has
 * always seen, keeping the carrier's AppError under
 * {@link IPC_RESTORED_APP_ERROR}; anything else is rethrown unchanged.
 * Idempotent, so a host that already restored (the desktop preload) and a
 * portable client compose.
 */
export function restoreIpcRejection(error: unknown): never {
  const decoded = decodeIpcAppError(safeErrorProperty(error, 'message'));
  if (!decoded) throw error;
  const restored = new Error(
    formatIpcLegacyError(decoded.channel, decoded.legacy),
  );
  attachRestoredIpcAppError(restored, () => decoded.appError);
  throw restored;
}

const IPC_INVOKE_WRAPPER_REGEX = /^Error invoking remote method '[^']*':\s*/;
const ERROR_CLASS_PREFIX_REGEX = /^(?:Error|[A-Z][A-Za-z0-9_]*Error):\s*/;
const IPC_ERROR_NAME_REGEX =
  /^(?:Error invoking remote method '[^']*':\s*)?([A-Z][A-Za-z0-9_]*Error):\s/;

function rawErrorText(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
}

/**
 * A caught IPC rejection's message without Electron's
 * `Error invoking remote method '…':` wrapper or an error-class prefix.
 */
export function extractIpcErrorMessage(error: unknown): string {
  const raw = rawErrorText(error);
  if (!raw) return 'Unknown error';
  const message = raw
    .replace(IPC_INVOKE_WRAPPER_REGEX, '')
    .replace(ERROR_CLASS_PREFIX_REGEX, '');
  return message.length > 0 ? message : 'Unknown error';
}

/** The error class name main kept in front of a wrapped IPC message, if any. */
export function extractIpcErrorName(error: unknown): string | undefined {
  const name = IPC_ERROR_NAME_REGEX.exec(rawErrorText(error))?.[1];
  return name && name !== 'Error' ? name : undefined;
}
