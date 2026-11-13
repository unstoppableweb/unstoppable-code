import { z } from 'zod';
import { MEMORY_SYNC_LIMITS, MEMORY_SYNC_QUOTAS } from './constants';
import {
  MemoryChangeCursorSchema,
  compareMemoryChangeSeq,
  parseMemoryChangeCursor,
} from './cursor';
import { MemorySyncErrorCodeSchema } from './errors';
import {
  MemoryChangeSeqSchema,
  MemoryCommitIdSchema,
  MemoryDeviceIdSchema,
  MemoryDocumentPathSchema,
  MemoryInstallationGenerationSchema,
  MemoryLeaseEpochSchema,
  MemoryNoteFileKeySchema,
  MemoryNoteIdSchema,
  MemoryOrganizationIdSchema,
  MemoryProjectIdSchema,
  MemoryRevisionSchema,
  MemoryScopeIdSchema,
  MemorySha256Schema,
  MemoryTimestampSchema,
  MemoryUuidSchema,
  isMemoryDocumentPath,
  memoryDocumentIdentity,
} from './identifiers';
import {
  MemoryChangeSchema,
  MemoryDocumentChangesSchema,
  MemoryDocumentSchema,
  MemoryHolderSchema,
  MemoryModelRefSchema,
  MemoryNoteRecordSchema,
  MemoryNoteSchema,
  MemoryRevisionRecordSchema,
  MemoryScopeRecordSchema,
  MemoryScopeRefSchema,
  hasStrictlyIncreasingSeqs,
} from './records';

const PageTokenSchema = z
  .string()
  .min(1)
  .max(MEMORY_SYNC_LIMITS.pageTokenMaxLength);

export const MemorySyncModeSchema = z.enum(['sync', 'device_only']);

export const MemorySyncSettingsSchema = z.strictObject({
  revision: z.int().min(1),
  enabled: z.boolean(),
  enabledAt: MemoryTimestampSchema.nullable(),
  userScope: MemorySyncModeSchema,
  defaultProjectScope: MemorySyncModeSchema,
  serverConsolidation: z.enum(['allowed', 'disallowed']),
});
export type MemorySyncSettings = z.output<typeof MemorySyncSettingsSchema>;

export const MemorySyncSettingsUpdateRequestSchema = z
  .strictObject({
    revision: z.int().min(1),
    enabled: z.boolean().optional(),
    userScope: MemorySyncModeSchema.optional(),
    defaultProjectScope: MemorySyncModeSchema.optional(),
    serverConsolidation: z.enum(['allowed', 'disallowed']).optional(),
  })
  .refine(
    (request): boolean => Object.keys(request).length > 1,
    'Change at least one setting',
  );

export const MemoryProjectSettingRequestSchema = z.strictObject({
  mode: MemorySyncModeSchema,
});

export const MemoryProjectSettingResponseSchema = z.strictObject({
  projectId: MemoryProjectIdSchema,
  mode: MemorySyncModeSchema,
});

/**
 * Every project the account chose a mode for (design §22). A project not
 * listed follows the account's `defaultProjectScope`.
 */
export const MemoryProjectSettingListResponseSchema = z.strictObject({
  projects: z
    .array(MemoryProjectSettingResponseSchema)
    .max(MEMORY_SYNC_QUOTAS.scopesPerAccount),
});
export type MemoryProjectSettingList = z.output<
  typeof MemoryProjectSettingListResponseSchema
>;

export const MemoryAccountPolicySchema = z.strictObject({
  blockedOriginOrganizationIds: z
    .array(MemoryOrganizationIdSchema)
    .max(MEMORY_SYNC_LIMITS.blockedOrganizationsMax),
  serverConsolidationAvailable: z.boolean(),
});
export type MemoryAccountPolicy = z.output<typeof MemoryAccountPolicySchema>;

export const MemorySyncSettingsResponseSchema = z.strictObject({
  settings: MemorySyncSettingsSchema,
  policy: MemoryAccountPolicySchema,
});

export const MemoryDevicePlatformSchema = z.enum(['darwin', 'win32', 'linux']);

