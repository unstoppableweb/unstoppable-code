import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentDelegationError,
  AgentDelegationResult,
  AgentDelegationSnapshot,
  AgentDelegationStatus,
  AgentDelegationUsage,
  AgentDelegationPhase,
  DelegateOutput,
  DelegateSettledStatus,
  GetDelegateOutputRequest,
  GetDelegateOutputValue,
} from '@canopy/protocol/delegation';
import { DELEGATION_NOT_DESCENDANT_ERROR } from '@canopy/protocol/delegation';
import { BRAND } from '@canopy/brand/current';
import {
  AgentDelegationBroker,
  type StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import { AgentRunnerRegistry } from '@canopy/desktop-shared/node/delegation/runner-registry';
import {
  FakeRunner,
  routeFixture,
} from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import { CodexHostToolDispatcher } from '@canopy/execution-engine/node/codex-runtime/host-tools';
import type { CodexHostToolPolicy } from '@canopy/execution-engine/node/codex-runtime/thread-handle';
import type { DynamicToolCallResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallResponse';
import type { CursorCapabilityProjection } from '@canopy/desktop-shared/lib/cursor-capabilities';
import {
  DelegationParent,
  type DelegationParentBroker,
} from '@canopy/desktop-shared/node/delegation/parent';
import {
  createClaudeChildTools,
  createCodexChildTools,
} from '../agents/delegation/child-tools';
import { createCursorDelegationRunner } from '../agents/delegation/cursor-runner';
import { createCopilotDelegationRunner } from '../agents/delegation/copilot-runner';
import { createOpenCodeDelegationRunner } from '../agents/delegation/opencode-runner';
import { DelegationNativePolicy } from '../agents/delegation/native-policy';
import type { CanopyInjectedToolTextResult } from '../canopy-tools/core';
import type { CanopyWorktreeSessionRoute } from '../mcp/http-proxy-service';
import type {
  CursorTurnGates,
  CursorTurnHost,
  CursorTurnRequest,
  CursorTurnResult,
} from '@canopy/desktop-shared/node/cursor/turn-driver';
import type { CopilotTurnOptions } from '@canopy/desktop-shared/node/copilot/turn-driver';
import type { ManagedOpenCodeRuntime } from '../opencode/connection';
import type {
  OpenCodeTurnHost,
  OpenCodeTurnRequest,
  OpenCodeTurnResult,
} from '@canopy/desktop-shared/node/opencode/turn-driver';
import {
  account as copilotAccount,
  nativeRuntime as createCopilotNativeRuntime,
  request as copilotRequest,
  type FixtureRuntime,
} from './helpers/delegation-runner-fixtures/copilot';
import {
  request as cursorRequest,
  success as cursorSuccess,
} from './helpers/delegation-runner-fixtures/cursor';
import { request as openCodeRequest } from './helpers/delegation-runner-fixtures/opencode';
import { runInAgentWorker } from '../agent-runs/agent-worker-context';

const FIXTURE_DIRECTORY = path.join(
  __dirname,
  'fixtures/delegation-output-adapters-golden',
);
// Suite-owned; afterAll removes only this directory.
const RUNNER_DIRECTORY = mkdtempSync(
  path.join(tmpdir(), 'canopy-11c2-output-adapter-golden-'),
);
const OUTPUT_TOOL_NAME = 'GetDelegateOutput';
const DELEGATION_ID = '00000000-0000-4000-8000-000000000001';
const OUTSIDE_DELEGATION_ID = '00000000-0000-4000-8000-000000000099';
const CODEX_THREAD_ID = 'native-golden-thread';
const CODEX_TURN_ID = 'native-golden-turn';
const CODEX_LIMIT_BYTES = 65_536;
const NEAR_LIMIT_BYTES = CODEX_LIMIT_BYTES - 64;
const CAPTURE_GOLDENS = process.env.CANOPY_CAPTURE_OUTPUT_GOLDENS === '1';

interface ClaudeDefinition {
  readonly name: string;
  readonly handler: (
    input: unknown,
    extra?: unknown,
  ) => Promise<{ isError: boolean; content?: { text: string }[] }>;
}

interface MockHttpProxyService {
  registerCanopyWorktreeSessionRoute(
    route: CanopyWorktreeSessionRoute,
  ): Promise<string>;
  unregisterCanopyWorktreeSessionRoute(sessionKey: string): void;
  getCanopyWorktreeMcpUrl(sessionKey: string): string;
  getMcpCapabilityDigests(
    servers: Record<string, unknown>,
  ): Record<string, string>;
}

interface CodexCall {
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly callId: string;
    readonly namespace: null;
    readonly tool: string;
    readonly arguments: unknown;
  };
}

const mockClaudeDefinitions: ClaudeDefinition[] = [];
const mockRoutes: CanopyWorktreeSessionRoute[] = [];
const mockRegisterRoute = jest.fn(
  (route: CanopyWorktreeSessionRoute): Promise<string> => {
    mockRoutes.push(route);
    return Promise.resolve(route.sessionKey);
  },
);
const mockCursorTurn = jest.fn<
  Promise<CursorTurnResult>,
  [CursorTurnRequest, CursorTurnHost]
>();
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
  [CopilotTurnOptions]
>();
const mockOpenCodeTurn = jest.fn<
  Promise<OpenCodeTurnResult>,
  [OpenCodeTurnRequest, OpenCodeTurnHost]
>();
const mockCopilotRuntime = jest.fn<Promise<FixtureRuntime>, [unknown]>();
const mockOpenCodeRuntime = jest.fn<
  Promise<ManagedOpenCodeRuntime>,
  [unknown]
>();
const mockCursorRuntime = jest.fn(() =>
  Promise.resolve({
    launch: { command: '/managed/cursor', args: [] },
    env: { PATH: '/usr/bin' },
    target: { hookRuntime: 'node' },
  }),
);
const mockUnregisterRoute = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (configuration: unknown): unknown => configuration,
  tool: (
    name: string,
    _description: string,
    _schema: unknown,
    handler: ClaudeDefinition['handler'],
  ): ClaudeDefinition => {
    const definition = { name, handler };
    mockClaudeDefinitions.push(definition);
    return definition;
  },
}));

