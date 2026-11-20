import {
  registerApprovalSecretConsumer,
  resolveApprovalSecretInput,
  resolveApproval,
  resolveApprovalFromMain,
  pendingApprovalRequests,
} from '../../approvals/pending-approvals';
import {
  getDesktopApprovalBroker,
  resetDesktopApprovalBrokerForTests,
} from '../../approvals/approval-broker';
import { windowApprovalPort } from '../../approvals/prompt-bridge';
import { resetDesktopChatWaitsForTest } from '../../chat-waits/desktop-chat-waits';
import { personalGatewayAccountFields } from '@canopy/desktop-shared/lib/org-enforced-parsing';
import {
  resolveModelGatewayIndex,
  gatewayRequirementForOwner,
} from '@canopy/desktop-shared/lib/org-model-gateway';
import { createDesktopTranscriptReadPort } from '../desktop-transcript-read-port';
// Runs the shared agent action conformance suite against the desktop host:
// the real desktop surface, environment port, and dispatcher, over in-memory
// chat state, workspace reads, renderer bridge, and watcher service.

interface MockWatcher {
  id: string;
  trigger: string;
  status: 'active';
  label: string;
  target: Record<string, unknown> & { kind: string; chatId?: string };
  destination: { projectId: string; worktreeId: string; chatId: string };
  createdByToolUseId?: string;
}

const mockWatcherState: {
  watchers: MockWatcher[];
  /** Fired watchers stay findable by the key that armed them. */
  fired: MockWatcher[];
  isIdle: (target: MockWatcher['target']) => boolean;
  /** Whether a chat's turn finished; null names the chat's first turn. */
  turnFinished: (
    target: MockWatcher['target'],
    turnUserMessageId: string | null,
  ) => boolean;
  next: number;
  /** Rejects the next watcher setup, as a service failure would. */
  failNextSetup: boolean;
} = {
  failNextSetup: false,
  watchers: [],
  fired: [],
  isIdle: () => false,
  turnFinished: () => false,
  next: 0,
};

let mockChatPort: unknown = null;

jest.mock('../../lib/workspace-registry', () => ({
  ...jest.requireActual<object>('../../lib/workspace-registry'),
  isCoworkWorkspace: (): boolean => false,
}));

jest.mock('../../project-discovery/bots', () => ({
  isBotAccessAllowed: (): Promise<boolean> => Promise.resolve(false),
}));

jest.mock('../../ipc/chat-state', () => {
  const actual = jest.requireActual<object>('../../ipc/chat-state');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      getChatStateCommandPort: {
        value: (): unknown => mockChatPort,
        enumerable: true,
      },
    },
  );
});

