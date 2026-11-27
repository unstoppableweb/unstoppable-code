import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AccountMcpConnection } from '@canopy/execution-engine/types/mcp-servers';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { CodexRuntimeService } from '@canopy/execution-engine/node/codex-runtime/runtime-service';
import type { CodexPromptRunnerRequest } from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  accountMcpCatalogKeyForUrl,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';

let mockDataDir = '';
/** The cached catalog's Linear connector, read by the catalog mock. */
const mockLinearEntry: CuratedMcpServerEntry = {
  key: 'linear',
  name: 'Linear',
  shortDescription: '',
  url: 'https://mcp.linear.app/mcp',
  transport: 'http',
  categories: [],
  popular: false,
  sortOrder: 1,
  updatedAt: '2026-11-01T00:00:00.000Z',
};
let mockConnections: AccountMcpConnection[] = [];
let mockCollectionMcp: { serverId: string; configId: string }[] = [];
/** The folder of the third-party marketplace that holds the Linear plugin. */
let mockMarketDir = '';
/** When set, the cached connector catalog can't be read. */
let mockCatalogUnreadable = false;
/** When set, the account connection list can't be read. */
let mockConnectionsUnreadable = false;
/** Connection ids whose cloud proxy route can't be resolved. */
let mockUnroutable = new Set<string>();

// Server files resolve under the temporary data folder too: the real helper
// reads the module's own data-folder function, which this mock can't reach.
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getDataDir: (): string => mockDataDir,
  getMcpServerFilePath: (serverId: string): string =>
    `${mockDataDir}/mcp-servers/server-${serverId}.json`,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../../collections/collection-store', () => ({
  ...jest.requireActual<object>('../../collections/collection-store'),
  readCollectionConfig: (): Promise<{
    version: 2;
    collection: {
      skills: never[];
      plugins: never[];
      mcpServers: { serverId: string; configId: string }[];
    };
  }> =>
    Promise.resolve({
      version: 2,
      collection: { skills: [], plugins: [], mcpServers: mockCollectionMcp },
    }),
}));
jest.mock('../../mcp/account-catalog', () => ({
  ...jest.requireActual<object>('../../mcp/account-catalog'),
  accountMcpConnectionsEnabled: (): boolean => true,
  loadAccountMcpRefConnections: (): Promise<AccountMcpConnection[] | null> =>
    Promise.resolve(
      mockConnectionsUnreadable ? null : structuredClone(mockConnections),
    ),
}));
jest.mock('../../mcp/curated-catalog', () => ({
  ...jest.requireActual<object>('../../mcp/curated-catalog'),
  readCachedCuratedMcpDesktopOnlyKeys: (): Promise<ReadonlySet<string>> =>
    Promise.resolve(new Set<string>()),
  readCachedCuratedMcpServerEntries: (): Promise<
    CuratedMcpServerEntry[] | null
  > => Promise.resolve(mockCatalogUnreadable ? null : [mockLinearEntry]),
}));
// A plugin's own sign-in probes its server; nothing here reaches the network.
jest.mock('../../mcp/oauth-probe', () => ({
  probeMcpHttpOAuthRequirement: (): Promise<unknown> =>
    Promise.resolve({ requiresOAuth: true, requirement: 'oauth' }),
}));
// One third-party marketplace with a Linear plugin, installed on disk.
jest.mock('../plugin-service', () => ({
  ...jest.requireActual<object>('../plugin-service'),
  loadMarketplaces: (): Promise<unknown> =>
    Promise.resolve({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-11-01T00:00:00.000Z',
        marketplaces: [
          {
            id: 'openai-plugins',
            name: 'OpenAI plugins',
            description: '',
            sourceType: 'github',
            sourceUrl: 'https://github.com/openai/plugins',
            installLocation: mockMarketDir,
            plugins: [
              {
                name: 'linear',
                description: '',
                version: '1.0.0',
                sourcePath: 'linear',
              },
            ],
          },
        ],
      },
    }),
}));
jest.mock('../../canopy-cloud/mcp-connections', () => ({
  ...jest.requireActual<object>('../../canopy-cloud/mcp-connections'),
  resolveAccountMcpProxyTarget: (target: {
    accountConnectionId?: string;
  }): Promise<{ connection: AccountMcpConnection; upstreamUrl: string }> => {
    const connection = mockConnections.find(
      (row) => row.id === target.accountConnectionId,
    );
    if (!connection || mockUnroutable.has(connection.id))
      return Promise.reject(
        new Error('Account MCP connection missing or ambiguous.'),
      );
    return Promise.resolve({
      connection,
      upstreamUrl: `https://cloud.test/api/v1/mcp-proxy/${connection.routeId}`,
    });
  },
}));
jest.mock('../../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: (): typeof mockProxy => mockProxy,
}));

