import type {
  ChatStateCommandPort,
  ChatStateSnapshot,
  PersistedChatTab,
  PortalCommandEnvelope,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { BrowserWindow } from 'electron';
import { CoreChatUpdateParamsSchema } from '@canopy/protocol/canopy-core';
import { getActiveDesktopRuntimeIfAccepting } from '../../../canopy-runtime/desktop-runtime';
import type { DesktopCanopyDispatcher } from '../../../canopy-runtime/desktop-runtime';
import { requestPortalComposerCommand } from '../../../ipc/portal-composer-command';
import {
  handlePortalChatSetFastMode,
  handlePortalChatSetModel,
  handlePortalChatSetPlanMode,
  handlePortalChatSetThinkingLevel,
} from '../chat-adapter';
import { queryPortalChatState } from '../chat-state-query';
import { handlePortalStandaloneChatSend } from '../standalone-chat-adapter';
import type { PortalAdapterContext } from '../types';

jest.mock('@canopy/desktop-shared/types', () => ({
  ...jest.requireActual<object>('@canopy/desktop-shared/types'),
  resolveKnownModel: jest.fn((model: string) => model),
  getProviderForModel: jest.fn((model: string) =>
    model.startsWith('antigravity:')
      ? 'antigravity'
      : model.startsWith('copilot-')
        ? 'copilot'
        : 'claude',
  ),
  requireProviderForModel: jest.fn((model: string) =>
    model.startsWith('antigravity:') ? 'antigravity' : 'claude',
  ),
}));
jest.mock('../../../canopy-runtime/desktop-runtime', () => ({
  ...jest.requireActual<object>('../../../canopy-runtime/desktop-runtime'),
  getActiveDesktopRuntimeIfAccepting: jest.fn(),
}));
jest.mock('../chat-state-query', () => ({
  ...jest.requireActual<object>('../chat-state-query'),
  queryPortalChatState: jest.fn(),
}));
jest.mock('../../../copilot/runtime-availability', () => ({
  isCopilotRuntimeAvailable: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../../../ipc/portal-composer-command', () => ({
  requestPortalComposerCommand: jest.fn(),
}));
jest.mock('../../../lib/model-policy-state', () => ({
  ...jest.requireActual<object>('../../../lib/model-policy-state'),
  isModelBlockedByStoredPolicy: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../../../agents/work-owner', () => ({
  ...jest.requireActual<object>('../../../agents/work-owner'),
  resolveAiCreditsScopeOwner: jest.fn(() => Promise.resolve(undefined)),
}));
jest.mock('../../../agents/agent-default-model', () => ({
  ...jest.requireActual<object>('../../../agents/agent-default-model'),
  pinInheritingAgentToDestination: jest.fn((model: string) =>
    Promise.resolve(model),
  ),
}));

// CAN-5097: the adapter calls getClaudeTerminalSessionService().restartForSettingsChange
// after a windowless thinking or model commit.
jest.mock('../../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): typeof mockTerminalService =>
    mockTerminalService,
}));
const mockTerminalService = {
  restartForSettingsChange: jest.fn<Promise<void>, [unknown]>(() =>
    Promise.resolve(),
  ),
};

const instruction = jest.fn<Promise<unknown>, [string, unknown, unknown]>();

function snapshotWith(tab?: Partial<PersistedChatTab>): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    revision: 1,
    tabsFile: {
      version: 1,
      activeTabId: 'chat-1',
      tabs: tab
        ? [
            {
              id: 'chat-1',
              title: 'Chat',
              createdAt: '2026-11-06T00:00:00.000Z',
              messages: [],
              ...tab,
            },
          ]
        : [],
    },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

