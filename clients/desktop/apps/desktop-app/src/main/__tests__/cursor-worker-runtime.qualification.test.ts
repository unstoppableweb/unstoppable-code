import type { AgentSessionOptions } from '../agents/types';
import type * as CursorSessionModule from '../agents/cursor-session';
import type * as SessionManagerModule from '../agents/session-manager';
import type * as AgentWorkerContextModule from '../agent-runs/agent-worker-context';
import {
  AgentOutsideWorkerError,
  runInAgentWorker,
  runInAgentWorkerSync,
} from '../agent-runs/agent-worker-context';
import { cursorProcessForWorkerRun } from '../agent-runs/cursor-worker-runtime';
import { spawnProviderProcess } from '../agent-runs/provider-process-host';
import { workerProviderRuntimeFor } from '../agent-runs/worker-provider-runtimes';
import { CursorProvider } from '../agents/cursor-session';
import { windowAgentInterfacePort } from '../agents/agent-interface-port';

jest.mock('../agents/cursor-session', () => ({
  CursorProvider: jest
    .fn()
    .mockImplementation(() => ({ createSession: jest.fn() })),
}));
jest.mock('../agent-runs/provider-process-host', () => ({
  spawnProviderProcess: jest.fn(),
}));

const SESSION: AgentSessionOptions = {
  projectId: 'p',
  worktreeId: 'w',
  chatId: 'c',
  cwd: '/tmp',
  executionHarness: 'cursor',
};

async function cursorRuntime(): ReturnType<typeof workerProviderRuntimeFor> {
  return workerProviderRuntimeFor('cursor');
}

beforeEach(() => {
  jest.mocked(CursorProvider).mockClear();
});

describe('the worker-owned Cursor runtime', () => {
  it('a Cursor session is constructed by the worker runtime inside a turn run', async () => {
    const provider = await runInAgentWorker(
      { kind: 'turn', runId: 'r1' },
      async () =>
        (await cursorRuntime())?.providerFor(
          'cursor',
          windowAgentInterfacePort(() => null),
        ),
    );
    expect(provider).toBe(jest.mocked(CursorProvider).mock.results[0]?.value);
    expect(CursorProvider).toHaveBeenCalledTimes(1);
  });

  it('a subagent run may construct the provider', async () => {
    await runInAgentWorker({ kind: 'subagent', runId: 's1' }, async () =>
      (await cursorRuntime())?.providerFor(
        'cursor',
        windowAgentInterfacePort(() => null),
      ),
    );
    expect(CursorProvider).toHaveBeenCalledTimes(1);
  });

  it('refuses a Cursor provider outside an agent run', async () => {
    const runtime = await cursorRuntime();
    await expect(
      runtime?.providerFor(
        'cursor',
        windowAgentInterfacePort(() => null),
      ),
    ).rejects.toThrow(
      new AgentOutsideWorkerError('CursorWorkerRuntime.providerFor'),
    );
    expect(CursorProvider).not.toHaveBeenCalled();
  });

  it("the turn's approval session and provider child are created inside the turn's worker context", () => {
    expect(
      runInAgentWorkerSync({ kind: 'turn', runId: 'r2' }, () =>
        cursorProcessForWorkerRun('CursorSession.run'),
      ),
    ).toEqual({
      spawner: spawnProviderProcess,
      owner: { kind: 'turn', id: 'r2' },
    });
    expect(() => cursorProcessForWorkerRun('CursorSession.run')).toThrow(
      new AgentOutsideWorkerError('CursorSession.run'),
    );
  });

  it('a managed Cursor subagent spawns its child only inside a subagent run', () => {
    expect(
      runInAgentWorkerSync({ kind: 'subagent', runId: 's2' }, () =>
        cursorProcessForWorkerRun('CursorDelegationRunner.start'),
      ).owner,
    ).toEqual({ kind: 'subagent', id: 's2' });
  });
});

describe('the real Cursor session', () => {
  function loadReal(): {
    module: typeof CursorSessionModule;
    context: typeof AgentWorkerContextModule;
    registerSession: jest.Mock;
  } {
    let loaded: typeof CursorSessionModule | undefined;
    let context: typeof AgentWorkerContextModule | undefined;
    const registerSession = jest.fn();
    jest.isolateModules(() => {
      // The ACP SDK is ESM-only; the session never reaches the ACP client here.
      jest.doMock('@canopy/desktop-shared/node/acp', () => ({}));
      jest.doMock('../agents/session-manager', () => {
        const actual = jest.requireActual<typeof SessionManagerModule>(
          '../agents/session-manager',
        );
        return { ...actual, registerSession };
      });
      // The isolated registry has its own worker context store.
      context = jest.requireActual<typeof AgentWorkerContextModule>(
        '../agent-runs/agent-worker-context',
      );
      loaded = jest.requireActual<typeof CursorSessionModule>(
        '../agents/cursor-session',
      );
    });
    if (!loaded || !context) throw new Error('cursor-session did not load');
    return { module: loaded, context, registerSession };
  }

  it('refuses a Cursor session created outside an agent run', () => {
    const { module, context, registerSession } = loadReal();
    const provider = new module.CursorProvider();
    expect(() =>
      provider.createSession(
        SESSION,
        () => undefined,
        windowAgentInterfacePort(() => null),
      ),
    ).toThrow(
      new context.AgentOutsideWorkerError('CursorProvider.createSession'),
    );
    expect(registerSession).not.toHaveBeenCalled();
  });

  it('a send during a live turn is refused and the session offers no steering', () => {
    const { module, context } = loadReal();
    const provider = new module.CursorProvider();
    // The turn waits on its first projected event, so it stays live.
    const held = new Promise<void>(() => undefined);
    const session = context.runInAgentWorkerSync(
      { kind: 'turn', runId: 'r3' },
      () =>
        provider.createSession(
          SESSION,
          () => held,
          windowAgentInterfacePort(() => null),
        ),
    );
    context.runInAgentWorkerSync({ kind: 'turn', runId: 'r3' }, () =>
      session.sendMessage('first'),
    );
    expect(() =>
      context.runInAgentWorkerSync({ kind: 'turn', runId: 'r4' }, () =>
        session.sendMessage('second'),
      ),
    ).toThrow('Wait for the current Cursor turn to finish.');
    expect('getSteeringCapabilities' in session).toBe(false);
    expect('submitSteeringInput' in session).toBe(false);
    void session.destroy();
  });
});
