import type {
  PortalChatMessage,
  PortalQueuedMessage,
} from '@canopy/protocol/portal';
import {
  createChatStore,
  type ChatStoreState,
} from '../../chat/create-chat-store';
import {
  bindCloudChatThread,
  CloudChatStopUnavailableError,
  type CloudChatThreadTarget,
} from '../cloud-chat-thread';
import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '../invoker';

/** The thread's transcript claim, whatever object it is. */
const ANY_CLAIM: unknown = expect.any(Object);

const target: CloudChatThreadTarget = {
  key: 'web-core:chat-1',
  workspaceId: 'ws-1',
  worktreeId: 'chat-1',
  chatId: 'chat-1',
};

const message = (id: string, text: string): Record<string, unknown> => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp: 1,
});

function snapshot(status: string, revision = 4): Record<string, unknown> {
  return {
    workspaceId: 'ws-1',
    worktreeId: 'chat-1',
    revision,
    eventsCursor: { daemonEpoch: 'e1', sequence: revision },
    tabs: { activeTabId: 'chat-1', items: [] },
    archives: [],
    runtimeByChatId: { 'chat-1': { status, queuedMessageIds: [] } },
    queue: [],
  };
}

function transcript(
  ...messages: Record<string, unknown>[]
): Record<string, unknown> {
  return {
    messages,
    totalMessages: messages.length,
    transcriptRevision: 1,
  };
}

type StreamRead = { done: true } | { done: false; value: unknown };

/** A stream the test feeds frame by frame. */
function controlledStream(): CoreCoworkStream & {
  push(frame: unknown): void;
  end(): void;
  closed: boolean;
} {
  const reads: StreamRead[] = [];
  let waiting: ((value: StreamRead) => void) | null = null;
  const deliver = (read: StreamRead): void => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(read);
    } else reads.push(read);
  };
  const stream = {
    closed: false,
    push(frame: unknown): void {
      deliver({ done: false, value: frame });
    },
    end(): void {
      deliver({ done: true });
    },
    next(): Promise<StreamRead> {
      const read = reads.shift();
      if (read) return Promise.resolve(read);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close(): Promise<void> {
      stream.closed = true;
      return Promise.resolve();
    },
  };
  return stream;
}

function ok(value: unknown): CanopyCoreRelayLikeReply {
  return { ok: true, value };
}

interface Harness {
  readonly thread: ReturnType<typeof bindCloudChatThread>;
  readonly calls: { method: string; params: Record<string, unknown> }[];
  readonly state: {
    hydrate: jest.Mock<void, [string, unknown[], Record<string, unknown>]>;
    reset: jest.Mock<void, [string]>;
    claimTranscript: jest.Mock<void, [string, object]>;
    releaseTranscript: jest.Mock<void, [string, object]>;
    bindOptimisticSend: jest.Mock<void, [string, unknown]>;
    rollbackOptimisticSend: jest.Mock<void, [string, unknown]>;
    threads: Record<string, { messages: Record<string, unknown>[] }>;
  };
  readonly stream: ReturnType<typeof controlledStream>;
  /** Each core.chat.live.events stream the thread opened, oldest first. */
  readonly lives: ReturnType<typeof controlledStream>[];
  /** Holds the next live open until the returned function is called. */
  readonly deferLive: () => () => void;
  readonly project: jest.Mock<
    unknown[],
    [{ chatKey: string; messages: readonly unknown[] }]
  >;
}

