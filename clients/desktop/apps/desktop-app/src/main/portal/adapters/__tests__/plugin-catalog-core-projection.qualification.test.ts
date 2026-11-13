import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
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
} from '@canopy/protocol/canopy-core';
import type {
  PortalCommandEnvelope,
  PortalPluginMutationResult,
  PortalPluginsInstallBuiltinPayload,
  PortalPluginsInstallExternalPayload,
} from '@canopy/protocol/portal';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import type { MarketplaceInfo } from '@canopy/execution-engine/types/plugins';
import {
  resetPluginMutationQueueForTests,
  runSerializedPluginMutation,
} from '../../../plugins/plugin-mutation-queue';
import {
  createDesktopCatalogMutationHost,
  type DesktopCatalogMutationDeps,
} from '../../../canopy-runtime/core-catalog-mutation-host';
import {
  handlePortalMarketplaceRefreshAll,
  handlePortalMarketplaceRemove,
  handlePortalPluginsInstallExternal,
  handlePortalPluginsInstallBuiltin,
} from '../plugin-catalog-adapter';
import type { PortalPluginInstallOutcome } from '../../../services/plugin-catalog-service';
import type { PortalAdapterContext } from '../types';

const row: PortalPluginMutationResult = {
  plugin: {
    name: 'p',
    marketplaceId: 'builtin/app',
    providerSupport: { claude: 'native', codex: 'none' },
    installed: true,
  },
};

type TestDispatcher = ReturnType<typeof compose>;
let dispatcher: TestDispatcher | null = null;

function activeDispatcher(): TestDispatcher {
  if (!dispatcher) throw new Error('No dispatcher');
  return dispatcher;
}

jest.mock(
  '../../../canopy-runtime/desktop-runtime-access',
  (): {
    getDesktopCanopyRuntime: () => Pick<
      TestDispatcher,
      'instruction' | 'query'
    >;
  } => ({
    getDesktopCanopyRuntime: () => activeDispatcher(),
  }),
);
jest.mock(
  '../../portal-session-manager',
  (): { getCanopyPortalState: () => { sessionId: string } } => ({
    getCanopyPortalState: () => ({ sessionId: 'session' }),
  }),
);
const readPortalPluginMutationResult = jest.fn(() => Promise.resolve(row));
const removePortalMarketplace = jest.fn(
  (): Promise<unknown> => Promise.resolve({ removed: true }),
);
const legacyExternalInstall = jest.fn(
  (): Promise<unknown> =>
    Promise.reject(
      Object.assign(
        new Error('Plugin "p" has no external source to install from.'),
        { code: 'invalid_payload' },
      ),
    ),
);
const startPortalMarketplacesRefresh = jest.fn(
  (): Promise<void> => Promise.resolve(),
);
jest.mock(
  '../../../services/plugin-catalog-service',
  (): {
    readPortalPluginMutationResult: () => Promise<PortalPluginMutationResult>;
    removePortalMarketplace: () => Promise<unknown>;
    installPortalExternalPlugin: () => Promise<unknown>;
    startPortalMarketplacesRefresh: () => Promise<void>;
  } => ({
    readPortalPluginMutationResult: () => readPortalPluginMutationResult(),
    removePortalMarketplace: () => removePortalMarketplace(),
    installPortalExternalPlugin: () => legacyExternalInstall(),
    startPortalMarketplacesRefresh: () => startPortalMarketplacesRefresh(),
  }),
);

let sources: CatalogSourceRecord[] = [];
const builtin: MarketplaceInfo = {
  id: 'builtin/app',
  name: 'Built-in',
  sourceType: 'builtin',
  sourceUrl: '',
  builtIn: true,
  installLocation: '/cache',
  pluginCount: 1,
  plugins: [
    {
      name: 'p',
      marketplaceId: 'builtin/app',
      sourcePath: '/cache/p',
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {},
    },
  ],
  providerStatus: {
    claude: {
      provider: 'claude',
      state: 'valid',
      accepted: true,
      pluginCount: 1,
      lastCheckedAt: '2026-11-05T00:00:00.000Z',
    },
    codex: {
      provider: 'codex',
      state: 'valid',
      accepted: true,
      pluginCount: 1,
      lastCheckedAt: '2026-11-05T00:00:00.000Z',
    },
  },
  validProviders: ['claude', 'codex'],
};

const external: MarketplaceInfo = {
  ...builtin,
  id: 'ext',
  name: 'External',
  sourceType: 'github',
  sourceUrl: 'https://github.com/owner/ext',
  builtIn: false,
  plugins: [
    {
      name: 'local-only',
      marketplaceId: 'ext',
      sourcePath: '/cache/local-only',
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {},
    },
  ],
};

let cachedRows: MarketplaceInfo[] = [];

