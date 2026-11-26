import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../../common';
import { CanopyStreamCursorSchema } from '../../definitions';
import { CanopyJsonValueSchema } from '../../errors';
import {
  DelegationLeaseReleaseReasonSchema,
  DelegationLeaseRenewalSchema,
  DelegationRecordSchema,
  DelegationResolutionSchema,
  ExecutionTargetRecordSchema,
} from '../delegation/records';
import {
  OPERATION_LIMITS,
  OPERATION_TERMINAL_STATUSES,
  OperationCancellationSchema,
  OperationEventTypeSchema,
  OperationFailureSchema,
  OperationKindSchema,
  OperationOriginSchema,
  OperationOwnerSchema,
  OperationRecordSchema,
  OperationRestartClassSchema,
  OperationStatusSchema,
} from '../operation/schemas';

/*
 * The operation ledger's internal writes and reads (CAN-6986 L3), for the
 * one owner whose domains run outside the process that holds the ledger.
 * Each operation is one `OperationService` method, with the same inputs and
 * results, so a remote service behaves as the in-process one does. Clients
 * keep using `core.operation.*`; nothing here is offered to an interface.
 */

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });

export const OPERATION_LEDGER_LIMITS = {
  admissionRunsMax: 256,
  domainsMax: 64,
  domainKindsMax: 64,
  delegationsPageMax: 500,
  headValueMax: 4_096,
} as const;

/** A keyed request's identity; the kind completes the key. */
export const OperationLedgerReceiptInputSchema = z.strictObject({
  caller: id,
  idempotencyKey: id,
  /** A digest of the request parameters the key is bound to. */
  fingerprint: id,
});

export const OperationLedgerAcceptRequestSchema = z.strictObject({
  kind: OperationKindSchema,
  status: z.enum(['queued', 'running']).optional(),
  receipt: OperationLedgerReceiptInputSchema.optional(),
  origin: OperationOriginSchema,
  owner: OperationOwnerSchema,
  scope: CanopyWorkspaceScopeSchema.optional(),
  parentOperationId: id.optional(),
  authorityId: id.nullable().optional(),
  executionTargetId: id.nullable().optional(),
  runtimeDelegationId: id.nullable().optional(),
});

/** A durable change, with its ledger sequence and the record it left. */
export const OperationLedgerEventSchema = z.strictObject({
  sequence: z.number().int().min(1),
  event: OperationEventTypeSchema,
  previousStatus: OperationStatusSchema.nullable(),
  occurredAt: timestamp,
  operation: OperationRecordSchema,
});

export const OperationLedgerAcceptResultSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      status: z.literal('accepted'),
      operation: OperationRecordSchema,
      event: OperationLedgerEventSchema,
    }),
    z.strictObject({
      status: z.enum(['in-progress', 'replay', 'replay-expired']),
      operation: OperationRecordSchema,
    }),
  ],
);

export const OperationLedgerTerminalSchema = z.strictObject({
  status: z.enum(OPERATION_TERMINAL_STATUSES),
  outcome: CanopyJsonValueSchema.optional(),
  error: OperationFailureSchema.optional(),
});

const NON_TERMINAL = z.enum(['queued', 'running', 'paused']);

const OperationChangeSchema = z.strictObject({
  operation: OperationRecordSchema,
  event: OperationLedgerEventSchema.nullable(),
});

const DelegationChangeSchema = z.strictObject({
  delegation: DelegationRecordSchema,
  change: OperationChangeSchema,
});

/*
 * The lease shape without the record schema's renewal refinement, which
 * the core enforces when it writes a lease. Kept field for field with
 * `DelegationLeaseRecordSchema`.
 */
const DelegationLeaseSchema = z.strictObject({
  leaseId: id,
  targetId: id,
  binding: z.enum(['in-process', 'local', 'http']),
  signal: z.enum(['process_liveness', 'transport_close', 'renewal']),
  runEpoch: id,
  leaseEpoch: z.number().int().min(1).optional(),
  lastRenewal: DelegationLeaseRenewalSchema.nullable().optional(),
  acquiredAt: timestamp,
  renewAfterMs: z.number().int().min(0).nullable(),
  ttlMs: z.number().int().min(0).nullable(),
  expiresAt: timestamp.nullable(),
  releasedAt: timestamp.nullable(),
  releaseReason: DelegationLeaseReleaseReasonSchema.nullable(),
});

const DelegationLeaseTermsSchema = DelegationLeaseSchema.pick({
  binding: true,
  signal: true,
  renewAfterMs: true,
  ttlMs: true,
});

const ExecutionTargetRegistrationSchema = ExecutionTargetRecordSchema.omit({
  registeredAt: true,
});

