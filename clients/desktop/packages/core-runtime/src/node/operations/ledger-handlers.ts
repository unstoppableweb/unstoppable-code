import {
  CanopyErrorPayloadSchema,
  OPERATION_LEDGER_ERROR_CODES,
  type CanopyErrorPayload,
  type CanopyJsonValue,
  type CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS,
  type CORE_OPERATION_LEDGER_QUERY_DEFINITIONS,
  type CORE_OPERATION_LEDGER_STREAM_DEFINITIONS,
  type CanopyErrorKind,
  type OperationFailure,
  type OperationTerminalStatus,
} from '@canopy/protocol/canopy-core';

import {
  CanopyOperationError,
  canopyUnavailableError,
} from '../../runtime/errors';
import type {
  CanopyDispatcherHandlerMap,
  CanopyDispatcherInstructionHandlerMap,
  CanopyDispatcherStreamHandlerMap,
} from '../../runtime/types';
import {
  OperationLedgerError,
  OperationLedgerRefusedError,
  type OperationLedgerRefusal,
} from './ledger/errors';
import type { OperationLedgerEvent } from './ledger/ledger';
import type { OperationService } from './service';

export interface CoreOperationLedgerHandlers {
  queries: CanopyDispatcherHandlerMap<
    typeof CORE_OPERATION_LEDGER_QUERY_DEFINITIONS
  >;
  instructions: CanopyDispatcherInstructionHandlerMap<
    typeof CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS
  >;
  streams: CanopyDispatcherStreamHandlerMap<
    typeof CORE_OPERATION_LEDGER_STREAM_DEFINITIONS
  >;
}

function snapshotRequired(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: OPERATION_LEDGER_ERROR_CODES.snapshotRequired,
    message: 'Read the operations again before reopening the event stream.',
    retry: { kind: 'after_refresh', resource: 'core.operationLedger.list' },
  });
}

const REFUSAL_KINDS: Record<OperationLedgerRefusal, CanopyErrorKind> = {
  'not-found': 'not_found',
  'key-reused': 'already_exists',
  'revision-conflict': 'conflict',
  'invalid-state': 'failed_precondition',
  'unknown-parent': 'failed_precondition',
};

/**
 * A ledger refusal as `core.operationLedger.refused`, naming the refusal so
 * the owner raises the one the in-process ledger would.
 */
function translate(error: unknown): unknown {
  if (error instanceof OperationLedgerRefusedError) {
    const { operationId, currentRevision } = error.details;
    const kind = REFUSAL_KINDS[error.refusal];
    return new CanopyOperationError({
      kind,
      code: OPERATION_LEDGER_ERROR_CODES.refused,
      message: error.message.slice(0, 4_096) || 'The ledger refused the write.',
      details: {
        refusal: error.refusal,
        ...(typeof operationId === 'string' ? { operationId } : {}),
        ...(typeof currentRevision === 'number' ? { currentRevision } : {}),
      },
      retry:
        kind === 'conflict' || kind === 'failed_precondition'
          ? { kind: 'after_refresh', resource: 'core.operationLedger.get' }
          : { kind: 'never' },
    });
  }
  if (error instanceof OperationLedgerError)
    return canopyUnavailableError('Operation records are unavailable.');
  return error;
}

/** A wire failure as an error payload: the same plane-qualified code rule. */
function payload(
  error: OperationFailure | undefined,
): CanopyErrorPayload | undefined {
  return error === undefined
    ? undefined
    : CanopyErrorPayloadSchema.parse(error);
}

function terminal<
  T extends {
    status: OperationTerminalStatus;
    outcome?: CanopyJsonValue;
    error?: OperationFailure;
  },
>(wire: T): Omit<T, 'error'> & { error?: CanopyErrorPayload } {
  const { error, ...rest } = wire;
  const parsed = payload(error);
  return parsed === undefined ? rest : { ...rest, error: parsed };
}

async function translated<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translate(error);
  }
}

/**
 * The `core.operationLedger.*` handlers over the ledger owner's service
 * (CAN-6986 L3): each one calls one `OperationService` method with the
 * validated params. The dispatcher admits only the owner's grant.
 */
