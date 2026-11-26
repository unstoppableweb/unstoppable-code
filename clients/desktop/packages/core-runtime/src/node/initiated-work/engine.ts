import { createHash } from 'node:crypto';

import {
  CORE_INITIATED_WORK_RUN_KIND,
  initiatedWorkGateErrorCode,
  isTerminalOperationStatus,
  parseInitiatedWorkRunRecord,
  type CanopyErrorPayload,
  type CanopyWorkspaceScope,
  type InitiatedWorkArtifact,
  type InitiatedWorkGate,
  type InitiatedWorkGateDecision,
  type InitiatedWorkGateOutcome,
  type InitiatedWorkRunRecord,
  type InitiatedWorkRunResult,
  type OperationOrigin,
  type OperationOriginKind,
  type OperationOwner,
  type OperationRecord,
  type OperationTerminalStatus,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';

import { OperationLedgerRefusedError } from '../operations/ledger/errors';
import type { OperationAcceptRequest } from '../operations/ledger/ledger';
import type {
  OperationCancelRequest,
  OperationRecovery,
  OperationServicePort,
} from '../operations/service';

/*
 * The initiated-work engine (CAN-4144). A source (hooks first; automations
 * and watchers later) submits each occurrence it fires. The engine records
 * the occurrence as a `core.initiatedWork.run` operation with its source,
 * occurrence identity and owner; applies the source's admission gates, the
 * occurrence deduplication and the one-run-per-target queue; and records how
 * every gate decided, the artifacts the run produced and how it ended.
 * Execution stays with the source's executor until CAN-4146.
 *
 * Firing is at least once (CAN-4145, ADR 14). A source that detects events
 * from durable state records the state it has seen and the runs it accepted
 * in one ledger transaction (`acceptOccurrence`), then starts them
 * (`runAccepted`). After a restart, accepted runs that never started resume
 * in their accepted order once their source revalidates them; possibly
 * started runs are reconciled by their identity, never started again.
 */

export const INITIATED_WORK_DOMAIN = 'core.initiatedWork';

/**
 * The engine's own bookkeeping disagreed with the ledger's reply, so it
 * refuses to guess. Nothing is started.
 */
export class InitiatedWorkInvariantError extends Error {
  readonly code = 'admission-outcome-count';

  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(
      `The operation ledger answered ${received} admissions for ${expected} runs.`,
    );
    this.name = 'InitiatedWorkInvariantError';
  }
}

/**
 * Why a gate skipped a run, when a source must tell the skip apart from its
 * gate's usual one. Closed: only these codes leave a skip.
 */
export type InitiatedWorkSkipCode =
  /** The worktree's pause state could not be read, so the hook did not run. */
  'core.initiatedWork.gate.pauseUnknown';

/** What an admission gate decided. Refusals carry the host's own error. */
export type InitiatedWorkGateVerdict =
  | { decision: 'passed' }
  | { decision: 'skipped'; message: string; code?: InitiatedWorkSkipCode }
  | {
      decision: 'refused';
      /** Portable and user-facing: every reader of the record sees it. */
      failure: CanopyErrorPayload;
      /** The host error the source raises for this refusal. */
      cause?: unknown;
    };

/**
 * An admission gate. Checks are synchronous and run in order before the run
 * is queued, so runs keep the order their source submitted them in.
 */
export interface InitiatedWorkGateCheck {
  readonly gate: InitiatedWorkGate;
  check(): InitiatedWorkGateVerdict;
}

/** What an executor sees of its run. */
export interface InitiatedWorkRunControl {
  readonly operationId: string;
  /** Aborted when anyone cancels the run. */
  readonly signal: AbortSignal;
  /** Record a gate the run met while executing, such as a command gate. */
  recordGate(
    gate: InitiatedWorkGate,
    decision: InitiatedWorkGateDecision,
    details?: { message?: string; actionIndex?: number },
  ): void;
  /** Record something the run produced. */
  recordArtifact(artifact: InitiatedWorkArtifact): void;
}

export interface InitiatedWorkExecution<T> {
  /** The source's own result, returned to the submitter. */
  value: T;
  result: InitiatedWorkRunResult;
}

export interface InitiatedWorkRequest<T> {
  /** The source, and the occurrence that fired it when it has an identity. */
  origin: OperationOrigin;
  owner: OperationOwner;
  scope: CanopyWorkspaceScope;
  /** Runs for one target run one at a time, in submission order. */
  targetKey: string;
  gates: readonly InitiatedWorkGateCheck[];
  /**
   * Present when the run needs a connected client (the `defer` no-client
   * policy): it waits at the `client` gate, after its turn on the target,
   * until one connects.
   */
  client?: InitiatedWorkClientPresence;
  /**
   * Called once the run is recorded and waiting for its target, or for a
   * duplicate once its recorded run is found. Runs still keep the order
   * their source submitted them in.
   */
  onQueued?(): void;
  execute(control: InitiatedWorkRunControl): Promise<InitiatedWorkExecution<T>>;
}

/** What a run that needs a connected client waits for (the `defer` policy). */
export interface InitiatedWorkClientPresence {
  attached(): boolean;
  /** Resolves once a client connects; the signal stops the wait. */
  whenAttached(signal: AbortSignal): Promise<void>;
}

