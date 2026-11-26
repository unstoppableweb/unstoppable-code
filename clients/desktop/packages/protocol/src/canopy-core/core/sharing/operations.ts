import { z } from 'zod';
import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { inherentOperationErrorSchema } from '../shared';

/**
 * Sharing (CAN-6046): the cloud chats shared with the caller and by the
 * caller in one organization, with what the chat list shows for each row.
 * Served by the web core only; desktop and the daemon don't register these
 * definitions.
 */

/** Page size: 20 by default, at most 50, like the REST shared-container lists. */
export const SHARED_CHAT_LIST_DEFAULT_LIMIT = 20;
export const SHARED_CHAT_LIST_MAX_LIMIT = 50;

const isoInstant = z.iso.datetime({ offset: true });
const cursor = z.string().min(1).max(512);

export const SharedChatListParamsSchema = z.strictObject({
  organizationId: z.uuid(),
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(SHARED_CHAT_LIST_MAX_LIMIT).optional(),
});
export type SharedChatListParams = z.output<typeof SharedChatListParamsSchema>;

/** A chat shared with the caller, as the recipient's chat list shows it. */
export const SharedWithMeChatSchema = z.strictObject({
  containerId: z.uuid(),
  chatId: z.uuid(),
  organizationId: z.uuid(),
  title: z.string(),
  createdAt: isoInstant,
  /** What the caller may do now: the grant, narrowed to VIEW as the share access check narrows it. */
  capabilities: z
    .array(z.enum(['VIEW', 'PROMPT']))
    .min(1)
    .max(2),
  /** The owner as this organization names them. */
  owner: z.strictObject({
    userId: z.uuid(),
    name: z.string(),
    image: z.string().optional(),
  }),
  /** The owner's project the chat belongs to. */
  workspace: z.strictObject({ id: z.uuid(), name: z.string() }).optional(),
  /** The chat's Core session; null until Core provisions it. */
  sessionId: z.string().min(1).nullable(),
  protocolVersion: z.union([z.literal(1), z.literal(2)]),
});
export type SharedWithMeChat = z.output<typeof SharedWithMeChatSchema>;

/** A chat the caller shared, with how many people it is shared with. */
export const SharedByMeChatSchema = z.strictObject({
  containerId: z.uuid(),
  chatId: z.uuid(),
  organizationId: z.uuid(),
  /** Grants, pending invites and dismissals, as the recipients list counts them. */
  recipientCount: z.number().int().min(0),
});
export type SharedByMeChat = z.output<typeof SharedByMeChatSchema>;

export const SharedWithMeChatsListResultSchema = z.strictObject({
  chats: z.array(SharedWithMeChatSchema),
  nextCursor: cursor.nullable(),
});
export type SharedWithMeChatsListResult = z.output<
  typeof SharedWithMeChatsListResultSchema
>;

export const SharedByMeChatsListResultSchema = z.strictObject({
  chats: z.array(SharedByMeChatSchema),
  nextCursor: cursor.nullable(),
});
export type SharedByMeChatsListResult = z.output<
  typeof SharedByMeChatsListResultSchema
>;

export const SHARING_ERROR_CODES = {
  storeUnavailable: 'core.sharing.storeUnavailable',
} as const;

/** Browser sessions only; agent sessions never hold it. */
export const SHARING_READ_GRANT = 'core.sharing.read';

const BASE = {
  plane: 'core',
  domain: 'sharing',
  version: 1,
  placement: 'core-only',
} as const;

// Web-core only. Do not compose into desktop or daemon definitions.
export const CORE_SHARING_QUERIES = defineCanopyQueryRegistry('core', {
  'core.sharing.chats.sharedWithMe.list': defineCanopyQuery({
    ...BASE,
    requiredGrants: ['core.sharing.read'],
    idempotency: 'inherent',
    params: SharedChatListParamsSchema,
    result: SharedWithMeChatsListResultSchema,
    error: inherentOperationErrorSchema([SHARING_ERROR_CODES.storeUnavailable]),
  }),
  'core.sharing.chats.sharedByMe.list': defineCanopyQuery({
    ...BASE,
    requiredGrants: ['core.sharing.read'],
    idempotency: 'inherent',
    params: SharedChatListParamsSchema,
    result: SharedByMeChatsListResultSchema,
    error: inherentOperationErrorSchema([SHARING_ERROR_CODES.storeUnavailable]),
  }),
});
