import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mcpServerEntryId,
  pluginEntryId,
  skillEntryId,
} from '@canopy/protocol/canopy-core';
import { INHERITED_PLUGIN_DEFAULTS_VERSION } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import type {
  ChatTabPluginSelections,
  ChatTabsFile,
  PreferencesData,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type {
  MarketplaceInfo,
  MarketplaceProviderStatus,
  PluginInfo,
} from '@canopy/execution-engine/types/plugins';
import type { InstalledItemRef } from '@canopy/protocol/installed-items';
import {
  createDesktopMaterializationResolver,
  createDesktopWorkerCatalogHost,
  type DesktopMaterializationDeps,
} from '../catalog-materialization-host';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  readPluginCatalog,
  readPluginCacheIndex,
} from '@canopy/execution-engine/node/plugins/catalog-read-health';
import { relayAllows } from '../renderer-relay/surface-allowlist';
import {
  mcpServerConfigRevision,
  type DescribedMcpServer,
} from '../../mcp/mcp-materialization';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

const scope = { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' };
const origin = { kind: 'client', sourceId: 'test' } as const;
const owner = { kind: 'system', id: 'test' } as const;
const ref = (name: string): { marketplaceId: string; pluginName: string } => ({
  marketplaceId: 'm',
  pluginName: name,
});

const selections = (
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections => ({
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
  ...overrides,
});

function status(provider: 'claude' | 'codex'): MarketplaceProviderStatus {
  return {
    provider,
    state: 'valid',
    accepted: true,
    pluginCount: 1,
    lastCheckedAt: '2026-11-05T00:00:00.000Z',
  };
}

function pluginInfo(name: string, dir: string): PluginInfo {
  return {
    name,
    sourcePath: dir,
    marketplaceId: 'm',
    version: '1.0.0',
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {
      claude: {
        provider: 'claude',
        mode: 'native',
        name,
        installLocation: dir,
        sourcePath: dir,
      },
    },
  };
}

function marketplace(
  plugins: PluginInfo[],
  lastUpdated = '2026-11-05T00:00:00.000Z',
): MarketplaceInfo {
  return {
    id: 'm',
    name: 'm',
    sourceType: 'github',
    sourceUrl: 'https://github.com/owner/m',
    installLocation: '/cache',
    pluginCount: plugins.length,
    plugins,
    lastUpdated,
    providerStatus: { claude: status('claude'), codex: status('codex') },
    validProviders: ['claude', 'codex'],
  };
}

interface Fakes {
  /** The stores as their serialized text, so a test can compare bytes. */
  stores: { preferences: string; workspace: string; tabs: string };
  marketplaces: MarketplaceInfo[];
  disabled: Set<string>;
  dirs: Map<string, string>;
  deps: DesktopMaterializationDeps;
}

function fakes(root: string): Fakes {
  const dirs = new Map(
    ['g', 'w'].map((name) => {
      const dir = join(root, 'plugins', name);
      mkdirSync(dir, { recursive: true });
      return [name, dir];
    }),
  );
  const preferences: PreferencesData = {
    ...DEFAULT_PREFERENCES,
    globalPluginSelections: selections({ pluginRefs: [ref('g')] }),
  };
  const workspace: WorkspaceConfigFile = {
    version: 1,
    type: 'single-repo',
    repos: [],
    defaultPluginSelections: selections({ pluginRefs: [ref('w')] }),
  };
  const tabs: ChatTabsFile = {
    version: 1,
    activeTabId: 'chat',
    tabs: [
      {
        id: 'chat',
        title: 'Chat',
        messages: [],
        createdAt: '2026-11-05T00:00:00.000Z',
        disabledGlobalPluginSelections: { pluginRefs: [ref('w')] },
        inheritedPluginDefaultsVersion: INHERITED_PLUGIN_DEFAULTS_VERSION,
      },
    ],
  };
  const state: Omit<Fakes, 'deps'> = {
    stores: {
      preferences: JSON.stringify(preferences),
      workspace: JSON.stringify(workspace),
      tabs: JSON.stringify(tabs),
    },
    marketplaces: [
      marketplace([...dirs].map(([name, dir]) => pluginInfo(name, dir))),
    ],
    disabled: new Set(),
    dirs,
  };
  const isDisabled = (item: InstalledItemRef): boolean =>
    item.kind === 'plugin' && state.disabled.has(item.pluginName);
  const deps: DesktopMaterializationDeps = {
    readPreferences: () =>
      Promise.resolve({
        preferences: JSON.parse(state.stores.preferences) as PreferencesData,
        authority: 'ok',
      }),
    readWorkspaceConfig: () =>
      Promise.resolve({
        config: JSON.parse(state.stores.workspace) as WorkspaceConfigFile,
        authority: 'ok',
      }),
    readWorkspaceRevision: () => Promise.resolve(3),
    readChatTabs: () =>
      Promise.resolve(JSON.parse(state.stores.tabs) as ChatTabsFile),
    normalizeAccountSelections: (value) => Promise.resolve(value),
    normalizeAccountTombstones: (value) => Promise.resolve(value),
    loadMarketplacesCacheOnly: () =>
      Promise.resolve({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-11-05T00:00:00.000Z',
          marketplaces: state.marketplaces,
        },
      }),
    resolveEffectiveRefs: (value, warnings) => {
      const plugins = value.pluginRefs.map((item) => ({
        kind: 'plugin' as const,
        ...item,
      }));
      return Promise.resolve({
        disabledRefs: plugins.filter(isDisabled),
        skillRefs: value.skillRefs,
        pluginRefs: value.pluginRefs.filter(
          (item) => !state.disabled.has(item.pluginName),
        ),
        mcpServerRefs: value.mcpServerRefs ?? [],
        warnings,
      });
    },
    resolvePluginRoot: (plugin) =>
      Promise.resolve(state.dirs.get(plugin.name) ?? null),
    realpath: (path) => realpath(path),
    readLockSnapshot: () =>
      Promise.resolve({ state: 'ok', entries: new Map() }),
    readSkillFile: (path) => readFile(path),
    skillExists: (path) => existsSync(path),
    resolveSkillDirectory: (item) =>
      Promise.resolve(join(root, 'skills', item.sourceId, item.skillName)),
    canonicalSkillDirectory: (item) =>
      Promise.resolve(join(root, 'skills', item.sourceId, item.skillName)),
    describeMcpServer: () => Promise.resolve(null),
  };
  return Object.assign(state, { deps });
}

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher | null;

function start(
  f: Fakes,
  worker: Partial<DesktopMaterializationDeps> = {},
): DesktopCanopyDispatcher {
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
    workerCatalogHost: createDesktopWorkerCatalogHost({
      ...f.deps,
      ...worker,
    }),
    catalogMaterializationResolver: createDesktopMaterializationResolver(
      f.deps,
    ),
  });
  return runtime;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4123-materialize-'));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = null;
});
afterEach(async () => {
  await runtime?.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('desktop catalog materialization (CAN-4123)', () => {
  it.each(
    ['catalog', 'index'].flatMap((file) =>
      ['damaged', 'unsupported'].flatMap((state) =>
        ['selection', 'worker'].map((stage) => ({ file, state, stage })),
      ),
    ),
  )(
    '$stage keeps resolving when $file becomes $state during awaited resolution',
    async ({ file, state, stage }) => {
      const f = fakes(root);
      const catalogPath = join(root, 'plugins-cache.json');
      const indexPath = join(root, 'plugin-cache-index.json');
      writeFileSync(
        catalogPath,
        JSON.stringify({
          version: 2,
          lastRefreshed: '',
          marketplaces: f.marketplaces,
        }),
      );
      writeFileSync(indexPath, JSON.stringify({ version: 1, entries: {} }));
      f.deps.loadMarketplacesCacheOnly = (): ReturnType<
        DesktopMaterializationDeps['loadMarketplacesCacheOnly']
      > => {
        // CAN-4481: a damaged or newer file is read as-is, never refused.
        const catalog = readPluginCatalog(catalogPath);
        expect(readPluginCacheIndex(indexPath).state).toBe('valid');
        return Promise.resolve(
          catalog.state === 'valid'
            ? { success: true, data: catalog.data }
            : { success: false, error: 'Plugin persistence unavailable' },
        );
      };
      const changedPath = file === 'catalog' ? catalogPath : indexPath;
      const bytes = state === 'damaged' ? '{' : '{"version":99}';
      if (stage === 'selection') {
        f.deps.readLockSnapshot = (): ReturnType<
          DesktopMaterializationDeps['readLockSnapshot']
        > => {
          writeFileSync(changedPath, bytes);
          return Promise.resolve({ state: 'ok', entries: new Map() });
        };
        await expect(
          createDesktopMaterializationResolver(f.deps).resolve(scope),
        ).resolves.toMatchObject({
          items: [expect.objectContaining({ kind: 'plugin', pluginName: 'g' })],
        });
      } else {
        f.deps.realpath = (path): Promise<string> => {
          writeFileSync(changedPath, bytes);
          return realpath(path);
        };
        await expect(
          createDesktopWorkerCatalogHost(f.deps).lookupPlugin('m', 'g'),
        ).resolves.toHaveProperty('pluginRevision');
      }
      expect(await readFile(changedPath, 'utf8')).toBe(bytes);
    },
  );

  it("materializes a chat's effective plugins through every layer", async () => {
    const f = fakes(root);
    const desktop = start(f);
    const outcome = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });

    expect(outcome.state).toBe('ready');
    expect(outcome.effectiveItems).toEqual([
      {
        entryId: pluginEntryId(ref('g')),
        kind: 'plugin',
        providers: ['claude'],
      },
    ]);
    expect(
      desktop.catalogMaterializationReader.resolve(outcome.materializationId)
        ?.plugins[0]?.roots.claude,
    ).toBe(realpathSync(f.dirs.get('g') ?? ''));
  });

  it('a failed materialization leaves every selection file byte-identical', async () => {
    const f = fakes(root);
    const before = { ...f.stores };
    const desktop = start(f, {
      loadMarketplacesCacheOnly: () =>
        Promise.resolve({
          success: true,
          data: {
            version: 2,
            lastRefreshed: '2026-11-05T00:00:00.000Z',
            marketplaces: [
              marketplace(
                [...f.dirs].map(([name, dir]) => pluginInfo(name, dir)),
                '2026-11-06T00:00:00.000Z',
              ),
            ],
          },
        }),
    });
    const outcome = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatchObject({
      code: 'worker.catalog.revisionConflict',
    });
    expect(f.stores).toEqual(before);
  });

  it('honours the installed-item policy', async () => {
    const f = fakes(root);
    f.disabled.add('g');
    const outcome = await start(f).catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });

    expect(outcome.unavailable).toContainEqual({
      entryId: pluginEntryId(ref('g')),
      reason: 'disabled',
    });
    expect(
      outcome.effectiveItems.some(
        (item) => item.entryId === pluginEntryId(ref('g')),
      ),
    ).toBe(false);
  });

  it('materializes skills and MCP servers', async () => {
    const f = fakes(root);
    mkdirSync(join(root, 'skills', 's', 'sk'), { recursive: true });
    writeFileSync(join(root, 'skills', 's', 'sk', 'SKILL.md'), '# sk\n');
    const mcpServer = { serverId: 'srv', configId: 'cfg' };
    const described: DescribedMcpServer = {
      descriptor: {
        kind: 'mcp_server',
        entryId: mcpServerEntryId(mcpServer),
        ...mcpServer,
        transport: 'http',
        binding: 'account',
        configRevision: mcpServerConfigRevision({
          binding: 'account',
          index: { id: 'srv' },
          server: null,
        }),
        secretRefs: [],
      },
      displayName: 'Server',
      enabled: true,
      pinned: { binding: 'account', index: { id: 'srv' }, server: null },
    };
    f.deps.describeMcpServer = (): Promise<DescribedMcpServer> =>
      Promise.resolve(described);
    const tabs = JSON.parse(f.stores.tabs) as ChatTabsFile;
    const [tab] = tabs.tabs;
    if (!tab) throw new Error('No chat tab');
    tab.pluginSelections = selections({
      skillRefs: [{ sourceId: 's', skillName: 'sk' }],
      mcpServerRefs: [mcpServer],
    });
    f.stores.tabs = JSON.stringify(tabs);
    const outcome = await start(f).catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });

    expect(outcome.deferred).toEqual([]);
    expect(outcome.effectiveItems).toContainEqual({
      entryId: skillEntryId({ sourceId: 's', skillName: 'sk' }),
      kind: 'skill',
    });
    expect(outcome.effectiveItems).toContainEqual(
      expect.objectContaining({
        entryId: mcpServerEntryId(mcpServer),
        kind: 'mcp_server',
      }),
    );
    expect(outcome.effectiveItems.map((item) => item.entryId)).toContain(
      pluginEntryId(ref('g')),
    );
  });

  it('refuses the worker materialization instructions to interface callers', () => {
    for (const surface of ['main', 'app-advisor'] as const) {
      expect(
        relayAllows(surface, 'instruction', 'worker.catalog.materialize'),
      ).toBe(false);
      expect(
        relayAllows(
          surface,
          'instruction',
          'worker.catalog.materialization.release',
        ),
      ).toBe(false);
    }
    expect(
      relayAllows('main', 'query', 'worker.catalog.materialization.get'),
    ).toBe(true);
  });
});
