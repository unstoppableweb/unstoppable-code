import { z } from 'zod';

export {
  LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL,
  LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
  PORTAL_CAPABILITY_LIFECYCLE_JOURNAL_QUARANTINE,
  lifecycleJournalRefusalKind,
} from './lifecycle-journal-refusal';

/** The journal scanners' recognized names: a hashed slot or an operation id. */
export const LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN =
  /^([a-f0-9]{64}|[a-f0-9-]{36})\.json$/;

const entryNameSchema = z
  .string()
  .regex(LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN, 'Unrecognized journal entry');

/** A project or worktree named only when the hashed file name matches it. */
export const LifecycleJournalEntryMatchSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('project'),
      workspaceId: z.string().min(1),
      projectName: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('worktree'),
      workspaceId: z.string().min(1),
      worktreeId: z.string().min(1),
      projectName: z.string(),
      worktreeName: z.string(),
    })
    .strict(),
]);
export type LifecycleJournalEntryMatch = z.infer<
  typeof LifecycleJournalEntryMatchSchema
>;

export const LifecycleJournalUnreadableEntrySchema = z
  .object({
    name: entryNameSchema,
    kind: z.enum(['file', 'directory', 'other']),
    /** Opaque physical identity the move re-checks. */
    identity: z.string().min(1),
    /** False when the identity can't be proven unique; the move then refuses. */
    identityVerified: z.boolean(),
    match: LifecycleJournalEntryMatchSchema.optional(),
  })
  .strict();
export type LifecycleJournalUnreadableEntry = z.infer<
  typeof LifecycleJournalUnreadableEntrySchema
>;

/**
 * `*Label` fields are display text the trusted desktop host projects for the
 * confirmation. On the Portal they are path-free, relative to the desktop's
 * data folder (`<data>/w5/…`). They are never path input: no request accepts
 * them back, and a move names only the entry and identity.
 */
const locationLabelSchema = z.string().max(4096);

export const LifecycleJournalInspectionSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('clear'), locationLabel: locationLabelSchema })
    .strict(),
  z
    .object({
      status: z.literal('directory-unreadable'),
      locationLabel: locationLabelSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('unreadable-entries'),
      locationLabel: locationLabelSchema,
      quarantineLocationLabel: locationLabelSchema,
      entries: z.array(LifecycleJournalUnreadableEntrySchema).min(1).max(100),
    })
    .strict(),
]);
export type LifecycleJournalInspection = z.infer<
  typeof LifecycleJournalInspectionSchema
>;

export const LifecycleJournalQuarantineRequestSchema = z
  .object({ name: entryNameSchema, identity: z.string().min(1).max(512) })
  .strict();
export type LifecycleJournalQuarantineRequest = z.infer<
  typeof LifecycleJournalQuarantineRequestSchema
>;

export const LifecycleJournalQuarantineResultSchema = z
  .object({
    status: z.literal('quarantined'),
    name: entryNameSchema,
    quarantinedName: z.string().min(1),
    quarantineLocationLabel: locationLabelSchema,
  })
  .strict();
export type LifecycleJournalQuarantineResult = z.infer<
  typeof LifecycleJournalQuarantineResultSchema
>;

export const archiveTriggerSchema = z.enum([
  'manual',
  'auto-delete',
  'agent',
  'project-deletion',
  'restore',
  'split',
  'import',
  'internal-rollback',
]);
export type ArchiveTrigger = z.infer<typeof archiveTriggerSchema>;
const operationSchema = z.enum([
  'workspace-delete',
  'worktree-archive',
  'worktree-delete',
]);
export const journalSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  operation: operationSchema,
  trigger: archiveTriggerSchema.optional(),
  /** Set on a child of {@link runStepFreeChildLifecycles}, which may resume it. */
  parentOperation: operationSchema.optional(),
  /** A resumed pre-capture archive's successor retains this binding after replacing its slot. */
  supersedesArchives: z.array(z.string().uuid()).optional(),
  workspaceId: z.string(),
  worktreeId: z.string().optional(),
  createdAt: z.string().optional(),
  directoryIdentity: z.string().nullable(),
  state: z.enum(['active', 'recovery-required', 'completed']),
  steps: z.array(
    z.object({
      phase: z.string(),
      state: z.enum(['pending', 'done', 'failed']),
      /** Privacy-safe failure classification; raw step errors stay local. */
      code: z.string().optional(),
      error: z.string().optional(),
      /** Taken by {@link resumableDestructiveStep} while it was step-free. */
      resumable: z.literal(true).optional(),
    }),
  ),
  outcome: z.unknown().optional(),
  cleanupRequired: z.boolean().optional(),
  archiveRecoveryCleanup: z
    .array(
      z.object({
        operationId: z.string().uuid(),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        done: z.boolean().optional(),
        discardPending: z.literal(true).optional(),
        receiptDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      }),
    )
    .optional(),
  /** Retains bounded-repair scope across a caught failure; never generic archive replay. */
  cleanupRepair: z.object({ kind: z.literal('completed-cleanup') }).optional(),
  ownedPaths: z
    .array(z.object({ path: z.string(), identity: z.string().nullable() }))
    .default([]),
});
export type DestructiveRecoveryRecord = z.infer<typeof journalSchema>;