jest.mock('@canopy/desktop-shared/node/cursor/turn-driver', () => ({
  runCursorTurn: (
    request: CursorTurnRequest,
    host: CursorTurnHost,
  ): Promise<CursorTurnResult> => mockCursorTurn(request, host),
}));
jest.mock('../cursor/connection', () => ({
  getManagedCursorRuntime: (): ReturnType<typeof mockCursorRuntime> =>
    mockCursorRuntime(),
}));
jest.mock('../cursor/approval-check', () => ({
  verifyCursorVersion: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../cursor/mcp-servers', () => ({
  buildCursorMcpServers: (): Promise<{
    servers: [];
    notes: [];
    warnings: [];
  }> => Promise.resolve({ servers: [], notes: [], warnings: [] }),
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: (): MockHttpProxyService => ({
    registerCanopyWorktreeSessionRoute: (
      route: CanopyWorktreeSessionRoute,
    ): Promise<string> => mockRegisterRoute(route),
    unregisterCanopyWorktreeSessionRoute: (): void => {
      mockUnregisterRoute();
    },
    getCanopyWorktreeMcpUrl: (): string => 'http://localhost/golden',
    getMcpCapabilityDigests: (): Record<string, string> => ({}),
  }),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  buildCursorCapabilityProjection: (): CursorCapabilityProjection => ({
    skills: [],
    commands: [],
  }),
}));
jest.mock('@canopy/desktop-shared/node/cursor/capability-root', () => ({
  materializeCursorCapabilityRoot: (): Promise<{
    warnings: string[];
    skillIds: string[];
    commandIds: string[];
  }> => Promise.resolve({ warnings: [], skillIds: [], commandIds: [] }),
  materializeSelectedCapabilityRoot: (): Promise<{
    warnings: string[];
    skillIds: string[];
    commandIds: string[];
  }> => Promise.resolve({ warnings: [], skillIds: [], commandIds: [] }),
}));
jest.mock('@canopy/desktop-shared/node/capabilities/file-snapshot', () => ({
  capabilityFiles: (): Promise<[]> => Promise.resolve([]),
  capabilityInstructionIdentity: (): string => '',
}));
jest.mock('../agents/delegation/canopy-tools', () => ({
  delegateAppToolGuidance: (): string => '',
}));
jest.mock('../copilot/connection', () => ({
  openManagedCopilotRuntime: (options: unknown): Promise<FixtureRuntime> =>
    mockCopilotRuntime(options),
  assertCopilotConnectionGeneration: (): void => undefined,
}));
jest.mock('../agent-runs/copilot-worker-runtime', () => ({
  getCopilotWorkerRuntime: (): Record<string, unknown> => ({
    openSessionRuntime: (_entry: string, options: unknown): unknown =>
      mockCopilotRuntime(options),
    acknowledgeToolResult: (): boolean => false,
  }),
}));
jest.mock('@canopy/desktop-shared/node/copilot/turn-driver', () => ({
  runCopilotTurn: (
    options: CopilotTurnOptions,
  ): ReturnType<typeof mockCopilotTurn> => mockCopilotTurn(options),
}));
jest.mock('../opencode/connection', () => ({
  openManagedOpenCodeRuntime: (
    options: unknown,
  ): Promise<ManagedOpenCodeRuntime> => mockOpenCodeRuntime(options),
  assertOpenCodeConnectionGeneration: (): void => undefined,
  // The runtime checks the requested model before the turn starts.
  assertOpenCodeModelAvailable: (
    model: string | undefined,
  ): Promise<{ id: string; label: string }> =>
    Promise.resolve({ id: model ?? 'opencode-model', label: 'OpenCode' }),
}));
jest.mock('../opencode/capability-snapshot', () => ({
  snapshotOpenCodeMcpTools: (): Promise<[]> => Promise.resolve([]),
}));
jest.mock('../opencode/mcp-servers', () => ({
  buildOpenCodeMcpServers: (): [] => [],
  resolveOpenCodeMcpCall: (): undefined => undefined,
}));
jest.mock('../agents/delegation/opencode-policy', () => ({
  openCodeDelegationPolicyIdentity: (): Promise<unknown> => Promise.resolve({}),
}));
jest.mock('@canopy/desktop-shared/node/opencode/turn-driver', () => ({
  runOpenCodeTurn: (
    request: OpenCodeTurnRequest,
    host: OpenCodeTurnHost,
  ): Promise<OpenCodeTurnResult> => mockOpenCodeTurn(request, host),
}));

