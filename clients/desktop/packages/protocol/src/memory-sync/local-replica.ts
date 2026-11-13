import { z } from 'zod';
import { MEMORY_SYNC_LIMITS } from './constants';
import { MemoryChangeCursorSchema } from './cursor';
import {
  MemoryAccountIdSchema,
  MemoryCommitIdSchema,
  MemoryDeviceIdSchema,
  MemoryDocumentPathSchema,
  MemoryNoteFileKeySchema,
  MemoryNoteIdSchema,
  MemoryOrganizationIdSchema,
  MemoryProjectIdSchema,
  MemoryRevisionSchema,
  MemoryScopeIdSchema,
  MemorySha256Schema,
  MemoryTimestampSchema,
  MemoryUuidSchema,
} from './identifiers';
import { MemoryScopeKindSchema, type MemoryScopeRef } from './records';
import { MemoryCommitKindSchema, MemoryNoteOpSchema } from './requests';

/*
 * Files a desktop keeps beside a scope's Markdown. Writers keep fields they do
 * not know (loose objects), so an older build that rewrites one of these files
 * cannot drop what a newer build added.
 */

export const MEMORY_REPLICA_ROOT_DIRNAME = 'memory-replicas';
export const MEMORY_REPLICA_USER_DIRNAME = 'user';
export const MEMORY_REPLICA_PROJECTS_DIRNAME = 'projects';
export const MEMORY_REPLICA_ACCOUNT_FILENAME = 'account.json';
export const MEMORY_MANIFEST_FILENAME = 'manifest.json';
export const MEMORY_SYNC_STATE_FILENAME = 'sync-state.json';
export const MEMORY_SYNC_OUTBOX_FILENAME = 'sync-outbox.json';
export const MEMORY_SYNC_PRIVATE_DIRNAME = '.sync';
export const MEMORY_LOCK_DIRNAME = '.lock';
export const MEMORY_LOCK_OWNER_FILENAME = 'owner.json';

/** The longest note file the Memory panel saves (512 KiB). */
const MEMORY_LOCAL_NOTE_FILE_MAX_CHARS = 512 * 1024;

export function memoryReplicaPathSegments(
  accountId: string,
  scope: MemoryScopeRef,
): string[] {
  const root = [MEMORY_REPLICA_ROOT_DIRNAME, accountId];
  return scope.kind === 'user'
    ? [...root, MEMORY_REPLICA_USER_DIRNAME]
    : [...root, MEMORY_REPLICA_PROJECTS_DIRNAME, scope.projectId];
}

/** A scope whose `minWriterFormat` is above this is read-only to this build. */
export const MEMORY_LOCAL_FORMAT_VERSION = 2;

export const MemoryManifestV1FileSchema = z.looseObject({
  version: z.literal(1),
});

export const MemoryReplicaBindingSchema = z.looseObject({
  accountId: MemoryAccountIdSchema,
  scopeId: MemoryScopeIdSchema,
  kind: MemoryScopeKindSchema,
  projectId: MemoryProjectIdSchema.nullable(),
});

export const MemoryManifestFileSchema = z.looseObject({
  version: z.literal(2),
  /**
   * Minted when the manifest is created or backfilled. A build that predates
   * version 2 rewrites the manifest to version 1; the next backfill mints a
   * new incarnation, so a revision read before that can never match again.
   */
  incarnation: MemoryUuidSchema,
  revision: MemoryRevisionSchema,
  minWriterFormat: z.int().min(MEMORY_LOCAL_FORMAT_VERSION),
  createdAt: MemoryTimestampSchema,
  backfilledAt: MemoryTimestampSchema.nullable(),
  binding: MemoryReplicaBindingSchema.nullable(),
  migratedTo: z
    .array(
      z.looseObject({
        accountId: MemoryAccountIdSchema,
        scopeId: MemoryScopeIdSchema,
        at: MemoryTimestampSchema,
      }),
    )
    .max(50),
});
export type MemoryManifestFile = z.output<typeof MemoryManifestFileSchema>;

export const MemoryReplicaAccountFileSchema = z.looseObject({
  version: z.literal(1),
  accountId: MemoryAccountIdSchema,
  deviceId: MemoryDeviceIdSchema,
  createdAt: MemoryTimestampSchema,
  settingsRevision: z.int().min(0),
});

export const MemoryReplicaModeSchema = z.enum([
  'syncing',
  'paused',
  'device_only',
  'repair_needed',
  'deleted_in_cloud',
]);

