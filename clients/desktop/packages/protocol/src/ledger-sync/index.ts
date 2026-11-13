import { z } from 'zod';
import { LEDGER_LIMITS } from '../canopy-core/core/ledger/limits';
import {
  LEDGER_ATTRIBUTION_KINDS,
  LEDGER_ENTRY_TYPES,
  LEDGER_V1_ENTRY_TYPES,
  LEDGER_STATUSES,
  LedgerActorFilterSchema,
  LedgerActorLabelSchema,
  LedgerActorRefSchema,
  LedgerAttributionKindSchema,
  LedgerCursorSchema,
  LedgerDisplayNameSchema,
  LedgerEntrySchema,
  LedgerEntrySearchItemSchema,
  LedgerEntryTypeSchema,
  LedgerGlobalOwnerSchema,
  LedgerMutationSchema,
  LedgerV1EntrySchema,
  LedgerV1EntrySearchItemSchema,
  LedgerV1EntryTypeSchema,
  LedgerV1MutationSchema,
  LedgerOpaqueIdSchema,
  LedgerOrganizationIdSchema,
  LedgerScopeRefSchema,
  LedgerSearchQuerySchema,
  LedgerSearchSortSchema,
  LedgerSequenceSchema,
  LedgerSourceAvailabilitySchema,
  LedgerStatusSchema,
  LedgerTimeFilterSchema,
  LedgerTimestampSchema,
  LedgerUuidSchema,
} from '../canopy-core/core/ledger/schemas';
import { containsDisallowedControlCharacters } from '../canopy-core/core/ledger/text';

/*
 * The wire contract between a desktop that owns Ledger scopes and the web
 * mirror (`/api/v1/ledger/*`). A desktop registers each scope it syncs, with
 * its writer session and the audience its summary sharing resolves to, then
 * pushes the scope's outbox events in contiguous batches. Readers search the
 * mirror for their own entries on every device and, where an organization can
 * read a scope, their teammates' entries.
 *
 * The server trusts no submitted organization: it recomputes the audience from
 * the tracked workspace and live membership. Event payloads are the desktop's
 * canonical outbox payloads, hashed with `toLedgerCanonicalJson`.
 *
 * Task scopes sync at schema version 1. Global (workflow) scopes sync at
 * version 2, only to a mirror that advertises `ledger-global-v1`; a request's
 * version must match its scope kind, and one push never mixes versions. A
 * batch that carries anything versions 1 and 2 cannot (an operation, a parent,
 * a parent change or a `leftOpen` reason) syncs at version 3 for a task scope
 * and version 4 for a global scope.
 */

export const LEDGER_SYNC_SCHEMA_VERSION = 1;
export const LEDGER_SYNC_GLOBAL_SCHEMA_VERSION = 2;

/**
 * Mirror reads negotiate their version with this header. A read without it is
 * version 1 and never sees a global scope: older readers parse scope kinds
 * strictly. The negotiated version is part of a search cursor's identity.
 */
export const LEDGER_MIRROR_VERSION_HEADER = 'X-Canopy-Ledger-Version';
export const LEDGER_MIRROR_READ_VERSIONS = [1, 2] as const;
export type LedgerMirrorReadVersion =
  (typeof LEDGER_MIRROR_READ_VERSIONS)[number];
export const LEDGER_MIRROR_GLOBAL_READ_VERSION = 2;

/** The read version a header value names; anything else reads as version 1. */
export function parseLedgerMirrorReadVersion(
  value: string | null | undefined,
): LedgerMirrorReadVersion {
  return value?.trim() === String(LEDGER_MIRROR_GLOBAL_READ_VERSION) ? 2 : 1;
}

/**
 * The versions of a push batch that carries anything versions 1 and 2 cannot:
 * an operation, a parent, a parent change or a `leftOpen` reason, for a task
 * scope and a global scope. A desktop sends one only for such a batch; a
 * mirror that predates it refuses the batch, and the desktop holds that scope
 * until the mirror accepts.
 */