interface ClaudeGolden {
  readonly deliveryText: string;
  readonly isError: boolean;
  readonly serializedDelivery: string;
}

interface CodexGolden {
  readonly deliveryText: string;
  readonly success: boolean;
  readonly serializedDelivery: string;
}

interface TextErrorGolden {
  readonly deliveryText: string;
  readonly isError: boolean;
  readonly serializedDelivery: string;
}

interface CopilotGolden {
  readonly deliveryText: string;
  readonly resultType: string;
  readonly serializedDelivery: string;
}

interface AdapterGolden {
  readonly scenario: string;
  readonly serializedInvocation: string;
  readonly claude: ClaudeGolden;
  readonly codex: CodexGolden;
  readonly cursor: TextErrorGolden;
  readonly copilot: CopilotGolden;
  readonly opencode: TextErrorGolden;
}

interface OversizedCase {
  readonly name: string;
  readonly changesIn11c2: 'paged';
  readonly response: DynamicToolCallResponse;
  readonly serializedResponse: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure<T>(
  code: AgentDelegationError['code'],
  message: string,
): AgentDelegationResult<T> {
  return {
    ok: false,
    error: { code, message, retryable: false },
  };
}

function outputValue(
  scenario: string,
  finalTextOverride?: string,
): GetDelegateOutputValue {
  let currentStatus: AgentDelegationStatus = 'completed';
  let currentPhase: AgentDelegationPhase = 'idle';
  let latestResultIndex: number | null = 1;
  let resultIndex = 1;
  let status: DelegateSettledStatus = 'completed';
  let finalText: string | undefined;
  let partialText: string | undefined;
  let outputTruncated = false;
  let error: AgentDelegationError | undefined;
  let usage: AgentDelegationUsage | undefined;

  if (scenario === 'final-ascii') finalText = 'A stable ASCII answer.';
  if (scenario === 'escaped-control')
    finalText = 'Quote: " slash: \\ nul: \u0000 unit: \u001f line: \u2028.';
  if (scenario === 'multibyte-astral') finalText = '雪 café 😀';
  if (scenario === 'lone-surrogate') finalText = `before\uD800after`;
  if (scenario === 'partial-only') partialText = 'Partial answer only.';
  if (scenario === 'interrupted-no-text') {
    currentStatus = 'interrupted';
    status = 'interrupted';
  }
  if (scenario === 'empty-final' || scenario === 'empty-final-with-partial')
    finalText = '';
  if (scenario === 'empty-final-with-partial')
    partialText = 'The partial remains beside an empty final.';
  if (scenario === 'both-bodies') {
    finalText = 'Final body.';
    partialText = 'Retained partial body.';
  }
  if (scenario === 'execution-failure-error-usage') {
    currentStatus = 'failed';
    status = 'failed';
    error = {
      code: 'runtime_error',
      message: 'The delegated operation failed.',
      retryable: false,
    };
    usage = { inputTokens: 17, outputTokens: 5 };
  }
  if (scenario === 'output-truncated') {
    finalText = 'Truncated output body.';
    outputTruncated = true;
  }
  if (scenario === 'unsettled-no-result') {
    currentStatus = 'running';
    currentPhase = 'running';
    latestResultIndex = null;
  }
  if (scenario === 'historical-result-index') {
    latestResultIndex = 2;
    resultIndex = 1;
    finalText = 'Historical result one.';
  }
  if (scenario === 'near-limit-codex') finalText = finalTextOverride ?? '';
  if (scenario === 'oversized-1mib-answer') finalText = 'x'.repeat(1_048_576);
  if (scenario === 'oversized-utf8-under-unit-cap')
    finalText = 'é'.repeat(32_768);
  if (scenario === 'oversized-empty-final-large-partial') {
    finalText = '';
    partialText = 'p'.repeat(1_048_576);
  }

  let result: DelegateOutput | null = null;
  if (scenario !== 'unsettled-no-result') {
    result = {
      resultIndex,
      runGeneration: 1,
      status,
      ...(finalText === undefined ? {} : { finalText }),
      ...(partialText === undefined ? {} : { partialText }),
      outputTruncated,
      ...(error === undefined ? {} : { error }),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  return {
    delegationId: DELEGATION_ID,
    currentRunGeneration: 1,
    currentStatus,
    latestResultIndex,
    result,
    currentPhase,
    queue: {
      id: 'default',
      name: 'Default',
      running: 0,
      waiting: 0,
      limit: 2,
    },
  };
}

function nearLimitTextLength(): number {
  const result: AgentDelegationResult<GetDelegateOutputValue> = {
    ok: true,
    value: outputValue('near-limit-codex', ''),
  };
  const envelope: DynamicToolCallResponse = {
    success: true,
    contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
  };
  const emptyResponseBytes = Buffer.byteLength(
    JSON.stringify(envelope),
    'utf8',
  );
  return NEAR_LIMIT_BYTES - emptyResponseBytes;
}

function outputForScenario(
  scenario: string,
  request: GetDelegateOutputRequest,
): AgentDelegationResult<GetDelegateOutputValue> {
  if (request.delegationId !== DELEGATION_ID)
    return {
      ok: false,
      error: { ...DELEGATION_NOT_DESCENDANT_ERROR },
    };
  if (scenario === 'missing-result-index')
    return failure('invalid_request', 'Result index is not available.');
  return {
    ok: true,
    value: outputValue(
      scenario,
      scenario === 'near-limit-codex'
        ? 'x'.repeat(nearLimitTextLength())
        : undefined,
    ),
  };
}

function requestForScenario(scenario: string): unknown {
  if (scenario === 'historical-result-index')
    return { delegationId: DELEGATION_ID, resultIndex: 1 };
  if (scenario === 'missing-result-index')
    return { delegationId: DELEGATION_ID, resultIndex: 2 };
  if (scenario === 'outside-subtree')
    return { delegationId: OUTSIDE_DELEGATION_ID };
  if (scenario === 'malformed-unknown-key')
    return {
      delegationId: DELEGATION_ID,
      unsupported: 'still invalid in 11c2',
    };
  if (scenario === 'malformed-non-integer-index')
    return { delegationId: DELEGATION_ID, resultIndex: 1.5 };
  return { delegationId: DELEGATION_ID };
}

function createParent(
  harness: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode',
  scenario: string,
): DelegationParent {
  const broker: DelegationParentBroker = {
    spawn: (): Promise<AgentDelegationResult<AgentDelegationSnapshot>> =>
      Promise.resolve(
        failure('capability_unavailable', 'Unused golden broker method.'),
      ),
    getOutput: (
      _parent,
      request,
    ): Promise<AgentDelegationResult<GetDelegateOutputValue>> =>
      Promise.resolve(outputForScenario(scenario, request)),
    inspect: () => undefined,
    list: () => [],
    stop: () =>
      failure('capability_unavailable', 'Unused golden broker method.'),
    closeOwner: (): Promise<void> => Promise.resolve(),
  };
  return new DelegationParent({
    owner: {
      harnessId: harness,
      projectId: 'golden-project',
      worktreeId: 'golden-worktree',
      chatId: 'golden-chat',
      sessionKey: 'golden-session',
      runtimeGeneration: 1,
      depth: 0,
    },
    harness,
    namespace: BRAND.tools.namespace,
    names: {
      spawn: 'DelegateTask',
      output: OUTPUT_TOOL_NAME,
      inspect: 'InspectDelegate',
      list: 'ListDelegates',
      stop: 'StopDelegate',
      manageWorktree: 'ManageDelegateWorktree',
      message: 'MessageDelegate',
      requestSteering: 'RequestSteering',
    },
    broker,
    currentTurn: () => CODEX_TURN_ID,
    removeQueued: () => Promise.resolve(),
    reportError: () => undefined,
    responseBudgetMs: 30_000,
    enableDelegationTools: true,
  });
}

function nativePolicy(signal: AbortSignal): DelegationNativePolicy {
  return new DelegationNativePolicy({
    cwd: '/golden/worktree',
    writePaths: [],
    mcpServerNames: [],
    signal,
    delegationId: DELEGATION_ID,
    mode: () => 'full-access',
    allowed: () => Promise.resolve(true),
    approval: {
      check: jest.fn(
        (): Promise<{ decision: 'allow' }> =>
          Promise.resolve({ decision: 'allow' }),
      ),
      setMode: jest.fn(),
      reevaluatePendingApprovals: (): Promise<void> => Promise.resolve(),
      dispose: jest.fn(),
    },
    emit: (): Promise<void> => Promise.resolve(),
  });
}

function outputToolDefinition(): ClaudeDefinition {
  const definition = mockClaudeDefinitions.find(
    (candidate) => candidate.name === OUTPUT_TOOL_NAME,
  );
  if (!definition) throw new Error('Claude output tool was not registered');
  return definition;
}

function codexPolicy(parent: DelegationParent): CodexHostToolPolicy {
  return createCodexChildTools(parent, CODEX_THREAD_ID).policy;
}

function codexDispatcher(policy: CodexHostToolPolicy): CodexHostToolDispatcher {
  return new CodexHostToolDispatcher(
    CODEX_THREAD_ID,
    () => CODEX_TURN_ID,
    policy,
    new AbortController().signal,
  );
}

function codexCall(scenario: string, request: unknown): CodexCall {
  return {
    params: {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      callId: `call-${scenario}`,
      namespace: null,
      tool: OUTPUT_TOOL_NAME,
      arguments: request,
    },
  };
}

async function claudeDelivery(
  parent: DelegationParent,
  request: unknown,
): Promise<ClaudeGolden> {
  mockClaudeDefinitions.length = 0;
  createClaudeChildTools(parent);
  const definition = outputToolDefinition();
  const bound = parent.bindClaude(OUTPUT_TOOL_NAME, request, 'claude-call');
  if (!bound.ok) throw new Error('Could not bind Claude golden call');
  const response = await definition.handler(bound.value);
  const deliveryText = response.content?.[0]?.text;
  if (deliveryText === undefined)
    throw new Error('Claude output adapter returned no serialized content');
  return {
    deliveryText,
    isError: response.isError,
    serializedDelivery: JSON.stringify(response),
  };
}

async function codexDelivery(
  parent: DelegationParent,
  scenario: string,
  request: unknown,
): Promise<CodexGolden> {
  const response = await codexDispatcher(codexPolicy(parent)).run(
    codexCall(scenario, request),
  );
  const item = response.contentItems[0];
  if (!item || item.type !== 'inputText')
    throw new Error('Codex output adapter returned no text item');
  return {
    deliveryText: item.text,
    success: response.success,
    serializedDelivery: JSON.stringify(response),
  };
}

function lastRoute(
  providerType: 'cursor' | 'opencode',
): CanopyWorktreeSessionRoute | undefined {
  for (let index = mockRoutes.length - 1; index >= 0; index--) {
    const route = mockRoutes[index];
    if (route?.providerType === providerType) return route;
  }
  return undefined;
}

function cursorGates(signal: AbortSignal): CursorTurnGates {
  return {
    consumeAllowance: () => true,
    recordGateDecision: () => undefined,
    appToolCallIdentity: (_key, args) => JSON.stringify(args) ?? '',
    pluginCallIdentity: (server, tool, args) =>
      JSON.stringify([server, tool, args]) ?? '',
    abort: () => undefined,
    signal,
  };
}

async function cursorDelivery(
  scenario: string,
  request: unknown,
): Promise<TextErrorGolden> {
  mockRoutes.length = 0;
  mockCursorTurn.mockReset();
  const parent = createParent('cursor', scenario);
  const signal = new AbortController().signal;
  const policy = nativePolicy(signal);
  let delivery: CanopyInjectedToolTextResult | undefined;
  mockCursorTurn.mockImplementation(async (_turnRequest, host) => {
    await host.prepareMcp({ http: true }, cursorGates(signal));
    const route = lastRoute('cursor');
    const managed = route?.managedDelegation;
    if (!managed) throw new Error('Cursor delegation route was not registered');
    delivery = await managed.invoke(OUTPUT_TOOL_NAME, request, {
      requestId: `cursor-${scenario}`,
    });
    return cursorSuccess;
  });
  const runner = createCursorDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'golden-cursor',
        profileDir: path.join(RUNNER_DIRECTORY, 'cursor'),
        tools: policy,
        plugins: [],
        mcpServers: {},
        bindMcpGates: () => undefined,
      }),
    delegation: () => parent,
    reportError: () => undefined,
  });
  const runRequest = cursorRequest({ cwd: '/golden/worktree', signal });
  let finish: () => void = () => undefined;
  const terminal = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handle = await runInAgentWorker(
    { kind: 'subagent', runId: 'golden-cursor' },
    () =>
      runner.start(runRequest, ({ event }) => {
        if (event.type === 'terminal') finish();
        return Promise.resolve();
      }),
  );
  await terminal;
  await runner.close(handle);
  if (!delivery) throw new Error('Cursor adapter did not deliver output');
  return {
    deliveryText: delivery.text,
    isError: delivery.isError ?? false,
    serializedDelivery: JSON.stringify(delivery),
  };
}