const DelegationDispatchInputSchema = DelegationRecordSchema.pick({
  delegationId: true,
  targetId: true,
  leaseId: true,
  operation: true,
  idempotencyKey: true,
  executorKey: true,
  activation: true,
  secrets: true,
});

const OperationIdParamsSchema = z.strictObject({ operationId: id });
const OperationResultSchema = z.strictObject({
  operation: OperationRecordSchema,
});
const OperationOrNullResultSchema = z.strictObject({
  operation: OperationRecordSchema.nullable(),
});
const DelegationIdParamsSchema = z.strictObject({ delegationId: id });

// Queries.

export const CoreOperationLedgerGetParamsSchema = OperationIdParamsSchema;
export const CoreOperationLedgerGetResultSchema = OperationOrNullResultSchema;

export const CoreOperationLedgerListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  statuses: z.array(OperationStatusSchema).min(1).max(6).optional(),
  kinds: z
    .array(OperationKindSchema)
    .min(1)
    .max(OPERATION_LIMITS.listKindsMax)
    .optional(),
  parentOperationId: id.optional(),
  limit: z.number().int().min(1).max(OPERATION_LIMITS.listPageMax),
  /** The last item of the previous page; pages run newest first. */
  after: z.strictObject({ createdAt: timestamp, operationId: id }).optional(),
});
export const CoreOperationLedgerListResultSchema = z.strictObject({
  items: z.array(OperationRecordSchema).max(OPERATION_LIMITS.listPageMax),
  next: z.strictObject({ createdAt: timestamp, operationId: id }).nullable(),
  /** The event sequence read before the page. */
  eventsHead: z.number().int().min(0),
});

export const CoreOperationLedgerLookupReceiptParamsSchema = z.strictObject({
  kind: OperationKindSchema,
  receipt: OperationLedgerReceiptInputSchema,
});
export const CoreOperationLedgerLookupReceiptResultSchema = z.strictObject({
  lookup: z.discriminatedUnion('status', [
    z.strictObject({ status: z.enum(['none', 'key-reused']) }),
    z.strictObject({
      status: z.enum(['in-progress', 'replay', 'replay-expired']),
      operation: OperationRecordSchema,
    }),
  ]),
});

export const CoreOperationLedgerStatusBeforeRestartParamsSchema =
  OperationIdParamsSchema;
export const CoreOperationLedgerStatusBeforeRestartResultSchema =
  z.strictObject({ status: OperationStatusSchema.nullable() });

export const CoreOperationLedgerSourceHeadParamsSchema = z.strictObject({
  source: id,
  subject: id,
});
export const CoreOperationLedgerSourceHeadResultSchema = z.strictObject({
  value: z.string().max(OPERATION_LEDGER_LIMITS.headValueMax).nullable(),
});

export const CoreOperationLedgerGetDelegationParamsSchema =
  DelegationIdParamsSchema;
export const CoreOperationLedgerGetDelegationResultSchema = z.strictObject({
  delegation: DelegationRecordSchema.nullable(),
});

/** One page of a parent's dispatches, oldest first, after `after`. */
export const CoreOperationLedgerListDelegationsParamsSchema = z.strictObject({
  parentOperationId: id,
  after: id.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(OPERATION_LEDGER_LIMITS.delegationsPageMax),
});
export const CoreOperationLedgerListDelegationsResultSchema = z.strictObject({
  delegations: z
    .array(DelegationRecordSchema)
    .max(OPERATION_LEDGER_LIMITS.delegationsPageMax),
  /** The last dispatch of this page when more follow; null on the last. */
  next: id.nullable(),
});

const AcceptPositionSchema = z.number().int().min(1);

/**
 * One page of unfinished work, of some kinds or under one parent, in the
 * order the ledger accepted it: the order the in-process service recovers
 * and cancels in.
 */
export const CoreOperationLedgerListUnfinishedParamsSchema = z
  .strictObject({
    /** At most every kind one registration can claim. */
    kinds: z
      .array(OperationKindSchema)
      .min(1)
      .max(
        OPERATION_LEDGER_LIMITS.domainsMax *
          OPERATION_LEDGER_LIMITS.domainKindsMax,
      )
      .optional(),
    parentOperationId: id.optional(),
    /** `next` of the previous page. */
    after: AcceptPositionSchema.optional(),
    limit: z.number().int().min(1).max(OPERATION_LIMITS.listPageMax),
  })
  .refine(
    ({ kinds, parentOperationId }) =>
      kinds !== undefined || parentOperationId !== undefined,
    { message: 'Name the kinds or the parent operation.' },
  );
