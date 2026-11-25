import { connectCanopyHttp } from '../../../core-transport/src/http';
import {
  createHttpFramedPair,
  createHttpTestServer,
} from '../../../core-transport/src/__tests__/fixtures/http-pair';
import type { CanopyFramedConnection } from '../../../core-transport/src/types';
import { CORE_TRANSPORT_INSTRUCTION_DEFINITIONS } from '@canopy/protocol/canopy-core';

import { createCanopyClient } from '../index';
import type { CanopyClient } from '../types';
import {
  describeCanopyClientConformance,
  drain,
  type CanopyClientConformancePair,
} from './client-conformance';
import {
  CANONICAL_DEFINITIONS,
  serveCanonicalCore,
} from './fixtures/canonical-core';

// The shared client over the HTTP binding's client half; the fixture says
// what this proves and where the web core itself is covered.
describeCanopyClientConformance(
  'http (client binding)',
  async (): Promise<CanopyClientConformancePair> => {
    const { client, server, loseNextReply } = await createHttpFramedPair();
    return {
      client,
      server,
      ...(loseNextReply === undefined ? {} : { loseNextReply }),
      close: () => {
        client.close();
        server.close();
        return Promise.resolve();
      },
    };
  },
  {
    serverClose: false,
    lostReplies: true,
  },
);