async function copilotDelivery(
  scenario: string,
  request: unknown,
): Promise<CopilotGolden> {
  mockCopilotTurn.mockReset();
  const parent = createParent('copilot', scenario);
  const signal = new AbortController().signal;
  const policy = nativePolicy(signal);
  const runtimeFixture = createCopilotNativeRuntime({
    account: copilotAccount,
  });
  mockCopilotRuntime.mockReset();
  mockCopilotRuntime.mockResolvedValue(runtimeFixture.runtime);
  let delivery: unknown;
  mockCopilotTurn.mockImplementation(async (options) => {
    const tool = options.tools?.find(
      (candidate) => candidate.name === OUTPUT_TOOL_NAME,
    );
    if (!tool?.handler)
      throw new Error('Copilot output tool was not registered');
    await options.onToolsReady?.(
      {
        version: 1,
        digest:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      [],
    );
    await options.onSession?.('native-golden');
    delivery = await tool.handler(request, {
      sessionId: 'native-golden',
      toolCallId: `copilot-${scenario}`,
      toolName: OUTPUT_TOOL_NAME,
      arguments: request,
      signal,
    });
    return {
      sessionId: 'native-golden',
      text: 'Provider turn complete.',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  });
  const runner = createCopilotDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'golden-copilot',
        profileDir: path.join(RUNNER_DIRECTORY, 'copilot'),
        tools: policy,
        plugins: [],
        retainedReadRoots: [],
        mcpServers: {},
      }),
    delegation: () => parent,
    reportError: () => undefined,
  });
  const runRequest = copilotRequest({
    cwd: '/golden/worktree',
    signal,
    account: copilotAccount,
  });
  let finish: () => void = () => undefined;
  const terminal = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handle = await runner.start(runRequest, ({ event }) => {
    if (event.type === 'terminal') finish();
    return Promise.resolve();
  });
  await terminal;
  await runner.close(handle);
  if (!isRecord(delivery))
    throw new Error('Copilot adapter did not return a result object');
  if (
    typeof delivery.textResultForLlm !== 'string' ||
    typeof delivery.resultType !== 'string'
  )
    throw new Error('Copilot adapter returned an invalid result object');
  return {
    deliveryText: delivery.textResultForLlm,
    resultType: delivery.resultType,
    serializedDelivery: JSON.stringify(delivery),
  };
}

