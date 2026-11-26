/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  mkdir,
  mkdtemp,
  rm,
  readFile,
  readdir,
  rename,
} from 'node:fs/promises';
import { materializeSelectedCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { SessionEvent } from '@github/copilot-sdk';
import type { createManagedDelegationSession } from '../agents/delegation/service';
import type { CanopyWorktreeSessionRoute } from '../mcp/http-proxy-service';
import type * as CopilotConnectionModule from '../copilot/connection';
import type {
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { CursorCapabilityProjection } from '@canopy/desktop-shared/lib/cursor-capabilities';
import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import { authorizeCursorMcpTool } from '../cursor/tool-approval';
import {
  assertCopilotConnectionGeneration,
  openManagedCopilotRuntime,
} from '../copilot/connection';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { runCopilotTurn } from '@canopy/desktop-shared/node/copilot/turn-driver';
import { authorizeCopilotNativeTool } from '../copilot/tool-approval';
import { createApprovalSession } from '../approvals/approval-service';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import {
  releaseTurnLifecycleProducer,
  setTurnLifecycleSink,
} from '../agents/provider-turn-lifecycle';
import {
  AgentOutsideWorkerError,
  currentAgentWorkerContext,
  runInAgentWorker,
  runInAgentWorkerSync,
} from '../agent-runs/agent-worker-context';
import { getCopilotWorkerRuntime } from '../agent-runs/copilot-worker-runtime';
import { chatTurnOutcomeOf } from '../agent-runs/turn-runs';
import type {
  AgentSession,
  AgentSessionOptions,
  AgentSessionSendOptions,
} from '../agents/types';
import { KeyedAsyncLock } from '../lib/keyed-async-lock';
import * as atomicFile from '../lib/atomic-file';
import { windowAgentInterfacePort } from '../agents/agent-interface-port';

type DelegationSessionOptions = Parameters<
  typeof createManagedDelegationSession
>[0];

jest.mock('@canopy/execution-engine/node/rtk/rewrite', () => ({
  runRtkRewrite: jest.fn(() => Promise.resolve(undefined)),
}));

jest.mock('../lib/chat-tabs-reader', () => ({ readChatTabsFile: jest.fn() }));

jest.mock('../lib/atomic-file', () => {
  const actual = jest.requireActual<typeof atomicFile>('../lib/atomic-file');
  return {
    ...actual,
    writeFileAtomically: jest.fn(actual.writeFileAtomically),
  };
});

const mockCommittedNoticeIds = new Set<string>();
const mockConfirmNotice = jest.fn(
  (id: string): Promise<boolean> =>
    Promise.resolve(mockCommittedNoticeIds.has(id)),
);
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    hasTranscriptMessage: (
      scope: { projectId: string; worktreeId: string },
      chatId: string,
      messageId: string,
    ) =>
      scope.projectId === 'project' &&
      scope.worktreeId === 'worktree' &&
      chatId === 'chat' &&
      mockConfirmNotice(messageId),
  }),
}));

let mockCommands: CursorCapabilityProjection['commands'] = [];
const mockManagedDelegationEnabled = jest.fn(() => false);
const mockCreateManagedDelegationSession = jest.fn<
  Promise<unknown>,
  [DelegationSessionOptions]
>();
jest.mock('../agents/delegation/gate', () => ({
  managedDelegationEnabled: () => mockManagedDelegationEnabled(),
}));
jest.mock('../agents/delegation/service', () => ({
  createManagedDelegationSession: (options: DelegationSessionOptions) =>
    mockCreateManagedDelegationSession(options),
}));

const mockAssertCopilotModelAvailable = jest.fn<
  ReturnType<typeof CopilotConnectionModule.assertCopilotModelAvailable>,
  [string]
>((model) =>
  Promise.resolve({
    id: model,
    rawModelId: model,
    label: model,
    supportsVision: false,
    supportedThinkingLevels: [],
  }),
);
const mockWorkspace = { directory: '', cowork: true, localMemoryEnabled: true };
const mockRegisterCanopyWorktreeSessionRoute = jest.fn<
  Promise<string>,
  [CanopyWorktreeSessionRoute]