jest.mock('../../app-advisor/watchers', () => {
  const sameDestination = (
    watcher: MockWatcher,
    destination: MockWatcher['destination'],
  ): boolean => watcher.destination.chatId === destination.chatId;
  const summary = (watcher: MockWatcher): Record<string, unknown> => ({
    ...watcher,
  });
  return {
    getAppAdvisorWatcherService: (): object => ({
      fireIfTurnSettled: (
        watcherId: string,
        destination: MockWatcher['destination'],
        turnUserMessageId: string | null,
      ): Promise<boolean> => {
        const watcher = mockWatcherState.watchers.find(
          (candidate) =>
            candidate.id === watcherId &&
            sameDestination(candidate, destination),
        );
        if (
          !watcher ||
          !mockWatcherState.turnFinished(watcher.target, turnUserMessageId)
        ) {
          return Promise.resolve(false);
        }
        mockWatcherState.watchers = mockWatcherState.watchers.filter(
          (candidate) => candidate !== watcher,
        );
        mockWatcherState.fired.push(watcher);
        return Promise.resolve(true);
      },
      search: (
        input: { includeActive?: boolean },
        destination: MockWatcher['destination'],
      ): Promise<object> =>
        Promise.resolve({
          catalog: [],
          activeWatchers:
            input.includeActive === false
              ? []
              : mockWatcherState.watchers
                  .filter((watcher) => sameDestination(watcher, destination))
                  .map(summary),
        }),
      // Chat watchers as SearchWatchers lists them: the canonical projection.
      projectCanonicalChatWatchers: (recipient: {
        destination: MockWatcher['destination'];
      }): Promise<object[]> =>
        Promise.resolve(
          mockWatcherState.watchers
            .filter((watcher) =>
              sameDestination(watcher, recipient.destination),
            )
            .map((watcher) => ({
              id: watcher.id,
              trigger: 'project_task_chat_completion',
              status: watcher.status,
              target: {
                projectId: watcher.target.projectId,
                taskId: watcher.target.worktreeId,
                chatId: watcher.target.chatId,
              },
            })),
        ),
      list: (destination: MockWatcher['destination']): Promise<object[]> =>
        Promise.resolve(
          mockWatcherState.watchers
            .filter((watcher) => sameDestination(watcher, destination))
            .map(summary),
        ),
      findWatcherCreatedBy: (
        toolUseId: string,
        destination: MockWatcher['destination'],
      ): Promise<object | null> => {
        const found = [
          ...mockWatcherState.watchers,
          ...mockWatcherState.fired,
        ].find(
          (watcher) =>
            watcher.createdByToolUseId === toolUseId &&
            sameDestination(watcher, destination),
        );
        return Promise.resolve(found ? summary(found) : null);
      },
      setup: (
        input: {
          watchers: {
            trigger: string;
            label?: string;
            target: MockWatcher['target'];
            armForNextCompletion?: boolean;
            allowDuplicate?: boolean;
          }[];
        },
        destination: MockWatcher['destination'],
        context?: { toolUseId?: string },
      ): Promise<object> => {
        if (mockWatcherState.failNextSetup) {
          mockWatcherState.failNextSetup = false;
          return Promise.resolve({
            ok: false,
            error: 'The watcher could not be saved.',
            rejectedIndex: 0,
          });
        }
        for (let index = 0; index < input.watchers.length; index += 1) {
          const entry = input.watchers[index];
          if (!entry) continue;
          if (entry.target.chatId === destination.chatId) {
            return Promise.resolve({
              ok: false,
              error: 'A chat watcher cannot watch itself.',
              rejectedIndex: index,
            });
          }
          if (
            entry.armForNextCompletion !== true &&
            mockWatcherState.isIdle(entry.target)
          ) {
            return Promise.resolve({
              ok: false,
              error: 'The target chat is idle.',
              rejectedIndex: index,
            });
          }
        }
        // Mirrors the service's dedupe key: trigger, target, and destination.
        const dedupeKey = (
          trigger: string,
          target: MockWatcher['target'],
        ): string => JSON.stringify({ trigger, target, destination });
        const results = input.watchers.map((entry): object => {
          const existing =
            entry.allowDuplicate === true
              ? undefined
              : mockWatcherState.watchers.find(
                  (watcher) =>
                    dedupeKey(watcher.trigger, watcher.target) ===
                    dedupeKey(entry.trigger, entry.target),
                );
          if (existing) {
            return { status: 'deduped', watcher: summary(existing) };
          }
          mockWatcherState.next += 1;
          const watcher: MockWatcher = {
            id: `watcher-${mockWatcherState.next}`,
            trigger: entry.trigger,
            status: 'active',
            label: entry.label ?? '',
            target: entry.target,
            destination,
            ...(context?.toolUseId
              ? { createdByToolUseId: context.toolUseId }
              : {}),
          };
          mockWatcherState.watchers.push(watcher);
          return { status: 'created', watcher: summary(watcher) };
        });
        return Promise.resolve({ ok: true, results });
      },
      deleteAgentWatchers: (
        input: { watcherIds: string[] },
        destination: MockWatcher['destination'],
      ): Promise<object> =>
        Promise.resolve({
          ok: true,
          results: input.watcherIds.map((watcherId) => {
            const index = mockWatcherState.watchers.findIndex(
              (watcher) =>
                watcher.id === watcherId &&
                sameDestination(watcher, destination),
            );
            if (index < 0) return { watcherId, status: 'not_found' };
            mockWatcherState.watchers.splice(index, 1);
            return { watcherId, status: 'deleted' };
          }),
        }),
    }),
  };
});

