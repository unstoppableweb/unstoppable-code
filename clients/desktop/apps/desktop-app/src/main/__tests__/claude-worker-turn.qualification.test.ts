import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type { ChatTabsFile } from '@canopy/desktop-shared/types';
import type * as DesktopSharedTypesModule from '@canopy/desktop-shared/types';
import type { ChildToolLiveness } from '@canopy/agent-transcript';
import type * as AiCreditsRoutingModule from '../agents/ai-credits-routing';
import type {
  GatewayModelEntry,
  WorkOwner,
} from '@canopy/protocol/llm-gateway';
import {
  managedAiCreditsChildValues,
  managedAiCreditsAttributionHeaders,
} from '@canopy/core-runtime/node/pipeline/host';
import type * as ClaudeModAdmissionLaunchModule from '../agents/claude-mod-admission-launch';
import type * as LedgerToolsRuntimeModule from '../canopy-tools/ledger-tools-runtime';
import type * as PreferencesStoreModule from '../lib/preferences-store';
import { subscribeCommittedPreferences } from '../lib/preferences-committed';
import {
  flushPreferencesWrites,
  readPreferencesFile,
  updatePreferencesFile,
} from '../lib/preferences-store';
import type * as WorkOwnerModule from '../agents/work-owner';
import * as preferencesStore from '../lib/preferences-store';
import * as modelPolicyState from '../lib/model-policy-state';
import * as modelGatewayState from '../lib/model-gateway-state';
import * as cloudAccountStore from '../lib/canopy-cloud-account-store';
import * as gatewayAvailability from '@canopy/execution-engine/lib/gateway-model-availability';
import { getCodexGatewayProxyService } from '../agents/codex-gateway-proxy-service';
import type { AccountProxySessionRoute } from '../account-proxy/routing';
import type { CanopyWorktreeSessionRoute } from '../mcp/http-proxy-service';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionOptions,
} from '../agents/types';

// Retained Claude and Ollama (Claude harness) turn behavior on the local
// worker (CAN-4116): sessions are constructed only through the worker-owned
// Claude runtime and created and prompted inside a worker turn run, the way
// the CAN-4115 posted expressions run them. The SDK and the process host are
// scripted; everything between them is the production session.

type MockQuery = (params: {
  prompt: AsyncIterable<unknown>;
  options?: Parameters<typeof claudeQuery>[0]['options'];
}) => unknown;

const mockQuery: jest.MockedFunction<MockQuery> = jest.fn();
const mockSpawnClaudeCodeProcessOffMain = jest.fn();
const mockWithholdClaudeProcessStdoutCreditUntil = jest.fn();
const mockResolveClaudeCompatibleInvocation = jest.fn();
const mockLoadCachedInventory = jest.fn(() => Promise.resolve(null));
const mockApprovalCheck = jest.fn();
const mockGetChildToolLiveness = jest.fn<
  ChildToolLiveness,
  [string, string, string]
>(() => ({ kind: 'no-live-session' }));
const mockPlanTrackingTabs = jest.fn<Promise<ChatTabsFile>, []>(() =>
  Promise.resolve({ version: 1, tabs: [], activeTabId: '' }),
);
const mockResolveSessionWorkOwner = jest.fn<
  ReturnType<typeof WorkOwnerModule.resolveSessionWorkOwner>,
  Parameters<typeof WorkOwnerModule.resolveSessionWorkOwner>
