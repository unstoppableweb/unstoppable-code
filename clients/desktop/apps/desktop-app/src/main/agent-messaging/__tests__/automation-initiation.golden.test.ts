// CAN-4174 migration golden: the presentation hint an automation's send
// carries, from the shared project/bot port through the real send and
// creation orchestrations, and what the desktop's chat.initiated reaction
// does with it on the real desktop runtime. Replaced at their boundaries:
// bot and project discovery, the chat tabs read, the cowork guards, the
// sender request, the chat command dispatch and the Orchestrator send, which
// publishes the chat.initiated of an accepted initiated send as chat state
// does (pinned by the chat state golden).
import type {
  ChatStateChangedEvent,
  ChatStateCommandPort,
  ChatSendMessageRequest,
  ChatCommandEnvelope,
} from '@canopy/desktop-shared/types';
import type * as SenderContext from '../sender-context';
import type * as CoworkGuard from '../../lib/cowork-folder-guard';
import type * as CommandAdapter from '../../canopy-runtime/core-chat-command-adapter';
import type * as WorkEntries from '../../lib/cowork-work-entries';
import type * as MessageAdapter from '../../canopy-runtime/core-chat-message-command-adapter';
import type * as Paths from '../../lib/paths';
import type * as ChatTabsReader from '../../lib/chat-tabs-reader';
import type * as ResourceContext from '../../lib/resource-context';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';

type Listener = (event: ChatStateChangedEvent) => void;
const mockListeners = new Set<Listener>();
const mockBotSends: ChatSendMessageRequest[] = [];
const mockCommands: ChatCommandEnvelope[] = [];
const mockTabs: { id: string; kind: 'chat' }[] = [];
const mockEntries: { id: string }[] = [];
// The direct window calls and the sends of one run, in order.
const mockOrder: string[] = [];
// The sidebar group each new Work Entry was assigned to.
const mockGroups = new Map<string, string>();
let mockRevision = 0;

function mockPublishInitiated(
  scope: { projectId: string; worktreeId: string },
  chatId: string,
  userMessageId: string,
  initiated: { origin: unknown; presentation: string } | undefined,
): void {
  if (!initiated) return;
  mockRevision += 1;
  const event = {
    schemaVersion: 1,
    eventId: `event-${mockRevision}`,
    occurredAt: new Date().toISOString(),
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    baseRevision: mockRevision - 1,
    revision: mockRevision,
    changes: [
      {
        type: 'chat.initiated',
        chatId,
        userMessageId,
        origin: initiated.origin,
        presentation: initiated.presentation,
        acceptedAt: new Date().toISOString(),
      },
    ],
  } as ChatStateChangedEvent;
  mockListeners.forEach((listener) => listener(event));
}

const mockPort: ChatStateCommandPort = {
  getState: jest.fn(),
  getTranscriptPage: jest.fn(),
  searchTranscript: jest.fn(),
  readToolOutput: jest.fn(),
  readVisual: jest.fn(),
  command: jest.fn(),
  getCommandReceipt: () => Promise.resolve(null),
  subscribe: (listener: Listener) => {
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  },
};

