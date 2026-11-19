import { z } from 'zod';
import { SelectionRefOwnerSchema } from '../../plugins/selection-ref-owner';

import { CODEX_SPEEDS } from '../../automations';
import {
  CLOUD_ATTACHMENTS_MAX_PER_MESSAGE,
  CLOUD_ATTACHMENT_MEDIA_TYPES,
  isCloudAttachmentFilename,
} from '../../cloud-attachments';
import { THINKING_LEVELS } from '../../thinking';

/*
 * Values the project, bot and chat host steps carry across the local worker
 * boundary (CAN-5077): the `send-agent-message` settings and text references,
 * and the send record a step returns. The executor's parsers and the shared
 * validators stay the authority on content; these schemas bound and close
 * the shapes those parsers already produce.
 */

const id = z.string().min(1).max(512);
const name = z.string().min(1).max(512);

/** The longest text a `send-agent-message` request carries, in UTF-16 code units. */
export const WORKER_PIPELINE_HOST_TEXT_MAX = 4 * 1024 * 1024;

const ShareablePluginSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('builtin'), id: name }),
  z.strictObject({ type: z.literal('github'), repo: name }),
]);

/** A portable plugin or skill reference (`ShareablePluginRef`). */
export const WorkerPipelinePluginRefSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('skill'),
    source: ShareablePluginSourceSchema,
    skill_name: name,
  }),
  z.strictObject({
    type: z.literal('plugin'),
    marketplace: ShareablePluginSourceSchema,
    plugin_name: name,
  }),
  z.strictObject({
    type: z.literal('claude_plugin'),
    marketplace: ShareablePluginSourceSchema,
    plugin_name: name,
  }),
  z.strictObject({
    type: z.literal('codex_plugin'),
    marketplace: z.strictObject({ type: z.literal('codex-builtin'), id: name }),
    plugin_name: name,
  }),
]);

const referenceText = {
  textStart: z.number().int().min(0).max(WORKER_PIPELINE_HOST_TEXT_MAX),
  displayText: z.string().min(1).max(WORKER_PIPELINE_HOST_TEXT_MAX),
};

/** A configured prompt reference (`ConfiguredPromptReference`). */
export const WorkerPipelinePromptReferenceSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('file'),
      ...referenceText,
      root: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('workspace') }),
        z.strictObject({ kind: z.literal('repo'), repoId: id }),
      ]),
      relativePath: z.string().min(1).max(4096),
    }),
    z.strictObject({
      kind: z.literal('plugin'),
      ...referenceText,
      plugin: z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('portable'),
          ref: WorkerPipelinePluginRefSchema,
        }),
        z.strictObject({
          kind: z.literal('installed'),
          marketplaceId: name,
          pluginName: name,
        }),
      ]),
    }),
  ],
);

const refs = <Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodArray<z.ZodObject<Shape, z.core.$strict>> =>
  z.array(z.strictObject(shape)).max(1024);

/**
 * Local plugin selections (`ChatTabPluginSelections`) as the step parser
 * normalizes them: legacy `bundleIds` already merged into `collectionIds`.
 */
export const WorkerPipelinePluginSelectionsSchema = z.strictObject({
  collectionIds: z.array(name).max(1024),
  skillRefs: refs({
    sourceId: name,
    skillName: name,
    owner: SelectionRefOwnerSchema.optional(),
  }),
  pluginRefs: refs({
    marketplaceId: name,
    pluginName: name,
    owner: SelectionRefOwnerSchema.optional(),
  }),
  mcpServerRefs: refs({
    serverId: name,
    configId: name,
    owner: SelectionRefOwnerSchema.optional(),
  }).optional(),
  mcpHttpAuthPreferences: refs({
    target: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('standalone'),
        serverId: name,
        configId: name,
      }),
      z.strictObject({
        kind: z.literal('plugin'),
        marketplaceId: name,
        pluginName: name,
        serverName: name,
      }),
    ]),
    handler: z.enum(['canopy', 'provider', 'account']),
  }).optional(),
  unresolvedCapabilities: refs({
    kind: z.enum(['plugin', 'mcp', 'skill']),
    sourceId: name,
    catalogId: name,
    name,
  }).optional(),
});

