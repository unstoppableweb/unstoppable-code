import { z } from 'zod';

export const CLOUD_CHAT_ACTION_TYPES = [
  'cloud_chats.list',
  'cloud_chats.open',
] as const;

/** A cloud chat id: a task's root chat, as `cloud_chats.list` returns it. */
const cloudChatIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^:\s]+$/);

/**
 * Reads and opens the cloud chats the main window's sidebar shows. Results
 * carry ids and titles only, never transcript content.
 */
export const cloudChatActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('cloud_chats.list') }),
  z.strictObject({
    type: z.literal('cloud_chats.open'),
    chatId: cloudChatIdSchema,
  }),
]);

export type CloudChatAction = z.infer<typeof cloudChatActionSchema>;

/** One cloud chat as the sidebar lists it. */
export interface CloudChatListEntry {
  readonly chatId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
}
