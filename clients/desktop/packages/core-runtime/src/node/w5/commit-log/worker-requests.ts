import { basename } from 'node:path';
import { readWorkspaceIndex } from '../../workspace/read-formats';
import { captureW5Files } from './capture';
import {
  isW5CaptureRequest,
  isW5CaptureWorkspaceId,
  type W5ConfinedFileReaderSource,
} from './capture-contract';
import { workspaceCreationDiagnosticsSchema } from './reservation-diagnostics';
import {
  applyW5Commit,
  isCleanApplyConflict,
  preflightW5CommitFiles,
  type W5ApplyResult,
  type W5DurabilityPort,
  type W5RecoveryReport,
  type W5ProcessFileLock,
  isTransientUnwrittenApplyFailure,
} from './apply';
import type {
  W5CommitLog,
  W5CommitRequest,
  W5Resource,
  W5ReceiptKey,
} from './commit-log';
import {
  W5CommitLogError,
  W5FileWriteRefusedError,
  W5CommitRefusedError,
  W5ProcessFileLockTimeoutError,
} from './errors';
import { isRecord } from './is-record';
import { W5_LAUNCH_HEAL_OPERATIONS } from './apply-evidence';
import { fingerprintW5File } from './fingerprint';
import type {
  W5CommitLogRequest,
  W5CommitLogWorkerData,
  W5CommitLogWorkerError,
  W5CommitOutcome,
  W5RecoveryRetryOutcome,
} from './worker-contract';

/*
 * How the W5 commit log worker runs a request, apart from the thread it runs
 * in, so it can be tested on a log opened in the test process (CAN-3805).
 */

export const MALFORMED_REQUEST_MESSAGE =
  'The W5 commit log request is malformed';
const UNEXPECTED_FAILURE_MESSAGE = 'The W5 commit log call failed unexpectedly';

/** A request this worker rejects before running it. */
class W5CommitLogRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'W5CommitLogRequestError';
  }
}

export function toW5CommitLogWorkerError(
  error: unknown,
): W5CommitLogWorkerError {
  if (error instanceof W5FileWriteRefusedError)
    return {
      kind: 'fingerprint-conflict',
      path: error.path,
      message: error.message,
    };
  if (error instanceof W5ProcessFileLockTimeoutError)
    return {
      kind: 'process-lock-timeout',
      path: error.path,
      message: error.message,
    };
  if (error instanceof W5CommitRefusedError) {
    return {
      kind: 'refused',
      reason: error.reason,
      message: error.message,
      details: { ...error.details },
    };
  }
  if (error instanceof W5CommitLogError) {
    return { kind: 'log', code: error.code, message: error.message };
  }
  if (error instanceof W5CommitLogRequestError) {
    return { kind: 'malformed', message: error.message };
  }
  return { kind: 'failed', message: unexpectedFailureMessage(error) };
}

// Names and errno codes only: an error message could quote a file path.
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function identifierField(error: object, field: string): string | undefined {
  const value: unknown = Reflect.get(error, field);
  return typeof value === 'string' && IDENTIFIER.test(value)
    ? value
    : undefined;
}

function unexpectedFailureMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null)
    return UNEXPECTED_FAILURE_MESSAGE;
  const name = identifierField(error, 'name');
  if (name === undefined) return UNEXPECTED_FAILURE_MESSAGE;
  const code = identifierField(error, 'code');
  return `${UNEXPECTED_FAILURE_MESSAGE} (${code === undefined ? name : `${name} ${code}`})`;
}

function isResource(value: unknown): value is W5Resource {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'workspaces':
      return true;
    case 'workspace':
    case 'worktrees':
      return typeof value.workspaceId === 'string';
    case 'worktree':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.worktreeId === 'string'
      );
    default:
      return false;
  }
}

function isReceipt(
  value: unknown,
): value is W5ReceiptKey & { fingerprint: string } {
  return (
    isRecord(value) &&
    typeof value.caller === 'string' &&
    typeof value.operation === 'string' &&
    typeof value.idempotencyKey === 'string' &&
    typeof value.fingerprint === 'string'
  );
}

function isExpectedRevision(value: unknown): boolean {
  return (
    isRecord(value) &&
    isResource(value.resource) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision)
  );
}

function isReservationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCommitId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isCommitRequest(value: unknown): value is W5CommitRequest {
  return (
    isRecord(value) &&
    typeof value.operation === 'string' &&
    (value.receipt === undefined || isReceipt(value.receipt)) &&
    (value.expectedRevisions === undefined ||
      (Array.isArray(value.expectedRevisions) &&
        value.expectedRevisions.every(isExpectedRevision))) &&
    (value.reservationId === undefined ||
      typeof value.reservationId === 'string') &&
    'outcome' in value &&
    Array.isArray(value.advance) &&
    value.advance.every(isResource) &&
    Array.isArray(value.files) &&
    value.files.every(
      (file: unknown) =>
        isRecord(file) &&
        typeof file.path === 'string' &&
        (file.contents === null || typeof file.contents === 'string') &&
        (file.previousFingerprint === null ||
          typeof file.previousFingerprint === 'string'),
    )
  );
}

export class W5CommitLogRequestHandler {
  constructor(
    private readonly log: W5CommitLog,
    private readonly data: W5CommitLogWorkerData,
    private readonly recovery: W5RecoveryReport,
    /** Supplied by the host that composes the worker. */
    private readonly durability: W5DurabilityPort,
    /** Trusted host OS, never supplied in a capture request. */
    private readonly platform: NodeJS.Platform | null,
    /** The host's Windows handle confinement; without it Windows capture refuses. */
    private readonly confined?: W5ConfinedFileReaderSource,
    private readonly processLock?: W5ProcessFileLock,
  ) {}