async function openCodeDelivery(
  scenario: string,
  request: unknown,
): Promise<TextErrorGolden> {
  mockRoutes.length = 0;
  mockOpenCodeTurn.mockReset();
  const parent = createParent('opencode', scenario);
  const signal = new AbortController().signal;
  const policy = nativePolicy(signal);
  let delivery: CanopyInjectedToolTextResult | undefined;
  mockOpenCodeTurn.mockImplementation(async () => {
    const route = lastRoute('opencode');
    const managed = route?.managedDelegation;
    if (!managed)
      throw new Error('OpenCode delegation route was not registered');
    delivery = await managed.invoke(OUTPUT_TOOL_NAME, request, {
      requestId: `opencode-${scenario}`,
    });
    return {
      sessionId: 'native-golden',
      responseText: 'Provider turn complete.',
      isError: false,
      cancelled: false,
      message: '',
    };
  });
  mockOpenCodeRuntime.mockReset();
  mockOpenCodeRuntime.mockResolvedValue({
    runtimeIdentity: { version: 'golden', platform: 'test' },
    executable: '/usr/bin/node',
    spawnProcess: () => {
      throw new Error('The golden mocks the OpenCode turn driver.');
    },
    processOwner: { kind: 'subagent', id: 'golden-opencode' },
    env: { PATH: '/usr/bin' },
    providerConfig: {},
    generation: 1,
    signal,
    close: () => Promise.resolve(),
  });
  const runner = createOpenCodeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'golden-opencode',
        profileDir: path.join(RUNNER_DIRECTORY, 'opencode'),
        tools: policy,
        plugins: [],
        mcpServers: {},
      }),
    delegation: () => parent,
    reportError: () => undefined,
  });
  const runRequest = openCodeRequest({ cwd: '/golden/worktree', signal });
  let finish: () => void = () => undefined;
  const terminal = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handle = await runInAgentWorker(
    { kind: 'subagent', runId: 'golden-opencode' },
    () =>
      runner.start(runRequest, ({ event }) => {
        if (event.type === 'terminal') finish();
        return Promise.resolve();
      }),
  );
  await terminal;
  await runner.close(handle);
  if (!delivery) throw new Error('OpenCode adapter did not deliver output');
  return {
    deliveryText: delivery.text,
    isError: delivery.isError ?? false,
    serializedDelivery: JSON.stringify(delivery),
  };
}

