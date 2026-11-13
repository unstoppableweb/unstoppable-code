import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readPluginCatalog,
  readPluginCacheIndex,
} from '@canopy/execution-engine/node/plugins/catalog-read-health';
import * as scanner from '../plugin-scanner';
import * as readHealth from '@canopy/execution-engine/node/plugins/catalog-read-health';
import type * as ConfigPaths from '../../pipelines/config-paths';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import { resolvePlugins } from '@canopy/execution-engine/node/plugins/plugin-resolver';
import type {
  PluginsCache,
  PluginsCacheV1,
} from '@canopy/execution-engine/types/plugins';
import {
  addMarketplace,
  installPlugin,
  loadMarketplaces,
  loadMarketplacesCacheOnly,
  loadMarketplacesForPresentation,
  prepareCodexCompatibilityPlugin,
  readPluginCatalogHealth,
  readPluginIndexHealth,
  refreshMarketplaces,
  resetBuiltInMarketplaceScanCacheForTests,
  refreshInstalledPluginCatalog,
  recordBuiltInPluginInstallError,
  syncCuratedPluginsForRefresh,
  removeInstalledPluginCache,
  removeMarketplace,
  setCodexCompatDisabled,
  setClaudeInstalledItemEnabled,
  uninstallClaudeInstalledItem,
} from '../plugin-service';
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../../lib/preferences-store';
import { cloneRepo } from '../../lib/git';
import { runClaudeCliProcessOffMain } from '../../agents/claude-process-host-runner';
import {
  addCodexMarketplace,
  listCodexPlugins,
  removeCodexMarketplace,
  resolveCodexPluginInstallRoots,
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
jest.mock('../../lib/e2e-gate', () => ({ isE2eBuild: (): boolean => true }));
jest.mock('../../pipelines/config-paths', () => ({
  ...jest.requireActual<typeof ConfigPaths>('../../pipelines/config-paths'),
  getBundledClaudeBinaryPath: (): string => '/test/claude',
  getEnhancedEnv: (): NodeJS.ProcessEnv => ({}),
}));
jest.mock('../../lib/git', () => ({
  cloneRepo: jest.fn(),
  getHeadCommitSha: jest.fn(),
  getRemoteHeadCommitSha: jest.fn(),
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
afterEach(() => {
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
      expect(readPluginCatalogHealth().state).toBe('damaged');
      expect(readPluginCatalog(catalogPath).state).toBe('damaged');
      expect((await loadMarketplacesCacheOnly()).success).toBe(false);
      expect(resolve().sdkPlugins).toEqual([]);
      expect(fs.readFileSync(catalogPath)).toEqual(before);
    }
  });

  test('installed-item full snapshots refuse damage rather than claiming plugins absent (deferred contract gap)', async () => {
    write({ version: 2, marketplaces: [null] });
    const before = fs.readFileSync(catalogPath);
    const { installedItemService } =
      await import('../../installed-items/installed-item-service');
    await expect(installedItemService.listStatus()).rejects.toThrow('damaged');
    for (const target of [
      { kind: 'skill', sourceId: 'custom:app', skillName: 's' },
      { kind: 'plugin', marketplaceId: 'm', pluginName: 'p' },
      { kind: 'mcp-config', serverId: 'm', configId: 'c' },
      { kind: 'collection', collectionId: 'c' },
    ] as const) {
      await expect(
        installedItemService.setStatus({ target, status: 'active' }),
      ).rejects.toThrow('damaged');
    }
    await expect(
      installedItemService.uninstall({
        target: { kind: 'plugin', marketplaceId: 'm', pluginName: 'p' },
      }),
    ).rejects.toThrow('damaged');
    await expect(
      installedItemService.uninstall({
        target: { kind: 'skill', sourceId: 'custom:app', skillName: 's' },
      }),
    ).rejects.toThrow('damaged');
    expect(updatePreferencesFile).not.toHaveBeenCalled();
    expect(runClaudeCliProcessOffMain).not.toHaveBeenCalled();
    expect(removeCodexMarketplace).not.toHaveBeenCalled();
    expect(fs.readFileSync(catalogPath)).toEqual(before);
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
    'compatibility preference completion cannot return authority after %s damage',
    async (target) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const file = target === 'catalog' ? catalogPath : indexPath;
      jest.mocked(updatePreferencesFile).mockImplementation(() => {
        write({ version: 99 }, file);
        return Promise.resolve(DEFAULT_PREFERENCES);
      });
      expect((await setCodexCompatDisabled('m', 'p', false)).success).toBe(
        false,
      );
      expect(updatePreferencesFile).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"version":99}');
    },
  );

  test('Codex policy observation rechecks catalog health after its provider await', async () => {
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
    expect(
      policy.isDisabled({
        kind: 'plugin',
        marketplaceId: 'm',
        pluginName: 'p',
      }),
    ).toBe(true);
    expect(
      policy.isDisabled({ kind: 'skill', sourceId: 's', skillName: 's' }),
    ).toBe(false);
  });

  test('unhealthy plugin persistence leaves standalone skills and MCP selectable and executable', async () => {
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
    expect(effective.pluginRefs).toEqual([]);
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
    'provider completion cannot publish after %s damage',
    async (target) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const file = target === 'catalog' ? catalogPath : indexPath;
      const other = target === 'catalog' ? indexPath : catalogPath;
      const before = fs.readFileSync(other);
      jest
        .mocked(runClaudeCliProcessOffMain)
        .mockResolvedValue({ stdout: '', stderr: '' });
      jest.mocked(removeCodexMarketplace).mockImplementation(() => {
        write({ version: 99 }, file);
        return Promise.resolve({ accepted: true });
      });
      expect(
        (await removeMarketplace('m', { providers: ['codex'] })).success,
      ).toBe(false);
      expect(removeCodexMarketplace).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"version":99}');
      expect(fs.readFileSync(other)).toEqual(before);
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
    expect(indexRead).toHaveBeenCalledWith(indexPath);
    expect(indexRead).toHaveReturnedWith({ state: 'valid', data: index });
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
    ['legacy', legacy],
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
    ['damaged', (): unknown => ({ ...legacy(), marketplaces: [null] })],
    ['damaged', (): unknown => ({ version: '2', marketplaces: [] })],
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
      if (state !== 'legacy')
        expect((await refreshMarketplaces()).success).toBe(false);
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
    ['catalog', '{'],
    ['catalog', ''],
    ['catalog', '\uFFFD'],
    ['index', '{'],
    ['index', ''],
    ['index', '\uFFFD'],
  ])(
    'invalid JSON/encoding is damaged and preserved: %s %p',
    async (target, text) => {
      write(healthy());
      const file = target === 'catalog' ? catalogPath : indexPath;
      fs.writeFileSync(file, text === '\uFFFD' ? Buffer.from([0xff]) : text);
      const before = fs.readFileSync(file);
      expect(
        (target === 'catalog'
          ? readPluginCatalogHealth()
          : readPluginIndexHealth()
        ).state,
      ).toBe('damaged');
      expect((await loadMarketplacesCacheOnly()).success).toBe(false);
      expect((await refreshMarketplaces()).success).toBe(false);
      expect(resolve().sdkPlugins).toEqual([]);
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
    'index failure cannot authorize deletion or execution: %p',
    async (fixture) => {
      write(healthy());
      write(fixture, indexPath);
      const before = fs.readFileSync(indexPath);
      expect(readPluginCacheIndex(indexPath)).toEqual(readPluginIndexHealth());
      expect(['unsupported', 'damaged']).toContain(
        readPluginIndexHealth().state,
      );
      expect((await loadMarketplacesCacheOnly()).success).toBe(false);
      expect((await addMarketplace('owner/m')).success).toBe(false);
      expect((await refreshMarketplaces()).success).toBe(false);
      await expect(removeInstalledPluginCache('m', 'p')).rejects.toThrow();
      expect(resolve().sdkPlugins).toEqual([]);
      expect(
        (await loadMarketplacesForPresentation(undefined, true)).data
          ?.marketplaces,
      ).toHaveLength(1);
      expect(fs.existsSync(pluginPath)).toBe(true);
      expect(fs.readFileSync(indexPath)).toEqual(before);
    },
  );

  test.each([
    ['catalog', 'EACCES'],
    ['catalog', 'EIO'],
    ['index', 'EACCES'],
    ['index', 'EIO'],
  ])(
    'injected I/O failure is unreadable, not absent: %s %s',
    async (target, code) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const file = target === 'catalog' ? catalogPath : indexPath;
      const original = fs.readFileSync;
      const before = original(file);
      const ioError = Object.assign(new Error('injected I/O failure'), {
        code,
      });
      expect(
        (target === 'catalog' ? readPluginCatalog : readPluginCacheIndex)(
          file,
          (): never => {
            throw ioError;
          },
        ).state,
      ).toBe('unreadable');
      jest
        .spyOn(fs, 'readFileSync')
        .mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
          if (args[0] === file) throw ioError;
          return original(...args);
        });
      expect(
        (target === 'catalog'
          ? readPluginCatalogHealth()
          : readPluginIndexHealth()
        ).state,
      ).toBe('unreadable');
      expect((await loadMarketplacesCacheOnly()).success).toBe(false);
      expect((await loadMarketplaces()).success).toBe(false);
      expect((await refreshMarketplaces()).success).toBe(false);
      await expect(
        syncCuratedPluginsForRefresh({ providerNudge: 'background' }),
      ).resolves.toBeNull();
      await expect(refreshInstalledPluginCatalog('m')).rejects.toThrow();
      await expect(
        recordBuiltInPluginInstallError(
          { marketplaceId: 'm', pluginName: 'p' },
          'claude',
          'failure',
        ),
      ).rejects.toThrow();
      expect((await addMarketplace('owner/m')).success).toBe(false);
      expect((await removeMarketplace('m')).success).toBe(false);
      expect(
        (await installPlugin('m', 'p', 'https://github.com/owner/p')).success,
      ).toBe(false);
      expect((await prepareCodexCompatibilityPlugin('m', 'p')).success).toBe(
        false,
      );
      await expect(removeInstalledPluginCache('m', 'p')).rejects.toThrow();
      const policy = await readInstalledItemPolicy(DEFAULT_PREFERENCES);
      expect(
        policy.isDisabled({
          kind: 'plugin',
          marketplaceId: 'm',
          pluginName: 'p',
        }),
      ).toBe(true);
      expect(
        policy.isDisabled({ kind: 'skill', sourceId: 's', skillName: 's' }),
      ).toBe(false);
      expect(resolve().sdkPlugins).toEqual([]);
      expect(original(file)).toEqual(before);
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

  test.each(['catalog', 'index'])(
    'health is rechecked before publishing after an await: %s',
    async (target) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const file = target === 'catalog' ? catalogPath : indexPath;
      jest.mocked(readPreferencesFile).mockImplementation(() => {
        write({ version: 99 }, file);
        return Promise.resolve({ ...DEFAULT_PREFERENCES });
      });
      expect((await loadMarketplacesCacheOnly()).success).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"version":99}');
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

  test('clone completing after catalog damage cannot publish an index or overwrite catalog', async () => {
    write(healthy());
    jest.mocked(cloneRepo).mockImplementation(() => {
      write({ version: 99 });
      return Promise.resolve();
    });
    expect(
      (await installPlugin('m', 'p', 'https://github.com/owner/p')).success,
    ).toBe(false);
    expect(cloneRepo).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe('{"version":99}');
    expect(fs.existsSync(indexPath)).toBe(false);
  });

  test.each([
    ['catalog', 'EACCES'],
    ['catalog', 'EIO'],
    ['index', 'EACCES'],
    ['index', 'EIO'],
  ])(
    'I/O failure after an await blocks load and clone publication: %s %s',
    async (target, code) => {
      write(healthy());
      write({ version: 1, entries: {} }, indexPath);
      const file = target === 'catalog' ? catalogPath : indexPath;
      const original = fs.readFileSync;
      const catalogBefore = original(catalogPath);
      const indexBefore = original(indexPath);
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
      const loaded = await loadMarketplacesCacheOnly();
      expect(loaded.success).toBe(false);
      expect(loaded.error).toContain('unreadable');
      // Presentation remains usable without lending its fallback to execution.
      await expect(
        loadMarketplacesForPresentation(undefined, true),
      ).resolves.toMatchObject({ success: true });
      expect(resolve().sdkPlugins).toEqual([]);

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
      expect(installed.success).toBe(false);
      expect(installed.error).toContain('unreadable');
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(original(catalogPath)).toEqual(catalogBefore);
      expect(original(indexPath)).toEqual(indexBefore);
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
    expect(readPluginCatalog(catalogPath).state).toBe('damaged');
    expect(readPluginCatalogHealth().state).toBe('damaged');
    expect(readPluginCatalog(catalogPath)).toEqual(readPluginCatalogHealth());
    expect((await loadMarketplacesCacheOnly()).success).toBe(false);
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
  fs.writeFileSync(path.join(pluginPath, 'old-payload'), 'previous install');
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
  expect(fs.existsSync(pluginPath)).toBe(false);
});
