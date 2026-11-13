import {
  TrackedPlanImplementationInputSchema,
  ChatPlanReviewApprovalSchema,
} from '../../chat-plan-review';
import { z } from 'zod';
import { CoreChatModelConfigSchema } from './commands-lifecycle';
import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
} from '../../common';

import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyRetryDirectiveSchema,
  type CanopyErrorPayload,
  type CanopyOperationCode,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../shared-messaging';

const IdentifierSchema = z.string().min(1).max(512);
const RevisionSchema = z.number().int().nonnegative();

const ChatCommandScopeSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  worktreeId: IdentifierSchema,
});

const ChatCommandBaseSchema = z.strictObject({
  scope: ChatCommandScopeSchema,
  commandId: IdentifierSchema,
  chatId: IdentifierSchema,
  expectedRevision: RevisionSchema.optional(),
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: IdentifierSchema,
  }),
});

export const CoreChatCommandReceiptSchema = z
  .object({
    commandId: IdentifierSchema,
    revision: RevisionSchema,
    outcome: z.enum([
      'applied',
      'already_applied',
      'conflict',
      'not_found',
      'rejected',
    ]),
    reason: z.string().optional(),
    entityId: IdentifierSchema.optional(),
    messageId: IdentifierSchema.optional(),
  })
  .catchall(CanopyJsonValueSchema);

export const CoreChatMessageSendParamsSchema = ChatCommandBaseSchema.extend({
  trackedPlanImplementation: TrackedPlanImplementationInputSchema.optional(),
  planReviewApproval: ChatPlanReviewApprovalSchema.optional(),
  messageId: IdentifierSchema,
  text: z.string(),
  /** Attachments uploaded to this chat before the send; a host without uploads refuses them. */
  attachments: z
    .array(z.strictObject({ attachmentId: IdentifierSchema }))
    .min(1)
    .max(10)
    .optional(),
  /**
   * This message's model, as the core's catalog and `chat.set_model` name it;
   * absent keeps the chat's (CAN-6092).
   */
  model: IdentifierSchema.optional(),
  /** This message's thinking and speed settings; absent keeps the chat's. */
  modelConfig: CoreChatModelConfigSchema.optional(),
  /** The account's workspace files the message mentions; a host without them refuses. */
  fileReferences: z
    .array(
      z.strictObject({
        kind: z.literal('workspace-file'),
        workspaceFileId: IdentifierSchema,
      }),
    )
    .min(1)
    .max(20)
    .optional(),
  origin: z
    .strictObject({
      kind: z.literal('terminalInitialPrompt'),
      turnTimerMessageId: IdentifierSchema,
    })
    .optional(),
})
  .refine(
    (params) =>
      !params.origin ||
      (!params.planReviewApproval && !params.trackedPlanImplementation),
    {
      message: 'Plan approval requires a canonical implementation message.',
    },
  )
  .refine(
    (params) =>
      !params.trackedPlanImplementation ||
      (params.trackedPlanImplementation.userMessageId === params.messageId &&
        (!params.planReviewApproval ||
          (params.planReviewApproval.planId ===
            params.trackedPlanImplementation.planId &&
            params.planReviewApproval.revisionNumber ===
              params.trackedPlanImplementation.revisionNumber))),
    {
      message:
        'Implementation must identify the sent message and reviewed revision.',
    },
  );

/** A queued entry's revision as the caller last read it (CAN-4112). */
const EntryRevisionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

export const CoreChatQueueEntryCancelParamsSchema =
  ChatCommandBaseSchema.extend({
    entryId: IdentifierSchema,
    entryRevision: EntryRevisionSchema.optional(),
  });

