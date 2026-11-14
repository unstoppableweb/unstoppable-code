import { z } from 'zod';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

export const ARCHIVE_GRANTS = {
  read: 'core.archive.read',
  write: 'core.archive.write',
} as const;

const ID = z.string().min(1).max(512);
const TIMESTAMP = z.string().min(1).max(64);

// `workspace`, a whole retained project, is the web core's only (CAN-6109).
export const ArchiveContainerKindSchema = z.enum([
  'worktree',
  'work-entry',
  'workspace',
]);
const REVISION = z.number().int().nonnegative();

export const ArchiveContainerSummarySchema = z.strictObject({
  archiveId: ID,
  kind: ArchiveContainerKindSchema,
  /** The project the container belongs to, or is (kind `workspace`). */
  workspaceId: ID,
  workspaceName: z.string(),
  /** The container's own revision; null where the host keeps none. */
  revision: REVISION.nullable(),
  name: z.string(),
  branchName: z.string().nullable(),
  archivedAt: TIMESTAMP,
  /**
   * When the retention sweep removes it; a locked container is kept. Null
   * where a locked container has no retention date (the web core).
   */
  expiresAt: TIMESTAMP.nullable(),
  locked: z.boolean(),
  lockedAt: TIMESTAMP.nullable(),
  chatCount: z.number().int().nonnegative(),
  archivedChatCount: z.number().int().nonnegative(),
  executionCount: z.number().int().nonnegative(),
  /** Some of it was restored; restoring again retries what is pending. */
  partiallyRestored: z.boolean(),
  /** A worktree whose setup was cancelled, so nothing was saved. */
  checkpointUnavailable: z.boolean().optional(),
  /**
   * The container's own ids (its project, and its worktree or chat), as a
   * restore's `restoredScope` names them, so a client never parses the
   * opaque `archiveId`. The web core sets it; the desktop omits it.
   */
  scope: CanopyWorkspaceScopeSchema.optional(),
});
export type ArchiveContainerSummary = z.output<
  typeof ArchiveContainerSummarySchema
>;

export const ArchiveContainerListParamsSchema = z.strictObject({
  /** Omitted: every project of the caller's (the web core only). */
  workspaceId: ID.optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const ArchiveContainerListResultSchema = z.strictObject({
  /** The project listed; null for an account-wide list. */
  workspaceId: ID.nullable(),
  containers: z.array(ArchiveContainerSummarySchema),
});
export type ArchiveContainerListResult = z.output<
  typeof ArchiveContainerListResultSchema
>;

/** The most messages one read returns, from the end of the transcript. */
export const ARCHIVE_CHAT_MESSAGE_LIMIT = 100;

export const ArchiveChatMessageSchema = z.strictObject({
  id: ID,
  role: z.enum(['user', 'assistant', 'system']),
  timestamp: z.number(),
  text: z.string(),
  truncated: z.boolean(),
});

export const ArchiveChatGetParamsSchema = z.strictObject({
  workspaceId: ID,
  archiveId: ID,
  chatId: ID,
  limit: z.number().int().min(1).max(ARCHIVE_CHAT_MESSAGE_LIMIT),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const ArchiveChatGetResultSchema = z.strictObject({
  workspaceId: ID,
  archiveId: ID,
  chatId: ID,
  title: z.string().nullable(),
  totalMessages: z.number().int().nonnegative(),
  messages: z.array(ArchiveChatMessageSchema),
});
export type ArchiveChatGetResult = z.output<typeof ArchiveChatGetResultSchema>;

export const ArchiveContainerUpdateParamsSchema = z.strictObject({
  workspaceId: ID,
  archiveId: ID,
  locked: z.boolean(),
  /** The container's listed `revision`; a host that keeps none refuses it. */
  expectedRevision: REVISION.optional(),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});
export type ArchiveContainerUpdateParams = z.output<
  typeof ArchiveContainerUpdateParamsSchema
>;

export const ArchiveContainerUpdateResultSchema = z.strictObject({
  container: ArchiveContainerSummarySchema,
});

export const ArchiveContainerDeleteParamsSchema = z.strictObject({
  workspaceId: ID,
  archiveId: ID,
  expectedRevision: REVISION,
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});
export type ArchiveContainerDeleteParams = z.output<
  typeof ArchiveContainerDeleteParamsSchema
>;

export const ArchiveContainerDeleteResultSchema = z.strictObject({
  archiveId: ID,
  deleted: z.literal(true),
  revision: REVISION,
});
export type ArchiveContainerDeleteResult = z.output<
  typeof ArchiveContainerDeleteResultSchema
>;

/** A caller of another authority: an archive answers only its own desktop. */
const FOREIGN_AUTHORITY = 'core.archive.foreignAuthority';

const NOT_FOUND_CODES = [
  'core.archive.container.notFound',
  'core.archive.chat.notFound',
] as const;

const BASE = {
  plane: 'core',
  domain: 'archive',
  version: 1,
  placement: 'core-only',
} as const;

// Served by the desktop dispatcher over Electron main's archived containers
// (CAN-6007), and by the web core over its retained items (CAN-6109). Like the
// restore, they stay out of the shared registries: the daemon does not serve
// them.
export const CORE_ARCHIVE_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.archive.container.list': defineCanopyQuery({
      ...BASE,
      idempotency: 'inherent',
      requiredGrants: [ARCHIVE_GRANTS.read],
      params: ArchiveContainerListParamsSchema,
      result: ArchiveContainerListResultSchema,
      error: inherentOperationErrorSchema([
        'core.archive.workspace.invalid',
        FOREIGN_AUTHORITY,
      ]),
    }),
    'core.archive.chat.get': defineCanopyQuery({
      ...BASE,
      idempotency: 'inherent',
      requiredGrants: [ARCHIVE_GRANTS.read],
      params: ArchiveChatGetParamsSchema,
      result: ArchiveChatGetResultSchema,
      error: inherentOperationErrorSchema([
        'core.archive.workspace.invalid',
        ...NOT_FOUND_CODES,
        FOREIGN_AUTHORITY,
      ]),
    }),
  },
);

export const CORE_ARCHIVE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.archive.container.update': defineCanopyInstruction({
      ...BASE,
      idempotency: 'keyed',
      requiredGrants: [ARCHIVE_GRANTS.write],
      params: ArchiveContainerUpdateParamsSchema,
      result: ArchiveContainerUpdateResultSchema,
      error: keyedOperationErrorSchema([
        'core.archive.workspace.invalid',
        'core.archive.container.notFound',
        'core.archive.revisionConflict',
        FOREIGN_AUTHORITY,
      ]),
    }),
  });

// Served by the web core only (CAN-6109): the desktop deletes its archives
// through its own IPC until a follow-up moves that delete here.
export const CORE_ARCHIVE_DELETE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.archive.container.delete': defineCanopyInstruction({
      ...BASE,
      idempotency: 'keyed',
      requiredGrants: [ARCHIVE_GRANTS.write],
      params: ArchiveContainerDeleteParamsSchema,
      result: ArchiveContainerDeleteResultSchema,
      error: keyedOperationErrorSchema([
        'core.archive.workspace.invalid',
        'core.archive.container.notFound',
        'core.archive.locked',
        'core.archive.revisionConflict',
        'core.archive.restoreInProgress',
        FOREIGN_AUTHORITY,
      ]),
    }),
  });
