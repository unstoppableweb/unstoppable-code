// CAN-5095: the Codex workflow step runner moved to desktop-shared and runs
// over ports; Electron main's ports keep the mockCalls it made before, in order.
import type { CodexPromptRunnerRequest } from '@canopy/execution-engine/node/pipelines/executor/types';
import { runCodexPipelinePromptWith } from '@canopy/execution-engine/node/pipelines/codex-pipeline-prompt';
import { desktopCodexPipelinePromptPorts } from '../codex-pipeline-prompt-ports';

interface StartThreadRequest {
  params: { dynamicTools?: unknown; developerInstructions?: string };
}

const mockCalls: string[] = [];
const mockLedgerSpecs = [
  { name: 'ledger_note', description: 'Note', inputSchema: {} },
];
const mockLedgerTools = {
  instructions: 'LEDGER INSTRUCTIONS',
  specs: mockLedgerSpecs,
  policy: jest.fn(() => ({})),
  dispose: jest.fn(() => {
    mockCalls.push('ledger.dispose');
  }),
};
const mockHandle = {
  threadId: 't1',
  capabilitySnapshotId: 'snapshot',
  runTurn: jest.fn(() =>
    Promise.resolve({
      status: 'completed',
      threadId: 't1',
      finalText: 'ok',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  ),
  unsubscribe: jest.fn(() => {
    mockCalls.push('handle.unsubscribe');
    return Promise.resolve();
  }),
};
const mockRuntime = {
  startThread: jest.fn<Promise<typeof mockHandle>, [StartThreadRequest]>(() =>
    Promise.resolve(mockHandle),
  ),
  resumeThread: jest.fn(),
  revokeStdioMcpRoutes: jest.fn(() => {
    mockCalls.push('runtime.revokeStdioMcpRoutes');
    return Promise.resolve();
  }),
};
const mockMcpProxy = {
  getCodexCapabilityAuthorityIds: jest.fn(() => []),
  unregisterRoutesForSession: jest.fn(() => {
    mockCalls.push('mcpProxy.unregisterRoutesForSession');
  }),
};
const mockGateway = {
  unregisterRoutesForSession: jest.fn(() => {
    mockCalls.push('gateway.unregisterRoutesForSession');
  }),
};
const mockResolveRouting = jest.fn(() => Promise.resolve(null));

jest.mock('../../codex/runtime-service', () => ({
  getCodexRuntimeService: (): unknown => mockRuntime,
}));
jest.mock('../../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: (): unknown => mockMcpProxy,
}));
jest.mock('../../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: (): unknown => mockGateway,
}));
jest.mock('../../agents/ai-credits-routing', () => ({
  resolveAiCreditsRoutingOverride: (...args: unknown[]): unknown =>
    Reflect.apply(mockResolveRouting, undefined, args),
}));
jest.mock('../../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: (): unknown => ({
    environment: {},
    logicalWorkspaceEnvironmentId: 'env',
  }),
}));
jest.mock('../../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn(() => {
    throw new Error('No plugins in this test.');
  }),
}));
jest.mock('../pipeline-ledger', () => ({
  openPipelineLedgerCodexTools: (): unknown => mockLedgerTools,
}));

function request(
  overrides: Partial<CodexPromptRunnerRequest> = {},
): CodexPromptRunnerRequest {
  return {
    cwd: '/tmp/run',
    prompt: 'Do the thing',
    environment: {},
    model: 'gpt-6.1-sol',
    fastMode: false,
    totalTimeoutMs: 60_000,
    permissionPreset: 'read_only',
    projectId: 'workspace-1',
    worktreeId: 'worktree-1',
    executionContext: 'context-1',
    ledgerAttemptKey: 'attempt-1',
    executionId: 'e',
    jobId: 'j',
    stepId: 's',
    attempt: 1,
    stepLabel: 'Step',
    ...overrides,
  };
}

describe('desktop Codex workflow ports', () => {
  beforeEach(() => {
    mockCalls.length = 0;
    jest.clearAllMocks();
  });

  it("the desktop ports keep the runner's mockCalls and their order", async () => {
    const result = await runCodexPipelinePromptWith(
      request(),
      desktopCodexPipelinePromptPorts,
    );
    expect(result).toMatchObject({ status: 'success', rawText: 'ok' });
    expect(mockResolveRouting).toHaveBeenCalledWith(
      'gpt-6.1-sol',
      'codex',
      undefined,
      'pipeline:e:j:s:1',
      {
        environmentRuntime: 'pipeline',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        executionContext: 'context-1',
      },
    );
    expect(mockRuntime.startThread).toHaveBeenCalledTimes(1);
    const start = mockRuntime.startThread.mock.calls[0]?.[0];
    expect(start?.params.dynamicTools).toEqual(mockLedgerSpecs);
    expect(
      start?.params.developerInstructions?.endsWith('LEDGER INSTRUCTIONS'),
    ).toBe(true);
    expect(mockCalls).toEqual([
      'ledger.dispose',
      'handle.unsubscribe',
      'mcpProxy.unregisterRoutesForSession',
      'gateway.unregisterRoutesForSession',
      'runtime.revokeStdioMcpRoutes',
    ]);
  });

  it('a runner without a plugin port fails a step with plugin selections before any thread starts', async () => {
    const result = await runCodexPipelinePromptWith(
      request({
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      }),
      { ...desktopCodexPipelinePromptPorts, resolvePlugins: undefined },
    );
    expect(result).toMatchObject({
      status: 'failure',
      failure: { message: 'Workflow plugins are not available here.' },
    });
    expect(mockRuntime.startThread).not.toHaveBeenCalled();
  });
});