>(() => Promise.resolve({ kind: 'personal' as const }));

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class MockBrowserWindow {
    public isDestroyed(): boolean {
      return false;
    }
  },
}));
jest.mock('../agents/claude-process-host-runner', () => ({
  get spawnClaudeCodeProcessOffMain(): typeof mockSpawnClaudeCodeProcessOffMain {
    return mockSpawnClaudeCodeProcessOffMain;
  },
  get withholdClaudeProcessStdoutCreditUntil(): typeof mockWithholdClaudeProcessStdoutCreditUntil {
    return mockWithholdClaudeProcessStdoutCreditUntil;
  },
}));
jest.mock('../agents/delegation/gate', () => ({
  managedDelegationEnabled: jest.fn(() => false),
}));
jest.mock('../agents/delegation/service', () => ({
  createManagedDelegationSession: jest.fn(),
}));
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  get query(): typeof mockQuery {
    return mockQuery;
  },
  createSdkMcpServer: jest.fn((configuration: unknown) => configuration),
  tool: jest.fn((name: string) => ({ name })),
}));
jest.mock('../lib/process-kill', () => ({
  killChildProcessGroup: jest.fn(),
}));
jest.mock('../account-proxy/switch-events', () => ({
  watchAccountProxySwitches: jest.fn(() => (): void => undefined),
}));
jest.mock('../account-proxy/routing', () => ({
  resolveAccountProxySessionRoute:
    (): Promise<AccountProxySessionRoute | null> => Promise.resolve(null),
  previewAccountProxySessionRoute: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  ),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
  readPreferencesFileDetailed: jest.fn<
    ReturnType<typeof PreferencesStoreModule.readPreferencesFileDetailed>,
    Parameters<typeof PreferencesStoreModule.readPreferencesFileDetailed>
  >(),
  readLatestPreferencesFile: jest.fn(() =>
    Promise.resolve(
      jest.requireActual<typeof PreferencesStoreModule>(
        '../lib/preferences-store',
      ).DEFAULT_PREFERENCES,
    ),
  ),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/claude'),
  getBundledRtkBinaryPath: jest.fn(() => '/mock/rtk'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/rg'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
  getRtkManagedEnv: jest.fn(() => ({ RTK_TELEMETRY_DISABLED: '1' })),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  cleanupWorktreeChatPluginDirs: jest.fn(),
  resolvePlugins: jest.fn().mockResolvedValue({
    sdkPlugins: [],
    skillPluginDir: null,
    selectedCapabilityRoots: [],
    codexProcessEnv: {},
    codexMcpServers: {},
    mcpServers: {},
    warnings: [],
  }),
}));
// Mod admission reads the real Claude config before each launch; this golden
// runs with it off, and the admission goldens cover it.
jest.mock('../agents/claude-mod-admission-launch', () => ({
  ...jest.requireActual<typeof ClaudeModAdmissionLaunchModule>(
    '../agents/claude-mod-admission-launch',
  ),
  resolveClaudeModAdmissionContext: (): Promise<undefined> =>
    Promise.resolve(undefined),
  resolveClaudeModAdmissionLaunch: (): Promise<undefined> =>
    Promise.resolve(undefined),
}));
jest.mock('../plugins/invocable-inventory-service', () => ({
  get loadCachedInventory(): typeof mockLoadCachedInventory {
    return mockLoadCachedInventory;
  },
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn((selections?: unknown) =>
    Promise.resolve({
      selections: selections ?? {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      },
    }),
  ),
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    registerCanopyWorktreeSessionRoute: jest.fn(
      (route: CanopyWorktreeSessionRoute): Promise<string> => {
        void route;
        return Promise.resolve('session-route');
      },
    ),
    unregisterCanopyWorktreeSessionRoute: jest.fn(),
    unregisterRoutesForSession: jest.fn(),
    getCanopyWorktreeMcpUrl: jest.fn(
      (sessionKey: string) =>
        `http://127.0.0.1:4567/mcp/${encodeURIComponent(sessionKey)}`,
    ),
    getCanopyWorktreeUiMcpUrl: jest.fn(
      (sessionKey: string) =>
        `http://127.0.0.1:4567/mcp/${encodeURIComponent(sessionKey)}/ui`,
    ),
  })),
}));
jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(() => ({
    registerRoute: jest.fn(() =>
      Promise.resolve({ routeId: 'route-id', baseUrl: 'http://127.0.0.1' }),
    ),
    unregisterRoutesForSession: jest.fn(),
  })),
}));
jest.mock('../mcp/script-output', () => ({
  loadScriptOutputSnapshot: jest.fn(),
}));
jest.mock('../mcp/pending-requests', () => ({
  rejectAllForSession: jest.fn(),
  createPendingRequest: jest.fn(() => new Promise(() => {})),
  resolveRequest: jest.fn(),
  rejectRequest: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: (): { hasGraph: jest.Mock } => ({
    hasGraph: jest.fn(() => false),
  }),
}));
jest.mock('../mcp/plan-pending-requests', () => ({
  createPendingPlanExit: jest.fn(),
  rejectAllPlanExitsForSession: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  registerSession: jest.fn(),
  unregisterSession: jest.fn(),
  getSessionKeyOwnership: jest.fn(() => 'registered'),
  getSessionInstanceId: jest.fn(() => 'session-instance-1'),
  buildSessionKey: jest.fn(
    (p: string, w: string, c: string) => `${p}/${w}/${c}`,
  ),
  markTurnActive: jest.fn(),
  markTurnAwaitingUser: jest.fn(),
  markTurnIdle: jest.fn(),
  noteSessionMessageQueued: jest.fn(),
  recordSessionEvent: jest.fn(),
  markSessionTeardownCause: jest.fn(),
  get getChildToolLiveness(): typeof mockGetChildToolLiveness {
    return mockGetChildToolLiveness;
  },
  recordClaudeSessionCronHookInput: jest.fn(),
  createSessionPhaseTimer: jest.fn(() => jest.fn()),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  recordSessionAccountProxyRoute: jest.fn(),
  resetSessionLiveBackgroundTasks: jest.fn(),
  subscribeLiveBackgroundTasks: jest.fn(() => (): void => undefined),
  SessionUnavailableForTaskStopError: class SessionUnavailableForTaskStopError extends Error {},
}));
jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: jest.Mock; clear: jest.Mock } => ({
    mark: jest.fn(),
    clear: jest.fn(),
  }),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordUsageLimitedChat: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    commitPlanExit: jest.Mock;
    getCompatibilityTabs: typeof mockPlanTrackingTabs;
  } => ({
    commitPlanExit: jest.fn(() => Promise.resolve()),
    get getCompatibilityTabs(): typeof mockPlanTrackingTabs {
      return mockPlanTrackingTabs;
    },
  }),
}));
jest.mock('../ollama/claude-compatible', () => ({
  get resolveClaudeCompatibleInvocation(): typeof mockResolveClaudeCompatibleInvocation {
    return mockResolveClaudeCompatibleInvocation;
  },
}));
jest.mock('../lib/resolve-workspace-display-name', () => ({
  resolveWorkspaceRecordingSnapshot: jest.fn().mockResolvedValue({
    name: 'Workspace',
    type: 'single-repo',
  }),
}));
jest.mock('../auth/provider-auth-state', () => {
  const isProviderNativelyAuthenticated = jest.fn().mockResolvedValue(true);
  return {
    isProviderNativelyAuthenticated,
    isProviderNativelyAuthenticatedForRouting: isProviderNativelyAuthenticated,
  };
});
jest.mock('../agents/ai-credits-routing', () => ({
  ...jest.requireActual<typeof AiCreditsRoutingModule>(
    '../agents/ai-credits-routing',
  ),
  getAiCreditsRoutingContext: jest.fn(),
  resolveAiCreditsAttribution: jest.fn().mockResolvedValue({}),
  resolveSessionAiCreditsAttribution: jest.fn(() => Promise.resolve({})),
  resolveOrgGatewayCredential: jest.fn(),
  markOrgGatewayCredentialRejected: jest.fn(() => Promise.resolve()),
}));
jest.mock('../agents/work-owner', () => ({
  ...jest.requireActual<typeof WorkOwnerModule>('../agents/work-owner'),
  get resolveSessionWorkOwner(): typeof mockResolveSessionWorkOwner {
    return mockResolveSessionWorkOwner;
  },
}));
jest.mock('../lib/plan-persistence', () => ({
  createTrackedPlan: jest.fn(),
  updateTrackedPlan: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToWindowDetailed: jest.fn(() => ({
    delivered: false,
    reason: 'no_window',
  })),
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    check: mockApprovalCheck,
    setMode: jest.fn(),
    invalidatePending: jest.fn(),
    dispose: jest.fn(),
  })),
}));
jest.mock('../canopy-tools/ledger-tools-runtime', () => ({
  ...jest.requireActual<typeof LedgerToolsRuntimeModule>(
    '../canopy-tools/ledger-tools-runtime',
  ),
  mayExposeLedgerTools: jest.fn(() => false),
  openLedgerChatTools: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('@canopy/desktop-shared/platform-capabilities', () => ({
  ...jest.requireActual<object>('@canopy/desktop-shared/platform-capabilities'),
  isOllamaSupportedOnPlatform: jest.fn(() => true),
}));
jest.mock('@canopy/desktop-shared/types', () => ({
  ...jest.requireActual<typeof DesktopSharedTypesModule>(
    '@canopy/desktop-shared/types',
  ),
  isSelectableOllamaModel: jest.fn(() => true),
}));

import {
  AgentOutsideWorkerError,
  currentAgentWorkerContext,
  runInAgentWorker,
  runInAgentWorkerSync,
  type AgentWorkerContext,
} from '../agent-runs/agent-worker-context';
import {
  getClaudeWorkerRuntime,
  type ClaudeHarnessProviderType,
} from '../agent-runs/claude-worker-runtime';
import { chatTurnOutcomeOf } from '../agent-runs/turn-runs';
import { interruptClaudeSessionForStop } from '../agents/claude-session';
import { isRootTerminalChatEventData } from '../lib/chat-turn-audit';
import { windowAgentInterfacePort } from '../agents/agent-interface-port';

const TURN: AgentWorkerContext = { kind: 'turn', runId: 'turn-1' };
const CHAIN_UUID = '11111111-2222-4333-8444-555555555555';
const STEER_ATTEMPT = '22222222-3333-4444-8555-666666666666';
const OLLAMA_MODEL = 'ollama:llama3';
const OLLAMA_INVOCATION = {
  providerType: 'ollama',
  sdkModel: 'llama3',
  envOverride: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' },
};
const NATIVE_CAPABILITIES = [
  'msg_lifecycle_v1',
  'interrupt_receipt_v1',
  'interrupt_cancel_queued_v1',
];

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Captured before any test installs fake timers, which replace the global Date.
const realDateNow = Date.now;
// Per wait, below Jest's default 5 s test timeout, so a test's one long wait
// reports a stall here rather than as a generic Jest timeout.
const FLUSH_UNTIL_DEADLINE_MS = 4_000;

/**
 * Yields event-loop turns until `done` holds. The bound is wall-clock, not a
 * turn count: a session's startup can wait on real I/O, which a loaded CI
 * shard delivers after an unpredictable number of turns.
 */
async function flushUntil(done: () => boolean): Promise<void> {
  const deadline = realDateNow() + FLUSH_UNTIL_DEADLINE_MS;
  while (!done()) {
    if (realDateNow() > deadline) {
      throw new Error(
        `flushUntil: condition not met within ${FLUSH_UNTIL_DEADLINE_MS} ms`,
      );
    }
    await flush();
  }
}

function getNoWindow(): null {
  return null;
}
const noWindowPort = windowAgentInterfacePort(getNoWindow);

function createGate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(event: unknown, field: string): string | undefined {
  if (!isRecord(event)) return undefined;
  const value = event[field];
  return typeof value === 'string' ? value : undefined;
}

function claudeQueryParams(index = 0): Parameters<MockQuery>[0] {
  const params = mockQuery.mock.calls[index]?.[0];
  if (!params) throw new Error('Expected a Claude SDK query');
  return params;
}

interface ObservedEvent {
  readonly data: unknown;
  readonly context: AgentWorkerContext | undefined;
}

/** A session's event handler that records each frame and the worker context it ran in. */
function eventLog(): {
  events: ObservedEvent[];
  onEvent: (data: unknown) => void;
  seen: (predicate: (data: unknown) => boolean) => boolean;
} {
  const events: ObservedEvent[] = [];
  return {
    events,
    onEvent: (data: unknown): void => {
      events.push({ data, context: currentAgentWorkerContext() });
    },
    seen: (predicate) => events.some(({ data }) => predicate(data)),
  };
}

function isType(type: string): (data: unknown) => boolean {
  return (data) => readString(data, 'type') === type;
}

/** The Claude runtime's provider, constructed inside a turn run. */
async function providerInTurn(
  providerType: ClaudeHarnessProviderType,
): Promise<AgentProvider> {
  return runInAgentWorker(TURN, () =>
    getClaudeWorkerRuntime().providerFor(providerType, noWindowPort),
  );
}

async function openSession(
  providerType: ClaudeHarnessProviderType,
  chatId: string,
  onEvent: (data: unknown) => void,
  extra: Partial<AgentSessionOptions> = {},
): Promise<AgentSession> {
  const provider = await providerInTurn(providerType);
  return runInAgentWorkerSync(TURN, () =>
    provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId,
        ...(providerType === 'ollama'
          ? { model: OLLAMA_MODEL, providerType: 'ollama' as const }
          : {}),
        ...extra,
      },
      onEvent,
      noWindowPort,
    ),
  );
}

function sendInTurn(session: AgentSession, text: string, id: string): void {
  runInAgentWorkerSync(TURN, () => {
    session.sendMessage(text, { userMessageId: id });
  });
}

interface ScriptedQuery {
  readonly cancelAsyncMessage: jest.Mock;
  readonly interrupt: jest.Mock;
}

/** Scripts the SDK query: `run` reads the streamed prompt and yields frames. */
function scriptQuery(
  run: (
    input: AsyncIterator<unknown>,
    params: Parameters<MockQuery>[0],
  ) => AsyncGenerator<unknown, void>,
  control: Partial<ScriptedQuery> = {},
): ScriptedQuery {
  const query: ScriptedQuery = {
    cancelAsyncMessage: control.cancelAsyncMessage ?? jest.fn(),
    interrupt:
      control.interrupt ??
      jest.fn(() => Promise.resolve({ cancelled: [], still_queued: [] })),
  };
  mockQuery.mockImplementation((params) => {
    const input = params.prompt[Symbol.asyncIterator]();
    return Object.assign(run(input, params), query, {
      applyFlagSettings: jest.fn().mockResolvedValue(undefined),
      setPermissionMode: jest.fn().mockResolvedValue(undefined),
      setModel: jest.fn().mockResolvedValue(undefined),
    });
  });
  return query;
}

function initFrame(
  sessionId: string,
  promptValue: unknown,
): Record<string, unknown> {
  const uuid = readString(promptValue, 'uuid');
  return {
    type: 'system',
    subtype: 'init',
    parent_tool_use_id: null,
    session_id: sessionId,
    ...(uuid ? { user_message_uuid: uuid } : {}),
    capabilities: NATIVE_CAPABILITIES,
  };
}

function lastRootTerminal(events: readonly ObservedEvent[]): unknown {
  return events
    .map(({ data }) => data)
    .filter((data) => isRootTerminalChatEventData(data, undefined))
    .at(-1);
}

beforeEach(() => {
  mockResolveClaudeCompatibleInvocation.mockResolvedValue(OLLAMA_INVOCATION);
  mockLoadCachedInventory.mockResolvedValue(null);
});

afterEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  mockSpawnClaudeCodeProcessOffMain.mockReset();
  mockApprovalCheck.mockReset();
  mockResolveClaudeCompatibleInvocation.mockReset();
});

