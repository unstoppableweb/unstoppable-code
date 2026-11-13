import { TrackedPlanImplementationInputSchema } from '../../chat-plan-review';
import { z } from 'zod';
import { CODEX_SPEEDS } from '../../../automations';

// Nested core modules use ../../ for common canopy-core contracts.

import {
  CanopyRequestMetadataSchema,
  CHAT_CUSTOM_TITLE_MAX_LENGTH,
} from '../../common';

import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyRetryDirectiveSchema,
  canopyJsonValueSchemaWithin,
} from '../../errors';

const id = z.string().min(1).max(512);
const revision = z.number().int().nonnegative();
const json = CanopyJsonValueSchema;
export const CoreChatFileRefSchema = z.strictObject({
  fileRootId: id,
  relativePath: z
    .string()
    .min(1)
    .regex(/^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\\\0]+$/),
});
const keyedMetadata = CanopyRequestMetadataSchema.extend({
  idempotencyKey: id,
});
const origin = z.enum(['desktop', 'portal']);
/** A chat's model settings: thinking, speed and Codex context window. */
export const CoreChatModelConfigSchema = z.strictObject({
  thinkingLevel: z.string().optional(),
  fastMode: z.boolean().optional(),
  // A Codex context window preset, or tokens at or above the 128K floor
  // (`CODEX_CONTEXT_WINDOW_FLOOR` in desktop-shared).
  contextWindow: z
    .union([
      z.enum(['model-default', 'standard-pricing', 'maximum']),
      z.number().int().min(128_000),
    ])
    .optional(),
  speed: z.enum(CODEX_SPEEDS).optional(),
});
const modelConfig = CoreChatModelConfigSchema;
const providerType = z.enum([
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
]);
const fileViewMode = z.enum(['raw', 'preview', 'table', 'diff']);
const createTab = z.strictObject({
  type: z.literal('chat.create_tab'),
  tabId: id,
  seedTab: json.optional(),
  seedFileRef: CoreChatFileRefSchema.optional(),
  starter: z.boolean().optional(),
  title: z.string().optional(),
  providerType: providerType.optional(),
  model: z.string().optional(),
  defaultStampModel: z.string().optional(),
  modelConfig: modelConfig.optional(),
  planMode: z.boolean().optional(),
  proposalMode: z.enum(['optional', 'required']).optional(),
  pluginSelections: json.optional(),
  deferredToolsAllowed: z.boolean().optional(),
  interfaceMode: z.enum(['canopy', 'claude-code', 'auto']).optional(),
  selectedRepoId: id.optional(),
  approvalMode: z.string().optional(),
  aiCreditsRouting: json.optional(),
  subscriptionBillingOverride: z.boolean().optional(),
});
const createFileTab = z.strictObject({
  type: z.literal('chat.create_file_tab'),
  tabId: id,
  activate: z.boolean().optional(),
  fileRef: CoreChatFileRefSchema.optional(),
  title: z.string().optional(),
  viewMode: fileViewMode.optional(),
  pinned: z.boolean().optional(),
});
const settingsPatch = z.strictObject({
  customTitle: z
    .string()
    .min(1)
    .max(CHAT_CUSTOM_TITLE_MAX_LENGTH)
    // The absolute end assertion also rejects trailing newline whitespace.
    .regex(/^\S(?:[\s\S]*\S)?(?![\s\S])/)
    .nullable()
    .optional(),
  unread: z.boolean().optional(),
  description: z.string().optional(),
  autoArchive: z.boolean().nullable().optional(),
  pinned: z.boolean().optional(),
  fileViewMode: fileViewMode.nullable().optional(),
  fileDiffContext: json.optional(),
  title: z.string().optional(),
  providerType: providerType.optional(),
  model: z.string().optional(),
  modelSelectionMode: z.literal('auto').nullable().optional(),
  modelExplicitlyChosen: z.boolean().optional(),
  billingExplicitlyChosen: z.boolean().optional(),
  sdkSessionId: z.string().nullable().optional(),
  globalInstructionsSnapshot: z.string().optional(),
  modelConfig: modelConfig.optional(),
  thinkingLevel: z.string().optional(),
  codexFastModeEnabled: z.boolean().nullable().optional(),
  planMode: z.boolean().optional(),
  proposalMode: z.enum(['optional', 'required']).optional(),
  pluginSelections: json.optional(),
  deferredToolsAllowed: z.boolean().optional(),
  interfaceMode: z
    .enum(['canopy', 'claude-code', 'auto'])
    .nullable()
    .optional(),
  selectedRepoId: id.nullable().optional(),
  attentionDismissedAt: z.number().nonnegative().nullable().optional(),
  aiCreditsRouting: json.nullable().optional(),
  subscriptionBillingOverride: z.boolean().optional(),
  sharedRun: json.nullable().optional(),
  scheduledSendDraft: z
    .strictObject({ runAt: z.string() })
    .nullable()
    .optional(),
  pendingRevertAttachmentPath: z.null().optional(),
  newChatStartedWatcherPending: z.boolean().nullable().optional(),
  newChatStartedWatcherFiredAt: z.string().nullable().optional(),
  pendingPlanExit: json.nullable().optional(),
  pendingPlanExitRequestId: id.nullable().optional(),
  trackedPlanImplementation:
    TrackedPlanImplementationInputSchema.nullable().optional(),
  trackedPlanId: id.nullable().optional(),
  trackedPlanSource: z.string().nullable().optional(),
  trackedPlanReviewStatus: z.string().nullable().optional(),
  hasOutstandingProposal: z.boolean().optional(),
  latestRevisionNumber: revision.nullable().optional(),
  pendingSystemInstructions: z.array(json).nullable().optional(),
  agentArtifactCarryByTurn: json.nullable().optional(),
});

