import { createHash } from 'node:crypto';
import type {
  CanopyErrorPayload,
  CanopyJsonValue,
  CanopyOperationCode,
  CanopyWorkspaceScope,
  OperationOrigin,
  OperationOwner,
  OperationRecord,
} from '@canopy/protocol/canopy-core';
import { isBoundedCanopyJsonValue } from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import { OperationLedgerRefusedError } from '../operations/ledger/errors';
import type {
  OperationAcceptResult,
  OperationReceiptInput,
} from '../operations/ledger/ledger';
import {
  OperationCancelRefusedError,
  type OperationService,
} from '../operations/service';

export const CORE_CATALOG_DOMAIN = 'core.catalog';
export const CORE_CATALOG_MUTATION_KINDS = [
  'core.catalog.selection.update',
  'core.catalog.source.upsert',
  'core.catalog.source.delete',
  'core.catalog.source.refresh',
  'core.catalog.plugin.install',
  'core.catalog.entry.publish',
  'core.catalog.skill.install',
  'core.catalog.skill.update',
  'core.catalog.skill.remove',
  'core.catalog.skill.custom.save',
  'core.catalog.skill.updates.check',
] as const;
export type CoreCatalogMutationKind =
  (typeof CORE_CATALOG_MUTATION_KINDS)[number];

type KeyedParams = { _meta: { idempotencyKey: string } } & Record<
  string,
  unknown
>;

export interface CatalogMutationRequest<Result extends CanopyJsonValue> {
  kind: CoreCatalogMutationKind;
  context: CanopyHandlerContext;
  /** Full params; the fingerprint excludes `_meta`. */
  params: KeyedParams;
  scope?: CanopyWorkspaceScope;
  /** Codes this operation may carry; any other recorded code is dropped on replay. */
  codes: readonly string[];
  /** The error for a key reused with other params. */
  keyReused: () => CanopyOperationError;
  /** Parses a recorded outcome; null when it does not parse. */
  decode: (outcome: unknown) => Result | null;
  effect: () => Promise<Result>;
}

type TerminalOutcome =
  | { status: 'completed'; outcome: CanopyJsonValue; error?: undefined }
  | { status: 'failed'; error: CanopyErrorPayload; outcome?: undefined };

const FINISH_RETRY_DELAYS_MS = [250, 1_000, 4_000, 15_000, 60_000] as const;

const FAILED_PAYLOAD: CanopyErrorPayload = {
  kind: 'internal',
  message: 'The catalog change failed.',
  retry: { kind: 'never' },
};

/** The failure a completed outcome records when the ledger cannot hold it (CAN-5898). */
const OUTCOME_TOO_LARGE: CanopyErrorPayload = {
  kind: 'internal',
  message:
    'The catalog change finished, but its result was too large to record.',
  retry: { kind: 'never' },
};

/** A completed outcome, or the failure it records when it cannot be recorded. */
function terminalOf(outcome: CanopyJsonValue): TerminalOutcome {
  return isBoundedCanopyJsonValue(outcome)
    ? { status: 'completed', outcome }
    : { status: 'failed', error: OUTCOME_TOO_LARGE };
}

const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

function receiptFingerprint(params: KeyedParams): string {
  return sha256Hex(
    stableStringify(
      Object.fromEntries(
        Object.entries(params).filter(([key]) => key !== '_meta'),
      ),
    ),
  );
}

function receiptOf(
  context: CanopyHandlerContext,
  params: KeyedParams,
): OperationReceiptInput {
  return {
    caller: `core.catalog:${context.caller.principalId}`,
    idempotencyKey: params._meta.idempotencyKey,
    fingerprint: receiptFingerprint(params),
  };
}

function finishedError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    message: 'This request already finished; refresh and send a new request.',
    retry: { kind: 'never' },
  });
}

/** The payload a failed effect records, and the error its caller sees. */
function failure(error: unknown): {
  payload: CanopyErrorPayload;
  thrown: CanopyOperationError;
} {
  if (error instanceof CanopyOperationError)
    return { payload: error.payload, thrown: error };
  return {
    payload: FAILED_PAYLOAD,
    thrown: new CanopyOperationError(FAILED_PAYLOAD, error),
  };
}

