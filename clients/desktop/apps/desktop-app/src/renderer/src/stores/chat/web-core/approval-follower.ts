import {
  CanopyErrorPayloadSchema,
  CORE_APPROVAL_REQUEST_LIST_SCHEMA_REVISION,
  CoreApprovalRequestEventsItemSchema,
  CoreApprovalRequestListResultSchema,
  type CanopyErrorPayload,
  type CoreApprovalListedRequest,
} from '@canopy/protocol/canopy-core';
import {
  CoreCoworkRequestError,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '@canopy/app-state/core-cowork';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type {
  AgentProviderType,
  ApprovalCancelledEvent,
  ApprovalDismissRequest,
  ApprovalRequestEvent,
  ApprovalRespondRequest,
} from '@canopy/desktop-shared/types';
import type { LiveChat } from './live-follower';

/** Refusals that end a chat's approval stream for good. */
const TERMINAL_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'unauthenticated',
  'permission_denied',
  'capability_unavailable',
]);

/** An answer the web core no longer takes: the request was settled. */
const SETTLED_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'not_found',
  'failed_precondition',
  'conflict',
]);

export interface ApprovalFollowerOptions {
  readonly invoker: () => CoreCoworkInvoker;
  /** A store chat id as the web core names it. */
  readonly chatToCore: (id: string) => string;
  /** The chat's provider, as its model reports it. */
  readonly providerOf: (chat: LiveChat) => AgentProviderType | undefined;
  /** Whether the chat's turn runs, as the committed runtime reports it. */
  readonly turnRuns: (chat: LiveChat) => boolean;
  /** Delay before reopening a chat's approval stream. */
  readonly reopenDelayMs?: number;
  readonly newId?: () => string;
}

export interface ApprovalFollower {
  /** The chats on screen: each follows its approvals while shown. */
  readonly setFocused: (chats: readonly LiveChat[]) => void;
  /** Every pending approval of the followed chats, read now. */
  readonly pendingRequests: () => Promise<ApprovalRequestEvent[]>;
  /** Follows again a chat the web core did not know once its turn runs. */
  readonly refresh: () => void;
  readonly respond: (req: ApprovalRespondRequest) => Promise<boolean>;
  readonly dismiss: (req: ApprovalDismissRequest) => Promise<boolean>;
  readonly onRequest: (
    listener: (event: ApprovalRequestEvent) => void,
  ) => () => void;
  readonly onCancelled: (
    listener: (event: ApprovalCancelledEvent) => void,
  ) => () => void;
  readonly closeAll: () => void;
}

interface Followed {
  readonly chat: LiveChat;
  stream: CoreCoworkStream | null;
  opening: boolean;
  reopenTimer: ReturnType<typeof setTimeout> | null;
  refused: boolean;
  /**
   * The web core did not know the chat: a task just created, or a chat
   * deleted. It is followed again once a turn runs there.
   */
  missing: boolean;
  /** Requests shown for this chat, by request id. */
  readonly shown: Set<string>;
  /** The chat's list reads and settlements, one at a time, in order. */
  queue: Promise<void>;
}

