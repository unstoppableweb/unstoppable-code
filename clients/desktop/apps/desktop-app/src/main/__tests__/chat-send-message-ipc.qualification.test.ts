import type * as ActiveChatInputModule from '../services/active-chat-input';
import type { inlineTurnRunsModule } from './helpers/inline-agent-runs';
const mockEditRetainedTerminalAgentInput = jest
  .fn<Promise<void>, [unknown]>()
  .mockResolvedValue(undefined);
const mockReadCursorAccount = jest.fn(
  (): Promise<{ email: string } | null> => Promise.resolve({ email: '' }),
);
jest.mock('../cursor/connection', () => ({
  readCursorAccount: (): Promise<{ email: string } | null> =>
    mockReadCursorAccount(),
}));
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type * as SessionManagerModule from '../agents/session-manager';
import type * as AgentDefaultModelModule from '../agents/agent-default-model';
import type * as DesktopSharedTypesModule from '@canopy/desktop-shared/types';
import type * as WorktreeChatTurnModule from '../lib/worktree-chat-turn';
import type * as ChatDispatchAuthorizationModule from '../services/chat-dispatch-authorization';
import type * as WorkOwnerModule from '../agents/work-owner';
import type * as ChatTabDispatchUtilsModule from '../lib/chat-tab-dispatch-utils';
import type * as DeliveryTrackerModule from '../memory/delivery-tracker';
import type * as ModelGatewayStateModule from '../lib/model-gateway-state';
import type * as HookChatModule from '../lib/hook-chat';
import type * as ApprovalModeResolutionModule from '../lib/approval-mode-resolution';
import type * as CodexCapabilityTransitionModule from '../codex/capability-transition';

const mockPrepareOrgMemory = jest
  .fn<Promise<unknown>, [unknown]>()
  .mockResolvedValue(null);
// This suite mocks the chat state service, so the queue's ownership is never
// bound and issues no dispatch capability; its dispatches stand in for
// queue-admitted ones.
jest.mock('../services/chat-dispatch-authorization', () => ({
  ...jest.requireActual<typeof ChatDispatchAuthorizationModule>(
    '../services/chat-dispatch-authorization',
  ),
  consumeDispatchAuthorization: (): void => undefined,
}));

jest.mock('../lib/worktree-chat-turn', () => ({
  ...jest.requireActual<typeof WorktreeChatTurnModule>(
    '../lib/worktree-chat-turn',
  ),
  prepareOrgMemory: (options: unknown) => mockPrepareOrgMemory(options),
}));

const mockPersistOrgMemoryUsedForChat = jest
  .fn<Promise<boolean>, [unknown]>()
  .mockResolvedValue(true);
jest.mock('../lib/chat-tab-dispatch-utils', () => ({
  ...jest.requireActual<typeof ChatTabDispatchUtilsModule>(
    '../lib/chat-tab-dispatch-utils',
  ),
  persistOrgMemoryUsedForChat: (args: unknown) =>
    mockPersistOrgMemoryUsedForChat(args),
}));

const mockMemoryAckDelivered = jest.fn();
const mockMemoryAckDropped = jest.fn();
jest.mock('../memory/delivery-tracker', () => {
  const actual = jest.requireActual<typeof DeliveryTrackerModule>(
    '../memory/delivery-tracker',
  );
  return {
    ...actual,
    createOrgMemoryDeliveryTracker: (
      options: DeliveryTrackerModule.OrgMemoryDeliveryTrackerOptions,
    ): DeliveryTrackerModule.OrgMemoryDeliveryTracker => {
      const tracker = actual.createOrgMemoryDeliveryTracker(options);
      return {
        ...tracker,
        ackDelivered: (organizationExternalId, searchId): void => {
          mockMemoryAckDelivered(organizationExternalId, searchId);
          tracker.ackDelivered(organizationExternalId, searchId);
        },
        ackDropped: (organizationExternalId, searchId, reason): void => {
          mockMemoryAckDropped(organizationExternalId, searchId, reason);
          tracker.ackDropped(organizationExternalId, searchId, reason);
        },
      };
    },
  };
});

jest.mock('../agent-runs/turn-runs', () =>
  jest
    .requireActual<{
      inlineTurnRunsModule: typeof inlineTurnRunsModule;
    }>('./helpers/inline-agent-runs')
    .inlineTurnRunsModule(),
);
jest.mock('../opencode/connection', () => ({
  assertOpenCodeModelAvailable: () =>
    Promise.resolve({ id: 'opencode:fixture%2Fmodel' }),
}));
jest.mock('../opencode/runtime-availability', () => ({
  isOpenCodeRuntimeAvailable: () => Promise.resolve(true),
}));

const mockAssertCopilotModelAvailable = jest.fn<
  Promise<void>,
  [string | undefined]
>(() => Promise.reject(new Error('This Copilot model is unavailable.')));
jest.mock('../copilot/connection', () => ({
  assertCopilotModelAvailable: (model?: string) =>
    mockAssertCopilotModelAvailable(model),
}));
jest.mock('../copilot/runtime-availability', () => ({
  isCopilotRuntimeAvailable: () => Promise.resolve(true),
}));

const mockCursorFlagEnabled = jest.fn(() => true);
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: () => ({ isEnabled: mockCursorFlagEnabled }),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

const mockCursorConnectionStatus = jest.fn(() =>
  Promise.resolve({
    supported: true,
    installed: true,
    enabled: true,
    version: 'test',
    phase: 'connected',
  }),
);
jest.mock('../cursor/runtime-status', () => ({
  cursorConnectionStatus: () => mockCursorConnectionStatus(),
}));
// `isCursorRuntimeAvailable` lives in `runtime-availability`, which is what
// `ipc/chat.ts` imports. Declaring it on `runtime-status` left a dead mock and
// ran the real implementation.
jest.mock('../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: async () => {
    try {
      const status = await mockCursorConnectionStatus();
      return status.supported && status.enabled && status.installed;
    } catch {
      return false;
    }
  },
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/tmp/repo'),
  resolveWorktreeTargetIds: jest.fn(() => null),
  isBranchPromptSent: jest.fn().mockResolvedValue(true),
  doesBranchMatchWorktreeId: jest.fn().mockResolvedValue({
    matches: false,
    matchingRepos: null,
  }),
}));

jest.mock('../lib/worktree-repair', () => ({
  recordWorktreeDiscovery: jest.fn(),
}));

jest.mock('../lib/branch-namer', () => ({
  generateAndRenameBranch: jest.fn().mockResolvedValue(undefined),
}));

const mockResolveAgentDestinationDefaultModel = jest.fn<
  Promise<string>,
  [string | undefined]
