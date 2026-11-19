/**
 * Several accounts per connector reach the desktop settings and pickers
 * (CAN-6226). The registered `mcp-servers:list-account-connections` handler
 * passes each account's label and default flag through to the renderer, so
 * two accounts of one connector can be told apart and the default shows.
 * `mcp-servers:remove-account` removes one, and lets a sign-in's own cleanup
 * keep an account that connected meanwhile.
 */
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
import type { AccountMcpConnection } from '@canopy/execution-engine/types/mcp-servers';
import type * as ToolDiscovery from '../mcp/tool-discovery';

const cloudRows: AccountMcpConnection[] = [
  {
    id: 'a',
    serverKey: 'slack',
    configId: 'default',
    kind: 'CURATED',
    displayName: 'Slack',
    status: 'CONNECTED',
    routeId: 'route-a',
    enabledTools: null,
    label: 'acme',
    isDefault: false,
  },
  {
    id: 'b',
    serverKey: 'slack',
    configId: 'acct-b',
    kind: 'CURATED',
    displayName: 'Slack',
    status: 'CONNECTED',
    routeId: 'route-b',
    enabledTools: null,
    label: 'globex',
    isDefault: true,
  },
  // An older cloud sends neither field.
  {
    id: 'c',
    serverKey: 'linear',
    configId: 'default',
    kind: 'CURATED',
    displayName: 'Linear',
    status: 'CONNECTED',
    routeId: 'route-c',
    enabledTools: null,
  },
];

