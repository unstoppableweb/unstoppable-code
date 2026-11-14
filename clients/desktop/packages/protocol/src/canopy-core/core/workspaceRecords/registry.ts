import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyQueryRetryDirectiveSchema,
  type CanopyErrorKind,
} from '../../errors';

/*
 * The trusted W5 record port (W6g, CAN-5498): Electron main's W5 commit-log
 * store over a daemon that hosts the commit log. W5 qualification host only.
 * The web core never registers it: W5 files are host-local, so these names are
 * absent from the web manifest. Kept out of the composed CANOPY_* registries,
 * as the migration exchange is, because only that host composes a handler.
 *
 * Targets name the four W5 file kinds relative to the authority's own root;
 * no structured wire field is a host path. Decisions stay host-local (DQ-7):
 * images and reservation diagnostics are opaque text the caller built, sent to
 * their same-host authority, which never resolves a path inside them.
 * Receipts and reservations (CAN-5506) give keyed callers the in-process
 * store's behavior.
 */

/** Matches core-runtime's `isW5CaptureWorkspaceId`. */
// Historical desktop slugs are ASCII; 255 bytes is the filesystem segment cap.
const WORKSPACE_ID_MAX = 255;
const RESERVED_DEVICE_NAME =
  '(?:[cC][oO][nN]|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][0-9]|[lL][pP][tT][0-9])';
const WORKSPACE_ID_PATTERN = new RegExp(
  `^(?:(?!${RESERVED_DEVICE_NAME}$)[A-Za-z0-9_-]{1,128}|[a-z0-9][a-z0-9-]{0,${WORKSPACE_ID_MAX - 1}})$`,
);

export const CoreWorkspaceRecordsWorkspaceIdSchema = z
  .string()
  .regex(WORKSPACE_ID_PATTERN);

/** One W5 file, by kind, under the authority's W5 root. */
export const CoreWorkspaceRecordsTargetSchema = z.union([
  z.strictObject({ kind: z.literal('index') }),
  z.strictObject({ kind: z.literal('index-backup') }),
  z.strictObject({
    kind: z.literal('manifest'),
    workspaceId: CoreWorkspaceRecordsWorkspaceIdSchema,
  }),
  z.strictObject({
    kind: z.literal('worktrees'),
    workspaceId: CoreWorkspaceRecordsWorkspaceIdSchema,
  }),
]);

const WORKTREE_ID_MAX = 256;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * Well-formed text only: the log stores keys as UTF-8, which turns a lone
 * surrogate into U+FFFD, so its revision would never read back.
 */
export const CoreWorkspaceRecordsWorktreeIdSchema = z
  .string()
  .min(1)
  .max(WORKTREE_ID_MAX)
  .refine((id) => !LONE_SURROGATE.test(id), {
    message: 'Expected a worktree id without lone surrogates',
  });

/** The longest resource key, `worktree:<workspaceId>/<worktreeId>`. */
const RESOURCE_KEY_MAX =
  'worktree:/'.length + WORKSPACE_ID_MAX + WORKTREE_ID_MAX;
/** Matches core-runtime's capture key cap; longer keys refuse the capture. */
const CAPTURE_KEY_MAX = RESOURCE_KEY_MAX;

/**
 * Workspace ids take the capture grammar and worktree ids are well formed, so
 * each accepted resource's revision reads back through capture evidence: the
 * manifest or worktree list selector of that workspace.
 */
export const CoreWorkspaceRecordsResourceSchema = z.union([
  z.strictObject({ kind: z.literal('workspaces') }),
  z.strictObject({
    kind: z.literal('workspace'),
    workspaceId: CoreWorkspaceRecordsWorkspaceIdSchema,
  }),
  z.strictObject({
    kind: z.literal('worktrees'),
    workspaceId: CoreWorkspaceRecordsWorkspaceIdSchema,
  }),
  z.strictObject({
    kind: z.literal('worktree'),
    workspaceId: CoreWorkspaceRecordsWorkspaceIdSchema,
    worktreeId: CoreWorkspaceRecordsWorktreeIdSchema,
  }),
]);

/** Matches core-runtime's `W5_CAPTURE_LIMITS`. */
export const CORE_WORKSPACE_RECORDS_LIMITS = Object.freeze({
  files: 256,
  bytes: 8 * 1024 * 1024,
  evidenceRows: 4096,
  /** A result stays below one 8 MiB frame; a larger capture is refused. */
  resultBytes: 7.5 * 1024 * 1024,
  /** A commit request's encoded params, with headroom for its envelope. */
  requestBytes: 7.5 * 1024 * 1024,
});