/**
 * One occurrence a source accepts in one ledger transaction with the state
 * that fired it. A run a gate already stopped is recorded, never started.
 */
export interface InitiatedWorkAdmission {
  origin: OperationOrigin;
  owner: OperationOwner;
  scope: CanopyWorkspaceScope;
  targetKey: string;
  stopped?: {
    gate: InitiatedWorkGate;
    verdict: Exclude<InitiatedWorkGateVerdict, { decision: 'passed' }>;
  };
}

export type InitiatedWorkAcceptance =
  | { status: 'accepted'; operationId: string }
  /** The occurrence was accepted before; this is its recorded run. */
  | { status: 'duplicate'; operation: OperationRecord }
  /**
   * Recorded as skipped or refused at its gate. `code` is the skip's code,
   * when its gate gave one.
   */
  | { status: 'stopped'; operationId: string; code?: InitiatedWorkSkipCode }
  /** The occurrence key was used before with other parameters. */
  | { status: 'keyReused' };

/** How a source answers for one of its runs after a restart. */
export type InitiatedWorkResumption<T> =
  | {
      status: 'resume';
      /** The run's origin, owner, scope and target come from its record. */
      request: Pick<
        InitiatedWorkRequest<T>,
        'gates' | 'client' | 'onQueued' | 'execute'
      >;
    }
  /** The run can no longer go ahead: its target or source changed. */
  | { status: 'invalidated'; message: string };

/**
 * A source's restart recovery. The engine asks it about every run of its
 * origin kind that a restart interrupted.
 */
export interface InitiatedWorkResumer<T = unknown> {
  /** The run's target queue. Synchronous, so recovered runs keep their order. */
  targetKey(operation: OperationRecord): string;
  /**
   * Revalidate a run that never started (its target, the source's
   * configuration and its gates) and rebuild it, or end it.
   */
  resume(
    operation: OperationRecord,
    signal: AbortSignal,
  ): Promise<InitiatedWorkResumption<T>>;
  /**
   * Find what became of a run that may have started, by its operation
   * identity. Answer `lost` when it cannot be found; it is never run again.
   */
  reconcile(operation: OperationRecord): Promise<OperationRecovery>;
}

export type InitiatedWorkSubmission<T> =
  | {
      disposition: 'ran';
      operationId: string;
      value: T;
      /** The run was cancelled while it executed. */
      cancelled: boolean;
    }
  | { disposition: 'cancelled'; operationId: string | null }
  | {
      disposition: 'skipped';
      operationId: string;
      gate: InitiatedWorkGate;
      message: string;
      code?: InitiatedWorkSkipCode;
    }
  | {
      disposition: 'refused';
      operationId: string | null;
      gate: InitiatedWorkGate;
      failure: CanopyErrorPayload;
      cause: unknown;
    }
  /** The occurrence was already submitted; this is its recorded run. */
  | { disposition: 'duplicate'; operation: OperationRecord }
  /**
   * The process is stopping: the run never started and stays queued in the
   * ledger, so the next process resumes it.
   */
  | { disposition: 'held'; operationId: string };

/** A queued or running run, for hosts that stop runs by target. */
export interface LiveInitiatedWorkRun {
  readonly operationId: string | null;
  readonly origin: OperationOrigin;
  readonly scope: CanopyWorkspaceScope;
  readonly targetKey: string;
  readonly started: boolean;
}

type Admission =
  | { status: 'accepted'; operationId: string }
  | { status: 'duplicate'; operation: OperationRecord }
  | { status: 'keyReused' };

interface LiveRun extends LiveInitiatedWorkRun {
  operationId: string | null;
  started: boolean;
  readonly controller: AbortController;
  cancelRequest: OperationCancelRequest | null;
}

/**
 * Whose interrupted runs a source resumes after a restart: every run of an
 * origin kind, or only the runs of one source of a kind, so that other
 * sources sharing it (such as other `system` sources) keep ending as
 * interrupted.
 */
export type InitiatedWorkRecoverableOrigin =
  | OperationOriginKind
  | { readonly kind: OperationOriginKind; readonly sourceId: string };

type RecoveryKey = string;

function recoveryKeyOf(origin: InitiatedWorkRecoverableOrigin): RecoveryKey {
  return typeof origin === 'string'
    ? origin
    : `${origin.kind}\0${origin.sourceId}`;
}

function describeRecoveryKey(key: RecoveryKey): string {
  return key.replace('\0', ' source ');
}

const RUN_FAILED: CanopyErrorPayload = {
  kind: 'internal',
  code: 'core.initiatedWork.run.failed',
  message: 'This run stopped unexpectedly before it could finish.',
  retry: { kind: 'never' },
};

function invalidatedError(message: string): CanopyErrorPayload {
  return {
    kind: 'failed_precondition',
    code: 'core.initiatedWork.run.invalidated',
    message: message.slice(0, 4_096),
    retry: { kind: 'never' },
  };
}

const KEY_REUSED: CanopyErrorPayload = {
  kind: 'conflict',
  code: initiatedWorkGateErrorCode('dedup'),
  message: 'This occurrence was already submitted with other parameters.',
  retry: { kind: 'never' },
};

