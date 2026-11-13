import { CodexAppServerClient } from '../../codex/app-server-client';
import {
  runInAgentWorker,
  AgentOutsideWorkerError,
} from '../agent-worker-context';
import {
  CodexRuntimeOutsideWorkerError,
  codexRuntimeForWorkerRun,
  getCodexWorkerRuntime,
  resetCodexWorkerRuntimeForTests,
} from '../codex-worker-runtime';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { runInHelperWorker } from '../../helper-runs/helper-worker-context';

// The worker runtime's pool owns every Codex app-server spawn; its factory is faked here.
interface AttachRequest {
  readonly owner: unknown;
  readonly profile: unknown;
  readonly processCallbacks: Record<string, unknown>;
}

const mockAttach = jest.fn<unknown, [AttachRequest]>(() => ({
  request: jest.fn(),
  notify: jest.fn(),
  close: jest.fn(),
}));
const mockCreateCodexRuntimeService = jest.fn<unknown, [unknown]>(() => ({
  attachInteractiveClient: mockAttach,
  shutdown: (): Promise<void> => Promise.resolve(),
}));

interface ProviderOptions {
  readonly providerType?: string;
  readonly emitIngestionLag?: (
    target: { projectId: string; worktreeId: string; chatId: string },
    data: unknown,
  ) => void;
  readonly prepareInvocation?: (model: unknown) => Promise<unknown>;
}
const mockProviders: ProviderOptions[] = [];
const mockResolveOllama = jest.fn<
  Promise<Record<string, unknown>>,
  [unknown, unknown]
>(() =>
  Promise.resolve({
    runtimeModel: 'llama',
    envOverride: { OLLAMA_HOST: 'x' },
    codexConfig: ['-c', 'k=v'],
    extra: 'ignored',
  }),
);

