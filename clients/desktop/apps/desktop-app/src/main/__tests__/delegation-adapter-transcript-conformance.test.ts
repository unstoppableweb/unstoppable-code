import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';
import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import { InMemoryDelegationTranscriptPort } from '@canopy/desktop-shared/node/delegation/in-memory-transcript-port';
import type {
  DelegationTranscriptTarget,
  DelegationTranscriptPort,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import type { DelegationTranscriptPortConformanceFixture } from '@canopy/desktop-shared/node/delegation/testing/transcript-port-conformance';
import type {
  CursorTurnHost,
  CursorTurnRequest,
  CursorTurnResult,
} from '@canopy/desktop-shared/node/cursor/turn-driver';
import type {
  OpenCodeTurnHost,
  OpenCodeTurnRequest,
  OpenCodeTurnResult,
} from '@canopy/desktop-shared/node/opencode/turn-driver';
import type { CopilotCapabilitySnapshot } from '@canopy/desktop-shared/node/copilot/capability-snapshot';
import type { DelegationNativePolicy } from '../agents/delegation/native-policy';
import { DelegationNativePolicy as NativePolicy } from '../agents/delegation/native-policy';
import {
  delegationBlockId,
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
  codexMcpToolResult,
  type DelegationChildRow,
  type PersistedChatBlock,
} from '@canopy/agent-transcript';
import { projectCodexThreadItem } from '@canopy/execution-engine/node/codex-runtime';
import { createCommandOutputSpools } from '../agents/delegation/command-output-spools';
import { FieldSpool } from '../lib/chat-transcript-field-spool';
import {
  createClaudeDelegationRunner,
  type ClaudeDelegationPreparation,
} from '../agents/delegation/claude-runner';
import { type CodexDelegationPreparation } from '../agents/delegation/codex-runner';
import {
  createCopilotDelegationRunner,
  type CopilotDelegationPreparation,
} from '../agents/delegation/copilot-runner';
import {
  createCursorDelegationRunner,
  type CursorDelegationPreparation,
} from '../agents/delegation/cursor-runner';
import {
  createOpenCodeDelegationRunner,
  type OpenCodeDelegationPreparation,
} from '../agents/delegation/opencode-runner';
import {
  createRepositoryTranscriptPortFixture,
  type RepositoryTranscriptPortFixture,
} from './helpers/repository-transcript-port-fixture';
import { request as claudeRequest } from './helpers/delegation-runner-fixtures/claude';
import { runInAgentWorker } from '../agent-runs/agent-worker-context';
import {
  fakeHandle as fakeCodexHandle,
  preparation as codexPreparation,
  run as runCodex,
  request as codexRequest,
  type TurnRequest as CodexTurnRequest,
} from './helpers/delegation-runner-fixtures/codex';

jest.setTimeout(120_000);

const FIXED_TIME = 1_700_000_000_000;

const mockClaudeQuery = jest.fn<unknown, [unknown]>();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (options: unknown): unknown => mockClaudeQuery(options),
  createSdkMcpServer: jest.fn(() => ({ type: 'sdk' })),
  tool: jest.fn((name: string) => ({ name })),
}));
jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: jest.fn(),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/fixture/claude'),
}));

const mockCopilotOpen = jest.fn<Promise<unknown>, unknown[]>();
const mockCopilotTurn = jest.fn<
  Promise<{
    sessionId: string;
    text: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
  }>,
  [unknown]
>();
jest.mock('../copilot/connection', () => ({
  openManagedCopilotRuntime: (...args: unknown[]): unknown =>
    mockCopilotOpen(...args),
  assertCopilotConnectionGeneration: jest.fn(),
}));
jest.mock('../agent-runs/copilot-worker-runtime', () => ({
  getCopilotWorkerRuntime: (): Record<string, unknown> => ({
    openSessionRuntime: (_entry: string, options: unknown): unknown =>
      mockCopilotOpen(options),
    acknowledgeToolResult: (): boolean => false,
  }),
}));
jest.mock('@canopy/desktop-shared/node/copilot/turn-driver', () => ({
  runCopilotTurn: (options: unknown): unknown => mockCopilotTurn(options),
}));
jest.mock('../copilot/mcp-servers', () => ({
  buildCopilotMcpServers: jest.fn(() => ({})),
}));

const mockCursorTurn = jest.fn<
  Promise<CursorTurnResult>,
  [CursorTurnRequest, CursorTurnHost]
>();
const mockCursorRuntime = jest.fn().mockResolvedValue({
  launch: { command: '/managed/cursor', args: [] },
  env: { PATH: '' },
  target: { hookRuntime: 'node' },
});
jest.mock('@canopy/desktop-shared/node/cursor/turn-driver', () => ({
  runCursorTurn: (
    ...args: [CursorTurnRequest, CursorTurnHost]
  ): Promise<CursorTurnResult> => mockCursorTurn(...args),
}));
jest.mock('../cursor/connection', () => ({
  getManagedCursorRuntime: (...args: unknown[]): unknown =>
    mockCursorRuntime(...args),
}));
jest.mock('../cursor/approval-check', () => ({
  verifyCursorVersion: jest.fn(() => Promise.resolve()),
}));

const mockOpenCodeTurn = jest.fn<
  Promise<OpenCodeTurnResult>,
  [OpenCodeTurnRequest, OpenCodeTurnHost]
>();
const mockOpenCodeRuntime = jest
  .fn()
  .mockImplementation((options: { signal: AbortSignal }) =>
    Promise.resolve({
      signal: options.signal,
      executable: process.execPath,
      prefix: [],
      env: { PATH: '' },
      generation: 1,
      close: jest.fn(() => Promise.resolve()),
    }),
  );
jest.mock('@canopy/desktop-shared/node/opencode/turn-driver', () => ({
  runOpenCodeTurn: (
    ...args: [OpenCodeTurnRequest, OpenCodeTurnHost]
  ): Promise<OpenCodeTurnResult> => mockOpenCodeTurn(...args),
}));
jest.mock('../opencode/connection', () => ({
  openManagedOpenCodeRuntime: (...args: unknown[]): unknown =>
    mockOpenCodeRuntime(...args),
  assertOpenCodeConnectionGeneration: jest.fn(),
  // The runtime checks the requested model before the turn starts.
  assertOpenCodeModelAvailable: (
    model: string | undefined,
  ): Promise<{ id: string; label: string }> =>
    Promise.resolve({ id: model ?? 'opencode-model', label: 'OpenCode' }),
}));
jest.mock('../opencode/capability-snapshot', () => ({
  snapshotOpenCodeMcpTools: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../opencode/mcp-servers', () => ({
  buildOpenCodeMcpServers: jest.fn(() => []),
  resolveOpenCodeMcpCall: jest.fn(() => undefined),
}));
jest.mock('../opencode/schema-validation', () => ({
  validateOpenCodeMcpSchema: jest.fn(),
}));

