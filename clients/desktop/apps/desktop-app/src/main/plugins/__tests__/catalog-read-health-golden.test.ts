import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import type { LookupAddress } from 'node:dns';
import { installPluginForPrincipal } from '../remote-install-source-gate';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { pluginCopyProviderEvidence } from '../plugin-copy-provider-evidence';
import {
  readPluginCatalog,
  readPluginCacheIndex,
} from '@canopy/execution-engine/node/plugins/catalog-read-health';
import * as scanner from '../plugin-scanner';
import * as readHealth from '@canopy/execution-engine/node/plugins/catalog-read-health';
import * as copyReferences from '@canopy/execution-engine/node/plugins/plugin-copy-references';
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
  resolvePluginRepairIdentity,
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
import * as pluginService from '../plugin-service';
import * as curatedSync from '../curated-plugin-sync';
import { runCuratedMcpRefresh } from '../../mcp/refresh-scheduler';
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../../lib/preferences-store';
import { cloneRepo, getHeadCommitSha } from '../../lib/git';
import type * as GitModule from '../../lib/git';
import { execFileSync } from 'node:child_process';
import { getMcpServersIndexFilePath } from '../../lib/paths';
import * as pluginPaths from '../../lib/paths';
import { runClaudeCliProcessOffMain } from '../../agents/claude-process-host-runner';
import {
  addCodexMarketplace,
  listCodexPlugins,
  removeCodexMarketplace,
  resolveCodexPluginInstallRoots,
  refreshCuratedCodexPlugins,
} from '../codex-marketplace-service';
import { materializeCodexPluginsOffMain } from '../codex-plugin-materialization-runner';
import type * as CodexAvailability from '../../codex/codex-executable-availability';
import { readInstalledItemPolicy } from '../../installed-items/installed-item-policy';
import {
  resolveEffectivePluginSelectionRefs,
  resolvePluginInfoPath,
  resolvePlugins as resolveSessionPlugins,
} from '../plugin-resolver';

const lookupMock = jest.fn<Promise<LookupAddress[]>, [string]>();
const codexPluginListRequest = jest.fn<
  ReturnType<typeof listCodexPlugins>,
  []