function baseHost(): CoreCatalogHost {
  const refused = (): Promise<never> =>
    Promise.reject(new Error('not used here'));
  return {
    snapshot: () =>
      Promise.resolve({ entries: [], refs: emptyCatalogSelectionRefs() }),
    readSelection: refused,
    replaceGlobalSelection: refused,
    replaceWorkspaceSelection: refused,
    listSources: () => Promise.resolve(sources),
    addGitSource: refused,
    deleteSource: refused,
    refreshSources: refused,
    findPlugin: refused,
    installPlugin: refused,
  };
}

const installPortalBuiltInPlugin = jest.fn(
  (): Promise<PortalPluginInstallOutcome> =>
    runSerializedPluginMutation(() =>
      Promise.resolve({
        result: row,
        installedProviders: ['claude'],
        failedProviders: [],
      }),
    ),
);
const removed = {
  success: true as const,
  data: {
    marketplace: null,
    removedProviders: ['claude' as const],
    providerOutcomes: {
      claude: { removed: true, alreadyAbsent: false },
      codex: { removed: false, alreadyAbsent: false },
    },
  },
};
const removeMarketplace = jest.fn(() => Promise.resolve(removed));
const refreshMarketplaces = jest.fn(() =>
  Promise.resolve({
    success: true as const,
    data: {
      version: 2 as const,
      lastRefreshed: '2026-11-05T00:00:00.000Z',
      marketplaces: cachedRows,
    },
  }),
);
const gitSource: CatalogSourceRecord = {
  sourceId: 'owner/gh',
  displayName: 'owner/gh',
  locator: { kind: 'git', repository: 'owner/gh', ref: null },
  providers: ['claude', 'codex'],
  enabled: true,
  revision: 1,
  lastRefresh: { state: 'never' },
};

function deps(): Partial<DesktopCatalogMutationDeps> {
  return {
    service: {
      loadMarketplacesCacheOnly: () =>
        Promise.resolve({
          success: true,
          data: {
            version: 2,
            lastRefreshed: '2026-11-05T00:00:00.000Z',
            marketplaces: cachedRows,
          },
        }),
      removeMarketplace,
      refreshMarketplaces,
      updateMarketplace: jest.fn(),
    },
    handlers: {
      refreshAfterSuccess: <T>(
        _reason: string,
        operation: () => Promise<IPCResult<T>> | IPCResult<T>,
      ): Promise<IPCResult<T>> => Promise.resolve(operation()),
    },
    portal: {
      addPortalMarketplace: jest.fn(),
      installPortalBuiltInPluginWithOutcomes: installPortalBuiltInPlugin,
      installPortalExternalPlugin: jest.fn(),
    },
    runSerialized: runSerializedPluginMutation,
  };
}