export const MemoryDeviceRegisterRequestSchema = z.strictObject({
  protocolVersion: z.int().min(1),
  device: z.strictObject({
    deviceId: MemoryDeviceIdSchema,
    installationGeneration: MemoryInstallationGenerationSchema,
    sessionNonce: MemoryUuidSchema,
    label: z.string().min(1).max(MEMORY_SYNC_LIMITS.deviceLabelMaxChars),
    platform: MemoryDevicePlatformSchema,
    appVersion: z.string().min(1).max(64),
  }),
});
export type MemoryDeviceRegisterRequest = z.output<
  typeof MemoryDeviceRegisterRequestSchema
>;

export const MemoryDeviceRegisterResponseSchema = z.strictObject({
  deviceSessionId: MemoryUuidSchema,
  minimumProtocolVersion: z.int().min(1),
  serverTime: MemoryTimestampSchema,
  ingestEnabled: z.boolean(),
  settings: MemorySyncSettingsSchema,
  policy: MemoryAccountPolicySchema,
});
export type MemoryDeviceRegisterResponse = z.output<
  typeof MemoryDeviceRegisterResponseSchema
>;

export const MemoryScopeResolveRequestSchema = z.strictObject({
  scope: MemoryScopeRefSchema,
  create: z.boolean(),
});

export const MemoryScopeResolveResponseSchema = z.strictObject({
  scope: MemoryScopeRecordSchema,
  created: z.boolean(),
});

export const MemoryScopeListResponseSchema = z.strictObject({
  scopes: z.array(MemoryScopeRecordSchema),
});

/**
 * One page of a snapshot pinned at `revision` and `cursor`: the documents at
 * that revision and the notes pending at that cursor. After the last page the
 * replica pulls changes from `cursor`.
 */
export const MemorySnapshotPageSchema = z.strictObject({
  scopeId: MemoryScopeIdSchema,
  revision: MemoryRevisionSchema,
  cursor: MemoryChangeCursorSchema,
  documents: z.array(MemoryDocumentSchema),
  pendingNotes: z.array(MemoryNoteRecordSchema),
  nextPageToken: PageTokenSchema.nullable(),
});
export type MemorySnapshotPage = z.output<typeof MemorySnapshotPageSchema>;

/** The UTF-8 length of a value's JSON encoding, as a page is measured. */
export function memorySyncJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Whether a server filling a changes page adds an entry of `entryBytes`
 * encoded bytes to a page that already holds `entryCount` entries totalling
 * `entriesBytes`. The first entry of a page always goes in, so every accepted
 * revision can be delivered; later entries only while the page stays within
 * `changesPageTargetBytes`.
 */
export function memoryChangesPageHasRoom(
  page: { readonly entryCount: number; readonly entriesBytes: number },
  entryBytes: number,
): boolean {
  if (page.entryCount === 0) return true;
  const separators = page.entryCount;
  return (
    MEMORY_SYNC_LIMITS.changesPageEnvelopeMaxBytes +
      page.entriesBytes +
      separators +
      entryBytes <=
    MEMORY_SYNC_LIMITS.changesPageTargetBytes
  );
}

/**
 * A page is within the target, or holds a single entry within the hard
 * maximum. The hard maximum is derived from the commit request maximum, so a
 * revision the server accepted always fits one page.
 */
export function isMemoryChangesPageWithinBytes(page: {
  readonly changes: readonly unknown[];
}): boolean {
  const bytes = memorySyncJsonBytes(page);
  if (bytes <= MEMORY_SYNC_LIMITS.changesPageTargetBytes) return true;
  return (
    page.changes.length === 1 &&
    bytes <= MEMORY_SYNC_LIMITS.changesPageHardMaxBytes
  );
}

export const MemoryChangesPageSchema = z
  .strictObject({
    scopeId: MemoryScopeIdSchema,
    changes: z.array(MemoryChangeSchema).max(MEMORY_SYNC_LIMITS.changesPageMax),
    nextCursor: MemoryChangeCursorSchema,
    hasMore: z.boolean(),
    headRevision: MemoryRevisionSchema,
  })
  .refine(
    (page): boolean => hasStrictlyIncreasingSeqs(page.changes),
    'Changes must be in strictly increasing order',
  )
  .refine(
    isMemoryChangesPageWithinBytes,
    'Only a page holding a single entry may exceed the page target',
  );
