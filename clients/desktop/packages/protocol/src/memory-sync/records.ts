import { z } from 'zod';
import { MEMORY_SYNC_LIMITS } from './constants';
import { MemoryChangeCursorSchema, compareMemoryChangeSeq } from './cursor';
import {
  MemoryAccountIdSchema,
  MemoryChangeSeqSchema,
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
  isMemoryDocumentPath,
  isMemoryNoteFileKey,
  memoryDocumentIdentity,
} from './identifiers';

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isNormalizedText(value: string): boolean {
  return !value.includes('\r') && !value.includes('\0');
}

export const MemoryScopeKindSchema = z.enum(['user', 'project']);
export type MemoryScopeKind = z.output<typeof MemoryScopeKindSchema>;

export const MemoryScopeRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({
    kind: z.literal('project'),
    projectId: MemoryProjectIdSchema,
  }),
]);
export type MemoryScopeRef = z.output<typeof MemoryScopeRefSchema>;

export const MemoryServerConsolidationSchema = z.enum([
  'inherit',
  'allowed',
  'disallowed',
]);

export const MemoryScopeRecordSchema = z
  .strictObject({
    scopeId: MemoryScopeIdSchema,
    accountId: MemoryAccountIdSchema,
    kind: MemoryScopeKindSchema,
    projectId: MemoryProjectIdSchema.nullable(),
    revision: MemoryRevisionSchema,
    cursor: MemoryChangeCursorSchema,
    syncState: z.enum(['active', 'suspended']),
    serverConsolidation: MemoryServerConsolidationSchema,
    createdAt: MemoryTimestampSchema,
    updatedAt: MemoryTimestampSchema,
  })
  .refine(
    (scope): boolean =>
      (scope.kind === 'project') === (scope.projectId !== null),
    'A project scope names its project; a user scope names none',
  );
export type MemoryScopeRecord = z.output<typeof MemoryScopeRecordSchema>;

export const MemoryNoteOriginSchema = z.strictObject({
  projectId: MemoryProjectIdSchema.nullable(),
  organizationId: MemoryOrganizationIdSchema.nullable(),
});
export type MemoryNoteOrigin = z.output<typeof MemoryNoteOriginSchema>;

const SourceFieldSchema = z
  .string()
  .max(MEMORY_SYNC_LIMITS.sourceFieldMaxChars);

export const MemoryNoteSourceSchema = z.strictObject({
  provider: SourceFieldSchema,
  chatId: SourceFieldSchema,
  sessionId: SourceFieldSchema.optional(),
});

export const MemoryDeviceRefSchema = z.strictObject({
  deviceId: MemoryDeviceIdSchema,
  label: z.string().min(1).max(MEMORY_SYNC_LIMITS.deviceLabelMaxChars),
});
export type MemoryDeviceRef = z.output<typeof MemoryDeviceRefSchema>;

export const MemoryImportToolSchema = z.enum([
  'claude-code',
  'codex',
  'canopy-device',
]);

/**
 * `originKey` is a hash of the tool and its logical source path, never the
 * path itself, so imports of one source from two devices can be de-duplicated
 * without uploading where the file lived.
 */
export const MemoryImportSourceSchema = z.strictObject({
  tool: MemoryImportToolSchema,
  originKey: MemorySha256Schema,
  sourceFilename: z.string().min(1).max(255),
  repo: z.string().min(1).max(255).optional(),
  modifiedAt: MemoryTimestampSchema,
});

export const MemoryNoteKindSchema = z.enum(['inbox', 'import']);

const NoteBodySchema = z
  .string()
  .min(1)
  .refine(isNormalizedText, 'Expected a normalized note body');

/**
 * An import note carries a whole local document (first enable, section 17),
 * so it may be as large as a document; every other note keeps the note limit.
 */
export function memoryNoteBodyMaxBytes(note: {
  readonly importSource?: unknown;
}): number {
  return note.importSource === undefined
    ? MEMORY_SYNC_LIMITS.noteBodyMaxBytes
    : MEMORY_SYNC_LIMITS.importNoteBodyMaxBytes;
}

const memoryNoteShape = {
  noteId: MemoryNoteIdSchema,
  kind: MemoryNoteKindSchema,
  fileKey: MemoryNoteFileKeySchema,
  body: NoteBodySchema,
  contentHash: MemorySha256Schema,
  createdAt: MemoryTimestampSchema,
  modifiedAt: MemoryTimestampSchema,
  device: MemoryDeviceRefSchema,
  source: MemoryNoteSourceSchema.nullable(),
  origin: MemoryNoteOriginSchema,
  importSource: MemoryImportSourceSchema.optional(),
  supersedes: MemoryNoteIdSchema.optional(),
};

