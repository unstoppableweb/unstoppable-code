import { z } from 'zod';

import {
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  CoreOperationLedgerAcceptDispatchParamsSchema,
  CoreOperationLedgerAcceptDispatchResultSchema,
  CoreOperationLedgerAdmitFinishedParamsSchema,
  CoreOperationLedgerAdmitFinishedResultSchema,
  CoreOperationLedgerAdmitInitiatedRunsParamsSchema,
  CoreOperationLedgerAdmitInitiatedRunsResultSchema,
  CoreOperationLedgerAdmitParamsSchema,
  CoreOperationLedgerAdmitResultSchema,
  CoreOperationLedgerCancelIntentParamsSchema,
  CoreOperationLedgerCancelIntentResultSchema,
  CoreOperationLedgerEventsItemSchema,
  CoreOperationLedgerEventsOpenResultSchema,
  CoreOperationLedgerEventsParamsSchema,
  CoreOperationLedgerFinishCancelledParamsSchema,
  CoreOperationLedgerFinishCancelledResultSchema,
  CoreOperationLedgerFinishOrRecordParamsSchema,
  CoreOperationLedgerFinishOrRecordResultSchema,
  CoreOperationLedgerFinishParamsSchema,
  CoreOperationLedgerFinishResultSchema,
  CoreOperationLedgerGetDelegationParamsSchema,
  CoreOperationLedgerGetDelegationResultSchema,
  CoreOperationLedgerGetParamsSchema,
  CoreOperationLedgerGetResultSchema,
  CoreOperationLedgerListDelegationsParamsSchema,
  CoreOperationLedgerListDelegationsResultSchema,
  CoreOperationLedgerListParamsSchema,
  CoreOperationLedgerListResultSchema,
  CoreOperationLedgerListUnfinishedParamsSchema,
  CoreOperationLedgerListUnfinishedResultSchema,
  CoreOperationLedgerLookupReceiptParamsSchema,
  CoreOperationLedgerLookupReceiptResultSchema,
  CoreOperationLedgerMarkDelegationParamsSchema,
  CoreOperationLedgerMarkDelegationResultSchema,
  CoreOperationLedgerMarkDispatchedParamsSchema,
  CoreOperationLedgerMarkDispatchedResultSchema,
  CoreOperationLedgerPlaceInProcessWorkerParamsSchema,
  CoreOperationLedgerPlaceInProcessWorkerResultSchema,
  CoreOperationLedgerRecordRecoveryParamsSchema,
  CoreOperationLedgerRecordRecoveryResultSchema,
  CoreOperationLedgerRegisterDomainsParamsSchema,
  CoreOperationLedgerRegisterDomainsResultSchema,
  CoreOperationLedgerReportProgressParamsSchema,
  CoreOperationLedgerReportProgressResultSchema,
  CoreOperationLedgerSettleDispatchParamsSchema,
  CoreOperationLedgerSettleDispatchResultSchema,
  CoreOperationLedgerSourceHeadParamsSchema,
  CoreOperationLedgerSourceHeadResultSchema,
  CoreOperationLedgerStatusBeforeRestartParamsSchema,
  CoreOperationLedgerStatusBeforeRestartResultSchema,
  CoreOperationLedgerTransitionOrRecordParamsSchema,
  CoreOperationLedgerTransitionOrRecordResultSchema,
  CoreOperationLedgerTransitionParamsSchema,
  CoreOperationLedgerTransitionResultSchema,
  CoreOperationLedgerWithdrawCancelIntentParamsSchema,
  CoreOperationLedgerWithdrawCancelIntentResultSchema,
} from './schemas';

/**
 * Held only by the ledger owner's caller: the proven owner connection where
 * the daemon holds the ledger. Owner proof alone grants it, an interim
 * exception until E1 (CAN-4729) designates trusted connections.
 */
export const OPERATION_LEDGER_GRANTS = {
  owner: 'core.operationLedger.owner',
} as const;

export const OPERATION_LEDGER_OWNER_GRANTS = [
  OPERATION_LEDGER_GRANTS.owner,
] as const;

/** The ledger refusals, as `OperationLedgerRefusedError` names them. */
export const OPERATION_LEDGER_REFUSALS = [
  'not-found',
  'key-reused',
  'unknown-parent',
  'invalid-state',
  'revision-conflict',
] as const;
export type OperationLedgerRefusalReason =
  (typeof OPERATION_LEDGER_REFUSALS)[number];

export const OPERATION_LEDGER_ERROR_CODES = {
  refused: 'core.operationLedger.refused',
  snapshotRequired: 'core.operationLedger.snapshotRequired',
} as const;

/**
 * A refusal changed nothing; `details.refusal` names it, so the owner
 * raises the same refusal the in-process ledger would.
 */
export const OperationLedgerErrorDetailsSchema = z.strictObject({
  refusal: z.enum(OPERATION_LEDGER_REFUSALS),
  operationId: z.string().min(1).max(512).optional(),
  currentRevision: z.number().int().min(1).optional(),
});
export type OperationLedgerErrorDetails = z.output<
  typeof OperationLedgerErrorDetailsSchema
>;

export const OperationLedgerErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      OPERATION_LEDGER_ERROR_CODES.refused,
      OPERATION_LEDGER_ERROR_CODES.snapshotRequired,
    ])
    .optional(),
  details: OperationLedgerErrorDetailsSchema.optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

/**
 * The ledger's internal reads (CAN-6986 L3). Owner only: no interface
 * profile installs them, and only the ledger owner's caller holds the
 * grant.
 */
