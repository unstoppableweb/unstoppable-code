import { z } from 'zod';
import { hasHostAbsolutePath, isHostAbsolutePath } from './host-paths';
import { CanopyWorkspaceScopeSchema } from '../../common';
import { CanopyStreamCursorSchema } from '../../definitions';
import { MODEL_LIBRARY_ACCESS_VALUES } from '../../../models/model-library-access';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyJsonValueSchema,
  canopyJsonValueSchemaWithin,
} from '../../errors';

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
/**
 * A cloud listing record passed through unchanged (CAN-6111). Its values are
 * bounded only by the web core's largest message (16 MiB), not the 32 KiB of
 * a plain JSON value: the cloud stores 128,000 characters of setup output and
 * first messages of any length, and one oversized record would fail the
 * whole listing.
 */
export const CoreCloudRecordSchema = z.record(
  z.string(),
  canopyJsonValueSchemaWithin(16 * 1024 * 1024),
);

/**
 * The cloud sidebar's fields (CAN-6111), as `GET /api/cloud/workspaces`
 * sends them; the nested records are its own, unchanged. Free text and those
 * records are exempt from the host path refusal: their text may start with
 * `/`, and a path in them is the cloud sandbox's (a setup command or its
 * log), which the REST listing already shows the same caller, never one of
 * the serving host's.
 */
const CLOUD_WORKSPACE_FIELDS = {
  description: z.string().nullable().optional(),
  defaultModelDefinitionId: id.nullable().optional(),
  deletionRetentionDays: count.optional(),
  chatsHome: z.literal(true).optional(),
  retainedChatCount: count.optional(),
  coreSandboxId: id.nullable().optional(),
  repository: CoreCloudRecordSchema.nullable().optional(),
  itemGroups: z.array(CoreCloudRecordSchema).optional(),
  itemGroupsRevision: count.optional(),
  itemGroupingAvailable: z.boolean().optional(),
  modelLibrary: z.enum(MODEL_LIBRARY_ACCESS_VALUES).optional(),
  chats: z.array(CoreCloudRecordSchema).optional(),
};
const HOST_PATH_EXEMPT: ReadonlySet<string> = new Set([
  'workspaceId',
  'name',
  'description',
  'repository',
  'itemGroups',
  'chats',
]);

// The typed fields use the `core.workspace.update` patch's value schemas, so a
// read value echoed back as an edit is accepted (W5a2, decision B3). The
// daemon's hosted metadata commands validate section ids against it (W5d1).
export const CORE_WORKSPACE_ACTIVITY_SECTION_IDS = [
  'plugins',
  'summary',
  'changed-files',
  'pull-request',
  'background-processes',
  'plans',
  'pipeline-runs',
  'cost',
  'scripts',
  'hooks',
  'terminals',
  'todo',
  'mcp-servers',
  'notes',
  'prompts',
  'attachments',
  'memory',
] as const;

const CoreWorkspaceActivitySectionOrderSchema = z
  .array(z.enum(CORE_WORKSPACE_ACTIVITY_SECTION_IDS))
  .max(CORE_WORKSPACE_ACTIVITY_SECTION_IDS.length)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate section id');

/**
 * The desktop's stored start page path rule (`isSafePortableRelativePath`),
 * and never a spelling the result's host path refusal would reject.
 */
function isPortableRelativePath(path: string): boolean {
  return (
    !isHostAbsolutePath(path) &&
    !path.includes('\\') &&
    !/^[A-Za-z]:/.test(path) &&
    path
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

/** `inherit`: no machine-local override; `null`: explicitly disabled. */
const CoreWorkspaceStartPageSchema = z.union([
  z.strictObject({
    kind: z.literal('file'),
    repoId: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    path: z
      .string()
      .min(1)
      .max(4096)
      .regex(/\S/)
      .refine(isPortableRelativePath, 'Not a portable relative path'),
  }),
  z.strictObject({
    kind: z.literal('url'),
    url: z
      .url({ protocol: /^https?$/ })
      .max(4096)
      // The patch's case-sensitive `^https?://` pattern.
      .refine((url) => /^https?:\/\/\S*$/.test(url), 'Not an http(s) URL'),
  }),
  z.strictObject({ kind: z.literal('inherit') }),
  z.null(),
]);

export const CoreWorkspaceSchema = z
  .object({
    workspaceId: id,
    name: z.string().min(1),
    kind: z.enum(['git', 'cowork']),
    /** Owning organization; null is Personal. Absent when the authority does not scope by organization. */
    ownerOrganizationId: id.nullable().optional(),
    revision: z.number().int().nonnegative().optional(),
    createdAt: timestamp.optional(),
    updatedAt: timestamp.optional(),
    repositorySources: z.array(
      z
        .object({
          repoId: id,
          remoteUrl: z.string().min(1).max(4096),
          defaultBranch: id.optional(),
        })
        .catchall(CanopyJsonValueSchema),
    ),
    // Retained empty for compatibility; the typed fields below replace it.
    settings: z.object({}).catchall(CanopyJsonValueSchema),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    pinned: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    itemSortMode: z.enum(['manual', 'last-updated']).optional(),
    activitySectionOrder: CoreWorkspaceActivitySectionOrderSchema.optional(),
    alwaysShow: z.boolean().optional(),
    startPage: CoreWorkspaceStartPageSchema.optional(),
    ...CLOUD_WORKSPACE_FIELDS,
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
export type CoreWorkspace = z.output<typeof CoreWorkspaceSchema>;

export const CoreWorkspaceListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  pageSize: z.number().int().min(1).max(500).default(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
export const CoreWorkspaceGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  workspaceId: id,
});
export const CoreWorkspaceListResultSchema = z
  .object({
    items: z.array(CoreWorkspaceSchema).max(500),
    nextCursor: z.string().max(2048).nullable(),
    // The `workspaces` collection's membership and order, not its items'
    // contents; only on a complete, verified listing (CAN-5319).
    collectionRevision: z.number().int().nonnegative().optional(),
    // The cloud listing's realtime position: `core.events.subscribe` for the
    // account families resumes from it (CAN-6111).
    realtimeCursor: CanopyStreamCursorSchema.optional(),
    cloudChatSharingEnabled: z.boolean().optional(),
  })
  .catchall(CanopyJsonValueSchema);
export const CoreWorkspaceGetResultSchema = CoreWorkspaceSchema;
export const CoreWorkspaceErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.workspace.invalidState',
      'core.workspace.revisionConflict',
      'core.workspace.notFound',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