interface MemoryNoteInvariantInput {
  noteId: string;
  kind: 'inbox' | 'import';
  fileKey: string;
  body: string;
  importSource?: unknown;
  supersedes?: string;
}

function noteInvariantIssue(note: MemoryNoteInvariantInput): string | null {
  if (utf8Length(note.body) > memoryNoteBodyMaxBytes(note)) {
    return 'The note body is over the size limit for its kind';
  }
  if (!isMemoryNoteFileKey(note.fileKey, note.kind)) {
    return 'The file key folder does not match the note kind';
  }
  if ((note.kind === 'import') !== (note.importSource !== undefined)) {
    return 'Only an import note carries an import source';
  }
  if (note.supersedes === note.noteId) {
    return 'A note cannot supersede itself';
  }
  return null;
}

function refineNote(
  note: MemoryNoteInvariantInput,
  context: z.RefinementCtx,
): void {
  const issue = noteInvariantIssue(note);
  if (issue !== null) context.addIssue({ code: 'custom', message: issue });
}

/**
 * A note as its device wrote it. Notes never change after they are written:
 * an edit is a new note that supersedes the old one.
 */
export const MemoryNoteSchema = z
  .strictObject(memoryNoteShape)
  .superRefine(refineNote);
export type MemoryNote = z.output<typeof MemoryNoteSchema>;

export const MemoryNoteStateSchema = z.enum([
  'pending',
  'consolidated',
  'withheld',
  'tombstoned',
]);
export type MemoryNoteState = z.output<typeof MemoryNoteStateSchema>;

export const MemoryNoteRecordSchema = z
  .strictObject({
    ...memoryNoteShape,
    state: MemoryNoteStateSchema,
    receivedAt: MemoryTimestampSchema,
    consumedInRevision: MemoryRevisionSchema.nullable(),
    closedAt: MemoryTimestampSchema.nullable(),
  })
  .superRefine((note, context): void => {
    refineNote(note, context);
    if (
      (note.state === 'consolidated') !==
      (note.consumedInRevision !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only a consolidated note names the revision that consumed it',
      });
    }
    if ((note.state === 'pending') !== (note.closedAt === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only a pending note has no closing time',
      });
    }
  });
export type MemoryNoteRecord = z.output<typeof MemoryNoteRecordSchema>;

/**
 * Why a document is outside the contract: a path no document has, bytes that
 * are not normalized text, or content past `documentMaxBytes`.
 */
export type MemoryDocumentRefusal = 'name' | 'not_text' | 'too_large';

/** Why {@link DocumentContentSchema} would refuse `content`, if it would. */
export function memoryDocumentContentRefusal(
  content: string,
): Exclude<MemoryDocumentRefusal, 'name'> | null {
  if (!isNormalizedText(content)) return 'not_text';
  if (utf8Length(content) > MEMORY_SYNC_LIMITS.documentMaxBytes) {
    return 'too_large';
  }
  return null;
}

/**
 * Why a document put is outside the contract, or null when it is within it:
 * the one reading of {@link MemoryDocumentChangeSchema}'s own limits, as a
 * reason a caller can report. A caller that builds a commit asks this first,
 * so a change the schema would refuse never reaches a request, and nothing
 * it has already shown a person is refused when it is sent.
 */
export function memoryDocumentRefusal(
  path: string,
  content: string,
): MemoryDocumentRefusal | null {
  return isMemoryDocumentPath(path)
    ? memoryDocumentContentRefusal(content)
    : 'name';
}

const DocumentContentSchema = z
  .string()
  .refine(
    (value: string): boolean => memoryDocumentContentRefusal(value) === null,
    'Expected normalized document content within the size limit',
  );

export const MemoryDocumentSchema = z.strictObject({
  path: MemoryDocumentPathSchema,
  content: DocumentContentSchema,
  contentHash: MemorySha256Schema,
  changedInRevision: MemoryRevisionSchema.min(1),
});
export type MemoryDocument = z.output<typeof MemoryDocumentSchema>;

export const MemoryDocumentChangeSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('put'),
    path: MemoryDocumentPathSchema,
    content: DocumentContentSchema,
    contentHash: MemorySha256Schema,
  }),
  z.strictObject({ op: z.literal('delete'), path: MemoryDocumentPathSchema }),
]);
export type MemoryDocumentChange = z.output<typeof MemoryDocumentChangeSchema>;