import {
  AgentPortError,
  transcriptReadActionSchema,
  createInMemoryAgentActionLimits,
  createInMemoryAgentActionReceipts,
  type AgentActionCall,
  type AgentTranscriptReadOwner,
  type AgentExperimentWriteResult,
  type AgentInventorySyncState,
  type AgentModelList,
} from '@canopy/agent-actions';
import {
  createConformanceTranscriptStore,
  createLimitCommitFailures,
  createWriteHolds,
  loadConformanceWorld,
  runAgentActionConformance,
  type AgentConformanceWorldControl,
  type AgentConformanceWriteHold,
  type ConformanceWorld,
} from '@canopy/agent-actions/conformance';
import type {
  ChatCommandRequest,
  ChatCommandResult,
  ChatStateCommandPort,
  ChatStateSnapshot,
  PersistedChatMessage,
  PersistedChatTab,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import {
  createDesktopEnvironmentPort,
  desktopEnvironmentPortDeps,
} from '../desktop-environment-port';
import { DESKTOP_AGENT_ACTION_LIMITS } from '../desktop-limits-port';
import { chatSendAdmissionCheck } from '../../services/chat-send-admission';
import { createDesktopSplitPort } from '../desktop-split-port';
import { createDesktopSettingsPort } from '../desktop-settings-port';
import { createDesktopRemoteControlDialogPort } from '../desktop-remote-control-dialog-port';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { createDesktopAgentActionSurface } from '../desktop-surface';
import { desktopAgentActionCapabilities } from '../desktop-surface';
import { desktopChatWatcherPort } from '../desktop-watcher-port';
import { seedEmptyApprovalRuleSources } from '../../__tests__/helpers/approval-rule-sources';

const inventorySyncState: AgentInventorySyncState = {
  enabled: true,
  allowIncoming: true,
  signedIn: true,
  syncing: true,
  pausedReason: null,
  deleteStatus: 'idle',
};

const CREATED_AT = '2026-01-01T00:00:00.000Z';

interface ScopeState {
  revision: number;
  tabs: PersistedChatTab[];
  archives: ChatStateSnapshot['archives'];
  running: Set<string>;
  // Each chat's running turn and the turns queued behind it, by user message.
  turns: Map<string, string[]>;
}

function textMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
): PersistedChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: 0 };
}