describe('daemon AI Credits child configuration parity (CAN-6997)', () => {
  const desktop = jest.requireActual<typeof AiCreditsRoutingModule>(
    '../agents/ai-credits-routing',
  );
  const baseUrl = 'http://127.0.0.1:12345/codex-gateway/fixture';
  const token = 'canopy-loopback-broker';
  const routeSecret = 'fixture-route-secret';
  const entry = (gatewayId: string): GatewayModelEntry => ({
    modelId: 'fixture-model',
    gatewayId,
    family: 'anthropic',
    recommendedHarness: 'claude',
    gatewayOnly: false,
    contextWindow: 200000,
    supportsPromptCaching: true,
    supportedThinkingLevels: [],
    toolSchemaProfile: 'standard',
  });

  for (const guest of [false, true]) {
    for (const model of ['anthropic/claude-sonnet', 'openai/gpt-fixture']) {
      it(`matches desktop Claude settings (${model}, guest=${guest}) with attribution injected by the daemon`, () => {
        const upstream = desktop.buildClaudeProxyEnvForBaseUrl(
          entry(model),
          token,
          baseUrl,
          undefined,
          { guestPrincipal: guest },
        );
        const { ANTHROPIC_CUSTOM_HEADERS, ...env } = upstream;
        expect(ANTHROPIC_CUSTOM_HEADERS).toBeTruthy();
        expect(
          managedAiCreditsChildValues({
            harness: 'claude',
            runtimeModel: model,
            baseUrl,
            authToken: token,
            routeSecret,
            guest,
          }),
        ).toEqual({
          env: {
            ...env,
            ANTHROPIC_CUSTOM_HEADERS: `x-canopy-broker-secret: ${routeSecret}`,
          },
        });
      });
    }
  }

  it('matches the desktop Codex provider block, with no upstream key or child-controlled attribution', () => {
    const upstream = desktop.buildCodexProxyConfigObject(
      entry('openai/gpt-fixture'),
      baseUrl,
    );
    const providers = upstream.model_providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers))
      throw new Error('Desktop model providers were not configured.');
    const provider = providers.canopy_ai_credits;
    if (
      !provider ||
      typeof provider !== 'object' ||
      Array.isArray(provider) ||
      typeof provider.name !== 'string'
    )
      throw new Error('Desktop AI Credits provider was not configured.');
    const { http_headers, ...providerSettings } = provider;
    expect(http_headers).toBeTruthy();
    expect(
      managedAiCreditsChildValues({
        harness: 'codex',
        runtimeModel: 'openai/gpt-fixture',
        baseUrl,
        authToken: token,
        routeSecret,
        guest: false,
        providerName: provider.name,
      }),
    ).toEqual({
      env: { CANOPY_MODEL_BROKER_SECRET: routeSecret },
      codexConfig: {
        ...upstream,
        model_providers: {
          canopy_ai_credits: {
            ...providerSettings,
            env_key: 'CANOPY_MODEL_BROKER_SECRET',
          },
        },
      },
    });
  });

  it.each<WorkOwner>([
    { kind: 'personal' },
    {
      kind: 'organization',
      organizationId: '11111111-2222-4333-8444-555555555555',
    },
  ])('matches desktop attribution for %j, including Unicode names', (owner) => {
    const attribution = {
      workspaceName: 'Work / España',
      worktreeName: 'branch & notes',
      organizationProjectId: 'project-1',
    };
    const serializedOwner =
      owner.kind === 'personal' ? 'personal' : `org:${owner.organizationId}`;
    expect(
      managedAiCreditsAttributionHeaders(serializedOwner, attribution),
    ).toEqual(
      Object.fromEntries(
        desktop.attributionHeaderPairs({ ...attribution, workOwner: owner }),
      ),
    );
  });

  describe('managed launch inspection uses the desktop decision path', () => {
    let mode: 'off' | 'on' | 'on-quota';
    let unreadable: boolean;
    let blocked: boolean;
    let degraded: boolean;
    let gatewayOnly: boolean;
    beforeEach(() => {
      mode = 'on';
      unreadable = false;
      blocked = false;
      degraded = false;
      gatewayOnly = false;
      jest
        .mocked(preferencesStore.readPreferencesFileDetailed)
        .mockImplementation(() =>
          Promise.resolve({
            authority: unreadable ? 'unreadable' : 'ok',
            preferences: {
              ...preferencesStore.DEFAULT_PREFERENCES,
              aiCreditsRoutingMode: mode,
            },
          }),
        );
      jest
        .spyOn(modelGatewayState, 'getModelGatewayRequirementForOwner')
        .mockResolvedValue({ kind: 'unrestricted' });
      jest
        .spyOn(modelGatewayState, 'readLocalModelGatewayProjectionStatus')
        .mockResolvedValue({ ok: true, projection: null });
      jest
        .spyOn(modelGatewayState, 'checkModelGatewayRoute')
        .mockResolvedValue({ ok: true, orgRoute: false });
      jest
        .spyOn(modelPolicyState, 'readModelPolicyDecision')
        .mockImplementation(() => Promise.resolve({ blocked, degraded }));
      jest
        .spyOn(modelPolicyState, 'isStoredModelPolicyReadDegraded')
        .mockReturnValue(false);
      jest
        .spyOn(modelPolicyState, 'readOrgModelPolicyActivityForStoredAccount')
        .mockResolvedValue({ active: true, degraded: false });
      jest
        .spyOn(cloudAccountStore, 'isCanopyCloudAccountReadDegraded')
        .mockReturnValue(false);
      jest
        .spyOn(gatewayAvailability, 'resolveGatewayModelEntry')
        .mockImplementation(() => ({
          ...entry('anthropic/claude-sonnet'),
          gatewayOnly,
        }));
      jest
        .spyOn(gatewayAvailability, 'isUnavailableModelSelection')
        .mockReturnValue(false);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      desktop.clearAiCreditsRoutingModeCache();
    });
    const inspect = (
      managed = true,
      cachedMode = mode,
    ): ReturnType<typeof desktop.inspectPipelineNativeRouting> => {
      desktop.setAiCreditsRoutingModeCache(cachedMode);
      return desktop.inspectPipelineNativeRouting(
        'fixture-model',
        'claude',
        { workOwner: { kind: 'personal' }, environmentRuntime: 'pipeline' },
        managed,
      );
    };
    it('admits explicit every-attempt credits, with the resolved gateway model and governance', async () => {
      await expect(inspect()).resolves.toEqual({
        kind: 'ai-credits',
        runtimeModel: 'anthropic/claude-sonnet',
        governed: true,
      });
      await expect(inspect(false)).resolves.toEqual({
        kind: 'app-dependent',
        reason: 'ai-credits',
      });
    });
    it('preserves governed native launches when credits are off', async () => {
      mode = 'off';
      await expect(inspect()).resolves.toEqual({
        kind: 'native',
        governed: true,
      });
    });
    it('does not freeze conditional on-quota consent into a surviving paid route', async () => {
      mode = 'on-quota';
      await expect(inspect()).resolves.toEqual({
        kind: 'app-dependent',
        reason: 'ai-credits',
      });
    });
    it('does not admit unreadable consent', async () => {
      unreadable = true;
      await expect(inspect()).resolves.toEqual({
        kind: 'app-dependent',
        reason: 'unknown',
      });
      expect(preferencesStore.readPreferencesFileDetailed).toHaveBeenCalled();
    });
    it('does not reuse cached paid consent after the authoritative choice is off', async () => {
      mode = 'off';
      await expect(inspect(true, 'on')).resolves.toEqual({
        kind: 'native',
        governed: true,
      });
      jest.mocked(getCodexGatewayProxyService).mockClear();
      await expect(
        desktop.resolveAiCreditsRoutingOverride(
          'fixture-model',
          'claude',
          undefined,
          'native-admission',
          { workOwner: { kind: 'personal' }, environmentRuntime: 'pipeline' },
        ),
      ).resolves.toBeNull();
      expect(getCodexGatewayProxyService).not.toHaveBeenCalled();
    });
    it('honors authoritative paid consent despite a stale off cache', async () => {
      await expect(inspect(true, 'off')).resolves.toEqual({
        kind: 'ai-credits',
        runtimeModel: 'anthropic/claude-sonnet',
        governed: true,
      });
    });
    it.each(['blocked', 'unknown'] as const)(
      'does not admit %s policy',
      async (state) => {
        blocked = state === 'blocked';
        degraded = state === 'unknown';
        await expect(inspect()).resolves.toEqual({
          kind: 'app-dependent',
          reason: 'policy',
        });
      },
    );
    it('does not admit policy whose activity re-read fails after the first read succeeds', async () => {
      mode = 'off';
      // A concurrent successful read may already have cleared the shared
      // degraded flag; the probe's own failed read still counts.
      jest
        .mocked(modelPolicyState.readOrgModelPolicyActivityForStoredAccount)
        .mockResolvedValue({ active: false, degraded: true });
      await expect(inspect()).resolves.toEqual({
        kind: 'app-dependent',
        reason: 'policy',
      });
    });
    it('keeps a mandatory gateway app-dependent rather than bypassing it', async () => {
      jest
        .mocked(modelGatewayState.getModelGatewayRequirementForOwner)
        .mockResolvedValue({ kind: 'enforced', organizationIds: ['org-1'] });
      await expect(inspect()).resolves.toEqual({
        kind: 'app-dependent',
        reason: 'gateway',
      });
    });
    it('does not mislabel a gateway-only model as a managed credits route', async () => {
      gatewayOnly = true;
      await expect(inspect()).resolves.toEqual({
        kind: 'app-dependent',
        reason: 'gateway',
      });
    });
  });
});

