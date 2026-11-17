import {
  isTerminalOperationStatus,
  type CanopyErrorPayload,
  type CanopyJsonValue,
  type OperationRecord,
  type OperationRestart,
  type OperationRestartClass,
  type OperationRestartDisposition,
  type OperationTerminalStatus,
} from '@canopy/protocol/canopy-core';

import type {
  OperationAcceptRequest,
  OperationAcceptResult,
  OperationLedger,
  OperationLedgerEvent,
  OperationListPage,
  OperationListQuery,
  OperationNonTerminalStatus,
} from './ledger/ledger';
import {
  OperationLedgerError,
  OperationLedgerRefusedError,
} from './ledger/errors';

/**
 * How a domain's interrupted operation stands once the domain has looked
 * for it after a restart: resumed or reattached (`running` or `queued`),
 * finished, or `lost`.
 */
export type OperationRecovery =
  | { status: 'running' | 'queued' }
  | { status: 'completed'; outcome?: CanopyJsonValue }
  | { status: 'failed'; error: CanopyErrorPayload }
  | { status: 'cancelled' }
  | { status: 'lost' };

export interface OperationCancelRequest {
  reason: string;
  /** The principal that asked. */
  requestedBy: string;
}

/**
 * A domain that runs operations of some kinds (pipelines, scripts, hooks).
 * The ledger records the work; the domain keeps its own rules for
 * cancelling, recovering and validating it. Everything a domain records
 * (outcomes, errors, refusal messages) is served to every reader as is, so
 * it must be portable, user-facing data: no host paths, secrets or raw
 * provider errors.
 */
export interface OperationDomain {
  readonly domain: string;
  readonly kinds: readonly string[];
  /** How a restart reconciles this domain's unfinished work. */
  readonly restartClass: OperationRestartClass;
  /**
   * Apply the domain's cancellation rules. `cancelled` when the work has
   * stopped; `requested` when it will stop and the domain then finishes the
   * operation. Throw {@link OperationCancelRefusedError} to refuse. Must be
   * safe to call again for work already being cancelled, since a parent's
   * cancellation also reaches its children.
   */
  cancel(
    operation: OperationRecord,
    request: OperationCancelRequest,
  ): Promise<'cancelled' | 'requested'>;
  /**
   * Required for `resumable` and `reattachable` domains: resume the work
   * from the domain's own state, or find its effect still running. Never
   * starts possibly started effects again.
   */
  recover?(operation: OperationRecord): Promise<OperationRecovery>;
}

/** The domain's cancellation rules refuse this request. */
export class OperationCancelRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationCancelRefusedError';
  }
}

export type OperationCancelOutcome =
  | 'cancelled'
  | 'requested'
  | 'already-terminal';

export interface OperationServiceOptions {
  /** Opens the ledger on first use, so hosts that never use it pay nothing. */
  openLedger: () => OperationLedger | Promise<OperationLedger>;
  /** Failures the service cannot return to a caller: domain recovery, child cancellation. */
  onError?: (error: unknown, context: string) => void;
  clock?: () => number;
}

export type OperationEventListener = (event: OperationLedgerEvent) => void;

const INTERRUPTED_ERROR: CanopyErrorPayload = {
  kind: 'failed_precondition',
  code: 'core.operation.interrupted',
  message:
    'A restart interrupted this operation. Its effects may be incomplete, so it was not run again.',
  retry: { kind: 'never' },
};

const AWAITING: Record<
  Exclude<OperationRestartClass, 'lost'>,
  OperationRestartDisposition
> = {
  resumable: 'awaiting-resume',
  reattachable: 'awaiting-reattach',
};

const RECOVERED: Record<
  Exclude<OperationRestartClass, 'lost'>,
  OperationRestartDisposition
> = {
  resumable: 'resumed',
  reattachable: 'reattached',
};