/**
 * Durable keyed outcomes for catalog changes (CAN-4123 D6) in the operation
 * ledger: a retry with the same key joins the running attempt, replays the
 * recorded outcome, or replays a restart's interruption as a failure. The
 * effect never runs twice for one (caller, kind, key).
 */
export class CatalogMutationRuns {
  private readonly operations: OperationService;
  /** Terminal outcomes whose ledger write failed, by operation id. */
  private readonly unrecorded = new Map<string, TerminalOutcome>();

  constructor(options: { operations: OperationService }) {
    this.operations = options.operations;
    this.operations.registerDomain({
      domain: CORE_CATALOG_DOMAIN,
      kinds: [...CORE_CATALOG_MUTATION_KINDS],
      restartClass: 'lost',
      cancel: () =>
        Promise.reject(
          new OperationCancelRefusedError(
            'Catalog changes run to completion; they cannot be stopped.',
          ),
        ),
    });
  }

  /** Runs `effect` at most once per (caller, kind, key) and returns its result. */
  async run<Result extends CanopyJsonValue>(
    request: CatalogMutationRequest<Result>,
  ): Promise<Result> {
    const admitted = await this.admit(request, request.scope);
    const operationId = admitted.operation.operationId;
    if (admitted.status === 'accepted') {
      let result: Result;
      try {
        result = await request.effect();
      } catch (error) {
        const { payload, thrown } = failure(error);
        await this.finishQuietly(operationId, {
          status: 'failed',
          error: payload,
        });
        throw thrown;
      }
      const terminal = terminalOf(result);
      await this.finishQuietly(operationId, terminal);
      if (terminal.status === 'failed')
        throw new CanopyOperationError(terminal.error);
      return result;
    }
    if (admitted.status === 'replay-expired') throw finishedError();
    if (admitted.status === 'replay')
      return replay(admitted.operation, request);
    const unrecorded = await this.settleUnrecorded(operationId);
    return replay(
      unrecorded ?? (await this.operations.waitForTerminal(operationId)),
      request,
    );
  }

  /**
   * Admits and returns at once; `effect` runs detached with the operation id,
   * and its outcome finishes the operation. Every call, first or replay,
   * returns `acknowledge(operationId)`.
   */
  async start<Ack extends CanopyJsonValue>(request: {
    kind: 'core.catalog.source.refresh';
    context: CanopyHandlerContext;
    params: KeyedParams;
    codes: readonly string[];
    keyReused: () => CanopyOperationError;
    /** Recorded on the operation when it is admitted. */
    acknowledgement: CanopyJsonValue;
    /** The ack for an operation and the acknowledgement it recorded (null when unreadable). */
    acknowledge: (operationId: string, recorded: unknown) => Ack;
    effect: (operationId: string) => Promise<CanopyJsonValue>;
  }): Promise<Ack> {
    const admitted = await this.admit(
      request,
      undefined,
      request.acknowledgement,
    );
    const operationId = admitted.operation.operationId;
    if (admitted.status !== 'accepted') {
      await this.settleUnrecorded(operationId);
      return request.acknowledge(
        operationId,
        admitted.operation.origin.context ?? null,
      );
    }
    void request.effect(operationId).then(
      (outcome) => this.finishQuietly(operationId, terminalOf(outcome)),
      (error: unknown) =>
        this.finishQuietly(operationId, {
          status: 'failed',
          error: failure(error).payload,
        }),
    );
    return request.acknowledge(operationId, request.acknowledgement);
  }

  /**
   * The operation a keyed request already recorded, or null when there is
   * none (or the ledger cannot say). Lets a handler replay before it checks
   * state that may have changed since the first attempt.
   */
  async recordedOperationId(request: {
    kind: CoreCatalogMutationKind;
    context: CanopyHandlerContext;
    params: KeyedParams;
  }): Promise<string | null> {
    try {
      const lookup = (await this.operations.ready()).lookupReceipt(
        request.kind,
        receiptOf(request.context, request.params),
      );
      return lookup.status === 'none' || lookup.status === 'key-reused'
        ? null
        : lookup.operation.operationId;
    } catch {
      return null;
    }
  }

