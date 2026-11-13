import {
  CanopyErrorPayloadSchema,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import {
  CoreCoworkRequestError,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '@canopy/app-state/core-cowork';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  applyLiveItem,
  liveReplyKey,
  parseLiveItem,
  type LiveChatState,
  type LiveReply,
} from './live-replies';
import { bareId, type WebCoreIds } from './translate';

/** A chat by its qualified store ids. */
export interface LiveChat {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/** Live streams followed at once; a chat beyond it shows committed replies only. */
export const LIVE_STREAM_LIMIT = 4;

const TERMINAL_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'unauthenticated',
  'permission_denied',
  'capability_unavailable',
  'not_found',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stream end the web core marks final: the stream is not opened again. */
export function isTerminalEnd(frame: unknown): boolean {
  if (!isRecord(frame) || frame.kind !== 'end') return false;
  const error = CanopyErrorPayloadSchema.safeParse(frame.error);
  return error.success && TERMINAL_KINDS.has(error.data.kind);
}

export interface LiveFollowerOptions {
  readonly invoker: () => CoreCoworkInvoker;
  /** How the store names the web core's message ids. */
  readonly messageIds?: Pick<WebCoreIds, 'messageToStore'>;
  /** A store chat id as the web core names it. */
  readonly chatToCore?: (id: string) => string;
  /** Whether the chat's turn runs, as the committed runtime reports it. */
  readonly turnRuns: (chat: LiveChat) => boolean;
  /** Publishes a chat's replies; an empty list clears them. */
  readonly publish: (key: string, chat: LiveChatState) => void;
  /**
   * The live stream says no turn runs. The committed runtime may not have
   * caught up: the web core can commit a turn's last reply before Core ends
   * the turn, and commit nothing after (CAN-6396).
   */
  readonly onIdle?: (chat: LiveChat) => void;
  readonly now?: () => number;
  /** Delay before reopening a live stream while its turn runs. */
  readonly reopenDelayMs?: number;
  /** How long a finished reply waits for its committed message. */
  readonly holdMs?: number;
}

interface Followed {
  readonly chat: LiveChat;
  replies: readonly LiveReply[];
  /** Whether its turn ran when the replies were last published. */
  publishedRuns: boolean;
  stream: CoreCoworkStream | null;
  opening: boolean;
  reopenTimer: ReturnType<typeof setTimeout> | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** Turns whose reply waits out `holdMs`: their turn stopped. */
  readonly stopped: Set<string>;
  /** The web core refused live replies here for good. */
  refused: boolean;
}

export interface LiveFollower {
  /** The chats on screen: only these follow their live reply. */
  readonly setFocused: (chats: readonly LiveChat[]) => void;
  /** Opens or ends streams after the committed runtime changed. */
  readonly refresh: () => void;
  readonly closeAll: () => void;
}

/**
 * Follows `core.chat.live.events` for the shown web core chats whose turn
 * runs, the way the web's thread follows it for its open chat (CAN-5984).
 */
export function createLiveFollower(options: LiveFollowerOptions): LiveFollower {
  const now = options.now ?? Date.now;
  const reopenDelayMs = options.reopenDelayMs ?? 1_000;
  const holdMs = options.holdMs ?? 5_000;
  const followed = new Map<string, Followed>();

  const isFollowed = (entry: Followed): boolean =>
    followed.get(liveReplyKey(entry.chat)) === entry;

  /**
   * A reply whose turn stopped waits for its committed message: the
   * transcript drops it once it commits, and this clears it after `holdMs`,
   * finished or not (a stream can end before its finish frame). Each reply
   * expires by its own turn, so the next turn starting keeps no stale reply.
   */
  function armHold(entry: Followed): void {
    if (!options.turnRuns(entry.chat))
      for (const reply of entry.replies) entry.stopped.add(reply.turnId);
    if (
      entry.holdTimer !== null ||
      !entry.replies.some((reply) => entry.stopped.has(reply.turnId))
    )
      return;
    entry.holdTimer = setTimeout(() => {
      entry.holdTimer = null;
      const expired = new Set(entry.stopped);
      entry.stopped.clear();
      publish(
        entry,
        entry.replies.filter((reply) => !expired.has(reply.turnId)),
      );
    }, holdMs);
  }

  function publish(entry: Followed, replies: readonly LiveReply[]): void {
    entry.replies = replies;
    entry.publishedRuns = options.turnRuns(entry.chat);
    options.publish(liveReplyKey(entry.chat), {
      replies,
      turnRuns: entry.publishedRuns,
    });
    armHold(entry);
  }

  function stopStream(entry: Followed): void {
    if (entry.reopenTimer !== null) clearTimeout(entry.reopenTimer);
    entry.reopenTimer = null;
    const open = entry.stream;
    entry.stream = null;
    if (open !== null) void open.close();
  }

  function forget(key: string, entry: Followed): void {
    stopStream(entry);
    if (entry.holdTimer !== null) clearTimeout(entry.holdTimer);
    entry.holdTimer = null;
    followed.delete(key);
    options.publish(key, { replies: [], turnRuns: false });
  }

  function scheduleReopen(entry: Followed): void {
    if (entry.refused || entry.reopenTimer !== null || !isFollowed(entry))
      return;
    entry.reopenTimer = setTimeout(() => {
      entry.reopenTimer = null;
      ensure(entry);
    }, reopenDelayMs);
  }

  /** One stream frame: read on, open again at once, stop, or stop for good. */
  function applyFrame(
    entry: Followed,
    frame: unknown,
  ): 'next' | 'gap' | 'end' | 'refused' {
    if (!isRecord(frame) || frame.kind !== 'item')
      return isTerminalEnd(frame) ? 'refused' : 'end';
    const item = parseLiveItem(frame.item);
    if (item.chatId !== (options.chatToCore ?? bareId)(entry.chat.chatId))
      return 'next';
    if (item.kind === 'idle') options.onIdle?.(entry.chat);
    // A turn that streams runs on: its reply no longer expires. A chat runs
    // one turn at a time, so every other turn's reply has stopped, even
    // when the chat never went idle between them (a lost finish frame).
    if (
      item.kind !== 'idle' &&
      !(item.kind === 'turn' && item.state === 'finished') &&
      options.turnRuns(entry.chat)
    ) {
      entry.stopped.delete(item.turnId);
      for (const reply of entry.replies)
        if (reply.turnId !== item.turnId) entry.stopped.add(reply.turnId);
    }
    const toStore =
      options.messageIds?.messageToStore ?? ((id: string): string => id);
    const replies = applyLiveItem(
      entry.replies,
      item.kind === 'turn'
        ? {
            ...item,
            promptMessageId:
              item.promptMessageId === null
                ? null
                : toStore(item.promptMessageId),
            ...(item.messageId === undefined
              ? {}
              : { messageId: toStore(item.messageId) }),
          }
        : item,
      now(),
    );
    // A gap: attach again at once; the next open sends the whole reply.
    if (replies === null) return 'gap';
    publish(entry, replies);
    return 'next';
  }

  async function pump(
    entry: Followed,
    opened: CoreCoworkStream,
  ): Promise<void> {
    let outcome: 'gap' | 'end' | 'refused' = 'end';
    try {
      for (;;) {
        const next = await opened.next();
        if (entry.stream !== opened || next.done) break;
        const step = applyFrame(entry, next.value);
        if (step === 'next') continue;
        outcome = step;
        break;
      }
    } finally {
      void opened.close();
      if (entry.stream === opened) entry.stream = null;
      afterStream(entry, outcome);
    }
  }

  function afterStream(
    entry: Followed,
    outcome: 'gap' | 'end' | 'refused',
  ): void {
    if (outcome === 'refused') {
      entry.refused = true;
      return;
    }
    if (!isFollowed(entry)) return;
    if (outcome === 'gap') ensure(entry);
    else if (options.turnRuns(entry.chat)) scheduleReopen(entry);
  }

  function ensure(entry: Followed): void {
    if (
      !isFollowed(entry) ||
      entry.refused ||
      entry.stream !== null ||
      entry.opening ||
      entry.reopenTimer !== null ||
      !options.turnRuns(entry.chat)
    )
      return;
    entry.opening = true;
    const scope = {
      workspaceId: bareId(entry.chat.projectId),
      worktreeId: bareId(entry.chat.worktreeId),
      chatId: (options.chatToCore ?? bareId)(entry.chat.chatId),
    };
    void options
      .invoker()
      .openStream('core.chat.live.events', { scope })
      .then(
        (opened) => {
          entry.opening = false;
          if (!isFollowed(entry)) {
            void opened.close();
            return;
          }
          entry.stream = opened;
          void pump(entry, opened).catch((error: unknown) => {
            reportClientAppError(error);
            scheduleReopen(entry);
          });
        },
        (error: unknown) => {
          entry.opening = false;
          if (
            error instanceof CoreCoworkRequestError &&
            TERMINAL_KINDS.has(error.payload.kind)
          )
            entry.refused = true;
          else {
            reportClientAppError(error);
            scheduleReopen(entry);
          }
        },
      );
  }

  function setFocused(chats: readonly LiveChat[]): void {
    const wanted = new Map(
      chats
        .slice(0, LIVE_STREAM_LIMIT)
        .map((chat) => [liveReplyKey(chat), chat]),
    );
    for (const [key, entry] of followed)
      if (!wanted.has(key)) forget(key, entry);
    for (const [key, chat] of wanted) {
      if (followed.has(key)) continue;
      const entry: Followed = {
        chat,
        replies: [],
        publishedRuns: false,
        stream: null,
        opening: false,
        reopenTimer: null,
        holdTimer: null,
        stopped: new Set(),
        refused: false,
      };
      followed.set(key, entry);
      ensure(entry);
    }
  }

  function refresh(): void {
    for (const entry of followed.values()) {
      ensure(entry);
      if (
        entry.replies.length > 0 &&
        entry.publishedRuns !== options.turnRuns(entry.chat)
      )
        publish(entry, entry.replies);
      else armHold(entry);
    }
  }

  function closeAll(): void {
    for (const [key, entry] of [...followed]) forget(key, entry);
  }

  return { setFocused, refresh, closeAll };
}
