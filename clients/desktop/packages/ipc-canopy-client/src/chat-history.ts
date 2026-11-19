/**
 * `chat.history` over `chat:get-transcript-page`.
 *
 * The host pages a chat's persisted transcript newest-first by message
 * ordinal: each page carries `before` (the exclusive upper ordinal of the next
 * older page, absent at the start) and the `transcriptRevision` it was read
 * at. The opaque {@link RemoteControlTranscriptCursor} this module returns encodes
 * both, so the next request reads the same transcript revision; a host whose
 * transcript has since been rewritten rejects it, and the caller restarts
 * from `before: null` (the newest page). Messages are projected exactly as
 * the Portal transcript projects persisted rows (delegation cards bounded,
 * tool family through the injected resolver); consumers merge by
 * `messageId`, so overlap with the live tail is harmless.
 *
 * Differences from the Portal relay, recorded in the parity map: there is no
 * live-tail watermark (a `before: null` request returns the newest persisted
 * page), `limitTurns` is advisory (the host's page size applies; pages are
 * not split by this module), and turn timers keep their persisted ids.
 */
import type {
  RemoteControlChatHistoryChunk,
  RemoteControlChatHistoryRequest,
  RemoteControlChatMessage,
  RemoteControlTranscriptCursor,
} from '@canopy/protocol/remote-control/shell';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/protocol/chat-targets';
import { REMOTE_IPC_CHANNELS as C } from '@canopy/protocol/remote-control/channels';
import {
  delegationRootMessages,
  isVisiblePersistedChatMessage,
} from '@canopy/agent-transcript';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import type { ToolFamilyResolver } from '@canopy/agent-transcript/remote-control/persisted-chat-projection';
import { persistedMessageToRemoteControlWireMessage } from '@canopy/agent-transcript/remote-control/remote-control-wire-message';
import type { ChannelClient } from './channel-client';
import { isRecord, reply } from './decoders';

const CURSOR_PREFIX = 'ipc-transcript-v1:';

export const CHAT_HISTORY_INVALID_CURSOR_CODE = 'chat_history_invalid_cursor';

/** The cursor was not issued by this adapter; restart from the newest page. */
export class ChatHistoryCursorError extends Error {
  readonly code = CHAT_HISTORY_INVALID_CURSOR_CODE;
  constructor() {
    super('This chat history position is no longer valid. Reload the chat.');
    this.name = 'ChatHistoryCursorError';
  }
}

interface HistoryPosition {
  readonly before: number;
  readonly transcriptRevision: number;
}

export function encodeChatHistoryCursor(
  position: HistoryPosition,
): RemoteControlTranscriptCursor {
  return `${CURSOR_PREFIX}${String(position.before)}:${String(position.transcriptRevision)}`;
}

function isOrdinal(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function decodeChatHistoryCursor(
  cursor: RemoteControlTranscriptCursor,
): HistoryPosition {
  if (!cursor.startsWith(CURSOR_PREFIX)) throw new ChatHistoryCursorError();
  const parts = cursor.slice(CURSOR_PREFIX.length).split(':');
  if (parts.length !== 2 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new ChatHistoryCursorError();
  }
  const before = Number(parts[0]);
  const transcriptRevision = Number(parts[1]);
  if (!isOrdinal(before) || !isOrdinal(transcriptRevision)) {
    throw new ChatHistoryCursorError();
  }
  return { before, transcriptRevision };
}

/** `TranscriptPage` fields this module reads. */
interface WireTranscriptPage {
  readonly messages: readonly PersistedChatMessage[];
  readonly before?: number;
  readonly transcriptRevision: number;
}

const isTranscriptPage = reply<WireTranscriptPage>(
  (value) =>
    isRecord(value) &&
    Array.isArray(value.messages) &&
    typeof value.transcriptRevision === 'number' &&
    (value.before === undefined || typeof value.before === 'number'),
);

/** The `(projectId, worktreeId)` a chat's transcript is keyed by. */
function transcriptTarget(args: RemoteControlChatHistoryRequest): {
  projectId: string;
  worktreeId: string;
} {
  const worktreeId = args.worktreeLocalId;
  if (!worktreeId) {
    throw new Error('chat.history requires worktreeLocalId on this host.');
  }
  if (args.scope === 'worktree') {
    if (!args.workspaceLocalId) {
      throw new Error(
        'chat.history requires workspaceLocalId for worktree-scoped chats.',
      );
    }
    return { projectId: args.workspaceLocalId, worktreeId };
  }
  // Standalone chats: a cowork workspace keys by its own id, a chat outside
  // any workspace by the standalone project id (the `chat.message` inverse).
  return {
    projectId: args.workspaceLocalId ?? STANDALONE_CHAT_PROJECT_ID,
    worktreeId,
  };
}

export async function readChatHistory(
  channels: ChannelClient,
  args: RemoteControlChatHistoryRequest,
  toolFamilyFor: ToolFamilyResolver | undefined,
): Promise<RemoteControlChatHistoryChunk> {
  const target = transcriptTarget(args);
  const position =
    args.before === null ? undefined : decodeChatHistoryCursor(args.before);
  const page = await channels.invoke(
    C.chatGetTranscriptPage,
    isTranscriptPage,
    {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: args.chatId,
      ...(position
        ? {
            before: position.before,
            transcriptRevision: position.transcriptRevision,
          }
        : {}),
    },
  );
  const visible = page.messages.filter(isVisiblePersistedChatMessage);
  const routing = {
    scope: args.scope,
    ...(args.workspaceLocalId !== undefined
      ? { workspaceLocalId: args.workspaceLocalId }
      : {}),
    worktreeLocalId: target.worktreeId,
    chatId: args.chatId,
  };
  const messages: RemoteControlChatMessage[] = delegationRootMessages(
    visible,
  ).map((message) =>
    persistedMessageToRemoteControlWireMessage(
      { ...routing, message, relatedMessages: visible },
      toolFamilyFor,
      { includeAssetReferences: args.scope !== 'app_advisor' },
    ),
  );
  const nextBefore = page.before;
  return {
    chatId: args.chatId,
    scope: args.scope,
    ...(args.workspaceLocalId !== undefined
      ? { workspaceLocalId: args.workspaceLocalId }
      : {}),
    worktreeLocalId: target.worktreeId,
    segment: 'historical',
    messages,
    nextCursor:
      nextBefore !== undefined && nextBefore > 0
        ? encodeChatHistoryCursor({
            before: nextBefore,
            transcriptRevision: page.transcriptRevision,
          })
        : null,
  };
}