jest.mock('../../ipc/chat-state', () => ({
  getChatStateCommandPort: (): ChatStateCommandPort => mockPort,
}));
jest.mock('../../project-discovery/bots/registry', () => ({
  ensureBotRegistryLoaded: (): Promise<void> => Promise.resolve(),
  requireBotWorkspace: (
    botId: string,
  ): { botId: string; projectId: string } => ({
    botId,
    projectId: 'app-advisor',
  }),
}));
jest.mock('../../project-discovery/bots/target', () => ({
  requireBotAccess: (): Promise<void> => Promise.resolve(),
  readBotEntries: (): Promise<{ id: string }[]> =>
    Promise.resolve([...mockEntries]),
}));
jest.mock('../../project-discovery/runtime-state', () => ({
  readTaskRuntimeSnapshot: (): Promise<unknown> =>
    Promise.resolve({ tabsFile: { tabs: [...mockTabs] }, runtime: {} }),
}));
jest.mock('../../project-discovery/chat-target', () => ({
  resolveAuthorizedChat: (address: {
    projectId: string;
    taskId: string;
    chatId: string;
  }): Promise<unknown> =>
    Promise.resolve({
      address,
      projectType: 'cowork',
      scope: {
        workspaceId: address.projectId,
        worktreeId: address.taskId,
        chatId: address.chatId,
      },
      tab: { id: address.chatId, kind: 'chat' },
    }),
}));
jest.mock('../../lib/cowork-folder-guard', () => ({
  ...jest.requireActual<typeof CoworkGuard>('../../lib/cowork-folder-guard'),
  assertCoworkChatRootPresent: (): Promise<void> => Promise.resolve(),
  assertCoworkWorkspaceRootPresent: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../sender-context', () => ({
  ...jest.requireActual<typeof SenderContext>('../sender-context'),
  buildPipelineSenderRequest: (): Promise<object> => Promise.resolve({}),
  revalidateAgentSenderRequest: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../canopy-runtime/core-chat-command-adapter', () => ({
  ...jest.requireActual<typeof CommandAdapter>(
    '../../canopy-runtime/core-chat-command-adapter',
  ),
  createChatCommandDispatchOptions: (): object => ({}),
  dispatchTrustedChatCommand: (
    envelope: ChatCommandEnvelope,
    options: {
      executionOptions?: {
        onAgentSendAccepted?: (facts: object) => void;
      };
    },
  ): Promise<{ outcome: string; entityId?: string }> => {
    mockCommands.push(envelope);
    const { command } = envelope;
    if (command.type === 'chat.create_tab') {
      mockTabs.push({ id: command.tabId, kind: 'chat' });
      return Promise.resolve({ outcome: 'applied', entityId: command.tabId });
    }
    if (command.type === 'chat.send_message') {
      mockOrder.push(`send:${command.chatId}`);
      options.executionOptions?.onAgentSendAccepted?.({
        acceptedInputId: command.userMessageId,
        disposition: 'started',
        acceptedAt: new Date().toISOString(),
      });
      mockPublishInitiated(
        envelope,
        command.chatId,
        command.userMessageId,
        command.automationDispatch?.initiated,
      );
    }
    return Promise.resolve({ outcome: 'applied' });
  },
}));
jest.mock('../../canopy-runtime/core-chat-message-command-adapter', () => ({
  ...jest.requireActual<typeof MessageAdapter>(
    '../../canopy-runtime/core-chat-message-command-adapter',
  ),
  withLegacyChatMessageCommand: async (
    envelope: ChatCommandEnvelope,
    run: () => Promise<unknown>,
    _receipt: unknown,
    executionOptions: { onAgentSendAccepted: (facts: object) => void },
  ): Promise<void> => {
    await run();
    const { command } = envelope;
    if (command.type !== 'chat.send_message') return;
    executionOptions.onAgentSendAccepted({
      acceptedInputId: command.userMessageId,
      disposition: 'started',
      acceptedAt: new Date().toISOString(),
    });
  },
}));
// Only what the orchestrations read; the real module's import graph is the
// whole chat runtime.
jest.mock('../../services/chat-service', () => ({
  ExistingTabDispatchTargetNotFoundError: class extends Error {},
  assertTerminalChatAcceptsSettings: (): Promise<void> => Promise.resolve(),
  isReusableEmptyChatTab: (): boolean => false,
  buildExistingTabDispatchOptions: (): Promise<object> => Promise.resolve({}),
  getRegisteredAppAdvisorSurfaces: (): undefined => undefined,
  sendWorktreeChatMessage: (
    request: ChatSendMessageRequest,
  ): Promise<{ ok: true }> => {
    mockOrder.push(`send:${request.chatId}`);
    mockBotSends.push(request);
    mockPublishInitiated(
      request,
      request.chatId,
      request.userMessageId,
      request.automationDispatch?.initiated,
    );
    return Promise.resolve({ ok: true });
  },
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  ...jest.requireActual<typeof WorkEntries>('../../lib/cowork-work-entries'),
  createWorkEntry: (
    _projectId: string,
    entry: { id: string; createdAt: string },
  ): Promise<{ entry: object; reusedExistingEmpty: false }> => {
    mockEntries.push({ id: entry.id });
    return Promise.resolve({ entry, reusedExistingEmpty: false });
  },
  removeUnstartedWorkEntry: (): Promise<void> => Promise.resolve(),
  removeWorkEntryRow: (): Promise<void> => Promise.resolve(),
}));
let mockDirectory = '';
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof Paths>('../../lib/paths'),
  getAutomationsFilePath: (): string => join(mockDirectory, 'automations.json'),
}));
jest.mock('../../lib/chat-tabs-reader', () => ({
  ...jest.requireActual<typeof ChatTabsReader>('../../lib/chat-tabs-reader'),
  readChatTabsFile: (): Promise<unknown> =>
    Promise.resolve({ tabs: [...mockTabs] }),
}));
jest.mock('../../lib/resource-context', () => ({
  ...jest.requireActual<typeof ResourceContext>('../../lib/resource-context'),
  resourceContextEnabled: (): boolean => false,
}));
const mockWarn = jest.fn();
jest.mock('../../lib/main-process-logging', () => ({
  ...jest.requireActual<object>('../../lib/main-process-logging'),
  logMainProcessWarn: (...args: unknown[]): void => {
    mockWarn(...args);
  },
}));
// Only the call an automation run makes; the real service writes user data.
jest.mock('../../services/sidebar-item-groups-service', () => ({
  sidebarItemGroupsService: {
    assignItemToNamedGroup: (args: {
      itemId: string;
      name: string;
    }): Promise<void> => {
      mockOrder.push(`group:${args.itemId}`);
      mockGroups.set(args.itemId, args.name);
      return Promise.resolve();
    },
  },
}));
jest.setTimeout(30_000);