const REVISION = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const FINGERPRINT = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
/** Captured keys include ones in-process writers persisted. */
const CAPTURED_REVISIONS = z.record(
  z.string().min(1).max(CAPTURE_KEY_MAX),
  REVISION,
);
/** A commit returns only the keys of the resources it advanced. */
const COMMITTED_REVISIONS = z.record(
  z.string().min(1).max(RESOURCE_KEY_MAX),
  REVISION,
);

const CaptureParamsSchema = z.strictObject({
  files: z
    .array(CoreWorkspaceRecordsTargetSchema)
    .max(CORE_WORKSPACE_RECORDS_LIMITS.files),
  /** Discover both workspace files of each entry in the captured index. */
  discoverWorkspaces: z.boolean(),
});

const ImageSchema = z.strictObject({
  kind: z.enum(['index', 'index-backup', 'manifest', 'worktrees']),
  workspaceId: CoreWorkspaceRecordsWorkspaceIdSchema.optional(),
  state: z.enum(['present', 'absent', 'unreadable']),
  /** The file's exact bytes, when present. */
  base64: z
    .string()
    .max(Math.ceil((CORE_WORKSPACE_RECORDS_LIMITS.bytes * 4) / 3) + 4)
    .optional(),
  reason: z.enum(['unsafe-path', 'not-file', 'io']).optional(),
});

const CaptureResultSchema = z.strictObject({
  files: z.array(ImageSchema).max(CORE_WORKSPACE_RECORDS_LIMITS.files),
  discovery: z.enum([
    'not-requested',
    'complete',
    'unavailable',
    'invalid-index',
  ]),
  log: z.strictObject({
    commitId: REVISION,
    retainedCommits: REVISION,
    unresolvedCommits: REVISION,
    schemaVersion: REVISION,
    revisions: CAPTURED_REVISIONS,
    files: z
      .array(
        z.strictObject({
          file: CoreWorkspaceRecordsTargetSchema,
          commitId: REVISION,
          state: z.enum(['committed', 'applied', 'recovery-required']),
          previousFingerprint: FINGERPRINT,
          newFingerprint: FINGERPRINT,
        }),
      )
      .max(CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows),
    chains: z
      .array(
        z.strictObject({
          file: CoreWorkspaceRecordsTargetSchema,
          decisions: REVISION,
          startsAbsent: z.boolean(),
          discontinuities: REVISION,
        }),
      )
      .max(CORE_WORKSPACE_RECORDS_LIMITS.files),
    resourceRevisionEligibility: z.literal('unproven'),
  }),
});

const RecoveryResultSchema = z.strictObject({
  /** Oldest successful launch heals; every heal is also logged locally. */
  abandoned: z
    .array(
      z.strictObject({
        commitId: REVISION,
        operation: z.string().min(1).max(256),
      }),
    )
    .max(CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows)
    .optional(),
  applied: z.array(REVISION).max(CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows),
  recoveryRequired: z
    .array(REVISION)
    .max(CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows),
  recoveryRequiredDetails: z
    .array(
      z.strictObject({
        commitId: REVISION,
        conflictCount: REVISION,
        writtenFileCount: REVISION,
        unexpectedFailure: z.boolean(),
      }),
    )
    .max(CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows),
  interruptedReservations: REVISION,
  /** Opaque reservation ids; their diagnostics stay off this wire. */
  recoveryRequiredReservations: z
    .array(z.string().min(1).max(256))
    .max(CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows),
});

const OPERATION = z.string().min(1).max(256);
const RESERVATION_ID = z.string().min(1).max(256);

/**
 * A keyed request's identity (CAN-5506): the caller the trusted host composed,
 * its operation and idempotency key, and the fingerprint of its parameters.
 */
const ReceiptSchema = z.strictObject({
  caller: z.string().min(1).max(512),
  operation: OPERATION,
  idempotencyKey: z.string().min(1).max(512),
  fingerprint: z.string().min(1).max(256),
});

/**
 * Reservation diagnostics: opaque JSON text that only Electron's trusted
 * adapter builds and reads, sent to its same-host authority as record images
 * are (DQ-7 reading (i)). It names owned paths, which may lie outside the W5
 * root and so have no target. The authority parses it as JSON, schema-checks
 * an update as the log does, stores it and returns it, but never resolves or
 * projects a path in it, and no `health`/`expose-*` decision rides in it.
 * Above the log's 64 KiB update bound, so the log, not the wire, refuses an
 * oversized update, as in-process.
 */
