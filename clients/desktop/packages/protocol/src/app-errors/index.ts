export {
  createErrorReferenceId,
  createReportReferenceId,
  isReferenceId,
} from './reference-id';
export type { ErrorRandomBytes } from './reference-id';
export {
  APP_ERROR_CATALOG,
  APP_ERROR_CODES,
  getAppErrorDefinition,
  isAppErrorCode,
} from './catalog';
export type { AppErrorCode, AppErrorDefinition } from './catalog';
export { AppErrorSchema } from './types';
export type { AppError } from './types';
export {
  AppCancellation,
  AppCancellationSchema,
  isAppCancellation,
} from './cancellation';
export {
  AppErrorKindSchema,
  AppErrorRecoverySchema,
  AppErrorSurfaceSchema,
  AppErrorCopySchema,
  AppErrorDetailSchema,
  AppErrorErrnoSchema,
  AppErrorClassSchema,
} from './primitives';
export type {
  AppErrorKind,
  AppErrorRecovery,
  AppErrorSurface,
  AppErrorCopy,
  AppErrorDetail,
} from './primitives';
export { createAppError, toAppError } from './create';
export type { CreateAppErrorOptions, ToAppErrorOptions } from './create';
export { presentAppError, showsRawErrorDetail } from './display';
export type { AppErrorDisplayPolicy, AppErrorPresentation } from './display';
export {
  createAppErrorHandler,
  appErrorNativeFrames,
  getAppErrorThrownType,
  rememberAppErrorNativeFrames,
} from './handler';
export { appErrorException } from './telemetry-exception';
export { surfacedErrorSource, createSurfacedErrorRecorder } from './surfaced';
export type {
  SurfacedErrorChokePoint,
  SurfacedErrorInput,
  SurfacedErrorRecorderOptions,
  SurfacedErrorRecorder,
} from './surfaced';
export type {
  AppErrorRecord,
  AppErrorReport,
  AppErrorSink,
  AppErrorScheduler,
  AppErrorHandlerOptions,
  AppErrorThrownType,
  AppErrorReportOptions,
  AppErrorHandler,
} from './handler';

export { classifyError, readErrorClassification } from './classification';
export type { ErrorClassification } from './classification';

export {
  createCanopyProxyAppError,
  isExpectedCanopyProxyAppError,
  AI_CREDITS_REFUSAL_ERROR_SOURCE,
} from './from-canopy-proxy';

export {
  AppErrorOperationFailureSchema,
  normalizeAppErrorOperationFailure,
} from './operation-failure';
export type { AppErrorOperationFailure } from './operation-failure';
