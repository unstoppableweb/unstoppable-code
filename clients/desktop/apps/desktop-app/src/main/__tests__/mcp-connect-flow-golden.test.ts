import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  getMcpHarnessInstallsFilePath,
  getMcpServerFilePath,
  getMcpServersIndexFilePath,
} from '../lib/paths';
import type { McpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
import type * as McpRefRewriteOutcome from '../mcp/server-ref-rewrite-outcome';
import type * as ToolDiscovery from '../mcp/tool-discovery';
import {
  forceMcpRemovalThroughCore,
  inspectMcpRemovalThroughCore,
} from '../canopy-runtime/mcp-removal-dispatch';
import { clearMcpOAuthToken } from '../mcp/oauth-token-store';
import { spawnMcpConnectionProbe } from '../mcp/connection-process';

it('preserves spawn output pipes and exit completion through the connection host adapter', async () => {
  const child = spawnMcpConnectionProbe(
    process.execPath,
    [
      '-e',
      'process.stdout.write("probe-out");process.stderr.write("probe-error")',
    ],
    { env: {} },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  expect(code).toBe(0);
  expect(stdout).toBe('probe-out');
  expect(stderr).toBe('probe-error');
});

jest.mock('../canopy-runtime/mcp-removal-dispatch', () => ({
  inspectMcpRemovalThroughCore: jest.fn(() =>
    Promise.resolve({ target: 'malformed' }),
  ),
  forceMcpRemovalThroughCore: jest.fn(() =>
    Promise.resolve({ status: 'unresolved' }),
  ),
}));

// Keep native presentation and unrelated runtime hosts outside this backend
// flow. MCP repository reads, inventory, declaration parsing and HTTP discovery
// run against production code and isolated on-disk/loopback fixtures.
jest.mock('../canopy-cloud/mcp-connections', () => ({}));
jest.mock('../mcp/account-catalog', () => ({
  accountMcpConnectionsEnabled: (): boolean => false,
  withAccountMcpInventory: (index: unknown): Promise<unknown> =>
    Promise.resolve(index),
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
  clearMcpOAuthToken: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/main-process-logging', () => ({}));
jest.mock('../lib/window-send', () => ({}));
jest.mock('../plugins/plugin-service', () => ({}));
jest.mock('../plugins/plugin-resolver', () => ({}));
jest.mock('../lib/open-external', () => ({}));
jest.mock('../mcp/provider-connectors', () => ({}));
jest.mock('../services/desktop-inventory-sync-signals', () => ({
  notifyDesktopInventoryChanged: jest.fn(),
}));
jest.mock('../installed-items/installed-item-events', () => ({
  notifyInstalledItemsChanged: jest.fn(),
}));
jest.mock('../mcp/curated-catalog', () => ({}));
jest.mock('../mcp/curated-plugin-binding', () => ({}));
// Logo resolution is out of scope; registering the handlers configures its
// disk cache.
const resolveRemoteImageDataUrl = jest.fn<
  Promise<string | null>,
  [url: unknown, enhanced?: boolean]
>(() => Promise.resolve(null));
jest.mock('../mcp/remote-image-cache', () => ({
  configureRemoteImageDiskCache: jest.fn(),
  resolveRemoteImageDataUrl: (
    url: unknown,
    enhanced?: boolean,
  ): Promise<string | null> => resolveRemoteImageDataUrl(url, enhanced),
}));
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
jest.mock('../mcp/server-ref-rewrite-outcome', () => ({
  ...jest.requireActual<typeof McpRefRewriteOutcome>(
    '../mcp/server-ref-rewrite-outcome',
  ),
  // Removal runs its steps through this phase marker; pass them through.
  inMcpRefRewritePhase: <T>(
    _phase: string,
    run: () => Promise<T>,
  ): Promise<T> => run(),
}));
// One Add for every harness (CAN-6815) confirms set-up harnesses itself;
// no harness runtime is installed here, so main confirms none of them.
jest.mock('../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => false,
}));
jest.mock('../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: (): boolean => false,
}));
jest.mock('../opencode/feature-flag', () => ({
  isOpenCodeHarnessEnabled: (): boolean => false,
}));
jest.mock('../auth/provider-auth-state', () => ({
  getCachedClaudeAuthStatusObserved: (): Promise<{ authenticated: boolean }> =>
    Promise.resolve({ authenticated: false }),
  getCachedCodexAuthStatusObserved: (): Promise<{ authenticated: boolean }> =>
    Promise.resolve({ authenticated: false }),
}));
jest.mock('../agents/user-supplied-credential', () => ({
  hasUserSuppliedProviderCredential: (): boolean => false,
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

// One Add for every harness (CAN-6815): the registered handlers stage the
// saved server through each harness's own adapter and record the result
// beside the index, which they never rewrite.
test('one Add installs a saved MCP server for every set-up harness and retries one (CAN-6815)', async () => {
  const registrations = jest.mocked(registerIpcHandler).mock.calls;
  const install = registrations.find(
    ([channel]) => channel === MCP_SERVER_CHANNELS.INSTALL_FOR_HARNESSES,
  )?.[1];
  const retry = registrations.find(
    ([channel]) => channel === MCP_SERVER_CHANNELS.RETRY_HARNESS_INSTALL,
  )?.[1];
  if (!install || !retry) throw new Error('Missing harness install handlers');
  const serverBefore = await readFile(getMcpServerFilePath(serverId), 'utf8');
  const harnesses = ['claude', 'codex', 'cursor', 'copilot', 'opencode'];
  const timeout = jest.spyOn(globalThis, 'setTimeout');
  const clear = jest.spyOn(globalThis, 'clearTimeout');
  let installed: unknown;
  try {
    installed = await Reflect.apply(install, undefined, [
      null,
      { serverId, configId, harnesses },
    ]);
    // Successful admission must release every readiness deadline.
    const deadlines = timeout.mock.calls.flatMap(([, delay], index) =>
      delay === 15_000 ? [timeout.mock.results[index]] : [],
    );
    expect(deadlines.length).toBeGreaterThan(0);
    for (const deadline of deadlines)
      expect(clear).toHaveBeenCalledWith(deadline.value);
  } finally {
    timeout.mockRestore();
    clear.mockRestore();
  }
  const statuses: Record<string, unknown> = {};
  for (const harness of harnesses)
    statuses[harness] = expect.objectContaining({ status: 'installed' });
  expect(installed).toEqual(
    expect.objectContaining({ configId, harnesses: statuses }),
  );
  // Staging hands adapters the URL alone: no request reaches the server, no
  // header leaves the server file, and the server file is not rewritten.
  expect(requests).toBe(1);
  expect(JSON.stringify(installed)).not.toContain('X-Context');
  expect(await readFile(getMcpServerFilePath(serverId), 'utf8')).toBe(
    serverBefore,
  );
  const retried: unknown = await Reflect.apply(retry, undefined, [
    null,
    { serverId, harness: 'cursor' },
  ]);
  const cursor: unknown = expect.objectContaining({ status: 'installed' });
  const retriedHarnesses: unknown = expect.objectContaining({ cursor });
  expect(retried).toEqual(
    expect.objectContaining({ harnesses: retriedHarnesses }),
  );
  await expect(
    Reflect.apply(install, undefined, [
      null,
      { serverId, configId, harnesses: ['antigravity'] },
    ]),
  ).rejects.toThrow();
});

test('ordinary IPC deletion refuses a damaged index before credentials or unlink, without escalation', async () => {
  const deleteServer = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(
      ([channel]) => channel === MCP_SERVER_CHANNELS.DELETE_SERVER,
    )?.[1];
  if (!deleteServer) throw new Error('Missing delete handler');
  const source = await readFile(getMcpServerFilePath(serverId), 'utf8');
  await writeFile(getMcpServersIndexFilePath(), '{');
  jest.mocked(clearMcpOAuthToken).mockClear();
  await expect(
    Reflect.apply(deleteServer, undefined, [null, serverId]),
  ).rejects.toMatchObject({ phase: 'preflight', effects: 'none' });
  expect(clearMcpOAuthToken).not.toHaveBeenCalled();
  expect(forceMcpRemovalThroughCore).not.toHaveBeenCalled();
  expect(await readFile(getMcpServerFilePath(serverId), 'utf8')).toBe(source);
  expect(await readFile(getMcpServersIndexFilePath(), 'utf8')).toBe('{');
});

test('dedicated repair IPC forwards exact options, independent of the damaged inventory, and rejects extras', async () => {
  const inspect = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(
      ([channel]) => channel === MCP_SERVER_CHANNELS.INSPECT_REMOVAL,
    )?.[1];
  const force = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(
      ([channel]) => channel === MCP_SERVER_CHANNELS.FORCE_REMOVAL,
    )?.[1];
  if (!inspect || !force) throw new Error('Missing dedicated repair handlers');
  await Reflect.apply(inspect, undefined, [null, { serverId }]);
  expect(inspectMcpRemovalThroughCore).toHaveBeenLastCalledWith({ serverId });
  const request = {
    serverId,
    mode: 'preserve-evidence',
    recoveryId: '11111111-1111-4111-8111-111111111111',
  };
  await Reflect.apply(force, undefined, [null, request]);
  expect(forceMcpRemovalThroughCore).toHaveBeenLastCalledWith(request);
  const calls = jest.mocked(forceMcpRemovalThroughCore).mock.calls.length;
  await expect(
    Reflect.apply(force, undefined, [
      null,
      { ...request, path: '/caller/path' },
    ]),
  ).rejects.toBeDefined();
  await expect(
    Reflect.apply(force, undefined, [
      null,
      { ...request, inspectedState: request.recoveryId },
    ]),
  ).rejects.toBeDefined();
  await expect(
    Reflect.apply(force, undefined, [
      null,
      { ...request, serverId: 'account:a1' },
    ]),
  ).rejects.toBeDefined();
  expect(forceMcpRemovalThroughCore).toHaveBeenCalledTimes(calls);
  jest.mocked(forceMcpRemovalThroughCore).mockClear();
});

test('the index serves the record, and removing the server removes it from every harness (CAN-6815)', async () => {
  const registrations = jest.mocked(registerIpcHandler).mock.calls;
  const loadIndex = registrations.find(
    ([channel]) => channel === MCP_SERVER_CHANNELS.LOAD_INDEX,
  )?.[1];
  const deleteServer = registrations.find(
    ([channel]) => channel === MCP_SERVER_CHANNELS.DELETE_SERVER,
  )?.[1];
  if (!loadIndex || !deleteServer)
    throw new Error('Missing MCP index or delete handler');
  const index = JSON.stringify({
    version: 1,
    servers: [
      {
        id: serverId,
        name: 'Fixture',
        description: '',
        type: 'http',
        configs: [{ id: configId, name: 'Default', enabled: true }],
        urlHost: '127.0.0.1',
        urlScheme: 'http',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  await writeFile(getMcpServersIndexFilePath(), index);
  const served: unknown = await Reflect.apply(loadIndex, undefined, [null]);
  const record: unknown = expect.objectContaining({ configId });
  expect(served).toEqual(
    expect.objectContaining({
      servers: [
        expect.objectContaining({ id: serverId, harnessInstalls: record }),
      ],
    }),
  );
  // Serving the record never writes it into the index.
  expect(await readFile(getMcpServersIndexFilePath(), 'utf8')).toBe(index);
  await Reflect.apply(deleteServer, undefined, [null, serverId]);
  const records: unknown = JSON.parse(
    await readFile(getMcpHarnessInstallsFilePath(), 'utf8'),
  );
  expect(records).toEqual({ version: 1, servers: {} });
  await rm(getMcpServersIndexFilePath(), { force: true });
});

// A logo resolves in the caller's mode: the renderer marks requests made
// while it shows New Customize, and anything else stays the plain path that
// older callers and the flag-off app use.
test("the logo channel forwards the caller's New Customize mode and defaults to the plain path", async () => {
  const resolve = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(
      ([channel]) => channel === MCP_SERVER_CHANNELS.RESOLVE_REMOTE_IMAGE,
    )?.[1];
  if (!resolve) throw new Error('Missing logo handler');
  resolveRemoteImageDataUrl.mockClear();
  await Reflect.apply(resolve, undefined, [null, 'https://a.test/logo.png']);
  await Reflect.apply(resolve, undefined, [
    null,
    'https://a.test/logo.png',
    { enhanced: true },
  ]);
  await Reflect.apply(resolve, undefined, [
    null,
    'https://a.test/logo.png',
    { enhanced: 'yes' },
  ]);
  expect(resolveRemoteImageDataUrl.mock.calls).toEqual([
    ['https://a.test/logo.png', false],
    ['https://a.test/logo.png', true],
    ['https://a.test/logo.png', false],
  ]);
});
