import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountMcpConnection } from '@canopy/execution-engine/types/mcp-servers';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { CodexRuntimeService } from '@canopy/execution-engine/node/codex-runtime/runtime-service';
import type { CodexPromptRunnerRequest } from '@canopy/execution-engine/node/pipelines/executor/types';

let mockDataDir = '';
let mockConnections: AccountMcpConnection[] = [];
let mockCollectionMcp: { serverId: string; configId: string }[] = [];

jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getDataDir: (): string => mockDataDir,
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
  accountMcpConnectionsEnabled: (): boolean => true,
  loadAccountMcpRefConnections: (): Promise<AccountMcpConnection[]> =>
    Promise.resolve(structuredClone(mockConnections)),
}));
jest.mock('../../mcp/curated-catalog', () => ({
  ...jest.requireActual<object>('../../mcp/curated-catalog'),
  readCachedCuratedMcpDesktopOnlyKeys: (): Promise<ReadonlySet<string>> =>
    Promise.resolve(new Set<string>()),
}));
jest.mock('../../canopy-cloud/mcp-connections', () => ({
  ...jest.requireActual<object>('../../canopy-cloud/mcp-connections'),
  resolveAccountMcpProxyTarget: (target: {
    accountConnectionId?: string;
  }): Promise<{ connection: AccountMcpConnection; upstreamUrl: string }> => {
    const connection = mockConnections.find(
      (row) => row.id === target.accountConnectionId,
    );
    if (!connection)
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

const routes = new Map<string, { serverId: string; configId: string }>();
const mockProxy = {
  ensureStarted: (): Promise<void> => Promise.resolve(),
  registerRoute: (route: {
    serverId: string;
    configId: string;
  }): Promise<string> => {
    const id = `route-${String(routes.size + 1)}`;
    routes.set(id, { serverId: route.serverId, configId: route.configId });
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
