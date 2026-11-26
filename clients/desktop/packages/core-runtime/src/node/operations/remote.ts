import { randomUUID } from 'node:crypto';

import {
  OPERATION_LEDGER_ERROR_CODES,
  OPERATION_LEDGER_LIMITS,
  OperationLedgerErrorSchema,
  isTerminalOperationStatus,
  type CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS,
  type CORE_OPERATION_LEDGER_QUERY_DEFINITIONS,
  type CORE_OPERATION_LEDGER_STREAM_DEFINITIONS,
  type CanopyErrorPayload,
  type CanopySchemaInput,
  type CanopySchemaOutput,
  type CanopyStreamCursor,
  type DelegationRecord,
  type OperationRecord,
  type OperationRestartClass,
} from '@canopy/protocol/canopy-core';

import {
  OperationLedgerError,
  OperationLedgerRefusedError,
} from './ledger/errors';
import type {
  OperationLedgerEvent,
  OperationNonTerminalStatus,
} from './ledger/ledger';
import {
  OperationCancelRefusedError,
  type OperationCancelOutcome,
  type OperationCancelRequest,
  type OperationDomain,
  type OperationEventListener,
  type OperationRecovery,
  type OperationService,
  type OperationServicePort,
} from './service';

/*
 * The operation service of an owner whose ledger another process holds
 * (CAN-6986 L3): Electron main, when the daemon holds the ledger. Each call
 * is one `core.operationLedger.*` operation on the owner connection, and
 * the domains' own cancellation and recovery run here, where the domains
 * are. Nothing falls back in process: a call that cannot reach the ledger
 * fails as an unavailable ledger.
 */

type Queries = typeof CORE_OPERATION_LEDGER_QUERY_DEFINITIONS;
type Instructions = typeof CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS;
type Events =
  (typeof CORE_OPERATION_LEDGER_STREAM_DEFINITIONS)['core.operationLedger.events'];
type QueryName = Extract<keyof Queries, string>;
type InstructionName = Extract<keyof Instructions, string>;

export type OperationLedgerEventFrame =
  | {
      kind: 'item';
      cursor: CanopyStreamCursor;
      item: CanopySchemaOutput<Events['item']>;
    }
  | {
      kind: 'end';
      cursor: CanopyStreamCursor;
      outcome: 'completed' | 'cancelled' | 'error';
      error: CanopyErrorPayload | null;
    };

/**
 * The calls the remote service makes, which the owner connection's client
 * carries and a leased peer client does not.
 */
export interface OperationLedgerTransport {
  query<N extends QueryName>(
    name: N,
    params: CanopySchemaOutput<Queries[N]['params']>,
  ): Promise<CanopySchemaOutput<Queries[N]['result']>>;
  instruction<N extends InstructionName>(
    name: N,
    params: CanopySchemaInput<Instructions[N]['params']>,
  ): Promise<CanopySchemaOutput<Instructions[N]['result']>>;
  openStream(
    name: 'core.operationLedger.events',
    params: CanopySchemaInput<Events['params']>,
  ): Promise<{
    onFrame(listener: (frame: OperationLedgerEventFrame) => void): () => void;
    close(): void;
  }>;
}

export interface RemoteOperationServiceOptions {
  /** The owner connection's client; read at each call. */
  readonly transport: () => Promise<OperationLedgerTransport>;
  /**
   * This owner process's run, the same for every owner session it opens,
   * so a reconnect or a restart of the ledger's process resumes the run
   * instead of failing the work still running here. A new one per process;
   * by default, one per service.
   */
  readonly ownerRun?: string;
  /** As `OperationServiceOptions.onError`. */
  readonly onError?: (error: unknown, context: string) => void;
}

const AWAITING_PAGE = 500;
const LIST_PAGE = 500;

/** A remote failure as the in-process ledger would raise it. */
function fromRemote(error: unknown): unknown {
  if (
    error instanceof OperationLedgerRefusedError ||
    error instanceof OperationLedgerError
  )
    return error;
  const payload =
    typeof error === 'object' && error !== null && 'payload' in error
      ? OperationLedgerErrorSchema.safeParse(error.payload)
      : null;
  const details = payload?.success ? payload.data.details : undefined;
  if (
    payload?.success &&
    payload.data.code === OPERATION_LEDGER_ERROR_CODES.refused &&
    details
  )
    return new OperationLedgerRefusedError(
      details.refusal,
      payload.data.message,
      {
        ...(details.operationId !== undefined
          ? { operationId: details.operationId }
          : {}),
        ...(details.currentRevision !== undefined
          ? { currentRevision: details.currentRevision }
          : {}),
      },
    );
  return new OperationLedgerError(
    'STORAGE_UNAVAILABLE',
    'The operation ledger could not be reached.',
    error,
  );
}

