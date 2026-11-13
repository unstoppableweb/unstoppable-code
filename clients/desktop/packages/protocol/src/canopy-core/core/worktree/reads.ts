import { z } from 'zod';
import { hasHostAbsolutePath } from '../workspace/host-paths';
import { CoreCloudRecordSchema } from '../workspace/reads';
import { CanopyWorkspaceScopeSchema } from '../../common';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyJsonValueSchema,
} from '../../errors';

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();

/**
 * The cloud sidebar's worktree fields (CAN-6111), as `GET
 * /api/cloud/workspaces` sends them; the nested records are its own,
 * unchanged. They and the label are exempt from the host path refusal: a
 * path in them is the cloud sandbox's (a setup command, its log, an error),
 * which the REST listing already shows the same caller, never one of the
 * serving host's.
 */
const CLOUD_WORKTREE_FIELDS = {
  label: z.string().nullable().optional(),
  hidden: z.boolean().optional(),
  /** The cloud's own state (`CREATING` … `ARCHIVED`) beside `state`. */
  cloudState: z.string().min(1).optional(),
  stateError: CoreCloudRecordSchema.nullable().optional(),
  lifecycle: z.string().min(1).optional(),
  lifecycleRevision: count.optional(),
  lastActivityAt: timestamp.nullable().optional(),
  archivedAt: timestamp.nullable().optional(),
  expiresAt: timestamp.nullable().optional(),
  coreSandboxId: id.nullable().optional(),
  sandboxRevision: count.optional(),
  repositories: z.array(CoreCloudRecordSchema).optional(),
  archive: CoreCloudRecordSchema.nullable().optional(),
  recovery: CoreCloudRecordSchema.nullable().optional(),
  setup: CoreCloudRecordSchema.nullable().optional(),
  firstMessage: CoreCloudRecordSchema.nullable().optional(),
  activeCombine: CoreCloudRecordSchema.nullable().optional(),
};
const HOST_PATH_EXEMPT: ReadonlySet<string> = new Set([
  'name',
  'label',
  'stateError',
  'repositories',
  'archive',
  'recovery',
  'setup',
  'firstMessage',
  'activeCombine',
]);

export const CoreWorktreeSchema = z
  .object({
    worktreeId: id,
    workspaceId: id,
    name: z.string().min(1),
    state: z.enum(['creating', 'ready', 'archived', 'deleting', 'error']),
    revision: z.number().int().nonnegative().optional(),
    baseBranch: id.nullable(),
    branch: id,
    targetId: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: timestamp.optional(),
    ...CLOUD_WORKTREE_FIELDS,
  })
  .catchall(CanopyJsonValueSchema)
  .refine(
    (value) =>
      !Object.entries(value).some(
        ([key, field]) =>
          !HOST_PATH_EXEMPT.has(key) && hasHostAbsolutePath(field),
      ),
    'Canonical results cannot contain host paths',
  );
export type CoreWorktree = z.output<typeof CoreWorktreeSchema>;

export const CoreWorktreeListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  pageSize: z.number().int().min(1).max(500).default(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
export const CoreWorktreeGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  worktreeId: id,
});
export const CoreWorktreeListResultSchema = z
  .object({
    items: z.array(CoreWorktreeSchema).max(500),
    nextCursor: z.string().max(2048).nullable(),
    // One workspace's worktree collection: membership and order, not its
    // items' contents. Only on a complete, verified workspace-scoped listing;
    // no revision spans workspaces (CAN-5319).
    collectionRevision: z.number().int().nonnegative().optional(),
  })
  .catchall(CanopyJsonValueSchema);
export const CoreWorktreeGetResultSchema = CoreWorktreeSchema;
export const CoreWorktreeErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.worktree.invalidState',
      'core.worktree.revisionConflict',
      'core.worktree.notFound',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