function harness(
  handlers: Record<
    string,
    (
      params: Record<string, unknown>,
    ) => CanopyCoreRelayLikeReply | Promise<CanopyCoreRelayLikeReply>
  >,
  options: {
    readonly liveRefused?: boolean;
    readonly hostOwnsRuntime?: boolean;
  } = {},
): Harness {
  const stream = controlledStream();
  const lives: ReturnType<typeof controlledStream>[] = [];
  let liveGate: Promise<void> | null = null;
  const deferLive = (): (() => void) => {
    let open = (): void => undefined;
    liveGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return open;
  };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const invoker: CoreCoworkInvoker = {
    request: (method, params) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected ${method}`);
      return Promise.resolve(handler(params));
    },
    openStream: (method, params) => {
      calls.push({ method, params });
      if (method !== 'core.chat.live.events') return Promise.resolve(stream);
      if (options.liveRefused)
        return Promise.reject(
          new CoreCoworkRequestError({
            kind: 'capability_unavailable',
            message:
              'core.chat.live.events is not available on this connection.',
            retry: { kind: 'never' },
          }),
        );
      const live = controlledStream();
      lives.push(live);
      const gate = liveGate;
      liveGate = null;
      return gate === null ? Promise.resolve(live) : gate.then(() => live);
    },
  };
  const state: Harness['state'] = {
    hydrate: jest.fn<void, [string, unknown[], Record<string, unknown>]>(),
    reset: jest.fn<void, [string]>(),
    claimTranscript: jest.fn<void, [string, object]>(),
    releaseTranscript: jest.fn<void, [string, object]>(),
    bindOptimisticSend: jest.fn<void, [string, unknown]>(),
    rollbackOptimisticSend: jest.fn<void, [string, unknown]>(),
    threads: {},
  };
  const chatStore = {
    getState: (): ChatStoreState => state as unknown as ChatStoreState,
  };
  let ids = 0;
  const project = jest.fn(
    ({ messages }: { chatKey: string; messages: readonly unknown[] }) =>
      messages.map((each) => ({
        messageId: (each as { id: string }).id,
        createdAtMs: 1,
      })),
  );
  const thread = bindCloudChatThread({
    invoker,
    target,
    chatStore,
    project: project as never,
    newId: () => `id-${(ids += 1)}`,
    reopenDelayMs: 5,
    liveReopenDelayMs: 5,
    liveHoldMs: 40,
    ...(options.hostOwnsRuntime === true ? { hostOwnsRuntime: true } : {}),
  });
  return { thread, calls, state, stream, lives, deferLive, project };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** The live reply saying no turn runs. */
const LIVE_IDLE = {
  kind: 'item',
  cursor: { daemonEpoch: 'live', sequence: 1 },
  item: { kind: 'idle', chatId: 'chat-1' },
};

/** A host-owned thread bound to a real chat store, with its events stream. */
function hostOwnedOnStore(
  status: string | (() => string),
  readTranscript: () => Promise<CanopyCoreRelayLikeReply> = () =>
    Promise.resolve(ok(transcript(message('m1', 'Hi')))),
  /** Each events open replays the held batch, as a cursorless open does. */
  replayHead = false,
): {
  store: ReturnType<typeof createChatStore>;
  thread: ReturnType<typeof bindCloudChatThread>;
  turn: () => unknown;
  ids: () => readonly string[];
  push: (...changes: unknown[]) => void;
  runtime: (status: string) => unknown;
  /** The live reply streams opened, oldest first. */
  lives: ReturnType<typeof controlledStream>[];
  /** The task's newest events stream: each (re)open gets its own. */
  events: () => ReturnType<typeof controlledStream>;
} {
  const store = createChatStore({
    subscribe: (): (() => void) => () => undefined,
    command: () => Promise.resolve({}),
  } as never);
  let events = controlledStream();
  let eventOpens = 0;
  const lives: ReturnType<typeof controlledStream>[] = [];
  const thread = bindCloudChatThread({
    invoker: {
      request: (method) =>
        method === 'core.chat.snapshot.get'
          ? Promise.resolve(
              ok(snapshot(typeof status === 'string' ? status : status())),
            )
          : readTranscript(),
      openStream: (method) => {
        if (method !== 'core.chat.live.events') {
          if ((eventOpens += 1) > 1) events = controlledStream();
          if (replayHead)
            events.push({
              kind: 'item',
              cursor: { daemonEpoch: 'e1', sequence: 4 },
              item: {
                schemaVersion: 1,
                eventId: 'ev-4',
                occurredAt: '2026-11-10T12:00:00.000Z',
                projectId: 'ws-1',
                worktreeId: 'chat-1',
                baseRevision: 3,
                revision: 4,
                changes: [
                  {
                    type: 'runtime.patched',
                    chatId: 'chat-1',
                    runtime: { status: 'streaming', queuedMessageIds: [] },
                  },
                ],
              },
            });
          return Promise.resolve(events);
        }
        const live = controlledStream();
        lives.push(live);
        return Promise.resolve(live);
      },
    },
    target,
    chatStore: store,
    reopenDelayMs: 5,
    liveReopenDelayMs: 5,
    project: ({ messages }) =>
      messages.map((each) => {
        const row = each as {
          id: string;
          role: 'user' | 'assistant';
          blocks: { text: string }[];
          timestamp: number;
        };
        return {
          messageId: row.id,
          chatId: target.key,
          role: row.role,
          status: 'complete',
          text: row.blocks[0]?.text ?? '',
          createdAtMs: row.timestamp,
        };
      }),
    hostOwnsRuntime: true,
  });
  let revision = 4;
  return {
    store,
    thread,
    lives,
    events: () => events,
    turn: () => {
      const entry = store.getState().threads[target.key];
      return { status: entry?.status, turnActive: entry?.turnActive };
    },
    ids: () =>
      (store.getState().threads[target.key]?.messages ?? []).map(
        (each) => each.messageId,
      ),
    push: (...changes) => {
      revision += 1;
      events.push({
        kind: 'item',
        cursor: { daemonEpoch: 'e1', sequence: revision },
        item: {
          schemaVersion: 1,
          eventId: `ev-${revision}`,
          occurredAt: '2026-11-10T12:00:00.000Z',
          projectId: 'ws-1',
          worktreeId: 'chat-1',
          baseRevision: revision - 1,
          revision,
          changes,
        },
      });
    },
    runtime: (runtimeStatus) => ({
      type: 'runtime.patched',
      chatId: 'chat-1',
      runtime: { status: runtimeStatus, queuedMessageIds: [] },
    }),
  };
}

describe('cloud chat thread binding (CAN-4185)', () => {
  it('a core.chat.events batch from another client updates the open transcript live', async () => {
    const { calls, state, stream, project } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript(message('m1', 'Hello'))),
    });
    await flush();
    expect(calls.find((c) => c.method === 'core.chat.events')?.params).toEqual({
      scope: { projectId: 'ws-1', worktreeId: 'chat-1' },
      cursor: { daemonEpoch: 'e1', sequence: 4 },
    });
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('m2', 'From the web'),
          },
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: { status: 'streaming', queuedMessageIds: [] },
          },
        ],
      },
    });
    await flush();
    const last = state.hydrate.mock.calls.at(-1);
    expect(last?.[0]).toBe('web-core:chat-1');
    expect(last?.[1]).toEqual([
      { messageId: 'm1', createdAtMs: 1, presentationOrder: 0 },
      { messageId: 'm2', createdAtMs: 1, presentationOrder: 1 },
    ]);
    expect(last?.[2]).toMatchObject({ turnActive: true, status: 'streaming' });
    expect(project).toHaveBeenLastCalledWith({
      chatKey: 'web-core:chat-1',
      messages: [message('m1', 'Hello'), message('m2', 'From the web')],
      tasks: [],
    });
  });

  it('tells its host the messages its transcript holds, as each batch lands, so accepted sends can retire (CAN-6509)', async () => {
    const { thread, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript(message('m1', 'Hello'))),
    });
    await flush();
    expect([...thread.getMessageIds()]).toEqual(['m1']);
    const seen: string[][] = [];
    thread.subscribeMessageIds(() => seen.push([...thread.getMessageIds()]));
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('m2', 'Sent from this tab'),
          },
        ],
      },
    });
    await flush();
    expect(seen.at(-1)).toEqual(['m1', 'm2']);
  });

  it('skips the replayed batch of a cursorless open and follows live, without re-reading', async () => {
    const withoutCursor = snapshot('idle', 4);
    delete withoutCursor.eventsCursor;
    const { calls, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(withoutCursor),
      'core.chat.transcript.page': () => ok(transcript()),
    });
    await flush();
    const batch = (base: number, id: string): Record<string, unknown> => ({
      schemaVersion: 1,
      eventId: `ev-${base + 1}`,
      occurredAt: '2026-11-07T15:00:00.000Z',
      projectId: 'ws-1',
      worktreeId: 'chat-1',
      baseRevision: base,
      revision: base + 1,
      changes: [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: message(id, id),
        },
      ],
    });
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 4 },
      item: batch(3, 'old'),
    });
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: batch(4, 'new'),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      calls.filter((c) => c.method === 'core.chat.snapshot.get'),
    ).toHaveLength(1);
    expect(stream.closed).toBe(false);
    expect(state.hydrate.mock.calls.at(-1)?.[1]).toEqual([
      { messageId: 'new', createdAtMs: 1, presentationOrder: 0 },
    ]);
  });

  it('re-reads the snapshot when a batch does not follow the held revision', async () => {
    const { calls, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
    });
    await flush();
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 9 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-9',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 8,
        revision: 9,
        changes: [
          { type: 'message.removed', chatId: 'chat-1', messageId: 'x' },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      calls.filter((c) => c.method === 'core.chat.snapshot.get'),
    ).toHaveLength(2);
    expect(stream.closed).toBe(true);
  });

  it('a lost send reply asks for the receipt before resending, and never sends twice', async () => {
    const sends: Record<string, unknown>[] = [];
    const { thread, calls, state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) => {
        sends.push(params);
        return {
          ok: false,
          error: {
            kind: 'unavailable',
            message: 'Lost.',
            retry: { kind: 'same_idempotency_key' },
          },
        };
      },
      'core.chat.send.receipt': (params) =>
        ok({
          outcome: 'matched',
          receipt: {
            commandId: params.commandId,
            revision: 5,
            outcome: 'applied',
            entityId: 'turn-1',
          },
        }),
    });
    await flush();
    await thread.send({ text: 'Hi', optimisticLocalId: 'local-1' });
    expect(sends).toHaveLength(1);
    const receipt = calls.find((c) => c.method === 'core.chat.send.receipt');
    expect(receipt?.params.commandId).toBe(sends[0]?.commandId);
    expect(sends[0]?._meta).toEqual({ idempotencyKey: sends[0]?.commandId });
    expect(state.bindOptimisticSend).toHaveBeenCalledWith('web-core:chat-1', {
      optimisticLocalId: 'local-1',
      userMessageId: sends[0]?.messageId,
    });
    expect(state.rollbackOptimisticSend).not.toHaveBeenCalled();
  });

  it('resends a missing send once under the same command id and key', async () => {
    const sends: Record<string, unknown>[] = [];
    const { thread } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) => {
        sends.push(params);
        return sends.length === 1
          ? {
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'Lost.',
                retry: { kind: 'same_idempotency_key' },
              },
            }
          : ok({
              commandId: params.commandId,
              revision: 5,
              outcome: 'applied',
            });
      },
      'core.chat.send.receipt': () => ok({ outcome: 'missing' }),
    });
    await flush();
    await thread.send({ text: 'Hi' });
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
  });

  it('stop cancels the turn this client started from idle, not a follow-up queued behind it, before any runtime report', async () => {
    const turnIds = ['turn-7', 'turn-8'];
    const { thread, calls } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) =>
        ok({
          commandId: params.commandId,
          revision: 5,
          outcome: 'applied',
          entityId: turnIds.shift(),
        }),
      'core.chat.turn.cancel': () => ok({}),
    });
    await flush();
    await thread.send({ text: 'Go' });
    await thread.send({ text: 'Then this' });
    await thread.stop();
    expect(
      calls.find((c) => c.method === 'core.chat.turn.cancel')?.params,
    ).toEqual({ chatId: 'chat-1', turnId: 'turn-7', reason: 'user' });
  });

  it('stop cancels a turn another client started, by the id the web core reports', async () => {
    const withTurn = {
      ...snapshot('streaming'),
      runtimeByChatId: {
        'chat-1': {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurnId: 'turn-web',
        },
      },
    };
    const { thread, calls } = harness({
      'core.chat.snapshot.get': () => ok(withTurn),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.turn.cancel': () => ok({}),
    });
    await flush();
    await thread.stop();
    expect(
      calls.find((c) => c.method === 'core.chat.turn.cancel')?.params,
    ).toEqual({ chatId: 'chat-1', turnId: 'turn-web', reason: 'user' });
  });

  it('refuses stop with no turn of its own, and sends nothing', async () => {
    const { thread, calls } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('streaming')),
      'core.chat.transcript.page': () => ok(transcript()),
    });
    await flush();
    await expect(thread.stop()).rejects.toBeInstanceOf(
      CloudChatStopUnavailableError,
    );
    expect(calls.some((c) => c.method === 'core.chat.turn.cancel')).toBe(false);
  });

  it('closing for offline drops the thread and ends its stream', async () => {
    const { thread, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript(message('m1', 'x'))),
    });
    await flush();
    thread.close();
    expect(state.reset).toHaveBeenCalledWith('web-core:chat-1');
    expect(stream.closed).toBe(true);
    const hydrations = state.hydrate.mock.calls.length;
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {},
    });
    await flush();
    expect(state.hydrate.mock.calls.length).toBe(hydrations);
  });

  it('a streamed update to an existing message moves its revision forward', async () => {
    const { state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('streaming')),
      'core.chat.transcript.page': () => ok(transcript(message('m1', 'Hel'))),
    });
    await flush();
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('m1', 'Hello world'),
          },
        ],
      },
    });
    await flush();
    const projected = state.hydrate.mock.calls.at(-1)?.[1] as {
      messageId: string;
      updatedAtMs?: number;
    }[];
    expect(projected[0]?.updatedAtMs).toBeGreaterThan(1);
  });

  it('reconciles an optimistic send with the canonical message id from the receipt', async () => {
    const { thread, state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) =>
        ok({
          commandId: params.commandId,
          revision: 5,
          outcome: 'applied',
          messageId: 'srv-1',
        }),
    });
    await flush();
    await thread.send({ text: 'Hi', optimisticLocalId: 'local-1' });
    expect(state.bindOptimisticSend).toHaveBeenLastCalledWith(
      'web-core:chat-1',
      { optimisticLocalId: 'local-1', userMessageId: 'srv-1' },
    );
  });

  it('shows its own queued send until it runs', async () => {
    const { thread, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('streaming')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) =>
        ok({
          commandId: params.commandId,
          revision: 5,
          outcome: 'applied',
          messageId: 'srv-2',
        }),
    });
    await flush();
    await thread.send({ text: 'Next please' });
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: { status: 'streaming', queuedMessageIds: ['srv-2'] },
          },
        ],
      },
    });
    await flush();
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      queuedMessages: [
        {
          id: 'srv-2',
          text: 'Next please',
          origin: 'desktop',
          supersedesUserMessageId: 'srv-2',
        },
      ],
    });
  });

  it("leaves the queue to a host that owns it, raises a running turn the host hasn't reported, and follows the live reply", async () => {
    const { thread, state, lives } = harness(
      {
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(message('m1', 'Hi'))),
      },
      { hostOwnsRuntime: true },
    );
    await flush();
    thread.setLive(true);
    await flush();
    expect(lives).toHaveLength(1);
    expect(state.hydrate).toHaveBeenCalled();
    for (const [, , options] of state.hydrate.mock.calls)
      expect(options).not.toHaveProperty('queuedMessages');
    // The claim drops REST turn frames: the web core's running turn shows.
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      status: 'streaming',
      turnActive: true,
    });
  });

  it("a host-owned thread clears its own failure notice and leaves the host's turn and settings alone", async () => {
    let pages = 0;
    const { thread, state } = harness(
      {
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () =>
          (pages += 1) === 1
            ? {
                ok: false,
                error: {
                  kind: 'unavailable',
                  message: 'Read failed.',
                  retry: { kind: 'same_request' },
                },
              }
            : ok(transcript(message('m1', 'Hi'))),
      },
      { hostOwnsRuntime: true },
    );
    state.threads[target.key] = {
      messages: [{ messageId: 'optimistic-1' }],
      turnActive: true,
    } as never;
    await flush();
    expect(state.hydrate.mock.calls[0]?.[2]).toEqual({
      status: 'error',
      error: 'Read failed.',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.hydrate.mock.calls.at(-2)?.[2]).toEqual({
      replaceMessages: true,
      transcriptOwner: ANY_CLAIM,
    });
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toEqual({
      status: 'streaming',
      turnActive: true,
      error: null,
    });
    state.hydrate.mockClear();
    thread.close();
    expect(state.reset).not.toHaveBeenCalled();
    expect(state.hydrate).toHaveBeenCalledWith(
      target.key,
      [{ messageId: 'optimistic-1' }],
      { replaceMessages: true, transcriptOwner: ANY_CLAIM },
    );
    expect(state.releaseTranscript).toHaveBeenCalledWith(
      target.key,
      state.claimTranscript.mock.calls[0]?.[1],
    );
  });

  it('a host-owned thread keeps a finished chat idle when a late reply lands, unless a send is pending', async () => {
    const { state } = harness(
      {
        'core.chat.snapshot.get': () => ok(snapshot('idle')),
        'core.chat.transcript.page': () => ok(transcript(message('m1', 'Hi'))),
      },
      { hostOwnsRuntime: true },
    );
    state.threads[target.key] = {
      messages: [],
      turnActive: false,
      error: 'Host notice.',
    } as never;
    await flush();
    // The web core and the host both say no turn runs: no revived streaming.
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toEqual({
      status: 'idle',
      error: 'Host notice.',
    });

    const pending = harness(
      {
        'core.chat.snapshot.get': () => ok(snapshot('idle')),
        'core.chat.transcript.page': () => ok(transcript(message('m1', 'Hi'))),
      },
      { hostOwnsRuntime: true },
    );
    pending.state.threads[target.key] = {
      messages: [{ messageId: 'optimistic-1' }],
      turnActive: false,
      error: null,
    } as never;
    await flush();
    expect(pending.state.hydrate.mock.calls.at(-1)?.[2]).toEqual({
      replaceMessages: true,
      transcriptOwner: ANY_CLAIM,
    });
  });

  it("a host-owned thread alone writes the chat's messages: REST rows are dropped until it closes", async () => {
    const store = createChatStore({
      subscribe: (): (() => void) => () => undefined,
      command: () => Promise.resolve({}),
    } as never);
    const thread = bindCloudChatThread({
      invoker: {
        request: (method) =>
          Promise.resolve(
            method === 'core.chat.snapshot.get'
              ? ok(snapshot('idle'))
              : ok(transcript(message('m1', 'From the web core'))),
          ),
        openStream: () => Promise.resolve(controlledStream()),
      },
      target,
      chatStore: store,
      project: ({ messages }) =>
        messages.map((each) => ({
          messageId: (each as { id: string }).id,
          chatId: target.key,
          role: 'assistant',
          status: 'complete',
          text: 'From the web core',
          createdAtMs: 1,
        })),
      hostOwnsRuntime: true,
    });
    await flush();
    const rest = {
      messageId: 'rest-1',
      chatId: target.key,
      role: 'assistant',
      status: 'complete',
      text: 'From REST',
      createdAtMs: 2,
    } as const;
    const ids = (): readonly string[] =>
      (store.getState().threads[target.key]?.messages ?? []).map(
        (each) => each.messageId,
      );
    // A REST live frame and a REST page: both dropped, the host's turn kept.
    store.getState().ingestMessageEvent({
      scope: 'worktree',
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      chatId: target.key,
      message: rest,
      occurredAt: '2026-11-10T12:00:00.000Z',
    });
    store.getState().hydrate(target.key, [rest], {
      replaceMessages: true,
      turnActive: true,
    });
    expect(ids()).toEqual(['m1']);
    expect(store.getState().threads[target.key]?.turnActive).toBe(true);
    // Closed, the thread hands the transcript back to REST.
    thread.close();
    store.getState().hydrate(target.key, [rest]);
    expect(ids()).toEqual(['rest-1']);
  });

  it("a host-owned thread lowers a composer send's turn once the web core reports it ran and ended", async () => {
    const { store, turn, push, runtime } = hostOwnedOnStore('idle');
    await flush();
    store
      .getState()
      .addOptimisticUserMessage(target.key, { text: 'Go', createdAtMs: 1 });
    expect(turn()).toEqual({ status: 'streaming', turnActive: true });
    // The send lands before its turn is reported: it stays raised.
    push({
      type: 'message.upserted',
      chatId: 'chat-1',
      message: { ...message('u1', 'Go'), role: 'user' },
    });
    await flush();
    expect(turn()).toEqual({ status: 'streaming', turnActive: true });
    push(runtime('streaming'));
    await flush();
    expect(turn()).toEqual({ status: 'streaming', turnActive: true });
    push(
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: message('m2', 'Done'),
      },
      runtime('idle'),
    );
    await flush();
    expect(turn()).toEqual({ status: 'idle', turnActive: false });
  });

  it("a host-owned thread's first read keeps a composer send in flight and its turn raised", async () => {
    let land = (): void => undefined;
    const read = new Promise<void>((resolve) => {
      land = resolve;
    });
    const { store, turn, ids } = hostOwnedOnStore('idle', () =>
      read.then(() => ok(transcript(message('m1', 'Hi')))),
    );
    store
      .getState()
      .addOptimisticUserMessage(target.key, { text: 'Go', createdAtMs: 1 });
    land();
    await flush();
    expect(ids()).toEqual(['m1', 'optimistic-1-user']);
    expect(turn()).toEqual({ status: 'streaming', turnActive: true });
  });

  it("a host-owned thread clears its read failure to the turn the web core settled, not the host's stale raise", async () => {
    let reads = 0;
    const { store, turn } = hostOwnedOnStore('idle', () =>
      Promise.resolve(
        (reads += 1) === 1
          ? {
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'Read failed.',
                retry: { kind: 'same_request' },
              },
            }
          : ok(transcript(message('m1', 'Hi'))),
      ),
    );
    // A turn the host raised, which ends while the first read fails.
    store
      .getState()
      .hydrate(target.key, [], { status: 'streaming', turnActive: true });
    await flush();
    expect(store.getState().threads[target.key]?.status).toBe('error');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turn()).toEqual({ status: 'idle', turnActive: false });
    expect(store.getState().threads[target.key]?.error).toBeNull();
  });

  it('a host-owned thread re-reads when the live reply says no turn runs, instead of waiting on the feed', async () => {
    let status = 'streaming';
    const { thread, turn, lives } = hostOwnedOnStore(() => status);
    thread.setLive(true);
    await flush();
    expect(turn()).toEqual({ status: 'streaming', turnActive: true });
    expect(lives).toHaveLength(1);
    // The turn ended; no feed batch says so yet.
    status = 'idle';
    lives[0]?.push(LIVE_IDLE);
    lives[0]?.end();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turn()).toEqual({ status: 'idle', turnActive: false });
    expect(lives).toHaveLength(1);
  });

  it('a host-owned thread backs off while the web core says a turn runs and its live reply says none does', async () => {
    let reads = 0;
    const { thread, lives } = hostOwnedOnStore(
      () => {
        reads += 1;
        return 'streaming';
      },
      undefined,
      true,
    );
    thread.setLive(true);
    const answered = new Set<unknown>();
    const until = Date.now() + 150;
    while (Date.now() < until) {
      for (const live of lives)
        if (!answered.has(live)) {
          answered.add(live);
          live.push(LIVE_IDLE);
          live.end();
        }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // 5 ms doubling: a handful of re-reads, not one reopen per delay.
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThanOrEqual(7);
    expect(lives.length).toBeLessThanOrEqual(7);
  });

  it('a host-owned thread lowers the turn when a re-read finds none running, even with a send still unmatched', async () => {
    let status = 'streaming';
    const { store, thread, turn, ids, lives } = hostOwnedOnStore(() => status);
    thread.setLive(true);
    await flush();
    // A send whose prompt the transcript never shows under the same text.
    store
      .getState()
      .addOptimisticUserMessage(target.key, { text: 'Go', createdAtMs: 1 });
    status = 'idle';
    lives[0]?.push(LIVE_IDLE);
    lives[0]?.end();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turn()).toEqual({ status: 'idle', turnActive: false });
    expect(ids()).toContain('optimistic-1-user');
  });

  it('a host-owned thread keeps a send the host echoed before its first read, and its turn', async () => {
    let land = (): void => undefined;
    const read = new Promise<void>((resolve) => {
      land = resolve;
    });
    const { store, ids, turn, push, runtime } = hostOwnedOnStore('idle', () =>
      read.then(() => ok(transcript(message('m1', 'Hi')))),
    );
    store
      .getState()
      .addOptimisticUserMessage(target.key, { text: 'Go', createdAtMs: 5 });
    // REST acknowledges the send before the web core's older read lands.
    store.getState().hydrate(target.key, [
      {
        messageId: 'u1',
        chatId: target.key,
        role: 'user',
        status: 'complete',
        text: 'Go',
        createdAtMs: 5,
      },
    ]);
    land();
    await flush();
    expect(ids()).toEqual(['m1', 'u1']);
    expect(turn()).toEqual({ status: 'streaming', turnActive: true });
    // Core's row for that prompt, under Core's id: the echo goes, once.
    push({
      type: 'message.upserted',
      chatId: 'chat-1',
      message: { ...message('u-core', 'Go'), role: 'user' },
    });
    await flush();
    expect(ids()).toEqual(['m1', 'u-core']);
    push(runtime('streaming'));
    await flush();
    push(runtime('idle'));
    await flush();
    expect(turn()).toEqual({ status: 'idle', turnActive: false });
  });

  it('a host-owned thread shows a send the host queued once: the queue row, then the host’s echo, then Core’s row', async () => {
    const { store, ids, push } = hostOwnedOnStore('streaming');
    await flush();
    const shown = (): unknown => [
      ids(),
      (store.getState().threads[target.key]?.queuedMessages ?? []).map(
        (each) => each.id,
      ),
    ];
    const queued = {
      id: 'q1',
      text: 'Go',
      origin: 'portal',
      enqueuedAtMs: 0,
      supersedesUserMessageId: 'u1',
    } as const;
    store.getState().addOptimisticUserMessage(target.key, {
      text: 'Go',
      createdAtMs: 5,
      localId: 'l1',
    });
    store.getState().bindOptimisticSend(target.key, {
      optimisticLocalId: 'optimistic-l1',
      userMessageId: 'u1',
    });
    // REST queues the send behind the running turn: its row stands for the bubble.
    store.getState().hydrate(target.key, [], { queuedMessages: [queued] });
    expect(shown()).toEqual([['m1'], ['q1']]);
    // REST starts it. The claim fences REST's rows, but its echo of this send
    // is the only copy until Core shows it.
    store.getState().hydrate(
      target.key,
      [
        {
          messageId: 'u1',
          chatId: target.key,
          role: 'user',
          status: 'complete',
          text: 'Go',
          createdAtMs: 5,
        },
      ],
      { queuedMessages: [] },
    );
    expect(shown()).toEqual([['m1', 'u1'], []]);
    push({
      type: 'message.upserted',
      chatId: 'chat-1',
      message: { ...message('m2', 'Done'), timestamp: 30_000 },
    });
    await flush();
    expect(shown()).toEqual([['m1', 'u1', 'm2'], []]);
    // Core writes a queued send's row when it runs, well after the send.
    push({
      type: 'message.upserted',
      chatId: 'chat-1',
      message: { ...message('u-core', 'Go'), role: 'user', timestamp: 20_000 },
    });
    await flush();
    expect(shown()).toEqual([['m1', 'm2', 'u-core'], []]);
  });

  it('a host-owned thread holds each queued send the host started until its own row lands', async () => {
    const { store, ids, push } = hostOwnedOnStore('streaming');
    await flush();
    const user = (
      id: string,
      text: string,
      createdAtMs: number,
    ): PortalChatMessage => ({
      messageId: id,
      chatId: target.key,
      role: 'user',
      status: 'complete',
      text,
      createdAtMs,
    });
    const queue = (...ids: string[]): PortalQueuedMessage[] =>
      ids.map((id) => ({
        id: `q-${id}`,
        text: '',
        origin: 'portal',
        enqueuedAtMs: 0,
        supersedesUserMessageId: id,
      }));
    store
      .getState()
      .hydrate(target.key, [], { queuedMessages: queue('u1', 'u2') });
    store.getState().hydrate(target.key, [user('u1', 'One', 5)], {
      queuedMessages: queue('u2'),
    });
    store
      .getState()
      .hydrate(target.key, [user('u1', 'One', 5), user('u2', 'Two', 6)], {
        queuedMessages: [],
      });
    expect(ids()).toEqual(['m1', 'u1', 'u2']);
    // A same-text bubble a held echo matches is the same send: one copy.
    store
      .getState()
      .addOptimisticUserMessage(target.key, { text: 'Two', createdAtMs: 7 });
    store.getState().hydrate(target.key, [], { queuedMessages: [] });
    expect(ids()).toEqual(['m1', 'u1', 'u2']);
    push({
      type: 'message.upserted',
      chatId: 'chat-1',
      message: { ...message('c1', 'One'), role: 'user', timestamp: 20_000 },
    });
    await flush();
    expect(ids()).toEqual(['m1', 'u2', 'c1']);
    push({
      type: 'message.upserted',
      chatId: 'chat-1',
      message: { ...message('c2', 'Two'), role: 'user', timestamp: 21_000 },
    });
    await flush();
    expect(ids()).toEqual(['m1', 'c1', 'c2']);
  });

  it('a host-owned thread that closes while it holds a host echo hands the message back to the host once', async () => {
    const { store, thread, ids } = hostOwnedOnStore('streaming');
    await flush();
    const echo: PortalChatMessage = {
      messageId: 'u1',
      chatId: target.key,
      role: 'user',
      status: 'complete',
      text: 'Go',
      createdAtMs: 5,
    };
    const queued: PortalQueuedMessage = {
      id: 'q1',
      text: 'Go',
      origin: 'portal',
      enqueuedAtMs: 0,
      supersedesUserMessageId: 'u1',
    };
    store.getState().hydrate(target.key, [], { queuedMessages: [queued] });
    store.getState().hydrate(target.key, [echo], { queuedMessages: [] });
    expect(ids()).toEqual(['m1', 'u1']);
    thread.close();
    // The host's own row for the send, under its canonical id: one copy.
    store
      .getState()
      .hydrate(target.key, [{ ...echo, messageId: 'u1-canonical' }]);
    expect(ids()).toEqual(['u1-canonical']);
  });

  it('a host-owned thread holds two queued sends with the same text until their own rows land', async () => {
    const { store, ids } = hostOwnedOnStore('streaming');
    await flush();
    const echo = (id: string, createdAtMs: number): PortalChatMessage => ({
      messageId: id,
      chatId: target.key,
      role: 'user',
      status: 'complete',
      text: 'yes',
      createdAtMs,
    });
    const queued = (id: string): PortalQueuedMessage => ({
      id: `q-${id}`,
      text: 'yes',
      origin: 'portal',
      enqueuedAtMs: 0,
      supersedesUserMessageId: id,
    });
    store.getState().hydrate(target.key, [], {
      queuedMessages: [queued('u1'), queued('u2')],
    });
    store.getState().hydrate(target.key, [echo('u1', 5), echo('u2', 6)], {
      queuedMessages: [],
    });
    expect(ids()).toEqual(['m1', 'u1', 'u2']);
    // A runtime-only hydrate, as each publish sends while the claim is held.
    store.getState().hydrate(target.key, [], { turnActive: true });
    expect(ids()).toEqual(['m1', 'u1', 'u2']);
  });

  it('a held echo of a multipart prompt lands on Core’s row for it', async () => {
    const { store, ids, push } = hostOwnedOnStore('streaming');
    await flush();
    store.getState().hydrate(target.key, [], {
      queuedMessages: [
        {
          id: 'q1',
          text: '',
          origin: 'portal',
          enqueuedAtMs: 0,
          supersedesUserMessageId: 'u1',
        },
      ],
    });
    // REST joins a prompt's text parts with blank lines; Core's row does not.
    store.getState().hydrate(
      target.key,
      [
        {
          messageId: 'u1',
          chatId: target.key,
          role: 'user',
          status: 'complete',
          text: 'Look at this\n\nand this',
          createdAtMs: 5,
        },
      ],
      { queuedMessages: [] },
    );
    expect(ids()).toEqual(['m1', 'u1']);
    push({
      type: 'message.upserted',
      chatId: 'chat-1',
      message: {
        ...message('u-core', 'Look at thisand this'),
        role: 'user',
        timestamp: 20_000,
      },
    });
    await flush();
    expect(ids()).toEqual(['m1', 'u-core']);
  });

  it('a host-owned thread brings nothing back for a queued send the user deleted', async () => {
    const { store, ids } = hostOwnedOnStore('streaming');
    await flush();
    store.getState().addOptimisticUserMessage(target.key, {
      text: 'Go',
      createdAtMs: 5,
      localId: 'l1',
    });
    store.getState().bindOptimisticSend(target.key, {
      optimisticLocalId: 'optimistic-l1',
      userMessageId: 'u1',
    });
    store.getState().hydrate(target.key, [], {
      queuedMessages: [
        {
          id: 'q1',
          text: 'Go',
          origin: 'portal',
          enqueuedAtMs: 0,
          supersedesUserMessageId: 'u1',
        },
      ],
    });
    store.getState().hydrate(target.key, [], { queuedMessages: [] });
    expect(ids()).toEqual(['m1']);
  });

  it('a send the host queued without a claim leaves its bubble to the host echo, as before', () => {
    const store = createChatStore({
      subscribe: (): (() => void) => () => undefined,
      command: () => Promise.resolve({}),
    } as never);
    store.getState().retainThread(target.key);
    store.getState().addOptimisticUserMessage(target.key, {
      text: 'Go',
      createdAtMs: 5,
      localId: 'l1',
    });
    store.getState().bindOptimisticSend(target.key, {
      optimisticLocalId: 'optimistic-l1',
      userMessageId: 'u1',
    });
    store.getState().hydrate(target.key, [], {
      queuedMessages: [
        {
          id: 'q1',
          text: 'Go',
          origin: 'portal',
          enqueuedAtMs: 0,
          supersedesUserMessageId: 'u1',
        },
      ],
    });
    store.getState().hydrate(target.key, [], { queuedMessages: [] });
    expect(store.getState().threads[target.key]?.messages).toEqual([]);
  });

  it('a host-owned thread keeps a send started while a re-read is in flight running', async () => {
    let status = 'streaming';
    let reads = 0;
    let land = (): void => undefined;
    const { store, thread, turn, lives } = hostOwnedOnStore(
      () => status,
      () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve(ok(transcript(message('m1', 'Hi'))))
          : new Promise<void>((resolve) => {
              land = resolve;
            }).then(() => ok(transcript(message('m1', 'Hi'))));
      },
    );
    thread.setLive(true);
    await flush();
    status = 'idle';
    lives[0]?.push(LIVE_IDLE);
    lives[0]?.end();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads).toBe(2);
    // The user sends while the re-read's transcript page is pending.
    store.getState().addOptimisticUserMessage(target.key, {
      text: 'Again',
      createdAtMs: Date.now(),
    });
    land();
    await flush();
    expect(turn()).toEqual({ status: 'streaming', turnActive: true });
  });

  it("a host-owned thread leaves the host's rows shown until its first read replaces them", async () => {
    let land = (): void => undefined;
    const read = new Promise<void>((resolve) => {
      land = resolve;
    });
    const { store, ids } = hostOwnedOnStore('idle', () =>
      read.then(() => ok(transcript(message('m1', 'Hi')))),
    );
    // The host's REST rows land while the first web core read is in flight.
    store.getState().hydrate(
      target.key,
      [
        {
          messageId: 'rest-1',
          chatId: target.key,
          role: 'assistant',
          status: 'complete',
          text: 'From REST',
          createdAtMs: 2,
        },
      ],
      { replaceMessages: true },
    );
    await flush();
    expect(ids()).toEqual(['rest-1']);
    land();
    await flush();
    expect(ids()).toEqual(['m1']);
  });

  it('a host-owned thread hands a turn only it raised back to the host when it closes', async () => {
    const { store, thread, turn } = hostOwnedOnStore('streaming');
    await flush();
    expect(turn()).toEqual({ status: 'streaming', turnActive: true });
    thread.close();
    // The host's terminal state lowers turnActive only, as REST does.
    store.getState().hydrate(target.key, [], { turnActive: false });
    expect(turn()).toEqual({ status: 'idle', turnActive: false });
  });

  it('loads older transcript pages from the position the newest page returned', async () => {
    const pages: Record<string, unknown>[] = [];
    const { thread, state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': (params) => {
        pages.push(params);
        return params.before === undefined
          ? ok({ ...transcript(message('m101', 'new')), before: 100 })
          : ok(transcript(message('m1', 'old')));
      },
    });
    await flush();
    await thread.loadOlder();
    expect(pages[1]?.before).toBe(100);
    expect(state.hydrate.mock.calls.at(-1)?.[1]).toEqual([
      { messageId: 'm1', createdAtMs: 1, presentationOrder: 0 },
      { messageId: 'm101', createdAtMs: 1, presentationOrder: 1 },
    ]);
    await thread.loadOlder();
    expect(pages).toHaveLength(2);
  });

  it('shows a prompt the web core marks cancelled as cancelled (CAN-6092)', async () => {
    const { state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () =>
        ok(
          transcript(
            {
              ...message('m-deleted', 'Delete me'),
              role: 'user',
              cancelled: true,
            },
            { ...message('m-sent', 'Keep me'), role: 'user' },
          ),
        ),
    });
    await flush();
    expect(state.hydrate.mock.calls.at(-1)?.[1]).toEqual([
      {
        messageId: 'm-deleted',
        createdAtMs: 1,
        presentationOrder: 0,
        status: 'cancelled',
      },
      { messageId: 'm-sent', createdAtMs: 1, presentationOrder: 1 },
    ]);
  });

  it("shows a turn's abnormal end on its timer as the renderer reads it (CAN-6116)", async () => {
    const timer = (id: string, outcome: string): Record<string, unknown> => ({
      id,
      role: 'system',
      blocks: [],
      timestamp: 1,
      outcome,
    });
    const { state, project } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () =>
        ok(
          transcript(
            timer('t1', 'failed'),
            timer('t2', 'cancelled'),
            timer('t3', 'completed'),
          ),
        ),
    });
    project.mockImplementation(
      ({ messages }: { readonly messages: readonly unknown[] }) =>
        messages.map((each) => ({
          messageId: (each as { id: string }).id,
          createdAtMs: 1,
          parts: [
            {
              kind: 'turn_timer',
              data: {
                completedAt: 2,
                outcome: (each as { outcome: string }).outcome,
              },
            },
          ],
        })),
    );
    await flush();
    const shown = state.hydrate.mock.calls.at(-1)?.[1] as PortalChatMessage[];
    expect(shown.map((each) => each.parts?.[0]?.data)).toEqual([
      { completedAt: 2, outcome: 'failed', endReason: 'failed' },
      { completedAt: 2, outcome: 'cancelled', endReason: 'cancelled' },
      { completedAt: 2, outcome: 'completed' },
    ]);
  });

  it("names the model Auto picked on its prompt's committed timer, only that one, and moves its revision when it lands later (CAN-6092)", async () => {
    const timer = (id: string): Record<string, unknown> => ({
      id,
      role: 'system',
      blocks: [],
      timestamp: 1,
    });
    const { thread, state, project } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () =>
        ok(transcript(timer('p1:turn-timer'), timer('p2:turn-timer'))),
    });
    project.mockImplementation(
      ({ messages }: { readonly messages: readonly unknown[] }) =>
        messages.map((each) => ({
          messageId: (each as { id: string }).id,
          createdAtMs: 1,
          parts: [{ kind: 'turn_timer', data: { completedAt: 2 } }],
        })),
    );
    await flush();
    thread.noteAutoRouting('p1', {
      autoRoutedModel: 'model-x',
      autoRoutedModelLabel: 'Model X',
    });
    await flush();
    const shown = state.hydrate.mock.calls.at(-1)?.[1] as PortalChatMessage[];
    expect(shown.map((each) => each.parts?.[0]?.data)).toEqual([
      {
        completedAt: 2,
        autoRoutedModel: 'model-x',
        autoRoutedModelLabel: 'Model X',
      },
      { completedAt: 2 },
    ]);
    // The store takes a row only when its revision moves.
    expect(shown[0]?.updatedAtMs).toBeGreaterThan(1);
  });

  it('names the Auto pick on a committed timer the chat store already holds, though its completion is ahead of the browser clock (CAN-6092)', async () => {
    const store = createChatStore({
      subscribe: (): (() => void) => () => undefined,
      command: () => Promise.resolve({}),
    } as never);
    // The server's clock runs ahead: the timer's completion outranks Date.now().
    const completedAt = Date.now() + 60_000;
    const thread = bindCloudChatThread({
      invoker: {
        request: (method) =>
          Promise.resolve(
            method === 'core.chat.snapshot.get'
              ? ok(snapshot('idle'))
              : ok(
                  transcript({
                    id: 'p1:turn-timer',
                    role: 'system',
                    blocks: [],
                    timestamp: 1,
                  }),
                ),
          ),
        openStream: () => Promise.resolve(controlledStream()),
      },
      target,
      chatStore: store,
      project: ({ messages }) =>
        messages.map((each) => ({
          messageId: (each as { id: string }).id,
          chatId: target.key,
          role: 'system',
          status: 'complete',
          text: '',
          createdAtMs: 1,
          parts: [{ kind: 'turn_timer', data: { startedAt: 1, completedAt } }],
        })),
      hostOwnsRuntime: true,
    });
    await flush();
    const timer = (): PortalChatMessage | undefined =>
      store
        .getState()
        .threads[
          target.key
        ]?.messages.find((each) => each.messageId === 'p1:turn-timer');
    expect(timer()).toBeDefined();
    thread.noteAutoRouting('p1', {
      autoRoutedModel: 'model-x',
      autoRoutedModelLabel: 'Model X',
    });
    await flush();
    expect(timer()?.parts?.[0]?.data).toEqual({
      startedAt: 1,
      completedAt,
      autoRoutedModel: 'model-x',
      autoRoutedModelLabel: 'Model X',
    });
    thread.close();
  });

  it("keeps a failed thread's error when an Auto pick lands after the failure (CAN-6092)", async () => {
    const { thread, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript(message('m1', 'Hi'))),
    });
    await flush();
    stream.push({
      kind: 'end',
      error: {
        kind: 'permission_denied',
        message: 'Access ended.',
        retry: { kind: 'never' },
      },
    });
    await flush();
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      status: 'error',
    });
    const publishes = state.hydrate.mock.calls.length;
    thread.noteAutoRouting('p1', { autoRoutedModel: 'model-x' });
    await flush();
    expect(state.hydrate.mock.calls.length).toBe(publishes);
  });

  it("shows a prompt's attachments the web core serves (CAN-6116)", async () => {
    const attachment = {
      attachmentId: 'att-1',
      filename: 'notes.txt',
      mediaType: 'text/plain',
      size: 12,
    };
    const { state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () =>
        ok(
          transcript(
            {
              ...message('m-file', 'See it'),
              role: 'user',
              attachments: [attachment],
            },
            { ...message('m-plain', 'Hi'), role: 'user' },
          ),
        ),
    });
    await flush();
    expect(state.hydrate.mock.calls.at(-1)?.[1]).toEqual([
      {
        messageId: 'm-file',
        createdAtMs: 1,
        presentationOrder: 0,
        attachments: [attachment],
      },
      { messageId: 'm-plain', createdAtMs: 1, presentationOrder: 1 },
    ]);
  });

  it('answers a question pending at open through core.chat.question.respond, keyed by question id', async () => {
    const { thread, calls } = harness({
      'core.chat.snapshot.get': () =>
        ok({
          ...snapshot('awaiting_input'),
          pendingQuestions: [
            {
              requestId: 'q-1',
              chatId: 'chat-1',
              questions: [
                { id: 'which', question: 'Which?', options: ['A', 'B'] },
              ],
            },
          ],
        }),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.question.respond': () => ok({}),
    });
    await flush();
    expect(thread.getQuestions()).toEqual([
      {
        requestId: 'q-1',
        questions: [{ id: 'which', question: 'Which?', options: ['A', 'B'] }],
        answered: false,
      },
    ]);
    await thread.answerQuestion('q-1', [
      { question: 'Which?', selectedOptions: ['B'] },
    ]);
    expect(
      calls.find((c) => c.method === 'core.chat.question.respond')?.params,
    ).toEqual({
      chatId: 'chat-1',
      questionId: 'q-1',
      answers: { which: { selectedOptions: ['B'] } },
    });
    expect(thread.getQuestions()).toEqual([]);
  });

  it('says in the thread when a send is rejected, after rolling back its optimistic row', async () => {
    const { thread, state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) =>
        ok({
          commandId: params.commandId,
          revision: 5,
          outcome: 'rejected',
          reason: 'Out of credits.',
        }),
    });
    await flush();
    await expect(
      thread.send({ text: 'Hi', optimisticLocalId: 'local-1' }),
    ).rejects.toThrow('Out of credits.');
    expect(state.rollbackOptimisticSend).toHaveBeenCalledWith(
      'web-core:chat-1',
      { localId: 'local-1' },
    );
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      turnActive: false,
      error: "Your message wasn't sent: Out of credits.",
    });
  });

  it('stops a turn waiting on a question, by the id the web core reports', async () => {
    const waiting = {
      ...snapshot('awaiting_input'),
      runtimeByChatId: {
        'chat-1': {
          status: 'awaiting_input',
          queuedMessageIds: [],
          activeTurnId: 'turn-q',
        },
      },
    };
    const { thread, calls, state } = harness({
      'core.chat.snapshot.get': () => ok(waiting),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.turn.cancel': () => ok({}),
    });
    await flush();
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      turnActive: true,
    });
    await thread.stop();
    expect(
      calls.find((c) => c.method === 'core.chat.turn.cancel')?.params,
    ).toEqual({ chatId: 'chat-1', turnId: 'turn-q', reason: 'user' });
  });

  it('a rejected follow-up keeps the running turn active and only adds the notice', async () => {
    const { thread, state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('streaming')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) =>
        ok({
          commandId: params.commandId,
          revision: 5,
          outcome: 'rejected',
          reason: 'Queue is full.',
        }),
    });
    await flush();
    await expect(thread.send({ text: 'Also this' })).rejects.toThrow(
      'Queue is full.',
    );
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      status: 'streaming',
      turnActive: true,
      error: "Your message wasn't sent: Queue is full.",
    });
  });

  it('keeps older pages it loaded when a refresh re-reads the newest page', async () => {
    let newestCalls = 0;
    const { thread, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': (params) => {
        if (params.before !== undefined)
          return ok(transcript(message('m1', 'old')));
        newestCalls += 1;
        return ok({
          ...transcript(message('m101', 'new'), message('m102', 'newer')),
          before: 100,
        });
      },
    });
    await flush();
    await thread.loadOlder();
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'transcript.updated',
            chatId: 'chat-1',
            transcript: {},
            reset: false,
          },
        ],
      },
    });
    await flush();
    expect(newestCalls).toBe(2);
    const latest = (state.hydrate.mock.calls.at(-1)?.[1] ?? []) as {
      messageId: string;
    }[];
    expect(latest.map((each) => each.messageId)).toEqual([
      'm1',
      'm101',
      'm102',
    ]);
  });

  it('shows a session parked awaiting input with no running turn as idle, and refuses stop', async () => {
    const { thread, state, calls } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('awaiting_input')),
      'core.chat.transcript.page': () => ok(transcript()),
    });
    await flush();
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      status: 'idle',
      turnActive: false,
    });
    await expect(thread.stop()).rejects.toBeInstanceOf(
      CloudChatStopUnavailableError,
    );
    expect(calls.some((c) => c.method === 'core.chat.turn.cancel')).toBe(false);
  });

  it('drops older pages it kept when the transcript is reset', async () => {
    const { thread, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': (params) =>
        params.before !== undefined
          ? ok(transcript(message('m1', 'old')))
          : ok({ ...transcript(message('m101', 'new')), before: 100 }),
    });
    await flush();
    await thread.loadOlder();
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'transcript.updated',
            chatId: 'chat-1',
            transcript: {},
            reset: true,
          },
        ],
      },
    });
    await flush();
    const latest = (state.hydrate.mock.calls.at(-1)?.[1] ?? []) as {
      messageId: string;
    }[];
    expect(latest.map((each) => each.messageId)).toEqual(['m101']);
  });

  it('drops an older page that was requested before a transcript reset, even when it lands during the reset read', async () => {
    let answerOlder: (reply: CanopyCoreRelayLikeReply) => void = () => {};
    let answerRefresh: (reply: CanopyCoreRelayLikeReply) => void = () => {};
    let reads = 0;
    const newest = ok({ ...transcript(message('m101', 'new')), before: 100 });
    const { thread, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': (params) => {
        if (params.before !== undefined)
          return new Promise<CanopyCoreRelayLikeReply>((resolve) => {
            answerOlder = resolve;
          });
        reads += 1;
        if (reads === 1) return newest;
        return new Promise<CanopyCoreRelayLikeReply>((resolve) => {
          answerRefresh = resolve;
        });
      },
    });
    await flush();
    const older = thread.loadOlder();
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'transcript.updated',
            chatId: 'chat-1',
            transcript: {},
            reset: true,
          },
        ],
      },
    });
    await flush();
    answerOlder(ok(transcript(message('m1', 'obsolete'))));
    await older;
    answerRefresh(newest);
    await flush();
    const latest = (state.hydrate.mock.calls.at(-1)?.[1] ?? []) as {
      messageId: string;
    }[];
    expect(latest.map((each) => each.messageId)).toEqual(['m101']);
  });

  describe('live reply (CAN-5984)', () => {
    const prompt = (id: string, text: string): Record<string, unknown> => ({
      id,
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp: 1,
    });
    const liveTurn = (
      text: string,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      kind: 'item',
      cursor: { daemonEpoch: 'web-core-chat-live-1', sequence: 1 },
      item: {
        kind: 'turn',
        chatId: 'chat-1',
        turnId: 'turn-1',
        promptMessageId: 'p1',
        text,
        reasoning: '',
        state: 'streaming',
        ...overrides,
      },
    });
    const shown = (state: Harness['state']): unknown[] =>
      state.hydrate.mock.calls.at(-1)?.[1] ?? [];
    const LIVE_ID = 'web-core:chat-1:live:turn-1';

    it('live text and reasoning show in the open thread', async () => {
      const { thread, calls, state, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      expect(
        calls.find((c) => c.method === 'core.chat.live.events')?.params,
      ).toEqual({
        scope: { workspaceId: 'ws-1', worktreeId: 'chat-1', chatId: 'chat-1' },
      });
      lives[0]?.push(liveTurn('Hel', { reasoning: 'Thinking' }));
      await flush();
      expect(shown(state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
        expect.objectContaining({
          messageId: LIVE_ID,
          chatId: 'web-core:chat-1',
          role: 'assistant',
          status: 'streaming',
          text: 'Hel',
          parts: [{ kind: 'thinking', data: { text: 'Thinking' } }],
          presentationOrder: 1,
        }),
      ]);
      lives[0]?.push({
        kind: 'item',
        cursor: { daemonEpoch: 'web-core-chat-live-1', sequence: 2 },
        item: {
          kind: 'append',
          chatId: 'chat-1',
          turnId: 'turn-1',
          textOffset: 3,
          text: 'lo',
          reasoningOffset: 8,
          reasoning: '...',
        },
      });
      await flush();
      expect(shown(state)[1]).toMatchObject({
        text: 'Hello',
        parts: [{ kind: 'thinking', data: { text: 'Thinking...' } }],
      });
    });

    describe('revision 2 (CAN-6116)', () => {
      const STARTED_AT = '2026-11-07T17:59:30.000Z';
      const liveTool = (
        tool: Record<string, unknown>,
      ): Record<string, unknown> => ({
        kind: 'item',
        cursor: { daemonEpoch: 'web-core-chat-live-1', sequence: 2 },
        item: { kind: 'tool', chatId: 'chat-1', turnId: 'turn-1', ...tool },
      });
      const timerRow = {
        id: 'p1:turn-timer',
        role: 'system',
        blocks: [
          {
            type: 'turn_timer',
            turnId: 'turn-1',
            userMessageId: 'p1',
            startedAt: Date.parse(STARTED_AT),
            pausedAt: null,
            resumedAt: null,
            accumulatedPausedDurationMs: 0,
            completedAt: null,
          },
        ],
        timestamp: Date.parse(STARTED_AT),
      };

      it("a running turn shows REST's steps, each tool card after its text, and its running timer", async () => {
        const { thread, state, lives, project } = harness({
          'core.chat.snapshot.get': () => ok(snapshot('streaming')),
          'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
        });
        thread.setLive(true);
        await flush();
        lives[0]?.push(liveTurn('Looking. Next.', { startedAt: STARTED_AT }));
        lives[0]?.push(
          liveTool({
            toolUseId: 'call-1',
            toolName: 'Read',
            input: 'a.ts',
            textOffset: 8,
            result: { output: 'contents', isError: false },
          }),
        );
        lives[0]?.push(
          liveTool({
            toolUseId: 'call-2',
            toolName: 'Bash',
            input: 'ls',
            textOffset: 14,
          }),
        );
        await flush();
        const rows = project.mock.calls.flatMap(([{ messages }]) => messages);
        // A tool step is projected as a committed reply's tool blocks are.
        expect(rows).toContainEqual({
          id: `${LIVE_ID}:1`,
          role: 'assistant',
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'call-1',
              toolName: 'Read',
              input: 'a.ts',
            },
            {
              type: 'tool_result',
              toolUseId: 'call-1',
              toolName: 'Read',
              output: 'contents',
              isError: false,
            },
          ],
          timestamp: expect.any(Number) as unknown,
        });
        // As REST's live view: a message per step, text and cards in turn,
        // the earlier steps done, and the running timer after them.
        expect(shown(state)).toEqual([
          { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
          expect.objectContaining({
            messageId: LIVE_ID,
            text: 'Looking.',
            status: 'complete',
            presentationOrder: 1,
          }),
          expect.objectContaining({
            messageId: `${LIVE_ID}:1`,
            text: '',
            status: 'complete',
            presentationOrder: 2,
          }),
          expect.objectContaining({
            messageId: `${LIVE_ID}:2`,
            text: ' Next.',
            status: 'complete',
            presentationOrder: 3,
          }),
          expect.objectContaining({
            messageId: `${LIVE_ID}:3`,
            status: 'streaming',
            presentationOrder: 4,
          }),
          {
            messageId: 'p1:turn-timer',
            chatId: 'web-core:chat-1',
            role: 'system',
            status: 'streaming',
            text: '',
            parts: [
              {
                kind: 'turn_timer',
                data: {
                  startedAt: Date.parse(STARTED_AT),
                  pausedAt: null,
                  resumedAt: null,
                  accumulatedPausedDurationMs: 0,
                  completedAt: null,
                },
              },
            ],
            createdAtMs: Date.parse(STARTED_AT),
            updatedAtMs: expect.any(Number) as unknown,
            presentationOrder: 5,
          },
        ]);
        // The timer is never left to a projection that drops running ones.
        expect(rows).not.toContainEqual(
          expect.objectContaining({ id: 'p1:turn-timer' }),
        );
      });

      it("a held reply's live timer never brings back a turn the runtime ended", async () => {
        let status = 'streaming';
        const { thread, turn, lives, push, runtime, ids } = hostOwnedOnStore(
          () => status,
        );
        thread.setLive(true);
        await flush();
        const reply = (state: string, text: string): Record<string, unknown> =>
          liveTurn(text, {
            promptMessageId: 'm1',
            startedAt: STARTED_AT,
            state,
          });
        lives[0]?.push(reply('streaming', 'Hel'));
        await flush();
        expect(ids()).toContain('m1:turn-timer');
        status = 'idle';
        push(runtime('idle'));
        await flush();
        // The live stream's finish comes after the runtime said idle.
        lives[0]?.push(reply('finished', 'Hello'));
        await flush();
        expect(turn()).toMatchObject({ turnActive: false });
        expect(ids()).not.toContain('m1:turn-timer');
      });

      it("a running turn's timer names the model Auto picked for its prompt, as REST's does (CAN-6092)", async () => {
        const { thread, state, lives } = harness({
          'core.chat.snapshot.get': () => ok(snapshot('streaming')),
          'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
        });
        thread.setLive(true);
        await flush();
        thread.noteAutoRouting('p1', {
          autoRoutedModel: 'model-x',
          autoRoutedModelLabel: 'Model X',
        });
        lives[0]?.push(liveTurn('Hello', { startedAt: STARTED_AT }));
        await flush();
        const timer = (shown(state) as PortalChatMessage[]).find(
          (each) => each.messageId === 'p1:turn-timer',
        );
        expect(timer?.parts).toEqual([
          {
            kind: 'turn_timer',
            data: {
              startedAt: Date.parse(STARTED_AT),
              pausedAt: null,
              resumedAt: null,
              accumulatedPausedDurationMs: 0,
              completedAt: null,
              autoRoutedModel: 'model-x',
              autoRoutedModelLabel: 'Model X',
            },
          },
        ]);
      });

      it('a timer the transcript already shows is not shown twice', async () => {
        const { thread, state, lives } = harness({
          'core.chat.snapshot.get': () => ok(snapshot('streaming')),
          'core.chat.transcript.page': () =>
            ok(
              transcript(prompt('p1', 'Hi'), {
                ...timerRow,
                blocks: [{ ...timerRow.blocks[0], completedAt: 1 }],
              }),
            ),
        });
        thread.setLive(true);
        await flush();
        lives[0]?.push(liveTurn('Hello', { startedAt: STARTED_AT }));
        await flush();
        const ids = (shown(state) as { messageId: string }[]).map(
          (each) => each.messageId,
        );
        expect(ids).toEqual(['p1', 'p1:turn-timer', LIVE_ID]);
      });
    });

    it('the committed reply replaces the live one in one publish, with no duplicate', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Hello'));
      await flush();
      const firstShown = state.hydrate.mock.calls.length;
      // Core finished; the transcript has not caught up yet: keep showing it.
      lives[0]?.push(
        liveTurn('Hello there', { state: 'finished', messageId: 'a1' }),
      );
      await flush();
      expect(shown(state)[1]).toMatchObject({
        messageId: LIVE_ID,
        status: 'complete',
        text: 'Hello there',
      });
      stream.push({
        kind: 'item',
        cursor: { daemonEpoch: 'e1', sequence: 5 },
        item: {
          schemaVersion: 1,
          eventId: 'ev-5',
          occurredAt: '2026-11-07T15:00:00.000Z',
          projectId: 'ws-1',
          worktreeId: 'chat-1',
          baseRevision: 4,
          revision: 5,
          changes: [
            {
              type: 'message.upserted',
              chatId: 'chat-1',
              message: message('a1', 'Hello there'),
            },
            {
              type: 'runtime.patched',
              chatId: 'chat-1',
              runtime: { status: 'idle', queuedMessageIds: [] },
            },
          ],
        },
      });
      await flush();
      const last = state.hydrate.mock.calls.at(-1);
      expect(last?.[1]).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
        { messageId: 'a1', createdAtMs: 1, presentationOrder: 1 },
      ]);
      // The store keeps rows a merge omits, so dropping the live row replaces.
      expect(last?.[2]).toMatchObject({ replaceMessages: true });
      // Every publish since the reply appeared shows it once: live or committed.
      for (const [, messages] of state.hydrate.mock.calls.slice(
        firstShown - 1,
      )) {
        const replies = messages.filter(
          (each) =>
            (each as { messageId: string }).messageId === LIVE_ID ||
            (each as { messageId: string }).messageId === 'a1',
        );
        expect(replies).toHaveLength(1);
      }
    });

    it('a reopened thread shows the reply in progress, or the committed reply once the turn ended', async () => {
      const { thread, state, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Hello'));
      // An append cut from other lengths is a gap: reopen for the whole reply.
      lives[0]?.push({
        kind: 'item',
        cursor: { daemonEpoch: 'web-core-chat-live-1', sequence: 2 },
        item: {
          kind: 'append',
          chatId: 'chat-1',
          turnId: 'turn-1',
          textOffset: 9,
          text: 'x',
          reasoningOffset: 0,
          reasoning: '',
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(lives[0]?.closed).toBe(true);
      expect(shown(state)[1]).toMatchObject({ text: 'Hello' });
      // The reopened stream rebuilds the reply in progress.
      lives[1]?.push(liveTurn('Hello world'));
      await flush();
      expect(shown(state)[1]).toMatchObject({
        messageId: LIVE_ID,
        text: 'Hello world',
      });

      // Opened after the turn ended: the committed reply only, no live stream.
      const ended = harness({
        'core.chat.snapshot.get': () => ok(snapshot('idle')),
        'core.chat.transcript.page': () =>
          ok(transcript(prompt('p1', 'Hi'), message('a1', 'Hello world'))),
      });
      ended.thread.setLive(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ended.lives).toHaveLength(0);
      expect(shown(ended.state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
        { messageId: 'a1', createdAtMs: 1, presentationOrder: 1 },
      ]);
    });

    const feedBatch = (
      revision: number,
      changes: Record<string, unknown>[],
    ): Record<string, unknown> => ({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: revision },
      item: {
        schemaVersion: 1,
        eventId: `ev-${revision}`,
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: revision - 1,
        revision,
        changes,
      },
    });
    const idle = {
      type: 'runtime.patched',
      chatId: 'chat-1',
      runtime: { status: 'idle', queuedMessageIds: [] },
    };

    it('a turn ending a batch before its committed message holds the reply until the message lands', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Done.', { state: 'finished', messageId: 'a1' }));
      await flush();
      const firstShown = state.hydrate.mock.calls.length;
      stream.push(feedBatch(5, [idle]));
      await flush();
      // The turn stopped, the reply has not committed yet: keep showing it.
      expect(shown(state).at(-1)).toMatchObject({ messageId: LIVE_ID });
      expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
        turnActive: false,
      });
      stream.push(
        feedBatch(6, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('a1', 'Done.'),
          },
        ]),
      );
      await flush();
      expect(
        shown(state).map((each) => (each as { messageId: string }).messageId),
      ).toEqual(['p1', 'a1']);
      for (const [, messages] of state.hydrate.mock.calls.slice(
        firstShown - 1,
      )) {
        const replies = messages.filter((each) =>
          [LIVE_ID, 'a1'].includes((each as { messageId: string }).messageId),
        );
        expect(replies).toHaveLength(1);
      }
    });

    it('a turn that ends with no committed reply drops its live reply after a short hold', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Half an'));
      await flush();
      expect(shown(state)).toHaveLength(2);
      // The turn failed: the web core reports it idle, with no reply.
      stream.push(feedBatch(5, [idle]));
      await flush();
      expect(shown(state)).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(shown(state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
      ]);
      expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
        replaceMessages: true,
        turnActive: false,
      });
    });

    it('a whole transcript read after the turn stopped, without the reply, drops it at once', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Half an'));
      await flush();
      stream.push(feedBatch(5, [idle]));
      await flush();
      expect(shown(state)).toHaveLength(2);
      stream.push(
        feedBatch(6, [
          {
            type: 'transcript.updated',
            chatId: 'chat-1',
            transcript: {},
            reset: true,
          },
        ]),
      );
      await flush();
      expect(shown(state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
      ]);
    });

    it('another assistant message mid-turn leaves the live reply streaming; its own commit drops it', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Part one'));
      await flush();
      const batch = (
        revision: number,
        changes: Record<string, unknown>[],
      ): Record<string, unknown> => ({
        kind: 'item',
        cursor: { daemonEpoch: 'e1', sequence: revision },
        item: {
          schemaVersion: 1,
          eventId: `ev-${revision}`,
          occurredAt: '2026-11-07T15:00:00.000Z',
          projectId: 'ws-1',
          worktreeId: 'chat-1',
          baseRevision: revision - 1,
          revision,
          changes,
        },
      });
      // An assistant message after the prompt that is not this reply.
      stream.push(
        batch(5, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('other-1', 'Not the reply'),
          },
        ]),
      );
      await flush();
      expect(shown(state).at(-1)).toMatchObject({
        messageId: LIVE_ID,
        text: 'Part one',
      });
      lives[0]?.push({
        kind: 'item',
        cursor: { daemonEpoch: 'web-core-chat-live-1', sequence: 2 },
        item: {
          kind: 'append',
          chatId: 'chat-1',
          turnId: 'turn-1',
          textOffset: 8,
          text: ', part two',
          reasoningOffset: 0,
          reasoning: '',
        },
      });
      await flush();
      expect(shown(state).at(-1)).toMatchObject({
        text: 'Part one, part two',
      });
      lives[0]?.push(
        liveTurn('Part one, part two', { state: 'finished', messageId: 'a1' }),
      );
      stream.push(
        batch(6, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('a1', 'Part one, part two'),
          },
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: { status: 'idle', queuedMessageIds: [] },
          },
        ]),
      );
      await flush();
      expect(
        shown(state).map((each) => (each as { messageId: string }).messageId),
      ).toEqual(['p1', 'other-1', 'a1']);
    });

    it('only the chat on screen follows its live reply', async () => {
      const { thread, state, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      await flush();
      // Retained but hidden: no live stream.
      expect(lives).toHaveLength(0);
      thread.setLive(true);
      await flush();
      expect(lives).toHaveLength(1);
      lives[0]?.push(liveTurn('Hello'));
      await flush();
      expect(shown(state)).toHaveLength(2);
      // Hidden again: the stream ends and the reply waits for the transcript.
      thread.setLive(false);
      await flush();
      expect(lives[0]?.closed).toBe(true);
      expect(shown(state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
      ]);
      // Shown again: a fresh attach rebuilds the reply in progress.
      thread.setLive(true);
      await flush();
      expect(lives).toHaveLength(2);
      lives[1]?.push(liveTurn('Hello again'));
      await flush();
      expect(shown(state)[1]).toMatchObject({ text: 'Hello again' });
    });

    it('a committed reply and the turn end landing before the live finish show the reply once', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Done'));
      await flush();
      stream.push(
        feedBatch(5, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('a1', 'Done.'),
          },
          idle,
        ]),
      );
      await flush();
      expect(
        shown(state).map((each) => (each as { messageId: string }).messageId),
      ).toEqual(['p1', 'a1']);
    });

    it('a live stream that finishes opening after the chat is hidden is closed and not followed', async () => {
      const { thread, state, lives, deferLive } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      await flush();
      const release = deferLive();
      thread.setLive(true);
      await flush();
      thread.setLive(false);
      release();
      await flush();
      expect(lives).toHaveLength(1);
      expect(lives[0]?.closed).toBe(true);
      const publishes = state.hydrate.mock.calls.length;
      lives[0]?.push(liveTurn('Should not show'));
      await flush();
      expect(state.hydrate.mock.calls.length).toBe(publishes);
    });

    it("a queued next turn starting does not keep the previous turn's live reply beside its commit", async () => {
      const running = (activeTurnId: string): Record<string, unknown> => ({
        ...snapshot('streaming'),
        runtimeByChatId: {
          'chat-1': { status: 'streaming', queuedMessageIds: [], activeTurnId },
        },
      });
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(running('turn-1')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Done'));
      await flush();
      // Turn 1 committed and turn 2 runs before turn 1's live finish.
      stream.push(
        feedBatch(5, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('a1', 'Done.'),
          },
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'streaming',
              queuedMessageIds: [],
              activeTurnId: 'turn-2',
            },
          },
        ]),
      );
      await flush();
      expect(
        shown(state).map((each) => (each as { messageId: string }).messageId),
      ).toEqual(['p1', 'a1']);
    });

    it('dropping a live reply keeps a send still in flight', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Done.', { state: 'finished', messageId: 'a1' }));
      await flush();
      const inFlight = {
        messageId: 'optimistic-next',
        chatId: 'web-core:chat-1',
        role: 'user',
        status: 'complete',
        text: 'And another thing',
        createdAtMs: Date.now(),
      };
      state.threads['web-core:chat-1'] = {
        messages: [...shown(state), inFlight] as Record<string, unknown>[],
      };
      stream.push(
        feedBatch(5, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('a1', 'Done.'),
          },
        ]),
      );
      await flush();
      const last = state.hydrate.mock.calls.at(-1);
      expect(last?.[2]).toMatchObject({ replaceMessages: true });
      expect(
        last?.[1].map((each) => (each as { messageId: string }).messageId),
      ).toEqual(['p1', 'a1', 'optimistic-next']);
    });

    it('hiding a failed chat keeps its error', async () => {
      const { thread, state } = harness({
        'core.chat.snapshot.get': () => ({
          ok: false,
          error: {
            kind: 'not_found',
            message: 'The chat was not found.',
            retry: { kind: 'never' },
          },
        }),
        'core.chat.transcript.page': () => ok(transcript()),
      });
      await flush();
      expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
        status: 'error',
      });
      const publishes = state.hydrate.mock.calls.length;
      thread.setLive(true);
      thread.setLive(false);
      await flush();
      expect(state.hydrate.mock.calls.length).toBe(publishes);
    });

    it('a refused live stream leaves the transcript working and is not retried', async () => {
      const { thread, calls, state } = harness(
        {
          'core.chat.snapshot.get': () => ok(snapshot('streaming')),
          'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
        },
        { liveRefused: true },
      );
      thread.setLive(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        calls.filter((c) => c.method === 'core.chat.live.events'),
      ).toHaveLength(1);
      expect(shown(state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
      ]);
      expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
        status: 'streaming',
        turnActive: true,
      });
    });
  });
});

describe('committed reply steps (CAN-6116)', () => {
  // As REST's transcript: a finished reply is a message per step, its text
  // and its tool calls in turn, so the turn folds as REST's does.
  it("a finished reply shows REST's steps, each tool card after its text", async () => {
    const reply = {
      id: 'a1',
      role: 'assistant',
      blocks: [
        { type: 'thinking', text: 'Plan.' },
        { type: 'text', text: 'Starting.' },
        { type: 'tool_use', toolUseId: 'c1', toolName: 'Bash', input: 'echo' },
        {
          type: 'tool_result',
          toolUseId: 'c1',
          toolName: 'Bash',
          output: 'one',
          isError: false,
        },
        { type: 'text', text: 'Middle.' },
        { type: 'tool_use', toolUseId: 'c2', toolName: 'Agent', input: 'go' },
        { type: 'text', text: 'All done.' },
      ],
      timestamp: 1,
    };
    const { project } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript(reply)),
    });
    await flush();
    const rows = (project.mock.calls.at(-1)?.[0].messages ?? []) as {
      id: string;
      blocks: { type: string }[];
    }[];
    expect(
      rows.map(({ id, blocks }) => [id, blocks.map((b) => b.type)]),
    ).toEqual([
      ['a1', ['thinking', 'text']],
      ['a1:step-1', ['tool_use', 'tool_result']],
      ['a1:step-2', ['text']],
      ['a1:step-3', ['tool_use']],
      ['a1:step-4', ['text']],
    ]);
  });

  it('a reply without tools stays one message', async () => {
    const { project } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript(message('a1', 'Hi'))),
    });
    await flush();
    const rows = (project.mock.calls.at(-1)?.[0].messages ?? []) as {
      id: string;
    }[];
    expect(rows.map(({ id }) => id)).toEqual(['a1']);
  });

  it('a later step takes its row update in the same millisecond as its card change', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(5_000);
    const store = createChatStore({
      subscribe: (): (() => void) => () => undefined,
      command: () => Promise.resolve({}),
    } as never);
    const events = controlledStream();
    const row = (result?: string): Record<string, unknown> => ({
      id: 'a1',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        { type: 'text', text: 'Start.' },
        { type: 'tool_use', toolUseId: 'c1', toolName: 'Agent', input: 'go' },
        ...(result === undefined
          ? []
          : [
              {
                type: 'tool_result',
                toolUseId: 'c1',
                toolName: 'Agent',
                output: result,
                isError: false,
              },
            ]),
      ],
    });
    let card = 'running';
    const thread = bindCloudChatThread({
      invoker: {
        request: (method) =>
          Promise.resolve(
            method === 'core.chat.snapshot.get'
              ? ok(snapshot('idle'))
              : ok(transcript(row())),
          ),
        openStream: (method) =>
          Promise.resolve(
            method === 'core.chat.live.events' ? controlledStream() : events,
          ),
      },
      target,
      chatStore: store,
      reopenDelayMs: 5,
      liveReopenDelayMs: 5,
      // The tool step's card changes with the test's `card`, as with a task.
      project: ({ messages }) =>
        messages.map((each) => {
          const step = each as {
            id: string;
            blocks: { type: string; output?: string }[];
          };
          const tool = step.blocks.some((block) => block.type === 'tool_use');
          return {
            messageId: step.id,
            chatId: target.key,
            role: 'assistant' as const,
            status: 'complete' as const,
            text: step.blocks.map((block) => block.output ?? '').join(''),
            createdAtMs: 1,
            ...(tool ? { parts: [{ kind: 'agent', card }] as never } : {}),
          };
        }),
    });
    const push = (revision: number, change: Record<string, unknown>): void =>
      events.push({
        kind: 'item',
        cursor: { daemonEpoch: 'e1', sequence: revision },
        item: {
          schemaVersion: 1,
          eventId: `ev-${revision}`,
          occurredAt: '2026-11-11T12:00:00.000Z',
          projectId: 'ws-1',
          worktreeId: 'chat-1',
          baseRevision: revision - 1,
          revision,
          changes: [change],
        },
      });
    const step = (): string | undefined =>
      store
        .getState()
        .threads[
          target.key
        ]?.messages.find((each) => each.messageId === 'a1:step-1')?.text;
    try {
      await flush();
      expect(step()).toBe('');
      card = 'done';
      push(5, {
        type: 'runtime.patched',
        chatId: 'chat-1',
        runtime: { status: 'idle', queuedMessageIds: [] },
      });
      await flush();
      push(6, {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: row('Found it.'),
      });
      await flush();
      expect(step()).toBe('Found it.');
    } finally {
      thread.close();
      now.mockRestore();
    }
  });

  it("a finished reply's served artifacts sit where REST puts them: a deliverable on its last step", async () => {
    const document = { kind: 'attachment', data: { text: 'notes.md' } };
    const deliverable = {
      kind: 'attachment',
      data: { text: 'deliverable-8826.txt', deliverable: { filename: 'x' } },
    };
    const reply = {
      id: 'a1',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Starting.' },
        { type: 'tool_use', toolUseId: 'c1', toolName: 'Bash', input: 'echo' },
        { type: 'text', text: 'All done.' },
      ],
      parts: [document, deliverable],
      timestamp: 1,
    };
    const { state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript(reply)),
    });
    await flush();
    const shown = state.hydrate.mock.calls.at(-1)?.[1] as {
      messageId: string;
      parts?: unknown[];
    }[];
    expect(shown.map(({ messageId, parts }) => [messageId, parts])).toEqual([
      ['a1', [document]],
      ['a1:step-1', undefined],
      ['a1:step-2', [deliverable]],
    ]);
  });
});
