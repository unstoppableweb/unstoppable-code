import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_AGENT_DEFERRED_TOOLS_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  ChatTabPluginSelections,
  DeferredToolMatch,
} from '@canopy/desktop-shared/types';
import {
  DEFERRED_REF_NOT_ISSUED_MESSAGE,
  encodeDeferredCatalogRef,
  encodeMcpRef,
  encodePluginRef,
  encodeSkillRef,
} from '../../deferred-tools/catalog';
import type { DeferredToolsExecutorRuntime } from '../../deferred-tools/executor';
import { resetIssuedDeferredRefsForTests } from '../../deferred-tools/issued-refs';
import { deferredToolsReloadCoordinator } from '../../deferred-tools/reload-coordinator';
import {
  loadDeferredToolsThroughCore,
  searchDeferredToolsThroughCore,
} from '../../canopy-tools/deferred-tools-core-client';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import { INTERFACE_RELAY_ALLOWLIST } from '../renderer-relay/interface-allowlist.generated';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

const mockFixture = {
  root: '',
  hiddenSkills: new Set(['other-org-skill']),
  uninstalledSkills: new Set<string>(),
  runtime: null as DesktopCanopyDispatcher | null,
};

jest.mock('../desktop-runtime', () => ({
  ...jest.requireActual<Record<string, unknown>>('../desktop-runtime'),
  getActiveDesktopRuntime: (): unknown => mockFixture.runtime,
}));

const mockOAuth = jest.fn();
jest.mock('../../mcp/oauth-client', () => ({
  startMcpOAuthFlow: (...args: unknown[]): unknown => mockOAuth(...args),
  openExternalUrl: (...args: unknown[]): unknown => mockOAuth(...args),
  getValidMcpAccessToken: (...args: unknown[]): unknown => mockOAuth(...args),
}));

jest.mock('../../skills/skill-service', () => ({
  loadSkills: (): unknown => ({
    success: true,
    data: [
      {
        sourceId: 'local',
        name: 'brainstorm',
        description: 'Explore ideas before building',
        source: 'Local',
      },
      {
        sourceId: 'local',
        name: 'enabled-skill',
        description: 'Already in the chat',
        source: 'Local',
      },
      {
        sourceId: 'org',
        name: 'other-org-skill',
        description: 'Belongs to another organization',
        source: 'Org',
      },
      {
        sourceId: 'local',
        name: 'policy-off',
        description: 'Turned off in settings',
        source: 'Local',
      },
    ].filter((skill) => !mockFixture.uninstalledSkills.has(skill.name)),
  }),
}));

jest.mock('../../skills/skill-install-context', () => ({
  filterStoredSkillContexts: <T extends { name: string }>(
    rows: T[],
  ): Promise<T[]> =>
    Promise.resolve(
      rows.filter((row) => !mockFixture.hiddenSkills.has(row.name)),
    ),
}));

jest.mock('../../installed-items/installed-item-policy', () => ({
  readInstalledItemPolicy: (): Promise<unknown> =>
    Promise.resolve({
      isDisabled: (ref: { kind: string; skillName?: string }): boolean =>
        ref.kind === 'skill' && ref.skillName === 'policy-off',
    }),
}));