/**
 * The core-owned operation service over the ledger (CAN-4130). Domains admit
 * work through it before they acknowledge a request and report its
 * lifecycle; clients read, observe and cancel it through `core.operation.*`.
 *
 * Accepted work belongs to the ledger, not to the request that started it:
 * no caller's disconnect, abort signal or delivery deadline reaches the
 * record. Only an explicit cancellation, through the owning domain's rules,
 * stops it.
 */
export class OperationService {
  private readonly domains = new Map<string, OperationDomain>();
  private readonly listeners = new Set<OperationEventListener>();
  private readonly recoveries = new Set<Promise<void>>();
  private readonly cancelDeliveries = new Map<string, Promise<unknown>>();
  private opening: Promise<OperationLedger> | null = null;
  private ledger: OperationLedger | null = null;
  private closed = false;
  private readonly clock: () => number;

  constructor(private readonly options: OperationServiceOptions) {
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Register a domain. Its unfinished work that no domain claimed at open
   * is reconciled now by the domain's restart class.
   */
  registerDomain(domain: OperationDomain): void {
    if (domain.restartClass !== 'lost' && !domain.recover)
      throw new Error(
        `Operation domain ${domain.domain} is ${domain.restartClass} and needs recover().`,
      );
    for (const kind of domain.kinds) {
      const existing = this.domains.get(kind);
      if (existing)
        throw new Error(
          `Operation kind ${kind} is claimed by both ${existing.domain} and ${domain.domain}.`,
        );
    }
    for (const kind of domain.kinds) this.domains.set(kind, domain);
    const ledger = this.ledger;
    if (!ledger) return;
    for (const operation of ledger.listUnfinished(domain.kinds))
      if (
        operation.restart?.disposition === 'unclaimed' &&
        operation.status === 'paused'
      )
        this.reconcileClaimed(
          ledger,
          this.inheritCancellation(ledger, operation),
          domain,
        );
  }

  /** The ledger, opened and reconciled. */
  ready(): Promise<OperationLedger> {
    if (this.closed) return Promise.reject(closedError());
    // A failed open is not cached: the next call tries again, and a ledger
    // that opened but could not be reconciled is closed so its lock frees.
    this.opening ??= (async (): Promise<OperationLedger> => {
      const ledger = await this.options.openLedger();
      try {
        if (this.closed) throw closedError();
        ledger.compact();
        for (const operation of ledger.listInterrupted())
          this.reconcileInterrupted(ledger, operation);
        this.ledger = ledger;
        return ledger;
      } catch (error) {
        ledger.close();
        throw error;
      }
    })().catch((error: unknown) => {
      this.opening = null;
      throw error;
    });
    return this.opening;
  }

  /** Resolves once every domain recovery started so far has settled. */
  async whenReconciled(): Promise<void> {
    await this.ready();
    while (this.recoveries.size > 0)
      await Promise.allSettled(Array.from(this.recoveries));
  }

  subscribe(listener: OperationEventListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Accept work and commit its record, and its idempotency key when keyed,
   * before the caller acknowledges anything. A retry with the same key
   * returns the recorded operation instead of new work: check `status`
   * before starting any effect.
   */
  async admit(request: OperationAcceptRequest): Promise<OperationAcceptResult> {
    const ledger = await this.ready();
    const result = ledger.accept(request);
    if (result.status === 'accepted') this.publish(result.event);
    return result;
  }

  /**
   * Run a write that commits with operation changes, such as a dispatch
   * record and its child operation (CAN-4132), and publish the events it
   * made. The write runs on the ready ledger; a throw publishes nothing.
   */
  async write<T>(
    run: (ledger: OperationLedger) => {
      value: T;
      events: readonly (OperationLedgerEvent | null)[];
    },
  ): Promise<T> {
    const { value, events } = run(await this.ready());
    for (const event of events) this.publish(event);
    return value;
  }

  async get(operationId: string): Promise<OperationRecord | null> {
    return (await this.ready()).get(operationId);
  }

  async list(
    query: OperationListQuery,
  ): Promise<OperationListPage & { eventsHead: number }> {
    const ledger = await this.ready();
    // The head is read first, so events after it cover any later change.
    const eventsHead = ledger.eventsHead();
    return { ...ledger.list(query), eventsHead };
  }

  async transition(
    operationId: string,
    status: OperationNonTerminalStatus,
  ): Promise<OperationRecord> {
    const change = (await this.ready()).transition(operationId, status);
    this.publish(change.event);
    return change.operation;
  }

  async reportProgress(
    operationId: string,
    progress: number,
  ): Promise<OperationRecord> {
    return (await this.ready()).reportProgress(operationId, progress);
  }

  async finish(
    operationId: string,
    terminal: {
      status: OperationTerminalStatus;
      outcome?: CanopyJsonValue;
      error?: CanopyErrorPayload;
    },
  ): Promise<OperationRecord> {
    const change = (await this.ready()).finish(operationId, terminal);
    this.publish(change.event);
    return change.operation;
  }

  /**
   * Cancel unfinished work from any client. The intent is recorded first,
   * then the owning domain applies its rules; a refusal withdraws the
   * intent. Unfinished children are cancelled through their own domains.
   */
  async cancel(
    operationId: string,
    request: OperationCancelRequest & { expectedRevision?: number },
  ): Promise<{ operation: OperationRecord; outcome: OperationCancelOutcome }> {
    const ledger = await this.ready();
    const current = ledger.get(operationId);
    if (!current)
      throw new OperationLedgerRefusedError(
        'not-found',
        'This operation does not exist.',
        { operationId },
      );
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.revision
    )
      throw new OperationLedgerRefusedError(
        'revision-conflict',
        'This operation changed since it was read.',
        { operationId, currentRevision: current.revision },
      );
    if (isTerminalOperationStatus(current.status))
      return { operation: current, outcome: 'already-terminal' };
    const domain = this.domains.get(current.kind);
    if (!domain)
      throw new OperationLedgerRefusedError(
        'invalid-state',
        'Nothing running here can cancel this operation.',
        { operationId, kind: current.kind },
      );
    // Requests for one operation share its recorded intent, so each one
    // records it and hears the domain's answer before the next: a refusal
    // withdraws only the intent its own request recorded.
    const delivered = await this.serializeCancel(operationId, () => {
      const requested = ledger.requestCancel(
        operationId,
        {
          requestedAt: this.now(),
          requestedBy: request.requestedBy,
          reason: request.reason,
        },
        { expectedRevision: request.expectedRevision },
      );
      this.publish(requested.event);
      if (isTerminalOperationStatus(requested.operation.status))
        return Promise.resolve(null);
      // A repeated request is delivered again: an earlier delivery may have
      // failed after its intent was recorded, and domain cancellation is
      // safe to repeat.
      return this.cancelThroughDomain(
        ledger,
        requested.operation,
        domain,
        request,
      );
    });
    if (delivered === null)
      return {
        operation: ledger.get(operationId) ?? current,
        outcome: 'already-terminal',
      };
    const outcome = delivered;
    await this.cancelChildren(ledger, operationId, {
      reason: request.reason,
      requestedBy: request.requestedBy,
    });
    const operation = ledger.get(operationId) ?? current;
    // Work that finished another way while the domain was stopping it was
    // not cancelled, whatever the domain answered.
    return {
      operation,
      outcome:
        isTerminalOperationStatus(operation.status) &&
        operation.status !== 'cancelled'
          ? 'already-terminal'
          : outcome,
    };
  }

  /**
   * Resolves with the operation once it finishes. The signal only stops the
   * wait: an aborted wait leaves the operation as it is.
   */
  async waitForTerminal(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    const ledger = await this.ready();
    return new Promise<OperationRecord>((resolve, reject) => {
      const settle = (): boolean => {
        const operation = ledger.get(operationId);
        if (!operation) {
          stop();
          reject(
            new OperationLedgerRefusedError(
              'not-found',
              'This operation does not exist.',
              { operationId },
            ),
          );
          return true;
        }
        if (!isTerminalOperationStatus(operation.status)) return false;
        stop();
        resolve(operation);
        return true;
      };
      const onAbort = (): void => {
        stop();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('The wait was aborted.'),
        );
      };
      const unsubscribe = this.subscribe((event) => {
        if (event.operation.operationId === operationId) settle();
      });
      const stop = (): void => {
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      settle();
    });
  }

  /** Close the ledger. Running work stays recorded for the next process. */
  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.ledger?.close();
    this.ledger = null;
  }