function closedError(): OperationLedgerError {
  return new OperationLedgerError(
    'STORAGE_UNAVAILABLE',
    'The operation service is closed.',
  );
}

function claimOf(domain: OperationDomain): {
  domain: string;
  kinds: string[];
  restartClass: OperationRestartClass;
} {
  return {
    domain: domain.domain,
    kinds: [...domain.kinds],
    restartClass: domain.restartClass,
  };
}

interface Registration {
  readonly transport: OperationLedgerTransport;
  readonly done: Promise<SessionRun>;
}

/** The ledger an owner session reached, and the run it claimed there. */
interface SessionRun {
  readonly ledgerId: string;
  readonly runEpoch: string;
}

/** A pending waitForTerminal, settled from an event or a fresh read. */
interface TerminalWait {
  readonly operationId: string;
  settle(operation: OperationRecord | null): void;
  fail(error: Error): void;
}

/**
 * Where the owner's event stream opens next: `fallback` is used once if the
 * ledger refuses `cursor`; `resync` makes pending waits read their
 * operations again once the stream is subscribed.
 */
interface EventsPlan {
  readonly cursor: CanopyStreamCursor | null;
  readonly fallback: CanopyStreamCursor | null;
  readonly failures: number;
  readonly resync: boolean;
  /**
   * Set after a refused cursor: once subscribed, every subscriber reads the
   * owner's unfinished work as it is, for the events it may have missed.
   */
  readonly catchUp: boolean;
}

/** An empty or failed stream may be reopened this many times in a row. */
const EVENT_REOPENS_MAX = 3;

export class RemoteOperationService implements OperationServicePort {
  private readonly domains = new Map<string, OperationDomain>();
  private readonly listeners = new Set<OperationEventListener>();
  private readonly recoveries = new Set<Promise<void>>();
  private readonly cancelDeliveries = new Map<string, Promise<unknown>>();
  private registration: Registration | null = null;
  private events: { close(): void } | null = null;
  /** The last event delivered to subscribers, kept across owner sessions. */
  private lastDelivered: CanopyStreamCursor | null = null;
  /**
   * Set when the events could not be resumed: every call answers it until
   * a new owner session, so no caller goes on with state it can't track.
   */
  private eventsLost: OperationLedgerError | null = null;
  private readonly waits = new Set<TerminalWait>();
  private closed = false;
  private readonly ownerRun: string;
  /**
   * The ledger's run, as `ledgerId:claimId`, and the kinds whose awaiting
   * work this process asked its domains to recover in it.
   */
  private recovered: { run: string; kinds: Set<string> } | null = null;

  constructor(private readonly options: RemoteOperationServiceOptions) {
    this.ownerRun = options.ownerRun ?? randomUUID();
  }

  /**
   * Register a domain here, where its work runs. The owner's domains are
   * claimed at the ledger when the owner session starts; one registered
   * later joins that session's run.
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
    const registration = this.registration;
    if (!registration) return;
    this.track(
      registration.done.then(async () => {
        // A newer session claimed every domain registered by then.
        if (this.registration !== registration) return;
        const { ledgerId, claimId } = await this.request(() =>
          registration.transport.instruction(
            'core.operationLedger.registerDomains',
            { ownerRun: this.ownerRun, domains: [claimOf(domain)] },
          ),
        );
        await this.recoverAwaiting(
          registration.transport,
          domain.kinds,
          `${ledgerId}:${claimId}`,
        );
      }),
      'register',
    );
  }

  /** The owner session's ledger run started and its domains are claimed. */
  async ready(): Promise<void> {
    await this.connected();
  }

  /** The ledger's identity, as its event cursors name it. */
  async ledgerId(): Promise<string> {
    const { ledgerId } = await this.session();
    return ledgerId;
  }