/**
 * Why a pulled change and a local edit were left to the person as a
 * conflict (design §13.2): edits in the same place, or a delete against an
 * edit (`overlap`); a line diff too costly to run (`too_costly`); or a side,
 * or the merged document, past what a merge or sync carries (`too_large`).
 */
export const MemoryConflictReasonSchema = z.enum([
  'overlap',
  'too_costly',
  'too_large',
]);
export type MemoryConflictReason = z.output<typeof MemoryConflictReasonSchema>;

export const MemorySyncStateFileSchema = z.looseObject({
  version: z.literal(1),
  binding: MemoryReplicaBindingSchema,
  deviceId: MemoryDeviceIdSchema,
  mode: MemoryReplicaModeSchema,
  cursor: MemoryChangeCursorSchema.nullable(),
  baseRevision: MemoryRevisionSchema,
  baseDocuments: z.record(
    MemoryDocumentPathSchema,
    z.looseObject({
      contentHash: MemorySha256Schema,
      changedInRevision: MemoryRevisionSchema.min(1),
    }),
  ),
  localOnlyNoteIds: z.array(MemoryNoteIdSchema),
  /**
   * Notes the last snapshot did not hold that stayed only because the outbox
   * held them, as of the replica cursor `cursor`; dropped once the cursor
   * moves without them (an earlier build pulled). A push that answers a
   * note's operation as replayed or renamed records `replayed`: the server
   * may have held the note before the snapshot, which then found it no
   * longer pending. A page that names the note drops its entry. Once the
   * outbox no longer holds the note and a page reaches `replayed.cursor`,
   * the note goes as the snapshot would have moved it aside, while its file
   * still holds that body; other bytes stay as a local-only note. Absent
   * when no note is kept so, and in a state an earlier build wrote.
   */
  snapshotKept: z
    .looseObject({
      cursor: MemoryChangeCursorSchema,
      notes: z.array(
        z.looseObject({
          noteId: MemoryNoteIdSchema,
          replayed: z
            .looseObject({
              contentHash: MemorySha256Schema,
              /** The push's cursor, at or after the note's storing. */
              cursor: MemoryChangeCursorSchema.nullable(),
            })
            .optional(),
        }),
      ),
    })
    .optional(),
  pendingCommit: z
    .looseObject({
      commitId: MemoryCommitIdSchema,
      kind: MemoryCommitKindSchema,
      baseRevision: MemoryRevisionSchema,
      startedAt: MemoryTimestampSchema,
    })
    .nullable(),
  conflicts: z.array(
    z.looseObject({
      path: MemoryDocumentPathSchema,
      detectedAt: MemoryTimestampSchema,
      theirsRevision: MemoryRevisionSchema,
      oursFile: z.string().min(1).max(256),
      // Absent in a file an earlier build wrote, and unknown in one a later
      // build wrote: either reads as an overlap, not as an unreadable state.
      reason: MemoryConflictReasonSchema.catch('overlap'),
      /** This device had deleted the document. */
      oursDeleted: z.boolean().optional(),
      /**
       * The inbox notes that carry this device's side to the next
       * consolidation, recorded before any is queued; absent until then,
       * as in a file an earlier build wrote.
       */
      autoNoteIds: z.array(MemoryNoteIdSchema).max(64).optional(),
      /** Every note in `autoNoteIds` is queued or already settled. */
      autoNotesQueued: z.boolean().optional(),
    }),
  ),
  firstEnable: z
    .looseObject({
      state: z.enum(['uploading', 'merging', 'reviewing', 'done']),
      startedAt: MemoryTimestampSchema,
      preMergeRevision: MemoryRevisionSchema.nullable(),
      /**
       * The first enable's commit, recorded before it is sent: once the
       * cloud holds it, a retry or restart finishes the first enable
       * instead of sending its notes again. Absent before that.
       */
      commitId: MemoryCommitIdSchema.optional(),
      /**
       * Every note this first enable queued to send, so a later try knows
       * which of them the cloud has consumed since. Absent before any.
       */
      sentNoteIds: z.array(MemoryNoteIdSchema).max(100_000).optional(),
    })
    .nullable(),
  lastPulledAt: MemoryTimestampSchema.nullable(),
  lastPushedAt: MemoryTimestampSchema.nullable(),
  lastError: z
    .looseObject({
      code: z.string().min(1).max(64),
      at: MemoryTimestampSchema,
    })
    .nullable(),
});
export type MemorySyncStateFile = z.output<typeof MemorySyncStateFileSchema>;

