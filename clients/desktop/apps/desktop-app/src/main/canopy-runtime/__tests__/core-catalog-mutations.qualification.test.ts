import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanopyOperationError,
  createCanopyDispatcher,
} from '@canopy/core-runtime';
import {
  CatalogHostRefusedError,
  CatalogMutationRuns,
  createCoreCatalogHandlers,
  type CatalogSourceRecord,
  type CoreCatalogHost,
} from '@canopy/core-runtime/node/catalog';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  CORE_CATALOG_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_QUERY_DEFINITIONS,
  CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SOURCE_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SOURCE_QUERY_DEFINITIONS,
  emptyCatalogSelectionRefs,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { PortalPluginMutationResult } from '@canopy/protocol/portal';
import type {
  MarketplaceInfo,
  MarketplaceProviderStatus,
  PluginInfo,
  PluginsCache,
} from '@canopy/execution-engine/types/plugins';
import { CanopyCloudClientError } from '../../canopy-cloud/client';
import { cloneRepo } from '../../lib/git';
import {
  resetPluginMutationQueueForTests,
  runSerializedPluginMutation,
} from '../../plugins/plugin-mutation-queue';
import { installBuiltInPlugin } from '../../plugins/plugin-service';
import {
  installPortalBuiltInPluginWithOutcomes,
  installPortalExternalPlugin,
} from '../../services/plugin-catalog-service';
import {
  createDesktopCatalogMutationHost,
  type DesktopCatalogMutationDeps,
} from '../core-catalog-mutation-host';

jest.mock('../../lib/git', () => ({ cloneRepo: jest.fn() }));

let cachedMarketplaces: MarketplaceInfo[] = [];
jest.mock('../../plugins/plugin-service', () => ({
  installBuiltInPlugin: jest.fn(),
  loadMarketplaces: jest.fn(),
  loadMarketplacesCacheOnly: jest.fn(() =>
    Promise.resolve({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-11-05T00:00:00.000Z',
        marketplaces: cachedMarketplaces,
      },
    }),
  ),
}));

jest.mock('../../plugins/plugin-handlers', () => ({
  refreshAfterSuccess: <T>(
    _reason: string,
    operation: () => Promise<T>,
  ): Promise<T> => operation(),
  reportCuratedPluginInstallBestEffort: jest.fn(),
}));

function status(provider: 'claude' | 'codex'): MarketplaceProviderStatus {
  return {
    provider,
    state: 'valid',
    accepted: true,
    pluginCount: 1,
    lastCheckedAt: '2026-11-05T00:00:00.000Z',
  };
}

function plugin(name: string, overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name,
    marketplaceId: 'm',
    sourcePath: `/cache/${name}`,
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
    ...overrides,
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
    pluginCount: 1,
    plugins: [],
    providerStatus: { claude: status('claude'), codex: status('codex') },
    validProviders: ['claude', 'codex'],
    ...overrides,
  };
}

const gitSource: CatalogSourceRecord = {
  sourceId: 'gh',
  displayName: 'owner/gh',
  locator: { kind: 'git', repository: 'owner/gh', ref: null },
  providers: ['claude', 'codex'],
  enabled: true,
  revision: 5,
  lastRefresh: { state: 'never' },
};
const builtinSource: CatalogSourceRecord = {
  ...gitSource,
  sourceId: 'builtin-id',
  locator: { kind: 'builtin', builtinId: 'builtin-id' },
};
const otherGitSource: CatalogSourceRecord = {
  ...gitSource,
  sourceId: 'other-gh',
  displayName: 'owner/other',
  locator: { kind: 'git', repository: 'owner/other', ref: null },
};

let listedSources: CatalogSourceRecord[] = [];

function baseHost(): CoreCatalogHost {
  const refused = (): Promise<never> =>
    Promise.reject(new Error('not used here'));
  return {
    snapshot: () =>
      Promise.resolve({ entries: [], refs: emptyCatalogSelectionRefs() }),
    readSelection: refused,
    replaceGlobalSelection: refused,
    replaceWorkspaceSelection: refused,
    listSources: () => Promise.resolve(listedSources),
    addGitSource: refused,
    deleteSource: refused,
    refreshSources: refused,
    findPlugin: refused,
    installPlugin: refused,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let done = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, resolve: () => done() };
}