function fingerprintOf(
  request: Pick<
    InitiatedWorkRequest<unknown>,
    'origin' | 'scope' | 'targetKey'
  >,
): string {
  return createHash('sha256')
    .update(
      stableStringify({
        origin: request.origin,
        scope: request.scope,
        targetKey: request.targetKey,
      }),
    )
    .digest('hex');
}

function errorPayloadFor(
  failure: CanopyErrorPayload,
  gate: InitiatedWorkGate,
  record: InitiatedWorkRunRecord,
): CanopyErrorPayload {
  return {
    ...failure,
    code: initiatedWorkGateErrorCode(gate),
    details: record,
  };
}

export class InitiatedWorkEngine {
  private readonly operations: OperationServicePort;
  private readonly clock: () => number;
  private readonly onError: (error: unknown, context: string) => void;
  private readonly recoverable: ReadonlySet<RecoveryKey>;
  private readonly live = new Set<LiveRun>();
  private readonly targetTails = new Map<string, Promise<void>>();
  private readonly resumers = new Map<RecoveryKey, InitiatedWorkResumer>();
  private readonly pendingRecoveries = new Map<
    RecoveryKey,
    PendingRecovery[]
  >();
  private stopping = false;
  /** Runs accepted with their occurrence and not yet started by their source. */
  private readonly accepted = new Map<string, AcceptedRun>();
  private readonly resumerWaits = new Map<
    RecoveryKey,
    { promise: Promise<void>; resolve: () => void }
  >();

  constructor(options: {
    operations: OperationServicePort;
    /**
     * Origin kinds, or single sources of a kind, whose interrupted runs a
     * source resumes after a restart. Their recovery waits until the source
     * registers its resumer; runs of any other origin end as interrupted.
     */
    recoverableOrigins?: readonly InitiatedWorkRecoverableOrigin[];
    /** Failures to record a run that already ended; its result still returns. */
    onError?: (error: unknown, context: string) => void;
    clock?: () => number;
  }) {
    this.operations = options.operations;
    this.clock = options.clock ?? Date.now;
    this.onError = options.onError ?? ((): void => undefined);
    this.recoverable = new Set(
      (options.recoverableOrigins ?? []).map(recoveryKeyOf),
    );
    this.operations.registerDomain({
      domain: INITIATED_WORK_DOMAIN,
      kinds: [CORE_INITIATED_WORK_RUN_KIND],
      restartClass: 'resumable',
      cancel: (operation, request) => this.cancelLive(operation, request),
      recover: (operation) => this.recover(operation),
    });
  }

  /**
   * Register the restart recovery of one origin kind, or with `sourceId` of
   * one source of that kind. Runs a restart interrupted are recovered in the
   * order they were accepted, once the ledger opens; a host that wants
   * recovery at startup opens it.
   */
  registerResumer(
    kind: OperationOriginKind,
    resumer: InitiatedWorkResumer,
    options: { sourceId?: string } = {},
  ): void {
    const key = recoveryKeyOf(
      options.sourceId === undefined
        ? kind
        : { kind, sourceId: options.sourceId },
    );
    const named = describeRecoveryKey(key);
    if (!this.recoverable.has(key))
      throw new Error(`Initiated work of kind ${named} is not recoverable.`);
    if (this.resumers.has(key))
      throw new Error(`Initiated work of kind ${named} already has a resumer.`);
    this.resumers.set(key, resumer);
    const pending = this.pendingRecoveries.get(key) ?? [];
    this.pendingRecoveries.delete(key);
    for (const recovery of pending) this.resumeRecovered(resumer, recovery);
    this.resumerWaits.get(key)?.resolve();
  }

  /** The recovery an interrupted run of this origin belongs to, if any. */
  private recoveryKeyFor(origin: OperationOrigin): RecoveryKey | null {
    const sourced = recoveryKeyOf({
      kind: origin.kind,
      sourceId: origin.sourceId,
    });
    if (this.recoverable.has(sourced)) return sourced;
    return this.recoverable.has(origin.kind) ? origin.kind : null;
  }

  /**
   * Start no more runs in this process. Queued runs stay queued in the
   * ledger, unstarted, so the next process resumes them; call it before
   * stopping the runs that already started.
   */
  stopStarting(): void {
    this.stopping = true;
  }

  /**
   * Submit an occurrence. Resolves once the run ends, or at once when a gate
   * stops it or it is a duplicate. Every outcome is committed before it
   * resolves.
   */
  submit<T>(
    request: InitiatedWorkRequest<T>,
  ): Promise<InitiatedWorkSubmission<T>> {
    const checked = this.checkGates(request.gates);
    if (checked.stopped)
      return this.recordStopped(
        request,
        checked.gates,
        checked.stopped.gate,
        checked.stopped.verdict,
      );
    const run = this.track(request, null);
    const admission = this.admit(request, run);
    return this.afterRecoveryReserved(() =>
      this.enqueue(run, (queue) =>
        this.runQueued(request, run, checked.gates, { ...queue, admission }),
      ),
    );
  }