const routes = new Map<
  string,
  { serverId: string; configId: string; upstreamUrl: string }
>();
const mockProxy = {
  ensureStarted: (): Promise<void> => Promise.resolve(),
  registerRoute: (route: {
    serverId: string;
    configId: string;
    upstreamUrl: string;
  }): Promise<string> => {
    const id = `route-${String(routes.size + 1)}`;
    routes.set(id, {
      serverId: route.serverId,
      configId: route.configId,
      upstreamUrl: route.upstreamUrl,
    });
    return Promise.resolve(id);
  },
  unregisterRoute: (id: string): void => {
    routes.delete(id);
  },
  getProxyUrl: (id: string): string => `http://127.0.0.1:9/mcp/${id}`,
};

import {
  resolveEffectivePluginSelectionRefs,
  resolvePlugins,
} from '../plugin-resolver';
import { listDetectedMcpServersForSelections } from '../mcp-inventory';
import { getMcpServerFilePath } from '../../lib/paths';
import { projectClaudePluginWithoutMcpServers } from '../claude-plugin-projection';
import { desktopCodexPipelinePromptPorts } from '../../pipelines/codex-pipeline-prompt-ports';
import { findCuratedAccountMcpConnection } from '../../mcp/curated-plugin-binding';
import {
  accountResolutionSignature,
  turnAccountResolution,
} from '../../agents/turn-account-resolution';

function slackAccount(
  configId: string,
  account: string,
  isDefault: boolean,
): AccountMcpConnection {
  return {
    id: `conn-${configId}`,
    kind: 'CURATED',
    serverKey: 'slack',
    configId,
    displayName: 'Slack',
    label: account,
    isDefault,
    routeId: `route-${configId}`,
    status: 'CONNECTED',
    enabledTools: null,
    enabled: true,
  };
}

const acme = slackAccount('default', 'acme', true);
const globex = slackAccount('acct-globex', 'globex', false);

/** A connector picked without naming an account: a config the device made. */
const unnamed: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [{ serverId: 'slack', configId: 'cfg-local' }],
};

async function boundConfigs(
  selections: ChatTabPluginSelections,
  accountResolution?: 'attended' | 'unattended',
): Promise<string[]> {
  routes.clear();
  await resolvePlugins(selections, 'ws', 'wt', 'chat', {
    purpose: 'claude-session',
    enableHttpMcpProxy: true,
    mcpHttpProxyService: mockProxy,
    sessionId: 'session',
    ...(accountResolution ? { accountResolution } : {}),
  });
  return Array.from(routes.values(), (route) => route.configId);
}

