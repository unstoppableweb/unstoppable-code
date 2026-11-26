import {
  WORKER_OPERATION_RECEIPT_INSTRUCTION_DEFINITIONS,
  WORKER_OPERATION_RECEIPT_QUERY_DEFINITIONS,
  WorkerOperationReceiptGetParamsSchema,
  WorkerOperationReceiptGetResultSchema,
  WorkerOperationReceiptSealParamsSchema,
  type CanopyInstructionDefinitionMap,
  type WorkerOperationReceiptGetResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../runtime/errors';
import type { CanopyHandlerContext } from '../runtime/types';
import {
  OPERATION_RECEIPT_SEAL,
  lookupTargetFor,
  sealTargetFor,
  type createWorkerOperationReceiptQuery,
  type createWorkerOperationReceiptSeal,
} from '../runtime/worker-operation-receipts';
import { peerScopedDispatchTag } from '../runtime/dispatch-tag-scope';
import { peerScopedIdempotencyKey } from './peer-scoped-idempotency';
import type { RuntimeModule } from './runtime-profile-graph';

export const OPERATION_RECEIPT_QUERY = 'worker.operation.receipt.get';
export { OPERATION_RECEIPT_SEAL };

type Handler = (params: unknown, context: CanopyHandlerContext) => unknown;

/** Seal params without the instruction's `_meta`, which carries no target. */
function sealParams(
  raw: unknown,
): ReturnType<typeof WorkerOperationReceiptSealParamsSchema.parse> {
  if (typeof raw !== 'object' || raw === null || !('_meta' in raw))
    return WorkerOperationReceiptSealParamsSchema.parse(raw);
  return WorkerOperationReceiptSealParamsSchema.parse(
    Object.fromEntries(
      Object.entries(raw).filter(([name]) => name !== '_meta'),
    ),
  );
}

/** Filled in by the worker that owns the receipts, and by the core's runtime. */
export interface OperationReceiptState {
  query?: ReturnType<typeof createWorkerOperationReceiptQuery>;
  seal?: ReturnType<typeof createWorkerOperationReceiptSeal>;
  daemonEpoch?: string;
  /** A supervised worker's incarnation; absent for a bundled worker. */
  workerIncarnation?: () => number;
}

/**
 * The worker-plane module that serves `worker.operation.receipt.get` and
 * `worker.operation.receipt.seal` (CAN-4733). Its handlers use the worker's
 * executor receipts, which exist only once the worker is composed, so they
 * answer through `state`.
 */
export function operationReceiptModule(
  state: OperationReceiptState,
): RuntimeModule {
  return {
    name: 'worker.operation.receipts',
    plane: 'worker',
    definitions: {
      queries: WORKER_OPERATION_RECEIPT_QUERY_DEFINITIONS,
      instructions: WORKER_OPERATION_RECEIPT_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {
        [OPERATION_RECEIPT_QUERY]: (params, context) => {
          if (!state.query)
            throw new Error('The operation receipt query is not composed');
          return state.query(
            WorkerOperationReceiptGetParamsSchema.parse(params),
            context,
          );
        },
      },
      instructions: {
        [OPERATION_RECEIPT_SEAL]: (params, context) => {
          if (!state.seal)
            throw new Error('The operation receipt seal is not composed');
          return state.seal(sealParams(params), context);
        },
      },
      streams: {},
    },
  };
}

export { scopeForwardedDispatchTags } from '../runtime/dispatch-tag-scope';

interface RouteOptions {
  instructions: CanopyInstructionDefinitionMap;
  peerScopedIdempotency: ReadonlySet<string>;
  state: OperationReceiptState;
}

/**
 * The run answering now: the core's epoch, with the worker incarnation once
 * a supervised worker has restarted.
 */
function answeringEpoch(
  state: OperationReceiptState,
  incarnation: number | undefined,
): string | undefined {
  const epoch = state.daemonEpoch;
  if (epoch === undefined) return undefined;
  return incarnation !== undefined && incarnation > 1
    ? `${epoch}/worker-${incarnation}`
    : epoch;
}

/**
 * Forwards one scoped lookup or seal and answers with the run answering now.
 * A worker that restarted lost the tags and seals its predecessor kept. A
 * lookup's absent is then never more than unknown, so it reads forgotten
 * after any restart. A seal was checked against its expected epoch before
 * forwarding, so it reads forgotten only when the worker restarted during
 * the call.
 */
async function forwardScoped(
  forward: Handler,
  scoped: unknown,
  context: CanopyHandlerContext,
  state: OperationReceiptState,
  kind: 'lookup' | 'seal',
): Promise<WorkerOperationReceiptGetResult> {
  const { workerIncarnation } = state;
  const before = workerIncarnation?.();
  const result = WorkerOperationReceiptGetResultSchema.parse(
    await forward(scoped, context),
  );
  const incarnation = workerIncarnation?.();
  const changed = incarnation !== before;
  const unknown =
    kind === 'seal'
      ? changed
      : incarnation !== undefined && (incarnation > 1 || changed);
  const receipt =
    unknown && result.receipt.state === 'absent'
      ? { state: 'forgotten' as const }
      : result.receipt;
  return {
    ...result,
    receipt,
    daemonEpoch: answeringEpoch(state, incarnation) ?? result.daemonEpoch,
  };
}

function epochChanged(current: string | undefined): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.operation.receipt.epochChanged',
    message:
      'The daemon or its worker restarted since this dispatch was sent, so its outcome can no longer be learned.',
    ...(current !== undefined && { details: { daemonEpoch: current } }),
    retry: { kind: 'never' },
  });
}