>();
jest.mock('../agents/agent-default-model', () => {
  const actual = jest.requireActual<typeof AgentDefaultModelModule>(
    '../agents/agent-default-model',
  );
  return {
    ...actual,
    resolveAgentDestinationDefaultModel: (
      projectId: string | undefined,
    ): Promise<string> => mockResolveAgentDestinationDefaultModel(projectId),
    // The real pin's rules (unit-tested in agent-default-model.test.ts) over
    // the mocked destination default.
    resolveSendModelPin: async (
      projectId: string,
      stored: string | undefined,
      requested: string | undefined,
    ): Promise<string | undefined> => {
      const selected = requested ?? stored;
      const { isInheritingAgentModel } = jest.requireActual<
        typeof DesktopSharedTypesModule
      >('@canopy/desktop-shared/types');
      // The real resolver reads the default only to pin a bare inheriting
      // Agent the chat holds no route for; give it that route, pinned to the
      // mocked default, as the chat's own.
      const needsDefault =
        selected !== undefined &&
        isInheritingAgentModel(selected) &&
        !stored?.startsWith(`${selected}@`);
      const chatModel = needsDefault
        ? actual.formatInheritedAgentRoute(
            selected,
            await mockResolveAgentDestinationDefaultModel(projectId),
          )
        : stored;
      return actual.resolveSendModelPin(projectId, chatModel, selected);
    },
  };
});

jest.mock('../agents/utils', () => ({
  HANDOFF_SUMMARY_MODEL: 'claude-haiku-4-5-20251001',
  generateHandoffSummary: jest.fn().mockResolvedValue({
    text: 'handoff summary',
    usage: {},
  }),
}));

const mockResolveSessionWorkOwner = jest.fn<
  ReturnType<typeof WorkOwnerModule.resolveSessionWorkOwner>,
  Parameters<typeof WorkOwnerModule.resolveSessionWorkOwner>
>(() => Promise.resolve(undefined));
const mockCaptureSessionWorkOwner = jest.fn();
jest.mock('../agents/work-owner', () => {
  const actual = jest.requireActual<typeof WorkOwnerModule>(
    '../agents/work-owner',
  );
  return {
    ...actual,
    captureSessionWorkOwner: (...args: unknown[]): unknown =>
      mockCaptureSessionWorkOwner(...args),
    resolveSessionWorkOwner: (
      ...args: Parameters<typeof WorkOwnerModule.resolveSessionWorkOwner>
    ): ReturnType<typeof WorkOwnerModule.resolveSessionWorkOwner> =>
      mockResolveSessionWorkOwner(...args),
  };
});

jest.mock('../codex/fork-thread', () => ({
  forkCodexThreadByIdViaOneShot: jest.fn(),
}));

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
  validateOptionalRepoId: jest.fn(),
}));

jest.mock('../lib/usage-limited-chats-registry', () => ({
  clearUsageLimitedChat: jest.fn(),
}));

const blockedModelIds = new Set<string>();
jest.mock('../lib/model-policy-state', () => ({
  // Async, matching the real guard: enforcement must consult the stored
  // account, not process-local state that is empty during startup.
  isModelBlockedByStoredPolicy: (modelId: string): Promise<boolean> =>
    Promise.resolve(blockedModelIds.has(modelId)),
  isOrgModelPolicyActiveForStoredAccount: (): Promise<boolean> =>
    Promise.resolve(false),
  isStoredModelPolicyReadDegraded: (): boolean => false,
}));

const mockCheckModelGatewayRoute = jest.fn<
  Promise<{ ok: true; orgRoute: boolean } | { ok: false; message: string }>,
  [string | undefined, unknown]
>(() => Promise.resolve({ ok: true, orgRoute: false }));
jest.mock('../lib/model-gateway-state', () => ({
  ...jest.requireActual<typeof ModelGatewayStateModule>(
    '../lib/model-gateway-state',
  ),
  checkModelGatewayRoute: (modelId: string | undefined, owner: unknown) =>
    mockCheckModelGatewayRoute(modelId, owner),
}));

jest.mock('../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticatedForRouting: (): Promise<boolean> =>
    Promise.resolve(true),
  peekProviderNativeAuthAvailability: (): {
    claude: boolean;
    codex: boolean;
  } => ({ claude: true, codex: true }),
}));

const mockRouteDesktopAutoTurn = jest.fn();
jest.mock('../model-routing/route-turn', () => ({
  routeDesktopAutoTurn: (...args: unknown[]): unknown =>
    mockRouteDesktopAutoTurn(...args),
}));

jest.mock('../agents/ai-credits-routing', () => ({
  getAiCreditsRoutingContext: (): Promise<null> => Promise.resolve(null),
  // Lane resolution reads the context and its degraded status as ONE value so
  // a concurrent read cannot move the status out from under it. `degraded:
  // false` here means the `null` above is a real sign-out, not a failed read.
  getAiCreditsRoutingContextWithStatus: (): Promise<{
    context: null;
    degraded: boolean;
  }> => Promise.resolve({ context: null, degraded: false }),
}));

jest.mock('../lib/transient-error-retry-service', () => ({
  cancelTransientRetryForChat: jest.fn(),
  getTransientRetryStateSnapshot: jest.fn(() => []),
}));

// CAN-1814 PR 5/7. The send-time auth preflight is cached-only and owns its own
// module; here only its VERDICT matters. `requireActual` is spread rather than
// hand-rolling a double so `TurnAuthPreflightBlockedError` stays the real class
// -- the handler identifies a refusal with `instanceof`, and a fake class would
// make that check pass without proving anything about production.
const mockAssertTurnAuthDependencies = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
jest.mock('../lib/auth-preflight', () => {
  const actual = jest.requireActual<typeof AuthPreflightModule>(
    '../lib/auth-preflight',
  );
  return {
    ...actual,
    assertTurnAuthDependencies: (input: unknown): Promise<void> =>
      mockAssertTurnAuthDependencies(input),
  };
});

const resetChatToPointMock = jest.fn();
jest.mock('../lib/chat-reset-to-point', () => ({
  resetChatToPoint: (...args: unknown[]): unknown =>
    resetChatToPointMock(...args),
}));

const buildPlanFileSystemInstructionMock = jest.fn();
jest.mock('../lib/plan-system-instructions', () => ({
  buildPlanFileSystemInstruction: (...args: unknown[]): unknown =>
    buildPlanFileSystemInstructionMock(...args),
}));

const cancelQueuedHookChatMock = jest.fn<{ cancelled: boolean }, [string]>(
  () => ({ cancelled: true }),
);
const forceQueuedHookChatMock = jest.fn<Promise<{ forced: boolean }>, [string]>(
  () => Promise.resolve({ forced: true }),
);
const updateQueuedHookChatPlanModeMock = jest.fn();
const updateQueuedHookChatApprovalModeMock = jest.fn();
const updateQueuedHookChatCodexFastModeMock = jest.fn();
const updateQueuedHookChatThinkingLevelMock = jest.fn();
const updateQueuedHookChatInterfaceModeMock = jest.fn<
  ReturnType<typeof HookChatModule.updateQueuedHookChatInterfaceMode>,
  Parameters<typeof HookChatModule.updateQueuedHookChatInterfaceMode>