jest.mock(
  '@canopy/execution-engine/node/codex-runtime',
  (): Record<string, unknown> => ({
    ...jest.requireActual<Record<string, unknown>>(
      '@canopy/execution-engine/node/codex-runtime',
    ),
    createCodexRuntimeService: (options: unknown): unknown =>
      mockCreateCodexRuntimeService(options),
  }),
);
const mockSendToWindow = jest.fn();
jest.mock(
  '../../lib/window-send',
  (): Record<string, unknown> => ({
    sendToWindow: (...args: unknown[]): unknown => mockSendToWindow(...args),
  }),
);
jest.mock(
  '../../codex/runtime-host-adapter',
  (): Record<string, never> => ({}),
);
jest.mock(
  '../../codex/capability-store',
  (): { getDesktopCodexCapabilityStore: () => Record<string, never> } => ({
    getDesktopCodexCapabilityStore: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../../codex/mcp-launcher-command',
  (): { resolveDesktopCodexMcpLauncher: () => unknown } => ({
    resolveDesktopCodexMcpLauncher: (): unknown => ({
      command: '/opt/brand/bin/canopyd',
      args: [],
    }),
  }),
);
jest.mock(
  '../../agents/codex-session',
  (): Record<string, unknown> => ({
    CodexProvider: class {
      constructor(options: ProviderOptions) {
        mockProviders.push(options);
      }
    },
  }),
);
jest.mock(
  '../../ollama/codex-compatible',
  (): Record<string, unknown> => ({
    resolveCodexCompatibleOllamaInvocation: (
      model: unknown,
      options: unknown,
    ): Promise<Record<string, unknown>> => mockResolveOllama(model, options),
  }),
);

afterEach(async () => {
  await resetCodexWorkerRuntimeForTests();
  mockCreateCodexRuntimeService.mockClear();
  mockAttach.mockClear();
  mockProviders.length = 0;
  mockResolveOllama.mockClear();
  mockSendToWindow.mockClear();
});

function clientOptions(): ConstructorParameters<
  typeof CodexAppServerClient
>[0] {
  return {
    cwd: '/tmp/worktree',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    sessionKey: 'session',
    onEvent: (): void => undefined,
    getWindow: (): null => null,
    extraEnv: { FOO: 'bar' },
    onProcessStarted: (): void => undefined,
    onProcessExit: (): void => undefined,
    onProcessError: (): void => undefined,
    onProcessRecovery: (): void => undefined,
  };
}

it('refuses an interactive attach outside a worker run', () => {
  expect(() => codexRuntimeForWorkerRun('attachInteractiveClient')).toThrow(
    new CodexRuntimeOutsideWorkerError('attachInteractiveClient'),
  );
  expect(() => codexRuntimeForWorkerRun('attachInteractiveClient')).toThrow(
    'Codex sessions run through the local worker (attachInteractiveClient).',
  );
  expect(mockCreateCodexRuntimeService).not.toHaveBeenCalled();
});

// A helper run is the context of a worker.agent.helper.run dispatch.
it('admits turn, subagent and helper runs', async () => {
  const turn = await runInAgentWorker({ kind: 'turn', runId: 't' }, () =>
    codexRuntimeForWorkerRun('attachInteractiveClient'),
  );
  const subagent = await runInAgentWorker(
    { kind: 'subagent', runId: 's' },
    () => codexRuntimeForWorkerRun('codexDelegationRunner'),
  );
  const helper = await runInHelperWorker(
    { helperRunId: 'h', kind: 'branch_naming' },
    () => Promise.resolve(codexRuntimeForWorkerRun('runCodexHelperText')),
  );
  expect(subagent).toBe(turn);
  expect(helper).toBe(turn);
});

it("a real interactive client attaches inside a turn run with today's attach request", async () => {
  const options = clientOptions();
  const client = await runInAgentWorker(
    { kind: 'turn', runId: 't' },
    () => new CodexAppServerClient(options),
  );
  expect(mockAttach).toHaveBeenCalledTimes(1);
  const request = mockAttach.mock.calls[0]?.[0];
  expect(request?.owner).toBe(client);
  expect(request?.profile).toEqual({ environment: { FOO: 'bar' } });
  expect(request?.processCallbacks).toEqual({
    onProcessStarted: options.onProcessStarted,
    onProcessExit: options.onProcessExit,
    onProcessError: options.onProcessError,
    onProcessRecovery: options.onProcessRecovery,
  });

  expect(() => new CodexAppServerClient(clientOptions())).toThrow(
    CodexRuntimeOutsideWorkerError,
  );
});

it('a context continued from a run still admits', async () => {
  const [now, later] = await runInAgentWorker(
    { kind: 'turn', runId: 't' },
    async () => {
      const current = codexRuntimeForWorkerRun('attachInteractiveClient');
      const continued = await new Promise((resolve) => {
        setTimeout(() => {
          resolve(codexRuntimeForWorkerRun('attachInteractiveClient'));
        }, 0);
      });
      return [current, continued];
    },
  );
  expect(later).toBe(now);
});

it('the worker runtime constructs Codex providers only inside a run', async () => {
  await expect(
    getCodexWorkerRuntime().providerFor('codex', () => null),
  ).rejects.toBeInstanceOf(AgentOutsideWorkerError);

  await runInAgentWorker({ kind: 'turn', runId: 't' }, () =>
    getCodexWorkerRuntime().providerFor('codex', () => null),
  );
  expect(mockProviders).toHaveLength(1);
  expect(mockProviders[0]?.emitIngestionLag).toEqual(expect.any(Function));
  expect(mockProviders[0]).not.toHaveProperty('providerType');

  const target = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
  mockProviders[0]?.emitIngestionLag?.(target, { sample: 1 });
  expect(mockSendToWindow).toHaveBeenCalledWith(null, IPC_CHANNELS.chatEvent, {
    ...target,
    data: { sample: 1 },
  });
});

it('Ollama on the Codex harness keeps its invocation', async () => {
  await runInAgentWorker({ kind: 'turn', runId: 't' }, () =>
    getCodexWorkerRuntime().providerFor('ollama', () => null),
  );
  const provider = mockProviders[0];
  expect(provider?.providerType).toBe('ollama');
  await expect(provider?.prepareInvocation?.('model-x')).resolves.toEqual({
    runtimeModel: 'llama',
    envOverride: { OLLAMA_HOST: 'x' },
    codexConfig: ['-c', 'k=v'],
  });
  expect(mockResolveOllama).toHaveBeenCalledTimes(1);
  expect(mockResolveOllama).toHaveBeenCalledWith('model-x', {
    ensureRunningReason: 'chat',
    assertInstalled: true,
  });
});