  private async serializeCancel<T>(
    operationId: string,
    deliver: () => Promise<T>,
  ): Promise<T> {
    const previous = this.cancelDeliveries.get(operationId);
    const delivery = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(deliver);
    const settled = delivery.catch(() => undefined);
    this.cancelDeliveries.set(operationId, settled);
    try {
      return await delivery;
    } finally {
      if (this.cancelDeliveries.get(operationId) === settled)
        this.cancelDeliveries.delete(operationId);
    }
  }

  private async cancelThroughDomain(
    ledger: OperationLedger,
    operation: OperationRecord,
    domain: OperationDomain,
    request: OperationCancelRequest,
  ): Promise<'cancelled' | 'requested'> {
    let disposition: 'cancelled' | 'requested';
    try {
      disposition = await domain.cancel(operation, request);
    } catch (error) {
      if (error instanceof OperationCancelRefusedError) {
        this.publish(ledger.withdrawCancel(operation.operationId).event);
        throw new OperationLedgerRefusedError('invalid-state', error.message, {
          operationId: operation.operationId,
        });
      }
      // The domain failed unexpectedly; the recorded intent stays, so a
      // restart cancels the work instead of resuming it.
      throw error;
    }
    if (disposition === 'cancelled') {
      const current = ledger.get(operation.operationId);
      if (current && !isTerminalOperationStatus(current.status))
        this.publish(
          ledger.finish(operation.operationId, { status: 'cancelled' }).event,
        );
    }
    return disposition;
  }