const row: PortalPluginMutationResult = {
  plugin: {
    name: 'p',
    marketplaceId: 'builtin-id',
    providerSupport: { claude: 'native', codex: 'none' },
    installed: true,
  },
};

const caller: CanopyCallerDescriptor = {
  principalId: 'p',
  clientInstanceId: 'c',
  authorityId: 'a',
  interfaceKind: 'desktop',
  grants: ['core.catalog.write'],
};
const keyed = (key: string): { idempotencyKey: string } => ({
  idempotencyKey: key,
});

let root: string;
let operations: OperationService;

function fakeDeps(): DesktopCatalogMutationDeps & {
  installGate: { promise: Promise<void>; resolve(): void };
} {
  const installGate = deferred();
  installGate.resolve();
  const cache = (): Promise<{ success: true; data: PluginsCache }> =>
    Promise.resolve({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-11-05T00:00:00.000Z',
        marketplaces: cachedMarketplaces,
      },
    });
  const state = {
    installGate,
    service: {
      loadMarketplacesCacheOnly: jest.fn(cache),
      removeMarketplace: jest.fn(() =>
        Promise.resolve({
          success: true as const,
          data: {
            marketplace: null,
            removedProviders: ['claude' as const, 'codex' as const],
            providerOutcomes: {
              claude: { removed: true, alreadyAbsent: false },
              codex: { removed: true, alreadyAbsent: false },
            },
          },
        }),
      ),
      refreshMarketplaces: jest.fn(cache),
      updateMarketplace: jest.fn(() =>
        Promise.resolve({ success: true as const, data: marketplace('gh') }),
      ),
    },
    handlers: {
      refreshAfterSuccess: jest.fn(
        <T>(
          _reason: string,
          operation: () => Promise<{
            success: boolean;
            data?: T;
            error?: string;
          }>,
        ) => operation(),
      ),
    },
    portal: {
      addPortalMarketplace: jest.fn(),
      installPortalBuiltInPluginWithOutcomes: jest.fn(
        (_marketplaceId: string, _pluginName: string, providers: string[]) =>
          runSerializedPluginMutation(async () => {
            await state.installGate.promise;
            return {
              result: row,
              installedProviders: providers,
              failedProviders: [],
            };
          }),
      ),
      installPortalExternalPlugin: jest.fn(),
    },
    cloud: {
      addCloudPluginMarketplace: jest.fn(() =>
        Promise.resolve({
          marketplaceId: 'mkt-1',
          sync: {
            status: 'preview' as const,
            revision: 'a'.repeat(40),
            pluginKeys: ['tool'],
          },
        }),
      ),
      confirmCloudPluginMarketplace: jest.fn(() =>
        Promise.resolve({
          status: 'applied' as const,
          revision: 'a'.repeat(40),
          pluginKeys: ['tool'],
        }),
      ),
    },
    runSerialized: runSerializedPluginMutation,
  };
  return state as unknown as DesktopCatalogMutationDeps & {
    installGate: { promise: Promise<void>; resolve(): void };
  };
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the dispatcher type is inferred from its definitions
function compose(deps: DesktopCatalogMutationDeps) {
  const runs = new CatalogMutationRuns({ operations });
  const handlers = createCoreCatalogHandlers({
    host: createDesktopCatalogMutationHost(baseHost(), deps),
    runs,
  });
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: {
        ...CORE_CATALOG_QUERY_DEFINITIONS,
        ...CORE_CATALOG_SOURCE_QUERY_DEFINITIONS,
      },
      instructions: {
        ...CORE_CATALOG_INSTRUCTION_DEFINITIONS,
        ...CORE_CATALOG_SOURCE_INSTRUCTION_DEFINITIONS,
        ...CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS,
      },
      streams: {},
    },
    handlers: { ...handlers, streams: {} },
  });
}

