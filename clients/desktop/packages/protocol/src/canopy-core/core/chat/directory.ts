import { z } from 'zod';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyWorkspaceScopeSchema,
} from '../shared';

const id = z.string().min(1).max(512);

export const CoreChatDirectoryListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.extend({ workspaceId: id, worktreeId: id }),
});
export type CoreChatDirectoryListParams = z.output<
  typeof CoreChatDirectoryListParamsSchema
>;

/** One live chat in a scope: its name fields, never its transcript or host paths. */
export const CoreChatDirectoryEntrySchema = z.strictObject({
  chatId: id,
  title: z.string(),
  customTitle: z.string().optional(),
  description: z.string().optional(),
  /** ISO time the chat was created, or null when the chat records none. */
  createdAt: z.string().nullable(),
  /** ISO time of the chat's last message, when it has one. */
  lastActivityAt: z.iso.datetime({ offset: true }).optional(),
});
export type CoreChatDirectoryEntry = z.output<
  typeof CoreChatDirectoryEntrySchema
>;

export const CoreChatDirectoryListResultSchema = z.strictObject({
  /** The scope's live chats, file tabs excluded. */
  live: z.array(CoreChatDirectoryEntrySchema),
  /** The IDs of the scope's archived chats. */
  archivedChatIds: z.array(id),
});
export type CoreChatDirectoryListResult = z.output<
  typeof CoreChatDirectoryListResultSchema
>;

export const CoreChatDirectoryListErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z.enum(['core.chat.directory.list.unavailable']).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  },
);