export function createCoreOperationLedgerHandlers(
  service: OperationService,
): CoreOperationLedgerHandlers {
  return {
    queries: {
      'core.operationLedger.get': ({ operationId }) =>
        translated(async () => ({
          operation: await service.get(operationId),
        })),
      'core.operationLedger.list': ({ limit, ...query }) =>
        translated(async () => {
          const page = await service.list({ ...query, limit });
          return {
            items: page.items,
            next: page.next,
            eventsHead: page.eventsHead,
          };
        }),
      'core.operationLedger.listUnfinished': ({ limit, ...query }) =>
        translated(async () => {
          const page = await service.listUnfinished({ ...query, limit });
          return {
            items: page.items,
            next: page.next,
            eventsHead: page.eventsHead,
          };
        }),
      'core.operationLedger.lookupReceipt': ({ kind, receipt }) =>
        translated(async () => ({
          lookup: await service.lookupReceipt(kind, receipt),
        })),
      'core.operationLedger.statusBeforeRestart': ({ operationId }) =>
        translated(async () => ({
          status: await service.statusBeforeRestart(operationId),
        })),
      'core.operationLedger.sourceHead': ({ source, subject }) =>
        translated(async () => ({
          value: await service.sourceHead(source, subject),
        })),
      'core.operationLedger.getDelegation': ({ delegationId }) =>
        translated(async () => ({
          delegation: await service.getDelegation(delegationId),
        })),
      'core.operationLedger.listDelegations': ({
        parentOperationId,
        after,
        limit,
      }) =>
        translated(async () => {
          const all = await service.listDelegations(parentOperationId);
          const at =
            after === undefined
              ? -1
              : all.findIndex(({ delegationId }) => delegationId === after);
          if (after !== undefined && at < 0)
            throw new OperationLedgerRefusedError(
              'not-found',
              'The page position names no dispatch of this operation.',
              { operationId: parentOperationId },
            );
          const start = at + 1;
          const delegations = all.slice(start, start + limit);
          const last = delegations[delegations.length - 1];
          return {
            delegations,
            next: last && start + limit < all.length ? last.delegationId : null,
          };
        }),
    },
    instructions: {
      'core.operationLedger.registerDomains': ({ ownerRun, domains }) =>
        translated(() => service.registerOwnerDomains(domains, { ownerRun })),
      'core.operationLedger.admit': ({ request }) =>
        translated(async () => ({ result: await service.admit(request) })),
      'core.operationLedger.admitInitiatedRuns': ({ head, runs }) =>
        translated(async () => ({
          outcomes: await service.admitInitiatedRuns({
            ...(head ? { head } : {}),
            runs: runs.map(({ request, finishAs }) => ({
              request,
              ...(finishAs ? { finishAs: terminal(finishAs) } : {}),
            })),
          }),
        })),
      'core.operationLedger.admitFinished': ({ request, terminal: ended }) =>
        translated(() => service.admitFinished(request, terminal(ended))),
      'core.operationLedger.finishCancelled': ({ operationId, intent }) =>
        translated(async () => {
          await service.finishCancelled(operationId, intent);
          return {};
        }),
      'core.operationLedger.placeInProcessWorker': ({ target, terms }) =>
        translated(async () => ({
          lease: await service.placeInProcessWorker(target, terms),
        })),
      'core.operationLedger.acceptDispatch': ({ request, dispatch }) =>
        translated(() => service.acceptDispatch(request, dispatch)),
      'core.operationLedger.markDispatched': ({ delegationId }) =>
        translated(() => service.markDispatched(delegationId)),
      'core.operationLedger.markDelegation': ({ delegationId, state }) =>
        translated(async () => ({
          delegation: await service.markDelegation(delegationId, state),
        })),
      'core.operationLedger.settleDispatch': ({ delegationId, settlement }) =>
        translated(() =>
          service.settleDispatch(delegationId, terminal(settlement)),
        ),
      'core.operationLedger.transition': ({ operationId, status }) =>
        translated(async () => ({
          operation: await service.transition(operationId, status),
        })),
      'core.operationLedger.reportProgress': ({ operationId, progress }) =>
        translated(async () => ({
          operation: await service.reportProgress(operationId, progress),
        })),
      'core.operationLedger.finish': ({ operationId, terminal: ended }) =>
        translated(async () => ({
          operation: await service.finish(operationId, terminal(ended)),
        })),
      'core.operationLedger.finishOrRecord': ({
        operationId,
        terminal: ended,
      }) =>
        translated(async () => ({
          operation: await service.finishOrRecord(operationId, terminal(ended)),
        })),
      'core.operationLedger.transitionOrRecord': ({ operationId, status }) =>
        translated(async () => ({
          operation: await service.transitionOrRecord(operationId, status),
        })),
      'core.operationLedger.cancelIntent': ({ operationId, ...request }) =>
        translated(() => service.cancelIntent(operationId, request)),
      'core.operationLedger.withdrawCancelIntent': ({ operationId }) =>
        translated(() => service.withdrawCancelIntent(operationId)),
      'core.operationLedger.recordRecovery': ({
        operationId,
        restartClass,
        recovery,
        runEpoch,
      }) =>
        translated(async () => ({
          operation: await service.recordRecovery(
            operationId,
            restartClass,
            recovery.status === 'failed'
              ? {
                  status: 'failed',
                  error: CanopyErrorPayloadSchema.parse(recovery.error),
                }
              : recovery,
            runEpoch,
          ),
        })),
    },
    streams: {
      /*
       * Every durable change at the ledger's own cursors, for the owner's
       * subscribers; it resumes from its last cursor after a reconnect, as
       * `core.operation.events` does.
       */
      'core.operationLedger.events': async (
        params,
        context,
        sink,
      ): Promise<(() => void) | void> => {
        const ledger = await translated(() => service.ready());
        const { ledgerId } = ledger;
        const cursor = params.cursor ?? null;
        if (
          cursor &&
          (cursor.daemonEpoch !== ledgerId ||
            cursor.sequence < ledger.eventsResumableFrom() ||
            cursor.sequence > ledger.eventsHead())
        ) {
          sink.end('error', snapshotRequired().payload);
          return;
        }
        let replaying = true;
        const pending: OperationLedgerEvent[] = [];
        const unsubscribe = service.subscribe((event) => {
          if (replaying) pending.push(event);
          else deliver(event);
        });
        let last = cursor ? cursor.sequence : ledger.eventsHead();
        let ended = false;
        const deliver = (event: OperationLedgerEvent): void => {
          if (ended || event.sequence <= last) return;
          last = event.sequence;
          ended =
            sink.emitAt(
              { daemonEpoch: ledgerId, sequence: event.sequence },
              event,
            ) === null;
        };
        while (cursor && !ended && !context.signal.aborted) {
          const page = ledger.eventsAfter(last);
          if (page.length === 0) break;
          for (const event of page) deliver(event);
        }
        replaying = false;
        for (const event of pending.splice(0)) deliver(event);
        return unsubscribe;
      },
    },
  };
}
