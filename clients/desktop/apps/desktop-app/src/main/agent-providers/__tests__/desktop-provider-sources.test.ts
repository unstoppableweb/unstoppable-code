import { desktopProviderSources } from '../desktop-provider-host';

const signedOut = {
  authenticated: false,
  accountLabel: null,
  detail: null,
  error: null,
};

jest.mock('../../auth/provider-auth-state', () => ({
  getCachedClaudeAuthStatusObserved: jest.fn(() => Promise.resolve(signedOut)),
  getCachedCodexAuthStatusObserved: jest.fn(() => Promise.resolve(signedOut)),
  peekProviderNativeAuthAvailability: jest.fn(() => ({
    claude: true,
    codex: false,
  })),
}));
jest.mock('../../agents/ai-credits-routing', () => ({
  hasUserSuppliedProviderCredential: jest.fn(() => false),
}));
jest.mock(
  '../../ollama',
  (): { getOllamaService: () => { getState: jest.Mock } } => {
    const getState = jest.fn(() =>
      Promise.resolve({ status: 'stopped', installation: { ready: false } }),
    );
    return { getOllamaService: () => ({ getState }) };
  },
);
jest.mock('../../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: jest.fn(() => Promise.resolve(true)),
  peekCursorRuntimeAvailability: jest.fn(() => true),
}));
jest.mock('../../antigravity/feature-flag', () => ({
  isAntigravityHarnessEnabled: jest.fn(() => true),
}));
jest.mock('../../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: jest.fn(() => true),
}));
jest.mock('../../copilot/runtime-availability', () => ({
  isCopilotRuntimeAvailable: jest.fn(() => Promise.resolve(true)),
  peekCopilotRuntimeAvailability: jest.fn(() => undefined),
}));
jest.mock('../../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: jest.fn(() => true),
}));
jest.mock('../../opencode/runtime-availability', () => ({
  isOpenCodeRuntimeAvailable: jest.fn(() => Promise.resolve(false)),
  peekOpenCodeRuntimeAvailability: jest.fn(() => false),
}));
jest.mock('../../opencode/feature-flag', () => ({
  isOpenCodeHarnessEnabled: jest.fn(() => true),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isOrgModelPolicyActiveForStoredAccount: jest.fn(() => Promise.resolve(false)),
  isModelBlockedByCurrentPolicy: jest.fn(() => false),
}));
jest.mock('../../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: jest.fn(() => Promise.resolve(undefined)),
}));
jest.mock('../../portal/provider-usage-projection', () => ({
  projectPortalProviderUsage: jest.fn(),
  readPortalProviderUsageAccountProxySource: jest.fn(),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(),
}));
jest.mock('../../models/model-registry', () => ({
  buildModelRegistrySnapshot: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/cursor/runtime-metadata', () => ({
  getCursorRuntimeArtifact: jest.fn(() => ({ version: '1' })),
}));
jest.mock('@canopy/desktop-shared/node/copilot/runtime-metadata', () => ({
  getCopilotRuntimeArtifact: jest.fn(() => ({ version: '1' })),
}));
jest.mock('@canopy/desktop-shared/node/opencode/runtime-metadata', () => ({
  getOpenCodeRuntimeArtifact: jest.fn(() => ({ version: '1' })),
}));
jest.mock('@canopy/desktop-shared/platform-capabilities', () => ({
  isOllamaSupportedOnPlatform: jest.fn(() => true),
}));

const auth = jest.requireMock<{
  getCachedClaudeAuthStatusObserved: jest.Mock;
  getCachedCodexAuthStatusObserved: jest.Mock;
  peekProviderNativeAuthAvailability: jest.Mock;
}>('../../auth/provider-auth-state');
const cursor = jest.requireMock<{
  isCursorRuntimeAvailable: jest.Mock;
  peekCursorRuntimeAvailability: jest.Mock;
}>('../../cursor/runtime-availability');
const copilot = jest.requireMock<{
  isCopilotRuntimeAvailable: jest.Mock;
  peekCopilotRuntimeAvailability: jest.Mock;
}>('../../copilot/runtime-availability');
const opencode = jest.requireMock<{
  isOpenCodeRuntimeAvailable: jest.Mock;
  peekOpenCodeRuntimeAvailability: jest.Mock;
}>('../../opencode/runtime-availability');
const credentials = jest.requireMock<{
  hasUserSuppliedProviderCredential: jest.Mock;
}>('../../agents/ai-credits-routing');
const workOwner = jest.requireMock<{ resolveAiCreditsScopeOwner: jest.Mock }>(
  '../../agents/work-owner',
);