const mockInstall = jest.fn();
jest.mock('../../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: (): Promise<unknown> => {
    const installed = join(mockFixture.root, 'installed');
    const missing = join(mockFixture.root, 'missing');
    const details = (
      skills: string[],
      commands: string[],
    ): Record<string, unknown> => ({
      skills: skills.map((name) => ({ name, description: `${name} skill` })),
      commands: commands.map((name) => ({
        name,
        description: `${name} command`,
      })),
      mcpServers: [],
      agents: [],
      hooks: [],
    });
    const facet = (
      location: string,
      skills: string[],
      commands: string[],
    ): Record<string, unknown> => ({
      installLocation: location,
      details: details(skills, commands),
    });
    return Promise.resolve({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'market',
            name: 'Market',
            description: 'Market plugins',
            plugins: [
              {
                name: 'superpowers',
                marketplaceId: 'market',
                description: 'Planning and review skills',
                providerSupport: { claude: 'native', codex: 'native' },
                cachePath: null,
                facets: {
                  claude: facet(installed, ['brainstorming'], ['plan']),
                  codex: facet(installed, ['brainstorming'], []),
                },
                details: details(['brainstorming'], ['plan']),
              },
              {
                name: 'claude-only',
                marketplaceId: 'market',
                description: 'Only for Claude',
                providerSupport: { claude: 'native', codex: 'none' },
                cachePath: null,
                facets: { claude: facet(installed, [], ['deploy']) },
                details: details([], ['deploy']),
              },
              {
                name: 'not-installed',
                marketplaceId: 'market',
                description: 'A plugin with no facet on disk',
                providerSupport: { claude: 'native', codex: 'native' },
                cachePath: null,
                facets: {
                  claude: facet(missing, ['ghost'], []),
                  codex: facet(missing, ['ghost'], []),
                },
                details: details(['ghost'], []),
              },
              {
                name: 'compat-plugin',
                marketplaceId: 'market',
                description: 'Codex compatibility turned off',
                providerSupport: { claude: 'native', codex: 'compat' },
                codexCompatDisabled: true,
                cachePath: null,
                facets: {
                  claude: facet(installed, ['review'], []),
                  codexCompatibility: facet(installed, ['review'], []),
                },
                details: details(['review'], []),
              },
            ],
          },
        ],
      },
    });
  },
  ...Object.fromEntries(
    [
      'loadMarketplaces',
      'refreshMarketplaces',
      'refreshInstalledPluginCatalog',
      'updateMarketplace',
      'installPlugin',
      'installBuiltInPlugin',
    ].map((name) => [
      name,
      (...args: unknown[]): unknown => mockInstall(name, ...args),
    ]),
  ),
}));

const mockResolvedPaths: Array<{ plugin: string; install: unknown }> = [];
jest.mock('../../plugins/plugin-resolver', () => ({
  resolveEffectivePluginSelectionRefs: (
    selections: ChatTabPluginSelections,
  ): Promise<unknown> =>
    Promise.resolve({
      skillRefs: selections.skillRefs,
      pluginRefs: selections.pluginRefs,
      mcpServerRefs: selections.mcpServerRefs ?? [],
    }),
  resolvePluginInfoPath: (
    plugin: { name: string },
    _marketplace: unknown,
    _deps: unknown,
    install: unknown,
  ): Promise<string | undefined> => {
    mockResolvedPaths.push({ plugin: plugin.name, install });
    return Promise.resolve(
      plugin.name === 'superpowers'
        ? join(mockFixture.root, 'installed')
        : undefined,
    );
  },
  discoverCursorPluginMembers: (): unknown[] => [
    {
      kind: 'plugin_skill',
      name: 'brainstorming',
      skill: { description: 'brainstorming skill' },
    },
    {
      kind: 'plugin_command',
      name: 'plan',
      command: { description: 'plan command' },
    },
  ],
  loadPluginManifest: (): null => null,
  readPluginMcpConfigObjects: (): Record<string, unknown> => ({}),
}));

jest.mock('../../lib/paths', () => ({
  getMcpServersIndexFilePath: (): string =>
    join(mockFixture.root, 'mcp-servers.json'),
}));

const SELECTIONS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [{ sourceId: 'local', skillName: 'enabled-skill' }],
  pluginRefs: [],
  mcpServerRefs: [{ serverId: 'github', configId: 'work' }],
};
const QUERIES = {
  queries: [
    { text: 'brainstorm' },
    { text: 'superpowers:plan' },
    { text: 'github', kinds: ['mcp'] },
    { text: 'plugin', limit: 2 },
    { text: 'claude' },
    { text: 'ghost' },
    { text: 'org' },
    { text: 'policy' },
  ],
};
const PROVIDERS = ['claude', 'codex', 'copilot', 'opencode', 'ollama'] as const;
const CHAT = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
const OTHER_CHAT = { projectId: 'other', worktreeId: 'w2', chatId: 'c2' };
const ref = (identity: string): string => encodeDeferredCatalogRef(identity);
const BRAINSTORM = ref(encodeSkillRef('local', 'brainstorm'));

function session(
  scope: DeferredToolsExecutorRuntime['scope'],
  providerType: DeferredToolsExecutorRuntime['providerType'] = 'claude',
): DeferredToolsExecutorRuntime {
  return { scope, providerType, pluginSelections: SELECTIONS, allowed: true };
}