>(() => Promise.resolve('route'));
const mockProxy = {
  getMcpCapabilityDigests: jest.fn(() => ({})),
  getCanopyCapabilityDefinitions: jest.fn(() => []),
  registerCanopyWorktreeSessionRoute: mockRegisterCanopyWorktreeSessionRoute,
  getCanopyWorktreeMcpUrl: jest.fn(() => 'http://localhost:1234/main'),
  getCanopyWorktreeUiMcpUrl: jest.fn(() => 'http://localhost:1234/ui'),
  setSessionToolCallGate: jest.fn(),
  unregisterRoutesForSession: jest.fn(),
  unregisterCanopyWorktreeSessionRoute: jest.fn(),
};
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: () => mockProxy,
}));
const mockRequestAnswersFromRenderer = jest.fn(
  (options: { onAwaitingUser?: () => void }) => {
    options.onAwaitingUser?.();
    return Promise.resolve([{ selectedOptions: ['One'] }]);
  },
);
let mockConnectionGeneration = 1;
const mockRuntimeClose = jest.fn<Promise<void>, []>(() => Promise.resolve());
jest.mock('../copilot/connection', () => ({
  assertCopilotModelAvailable: (model: string) =>
    mockAssertCopilotModelAvailable(model),
  openManagedCopilotRuntime: jest.fn(() =>
    Promise.resolve({
      account: { login: 'test-account' },
      generation: mockConnectionGeneration,
      close: () => mockRuntimeClose(),
      // The handle runs the turn; the turn driver itself is mocked below.
      runTurn: (request: unknown) =>
        jest
          .requireMock<{
            runCopilotTurn: (request: unknown) => Promise<unknown>;
          }>('@canopy/desktop-shared/node/copilot/turn-driver')
          .runCopilotTurn(request),
    }),
  ),
  assertCopilotConnectionGeneration: jest.fn(),
  listCopilotModels: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/copilot/turn-driver', () => ({
  runCopilotTurn: jest.fn(() => Promise.resolve({ text: 'Done', usage: {} })),
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    dispose: jest.fn(),
    invalidatePending: jest.fn(),
  })),
}));
jest.mock('../copilot/tool-approval', () => ({
  authorizeCopilotNativeTool: jest.fn(),
}));
jest.mock('../cursor/tool-approval', () => ({
  authorizeCursorMcpTool: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: () => mockWorkspace.directory,
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeTargetIds: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: () => mockWorkspace.cowork,
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      localMemoryEnabled: mockWorkspace.localMemoryEnabled,
    }),
  ),
}));
type InheritedFixture = {
  skills: Array<{
    origin: 'claude' | 'cursor' | 'codex' | 'grok' | 'agents';
    name: string;
    sourceDir: string;
    description: string;
    userInvocable: boolean;
  }>;
  commands: Array<{
    origin: 'claude' | 'cursor';
    name: string;
    markdown: string;
    description: string;
  }>;
  skipped: Array<{ label: string; reason: string }>;
  fingerprint: string;
};
const emptyInherited = (): InheritedFixture => ({
  skills: [],
  commands: [],
  skipped: [],
  fingerprint: 'fp-empty',
});
let mockInherited: InheritedFixture = emptyInherited();
const mockDiscoverInherited = jest.fn(() => Promise.resolve(mockInherited));
jest.mock('@canopy/desktop-shared/node/cursor/inherited-capabilities', () => ({
  discoverInheritedCursorCapabilities: () => mockDiscoverInherited(),
  emptyInheritedCursorCapabilities: () => ({
    skills: [],
    commands: [],
    skipped: [],
    fingerprint: '',
  }),
}));
jest.mock('../cursor/inherited-roots', () => ({
  resolveInheritedCursorRoots: () => ({
    userHome: '/home/user',
    claudeConfigDir: '/home/user/.claude',
    codexHome: '/home/user/.codex',
  }),
}));
let mockClaudeEnabled: Map<string, string> | null = null;
jest.mock('../plugins/claude-enabled-plugins', () => ({
  readClaudeDisabledInstalledPlugins: (): string[] => [],
  readClaudeEnabledPlugins: () => mockClaudeEnabled,
}));
jest.mock('../plugins/inherited-cursor-plugins', () => ({
  inheritedClaudePluginRefs: (
    _marketplaces: unknown,
    _effective: unknown,
    _tombstones: unknown,
    enabled: Map<string, string> | null,
  ) =>
    enabled
      ? Array.from(enabled, ([key, installPath]) => {
          const [pluginName, marketplaceId] = key.split('@');
          return { marketplaceId, pluginName, installPath };
        })
      : [],
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: jest.fn(() =>
    Promise.resolve({ success: true, data: { marketplaces: [] } }),
  ),
}));
const mockRefreshInventory = jest.fn();
jest.mock('../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: (reason: string): void => {
    mockRefreshInventory(reason);
  },
}));
jest.mock('../plugins/request-chat-tombstones', () => ({
  requestChatTombstones: (apply: unknown) => apply,
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(() =>
    Promise.resolve({
      selections: {
        collectionIds: mockCommands.length ? ['selected'] : [],
        skillRefs: [],
        pluginRefs: [],
      },
    }),
  ),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn(() =>
    Promise.resolve({
      mcpServers: {},
      mcpServerBindings: {},
      cursorNotices: mockClaudeEnabled
        ? ['No supported capabilities in this Cursor session.']
        : [],
      cursorCapabilities: { skills: [], commands: mockCommands },
    }),
  ),
}));
jest.mock('@canopy/desktop-shared/node/cursor/capability-root', () => ({
  materializeSelectedCapabilityRoot: jest.fn(() =>
    Promise.resolve({
      warnings: [],
      commandIds: mockCommands.map((command) => command.id),
      skillIds: [],
    }),
  ),
}));
jest.mock('../pipelines/config-paths', () => ({ getEnhancedEnv: jest.fn() }));
jest.mock('../canopy-tools/session-runtime', () => ({
  requestAnswersFromRenderer: (options: { onAwaitingUser?: () => void }) =>
    mockRequestAnswersFromRenderer(options),
}));
const mockGetSessionKeyOwnership = jest.fn<string, unknown[]>(
  () => 'registered',
);
jest.mock('../agents/session-manager', () => ({
  buildSessionKey: () => 'project/worktree/chat',
  getSessionKeyOwnership: (...args: unknown[]): string =>
    mockGetSessionKeyOwnership(...args),
  drainChatSessionEvents: jest.fn(),
  markTurnActive: jest.fn(),
  markTurnAwaitingUser: jest.fn(),
  markTurnIdle: jest.fn(),
  recordSessionEvent: jest.fn(),
  registerSession: jest.fn(),
}));

const TURN = { kind: 'turn', runId: 'turn-1' } as const;
const USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function recordNotice(event: unknown): void {
  if (
    event &&
    typeof event === 'object' &&
    'messageId' in event &&
    typeof event.messageId === 'string'
  ) {
    mockCommittedNoticeIds.add(event.messageId);
  }
}

function isTerminal(event: unknown): boolean {
  return (
    !!event &&
    typeof event === 'object' &&
    'type' in event &&
    (event.type === 'result' || event.type === 'error')
  );
}