export type MemoryChangesPage = z.output<typeof MemoryChangesPageSchema>;

export type MemoryChangePageProblem =
  | 'unparseable_cursor'
  | 'scope_mismatch'
  | 'generation_changed'
  | 'cursor_moved_backwards'
  | 'change_not_after_cursor'
  | 'change_after_next_cursor'
  | 'empty_page_with_more';

/**
 * Checks a page against the cursor it was requested with. A replica that
 * applied a page failing these checks could skip or replay changes, so any
 * problem means: stop, and take a snapshot.
 */
export function checkMemoryChangesPage(
  requestCursor: string,
  page: MemoryChangesPage,
): MemoryChangePageProblem | null {
  const from = parseMemoryChangeCursor(requestCursor);
  const next = parseMemoryChangeCursor(page.nextCursor);
  if (from === null || next === null) return 'unparseable_cursor';
  if (from.scopeId !== page.scopeId || next.scopeId !== page.scopeId) {
    return 'scope_mismatch';
  }
  if (from.generation !== next.generation) return 'generation_changed';
  if (compareMemoryChangeSeq(next.seq, from.seq) < 0) {
    return 'cursor_moved_backwards';
  }
  const first = page.changes[0];
  const last = page.changes[page.changes.length - 1];
  if (first !== undefined && compareMemoryChangeSeq(first.seq, from.seq) <= 0) {
    return 'change_not_after_cursor';
  }
  if (last !== undefined && compareMemoryChangeSeq(last.seq, next.seq) > 0) {
    return 'change_after_next_cursor';
  }
  if (page.hasMore && page.changes.length === 0) return 'empty_page_with_more';
  return null;
}

export const MemoryNoteOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('put'), note: MemoryNoteSchema }),
  z
    .strictObject({ op: z.literal('replace'), note: MemoryNoteSchema })
    .refine(
      (op): boolean => op.note.supersedes !== undefined,
      'A replacement names the note it supersedes',
    ),
  z.strictObject({
    op: z.literal('tombstone'),
    noteId: MemoryNoteIdSchema,
    deletedAt: MemoryTimestampSchema,
  }),
]);
export type MemoryNoteOp = z.output<typeof MemoryNoteOpSchema>;

function opNoteId(op: MemoryNoteOp): string {
  return op.op === 'tombstone' ? op.noteId : op.note.noteId;
}

export const MemoryNotesPushRequestSchema = z.strictObject({
  ops: z
    .array(MemoryNoteOpSchema)
    .min(1)
    .max(MEMORY_SYNC_LIMITS.pushOpsMax)
    .refine((ops): boolean => {
      const ids = ops.map(opNoteId);
      return new Set(ids).size === ids.length;
    }, 'Each note may appear once in a push'),
});
export type MemoryNotesPushRequest = z.output<
  typeof MemoryNotesPushRequestSchema
>;

export const MemoryNoteOpResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ noteId: MemoryNoteIdSchema, outcome: z.literal('applied') }),
  z.strictObject({
    noteId: MemoryNoteIdSchema,
    outcome: z.literal('replayed'),
  }),
  z.strictObject({
    noteId: MemoryNoteIdSchema,
    outcome: z.literal('renamed'),
    fileKey: MemoryNoteFileKeySchema,
  }),
  z.strictObject({
    noteId: MemoryNoteIdSchema,
    outcome: z.literal('deduplicated'),
    canonicalNoteId: MemoryNoteIdSchema,
  }),
  z.strictObject({
    noteId: MemoryNoteIdSchema,
    outcome: z.literal('rejected'),
    code: MemorySyncErrorCodeSchema,
    keepLocal: z.boolean(),
  }),
]);
export type MemoryNoteOpResult = z.output<typeof MemoryNoteOpResultSchema>;