function expectedResult(
  parent: DelegationParent,
  request: unknown,
): Promise<AgentDelegationResult<unknown>> {
  const context = parent.context(CODEX_TURN_ID, 'expected-golden-call');
  if (!context) throw new Error('Expected an active delegation parent');
  return parent.projection.invoke(context, OUTPUT_TOOL_NAME, request);
}

async function outputGolden(scenario: string): Promise<AdapterGolden> {
  const request = requestForScenario(scenario);
  const expectedParent = createParent('codex', scenario);
  const invocation = await expectedResult(expectedParent, request);
  const serializedInvocation = JSON.stringify(invocation);
  const claudeParent = createParent('claude', scenario);
  const codexParent = createParent('codex', scenario);
  const claude = await claudeDelivery(claudeParent, request);
  const codex = await codexDelivery(codexParent, scenario, request);
  const cursor = await cursorDelivery(scenario, request);
  const copilot = await copilotDelivery(scenario, request);
  const opencode = await openCodeDelivery(scenario, request);

  expect(claude.deliveryText).toBe(serializedInvocation);
  expect(codex.deliveryText).toBe(serializedInvocation);
  expect(cursor.deliveryText).toBe(serializedInvocation);
  expect(copilot.deliveryText).toBe(serializedInvocation);
  expect(opencode.deliveryText).toBe(serializedInvocation);
  expect(claude.isError).toBe(!invocation.ok);
  expect(codex.success).toBe(invocation.ok);
  expect(cursor.isError).toBe(!invocation.ok);
  expect(copilot.resultType).toBe(invocation.ok ? 'success' : 'failure');
  expect(opencode.isError).toBe(!invocation.ok);

  return {
    scenario,
    serializedInvocation,
    claude,
    codex,
    cursor,
    copilot,
    opencode,
  };
}

