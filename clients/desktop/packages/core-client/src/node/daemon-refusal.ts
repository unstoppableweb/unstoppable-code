import type { CanopyErrorKind } from '@canopy/protocol/canopy-core';
import { CanopyClientError, toCanopyClientError } from '../errors';
import { canopyConnectError } from './endpoint';

/**
 * Why a host refuses the daemon it found or started, carried in the error's
 * `details.refusal` so the protocol error schema stays unchanged. Additive:
 * later lanes append reasons, never rename one.
 */
export const CANOPY_DAEMON_REFUSALS = [
  /** A peer holds the W5 commit log's writer lock; waiting would not help. */
  'writer_held',
  /** A daemon without the needed operations outlived the wait. */
  'peer_held',
  /** The daemon serves the needed operations at other versions. */
  'version_skew',
  /** The daemon this launch spawned exited before it was ready. */
  'exited_before_ready',
  /** The owned daemon or the host's pre-spawn check refused connection files that need offline repair. */
  'endpoint_repair_required',
] as const;

export type CanopyDaemonRefusal = (typeof CANOPY_DAEMON_REFUSALS)[number];

const isRefusal = (value: unknown): value is CanopyDaemonRefusal =>
  CANOPY_DAEMON_REFUSALS.some((refusal) => refusal === value);

/** Closed facts a launch or connect failure may carry; never copied from messages or paths. */
const LAUNCH_ERRNOS = [
  'ENOENT',
  'ENOTDIR',
  'EACCES',
  'EPERM',
  'ENOEXEC',
  'ELOOP',
  'ENAMETOOLONG',
  'EMFILE',
  'ENFILE',
  'ENOMEM',
  'EAGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EIO',
  'ENOSPC',
  'EROFS',
  'EBUSY',
  'EEXIST',
  'ETIMEDOUT',
  'EINVAL',
] as const;
const LAUNCH_SIGNALS = [
  'SIGABRT',
  'SIGALRM',
  'SIGBUS',
  'SIGFPE',
  'SIGHUP',
  'SIGILL',
  'SIGINT',
  'SIGKILL',
  'SIGPIPE',
  'SIGQUIT',
  'SIGSEGV',
  'SIGSYS',
  'SIGTERM',
  'SIGTRAP',
  'SIGXCPU',
  'SIGXFSZ',
] as const;
const LAUNCH_NATIVE_STAGES = ['load_failed', 'native_unknown'] as const;
/** Why a startup claim was ambiguous, carried beside `details.claim`. */
const CLAIM_CAUSES = ['stale_guard', 'guard_io', 'record_io'] as const;
export type CanopyClaimCause = (typeof CLAIM_CAUSES)[number];

export type CanopyLaunchDetails = {
  readonly errno?: (typeof LAUNCH_ERRNOS)[number];
  readonly exitCode?: number;
  readonly signal?: (typeof LAUNCH_SIGNALS)[number];
  readonly nativeStage?: (typeof LAUNCH_NATIVE_STAGES)[number];
  readonly cause?: CanopyClaimCause;
};

const own = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

const allowed = <T extends string>(
  list: readonly T[],
  value: unknown,
): T | undefined => list.find((item) => item === value);

/**
 * Reads only the allowlisted launch facts from a details-like object, a typed
 * client error's details, or a raw error's `code`. Everything else (messages,
 * paths, native diagnostics) is dropped.
 */
export function canopyLaunchDetails(value: unknown): CanopyLaunchDetails {
  const source = own(own(value, 'payload'), 'details') ?? value;
  const errno =
    allowed(LAUNCH_ERRNOS, own(source, 'errno')) ??
    allowed(LAUNCH_ERRNOS, own(value, 'code'));
  const exitCode = own(source, 'exitCode');
  const signal = allowed(LAUNCH_SIGNALS, own(source, 'signal'));
  const nativeStage = allowed(LAUNCH_NATIVE_STAGES, own(source, 'nativeStage'));
  const cause = allowed(CLAIM_CAUSES, own(source, 'cause'));
  return {
    ...(errno ? { errno } : {}),
    ...(typeof exitCode === 'number' &&
    Number.isSafeInteger(exitCode) &&
    exitCode >= 0 &&
    exitCode <= 255
      ? { exitCode }
      : {}),
    ...(signal ? { signal } : {}),
    ...(nativeStage ? { nativeStage } : {}),
    ...(cause ? { cause } : {}),
  };
}

export function canopyDaemonRefusalError(
  refusal: CanopyDaemonRefusal,
  message: string,
  kind: CanopyErrorKind = 'failed_precondition',
  extra: CanopyLaunchDetails = {},
): CanopyClientError {
  const { payload } = canopyConnectError(kind, message);
  return new CanopyClientError({ ...payload, details: { ...extra, refusal } });
}

/** Fixed text only: the refusing check's own message never crosses. */
export const canopyEndpointRepairRequiredError = (): CanopyClientError =>
  canopyDaemonRefusalError(
    'endpoint_repair_required',
    'Core found connection files from an earlier run that it could not prove unused.',
    'unavailable',
  );

/** The typed refusal an error carries, or `null`; reads any schema-valid payload. */
export function canopyDaemonRefusal(
  error: unknown,
): CanopyDaemonRefusal | null {
  const { details } = toCanopyClientError(error).payload;
  if (typeof details !== 'object' || details === null || Array.isArray(details))
    return null;
  const refusal: unknown = Object.getOwnPropertyDescriptor(
    details,
    'refusal',
  )?.value;
  return isRefusal(refusal) ? refusal : null;
}
