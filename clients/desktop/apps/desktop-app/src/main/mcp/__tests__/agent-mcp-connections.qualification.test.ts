import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  McpCredentialBroker,
  type McpCredentialOwner,
} from '@canopy/core-runtime/node/mcp-auth';
import type * as CanopyCloudClientModule from '../../canopy-cloud/client';

jest.mock('../../canopy-cloud/client', () => ({
  CanopyCloudClientError: jest.requireActual<typeof CanopyCloudClientModule>(
    '../../canopy-cloud/client',
  ).CanopyCloudClientError,
  resolveCanopyCloudCredentialContext: jest.fn(),
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));

import { resolveCanopyCloudCredentialContext } from '../../canopy-cloud/client';
import * as pendingAuthFailures from '../pending-auth-failures';
import { isAccountMcpReauthRequired } from '../account-route-status';
import {
  AgentMcpConnections,
  type AgentMcpRouteRegistration,
  type McpProxiedToolCallGate,
} from '../agent-mcp-connections';
import { AntigravityExternalToolSchemas } from '../../antigravity/external-mcp-schemas';
import { classifyMcpSchemaInput } from '@canopy/desktop-shared/node/opencode/schema-classification';
import type { McpSchemaInputCheck } from '@canopy/desktop-shared/node/opencode/schema-validation';

interface Subject {
  scope: string;
}

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface ClientResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

type UpstreamHandler = (req: RecordedRequest, res: ServerResponse) => void;

// Headers Node's HTTP client and server add on their own.
const TRANSPORT_HEADERS = new Set([
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'date',
]);

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address: AddressInfo | string | null = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function send(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: options.method ?? 'POST', headers: options.headers ?? {} },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function nonTransportHeaderNames(headers: IncomingHttpHeaders): string[] {
  return Object.keys(headers)
    .filter((name) => !TRANSPORT_HEADERS.has(name))
    .sort();
}

const TOOL_CALL = JSON.stringify({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'search', arguments: { q: 'x' } },
});

