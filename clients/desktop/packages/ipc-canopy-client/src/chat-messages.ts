import type {
  DomainEventMap,
  SubscriptionFilter,
  Unsubscribe,
} from '@canopy/app-core';
import {
  ChatEventOutputDecoder,
  type ChatEvent,
  type ChatEventMessage,
} from '@canopy/agent-transcript/lib/chat-event-output';
import { createListenerFanout } from '@canopy/agent-transcript/lib/listener-fanout';
import {
  createCursorAssistantPatchProjector,
  isCursorAssistantPatchEvent,
  isTerminalRuntimeChatEvent,
  runtimeChatEventToRemoteControlMessage,
  type CursorAssistantPatchProjector,
} from '@canopy/agent-transcript/remote-control/runtime-chat-projection';
import type { ToolFamilyResolver } from '@canopy/agent-transcript/remote-control/persisted-chat-projection';
import {
  COWORK_HOME_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/protocol/chat-targets';
import { REMOTE_IPC_CHANNELS as C } from '@canopy/protocol/remote-control/channels';
import type { ChannelClient } from './channel-client';
import { isRecord } from './decoders';

function isChatEventMessage(value: unknown): value is ChatEventMessage {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string' &&
    'data' in value
  );
}

/** 128 random bits as lowercase hex, the desktop preload's reset epoch. */
function randomEpoch(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export interface ChatEventSourceOptions {
  /**
   * Host-local `chat:event-output-reset`. The host encodes growing outputs
   * per receiving page; a new decoder asks it to start over. This is never
   * sent over the transport: a reset is local to the page that decodes, so a
   * transport that already delivers decoded events (the desktop preload)
   * omits it, and the decoder then passes full events through unchanged.
   */
  readonly requestOutputReset?: (epoch: string) => Promise<void>;
  readonly newEpoch?: () => string;
  /**
   * The transport already delivers decoded events (the desktop preload
   * decodes once per page). The adapter then only fans out, so the page keeps
   * one decoder and one copy of each growing output.
   */
  readonly decoded?: boolean;
}

/**
 * One `chat:event` listener for the client, however many subscribers, with
 * the desktop preload's output decoding: an event the decoder cannot rebuild
 * is dropped, never shown with a wrong output.
 */
export function createChatEventSource(
  channels: ChannelClient,
  options: ChatEventSourceOptions = {},
): (listener: (event: ChatEvent) => void) => Unsubscribe {
  return createListenerFanout<ChatEvent>((dispatch) => {
    if (options.decoded === true) {
      return channels.listen(C.chatEvent, isChatEventMessage, dispatch);
    }
    const requestOutputReset = options.requestOutputReset;
    const decoder = new ChatEventOutputDecoder({
      newEpoch: options.newEpoch ?? randomEpoch,
      requestReset: (epoch): Promise<void> =>
        requestOutputReset ? requestOutputReset(epoch) : Promise.resolve(),
    });
    return channels.listen(C.chatEvent, isChatEventMessage, (message) => {
      const event = decoder.decode(message);
      if (event !== undefined) dispatch(event);
    });
  });
}

function runtimeAssistantFallbackMessageId(
  chatId: string,
  data: unknown,
  turnSequence: number,
): string {
  if (isRecord(data)) {
    const turnUserMessageId = data.canopy_turn_user_message_id;
    if (typeof turnUserMessageId === 'string' && turnUserMessageId.length > 0) {
      return `${turnUserMessageId}:assistant`;
    }
  }
  return `${chatId}:desktop-turn-${String(turnSequence)}:assistant`;
}

export interface ChatMessageSubscriptionOptions {
  readonly subscribeChatEvents: (
    listener: (event: ChatEvent) => void,
  ) => Unsubscribe;
  readonly isCoworkChatTarget: (projectId: string) => boolean;
  readonly toolFamilyFor?: ToolFamilyResolver;
  readonly now: () => string;
}

/**
 * `chat.message`: project raw runtime chat events into whole Portal messages,
 * exactly as the desktop renderer adapter did.
 */
export function subscribeChatMessages(
  options: ChatMessageSubscriptionOptions,
  handler: (event: DomainEventMap['chat.message']) => void,
  filter?: SubscriptionFilter,
): Unsubscribe {
  const turnSequenceByChat = new Map<string, number>();
  // Cursor streams patches against one assistant message per turn; fold them
  // per chat and drop the fold at the terminal event. A turn that never ends
  // keeps its projector for this subscription's life: size-based eviction
  // would silently corrupt an open chat's fold, and no deletion signal
  // reaches this subscription (see the desktop history of this handler).
  const cursorPatchesByChat = new Map<string, CursorAssistantPatchProjector>();
  return options.subscribeChatEvents((event) => {
    const isCowork =
      event.worktreeId === COWORK_HOME_WORKTREE_ID ||
      options.isCoworkChatTarget(event.projectId);
    const scope =
      event.projectId === STANDALONE_CHAT_PROJECT_ID || isCowork
        ? 'standalone'
        : 'worktree';
    const workspaceLocalId =
      scope === 'worktree' || isCowork ? event.projectId : undefined;
    const worktreeLocalId = event.worktreeId;
    if (
      (filter?.projectId !== undefined &&
        filter.projectId !== event.projectId) ||
      (filter?.worktreeId !== undefined &&
        filter.worktreeId !== event.worktreeId) ||
      (filter?.workspaceLocalId !== undefined &&
        filter.workspaceLocalId !== workspaceLocalId) ||
      (filter?.worktreeLocalId !== undefined &&
        filter.worktreeLocalId !== worktreeLocalId) ||
      (filter?.chatLocalId !== undefined && filter.chatLocalId !== event.chatId)
    ) {
      return;
    }

    const turnSequence = turnSequenceByChat.get(event.chatId) ?? 0;
    const chatKey = `${event.projectId}/${event.worktreeId}/${event.chatId}`;
    let cursorPatches = cursorPatchesByChat.get(chatKey);
    if (!cursorPatches && isCursorAssistantPatchEvent(event.data)) {
      cursorPatches = createCursorAssistantPatchProjector({
        scope,
        workspaceLocalId,
        worktreeLocalId,
        chatId: event.chatId,
        toolFamilyFor: options.toolFamilyFor,
      });
      cursorPatchesByChat.set(chatKey, cursorPatches);
    }
    const message =
      cursorPatches?.apply(event.data) ??
      runtimeChatEventToRemoteControlMessage({
        scope,
        workspaceLocalId,
        worktreeLocalId,
        chatId: event.chatId,
        data: event.data,
        fallbackMessageId: runtimeAssistantFallbackMessageId(
          event.chatId,
          event.data,
          turnSequence,
        ),
        toolFamilyFor: options.toolFamilyFor,
      });
    if (message) {
      handler({
        eventId: `${event.projectId}:${event.worktreeId}:${event.chatId}:${message.messageId}:${String(message.updatedAtMs ?? message.createdAtMs)}`,
        occurredAt: options.now(),
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        scope,
        workspaceLocalId,
        worktreeLocalId,
        chatId: event.chatId,
        message,
      });
    }
    if (isTerminalRuntimeChatEvent(event.data)) {
      turnSequenceByChat.set(event.chatId, turnSequence + 1);
      cursorPatchesByChat.delete(chatKey);
    }
  });
}