import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { startInitiatedPresentation } from '../../app-advisor/initiated-presentation';
import { registerInitiatedPresentation } from '../../app-advisor/initiated-presentation-registration';
import { assertUntrustedChatInput } from '../untrusted-input';
import { withAutomationInitiation } from '../automation-dispatch';
import { runPipelineProjectBotAction } from '../../agent-actions/desktop-project-bot-port';

const automationCaller = {
  kind: 'pipeline' as const,
  source: {
    kind: 'automation' as const,
    automationId: 'automation-1',
    automationName: 'Morning summary',
    owner: { kind: 'personal' as const },
  },
};

const workflowCaller = {
  kind: 'pipeline' as const,
  source: {
    kind: 'step' as const,
    executionId: 'execution-1',
    pipelineId: 'pipeline-1',
    pipelineName: 'Summary',
    stepId: 'send',
    owner: { kind: 'personal' as const },
    automation: {
      automationId: 'automation-1',
      automationName: 'Morning summary',
    },
  },
};

const dispatch = (
  presentation: 'foreground' | 'background',
): {
  version: 1;
  automationName: string;
  presentation: 'foreground' | 'background';
  executionContext: string;
} => ({
  version: 1 as const,
  automationName: 'Morning summary',
  presentation,
  executionContext: 'personal',
});

// Any thrown Error, typed for the logged fields it matches.
const anError: unknown = expect.any(Error);

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

async function withReaction(
  run: (ensure: jest.Mock) => Promise<void>,
): Promise<void> {
  const runtime = createDesktopRuntime({ getChatStatePort: () => mockPort });
  const ensure: jest.Mock = jest.fn(() =>
    Promise.resolve({ open: true, focused: true }),
  );
  const presentation = await startInitiatedPresentation({
    openChatEvents: (params) =>
      runtime.openStream('core.chat.events', params, {
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: 'electron-main-initiated-presentation',
          authorityId: 'local-desktop',
          interfaceKind: 'test',
          grants: ['core.chat.read'],
        },
      }),
    surfaces: { ensureAppAdvisorWindow: ensure },
  });
  try {
    await run(ensure);
  } finally {
    presentation.stop();
    await runtime.shutdown();
  }
}

