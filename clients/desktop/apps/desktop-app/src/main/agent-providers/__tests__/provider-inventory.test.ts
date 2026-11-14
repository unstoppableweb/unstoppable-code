import type {
  PortalProviderUsageEntry,
  PortalProviderUsageWindow,
} from '@canopy/protocol/portal';
import type {
  AgentProviderAuthStatus,
  ModelRegistrySnapshot,
  OllamaModelEntry,
  OllamaState,
} from '@canopy/desktop-shared/types';
import {
  availabilityAuthState,
  nativeAuthState,
  normalizeIsoTimestamp,
  ollamaAuthState,
  projectModelBilling,
  projectProviderInventory,
  projectProviderUsageLimit,
  type ProviderInventoryInputs,
} from '../provider-inventory';

const allSupported = {
  claude: true,
  codex: true,
  ollama: true,
  cursor: true,
  copilot: true,
  antigravity: true,
  opencode: true,
};

function ollamaModel(id: string): OllamaModelEntry {
  return { id, rawModelId: id, label: id };
}

function registry(
  overrides: Partial<ModelRegistrySnapshot> = {},
): ModelRegistrySnapshot {
  return { claude: [], codex: [], ollama: [], aliases: {}, ...overrides };
}

function inputs(
  overrides: Partial<ProviderInventoryInputs> = {},
): ProviderInventoryInputs {
  return {
    registry: registry(),
    supported: allSupported,
    authStates: {},
    checkedAt: '2026-11-05T12:00:00.000Z',
    usage: null,
    isBlocked: () => false,
    ...overrides,
  };
}

function authStatus(
  overrides: Partial<AgentProviderAuthStatus>,
): AgentProviderAuthStatus {
  return {
    authenticated: false,
    accountLabel: null,
    detail: null,
    error: null,
    ...overrides,
  };
}

function ollamaState(
  status: OllamaState['status'],
  ready: boolean,
): OllamaState {
  return {
    port: 11434,
    status,
    models: [],
    mode: 'managed',
    installation: {
      platform: 'darwin',
      ready,
      path: null,
      version: null,
      source: 'not-found',
      checkedAt: '2026-11-05T12:00:00.000Z',
      automaticInstallSupported: true,
    },
  };
}

it('billing sources restate the gateway metadata', () => {
  expect(projectModelBilling({}, 'ollama')).toEqual({
    billingSources: ['local'],
    gatewayOrigin: null,
  });
  expect(projectModelBilling({}, 'ai-gateway')).toEqual({
    billingSources: ['ai_credits'],
    gatewayOrigin: 'hosted',
  });
  expect(projectModelBilling({}, 'native')).toEqual({
    billingSources: ['provider_account'],
    gatewayOrigin: null,
  });
  expect(
    projectModelBilling(
      { gateway: { gatewayOnly: true, origin: 'org-gateway' } },
      'native',
    ),
  ).toEqual({ billingSources: [], gatewayOrigin: 'org-gateway' });
  expect(
    projectModelBilling(
      { gateway: { gatewayOnly: false, origin: 'org-gateway' } },
      'native',
    ),
  ).toEqual({
    billingSources: ['provider_account'],
    gatewayOrigin: 'org-gateway',
  });
  expect(
    projectModelBilling({ gateway: { gatewayOnly: true } }, 'native'),
  ).toEqual({ billingSources: ['ai_credits'], gatewayOrigin: 'hosted' });
  expect(
    projectModelBilling(
      { gateway: { gatewayOnly: false, origin: 'hosted' } },
      'native',
    ),
  ).toEqual({
    billingSources: ['provider_account', 'ai_credits'],
    gatewayOrigin: 'hosted',
  });
});

it('custom agents, unselectable and repeated models are not listed', () => {
  const result = projectProviderInventory(
    inputs({
      registry: registry({
        claude: [
          { id: 'opus', label: 'Opus' },
          { id: 'hidden', label: 'Hidden', selectable: false },
        ],
        codex: [
          { id: 'gpt', label: 'GPT' },
          { id: 'gpt', label: 'GPT again' },
        ],
        agents: [
          {
            id: 'agent:custom',
            name: 'Custom',
            baseModel: 'opus',
            instructions: 'SECRET-INSTRUCTIONS',
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
            },
            createdAt: '2026-11-05T12:00:00.000Z',
            updatedAt: '2026-11-05T12:00:00.000Z',
            available: true,
          },
        ],
      }),
    }),
  );
  const ids = (providerId: string): string[] =>
    result.providers
      .find((provider) => provider.providerId === providerId)
      ?.models.map((model) => model.modelId) ?? [];
  expect(ids('claude')).toEqual(['opus']);
  expect(ids('codex')).toEqual(['gpt']);
  expect(JSON.stringify(result)).not.toContain('SECRET-INSTRUCTIONS');
  expect(JSON.stringify(result)).not.toContain('agent:custom');
});

it("a provider's models are capped at 500", () => {
  const warn = jest.fn();
  const result = projectProviderInventory(
    inputs({
      registry: registry({
        ollama: Array.from({ length: 501 }, (_, index) =>
          ollamaModel(`model-${index}`),
        ),
      }),
      warn,
    }),
  );
  const ollama = result.providers.find(
    (provider) => provider.providerId === 'ollama',
  );
  expect(ollama?.models).toHaveLength(500);
  expect(warn).toHaveBeenCalledTimes(1);
});