/** A send's per-turn settings; `model` is already resolved from its alias. */
export const WorkerPipelineSendSettingsSchema = z.strictObject({
  model: name.optional(),
  thinkingEffort: z.enum(THINKING_LEVELS).optional(),
  fastMode: z.boolean().optional(),
  /** The Codex speed, Ultra fast included; never with `fastMode`. */
  speed: z.enum(CODEX_SPEEDS).optional(),
  planMode: z.boolean().optional(),
  approvalMode: z.enum(['ask', 'auto', 'full-access']).optional(),
  plugins: z.array(WorkerPipelinePluginRefSchema).max(256).optional(),
  pluginSelections: WorkerPipelinePluginSelectionsSchema.optional(),
  interfaceMode: z.enum(['canopy', 'claude-code', 'auto']).optional(),
});

/**
 * The most bytes the files one `send-agent-message` request attaches may
 * hold together (CAN-6857, G6). An owner that can't read the step's host
 * paths (the cloud) gets a copy of each file with the request, so the
 * request, with its text, stays within one relay message.
 */
export const WORKER_PIPELINE_HOST_ATTACHMENTS_MAX_BYTES = 2 * 1024 * 1024;

/** The most files one request attaches: a cloud message's own limit. */
export const WORKER_PIPELINE_HOST_ATTACHMENTS_MAX =
  CLOUD_ATTACHMENTS_MAX_PER_MESSAGE;

/**
 * A copy of one file a `send-agent-message` step attaches, for an owner that
 * can't read the step's host paths (CAN-6857): its name, never its path, and
 * its bytes as base64, with their size and digest, which the owner checks.
 */
export const WorkerPipelineHostAttachmentSchema = z.strictObject({
  filename: z.string().refine(isCloudAttachmentFilename, {
    message: 'Not a portable file name.',
  }),
  mediaType: z.enum(CLOUD_ATTACHMENT_MEDIA_TYPES),
  size: z.number().int().min(0).max(WORKER_PIPELINE_HOST_ATTACHMENTS_MAX_BYTES),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Base64 of the whole file. */
  data: z
    .string()
    .max(Math.ceil(WORKER_PIPELINE_HOST_ATTACHMENTS_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});

export type WorkerPipelineHostAttachment = z.output<
  typeof WorkerPipelineHostAttachmentSchema
>;

export const WorkerPipelineHostAttachmentsSchema = z
  .array(WorkerPipelineHostAttachmentSchema)
  .min(1)
  .max(WORKER_PIPELINE_HOST_ATTACHMENTS_MAX)
  .refine(
    (files) =>
      files.reduce((total, file) => total + file.size, 0) <=
      WORKER_PIPELINE_HOST_ATTACHMENTS_MAX_BYTES,
    'The attached files are too large together.',
  );

export const WorkerPipelineChatAddressSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('project'),
    projectId: id,
    taskId: id,
    chatId: id,
  }),
  z.strictObject({
    kind: z.literal('bot'),
    botId: id,
    taskId: id,
    chatId: id,
  }),
]);

/**
 * The message a `send-agent-message` step sent (`PipelineChatSendRecord`).
 * The executor records it on the step, including on a failure whose message
 * was already accepted.
 */
export const WorkerPipelineChatSendRecordSchema = z.strictObject({
  version: z.literal(1),
  address: WorkerPipelineChatAddressSchema,
  /** The accepted input id; `automation_run` watchers match it as `userMessageId`. */
  userMessageId: id,
  queuedMessageId: id.optional(),
  state: z.enum(['sent', 'queued', 'steered']),
  chatCreated: z.boolean(),
  acceptedAt: id,
  turnId: id.optional(),
});