async function search(
  scope: DeferredToolsExecutorRuntime['scope'],
  text: string,
): Promise<DeferredToolMatch[]> {
  const result = await searchDeferredToolsThroughCore(
    { queries: [{ text }] },
    session(scope),
  );
  const parsed = JSON.parse(result.text) as {
    results: Array<{ matches: DeferredToolMatch[] }>;
  };
  return parsed.results.flatMap((entry) => entry.matches);
}

async function load(
  scope: DeferredToolsExecutorRuntime['scope'],
  refs: string[],
  call: { toolUseId?: string; invocationId?: string } = {
    toolUseId: 'toolu_1',
  },
  runtime: DeferredToolsExecutorRuntime = session(scope),
): Promise<{
  isError: boolean;
  result: {
    status: string;
    willEnable: Array<{ ref: string }>;
    rejected: Array<{ ref: string; code: string; message: string }>;
  };
}> {
  const result = await loadDeferredToolsThroughCore(
    { items: refs.map((item) => ({ ref: item })) },
    runtime,
    call,
  );
  return {
    isError: result.isError === true,
    result: JSON.parse(result.text) as never,
  };
}

let ledger: string;
let mockRequest: jest.SpiedFunction<
  typeof deferredToolsReloadCoordinator.request
>;

beforeAll(() => {
  mockFixture.root = mkdtempSync(join(tmpdir(), 'deferred-tools-'));
  mkdirSync(join(mockFixture.root, 'installed'));
  writeFileSync(
    join(mockFixture.root, 'mcp-servers.json'),
    JSON.stringify({
      version: 1,
      servers: [
        {
          id: 'github',
          name: 'GitHub',
          description: 'GitHub issues and pull requests',
          type: 'http',
          configs: [
            { id: 'default', name: 'GitHub', enabled: true },
            { id: 'work', name: 'Work', enabled: true },
            { id: 'off', name: 'Off', enabled: false },
          ],
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    }),
  );
});
afterAll(() => {
  rmSync(mockFixture.root, { recursive: true, force: true });
});

beforeEach(() => {
  ledger = mkdtempSync(join(tmpdir(), 'deferred-tools-ledger-'));
  mockFixture.runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(ledger, 'ledger.sqlite'),
    }),
    shutdownTimeoutMs: 25,
  });
  mockFixture.hiddenSkills = new Set(['other-org-skill']);
  mockFixture.uninstalledSkills = new Set();
  mockRequest = jest
    .spyOn(deferredToolsReloadCoordinator, 'request')
    .mockResolvedValue({
      accepted: true,
      requestId: 'reload-1',
    });
  mockInstall.mockReset();
  mockOAuth.mockReset();
  mockResolvedPaths.length = 0;
  resetIssuedDeferredRefsForTests();
});
afterEach(async () => {
  mockRequest.mockRestore();
  await mockFixture.runtime?.shutdown();
  mockFixture.runtime = null;
  rmSync(ledger, { recursive: true, force: true });
});