const chatKey = (chat: LiveChat): string =>
  `${chat.projectId}/${chat.worktreeId}/${chat.chatId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The refusal a stream's last frame carries, if it has one. */
function endRefusal(frame: unknown): CanopyErrorPayload['kind'] | null {
  if (!isRecord(frame) || frame.kind !== 'end') return null;
  const error = CanopyErrorPayloadSchema.safeParse(frame.error);
  return error.success ? error.data.kind : null;
}

/**
 * A cloud chat's tool approvals on desktop (CAN-6515): followed over
 * `core.approval.request.events` for each chat on screen, each card read
 * from `core.approval.request.list` (revision 2, which carries the card the
 * web shows), and answered through `core.approval.request.respond`. Cloud
 * chats keep no approval rules, so every answer is for this request only.
 */
export function createApprovalFollower(
  options: ApprovalFollowerOptions,
): ApprovalFollower {
  const reopenDelayMs = options.reopenDelayMs ?? 1_000;
  const newId = options.newId ?? ((): string => globalThis.crypto.randomUUID());
  const followed = new Map<string, Followed>();
  // A chat's shown cards outlive its stream: they stay in the store while it
  // is off screen or offline, and its next list read settles the stale ones.
  const shownByChat = new Map<string, Set<string>>();
  const requestListeners = new Set<(event: ApprovalRequestEvent) => void>();
  const cancelListeners = new Set<(event: ApprovalCancelledEvent) => void>();

  const isFollowed = (entry: Followed): boolean =>
    followed.get(chatKey(entry.chat)) === entry;

  async function request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const reply = await options.invoker().request(method, params);
    if (!reply.ok) throw new CoreCoworkRequestError(reply.error);
    return reply.value;
  }

  function cardOf(
    chat: LiveChat,
    listed: CoreApprovalListedRequest,
  ): ApprovalRequestEvent | null {
    const card = listed.presentation;
    if (card === undefined) return null;
    const toolName =
      listed.target.kind === 'tool' ? listed.target.toolName : 'tool';
    return {
      surface: 'chat',
      requestId: listed.requestId,
      projectId: chat.projectId,
      worktreeId: chat.worktreeId,
      chatId: chat.chatId,
      provider: options.providerOf(chat) ?? 'claude',
      title: `Agent wants to use ${toolName}`,
      details: card.details,
      ...(card.toolCallId === null ? {} : { toolUseId: card.toolCallId }),
      ...(listed.subagentId === null ? {} : { subagentId: listed.subagentId }),
      policyRevision: listed.policyRevision,
    };
  }

  async function listPending(chat: LiveChat): Promise<ApprovalRequestEvent[]> {
    const listed = CoreApprovalRequestListResultSchema.parse(
      await request('core.approval.request.list', {
        scope: { chatId: options.chatToCore(chat.chatId) },
        states: ['pending'],
        cursor: null,
        // A chat waits on a few approvals at most.
        limit: 500,
        revision: CORE_APPROVAL_REQUEST_LIST_SCHEMA_REVISION,
      }),
    );
    return listed.requests.flatMap((each) => cardOf(chat, each) ?? []);
  }

  function serial<T>(entry: Followed, run: () => Promise<T>): Promise<T> {
    const next = entry.queue.then(run);
    entry.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function settle(entry: Followed, requestId: string): void {
    if (!entry.shown.delete(requestId)) return;
    for (const listener of cancelListeners) listener({ requestId });
  }

  /**
   * Reads the chat's pending requests and makes its cards match: a shown card
   * no longer pending is settled, and a pending one not yet shown is raised,
   * whoever asked for the read.
   */
  async function reconcile(entry: Followed): Promise<ApprovalRequestEvent[]> {
    const pending = await listPending(entry.chat);
    if (!isFollowed(entry)) return [];
    const ids = new Set(pending.map((event) => event.requestId));
    for (const requestId of [...entry.shown])
      if (!ids.has(requestId)) settle(entry, requestId);
    for (const event of pending) {
      if (entry.shown.has(event.requestId)) continue;
      entry.shown.add(event.requestId);
      for (const listener of requestListeners) listener(event);
    }
    return pending;
  }

  const showPending = (entry: Followed): Promise<unknown> =>
    serial(entry, () => reconcile(entry));

  function stopStream(entry: Followed): void {
    if (entry.reopenTimer !== null) clearTimeout(entry.reopenTimer);
    entry.reopenTimer = null;
    const open = entry.stream;
    entry.stream = null;
    if (open !== null) void open.close();
  }

  /** A refusal that ends the stream: final, or until a turn runs there. */
  function refuse(entry: Followed, kind: CanopyErrorPayload['kind']): boolean {
    // A chat whose turn runs was known to the web core: not finding it now
    // means it was deleted, which is final.
    if (kind === 'not_found' && !options.turnRuns(entry.chat))
      entry.missing = true;
    else if (kind === 'not_found' || TERMINAL_KINDS.has(kind))
      entry.refused = true;
    else return false;
    return true;
  }

  function scheduleReopen(entry: Followed): void {
    if (
      entry.refused ||
      entry.missing ||
      entry.reopenTimer !== null ||
      !isFollowed(entry)
    )
      return;
    entry.reopenTimer = setTimeout(() => {
      entry.reopenTimer = null;
      ensure(entry);
    }, reopenDelayMs);
  }

  async function pump(
    entry: Followed,
    opened: CoreCoworkStream,
  ): Promise<void> {
    let refused = false;
    try {
      for (;;) {
        const next = await opened.next();
        if (entry.stream !== opened || next.done) break;
        const frame = next.value;
        if (!isRecord(frame) || frame.kind !== 'item') {
          const kind = endRefusal(frame);
          refused = kind !== null && refuse(entry, kind);
          break;
        }
        const item = CoreApprovalRequestEventsItemSchema.safeParse(frame.item);
        if (!item.success) continue;
        const event = item.data;
        if (event.kind === 'request') await showPending(entry);
        else if (event.kind !== 'policy_invalidated')
          await serial(entry, () => {
            settle(entry, event.requestId);
            return Promise.resolve();
          });
      }
    } finally {
      void opened.close();
      if (entry.stream === opened) entry.stream = null;
      if (!refused) scheduleReopen(entry);
    }
  }

  function ensure(entry: Followed): void {
    if (
      !isFollowed(entry) ||
      entry.refused ||
      entry.missing ||
      entry.stream !== null ||
      entry.opening ||
      entry.reopenTimer !== null
    )
      return;
    entry.opening = true;
    void options
      .invoker()
      .openStream('core.approval.request.events', {
        scope: { chatId: options.chatToCore(entry.chat.chatId) },
        cursor: null,
      })
      .then(
        (opened) => {
          entry.opening = false;
          if (!isFollowed(entry)) {
            void opened.close();
            return;
          }
          entry.stream = opened;
          // Opened first, then read, so a request raised in between is
          // either listed or arrives as an item; the read is queued ahead of
          // every item, so no settlement is applied before it.
          void showPending(entry).catch((error: unknown) => {
            if (entry.stream === opened) stopStream(entry);
            if (
              error instanceof CoreCoworkRequestError &&
              refuse(entry, error.payload.kind)
            )
              return;
            reportClientAppError(error);
            // The stream never replays what was already pending, so the read
            // is tried again on a fresh one.
            scheduleReopen(entry);
          });
          void pump(entry, opened).catch((error: unknown) => {
            reportClientAppError(error);
            scheduleReopen(entry);
          });
        },
        (error: unknown) => {
          entry.opening = false;
          if (
            !(
              error instanceof CoreCoworkRequestError &&
              refuse(entry, error.payload.kind)
            )
          ) {
            reportClientAppError(error);
            scheduleReopen(entry);
          }
        },
      );
  }

  function setFocused(chats: readonly LiveChat[]): void {
    const wanted = new Map(chats.map((chat) => [chatKey(chat), chat]));
    for (const [key, entry] of followed) {
      if (wanted.has(key)) continue;
      stopStream(entry);
      followed.delete(key);
    }
    for (const [key, chat] of wanted) {
      if (followed.has(key)) continue;
      let shown = shownByChat.get(key);
      if (shown === undefined) {
        shown = new Set();
        shownByChat.set(key, shown);
      }
      const entry: Followed = {
        chat,
        stream: null,
        opening: false,
        reopenTimer: null,
        refused: false,
        missing: false,
        shown,
        queue: Promise.resolve(),
      };
      followed.set(key, entry);
      ensure(entry);
    }
  }

  function refresh(): void {
    for (const entry of followed.values()) {
      if (!entry.missing || !options.turnRuns(entry.chat)) continue;
      entry.missing = false;
      ensure(entry);
    }
  }

  async function pendingRequests(): Promise<ApprovalRequestEvent[]> {
    const lists = await Promise.all(
      [...followed.values()].map((entry) =>
        serial(entry, () => reconcile(entry)),
      ),
    );
    return lists.flat();
  }

  async function answer(
    req: ApprovalDismissRequest,
    decision: {
      readonly behavior: 'allow' | 'deny';
      readonly message?: string;
      readonly stopTurn?: boolean;
    },
    policyRevision: number,
  ): Promise<boolean> {
    try {
      await request('core.approval.request.respond', {
        requestId: req.requestId,
        policyRevision,
        decision: decision.behavior,
        stopTurn: decision.behavior === 'deny' && decision.stopTurn === true,
        message:
          decision.behavior === 'deny' && decision.message !== undefined
            ? decision.message
            : null,
        createRule: null,
        _meta: { idempotencyKey: newId() },
      });
    } catch (error) {
      // Answered elsewhere, or expired: the card goes, as a settled one does.
      if (
        error instanceof CoreCoworkRequestError &&
        SETTLED_KINDS.has(error.payload.kind)
      ) {
        if (shownByChat.get(chatKey(req))?.delete(req.requestId) === true)
          for (const listener of cancelListeners)
            listener({ requestId: req.requestId });
        return false;
      }
      throw error;
    }
    shownByChat.get(chatKey(req))?.delete(req.requestId);
    return true;
  }

  return {
    setFocused,
    pendingRequests,
    refresh,
    respond: (req) => answer(req, req.decision, req.policyRevision ?? 0),
    // A dismissed card denies its tool call, as a cloud chat has no other
    // way to let it go.
    dismiss: (req) => answer(req, { behavior: 'deny' }, 0),
    onRequest: (listener) => {
      requestListeners.add(listener);
      return (): void => {
        requestListeners.delete(listener);
      };
    },
    onCancelled: (listener) => {
      cancelListeners.add(listener);
      return (): void => {
        cancelListeners.delete(listener);
      };
    },
    // The store drops the cloud scopes with their cards (CAN-4185 D7), so
    // nothing counts as shown once they come back.
    closeAll: () => {
      for (const entry of followed.values()) stopStream(entry);
      followed.clear();
      shownByChat.clear();
    },
  };
}
