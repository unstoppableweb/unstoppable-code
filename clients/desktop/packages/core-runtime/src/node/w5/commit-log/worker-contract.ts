import {
  isW5ErrorName,
  isW5ErrorCode,
  isW5SqliteErrcode,
  isW5FilesystemCode,
  type W5UnderlyingDiagnostics,
} from '../error-diagnostics';
export {
  isW5CaptureRequest,
  isW5CaptureResult,
  freezeW5Capture,
  isW5CaptureWorkspaceId,
  W5_CAPTURE_LIMITS,
  type W5CaptureFile,
  type W5CaptureRequest,
  type W5CaptureResult,
  type W5ConfinedFileRead,
  type W5ConfinedFileReader,
  type W5ConfinedFileReaderSource,
  type W5FileImage,
} from './capture-contract';
import { isW5FileConflict } from './apply-evidence';
import type { W5FileConflict, W5ApplyResult, W5RecoveryReport } from './apply';
import type {
  W5BackupPosition,
  W5ReceiptLookup,
  W5Reservation,
} from './commit-log';
import type { W5CommitLogErrorCode, W5CommitRefusal } from './errors';
import { isRecord } from './is-record';

/*
 * Private, same-process message contract between the W5 commit log host on the
 * Electron main thread and the worker thread that holds the commit log's only
 * connection (CAN-3805). It carries commit log calls and their outcomes; what
 * a write commits stays with the W5 repositories.
 */

/** The `workerData` the host starts the worker with. */
export interface W5CommitLogWorkerData {
  /** The commit log database. */
  dbPath: string;
  /** The W5 data root; every file a commit writes must be inside it. */
  root: string;
  /**
   * The Canopy data root holding `root` and the database's folder; the worker
   * makes every folder up to it durable before `ready`. Absent: `root`, and
   * the database's folder is not covered.
   */
  dataRoot?: string;
  /**
   * The realpath of `root`, which the host's first worker resolves before it
   * is ready and the host passes to every worker after, so a restart never
   * re-anchors it. Windows capture confines reads to it and refuses without it.
   */
  captureRoot?: string;
  healCleanConflictOperations?: readonly string[];
  /**
   * The longest a read waits in the worker for writes to settle before it
   * refuses as `overloaded` (CAN-5589); under the host's request bound, so
   * the host never retires a worker over a waiting read. Default 10 s.
   */
  readWaitMs?: number;
}

/**
 * What `W5CommitLogHost` starts each worker with: the portable data plus the
 * fields only a host's worker entry reads. The portable body ignores them.
 */
export interface W5CommitLogHostWorkerData extends W5CommitLogWorkerData {
  /** win32: the native addon the entry loads its handle-confined reader from. */
  readonly confinementAddon?: string;
}

/**
 * `recoveryReport` returns what launch recovery found when the worker opened
 * the log; `commit` commits a change and writes its files before answering;
 * `revision` reads one resource's revision; `lookupReceipt` admits a keyed
 * attempt without effects; `reserve` durably names it before uncertain effects; `snapshot` reads the verified
 * backup position after file recovery.
 *
 * `resolveRecovery`, `retryRecoveryRequiredCommit` and
 * `abandonRecoveryRequiredCommit` are for offline maintenance's cold host
 * only (RX1); nothing else sends them.
 */
export type W5CommitLogMethod =
  | 'recoveryReport'
  | 'commit'
  | 'revision'
  | 'lookupReceipt'
  | 'reserve'
  | 'updateReservationDiagnostics'
  | 'releaseReservation'
  | 'markReservationRecoveryRequired'
  | 'snapshot'
  | 'capture'
  | 'resolveRecovery'
  | 'retryRecoveryRequiredCommit'
  | 'abandonRecoveryRequiredCommit';

/** What one commit request did. */
export type W5CommitOutcome =
  /** A keyed request seen before: its saved outcome, with no new effect. */
  | { status: 'replayed'; commitId: number; outcome: unknown }
  /** Already completed; the saved outcome expired, so no effect is repeated. */
  | { status: 'replay-expired'; commitId: number }
  /** Committed and written to its files. */
  | { status: 'applied'; commitId: number; revisions: Record<string, number> }
  /** Recorded and abandoned without writing files; revision advances stay. */
  | {
      status: 'conflict';
      commitId: number;
      revisions: Record<string, number>;
      conflicts: W5FileConflict[];
    }
  /**
   * Committed, but its files could not be brought up to date; the commit
   * waits for manual recovery and blocks later changes to those files.
   */
  | {
      status: 'recovery-required';
      commitId: number;
      revisions: Record<string, number>;
      apply: Extract<W5ApplyResult, { status: 'recovery-required' }>;
    };

/**
 * What retrying a commit awaiting recovery did, in the same request. Unlike
 * {@link W5CommitOutcome} it carries no revisions: the log keeps none per
 * commit, and a retry advances none.
 */
export type W5RecoveryRetryOutcome =
  /** Its files were brought up to date and it now counts as applied. */
  | { status: 'applied'; commitId: number }
  /** Its files still match neither side; it waits for recovery again. */
  | {
      status: 'recovery-required';
      commitId: number;
      apply: Extract<W5ApplyResult, { status: 'recovery-required' }>;
    };