beforeEach(() => {
  mockOrder.length = 0;
  mockGroups.clear();
  mockWarn.mockClear();
  mockBotSends.length = 0;
  mockCommands.length = 0;
  mockTabs.splice(0, mockTabs.length, { id: 'chat-1', kind: 'chat' });
  mockEntries.splice(0, mockEntries.length, { id: 'task-1' });
});

describe("an automation's send and the Orchestrator window (CAN-4174)", () => {
  it.each(['foreground', 'background'] as const)(
    'a %s send to an existing Orchestrator chat is open: the window opens with no chat selected',
    (presentation) =>
      withReaction(async (ensure) => {
        await runPipelineProjectBotAction(
          {
            type: 'bots.send_message',
            botId: 'app_advisor',
            taskId: 'task-1',
            chatId: 'chat-1',
            text: 'Summarize my day',
          },
          automationCaller,
          { automationDispatch: dispatch(presentation) },
        );
        expect(mockBotSends).toHaveLength(1);
        expect(mockBotSends[0]?.automationDispatch?.initiated).toEqual({
          origin: { kind: 'automation', sourceId: 'automation-1' },
          presentation: 'open',
        });
        await settle();
        expect(ensure.mock.calls).toEqual([[undefined]]);
      }),
  );

  it.each([
    ['a new Work Entry', 'bots.create_task'],
    ['an existing Work Entry', 'bots.create_task_chat'],
  ] as const)(
    "an automation's quick prompt into %s is focus: the window opens on its new chat",
    (_name, type) =>
      withReaction(async (ensure) => {
        mockTabs.length = 0;
        if (type === 'bots.create_task') mockEntries.length = 0;
        const created = await runPipelineProjectBotAction(
          type === 'bots.create_task'
            ? {
                type,
                botId: 'app_advisor',
                title: 'Morning summary',
                initialMessage: 'Summarize my day',
              }
            : {
                type,
                botId: 'app_advisor',
                taskId: 'task-1',
                initialMessage: 'Summarize my day',
              },
          automationCaller,
          {
            ...(type === 'bots.create_task'
              ? { plannedTaskId: 'task-new' }
              : {}),
            // app_advisor_prompt always seeds its new chat (CAN-4174 capture).
            newChatSeed: { planMode: false },
            automationDispatch: dispatch('foreground'),
          },
        );
        const chatId =
          'address' in created ? created.address.chatId : undefined;
        expect(chatId).toEqual(expect.any(String));
        expect(mockBotSends).toHaveLength(1);
        expect(mockBotSends[0]?.automationDispatch?.initiated).toEqual({
          origin: { kind: 'automation', sourceId: 'automation-1' },
          presentation: 'focus',
        });
        await settle();
        expect(ensure.mock.calls).toEqual([[{ chatId }]]);
      }),
  );

  it("emits open only for an automation's send to an existing Orchestrator chat", () =>
    withReaction(async () => {
      const hints: Record<string, string | undefined> = {};
      const last = (): string | undefined => {
        const bot = mockBotSends.at(-1)?.automationDispatch?.initiated;
        const sent = mockCommands
          .filter((envelope) => envelope.command.type === 'chat.send_message')
          .at(-1)?.command;
        const project =
          sent?.type === 'chat.send_message'
            ? sent.automationDispatch?.initiated
            : undefined;
        mockBotSends.length = 0;
        mockCommands.length = 0;
        return (bot ?? project)?.presentation;
      };
      const send = {
        type: 'bots.send_message' as const,
        botId: 'app_advisor',
        taskId: 'task-1',
        chatId: 'chat-1',
        text: 'Summarize my day',
      };
      await runPipelineProjectBotAction(send, automationCaller, {
        automationDispatch: dispatch('background'),
      });
      hints['automation, existing Orchestrator chat'] = last();
      await runPipelineProjectBotAction(
        {
          type: 'bots.create_task_chat',
          botId: 'app_advisor',
          taskId: 'task-1',
          initialMessage: 'Summarize my day',
        },
        automationCaller,
        {
          newChatSeed: { planMode: false },
          automationDispatch: dispatch('foreground'),
        },
      );
      hints['app_advisor_prompt'] = last();
      for (const presentation of ['foreground', 'background'] as const) {
        await runPipelineProjectBotAction(send, workflowCaller, {
          automationDispatch: dispatch(presentation),
        });
        hints[`workflow step, ${presentation}`] = last();
        await runPipelineProjectBotAction(
          {
            type: 'projects.send_message',
            projectId: 'cowork-project',
            taskId: 'entry-1',
            chatId: 'chat-1',
            text: 'Summarize my day',
          },
          automationCaller,
          { automationDispatch: dispatch(presentation) },
        );
        hints[`project chat, ${presentation}`] = last();
      }
      expect(hints).toEqual({
        'automation, existing Orchestrator chat': 'open',
        app_advisor_prompt: 'focus',
        'workflow step, foreground': 'none',
        'workflow step, background': 'none',
        'project chat, foreground': 'focus',
        'project chat, background': 'none',
      });
    }));

  // The inference pin: only a seed recognised as a creation's selects a chat.
  it.each([
    ['no seed', undefined],
    ['a null seed', null],
    ['an empty seed', {}],
    ['a seed with no field set', { planMode: undefined, model: undefined }],
    [
      'a seed with a field no creation sets',
      { planMode: false, chatId: 'chat-2' },
    ],
    ['a seed that is not an object', 'seed'],
    ['a seed that is a list', [{ planMode: false }]],
  ])(
    "an automation's Orchestrator send with %s is open: the window opens and no chat is selected",
    (_name, seed) =>
      withReaction(async (ensure) => {
        await runPipelineProjectBotAction(
          {
            type: 'bots.send_message',
            botId: 'app_advisor',
            taskId: 'task-1',
            chatId: 'chat-1',
            text: 'Summarize my day',
          },
          automationCaller,
          {
            automationDispatch: dispatch('foreground'),
            fixedIds: { userMessageId: 'input-1', commandId: 'command-1' },
            composition: { inputMode: 'typed' },
            ...(seed === undefined
              ? {}
              : // A malformed seed is exactly what this pins against.
                { newChatSeed: seed as never }),
          },
        );
        expect(
          mockBotSends[0]?.automationDispatch?.initiated?.presentation,
        ).toBe('open');
        await settle();
        expect(ensure.mock.calls).toEqual([[undefined]]);
      }),
  );

  it("a workflow step's send to an Orchestrator chat is none: nothing opens", () =>
    withReaction(async (ensure) => {
      await runPipelineProjectBotAction(
        {
          type: 'bots.send_message',
          botId: 'app_advisor',
          taskId: 'task-1',
          chatId: 'chat-1',
          text: 'Summarize my day',
        },
        workflowCaller,
        { automationDispatch: dispatch('foreground') },
      );
      expect(mockBotSends[0]?.automationDispatch?.initiated).toEqual({
        origin: {
          kind: 'automation',
          sourceId: 'automation-1',
          occurrenceKey: 'execution-1',
        },
        presentation: 'none',
      });
      await settle();
      expect(ensure).not.toHaveBeenCalled();
    }));

  it("a presentation a caller puts on the dispatch block is never used: main derives it from the send's own path", () =>
    withReaction(async (ensure) => {
      await runPipelineProjectBotAction(
        {
          type: 'bots.send_message',
          botId: 'app_advisor',
          taskId: 'task-1',
          chatId: 'chat-1',
          text: 'Summarize my day',
        },
        workflowCaller,
        {
          automationDispatch: {
            ...dispatch('foreground'),
            initiated: {
              origin: { kind: 'automation', sourceId: 'someone-else' },
              presentation: 'focus',
            },
          },
        },
      );
      expect(mockBotSends[0]?.automationDispatch?.initiated).toEqual({
        origin: {
          kind: 'automation',
          sourceId: 'automation-1',
          occurrenceKey: 'execution-1',
        },
        presentation: 'none',
      });
      await settle();
      expect(ensure).not.toHaveBeenCalled();
    }));

  it('a dispatch block from a source with no automation keeps no presentation at all', () => {
    const block = withAutomationInitiation(
      {
        ...dispatch('foreground'),
        initiated: {
          origin: { kind: 'automation', sourceId: 'someone-else' },
          presentation: 'focus',
        },
      },
      {
        kind: 'step',
        executionId: 'execution-1',
        pipelineId: 'pipeline-1',
        pipelineName: 'Summary',
        stepId: 'send',
        owner: { kind: 'personal' },
      },
      'bot',
      true,
    );
    expect(block).not.toHaveProperty('initiated');
  });

  it('untrusted chat input naming an automation dispatch is refused before any send', () => {
    expect(() =>
      assertUntrustedChatInput({
        projectId: 'app-advisor',
        worktreeId: 'task-1',
        chatId: 'chat-1',
        text: 'Summarize my day',
        automationDispatch: {
          ...dispatch('foreground'),
          initiated: {
            origin: { kind: 'automation', sourceId: 'automation-1' },
            presentation: 'focus',
          },
        },
      }),
    ).toThrow(
      'Untrusted chat input cannot contain the "automationDispatch" field.',
    );
  });

  it.each([
    ['foreground', 'focus'],
    ['background', 'none'],
  ] as const)(
    'a %s send to a project chat is %s, and the Orchestrator window stays shut',
    (presentation, hint) =>
      withReaction(async (ensure) => {
        await runPipelineProjectBotAction(
          {
            type: 'projects.send_message',
            projectId: 'cowork-project',
            taskId: 'entry-1',
            chatId: 'chat-1',
            text: 'Summarize my day',
          },
          automationCaller,
          { automationDispatch: dispatch(presentation) },
        );
        const sent = mockCommands.find(
          (envelope) => envelope.command.type === 'chat.send_message',
        );
        expect(
          sent?.command.type === 'chat.send_message'
            ? sent.command.automationDispatch?.initiated?.presentation
            : undefined,
        ).toBe(hint);
        await settle();
        expect(ensure).not.toHaveBeenCalled();
      }),
  );
});