  /**
   * Durable events from `cursor`, or from now when it is null, for one
   * subscriber that resumes at its own cursors. `end` receives the stream's
   * end; the returned function closes it.
   */
  async streamEvents(
    cursor: CanopyStreamCursor | null,
    deliver: (cursor: CanopyStreamCursor, event: OperationLedgerEvent) => void,
    end: (error: CanopyErrorPayload | null) => void,
  ): Promise<() => void> {
    const { transport } = await this.session();
    const stream = await this.request(() =>
      transport.openStream('core.operationLedger.events', { cursor }),
    );
    if (this.closed) {
      stream.close();
      throw closedError();
    }
    const unsubscribe = stream.onFrame((frame) => {
      if (frame.kind === 'item') deliver(frame.cursor, frame.item);
      else end(frame.error);
    });
    return (): void => {
      unsubscribe();
      stream.close();
    };
  }

  async whenReconciled(): Promise<void> {
    await this.connected();
    while (this.recoveries.size > 0)
      await Promise.allSettled(Array.from(this.recoveries));
  }

  subscribe(listener: OperationEventListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  async admit(
    request: Parameters<OperationService['admit']>[0],
  ): ReturnType<OperationService['admit']> {
    return (await this.instruct('core.operationLedger.admit', { request }))
      .result;
  }

  /**
   * As the in-process admission, within the protocol's bounds: a batch
   * larger than one admission is sent in order, in bounded parts, and the
   * source's head is recorded only with the last part, so a failed part
   * leaves the head where it was and a retry answers the parts already
   * recorded as duplicates. A head beyond its bound is refused before
   * anything is sent.
   */
  async admitInitiatedRuns(
    batch: Parameters<OperationService['admitInitiatedRuns']>[0],
  ): ReturnType<OperationService['admitInitiatedRuns']> {
    if (
      batch.head &&
      batch.head.value.length > OPERATION_LEDGER_LIMITS.headValueMax
    )
      throw new OperationLedgerRefusedError(
        'invalid-state',
        "The source's state is longer than the ledger records.",
      );
    const runs = batch.runs.map((run) => ({
      request: run.request,
      ...(run.finishAs ? { finishAs: run.finishAs } : {}),
    }));
    const size = OPERATION_LEDGER_LIMITS.admissionRunsMax;
    const outcomes: Awaited<
      ReturnType<OperationService['admitInitiatedRuns']>
    > = [];
    for (let start = 0; start === 0 || start < runs.length; start += size) {
      const last = start + size >= runs.length;
      const part = await this.instruct(
        'core.operationLedger.admitInitiatedRuns',
        {
          ...(last && batch.head ? { head: batch.head } : {}),
          runs: runs.slice(start, start + size),
        },
      );
      outcomes.push(...part.outcomes);
    }
    return outcomes;
  }

  admitFinished(
    request: Parameters<OperationService['admitFinished']>[0],
    terminal: Parameters<OperationService['admitFinished']>[1],
  ): ReturnType<OperationService['admitFinished']> {
    return this.instruct('core.operationLedger.admitFinished', {
      request,
      terminal,
    });
  }

  async finishCancelled(
    operationId: string,
    intent?: Parameters<OperationService['finishCancelled']>[1],
  ): Promise<void> {
    await this.instruct('core.operationLedger.finishCancelled', {
      operationId,
      ...(intent ? { intent } : {}),
    });
  }

  async placeInProcessWorker(
    target: Parameters<OperationService['placeInProcessWorker']>[0],
    terms: Parameters<OperationService['placeInProcessWorker']>[1],
  ): ReturnType<OperationService['placeInProcessWorker']> {
    return (
      await this.instruct('core.operationLedger.placeInProcessWorker', {
        target,
        terms,
      })
    ).lease;
  }

  acceptDispatch(
    request: Parameters<OperationService['acceptDispatch']>[0],
    dispatch: Parameters<OperationService['acceptDispatch']>[1],
  ): ReturnType<OperationService['acceptDispatch']> {
    return this.instruct('core.operationLedger.acceptDispatch', {
      request,
      dispatch,
    });
  }

  markDispatched(
    delegationId: string,
  ): ReturnType<OperationService['markDispatched']> {
    return this.instruct('core.operationLedger.markDispatched', {
      delegationId,
    });
  }

  async markDelegation(
    delegationId: string,
    state: 'reconciling' | 'unreachable',
  ): Promise<DelegationRecord> {
    return (
      await this.instruct('core.operationLedger.markDelegation', {
        delegationId,
        state,
      })
    ).delegation;
  }

  settleDispatch(
    delegationId: string,
    settlement: Parameters<OperationService['settleDispatch']>[1],
  ): ReturnType<OperationService['settleDispatch']> {
    return this.instruct('core.operationLedger.settleDispatch', {
      delegationId,
      settlement,
    });
  }

  async get(operationId: string): Promise<OperationRecord | null> {
    return (await this.read('core.operationLedger.get', { operationId }))
      .operation;
  }

  async lookupReceipt(
    kind: string,
    receipt: Parameters<OperationService['lookupReceipt']>[1],
  ): ReturnType<OperationService['lookupReceipt']> {
    return (
      await this.read('core.operationLedger.lookupReceipt', { kind, receipt })
    ).lookup;
  }

  async statusBeforeRestart(
    operationId: string,
  ): ReturnType<OperationService['statusBeforeRestart']> {
    return (
      await this.read('core.operationLedger.statusBeforeRestart', {
        operationId,
      })
    ).status;
  }

  async sourceHead(source: string, subject: string): Promise<string | null> {
    return (
      await this.read('core.operationLedger.sourceHead', { source, subject })
    ).value;
  }

  async getDelegation(delegationId: string): Promise<DelegationRecord | null> {
    return (
      await this.read('core.operationLedger.getDelegation', { delegationId })
    ).delegation;
  }

  /** A parent's dispatches, oldest first, read page by page. */
  async listDelegations(
    parentOperationId: string,
  ): Promise<DelegationRecord[]> {
    const delegations: DelegationRecord[] = [];
    let after: string | null = null;
    do {
      const page: CanopySchemaOutput<
        Queries['core.operationLedger.listDelegations']['result']
      > = await this.read('core.operationLedger.listDelegations', {
        parentOperationId,
        limit: OPERATION_LEDGER_LIMITS.delegationsPageMax,
        ...(after === null ? {} : { after }),
      });
      delegations.push(...page.delegations);
      after = page.next;
    } while (after !== null);
    return delegations;
  }

  list(
    query: Parameters<OperationService['list']>[0],
  ): ReturnType<OperationService['list']> {
    return this.read('core.operationLedger.list', {
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.statuses ? { statuses: [...query.statuses] } : {}),
      ...(query.kinds ? { kinds: [...query.kinds] } : {}),
      ...(query.parentOperationId !== undefined
        ? { parentOperationId: query.parentOperationId }
        : {}),
      limit: query.limit,
      ...(query.after ? { after: query.after } : {}),
    });
  }