describe('Copilot turns on the local worker (CAN-4119)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockConnectionGeneration = 1;
    const emptyTabs: ChatTabsFile = { version: 1, tabs: [], activeTabId: '' };
    // Preserve the legacy nullable active-tab fixture after the type tightened.
    Reflect.set(emptyTabs, 'activeTabId', null);
    jest.mocked(readChatTabsFile).mockResolvedValue(emptyTabs);
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, []);
      return {
        sessionId: 'fixture-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    mockCommands = [];
    mockInherited = emptyInherited();
    mockClaudeEnabled = null;
    mockDiscoverInherited.mockImplementation(() =>
      Promise.resolve(mockInherited),
    );
    mockWorkspace.cowork = true;
    mockManagedDelegationEnabled.mockReturnValue(false);
    mockWorkspace.directory = await mkdtemp(
      join(tmpdir(), 'copilot-session-test-'),
    );
  });

  afterEach(async () => {
    await rm(mockWorkspace.directory, { recursive: true, force: true });
  });

  async function startSession(
    onEvent: (event: unknown) => void,
    options: Partial<AgentSessionOptions> = {},
  ): Promise<{ session: AgentSession }> {
    const session = await runInAgentWorker(TURN, async () => {
      const provider = await getCopilotWorkerRuntime().providerFor(
        'copilot',
        windowAgentInterfacePort(() => null),
      );
      return provider.createSession(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          cwd: mockWorkspace.directory,
          model: 'copilot:gpt-5',
          ...options,
        },
        onEvent,
        windowAgentInterfacePort(() => null),
      );
    });
    return { session };
  }

  function send(
    session: AgentSession,
    text: string,
    options?: AgentSessionSendOptions,
  ): void {
    runInAgentWorkerSync(TURN, () => session.sendMessage(text, options));
  }

  async function settled(events: unknown[], from: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (events.slice(from).some(isTerminal)) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async function sendAndSettle(
    session: AgentSession,
    events: unknown[],
    text: string,
    options?: AgentSessionSendOptions,
  ): Promise<void> {
    const from = events.length;
    send(session, text, options);
    await settled(events, from);
  }

  it("streams every native event to the session's event handler in order, inside the turn's worker context", async () => {
    const events: unknown[] = [];
    const contexts: unknown[] = [];
    const { session } = await startSession((event) => {
      events.push(event);
      contexts.push(currentAgentWorkerContext());
    });
    jest.mocked(runCopilotTurn).mockImplementationOnce(async (config) => {
      await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, []);
      for (const messageId of ['m1', 'm2', 'm3'])
        await config.emit({ type: 'canopy_assistant_patch', messageId });
      return { sessionId: 'fixture-session', text: 'Done', usage: USAGE };
    });
    try {
      await sendAndSettle(session, events, 'Stream');
      const patches = events.filter(
        (event) =>
          !!event &&
          typeof event === 'object' &&
          'messageId' in event &&
          typeof event.messageId === 'string' &&
          /^m[123]$/.test(event.messageId),
      );
      expect(patches).toEqual([
        expect.objectContaining({ messageId: 'm1', provider: 'copilot' }),
        expect.objectContaining({ messageId: 'm2', provider: 'copilot' }),
        expect.objectContaining({ messageId: 'm3', provider: 'copilot' }),
      ]);
      const last = events.findIndex(isTerminal);
      expect(last).toBeGreaterThan(events.indexOf(patches[2]));
      expect(contexts).not.toHaveLength(0);
      for (const context of contexts) expect(context).toEqual(TURN);
    } finally {
      await session.destroy();
    }
  });

  it.each([
    { requested: 'low', expected: 'low' },
    { requested: 'medium', expected: 'medium' },
    { requested: 'max', expected: 'high' },
  ] as const)(
    'a turn sends the raw Copilot model id and the clamped reasoning effort ($requested → $expected)',
    async ({ requested, expected }) => {
      mockAssertCopilotModelAvailable.mockResolvedValueOnce({
        id: 'gpt-5',
        rawModelId: 'gpt-5',
        label: 'GPT-5',
        supportsVision: false,
        supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
      });
      const events: unknown[] = [];
      const { session } = await startSession((event) => events.push(event), {
        thinkingLevel: requested,
      });
      try {
        await sendAndSettle(session, events, 'Hello');
        expect(events.at(-1)).toMatchObject({
          type: 'result',
          is_error: false,
        });
        const config = jest.mocked(runCopilotTurn).mock.calls[0]?.[0];
        expect(config?.reasoningEffort).toBe(expected);
        expect(config?.model).toBe('gpt-5');
      } finally {
        await session.destroy();
      }
    },
  );

  it('a non-Copilot model or AI-credits routing fails the turn before the runtime opens', async () => {
    for (const options of [
      { model: 'claude-sonnet-4' },
      {
        model: 'copilot:gpt-5',
        aiCreditsRouting: { active: true },
      } as Partial<AgentSessionOptions>,
    ]) {
      const events: unknown[] = [];
      const { session } = await startSession(
        (event) => events.push(event),
        options,
      );
      try {
        await sendAndSettle(session, events, 'Hello');
        expect(events.at(-1)).toMatchObject({
          type: 'error',
          error:
            'Choose a GitHub Copilot model to use Copilot account billing.',
        });
      } finally {
        await session.destroy();
      }
    }
    expect(openManagedCopilotRuntime).not.toHaveBeenCalled();
    mockAssertCopilotModelAvailable.mockRejectedValueOnce(
      new Error('This Copilot model is unavailable.'),
    );
    const events: unknown[] = [];
    const { session } = await startSession((event) => events.push(event), {
      model: 'copilot:stale-model',
    });
    try {
      await sendAndSettle(session, events, 'Do not send this prompt');
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        error: 'This Copilot model is unavailable.',
      });
      expect(runCopilotTurn).not.toHaveBeenCalled();
    } finally {
      await session.destroy();
    }
  });

  it.each([true, false])(
    'a saved session resumes with its id, capability digests and committed notices (first notice commit succeeded: %s)',
    async (firstNoticeCommitted) => {
      mockCommittedNoticeIds.clear();
      mockClaudeEnabled = new Map([['test@market', '/plugin']]);
      let connected = false;
      const savedTurn = async (
        config: Parameters<typeof runCopilotTurn>[0],
      ): ReturnType<typeof runCopilotTurn> => {
        await config.onToolsReady?.({ version: 1, digest: 'c'.repeat(64) }, [
          { name: 'slack', status: connected ? 'connected' : 'needs-auth' },
        ]);
        await config.onSession('new-session');
        return { sessionId: 'new-session', text: 'Done', usage: USAGE };
      };
      jest.mocked(runCopilotTurn).mockImplementationOnce(savedTurn);
      const events: unknown[] = [];
      const first = await startSession((event) => {
        events.push(event);
        if (firstNoticeCommitted) recordNotice(event);
      });
      try {
        mockInherited.skipped = [
          { label: 'sample skill', reason: 'unreadable' },
        ];
        const setup = Promise.withResolvers<void>();
        jest
          .mocked(materializeSelectedCapabilityRoot)
          .mockImplementationOnce(async (_root, _projection, options) => {
            const signal = options?.signal;
            if (!signal) throw new Error('Expected a cancellable setup');
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new Error('Capability setup cancelled')),
                {
                  once: true,
                },
              );
              setup.resolve();
            });
          });
        send(first.session, 'Start setup');
        await setup.promise;
        await first.session.cancel();
        expect(events.at(-1)).toMatchObject({ subtype: 'cancelled' });
        expect(JSON.stringify(events)).not.toContain('sample skill');
        await sendAndSettle(first.session, events, 'Hello');
        expect(JSON.stringify(events)).toContain(
          'could not be loaded: sample skill',
        );
        expect(JSON.stringify(events)).toContain('No supported capabilities');
        expect(JSON.stringify(events)).toContain('needs sign-in');
        const root = join(mockWorkspace.directory, 'copilot-sessions');
        const [profile] = await readdir(root);
        const binding: unknown = JSON.parse(
          await readFile(join(root, profile, 'host-session.json'), 'utf8'),
        );
        expect(binding).toMatchObject({
          version: 2,
          sessionId: 'new-session',
          nativeToolSnapshot: { version: 1, digest: 'c'.repeat(64) },
          capabilitySnapshot: { version: 1 },
        });
        expect(JSON.stringify(binding)).toMatch(/"digest":"[a-f0-9]{64}"/);
        expect(JSON.stringify(binding)).not.toContain('ghu_test');
      } finally {
        await first.session.destroy();
      }
      jest.mocked(runCopilotTurn).mockImplementationOnce(savedTurn);
      const resumed: unknown[] = [];
      const second = await startSession(
        (event) => {
          resumed.push(event);
          recordNotice(event);
        },
        {
          sdkSessionId: 'new-session',
        },
      );
      try {
        await sendAndSettle(second.session, resumed, 'Continue');
        expect(resumed.at(-1)).toMatchObject({
          type: 'result',
          is_error: false,
        });
        expect(jest.mocked(runCopilotTurn).mock.calls[1]?.[0].sessionId).toBe(
          'new-session',
        );
        for (const text of [
          'No supported capabilities',
          'sample skill',
          'needs sign-in',
        ]) {
          expect(JSON.stringify(resumed).includes(text)).toBe(
            !firstNoticeCommitted,
          );
        }
        expect(JSON.stringify(resumed)).not.toContain('capabilities-changed');
        connected = true;
        jest.mocked(runCopilotTurn).mockImplementationOnce(savedTurn);
        await sendAndSettle(second.session, resumed, 'Try Slack again');
        expect(JSON.stringify(resumed)).toContain('connected again');
      } finally {
        await second.session.destroy();
      }
    },
  );

  it.each([false, true, 'native digest change'] as const)(
    'keeps confirmed notices if tool setup fails before onSession (existing binding: %s)',
    async (hasBinding) => {
      mockCommittedNoticeIds.clear();
      const events: unknown[] = [];
      const observer = (event: unknown) => {
        recordNotice(event);
        events.push(event);
      };
      const { session } = await startSession(observer);
      const savedId = 'setup-test';
      const outageDigest =
        hasBinding === 'native digest change' ? 'b'.repeat(64) : 'a'.repeat(64);
      try {
        if (hasBinding) {
          jest.mocked(runCopilotTurn).mockImplementationOnce(async (config) => {
            await config.onToolsReady?.(
              { version: 1, digest: 'a'.repeat(64) },
              [],
            );
            await config.onSession(savedId);
            return { sessionId: savedId, text: 'Done', usage: USAGE };
          });
          await sendAndSettle(session, events, 'Start chat');
          expect(events.at(-1)).toMatchObject({
            type: 'result',
            is_error: false,
          });
        }
        if (hasBinding !== 'native digest change')
          mockClaudeEnabled = new Map([['test@market', '/plugin']]);
        jest.mocked(runCopilotTurn).mockImplementationOnce(async (config) => {
          await config.onToolsReady?.({ version: 1, digest: outageDigest }, [
            { name: 'slack', status: 'needs-auth' },
          ]);
          throw new Error('Setup failed before onSession');
        });
        await sendAndSettle(session, events, 'Send with plugin');
        expect(events.at(-1)).toMatchObject({
          type: 'error',
          error: 'Setup failed before onSession',
        });
        if (hasBinding !== 'native digest change')
          expect(JSON.stringify(events)).toContain('No supported capabilities');
        expect(JSON.stringify(events)).toContain('needs sign-in');
      } finally {
        await session.destroy();
      }
      events.length = 0;
      const retry = await startSession(
        observer,
        hasBinding ? { sdkSessionId: savedId } : {},
      );
      try {
        jest.mocked(runCopilotTurn).mockImplementationOnce(async (config) => {
          await config.onToolsReady?.({ version: 1, digest: outageDigest }, [
            { name: 'slack', status: 'needs-auth' },
          ]);
          await config.onSession(savedId);
          return { sessionId: savedId, text: 'Done', usage: USAGE };
        });
        await sendAndSettle(retry.session, events, 'Retry after restart');
        expect(events.at(-1)).toMatchObject({
          type: 'result',
          is_error: false,
        });
        expect(JSON.stringify(events)).not.toContain(
          'No supported capabilities',
        );
        expect(JSON.stringify(events)).not.toContain('needs sign-in');
        if (hasBinding === 'native digest change')
          expect(JSON.stringify(events)).not.toContain(
            'Selected capabilities changed',
          );
      } finally {
        await retry.session.destroy();
      }
    },
  );

  it('remembers notices across repeated read failures and saves them when storage recovers', async () => {
    const events: unknown[] = [];
    const receive = (event: unknown) => {
      recordNotice(event);
      events.push(event);
    };
    mockClaudeEnabled = new Map([['test@market', '/plugin']]);
    let connected = false;
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, [
        { name: 'slack', status: connected ? 'connected' : 'needs-auth' },
      ]);
      return { sessionId: 'storage-test', text: 'Done', usage: USAGE };
    });
    const seed = await startSession(receive);
    await sendAndSettle(seed.session, events, 'Seed notice history');
    await seed.session.destroy();
    const root = join(mockWorkspace.directory, 'copilot-sessions');
    const [profile] = await readdir(root);
    const name = (await readdir(join(root, profile))).find((file) =>
      file.startsWith('notices-'),
    );
    if (!name) throw new Error('Expected a notice history file');
    const history = join(root, profile, name);
    await rename(history, history + '.saved');
    connected = true;
    await mkdir(history);
    const resumed = await startSession(receive);
    try {
      for (const first of [true, false]) {
        events.length = 0;
        await sendAndSettle(resumed.session, events, 'Unreadable history');
        expect(
          JSON.stringify(events).includes('No supported capabilities'),
        ).toBe(first);
      }
      await rm(history, { recursive: true });
      await rename(history + '.saved', history);
      events.length = 0;
      connected = false;
      await sendAndSettle(
        resumed.session,
        events,
        'Retry after storage recovery',
      );
      expect(JSON.stringify(events)).toContain('needs sign-in');
      expect(JSON.parse(await readFile(history, 'utf8'))).toMatchObject({
        announcedNotices: [expect.any(String)],
      });
    } finally {
      await resumed.session.destroy();
    }
  });

  it.each(['failed', 'late', 'late failure'] as const)(
    'retains the latest MCP notice history across a %s save and a restart',
    async (scenario) => {
      const realWrite =
        jest.requireActual<typeof atomicFile>(
          '../lib/atomic-file',
        ).writeFileAtomically;
      const firstWrite = Promise.withResolvers<void>();
      const releaseWrite = Promise.withResolvers<void>();

      let writing = false;
      let overlap = false;
      let lateCallback: Promise<void> | undefined;
      const writer = jest.mocked(atomicFile.writeFileAtomically);
      writer.mockImplementationOnce(async (...args) => {
        firstWrite.resolve();
        if (scenario === 'failed') throw new Error('Simulated storage outage');
        writing = true;
        try {
          await releaseWrite.promise;
          if (scenario === 'late failure')
            throw new Error('Late storage outage');
          return await realWrite(...args);
        } finally {
          writing = false;
        }
      });
      writer.mockImplementation(async (...args) => {
        if (writing) overlap = true;
        return realWrite(...args);
      });
      const events: unknown[] = [];
      const receive = (event: unknown) => {
        recordNotice(event);
        events.push(event);
      };
      let connected = false;
      const savedTurn = async (
        config: Parameters<typeof runCopilotTurn>[0],
      ): ReturnType<typeof runCopilotTurn> => {
        await config.onToolsReady?.({ version: 1, digest: 'c'.repeat(64) }, [
          { name: 'slack', status: connected ? 'connected' : 'needs-auth' },
        ]);
        await config.onSession('history-retry');
        return { sessionId: 'history-retry', text: 'Done', usage: USAGE };
      };
      jest.mocked(runCopilotTurn).mockImplementation(savedTurn);
      const first = await startSession(receive);
      try {
        if (scenario !== 'failed') {
          jest.mocked(runCopilotTurn).mockImplementationOnce(async (config) => {
            lateCallback = Promise.resolve(
              config.onToolsReady?.({ version: 1, digest: 'c'.repeat(64) }, [
                { name: 'slack', status: 'needs-auth' },
              ]),
            );
            await firstWrite.promise;
            throw new Error('Tool setup timed out');
          });
        }
        await sendAndSettle(first.session, events, 'Check tools');
        expect(JSON.stringify(events)).toContain('needs sign-in');
        events.length = 0;
        connected = scenario === 'late';
        const lock = jest.spyOn(KeyedAsyncLock.prototype, 'run');
        try {
          send(first.session, 'Check again');
          if (scenario !== 'failed') {
            const deadline = AbortSignal.timeout(2000);
            while (
              !lock.mock.calls.length &&
              jest.mocked(runCopilotTurn).mock.calls.length < 2
            ) {
              deadline.throwIfAborted();
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
            }
            releaseWrite.resolve();
            await lateCallback;
          }
        } finally {
          lock.mockRestore();
        }
        await settled(events, 0);
        expect(events.at(-1)).toMatchObject({
          type: 'result',
          is_error: false,
        });
        expect(overlap).toBe(false);
      } finally {
        releaseWrite.resolve();
        await first.session.destroy();
        writer.mockImplementation(realWrite);
      }
      events.length = 0;
      connected = false;
      const resumed = await startSession(receive, {
        sdkSessionId: 'history-retry',
      });
      try {
        await sendAndSettle(resumed.session, events, 'Check after restart');
        expect(events.at(-1)).toMatchObject({
          type: 'result',
          is_error: false,
        });
        expect(JSON.stringify(events).includes('needs sign-in')).toBe(
          scenario === 'late',
        );
      } finally {
        await resumed.session.destroy();
      }
    },
  );

  it.each([true, false])(
    'retries a missing recovery notice or announces a renewed outage (outage recurs: %s)',
    async (recurs) => {
      const events: unknown[] = [];
      const receive = (event: unknown) => {
        recordNotice(event);
        events.push(event);
      };
      let connected = false;
      jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
        await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, [
          { name: 'slack', status: connected ? 'connected' : 'needs-auth' },
        ]);
        return { sessionId: 'recovery', text: 'Done', usage: USAGE };
      });
      const first = await startSession(receive);
      try {
        await sendAndSettle(first.session, events, 'Initial outage');
        expect(JSON.stringify(events)).toContain('needs sign-in');
        events.length = 0;
        connected = true;
        mockConfirmNotice.mockResolvedValueOnce(false);
        await sendAndSettle(first.session, events, 'First recovery');
        expect(JSON.stringify(events)).toContain('connected again');
      } finally {
        await first.session.destroy();
      }
      events.length = 0;
      connected = !recurs;
      const next = await startSession(receive);
      try {
        await sendAndSettle(next.session, events, 'Check after restarting');
        expect(JSON.stringify(events)).toContain(
          recurs ? 'needs sign-in' : 'connected again',
        );
        events.length = 0;
        await sendAndSettle(next.session, events, 'Unchanged');
        expect(JSON.stringify(events)).not.toContain('needs sign-in');
        expect(JSON.stringify(events)).not.toContain('connected again');
      } finally {
        await next.session.destroy();
      }
    },
  );

  it.each([true, false, 'failed write', 'late confirmation'] as const)(
    'restores a confirmed notice when the provider changes during a save (cancel queued read: %s)',
    async (cancelRead) => {
      const writeStarted = Promise.withResolvers<void>();
      const releaseWrite = Promise.withResolvers<void>();
      const realWrite =
        jest.requireActual<typeof atomicFile>(
          '../lib/atomic-file',
        ).writeFileAtomically;
      if (cancelRead === 'late confirmation') {
        mockConfirmNotice.mockImplementationOnce(async (id) => {
          writeStarted.resolve();
          await releaseWrite.promise;
          return mockCommittedNoticeIds.has(id);
        });
      } else
        jest
          .mocked(atomicFile.writeFileAtomically)
          .mockImplementationOnce(async (...args) => {
            writeStarted.resolve();
            await releaseWrite.promise;
            if (cancelRead === 'failed write')
              throw new Error('Storage offline');
            return realWrite(...args);
          });
      const events: unknown[] = [];
      const receive = (event: unknown) => {
        recordNotice(event);
        events.push(event);
      };
      const first = await startSession(receive);
      const readiness = [{ name: 'slack', status: 'needs-auth' }] as const;
      const manifest = { version: 1, digest: 'c'.repeat(64) } as const;
      jest
        .mocked(runCopilotTurn)
        .mockImplementationOnce(async (config) => {
          void config.onToolsReady?.(manifest, readiness);
          await writeStarted.promise;
          throw new Error('Tool setup timed out');
        })
        .mockImplementation(async (config) => {
          await config.onToolsReady?.(manifest, readiness);
          return { sessionId: 'replacement', text: 'Done', usage: USAGE };
        });
      await sendAndSettle(first.session, events, 'Check tools');
      expect(JSON.stringify(events)).toContain('needs sign-in');
      await first.session.destroy();
      mockGetSessionKeyOwnership.mockImplementation((_key, session) =>
        session === first.session ? 'replaced' : 'registered',
      );
      events.length = 0;
      if (cancelRead === 'failed write') mockConnectionGeneration++;
      const next = await startSession(receive);
      const lock = jest.spyOn(KeyedAsyncLock.prototype, 'run');
      try {
        send(next.session, 'Check again');
        const deadline = AbortSignal.timeout(2000);
        while (
          !lock.mock.calls.some(([key]) => basename(key).startsWith('notices-'))
        ) {
          deadline.throwIfAborted();
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        if (cancelRead === true) {
          let timedOut = false;
          const fallback = setTimeout(() => {
            timedOut = true;
            releaseWrite.resolve();
          }, 1000);
          try {
            await next.session.cancel();
            expect(timedOut).toBe(false);
            expect(events.at(-1)).toMatchObject({ subtype: 'cancelled' });
          } finally {
            clearTimeout(fallback);
          }
          events.length = 0;
          send(next.session, 'Retry after Stop');
        }
        releaseWrite.resolve();
        await settled(events, 0);
        expect(events.at(-1)).toMatchObject({
          type: 'result',
          is_error: false,
        });
        expect(JSON.stringify(events)).not.toContain('needs sign-in');
      } finally {
        releaseWrite.resolve();
        lock.mockRestore();
        mockGetSessionKeyOwnership.mockImplementation(() => 'registered');
        await next.session.destroy();
      }
    },
  );

  it('a missing native session starts a new conversation with the lost-context notice', async () => {
    const events: unknown[] = [];
    const { session } = await startSession((event) => events.push(event), {
      sdkSessionId: 'lost-session',
    });
    try {
      await sendAndSettle(session, events, 'Continue');
      expect(events.at(-1)).toMatchObject({ type: 'result', is_error: false });
      expect(
        jest.mocked(runCopilotTurn).mock.calls.at(-1)?.[0].sessionId,
      ).toBeUndefined();
      expect(JSON.stringify(events)).toContain('previous conversation');
    } finally {
      await session.destroy();
    }
  });

  test.each(['none', 'before-acceptance', 'after-acceptance'] as const)(
    "a forked chat's first prompt carries the inherited context once (%s)",
    async (failure) => {
      const tab: PersistedChatTab = {
        id: 'chat',
        title: 'Fork',
        createdAt: '2026-10-12T00:00:00Z',
        providerType: 'copilot',
        model: 'copilot:model',
        forkedFrom: {
          projectId: 'source-project',
          worktreeId: 'source-worktree',
          chatId: 'source-chat',
          atMessageId: 'a1',
        },
        messages: [
          {
            id: 'u1',
            role: 'user',
            blocks: [{ type: 'text', text: 'COPILOT_FORK_HISTORY_CANARY' }],
            timestamp: 1,
          },
          {
            id: 'a1',
            role: 'assistant',
            blocks: [
              { type: 'text', text: 'Remembered the original decision.' },
            ],
            timestamp: 2,
          },
          {
            id: 'later',
            role: 'user',
            blocks: [{ type: 'text', text: 'COPILOT_FUTURE_SOURCE_CANARY' }],
            timestamp: 3,
          },
        ],
      };
      const tabs: ChatTabsFile = {
        version: 1,
        tabs: [tab],
        activeTabId: 'chat',
      };
      jest.mocked(readChatTabsFile).mockResolvedValue(tabs);
      let nativeTurns = 0;
      const submittedPrompts: string[] = [];
      jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
        nativeTurns++;
        await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, []);
        await config.onSession('fork-native-session');
        submittedPrompts.push(
          (await config.preparePrompt?.('fork-native-session')) ??
            config.prompt,
        );
        if (failure === 'before-acceptance' && nativeTurns === 1)
          throw new Error('fixture send was rejected');
        await config.onPromptAccepted?.('fork-native-session');
        if (failure === 'after-acceptance' && nativeTurns === 1)
          throw new Error('fixture model failed after accepting the prompt');
        return { sessionId: 'fork-native-session', text: 'Done', usage: USAGE };
      });
      const events: unknown[] = [];
      const { session } = await startSession((event) => events.push(event), {
        model: 'copilot:model',
      });
      const forkSend = () =>
        sendAndSettle(session, events, 'Continue the selected conversation', {
          userMessageId: 'current',
        });
      try {
        await forkSend();
        const first = submittedPrompts[0];
        expect(first).toContain('COPILOT_FORK_HISTORY_CANARY');
        expect(first).not.toContain('COPILOT_FUTURE_SOURCE_CANARY');
        expect(first).toContain('historical records');
        expect(first).toContain('Continue the selected conversation');
        expect(readChatTabsFile).toHaveBeenCalledWith('project', 'worktree', {
          chatIds: ['chat'],
          fullTranscript: true,
        });
        if (failure !== 'none') {
          await forkSend();
          if (failure === 'before-acceptance')
            expect(submittedPrompts.at(-1)).toContain(
              'COPILOT_FORK_HISTORY_CANARY',
            );
          else
            expect(submittedPrompts.at(-1)).not.toContain(
              'COPILOT_FORK_HISTORY_CANARY',
            );
        }
        await forkSend();
        expect(submittedPrompts.at(-1)).not.toContain(
          'COPILOT_FORK_HISTORY_CANARY',
        );
        expect(
          jest.mocked(runCopilotTurn).mock.calls.at(-1)?.[0].sessionId,
        ).toBe('fork-native-session');
      } finally {
        await session.destroy();
      }
    },
  );

  it.each(['cancelled', 'failed'] as const)(
    "cancel aborts the turn's signal once and the turn settles cancelled (%s)",
    async (outcome) => {
      const scope = {
        projectId: `copilot-${outcome}-project`,
        worktreeId: `copilot-${outcome}-worktree`,
        chatId: `copilot-${outcome}-chat`,
      };
      const lifecycleEvents: ChatTurnLifecycleEvent[] = [];
      setTurnLifecycleSink((event): void => {
        lifecycleEvents.push(event);
      });
      let markRunStarted: () => void = () => undefined;
      const runStarted = new Promise<void>((resolve) => {
        markRunStarted = resolve;
      });
      let aborts = 0;
      let turnSignal: AbortSignal | undefined;
      if (outcome === 'cancelled') {
        jest.mocked(runCopilotTurn).mockImplementationOnce(
          (options) =>
            new Promise<Awaited<ReturnType<typeof runCopilotTurn>>>(
              (_resolve, reject) => {
                turnSignal = options.signal;
                options.signal.addEventListener('abort', () => {
                  aborts++;
                  reject(new Error('Copilot run stopped.'));
                });
                markRunStarted();
              },
            ),
        );
      } else {
        mockAssertCopilotModelAvailable.mockRejectedValueOnce(
          new Error('Copilot model unavailable.'),
        );
      }
      const events: unknown[] = [];
      const { session } = await startSession(
        (event) => events.push(event),
        scope,
      );
      try {
        send(session, 'Continue this turn', {
          userMessageId: `copilot-${outcome}-message`,
        });
        if (outcome === 'cancelled') {
          await runStarted;
          await session.cancel();
        }
        await settled(events, 0);
        const final = events.at(-1);
        expect(final).toMatchObject({
          type: outcome === 'cancelled' ? 'result' : 'error',
        });
        if (outcome === 'cancelled') {
          expect(turnSignal?.aborted).toBe(true);
          expect(aborts).toBe(1);
          expect(final).toMatchObject({
            type: 'result',
            subtype: 'cancelled',
            result: 'Turn cancelled',
          });
          if (!final || typeof final !== 'object')
            throw new Error('Missing final frame');
          expect(chatTurnOutcomeOf({ ...final })).toBe('cancelled');
        }
        expect(lifecycleEvents).toContainEqual(
          expect.objectContaining({
            type: 'TurnEnded',
            outcome: outcome === 'cancelled' ? 'cancelled' : 'failed',
            source: 'result',
          }),
        );
        expect(lifecycleEvents.at(-1)).toMatchObject({
          type: 'SessionState',
          state: 'idle',
        });
      } finally {
        await session.destroy();
        setTurnLifecycleSink(null);
        releaseTurnLifecycleProducer('copilot', scope);
      }
    },
  );

  it('destroy cancels the turn and closes the runtime', async () => {
    let markRunStarted: () => void = () => undefined;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    jest.mocked(runCopilotTurn).mockImplementationOnce(
      (options) =>
        new Promise<Awaited<ReturnType<typeof runCopilotTurn>>>(
          (_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(new Error('Copilot run stopped.')),
              { once: true },
            );
            markRunStarted();
          },
        ),
    );
    const events: unknown[] = [];
    const { session } = await startSession((event) => events.push(event));
    send(session, 'Blocked turn');
    await runStarted;
    await session.destroy();
    expect(events.some(isTerminal)).toBe(true);
    expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
    expect(() => send(session, 'After destroy')).toThrow(
      'Copilot session has ended.',
    );
  });

  it('a native tool approval keeps the turn running and resolves through the approval session', async () => {
    jest
      .mocked(authorizeCopilotNativeTool)
      .mockResolvedValue({ decision: 'allow' });
    const events: unknown[] = [];
    const { session } = await startSession((event) => events.push(event));
    let terminalBeforeDecision = true;
    jest.mocked(runCopilotTurn).mockImplementationOnce(async (config) => {
      await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, []);
      const decision = await config.authorize({
        toolName: 'bash',
        toolArgs: { command: 'ls' },
        timestamp: new Date(),
        workingDirectory: config.workingDirectory,
        sessionId: 'native-session',
      });
      terminalBeforeDecision = events.some(isTerminal);
      expect(decision).toEqual({ decision: 'allow' });
      return { sessionId: 'fixture-session', text: 'Done', usage: USAGE };
    });
    try {
      await sendAndSettle(session, events, 'Run ls');
      expect(terminalBeforeDecision).toBe(false);
      const approval = jest.mocked(createApprovalSession).mock.results.at(-1)
        ?.value as unknown;
      expect(approval).toBeDefined();
      expect(authorizeCopilotNativeTool).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'bash' }),
        expect.objectContaining({ approval }),
      );
      expect(events.at(-1)).toMatchObject({ type: 'result', is_error: false });
    } finally {
      await session.destroy();
    }
  });

  type ReceiptScenario =
    | 'accepted'
    | 'mismatched'
    | 'denied'
    | 'missing-native'
    | 'child'
    | 'cancelled'
    | 'account-changed'
    | 'early'
    | 'missing-result'
    | 'no-active-reload';

  async function receiptScenario(scenario: ReceiptScenario): Promise<void> {
    mockWorkspace.cowork = false;
    const delivered = jest
      .spyOn(getCopilotWorkerRuntime(), 'acknowledgeToolResult')
      .mockReturnValue(scenario !== 'no-active-reload');
    const generation = jest.mocked(assertCopilotConnectionGeneration);
    jest.mocked(authorizeCursorMcpTool).mockResolvedValue({
      decision: scenario === 'denied' ? 'deny' : 'allow',
    });
    const events: unknown[] = [];
    const { session } = await startSession((event) => events.push(event));
    let reachedReceipt = false;
    let stoppedAfterReceipt = false;
    const originalRun = jest.mocked(runCopilotTurn).getMockImplementation();
    if (!originalRun) throw new Error('Missing turn fixture');
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      const route =
        mockProxy.registerCanopyWorktreeSessionRoute.mock.calls.at(-1)?.[0];
      if (!route?.nativeToolResultDelivery || !route.authorizeToolCall)
        throw new Error('Missing host receipt binding');
      const args = { items: [{ ref: 'deferred:v1:fixture' }] };
      const toolName = 'fixture-loader';
      const eventBase = {
        id: 'native-event',
        parentId: null,
        timestamp: '2026-10-12T00:00:00Z',
      };
      const complete: SessionEvent = {
        ...eventBase,
        id: 'complete',
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'native-load',
          success: true,
          result: {
            content: 'accepted',
            detailedContent: 'accepted',
            contents: [{ type: 'text', text: 'accepted' }],
          },
        },
      };
      if (scenario !== 'missing-native') {
        config.onEvent?.({
          ...eventBase,
          type: 'tool.execution_start',
          data: {
            toolCallId: 'native-load',
            toolName,
            arguments: args,
            mcpConfigServerName: cursorCanopyMcpServerNames('default').main,
            mcpToolName: 'LoadDeferredTools',
          },
        });
        await expect(
          config.authorize({
            toolName,
            toolArgs: args,
            timestamp: new Date(),
            workingDirectory: config.workingDirectory,
            sessionId: 'native-session',
          }),
        ).resolves.toEqual({
          decision: scenario === 'denied' ? 'deny' : 'allow',
        });
      }
      const admitted = await route.authorizeToolCall(
        'load_deferred_tools',
        args,
        { requestId: 'rpc-1' },
      );
      expect(admitted).toBe(
        scenario !== 'denied' && scenario !== 'missing-native',
      );
      reachedReceipt = true;
      if (!admitted) return originalRun(config);
      if (scenario === 'early') config.onEvent?.(complete);
      const expectedResponse = {
        requestId: 'rpc-1',
        toolUseId: 'route:rpc-1',
        result:
          scenario === 'missing-result'
            ? { isError: true }
            : { content: [{ type: 'text', text: 'accepted' }] },
      };
      if (scenario === 'early')
        expect(() =>
          route.nativeToolResultDelivery?.(expectedResponse),
        ).toThrow('could not verify');
      else route.nativeToolResultDelivery(expectedResponse);
      expect(delivered).not.toHaveBeenCalled();
      if (scenario === 'cancelled') void session.cancel();
      if (scenario === 'account-changed')
        generation.mockImplementationOnce(() => {
          throw new Error('Account changed');
        });
      const nativeReceipt: SessionEvent =
        scenario === 'mismatched'
          ? {
              ...complete,
              data: {
                ...complete.data,
                result: {
                  content: 'wrong',
                  contents: [{ type: 'text', text: 'wrong' }],
                },
              },
            }
          : scenario === 'child'
            ? { ...complete, agentId: 'child' }
            : complete;
      if (scenario === 'account-changed')
        expect(() => config.onEvent?.(nativeReceipt)).toThrow(
          'Account changed',
        );
      else config.onEvent?.(nativeReceipt);
      if (scenario === 'accepted' || scenario === 'no-active-reload') {
        stoppedAfterReceipt = config.signal.aborted;
        expect(delivered).toHaveBeenCalledWith(
          { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' },
          'route:rpc-1',
        );
        config.onEvent?.(complete);
        expect(delivered).toHaveBeenCalledTimes(1);
      } else expect(delivered).not.toHaveBeenCalled();
      return originalRun(config);
    });
    try {
      await sendAndSettle(session, events, 'Receipt fixture');
      expect(reachedReceipt).toBe(true);
      // An acknowledgement aborts the turn, which hides a failed expectation
      // inside the fixture, so the count is checked here as well.
      expect(delivered).toHaveBeenCalledTimes(
        scenario === 'accepted' || scenario === 'no-active-reload' ? 1 : 0,
      );
      if (scenario === 'accepted') expect(stoppedAfterReceipt).toBe(true);
      if (scenario === 'no-active-reload')
        expect(stoppedAfterReceipt).toBe(false);
      if (scenario !== 'cancelled')
        expect(events.at(-1)).toMatchObject({
          type: 'result',
          is_error: false,
        });
    } finally {
      delivered.mockRestore();
      generation.mockReset();
      await session.destroy();
    }
  }

  it.each(['denied', 'missing-native'] as const)(
    'an MCP call is allowed only after its native approval (%s)',
    (scenario) => receiptScenario(scenario),
  );

  it.each(['accepted', 'no-active-reload'] as const)(
    'a reload waits for the native root tool completion before the turn stops (%s)',
    (scenario) => receiptScenario(scenario),
  );

  it.each([
    'mismatched',
    'denied',
    'missing-native',
    'child',
    'cancelled',
    'account-changed',
    'early',
    'missing-result',
  ] as const)(
    'a mismatched, failed, child or duplicate completion never acknowledges a reload (%s)',
    (scenario) => receiptScenario(scenario),
  );

  it('a session outside a worker run is refused before any runtime opens', async () => {
    await expect(
      getCopilotWorkerRuntime().providerFor(
        'copilot',
        windowAgentInterfacePort(() => null),
      ),
    ).rejects.toThrow(
      new AgentOutsideWorkerError('CopilotWorkerRuntime.providerFor'),
    );
    expect(openManagedCopilotRuntime).not.toHaveBeenCalled();
    expect(runCopilotTurn).not.toHaveBeenCalled();
  });
});
