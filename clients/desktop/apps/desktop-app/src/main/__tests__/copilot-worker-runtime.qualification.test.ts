import {
  AgentOutsideWorkerError,
  runInAgentWorker,
} from '../agent-runs/agent-worker-context';
import { getCopilotWorkerRuntime } from '../agent-runs/copilot-worker-runtime';
import {
  setWorkerProviderRuntimeForTests,
  workerProviderRuntimeFor,
  type WorkerProviderRuntime,
} from '../agent-runs/worker-provider-runtimes';
import { CopilotProvider } from '../agents/copilot-session';
import type { AgentSessionOptions } from '../agents/types';
import { openManagedCopilotRuntime } from '../copilot/connection';
import { windowAgentInterfacePort } from '../agents/agent-interface-port';

jest.mock('../agents/copilot-session', () => ({
  CopilotProvider: jest
    .fn()
    .mockImplementation(() => ({ createSession: jest.fn() })),
}));
jest.mock('../copilot/connection', () => ({
  openManagedCopilotRuntime: jest.fn(() =>
    Promise.resolve({
      account: null,
      generation: 1,
      close: jest.fn(),
      runTurn: jest.fn(),
      listModels: jest.fn(),
      getQuota: jest.fn(),
    }),
  ),
}));
const mockMarkToolResultDelivered = jest.fn<boolean, unknown[]>(() => true);
jest.mock('../deferred-tools/reload-coordinator', () => ({
  deferredToolsReloadCoordinator: {
    markToolResultDelivered: (...args: unknown[]): boolean =>
      mockMarkToolResultDelivered(...args),
  },
}));

async function copilotRuntime(): Promise<WorkerProviderRuntime> {
  const runtime = await workerProviderRuntimeFor('copilot');
  if (!runtime) throw new Error('No Copilot worker runtime is registered.');
  return runtime;
}

describe('Copilot worker runtime (CAN-4119)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('a Copilot session is constructed by the worker runtime inside a turn run', async () => {
    const provider = await runInAgentWorker(
      { kind: 'turn', runId: 'r1' },
      async () =>
        (await copilotRuntime()).providerFor(
          'copilot',
          windowAgentInterfacePort(() => null),
        ),
    );
    expect(provider).toBe(jest.mocked(CopilotProvider).mock.results[0].value);
    expect(CopilotProvider).toHaveBeenCalledTimes(1);
    expect(CopilotProvider).toHaveBeenCalledWith();
  });

  it('a subagent run may construct the provider', async () => {
    await runInAgentWorker({ kind: 'subagent', runId: 's1' }, async () =>
      (await copilotRuntime()).providerFor(
        'copilot',
        windowAgentInterfacePort(() => null),
      ),
    );
    expect(CopilotProvider).toHaveBeenCalledTimes(1);
  });

  it('refuses a Copilot provider outside an agent run', async () => {
    const runtime = await copilotRuntime();
    await expect(
      runtime.providerFor(
        'copilot',
        windowAgentInterfacePort(() => null),
      ),
    ).rejects.toThrow(
      new AgentOutsideWorkerError('CopilotWorkerRuntime.providerFor'),
    );
    expect(CopilotProvider).not.toHaveBeenCalled();
  });

  it('opens a session runtime owned by the turn run', async () => {
    const signal = new AbortController().signal;
    await runInAgentWorker({ kind: 'turn', runId: 'r1' }, () =>
      getCopilotWorkerRuntime().openSessionRuntime('CopilotSession.run', {
        signal,
        cwd: '/w',
        workspaceId: 'p',
      }),
    );
    expect(openManagedCopilotRuntime).toHaveBeenCalledTimes(1);
    expect(openManagedCopilotRuntime).toHaveBeenCalledWith({
      signal,
      cwd: '/w',
      workspaceId: 'p',
      purpose: 'session',
      owner: { kind: 'turn', id: 'r1' },
    });
    await runInAgentWorker({ kind: 'subagent', runId: 's1' }, () =>
      getCopilotWorkerRuntime().openSessionRuntime(
        'CopilotDelegationRunner.execute',
        { signal, cwd: '/w', workspaceId: 'p', restrictedEnvironment: true },
      ),
    );
    expect(openManagedCopilotRuntime).toHaveBeenLastCalledWith({
      signal,
      cwd: '/w',
      workspaceId: 'p',
      restrictedEnvironment: true,
      purpose: 'session',
      owner: { kind: 'subagent', id: 's1' },
    });
  });

  it('refuses a session runtime opened outside an agent run', async () => {
    const signal = new AbortController().signal;
    await expect(
      Promise.resolve().then(() =>
        getCopilotWorkerRuntime().openSessionRuntime('CopilotSession.run', {
          signal,
        }),
      ),
    ).rejects.toThrow(new AgentOutsideWorkerError('CopilotSession.run'));
    expect(openManagedCopilotRuntime).not.toHaveBeenCalled();
  });

  it('acknowledgeToolResult delegates to the reload coordinator', () => {
    const scope = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
    expect(
      getCopilotWorkerRuntime().acknowledgeToolResult(scope, 'route:rpc-1'),
    ).toBe(true);
    expect(mockMarkToolResultDelivered).toHaveBeenCalledTimes(1);
    expect(mockMarkToolResultDelivered).toHaveBeenCalledWith(
      scope,
      'route:rpc-1',
    );
    mockMarkToolResultDelivered.mockReturnValueOnce(false);
    expect(
      getCopilotWorkerRuntime().acknowledgeToolResult(scope, 'route:rpc-1'),
    ).toBe(false);
  });

  it('refuses a Copilot session created outside an agent run', () => {
    jest.isolateModules(() => {
      const actual = jest.requireActual<{
        CopilotProvider: typeof CopilotProvider;
      }>('../agents/copilot-session');
      let refusal: unknown;
      try {
        new actual.CopilotProvider().createSession(
          {
            projectId: 'p',
            worktreeId: 'w',
            chatId: 'c',
          } as AgentSessionOptions,
          () => undefined,
          windowAgentInterfacePort(() => null),
        );
      } catch (error) {
        refusal = error;
      }
      // The isolated registry loads its own copy of the error class.
      expect(refusal).toMatchObject({
        name: 'AgentOutsideWorkerError',
        message: new AgentOutsideWorkerError('CopilotProvider.createSession')
          .message,
      });
    });
  });

  it('a test override replaces the harness runtime', async () => {
    const fake: WorkerProviderRuntime = {
      harness: 'copilot',
      providerFor: jest.fn(),
    };
    setWorkerProviderRuntimeForTests('copilot', fake);
    try {
      expect(await workerProviderRuntimeFor('copilot')).toBe(fake);
    } finally {
      setWorkerProviderRuntimeForTests('copilot', undefined);
    }
    expect(await workerProviderRuntimeFor('copilot')).toBe(
      getCopilotWorkerRuntime(),
    );
  });
});