export const LEDGER_SYNC_OPERATIONS_SCHEMA_VERSION = 3;
export const LEDGER_SYNC_GLOBAL_OPERATIONS_SCHEMA_VERSION = 4;

export type LedgerSyncPushVersion =
  | typeof LEDGER_SYNC_SCHEMA_VERSION
  | typeof LEDGER_SYNC_GLOBAL_SCHEMA_VERSION
  | typeof LEDGER_SYNC_OPERATIONS_SCHEMA_VERSION
  | typeof LEDGER_SYNC_GLOBAL_OPERATIONS_SCHEMA_VERSION;

/** The push version for a scope kind and whether the batch carries operations. */
export function ledgerSyncPushVersion(
  global: boolean,
  operations: boolean,
): LedgerSyncPushVersion {
  if (global) {
    return operations
      ? LEDGER_SYNC_GLOBAL_OPERATIONS_SCHEMA_VERSION
      : LEDGER_SYNC_GLOBAL_SCHEMA_VERSION;
  }
  return operations
    ? LEDGER_SYNC_OPERATIONS_SCHEMA_VERSION
    : LEDGER_SYNC_SCHEMA_VERSION;
}

/** Whether a push version belongs to a global scope. */
export function isLedgerSyncGlobalVersion(version: number): boolean {
  return (
    version === LEDGER_SYNC_GLOBAL_SCHEMA_VERSION ||
    version === LEDGER_SYNC_GLOBAL_OPERATIONS_SCHEMA_VERSION
  );
}

/** Whether a push version may carry operations, parents and `leftOpen`. */
export function isLedgerSyncOperationsVersion(version: number): boolean {
  return (
    version === LEDGER_SYNC_OPERATIONS_SCHEMA_VERSION ||
    version === LEDGER_SYNC_GLOBAL_OPERATIONS_SCHEMA_VERSION
  );
}

/**
 * Mirror reads return operations and parents only to a client that asks with
 * this header. A header rather than a body field, because a mirror that
 * predates them parses request bodies strictly but ignores unknown headers.
 */
export const LEDGER_MIRROR_CAPABILITIES_HEADER = 'X-Canopy-Ledger-Capabilities';
export const LEDGER_MIRROR_OPERATIONS_CAPABILITY = 'operations';

/** Whether a capabilities header value (comma-separated tokens) asks for operations. */
export function hasLedgerMirrorOperationsCapability(
  value: string | null | undefined,
): boolean {
  if (value === null || value === undefined) return false;
  return value
    .split(',')
    .some(
      (token) =>
        token.trim().toLowerCase() === LEDGER_MIRROR_OPERATIONS_CAPABILITY,
    );
}

export const LEDGER_SYNC_LIMITS = {
  /** Events in one push; the batch is applied or rejected as a whole. */
  pushEventsMax: 100,
  /** UTF-8 bytes of one push request. */
  pushRequestMaxBytes: 512 * 1024,
  /** UTF-8 bytes of a register, search or entry request. */
  requestMaxBytes: 16 * 1024,
  deviceIdMaxLength: 128,
  /**
   * The desktop's own ceiling for an installation generation: a signed 32-bit
   * integer, which is how the mirror stores it.
   */
  installationGenerationMax: 2_147_483_647,
  originKeyMaxCodePoints: 1_024,
  /** An organization audience lasts this long after each registration. */
  audienceLeaseMs: 72 * 60 * 60 * 1000,
  /** How often an online desktop reconfirms an organization audience. */
  audienceReconfirmMs: 6 * 60 * 60 * 1000,
  searchCursorLifetimeMs: LEDGER_LIMITS.cursorLifetimeMs,
  historyPageMax: LEDGER_LIMITS.historyPageMax,
} as const;