>(() => true);
const updateQueuedHookChatModelMock = jest.fn();
const updateQueuedHookChatPluginSelectionsMock = jest.fn();
const hasQueuedHookChatMock = jest.fn<
  ReturnType<typeof HookChatModule.hasQueuedHookChat>,
  Parameters<typeof HookChatModule.hasQueuedHookChat>
>(() => false);

jest.mock('../lib/hook-chat', () => ({
  hasQueuedHookChat: (
    ...args: Parameters<typeof HookChatModule.hasQueuedHookChat>
  ): ReturnType<typeof HookChatModule.hasQueuedHookChat> =>
    hasQueuedHookChatMock(...args),
  cancelQueuedHookChat: (...args: [string]): { cancelled: boolean } =>
    cancelQueuedHookChatMock(...args),
  forceQueuedHookChat: (...args: [string]): Promise<{ forced: boolean }> =>
    forceQueuedHookChatMock(...args),
  updateQueuedHookChatPlanMode: (...args: unknown[]): unknown =>
    updateQueuedHookChatPlanModeMock(...args),
  updateQueuedHookChatApprovalMode: (...args: unknown[]): unknown =>
    updateQueuedHookChatApprovalModeMock(...args),
  updateQueuedHookChatCodexFastMode: (...args: unknown[]): unknown =>
    updateQueuedHookChatCodexFastModeMock(...args),
  updateQueuedHookChatThinkingLevel: (...args: unknown[]): unknown =>
    updateQueuedHookChatThinkingLevelMock(...args),
  updateQueuedHookChatInterfaceMode: (
    ...args: Parameters<typeof HookChatModule.updateQueuedHookChatInterfaceMode>
  ): ReturnType<typeof HookChatModule.updateQueuedHookChatInterfaceMode> =>
    updateQueuedHookChatInterfaceModeMock(...args),
  updateQueuedHookChatModel: (...args: unknown[]): unknown =>
    updateQueuedHookChatModelMock(...args),
  updateQueuedHookChatPluginSelections: (...args: unknown[]): unknown =>
    updateQueuedHookChatPluginSelectionsMock(...args),
}));

jest.mock('../agents/session-manager', () => ({
  restrictSessionApprovalRules: jest.fn(),
  beginSessionTurnPreparation: jest.fn(() => jest.fn()),
  releaseSessionTurnPreparationOnActivation: jest.fn(),
  getOrCreateSession: jest.fn(),
  getSession: jest.fn(),
  getSessionSelectedModel: jest.fn(),
  getActiveChatIds: jest.fn(() => []),
  hasPendingCodexContinuation: jest.fn(() => false),
  getActiveSessionInfos: jest.fn(() => []),
  getActiveSessionCapabilityProfile: jest.fn(() => undefined),
  getChatTurnConcurrencySnapshot: jest.fn(() => ({
    activeTurns: 0,
    pendingMessages: 0,
  })),
  drainChatSessionEvents: jest.fn(() => Promise.resolve()),
  destroySession: jest.fn().mockResolvedValue(undefined),
  suppressCodexAuthenticationRecovery: jest.fn(),
  markSessionForNextTurnRecreation: jest.fn(),
  sessionHasActiveTurnOrNativeWork: jest.fn(() => false),
  chatHasNativeBackgroundWork: jest.fn(() => false),
  updateSessionTurnSettingsModel: jest.fn(),
  updateSessionModel: jest.fn(),
  getSessionTurnSettings: jest.fn(() => undefined),
  setSessionTurnSettings: jest.fn(),
  getSessionRecreateReasons: jest.fn(() => []),
  getSessionProviderType: jest.fn(),
  getSessionCodeGraphToolsAdvertised: jest.fn(() => undefined),
  getSessionGlobalInstructionsSnapshot: jest.fn(() => undefined),
  shouldRecreateSessionOnNextTurn: jest.fn(() => false),
  isProviderChangeAllowed: jest.fn(() => true),
  buildSessionKey: jest.fn(
    (projectId: string, worktreeId: string, chatId: string) =>
      `${projectId}/${worktreeId}/${chatId}`,
  ),
  subscribeChatSessionActivity: jest.fn((): (() => void) => () => {}),
  subscribeLiveBackgroundTasks: jest.fn((): (() => void) => () => {}),
  getChatSessionLiveness: jest.fn(
    (projectId: string, worktreeId: string, chatId: string) => {
      const { getSession, getActiveChatIds } = jest.requireMock<
        typeof SessionManagerModule
      >('../agents/session-manager');
      const session = getSession(projectId, worktreeId, chatId);
      return {
        foreground:
          session?.isDisposed?.() !== true &&
          (session?.hasPendingSteeringInput?.() === true ||
            getActiveChatIds(projectId, worktreeId).includes(chatId)),
        background: false,
      };
    },
  ),
  hasActiveChatTurns: jest.fn(() => false),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  getSessionAiCreditsRoutedState: jest.fn(() => undefined),
  getSessionPluginSelections: jest.fn(() => undefined),
  getSessionGlobalPluginDefaultsRevision: jest.fn(() => undefined),
  getGlobalPluginDefaultsRevision: jest.fn(() => 0),
  subscribeGlobalPluginDefaultsRevision: jest.fn((): (() => void) => () => {}),
}));

jest.mock('../mcp/pending-requests', () => ({
  resolveRequest: jest.fn(),
  rejectRequest: jest.fn(),
  hasPendingRequestForSession: jest.fn(() => false),
}));

jest.mock('../mcp/plan-pending-requests', () => ({
  approvePlanExit: jest.fn(),
  denyPlanExit: jest.fn(),
}));

const mockResolvePersistedApprovalMode = jest.fn().mockResolvedValue('ask');
const mockResolveApprovalProjectId = jest.fn(
  (projectId: string): string | undefined => projectId,
);
const mockSurfaceForChat = jest.fn<
  ReturnType<typeof ApprovalModeResolutionModule.surfaceForChat>,
  Parameters<typeof ApprovalModeResolutionModule.surfaceForChat>