/** The configs a Codex workflow prompt step binds for `unnamed`. */
async function workflowPromptConfigs(): Promise<string[]> {
  const resolve = desktopCodexPipelinePromptPorts.resolvePlugins;
  if (!resolve) throw new Error('the desktop resolves workflow plugins');
  const request: CodexPromptRunnerRequest = {
    cwd: mockDataDir,
    prompt: 'post the summary',
    environment: {},
    fastMode: false,
    totalTimeoutMs: 1_000,
    permissionPreset: 'none',
    pluginSelections: unnamed,
    projectId: 'ws',
    worktreeId: 'wt',
    executionId: 'run',
    jobId: 'job',
    stepId: 'step',
    attempt: 1,
    stepLabel: 'Post',
  };
  // The broker serves stdio servers only; these are all HTTP.
  const runtime = {
    registerStdioMcpRoute: jest.fn(),
  } as unknown as CodexRuntimeService;
  routes.clear();
  await resolve(request, 'route-session', runtime);
  return Array.from(routes.values(), (route) => route.configId);
}

beforeEach(() => {
  mockDataDir = mkdtempSync(join(tmpdir(), 'unattended-account-'));
  mockMarketDir = join(mockDataDir, 'market');
  routes.clear();
});

afterEach(() => {
  rmSync(mockDataDir, { recursive: true, force: true });
});

describe('unattended account resolution (CAN-6232)', () => {
  it('a chat reaches the default account of a connector held twice', async () => {
    mockConnections = [acme, globex];
    expect(await boundConfigs(unnamed)).toEqual(['default']);
    expect(await boundConfigs(unnamed, 'attended')).toEqual(['default']);
  });

  it('an unattended run never picks between accounts', async () => {
    mockConnections = [acme, globex];
    expect(await boundConfigs(unnamed, 'unattended')).toEqual([]);
  });

  it('an unattended run uses the only account, or the exact one', async () => {
    mockConnections = [globex];
    expect(await boundConfigs(unnamed, 'unattended')).toEqual(['acct-globex']);
    mockConnections = [acme, globex];
    expect(
      await boundConfigs(
        {
          ...unnamed,
          mcpServerRefs: [{ serverId: 'slack', configId: 'acct-globex' }],
        },
        'unattended',
      ),
    ).toEqual(['acct-globex']);
  });

  it('a workflow prompt resolves unattended', async () => {
    mockConnections = [acme, globex];
    expect(await workflowPromptConfigs()).toEqual([]);
    mockConnections = [globex];
    expect(await workflowPromptConfigs()).toEqual(['acct-globex']);
  });

  it('a server a plugin brings follows the same rule', () => {
    expect(
      findCuratedAccountMcpConnection([acme, globex], 'slack'),
    ).toMatchObject({
      kind: 'connection',
      connection: { configId: 'default' },
    });
    expect(
      findCuratedAccountMcpConnection([acme, globex], 'slack', {
        resolution: 'unattended',
      }),
    ).toEqual({ kind: 'ambiguous' });
    expect(
      findCuratedAccountMcpConnection([globex], 'slack', {
        resolution: 'unattended',
      }),
    ).toMatchObject({
      kind: 'connection',
      connection: { configId: 'acct-globex' },
    });
  });

  it('a server a plugin brings reaches the account the selection picks', () => {
    const picks = [{ serverId: 'slack', configId: 'acct-globex' }];
    for (const resolution of ['attended', 'unattended'] as const)
      expect(
        findCuratedAccountMcpConnection([acme, globex], 'slack', {
          resolution,
          directRefs: picks,
        }),
      ).toMatchObject({
        kind: 'connection',
        connection: { configId: 'acct-globex' },
      });
    // The picked account is gone: nothing, never the default.
    expect(
      findCuratedAccountMcpConnection([acme], 'slack', { directRefs: picks }),
    ).toEqual({ kind: 'ambiguous' });
  });

  it("an automation's turn runs unattended, in a session of its own", () => {
    const automation = turnAccountResolution({
      automationName: 'Daily digest',
    });
    expect(automation).toEqual({ accountResolution: 'unattended' });
    expect(
      turnAccountResolution({
        automationDispatch: {
          version: 1,
          automationName: 'Daily digest',
          presentation: 'background',
        },
      }),
    ).toEqual({ accountResolution: 'unattended' });
    // A person's turn, and a retry, resume or delegate delivery into a
    // person's chat (initiation source `automation`, no automation facts).
    expect(turnAccountResolution({})).toEqual({});
    expect(accountResolutionSignature(automation)).not.toBe(
      accountResolutionSignature(turnAccountResolution({})),
    );
  });

  it("a collection's other account gives way to the selection's own pick", async () => {
    mockConnections = [acme, globex];
    mockCollectionMcp = [{ serverId: 'slack', configId: 'default' }];
    const picked: ChatTabPluginSelections = {
      collectionIds: ['c0ffee00-0000-4000-8000-000000000001'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'slack', configId: 'acct-globex' }],
    };
    const effective = await resolveEffectivePluginSelectionRefs(
      picked,
      [],
      undefined,
      undefined,
      'unattended',
    );
    expect(effective.mcpServerRefs).toEqual([
      { serverId: 'slack', configId: 'acct-globex' },
    ]);
    expect(await boundConfigs(picked, 'unattended')).toEqual(['acct-globex']);
    // Without a pick, the collection's account loads as before.
    expect(
      (
        await resolveEffectivePluginSelectionRefs(
          { ...picked, mcpServerRefs: [] },
          [],
          undefined,
          undefined,
          'unattended',
        )
      ).mcpServerRefs,
    ).toEqual([{ serverId: 'slack', configId: 'default' }]);
    mockCollectionMcp = [];
  });
});

