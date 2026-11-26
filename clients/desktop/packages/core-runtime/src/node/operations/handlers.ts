import type { CANOPY_STREAM_DEFINITIONS } from '@canopy/protocol/canopy-core';
import {
  OPERATION_ERROR_CODES,
  OPERATION_LIMITS,
  OPERATION_SNAPSHOT_RESOURCE,
  OperationListPositionSchema,
  type CanopyInstructionHandlerMap,
  type CanopyQueryHandlerMap,
  type CoreOperationEventsItem,
  type CoreOperationEventsParams,
  type CoreOperationListParams,
  type OperationRecord,
  OPERATION_LEDGER_ERROR_CODES,
} from '@canopy/protocol/canopy-core';

import {
  CanopyOperationError,
  canopyInvalidArgumentError,
  canopyUnavailableError,
} from '../../runtime/errors';
import type {
  CanopyDispatcherStreamHandlerMap,
  CanopyHandlerContext,
} from '../../runtime/types';
import {
  OperationLedgerError,
  OperationLedgerRefusedError,
} from './ledger/errors';
import type { OperationLedgerEvent } from './ledger/ledger';
import type { RemoteOperationService } from './remote';
import type { OperationService } from './service';

type OperationQueryHandlers = Pick<
  CanopyQueryHandlerMap<CanopyHandlerContext>,
  'core.operation.get' | 'core.operation.list'
>;
type OperationInstructionHandlers = Pick<
  CanopyInstructionHandlerMap<CanopyHandlerContext>,
  'core.operation.cancel'
>;
type OperationStreamHandlers = Pick<
  CanopyDispatcherStreamHandlerMap<typeof CANOPY_STREAM_DEFINITIONS>,
  'core.operation.events'
>;

export interface CoreOperationHandlers {
  queries: OperationQueryHandlers;
  instructions: OperationInstructionHandlers;
  streams: OperationStreamHandlers;
}

const AFTER_REFRESH = {
  kind: 'after_refresh',
  resource: OPERATION_SNAPSHOT_RESOURCE,
} as const;

function notFound(operationId: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: OPERATION_ERROR_CODES.NOT_FOUND,
    message: `Operation ${operationId} does not exist.`,
    details: { reason: 'NOT_FOUND' },
    retry: { kind: 'never' },
  });
}

function snapshotRequired(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: OPERATION_ERROR_CODES.SNAPSHOT_REQUIRED,
    message: 'Read the operations again before reopening the event stream.',
    details: { reason: 'SNAPSHOT_REQUIRED' },
    retry: AFTER_REFRESH,
  });
}

/** Ledger and service failures as the operation's declared errors. */
function translate(error: unknown): unknown {
  if (error instanceof OperationLedgerRefusedError) {
    const operationId = error.details.operationId;
    switch (error.refusal) {
      case 'not-found':
        return notFound(typeof operationId === 'string' ? operationId : '');
      case 'revision-conflict': {
        const currentRevision = error.details.currentRevision;
        return new CanopyOperationError({
          kind: 'conflict',
          code: OPERATION_ERROR_CODES.REVISION_CONFLICT,
          message: error.message,
          details: {
            reason: 'REVISION_CONFLICT',
            ...(typeof currentRevision === 'number' ? { currentRevision } : {}),
          },
          retry: AFTER_REFRESH,
        });
      }
      default:
        return new CanopyOperationError({
          kind: 'failed_precondition',
          code: OPERATION_ERROR_CODES.INVALID_STATE,
          message: error.message.slice(0, 4_096) || 'Invalid state.',
          details: { reason: 'INVALID_STATE' },
          retry: AFTER_REFRESH,
        });
    }
  }
  if (error instanceof OperationLedgerError)
    return canopyUnavailableError('Operation records are unavailable.');
  return error;
}

async function translated<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translate(error);
  }
}

/**
 * List cursors name the last item served: `[createdAt, operationId]`. A
 * cursor only positions a page; it grants nothing, since every reader sees
 * every record.
 */