  /**
   * Accept a source's occurrences and record the state that fired them, in
   * one ledger transaction: either the source has seen the state and every
   * run is accepted, or nothing is recorded and the source fires again from
   * the same state. A repeat of an accepted occurrence answers its recorded
   * run. Nothing starts until {@link runAccepted}.
   */
  async acceptOccurrence(input: {
    head?: { source: string; subject: string; value: string };
    runs: readonly InitiatedWorkAdmission[];
  }): Promise<InitiatedWorkAcceptance[]> {
    // Each run that may be accepted takes its place on its target now, in
    // call order, so nothing submitted after this call can go ahead of it;
    // a run the ledger does not accept gives its place back.
    const slots = input.runs.map((admission) =>
      admission.stopped ? null : this.reserveSlot(admission),
    );
    const release = (slot: AcceptedRun | null): void => {
      slot?.start(() => Promise.resolve());
    };
    let acceptances: InitiatedWorkAcceptance[];
    try {
      const outcomes = await this.operations.admitInitiatedRuns({
        ...(input.head && { head: input.head }),
        runs: input.runs.map((admission) => {
          const stopped = admission.stopped;
          return {
            request: this.acceptRequest(admission, {
              keyed: !stopped || stopped.verdict.decision === 'skipped',
            }),
            ...(stopped && {
              finishAs: this.stoppedTerminal([], stopped.gate, stopped.verdict),
            }),
          };
        }),
      });
      // Outcomes are matched to runs by position, so a count that differs
      // can't be attributed and fails closed.
      if (outcomes.length !== input.runs.length)
        throw new InitiatedWorkInvariantError(
          input.runs.length,
          outcomes.length,
        );
      acceptances = outcomes.map((outcome, index): InitiatedWorkAcceptance => {
        switch (outcome.status) {
          case 'accepted':
            return {
              status: 'accepted',
              operationId: outcome.operation.operationId,
            };
          case 'stopped': {
            const verdict = input.runs[index]?.stopped?.verdict;
            return {
              status: 'stopped',
              operationId: outcome.operation.operationId,
              ...(verdict?.decision === 'skipped' && verdict.code !== undefined
                ? { code: verdict.code }
                : {}),
            };
          }
          case 'duplicate':
            return { status: 'duplicate', operation: outcome.operation };
          case 'keyReused':
            return { status: 'keyReused' };
        }
      });
    } catch (error) {
      for (const slot of slots) release(slot);
      throw error;
    }
    acceptances.forEach((acceptance, index) => {
      const slot = slots[index];
      if (acceptance.status !== 'accepted') {
        release(slot);
        return;
      }
      if (!slot) return;
      slot.run.operationId = acceptance.operationId;
      this.accepted.set(acceptance.operationId, slot);
    });
    return acceptances;
  }