export const CORE_OPERATION_LEDGER_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.operationLedger.get': defineCanopyQuery({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerGetParamsSchema,
      result: CoreOperationLedgerGetResultSchema,
    }),
    'core.operationLedger.list': defineCanopyQuery({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerListParamsSchema,
      result: CoreOperationLedgerListResultSchema,
    }),
    'core.operationLedger.lookupReceipt': defineCanopyQuery({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerLookupReceiptParamsSchema,
      result: CoreOperationLedgerLookupReceiptResultSchema,
    }),
    'core.operationLedger.statusBeforeRestart': defineCanopyQuery({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerStatusBeforeRestartParamsSchema,
      result: CoreOperationLedgerStatusBeforeRestartResultSchema,
    }),
    'core.operationLedger.sourceHead': defineCanopyQuery({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerSourceHeadParamsSchema,
      result: CoreOperationLedgerSourceHeadResultSchema,
    }),
    'core.operationLedger.getDelegation': defineCanopyQuery({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerGetDelegationParamsSchema,
      result: CoreOperationLedgerGetDelegationResultSchema,
    }),
    'core.operationLedger.listDelegations': defineCanopyQuery({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerListDelegationsParamsSchema,
      result: CoreOperationLedgerListDelegationsResultSchema,
    }),
    'core.operationLedger.listUnfinished': defineCanopyQuery({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerListUnfinishedParamsSchema,
      result: CoreOperationLedgerListUnfinishedResultSchema,
    }),
  });

/**
 * The ledger's internal writes (CAN-6986 L3), each one `OperationService`
 * method. Owner only, as the reads are.
 */
export const CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.operationLedger.registerDomains': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerRegisterDomainsParamsSchema,
      result: CoreOperationLedgerRegisterDomainsResultSchema,
    }),
    'core.operationLedger.admit': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerAdmitParamsSchema,
      result: CoreOperationLedgerAdmitResultSchema,
    }),
    'core.operationLedger.admitInitiatedRuns': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerAdmitInitiatedRunsParamsSchema,
      result: CoreOperationLedgerAdmitInitiatedRunsResultSchema,
    }),
    'core.operationLedger.admitFinished': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerAdmitFinishedParamsSchema,
      result: CoreOperationLedgerAdmitFinishedResultSchema,
    }),
    'core.operationLedger.finishCancelled': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerFinishCancelledParamsSchema,
      result: CoreOperationLedgerFinishCancelledResultSchema,
    }),
    'core.operationLedger.placeInProcessWorker': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerPlaceInProcessWorkerParamsSchema,
      result: CoreOperationLedgerPlaceInProcessWorkerResultSchema,
    }),
    'core.operationLedger.acceptDispatch': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerAcceptDispatchParamsSchema,
      result: CoreOperationLedgerAcceptDispatchResultSchema,
    }),
    'core.operationLedger.markDispatched': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerMarkDispatchedParamsSchema,
      result: CoreOperationLedgerMarkDispatchedResultSchema,
    }),
    'core.operationLedger.markDelegation': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerMarkDelegationParamsSchema,
      result: CoreOperationLedgerMarkDelegationResultSchema,
    }),
    'core.operationLedger.settleDispatch': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerSettleDispatchParamsSchema,
      result: CoreOperationLedgerSettleDispatchResultSchema,
    }),
    'core.operationLedger.transition': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerTransitionParamsSchema,
      result: CoreOperationLedgerTransitionResultSchema,
    }),
    'core.operationLedger.reportProgress': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerReportProgressParamsSchema,
      result: CoreOperationLedgerReportProgressResultSchema,
    }),
    'core.operationLedger.finish': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerFinishParamsSchema,
      result: CoreOperationLedgerFinishResultSchema,
    }),
    'core.operationLedger.finishOrRecord': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerFinishOrRecordParamsSchema,
      result: CoreOperationLedgerFinishOrRecordResultSchema,
    }),
    'core.operationLedger.transitionOrRecord': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerTransitionOrRecordParamsSchema,
      result: CoreOperationLedgerTransitionOrRecordResultSchema,
    }),
    'core.operationLedger.cancelIntent': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerCancelIntentParamsSchema,
      result: CoreOperationLedgerCancelIntentResultSchema,
    }),
    'core.operationLedger.withdrawCancelIntent': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerWithdrawCancelIntentParamsSchema,
      result: CoreOperationLedgerWithdrawCancelIntentResultSchema,
    }),
    'core.operationLedger.recordRecovery': defineCanopyInstruction({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'none',
      params: CoreOperationLedgerRecordRecoveryParamsSchema,
      result: CoreOperationLedgerRecordRecoveryResultSchema,
    }),
  });

export const CoreOperationLedgerEventsEndSchema = CanopyStreamEndSchema.extend({
  error: OperationLedgerErrorSchema.nullable(),
});

/**
 * The ledger's durable events for its owner (CAN-6986 L3), at the ledger's
 * own cursors. Owner only, as the reads are; clients observe operations
 * through `core.operation.events`.
 */
export const CORE_OPERATION_LEDGER_STREAM_DEFINITIONS =
  defineCanopyStreamRegistry('core', {
    'core.operationLedger.events': defineCanopyStream({
      plane: 'core',
      domain: 'operationLedger',
      version: 1,
      placement: 'core-only',
      requiredGrants: [OPERATION_LEDGER_GRANTS.owner],
      error: OperationLedgerErrorSchema,
      idempotency: 'inherent',
      params: CoreOperationLedgerEventsParamsSchema,
      openResult: CoreOperationLedgerEventsOpenResultSchema,
      item: CoreOperationLedgerEventsItemSchema,
      end: CoreOperationLedgerEventsEndSchema,
    }),
  });