function linearAccount(
  configId: string,
  account: string,
  isDefault: boolean,
): AccountMcpConnection {
  return {
    ...slackAccount(configId, account, isDefault),
    id: `conn-linear-${configId}`,
    serverKey: 'linear',
    displayName: 'Linear',
    routeId: `route-linear-${configId}`,
    upstreamHost: 'mcp.linear.app',
  };
}

const LINEAR = 'https://mcp.linear.app/mcp';
const work = linearAccount('default', 'work', true);
const client = linearAccount('acct-client', 'client', false);
const viaAccount = (account: AccountMcpConnection): string =>
  `https://cloud.test/api/v1/mcp-proxy/${account.routeId}`;
const withLinearPlugin: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [{ marketplaceId: 'openai-plugins', pluginName: 'linear' }],
};

/** Install the third-party Linear plugin declaring one MCP server. */
function writeLinearPlugin(declaration: Record<string, unknown>): void {
  const dir = join(mockMarketDir, 'linear');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'linear', version: '1.0.0' }),
  );
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { linear: declaration } }),
  );
}

/** Where each route the resolution registered sends its requests. */
async function upstreams(
  selections: ChatTabPluginSelections,
  accountResolution?: 'attended' | 'unattended',
): Promise<string[]> {
  routes.clear();
  await resolvePlugins(selections, 'ws', 'wt', 'chat', {
    purpose: 'claude-session',
    enableHttpMcpProxy: true,
    mcpHttpProxyService: mockProxy,
    sessionId: 'session',
    ...(accountResolution ? { accountResolution } : {}),
  });
  return Array.from(routes.values(), (route) => route.upstreamUrl);
}

/**
 * A well-formed device server file whose id is the connector key, in this
 * worker's isolated data folder. The caller removes it.
 */