describe('http (client binding): cleanup and connection health', () => {
  const ENDPOINT = '/api/cloud/core/connections';
  const bounded = <T>(promise: Promise<T>): Promise<T | 'timeout'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(resolve, 1_000, 'timeout');
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 50));
  type Client = Pick<
    CanopyClient<
      typeof CANONICAL_DEFINITIONS.queries,
      typeof CANONICAL_DEFINITIONS.instructions,
      typeof CANONICAL_DEFINITIONS.streams
    >,
    'openStream' | 'query' | 'close' | 'signal'
  >;
  type Handle = Awaited<ReturnType<Client['openStream']>>;
  /** How a gateway answers one POST: through, a 503, or no response. */
  type Outcome = 'through' | '503' | 'lost';
  const closing: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closing.splice(0)) await close();
  });

  /**
   * A client over the real HTTP binding with a sibling stream and seven held
   * streams the core can end, its POSTs answered as `outcome` decides by
   * method; cleanup unsubscribes go as background requests.
   */
  async function harness(): Promise<{
    client: Client;
    core: ReturnType<typeof serveCanonicalCore>;
    sibling: Handle;
    held: Handle[];
    unsubscribes: unknown[];
    answer: (outcome: (method: unknown) => Outcome) => void;
    offline: () => Promise<boolean>;
  }> {
    const servers: CanopyFramedConnection[] = [];
    const http = createHttpTestServer(
      (opened) => servers.length === 0 && servers.push(opened) > 0,
    );
    let outcome: (method: unknown) => Outcome = () => 'through';
    const unsubscribes: unknown[] = [];
    const connection = await connectCanopyHttp({
      endpoint: ENDPOINT,
      fetch: (path, init) => {
        if (path !== ENDPOINT && init?.method === 'POST') {
          const body: unknown = JSON.parse(
            typeof init.body === 'string' ? init.body : 'null',
          );
          const method: unknown = Reflect.get(Object(body), 'method');
          if (method === 'core.events.unsubscribe') unsubscribes.push(method);
          const answer = outcome(method);
          if (answer === '503')
            return Promise.resolve(
              new Response('upstream connect error', { status: 503 }),
            );
          if (answer === 'lost')
            return Promise.reject(new TypeError('fetch failed'));
        }
        return http.fetch(path, init);
      },
    });
    const [server] = servers;
    if (!server) throw new Error('The HTTP pair did not open.');
    const core = serveCanonicalCore(server, {
      'core.test.echo': (params) => ({
        text: String(params.text),
        length: String(params.text).length,
      }),
    });
    const client: Client = await createCanopyClient({
      connection,
      clientName: 'conformance',
      clientVersion: '1.0.0',
      definitions: {
        ...CANONICAL_DEFINITIONS,
        instructions: {
          ...CANONICAL_DEFINITIONS.instructions,
          'core.events.unsubscribe':
            CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.events.unsubscribe'],
        },
      },
    });
    closing.push(async () => {
      await client.close();
      connection.close();
      server.close();
      await bounded(core.done);
    });
    const hold = { count: 0, hold: true };
    const sibling = await client.openStream('core.test.ticks', hold);
    const held = [];
    for (let open = 0; open < 7; open += 1)
      held.push(await client.openStream('core.test.ticks', hold));
    return {
      client,
      core,
      sibling,
      held,
      unsubscribes,
      answer: (next) => {
        outcome = next;
      },
      offline: async () =>
        (await bounded(
          new Promise<void>((resolve) =>
            client.signal.aborted
              ? resolve()
              : client.signal.addEventListener('abort', () => resolve()),
          ),
        )) === undefined,
    };
  }

  /** The core ends `handles` at once, as a rollover ends every flag stream. */
  async function endAll(
    core: ReturnType<typeof serveCanonicalCore>,
    handles: readonly Handle[],
  ): Promise<void> {
    for (const handle of handles)
      await core.end(handle.openResult.subscriptionId);
    for (const handle of handles) await drain(handle.frames);
    await settle();
  }

  async function stillLive(
    h: Awaited<ReturnType<typeof harness>>,
  ): Promise<void> {
    expect(h.client.signal.aborted).toBe(false);
    await h.core.emit(h.sibling.openResult.subscriptionId, { tick: 7 });
    expect(
      await bounded(h.sibling.frames[Symbol.asyncIterator]().next()),
    ).toMatchObject({ value: { kind: 'item', item: { tick: 7 } } });
    await expect(
      h.client.query('core.test.echo', { text: 'ok' }),
    ).resolves.toEqual({ text: 'ok', length: 2 });
  }

  const query = (h: Awaited<ReturnType<typeof harness>>): Promise<unknown> =>
    h.client.query('core.test.echo', { text: 'x' }).catch(() => null);
  const unsubscribe = (method: unknown): boolean =>
    method === 'core.events.unsubscribe';

  it('keeps the connection and its other streams when cleanup unsubscribes keep failing 503, while five failed requests in a row still end it', async () => {
    const h = await harness();
    const last = h.held.pop();
    if (!last) throw new Error('No stream opened.');
    h.answer((method) => (unsubscribe(method) ? '503' : 'through'));
    await endAll(h.core, h.held);
    expect(h.unsubscribes).toHaveLength(6);
    await stillLive(h);
    // Requests the app made still count: five 503s in a row end it, and a
    // cleanup answered among them does not start the count afresh.
    h.answer((method) => (unsubscribe(method) ? 'through' : '503'));
    for (let failed = 0; failed < 4; failed += 1) await query(h);
    await endAll(h.core, [last]);
    expect(h.unsubscribes).toHaveLength(7);
    expect(h.client.signal.aborted).toBe(false);
    await query(h);
    expect(await h.offline()).toBe(true);
  });

  it('keeps the connection and its other streams when cleanup unsubscribes keep getting no response', async () => {
    const h = await harness();
    h.answer((method) => (unsubscribe(method) ? 'lost' : 'through'));
    await endAll(h.core, h.held);
    expect(h.unsubscribes).toHaveLength(7);
    // Nor do they start a run: the app's next request alone may get none.
    h.answer(() => 'lost');
    await query(h);
    expect(h.client.signal.aborted).toBe(false);
    h.answer((method) => (unsubscribe(method) ? 'lost' : 'through'));
    await stillLive(h);
  });

  it('goes offline at the second app request in a row with no response, whatever cleanup the core answered between them', async () => {
    const h = await harness();
    h.answer((method) => (unsubscribe(method) ? 'through' : 'lost'));
    await query(h);
    await endAll(h.core, h.held.slice(0, 1));
    expect(h.unsubscribes).toHaveLength(1);
    expect(h.client.signal.aborted).toBe(false);
    await query(h);
    expect(await h.offline()).toBe(true);
  });

  it('goes offline at the second app request in a row with no response while cleanup also gets none', async () => {
    const h = await harness();
    h.answer(() => 'lost');
    await query(h);
    await endAll(h.core, h.held.slice(0, 2));
    expect(h.unsubscribes).toHaveLength(2);
    expect(h.client.signal.aborted).toBe(false);
    await query(h);
    expect(await h.offline()).toBe(true);
  });
});