const createAction = z.discriminatedUnion('type', [createTab, createFileTab]);
const updateAction = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('chat.reject_plan_implementation_delivery'),
    chatId: id,
    userMessageId: TrackedPlanImplementationInputSchema.shape.userMessageId,
  }),
  z.strictObject({ type: z.literal('chat.activate_tab'), tabId: id }),
  z.strictObject({ type: z.literal('chat.reorder_tabs'), tabIds: z.array(id) }),
  z.strictObject({
    type: z.literal('chat.patch_tab_settings'),
    tabId: id,
    patch: settingsPatch,
    fileRef: CoreChatFileRefSchema.optional(),
    expectedPendingPlanExitRequestId: id.optional(),
    expectedPluginSelections: json.optional(),
  }),
  z.strictObject({
    type: z.literal('chat.set_model'),
    tabId: id,
    model: z.string(),
    providerType,
    executionHarness: z.string().optional(),
    settings: z
      .strictObject({
        thinkingLevel: z.string(),
        modelConfig,
        codexFastModeEnabled: z.boolean(),
        interfaceMode: z.enum(['canopy', 'claude-code', 'auto']).nullable(),
      })
      .optional(),
    preserveModelSelectionMode: z.literal(true).optional(),
    autoRoutedMessageId: id.optional(),
    notice: json.optional(),
  }),
  // Approval mode never travels in a settings patch.
  z.strictObject({
    type: z.literal('chat.set_approval_mode'),
    tabId: id,
    approvalMode: z.enum(['ask', 'auto', 'full-access']),
  }),
  z.strictObject({ type: z.literal('chat.mark_read'), chatId: id }),
  // `manual` marks a user's explicit "Mark as unread"; automatic marks omit it.
  z.strictObject({
    type: z.literal('chat.mark_unread'),
    chatId: id,
    manual: z.literal(true).optional(),
  }),
  z.strictObject({
    type: z.literal('chat.mark_archive_read'),
    archiveEntryId: id,
    unread: z.boolean(),
  }),
  z.strictObject({ type: z.literal('chat.mark_all_archives_read') }),
  z.strictObject({
    type: z.literal('chat.dismiss_attention'),
    chatId: id,
    attentionVersion: revision.optional(),
  }),
]);
const closeMode = z.enum(['archive', 'discard_empty', 'discard']);
const replacement = {
  replacementTabId: id.optional(),
  replacementTab: createTab.optional(),
};
const archiveAction = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('chat.archive_tab'),
    tabId: id,
    unread: z.boolean().optional(),
    keepSession: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('chat.restore_archive'),
    archiveEntryId: id,
    targetTabId: id.optional(),
  }),
]);
const deleteAction = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('chat.close_tab'),
    tabId: id,
    mode: closeMode,
    ...replacement,
  }),
  z.strictObject({
    type: z.literal('chat.close_tabs'),
    targets: z
      .array(z.strictObject({ tabId: id, mode: closeMode }))
      .min(1)
      .max(1_000),
    ...replacement,
  }),
]);
// Legacy fork carries only an empty destination tab, so its create shape is closed to seeds.
const forkDestination = z.strictObject({
  type: z.literal('chat.create_tab'),
  tabId: id,
  seedTab: json,
  seedFileRef: CoreChatFileRefSchema.optional(),
});
const forkAction = z.strictObject({
  type: z.literal('chat.fork_tab'),
  sourceTabId: id,
  targetTabId: id,
  atMessageId: id.optional(),
  sourceSdkSessionId: z.string().optional(),
  syncWarning: z.string().optional(),
  /**
   * `continuation` clones into a new tab (desktop OpenCode); `in-place`
   * continues an ended cloud chat on its own tab from `sourceSdkSessionId`,
   * the ended session the client saw (CAN-6106).
   */
  cloneMode: z.enum(['continuation', 'in-place']).optional(),
  /** Fast mode for the session an `in-place` continue creates. */
  fastMode: z.boolean().optional(),
  destinationCreate: forkDestination.optional(),
});

