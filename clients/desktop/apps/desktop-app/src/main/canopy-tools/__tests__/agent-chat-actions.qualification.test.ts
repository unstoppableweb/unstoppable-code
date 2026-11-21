import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type * as WorkspaceRegistryModule from '../../lib/workspace-registry';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));
jest.mock('../../ipc/app-advisor', () => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  routeRendererToolRequest: jest.fn(() => null),
  requestAppAdvisorRendererTool: jest.fn(),
}));
const mockCreateWorktree = jest.fn((request: { workspaceId: string }) =>
  Promise.resolve({
    status: 'created',
    workspaceKind: 'single-repo',
    record: { worktreeId: `${request.workspaceId}-new` },
    response: {},
  }),
);
jest.mock('../../lib/worktree-creation', () => ({
  createWorktreeFromSelection: (request: { workspaceId: string }): unknown =>
    mockCreateWorktree(request),
}));
jest.mock('../../lib/workspace-registry', () => ({
  ...jest.requireActual<typeof WorkspaceRegistryModule>(
    '../../lib/workspace-registry',
  ),
  getWorkspaceType: (): 'single-repo' => 'single-repo',
}));
const mockDrain = jest.fn(() => Promise.resolve());
jest.mock('../../agents/session-event-router', () => ({
  drainCurrentSessionEvents: (): Promise<void> => mockDrain(),
}));
const mockCreateSingleRepo = jest.fn();
jest.mock('../../lib/worktree-service', () => ({
  createSingleRepoWorktree: (...args: unknown[]): unknown =>
    mockCreateSingleRepo(...args),
  createMultiRepoWorktree: jest.fn(),
}));
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfig: (): Promise<{ type: 'single-repo' }> =>
    Promise.resolve({ type: 'single-repo' }),
  readWorkspaceWorktrees: (): Promise<[]> => Promise.resolve([]),
  readWorkspaceConfigSync: jest.fn(),
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (): string => '/worktrees/proj/wt',
  resolveWorktreeTargetIds: (): { projectId: string; worktreeId: string } => ({
    projectId: 'proj',
    worktreeId: 'wt',
  }),
}));
jest.mock('../../opencode/fork-session', () => ({
  forkOpenCodeSessionByIdViaOneShot: jest.fn(),
  discardUnpublishedOpenCodeFork: jest.fn(),
}));
jest.mock('../../codex/fork-thread', () => ({
  forkCodexThreadByIdViaOneShot: jest.fn(),
}));
const mockSendToWindow = jest.fn<boolean, unknown[]>(() => false);
jest.mock('../../lib/window-send', () => ({
  sendToWindow: (...args: unknown[]): boolean => mockSendToWindow(...args),
  sendToAllWindows: jest.fn(),
}));
jest.mock('../../lib/desktop-telemetry', () => ({
  recordWorktreeCrudTelemetry: jest.fn(),
}));
const mockCompatibilityTabs = jest.fn(
  (): Promise<{ tabs: unknown[] }> => Promise.resolve({ tabs: [] }),
);
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    getCompatibilityTabs: (): unknown => mockCompatibilityTabs(),
  }),
}));
jest.mock('../../lib/git', () => ({
  getCurrentBranch: (): Promise<string> => Promise.resolve('main'),
}));

import {
  InterfaceToolRegistry,
  type InterfaceToolCall,
} from '@canopy/core-runtime/node/client';
import {
  interfaceToolDescriptor,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import { routeRendererToolRequest } from '../../ipc/app-advisor';
import { windowAgentInterfacePort } from '../../agents/agent-interface-port';
import { setSessionInterfaceToolRegistry } from '../../agents/interface-tool-binding';
import { createDesktopChatWorktree } from '../../agent-actions/desktop-environment-port';
import {
  AGENT_CORE_TOOL_OPERATIONS,
  AgentToolOperationRefusedError,
  agentCoreOperations,
  type AgentCoreOperationDispatcher,
} from '../agent-core-operations';
import { AGENT_CHAT_INTERFACE_TEXTS } from '../agent-chat-interface';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  assertBranchedPromptQueued,
  startSplitAgent,
} from '../start-split-agent-runtime';

const routeRequest = jest.mocked(routeRendererToolRequest);

type CreateCall = Parameters<typeof createDesktopChatWorktree>[1];

function call(): CreateCall {
  return {
    scope: { workspaceId: 'proj', worktreeId: 'wt', chatId: 'chat-1' },
    host: {
      worktreeActionRuntime: {
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        cwd: '/worktrees/proj/wt',
        getWindow: (): null => null,
      },
    },
  } as unknown as CreateCall;
}

const request = {
  workspaceId: 'proj',
  baseWorktreeId: 'wt',
  idempotencyKey: 'start-1:worktree',
};