>(() => 'worktree');
const mockEndPendingApprovalDefaultWrite = jest.fn();
const mockApprovalDefaultIntentGenerations = new Map<string, number>();
const mockCommittedApprovalDefaultIntentGenerations = new Map<string, number>();
const mockBeginApprovalDefaultIntent = jest.fn((surface: string): number => {
  const generation =
    (mockApprovalDefaultIntentGenerations.get(surface) ?? 0) + 1;
  mockApprovalDefaultIntentGenerations.set(surface, generation);
  return generation;
});
const mockIsApprovalDefaultIntentCurrent = jest.fn(
  (surface: string, generation: number): boolean =>
    (mockCommittedApprovalDefaultIntentGenerations.get(surface) ?? 0) <=
    generation,
);
const mockCommitApprovalDefaultIntent = jest.fn(
  (surface: string, generation: number): void => {
    const committedGeneration =
      mockCommittedApprovalDefaultIntentGenerations.get(surface) ?? 0;
    if (generation > committedGeneration) {
      mockCommittedApprovalDefaultIntentGenerations.set(surface, generation);
    }
  },
);
const mockBeginPendingApprovalDefaultWrite = jest.fn(
  (): (() => void) => mockEndPendingApprovalDefaultWrite,
);
jest.mock('../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: (...args: unknown[]): unknown =>
    mockResolvePersistedApprovalMode(...args),
  resolveApprovalProjectId: (...args: unknown[]): unknown =>
    mockResolveApprovalProjectId(...(args as [string])),
  surfaceForChat: (
    ...args: Parameters<typeof ApprovalModeResolutionModule.surfaceForChat>
  ): ReturnType<typeof ApprovalModeResolutionModule.surfaceForChat> =>
    mockSurfaceForChat(...args),
  defaultsKeyForSurface: (surface: string): string =>
    surface === 'cowork'
      ? 'cowork'
      : surface === 'app-advisor'
        ? 'appAdvisor'
        : 'worktree',
  beginPendingApprovalDefaultWrite: (...args: unknown[]): unknown =>
    mockBeginPendingApprovalDefaultWrite(...(args as [])),
  beginApprovalDefaultIntent: (...args: unknown[]): unknown =>
    mockBeginApprovalDefaultIntent(...(args as [string])),
  commitApprovalDefaultIntent: (...args: unknown[]): unknown =>
    mockCommitApprovalDefaultIntent(...(args as [string, number])),
  isApprovalDefaultIntentCurrent: (...args: unknown[]): unknown =>
    mockIsApprovalDefaultIntentCurrent(...(args as [string, number])),
  isEphemeralApprovalSurface: (projectId: string): boolean =>
    projectId === 'code-review-chat' || projectId === 'plan-explore-chat',
}));

const mockBroadcastPreferencesSynced = jest.fn();
jest.mock('../lib/preferences-broadcast', () => ({
  broadcastPreferencesSynced: (...args: unknown[]): unknown =>
    mockBroadcastPreferencesSynced(...args),
}));

const mockReadPreferencesFile = jest.fn<Promise<Record<string, unknown>>, []>();
const mockGetWorkspaceType = jest.fn();
const mockReadEffectiveWorkspaceConfig = jest.fn();

jest.mock('../ipc/preferences', () => ({
  get readPreferencesFile() {
    return mockReadPreferencesFile;
  },
}));

// Simulates `updatePreferencesFileWithPrevious`: the updater runs inside the
// serialized write queue and is handed the state as re-read at that moment.
const queuedPreferencesState: unknown = {};
const mockPeekPreferencesLoadError = jest.fn<unknown, unknown[]>(() => null);
const mockUpdatePreferencesFile = jest.fn(
  (updater: (previous: unknown) => unknown): Promise<unknown> =>
    Promise.resolve(updater(queuedPreferencesState)),
);
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFileDetailed: async (): Promise<{
    preferences: Awaited<ReturnType<typeof mockReadPreferencesFile>>;
    authority: 'ok' | 'unreadable';
  }> => ({
    preferences: await mockReadPreferencesFile(),
    authority: mockPeekPreferencesLoadError() != null ? 'unreadable' : 'ok',
  }),
  // Not degraded: approval resolution fails closed when this is non-null.
  peekPreferencesLoadError: (...args: unknown[]): unknown =>
    mockPeekPreferencesLoadError(...args),
  get readPreferencesFile() {
    return mockReadPreferencesFile;
  },
  updatePreferencesFile: (...args: unknown[]): unknown =>
    mockUpdatePreferencesFile(...(args as [(previous: unknown) => unknown])),
}));

jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: (workspaceId: string): unknown =>
    mockGetWorkspaceType(workspaceId),
  // 'standalone-chat' is the legacy sentinel keying; 'cowork-default'
  // simulates a real, rekeyed cowork workspace id so cowork-treatment tests
  // can exercise both keyings.
  isCoworkWorkspace: (id: string): boolean =>
    id === 'standalone-chat' || id === 'cowork-default',
  isWorkEntryWorkspace: (id: string): boolean =>
    id === 'app-advisor' || id === 'standalone-chat' || id === 'cowork-default',
}));

jest.mock('../lib/workspace-source', () => ({
  readEffectiveWorkspaceConfig: (workspaceId: string): unknown =>
    mockReadEffectiveWorkspaceConfig(workspaceId),
}));

jest.mock('../ipc/standalone-chat', () => ({
  generateChatSummaryForProject: jest.fn().mockResolvedValue('summary'),
  updateChatMeta: jest.fn().mockResolvedValue(undefined),
}));

const scheduleSummaryGenerationMock = jest.fn();
jest.mock('../lib/worktree-summary-scheduler', () => ({
  get scheduleSummaryGeneration() {
    return scheduleSummaryGenerationMock;
  },
}));

const startObservedTaskMock = jest.fn<
  ReturnType<ObservabilityService['startObservedTask']>,
  Parameters<ObservabilityService['startObservedTask']>
>();
const finalizeObservedTaskMock = jest.fn<
  ReturnType<ObservabilityService['finalizeObservedTask']>,
  Parameters<ObservabilityService['finalizeObservedTask']>
>();
const observeChatEventMock = jest.fn();
const completeChatTurnMock = jest.fn();
const recordSessionDiagnosticMock = jest.fn();
const recordInjectedPromptForOpenChatTurnMock = jest.fn();
const startChatTurnMock = jest.fn<
  void,
  [Parameters<ObservabilityService['startChatTurn']>[0]]
>();
const mockCheckWatcherIngress = jest.fn<
  ReturnType<typeof ActiveChatInputModule.checkWatcherDeliveryIngress>,
  [unknown]
