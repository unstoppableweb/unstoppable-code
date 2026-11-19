import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('sends a delegate live frame on chat:event with the payload the delegation service sent itself', () => {
    const send = jest.mocked(sendToWindow);
    send.mockClear();
    const port = windowAgentInterfacePort(() => null);
    // A delegation root's target can carry more than the chat address; only
    // the address goes out, in the order the service wrote it.
    const target = {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      surface: 'worktree-chat',
    };
    const live = {
      type: 'canopy_delegation',
      delegation: { delegationId: 'd-1', runGeneration: 1, sequence: 3 },
      canopy_turn_user_message_id: 'user-1',
      delivery: 'live',
      liveClass: 'essential' as const,
    };
    port.publishDelegationLive(target, live);
    const expected = (data: Record<string, unknown>): string =>
      JSON.stringify({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        data,
      });
    expect(
      send.mock.calls.map(([window, channel]) => [window, channel]),
    ).toEqual([[null, IPC_CHANNELS.chatEvent]]);
    expect(
      send.mock.calls.map(([, , payload]) => JSON.stringify(payload)),
    ).toEqual([expected(live)]);
    expect(send.mock.calls[0]?.[2]).toEqual({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      data: live,
    });
  });

  async function proposeOpenCodePlan(applied: boolean): Promise<{
    committed: PlanExitRequestEvent[];
    presented: PlanExitRequestEvent[];
  }> {
    const committed: PlanExitRequestEvent[] = [];
    const presented: PlanExitRequestEvent[] = [];
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../lib/workspace-registry', () => ({
        isCoworkWorkspace: (): boolean => false,
      }));
      jest.doMock('../../canopy-runtime/plan-host-writers', () => ({
        planModeTrackedPlans: {
          createTrackedPlan: (): Promise<unknown> =>
            Promise.resolve({ id: 'plan-1', latestRevisionNumber: 1 }),
          updateTrackedPlan: (): Promise<unknown> => Promise.resolve(null),
        },
      }));
      jest.doMock('../../lib/plan-system-instructions', () => ({
        buildPlanFileSystemInstruction: (): Promise<null> =>
          Promise.resolve(null),
      }));
      jest.doMock('../../services/attention-tracker', () => ({
        getAttentionTracker: (): { mark: () => void } => ({
          mark: (): void => undefined,
        }),
      }));
      jest.doMock('../../services/chat-state-service', () => ({
        getChatStateService: (): Record<string, unknown> => ({
          getState: (): Promise<unknown> =>
            Promise.resolve({
              tabsFile: { tabs: [{ id: 'chat', planMode: true }] },
            }),
          commitPlanExit: (event: PlanExitRequestEvent): Promise<boolean> => {
            committed.push(event);
            return Promise.resolve(applied);
          },
        }),
      }));
      const { publishOpenCodePlanProposal } =
        await import('../../services/chat-state-plan-exit');
      await publishOpenCodePlanProposal({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        plan: '1. Do it',
        userMessageId: 'user-1',
        isCurrent: () => true,
        presentPlanExit: (event): void => void presented.push(event),
      });
    });
    return { committed, presented };
  }

  it('presents the committed OpenCode plan proposal through the port, unchanged', async () => {
    const send = jest.mocked(sendToWindow);
    send.mockClear();
    const { committed, presented } = await proposeOpenCodePlan(true);
    expect(committed).toHaveLength(1);
    expect(presented).toHaveLength(1);
    expect(presented[0]).toBe(committed[0]);
    expect(presented[0]).toMatchObject({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      source: 'opencode',
      reviewMode: 'proposal',
      planId: 'plan-1',
      revisionNumber: 1,
      toolInput: { plan: '1. Do it', source: 'opencode' },
    });
    // The proposal itself sends nothing; the port does.
    expect(send).not.toHaveBeenCalled();
  });

  it('presents nothing when the OpenCode plan proposal was not committed', async () => {
    const { committed, presented } = await proposeOpenCodePlan(false);
    expect(committed).toHaveLength(1);
    expect(presented).toEqual([]);
  });

  it('the OpenCode plan proposal reaches no window itself', () => {
    for (const file of ['../../services/chat-state-plan-exit.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      expect({ file, windowSend: source.includes('lib/window-send') }).toEqual({
        file,
        windowSend: false,
      });
    }
  });
});
