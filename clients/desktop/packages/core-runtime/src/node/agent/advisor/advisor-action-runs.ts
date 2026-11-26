import { createHash } from 'node:crypto';
import type {
  CanopyCallerDescriptor,
  CanopyErrorPayload,
  CanopyJsonValue,
  OperationRecord,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';
import { OperationLedgerRefusedError } from '../../operations/ledger/errors';
import type { OperationAcceptResult } from '../../operations/ledger/ledger';
import {
  OperationCancelRefusedError,
  type OperationServicePort,
} from '../../operations/service';

/*
 * CAN-4133: every App Advisor write is one keyed operation in the operation
 * ledger. A repeated tool call joins the running attempt or replays the
 * recorded result; it never runs the effect twice, across restarts.
 */
export const CORE_APP_ADVISOR_ACTION_DOMAIN = 'core.appAdvisor.action';
export const CORE_APP_ADVISOR_ACTION_RUN = 'core.appAdvisor.action.run';

export interface AdvisorActionRunRequest<Result extends CanopyJsonValue> {
  readonly caller: CanopyCallerDescriptor;
  readonly idempotencyKey: string;
  /** Hashed with stableStringify; never stored. */
  readonly fingerprintInput: CanopyJsonValue;
  readonly scope: {
    readonly workspaceId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  };
  readonly actionType: string;
  readonly decode: (outcome: unknown) => Result | null;
  readonly effect: () => Promise<Result>;
  /** The copy recorded for replays; defaults to the result itself. */
  readonly storeAs?: (result: Result) => Result;
}

export type AdvisorActionRunOutcome<Result> =
  | { readonly status: 'ran'; readonly result: Result }
  | { readonly status: 'replayed'; readonly result: Result }
  | { readonly status: 'conflict' }
  | { readonly status: 'interrupted' }
  | { readonly status: 'expired' }
  | { readonly status: 'unavailable' };

type TerminalOutcome =
  | { status: 'completed'; outcome: CanopyJsonValue }
  | { status: 'failed'; error: CanopyErrorPayload };

const FINISH_RETRY_DELAYS_MS = [250, 1_000, 4_000, 15_000, 60_000] as const;

const FAILED_PAYLOAD: CanopyErrorPayload = {
  kind: 'internal',
  message: 'The App Advisor action failed.',
  retry: { kind: 'never' },
};

const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export class AdvisorActionRuns {
  private readonly operations: OperationServicePort;
  private readonly onError: (error: unknown, context: string) => void;
  /** Terminal outcomes whose ledger write failed, by operation id. */
  private readonly unrecorded = new Map<string, TerminalOutcome>();

  constructor(options: {
    operations: OperationServicePort;
    onError?: (error: unknown, context: string) => void;
  }) {
    this.operations = options.operations;
    this.onError = options.onError ?? ((): void => undefined);
    this.operations.registerDomain({
      domain: CORE_APP_ADVISOR_ACTION_DOMAIN,
      kinds: [CORE_APP_ADVISOR_ACTION_RUN],
      restartClass: 'lost',
      cancel: () =>
        Promise.reject(
          new OperationCancelRefusedError(
            'App Advisor actions run to completion; they cannot be stopped this way.',
          ),
        ),
    });
  }

  /** Never rejects except when `effect` throws, after the failure is recorded. */
  async run<Result extends CanopyJsonValue>(
    request: AdvisorActionRunRequest<Result>,
  ): Promise<AdvisorActionRunOutcome<Result>> {
    let admitted: OperationAcceptResult;
    try {
      admitted = await this.operations.admit({
        kind: CORE_APP_ADVISOR_ACTION_RUN,
        status: 'running',
        receipt: {
          caller: `${CORE_APP_ADVISOR_ACTION_DOMAIN}:${request.caller.principalId}`,
          idempotencyKey: request.idempotencyKey,
          fingerprint: sha256Hex(stableStringify(request.fingerprintInput)),
        },
        origin: {
          kind: 'client',
          sourceId: request.caller.clientInstanceId,
          context: { actionType: request.actionType },
        },
        owner: { kind: 'principal', id: request.caller.principalId },
        scope: { ...request.scope },
      });
    } catch (error) {
      if (
        error instanceof OperationLedgerRefusedError &&
        error.refusal === 'key-reused'
      )
        return { status: 'conflict' };
      this.onError(error, 'advisor action admission');
      return { status: 'unavailable' };
    }
    const operationId = admitted.operation.operationId;
    switch (admitted.status) {
      case 'accepted': {
        let result: Result;
        try {
          result = await request.effect();
        } catch (error) {
          await this.finishQuietly(operationId, {
            status: 'failed',
            error: FAILED_PAYLOAD,
          });
          throw error;
        }
        await this.finishQuietly(operationId, {
          status: 'completed',
          outcome: request.storeAs ? request.storeAs(result) : result,
        });
        return { status: 'ran', result };
      }
      case 'replay-expired':
        return { status: 'expired' };
      case 'replay':
        return replay(admitted.operation, request.decode);
      case 'in-progress': {
        const unrecorded = await this.settleUnrecorded(operationId);
        return replay(
          unrecorded ?? (await this.operations.waitForTerminal(operationId)),
          request.decode,
        );
      }
    }
  }

  /**
   * Records a terminal outcome. A failed ledger write keeps the outcome in
   * memory and retries it with backoff, so a same-key retry in this process
   * replays it and a waiting joiner settles once a retry lands.
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
    } catch (error) {
      this.onError(error, 'advisor action finish');
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

function replay<Result>(
  record: {
    status: OperationRecord['status'];
    outcome?: OperationRecord['outcome'];
  },
  decode: (outcome: unknown) => Result | null,
): AdvisorActionRunOutcome<Result> {
  if (record.status === 'completed') {
    const result =
      record.outcome === null || record.outcome === undefined
        ? null
        : decode(record.outcome);
    return result === null
      ? { status: 'expired' }
      : { status: 'replayed', result };
  }
  if (record.status === 'failed' || record.status === 'cancelled')
    return { status: 'interrupted' };
  return { status: 'expired' };
}