const DIAGNOSTICS = z.string().max(256 * 1024);

/** Content-free facts about a failed live attempt. */
const FailureDiagnosticsSchema = z.strictObject({
  operation: OPERATION,
  errorName: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .optional(),
});

const CommitParamsSchema = z
  .strictObject({
    /** The commit-log label, unchanged from the in-process store's. */
    operation: OPERATION,
    /** A keyed request's identity; its outcome is recorded with the decision. */
    receipt: ReceiptSchema.optional(),
    /** The reservation this commit completes. */
    reservationId: RESERVATION_ID.optional(),
    expectedRevisions: z
      .array(
        z.strictObject({
          resource: CoreWorkspaceRecordsResourceSchema,
          revision: REVISION,
        }),
      )
      .max(CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows)
      .optional(),
    advance: z
      .array(CoreWorkspaceRecordsResourceSchema)
      .max(CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows),
    /** Full images with the fingerprint each replaces (CAS); `null` removes. */
    files: z
      .array(
        z.strictObject({
          target: CoreWorkspaceRecordsTargetSchema,
          contents: z
            .string()
            .max(CORE_WORKSPACE_RECORDS_LIMITS.bytes)
            .nullable(),
          previousFingerprint: FINGERPRINT,
        }),
      )
      .max(CORE_WORKSPACE_RECORDS_LIMITS.files),
    /** The portable result recorded with the decision. */
    outcome: CanopyJsonValueSchema,
  })
  // A commit names a record, whose ownership the authority checks, or is a
  // keyed decision that records only its receipt or completes a reservation.
  .refine(
    (params) =>
      params.files.length > 0 ||
      params.advance.length > 0 ||
      (params.expectedRevisions?.length ?? 0) > 0 ||
      params.receipt !== undefined ||
      params.reservationId !== undefined,
    {
      message:
        'Expected a commit that names a W5 record, a receipt or a reservation',
    },
  )
  // One frame carries the whole request.
  .refine(
    (params) =>
      new TextEncoder().encode(JSON.stringify(params)).byteLength <=
      CORE_WORKSPACE_RECORDS_LIMITS.requestBytes,
    { message: 'Expected a commit request within one transport frame' },
  );

const CommitResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('applied'),
    commitId: REVISION,
    revisions: COMMITTED_REVISIONS,
  }),
  /** Decided, but its files did not apply; later writes to them are fenced. */
  z.strictObject({
    status: z.literal('recovery-required'),
    commitId: REVISION,
    revisions: COMMITTED_REVISIONS,
    conflictCount: REVISION,
    writtenFileCount: REVISION,
    unexpectedFailure: z.boolean(),
  }),
  /** A keyed request seen before: its saved outcome, with no new decision. */
  z.strictObject({
    status: z.literal('replayed'),
    commitId: REVISION,
    outcome: CanopyJsonValueSchema,
  }),
  /** A keyed request already completed whose saved outcome expired. */
  z.strictObject({ status: z.literal('replay-expired'), commitId: REVISION }),
]);

const ReceiptLookupParamsSchema = z.strictObject({ receipt: ReceiptSchema });

/** What a keyed request does before any effect (the keyed-receipt model). */
const ReceiptLookupResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('none') }),
  z.strictObject({
    status: z.literal('replay'),
    commitId: REVISION,
    outcome: CanopyJsonValueSchema,
  }),
  z.strictObject({ status: z.literal('replay-expired'), commitId: REVISION }),
  /** Its decision never reached its files; path-free counts only. */
  z.strictObject({
    status: z.literal('commit-recovery-required'),
    commitId: REVISION,
    conflictCount: REVISION,
    writtenFileCount: REVISION,
    unexpectedFailure: z.boolean(),
  }),
  z.strictObject({ status: z.literal('key-reused') }),
  z.strictObject({
    status: z.literal('in-progress'),
    reservationId: RESERVATION_ID,
  }),
  z.strictObject({
    status: z.literal('recovery-required'),
    reservationId: RESERVATION_ID,
    diagnostics: DIAGNOSTICS,
  }),
]);