  private async cancelChildren(
    ledger: OperationLedger,
    operationId: string,
    request: OperationCancelRequest,
  ): Promise<void> {
    const children = ledger.listActiveChildren(operationId);
    const results = await Promise.allSettled(
      children.map((child) => this.cancel(child.operationId, request)),
    );
    for (const result of results)
      if (result.status === 'rejected')
        this.options.onError?.(result.reason, 'cancel-child');
  }

  /** Phase one of restart reconciliation; never leaves work `running`. */
  private reconcileInterrupted(
    ledger: OperationLedger,
    interrupted: OperationRecord,
  ): void {
    const operation = this.inheritCancellation(ledger, interrupted);
    const domain = this.domains.get(operation.kind);
    if (domain) {
      this.reconcileClaimed(ledger, operation, domain);
      return;
    }
    if (
      operation.status === 'paused' &&
      operation.restart?.disposition === 'unclaimed'
    )
      return;
    this.publish(
      ledger.reconcile(operation.operationId, {
        status: 'paused',
        claim: false,
        restart: this.restart(null, 'unclaimed'),
      }).event,
    );
  }

  /**
   * A process can stop between recording a parent's cancellation and
   * cascading it. Interrupted work under a cancelled ancestor takes that
   * intent before it is classified, so it is never resumed: at open, and
   * when a domain registers late for work the cascade could not reach.
   * Interrupted work is listed in accept order, so parents settle first.
   */
  private inheritCancellation(
    ledger: OperationLedger,
    operation: OperationRecord,
  ): OperationRecord {
    if (operation.cancellation) return operation;
    let ancestorId = operation.parentOperationId;
    while (ancestorId !== null) {
      const ancestor = ledger.get(ancestorId);
      if (!ancestor) break;
      if (ancestor.cancellation) {
        const change = ledger.requestCancel(operation.operationId, {
          requestedAt: this.now(),
          requestedBy: ancestor.cancellation.requestedBy,
          reason: ancestor.cancellation.reason,
        });
        this.publish(change.event);
        return change.operation;
      }
      ancestorId = ancestor.parentOperationId;
    }
    return operation;
  }