function makeContext(window: BrowserWindow | null = null): {
  context: PortalAdapterContext;
  complete: jest.Mock;
  fail: jest.Mock;
} {
  const complete = jest.fn();
  const fail = jest.fn();
  const port: ChatStateCommandPort = {
    command: jest.fn(),
    getState: jest.fn(),
    getTranscriptPage: jest.fn(),
    readVisual: jest.fn(),
    readToolOutput: jest.fn(),
    searchTranscript: jest.fn(),
    subscribe: jest.fn(() => () => undefined),
  };
  return {
    context: {
      sessionId: 'portal-session',
      getWindow: () => window,
      enqueueEvent: jest.fn(),
      complete,
      fail,
      chatStatePort: port,
    },
    complete,
    fail,
  };
}

function envelope<T>(id: string, payload: T): PortalCommandEnvelope<T> {
  return {
    id,
    sequence: 1,
    type: 'portal.chat.set_plan_mode',
    payload,
    createdAt: '2026-11-06T00:00:00.000Z',
    expiresAt: null,
  };
}

const target = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

function lastUpdate(): {
  commandId: string;
  origin?: string;
  action: Record<string, unknown>;
} {
  const call = instruction.mock.calls.at(-1);
  expect(call?.[0]).toBe('core.chat.update');
  return call?.[1] as {
    commandId: string;
    origin?: string;
    action: Record<string, unknown>;
  };
}