const ReservationListResultSchema = z
  .strictObject({
    reservations: z
      .array(
        z.strictObject({
          reservationId: RESERVATION_ID,
          operation: OPERATION,
          state: z.enum(['reserved', 'recovery-required']),
          diagnostics: DIAGNOSTICS,
        }),
      )
      .max(CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows),
  })
  // One frame carries the whole list; a longer one is refused.
  .refine(
    (result) =>
      new TextEncoder().encode(JSON.stringify(result)).byteLength <=
      CORE_WORKSPACE_RECORDS_LIMITS.resultBytes,
    { message: 'Expected a reservation list within one transport frame' },
  );

const ReserveParamsSchema = z.strictObject({
  workspaceIdentity: CoreWorkspaceRecordsWorkspaceIdSchema.optional(),
  expectedWorkspaceRecords: z
    .strictObject({
      manifest: FINGERPRINT,
      worktrees: FINGERPRINT,
    })
    .optional(),
  reservationId: RESERVATION_ID,
  operation: OPERATION,
  receipt: ReceiptSchema.optional(),
  diagnostics: DIAGNOSTICS.optional(),
});

const UpdateDiagnosticsParamsSchema = z.strictObject({
  reservationId: RESERVATION_ID,
  diagnostics: DIAGNOSTICS,
});

const ReservationParamsSchema = z.strictObject({
  reservationId: RESERVATION_ID,
});

const MarkRecoveryRequiredParamsSchema = z.strictObject({
  reservationId: RESERVATION_ID,
  diagnostics: FailureDiagnosticsSchema,
});

const NO_RESULT = z.strictObject({});

/** Each operation-specific code with the one kind it is always sent with. */
export const CORE_WORKSPACE_RECORDS_ERROR_KINDS = {
  'core.workspaceRecords.identityConflict': 'conflict',
  /** A target changed since the caller's read; nothing was decided. */
  'core.workspaceRecords.fingerprintConflict': 'conflict',
  /** An expected revision moved; nothing was decided. */
  'core.workspaceRecords.revisionConflict': 'conflict',
  'core.workspaceRecords.recoveryRequired': 'failed_precondition',
  /** A target has a decided change that has not applied. */
  'core.workspaceRecords.unappliedChange': 'failed_precondition',
  'core.workspaceRecords.invalidState': 'failed_precondition',
  /** The capture cannot be served; `details.capture` says why. */
  'core.workspaceRecords.captureRefused': 'failed_precondition',
  /** Storage ownership refuses the daemon writer. */
  'core.workspaceRecords.writeRefused': 'permission_denied',
  /** The commit log cannot be opened or used; nothing was decided. */
  'core.workspaceRecords.logUnavailable': 'unavailable',
  /** The idempotency key belongs to another request or reservation (CAN-5506). */
  'core.workspaceRecords.keyReused': 'already_exists',
  /** The keyed request completed; its saved outcome expired. */
  'core.workspaceRecords.outcomeExpired': 'failed_precondition',
  /** Another attempt with the same key is still reserved. */
  'core.workspaceRecords.inProgress': 'failed_precondition',
  /** The commit names a reservation that is not held. */
  'core.workspaceRecords.unknownReservation': 'not_found',
} as const satisfies Record<string, CanopyErrorKind>;

export type CoreWorkspaceRecordsErrorCode =
  keyof typeof CORE_WORKSPACE_RECORDS_ERROR_KINDS;

const CODE = z.enum([
  'core.workspaceRecords.identityConflict',
  'core.workspaceRecords.fingerprintConflict',
  'core.workspaceRecords.revisionConflict',
  'core.workspaceRecords.recoveryRequired',
  'core.workspaceRecords.unappliedChange',
  'core.workspaceRecords.invalidState',
  'core.workspaceRecords.captureRefused',
  'core.workspaceRecords.writeRefused',
  'core.workspaceRecords.logUnavailable',
  'core.workspaceRecords.keyReused',
  'core.workspaceRecords.outcomeExpired',
  'core.workspaceRecords.inProgress',
  'core.workspaceRecords.unknownReservation',
]);