beforeEach(() => {
  resetPluginMutationQueueForTests();
  listedSources = [gitSource, builtinSource, otherGitSource];
  root = mkdtempSync(join(tmpdir(), 'can-4123-'));
  const path = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(path),
  });
  cachedMarketplaces = [
    marketplace('builtin-id', { builtIn: true, plugins: [plugin('p')] }),
    marketplace('ext', {
      plugins: [
        plugin('x', {
          marketplaceId: 'ext',
          externalSource: { source: 'git', url: 'http://127.0.0.1/x.git' },
        }),
      ],
    }),
  ];
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('desktop catalog mutations (CAN-4123)', () => {
  it('runs catalog mutations one at a time through the plugin mutation queue', async () => {
    const deps = fakeDeps();
    deps.installGate = deferred();
    const dispatcher = compose(deps);

    const install = dispatcher.instruction(
      'core.catalog.plugin.install',
      {
        entryId: 'plugin:builtin-id/p',
        providers: ['claude'],
        _meta: keyed('install'),
      },
      { caller, metadata: keyed('install') },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const removal = dispatcher.instruction(
      'core.catalog.source.delete',
      {
        sourceId: 'gh',
        providers: ['claude', 'codex'],
        expectedRevision: 5,
        _meta: keyed('delete'),
      },
      { caller, metadata: keyed('delete') },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.service.removeMarketplace).not.toHaveBeenCalled();

    deps.installGate.resolve();
    await expect(install).resolves.toEqual({
      entryId: 'plugin:builtin-id/p',
      providers: ['claude'],
      installedProviders: ['claude'],
      failedProviders: [],
    });
    await expect(removal).resolves.toMatchObject({ sourceId: 'gh' });
    expect(deps.service.removeMarketplace).toHaveBeenCalledTimes(1);
  });

  it('publishes a GitHub plugin by adding its source to the cloud and confirming the preview (CAN-6176)', async () => {
    cachedMarketplaces = [
      ...cachedMarketplaces,
      marketplace('gh', { plugins: [plugin('tool', { marketplaceId: 'gh' })] }),
    ];
    const target = {
      entryId: 'plugin:gh/tool',
      marketplaceId: 'gh',
      pluginName: 'tool',
      install: 'managed' as const,
    };
    const deps = fakeDeps();
    const host = createDesktopCatalogMutationHost(baseHost(), deps);
    if (host.publishPlugin === undefined) throw new Error('no publishPlugin');
    const publish = host.publishPlugin.bind(host);

    await expect(publish(target)).resolves.toEqual({
      publicationId: 'mkt-1',
      remoteEntryId: 'plugin:marketplace:mkt-1/tool',
      revision: 'a'.repeat(40),
    });
    expect(deps.cloud.addCloudPluginMarketplace).toHaveBeenCalledWith(
      'owner/gh',
    );
    expect(deps.cloud.confirmCloudPluginMarketplace).toHaveBeenCalledWith(
      'mkt-1',
      'a'.repeat(40),
    );

    // A source the account already applied is adopted without a second confirm.
    jest.mocked(deps.cloud.addCloudPluginMarketplace).mockResolvedValueOnce({
      marketplaceId: 'mkt-1',
      sync: {
        status: 'applied',
        revision: 'b'.repeat(40),
        pluginKeys: ['tool'],
      },
    });
    await expect(publish(target)).resolves.toMatchObject({
      revision: 'b'.repeat(40),
    });
    expect(deps.cloud.confirmCloudPluginMarketplace).toHaveBeenCalledTimes(1);

    const refusal = async (promise: Promise<unknown>): Promise<string> => {
      const error: unknown = await promise.catch((caught: unknown) => caught);
      return error instanceof CatalogHostRefusedError ? error.refusal : 'none';
    };
    await expect(
      refusal(
        publish({
          ...target,
          entryId: 'plugin:builtin-id/p',
          marketplaceId: 'builtin-id',
          pluginName: 'p',
        }),
      ),
    ).resolves.toBe('publish-source-unsupported');
    expect(deps.cloud.addCloudPluginMarketplace).toHaveBeenCalledTimes(2);

    jest
      .mocked(deps.cloud.confirmCloudPluginMarketplace)
      .mockRejectedValueOnce(
        new CanopyCloudClientError('http-error', 'moved', 409),
      );
    await expect(refusal(publish(target))).resolves.toBe(
      'publish-revision-moved',
    );
    jest
      .mocked(deps.cloud.addCloudPluginMarketplace)
      .mockRejectedValueOnce(
        new CanopyCloudClientError('missing-api-key', 'Sign in.'),
      );
    await expect(refusal(publish(target))).resolves.toBe(
      'publish-remote-unavailable',
    );
    jest
      .mocked(deps.cloud.confirmCloudPluginMarketplace)
      .mockResolvedValueOnce({
        status: 'applied',
        revision: 'a'.repeat(40),
        pluginKeys: ['other'],
      });
    await expect(refusal(publish(target))).resolves.toBe('plugin-not-found');
  });

  it('installs once for a repeated key and replays after a lost reply', async () => {
    const deps = fakeDeps();
    const dispatcher = compose(deps);
    const install = (): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.plugin.install',
        {
          entryId: 'plugin:builtin-id/p',
          providers: ['claude'],
          _meta: keyed('k'),
        },
        { caller, metadata: keyed('k') },
      );

    await Promise.all([install(), install()]);
    expect(
      deps.portal.installPortalBuiltInPluginWithOutcomes,
    ).toHaveBeenCalledTimes(1);
    await install();
    expect(
      deps.portal.installPortalBuiltInPluginWithOutcomes,
    ).toHaveBeenCalledTimes(1);
  });

  it('reports the provider that failed in a two-provider install', async () => {
    jest.mocked(installBuiltInPlugin).mockResolvedValueOnce({
      success: true,
      data: {
        plugin: plugin('p', { marketplaceId: 'builtin-id' }),
        providerOutcomes: {
          claude: { installed: true },
          codex: { installed: false, error: 'Codex said no.' },
        },
      },
    });
    const deps = fakeDeps();
    deps.portal.installPortalBuiltInPluginWithOutcomes =
      installPortalBuiltInPluginWithOutcomes;
    const dispatcher = compose(deps);

    await expect(
      dispatcher.instruction(
        'core.catalog.plugin.install',
        {
          entryId: 'plugin:builtin-id/p',
          providers: ['claude', 'codex'],
          _meta: keyed('both'),
        },
        { caller, metadata: keyed('both') },
      ),
    ).resolves.toEqual({
      entryId: 'plugin:builtin-id/p',
      providers: ['claude', 'codex'],
      installedProviders: ['claude'],
      failedProviders: ['codex'],
    });
    expect(installBuiltInPlugin).toHaveBeenCalledWith({
      marketplaceId: 'builtin-id',
      pluginName: 'p',
      providers: ['claude', 'codex'],
    });
  });

  it('refuses an external plugin whose source is not a public https URL before cloning', async () => {
    const deps = fakeDeps();
    deps.portal.installPortalExternalPlugin = installPortalExternalPlugin;
    const dispatcher = compose(deps);

    await expect(
      dispatcher.instruction(
        'core.catalog.plugin.install',
        { entryId: 'plugin:ext/x', providers: ['claude'], _meta: keyed('k') },
        { caller, metadata: keyed('k') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.catalog.pluginSourceRejected',
      },
    });
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it("keeps the provider's message for local callers only", async () => {
    const deps = fakeDeps();
    deps.service.removeMarketplace = jest.fn(() =>
      Promise.resolve({
        success: false as const,
        error: 'claude: provider said no',
      }),
    );
    const dispatcher = compose(deps);

    const error = await dispatcher
      .instruction(
        'core.catalog.source.delete',
        {
          sourceId: 'gh',
          providers: ['claude', 'codex'],
          expectedRevision: 5,
          _meta: keyed('k'),
        },
        { caller, metadata: keyed('k') },
      )
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CanopyOperationError);
    if (!(error instanceof CanopyOperationError)) return;
    expect(error.payload).toMatchObject({
      kind: 'unavailable',
      message: 'A provider could not remove this source.',
    });
    expect(error.runtimeCause).toMatchObject({
      code: 'execution_failed',
      message: 'claude: provider said no',
    });
  });

  it('refuses to delete a built-in source and a stale revision', async () => {
    const deps = fakeDeps();
    const dispatcher = compose(deps);

    await expect(
      dispatcher.instruction(
        'core.catalog.source.delete',
        {
          sourceId: 'builtin-id',
          providers: ['claude', 'codex'],
          expectedRevision: 5,
          _meta: keyed('k1'),
        },
        { caller, metadata: keyed('k1') },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.catalog.sourceBuiltin' },
    });
    await expect(
      dispatcher.instruction(
        'core.catalog.source.delete',
        {
          sourceId: 'gh',
          providers: ['claude', 'codex'],
          expectedRevision: 4,
          _meta: keyed('k2'),
        },
        { caller, metadata: keyed('k2') },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.catalog.sourceConflict' },
    });
    expect(deps.service.removeMarketplace).not.toHaveBeenCalled();
  });

  it('adds a GitHub source through core.catalog.source.upsert and refuses a pinned ref', async () => {
    const deps = fakeDeps();
    deps.portal.addPortalMarketplace = jest.fn(() =>
      Promise.resolve({ marketplace: { id: 'gh' } }),
    ) as unknown as DesktopCatalogMutationDeps['portal']['addPortalMarketplace'];
    const dispatcher = compose(deps);
    const params = {
      sourceId: null,
      displayName: 'owner/gh',
      locator: { kind: 'git' as const, repository: 'owner/gh', ref: null },
      providers: ['claude' as const, 'codex' as const],
      enabled: true,
      expectedRevision: null,
    };

    await expect(
      dispatcher.instruction(
        'core.catalog.source.upsert',
        { ...params, _meta: keyed('k1') },
        { caller, metadata: keyed('k1') },
      ),
    ).resolves.toEqual(gitSource);
    expect(deps.portal.addPortalMarketplace).toHaveBeenCalledWith('owner/gh');
    await expect(
      dispatcher.instruction(
        'core.catalog.source.upsert',
        {
          ...params,
          locator: { kind: 'git', repository: 'owner/gh', ref: 'main' },
          _meta: keyed('k2'),
        },
        { caller, metadata: keyed('k2') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
  });

  it('scans the built-in sources of a partial refresh and fails a refresh that refreshed nothing, including one every provider rejected', async () => {
    const deps = fakeDeps();
    const dispatcher = compose(deps);
    const refresh = (
      sourceIds: string[],
      mode: 'scan' | 'update_then_scan',
      key: string,
    ): Promise<{ operationId: string }> =>
      dispatcher.instruction(
        'core.catalog.source.refresh',
        { sourceIds, providers: ['claude', 'codex'], mode, _meta: keyed(key) },
        { caller, metadata: keyed(key) },
      );

    const mixed = await refresh(['gh', 'builtin-id'], 'update_then_scan', 'm');
    const done = await operations.waitForTerminal(mixed.operationId);
    expect(deps.service.updateMarketplace).toHaveBeenCalledWith('gh');
    expect(deps.service.refreshMarketplaces).toHaveBeenCalledWith(undefined, {
      providerUpdates: 'if-stale',
    });
    expect(done.status).toBe('completed');
    expect(done.outcome).toEqual({
      refreshed: ['gh', 'builtin-id'],
      failed: [],
    });

    jest
      .mocked(deps.service.refreshMarketplaces)
      .mockResolvedValueOnce({ success: false, error: 'offline' });
    const scan = await refresh(['builtin-id'], 'scan', 's');
    const failed = await operations.waitForTerminal(scan.operationId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({
      kind: 'unavailable',
      code: 'core.catalog.refreshUnavailable',
    });

    jest.mocked(deps.service.updateMarketplace).mockResolvedValueOnce({
      success: true,
      data: marketplace('gh', { validProviders: [] }),
    });
    const rejected = await refresh(['gh'], 'update_then_scan', 'r');
    const unrefreshed = await operations.waitForTerminal(rejected.operationId);
    expect(unrefreshed.status).toBe('failed');
    expect(unrefreshed.error).toMatchObject({
      code: 'core.catalog.refreshUnavailable',
    });
  });

  it('never updates a source deleted while its refresh waited in the queue', async () => {
    const deps = fakeDeps();
    const firstUpdate = deferred();
    let updating = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      updating = resolve;
    });
    jest
      .mocked(deps.service.updateMarketplace)
      .mockImplementationOnce(async (id) => {
        updating();
        await firstUpdate.promise;
        return { success: true, data: marketplace(id) };
      });
    const dispatcher = compose(deps);
    const ack = await dispatcher.instruction(
      'core.catalog.source.refresh',
      {
        sourceIds: ['gh', 'other-gh'],
        providers: ['claude', 'codex'],
        mode: 'update_then_scan',
        _meta: keyed('partial'),
      },
      { caller, metadata: keyed('partial') },
    );
    await started;
    const deletion = runSerializedPluginMutation(() => {
      listedSources = [gitSource, builtinSource];
      return Promise.resolve();
    });
    firstUpdate.resolve();
    await deletion;
    const done = await operations.waitForTerminal(ack.operationId);

    expect(deps.service.updateMarketplace).toHaveBeenCalledTimes(1);
    expect(deps.service.updateMarketplace).toHaveBeenCalledWith('gh');
    expect(done.outcome).toEqual({ refreshed: ['gh'], failed: ['other-gh'] });
  });

  it('finds a plugin that a queued marketplace change registers before installing it', async () => {
    const deps = fakeDeps();
    const dispatcher = compose(deps);
    const addition = deferred();
    const queuedAdd = runSerializedPluginMutation(async () => {
      await addition.promise;
      cachedMarketplaces = [
        marketplace('builtin-id', {
          builtIn: true,
          plugins: [plugin('p'), plugin('q')],
        }),
      ];
    });
    const install = dispatcher.instruction(
      'core.catalog.plugin.install',
      {
        entryId: 'plugin:builtin-id/q',
        providers: ['claude'],
        _meta: keyed('after-add'),
      },
      { caller, metadata: keyed('after-add') },
    );
    install.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    addition.resolve();
    await queuedAdd;

    await expect(install).resolves.toEqual({
      entryId: 'plugin:builtin-id/q',
      providers: ['claude'],
      installedProviders: ['claude'],
      failedProviders: [],
    });
  });

  it('lets identical installs reach the Portal install together while one is running', async () => {
    const deps = fakeDeps();
    deps.installGate = deferred();
    const dispatcher = compose(deps);
    const install = (key: string): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.plugin.install',
        {
          entryId: 'plugin:builtin-id/p',
          providers: ['claude'],
          _meta: keyed(key),
        },
        { caller, metadata: keyed(key) },
      );
    const first = install('one');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = install('two');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      deps.portal.installPortalBuiltInPluginWithOutcomes,
    ).toHaveBeenCalledTimes(2);
    deps.installGate.resolve();
    await Promise.all([first, second]);
  });

  it('installs a plugin named with different case under its cached name', async () => {
    const deps = fakeDeps();
    const dispatcher = compose(deps);

    await expect(
      dispatcher.instruction(
        'core.catalog.plugin.install',
        {
          entryId: 'plugin:builtin-id/P',
          providers: ['claude'],
          _meta: keyed('case'),
        },
        { caller, metadata: keyed('case') },
      ),
    ).resolves.toEqual({
      entryId: 'plugin:builtin-id/P',
      providers: ['claude'],
      installedProviders: ['claude'],
      failedProviders: [],
    });
    expect(
      deps.portal.installPortalBuiltInPluginWithOutcomes,
    ).toHaveBeenCalledWith('builtin-id', 'p', ['claude']);
  });
});
