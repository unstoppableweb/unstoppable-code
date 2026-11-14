import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CANOPY_ERROR_KINDS,
  type CanopyErrorPayload,
  type CoreRuntimeInitializeResult,
} from '@canopy/protocol/canopy-core';

import { CanopyClientError, createCanopyClient } from '../index';
import type { CanopyClient, CanopyClientStreamFrame } from '../types';
import {
  CANONICAL_DEFINITIONS,
  CanonicalCoreError,
  canonicalInitializeResult,
  serveCanonicalCore,
  subscriptionIdFor,
  type CanonicalCoreServer,
  type CanonicalHandlers,
} from './fixtures/canonical-core';

type CanonicalClient = CanopyClient<
  typeof CANONICAL_DEFINITIONS.queries,
  typeof CANONICAL_DEFINITIONS.instructions,
  typeof CANONICAL_DEFINITIONS.streams
>;

export interface CanopyClientConformancePair {
  readonly client: CanopyFramedConnection;
  readonly server: CanopyFramedConnection;
  close(): Promise<void>;
}

export interface CanopyClientConformanceBinding {
  /**
   * False when the client cannot observe the server ending its connection
   * until its next request, so no close or close reason reaches it (HTTP POST
   * plus SSE, ADR 13a): cases that close the server end become `it.todo`.
   */
  readonly serverClose?: boolean;
  /** Exact case names this binding cannot pass yet, each with its owning ticket. */
  readonly pending?: Readonly<Record<string, string>>;
}

const NO_SERVER_CLOSE =
  'no server close reaches the client on this binding (ADR 13a)';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded, so a missed settle fails the assertion instead of the Jest timeout. */
function within<T>(promise: Promise<T>): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(resolve, 1_000, 'timeout');
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const HANDLERS: CanonicalHandlers = {
  'core.test.echo': async (params) => {
    if (typeof params.delayMs === 'number') await sleep(params.delayMs);
    const text = typeof params.text === 'string' ? params.text : '';
    const kind = CANOPY_ERROR_KINDS.find((candidate) => candidate === text);
    if (kind)
      throw new CanonicalCoreError({
        kind,
        message: `${text} from core`,
        retry: { kind: 'never' },
      });
    if (text === 'declared')
      throw new CanonicalCoreError({
        kind: 'not_found',
        message: 'declared',
        code: 'core.test.notFound',
        retry: { kind: 'never' },
      });
    if (text === 'undeclared')
      throw new CanonicalCoreError({
        kind: 'not_found',
        message: 'undeclared',
        code: 'core.other.missing',
        retry: { kind: 'never' },
      });
    return text === 'bad-result'
      ? { text, length: 'one' }
      : { text, length: text.length };
  },
  'core.test.record': (params) => ({
    recorded: Number(params.value),
    label: typeof params.label === 'string' ? params.label : 'none',
  }),
};

export async function rejection(
  promise: Promise<unknown>,
): Promise<CanopyErrorPayload> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof CanopyClientError))
    throw new Error(`Expected a CanopyClientError, got ${String(error)}`);
  return error.payload;
}

/** Collects frames to the end; a stream that never ends fails here. */
export async function drain<T>(frames: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  const done = await within(
    (async (): Promise<void> => {
      for await (const frame of frames) collected.push(frame);
    })(),
  );
  if (done === 'timeout') throw new Error('The stream did not end.');
  return collected;
}

type TickFrame = CanopyClientStreamFrame<{ tick: number }, unknown>;

/** The next frame, bounded; undefined once the stream is done. */
async function pull(
  frames: AsyncIterator<TickFrame>,
): Promise<TickFrame | undefined> {
  const next = await within(frames.next());
  if (next === 'timeout') throw new Error('No frame arrived.');
  return next.done ? undefined : next.value;
}

const item = (
  sequence: number,
  tick: number,
  epoch = 'epoch-1',
): TickFrame => ({
  kind: 'item',
  cursor: { daemonEpoch: epoch, sequence },
  item: { tick },
});
const completed = (sequence: number, epoch = 'epoch-1'): TickFrame => ({
  kind: 'end',
  cursor: { daemonEpoch: epoch, sequence },
  outcome: 'completed',
  error: null,
});
const ticksOf = (frames: readonly TickFrame[]): (number | string)[] =>
  frames.map((frame) =>
    frame.kind === 'item' ? frame.item.tick : frame.outcome,
  );

/** Records pushed frames; `ended` settles on the end frame. */
function recorder(): {
  frames: TickFrame[];
  ended: Promise<void>;
  listener: (frame: TickFrame) => void;
} {
  const frames: TickFrame[] = [];
  let resolve = (): void => {};
  const ended = new Promise<void>((settle) => (resolve = settle));
  const listener = (frame: TickFrame): void => {
    frames.push(frame);
    if (frame.kind === 'end') resolve();
  };
  return { frames, ended, listener };
}

/**
 * Request-facade behavior every binding must preserve, driven through
 * `serveCanonicalCore`. Pair-specific wire cases stay with each binding.
 */