const mockProjection = jest.fn<unknown, unknown[]>(() => ({
  skills: [],
  commands: [],
}));
const mockMaterialize = jest.fn<Promise<unknown>, unknown[]>(
  async (...args) => {
    const root = args[0];
    if (typeof root === 'string') await mkdir(root, { recursive: true });
    return { warnings: [], skillIds: [], commandIds: [] };
  },
);
jest.mock('../plugins/plugin-resolver', () => ({
  buildCursorCapabilityProjection: (...args: unknown[]): unknown =>
    mockProjection(...args),
}));
jest.mock('@canopy/desktop-shared/node/cursor/capability-root', () => ({
  materializeSelectedCapabilityRoot: (...args: unknown[]): unknown =>
    mockMaterialize(...args),
  materializeCursorCapabilityRoot: (...args: unknown[]): unknown =>
    mockMaterialize(...args),
}));
const mockProxy = {
  getMcpCapabilityDigests: jest.fn(() => ({})),
  getCanopyWorktreeMcpUrl: jest.fn(() => 'http://127.0.0.1/fixture'),
  registerCanopyWorktreeSessionRoute: jest.fn(() => Promise.resolve()),
  unregisterCanopyWorktreeSessionRoute: jest.fn(),
};
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => mockProxy),
}));
jest.mock('../agents/delegation/canopy-tools', () => ({
  delegateAppToolGuidance: (): string => '',
}));
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => {
    throw new Error('The conformance fixture injects the Codex runtime.');
  }),
  codexRuntimeForWorkerRun: jest.fn(() => {
    throw new Error('The conformance fixture injects the Codex runtime.');
  }),
}));

interface ProviderRun {
  readonly request: AgentRunRequest;
  readonly events: AgentDelegationEvent['event'][];
  readonly terminal: AgentDelegationEvent['event'];
  readonly late: () => Promise<void>;
  readonly close: () => Promise<void>;
}

type Provider = 'claude' | 'codex' | 'copilot' | 'cursor' | 'opencode';

function targetFor(
  chatId: string,
  delegationId: string,
  runGeneration: number,
): DelegationTranscriptTarget {
  return { kind: 'delegation', chatId, delegationId, runGeneration };
}

function requestFor(provider: Provider, signal: AbortSignal): AgentRunRequest {
  const runtimeKinds: Record<Provider, string> = {
    claude: 'claude-sdk',
    codex: 'codex-app-server',
    copilot: 'copilot-sdk',
    cursor: 'cursor-acp',
    opencode: 'opencode-acp',
  };
  const account = { host: 'https://github.com', login: 'fixture' };
  return {
    ...claudeRequest,
    delegationId:
      provider === 'claude' || provider === 'codex' ? 'delegation-1' : 'child',
    runGeneration: 1,
    parent: {
      ...claudeRequest.parent,
      harnessId: 'claude',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'parent-session',
      toolCallId: 'delegation-card',
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      ...claudeRequest.task,
      modelId: `${provider}-fixture`,
    },
    route: routeFixture({
      harnessId: provider,
      runtimeKind: runtimeKinds[provider],
      // OpenCode runs native ids directly; other ids need the managed-inference gateway.
      runtimeModelId:
        provider === 'opencode'
          ? toOpenCodeModelId('fixture/model')
          : `${provider}-fixture`,
      ...(provider === 'copilot'
        ? {
            authAccountKey: createHash('sha256')
              .update(JSON.stringify(account))
              .digest('hex'),
          }
        : {}),
      ...(provider === 'cursor' ? { effectiveThinkingLevel: 'high' } : {}),
    }),
    cwd: process.cwd(),
    effectivePermission: 'read-only',
    signal,
  };
}

function inMemoryFixture(): DelegationTranscriptPortConformanceFixture {
  const port = new InMemoryDelegationTranscriptPort({
    owns: (target: DelegationTranscriptTarget): boolean =>
      target.chatId === 'chat',
  });
  return {
    port,
    ownedTarget: targetFor,
    foreignTarget: targetFor('foreign-chat', 'foreign-child', 1),
    dispose: (): void => undefined,
  };
}