  /**
   * Start a run {@link acceptOccurrence} accepted: check its gates, wait for
   * its target, run it and record how it ended. A gate that stops it ends
   * its recorded run.
   */
  runAccepted<T>(
    operationId: string,
    request: InitiatedWorkRequest<T>,
  ): Promise<InitiatedWorkSubmission<T>> {
    const reserved = this.takeAccepted(operationId);
    const run = reserved?.run ?? this.track(request, operationId);
    // A run that will not go ahead gives its reserved place back.
    const release = (): void => {
      if (reserved) reserved.start(() => Promise.resolve());
      else this.live.delete(run);
    };
    if (run.controller.signal.aborted) {
      release();
      return this.finishCancelled(run, operationId).then(() => ({
        disposition: 'cancelled',
        operationId,
      }));
    }
    const gates: InitiatedWorkGateOutcome[] = [];
    if (request.origin.occurrenceKey !== undefined)
      gates.push(this.outcome('dedup', 'passed'));
    const checked = this.checkGates(request.gates, gates);
    if (checked.stopped) {
      release();
      return this.finishStopped(
        operationId,
        checked.gates,
        checked.stopped.gate,
        checked.stopped.verdict,
      );
    }
    const runIn = (queue: QueueSlot): Promise<InitiatedWorkSubmission<T>> =>
      this.runQueued(request, run, checked.gates, {
        ...queue,
        admission: Promise.resolve({ status: 'accepted', operationId }),
        recorded: true,
      });
    if (!reserved)
      return this.afterRecoveryReserved(() => this.enqueue(run, runIn));
    return new Promise<InitiatedWorkSubmission<T>>((resolve, reject) => {
      reserved.start(async (queue) => {
        try {
          resolve(await runIn(queue));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  /** A place on the admission's target, held until its work is handed in. */
  private reserveSlot(admission: InitiatedWorkAdmission): AcceptedRun {
    const run = this.track(admission, null);
    let start: AcceptedRun['start'] = (): void => undefined;
    const body = new Promise<(queue: QueueSlot) => Promise<void>>((resolve) => {
      start = resolve;
    });
    void this.afterRecoveryReserved(() =>
      this.enqueue(run, (queue) => body.then((work) => work(queue))),
    );
    return { run, start };
  }

  private takeAccepted(operationId: string): AcceptedRun | undefined {
    const accepted = this.accepted.get(operationId);
    this.accepted.delete(operationId);
    return accepted;
  }

  /**
   * New work on a recoverable engine queues only once the runs a restart
   * interrupted hold their places, so recovered runs go first on their
   * targets. Submissions keep their order: they wait on the same steps.
   */
  private afterRecoveryReserved<R>(enqueue: () => Promise<R>): Promise<R> {
    if (this.recoverable.size === 0) return enqueue();
    return this.recoveryReserved().then(enqueue);
  }

  private recoveryReserved(): Promise<void> {
    if (this.recoverable.size === 0) return Promise.resolve();
    return this.operations
      .ready()
      .then(() =>
        Promise.all(
          Array.from(this.pendingRecoveries.keys(), (key) =>
            this.resumerRegistered(key),
          ),
        ),
      )
      .then(
        (): void => undefined,
        (): void => undefined,
      );
  }

  private resumerRegistered(key: RecoveryKey): Promise<void> {
    let waiting = this.resumerWaits.get(key);
    if (!waiting) {
      let resolve = (): void => undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      waiting = { promise, resolve };
      this.resumerWaits.set(key, waiting);
    }
    return waiting.promise;
  }

  /**
   * Resolves once a run's operation ends, with what it recorded: how a
   * duplicate's first firing ended, for instance.
   */
  async waitForRun(operationId: string): Promise<{
    status: OperationTerminalStatus;
    record: InitiatedWorkRunRecord | null;
    result: InitiatedWorkRunResult | null;
  }> {
    const operation = await this.operations.waitForTerminal(operationId);
    const record = parseInitiatedWorkRunRecord(
      operation.outcome ?? operation.error?.details,
    );
    return {
      status:
        operation.status === 'completed' || operation.status === 'failed'
          ? operation.status
          : 'cancelled',
      record,
      result: record?.result ?? null,
    };
  }

  /**
   * Opens the ledger and resolves once every interrupted run found so far
   * was recovered: resumed, reconciled or ended.
   */
  whenRecovered(): Promise<void> {
    return this.operations.whenReconciled();
  }

  /** The state a source last recorded for a subject. */
  async sourceHead(source: string, subject: string): Promise<string | null> {
    return this.operations.sourceHead(source, subject);
  }

  /** Queued and running runs, oldest first. */
  liveRuns(): LiveInitiatedWorkRun[] {
    return Array.from(this.live, (run) => ({
      operationId: run.operationId,
      origin: run.origin,
      scope: run.scope,
      targetKey: run.targetKey,
      started: run.started,
    }));
  }

  /**
   * Cancel the live runs a host selects, such as every run of a worktree it
   * is removing. Each run stops at once; the cancellation is recorded on its
   * operation, where any client sees it.
   */
  async cancelWhere(
    select: (run: LiveInitiatedWorkRun) => boolean,
    request: OperationCancelRequest,
  ): Promise<void> {
    const selected = Array.from(this.live).filter((run) => select(run));
    for (const run of selected) {
      run.cancelRequest ??= request;
      run.controller.abort();
    }
    await Promise.allSettled(
      selected.flatMap((run) =>
        run.operationId === null
          ? []
          : [this.operations.cancel(run.operationId, request)],
      ),
    );
  }

  private checkGates(
    checks: readonly InitiatedWorkGateCheck[],
    gates: InitiatedWorkGateOutcome[] = [],
  ): {
    gates: InitiatedWorkGateOutcome[];
    stopped?: {
      gate: InitiatedWorkGate;
      verdict: Exclude<InitiatedWorkGateVerdict, { decision: 'passed' }>;
    };
  } {
    for (const gate of checks) {
      const verdict = gate.check();
      if (verdict.decision !== 'passed')
        return { gates, stopped: { gate: gate.gate, verdict } };
      gates.push(this.outcome(gate.gate, 'passed'));
    }
    return { gates };
  }

  private track(
    request: Pick<
      InitiatedWorkRequest<unknown>,
      'origin' | 'scope' | 'targetKey'
    >,
    operationId: string | null,
  ): LiveRun {
    const run: LiveRun = {
      operationId,
      origin: request.origin,
      scope: request.scope,
      targetKey: request.targetKey,
      started: false,
      controller: new AbortController(),
      cancelRequest: null,
    };
    this.live.add(run);
    return run;
  }

  /**
   * Queue a run behind the work already waiting for its target. The next run
   * on this target waits for this one and for whatever this one waited for,
   * even when a cancellation or a failed admission ended this one early.
   */
  private enqueue<R>(
    run: LiveRun,
    body: (queue: {
      prior: Promise<void>;
      waited: boolean;
      aborted: Promise<void>;
    }) => Promise<R>,
  ): Promise<R> {
    const prior = this.targetTails.get(run.targetKey);
    const aborted = new Promise<void>((resolve) => {
      // A run cancelled before it reached its queue settles at once.
      if (run.controller.signal.aborted) {
        resolve();
        return;
      }
      run.controller.signal.addEventListener('abort', () => resolve(), {
        once: true,
      });
    });
    const job = body({
      prior: prior ?? Promise.resolve(),
      waited: prior !== undefined,
      aborted,
    }).finally(() => {
      this.live.delete(run);
    });
    const tail = Promise.allSettled([prior, job]).then((): void => undefined);
    this.targetTails.set(run.targetKey, tail);
    void tail.then((): void => {
      if (this.targetTails.get(run.targetKey) === tail)
        this.targetTails.delete(run.targetKey);
    });
    return job;
  }

  private outcome(
    gate: InitiatedWorkGate,
    decision: InitiatedWorkGateDecision,
    details: { message?: string; actionIndex?: number } = {},
  ): InitiatedWorkGateOutcome {
    return {
      gate,
      decision,
      decidedAt: new Date(this.clock()).toISOString(),
      ...(details.message !== undefined && details.message.length > 0
        ? { message: details.message.slice(0, 4_096) }
        : {}),
      ...(details.actionIndex !== undefined
        ? { actionIndex: details.actionIndex }
        : {}),
    };
  }

  private acceptRequest(
    request: Pick<
      InitiatedWorkRequest<unknown>,
      'origin' | 'owner' | 'scope' | 'targetKey'
    >,
    options: { keyed: boolean },
  ): OperationAcceptRequest {
    const occurrence = request.origin.occurrenceKey;
    return {
      kind: CORE_INITIATED_WORK_RUN_KIND,
      status: 'queued',
      origin: request.origin,
      owner: request.owner,
      scope: request.scope,
      ...(options.keyed && occurrence !== undefined
        ? {
            receipt: {
              // An occurrence belongs to one source in one scope.
              caller: stableStringify({
                source: `${request.origin.kind}:${request.origin.sourceId}`,
                scope: request.scope,
              }),
              idempotencyKey: occurrence,
              fingerprint: fingerprintOf(request),
            },
          }
        : {}),
    };
  }

  /** The terminal record of a run a gate stopped. */
  private stoppedTerminal(
    passed: readonly InitiatedWorkGateOutcome[],
    gate: InitiatedWorkGate,
    verdict: Exclude<InitiatedWorkGateVerdict, { decision: 'passed' }>,
  ):
    | { status: 'completed'; outcome: InitiatedWorkRunRecord }
    | { status: 'failed'; error: CanopyErrorPayload } {
    const message =
      verdict.decision === 'skipped'
        ? verdict.message
        : verdict.failure.message;
    const record: InitiatedWorkRunRecord = {
      disposition: verdict.decision,
      gates: [...passed, this.outcome(gate, verdict.decision, { message })],
      artifacts: [],
      result: null,
    };
    return verdict.decision === 'skipped'
      ? { status: 'completed', outcome: record }
      : {
          status: 'failed',
          error: errorPayloadFor(verdict.failure, gate, record),
        };
  }

  private stoppedSubmission<T>(
    operationId: string,
    gate: InitiatedWorkGate,
    verdict: Exclude<InitiatedWorkGateVerdict, { decision: 'passed' }>,
  ): InitiatedWorkSubmission<T> {
    return verdict.decision === 'skipped'
      ? {
          disposition: 'skipped',
          operationId,
          gate,
          message: verdict.message,
          ...(verdict.code !== undefined ? { code: verdict.code } : {}),
        }
      : {
          disposition: 'refused',
          operationId,
          gate,
          failure: verdict.failure,
          cause: verdict.cause ?? verdict.failure,
        };
  }

  /**
   * Record a run an admission gate stopped. A skip consumes its occurrence,
   * so a repeat replays it; a refusal does not, so a later repeat can run.
   */
  private async recordStopped<T>(
    request: InitiatedWorkRequest<T>,
    passed: InitiatedWorkGateOutcome[],
    gate: InitiatedWorkGate,
    verdict: Exclude<InitiatedWorkGateVerdict, { decision: 'passed' }>,
  ): Promise<InitiatedWorkSubmission<T>> {
    const recorded = await this.operations.admitFinished(
      this.acceptRequest(request, { keyed: verdict.decision === 'skipped' }),
      this.stoppedTerminal(passed, gate, verdict),
    );
    if (recorded.status !== 'accepted')
      return { disposition: 'duplicate', operation: recorded.operation };
    return this.stoppedSubmission(
      recorded.operation.operationId,
      gate,
      verdict,
    );
  }

  /** End an accepted run a gate stopped before it started. */
  private async finishStopped<T>(
    operationId: string,
    passed: InitiatedWorkGateOutcome[],
    gate: InitiatedWorkGate,
    verdict: Exclude<InitiatedWorkGateVerdict, { decision: 'passed' }>,
  ): Promise<InitiatedWorkSubmission<T>> {
    await this.operations.finish(
      operationId,
      this.stoppedTerminal(passed, gate, verdict),
    );
    return this.stoppedSubmission(operationId, gate, verdict);
  }

  private async admit(
    request: InitiatedWorkRequest<unknown>,
    run: LiveRun,
  ): Promise<Admission> {
    try {
      const admitted = await this.operations.admit(
        this.acceptRequest(request, { keyed: true }),
      );
      if (admitted.status !== 'accepted')
        return { status: 'duplicate', operation: admitted.operation };
      run.operationId = admitted.operation.operationId;
      return { status: 'accepted', operationId: run.operationId };
    } catch (error) {
      if (
        error instanceof OperationLedgerRefusedError &&
        error.refusal === 'key-reused'
      )
        return { status: 'keyReused' };
      throw error;
    }
  }

  private async runQueued<T>(
    request: InitiatedWorkRequest<T>,
    run: LiveRun,
    gates: InitiatedWorkGateOutcome[],
    queue: {
      admission: Promise<Admission>;
      prior: Promise<void>;
      waited: boolean;
      aborted: Promise<void>;
      /** The run was accepted earlier; its dedup gate is already recorded. */
      recorded?: boolean;
      /** A recovered run waits until the restart's reconciliation releases it. */
      released?: Promise<void>;
    },
  ): Promise<InitiatedWorkSubmission<T>> {
    const admitted = await queue.admission;
    // Only work the ledger holds is reported queued: a new run, or the
    // recorded run a duplicate names.
    if (admitted.status !== 'keyReused') request.onQueued?.();
    if (admitted.status === 'duplicate')
      return { disposition: 'duplicate', operation: admitted.operation };
    if (admitted.status === 'keyReused')
      return {
        disposition: 'refused',
        operationId: null,
        gate: 'dedup',
        failure: KEY_REUSED,
        cause: KEY_REUSED,
      };
    const { operationId } = admitted;
    if (request.origin.occurrenceKey !== undefined && !queue.recorded)
      gates.push(this.outcome('dedup', 'passed'));

    await Promise.race([queue.prior, queue.aborted]);
    if (!run.controller.signal.aborted && queue.released)
      await Promise.race([queue.released, queue.aborted]);
    if (run.controller.signal.aborted) {
      await this.finishCancelled(run, operationId);
      return { disposition: 'cancelled', operationId };
    }
    if (this.stopping) return { disposition: 'held', operationId };
    gates.push(this.outcome('busyTarget', queue.waited ? 'waited' : 'passed'));
    if (request.client && !request.client.attached()) {
      await Promise.race([
        request.client.whenAttached(run.controller.signal),
        queue.aborted,
      ]);
      if (run.controller.signal.aborted) {
        gates.push(this.outcome('client', 'cancelled'));
        await this.finishCancelled(run, operationId);
        return { disposition: 'cancelled', operationId };
      }
      gates.push(this.outcome('client', 'waited'));
    }
    if (this.stopping) return { disposition: 'held', operationId };
    run.started = true;
    await this.operations.transition(operationId, 'running');

    const artifacts: InitiatedWorkArtifact[] = [];
    const control: InitiatedWorkRunControl = {
      operationId,
      signal: run.controller.signal,
      recordGate: (gate, decision, details) => {
        gates.push(this.outcome(gate, decision, details));
      },
      recordArtifact: (artifact) => {
        artifacts.push(artifact);
      },
    };
    let execution: InitiatedWorkExecution<T>;
    try {
      execution = await request.execute(control);
    } catch (error) {
      // An executor may reject because it was cancelled; that is still a
      // cancellation, not a failure.
      if (run.controller.signal.aborted) {
        await this.finishCancelled(run, operationId);
        return { disposition: 'cancelled', operationId };
      }
      await this.operations
        .finish(operationId, {
          status: 'failed',
          error: {
            ...RUN_FAILED,
            details: { disposition: 'ran', gates, artifacts, result: null },
          },
        })
        .catch((recordError: unknown) => {
          this.onError(recordError, 'record-failed-run');
        });
      throw error;
    }
    if (run.controller.signal.aborted) {
      await this.finishCancelled(run, operationId);
      return {
        disposition: 'ran',
        operationId,
        value: execution.value,
        cancelled: true,
      };
    }
    const record: InitiatedWorkRunRecord = {
      disposition: execution.result.status === 'stopped' ? 'skipped' : 'ran',
      gates,
      artifacts,
      result: execution.result,
    };
    await this.operations
      .finish(operationId, { status: 'completed', outcome: record })
      .catch((error: unknown) => {
        this.onError(error, 'record-run');
      });
    return {
      disposition: 'ran',
      operationId,
      value: execution.value,
      cancelled: false,
    };
  }

  /**
   * Records a cancellation, with the intent of a host stop that asked for
   * it, unless the run already ended (a client's cancellation finishes a run
   * that never started itself).
   */
  private async finishCancelled(
    run: LiveRun,
    operationId: string,
  ): Promise<void> {
    const intent = run.cancelRequest;
    await this.operations
      .finishCancelled(
        operationId,
        intent
          ? {
              requestedAt: new Date(this.clock()).toISOString(),
              requestedBy: intent.requestedBy,
              reason: intent.reason,
            }
          : undefined,
      )
      .catch((error: unknown) => {
        this.onError(error, 'record-cancelled-run');
      });
  }

  /** The operation service's cancellation, from any client. */
  private cancelLive(
    operation: OperationRecord,
    request: OperationCancelRequest,
  ): Promise<'cancelled' | 'requested'> {
    const run = Array.from(this.live).find(
      (candidate) => candidate.operationId === operation.operationId,
    );
    if (!run) {
      // A recovered run still waiting for its source to register ends here.
      const key = this.recoveryKeyFor(operation.origin);
      const pending =
        key === null ? undefined : this.pendingRecoveries.get(key);
      const index =
        pending?.findIndex(
          (recovery) =>
            recovery.operation.operationId === operation.operationId,
        ) ?? -1;
      if (pending && index >= 0) {
        const [recovery] = pending.splice(index, 1);
        if (pending.length === 0 && key !== null)
          this.pendingRecoveries.delete(key);
        recovery.resolve({ status: 'cancelled' });
      }
      return Promise.resolve('cancelled');
    }
    run.cancelRequest ??= request;
    run.controller.abort();
    return Promise.resolve(run.started ? 'requested' : 'cancelled');
  }

  /** The operation service's restart recovery for one interrupted run. */
  private recover(operation: OperationRecord): Promise<OperationRecovery> {
    const key = this.recoveryKeyFor(operation.origin);
    if (key === null) return Promise.resolve({ status: 'lost' });
    return new Promise<OperationRecovery>((resolve) => {
      const recovery: PendingRecovery = { operation, resolve };
      const resumer = this.resumers.get(key);
      if (resumer) {
        this.resumeRecovered(resumer, recovery);
        return;
      }
      const pending = this.pendingRecoveries.get(key) ?? [];
      pending.push(recovery);
      this.pendingRecoveries.set(key, pending);
    });
  }

  /**
   * Take the run's place on its target now, so recovered runs keep their
   * accepted order ahead of new work, then ask its source about it.
   */
  private resumeRecovered(
    resumer: InitiatedWorkResumer,
    { operation, resolve }: PendingRecovery,
  ): void {
    const { operationId } = operation;
    let targetKey: string;
    try {
      targetKey = resumer.targetKey(operation);
    } catch (error) {
      this.onError(error, 'recover-target');
      resolve({ status: 'lost' });
      return;
    }
    const run = this.track(
      { origin: operation.origin, scope: operation.scope, targetKey },
      operationId,
    );
    let release = (): void => undefined;
    const released = new Promise<void>((resolveReleased) => {
      release = resolveReleased;
    });
    const resumption = (async (): Promise<
      | InitiatedWorkResumption<unknown>
      | { status: 'started' }
      | { status: 'ended' }
    > => {
      const current = await this.operations.get(operationId);
      const before = await this.operations.statusBeforeRestart(operationId);
      if (!current || isTerminalOperationStatus(current.status))
        return { status: 'ended' };
      // Only a run the ledger shows still queued is known not to have
      // started; anything else may have, so its source reconciles it.
      if (before !== 'queued') return { status: 'started' };
      return resumer.resume(operation, run.controller.signal);
    })();
    void this.enqueue(run, async (queue) => {
      let resumed: Awaited<typeof resumption>;
      try {
        resumed = await resumption;
      } catch (error) {
        this.onError(error, 'recover');
        resolve({ status: 'lost' });
        return;
      }
      if (resumed.status === 'ended') {
        // It ended while it waited, by a cancellation from any client.
        resolve({ status: 'cancelled' });
        return;
      }
      if (resumed.status === 'started') {
        resolve(
          await resumer.reconcile(operation).catch((error: unknown) => {
            this.onError(error, 'reconcile');
            return { status: 'lost' as const };
          }),
        );
        return;
      }
      if (resumed.status === 'invalidated') {
        const record: InitiatedWorkRunRecord = {
          disposition: 'refused',
          gates: [],
          artifacts: [],
          result: null,
        };
        resolve({
          status: 'failed',
          error: { ...invalidatedError(resumed.message), details: record },
        });
        return;
      }
      const request: InitiatedWorkRequest<unknown> = {
        ...resumed.request,
        origin: operation.origin,
        owner: operation.owner,
        scope: operation.scope,
        targetKey,
      };
      const gates: InitiatedWorkGateOutcome[] = [];
      if (operation.origin.occurrenceKey !== undefined)
        gates.push(this.outcome('dedup', 'passed'));
      const checked = this.checkGates(request.gates, gates);
      if (checked.stopped) {
        const terminal = this.stoppedTerminal(
          checked.gates,
          checked.stopped.gate,
          checked.stopped.verdict,
        );
        resolve(terminal);
        return;
      }
      // The service records the run queued again, then releases it.
      const unsubscribe = this.operations.subscribe((event) => {
        if (
          event.operation.operationId === operationId &&
          event.operation.status !== 'paused'
        )
          release();
      });
      resolve({ status: 'queued' });
      try {
        await this.runQueued(request, run, checked.gates, {
          ...queue,
          admission: Promise.resolve({ status: 'accepted', operationId }),
          recorded: true,
          released,
        });
      } catch (error) {
        this.onError(error, 'recovered-run');
      } finally {
        unsubscribe();
      }
    });
  }
}

interface QueueSlot {
  prior: Promise<void>;
  waited: boolean;
  aborted: Promise<void>;
}

/** An accepted run's reserved place on its target, waiting for its work. */
interface AcceptedRun {
  run: LiveRun;
  start: (work: (queue: QueueSlot) => Promise<void>) => void;
}

interface PendingRecovery {
  operation: OperationRecord;
  resolve: (recovery: OperationRecovery) => void;
}