>();
jest.mock('../services/active-chat-input', () => {
  const actual = jest.requireActual<typeof ActiveChatInputModule>(
    '../services/active-chat-input',
  );
  return {
    ...actual,
    checkWatcherDeliveryIngress: (request: unknown) =>
      mockCheckWatcherIngress(request),
    captureCanonicalChatProducerContext: jest.fn(
      (target: { projectId: string; worktreeId: string; chatId: string }) =>
        Promise.resolve({
          address: {
            projectId: target.projectId,
            taskId: target.worktreeId,
            chatId: target.chatId,
          },
          evidence: { sourceOwner: { kind: 'personal' } },
        }),
    ),
  };
});
const mockHandleChatTerminalEvent = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    get startObservedTask() {
      return startObservedTaskMock;
    },
    get finalizeObservedTask() {
      return finalizeObservedTaskMock;
    },
    get observeChatEvent() {
      return observeChatEventMock;
    },
    get completeChatTurn() {
      return completeChatTurnMock;
    },
    get startChatTurn() {
      return startChatTurnMock;
    },
    get recordSessionDiagnostic() {
      return recordSessionDiagnosticMock;
    },
    get recordInjectedPromptForOpenChatTurn() {
      return recordInjectedPromptForOpenChatTurnMock;
    },
  })),
}));

jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    get handleCanonicalChatTerminalEvent() {
      return mockHandleChatTerminalEvent;
    },
  })),
}));

jest.mock('../lib/turn-diff-capture', () => ({
  captureTurnStart: jest.fn().mockResolvedValue(undefined),
  captureTurnEndAndDiff: jest.fn().mockResolvedValue(null),
  // The chat turn's end capture since turn-state phase 40f.
  captureTurnEndAndDiffs: jest.fn().mockResolvedValue(null),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToWindowDetailed: jest.fn(),
}));

const mockReadChatTabsFile = jest.fn<Promise<ChatTabsFile>, [string, string]>();
jest.mock('../lib/chat-tabs-reader', () => ({
  readPersistedChatDispatchMetadata: jest.fn().mockResolvedValue({}),
  readChatTabsFile: (...args: [string, string]): Promise<ChatTabsFile> =>
    mockReadChatTabsFile(...args),
}));

const mockWriteChatTabsFile = jest
  .fn<Promise<void>, [string, string, ChatTabsFile, unknown?]>()
  .mockResolvedValue(undefined);
jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: (
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    delta?: unknown,
  ): Promise<void> => mockWriteChatTabsFile(projectId, worktreeId, data, delta),
}));

const mockHoldLocalSendForWorktreeSetup = jest.fn(
  async (
    _request: DesktopSharedTypesModule.ChatSendMessageRequest,
    _userMessage: () => unknown,
    submit: () => Promise<void>,
  ): Promise<'dispatch-now'> => {
    await submit();
    return 'dispatch-now';
  },
);
const mockAnswerPendingQuestion = jest.fn().mockResolvedValue(false);
const mockEnsureChatForTrustedSend = jest.fn().mockResolvedValue(undefined);
const mockRunWithScopeActivity = jest.fn(
  async (
    _scope: { projectId: string; worktreeId: string },
    operation: () => Promise<void>,
  ): Promise<void> => operation(),
);
const mockIngestProviderEvent = jest.fn<Promise<boolean>, [ProviderEventInput]>(
  () => Promise.resolve(true),
);
// Delivery-gated callers read the three-way outcome; by default it mirrors the
// boolean commit mock so existing commit expectations keep their meaning.
const ingestOutcomeFromCommit = async (
  input: ProviderEventInput,
): Promise<ProviderEventIngestOutcome> =>
  (await mockIngestProviderEvent(input)) ? 'applied' : 'not-applied';
const mockIngestProviderEventWithOutcome = jest.fn<
  Promise<ProviderEventIngestOutcome>,
  [ProviderEventInput]
>(ingestOutcomeFromCommit);
const ingestResultFromOutcome = async (
  input: ProviderEventInput,
): Promise<ProviderEventIngestResult> => {
  const outcome = await mockIngestProviderEventWithOutcome(input);
  const data = isRecord(input.data) ? input.data : null;
  const startingPickup =
    data?.type === 'canopy_input_delivery' &&
    data.phase === 'picked-up' &&
    data.startsTurn === true;
  return startingPickup
    ? {
        outcome,
        pickup: outcome === 'not-applied' ? 'rejected' : 'accepted',
      }
    : { outcome };
};
const mockIngestProviderEventWithResult = jest.fn<
  Promise<ProviderEventIngestResult>,
  [ProviderEventInput]
>(ingestResultFromOutcome);
const mockHasMutation = jest.fn<
  Promise<boolean>,
  [{ projectId: string; worktreeId: string }, string]
>(() => Promise.resolve(false));
const mockGetChatState = jest.fn<
  Promise<Pick<ChatStateSnapshot, 'runtimeByChatId' | 'tabsFile'>>,
  []
>(() =>
  Promise.resolve({
    runtimeByChatId: {},
    tabsFile: { version: 1, tabs: [], activeTabId: '' },
  }),
);
const mockReconcileHostQueue = jest.fn().mockResolvedValue(undefined);
const mockReplaceCompatibilityTabs = jest.fn(
  (
    scope: { projectId: string; worktreeId: string },
    tabsFile: ChatTabsFile,
  ): Promise<void> =>
    mockWriteChatTabsFile(scope.projectId, scope.worktreeId, tabsFile),
);
const mockUpdateCompatibilityTab = jest.fn(
  async (
    scope: { projectId: string; worktreeId: string },
    chatId: string,
    update: (
      tab: ChatTabsFile['tabs'][number],
    ) => ChatTabsFile['tabs'][number] | null,
  ) => {
    const file = await mockReadChatTabsFile(scope.projectId, scope.worktreeId);
    let updated = false;
    const tabs = file.tabs.map((tab) => {
      if (tab.id !== chatId) return tab;
      const next = update(tab);
      updated = next !== null;
      return next ?? tab;
    });
    const tabsFile = { ...file, tabs };
    if (updated)
      await mockWriteChatTabsFile(scope.projectId, scope.worktreeId, tabsFile);
    return { tabsFile, updated };
  },
);
const mockChatStateCommand = jest.fn<
  Promise<DesktopSharedTypesModule.ChatCommandResult>,
  [envelope: unknown]