let root: string;
let operations: OperationService;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the dispatcher type is inferred from its definitions
function compose() {
  const runs = new CatalogMutationRuns({ operations });
  const handlers = createCoreCatalogHandlers({
    host: createDesktopCatalogMutationHost(baseHost(), deps()),
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

interface Recorded {
  completed: unknown[];
  failed: { code: string; message: string }[];
}

function context(recorded: Recorded): PortalAdapterContext {
  return {
    getWindow: () => null,
    enqueueEvent: () => undefined,
    complete: (_command, result) => {
      recorded.completed.push(result);
    },
    fail: (_command, code, message) => {
      recorded.failed.push({ code, message });
    },
  };
}

function envelope<T>(
  type: PortalCommandEnvelope['type'],
  payload: T,
): PortalCommandEnvelope<T> {
  return {
    id: 'command-1',
    sequence: 1,
    type,
    payload,
    createdAt: '2026-11-06T00:00:00.000Z',
    expiresAt: null,
  };
}

async function settled(recorded: Recorded, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (recorded.completed.length + recorded.failed.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The command did not settle.');
}

beforeEach(() => {
  resetPluginMutationQueueForTests();
  installPortalBuiltInPlugin.mockClear();
  removeMarketplace.mockReset();
  removeMarketplace.mockImplementation(() => Promise.resolve(removed));
  refreshMarketplaces.mockClear();
  startPortalMarketplacesRefresh.mockClear();
  removePortalMarketplace.mockClear();
  legacyExternalInstall.mockClear();
  sources = [];
  cachedRows = [builtin, external];
  root = mkdtempSync(join(tmpdir(), 'can-4123-'));
  const path = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(path),
  });
  dispatcher = compose();
});
afterEach(() => {
  dispatcher = null;
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

const installCommand = envelope<PortalPluginsInstallBuiltinPayload>(
  'portal.plugins.install_builtin',
  {
    projectId: 'project',
    marketplaceId: 'builtin/app',
    pluginName: 'p',
    providers: ['claude'],
  },
);

describe('Portal catalog commands through core (CAN-4123)', () => {
  it('a redelivered Portal command installs once', async () => {
    const recorded: Recorded = { completed: [], failed: [] };
    handlePortalPluginsInstallBuiltin(installCommand, context(recorded));
    await settled(recorded, 1);
    handlePortalPluginsInstallBuiltin(installCommand, context(recorded));
    await settled(recorded, 2);

    expect(recorded.failed).toEqual([]);
    expect(installPortalBuiltInPlugin).toHaveBeenCalledTimes(1);
    expect(recorded.completed).toEqual([row, row]);
  });

  it("keeps today's Portal failure code and message", async () => {
    installPortalBuiltInPlugin.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error('Provider said no.'), {
          code: 'execution_failed',
        }),
      ),
    );
    const recorded: Recorded = { completed: [], failed: [] };
    handlePortalPluginsInstallBuiltin(installCommand, context(recorded));
    await settled(recorded, 1);

    expect(recorded.failed).toEqual([
      { code: 'execution_failed', message: 'Provider said no.' },
    ]);
  });

  it('removes an unlisted cached marketplace once through the keyed delete and answers an absent one as already absent', async () => {
    removeMarketplace.mockImplementationOnce(() => {
      cachedRows = [builtin];
      return Promise.resolve(removed);
    });
    const command = envelope('portal.marketplace.remove', {
      projectId: 'project',
      marketplaceId: 'ext',
    });
    const recorded: Recorded = { completed: [], failed: [] };
    handlePortalMarketplaceRemove(command, context(recorded));
    await settled(recorded, 1);
    handlePortalMarketplaceRemove(command, context(recorded));
    await settled(recorded, 2);
    handlePortalMarketplaceRemove(
      {
        ...envelope('portal.marketplace.remove', {
          projectId: 'project',
          marketplaceId: 'gone',
        }),
        id: 'command-2',
      },
      context(recorded),
    );
    await settled(recorded, 3);

    expect(recorded.failed).toEqual([]);
    expect(recorded.completed).toEqual([
      { removed: true },
      { removed: true },
      { removed: true, alreadyAbsent: true },
    ]);
    expect(removeMarketplace).toHaveBeenCalledTimes(1);
    expect(removePortalMarketplace).not.toHaveBeenCalled();
  });

  it('a redelivered refresh-all replays after a marketplace was added', async () => {
    sources = [gitSource];
    const command = envelope('portal.marketplace.refresh_all', {
      projectId: 'project',
    });
    const recorded: Recorded = { completed: [], failed: [] };
    await handlePortalMarketplaceRefreshAll(command, context(recorded));
    await runSerializedPluginMutation(() => Promise.resolve());
    sources = [gitSource, { ...gitSource, sourceId: 'owner/added' }];
    await handlePortalMarketplaceRefreshAll(command, context(recorded));
    await runSerializedPluginMutation(() => Promise.resolve());

    expect(recorded.failed).toEqual([]);
    expect(recorded.completed).toEqual([{ started: true }, { started: true }]);
    expect(refreshMarketplaces).toHaveBeenCalledTimes(1);
    expect(refreshMarketplaces).toHaveBeenCalledWith(undefined, {
      providerUpdates: 'always',
    });
    expect(startPortalMarketplacesRefresh).not.toHaveBeenCalled();

    sources = Array.from({ length: 101 }, (_, index) => ({
      ...gitSource,
      sourceId: `owner/repo-${index}`,
    }));
    await handlePortalMarketplaceRefreshAll(
      { ...command, id: 'command-2' },
      context(recorded),
    );

    expect(recorded.failed).toEqual([]);
    expect(recorded.completed).toHaveLength(3);
    expect(startPortalMarketplacesRefresh).toHaveBeenCalledTimes(1);
    expect(refreshMarketplaces).toHaveBeenCalledTimes(1);
  });

  it('a redelivered removal replays instead of removing a re-added marketplace', async () => {
    sources = [gitSource];
    removeMarketplace.mockImplementationOnce(() => {
      sources = [];
      return Promise.resolve(removed);
    });
    const command = envelope('portal.marketplace.remove', {
      projectId: 'project',
      marketplaceId: 'owner/gh',
    });
    const recorded: Recorded = { completed: [], failed: [] };
    handlePortalMarketplaceRemove(command, context(recorded));
    await settled(recorded, 1);

    let release = (): void => undefined;
    const readd = runSerializedPluginMutation(
      () =>
        new Promise<void>((resolve) => {
          release = (): void => {
            sources = [gitSource];
            resolve();
          };
        }),
    );
    handlePortalMarketplaceRemove(command, context(recorded));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await readd;
    await settled(recorded, 2);

    expect(recorded.completed).toEqual([{ removed: true }, { removed: true }]);
    expect(removeMarketplace).toHaveBeenCalledTimes(1);
    expect(removePortalMarketplace).not.toHaveBeenCalled();
    expect(sources).toEqual([gitSource]);
  });

  it('removes a marketplace queued behind a change to it', async () => {
    sources = [gitSource];
    let release = (): void => undefined;
    const refresh = runSerializedPluginMutation(
      () =>
        new Promise<void>((resolve) => {
          release = (): void => {
            sources = [{ ...gitSource, revision: 2 }];
            resolve();
          };
        }),
    );
    const recorded: Recorded = { completed: [], failed: [] };
    handlePortalMarketplaceRemove(
      envelope('portal.marketplace.remove', {
        projectId: 'project',
        marketplaceId: 'owner/gh',
      }),
      context(recorded),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(removeMarketplace).not.toHaveBeenCalled();
    release();
    await refresh;
    await settled(recorded, 1);

    expect(recorded.failed).toEqual([]);
    expect(recorded.completed).toEqual([{ removed: true }]);
    expect(removeMarketplace).toHaveBeenCalledTimes(1);
  });

  it('a redelivered provider-specific removal replays its result', async () => {
    sources = [gitSource];
    removeMarketplace.mockImplementationOnce(() => {
      sources = [{ ...gitSource, providers: ['codex'], revision: 2 }];
      return Promise.resolve(removed);
    });
    const command = envelope('portal.marketplace.remove', {
      projectId: 'project',
      marketplaceId: 'owner/gh',
      providers: ['claude' as const],
    });
    const recorded: Recorded = { completed: [], failed: [] };
    handlePortalMarketplaceRemove(command, context(recorded));
    await settled(recorded, 1);
    handlePortalMarketplaceRemove(command, context(recorded));
    await settled(recorded, 2);

    expect(recorded.failed).toEqual([]);
    expect(recorded.completed).toEqual([{ removed: true }, { removed: true }]);
    expect(removeMarketplace).toHaveBeenCalledTimes(1);
  });

  it("keeps today's Portal install refusals for plugins the core cannot install", async () => {
    const recorded: Recorded = { completed: [], failed: [] };
    const externalInstall = (
      pluginName: string,
      id: string,
    ): PortalCommandEnvelope<PortalPluginsInstallExternalPayload> => ({
      ...envelope<PortalPluginsInstallExternalPayload>(
        'portal.plugins.install_external',
        { projectId: 'project', marketplaceId: 'ext', pluginName },
      ),
      id,
    });
    const builtinInstall = (
      marketplaceId: string,
      pluginName: string,
      id: string,
    ): PortalCommandEnvelope<PortalPluginsInstallBuiltinPayload> => ({
      ...envelope<PortalPluginsInstallBuiltinPayload>(
        'portal.plugins.install_builtin',
        {
          projectId: 'project',
          marketplaceId,
          pluginName,
          providers: ['claude'],
        },
      ),
      id,
    });
    handlePortalPluginsInstallExternal(
      externalInstall('local-only', 'c1'),
      context(recorded),
    );
    handlePortalPluginsInstallExternal(
      externalInstall('ghost', 'c2'),
      context(recorded),
    );
    handlePortalPluginsInstallBuiltin(
      builtinInstall('builtin/app', 'ghost', 'c3'),
      context(recorded),
    );
    handlePortalPluginsInstallBuiltin(
      builtinInstall('ext', 'local-only', 'c4'),
      context(recorded),
    );
    await settled(recorded, 4);

    expect(recorded.completed).toEqual([]);
    expect(recorded.failed).toEqual(
      expect.arrayContaining([
        {
          code: 'invalid_payload',
          message:
            'Plugin "local-only" has no external source to install from.',
        },
        {
          code: 'not_found',
          message: 'Plugin "ghost" not found in marketplace "ext".',
        },
        {
          code: 'execution_failed',
          message: 'Plugin not found in the marketplace.',
        },
        {
          code: 'execution_failed',
          message:
            'Built-in plugin installs require the built-in or curated marketplace.',
        },
      ]),
    );
    expect(installPortalBuiltInPlugin).not.toHaveBeenCalled();
  });

  it('installs an external plugin from a built-in marketplace through the Portal install', async () => {
    const recorded: Recorded = { completed: [], failed: [] };
    handlePortalPluginsInstallExternal(
      envelope<PortalPluginsInstallExternalPayload>(
        'portal.plugins.install_external',
        { projectId: 'project', marketplaceId: 'builtin/app', pluginName: 'p' },
      ),
      context(recorded),
    );
    await settled(recorded, 1);

    expect(recorded.failed).toEqual([
      {
        code: 'invalid_payload',
        message: 'Plugin "p" has no external source to install from.',
      },
    ]);
    expect(legacyExternalInstall).toHaveBeenCalledTimes(1);
    expect(installPortalBuiltInPlugin).not.toHaveBeenCalled();
  });
});
