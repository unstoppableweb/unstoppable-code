import { isNativeError } from 'node:util/types';
import { CanopyOperationError } from '@canopy/core-runtime';
import { W5RecordOverloadedError } from '@canopy/core-runtime/node/w5/file-store';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { readCoworkFolderMissing } from '@canopy/protocol/canopy-core';
import {
  AppErrorSchema,
  classifyError,
  getAppErrorDefinition,
  getAppErrorThrownType,
  isAppCancellation,
  rememberAppErrorNativeFrames,
  toAppError,
  type AppError,
} from '@canopy/protocol/app-errors';
import { IPC_PRIVATE_CHANNELS } from './channel-policy';
import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import { classifySystemError } from '@canopy/desktop-shared/node/lib/app-error-classification';
import {
  IpcAppErrorRejection,
  safeLegacyErrorText,
  safeErrorProperty,
  type IpcOperationFailure,
} from '@canopy/desktop-shared/ipc/app-error-rejection';
import { readIpcOperationFailure } from '@canopy/desktop-shared/ipc/operation-failure';
import {
  RpcClosedError,
  RpcRemoteError,
} from '../remote-control/transport/rpc-peer';
import { ipcShowsRawErrorDetail } from './app-error-policy';
import { preservesLegacyErrorText } from './legacy-error-text-contracts';

const SAFE_FALLBACK =
  'Error: Something went wrong. Reload to get back to a working state.';

function ipcSource(channel: string): string {
  const source = `ipc:${channel}`;
  return !IPC_PRIVATE_CHANNELS.has(channel) &&
    source.length <= 128 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(source)
    ? source
    : 'ipc';
}

function catalogLegacy(error: AppError): string {
  const copy = getAppErrorDefinition(error.code).copy;
  return `Error: ${copy.title}${copy.description ? ` ${copy.description}` : ''}`;
}

function wireError(error: AppError, raw: boolean): AppError {
  const detail = { ...error.detail };
  delete detail.stack;
  // No source currently has reviewed input-copy overrides for this boundary.
  return AppErrorSchema.parse({
    ...error,
    copy: raw ? error.copy : getAppErrorDefinition(error.code).copy,
    detail: raw ? detail : { message: error.code },
  });
}

/** Only a named W5 admission refusal qualifies on these read surfaces. */
function workspaceReadOverload(
  channel: string,
  thrown: unknown,
): W5RecordOverloadedError | undefined {
  if (
    channel !== IPC_CHANNELS.projectsLoad &&
    channel !== IPC_CHANNELS.desktopSessionSnapshot
  )
    return undefined;
  const cause =
    thrown instanceof CanopyOperationError ? thrown.runtimeCause : thrown;
  return cause instanceof W5RecordOverloadedError ? cause : undefined;
}

/** Rejection conversion must never replace an application failure with a
 * conversion failure or leak detail when stable policy cannot be evaluated. */
export function toIpcRejection(
  channel: string,
  thrown: unknown,
  synchronous = false,
): Error {
  let raw = false;
  try {
    raw = ipcShowsRawErrorDetail();
  } catch {
    /* Safe policy by default. */
  }
  const originalText = safeLegacyErrorText(thrown);
  let legacy = originalText;
  let operationFailure: IpcOperationFailure | undefined;
  try {
    if (synchronous && !(thrown instanceof Error))
      legacy = `Error: ${originalText}`;
    if (thrown instanceof IpcAppErrorRejection) return thrown;
    operationFailure = readIpcOperationFailure(thrown);
    const missingFolder = readCoworkFolderMissing(thrown);
    if (missingFolder)
      return new IpcAppErrorRejection(
        missingFolder.message,
        undefined,
        thrown,
        operationFailure,
        missingFolder,
      );
    if (thrown instanceof RpcClosedError)
      return new IpcAppErrorRejection(
        'RpcClosedError: The connection to the other computer closed.',
        undefined,
        thrown,
      );
    // Raw-text privacy exceptions: cancellation is caller-owned, and remote
    // text has already passed the controlled host's own policy.
    if (
      thrown instanceof RpcRemoteError ||
      isAppCancellation(thrown) ||
      operationFailure?.status === 'cancelled' ||
      safeErrorProperty(thrown, 'name') === 'AbortError' ||
      safeErrorProperty(thrown, 'code') === 'ABORT_ERR' ||
      (safeErrorProperty(thrown, 'code') === 'cancelled' &&
        ['GitHubBrokerError', 'GitHubRequestError'].includes(
          String(safeErrorProperty(thrown, 'name')),
        ))
    )
      return new IpcAppErrorRejection(
        legacy,
        undefined,
        thrown,
        operationFailure,
      );
    // CAN-4405 owns mapping daemon failures to catalog codes. Until then no
    // nested transport evidence may present one as a generic Try again.
    const overload = workspaceReadOverload(channel, thrown);
    if (operationFailure && !overload) classifyError(thrown, 'app.unexpected');
    // W5's error carries a `kind` and isn't an AppError payload. Project it
    // into the shared shape while retaining the original operation metadata.
    const classified = overload
      ? classifyError(
          new Error(overload.message),
          'external.service_unavailable',
        )
      : thrown;
    const nativeError = isNativeError(thrown) ? thrown : undefined;
    if (nativeError) rememberAppErrorNativeFrames(nativeError);
    let error = toAppError(classified);
    if (!error)
      return new IpcAppErrorRejection(
        legacy,
        undefined,
        thrown,
        operationFailure,
      );
    if (
      !operationFailure &&
      error.code === 'app.unexpected' &&
      error.detail.name !== 'AppErrorValidation'
    ) {
      error = toAppError(classifySystemError(thrown)) ?? error;
    }
    // A shape recorded at its origin keeps that origin's identity untouched.
    if (error.recordedBy === undefined)
      error = { ...error, source: error.source ?? ipcSource(channel) };
    try {
      error =
        reportMainAppError(
          error,
          nativeError
            ? { nativeError }
            : { thrownType: getAppErrorThrownType(thrown) },
        )?.error ?? error;
    } catch {
      /* Leave shape unrecorded. */
    }
    return new IpcAppErrorRejection(
      raw || preservesLegacyErrorText(channel, legacy)
        ? legacy
        : catalogLegacy(error),
      wireError(error, raw),
      thrown,
      operationFailure,
    );
  } catch {
    // No serialization/reporting/property-access failure may expose stable raw text.
    try {
      return new IpcAppErrorRejection(
        raw ? legacy : SAFE_FALLBACK,
        undefined,
        thrown,
        operationFailure,
      );
    } catch {
      return new Error(raw ? legacy : SAFE_FALLBACK);
    }
  }
}