const NOW = '2026-11-17T12:00:00.000Z';
const ID = 'automation-1';

async function runAutomation(
  action: AutomationAction,
  direct: string[],
  window: { opening?: 'fails' } = {},
): Promise<ScheduledActivityRun> {
  const activity: ScheduledActivity = {
    version: 1,
    id: ID,
    name: 'Morning summary',
    enabled: false,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action,
    createdAt: NOW,
    updatedAt: NOW,
    failureCount: 0,
  };
  await writeFile(
    join(mockDirectory, 'automations.json'),
    JSON.stringify({
      version: 1,
      updatedAt: NOW,
      activities: [activity],
      recentRuns: [],
    }),
  );
  const { AutomationsService } = await import('../../automations/service');
  const service = new AutomationsService();
  service.configure({
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: () => Promise.resolve({ open: true, focused: true }),
    // The service's own window calls: only the native-path one is left.
    ensureAppAdvisorWindow: (request) => {
      direct.push(`window:${request?.chatId ?? 'any'}`);
      mockOrder.push(`direct:${request?.chatId ?? 'any'}`);
      if (window.opening === 'fails')
        return Promise.reject(new Error('no display'));
      return Promise.resolve({ open: true, focused: true });
    },
    sendAppAdvisorWindowCommand: () => undefined,
  });
  const started = await service.runNow({ id: ID });
  if (!started.ok) throw new Error(`Run now refused: ${started.error}`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const history = await service.listRuns({ activityId: ID });
    const run = 'runs' in history ? history.runs[0] : undefined;
    if (run && run.status !== 'running') return run;
    if (Date.now() > deadline) throw new Error('The run did not finish');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("an automation's own run, from the automations service (CAN-4174)", () => {
  beforeEach(async () => {
    mockDirectory = await mkdtemp(join(tmpdir(), 'automation-initiation-'));
  });
  afterEach(async () => {
    await rm(mockDirectory, { recursive: true, force: true });
  });

  it('app_advisor_prompt: the window opens on the new chat, from the reaction alone', () =>
    withReaction(async (ensure) => {
      mockTabs.length = 0;
      mockEntries.length = 0;
      const direct: string[] = [];
      const run = await runAutomation(
        { type: 'app_advisor_prompt', prompt: 'Summarize my day' },
        direct,
      );
      expect(run.status).toBe('success');
      const chatId = run.target?.chatId;
      expect(chatId).toEqual(expect.any(String));
      expect(mockBotSends[0]?.automationDispatch?.initiated?.presentation).toBe(
        'focus',
      );
      await settle();
      expect(direct).toEqual([]);
      expect(ensure.mock.calls).toEqual([[{ chatId }]]);
    }));

  it('worktree_session_prompt to an Orchestrator chat: the window opens with no chat selected, from the reaction alone', () =>
    withReaction(async (ensure) => {
      const direct: string[] = [];
      const run = await runAutomation(
        {
          type: 'worktree_session_prompt',
          workspaceId: 'app-advisor',
          worktreeId: 'task-1',
          chatId: 'chat-1',
          prompt: 'Summarize my day',
        },
        direct,
      );
      expect(run).toMatchObject({ status: 'success' });
      expect(mockBotSends[0]?.automationDispatch?.initiated?.presentation).toBe(
        'open',
      );
      await settle();
      expect(direct).toEqual([]);
      expect(ensure.mock.calls).toEqual([[undefined]]);
    }));
});

// The automations service's runs with the reaction registered as Electron
// main registers it. The capture of develop's direct calls (CAN-4174 PR 4's
// first commit) is the before; these are the after. Three named deviations:
// the window comes after the accepted send instead of before it; a window
// that fails no longer fails the run; and the chat is selected right after the
// commit, which can be before its Work Entry joins a sidebar group, with the
// same end state. The native path keeps its direct call.
describe("an automation's own run, with the reaction registered (CAN-4174)", () => {
  const session = (
    extra: Partial<
      Extract<AutomationAction, { type: 'worktree_session_prompt' }>
    > = {},
  ): AutomationAction => ({
    type: 'worktree_session_prompt',
    workspaceId: 'app-advisor',
    worktreeId: 'task-1',
    chatId: 'chat-1',
    prompt: 'Summarize my day',
    ...extra,
  });

  const reaction: { fails: boolean } = { fails: false };
  let runtime: ReturnType<typeof createDesktopRuntime>;
  let registration: ReturnType<typeof registerInitiatedPresentation>;
  beforeEach(async () => {
    reaction.fails = false;
    mockDirectory = await mkdtemp(join(tmpdir(), 'automation-initiation-'));
    runtime = createDesktopRuntime({ getChatStatePort: () => mockPort });
    registration = registerInitiatedPresentation({
      dispatcher: runtime,
      surfaces: {
        ensureAppAdvisorWindow: (request) => {
          mockOrder.push(`window:${request?.chatId ?? 'any'}`);
          return reaction.fails
            ? Promise.reject(new Error('no display'))
            : Promise.resolve({ open: true, focused: true });
        },
      },
    });
    await registration.ready;
  });
  afterEach(async () => {
    registration.stop();
    await runtime.shutdown();
    await rm(mockDirectory, { recursive: true, force: true });
  });

  it('app_advisor_prompt: the window opens on the chat after the send is accepted, and never before it (deviation 1)', async () => {
    mockTabs.length = 0;
    mockEntries.length = 0;
    const run = await runAutomation(
      { type: 'app_advisor_prompt', prompt: 'Summarize my day' },
      [],
    );
    await settle();
    expect(run.status).toBe('success');
    const chatId = run.target?.chatId;
    expect(mockOrder).toEqual([`send:${chatId}`, `window:${chatId}`]);
  });

  it('app_advisor_prompt into a sidebar group: the same end state as develop, the chat selected and its Work Entry in the group (deviation 3)', async () => {
    mockTabs.length = 0;
    mockEntries.length = 0;
    const run = await runAutomation(
      {
        type: 'app_advisor_prompt',
        prompt: 'Summarize my day',
        sidebarGroupName: 'Mornings',
      },
      [],
    );
    await settle();
    expect(run.status).toBe('success');
    const chatId = run.target?.chatId;
    const taskId = mockEntries[0]?.id;
    expect(mockGroups.get(taskId ?? '')).toBe('Mornings');
    expect([...mockOrder].sort()).toEqual(
      [`group:${taskId}`, `send:${chatId}`, `window:${chatId}`].sort(),
    );
    expect(mockOrder.indexOf(`window:${chatId}`)).toBeGreaterThan(
      mockOrder.indexOf(`send:${chatId}`),
    );
  });

  it('app_advisor_prompt: a window that fails is logged with the chat, and the accepted message and the run stay as they were (deviation 2)', async () => {
    mockTabs.length = 0;
    mockEntries.length = 0;
    // Every window opener fails: on develop the run failed before sending.
    reaction.fails = true;
    const run = await runAutomation(
      { type: 'app_advisor_prompt', prompt: 'Summarize my day' },
      [],
      { opening: 'fails' },
    );
    await settle();
    const chatId = run.target?.chatId;
    // The Orchestrator send that was accepted, once.
    expect(mockBotSends).toHaveLength(1);
    const userMessageId = mockBotSends[0]?.userMessageId;
    expect(userMessageId).toEqual(expect.any(String));
    expect(run).toMatchObject({
      status: 'success',
      result: { appAdvisorChatId: chatId, userMessageId },
      target: { chatId },
    });
    expect(run.error).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      'Opening the Orchestrator window for an automation failed',
      { presentation: 'focus', chatId, error: anError },
    );
  });

  it('worktree_session_prompt to an Orchestrator chat through the port: the window opens with no chat selected, after the send (deviation 1)', async () => {
    const run = await runAutomation(session(), []);
    await settle();
    expect(run.status).toBe('success');
    expect(mockOrder).toEqual(['send:chat-1', 'window:any']);
  });

  it('worktree_session_prompt to an Orchestrator chat through the port: a window that fails is logged, and the send and run stand (deviation 2)', async () => {
    reaction.fails = true;
    const run = await runAutomation(session(), [], { opening: 'fails' });
    await settle();
    expect(run.status).toBe('success');
    expect(mockBotSends).toHaveLength(1);
    expect(mockWarn).toHaveBeenCalledWith(
      'Opening the Orchestrator window for an automation failed',
      { presentation: 'open', chatId: 'chat-1', error: anError },
    );
  });

  it('worktree_session_prompt to an Orchestrator chat on the native path: unchanged, the direct call before the send, and nothing from the reaction', async () => {
    const run = await runAutomation(session({ purpose: 'scheduled_send' }), []);
    await settle();
    expect(run.status).toBe('success');
    expect(mockOrder).toEqual(['direct:any', 'send:chat-1']);
    expect(mockBotSends[0]?.automationDispatch?.initiated).toBeUndefined();
  });

  it('worktree_session_prompt on the native path: a direct window that fails still fails the run before any send, as on develop', async () => {
    const run = await runAutomation(
      session({ purpose: 'scheduled_send' }),
      [],
      {
        opening: 'fails',
      },
    );
    expect(run.status).toBe('failure');
    expect(mockOrder).toEqual(['direct:any']);
    expect(mockBotSends).toEqual([]);
  });
});