function makeDesktopHost(world: ConformanceWorld): {
  surface: ReturnType<typeof createDesktopAgentActionSurface>;
  runtime: CanopyInjectedToolRuntime;
  control: AgentConformanceWorldControl;
  /** Chats the host started that the world did not seed. */
  startedChatIds: () => string[];
} {
  const workspaceId = world.workspace.workspaceId;
  const scopes = new Map<string, ScopeState>();
  const scope = (projectId: string, worktreeId: string): ScopeState => {
    const key = `${projectId}/${worktreeId}`;
    let state = scopes.get(key);
    if (!state) {
      state = {
        revision: 0,
        tabs: [],
        archives: [],
        running: new Set(),
        turns: new Map(),
      };
      scopes.set(key, state);
    }
    return state;
  };
  for (const chat of world.chats) {
    const state = scope(workspaceId, chat.worktreeId);
    if (chat.state === 'archived') {
      state.archives.push({
        chatId: chat.chatId,
        title: chat.title,
        archivedAt: CREATED_AT,
        createdAt: CREATED_AT,
        turnCount: 1,
        unread: false,
        restorable: true,
      });
      continue;
    }
    state.tabs.push({
      id: chat.chatId,
      title: chat.title,
      createdAt: CREATED_AT,
      model: chat.modelId,
      messages: chat.lastResponse
        ? [
            textMessage(`${chat.chatId}-ask`, 'user', 'Review it.'),
            textMessage(`${chat.chatId}-reply`, 'assistant', chat.lastResponse),
          ]
        : [],
    });
    if (chat.state === 'running') {
      state.running.add(chat.chatId);
      state.turns.set(chat.chatId, [`${chat.chatId}-seeded-turn`]);
    }
  }
  scope(world.foreign.workspaceId, world.foreign.worktreeId).tabs.push({
    id: world.foreign.chatId,
    title: 'Foreign chat',
    createdAt: CREATED_AT,
    messages: [],
  });

  const worktrees = new Map<string, WorktreeData[]>([
    [
      workspaceId,
      world.worktrees.map((worktree) => ({
        id: worktree.worktreeId,
        branchName: worktree.branch,
        label: worktree.name,
        createdAt: CREATED_AT,
        trackedBaseBranch: null,
      })),
    ],
    [
      world.foreign.workspaceId,
      [
        {
          id: world.foreign.worktreeId,
          branchName: 'foreign',
          createdAt: CREATED_AT,
          trackedBaseBranch: null,
        },
      ],
    ],
  ]);

  const submitTurn = (
    state: ScopeState,
    chatId: string,
    userMessageId: string,
  ): void => {
    state.running.add(chatId);
    state.turns.set(chatId, [
      ...(state.turns.get(chatId) ?? []),
      userMessageId,
    ]);
  };

  const findTab = (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): PersistedChatTab | undefined =>
    scope(projectId, worktreeId).tabs.find((tab) => tab.id === chatId);

  const result = (
    request: ChatCommandRequest,
    state: ScopeState,
    outcome: ChatCommandResult['outcome'],
  ): ChatCommandResult => ({
    commandId: request.commandId,
    revision: state.revision,
    outcome,
  });

  const transcripts = createConformanceTranscriptStore(world);
  const transcriptOwner = (request: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }): AgentTranscriptReadOwner => ({
    scope: {
      workspaceId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: request.chatId,
    },
  });
  const port: ChatStateCommandPort = {
    getState: (request) => {
      const state = scope(request.projectId, request.worktreeId);
      const runtimeByChatId: ChatStateSnapshot['runtimeByChatId'] = {};
      state.running.forEach((chatId) => {
        runtimeByChatId[chatId] = { status: 'streaming', queuedMessageIds: [] };
      });
      return Promise.resolve({
        schemaVersion: 1,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        revision: state.revision,
        tabsFile: {
          version: 1,
          activeTabId: state.tabs[0]?.id ?? '',
          tabs: state.tabs,
        },
        archives: state.archives,
        runtimeByChatId,
        queue: [],
      });
    },
    getTranscriptPage: (request): Promise<TranscriptPage> => {
      if (request.target?.kind === 'delegation') {
        try {
          const input = transcriptReadActionSchema.parse({
            type: 'chat.transcript.page',
            target: request.target,
            cursor: request.cursor,
          });
          if (input.type !== 'chat.transcript.page')
            throw new Error('Unexpected action.');
          return Promise.resolve(
            transcripts.page(input, transcriptOwner(request)),
          );
        } catch (error) {
          if (
            error instanceof AgentPortError &&
            error.code === 'invalid_target'
          )
            throw new Error('Invalid transcript page cursor');
          throw error;
        }
      }
      const tab = findTab(
        request.projectId,
        request.worktreeId,
        request.chatId,
      );
      const messages = tab?.messages ?? [];
      return Promise.resolve({
        messages,
        totalMessages: messages.length,
        transcriptRevision: 0,
      });
    },
    readTranscriptContent: (request) => {
      const input = transcriptReadActionSchema.parse({
        type: 'chat.content.read',
        target: request.target,
        messageId: request.messageId,
        blockOrdinal: request.blockOrdinal,
        field: request.field,
        fieldSource: request.fieldSource,
        offset: request.offset,
        limit: request.limit,
      });
      if (input.type !== 'chat.content.read')
        throw new Error('Unexpected action.');
      return Promise.resolve(
        transcripts.content(input, transcriptOwner(request)),
      );
    },
    getTranscriptBlocks: (request) => {
      const input = transcriptReadActionSchema.parse({
        type: 'chat.transcript.blocks.page',
        target: request.target,
        messageId: request.messageId,
        firstBlockOrdinal: request.firstBlockOrdinal,
        cursor: request.cursor,
        limit: request.limit,
      });
      if (input.type !== 'chat.transcript.blocks.page')
        throw new Error('Unexpected action.');
      try {
        return Promise.resolve(
          transcripts.rawBlocks(
            { ...input, projection: 'bounded-v1' },
            transcriptOwner(request),
          ),
        );
      } catch (error) {
        if (error instanceof AgentPortError && error.code === 'invalid_target')
          throw new Error('Stale transcript blocks cursor');
        throw error;
      }
    },
    searchTranscript: () => Promise.reject(new Error('unused')),
    readToolOutput: () => Promise.reject(new Error('unused')),
    readVisual: () => Promise.reject(new Error('unused')),
    subscribe: () => () => undefined,
    command: (request) => {
      const state = scope(request.projectId, request.worktreeId);
      const command = request.command;
      state.revision += 1;
      switch (command.type) {
        case 'chat.create_tab':
          state.tabs.push({
            id: command.tabId,
            title: command.title ?? 'New Chat',
            createdAt: CREATED_AT,
            messages: [],
            ...(command.model ? { model: command.model } : {}),
          });
          return Promise.resolve({
            ...result(request, state, 'applied'),
            entityId: command.tabId,
          });
        case 'chat.patch_tab_settings': {
          const tab = state.tabs.find((entry) => entry.id === command.tabId);
          if (!tab) return Promise.resolve(result(request, state, 'not_found'));
          if (command.patch.title) tab.title = command.patch.title;
          return Promise.resolve(result(request, state, 'applied'));
        }
        case 'chat.send_message': {
          const tab = state.tabs.find((entry) => entry.id === command.chatId);
          if (!tab) return Promise.resolve(result(request, state, 'not_found'));
          const refusal = chatSendAdmissionCheck({
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            chatId: command.chatId,
            userMessageId: command.userMessageId,
          })?.(tab);
          if (refusal !== undefined) {
            return Promise.resolve({
              ...result(request, state, 'rejected'),
              reason: refusal,
            });
          }
          tab.messages.push(
            textMessage(command.userMessageId, 'user', command.text),
          );
          submitTurn(state, command.chatId, command.userMessageId);
          return Promise.resolve(result(request, state, 'applied'));
        }
        default:
          return Promise.resolve(result(request, state, 'rejected'));
      }
    },
  };
  mockChatPort = port;
  mockWatcherState.watchers = [];
  mockWatcherState.fired = [];
  mockWatcherState.failNextSetup = false;
  mockWatcherState.isIdle = (target): boolean => {
    const projectId =
      typeof target.projectId === 'string' ? target.projectId : '';
    const worktreeId =
      typeof target.worktreeId === 'string' ? target.worktreeId : '';
    return !scope(projectId, worktreeId).running.has(target.chatId ?? '');
  };
  mockWatcherState.turnFinished = (target, turnUserMessageId): boolean => {
    const projectId =
      typeof target.projectId === 'string' ? target.projectId : '';
    const worktreeId =
      typeof target.worktreeId === 'string' ? target.worktreeId : '';
    const chatId = target.chatId ?? '';
    const userMessageId =
      turnUserMessageId ??
      findTab(projectId, worktreeId, chatId)?.messages.find(
        (message) => message.role === 'user',
      )?.id;
    return (
      userMessageId !== undefined &&
      findTab(projectId, worktreeId, chatId)?.messages.some(
        (message) => message.id === userMessageId,
      ) === true &&
      !(scope(projectId, worktreeId).turns.get(chatId) ?? []).includes(
        userMessageId,
      )
    );
  };

  const dispatcher = createDesktopRuntime({
    workspaceServices: {
      readAllSidebarItems: jest
        .fn()
        .mockResolvedValue({ version: 1, items: [] }),
      readWorkspaceIndexEntry: jest.fn((id: string) =>
        Promise.resolve(
          worktrees.has(id)
            ? {
                id,
                name:
                  id === workspaceId
                    ? world.workspace.name
                    : 'Foreign workspace',
                type: 'multi-repo',
                color: '#000000',
                collapsed: false,
                order: 0,
              }
            : null,
        ),
      ),
      readWorkspaceConfig: jest
        .fn()
        .mockResolvedValue({ version: 1, type: 'multi-repo', repos: [] }),
      readEffectiveWorkspaceConfig: jest.fn().mockResolvedValue({
        repos: world.workspace.repositories.map((repository) => ({
          id: repository.repoId,
          manifestUrl: repository.remoteUrl,
        })),
      }),
      readWorkspaceWorktrees: jest.fn((id: string) =>
        Promise.resolve(worktrees.get(id) ?? []),
      ),
    },
    getChatStatePort: () => port,
    chatServices: { getPort: () => port },
    chatCommandPort: port,
  });

  const withdrawnModels = new Set<string>();
  const holds = createWriteHolds();
  const commitFailures = createLimitCommitFailures();
  let clock = Date.parse(CREATED_AT);
  const models = (): AgentModelList => ({
    models: world.models.map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.provider,
      kind: 'model',
      available: !withdrawnModels.has(model.id),
      isDefault: model.id === world.defaultModelId,
      thinkingLevels: [...model.thinkingLevels],
    })),
    defaultModelId: world.defaultModelId,
  });
  const terminalChats = new Set<string>();
  const conformanceRoot = (chat: {
    workspaceId: string;
    worktreeId: string;
  }): string => `/conformance/${chat.workspaceId}/${chat.worktreeId}`;
  const environment = createDesktopEnvironmentPort({
    runtime: () => dispatcher,
    listModels: () => Promise.resolve(models()),
    listWorkEntries: () => Promise.resolve([]),
    chatApprovalPolicy: (chat) =>
      Promise.resolve({
        mode: 'full-access',
        sessionRules: [],
        root: conformanceRoot(chat),
      }),
    newChatApprovalMode: () => Promise.resolve('full-access'),
    liveApprovalMode: (chat, mode, use) =>
      desktopEnvironmentPortDeps().liveApprovalMode(chat, mode, use),
    callerSessionApprovalRules: (chat, rules) =>
      desktopEnvironmentPortDeps().callerSessionApprovalRules(chat, rules),
    approvalSettingsRevision: () =>
      desktopEnvironmentPortDeps().approvalSettingsRevision(),
    chatApprovalStateRevision: (chat) =>
      desktopEnvironmentPortDeps().chatApprovalStateRevision(chat),
    effectiveApprovalPolicy: (source, policyCall) =>
      desktopEnvironmentPortDeps().effectiveApprovalPolicy(source, policyCall),
    chatExecutionRoot: (chat) => Promise.resolve(conformanceRoot(chat)),
    terminalDrivenChatIds: (_scope, chatIds) =>
      Promise.resolve(chatIds.filter((chatId) => terminalChats.has(chatId))),
    terminalTurnStates: () => Promise.resolve(() => undefined),
  });

  const runtime: CanopyInjectedToolRuntime = {
    requestUserAnswers: () => Promise.resolve([]),
    loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
    worktreeActionRuntime: {
      projectId: world.current.workspaceId,
      worktreeId: world.current.worktreeId,
      chatId: world.current.chatId,
      cwd: '/conformance/worktree',
      getWindow: () => null,
    },
    worktreeWatcherRuntime: {
      projectId: world.current.workspaceId,
      worktreeId: world.current.worktreeId,
      chatId: world.current.chatId,
    },
  };
  const openedSettings: unknown[] = [];
  const control: AgentConformanceWorldControl = {
    transcriptReadCount: (): number => transcripts.readCount(),
    setChatMessageable: (chatId, messageable): Promise<void> => {
      if (messageable) terminalChats.delete(chatId);
      else terminalChats.add(chatId);
      return Promise.resolve();
    },
    archiveChat: (chatId): Promise<void> => {
      scopes.forEach((state) => {
        const index = state.tabs.findIndex((tab) => tab.id === chatId);
        const tab = state.tabs[index];
        if (!tab) return;
        state.tabs.splice(index, 1);
        state.running.delete(chatId);
        state.revision += 1;
        state.archives.push({
          chatId,
          title: tab.title,
          archivedAt: CREATED_AT,
          createdAt: CREATED_AT,
          turnCount: 1,
          unread: false,
          restorable: true,
        });
      });
      return Promise.resolve();
    },
    withdrawModel: (modelId): Promise<void> => {
      withdrawnModels.add(modelId);
      return Promise.resolve();
    },
    advanceClock: (ms): Promise<void> => {
      clock += ms;
      return Promise.resolve();
    },
    holdNextChatStart: (): AgentConformanceWriteHold =>
      holds.holdNextChatStart(),
    holdNextMessagePost: (): AgentConformanceWriteHold =>
      holds.holdNextMessagePost(),
    failNextLimitCommit: (): Promise<void> => {
      commitFailures.failNextCommit();
      return Promise.resolve();
    },
    // A completion is stamped with its turn's user message id, so a watcher
    // bound to another turn of the chat stays armed.
    completeTurn: (chatId): Promise<readonly string[]> => {
      let finished: string | undefined;
      scopes.forEach((state) => {
        const queue = state.turns.get(chatId);
        if (finished !== undefined || !queue?.length) return;
        finished = queue.shift();
        if (queue.length === 0) state.running.delete(chatId);
      });
      if (finished === undefined) return Promise.resolve([]);
      const fired = mockWatcherState.watchers.filter(
        (watcher) =>
          watcher.target.chatId === chatId &&
          (watcher.target.turnUserMessageId === undefined ||
            watcher.target.turnUserMessageId === finished),
      );
      mockWatcherState.watchers = mockWatcherState.watchers.filter(
        (watcher) => !fired.includes(watcher),
      );
      mockWatcherState.fired.push(...fired);
      return Promise.resolve(fired.map((watcher) => watcher.id));
    },
    firedWatchers: (): Promise<readonly string[]> =>
      Promise.resolve(mockWatcherState.fired.map((watcher) => watcher.id)),
    openedSettings: (): Promise<readonly unknown[]> =>
      Promise.resolve([...openedSettings]),
  };
  // The calling chat's main window, recording the routes main asks it to open.
  const settingsWindow = {
    isDestroyed: (): boolean => false,
    webContents: {
      isDestroyed: (): boolean => false,
      isCrashed: (): boolean => false,
      mainFrame: { detached: false, isDestroyed: (): boolean => false },
      send: (channel: string, route: unknown): void => {
        if (channel === IPC_CHANNELS.accountOrganizationSettingsOpen)
          openedSettings.push(route);
        if (
          channel === IPC_CHANNELS.remoteControlDialogRequest &&
          !(
            typeof route === 'object' &&
            route !== null &&
            Object.keys(route).length === 1 &&
            'open' in route &&
            typeof route.open === 'boolean'
          )
        )
          throw new Error('Remote Control dialog request is not { open }');
      },
    },
  };
  const settings = createDesktopSettingsPort({
    readAccount: () =>
      Promise.resolve({
        status: 'signed_in',
        organizationIds: world.organizations.map(
          (organization) => organization.organizationId,
        ),
      }),
    getWindow: () => settingsWindow,
  });
  let forks = 0;
  const receipts =
    createInMemoryAgentActionReceipts<CanopyInjectedToolRuntime>();
  const split = createDesktopSplitPort({
    receipts,
    startSplitAgent: (_kind, _input, source) => {
      forks += 1;
      const chatId = `forked-chat-${forks}`;
      const state = scope(source.projectId, source.worktreeId);
      state.tabs.push({
        id: chatId,
        title: 'Forked chat',
        createdAt: CREATED_AT,
        messages: [],
      });
      submitTurn(state, chatId, `${chatId}-turn`);
      return Promise.resolve({
        ok: true,
        chatId,
        worktreeId: source.worktreeId,
        delivery: 'submitted',
        independent: true,
      });
    },
  });
  const seededChatIds = new Set([
    ...world.chats.map((chat) => chat.chatId),
    world.foreign.chatId,
  ]);
  return {
    runtime,
    control,
    startedChatIds: (): string[] =>
      Array.from(scopes.values()).flatMap((state) =>
        state.tabs
          .map((tab) => tab.id)
          .filter((chatId) => !seededChatIds.has(chatId)),
      ),
    surface: createDesktopAgentActionSurface(runtime, {
      brand: world.brand,
      ports: {
        experiments: {
          setEnabled: (request): Promise<AgentExperimentWriteResult> => {
            if (request.experimentId !== 'early-access')
              return Promise.reject(
                new AgentPortError('invalid_payload', 'Unknown experiment.'),
              );
            return Promise.resolve({
              experimentId: request.experimentId,
              storedChoice: request.enabled,
              effectiveEnabledAtCommit: request.enabled,
              listedAtCommit: true,
              generationAtCommit: 0,
              revisionAtCommit: 1,
            });
          },
        },
        // A signed-in computer syncing its lists; writing the current state
        // is a no-op. This stub does not model the real port's turn-off
        // prompt; it rejects any change.
        inventorySync: {
          getState: (): Promise<AgentInventorySyncState> =>
            Promise.resolve(inventorySyncState),
          setEnabled: (request) =>
            request.enabled === inventorySyncState.enabled
              ? Promise.resolve({
                  changed: false,
                  stateAtCommit: inventorySyncState,
                })
              : Promise.reject(
                  new AgentPortError(
                    'authorization_conflict',
                    'The person declined turning off syncing.',
                  ),
                ),
        },
        // The real port, sending to the calling chat's window above.
        remoteControlDialog: createDesktopRemoteControlDialogPort({
          getWindow: () => settingsWindow,
          service: () =>
            Promise.resolve({
              getState: () => Promise.resolve({ available: true }),
            }),
        }),
        settings,
        environment: holds.wrap(environment),
        transcriptRead: createDesktopTranscriptReadPort({
          runtime: () => dispatcher,
          listWorkEntries: () => Promise.resolve([]),
          resolveStandaloneOwner: () =>
            Promise.resolve({
              workspaceId: world.workspace.workspaceId,
              entryId: null,
              archivedInEntryId: null,
            }),
        }),
        limits: commitFailures.wrap(
          createInMemoryAgentActionLimits({
            limits: DESKTOP_AGENT_ACTION_LIMITS,
            now: () => clock,
          }),
        ),
        chatWatchers: desktopChatWatcherPort,
        split,
        receipts,
      },
    }),
  };
}