/** Error codes the mirror answers with, beside generic HTTP failures. */
export const LEDGER_SYNC_ERROR_CODES = [
  /** The request did not match the contract. */
  'ledger_invalid_request',
  /** Ingest is switched off; retry later without dropping the outbox. */
  'ledger_ingest_disabled',
  /** A `summaries` prohibition in one of the owner's organizations. */
  'ledger_scope_prohibited',
  /** The named tracked workspace cannot carry an organization audience. */
  'ledger_audience_forbidden',
  /** The request names another account than the scope is bound to. */
  'ledger_stale_binding',
  /** Another writer session registered the scope since this one did. */
  'ledger_stale_writer',
  /** The scope is not registered for this account. */
  'ledger_scope_not_registered',
  /** The batch does not continue from the acknowledged sequence. */
  'ledger_sequence_gap',
  /** An event reuses an identity or sequence with different content. */
  'ledger_divergent_event',
  /** An event breaks the Ledger's history rules. */
  'ledger_illegal_event',
  /** A search cursor outlived its ten minutes or another search. */
  'ledger_cursor_expired',
  /** No entry this caller can read has that ID. */
  'ledger_not_found',
] as const;
export const LedgerSyncErrorCodeSchema = z.enum(LEDGER_SYNC_ERROR_CODES);
export type LedgerSyncErrorCode = z.output<typeof LedgerSyncErrorCodeSchema>;

/** What the desktop should do after an error. */
export const LedgerSyncRetrySchema = z.enum([
  /** Try the same request again later. */
  'later',
  /** Register the scope again, then retry. */
  'after_register',
  /** Do not retry; the scope needs repair or a policy change. */
  'never',
]);
export type LedgerSyncRetry = z.output<typeof LedgerSyncRetrySchema>;

export const LedgerSyncErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: LedgerSyncErrorCodeSchema,
    message: z.string().max(512),
    retry: LedgerSyncRetrySchema,
    /** For a gap: the sequence the next new event must carry. */
    expectedSequence: LedgerSequenceSchema.optional(),
  }),
});
export type LedgerSyncErrorResponse = z.output<
  typeof LedgerSyncErrorResponseSchema
>;

export const LEDGER_TASK_SCOPE_KINDS = [
  'code_worktree',
  'cowork_entry',
  'advisor_entry',
] as const;
export const LedgerTaskScopeKindSchema = z.enum(LEDGER_TASK_SCOPE_KINDS);
export type LedgerTaskScopeKind = z.output<typeof LedgerTaskScopeKindSchema>;

export const LEDGER_SCOPE_KINDS = [
  ...LEDGER_TASK_SCOPE_KINDS,
  'global',
] as const;
export const LedgerScopeKindSchema = z.enum(LEDGER_SCOPE_KINDS);
export type LedgerScopeKind = z.output<typeof LedgerScopeKindSchema>;

/** A portal device ID: an identifier, so it holds no control character. */
export const LedgerDeviceIdSchema = z
  .string()
  .min(1)
  .max(LEDGER_SYNC_LIMITS.deviceIdMaxLength)
  .refine(
    (value: string): boolean =>
      !containsDisallowedControlCharacters(value, { allowLineBreaks: false }),
    'Expected a device ID without control characters',
  );

/**
 * One launch of a desktop writer: the portal device, the installation's
 * generation and a nonce minted for the launch. Each registration from a new
 * session supersedes the previous one.
 */
export const LedgerWriterSessionSchema = z.strictObject({
  deviceId: LedgerDeviceIdSchema,
  installationGeneration: z
    .int()
    .min(0)
    .max(LEDGER_SYNC_LIMITS.installationGenerationMax),
  nonce: LedgerUuidSchema,
});
export type LedgerWriterSession = z.output<typeof LedgerWriterSessionSchema>;

/** A writer epoch: a decimal counter the mirror mints per writer session. */
export const LedgerWriterEpochSchema = z.string().regex(/^[1-9][0-9]{0,15}$/);