const readError = CanopyErrorPayloadSchema.extend({
  code: CODE.optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
const writeError = CanopyErrorPayloadSchema.extend({
  code: CODE.optional(),
}).refine(
  (error): boolean => {
    if (
      error.code !== 'core.workspaceRecords.identityConflict' ||
      typeof error.details !== 'object' ||
      error.details === null ||
      Array.isArray(error.details) ||
      !('workspaceIdentity' in error.details)
    )
      return true;
    return CoreWorkspaceRecordsWorkspaceIdSchema.safeParse(
      error.details.workspaceIdentity,
    ).success;
  },
  {
    message: 'Expected a path-free workspace identity',
    path: ['details', 'workspaceIdentity'],
  },
);

export const CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.workspaceRecords.capture': defineCanopyQuery({
      plane: 'core',
      domain: 'workspaceRecords',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.workspaceRecords.read'],
      params: CaptureParamsSchema,
      result: CaptureResultSchema,
      error: readError,
    }),
    'core.workspaceRecords.recovery.get': defineCanopyQuery({
      plane: 'core',
      domain: 'workspaceRecords',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.workspaceRecords.read'],
      params: z.strictObject({}),
      result: RecoveryResultSchema,
      error: readError,
    }),
    // Keyed admission before any effect (CAN-5506).
    'core.workspaceRecords.receipt.lookup': defineCanopyQuery({
      plane: 'core',
      domain: 'workspaceRecords',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.workspaceRecords.read'],
      params: ReceiptLookupParamsSchema,
      result: ReceiptLookupResultSchema,
      error: readError,
    }),
    'core.workspaceRecords.reservation.list': defineCanopyQuery({
      plane: 'core',
      domain: 'workspaceRecords',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.workspaceRecords.read'],
      params: z.strictObject({}),
      result: ReservationListResultSchema,
      error: readError,
    }),
  });

export const CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.workspaceRecords.commit': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspaceRecords',
      version: 1,
      placement: 'core-only',
      // No envelope key: a lost response is uncertain and never retried. A
      // keyed caller replays through `receipt.lookup` (CAN-5506).
      idempotency: 'none',
      requiredGrants: ['core.workspaceRecords.write'],
      params: CommitParamsSchema,
      result: CommitResultSchema,
      error: writeError,
    }),
    // Reservations (CAN-5506): none is safe to repeat, so a lost response is
    // uncertain and never retried; launch recovery is the fallback.
    'core.workspaceRecords.reservation.reserve': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspaceRecords',
      version: 1,
      placement: 'core-only',
      idempotency: 'none',
      requiredGrants: ['core.workspaceRecords.write'],
      params: ReserveParamsSchema,
      result: NO_RESULT,
      error: writeError,
    }),
    'core.workspaceRecords.reservation.updateDiagnostics':
      defineCanopyInstruction({
        plane: 'core',
        domain: 'workspaceRecords',
        version: 1,
        placement: 'core-only',
        idempotency: 'none',
        requiredGrants: ['core.workspaceRecords.write'],
        params: UpdateDiagnosticsParamsSchema,
        result: NO_RESULT,
        error: writeError,
      }),
    'core.workspaceRecords.reservation.release': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspaceRecords',
      version: 1,
      placement: 'core-only',
      idempotency: 'none',
      requiredGrants: ['core.workspaceRecords.write'],
      params: ReservationParamsSchema,
      result: NO_RESULT,
      error: writeError,
    }),
    'core.workspaceRecords.reservation.markRecoveryRequired':
      defineCanopyInstruction({
        plane: 'core',
        domain: 'workspaceRecords',
        version: 1,
        placement: 'core-only',
        idempotency: 'none',
        requiredGrants: ['core.workspaceRecords.write'],
        params: MarkRecoveryRequiredParamsSchema,
        result: NO_RESULT,
        error: writeError,
      }),
  });

export type CoreWorkspaceRecordsTarget = z.output<
  typeof CoreWorkspaceRecordsTargetSchema
>;
export type CoreWorkspaceRecordsCaptureResult = z.output<
  typeof CaptureResultSchema
>;
export type CoreWorkspaceRecordsCommitParams = z.input<
  typeof CommitParamsSchema
>;
export type CoreWorkspaceRecordsCommitResult = z.output<
  typeof CommitResultSchema
>;
export type CoreWorkspaceRecordsRecovery = z.output<
  typeof RecoveryResultSchema
>;
export type CoreWorkspaceRecordsReceipt = z.output<typeof ReceiptSchema>;
export type CoreWorkspaceRecordsReceiptLookup = z.output<
  typeof ReceiptLookupResultSchema
>;
export type CoreWorkspaceRecordsReservationList = z.output<
  typeof ReservationListResultSchema
>;
export type CoreWorkspaceRecordsReserveParams = z.input<
  typeof ReserveParamsSchema
>;
export type CoreWorkspaceRecordsFailureDiagnostics = z.output<
  typeof FailureDiagnosticsSchema
>;