>((envelope: unknown): Promise<DesktopSharedTypesModule.ChatCommandResult> => {
  void envelope;
  return Promise.resolve({
    commandId: 'test',
    revision: 1,
    outcome: 'applied',
  });
});
const mockGetCompatibilityTabs = jest.fn(
  (scope: { projectId: string; worktreeId: string }): Promise<ChatTabsFile> =>
    mockReadChatTabsFile(scope.projectId, scope.worktreeId),
);
const mockConsumeTranscript = jest.fn(
  async (
    _scope: unknown,
    _chatId: string,
    _fullOutputs: boolean,
    consume: (
      messages: AsyncIterable<PersistedChatMessage>,
    ) => Promise<unknown>,
  ): Promise<unknown> =>
    consume(
      (async function* (): AsyncGenerator<PersistedChatMessage> {
        await Promise.resolve();
        yield {
          id: 'canonical',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'resume this task' }],
        };
      })(),
    ),
);
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    claimRetainedTerminalAgentInputForNative: (
      request: DesktopSharedTypesModule.ChatSendMessageRequest,
    ): Promise<DesktopSharedTypesModule.ChatSendMessageRequest> =>
      Promise.resolve(request),
    restoreRetainedTerminalAgentInputAfterFailedNativeAdmission:
      (): Promise<void> => Promise.resolve(),
    // No worktree Git setup is pending in these sends; the hold submits now.
    holdLocalSendForWorktreeSetup: (
      request: DesktopSharedTypesModule.ChatSendMessageRequest,
      userMessage: () => unknown,
      submit: () => Promise<void>,
    ): Promise<'dispatch-now'> =>
      mockHoldLocalSendForWorktreeSetup(request, userMessage, submit),
    get answerPendingQuestion() {
      return mockAnswerPendingQuestion;
    },
    get command() {
      return mockChatStateCommand;
    },
    commitTurnOverrideModelFor: (): Promise<void> => Promise.resolve(),
    get consumeTranscript() {
      return mockConsumeTranscript;
    },
    get ensureChatForTrustedSend() {
      return mockEnsureChatForTrustedSend;
    },
    get editRetainedTerminalAgentInput() {
      return mockEditRetainedTerminalAgentInput;
    },
    get getCompatibilityTabs() {
      return mockGetCompatibilityTabs;
    },
    get getState() {
      return mockGetChatState;
    },
    get hasMutation() {
      return mockHasMutation;
    },
    holdRuntimeHost: (): (() => void) => (): void => undefined,
    // Main's auto-archiver (CAN-6014) subscribes when the handlers register.
    onTurnStateCommitted: (): (() => void) => (): void => undefined,
    subscribe: (): (() => void) => (): void => undefined,
    get ingestProviderEvent() {
      return mockIngestProviderEvent;
    },
    get ingestProviderEventWithOutcome() {
      return mockIngestProviderEventWithOutcome;
    },
    get ingestProviderEventWithResult() {
      return mockIngestProviderEventWithResult;
    },
    inputDelivery: {
      steerGenerated: () => Promise.resolve({ status: 'fallback' as const }),
      stop: async (
        _target: unknown,
        operation: () => Promise<void>,
      ): Promise<void> => operation(),
    },
    get reconcileHostQueue() {
      return mockReconcileHostQueue;
    },
    get replaceCompatibilityTabs() {
      return mockReplaceCompatibilityTabs;
    },
    get updateCompatibilityTab() {
      return mockUpdateCompatibilityTab;
    },
    get runWithScopeActivity() {
      return mockRunWithScopeActivity;
    },
  }),
}));

// Typed so specs can inspect the transition input without `any`.
const mockMaterializeCodexCapabilityTransition = jest.fn<
  ReturnType<
    typeof CodexCapabilityTransitionModule.materializeCodexCapabilityTransition
  >,
  Parameters<
    typeof CodexCapabilityTransitionModule.materializeCodexCapabilityTransition
  >
>();
jest.mock('../codex/capability-transition', () => ({
  materializeCodexCapabilityTransition: (
    ...args: Parameters<
      typeof CodexCapabilityTransitionModule.materializeCodexCapabilityTransition
    >
  ): ReturnType<
    typeof CodexCapabilityTransitionModule.materializeCodexCapabilityTransition
  > => mockMaterializeCodexCapabilityTransition(...args),
}));

const mockDispatchAppAdvisorChatMessage = jest.fn<
  Promise<void>,
  [unknown, unknown]
>(() => Promise.resolve());

jest.mock('../app-advisor/chat-service', () => ({
  dispatchAppAdvisorChatMessage: (...args: [unknown, unknown]): Promise<void> =>
    mockDispatchAppAdvisorChatMessage(...args),
}));

const mockDispatchPipelineEditorChatMessage = jest.fn<
  Promise<void>,
  [unknown, unknown]
>(() => Promise.resolve());

jest.mock('../pipeline-editor/chat-service', () => ({
  dispatchPipelineEditorChatMessage: (
    ...args: [unknown, unknown]
  ): Promise<void> => mockDispatchPipelineEditorChatMessage(...args),
}));

const mockClaudeTerminalGetState = jest.fn();
const mockClaudeTerminalCleanup = jest.fn();
const mockClaudeTerminalUpdateDeferredToolsContext = jest.fn();
const mockClaudeTerminalSetPlanMode = jest.fn();
const mockClaudeTerminalSetApprovalMode = jest.fn();

jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: jest.fn(() => ({
    get getState() {
      return mockClaudeTerminalGetState;
    },
    get cleanup() {
      return mockClaudeTerminalCleanup;
    },
    get updateDeferredToolsContext() {
      return mockClaudeTerminalUpdateDeferredToolsContext;
    },
    get setPlanMode() {
      return mockClaudeTerminalSetPlanMode;
    },
    get setApprovalMode() {
      return mockClaudeTerminalSetApprovalMode;
    },
  })),
}));

import type { BrowserWindow } from 'electron';
import type { AgentSession } from '../agents/types';
import type {
  ChatStateSnapshot,
  PersistedChatMessage,
  ChatTabsFile,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type { ObservabilityService } from '../observability/service';
import type {
  ProviderEventIngestOutcome,
  ProviderEventIngestResult,
  ProviderEventInput,
} from '../services/chat-state-service';
import {
  DEFAULT_HIDE_ANTHROPIC_NAV,
  IPC_CHANNELS,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import {
  getOrCreateSession,
  sessionHasActiveTurnOrNativeWork,
  chatHasNativeBackgroundWork,
  shouldRecreateSessionOnNextTurn,
} from '../agents/session-manager';
import {
  doesBranchMatchWorktreeId,
  isBranchPromptSent,
} from '../lib/resolve-worktree';
import { recordWorktreeDiscovery } from '../lib/worktree-repair';
import { generateAndRenameBranch } from '../lib/branch-namer';
import { readPreferencesFile } from '../lib/preferences-store';
import { clearUsageLimitedChat } from '../lib/usage-limited-chats-registry';
import { sendToWindow, sendToWindowDetailed } from '../lib/window-send';
import { readPersistedChatDispatchMetadata } from '../lib/chat-tabs-reader';
import { getChatQueueService } from '../services/chat-queue-service';
import type * as AuthPreflightModule from '../lib/auth-preflight';
import { registerChatHandlers } from '../ipc/chat';
import { backgroundHelperQueueTestExports } from '../lib/background-helper-queue';
import { getStoppedTurnResumeService } from '../services/stopped-turn-resume-service';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedGetOrCreateSession = jest.mocked(getOrCreateSession);
const mockedSessionHasActiveTurnOrNativeWork = jest.mocked(
  sessionHasActiveTurnOrNativeWork,
);
const mockedChatHasNativeBackgroundWork = jest.mocked(
  chatHasNativeBackgroundWork,
);
const mockedShouldRecreateSessionOnNextTurn = jest.mocked(
  shouldRecreateSessionOnNextTurn,
);
const mockedDoesBranchMatchWorktreeId = jest.mocked(doesBranchMatchWorktreeId);
const mockedIsBranchPromptSent = jest.mocked(isBranchPromptSent);
const mockedRecordWorktreeDiscovery = jest.mocked(recordWorktreeDiscovery);
const mockedGenerateAndRenameBranch = jest.mocked(generateAndRenameBranch);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedClearUsageLimitedChat = jest.mocked(clearUsageLimitedChat);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedSendToWindowDetailed = jest.mocked(sendToWindowDetailed);
const mockedReadPersistedChatDispatchMetadata = jest.mocked(
  readPersistedChatDispatchMetadata,
);
const ensureAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: false, focused: false }),
);
const openAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: true, focused: true }),
);
const closeAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: false, focused: false }),
);
const toggleAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: true, focused: true }),
);
const sendAppAdvisorWindowCommandMock = jest.fn();

