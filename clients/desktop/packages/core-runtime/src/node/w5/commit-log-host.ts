import {
  dirname,
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { Worker } from 'node:worker_threads';
// Explicit commit-log modules only: the commit-log index loads node:sqlite,
// which only the worker opens.
import type {
  W5BackupPosition,
  W5CommitRequest,
  W5ReceiptLookup,
  W5ReservationFailureDiagnostics,
  W5Resource,
} from './commit-log/commit-log';
import {
  W5CommitLogError,
  W5CommitRefusedError,
  W5ProcessFileLockTimeoutError,
  W5FileWriteRefusedError,
} from './commit-log/errors';
import type { WorkspaceCreationDiagnostics } from './commit-log/reservation-diagnostics';
import {
  isW5CaptureRequest,
  isW5CaptureResult,
  freezeW5Capture,
  type W5CaptureRequest,
  type W5CaptureResult,
  isW5CommitLogResponse,
  isW5CommitLogStartupMessage,
  isW5CommitOutcome,
  isW5RecoveryReport,
  isW5RecoveryRetryOutcome,
  isW5Revision,
  isW5ReceiptLookup,
  isW5BackupPosition,
  type W5CommitLogMethod,
  type W5CommitLogRequest,
  type W5CommitLogHostWorkerData,
  type W5CommitLogWorkerError,
  type W5CommitOutcome,
  type W5HostRecoveryReport,
  type W5RecoveryRetryOutcome,
} from './commit-log/worker-contract';
import type { W5CommitLogHostPort } from './commit-log-file-store';

const WORKER_NAME = 'w5-commit-log';
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_QUEUED_READ_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_QUEUED_CALLS = 256;
// A worker blocked in a native SQLite call stops only once that call returns.
const DEFAULT_WORKER_EXIT_WAIT_MS = 2_000;

export interface W5CommitLogHostOptions {
  /** The commit log the worker opens. The host itself never touches it. */
  dbPath: string;
  /** The W5 data root; every file a commit writes must be inside it. */
  root: string;
  /**
   * The canonical data root holding `root` and `dbPath`'s folder, which the
   * worker makes durable up to it before `ready`. Default: `root` alone.
   */
  dataRoot?: string;
  healCleanConflictOperations?: readonly string[];
  /**
   * win32: the native addon the host's worker entry loads its handle-confined
   * capture reader from, passed through as worker data. The portable worker
   * body never reads it.
   */
  confinementAddon?: string | undefined;
  /** The worker entry each host bundles beside its own entry. */
  workerEntry: string;
  /** Bounds the wait for the worker to open the log and recover it. */
  startupTimeoutMs?: number;
  /** Bounds each request, from send to response. */
  requestTimeoutMs?: number;
  /** Bounds queue waits for capture, revision and recoveryReport only. */
  queuedReadTimeoutMs?: number;
  /** Operational warnings only; defaults to stderr outside a logging host. */
  warn?: (message: string, context: Record<string, unknown>) => void;
  /** Bounds the wait for the in-flight request during shutdown. */
  shutdownTimeoutMs?: number;
  /** Calls allowed to wait for their turn before new calls are refused. */
  maxQueuedCalls?: number;
  /** Bounds each wait for stopped workers to exit. */
  workerExitWaitMs?: number;
  /**
   * Writer admission, awaited before each worker start; a rejection refuses
   * the waiting calls as `unavailable`. Production hosts must pass one.
   */
  admission?: () => Promise<void>;
  /** Cold compositions revalidate operation authority immediately before dispatch. */
  requestAdmission?: (request: W5CommitLogRequest) => Promise<void>;
  /** Pre-handoff backup: launch recovery and snapshots only, never new decisions. */
  snapshotOnly?: true;
}

/**
 * Why a call failed outside the commit log itself.
 *
 * - `unavailable`: the call never reached the worker (the host is shutting
 *   down or busy, or the worker could not start), so it changed nothing.
 * - `outcome-unknown`: the call reached the worker, which stopped, did not
 *   answer in time, or failed unexpectedly. A commit may have been made; the
 *   next worker's launch recovery finishes writing it.
 * - `malformed`: the worker rejected the request before running it.
 */
export type W5CommitLogHostFailure =
  | 'unavailable'
  | 'outcome-unknown'
  | 'malformed';

export class W5CommitLogHostError extends Error {
  constructor(
    readonly reason: W5CommitLogHostFailure,
    message: string,
    readonly unavailableCause?: 'queue-full' | 'queued-wait',
  ) {
    super(message);
    this.name = 'W5CommitLogHostError';
  }
}

/** A failed call: the commit log's own error, or the host's. */
type W5CommitLogCallError =
  | W5CommitLogError
  | W5ProcessFileLockTimeoutError
  | W5FileWriteRefusedError
  | W5CommitRefusedError
  | W5CommitLogHostError;

function toCallError(error: W5CommitLogWorkerError): W5CommitLogCallError {
  switch (error.kind) {
    case 'fingerprint-conflict':
      return new W5FileWriteRefusedError(error.path);
    case 'process-lock-timeout':
      return new W5ProcessFileLockTimeoutError(error.path);
    case 'log':
      return new W5CommitLogError(error.code, error.message);
    case 'refused':
      return new W5CommitRefusedError(
        error.reason,
        error.message,
        error.details,
      );
    case 'malformed':
      return new W5CommitLogHostError('malformed', error.message);
    case 'failed':
      return new W5CommitLogHostError('outcome-unknown', error.message);
  }
}

function unavailable(message: string): W5CommitLogHostError {
  return new W5CommitLogHostError('unavailable', message);
}

function outcomeUnknown(message: string): W5CommitLogHostError {
  return new W5CommitLogHostError('outcome-unknown', message);
}

/** A result of the wrong shape: the call ran, but what it did is unknown. */
function unexpectedResult(): W5CommitLogHostError {
  return outcomeUnknown('The W5 commit log sent an unexpected result');
}

function positiveOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return value;
}

