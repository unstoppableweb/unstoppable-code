import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getMcpServerFilePath } from '../lib/paths';
import type { McpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
import type * as ToolDiscovery from '../mcp/tool-discovery';

// Keep native presentation and unrelated runtime hosts outside this backend
// flow. MCP repository reads, inventory, declaration parsing and HTTP discovery
// run against production code and isolated on-disk/loopback fixtures.
jest.mock('../canopy-cloud/mcp-connections', () => ({}));
jest.mock('../mcp/account-catalog', () => ({
  accountMcpConnectionsEnabled: (): boolean => false,
  normalizeAccountMcpSelections: (selections: unknown): Promise<unknown> =>
    Promise.resolve(selections),
}));
jest.mock('../mcp/account-routing', () => ({
  readMcpAccountIndexEntry: (): Promise<undefined> =>
    Promise.resolve(undefined),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  subscribeCanopyCloudAccountChanges: jest.fn(),
}));
jest.mock('../mcp/server-ref-rewrite', () => ({}));
jest.mock('../mcp/server-secret-view', () => ({}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn().mockResolvedValue({
    mcpHttpAuthDefaultHandler: 'canopy',
    mcpProxyPort: 4321,
  }),
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    setWindowAccessor: jest.fn(),
    setBroadcastHandlers: jest.fn(),
    refreshPreferredPortStatus: jest.fn(),
    ensureStarted: (): never => {
      throw new Error('No-auth Connect must not start the proxy');
    },
  })),
}));
jest.mock('../lib/auth-failure-resume', () => ({}));
jest.mock('../mcp/oauth-client', () => ({
  setMcpOAuthSettledListener: jest.fn(),
  startMcpOAuthFlow: (): never => {
    throw new Error('No-auth Connect must not open a browser');
  },
}));
jest.mock('../mcp/oauth-token-store', () => ({
  setMcpOAuthTokensChangedListener: jest.fn(),
  getMcpOAuthAuthStatusForDefinition: jest.fn().mockResolvedValue({
    status: 'not_connected',
    hasStoredToken: false,
  }),
  getMcpOAuthTokenRevision: jest.fn().mockResolvedValue(0),
}));
jest.mock('../lib/main-process-logging', () => ({}));
jest.mock('../lib/window-send', () => ({}));
jest.mock('../plugins/plugin-service', () => ({}));
jest.mock('../plugins/plugin-resolver', () => ({}));
jest.mock('../lib/open-external', () => ({}));
jest.mock('../mcp/provider-connectors', () => ({}));
jest.mock('../services/desktop-inventory-sync-signals', () => ({}));
jest.mock('../mcp/curated-catalog', () => ({}));
jest.mock('../mcp/curated-plugin-binding', () => ({}));
jest.mock('../mcp/remote-image-cache', () => ({}));
// A connection test's tools reach the Tools table through this cache.
jest.mock('../mcp/tool-discovery', () => ({
  mergeConfigIntoDefinition: jest.requireActual<typeof ToolDiscovery>(
    '../mcp/tool-discovery',
  ).mergeConfigIntoDefinition,
  mcpToolsSourceFingerprint: jest.fn().mockResolvedValue('fixture'),
  writeMcpToolsCacheEntry: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../mcp/connection-status', () => ({
  getMcpServerHealth: jest.fn(),
  getMcpServerHealthGeneration: (): number => 0,
  recordMcpServerHealth: (): boolean => false,
}));
jest.mock('../agents/session-manager', () => ({
  refreshCodexSessionsAfterMcpOAuth: (): never => {
    throw new Error('No-auth Connect must not refresh agent sessions');
  },
}));
jest.mock('../mcp/server-ref-rewrite-outcome', () => ({}));
jest.mock('../portal/adapters/mcp-adapter', () => ({
  refreshProjectedPortalMcpServers: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

import { registerIpcHandler } from '../ipc/register';
import { registerMcpServerHandlers } from '../ipc/mcp-servers';
import { writeMcpToolsCacheEntry } from '../mcp/tool-discovery';

let server: Server;
let requests = 0;
let endpoint = '';
const serverId = 'ca5704';
const configId = 'def';

beforeAll(async () => {
  server = createServer((request, response) => {
    requests++;
    if (
      request.method !== 'POST' ||
      request.headers['x-context'] !== 'config'
    ) {
      response.writeHead(400).end();
      return;
    }
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'fixture', version: '1' },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing loopback fixture address');
  endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const timestamp = '2026-01-01T00:00:00.000Z';
  const file: McpServerFile = {
    version: 1,
    server: {
      definition: {
        id: serverId,
        name: 'Fixture',
        description: '',
        type: 'http',
        url: endpoint,
        headers: { 'X-Context': 'definition' },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      configs: [
        {
          id: configId,
          name: 'Default',
          description: '',
          enabled: true,
          envVars: {},
          extraArgs: [],
          extraHeaders: { 'X-Context': 'config' },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  };
  const filename = getMcpServerFilePath(serverId);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(file));
  registerMcpServerHandlers(() => null);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(getMcpServerFilePath(serverId), { force: true });
});

test('a persisted HTTP MCP server connects without OAuth and passive inventory never contacts it', async () => {
  const registrations = jest.mocked(registerIpcHandler).mock.calls;
  const list = registrations.find(
    ([channel]) => channel === MCP_SERVER_CHANNELS.LIST_DETECTED,
  )?.[1];
  const start = registrations.find(
    ([channel]) => channel === MCP_SERVER_CHANNELS.START_OAUTH_LOGIN,
  )?.[1];
  if (!list || !start)
    throw new Error('Missing MCP inventory or Connect handler');
  const selections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [{ serverId, configId }],
  };
  // These are the registered IPC boundaries, invoked with the same payloads as
  // the desktop preload. A no-auth result must never imply connection health.
  const before: unknown = await Reflect.apply(list, undefined, [
    null,
    { selections },
  ]);
  expect(before).toEqual(
    expect.objectContaining({
      servers: [
        expect.objectContaining({
          authStatus: 'not_configured',
          canConnect: true,
        }),
      ],
    }),
  );
  expect(requests).toBe(0);
  expect(
    await Reflect.apply(start, undefined, [
      null,
      { serverId, configId, force: true },
    ]),
  ).toEqual({
    status: 'completed',
  });
  const after: unknown = await Reflect.apply(list, undefined, [
    null,
    { selections },
  ]);
  expect(after).toEqual(
    expect.objectContaining({
      servers: [
        expect.objectContaining({
          authStatus: 'not_configured',
          canConnect: false,
        }),
      ],
    }),
  );
  expect(requests).toBe(1);
});

// MCP's stdio transport is newline-delimited JSON-RPC, one message per line
// (CAN-6510). This server answers only that framing, pages its tools, and
// refuses tools/list before the client's initialized notification, as the
// official SDK's StdioServerTransport servers expect.
const STDIO_SERVER = `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let initialized = false;
const stallTools = process.argv.includes('--stall-tools');
const pingFirst = process.argv.includes('--ping-first');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // Like the SDK's transport: report nothing, keep reading.
  }
  if (message.method === 'initialize')
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    } });
  else if (message.method === 'notifications/initialized') initialized = true;
  else if (message.method === 'tools/list' && !stallTools) {
    // A server request may reuse the id of the client's pending request.
    if (pingFirst) send({ jsonrpc: '2.0', id: message.id, method: 'ping' });
    send(initialized
      ? { jsonrpc: '2.0', id: message.id, result: message.params.cursor
          ? { tools: [{ name: 'second' }] }
          : { tools: [{ name: 'first' }], nextCursor: 'page-2' } }
      : { jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'Not initialized' } });
  }
});
`;

async function testStdioServer(
  stdioServerId: string,
  serverArgs: readonly string[],
): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-stdio-'));
  const script = join(directory, 'server.cjs');
  await writeFile(script, STDIO_SERVER);
  const timestamp = '2026-01-01T00:00:00.000Z';
  const file: McpServerFile = {
    version: 1,
    server: {
      definition: {
        id: stdioServerId,
        name: 'Stdio fixture',
        description: '',
        type: 'command',
        command: 'node',
        args: [script, ...serverArgs],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      configs: [
        {
          id: configId,
          name: 'Default',
          description: '',
          enabled: true,
          envVars: {},
          extraArgs: [],
          extraHeaders: {},
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  };
  const filename = getMcpServerFilePath(stdioServerId);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(file));
  try {
    const test = jest
      .mocked(registerIpcHandler)
      .mock.calls.find(
        ([channel]) => channel === MCP_SERVER_CHANNELS.TEST_CONNECTION,
      )?.[1];
    if (!test) throw new Error('Missing MCP connection test handler');
    return await Reflect.apply(test, undefined, [
      null,
      stdioServerId,
      configId,
    ]);
  } finally {
    await rm(filename, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

test('a command MCP server connects over newline-delimited stdio and its tools reach the Tools table (CAN-6510)', async () => {
  const result = await testStdioServer('c65100', []);
  expect(result).toEqual(
    expect.objectContaining({
      success: true,
      tools: ['first', 'second'],
    }),
  );
  expect(jest.mocked(writeMcpToolsCacheEntry)).toHaveBeenCalledWith(
    'c65100',
    configId,
    expect.objectContaining({ tools: ['first', 'second'] }),
  );
}, 30_000);

// A server that initialized is reachable even when its tool list stalls, so
// Health shows a tool-discovery failure, not Unreachable.
test('a command MCP server whose tools/list stalls after initialize stays reachable (CAN-6510)', async () => {
  const result = await testStdioServer('c65101', ['--stall-tools']);
  expect(result).toEqual(
    expect.objectContaining({
      success: false,
      message: 'MCP tools/list failed',
      endpointReachable: true,
    }),
  );
}, 30_000);

// A server's own request can reuse the id of the client's pending request;
// only a response (result or error, no method) answers it.
test('a command MCP server request that reuses a pending id is not read as the response (CAN-6510)', async () => {
  const result = await testStdioServer('c65102', ['--ping-first']);
  expect(result).toEqual(
    expect.objectContaining({
      success: true,
      tools: ['first', 'second'],
    }),
  );
}, 30_000);
