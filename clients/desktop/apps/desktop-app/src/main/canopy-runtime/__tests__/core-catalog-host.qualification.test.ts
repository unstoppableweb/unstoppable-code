import { CanopyOperationError } from '@canopy/core-runtime';
import {
  CatalogHostRefusedError,
  CatalogSelectionNotFoundError,
  CatalogSelectionUnavailableError,
  catalogContentRevision,
  type CatalogSelectionScope,
} from '@canopy/core-runtime/node/catalog';
import {
  CatalogEntrySchema,
  CoreWorkspacePluginsUpdateParamsSchema,
  catalogSelectionRefsOf,
  collectionEntryId,
  mcpServerEntryId,
  pluginEntryId,
  skillEntryId,
  type CanopyCallerDescriptor,
  type CatalogPluginHarnesses,
} from '@canopy/protocol/canopy-core';
import type { PortalPluginCatalog } from '@canopy/protocol/portal';
import { INHERITED_PLUGIN_DEFAULTS_VERSION } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  ChatTabPluginSelections,
  ChatTabsFile,
  PersistedChatTab,
  PreferencesData,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type {
  MarketplaceInfo,
  MarketplaceProviderStatus,
  PluginInfo,
} from '@canopy/execution-engine/types/plugins';
import { RELAY_DEFINITIONS } from '../renderer-relay/definitions';
import {
  createDesktopCatalogHost,
  type DesktopCatalogHostDeps,
} from '../core-catalog-host';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

const ref = (name: string): { marketplaceId: string; pluginName: string } => ({
  marketplaceId: 'm',
  pluginName: name,
});

const catalog: PortalPluginCatalog = {
  collections: [
    {
      id: 'col',
      name: 'Collection',
      description: '',
      skillCount: 1,
      pluginCount: 1,
      mcpServerCount: 0,
    },
  ],
  skills: [
    {
      sourceId: 's',
      skillName: 'sk',
      name: 'Skill',
      description: '',
      source: 'user',
    },
  ],
  plugins: [
    {
      marketplaceId: 'm',
      pluginName: 'p1',
      name: 'Plugin one',
      description: '',
      marketplaceName: 'M',
      claudeSupported: true,
      codexSupported: false,
    },
    {
      marketplaceId: 'm',
      pluginName: 'p2',
      name: 'Plugin two',
      description: '',
      marketplaceName: 'M',
      claudeSupported: false,
      codexSupported: false,
    },
  ],
  mcpServers: [
    {
      serverId: 'srv',
      configId: 'cfg',
      serverName: 'Server',
      configName: 'Default',
      description: '',
      transport: 'http',
    },
  ],
};

function status(
  provider: 'claude' | 'codex',
  accepted: boolean,
): MarketplaceProviderStatus {
  return {
    provider,
    state: accepted ? 'valid' : 'invalid',
    accepted,
    pluginCount: 1,
    lastCheckedAt: '2026-11-05T00:00:00.000Z',
  };
}

function marketplace(
  id: string,
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return {
    id,
    name: id,
    sourceType: 'github',
    sourceUrl: `https://github.com/owner/${id}`,
    installLocation: '/cache',
    pluginCount: 0,
    plugins: [],
    providerStatus: {
      claude: status('claude', true),
      codex: status('codex', true),
    },
    validProviders: ['claude', 'codex'],
    ...overrides,
  };
}

function harnesses(member: string): CatalogPluginHarnesses {
  const harness = (supported: boolean): CatalogPluginHarnesses['claude'] => ({
    supported,
    enabled: true,
    installed: supported,
    members: supported
      ? [{ kind: 'skill' as const, name: member, description: '' }]
      : [],
  });
  return {
    claude: harness(true),
    codex: harness(false),
    ollama: harness(true),
    copilot: harness(false),
    opencode: harness(false),
  };
}

function workspaceConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return { version: 1, type: 'single-repo', repos: [], ...overrides };
}

interface WorkspaceRead {
  config: WorkspaceConfigFile;
  authority: 'ok' | 'absent' | 'unreadable';
}