// What the cloud client was asked to send; never a real request.
const sent: { start: unknown[]; update: unknown[]; remove: unknown[] } = {
  start: [],
  update: [],
  remove: [],
};
jest.mock('../canopy-cloud/mcp-connections', () => ({
  listAccountMcpConnections: (): Promise<AccountMcpConnection[]> =>
    Promise.resolve(cloudRows),
  invalidateAccountMcpConnections: (): void => undefined,
  accountMcpConnectionsChanged: (): void => undefined,
  startAccountMcpConnection: (request: unknown): Promise<unknown> => {
    sent.start.push(request);
    events.push('start');
    return Promise.resolve({ authorizationUrl: 'https://auth.example.test/' });
  },
  updateAccountMcpConnection: (
    id: string,
    request: unknown,
  ): Promise<AccountMcpConnection | undefined> => {
    sent.update.push({ id, request });
    return Promise.resolve(cloudRows[0]);
  },
  removeAccountMcpConnection: (
    id: string,
    options: unknown,
  ): Promise<{ removed: boolean }> => {
    sent.remove.push({ id, options });
    return Promise.resolve({ removed: true });
  },
}));
jest.mock('../mcp/account-catalog', () => ({
  accountMcpConnectionsEnabled: (): boolean => true,
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
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));
jest.mock('../installed-items/installed-item-events', () => ({
  notifyInstalledItemsChanged: jest.fn(),
}));
jest.mock('../plugins/plugin-service', () => ({}));
jest.mock('../plugins/plugin-resolver', () => ({}));
jest.mock('../lib/open-external', () => ({}));
jest.mock('../mcp/provider-connectors', () => ({}));
jest.mock('../services/desktop-inventory-sync-signals', () => ({}));
jest.mock('../mcp/curated-catalog', () => ({}));
jest.mock('../mcp/curated-plugin-binding', () => ({}));
jest.mock('../mcp/remote-image-cache', () => ({
  configureRemoteImageDiskCache: jest.fn(),
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
jest.mock('../mcp/server-ref-rewrite-outcome', () => ({}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
// The order of clearing the app's own sign-in page and starting a sign-in.
const events: string[] = [];
jest.mock('../browser/mcp-oauth-session', () => ({
  clearMcpOAuthBrowserSession: (): Promise<void> => {
    events.push('clear');
    return Promise.resolve();
  },
}));

import { registerIpcHandler } from '../ipc/register';
import { registerMcpServerHandlers } from '../ipc/mcp-servers';
import { mergeCatalogAccountMcpServers } from '../services/catalog-account-mcp-rows';
import type { AccountMcpConnection as CloudAccountMcpConnection } from '@canopy/protocol/mcp-servers';

registerMcpServerHandlers(() => null);
type RegisteredHandler = Parameters<typeof registerIpcHandler>[1];
function handlerFor(channel: string): RegisteredHandler {
  const handler = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([registered]) => registered === channel)?.[1];
  if (!handler) throw new Error(`Missing ${channel} handler`);
  return handler;
}

test('each account keeps its label and default flag on the way to the renderer', async () => {
  const handler = handlerFor(MCP_SERVER_CHANNELS.LIST_ACCOUNT_CONNECTIONS);
  const listed: unknown = await Reflect.apply(handler, undefined, [null]);
  expect(listed).toEqual([
    expect.objectContaining({ id: 'a', label: 'acme', isDefault: false }),
    expect.objectContaining({ id: 'b', label: 'globex', isDefault: true }),
    expect.objectContaining({ id: 'c' }),
  ]);
  // An older cloud's row gains no label or default it never sent.
  if (!Array.isArray(listed)) throw new Error('Expected a list');
  const older: unknown = listed[2];
  expect(older).not.toHaveProperty('label');
  expect(older).not.toHaveProperty('isDefault');
  // Never the proxy route or tool policy.
  expect(JSON.stringify(listed)).not.toContain('route-');
});

test('adding another account sends its name with a fresh configuration', async () => {
  const start = handlerFor(MCP_SERVER_CHANNELS.START_ACCOUNT);
  await Reflect.apply(start, undefined, [
    null,
    { serverKey: 'slack', configId: 'acct-abc123', label: '  globex  ' },
  ]);
  expect(sent.start).toContainEqual(
    expect.objectContaining({
      serverKey: 'slack',
      configId: 'acct-abc123',
      label: 'globex',
    }),
  );
  // A blank name is refused before anything is sent.
  await expect(
    Reflect.apply(start, undefined, [
      null,
      { serverKey: 'slack', configId: 'acct-def456', label: '   ' },
    ]),
  ).rejects.toThrow();
  expect(sent.start).toHaveLength(1);
});

test('another account signs in on a cleared app page, so the provider asks who to sign in as', async () => {
  const start = handlerFor(MCP_SERVER_CHANNELS.START_ACCOUNT);
  events.length = 0;
  await Reflect.apply(start, undefined, [
    null,
    {
      serverKey: 'linear',
      configId: 'acct-xyz789',
      label: 'globex',
      browser: 'embedded',
    },
  ]);
  // Cleared before the sign-in starts, never after.
  expect(events).toEqual(['clear', 'start']);
  // The first account, or a sign-in in the person's browser, keeps the page.
  events.length = 0;
  await Reflect.apply(start, undefined, [
    null,
    { serverKey: 'linear', configId: 'default', browser: 'embedded' },
  ]);
  await Reflect.apply(start, undefined, [
    null,
    { serverKey: 'linear', configId: 'acct-uvw456', label: 'initech' },
  ]);
  expect(events).toEqual(['start', 'start']);
});

test('renaming an account and making it the default edit it in place', async () => {
  const update = handlerFor(MCP_SERVER_CHANNELS.UPDATE_ACCOUNT);
  const id = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  await Reflect.apply(update, undefined, [null, id, { label: 'acme west' }]);
  await Reflect.apply(update, undefined, [null, id, { label: null }]);
  await Reflect.apply(update, undefined, [null, id, { isDefault: true }]);
  expect(sent.update).toEqual([
    { id, request: { label: 'acme west' } },
    { id, request: { label: null } },
    { id, request: { isDefault: true } },
  ]);
  // Only `true` makes an account the default; nothing else is sent.
  await expect(
    Reflect.apply(update, undefined, [null, id, { isDefault: false }]),
  ).rejects.toThrow();
  expect(sent.update).toHaveLength(3);
});

test('removing an account, and a sign-in cleaning up the one it added', async () => {
  const remove = handlerFor(MCP_SERVER_CHANNELS.REMOVE_ACCOUNT);
  const id = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  // Remove on an account row deletes it outright.
  await Reflect.apply(remove, undefined, [null, id]);
  // A failed added account's cleanup asks the cloud to keep it if the
  // sign-in connected meanwhile.
  await Reflect.apply(remove, undefined, [null, id, { unlessConnected: true }]);
  expect(sent.remove).toEqual([
    { id, options: {} },
    { id, options: { unlessConnected: true } },
  ]);
  // Nothing else rides along.
  await expect(
    Reflect.apply(remove, undefined, [null, id, { force: true }]),
  ).rejects.toThrow();
  expect(sent.remove).toHaveLength(2);
});

test('the Portal catalog names each hosted account of a connector the person holds several of', () => {
  const account = (
    id: string,
    configId: string,
    label: string,
    isDefault: boolean,
  ): CloudAccountMcpConnection => ({
    id,
    serverKey: 'slack',
    configId,
    kind: 'CURATED',
    displayName: 'Slack',
    status: 'CONNECTED',
    routeId: `route-${id}`,
    enabledTools: null,
    label,
    isDefault,
  });
  const accounts = [
    account('a', 'default', 'acme', true),
    account('b', 'acct-b', 'globex', false),
  ];
  // A desktop with no device index still lists each hosted account.
  expect(mergeCatalogAccountMcpServers([], [], accounts)).toEqual([
    expect.objectContaining({
      configId: 'default',
      configName: 'acme',
      connectionId: 'a',
      accountIsDefault: true,
    }),
    expect.objectContaining({
      configId: 'acct-b',
      configName: 'globex',
      connectionId: 'b',
      accountIsDefault: false,
    }),
  ]);
  // A connector the device lists runs its device configs, so no hosted
  // account is offered or named for it, even with that config disabled.
  const device = {
    serverId: 'slack',
    configId: 'default',
    serverName: 'Slack',
    configName: 'Default',
    description: 'Team chat',
    transport: 'http' as const,
  };
  expect(mergeCatalogAccountMcpServers([device], ['slack'], accounts)).toEqual([
    device,
  ]);
  expect(mergeCatalogAccountMcpServers([], ['slack'], accounts)).toEqual([]);
  // One account changes nothing.
  expect(mergeCatalogAccountMcpServers([], [], [accounts[0]])).toEqual([]);
});