export const CoreOperationLedgerListUnfinishedResultSchema = z.strictObject({
  items: z.array(OperationRecordSchema).max(OPERATION_LIMITS.listPageMax),
  /** Where the next page starts when more follow; null on the last. */
  next: AcceptPositionSchema.nullable(),
  /** The event sequence read before the page. */
  eventsHead: z.number().int().min(0),
});

// Instructions.

export const OperationLedgerDomainSchema = z.strictObject({
  domain: id,
  kinds: z
    .array(OperationKindSchema)
    .min(1)
    .max(OPERATION_LEDGER_LIMITS.domainKindsMax),
  restartClass: OperationRestartClassSchema,
});

/**
 * The ledger runs as the owner process's `ownerRun`. A new owner process
 * replaces the earlier one's domains and starts a new run, and work earlier
 * runs left unfinished is reconciled as at an open; the same process, after
 * a reconnect or the ledger's restart, resumes its run and claims its
 * domains again. The work left paused for the owner to recover in its own
 * process is read page by page, in accept order, through
 * `core.operationLedger.listUnfinished`.
 */
export const CoreOperationLedgerRegisterDomainsParamsSchema = z.strictObject({
  /**
   * The owner process's run, the same for each of its owner sessions. A
   * different run than the ledger's last starts a new run, so work the
   * earlier process left unfinished is reconciled as at an open.
   */
  ownerRun: id,
  domains: z
    .array(OperationLedgerDomainSchema)
    .max(OPERATION_LEDGER_LIMITS.domainsMax),
});
export const CoreOperationLedgerRegisterDomainsResultSchema = z.strictObject({
  /** The ledger's identity, as its event cursors name it. */
  ledgerId: id,
  /**
   * The event sequence read before the registration changed anything, so
   * the owner's events can resume from it and miss no change it made.
   */
  eventsHead: z.number().int().min(0),
  runEpoch: id,
  /**
   * The ledger's run of this owner process, new each time its owner
   * process changes, so the owner tells its runs here apart.
   */
  claimId: id,
  /**
   * The ledger resumed this owner process's run: nothing was reconciled,
   * so nothing new awaits the owner's recovery.
   */
  resumed: z.boolean(),
});

export const CoreOperationLedgerAdmitParamsSchema = z.strictObject({
  request: OperationLedgerAcceptRequestSchema,
});
export const CoreOperationLedgerAdmitResultSchema = z.strictObject({
  result: OperationLedgerAcceptResultSchema,
});

export const CoreOperationLedgerAdmitInitiatedRunsParamsSchema = z.strictObject(
  {
    head: z
      .strictObject({
        source: id,
        subject: id,
        value: z.string().max(OPERATION_LEDGER_LIMITS.headValueMax),
      })
      .optional(),
    runs: z
      .array(
        z.strictObject({
          request: OperationLedgerAcceptRequestSchema,
          finishAs: OperationLedgerTerminalSchema.optional(),
        }),
      )
      .max(OPERATION_LEDGER_LIMITS.admissionRunsMax),
  },
);
export const CoreOperationLedgerAdmitInitiatedRunsResultSchema = z.strictObject(
  {
    outcomes: z
      .array(
        z.discriminatedUnion('status', [
          z.strictObject({
            status: z.enum(['accepted', 'stopped', 'duplicate']),
            operation: OperationRecordSchema,
          }),
          z.strictObject({ status: z.literal('keyReused') }),
        ]),
      )
      .max(OPERATION_LEDGER_LIMITS.admissionRunsMax),
  },
);

export const CoreOperationLedgerAdmitFinishedParamsSchema = z.strictObject({
  request: OperationLedgerAcceptRequestSchema,
  terminal: OperationLedgerTerminalSchema,
});
export const CoreOperationLedgerAdmitFinishedResultSchema = z.strictObject({
  status: z.enum(['accepted', 'duplicate']),
  operation: OperationRecordSchema,
});

export const CoreOperationLedgerFinishCancelledParamsSchema = z.strictObject({
  operationId: id,
  intent: OperationCancellationSchema.optional(),
});
export const CoreOperationLedgerFinishCancelledResultSchema = z.strictObject(
  {},
);

export const CoreOperationLedgerPlaceInProcessWorkerParamsSchema =
  z.strictObject({
    target: ExecutionTargetRegistrationSchema,
    terms: DelegationLeaseTermsSchema,
  });
export const CoreOperationLedgerPlaceInProcessWorkerResultSchema =
  z.strictObject({ lease: DelegationLeaseSchema });

export const CoreOperationLedgerAcceptDispatchParamsSchema = z.strictObject({
  request: OperationLedgerAcceptRequestSchema.extend({
    parentOperationId: id,
    runtimeDelegationId: id,
  }),
  dispatch: DelegationDispatchInputSchema,
});
export const CoreOperationLedgerAcceptDispatchResultSchema = z.strictObject({
  result: OperationLedgerAcceptResultSchema,
  delegation: DelegationRecordSchema,
});