async function portFixture(portKind: 'memory' | 'repository'): Promise<{
  fixture: DelegationTranscriptPortConformanceFixture;
  dispose: () => Promise<void>;
  checkpointReopen: () => Promise<void>;
  repository?: RepositoryTranscriptPortFixture;
}> {
  if (portKind === 'memory') {
    const fixture = inMemoryFixture();
    return {
      fixture,
      dispose: async () => fixture.dispose?.(),
      checkpointReopen: () => Promise.resolve(),
    };
  }
  const root = await mkdtemp(join(tmpdir(), 'delegation-transcript-matrix-'));
  const factory = createRepositoryTranscriptPortFixture(root);
  const fixture = await factory();
  return {
    fixture,
    repository: fixture,
    checkpointReopen: async (): Promise<void> => {
      const previous = fixture.repository;
      await previous.flushScope(fixture.scope);
      await fixture.reopen();
      expect(fixture.repository).not.toBe(previous);
    },
    dispose: async (): Promise<void> => {
      await fixture.dispose?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function policy(
  signal: AbortSignal,
  delegationId: string,
): DelegationNativePolicy {
  return new NativePolicy({
    cwd: process.cwd(),
    writePaths: [],
    signal,
    delegationId,
    mode: () => 'full-access',
    allowed: () => Promise.resolve(true),
    approval: {
      check: jest.fn(() => Promise.resolve({ decision: 'allow' })),
      setMode: jest.fn(),
      reevaluatePendingApprovals: jest.fn(() => Promise.resolve()),
      dispose: jest.fn(),
    },
    emit: () => Promise.resolve(),
  });
}

function patchEvents(
  provider: 'copilot' | 'cursor' | 'opencode',
): [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>] {
  const toolUseId = `${provider}-native-tool-id`;
  return [
    {
      type: 'canopy_assistant_patch',
      provider,
      role: 'assistant',
      messageId: `${provider}-message`,
      timestamp: FIXED_TIME,
      revision: 1,
      patches: [
        { index: 0, block: { type: 'text', text: `${provider} answer` } },
        { index: 1, block: { type: 'thinking', text: `${provider} thought` } },
        {
          index: 2,
          block: {
            type: 'tool_use',
            toolUseId,
            toolName: `${provider}.raw_tool_name`,
            input: '{"path":"/fixture"}',
          },
        },
      ],
    },
    {
      type: 'canopy_assistant_patch',
      provider,
      role: 'assistant',
      messageId: `${provider}-message`,
      timestamp: FIXED_TIME,
      revision: 2,
      patches: [
        { index: 0, appendText: ' with delta' },
        {
          index: 3,
          block: {
            type: 'tool_result',
            toolUseId,
            toolName: `${provider}.raw_tool_name`,
            output: 'structured tool error',
            isError: true,
          },
        },
      ],
    },
    {
      type: 'canopy_assistant_patch',
      provider,
      role: 'assistant',
      messageId: `${provider}-message`,
      timestamp: FIXED_TIME,
      revision: 3,
      patches: [{ index: 0, appendText: ' late mutation' }],
    },
  ];
}

function makeClaudeIterator(
  events: readonly Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> & { close: jest.Mock } {
  async function* stream(): AsyncGenerator<Record<string, unknown>> {
    for (const event of events) yield await Promise.resolve(event);
  }
  return Object.assign(stream(), { close: jest.fn() });
}

function claudeEvents(): Record<string, unknown>[] {
  const message = {
    id: 'claude-native-message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Claude answer' },
      { type: 'thinking', thinking: 'Claude reasoning' },
      {
        type: 'tool_use',
        id: 'claude-raw-tool-id',
        name: 'mcp__raw_server__read_file',
        input: { path: '/fixture' },
      },
    ],
  };
  return [
    { type: 'assistant', message, timestamp: FIXED_TIME },
    {
      type: 'user',
      timestamp: FIXED_TIME,
      message: {
        id: 'claude-tool-result',
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'claude-raw-tool-id',
            is_error: true,
            content: [
              { type: 'text', text: 'resource output' },
              { type: 'resource', resource: { text: 'nested resource' } },
            ],
          },
        ],
      },
    },
    // This provider event is late for the already-final assistant rows.
    {
      type: 'assistant',
      timestamp: FIXED_TIME,
      message: {
        ...message,
        content: [{ type: 'text', text: 'late Claude replacement' }],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Claude answer',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ];
}

function codexEvents(turn: CodexTurnRequest): void {
  const send = (method: string, params: Record<string, unknown>): void => {
    void turn.onEvent?.({ method, params });
  };
  send('turn/started', {
    threadId: 'codex-native-thread',
    turn: { id: 'codex-native-turn' },
    timestamp: FIXED_TIME,
  });
  send('item/started', {
    threadId: 'codex-native-thread',
    turnId: 'codex-native-turn',
    timestamp: FIXED_TIME,
    item: { id: 'codex-message', type: 'agentMessage', text: 'Codex answer' },
  });
  send('item/agentMessage/delta', {
    threadId: 'codex-native-thread',
    turnId: 'codex-native-turn',
    itemId: 'codex-message',
    delta: ' with delta',
    timestamp: FIXED_TIME,
  });
  send('item/completed', {
    threadId: 'codex-native-thread',
    turnId: 'codex-native-turn',
    timestamp: FIXED_TIME,
    item: {
      id: 'codex-message',
      type: 'agentMessage',
      text: 'Codex answer with delta',
    },
  });
  send('item/completed', {
    threadId: 'codex-native-thread',
    turnId: 'codex-native-turn',
    timestamp: FIXED_TIME,
    item: {
      id: 'codex-reasoning',
      type: 'reasoning',
      summary: ['Codex thought'],
      content: [],
    },
  });
  send('item/completed', {
    threadId: 'codex-native-thread',
    turnId: 'codex-native-turn',
    timestamp: FIXED_TIME,
    item: {
      id: 'codex-mcp-success',
      type: 'mcpToolCall',
      server: 'raw_server',
      tool: 'read_resource',
      arguments: { path: '/fixture' },
      status: 'completed',
      result: {
        content: [
          { type: 'resource', resource: { text: 'resource payload' } },
          { type: 'image', mimeType: 'image/png', data: 'AQID' },
          { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
        ],
      },
    },
  });
  send('item/completed', {
    threadId: 'codex-native-thread',
    turnId: 'codex-native-turn',
    timestamp: FIXED_TIME,
    item: {
      id: 'codex-mcp-structured',
      type: 'mcpToolCall',
      server: 'raw_server',
      tool: 'structured_result',
      arguments: { query: 'count' },
      status: 'completed',
      result: { structuredContent: { count: 2 } },
    },
  });
  send('item/completed', {
    threadId: 'codex-native-thread',
    turnId: 'codex-native-turn',
    timestamp: FIXED_TIME,
    item: {
      id: 'codex-mcp-error',
      type: 'mcpToolCall',
      server: 'raw_server',
      tool: 'failing_call',
      arguments: {},
      status: 'failed',
      error: { message: 'Codex native failure' },
    },
  });
}

async function runProvider(
  provider: Provider,
  transcriptPort?: DelegationTranscriptPort,
  streamTarget?: DelegationTranscriptTarget,
): Promise<ProviderRun> {
  const signal = new AbortController().signal;
  const profileDir = await mkdtemp(join(tmpdir(), `delegation-${provider}-`));
  let request = requestFor(provider, signal);
  if (streamTarget)
    request = { ...request, transcriptStream: { target: streamTarget } };

  let late = (): Promise<void> => Promise.resolve();
  let events: AgentDelegationEvent['event'][] = [];
  let terminal: AgentDelegationEvent['event'];
  if (provider === 'codex') {
    let savedTurn: CodexTurnRequest | undefined;
    const handle = fakeCodexHandle('codex-native-thread', (turn) => {
      savedTurn = turn;
      codexEvents(turn);
      return Promise.resolve({
        status: 'completed',
        text: 'Codex answer with delta',
      });
    });
    const harness = runCodex({
      prepare: (): Promise<CodexDelegationPreparation> =>
        Promise.resolve(codexPreparation()),
      handles: [handle],
      runRequest: request,
      transcriptPort,
      spools: () => createCommandOutputSpools({ root: () => profileDir }),
    });
    terminal = await harness.terminal;
    events = harness.events;
    late = (): Promise<void> => {
      void savedTurn?.onEvent?.({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'codex-native-thread',
          turnId: 'codex-native-turn',
          itemId: 'codex-message',
          delta: ' late mutation',
          timestamp: FIXED_TIME,
        },
      });
      return Promise.resolve();
    };
    await harness.stop();
  } else {
    let runner;
    if (provider === 'claude') {
      const input = request;
      mockClaudeQuery.mockReturnValue(makeClaudeIterator(claudeEvents()));
      runner = createClaudeDelegationRunner({
        available: () => Promise.resolve({ available: true }),
        prepare: (): Promise<ClaudeDelegationPreparation> =>
          Promise.resolve({
            model: 'claude-fixture',
            environment: { PATH: '' },
            tools: policy(input.signal, input.delegationId),
            plugins: [],
            mcpServers: {},
          }),
        reportError: jest.fn(),
        transcriptPort,
      });
    } else if (provider === 'copilot') {
      const input = request;
      const runtime = {
        client: { createSession: jest.fn(), resumeSession: jest.fn() },
        generation: 1,
        account: { host: 'https://github.com', login: 'fixture' },
        // The recipient handle runs the turn; the driver mock stands in for it.
        runTurn: (turn: unknown): unknown => mockCopilotTurn(turn),
        exited: Promise.resolve(),
        close: jest.fn(() => Promise.resolve()),
      };
      mockCopilotOpen.mockResolvedValue(runtime);
      const [initialPatch, finalPatch, latePatch] = patchEvents('copilot');
      let savedEmit:
        | ((event: Record<string, unknown>) => Promise<void> | void)
        | undefined;
      mockCopilotTurn.mockImplementation(async (value: unknown) => {
        const options = value as {
          emit: (event: Record<string, unknown>) => Promise<void> | void;
          onToolsReady: (
            snapshot: CopilotCapabilitySnapshot,
            mcpReadiness: readonly unknown[],
          ) => Promise<void> | void;
          onSession: (sessionId: string) => Promise<void> | void;
        };
        savedEmit = options.emit;
        await options.onToolsReady({ version: 1, digest: 'a'.repeat(64) }, []);
        await options.onSession('copilot-native-session');
        await options.emit(initialPatch);
        await options.emit(finalPatch);
        return {
          sessionId: 'copilot-native-session',
          text: 'Copilot answer with delta',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      });
      runner = createCopilotDelegationRunner({
        available: () => Promise.resolve({ available: true }),
        prepare: (): Promise<CopilotDelegationPreparation> =>
          Promise.resolve({
            model: 'copilot-fixture',
            profileDir,
            tools: policy(input.signal, input.delegationId),
            retainedReadRoots: [],
            plugins: [],
            mcpServers: {},
          }),
        reportError: jest.fn(),
        transcriptPort,
      });
      late = async (): Promise<void> => {
        if (savedEmit) await savedEmit(latePatch);
      };
    } else if (provider === 'cursor') {
      const input = request;
      const [initialPatch, finalPatch, latePatch] = patchEvents('cursor');
      let savedHost: CursorTurnHost | undefined;
      mockCursorTurn.mockImplementation(async (_turnRequest, host) => {
        savedHost = host;
        await host.beforePrompt({
          sessionId: 'cursor-native-session',
          contextLost: false,
          mcp: {
            servers: [],
            notes: [],
            notices: [],
            appToolsAvailable: false,
            pluginServerNames: [],
          },
          announce: jest.fn(),
        });
        await host.emit(initialPatch);
        await host.emit(finalPatch);
        return {
          sessionId: 'cursor-native-session',
          isError: false,
          cancelled: false,
          message: '',
          contextLost: false,
          inheritedContextDelivered: false,
          responseText: 'Cursor answer with delta',
        };
      });
      runner = createCursorDelegationRunner({
        available: () => Promise.resolve({ available: true }),
        prepare: (): Promise<CursorDelegationPreparation> =>
          Promise.resolve({
            model: 'cursor-fixture',
            profileDir,
            tools: policy(input.signal, input.delegationId),
            plugins: [],
            mcpServers: {},
            bindMcpGates: jest.fn(),
          }),
        reportError: jest.fn(),
        transcriptPort,
      });
      late = async (): Promise<void> => {
        if (savedHost) await savedHost.emit(latePatch);
      };
    } else {
      const input = request;
      const [initialPatch, finalPatch, latePatch] = patchEvents('opencode');
      let savedHost: OpenCodeTurnHost | undefined;
      mockOpenCodeTurn.mockImplementation(async (_turnRequest, host) => {
        savedHost = host;
        await host.onSession?.('opencode-native-session', {
          version: 1,
          sessionId: 'opencode-native-session',
          digest: 'fixed-capability-digest',
          generation: 1,
        });
        await host.emit(initialPatch);
        await host.emit(finalPatch);
        return {
          sessionId: 'opencode-native-session',
          responseText: 'OpenCode answer with delta',
          isError: false,
          cancelled: false,
          message: '',
        };
      });
      runner = createOpenCodeDelegationRunner({
        available: () => Promise.resolve({ available: true }),
        prepare: (): Promise<OpenCodeDelegationPreparation> =>
          Promise.resolve({
            model: 'opencode-fixture',
            profileDir,
            tools: policy(input.signal, input.delegationId),
            retainedReadRoots: [],
            plugins: [],
            mcpServers: {},
          }),
        reportError: jest.fn(),
        transcriptPort,
      });
      late = async (): Promise<void> => {
        if (savedHost) await savedHost.emit(latePatch);
      };
    }
    const collected: AgentDelegationEvent['event'][] = [];
    let resolveTerminal!: (event: AgentDelegationEvent['event']) => void;
    const terminalEvent = new Promise<AgentDelegationEvent['event']>(
      (resolve) => {
        resolveTerminal = resolve;
      },
    );
    await runInAgentWorker(
      { kind: 'subagent', runId: request.delegationId },
      () =>
        runner.start(request, (envelope) => {
          collected.push(envelope.event);
          if (envelope.event.type === 'terminal')
            resolveTerminal(envelope.event);
          return Promise.resolve();
        }),
    );
    terminal = await terminalEvent;
    events = collected;
    await runner.close({ runId: request.delegationId });
  }
  return {
    request,
    events,
    terminal,
    late,
    close: async (): Promise<void> => {
      await rm(profileDir, { recursive: true, force: true });
    },
  };
}

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok)
    throw new Error(`Transcript operation failed: ${result.error.code}`);
  return result.value;
}

function transcriptPayloads(
  events: readonly AgentDelegationEvent['event'][],
): AgentDelegationEvent['event'][] {
  return events.filter((event) => event.type === 'transcript');
}

function assertCoreRows(provider: Provider, rows: readonly unknown[]): void {
  expect(rows.length).toBeGreaterThanOrEqual(provider === 'codex' ? 5 : 3);
  const serialized = JSON.stringify(rows);
  const delegationId =
    provider === 'claude' || provider === 'codex' ? 'delegation-1' : 'child';
  const expectedBlockId = delegationBlockId(delegationId, 1);
  expect(serialized).toContain(
    provider === 'claude'
      ? 'Claude reasoning'
      : provider === 'codex'
        ? 'Codex thought'
        : `${provider} thought`,
  );
  expect(serialized).toContain(
    provider === 'claude'
      ? 'mcp__raw_server__read_file'
      : provider === 'codex'
        ? 'mcp__raw_server__read_resource'
        : `${provider}.raw_tool_name`,
  );
  for (const row of rows as readonly {
    id: string;
    parentBlockId: string;
  }[]) {
    expect(row.parentBlockId).toBe(expectedBlockId);
    expect(row.id.startsWith(`${expectedBlockId}:`)).toBe(true);
  }
  expect(rows.every((row) => (row as { final: boolean }).final)).toBe(true);
  expect(
    rows.some((row) => (row as { itemRevision: number }).itemRevision > 0),
  ).toBe(true);
  const sequences = rows.map(
    (row) => (row as { delegationSequence: number }).delegationSequence,
  );
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(serialized).toContain('tool_result');
  expect(serialized).toContain('isError');
}

const providers: readonly Provider[] = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'opencode',
];
const ports = [{ kind: 'memory' as const }, { kind: 'repository' as const }];

describe('delegation adapter transcript-port conformance matrix', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
    mockClaudeQuery.mockReset();
    mockCopilotOpen.mockReset();
    mockCopilotTurn.mockReset();
    mockCursorTurn.mockReset();
    mockOpenCodeTurn.mockReset();
    mockOpenCodeRuntime.mockClear();
    mockCursorRuntime.mockClear();
    mockProjection.mockClear();
    mockMaterialize.mockClear();
    mockProxy.getMcpCapabilityDigests.mockClear();
    mockProxy.getCanopyWorktreeMcpUrl.mockClear();
    mockProxy.registerCanopyWorktreeSessionRoute.mockClear();
    mockProxy.unregisterCanopyWorktreeSessionRoute.mockClear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(providers)(
    '%s uses both transcript ports for stream rows while preserving legacy transcript payloads',
    async (provider) => {
      const fixtures: Array<{
        fixture: DelegationTranscriptPortConformanceFixture;
        dispose: () => Promise<void>;
      }> = [];
      const streamRuns: ProviderRun[] = [];
      const rowSnapshots: unknown[][] = [];
      let legacyRun: ProviderRun | undefined;
      try {
        for (const portKind of ports) {
          const portInstance = await portFixture(portKind.kind);
          fixtures.push(portInstance);
          const target = portInstance.fixture.ownedTarget(
            'chat',
            provider === 'claude' || provider === 'codex'
              ? 'delegation-1'
              : 'child',
            1,
          );
          const streamRun = await runProvider(
            provider,
            portInstance.fixture.port,
            target,
          );
          streamRuns.push(streamRun);
          expect(streamRun.terminal).toMatchObject({
            type: 'terminal',
            status: 'completed',
          });

          await portInstance.checkpointReopen();
          const opened = unwrap(
            await portInstance.fixture.port.open({ target }),
          );
          const beforeLate = unwrap(
            await portInstance.fixture.port.page({
              target,
              streamRevision: opened.streamRevision,
            }),
          );
          assertCoreRows(provider, beforeLate.rows);
          if (provider === 'codex') {
            expect(JSON.stringify(beforeLate.rows)).toContain(
              'resource payload',
            );
            expect(JSON.stringify(beforeLate.rows)).toContain('count');
            const images = beforeLate.rows
              .flatMap((row) => row.blocks)
              .filter((block) => block.type === 'image');
            expect(images).toHaveLength(1);
            expect(JSON.stringify(images)).toContain(
              'data:image/png;base64,AQID',
            );
            expect(JSON.stringify(images)).not.toContain('image/svg+xml');
          } else if (provider === 'claude') {
            expect(JSON.stringify(beforeLate.rows)).toContain(
              'nested resource',
            );
          }
          rowSnapshots.push([...beforeLate.rows]);

          await streamRun.late();
          await portInstance.checkpointReopen();
          const afterLateOpen = unwrap(
            await portInstance.fixture.port.open({ target }),
          );
          const afterLate = unwrap(
            await portInstance.fixture.port.page({
              target,
              streamRevision: afterLateOpen.streamRevision,
            }),
          );
          expect(afterLate.rows).toEqual(beforeLate.rows);
          expect(afterLateOpen.streamRevision).toBe(opened.streamRevision);
        }
        expect(rowSnapshots[0]).toEqual(rowSnapshots[1]);
        legacyRun = await runProvider(provider);
        expect(legacyRun.terminal).toMatchObject({
          type: 'terminal',
          status: 'completed',
        });
        for (const streamRun of streamRuns)
          expect(transcriptPayloads(streamRun.events)).toEqual(
            transcriptPayloads(legacyRun.events),
          );
      } finally {
        await Promise.all(streamRuns.map((streamRun) => streamRun.close()));
        await legacyRun?.close();
        await Promise.all(fixtures.map(({ dispose }) => dispose()));
      }
    },
  );
});

