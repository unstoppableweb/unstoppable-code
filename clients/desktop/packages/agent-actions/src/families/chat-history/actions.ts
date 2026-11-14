import { z } from 'zod';
import {
  MemoryChatSearchParamsSchema,
  MemoryChatExcerptParamsSchema,
} from '@canopy/protocol/canopy-core';

export const CHAT_HISTORY_ACTION_TYPES = [
  'chat.history.search',
  'chat.history.excerpt',
] as const;
export const chatHistoryActionSchema = z.discriminatedUnion('type', [
  MemoryChatSearchParamsSchema.omit({ scope: true, _meta: true }).extend({
    type: z.literal('chat.history.search'),
  }),
  MemoryChatExcerptParamsSchema.omit({ scope: true, _meta: true }).extend({
    type: z.literal('chat.history.excerpt'),
  }),
]);
export type ChatHistoryAction = z.output<typeof chatHistoryActionSchema>;