>();
jest.mock('node:dns/promises', () => ({
  lookup: (host: string): Promise<LookupAddress[]> => lookupMock(host),
}));

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
jest.mock('../../codex/runtime-service', () => ({
  getCodexRuntimeService: (): {
    admin: () => { request: typeof codexPluginListRequest };
  } => ({
    admin: (): { request: typeof codexPluginListRequest } => ({
      request: codexPluginListRequest,
    }),
  }),
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
// Pass-through by default; a test opts into the real executable pre-check.
const mockCodexAvailability = { real: false };
jest.mock('../../codex/codex-executable-availability', () => {
  const actual = jest.requireActual<typeof CodexAvailability>(
    '../../codex/codex-executable-availability',
  );
  return {
    CodexNotInstalledError: actual.CodexNotInstalledError,
    probeCodexExecutableInstalled: actual.probeCodexExecutableInstalled,
    withOptionalCodex: (read: () => Promise<unknown>): Promise<unknown> =>
      read(),
    withInstalledCodex: (read: () => Promise<unknown>): Promise<unknown> =>
      mockCodexAvailability.real ? actual.withInstalledCodex(read) : read(),
  };
});
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
  writePreferencesFile: jest.fn(),
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
function resolve(pluginName = 'p'): ReturnType<typeof resolvePlugins> {
  return resolvePlugins(
    {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'm', pluginName }],
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
    expect(fs.existsSync(installedPath)).toBe(true);
    const retiredIndex = readPluginIndexHealth();
    if (retiredIndex.state !== 'valid') throw new Error('expected valid index');
    expect(retiredIndex).toEqual({
      state: 'valid',
      data: {
        version: 1,
        entries: {},
        retired: [
          {
            cachePath: installedPath,
            retiredAt: retiredIndex.data.retired?.[0].retiredAt,
          },
        ],
      },
    });
    expect(typeof retiredIndex.data.retired?.[0].retiredAt).toBe('string');
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
  const cache = healthy();
  cache.marketplaces[0].plugins[0].provenance = {
    sourceUrl: 'https://github.com/o/p',
    installedAt: '',
    marketplaceEntryName: 'p',
  };
  write(cache);
  write(
    {
      version: 1,
      entries: {
        'm/p': {
          cachePath: previousPayload,
          sourceUrl: 'https://github.com/o/p',
          provenance: {
            sourceUrl: 'https://github.com/o/p',
            installedAt: '',
            marketplaceEntryName: 'p',
          },
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
  expect(fs.existsSync(previousPayload)).toBe(true);
  expect(index.data.retired).toEqual([
    expect.objectContaining({ cachePath: previousPayload }),
  ]);
  expect(typeof index.data.retired?.[0].retiredAt).toBe('string');
  expect(fs.existsSync(pluginPath)).toBe(true);
});

describe('downloaded copy provenance and retirement (CAN-4481 R31b)', () => {
  const head = 'a'.repeat(40);
  let marketplaceRoot: string;
  beforeEach(() => {
    marketplaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-'));
  });
  afterEach(async () => {
    await settleDetachedWork();
    fs.rmSync(marketplaceRoot, { recursive: true, force: true });
  });
  function cloneFixture(installedName = 'p'): void {
    jest.mocked(getHeadCommitSha).mockResolvedValue(head);
    jest.mocked(cloneRepo).mockImplementation((_url, dir) => {
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
      write(
        { name: installedName },
        path.join(dir, '.claude-plugin', 'plugin.json'),
      );
      return Promise.resolve();
    });
  }
  function marketplaceFixture(
    sourceUrl: string,
    sourceType = 'url',
    marketplaceId = 'm',
    entryName = 'p',
    manifestName = marketplaceId,
  ): void {
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(marketplaceRoot, '.claude-plugin'), {
      recursive: true,
    });
    write(
      {
        [marketplaceId]: {
          source: { source: 'github', repo: 'owner/m' },
          installLocation: marketplaceRoot,
          lastUpdated: '',
        },
      },
      path.join(root, 'plugins', 'known_marketplaces.json'),
    );
    write(
      {
        name: manifestName,
        plugins: [
          {
            name: entryName,
            source: {
              source: sourceType,
              url: sourceUrl,
              sha: 'requested-not-cloned',
            },
          },
        ],
      },
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    );
    listCodexThroughEvidence({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    jest
      .mocked(addCodexMarketplace)
      .mockResolvedValue({ accepted: false, error: 'not supported' });
    // Update scans Codex by the existing marketplace name even after a rejected add.
    jest
      .mocked(resolveCodexPluginInstallRoots)
      .mockResolvedValue({ locations: [], unresolved: [] });
    jest
      .mocked(runClaudeCliProcessOffMain)
      .mockResolvedValue({ stdout: '', stderr: '' });
  }

  /** The sweep admits only a judged listing: mock the runtime request, not the boundary. */
  function listCodexThroughEvidence(
    response:
      | Awaited<ReturnType<typeof listCodexPlugins>>
      | (() => ReturnType<typeof listCodexPlugins>),
  ): void {
    const actual = jest.requireActual<{
      listCodexPlugins: typeof listCodexPlugins;
    }>('../codex-marketplace-service');
    jest.mocked(listCodexPlugins).mockImplementation(actual.listCodexPlugins);
    if (typeof response === 'function')
      codexPluginListRequest.mockImplementation(response);
    else codexPluginListRequest.mockResolvedValue(response);
  }

  function baseCatalog(): PluginsCache {
    const cache = healthy();
    cache.marketplaces[0].installLocation = marketplaceRoot;
    return cache;
  }
  function catalog(): PluginsCache {
    const current = readPluginCatalogHealth();
    if (current.state !== 'valid') throw new Error('expected catalog');
    return current.data;
  }
  function index(): readHealth.PluginCacheIndex {
    const current = readPluginIndexHealth();
    if (current.state !== 'valid') throw new Error('expected index');
    return current.data;
  }
  /** `uncertain` fails the directory flush after installing, as production does. */
  function failIndexWrite(
    failure: string,
  ): jest.SpiedFunction<typeof atomicFile.writeFileAtomically> {
    const realWrite = atomicFile.writeFileAtomically;
    return jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation(async (target, data, options) => {
        if (target !== indexPath) return realWrite(target, data, options);
        if (failure !== 'uncertain') throw new Error('index write failed');
        await realWrite(target, data, options);
        throw new StorageOutcomeUnknownError(
          'directory_flush',
          new Error('index flush failed'),
          'plugin_cache_index',
        );
      });
  }
  async function install(source = 'owner/p'): Promise<string> {
    const result = await installPlugin('m', 'p', source, { skipRefresh: true });
    expect(result.success).toBe(true);
    if (!result.data?.cachePath) throw new Error('expected copy');
    return result.data.cachePath;
  }
  async function refreshed(): Promise<void> {
    expect((await refreshMarketplaces()).success).toBe(true);
  }

  async function refreshedInIsolatedLifetime(): Promise<void> {
    const providers = await import('../codex-marketplace-service');
    const actualProviders = jest.requireActual<{
      listCodexPlugins: typeof listCodexPlugins;
    }>('../codex-marketplace-service');
    jest
      .mocked(providers.listCodexPlugins)
      .mockImplementation(actualProviders.listCodexPlugins);
    codexPluginListRequest.mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    jest.mocked(providers.addCodexMarketplace).mockResolvedValue({
      accepted: false,
      error: 'not supported',
    });
    jest.mocked(providers.resolveCodexPluginInstallRoots).mockResolvedValue({
      locations: [],
      unresolved: [],
    });
    const cli = await import('../../agents/claude-process-host-runner');
    jest.mocked(cli.runClaudeCliProcessOffMain).mockResolvedValue({
      stdout: '',
      stderr: '',
    });
    const preferences = await import('../../lib/preferences-store');
    jest.mocked(preferences.readPreferencesFile).mockResolvedValue({
      ...DEFAULT_PREFERENCES,
    });
    const { refreshMarketplaces: refresh } = await import('../plugin-service');
    expect((await refresh()).success).toBe(true);
    const { settleDetachedWork: settle } =
      await import('@canopy/desktop-shared/node/lib/detached-work');
    await settle();
  }

  test.each(['cache-root', 'copy-directory'])(
    'marketplace source %s protects overlapping retired copies',
    async (location) => {
      marketplaceFixture('owner/p');
      write(baseCatalog());
      await refreshed();
      const copy = path.join(root, 'plugin-cache', 'source-1234abcd');
      const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
      for (const candidate of [copy, unused]) {
        fs.mkdirSync(candidate, { recursive: true });
        fs.writeFileSync(path.join(candidate, 'payload'), 'keep');
      }
      const snapshot = catalog();
      snapshot.marketplaces[0].sourceUrl =
        location === 'cache-root' ? path.dirname(copy) : copy;
      write(snapshot);
      const retired = [copy, unused].map((cachePath) => ({
        cachePath,
        retiredAt: '2000-01-01T00:00:00Z',
      }));
      write({ version: 1, entries: {}, retired }, indexPath);
      write(
        {
          m: {
            source: { source: 'git', url: snapshot.marketplaces[0].sourceUrl },
            installLocation: marketplaceRoot,
            lastUpdated: '',
          },
        },
        path.join(root, 'plugins', 'known_marketplaces.json'),
      );
      await refreshed();
      expect(catalog().marketplaces[0].sourceUrl).toBe(
        snapshot.marketplaces[0].sourceUrl,
      );
      expect(fs.existsSync(copy)).toBe(true);
      expect(fs.readFileSync(path.join(copy, 'payload'), 'utf8')).toBe('keep');
      expect(fs.existsSync(unused)).toBe(location === 'cache-root');
      expect(index().retired).toEqual(
        location === 'cache-root' ? retired : [retired[0]],
      );
    },
  );

  test('an observed managed-root ancestor survives metadata replacement until restart', async () => {
    marketplaceFixture('owner/p');
    const copy = path.join(root, 'plugin-cache', 'old-1234abcd');
    fs.mkdirSync(copy, { recursive: true });
    const retired = [{ cachePath: copy, retiredAt: '2000-01-01T00:00:00Z' }];
    write({ version: 1, entries: {}, retired }, indexPath);
    await jest.isolateModulesAsync(async () => {
      const { readPluginCatalog: readSnapshot } =
        await import('@canopy/execution-engine/node/plugins/catalog-read-health');
      const snapshot = baseCatalog();
      snapshot.marketplaces[0].sourceUrl = path.dirname(copy);
      write(snapshot);
      expect(readSnapshot(catalogPath).state).toBe('valid');
      write(baseCatalog());
      await refreshedInIsolatedLifetime();
      expect(fs.existsSync(copy)).toBe(true);
      expect(index().retired).toEqual(retired);
    });
    // A fresh lifetime without the observation must still reclaim it.
    await jest.isolateModulesAsync(refreshedInIsolatedLifetime);
    expect(fs.existsSync(copy)).toBe(false);
    expect(index().retired).toEqual([]);
  });

  test('a queued automatic repair yields to a same-entry restricted reinstall', async () => {
    const source = 'https://github.com/owner/p';
    marketplaceFixture(source);
    write(baseCatalog());
    cloneFixture('installed-name');
    await install(source);
    const selected = catalog().marketplaces[0].plugins[0];
    const repairIdentity = await resolvePluginRepairIdentity('m', selected);
    if (!repairIdentity) throw new Error('expected repair identity');
    let entered = (): void => {};
    const installing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reinstall = runSerializedPluginMutation(async () => {
      entered();
      await gate;
      return installPlugin('m', 'installed-name', source, {
        skipRefresh: true,
        disableRedirects: true,
      });
    });
    await installing;
    jest.mocked(cloneRepo).mockClear();
    const repair = installPlugin('m', 'installed-name', source, {
      skipRefresh: true,
      repairIdentity: { ...repairIdentity, sourceUrl: source },
    });
    release();
    const reinstalled = await reinstall;
    expect(reinstalled.success).toBe(true);
    const installedIndex = fs.readFileSync(indexPath, 'utf8');
    const installedCatalog = fs.readFileSync(catalogPath, 'utf8');
    // The yielded repair hands its session the user's new copy.
    expect((await repair).data?.cachePath).toBe(reinstalled.data?.cachePath);
    expect(reinstalled.data?.cachePath).toBeTruthy();
    expect(cloneRepo).toHaveBeenCalledTimes(1);
    expect(cloneRepo).toHaveBeenCalledWith(source, expect.any(String), {
      followRedirects: false,
    });
    expect(index().entries['m/p'].provenance?.remoteSourceRestricted).toBe(
      true,
    );
    expect(
      catalog().marketplaces[0].plugins[0].provenance?.remoteSourceRestricted,
    ).toBe(true);
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(installedIndex);
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe(installedCatalog);
  });

  test('a stale repair after another session repaired the copy loads that copy', async () => {
    const source = 'https://github.com/owner/p';
    marketplaceFixture(source);
    write(
      {
        name: 'm',
        plugins: [{ name: 'p', source: { source: 'url', url: source } }],
      },
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    );
    write(baseCatalog());
    jest.mocked(getHeadCommitSha).mockResolvedValue(head);
    jest.mocked(cloneRepo).mockImplementation((_url, dir) => {
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
      write({ name: 'p' }, path.join(dir, '.claude-plugin', 'plugin.json'));
      return Promise.resolve();
    });
    lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
    await refreshed();
    const installed = await installPlugin('m', 'p', source, {
      skipRefresh: true,
    });
    if (!installed.data?.cachePath) throw new Error('expected copy');
    fs.rmSync(path.join(installed.data.cachePath, '.git', 'HEAD'));
    await refreshed();
    const stale = catalog().marketplaces[0];
    jest.mocked(cloneRepo).mockClear();
    const repaired = await resolvePluginInfoPath(
      stale.plugins[0],
      stale,
      [],
      true,
      'claude',
    );
    expect(repaired).toBe(index().entries['m/p'].cachePath);
    const warnings: string[] = [];
    expect(
      await resolvePluginInfoPath(
        stale.plugins[0],
        stale,
        warnings,
        true,
        'claude',
      ),
    ).toBe(repaired);
    expect(warnings).toEqual([]);
    expect(cloneRepo).toHaveBeenCalledTimes(1);
  });

  test('a repair cannot overwrite a restricted reinstall whose catalog publication failed', async () => {
    const source = 'https://github.com/owner/p';
    marketplaceFixture(source);
    write(
      {
        name: 'm',
        plugins: [{ name: 'p', source: { source: 'url', url: source } }],
      },
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    );
    write(baseCatalog());
    jest.mocked(getHeadCommitSha).mockResolvedValue(head);
    jest.mocked(cloneRepo).mockImplementation((_url, dir) => {
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
      write({ name: 'p' }, path.join(dir, '.claude-plugin', 'plugin.json'));
      return Promise.resolve();
    });
    lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
    await refreshed();
    const installed = await installPlugin('m', 'p', source, {
      skipRefresh: true,
    });
    const oldCopy = installed.data?.cachePath;
    if (!oldCopy) throw new Error('expected copy');
    const realWrite = atomicFile.writeFileAtomically;
    const failCatalog = jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation((target, data, options) =>
        target === catalogPath
          ? Promise.reject(new Error('catalog install failed'))
          : realWrite(target, data, options),
      );
    const reinstalled = await installPlugin('m', 'p', source, {
      skipRefresh: true,
      disableRedirects: true,
    });
    failCatalog.mockRestore();
    expect(reinstalled.success).toBe(false);
    // Index-first publication: the index has the user's copy, the catalog the old one.
    const userBinding = index().entries['m/p'];
    expect(userBinding.cachePath).not.toBe(oldCopy);
    expect(userBinding.provenance?.remoteSourceRestricted).toBe(true);
    const stale = catalog().marketplaces[0];
    expect(stale.plugins[0].cachePath).toBe(oldCopy);
    fs.rmSync(path.join(oldCopy, '.git', 'HEAD'));
    jest.mocked(cloneRepo).mockClear();
    // This caller reads its generation after the user's reinstall.
    const warnings: string[] = [];
    expect(
      await resolvePluginInfoPath(
        stale.plugins[0],
        stale,
        warnings,
        true,
        'claude',
      ),
    ).toBe(userBinding.cachePath);
    expect(warnings).toEqual([]);
    expect(cloneRepo).not.toHaveBeenCalled();
    expect(index().entries['m/p']).toEqual(userBinding);
    // Refresh then adopts the index binding the repair left in place.
    await refreshed();
    const refreshedRow = catalog().marketplaces[0].plugins[0];
    expect(refreshedRow.cachePath).toBe(userBinding.cachePath);
    expect(refreshedRow.provenance?.remoteSourceRestricted).toBe(true);
  });

  /** Reinstalls `p` while the catalog write fails, leaving the index ahead of its row. */
  async function reinstallWithFailedCatalog(
    source: string,
    restricted: boolean,
  ): Promise<readHealth.PluginCacheIndex['entries'][string]> {
    const realWrite = atomicFile.writeFileAtomically;
    const failCatalog = jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation((target, data, options) =>
        target === catalogPath
          ? Promise.reject(new Error('catalog install failed'))
          : realWrite(target, data, options),
      );
    try {
      const reinstalled = await installPlugin('m', 'p', source, {
        skipRefresh: true,
        ...(restricted ? { disableRedirects: true } : {}),
      });
      expect(reinstalled.success).toBe(false);
    } finally {
      failCatalog.mockRestore();
    }
    return index().entries['m/p'];
  }

  test.each([
    { restricted: true, catalogCopy: 'dropped', clock: 'forward' },
    { restricted: false, catalogCopy: 'dropped', clock: 'forward' },
    { restricted: true, catalogCopy: 'dropped', clock: 'rolled back' },
    { restricted: true, catalogCopy: 'damaged', clock: 'rolled back' },
  ] as const)(
    'a repair cannot overwrite a reinstall whose catalog publication failed (restricted=$restricted, catalog copy $catalogCopy, clock $clock)',
    async ({ restricted, catalogCopy, clock }) => {
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      write(baseCatalog());
      cloneFixture();
      lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
      await refreshed();
      const oldCopy = await install(source);
      if (catalogCopy === 'dropped') {
        fs.rmSync(oldCopy, { recursive: true });
        await refreshed();
        expect(catalog().marketplaces[0].plugins[0].cachePath).toBeUndefined();
      } else {
        fs.rmSync(path.join(oldCopy, '.git', 'HEAD'));
      }
      const userBinding = await reinstallWithFailedCatalog(source, restricted);
      expect(userBinding.cachePath).not.toBe(oldCopy);
      const userInstalledAt = userBinding.provenance?.installedAt;
      if (!userInstalledAt) throw new Error('expected installation time');
      if (clock === 'rolled back') {
        // The reinstall's clock ran behind the stale row's installation time.
        const later = new Date(
          Date.parse(userInstalledAt) + 60 * 60 * 1000,
        ).toISOString();
        const rolledBack = catalog();
        const row = rolledBack.marketplaces[0].plugins[0];
        for (const provenance of [
          row.provenance,
          row.facets.claude?.provenance,
        ])
          if (provenance) provenance.installedAt = later;
        write(rolledBack);
        expect(
          Date.parse(
            catalog().marketplaces[0].plugins[0].provenance?.installedAt ?? '',
          ),
        ).toBeGreaterThan(Date.parse(userInstalledAt));
      }
      jest.mocked(cloneRepo).mockClear();
      const stale = catalog().marketplaces[0];
      const warnings: string[] = [];
      expect(
        await resolvePluginInfoPath(
          stale.plugins[0],
          stale,
          warnings,
          true,
          'claude',
        ),
      ).toBe(userBinding.cachePath);
      expect(warnings).toEqual([]);
      expect(cloneRepo).not.toHaveBeenCalled();
      expect(index().entries['m/p']).toEqual(userBinding);
      expect(userBinding.provenance?.remoteSourceRestricted).toBe(
        restricted ? true : undefined,
      );
    },
  );

  test('a repair re-clones at the user policy when a reinstall whose catalog publication failed lost its copy too', async () => {
    const source = 'https://github.com/owner/p';
    marketplaceFixture(source);
    write(baseCatalog());
    cloneFixture();
    lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
    await refreshed();
    const oldCopy = await install(source);
    const userBinding = await reinstallWithFailedCatalog(source, true);
    fs.rmSync(path.join(oldCopy, '.git', 'HEAD'));
    fs.rmSync(userBinding.cachePath, { recursive: true });
    jest.mocked(cloneRepo).mockClear();
    lookupMock.mockClear();
    const stale = catalog().marketplaces[0];
    expect(stale.plugins[0].provenance?.remoteSourceRestricted).toBeUndefined();
    const warnings: string[] = [];
    const repaired = await resolvePluginInfoPath(
      stale.plugins[0],
      stale,
      warnings,
      true,
      'claude',
    );
    expect(warnings).toEqual([]);
    expect(lookupMock).toHaveBeenCalled();
    expect(cloneRepo).toHaveBeenCalledTimes(1);
    expect(cloneRepo).toHaveBeenCalledWith(source, expect.any(String), {
      followRedirects: false,
    });
    expect(repaired).toBe(index().entries['m/p'].cachePath);
    expect(repaired).not.toBe(userBinding.cachePath);
    expect(index().entries['m/p'].provenance?.remoteSourceRestricted).toBe(
      true,
    );
  });

  test.each(['rejected', 'uncertain'])(
    "a repair adopts the last reinstall copy that reached the index when a later reinstall's index write is %s",
    async (failure) => {
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      write(baseCatalog());
      cloneFixture();
      await refreshed();
      const oldCopy = await install(source);
      const first = await reinstallWithFailedCatalog(source, true);
      const failedIndex = failIndexWrite(failure);
      try {
        const second = await installPlugin('m', 'p', source, {
          skipRefresh: true,
        });
        expect(second.success).toBe(false);
      } finally {
        failedIndex.mockRestore();
      }
      const bound = index().entries['m/p'];
      // An uncertain write still landed; a rejected one left the first copy.
      if (failure === 'rejected') expect(bound).toEqual(first);
      else expect(bound.cachePath).not.toBe(first.cachePath);
      fs.rmSync(path.join(oldCopy, '.git', 'HEAD'));
      jest.mocked(cloneRepo).mockClear();
      const stale = catalog().marketplaces[0];
      expect(stale.plugins[0].cachePath).toBe(oldCopy);
      expect(
        await resolvePluginInfoPath(
          stale.plugins[0],
          stale,
          [],
          true,
          'claude',
        ),
      ).toBe(bound.cachePath);
      expect(cloneRepo).not.toHaveBeenCalled();
      expect(index().entries['m/p']).toEqual(bound);
    },
  );

  test('a failed reinstall that never reached the index does not stop an earlier session repair', async () => {
    const source = 'https://github.com/owner/p';
    marketplaceFixture(source);
    write(baseCatalog());
    cloneFixture();
    await refreshed();
    const copy = await install(source);
    fs.rmSync(path.join(copy, '.git', 'HEAD'));
    const generation = pluginService.getPluginUserMutationGeneration();
    const failedIndex = failIndexWrite('rejected');
    try {
      expect(
        (await installPlugin('m', 'p', source, { skipRefresh: true })).success,
      ).toBe(false);
    } finally {
      failedIndex.mockRestore();
    }
    expect(index().entries['m/p'].cachePath).toBe(copy);
    jest.mocked(cloneRepo).mockClear();
    const stale = catalog().marketplaces[0];
    const warnings: string[] = [];
    const repaired = await resolveAtGeneration(
      generation,
      stale.plugins[0],
      stale,
      warnings,
      true,
      'claude',
    );
    expect(warnings).toEqual([]);
    expect(cloneRepo).toHaveBeenCalledTimes(1);
    expect(repaired).toBe(index().entries['m/p'].cachePath);
    expect(repaired).not.toBe(copy);
  });

  test.each(['public', 'now-private'])(
    'an earlier session repairs a still-bound slot whose newer copy does not verify, at the stricter policy: %s source',
    async (scenario) => {
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      write(baseCatalog());
      cloneFixture();
      lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
      await refreshed();
      const copy = await install(source);
      fs.rmSync(path.join(copy, '.git', 'HEAD'));
      const generation = pluginService.getPluginUserMutationGeneration();
      const stale = catalog().marketplaces[0];
      expect(
        stale.plugins[0].provenance?.remoteSourceRestricted,
      ).toBeUndefined();
      const reinstalled = await installPlugin('m', 'p', source, {
        skipRefresh: true,
        disableRedirects: true,
      });
      const userCopy = reinstalled.data?.cachePath;
      if (!userCopy) throw new Error('expected reinstalled copy');
      // A current session repairs the user's damaged copy into another folder.
      fs.rmSync(path.join(userCopy, '.git', 'HEAD'));
      const current = catalog().marketplaces[0];
      const rebound = await resolvePluginInfoPath(
        current.plugins[0],
        current,
        [],
        true,
        'claude',
      );
      if (!rebound) throw new Error('expected repaired copy');
      expect(rebound).not.toBe(userCopy);
      await settleDetachedWork();
      expect(catalog().marketplaces[0].plugins[0].cachePath).toBe(rebound);
      fs.rmSync(path.join(rebound, '.git', 'HEAD'));
      const reboundBinding = index().entries['m/p'];
      jest.mocked(cloneRepo).mockClear();
      lookupMock.mockClear();
      if (scenario === 'now-private')
        lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      const warnings: string[] = [];
      const repaired = await resolveAtGeneration(
        generation,
        stale.plugins[0],
        stale,
        warnings,
        true,
        'claude',
      );
      // The unrestricted snapshot repairs at the restriction the slot now
      // records, including the clone-URL check a fresh session would run.
      expect(lookupMock).toHaveBeenCalled();
      if (scenario === 'now-private') {
        expect(repaired).toBeNull();
        expect(cloneRepo).not.toHaveBeenCalled();
        expect(warnings).toContainEqual(
          expect.stringContaining('resolves to a non-public address'),
        );
        expect(index().entries['m/p']).toEqual(reboundBinding);
        return;
      }
      expect(warnings).toEqual([]);
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(cloneRepo).toHaveBeenCalledWith(source, expect.any(String), {
        followRedirects: false,
      });
      expect(repaired).toBe(index().entries['m/p'].cachePath);
      expect(repaired).not.toBe(rebound);
      expect(index().entries['m/p'].provenance?.remoteSourceRestricted).toBe(
        true,
      );
    },
  );

  test.each(['public', 'now-private'])(
    'after a restart a reinstall whose catalog publication failed gets the ordinary repair, at its restricted policy: %s source',
    async (scenario) => {
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      write(baseCatalog());
      cloneFixture();
      lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
      await refreshed();
      const oldCopy = await install(source);
      const userBinding = await reinstallWithFailedCatalog(source, true);
      expect(userBinding.provenance?.remoteSourceRestricted).toBe(true);
      fs.rmSync(path.join(oldCopy, '.git', 'HEAD'));
      const stale = catalog().marketplaces[0];
      expect(
        stale.plugins[0].provenance?.remoteSourceRestricted,
      ).toBeUndefined();
      await settleDetachedWork();
      lookupMock.mockClear();
      if (scenario === 'now-private')
        lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      // Accepted gap: the user-install record is in-process only, so a fresh
      // lifetime repairs as develop did instead of adopting. The repair still
      // never skips the plugin, and clones at the policy the slot records.
      await jest.isolateModulesAsync(async () => {
        const git = await import('../../lib/git');
        jest.mocked(git.getHeadCommitSha).mockResolvedValue(head);
        jest.mocked(git.cloneRepo).mockImplementation((_url, dir) => {
          fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
          fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
          fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
          write({ name: 'p' }, path.join(dir, '.claude-plugin', 'plugin.json'));
          return Promise.resolve();
        });
        jest.mocked(git.cloneRepo).mockClear();
        const preferences = await import('../../lib/preferences-store');
        jest.mocked(preferences.readPreferencesFile).mockResolvedValue({
          ...DEFAULT_PREFERENCES,
        });
        const { resolvePluginInfoPath: resolveInLifetime } =
          await import('../plugin-resolver');
        const warnings: string[] = [];
        const repaired = await resolveInLifetime(
          stale.plugins[0],
          stale,
          warnings,
          true,
          'claude',
        );
        const { settleDetachedWork: settle } =
          await import('@canopy/desktop-shared/node/lib/detached-work');
        await settle();
        // The stale row still matches the session's, so only the index slot
        // records the restriction; the clone-URL check runs as in a fresh session.
        expect(lookupMock).toHaveBeenCalled();
        if (scenario === 'now-private') {
          expect(repaired).toBeNull();
          expect(git.cloneRepo).not.toHaveBeenCalled();
          expect(warnings).toContainEqual(
            expect.stringContaining('resolves to a non-public address'),
          );
          expect(index().entries['m/p']).toEqual(userBinding);
          return;
        }
        expect(warnings).toEqual([]);
        expect(git.cloneRepo).toHaveBeenCalledTimes(1);
        expect(git.cloneRepo).toHaveBeenCalledWith(source, expect.any(String), {
          followRedirects: false,
        });
        expect(repaired).toBe(index().entries['m/p'].cachePath);
        expect(repaired).not.toBe(userBinding.cachePath);
        expect(index().entries['m/p'].provenance?.remoteSourceRestricted).toBe(
          true,
        );
      });
    },
  );

  test('after a restart a legacy row repairs at the policy of the copy its literal-name reinstall bound', async () => {
    const source = 'https://github.com/owner/p';
    marketplaceFixture(source);
    write(baseCatalog());
    cloneFixture('installed-name');
    lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
    await refreshed();
    const oldCopy = await install(source);
    const legacy = catalog();
    forgetIdentity(legacy);
    write(legacy);
    const realWrite = atomicFile.writeFileAtomically;
    const failCatalog = jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation((target, data, options) =>
        target === catalogPath
          ? Promise.reject(new Error('catalog install failed'))
          : realWrite(target, data, options),
      );
    try {
      const reinstalled = await installPlugin('m', 'installed-name', source, {
        skipRefresh: true,
        disableRedirects: true,
      });
      expect(reinstalled.success).toBe(false);
    } finally {
      failCatalog.mockRestore();
    }
    // A legacy row's user reinstall binds its literal key, not the entry
    // repair infers for it.
    const userBinding = index().entries['m/installed-name'];
    expect(userBinding.provenance?.remoteSourceRestricted).toBe(true);
    expect(index().entries['m/p']?.cachePath).not.toBe(userBinding.cachePath);
    const stale = catalog().marketplaces[0];
    expect(stale.plugins[0].provenance).toBeUndefined();
    // An unverifiable legacy copy is kept; a missing one is repaired.
    fs.rmSync(oldCopy, { recursive: true, force: true });
    await settleDetachedWork();
    lookupMock.mockClear();
    await jest.isolateModulesAsync(async () => {
      const git = await import('../../lib/git');
      jest.mocked(git.getHeadCommitSha).mockResolvedValue(head);
      jest.mocked(git.cloneRepo).mockImplementation((_url, dir) => {
        fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
        fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
        write(
          { name: 'installed-name' },
          path.join(dir, '.claude-plugin', 'plugin.json'),
        );
        return Promise.resolve();
      });
      jest.mocked(git.cloneRepo).mockClear();
      const preferences = await import('../../lib/preferences-store');
      jest.mocked(preferences.readPreferencesFile).mockResolvedValue({
        ...DEFAULT_PREFERENCES,
      });
      const { resolvePluginInfoPath: resolveInLifetime } =
        await import('../plugin-resolver');
      const warnings: string[] = [];
      const repaired = await resolveInLifetime(
        stale.plugins[0],
        stale,
        warnings,
        true,
        'claude',
      );
      const { settleDetachedWork: settle } =
        await import('@canopy/desktop-shared/node/lib/detached-work');
      await settle();
      expect(warnings).toEqual([]);
      expect(repaired).not.toBeNull();
      expect(lookupMock).toHaveBeenCalled();
      expect(git.cloneRepo).toHaveBeenCalledTimes(1);
      expect(git.cloneRepo).toHaveBeenCalledWith(source, expect.any(String), {
        followRedirects: false,
      });
      expect(
        Object.values(index().entries).find(
          (binding) => binding.cachePath === repaired,
        )?.provenance?.remoteSourceRestricted,
      ).toBe(true);
    });
  });

  test.each([
    [
      'superseded copy stamped earlier',
      -60 * 60 * 1000,
      'superseded',
      'damaged',
    ],
    ['superseded copy stamped at the same time', 0, 'superseded', 'damaged'],
    ['superseded copy stamped later', 60 * 60 * 1000, 'superseded', 'damaged'],
    [
      'superseded copy with an unparseable time',
      undefined,
      'superseded',
      'damaged',
    ],
    [
      'superseded copy after refresh dropped the missing path',
      -60 * 60 * 1000,
      'superseded',
      'dropped',
    ],
    [
      "catalog's own copy restamped later",
      60 * 60 * 1000,
      'catalog',
      'damaged',
    ],
  ] as const)(
    'a repair yields only to the copy a user install left in the index: %s',
    async (_label, offset, bound, catalogCopyState) => {
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      write(baseCatalog());
      cloneFixture();
      lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
      await refreshed();
      const catalogCopy = await install(source);
      const catalogInstalledAt =
        catalog().marketplaces[0].plugins[0].provenance?.installedAt;
      if (!catalogInstalledAt) throw new Error('expected installation time');
      // A partial restore leaves the index on a verifiable, superseded copy.
      const superseded = path.join(
        path.dirname(catalogCopy),
        'superseded-1234abcd',
      );
      fs.cpSync(catalogCopy, superseded, { recursive: true });
      if (catalogCopyState === 'dropped') {
        fs.rmSync(catalogCopy, { recursive: true });
        await refreshed();
        expect(catalog().marketplaces[0].plugins[0].cachePath).toBeUndefined();
      } else {
        fs.rmSync(path.join(catalogCopy, '.git', 'HEAD'));
      }
      const installedAt =
        offset === undefined
          ? 'not-a-time'
          : new Date(Date.parse(catalogInstalledAt) + offset).toISOString();
      const current = index();
      const binding = current.entries['m/p'];
      write(
        {
          ...current,
          entries: {
            ...current.entries,
            'm/p': {
              ...binding,
              cachePath: bound === 'superseded' ? superseded : catalogCopy,
              cachedAt: installedAt,
              provenance: { ...binding.provenance, installedAt },
            },
          },
        },
        indexPath,
      );
      jest.mocked(cloneRepo).mockClear();
      const stale = catalog().marketplaces[0];
      const warnings: string[] = [];
      const repaired = await resolvePluginInfoPath(
        stale.plugins[0],
        stale,
        warnings,
        true,
        'claude',
      );
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(repaired).toBe(index().entries['m/p'].cachePath);
      expect(repaired).not.toBe(superseded);
      expect(repaired).not.toBe(catalogCopy);
      expect(warnings).toEqual([]);
    },
  );

  const selectedSource = 'https://github.com/owner/p';
  test.each([
    {
      label: 'another repository',
      userSource: 'https://github.com/other/p',
      adopted: false,
    },
    {
      label: 'a redacted credential-bearing source',
      userSource: 'https://user:token@github.com/owner/p',
      adopted: false,
    },
    {
      // A newer unmarked installation clears the recorded policy, and adoption
      // fetches nothing; a restricted re-clone would fail on the redirect.
      label: 'a less restricted copy whose source now redirects',
      catalogRestricted: true,
      sourceNowRedirects: true,
      adopted: true,
    },
    {
      label: 'a GitHub transport alias',
      userSource: 'git@github.com:Owner/p.git',
      adopted: true,
    },
    {
      label: 'the same credential-bearing clone URL',
      source: 'https://user:token@github.com/owner/p',
      userSource: 'https://user:token@github.com/owner/p',
      adopted: true,
    },
    { label: 'a more restricted copy', userRestricted: true, adopted: true },
  ])(
    'a repair adopts a later index copy only as the same requested plugin: $label',
    async ({
      source = selectedSource,
      userSource = selectedSource,
      catalogRestricted = false,
      userRestricted = false,
      sourceNowRedirects = false,
      adopted,
    }) => {
      marketplaceFixture(source);
      write(baseCatalog());
      cloneFixture();
      lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
      await refreshed();
      const installed = await installPlugin('m', 'p', source, {
        skipRefresh: true,
        ...(catalogRestricted ? { disableRedirects: true } : {}),
      });
      const catalogCopy = installed.data?.cachePath;
      if (!catalogCopy) throw new Error('expected copy');
      const realWrite = atomicFile.writeFileAtomically;
      const failCatalog = jest
        .spyOn(atomicFile, 'writeFileAtomically')
        .mockImplementation((target, data, options) =>
          target === catalogPath
            ? Promise.reject(new Error('catalog install failed'))
            : realWrite(target, data, options),
        );
      const reinstalled = await installPlugin('m', 'p', userSource, {
        skipRefresh: true,
        ...(userRestricted ? { disableRedirects: true } : {}),
      });
      failCatalog.mockRestore();
      expect(reinstalled.success).toBe(false);
      // Index-first publication: the catalog still records the selected source.
      const userBinding = index().entries['m/p'];
      expect(userBinding.cachePath).not.toBe(catalogCopy);
      expect(userBinding.sourceUrl).toBe(userSource);
      const stale = catalog().marketplaces[0];
      expect(stale.plugins[0]).toMatchObject({
        cachePath: catalogCopy,
        externalSource: { url: source },
      });
      // A missing copy reaches repair even when its provenance is redacted.
      fs.rmSync(catalogCopy, { recursive: true });
      jest.mocked(cloneRepo).mockClear();
      if (sourceNowRedirects)
        jest.mocked(cloneRepo).mockRejectedValue(new Error('redirect refused'));
      const warnings: string[] = [];
      const repaired = await resolvePluginInfoPath(
        stale.plugins[0],
        stale,
        warnings,
        true,
        'claude',
      );
      expect(warnings).toEqual([]);
      if (adopted) {
        expect(repaired).toBe(userBinding.cachePath);
        expect(cloneRepo).not.toHaveBeenCalled();
        expect(index().entries['m/p']).toEqual(userBinding);
        return;
      }
      // Not the same requested plugin: the ordinary repair restores the selected source.
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(cloneRepo).toHaveBeenCalledWith(source, expect.any(String), {
        followRedirects: !catalogRestricted,
      });
      expect(repaired).toBe(index().entries['m/p'].cachePath);
      expect(repaired).not.toBe(userBinding.cachePath);
      expect(repaired).not.toBe(catalogCopy);
      expect(index().entries['m/p'].sourceUrl).toBe(source);
      expect(index().entries['m/p'].provenance?.remoteSourceRestricted).toBe(
        catalogRestricted ? true : undefined,
      );
    },
  );

  test('a session snapshot cannot repair over a reinstall made while an earlier selection resolves', async () => {
    const source = (name: string): string => `https://github.com/owner/${name}`;
    marketplaceFixture(source('p'));
    write(
      {
        name: 'm',
        plugins: ['p', 'q'].map((name) => ({
          name,
          source: { source: 'url', url: source(name) },
        })),
      },
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    );
    write(baseCatalog());
    jest.mocked(getHeadCommitSha).mockResolvedValue(head);
    jest.mocked(cloneRepo).mockImplementation((url, dir) => {
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
      write(
        { name: path.basename(url) },
        path.join(dir, '.claude-plugin', 'plugin.json'),
      );
      return Promise.resolve();
    });
    lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
    await refreshed();
    for (const name of ['p', 'q']) {
      const installed = await installPlugin('m', name, source(name), {
        skipRefresh: true,
        disableRedirects: name === 'p',
      });
      if (!installed.data?.cachePath) throw new Error('expected copy');
      fs.rmSync(installed.data.cachePath, { recursive: true });
    }
    await refreshed();
    const stale = catalog().marketplaces[0];
    let validating = (): void => {};
    const paused = new Promise<void>((resolve) => {
      validating = resolve;
    });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // p's restricted repair validates its URL before the mutation slot.
    lookupMock.mockImplementationOnce(async () => {
      validating();
      await gate;
      return [{ address: '140.82.112.3', family: 4 }];
    });
    const session = resolveSessionPlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: ['p', 'q'].map((pluginName) => ({
          marketplaceId: 'm',
          pluginName,
        })),
      },
      'project',
      'worktree',
      'chat',
      {
        installExternalPlugins: true,
        skipMcpServers: true,
        claudeModAdmissionContext: undefined,
        preferences: { ...DEFAULT_PREFERENCES },
      },
    );
    try {
      await paused;
      const reinstalled = await installPlugin('m', 'q', source('q'), {
        skipRefresh: true,
        disableRedirects: true,
      });
      const userCopy = reinstalled.data?.cachePath;
      if (!userCopy) throw new Error('expected reinstalled copy');
      const userBinding = index().entries['m/q'];
      jest.mocked(cloneRepo).mockClear();
      release();
      const resolved = await session;
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(cloneRepo).toHaveBeenCalledWith(
        source('p'),
        expect.any(String),
        expect.anything(),
      );
      expect(index().entries['m/q']).toEqual(userBinding);
      expect(userBinding.provenance?.remoteSourceRestricted).toBe(true);
      const row = catalog().marketplaces[0].plugins.find(
        (plugin) => plugin.name === 'q',
      );
      expect(row?.cachePath).toBe(userCopy);
      expect(row?.provenance?.remoteSourceRestricted).toBe(true);
      expect(fs.existsSync(userCopy)).toBe(true);
      expect(index().retired ?? []).not.toContainEqual(
        expect.objectContaining({ cachePath: userCopy }),
      );
      expect(resolved.sdkPlugins).toContainEqual({
        type: 'local',
        path: index().entries['m/p'].cachePath,
      });
      // The cancelled repair loads the user's copy instead of skipping q.
      expect(resolved.sdkPlugins).toContainEqual({
        type: 'local',
        path: userCopy,
      });
      // A single-row caller reads its generation late; the binding check still applies.
      const staleRow = stale.plugins.find((plugin) => plugin.name === 'q');
      if (!staleRow) throw new Error('expected stale row');
      jest.mocked(cloneRepo).mockClear();
      expect(
        await resolvePluginInfoPath(staleRow, stale, [], true, 'claude'),
      ).toBe(userCopy);
      expect(cloneRepo).not.toHaveBeenCalled();
      expect(index().entries['m/q']).toEqual(userBinding);
    } finally {
      release();
      await session.catch(() => undefined);
    }
  });

  test.each(['facet', 'no-facet'])(
    'R38 automatic repair cannot undo uninstall during copy verification: %s',
    async (resolver) => {
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      write(baseCatalog());
      cloneFixture('installed-name');
      await install(source);
      const selected = catalog().marketplaces[0];
      const row = selected.plugins[0];
      if (!row.cachePath) throw new Error('expected bound copy');
      // Both integrity checks must see the damage, including the facet sourcePath fallback.
      fs.writeFileSync(
        path.join(row.cachePath, '.git', 'HEAD'),
        'b'.repeat(40),
      );
      let started = (): void => {};
      const verifying = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = jest
        .spyOn(fs.promises, 'readFile')
        .mockImplementationOnce(async () => {
          started();
          await gate;
          return 'b'.repeat(40);
        });
      const repair = resolvePluginInfoPath(
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        selected,
        [],
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      try {
        expect(
          await Promise.race([
            verifying.then(() => 'verifying'),
            repair.then(() => 'finished'),
          ]),
        ).toBe('verifying');
        await removeInstalledPluginCache('m', 'installed-name');
        expect(index().entries['m/p']).toBeUndefined();
        const beforeIndex = fs.readFileSync(indexPath, 'utf8');
        const beforeCatalog = fs.readFileSync(catalogPath, 'utf8');
        jest.mocked(cloneRepo).mockClear();
        release();
        expect(await repair).toBeNull();
        await settleDetachedWork();
        expect(cloneRepo).not.toHaveBeenCalled();
        expect(fs.readFileSync(indexPath, 'utf8')).toBe(beforeIndex);
        expect(fs.readFileSync(catalogPath, 'utf8')).toBe(beforeCatalog);
      } finally {
        release();
        await repair;
        read.mockRestore();
      }
    },
  );

  test.each(['facet', 'no-facet'])(
    'automatic repair cannot undo uninstall during validation: %s',
    async (resolver) => {
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      write(baseCatalog());
      cloneFixture('installed-name');
      const installed = await installPlugin('m', 'p', source, {
        skipRefresh: true,
        disableRedirects: true,
      });
      if (!installed.data?.cachePath) throw new Error('expected copy');
      const selected = catalog().marketplaces[0];
      const row = selected.plugins[0];
      fs.rmSync(installed.data.cachePath, { recursive: true });
      let started = (): void => {};
      const validating = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      lookupMock.mockImplementationOnce(async () => {
        started();
        await gate;
        return [{ address: '140.82.112.3', family: 4 }];
      });
      const repair = resolvePluginInfoPath(
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        selected,
        [],
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      try {
        expect(
          await Promise.race([
            validating.then(() => 'validating'),
            repair.then(() => 'finished'),
          ]),
        ).toBe('validating');
        await removeInstalledPluginCache('m', 'installed-name');
        expect(index().entries['m/p']).toBeUndefined();
        const beforeIndex = fs.readFileSync(indexPath, 'utf8');
        const beforeCatalog = fs.readFileSync(catalogPath, 'utf8');
        jest.mocked(cloneRepo).mockClear();
        release();
        expect(await repair).toBeNull();
        await settleDetachedWork();
        expect(cloneRepo).not.toHaveBeenCalled();
        expect(fs.readFileSync(indexPath, 'utf8')).toBe(beforeIndex);
        expect(fs.readFileSync(catalogPath, 'utf8')).toBe(beforeCatalog);
        const reinstalled = await installPlugin('m', 'p', source, {
          skipRefresh: true,
        });
        expect(reinstalled.success).toBe(true);
        expect(reinstalled.data?.cachePath).toBe(
          index().entries['m/p'].cachePath,
        );
      } finally {
        release();
        await repair;
      }
    },
  );

  test.each(['manifest-bytes'])(
    'refresh preserves legacy provider discovery with uncertain %s and defers cleanup',
    async (input) => {
      write(baseCatalog());
      marketplaceFixture('owner/p');
      if (input === 'manifest-bytes') {
        fs.writeFileSync(
          path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
          Buffer.from(
            JSON.stringify({
              name: 'm',
              description: 'café',
              plugins: [{ name: 'p', source: { url: 'owner/p' } }],
            }),
            'latin1',
          ),
        );
      } else {
        fs.writeFileSync(
          path.join(root, 'plugins', 'known_marketplaces.json'),
          Buffer.from(
            JSON.stringify({
              m: {
                source:
                  input === 'registration-shape'
                    ? { repo: 'owner/m' }
                    : { source: 'github', repo: 'owner/m' },
                installLocation: marketplaceRoot,
                description: 'café',
                lastUpdated: '',
              },
            }),
            input === 'registration-bytes' ? 'latin1' : 'utf8',
          ),
        );
      }
      const copy = path.join(root, 'plugin-cache', 'unused-1234abcd');
      fs.mkdirSync(copy, { recursive: true });
      write(
        {
          version: 1,
          entries: {},
          retired: [{ cachePath: copy, retiredAt: '2000-01-01T00:00:00Z' }],
        },
        indexPath,
      );
      await jest.isolateModulesAsync(async () => {
        await refreshedInIsolatedLifetime();
        const { readPluginCatalogHealth: read } =
          await import('../plugin-service');
        const snapshot = read();
        if (snapshot.state !== 'valid') throw new Error('expected catalog');
        const marketplace = snapshot.data.marketplaces.find(
          (row) => row.id === 'm',
        );
        expect(marketplace?.plugins.map((plugin) => plugin.name)).toEqual([
          'p',
        ]);
        expect(fs.existsSync(copy)).toBe(true);
      });
      marketplaceFixture('owner/p');
      await jest.isolateModulesAsync(refreshedInIsolatedLifetime);
      expect(fs.existsSync(copy)).toBe(false);
    },
  );

  test('uninstall retires a catalog-only copy, then a fresh lifetime reclaims it after grace', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    cloneFixture();
    const copy = await install();
    write({ version: 1, entries: {} }, indexPath);
    await removeInstalledPluginCache('m', 'p');
    expect(index().entries).toEqual({});
    const retired = index().retired;
    expect(retired).toEqual([
      { cachePath: copy, retiredAt: retired?.[0].retiredAt },
    ]);
    expect(typeof retired?.[0].retiredAt).toBe('string');
    expect(catalog().marketplaces[0].plugins[0].cachePath).toBeUndefined();
    expect(fs.existsSync(copy)).toBe(true);
    await jest.isolateModulesAsync(async () => {
      await refreshedInIsolatedLifetime();
    });
    expect(fs.existsSync(copy)).toBe(true);
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
    try {
      await refreshed();
      expect(fs.existsSync(copy)).toBe(true);
      await jest.isolateModulesAsync(async () => {
        await refreshedInIsolatedLifetime();
      });
      expect(fs.existsSync(copy)).toBe(false);
      expect(index().retired).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  test.each(['rejected', 'uncertain'])(
    'uninstall that only retires a copy still clears the catalog when the index write is %s',
    async (failure) => {
      write(baseCatalog());
      marketplaceFixture('owner/p');
      cloneFixture();
      const copy = await install();
      write({ version: 1, entries: {} }, indexPath);
      const writes = failIndexWrite(failure);
      await removeInstalledPluginCache('m', 'p');
      expect(writes.mock.calls.map(([target]) => target)).toContain(indexPath);
      const row = catalog().marketplaces[0].plugins[0];
      expect(row.cachePath).toBeUndefined();
      expect(row.facets.claude?.cachePath).toBeUndefined();
      expect(fs.existsSync(copy)).toBe(true);
      if (failure === 'rejected') {
        // The unrecorded copy leaks rather than failing a provider uninstall.
        expect(index()).toEqual({ version: 1, entries: {} });
      } else {
        expect(index()).toEqual({
          version: 1,
          entries: {},
          retired: [expect.objectContaining({ cachePath: copy })],
        });
      }
    },
  );

  test('uninstall that removes a binding still fails when the index write fails', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    cloneFixture();
    const copy = await install();
    const before = index();
    failIndexWrite('rejected');
    await expect(removeInstalledPluginCache('m', 'p')).rejects.toThrow(
      'index write failed',
    );
    expect(index()).toEqual(before);
    expect(catalog().marketplaces[0].plugins[0].cachePath).toBe(copy);
  });

  test('uninstall retires every case-folded key copy except a key another entry owns', async () => {
    marketplaceFixture('owner/Tool', 'url', 'm', 'Tool');
    write(
      {
        name: 'm',
        plugins: ['Tool', 'tool'].map((name) => ({
          name,
          source: { source: 'url', url: `owner/${name}` },
        })),
      },
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    );
    const bound = path.join(root, 'plugin-cache', 'Tool-aaaa1111');
    const variant = path.join(root, 'plugin-cache', 'TOOL-bbbb2222');
    const foreign = path.join(root, 'plugin-cache', 'tool-cccc3333');
    for (const copy of [bound, variant, foreign])
      fs.mkdirSync(copy, { recursive: true });
    const cache = baseCatalog();
    const row = cache.marketplaces[0].plugins[0];
    row.name = 'Tool';
    row.cachePath = bound;
    if (!row.facets.claude) throw new Error('expected Claude facet');
    row.facets.claude.name = 'Tool';
    row.facets.claude.cachePath = bound;
    row.facets.claude.externalSource = { source: 'url', url: 'owner/Tool' };
    // Uninstall names its entry by the recorded entry name, never by source.
    row.facets.claude.provenance = {
      sourceUrl: 'owner/Tool',
      installedAt: '',
      marketplaceEntryName: 'Tool',
    };
    write(cache);
    write(
      {
        version: 1,
        entries: {
          'm/Tool': { cachePath: bound, sourceUrl: 'owner/Tool', cachedAt: '' },
          'm/TOOL': {
            cachePath: variant,
            sourceUrl: 'owner/TOOL',
            cachedAt: '',
          },
          'm/tool': {
            cachePath: foreign,
            sourceUrl: 'owner/tool',
            cachedAt: '',
          },
        },
      },
      indexPath,
    );
    await removeInstalledPluginCache('m', 'Tool');
    const retired = (index().retired ?? []).map((entry) => entry.cachePath);
    expect(retired).toEqual(expect.arrayContaining([bound, variant]));
    expect(retired).not.toContain(foreign);
    expect(Object.keys(index().entries).sort()).toEqual(['m/TOOL', 'm/tool']);
    for (const copy of [bound, variant, foreign])
      expect(fs.existsSync(copy)).toBe(true);
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
    try {
      await jest.isolateModulesAsync(async () => {
        await refreshedInIsolatedLifetime();
      });
      expect(fs.existsSync(bound)).toBe(false);
      // A retired copy stays while a binding still names it.
      expect(fs.existsSync(variant)).toBe(true);
      expect(fs.existsSync(foreign)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  test.each([false, true])(
    'Update retires its own key copy and leaves the request literal key bound (owned elsewhere: %s)',
    async (ownedElsewhere) => {
      marketplaceFixture('owner/p');
      cloneFixture();
      write(baseCatalog());
      const previous = await install();
      if (ownedElsewhere)
        write(
          {
            name: 'm',
            plugins: ['p', 'P'].map((name) => ({
              name,
              source: { source: 'url', url: `owner/${name}` },
            })),
          },
          path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
        );
      const literal = path.join(root, 'plugin-cache', 'P-bbbb2222');
      fs.mkdirSync(literal, { recursive: true });
      const current = index();
      current.entries['m/P'] = {
        cachePath: literal,
        sourceUrl: 'owner/P',
        cachedAt: '',
      };
      write(current, indexPath);
      const result = await installPlugin('m', 'P', 'owner/p', {
        skipRefresh: true,
      });
      expect(result.success).toBe(true);
      const retired = (index().retired ?? []).map((entry) => entry.cachePath);
      expect(retired).toContain(previous);
      // The recorded entry names the key; another literal key keeps its binding.
      expect(retired).not.toContain(literal);
      expect(index().entries['m/P']).toEqual({
        cachePath: literal,
        sourceUrl: 'owner/P',
        cachedAt: '',
      });
      expect(fs.existsSync(previous)).toBe(true);
      expect(fs.existsSync(literal)).toBe(true);
    },
  );

  function addNeighborManifest(
    id: string,
    entryName: string,
    sourceUrl: string,
    manifestName = id,
  ): void {
    const location = path.join(marketplaceRoot, 'neighbor');
    fs.mkdirSync(path.join(location, '.claude-plugin'), { recursive: true });
    write(
      {
        name: manifestName,
        plugins: [
          { name: entryName, source: { source: 'url', url: sourceUrl } },
        ],
      },
      path.join(location, '.claude-plugin', 'marketplace.json'),
    );
    const file = path.join(root, 'plugins', 'known_marketplaces.json');
    const known: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!known || typeof known !== 'object' || Array.isArray(known))
      throw new Error('expected known marketplaces');
    write(
      {
        ...known,
        [id]: {
          source: { source: 'github', repo: 'owner/neighbor' },
          installLocation: location,
          lastUpdated: '',
        },
      },
      file,
    );
  }

  function forgetIdentity(cache: PluginsCache): void {
    for (const marketplace of cache.marketplaces)
      for (const row of marketplace.plugins) {
        delete row.provenance;
        if (row.facets.claude) delete row.facets.claude.provenance;
      }
  }

  test.each(['Update', 'uninstall'])(
    'entry ownership: legacy prefix/path neighbor survives %s independently',
    async (operation) => {
      write(baseCatalog());
      marketplaceFixture('owner/p');
      addNeighborManifest('m/x', 'p', 'owner/neighbor');
      cloneFixture('installed-name');
      const copy = await install();
      const cache = catalog();
      forgetIdentity(cache);
      write(cache);
      const foreign = {
        cachePath: copy,
        sourceUrl: 'owner/neighbor',
        cachedAt: '',
      };
      write({ version: 1, entries: { 'm/x/p': foreign } }, indexPath);
      if (operation === 'Update')
        expect(
          (
            await installPlugin('m', 'installed-name', 'owner/new', {
              skipRefresh: true,
            })
          ).success,
        ).toBe(true);
      else await removeInstalledPluginCache('m', 'installed-name');
      expect(index().entries['m/x/p']).toEqual(foreign);
      expect(fs.existsSync(copy)).toBe(true);
      if (operation === 'uninstall')
        expect(catalog().marketplaces[0].plugins[0].sourcePath).toBe('');
    },
  );

  test.each(['Update', 'uninstall'])(
    'overlapping entry and installed names: %s selects the installed row by its recorded entry',
    async (operation) => {
      const cache = baseCatalog();
      cache.marketplaces[0].plugins = [];
      write(cache);
      marketplaceFixture('owner/alpha', 'url', 'm', 'alpha');
      const copies = [
        { entry: 'alpha', installed: 'beta', folder: 'alpha-1111aaaa' },
        { entry: 'beta', installed: 'gamma', folder: 'beta-2222bbbb' },
      ].map((copy) => ({
        ...copy,
        cachePath: path.join(root, 'plugin-cache', copy.folder),
        sourceUrl: `owner/${copy.entry}`,
      }));
      write(
        {
          name: 'm',
          plugins: copies.map((copy) => ({
            name: copy.entry,
            source: { source: 'url', url: copy.sourceUrl },
          })),
        },
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      for (const copy of copies) {
        fs.mkdirSync(path.join(copy.cachePath, '.claude-plugin'), {
          recursive: true,
        });
        write(
          { name: copy.installed },
          path.join(copy.cachePath, '.claude-plugin', 'plugin.json'),
        );
        fs.writeFileSync(path.join(copy.cachePath, 'payload'), copy.entry);
      }
      write(
        {
          version: 1,
          entries: Object.fromEntries(
            copies.map((copy) => [
              `m/${copy.entry}`,
              {
                cachePath: copy.cachePath,
                sourceUrl: copy.sourceUrl,
                cachedAt: '',
              },
            ]),
          ),
        },
        indexPath,
      );
      await refreshed();
      const neighbor = catalog().marketplaces[0].plugins.find(
        (row) => row.name === 'gamma',
      );
      expect(neighbor?.cachePath).toBe(copies[1].cachePath);
      const neighborBinding = index().entries['m/beta'];
      if (operation === 'Update') {
        cloneFixture('beta');
        const result = await installPlugin('m', 'beta', 'owner/new-alpha', {
          skipRefresh: true,
        });
        expect(result.success).toBe(true);
        expect(result.data?.cachePath).toBeTruthy();
        expect(result.data?.cachePath).not.toBe(copies[0].cachePath);
        expect(index().entries['m/alpha'].cachePath).toBe(
          result.data?.cachePath,
        );
        expect(index().retired).toContainEqual(
          expect.objectContaining({ cachePath: copies[0].cachePath }),
        );
        expect(index().retired).not.toContainEqual(
          expect.objectContaining({ cachePath: copies[1].cachePath }),
        );
      } else {
        await removeInstalledPluginCache('m', 'beta');
        expect(index().entries['m/alpha']).toBeUndefined();
        expect(fs.existsSync(copies[0].cachePath)).toBe(true);
        expect(index().retired).toContainEqual(
          expect.objectContaining({ cachePath: copies[0].cachePath }),
        );
        expect(
          catalog().marketplaces[0].plugins.find((row) => row.name === 'beta'),
        ).toMatchObject({
          sourcePath: '',
          facets: { claude: { sourcePath: '' } },
        });
      }
      expect(index().entries['m/beta']).toEqual(neighborBinding);
      expect(
        catalog().marketplaces[0].plugins.find((row) => row.name === 'gamma'),
      ).toEqual(neighbor);
      expect(
        fs.readFileSync(path.join(copies[1].cachePath, 'payload'), 'utf8'),
      ).toBe('beta');
    },
  );

  test.each(['original-first'])(
    'uninstall drops active provenance before refresh with a colliding entry: %s',
    async (order) => {
      write(baseCatalog());
      marketplaceFixture('owner/p');
      cloneFixture('installed-name');
      await install();
      const installed = catalog().marketplaces[0].plugins[0];
      expect(installed.provenance?.installedName).toBe('installed-name');
      expect(installed.facets.claude?.provenance?.installedName).toBe(
        'installed-name',
      );

      await removeInstalledPluginCache('m', 'installed-name');
      expect(index().entries['m/p']).toBeUndefined();
      const removed = catalog().marketplaces[0].plugins[0];
      const entries = [
        { name: 'p', source: { source: 'url', url: 'owner/p' } },
        {
          name: 'installed-name',
          source: { source: 'url', url: 'owner/neighbor' },
        },
      ];
      write(
        {
          name: 'm',
          plugins: order === 'original-first' ? entries : entries.reverse(),
        },
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      // Both the initial and repeated refresh must retain both marketplace entries.
      for (let refresh = 0; refresh < 2; refresh++) {
        await refreshed();
        const rows = catalog().marketplaces[0].plugins;
        expect(rows.map((row) => row.name).sort()).toEqual([
          'installed-name',
          'p',
        ]);
        expect(rows.find((row) => row.name === 'p')?.externalSource?.url).toBe(
          'owner/p',
        );
        expect(
          rows.find((row) => row.name === 'installed-name')?.externalSource
            ?.url,
        ).toBe('owner/neighbor');
        expect(index().entries).toEqual({});
      }
      expect(removed.provenance).toBeUndefined();
      expect(removed.facets.claude?.provenance).toBeUndefined();
    },
  );

  test('uninstall unbinds an entry whose indexed copy exists while the managed cache folder is gone', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    cloneFixture('installed-name');
    await install();
    fs.rmSync(path.join(root, 'plugin-cache'), {
      recursive: true,
      force: true,
    });
    const current = index();
    expect(Object.keys(current.entries)).toEqual(['m/p']);
    current.entries['m/p'] = {
      ...current.entries['m/p'],
      cachePath: pluginPath,
    };
    write(current, indexPath);
    await removeInstalledPluginCache('m', 'installed-name');
    expect(index().entries['m/p']).toBeUndefined();
    expect(fs.existsSync(pluginPath)).toBe(true);
    const row = catalog().marketplaces[0].plugins[0];
    expect(row.cachePath).toBeUndefined();
    expect(row.provenance).toBeUndefined();
  });

  test.each(['./local', 'owner/shared'])(
    'entry ownership: a known-ownership row (%s) cannot claim a foreign removal key',
    async (source) => {
      const cache = baseCatalog();
      cache.marketplaces[0].plugins[0].name = 'x/p';
      // Every registration maps to one catalog marketplace, so legacy ownership is known.
      const neighbor = structuredClone(healthy().marketplaces[0]);
      neighbor.id = 'm/x';
      neighbor.name = 'm/x';
      neighbor.installLocation = path.join(marketplaceRoot, 'neighbor');
      neighbor.plugins[0].marketplaceId = 'm/x';
      cache.marketplaces.push(neighbor);
      write(cache);
      marketplaceFixture('owner/p');
      write(
        {
          name: 'm',
          plugins: [
            {
              name: 'x/p',
              source:
                source === './local' ? source : { source: 'url', url: source },
            },
            { name: 'q', source: { source: 'url', url: 'owner/q' } },
          ],
        },
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      addNeighborManifest('m/x', 'p', 'owner/neighbor');
      const foreignCopy = path.join(root, 'plugin-cache', 'p-aaaa1111');
      const ownedCopy = path.join(root, 'plugin-cache', 'q-bbbb2222');
      for (const copy of [foreignCopy, ownedCopy])
        fs.mkdirSync(copy, { recursive: true });
      const foreign = {
        cachePath: foreignCopy,
        sourceUrl: 'owner/neighbor',
        cachedAt: '',
      };
      const owned = {
        cachePath: ownedCopy,
        sourceUrl: 'owner/q',
        cachedAt: '',
      };
      write(
        { version: 1, entries: { 'm/x/p': foreign, 'm/q': owned } },
        indexPath,
      );
      const result = await removeMarketplace('m', { providers: ['claude'] });
      expect(result.success).toBe(true);
      expect(result.data?.removedProviders).toContain('claude');
      expect(
        catalog().marketplaces.find((row) => row.id === 'm'),
      ).toBeUndefined();
      expect(index().entries['m/q']).toBeUndefined();
      expect(index().entries['m/x/p']).toEqual(foreign);
      expect(fs.existsSync(foreignCopy)).toBe(true);
    },
  );

  test.each([
    {
      context: 'row',
      operation: 'Update',
    },
    {
      context: 'row',
      operation: 'uninstall',
    },
  ])(
    'explicit legacy request: $operation uses its literal key with $context and no manifest',
    async ({ context, operation }) => {
      const cache = baseCatalog();
      if (context === 'no-row') cache.marketplaces[0].plugins = [];
      write(cache);
      cloneFixture();
      const copy = path.join(root, 'plugin-cache', 'literal-aaaa1111');
      fs.mkdirSync(copy, { recursive: true });
      fs.writeFileSync(path.join(copy, 'payload'), 'legacy');
      const binding = { cachePath: copy, sourceUrl: 'repo', cachedAt: '' };
      write({ version: 1, entries: { 'm/p': binding } }, indexPath);
      if (operation === 'Update') {
        const result = await installPlugin('m', 'p', 'owner/new', {
          skipRefresh: true,
        });
        expect(result.success).toBe(true);
        expect(result.data?.cachePath).not.toBe(copy);
        expect(index().entries['m/p'].cachePath).toBe(result.data?.cachePath);
        expect(index().retired).toContainEqual(
          expect.objectContaining({ cachePath: copy }),
        );
      } else {
        await removeInstalledPluginCache('m', 'p');
        expect(index().entries['m/p']).toBeUndefined();
        expect(fs.existsSync(copy)).toBe(true);
        expect(index().retired).toContainEqual(
          expect.objectContaining({ cachePath: copy }),
        );
        if (context === 'row')
          expect(catalog().marketplaces[0].plugins[0].sourcePath).toBe('');
      }
    },
  );

  test.each(['Update', 'uninstall', 'removal'])(
    "entry ownership: recorded foreign tuple's copy survives %s",
    async (operation) => {
      let updatedCopy: string | undefined;
      marketplaceFixture('owner/shared', 'url', 'm', 'x/p');
      addNeighborManifest('m/x', 'p', 'owner/shared');
      const copy = path.join(root, 'plugin-cache', 'foreign-aaaa1111');
      fs.mkdirSync(copy, { recursive: true });
      fs.writeFileSync(path.join(copy, 'payload'), 'foreign');
      const cache = baseCatalog();
      const row = cache.marketplaces[0].plugins[0];
      row.name = 'x/p';
      row.cachePath = copy;
      row.provenance = {
        sourceUrl: 'owner/shared',
        installedAt: '',
        marketplaceEntryName: 'x/p',
      };
      if (!row.facets.claude) throw new Error('expected facet');
      row.facets.claude.provenance = row.provenance;
      row.facets.claude.cachePath = copy;
      row.facets.claude.externalSource = { source: 'url', url: 'owner/shared' };
      const binding = {
        cachePath: copy,
        sourceUrl: 'owner/shared',
        cachedAt: '',
        provenance: {
          sourceUrl: 'owner/shared',
          installedAt: '',
          marketplaceEntryName: 'p',
        },
      };
      if (operation === 'Update') {
        // The foreign tuple's own catalog row, recorded as installed.
        const neighbor = structuredClone(cache.marketplaces[0]);
        neighbor.id = 'm/x';
        neighbor.name = 'm/x';
        neighbor.sourceUrl = 'https://github.com/owner/neighbor';
        neighbor.installLocation = path.join(marketplaceRoot, 'neighbor');
        const neighborRow = neighbor.plugins[0];
        neighborRow.name = 'p';
        neighborRow.marketplaceId = neighbor.id;
        neighborRow.provenance = binding.provenance;
        if (neighborRow.facets.claude)
          neighborRow.facets.claude.provenance = binding.provenance;
        cache.marketplaces.push(neighbor);
      }
      write(cache);
      write({ version: 1, entries: { 'm/x/p': binding } }, indexPath);
      cloneFixture('x/p');
      if (operation === 'Update') {
        const result = await installPlugin('m', 'x/p', 'owner/new', {
          skipRefresh: true,
        });
        expect(result.success).toBe(true);
        if (!result.data?.cachePath) throw new Error('expected new copy');
        expect(result.data.cachePath).not.toBe(copy);
        updatedCopy = result.data.cachePath;
        const updated = catalog().marketplaces[0];
        expect(updated.plugins[0].cachePath).toBe(result.data.cachePath);
        expect(
          await resolvePluginInfoPath(
            updated.plugins[0],
            updated,
            [],
            false,
            'claude',
          ),
        ).toBe(result.data.cachePath);
        expect(
          fs.existsSync(
            path.join(result.data.cachePath, '.claude-plugin', 'plugin.json'),
          ),
        ).toBe(true);
        // Taking the shared slot leaves the neighbor runnable from its own copy.
        for (let pass = 0; pass < 2; pass++) {
          await refreshed();
          for (const [id, expected] of [
            ['m', result.data.cachePath],
            ['m/x', copy],
          ]) {
            const current = catalog().marketplaces.find((row) => row.id === id);
            const plugin = current?.plugins[0];
            if (!current || !plugin) throw new Error(`expected ${id} row`);
            expect(plugin.cachePath).toBe(expected);
            expect(
              await resolvePluginInfoPath(plugin, current, [], false, 'claude'),
            ).toBe(expected);
          }
        }
      } else if (operation === 'uninstall') {
        await removeInstalledPluginCache('m', 'x/p');
        const selected = catalog().marketplaces[0];
        const removed = selected.plugins[0];
        expect(removed).toMatchObject({
          sourcePath: '',
          facets: {
            claude: {
              sourcePath: '',
              installLocation: '',
            },
          },
        });
        expect(removed.cachePath).toBeUndefined();
        expect(removed.details).toBeUndefined();
        expect(removed.facets.claude?.cachePath).toBeUndefined();
        expect(removed.facets.claude?.details).toBeUndefined();
        expect(
          await resolvePluginInfoPath(removed, selected, [], false, 'claude'),
        ).toBeNull();
      } else {
        const result = await removeMarketplace('m', { providers: ['claude'] });
        expect(result.success).toBe(true);
        expect(result.data?.providerOutcomes.claude.error).toBeUndefined();
        expect(result.data?.removedProviders).toContain('claude');
        expect(
          catalog().marketplaces.find((row) => row.id === 'm'),
        ).toBeUndefined();
      }
      // Update takes the slot under its recorded entry name; the foreign copy stays.
      if (updatedCopy)
        expect(index().entries['m/x/p']).toMatchObject({
          cachePath: updatedCopy,
          provenance: { marketplaceEntryName: 'x/p' },
        });
      else expect(index().entries['m/x/p']).toEqual(binding);
      expect(fs.existsSync(copy)).toBe(true);
      expect(fs.readFileSync(path.join(copy, 'payload'), 'utf8')).toBe(
        'foreign',
      );
    },
  );

  test('entry ownership: an unreadable neighbor manifest keeps a shared legacy key through removal', async () => {
    marketplaceFixture('owner/shared', 'url', 'm', 'x/p');
    addNeighborManifest('m/x', 'p', 'owner/shared');
    fs.writeFileSync(
      path.join(
        marketplaceRoot,
        'neighbor',
        '.claude-plugin',
        'marketplace.json',
      ),
      '{ damaged',
    );
    const copy = path.join(root, 'plugin-cache', 'foreign-aaaa1111');
    fs.mkdirSync(copy, { recursive: true });
    const cache = baseCatalog();
    const row = cache.marketplaces[0].plugins[0];
    row.name = 'x/p';
    // The removed row naming the kept copy must not retire it either.
    row.cachePath = copy;
    if (row.facets.claude) row.facets.claude.cachePath = copy;
    write(cache);
    const binding = {
      cachePath: copy,
      sourceUrl: 'owner/shared',
      cachedAt: '',
    };
    write({ version: 1, entries: { 'm/x/p': binding } }, indexPath);
    const result = await removeMarketplace('m', { providers: ['claude'] });
    expect(result.success).toBe(true);
    expect(result.data?.removedProviders).toContain('claude');
    expect(
      catalog().marketplaces.find((row) => row.id === 'm'),
    ).toBeUndefined();
    expect(index().entries['m/x/p']).toEqual(binding);
    expect(index().retired ?? []).not.toContainEqual(
      expect.objectContaining({ cachePath: copy }),
    );
    expect(fs.existsSync(copy)).toBe(true);
  });

  test.each(['{ damaged', 'null', '{"m/x":"no location"}'])(
    'entry ownership: an unreadable registry or registration (%s) keeps a shared legacy key through removal',
    async (registry) => {
      marketplaceFixture('owner/shared', 'url', 'm', 'x/p');
      addNeighborManifest('m/x', 'p', 'owner/shared');
      const copy = path.join(root, 'plugin-cache', 'foreign-aaaa1111');
      fs.mkdirSync(copy, { recursive: true });
      const cache = baseCatalog();
      const row = cache.marketplaces[0].plugins[0];
      row.name = 'x/p';
      row.provenance = {
        sourceUrl: 'owner/shared',
        installedAt: '',
        marketplaceEntryName: 'x/p',
      };
      row.cachePath = copy;
      if (row.facets.claude) row.facets.claude.cachePath = copy;
      write(cache);
      const binding = {
        cachePath: copy,
        sourceUrl: 'owner/shared',
        cachedAt: '',
      };
      write({ version: 1, entries: { 'm/x/p': binding } }, indexPath);
      fs.writeFileSync(
        path.join(root, 'plugins', 'known_marketplaces.json'),
        registry,
      );
      const result = await removeMarketplace('m', { providers: ['claude'] });
      expect(result.success).toBe(true);
      expect(result.data?.removedProviders).toContain('claude');
      expect(
        catalog().marketplaces.find((row) => row.id === 'm'),
      ).toBeUndefined();
      expect(index().entries['m/x/p']).toEqual(binding);
      expect(index().retired ?? []).not.toContainEqual(
        expect.objectContaining({ cachePath: copy }),
      );
      expect(fs.existsSync(copy)).toBe(true);
    },
  );

  test.each(['Update', 'uninstall'])(
    'entry ownership: a reassigned source leaves the other entry binding through %s',
    async (operation) => {
      write(baseCatalog());
      const installCopy = async (name: string): Promise<string> => {
        marketplaceFixture('owner/s', 'url', 'm', name);
        cloneFixture(name);
        const result = await installPlugin('m', name, 'owner/s', {
          skipRefresh: true,
        });
        if (!result.data?.cachePath) throw new Error('expected copy');
        return result.data.cachePath;
      };
      const mineCopy = await installCopy('mine');
      // The manifest now maps the legacy installation's source to `other`.
      const otherCopy = await installCopy('other');
      const cache = catalog();
      const mine = cache.marketplaces[0].plugins.find(
        (row) => row.name === 'mine',
      );
      if (!mine?.facets.claude) throw new Error('expected legacy row');
      delete mine.provenance;
      delete mine.facets.claude.provenance;
      write(cache);
      const legacy = index();
      delete legacy.entries['m/mine'].provenance;
      write(legacy, indexPath);
      const otherBinding = legacy.entries['m/other'];
      if (operation === 'Update') {
        cloneFixture('mine');
        const result = await installPlugin('m', 'mine', 'owner/s2', {
          skipRefresh: true,
        });
        expect(result.success).toBe(true);
        expect(index().entries['m/mine'].cachePath).toBe(
          result.data?.cachePath,
        );
      } else {
        await removeInstalledPluginCache('m', 'mine');
        expect(index().entries['m/mine']).toBeUndefined();
      }
      const retired = (index().retired ?? []).map((entry) => entry.cachePath);
      expect(retired).toContain(mineCopy);
      expect(retired).not.toContain(otherCopy);
      expect(fs.existsSync(mineCopy)).toBe(true);
      expect(index().entries['m/other']).toEqual(otherBinding);
      expect(fs.existsSync(otherCopy)).toBe(true);
      const clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
      try {
        await jest.isolateModulesAsync(async () => {
          await refreshedInIsolatedLifetime();
        });
      } finally {
        clock.mockRestore();
      }
      expect(fs.existsSync(mineCopy)).toBe(false);
      expect(index().entries['m/other']).toEqual(otherBinding);
      expect(fs.existsSync(otherCopy)).toBe(true);
    },
  );

  test.each(['Update', 'uninstall'])(
    'entry ownership: a source reassigned to an empty entry keeps the requested binding through %s',
    async (operation) => {
      write(baseCatalog());
      marketplaceFixture('owner/s', 'url', 'm', 'mine');
      cloneFixture('mine');
      const first = await installPlugin('m', 'mine', 'owner/s', {
        skipRefresh: true,
      });
      if (!first.data?.cachePath) throw new Error('expected copy');
      const mineCopy = first.data.cachePath;
      // The manifest now maps the legacy installation's source to an empty `other`.
      write(
        {
          name: 'm',
          plugins: [
            { name: 'mine', source: { source: 'url', url: 'owner/s2' } },
            { name: 'other', source: { source: 'url', url: 'owner/s' } },
          ],
        },
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      const cache = catalog();
      forgetIdentity(cache);
      write(cache);
      const legacy = index();
      delete legacy.entries['m/mine'].provenance;
      write(legacy, indexPath);
      let replacement: string | undefined;
      if (operation === 'Update') {
        cloneFixture('mine');
        const result = await installPlugin('m', 'mine', 'owner/s2', {
          skipRefresh: true,
        });
        expect(result.success).toBe(true);
        replacement = result.data?.cachePath;
        expect(replacement).toBeDefined();
        expect(index().entries['m/mine'].cachePath).toBe(replacement);
      } else {
        await removeInstalledPluginCache('m', 'mine');
        expect(index().entries['m/mine']).toBeUndefined();
      }
      expect(index().entries['m/other']).toBeUndefined();
      expect((index().retired ?? []).map((entry) => entry.cachePath)).toContain(
        mineCopy,
      );
      expect(fs.existsSync(mineCopy)).toBe(true);
      await refreshed();
      const rows = catalog().marketplaces[0].plugins;
      const cachePathOf = (name: string): string | undefined =>
        rows.find((plugin) => plugin.name === name)?.facets.claude?.cachePath;
      expect(rows.map((plugin) => plugin.name)).toEqual(
        expect.arrayContaining(['mine', 'other']),
      );
      expect(cachePathOf('mine')).toBe(replacement);
      expect(cachePathOf('other')).toBeUndefined();
      expect(
        rows.filter((plugin) => plugin.facets.claude?.cachePath === mineCopy),
      ).toEqual([]);
      const clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
      try {
        await jest.isolateModulesAsync(async () => {
          await refreshedInIsolatedLifetime();
        });
      } finally {
        clock.mockRestore();
      }
      expect(fs.existsSync(mineCopy)).toBe(false);
      expect(index().entries['m/other']).toBeUndefined();
      expect(index().entries['m/mine']?.cachePath).toBe(replacement);
      if (replacement) expect(fs.existsSync(replacement)).toBe(true);
    },
  );

  test('uninstall keeps an inline plugin resolvable from the marketplace checkout', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    const inline = path.join(marketplaceRoot, 'plugins', 'inline');
    fs.mkdirSync(path.join(inline, '.claude-plugin'), { recursive: true });
    write(
      { name: 'inline' },
      path.join(inline, '.claude-plugin', 'plugin.json'),
    );
    write(
      { name: 'm', plugins: [{ name: 'inline', source: './plugins/inline' }] },
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    );
    await refreshed();
    await removeInstalledPluginCache('m', 'inline');
    const marketplace = catalog().marketplaces[0];
    const row = marketplace.plugins.find((plugin) => plugin.name === 'inline');
    if (!row) throw new Error('expected inline row');
    expect(row.facets.claude?.sourcePath).toBe('./plugins/inline');
    expect(row.facets.claude?.installLocation).toBe(inline);
    expect(
      await resolvePluginInfoPath(row, marketplace, [], false, 'claude'),
    ).toBe(inline);
  });

  test.each(['managed', 'outside'])(
    'entry ownership: Update keeps an aliased legacy key whose source moved to another entry (%s copy)',
    async (location) => {
      write(baseCatalog());
      marketplaceFixture('owner/p');
      cloneFixture('installed-name');
      const installed = await install();
      const copy = location === 'managed' ? installed : pluginPath;
      const cache = catalog();
      forgetIdentity(cache);
      write(cache);
      write(
        {
          version: 1,
          entries: {
            'm/installed-name': {
              cachePath: copy,
              sourceUrl: 'owner/p',
              cachedAt: '',
            },
          },
        },
        indexPath,
      );
      const manifestPath = path.join(
        marketplaceRoot,
        '.claude-plugin',
        'marketplace.json',
      );
      const entries = [
        { name: 'p', source: { source: 'url', url: 'owner/p2' } },
        { name: 'other', source: { source: 'url', url: 'owner/p' } },
      ];
      write({ name: 'm', plugins: entries }, manifestPath);
      const result = await installPlugin('m', 'installed-name', 'owner/p2', {
        skipRefresh: true,
      });
      expect(result.success).toBe(true);
      const replacement = result.data?.cachePath;
      if (!replacement) throw new Error('expected replacement');
      // Develop's literal key: no other entry's slot, no superseded binding.
      expect(Object.keys(index().entries)).toEqual(['m/installed-name']);
      expect(index().entries['m/installed-name']).toMatchObject({
        cachePath: replacement,
        provenance: { marketplaceEntryName: 'installed-name' },
      });
      // Update retires a managed copy instead of deleting it.
      expect(fs.existsSync(copy)).toBe(true);
      // The outside copy is not admitted; the replaced row's managed copy is.
      expect((index().retired ?? []).map((entry) => entry.cachePath)).toEqual([
        installed,
      ]);
      // A later listing that reuses the old name finds only the replacement.
      write(
        {
          name: 'm',
          plugins: [
            ...entries,
            {
              name: 'installed-name',
              source: { source: 'url', url: 'owner/zzz' },
            },
          ],
        },
        manifestPath,
      );
      await refreshed();
      const rows = catalog().marketplaces[0].plugins;
      const row = (name: string): (typeof rows)[number] | undefined =>
        rows.find((plugin) => plugin.name === name);
      expect(row('other')).toBeDefined();
      expect(row('other')?.facets.claude?.cachePath).toBeUndefined();
      expect(row('installed-name')?.facets.claude?.cachePath).toBe(replacement);
      expect(row('installed-name')?.sourceChanged).toBe(true);
      expect(
        rows.map((plugin) => plugin.facets.claude?.cachePath),
      ).not.toContain(copy);
    },
  );

  test.each(['manifest', 'registry'])(
    'entry ownership: a FIFO %s cannot stall marketplace removal',
    async (file) => {
      write(baseCatalog());
      marketplaceFixture('owner/p');
      cloneFixture('installed-name');
      await install();
      const target =
        file === 'manifest'
          ? path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json')
          : path.join(root, 'plugins', 'known_marketplaces.json');
      const fifo = path.join(marketplaceRoot, 'fifo');
      execFileSync('mkfifo', [fifo]);
      fs.rmSync(target);
      fs.symlinkSync(fifo, target);
      const result = await removeMarketplace('m', { providers: ['claude'] });
      expect(result.success).toBe(true);
      expect(result.data?.removedProviders).toContain('claude');
      // Unknown legacy ownership still drops the binding provenance records.
      expect(index().entries['m/p']).toBeUndefined();
    },
  );

  test('entry ownership: installing an entry named like the installed name of another entry binds its own key', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/a', 'url', 'm', 'a');
    write(
      {
        name: 'm',
        plugins: [
          { name: 'x', source: { source: 'url', url: 'owner/x' } },
          { name: 'a', source: { source: 'url', url: 'owner/a' } },
        ],
      },
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    );
    cloneFixture('x');
    const a = await installPlugin('m', 'a', 'owner/a', { skipRefresh: true });
    const aCopy = a.data?.cachePath;
    if (!aCopy) throw new Error('expected copy');
    await refreshed();
    cloneFixture('x-copy');
    const x = await installPlugin('m', 'x', 'owner/x', { skipRefresh: true });
    expect(x.success).toBe(true);
    // Develop's literal key; entry a keeps its copy.
    expect(index().entries['m/x'].cachePath).toBe(x.data?.cachePath);
    expect(index().entries['m/a'].cachePath).toBe(aCopy);
    expect(fs.existsSync(aCopy)).toBe(true);
    cloneFixture('x');
    const update = await installPlugin('m', 'x', 'owner/a', {
      skipRefresh: true,
    });
    expect(update.success).toBe(true);
    expect(index().entries['m/a'].cachePath).toBe(update.data?.cachePath);
    expect(index().entries['m/x'].cachePath).toBe(x.data?.cachePath);
  });

  test('entry ownership: two entries installing the same manifest name publish one selectable row', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/a', 'url', 'm', 'a');
    write(
      {
        name: 'm',
        plugins: [
          { name: 'b', source: { source: 'url', url: 'owner/b' } },
          { name: 'a', source: { source: 'url', url: 'owner/a' } },
        ],
      },
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    );
    const selectionNames = (): string[] =>
      (
        catalog().marketplaces.find((market) => market.id === 'm')?.plugins ??
        []
      ).map((row) => row.name.toLowerCase());
    cloneFixture('a');
    await refreshed();
    expect(
      (await installPlugin('m', 'a', 'owner/a', { skipRefresh: true })).success,
    ).toBe(true);
    await refreshed();
    // b's own row and, once refresh lets a's row win, a missing row.
    for (let pass = 0; pass < 2; pass++) {
      const b = await installPlugin('m', 'b', 'owner/b', { skipRefresh: true });
      expect(b.success).toBe(true);
      expect(index().entries['m/b'].cachePath).toBe(b.data?.cachePath);
      expect(selectionNames().filter((name) => name === 'a')).toHaveLength(1);
      expect(resolve('a').sdkPlugins).toEqual([
        { type: 'local', path: b.data?.cachePath },
      ]);
      await refreshed();
      expect(selectionNames().filter((name) => name === 'a')).toHaveLength(1);
    }
  });

  test('entry ownership: refresh keeps the history of a bound row off the entry its source moved to', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    cloneFixture('installed-name');
    const copy = await install();
    await refreshed();
    const cache = catalog();
    for (const row of cache.marketplaces[0].plugins) {
      if (row.provenance) delete row.provenance.marketplaceEntryName;
      if (row.facets.claude?.provenance)
        delete row.facets.claude.provenance.marketplaceEntryName;
    }
    write(cache);
    write(
      {
        version: 1,
        entries: {
          'm/p': { cachePath: copy, sourceUrl: 'owner/p', cachedAt: '' },
        },
      },
      indexPath,
    );
    write(
      {
        name: 'm',
        plugins: [
          { name: 'p', source: { source: 'url', url: 'owner/p2' } },
          { name: 'other', source: { source: 'url', url: 'owner/p' } },
        ],
      },
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    );
    await refreshed();
    const rows = catalog().marketplaces[0].plugins;
    expect(
      rows.find((row) => row.facets.claude?.cachePath === copy),
    ).toMatchObject({ sourceChanged: true });
    const other = rows.find((row) => row.name === 'other');
    expect(other).toBeDefined();
    expect(other?.provenance).toBeUndefined();
    expect(other?.facets.claude?.provenance).toBeUndefined();
  });

  test('entry ownership: damaged-index recovery persists entry identity through removal and re-add', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    cloneFixture('installed-name');
    const copy = await install();
    const cache = catalog();
    forgetIdentity(cache);
    write(cache);
    write({ version: 1, entries: { bad: { cachePath: 7 } } }, indexPath);
    await refreshed();
    const recovered = catalog().marketplaces.find((row) => row.id === 'm')
      ?.plugins[0];
    expect(recovered?.provenance?.marketplaceEntryName).toBe('p');
    expect(
      (await removeMarketplace('m', { providers: ['claude'] })).success,
    ).toBe(true);
    expect(index().entries['m/p']).toBeUndefined();
    expect((await addMarketplace('owner/m')).success).toBe(true);
    const readdedMarketplace = catalog().marketplaces.find(
      (row) => row.id === 'm',
    );
    expect(readdedMarketplace).toBeDefined();
    const readded = readdedMarketplace?.plugins.find(
      (plugin) => plugin.name === 'p',
    );
    expect(readded).toBeDefined();
    expect(readded?.name).toBe('p');
    expect(readded?.externalSource?.url).toBe('owner/p');
    expect(readded?.cachePath).toBeUndefined();
    expect(index().entries['m/p']).toBeUndefined();
    expect(fs.existsSync(copy)).toBe(true);
  });

  test('entry ownership: removal captures a differently named legacy provider before deletion', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    cloneFixture('installed-name');
    const copy = await install();
    const cache = catalog();
    forgetIdentity(cache);
    cache.marketplaces[0].providerStatus.claude.marketplaceName =
      'provider-name';
    write(cache);
    marketplaceFixture('owner/p', 'url', 'provider-name');
    write(
      {
        version: 1,
        entries: {
          'm/p': { cachePath: copy, sourceUrl: 'owner/p', cachedAt: '' },
        },
      },
      indexPath,
    );
    jest.mocked(runClaudeCliProcessOffMain).mockImplementation(() => {
      fs.unlinkSync(
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      fs.unlinkSync(path.join(root, 'plugins', 'known_marketplaces.json'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    expect(
      (await removeMarketplace('m', { providers: ['claude'] })).success,
    ).toBe(true);
    expect(index().entries['m/p']).toBeUndefined();
    expect(fs.existsSync(copy)).toBe(true);
  });

  test('Installed Items uninstall unbinds the stored mixed-case legacy entry despite ambiguous sources', async () => {
    marketplaceFixture('owner/shared', 'url', 'm', 'Tool');
    // This is a Canopy-only install, with no Claude CLI installation to remove.
    write(
      { version: 2, plugins: {} },
      path.join(root, 'plugins', 'installed_plugins.json'),
    );
    write({ enabledPlugins: {} }, path.join(root, 'settings.json'));
    // Uninstall also prunes legacy selections for the implicit default project.
    const defaultProjectFile =
      pluginPaths.getChatProjectProjectFilePath('default');
    fs.mkdirSync(path.dirname(defaultProjectFile), { recursive: true });
    write({ projects: [] }, pluginPaths.getChatProjectsFilePath());
    write({}, defaultProjectFile);
    write({ tabs: [] }, pluginPaths.getChatProjectChatTabsFilePath('default'));
    write(
      {
        name: 'm',
        plugins: ['Tool', 'other'].map((name) => ({
          name,
          source: { source: 'url', url: 'owner/shared' },
        })),
      },
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    );
    const copy = path.join(root, 'plugin-cache', 'Tool-aaaa1111');
    fs.mkdirSync(copy, { recursive: true });
    const cache = baseCatalog();
    const row = cache.marketplaces[0].plugins[0];
    row.name = 'Tool';
    row.cachePath = copy;
    if (!row.facets.claude) throw new Error('expected Claude facet');
    row.facets.claude.name = 'Tool';
    row.facets.claude.cachePath = copy;
    row.facets.claude.externalSource = { source: 'url', url: 'owner/shared' };
    write(cache);
    write(
      {
        version: 1,
        entries: {
          'm/Tool': {
            cachePath: copy,
            sourceUrl: 'owner/shared',
            cachedAt: '',
          },
        },
      },
      indexPath,
    );
    const { installedItemService } =
      await import('../../installed-items/installed-item-service');
    const target = {
      kind: 'plugin',
      marketplaceId: 'm',
      pluginName: 'tool',
    } as const;
    expect((await installedItemService.listStatus()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target, removable: true }),
      ]),
    );
    const result = await installedItemService.uninstall({
      target,
    });
    expect(result.errors).toEqual([]);
    expect(index().entries['m/Tool']).toBeUndefined();
    await refreshed();
    expect(
      catalog()
        .marketplaces.find((entry) => entry.id === 'm')
        ?.plugins.some((plugin) => plugin.cachePath === copy),
    ).toBe(false);
    expect(fs.existsSync(copy)).toBe(true);
    expect(index().retired).toContainEqual(
      expect.objectContaining({ cachePath: copy }),
    );
  });

  test('entry ownership: healthy partial index provenance gains entry without losing copy metadata', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    cloneFixture('installed-name');
    await install();
    const before = index();
    const provenance = before.entries['m/p'].provenance;
    if (!provenance) throw new Error('expected provenance');
    delete provenance.marketplaceEntryName;
    write(before, indexPath);
    await refreshed();
    expect(
      catalog().marketplaces.find((row) => row.id === 'm')?.plugins[0]
        .provenance,
    ).toEqual({ ...provenance, marketplaceEntryName: 'p' });
  });

  test('entry ownership: partial facet does not hide row identity during Update', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    cloneFixture('installed-name');
    const oldCopy = await install();
    const cache = catalog();
    const row = cache.marketplaces[0].plugins[0];
    if (!row.facets.claude) throw new Error('expected facet');
    row.facets.claude.provenance = { sourceUrl: 'owner/p', installedAt: '' };
    write(cache);
    // Only the row's recorded entry name links the installed alias to m/p.
    marketplaceFixture('owner/new');
    const result = await installPlugin('m', 'installed-name', 'owner/new', {
      skipRefresh: true,
    });
    expect(result.success).toBe(true);
    expect(result.data?.cachePath).not.toBe(oldCopy);
    expect(catalog().marketplaces[0].plugins).toHaveLength(1);
    expect(catalog().marketplaces[0].plugins[0].cachePath).toBe(
      result.data?.cachePath,
    );
    expect(index().entries['m/p'].cachePath).toBe(result.data?.cachePath);
    expect(index().entries['m/installed-name']).toBeUndefined();
  });

  test.each(['recorded-row', 'unrecorded'])(
    'entry ownership: duplicate exact sources during %s recovery',
    async (identity) => {
      write(baseCatalog());
      marketplaceFixture('owner/p');
      cloneFixture('installed-name');
      const copy = await install();
      const cache = catalog();
      const row = cache.marketplaces[0].plugins[0];
      if (!row.facets.claude) throw new Error('expected facet');
      row.facets.claude.provenance = { sourceUrl: 'owner/p', installedAt: '' };
      if (identity === 'unrecorded') delete row.provenance;
      write(cache);
      write(
        {
          name: 'm',
          plugins: ['other', 'p'].map((name) => ({
            name,
            source: { source: 'url', url: 'owner/p' },
          })),
        },
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      write({ version: 1, entries: { bad: { cachePath: 7 } } }, indexPath);
      await refreshed();
      const marketplace = catalog().marketplaces.find((row) => row.id === 'm');
      expect(marketplace).toBeDefined();
      if (!marketplace) throw new Error('expected marketplace');
      const plugins = marketplace.plugins;
      expect(plugins.map((plugin) => plugin.name).sort()).toEqual(
        identity === 'recorded-row'
          ? ['installed-name', 'other']
          : ['other', 'p'],
      );
      const bound = plugins.filter((plugin) => plugin.cachePath === copy);
      expect(bound).toHaveLength(identity === 'recorded-row' ? 1 : 0);
      if (identity === 'recorded-row')
        expect(bound[0].provenance?.marketplaceEntryName).toBe('p');
    },
  );

  test.each(['raw', 'redacted-only'])(
    'entry ownership: %s legacy source evidence never binds recovery to a redaction-equal entry',
    async (evidence) => {
      write(baseCatalog());
      const raw = 'https://h.example/r?x=1';
      marketplaceFixture(raw);
      cloneFixture('installed-name');
      const copy = await install(raw);
      const cache = catalog();
      const row = cache.marketplaces[0].plugins[0];
      if (!row.facets.claude) throw new Error('expected facet');
      delete row.provenance;
      row.facets.claude.provenance = { sourceUrl: raw, installedAt: '' };
      if (evidence === 'redacted-only') delete row.facets.claude.externalSource;
      write(cache);
      // Redaction turns p's install URL into q's.
      write(
        {
          name: 'm',
          plugins: [
            {
              name: 'q',
              source: { source: 'url', url: 'https://h.example/r' },
            },
            { name: 'p', source: { source: 'url', url: raw } },
          ],
        },
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      write({ version: 1, entries: { bad: { cachePath: 7 } } }, indexPath);
      await refreshed();
      const bound = (
        catalog().marketplaces.find((market) => market.id === 'm')?.plugins ??
        []
      ).filter((plugin) => plugin.cachePath === copy);
      // Raw evidence recovers p; redacted-only evidence leaves the copy unbound.
      expect(
        bound.map((plugin) => plugin.provenance?.marketplaceEntryName),
      ).toEqual(evidence === 'raw' ? ['p'] : []);
      expect(fs.existsSync(copy)).toBe(true);
    },
  );

  test('first install with an empty colliding slot stays executable after refresh', async () => {
    marketplaceFixture('owner/shared', 'url', 'm', 'x/p');
    addNeighborManifest('m/x', 'p', 'owner/shared');
    const cache = baseCatalog();
    cache.marketplaces[0].plugins = [];
    cache.marketplaces[0].pluginCount = 0;
    write(cache);
    write({ version: 1, entries: {} }, indexPath);
    cloneFixture('installed-name');
    const result = await installPlugin('m', 'x/p', 'owner/shared', {
      skipRefresh: true,
    });
    expect(result.success).toBe(true);
    const copy = result.data?.cachePath;
    if (!copy) throw new Error('expected installed copy');
    const ownBinding = {
      cachePath: copy,
      provenance: { marketplaceEntryName: 'x/p' },
    };
    expect(index().entries['m/x/p']).toMatchObject(ownBinding);
    fs.writeFileSync(path.join(copy, 'README.md'), 'installed details');
    for (let pass = 0; pass < 2; pass++) {
      await refreshed();
      const current = catalog().marketplaces.find(
        (market) => market.id === 'm',
      );
      if (!current) throw new Error('expected marketplace');
      const row = current.plugins[0];
      expect(row).toMatchObject({
        name: 'installed-name',
        cachePath: copy,
        provenance: { marketplaceEntryName: 'x/p', commit: head },
        facets: { claude: { cachePath: copy, installLocation: copy } },
        details: { hasReadme: true },
      });
      expect(
        await resolvePluginInfoPath(row, current, [], false, 'claude'),
      ).toBe(copy);
      expect(index().entries['m/x/p']).toMatchObject(ownBinding);
      expect(
        catalog().marketplaces.find((market) => market.id === 'm/x')?.plugins[0]
          .cachePath,
      ).toBeUndefined();
    }
  });

  test.each([
    'refresh',
    'Update',
    'Update-missing',
    'Update-incomplete',
    'Update-incomplete-same-source',
    'uninstall',
    'removal',
  ])(
    'entry ownership: joined-key collision keeps the legacy copy during %s',
    async (operation) => {
      let updatedCopy: string | undefined;
      marketplaceFixture(
        'owner/shared',
        'url',
        'selected-registration',
        'x/p',
        'm',
      );
      addNeighborManifest('neighbor-registration', 'p', 'owner/shared', 'm/x');
      const cache = baseCatalog();
      cache.marketplaces[0].providerStatus.claude.marketplaceName =
        'selected-registration';
      const row = cache.marketplaces[0].plugins[0];
      row.name = 'x/p';
      row.cachePath = pluginPath;
      if (!row.facets.claude) throw new Error('expected facet');
      row.facets.claude.cachePath = pluginPath;
      row.facets.claude.externalSource = { source: 'url', url: 'owner/shared' };
      const neighbor = structuredClone(cache.marketplaces[0]);
      neighbor.id = 'm/x';
      neighbor.providerStatus.claude.marketplaceName = 'neighbor-registration';
      neighbor.sourceUrl = 'https://github.com/owner/neighbor';
      neighbor.installLocation = path.join(marketplaceRoot, 'neighbor');
      neighbor.plugins[0].name = 'p';
      neighbor.plugins[0].marketplaceId = neighbor.id;
      cache.marketplaces.push(neighbor);
      forgetIdentity(cache);
      write(cache);
      const binding = {
        cachePath: pluginPath,
        sourceUrl: 'owner/shared',
        cachedAt: '',
      };
      write({ version: 1, entries: { 'm/x/p': binding } }, indexPath);
      fs.writeFileSync(path.join(pluginPath, 'payload'), 'foreign');
      cloneFixture('x/p');
      const alignRegistrationsForRefresh = (): void => {
        // Refresh's pre-existing source merge keeps the registration ID. Identity
        // ownership is tested above that boundary, with both catalog rows present.
        marketplaceFixture('owner/shared', 'url', 'm', 'x/p');
        addNeighborManifest('m/x', 'p', 'owner/shared');
      };
      if (operation === 'refresh') {
        alignRegistrationsForRefresh();
        await refreshed();
        for (const [id, name] of [
          ['m', 'x/p'],
          ['m/x', 'p'],
        ]) {
          const current = catalog().marketplaces.find((row) => row.id === id);
          expect(current).toBeDefined();
          if (!current) throw new Error('expected marketplace');
          expect(current.plugins.map((plugin) => plugin.name)).toEqual([name]);
          expect(
            current.plugins[0].provenance?.marketplaceEntryName,
          ).toBeUndefined();
        }
      } else if (operation.startsWith('Update')) {
        // Refresh advertises owner/shared, so an owner/new Update has drifted.
        const updateSource =
          operation === 'Update-incomplete-same-source'
            ? 'owner/shared'
            : 'owner/new';
        const result = await installPlugin('m', 'x/p', updateSource, {
          skipRefresh: true,
        });
        expect(result.success).toBe(true);
        if (!result.data?.cachePath) throw new Error('expected new copy');
        expect(result.data.cachePath).not.toBe(pluginPath);
        updatedCopy = result.data.cachePath;
        const updated = catalog().marketplaces.find((row) => row.id === 'm');
        if (!updated) throw new Error('expected selected marketplace');
        expect(updated.plugins[0].cachePath).toBe(result.data.cachePath);
        expect(
          await resolvePluginInfoPath(
            updated.plugins[0],
            updated,
            [],
            false,
            'claude',
          ),
        ).toBe(result.data.cachePath);
        expect(
          fs.existsSync(
            path.join(result.data.cachePath, '.claude-plugin', 'plugin.json'),
          ),
        ).toBe(true);
        // Reconciliation must not undo a successful Update over a joined-key collision.
        fs.writeFileSync(
          path.join(result.data.cachePath, 'README.md'),
          'new details',
        );
        // Refresh keeps every existing copy bound; resolution verifies it, so a
        // same-source refresh cannot lose the path a later drift keeps (CAN-7698).
        const kept = operation !== 'Update-missing';
        if (operation === 'Update-missing')
          fs.rmSync(result.data.cachePath, { recursive: true });
        if (operation.startsWith('Update-incomplete'))
          fs.rmSync(path.join(result.data.cachePath, '.git', 'HEAD'));
        const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
        fs.mkdirSync(unused, { recursive: true });
        write(
          {
            ...index(),
            retired: [{ cachePath: unused, retiredAt: '2000-01-01T00:00:00Z' }],
          },
          indexPath,
        );
        alignRegistrationsForRefresh();
        for (let pass = 0; pass < 2; pass++) {
          await refreshed();
          const current = catalog().marketplaces.find((row) => row.id === 'm')
            ?.plugins[0];
          expect(current?.cachePath).toBe(
            kept ? result.data.cachePath : undefined,
          );
          expect(current?.facets.claude?.installLocation).toBe(
            kept ? result.data.cachePath : '',
          );
          expect(current?.details?.hasReadme).toBe(kept ? true : undefined);
          expect(current?.provenance?.sourceUrl).toBe(updateSource);
        }
        expect(fs.existsSync(unused)).toBe(false);
        if (operation === 'Update-incomplete') {
          // Damage must not turn the advertised source change into an implicit Update.
          const selected = catalog().marketplaces.find((row) => row.id === 'm');
          if (!selected) throw new Error('expected selected marketplace');
          const warnings: string[] = [];
          jest.mocked(cloneRepo).mockClear();
          expect(
            await resolvePluginInfoPath(
              selected.plugins[0],
              selected,
              warnings,
              true,
              'claude',
            ),
          ).toBe(result.data.cachePath);
          expect(warnings.length).toBeGreaterThan(0);
          expect(cloneRepo).not.toHaveBeenCalled();
        }
        if (operation === 'Update-incomplete-same-source') {
          // Same-source refreshes keep the path, so later drift still keeps the copy.
          marketplaceFixture('owner/drifted', 'url', 'm', 'x/p');
          addNeighborManifest('m/x', 'p', 'owner/shared');
          await refreshed();
          const selected = catalog().marketplaces.find((row) => row.id === 'm');
          if (!selected) throw new Error('expected selected marketplace');
          expect(selected.plugins[0]).toMatchObject({
            cachePath: result.data.cachePath,
            sourceChanged: true,
          });
          const warnings: string[] = [];
          jest.mocked(cloneRepo).mockClear();
          expect(
            await resolvePluginInfoPath(
              selected.plugins[0],
              selected,
              warnings,
              true,
              'claude',
            ),
          ).toBe(result.data.cachePath);
          expect(warnings.length).toBeGreaterThan(0);
          expect(cloneRepo).not.toHaveBeenCalled();
        }
      } else if (operation === 'uninstall') {
        await removeInstalledPluginCache('m', 'x/p');
        const selected = catalog().marketplaces.find((row) => row.id === 'm');
        if (!selected) throw new Error('expected selected marketplace');
        const removed = selected.plugins[0];
        expect(removed).toMatchObject({
          sourcePath: '',
          facets: {
            claude: {
              sourcePath: '',
              installLocation: '',
            },
          },
        });
        expect(removed?.cachePath).toBeUndefined();
        expect(removed?.details).toBeUndefined();
        expect(removed?.facets.claude?.cachePath).toBeUndefined();
        expect(removed?.facets.claude?.details).toBeUndefined();
        expect(
          await resolvePluginInfoPath(removed, selected, [], false, 'claude'),
        ).toBeNull();
      } else {
        const result = await removeMarketplace('m', { providers: ['claude'] });
        expect(result.success).toBe(true);
        expect(result.data?.providerOutcomes.claude.error).toBeUndefined();
        expect(result.data?.removedProviders).toContain('claude');
        expect(
          catalog().marketplaces.find((row) => row.id === 'm'),
        ).toBeUndefined();
      }
      // Update takes the slot under its recorded entry name; the legacy copy stays.
      if (updatedCopy)
        expect(index().entries['m/x/p']).toMatchObject({
          cachePath: updatedCopy,
          provenance: { marketplaceEntryName: 'x/p' },
        });
      else expect(index().entries['m/x/p']).toEqual(binding);
      expect(fs.existsSync(pluginPath)).toBe(true);
      expect(fs.readFileSync(path.join(pluginPath, 'payload'), 'utf8')).toBe(
        'foreign',
      );
    },
  );

  test.each(['raw-file-source', 'claude-installed'])(
    'refresh retirement retains a sole %s reference and deletes an unused copy',
    async (evidence) => {
      // Raw # remains portable; literal ? filenames are covered in scratch on POSIX.
      if (evidence === 'raw-file-source') {
        const oldRoot = root;
        root = `${root}#raw-data`;
        fs.renameSync(oldRoot, root);
        catalogPath = path.join(root, 'plugins-cache.json');
        indexPath = path.join(root, 'plugin-cache-index.json');
        pluginPath = path.join(root, 'plugin');
        process.env.CANOPY_DATA_DIR = root;
        process.env.CLAUDE_CONFIG_DIR = root;
      }
      const copy = path.join(root, 'plugin-cache', 'source-1234abcd');
      const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
      for (const candidate of [copy, unused]) {
        fs.mkdirSync(candidate, { recursive: true });
        fs.writeFileSync(path.join(candidate, 'payload'), 'source');
      }
      marketplaceFixture(
        evidence === 'raw-file-source' ? `file://${copy}` : 'owner/p',
      );
      const cache = baseCatalog();
      if (evidence.startsWith('marketplace-')) {
        const sourceUrl =
          evidence === 'marketplace-path' ? copy : pathToFileURL(copy).href;
        cache.marketplaces[0].sourceUrl = sourceUrl;
        write(
          {
            m: {
              source: { source: 'url', url: sourceUrl },
              installLocation: marketplaceRoot,
              lastUpdated: '',
            },
          },
          path.join(root, 'plugins', 'known_marketplaces.json'),
        );
      }
      if (evidence === 'claude-installed')
        write(
          {
            version: 2,
            plugins: {
              'unlisted@other': [{ scope: 'user', installPath: copy }],
            },
          },
          path.join(root, 'plugins', 'installed_plugins.json'),
        );
      write(cache);
      const retired = [copy, unused].map((cachePath) => ({
        cachePath,
        retiredAt: '2000-01-01T00:00:00Z',
      }));
      write({ version: 1, entries: {}, retired }, indexPath);
      await refreshed();
      await refreshed();
      expect(fs.existsSync(copy)).toBe(true);
      expect(fs.readFileSync(path.join(copy, 'payload'), 'utf8')).toBe(
        'source',
      );
      expect(fs.existsSync(unused)).toBe(false);
      expect(index().retired).toEqual([retired[0]]);
      expect(index().entries).toEqual({});
    },
  );

  test('uninstall retains another marketplace source but clears the selected row and binding', async () => {
    marketplaceFixture('owner/p');
    cloneFixture();
    write(baseCatalog());
    const copy = await install();
    fs.writeFileSync(path.join(copy, 'payload'), 'shared marketplace source');
    const cache = catalog();
    const neighbor = structuredClone(cache.marketplaces[0]);
    neighbor.id = 'other';
    neighbor.sourceUrl = pathToFileURL(copy).href;
    neighbor.plugins = [];
    cache.marketplaces.push(neighbor);
    write(cache);
    const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
    fs.mkdirSync(unused, { recursive: true });
    write(
      {
        ...index(),
        retired: [{ cachePath: unused, retiredAt: '2000-01-01T00:00:00Z' }],
      },
      indexPath,
    );
    await removeInstalledPluginCache('m', 'p');
    expect(index().entries['m/p']).toBeUndefined();
    expect(catalog().marketplaces[0].plugins[0].cachePath).toBeUndefined();
    expect(catalog().marketplaces[0].plugins[0].details).toBeUndefined();
    expect(
      catalog().marketplaces[0].plugins[0].facets.claude?.cachePath,
    ).toBeUndefined();
    expect(
      catalog().marketplaces[0].plugins[0].facets.claude?.details,
    ).toBeUndefined();
    expect(fs.existsSync(copy)).toBe(true);
    const sharedRetirement = index().retired?.find(
      (entry) => entry.cachePath === copy,
    );
    expect(sharedRetirement?.cachePath).toBe(copy);
    expect(typeof sharedRetirement?.retiredAt).toBe('string');
    expect(fs.existsSync(unused)).toBe(true);
    // Past the grace period in a fresh lifetime, only the neighbor's source
    // reference keeps the shared copy.
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
    try {
      await jest.isolateModulesAsync(refreshedInIsolatedLifetime);
    } finally {
      clock.mockRestore();
    }
    expect(fs.existsSync(unused)).toBe(false);
    expect(fs.existsSync(copy)).toBe(true);
    expect(fs.readFileSync(path.join(copy, 'payload'), 'utf8')).toBe(
      'shared marketplace source',
    );
    expect(index().retired).toEqual([sharedRetirement]);
  });

  test.each([
    'failure',
    'partial',
    'unlocatable source',
    'unlocatable marketplace',
    'empty without its manifest',
    'empty while its manifest lists plugins',
    'empty without a path',
  ])(
    'refresh succeeds but skips retirement after a provider listing %s',
    async (evidence) => {
      marketplaceFixture('owner/p');
      write(baseCatalog());
      const codexManifest = path.join(
        root,
        'codex-market',
        '.agents',
        'plugins',
        'marketplace.json',
      );
      const emptyListing = (
        manifestPath: string | null,
      ): Awaited<ReturnType<typeof listCodexPlugins>> => ({
        marketplaces: [
          {
            name: 'local-market',
            path: manifestPath,
            interface: null,
            plugins: [],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      });
      const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
      fs.mkdirSync(unused, { recursive: true });
      write(
        {
          version: 1,
          entries: {},
          retired: [{ cachePath: unused, retiredAt: '2000-01-01T00:00:00Z' }],
        },
        indexPath,
      );
      // Keep listCodexPlugins' evidence boundary; mock only the runtime request.
      const actual = jest.requireActual<{
        listCodexPlugins: typeof listCodexPlugins;
      }>('../codex-marketplace-service');
      jest.mocked(listCodexPlugins).mockImplementation(actual.listCodexPlugins);
      if (evidence === 'failure')
        codexPluginListRequest.mockRejectedValue(
          new Error('provider unavailable'),
        );
      else if (evidence === 'empty without its manifest')
        // Codex lists a missing or unreadable manifest as an empty marketplace.
        codexPluginListRequest.mockResolvedValue(emptyListing(codexManifest));
      else if (evidence === 'empty while its manifest lists plugins') {
        fs.mkdirSync(path.dirname(codexManifest), { recursive: true });
        write(
          {
            name: 'local-market',
            plugins: [
              {
                name: 'p',
                source: { source: 'local', path: './plugins/p' },
              },
            ],
          },
          codexManifest,
        );
        codexPluginListRequest.mockResolvedValue(emptyListing(codexManifest));
      } else if (evidence === 'empty without a path')
        codexPluginListRequest.mockResolvedValue(emptyListing(null));
      else if (evidence === 'unlocatable marketplace')
        // The protocol requires an absolute or null marketplace path. The
        // listing is otherwise valid, so the path is its only defect.
        codexPluginListRequest.mockResolvedValue(
          listedPlugin(
            '.agents/plugins/marketplace.json',
            path.join(root, 'codex-market', 'plugins', 'p'),
          ),
        );
      else if (evidence === 'unlocatable source')
        // The protocol requires absolute local paths; a relative one names no copy.
        codexPluginListRequest.mockResolvedValue(
          listedPlugin(null, 'plugins/p'),
        );
      else
        codexPluginListRequest.mockResolvedValue({
          marketplaces: [],
          marketplaceLoadErrors: [
            { marketplacePath: '/unavailable', message: 'load failed' },
          ],
          featuredPluginIds: [],
        });
      await refreshed();
      expect(fs.existsSync(unused)).toBe(true);
      // A genuinely empty marketplace stays eligible: its manifest lists nothing.
      fs.mkdirSync(path.dirname(codexManifest), { recursive: true });
      write({ name: 'local-market', plugins: [] }, codexManifest);
      codexPluginListRequest.mockResolvedValue(emptyListing(codexManifest));
      await refreshed();
      expect(fs.existsSync(unused)).toBe(false);
    },
  );

  function listedPlugin(
    marketplacePath: string | null,
    sourcePath: string,
  ): Awaited<ReturnType<typeof listCodexPlugins>> {
    return {
      marketplaces: [
        {
          name: 'local-market',
          path: marketplacePath,
          interface: null,
          plugins: [
            {
              id: 'p@local-market',
              remotePluginId: null,
              version: null,
              localVersion: null,
              name: 'p',
              shareContext: null,
              source: { type: 'local', path: sourcePath },
              installed: true,
              installedAt: null,
              enabled: true,
              installPolicy: 'AVAILABLE',
              installPolicySource: null,
              mustShowInstallationInterstitial: null,
              authPolicy: 'ON_INSTALL',
              availability: 'AVAILABLE',
              disabledReason: null,
              eligiblePlanTypes: null,
              interface: null,
              keywords: [],
            },
          ],
        },
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    };
  }

  test('refresh reclaims retired copies when the Codex CLI is not installed', async () => {
    marketplaceFixture('owner/p');
    write(baseCatalog());
    const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
    fs.mkdirSync(unused, { recursive: true });
    write(
      {
        version: 1,
        entries: {},
        retired: [{ cachePath: unused, retiredAt: '2000-01-01T00:00:00Z' }],
      },
      indexPath,
    );
    const actual = jest.requireActual<{
      listCodexPlugins: typeof listCodexPlugins;
    }>('../codex-marketplace-service');
    jest.mocked(listCodexPlugins).mockImplementation(actual.listCodexPlugins);
    const previousExecutable = process.env.CODEX_EXECUTABLE;
    // The real pre-check rejects this absolute path before any runtime request.
    const executable = path.join(root, 'missing-codex');
    process.env.CODEX_EXECUTABLE = executable;
    mockCodexAvailability.real = true;
    const restored = path.join(root, 'plugin-cache', 'restored-1234abcd');
    try {
      await refreshed();
      expect(jest.mocked(listCodexPlugins)).toHaveBeenCalled();
      expect(codexPluginListRequest).not.toHaveBeenCalled();
      expect(fs.existsSync(unused)).toBe(false);
      expect(index().retired).toEqual([]);
      // Restored while the pre-check still caches its miss: absence is unproven.
      fs.mkdirSync(restored, { recursive: true });
      write(
        {
          version: 1,
          entries: {},
          retired: [{ cachePath: restored, retiredAt: '2000-01-01T00:00:00Z' }],
        },
        indexPath,
      );
      fs.writeFileSync(executable, '', { mode: 0o755 });
      await refreshed();
    } finally {
      mockCodexAvailability.real = false;
      if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE;
      else process.env.CODEX_EXECUTABLE = previousExecutable;
    }
    expect(fs.existsSync(restored)).toBe(true);
  });

  test('refresh stops reclaiming once the Codex CLI is restored between deletions', async () => {
    marketplaceFixture('owner/p');
    write(baseCatalog());
    const copies = ['first-1234abcd', 'second-1234abcd', 'third-1234abcd'].map(
      (name) => path.join(root, 'plugin-cache', name),
    );
    for (const copy of copies) fs.mkdirSync(copy, { recursive: true });
    const retired = copies.map((cachePath) => ({
      cachePath,
      retiredAt: '2000-01-01T00:00:00Z',
    }));
    write({ version: 1, entries: {}, retired }, indexPath);
    const actual = jest.requireActual<{
      listCodexPlugins: typeof listCodexPlugins;
    }>('../codex-marketplace-service');
    jest.mocked(listCodexPlugins).mockImplementation(actual.listCodexPlugins);
    const previousExecutable = process.env.CODEX_EXECUTABLE;
    const executable = path.join(root, 'missing-codex');
    process.env.CODEX_EXECUTABLE = executable;
    mockCodexAvailability.real = true;
    // As the sweep first inspects each candidate: leave Codex missing, restore
    // it, then remove it again. Only a stopped cycle keeps the third copy.
    const steps = [
      (): void => undefined,
      (): void => fs.writeFileSync(executable, '', { mode: 0o755 }),
      (): void => fs.rmSync(executable),
    ];
    const realLstat = fs.promises.lstat;
    const inspected: string[] = [];
    jest
      .spyOn(fs.promises, 'lstat')
      .mockImplementation(async (...args: Parameters<typeof realLstat>) => {
        const [target] = args;
        if (
          typeof target === 'string' &&
          copies.includes(target) &&
          !inspected.includes(target)
        ) {
          steps[inspected.length]?.();
          inspected.push(target);
        }
        return realLstat(...args);
      });
    try {
      await refreshed();
    } finally {
      mockCodexAvailability.real = false;
      if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE;
      else process.env.CODEX_EXECUTABLE = previousExecutable;
    }
    // Pins the window: the listing judged Codex absent, then the sweep reached each candidate.
    expect(codexPluginListRequest).not.toHaveBeenCalled();
    expect(inspected).toHaveLength(copies.length);
    const [reclaimed, ...kept] = inspected;
    expect(fs.existsSync(reclaimed)).toBe(false);
    for (const copy of kept) expect(fs.existsSync(copy)).toBe(true);
    expect(index().retired).toEqual(
      expect.arrayContaining(
        retired.filter(({ cachePath }) => cachePath !== reclaimed),
      ),
    );
    expect(index().retired).toHaveLength(kept.length);
  });

  test.each([
    { change: 'installed registry row', token: 'e0000001' },
    { change: 'known marketplace', token: 'e0000002' },
    { change: 'manifest rewritten in place', token: 'e0000003' },
    { change: 'catalog replaced', token: 'e0000004' },
    { change: 'damaged preimage', token: 'e0000005' },
    { change: 'nothing', token: 'e0000006' },
  ] as const)(
    'refresh stops reclaiming once evidence it read changes between deletions: $change',
    async ({ change, token }) => {
      marketplaceFixture('owner/p');
      write(baseCatalog());
      // Process history matches copy basenames: a per-case token keeps one
      // case's observed reference from protecting the next case's copy.
      const copies = [`first-${token}`, `second-${token}`].map((name) =>
        path.join(root, 'plugin-cache', name),
      );
      for (const copy of copies) fs.mkdirSync(copy, { recursive: true });
      const retired = copies.map((cachePath) => ({
        cachePath,
        retiredAt: '2000-01-01T00:00:00Z',
      }));
      write({ version: 1, entries: {}, retired }, indexPath);
      const manifestPath = path.join(
        marketplaceRoot,
        '.claude-plugin',
        'marketplace.json',
      );
      // Each change names the copy through a file the sweep already read, and
      // changes its size: coarse timestamps alone may not reveal a rewrite.
      const name = (copy: string): void => {
        if (change === 'installed registry row')
          write(
            {
              version: 2,
              plugins: { 'late@m': [{ scope: 'user', installPath: copy }] },
            },
            path.join(root, 'plugins', 'installed_plugins.json'),
          );
        else if (change === 'known marketplace') {
          const late = path.join(root, 'late-market');
          fs.mkdirSync(path.join(late, '.claude-plugin'), { recursive: true });
          write(
            { name: 'late', plugins: [{ name: 'late', source: copy }] },
            path.join(late, '.claude-plugin', 'marketplace.json'),
          );
          const registry = path.join(
            root,
            'plugins',
            'known_marketplaces.json',
          );
          const parsed: unknown = JSON.parse(fs.readFileSync(registry, 'utf8'));
          if (typeof parsed !== 'object' || parsed === null)
            throw new Error('expected registry');
          write(
            {
              ...parsed,
              late: {
                source: { source: 'github', repo: 'owner/late' },
                installLocation: late,
                lastUpdated: '',
              },
            },
            registry,
          );
        } else if (change === 'manifest rewritten in place')
          fs.writeFileSync(
            manifestPath,
            JSON.stringify({
              name: 'm',
              plugins: [{ name: 'late', source: copy }],
            }),
          );
        else if (change === 'catalog replaced') {
          const next = baseCatalog();
          next.marketplaces[0].plugins[0].cachePath = copy;
          write(next, `${catalogPath}.tmp`);
          fs.renameSync(`${catalogPath}.tmp`, catalogPath);
        } else if (change === 'damaged preimage') {
          const preimage = baseCatalog();
          preimage.marketplaces[0].plugins[0].cachePath = copy;
          write(preimage, `${catalogPath}.damaged-${Date.now()}`);
        }
      };
      const realLstat = fs.promises.lstat;
      const inspected: string[] = [];
      jest
        .spyOn(fs.promises, 'lstat')
        .mockImplementation(async (...args: Parameters<typeof realLstat>) => {
          const [target] = args;
          if (
            typeof target === 'string' &&
            copies.includes(target) &&
            !inspected.includes(target)
          ) {
            // After the first copy's removal, before the second's recheck.
            if (inspected.length === 1) name(target);
            inspected.push(target);
          }
          return realLstat(...args);
        });
      await refreshed();
      expect(inspected).toHaveLength(copies.length);
      const [reclaimed, named] = inspected;
      expect(fs.existsSync(reclaimed)).toBe(false);
      if (change === 'nothing') {
        // The sweep's own removal and effects never trip the recheck.
        expect(fs.existsSync(named)).toBe(false);
        expect(index().retired).toEqual([]);
        return;
      }
      expect(fs.existsSync(named)).toBe(true);
      expect(index().retired).toEqual(
        retired.filter(({ cachePath }) => cachePath === named),
      );
    },
  );

  test('refresh skips cleanup while marketplace text exceeds the token-index cap', async () => {
    marketplaceFixture('owner/p');
    write(baseCatalog());
    const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
    fs.mkdirSync(unused, { recursive: true });
    write(
      {
        version: 1,
        entries: {},
        retired: [{ cachePath: unused, retiredAt: '2000-01-01T00:00:00Z' }],
      },
      indexPath,
    );
    const actualCollector = copyReferences.pluginCopyReferenceCollector;
    const collectors = jest
      .spyOn(copyReferences, 'pluginCopyReferenceCollector')
      .mockImplementation(() => actualCollector({ maxTokenOccurrences: 100 }));
    const manifestPath = path.join(
      marketplaceRoot,
      '.claude-plugin',
      'marketplace.json',
    );
    const before = fs.readFileSync(manifestPath);
    const manifest: unknown = JSON.parse(before.toString('utf8'));
    if (typeof manifest !== 'object' || manifest === null)
      throw new Error('expected manifest');
    // Publisher text within the file-size limit: one token record per match.
    write({ ...manifest, notes: 'x-0badf00d '.repeat(1000) }, manifestPath);
    await refreshed();
    expect(collectors).toHaveBeenCalled();
    expect(fs.existsSync(unused)).toBe(true);
    expect(index().retired).toEqual([
      { cachePath: unused, retiredAt: '2000-01-01T00:00:00Z' },
    ]);
    // The same cap admits ordinary evidence: only the over-cap cycle leaks.
    fs.writeFileSync(manifestPath, before);
    await refreshed();
    expect(fs.existsSync(unused)).toBe(false);
  });

  test.each([
    { name: 'installed_plugins.json', damage: 'unreadable' },
    { name: 'installed_plugins.json', damage: 'over-long file URL' },
  ])(
    'refresh skips cleanup for $damage evidence in $name and resumes when repaired',
    async ({ name, damage }) => {
      marketplaceFixture('owner/p');
      write(baseCatalog());
      const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
      fs.mkdirSync(unused, { recursive: true });
      write(
        {
          version: 1,
          entries: {},
          retired: [{ cachePath: unused, retiredAt: '2000-01-01T00:00:00Z' }],
        },
        indexPath,
      );
      const file = path.join(root, 'plugins', name);
      const before = fs.existsSync(file)
        ? fs.readFileSync(file)
        : Buffer.from(
            JSON.stringify(
              name === 'installed_plugins.json'
                ? { version: 2, plugins: {} }
                : {},
            ),
          );
      if (damage === 'unreadable') {
        fs.writeFileSync(file, '{');
        await refreshed();
        expect(fs.existsSync(unused)).toBe(true);
        fs.writeFileSync(file, before);
        await refreshed();
        expect(fs.existsSync(unused)).toBe(false);
        return;
      }
      // Over the per-string cap: never normalized, so unmappable until restart.
      write(
        {
          version: 2,
          plugins: {},
          note: `file:///${'a'.repeat(140_000)}`,
        },
        file,
      );
      await jest.isolateModulesAsync(refreshedInIsolatedLifetime);
      expect(fs.existsSync(unused)).toBe(true);
      fs.writeFileSync(file, before);
      await jest.isolateModulesAsync(refreshedInIsolatedLifetime);
      expect(fs.existsSync(unused)).toBe(false);
    },
  );

  test.each([
    { file: 'installed_plugins.json', row: { scope: 'user' } },
    { file: 'installed_plugins.json', row: { scope: 'user', installPath: '' } },
    {
      file: 'installed_plugins.json',
      row: { scope: 'user', installPath: 'relative/p' },
    },
    {
      file: 'known_marketplaces.json',
      row: { source: { source: 'github', repo: 'o/x' }, installLocation: '' },
    },
    {
      // installLocation is replaced by an existing checkout without a manifest.
      file: 'known_marketplaces.json',
      row: {
        source: { source: 'github', repo: 'o/x' },
        installLocation: 'checkout without .claude-plugin/marketplace.json',
      },
    },
  ])(
    'refresh skips cleanup while $file has a row its reader cannot locate: $row',
    async ({ file, row }) => {
      const checkout = path.join(root, 'manifestless-checkout');
      fs.mkdirSync(checkout, { recursive: true });
      const written =
        row.installLocation?.startsWith('checkout') === true
          ? { ...row, installLocation: checkout }
          : row;
      marketplaceFixture('owner/p');
      write(baseCatalog());
      const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
      fs.mkdirSync(unused, { recursive: true });
      write(
        {
          version: 1,
          entries: {},
          retired: [{ cachePath: unused, retiredAt: '2000-01-01T00:00:00Z' }],
        },
        indexPath,
      );
      const target = path.join(root, 'plugins', file);
      const before = fs.existsSync(target)
        ? fs.readFileSync(target)
        : Buffer.from(JSON.stringify({ version: 2, plugins: {} }));
      const parsed: unknown = JSON.parse(before.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null)
        throw new Error('expected provider file');
      write(
        file === 'installed_plugins.json'
          ? { version: 2, plugins: { 'p@other': [written] } }
          : { ...parsed, other: written },
        target,
      );
      await refreshed();
      expect(fs.existsSync(unused)).toBe(true);
      fs.writeFileSync(target, before);
      await refreshed();
      expect(fs.existsSync(unused)).toBe(false);
    },
  );

  test.each([
    { name: 'elsewhere', protects: false, unlocatable: false },
    { name: 'at the retired copy', protects: true, unlocatable: false },
    { name: 'without a path', protects: true, unlocatable: true },
  ])(
    'refresh reads a singleton Claude install record $name',
    async ({ protects, unlocatable }) => {
      marketplaceFixture('owner/p');
      write(baseCatalog());
      const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
      fs.mkdirSync(unused, { recursive: true });
      write(
        {
          version: 1,
          entries: {},
          retired: [{ cachePath: unused, retiredAt: '2000-01-01T00:00:00Z' }],
        },
        indexPath,
      );
      const installPath = protects
        ? unused
        : path.join(root, 'claude-installs', 'p');
      fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
      write(
        {
          version: 2,
          plugins: {
            'p@other': unlocatable
              ? { scope: 'user' }
              : { scope: 'user', installPath },
          },
        },
        path.join(root, 'plugins', 'installed_plugins.json'),
      );
      // Observed references outlive a refresh; keep them out of later cases.
      await jest.isolateModulesAsync(refreshedInIsolatedLifetime);
      expect(fs.existsSync(unused)).toBe(protects);
    },
  );

  test.each(['scanned', 'cached', 'dropped-facet'])(
    'refresh skips cleanup while the curated Codex listing omits a known plugin (%s)',
    async (variant) => {
      // No external marketplace: its provider rechecks would advance the
      // generation and stale a memo warmed before them.
      write({ ...baseCatalog(), marketplaces: [] });
      jest
        .mocked(resolveCodexPluginInstallRoots)
        .mockResolvedValue({ locations: [], unresolved: [] });
      jest
        .mocked(runClaudeCliProcessOffMain)
        .mockResolvedValue({ stdout: '', stderr: '' });
      resetBuiltInMarketplaceScanCacheForTests();
      const curatedRoot = path.join(root, 'curated-plugins', 'marketplace');
      const p = path.join(curatedRoot, 'plugins', 'p');
      for (const kind of ['.claude-plugin', '.codex-plugin']) {
        fs.mkdirSync(path.join(p, kind), { recursive: true });
        write({ name: 'p' }, path.join(p, kind, 'plugin.json'));
      }
      fs.mkdirSync(path.join(curatedRoot, '.claude-plugin'), {
        recursive: true,
      });
      fs.mkdirSync(path.join(curatedRoot, '.agents', 'plugins'), {
        recursive: true,
      });
      write(
        { name: 'curated', plugins: [{ name: 'p', source: './plugins/p' }] },
        path.join(curatedRoot, '.claude-plugin', 'marketplace.json'),
      );
      const codexManifest = path.join(
        curatedRoot,
        '.agents',
        'plugins',
        'marketplace.json',
      );
      // A manifest-named plugin with no local tree never becomes a facet.
      const names = variant === 'dropped-facet' ? ['p', 'q'] : ['p', 'r'];
      if (variant !== 'dropped-facet') {
        const r = path.join(curatedRoot, 'plugins', 'r', '.codex-plugin');
        fs.mkdirSync(r, { recursive: true });
        write({ name: 'r' }, path.join(r, 'plugin.json'));
      }
      write(
        {
          name: 'curated',
          plugins: names.map((name) => ({
            name,
            source: { source: 'local', path: `./plugins/${name}` },
          })),
        },
        codexManifest,
      );
      jest.spyOn(curatedSync, 'syncCuratedPlugins').mockResolvedValue({
        status: 'skipped',
        added: [],
        changed: [],
        removed: [],
        errors: [],
      });
      const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
      fs.mkdirSync(unused, { recursive: true });
      write(
        {
          version: 1,
          entries: {},
          retired: [{ cachePath: unused, retiredAt: '2000-01-01T00:00:00Z' }],
        },
        indexPath,
      );
      const curatedListing = (
        listed: string[],
      ): Awaited<ReturnType<typeof listCodexPlugins>> => ({
        marketplaces: [
          {
            name: curatedSync.getCuratedPluginMarketplaceName(),
            path: null,
            interface: null,
            plugins: listed.map((name) => ({
              id: `${name}@${curatedSync.getCuratedPluginMarketplaceName()}`,
              remotePluginId: null,
              version: null,
              localVersion: null,
              name,
              shareContext: null,
              source: { type: 'local', path: path.join(curatedRoot, name) },
              installed: false,
              installedAt: null,
              enabled: false,
              installPolicy: 'AVAILABLE',
              installPolicySource: null,
              mustShowInstallationInterstitial: null,
              authPolicy: 'ON_INSTALL',
              availability: 'AVAILABLE',
              disabledReason: null,
              eligiblePlanTypes: null,
              interface: null,
              keywords: [],
            })),
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      });
      // Non-empty, so the empty-marketplace guard passes it and only the
      // curated completeness check can refuse a listing that omits a plugin.
      const partial = curatedListing(
        variant === 'dropped-facet' ? ['p'] : ['r'],
      );
      let warming = false;
      let warmed = false;
      listCodexThroughEvidence(async () => {
        if (variant !== 'cached') return partial;
        if (warming) return curatedListing(names);
        // Warm once: a refresh scan that misses the memo then reads the
        // partial listing instead of re-warming in a retry loop.
        if (warmed) return partial;
        // A concurrent reader, outside the refresh's evidence, scans a complete
        // listing in this generation; its memo must not vouch for the refresh.
        warmed = true;
        warming = true;
        try {
          await pluginCopyProviderEvidence.exit(scanManagedMarketplacesFresh);
        } finally {
          warming = false;
        }
        return partial;
      });
      try {
        const result = await refreshMarketplaces();
        expect(result).toMatchObject({ success: true });
        const row = result.data?.marketplaces
          .flatMap((marketplace) => marketplace.plugins)
          .find((plugin) => plugin.curated && plugin.name === 'p');
        // Only a listed summary sets `enabled`: in the cached variant it proves
        // the refresh scan reused the warmed row, not the partial listing.
        expect(row?.globalInstallStatus?.codex).toEqual(
          variant === 'scanned'
            ? {
                available: true,
                installed: false,
                version: '',
                error: 'Incomplete curated Codex plugin listing.',
              }
            : {
                available: true,
                installed: false,
                enabled: false,
                version: '',
              },
        );
        expect(fs.existsSync(unused)).toBe(true);
        codexPluginListRequest.mockReset();
        // Listing every manifest-named plugin lets the sweep reclaim.
        listCodexThroughEvidence(curatedListing(names));
        resetBuiltInMarketplaceScanCacheForTests();
        await refreshed();
        expect(fs.existsSync(unused)).toBe(false);
      } finally {
        resetBuiltInMarketplaceScanCacheForTests();
      }
    },
  );

  test.each([
    {
      damage: 'missing',
      resolver: 'facet',
      scenario: 'allowed',
    },
    {
      damage: 'missing',
      resolver: 'facet',
      scenario: 'now-private',
    },
    {
      damage: 'missing',
      resolver: 'facet',
      scenario: 'trusted-ssh',
    },
    {
      damage: 'missing',
      resolver: 'facet',
      scenario: 'trusted-private',
    },
    {
      damage: 'incomplete',
      resolver: 'no-facet',
      scenario: 'allowed',
    },
    {
      damage: 'incomplete',
      resolver: 'no-facet',
      scenario: 'now-private',
    },
    {
      damage: 'incomplete',
      resolver: 'no-facet',
      scenario: 'trusted-ssh',
    },
    {
      damage: 'incomplete',
      resolver: 'no-facet',
      scenario: 'trusted-private',
    },
  ])(
    'metadata-only automatic repair: $damage $resolver $scenario keeps installation policy after recovery',
    async ({ damage, resolver, scenario }) => {
      write(baseCatalog());
      const trusted = scenario.startsWith('trusted');
      const source =
        scenario === 'trusted-ssh'
          ? 'git@github.com:owner/p.git'
          : 'https://github.com/owner/p';
      marketplaceFixture(source);
      cloneFixture('installed-name');
      lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
      const installed = await installPluginForPrincipal(
        {
          remote: !trusted,
          marketplaceId: 'm',
          pluginName: 'p',
          sourceUrl: source,
        },
        (id, name, url, options) =>
          installPlugin(id, name, url, { ...options, skipRefresh: true }),
        // The marketplace fixture records `source` for this plugin.
        () => Promise.resolve(source),
      );
      expect(installed.success).toBe(true);
      if (!installed.data?.cachePath) throw new Error('expected copy');
      if (damage === 'missing')
        fs.rmSync(installed.data.cachePath, { recursive: true });
      else
        fs.writeFileSync(
          path.join(installed.data.cachePath, '.git', 'HEAD'),
          'b'.repeat(40),
        );
      await refreshed();
      write({ version: 1, entries: { bad: { cachePath: 7 } } }, indexPath);
      // A row without a readable copy is named by its marketplace entry.
      const rowName = damage === 'missing' ? 'p' : 'installed-name';
      for (let scan = 0; scan < 2; scan++) {
        await refreshed();
        const current = catalog()
          .marketplaces.find((row) => row.id === 'm')
          ?.plugins.find((row) => row.name === rowName);
        expect(current).toBeDefined();
        expect(current?.provenance).toMatchObject({
          sourceUrl: source,
          installedName: 'installed-name',
          marketplaceEntryName: 'p',
        });
        expect(current?.provenance?.remoteSourceRestricted).toBe(
          trusted ? undefined : true,
        );
        expect(current?.facets.claude?.provenance).toEqual(current?.provenance);
        // Refresh drops only a missing copy; resolution verifies an existing one.
        const kept =
          damage === 'incomplete' ? installed.data.cachePath : undefined;
        expect(current?.cachePath).toBe(kept);
        expect(current?.details === undefined).toBe(kept === undefined);
        expect(current?.facets.claude?.installLocation).toBe(kept ?? '');
        expect(current?.facets.claude?.sourcePath).toBe(kept ?? '');
        expect(current?.facets.claude?.cachePath).toBe(kept);
        expect(current?.facets.claude?.details === undefined).toBe(
          kept === undefined,
        );
      }
      const marketplace = catalog().marketplaces.find((row) => row.id === 'm');
      const row = marketplace?.plugins.find(
        (plugin) => plugin.name === rowName,
      );
      if (!marketplace || !row) throw new Error('expected installed metadata');
      jest.mocked(cloneRepo).mockClear();
      lookupMock.mockClear();
      if (scenario === 'now-private' || scenario === 'trusted-private')
        lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      const warnings: string[] = [];
      const repaired = await resolvePluginInfoPath(
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        marketplace,
        warnings,
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      await settleDetachedWork();
      if (scenario === 'now-private') {
        expect(repaired).toBeNull();
        expect(cloneRepo).not.toHaveBeenCalled();
        expect(warnings.length).toBeGreaterThan(0);
      } else {
        expect(repaired).not.toBeNull();
        expect(repaired).not.toBe(installed.data.cachePath);
        expect(cloneRepo).toHaveBeenCalledTimes(1);
        expect(cloneRepo).toHaveBeenCalledWith(source, expect.any(String), {
          followRedirects: trusted,
        });
        expect(index().entries['m/p'].cachePath).toBe(repaired);
        expect(index().entries['m/p'].provenance?.remoteSourceRestricted).toBe(
          trusted ? undefined : true,
        );
      }
      if (trusted) expect(lookupMock).not.toHaveBeenCalled();
      else expect(lookupMock).toHaveBeenCalled();
    },
  );

  test.each([
    {
      scan: 'standalone',
      identity: 'exact',
    },
    {
      scan: 'standalone',
      identity: 'ambiguous',
    },
    {
      scan: 'refresh',
      identity: 'alias',
    },
    {
      scan: 'refresh',
      identity: 'ambiguous',
    },
  ])(
    'curated metadata-only identity: $scan $identity uses the current managed manifest',
    async ({ scan, identity }) => {
      const source = 'https://github.com/owner/p';
      const curatedRoot = path.join(root, 'curated-plugins', 'marketplace');
      fs.mkdirSync(path.join(curatedRoot, '.claude-plugin'), {
        recursive: true,
      });
      write(
        {
          name: 'curated',
          plugins: [
            {
              name: 'p',
              source: {
                source: 'github',
                url:
                  identity === 'alias' ? 'git@github.com:owner/p.git' : source,
              },
            },
            ...(identity === 'ambiguous'
              ? [
                  {
                    name: 'neighbor',
                    source: { source: 'github', url: source },
                  },
                ]
              : []),
          ],
        },
        path.join(curatedRoot, '.claude-plugin', 'marketplace.json'),
      );
      const previous = baseCatalog();
      const marketplace = previous.marketplaces[0];
      marketplace.id = CURATED_PLUGIN_MARKETPLACE_ID;
      marketplace.sourceType = 'curated';
      marketplace.installLocation = curatedRoot;
      const row = marketplace.plugins[0];
      row.marketplaceId = marketplace.id;
      row.name = 'installed-name';
      row.sourcePath = '';
      delete row.details;
      row.provenance = {
        sourceUrl: source,
        installedAt: '',
        installedName: 'installed-name',
        remoteSourceRestricted: true,
      };
      row.facets.claude = {
        provider: 'claude',
        mode: 'native',
        name: 'installed-name',
        sourcePath: '',
        installLocation: '',
        externalSource: { source: 'github', url: source },
        provenance: row.provenance,
      };
      write(previous);
      write({ version: 1, entries: {} }, indexPath);
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
      try {
        const marketplaces =
          scan === 'standalone'
            ? await scanManagedMarketplacesFresh()
            : (await refreshMarketplaces()).data?.marketplaces;
        const current = marketplaces?.find(
          (market) => market.id === marketplace.id,
        );
        expect(current).toBeDefined();
        if (!current) throw new Error('expected curated marketplace');
        if (identity === 'ambiguous') {
          expect(current.plugins.map((plugin) => plugin.name).sort()).toEqual([
            'neighbor',
            'p',
          ]);
          expect(
            current.plugins.every((plugin) => plugin.provenance === undefined),
          ).toBe(true);
        } else {
          expect(current.plugins).toHaveLength(1);
          const installed = current.plugins[0];
          // A row without bytes keeps its entry name; provenance keeps the alias.
          expect(installed.name).toBe('p');
          expect(installed.provenance).toEqual({
            ...row.provenance,
            marketplaceEntryName: 'p',
          });
          // Historical remote provenance has not proved lossless clone identity.
          expect(installed.sourceChanged).toBe(true);
          expect(installed.cachePath).toBeUndefined();
          expect(installed.details).toBeUndefined();
          expect(installed.facets.claude?.sourcePath).toBe('');
          expect(installed.facets.claude?.installLocation).toBe('');
        }
        expect(index().entries).toEqual({});
        expect(cloneRepo).not.toHaveBeenCalled();
      } finally {
        resetBuiltInMarketplaceScanCacheForTests();
      }
    },
  );

  test.each(['absent'])(
    'metadata-only refresh: %s index preserves unique installation history without paths',
    async (state) => {
      write(baseCatalog());
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source, 'github');
      cloneFixture('installed-name');
      const result = await installPlugin('m', 'p', source, {
        skipRefresh: true,
        disableRedirects: true,
      });
      expect(result.success).toBe(true);
      const copy = result.data?.cachePath;
      if (!copy) throw new Error('expected copy');
      if (state === 'absent') fs.unlinkSync(indexPath);
      else write({ version: 1, entries: {} }, indexPath);
      marketplaceFixture('owner/new', 'github');
      for (let scan = 0; scan < 2; scan++) {
        await refreshed();
        const row = catalog()
          .marketplaces.find((market) => market.id === 'm')
          ?.plugins.find((plugin) => plugin.name === 'p');
        expect(row).toBeDefined();
        expect(row?.provenance).toMatchObject({
          sourceUrl: source,
          installedName: 'installed-name',
          marketplaceEntryName: 'p',
          remoteSourceRestricted: true,
        });
        expect(row?.sourceChanged).toBe(true);
        expect(row?.cachePath).toBeUndefined();
        expect(row?.details).toBeUndefined();
        expect(row?.facets.claude?.sourcePath).toBe('');
      }
      expect(fs.existsSync(copy)).toBe(true);
    },
  );

  test.each([
    {
      resolver: 'facet',
      snapshot: 'bound',
    },
    {
      resolver: 'no-facet',
      snapshot: 'refreshed-damage',
    },
  ])(
    'shorthand automatic repair: $resolver $snapshot uses exact source before GitHub aliases',
    async ({ resolver, snapshot }) => {
      write(baseCatalog());
      marketplaceFixture('owner/p', 'github');
      cloneFixture();
      const copy = await install();
      await refreshed();
      expect(catalog().marketplaces[0].plugins[0].sourceChanged).toBe(false);
      fs.writeFileSync(path.join(copy, '.git', 'HEAD'), 'b'.repeat(40));
      if (snapshot === 'refreshed-damage') await refreshed();
      const marketplace = catalog().marketplaces[0];
      const row = marketplace.plugins[0];
      expect(row.sourceChanged).toBe(false);
      jest.mocked(cloneRepo).mockClear();
      const warnings: string[] = [];
      const resolved = await resolvePluginInfoPath(
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        marketplace,
        warnings,
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      await settleDetachedWork();
      expect(resolved).not.toBeNull();
      expect(resolved).not.toBe(copy);
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(warnings).toEqual([]);
    },
  );

  test.each(['recorded', 'exact', 'ambiguous'])(
    'metadata-only entry identity: %s history never marks a neighboring entry',
    async (identity) => {
      write(baseCatalog());
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source, 'github');
      cloneFixture('installed-name');
      expect(
        (
          await installPlugin('m', 'p', source, {
            skipRefresh: true,
            disableRedirects: true,
          })
        ).success,
      ).toBe(true);
      const previous = catalog();
      const installed = previous.marketplaces[0].plugins[0];
      if (identity !== 'recorded') {
        if (installed.provenance)
          delete installed.provenance.marketplaceEntryName;
        if (installed.facets.claude?.provenance)
          delete installed.facets.claude.provenance.marketplaceEntryName;
      }
      if (identity === 'duplicate-records') {
        const duplicate = structuredClone(installed);
        duplicate.name = 'another-installed-name';
        previous.marketplaces[0].plugins.push(duplicate);
      }
      write(previous);
      write({ version: 1, entries: {} }, indexPath);
      write(
        {
          name: 'm',
          plugins: [
            {
              name: 'p',
              source: {
                source: 'github',
                url:
                  identity === 'alias' ? 'git@github.com:owner/p.git' : source,
              },
            },
            {
              name: 'neighbor',
              source: {
                source: 'github',
                url:
                  identity === 'ambiguous' || identity === 'recorded'
                    ? source
                    : identity === 'exact'
                      ? 'git@github.com:owner/p.git'
                      : 'owner/neighbor',
              },
            },
          ],
        },
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      await refreshed();
      const plugins = catalog().marketplaces[0].plugins;
      const recovered = plugins.filter(
        (row) => row.provenance?.remoteSourceRestricted,
      );
      if (identity === 'ambiguous' || identity === 'duplicate-records') {
        expect(recovered).toEqual([]);
        expect(plugins.map((row) => row.name).sort()).toEqual([
          'neighbor',
          'p',
        ]);
      } else {
        expect(recovered).toHaveLength(1);
        expect(recovered[0]).toMatchObject({
          name: 'p',
          provenance: {
            marketplaceEntryName: 'p',
            installedName: 'installed-name',
            sourceUrl: source,
          },
        });
        expect(recovered[0].cachePath).toBeUndefined();
        const neighbor = plugins.find((row) => row.name === 'neighbor');
        expect(neighbor).toBeDefined();
        expect(neighbor?.provenance).toBeUndefined();
      }
    },
  );

  test('metadata-only refresh: an installed alias naming another entry keeps both rows', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    cloneFixture('q');
    await install();
    fs.unlinkSync(indexPath);
    write(
      {
        name: 'm',
        plugins: [
          { name: 'p', source: { source: 'url', url: 'owner/p' } },
          { name: 'q', source: { source: 'url', url: 'owner/q' } },
        ],
      },
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    );
    for (let refresh = 0; refresh < 2; refresh++) {
      await refreshed();
      const rows = catalog().marketplaces[0].plugins;
      expect(rows.map((row) => row.name).sort()).toEqual(['p', 'q']);
      const installed = rows.find((row) => row.name === 'p');
      expect(installed?.externalSource?.url).toBe('owner/p');
      expect(installed?.provenance).toMatchObject({
        installedName: 'q',
        marketplaceEntryName: 'p',
      });
      const neighbor = rows.find((row) => row.name === 'q');
      expect(neighbor?.externalSource?.url).toBe('owner/q');
      expect(neighbor?.provenance).toBeUndefined();
    }
  });

  test.each([
    {
      resolver: 'facet',
      sameSource: true,
    },
    {
      resolver: 'no-facet',
      sameSource: false,
    },
  ])(
    'effective installed source: $resolver sameSource=$sameSource uses provenance, not the operational URL',
    async ({ resolver, sameSource }) => {
      write(baseCatalog());
      marketplaceFixture('https://github.com/owner/old');
      cloneFixture();
      const copy = await install('https://github.com/owner/old');
      marketplaceFixture('https://github.com/owner/new');
      const changed = index();
      const binding = changed.entries['m/p'];
      if (!binding.provenance) throw new Error('expected provenance');
      binding.sourceUrl = sameSource
        ? 'https://github.com/owner/old'
        : 'https://github.com/owner/new';
      binding.provenance.sourceUrl = sameSource
        ? 'https://github.com/owner/new'
        : 'https://github.com/owner/old';
      write(changed, indexPath);
      fs.writeFileSync(path.join(copy, '.git', 'HEAD'), 'b'.repeat(40));
      await refreshed();
      const marketplace = catalog().marketplaces[0];
      const row = marketplace.plugins[0];
      expect(row).toMatchObject({
        sourceChanged: !sameSource,
        provenance: { sourceUrl: binding.provenance.sourceUrl },
      });
      // Refresh keeps the damaged copy's path either way; resolution decides.
      expect(row.cachePath).toBe(copy);
      jest.mocked(cloneRepo).mockClear();
      const warnings: string[] = [];
      const resolved = await resolvePluginInfoPath(
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        marketplace,
        warnings,
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      if (sameSource) {
        expect(resolved).not.toBeNull();
        expect(resolved).not.toBe(copy);
        expect(cloneRepo).toHaveBeenCalledTimes(1);
        expect(warnings).toEqual([]);
      } else {
        expect(resolved).toBe(copy);
        expect(cloneRepo).not.toHaveBeenCalled();
        expect(warnings.length).toBeGreaterThan(0);
      }
    },
  );

  test.each([true, false])(
    'index-first policy: restricted=%s reinstall survives failed catalog publication',
    async (restricted) => {
      write(baseCatalog());
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      cloneFixture('old-installed-name');
      expect(
        (
          await installPlugin('m', 'p', source, {
            skipRefresh: true,
            disableRedirects: !restricted,
          })
        ).success,
      ).toBe(true);
      expect(
        catalog().marketplaces[0].plugins[0].provenance?.remoteSourceRestricted,
      ).toBe(restricted ? undefined : true);
      const realWrite = atomicFile.writeFileAtomically;
      const failedWrite = jest
        .spyOn(atomicFile, 'writeFileAtomically')
        .mockImplementation((target, data, options) =>
          target === catalogPath
            ? Promise.reject(new Error('catalog install failed'))
            : realWrite(target, data, options),
        );
      cloneFixture('new-installed-name');
      const result = await installPlugin('m', 'p', source, {
        skipRefresh: true,
        disableRedirects: restricted,
      });
      expect(result.success).toBe(false);
      failedWrite.mockRestore();
      expect(catalog().marketplaces[0].plugins[0]).toMatchObject({
        name: 'old-installed-name',
      });
      expect(
        catalog().marketplaces[0].plugins[0].provenance?.remoteSourceRestricted,
      ).toBe(restricted ? undefined : true);
      const selected = index().entries['m/p'];
      expect(selected.provenance?.remoteSourceRestricted).toBe(
        restricted ? true : undefined,
      );
      await refreshed();
      const row = catalog().marketplaces[0].plugins[0];
      expect(row.name).toBe('new-installed-name');
      expect(row.cachePath).toBe(selected.cachePath);
      expect(row.provenance).toEqual(selected.provenance);
      expect(row.facets.claude?.provenance).toEqual(selected.provenance);
    },
  );

  test.each([
    {
      resolver: 'facet',
      identity: 'ambiguous',
    },
    {
      resolver: 'no-facet',
      identity: 'unmatched',
    },
    {
      resolver: 'facet',
      identity: 'ambiguous',
      indexRestricted: true,
    },
    {
      resolver: 'no-facet',
      identity: 'unmatched',
      indexRestricted: true,
    },
    {
      resolver: 'no-facet',
      identity: 'unmatched',
      indexRestricted: true,
      nowPrivate: true,
    },
  ])(
    'automatic repair identity: $resolver $identity legacy owner reinstalls from the advertised source (restricted index copy: $indexRestricted, now private: $nowPrivate)',
    async ({
      resolver,
      identity,
      indexRestricted = false,
      nowPrivate = false,
    }) => {
      write(baseCatalog());
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      cloneFixture('installed-name');
      lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
      const copy = await install(source);
      const legacy = catalog();
      forgetIdentity(legacy);
      write(legacy);
      if (indexRestricted) {
        // Only the index binding of the row's copy records the restriction.
        const current = index();
        const binding = current.entries['m/p'];
        expect(binding.cachePath).toBe(copy);
        write(
          {
            ...current,
            entries: {
              ...current.entries,
              'm/p': {
                ...binding,
                provenance: {
                  ...binding.provenance,
                  remoteSourceRestricted: true,
                },
              },
            },
          },
          indexPath,
        );
      }
      fs.rmSync(copy, { recursive: true });
      write(
        {
          name: 'm',
          plugins: ['p', 'q'].map((name) => ({
            name,
            source: {
              source: 'url',
              url: identity === 'ambiguous' ? source : `${source}-${name}`,
            },
          })),
        },
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      const marketplace = legacy.marketplaces[0];
      const row = marketplace.plugins[0];
      jest.mocked(cloneRepo).mockClear();
      lookupMock.mockClear();
      if (nowPrivate)
        lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      const indexBefore = index();
      const warnings: string[] = [];
      const resolved = await resolvePluginInfoPath(
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        marketplace,
        warnings,
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      await settleDetachedWork();
      if (nowPrivate) {
        // A refusal fails this repair only, as a fresh session's check does.
        expect(resolved).toBeNull();
        expect(cloneRepo).not.toHaveBeenCalled();
        expect(warnings).toContainEqual(
          expect.stringContaining('resolves to a non-public address'),
        );
        expect(index()).toEqual(indexBefore);
        return;
      }
      expect(resolved).not.toBeNull();
      expect(resolved).not.toBe(copy);
      if (!resolved) throw new Error('expected reinstalled copy');
      expect(
        fs.readFileSync(
          path.join(resolved, '.claude-plugin', 'plugin.json'),
          'utf8',
        ),
      ).toBe(JSON.stringify({ name: 'installed-name' }));
      expect(cloneRepo).toHaveBeenCalledWith(source, resolved, {
        followRedirects: !indexRestricted,
      });
      expect(lookupMock).toHaveBeenCalledTimes(indexRestricted ? 1 : 0);
      expect(
        Object.values(index().entries).find(
          (binding) => binding.cachePath === resolved,
        )?.provenance?.remoteSourceRestricted,
      ).toBe(indexRestricted ? true : undefined);
    },
  );

  test.each(['facet', 'no-facet'])(
    'automatic repair identity: %s unproven selection keeps base repair after an installed-name change',
    async (resolver) => {
      write(baseCatalog());
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      cloneFixture('installed-name');
      const copy = await install(source);
      const legacy = catalog();
      forgetIdentity(legacy);
      const marketplace = legacy.marketplaces[0];
      const row = marketplace.plugins[0];
      row.provenance = {
        sourceUrl: source,
        installedAt: '',
        remoteSourceRestricted: true,
      };
      if (!row.facets.claude) throw new Error('expected Claude facet');
      row.facets.claude.provenance = { ...row.provenance };
      write(legacy);
      fs.rmSync(copy, { recursive: true });
      write(
        {
          name: 'm',
          plugins: ['p', 'q'].map((name) => ({
            name,
            source: { source: 'url', url: source },
          })),
        },
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      let validationStarted = (): void => {};
      const validating = new Promise<void>((resolve) => {
        validationStarted = resolve;
      });
      let releaseValidation = (): void => {};
      const validationGate = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
      lookupMock.mockImplementationOnce(async () => {
        validationStarted();
        await validationGate;
        return [{ address: '140.82.112.3', family: 4 }];
      });
      const repair = resolvePluginInfoPath(
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        marketplace,
        [],
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      try {
        expect(
          await Promise.race([
            validating.then(() => 'validating'),
            repair.then(() => 'finished'),
          ]),
        ).toBe('validating');
        cloneFixture('renamed');
        const updated = await installPlugin('m', row.name, source, {
          skipRefresh: true,
          disableRedirects: true,
        });
        expect(updated.success).toBe(true);
        expect(updated.data?.name).toBe('renamed');
        cloneFixture('repaired-name');
        jest.mocked(cloneRepo).mockClear();
        lookupMock.mockClear();
        releaseValidation();
        const repaired = await repair;
        // The clone URL is checked again once the repair holds its slot.
        expect(lookupMock).toHaveBeenCalled();
        expect(repaired).not.toBeNull();
        expect(repaired).not.toBe(updated.data?.cachePath);
        if (!repaired) throw new Error('expected reinstalled copy');
        expect(
          fs.readFileSync(
            path.join(repaired, '.claude-plugin', 'plugin.json'),
            'utf8',
          ),
        ).toBe(JSON.stringify({ name: 'repaired-name' }));
        expect(cloneRepo).toHaveBeenCalledTimes(1);
        expect(cloneRepo).toHaveBeenCalledWith(source, repaired, {
          followRedirects: false,
        });
      } finally {
        releaseValidation();
        await repair;
      }
    },
  );

  test.each(['facet', 'no-facet'])(
    'automatic repair identity: %s legacy source keeps its inferred entry through publication',
    async (resolver) => {
      write(baseCatalog());
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      cloneFixture('installed-name');
      const copy = await install(source);
      const legacy = catalog();
      const marketplace = legacy.marketplaces[0];
      const row = marketplace.plugins[0];
      forgetIdentity(legacy);
      if (resolver === 'no-facet') row.facets = {};
      write(legacy);
      fs.rmSync(copy, { recursive: true });
      const repaired = await resolvePluginInfoPath(
        row,
        marketplace,
        [],
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      expect(repaired).not.toBeNull();
      expect(repaired).not.toBe(copy);
      await settleDetachedWork();
      expect(index().entries['m/p'].cachePath).toBe(repaired);
      expect(index().entries['m/installed-name']).toBeUndefined();
      expect(catalog().marketplaces[0].plugins[0]).toMatchObject({
        cachePath: repaired,
        provenance: { marketplaceEntryName: 'p' },
      });
    },
  );

  /** Resolves as a session that read its generation before later user changes. */
  async function resolveAtGeneration(
    generation: number,
    ...args: Parameters<typeof resolvePluginInfoPath>
  ): Promise<string | null> {
    const stale = jest
      .spyOn(pluginService, 'getPluginUserMutationGeneration')
      .mockReturnValueOnce(generation);
    try {
      return await resolvePluginInfoPath(...args);
    } finally {
      stale.mockRestore();
    }
  }

  test.each([
    { resolver: 'facet', failCatalogWrite: false },
    { resolver: 'no-facet', failCatalogWrite: true },
  ])(
    'automatic repair identity: $resolver legacy snapshot yields to a later restricted reinstall (failCatalogWrite=$failCatalogWrite)',
    async ({ resolver, failCatalogWrite }) => {
      write(baseCatalog());
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      cloneFixture('installed-name');
      lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
      const copy = await install(source);
      const legacy = catalog();
      forgetIdentity(legacy);
      write(legacy);
      const legacyIndex = index();
      delete legacyIndex.entries['m/p'].provenance;
      write(legacyIndex, indexPath);
      fs.rmSync(copy, { recursive: true });
      const generation = pluginService.getPluginUserMutationGeneration();
      const stale = catalog().marketplaces[0];
      const row = stale.plugins[0];
      const realWrite = atomicFile.writeFileAtomically;
      const failCatalog = failCatalogWrite
        ? jest
            .spyOn(atomicFile, 'writeFileAtomically')
            .mockImplementation((target, data, options) =>
              target === catalogPath
                ? Promise.reject(new Error('catalog install failed'))
                : realWrite(target, data, options),
            )
        : undefined;
      const user = await installPlugin('m', row.name, source, {
        skipRefresh: true,
        disableRedirects: true,
      });
      failCatalog?.mockRestore();
      expect(user.success).toBe(!failCatalogWrite);
      // Without a recorded entry name, the reinstall binds the row's literal key.
      const userBinding = index().entries['m/installed-name'];
      expect(userBinding.provenance?.remoteSourceRestricted).toBe(true);
      const userIndex = fs.readFileSync(indexPath, 'utf8');
      jest.mocked(cloneRepo).mockClear();
      const repaired = await resolveAtGeneration(
        generation,
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        stale,
        [],
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      await settleDetachedWork();
      expect(cloneRepo).not.toHaveBeenCalled();
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(userIndex);
      // The repair's inferred entry finds the copy the reinstall bound by name.
      expect(repaired).toBe(userBinding.cachePath);
    },
  );

  test.each([false, true])(
    'automatic repair identity: a literal-key legacy snapshot re-clones a later restricted reinstall whose copy fails verification (failCatalogWrite=%s)',
    async (failCatalogWrite) => {
      write(baseCatalog());
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      cloneFixture('installed-name');
      lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
      const copy = await install(source);
      const legacy = catalog();
      forgetIdentity(legacy);
      write(legacy);
      // A pre-provenance installation bound only its literal key, so the
      // snapshot's inferred entry has no slot of its own.
      const legacyIndex = index();
      const literal = legacyIndex.entries['m/p'];
      delete literal.provenance;
      delete legacyIndex.entries['m/p'];
      legacyIndex.entries['m/installed-name'] = literal;
      write(legacyIndex, indexPath);
      fs.rmSync(copy, { recursive: true });
      const generation = pluginService.getPluginUserMutationGeneration();
      const stale = catalog().marketplaces[0];
      const realWrite = atomicFile.writeFileAtomically;
      const failCatalog = failCatalogWrite
        ? jest
            .spyOn(atomicFile, 'writeFileAtomically')
            .mockImplementation((target, data, options) =>
              target === catalogPath
                ? Promise.reject(new Error('catalog install failed'))
                : realWrite(target, data, options),
            )
        : undefined;
      const user = await installPlugin('m', 'installed-name', source, {
        skipRefresh: true,
        disableRedirects: true,
      });
      failCatalog?.mockRestore();
      expect(user.success).toBe(!failCatalogWrite);
      const userCopy = index().entries['m/installed-name'].cachePath;
      expect(index().entries['m/p']).toBeUndefined();
      fs.rmSync(path.join(userCopy, '.git', 'HEAD'));
      jest.mocked(cloneRepo).mockClear();
      const warnings: string[] = [];
      const repaired = await resolveAtGeneration(
        generation,
        stale.plugins[0],
        stale,
        warnings,
        true,
        'claude',
      );
      await settleDetachedWork();
      // Never skipped, as on develop; the user's restriction is kept.
      expect(warnings).toEqual([]);
      expect(repaired).not.toBeNull();
      expect(repaired).not.toBe(userCopy);
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(cloneRepo).toHaveBeenCalledWith(source, repaired, {
        followRedirects: false,
      });
      await refreshed();
      expect(catalog().marketplaces[0].plugins[0]).toMatchObject({
        cachePath: repaired,
        provenance: { remoteSourceRestricted: true },
      });
      expect(resolve('installed-name').sdkPlugins).toEqual([
        { type: 'local', path: repaired },
      ]);
    },
  );

  test('automatic repair identity: a legacy snapshot yields to a later uninstall', async () => {
    write(baseCatalog());
    const source = 'https://github.com/owner/p';
    marketplaceFixture(source);
    cloneFixture('installed-name');
    lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
    const copy = await install(source);
    const legacy = catalog();
    forgetIdentity(legacy);
    write(legacy);
    const legacyIndex = index();
    delete legacyIndex.entries['m/p'].provenance;
    write(legacyIndex, indexPath);
    fs.rmSync(copy, { recursive: true });
    const generation = pluginService.getPluginUserMutationGeneration();
    const stale = catalog().marketplaces[0];
    await removeInstalledPluginCache('m', stale.plugins[0].name);
    const uninstalledIndex = fs.readFileSync(indexPath, 'utf8');
    const uninstalledCatalog = fs.readFileSync(catalogPath, 'utf8');
    jest.mocked(cloneRepo).mockClear();
    // Without an installation time, only the entry's user-mutation generation
    // shows the uninstall happened after the snapshot.
    expect(
      await resolveAtGeneration(
        generation,
        stale.plugins[0],
        stale,
        [],
        true,
        'claude',
      ),
    ).toBeNull();
    await settleDetachedWork();
    expect(cloneRepo).not.toHaveBeenCalled();
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(uninstalledIndex);
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe(uninstalledCatalog);
  });

  test('automatic repair identity: a legacy row whose copy is still bound repairs its own entry, not a matched entry a user changed', async () => {
    write(baseCatalog());
    lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
    const source = 'https://github.com/owner/s';
    const installCopy = async (name: string): Promise<string> => {
      marketplaceFixture(source, 'url', 'm', name);
      cloneFixture(name);
      const result = await installPlugin('m', name, source, {
        skipRefresh: true,
      });
      if (!result.data?.cachePath) throw new Error('expected copy');
      return result.data.cachePath;
    };
    const mineCopy = await installCopy('mine');
    // The manifest now lists only `other`, so the legacy row's source infers it.
    await installCopy('other');
    const legacy = catalog();
    const mine = legacy.marketplaces[0].plugins.find(
      (plugin) => plugin.name === 'mine',
    );
    if (!mine?.facets.claude) throw new Error('expected legacy row');
    delete mine.provenance;
    delete mine.facets.claude.provenance;
    write(legacy);
    const legacyIndex = index();
    delete legacyIndex.entries['m/mine'].provenance;
    write(legacyIndex, indexPath);
    fs.rmSync(mineCopy, { recursive: true });
    const generation = pluginService.getPluginUserMutationGeneration();
    const stale = catalog().marketplaces[0];
    const row = stale.plugins.find((plugin) => plugin.name === 'mine');
    if (!row) throw new Error('expected mine');
    cloneFixture('other');
    const user = await installPlugin('m', 'other', source, {
      skipRefresh: true,
      disableRedirects: true,
    });
    expect(user.success).toBe(true);
    const otherBinding = index().entries['m/other'];
    cloneFixture('mine');
    jest.mocked(cloneRepo).mockClear();
    const repaired = await resolveAtGeneration(
      generation,
      row,
      stale,
      [],
      true,
      'claude',
    );
    await settleDetachedWork();
    expect(index().entries['m/other']).toEqual(otherBinding);
    expect(repaired).not.toBeNull();
    expect(repaired).not.toBe(mineCopy);
    expect(repaired).not.toBe(otherBinding.cachePath);
    expect(index().entries['m/mine'].cachePath).toBe(repaired);
    expect(cloneRepo).toHaveBeenCalledTimes(1);
  });

  test.each(['facet', 'no-facet'])(
    'automatic repair identity: %s re-added marketplace with a different source keeps its new binding',
    async (resolver) => {
      write(baseCatalog());
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      cloneFixture('installed-name');
      const installed = await installPlugin('m', 'p', source, {
        skipRefresh: true,
        disableRedirects: true,
      });
      if (!installed.success || !installed.data?.cachePath)
        throw new Error('expected copy');
      const selected = catalog().marketplaces[0];
      const row = selected.plugins[0];
      fs.rmSync(installed.data.cachePath, { recursive: true });
      let validationStarted = (): void => {};
      const validating = new Promise<void>((resolve) => {
        validationStarted = resolve;
      });
      let releaseValidation = (): void => {};
      const validationGate = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      lookupMock.mockImplementationOnce(async () => {
        validationStarted();
        await validationGate;
        return [{ address: '140.82.112.3', family: 4 }];
      });
      const repair = resolvePluginInfoPath(
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        selected,
        [],
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      try {
        expect(
          await Promise.race([
            validating.then(() => 'validating'),
            repair.then(() => 'finished'),
          ]),
        ).toBe('validating');
        const removed = await removeMarketplace('m', { providers: ['claude'] });
        expect(removed.data?.removedProviders).toContain('claude');
        expect(
          catalog().marketplaces.find((entry) => entry.id === 'm'),
        ).toBeUndefined();
        const newSource = 'https://github.com/owner/new';
        marketplaceFixture(newSource);
        expect((await addMarketplace('owner/m')).success).toBe(true);
        const replacement = await installPlugin('m', 'p', newSource, {
          skipRefresh: true,
        });
        expect(replacement.success).toBe(true);
        if (!replacement.data?.cachePath) throw new Error('expected new copy');
        expect(index().entries['m/p'].sourceUrl).toBe(newSource);
        expect(
          catalog().marketplaces.find((entry) => entry.id === 'm')?.plugins[0]
            .externalSource?.url,
        ).toBe(newSource);
        const beforeIndex = fs.readFileSync(indexPath, 'utf8');
        const beforeCatalog = fs.readFileSync(catalogPath, 'utf8');
        const manifestPath = path.join(
          replacement.data.cachePath,
          '.claude-plugin',
          'plugin.json',
        );
        const manifest = fs.readFileSync(manifestPath, 'utf8');
        jest.mocked(cloneRepo).mockClear();
        releaseValidation();
        expect(await repair).toBeNull();
        await settleDetachedWork();
        expect(cloneRepo).not.toHaveBeenCalled();
        expect(fs.readFileSync(indexPath, 'utf8')).toBe(beforeIndex);
        expect(fs.readFileSync(catalogPath, 'utf8')).toBe(beforeCatalog);
        expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifest);
      } finally {
        releaseValidation();
        await repair;
      }
    },
  );

  test.each([
    {
      resolver: 'facet',
      owner: 'reused',
    },
    {
      resolver: 'no-facet',
      owner: 'absent',
    },
  ])(
    'automatic repair identity: $resolver $owner installed name skips a stale selection',
    async ({ resolver, owner }) => {
      write(baseCatalog());
      const source = 'https://github.com/owner/p';
      marketplaceFixture(source);
      cloneFixture('installed-name');
      const installed = await installPlugin('m', 'p', source, {
        skipRefresh: true,
        disableRedirects: true,
      });
      if (!installed.success || !installed.data?.cachePath)
        throw new Error('expected copy');
      const selected = catalog().marketplaces[0];
      const row = selected.plugins[0];
      fs.writeFileSync(
        path.join(installed.data.cachePath, '.git', 'HEAD'),
        'b'.repeat(40),
      );
      let validationStarted = (): void => {};
      const validating = new Promise<void>((resolve) => {
        validationStarted = resolve;
      });
      let releaseValidation = (): void => {};
      const validationGate = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      lookupMock.mockImplementationOnce(async () => {
        validationStarted();
        await validationGate;
        return [{ address: '140.82.112.3', family: 4 }];
      });
      const repair = resolvePluginInfoPath(
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        selected,
        [],
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      await validating;
      try {
        // The original entry changes installed name while another may reuse it.
        cloneFixture('renamed');
        expect(
          (await installPlugin('m', 'p', source, { skipRefresh: true }))
            .success,
        ).toBe(true);
        if (owner === 'reused') {
          const otherSource = 'https://github.com/owner/q';
          marketplaceFixture(otherSource, 'url', 'm', 'q');
          cloneFixture('installed-name');
          expect(
            (
              await installPlugin('m', 'q', otherSource, {
                skipRefresh: true,
              })
            ).success,
          ).toBe(true);
        }
        const beforeIndex = fs.readFileSync(indexPath, 'utf8');
        const beforeCatalog = fs.readFileSync(catalogPath, 'utf8');
        const copies = Object.values(index().entries).map((entry) => ({
          path: entry.cachePath,
          manifest: fs.readFileSync(
            path.join(entry.cachePath, '.claude-plugin', 'plugin.json'),
            'utf8',
          ),
        }));
        jest.mocked(cloneRepo).mockClear();
        releaseValidation();
        expect(await repair).toBeNull();
        await settleDetachedWork();
        expect(cloneRepo).not.toHaveBeenCalled();
        expect(fs.readFileSync(indexPath, 'utf8')).toBe(beforeIndex);
        expect(fs.readFileSync(catalogPath, 'utf8')).toBe(beforeCatalog);
        for (const copy of copies)
          expect(
            fs.readFileSync(
              path.join(copy.path, '.claude-plugin', 'plugin.json'),
              'utf8',
            ),
          ).toBe(copy.manifest);
      } finally {
        releaseValidation();
        await repair;
      }
    },
  );

  test.each([
    {
      resolver: 'facet',
      scenario: 'allowed',
    },
    {
      resolver: 'facet',
      scenario: 'now-private',
    },
    {
      resolver: 'no-facet',
      scenario: 'trusted-ssh',
    },
    {
      resolver: 'no-facet',
      scenario: 'trusted-private',
    },
  ])(
    'restricted automatic repair: $resolver $scenario retains original clone policy',
    async ({ resolver, scenario }) => {
      write(baseCatalog());
      const trusted = scenario.startsWith('trusted');
      const source =
        scenario === 'trusted-ssh'
          ? 'git@github.com:owner/p.git'
          : 'https://github.com/owner/p';
      marketplaceFixture(source);
      cloneFixture();
      lookupMock.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
      const installed = await installPluginForPrincipal(
        {
          remote: !trusted,
          marketplaceId: 'm',
          pluginName: 'p',
          sourceUrl: source,
        },
        (id, name, url, options) =>
          installPlugin(id, name, url, { ...options, skipRefresh: true }),
        // The marketplace fixture records `source` for this plugin.
        () => Promise.resolve(source),
      );
      expect(installed.success).toBe(true);
      if (!installed.data?.cachePath) throw new Error('expected copy');
      // Repair must retain its policy through index recovery and catalog projection.
      write({ version: 1, entries: { bad: { cachePath: 7 } } }, indexPath);
      await refreshed();
      const cache = catalog();
      const marketplace = cache.marketplaces[0];
      const row = marketplace.plugins[0];
      fs.writeFileSync(
        path.join(installed.data.cachePath, '.git', 'HEAD'),
        'b'.repeat(40),
      );
      jest.mocked(cloneRepo).mockClear();
      lookupMock.mockClear();
      if (scenario === 'now-private' || scenario === 'trusted-private')
        lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      const warnings: string[] = [];
      const repaired = await resolvePluginInfoPath(
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        marketplace,
        warnings,
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      await settleDetachedWork();
      if (scenario === 'now-private') {
        expect(repaired).toBeNull();
        expect(cloneRepo).not.toHaveBeenCalled();
      } else {
        expect(repaired).not.toBeNull();
        expect(repaired).not.toBe(installed.data.cachePath);
        expect(cloneRepo).toHaveBeenCalledTimes(1);
        expect(cloneRepo).toHaveBeenCalledWith(source, repaired, {
          followRedirects: trusted,
        });
        if (trusted) expect(lookupMock).not.toHaveBeenCalled();
      }
      expect(installed.data.provenance?.remoteSourceRestricted).toBe(
        trusted ? undefined : true,
      );
    },
  );

  test.each([
    {
      resolver: 'facet',
      prefix: 'file:///',
      delimiter: '#',
    },
    {
      resolver: 'no-facet',
      prefix: '/',
      delimiter: '#',
    },
  ])(
    '$resolver Git local bound-copy repair preserves literal $delimiter in $prefix sources',
    async ({ resolver, prefix, delimiter }) => {
      write(baseCatalog());
      cloneFixture();
      const original = `${prefix}repos/plugins${delimiter}stable/tool`;
      const advertised = `${prefix}repos/plugins${delimiter}preview/tool`;
      marketplaceFixture(original);
      const copy = await install(original);
      marketplaceFixture(advertised);
      await refreshed();
      const current = catalog().marketplaces[0];
      const row = current.plugins[0];
      expect(row).toMatchObject({ cachePath: copy, sourceChanged: true });
      expect(row.provenance?.sourceUrl).toBe(original);
      expect(row.facets.claude?.provenance?.sourceUrl).toBe(original);
      expect(row.facets.claude?.sourceChanged).toBe(true);
      fs.writeFileSync(path.join(copy, '.git', 'HEAD'), 'b'.repeat(40));
      const beforeIndex = index();
      const beforeCatalog = catalog();
      jest.mocked(cloneRepo).mockClear();
      const warnings: string[] = [];
      expect(
        await resolvePluginInfoPath(
          resolver === 'no-facet' ? { ...row, facets: {} } : row,
          current,
          warnings,
          true,
          resolver === 'facet' ? 'claude' : undefined,
        ),
      ).toBe(copy);
      await settleDetachedWork();
      expect(cloneRepo).not.toHaveBeenCalled();
      expect(warnings.length).toBeGreaterThan(0);
      expect(index()).toEqual(beforeIndex);
      expect(catalog()).toEqual(beforeCatalog);
      const updated = await install(advertised);
      expect(updated).not.toBe(copy);
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(index().entries['m/p'].provenance?.sourceUrl).toBe(advertised);
    },
  );

  test('a qualified GitHub transport alias repairs the bound copy', async () => {
    write(baseCatalog());
    cloneFixture();
    const copy = await install('https://github.com/owner/p');
    marketplaceFixture('git@github.com:OWNER/p.git');
    await refreshed();
    const current = catalog().marketplaces[0];
    const row = current.plugins[0];
    expect(row).toMatchObject({ cachePath: copy, sourceChanged: false });
    fs.writeFileSync(path.join(copy, '.git', 'HEAD'), 'b'.repeat(40));
    jest.mocked(cloneRepo).mockClear();
    const resolved = await resolvePluginInfoPath(
      row,
      current,
      [],
      true,
      'claude',
    );
    await settleDetachedWork();
    expect(resolved).not.toBeNull();
    expect(resolved).not.toBe(copy);
    expect(cloneRepo).toHaveBeenCalledTimes(1);
    expect(index().entries['m/p'].cachePath).toBe(resolved);
  });

  test.each(['facet', 'no-facet'])(
    '%s bound-copy repair treats a GitHub SSH login case change as source drift',
    async (resolver) => {
      const original = 'ssh://git@github.com/owner/p.git';
      const advertised = 'ssh://GIT@github.com/owner/p.git';
      write(baseCatalog());
      cloneFixture();
      const copy = await install(original);
      marketplaceFixture(advertised);
      await refreshed();
      const current = catalog().marketplaces[0];
      const row = current.plugins[0];
      expect(row).toMatchObject({ cachePath: copy, sourceChanged: true });
      expect(row.facets.claude?.sourceChanged).toBe(true);
      fs.writeFileSync(path.join(copy, '.git', 'HEAD'), 'b'.repeat(40));
      const beforeIndex = index();
      const beforeCatalog = catalog();
      jest.mocked(cloneRepo).mockClear();
      const warnings: string[] = [];
      expect(
        await resolvePluginInfoPath(
          resolver === 'no-facet' ? { ...row, facets: {} } : row,
          current,
          warnings,
          true,
          resolver === 'facet' ? 'claude' : undefined,
        ),
      ).toBe(copy);
      expect(cloneRepo).not.toHaveBeenCalled();
      expect(warnings.length).toBeGreaterThan(0);
      expect(index()).toEqual(beforeIndex);
      expect(catalog()).toEqual(beforeCatalog);
      const updated = await install(advertised);
      expect(updated).not.toBe(copy);
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(index().entries['m/p'].provenance?.sourceUrl).toBe(advertised);
    },
  );

  test.each(
    ['facet', 'no-facet'].flatMap((resolver) =>
      [true, false].map((loginChanged) => ({ resolver, loginChanged })),
    ),
  )(
    '$resolver bound-copy repair of a complete SSH source (login changed: $loginChanged)',
    async ({ resolver, loginChanged }) => {
      write(baseCatalog());
      cloneFixture();
      const original = 'ssh://alice@private.example/owner/p';
      const advertised = loginChanged
        ? 'ssh://bob@private.example/owner/p'
        : original;
      const copy = await install(original);
      expect(index().entries['m/p'].provenance).toMatchObject({
        sourceUrl: original,
        sourceIdentityComplete: true,
      });
      marketplaceFixture(advertised);
      await refreshed();
      const current = catalog().marketplaces[0];
      const row = current.plugins[0];
      expect(row).toMatchObject({
        cachePath: copy,
        sourceChanged: loginChanged,
        provenance: { sourceUrl: original, sourceIdentityComplete: true },
      });
      fs.writeFileSync(path.join(copy, '.git', 'HEAD'), 'b'.repeat(40));
      const beforeIndex = index();
      const beforeCatalog = catalog();
      jest.mocked(cloneRepo).mockClear();
      const warnings: string[] = [];
      const resolved = await resolvePluginInfoPath(
        resolver === 'no-facet' ? { ...row, facets: {} } : row,
        current,
        warnings,
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      if (!loginChanged) {
        // The unchanged complete source repairs the damaged copy.
        expect(warnings).toEqual([]);
        expect(cloneRepo).toHaveBeenCalledTimes(1);
        expect(cloneRepo).toHaveBeenCalledWith(
          original,
          expect.any(String),
          expect.anything(),
        );
        expect(resolved).not.toBe(copy);
        expect(resolved).toBe(index().entries['m/p'].cachePath);
        return;
      }
      // Another SSH login can select another repository, so it is source drift.
      expect(resolved).toBe(copy);
      expect(warnings.length).toBeGreaterThan(0);
      expect(cloneRepo).not.toHaveBeenCalled();
      expect(index()).toEqual(beforeIndex);
      expect(catalog()).toEqual(beforeCatalog);
      const updated = await install(advertised);
      expect(updated).not.toBe(copy);
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(index().entries['m/p'].provenance?.sourceUrl).toBe(advertised);
    },
  );

  test.each(['facet', 'no-facet'])(
    '%s bound-copy repair keeps a copy whose SSH password was redacted',
    async (resolver) => {
      write(baseCatalog());
      cloneFixture();
      const original = 'ssh://alice:old-secret@private.example/owner/p';
      const copy = await install(original);
      expect(index().entries['m/p'].provenance).toMatchObject({
        sourceUrl: 'ssh://alice@private.example/owner/p',
        sourceIdentityComplete: false,
      });
      expect(JSON.stringify(index().entries['m/p'].provenance)).not.toContain(
        'old-secret',
      );
      // Even the unchanged source can't be confirmed from redacted provenance.
      marketplaceFixture(original);
      await refreshed();
      const current = catalog().marketplaces[0];
      const row = current.plugins[0];
      expect(row).toMatchObject({
        cachePath: copy,
        sourceChanged: true,
        provenance: { sourceUrl: 'ssh://alice@private.example/owner/p' },
      });
      expect(row.facets.claude?.sourceChanged).toBe(true);
      expect(JSON.stringify(row.provenance)).not.toContain('old-secret');
      fs.writeFileSync(path.join(copy, '.git', 'HEAD'), 'b'.repeat(40));
      const beforeIndex = index();
      const beforeCatalog = catalog();
      jest.mocked(cloneRepo).mockClear();
      const warnings: string[] = [];
      expect(
        await resolvePluginInfoPath(
          resolver === 'no-facet' ? { ...row, facets: {} } : row,
          current,
          warnings,
          true,
          resolver === 'facet' ? 'claude' : undefined,
        ),
      ).toBe(copy);
      expect(warnings.length).toBeGreaterThan(0);
      expect(cloneRepo).not.toHaveBeenCalled();
      expect(index()).toEqual(beforeIndex);
      expect(catalog()).toEqual(beforeCatalog);
      const updated = await install(
        'ssh://bob:new-secret@private.example/owner/p',
      );
      expect(updated).not.toBe(copy);
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(index().entries['m/p'].provenance?.sourceUrl).toBe(
        'ssh://bob@private.example/owner/p',
      );
    },
  );

  test.each(
    ['facet', 'no-facet'].flatMap((resolver) =>
      ['missing', 'manifest', 'head'].flatMap((damage) =>
        [true, false].map((sourceChanged) => ({
          resolver,
          damage,
          sourceChanged,
        })),
      ),
    ),
  )(
    '$resolver bound-copy resolution: $damage with sourceChanged=$sourceChanged',
    async ({ resolver, damage, sourceChanged }) => {
      write(baseCatalog());
      cloneFixture('installed-name');
      const original = 'https://github.com/owner/p';
      const advertised = sourceChanged
        ? 'https://github.com/other/p'
        : 'https://github.com/owner/p.git';
      const clone = jest.mocked(cloneRepo).getMockImplementation();
      if (!clone) throw new Error('expected clone fixture');
      jest.mocked(cloneRepo).mockImplementation(async (url, dir, options) => {
        if (url !== original && url !== advertised)
          throw new Error('authenticated URL required');
        await clone(url, dir, options);
        fs.writeFileSync(path.join(dir, 'payload'), url);
      });
      const copy = await install(original);
      expect(index().entries['m/p'].sourceUrl).toBe(original);
      const provenance = catalog().marketplaces[0].plugins[0].provenance;
      expect(provenance).toMatchObject({
        sourceUrl: 'https://github.com/owner/p',
        commit: head,
        marketplaceEntryName: 'p',
        installedName: 'installed-name',
        reinstalled: false,
      });
      expect(typeof provenance?.installedAt).toBe('string');
      marketplaceFixture(original, 'github');
      await refreshed();
      expect(catalog().marketplaces[0].plugins[0].sourceChanged).toBe(false);
      marketplaceFixture(advertised);
      await refreshed();
      const installedMarketplace = catalog().marketplaces[0];
      expect(installedMarketplace.plugins[0]).toMatchObject({
        name: 'installed-name',
        cachePath: copy,
        sourceChanged,
      });
      expect(installedMarketplace.plugins[0].externalSource?.sha).toBe(
        'requested-not-cloned',
      );
      expect(resolve('installed-name').sdkPlugins).toEqual([
        { type: 'local', path: copy },
      ]);
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      const installedIndex = index();
      if (damage === 'missing') fs.rmSync(copy, { recursive: true });
      else if (damage === 'manifest')
        fs.unlinkSync(path.join(copy, '.claude-plugin', 'plugin.json'));
      else fs.writeFileSync(path.join(copy, '.git', 'HEAD'), 'b'.repeat(40));
      expect(resolve('installed-name').sdkPlugins).toEqual([]);
      await refreshed();
      const current = catalog().marketplaces[0];
      // Refresh keeps an existing copy's path; resolution decides whether it
      // is kept (drift) or repaired (same source).
      const keepsPath = damage !== 'missing';
      const keepsBinding = sourceChanged && keepsPath;
      // A row without a readable copy is named by its marketplace entry.
      const rowName = damage === 'head' ? 'installed-name' : 'p';
      expect(index()).toEqual(installedIndex);
      expect(current.plugins[0].name).toBe(rowName);
      expect(current.plugins[0].provenance).toEqual(provenance);
      expect(current.plugins[0].sourceChanged).toBe(sourceChanged);
      expect(current.plugins[0].cachePath).toBe(keepsPath ? copy : undefined);
      expect(current.plugins[0].sourcePath).toBe(keepsPath ? copy : '');
      expect(current.plugins[0].facets.claude?.cachePath).toBe(
        keepsPath ? copy : undefined,
      );
      expect(current.plugins[0].facets.claude).toMatchObject({
        name: rowName,
        installLocation: keepsPath ? copy : '',
        sourcePath: keepsPath ? copy : '',
        sourceChanged,
      });
      if (keepsPath) {
        expect(current.plugins[0].cachedAt).toBe(
          installedMarketplace.plugins[0].cachedAt,
        );
        expect(current.plugins[0].facets.claude?.provenance).toEqual(
          provenance,
        );
      }
      const selected =
        resolver === 'no-facet'
          ? { ...current.plugins[0], facets: {} }
          : current.plugins[0];
      const beforeIndex = index();
      const beforeCatalog = catalog();
      const noInstallWarnings: string[] = [];
      expect(
        await resolvePluginInfoPath(
          selected,
          current,
          noInstallWarnings,
          false,
          resolver === 'facet' ? 'claude' : undefined,
        ),
      ).toBe(keepsBinding ? copy : null);
      expect(noInstallWarnings.length).toBeGreaterThan(0);
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(index()).toEqual(beforeIndex);
      expect(catalog()).toEqual(beforeCatalog);
      const warnings: string[] = [];
      let repaired = await resolvePluginInfoPath(
        selected,
        current,
        warnings,
        true,
        resolver === 'facet' ? 'claude' : undefined,
      );
      if (sourceChanged && damage !== 'missing') {
        expect(repaired).toBe(copy);
        expect(cloneRepo).toHaveBeenCalledTimes(1);
        expect(warnings.length).toBeGreaterThan(0);
        expect(fs.readFileSync(path.join(copy, 'payload'), 'utf8')).toBe(
          original,
        );
        expect(index()).toEqual(beforeIndex);
        expect(catalog()).toEqual(beforeCatalog);
        expect(
          await resolvePluginInfoPath(
            selected,
            current,
            [],
            false,
            resolver === 'facet' ? 'claude' : undefined,
          ),
        ).toBe(copy);
        expect(cloneRepo).toHaveBeenCalledTimes(1);
        // Explicit catalog install/update can still adopt the advertised source.
        repaired = await install(advertised);
      }
      expect(repaired).toBeTruthy();
      expect(repaired).not.toBe(copy);
      expect(cloneRepo).toHaveBeenCalledTimes(2);
      expect(cloneRepo).toHaveBeenLastCalledWith(
        advertised,
        repaired,
        expect.any(Object),
      );
      expect(
        fs.readFileSync(path.join(repaired ?? '', 'payload'), 'utf8'),
      ).toBe(advertised);
      expect(index().entries['m/p'].sourceUrl).toBe(advertised);
      expect(index().entries['m/p'].provenance).toMatchObject({
        sourceUrl: sourceChanged
          ? 'https://github.com/other/p'
          : 'https://github.com/owner/p.git',
        commit: head,
        reinstalled: true,
      });
    },
  );

  function gitOutput(args: string[]): string {
    return execFileSync('git', args, { stdio: 'pipe' }).toString().trim();
  }
  /** `git init --ref-format` arrived in Git 2.45; never skip these layouts. */
  function requireReftableGit(): void {
    const version = /(\d+)\.(\d+)/.exec(gitOutput(['--version']));
    const [major, minor] = [Number(version?.[1]), Number(version?.[2])];
    if (!(major > 2 || (major === 2 && minor >= 45)))
      throw new Error(
        `This golden requires git ≥ 2.45; found ${version?.[0] ?? 'none'}.`,
      );
  }
  function commitPluginRepository(dir: string, refFormat: string): void {
    gitOutput([
      'init',
      '-q',
      '--object-format=sha1',
      `--ref-format=${refFormat}`,
      '-b',
      'main',
      dir,
    ]);
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    write({ name: 'p' }, path.join(dir, '.claude-plugin', 'plugin.json'));
    gitOutput(['-C', dir, 'add', '-A']);
    gitOutput([
      '-C',
      dir,
      '-c',
      'user.name=Golden',
      '-c',
      'user.email=golden@example.com',
      'commit',
      '-q',
      '-m',
      'plugin',
    ]);
  }

  test.each(['legacy', 'manifest-free'])(
    'availability exceptions keep %s copies executable without repeated clones',
    async (layout) => {
      write(baseCatalog());
      marketplaceFixture('owner/p');
      cloneFixture();
      let copy = pluginPath;
      if (layout === 'legacy') {
        write(
          {
            version: 1,
            entries: {
              'm/p': { cachePath: copy, sourceUrl: 'owner/p', cachedAt: '' },
            },
          },
          indexPath,
        );
      } else {
        jest.mocked(cloneRepo).mockImplementation((_url, dir) => {
          fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
          fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
          return Promise.resolve();
        });
        copy = await install();
      }
      await refreshed();
      const current = catalog().marketplaces.find((row) => row.id === 'm');
      if (!current) throw new Error('expected marketplace');
      expect(resolve().sdkPlugins).toEqual([{ type: 'local', path: copy }]);
      expect(
        await resolvePluginInfoPath(
          current.plugins[0],
          current,
          [],
          true,
          'claude',
        ),
      ).toBe(copy);
      expect(cloneRepo).toHaveBeenCalledTimes(layout === 'legacy' ? 0 : 1);
    },
  );

  test.each([
    { layout: 'files worktree', refFormat: 'files', usable: true },
    { layout: 'reftable worktree', refFormat: 'reftable', usable: true },
    { layout: 'reftable', refFormat: 'reftable', usable: true },
    {
      layout: 'quoted reftable',
      refFormat: 'reftable',
      config: 'refStorage = "reftable"',
      usable: true,
    },
    {
      layout: 'commented reftable',
      refFormat: 'reftable',
      config: 'refstorage = reftable # ref backend',
      usable: true,
    },
    {
      // Negative control: a files backend still needs a resolvable HEAD.
      layout: 'files with a missing HEAD ref',
      refFormat: 'files',
      config: 'refStorage = "files"',
      usable: false,
    },
  ])(
    'real Git $layout copies keep their recorded commit without repeated clones: usable=$usable',
    async ({ layout, refFormat, config, usable }) => {
      requireReftableGit();
      const seeds = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-seed-'));
      try {
        const seed = path.join(seeds, 'seed');
        const worktree = layout.endsWith('worktree');
        if (worktree) commitPluginRepository(seed, refFormat);
        write(baseCatalog());
        marketplaceFixture('owner/p');
        jest
          .mocked(getHeadCommitSha)
          .mockImplementation((dir) =>
            Promise.resolve(gitOutput(['-C', dir, 'rev-parse', 'HEAD'])),
          );
        jest.mocked(cloneRepo).mockImplementation((_url, dir) => {
          if (worktree)
            gitOutput(['-C', seed, 'worktree', 'add', '-q', '--detach', dir]);
          else commitPluginRepository(dir, refFormat);
          if (config) {
            const file = path.join(dir, '.git', 'config');
            const text = fs.readFileSync(file, 'utf8');
            const rewritten =
              refFormat === 'reftable'
                ? text.replace(/^\s*refstorage\s*=\s*reftable\s*$/im, config)
                : text
                    .replace(
                      'repositoryformatversion = 0',
                      'repositoryformatversion = 1',
                    )
                    .concat(`[extensions]\n\t${config}\n`);
            // Another Git's config spelling must not leave the bare value in place.
            expect(rewritten).not.toBe(text);
            expect(rewritten).toContain(config);
            fs.writeFileSync(file, rewritten);
            // Git itself reads the rewritten value as the fixture's backend.
            expect(
              gitOutput([
                'config',
                '--file',
                file,
                '--get',
                'extensions.refstorage',
              ]),
            ).toBe(refFormat);
          }
          return Promise.resolve();
        });
        const copy = await install();
        const git = path.join(copy, '.git');
        expect(fs.statSync(git).isFile()).toBe(worktree);
        // Fixture sanity: Git resolves HEAD to the recorded commit.
        const commit = index().entries['m/p'].provenance?.commit;
        expect(commit).toMatch(/^[0-9a-f]{40}$/);
        expect(gitOutput(['-C', copy, 'rev-parse', 'HEAD'])).toBe(commit);
        if (!usable) {
          fs.rmSync(path.join(git, 'refs', 'heads', 'main'));
          expect(fs.existsSync(path.join(git, 'packed-refs'))).toBe(false);
          expect(() => gitOutput(['-C', copy, 'rev-parse', 'HEAD'])).toThrow();
        }
        await refreshed();
        const current = catalog().marketplaces.find((row) => row.id === 'm');
        if (!current) throw new Error('expected marketplace');
        if (usable)
          expect(resolve().sdkPlugins).toEqual([{ type: 'local', path: copy }]);
        else
          expect(resolve().sdkPlugins).not.toContainEqual({
            type: 'local',
            path: copy,
          });
        const resolved = await resolvePluginInfoPath(
          current.plugins[0],
          current,
          [],
          true,
          'claude',
        );
        if (usable) expect(resolved).toBe(copy);
        else expect(resolved).not.toBe(copy);
        expect(resolved).toBeTruthy();
        expect(cloneRepo).toHaveBeenCalledTimes(usable ? 1 : 2);
      } finally {
        fs.rmSync(seeds, { recursive: true, force: true });
      }
    },
  );

  test('Git helper source provenance stays redacted through install and refresh', async () => {
    write(baseCatalog());
    const source =
      'https::https://old:token@github.com/owner/p?token=old-query-secret#old-fragment-secret';
    marketplaceFixture(source);
    cloneFixture();
    await install(source);
    const redacted = 'https::https://github.com/owner/p';
    expect(catalog().marketplaces[0].plugins[0].provenance?.sourceUrl).toBe(
      redacted,
    );
    // Refresh must also sanitize provenance from historical local index rows.
    const historical = index();
    historical.entries['m/p'].provenance = {
      ...historical.entries['m/p'].provenance,
      sourceUrl: source,
      installedAt: '',
    };
    write(historical, indexPath);
    marketplaceFixture('https::https://github.com/owner/p');
    await refreshed();
    const row = catalog().marketplaces[0].plugins[0];
    expect(row.provenance?.sourceUrl).toBe(redacted);
    expect(row.facets.claude?.provenance?.sourceUrl).toBe(redacted);
    expect(row.sourceChanged).toBe(true);
    expect(row.provenance?.sourceIdentityComplete).toBe(false);
    expect(index().entries['m/p'].sourceUrl).toBe(source);
  });

  test.each([
    {
      operation: 'pair publication',
      sourceUrl:
        'https::https://old:token@github.com/owner/q?token=old-query-secret#old-fragment-secret',
    },
    {
      operation: 'cache-only read',
      sourceUrl:
        'https://github.com/owner/q?token=old-query-secret&access_token=other-query-secret#old-fragment-secret',
    },
    {
      operation: 'presentation cache-only read',
      sourceUrl: 'https://old:token@github.com/owner/q',
    },
    {
      // libcurl, and so Git, accepts extra slashes before the login.
      operation: 'pair publication',
      sourceUrl: 'https:///old:token@github.com/owner/q',
    },
  ])(
    '$operation strips historical provenance on untouched rows and every facet: $sourceUrl',
    async ({ operation, sourceUrl }) => {
      const cache = baseCatalog();
      const provenance = {
        sourceUrl,
        installedAt: '',
      };
      const facet = {
        name: 'q',
        provenance,
        installLocation: pluginPath,
        sourcePath: pluginPath,
      };
      cache.marketplaces[0].plugins.push({
        ...cache.marketplaces[0].plugins[0],
        name: 'q',
        provenance,
        facets: {
          claude: { ...facet, provider: 'claude', mode: 'native' },
          codex: { ...facet, provider: 'codex', mode: 'native' },
          codexCompatibility: { ...facet, provider: 'codex', mode: 'compat' },
        },
      });
      write(cache);
      const before = fs.readFileSync(catalogPath, 'utf8');
      if (operation === 'pair publication') {
        cloneFixture();
        await install();
      }
      const loaded =
        operation === 'presentation cache-only read'
          ? await loadMarketplacesForPresentation(undefined, true)
          : await loadMarketplacesCacheOnly();
      expect(loaded.success).toBe(true);
      const published = fs.readFileSync(catalogPath, 'utf8');
      if (operation !== 'pair publication') {
        expect(published).toBe(before);
        expect(cloneRepo).not.toHaveBeenCalled();
        expect(fs.existsSync(indexPath)).toBe(false);
      }
      const untouched = loaded.data?.marketplaces[0].plugins.find(
        (plugin) => plugin.name === 'q',
      );
      expect(untouched?.provenance?.sourceUrl).toBe(
        sourceUrl.startsWith('https::')
          ? 'https::https://github.com/owner/q'
          : 'https://github.com/owner/q',
      );
      for (const provider of ['claude', 'codex', 'codexCompatibility'] as const)
        expect(untouched?.facets[provider]?.provenance?.sourceUrl).toBe(
          sourceUrl.startsWith('https::')
            ? 'https::https://github.com/owner/q'
            : 'https://github.com/owner/q',
        );
      const projections = [JSON.stringify(loaded.data)];
      if (operation === 'pair publication') projections.push(published);
      for (const serialized of projections)
        for (const secret of [
          'old:token@',
          'old-query-secret',
          'other-query-secret',
          'old-fragment-secret',
        ])
          expect(serialized).not.toContain(secret);
    },
  );

  test.each(['loose', 'packed'])(
    'standard %s refs verify the actual HEAD',
    async (layout) => {
      write(baseCatalog());
      cloneFixture();
      const copy = await install();
      const git = path.join(copy, '.git');
      fs.writeFileSync(
        path.join(git, 'HEAD'),
        'ref: refs/heads/release+stable',
      );
      fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
      const ref =
        layout === 'loose'
          ? path.join(git, 'refs', 'heads', 'release+stable')
          : path.join(git, 'packed-refs');
      fs.writeFileSync(
        ref,
        layout === 'loose' ? head : `${head} refs/heads/release+stable\n`,
      );
      expect(resolve().sdkPlugins).toEqual([{ type: 'local', path: copy }]);
      fs.writeFileSync(
        ref,
        layout === 'loose'
          ? 'b'.repeat(40)
          : `${'b'.repeat(40)} refs/heads/release+stable\n`,
      );
      expect(resolve().sdkPlugins).toEqual([]);
    },
  );

  test('replacement and marketplace removal retire copies; re-add never restores removed bindings', async () => {
    write(baseCatalog());
    cloneFixture();
    marketplaceFixture('owner/p');
    const first = await install();
    const second = await install();
    expect(fs.existsSync(first)).toBe(true);
    const before = index();
    const other = { cachePath: second, sourceUrl: 'owner/other', cachedAt: '' };
    before.entries['other/p'] = other;
    write(before, indexPath);
    jest
      .mocked(runClaudeCliProcessOffMain)
      .mockRejectedValueOnce(new Error('unavailable'));
    await removeMarketplace('m', { providers: ['claude'] });
    expect(index().entries['m/p'].cachePath).toBe(second);
    const cache = catalog();
    cache.marketplaces[0].plugins[0].facets.codex = {
      name: 'p',
      provider: 'codex',
      mode: 'native',
      installLocation: pluginPath,
      sourcePath: pluginPath,
    };
    write(cache);
    expect(
      (await removeMarketplace('m', { providers: ['claude'] })).success,
    ).toBe(true);
    expect(index().entries['m/p']).toBeUndefined();
    expect(index().entries['other/p']).toEqual(other);
    expect(index().retired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cachePath: first }),
        expect.objectContaining({ cachePath: second }),
      ]),
    );
    expect(fs.existsSync(second)).toBe(true);
    expect(catalog().marketplaces.find((row) => row.id === 'm')).toBeDefined();
    jest.mocked(removeCodexMarketplace).mockResolvedValue({ accepted: true });
    expect(
      (await removeMarketplace('m', { providers: ['codex'] })).success,
    ).toBe(true);
    expect(
      catalog().marketplaces.find((row) => row.id === 'm'),
    ).toBeUndefined();
    marketplaceFixture('other/p');
    expect((await addMarketplace('owner/m')).success).toBe(true);
    const readded = catalog().marketplaces.find((row) => row.id === 'm');
    if (!readded) throw new Error('expected re-added marketplace');
    expect(readded.sourceUrl).toBe('https://github.com/owner/m');
    const plugin = readded.plugins.find((row) => row.name === 'p');
    if (!plugin) throw new Error('expected re-added plugin');
    expect(plugin.externalSource?.url).toBe('other/p');
    expect(plugin.cachePath).toBeUndefined();
    expect(index().entries['m/p']).toBeUndefined();
    expect(cloneRepo).toHaveBeenCalledTimes(2);
  });

  test('marketplace removal with nothing to unbind or retire writes only the catalog', async () => {
    marketplaceFixture('owner/p');
    write(baseCatalog());
    const other = {
      cachePath: path.join(root, 'plugin-cache', 'other-1234abcd'),
      sourceUrl: 'owner/other',
      cachedAt: '',
    };
    write({ version: 1, entries: { 'other/p': other } }, indexPath);
    const realWrite = atomicFile.writeFileAtomically;
    const writes = jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementation((target, data, options) =>
        target === indexPath
          ? Promise.reject(new Error('index write failed'))
          : realWrite(target, data, options),
      );
    const result = await removeMarketplace('m', { providers: ['claude'] });
    expect(result.success).toBe(true);
    expect(result.data?.marketplace).toBeNull();
    expect(
      catalog().marketplaces.find((row) => row.id === 'm'),
    ).toBeUndefined();
    expect(writes.mock.calls.map(([target]) => target)).not.toContain(
      indexPath,
    );
    expect(index()).toEqual({ version: 1, entries: { 'other/p': other } });
  });

  test.each(['rejected', 'uncertain'])(
    'marketplace removal that only retires a copy still leaves the catalog when the index write is %s',
    async (failure) => {
      marketplaceFixture('owner/p');
      const copy = path.join(root, 'plugin-cache', 'catalog-only-1234abcd');
      fs.mkdirSync(copy, { recursive: true });
      const cache = baseCatalog();
      const row = cache.marketplaces[0].plugins[0];
      row.cachePath = copy;
      if (row.facets.claude) row.facets.claude.cachePath = copy;
      write(cache);
      const other = {
        cachePath: path.join(root, 'plugin-cache', 'other-1234abcd'),
        sourceUrl: 'owner/other',
        cachedAt: '',
      };
      write({ version: 1, entries: { 'other/p': other } }, indexPath);
      const writes = failIndexWrite(failure);
      const result = await removeMarketplace('m', { providers: ['claude'] });
      expect(result).toMatchObject({ success: true });
      expect(result.data?.marketplace).toBeNull();
      expect(writes.mock.calls.map(([target]) => target)).toContain(indexPath);
      expect(
        catalog().marketplaces.find((entry) => entry.id === 'm'),
      ).toBeUndefined();
      expect(fs.existsSync(copy)).toBe(true);
      if (failure === 'rejected') {
        // The unrecorded copy leaks rather than blocking the removal.
        expect(index()).toEqual({ version: 1, entries: { 'other/p': other } });
      } else {
        // The installed index stays visible; only its crash durability is unknown.
        expect(index()).toEqual({
          version: 1,
          entries: { 'other/p': other },
          retired: [expect.objectContaining({ cachePath: copy })],
        });
      }
    },
  );

  test.each(['provenance', 'ambiguous-legacy', 'undiscoverable-legacy'])(
    'marketplace removal unbinds slash entry names with %s identity and leaves unknown owners',
    async (identity) => {
      const marketplaceId = 'owner/repo';
      const entryName = 'tools/lint';
      const cache = baseCatalog();
      const marketplace = cache.marketplaces[0];
      marketplace.id = marketplaceId;
      marketplace.plugins[0].marketplaceId = marketplaceId;
      marketplace.plugins[0].name = entryName;
      write(cache);
      marketplaceFixture('owner/p', 'url', marketplaceId, entryName);
      cloneFixture(identity === 'provenance' ? 'installed-name' : entryName);
      const result = await installPlugin(marketplaceId, entryName, 'owner/p', {
        skipRefresh: true,
      });
      expect(result.success).toBe(true);
      const key = `${marketplaceId}/${entryName}`;
      const before = index();
      const copy = before.entries[key].cachePath;
      const other = {
        ...before.entries[key],
        provenance: {
          ...before.entries[key].provenance,
          sourceUrl: 'owner/other',
          installedAt: '',
          marketplaceEntryName: 'other',
        },
      };
      const unknown = {
        cachePath: copy,
        sourceUrl: 'owner/unknown',
        cachedAt: '',
      };
      before.entries[`${marketplaceId}/tools/other`] = other;
      before.entries[`${marketplaceId}/unknown`] = unknown;
      if (identity !== 'provenance') {
        delete before.entries[key].provenance;
        const installed = catalog();
        for (const plugin of installed.marketplaces[0].plugins) {
          delete plugin.provenance;
          if (plugin.facets.claude) delete plugin.facets.claude.provenance;
        }
        if (identity === 'ambiguous-legacy') {
          const neighbor = baseCatalog().marketplaces[0];
          neighbor.id = `${marketplaceId}/tools`;
          neighbor.plugins[0].marketplaceId = neighbor.id;
          neighbor.plugins[0].name = 'lint';
          installed.marketplaces.push(neighbor);
          addNeighborManifest(neighbor.id, 'lint', 'owner/neighbor');
        }
        write(installed);
      }
      if (identity === 'undiscoverable-legacy')
        // No manifest names the entry, so no lookup discovers its legacy binding.
        fs.rmSync(
          path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
        );
      write(before, indexPath);
      const removal = await removeMarketplace(marketplaceId, {
        providers: ['claude'],
      });
      expect(removal.success).toBe(true);
      expect(index().entries[key]).toEqual(
        identity === 'provenance' ? undefined : before.entries[key],
      );
      expect(index().entries[`${marketplaceId}/tools/other`]).toEqual(other);
      expect(index().entries[`${marketplaceId}/unknown`]).toEqual(unknown);
      // Unknown legacy ownership retires none of the copies legacy bindings hold.
      expect(
        (index().retired ?? []).some((entry) => entry.cachePath === copy),
      ).toBe(identity !== 'undiscoverable-legacy');
      expect(fs.existsSync(copy)).toBe(true);
      expect(
        catalog().marketplaces.find((row) => row.id === marketplaceId),
      ).toBeUndefined();
    },
  );

  test.each(['unique', 'unmapped-empty', 'unmapped-local-only'])(
    'marketplace removal preserves a neighbor legacy binding with %s registration mapping',
    async (mapping) => {
      marketplaceFixture(
        'owner/p',
        'url',
        'selected-registration',
        'tools/lint',
      );
      addNeighborManifest('neighbor-registration', 'lint', 'owner/neighbor');
      const neighborPlugins = mapping.endsWith('-empty')
        ? []
        : mapping.endsWith('-local-only')
          ? [{ name: 'lint', source: './lint' }]
          : undefined;
      if (neighborPlugins)
        write(
          { name: 'neighbor-registration', plugins: neighborPlugins },
          path.join(
            marketplaceRoot,
            'neighbor',
            '.claude-plugin',
            'marketplace.json',
          ),
        );
      const cache = baseCatalog();
      const selected = cache.marketplaces[0];
      selected.id = 'owner/repo';
      selected.providerStatus.claude.marketplaceName = 'selected-registration';
      selected.plugins = [];
      selected.pluginCount = 0;
      const neighbor = baseCatalog().marketplaces[0];
      neighbor.id = 'owner/repo/tools';
      neighbor.providerStatus.claude.marketplaceName = mapping.startsWith(
        'unmapped',
      )
        ? 'unknown-registration'
        : 'neighbor-registration';
      neighbor.plugins = [];
      neighbor.pluginCount = 0;
      cache.marketplaces.push(neighbor);
      if (mapping.startsWith('ambiguous')) {
        const duplicate = baseCatalog().marketplaces[0];
        duplicate.id = 'another-owner';
        duplicate.providerStatus.claude.marketplaceName =
          'neighbor-registration';
        duplicate.plugins = [];
        cache.marketplaces.push(duplicate);
      }
      write(cache);
      const copy = path.join(root, 'plugin-cache', 'neighbor-1234abcd');
      const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
      for (const candidate of [copy, unused]) {
        fs.mkdirSync(candidate, { recursive: true });
        fs.writeFileSync(path.join(candidate, 'payload'), 'keep');
      }
      const key = 'owner/repo/tools/lint';
      const binding = {
        cachePath: copy,
        sourceUrl: 'owner/neighbor',
        cachedAt: '',
      };
      write(
        {
          version: 1,
          entries: { [key]: binding },
          retired: [{ cachePath: unused, retiredAt: '2000-01-01T00:00:00Z' }],
        },
        indexPath,
      );
      const removal = await removeMarketplace(selected.id, {
        providers: ['claude'],
      });
      expect(removal.success).toBe(true);
      expect(removal.data?.removedProviders).toContain('claude');
      expect(
        catalog().marketplaces.find((row) => row.id === selected.id),
      ).toBeUndefined();
      expect(index().entries[key]).toEqual(binding);
      expect(index().retired).not.toContainEqual(
        expect.objectContaining({ cachePath: copy }),
      );
      await jest.isolateModulesAsync(refreshedInIsolatedLifetime);
      expect(index().entries[key]).toEqual(binding);
      expect(fs.readFileSync(path.join(copy, 'payload'), 'utf8')).toBe('keep');
      expect(fs.existsSync(unused)).toBe(false);
    },
  );

  test.each(['provenance', 'shared-path'])(
    'Update and uninstall use one %s key and preserve other bindings and shared payloads',
    async (identity) => {
      write(baseCatalog());
      marketplaceFixture('owner/p');
      cloneFixture('installed-name');
      const oldCopy = await install();
      const cache = catalog();
      const row = cache.marketplaces[0].plugins[0];
      const before = index();
      const original = before.entries['m/p'];
      if (identity !== 'provenance') {
        delete row.provenance;
        if (!row.facets.claude) throw new Error('expected facet');
        delete row.facets.claude.provenance;
      } else {
        // Facet identity wins even when the row-level projection disagrees.
        row.provenance = {
          sourceUrl: 'owner/other',
          installedAt: '',
          marketplaceEntryName: 'other',
        };
      }
      if (identity === 'shared-path')
        before.entries['m/alias'] = { ...original };
      if (identity === 'different-path') {
        // Payload location does not change the manifest entry identity.
        before.entries['m/p'] = { ...original, cachePath: pluginPath };
      }
      before.entries['other/p'] = { ...original };
      write(cache);
      write(before, indexPath);
      // Without a recorded entry name, develop's requested literal key.
      const key = identity === 'provenance' ? 'm/p' : 'm/installed-name';
      const result = await installPlugin('m', row.name, 'owner/new', {
        skipRefresh: true,
      });
      expect(result.success).toBe(true);
      const next = result.data?.cachePath;
      if (!next) throw new Error('expected updated copy');
      const after = index();
      expect(after.entries[key].cachePath).toBe(next);
      for (const [otherKey, binding] of Object.entries(before.entries))
        if (otherKey !== key) expect(after.entries[otherKey]).toEqual(binding);
      expect(fs.existsSync(oldCopy)).toBe(true);
      const retained = catalog();
      const installed = retained.marketplaces[0].plugins[0];
      if (!installed.facets.claude) throw new Error('expected installed facet');
      installed.facets.codex = {
        ...installed.facets.claude,
        provider: 'codex',
        mode: 'native',
      };
      installed.providerSupport.codex = 'native';
      const shared = structuredClone(retained.marketplaces[0].plugins[0]);
      shared.name = 'shared';
      if (!shared.facets.claude) throw new Error('expected shared facet');
      shared.facets.claude.name = 'shared';
      if (!shared.facets.codex) throw new Error('expected shared Codex facet');
      shared.facets.codex.name = 'shared';
      retained.marketplaces[0].plugins.push(shared);
      write(retained);
      expect(resolve('installed-name').sdkPlugins).toEqual([
        { type: 'local', path: next },
      ]);
      expect(
        await resolvePluginInfoPath(
          installed,
          retained.marketplaces[0],
          [],
          false,
          'codex',
        ),
      ).toBe(next);
      await removeInstalledPluginCache('m', 'installed-name');
      expect(index().entries[key]).toBeUndefined();
      expect(index().entries['other/p']).toEqual(original);
      expect(fs.existsSync(next)).toBe(true);
      const uninstalled = catalog().marketplaces[0];
      const removed = uninstalled.plugins.find(
        (plugin) => plugin.name === 'installed-name',
      );
      if (!removed) throw new Error('expected uninstalled row');
      expect(resolve('installed-name').sdkPlugins).toEqual([]);
      expect(removed.sourcePath).toBe('');
      expect(removed.cachePath).toBeUndefined();
      for (const provider of ['claude', 'codex'] as const) {
        expect(
          await resolvePluginInfoPath(
            removed,
            uninstalled,
            [],
            false,
            provider,
          ),
        ).toBeNull();
        expect(removed.facets[provider]).toMatchObject({
          sourcePath: '',
          installLocation: '',
        });
        expect(removed.facets[provider]?.cachePath).toBeUndefined();
        expect(
          await resolvePluginInfoPath(shared, uninstalled, [], false, provider),
        ).toBe(next);
      }
      expect(resolve('shared').sdkPlugins).toEqual([
        { type: 'local', path: next },
      ]);
      expect(
        catalog().marketplaces[0].plugins.find(
          (plugin) => plugin.name === 'shared',
        ),
      ).toEqual(shared);
    },
  );

  test.each([
    'exact',
    'unique-normalized',
    'ambiguous-normalized',
    'provenance',
  ])(
    'recovered index binds catalog copies by %s entry identity',
    async (matching) => {
      write(baseCatalog());
      cloneFixture('installed-name');
      const source = 'git@github.com:owner/p.git';
      marketplaceFixture(source);
      const copy = await install(source);
      const cache = catalog();
      const row = cache.marketplaces[0].plugins[0];
      if (!row.facets.claude) throw new Error('expected installed facet');
      if (matching !== 'provenance') {
        delete row.provenance;
        delete row.facets.claude.provenance;
      }
      write(cache);
      const httpsSource = { source: 'url', url: 'https://github.com/owner/p' };
      write(
        {
          name: 'm',
          plugins:
            matching === 'unique-normalized'
              ? [{ name: 'p', source: httpsSource }]
              : matching === 'provenance'
                ? [
                    { name: 'p', source: httpsSource },
                    {
                      name: 'exact-entry',
                      source: { source: 'url', url: source },
                    },
                  ]
                : [
                    { name: 'https-entry', source: httpsSource },
                    {
                      name: 'p',
                      source:
                        matching === 'exact'
                          ? { source: 'url', url: source }
                          : httpsSource,
                    },
                  ],
        },
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      write({ version: 1, entries: { bad: { cachePath: 7 } } }, indexPath);
      await refreshed();
      const current = catalog().marketplaces.find((entry) => entry.id === 'm');
      if (!current) throw new Error('expected recovered marketplace');
      if (matching === 'ambiguous-normalized') {
        expect(current.plugins.map((plugin) => plugin.cachePath)).toEqual([
          undefined,
          undefined,
        ]);
        expect(resolve('installed-name').sdkPlugins).toEqual([]);
      } else {
        const bound = current.plugins.find(
          (plugin) => plugin.cachePath === copy,
        );
        expect(bound?.name).toBe('installed-name');
        expect(bound?.externalSource?.url).toBe(
          matching === 'exact' ? source : httpsSource.url,
        );
        expect(
          current.plugins.filter((plugin) => plugin.cachePath),
        ).toHaveLength(1);
        expect(resolve('installed-name').sdkPlugins).toEqual([
          { type: 'local', path: copy },
        ]);
      }
      expect(cloneRepo).toHaveBeenCalledTimes(1);
    },
  );

  test('recovered index then healthy write retains observed snapshots until a fresh module lifetime', async () => {
    write(baseCatalog());
    cloneFixture();
    marketplaceFixture('owner/p');
    const first = await install();
    const snapshot = catalog();
    const second = await install();
    const recovered = index();
    recovered.retired = [
      { cachePath: first, retiredAt: '2000-01-01T00:00:00Z' },
    ];
    write(
      {
        ...recovered,
        entries: { ...recovered.entries, 'other/bad': { cachePath: 7 } },
      },
      indexPath,
    );
    write({
      ...snapshot,
      marketplaces: snapshot.marketplaces.map((marketplace) => ({
        ...marketplace,
        plugins: [...marketplace.plugins, { name: 'malformed', cachePath: 7 }],
      })),
    });
    expect(readPluginCatalogHealth()).toMatchObject({ recovered: 'damaged' });
    await refreshed();
    expect(
      catalog().marketplaces.find((row) => row.id === 'm')?.plugins[0]
        .cachePath,
    ).toBe(second);
    // Provider registration shape is irrelevant to index recovery.
    write(
      { m: { installLocation: 42 } },
      path.join(root, 'plugins', 'known_marketplaces.json'),
    );
    // An ordinary install makes the recovered index healthy without changing the old retirement.
    expect(
      (await installPlugin('other', 'q', 'owner/q', { skipRefresh: true }))
        .success,
    ).toBe(true);
    expect(
      index().retired?.find((entry) => entry.cachePath === first)?.retiredAt,
    ).toBe('2000-01-01T00:00:00Z');
    marketplaceFixture('owner/p');
    await refreshed();
    expect(fs.existsSync(first)).toBe(true);
    await jest.isolateModulesAsync(async () => {
      await refreshedInIsolatedLifetime();
    });
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(true);
  });

  test.each(['encoded-parent-traversal-file-url'])(
    'marketplace refresh publishes a %s local source before retiring unused copies',
    async (source) => {
      const copy = path.join(root, 'plugin-cache', 'source-1234abcd');
      const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
      for (const candidate of [copy, unused]) {
        fs.mkdirSync(candidate, { recursive: true });
        fs.writeFileSync(path.join(candidate, 'payload'), 'source');
      }
      if (source === 'encoded-parent-traversal-file-url')
        fs.mkdirSync(path.join(copy, 'child'));
      const sourceUrl =
        source === 'path'
          ? copy
          : source === 'file-url'
            ? pathToFileURL(copy).href
            : source === 'encoded-separator-file-url'
              ? pathToFileURL(copy).href.replace(/\/(?=[^/]+$)/, '%2F')
              : `${pathToFileURL(copy).href}%2Fchild/..`;
      marketplaceFixture(sourceUrl);
      write(baseCatalog());
      const retired = [copy, unused].map((cachePath) => ({
        cachePath,
        retiredAt: '2000-01-01T00:00:00Z',
      }));
      write({ version: 1, entries: {}, retired }, indexPath);
      await refreshed();
      await refreshed();
      const published = catalog().marketplaces.find((entry) => entry.id === 'm')
        ?.plugins[0];
      expect(published?.externalSource?.url).toBe(sourceUrl);
      expect(published?.facets.claude?.externalSource?.url).toBe(sourceUrl);
      expect(fs.existsSync(copy)).toBe(true);
      expect(fs.readFileSync(path.join(copy, 'payload'), 'utf8')).toBe(
        'source',
      );
      expect(fs.existsSync(unused)).toBe(false);
      expect(index().entries).toEqual({});
      expect(index().retired).toEqual([retired[0]]);
    },
  );

  test('a Git file source with a literal delimiter protects retired children of its resolved ancestor', async () => {
    const copy = path.join(root, 'plugin-cache', 'source-1234abcd');
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'payload'), 'keep');
    fs.mkdirSync(path.join(root, 'parent#literal'));
    const source = `${pathToFileURL(root).href}/parent#literal/../plugin-cache`;
    marketplaceFixture(source);
    write(baseCatalog());
    const retired = { cachePath: copy, retiredAt: '2000-01-01T00:00:00Z' };
    write({ version: 1, entries: {}, retired: [retired] }, indexPath);
    await refreshed();
    expect(fs.readFileSync(path.join(copy, 'payload'), 'utf8')).toBe('keep');
    expect(index().retired).toEqual([retired]);
  });

  test('marketplace refresh publishes an unmappable local source without deleting potentially referenced copies', async () => {
    const copy = path.join(root, 'plugin-cache', 'source-1234abcd');
    const unused = path.join(root, 'plugin-cache', 'unused-1234abcd');
    for (const candidate of [copy, unused]) {
      fs.mkdirSync(candidate, { recursive: true });
      fs.writeFileSync(path.join(candidate, 'payload'), 'source');
    }
    marketplaceFixture('file:///%ZZ');
    write(baseCatalog());
    write(
      {
        version: 1,
        entries: {},
        retired: [copy, unused].map((cachePath) => ({
          cachePath,
          retiredAt: '2000-01-01T00:00:00Z',
        })),
      },
      indexPath,
    );
    await jest.isolateModulesAsync(async () => {
      const { readPluginCatalogHealth: readSnapshot } =
        await import('../plugin-service');
      await refreshedInIsolatedLifetime();
      const uncertain = readSnapshot();
      if (uncertain.state !== 'valid') throw new Error('expected catalog');
      expect(
        uncertain.data.marketplaces.find((entry) => entry.id === 'm')
          ?.plugins[0].externalSource?.url,
      ).toBe('file:///%ZZ');
      expect(fs.existsSync(copy)).toBe(true);
      expect(fs.existsSync(unused)).toBe(true);
      marketplaceFixture(copy);
      await refreshedInIsolatedLifetime();
      const corrected = readSnapshot();
      if (corrected.state !== 'valid') throw new Error('expected catalog');
      expect(
        corrected.data.marketplaces.find((entry) => entry.id === 'm')
          ?.plugins[0].externalSource?.url,
      ).toBe(copy);
      expect(fs.existsSync(unused)).toBe(true);
    });
    // Uncertainty disables deletion for the lifetime, not refresh. Restart can sweep again.
    await jest.isolateModulesAsync(async () => {
      await refreshedInIsolatedLifetime();
    });
    expect(fs.readFileSync(path.join(copy, 'payload'), 'utf8')).toBe('source');
    expect(fs.existsSync(unused)).toBe(false);
    expect(index().retired?.map((entry) => entry.cachePath)).toEqual([copy]);
  });
  test.each(['file:///%ZZ'])(
    'an unmappable local source %s skips cleanup without blocking refresh or uninstall',
    async (sourceUrl) => {
      marketplaceFixture('owner/p');
      const copy = path.join(root, 'plugin-cache', 'uncertain-1234abcd');
      fs.mkdirSync(copy, { recursive: true });
      const entries = {
        'other/source-user': { cachePath: pluginPath, sourceUrl, cachedAt: '' },
      };
      const retired = [{ cachePath: copy, retiredAt: '2000-01-01T00:00:00Z' }];
      write(baseCatalog());
      write({ version: 1, entries, retired }, indexPath);
      // Unknown references disable cleanup only, not ordinary mutations.
      await jest.isolateModulesAsync(async () => {
        const service = await import('../plugin-service');
        await service.sweepRetiredPluginCopies();
        expect(fs.existsSync(copy)).toBe(true);
        await refreshedInIsolatedLifetime();
        expect(fs.existsSync(copy)).toBe(true);
        const installed = baseCatalog();
        installed.marketplaces[0].plugins[0].cachePath = copy;
        write(installed);
        write(
          {
            version: 1,
            entries: {
              ...entries,
              'm/p': { cachePath: copy, sourceUrl: 'owner/p', cachedAt: '' },
            },
            retired,
          },
          indexPath,
        );
        await service.removeInstalledPluginCache('m', 'p');
        expect(fs.existsSync(copy)).toBe(true);
        const {
          readPluginCacheIndex: readIndex,
          readPluginCatalog: readSnapshot,
        } =
          await import('@canopy/execution-engine/node/plugins/catalog-read-health');
        const remaining = readIndex(indexPath);
        if (remaining.state !== 'valid') throw new Error('expected index');
        expect(remaining.data.entries).toEqual(entries);
        expect(remaining.data.retired).toEqual([
          { cachePath: copy, retiredAt: remaining.data.retired?.[0].retiredAt },
        ]);
        expect(typeof remaining.data.retired?.[0].retiredAt).toBe('string');
        expect(remaining.data.retired?.[0].retiredAt).not.toBe(
          retired[0].retiredAt,
        );
        const snapshot = readSnapshot(catalogPath);
        if (snapshot.state !== 'valid') throw new Error('expected catalog');
        expect(
          snapshot.data.marketplaces[0].plugins[0].cachePath,
        ).toBeUndefined();
      });
    },
  );

  test('previously read local sources protect copies until successive restarts', async () => {
    marketplaceFixture('owner/p');
    const copy = path.join(root, 'plugin-cache', 'snapshot-1234abcd');
    function retireCopy(): void {
      fs.mkdirSync(copy, { recursive: true });
      write(
        {
          version: 1,
          entries: {},
          retired: [{ cachePath: copy, retiredAt: '2000-01-01T00:00:00Z' }],
        },
        indexPath,
      );
    }
    async function observeSource(source: string): Promise<void> {
      const { readPluginCatalog: readSnapshot } =
        await import('@canopy/execution-engine/node/plugins/catalog-read-health');
      const snapshot = baseCatalog();
      snapshot.marketplaces[0].plugins[0].externalSource = {
        source: 'url',
        url:
          source === 'encoded-separator'
            ? pathToFileURL(copy).href.replace(/\/(?=[^/]+$)/, '%2F')
            : 'file:///%ZZ',
      };
      write(snapshot);
      expect(readSnapshot(catalogPath).state).toBe('valid');
      write(baseCatalog());
      await refreshedInIsolatedLifetime();
      expect(fs.existsSync(copy)).toBe(true);
    }

    retireCopy();
    await jest.isolateModulesAsync(async () => {
      await observeSource('encoded-separator');
    });
    await jest.isolateModulesAsync(async () => {
      await refreshedInIsolatedLifetime();
      expect(fs.existsSync(copy)).toBe(false);
      // Prove reclamation before uncertainty can mask the known-path control.
      retireCopy();
      await observeSource('unmappable');
    });
    await jest.isolateModulesAsync(async () => {
      await refreshedInIsolatedLifetime();
    });
    expect(fs.existsSync(copy)).toBe(false);
  });

  test('a recovered shared read during cleanup protects the next copy before removal', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    const copies = ['first-1234abcd', 'second-1234abcd'].map((name) =>
      path.join(root, 'plugin-cache', name),
    );
    for (const copy of copies) fs.mkdirSync(copy, { recursive: true });
    write(
      {
        version: 1,
        entries: {},
        retired: copies.map((cachePath) => ({
          cachePath,
          retiredAt: '2000-01-01T00:00:00Z',
        })),
      },
      indexPath,
    );
    const remove = fs.promises.rm;
    const removed: string[] = [];
    jest
      .spyOn(fs.promises, 'rm')
      .mockImplementation(async (candidate, options) => {
        if (typeof candidate === 'string' && copies.includes(candidate)) {
          removed.push(candidate);
          if (removed.length === 1) {
            const observed = baseCatalog();
            observed.marketplaces[0].plugins[0].cachePath = copies.find(
              (copy) => copy !== candidate,
            );
            // A sibling of the live catalog: its observation root is the same
            // cache, and leaving the live catalog untouched keeps the sweep's
            // evidence recheck from masking the process-history guard.
            const sibling = path.join(root, 'observed-plugins-cache.json');
            write(
              {
                ...observed,
                marketplaces: observed.marketplaces.map((marketplace) => ({
                  ...marketplace,
                  plugins: [
                    ...marketplace.plugins,
                    { name: 'bad', cachePath: 7 },
                  ],
                })),
              },
              sibling,
            );
            expect(
              await readHealth.readPluginCatalogAsync(sibling),
            ).toMatchObject({ recovered: 'damaged' });
          }
        }
        await remove(candidate, options);
      });
    await refreshed();
    expect(removed).toHaveLength(1);
    expect(copies.filter((copy) => fs.existsSync(copy))).toHaveLength(1);
  });

  test('a publication candidate with an uncertain install protects its copy for this lifetime', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    const copy = path.join(root, 'plugin-cache', 'uncertain-1234abcd');
    fs.mkdirSync(copy, { recursive: true });
    const candidate = baseCatalog();
    candidate.marketplaces[0].plugins[0].cachePath = copy;
    // The real writer installs the candidate, then its directory flush fails.
    const before = fs.readFileSync(catalogPath, 'utf8');
    const realOpen = fsPromises.open;
    const opened = jest
      .spyOn(fsPromises, 'open')
      .mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (args[0] === root && fs.readFileSync(catalogPath, 'utf8') !== before)
          jest
            .spyOn(handle, 'sync')
            .mockRejectedValue(new Error('injected directory flush failure'));
        return handle;
      });
    let failure: unknown;
    try {
      await publishPluginCatalog(candidate);
    } catch (error) {
      failure = error;
    }
    opened.mockRestore();
    expect(failure).toBeInstanceOf(CatalogPublicationError);
    if (!(failure instanceof CatalogPublicationError))
      throw new Error('expected publication failure');
    expect(failure.outcomes).toMatchObject([
      { document: 'plugins_cache', state: 'installed_uncertain' },
    ]);
    // Raw bytes, not a catalog reader, so no read observes the reference.
    const installed: unknown = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    expect(installed).toMatchObject({
      marketplaces: [{ plugins: [{ cachePath: copy }] }],
    });
    // A later catalog replaces the candidate before any detached read settles.
    write(baseCatalog());
    write(
      {
        version: 1,
        entries: {},
        retired: [{ cachePath: copy, retiredAt: '2000-01-01T00:00:00Z' }],
      },
      indexPath,
    );
    await settleDetachedWork();
    await refreshed();
    expect(fs.existsSync(copy)).toBe(true);
  });

  test('catalog snapshot copy-token-filter revision: outside and managed strings bound history without blocking reads, and cleanup resumes after successive restarts', async () => {
    marketplaceFixture('owner/p');
    const cacheRoot = path.join(root, 'plugin-cache');
    const copy = path.join(cacheRoot, 'unused-1234abcd');
    const active = path.join(cacheRoot, 'active-1234abcd');
    const binding = {
      cachePath: active,
      sourceUrl: 'owner/live',
      cachedAt: '',
    };
    function retireCopy(): void {
      fs.mkdirSync(copy, { recursive: true });
      fs.mkdirSync(active, { recursive: true });
      write(
        {
          version: 1,
          entries: { 'other/live': binding },
          retired: [{ cachePath: copy, retiredAt: '2000-01-01T00:00:00Z' }],
        },
        indexPath,
      );
    }
    async function observeHistory(location: string): Promise<void> {
      const { readPluginCatalog: readSnapshot } =
        await import('@canopy/execution-engine/node/plugins/catalog-read-health');
      for (let generation = 0; generation < 2; generation++) {
        const snapshot = baseCatalog();
        const details = snapshot.marketplaces[0].plugins[0].details;
        if (!details) throw new Error('expected plugin details');
        details.mcpServers = [
          {
            name: 'publisher',
            type: 'command',
            command: 'cmd',
            args: Array.from({ length: 6000 }, (_, offset) =>
              path.join(
                location === 'managed' ? cacheRoot : `${cacheRoot}-outside`,
                location === 'managed'
                  ? `publisher-${generation}-${offset.toString(16).padStart(8, '0')}`
                  : `publisher-${generation}-${offset}`,
              ),
            ),
          },
        ];
        write(snapshot);
        expect(readSnapshot(catalogPath).state).toBe('valid');
      }
      write(baseCatalog());
      await refreshedInIsolatedLifetime();
      expect(fs.existsSync(copy)).toBe(location === 'managed');
      expect(fs.existsSync(active)).toBe(true);
      const { readPluginCacheIndex: readIndex } =
        await import('@canopy/execution-engine/node/plugins/catalog-read-health');
      const remaining = readIndex(indexPath);
      if (remaining.state !== 'valid') throw new Error('expected index');
      expect(remaining.data.entries['other/live']).toEqual(binding);
      expect(remaining.data.retired).toEqual(
        location === 'managed'
          ? [{ cachePath: copy, retiredAt: '2000-01-01T00:00:00Z' }]
          : [],
      );
    }

    retireCopy();
    await jest.isolateModulesAsync(async () => {
      await observeHistory('outside');
    });
    await jest.isolateModulesAsync(async () => {
      await refreshedInIsolatedLifetime();
      expect(fs.existsSync(copy)).toBe(false);
      expect(fs.existsSync(active)).toBe(true);
      // Saturate history only after the outside-string deletion control passes.
      retireCopy();
      await observeHistory('managed');
    });
    await jest.isolateModulesAsync(async () => {
      await refreshedInIsolatedLifetime();
    });
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(active)).toBe(true);
  });

  test.each(['invalid-utf8'])(
    'refresh cleanup respects references and skips %s preimages and unsafe candidates',
    async (damage) => {
      write(baseCatalog());
      marketplaceFixture('owner/p');
      const cacheRoot = path.join(root, 'plugin-cache');
      const names = [
        'unused-1234abcd',
        'executable-1234abcd',
        'preimage-1234abcd',
        'recent-1234abcd',
        'orphan-1234abcd',
        'codex-compatibility',
        'unknown',
        'Copy-1234abcd',
      ];
      fs.mkdirSync(cacheRoot, { recursive: true });
      for (const name of names) fs.mkdirSync(path.join(cacheRoot, name));
      const external = path.join(marketplaceRoot, 'external-1234abcd');
      fs.mkdirSync(external);
      const alias = path.join(cacheRoot, 'alias-1234abcd');
      fs.symlinkSync(external, alias, 'junction');
      const file = path.join(cacheRoot, 'file-1234abcd');
      fs.writeFileSync(file, 'not a directory');
      const detailsCopy = path.join(cacheRoot, names[1]);
      const local = path.join(marketplaceRoot, 'local');
      fs.mkdirSync(path.join(local, '.claude-plugin'), { recursive: true });
      write(
        { name: 'local' },
        path.join(local, '.claude-plugin', 'plugin.json'),
      );
      // Publisher-controlled arguments must not overflow a function call's argument count.
      write(
        {
          demo: {
            command: path.join(detailsCopy, 'missing', '..', 'command'),
            args: Array(150000).fill('.'),
          },
        },
        path.join(local, '.mcp.json'),
      );
      write(
        { name: 'm', plugins: [{ name: 'local', source: './local' }] },
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      );
      const old = '2000-01-01T00:00:00Z';
      const retired = [
        ...names
          .filter(
            (name) => !name.startsWith('orphan') && !name.startsWith('Copy'),
          )
          .map((name) => path.join(cacheRoot, name)),
        external,
        alias,
        file,
        path.join(cacheRoot, 'missing-1234abcd'),
        path.join(cacheRoot, 'copy-1234abcd'),
      ].map((cachePath) => ({
        cachePath,
        retiredAt: cachePath.endsWith(names[3])
          ? new Date().toISOString()
          : old,
      }));
      write({ version: 1, entries: {}, retired }, indexPath);
      write(
        {
          version: 1,
          entries: {},
          retired: [
            {
              cachePath: path.join(cacheRoot, names[2], 'missing'),
              retiredAt: old,
            },
          ],
        },
        `${indexPath}.damaged-old`,
      );
      const damaged = Buffer.from(
        JSON.stringify({
          version: 2,
          lastRefreshed: '',
          marketplaces: [],
          description: 'descriptive text',
        }),
      );
      damaged[damaged.indexOf('descriptive text') + 1] = 0xff;
      fs.writeFileSync(
        `${catalogPath}.damaged-bad`,
        damage === 'truncated' ? '{' : damaged,
      );
      await refreshed();
      expect(fs.existsSync(path.join(cacheRoot, names[0]))).toBe(true);
      fs.unlinkSync(`${catalogPath}.damaged-bad`);
      jest.spyOn(process, 'cwd').mockReturnValue(path.parse(root).root);
      await refreshed();
      expect(fs.existsSync(path.join(cacheRoot, names[0]))).toBe(false);
      for (const name of names.slice(1))
        expect(fs.existsSync(path.join(cacheRoot, name))).toBe(true);
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(external)).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('not a directory');
      expect(index().retired).not.toContainEqual(
        expect.objectContaining({
          cachePath: path.join(cacheRoot, 'missing-1234abcd'),
        }),
      );
    },
  );
  test('execution keeps the selected catalog snapshot until refresh reconciles an index-first install', async () => {
    const before = baseCatalog();
    const beforePlugin = before.marketplaces[0].plugins[0];
    beforePlugin.externalSource = { url: 'owner/p' };
    beforePlugin.cachePath = pluginPath;
    if (!beforePlugin.facets.claude) throw new Error('expected Claude facet');
    beforePlugin.facets.claude.externalSource = { url: 'owner/p' };
    beforePlugin.facets.claude.cachePath = pluginPath;
    write(before);
    marketplaceFixture('owner/p');
    cloneFixture();
    const installed = await installPlugin('m', 'p', 'owner/p', {
      skipRefresh: true,
    });
    expect(installed.success).toBe(true);
    write(before);
    expect(resolve().sdkPlugins).toEqual([{ type: 'local', path: pluginPath }]);
    expect(
      await resolvePluginInfoPath(
        beforePlugin,
        before.marketplaces[0],
        [],
        false,
        'claude',
      ),
    ).toBe(pluginPath);
    await refreshMarketplaces();
    expect(resolve().sdkPlugins).toEqual([
      { type: 'local', path: installed.data?.cachePath },
    ]);
  });

  test('refresh leaves a UNC managed cache root and its retirement record untouched', async () => {
    write(baseCatalog());
    marketplaceFixture('owner/p');
    const localRoot = path.join(root, 'plugin-cache');
    const copy = path.join(localRoot, 'copy-1234abcd');
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'keep'), 'payload');
    // Network-style root spelling backed by a local fixture, never a real share.
    const cacheRoot =
      process.platform === 'win32'
        ? path.win32.toNamespacedPath(localRoot)
        : `/${localRoot}`;
    expect(cacheRoot).toMatch(/^[\\/]{2}/);
    expect(path.isAbsolute(cacheRoot)).toBe(true);
    const entry = {
      cachePath: path.join(cacheRoot, 'copy-1234abcd'),
      retiredAt: '2000-01-01T00:00:00Z',
    };
    write({ version: 1, entries: {}, retired: [entry] }, indexPath);
    jest.spyOn(pluginPaths, 'getPluginCacheDir').mockReturnValue(cacheRoot);
    const readDirectory = jest.spyOn(fs.promises, 'readdir');
    expect((await refreshMarketplaces()).success).toBe(true);
    expect(
      readDirectory.mock.calls.map(([candidate]) => candidate),
    ).not.toContain(cacheRoot);
    const normalizedRoot =
      process.platform === 'win32'
        ? path.win32.normalize(cacheRoot).replace(/\\/g, '/')
        : path.posix.normalize(cacheRoot);
    expect(
      readDirectory.mock.calls.map(([candidate]) => candidate),
    ).not.toContain(normalizedRoot);
    expect(readPluginIndexHealth()).toMatchObject({
      data: { retired: [entry] },
    });
    expect(fs.readFileSync(path.join(copy, 'keep'), 'utf8')).toBe('payload');
  });
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
          beforeInstall: async (temporaryPath) => {
            notePluginCatalogEffects();
            await options?.beforeInstall?.(temporaryPath);
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
      await expect(
        removeInstalledPluginCache('m', 'p'),
      ).resolves.toBeUndefined();
      expect(fs.readFileSync(path.join(payload, 'keep'), 'utf8')).toBe(
        'separately owned',
      );
      const health = readPluginIndexHealth();
      expect(health.state).toBe('valid');
      if (health.state !== 'valid') throw new Error('expected index');
      expect(health.data.entries['m/p']).toBeUndefined();
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
      expect(result.success).toBe(true);
      expect(fs.readFileSync(marker, 'utf8')).toBe('unowned payload');
      const index = readPluginIndexHealth();
      if (index.state !== 'valid')
        throw new Error('expected valid installed index');
      expect(index.data.entries['m/p'].cachePath).not.toBe(previousPayload);
      expect(fs.existsSync(index.data.entries['m/p'].cachePath)).toBe(true);
      expect(index.data.retired ?? []).toEqual([]);
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