// These are runner/queue integration oracles, not substitutes for S2's causal reds.
const MATRIX_THREAD = 'matrix-thread';
const MATRIX_TURN = 'matrix-turn';
const MATRIX_SEGMENT = `codex:${MATRIX_THREAD}:${MATRIX_TURN}`;
const MATRIX_BLOCK = delegationBlockId('delegation-1', 1);

type NativeItem = Record<string, unknown> & { id: string; type: string };

interface MatrixOracle {
  readonly item: NativeItem;
  readonly blocks: PersistedChatBlock[];
}

function command(id: string, extra: Record<string, unknown> = {}): NativeItem {
  return {
    id,
    type: 'commandExecution',
    command: `fixture ${id}`,
    status: 'inProgress',
    ...extra,
  };
}

function commandOracle(
  item: NativeItem,
  output: string,
  isError = false,
): MatrixOracle {
  return {
    item,
    blocks: [
      {
        type: 'tool_use',
        toolName: 'command',
        toolUseId: `codex-${item.id}`,
        input: `fixture ${item.id}`,
      },
      {
        type: 'tool_result',
        toolName: 'command',
        toolUseId: `codex-${item.id}`,
        output,
        isError,
      },
    ],
  };
}

function primaryBlocks(item: NativeItem): PersistedChatBlock[] {
  const projected = projectCodexThreadItem(item);
  if (!projected) throw new Error('Invalid primary fixture item');
  const primary = applyCodexTranscriptEvent(
    createEmptyTranscriptReducerState(),
    { type: 'item.completed', item: projected },
    {
      childToolLiveness: { kind: 'unknown' },
      now: FIXED_TIME,
      createMessageId: () => 'primary-generated',
    },
  );
  const message = primary.messages[primary.messages.length - 1];
  if (!message) throw new Error(`Primary fixture missing ${item.id}`);
  expect(message.id).toBe(`codex-${item.id}`);
  return message.blocks;
}

