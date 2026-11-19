import { InterfaceToolRegistry } from '@canopy/core-runtime/node/client';
import { interfaceToolDescriptor } from '@canopy/protocol/canopy-core';
import type { AgentSession, AgentSessionOptions } from '../types';
import {
  buildSessionKey,
  destroyAllSessions,
  getOrCreateSession,
  getSessionChangedOptions,
  registerSession,
} from '../session-manager';
import { runInAgentWorker } from '../../agent-runs/agent-worker-context';
import {
  resolveSessionInterfaceTools,
  setSessionInterfaceToolRegistry,
} from '../interface-tool-binding';
import { windowAgentInterfacePort } from '../agent-interface-port';
import { sendToWindow } from '../../lib/window-send';
import {
  INGESTION_LAG_EVENT_TYPE,
  IPC_CHANNELS,
  PROMPT_SUGGESTION_EVENT_TYPE,
  type ChatIngestionLagEventData,
  type PlanExitRequestEvent,
  type PromptSuggestionEventData,
} from '@canopy/desktop-shared/types';

jest.mock('../../lib/window-send', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../lib/window-send'),
  sendToWindow: jest.fn(),
}));

jest.mock('../claude-session', () => ({
  ClaudeCodeProvider: class {
    createSession = (opts: AgentSessionOptions): Partial<AgentSession> => {
      const session: Partial<AgentSession> = {
        isDisposed: (): boolean => false,
        destroy: (): Promise<void> => Promise.resolve(),
        setApprovalMode: (): Promise<void> => Promise.resolve(),
      };
      registerSession(
        buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId),
        session as AgentSession,
        new AbortController(),
        'claude',
        opts.model,
        opts.assistantMode,
      );
      return session;
    };
  },
}));

const options: AgentSessionOptions = {
  cwd: '/tmp/canopy-interface-tools',
  projectId: 'ws',
  worktreeId: 'wt',
  chatId: 'chat',
  planMode: false,
  providerType: 'claude',
  executionHarness: 'claude',
};

function mainWindowLease(): InterfaceToolRegistry {
  const registry = new InterfaceToolRegistry();
  registry.openLease(
    { leaseId: 'main-1', surface: 'main', interfaceKind: 'desktop' },
    { deliver: () => true, cancel: () => undefined },
  );
  registry.register('main-1', {
    tools: [interfaceToolDescriptor('ui.show_files')],
    _meta: { idempotencyKey: 'main-tools' },
  });
  setSessionInterfaceToolRegistry(registry);
  return registry;
}

afterEach(async () => {
  setSessionInterfaceToolRegistry(null);
  await destroyAllSessions();
});

describe('session interface tool binding (CAN-4131)', () => {
  it('resolveSessionInterfaceTools follows the registry', () => {
    expect(resolveSessionInterfaceTools({})).toEqual([]);
    const registry = mainWindowLease();
    expect(resolveSessionInterfaceTools({})).toEqual(['ui.show_files']);
    expect(
      resolveSessionInterfaceTools({ assistantMode: 'pipeline-editor' }),
    ).toEqual([]);
    expect(
      resolveSessionInterfaceTools({ assistantMode: 'app-advisor' }),
    ).toEqual(['ui.show_files']);
    registry.endLease('main-1');
    expect(resolveSessionInterfaceTools({})).toEqual([]);
  });

  it('a session bound with ShowFiles is replaced at the next turn after the lease ends', async () => {
    const registry = mainWindowLease();
    await runInAgentWorker({ kind: 'turn', runId: 'r' }, () =>
      getOrCreateSession(
        options,
        () => undefined,
        windowAgentInterfacePort(() => null),
      ),
    );
    await expect(getSessionChangedOptions(options)).resolves.not.toContain(
      'interfaceTools',
    );
    registry.endLease('main-1');
    await expect(getSessionChangedOptions(options)).resolves.toContain(
      'interfaceTools',
    );
  });
});

describe('agent interface port over the main window (CAN-6995)', () => {
  it('sends transient events on chat:event and the plan exit on plan:exit-request', () => {
    const send = jest.mocked(sendToWindow);
    send.mockClear();
    const port = windowAgentInterfacePort(() => null);
    const target = { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' };
    const suggestion: PromptSuggestionEventData = {
      type: PROMPT_SUGGESTION_EVENT_TYPE,
      text: 'Run the tests',
      turnUserMessageId: 'user-1',
    };
    const lag: ChatIngestionLagEventData = {
      type: INGESTION_LAG_EVENT_TYPE,
      lag: null,
    };
    const planExit: PlanExitRequestEvent = {
      requestId: 'plan-1',
      ...target,
      toolInput: {},
    };
    port.publishPromptSuggestion(target, suggestion);
    port.publishIngestionLag(target, lag);
    port.presentPlanExit(planExit);
    expect(send.mock.calls).toEqual([
      [null, IPC_CHANNELS.chatEvent, { ...target, data: suggestion }],
      [null, IPC_CHANNELS.chatEvent, { ...target, data: lag }],
      [null, IPC_CHANNELS.planExitRequest, planExit],
    ]);
  });
});