const LedgerPrivateAudienceSchema = z.strictObject({
  kind: z.literal('private'),
});

/** A task scope's audience: private, or its tracked workspace's organization. */
export const LedgerRequestedTaskAudienceSchema = z.discriminatedUnion('kind', [
  LedgerPrivateAudienceSchema,
  z.strictObject({
    kind: z.literal('organization'),
    trackedWorkspaceId: LedgerUuidSchema,
  }),
]);

/**
 * A global scope's audience: private, or its owning organization's current
 * members. The server grants the organization only while the writer is a
 * member, and only when it is the scope's pinned owner.
 */
export const LedgerRequestedGlobalAudienceSchema = z.discriminatedUnion(
  'kind',
  [
    LedgerPrivateAudienceSchema,
    z.strictObject({
      kind: z.literal('organization_global'),
      organizationId: LedgerOrganizationIdSchema,
    }),
  ],
);
export type LedgerRequestedTaskAudience = z.output<
  typeof LedgerRequestedTaskAudienceSchema
>;
export type LedgerRequestedGlobalAudience = z.output<
  typeof LedgerRequestedGlobalAudienceSchema
>;

/** The audience the desktop's summary sharing resolves to for a scope. */
export const LedgerRequestedAudienceSchema = z.discriminatedUnion('kind', [
  LedgerPrivateAudienceSchema,
  z.strictObject({
    kind: z.literal('organization'),
    trackedWorkspaceId: LedgerUuidSchema,
  }),
  z.strictObject({
    kind: z.literal('organization_global'),
    organizationId: LedgerOrganizationIdSchema,
  }),
]);
export type LedgerRequestedAudience = z.output<
  typeof LedgerRequestedAudienceSchema
>;

/** Fields every registration carries, in the order version 1 sends them. */
const ledgerScopeRegisterFields = {
  ledgerId: LedgerUuidSchema,
  /** The account the desktop bound the scope to: the user's external ID. */
  accountId: LedgerUuidSchema,
} as const;
const ledgerScopeRegisterSessionFields = {
  session: LedgerWriterSessionSchema,
  /**
   * The epoch this session already holds, on every registration after its
   * first. A session that was superseded is refused rather than resumed.
   */
  writerEpoch: LedgerWriterEpochSchema.optional(),
} as const;

export const LedgerTaskScopeRegisterRequestSchema = z.strictObject({
  schemaVersion: z.literal(LEDGER_SYNC_SCHEMA_VERSION),
  ...ledgerScopeRegisterFields,
  scopeKind: LedgerTaskScopeKindSchema,
  ...ledgerScopeRegisterSessionFields,
  audience: LedgerRequestedTaskAudienceSchema,
});
export type LedgerTaskScopeRegisterRequest = z.output<
  typeof LedgerTaskScopeRegisterRequestSchema
>;

/**
 * A global scope's registration. `globalOwner` is the owner the writer
 * claims; the first registration pins it, including a private one, and no
 * later registration can change it.
 */
export const LedgerGlobalScopeRegisterRequestSchema = z.strictObject({
  schemaVersion: z.literal(LEDGER_SYNC_GLOBAL_SCHEMA_VERSION),
  ...ledgerScopeRegisterFields,
  scopeKind: z.literal('global'),
  globalOwner: LedgerGlobalOwnerSchema,
  ...ledgerScopeRegisterSessionFields,
  audience: LedgerRequestedGlobalAudienceSchema,
});
export type LedgerGlobalScopeRegisterRequest = z.output<
  typeof LedgerGlobalScopeRegisterRequestSchema
>;

export const LedgerScopeRegisterRequestSchema = z.discriminatedUnion(
  'schemaVersion',
  [
    LedgerTaskScopeRegisterRequestSchema,
    LedgerGlobalScopeRegisterRequestSchema,
  ],
);
export type LedgerScopeRegisterRequest = z.output<
  typeof LedgerScopeRegisterRequestSchema