describe.each(['claude', 'ollama'] as const)(
  '%s sessions on the local worker',
  (providerType) => {
    it("streams every SDK frame to the session's event handler in order, inside the turn's worker context", async () => {
      const frames = [
        { type: 'assistant', marker: 'frame-2' },
        { type: 'assistant', marker: 'frame-3' },
        { type: 'stream_event', marker: 'frame-4' },
      ];
      scriptQuery(async function* (input) {
        const prompt = await input.next();
        if (prompt.done) return;
        yield { ...initFrame('stream', prompt.value), marker: 'frame-1' };
        yield {
          ...frames[0],
          parent_tool_use_id: null,
          session_id: 'stream',
          message: {
            id: 'msg-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'one' }],
          },
        };
        yield {
          ...frames[1],
          parent_tool_use_id: null,
          session_id: 'stream',
          message: {
            id: 'msg-2',
            role: 'assistant',
            content: [{ type: 'text', text: 'two' }],
          },
        };
        yield {
          ...frames[2],
          parent_tool_use_id: null,
          session_id: 'stream',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'three' },
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
          marker: 'frame-5',
          user_message_uuid: readString(prompt.value, 'uuid'),
        };
      });
      const log = eventLog();
      const session = await openSession(providerType, 'stream', log.onEvent);
      try {
        sendInTurn(session, 'Stream please', 'user-stream');
        await flushUntil(() => log.seen(isType('result')));

        const marked = log.events.filter(
          ({ data }) => readString(data, 'marker') !== undefined,
        );
        expect(marked.map(({ data }) => readString(data, 'marker'))).toEqual([
          'frame-1',
          'frame-2',
          'frame-3',
          'frame-4',
          'frame-5',
        ]);
        expect(marked.map(({ data }) => readString(data, 'type'))).toEqual([
          'system',
          'assistant',
          'assistant',
          'stream_event',
          'result',
        ]);
        for (const { context } of marked) expect(context).toEqual(TURN);
        if (providerType === 'ollama') {
          const options = claudeQueryParams().options;
          expect(options?.model).toBe('llama3');
          expect(options?.env?.ANTHROPIC_BASE_URL).toBe(
            'http://127.0.0.1:11434',
          );
        }
      } finally {
        await session.destroy();
      }
    });

    it('a resumed and a forked turn pass the SDK session id and fork options unchanged', async () => {
      scriptQuery(async function* () {
        await Promise.resolve();
        yield* [];
      });
      const resumed = await openSession(providerType, 'resumed', jest.fn(), {
        sdkSessionId: 'sdk-1',
      });
      await flushUntil(() => mockQuery.mock.calls.length > 0);
      const resumeOptions = claudeQueryParams(0).options;
      expect(resumeOptions).toEqual(
        expect.objectContaining({ resume: 'sdk-1' }),
      );
      expect(resumeOptions).not.toHaveProperty('forkSession');
      await resumed.destroy();

      const forked = await openSession(providerType, 'forked', jest.fn(), {
        sdkSessionId: 'sdk-1',
        claudeForkSession: true,
        claudeForkResumeAt: CHAIN_UUID,
      });
      await flushUntil(() => mockQuery.mock.calls.length > 1);
      expect(claudeQueryParams(1).options).toEqual(
        expect.objectContaining({
          resume: 'sdk-1',
          forkSession: true,
          resumeSessionAt: CHAIN_UUID,
        }),
      );
      await forked.destroy();
    });

    it('a tool approval keeps the turn running and resolves through the existing approval path', async () => {
      const approval = createGate();
      mockApprovalCheck.mockImplementation(async () => {
        await approval.promise;
        return { decision: 'allow' };
      });
      let permission: unknown;
      const permissionSettled = createGate();
      scriptQuery(async function* (input, params) {
        const prompt = await input.next();
        if (prompt.done) return;
        yield initFrame('approval', prompt.value);
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          session_id: 'approval',
          message: {
            id: 'msg-tool',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Bash',
                input: { command: 'ls' },
              },
            ],
          },
        };
        const canUseTool = params.options?.canUseTool;
        if (!canUseTool) throw new Error('Expected canUseTool');
        permission = await canUseTool(
          'Bash',
          { command: 'ls' },
          {
            signal: new AbortController().signal,
            toolUseID: 'tool-1',
            requestId: 'request-1',
          },
        );
        permissionSettled.release();
        yield {
          type: 'user',
          parent_tool_use_id: null,
          session_id: 'approval',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
            ],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
          user_message_uuid: readString(prompt.value, 'uuid'),
        };
      });
      const log = eventLog();
      const session = await openSession(providerType, 'approval', log.onEvent);
      try {
        sendInTurn(session, 'Run ls', 'user-approval');
        await flushUntil(() => mockApprovalCheck.mock.calls.length > 0);
        expect(mockApprovalCheck).toHaveBeenCalledWith(
          { kind: 'command', command: 'ls', cwd: '/tmp/repo' },
          expect.objectContaining({ toolUseId: 'tool-1' }),
        );
        await flush();
        expect(log.seen(isType('result'))).toBe(false);
        expect(
          log.events.some(
            ({ data }) =>
              isRecord(data) &&
              data.type === 'user' &&
              JSON.stringify(data).includes('tool_result'),
          ),
        ).toBe(false);

        approval.release();
        await permissionSettled.promise;
        expect(permission).toEqual(
          expect.objectContaining({ behavior: 'allow' }),
        );
        await flushUntil(() => log.seen(isType('result')));
        const types = log.events.map(({ data }) => readString(data, 'type'));
        const toolUse = log.events.findIndex(({ data }) =>
          JSON.stringify(data).includes('"tool_use"'),
        );
        const toolResult = log.events.findIndex(({ data }) =>
          JSON.stringify(data).includes('"tool_result"'),
        );
        expect(toolUse).toBeGreaterThanOrEqual(0);
        expect(toolResult).toBeGreaterThan(toolUse);
        expect(types.lastIndexOf('result')).toBeGreaterThan(toolResult);
      } finally {
        approval.release();
        await session.destroy();
      }
    });

    it('a session outside a worker run is refused before any query starts', async () => {
      await expect(
        getClaudeWorkerRuntime().providerFor(providerType, noWindowPort),
      ).rejects.toBeInstanceOf(AgentOutsideWorkerError);
      const provider = await providerInTurn(providerType);
      expect(() =>
        provider.createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'outside',
            ...(providerType === 'ollama' ? { model: OLLAMA_MODEL } : {}),
          },
          jest.fn(),
          noWindowPort,
        ),
      ).toThrow(AgentOutsideWorkerError);
      await flush();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  },
);