  async transition(
    operationId: string,
    status: OperationNonTerminalStatus,
  ): Promise<OperationRecord> {
    return (
      await this.instruct('core.operationLedger.transition', {
        operationId,
        status,
      })
    ).operation;
  }

  async reportProgress(
    operationId: string,
    progress: number,
  ): Promise<OperationRecord> {
    return (
      await this.instruct('core.operationLedger.reportProgress', {
        operationId,
        progress,
      })
    ).operation;
  }

  async finish(
    operationId: string,
    terminal: Parameters<OperationService['finish']>[1],
  ): Promise<OperationRecord> {
    return (
      await this.instruct('core.operationLedger.finish', {
        operationId,
        terminal,
      })
    ).operation;
  }

  /**
   * As the in-process `finishOrRecord`: the ledger's process retries the
   * write and records a second failure. A call that cannot reach it goes
   * to `onError` here; a refusal resolves null. Never rejects.
   */
  finishOrRecord(
    operationId: string,
    terminal: Parameters<OperationService['finish']>[1],
  ): Promise<OperationRecord | null> {
    return this.orRecord('finish', async () => {
      const { operation } = await this.instruct(
        'core.operationLedger.finishOrRecord',
        { operationId, terminal },
      );
      return operation;
    });
  }

  /** As {@link finishOrRecord}, for `transitionOrRecord`. */
  transitionOrRecord(
    operationId: string,
    status: OperationNonTerminalStatus,
  ): Promise<OperationRecord | null> {
    return this.orRecord('transition', async () => {
      const { operation } = await this.instruct(
        'core.operationLedger.transitionOrRecord',
        { operationId, status },
      );
      return operation;
    });
  }