export function describeCanopyClientConformance(
  name: string,
  createPair: () => Promise<CanopyClientConformancePair>,
  binding: CanopyClientConformanceBinding = {},
): void {
  describe(`${name}: canonical client conformance`, () => {
    const pending = new Map(Object.entries(binding.pending ?? {}));
    /** Registers a case, or its `it.todo` when this binding cannot run it. */
    const conformance = (
      title: string,
      closesServer: boolean,
      body: () => Promise<void>,
    ): void => {
      const owner = pending.get(title);
      pending.delete(title);
      if (owner) it.todo(`${title} (pending ${owner})`);
      else if (closesServer && binding.serverClose === false)
        it.todo(`${title} (${NO_SERVER_CLOSE})`);
      else it(title, body);
    };
    const pairs: CanopyClientConformancePair[] = [];
    const cores: CanonicalCoreServer[] = [];
    const holds: (() => void)[] = [];
    afterEach(async () => {
      const closing = pairs.splice(0).map((pair) => pair.close());
      const closed = await within(Promise.all(closing));
      holds.splice(0).forEach((release) => release());
      const finishing = cores.splice(0).map((core) => core.done);
      const done = await within(Promise.all(finishing));
      // Asserted last so a stuck close still releases holds and drains cores.
      expect({ closed, done }).toEqual({
        closed: closing.map(() => undefined),
        done: finishing.map(() => undefined),
      });
    });

    /** A handler reply the test releases; afterEach releases any left. */
    const held = (): Promise<void> =>
      new Promise((resolve) => holds.push(resolve));
    const hold: CanonicalHandlers = {
      'core.test.echo': () => held().then(() => ({ text: '', length: 0 })),
      'core.test.record': () => held().then(() => ({ recorded: 0, label: '' })),
    };

    async function received(
      core: CanonicalCoreServer,
      count: number,
    ): Promise<boolean> {
      for (let i = 0; i < 100 && core.requests.length < count; i += 1)
        await sleep(10);
      return core.requests.length >= count;
    }

    async function connect(
      overrides: CanonicalHandlers = {},
      options: {
        initialize?: CoreRuntimeInitializeResult;
        signal?: AbortSignal;
      } = {},
    ): Promise<{
      core: CanonicalCoreServer;
      connection: CanopyFramedConnection;
      server: CanopyFramedConnection;
      connecting: Promise<CanonicalClient>;
    }> {
      const pair = await createPair();
      pairs.push(pair);
      const core = serveCanonicalCore(
        pair.server,
        { ...HANDLERS, ...overrides },
        { initialize: options.initialize },
      );
      cores.push(core);
      const connecting = createCanopyClient({
        connection: pair.client,
        clientName: 'conformance',
        clientVersion: '1.0.0',
        definitions: CANONICAL_DEFINITIONS,
        signal: options.signal,
      });
      return { core, connection: pair.client, server: pair.server, connecting };
    }
    async function open(
      overrides?: CanonicalHandlers,
      options?: { signal?: AbortSignal },
    ): Promise<{
      core: CanonicalCoreServer;
      connection: CanopyFramedConnection;
      server: CanopyFramedConnection;
      client: CanonicalClient;
    }> {
      const { connecting, ...connected } = await connect(overrides, options);
      return { ...connected, client: await connecting };
    }

    it('negotiates a frozen identity and gates on a private manifest snapshot', async () => {
      const { client, core, connection } = await open();
      expect(core.requests[0]?.params).toMatchObject({
        client: { name: 'conformance', protocolVersions: [1] },
      });
      expect(client.identity).toEqual({
        connectionId: connection.connectionId,
        authorityId: 'authority-1',
        runtimeId: 'runtime-1',
        hostId: 'host-1',
        daemonEpoch: 'epoch-1',
        profile: 'core+worker',
        buildVersion: '0.0.0-canonical',
        protocolVersion: 1,
      });
      expect(Object.isFrozen(client.identity)).toBe(true);
      if (client.manifest.operations instanceof Set)
        client.manifest.operations.add('core.test.hidden');
      expect(
        await rejection(client.query('core.test.hidden', {})),
      ).toMatchObject({ kind: 'capability_unavailable' });
      expect(core.requests).toHaveLength(1);
    });

    it('correlates concurrent replies out of order with typed results', async () => {
      const replies = new Map<string, () => void>();
      let receivedAll = (): void => {};
      const allReceived = new Promise<void>(
        (resolve) => (receivedAll = resolve),
      );
      const { client } = await open({
        'core.test.echo': async (params) => {
          const text = typeof params.text === 'string' ? params.text : '';
          if (['slow', 'fast!', 'mid'].includes(text))
            await new Promise<void>((resolve) => {
              holds.push(resolve);
              replies.set(text, resolve);
              if (replies.size === 3) receivedAll();
            });
          return { text, length: text.length };
        },
      });
      const order: string[] = [];
      const call = (text: string): Promise<number> =>
        client.query('core.test.echo', { text }).then((result) => {
          order.push(result.text);
          return result.length;
        });
      const slow = call('slow');
      const fast = call('fast!');
      const mid = call('mid');
      const lengths = Promise.allSettled([slow, fast, mid]);
      expect(await within(allReceived)).toBeUndefined();
      // Ordered server sends alone cannot order independent HTTP responses.
      replies.get('fast!')?.();
      expect(await within(fast)).toBe(5);
      replies.get('mid')?.();
      expect(await within(mid)).toBe(3);
      replies.get('slow')?.();
      expect(await within(slow)).toBe(4);
      expect(await lengths).toEqual(
        [4, 5, 3].map((value) => ({ status: 'fulfilled', value })),
      );
      expect(order).toEqual(['fast!', 'mid', 'slow']);
      const large = 'x'.repeat(1024 * 1024);
      await expect(
        client.query('core.test.echo', { text: large }),
      ).resolves.toEqual({ text: large, length: large.length });
    });

    it('validates request metadata locally and sends exact params with _meta', async () => {
      const { client, core } = await open();
      const invalid = await Promise.all([
        rejection(client.instruction('core.test.record', { value: 1 })),
        rejection(
          client.instruction(
            'core.test.record',
            { value: 1 },
            { metadata: { idempotencyKey: '' } },
          ),
        ),
        rejection(
          client.query(
            'core.test.echo',
            { text: 'a' },
            { metadata: { deadlineAt: 'tomorrow' } },
          ),
        ),
      ]);
      expect(invalid.map(({ kind }) => kind)).toEqual([
        'invalid_argument',
        'invalid_argument',
        'invalid_argument',
      ]);
      expect(core.requests).toHaveLength(1);
      await expect(
        client.instruction(
          'core.test.record',
          { value: 7 },
          { metadata: { idempotencyKey: 'key-1' } },
        ),
      ).resolves.toEqual({ recorded: 7, label: 'none' });
      const deadlineAt = new Date(Date.now() + 60_000).toISOString();
      await client.query(
        'core.test.echo',
        { text: 'a' },
        { metadata: { deadlineAt, traceparent: 'trace-1' } },
      );
      expect(core.requests.slice(1).map(({ params }) => params)).toEqual([
        { value: 7, _meta: { idempotencyKey: 'key-1' } },
        { text: 'a', _meta: { deadlineAt, traceparent: 'trace-1' } },
      ]);
    });

    it('maps every error kind and fails closed on undeclared errors or results', async () => {
      const { client } = await open();
      for (const kind of CANOPY_ERROR_KINDS)
        expect(
          await rejection(client.query('core.test.echo', { text: kind })),
        ).toEqual({
          kind,
          message: `${kind} from core`,
          retry: { kind: 'never' },
        });
      expect(
        await rejection(client.query('core.test.echo', { text: 'declared' })),
      ).toEqual({
        kind: 'not_found',
        message: 'declared',
        code: 'core.test.notFound',
        retry: { kind: 'never' },
      });
      for (const text of ['undeclared', 'bad-result'])
        expect(
          await rejection(client.query('core.test.echo', { text })),
        ).toMatchObject({ kind: 'internal', retry: { kind: 'never' } });
      expect(client.signal.aborted).toBe(false);
    });

    it('maps an advertised but unimplemented core method to capability_unavailable', async () => {
      const base = canonicalInitializeResult();
      const { connecting } = await connect(
        {},
        {
          initialize: {
            ...base,
            capabilities: {
              ...base.capabilities,
              operations: ['core.test.hidden'],
            },
          },
        },
      );
      const client = await connecting;
      expect(
        await rejection(client.query('core.test.hidden', {})),
      ).toMatchObject({ kind: 'capability_unavailable' });
      expect(client.signal.aborted).toBe(false);
    });

    it('rejects failed handshakes with their taxonomy and closes the connection', async () => {
      const revoked: CanopyErrorPayload = {
        kind: 'unauthenticated',
        message: 'Token revoked.',
        retry: { kind: 'never' },
      };
      const denied = await connect({
        'core.runtime.initialize': () => {
          throw new CanonicalCoreError(revoked);
        },
      });
      expect(await rejection(denied.connecting)).toEqual(revoked);
      expect(denied.connection.signal.aborted).toBe(true);

      // The canonical core's result selects a version the client never offered.
      const base = canonicalInitializeResult();
      const mismatch = await connect(
        {},
        {
          initialize: {
            ...base,
            selectedProtocolVersion: 2,
            runtime: { ...base.runtime, protocolVersions: [2] },
          },
        },
      );
      const payload = await rejection(mismatch.connecting);
      expect(payload).toMatchObject({
        kind: 'failed_precondition',
        code: 'core.runtime.invalidState',
      });
      expect(payload.message).toMatch(/restart the daemon or update/i);
      expect(mismatch.connection.signal.aborted).toBe(true);

      const runtime = Object.fromEntries(
        Object.entries(base.runtime).filter(([key]) => key !== 'buildVersion'),
      );
      const unversioned = await connect({
        'core.runtime.initialize': () => ({ ...base, runtime }),
      });
      const malformed = await rejection(unversioned.connecting);
      expect(malformed).toMatchObject({ kind: 'internal' });
      expect(malformed.message).toMatch(/runtime\.buildVersion/);
      expect(unversioned.connection.signal.aborted).toBe(true);
    });

    it('closes an unanswered initialize when the client signal aborts', async () => {
      const controller = new AbortController();
      const { core, connection, connecting } = await connect(
        { 'core.runtime.initialize': () => held() },
        { signal: controller.signal },
      );
      expect(await received(core, 1)).toBe(true);
      controller.abort();
      expect(await within(rejection(connecting))).toMatchObject({
        kind: 'cancelled',
      });
      expect(connection.signal.aborted).toBe(true);
    });

    it('rejects pre-aborted and already-expired calls without sending them', async () => {
      const { client, core } = await open();
      const aborted = new AbortController();
      aborted.abort();
      const past = new Date(Date.now() - 1_000).toISOString();
      expect(
        await rejection(
          client.query(
            'core.test.echo',
            { text: 'a' },
            { signal: aborted.signal },
          ),
        ),
      ).toMatchObject({ kind: 'cancelled' });
      expect(
        await rejection(
          client.query(
            'core.test.echo',
            { text: 'a' },
            { metadata: { deadlineAt: past } },
          ),
        ),
      ).toMatchObject({
        kind: 'deadline_exceeded',
        retry: { kind: 'same_request' },
      });
      expect(core.requests).toHaveLength(1);
    });

    it('cancels and expires in-flight calls and ignores their late replies', async () => {
      const { client, core } = await open({
        'core.test.echo': async (params) => {
          if (params.text !== 'ok') await held();
          return { text: params.text, length: 2 };
        },
      });
      const controller = new AbortController();
      const inFlight = rejection(
        client.query(
          'core.test.echo',
          { text: 'late' },
          { signal: controller.signal },
        ),
      );
      const expiring = rejection(
        client.query(
          'core.test.echo',
          { text: 'later' },
          { metadata: { deadlineAt: new Date(Date.now() + 10).toISOString() } },
        ),
      );
      expect(await received(core, 3)).toBe(true);
      controller.abort();
      expect(await inFlight).toMatchObject({ kind: 'cancelled' });
      expect(await within(expiring)).toMatchObject({
        kind: 'deadline_exceeded',
        retry: { kind: 'same_request' },
      });
      // Late replies are sent before the next reply, so it proves both were ignored.
      holds.splice(0).forEach((release) => release());
      await expect(
        client.query('core.test.echo', { text: 'ok' }),
      ).resolves.toEqual({ text: 'ok', length: 2 });
      expect(client.signal.aborted).toBe(false);
    });

    conformance(
      'settles pending calls when the core disconnects',
      true,
      async () => {
        const { client, core, server } = await open(hold);
        const query = rejection(client.query('core.test.echo', { text: 'x' }));
        const keyed = rejection(
          client.instruction(
            'core.test.record',
            { value: 1 },
            { metadata: { idempotencyKey: 'key-1' } },
          ),
        );
        expect(await received(core, 3)).toBe(true);
        server.close();
        expect(await within(query)).toMatchObject({
          kind: 'unavailable',
          retry: { kind: 'same_request' },
        });
        expect(await within(keyed)).toMatchObject({
          kind: 'unavailable',
          retry: { kind: 'same_idempotency_key' },
        });
        expect(client.signal.aborted).toBe(true);
        expect(
          await rejection(client.query('core.test.echo', { text: 'x' })),
        ).toMatchObject({ kind: 'unavailable' });
      },
    );

    // Simulated: the core closes with a typed reason. Real auth and version
    // negotiation are covered by the handshake cases and transport tests.
    const closeReasons: CanopyErrorPayload[] = [
      {
        kind: 'unauthenticated',
        message: 'Session token expired.',
        retry: { kind: 'never' },
      },
      {
        kind: 'failed_precondition',
        message: 'The daemon was updated; reconnect.',
        code: 'core.runtime.invalidState',
        retry: { kind: 'never' },
      },
    ];
    for (const reason of closeReasons)
      conformance(
        `settles pending and later calls with a mid-session ${reason.kind} close`,
        true,
        async () => {
          const { client, core, server } = await open(hold);
          const pending = [
            rejection(client.query('core.test.echo', { text: 'x' })),
            rejection(
              client.instruction(
                'core.test.record',
                { value: 1 },
                { metadata: { idempotencyKey: 'key-1' } },
              ),
            ),
          ];
          expect(await received(core, 3)).toBe(true);
          server.close(reason);
          expect(await within(Promise.all(pending))).toEqual([reason, reason]);
          expect(client.signal.aborted).toBe(true);
          expect(
            await rejection(client.query('core.test.echo', { text: 'x' })),
          ).toEqual(reason);
          expect(
            await rejection(
              client.instruction(
                'core.test.record',
                { value: 2 },
                { metadata: { idempotencyKey: 'key-2' } },
              ),
            ),
          ).toEqual(reason);
          expect(core.requests).toHaveLength(3);
        },
      );

    it('closes the session when the client signal aborts', async () => {
      const controller = new AbortController();
      const { client, connection } = await open(hold, {
        signal: controller.signal,
      });
      const pending = rejection(client.query('core.test.echo', { text: 'x' }));
      controller.abort();
      expect(await within(pending)).toMatchObject({ kind: 'cancelled' });
      expect(client.signal.aborted).toBe(true);
      expect(connection.signal.aborted).toBe(true);
      expect(
        await rejection(client.query('core.test.echo', { text: 'x' })),
      ).toMatchObject({ kind: 'cancelled' });
    });

    it('close settles pending calls as cancelled and closes the connection', async () => {
      const { client, connection } = await open(hold);
      const pending = rejection(client.query('core.test.echo', { text: 'x' }));
      expect(await within(client.close())).toBeUndefined();
      const closed: CanopyErrorPayload = {
        kind: 'cancelled',
        message: 'The client was closed.',
        retry: { kind: 'never' },
      };
      expect(await within(pending)).toEqual(closed);
      expect(connection.signal.aborted).toBe(true);
      expect(client.signal.aborted).toBe(true);
      expect(
        await rejection(client.query('core.test.echo', { text: 'x' })),
      ).toEqual(closed);
    });

    /** Its reply lands after every frame the core sent before it. */
    const flush = (client: CanonicalClient): Promise<unknown> =>
      client.query('core.test.echo', { text: 'flush' });
    const holdOpen = { count: 0, hold: true };
    /** Opens a stream the core holds open, so the test drives its frames. */
    const openHeld = (
      client: CanonicalClient,
      options?: Parameters<CanonicalClient['openStream']>[2],
    ): ReturnType<CanonicalClient['openStream']> =>
      client.openStream('core.test.ticks', holdOpen, options);
    const thrown = (action: () => unknown): Promise<CanopyErrorPayload> =>
      rejection(Promise.resolve().then(action));

    conformance(
      'streams typed frames to completion with the open result and request id',
      false,
      async () => {
        const { client, core } = await open();
        const handle = await client.openStream('core.test.ticks', { count: 2 });
        expect(handle.requestId).toBe(String(core.requests[1]?.id));
        expect(handle.openResult).toEqual({
          subscriptionId: subscriptionIdFor(handle.requestId),
          acceptedCursor: null,
        });
        expect(await drain(handle.frames)).toEqual([
          item(1, 0),
          item(2, 1),
          completed(2),
        ]);
      },
    );

    it('delivers frames sent ahead of their open reply first, in order', async () => {
      const { client } = await open();
      const handle = await client.openStream('core.test.ticks', {
        early: 2,
        count: 1,
      });
      expect(await drain(handle.frames)).toEqual([
        item(1, 0),
        item(2, 1),
        item(3, 2),
        completed(3),
      ]);
    });

    conformance(
      'delivers every frame to an onFrame option attached at open',
      false,
      async () => {
        const { client } = await open();
        const pushed = recorder();
        const options = { onFrame: pushed.listener };
        await client.openStream('core.test.ticks', { count: 3 }, options);
        expect(await within(pushed.ended)).toBeUndefined();
        expect(ticksOf(pushed.frames)).toEqual([0, 1, 2, 'completed']);
      },
    );

    it('buffers while push listeners detach and redelivers in order past listener errors', async () => {
      const { client, core } = await open();
      const handle = await openHeld(client);
      const { subscriptionId } = handle.openResult;
      const first: TickFrame[] = [];
      const detach = handle.onFrame((frame) => first.push(frame));
      expect(await rejection(drain(handle.frames))).toMatchObject({
        kind: 'failed_precondition',
      });
      await core.emit(subscriptionId, { tick: 1 });
      await flush(client);
      detach();
      await core.emit(subscriptionId, { tick: 2 });
      await core.emit(subscriptionId, { tick: 3 });
      await flush(client);
      const second = recorder();
      handle.onFrame((frame) => {
        second.listener(frame);
        throw new Error('listener failed');
      });
      await core.emit(subscriptionId, { tick: 4 });
      await core.end(subscriptionId);
      expect(await within(second.ended)).toBeUndefined();
      expect(ticksOf(first)).toEqual([1]);
      expect(ticksOf(second.frames)).toEqual([2, 3, 4, 'completed']);
      await flush(client);
      expect(client.signal.aborted).toBe(false);
    });

    it('keeps a stream live and pull-only after an early iterator exit until closed', async () => {
      const { client, core } = await open();
      const handle = await openHeld(client);
      const { subscriptionId } = handle.openResult;
      for (const tick of [0, 1]) await core.emit(subscriptionId, { tick });
      for await (const frame of handle.frames) {
        expect(ticksOf([frame])).toEqual([0]);
        break;
      }
      await core.emit(subscriptionId, { tick: 2 });
      await flush(client);
      expect(await thrown(() => handle.onFrame(() => {}))).toMatchObject({
        kind: 'failed_precondition',
      });
      const rest = handle.frames[Symbol.asyncIterator]();
      expect(await pull(rest)).toMatchObject({ item: { tick: 1 } });
      const last = await pull(rest);
      expect(last).toMatchObject({ item: { tick: 2 } });
      handle.close();
      expect(await pull(rest)).toMatchObject({
        kind: 'end',
        cursor: last?.cursor ?? {},
        outcome: 'cancelled',
        error: { kind: 'cancelled' },
      });
      expect(await pull(rest)).toBeUndefined();
      // Initialize, the open, and one flush: closing sent nothing.
      expect(core.requests).toHaveLength(3);
    });

    it('bounds an early-exited stream at 1024 items while queries and siblings progress', async () => {
      const { client, core } = await open();
      const flooded = await openHeld(client);
      const sibling = recorder();
      const other = await openHeld(client, { onFrame: sibling.listener });
      await core.emit(flooded.openResult.subscriptionId, { tick: 0 });
      for await (const frame of flooded.frames) {
        expect(ticksOf([frame])).toEqual([0]);
        break;
      }
      // Fixed emits, then one round trip: no timing assumptions.
      for (let tick = 1; tick <= 1_030; tick += 1) {
        await core.emit(flooded.openResult.subscriptionId, { tick });
        if (tick % 500 === 0)
          await core.emit(other.openResult.subscriptionId, { tick });
      }
      await expect(flush(client)).resolves.toMatchObject({ text: 'flush' });
      await core.end(other.openResult.subscriptionId);
      expect(await within(sibling.ended)).toBeUndefined();
      expect(ticksOf(sibling.frames)).toEqual([500, 1_000, 'completed']);
      const frames = await drain(flooded.frames);
      expect(ticksOf(frames)).toEqual([
        ...Array.from({ length: 1_024 }, (_, index) => index + 1),
        'error',
      ]);
      // Ends at the last delivered item, so a resume skips nothing.
      expect(frames.at(-1)).toEqual({
        kind: 'end',
        cursor: frames.at(-2)?.cursor,
        outcome: 'error',
        error: {
          kind: 'resource_exhausted',
          message: 'Stream buffer capacity exceeded.',
          retry: { kind: 'after_refresh', resource: 'stream' },
        },
      });
      expect(client.signal.aborted).toBe(false);
    });

    it('bounds a paused stream by encoded bytes while queries and siblings progress', async () => {
      const { client, core, connection } = await open();
      const flooded = await openHeld(client);
      const sibling = recorder();
      const other = await openHeld(client, { onFrame: sibling.listener });
      // 6 MiB each: two fit one stream's byte budget, the third cannot.
      const pad = 'x'.repeat(6 * 1024 * 1024);
      const during = client.query('core.test.echo', { text: 'during' });
      for (const tick of [1, 2, 3]) {
        await core.emit(flooded.openResult.subscriptionId, { tick, pad });
        await core.emit(other.openResult.subscriptionId, { tick });
      }
      await expect(during).resolves.toEqual({ text: 'during', length: 6 });
      await expect(flush(client)).resolves.toMatchObject({ text: 'flush' });
      await core.end(other.openResult.subscriptionId);
      expect(await within(sibling.ended)).toBeUndefined();
      expect(ticksOf(sibling.frames)).toEqual([1, 2, 3, 'completed']);
      const rest = flooded.frames[Symbol.asyncIterator]();
      const frames = [await pull(rest), await pull(rest), await pull(rest)];
      // Compact first, so a red run never prints the padding.
      expect(frames.map((frame) => frame && ticksOf([frame])[0])).toEqual([
        1,
        2,
        'error',
      ]);
      // Ends at the last accepted item, so a resume skips nothing.
      expect(frames.map((frame) => frame?.cursor)).toEqual(
        [1, 3, 3].map((sequence) => ({ daemonEpoch: 'epoch-1', sequence })),
      );
      expect(frames[2]).toMatchObject({
        kind: 'end',
        outcome: 'error',
        error: {
          kind: 'resource_exhausted',
          retry: { kind: 'after_refresh', resource: 'stream' },
        },
      });
      const padded = frames.map(
        (frame) =>
          frame?.kind === 'item' &&
          'pad' in frame.item &&
          frame.item.pad === pad,
      );
      expect(padded).toEqual([true, true, false]);
      expect(await pull(rest)).toBeUndefined();
      expect(client.signal.aborted).toBe(false);
      expect(connection.signal.aborted).toBe(false);
    });

    it('closes locally at a client-only cursor, drops late frames, and sends nothing', async () => {
      const { client, core } = await open();
      const pushed = recorder();
      const handle = await openHeld(client, { onFrame: pushed.listener });
      handle.close();
      handle.close();
      await core.emit(handle.openResult.subscriptionId, { tick: 1 });
      await flush(client);
      expect(pushed.frames).toMatchObject([
        {
          kind: 'end',
          cursor: { daemonEpoch: 'epoch-1', sequence: 0 },
          outcome: 'cancelled',
          error: { kind: 'cancelled' },
        },
      ]);
      const cursor = { daemonEpoch: 'epoch-1', sequence: 7 };
      const resumeAt = { ...holdOpen, cursor };
      const resumed = await client.openStream('core.test.ticks', resumeAt);
      expect(resumed.openResult.acceptedCursor).toEqual(cursor);
      resumed.close();
      expect(await drain(resumed.frames)).toMatchObject([
        { kind: 'end', cursor, outcome: 'cancelled' },
      ]);
      const fresh = await client.openStream('core.test.ticks', { count: 0 });
      expect(ticksOf(await drain(fresh.frames))).toEqual(['completed']);
      // The zero cursor never leaves the client, and no close reaches the wire.
      expect(
        core.requests.slice(1).map(({ method, params }) => [method, params]),
      ).toEqual([
        ['core.test.ticks', holdOpen],
        ['core.test.echo', { text: 'flush' }],
        ['core.test.ticks', resumeAt],
        ['core.test.ticks', { count: 0 }],
      ]);
      expect(client.signal.aborted).toBe(false);
    });

    it('ends open streams as cancelled on abort and as errors at their deadline', async () => {
      const { client, core } = await open();
      const abort = new AbortController();
      const aborted = await openHeld(client, { signal: abort.signal });
      const deadlineAt = new Date(Date.now() + 200).toISOString();
      const expiring = await openHeld(client, { metadata: { deadlineAt } });
      abort.abort();
      expect(await drain(aborted.frames)).toMatchObject([
        { outcome: 'cancelled', error: { kind: 'cancelled' } },
      ]);
      expect(await drain(expiring.frames)).toMatchObject([
        { outcome: 'error', error: { kind: 'deadline_exceeded' } },
      ]);
      expect(core.requests).toHaveLength(3);
      expect(client.signal.aborted).toBe(false);
    });

    it('rejects opens aborted or expired before the reply and ignores the late reply', async () => {
      const { client, core } = await open({ 'core.test.ticks': () => held() });
      const abort = new AbortController();
      const aborted = rejection(openHeld(client, { signal: abort.signal }));
      const deadlineAt = new Date(Date.now() + 10).toISOString();
      const lapsed = rejection(openHeld(client, { metadata: { deadlineAt } }));
      expect(await received(core, 3)).toBe(true);
      abort.abort();
      expect(await aborted).toMatchObject({ kind: 'cancelled' });
      expect(await within(lapsed)).toMatchObject({
        kind: 'deadline_exceeded',
        retry: { kind: 'same_request' },
      });
      // Late open replies land before the flush reply; their frames follow.
      holds.splice(0).forEach((release) => release());
      await flush(client);
      for (const { id } of core.requests.slice(1, 3))
        await core.emit(subscriptionIdFor(id), { tick: 1 });
      await expect(flush(client)).resolves.toMatchObject({ text: 'flush' });
      expect(client.signal.aborted).toBe(false);
    });

    it('rejects invalid opens locally and contains open errors and malformed frames', async () => {
      const base = canonicalInitializeResult();
      const capabilities = { ...base.capabilities, streams: [] };
      const unadvertised = await connect(
        {},
        { initialize: { ...base, capabilities } },
      );
      const gated = await unadvertised.connecting;
      expect(await rejection(openHeld(gated))).toMatchObject({
        kind: 'capability_unavailable',
      });
      const declared: CanopyErrorPayload = {
        kind: 'not_found',
        message: 'declared',
        code: 'core.test.notFound',
        retry: { kind: 'never' },
      };
      const { client, core } = await open({
        'core.test.ticks': ({ count }) => {
          if (count === 1) throw new CanonicalCoreError(declared);
          if (count === 2)
            throw new CanonicalCoreError({
              ...declared,
              code: 'core.other.missing',
            });
          return count === 3 ? { subscriptionId: '' } : undefined;
        },
      });
      const aborted = new AbortController();
      aborted.abort();
      const past = new Date(Date.now() - 1_000).toISOString();
      const options = [
        { metadata: { deadlineAt: 'tomorrow' } },
        { signal: aborted.signal },
        { metadata: { deadlineAt: past } },
      ];
      const local = await Promise.all([
        rejection(client.openStream('core.test.ticks', { count: -1 })),
        ...options.map((option) => rejection(openHeld(client, option))),
      ]);
      expect(local.map(({ kind }) => kind)).toEqual([
        'invalid_argument',
        'invalid_argument',
        'cancelled',
        'deadline_exceeded',
      ]);
      expect(unadvertised.core.requests).toHaveLength(1);
      expect(core.requests).toHaveLength(1);
      expect(
        await rejection(client.openStream('core.test.ticks', { count: 1 })),
      ).toEqual(declared);
      for (const count of [2, 3])
        expect(
          await rejection(client.openStream('core.test.ticks', { count })),
        ).toMatchObject({ kind: 'internal' });
      const malformed = await openHeld(client);
      await core.emit(malformed.openResult.subscriptionId, { tick: 'x' });
      expect(await drain(malformed.frames)).toMatchObject([
        { kind: 'end', outcome: 'error', error: { kind: 'internal' } },
      ]);
      await expect(flush(client)).resolves.toMatchObject({ text: 'flush' });
      expect(client.signal.aborted).toBe(false);
    });

    const expired: CanopyErrorPayload = {
      kind: 'unauthenticated',
      message: 'Session token expired.',
      retry: { kind: 'never' },
    };
    type Session = Awaited<ReturnType<typeof open>>;
    const disconnect = ({ server }: Session): void => server.close();
    const expire = ({ server }: Session): void => server.close(expired);
    const closeClient = ({ client }: Session): Promise<void> => client.close();
    const sessionEnds = [
      ['the core disconnects', disconnect, { kind: 'unavailable' }, 'error'],
      ['the core closes typed', expire, expired, 'error'],
      [
        'the client closes',
        closeClient,
        { kind: 'cancelled', message: 'The client was closed.' },
        'cancelled',
      ],
    ] as const;
    for (const [when, closeSession, reason, outcome] of sessionEnds)
      conformance(
        `ends held streams with the session reason when ${when}`,
        closeSession !== closeClient,
        async () => {
          const session = await open();
          const { client, core } = session;
          const handle = await openHeld(client);
          await core.emit(handle.openResult.subscriptionId, { tick: 1 });
          await flush(client);
          await closeSession(session);
          const frames = await drain(handle.frames);
          const cursor = frames[0]?.cursor ?? {};
          expect(frames).toMatchObject([
            { kind: 'item' },
            { kind: 'end', cursor, outcome, error: reason },
          ]);
          expect(client.signal.aborted).toBe(true);
          expect(await rejection(openHeld(client))).toMatchObject(reason);
        },
      );

    /** Two connections to distinct cores, each holding a same-id stream. */
    const twoConnections = async (): Promise<{
      first: Awaited<ReturnType<typeof open>>;
      other: Awaited<ReturnType<typeof connect>>;
      second: CanonicalClient;
      lost: Awaited<ReturnType<typeof openHeld>>;
      kept: Awaited<ReturnType<typeof openHeld>>;
      subscriptionId: string;
      daemonEpoch: string;
    }> => {
      const first = await open();
      const base = canonicalInitializeResult();
      const runtime = {
        ...base.runtime,
        authorityId: 'authority-2',
        runtimeId: 'runtime-2',
        hostId: 'host-2',
        daemonEpoch: 'epoch-2',
      };
      const other = await connect({}, { initialize: { ...base, runtime } });
      const second = await other.connecting;
      const identities = [first.client, second].map(({ identity }) => [
        identity.authorityId,
        identity.runtimeId,
        identity.hostId,
        identity.daemonEpoch,
      ]);
      expect(identities).toEqual([
        ['authority-1', 'runtime-1', 'host-1', 'epoch-1'],
        ['authority-2', 'runtime-2', 'host-2', 'epoch-2'],
      ]);
      const lost = await openHeld(first.client);
      const kept = await openHeld(second);
      // Both cores issue the same subscription id; routing stays per connection.
      const { subscriptionId } = kept.openResult;
      expect(lost.openResult.subscriptionId).toBe(subscriptionId);
      return {
        first,
        other,
        second,
        lost,
        kept,
        subscriptionId,
        daemonEpoch: runtime.daemonEpoch,
      };
    };

    conformance('routes same-id streams per connection', false, async () => {
      const { first, other, lost, kept, subscriptionId, daemonEpoch } =
        await twoConnections();
      await first.core.emit(subscriptionId, { tick: 1 });
      await other.core.emit(subscriptionId, { tick: 2 });
      await first.core.end(subscriptionId);
      await other.core.end(subscriptionId);
      expect(await drain(lost.frames)).toEqual([item(1, 1), completed(1)]);
      expect(await drain(kept.frames)).toEqual([
        item(1, 2, daemonEpoch),
        completed(1, daemonEpoch),
      ]);
    });

    conformance(
      'keeps identities, cursors, and streams independent across connections',
      true,
      async () => {
        const {
          first,
          other,
          second,
          lost,
          kept,
          subscriptionId,
          daemonEpoch,
        } = await twoConnections();
        await first.core.emit(subscriptionId, { tick: 1 });
        await other.core.emit(subscriptionId, { tick: 2 });
        await flush(first.client);
        first.server.close();
        expect(ticksOf(await drain(lost.frames))).toEqual([1, 'error']);
        await other.core.emit(subscriptionId, { tick: 3 });
        await other.core.end(subscriptionId);
        expect(await drain(kept.frames)).toEqual([
          item(1, 2, daemonEpoch),
          item(2, 3, daemonEpoch),
          completed(2, daemonEpoch),
        ]);
        const local = await openHeld(second);
        local.close();
        expect(await drain(local.frames)).toMatchObject([
          { cursor: { daemonEpoch, sequence: 0 } },
        ]);
        expect(second.signal.aborted).toBe(false);
      },
    );

    // A stale entry would silently stop naming a case that now runs.
    if (pending.size > 0)
      throw new Error(
        `Unknown pending cases (each must name a case registered through conformance()): ${[...pending.keys()].join(', ')}`,
      );
  });
}