export const MemoryNotesPushResponseSchema = z.strictObject({
  results: z.array(MemoryNoteOpResultSchema).max(MEMORY_SYNC_LIMITS.pushOpsMax),
  cursor: MemoryChangeCursorSchema,
});
export type MemoryNotesPushResponse = z.output<
  typeof MemoryNotesPushResponseSchema
>;

export const MemoryUsageAggregateSchema = z.strictObject({
  trackingSince: MemoryTimestampSchema.nullable(),
  entries: z.array(
    z.strictObject({
      fileKey: z.string().min(1).max(256),
      usageCount: z.int().min(0),
      lastUsedAt: MemoryTimestampSchema.nullable(),
      firstSeenAt: MemoryTimestampSchema,
    }),
  ),
});
export type MemoryUsageAggregate = z.output<typeof MemoryUsageAggregateSchema>;

export const MemoryLeaseReasonSchema = z.enum([
  'scheduled',
  'manual',
  'rebuild',
  'first_enable',
]);

export const MemoryLeaseSchema = z.strictObject({
  leaseId: MemoryUuidSchema,
  epoch: MemoryLeaseEpochSchema,
  holder: MemoryHolderSchema,
  reason: MemoryLeaseReasonSchema,
  grantedAt: MemoryTimestampSchema,
  expiresAt: MemoryTimestampSchema,
  maxUntil: MemoryTimestampSchema,
  baseRevision: MemoryRevisionSchema,
});
export type MemoryLease = z.output<typeof MemoryLeaseSchema>;

export const MemoryLeaseAcquireRequestSchema = z.strictObject({
  reason: MemoryLeaseReasonSchema,
});

export const MemoryLeaseAcquireResponseSchema = z.strictObject({
  lease: MemoryLeaseSchema,
  pendingNoteCount: z.int().min(0),
  usage: MemoryUsageAggregateSchema,
});
export type MemoryLeaseAcquireResponse = z.output<
  typeof MemoryLeaseAcquireResponseSchema
>;

export const MemoryLeaseFenceSchema = z.strictObject({
  leaseId: MemoryUuidSchema,
  epoch: MemoryLeaseEpochSchema,
});
export type MemoryLeaseFence = z.output<typeof MemoryLeaseFenceSchema>;

export const MemoryLeaseRenewRequestSchema = MemoryLeaseFenceSchema;

export const MemoryLeaseRenewResponseSchema = z.strictObject({
  lease: MemoryLeaseSchema,
});

export const MemoryLeaseReleaseRequestSchema = z.strictObject({
  leaseId: MemoryUuidSchema,
  epoch: MemoryLeaseEpochSchema,
  outcome: z.enum(['committed', 'clean', 'abandoned', 'failed']),
  reason: z.string().max(MEMORY_SYNC_LIMITS.messageMaxChars).optional(),
});

export const MemoryCommitKindSchema = z.enum([
  'consolidation',
  'manual_edit',
  'import',
  'merge',
]);

const LEASED_COMMIT_KINDS: ReadonlySet<string> = new Set([
  'consolidation',
  'import',
  'merge',
]);