  async run(request: W5CommitLogRequest): Promise<unknown> {
    const [first] = request.args;
    switch (request.method) {
      case 'recoveryReport': {
        const reservations = this.log.listReservations();
        return {
          ...this.recovery,
          ...(reservations.length ? { reservations } : {}),
        };
      }
      case 'capture':
        if (request.args.length !== 1 || !isW5CaptureRequest(first))
          throw malformed();
        return captureW5Files(
          this.log,
          this.data.root,
          first,
          this.platform,
          this.confined,
          this.data.captureRoot,
        );
      case 'snapshot':
        return this.log.snapshot();
      case 'revision':
        if (!isResource(first)) throw malformed();
        return this.log.revision(first);
      case 'lookupReceipt':
        if (!isReceipt(first)) throw malformed();
        return this.lockPending([], async () => {
          await this.finishPendingCommits();
          return this.log.lookupReceipt(first, first.fingerprint);
        });
      case 'reserve': {
        if (
          !isRecord(first) ||
          typeof first.reservationId !== 'string' ||
          typeof first.operation !== 'string' ||
          (first.receipt !== undefined &&
            (!isReceipt(first.receipt) ||
              first.operation !== first.receipt.operation))
        )
          throw malformed();
        const { reservationId, operation, receipt } = first;
        const workspaceIdentity = first.workspaceIdentity;
        const expectedRecords = first.expectedWorkspaceRecords;
        if (
          expectedRecords !== undefined &&
          (workspaceIdentity === undefined ||
            !isRecord(expectedRecords) ||
            ![expectedRecords.manifest, expectedRecords.worktrees].every(
              (value) =>
                value === null ||
                (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)),
            ) ||
            Object.keys(expectedRecords).some(
              (key) => key !== 'manifest' && key !== 'worktrees',
            ))
        )
          throw malformed();
        if (workspaceIdentity !== undefined) {
          if (!isW5CaptureWorkspaceId(workspaceIdentity)) throw malformed();
          await this.lockPending([], async () => {
            await this.finishPendingCommits();
            const captured = await captureW5Files(
              this.log,
              this.data.root,
              {
                files: [
                  { kind: 'index' },
                  { kind: 'manifest', workspaceId: workspaceIdentity },
                  { kind: 'worktrees', workspaceId: workspaceIdentity },
                ],
                discoverWorkspaces: false,
              },
              this.platform,
              this.confined,
              this.data.captureRoot,
            );
            const image = captured.files.find((file) => file.kind === 'index');
            const index = readWorkspaceIndex(
              image?.state === 'present'
                ? {
                    state: 'present',
                    raw: Buffer.from(image.base64, 'base64').toString('utf8'),
                  }
                : {
                    state: image?.state === 'absent' ? 'absent' : 'unreadable',
                  },
              () => undefined,
            );
            if (index.authority !== 'ok' && index.authority !== 'absent')
              throw new W5CommitRefusedError(
                'invalid-state',
                'The workspace index cannot prove identity availability.',
              );
            if (captured.files.some((file) => file.state === 'unreadable'))
              throw new W5CommitRefusedError(
                'invalid-state',
                'The workspace records cannot prove identity availability.',
              );
            if (
              index.entries.some(
                (entry) =>
                  entry.id.toLowerCase() === workspaceIdentity.toLowerCase(),
              ) ||
              captured.files.some((file) => {
                if (file.kind !== 'manifest' && file.kind !== 'worktrees')
                  return false;
                const expected = isRecord(expectedRecords)
                  ? expectedRecords[file.kind]
                  : null;
                return (
                  file.state === 'unreadable' ||
                  fingerprintW5File(
                    file.state === 'present'
                      ? Buffer.from(file.base64, 'base64').toString('utf8')
                      : null,
                  ) !== expected
                );
              })
            )
              throw new W5CommitRefusedError(
                'identity-conflict',
                'This workspace identity is already occupied.',
              );
            this.log.reserve({
              reservationId,
              operation,
              receipt,
              diagnostics: first.diagnostics ?? null,
              workspaceIdentity,
            });
          });
          return null;
        }
        this.log.reserve({
          reservationId: first.reservationId,
          operation: first.operation,
          receipt: first.receipt,
          diagnostics: first.diagnostics ?? null,
        });
        return null;
      }
      case 'updateReservationDiagnostics': {
        const diagnostics = workspaceCreationDiagnosticsSchema.safeParse(
          request.args[1],
        );
        if (typeof first !== 'string' || !diagnostics.success)
          throw malformed();
        this.log.updateReservationDiagnostics(first, diagnostics.data);
        return null;
      }
      case 'releaseReservation':
        if (typeof first !== 'string') throw malformed();
        this.log.releaseReservation(first);
        return null;
      case 'markReservationRecoveryRequired': {
        const diagnostics = request.args[1];
        if (
          typeof first !== 'string' ||
          !isRecord(diagnostics) ||
          typeof diagnostics.operation !== 'string' ||
          typeof diagnostics.errorName !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(diagnostics.errorName) ||
          (diagnostics.errorCode !== undefined &&
            (typeof diagnostics.errorCode !== 'string' ||
              !/^[A-Z][A-Z0-9_]{0,63}$/.test(diagnostics.errorCode)))
        )
          throw malformed();
        this.log.markReservationRecoveryRequired(first, {
          operation: diagnostics.operation,
          errorName: diagnostics.errorName,
          ...(diagnostics.errorCode === undefined
            ? {}
            : { errorCode: diagnostics.errorCode }),
        });
        return null;
      }
      case 'commit':
        if (!isCommitRequest(first)) throw malformed();
        return this.lockPending(
          first.files.map((file) => file.path),
          () => this.commit(first),
        );
      case 'resolveRecovery':
      case 'retryRecoveryRequiredCommit':
      case 'abandonRecoveryRequiredCommit':
        return this.recover(request.method, request.args);
    }
  }

  /**
   * Manual recovery, for offline maintenance's cold host only (RX1). Each
   * takes exactly one ID; a wrong state refuses `invalid-state`.
   */
  private async recover(
    method:
      | 'resolveRecovery'
      | 'retryRecoveryRequiredCommit'
      | 'abandonRecoveryRequiredCommit',
    args: readonly unknown[],
  ): Promise<W5RecoveryRetryOutcome | null> {
    const [id] = args;
    if (args.length !== 1) throw malformed();
    if (method === 'resolveRecovery') {
      if (!isReservationId(id)) throw malformed();
      this.log.resolveRecovery(id);
      return null;
    }
    if (!isCommitId(id)) throw malformed();
    if (method === 'retryRecoveryRequiredCommit')
      return this.lockPending(this.log.recoveryCommitPaths(id), () =>
        this.retryRecoveryRequiredCommit(id),
      );
    this.log.abandonRecoveryRequiredCommit(id);
    return null;
  }

  /**
   * Puts a commit awaiting recovery back in the apply flow and applies it
   * before answering, so the caller learns whether the restored files took it.
   */
  private async retryRecoveryRequiredCommit(
    commitId: number,
  ): Promise<W5RecoveryRetryOutcome> {
    // As in `commit`: commits an earlier call left unwritten are written first.
    await this.finishPendingCommits();
    this.log.retryRecoveryRequiredCommit(commitId);
    const pending = this.log
      .listPendingCommits()
      .find((commit) => commit.commitId === commitId);
    if (!pending) throw new Error(UNEXPECTED_FAILURE_MESSAGE);
    const applied = await applyW5Commit(this.log, pending, {
      root: this.data.root,
      durability: this.durability,
    });
    return applied.status === 'applied'
      ? { status: 'applied', commitId }
      : { status: 'recovery-required', commitId, apply: applied };
  }

  private async commit(request: W5CommitRequest): Promise<W5CommitOutcome> {
    // An earlier call can fail after its commit is durable. Its files are
    // written first, so a replay never reports an outcome they do not hold
    // and a later change never commits over it.
    await this.finishPendingCommits();
    // Client preflight can become stale while waiting for this worker's lock.
    // Recheck list-bearing decisions here before a keyed decision can wedge.
    if (
      this.processLock &&
      request.files.some(
        (file) => basename(file.path).toLowerCase() === 'worktrees.json',
      )
    ) {
      const lookup = request.receipt
        ? this.log.lookupReceipt(request.receipt, request.receipt.fingerprint)
        : undefined;
      if (
        !lookup ||
        lookup.status === 'none' ||
        (lookup.status === 'in-progress' &&
          lookup.reservationId === request.reservationId)
      ) {
        this.log.refuseInadmissibleCommit(request);
        await preflightW5CommitFiles(request.files, this.data.root);
      }
    }
    const result = this.log.commit(request);
    if (result.status === 'replayed' || result.status === 'replay-expired')
      return result;
    const pending = this.log
      .listPendingCommits()
      .find((commit) => commit.commitId === result.commitId);
    // Nothing else was pending, so a missing commit means the log changed
    // under this worker.
    if (!pending) throw new Error(UNEXPECTED_FAILURE_MESSAGE);
    const applied = await applyW5Commit(this.log, pending, {
      root: this.data.root,
      durability: this.durability,
    });
    this.keepTransientFailurePending(result.commitId, applied);
    if (
      isCleanApplyConflict(applied) &&
      request.receipt === undefined &&
      request.reservationId === undefined
    ) {
      this.log.abandonRecoveryRequiredCommit(result.commitId);
      return {
        status: 'conflict',
        commitId: result.commitId,
        revisions: result.revisions,
        conflicts: applied.conflicts,
      };
    }
    return applied.status === 'applied'
      ? {
          status: 'applied',
          commitId: result.commitId,
          revisions: result.revisions,
        }
      : {
          status: 'recovery-required',
          commitId: result.commitId,
          revisions: result.revisions,
          apply: applied,
        };
  }

  /** Lock before the decision and hold until apply stops, independent of RPC lifetime. */
  private lockPending<T>(
    paths: readonly string[],
    work: () => Promise<T>,
  ): Promise<T> {
    const pending = this.log
      .listPendingCommits()
      .flatMap((commit) => commit.files.map((file) => file.path));
    return this.processLock
      ? this.processLock([...paths, ...pending], work)
      : work();
  }

  private async finishPendingCommits(): Promise<void> {
    for (const pending of this.log.listPendingCommits()) {
      const applied = await applyW5Commit(this.log, pending, {
        root: this.data.root,
        durability: this.durability,
      });
      this.keepTransientFailurePending(pending.commitId, applied);
    }
  }

  /**
   * CAN-5680: an unkeyed list write that stopped on a transient I/O error
   * before writing anything stays pending instead of awaiting recovery, so
   * the next write applies it first once the error clears. Keyed commits keep
   * waiting for recovery: a replay must never report an outcome the files do
   * not hold.
   */
  private keepTransientFailurePending(
    commitId: number,
    applied: W5ApplyResult,
  ): void {
    if (!isTransientUnwrittenApplyFailure(applied)) return;
    const row = this.log
      .listRecoveryRequiredCommits()
      .find((entry) => entry.commitId === commitId);
    if (
      row &&
      !row.hasReceipt &&
      W5_LAUNCH_HEAL_OPERATIONS.includes(row.operation)
    )
      this.log.retryRecoveryRequiredCommit(commitId);
  }
}

function malformed(): W5CommitLogRequestError {
  return new W5CommitLogRequestError(MALFORMED_REQUEST_MESSAGE);
}