async function isAdmitted(admission: () => Promise<void>): Promise<boolean> {
  try {
    await admission();
    return true;
  } catch {
    return false;
  }
}

async function waitAtMost(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isInside(folder: string, dataRoot: string): boolean {
  const path = relative(resolvePath(dataRoot), resolvePath(folder));
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** A data root must hold the root and the database's folder. */
function dataRootOption(
  options: W5CommitLogHostOptions,
): { dataRoot: string } | undefined {
  const { dataRoot } = options;
  if (dataRoot === undefined) return undefined;
  if (
    !isInside(options.root, dataRoot) ||
    !isInside(dirname(options.dbPath), dataRoot)
  ) {
    throw new RangeError('dataRoot must hold root and dbPath');
  }
  return { dataRoot };
}

interface PendingCall {
  readonly request: W5CommitLogRequest;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: W5CommitLogCallError) => void;
  /** A capture that already replaced a worker that had no capture root. */
  reanchored: boolean;
  queuedTimer: ReturnType<typeof setTimeout> | undefined;
  queuedDeadline: number | undefined;
}

interface WorkerSession {
  readonly worker: Worker;
  /** Its place in start order, as `workersStarted` counted it. */
  readonly number: number;
  ready: boolean;
  /** Reported a capture root at startup. */
  anchored: boolean;
  active: PendingCall | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly idleWaiters: Array<() => void>;
}

/**
 * Owns the lazily started worker thread that holds the W5 commit log's only
 * connection, so synchronous SQLite stays off the host's event loop (CAN-3805).
 * Nothing starts until the first call; the worker then opens the log and runs
 * launch recovery before it answers. There is no fallback to the main thread:
 * when the worker is unavailable, calls fail with a typed error, and the next
 * call starts a fresh worker, whose recovery finishes any commit the previous
 * one made but did not write.
 */
export class W5CommitLogHost implements W5CommitLogHostPort {
  private readonly workerData: W5CommitLogHostWorkerData;
  private readonly workerEntry: string;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly queuedReadTimeoutMs: number;
  private readonly warn: (
    message: string,
    context: Record<string, unknown>,
  ) => void;
  private readonly shutdownTimeoutMs: number;
  private readonly maxQueuedCalls: number;
  private readonly workerExitWaitMs: number;
  private readonly admission: (() => Promise<void>) | undefined;
  private readonly requestAdmission:
    | ((request: W5CommitLogRequest) => Promise<void>)
    | undefined;
  private checkingRequest = false;
  private readonly snapshotOnly: boolean;
  private readonly queue: PendingCall[] = [];
  /** Settles when a started worker exits; removed once it has. */
  private readonly runningWorkers = new Set<Promise<void>>();
  private session: WorkerSession | undefined;
  /** The first worker's anchored root; every later worker is started with it. */
  private anchoredCaptureRoot: string | undefined;
  private launching = false;
  private closing = false;
  private shutdownPromise: Promise<void> | undefined;
  private nextRequestId = 0;
  private started = 0;
  private recovered = 0;
  private readonly exitListeners = new Set<() => void>();

  constructor(options: W5CommitLogHostOptions) {
    this.workerData = {
      dbPath: options.dbPath,
      root: options.root,
      ...dataRootOption(options),
      ...(options.healCleanConflictOperations !== undefined && {
        healCleanConflictOperations: options.healCleanConflictOperations,
      }),
      ...(options.confinementAddon !== undefined && {
        confinementAddon: options.confinementAddon,
      }),
    };
    this.workerEntry = options.workerEntry;
    this.startupTimeoutMs = positiveOption(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      'startupTimeoutMs',
    );
    this.requestTimeoutMs = positiveOption(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.queuedReadTimeoutMs = positiveOption(
      options.queuedReadTimeoutMs,
      DEFAULT_QUEUED_READ_TIMEOUT_MS,
      'queuedReadTimeoutMs',
    );
    this.warn =
      options.warn ??
      ((message, context): void => {
        process.stderr.write(`${message} ${JSON.stringify(context)}\n`);
      });
    this.shutdownTimeoutMs = positiveOption(
      options.shutdownTimeoutMs,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      'shutdownTimeoutMs',
    );
    this.maxQueuedCalls = positiveOption(
      options.maxQueuedCalls,
      DEFAULT_MAX_QUEUED_CALLS,
      'maxQueuedCalls',
    );
    this.workerExitWaitMs = positiveOption(
      options.workerExitWaitMs,
      DEFAULT_WORKER_EXIT_WAIT_MS,
      'workerExitWaitMs',
    );
    this.admission = options.admission;
    this.requestAdmission = options.requestAdmission;
    this.snapshotOnly = options.snapshotOnly === true;
  }

  /**
   * Workers that have not exited yet. Shutdown waits only a bounded time for
   * them, so a caller that needs the data root quiet must check this after it.
   */
  get runningWorkerCount(): number {
    return this.runningWorkers.size;
  }

  /** The W5 data root the worker captures and writes under. */
  get root(): string {
    return this.workerData.root;
  }

  /**
   * The root's realpath, anchored by this host's first worker before it was
   * ready; Windows capture reads are confined to it. Undefined until then.
   */
  get captureRoot(): string | undefined {
    return this.anchoredCaptureRoot;
  }

  /** How many workers this host has started. */
  get workersStarted(): number {
    return this.started;
  }

  /**
   * The start number of the latest worker whose launch recovery completed, so
   * its effects are on disk; 0 until one has. A started worker counts only
   * once it reports ready.
   */
  get recoveredWorker(): number {
    return this.recovered;
  }

  /**
   * Calls `listener` after each worker this host started exits, so nothing
   * it was running can still change the files. Returns its removal.
   */
  onWorkerExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return (): void => {
      this.exitListeners.delete(listener);
    };
  }

  /** What launch recovery found when the running worker opened the log. */
  async recoveryReport(): Promise<W5HostRecoveryReport> {
    const result = await this.call('recoveryReport', []);
    if (!isW5RecoveryReport(result)) throw unexpectedResult();
    return result;
  }

  /** Commits a change and writes its files before resolving. */
  async commit(request: W5CommitRequest): Promise<W5CommitOutcome> {
    const result = await this.call('commit', [request]);
    if (!isW5CommitOutcome(result)) throw unexpectedResult();
    return result;
  }

  async lookupReceipt(
    receipt: NonNullable<W5CommitRequest['receipt']>,
  ): Promise<W5ReceiptLookup> {
    const result = await this.call('lookupReceipt', [receipt]);
    if (!isW5ReceiptLookup(result)) throw unexpectedResult();
    return result;
  }

  async reserve(input: {
    workspaceIdentity?: string;
    expectedWorkspaceRecords?: {
      manifest: string | null;
      worktrees: string | null;
    };
    reservationId: string;
    operation: string;
    receipt?: NonNullable<W5CommitRequest['receipt']>;
    diagnostics?: unknown;
  }): Promise<void> {
    const result = await this.call('reserve', [input]);
    if (result !== null) throw unexpectedResult();
  }

  async updateReservationDiagnostics(
    reservationId: string,
    diagnostics: WorkspaceCreationDiagnostics,
  ): Promise<void> {
    const result = await this.call('updateReservationDiagnostics', [
      reservationId,
      diagnostics,
    ]);
    if (result !== null) throw unexpectedResult();
  }

  async releaseReservation(reservationId: string): Promise<void> {
    const result = await this.call('releaseReservation', [reservationId]);
    if (result !== null) throw unexpectedResult();
  }

  async markReservationRecoveryRequired(
    reservationId: string,
    diagnostics: W5ReservationFailureDiagnostics,
  ): Promise<void> {
    const result = await this.call('markReservationRecoveryRequired', [
      reservationId,
      diagnostics,
    ]);
    if (result !== null) throw unexpectedResult();
  }

  async revision(resource: W5Resource): Promise<number> {
    const result = await this.call('revision', [resource]);
    if (!isW5Revision(result)) throw unexpectedResult();
    return result;
  }

  /** Exact position and tombstone revisions for namespace backup verification. */
  async snapshot(): Promise<W5BackupPosition> {
    const result = await this.call('snapshot', []);
    if (!isW5BackupPosition(result)) throw unexpectedResult();
    return { ...result, revisions: { ...result.revisions } };
  }

  /** Private single-position read; launch recovery remains a lifecycle prerequisite. */
  async capture(request: W5CaptureRequest): Promise<W5CaptureResult> {
    if (!isW5CaptureRequest(request))
      throw new W5CommitLogHostError(
        'malformed',
        'The W5 capture request is malformed',
      );
    // Own the request while queued; callers cannot change its dependency set.
    const result = await this.call('capture', [
      {
        files: request.files.map((file) => ({ ...file })),
        discoverWorkspaces: request.discoverWorkspaces,
      },
    ]);
    if (!isW5CaptureResult(result)) throw unexpectedResult();
    return freezeW5Capture(result);
  }

  /*
   * Manual recovery, for offline maintenance's cold host only (RX1; RX2 is
   * the one caller). The worker validates the arguments, and a reservation or
   * commit in the wrong state refuses `invalid-state`.
   */

  /** Drops a reservation awaiting recovery, so its key may be used again. */
  async resolveRecovery(reservationId: string): Promise<void> {
    const result = await this.call('resolveRecovery', [reservationId]);
    if (result !== null) throw unexpectedResult();
  }

  /**
   * Puts a commit awaiting recovery back in the apply flow and applies it in
   * the same request: `applied` once its files took it, `recovery-required`
   * when they still match neither side.
   */
  async retryRecoveryRequiredCommit(
    commitId: number,
  ): Promise<W5RecoveryRetryOutcome> {
    const result = await this.call('retryRecoveryRequiredCommit', [commitId]);
    if (!isW5RecoveryRetryOutcome(result) || result.commitId !== commitId)
      throw unexpectedResult();
    return result;
  }

  /**
   * Drops a commit awaiting recovery and its receipt, leaving its files as
   * they are. Its revision advances stay.
   */
  async abandonRecoveryRequiredCommit(commitId: number): Promise<void> {
    const result = await this.call('abandonRecoveryRequiredCommit', [commitId]);
    if (result !== null) throw unexpectedResult();
  }

  /**
   * Refuses new calls and rejects the ones still waiting for their turn, lets
   * the in-flight call finish within the shutdown bound, then stops the worker
   * so the commit log's lock is released. Repeated calls share one shutdown.
   */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.closing = true;
      this.shutdownPromise = this.stop();
    }
    return this.shutdownPromise;
  }

  private call(
    method: W5CommitLogMethod,
    args: readonly unknown[],
  ): Promise<unknown> {
    if (this.snapshotOnly && method !== 'snapshot')
      return Promise.reject(
        unavailable('The W5 backup host permits snapshots only'),
      );
    if (this.closing) {
      return Promise.reject(unavailable('The W5 commit log is shut down'));
    }
    if (this.queue.length >= this.maxQueuedCalls) {
      return Promise.reject(
        new W5CommitLogHostError(
          'unavailable',
          'The W5 commit log is busy',
          'queue-full',
        ),
      );
    }
    this.nextRequestId += 1;
    const request: W5CommitLogRequest = {
      id: this.nextRequestId,
      method,
      args,
    };
    return new Promise<unknown>((resolve, reject) => {
      const call: PendingCall = {
        request,
        resolve,
        reject,
        reanchored: false,
        queuedTimer: undefined,
        queuedDeadline: undefined,
      };
      this.queue.push(call);
      this.armQueuedRead(call);
      this.pump();
    });
  }

  private armQueuedRead(call: PendingCall): void {
    const method = call.request.method;
    // Only these reads have an admission/queue deadline. Durable writes keep
    // their existing wait policy until sent or refused by the host lifecycle.
    if (
      method !== 'capture' &&
      method !== 'revision' &&
      method !== 'recoveryReport'
    )
      return;
    call.queuedDeadline = performance.now() + this.queuedReadTimeoutMs;
    call.queuedTimer = setTimeout(
      (): void => this.expireQueuedRead(call),
      this.queuedReadTimeoutMs,
    );
    call.queuedTimer.unref();
  }

  private expireQueuedRead(call: PendingCall): void {
    const index = this.queue.indexOf(call);
    if (index === -1) return;
    this.queue.splice(index, 1);
    this.clearQueuedTimer(call);
    call.reject(
      new W5CommitLogHostError(
        'unavailable',
        `The W5 commit log ${call.request.method} exceeded its queued wait; the call was not sent`,
        'queued-wait',
      ),
    );
  }

  private clearQueuedTimer(call: PendingCall): void {
    if (call.queuedTimer) clearTimeout(call.queuedTimer);
    call.queuedTimer = undefined;
  }

  private async stop(): Promise<void> {
    this.rejectQueued(unavailable('The W5 commit log is shutting down'));
    const session = this.session;
    if (session) {
      if (session.active) {
        await waitAtMost(this.whenIdle(session), this.shutdownTimeoutMs);
      }
      this.fail(
        session,
        outcomeUnknown('The W5 commit log shut down before it answered'),
      );
    }
    await this.waitForWorkerExits();
  }

  private pump(): void {
    if (this.checkingRequest) return;
    while (!this.closing && this.queue.length > 0) {
      const session = this.session;
      if (!session) {
        if (!this.launching) void this.launch();
        return;
      }
      if (!session.ready || session.active) return;
      const next = this.queue[0];
      // Worker I/O can run after a deadline but before its timer callback.
      if (
        next?.queuedDeadline !== undefined &&
        performance.now() >= next.queuedDeadline
      ) {
        this.expireQueuedRead(next);
        continue;
      }
      if (next && this.needsAnchor(session, next)) {
        next.reanchored = true;
        this.replaceIdle(session);
        continue;
      }
      if (next && this.requestAdmission) {
        void this.admitRequest(session, next, this.requestAdmission);
        return;
      }
      const call = this.queue.shift();
      if (!call || this.send(session, call)) return;
    }
  }

  private async admitRequest(
    session: WorkerSession,
    call: PendingCall,
    admission: (request: W5CommitLogRequest) => Promise<void>,
  ): Promise<void> {
    this.checkingRequest = true;
    try {
      const admitted = await isAdmitted(() => admission(call.request));
      // Shutdown, failure or a queued deadline may retire this call while checking.
      if (this.closing || this.session !== session || this.queue[0] !== call)
        return;
      if (
        call.queuedDeadline !== undefined &&
        performance.now() >= call.queuedDeadline
      ) {
        this.expireQueuedRead(call);
        return;
      }
      this.queue.shift();
      if (admitted) this.send(session, call);
      else {
        this.clearQueuedTimer(call);
        call.reject(unavailable('The W5 request is not admitted'));
      }
    } finally {
      this.checkingRequest = false;
      this.pump();
    }
  }

  /**
   * A capture bound for a worker that could not resolve the root at startup,
   * while none is pinned. Without a replacement, one transient failure would
   * refuse every capture until the worker failed for another reason. Once per
   * capture, so a root that never resolves cannot restart workers in a loop.
   */
  private needsAnchor(session: WorkerSession, call: PendingCall): boolean {
    return (
      call.request.method === 'capture' &&
      !call.reanchored &&
      !session.anchored &&
      this.anchoredCaptureRoot === undefined
    );
  }

  /**
   * Retires an idle worker without failing the calls queued behind it; they
   * wait for its replacement, which starts once it has exited.
   */
  private replaceIdle(session: WorkerSession): void {
    this.session = undefined;
    this.clearTimer(session);
    void session.worker.terminate().catch((): undefined => undefined);
  }

  private async launch(): Promise<void> {
    let admitted = true;
    this.launching = true;
    try {
      // Never run two workers at once: a stopping worker can still hold the
      // exclusive lock the new one needs.
      if (this.runningWorkers.size > 0) await this.waitForWorkerExits();
      if (this.admission) admitted = await isAdmitted(this.admission);
    } finally {
      this.launching = false;
    }
    if (this.closing || this.session || this.queue.length === 0) return;
    if (!admitted) {
      this.rejectQueued(
        unavailable('The W5 commit log is not admitted in this process'),
      );
      return;
    }
    if (this.runningWorkers.size > 0) {
      // A stopped worker blocked in a native call may still hold the log's
      // lock, and every replacement would then pile up behind it. Refuse
      // until it has exited; the next call starts a worker then.
      this.rejectQueued(
        unavailable('The previous W5 commit log worker has not stopped yet'),
      );
      return;
    }
    this.start();
    this.pump();
  }

  private start(): void {
    let worker: Worker;
    this.started += 1;
    try {
      worker = new Worker(this.workerEntry, {
        workerData: {
          ...this.workerData,
          ...(this.anchoredCaptureRoot !== undefined && {
            captureRoot: this.anchoredCaptureRoot,
          }),
        } satisfies W5CommitLogHostWorkerData,
        name: WORKER_NAME,
      });
    } catch {
      this.rejectQueued(unavailable('The W5 commit log could not start'));
      return;
    }
    worker.unref();
    const session: WorkerSession = {
      worker,
      number: this.started,
      ready: false,
      anchored: false,
      active: undefined,
      timer: undefined,
      idleWaiters: [],
    };
    this.session = session;
    let markExited = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    this.runningWorkers.add(exited);
    worker.on('message', (message: unknown): void =>
      this.receive(session, message),
    );
    worker.on('messageerror', (): void =>
      this.fail(
        session,
        outcomeUnknown('The W5 commit log sent an unreadable message'),
      ),
    );
    // The worker's own error text is dropped: it could quote a file path.
    worker.on('error', (): void =>
      this.fail(session, outcomeUnknown('The W5 commit log stopped')),
    );
    worker.on('exit', (): void => {
      this.runningWorkers.delete(exited);
      markExited();
      this.fail(session, outcomeUnknown('The W5 commit log stopped'));
      for (const listener of this.exitListeners) listener();
    });
    this.arm(session, this.startupTimeoutMs, 'The W5 commit log did not start');
  }

  private send(session: WorkerSession, call: PendingCall): boolean {
    this.clearQueuedTimer(call);
    session.active = call;
    this.arm(
      session,
      this.requestTimeoutMs,
      'The W5 commit log did not answer',
    );
    try {
      session.worker.postMessage(call.request);
      return true;
    } catch {
      // A request that cannot be cloned never reaches the worker, so it
      // changed nothing and the worker stays usable for the calls behind it.
      this.clearTimer(session);
      session.active = undefined;
      call.reject(
        new W5CommitLogHostError(
          'malformed',
          'The W5 commit log request could not be sent',
        ),
      );
      this.notifyIdle(session);
      return false;
    }
  }

  private receive(session: WorkerSession, message: unknown): void {
    if (this.session !== session) return;
    if (!session.ready) {
      this.receiveStartup(session, message);
      return;
    }
    const call = session.active;
    if (
      !call ||
      !isW5CommitLogResponse(message) ||
      message.id !== call.request.id
    ) {
      this.fail(
        session,
        outcomeUnknown('The W5 commit log sent an unexpected message'),
      );
      return;
    }
    if (!message.ok && message.error.kind === 'failed') {
      // The call may have committed without writing its files. Retire this
      // worker, so the next one recovers before it answers anything.
      this.fail(session, toCallError(message.error));
      return;
    }
    session.active = undefined;
    this.clearTimer(session);
    if (message.ok) {
      call.resolve(message.result);
    } else {
      call.reject(toCallError(message.error));
    }
    this.notifyIdle(session);
    this.pump();
  }

  private receiveStartup(session: WorkerSession, message: unknown): void {
    if (!isW5CommitLogStartupMessage(message)) {
      this.fail(
        session,
        outcomeUnknown('The W5 commit log sent an unexpected message'),
      );
      return;
    }
    if (message.type === 'openFailed') {
      // Keep the worker's reason: a log held by another process and one that
      // cannot be opened call for different handling. No call was sent, and
      // the next call tries to open the log again.
      const error = toCallError(message.error);
      this.fail(
        session,
        error,
        error instanceof W5CommitLogHostError
          ? unavailable(error.message)
          : error,
      );
      return;
    }
    session.ready = true;
    this.recovered = session.number;
    session.anchored = message.captureRoot !== undefined;
    // Pinned once, not per worker: a swap that forces a restart must not
    // re-anchor the root. A worker that could not anchor is replaced before
    // its first capture, so the next can (`needsAnchor`).
    this.anchoredCaptureRoot ??= message.captureRoot;
    this.clearTimer(session);
    this.pump();
  }

  /**
   * Retires the session: rejects its in-flight call with `sentError` and every
   * waiting call with `queuedError` (by default `unavailable`, since they were
   * never sent), then terminates the worker, which releases the log's lock.
   * Events from a retired worker are ignored.
   */
  private fail(
    session: WorkerSession,
    sentError: W5CommitLogCallError,
    queuedError: W5CommitLogCallError = unavailable(sentError.message),
  ): void {
    if (this.session !== session) return;
    this.session = undefined;
    this.clearTimer(session);
    const active = session.active;
    session.active = undefined;
    active?.reject(sentError);
    this.rejectQueued(queuedError);
    this.notifyIdle(session);
    void session.worker.terminate().catch((): undefined => undefined);
  }

  private arm(
    session: WorkerSession,
    timeoutMs: number,
    message: string,
  ): void {
    this.clearTimer(session);
    const startedAt = performance.now();
    session.timer = setTimeout((): void => {
      if (this.session !== session) return;
      const method = session.active?.request.method;
      if (method === undefined) {
        this.fail(session, outcomeUnknown(message));
        return;
      }
      const context = {
        method,
        elapsedMs: Math.round(performance.now() - startedAt),
        queueDepth: this.queue.length,
        workerNumber: session.number,
      };
      try {
        this.warn('W5 commit log request timed out', context);
      } catch {
        // A logging failure must not prevent timeout settlement or retirement.
      }
      this.fail(
        session,
        outcomeUnknown(
          `${message}: ${method}, elapsed ${context.elapsedMs} ms, queue depth ${context.queueDepth}, worker ${context.workerNumber}`,
        ),
        unavailable(
          `The W5 commit log worker timed out running ${method}; this call was not sent`,
        ),
      );
    }, timeoutMs);
    session.timer.unref();
  }

  private clearTimer(session: WorkerSession): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
  }

  private rejectQueued(error: W5CommitLogCallError): void {
    for (const call of this.queue.splice(0)) {
      this.clearQueuedTimer(call);
      call.reject(error);
    }
  }

  private whenIdle(session: WorkerSession): Promise<void> {
    if (!session.active) return Promise.resolve();
    return new Promise<void>((resolve) => {
      session.idleWaiters.push(resolve);
    });
  }

  private notifyIdle(session: WorkerSession): void {
    for (const resolve of session.idleWaiters.splice(0)) resolve();
  }

  private waitForWorkerExits(): Promise<void> {
    return waitAtMost(Promise.all(this.runningWorkers), this.workerExitWaitMs);
  }
}