export const MemoryCommitRequestSchema = z
  .strictObject({
    commitId: MemoryCommitIdSchema,
    kind: MemoryCommitKindSchema,
    baseRevision: MemoryRevisionSchema,
    lease: MemoryLeaseFenceSchema.nullable(),
    changes: MemoryDocumentChangesSchema,
    consumedNoteIds: z
      .array(MemoryNoteIdSchema)
      .max(MEMORY_SYNC_LIMITS.commitConsumedNotesMax)
      .refine(
        (ids): boolean => new Set(ids).size === ids.length,
        'Each note is consumed once',
      ),
    metadata: z.strictObject({
      model: MemoryModelRefSchema.nullable(),
      promptVersion: z.string().min(1).max(64).nullable(),
      consolidationPackageVersion: z.string().min(1).max(64).nullable(),
      inputHash: MemorySha256Schema.nullable(),
    }),
    /**
     * Topics this commit deletes because nothing used them (design §15).
     * The server refuses the commit with `memory_notes_changed` when any of
     * them was used since the usage aggregate the holder pruned from, so a
     * use from another device after the lease grant keeps the topic.
     */
    prunedTopicPaths: z
      .array(MemoryDocumentPathSchema)
      .max(MEMORY_SYNC_LIMITS.commitChangesMax)
      .optional(),
  })
  .superRefine((commit, context): void => {
    const deleted = new Set(
      commit.changes.flatMap((change) =>
        change.op === 'delete' ? [memoryDocumentIdentity(change.path)] : [],
      ),
    );
    const pruned = (commit.prunedTopicPaths ?? []).map(memoryDocumentIdentity);
    if (
      new Set(pruned).size !== pruned.length ||
      pruned.some(
        (identity) => identity === 'MEMORY.md' || !deleted.has(identity),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A pruned topic is listed once and deleted by the commit',
      });
    }
    if (LEASED_COMMIT_KINDS.has(commit.kind) && commit.lease === null) {
      context.addIssue({
        code: 'custom',
        message: 'Consolidation, import and merge commits carry their lease',
      });
    }
    if (commit.kind === 'manual_edit' && commit.consumedNoteIds.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'A manual edit consumes no notes',
      });
    }
    if (commit.changes.length === 0 && commit.consumedNoteIds.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A commit changes a document or consumes a note',
      });
    }
  });
export type MemoryCommitRequest = z.output<typeof MemoryCommitRequestSchema>;

export const MemoryCommitResponseSchema = z.strictObject({
  revision: MemoryRevisionRecordSchema,
  cursor: MemoryChangeCursorSchema,
});
export type MemoryCommitResponse = z.output<typeof MemoryCommitResponseSchema>;

export const MemoryRevisionListResponseSchema = z.strictObject({
  revisions: z
    .array(MemoryRevisionRecordSchema)
    .max(MEMORY_SYNC_LIMITS.historyPageMax),
  nextBefore: MemoryRevisionSchema.nullable(),
});

export const MemoryRevisionDocumentsPageSchema = z.strictObject({
  scopeId: MemoryScopeIdSchema,
  revision: MemoryRevisionSchema,
  documents: z.array(MemoryDocumentSchema),
  nextPageToken: PageTokenSchema.nullable(),
});

export const MemoryRestoreRequestSchema = z
  .strictObject({
    commitId: MemoryCommitIdSchema,
    targetRevision: MemoryRevisionSchema.min(1),
    baseRevision: MemoryRevisionSchema,
  })
  .refine(
    (request): boolean => request.targetRevision < request.baseRevision,
    'A restore targets an earlier revision',
  );

export const MemoryUsagePushRequestSchema = z.strictObject({
  deltas: z
    .array(
      z.strictObject({
        fileKey: z
          .string()
          .refine(
            (value: string): boolean =>
              isMemoryDocumentPath(value) ||
              MemoryNoteFileKeySchema.safeParse(value).success,
            'Expected a document path or note file key',
          ),
        uses: z.int().min(1).max(MEMORY_SYNC_LIMITS.usageDeltaUsesMax),
        lastUsedAt: MemoryTimestampSchema,
      }),
    )
    .min(1)
    .max(MEMORY_SYNC_LIMITS.usageDeltasMax),
});

export const MEMORY_SYNC_PURGE_CONFIRMATION = 'delete-cloud-memory';

export const MemoryPurgeRequestSchema = z.strictObject({
  confirm: z.literal(MEMORY_SYNC_PURGE_CONFIRMATION),
});

export const MemoryScopeExportPageSchema = z.strictObject({
  scope: MemoryScopeRecordSchema,
  revision: MemoryRevisionSchema,
  documents: z.array(MemoryDocumentSchema),
  notes: z.array(MemoryNoteRecordSchema),
  nextPageToken: PageTokenSchema.nullable(),
});

export const MemorySyncRealtimeSignalSchema = z.strictObject({
  scopeId: MemoryScopeIdSchema,
  seq: MemoryChangeSeqSchema,
  reason: z.enum(['changed', 'lease', 'settings', 'deleted']),
});
export type MemorySyncRealtimeSignal = z.output<
  typeof MemorySyncRealtimeSignalSchema
>;