describe('Portal settings changes through the core (CAN-4110)', () => {
  beforeEach(() => {
    instruction.mockReset();
    instruction.mockImplementation((_name, params) =>
      Promise.resolve({
        commandId: (params as { commandId: string }).commandId,
        revision: 2,
        outcome: 'applied',
      }),
    );
    jest
      .mocked(getActiveDesktopRuntimeIfAccepting)
      .mockReturnValue({ instruction } as unknown as DesktopCanopyDispatcher);
    jest
      .mocked(queryPortalChatState)
      .mockResolvedValue(snapshotWith({ providerType: 'codex' }));
    jest
      .mocked(requestPortalComposerCommand)
      .mockReset()
      .mockResolvedValue({ requestId: 'renderer', ok: true });
    mockTerminalService.restartForSettingsChange
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it('sends plan, thinking and fast changes through core.chat.update under the Portal command id', async () => {
    const plan = makeContext();
    const planCommand = envelope('portal-plan', { ...target, planMode: true });
    await handlePortalChatSetPlanMode(planCommand, plan.context);
    expect(lastUpdate()).toMatchObject({
      commandId: 'portal-plan',
      origin: 'portal',
      action: {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: true },
      },
    });
    expect(plan.complete).toHaveBeenCalledWith(planCommand, { ok: true });

    const thinking = makeContext();
    const thinkingCommand = envelope('portal-thinking', {
      ...target,
      thinkingLevel: 'high' as const,
    });
    await handlePortalChatSetThinkingLevel(thinkingCommand, thinking.context);
    expect(lastUpdate()).toMatchObject({
      commandId: 'portal-thinking',
      origin: 'portal',
      action: { patch: { modelConfig: { thinkingLevel: 'high' } } },
    });
    expect(thinking.complete).toHaveBeenCalledWith(thinkingCommand, {
      ok: true,
    });

    const fast = makeContext();
    const fastCommand = envelope('portal-fast', { ...target, fastMode: true });
    await handlePortalChatSetFastMode(fastCommand, fast.context);
    expect(lastUpdate()).toMatchObject({
      commandId: 'portal-fast',
      origin: 'portal',
      action: { patch: { modelConfig: { fastMode: true } } },
    });
    expect(fast.complete).toHaveBeenCalledWith(fastCommand, { ok: true });
    expect(instruction).toHaveBeenCalledTimes(3);
    expect(requestPortalComposerCommand).not.toHaveBeenCalled();
  });

  it('keeps terminal-backed Claude chats on the renderer path while a window is open', async () => {
    jest
      .mocked(queryPortalChatState)
      .mockResolvedValue(
        snapshotWith({ interfaceMode: 'claude-code', providerType: 'claude' }),
      );
    const { context } = makeContext({
      isDestroyed: () => false,
    } as unknown as BrowserWindow);
    await handlePortalChatSetPlanMode(
      envelope('portal-plan', { ...target, planMode: true }),
      context,
    );
    expect(requestPortalComposerCommand).toHaveBeenCalledTimes(1);
    expect(instruction).not.toHaveBeenCalled();
  });

  it("sends a terminal-backed Claude chat's thinking change through the core without a window and restarts its terminal", async () => {
    jest
      .mocked(queryPortalChatState)
      .mockResolvedValue(
        snapshotWith({ interfaceMode: 'claude-code', providerType: 'claude' }),
      );
    const { context, complete } = makeContext(null);
    const command = envelope('portal-thinking', {
      ...target,
      thinkingLevel: 'high' as const,
    });
    await handlePortalChatSetThinkingLevel(command, context);

    expect(instruction).toHaveBeenCalledTimes(1);
    expect(lastUpdate()).toMatchObject({
      action: { patch: { modelConfig: { thinkingLevel: 'high' } } },
    });
    expect(mockTerminalService.restartForSettingsChange).toHaveBeenCalledTimes(
      1,
    );
    expect(mockTerminalService.restartForSettingsChange).toHaveBeenCalledWith(
      target,
    );
    expect(complete).toHaveBeenCalledWith(command, { ok: true });
    expect(requestPortalComposerCommand).not.toHaveBeenCalled();
  });

  it('a terminal restart failure after the commit still completes the command', async () => {
    jest
      .mocked(queryPortalChatState)
      .mockResolvedValue(
        snapshotWith({ interfaceMode: 'claude-code', providerType: 'claude' }),
      );
    mockTerminalService.restartForSettingsChange.mockRejectedValue(
      new Error('cleanup failed'),
    );
    const { context, complete, fail } = makeContext(null);
    const command = envelope('portal-thinking', {
      ...target,
      thinkingLevel: 'low' as const,
    });
    await handlePortalChatSetThinkingLevel(command, context);

    expect(instruction).toHaveBeenCalledTimes(1);
    expect(mockTerminalService.restartForSettingsChange).toHaveBeenCalledTimes(
      1,
    );
    expect(complete).toHaveBeenCalledWith(command, { ok: true });
    expect(fail).not.toHaveBeenCalled();
  });

  it('a plan change without a window does not restart the terminal again', async () => {
    jest
      .mocked(queryPortalChatState)
      .mockResolvedValue(
        snapshotWith({ interfaceMode: 'claude-code', providerType: 'claude' }),
      );
    const { context } = makeContext(null);
    await handlePortalChatSetPlanMode(
      envelope('portal-plan', { ...target, planMode: true }),
      context,
    );

    expect(instruction).toHaveBeenCalledTimes(1);
    expect(mockTerminalService.restartForSettingsChange).not.toHaveBeenCalled();
  });

  it.each(['claude-sonnet-4-6', 'antigravity:gemini-capture'])(
    'changes %s through the core only when no window can take it',
    async (model) => {
      const windowless = makeContext(null);
      await handlePortalChatSetModel(
        envelope('portal-model', { ...target, model }),
        windowless.context,
      );
      expect(lastUpdate()).toMatchObject({
        commandId: 'portal-model',
        action: {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model,
        },
      });
      expect(
        CoreChatUpdateParamsSchema.safeParse(instruction.mock.calls.at(-1)?.[1])
          .success,
      ).toBe(true);
      expect(windowless.fail).not.toHaveBeenCalled();
      expect(windowless.complete).toHaveBeenCalled();
      expect(requestPortalComposerCommand).not.toHaveBeenCalled();

      instruction.mockClear();
      const withWindow = makeContext({
        isDestroyed: () => false,
      } as unknown as BrowserWindow);
      await handlePortalChatSetModel(
        envelope('portal-model-2', { ...target, model }),
        withWindow.context,
      );
      expect(requestPortalComposerCommand).toHaveBeenCalledTimes(1);
      expect(instruction).not.toHaveBeenCalled();
    },
  );

  it('reports refused and conflicting changes as the renderer did', async () => {
    instruction.mockResolvedValueOnce({
      commandId: 'portal-rejected',
      revision: 2,
      outcome: 'rejected',
      reason: 'r',
    });
    const rejected = makeContext();
    const rejectedCommand = envelope('portal-rejected', {
      ...target,
      planMode: true,
    });
    await handlePortalChatSetPlanMode(rejectedCommand, rejected.context);
    expect(rejected.fail).toHaveBeenCalledWith(
      rejectedCommand,
      'invalid_target',
      'r',
    );

    instruction.mockResolvedValueOnce({
      commandId: 'portal-conflict',
      revision: 2,
      outcome: 'conflict',
    });
    const conflict = makeContext();
    const conflictCommand = envelope('portal-conflict', {
      ...target,
      planMode: true,
    });
    await handlePortalChatSetPlanMode(conflictCommand, conflict.context);
    expect(conflict.fail).toHaveBeenCalledWith(
      conflictCommand,
      'conflict',
      expect.any(String),
      true,
    );
  });

  it('keeps the renderer path where the renderer owns the outcome', async () => {
    for (const tab of [
      { kind: 'file' as const },
      { readOnly: true },
      { pendingPlanExitRequestId: 'exit-1', planMode: true },
      {
        trackedPlanId: 'plan-1',
        trackedPlanReviewStatus: 'pending' as const,
        planMode: true,
      },
    ]) {
      jest.mocked(queryPortalChatState).mockResolvedValue(snapshotWith(tab));
      const { context } = makeContext();
      await handlePortalChatSetPlanMode(
        envelope('portal-plan', { ...target, planMode: false }),
        context,
      );
    }
    jest
      .mocked(queryPortalChatState)
      .mockResolvedValue(snapshotWith({ providerType: 'claude' }));
    await handlePortalChatSetFastMode(
      envelope('portal-fast-claude', { ...target, fastMode: true }),
      makeContext().context,
    );
    expect(requestPortalComposerCommand).toHaveBeenCalledTimes(5);
    jest.mocked(queryPortalChatState).mockResolvedValue(snapshotWith({}));
    const { context } = makeContext(null);
    await handlePortalChatSetModel(
      envelope('portal-copilot', { ...target, model: 'copilot-gpt' }),
      context,
    );
    expect(instruction).not.toHaveBeenCalled();
  });

  it('keeps App Advisor chats on their existing path', async () => {
    const { context } = makeContext();
    await handlePortalChatSetPlanMode(
      envelope('portal-advisor', {
        ...target,
        projectId: APP_ADVISOR_PROJECT_ID,
        planMode: true,
      }),
      context,
    );
    expect(requestPortalComposerCommand).toHaveBeenCalledTimes(1);
    expect(instruction).not.toHaveBeenCalled();
  });
});

test('portal.standalone_chat.send accepts Google identity and retains asset authorization before dispatch', async () => {
  const { context, fail, complete } = makeContext();
  const command = {
    ...envelope('google-assets', {
      chatId: 'chat-1',
      userMessageId: 'message-1',
      message: 'Read the attachment',
      model: 'antigravity:gemini-capture',
      providerType: 'antigravity',
      cloudAttachments: [],
    }),
    type: 'portal.standalone_chat.send' as const,
  };
  if (!context.chatStatePort) throw new Error('Missing fixture chat port');
  const mutate = jest.spyOn(context.chatStatePort, 'command');
  await handlePortalStandaloneChatSend(command, context);
  expect(fail).toHaveBeenCalledWith(
    command,
    'invalid_target',
    'This paired session cannot send chat attachments.',
    false,
  );
  expect(complete).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
});
