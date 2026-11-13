import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  CLOUD_ACCOUNT,
  handleCloudRequest,
} from '../mock-server/routes/cloud.mjs';
import {
  createCloudChatsWorld,
  WEB_CORE_AUTHORITY_ID,
} from './cloudChatsWorld.js';

const CONNECTIONS = '/api/cloud/core/connections';
const INITIALIZE = 'core.runtime.initialize';

/**
 * As `CANOPY_JSON_RPC_ERROR_CODES` in @canopy/protocol's wire.ts. The client
 * refuses an error frame whose code is not its kind's, and closes the
 * connection, so a refusal must carry its kind's code.
 */
const ERROR_CODES = {
  invalid_argument: -32602,
  unauthenticated: -32001,
  permission_denied: -32002,
  not_found: -32003,
  already_exists: -32004,
  conflict: -32005,
  failed_precondition: -32006,
  capability_unavailable: -32007,
  cancelled: -32008,
  deadline_exceeded: -32009,
  unavailable: -32010,
  resource_exhausted: -32011,
  internal: -32603,
};

/**
 * Per-test Cloud for desktop cloud chats (CAN-6280): the seeded world of
 * `cloudChatsWorld.js` served over the web core's real POST + SSE binding,
 * and the suite's Cloud routes for everything else. Launch the app with
 * `CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl` and the cloud chats flag on,
 * then connect the mock account; the sidebar then lists the seeded project.
 *
 * Each connection gets its own push stream. A stream item goes to the
 * connection that opened its subscription, numbered so a reopened stream
 * resumes after the last event id it received.
 */
export async function startCloudChatsWebCore() {
  const world = createCloudChatsWorld({ accountId: CLOUD_ACCOUNT.id });
  /**
   * @type {Map<string, { events: { id: number, data: string }[], streams: Set<import('node:http').ServerResponse> }>}
   */
  const connections = new Map();
  /** Which connection opened each subscription. */
  const subscriptionOwners = new Map();

  const push = (connectionId, message) => {
    const connection = connections.get(connectionId);
    if (connection === undefined) return;
    const event = {
      id: connection.events.length + 1,
      data: JSON.stringify(message),
    };
    connection.events.push(event);
    for (const stream of connection.streams) writeEvent(stream, event);
  };
  world.onNotification((notification) => {
    const owner = subscriptionOwners.get(notification.params.subscriptionId);
    if (owner !== undefined) push(owner, notification);
  });

  const send = (response, status, data) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(data));
  };
  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return null;
    }
  };
  const authorized = (request) =>
    /^Bearer (csk_|cwc_)/.test(request.headers.authorization ?? '');

  const initialize = () => ({
    runtime: {
      runtimeId: 'web-core-e2e',
      hostId: 'web-core-e2e',
      authorityId: WEB_CORE_AUTHORITY_ID,
      profile: 'core+worker',
      daemonEpoch: 'web-core-e2e',
      protocolVersions: [1],
      state: 'ready',
      buildVersion: 'e2e',
    },
    selectedProtocolVersion: 1,
    capabilities: {
      operations: world.served(),
      events: [],
      streams: world.streams(),
    },
    limits: {},
    authentication: {
      required: true,
      methods: [],
      principal: { userId: CLOUD_ACCOUNT.id },
    },
  });

  const reply = (id, answer) => {
    if (answer === undefined)
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: 'Not served.',
          data: {
            kind: 'capability_unavailable',
            message: 'Not served.',
            retry: { kind: 'never' },
          },
        },
      };
    if ('error' in answer)
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: ERROR_CODES[answer.error.kind],
          message: answer.error.message,
          data: answer.error,
        },
      };
    return { jsonrpc: '2.0', id, result: answer.result };
  };

  /** The SSE leg: replays what followed `last-event-id`, then stays open. */
  const openEvents = (request, response, connectionId) => {
    const connection = connections.get(connectionId);
    if (connection === undefined) {
      send(response, 404, { error: 'No such connection.' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.flushHeaders();
    const after = Number(request.headers['last-event-id'] ?? 0) || 0;
    for (const event of connection.events)
      if (event.id > after) writeEvent(response, event);
    connection.streams.add(response);
    request.on('close', () => connection.streams.delete(response));
  };

  const handleWebCore = async (request, response, url) => {
    if (!authorized(request)) {
      send(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method === 'POST' && url.pathname === CONNECTIONS) {
      const connectionId = randomUUID();
      connections.set(connectionId, { events: [], streams: new Set() });
      send(response, 201, {
        connectionId,
        connectionToken: `cwc_${randomUUID()}`,
      });
      return;
    }
    const [connectionId, leg] = url.pathname
      .slice(CONNECTIONS.length + 1)
      .split('/');
    if (request.method === 'GET' && leg === 'events') {
      openEvents(request, response, connectionId);
      return;
    }
    if (request.method === 'DELETE') {
      const connection = connections.get(connectionId);
      for (const stream of connection?.streams ?? []) stream.end();
      connections.delete(connectionId);
      send(response, 200, {});
      return;
    }
    if (!connections.has(connectionId)) {
      send(response, 404, { error: 'No such connection.' });
      return;
    }
    const message = await readBody(request);
    if (message === null || message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const params = message.params ?? {};
    // An extra answer may settle later, as a slow web core does.
    const answer =
      message.method === INITIALIZE
        ? { result: initialize() }
        : await world.call(message.method, params);
    const subscriptionId = answer?.result?.subscriptionId;
    if (world.streams().includes(message.method) && subscriptionId)
      subscriptionOwners.set(subscriptionId, connectionId);
    send(response, 200, reply(message.id, answer));
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (
      url.pathname === CONNECTIONS ||
      url.pathname.startsWith(`${CONNECTIONS}/`)
    ) {
      await handleWebCore(request, response, url);
      return;
    }
    if (await handleCloudRequest(request, response, url)) return;
    send(response, 404, { error: 'Not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    /** The seeded world: its `state` records sends and answers. */
    world,
    close: () =>
      new Promise((resolve) => {
        for (const connection of connections.values())
          for (const stream of connection.streams) stream.end();
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

function writeEvent(response, event) {
  response.write(`id: ${event.id}\ndata: ${event.data}\n\n`);
}