export const MemorySyncOutboxFileSchema = z.looseObject({
  version: z.literal(1),
  binding: MemoryReplicaBindingSchema,
  /** The next operation's `seq`; absent before operations had identities. */
  nextSeq: z.int().min(1).optional(),
  ops: z
    .array(
      z.looseObject({
        /**
         * The operation's identity in this outbox, never reused. A push's
         * answer settles only the operations it carried. Absent in an outbox
         * an earlier build wrote.
         */
        seq: z.int().min(1).optional(),
        queuedAt: MemoryTimestampSchema,
        attempts: z.int().min(0),
        /**
         * Set before the operation is first sent: the server may hold it
         * from then on, so a later edit or delete never cancels it.
         */
        sent: z.boolean().optional(),
        op: MemoryNoteOpSchema,
      }),
    )
    .max(MEMORY_SYNC_LIMITS.pendingNotesPerScopeMax),
  /**
   * Notes deleted or edited on this device whose file is not settled yet,
   * each recorded before the file changes, in the outbox write that queues
   * its change. Settling finishes the change only while the file still holds
   * the bytes the change saw: a delete removes it, an edit writes its
   * replacement over it. Then the local-only marks are fixed and the entry
   * goes, so a change cut short by a failure or a crash is finished later.
   * Absent in an outbox an earlier build wrote.
   */
  localDeletes: z
    .array(
      z.looseObject({
        noteId: MemoryNoteIdSchema,
        fileKey: MemoryNoteFileKeySchema,
        /**
         * The file's bytes when the change was made. A file holding other
         * bytes by then stays, as a local-only note. Absent in an entry an
         * earlier build wrote, which removes any file holding the note.
         */
        contentHash: MemorySha256Schema.optional(),
        /**
         * The note an edit wrote in this one's place. An entry with one is
         * an edit and never removes its file.
         */
        replacedBy: MemoryNoteIdSchema.optional(),
        /**
         * The edit's replacement as written over the file, so an edit cut
         * short is finished from the entry alone. Without it the file and
         * the entry stay. Absent in an entry an earlier build wrote.
         */
        replacement: z
          .looseObject({
            contentHash: MemorySha256Schema,
            content: z.string().max(MEMORY_LOCAL_NOTE_FILE_MAX_CHARS),
            /** The replacement stays on this device only. */
            localOnly: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  usage: z.record(
    z.string().min(1).max(256),
    z.looseObject({
      uses: z.int().min(1),
      lastUsedAt: MemoryTimestampSchema,
    }),
  ),
  /**
   * The usage push in flight, marked sent before it goes: it is sent again
   * as it is until it is answered, and only that answer, by its `seq` from
   * the operations' sequence, removes it. Uses counted meanwhile wait in
   * `usage`.
   */
  usageSent: z
    .looseObject({
      seq: z.int().min(1),
      deltas: z
        .array(
          z.object({
            fileKey: z.string().min(1).max(256),
            uses: z.int().min(1).max(MEMORY_SYNC_LIMITS.usageDeltaUsesMax),
            lastUsedAt: MemoryTimestampSchema,
          }),
        )
        .max(MEMORY_SYNC_LIMITS.usageDeltasMax),
    })
    .optional(),
});
export type MemorySyncOutboxFile = z.output<typeof MemorySyncOutboxFileSchema>;

/** A note without `device` was saved on this device before it registered. */
export const MemoryNoteFrontmatterIdentitySchema = z.looseObject({
  id: MemoryNoteIdSchema,
  device: MemoryDeviceIdSchema.optional(),
  deviceLabel: z
    .string()
    .min(1)
    .max(MEMORY_SYNC_LIMITS.deviceLabelMaxChars)
    .optional(),
  origin: z
    .looseObject({
      projectId: MemoryProjectIdSchema.optional(),
      organizationId: MemoryOrganizationIdSchema.optional(),
    })
    .optional(),
  supersedes: MemoryNoteIdSchema.optional(),
});
export type MemoryNoteFrontmatterIdentity = z.output<
  typeof MemoryNoteFrontmatterIdentitySchema
>;

export const MemoryLocalLockOwnerFileSchema = z.looseObject({
  version: z.literal(1),
  token: MemoryUuidSchema,
  pid: z.int().min(1),
  hostname: z.string().min(1).max(255),
  processKind: z.enum(['app', 'cli', 'daemon', 'test']),
  acquiredAt: MemoryTimestampSchema,
  heartbeatAt: MemoryTimestampSchema,
});
export type MemoryLocalLockOwnerFile = z.output<
  typeof MemoryLocalLockOwnerFileSchema
>;
