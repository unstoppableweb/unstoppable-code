import { isNativeError } from 'node:util/types';

// Every logged string is one of these source literals, a UUID or a sentinel.
// Extend a list in a reviewed change; unlisted values log as `other`.
// prettier-ignore
const CLEANUP_LABELS = [
  'approval-session', 'background-task-dir', 'capability-overlay', 'claude-temp-dir',
  'delegation-detach', 'ledger-tools', 'mcp-session', 'native-process',
  'watcher-directory',
] as const;
// prettier-ignore
const CLEANUP_PHASES = ['preparation', 'capability', 'parent', 'native'] as const;
// prettier-ignore
const ERROR_NAMES = [
  'AbortError', 'AggregateError', 'Error', 'EvalError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'SystemError', 'TimeoutError', 'TypeError', 'URIError',
] as const;
// Codes of the fs, process, socket and stream calls behind the retain sites.
// prettier-ignore
const ERROR_CODES = [
  'EACCES', 'EAGAIN', 'EBADF', 'EBUSY', 'ECANCELED', 'ECONNREFUSED', 'ECONNRESET',
  'EEXIST', 'EINVAL', 'EIO', 'EISDIR', 'ELOOP', 'EMFILE', 'ENAMETOOLONG', 'ENFILE',
  'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'EPERM', 'EPIPE', 'EROFS', 'ESRCH',
  'ETIMEDOUT', 'EXDEV', 'UNKNOWN', 'ABORT_ERR', 'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_STATE', 'ERR_IPC_CHANNEL_CLOSED', 'ERR_SOCKET_CLOSED',
  'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_WRITE_AFTER_END',
  'ERR_USE_AFTER_CLOSE',
] as const;
// prettier-ignore
const HARNESS_IDS = ['claude', 'codex', 'copilot', 'cursor', 'opencode'] as const;
// prettier-ignore
const RUNTIME_KINDS = [
  'claude-sdk', 'codex-app-server', 'copilot-sdk', 'cursor-acp', 'opencode-acp',
] as const;
// Case-insensitive, as the broker's own UUID check and the storage schema.
const DELEGATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 12 entries of at most ~200 B, identity and ten label counts stay under 4 KiB.
const MAX_LOGGED_FAILURES = 12;
const MESSAGES = {
  rejected: 'Local delegation resources remain open',
  timeout: 'Delegation cleanup timed out',
} as const;

type Listed<T extends string> = T | 'other';
export type LocalDelegationCleanupLabel = (typeof CLEANUP_LABELS)[number];
export type LocalDelegationCleanupPhase = (typeof CLEANUP_PHASES)[number];

/** The stable resource a retained cleanup callback releases. */
export interface LocalDelegationCleanupResource {
  readonly label: LocalDelegationCleanupLabel;
  readonly phase: LocalDelegationCleanupPhase;
  /** 0 for the launch preparation, n for capability reload n. */
  readonly preparation?: number;
}

/** A retained callback's resource after its fields were checked. */
export interface LocalDelegationCleanupTarget {
  readonly label: Listed<LocalDelegationCleanupLabel> | 'unlabelled';
  readonly phase: Listed<LocalDelegationCleanupPhase> | 'unlabelled';
  readonly preparation?: number;
}

export interface LocalDelegationCleanupFailure extends LocalDelegationCleanupTarget {
  readonly settlement: 'threw' | 'rejected' | 'pending';
  /** `typeof`, or `error`, `null` or `unreadable`. */
  readonly valueType?: string;
  readonly errorName?: Listed<(typeof ERROR_NAMES)[number]>;
  readonly errorCode?: Listed<(typeof ERROR_CODES)[number]>;
}

export interface LocalDelegationCleanupDiagnostic {
  readonly harnessId: Listed<(typeof HARNESS_IDS)[number]>;
  readonly runtimeKind: Listed<(typeof RUNTIME_KINDS)[number]>;
  /** A UUID, or `<non-uuid>`. */
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly attempt: number;
  readonly outcome: 'rejected' | 'timeout';
  readonly retained: number;
  /** Every failure of the attempt, in registration order. */
  readonly failures: readonly LocalDelegationCleanupFailure[];
}

/** Carries only the checked diagnostic; raw cleanup values are never kept. */
export class LocalDelegationCleanupError extends Error {
  constructor(readonly diagnostic: LocalDelegationCleanupDiagnostic) {
    super(MESSAGES[diagnostic.outcome]);
  }
}

function listed<T extends string>(
  values: readonly T[],
  value: unknown,
): Listed<T> {
  return values.find((entry) => entry === value) ?? 'other';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : -1;
}

/** Value type, listed name and listed code only; never message, stack or path. */
export function describeValue(
  value: unknown,
): Pick<
  LocalDelegationCleanupFailure,
  'valueType' | 'errorName' | 'errorCode'
> {
  try {
    if (value === null) return { valueType: 'null' };
    // Node core errors come from another realm under Jest and vm contexts.
    if (!(value instanceof Error || isNativeError(value)))
      return { valueType: typeof value };
    const code: unknown = Reflect.get(value, 'code');
    return {
      valueType: 'error',
      errorName: listed(ERROR_NAMES, Reflect.get(value, 'name')),
      ...(code === undefined ? {} : { errorCode: listed(ERROR_CODES, code) }),
    };
  } catch {
    return { valueType: 'unreadable' };
  }
}

/** Checked once at registration; no caller field is read after that. */
export function cleanupTarget(
  resource: LocalDelegationCleanupResource | undefined,
): LocalDelegationCleanupTarget {
  if (!resource) return { label: 'unlabelled', phase: 'unlabelled' };
  try {
    const preparation: unknown = resource.preparation;
    return {
      label: listed(CLEANUP_LABELS, resource.label),
      phase: listed(CLEANUP_PHASES, resource.phase),
      ...(preparation === undefined ? {} : { preparation: count(preparation) }),
    };
  } catch {
    return { label: 'other', phase: 'other' };
  }
}

/** Checks the fields the runner holds before they reach a record. */
export function cleanupDiagnostic(
  fields: Omit<LocalDelegationCleanupDiagnostic, 'harnessId' | 'runtimeKind'> &
    Record<'harnessId' | 'runtimeKind', string>,
): LocalDelegationCleanupDiagnostic {
  return {
    harnessId: listed(HARNESS_IDS, fields.harnessId),
    runtimeKind: listed(RUNTIME_KINDS, fields.runtimeKind),
    delegationId: DELEGATION_ID.test(fields.delegationId)
      ? fields.delegationId
      : '<non-uuid>',
    runGeneration: count(fields.runGeneration),
    attempt: count(fields.attempt),
    outcome: fields.outcome,
    retained: count(fields.retained),
    failures: fields.failures,
  };
}

/** The bounded main-log JSON; its counts cover every failure. */
export function cleanupLogRecord(
  diagnostic: LocalDelegationCleanupDiagnostic,
): string {
  const { failures } = diagnostic;
  const labels: Partial<
    Record<LocalDelegationCleanupFailure['label'], number>
  > = {};
  for (const { label } of failures) labels[label] = (labels[label] ?? 0) + 1;
  return JSON.stringify({
    ...diagnostic,
    failureCount: failures.length,
    labels,
    failures: failures.slice(0, MAX_LOGGED_FAILURES),
    omittedFailures: Math.max(0, failures.length - MAX_LOGGED_FAILURES),
  });
}
