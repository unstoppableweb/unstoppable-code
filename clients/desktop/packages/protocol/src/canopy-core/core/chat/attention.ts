import { z } from 'zod';
import { CanopyJsonValueSchema } from '../../errors';

/*
 * Account-wide chat attention events (CAN-6113), served by the web core on
 * `core.events.subscribe` in the `core.chat.attention` family, a refinement
 * of `core.chat`: a question or tool approval in one of the caller's cloud
 * chats started or ended. Identifiers only; the chat's own reads carry the
 * request. Payloads may gain optional fields.
 */

/** The family an account-wide attention subscriber names. */
export const CORE_CHAT_ATTENTION_EVENT_FAMILY = 'core.chat.attention';
/** Scoped `{ workspaceId, chatId }`. */
export const CORE_CHAT_ATTENTION_CHANGED_EVENT = 'core.chat.attention.changed';

export const CoreChatAttentionChangedPayloadSchema = z
  .object({
    /** The interaction id `core.chat.question.respond` and approvals take. */
    interactionId: z.string().min(1).max(512),
    kind: z.enum(['question', 'approval']),
    /** `resolved`: answered, expired or cancelled. */
    state: z.enum(['requested', 'resolved']),
    /** When an unanswered request expires; on `requested` only. */
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .catchall(CanopyJsonValueSchema);
export type CoreChatAttentionChangedPayload = z.output<
  typeof CoreChatAttentionChangedPayloadSchema
>;
