// CAN-4121 PR3: the async `model-registry:get` handler answers through
// `worker.agent.provider.list` on a real desktop runtime and returns the
// registry snapshot the in-process worker built, unchanged. The synchronous
// bootstrap listener keeps the direct snapshot.
import type * as AgentCatalogCompatibility from '../remote-projection/agent-catalog-compatibility';
import {
  IPC_CHANNELS,
  type ModelRegistrySnapshot,
} from '@canopy/desktop-shared/types';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { canopyPermissionDeniedError } from '@canopy/core-runtime';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { createWorkerAgentAdapter } from '../canopy-runtime/worker-agent-adapter';
import {
  createDesktopProviderHost,
  type DesktopProviderSources,
} from '../agent-providers/desktop-provider-host';
import { registerModelRegistryHandlers } from '../ipc/ollama';

jest.mock('node-pty', () => {
  throw new Error('Model registry tests must not load native node-pty');
});
jest.mock('../terminal/worker-terminal', () => ({}));

const mockHandlers = new Map<
  string,
  (
    event: unknown,
    request?: { probe?: boolean; recheck?: boolean },
  ) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (
      event: unknown,
      request?: { probe?: boolean; recheck?: boolean },
    ) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

const mockListeners = new Map<
  string,
  (event: { returnValue?: unknown }) => void