describe('deferred tools through core.agent.deferredTools (CAN-5995)', () => {
  it('SearchDeferredTools answers byte for byte as it did before the move, for every provider', async () => {
    const golden = JSON.parse(
      readFileSync(
        join(__dirname, '__golden__', 'deferred-tools-search.golden.json'),
        'utf8',
      ),
    ) as Record<string, string>;
    for (const providerType of PROVIDERS) {
      const result = await searchDeferredToolsThroughCore(
        QUERIES,
        session(CHAT, providerType),
      );
      expect({ providerType, text: result.text }).toEqual({
        providerType,
        text: golden[providerType],
      });
    }
  });

  it('load enables only a ref search returned to the same chat; anything else is refused before any write', async () => {
    const [match] = await search(CHAT, 'brainstorm');
    expect(match?.ref).toBe(BRAINSTORM);

    // Returned to another chat, or built by hand: never issued here.
    const notIssued = [
      BRAINSTORM,
      ref(encodePluginRef('market', 'not-installed')),
      ref(encodeSkillRef('org', 'other-org-skill')),
      ref(encodeMcpRef('github', 'off')),
      'deferred:v1:forged',
    ];
    const elsewhere = await load(OTHER_CHAT, notIssued);
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.result.rejected).toEqual(
      notIssued.map((item) => ({
        ref: item,
        code: 'not_found',
        message: DEFERRED_REF_NOT_ISSUED_MESSAGE,
      })),
    );
    const handBuilt = await load(CHAT, notIssued.slice(1));
    expect(handBuilt.result.rejected.map((entry) => entry.message)).toEqual(
      notIssued.slice(1).map(() => DEFERRED_REF_NOT_ISSUED_MESSAGE),
    );
    expect(mockRequest).not.toHaveBeenCalled();

    const loaded = await load(CHAT, [BRAINSTORM]);
    expect(loaded).toEqual({
      isError: false,
      result: {
        status: 'success',
        willEnable: [
          {
            ref: BRAINSTORM,
            kind: 'skill',
            name: 'brainstorm',
            sourceLabel: 'Local',
          },
        ],
        rejected: [],
      },
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0]?.[0]).toMatchObject({
      scope: CHAT,
      toolCallId: 'toolu_1',
      additions: {
        skillRefs: [{ sourceId: 'local', skillName: 'brainstorm' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
  });

  it('an issued ref is refused once its item is uninstalled or leaves this organization', async () => {
    mockFixture.hiddenSkills = new Set();
    const issued = await search(CHAT, 'skill');
    const other = ref(encodeSkillRef('org', 'other-org-skill'));
    expect(issued.map((match) => match.ref)).toEqual(
      expect.arrayContaining([BRAINSTORM, other]),
    );
    mockFixture.uninstalledSkills = new Set(['brainstorm']);
    mockFixture.hiddenSkills = new Set(['other-org-skill']);
    const refused = await load(CHAT, [BRAINSTORM, other]);
    expect(refused.isError).toBe(true);
    expect(refused.result.rejected).toEqual([
      {
        ref: BRAINSTORM,
        code: 'not_found',
        message: 'Catalog item was not found.',
      },
      { ref: other, code: 'not_found', message: 'Catalog item was not found.' },
    ]);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('search and load never install, fetch a marketplace or start OAuth', async () => {
    for (const providerType of PROVIDERS)
      await searchDeferredToolsThroughCore(
        QUERIES,
        session(CHAT, providerType),
      );
    const [plugin] = await search(CHAT, 'superpowers');
    await load(CHAT, [plugin?.ref ?? '']);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockOAuth).not.toHaveBeenCalled();
    expect(mockResolvedPaths.length).toBeGreaterThan(0);
    expect(mockResolvedPaths.every((entry) => entry.install === false)).toBe(
      true,
    );
  });

  it('the chat comes from the session; a scope in tool input changes nothing', async () => {
    const runtime = mockFixture.runtime;
    if (!runtime) throw new Error('no runtime');
    const instruction = runtime.instruction.bind(runtime);
    const dispatched: unknown[] = [];
    const spy = jest
      .spyOn(runtime, 'instruction')
      .mockImplementation((name, params, options) => {
        dispatched.push(params);
        return instruction(name, params, options);
      });
    await search(CHAT, 'brainstorm');
    await loadDeferredToolsThroughCore(
      {
        items: [{ ref: BRAINSTORM }],
        scope: OTHER_CHAT,
        chatId: 'c2',
        recipient: { workspaceId: 'other', worktreeId: 'w2', chatId: 'c2' },
      },
      session(CHAT),
      { toolUseId: 'toolu_1' },
    );
    spy.mockRestore();
    expect(dispatched).toEqual([
      expect.objectContaining({
        recipient: { workspaceId: 'p', worktreeId: 'w', chatId: 'c' },
        input: { items: [{ ref: BRAINSTORM }] },
      }),
    ]);
    expect(mockRequest.mock.calls[0]?.[0]).toMatchObject({ scope: CHAT });
  });

  it('a keyed retry enables once', async () => {
    await search(CHAT, 'brainstorm');
    const call = { toolUseId: 'toolu_9', invocationId: 'claude:toolu_9' };
    const first = await load(CHAT, [BRAINSTORM], call);
    const retry = await load(CHAT, [BRAINSTORM], call);
    expect(retry).toEqual(first);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('a retry of the same invocation over a new connection keeps one reload and answers reload_in_progress, not a key conflict', async () => {
    await search(CHAT, 'brainstorm');
    mockRequest
      .mockResolvedValueOnce({
        accepted: true,
        requestId: 'reload-1',
      })
      .mockResolvedValueOnce({
        accepted: false,
        reason: 'reload_in_progress',
      });
    const first = await load(CHAT, [BRAINSTORM], {
      toolUseId: '1',
      invocationId: 'claude:toolu_9',
    });
    const retry = await load(CHAT, [BRAINSTORM], {
      toolUseId: '7',
      invocationId: 'claude:toolu_9',
    });
    expect(first.result.status).toBe('success');
    expect(retry.isError).toBe(true);
    expect(retry.result.status).toBe('error');
    expect(retry.result.willEnable).toEqual([]);
    expect(
      retry.result.rejected.map(({ ref, code }) => ({ ref, code })),
    ).toEqual([{ ref: BRAINSTORM, code: 'reload_in_progress' }]);
    expect(mockRequest.mock.calls[0]?.[0]).toMatchObject({ toolCallId: '1' });
  });

  it('the search grant alone cannot load, and the load grant alone cannot search', async () => {
    const runtime = mockFixture.runtime;
    if (!runtime) throw new Error('no runtime');
    const caller = (
      grants: CanopyCallerDescriptor['grants'],
    ): CanopyCallerDescriptor => ({
      principalId: 'desktop-agent-deferred-tools',
      clientInstanceId: 'desktop-main',
      authorityId: 'local',
      interfaceKind: 'mcp',
      grants,
    });
    const params = {
      recipient: { workspaceId: 'p', worktreeId: 'w', chatId: 'c' },
      session: { providerType: 'claude' as const },
      input: { items: [{ ref: BRAINSTORM }] },
      toolCallId: 'toolu_1',
      _meta: { idempotencyKey: 'k1' },
    };
    await expect(
      runtime.instruction('core.agent.deferredTools.load', params, {
        caller: caller([CORE_AGENT_DEFERRED_TOOLS_GRANTS.search]),
        metadata: { idempotencyKey: 'k1' },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      runtime.query(
        'core.agent.deferredTools.search',
        {
          recipient: params.recipient,
          session: params.session,
          input: { queries: [{ text: 'x' }] },
        },
        { caller: caller([CORE_AGENT_DEFERRED_TOOLS_GRANTS.load]) },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("a managed delegate's in-run load applies the same issued-ref check", async () => {
    const delegate = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'delegation-d1',
    };
    const reloadSink = {
      request: jest.fn(() => ({ accepted: true as const, reloadId: 'r1' })),
    };
    const runtime = { ...session(delegate), reloadSink };
    const refused = await load(delegate, [BRAINSTORM], undefined, runtime);
    expect(refused.result.rejected[0]?.message).toBe(
      DEFERRED_REF_NOT_ISSUED_MESSAGE,
    );
    await search(delegate, 'brainstorm');
    const loaded = await load(delegate, [BRAINSTORM], undefined, runtime);
    expect(loaded.result.status).toBe('success');
    expect(reloadSink.request).toHaveBeenCalledTimes(1);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('search reads the catalog snapshot through the dispatcher with only the catalog read grant (CAN-6034)', async () => {
    const runtime = mockFixture.runtime;
    if (!runtime) throw new Error('No runtime.');
    const query = jest.spyOn(runtime, 'query');
    await search(CHAT, 'brainstorm');
    const reads = query.mock.calls.filter(
      ([operation]) => operation === 'core.catalog.snapshot.get',
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]?.[1]).toEqual({
      scope: {},
      kinds: ['skill', 'plugin', 'mcp_server'],
      includeUnavailable: true,
    });
    const options = reads[0]?.[2] as
      | { caller: CanopyCallerDescriptor }
      | undefined;
    expect(options?.caller.principalId).toBe('desktop-agent-deferred-tools');
    expect(options?.caller.grants).toEqual(['core.catalog.read']);
  });

  it('no renderer relay or Portal session reaches either operation', () => {
    for (const mode of Object.values(INTERFACE_RELAY_ALLOWLIST))
      for (const operations of Object.values(mode))
        expect(
          operations.filter((name) => name.startsWith('core.agent.')),
        ).toEqual([]);
  });
});