export const CoreChatQueueEntryUpdateParamsSchema =
  ChatCommandBaseSchema.extend({
    entryId: IdentifierSchema,
    entryRevision: EntryRevisionSchema.optional(),
    mutation: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('edit'),
        text: z.string(),
        inputMode: z.enum(['typed', 'voice']).optional(),
      }),
      z.strictObject({ kind: z.literal('steer') }),
      z.strictObject({
        kind: z.literal('move'),
        beforeEntryId: IdentifierSchema.nullable(),
      }),
      z.strictObject({
        kind: z.literal('lock'),
        /** true holds the entry for editing; false releases it. */
        locked: z.boolean(),
        /** The holder's acquisition; an unlock names the acquisition it releases. */
        acquisitionId: IdentifierSchema.optional(),
      }),
    ]),
  });

export const CoreChatQueueEntryForceParamsSchema = ChatCommandBaseSchema.extend(
  {
    entryId: IdentifierSchema,
    entryRevision: EntryRevisionSchema.optional(),
  },
);

export const CoreChatTurnCancelParamsSchema = z.strictObject({
  chatId: IdentifierSchema,
  turnId: IdentifierSchema,
  reason: z.enum(['user', 'superseded', 'shutdown', 'policy', 'timeout']),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const CoreChatTurnCancelResultSchema = z
  .object({
    chatId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    worktreeId: z.string().nullable(),
    title: z.string().max(512),
    state: z.enum([
      'idle',
      'queued',
      'running',
      'awaiting_user',
      'completed',
      'failed',
      'archived',
    ]),
    revision: RevisionSchema,
    providerId: z.string().nullable().optional(),
    modelId: z.string().nullable().optional(),
    providerSessionId: z.string().nullable().optional(),
    targetId: z.string().nullable().optional(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .catchall(CanopyJsonValueSchema);

export const CoreChatTurnCancelErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.chat.turn.invalidState',
      'core.chat.turn.revisionConflict',
      'core.chat.turn.notFound',
    ])
    .optional(),
  retry: z.discriminatedUnion('kind', [
    CanopyRetryDirectiveSchema.options[0],
    CanopyRetryDirectiveSchema.options[1],
    CanopyRetryDirectiveSchema.options[3],
  ]),
});

const KeyedRetrySchema = z.discriminatedUnion('kind', [
  CanopyRetryDirectiveSchema.options[0],
  CanopyRetryDirectiveSchema.options[2],
  CanopyRetryDirectiveSchema.options[3],
]);

function keyedErrorSchema<
  const Codes extends [CanopyOperationCode, ...CanopyOperationCode[]],
>(codes: Codes): z.ZodType<CanopyErrorPayload> {
  return CanopyErrorPayloadSchema.extend({
    code: z.enum(codes).optional(),
    retry: KeyedRetrySchema,
  });
}

export const CORE_CHAT_MESSAGE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.chat.message.send': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatMessageSendParamsSchema,
      result: CoreChatCommandReceiptSchema,
      error: keyedErrorSchema([
        'core.chat.message.invalidState',
        'core.chat.message.revisionConflict',
        'core.chat.message.notFound',
      ]),
    }),
    'core.chat.queue.entry.cancel': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatQueueEntryCancelParamsSchema,
      result: CoreChatCommandReceiptSchema,
      error: keyedErrorSchema([
        'core.chat.entryNotQueued',
        'core.chat.revisionConflict',
      ]),
    }),
    'core.chat.queue.entry.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatQueueEntryUpdateParamsSchema,
      result: CoreChatCommandReceiptSchema,
      error: keyedErrorSchema([
        'core.chat.entryNotQueued',
        'core.chat.revisionConflict',
        'core.chat.busy',
      ]),
    }),
    'core.chat.turn.cancel': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.write'],
      params: CoreChatTurnCancelParamsSchema,
      result: CoreChatTurnCancelResultSchema,
      error: CoreChatTurnCancelErrorSchema,
    }),
    'core.chat.queue.entry.force': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatQueueEntryForceParamsSchema,
      result: CoreChatCommandReceiptSchema,
      error: keyedErrorSchema([
        'core.chat.entryNotQueued',
        'core.chat.revisionConflict',
        'core.chat.busy',
        'core.chat.policyDenied',
      ]),
    }),
  });
