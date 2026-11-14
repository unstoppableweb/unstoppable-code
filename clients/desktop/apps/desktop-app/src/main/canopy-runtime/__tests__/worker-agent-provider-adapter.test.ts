import type {
  CanopyCallerDescriptor,
  WorkerAgentProviderAuthState,
  WorkerAgentProviderId,
  WorkerAgentProviderListResult,
} from '@canopy/protocol/canopy-core';
import type { PortalProviderUsageProjection } from '@canopy/protocol/portal';
import type { ModelRegistrySnapshot } from '@canopy/desktop-shared/types';
import {
  createDesktopProviderHost,
  PROVIDER_STATUS_DEADLINE_MS,
  type DesktopProviderSources,
} from '../../agent-providers/desktop-provider-host';
import { projectProviderUsageLimit } from '../../agent-providers/provider-inventory';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { createWorkerAgentAdapter } from '../worker-agent-adapter';

const caller: CanopyCallerDescriptor = {
  principalId: 'desktop-ipc',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.agent.read'],
};

const allSupported: Record<WorkerAgentProviderId, boolean> = {
  claude: true,
  codex: true,
  ollama: true,
  cursor: true,
  copilot: true,
  antigravity: true,
  opencode: true,
};

const usage: PortalProviderUsageProjection = {
  updatedAt: '2026-11-05T12:00:00.000Z',
  providers: [
    {
      provider: 'claude',
      authState: 'authenticated',
      accountEmail: 'person@example.com',
      planLabel: 'Claude Max 20x',
      error: { kind: 'service', message: 'Usage is unavailable.' },
      windows: [{ id: 'five-hour', label: '5-hour window', usedPercent: 12 }],
    },
    {
      provider: 'codex',
      authState: 'unauthenticated',
      windows: [],
    },
  ],
};

function fixtureRegistry(): ModelRegistrySnapshot {
  return {
    claude: [
      {
        id: 'claude-opus',
        label: 'Opus',
        contextWindow: 200_000,
        supportedThinkingLevels: ['low', 'high'],
        gateway: {
          gatewayId: 'opus',
          family: 'claude',
          recommendedHarness: 'claude',
          gatewayOnly: false,
          contextWindow: 200_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
          origin: 'org-gateway',
          baseUrl: 'https://gw.example.internal',
          organizationId: 'org-123',
        },
      },
      { id: 'claude-sonnet', label: 'Sonnet' },
    ],
    codex: [],
    ollama: [{ id: 'ollama:llama3', rawModelId: 'llama3', label: 'Llama 3' }],
    aliases: {},
    aiGatewayModels: [
      {
        id: 'gateway-gpt',
        label: 'Gateway GPT',
        recommendedHarness: 'codex',
        contextWindow: 128_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: ['medium'],
        toolSchemaProfile: 'standard',
      },
    ],
  };
}

type FakeSources = {
  [Key in keyof DesktopProviderSources]: jest.MockedFunction<
    DesktopProviderSources[Key]
  >;
};

function fakeSources(
  overrides: Partial<DesktopProviderSources> = {},
): FakeSources {
  const defaults: DesktopProviderSources = {
    buildRegistry: () => fixtureRegistry(),
    supported: () => allSupported,
    readAuthState: (): Promise<WorkerAgentProviderAuthState> =>
      Promise.resolve('ready'),
    readUsage: () => Promise.resolve(usage),
    resolveOwner: () => Promise.resolve({ kind: 'personal' }),
    refreshPolicy: () => Promise.resolve(),
    isBlocked: () => false,
    now: () => new Date('2026-11-05T12:00:00.000Z'),
  };
  const merged = { ...defaults, ...overrides };
  return {
    buildRegistry: jest.fn(merged.buildRegistry),
    supported: jest.fn(merged.supported),
    readAuthState: jest.fn(merged.readAuthState),
    readUsage: jest.fn(merged.readUsage),
    resolveOwner: jest.fn(merged.resolveOwner),
    refreshPolicy: jest.fn(merged.refreshPolicy),
    isBlocked: jest.fn(merged.isBlocked),
    now: jest.fn(merged.now),
  };
}

let runtime: DesktopCanopyDispatcher | undefined;

function runtimeFor(sources: DesktopProviderSources): DesktopCanopyDispatcher {
  runtime = createDesktopRuntime({
    shutdownTimeoutMs: 25,
    workerAgentAdapter: createWorkerAgentAdapter({
      providerHost: createDesktopProviderHost(sources),
      sinkFor: () => null,
    }),
  });
  return runtime;
}