function bodyEncoding(text: string): 'utf8' | 'utf16le' {
  return /[\uD800-\uDFFF]/.test(
    text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''),
  )
    ? 'utf16le'
    : 'utf8';
}

function digest(text: string, encoding: 'utf8' | 'utf16le'): string {
  return createHash('sha256').update(Buffer.from(text, encoding)).digest('hex');
}

async function assertBodyRanges(
  port: DelegationTranscriptPort,
  target: DelegationTranscriptTarget,
  streamRevision: number,
  row: DelegationChildRow,
): Promise<void> {
  for (let blockOrdinal = 0; blockOrdinal < row.blocks.length; blockOrdinal++) {
    const block = row.blocks[blockOrdinal];
    const field =
      block.type === 'tool_result'
        ? 'output'
        : block.type === 'tool_use'
          ? 'input'
          : block.type === 'text' || block.type === 'thinking'
            ? 'text'
            : undefined;
    const full =
      block.type === 'tool_result'
        ? block.output
        : block.type === 'tool_use'
          ? block.input
          : block.type === 'text' || block.type === 'thinking'
            ? block.text
            : undefined;
    if (field === undefined || full === undefined || full.length === 0)
      continue;
    const encoding = bodyEncoding(full);
    const byteLength = Buffer.byteLength(full, encoding);
    // Positions are code-unit boundaries converted into bytes of the stored
    // encoding. Never split a surrogate pair or assume UTF-16 length is UTF-8.
    for (let start of [
      Math.floor(full.length / 2),
      Math.max(0, full.length - 32),
    ]) {
      if (start > 0 && /[\uDC00-\uDFFF]/.test(full[start])) start -= 1;
      let end = Math.min(full.length, start + 32);
      if (end < full.length && /[\uDC00-\uDFFF]/.test(full[end])) end -= 1;
      const expected = full.slice(start, end);
      const part = unwrap(
        await port.contentRange({
          target,
          streamRevision,
          messageId: row.id,
          blockOrdinal,
          field,
          offset: Buffer.byteLength(full.slice(0, start), encoding),
          limit: Math.max(4, Buffer.byteLength(expected, encoding)),
        }),
      );
      expect(part).toMatchObject({ text: expected, encoding, byteLength });
      expect(digest(part.text, encoding)).toBe(digest(expected, encoding));
    }
  }
}