function mainLease(tools: readonly InterfaceToolName[]): InterfaceToolCall[] {
  const registry = new InterfaceToolRegistry();
  const calls: InterfaceToolCall[] = [];
  registry.openLease(
    { leaseId: 'main-1', surface: 'main', interfaceKind: 'desktop' },
    {
      deliver: (delivered) => {
        calls.push(delivered);
        return true;
      },
      cancel: () => undefined,
    },
  );
  registry.register('main-1', {
    tools: tools.map((name) => interfaceToolDescriptor(name)),
    _meta: { idempotencyKey: 'main-1-tools' },
  });
  setSessionInterfaceToolRegistry(registry);
  return calls;
}

beforeEach(() => {
  mockCreateWorktree.mockClear();
  mockSendToWindow.mockClear();
  mockDrain.mockClear();
  mockCreateSingleRepo.mockClear();
  routeRequest.mockReset();
  routeRequest.mockReturnValue(null);
});
afterEach(() => setSessionInterfaceToolRegistry(null));

describe('worktree chat actions as keyed core writes (CAN-5830)', () => {
  it('a new-worktree chat refuses headless before anything is created', async () => {
    const result = await createDesktopChatWorktree(request, call());

    expect(result).toEqual({
      ok: false,
      code: 'surface_unavailable',
      message: AGENT_CHAT_INTERFACE_TEXTS.needsWindow,
      retryable: true,
    });
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('a new-worktree chat refuses without a bound main window lease', async () => {
    mainLease(['ui.show_files']);

    const result = await createDesktopChatWorktree(request, call());

    expect(result).toMatchObject({ ok: false, code: 'surface_unavailable' });
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('with the main window lease it creates through the keyed W5 writer of core.worktree.create, never the renderer', async () => {
    mainLease(['ui.app_advisor.present', 'ui.show_files']);

    const result = await createDesktopChatWorktree(request, call());

    expect(result).toEqual({ ok: true, worktreeId: 'proj-new' });
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
    expect(mockCreateWorktree.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'proj',
      workspaceKind: 'single-repo',
      idempotencyKey: 'start-1:worktree',
      callerSource: 'agent-chat',
      startPostCreateSetup: true,
      deferGitSetup: true,
    });
  });

  it('a stopped chat creates no worktree', async () => {
    mainLease(['ui.app_advisor.present']);
    const controller = new AbortController();
    controller.abort();
    const stopped = { ...call(), signal: controller.signal } as CreateCall;

    await expect(createDesktopChatWorktree(request, stopped)).rejects.toThrow();
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('a chat driven from another computer may create a worktree', async () => {
    routeRequest.mockReturnValue(
      {} as unknown as NonNullable<ReturnType<typeof routeRendererToolRequest>>,
    );

    const result = await createDesktopChatWorktree(request, call());

    expect(result).toEqual({ ok: true, worktreeId: 'proj-new' });
  });

  it('the branched-agent prompt reaches only core.chat.message.send with the chat grant', async () => {
    const recorded: { name: string; grants: readonly string[] }[] = [];
    const record = (
      name: string,
      _params: unknown,
      options: { caller: { grants: readonly string[] } },
    ): Promise<unknown> => {
      recorded.push({ name, grants: options.caller.grants });
      return Promise.resolve({});
    };
    const chatActions = agentCoreOperations('chatActions', {
      query: record,
      instruction: record,
    } as unknown as AgentCoreOperationDispatcher);
    const send = chatActions.instruction as unknown as (
      name: string,
      params: unknown,
      options: { caller: { grants: readonly string[] } },
    ) => Promise<unknown>;

    await send(
      'core.chat.message.send',
      {},
      {
        caller: { grants: ['core.chat.write', 'core.worktree.write'] },
      },
    );
    await expect(
      send('core.chat.update', {}, { caller: { grants: ['core.chat.write'] } }),
    ).rejects.toBeInstanceOf(AgentToolOperationRefusedError);

    expect(Object.keys(AGENT_CORE_TOOL_OPERATIONS.chatActions)).toEqual([
      'core.chat.message.send',
    ]);
    expect(recorded).toEqual([
      { name: 'core.chat.message.send', grants: ['core.chat.write'] },
    ]);
  });

  it('a branched agent refuses headless before anything is read or created', async () => {
    await expect(
      startSplitAgent(
        'start_branched_agent',
        { followUpInstruction: 'Continue the work.' },
        {
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat-1',
          cwd: '/worktrees/proj/wt',
          getWindow: (): null => null,
          interfacePort: windowAgentInterfacePort(() => null),
        },
      ),
    ).rejects.toThrow(AGENT_CHAT_INTERFACE_TEXTS.needsWindow);
    expect(mockDrain).not.toHaveBeenCalled();
    expect(mockCreateSingleRepo).not.toHaveBeenCalled();
  });

  it('a branched agent refuses without a bound main window lease', async () => {
    mainLease(['ui.show_files']);

    await expect(
      startSplitAgent(
        'start_branched_agent',
        { followUpInstruction: 'Continue the work.' },
        {
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat-1',
          cwd: '/worktrees/proj/wt',
          getWindow: (): null => null,
          interfacePort: windowAgentInterfacePort(() => null),
        },
      ),
    ).rejects.toThrow(AGENT_CHAT_INTERFACE_TEXTS.needsWindow);
    expect(mockCreateSingleRepo).not.toHaveBeenCalled();
  });

  it('a workspace root that needs repair keeps the setup pending for the repair flow', async () => {
    mainLease(['ui.app_advisor.present']);

    await createDesktopChatWorktree(request, call());

    const created = mockCreateWorktree.mock.calls[0]?.[0] as unknown as {
      onNeedsRepair?: (payload: unknown) => void;
    };
    expect(typeof created.onNeedsRepair).toBe('function');
    created.onNeedsRepair?.({ worktreeId: 'proj-new' });
    expect(mockSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.worktreeNeedsRepair,
      { worktreeId: 'proj-new' },
    );
  });

  it("a branched agent's worktree notices reach the window through the chat's interface port, unchanged", async () => {
    mainLease(['ui.app_advisor.present']);
    mockCompatibilityTabs.mockResolvedValueOnce({
      tabs: [
        {
          id: 'chat-1',
          title: 'Source',
          providerType: 'claude',
          messages: [{ id: 'user-1', role: 'user', blocks: [] }],
        },
      ],
    });
    const ready = {
      projectId: 'proj',
      worktreeId: 'wt-new',
      branchName: 'agent/continue',
    };
    const failed = {
      projectId: 'proj',
      worktreeId: 'wt-new',
      error: 'git failed',
    };
    const repair = {
      projectId: 'proj',
      worktreeId: 'wt-new',
      branchName: 'agent/continue',
      repairIssues: [],
    };
    mockCreateSingleRepo.mockImplementationOnce(
      (options: {
        onGitReady: (event: unknown) => void;
        onGitFailed: (event: unknown) => void;
        onNeedsRepair: (event: unknown) => void;
      }) => {
        options.onGitReady(ready);
        options.onGitFailed(failed);
        options.onNeedsRepair(repair);
        return Promise.resolve({ id: 'wt-new' });
      },
    );
    const published: string[] = [];
    const port = windowAgentInterfacePort(() => null);
    const recorded = new Proxy(port, {
      get: (target, name: string): unknown => {
        const member = Reflect.get(target, name) as unknown;
        if (typeof member !== 'function' || !name.startsWith('publish'))
          return member;
        return (...args: unknown[]): unknown => {
          published.push(name);
          return (member as (...a: unknown[]) => unknown)(...args);
        };
      },
    });

    // Nothing after the list is mocked, so the start then fails; the
    // notices it sent before that are what this pins.
    await expect(
      startSplitAgent(
        'start_branched_agent',
        { followUpInstruction: 'Continue the work.' },
        {
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat-1',
          cwd: '/worktrees/proj/wt',
          getWindow: (): null => null,
          interfacePort: recorded,
        },
      ),
    ).rejects.toThrow();

    expect(published).toEqual([
      'publishWorktreeGitReady',
      'publishWorktreeGitFailed',
      'publishWorktreeNeedsRepair',
      'publishWorkspaceWorktrees',
    ]);
    expect(mockSendToWindow.mock.calls).toEqual([
      [null, IPC_CHANNELS.worktreeGitReady, ready],
      [null, IPC_CHANNELS.worktreeGitFailed, failed],
      [null, IPC_CHANNELS.worktreeNeedsRepair, repair],
      [
        null,
        IPC_CHANNELS.workspaceWorktreesUpdated,
        { workspaceId: 'proj', worktrees: [] },
      ],
    ]);
    expect(mockSendToWindow.mock.calls[0]?.[2]).toBe(ready);
    expect(mockSendToWindow.mock.calls[1]?.[2]).toBe(failed);
    expect(mockSendToWindow.mock.calls[2]?.[2]).toBe(repair);
  });

  it('a refused branched prompt fails the start instead of counting as queued', () => {
    expect(() =>
      assertBranchedPromptQueued({ outcome: 'applied' }),
    ).not.toThrow();
    expect(() =>
      assertBranchedPromptQueued({ outcome: 'already_applied' }),
    ).not.toThrow();
    for (const outcome of ['rejected', 'not_found', 'conflict'])
      expect(() => assertBranchedPromptQueued({ outcome })).toThrow(
        'Could not queue the branched agent prompt.',
      );
    expect(() =>
      assertBranchedPromptQueued({
        outcome: 'rejected',
        reason: 'Chat is busy.',
      }),
    ).toThrow('Chat is busy.');
  });
});