it('usage limits drop account identity', () => {
  const window: PortalProviderUsageWindow = {
    id: 'five-hour',
    label: '5-hour window',
    usedPercent: 40,
    resetsAt: '2026-11-05T17:00:00Z',
    credits: { unit: 'usd', spent: 1, remaining: 2, total: 3 },
    spend: { currency: 'USD', used: 1, limit: null, isEnabled: true },
  };
  const entry: PortalProviderUsageEntry = {
    provider: 'claude',
    authState: 'authenticated',
    accountEmail: 'person@example.com',
    accountLabel: 'person-login',
    planLabel: 'Claude Max 20x',
    lastUpdatedAt: '2026-11-05T12:00:00Z',
    windows: [window],
    accounts: [
      {
        id: 'account-1',
        label: 'proxy@example.com',
        planLabel: 'Claude Pro',
        status: 'active',
        usageSource: 'live',
        windows: [window],
      },
    ],
  };
  const limit = projectProviderUsageLimit(entry);
  const text = JSON.stringify(limit);
  for (const secret of [
    'person@example.com',
    'person-login',
    'Claude Max 20x',
    'account-1',
    'proxy@example.com',
    'Claude Pro',
  ])
    expect(text).not.toContain(secret);
  const projectedWindow = {
    id: 'five-hour',
    label: '5-hour window',
    usedPercent: 40,
    resetsAt: '2026-11-05T17:00:00.000Z',
    credits: { unit: 'usd', spent: 1, remaining: 2, total: 3 },
    spend: { currency: 'USD', used: 1, limit: null, isEnabled: true },
  };
  expect(limit).toEqual({
    authState: 'authenticated',
    lastUpdatedAt: '2026-11-05T12:00:00.000Z',
    error: null,
    windows: [projectedWindow],
    accountProxy: {
      accounts: [
        { status: 'active', usageSource: 'live', windows: [projectedWindow] },
      ],
    },
  });
});

it('auth state mapping is fail closed', () => {
  expect(nativeAuthState(authStatus({ authenticated: true }), false)).toBe(
    'ready',
  );
  expect(nativeAuthState(authStatus({ probeFailed: true }), false)).toBe(
    'error',
  );
  expect(nativeAuthState(authStatus({}), false)).toBe('missing');
  expect(nativeAuthState(authStatus({ probeFailed: true }), true)).toBe(
    'ready',
  );
  expect(nativeAuthState(true, false)).toBe('ready');
  expect(nativeAuthState(false, false)).toBe('missing');
  expect(nativeAuthState(false, true)).toBe('ready');
  expect(nativeAuthState(undefined, false)).toBe('error');
  expect(nativeAuthState(undefined, true)).toBe('ready');

  expect(availabilityAuthState(true)).toBe('ready');
  expect(availabilityAuthState(false)).toBe('missing');
  expect(availabilityAuthState(undefined)).toBe('error');

  expect(ollamaAuthState(ollamaState('error', true))).toBe('error');
  expect(ollamaAuthState(ollamaState('running-managed', false))).toBe('ready');
  expect(ollamaAuthState(ollamaState('running-external', false))).toBe('ready');
  expect(ollamaAuthState(ollamaState('stopped', true))).toBe('ready');
  expect(ollamaAuthState(ollamaState('stopped', false))).toBe('missing');
});

it('unparsable timestamps are dropped and parsable ones re-serialised', () => {
  expect(normalizeIsoTimestamp(undefined)).toBeUndefined();
  expect(normalizeIsoTimestamp('')).toBeUndefined();
  expect(normalizeIsoTimestamp('not a date')).toBeUndefined();
  expect(normalizeIsoTimestamp('2026-11-05T12:00:00+01:00')).toBe(
    '2026-11-05T11:00:00.000Z',
  );
});

it('a failed probe that kept the last confirmed sign-in reads error, as the peek does', () => {
  expect(
    nativeAuthState(
      authStatus({ authenticated: true, probeFailed: true }),
      false,
    ),
  ).toBe('error');
  expect(
    nativeAuthState(
      authStatus({ authenticated: true, probeFailed: true }),
      true,
    ),
  ).toBe('ready');
});

it('Google account models are native and never expose a gateway billing route', () => {
  const result = projectProviderInventory(
    inputs({
      registry: registry({
        antigravity: [
          {
            id: 'antigravity:gemini-test',
            rawModelId: 'gemini-test',
            label: 'Gemini test',
            supportedThinkingLevels: ['high'],
          },
        ],
      }),
      authStates: { antigravity: 'ready' },
    }),
  );
  const google = result.providers.find(
    (provider) => provider.providerId === 'antigravity',
  );
  expect(google).toMatchObject({
    providerId: 'antigravity',
    authState: 'ready',
    models: [
      {
        modelId: 'antigravity:gemini-test',
        billingSources: ['provider_account'],
        gatewayOrigin: null,
      },
    ],
  });
  expect(JSON.stringify(google)).not.toContain('ai-gateway');
});