afterEach(async () => {
  jest.useRealTimers();
  await runtime?.shutdown();
  runtime = undefined;
});

function list(
  dispatcher: DesktopCanopyDispatcher,
  params: { scope?: Record<string, string>; probe?: boolean } = {},
  listCaller: CanopyCallerDescriptor = caller,
): Promise<WorkerAgentProviderListResult> {
  return dispatcher.query(
    'worker.agent.provider.list',
    { scope: params.scope ?? {}, probe: params.probe ?? false },
    { caller: listCaller },
  );
}

function provider(
  result: WorkerAgentProviderListResult,
  providerId: WorkerAgentProviderId,
): WorkerAgentProviderListResult['providers'][number] | undefined {
  return result.providers.find((entry) => entry.providerId === providerId);
}

it("lists the registry's models under their providers", async () => {
  const result = await list(runtimeFor(fakeSources()));
  expect(result).toMatchObject({
    authorityId: 'local-desktop',
    targetId: 'in_process_worker',
    probed: false,
  });
  expect(provider(result, 'claude')?.models).toEqual([
    {
      modelId: 'claude-opus',
      name: 'Opus',
      contextWindow: 200_000,
      outputLimit: null,
      billingSources: ['provider_account'],
      gatewayOrigin: 'org-gateway',
      thinkingLevels: ['low', 'high'],
      blockedByOrganization: false,
    },
    {
      modelId: 'claude-sonnet',
      name: 'Sonnet',
      contextWindow: null,
      outputLimit: null,
      billingSources: ['provider_account'],
      gatewayOrigin: null,
      thinkingLevels: null,
      blockedByOrganization: false,
    },
  ]);
  expect(provider(result, 'codex')?.models).toEqual([
    {
      modelId: 'gateway-gpt',
      name: 'Gateway GPT',
      contextWindow: 128_000,
      outputLimit: null,
      billingSources: ['ai_credits'],
      gatewayOrigin: 'hosted',
      thinkingLevels: ['medium'],
      blockedByOrganization: false,
    },
  ]);
  expect(provider(result, 'ollama')?.models).toEqual([
    {
      modelId: 'ollama:llama3',
      name: 'Llama 3',
      contextWindow: null,
      outputLimit: null,
      billingSources: ['local'],
      gatewayOrigin: null,
      thinkingLevels: null,
      blockedByOrganization: false,
    },
  ]);
});

it('represents all supported providers when supported', async () => {
  const result = await list(runtimeFor(fakeSources()));
  expect(result.providers.map((entry) => entry.providerId)).toEqual([
    'claude',
    'codex',
    'ollama',
    'cursor',
    'copilot',
    'antigravity',
    'opencode',
  ]);
});

it('omits a provider its flag or platform does not support', async () => {
  const sources = fakeSources({
    supported: () => ({
      ...allSupported,
      ollama: false,
      cursor: false,
      copilot: false,
      antigravity: false,
      opencode: false,
    }),
  });
  const result = await list(runtimeFor(sources));
  expect(result.providers.map((entry) => entry.providerId)).toEqual([
    'claude',
    'codex',
  ]);
  expect(
    sources.readAuthState.mock.calls.map(([providerId]) => providerId),
  ).toEqual(['claude', 'codex']);
});

it('a slow provider read reports error without failing the list', async () => {
  jest.useFakeTimers();
  const sources = fakeSources({
    readAuthState: (providerId) =>
      providerId === 'cursor'
        ? new Promise<WorkerAgentProviderAuthState>(() => undefined)
        : Promise.resolve(providerId === 'codex' ? 'missing' : 'ready'),
  });
  const pending = list(runtimeFor(sources));
  await jest.advanceTimersByTimeAsync(PROVIDER_STATUS_DEADLINE_MS);
  const result = await pending;
  expect(provider(result, 'cursor')?.authState).toBe('error');
  expect(provider(result, 'claude')?.authState).toBe('ready');
  expect(provider(result, 'codex')?.authState).toBe('missing');
});

it('never projects credentials, account identity, gateway URLs or provider text', async () => {
  const result = await list(runtimeFor(fakeSources()));
  const text = JSON.stringify(result);
  for (const secret of [
    'gw.example.internal',
    'org-123',
    'person@example.com',
    'Claude Max 20x',
  ])
    expect(text).not.toContain(secret);
  expect(provider(result, 'claude')?.usageLimit?.error).toEqual({
    kind: 'service',
    message: 'Usage is unavailable.',
  });
});