// Supersedes archived oversized-today.json only; every fitting golden stays frozen.
async function oversizedPagedCases(): Promise<{ cases: OversizedCase[] }> {
  const names = [
    'oversized-1mib-answer',
    'oversized-utf8-under-unit-cap',
    'oversized-empty-final-large-partial',
  ];
  const cases: OversizedCase[] = [];
  for (const name of names) {
    const records = new Map<string, StoredDelegation>();
    const runner = new FakeRunner('local-sdk');
    const registry = new AgentRunnerRegistry();
    registry.register({
      apiVersion: 1,
      registrationId: 'third-local',
      adapter: runner,
    });
    const broker = new AgentDelegationBroker({
      registry,
      cwd: '/golden/worktree',
      capacity: 2,
      storage: {
        load: (): Promise<readonly StoredDelegation[]> => Promise.resolve([]),
        loadOne: (delegationId): Promise<StoredDelegation | undefined> => {
          const record = records.get(delegationId);
          return Promise.resolve(record ? structuredClone(record) : undefined);
        },
        commit: (record): Promise<void> => {
          records.set(record.state.delegationId, structuredClone(record));
          return Promise.resolve();
        },
      },
      resolveRoute: (): Promise<
        AgentDelegationResult<ReturnType<typeof routeFixture>>
      > => Promise.resolve({ ok: true, value: routeFixture() }),
      authorize: (): Promise<AgentDelegationResult<undefined>> =>
        Promise.resolve({ ok: true, value: undefined }),
    });
    try {
      await broker.initialize();
      const parent = new DelegationParent({
        owner: {
          harnessId: 'codex',
          projectId: 'golden-project',
          worktreeId: 'golden-worktree',
          chatId: 'golden-chat',
          sessionKey: 'golden-session',
          runtimeGeneration: 1,
          depth: 0,
        },
        harness: 'codex',
        namespace: BRAND.tools.namespace,
        names: {
          spawn: 'DelegateTask',
          output: OUTPUT_TOOL_NAME,
          inspect: 'InspectDelegate',
          list: 'ListDelegates',
          stop: 'StopDelegate',
          manageWorktree: 'ManageDelegateWorktree',
          message: 'MessageDelegate',
          requestSteering: 'RequestSteering',
        },
        broker,
        currentTurn: (): string => CODEX_TURN_ID,
        removeQueued: (): Promise<void> => Promise.resolve(),
        reportError: (): void => undefined,
        responseBudgetMs: 30_000,
        enableDelegationTools: true,
      });
      const context = parent.context(CODEX_TURN_ID, 'oversized-spawn');
      if (!context) throw new Error('Missing oversized parent context');
      const spawned = await broker.spawn(context, {
        modelId: 'logical-review-model',
        description: 'Oversized adapter evidence',
        prompt: 'Read fixed output.',
        executionMode: 'background',
        contextPolicy: 'task_only',
        isolation: 'shared_worktree',
      });
      if (!spawned.ok) throw new Error(spawned.error.message);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const id = spawned.value.delegationId;
      const sink = runner.sinks.get(id);
      if (!sink) throw new Error('Missing oversized event sink');
      const body = outputValue(name).result;
      if (!body) throw new Error('Missing oversized fixture result');
      await sink({
        delegationId: id,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 10,
        event: { type: 'started', nativeSessionId: 'native-oversized' },
      });
      if (body.partialText !== undefined)
        await sink({
          delegationId: id,
          runGeneration: 1,
          sequence: 2,
          occurredAt: 20,
          event: { type: 'progress', text: body.partialText },
        });
      await sink({
        delegationId: id,
        runGeneration: 1,
        sequence: 3,
        occurredAt: 30,
        event: {
          type: 'terminal',
          status: 'completed',
          finalText: body.finalText,
        },
      });
      const response = await codexDispatcher(codexPolicy(parent)).run(
        codexCall(name, { delegationId: id }),
      );
      expect(response.success).toBe(true);
      expect(
        Buffer.byteLength(JSON.stringify(response), 'utf8'),
      ).toBeLessThanOrEqual(CODEX_LIMIT_BYTES);
      const item = response.contentItems[0];
      if (!item || item.type !== 'inputText')
        throw new Error('Missing oversized page delivery');
      const reply: unknown = JSON.parse(item.text);
      if (
        !isRecord(reply) ||
        !isRecord(reply.value) ||
        !isRecord(reply.value.result)
      )
        throw new Error('Missing oversized page result');
      const result = reply.value.result;
      expect(result).not.toHaveProperty('finalText');
      expect(result).not.toHaveProperty('partialText');
      expect(result.answer).toMatchObject({
        role: 'final',
        encoding: 'utf8',
        offset: 0,
        byteLength: Buffer.byteLength(body.finalText ?? '', 'utf8'),
      });
      if (body.finalText === '')
        expect(result.answer).toEqual({
          role: 'final',
          text: '',
          encoding: 'utf8',
          byteLength: 0,
          offset: 0,
        });
      else {
        if (!isRecord(result.answer) || typeof result.answer.text !== 'string')
          throw new Error('Missing page text');
        expect(result.answer.text.length).toBeGreaterThan(0);
        expect(result.answer.nextOffset).toBe(
          Buffer.byteLength(result.answer.text, 'utf8'),
        );
        expect(body.finalText?.startsWith(result.answer.text)).toBe(true);
        expect(result.answer).toHaveProperty('notice');
      }
      cases.push({
        name,
        changesIn11c2: 'paged',
        response,
        serializedResponse: JSON.stringify(response),
      });
    } finally {
      await broker.close();
    }
  }
  return { cases };
}