describe('Codex C01–C05 real-runner two-port final/reopen matrix', () => {
  const roots: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  const liveHandles = new Set<string>();

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
    const create = FieldSpool.create.bind(FieldSpool);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored with call(this) below.
    const close = FieldSpool.prototype.close;
    jest.spyOn(FieldSpool, 'create').mockImplementation(async (directory) => {
      const spool = await create(directory);
      liveHandles.add(spool.path);
      return spool;
    });
    jest
      .spyOn(FieldSpool.prototype, 'close')
      .mockImplementation(async function (this: FieldSpool): Promise<void> {
        await close.call(this);
        liveHandles.delete(this.path);
      });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    expect(liveHandles.size).toBe(0);
    jest.restoreAllMocks();
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true });
  });

  async function matrix(
    oracles: readonly MatrixOracle[],
    script: (
      send: (method: string, params: Record<string, unknown>) => Promise<void>,
    ) => Promise<void>,
    inspect?: (
      instance: Awaited<ReturnType<typeof portFixture>>,
      target: DelegationTranscriptTarget,
      rows: readonly DelegationChildRow[],
      events: AgentDelegationEvent['event'][],
    ) => Promise<void>,
  ): Promise<void> {
    const snapshots: DelegationChildRow[][] = [];
    for (const { kind } of ports) {
      const instance = await portFixture(kind);
      cleanups.push(instance.dispose);
      const spoolRoot = await mkdtemp(join(tmpdir(), 'codex-matrix-spools-'));
      roots.push(spoolRoot);
      const owner = createCommandOutputSpools({ root: () => spoolRoot });
      cleanups.push(() => owner.close());
      const target = instance.fixture.ownedTarget('chat', 'delegation-1', 1);
      let saved: CodexTurnRequest | undefined;
      const handle = fakeCodexHandle(MATRIX_THREAD, async (turn) => {
        saved = turn;
        const send = async (
          method: string,
          params: Record<string, unknown>,
        ): Promise<void> => {
          await turn.onEvent?.({
            method,
            params: {
              threadId: MATRIX_THREAD,
              turnId: MATRIX_TURN,
              timestamp: FIXED_TIME,
              ...params,
            },
          });
        };
        await send('turn/started', { turn: { id: MATRIX_TURN } });
        await script(send);
        return { status: 'completed', text: 'matrix complete' };
      });
      const harness = runCodex({
        prepare: () => Promise.resolve(codexPreparation()),
        handles: [handle],
        transcriptPort: instance.fixture.port,
        spools: () => owner,
        runRequest: {
          ...codexRequest,
          signal: new AbortController().signal,
          transcriptStream: { target },
        },
      });
      cleanups.push(harness.stop);
      expect(await harness.terminal).toMatchObject({
        type: 'terminal',
        status: 'completed',
      });
      expect(handle.interrupt).not.toHaveBeenCalled();
      expect(
        harness.events.filter((event) => event.type === 'terminal'),
      ).toHaveLength(1);
      expect(liveHandles.size).toBe(0);
      expect(await readdir(spoolRoot)).toEqual([]);
      const before = unwrap(await instance.fixture.port.open({ target }));
      await instance.checkpointReopen();
      const port = instance.fixture.port;
      expect(unwrap(await port.open({ target }))).toEqual(before);
      const { rows } = unwrap(
        await port.page({
          target,
          streamRevision: before.streamRevision,
          limit: 512,
        }),
      );
      expect(rows.map((row) => row.id)).toEqual(
        oracles.map(
          ({ item }) => `${MATRIX_BLOCK}:${MATRIX_SEGMENT}::${item.id}`,
        ),
      );
      expect(rows.map((row) => row.delegationSequence)).toEqual(
        oracles.map((_, index) => index),
      );
      expect(new Set(rows.map((row) => row.id)).size).toBe(oracles.length);
      const expanded: DelegationChildRow[] = [];
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        expect(row).toMatchObject({
          final: true,
          parentBlockId: MATRIX_BLOCK,
          delegationSegment: MATRIX_SEGMENT,
        });
        const full = unwrap(
          await port.message({
            target,
            streamRevision: before.streamRevision,
            messageId: row.id,
          }),
        );
        expect(full.blocks).toEqual(oracles[index].blocks);
        expect(
          digest(
            JSON.stringify(
              full.blocks.map((block) =>
                Object.fromEntries(
                  Object.entries(block).sort(([left], [right]) =>
                    left.localeCompare(right),
                  ),
                ),
              ),
            ),
            'utf8',
          ),
        ).toBe(
          digest(
            JSON.stringify(
              oracles[index].blocks.map((block) =>
                Object.fromEntries(
                  Object.entries(block).sort(([left], [right]) =>
                    left.localeCompare(right),
                  ),
                ),
              ),
            ),
            'utf8',
          ),
        );
        const uses = full.blocks.filter((block) => block.type === 'tool_use');
        const results = full.blocks.filter(
          (block) => block.type === 'tool_result',
        );
        expect(results.map((block) => block.toolUseId)).toEqual(
          uses.map((block) => block.toolUseId),
        );
        await assertBodyRanges(port, target, before.streamRevision, full);
        expanded.push(full);
      }
      await inspect?.(instance, target, expanded, harness.events);
      // Events delivered after owner teardown are inert too: no rejected
      // admission, allocation, final revision change or interruption row.
      // In-lifetime duplicates before/after acknowledgement are exercised C05.
      for (const { item } of oracles) {
        await Promise.resolve(
          saved?.onEvent?.({
            method: 'item/completed',
            params: {
              threadId: MATRIX_THREAD,
              turnId: MATRIX_TURN,
              item: { ...item, aggregatedOutput: 'late replacement' },
            },
          }),
        );
        await Promise.resolve(
          saved?.onEvent?.({
            method: 'item/commandExecution/outputDelta',
            params: {
              threadId: MATRIX_THREAD,
              turnId: MATRIX_TURN,
              itemId: item.id,
              delta: 'late delta',
            },
          }),
        );
      }
      await instance.checkpointReopen();
      expect(unwrap(await instance.fixture.port.open({ target }))).toEqual(
        before,
      );
      expect(
        unwrap(
          await instance.fixture.port.page({
            target,
            streamRevision: before.streamRevision,
            limit: 512,
          }),
        ).rows,
      ).toEqual(rows);
      expect(await readdir(spoolRoot)).toEqual([]);
      expect(liveHandles.size).toBe(0);
      snapshots.push(expanded);
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
  }

  it('C01 retains the primary 131,082-character / 101-item dynamic result including item 101', async () => {
    const contentItems = Array.from({ length: 100 }, () => ({
      type: 'inputText',
      text: 'x'.repeat(1308),
    }));
    contentItems.push({
      type: 'inputText',
      text: `after-item-100:${'y'.repeat(57)}end-marker`,
    });
    const expected = contentItems.map((item) => item.text).join('\n\n');
    expect(expected).toHaveLength(131_082);
    expect(contentItems).toHaveLength(101);
    const item: NativeItem = {
      id: 'dynamic-101',
      type: 'dynamicToolCall',
      tool: 'raw_dynamic_name',
      arguments: { query: 'all' },
      status: 'completed',
      success: true,
      contentItems,
    };
    const blocks = primaryBlocks(item);
    expect(blocks[1]).toMatchObject({
      type: 'tool_result',
      output: expected,
      isError: false,
    });
    await matrix([{ item, blocks }], (send) =>
      send('item/completed', { item }),
    );
  });

  it('C02 matches primary text/resource, wide/deep structured, errors and excluded payload fixtures', async () => {
    const content = Array.from({ length: 101 }, () => ({
      type: 'text',
      text: 'x'.repeat(1300),
    }));
    const textResult = {
      content: [
        ...content,
        { type: 'resource', resource: { text: 'last resource' } },
      ],
    };
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 3_001; index++) wide[`key-${index}`] = index;
    let clean: unknown = { wide: { ...wide } };
    wide._meta = 'secret';
    let deep: unknown = { wide };
    for (let index = 0; index < 50; index++) {
      deep = { nested: deep, _meta: 'secret' };
      clean = { nested: clean };
    }
    const resultItems: NativeItem[] = [
      {
        id: 'resources',
        type: 'mcpToolCall',
        server: 'raw_server',
        tool: 'resources',
        arguments: {},
        status: 'completed',
        result: textResult,
      },
      {
        id: 'structured',
        type: 'mcpToolCall',
        server: 'raw_server',
        tool: 'structured',
        arguments: {},
        status: 'completed',
        result: {
          content: [],
          structuredContent: deep,
          _meta: 'result-secret',
        },
      },
      {
        id: 'native-error',
        type: 'mcpToolCall',
        server: 'raw_server',
        tool: 'error',
        arguments: {},
        status: 'failed',
        error: { message: 'x'.repeat(70_000), _meta: 'error-secret' },
        result: {
          content: [{ type: 'text', text: 'lower-precedence result' }],
        },
      },
      {
        id: 'excluded',
        type: 'dynamicToolCall',
        tool: 'raw_media',
        arguments: {},
        status: 'completed',
        success: false,
        contentItems: [
          { type: 'input_image', image_url: 'private' },
          { type: 'inputAudio', data: 'private' },
          { type: 'encrypted_content', data: 'private' },
          { type: 'unknown' },
          null,
        ],
      },
    ];
    const oracles = resultItems.map((item) => ({
      item,
      blocks: primaryBlocks(item),
    }));
    expect(oracles[0].blocks[1]).toMatchObject({
      output: [...content.map((item) => item.text), 'last resource'].join(
        '\n\n',
      ),
    });
    const structured = codexMcpToolResult({
      result: { structuredContent: deep },
      status: 'completed',
      error: null,
    }).output;
    expect(JSON.parse(structured)).toEqual(clean);
    expect(oracles[1].blocks[1]).toMatchObject({ output: structured });
    expect(oracles[3].blocks[1]).toMatchObject({
      output: Array.from(
        { length: 4 },
        () => '[unsupported output omitted]',
      ).join('\n\n'),
      isError: true,
    });
    expect(oracles[2].blocks[1]).toMatchObject({
      output: 'x'.repeat(70_000),
      isError: true,
    });
    expect(
      JSON.stringify(oracles.map((oracle) => oracle.blocks)),
    ).not.toContain('result-secret');
    await matrix(
      oracles,
      async (send) => {
        for (const item of resultItems) await send('item/completed', { item });
      },
      (_instance, _target, rows) => {
        expect(JSON.stringify(rows)).not.toMatch(
          /secret|private|_meta|lower-precedence/,
        );
        return Promise.resolve();
      },
    );
  });

  it('C02 keeps supported PNG separately from excluded SVG/binary bodies exactly like primary chat', async () => {
    const item: NativeItem = {
      id: 'supported-media',
      type: 'mcpToolCall',
      server: 'raw_server',
      tool: 'media',
      arguments: {},
      status: 'completed',
      result: {
        content: [
          { type: 'image', mimeType: 'image/png', data: 'AQID' },
          { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
        ],
      },
    };
    const blocks = primaryBlocks(item);
    expect(blocks).toEqual([
      {
        type: 'tool_use',
        toolUseId: 'codex-supported-media',
        toolName: 'mcp__raw_server__media',
        input: '{}',
      },
      {
        type: 'tool_result',
        toolUseId: 'codex-supported-media',
        toolName: 'mcp__raw_server__media',
        output: '[Image displayed below]\n\n[image output omitted]',
        isError: false,
      },
      {
        type: 'image',
        path: '',
        dataUrl: 'data:image/png;base64,AQID',
        alt: 'Tool output image',
      },
    ]);
    await matrix([{ item, blocks }], (send) =>
      send('item/completed', { item }),
    );
  });

  it('C03 admits 1,048,608-byte and >16 MiB aggregates on both ports, without a budget interrupt (large case runs only here)', async () => {
    const medium =
      'H'.repeat(524_288) + 'MIDDLE_1M_MARKER' + 'T'.repeat(524_304);
    expect(Buffer.byteLength(medium)).toBe(1_048_608);
    const large =
      'L'.repeat(8_500_000) +
      'MIDDLE_17M_MARKER' +
      'R'.repeat(8_500_000) +
      'END_17M';
    expect(Buffer.byteLength(large)).toBeGreaterThan(16 * 1_024 * 1_024);
    const oracles = [
      commandOracle(
        command('medium', { status: 'completed', aggregatedOutput: medium }),
        medium,
      ),
      commandOracle(
        command('large', { status: 'completed', aggregatedOutput: large }),
        large,
      ),
    ];
    await matrix(
      oracles,
      async (send) => {
        for (const { item } of oracles) {
          await send('item/started', { item: command(item.id) });
          await send('item/completed', { item });
        }
      },
      async (instance, target, rows, events) => {
        const previews = events.filter((event) => event.type === 'transcript');
        expect(previews.length).toBeGreaterThan(0);
        // Stream mode clears the legacy recorder's truncation flag: canonical
        // bodies live behind the transcript port, not these bounded snapshots.
        expect(previews.every((event) => event.truncated === false)).toBe(true);
        expect(JSON.stringify(previews)).not.toContain('MIDDLE_17M_MARKER');
        expect(JSON.stringify(previews)).not.toContain('fullOutputRef');
        if (instance.repository) {
          // Port reads are logical/expanded. Storage is referenced, rather than
          // mistaking a recorder's incomplete bounded preview for canonical data.
          const directory = join(
            instance.repository.store.directory,
            'transcripts',
            'tool-output',
            target.chatId,
          );
          expect(await readdir(directory)).toHaveLength(2);
        }
        expect(rows).toHaveLength(2);
      },
    );
  });

  it('C04 retains delta-only and unfinished middle/end output, split pairs and lone-surrogate encoding', async () => {
    const delta =
      'H'.repeat(40_000) + 'DELTA_MIDDLE😀' + 'é'.repeat(40_000) + 'DELTA_END';
    const interrupted =
      'P'.repeat(33_000) +
      'PARTIAL_MIDDLE' +
      'Z'.repeat(33_000) +
      'PARTIAL_END';
    const pair = 'prefix😀middle😀end';
    const lone = 'lone😀middle\uD800';
    const oracles = [
      commandOracle(command('delta-only'), delta),
      commandOracle(command('unfinished'), interrupted, true),
      commandOracle(command('split-pair'), pair),
      commandOracle(command('lone'), lone),
    ];
    await matrix(oracles, async (send) => {
      for (const { item } of oracles) await send('item/started', { item });
      for (const [id, chunks] of [
        ['delta-only', [delta.slice(0, 40_000), delta.slice(40_000)]],
        ['unfinished', [interrupted]],
        ['split-pair', ['prefix\uD83D', '\uDE00middle\uD83D', '\uDE00end']],
        ['lone', ['lone\uD83D', '\uDE00middle', '\uD800']],
      ] satisfies Array<[string, string[]]>) {
        for (const chunk of chunks)
          await send('item/commandExecution/outputDelta', {
            itemId: id,
            delta: chunk,
          });
        if (id !== 'unfinished')
          await send('item/completed', {
            item: command(id, { status: 'completed' }),
          });
      }
    });
  });

  it('C05 retains >64 interleaved commands, native terminal statuses, terminal-only prose/reasoning and duplicate fences', async () => {
    const oracles = Array.from({ length: 66 }, (_, index) =>
      commandOracle(
        command(`interleaved-${index}`),
        `head-${index}|middle-${index}|end-${index}`,
      ),
    );
    const empty = command('empty', {
      status: 'completed',
      aggregatedOutput: '',
    });
    const failed = command('failed', {
      status: 'failed',
      aggregatedOutput: 'native failure',
    });
    const declined = command('declined', { status: 'declined' });
    const terminal = command('terminal-running', {
      aggregatedOutput: 'terminal partial😀END',
    });
    const prose: NativeItem = {
      id: 'terminal-prose',
      type: 'agentMessage',
      text: 'terminal-only answer',
    };
    const reason: NativeItem = {
      id: 'terminal-reason',
      type: 'reasoning',
      summary: ['terminal-only reasoning'],
      content: [],
    };
    oracles.push(
      commandOracle(empty, 'Done'),
      commandOracle(failed, 'native failure', true),
      commandOracle(declined, 'declined', true),
      commandOracle(terminal, 'terminal partial😀END', true),
      { item: prose, blocks: [{ type: 'text', text: 'terminal-only answer' }] },
      {
        item: reason,
        blocks: [{ type: 'thinking', text: 'terminal-only reasoning' }],
      },
    );
    await matrix(oracles, async (send) => {
      for (const { item } of oracles.slice(0, 66))
        await send('item/started', { item });
      for (const part of ['head', 'middle', 'end']) {
        for (let index = 0; index < 66; index++)
          await send('item/commandExecution/outputDelta', {
            itemId: `interleaved-${index}`,
            delta: `${part === 'head' ? '' : '|'}${part}-${index}`,
          });
      }
      for (const { item } of oracles.slice(0, 66)) {
        const completed = { ...item, status: 'completed' };
        // Both source events arrive before the first receipt/eviction; the
        // runner's lane must serialize them and admit only one final.
        await Promise.all([
          send('item/completed', { item: completed }),
          send('item/completed', { item: completed }),
        ]);
        await send('item/commandExecution/outputDelta', {
          itemId: item.id,
          delta: 'late-after-ack',
        });
      }
      await send('item/started', { item: command('empty') });
      await send('item/commandExecution/outputDelta', {
        itemId: 'empty',
        delta: 'must be discarded by explicit empty aggregate',
      });
      for (const item of [empty, failed, declined])
        await send('item/completed', { item });
      await send('turn/completed', {
        turn: {
          id: MATRIX_TURN,
          status: 'interrupted',
          items: [terminal, prose, reason],
        },
      });
    });
  });
});