function encodeCursor(after: {
  createdAt: string;
  operationId: string;
}): string {
  return Buffer.from(
    JSON.stringify([after.createdAt, after.operationId]),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string): {
  createdAt: string;
  operationId: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (error) {
    throw canopyInvalidArgumentError('The list cursor is invalid.', error);
  }
  const parsed = OperationListPositionSchema.safeParse(value);
  if (!parsed.success)
    throw canopyInvalidArgumentError('The list cursor is invalid.');
  const [createdAt, operationId] = parsed.data;
  return { createdAt, operationId };
}

function matchesScope(
  operation: OperationRecord,
  params: CoreOperationEventsParams,
): boolean {
  if (
    params.operationIds &&
    !params.operationIds.includes(operation.operationId)
  )
    return false;
  const scope = params.scope;
  if (!scope) return true;
  const recorded: Record<string, string | null | undefined> = {
    ...operation.scope,
    authorityId: operation.authorityId,
    targetId: operation.executionTargetId,
    operationId: operation.operationId,
  };
  return Object.entries(scope).every(
    ([field, value]) => value === undefined || recorded[field] === value,
  );
}

function toItem(
  ledgerId: string,
  event: OperationLedgerEvent,
): CoreOperationEventsItem {
  return {
    eventId: `${ledgerId}:${String(event.sequence)}`,
    occurredAt: event.occurredAt,
    event: event.event,
    previousStatus: event.previousStatus,
    operation: event.operation,
  };
}

/**
 * The `core.operation.*` handlers over the operation service. Params arrive
 * validated and authorized by the dispatcher; every caller with the read
 * grant sees every record, as every client of one local core is the same
 * principal.
 */
export function createCoreOperationHandlers(
  service: OperationService,
): CoreOperationHandlers {
  return {
    queries: {
      'core.operation.get': (params) =>
        translated(async () => {
          const operation = await service.get(params.operationId);
          if (!operation) throw notFound(params.operationId);
          return { operation };
        }),
      'core.operation.list': (params) =>
        translated(async () => {
          const ledger = await service.ready();
          const page = await service.list({
            ...(params.scope ? { scope: params.scope } : {}),
            ...(params.statuses ? { statuses: params.statuses } : {}),
            ...(params.kinds ? { kinds: params.kinds } : {}),
            ...(params.parentOperationId !== undefined
              ? { parentOperationId: params.parentOperationId }
              : {}),
            limit: params.pageSize ?? OPERATION_LIMITS.listPageDefault,
            ...(params.cursor !== undefined
              ? { after: decodeCursor(params.cursor) }
              : {}),
          });
          return {
            items: page.items,
            nextCursor: page.next ? encodeCursor(page.next) : null,
            eventsCursor: {
              daemonEpoch: ledger.ledgerId,
              sequence: page.eventsHead,
            },
          };
        }),
    },
    instructions: {
      'core.operation.cancel': (params, context) =>
        translated(() =>
          service.cancel(params.operationId, {
            reason: params.reason,
            requestedBy: context.caller.principalId,
            ...(params.expectedRevision !== undefined
              ? { expectedRevision: params.expectedRevision }
              : {}),
          }),
        ),
    },
    streams: {
      /*
       * Durable lifecycle events at the ledger's own cursors, so a client
       * resumes after a reconnect or a restart from its last cursor. A
       * client that falls behind the buffer is ended and resumes from its
       * last cursor; no terminal event is dropped. Closing the stream
       * releases only this subscription.
       */
      'core.operation.events': async (
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
        // The sink refuses items once the stream has ended, including when
        // a slow client overflows its buffer; nothing more is read for it.
        let ended = false;
        const deliver = (event: OperationLedgerEvent): void => {
          if (ended || event.sequence <= last) return;
          last = event.sequence;
          if (!matchesScope(event.operation, params)) return;
          ended =
            sink.emitAt(
              { daemonEpoch: ledgerId, sequence: event.sequence },
              toItem(ledgerId, event),
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

function listQuery(
  params: CoreOperationListParams,
): Parameters<OperationService['list']>[0] {
  return {
    ...(params.scope ? { scope: params.scope } : {}),
    ...(params.statuses ? { statuses: params.statuses } : {}),
    ...(params.kinds ? { kinds: params.kinds } : {}),
    ...(params.parentOperationId !== undefined
      ? { parentOperationId: params.parentOperationId }
      : {}),
    limit: params.pageSize ?? OPERATION_LIMITS.listPageDefault,
    ...(params.cursor !== undefined
      ? { after: decodeCursor(params.cursor) }
      : {}),
  };
}

/**
 * The `core.operation.*` handlers of an owner whose ledger another process
 * holds (CAN-6986 L3): reads and events come from the ledger over the owner
 * connection, at the ledger's own cursors, and a cancellation is applied by
 * the owning domain here, so the window's and Remote Control's cancels keep
 * going through this process.
 */
export function createRemoteCoreOperationHandlers(
  service: RemoteOperationService,
): CoreOperationHandlers {
  return {
    queries: {
      'core.operation.get': (params) =>
        translated(async () => {
          const operation = await service.get(params.operationId);
          if (!operation) throw notFound(params.operationId);
          return { operation };
        }),
      'core.operation.list': (params) =>
        translated(async () => {
          const query = listQuery(params);
          const ledgerId = await service.ledgerId();
          const page = await service.list(query);
          return {
            items: page.items,
            nextCursor: page.next ? encodeCursor(page.next) : null,
            eventsCursor: { daemonEpoch: ledgerId, sequence: page.eventsHead },
          };
        }),
    },
    instructions: {
      'core.operation.cancel': (params, context) =>
        translated(() =>
          service.cancel(params.operationId, {
            reason: params.reason,
            requestedBy: context.caller.principalId,
            ...(params.expectedRevision !== undefined
              ? { expectedRevision: params.expectedRevision }
              : {}),
          }),
        ),
    },
    streams: {
      'core.operation.events': async (
        params,
        _context,
        sink,
      ): Promise<(() => void) | void> => {
        const ledgerId = await translated(() => service.ledgerId());
        let ended = false;
        let close = (): void => undefined;
        close = await translated(() =>
          service.streamEvents(
            params.cursor ?? null,
            (cursor, event) => {
              if (ended || !matchesScope(event.operation, params)) return;
              ended = sink.emitAt(cursor, toItem(ledgerId, event)) === null;
              if (ended) close();
            },
            (error) => {
              if (ended) return;
              ended = true;
              sink.end(
                'error',
                error?.code === OPERATION_LEDGER_ERROR_CODES.snapshotRequired
                  ? snapshotRequired().payload
                  : canopyUnavailableError('Operation records are unavailable.')
                      .payload,
              );
            },
          ),
        );
        return close;
      },
    },
  };
}