describe('agent MCP connections (CAN-4125)', () => {
  let upstream: Server;
  let upstreamBase: string;
  let upstreamRequests: RecordedRequest[];
  let upstreamHandler: UpstreamHandler;
  let front: Server;
  let frontBase: string;
  let connections: AgentMcpConnections;
  let broker: McpCredentialBroker<Subject>;
  const resolveToken = jest.fn<Promise<string | null>, [Subject]>();
  const invalidate = jest.fn<Promise<void>, [Subject, string, string]>();
  const owner: McpCredentialOwner<Subject> = {
    scopeOf: (subject) => subject.scope,
    resolve: (subject) => resolveToken(subject),
    invalidate: (subject, token, upstreamUrl) =>
      invalidate(subject, token, upstreamUrl),
  };

  const proxyUrl = (routeId: string): string =>
    `${frontBase}/mcp-proxy/${encodeURIComponent(routeId)}`;

  const route = (
    overrides: Partial<AgentMcpRouteRegistration> = {},
  ): AgentMcpRouteRegistration => ({
    sessionId: null,
    serverId: 'srv',
    configId: 'cfg',
    displayName: 'Server',
    upstreamUrl: `${upstreamBase}/mcp`,
    headers: {},
    oauthEnabled: false,
    ...overrides,
  });

  beforeEach(async () => {
    resolveToken.mockReset();
    jest.mocked(resolveCanopyCloudCredentialContext).mockReset();
    invalidate.mockReset();
    invalidate.mockResolvedValue(undefined);
    broker = new McpCredentialBroker<Subject>({ owner });
    upstreamRequests = [];
    upstreamHandler = (_req, res): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const recorded: RecordedRequest = {
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        upstreamRequests.push(recorded);
        upstreamHandler(recorded, res);
      });
    });
    upstreamBase = `http://127.0.0.1:${String(await listen(upstream))}`;
    connections = new AgentMcpConnections({
      proxyUrl,
      listening: (): boolean => true,
      credentials: broker,
    });
    front = createServer((req, res) => {
      const id = decodeURIComponent(
        new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '',
      );
      void connections.serve(req, res, id);
    });
    frontBase = `http://127.0.0.1:${String(await listen(front))}`;
  });

  afterEach(async () => {
    connections.clear();
    await close(front);
    await close(upstream);
  });

  it("forwards only safe headers and injects the route's credentials", async () => {
    upstreamHandler = (_req, res): void => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'upstream=secret',
        'x-upstream-private': 'hidden',
        'mcp-session-id': 'upstream-session',
      });
      res.end('{"ok":true}');
    };
    const id = await connections.register(
      route({ headers: { 'X-Api-Key': 'route-key' } }),
    );

    const response = await send(proxyUrl(id), {
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'mcp-session-id': 'client-session',
        cookie: 'client=secret',
        authorization: 'Bearer agent',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });

    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    const seen = upstreamRequests[0]?.headers ?? {};
    expect(nonTransportHeaderNames(seen)).toEqual([
      'accept',
      'content-type',
      'host',
      'mcp-session-id',
      'x-api-key',
    ]);
    expect(seen['x-api-key']).toBe('route-key');
    expect(seen['mcp-session-id']).toBe('client-session');
    expect(nonTransportHeaderNames(response.headers)).toEqual([
      'content-type',
      'mcp-session-id',
    ]);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['mcp-session-id']).toBe('upstream-session');
  });

  it('an account route sends the account key and refuses a route outside the configured cloud', async () => {
    jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue({
      apiKey: 'acct-key',
      baseUrl: upstreamBase,
    });
    const accountRoute = await connections.register(
      route({
        upstreamUrl: `${upstreamBase}/api/v1/mcp-proxy/r1`,
        authSupplier: 'canopy-cloud',
        headers: { Authorization: 'Bearer route-supplied' },
      }),
    );

    const ok = await send(proxyUrl(accountRoute), { body: '{}' });
    expect(ok.status).toBe(200);
    expect(upstreamRequests[0]?.headers.authorization).toBe('Bearer acct-key');

    const foreignOrigin = upstreamBase.replace('127.0.0.1', 'localhost');
    const foreign = await connections.register(
      route({
        upstreamUrl: `${foreignOrigin}/api/v1/mcp-proxy/r2`,
        authSupplier: 'canopy-cloud',
      }),
    );
    const refused = await send(proxyUrl(foreign), { body: '{}' });
    expect(refused.status).toBe(502);
    expect(JSON.parse(refused.body)).toEqual({
      error: 'account_route_unavailable',
    });
    expect(upstreamRequests).toHaveLength(1);

    jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue({
      apiKey: '',
      baseUrl: upstreamBase,
    });
    const signedOut = await send(proxyUrl(accountRoute), { body: '{}' });
    expect(signedOut.status).toBe(401);
    expect(JSON.parse(signedOut.body)).toEqual({
      error: 'mcp_reauth_required',
    });
    expect(connections.routeStatus(accountRoute)).toEqual({
      reauthRequired: true,
    });
    expect(upstreamRequests).toHaveLength(1);
  });

  it('a gated route never forwards without its live session gate', async () => {
    const id = await connections.register(
      route({ sessionId: 's', requireToolCallGate: true }),
    );

    const ungated = await send(proxyUrl(id), { body: TOOL_CALL });
    expect(JSON.parse(ungated.body)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Selected MCP route is unavailable.' },
    });
    expect(upstreamRequests).toHaveLength(0);

    const gate = jest.fn<
      ReturnType<McpProxiedToolCallGate>,
      Parameters<McpProxiedToolCallGate>
    >();
    gate.mockResolvedValue(false);
    connections.setSessionToolCallGate('s', gate);
    const denied = await send(proxyUrl(id), { body: TOOL_CALL });
    expect(JSON.parse(denied.body)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        content: [{ type: 'text', text: 'search was denied.' }],
        isError: true,
      },
    });
    expect(gate).toHaveBeenCalledWith({
      proxyUrl: proxyUrl(id),
      tool: 'search',
      args: { q: 'x' },
      requestId: '7',
    });

    const batched = await send(proxyUrl(id), {
      body: JSON.stringify([JSON.parse(TOOL_CALL)]),
    });
    expect(JSON.parse(batched.body)).toMatchObject({
      error: { code: -32600 },
    });
    expect(upstreamRequests).toHaveLength(0);

    gate.mockResolvedValue(true);
    await send(proxyUrl(id), { body: TOOL_CALL });
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.body).toBe(TOOL_CALL);

    // Without a tools/list transform (other harnesses), non-object arguments
    // keep their previous handling: the gate sees none, the body is unchanged.
    gate.mockClear();
    const nonObject = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'search', arguments: 'x' },
    });
    await send(proxyUrl(id), { body: nonObject });
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ args: {} }));
    expect(upstreamRequests[1]?.body).toBe(nonObject);

    gate.mockClear();
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    await send(proxyUrl(id), { body: notification });
    expect(gate).not.toHaveBeenCalled();
    expect(upstreamRequests[2]?.body).toBe(notification);
  });

  it('a gated route answers refusals with their text, rejects non-object arguments unforwarded, and lets only its session rewrite tools/list (CAN-6708)', async () => {
    const LOOKUP = {
      name: 'lookup',
      inputSchema: {
        type: 'object',
        properties: { w: { type: 'string', pattern: '^(?!bad)' } },
      },
    };
    upstreamHandler = (req, res): void => {
      const message: unknown = JSON.parse(req.body);
      const id =
        typeof message === 'object' && message !== null && 'id' in message
          ? message.id
          : null;
      const answer = JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { tools: [LOOKUP] },
      });
      if (req.headers.accept?.includes('text/event-stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\r\ndata: ${answer}\r\n\r\n`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(answer);
    };
    const gated = await connections.register(
      route({ sessionId: 's', requireToolCallGate: true }),
    );
    const ungated = await connections.register(route({ sessionId: 's' }));
    const gate = jest.fn<
      ReturnType<McpProxiedToolCallGate>,
      Parameters<McpProxiedToolCallGate>
    >();
    gate.mockResolvedValue({ refusal: 'The arguments do not match.' });
    connections.setSessionToolCallGate('s', gate);
    connections.setSessionToolListTransform(
      's',
      ({ proxyUrl: url, result }) => ({
        routed: url,
        original: result,
      }),
    );

    const refused = await send(proxyUrl(gated), { body: TOOL_CALL });
    expect(JSON.parse(refused.body)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        content: [{ type: 'text', text: 'The arguments do not match.' }],
        isError: true,
      },
    });
    gate.mockClear();
    for (const args of ['x', [1], 7]) {
      const invalid = await send(proxyUrl(gated), {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: { name: 'search', arguments: args },
        }),
      });
      expect(JSON.parse(invalid.body)).toEqual({
        jsonrpc: '2.0',
        id: 8,
        error: { code: -32600, message: 'Invalid MCP request.' },
      });
    }
    expect(gate).not.toHaveBeenCalled();
    expect(upstreamRequests).toHaveLength(0);
    // `null` reads as no arguments, as before this check existed.
    await send(proxyUrl(gated), {
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'search', arguments: null },
      }),
    });
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ args: {} }));
    gate.mockClear();

    const list = (id: number): string =>
      JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' });
    const json = await send(proxyUrl(gated), {
      headers: { accept: 'application/json' },
      body: list(1),
    });
    expect(JSON.parse(json.body)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { routed: proxyUrl(gated), original: { tools: [LOOKUP] } },
    });
    const sse = await send(proxyUrl(gated), {
      headers: { accept: 'application/json, text/event-stream' },
      body: list(2),
    });
    const data = sse.body.split('\n').find((line) => line.startsWith('data: '));
    expect(JSON.parse(data?.slice(6) ?? 'null')).toMatchObject({
      id: 2,
      result: { routed: proxyUrl(gated) },
    });
    expect(sse.body).toContain('event: message');

    const batched = await send(proxyUrl(gated), {
      body: JSON.stringify([JSON.parse(list(3))]),
    });
    expect(JSON.parse(batched.body)).toMatchObject({ error: { code: -32600 } });
    const plain = await send(proxyUrl(ungated), {
      headers: { accept: 'application/json' },
      body: list(4),
    });
    expect(JSON.parse(plain.body)).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { tools: [LOOKUP] },
    });
    expect(upstreamRequests).toHaveLength(3);

    connections.disconnectSession('s');
    const after = await connections.register(
      route({ sessionId: 's', requireToolCallGate: true }),
    );
    connections.setSessionToolCallGate('s', () => Promise.resolve(true));
    const unrewritten = await send(proxyUrl(after), {
      headers: { accept: 'application/json' },
      body: list(5),
    });
    expect(JSON.parse(unrewritten.body)).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: { tools: [LOOKUP] },
    });
  });

  it('an Antigravity selected server is advertised a projected schema, and only calls the upstream schema accepts reach it (CAN-6708)', async () => {
    const tools = [
      {
        name: 'lookup',
        inputSchema: {
          type: 'object',
          properties: {
            word: { type: 'string', pattern: '^(?!bad)[a-z]+$', maxLength: 8 },
          },
          required: ['word'],
        },
      },
      {
        name: 'plain',
        inputSchema: {
          type: 'object',
          properties: { word: { type: 'string', maxLength: 1 } },
        },
      },
      {
        // Omitting a pattern beneath `not` must not advertise `not: {}`.
        name: 'guarded',
        inputSchema: {
          type: 'object',
          properties: {
            word: { type: 'string', not: { pattern: '^(?=admin)' } },
          },
        },
      },
      {
        // agy 1.5.1 also rejects backreferences and lookbehind.
        name: 'pair',
        inputSchema: {
          type: 'object',
          properties: { word: { type: 'string', pattern: '^(a)\\1$' } },
        },
      },
    ];
    upstreamHandler = (req, res): void => {
      const message: unknown = JSON.parse(req.body);
      const record =
        typeof message === 'object' && message !== null ? message : {};
      const id = 'id' in record ? record.id : null;
      const result =
        'method' in record && record.method === 'tools/list'
          ? { tools }
          : { content: [{ type: 'text', text: 'ran' }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    const ledger = new AntigravityExternalToolSchemas((schema, input) =>
      Promise.resolve(
        classifyMcpSchemaInput({
          schema: JSON.stringify(schema),
          input: JSON.stringify(input),
        }),
      ),
    );
    const signal = new AbortController().signal;
    const id = await connections.register(
      route({ sessionId: 'agy', requireToolCallGate: true }),
    );
    connections.setSessionToolListTransform('agy', ({ cursor, result }) =>
      ledger.advertise('remote', {
        ...(cursor === undefined ? {} : { cursor }),
        result,
      }),
    );
    connections.setSessionToolCallGate('agy', async ({ tool, args }) => {
      const checked = await ledger.check('remote', tool, args, signal);
      return checked.ok ? true : { refusal: checked.refusal };
    });
    const call = (
      requestId: number,
      name: string,
      word: string,
    ): Promise<ClientResponse> =>
      send(proxyUrl(id), {
        headers: { accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method: 'tools/call',
          params: { name, arguments: { word } },
        }),
      });
    const refusal = async (
      response: Promise<ClientResponse>,
    ): Promise<string> => {
      const parsed: unknown = JSON.parse((await response).body);
      return JSON.stringify(parsed);
    };

    const listed = await send(proxyUrl(id), {
      headers: { accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listed.body).not.toContain('(?!');
    // Never stricter than the original: no emptied `not`.
    expect(listed.body).not.toContain('"not"');
    expect(listed.body).not.toContain('\\\\1');
    expect(JSON.parse(listed.body)).toMatchObject({
      result: {
        tools: [
          {
            name: 'lookup',
            inputSchema: { properties: { word: { maxLength: 8 } } },
          },
          tools[1],
          {
            name: 'guarded',
            inputSchema: { properties: { word: { type: 'string' } } },
          },
          { name: 'pair', inputSchema: { properties: { word: {} } } },
        ],
      },
    });
    expect(upstreamRequests).toHaveLength(1);

    expect(await refusal(call(2, 'lookup', 'badword'))).toContain(
      "The arguments do not match the tool's input schema.",
    );
    expect(await refusal(call(3, 'other', 'x'))).toContain(
      'This MCP server did not list that tool in this session.',
    );
    expect(await refusal(call(6, 'pair', 'ab'))).toContain(
      "The arguments do not match the tool's input schema.",
    );
    expect(await refusal(call(7, 'guarded', 'admin1'))).toContain(
      "The arguments do not match the tool's input schema.",
    );
    expect(upstreamRequests).toHaveLength(1);
    expect(JSON.parse((await call(4, 'lookup', 'good')).body)).toMatchObject({
      result: { content: [{ text: 'ran' }] },
    });
    // Relayed unchanged: the host adds no argument check, as before.
    expect(JSON.parse((await call(5, 'plain', 'long')).body)).toMatchObject({
      result: { content: [{ text: 'ran' }] },
    });
    expect(JSON.parse((await call(8, 'guarded', 'user')).body)).toMatchObject({
      result: { content: [{ text: 'ran' }] },
    });
    expect(upstreamRequests).toHaveLength(4);
  });

  it('an Antigravity selected call whose upstream schema cannot be evaluated is refused before approval and never forwarded (CAN-6708)', async () => {
    const lookup = {
      name: 'lookup',
      inputSchema: {
        type: 'object',
        properties: { word: { type: 'string', pattern: '^(?!bad)[a-z]+$' } },
      },
    };
    upstreamHandler = (req, res): void => {
      const message: unknown = JSON.parse(req.body);
      const record =
        typeof message === 'object' && message !== null ? message : {};
      const result =
        'method' in record && record.method === 'tools/list'
          ? { tools: [lookup] }
          : { content: [{ type: 'text', text: 'ran' }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'id' in record ? record.id : null,
          result,
        }),
      );
    };
    // Deterministic stand-ins for a failed worker, an unevaluable schema and a
    // timed-out or overflowing queue.
    const outcomes = new Map<string, McpSchemaInputCheck>([
      ['err', 'error'],
      ['uns', 'unsupported'],
      ['slow', 'unavailable'],
    ]);
    const ledger = new AntigravityExternalToolSchemas((_schema, input) => {
      const word =
        typeof input === 'object' && input !== null && 'word' in input
          ? input.word
          : undefined;
      return Promise.resolve(
        (typeof word === 'string' ? outcomes.get(word) : undefined) ?? 'valid',
      );
    });
    const approvals = jest.fn();
    const signal = new AbortController().signal;
    const id = await connections.register(
      route({ sessionId: 'agy', requireToolCallGate: true }),
    );
    connections.setSessionToolListTransform('agy', ({ result }) =>
      ledger.advertise('remote', { result }),
    );
    connections.setSessionToolCallGate('agy', async ({ tool, args }) => {
      const checked = await ledger.check('remote', tool, args, signal);
      if (!checked.ok) return { refusal: checked.refusal };
      approvals();
      return true;
    });
    const post = (body: unknown): Promise<ClientResponse> =>
      send(proxyUrl(id), {
        headers: { accept: 'application/json' },
        body: JSON.stringify(body),
      });
    await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const texts: string[] = [];
    for (const word of ['err', 'uns', 'slow']) {
      const answer = await post({
        jsonrpc: '2.0',
        id: word,
        method: 'tools/call',
        params: { name: 'lookup', arguments: { word } },
      });
      const parsed: unknown = JSON.parse(answer.body);
      expect(parsed).toMatchObject({ id: word, result: { isError: true } });
      texts.push(answer.body);
    }
    expect(texts[0]).toContain("couldn't be checked");
    expect(texts[1]).toContain("can't be checked here");
    expect(texts[2]).toContain("couldn't be checked");
    expect(approvals).not.toHaveBeenCalled();
    expect(upstreamRequests).toHaveLength(1);

    await post({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'lookup', arguments: { word: 'good' } },
    });
    expect(approvals).toHaveBeenCalledTimes(1);
    expect(upstreamRequests).toHaveLength(2);
  });

  it('a tools/list answered 202 is rewritten where its response arrives, on the session GET stream (CAN-6708)', async () => {
    const lookup = {
      name: 'lookup',
      inputSchema: {
        type: 'object',
        properties: { word: { type: 'string', pattern: '^(?!bad)' } },
      },
    };
    let stream: ServerResponse | undefined;
    upstreamHandler = (req, res): void => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': open\n\n');
        stream = res;
        return;
      }
      const message: unknown = JSON.parse(req.body);
      const id =
        typeof message === 'object' && message !== null && 'id' in message
          ? message.id
          : null;
      res.writeHead(202);
      res.end();
      stream?.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })}\n\n`,
      );
      stream?.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [lookup] } })}\n\n`,
      );
      stream?.end();
    };
    const id = await connections.register(
      route({ sessionId: 'agy', requireToolCallGate: true }),
    );
    connections.setSessionToolCallGate('agy', () => Promise.resolve(true));
    const advertised: unknown[] = [];
    connections.setSessionToolListTransform('agy', ({ result }) => {
      advertised.push(result);
      return { projected: result };
    });
    const opened = send(proxyUrl(id), {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });
    for (let attempt = 0; attempt < 100 && !stream; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const accepted = await send(proxyUrl(id), {
      headers: { accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(accepted.status).toBe(202);
    const events = (await opened).body.split('\n\n').filter(Boolean);
    expect(events[0]).toBe(': open');
    expect(events[1]).toContain('notifications/message');
    const data = events[2]
      ?.split('\n')
      .find((line) => line.startsWith('data: '));
    expect(JSON.parse(data?.slice(6) ?? 'null')).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { projected: { tools: [lookup] } },
    });
    expect(advertised).toHaveLength(1);
  });

  it('disconnecting a session removes every route it owns and nothing else', async () => {
    const clearSpy = jest.spyOn(
      pendingAuthFailures,
      'clearPendingAuthFailures',
    );
    const first = await connections.register(
      route({
        sessionId: 's1',
        oauthEnabled: true,
        credential: broker.bind({ scope: 'd/c' }),
      }),
    );
    const second = await connections.register(
      route({
        sessionId: 's1',
        oauthEnabled: true,
        credential: broker.bind({ scope: 'd/c' }),
      }),
    );
    const other = await connections.register(route({ sessionId: 's2' }));
    const probe = await connections.register(route({ sessionId: null }));
    const bound = broker.size;

    connections.disconnectSession('s1');
    expect(broker.size).toBe(bound - 2);

    expect((await send(proxyUrl(first), { body: '{}' })).status).toBe(404);
    expect((await send(proxyUrl(second), { body: '{}' })).status).toBe(404);
    expect((await send(proxyUrl(other), { body: '{}' })).status).toBe(200);
    expect((await send(proxyUrl(probe), { body: '{}' })).status).toBe(200);
    expect(clearSpy).toHaveBeenCalledWith('s1');

    connections.setSessionToolCallGate('s1', () => Promise.resolve(true));
    connections.disconnectSession('s1');
    const gated = await connections.register(
      route({ sessionId: 's1', requireToolCallGate: true }),
    );
    const unavailable = await send(proxyUrl(gated), { body: TOOL_CALL });
    expect(JSON.parse(unavailable.body)).toMatchObject({
      error: { code: -32000, message: 'Selected MCP route is unavailable.' },
    });
    connections.setSessionToolCallGate('s1', () => Promise.resolve(true));
    expect((await send(proxyUrl(gated), { body: TOOL_CALL })).status).toBe(200);
    clearSpy.mockRestore();
  });

  it('an OAuth route answers 401 without a token, 503 when the token read fails, and invalidates a rejected token before relaying it', async () => {
    const subject: Subject = { scope: 'd/c' };
    const id = await connections.register(
      route({
        oauthEnabled: true,
        credential: broker.bind(subject),
      }),
    );

    resolveToken.mockResolvedValue(null);
    const missing = await send(proxyUrl(id), { body: '{}' });
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.body)).toMatchObject({ error: { code: -32001 } });

    resolveToken.mockRejectedValue(new Error('store unreadable'));
    const unavailable = await send(proxyUrl(id), { body: '{}' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers['retry-after']).toBe('30');
    expect(upstreamRequests).toHaveLength(0);

    resolveToken.mockResolvedValue('tok');
    await send(proxyUrl(id), { body: '{}' });
    expect(upstreamRequests[0]?.headers.authorization).toBe('Bearer tok');

    const order: string[] = [];
    invalidate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            order.push('invalidated');
            resolve();
          }, 50);
        }),
    );
    upstreamHandler = (_req, res): void => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_token"}');
    };
    const rejected = await send(proxyUrl(id), { body: '{}' });
    order.push('client');
    expect(rejected.status).toBe(401);
    expect(invalidate).toHaveBeenCalledWith(
      subject,
      'tok',
      `${upstreamBase}/mcp`,
    );
    expect(order).toEqual(['invalidated', 'client']);
  });

  it('register refuses non-HTTP upstreams and a gated route without a session', async () => {
    await expect(
      connections.register(route({ upstreamUrl: 'ftp://127.0.0.1/mcp' })),
    ).rejects.toThrow('MCP proxy only supports HTTP and HTTPS upstream URLs.');
    await expect(
      connections.register(
        route({ sessionId: null, requireToolCallGate: true }),
      ),
    ).rejects.toThrow('A gated MCP route requires a session.');
    expect(connections.size).toBe(0);
  });

  it('start, port change and shutdown keep their routes and statuses as before', async () => {
    const { McpHttpProxyService } = await import('../http-proxy-service');
    const freePort = async (): Promise<number> => {
      const probe = createServer();
      const port = await listen(probe);
      await close(probe);
      return port;
    };
    const p1 = await freePort();
    const p2 = await freePort();
    const p3 = await freePort();
    const service = new McpHttpProxyService();
    try {
      await service.ensureStarted(p1);
      expect(service.getState().status).toBe('running');

      const id = await service.registerRoute(route());
      const accountId = await service.registerRoute(
        route({
          upstreamUrl: `${upstreamBase}/api/v1/mcp-proxy/acct`,
          authSupplier: 'canopy-cloud',
        }),
      );
      jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue({
        apiKey: '',
        baseUrl: upstreamBase,
      });
      await send(service.getProxyUrl(accountId), { body: '{}' });
      expect(isAccountMcpReauthRequired('srv', 'cfg')).toBe(true);

      expect((await send(service.getProxyUrl(id), { body: '{}' })).status).toBe(
        200,
      );

      await service.updatePort(p2);
      expect(service.getPort()).toBe(p2);
      expect(service.getProxyUrl(id)).toContain(`:${String(p2)}/`);
      expect((await send(service.getProxyUrl(id), { body: '{}' })).status).toBe(
        200,
      );

      await service.ensureStarted(p3);
      expect(service.getPort()).toBe(p2);

      const health = await send(`http://127.0.0.1:${String(p2)}/health`, {
        method: 'GET',
      });
      expect(JSON.parse(health.body)).toMatchObject({ routeCount: 2 });

      await service.shutdown();
      expect(service.getState().status).toBe('stopped');
      expect(service.getRouteStatus(id)).toBeUndefined();
      expect(isAccountMcpReauthRequired('srv', 'cfg')).toBe(false);
    } finally {
      await service.shutdown();
    }
  }, 60_000);
});