export const CoreOperationLedgerMarkDispatchedParamsSchema =
  DelegationIdParamsSchema;
export const CoreOperationLedgerMarkDispatchedResultSchema =
  DelegationChangeSchema;

export const CoreOperationLedgerMarkDelegationParamsSchema = z.strictObject({
  delegationId: id,
  state: z.enum(['reconciling', 'unreachable']),
});
export const CoreOperationLedgerMarkDelegationResultSchema = z.strictObject({
  delegation: DelegationRecordSchema,
});

export const CoreOperationLedgerSettleDispatchParamsSchema = z.strictObject({
  delegationId: id,
  settlement: OperationLedgerTerminalSchema.extend({
    resolution: DelegationResolutionSchema,
  }),
});
export const CoreOperationLedgerSettleDispatchResultSchema =
  DelegationChangeSchema;

export const CoreOperationLedgerTransitionParamsSchema = z.strictObject({
  operationId: id,
  status: NON_TERMINAL,
});
export const CoreOperationLedgerTransitionResultSchema = OperationResultSchema;

export const CoreOperationLedgerReportProgressParamsSchema = z.strictObject({
  operationId: id,
  progress: z.number().min(0).max(1),
});
export const CoreOperationLedgerReportProgressResultSchema =
  OperationResultSchema;

export const CoreOperationLedgerFinishParamsSchema = z.strictObject({
  operationId: id,
  terminal: OperationLedgerTerminalSchema,
});
export const CoreOperationLedgerFinishResultSchema = OperationResultSchema;

export const CoreOperationLedgerFinishOrRecordParamsSchema =
  CoreOperationLedgerFinishParamsSchema;
export const CoreOperationLedgerFinishOrRecordResultSchema =
  OperationOrNullResultSchema;

export const CoreOperationLedgerTransitionOrRecordParamsSchema =
  CoreOperationLedgerTransitionParamsSchema;
export const CoreOperationLedgerTransitionOrRecordResultSchema =
  OperationOrNullResultSchema;

/**
 * Record a cancellation intent before the owner's domain is told, so a
 * restart cancels the work instead of resuming it. `already-terminal`
 * changes nothing.
 */
export const CoreOperationLedgerCancelIntentParamsSchema = z.strictObject({
  operationId: id,
  reason: z.string().min(1).max(OPERATION_LIMITS.reasonMax),
  /** The principal that asked, as the owner received the request. */
  requestedBy: id,
  expectedRevision: z.number().int().min(1).optional(),
});
export const CoreOperationLedgerCancelIntentResultSchema = z.strictObject({
  operation: OperationRecordSchema,
  outcome: z.enum(['recorded', 'already-terminal']),
});

/** Withdraw the intent a refused cancellation recorded. */
export const CoreOperationLedgerWithdrawCancelIntentParamsSchema =
  OperationIdParamsSchema;
export const CoreOperationLedgerWithdrawCancelIntentResultSchema =
  OperationChangeSchema;

/**
 * What the owner's domain found for work `registerDomains` left awaiting:
 * the second phase of restart reconciliation, written as the in-process
 * service writes it.
 */
export const CoreOperationLedgerRecordRecoveryParamsSchema = z.strictObject({
  operationId: id,
  restartClass: z.enum(['resumable', 'reattachable']),
  recovery: z.discriminatedUnion('status', [
    z.strictObject({ status: z.enum(['running', 'queued']) }),
    z.strictObject({
      status: z.literal('completed'),
      outcome: CanopyJsonValueSchema.optional(),
    }),
    z.strictObject({
      status: z.literal('failed'),
      error: OperationFailureSchema,
    }),
    z.strictObject({ status: z.enum(['cancelled', 'lost']) }),
  ]),
  /** The run of the owner session recording it; another run's is refused. */
  runEpoch: id,
});
export const CoreOperationLedgerRecordRecoveryResultSchema = z.strictObject({
  /**
   * Null when the work was missing or had already finished, or the run is
   * no longer the ledger's.
   */
  operation: OperationRecordSchema.nullable(),
});

// Streams.

/**
 * Every durable change from `cursor`, or from now. A cursor from another
 * ledger, ahead of it, or older than its retained events ends the stream
 * with `core.operationLedger.snapshotRequired`.
 */
export const CoreOperationLedgerEventsParamsSchema = z.strictObject({
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});
export const CoreOperationLedgerEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});
export const CoreOperationLedgerEventsItemSchema = OperationLedgerEventSchema;
