import type { AgentSession, AgentSessionOptions } from '../../agents/types';
import { getOrCreateSession } from '../../agents/session-manager';
import {
  AgentOutsideWorkerError,
  runInAgentWorker,
} from '../agent-worker-context';
import { windowAgentInterfacePort } from '../../agents/agent-interface-port';

const createSession = jest.fn(
  (): Promise<Partial<AgentSession>> =>
    Promise.resolve({
      isDisposed: (): boolean => false,
      destroy: (): Promise<void> => Promise.resolve(),
    }),
);

jest.mock('../../agents/claude-session', () => ({
  ClaudeCodeProvider: class {
    createSession = createSession;
  },
}));

const options: AgentSessionOptions = {
  cwd: '/tmp/canopy-guard',
  projectId: 'ws',
  worktreeId: 'wt',
  chatId: 'chat',
  planMode: false,
  providerType: 'claude',
  executionHarness: 'claude',
};

beforeEach(() => createSession.mockClear());

it('refuses a session created outside an agent run', () => {
  expect(() =>
    getOrCreateSession(
      options,
      () => undefined,
      windowAgentInterfacePort(() => null),
    ),
  ).toThrow(AgentOutsideWorkerError);
  expect(createSession).not.toHaveBeenCalled();
});

it('creates the session inside a turn run', async () => {
  const session = await runInAgentWorker({ kind: 'turn', runId: 'r' }, () =>
    getOrCreateSession(
      options,
      () => undefined,
      windowAgentInterfacePort(() => null),
    ),
  );
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(session.isDisposed?.()).toBe(false);
});
