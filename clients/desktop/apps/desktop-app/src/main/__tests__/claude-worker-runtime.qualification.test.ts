import type * as ClaudeSessionModule from '../agents/claude-session';
import type { ClaudeCodeProviderOptions } from '../agents/claude-session';
import type { AgentSessionOptions } from '../agents/types';
import {
  AgentOutsideWorkerError,
  runInAgentWorker,
} from '../agent-runs/agent-worker-context';
import {
  setWorkerProviderRuntimeForTests,
  workerProviderRuntimeFor,
  type WorkerProviderRuntime,
} from '../agent-runs/worker-provider-runtimes';
import { ClaudeCodeProvider } from '../agents/claude-session';
import { OllamaProvider } from '../agents/ollama-provider';
import { resolveClaudeCompatibleInvocation } from '../ollama/claude-compatible';
import { windowAgentInterfacePort } from '../agents/agent-interface-port';

// Claude and Ollama (Claude harness) providers are constructed only by the
// worker-owned Claude runtime, inside an agent worker run (CAN-4116).

jest.mock('../agents/claude-session', () => ({
  ClaudeCodeProvider: jest.fn().mockImplementation((options: unknown) => ({
    options,
    createSession: jest.fn(),
  })),
}));
jest.mock('../agents/ollama-provider', () => ({
  OllamaProvider: jest.fn().mockImplementation((options: unknown) => ({
    options,
    createSession: jest.fn(),
  })),
}));
jest.mock('../ollama/claude-compatible', () => ({
  resolveClaudeCompatibleInvocation: jest.fn(() =>
    Promise.resolve({
      providerType: 'ollama',
      sdkModel: 'llama3',
      envOverride: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' },
    }),
  ),
}));

function preparerOf(
  options: Pick<ClaudeCodeProviderOptions, 'prepareInvocation'> | undefined,
): NonNullable<ClaudeCodeProviderOptions['prepareInvocation']> {
  const prepare = options?.prepareInvocation;
  if (!prepare)
    throw new Error('the provider was constructed without prepareInvocation');
  return prepare;
}

function constructed(mock: {
  mock: { results: readonly { value: unknown }[] };
}): unknown {
  return mock.mock.results[0]?.value;
}

async function claudeRuntime(): Promise<WorkerProviderRuntime> {
  const runtime = await workerProviderRuntimeFor('claude');
  if (!runtime) throw new Error('no Claude runtime');
  return runtime;
}

const claudeProvider = jest.mocked(ClaudeCodeProvider);
const ollamaProvider = jest.mocked(OllamaProvider);
const resolveInvocation = jest.mocked(resolveClaudeCompatibleInvocation);

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  setWorkerProviderRuntimeForTests('claude', undefined);
});

describe('the worker-owned Claude runtime', () => {
  it('a Claude session is constructed by the worker runtime inside a turn run', async () => {
    const provider = await runInAgentWorker(
      { kind: 'turn', runId: 'r1' },
      async () =>
        (await claudeRuntime()).providerFor(
          'claude',
          windowAgentInterfacePort(() => null),
        ),
    );

    expect(claudeProvider).toHaveBeenCalledTimes(1);
    expect(Object.keys(claudeProvider.mock.calls[0]?.[0] ?? {})).toEqual([
      'prepareInvocation',
    ]);
    expect(provider).toBe(constructed(claudeProvider));
    expect(ollamaProvider).not.toHaveBeenCalled();
    await expect(
      preparerOf(claudeProvider.mock.calls[0]?.[0])(
        'claude-sonnet',
        'session-start',
      ),
    ).resolves.toEqual({ providerType: 'claude', sdkModel: 'claude-sonnet' });
    expect(resolveInvocation).not.toHaveBeenCalled();
  });

  it('an Ollama session is constructed by the worker runtime inside a turn run', async () => {
    const provider = await runInAgentWorker(
      { kind: 'turn', runId: 'r1' },
      async () =>
        (await claudeRuntime()).providerFor(
          'ollama',
          windowAgentInterfacePort(() => null),
        ),
    );

    expect(ollamaProvider).toHaveBeenCalledTimes(1);
    expect(provider).toBe(constructed(ollamaProvider));
    expect(claudeProvider).not.toHaveBeenCalled();
    const prepare = preparerOf(ollamaProvider.mock.calls[0]?.[0]);
    await prepare('ollama:llama3', 'session-start');
    expect(resolveInvocation).toHaveBeenLastCalledWith('ollama:llama3', {
      ensureRunningReason: 'chat',
      assertInstalled: true,
    });
    await prepare('ollama:llama3', 'model-change');
    expect(resolveInvocation).toHaveBeenLastCalledWith('ollama:llama3', {
      ensureRunningReason: 'chat',
      assertInstalled: true,
    });
  });

  it('a subagent run may construct the provider', async () => {
    await runInAgentWorker({ kind: 'subagent', runId: 's1' }, async () =>
      (await claudeRuntime()).providerFor(
        'claude',
        windowAgentInterfacePort(() => null),
      ),
    );

    expect(claudeProvider).toHaveBeenCalledTimes(1);
  });

  it('refuses a Claude-harness provider outside an agent run', async () => {
    const refused = (await claudeRuntime()).providerFor(
      'claude',
      windowAgentInterfacePort(() => null),
    );

    await expect(refused).rejects.toBeInstanceOf(AgentOutsideWorkerError);
    await expect(refused).rejects.toThrow('ClaudeWorkerRuntime.providerFor');
    expect(claudeProvider).not.toHaveBeenCalled();
    expect(ollamaProvider).not.toHaveBeenCalled();
  });

  it('refuses a Claude session created outside an agent run', () => {
    let real: typeof ClaudeSessionModule | undefined;
    jest.isolateModules(() => {
      real = jest.requireActual<typeof ClaudeSessionModule>(
        '../agents/claude-session',
      );
    });
    if (!real) throw new Error('claude-session did not load');
    const provider = new real.ClaudeCodeProvider();
    const options: AgentSessionOptions = {
      cwd: '/w',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
    };

    let thrown: unknown;
    try {
      provider.createSession(
        options,
        () => undefined,
        windowAgentInterfacePort(() => null),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown instanceof Error ? thrown.name : undefined).toBe(
      'AgentOutsideWorkerError',
    );
    expect(thrown instanceof Error ? thrown.message : '').toContain(
      'ClaudeCodeProvider.createSession',
    );
  });

  it('a test override replaces the harness runtime', async () => {
    const real = await claudeRuntime();
    const fake: WorkerProviderRuntime = {
      harness: 'claude',
      providerFor: jest.fn(),
    };

    setWorkerProviderRuntimeForTests('claude', fake);
    await expect(workerProviderRuntimeFor('claude')).resolves.toBe(fake);
    setWorkerProviderRuntimeForTests('claude', undefined);
    await expect(workerProviderRuntimeFor('claude')).resolves.toBe(real);
  });
});
