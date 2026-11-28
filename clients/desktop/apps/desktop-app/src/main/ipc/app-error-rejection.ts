import { isNativeError } from 'node:util/types';
import { CanopyOperationError } from '@canopy/core-runtime';
import { W5RecordOverloadedError } from '@canopy/core-runtime/node/w5/file-store';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { readCoworkFolderMissing } from '@canopy/protocol/canopy-core';
import { OrchestratorInstructionsConflictError } from '@canopy/protocol/remote-control/shell';
import {
  AppErrorDetailSchema,
  AppErrorSchema,
  classifyError,
  getAppErrorDefinition,
  createAppError,
  getAppErrorThrownType,
  isAppCancellation,
  isAppErrorCode,
  rememberAppErrorNativeFrames,
  normalizeAppErrorOperationFailure,
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
import {
  readIpcOperationDiagnostic,
  readIpcOperationFailure,
} from '@canopy/desktop-shared/ipc/operation-failure';
import {
  RpcClosedError,
  RpcRemoteError,
} from '../remote-control/transport/rpc-peer';
import { ProjectsReloadRequiredError } from '../lib/sidebar-save-errors';
import { W5DaemonHandoffError } from '../lib/w5-handoff-store';
import { ipcShowsRawErrorDetail } from './app-error-policy';
import { findInIpcErrorChain } from './error-chain';
import { recordIpcRequestFailure } from './ipc-failure-diagnostics';
import { preservesLegacyErrorText } from './legacy-error-text-contracts';
import { logMainProcessWarn } from '../lib/main-process-logging';

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

const DEFECT_LOG_WINDOW_MS = 60_000;
const DEFECT_LOG_MAX_KEYS = 256;
const DEFECT_LOG_NAME_MAX_LENGTH = 64;
const defectLogState = new Map<
  string,
  { loggedAt: number; suppressed: number }
>();

/**
 * One `main.log` line per IPC defect (CAN-6895), so a bundle without telemetry
 * still names the failing channel. Only sanitized identity is written: never
 * the message, stack, legacy text or raw channel (CAN-7096). At most one line
 * per code, source and name each minute; the next line carries the count of
 * occurrences skipped in between.
 */
function logIpcDefect(error: AppError): void {
  try {
    const now = Date.now();
    if (error.kind !== 'defect') return;
    const name = error.detail.name?.slice(0, DEFECT_LOG_NAME_MAX_LENGTH);
    const key = `${error.code}|${error.source ?? ''}|${name ?? ''}`;
    const previous = defectLogState.get(key);
    if (previous && now - previous.loggedAt < DEFECT_LOG_WINDOW_MS) {
      previous.suppressed += 1;
      return;
    }
    if (!previous && defectLogState.size >= DEFECT_LOG_MAX_KEYS)
      defectLogState.clear();
    defectLogState.set(key, { loggedAt: now, suppressed: 0 });
    logMainProcessWarn('[ipc] handler failed', {
      referenceId: error.referenceId,
      code: error.code,
      source: error.source,
      name,
      errno: error.detail.errno,
      operationCode: error.detail.operationCode,
      suppressed: previous?.suppressed ?? 0,
    });
  } catch {
    /* Logging must never change the rejection. */
  }
}

function legacyCopyText(copy: AppError['copy']): string {
  return `Error: ${copy.title}${copy.description ? ` ${copy.description}` : ''}`;
}

function wireError(
  error: AppError,
  raw: boolean,
  stableCopy: AppError['copy'],
): AppError {
  const detail = { ...error.detail };
  delete detail.stack;
  return AppErrorSchema.parse({
    ...error,
    copy: raw ? error.copy : stableCopy,
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

/**
 * A named, trusted refusal caused by an unavailable background service (Core),
 * on any channel (CAN-7137): the degraded W5 startup handoff, which only a
 * relaunch recovers, or a save whose window loaded while Core was unreachable.
 * The latter clears on the reload that follows recovery, but `projects:save`
 * rejections are only logged by the renderer, so it changes the local record,
 * never visible copy. Only these classes qualify; any other daemon failure
 * keeps the CAN-4405 interim rule. The degraded store rejects every call with
 * one shared handoff error, so the match is read, never marked.
 */
function backgroundServiceRefusal(
  thrown: unknown,
): W5DaemonHandoffError | ProjectsReloadRequiredError | undefined {
  return findInIpcErrorChain(
    thrown,
    (value): value is W5DaemonHandoffError | ProjectsReloadRequiredError =>
      (value instanceof W5DaemonHandoffError && value.reason !== 'cancelled') ||
      value instanceof ProjectsReloadRequiredError,
  );
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
    // The host sent a code with catalog copy: report this computer's view of
    // it by code. Protocol codes (remote_*, timeout) are not app codes.
    if (thrown instanceof RpcRemoteError && isAppErrorCode(thrown.code)) {
      try {
        reportMainAppError(
          createAppError(thrown.code, { source: ipcSource(channel) }),
          { thrownType: getAppErrorThrownType(thrown) },
        );
      } catch {
        /* Reporting is best effort. */
      }
    }
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
    const refusal = overload ? undefined : backgroundServiceRefusal(thrown);
    if (operationFailure && !overload && !refusal)
      classifyError(thrown, 'app.unexpected');
    // W5's error carries a `kind` and isn't an AppError payload. Project it
    // into the shared shape while retaining the original operation metadata.
    // A background-service refusal wins over any marker on the thrown value.
    const classified = overload
      ? classifyError(
          new Error(overload.message),
          'external.service_unavailable',
        )
      : refusal
        ? classifyError(
            new Error('Background service unavailable'),
            'external.background_service_unavailable',
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
    // The daemon's dotted code, already grammar-checked by the payload schema;
    // this adds the length cap. Telemetry re-applies its reviewed allowlist.
    // A shape recorded at its origin stays untouched.
    const operationCode = AppErrorDetailSchema.shape.operationCode.safeParse(
      operationFailure?.code,
    );
    if (
      operationCode.success &&
      operationCode.data !== undefined &&
      error.recordedBy === undefined
    )
      error = {
        ...error,
        detail: { ...error.detail, operationCode: operationCode.data },
      };
    // An unexpected daemon failure's class, code and frames; the telemetry
    // builder re-applies its allowlists. A recorded shape stays untouched.
    const diagnostic =
      error.recordedBy === undefined
        ? readIpcOperationDiagnostic(thrown)
        : undefined;
    if (diagnostic)
      error = {
        ...error,
        detail: {
          ...error.detail,
          name: diagnostic.name,
          ...(diagnostic.code === undefined ? {} : { errno: diagnostic.code }),
        },
      };
    // A typed failure, local or from the daemon, carries its system code in
    // `details.errno` (CAN-7114); only an allowlisted code is kept, and only
    // when the diagnostic above supplied none.
    const errno = AppErrorDetailSchema.shape.errno.safeParse(
      safeErrorProperty(
        safeErrorProperty(safeErrorProperty(thrown, 'payload'), 'details'),
        'errno',
      ),
    );
    if (
      errno.success &&
      errno.data !== undefined &&
      error.detail.errno === undefined &&
      error.recordedBy === undefined
    )
      error = { ...error, detail: { ...error.detail, errno: errno.data } };
    try {
      error =
        reportMainAppError(error, {
          operationFailure: normalizeAppErrorOperationFailure(operationFailure),
          ...(diagnostic ? { frames: diagnostic.frames } : {}),
          ...(nativeError
            ? { nativeError }
            : { thrownType: getAppErrorThrownType(thrown) }),
        })?.error ?? error;
    } catch {
      /* Leave shape unrecorded. */
    }
    // Logged whether or not the report was sent, so local-only and
    // telemetry-off builds still get the line.
    logIpcDefect(error);
    // The local record exists with telemetry off; it never changes or delays
    // the rejection (CAN-7137).
    try {
      recordIpcRequestFailure({ error, thrown, operationFailure });
    } catch {
      /* Recording is best effort. */
    }
    // This expected refusal carries fixed recovery copy. Stable keeps the
    // cause and all caller-supplied copy subject to the usual redaction.
    const stableCopy =
      channel === IPC_CHANNELS.appAdvisorSaveClaudeMd &&
      thrown instanceof OrchestratorInstructionsConflictError
        ? OrchestratorInstructionsConflictError.copy
        : getAppErrorDefinition(error.code).copy;
    return new IpcAppErrorRejection(
      raw || preservesLegacyErrorText(channel, legacy)
        ? legacy
        : legacyCopyText(stableCopy),
      wireError(error, raw, stableCopy),
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