/**
 * The core's forwarder for `worker.operation.receipt.get`. The worker sees
 * only the owning core, so the core refuses an operation it does not serve
 * as an instruction, checks the interface caller's grants for the looked-up
 * instruction, scopes the key or tag to that caller exactly as
 * the dispatch was scoped, and answers with its own runtime epoch, the one
 * `core.runtime.initialize` reported.
 */
export function routeOperationReceiptLookups(
  queries: Readonly<Record<string, Handler>>,
  options: RouteOptions,
): Readonly<Record<string, Handler>> {
  const forward = queries[OPERATION_RECEIPT_QUERY];
  if (!forward) return queries;
  return {
    ...queries,
    [OPERATION_RECEIPT_QUERY]: async (
      raw: unknown,
      context: CanopyHandlerContext,
    ): Promise<WorkerOperationReceiptGetResult> => {
      const params = WorkerOperationReceiptGetParamsSchema.parse(raw);
      lookupTargetFor(options.instructions, params.operation, context.caller);
      const scoped =
        'dispatchId' in params
          ? {
              ...params,
              dispatchId: peerScopedDispatchTag(
                context.caller,
                params.dispatchId,
              ),
            }
          : options.peerScopedIdempotency.has(params.operation)
            ? {
                ...params,
                idempotencyKey: peerScopedIdempotencyKey(
                  context.caller,
                  params.idempotencyKey,
                ),
              }
            : params;
      return await forwardScoped(
        forward,
        scoped,
        context,
        options.state,
        'lookup',
      );
    },
  };
}

/**
 * The core's forwarder for `worker.operation.receipt.seal`, scoped like a
 * lookup. A seal the caller may not make (`sealTargetFor`), or one naming
 * another run than the one answering now, is refused here, before anything
 * reaches the worker: only the core knows both its epoch and the worker's
 * incarnation, and a sealed absent from another run would wrongly say a
 * dispatch the old run may have executed was never received.
 */
export function routeOperationReceiptSeals(
  instructions: Readonly<Record<string, Handler>>,
  options: RouteOptions,
): Readonly<Record<string, Handler>> {
  const forward = instructions[OPERATION_RECEIPT_SEAL];
  if (!forward) return instructions;
  return {
    ...instructions,
    [OPERATION_RECEIPT_SEAL]: async (
      raw: unknown,
      context: CanopyHandlerContext,
    ): Promise<WorkerOperationReceiptGetResult> => {
      const params = sealParams(raw);
      sealTargetFor(options.instructions, params.operation, context.caller);
      const current = answeringEpoch(
        options.state,
        options.state.workerIncarnation?.(),
      );
      if (current === undefined || params.expectedEpoch !== current)
        throw epochChanged(current);
      const scoped = {
        ...params,
        dispatchId: peerScopedDispatchTag(context.caller, params.dispatchId),
      };
      return await forwardScoped(
        forward,
        scoped,
        context,
        options.state,
        'seal',
      );
    },
  };
}