  private async admit(
    request: {
      kind: CoreCatalogMutationKind;
      context: CanopyHandlerContext;
      params: KeyedParams;
      keyReused: () => CanopyOperationError;
    },
    scope: CanopyWorkspaceScope | undefined,
    originContext?: CanopyJsonValue,
  ): Promise<OperationAcceptResult> {
    const { caller } = request.context;
    const origin: OperationOrigin = {
      kind: 'client',
      sourceId: caller.clientInstanceId,
      ...(originContext !== undefined ? { context: originContext } : {}),
    };
    const owner: OperationOwner = { kind: 'principal', id: caller.principalId };
    try {
      return await this.operations.admit({
        kind: request.kind,
        status: 'running',
        receipt: receiptOf(request.context, request.params),
        origin,
        owner,
        scope: scope ?? {},
      });
    } catch (error) {
      if (
        error instanceof OperationLedgerRefusedError &&
        error.refusal === 'key-reused'
      )
        throw request.keyReused();
      throw new CanopyOperationError(
        {
          kind: 'unavailable',
          message: 'Catalog changes cannot be recorded right now.',
          retry: { kind: 'same_idempotency_key' },
        },
        error,
      );
    }
  }

  /**
   * Records a terminal outcome. A failed ledger write keeps the outcome in
   * memory and retries it with backoff, so a same-key retry in this process
   * replays it and a waiting joiner settles once a retry lands. Only a
   * process that dies first leaves the record running for restart
   * reconciliation.
   */
  private async finishQuietly(
    operationId: string,
    terminal: TerminalOutcome,
  ): Promise<void> {
    if (await this.tryFinish(operationId, terminal)) return;
    this.unrecorded.set(operationId, terminal);
    this.scheduleRetry(operationId, 0);
  }

  private async tryFinish(
    operationId: string,
    terminal: TerminalOutcome,
  ): Promise<boolean> {
    try {
      await this.operations.finish(operationId, terminal);
      return true;
    } catch {
      return false;
    }
  }

  /** The outcome this process could not record yet, after one more try to record it. */
  private async settleUnrecorded(
    operationId: string,
  ): Promise<TerminalOutcome | null> {
    const terminal = this.unrecorded.get(operationId);
    if (!terminal) return null;
    if (await this.tryFinish(operationId, terminal))
      this.unrecorded.delete(operationId);
    return terminal;
  }

  /** Retries until the write lands, backing off to the last delay. */
  private scheduleRetry(operationId: string, attempt: number): void {
    const delay =
      FINISH_RETRY_DELAYS_MS[
        Math.min(attempt, FINISH_RETRY_DELAYS_MS.length - 1)
      ];
    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        const terminal = this.unrecorded.get(operationId);
        if (!terminal) return;
        if (await this.tryFinish(operationId, terminal))
          this.unrecorded.delete(operationId);
        else this.scheduleRetry(operationId, attempt + 1);
      })();
    }, delay);
    timer.unref?.();
  }
}

function isListedCode(
  code: string,
  codes: readonly string[],
): code is CanopyOperationCode {
  return codes.includes(code);
}

function replay<Result extends CanopyJsonValue>(
  record: {
    status: OperationRecord['status'];
    outcome?: OperationRecord['outcome'];
    error?: OperationRecord['error'];
  },
  request: Pick<CatalogMutationRequest<Result>, 'codes' | 'decode'>,
): Result {
  switch (record.status) {
    case 'completed': {
      const decoded =
        record.outcome === null || record.outcome === undefined
          ? null
          : request.decode(record.outcome);
      if (decoded === null) throw finishedError();
      return decoded;
    }
    case 'failed': {
      if (record.error?.code === 'core.operation.interrupted')
        throw new CanopyOperationError({
          kind: 'failed_precondition',
          message:
            'A restart interrupted this change. It was not run again; refresh and send a new request.',
          retry: { kind: 'never' },
        });
      if (!record.error) throw new CanopyOperationError(FAILED_PAYLOAD);
      const { code, ...rest } = record.error;
      throw new CanopyOperationError(
        code !== undefined && isListedCode(code, request.codes)
          ? { ...rest, code }
          : rest,
      );
    }
    case 'cancelled':
      throw new CanopyOperationError({
        kind: 'cancelled',
        message: 'This change was cancelled.',
        retry: { kind: 'never' },
      });
    default:
      throw finishedError();
  }
}