function writeDeviceLinear(): string {
  const target = getMcpServerFilePath('linear');
  if (!target.startsWith(`${mockDataDir}/`))
    throw new Error(`refusing to write outside the test folder: ${target}`);
  const timestamp = '2026-01-01T00:00:00.000Z';
  const deviceFile = getMcpServerFilePath('linear');
  mkdirSync(dirname(deviceFile), { recursive: true });
  writeFileSync(
    deviceFile,
    JSON.stringify({
      version: 1,
      server: {
        definition: {
          id: 'linear',
          name: 'Linear on this device',
          description: '',
          type: 'command',
          command: 'true',
          args: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        configs: [
          {
            id: 'default',
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
    }),
  );
  return deviceFile;
}

describe("a third-party plugin's server and the person's connector accounts", () => {
  beforeEach(() => {
    writeLinearPlugin({ type: 'http', url: LINEAR });
    mockUnroutable = new Set();
  });

  /** The selection, with the plugin, picking one Linear account. */
  const picking = (configId: string): ChatTabPluginSelections => ({
    ...withLinearPlugin,
    mcpServerRefs: [{ serverId: 'linear', configId }],
  });

  it('keeps its own sign-in unless the selection picks an account', async () => {
    for (const held of [[], [work], [work, client]]) {
      mockConnections = held;
      expect(await upstreams(withLinearPlugin)).toEqual([LINEAR]);
      expect(await upstreams(withLinearPlugin, 'unattended')).toEqual([LINEAR]);
    }
  });

  it('reaches the picked account, in a chat and unattended', async () => {
    mockConnections = [work, client];
    expect(await upstreams(picking('acct-client'))).toEqual([
      viaAccount(client),
    ]);
    expect(await upstreams(picking('acct-client'), 'unattended')).toEqual([
      viaAccount(client),
    ]);
    expect(await upstreams(picking('default'), 'unattended')).toEqual([
      viaAccount(work),
    ]);
  });

  it('with a pick, never runs as anyone else', async () => {
    // The picked account is gone; another remains.
    mockConnections = [work];
    expect(await upstreams(picking('acct-client'), 'unattended')).toEqual([]);
    // The picked account is off.
    mockConnections = [work, { ...client, enabled: false }];
    expect(await upstreams(picking('acct-client'))).toEqual([]);
    // The picked account is at another host, beside one at the declared
    // host, or the cloud names no host for it: the pick's own ref loads it,
    // and the plugin's server is left out rather than bound or signed in.
    for (const picked of [
      { ...client, upstreamHost: 'mcp.eu.linear.app' },
      { ...client, upstreamHost: undefined },
    ]) {
      mockConnections = [work, picked];
      expect(await upstreams(picking('acct-client'), 'unattended')).toEqual([
        viaAccount(client),
      ]);
    }
    // Its route fails.
    mockConnections = [client];
    mockUnroutable = new Set([client.id]);
    expect(await upstreams(picking('acct-client'))).toEqual([]);
  });

  it('with a pick, an unreadable account list leaves it out', async () => {
    mockConnectionsUnreadable = true;
    try {
      mockConnections = [client];
      expect(await upstreams(picking('acct-client'), 'unattended')).toEqual([]);
      // Without a pick the list isn't needed.
      expect(await upstreams(withLinearPlugin, 'unattended')).toEqual([LINEAR]);
    } finally {
      mockConnectionsUnreadable = false;
    }
  });

  it('keeps its own sign-in for another URL, or headers or a tool policy of its own', async () => {
    mockConnections = [work];
    writeLinearPlugin({ type: 'http', url: 'https://linear.example.com/mcp' });
    expect(await upstreams(picking('default'))).toEqual([
      viaAccount(work),
      'https://linear.example.com/mcp',
    ]);
    // Every field the plugin's own headers come from, set or not.
    for (const own of [
      { headers: { 'X-Team': 'a' } },
      { http_headers: { 'X-Team': 'a' } },
      { env_http_headers: { Authorization: 'LINEAR_TOKEN_UNSET' } },
      { bearer_token_env_var: 'LINEAR_TOKEN_UNSET' },
      { disabled_tools: ['delete_issue'] },
      { enabled_tools: ['list_issues'] },
    ]) {
      writeLinearPlugin({ type: 'http', url: LINEAR, ...own });
      expect(await upstreams(picking('default'))).toEqual([
        viaAccount(work),
        LINEAR,
      ]);
    }
  });

  it('a delegate whose parent pinned the handler keeps its own path', async () => {
    mockConnections = [work];
    routes.clear();
    await resolvePlugins(picking('default'), 'ws', 'wt', 'chat', {
      purpose: 'claude-session',
      enableHttpMcpProxy: true,
      mcpHttpProxyService: mockProxy,
      sessionId: 'session',
      mcpHttpAuthPins: [
        {
          target: {
            kind: 'plugin',
            marketplaceId: 'openai-plugins',
            pluginName: 'linear',
            serverName: 'linear',
          },
          handler: 'canopy',
        },
      ],
    });
    expect(Array.from(routes.values(), (route) => route.upstreamUrl)).toEqual([
      viaAccount(work),
      LINEAR,
    ]);
  });

  it('adds nothing beside the picked account the selection loads', async () => {
    mockConnections = [work, client];
    routes.clear();
    const { mcpServers } = await resolvePlugins(
      picking('acct-client'),
      'ws',
      'wt',
      'chat',
      {
        purpose: 'claude-session',
        enableHttpMcpProxy: true,
        mcpHttpProxyService: mockProxy,
        sessionId: 'session',
      },
    );
    expect(Object.keys(mcpServers)).toHaveLength(1);
    expect(Array.from(routes.values(), (route) => route.upstreamUrl)).toEqual([
      viaAccount(client),
    ]);
  });

  it('a legacy account ref is a pick of its connection', async () => {
    mockConnections = [work, client];
    const legacy: ChatTabPluginSelections = {
      ...withLinearPlugin,
      mcpServerRefs: [
        { serverId: `account:${client.id}`, configId: 'acct-client' },
      ],
    };
    const bound = await upstreams(legacy, 'unattended');
    expect(bound).toContain(viaAccount(client));
    expect(bound).not.toContain(LINEAR);
    // Its connection is gone: the plugin's server is left out.
    mockConnections = [work];
    expect(await upstreams(legacy, 'unattended')).not.toContain(LINEAR);
  });

  it('with a pick and no readable catalog, it is left out', async () => {
    mockCatalogUnreadable = true;
    try {
      mockConnections = [client];
      expect(await upstreams(picking('acct-client'))).toEqual([
        viaAccount(client),
      ]);
      // Without a pick it keeps its own sign-in.
      expect(await upstreams(withLinearPlugin)).toEqual([LINEAR]);
    } finally {
      mockCatalogUnreadable = false;
    }
  });

  it('a legacy ref must name its connection exactly, as the standalone pass requires', async () => {
    mockConnections = [work, client];
    const routesFor = await upstreams(
      {
        ...withLinearPlugin,
        mcpServerRefs: [
          { serverId: `account:${client.id}`, configId: 'other' },
        ],
      },
      'unattended',
    );
    expect(routesFor).not.toContain(LINEAR);
    expect(routesFor).not.toContain(viaAccount(client));
  });

  it('refs that reach two accounts leave it out', async () => {
    mockConnections = [work, client];
    // `cfg-x` reaches the default account in a chat; `acct-client` the other.
    const routesFor = await upstreams({
      ...withLinearPlugin,
      mcpServerRefs: [
        { serverId: 'linear', configId: 'acct-client' },
        { serverId: 'linear', configId: 'cfg-x' },
      ],
    });
    expect(routesFor.sort()).toEqual(
      [viaAccount(client), viaAccount(work)].sort(),
    );
  });

  it('with no readable catalog, a server that could never bind keeps its path', async () => {
    mockCatalogUnreadable = true;
    try {
      mockConnections = [client];
      writeLinearPlugin({ type: 'http', url: 'http://mcp.linear.app/mcp' });
      expect(await upstreams(picking('acct-client'))).toEqual([
        viaAccount(client),
        'http://mcp.linear.app/mcp',
      ]);
    } finally {
      mockCatalogUnreadable = false;
    }
  });

  it("a ref naming this computer's device server picks no account", async () => {
    mockConnections = [work];
    // A device server file whose id is the connector key takes precedence
    // over the key in the standalone pass, so the ref names that file.
    const deviceFile = writeDeviceLinear();
    try {
      expect(await upstreams(picking('default'))).toEqual([LINEAR]);
      const card = await listDetectedMcpServersForSelections(
        picking('default'),
      );
      expect(card.servers.find((row) => row.source === 'plugin')).toMatchObject(
        { canToggleCanopyProxy: true },
      );
    } finally {
      rmSync(deviceFile, { force: true });
    }
  });

  it('a declaration with a command runs as stdio, and the card keeps its row', async () => {
    mockConnections = [client];
    writeLinearPlugin({ command: 'linear-mcp', url: LINEAR });
    const { mcpServers } = await resolvePlugins(
      picking('acct-client'),
      'ws',
      'wt',
      'chat',
      {
        purpose: 'claude-session',
        enableHttpMcpProxy: true,
        mcpHttpProxyService: mockProxy,
        sessionId: 'session',
      },
    );
    expect(Object.values(mcpServers)).toContainEqual(
      expect.objectContaining({ type: 'stdio', command: 'linear-mcp' }),
    );
    const card = await listDetectedMcpServersForSelections(
      picking('acct-client'),
    );
    // The plugin's row stays (never folded into the pick), unbound.
    const row = card.servers.find((server) => server.source === 'plugin');
    expect(row).toBeDefined();
    expect(row?.accountConnectionId).toBeUndefined();
  });

  it('with no readable catalog, a device ref alone leaves its own sign-in', async () => {
    mockCatalogUnreadable = true;
    const deviceFile = writeDeviceLinear();
    try {
      mockConnections = [work];
      expect(await upstreams(picking('default'))).toEqual([LINEAR]);
    } finally {
      rmSync(deviceFile, { force: true });
      mockCatalogUnreadable = false;
    }
  });

  it('a pick that needs sign-in or is off has one recovery row', async () => {
    for (const picked of [
      { ...client, enabled: false },
      { ...client, status: 'REAUTH_REQUIRED' as const },
    ]) {
      mockConnections = [work, picked];
      const { servers } = await listDetectedMcpServersForSelections(
        picking('acct-client'),
      );
      expect(
        servers.filter((row) => row.accountConnectionId === client.id),
      ).toHaveLength(1);
      expect(
        servers.find((row) => row.source === 'plugin')?.accountConnectionId,
      ).toBeUndefined();
    }
  });

  it('Claude gets a manifestless plugin without its own .mcp.json', async () => {
    rmSync(join(mockMarketDir, 'linear', '.claude-plugin'), {
      recursive: true,
      force: true,
    });
    // Bound to the pick, and with a pick that can't be honored.
    for (const held of [[client], [work]]) {
      mockConnections = held;
      const { sdkPlugins } = await resolvePlugins(
        picking('acct-client'),
        'ws',
        'wt',
        'chat',
        {
          purpose: 'claude-session',
          enableHttpMcpProxy: true,
          mcpHttpProxyService: mockProxy,
          sessionId: 'session',
        },
      );
      const linear = sdkPlugins.find((plugin) =>
        plugin.path.endsWith('linear'),
      );
      expect(linear).toBeDefined();
      expect(existsSync(join(linear?.path ?? '', '.mcp.json'))).toBe(false);
    }
  });

  it('projecting a plugin installed through a link never changes the installed files', async () => {
    // The marketplace's `linear` folder is a link to the installed plugin.
    const installed = join(mockDataDir, 'installed-linear');
    renameSync(join(mockMarketDir, 'linear'), installed);
    const linked = join(mockMarketDir, 'linear');
    symlinkSync(installed, linked, 'dir');
    const manifest = join(installed, '.claude-plugin', 'plugin.json');
    const manifestBefore = readFileSync(manifest, 'utf8');
    for (const withManifest of [true, false]) {
      if (!withManifest)
        rmSync(join(installed, '.claude-plugin'), {
          recursive: true,
          force: true,
        });
      const projected = await projectClaudePluginWithoutMcpServers({
        sourcePluginPath: linked,
        marketplaceId: 'openai-plugins',
        pluginName: 'linear',
        projectionRootDir: join(mockDataDir, 'projected-plugins'),
        warnings: [],
      });
      expect(projected).not.toBe(linked);
      expect(lstatSync(projected).isSymbolicLink()).toBe(false);
      expect(existsSync(join(projected, '.mcp.json'))).toBe(false);
      // The installed plugin keeps its server file, and its manifest.
      expect(existsSync(join(installed, '.mcp.json'))).toBe(true);
      if (withManifest)
        expect(readFileSync(manifest, 'utf8')).toBe(manifestBefore);
    }
  });

  it('the MCP servers card shows the picked account once, else its own sign-in', async () => {
    mockConnections = [work, client];
    const { servers } = await listDetectedMcpServersForSelections(
      picking('acct-client'),
    );
    // The session loads one server for the plugin and its pick: the pick's
    // own row, with no plugin row beside it.
    expect(servers.filter((row) => row.source === 'plugin')).toEqual([]);
    expect(
      servers.filter((row) => row.accountConnectionId === client.id),
    ).toHaveLength(1);
    const own = await listDetectedMcpServersForSelections(withLinearPlugin);
    expect(own.servers[0]).toMatchObject({
      source: 'plugin',
      canToggleCanopyProxy: true,
    });
    expect(own.servers[0]?.accountConnectionId).toBeUndefined();
    // A pick that can't be honored shows the plugin row unbound.
    mockConnections = [work];
    const gone = await listDetectedMcpServersForSelections(
      picking('acct-client'),
    );
    expect(gone.servers.find((row) => row.source === 'plugin')).toMatchObject({
      authStatus: 'not_connected',
      canConnect: false,
    });
  });

  it('matches a catalog endpoint exactly, and only one', () => {
    expect(
      accountMcpCatalogKeyForUrl(
        [mockLinearEntry],
        'https://MCP.linear.app/mcp/',
      ),
    ).toBe('linear');
    for (const other of [
      'http://mcp.linear.app/mcp',
      'https://mcp.linear.app/mcp?team=a',
      'https://user:secret@mcp.linear.app/mcp',
      'https://mcp.linear.app/mcp/other',
    ])
      expect(
        accountMcpCatalogKeyForUrl([mockLinearEntry], other),
      ).toBeUndefined();
    expect(
      accountMcpCatalogKeyForUrl(
        [mockLinearEntry, { ...mockLinearEntry, key: 'linear-copy' }],
        LINEAR,
      ),
    ).toBeUndefined();
    expect(
      accountMcpCatalogKeyForUrl(
        [{ ...mockLinearEntry, availability: 'desktop' }],
        LINEAR,
      ),
    ).toBeUndefined();
    // A URL a desktop-only entry shares with an account-capable one.
    expect(
      accountMcpCatalogKeyForUrl(
        [
          mockLinearEntry,
          { ...mockLinearEntry, key: 'linear-local', availability: 'desktop' },
        ],
        LINEAR,
      ),
    ).toBeUndefined();
    // Two ports of one hostname: an account's hostname can't tell them apart.
    expect(
      accountMcpCatalogKeyForUrl(
        [
          {
            ...mockLinearEntry,
            urlOptions: [
              { url: LINEAR, label: 'Main' },
              { url: 'https://mcp.linear.app:8443/mcp', label: 'Alt' },
            ],
          },
        ],
        LINEAR,
      ),
    ).toBeUndefined();
    // Two endpoints on one host: an account's host can't tell them apart.
    expect(
      accountMcpCatalogKeyForUrl(
        [
          {
            ...mockLinearEntry,
            urlOptions: [
              { url: LINEAR, label: 'Main' },
              { url: 'https://mcp.linear.app/mcp/eu', label: 'EU' },
            ],
          },
        ],
        LINEAR,
      ),
    ).toBeUndefined();
  });
});
