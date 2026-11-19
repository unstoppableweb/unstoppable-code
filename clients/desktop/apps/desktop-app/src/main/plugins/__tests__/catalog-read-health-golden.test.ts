import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as atomicFile from '@canopy/execution-engine/node/lib/atomic-file';
import {
  StorageOutcomeUnknownError,
  assertAdmittedWriter,
  STORAGE_OWNERSHIP,
} from '@canopy/core-runtime/storage';
import * as storageAuthority from '@canopy/core-runtime/storage';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  CatalogPublicationError,
  observePluginCatalog,
  publishPluginCatalog,
  publishPluginCachePair,
  notePluginCatalogEffects,
  withPluginCatalogScan,
} from '../plugin-catalog-store';
import {
  runSerializedPluginMutation,
  enqueueDetachedPluginMutation,
} from '../plugin-mutation-queue';
import { refreshInvocableInventoryAfterMutation } from '../invocable-inventory-service';
import {
  readPluginCatalog,
  readPluginCacheIndex,
} from '@canopy/execution-engine/node/plugins/catalog-read-health';
import * as scanner from '../plugin-scanner';
import * as readHealth from '@canopy/execution-engine/node/plugins/catalog-read-health';
import type * as ConfigPaths from '../../pipelines/config-paths';
import * as configPaths from '../../pipelines/config-paths';
import {
  scanCuratedMarketplace,
  invalidateCuratedMarketplaceScanCache,
  type CuratedMarketplaceScanDeps,
} from '../curated-plugin-marketplace';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import { resolvePlugins } from '@canopy/execution-engine/node/plugins/plugin-resolver';
import type {
  PluginsCache,
  PluginsCacheV1,
} from '@canopy/execution-engine/types/plugins';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/execution-engine/types/plugins';
import {
  addMarketplace,
  installPlugin,
  installBuiltInPlugin,
  loadMarketplaces,
  loadMarketplacesCacheOnly,
  loadMarketplacesForPresentation,
  prepareCodexCompatibilityPlugin,
  readPluginCatalogHealth,
  readPluginIndexHealth,
  refreshMarketplaces,
  resetBuiltInMarketplaceScanCacheForTests,
  scanManagedMarketplacesFresh,
  recordBuiltInPluginInstallError,
  syncCuratedPluginsForRefresh,
  removeInstalledPluginCache,
  removeMarketplace,
  setCodexCompatDisabled,
  setClaudeInstalledItemEnabled,
  uninstallClaudeInstalledItem,
  updateMarketplace,
  flushMarketplaceSelectionPruneForTests,
} from '../plugin-service';
import * as curatedSync from '../curated-plugin-sync';
import { runCuratedMcpRefresh } from '../../mcp/refresh-scheduler';
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../../lib/preferences-store';
import { cloneRepo } from '../../lib/git';
import type * as GitModule from '../../lib/git';
import { execFileSync } from 'node:child_process';
import { getMcpServersIndexFilePath } from '../../lib/paths';
import { runClaudeCliProcessOffMain } from '../../agents/claude-process-host-runner';
import {
  addCodexMarketplace,
  listCodexPlugins,
  removeCodexMarketplace,
  resolveCodexPluginInstallRoots,
  refreshCuratedCodexPlugins,
} from '../codex-marketplace-service';
import { materializeCodexPluginsOffMain } from '../codex-plugin-materialization-runner';
import { readInstalledItemPolicy } from '../../installed-items/installed-item-policy';
import {
  resolveEffectivePluginSelectionRefs,
  resolvePluginInfoPath,
} from '../plugin-resolver';

jest.mock('node:fs', () => ({
  __esModule: true,
  default: jest.requireActual<typeof fs>('node:fs'),
  ...jest.requireActual<typeof fs>('node:fs'),
}));
jest.mock('node:fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual<typeof fsPromises>('node:fs/promises'),
}));
jest.mock('../../lib/e2e-gate', () => ({ isE2eBuild: (): boolean => true }));
jest.mock('../../pipelines/config-paths', () => ({
  __esModule: true,
  ...jest.requireActual<typeof ConfigPaths>('../../pipelines/config-paths'),
  getBundledClaudeBinaryPath: (): string => '/test/claude',
  getEnhancedEnv: (): NodeJS.ProcessEnv => ({}),
}));
jest.mock('../../lib/git', () => ({
  cloneRepo: jest.fn(),
  getHeadCommitSha: jest.fn(),
  getRemoteHeadCommitSha: jest.fn(),
}));
jest.mock('../invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));
jest.mock('../../agents/claude-process-host-runner', () => ({
  runClaudeCliProcessOffMain: jest.fn(),
}));
jest.mock('../codex-plugin-materialization-runner', () => ({
  materializeCodexPluginsOffMain: jest.fn(),
}));
jest.mock('../codex-marketplace-service', () => ({
  isStructuralCodexMarketplaceFailure: jest.fn(),
  addCodexMarketplace: jest.fn(),
  removeCodexMarketplace: jest.fn(),
  resolveCodexPluginInstallRoots: jest.fn(),
  upgradeCodexMarketplace: jest.fn(),
  installCodexPlugin: jest.fn(),
  listCodexPlugins: jest.fn(),
  refreshCuratedCodexPlugins: jest.fn(),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
  updatePreferencesFile: jest.fn(),
  peekPreferencesLoadError: (): null => null,
}));

let root: string;
let catalogPath: string;
let indexPath: string;
let pluginPath: string;
let previousDataDir: string | undefined;
let previousClaudeDir: string | undefined;

function healthy(): PluginsCache {
  return {
    version: 2,
    lastRefreshed: '2026-11-06T00:00:00Z',
    lastProviderRefreshAt: 'stamp',
    marketplaces: [
      {
        id: 'm',
        name: 'm',
        sourceType: 'future-source',
        sourceUrl: 'https://github.com/owner/m',
        installLocation: root,
        pluginCount: 1,
        validProviders: ['claude'],
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'valid',
            accepted: true,
            pluginCount: 1,
            lastCheckedAt: '',
          },
          codex: {
            provider: 'codex',
            state: 'invalid',
            accepted: false,
            pluginCount: 0,
            lastCheckedAt: '',
          },
        },
        plugins: [
          {
            name: 'p',
            marketplaceId: 'm',
            sourcePath: pluginPath,
            owner: { type: 'system' },
            tryNowPrompt: 'example',
            details: {
              skills: [
                {
                  name: 's',
                  description: '',
                  path: 'SKILL.md',
                  userInvocable: false,
                },
              ],
              agents: [{ name: 'a', description: '', filePath: 'AGENT.md' }],
              commands: [{ name: 'c', description: '', filePath: 'c.md' }],
              apps: [{ name: 'app', description: '', filePath: 'app.json' }],
              hooks: [
                {
                  event: 'start',
                  hookType: 'command',
                  matcher: '*',
                  command: 'echo hello',
                },
              ],
              mcpServers: [
                { name: 'mcp', type: 'command', command: 'cmd', args: [] },
              ],
              lspServers: [
                { name: 'lsp', command: 'cmd', args: [], languages: ['ts'] },
              ],
              hasReadme: true,
            },
            providerSupport: { claude: 'native', codex: 'compat' },
            globalInstallStatus: {
              claude: {
                available: true,
                installed: false,
                installError: 'prior failure',
              },
              checkedAt: '',
            },
            facets: {
              claude: {
                name: 'p',
                sourcePath: pluginPath,
                installLocation: pluginPath,
                provider: 'claude',
                mode: 'native',
              },
            },
          },
        ],
      },
    ],
  };
}

function withExtensions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withExtensions);
  if (typeof value !== 'object' || value === null) return value;
  return {
    ...Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withExtensions(entry)]),
    ),
    providerExtension: { nested: ['retained', { future: true }] },
  };
}