  /**
   * Cancel unfinished work, as the in-process service does: the ledger
   * records the intent first, then the owning domain here applies its
   * rules; a refusal withdraws the intent. Unfinished children are
   * cancelled through their own domains.
   */
  async cancel(
    operationId: string,
    request: OperationCancelRequest & { expectedRevision?: number },
  ): Promise<{ operation: OperationRecord; outcome: OperationCancelOutcome }> {
    const current = await this.get(operationId);
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
    const delivered = await this.serializeCancel(operationId, async () => {
      const intent = await this.instruct('core.operationLedger.cancelIntent', {
        operationId,
        reason: request.reason,
        requestedBy: request.requestedBy,
        ...(request.expectedRevision !== undefined
          ? { expectedRevision: request.expectedRevision }
          : {}),
      });
      if (intent.outcome === 'already-terminal') return null;
      return this.cancelThroughDomain(intent.operation, domain, request);
    });
    if (delivered === null)
      return {
        operation: (await this.get(operationId)) ?? current,
        outcome: 'already-terminal',
      };
    await this.cancelChildren(operationId, {
      reason: request.reason,
      requestedBy: request.requestedBy,
    });
    const operation = (await this.get(operationId)) ?? current;
    return {
      operation,
      outcome:
        isTerminalOperationStatus(operation.status) &&
        operation.status !== 'cancelled'
          ? 'already-terminal'
          : delivered,
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
    await this.connected();
    return new Promise<OperationRecord>((resolve, reject) => {
      let settled = false;
      const finish = (operation: OperationRecord): void => {
        if (settled) return;
        settled = true;
        stop();
        resolve(operation);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        stop();
        reject(error);
      };
      const onAbort = (): void => {
        fail(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('The wait was aborted.'),
        );
      };
      const settle = (operation: OperationRecord | null): void => {
        if (!operation)
          fail(
            new OperationLedgerRefusedError(
              'not-found',
              'This operation does not exist.',
              { operationId },
            ),
          );
        else if (isTerminalOperationStatus(operation.status)) finish(operation);
      };
      const wait: TerminalWait = { operationId, settle, fail };
      this.waits.add(wait);
      const unsubscribe = this.subscribe((event) => {
        if (
          event.operation.operationId === operationId &&
          isTerminalOperationStatus(event.operation.status)
        )
          finish(event.operation);
      });
      const stop = (): void => {
        this.waits.delete(wait);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      // Read after subscribing, so a change between the two is not missed.
      this.get(operationId).then(settle, (error: unknown) => {
        fail(
          error instanceof Error
            ? error
            : new Error('The operation could not be read.'),
        );
      });
    });
  }

  /** Stop using the ledger. Its work stays recorded where it is held. */
  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.registration = null;
    this.stopEvents();
  }

  /**
   * The owner connection's client, with this session's domains claimed. A
   * new client is a new owner session: its domains are claimed again and
   * the ledger starts a new run.
   */
  private async connected(): Promise<OperationLedgerTransport> {
    return (await this.session()).transport;
  }

  private async session(): Promise<
    SessionRun & { transport: OperationLedgerTransport }
  > {
    if (this.closed) throw closedError();
    let transport: OperationLedgerTransport;
    try {
      transport = await this.options.transport();
    } catch (error) {
      throw fromRemote(error);
    }
    // A close while the connection was being acquired starts no session.
    if (this.closed) throw closedError();
    let registration = this.registration;
    if (registration?.transport !== transport) {
      this.eventsLost = null;
      const done = this.register(transport);
      registration = { transport, done };
      this.registration = registration;
      const started = registration;
      done.catch(() => {
        if (this.registration === started) this.registration = null;
      });
    }
    const run = await registration.done;
    if (this.closed) throw closedError();
    if (this.eventsLost) throw this.eventsLost;
    return { transport, ...run };
  }

  private async register(
    transport: OperationLedgerTransport,
  ): Promise<SessionRun> {
    if (this.closed) throw closedError();
    const domains = Array.from(new Set(this.domains.values()), claimOf);
    this.stopEvents();
    const { ledgerId, eventsHead, runEpoch, claimId } = await this.request(() =>
      transport.instruction('core.operationLedger.registerDomains', {
        ownerRun: this.ownerRun,
        domains,
      }),
    );
    if (this.closed) throw closedError();
    const run = { ledgerId, runEpoch };
    // A newer session claimed the domains while this one registered.
    if (!this.isCurrent(transport)) return run;
    // The events resume from the last one delivered, when it is this
    // ledger's, and otherwise from the head read before the registration
    // changed anything, so its reconciliation reaches subscribers. Waits
    // read their operations again once the stream listens: a session may
    // reach another ledger, where a waited operation does not exist.
    const head = { daemonEpoch: ledgerId, sequence: eventsHead };
    const last = this.lastDelivered;
    await this.openEvents(transport, {
      cursor: last?.daemonEpoch === ledgerId ? last : head,
      fallback: head,
      failures: 0,
      resync: true,
      catchUp: false,
    });
    if (!this.isCurrent(transport)) return run;
    // Kinds already recovered in the ledger's run are not asked again; one
    // whose recovery an earlier session did not reach is asked now.
    await this.recoverAwaiting(
      transport,
      domains.flatMap(({ kinds }) => kinds),
      `${ledgerId}:${claimId}`,
    );
    return run;
  }

  /**
   * Durable events from the ledger, delivered to subscribers in order and
   * once each. An ended stream reopens from the last delivered event while
   * its session is current. A cursor the ledger no longer holds falls back
   * once to `fallback`, then to the current position, and pending waits
   * read their operations again only after the replacement stream is
   * subscribed, so a change is either in that read or arrives as an event;
   * a wait settles once either way. A stream that ends or fails to open
   * without delivering anything is reopened at most EVENT_REOPENS_MAX
   * times in a row; then the ledger answers unavailable.
   */
  private async openEvents(
    transport: OperationLedgerTransport,
    plan: EventsPlan,
  ): Promise<void> {
    let stream: Awaited<ReturnType<OperationLedgerTransport['openStream']>>;
    try {
      stream = await this.request(() =>
        transport.openStream('core.operationLedger.events', {
          cursor: plan.cursor,
        }),
      );
    } catch (error) {
      this.options.onError?.(error, 'events');
      this.reopenEvents(transport, plan, { delivered: false, stale: false });
      return;
    }
    if (this.closed || this.registration?.transport !== transport) {
      stream.close();
      return;
    }
    this.events = stream;
    let delivered = false;
    const subscribed: EventsPlan = { ...plan, resync: false, catchUp: false };
    stream.onFrame((frame) => {
      // A stopped stream's late frames are not this session's.
      if (this.events !== stream) return;
      if (frame.kind === 'item') {
        delivered = true;
        this.deliver(frame.cursor, frame.item);
        return;
      }
      this.events = null;
      const stale =
        frame.error?.code === OPERATION_LEDGER_ERROR_CODES.snapshotRequired;
      if (frame.error)
        this.options.onError?.(
          new OperationLedgerError('STORAGE_UNAVAILABLE', frame.error.message),
          'events',
        );
      this.reopenEvents(transport, subscribed, { delivered, stale });
    });
    if (plan.resync) this.resyncWaits();
    if (plan.catchUp) this.track(this.catchUp(transport), 'events');
  }

  /**
   * After a refused cursor, events between it and the replacement stream
   * may be missed. Every subscriber reads the owner's unfinished work, in
   * accept order, as a `reconciled` event of its state at the head read
   * before each page. These move no cursor, and a subscriber reading them
   * again changes nothing. Work that finished in the gap is not read again.
   */
  private async catchUp(transport: OperationLedgerTransport): Promise<void> {
    const kinds = Array.from(this.domains.keys());
    if (kinds.length === 0) return;
    let after: number | undefined;
    do {
      const query = {
        kinds,
        limit: LIST_PAGE,
        ...(after === undefined ? {} : { after }),
      };
      const page = await this.request(() =>
        transport.query('core.operationLedger.listUnfinished', query),
      );
      if (!this.isCurrent(transport)) return;
      for (const operation of page.items)
        this.publish({
          sequence: page.eventsHead,
          event: 'reconciled',
          previousStatus: operation.status,
          occurredAt: operation.updatedAt,
          operation,
        });
      after = page.next ?? undefined;
    } while (after !== undefined);
  }

  private reopenEvents(
    transport: OperationLedgerTransport,
    plan: EventsPlan,
    ended: { delivered: boolean; stale: boolean },
  ): void {
    if (this.closed || this.registration?.transport !== transport) return;
    const failures = ended.delivered ? 0 : plan.failures + 1;
    if (failures > EVENT_REOPENS_MAX) {
      this.loseEvents();
      return;
    }
    if (ended.stale) {
      // Events after the refused cursor may be missed: waits read again,
      // and subscribers catch up, once the replacement stream is subscribed.
      this.lastDelivered = null;
      this.track(
        this.openEvents(transport, {
          cursor: plan.fallback,
          fallback: null,
          failures,
          resync: true,
          catchUp: true,
        }),
        'events',
      );
      return;
    }
    this.track(
      this.openEvents(transport, {
        cursor: this.lastDelivered ?? plan.cursor,
        fallback: plan.fallback,
        failures,
        resync: plan.resync,
        catchUp: plan.catchUp,
      }),
      'events',
    );
  }

  /** Publish an event once: a resumed stream may repeat delivered ones. */
  private deliver(
    cursor: CanopyStreamCursor,
    event: OperationLedgerEvent,
  ): void {
    const last = this.lastDelivered;
    if (
      last &&
      last.daemonEpoch === cursor.daemonEpoch &&
      cursor.sequence <= last.sequence
    )
      return;
    this.lastDelivered = cursor;
    this.publish(event);
  }

  /** Read each waited operation again, after events may have been missed. */
  private resyncWaits(): void {
    for (const wait of Array.from(this.waits))
      this.get(wait.operationId).then(
        (operation) => {
          wait.settle(operation);
        },
        () => undefined,
      );
  }

  /** The events can't be resumed: the ledger answers unavailable. */
  private loseEvents(): void {
    const lost = new OperationLedgerError(
      'STORAGE_UNAVAILABLE',
      "The operation ledger's events could not be resumed; operations can't be tracked until the owner connection is made again.",
    );
    this.eventsLost = lost;
    this.options.onError?.(lost, 'events');
    for (const wait of Array.from(this.waits)) wait.fail(lost);
  }

  /** Whether `transport` is still this open service's owner session. */
  private isCurrent(transport: OperationLedgerTransport): boolean {
    return !this.closed && this.registration?.transport === transport;
  }

  /** Detached first, so the end it causes is not taken for a failure. */
  private stopEvents(): void {
    const events = this.events;
    this.events = null;
    events?.close();
  }

  /**
   * Find the work a registration left awaiting this owner's recovery, page
   * by page in accept order, and recover it here in that order, as the
   * in-process service does. Read on the registering connection, which the
   * session's calls wait for.
   */
  private async recoverAwaiting(
    transport: OperationLedgerTransport,
    kinds: readonly string[],
    run: string,
  ): Promise<void> {
    const recoverable = kinds.filter((kind) => {
      const domain = this.domains.get(kind);
      return domain?.recover !== undefined && domain.restartClass !== 'lost';
    });
    if (recoverable.length === 0) return;
    const awaiting: OperationRecord[] = [];
    let after: number | undefined;
    do {
      const query = {
        kinds: recoverable,
        limit: AWAITING_PAGE,
        ...(after === undefined ? {} : { after }),
      };
      const page = await this.request(() =>
        transport.query('core.operationLedger.listUnfinished', query),
      );
      for (const operation of page.items)
        if (
          operation.status === 'paused' &&
          (operation.restart?.disposition === 'awaiting-resume' ||
            operation.restart?.disposition === 'awaiting-reattach')
        )
          awaiting.push(operation);
      after = page.next ?? undefined;
    } while (after !== undefined);
    if (!this.isCurrent(transport)) return;
    if (this.recovered?.run !== run) this.recovered = { run, kinds: new Set() };
    const recovered = this.recovered.kinds;
    const asked = recoverable.filter((kind) => !recovered.has(kind));
    for (const kind of asked) recovered.add(kind);
    this.recoverAll(awaiting.filter(({ kind }) => asked.includes(kind)));
  }

  private recoverAll(awaiting: readonly OperationRecord[]): void {
    for (const operation of awaiting) {
      const domain = this.domains.get(operation.kind);
      const restartClass = operation.restart?.class;
      if (
        !domain?.recover ||
        (restartClass !== 'resumable' && restartClass !== 'reattachable')
      )
        continue;
      const { operationId } = operation;
      const recover = domain.recover.bind(domain);
      this.track(
        (async (): Promise<void> => {
          const recorded = await this.recordRecovery(
            operationId,
            restartClass,
            await recover(operation),
          );
          const cancellation = recorded?.cancellation;
          if (
            recorded &&
            cancellation &&
            !isTerminalOperationStatus(recorded.status)
          )
            await this.serializeCancel(operationId, () =>
              this.cancelThroughDomain(recorded, domain, {
                reason: cancellation.reason,
                requestedBy: cancellation.requestedBy,
              }),
            );
        })(),
        'recover',
      );
    }
  }

  /**
   * Record a domain's answer on the current owner session, fenced to its
   * run: the domain answered for work running in this process, whichever
   * session asked. A session replaced while it sends records it again on
   * the new one. Nothing is recorded once the service closed.
   */
  private async recordRecovery(
    operationId: string,
    restartClass: 'resumable' | 'reattachable',
    recovery: OperationRecovery,
  ): Promise<OperationRecord | null> {
    for (;;) {
      if (this.closed) return null;
      let transport: OperationLedgerTransport;
      let operation: OperationRecord | null;
      try {
        const session = await this.session();
        transport = session.transport;
        ({ operation } = await this.request(() =>
          session.transport.instruction('core.operationLedger.recordRecovery', {
            operationId,
            restartClass,
            recovery,
            runEpoch: session.runEpoch,
          }),
        ));
      } catch (error) {
        // As the in-process service records nothing once its ledger closed.
        if (this.closed) return null;
        throw error;
      }
      if (operation || this.closed || this.isCurrent(transport))
        return operation;
    }
  }

  private async cancelThroughDomain(
    operation: OperationRecord,
    domain: OperationDomain,
    request: OperationCancelRequest,
  ): Promise<'cancelled' | 'requested'> {
    let disposition: 'cancelled' | 'requested';
    try {
      disposition = await domain.cancel(operation, request);
    } catch (error) {
      if (error instanceof OperationCancelRefusedError) {
        await this.instruct('core.operationLedger.withdrawCancelIntent', {
          operationId: operation.operationId,
        });
        throw new OperationLedgerRefusedError('invalid-state', error.message, {
          operationId: operation.operationId,
        });
      }
      // The domain failed unexpectedly; the recorded intent stays, so a
      // restart cancels the work instead of resuming it.
      throw error;
    }
    if (disposition === 'cancelled')
      await this.finishCancelled(operation.operationId);
    return disposition;
  }

  private async cancelChildren(
    operationId: string,
    request: OperationCancelRequest,
  ): Promise<void> {
    // In accept order, as the in-process service cancels them.
    const children: OperationRecord[] = [];
    let after: number | undefined;
    do {
      const query = {
        parentOperationId: operationId,
        limit: LIST_PAGE,
        ...(after === undefined ? {} : { after }),
      };
      const page = await this.read(
        'core.operationLedger.listUnfinished',
        query,
      );
      children.push(...page.items);
      after = page.next ?? undefined;
    } while (after !== undefined);
    const results = await Promise.allSettled(
      children.map((child) => this.cancel(child.operationId, request)),
    );
    for (const result of results)
      if (result.status === 'rejected')
        this.options.onError?.(result.reason, 'cancel-child');
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

  private async orRecord(
    context: 'finish' | 'transition',
    write: () => Promise<OperationRecord | null>,
  ): Promise<OperationRecord | null> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof OperationLedgerRefusedError || this.closed)
        return null;
      try {
        this.options.onError?.(error, context);
      } catch {
        // Callers do not await this; a failing observer changes nothing.
      }
      return null;
    }
  }

  private track(work: Promise<void>, context: string): void {
    const tracked = work
      .catch((error: unknown) => {
        this.options.onError?.(error, context);
      })
      .finally(() => {
        this.recoveries.delete(tracked);
      });
    this.recoveries.add(tracked);
  }

  private publish(event: OperationLedgerEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        this.options.onError?.(error, 'listener');
      }
    }
  }

  private async read<N extends QueryName>(
    name: N,
    params: CanopySchemaOutput<Queries[N]['params']>,
  ): Promise<CanopySchemaOutput<Queries[N]['result']>> {
    const transport = await this.connected();
    return this.request(() => transport.query(name, params));
  }

  private async instruct<N extends InstructionName>(
    name: N,
    params: CanopySchemaInput<Instructions[N]['params']>,
  ): Promise<CanopySchemaOutput<Instructions[N]['result']>> {
    const transport = await this.connected();
    return this.request(() => transport.instruction(name, params));
  }

  private async request<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw fromRemote(error);
    }
  }
}