it('usage limits come from the provider usage projection', async () => {
  const result = await list(runtimeFor(fakeSources()));
  expect(provider(result, 'claude')?.usageLimit).toEqual(
    projectProviderUsageLimit(usage.providers[0]),
  );
  expect(provider(result, 'codex')?.usageLimit).toEqual(
    projectProviderUsageLimit(usage.providers[1]),
  );
  for (const providerId of ['ollama', 'cursor', 'opencode', 'copilot'] as const)
    expect(provider(result, providerId)?.usageLimit).toBeNull();
});

it('a model the organization blocks is marked blocked, from the same policy read', async () => {
  const order: string[] = [];
  const owner = { kind: 'organization', organizationId: 'org' };
  const sources = fakeSources({
    resolveOwner: () => Promise.resolve(owner),
    refreshPolicy: () => {
      order.push('refresh');
      return Promise.resolve();
    },
    isBlocked: (modelId) => {
      order.push('isBlocked');
      return modelId === 'claude-opus';
    },
  });
  const dispatcher = runtimeFor(sources);
  const probed = await list(dispatcher, {
    scope: { workspaceId: 'w', worktreeId: 't', chatId: 'c' },
    probe: true,
  });
  expect(
    provider(probed, 'claude')?.models.map(
      (model) => model.blockedByOrganization,
    ),
  ).toEqual([true, false]);
  expect(sources.refreshPolicy).toHaveBeenCalledTimes(1);
  expect(sources.refreshPolicy).toHaveBeenCalledWith(owner);
  expect(order[0]).toBe('refresh');
  expect(order.filter((step) => step === 'refresh')).toHaveLength(1);
  expect(
    sources.isBlocked.mock.calls.map(([modelId]) => modelId),
  ).not.toContain('ollama:llama3');

  sources.refreshPolicy.mockClear();
  await list(dispatcher, { probe: false });
  expect(sources.refreshPolicy).not.toHaveBeenCalled();
});

it('a failed policy read blocks every non-Ollama model', async () => {
  const result = await list(
    runtimeFor(
      fakeSources({
        refreshPolicy: () => Promise.reject(new Error('stored account read')),
      }),
    ),
    { probe: true },
  );
  for (const entry of result.providers)
    for (const model of entry.models)
      expect(model.blockedByOrganization).toBe(entry.providerId !== 'ollama');
  expect(provider(result, 'ollama')?.models).toHaveLength(1);
});

it('is denied without worker.agent.read before any read', async () => {
  const sources = fakeSources();
  await expect(
    list(runtimeFor(sources), {}, { ...caller, grants: [] }),
  ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  expect(sources.buildRegistry).not.toHaveBeenCalled();
});

it('refuses a remote target', async () => {
  const sources = fakeSources();
  const dispatcher = runtimeFor(sources);
  await expect(
    list(dispatcher, { scope: { targetId: 'remote-1' } }),
  ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
  expect(sources.buildRegistry).not.toHaveBeenCalled();
  await expect(
    list(dispatcher, { scope: { targetId: 'in_process_worker' } }),
  ).resolves.toMatchObject({ targetId: 'in_process_worker' });
});

it('an org-gateway API-only model is not reported as hosted AI credits', async () => {
  const registry = fixtureRegistry();
  const orgRow = {
    id: 'org-model',
    label: 'Org model',
    recommendedHarness: 'claude' as const,
    contextWindow: 100_000,
    supportsPromptCaching: false,
    supportedThinkingLevels: [],
    toolSchemaProfile: 'standard' as const,
  };
  const result = await list(
    runtimeFor(
      fakeSources({
        buildRegistry: () => ({
          ...registry,
          aiGatewayModels: [...(registry.aiGatewayModels ?? []), orgRow],
          gatewayRoutes: [
            {
              modelId: 'org-model',
              gatewayId: 'org-model',
              family: 'custom',
              recommendedHarness: 'claude',
              gatewayOnly: true,
              contextWindow: 100_000,
              supportsPromptCaching: false,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
              origin: 'org-gateway',
              baseUrl: 'https://gw.example.internal',
              organizationId: 'org-123',
            },
          ],
        }),
      }),
    ),
  );
  expect(
    provider(result, 'claude')?.models.find(
      (model) => model.modelId === 'org-model',
    ),
  ).toMatchObject({ billingSources: [], gatewayOrigin: 'org-gateway' });
  expect(
    provider(result, 'codex')?.models.find(
      (model) => model.modelId === 'gateway-gpt',
    ),
  ).toMatchObject({ billingSources: ['ai_credits'], gatewayOrigin: 'hosted' });
  expect(JSON.stringify(result)).not.toContain('gw.example.internal');
  expect(JSON.stringify(result)).not.toContain('org-123');
});