function compareGolden(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

function assertOrCaptureGolden(name: string, actual: unknown): void {
  // Frozen in the 11c2 A0 commit; capture stays off so the oracle cannot be regenerated.
  if (CAPTURE_GOLDENS)
    throw new Error('Golden capture is disabled: these fixtures are frozen.');
  const file = path.join(FIXTURE_DIRECTORY, `${name}.json`);
  const expectedText = readFileSync(file, 'utf8');
  const expected: unknown = JSON.parse(expectedText);
  compareGolden(actual, expected);
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  mockClaudeDefinitions.length = 0;
  mockRoutes.length = 0;
  mockRegisterRoute.mockClear();
  mockUnregisterRoute.mockClear();
  mockCursorTurn.mockReset();
  mockCopilotTurn.mockReset();
  mockCopilotRuntime.mockReset();
  mockOpenCodeTurn.mockReset();
  mockOpenCodeRuntime.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// The OpenCode runner loads its execution runtime lazily (CAN-4120); load it
// before the timed cases so module setup stays outside their timeout.
beforeAll(async () => {
  await import('../opencode/execution-runtime');
});

afterAll(() => {
  rmSync(RUNNER_DIRECTORY, { recursive: true, force: true });
});

it('captures serialized delivery for all five current delegation adapters', async () => {
  const scenarios = [
    'final-ascii',
    'escaped-control',
    'multibyte-astral',
    'lone-surrogate',
    'partial-only',
    'interrupted-no-text',
    'empty-final',
    'both-bodies',
    'empty-final-with-partial',
    'execution-failure-error-usage',
    'output-truncated',
    'unsettled-no-result',
    'historical-result-index',
    'missing-result-index',
    'outside-subtree',
    'malformed-unknown-key',
    'malformed-non-integer-index',
    'near-limit-codex',
  ];
  for (const scenario of scenarios)
    assertOrCaptureGolden(scenario, await outputGolden(scenario));
});

it('supersedes only the three archived oversized denials with real-broker Codex pages', async () => {
  // oversized-today.json is retained unchanged as the superseded A0 oracle.
  const actual = await oversizedPagedCases();
  const archived: unknown = JSON.parse(
    readFileSync(path.join(FIXTURE_DIRECTORY, 'oversized-today.json'), 'utf8'),
  );
  expect(archived).toMatchObject({
    cases: actual.cases.map(({ name }) => ({
      name,
      changesIn11c2: 'paged',
      response: { success: false },
    })),
  });
  expect(actual.cases).toHaveLength(3);
});

it('proves the adapter golden comparison rejects a mutated captured delivery', async () => {
  const actual = await outputGolden('final-ascii');
  const mutated = {
    ...actual,
    claude: { ...actual.claude, isError: !actual.claude.isError },
  };
  expect(() => compareGolden(mutated, actual)).toThrow();
});
