import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkStream,
} from '@canopy/app-state/core-cowork';
import {
  type CanopyErrorPayload,
  CORE_APPROVAL_INSTRUCTION_DEFINITIONS,
  CORE_APPROVAL_QUERY_DEFINITIONS,
  CORE_APPROVAL_STREAM_DEFINITIONS,
  type CoreApprovalListedRequest,
} from '@canopy/protocol/canopy-core';
import type {
  ApprovalCancelledEvent,
  ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
import { createWebCoreChatBackend } from '../index';
import { createWebCoreChatBackendCore } from '../web-core-chat-backend';

// Tool approvals in a cloud chat on desktop (CAN-6515): the chat store's
// approval cards come from the web core for the cloud chats on screen, and
// the answers go back to it. Before, the web core backend listed none and
// refused every answer, so a Claude turn waiting on one stalled until Stop.

const CHAT = {
  projectId: 'web-core:11111111-1111-4111-8111-111111111111',
  worktreeId: 'web-core:22222222-2222-4222-8222-222222222222',
  chatId: 'web-core:33333333-3333-4333-8333-333333333333',
};
const CORE_CHAT = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = `${CORE_CHAT}/approval-1`;

const LIST = CORE_APPROVAL_QUERY_DEFINITIONS['core.approval.request.list'];
const RESPOND =
  CORE_APPROVAL_INSTRUCTION_DEFINITIONS['core.approval.request.respond'];
const EVENTS = CORE_APPROVAL_STREAM_DEFINITIONS['core.approval.request.events'];

function pendingApproval(): CoreApprovalListedRequest {
  return {
    requestId: REQUEST_ID,
    sessionId: CORE_CHAT,
    chatId: CORE_CHAT,
    turnId: null,
    target: { kind: 'tool', toolName: 'Bash', providerId: null },
    explanation: 'ls -la',
    policyRevision: 0,
    state: 'pending',
    requestedAt: '2026-11-12T12:00:00.000Z',
    expiresAt: '2026-11-12T12:10:00.000Z',
    subagentId: null,
    suggestedRule: null,
    presentation: {
      toolCallId: 'toolu_bash',
      details: { kind: 'command', command: 'ls -la' },
      explainable: true,
    },
  };
}

/** The request as an event item carries it: without its card. */
function raisedRequest(): Omit<CoreApprovalListedRequest, 'presentation'> {
  const { presentation: _card, ...raised } = pendingApproval();
  void _card;
  return raised;
}

/** A stream the test feeds frame by frame. */
class FakeStream implements CoreCoworkStream {
  private readonly frames: unknown[] = [];
  private waiting: ((frame: unknown) => void) | null = null;
  closed = false;

  push(frame: unknown): void {
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(frame);
    } else this.frames.push(frame);
  }

  next(): Promise<{ done: true } | { done: false; value: unknown }> {
    if (this.closed) return Promise.resolve({ done: true });
    const frame = this.frames.shift();
    if (frame !== undefined)
      return Promise.resolve({ done: false, value: frame });
    return new Promise((resolve) => {
      this.waiting = (value): void => resolve({ done: false, value });
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function setup(): {
  backend: ReturnType<typeof createWebCoreChatBackend>;
  core: ReturnType<typeof createWebCoreChatBackendCore>;
  stream: () => FakeStream;
  pending: CoreApprovalListedRequest[];
  responds: Record<string, unknown>[];
  streamParams: Record<string, unknown>[];
  lists: { hold: boolean; failNext: boolean; readonly release: () => void };
  /** A refusal the next approval stream opens with. */
  streams: { refuseNext: CanopyErrorPayload | null };
} {
  const pending: CoreApprovalListedRequest[] = [];
  // Held list replies answer with the requests pending when they were read.
  const held: (() => void)[] = [];
  const lists = {
    hold: false,
    failNext: false,
    release: (): void => {
      for (const reply of held.splice(0)) reply();
    },
  };
  const responds: Record<string, unknown>[] = [];
  const streamParams: Record<string, unknown>[] = [];
  const streams: { refuseNext: CanopyErrorPayload | null } = {
    refuseNext: null,
  };
  let open: FakeStream | null = null;
  const core = createWebCoreChatBackendCore({
    invoker: () => ({
      request: (method, params): Promise<CanopyCoreRelayLikeReply> => {
        if (method === 'core.approval.request.list') {
          expect(LIST.params.safeParse(params).error).toBeUndefined();
          if (lists.failNext) {
            lists.failNext = false;
            return Promise.resolve({
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'The web core is restarting.',
                retry: { kind: 'never' },
              },
            });
          }
          const value = { requests: [...pending], nextCursor: null };
          expect(LIST.result.safeParse(value).error).toBeUndefined();
          if (lists.hold)
            return new Promise((resolve) => {
              held.push((): void => resolve({ ok: true, value }));
            });
          return Promise.resolve({ ok: true, value });
        }
        if (method === 'core.chat.message.send')
          return Promise.resolve({
            ok: true,
            value: {
              commandId: params.commandId,
              revision: 2,
              outcome: 'applied',
              entityId: 'turn-1',
              messageId: params.messageId,
            },
          });
        if (method === 'core.approval.request.respond') {
          expect(RESPOND.params.safeParse(params).error).toBeUndefined();
          responds.push(params);
          const settled = pending.shift();
          return Promise.resolve({
            ok: true,
            value: { ...settled, state: 'allowed' },
          });
        }
        return Promise.reject(new Error(`unexpected ${method}`));
      },
      openStream: (method, params): Promise<CoreCoworkStream> => {
        // The running turn's live reply, which these cases never feed.
        if (method === 'core.chat.live.events')
          return Promise.resolve(new FakeStream());
        if (method !== 'core.approval.request.events')
          return Promise.reject(new Error(`unexpected stream ${method}`));
        expect(EVENTS.params.safeParse(params).error).toBeUndefined();
        streamParams.push(params);
        const refusal = streams.refuseNext;
        streams.refuseNext = null;
        if (refusal !== null)
          return Promise.reject(new CoreCoworkRequestError(refusal));
        open = new FakeStream();
        return Promise.resolve(open);
      },
    }),
    newId: () => crypto.randomUUID(),
  });
  return {
    backend: createWebCoreChatBackend(core),
    core,
    stream: () => {
      if (open === null) throw new Error('No approval stream is open.');
      return open;
    },
    pending,
    responds,
    streamParams,
    lists,
    streams,
  };
}

/** The cards the store still shows: raised and not yet cancelled. */
function showing(
  requests: readonly ApprovalRequestEvent[],
  cancelled: readonly ApprovalCancelledEvent[],
): string[] {
  const shown = new Set<string>();
  for (const event of requests) shown.add(event.requestId);
  for (const event of cancelled) shown.delete(event.requestId);
  return [...shown];
}

describe('tool approvals in a cloud chat on desktop (CAN-6515)', () => {
  it('shows a cloud chat’s approval with its card, under the store’s ids, and sends the answer to the web core', async () => {
    const { backend, core, stream, pending, responds, streamParams } = setup();
    const requests: ApprovalRequestEvent[] = [];
    const cancelled: ApprovalCancelledEvent[] = [];
    backend.approvals.onRequest((event) => requests.push(event));
    backend.approvals.onCancelled((event) => cancelled.push(event));

    core.setLiveChats([CHAT]);
    await flush();
    expect(streamParams).toEqual([
      { scope: { chatId: CORE_CHAT }, cursor: null },
    ]);

    // The web core raises an approval: its card reaches the store.
    pending.push(pendingApproval());
    const item = {
      kind: 'request',
      request: raisedRequest(),
      occurredAt: '2026-11-12T12:00:00.000Z',
    };
    expect(EVENTS.item?.safeParse(item).error).toBeUndefined();
    stream().push({ kind: 'item', item });
    await flush();
    expect(requests).toEqual([
      expect.objectContaining({
        requestId: REQUEST_ID,
        ...CHAT,
        surface: 'chat',
        title: 'Agent wants to use Bash',
        details: { kind: 'command', command: 'ls -la' },
        toolUseId: 'toolu_bash',
        policyRevision: 0,
      }),
    ]);
    await expect(backend.approvals.pendingRequests()).resolves.toEqual(
      requests,
    );

    // Allow goes to the web core, for this request only.
    await expect(
      backend.approvals.respond({
        ...CHAT,
        requestId: REQUEST_ID,
        decision: { behavior: 'allow', scope: 'once' },
        policyRevision: 0,
      }),
    ).resolves.toBe(true);
    expect(responds).toEqual([
      expect.objectContaining({
        requestId: REQUEST_ID,
        policyRevision: 0,
        decision: 'allow',
        stopTurn: false,
        message: null,
        createRule: null,
      }),
    ]);
  });

  it('drops a card the web core settles elsewhere, and a deny carries its reason and stop', async () => {
    const { backend, core, stream, pending, responds } = setup();
    const cancelled: ApprovalCancelledEvent[] = [];
    backend.approvals.onCancelled((event) => cancelled.push(event));
    pending.push(pendingApproval());
    core.setLiveChats([CHAT]);
    await flush();
    stream().push({
      kind: 'item',
      item: {
        kind: 'resolved',
        requestId: REQUEST_ID,
        state: 'allowed',
        occurredAt: '2026-11-12T12:01:00.000Z',
      },
    });
    await flush();
    expect(cancelled).toEqual([{ requestId: REQUEST_ID }]);

    pending.push(pendingApproval());
    await backend.approvals.respond({
      ...CHAT,
      requestId: REQUEST_ID,
      decision: {
        behavior: 'deny',
        scope: 'once',
        message: 'Not that folder',
        stopTurn: true,
      },
    });
    expect(responds.at(-1)).toMatchObject({
      decision: 'deny',
      stopTurn: true,
      message: 'Not that folder',
    });
  });

  it('drops a card settled while its chat was off screen once the chat is back', async () => {
    const { backend, core, pending } = setup();
    const requests: ApprovalRequestEvent[] = [];
    const cancelled: ApprovalCancelledEvent[] = [];
    backend.approvals.onRequest((event) => requests.push(event));
    backend.approvals.onCancelled((event) => cancelled.push(event));
    pending.push(pendingApproval());
    core.setLiveChats([CHAT]);
    await flush();
    expect(showing(requests, cancelled)).toEqual([REQUEST_ID]);

    // Answered on the web while desktop showed another chat.
    core.setLiveChats([]);
    await flush();
    pending.splice(0);
    core.setLiveChats([CHAT]);
    await flush();
    expect(showing(requests, cancelled)).toEqual([]);
  });

  it('a settlement that arrives while the first list read is out leaves no card', async () => {
    const { backend, core, stream, pending, lists } = setup();
    const requests: ApprovalRequestEvent[] = [];
    const cancelled: ApprovalCancelledEvent[] = [];
    backend.approvals.onRequest((event) => requests.push(event));
    backend.approvals.onCancelled((event) => cancelled.push(event));
    pending.push(pendingApproval());
    lists.hold = true;
    core.setLiveChats([CHAT]);
    await flush();

    // The list read saw the request pending; it is settled before it answers.
    pending.splice(0);
    stream().push({
      kind: 'item',
      item: {
        kind: 'resolved',
        requestId: REQUEST_ID,
        state: 'allowed',
        occurredAt: '2026-11-12T12:01:00.000Z',
      },
    });
    await flush();
    lists.hold = false;
    lists.release();
    await flush();
    expect(showing(requests, cancelled)).toEqual([]);
  });

  it('a card read through pendingRequests still reaches the store when its request item arrives', async () => {
    const { backend, core, stream, pending } = setup();
    const requests: ApprovalRequestEvent[] = [];
    backend.approvals.onRequest((event) => requests.push(event));
    core.setLiveChats([CHAT]);
    await flush();

    // The store asks for one request only and ignores the rest.
    pending.push(pendingApproval());
    await backend.approvals.pendingRequests();
    stream().push({
      kind: 'item',
      item: {
        kind: 'request',
        request: raisedRequest(),
        occurredAt: '2026-11-12T12:00:00.000Z',
      },
    });
    await flush();
    expect(requests.map((event) => event.requestId)).toEqual([REQUEST_ID]);
  });

  it('a first list read that fails is read again, so an approval already pending shows', async () => {
    const { backend, core, pending, lists } = setup();
    const requests: ApprovalRequestEvent[] = [];
    backend.approvals.onRequest((event) => requests.push(event));
    pending.push(pendingApproval());
    lists.failNext = true;
    core.setLiveChats([CHAT]);
    await flush();
    expect(requests).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await flush();
    expect(requests.map((event) => event.requestId)).toEqual([REQUEST_ID]);
  });

  it('a still-pending approval shows again after the cloud went offline and came back', async () => {
    const { backend, core, pending } = setup();
    const requests: ApprovalRequestEvent[] = [];
    backend.approvals.onRequest((event) => requests.push(event));
    pending.push(pendingApproval());
    core.setLiveChats([CHAT]);
    await flush();
    expect(requests).toHaveLength(1);

    // Offline: the store drops the cloud scope with its cards.
    core.closeAll();
    core.setLiveChats([CHAT]);
    await flush();
    expect(requests.map((event) => event.requestId)).toEqual([
      REQUEST_ID,
      REQUEST_ID,
    ]);
  });
  it('shows the approval a new chat’s first turn raised before its stream opened, though the web core did not know the chat when it came on screen (CAN-6643)', async () => {
    const { backend, core, pending, streamParams, streams } = setup();
    const requests: ApprovalRequestEvent[] = [];
    backend.approvals.onRequest((event) => requests.push(event));

    // A task just created: the web core does not know its chat yet.
    streams.refuseNext = {
      kind: 'not_found',
      message: 'The chat was not found.',
      retry: { kind: 'never' },
    };
    core.setLiveChats([CHAT]);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await flush();
    // Not asked again while nothing runs there, as for a deleted chat.
    expect(streamParams).toHaveLength(1);

    // The first message starts a turn, which asks before it runs a command,
    // before the stream opens again: no item ever reports it, so the list
    // read after the reopen is what shows it.
    pending.push(pendingApproval());
    await core.sendMessage({
      projectId: CHAT.projectId,
      worktreeId: CHAT.worktreeId,
      chatId: CHAT.chatId,
      userMessageId: 'desktop-first',
      text: 'Run ls -la',
    });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await flush();
    expect(streamParams).toHaveLength(2);
    expect(requests.map((event) => event.requestId)).toEqual([REQUEST_ID]);
  });

  it('stops asking for a deleted chat’s approvals, with no retry loop (CAN-6643)', async () => {
    const { core, streamParams, streams } = setup();
    const notFound: CanopyErrorPayload = {
      kind: 'not_found',
      message: 'The chat was not found.',
      retry: { kind: 'never' },
    };
    const send = (id: string): Promise<unknown> =>
      core.sendMessage({
        projectId: CHAT.projectId,
        worktreeId: CHAT.worktreeId,
        chatId: CHAT.chatId,
        userMessageId: id,
        text: 'Run ls -la',
      });
    const settle = async (): Promise<void> => {
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await flush();
    };

    streams.refuseNext = notFound;
    core.setLiveChats([CHAT]);
    await settle();
    expect(streamParams).toHaveLength(1);

    // A turn runs, so the chat is asked for again, and the web core still
    // does not know it: it was deleted.
    streams.refuseNext = notFound;
    await send('desktop-first');
    await settle();
    expect(streamParams).toHaveLength(2);

    // Nothing asks again: not the turn still running, nor a later one.
    await send('desktop-second');
    await settle();
    expect(streamParams).toHaveLength(2);
  });
});