/**
 * A failure the worker reports. The commit log's own errors keep their code
 * or refusal reason. `malformed` is a request the worker rejected before
 * running it; `failed` is any other failure, with a fixed message, after
 * which a commit may or may not have been made.
 */
export type W5CommitLogWorkerError =
  | ({
      kind: 'log';
      code: W5CommitLogErrorCode;
      message: string;
    } & W5UnderlyingDiagnostics)
  | { kind: 'config-unreadable'; message: string; errorCode?: string }
  | { kind: 'process-lock-timeout'; path: string; message: string }
  | { kind: 'fingerprint-conflict'; path: string; message: string }
  | {
      kind: 'refused';
      reason: W5CommitRefusal;
      message: string;
      details: Record<string, unknown>;
    }
  | { kind: 'malformed'; message: string }
  | { kind: 'failed'; message: string }
  /** A read that waited past its bound for writes to settle; it changed nothing. */
  | { kind: 'overloaded'; message: string };

/**
 * Host to worker. Writes go one at a time, in FIFO order; reads (`capture`,
 * `revision`, `recoveryReport`) can be sent beside them (CAN-5589).
 */
export interface W5CommitLogRequest {
  id: number;
  method: W5CommitLogMethod;
  args: readonly unknown[];
}

/** Worker to host: the outcome of the request with the same `id`. */
export type W5CommitLogResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: W5CommitLogWorkerError };

/**
 * Worker to host, sent once after the worker has opened the log and run
 * launch recovery, before any response. `ready` carries the capture root the
 * worker uses: the one it was started with, or the root's realpath it
 * resolved, absent if that failed.
 */
export type W5CommitLogStartupMessage =
  | { type: 'ready'; captureRoot?: string }
  | { type: 'openFailed'; error: W5CommitLogWorkerError };

const METHODS: ReadonlySet<string> = new Set<W5CommitLogMethod>([
  'recoveryReport',
  'commit',
  'revision',
  'lookupReceipt',
  'reserve',
  'updateReservationDiagnostics',
  'releaseReservation',
  'markReservationRecoveryRequired',
  'snapshot',
  'capture',
  'resolveRecovery',
  'retryRecoveryRequiredCommit',
  'abandonRecoveryRequiredCommit',
]);

function isRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isW5CommitLogMethod(
  value: unknown,
): value is W5CommitLogMethod {
  return typeof value === 'string' && METHODS.has(value);
}

function isWorkerError(value: unknown): value is W5CommitLogWorkerError {
  if (!isRecord(value) || typeof value.message !== 'string') return false;
  switch (value.kind) {
    case 'log':
      return (
        typeof value.code === 'string' &&
        (value.underlyingName === undefined ||
          isW5ErrorName(value.underlyingName)) &&
        (value.underlyingCode === undefined ||
          isW5ErrorCode(value.underlyingCode)) &&
        (value.underlyingErrcode === undefined ||
          isW5SqliteErrcode(value.underlyingErrcode))
      );
    case 'config-unreadable':
      return (
        value.errorCode === undefined || isW5FilesystemCode(value.errorCode)
      );
    case 'process-lock-timeout':
    case 'fingerprint-conflict':
      return typeof value.path === 'string' && value.path.length > 0;
    case 'refused':
      return typeof value.reason === 'string' && isRecord(value.details);
    case 'malformed':
    case 'failed':
    case 'overloaded':
      return true;
    default:
      return false;
  }
}

export function isW5CommitLogWorkerData(
  value: unknown,
): value is W5CommitLogWorkerData {
  return (
    isRecord(value) &&
    typeof value.dbPath === 'string' &&
    value.dbPath.length > 0 &&
    typeof value.root === 'string' &&
    value.root.length > 0 &&
    isOptionalPath(value.dataRoot) &&
    isOptionalPath(value.captureRoot) &&
    (value.readWaitMs === undefined ||
      (typeof value.readWaitMs === 'number' &&
        Number.isFinite(value.readWaitMs) &&
        value.readWaitMs > 0)) &&
    (value.healCleanConflictOperations === undefined ||
      (Array.isArray(value.healCleanConflictOperations) &&
        value.healCleanConflictOperations.every(
          (operation: unknown) =>
            typeof operation === 'string' &&
            operation.length > 0 &&
            operation.length <= 256,
        )))
  );
}

function isOptionalPath(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

export function isW5CommitLogRequest(
  value: unknown,
): value is W5CommitLogRequest {
  return (
    isRecord(value) &&
    isRequestId(value.id) &&
    isW5CommitLogMethod(value.method) &&
    Array.isArray(value.args)
  );
}

export function isW5CommitLogResponse(
  value: unknown,
): value is W5CommitLogResponse {
  if (!isRecord(value) || !isRequestId(value.id)) return false;
  if (value.ok === true) return 'result' in value;
  return value.ok === false && isWorkerError(value.error);
}

export function isW5CommitLogStartupMessage(
  value: unknown,
): value is W5CommitLogStartupMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'ready') return isOptionalPath(value.captureRoot);
  return value.type === 'openFailed' && isWorkerError(value.error);
}