beforeAll(async () => {
  const world = loadConformanceWorld();
  await seedEmptyApprovalRuleSources([
    world.workspace.workspaceId,
    world.foreign.workspaceId,
  ]);
});

describe('desktop agent action host', () => {
  runAgentActionConformance({ describe, it }, (world) => {
    const host = makeDesktopHost(world);
    return {
      surface: host.surface,
      capabilities: desktopAgentActionCapabilities(host.runtime),
      call: ({
        callingChatId,
        ...identity
      }): AgentActionCall<CanopyInjectedToolRuntime> => {
        const caller = world.chats.find(
          (chat) => chat.chatId === callingChatId,
        );
        return {
          host: host.runtime,
          scope: caller
            ? {
                workspaceId: world.workspace.workspaceId,
                worktreeId: caller.worktreeId,
                chatId: caller.chatId,
              }
            : { ...world.current },
          ...identity,
        };
      },
      control: host.control,
      limitValues: DESKTOP_AGENT_ACTION_LIMITS,
    };
  });
});

// These boundary contracts are part of the desktop settings action host: a replayable
// approval must never acquire a secret, and Personal policy must never govern team work.
describe('AI gateway desktop action boundaries', () => {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  it('approval:secret-input is consumed once by its bound renderer, outside generic decisions and replay', async () => {
    const identity = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    };
    resetDesktopChatWaitsForTest({ noClientMode: 'wait' });
    resetDesktopApprovalBrokerForTests();
    const sender = {
      isCrashed: (): boolean => false,
      isDestroyed: (): boolean => false,
      send: jest.fn(),
      mainFrame: { detached: false, isDestroyed: (): boolean => false },
    };
    const window = { isDestroyed: (): boolean => false, webContents: sender };
    const bindingId = '33333333-3333-4333-8333-333333333333';
    const handle = getDesktopApprovalBroker().open({
      owner: 'gateway-session',
      scope: {
        workspaceId: identity.projectId,
        worktreeId: identity.worktreeId,
        chatId: identity.chatId,
      },
      presentation: (id) => ({
        ...identity,
        requestId: id,
        provider: 'claude',
        title: 'Connect AI gateway gateway.example?',
        details: { kind: 'tool', toolName: 'settings.ai_gateway.connect' },
        secretInput: { kind: 'secret-input', bindingId, label: 'API key' },
      }),
      port: windowApprovalPort(() => window),
      timeoutMs: null,
      revalidate: () => Promise.resolve('prompt'),
    });
    const { requestId } = handle;
    const responder = { id: 'webcontents:1', owners: [sender] };
    const consume = jest.fn<void, [string]>();
    expect(registerApprovalSecretConsumer(requestId, consume)).toBe(true);
    const [card] = pendingApprovalRequests([sender]);
    const request = {
      ...identity,
      requestId,
      bindingId,
      secret: 'secret-input-test-key',
      policyRevision: card?.policyRevision,
    };
    expect(JSON.stringify(pendingApprovalRequests([sender]))).not.toContain(
      request.secret,
    );
    expect(
      resolveApproval(
        requestId,
        { behavior: 'allow', scope: 'once' },
        responder,
        identity,
        request.policyRevision,
      ),
    ).toBe(false);
    expect(
      resolveApprovalFromMain(requestId, 'gateway-session', {
        behavior: 'allow',
        scope: 'once',
      }),
    ).toBe(false);
    expect(
      resolveApprovalSecretInput(request, { id: 'other', owners: [{}] }),
    ).toBe(false);
    expect(
      resolveApprovalSecretInput(
        { ...request, bindingId: requestId },
        responder,
      ),
    ).toBe(false);
    expect(resolveApprovalSecretInput(request, responder)).toBe(true);
    await expect(handle.settled).resolves.toMatchObject({
      state: 'allowed',
      decision: { behavior: 'allow', scope: 'once' },
    });
    expect(consume).toHaveBeenCalledWith(request.secret);
    expect(resolveApprovalSecretInput(request, responder)).toBe(false);
    expect(pendingApprovalRequests([sender])).toEqual([]);
    resetDesktopApprovalBrokerForTests();
  });
  it('settings:save-canopy-cloud-api-key retains separate Personal policy without adding it to team enforcement', () => {
    const fields = personalGatewayAccountFields({
      personalOrganizationId: organizationId,
      personalModelGateway: {
        organizationId,
        kind: 'model-gateway',
        baseUrl: 'https://gateway.example/v1',
        models: [],
        enforced: true,
        promptCachePassthrough: true,
        displayName: 'My gateway',
      },
    });
    const index = resolveModelGatewayIndex({
      personalOrganizationId: organizationId,
      ...fields,
    });
    expect(gatewayRequirementForOwner(index, { kind: 'personal' })).toEqual({
      kind: 'enforced',
      organizationIds: [organizationId],
    });
    expect(gatewayRequirementForOwner(index)).toEqual({ kind: 'unrestricted' });
    expect(
      gatewayRequirementForOwner(index, {
        kind: 'organization',
        organizationId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toEqual({ kind: 'unrestricted' });
    expect(
      personalGatewayAccountFields({
        personalOrganizationId: organizationId,
        personalModelGateway: {
          organizationId,
          kind: 'model-gateway',
          baseUrl: 'http://unsafe',
          enforced: true,
        },
      }),
    ).toEqual({ personalModelGatewayEnforcementUnavailable: true });
    expect(personalGatewayAccountFields({})).toEqual({});
  });
});
