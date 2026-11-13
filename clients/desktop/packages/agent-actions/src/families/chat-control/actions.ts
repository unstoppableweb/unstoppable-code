import { z } from 'zod';
import { ENVIRONMENT_MAX_ID_LENGTH } from '../environment/actions';

export const CHAT_CONTROL_ACTION_TYPES = [
  'chat.interrupt',
  'chat.cancel',
  'chat.archive',
] as const;

export type ChatControlActionType = (typeof CHAT_CONTROL_ACTION_TYPES)[number];

const chatIdSchema = z.string().trim().min(1).max(ENVIRONMENT_MAX_ID_LENGTH);

/** Every chat control action names one target chat and nothing else. */
export const chatControlActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('chat.interrupt'), chatId: chatIdSchema }),
  z.strictObject({ type: z.literal('chat.cancel'), chatId: chatIdSchema }),
  z.strictObject({ type: z.literal('chat.archive'), chatId: chatIdSchema }),
]);

export type ChatControlAction = z.output<typeof chatControlActionSchema>;