function isCommitIdList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id),
    )
  );
}

function isRevisionMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (revision: unknown) =>
        typeof revision === 'number' && Number.isSafeInteger(revision),
    )
  );
}

export type W5HostRecoveryReport = W5RecoveryReport & {
  /** Existing reservation records, for host lifecycle diagnostics and id admission. */
  reservations?: W5Reservation[];
};

export function isW5RecoveryReport(
  value: unknown,
): value is W5HostRecoveryReport {
  return (
    isRecord(value) &&
    (value.abandoned === undefined ||
      (Array.isArray(value.abandoned) &&
        value.abandoned.every(
          (entry: unknown) =>
            isRecord(entry) &&
            isRequestId(entry.commitId) &&
            typeof entry.operation === 'string' &&
            entry.operation.length > 0 &&
            entry.operation.length <= 256,
        ))) &&
    isCommitIdList(value.applied) &&
    isCommitIdList(value.recoveryRequired) &&
    (value.recoveryRequiredDetails === undefined ||
      (Array.isArray(value.recoveryRequiredDetails) &&
        value.recoveryRequiredDetails.every(
          (detail: unknown) =>
            isRecord(detail) &&
            isW5Revision(detail.commitId) &&
            isW5Revision(detail.conflictCount) &&
            isW5Revision(detail.writtenFileCount) &&
            typeof detail.unexpectedFailure === 'boolean',
        ))) &&
    (value.recoveryRequiredReservations === undefined ||
      (Array.isArray(value.recoveryRequiredReservations) &&
        value.recoveryRequiredReservations.every(
          (id: unknown) => typeof id === 'string',
        ))) &&
    (value.reservations === undefined ||
      (Array.isArray(value.reservations) &&
        value.reservations.every(
          (entry: unknown) =>
            isRecord(entry) &&
            typeof entry.reservationId === 'string' &&
            typeof entry.operation === 'string' &&
            (entry.state === 'reserved' ||
              entry.state === 'recovery-required') &&
            'diagnostics' in entry,
        ))) &&
    typeof value.interruptedReservations === 'number'
  );
}

export function isW5Revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isW5CommitOutcome(value: unknown): value is W5CommitOutcome {
  if (!isRecord(value) || typeof value.commitId !== 'number') return false;
  switch (value.status) {
    case 'replayed':
      return 'outcome' in value;
    case 'replay-expired':
      return Number.isSafeInteger(value.commitId) && value.commitId > 0;
    case 'applied':
      return isRevisionMap(value.revisions);
    case 'conflict':
      return (
        isRequestId(value.commitId) &&
        isRevisionMap(value.revisions) &&
        Array.isArray(value.conflicts) &&
        value.conflicts.length > 0 &&
        value.conflicts.every(isW5FileConflict)
      );
    case 'recovery-required':
      return (
        isRevisionMap(value.revisions) && isRecoveryRequiredApply(value.apply)
      );
    default:
      return false;
  }
}

function isRecoveryRequiredApply(
  value: unknown,
): value is Extract<W5ApplyResult, { status: 'recovery-required' }> {
  return (
    isRecord(value) &&
    value.status === 'recovery-required' &&
    Array.isArray(value.conflicts) &&
    Array.isArray(value.written)
  );
}

export function isW5RecoveryRetryOutcome(
  value: unknown,
): value is W5RecoveryRetryOutcome {
  if (!isRecord(value) || !isW5Revision(value.commitId) || value.commitId === 0)
    return false;
  switch (value.status) {
    case 'applied':
      return true;
    case 'recovery-required':
      return isRecoveryRequiredApply(value.apply);
    default:
      return false;
  }
}

/** The `id` of a message, when it carries one a response can answer. */
export function readW5CommitLogRequestId(value: unknown): number | undefined {
  return isRecord(value) && isRequestId(value.id) ? value.id : undefined;
}

export function isW5ReceiptLookup(value: unknown): value is W5ReceiptLookup {
  if (!isRecord(value)) return false;
  switch (value.status) {
    case 'none':
    case 'key-reused':
      return true;
    case 'replay':
      return isW5Revision(value.commitId) && 'outcome' in value;
    case 'replay-expired':
      return isW5Revision(value.commitId);
    case 'commit-recovery-required':
      return isW5Revision(value.commitId) && 'diagnostics' in value;
    case 'in-progress':
      return typeof value.reservationId === 'string';
    case 'recovery-required':
      return typeof value.reservationId === 'string' && 'diagnostics' in value;
    default:
      return false;
  }
}

/** Private worker reply for the backup's stable log position. */
export function isW5BackupPosition(value: unknown): value is W5BackupPosition {
  return (
    isRecord(value) &&
    isW5Revision(value.commitId) &&
    // The log's own schema; the backup compares it, the host does not.
    isW5Revision(value.schemaVersion) &&
    value.schemaVersion > 0 &&
    isRecord(value.revisions) &&
    Object.values(value.revisions).every(isW5Revision)
  );
}