describe('claude sessions on the local worker', () => {
  it('steering input reaches the live Claude query while the turn run is live', async () => {
    const steeringPulled = createGate();
    const allowResult = createGate();
    let steeringMessage: unknown;
    scriptQuery(async function* (input) {
      const prompt = await input.next();
      if (prompt.done) return;
      yield initFrame('steer', prompt.value);
      const steer = await input.next();
      if (steer.done) return;
      steeringMessage = steer.value;
      steeringPulled.release();
      const uuid = readString(steer.value, 'uuid');
      if (uuid)
        yield {
          type: 'command_lifecycle',
          command_uuid: uuid,
          state: 'queued',
        };
      await allowResult.promise;
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        user_message_uuid: readString(prompt.value, 'uuid'),
      };
    });
    const log = eventLog();
    const session = await openSession('claude', 'steer', log.onEvent);
    try {
      sendInTurn(session, 'Start a long turn', 'user-steer');
      await flushUntil(() => log.seen(isType('system')));
      if (!session.submitSteeringInput)
        throw new Error('Expected a steerable Claude session');
      expect(currentAgentWorkerContext()).toBeUndefined();
      const admission = await session.submitSteeringInput(
        'steer me',
        STEER_ATTEMPT,
        'user-1',
      );
      await steeringPulled.promise;

      expect(admission).toMatchObject({
        kind: 'accepted',
        attemptId: STEER_ATTEMPT,
      });
      expect(JSON.stringify(steeringMessage)).toContain('steer me');
      expect(readString(steeringMessage, 'type')).toBe('user');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    } finally {
      allowResult.release();
      await session.destroy();
    }
  });

  it('proves refusal of staged input when inherited defaults change before handoff (CAN-7350)', async () => {
    let normalizationEntered = false;
    const finishNormalization = createGate();
    const finishQuery = createGate();
    const sdkReadPending = createGate();
    let handedOver: unknown;
    let defaultsRevision = 0;
    const original = await readPreferencesFile();
    await updatePreferencesFile((previous) => ({
      providerModelConfigDefaults: {
        ...previous.providerModelConfigDefaults,
        claude: { thinkingLevel: 'low' },
      },
    }));
    scriptQuery(async function* (input) {
      const prompt = await input.next();
      if (prompt.done) return;
      yield initFrame('defaults-race', prompt.value);
      sdkReadPending.release();
      const steer = await input.next();
      if (!steer.done) {
        handedOver = steer.value;
        yield {
          type: 'command_lifecycle',
          command_uuid: readString(steer.value, 'uuid'),
          state: 'queued',
        };
      }
      await finishQuery.promise;
    });
    const log = eventLog();
    const session = await openSession('claude', 'defaults-race', log.onEvent);
    const unsubscribe = subscribeCommittedPreferences(() => {
      defaultsRevision += 1;
    });
    try {
      sendInTurn(session, 'Start a long turn', 'root-1');
      await flushUntil(() => log.seen(isType('system')));
      await sdkReadPending.promise;
      mockLoadCachedInventory.mockImplementationOnce(() => {
        normalizationEntered = true;
        return finishNormalization.promise.then(() => null);
      });
      if (!session.submitSteeringInput)
        throw new Error('Expected a steerable session');
      const admittedRevision = defaultsRevision;
      const admission = session.submitSteeringInput(
        'Follow up with inherited defaults',
        STEER_ATTEMPT,
        'original-queued-message',
        session.getSteeringTarget?.(),
        {
          expectedTurnId: 'root-1',
          canHandoff: () => defaultsRevision === admittedRevision,
        },
      );
      await flushUntil(() => normalizationEntered);
      await updatePreferencesFile((previous) => ({
        providerModelConfigDefaults: {
          ...previous.providerModelConfigDefaults,
          claude: { thinkingLevel: 'high' },
        },
      }));
      expect(defaultsRevision).toBeGreaterThan(admittedRevision);
      finishNormalization.release();
      await expect(admission).resolves.toMatchObject({
        kind: 'rejected',
        attemptId: STEER_ATTEMPT,
        fallback: 'ordinary',
        refusal: { code: 'steering-unavailable' },
      });
      expect(handedOver).toBeUndefined();
      expect(session.hasPendingSteeringInput?.()).toBe(false);
      expect(log.seen(isType('result'))).toBe(false);
    } finally {
      finishNormalization.release();
      finishQuery.release();
      unsubscribe();
      await session.destroy();
      await updatePreferencesFile(() => ({
        providerModelConfigDefaults: original.providerModelConfigDefaults,
      }));
      await flushPreferencesWrites();
    }
  });

  it('a Stop interrupts the Claude query once and the turn settles cancelled', async () => {
    const initAdmitted = createGate();
    const interrupted = createGate();
    const query = scriptQuery(
      async function* (input) {
        const prompt = await input.next();
        if (prompt.done) return;
        yield initFrame('stop', prompt.value);
        await interrupted.promise;
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'aborted_streaming',
          user_message_uuid: readString(prompt.value, 'uuid'),
        };
      },
      {
        interrupt: jest.fn(() => {
          interrupted.release();
          return Promise.resolve({ cancelled: [], still_queued: [] });
        }),
      },
    );
    const log = eventLog();
    const session = await openSession('claude', 'stop', (data) => {
      log.onEvent(data);
      if (readString(data, 'session_id') === 'stop') initAdmitted.release();
    });
    try {
      sendInTurn(session, 'Start then stop', 'user-stop');
      await initAdmitted.promise;

      await expect(
        interruptClaudeSessionForStop(session),
      ).resolves.toMatchObject({ outcome: 'interrupted' });
      await flushUntil(() => lastRootTerminal(log.events) !== undefined);

      expect(query.interrupt).toHaveBeenCalledTimes(1);
      const terminal = lastRootTerminal(log.events);
      if (!isRecord(terminal))
        throw new Error('Expected a root terminal frame');
      expect(chatTurnOutcomeOf(terminal)).toBe('cancelled');
    } finally {
      await session.destroy();
    }
  });

  describe('hosted CLI ownership (CAN-4833)', () => {
    class FakeHostedCli extends EventEmitter {
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      killed = false;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly kill = jest.fn((signal: NodeJS.Signals): boolean => {
        void signal;
        this.killed = true;
        return true;
      });

      exit(code: number | null, signal: NodeJS.Signals | null): void {
        this.exitCode = code;
        this.signalCode = signal;
        this.emit('exit', code, signal);
      }
    }

    function spawnThroughSdk(
      params: Parameters<MockQuery>[0],
      cli: FakeHostedCli,
    ): void {
      mockSpawnClaudeCodeProcessOffMain.mockReturnValueOnce(cli);
      const spawn = params.options?.spawnClaudeCodeProcess;
      if (!spawn) throw new Error('Expected spawnClaudeCodeProcess option');
      spawn({
        command: '/mock/claude',
        args: [],
        cwd: '/tmp/repo',
        env: {},
        signal: new AbortController().signal,
      });
    }

    function scriptLoopThatExits(cli: FakeHostedCli): void {
      mockQuery.mockImplementation((params) => {
        spawnThroughSdk(params, cli);
        return Object.assign(
          (async function* (): AsyncGenerator<unknown, void> {
            await Promise.resolve();
            yield { type: 'system', subtype: 'init', session_id: 'resumed' };
          })(),
          {
            applyFlagSettings: jest.fn().mockResolvedValue(undefined),
            setPermissionMode: jest.fn().mockResolvedValue(undefined),
            setModel: jest.fn().mockResolvedValue(undefined),
          },
        );
      });
    }

    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('a CLI that outlives its query loop is SIGKILLed after the grace', async () => {
      const cli = new FakeHostedCli();
      scriptLoopThatExits(cli);
      const session = await openSession('claude', 'reap', jest.fn());
      await flushUntil(() => session.isDisposed?.() === true);
      expect(session.isDisposed?.()).toBe(true);

      expect(cli.stdin.writableEnded).toBe(true);
      expect(cli.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(4_999);
      expect(cli.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(cli.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('a CLI that exits within the grace is not killed', async () => {
      const cli = new FakeHostedCli();
      scriptLoopThatExits(cli);
      const session = await openSession('claude', 'reap-exits', jest.fn());
      await flushUntil(() => session.isDisposed?.() === true);
      cli.exit(0, null);
      jest.advanceTimersByTime(5_000);
      expect(cli.kill).not.toHaveBeenCalled();
    });
  });
});

describe('ollama sessions on the local worker', () => {
  it('cancelling an Ollama session ends its query and the turn settles cancelled', async () => {
    const initAdmitted = createGate();
    scriptQuery(async function* (input, params) {
      const prompt = await input.next();
      if (prompt.done) return;
      yield initFrame('ollama-cancel', prompt.value);
      const signal = params.options?.abortController?.signal;
      if (!signal) throw new Error('Expected the query abort signal');
      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      // The SDK ends an aborted query by throwing, as the CLI exits.
      const aborted = new Error('The operation was aborted');
      aborted.name = 'AbortError';
      throw aborted;
    });
    const log = eventLog();
    const session = await openSession('ollama', 'ollama-cancel', (data) => {
      log.onEvent(data);
      if (readString(data, 'session_id') === 'ollama-cancel')
        initAdmitted.release();
    });
    try {
      sendInTurn(session, 'Start then cancel', 'user-ollama-cancel');
      await initAdmitted.promise;
      await expect(interruptClaudeSessionForStop(session)).resolves.toEqual({
        outcome: 'not-native-claude',
      });

      const signal = claudeQueryParams().options?.abortController?.signal;
      if (!signal) throw new Error('Expected the query abort signal');
      const aborts = jest.fn();
      signal.addEventListener('abort', aborts);
      expect(signal.aborted).toBe(false);
      const cancelled = session.cancel();
      expect(signal.aborted).toBe(true);
      await cancelled;
      await flush();
      expect(aborts).toHaveBeenCalledTimes(1);

      await flushUntil(() => lastRootTerminal(log.events) !== undefined);
      const terminal = lastRootTerminal(log.events);
      if (!isRecord(terminal))
        throw new Error('Expected a root terminal frame');
      expect(chatTurnOutcomeOf(terminal)).toBe('cancelled');
    } finally {
      await session.destroy();
    }
  });
});
