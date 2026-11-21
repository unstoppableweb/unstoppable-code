/**
 * `chat.readVisual` over `chat:read-visual` (CAN-7432): one raw byte range of
 * a chat visual. The computer checks the reference's hash, size and archive
 * scope; this side rejects a reply of the wrong shape or one longer than the
 * requested range before the shared reader verifies the bytes.
 */
import type { QueryMap } from '@canopy/app-core';
import {
  CoreChatVisualReadResultSchema,
  type CoreChatVisualReadResult,
} from '@canopy/protocol/canopy-core';
import { REMOTE_IPC_CHANNELS as C } from '@canopy/protocol/remote-control/channels';
import {
  RemoteIpcMalformedReplyError,
  type ChannelClient,
} from './channel-client';

const isVisualReadResult = (
  value: unknown,
): value is CoreChatVisualReadResult =>
  CoreChatVisualReadResultSchema.safeParse(value).success;

export async function readChatVisual(
  channels: ChannelClient,
  args: QueryMap['chat.readVisual']['args'],
): Promise<CoreChatVisualReadResult> {
  const reply = await channels.invoke(C.chatReadVisual, isVisualReadResult, {
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    chatId: args.chatId,
    messageId: args.messageId,
    toolUseId: args.toolUseId,
    reference: args.reference,
    offset: args.offset,
    limit: args.limit,
    ...(args.archivedContainerId === undefined
      ? {}
      : { archivedContainerId: args.archivedContainerId }),
  });
  if (reply.length > args.limit)
    throw new RemoteIpcMalformedReplyError(C.chatReadVisual);
  return reply;
}