function write(value: unknown, file = catalogPath): void {
  fs.writeFileSync(file, JSON.stringify(value));
}
function resolve(): ReturnType<typeof resolvePlugins> {
  return resolvePlugins(
    {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'm', pluginName: 'p' }],
    },
    'project',
    'worktree',
    'chat',
  );
}
function legacy(): PluginsCacheV1 {
  return {
    version: 1,
    lastRefreshed: '',
    marketplaces: [
      {
        id: 'm',
        name: 'm',
        description: '',
        sourceType: 'github',
        sourceUrl: 'https://github.com/owner/m',
        installLocation: root,
        lastUpdated: '',
        pluginCount: 1,
        plugins: [
          {
            name: 'p',
            description: '',
            version: '',
            author: '',
            category: '',
            homepage: '',
            sourcePath: pluginPath,
            marketplaceId: 'm',
            details: null,
            externalSource: null,
            cachePath: pluginPath,
            cachedAt: null,
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-health-'));
  catalogPath = path.join(root, 'plugins-cache.json');
  indexPath = path.join(root, 'plugin-cache-index.json');
  pluginPath = path.join(root, 'plugin');
  fs.mkdirSync(pluginPath);
  previousDataDir = process.env.CANOPY_DATA_DIR;
  previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CANOPY_DATA_DIR = root;
  process.env.CLAUDE_CONFIG_DIR = root;
  jest
    .mocked(readPreferencesFile)
    .mockResolvedValue({ ...DEFAULT_PREFERENCES });
});
afterEach(async () => {
  await flushMarketplaceSelectionPruneForTests();
  await settleDetachedWork();
  jest.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('catalog persistence contract shared by desktop and pipeline execution (CAN-5878)', () => {
  test('historical display normalization never relaxes authority primitive types', async () => {
    const value = healthy();
    const marketplace = value.marketplaces[0];
    const plugin = marketplace.plugins[0];
    for (const patch of [
      { sourcePath: 7 },
      { cachePath: false },
      { externalSource: { url: 42 } },
      { externalSource: { sha: null } },
      { externalSource: { source: false } },
      { facets: { claude: { ...plugin.facets.claude, installLocation: [] } } },
      {
        details: {
          ...plugin.details,
          mcpServers: [{ name: 'm', type: 'command', command: 7 }],
        },
      },
      {
        details: {
          ...plugin.details,
          mcpServers: [{ name: 'm', type: 'http', url: 7 }],
        },
      },
      {
        details: {
          ...plugin.details,
          mcpServers: [{ name: 'm', type: 'command', args: ['valid', 7] }],
        },
      },
      {
        details: { ...plugin.details, lspServers: [{ name: 'l', command: 7 }] },
      },
      {
        details: {
          ...plugin.details,
          lspServers: [{ name: 'l', command: 'lsp', args: [false] }],
        },
      },
      {
        details: {
          ...plugin.details,
          hooks: [{ event: 'start', hookType: 'command', command: 7 }],
        },
      },
    ]) {
      write({
        ...value,
        marketplaces: [{ ...marketplace, plugins: [{ ...plugin, ...patch }] }],
      });
      const before = fs.readFileSync(catalogPath);
      const desktop = readPluginCatalogHealth();
      expect(desktop).toMatchObject({ state: 'valid', recovered: 'damaged' });
      expect(readPluginCatalog(catalogPath)).toEqual(desktop);
      if (desktop.state !== 'valid') throw new Error('expected valid catalog');
      // CAN-4481: read as-is, but the malformed plugin is skipped, never trusted.
      expect(desktop.data.marketplaces[0].plugins).toEqual([]);
      expect((await loadMarketplacesCacheOnly()).success).toBe(true);
      expect(resolve().sdkPlugins).toEqual([]);
      expect(fs.readFileSync(catalogPath)).toEqual(before);
    }
  });

  test('installed-items:list-status distinguishes an absent device MCP index from damage', async () => {
    const { installedItemService } =
      await import('../../installed-items/installed-item-service');
    const index = getMcpServersIndexFilePath();

    expect(fs.existsSync(index)).toBe(false);
    await expect(installedItemService.listStatus()).resolves.toEqual({
      items: [],
    });

    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, '{invalid json');
    await expect(installedItemService.listStatus()).rejects.toThrow();
  });

  test('installed-item management keeps working on a damaged catalog (CAN-4481)', async () => {
    write({ version: 2, marketplaces: [null] });
    const { installedItemService } =
      await import('../../installed-items/installed-item-service');
    await expect(installedItemService.listStatus()).resolves.toEqual({
      items: [],
    });
    const outcomes: string[] = [];
    for (const target of [
      { kind: 'skill', sourceId: 'custom:app', skillName: 's' },
      { kind: 'plugin', marketplaceId: 'm', pluginName: 'p' },
      { kind: 'mcp-config', serverId: 'm', configId: 'c' },
      { kind: 'collection', collectionId: 'c' },
    ] as const) {
      outcomes.push(
        await installedItemService.setStatus({ target, status: 'active' }).then(
          () => 'ok',
          (error: unknown) => String(error),
        ),
      );
    }
    for (const target of [
      { kind: 'plugin', marketplaceId: 'm', pluginName: 'p' },
      { kind: 'skill', sourceId: 'custom:app', skillName: 's' },
    ] as const) {
      outcomes.push(
        await installedItemService.uninstall({ target }).then(
          () => 'ok',
          (error: unknown) => String(error),
        ),
      );
    }
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  });

  test('legacy URL-less sources and malformed descriptive strings remain read-only legacy', async () => {
    const value = legacy();
    const fixture = {
      ...value,
      marketplaces: [
        {
          ...value.marketplaces[0],
          name: false,
          plugins: [
            {
              ...value.marketplaces[0].plugins[0],
              externalSource: {},
              description: 3,
              author: { name: 'old' },
              version: false,
              category: [],
              homepage: null,
            },
          ],
        },
      ],
    };
    write(fixture);
    const before = fs.readFileSync(catalogPath);
    const desktop = readPluginCatalogHealth();
    expect(desktop.state).toBe('legacy');
    expect(readPluginCatalog(catalogPath)).toEqual(desktop);
    if (desktop.state !== 'legacy') throw new Error('expected legacy catalog');
    expect(desktop.data.marketplaces[0]).toMatchObject({
      name: 'm',
      plugins: [
        {
          externalSource: {},
          description: '',
          author: '',
          version: '',
          category: '',
          homepage: '',
        },
      ],
    });
    expect(resolve().sdkPlugins).toEqual([]);
    expect((await loadMarketplacesCacheOnly()).success).toBe(false);
    expect(fs.readFileSync(catalogPath)).toEqual(before);
  });

  test.each([
    { source: 'github', repo: 'owner/repo' },
    { url: 'https://github.com/owner/repo', ref: 'release' },
    { repo: 'owner/repo' },
  ])('refresh retains historical source objects: %j', async (source) => {
    write(healthy());
    jest.mocked(listCodexPlugins).mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    jest
      .mocked(addCodexMarketplace)
      .mockResolvedValue({ accepted: false, error: 'not supported' });
    jest
      .mocked(runClaudeCliProcessOffMain)
      .mockResolvedValue({ stdout: '', stderr: '' });
    fs.mkdirSync(path.join(root, 'plugins'));
    write(
      {
        m: {
          source: { source: 'github', repo: 'owner/m' },
          installLocation: root,
          lastUpdated: '',
        },
      },
      path.join(root, 'plugins', 'known_marketplaces.json'),
    );
    fs.mkdirSync(path.join(root, '.claude-plugin'));
    write(
      { name: 'm', plugins: [{ name: 'p', source }] },
      path.join(root, '.claude-plugin', 'marketplace.json'),
    );
    expect((await refreshMarketplaces()).success).toBe(true);
    const current = readPluginCatalogHealth();
    expect(current.state).toBe('valid');
    if (current.state !== 'valid') throw new Error('expected valid catalog');
    const row = current.data.marketplaces.find((item) => item.id === 'm')
      ?.plugins[0];
    expect(row?.externalSource).toEqual(source);
    expect(row?.facets.claude?.externalSource).toEqual(source);
    expect(row?.sourcePath).toBe('');
    expect(row?.facets.claude?.installLocation).toBe('');
    if (!source.url) {
      if (!row) throw new Error('expected refreshed plugin');
      const marketplace = current.data.marketplaces.find(
        (item) => item.id === 'm',
      );
      if (!marketplace) throw new Error('expected refreshed marketplace');
      expect(resolve().sdkPlugins).toEqual([]);
      expect(
        await resolvePluginInfoPath(row, marketplace, [], true, 'claude'),
      ).toBeNull();
    }
    expect(fs.existsSync(indexPath)).toBe(false);
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  test.each([
    'optional display',
    'required descriptions',
    'marketplace name',
    'languages',
  ])(
    'historical malformed %s normalizes without losing authority or extensions',
    async (kind) => {
      const value = healthy();
      const row = value.marketplaces[0];
      const plugin = row.plugins[0];
      const metadata = {
        description: { old: true },
        author: ['old'],
        version: 7,
        category: false,
        homepage: null,
        displayName: {},
        logoUrl: 4,
      };
      const details = plugin.details;
      if (!details) throw new Error('expected details');
      const fixture =
        kind === 'optional display'
          ? {
              ...value,
              marketplaces: [
                {
                  ...row,
                  description: false,
                  plugins: [
                    {
                      ...plugin,
                      ...metadata,
                      tryNowPrompt: 2,
                      globalInstallStatus: {
                        ...plugin.globalInstallStatus,
                        claude: {
                          ...plugin.globalInstallStatus?.claude,
                          version: 7,
                        },
                      },
                      facets: {
                        claude: { ...plugin.facets.claude, ...metadata },
                      },
                      details: {
                        ...details,
                        hooks: [{ ...details.hooks[0], matcher: 42 }],
                      },
                    },
                  ],
                },
              ],
            }
          : kind === 'required descriptions'
            ? {
                ...value,
                marketplaces: [
                  {
                    ...row,
                    plugins: [
                      {
                        ...plugin,
                        details: {
                          ...details,
                          skills: [{ ...details.skills[0], description: 1 }],
                          agents: [
                            { ...details.agents[0], description: false },
                          ],
                          commands: [
                            { ...details.commands[0], description: {} },
                          ],
                          apps: [{ ...details.apps?.[0], description: null }],
                        },
                      },
                    ],
                  },
                ],
              }
            : kind === 'marketplace name'
              ? { ...value, marketplaces: [{ ...row, name: { old: true } }] }
              : {
                  ...value,
                  marketplaces: [
                    {
                      ...row,
                      plugins: [
                        {
                          ...plugin,
                          details: {
                            ...details,
                            lspServers: [
                              {
                                ...details.lspServers[0],
                                languages: ['ts', 3],
                              },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                };
      write(withExtensions(fixture));
      const before = fs.readFileSync(catalogPath);
      const desktop = readPluginCatalogHealth();
      expect(desktop.state).toBe('valid');
      expect(readPluginCatalog(catalogPath)).toEqual(desktop);
      if (desktop.state !== 'valid') throw new Error('expected valid catalog');
      const normalized = desktop.data.marketplaces[0].plugins[0];
      if (kind === 'optional display') {
        expect(normalized.description).toBeUndefined();
        expect(normalized.author).toBeUndefined();
        expect(normalized.version).toBeUndefined();
        expect(normalized.category).toBeUndefined();
        expect(normalized.homepage).toBeUndefined();
        expect(normalized.displayName).toBeUndefined();
        expect(normalized.logoUrl).toBeUndefined();
        expect(normalized.tryNowPrompt).toBeUndefined();
        expect(normalized.globalInstallStatus?.claude?.version).toBeUndefined();
        expect(normalized.facets.claude?.description).toBeUndefined();
        expect(normalized.details?.hooks[0].matcher).toBeUndefined();
      } else if (kind === 'required descriptions') {
        for (const component of [
          normalized.details?.skills[0],
          normalized.details?.agents[0],
          normalized.details?.commands[0],
          normalized.details?.apps?.[0],
        ])
          expect(component?.description).toBe('');
      } else if (kind === 'marketplace name')
        expect(desktop.data.marketplaces[0].name).toBe('m');
      else expect(normalized.details?.lspServers[0].languages).toBeUndefined();
      expect(resolve().sdkPlugins).toEqual([
        { type: 'local', path: pluginPath },
      ]);
      expect(fs.readFileSync(catalogPath)).toEqual(before);
      await recordBuiltInPluginInstallError(
        { marketplaceId: 'm', pluginName: 'p' },
        'claude',
        'retry',
      );
      const history = normalized.globalInstallStatus?.claude;
      if (!history) throw new Error('expected install history');
      history.installError = 'retry';
      expect(readPluginCatalogHealth()).toEqual(desktop);
      expect(JSON.parse(fs.readFileSync(catalogPath, 'utf8'))).toEqual(
        desktop.data,
      );
    },
  );

  test.each([
    { source: 'github', repo: 'owner/repo' },
    { url: 'https://github.com/owner/repo', ref: 'main' },
    { repo: 'owner/repo' },
  ])(
    'historical source objects read and republish losslessly: %j',
    async (externalSource) => {
      const value = healthy();
      const plugin = value.marketplaces[0].plugins[0];
      const fixture = {
        ...value,
        marketplaces: [
          {
            ...value.marketplaces[0],
            plugins: [
              {
                ...plugin,
                externalSource,
                facets: { claude: { ...plugin.facets.claude, externalSource } },
              },
            ],
          },
        ],
      };
      write(fixture);
      expect(readPluginCatalogHealth()).toEqual({
        state: 'valid',
        data: fixture,
      });
      expect(readPluginCatalog(catalogPath)).toEqual({
        state: 'valid',
        data: fixture,
      });
      expect(resolve().sdkPlugins).toEqual([
        { type: 'local', path: pluginPath },
      ]);
      await recordBuiltInPluginInstallError(
        { marketplaceId: 'm', pluginName: 'p' },
        'claude',
        'retry',
      );
      const after = readPluginCatalogHealth();
      expect(after.state).toBe('valid');
      if (after.state !== 'valid') throw new Error('expected valid catalog');
      expect(after.data.marketplaces[0].plugins[0].externalSource).toEqual(
        externalSource,
      );
      expect(
        after.data.marketplaces[0].plugins[0].facets.claude?.externalSource,
      ).toEqual(externalSource);
      expect(JSON.parse(fs.readFileSync(catalogPath, 'utf8'))).toEqual(
        after.data,
      );
    },
  );

  test.each(['catalog', 'index'])(
    'compatibility preference completion survives %s damage during the operation',
    async (target) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const file = target === 'catalog' ? catalogPath : indexPath;
      jest.mocked(updatePreferencesFile).mockImplementation(() => {
        write({ version: 99 }, file);
        return Promise.resolve(DEFAULT_PREFERENCES);
      });
      expect((await setCodexCompatDisabled('m', 'p', false)).success).toBe(
        true,
      );
      expect(updatePreferencesFile).toHaveBeenCalledTimes(1);
      // Reads never rewrite; this operation publishes neither document.
      expect(fs.readFileSync(file, 'utf8')).toBe('{"version":99}');
    },
  );

  test('Codex policy observation rereads a catalog a newer build wrote during its provider await', async () => {
    const value = healthy();
    const plugin = value.marketplaces[0].plugins[0];
    plugin.facets.codex = {
      provider: 'codex',
      mode: 'native',
      name: 'p',
      installLocation: pluginPath,
      sourcePath: pluginPath,
    };
    plugin.providerSupport.codex = 'native';
    write(value);
    jest.mocked(listCodexPlugins).mockImplementation(() => {
      write({ version: 99 });
      return Promise.resolve({
        marketplaces: [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      });
    });
    const policy = await readInstalledItemPolicy(DEFAULT_PREFERENCES);
    expect(listCodexPlugins).toHaveBeenCalledTimes(1);
    // CAN-4481: the newer file is read as-is, so it doesn't disable plugins.
    expect(policy.hasDisabledKind('plugin')).toBe(false);
    expect(
      policy.isDisabled({
        kind: 'plugin',
        marketplaceId: 'm',
        pluginName: 'p',
      }),
    ).toBe(false);
    expect(
      policy.isDisabled({ kind: 'skill', sourceId: 's', skillName: 's' }),
    ).toBe(false);
  });

  test('a catalog a newer build wrote leaves standalone skills and MCP selectable and executable', async () => {
    write({ version: 99 });
    const selections = {
      collectionIds: [],
      pluginRefs: [{ marketplaceId: 'm', pluginName: 'p' }],
      skillRefs: [{ sourceId: 's', skillName: 's' }],
      mcpServerRefs: [{ serverId: 'm', configId: 'c' }],
    };
    const effective = await resolveEffectivePluginSelectionRefs(
      selections,
      [],
      undefined,
      DEFAULT_PREFERENCES,
    );
    expect(effective.pluginRefs).toEqual(selections.pluginRefs);
    expect(effective.skillRefs).toEqual(selections.skillRefs);
    expect(effective.mcpServerRefs).toEqual(selections.mcpServerRefs);
    const skillDir = path.join(root, 'skills', 's', 's');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: s\ndescription: independent\n---\nSkill',
    );
    fs.mkdirSync(path.join(root, 'mcp-servers'));
    write(
      {
        version: 1,
        server: {
          definition: {
            id: 'm',
            name: 'MCP',
            description: '',
            type: 'command',
            command: 'independent-command',
            createdAt: '',
            updatedAt: '',
          },
          configs: [
            {
              id: 'c',
              name: 'default',
              description: '',
              enabled: true,
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
              createdAt: '',
              updatedAt: '',
            },
          ],
        },
      },
      path.join(root, 'mcp-servers', 'server-m.json'),
    );
    const runtime = resolvePlugins(selections, 'project', 'worktree', 'chat');
    expect(runtime.sdkPlugins).toHaveLength(1);
    expect(runtime.sdkPlugins[0].path).not.toBe(pluginPath);
    expect(Object.values(runtime.mcpServers)).toEqual([
      expect.objectContaining({ command: 'independent-command' }),
    ]);
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe('{"version":99}');
  });

  test('legacy display stays read-only until an explicit refresh observes provider facets', async () => {
    write(legacy());
    const before = fs.readFileSync(catalogPath);
    const presentation = await loadMarketplacesForPresentation(undefined, true);
    expect(
      presentation.data?.marketplaces[0].plugins[0].facets.claude,
    ).toBeDefined();
    expect(fs.readFileSync(catalogPath)).toEqual(before);
    expect((await loadMarketplacesCacheOnly()).success).toBe(false);
    jest.mocked(listCodexPlugins).mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    jest
      .mocked(addCodexMarketplace)
      .mockResolvedValue({ accepted: false, error: 'not supported' });
    jest
      .mocked(runClaudeCliProcessOffMain)
      .mockResolvedValue({ stdout: '', stderr: '' });
    fs.mkdirSync(path.join(root, 'plugins'));
    write(
      {
        m: {
          source: { source: 'github', repo: 'owner/m' },
          installLocation: root,
          lastUpdated: 'stamp',
        },
      },
      path.join(root, 'plugins', 'known_marketplaces.json'),
    );
    fs.mkdirSync(path.join(root, '.claude-plugin'));
    write(
      { name: 'm', plugins: [{ name: 'p', source: './plugin' }] },
      path.join(root, '.claude-plugin', 'marketplace.json'),
    );
    const refreshed = await refreshMarketplaces();
    expect(refreshed.success).toBe(true);
    expect(runClaudeCliProcessOffMain).toHaveBeenCalled();
    expect(readPluginCatalogHealth().state).toBe('valid');
    expect(resolve().sdkPlugins).toEqual([{ type: 'local', path: pluginPath }]);
  });

  test('a legacy refresh without any observed provider keeps the original bytes', async () => {
    write(legacy());
    const before = fs.readFileSync(catalogPath);
    jest.mocked(listCodexPlugins).mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    jest
      .mocked(addCodexMarketplace)
      .mockResolvedValue({ accepted: false, error: 'not supported' });
    jest
      .mocked(runClaudeCliProcessOffMain)
      .mockResolvedValue({ stdout: '', stderr: '' });
    expect((await refreshMarketplaces()).success).toBe(false);
    expect(fs.readFileSync(catalogPath)).toEqual(before);
  });

  test.each(['catalog', 'index'])(
    'provider completion still publishes after %s damage during the operation',
    async (target) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const file = target === 'catalog' ? catalogPath : indexPath;
      jest
        .mocked(runClaudeCliProcessOffMain)
        .mockResolvedValue({ stdout: '', stderr: '' });
      jest.mocked(removeCodexMarketplace).mockImplementation(() => {
        write({ version: 99 }, file);
        return Promise.resolve({ accepted: true });
      });
      expect(
        (await removeMarketplace('m', { providers: ['codex'] })).success,
      ).toBe(true);
      expect(removeCodexMarketplace).toHaveBeenCalledTimes(1);
      // The catalog publication replaces a damaged catalog; an index the
      // operation doesn't publish is left for the next index write.
      const catalog = readPluginCatalogHealth();
      expect(catalog.state).toBe('valid');
      expect(catalog).not.toHaveProperty('recovered');
      if (target === 'index')
        expect(fs.readFileSync(indexPath, 'utf8')).toBe('{"version":99}');
    },
  );

  test('confirmed absence stays empty and cache-only never creates files', async () => {
    expect(readPluginCatalogHealth().state).toBe('absent');
    expect(readPluginCatalog(catalogPath).state).toBe('absent');
    expect(readPluginIndexHealth().state).toBe('absent');
    expect((await loadMarketplacesCacheOnly()).success).toBe(true);
    expect(resolve().sdkPlugins).toEqual([]);
    expect(fs.existsSync(catalogPath)).toBe(false);
    expect(fs.existsSync(indexPath)).toBe(false);
    expect(cloneRepo).not.toHaveBeenCalled();
    expect(runClaudeCliProcessOffMain).not.toHaveBeenCalled();
  });

  test('healthy nested provider extensions survive both readers and a desktop republish', async () => {
    const value = healthy();
    const row = value.marketplaces[0];
    const plugin = row.plugins[0];
    const externalSource = {
      source: 'git-subdir',
      url: 'https://github.com/o/p',
      path: 'plugins/p',
      ref: 'release',
    };
    const fixture = withExtensions({
      ...value,
      marketplaces: [
        {
          ...row,
          plugins: [
            {
              ...plugin,
              externalSource,
              facets: {
                claude: {
                  ...plugin.facets.claude,
                  externalSource,
                  details: plugin.details,
                },
              },
            },
          ],
        },
      ],
    });
    const index = {
      version: 1,
      future: { retained: true },
      entries: {
        'm/p': {
          cachePath: pluginPath,
          sourceUrl: externalSource.url,
          cachedAt: '',
          future: { retained: true },
        },
      },
    };
    write(fixture);
    write(index, indexPath);
    const catalogRead = jest.spyOn(readHealth, 'readPluginCatalog');
    const indexRead = jest.spyOn(readHealth, 'readPluginCacheIndex');
    expect(readPluginCatalogHealth()).toEqual({
      state: 'valid',
      data: fixture,
    });
    expect(readPluginIndexHealth()).toEqual({ state: 'valid', data: index });
    catalogRead.mockClear();
    indexRead.mockClear();
    expect(resolve().sdkPlugins).toEqual([{ type: 'local', path: pluginPath }]);
    expect(catalogRead).toHaveBeenCalledWith(catalogPath);
    expect(catalogRead).toHaveReturnedWith({ state: 'valid', data: fixture });
    // CAN-4481: the index no longer gates execution.
    expect(indexRead).not.toHaveBeenCalled();
    // A writer that changes only install history must retain the decoded extensions.
    const expected = healthy();
    const status =
      expected.marketplaces[0].plugins[0].globalInstallStatus?.claude;
    if (!status) throw new Error('expected Claude install history');
    status.installError = 'new failure';
    await recordBuiltInPluginInstallError(
      { marketplaceId: 'm', pluginName: 'p' },
      'claude',
      'new failure',
    );
    const expectedPlugin = expected.marketplaces[0].plugins[0];
    const expectedFixture = withExtensions({
      ...expected,
      marketplaces: [
        {
          ...expected.marketplaces[0],
          plugins: [
            {
              ...expectedPlugin,
              externalSource,
              facets: {
                claude: {
                  ...expectedPlugin.facets.claude,
                  externalSource,
                  details: expectedPlugin.details,
                },
              },
            },
          ],
        },
      ],
    });
    expect(readPluginCatalogHealth()).toEqual({
      state: 'valid',
      data: expectedFixture,
    });
    expect(JSON.parse(fs.readFileSync(catalogPath, 'utf8'))).toEqual(
      expectedFixture,
    );
  });

  test.each(['builtin/app', 'curated/cloud', 'canopy-chat-plugins'])(
    'legacy refresh with no external sources can publish revalidated current data: %s',
    async (id) => {
      const value = legacy();
      value.marketplaces[0].id = id;
      value.marketplaces[0].name = id;
      write(value);
      jest.mocked(listCodexPlugins).mockResolvedValue({
        marketplaces: [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      });
      expect((await refreshMarketplaces()).success).toBe(true);
      expect(readPluginCatalogHealth().state).toBe('valid');
    },
  );

  test('empty legacy catalog can initialize through the dedicated refresh', async () => {
    write({ ...legacy(), marketplaces: [] });
    jest.mocked(listCodexPlugins).mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    expect((await refreshMarketplaces()).success).toBe(true);
    expect(readPluginCatalogHealth().state).toBe('valid');
  });

  test('healthy optional fields, refresh stamp, open source type and native selection survive', async () => {
    const value = healthy();
    write(value);
    write({ version: 1, entries: {} }, indexPath);
    expect(readPluginCatalogHealth()).toEqual({ state: 'valid', data: value });
    expect(readPluginCatalog(catalogPath)).toEqual(readPluginCatalogHealth());
    expect(readPluginCacheIndex(indexPath)).toEqual(readPluginIndexHealth());
    const projected = healthy();
    projected.marketplaces[0].plugins[0].codexCompatDisabled = false;
    expect(await loadMarketplacesCacheOnly()).toEqual({
      success: true,
      data: projected,
    });
    expect(resolve().sdkPlugins).toEqual([{ type: 'local', path: pluginPath }]);
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe(JSON.stringify(value));
    expect(runClaudeCliProcessOffMain).not.toHaveBeenCalled();
  });

  test('compatibility metadata round-trips cache v2 while stale or malformed metadata leaves the plugin usable', () => {
    const value = healthy();
    const compatibility = {
      version: 1,
      rulesVersion: 1,
      harnesses: { claude: { level: 'native' as const } },
    };
    value.marketplaces[0].plugins[0].harnessCompatibility = compatibility;
    write(value);
    const current = readPluginCatalog(catalogPath);
    expect(current.state).toBe('valid');
    if (current.state !== 'valid') throw new Error('Expected cache version 2');
    expect(
      current.data.marketplaces[0].plugins[0].harnessCompatibility,
    ).toEqual(compatibility);
    for (const metadata of [
      { ...compatibility, rulesVersion: 2 },
      [],
      {
        version: 1,
        rulesVersion: 1,
        harnesses: { codex: { level: 'partial', missing: ['future'] } },
      },
    ]) {
      write({
        ...value,
        marketplaces: value.marketplaces.map((marketplace) => ({
          ...marketplace,
          plugins: marketplace.plugins.map((plugin) => ({
            ...plugin,
            harnessCompatibility: metadata,
          })),
        })),
      });
      const result = readPluginCatalog(catalogPath);
      expect(result.state).toBe('valid');
      if (result.state !== 'valid')
        throw new Error('Metadata must not invalidate a plugin');
      const plugin = result.data.marketplaces[0].plugins[0];
      expect(plugin.name).toBe('p');
      expect(plugin.harnessCompatibility).toBeUndefined();
      expect(plugin.providerSupport).toEqual(
        value.marketplaces[0].plugins[0].providerSupport,
      );
    }
  });

  test.each(['native', 'compat'] as const)(
    'healthy Codex %s selection is retained',
    (mode) => {
      const value = healthy();
      const plugin = value.marketplaces[0].plugins[0];
      const facet = {
        name: 'p',
        sourcePath: pluginPath,
        installLocation: pluginPath,
        provider: 'codex' as const,
        mode,
      };
      plugin.facets =
        mode === 'native' ? { codex: facet } : { codexCompatibility: facet };
      plugin.providerSupport.codex = mode;
      write(value);
      const result = resolvePlugins(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [{ marketplaceId: 'm', pluginName: 'p' }],
        },
        'project',
        'worktree',
        'chat',
        { purpose: 'codex-session' },
      );
      expect(result.selectedCapabilityRoots).toHaveLength(1);
      expect(readPluginCatalog(catalogPath).state).toBe('valid');
    },
  );

  test('invalid Codex acceptance normalizes consistently without rewriting bytes', () => {
    const value = healthy();
    value.marketplaces[0].providerStatus.codex.accepted = true;
    value.marketplaces[0].validProviders.push('codex');
    write(value);
    const result = readPluginCatalogHealth();
    expect(result).toEqual(readPluginCatalog(catalogPath));
    expect(result.state).toBe('valid');
    if (result.state !== 'valid') throw new Error('expected valid');
    expect(result.data.marketplaces[0].providerStatus.codex.accepted).toBe(
      false,
    );
    expect(result.data.marketplaces[0].validProviders).toEqual(['claude']);
    const sharedRead = jest.spyOn(readHealth, 'readPluginCatalog');
    expect(resolve().sdkPlugins).toEqual([{ type: 'local', path: pluginPath }]);
    expect(sharedRead).toHaveReturnedWith(result);
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe(JSON.stringify(value));
  });

  test.each([
    ['legacy', legacy],
    // A damaged legacy catalog keeps the rows that decode and stays legacy.
    ['legacy', (): unknown => ({ ...legacy(), marketplaces: [null] })],
    [
      'legacy',
      (): unknown => {
        const value = legacy();
        return {
          ...value,
          marketplaces: [
            {
              ...value.marketplaces[0],
              plugins: [
                {
                  ...value.marketplaces[0].plugins[0],
                  externalSource: {
                    url: 'https://github.com/o/p',
                    sha: 'commit',
                  },
                  cachePath: null,
                },
              ],
            },
          ],
        };
      },
    ],
  ])(
    '%s data never authorizes effects, materialization or execution',
    async (state, fixture) => {
      write(fixture());
      const before = fs.readFileSync(catalogPath);
      expect(readPluginCatalogHealth().state).toBe(state);
      expect(readPluginCatalog(catalogPath)).toEqual(readPluginCatalogHealth());
      expect((await loadMarketplacesCacheOnly()).success).toBe(false);
      expect((await loadMarketplaces()).success).toBe(false);
      const policy = await readInstalledItemPolicy(DEFAULT_PREFERENCES);
      expect(
        policy.isDisabled({
          kind: 'plugin',
          marketplaceId: 'm',
          pluginName: 'p',
        }),
      ).toBe(true);
      expect(policy.hasDisabledKind('plugin')).toBe(true);
      expect(
        policy.isDisabled({ kind: 'skill', sourceId: 's', skillName: 's' }),
      ).toBe(false);
      expect(
        policy.isDisabled({ kind: 'mcp-config', serverId: 'm', configId: 'c' }),
      ).toBe(false);
      expect((await addMarketplace('owner/m')).success).toBe(false);
      expect((await removeMarketplace('m')).success).toBe(false);
      expect(
        (await installPlugin('m', 'p', 'https://github.com/owner/p')).success,
      ).toBe(false);
      expect((await prepareCodexCompatibilityPlugin('m', 'p')).success).toBe(
        false,
      );
      await expect(removeInstalledPluginCache('m', 'p')).rejects.toThrow();
      await expect(
        setClaudeInstalledItemEnabled('p@m', true),
      ).rejects.toThrow();
      await expect(uninstallClaudeInstalledItem('p@m')).rejects.toThrow();
      expect(resolve().sdkPlugins).toEqual([]);
      expect(
        (await loadMarketplacesForPresentation(undefined, true)).success,
      ).toBe(true);
      expect(fs.readFileSync(catalogPath)).toEqual(before);
      expect(fs.existsSync(indexPath)).toBe(false);
      for (const effect of [
        cloneRepo,
        runClaudeCliProcessOffMain,
        addCodexMarketplace,
        removeCodexMarketplace,
        resolveCodexPluginInstallRoots,
        materializeCodexPluginsOffMain,
      ])
        expect(effect).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['unsupported', (): unknown => ({ version: 99, marketplaces: [] })],
    ['damaged', (): unknown => ({ ...healthy(), marketplaces: [null] })],
    [
      'damaged',
      (): unknown => ({
        ...healthy(),
        marketplaces: [{ ...healthy().marketplaces[0], plugins: 'wrong' }],
      }),
    ],
    [
      'damaged',
      (): unknown => {
        const value = healthy();
        return {
          ...value,
          marketplaces: [
            {
              ...value.marketplaces[0],
              plugins: [
                { ...value.marketplaces[0].plugins[0], facets: undefined },
              ],
            },
          ],
        };
      },
    ],
    [
      'damaged',
      (): unknown => {
        const value = healthy();
        return {
          ...value,
          marketplaces: [
            {
              ...value.marketplaces[0],
              providerStatus: { claude: null, codex: null },
            },
          ],
        };
      },
    ],
    [
      'damaged',
      (): unknown => {
        const value = healthy();
        return {
          ...value,
          marketplaces: [
            {
              ...value.marketplaces[0],
              plugins: [
                {
                  ...value.marketplaces[0].plugins[0],
                  globalInstallStatus: {
                    checkedAt: '',
                    claude: {
                      available: true,
                      installed: false,
                      installError: 5,
                    },
                  },
                },
              ],
            },
          ],
        };
      },
    ],
    ['damaged', (): unknown => ({ version: '2', marketplaces: [] })],
  ])(
    '%s catalog is read as-is: undecodable rows never execute and nothing is refused',
    async (problem, fixture) => {
      write(fixture());
      const before = fs.readFileSync(catalogPath);
      const desktop = readPluginCatalogHealth();
      expect(desktop).toMatchObject({ state: 'valid', recovered: problem });
      expect(readPluginCatalog(catalogPath)).toEqual(desktop);
      expect((await loadMarketplacesCacheOnly()).success).toBe(true);
      const policy = await readInstalledItemPolicy(DEFAULT_PREFERENCES);
      expect(policy.hasDisabledKind('plugin')).toBe(false);
      expect(
        policy.isDisabled({ kind: 'skill', sourceId: 's', skillName: 's' }),
      ).toBe(false);
      expect(resolve().sdkPlugins).toEqual([]);
      expect(
        (await loadMarketplacesForPresentation(undefined, true)).success,
      ).toBe(true);
      expect(fs.readFileSync(catalogPath)).toEqual(before);
      for (const effect of [
        cloneRepo,
        runClaudeCliProcessOffMain,
        addCodexMarketplace,
        removeCodexMarketplace,
        resolveCodexPluginInstallRoots,
        materializeCodexPluginsOffMain,
      ])
        expect(effect).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['damaged', 2],
    ['unsupported', 99],
  ])(
    'a %s catalog keeps executing the rows that decode',
    async (problem, version) => {
      const value = healthy();
      const row = value.marketplaces[0];
      write({
        ...value,
        version,
        marketplaces: [
          row,
          null,
          { ...row, id: 'broken', providerStatus: null },
          { ...row, id: 'partial', plugins: [null, row.plugins[0]] },
        ],
      });
      const warn = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const desktop = readPluginCatalogHealth();
      expect(desktop).toMatchObject({ state: 'valid', recovered: problem });
      if (desktop.state !== 'valid') throw new Error('expected valid catalog');
      expect(desktop.data.version).toBe(2);
      expect(desktop.data.lastProviderRefreshAt).toBe('stamp');
      expect(
        desktop.data.marketplaces.map((marketplace) => [
          marketplace.id,
          marketplace.plugins.map((plugin) => plugin.name),
        ]),
      ).toEqual([
        ['m', ['p']],
        ['partial', ['p']],
      ]);
      expect(resolve().sdkPlugins).toEqual([
        { type: 'local', path: pluginPath },
      ]);
      readPluginCatalogHealth();
      // Warned once per file and problem, not on every reread.
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes(catalogPath),
        ),
      ).toHaveLength(1);
      expect((await loadMarketplacesCacheOnly()).success).toBe(true);
    },
  );

  test.each([
    ['catalog', '{'],
    ['catalog', ''],
    ['catalog', '\uFFFD'],
    ['index', '{'],
    ['index', ''],
    ['index', '\uFFFD'],
  ])(
    'invalid JSON/encoding reads as empty without blocking: %s %p',
    async (target, text) => {
      write(healthy());
      const file = target === 'catalog' ? catalogPath : indexPath;
      fs.writeFileSync(file, text === '\uFFFD' ? Buffer.from([0xff]) : text);
      const before = fs.readFileSync(file);
      expect(
        target === 'catalog'
          ? readPluginCatalogHealth()
          : readPluginIndexHealth(),
      ).toEqual({
        state: 'valid',
        recovered: 'damaged',
        data:
          target === 'catalog'
            ? { version: 2, lastRefreshed: '', marketplaces: [] }
            : { version: 1, entries: {} },
      });
      expect((await loadMarketplacesCacheOnly()).success).toBe(true);
      // Only the catalog grants execution; nothing readable grants nothing.
      expect(resolve().sdkPlugins).toEqual(
        target === 'catalog' ? [] : [{ type: 'local', path: pluginPath }],
      );
      expect(
        (await loadMarketplacesForPresentation(undefined, true)).success,
      ).toBe(true);
      expect(fs.readFileSync(file)).toEqual(before);
    },
  );

  test.each([
    { version: 7, entries: {} },
    { version: 1, entries: 'not-an-object' },
    { version: 1, entries: { 'm/p': null } },
    {
      version: 1,
      entries: {
        'm/p': { cachePath: 'cache-path', sourceUrl: 8, cachedAt: '' },
      },
    },
  ])(
    'a damaged or newer index never gates execution or authorizes deletion: %p',
    async (fixture) => {
      write(healthy());
      write(fixture, indexPath);
      const index = readPluginIndexHealth();
      expect(readPluginCacheIndex(indexPath)).toEqual(index);
      expect(index).toMatchObject({
        state: 'valid',
        recovered: fixture.version === 1 ? 'damaged' : 'unsupported',
        data: { version: 1, entries: {} },
      });
      expect((await loadMarketplacesCacheOnly()).success).toBe(true);
      expect(resolve().sdkPlugins).toEqual([
        { type: 'local', path: pluginPath },
      ]);
      expect(
        (await loadMarketplacesForPresentation(undefined, true)).data
          ?.marketplaces,
      ).toHaveLength(1);
      // The dropped entry's path is never deleted.
      await removeInstalledPluginCache('m', 'p');
      expect(fs.existsSync(pluginPath)).toBe(true);
    },
  );

  test.each([
    ['catalog', 'EACCES'],
    ['catalog', 'EIO'],
    ['index', 'EACCES'],
    ['index', 'EIO'],
  ])(
    'injected I/O failure reads as empty and never blocks: %s %s',
    async (target, code) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const file = target === 'catalog' ? catalogPath : indexPath;
      const original = fs.readFileSync;
      const before = original(file);
      const ioError = Object.assign(new Error('injected I/O failure'), {
        code,
      });
      const empty =
        target === 'catalog'
          ? { version: 2, lastRefreshed: '', marketplaces: [] }
          : { version: 1, entries: {} };
      expect(
        (target === 'catalog' ? readPluginCatalog : readPluginCacheIndex)(
          file,
          (): never => {
            throw ioError;
          },
        ),
      ).toEqual({ state: 'valid', recovered: 'unreadable', data: empty });
      jest
        .spyOn(fs, 'readFileSync')
        .mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
          if (args[0] === file) throw ioError;
          return original(...args);
        });
      expect(
        target === 'catalog'
          ? readPluginCatalogHealth()
          : readPluginIndexHealth(),
      ).toEqual({ state: 'valid', recovered: 'unreadable', data: empty });
      expect((await loadMarketplacesCacheOnly()).success).toBe(true);
      const policy = await readInstalledItemPolicy(DEFAULT_PREFERENCES);
      expect(policy.hasDisabledKind('plugin')).toBe(false);
      expect(
        policy.isDisabled({ kind: 'skill', sourceId: 's', skillName: 's' }),
      ).toBe(false);
      expect(resolve().sdkPlugins).toEqual(
        target === 'catalog' ? [] : [{ type: 'local', path: pluginPath }],
      );
      expect(original(file)).toEqual(before);
    },
  );

  test.each(['catalog', 'index'])(
    'a file a newer build writes during a cache-only load is read as-is, never rewritten: %s',
    async (target) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const file = target === 'catalog' ? catalogPath : indexPath;
      jest.mocked(readPreferencesFile).mockImplementation(() => {
        write({ version: 99 }, file);
        return Promise.resolve({ ...DEFAULT_PREFERENCES });
      });
      expect((await loadMarketplacesCacheOnly()).success).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"version":99}');
    },
  );

  test.each([
    ['damaged', 'p', false],
    ['damaged', 'manifest-p', false],
    ['unsupported', 'manifest-p', true],
    ['unreadable', 'manifest-p', true],
    ['partial', 'manifest-p', true],
    ['healthy', 'manifest-p', false],
  ])(
    'index %s rebinds installed %s from the catalog (republish: %s)',
    async (problem, manifestName, republish) => {
      write(healthy());
      jest.mocked(cloneRepo).mockImplementation((_source, destination) => {
        const manifestDir = path.join(destination, '.claude-plugin');
        fs.mkdirSync(manifestDir, { recursive: true });
        write({ name: manifestName }, path.join(manifestDir, 'plugin.json'));
        return Promise.resolve();
      });
      const installed = await installPlugin(
        'm',
        'p',
        'https://github.com/owner/p',
        { skipRefresh: true },
      );
      const cachePath = installed.data?.cachePath;
      if (!cachePath) throw new Error('expected installed cache path');
      if (problem === 'unsupported') write({ version: 99 }, indexPath);
      else if (problem === 'partial')
        write({ version: 1, entries: { broken: null } }, indexPath);
      else if (problem !== 'healthy') fs.writeFileSync(indexPath, '{');
      const realRead = fs.readFileSync;
      const read = jest
        .spyOn(fs, 'readFileSync')
        .mockImplementation((file, options) => {
          if (problem === 'unreadable' && String(file) === indexPath)
            throw Object.assign(new Error('read failed'), { code: 'EIO' });
          return realRead(file, options);
        });
      jest.mocked(listCodexPlugins).mockResolvedValue({
        marketplaces: [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      });
      jest
        .mocked(addCodexMarketplace)
        .mockResolvedValue({ accepted: false, error: 'not supported' });
      jest
        .mocked(runClaudeCliProcessOffMain)
        .mockResolvedValue({ stdout: '', stderr: '' });
      fs.mkdirSync(path.join(root, 'plugins'));
      write(
        {
          m: {
            source: { source: 'github', repo: 'owner/m' },
            installLocation: root,
            lastUpdated: '',
          },
        },
        path.join(root, 'plugins', 'known_marketplaces.json'),
      );
      fs.mkdirSync(path.join(root, '.claude-plugin'));
      write(
        {
          name: 'm',
          plugins: [
            {
              name: 'p',
              source: { source: 'url', url: 'https://github.com/owner/p' },
            },
          ],
        },
        path.join(root, '.claude-plugin', 'marketplace.json'),
      );
      if (republish) {
        // An unrelated install must persist the reconstructed marketplace-entry key.
        expect(
          (
            await installPlugin('other', 'q', 'https://github.com/owner/q', {
              skipRefresh: true,
            })
          ).success,
        ).toBe(true);
        read.mockRestore();
        const index = readPluginIndexHealth();
        if (index.state !== 'valid') throw new Error('expected valid index');
        expect(index.data.entries['m/p']?.cachePath).toBe(cachePath);
      }
      expect((await refreshMarketplaces()).success).toBe(true);
      const catalog = readPluginCatalogHealth();
      if (catalog.state !== 'valid') throw new Error('expected valid catalog');
      expect(
        catalog.data.marketplaces.find((row) => row.id === 'm')?.plugins[0]
          .facets.claude?.cachePath,
      ).toBe(cachePath);
      expect(
        resolvePlugins(
          {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [{ marketplaceId: 'm', pluginName: manifestName }],
          },
          'project',
          'worktree',
          'chat',
        ).sdkPlugins,
      ).toEqual([{ type: 'local', path: cachePath }]);
      expect(cloneRepo).toHaveBeenCalledTimes(republish ? 2 : 1);
    },
  );

  test('healthy explicit install and managed deletion retain the provider refresh stamp', async () => {
    write(healthy());
    jest.mocked(cloneRepo).mockImplementation((_source, destination) => {
      const manifestDir = path.join(destination, '.claude-plugin');
      fs.mkdirSync(manifestDir, { recursive: true });
      write(
        { name: 'p', version: '1.0.0' },
        path.join(manifestDir, 'plugin.json'),
      );
      return Promise.resolve();
    });
    const installed = await installPlugin(
      'm',
      'p',
      'https://github.com/owner/p',
      { skipRefresh: true },
    );
    expect(installed.success).toBe(true);
    const installedPath = installed.data?.cachePath;
    expect(installedPath).toBeDefined();
    if (!installedPath) throw new Error('expected installed cache path');
    const catalog = readPluginCatalogHealth();
    expect(catalog.state).toBe('valid');
    if (catalog.state !== 'valid') throw new Error('expected valid catalog');
    expect(catalog.data.lastProviderRefreshAt).toBe('stamp');
    const index = readPluginIndexHealth();
    expect(index.state).toBe('valid');
    if (index.state !== 'valid') throw new Error('expected valid index');
    expect(index.data.entries['m/p'].cachePath).toBe(installedPath);
    await removeInstalledPluginCache('m', 'p');
    expect(fs.existsSync(installedPath)).toBe(false);
    expect(readPluginIndexHealth()).toEqual({
      state: 'valid',
      data: { version: 1, entries: {} },
    });
    expect(readPluginCatalogHealth().state).toBe('valid');
  });

  // CAN-7169: plugin sources are the likeliest hostile remote. Through the
  // real clone, a remote HEAD named like an option fails the install closed:
  // nothing is checked out, no clone is left in the cache, nothing is indexed.
  test.each(['--upload-pack=sub/pwned', '-uxyz'])(
    'plugins:install-plugin refuses a plugin remote whose HEAD names %s',
    async (hostile) => {
      write(healthy());
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hostile-'));
      const seed = path.join(base, 'seed');
      const git = (cwd: string, args: string[]): void => {
        execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
      };
      fs.mkdirSync(path.join(seed, '.claude-plugin'), { recursive: true });
      git(seed, ['init', '-q', '-b', 'main']);
      write(
        { name: 'p', version: '1.0.0' },
        path.join(seed, '.claude-plugin', 'plugin.json'),
      );
      git(seed, ['add', '-A']);
      git(seed, [
        '-c',
        'user.name=Golden',
        '-c',
        'user.email=golden@example.com',
        'commit',
        '-q',
        '-m',
        'plugin',
      ]);
      const origin = path.join(base, 'origin.git');
      execFileSync('git', ['clone', '-q', '--bare', seed, origin], {
        stdio: 'pipe',
      });
      git(origin, ['update-ref', `refs/heads/${hostile}`, 'refs/heads/main']);
      git(origin, ['symbolic-ref', 'HEAD', `refs/heads/${hostile}`]);
      const actualGit = jest.requireActual<typeof GitModule>('../../lib/git');
      let destination: string | undefined;
      jest
        .mocked(cloneRepo)
        .mockImplementationOnce((source, target, options) => {
          destination = target;
          return actualGit.cloneRepo(source, target, options);
        });
      try {
        const installed = await installPlugin('m', 'p', origin, {
          skipRefresh: true,
        });
        expect(installed.success).toBe(false);
        expect(installed.error).toContain(
          "default branch isn't a valid branch name",
        );
        if (!destination) throw new Error('expected the real clone to run');
        expect(fs.existsSync(destination)).toBe(false);
        const index = readPluginIndexHealth();
        expect(['absent', 'valid']).toContain(index.state);
        if (index.state === 'valid')
          expect(index.data.entries['m/p']).toBeUndefined();
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );

  test('a clone completing after catalog damage still installs and rewrites both files', async () => {
    write(healthy());
    jest.mocked(cloneRepo).mockImplementation(() => {
      write({ version: 99 });
      return Promise.resolve();
    });
    const installed = await installPlugin(
      'm',
      'p',
      'https://github.com/owner/p',
      { skipRefresh: true },
    );
    expect(installed.success).toBe(true);
    expect(cloneRepo).toHaveBeenCalledTimes(1);
    const catalog = readPluginCatalogHealth();
    expect(catalog.state).toBe('valid');
    expect(catalog).not.toHaveProperty('recovered');
    const index = readPluginIndexHealth();
    expect(index).not.toHaveProperty('recovered');
    expect(index).toMatchObject({
      state: 'valid',
      data: { entries: { 'm/p': { cachePath: installed.data?.cachePath } } },
    });
  });

  test.each([
    ['catalog', 'EACCES'],
    ['catalog', 'EIO'],
    ['index', 'EACCES'],
    ['index', 'EIO'],
  ])(
    'I/O failure after an await reads as empty and blocks neither load nor install: %s %s',
    async (target, code) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const file = target === 'catalog' ? catalogPath : indexPath;
      const original = fs.readFileSync;
      let failReads = false;
      const ioError = Object.assign(new Error('injected post-await failure'), {
        code,
      });
      jest
        .spyOn(fs, 'readFileSync')
        .mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
          if (failReads && args[0] === file) throw ioError;
          return original(...args);
        });

      jest.mocked(readPreferencesFile).mockImplementation(() => {
        failReads = true;
        return Promise.resolve({ ...DEFAULT_PREFERENCES });
      });
      expect((await loadMarketplacesCacheOnly()).success).toBe(true);
      await expect(
        loadMarketplacesForPresentation(undefined, true),
      ).resolves.toMatchObject({ success: true });
      expect(resolve().sdkPlugins).toEqual(
        target === 'catalog' ? [] : [{ type: 'local', path: pluginPath }],
      );

      failReads = false;
      jest
        .mocked(readPreferencesFile)
        .mockResolvedValue({ ...DEFAULT_PREFERENCES });
      jest.mocked(cloneRepo).mockImplementation(() => {
        failReads = true;
        return Promise.resolve();
      });
      const installed = await installPlugin(
        'm',
        'p',
        'https://github.com/owner/p',
        { skipRefresh: true },
      );
      expect(installed.success).toBe(true);
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      failReads = false;
      expect(readPluginIndexHealth()).toMatchObject({
        state: 'valid',
        data: { entries: { 'm/p': { cachePath: installed.data?.cachePath } } },
      });
      expect(fs.existsSync(pluginPath)).toBe(true);
      expect(runClaudeCliProcessOffMain).not.toHaveBeenCalled();
      expect(addCodexMarketplace).not.toHaveBeenCalled();
    },
  );

  test('deep facet details are decoded, not trusted as opaque objects', async () => {
    const value = healthy();
    const row = value.marketplaces[0];
    const plugin = row.plugins[0];
    const damaged = {
      ...value,
      marketplaces: [
        {
          ...row,
          plugins: [
            {
              ...plugin,
              facets: {
                claude: {
                  ...plugin.facets.claude,
                  details: { ...plugin.details, skills: [null] },
                },
              },
            },
          ],
        },
      ],
    };
    write(damaged);
    const before = fs.readFileSync(catalogPath);
    const desktop = readPluginCatalogHealth();
    expect(desktop).toMatchObject({ state: 'valid', recovered: 'damaged' });
    expect(readPluginCatalog(catalogPath)).toEqual(desktop);
    if (desktop.state !== 'valid') throw new Error('expected valid catalog');
    expect(desktop.data.marketplaces[0].plugins).toEqual([]);
    expect((await loadMarketplacesCacheOnly()).success).toBe(true);
    expect(resolve().sdkPlugins).toEqual([]);
    expect(fs.readFileSync(catalogPath)).toEqual(before);
  });
});
describe('catalog publication remains readable and presentation preserves errors', () => {
  test.each([false, true])(
    'healthy presentation preserves strict failure (cacheOnly=%s)',
    async (cacheOnly) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const before = fs.readFileSync(catalogPath);
      jest
        .mocked(readPreferencesFile)
        .mockRejectedValue(new Error('preferences unavailable'));
      const result = await loadMarketplacesForPresentation(
        undefined,
        cacheOnly,
      );
      expect(result).toEqual({
        success: false,
        error: 'preferences unavailable',
      });
      expect(fs.readFileSync(catalogPath)).toEqual(before);
    },
  );

  test('first-run presentation preserves initialization failure with absent files', async () => {
    jest
      .mocked(readPreferencesFile)
      .mockRejectedValue(new Error('preferences unavailable'));
    expect(await loadMarketplacesForPresentation()).toEqual({
      success: false,
      error: 'preferences unavailable',
    });
  });

  test.each([
    {
      args: ['--port', 8080],
      languages: { '.ts': 'ts', '.bad': 42, '.tsx': 'ts' },
      expectedArgs: ['--port'],
      expectedLanguages: ['ts'],
    },
    { args: [], languages: {}, expectedArgs: [], expectedLanguages: [] },
    {
      args: [null, false, {}],
      languages: { '.bad': false },
      expectedArgs: [],
      expectedLanguages: [],
    },
    {
      args: 8080,
      languages: false,
      expectedArgs: undefined,
      expectedLanguages: undefined,
    },
    {
      args: ['--port', '8080'],
      languages: { '.ts': 'ts' },
      expectedArgs: ['--port', '8080'],
      expectedLanguages: ['ts'],
    },
  ])(
    'scanned untrusted metadata remains readable after install: %j',
    async ({ args, languages, expectedArgs, expectedLanguages }) => {
      write(healthy());
      jest.mocked(cloneRepo).mockImplementation((_url, dir) => {
        fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
        write(
          {
            name: 42,
            description: {},
            version: [],
            author: { name: 8 },
            homepage: false,
            skills: [42, 'skills'],
            agents: [null, 'agents'],
          },
          path.join(dir, '.claude-plugin', 'plugin.json'),
        );
        write(
          { mcpServers: { server: { command: 'cmd', args } } },
          path.join(dir, '.mcp.json'),
        );
        write(
          { server: { command: 'lsp', args, extensionToLanguage: languages } },
          path.join(dir, '.lsp.json'),
        );
        fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'agents', 'a.md'),
          '---\nname: [bad]\ndescription: 45\n---\nAgent',
        );
        fs.mkdirSync(path.join(dir, 'skills', 's'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'skills', 's', 'SKILL.md'),
          '---\nname: 45\ndescription: [bad]\n---\nSkill',
        );
        return Promise.resolve();
      });
      const result = await installPlugin('m', 'p', 'https://github.com/o/p', {
        skipRefresh: true,
      });
      expect(result.success).toBe(true);
      expect(readPluginCatalogHealth().state).toBe('valid');
      expect(readPluginCatalog(catalogPath).state).toBe('valid');
      const details = result.data?.details;
      expect(details?.mcpServers[0].args).toEqual(expectedArgs);
      expect(details?.lspServers[0]).toMatchObject({
        args: expectedArgs,
        languages: expectedLanguages,
      });
      expect(details?.skills[0]).toMatchObject({ name: 's', description: '' });
      expect(details?.agents[0]).toMatchObject({ name: 'a', description: '' });
      expect(result.data).toMatchObject({
        name: 'p',
        description: '',
        version: '',
        author: '',
        homepage: '',
      });
    },
  );

  test('marketplace facet scans sanitize metadata and preserve valid source extensions', async () => {
    write(healthy());
    jest.mocked(listCodexPlugins).mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    jest
      .mocked(addCodexMarketplace)
      .mockResolvedValue({ accepted: false, error: 'not supported' });
    jest
      .mocked(runClaudeCliProcessOffMain)
      .mockResolvedValue({ stdout: '', stderr: '' });
    fs.mkdirSync(path.join(root, 'plugins'));
    write(
      {
        m: {
          source: { source: 'github', repo: 'owner/m' },
          installLocation: root,
          lastUpdated: 23,
        },
      },
      path.join(root, 'plugins', 'known_marketplaces.json'),
    );
    fs.mkdirSync(path.join(root, '.claude-plugin'));
    fs.mkdirSync(path.join(pluginPath, '.claude-plugin'));
    write(
      {
        name: 9,
        author: { name: [] },
        description: false,
        version: {},
        homepage: [],
      },
      path.join(pluginPath, '.claude-plugin', 'plugin.json'),
    );
    write(
      {
        name: 45,
        description: [],
        plugins: [
          null,
          { name: 42, source: './plugin' },
          {
            name: 'p',
            source: './plugin',
            description: {},
            version: 9,
            author: { name: false },
            category: [],
            homepage: false,
          },
          {
            name: 'external',
            source: {
              source: 'git-subdir',
              url: 'https://github.com/o/p',
              sha: 9,
              path: 'plugins/p',
              ref: 'release',
            },
          },
        ],
      },
      path.join(root, '.claude-plugin', 'marketplace.json'),
    );
    expect((await refreshMarketplaces()).success).toBe(true);
    const current = readPluginCatalogHealth();
    expect(current.state).toBe('valid');
    expect(readPluginCatalog(catalogPath).state).toBe('valid');
    if (current.state !== 'valid') throw new Error('catalog did not decode');
    const market = current.data.marketplaces.find((row) => row.id === 'm');
    expect(market?.plugins).toHaveLength(2);
    expect(market?.plugins.find((row) => row.name === 'p')).toMatchObject({
      description: '',
      version: '',
      author: '',
      category: '',
      homepage: '',
    });
    expect(
      market?.plugins.find((row) => row.name === 'external')?.externalSource,
    ).toEqual({
      source: 'git-subdir',
      url: 'https://github.com/o/p',
      path: 'plugins/p',
      ref: 'release',
    });
  });

  test('non-decodable outgoing catalog is refused without replacing healthy bytes', async () => {
    write(healthy());
    write(
      {
        version: 1,
        entries: {
          'm/p': {
            cachePath: pluginPath,
            sourceUrl: 'https://github.com/o/p',
            cachedAt: '',
          },
        },
      },
      indexPath,
    );
    const indexBefore = fs.readFileSync(indexPath);
    fs.writeFileSync(path.join(pluginPath, 'old-payload'), 'previous install');
    const before = fs.readFileSync(catalogPath);
    const details = healthy().marketplaces[0].plugins[0].details;
    if (!details) throw new Error('missing fixture details');
    Object.defineProperty(details, 'mcpServers', {
      value: [{ name: 'bad', type: 'command', args: [8080] }],
    });
    jest.spyOn(scanner, 'scanPluginDetails').mockReturnValue(details);
    jest.mocked(cloneRepo).mockImplementation((_url, dir) => {
      fs.mkdirSync(dir, { recursive: true });
      return Promise.resolve();
    });
    const result = await installPlugin('m', 'p', 'https://github.com/o/p', {
      skipRefresh: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/plugin catalog.*updated data/i);
    expect(fs.readFileSync(catalogPath)).toEqual(before);
    expect(fs.existsSync(path.join(pluginPath, 'old-payload'))).toBe(true);
    expect(fs.readFileSync(indexPath)).toEqual(indexBefore);
  });

  test('non-decodable outgoing index is refused without replacing healthy bytes', async () => {
    write(healthy());
    const catalogBefore = fs.readFileSync(catalogPath);
    fs.writeFileSync(path.join(pluginPath, 'old-payload'), 'previous install');
    write(
      {
        version: 1,
        entries: {
          'm/p': {
            cachePath: pluginPath,
            sourceUrl: 'https://github.com/o/p',
            cachedAt: '',
          },
        },
      },
      indexPath,
    );
    const before = fs.readFileSync(indexPath);
    const readIndex = readHealth.readPluginCacheIndex;
    jest
      .spyOn(readHealth, 'readPluginCacheIndex')
      .mockImplementation((file) => {
        const result = readIndex(file);
        if (result.state === 'valid') {
          const entry = {
            cachePath: pluginPath,
            sourceUrl: 'https://github.com/o/p',
            cachedAt: '',
          };
          Object.defineProperty(entry, 'cachedAt', { value: 8 });
          result.data.entries['other/p'] = entry;
        }
        return result;
      });
    jest.mocked(cloneRepo).mockImplementation((_url, dir) => {
      fs.mkdirSync(dir, { recursive: true });
      return Promise.resolve();
    });
    const result = await installPlugin('m', 'p', 'https://github.com/o/p', {
      skipRefresh: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/plugin cache index.*updated data/i);
    expect(fs.readFileSync(indexPath)).toEqual(before);
    expect(fs.readFileSync(catalogPath)).toEqual(catalogBefore);
    expect(fs.readFileSync(path.join(pluginPath, 'old-payload'), 'utf-8')).toBe(
      'previous install',
    );
  });
});

test('native Codex marketplace display metadata is narrowed before publication', async () => {
  const cache = healthy();
  cache.lastProviderRefreshAt = new Date().toISOString();
  write(cache);
  fs.mkdirSync(path.join(pluginPath, '.codex-plugin'));
  write(
    { name: 'p', author: { name: 5 }, description: 8, version: false },
    path.join(pluginPath, '.codex-plugin', 'plugin.json'),
  );
  const display = { displayName: 'native-market' };
  Object.defineProperty(display, 'displayName', { value: 42 });
  jest.mocked(listCodexPlugins).mockResolvedValue({
    marketplaces: [
      {
        name: 'native-market',
        path: path.join(root, '.agents', 'plugins', 'marketplace.json'),
        interface: display,
        plugins: [],
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  });
  jest.mocked(resolveCodexPluginInstallRoots).mockResolvedValue({
    locations: [
      {
        pluginName: 'p',
        marketplaceName: 'native-market',
        installRoot: pluginPath,
      },
    ],
    unresolved: [],
  });
  const result = await refreshMarketplaces();
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  expect(readPluginCatalog(catalogPath).state).toBe('valid');
  expect(
    result.data?.marketplaces.find((row) => row.id === 'native-market'),
  ).toMatchObject({
    name: 'native-market',
    plugins: [{ name: 'p', author: '', description: '', version: '' }],
  });
});

test.each([false, true])(
  'curated native scans sanitize metadata but retain valid values (malformed=%s)',
  async (malformed) => {
    write(healthy());
    resetBuiltInMarketplaceScanCacheForTests();
    const curatedRoot = path.join(root, 'curated-plugins', 'marketplace');
    const p = path.join(curatedRoot, 'plugins', 'p');
    for (const kind of ['.claude-plugin', '.codex-plugin']) {
      fs.mkdirSync(path.join(p, kind), { recursive: true });
      write(
        {
          name: 'p',
          description: malformed ? 9 : 'description',
          author: { name: malformed ? false : 'author' },
          version: malformed ? [] : '1.2.3',
          homepage: malformed ? {} : 'https://example.com',
        },
        path.join(p, kind, 'plugin.json'),
      );
    }
    fs.mkdirSync(path.join(curatedRoot, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(curatedRoot, '.agents', 'plugins'), {
      recursive: true,
    });
    write(
      {
        name: malformed ? 9 : 'curated-name',
        plugins: [
          null,
          { name: 42 },
          {
            name: 'p',
            source: './plugins/p',
            category: malformed ? {} : 'category',
            recommended: true,
            tryNowPrompt: malformed ? {} : 'try p',
          },
        ],
      },
      path.join(curatedRoot, '.claude-plugin', 'marketplace.json'),
    );
    write(
      {
        name: malformed ? [] : 'curated-name',
        plugins: [
          null,
          { name: false },
          {
            name: 'p',
            source: { source: 'local', path: './plugins/p' },
            category: malformed ? [] : 'category',
            tryNowPrompt: malformed ? 42 : 'try p',
          },
        ],
      },
      path.join(curatedRoot, '.agents', 'plugins', 'marketplace.json'),
    );
    write(
      { mcpServers: { m: { command: 'cmd', args: ['--port', 8080] } } },
      path.join(p, '.mcp.json'),
    );
    write(
      {
        l: {
          command: 'lsp',
          args: ['--stdio', false],
          extensionToLanguage: { '.ts': 'typescript', '.bad': {} },
        },
      },
      path.join(p, '.lsp.json'),
    );
    jest.mocked(listCodexPlugins).mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    try {
      const result = await refreshMarketplaces();
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      const current = readPluginCatalogHealth();
      expect(current.state).toBe('valid');
      expect(readPluginCatalog(catalogPath).state).toBe('valid');
      if (current.state !== 'valid') throw new Error('catalog did not decode');
      const plugin = current.data.marketplaces.find((row) => row.curated)
        ?.plugins[0];
      expect(plugin).toMatchObject({
        name: 'p',
        recommended: true,
        description: malformed ? '' : 'description',
        author: malformed ? '' : 'author',
        version: malformed ? '' : '1.2.3',
        category: malformed ? '' : 'category',
        homepage: malformed ? '' : 'https://example.com',
      });
      expect(plugin?.tryNowPrompt).toBe(malformed ? undefined : 'try p');
      for (const facet of [plugin?.facets.claude, plugin?.facets.codex]) {
        expect(facet?.details?.mcpServers[0].args).toEqual(['--port']);
        expect(facet?.details?.lspServers[0]).toMatchObject({
          args: ['--stdio'],
          languages: ['typescript'],
        });
      }
    } finally {
      resetBuiltInMarketplaceScanCacheForTests();
    }
  },
);

test('installed empty manifest paths publish default components readable by both readers', async () => {
  write(healthy());
  jest.mocked(cloneRepo).mockImplementation((_url, dir) => {
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    write(
      { name: 'p', skills: '', commands: '', agents: '', apps: '' },
      path.join(dir, '.claude-plugin', 'plugin.json'),
    );
    fs.mkdirSync(path.join(dir, 'skills', 's'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 's', 'SKILL.md'), 'Skill');
    for (const kind of ['commands', 'agents', 'apps']) {
      fs.mkdirSync(path.join(dir, kind));
      fs.writeFileSync(path.join(dir, kind, 'member.md'), 'Member');
    }
    fs.writeFileSync(path.join(dir, 'README.md'), 'Readme');
    return Promise.resolve();
  });
  const result = await installPlugin('m', 'p', 'https://github.com/o/p', {
    skipRefresh: true,
  });
  expect(result.success).toBe(true);
  const catalog = readPluginCatalogHealth();
  expect(catalog.state).toBe('valid');
  expect(readPluginCatalog(catalogPath)).toEqual(catalog);
  if (catalog.state !== 'valid') throw new Error('catalog did not decode');
  const details = catalog.data.marketplaces[0].plugins[0].details;
  if (!details) throw new Error('installed components missing from catalog');
  expect(details.skills.map((skill) => skill.name)).toEqual(['s']);
  for (const kind of ['commands', 'agents', 'apps'] as const) {
    expect(details[kind]?.map((member) => member.name)).toEqual(['member']);
  }
  expect(details.hasReadme).toBe(true);
  const index = readPluginIndexHealth();
  expect(index.state).toBe('valid');
  expect(readPluginCacheIndex(indexPath)).toEqual(index);
  if (index.state !== 'valid') throw new Error('index did not decode');
  expect(index.data.entries['m/p'].cachePath).toBe(result.data?.cachePath);
  expect(resolve().sdkPlugins).toEqual([
    { type: 'local', path: index.data.entries['m/p'].cachePath },
  ]);
});

test('healthy reinstall publishes readable documents and retires only the prior payload', async () => {
  const previousPayload = path.join(root, 'plugin-cache', 'previous-install');
  fs.mkdirSync(previousPayload, { recursive: true });
  write(healthy());
  write(
    {
      version: 1,
      entries: {
        'm/p': {
          cachePath: previousPayload,
          sourceUrl: 'https://github.com/o/p',
          cachedAt: '',
        },
      },
    },
    indexPath,
  );
  fs.writeFileSync(
    path.join(previousPayload, 'old-payload'),
    'previous install',
  );
  jest.mocked(cloneRepo).mockImplementation((_url, dir) => {
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    write(
      { name: 'p', description: 'healthy' },
      path.join(dir, '.claude-plugin', 'plugin.json'),
    );
    return Promise.resolve();
  });
  const result = await installPlugin('m', 'p', 'https://github.com/o/p', {
    skipRefresh: true,
  });
  expect(result.success).toBe(true);
  expect(result.data?.description).toBe('healthy');
  const index = readPluginIndexHealth();
  expect(index.state).toBe('valid');
  expect(readPluginCatalogHealth().state).toBe('valid');
  if (index.state !== 'valid') throw new Error('index did not decode');
  expect(index.data.entries['m/p'].cachePath).toBe(result.data?.cachePath);
  expect(fs.existsSync(index.data.entries['m/p'].cachePath)).toBe(true);
  expect(fs.existsSync(previousPayload)).toBe(false);
  expect(fs.existsSync(pluginPath)).toBe(true);
});

function publicationGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('admitted catalog publication and operation lifetimes (CAN-4481)', () => {
  function seedExternalMarketplace(): void {
    write(healthy());
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    write(
      {
        m: {
          source: { source: 'github', repo: 'owner/m' },
          installLocation: root,
          lastUpdated: '',
        },
      },
      path.join(root, 'plugins', 'known_marketplaces.json'),
    );
    fs.mkdirSync(path.join(root, '.claude-plugin'));
    write(
      { name: 'm', plugins: [{ name: 'p', source: './plugin' }] },
      path.join(root, '.claude-plugin', 'marketplace.json'),
    );
    jest.spyOn(curatedSync, 'syncCuratedPlugins').mockResolvedValue({
      status: 'skipped',
      added: [],
      changed: [],
      removed: [],
      errors: [],
    });
    jest.mocked(listCodexPlugins).mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    jest
      .mocked(addCodexMarketplace)
      .mockResolvedValue({ accepted: false, error: 'not supported' });
    jest.mocked(removeCodexMarketplace).mockResolvedValue({ accepted: true });
    jest
      .mocked(resolveCodexPluginInstallRoots)
      .mockResolvedValue({ locations: [], unresolved: [] });
    jest
      .mocked(runClaudeCliProcessOffMain)
      .mockResolvedValue({ stdout: '', stderr: '' });
  }

  function seedCuratedPlugin(): void {
    const curatedRoot = path.join(root, 'curated-plugins', 'marketplace');
    fs.mkdirSync(path.join(curatedRoot, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(curatedRoot, 'p', '.claude-plugin'), {
      recursive: true,
    });
    write(
      { name: 'curated', plugins: [{ name: 'p', source: './p' }] },
      path.join(curatedRoot, '.claude-plugin', 'marketplace.json'),
    );
    write(
      { name: 'p', description: 'curated plugin' },
      path.join(curatedRoot, 'p', '.claude-plugin', 'plugin.json'),
    );
    jest.mocked(listCodexPlugins).mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    invalidateCuratedMarketplaceScanCache();
  }

  test('scheduler noop can publish refreshed Codex copies and bootstrap an empty refresh stamp', async () => {
    seedCuratedPlugin();
    jest.spyOn(curatedSync, 'syncCuratedPlugins').mockResolvedValue({
      status: 'noop',
      added: [],
      changed: [],
      removed: [],
      errors: [],
    });
    jest.mocked(refreshCuratedCodexPlugins).mockResolvedValue(true);
    const compatibilityNotification = jest.fn();
    await runCuratedMcpRefresh({
      refreshCatalog: () => Promise.resolve(),
      refreshTools: () => Promise.resolve(),
      syncCuratedPlugins: () => syncCuratedPluginsForRefresh(),
      refreshInvocableInventory: compatibilityNotification,
    });
    expect(compatibilityNotification).not.toHaveBeenCalled();
    expect(readPluginCatalogHealth()).toMatchObject({
      state: 'valid',
      data: { lastRefreshed: '', marketplaces: [{ curated: true }] },
    });
    await settleDetachedWork();
    expect(refreshInvocableInventoryAfterMutation).toHaveBeenCalledWith(
      'plugin-catalog:settled-change',
    );
  });

  test('a managed install that publishes then returns failure still invalidates consumers', async () => {
    seedCuratedPlugin();
    write(healthy());
    jest
      .mocked(runClaudeCliProcessOffMain)
      .mockRejectedValue(new Error('provider refused installation'));
    const sink = jest.spyOn(atomicFile, 'writeFileAtomically');
    const result = await installBuiltInPlugin({
      marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
      pluginName: 'p',
      providers: ['claude'],
    });
    expect(result.success).toBe(false);
    expect(sink).toHaveBeenCalledWith(
      catalogPath,
      expect.any(String),
      expect.objectContaining({
        durable: true,
        admittedWriter: {
          namespace: 'plugins_cache',
          writer: 'electron_main',
          module: 'main/plugins/plugin-catalog-store',
        },
      }),
    );
    expect(readPluginCatalogHealth()).toMatchObject({
      state: 'valid',
      data: { lastProviderRefreshAt: 'stamp' },
    });
    await settleDetachedWork();
    expect(refreshInvocableInventoryAfterMutation).toHaveBeenCalledWith(
      'plugin-catalog:settled-change',
    );
  });

  test.each(['open', 'write', 'sync', 'directory_flush'] as const)(
    'the production sink reports real %s faults without claiming durable publication',
    async (stage) => {
      write(healthy());
      const before = fs.readFileSync(catalogPath, 'utf8');
      const realOpen = fsPromises.open;
      jest.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
        const temporary =
          typeof args[0] === 'string' && args[0].endsWith('.tmp');
        if (temporary && stage === 'open')
          throw new Error('injected open failure');
        const handle = await realOpen(...args);
        if (temporary && stage === 'write')
          jest
            .spyOn(handle, 'writeFile')
            .mockRejectedValue(new Error('injected write failure'));
        if (temporary && stage === 'sync')
          jest
            .spyOn(handle, 'sync')
            .mockRejectedValue(new Error('injected sync failure'));
        if (
          stage === 'directory_flush' &&
          args[0] === root &&
          fs.readFileSync(catalogPath, 'utf8') !== before
        )
          jest
            .spyOn(handle, 'sync')
            .mockRejectedValue(new Error('injected directory flush failure'));
        return handle;
      });
      let failure: unknown;
      try {
        await publishPluginCatalog({ ...healthy(), lastRefreshed: 'new' });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CatalogPublicationError);
      if (!(failure instanceof CatalogPublicationError))
        throw new Error('expected publication failure');
      expect(failure.outcomes).toMatchObject([
        {
          document: 'plugins_cache',
          state:
            stage === 'directory_flush'
              ? 'installed_uncertain'
              : 'not_installed',
        },
      ]);
      expect(fs.readFileSync(catalogPath, 'utf8') === before).toBe(
        stage !== 'directory_flush',
      );
      expect(
        fs.readdirSync(root).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]);
      await settleDetachedWork();
      expect(
        jest.mocked(refreshInvocableInventoryAfterMutation).mock.calls.length >
          0,
      ).toBe(stage === 'directory_flush');
    },
  );

  test('a rename retry rechecks observations rather than installing an obsolete temporary file', async () => {
    write(healthy());
    const before = fs.readFileSync(catalogPath, 'utf8');
    const attempted = publicationGate();
    const rename = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementationOnce(() => {
        notePluginCatalogEffects();
        attempted.resolve();
        return Promise.reject(
          Object.assign(new Error('sharing violation'), { code: 'EBUSY' }),
        );
      });
    jest.useFakeTimers();
    try {
      const result = publishPluginCatalog({
        ...healthy(),
        lastRefreshed: 'stale',
      }).catch((error: unknown) => error);
      await attempted.promise;
      await jest.advanceTimersByTimeAsync(50);
      expect(await result).toBeInstanceOf(CatalogPublicationError);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(catalogPath, 'utf8')).toBe(before);
      expect(
        fs.readdirSync(root).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a retired inherited continuation must requeue even without explicit detached enqueue', async () => {
    const launch = publicationGate();
    const release = publicationGate();
    const started = publicationGate();
    const order: string[] = [];
    let child = Promise.resolve();
    await runSerializedPluginMutation(() => {
      child = launch.promise.then(() =>
        runSerializedPluginMutation(() => {
          order.push('child');
          return Promise.resolve();
        }),
      );
      return Promise.resolve();
    });
    const blocker = runSerializedPluginMutation(async () => {
      started.resolve();
      await release.promise;
      order.push('released');
    });
    await started.promise;
    launch.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);
    release.resolve();
    await Promise.all([child, blocker]);
    expect(order).toEqual(['released', 'child']);
  });

  test('a detached launch while its parent is active cannot borrow the live slot', async () => {
    const started = publicationGate();
    const release = publicationGate();
    const order: string[] = [];
    let child = Promise.resolve();
    const parent = runSerializedPluginMutation(async () => {
      child = enqueueDetachedPluginMutation(() => {
        order.push('child');
        return Promise.resolve();
      });
      started.resolve();
      await release.promise;
      order.push('parent settled');
    });
    await started.promise;
    expect(order).toEqual([]);
    release.resolve();
    await parent;
    await child;
    expect(order).toEqual(['parent settled', 'child']);
  });

  test.each([
    ['refresh', false],
    ['refresh', true],
    ['update', false],
    ['update', true],
  ] as const)(
    '%s and remove are ordered before input reads (remove first=%s)',
    async (operation, removeFirst) => {
      seedExternalMarketplace();
      const knownPath = path.join(root, 'plugins', 'known_marketplaces.json');
      const started = publicationGate();
      const release = publicationGate();
      const effects: string[] = [];
      jest
        .mocked(runClaudeCliProcessOffMain)
        .mockImplementation(async ({ args }) => {
          const verb = args[2];
          effects.push(verb);
          if (effects.length === 1) {
            started.resolve();
            await release.promise;
          }
          if (verb === 'remove') write({}, knownPath);
          return { stdout: '', stderr: '' };
        });
      const mutate = ():
        | ReturnType<typeof refreshMarketplaces>
        | ReturnType<typeof updateMarketplace> =>
        operation === 'refresh'
          ? refreshMarketplaces(undefined, { providerUpdates: 'always' })
          : updateMarketplace('m');
      const remove = (): ReturnType<typeof removeMarketplace> =>
        removeMarketplace('m');
      const sink = jest.spyOn(atomicFile, 'writeFileAtomically');
      const first = removeFirst ? remove() : mutate();
      await started.promise;
      const second = removeFirst ? mutate() : remove();
      await Promise.resolve();
      expect(effects).toHaveLength(1);
      release.resolve();
      const results = await Promise.all([first, second]);
      expect(results[0].success).toBe(true);
      // Refresh after removal discovers no source. Update after removal refuses,
      // rather than applying an observation of the previous same-ID row.
      expect(results[1].success).toBe(!(removeFirst && operation === 'update'));
      const catalog = readPluginCatalogHealth();
      if (catalog.state !== 'valid')
        throw new Error('expected healthy catalog');
      expect(
        catalog.data.marketplaces.find((marketplace) => marketplace.id === 'm'),
      ).toBeUndefined();
      const catalogWrites = sink.mock.calls.filter(
        ([target]) => target === catalogPath,
      );
      expect(catalogWrites.length).toBeGreaterThan(0);
      for (const [, , options] of catalogWrites)
        expect(options).toMatchObject({
          durable: true,
          admittedWriter: {
            namespace: 'plugins_cache',
            writer: 'electron_main',
            module: 'main/plugins/plugin-catalog-store',
          },
        });
    },
  );

  test.each([
    -60_000,
    24 * 60 * 60_000 - 1,
    24 * 60 * 60_000,
    24 * 60 * 60_000 + 1,
  ])(
    'provider refresh TTL retains its strict boundary and future stamp policy (age=%s)',
    async (age) => {
      seedExternalMarketplace();
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const stamp = new Date(now - age).toISOString();
      write({ ...healthy(), lastProviderRefreshAt: stamp });
      const result = await refreshMarketplaces(undefined, {
        providerUpdates: 'if-stale',
      });
      expect(result.success).toBe(true);
      const shouldUpdate = age > 24 * 60 * 60_000;
      const providerUpdated = jest
        .mocked(runClaudeCliProcessOffMain)
        .mock.calls.some(([request]) => request.args[2] === 'update');
      expect(providerUpdated).toBe(shouldUpdate);
      if (!shouldUpdate) expect(result.data?.lastProviderRefreshAt).toBe(stamp);
      const persisted = readPluginCatalogHealth();
      if (persisted.state !== 'valid')
        throw new Error('expected valid catalog');
      expect(persisted.data.lastProviderRefreshAt).toBe(
        result.data?.lastProviderRefreshAt,
      );
    },
  );

  test('an in-flight built-in scan cannot insert its pre-invalidation result', async () => {
    write(healthy());
    const bundle = path.join(root, 'bundle');
    const manifest = path.join(
      bundle,
      '.agents',
      'plugins',
      'marketplace.json',
    );
    const pluginManifest = path.join(
      bundle,
      'plugin',
      '.codex-plugin',
      'plugin.json',
    );
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.mkdirSync(path.dirname(pluginManifest), { recursive: true });
    write(
      {
        name: 'builtin',
        plugins: [{ name: 'p', source: { source: 'local', path: './plugin' } }],
      },
      manifest,
    );
    write({ name: 'p', description: 'old' }, pluginManifest);
    jest.spyOn(configPaths, 'getBundledPluginsDir').mockReturnValue(bundle);
    jest
      .spyOn(configPaths, 'getBundledClaudePluginMarketplaceManifestPath')
      .mockReturnValue(path.join(bundle, 'absent.json'));
    jest
      .spyOn(configPaths, 'getBundledCodexPluginMarketplaceManifestPath')
      .mockReturnValue(manifest);
    const started = publicationGate();
    const release = publicationGate();
    const empty = {
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    };
    jest
      .mocked(listCodexPlugins)
      .mockResolvedValue(empty)
      .mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return empty;
      });
    const scan = scanManagedMarketplacesFresh();
    await started.promise;
    write({ name: 'p', description: 'new' }, pluginManifest);
    resetBuiltInMarketplaceScanCacheForTests();
    release.resolve();
    const rows = await scan;
    expect(rows.find((entry) => entry.builtIn)?.plugins[0].description).toBe(
      'new',
    );
    expect(
      jest.mocked(listCodexPlugins).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  test('an in-flight curated scan retries after invalidation rather than resurrecting its memo', async () => {
    const manifest = path.join(
      root,
      'curated-plugins',
      'marketplace',
      '.claude-plugin',
      'marketplace.json',
    );
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    write(
      { name: 'curated', plugins: [{ name: 'p', source: './p' }] },
      manifest,
    );
    const fixture = healthy().marketplaces[0];
    const started = publicationGate();
    const release = publicationGate();
    let scans = 0;
    const deps: CuratedMarketplaceScanDeps = {
      readClaudeFacets: () => [],
      readCodexFacets: () => [],
      mergeProviderPluginFacets: () => fixture.plugins,
      providerStatus: (provider) => fixture.providerStatus[provider],
      readInstallStatuses: async ({ plugins }) => {
        scans += 1;
        const description = scans === 1 ? 'old' : 'new';
        if (scans === 1) {
          started.resolve();
          await release.promise;
        }
        return plugins.map((plugin) => ({ ...plugin, description }));
      },
    };
    invalidateCuratedMarketplaceScanCache();
    const scan = scanCuratedMarketplace(deps);
    await started.promise;
    invalidateCuratedMarketplaceScanCache();
    release.resolve();
    expect((await scan)?.plugins[0].description).toBe('new');
    expect((await scanCuratedMarketplace(deps))?.plugins[0].description).toBe(
      'new',
    );
    expect(scans).toBe(2);
  });

  test('normalizes the exact committed bytes and preserves the latest provider stamp and extensions', async () => {
    write({
      ...healthy(),
      extension: { retained: true },
      lastProviderRefreshAt: 'latest',
    });
    const candidate = { ...healthy(), lastProviderRefreshAt: 'obsolete' };
    const committed = await publishPluginCatalog(candidate);
    expect(committed.lastProviderRefreshAt).toBe('latest');
    expect(JSON.parse(fs.readFileSync(catalogPath, 'utf8'))).toEqual(committed);
    expect(JSON.parse(fs.readFileSync(catalogPath, 'utf8'))).toMatchObject({
      extension: { retained: true },
    });
    const advanced = await publishPluginCatalog(candidate, {
      advanceProviderStamp: true,
    });
    expect(advanced.lastProviderRefreshAt).toBe('obsolete');
  });

  test('a scan can retain its intentional provider rejection without replaying the effect', async () => {
    write(healthy());
    let effects = 0;
    const scanned = await withPluginCatalogScan(() => {
      // scanCodexMarketplace may deregister a structurally invalid provider.
      effects += 1;
      notePluginCatalogEffects();
      return Promise.resolve({
        ...healthy(),
        lastRefreshed: 'scanned after rejection',
      });
    });
    const committed = await publishPluginCatalog(scanned.value, {
      observation: scanned.observation,
    });
    expect(committed.lastRefreshed).toBe('scanned after rejection');
    expect(effects).toBe(1);
  });

  test('an owned scan effect cannot revive an observation invalidated by another context', async () => {
    write(healthy());
    const started = publicationGate();
    const release = publicationGate();
    const scanning = withPluginCatalogScan(async () => {
      started.resolve();
      await release.promise;
      notePluginCatalogEffects();
      return healthy();
    });
    await started.promise;
    notePluginCatalogEffects();
    release.resolve();
    const scanned = await scanning;
    await expect(
      publishPluginCatalog(scanned.value, { observation: scanned.observation }),
    ).rejects.toThrow(/fresh scan/);
  });

  test('rejects a candidate observed before remove/re-add, including reused marketplace IDs', async () => {
    write(healthy());
    const observation = observePluginCatalog();
    await publishPluginCatalog({ ...healthy(), marketplaces: [] });
    const replacement = healthy();
    replacement.marketplaces[0].name = 'replacement';
    await publishPluginCatalog(replacement);
    await expect(
      publishPluginCatalog(healthy(), { observation }),
    ).rejects.toThrow(/fresh scan/);
    expect(readPluginCatalogHealth()).toMatchObject({
      state: 'valid',
      data: replacement,
    });
  });

  test('rechecks the original observation at installation after the temp has been written', async () => {
    write(healthy());
    const before = fs.readFileSync(catalogPath, 'utf8');
    const realWrite = atomicFile.writeFileAtomically;
    jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation((target, data, options) =>
        realWrite(target, data, {
          ...options,
          beforeInstall: async () => {
            notePluginCatalogEffects();
            await options?.beforeInstall?.();
          },
        }),
      );
    await expect(
      publishPluginCatalog({ ...healthy(), lastRefreshed: 'new' }),
    ).rejects.toThrow(/fresh scan/);
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe(before);
    expect(
      fs.readdirSync(root).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  test.each([
    ['plugin_cache_index', 'not_installed'],
    ['plugin_cache_index', 'installed_uncertain'],
    ['plugins_cache', 'not_installed'],
    ['plugins_cache', 'installed_uncertain'],
  ] as const)(
    'retains exact pair outcomes when %s is %s',
    async (failedDocument, failure) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const oldCatalog = fs.readFileSync(catalogPath, 'utf8');
      const oldIndex = fs.readFileSync(indexPath, 'utf8');
      const realWrite = atomicFile.writeFileAtomically;
      jest
        .spyOn(atomicFile, 'writeFileAtomically')
        .mockImplementation(async (target, data, options) => {
          const document =
            target === indexPath ? 'plugin_cache_index' : 'plugins_cache';
          if (document !== failedDocument)
            return realWrite(target, data, options);
          if (failure === 'not_installed') throw new Error('before install');
          await realWrite(target, data, options);
          throw new StorageOutcomeUnknownError(
            'directory_flush',
            new Error('flush'),
            document,
          );
        });
      const expected = [
        ...(failedDocument === 'plugins_cache'
          ? [{ document: 'plugin_cache_index', state: 'durable' }]
          : []),
        { document: failedDocument, state: failure },
      ];
      const nextIndex = {
        version: 1 as const,
        entries: {
          'm/p': { cachePath: pluginPath, sourceUrl: 'repo', cachedAt: 'new' },
        },
      };
      let failureResult: unknown;
      try {
        await publishPluginCachePair(nextIndex, {
          ...healthy(),
          lastRefreshed: 'new',
        });
      } catch (error) {
        failureResult = error;
      }
      expect(failureResult).toBeInstanceOf(CatalogPublicationError);
      if (!(failureResult instanceof CatalogPublicationError))
        throw new Error('expected publication error');
      expect(
        failureResult.outcomes.map(({ document, state }) => ({
          document,
          state,
        })),
      ).toEqual(expected);
      for (const outcome of failureResult.outcomes) {
        if (outcome.state === 'durable')
          expect(outcome.committed).toEqual(
            JSON.parse(
              fs.readFileSync(
                outcome.document === 'plugins_cache' ? catalogPath : indexPath,
                'utf8',
              ),
            ),
          );
        else expect(outcome.committed).toBeUndefined();
        if (outcome.state === 'installed_uncertain')
          expect(outcome.installedCandidate).toEqual(
            JSON.parse(
              fs.readFileSync(
                outcome.document === 'plugins_cache' ? catalogPath : indexPath,
                'utf8',
              ),
            ),
          );
      }
      expect(fs.readFileSync(catalogPath, 'utf8') === oldCatalog).toBe(
        failedDocument === 'plugin_cache_index' || failure === 'not_installed',
      );
      expect(fs.readFileSync(indexPath, 'utf8') === oldIndex).toBe(
        failedDocument === 'plugin_cache_index' && failure === 'not_installed',
      );
      await settleDetachedWork();
      if (
        failedDocument === 'plugins_cache' ||
        failure === 'installed_uncertain'
      )
        expect(refreshInvocableInventoryAfterMutation).toHaveBeenCalled();
      else
        expect(refreshInvocableInventoryAfterMutation).not.toHaveBeenCalled();
    },
  );

  test('a successful pair reports two durable normalized documents', async () => {
    write(healthy());
    const committed = await publishPluginCachePair(
      { version: 1, entries: {} },
      healthy(),
    );
    expect(
      committed.outcomes.map(({ document, state }) => ({ document, state })),
    ).toEqual([
      { document: 'plugin_cache_index', state: 'durable' },
      { document: 'plugins_cache', state: 'durable' },
    ]);
    expect(JSON.parse(fs.readFileSync(catalogPath, 'utf8'))).toEqual(
      committed.catalog,
    );
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf8'))).toEqual(
      committed.index,
    );
  });

  test('the second document cannot forget a foreign invalidation during the first publication', async () => {
    write(healthy());
    const before = fs.readFileSync(catalogPath, 'utf8');
    const realWrite = atomicFile.writeFileAtomically;
    jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation(async (target, data, options) => {
        await realWrite(target, data, options);
        if (target === indexPath) notePluginCatalogEffects();
      });
    await expect(
      publishPluginCachePair(
        { version: 1, entries: {} },
        { ...healthy(), lastRefreshed: 'obsolete' },
      ),
    ).rejects.toMatchObject({
      outcomes: [
        { document: 'plugin_cache_index', state: 'durable' },
        { document: 'plugins_cache', state: 'not_installed' },
      ],
    });
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe(before);
  });

  test('outgoing validation refuses both documents before installing either', async () => {
    write(healthy());
    const writeSpy = jest.spyOn(atomicFile, 'writeFileAtomically');
    await expect(
      publishPluginCachePair({ version: 1, entries: {} }, {
        ...healthy(),
        version: 7,
      } as unknown as PluginsCache),
    ).rejects.toThrow(/supported format/);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test.each(['renderer', 'desktop_cli', 'utility_process', 'daemon'] as const)(
    'refuses a self-declared %s persistence principal',
    (writer) => {
      for (const namespace of [
        'plugins_cache',
        'plugin_cache_index',
        'plugin_cache',
      ] as const)
        expect(() =>
          assertAdmittedWriter(
            namespace,
            writer,
            'main/plugins/plugin-catalog-store',
            STORAGE_OWNERSHIP,
          ),
        ).toThrow(/unlisted_writer/);
    },
  );

  test('refuses unsupported physical module declarations before temp creation', async () => {
    write(healthy());
    const before = fs.readFileSync(catalogPath, 'utf8');
    await expect(
      atomicFile.writeFileAtomically(catalogPath, '{}', {
        admittedWriter: {
          namespace: 'plugins_cache',
          writer: 'electron_main',
          module: 'main/plugins/plugin-service',
        },
      }),
    ).rejects.toThrow(/unadmitted_writer/);
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe(before);
  });

  test('production payload admission refuses before mkdir and clone effects', async () => {
    write(healthy());
    const assertWriter = storageAuthority.assertAdmittedWriter;
    jest
      .spyOn(storageAuthority, 'assertAdmittedWriter')
      .mockImplementation((namespace, writer, module, rows) => {
        if (namespace === 'plugin_cache')
          throw new storageAuthority.StorageWriteRefusedError(
            namespace,
            writer,
            'unadmitted_writer',
          );
        assertWriter(namespace, writer, module, rows);
      });
    expect(
      (
        await installPlugin('m', 'p', 'https://github.com/o/p', {
          skipRefresh: true,
        })
      ).success,
    ).toBe(false);
    expect(cloneRepo).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'plugin-cache'))).toBe(false);
    expect(fs.existsSync(indexPath)).toBe(false);
  });

  test.each([false, true])(
    'parent payload removal cannot claim the compatibility tree (aliased=%s)',
    async (aliased) => {
      write(healthy());
      const cacheRoot = path.join(root, 'plugin-cache');
      const compatibilityRoot = path.join(cacheRoot, 'codex-compatibility');
      const actualRoot = aliased
        ? path.join(cacheRoot, 'compatibility-actual')
        : compatibilityRoot;
      const payload = path.join(actualRoot, 'p');
      fs.mkdirSync(payload, { recursive: true });
      if (aliased) fs.symlinkSync(actualRoot, compatibilityRoot, 'junction');
      fs.writeFileSync(path.join(payload, 'keep'), 'separately owned');
      write(
        {
          version: 1,
          entries: {
            'm/p': { cachePath: payload, sourceUrl: 'repo', cachedAt: '' },
          },
        },
        indexPath,
      );
      const before = fs.readFileSync(indexPath, 'utf8');
      await expect(removeInstalledPluginCache('m', 'p')).rejects.toThrow(
        /separate owner/,
      );
      expect(fs.readFileSync(path.join(payload, 'keep'), 'utf8')).toBe(
        'separately owned',
      );
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(before);
    },
  );

  test.each(['parent', 'external', 'outside-alias', 'compatibility-ancestor'])(
    'reinstall cannot retire an unowned %s payload path',
    async (kind) => {
      write(healthy());
      const cacheRoot = path.join(root, 'plugin-cache');
      const compatibilityRoot = path.join(cacheRoot, 'codex-compatibility');
      fs.mkdirSync(cacheRoot, { recursive: true });
      let previousPayload: string;
      if (kind === 'parent') previousPayload = cacheRoot;
      else if (kind === 'external') previousPayload = pluginPath;
      else if (kind === 'outside-alias') {
        previousPayload = path.join(cacheRoot, 'outside-alias');
        fs.symlinkSync(pluginPath, previousPayload, 'junction');
      } else {
        previousPayload = path.join(cacheRoot, 'compatibility-parent');
        fs.mkdirSync(path.join(previousPayload, 'compatibility'), {
          recursive: true,
        });
        fs.symlinkSync(
          path.join(previousPayload, 'compatibility'),
          compatibilityRoot,
          'junction',
        );
      }
      const marker = path.join(previousPayload, 'keep');
      fs.writeFileSync(marker, 'unowned payload');
      write(
        {
          version: 1,
          entries: {
            'm/p': {
              cachePath: previousPayload,
              sourceUrl: 'repo',
              cachedAt: '',
            },
          },
        },
        indexPath,
      );
      jest.mocked(cloneRepo).mockImplementation((_url, destination) => {
        fs.mkdirSync(destination, { recursive: true });
        return Promise.resolve();
      });
      const result = await installPlugin('m', 'p', 'https://github.com/o/p', {
        skipRefresh: true,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /separate owner|outside its managed directory/,
      );
      expect(fs.readFileSync(marker, 'utf8')).toBe('unowned payload');
      const index = readPluginIndexHealth();
      if (index.state !== 'valid')
        throw new Error('expected valid installed index');
      expect(index.data.entries['m/p'].cachePath).not.toBe(previousPayload);
      expect(fs.existsSync(index.data.entries['m/p'].cachePath)).toBe(true);
    },
  );

  test.each([false, true])(
    'detached work takes a fresh slot when launched after parent settlement = %s',
    async (afterSettlement) => {
      const launch = publicationGate();
      const release = publicationGate();
      const started = publicationGate();
      const order: string[] = [];
      let child: Promise<void> = Promise.resolve();
      await runSerializedPluginMutation(() => {
        child = (async (): Promise<void> => {
          if (afterSettlement) await launch.promise;
          await enqueueDetachedPluginMutation(() => {
            order.push('child');
            return Promise.resolve();
          });
        })();
        order.push('parent');
        return Promise.resolve();
      });
      if (afterSettlement) {
        const blocker = runSerializedPluginMutation(async () => {
          started.resolve();
          await release.promise;
          order.push('released');
        });
        await started.promise;
        launch.resolve();
        await Promise.resolve();
        expect(order).toEqual(['parent']);
        release.resolve();
        await blocker;
        await child;
        expect(order).toEqual(['parent', 'released', 'child']);
      } else {
        await child;
        expect(order).toEqual(['parent', 'child']);
      }
    },
  );

  test('external installation invalidates after a partial publication, without retiring the previous payload', async () => {
    write(healthy());
    write(
      {
        version: 1,
        entries: {
          'm/p': { cachePath: pluginPath, sourceUrl: 'repo', cachedAt: '' },
        },
      },
      indexPath,
    );
    fs.writeFileSync(path.join(pluginPath, 'keep'), 'old');
    jest.mocked(cloneRepo).mockImplementation((_url, dir) => {
      fs.mkdirSync(dir, { recursive: true });
      return Promise.resolve();
    });
    const realWrite = atomicFile.writeFileAtomically;
    jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation((target, data, options) => {
        if (target === catalogPath)
          return Promise.reject(new Error('catalog install failed'));
        return realWrite(target, data, options);
      });
    const result = await installPlugin('m', 'p', 'https://github.com/o/p', {
      skipRefresh: true,
    });
    expect(result.success).toBe(false);
    expect(fs.readFileSync(path.join(pluginPath, 'keep'), 'utf8')).toBe('old');
    await settleDetachedWork();
    expect(refreshInvocableInventoryAfterMutation).toHaveBeenCalledWith(
      'plugin-catalog:settled-change',
    );
  });
});