interface Fakes {
  deps: DesktopCatalogHostDeps;
  preferences: {
    value: PreferencesData;
    authority: 'ok' | 'absent' | 'unreadable';
    writes: number;
  };
  workspaces: Map<string, WorkspaceRead>;
  revisions: Map<string, number>;
  tabs: PersistedChatTab[];
  chatTabsError: Error | null;
  marketplaces: MarketplaceInfo[];
  dispatched: {
    params: Parameters<
      DesktopCatalogHostDeps['dispatchWorkspacePluginsUpdate']
    >[0];
    caller: CanopyCallerDescriptor;
  }[];
  dispatchError: Error | null;
  afterGlobalSelectionChanged: jest.Mock;
}

function tab(overrides: Partial<PersistedChatTab>): PersistedChatTab {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [],
    createdAt: '2026-11-05T00:00:00.000Z',
    ...overrides,
  };
}

function fakes(): Fakes {
  const state: Omit<Fakes, 'deps'> = {
    preferences: {
      value: { ...DEFAULT_PREFERENCES },
      authority: 'ok',
      writes: 0,
    },
    workspaces: new Map<string, WorkspaceRead>([
      ['ws', { config: workspaceConfig(), authority: 'ok' }],
    ]),
    revisions: new Map([['ws', 3]]),
    tabs: [tab({})],
    chatTabsError: null,
    marketplaces: [],
    dispatched: [],
    dispatchError: null,
    afterGlobalSelectionChanged: jest.fn(() => Promise.resolve()),
  };
  const deps: DesktopCatalogHostDeps = {
    buildCachedPluginCatalog: () => Promise.resolve(catalog),
    readCollection: (id) =>
      Promise.resolve(
        id === 'col'
          ? {
              skills: [{ sourceId: 's', skillName: 'sk' }],
              plugins: [ref('p1')],
            }
          : null,
      ),
    loadMarketplacesCacheOnly: () =>
      Promise.resolve({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-11-05T00:00:00.000Z',
          marketplaces: state.marketplaces,
        },
      }),
    readPluginHarnessFacts: (_marketplace, plugin) =>
      Promise.resolve(harnesses(plugin.name)),
    readInstalledItemPolicy: () =>
      Promise.resolve({
        isDisabled: (item) => item.kind === 'skill',
      }),
    readPreferences: () =>
      Promise.resolve({
        preferences: state.preferences.value,
        authority: state.preferences.authority,
      }),
    updatePreferences: (updater) => {
      const previous = state.preferences.value;
      const patch = updater(previous);
      if (patch === null) return Promise.resolve({ previous, next: previous });
      state.preferences.writes += 1;
      state.preferences.value = { ...previous, ...patch };
      return Promise.resolve({ previous, next: state.preferences.value });
    },
    afterGlobalSelectionChanged: state.afterGlobalSelectionChanged,
    readWorkspaceConfig: (id) =>
      Promise.resolve(
        state.workspaces.get(id) ?? {
          config: workspaceConfig(),
          authority: 'absent',
        },
      ),
    readWorkspaceRevision: (id) =>
      Promise.resolve(state.revisions.get(id) ?? 0),
    readChatTabs: (): Promise<ChatTabsFile> =>
      state.chatTabsError
        ? Promise.reject(state.chatTabsError)
        : Promise.resolve({
            version: 1,
            tabs: state.tabs,
            activeTabId: 'chat',
          }),
    normalizeAccountSelections: (value) => Promise.resolve(value),
    normalizeAccountTombstones: (value) => Promise.resolve(value),
    dispatchWorkspacePluginsUpdate: (params, caller) => {
      state.dispatched.push({ params, caller });
      return state.dispatchError
        ? Promise.reject(state.dispatchError)
        : Promise.resolve({
            workspaceId: params.workspaceId,
            written: true,
            ...(params.change.kind === 'setDefaults' &&
            params.change.defaultPluginSelections !== null
              ? {
                  defaultPluginSelections:
                    params.change.defaultPluginSelections,
                }
              : {}),
          });
    },
  };
  return Object.assign(state, { deps });
}

const chatScope: CatalogSelectionScope = {
  kind: 'chat',
  workspaceId: 'ws',
  worktreeId: 'wt',
  chatId: 'chat',
};

const caller: CanopyCallerDescriptor = {
  principalId: 'user',
  clientInstanceId: 'renderer',
  authorityId: 'local',
  interfaceKind: 'desktop',
  grants: ['core.catalog.write'],
};

const pluginSelections = (...names: string[]): ChatTabPluginSelections => ({
  collectionIds: [],
  skillRefs: [],
  pluginRefs: names.map(ref),
  mcpServerRefs: [],
});

