import type {
  CanopyCallerDescriptor,
  CanopyInstructionDefinitionMap,
  WorkerOperationReceiptGetParams,
  WorkerOperationReceiptGetResult,
  WorkerOperationReceiptSealParams,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError, canopyPermissionDeniedError } from './errors';
import type { CanopyHandlerContext } from './types';
import type { WorkerExecutorReceipts } from './worker-executor-receipts';

/** The receipt operations themselves are never looked up or sealed. */
export const OPERATION_RECEIPT_SEAL = 'worker.operation.receipt.seal';

function refusal(
  code:
    | 'worker.operation.receipt.unknownOperation'
    | 'worker.operation.receipt.keyMismatch',
  message: string,
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    code,
    message,
    retry: { kind: 'never' },
  });
}

/**
 * The looked-up instruction's definition, once the caller may read its
 * receipts: it must hold every grant that instruction requires. Undefined
 * when this worker serves no such instruction.
 */
export function receiptTargetFor(
  instructions: CanopyInstructionDefinitionMap,
  operation: string,
  caller: CanopyCallerDescriptor,
): CanopyInstructionDefinitionMap[string] | undefined {
  const definition =
    operation !== OPERATION_RECEIPT_SEAL &&
    Object.prototype.hasOwnProperty.call(instructions, operation)
      ? instructions[operation]
      : undefined;
  if (!definition) return undefined;
  const grants = new Set(caller.grants);
  if (definition.requiredGrants.some((grant) => !grants.has(grant)))
    throw canopyPermissionDeniedError();
  return definition;
}

/**
 * The instruction whose tag `caller` may seal (CAN-4733). A seal is a write
 * on one dispatch: it needs exactly the grants that dispatching the
 * instruction needs, so it never gives a caller more than it already has.
 * It is allowed only for a tag of an instruction, which the catalog
 * classifies as a write, that this worker serves, that is gated by at least
 * one grant, and whose every grant the caller holds. Anything else is
 * permission_denied, with nothing sealed.
 */
export function sealTargetFor(
  instructions: CanopyInstructionDefinitionMap,
  operation: string,
  caller: CanopyCallerDescriptor,
): CanopyInstructionDefinitionMap[string] {
  const definition = receiptTargetFor(instructions, operation, caller);
  if (!definition || definition.requiredGrants.length === 0)
    throw canopyPermissionDeniedError();
  return definition;
}

/**
 * The looked-up instruction for a lookup: an unknown name, a query or a
 * receipt operation is `worker.operation.receipt.unknownOperation`.
 */
export function lookupTargetFor(
  instructions: CanopyInstructionDefinitionMap,
  operation: string,
  caller: CanopyCallerDescriptor,
): CanopyInstructionDefinitionMap[string] {
  const definition = receiptTargetFor(instructions, operation, caller);
  if (!definition)
    throw refusal(
      'worker.operation.receipt.unknownOperation',
      'This worker runs no instruction by that name.',
    );
  return definition;
}

interface ReceiptOptions {
  receipts: Pick<WorkerExecutorReceipts, 'lookup' | 'seal'>;
  instructions: CanopyInstructionDefinitionMap;
  daemonEpoch: () => string;
}

/**
 * `worker.operation.receipt.get` over one worker's executor receipts
 * (CAN-4733). Never waits, runs, replays or records anything. The caller must
 * hold the looked-up instruction's own grants, and sees only dispatches made
 * under its own principal.
 */
export function createWorkerOperationReceiptQuery(
  options: ReceiptOptions,
): (
  params: WorkerOperationReceiptGetParams,
  context: CanopyHandlerContext,
) => WorkerOperationReceiptGetResult {
  return (params, context) => {
    const definition = lookupTargetFor(
      options.instructions,
      params.operation,
      context.caller,
    );
    if ('idempotencyKey' in params && definition.idempotency !== 'keyed')
      throw refusal(
        'worker.operation.receipt.keyMismatch',
        'This instruction takes no idempotency key; look it up by dispatch tag.',
      );
    return {
      daemonEpoch: options.daemonEpoch(),
      receipt: options.receipts.lookup(
        context.caller.principalId,
        params.operation,
        'idempotencyKey' in params
          ? { idempotencyKey: params.idempotencyKey }
          : { dispatchId: params.dispatchId },
      ),
    };
  };
}

/**
 * `worker.operation.receipt.seal` over one worker's executor receipts
 * (CAN-4733): a tag the worker never received is sealed, so its dispatch is
 * refused before it runs and absent is final for this worker run. Only a
 * tag of a served, grant-gated instruction whose every grant the caller holds
 * is sealed, and only among the caller's own dispatches. The core checks
 * `expectedEpoch` before forwarding; a worker cannot, since it does not know
 * its own incarnation.
 */
export function createWorkerOperationReceiptSeal(
  options: ReceiptOptions,
): (
  params: WorkerOperationReceiptSealParams,
  context: CanopyHandlerContext,
) => WorkerOperationReceiptGetResult {
  return (params, context) => {
    sealTargetFor(options.instructions, params.operation, context.caller);
    return {
      daemonEpoch: options.daemonEpoch(),
      receipt: options.receipts.seal(
        context.caller.principalId,
        params.operation,
        params.dispatchId,
      ),
    };
  };
}