>;

/** The audience the mirror applied: private, or an organization lease. */
export const LedgerScopeAudienceSchema = z.discriminatedUnion('kind', [
  LedgerPrivateAudienceSchema,
  z.strictObject({
    kind: z.literal('organization'),
    organizationId: LedgerUuidSchema,
    trackedWorkspaceId: LedgerUuidSchema,
    expiresAt: LedgerTimestampSchema,
  }),
  z.strictObject({
    kind: z.literal('organization_global'),
    organizationId: LedgerOrganizationIdSchema,
    expiresAt: LedgerTimestampSchema,
  }),
]);
export type LedgerScopeAudience = z.output<typeof LedgerScopeAudienceSchema>;

export const LedgerScopeRegisterResponseSchema = z.strictObject({
  ledgerId: LedgerUuidSchema,
  writerEpoch: LedgerWriterEpochSchema,
  /** The highest contiguous scope sequence the mirror holds; "0" for none. */
  acknowledgedSequence: LedgerSequenceSchema,
  audience: LedgerScopeAudienceSchema,
});
export type LedgerScopeRegisterResponse = z.output<
  typeof LedgerScopeRegisterResponseSchema
>;

export const LEDGER_SYNC_EVENT_KINDS = [
  'scope_registered',
  'actor_registered',
  'entry_revision',
  'scope_archived',
  'scope_restored',
] as const;
export const LedgerSyncEventKindSchema = z.enum(LEDGER_SYNC_EVENT_KINDS);
export type LedgerSyncEventKind = z.output<typeof LedgerSyncEventKindSchema>;

const LedgerOriginKeySchema = z
  .string()
  .min(1)
  .refine(
    (value: string): boolean =>
      Array.from(value).length <= LEDGER_SYNC_LIMITS.originKeyMaxCodePoints &&
      !containsDisallowedControlCharacters(value, { allowLineBreaks: false }),
    'Expected an origin key without control characters',
  );

/** The scope's first event: where it lives and the account it bound. */
export const LedgerScopeRegisteredPayloadSchema = z.strictObject({
  scope: LedgerScopeRefSchema,
  containerCreatedAt: LedgerTimestampSchema,
  accountId: LedgerOpaqueIdSchema.nullable(),
});

export const LedgerActorRegisteredPayloadSchema = z.strictObject({
  actor: LedgerActorRefSchema,
  originKey: LedgerOriginKeySchema,
  displayName: LedgerDisplayNameSchema,
});

export const LedgerEntryRevisionPayloadSchema = z.strictObject({
  entry: LedgerV1EntrySchema,
  mutation: LedgerV1MutationSchema,
  /** Present on a published Summary. */
  publication: z.strictObject({ sourceTruncated: z.boolean() }).optional(),
});

/** An entry revision in a version 2 batch: it may carry the new fields. */
export const LedgerEntryRevisionPayloadV2Schema = z.strictObject({
  entry: LedgerEntrySchema,
  mutation: LedgerMutationSchema,
  publication: z.strictObject({ sourceTruncated: z.boolean() }).optional(),
});
export type LedgerEntryRevisionPayloadV2 = z.output<
  typeof LedgerEntryRevisionPayloadV2Schema
>;

/** Whether a revision carries a field a version 1 batch cannot. */
export function ledgerEntryRevisionNeedsV2(
  payload: LedgerEntryRevisionPayloadV2,
): boolean {
  const { entry, mutation } = payload;
  return (
    entry.type === 'OPERATION' ||
    entry.parentEntryId !== undefined ||
    mutation.parent !== undefined ||
    mutation.leftOpen !== undefined
  );
}

/** An archive or a restore, naming where the scope now lives. */
export const LedgerScopeLifecyclePayloadSchema = z.strictObject({
  scope: LedgerScopeRefSchema,
  containerCreatedAt: LedgerTimestampSchema,
});

const LedgerPayloadHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * One outbox event. The payload stays raw JSON on the wire: the mirror checks
 * `payloadHash` against its canonical serialization, then parses it by kind.
 */
export const LedgerSyncEventSchema = z.strictObject({
  eventId: LedgerUuidSchema,
  scopeSequence: LedgerSequenceSchema,
  kind: LedgerSyncEventKindSchema,
  entryId: LedgerUuidSchema.nullable(),
  entryRevision: z.int().min(1).nullable(),
  occurredAt: LedgerTimestampSchema,
  payloadHash: LedgerPayloadHashSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type LedgerSyncEvent = z.output<typeof LedgerSyncEventSchema>;

export const LedgerSyncPushRequestSchema = z.strictObject({
  /**
   * Version 1 for a task scope, version 2 for a global scope, and 3 or 4 for
   * a batch of either that carries operations; the mirror refuses a version
   * that does not match the registered scope's kind.
   */
  schemaVersion: z.union([
    z.literal(LEDGER_SYNC_SCHEMA_VERSION),
    z.literal(LEDGER_SYNC_GLOBAL_SCHEMA_VERSION),
    z.literal(LEDGER_SYNC_OPERATIONS_SCHEMA_VERSION),
    z.literal(LEDGER_SYNC_GLOBAL_OPERATIONS_SCHEMA_VERSION),
  ]),
  ledgerId: LedgerUuidSchema,
  accountId: LedgerUuidSchema,
  writerEpoch: LedgerWriterEpochSchema,
  /** The sequence the desktop last saw acknowledged. */
  acknowledgedSequence: LedgerSequenceSchema,
  events: z
    .array(LedgerSyncEventSchema)
    .min(1)
    .max(LEDGER_SYNC_LIMITS.pushEventsMax),
});
export type LedgerSyncPushRequest = z.output<
  typeof LedgerSyncPushRequestSchema
>;

export const LedgerSyncPushResponseSchema = z.strictObject({
  ledgerId: LedgerUuidSchema,
  acknowledgedSequence: LedgerSequenceSchema,
  /** Events applied by this request. */
  applied: z.int().min(0),
  /** Events the mirror already held, matched exactly. */
  replayed: z.int().min(0),
});
export type LedgerSyncPushResponse = z.output<
  typeof LedgerSyncPushResponseSchema
>;

/** Whose entries a mirror search reads. */
export const LEDGER_MIRROR_AUDIENCES = ['mine', 'teammates'] as const;
export const LedgerMirrorAudienceSchema = z.enum(LEDGER_MIRROR_AUDIENCES);
export type LedgerMirrorAudience = z.output<typeof LedgerMirrorAudienceSchema>;

/**
 * The local search filters plus the mirror's own: whose entries, one device of
 * the caller's, and archived scopes. `owner: 'self'` and `author: 'self'` mean
 * the caller's own user actor.
 */
export const LedgerMirrorSearchRequestSchema = z.strictObject({
  audience: LedgerMirrorAudienceSchema.optional(),
  /** Only the caller's scopes written from this portal device. */
  deviceId: LedgerDeviceIdSchema.optional(),
  includeArchived: z.boolean().optional(),
  query: LedgerSearchQuerySchema.optional(),
  entryIds: z
    .array(LedgerUuidSchema)
    .min(1)
    .max(LEDGER_LIMITS.searchEntryIdsMax)
    .optional(),
  owner: LedgerActorFilterSchema.optional(),
  author: LedgerActorFilterSchema.optional(),
  types: z
    .array(LedgerV1EntryTypeSchema)
    .min(1)
    .max(LEDGER_V1_ENTRY_TYPES.length)
    .optional(),
  statuses: z
    .array(LedgerStatusSchema)
    .min(1)
    .max(LEDGER_STATUSES.length)
    .optional(),
  attribution: z
    .array(LedgerAttributionKindSchema)
    .min(1)
    .max(LEDGER_ATTRIBUTION_KINDS.length)
    .optional(),
  createdAfter: LedgerTimeFilterSchema.optional(),
  createdBefore: LedgerTimeFilterSchema.optional(),
  updatedAfter: LedgerTimeFilterSchema.optional(),
  updatedBefore: LedgerTimeFilterSchema.optional(),
  sort: LedgerSearchSortSchema.optional(),
  limit: z.int().min(1).max(LEDGER_LIMITS.searchPageMax).optional(),
  cursor: LedgerCursorSchema.optional(),
});
export type LedgerMirrorSearchRequest = z.output<
  typeof LedgerMirrorSearchRequestSchema
>;

/** A search from a client that sent the operations capability. */
export const LedgerMirrorSearchRequestV2Schema =
  LedgerMirrorSearchRequestSchema.extend({
    types: z
      .array(LedgerEntryTypeSchema)
      .min(1)
      .max(LEDGER_ENTRY_TYPES.length)
      .optional(),
    /** That entry's direct children; `null` for entries with no parent. */
    parentEntryId: LedgerUuidSchema.nullable().optional(),
    /** That top-level entry and everything under it. */
    rootEntryId: LedgerUuidSchema.optional(),
  });
export type LedgerMirrorSearchRequestV2 = z.output<
  typeof LedgerMirrorSearchRequestV2Schema
>;

/** Where a mirrored entry was written. */
export const LedgerMirrorSourceSchema = z.discriminatedUnion('kind', [
  /** One of the caller's devices. */
  z.strictObject({
    kind: z.literal('mine'),
    deviceId: LedgerDeviceIdSchema,
    deviceLabel: z.string().min(1).max(256),
  }),
  /** A teammate's scope that an organization of the caller can read. */
  z.strictObject({
    kind: z.literal('teammate'),
    teammateName: z.string().min(1).max(256),
    organizationId: LedgerUuidSchema,
    organizationName: z.string().min(1).max(256),
  }),
]);
export type LedgerMirrorSource = z.output<typeof LedgerMirrorSourceSchema>;

/**
 * A global scope's owner on a version-2 row. `organizationName` is present
 * only when the reader may see the organization; without it a reader labels
 * the row by its kind of work alone.
 */
const LedgerMirrorGlobalFieldsShape = {
  globalOwner: LedgerGlobalOwnerSchema.optional(),
  organizationName: z.string().min(1).max(256).optional(),
};

/** A search item from a mirrored scope, with the scope and its source. */
export const LedgerMirrorEntrySchema = LedgerV1EntrySearchItemSchema.omit({
  // A row the mirror returns is mirrored by definition.
  syncState: true,
  // Only the device that owns an entry names what its source opens as.
  sourceKind: true,
}).extend({
  ledgerId: LedgerUuidSchema,
  scopeKind: LedgerScopeKindSchema,
  scopeArchived: z.boolean(),
  source: LedgerMirrorSourceSchema,
  ...LedgerMirrorGlobalFieldsShape,
});
export type LedgerMirrorEntry = z.output<typeof LedgerMirrorEntrySchema>;

/** A search item for a client that sent the operations capability. */
export const LedgerMirrorEntryV2Schema = LedgerEntrySearchItemSchema.omit({
  syncState: true,
  sourceKind: true,
}).extend({
  ledgerId: LedgerUuidSchema,
  scopeKind: LedgerScopeKindSchema,
  scopeArchived: z.boolean(),
  source: LedgerMirrorSourceSchema,
  ...LedgerMirrorGlobalFieldsShape,
});
export type LedgerMirrorEntryV2 = z.output<typeof LedgerMirrorEntryV2Schema>;

/** An actor label within one scope; actor IDs are unique per scope. */
export const LedgerMirrorActorLabelSchema = LedgerActorLabelSchema.extend({
  ledgerId: LedgerUuidSchema,
});
export type LedgerMirrorActorLabel = z.output<
  typeof LedgerMirrorActorLabelSchema
>;

export const LedgerMirrorSearchResponseSchema = z.strictObject({
  entries: z.array(LedgerMirrorEntrySchema).max(LEDGER_LIMITS.searchPageMax),
  actors: z
    .array(LedgerMirrorActorLabelSchema)
    .max(LEDGER_LIMITS.actorLabelsMax),
  /**
   * Opaque. It carries the snapshot the first page captured, which later
   * pages read at or below; the snapshot itself is never returned.
   */
  nextCursor: LedgerCursorSchema.nullable(),
  hasMore: z.boolean(),
});
export type LedgerMirrorSearchResponse = z.output<
  typeof LedgerMirrorSearchResponseSchema
>;

export const LedgerMirrorSearchResponseV2Schema =
  LedgerMirrorSearchResponseSchema.extend({
    entries: z
      .array(LedgerMirrorEntryV2Schema)
      .max(LEDGER_LIMITS.searchPageMax),
  });
export type LedgerMirrorSearchResponseV2 = z.output<
  typeof LedgerMirrorSearchResponseV2Schema
>;

export const LedgerMirrorEntryResponseSchema = z.strictObject({
  entry: LedgerV1EntrySchema,
  ledgerId: LedgerUuidSchema,
  scopeKind: LedgerScopeKindSchema,
  scopeArchived: z.boolean(),
  source: LedgerMirrorSourceSchema,
  ...LedgerMirrorGlobalFieldsShape,
  sourceAvailability: LedgerSourceAvailabilitySchema,
  history: z.strictObject({
    mutations: z
      .array(LedgerV1MutationSchema)
      .max(LEDGER_LIMITS.historyPageMax),
    /** The revision to read the next page below; null at the first. */
    nextBeforeRevision: z.int().min(1).nullable(),
  }),
  actors: z
    .array(LedgerMirrorActorLabelSchema)
    .max(LEDGER_LIMITS.actorLabelsMax),
});
export type LedgerMirrorEntryResponse = z.output<
  typeof LedgerMirrorEntryResponseSchema
>;

export const LedgerMirrorEntryResponseV2Schema =
  LedgerMirrorEntryResponseSchema.extend({
    entry: LedgerEntrySchema,
    history: z.strictObject({
      mutations: z
        .array(LedgerMutationSchema)
        .max(LEDGER_LIMITS.historyPageMax),
      nextBeforeRevision: z.int().min(1).nullable(),
    }),
  });
export type LedgerMirrorEntryResponseV2 = z.output<
  typeof LedgerMirrorEntryResponseV2Schema
>;

export type LedgerCanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly LedgerCanonicalValue[]
  | { readonly [key: string]: LedgerCanonicalValue | undefined };

/** Whether parsed JSON is canonical data (it always is, from `JSON.parse`). */
export function isLedgerCanonicalValue(
  value: unknown,
): value is LedgerCanonicalValue {
  if (value === null) return true;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      return Array.isArray(value)
        ? value.every(isLedgerCanonicalValue)
        : Object.values(value).every(isLedgerCanonicalValue);
    default:
      return false;
  }
}

function isCanonicalArray(
  value: LedgerCanonicalValue,
): value is readonly LedgerCanonicalValue[] {
  return Array.isArray(value);
}

/**
 * Serializes JSON data with object keys sorted and `undefined` members
 * omitted, so equal data always produces the same text. The desktop hashes
 * outbox payloads over this text, and the mirror checks them against it.
 */
export function toLedgerCanonicalJson(value: LedgerCanonicalValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (isCanonicalArray(value)) {
    return `[${value.map(toLedgerCanonicalJson).join(',')}]`;
  }
  const members: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const member = value[key];
    if (member === undefined) continue;
    members.push(`${JSON.stringify(key)}:${toLedgerCanonicalJson(member)}`);
  }
  return `{${members.join(',')}}`;
}