initClaudeModels([
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]);
initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
initOllamaModels([
  {
    id: 'ollama-qwen3-coder',
    rawModelId: 'qwen3-coder',
    label: 'qwen3-coder',
    show: {
      capabilities: ['completion', 'tools'],
    },
  },
]);

function makePreferences(
  overrides: Partial<PreferencesData> = {},
): PreferencesData {
  // A partial fixture: the tests rely on unset preferences staying undefined,
  // so the full type is applied at this one boundary.
  const preferences: Partial<PreferencesData> = {
    worktreePanelPercent: 32,
    activityPanelExpanded: false,
    activityPanelWidthPercent: 25,
    kanbanWorktreePanelPercent: 32,
    kanbanActivityPanelExpanded: false,
    kanbanActivityPanelWidthPercent: 25,
    kanbanChatPanelVisible: false,
    sidebarCollapsed: false,
    branchNamePrefixMode: 'none',
    branchNameCustomPrefix: '',
    deleteBranchOnArchive: true,
    archiveOnMerge: true,
    defaultChatProvider: 'claude',
    defaultChatModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      ollama: null,
    },
    defaultWorktreeProvider: 'claude',
    defaultWorktreeModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      ollama: null,
    },
    summaryModel: 'claude-sonnet-4-6',
    summaryThinkingLevel: 'high',
    handoffSummaryModel: 'claude-haiku-4-5-20251001',
    handoffSummaryThinkingLevel: 'off',
    worktreeSummaryEnabled: true,
    worktreeSummaryModel: 'claude-haiku-4-5-20251001',
    worktreeSummaryThinkingLevel: 'off',
    prGenerationModel: 'claude-sonnet-4-6',
    prGenerationThinkingLevel: 'high',
    prInstructions: '',
    prInstructionMode: 'append',
    commitGenerationModel: 'claude-sonnet-4-6',
    commitGenerationThinkingLevel: 'high',
    commitInstructions: '',
    commitInstructionMode: 'append',
    branchNamingModel: 'claude-haiku-4-5-20251001',
    branchNamingThinkingLevel: 'off',
    branchNamingInstructions: '',
    branchDisplayMappings: [],
    reviewCommitMessage: false,
    agentRebaseResolutionEnabled: false,
    agentRebaseResolutionModel: null,
    agentRebaseResolutionThinkingLevel: null,
    mergeQueueAgentHandling: 'when_hook_absent',
    rtkEnabled: true,
    scriptTimeoutMinutes: 5,
    codexAppServerIdleTimeoutMinutes: 10,
    maxActiveChatTurns: 10,
    maxActivePipelineExecutions: 5,
    memoryPressureGuardEnabled: false,
    memoryPressureWarningThresholdBytes: 2 * 1024 * 1024 * 1024,
    memoryPressureCriticalThresholdBytes: 4 * 1024 * 1024 * 1024,
    keepSystemAwakeWhileAgentsActive: true,
    codexMultiAgentWorktreeChatsEnabled: false,
    codexMultiAgentStandaloneChatsEnabled: false,
    codexMultiAgentPipelinesEnabled: false,
    lastOpenApp: '',
    disabledOpenApps: [],
    lastSelectedWorktreeProjectId: '',
    lastSelectedWorktreeId: '',
    executionDetailViewMode: 'list',
    worktreeViewMode: 'list',
    worktreeFilterHiddenWorkspaceIds: [],
    auditRetentionDays: 7,
    theme: 'default',
    colorMode: 'dark',
    uiScale: 100,
    windowBounds: null,
    windowMaximized: false,
    windowFullScreen: false,
    ollamaServerPort: 11534,
    mcpProxyPort: 37645,
    hideAnthropicNav: DEFAULT_HIDE_ANTHROPIC_NAV,
    lastActiveContext: null,
    fileAutoSave: false,
    inAppNotifications: {
      enabled: true,
      placement: 'bottom-right',
      categories: {
        chat: true,
        script: true,
        hook: true,
        gitCommit: true,
        gitPush: true,
        prCreate: true,
        pipeline: true,
        terminal: true,
        runComment: true,
        activation: true,
      },
    },
    terminalDrawerCollapsed: true,
    terminalDrawerHeight: 300,
    terminalDrawerActiveTabId: 'terminal',
    osNotifications: {
      enabled: false,
      skipWhenFocused: true,
      defaultSound: 'System',
      categories: {
        chat: true,
        script: true,
        hook: true,
        gitCommit: true,
        gitPush: true,
        prCreate: true,
        pipeline: true,
        terminal: true,
        runComment: true,
        activation: true,
      },
      categorySounds: {
        chat: 'Default',
        script: 'Default',
        hook: 'Default',
        gitCommit: 'Default',
        gitPush: 'Default',
        prCreate: 'Default',
        pipeline: 'Default',
        terminal: 'Default',
        runComment: 'Default',
        activation: 'Default',
      },
    },
    branchNamingPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    commitGenerationPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    prGenerationPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    worktreeSummaryPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    voiceDictationEnabled: true,
    mcpHttpAuthDefaultHandler: 'canopy',
    fileIndexing: {
      disabledBuiltinGlobIds: [],
      customGlobs: [],
    },
    autoDownloadUpdates: true,
    ...overrides,
    showDiagnosticsPill: overrides.showDiagnosticsPill ?? true,
  };
  return preferences as PreferencesData;
}

type HandlerFn = (...args: unknown[]) => unknown;

function getHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );

  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }

  const [, handler] = call;
  return (...args: unknown[]): unknown => {
    const result: unknown = Reflect.apply(handler, undefined, args);
    return result;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function makeMockSession(): AgentSession {
  return {
    sendMessage: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    setPlanMode: jest.fn().mockResolvedValue(undefined),
    setApprovalMode: jest.fn().mockResolvedValue(undefined),
    setCodexFastMode: jest.fn().mockResolvedValue(undefined),
    setCodexAppServerIdleTimeoutMinutes: jest.fn().mockResolvedValue(undefined),
    setRtkEnabled: jest.fn().mockResolvedValue(undefined),
    setThinkingLevel: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
  };
}

function makeWindowAccessors(
  getMainWindow: () => BrowserWindow | null = () => null,
): Parameters<typeof registerChatHandlers>[0] {
  return {
    getMainWindow,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: openAppAdvisorWindowMock,
    ensureAppAdvisorWindow: ensureAppAdvisorWindowMock,
    closeAppAdvisorWindow: closeAppAdvisorWindowMock,
    toggleAppAdvisorWindow: toggleAppAdvisorWindowMock,
    getAppAdvisorWindowState: () => ({ open: false, focused: false }),
    markAppAdvisorWindowRendererReady: () => ({ open: false, focused: false }),
    setAppAdvisorFloatingSize: () => ({ open: false, focused: false }),
    setAppAdvisorDock: () =>
      Promise.resolve({ state: { open: false, focused: false } }),
    sendAppAdvisorWindowCommand: sendAppAdvisorWindowCommandMock,
    sendChatWindowCommand: jest.fn(() => true),
    notifyStartupUnlocked: jest.fn(),
  };
}

beforeEach(() => {
  mockCheckWatcherIngress.mockReset().mockResolvedValue({ allowed: true });
  mockPrepareOrgMemory.mockReset().mockResolvedValue(null);
  mockPersistOrgMemoryUsedForChat.mockReset().mockResolvedValue(true);
  mockMemoryAckDelivered.mockReset();
  mockMemoryAckDropped.mockReset();
  mockedSessionHasActiveTurnOrNativeWork.mockReturnValue(false);
  mockedChatHasNativeBackgroundWork.mockReturnValue(false);
  getChatQueueService().resetForTests();
  getStoppedTurnResumeService().resetForTests();
});
afterEach(() => {
  getChatQueueService().resetForTests();
  getStoppedTurnResumeService().resetForTests();
});

describe('chat:send-message IPC qualification (CAN-5897)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getChatQueueService().resetForTests();
    backgroundHelperQueueTestExports.reset();
    mockedSendToWindow.mockReturnValue(true);
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    mockedReadPersistedChatDispatchMetadata.mockResolvedValue({});
    mockedDoesBranchMatchWorktreeId.mockResolvedValue({ matches: false });
    mockedIsBranchPromptSent.mockResolvedValue(true);
    mockedRecordWorktreeDiscovery.mockResolvedValue({
      status: 'recorded',
      worktree: null,
    });
    mockedGenerateAndRenameBranch.mockResolvedValue({});
    mockedReadPreferencesFile.mockResolvedValue(makePreferences());
    mockedClearUsageLimitedChat.mockResolvedValue(undefined);
    mockClaudeTerminalGetState.mockReturnValue(undefined);
    mockClaudeTerminalCleanup.mockResolvedValue(undefined);
    mockGetWorkspaceType.mockReturnValue(null);
    mockReadEffectiveWorkspaceConfig.mockResolvedValue({
      repos: [],
      sourceRepoPath: undefined,
    });
    mockedShouldRecreateSessionOnNextTurn.mockReturnValue(false);
    mockIngestProviderEvent.mockResolvedValue(true);
    mockIngestProviderEventWithOutcome.mockImplementation(
      ingestOutcomeFromCommit,
    );
    mockIngestProviderEventWithResult
      .mockReset()
      .mockImplementation(ingestResultFromOutcome);
    mockHasMutation.mockResolvedValue(false);
    mockedGetOrCreateSession.mockResolvedValue(makeMockSession());
    registerChatHandlers(makeWindowAccessors());
  });

  const send = {
    projectId: 'proj',
    worktreeId: 'worktree',
    chatId: 'chat',
    userMessageId: 'composer-message',
    text: 'Run the checks',
  };

  // CAN-5483: the hold decides before the host queue sees the send.
  it('a composer worktree send goes through the setup hold before the host queue, unchanged', async () => {
    const queue = getChatQueueService();
    const original = queue.submit.bind(queue);
    const submit = jest.spyOn(queue, 'submit');
    const order: string[] = [];
    mockHoldLocalSendForWorktreeSetup.mockImplementationOnce(
      async (_request, _userMessage, admit) => {
        order.push('hold');
        await admit();
        order.push('held send submitted');
        return 'dispatch-now';
      },
    );
    submit.mockImplementationOnce((...args) => {
      order.push('queue');
      return original(...args);
    });

    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, send),
    ).resolves.toMatchObject({ disposition: 'dispatched' });

    expect(order).toEqual(['hold', 'queue', 'held send submitted']);
    expect(mockHoldLocalSendForWorktreeSetup).toHaveBeenCalledTimes(1);
    expect(mockHoldLocalSendForWorktreeSetup.mock.calls[0]?.[0]).toMatchObject(
      send,
    );
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining(send),
      'desktop',
    );
  });

  it('a renderer cannot supply main-owned provenance', async () => {
    for (const field of ['agentSent', 'autoResume', 'resumesInterruptedTurn'])
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
          ...send,
          [field]: true,
        }),
      ).rejects.toThrow(
        `Untrusted chat input cannot contain the "${field}" field.`,
      );
    expect(mockHoldLocalSendForWorktreeSetup).not.toHaveBeenCalled();

    const submit = jest.spyOn(getChatQueueService(), 'submit');
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      ...send,
      admittedApproval: { approvalMode: 'bypass' },
    });
    for (const request of [
      mockHoldLocalSendForWorktreeSetup.mock.calls[0]?.[0],
      submit.mock.calls[0]?.[0],
    ]) {
      expect(request).toMatchObject(send);
      expect(request).not.toHaveProperty('admittedApproval');
    }
  });

  // CAN-5249: one execution per input id, so a redelivered send never
  // starts a second turn for a delayed terminal to settle against.
  it('an accepted user message answers already_accepted and dispatches nothing', async () => {
    mockHasMutation.mockImplementation((_scope, mutationId) =>
      Promise.resolve(mutationId === 'chat:composer-message:accepted'),
    );
    const submit = jest.spyOn(getChatQueueService(), 'submit');

    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, send),
    ).resolves.toEqual({ disposition: 'already_accepted' });
    expect(mockHoldLocalSendForWorktreeSetup).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
  });
});
