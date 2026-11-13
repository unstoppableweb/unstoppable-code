import { create } from 'zustand';
import { CORE_CHAT_LIVE_STREAM_DEFINITIONS } from '@canopy/protocol/canopy-core';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { WebCoreTranslationError } from './translate';

/**
 * A web core chat's provisional reply while its turn runs (CAN-5984), never
 * part of the transcript: the transcript shows it after the committed
 * messages until the reply itself commits (CAN-6175 R3).
 */
export interface LiveReply {
  readonly turnId: string;
  readonly promptMessageId: string | null;
  /** The committed message the web core named for it, once finished. */
  readonly messageId: string | null;
  readonly text: string;
  readonly reasoning: string;
  readonly finished: boolean;
  readonly createdAtMs: number;
}

/** Replies a chat keeps at once, oldest dropped first. */
export const LIVE_REPLY_LIMIT = 4;

type LiveItem = ReturnType<
  (typeof CORE_CHAT_LIVE_STREAM_DEFINITIONS)['core.chat.live.events']['item']['parse']
>;

export function parseLiveItem(value: unknown): LiveItem {
  const parsed =
    CORE_CHAT_LIVE_STREAM_DEFINITIONS['core.chat.live.events'].item.safeParse(
      value,
    );
  if (!parsed.success) throw new WebCoreTranslationError('live reply');
  return parsed.data;
}

/**
 * The replies after one live item, oldest first, or null for an append cut
 * at lengths this client does not hold: the stream must be opened again.
 */
export function applyLiveItem(
  replies: readonly LiveReply[],
  item: LiveItem,
  now: number,
): readonly LiveReply[] | null {
  if (item.kind === 'idle')
    return replies.map((reply) =>
      reply.finished ? reply : { ...reply, finished: true },
    );
  const held = replies.find((reply) => reply.turnId === item.turnId);
  if (item.kind === 'turn') {
    const next: LiveReply = {
      turnId: item.turnId,
      promptMessageId: item.promptMessageId,
      messageId: item.messageId ?? null,
      text: item.text,
      reasoning: item.reasoning,
      finished: item.state === 'finished',
      createdAtMs: held?.createdAtMs ?? now,
    };
    const others = replies.filter((reply) => reply.turnId !== item.turnId);
    return [...others, next].slice(-LIVE_REPLY_LIMIT);
  }
  if (
    held === undefined ||
    held.text.length !== item.textOffset ||
    held.reasoning.length !== item.reasoningOffset
  )
    return null;
  return replies.map((reply) =>
    reply === held
      ? {
          ...reply,
          text: reply.text + item.text,
          reasoning: reply.reasoning + item.reasoning,
        }
      : reply,
  );
}

/**
 * Whether the transcript holds the reply: the committed message the web core
 * named, or, once its turn stopped and it named none, the turn's one reply
 * after its prompt. While the turn runs, another assistant message after the
 * prompt is never taken for its reply.
 */
export function isLiveReplyCommitted(
  reply: LiveReply,
  messages: readonly PersistedChatMessage[],
  turnRuns: boolean,
): boolean {
  if (reply.messageId !== null)
    return messages.some((message) => message.id === reply.messageId);
  if ((!reply.finished && turnRuns) || reply.promptMessageId === null)
    return false;
  const at = messages.findIndex(
    (message) => message.id === reply.promptMessageId,
  );
  return (
    at !== -1 &&
    messages.slice(at + 1).some((message) => message.role === 'assistant')
  );
}

/** The provisional rows to show after `messages`, as transcript messages. */
export function presentLiveReplies(
  replies: readonly LiveReply[],
  messages: readonly PersistedChatMessage[],
  turnRuns: boolean,
): PersistedChatMessage[] {
  return replies
    .filter(
      (reply) =>
        (reply.text.length > 0 || reply.reasoning.length > 0) &&
        !isLiveReplyCommitted(reply, messages, turnRuns),
    )
    .map((reply) => ({
      id: `live:${reply.turnId}`,
      role: 'assistant',
      timestamp: reply.createdAtMs,
      blocks: [
        ...(reply.reasoning.length > 0
          ? [{ type: 'thinking' as const, text: reply.reasoning }]
          : []),
        ...(reply.text.length > 0
          ? [{ type: 'text' as const, text: reply.text }]
          : []),
      ],
    }));
}

/** The store key of one chat: its qualified project, worktree and chat ids. */
export function liveReplyKey(target: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}): string {
  return `${target.projectId}/${target.worktreeId}/${target.chatId}`;
}

/** One shown chat's live replies, and whether its turn runs. */
export interface LiveChatState {
  readonly replies: readonly LiveReply[];
  readonly turnRuns: boolean;
}

interface LiveReplyState {
  readonly byChat: Readonly<Record<string, LiveChatState>>;
  readonly set: (key: string, chat: LiveChatState) => void;
  readonly clear: () => void;
}

const EMPTY: LiveChatState = { replies: [], turnRuns: false };

export const useWebCoreLiveReplyStore = create<LiveReplyState>((set) => ({
  byChat: {},
  set: (key, chat): void =>
    set((state) => {
      if (chat.replies.length === 0) {
        if (!(key in state.byChat)) return state;
        const byChat = { ...state.byChat };
        delete byChat[key];
        return { byChat };
      }
      const known = state.byChat[key];
      if (known?.replies === chat.replies && known.turnRuns === chat.turnRuns)
        return state;
      return { byChat: { ...state.byChat, [key]: chat } };
    }),
  clear: (): void => set({ byChat: {} }),
}));

/** One chat's live state; the same empty state for a chat with none. */
export function selectLiveChat(
  state: LiveReplyState,
  key: string | null,
): LiveChatState {
  return key === null ? EMPTY : (state.byChat[key] ?? EMPTY);
}