describe('desktop catalog host (CAN-4123)', () => {
  it('serves the cached catalog as closed entries with the shared ids', async () => {
    const host = createDesktopCatalogHost(fakes().deps);
    const { entries } = await host.snapshot();

    for (const entry of entries)
      expect(CatalogEntrySchema.safeParse(entry).success).toBe(true);
    const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
    expect([...byId.keys()].sort()).toEqual(
      [
        skillEntryId({ sourceId: 's', skillName: 'sk' }),
        pluginEntryId(ref('p1')),
        pluginEntryId(ref('p2')),
        mcpServerEntryId({ serverId: 'srv', configId: 'cfg' }),
        collectionEntryId('col'),
      ].sort(),
    );
    expect(byId.get('skill:s/sk')?.availability).toBe('disabled');
    expect(byId.get('plugin:m/p2')?.availability).toBe('incompatible');
    expect(byId.get('plugin:m/p1')?.availability).toBe('available');
    expect(byId.get('collection:col')?.content).toEqual({
      kind: 'collection',
      entryIds: ['skill:s/sk', 'plugin:m/p1'],
    });
  });

  it('adds the harness facts, source labels and description fallback search reads (CAN-6034)', async () => {
    const f = fakes();
    f.marketplaces = [
      marketplace('m', {
        name: 'M',
        description: 'Marketplace description',
        plugins: [
          {
            name: 'p1',
            marketplaceId: 'm',
            sourcePath: '/cache/p1',
            version: '1.0.0',
            providerSupport: { claude: 'native', codex: 'none' },
            facets: {},
          },
        ],
      }),
    ];
    const { entries } = await createDesktopCatalogHost(f.deps).snapshot();
    for (const entry of entries)
      expect(CatalogEntrySchema.safeParse(entry).success).toBe(true);
    const byId = new Map(entries.map((entry) => [entry.entryId, entry]));

    const p1 = byId.get(pluginEntryId(ref('p1')));
    expect(p1?.description).toBe('Marketplace description');
    expect(p1?.sourceLabel).toBe('M');
    expect(p1?.content).toMatchObject({ harnesses: harnesses('p1') });
    // A row the cache doesn't hold carries no facts rather than guessed ones.
    const p2 = byId.get(pluginEntryId(ref('p2')));
    expect(p2?.content.kind === 'plugin' && p2.content.harnesses).toBe(
      undefined,
    );
    expect(byId.get('skill:s/sk')?.sourceLabel).toBe('user');
    const server = byId.get(
      mcpServerEntryId({ serverId: 'srv', configId: 'cfg' }),
    );
    expect(server?.sourceLabel).toBe('Server');
    expect(server?.content).toMatchObject({ configName: 'Default' });
  });

  it("serves the snapshot when one plugin's facts cannot be read", async () => {
    const f = fakes();
    const plugin = (name: string): PluginInfo => ({
      name,
      marketplaceId: 'm',
      sourcePath: `/cache/${name}`,
      version: '1.0.0',
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {},
    });
    f.marketplaces = [
      marketplace('m', { plugins: [plugin('p1'), plugin('p2')] }),
    ];
    const { entries } = await createDesktopCatalogHost({
      ...f.deps,
      readPluginHarnessFacts: (_marketplace, row) =>
        row.name === 'p2'
          ? Promise.reject(new Error('Invalid MCP OAuth token store'))
          : Promise.resolve(harnesses(row.name)),
    }).snapshot();
    const content = (id: string): unknown =>
      entries.find((entry) => entry.entryId === id)?.content;
    expect(content(pluginEntryId(ref('p1')))).toMatchObject({
      harnesses: harnesses('p1'),
    });
    expect(content(pluginEntryId(ref('p2')))).not.toHaveProperty('harnesses');
  });

  it("reads a chat's effective selection through every layer and its tombstones", async () => {
    const f = fakes();
    f.preferences.value = {
      ...f.preferences.value,
      globalPluginSelections: pluginSelections('g', 'g2'),
    };
    f.workspaces.set('ws', {
      config: workspaceConfig({
        defaultPluginSelections: pluginSelections('w'),
        disabledGlobalPluginSelections: { pluginRefs: [ref('g2')] },
      }),
      authority: 'ok',
    });
    f.tabs = [
      tab({
        pluginSelections: pluginSelections('l'),
        disabledGlobalPluginSelections: { pluginRefs: [ref('w')] },
        inheritedPluginDefaultsVersion: INHERITED_PLUGIN_DEFAULTS_VERSION,
      }),
    ];
    const host = createDesktopCatalogHost(f.deps);
    const read = await host.readSelection(chatScope);

    expect(
      read.selections.pluginRefs.map((item) => item.pluginName).sort(),
    ).toEqual(['g', 'l']);
    expect(read.tombstones?.pluginRefs).toEqual([ref('w')]);

    f.tabs = [
      tab({
        pluginSelections: pluginSelections('l'),
        disabledGlobalPluginSelections: { pluginRefs: [ref('w'), ref('g')] },
        inheritedPluginDefaultsVersion: INHERITED_PLUGIN_DEFAULTS_VERSION,
      }),
    ];
    expect((await host.readSelection(chatScope)).revision).not.toBe(
      read.revision,
    );
  });

  it('reads an app-managed chat that has no workspace manifest', async () => {
    const f = fakes();
    f.preferences.value = {
      ...f.preferences.value,
      globalPluginSelections: pluginSelections('g'),
    };
    f.tabs = [tab({ pluginSelections: pluginSelections('l') })];
    const host = createDesktopCatalogHost(f.deps);
    const read = await host.readSelection({
      ...chatScope,
      workspaceId: APP_ADVISOR_PROJECT_ID,
    });

    expect(read.selections.pluginRefs).toEqual([ref('l')]);
  });

  it('the renderer relay reaches the catalog reads', () => {
    for (const name of [
      'core.catalog.snapshot.get',
      'core.catalog.selection.get',
      'core.catalog.source.list',
    ])
      expect(Object.hasOwn(RELAY_DEFINITIONS.queries, name)).toBe(true);
  });

  it('never serves an unreadable layer as empty', async () => {
    const f = fakes();
    const host = createDesktopCatalogHost(f.deps);

    f.preferences.authority = 'unreadable';
    await expect(host.readSelection(chatScope)).rejects.toBeInstanceOf(
      CatalogSelectionUnavailableError,
    );
    f.preferences.authority = 'ok';
    f.workspaces.set('ws', {
      config: workspaceConfig(),
      authority: 'unreadable',
    });
    await expect(host.readSelection(chatScope)).rejects.toBeInstanceOf(
      CatalogSelectionUnavailableError,
    );
    f.workspaces.set('ws', { config: workspaceConfig(), authority: 'ok' });
    f.chatTabsError = new Error('chat file busy');
    await expect(host.readSelection(chatScope)).rejects.toBeInstanceOf(
      CatalogSelectionUnavailableError,
    );
    f.chatTabsError = null;
    f.tabs = [];
    await expect(host.readSelection(chatScope)).rejects.toBeInstanceOf(
      CatalogSelectionNotFoundError,
    );
  });

  it('replaces the global defaults under their revision', async () => {
    const f = fakes();
    f.preferences.value = {
      ...f.preferences.value,
      globalPluginSelections: {
        ...pluginSelections('g'),
        mcpHttpAuthPreferences: [],
      },
    };
    const host = createDesktopCatalogHost(f.deps);
    const before = await host.readSelection({ kind: 'global' });

    const replaced = await host.replaceGlobalSelection(
      before.revision,
      catalogSelectionRefsOf(pluginSelections('p1')),
    );
    expect(replaced.outcome).toBe('replaced');
    expect(f.preferences.value.globalPluginSelections?.pluginRefs).toEqual([
      ref('p1'),
    ]);
    expect(
      f.preferences.value.globalPluginSelections?.mcpHttpAuthPreferences,
    ).toEqual([]);
    expect(f.afterGlobalSelectionChanged).toHaveBeenCalledTimes(1);
    expect(replaced.read.revision).toBe(
      catalogContentRevision(catalogSelectionRefsOf(pluginSelections('p1'))),
    );

    const writes = f.preferences.writes;
    const stale = await host.replaceGlobalSelection(
      before.revision,
      catalogSelectionRefsOf(pluginSelections('p2')),
    );
    expect(stale.outcome).toBe('conflict');
    expect(f.preferences.writes).toBe(writes);
  });

  it('replaces workspace defaults through core.workspace.plugins.update', async () => {
    const f = fakes();
    const host = createDesktopCatalogHost(f.deps);
    await host.replaceWorkspaceSelection({
      workspaceId: 'ws',
      expectedRevision: 3,
      refs: catalogSelectionRefsOf(pluginSelections('p1')),
      idempotencyKey: 'catalog-selection:k',
      caller,
    });

    expect(f.dispatched).toHaveLength(1);
    const [call] = f.dispatched;
    expect(
      CoreWorkspacePluginsUpdateParamsSchema.safeParse(call?.params).success,
    ).toBe(true);
    expect(call?.params.change.kind).toBe('setDefaults');
    expect(call?.caller).toEqual({
      ...caller,
      grants: ['core.workspace.write'],
    });

    f.dispatchError = new CanopyOperationError({
      kind: 'conflict',
      code: 'core.workspace.revisionConflict',
      message: 'm',
      retry: { kind: 'never' },
    });
    const refused = await host
      .replaceWorkspaceSelection({
        workspaceId: 'ws',
        expectedRevision: 2,
        refs: catalogSelectionRefsOf(pluginSelections('p1')),
        idempotencyKey: 'catalog-selection:k2',
        caller,
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CatalogHostRefusedError);
    expect(
      refused instanceof CatalogHostRefusedError ? refused.refusal : null,
    ).toBe('workspace-revision-conflict');
  });

  it('returns the committed workspace defaults and bounds the forwarded key', async () => {
    const f = fakes();
    const host = createDesktopCatalogHost(f.deps);
    const longKey = `catalog-selection:${'k'.repeat(512)}`;
    const read = await host.replaceWorkspaceSelection({
      workspaceId: 'ws',
      expectedRevision: 3,
      refs: catalogSelectionRefsOf(pluginSelections('p1')),
      idempotencyKey: longKey,
      caller,
    });

    const forwarded = f.dispatched[0]?.params._meta.idempotencyKey ?? '';
    expect(forwarded.length).toBeLessThanOrEqual(512);
    expect(forwarded).not.toBe(longKey);
    // Another writer changed the defaults; the reply is still what was committed.
    f.workspaces.set('ws', {
      config: workspaceConfig({
        defaultPluginSelections: pluginSelections('p2'),
      }),
      authority: 'ok',
    });
    const replay = await host.replaceWorkspaceSelection({
      workspaceId: 'ws',
      expectedRevision: 3,
      refs: catalogSelectionRefsOf(pluginSelections('p1')),
      idempotencyKey: longKey,
      caller,
    });
    expect(replay.selections.pluginRefs).toEqual([ref('p1')]);
    expect(read.selections.pluginRefs).toEqual([ref('p1')]);
    expect(f.dispatched[1]?.params._meta.idempotencyKey).toBe(forwarded);
  });

  // The rows behind core.catalog.source.list.
  it('lists marketplaces as sources with content revisions', async () => {
    const f = fakes();
    const plugin = (version: string): PluginInfo => ({
      name: 'p',
      marketplaceId: 'gh',
      sourcePath: '/cache/p',
      version,
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {},
    });
    f.marketplaces = [
      marketplace('builtin-id', { builtIn: true, sourceType: 'builtin' }),
      marketplace('curated-id', { curated: true, sourceType: 'curated' }),
      marketplace('gh', { plugins: [plugin('1.0.0')] }),
      marketplace('dir', { sourceType: 'directory', sourceUrl: '/tmp/dir' }),
    ];
    const host = createDesktopCatalogHost(f.deps);
    const sources = await host.listSources();

    expect(sources.map((source) => [source.sourceId, source.locator])).toEqual([
      ['builtin-id', { kind: 'builtin', builtinId: 'builtin-id' }],
      ['curated-id', { kind: 'curated', catalogId: 'curated-id' }],
      ['gh', { kind: 'git', repository: 'owner/gh', ref: null }],
    ]);

    f.marketplaces = f.marketplaces.map((row) =>
      row.id === 'gh' ? { ...row, plugins: [plugin('2.0.0')] } : row,
    );
    const after = await host.listSources();
    const revisions = (list: typeof sources): Record<string, number> =>
      Object.fromEntries(
        list.map((source) => [source.sourceId, source.revision]),
      );
    expect(revisions(after).gh).not.toBe(revisions(sources).gh);
    expect(revisions(after)['builtin-id']).toBe(
      revisions(sources)['builtin-id'],
    );
    expect(revisions(after)['curated-id']).toBe(
      revisions(sources)['curated-id'],
    );
  });
});