export function hasUniqueDocumentIdentities(
  changes: readonly { path: string }[],
): boolean {
  const identities = changes.map((change) =>
    memoryDocumentIdentity(change.path),
  );
  return new Set(identities).size === identities.length;
}

export const MemoryDocumentChangesSchema = z
  .array(MemoryDocumentChangeSchema)
  .max(MEMORY_SYNC_LIMITS.commitChangesMax)
  .refine(hasUniqueDocumentIdentities, 'Each document may change once');

export const MemoryHolderSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('desktop'),
    deviceId: MemoryDeviceIdSchema,
    deviceLabel: z.string().min(1).max(MEMORY_SYNC_LIMITS.deviceLabelMaxChars),
  }),
  z.strictObject({
    kind: z.literal('cloud'),
    workerId: z.string().min(1).max(128),
  }),
  z.strictObject({ kind: z.literal('web') }),
]);
export type MemoryHolder = z.output<typeof MemoryHolderSchema>;

export const MemoryModelRefSchema = z.strictObject({
  modelId: z.string().min(1).max(256),
  provider: z.string().min(1).max(64).optional(),
  thinkingLevel: z.string().min(1).max(32).optional(),
});

export const MemoryRevisionKindSchema = z.enum([
  'consolidation',
  'manual_edit',
  'restore',
  'import',
  'merge',
  'migration',
]);
export type MemoryRevisionKind = z.output<typeof MemoryRevisionKindSchema>;

export const MemoryRevisionRecordSchema = z
  .strictObject({
    revision: MemoryRevisionSchema.min(1),
    parentRevision: MemoryRevisionSchema,
    commitId: MemoryCommitIdSchema,
    kind: MemoryRevisionKindSchema,
    committedAt: MemoryTimestampSchema,
    holder: MemoryHolderSchema,
    model: MemoryModelRefSchema.nullable(),
    promptVersion: z.string().min(1).max(64).nullable(),
    consolidationPackageVersion: z.string().min(1).max(64).nullable(),
    inputHash: MemorySha256Schema.nullable(),
    changedPaths: z
      .array(MemoryDocumentPathSchema)
      .max(MEMORY_SYNC_LIMITS.commitChangesMax),
    consumedNoteCount: z.int().min(0),
    restoredFromRevision: MemoryRevisionSchema.min(1).nullable(),
  })
  .superRefine((revision, context): void => {
    if (revision.parentRevision !== revision.revision - 1) {
      context.addIssue({
        code: 'custom',
        message: 'Revisions are linear: the parent is the revision before',
      });
    }
    if (
      (revision.kind === 'restore') !==
      (revision.restoredFromRevision !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only a restore names the revision it restored',
      });
    }
    if (
      revision.restoredFromRevision !== null &&
      revision.restoredFromRevision >= revision.revision
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A restore names an earlier revision',
      });
    }
  });
export type MemoryRevisionRecord = z.output<typeof MemoryRevisionRecordSchema>;

export const MemoryNoteRemovalReasonSchema = z.enum([
  'tombstoned',
  'superseded',
  'withheld',
  'purged',
]);

export const MemoryChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('note_put'),
    seq: MemoryChangeSeqSchema,
    note: MemoryNoteRecordSchema,
  }),
  z.strictObject({
    kind: z.literal('note_removed'),
    seq: MemoryChangeSeqSchema,
    noteId: MemoryNoteIdSchema,
    reason: MemoryNoteRemovalReasonSchema,
    at: MemoryTimestampSchema,
  }),
  z.strictObject({
    kind: z.literal('revision'),
    seq: MemoryChangeSeqSchema,
    revision: MemoryRevisionRecordSchema,
    changes: MemoryDocumentChangesSchema,
    consumedNoteIds: z
      .array(MemoryNoteIdSchema)
      .max(MEMORY_SYNC_LIMITS.commitConsumedNotesMax),
  }),
  z.strictObject({
    kind: z.literal('scope_updated'),
    seq: MemoryChangeSeqSchema,
    scope: MemoryScopeRecordSchema,
  }),
]);
export type MemoryChange = z.output<typeof MemoryChangeSchema>;

export function hasStrictlyIncreasingSeqs(
  changes: readonly { seq: string }[],
): boolean {
  for (let index = 1; index < changes.length; index += 1) {
    const previous = changes[index - 1];
    const current = changes[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareMemoryChangeSeq(previous.seq, current.seq) >= 0
    ) {
      return false;
    }
  }
  return true;
}