const PROVIDERS = [
  'claude',
  'codex',
  'ollama',
  'cursor',
  'copilot',
  'opencode',
] as const;

beforeEach(() => {
  jest.clearAllMocks();
});

it('probe false never calls a probing source', async () => {
  const states = [];
  for (const provider of PROVIDERS)
    states.push(
      await desktopProviderSources.readAuthState(provider, false, {}),
    );
  expect(states).toEqual([
    'ready',
    'missing',
    'missing',
    'ready',
    'error',
    'missing',
  ]);
  expect(auth.peekProviderNativeAuthAvailability).toHaveBeenCalledTimes(2);
  expect(cursor.peekCursorRuntimeAvailability).toHaveBeenCalledTimes(1);
  expect(copilot.peekCopilotRuntimeAvailability).toHaveBeenCalledTimes(1);
  expect(opencode.peekOpenCodeRuntimeAvailability).toHaveBeenCalledTimes(1);
  expect(auth.getCachedClaudeAuthStatusObserved).not.toHaveBeenCalled();
  expect(auth.getCachedCodexAuthStatusObserved).not.toHaveBeenCalled();
  expect(cursor.isCursorRuntimeAvailable).not.toHaveBeenCalled();
  expect(copilot.isCopilotRuntimeAvailable).not.toHaveBeenCalled();
  expect(opencode.isOpenCodeRuntimeAvailable).not.toHaveBeenCalled();
});

it('probe true reuses the cached probes changeChatModelLocked and settings use', async () => {
  for (const provider of PROVIDERS)
    await desktopProviderSources.readAuthState(provider, true, {});
  expect(auth.getCachedClaudeAuthStatusObserved).toHaveBeenCalledWith(
    'worker-provider-list',
  );
  expect(auth.getCachedCodexAuthStatusObserved).toHaveBeenCalledWith(
    'worker-provider-list',
  );
  expect(cursor.isCursorRuntimeAvailable).toHaveBeenCalledTimes(1);
  expect(copilot.isCopilotRuntimeAvailable).toHaveBeenCalledTimes(1);
  expect(opencode.isOpenCodeRuntimeAvailable).toHaveBeenCalledTimes(1);
});

it('the policy owner comes from the work scope', async () => {
  await desktopProviderSources.resolveOwner({
    workspaceId: 'w',
    worktreeId: 't',
    chatId: 'c',
  });
  expect(workOwner.resolveAiCreditsScopeOwner).toHaveBeenLastCalledWith({
    kind: 'work',
    projectId: 'w',
    worktreeId: 't',
    chatId: 'c',
  });
  await desktopProviderSources.resolveOwner({});
  expect(workOwner.resolveAiCreditsScopeOwner).toHaveBeenLastCalledWith(
    undefined,
  );
});

it("a workspace's own credential counts for Claude and Codex", async () => {
  credentials.hasUserSuppliedProviderCredential.mockImplementation(
    (_provider: string, workspaceId?: string) => workspaceId === 'w',
  );
  expect(
    await desktopProviderSources.readAuthState('codex', false, {
      workspaceId: 'w',
    }),
  ).toBe('ready');
  expect(credentials.hasUserSuppliedProviderCredential).toHaveBeenCalledWith(
    'codex',
    'w',
  );
  expect(await desktopProviderSources.readAuthState('codex', false, {})).toBe(
    'missing',
  );
  credentials.hasUserSuppliedProviderCredential.mockReturnValue(false);
});

it('a platform without the runtime artifact omits Cursor, Copilot and OpenCode', async () => {
  expect(await desktopProviderSources.supported()).toEqual({
    antigravity: process.platform === 'darwin',
    claude: true,
    codex: true,
    ollama: true,
    cursor: true,
    copilot: true,
    opencode: true,
  });
  for (const [path, name] of [
    [
      '@canopy/desktop-shared/node/cursor/runtime-metadata',
      'getCursorRuntimeArtifact',
    ],
    [
      '@canopy/desktop-shared/node/copilot/runtime-metadata',
      'getCopilotRuntimeArtifact',
    ],
    [
      '@canopy/desktop-shared/node/opencode/runtime-metadata',
      'getOpenCodeRuntimeArtifact',
    ],
  ] as const)
    jest
      .requireMock<Record<string, jest.Mock>>(path)
      [name]?.mockReturnValueOnce(undefined);
  expect(await desktopProviderSources.supported()).toEqual({
    antigravity: process.platform === 'darwin',
    claude: true,
    codex: true,
    ollama: true,
    cursor: false,
    copilot: false,
    opencode: false,
  });
});