const envelope = {
  projectId: id,
  worktreeId: id,
  commandId: id,
  origin: origin.optional(),
  expectedRevision: revision.optional(),
  expectedTabRevision: revision.optional(),
  _meta: keyedMetadata,
};

export const CoreChatCreateParamsSchema = z.strictObject({
  ...envelope,
  action: createAction,
});
/**
 * The minor schema revision `core.chat.update` serves (protocol rule 5,
 * CAN-6092): revision 2 adds a `pluginSelections` patch's `capabilities`. A
 * runtime advertises it in its manifest; a client asks for it with `revision`
 * only when it is advertised, and a client that does not ask gets revision 1
 * output.
 */
export const CORE_CHAT_UPDATE_SCHEMA_REVISION = 2;

/**
 * The minor schema revision `core.chat.message.send` serves (protocol rule 5,
 * CAN-6092): revision 2 adds what the web core's send accepted the turn with
 * (its session, model, routing and capability state). Asked for with
 * `revision` only when advertised; a client that does not ask gets revision
 * 1 output.
 */
export const CORE_CHAT_MESSAGE_SEND_SCHEMA_REVISION = 2;

const capabilityBundleRef = z.strictObject({
  version: z.number().int(),
  digest: z.string().min(1),
});

/**
 * A capability state detail, bounded by a framed binding's 8 MiB frame
 * rather than the 32 KiB JSON detail bound: a large selection's pruning list
 * exceeds that, and the PUT answers it whole (CAN-6092).
 */
const capabilityStateJson = canopyJsonValueSchemaWithin(8 * 1024 * 1024);

/**
 * A chat's capability state, with the fields `PUT /cloud/chats/:id/capabilities`
 * answers (CAN-6092): what a selection patch or a send left on the web core.
 * Output only; the desktop core never sets it.
 */
export const CoreChatCapabilityStateSchema = z.strictObject({
  capabilityBundles: z.strictObject({
    activeBundle: capabilityBundleRef.optional(),
    pendingBundle: capabilityBundleRef.optional(),
  }),
  capabilityBundleStateVersion: z.number().int().nonnegative(),
  capabilitySelections: capabilityStateJson.optional(),
  inheritedCapabilitySelections: capabilityStateJson.optional(),
  capabilityUnavailable: capabilityStateJson.optional(),
  capabilityPruned: capabilityStateJson.optional(),
  warnings: z.array(z.string()),
});

export const CoreChatUpdateParamsSchema = z.strictObject({
  ...envelope,
  action: updateAction,
  /** Revision 2 output, sent only when the runtime advertises it. */
  revision: z.literal(CORE_CHAT_UPDATE_SCHEMA_REVISION).optional(),
});
export const CoreChatArchiveParamsSchema = z.strictObject({
  ...envelope,
  action: archiveAction,
});
export const CoreChatDeleteParamsSchema = z.strictObject({
  ...envelope,
  action: deleteAction,
});
export const CoreChatForkParamsSchema = z.strictObject({
  ...envelope,
  action: forkAction,
});

export const CoreChatLifecycleResultSchema = z
  .object({
    commandId: id,
    revision,
    outcome: z.enum([
      'applied',
      'already_applied',
      'conflict',
      'not_found',
      'rejected',
    ]),
    reason: z.string().optional(),
    entityId: id.optional(),
    messageId: id.optional(),
    /** Set when the command archived chats: the archive entries' `archivedAt`. */
    archivedAt: z.string().optional(),
    /**
     * A `chat.set_model` change's model as the chat now has it, when the
     * core reports it (CAN-6092): the resolved id (a gateway row's new id on
     * its first pick) and the settings the change confirmed.
     */
    model: z
      .object({
        id: z.string().nullable(),
        thinkingLevel: z.string().nullable(),
        fastMode: z.boolean().optional(),
      })
      .optional(),
  })
  .catchall(CanopyJsonValueSchema);

export const CoreChatLifecycleErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.chat.invalidState',
      'core.chat.revisionConflict',
      'core.chat.notFound',
    ])
    .optional(),
  retry: z.discriminatedUnion('kind', [
    CanopyRetryDirectiveSchema.options[0],
    CanopyRetryDirectiveSchema.options[2],
    CanopyRetryDirectiveSchema.options[3],
  ]),
});

export const CoreChatForkErrorSchema = CoreChatLifecycleErrorSchema.extend({
  code: z
    .enum([
      'core.chat.notFound',
      'core.chat.revisionConflict',
      'core.chat.forkBoundaryNotFound',
      'core.chat.notTransferable',
      'core.chat.limitReached',
    ])
    .optional(),
});