  private reconcileClaimed(
    ledger: OperationLedger,
    operation: OperationRecord,
    domain: OperationDomain,
  ): void {
    const restartClass = domain.restartClass;
    if (
      restartClass === 'lost' ||
      (operation.cancellation && restartClass === 'resumable')
    ) {
      this.publish(
        ledger.reconcile(
          operation.operationId,
          operation.cancellation
            ? {
                status: 'cancelled',
                restart: this.restart(restartClass, 'cancelled'),
              }
            : {
                status: 'failed',
                restart: this.restart(restartClass, 'lost'),
                error: INTERRUPTED_ERROR,
              },
        ).event,
      );
      return;
    }
    const change = ledger.reconcile(operation.operationId, {
      status: 'paused',
      claim: true,
      restart: this.restart(restartClass, AWAITING[restartClass]),
    });
    this.publish(change.event);
    const recovery = this.recover(
      ledger,
      change.operation,
      domain,
      restartClass,
    )
      .catch((error: unknown) => {
        this.options.onError?.(error, 'recover');
      })
      .finally(() => {
        this.recoveries.delete(recovery);
      });
    this.recoveries.add(recovery);
  }

  /**
   * Phase two: the domain looks for its work. Until it answers, the record
   * stays paused and awaiting; a failed lookup leaves it that way.
   */
  private async recover(
    ledger: OperationLedger,
    operation: OperationRecord,
    domain: OperationDomain,
    restartClass: Exclude<OperationRestartClass, 'lost'>,
  ): Promise<void> {
    if (!domain.recover) return;
    const result = await domain.recover(operation);
    if (!ledger.isOpen) return;
    const current = ledger.get(operation.operationId);
    if (!current || isTerminalOperationStatus(current.status)) return;
    const recovered = this.restart(restartClass, RECOVERED[restartClass]);
    switch (result.status) {
      case 'running':
      case 'queued': {
        const change = ledger.transition(operation.operationId, result.status, {
          restart: recovered,
        });
        this.publish(change.event);
        const { cancellation } = change.operation;
        if (cancellation)
          await this.serializeCancel(operation.operationId, () =>
            this.cancelThroughDomain(ledger, change.operation, domain, {
              reason: cancellation.reason,
              requestedBy: cancellation.requestedBy,
            }),
          );
        return;
      }
      case 'completed':
      case 'cancelled':
        this.publish(
          ledger.finish(operation.operationId, {
            status: result.status,
            ...(result.status === 'completed' && result.outcome !== undefined
              ? { outcome: result.outcome }
              : {}),
            restart: recovered,
          }).event,
        );
        return;
      case 'failed':
        this.publish(
          ledger.finish(operation.operationId, {
            status: 'failed',
            error: result.error,
            restart: recovered,
          }).event,
        );
        return;
      case 'lost':
        this.publish(
          ledger.finish(
            operation.operationId,
            current.cancellation
              ? {
                  status: 'cancelled',
                  restart: this.restart(restartClass, 'cancelled'),
                }
              : {
                  status: 'failed',
                  error: INTERRUPTED_ERROR,
                  restart: this.restart(restartClass, 'lost'),
                },
          ).event,
        );
        return;
    }
  }

  private publish(event: OperationLedgerEvent | null): void {
    if (!event) return;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        this.options.onError?.(error, 'listener');
      }
    }
  }

  private restart(
    restartClass: OperationRestartClass | null,
    disposition: OperationRestartDisposition,
  ): OperationRestart {
    return { class: restartClass, disposition, reconciledAt: this.now() };
  }

  private now(): string {
    return new Date(this.clock()).toISOString();
  }
}

function closedError(): OperationLedgerError {
  return new OperationLedgerError(
    'STORAGE_UNAVAILABLE',
    'The operation service is closed.',
  );
}
