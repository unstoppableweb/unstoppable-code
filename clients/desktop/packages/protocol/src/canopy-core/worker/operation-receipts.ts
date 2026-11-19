import { z } from 'zod';

import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../definitions';
import { OperationFailureSchema } from '../core/operation/schemas';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';
const ID = z.string().min(1).max(512);
/** A worker instruction name; the host refuses one it does not serve. */
const OPERATION = z.string().min(1).max(256);

/**
 * Which dispatch to look up: a keyed instruction by its idempotency key, or
 * any instruction by the report-only `_meta.dispatchId` tag it was sent with.
 */
export const WorkerOperationReceiptGetParamsSchema = z.union([
  z.strictObject({ operation: OPERATION, idempotencyKey: ID }),
  z.strictObject({ operation: OPERATION, dispatchId: ID }),
]);

export type WorkerOperationReceiptGetParams = z.output<
  typeof WorkerOperationReceiptGetParamsSchema
>;

/**
 * Which tagged dispatch to seal: tags only, since a key never needs it.
 * `expectedEpoch` is the `daemonEpoch` (with any `/worker-<n>`) the dispatch
 * was sent under; the host refuses the seal when another run answers now.
 */
export const WorkerOperationReceiptSealParamsSchema = z.strictObject({
  operation: OPERATION,
  dispatchId: ID,
  expectedEpoch: ID,
});

export type WorkerOperationReceiptSealParams = z.output<
  typeof WorkerOperationReceiptSealParamsSchema
>;

export const WorkerOperationReceiptOutcomeSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      status: z.literal('completed'),
      /** Absent when the result is not bounded JSON (32 KiB). */
      result: CanopyJsonValueSchema.optional(),
    }),
    z.strictObject({
      status: z.literal('failed'),
      error: OperationFailureSchema,
    }),
  ],
);

/**
 * `absent`: this worker run had not received the dispatch; from `get` it may
 * still be on its way, from `seal` it never will be. `running`: its handler
 * has not settled. `settled`: how it ended. `forgotten`: its outcome is
 * unknown, because its receipt is no longer kept, the worker restarted, or
 * (for `seal`) the run's tag bound was reached.
 */
export const WorkerOperationReceiptSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent') }),
  z.strictObject({ state: z.literal('running') }),
  z.strictObject({ state: z.literal('forgotten') }),
  z.strictObject({
    state: z.literal('settled'),
    outcome: WorkerOperationReceiptOutcomeSchema,
  }),
]);

export type WorkerOperationReceipt = z.output<
  typeof WorkerOperationReceiptSchema
>;

export const WorkerOperationReceiptGetResultSchema = z.strictObject({
  /**
   * The answering runtime's epoch, with `/worker-<n>` after a supervised
   * worker restart; another epoch's dispatches are absent.
   */
  daemonEpoch: ID,
  receipt: WorkerOperationReceiptSchema,
});

export type WorkerOperationReceiptGetResult = z.output<
  typeof WorkerOperationReceiptGetResultSchema
>;

export const WORKER_OPERATION_RECEIPT_ERROR_CODES = [
  'worker.operation.receipt.unknownOperation',
  'worker.operation.receipt.keyMismatch',
] as const;

export const WorkerOperationReceiptGetErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(WORKER_OPERATION_RECEIPT_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

/**
 * Side effect free and never waits: it reads how one dispatch ended, never
 * runs, replays or seals it. It declares no grant of its own; the host
 * requires the looked-up instruction's grants instead, so it reveals an
 * outcome only to a caller allowed to send that instruction, and only its own
 * dispatches.
 */
export const WORKER_OPERATION_RECEIPT_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('worker', {
    'worker.operation.receipt.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'operation',
      version: 1,
      placement: 'worker-only',
      params: WorkerOperationReceiptGetParamsSchema,
      result: WorkerOperationReceiptGetResultSchema,
      error: WorkerOperationReceiptGetErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [],
    }),
  });

export const WORKER_OPERATION_RECEIPT_SEAL_ERROR_CODES = [
  'worker.operation.receipt.epochChanged',
] as const;

/**
 * `epochChanged` (`failed_precondition`): the daemon or its worker restarted
 * since `expectedEpoch`, so the dispatch's outcome can no longer be learned;
 * `details.daemonEpoch` names the run answering now.
 */
export const WorkerOperationReceiptSealErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(WORKER_OPERATION_RECEIPT_SEAL_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

/**
 * A write: it reads how one tagged dispatch stands and, when the worker never
 * received it, seals the tag so that dispatch is refused before it runs, which
 * makes its `absent` final for this epoch and worker incarnation. Repeating it
 * answers the same. It declares no grant of its own: the host seals only a tag
 * of an instruction, which the catalog classifies as a write, that the worker
 * serves and that requires at least one grant, all of which the caller holds.
 * A query, an unknown name or a missing grant is refused, so a caller without
 * that instruction's write authority can never seal.
 */
export const WORKER_OPERATION_RECEIPT_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.operation.receipt.seal': defineCanopyInstruction({
      plane: 'worker',
      domain: 'operation',
      version: 1,
      placement: 'worker-only',
      params: WorkerOperationReceiptSealParamsSchema,
      result: WorkerOperationReceiptGetResultSchema,
      error: WorkerOperationReceiptSealErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [],
    }),
  });