>();
jest.mock('electron', () => ({
  ipcMain: {
    on: (
      channel: string,
      listener: (event: { returnValue?: unknown }) => void,
    ): void => {
      mockListeners.set(channel, listener);
    },
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
}));

const order: string[] = [];
const fixture: ModelRegistrySnapshot = {
  claude: [{ id: 'claude-opus', label: 'Opus' }],
  codex: [{ id: 'gpt-codex', label: 'Codex' }],
  ollama: [{ id: 'ollama:llama3', rawModelId: 'llama3', label: 'Llama 3' }],
  cursor: [{ id: 'cursor-auto', rawModelId: 'auto', label: 'Auto' }],
  copilot: [
    {
      id: 'copilot-gpt',
      rawModelId: 'gpt',
      label: 'GPT',
      supportsVision: false,
      supportedThinkingLevels: [],
    },
  ],
  opencode: [
    {
      id: 'opencode-sonnet',
      rawModelId: 'sonnet',
      label: 'Sonnet',
      supportsVision: false,
      supportedThinkingLevels: [],
    },
  ],
  agents: [
    {
      id: 'agent:helper',
      name: 'Helper',
      baseModel: 'claude-opus',
      instructions: 'Be brief.',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
      available: true,
    },
  ],
  aliases: { opus: 'claude-opus' },
  gatewayRoutes: [],
  aiGatewayCatalogStatus: 'ready',
};
const syncFixture: ModelRegistrySnapshot = { ...fixture, aliases: {} };

const mockBuild = jest.fn((): ModelRegistrySnapshot => {
  order.push('build');
  return fixture;
});
jest.mock('../models/model-registry', () => ({
  buildModelRegistrySnapshot: (): ModelRegistrySnapshot => mockBuild(),
  getSynchronousModelRegistrySnapshot: (): ModelRegistrySnapshot => syncFixture,
  setModelRegistryBroadcastHandler: (): void => undefined,
  broadcastModelRegistryUpdated: (): void => undefined,
}));
const mockRemoteControlCatalogChanged = jest.fn(() => Promise.resolve());
jest.mock('../remote-projection/agent-catalog-compatibility', () => ({
  ...jest.requireActual<typeof AgentCatalogCompatibility>(
    '../remote-projection/agent-catalog-compatibility',
  ),
  notifyModelCatalogChanged: (): Promise<void> =>
    mockRemoteControlCatalogChanged(),
}));
const mockFactsRefresh = jest.fn<Promise<boolean>, [{ fresh?: boolean }?]>(
  async (): Promise<boolean> => {
    await Promise.resolve();
    order.push('facts');
    return false;
  },
);
const mockPublish = jest.fn((): void => {
  order.push('publish');
});
let mockSetupWatched = true;
jest.mock('../remote-projection/provider-setup-status', () => ({
  isProviderSetupWatched: (): boolean => mockSetupWatched,
  refreshProviderSetupFacts: (options?: {
    fresh?: boolean;
  }): Promise<boolean> => mockFactsRefresh(options),
  publishProviderSetupProjections: (): void => mockPublish(),
}));
const mockRefresh = jest.fn(async (): Promise<void> => {
  await Promise.resolve();
  order.push('refresh');
});
jest.mock('../lib/agent-models', () => ({
  refreshAgentModelsFromStore: (): Promise<void> => mockRefresh(),
}));
let resourceContext = false;
jest.mock('../agents/resource-lanes', () => ({
  agentResourceContextEnabled: (): boolean => resourceContext,
}));

const trustedCaller: CanopyCallerDescriptor = {
  principalId: 'desktop-ipc',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

let runtime: DesktopCanopyDispatcher;
let list: jest.Mock;

function fakeSources(): DesktopProviderSources {
  return {
    buildRegistry: (): ModelRegistrySnapshot => mockBuild(),
    supported: () => ({
      claude: true,
      codex: true,
      ollama: true,
      cursor: true,
      copilot: true,
      antigravity: true,
      opencode: true,
    }),
    platformSupported: () => ({
      claude: true,
      codex: true,
      ollama: true,
      cursor: true,
      copilot: true,
      antigravity: true,
      opencode: true,
    }),
    readAuthState: () => Promise.resolve('ready'),
    readUsage: () =>
      Promise.resolve({ updatedAt: '2026-11-06T00:00:00.000Z', providers: [] }),
    resolveOwner: () => Promise.resolve(undefined),
    refreshPolicy: () => Promise.resolve(),
    isBlocked: () => false,
    now: () => new Date('2026-11-06T00:00:00.000Z'),
  };
}

function register(resolveCaller: () => CanopyCallerDescriptor): void {
  const host = createDesktopProviderHost(fakeSources());
  list = jest.fn(
    (...args: Parameters<typeof host.list>): ReturnType<typeof host.list> =>
      host.list(...args),
  );
  runtime = createDesktopRuntime({
    shutdownTimeoutMs: 25,
    workerAgentAdapter: createWorkerAgentAdapter({
      providerHost: { ...host, list },
      sinkFor: () => null,
    }),
  });
  registerModelRegistryHandlers(() => null, {
    dispatcher: runtime,
    resolveCaller,
  });
}

function asyncHandler(): (
  event: unknown,
  request?: { probe?: boolean; recheck?: boolean },
) => Promise<unknown> {
  const handler = mockHandlers.get(IPC_CHANNELS.modelRegistryGet);
  if (!handler) throw new Error('model-registry:get handler not registered');
  return handler;
}

beforeEach(() => {
  mockHandlers.clear();
  mockListeners.clear();
  mockBuild.mockClear();
  mockRefresh.mockClear();
  mockFactsRefresh.mockClear();
  mockPublish.mockClear();
  mockSetupWatched = true;
  order.length = 0;
  resourceContext = false;
});
afterEach(async () => {
  await runtime.shutdown();
});

it('model-registry:get returns the registry snapshot unchanged through worker.agent.provider.list', async () => {
  register(() => trustedCaller);
  await expect(asyncHandler()({ sender: {} })).resolves.toBe(fixture);
  expect(list).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenCalledWith(
    { scope: {}, probe: false },
    expect.anything(),
  );
});

it('the agent-model refresh still runs before the build', async () => {
  resourceContext = true;
  register(() => trustedCaller);
  await asyncHandler()({ sender: {} });
  expect(order).toEqual(['refresh', 'build']);
});

it('a registry build failure rejects with the same error', async () => {
  const boom = new Error('registry broke');
  mockBuild.mockImplementationOnce(() => {
    throw boom;
  });
  register(() => trustedCaller);
  await expect(asyncHandler()({ sender: {} })).rejects.toBe(boom);
});

it('an untracked sender is refused before the registry is built', async () => {
  const refusal = canopyPermissionDeniedError('Untrusted desktop IPC sender.');
  register(() => {
    throw refusal;
  });
  await expect(asyncHandler()({ sender: {} })).rejects.toBe(refusal);
  expect(mockBuild).not.toHaveBeenCalled();
});

it('the synchronous bootstrap listener still answers directly', () => {
  register(() => trustedCaller);
  const listener = mockListeners.get(IPC_CHANNELS.modelRegistryGet);
  if (!listener) throw new Error('model-registry:get listener not registered');
  const event: { returnValue?: unknown } = {};
  listener(event);
  expect(event.returnValue).toBe(syncFixture);
  expect(list).not.toHaveBeenCalled();
});

it('explicit model refresh probes through worker.agent.provider.list', async () => {
  register(() => trustedCaller);
  await expect(asyncHandler()({ sender: {} }, { probe: true })).resolves.toBe(
    fixture,
  );
  expect(list).toHaveBeenCalledWith(
    { scope: {}, probe: true },
    expect.anything(),
  );
  expect(mockRemoteControlCatalogChanged).toHaveBeenCalledTimes(1);
});

it('Check again re-reads the provider setup facts before it re-projects', async () => {
  register(() => trustedCaller);
  await asyncHandler()({ sender: {} }, { probe: true, recheck: true });
  expect(mockFactsRefresh).toHaveBeenCalledWith({ fresh: true });
  // The facts were read again before the push controllers re-project on.
  expect(order.filter((step) => step !== 'build')).toEqual([
    'facts',
    'publish',
  ]);
});

// CAN-6718 review: a computer no remote session has attached to keeps its
// probe as it was, with no setup read and no session-stale push.
it('Check again reads no setup facts before a remote session attaches', async () => {
  mockSetupWatched = false;
  mockRemoteControlCatalogChanged.mockClear();
  register(() => trustedCaller);
  await asyncHandler()({ sender: {} }, { probe: true, recheck: true });
  expect(mockFactsRefresh).not.toHaveBeenCalled();
  expect(mockPublish).not.toHaveBeenCalled();
  expect(mockRemoteControlCatalogChanged).toHaveBeenCalledTimes(1);
});

// CAN-6718 review: the sign-in dialog's two-second poll probes too, but
// only Check again forces a setup read and a session-stale push, so the poll
// keeps the one-minute throttle while a remote session is attached.
it('a probe without Check again keeps the setup facts throttled', async () => {
  mockRemoteControlCatalogChanged.mockClear();
  register(() => trustedCaller);
  await asyncHandler()({ sender: {} }, { probe: true });
  expect(mockFactsRefresh).not.toHaveBeenCalled();
  expect(mockPublish).not.toHaveBeenCalled();
  expect(mockRemoteControlCatalogChanged).toHaveBeenCalledTimes(1);
});
