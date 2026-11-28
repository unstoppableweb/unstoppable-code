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

// The bridges this test marks as a one-window session's (CAN-7854), each
// with whether its pairing still holds.
const mockOneWindowSenders = new Map<number, () => boolean>();
jest.mock('../remote-control/host/bridge-window', () => ({
  ...jest.requireActual<object>('../remote-control/host/bridge-window'),
  remoteBridgeIsOneWindow: (sender?: { id?: number }): boolean =>
    typeof sender?.id === 'number' && mockOneWindowSenders.has(sender.id),
  remoteBridgeCommitGuard: (sender?: {
    id?: number;
  }): (() => boolean) | undefined => {
    if (typeof sender?.id !== 'number') return undefined;
    const senderId = sender.id;
    const record = mockOneWindowSenders.get(senderId);
    if (!record) return undefined;
    return () => mockOneWindowSenders.get(senderId) === record && record();
  },
}));
const mockAssertCoworkChatRootPresent = jest
  .fn<Promise<void>, [string, string]>()
  .mockResolvedValue(undefined);
jest.mock('../lib/cowork-folder-guard', () => ({
  ...jest.requireActual<object>('../lib/cowork-folder-guard'),
  assertCoworkChatRootPresent: (projectId: string, worktreeId: string) =>
    mockAssertCoworkChatRootPresent(projectId, worktreeId),
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
    notifyCanonicalChatStarted: (...args: unknown[]) =>
      mockNotifyCanonicalChatStarted(...args),
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
const mockNotifyCanonicalChatStarted = jest
  .fn<Promise<void>, unknown[]>()
  .mockResolvedValue(undefined);
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

const mockCaptureTurnStart = jest
  .fn<Promise<void>, [string, string, string]>()
  .mockResolvedValue(undefined);
const mockDiscardTurnStart = jest.fn<void, [string]>();
jest.mock('../lib/turn-diff-capture', () => ({
  captureTurnStart: (
    sessionKey: string,
    projectId: string,
    worktreeId: string,
  ) => mockCaptureTurnStart(sessionKey, projectId, worktreeId),
  discardTurnStart: (sessionKey: string) => mockDiscardTurnStart(sessionKey),
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
const mockCommitAutomationStartBanner = jest.fn().mockResolvedValue(undefined);
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
  [
    envelope: unknown,
    options?: DesktopSharedTypesModule.ChatCommandExecutionOptions,
  ]
>(
  (
    envelope: unknown,
    options?: DesktopSharedTypesModule.ChatCommandExecutionOptions,
  ): Promise<DesktopSharedTypesModule.ChatCommandResult> => {
    void envelope;
    void options;
    return Promise.resolve({
      commandId: 'test',
      revision: 1,
      outcome: 'applied',
    });
  },
);
const mockRetainTrustedTerminalInput = jest.fn<
  Promise<{ status: 'retained' | 'already-retained' }>,
  [unknown, unknown, (() => boolean) | undefined]
>(() => Promise.resolve({ status: 'retained' }));
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
    get commitAutomationStartBanner() {
      return mockCommitAutomationStartBanner;
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
    get retainTrustedTerminalInput() {
      return mockRetainTrustedTerminalInput;
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
    openAppAdvisorApprovalsSettings: jest.fn().mockResolvedValue(undefined),
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
    for (const field of [
      'agentSent',
      'autoResume',
      'resumesInterruptedTurn',
      // canopy#125 phase 02a: host-issued managed delegation delivery identity.
      'managedDelegationDeliveryId',
      'internalRow',
    ])
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

  it('refuses a remote chat:send-message once its pairing is revoked before dispatch (CAN-7877)', async () => {
    let paired = false;
    mockOneWindowSenders.set(77, () => paired);
    const submit = jest.spyOn(getChatQueueService(), 'submit');
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)({ sender: { id: 77 } }, send),
      ).rejects.toThrow(/no longer authorizes/i);
      expect(mockHoldLocalSendForWorktreeSetup).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(mockedGetOrCreateSession).not.toHaveBeenCalled();

      paired = true;
      mockHoldLocalSendForWorktreeSetup.mockImplementationOnce(
        async (_request, _userMessage, admit) => {
          paired = false;
          await admit();
          return 'dispatch-now';
        },
      );
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(
          { sender: { id: 77 } },
          { ...send, userMessageId: 'composer-revoked-during-setup' },
        ),
      ).rejects.toThrow(/no longer authorizes/i);
      expect(submit).not.toHaveBeenCalled();
      expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
    } finally {
      mockOneWindowSenders.delete(77);
    }
  });

  it('captures the pairing guard before the scope-check await so closing the bridge mid-check still rejects (CAN-7877)', async () => {
    mockOneWindowSenders.set(79, () => true);
    const submit = jest.spyOn(getChatQueueService(), 'submit');
    mockAssertCoworkChatRootPresent.mockImplementationOnce(() => {
      mockOneWindowSenders.delete(79);
      return Promise.resolve();
    });
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(
          { sender: { id: 79 } },
          {
            ...send,
            userMessageId: 'composer-bridge-closed-during-scope-check',
          },
        ),
      ).rejects.toThrow(/no longer authorizes/i);
      expect(mockHoldLocalSendForWorktreeSetup).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
    } finally {
      mockOneWindowSenders.delete(79);
    }
  });

  it('rejects caller-supplied forged or non-iterable consolidatedWatcherUserMessageIds on chat:send-message (CAN-7877)', async () => {
    mockOneWindowSenders.set(80, () => true);
    const submit = jest.spyOn(getChatQueueService(), 'submit');
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(
          { sender: { id: 80 } },
          {
            ...send,
            userMessageId: 'composer-forged-consolidation',
            consolidatedWatcherUserMessageIds: ['unrelated-local-input'],
          },
        ),
      ).rejects.toThrow(/consolidatedWatcherUserMessageIds/);
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(
          { sender: { id: 80 } },
          Object.assign({}, send, {
            userMessageId: 'composer-non-iterable-consolidation',
            consolidatedWatcherUserMessageIds: 123,
          }),
        ),
      ).rejects.toThrow(/consolidatedWatcherUserMessageIds/);
      expect(submit).not.toHaveBeenCalled();
      expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
    } finally {
      mockOneWindowSenders.delete(80);
    }
  });

  it('forwards the remote pairing guard through chat:queue-edit, cancel, force and edit-lock (CAN-7877)', async () => {
    let paired = true;
    mockOneWindowSenders.set(88, () => paired);
    const remoteEvent = { sender: { id: 88 } };
    const entry = {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      entryId: 'row-1',
    };
    try {
      mockChatStateCommand.mockClear();
      mockChatStateCommand.mockResolvedValue({
        commandId: 'cmd',
        revision: 1,
        outcome: 'applied',
        entityId: 'chat',
      });

      await getHandler(IPC_CHANNELS.chatQueueEdit)(remoteEvent, {
        ...entry,
        text: 'Updated',
      });
      await getHandler(IPC_CHANNELS.chatQueueCancel)(remoteEvent, entry);
      await getHandler(IPC_CHANNELS.chatQueueForce)(remoteEvent, entry);
      await getHandler(IPC_CHANNELS.chatQueueSetEditLock)(remoteEvent, {
        ...entry,
        locked: true,
      });

      expect(mockChatStateCommand).toHaveBeenCalledTimes(4);
      for (const call of mockChatStateCommand.mock.calls) {
        expect(call[1]?.canCommitSend?.()).toBe(true);
      }

      paired = false;
      for (const call of mockChatStateCommand.mock.calls) {
        expect(call[1]?.canCommitSend?.()).toBe(false);
      }
      mockChatStateCommand.mockClear();
      await expect(
        getHandler(IPC_CHANNELS.chatQueueEdit)(remoteEvent, {
          ...entry,
          text: 'Late edit',
        }),
      ).rejects.toThrow(/no longer authorizes/i);
      await expect(
        getHandler(IPC_CHANNELS.chatQueueCancel)(remoteEvent, entry),
      ).rejects.toThrow(/no longer authorizes/i);
      await expect(
        getHandler(IPC_CHANNELS.chatQueueForce)(remoteEvent, entry),
      ).rejects.toThrow(/no longer authorizes/i);
      await expect(
        getHandler(IPC_CHANNELS.chatQueueSetEditLock)(remoteEvent, {
          ...entry,
          locked: true,
        }),
      ).rejects.toThrow(/no longer authorizes/i);
      expect(mockChatStateCommand).not.toHaveBeenCalled();

      await getHandler(IPC_CHANNELS.chatQueueForce)(
        { sender: { id: 1 } },
        entry,
      );
      expect(mockChatStateCommand).toHaveBeenCalledTimes(1);
      expect(mockChatStateCommand.mock.calls[0]?.[1]).toBeUndefined();
    } finally {
      mockOneWindowSenders.delete(88);
    }
  });

  it('defers guarded portal prompt commits until provider handoff so revocations and parks leave zero committed prompt (CAN-7877)', async () => {
    const resolveWorktree = await import('../lib/resolve-worktree');
    const { sendWorktreeChatMessage } =
      await import('../services/chat-service');
    const resolveTargetSpy = jest
      .spyOn(resolveWorktree, 'resolveWorktreeTargetIds')
      .mockReturnValue({
        projectId: send.projectId,
        worktreeId: send.worktreeId,
      });
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: send.chatId,
      tabs: [
        {
          id: send.chatId,
          title: 'Chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          messages: [],
          kind: 'chat',
        },
      ],
    });
    try {
      // 1. Revocation right before session.sendMessage: neither compatibility tabs
      //    nor ingestProviderEvent ever wrote the user prompt.
      let paired1 = true;
      mockReplaceCompatibilityTabs.mockClear();
      mockIngestProviderEvent.mockClear();
      mockedGetOrCreateSession.mockImplementationOnce(() => {
        paired1 = false;
        return Promise.resolve(makeMockSession());
      });
      await expect(
        sendWorktreeChatMessage(
          {
            ...send,
            userMessageId: 'portal-revoked-before-send',
            text: 'Must never commit before handoff',
          },
          { getWindow: () => null, canCommit: () => paired1 },
        ),
      ).rejects.toThrow(/no longer authorizes/i);
      expect(
        mockIngestProviderEvent.mock.calls.filter(
          ([input]) =>
            input.mutationId ===
            `${send.chatId}:portal-revoked-before-send:user-prompt`,
        ),
      ).toHaveLength(0);
      for (const call of mockReplaceCompatibilityTabs.mock.calls) {
        const writtenTab = call[1]?.tabs.find((t) => t.id === send.chatId);
        expect(
          writtenTab?.messages.some(
            (m) => m.id === 'portal-revoked-before-send',
          ),
        ).toBe(false);
      }

      // 2. Guarded dispatch that exits with a parked ChatDispatchOutcomeError
      //    never commits an unaccepted prompt either.
      mockReplaceCompatibilityTabs.mockClear();
      mockIngestProviderEvent.mockClear();
      const { ChatDispatchOutcomeError } =
        await import('../services/chat-dispatch-authorization');
      mockedGetOrCreateSession.mockResolvedValueOnce({
        ...makeMockSession(),
        sendMessage: jest.fn(() => {
          throw new ChatDispatchOutcomeError({
            dispatchOwner: Symbol('test-parked'),
            operationEpoch: 1,
            kind: 'parked',
            blockedByTurnId: 'wake-turn-1',
            receiptGeneration: 1,
            promptCommitted: false,
          });
        }),
      });
      await sendWorktreeChatMessage(
        {
          ...send,
          userMessageId: 'portal-parked-before-handoff',
          text: 'Parked guarded send',
        },
        { getWindow: () => null, canCommit: () => true },
      );
      expect(
        mockIngestProviderEvent.mock.calls.filter(
          ([input]) =>
            input.mutationId ===
            `${send.chatId}:portal-parked-before-handoff:user-prompt`,
        ),
      ).toHaveLength(0);
      for (const call of mockReplaceCompatibilityTabs.mock.calls) {
        const writtenTab = call[1]?.tabs.find((t) => t.id === send.chatId);
        expect(
          writtenTab?.messages.some(
            (m) => m.id === 'portal-parked-before-handoff',
          ),
        ).toBe(false);
      }
    } finally {
      resolveTargetSpy.mockRestore();
    }
  });

  it('enforces the pairing guard on the managed-terminal send branch before terminal delivery (CAN-7877)', async () => {
    const resolveWorktree = await import('../lib/resolve-worktree');
    const claudeTuiChats = await import('../lib/claude-tui-chats');
    const { sendWorktreeChatMessage } =
      await import('../services/chat-service');
    const resolveTargetSpy = jest
      .spyOn(resolveWorktree, 'resolveWorktreeTargetIds')
      .mockReturnValue({
        projectId: send.projectId,
        worktreeId: send.worktreeId,
      });
    const tuiModeSpy = jest
      .spyOn(claudeTuiChats, 'getEffectiveClaudeChatInterfaceMode')
      .mockReturnValue('claude-code');
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: send.chatId,
      tabs: [
        {
          id: send.chatId,
          title: 'Terminal Chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          messages: [],
          kind: 'chat',
          interfaceMode: 'claude-code',
          trackedPlanImplementation: {
            planId: 'plan-1',
            revisionNumber: 1,
            userMessageId: 'terminal-revoked-before-deliver',
            startedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    });
    mockedSendToWindowDetailed.mockClear();
    let paired = true;
    const baseTabs = await mockReadChatTabsFile(
      send.projectId,
      send.worktreeId,
    );
    let reads = 0;
    mockReadChatTabsFile.mockImplementation(() => {
      reads += 1;
      // Revoke pairing right after the initial terminal-branch read so
      // sendWorktreeChatMessageNow's managed-terminal gate rejects before delivery.
      if (reads >= 1) paired = false;
      return Promise.resolve(baseTabs);
    });
    try {
      await expect(
        sendWorktreeChatMessage(
          {
            ...send,
            userMessageId: 'terminal-revoked-before-deliver',
            text: 'Must stop before managed-terminal delivery',
            interfaceMode: 'claude-code',
          },
          { getWindow: () => null, canCommit: () => paired },
        ),
      ).rejects.toThrow(/no longer authorizes/i);
      expect(reads).toBeGreaterThanOrEqual(1);
      expect(
        mockedSendToWindowDetailed.mock.calls.filter(
          (call) => call[1] === IPC_CHANNELS.claudeTerminalScheduledPrompt,
        ),
      ).toHaveLength(0);
    } finally {
      tuiModeSpy.mockRestore();
      resolveTargetSpy.mockRestore();
    }
  });

  it('defers notifyCanonicalChatStarted on guarded native sends until after provider handoff (CAN-7877)', async () => {
    mockNotifyCanonicalChatStarted.mockReset().mockResolvedValue(undefined);
    let paired = true;
    let sessionCreated = false;
    mockOneWindowSenders.set(81, () => paired);
    const sendMessage = jest.fn();
    mockedGetOrCreateSession.mockImplementationOnce(() => {
      sessionCreated = true;
      return Promise.resolve({
        ...makeMockSession(),
        sendMessage,
      });
    });
    let postSessionScopeCheckRan = false;
    mockAssertCoworkChatRootPresent.mockImplementation(() => {
      // Wait until getOrCreateSession has run inside worktree-chat-turn so the
      // revocation lands right between preparation and the pre-sendMessage fence.
      if (sessionCreated) {
        postSessionScopeCheckRan = true;
        paired = false;
      }
      return Promise.resolve();
    });
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(
          { sender: { id: 81 } },
          {
            ...send,
            userMessageId: 'native-revoked-before-fence',
            startsNewTrackedChat: true,
          },
        ),
      ).rejects.toThrow(/no longer authorizes/i);
      expect(sessionCreated).toBe(true);
      expect(postSessionScopeCheckRan).toBe(true);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(mockNotifyCanonicalChatStarted).not.toHaveBeenCalled();

      // When pairing stays valid through provider handoff, notifyCanonicalChatStarted
      // fires after session.sendMessage succeeds.
      paired = true;
      mockAssertCoworkChatRootPresent.mockResolvedValue(undefined);
      const order: string[] = [];
      const acceptedSendMessage = jest.fn(() => {
        order.push('sendMessage');
      });
      mockNotifyCanonicalChatStarted.mockImplementation(() => {
        order.push('notifyCanonicalChatStarted');
        return Promise.resolve();
      });
      mockedGetOrCreateSession.mockResolvedValueOnce({
        ...makeMockSession(),
        sendMessage: acceptedSendMessage,
      });
      await getHandler(IPC_CHANNELS.chatSendMessage)(
        { sender: { id: 81 } },
        {
          ...send,
          userMessageId: 'native-paired-handoff',
          startsNewTrackedChat: true,
        },
      );
      expect(order).toEqual(['sendMessage', 'notifyCanonicalChatStarted']);
    } finally {
      mockAssertCoworkChatRootPresent.mockResolvedValue(undefined);
      mockNotifyCanonicalChatStarted.mockReset().mockResolvedValue(undefined);
      mockOneWindowSenders.delete(81);
    }
  });

  it('keeps :accepted, blocks replay, and retries a failed deferred prompt commit across local, portal, and cowork guarded sends (CAN-7877)', async () => {
    const resolveWorktree = await import('../lib/resolve-worktree');
    const { sendWorktreeChatMessage } =
      await import('../services/chat-service');
    const resolveTargetSpy = jest
      .spyOn(resolveWorktree, 'resolveWorktreeTargetIds')
      .mockReturnValue({
        projectId: send.projectId,
        worktreeId: send.worktreeId,
      });
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: send.chatId,
      tabs: [
        {
          id: send.chatId,
          title: 'Chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          messages: [],
          kind: 'chat',
        },
      ],
    });
    const committedMutations = new Set<string>();
    mockHasMutation.mockImplementation((_scope, mutationId) =>
      Promise.resolve(committedMutations.has(mutationId)),
    );
    mockOneWindowSenders.set(82, () => true);
    try {
      // 1. Guarded local send: first prompt commit fails transiently, :accepted still commits,
      //    replay returns already_accepted without calling sendMessage again, and the next provider event retries the prompt.
      let localOnEvent: ((data: unknown) => void | Promise<void>) | undefined;
      const localSendMessage = jest.fn();
      mockedGetOrCreateSession.mockImplementationOnce((_opts, onEvent) => {
        localOnEvent = onEvent;
        return Promise.resolve({
          ...makeMockSession(),
          sendMessage: localSendMessage,
        });
      });
      let localPromptAttempts = 0;
      mockIngestProviderEvent.mockImplementation((input) => {
        if (
          input.mutationId === `${send.chatId}:local-staged-retry:user-prompt`
        ) {
          localPromptAttempts += 1;
          if (localPromptAttempts === 1) {
            return Promise.reject(new Error('transient sqlite busy'));
          }
        }
        if (input.mutationId) committedMutations.add(input.mutationId);
        return Promise.resolve(true);
      });
      mockIngestProviderEventWithResult.mockClear();
      await getHandler(IPC_CHANNELS.chatSendMessage)(
        { sender: { id: 82 } },
        { ...send, userMessageId: 'local-staged-retry' },
      );
      expect(localSendMessage).toHaveBeenCalledTimes(1);
      expect(localPromptAttempts).toBe(1);
      expect(
        committedMutations.has(`${send.chatId}:local-staged-retry:accepted`),
      ).toBe(true);
      expect(
        committedMutations.has(`${send.chatId}:local-staged-retry:user-prompt`),
      ).toBe(false);
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(
          { sender: { id: 82 } },
          { ...send, userMessageId: 'local-staged-retry' },
        ),
      ).resolves.toEqual({ disposition: 'already_accepted' });
      expect(localSendMessage).toHaveBeenCalledTimes(1);
      expect(localOnEvent).toBeDefined();
      await localOnEvent?.({
        type: 'assistant',
        message: {
          id: 'local-assistant-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Delivered after retry' }],
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(localPromptAttempts).toBe(2);
      expect(
        committedMutations.has(`${send.chatId}:local-staged-retry:user-prompt`),
      ).toBe(true);
      expect(mockIngestProviderEventWithResult).toHaveBeenCalled();

      // 2. Guarded portal send: same guarantee for :accepted, replay dedupe, and prompt retry.
      getChatQueueService().resetForTests();
      let portalOnEvent: ((data: unknown) => void | Promise<void>) | undefined;
      const portalSendMessage = jest.fn();
      mockedGetOrCreateSession.mockImplementationOnce((_opts, onEvent) => {
        portalOnEvent = onEvent;
        return Promise.resolve({
          ...makeMockSession(),
          sendMessage: portalSendMessage,
        });
      });
      let portalPromptAttempts = 0;
      mockIngestProviderEvent.mockImplementation((input) => {
        if (
          input.mutationId === `${send.chatId}:portal-staged-retry:user-prompt`
        ) {
          portalPromptAttempts += 1;
          if (portalPromptAttempts === 1) {
            return Promise.reject(new Error('transient portal sqlite busy'));
          }
        }
        if (input.mutationId) committedMutations.add(input.mutationId);
        return Promise.resolve(true);
      });
      mockIngestProviderEventWithResult.mockClear();
      await sendWorktreeChatMessage(
        {
          ...send,
          userMessageId: 'portal-staged-retry',
          text: 'Portal retry test',
        },
        { getWindow: () => null, canCommit: () => true },
      );
      expect(portalSendMessage).toHaveBeenCalledTimes(1);
      expect(portalPromptAttempts).toBe(1);
      expect(
        committedMutations.has(`${send.chatId}:portal-staged-retry:accepted`),
      ).toBe(true);
      expect(
        committedMutations.has(
          `${send.chatId}:portal-staged-retry:user-prompt`,
        ),
      ).toBe(false);
      getChatQueueService().resetForTests();
      await expect(
        sendWorktreeChatMessage(
          {
            ...send,
            userMessageId: 'portal-staged-retry',
            text: 'Portal retry test',
          },
          { getWindow: () => null, canCommit: () => true },
        ),
      ).resolves.toEqual({ ok: true, chatId: send.chatId });
      expect(portalSendMessage).toHaveBeenCalledTimes(1);
      expect(portalOnEvent).toBeDefined();
      await portalOnEvent?.({
        type: 'assistant',
        message: {
          id: 'portal-assistant-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Portal delivered after retry' }],
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(portalPromptAttempts).toBe(2);
      expect(
        committedMutations.has(
          `${send.chatId}:portal-staged-retry:user-prompt`,
        ),
      ).toBe(true);
      expect(mockIngestProviderEventWithResult).toHaveBeenCalled();

      // 3. Guarded cowork/native send in ipc/chat.ts: failed deferred prompt write after
      //    turnRun.accepted() does not fail the IPC or ack org memory as send_failed, still
      //    commits :accepted, blocks replay, and retries on the next provider event.
      getChatQueueService().resetForTests();
      mockMemoryAckDelivered.mockClear();
      mockMemoryAckDropped.mockClear();
      mockPrepareOrgMemory.mockResolvedValueOnce({
        attempt: {
          result: {
            organizationExternalId: 'org-1',
            searchId: 'search-1',
            block: '<org-memory/>',
            facts: [
              {
                id: 'fact-1',
                title: 'Fact',
                content: 'Remembered',
                source: 'org',
              },
            ],
          },
        },
      });
      let coworkOnEvent: ((data: unknown) => void | Promise<void>) | undefined;
      const coworkSendMessage = jest.fn();
      mockedGetOrCreateSession.mockImplementationOnce((_opts, onEvent) => {
        coworkOnEvent = onEvent;
        return Promise.resolve({
          ...makeMockSession(),
          sendMessage: coworkSendMessage,
        });
      });
      let coworkPromptAttempts = 0;
      mockIngestProviderEvent.mockImplementation((input) => {
        if (
          input.mutationId === `${send.chatId}:cowork-staged-retry:user-prompt`
        ) {
          coworkPromptAttempts += 1;
          if (coworkPromptAttempts === 1) {
            return Promise.reject(new Error('transient cowork sqlite busy'));
          }
        }
        if (input.mutationId) committedMutations.add(input.mutationId);
        return Promise.resolve(true);
      });
      mockIngestProviderEventWithResult.mockClear();
      const coworkSend = {
        ...send,
        projectId: 'cowork-default',
        userMessageId: 'cowork-staged-retry',
        text: 'Cowork retry test',
      };
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(
          { sender: { id: 82 } },
          coworkSend,
        ),
      ).resolves.toEqual({ disposition: 'dispatched' });
      expect(coworkSendMessage).toHaveBeenCalledTimes(1);
      expect(coworkPromptAttempts).toBe(1);
      expect(mockMemoryAckDropped).not.toHaveBeenCalled();
      expect(mockMemoryAckDelivered).toHaveBeenCalledWith('org-1', 'search-1');
      expect(
        committedMutations.has(`${send.chatId}:cowork-staged-retry:accepted`),
      ).toBe(true);
      expect(
        committedMutations.has(
          `${send.chatId}:cowork-staged-retry:user-prompt`,
        ),
      ).toBe(false);
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(
          { sender: { id: 82 } },
          coworkSend,
        ),
      ).resolves.toEqual({ disposition: 'already_accepted' });
      expect(coworkSendMessage).toHaveBeenCalledTimes(1);
      expect(coworkOnEvent).toBeDefined();
      await coworkOnEvent?.({
        type: 'assistant',
        message: {
          id: 'cowork-assistant-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Cowork delivered after retry' }],
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(coworkPromptAttempts).toBe(2);
      expect(
        committedMutations.has(
          `${send.chatId}:cowork-staged-retry:user-prompt`,
        ),
      ).toBe(true);
      expect(mockIngestProviderEventWithResult).toHaveBeenCalled();
    } finally {
      mockPrepareOrgMemory.mockResolvedValue(null);
      mockHasMutation.mockResolvedValue(false);
      mockIngestProviderEvent.mockResolvedValue(true);
      mockOneWindowSenders.delete(82);
      resolveTargetSpy.mockRestore();
    }
  });

  it('completes the audit turn and discards the diff baseline on pre-acceptance pairing-guard rejection (CAN-7877)', async () => {
    const resolveWorktree = await import('../lib/resolve-worktree');
    const { sendWorktreeChatMessage } =
      await import('../services/chat-service');
    const resolveTargetSpy = jest
      .spyOn(resolveWorktree, 'resolveWorktreeTargetIds')
      .mockReturnValue({
        projectId: send.projectId,
        worktreeId: send.worktreeId,
      });
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: send.chatId,
      tabs: [
        {
          id: send.chatId,
          title: 'Chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          messages: [],
          kind: 'chat',
        },
      ],
    });
    try {
      // 1. Revoked before the pre-send pairing guard (after startChatTurn and captureTurnStart).
      let pairedEarly = true;
      const sendMessageEarly = jest.fn();
      startChatTurnMock.mockClear();
      completeChatTurnMock.mockClear();
      mockCaptureTurnStart.mockClear();
      mockDiscardTurnStart.mockClear();
      mockedGetOrCreateSession.mockImplementationOnce(() => {
        pairedEarly = false;
        return Promise.resolve({
          ...makeMockSession(),
          sendMessage: sendMessageEarly,
        });
      });
      await expect(
        sendWorktreeChatMessage(
          {
            ...send,
            userMessageId: 'revoked-audit-cleanup-early',
            text: 'Revoked before pre-send guard',
          },
          { getWindow: () => null, canCommit: () => pairedEarly },
        ),
      ).rejects.toThrow(/no longer authorizes/i);
      expect(sendMessageEarly).not.toHaveBeenCalled();
      expect(startChatTurnMock).toHaveBeenCalledTimes(1);
      expect(completeChatTurnMock).toHaveBeenCalledTimes(1);
      expect(completeChatTurnMock).toHaveBeenCalledWith(
        send.projectId,
        send.worktreeId,
        send.chatId,
        'interrupted',
      );
      expect(mockCaptureTurnStart).toHaveBeenCalledTimes(1);
      const earlySessionKey = mockCaptureTurnStart.mock.calls[0]?.[0];
      expect(earlySessionKey).toBeDefined();
      expect(mockDiscardTurnStart).toHaveBeenCalledTimes(1);
      expect(mockDiscardTurnStart).toHaveBeenCalledWith(earlySessionKey);

      // 2. Revoked at the final pre-enqueue pairing guard (after assertCoworkChatRootPresent).
      let pairedLate = true;
      let sessionCreated = false;
      const sendMessageLate = jest.fn();
      startChatTurnMock.mockClear();
      completeChatTurnMock.mockClear();
      mockCaptureTurnStart.mockClear();
      mockDiscardTurnStart.mockClear();
      mockedGetOrCreateSession.mockImplementationOnce(() => {
        sessionCreated = true;
        return Promise.resolve({
          ...makeMockSession(),
          sendMessage: sendMessageLate,
        });
      });
      mockAssertCoworkChatRootPresent.mockImplementation(() => {
        if (sessionCreated) {
          pairedLate = false;
        }
        return Promise.resolve();
      });
      await expect(
        sendWorktreeChatMessage(
          {
            ...send,
            userMessageId: 'revoked-audit-cleanup-late',
            text: 'Revoked before final enqueue guard',
          },
          { getWindow: () => null, canCommit: () => pairedLate },
        ),
      ).rejects.toThrow(/no longer authorizes/i);
      expect(sendMessageLate).not.toHaveBeenCalled();
      expect(startChatTurnMock).toHaveBeenCalledTimes(1);
      expect(completeChatTurnMock).toHaveBeenCalledTimes(1);
      expect(completeChatTurnMock).toHaveBeenCalledWith(
        send.projectId,
        send.worktreeId,
        send.chatId,
        'interrupted',
      );
      expect(mockCaptureTurnStart).toHaveBeenCalledTimes(1);
      const lateSessionKey = mockCaptureTurnStart.mock.calls[0]?.[0];
      expect(lateSessionKey).toBeDefined();
      expect(mockDiscardTurnStart).toHaveBeenCalledTimes(1);
      expect(mockDiscardTurnStart).toHaveBeenCalledWith(lateSessionKey);
    } finally {
      mockAssertCoworkChatRootPresent.mockResolvedValue(undefined);
      resolveTargetSpy.mockRestore();
    }
  });

  it('commits the deferred local user prompt before provider output that arrives during post-handoff bookkeeping awaits (CAN-7877)', async () => {
    const rootMigrationNotice =
      await import('../lib/root-migration-chat-notice');
    let releaseDelivered: (() => void) | undefined;
    let deliveredStartedResolve: (() => void) | undefined;
    const deliveredStarted = new Promise<void>((resolve) => {
      deliveredStartedResolve = resolve;
    });
    const deliveredGate = new Promise<void>((resolve) => {
      releaseDelivered = resolve;
    });
    const migrationSpy = jest
      .spyOn(rootMigrationNotice, 'prepareRootMigrationChatNotice')
      .mockResolvedValueOnce({
        text: 'Root migration notice',
        delivered: () => {
          deliveredStartedResolve?.();
          return deliveredGate;
        },
      });
    let capturedOnEvent: ((data: unknown) => void | Promise<void>) | undefined;
    const sendMessage = jest.fn();
    mockedGetOrCreateSession.mockImplementationOnce((_opts, onEvent) => {
      capturedOnEvent = onEvent;
      return Promise.resolve({
        ...makeMockSession(),
        sendMessage,
      });
    });
    const order: string[] = [];
    mockIngestProviderEvent.mockImplementation((input) => {
      if (input.mutationId === `${send.chatId}:staged-order-race:user-prompt`) {
        order.push('user-prompt');
      }
      return Promise.resolve(true);
    });
    mockIngestProviderEventWithResult.mockImplementation((input) => {
      if (input.mutationId?.includes(':provider:')) {
        order.push('provider-event');
      }
      return ingestResultFromOutcome(input);
    });
    mockOneWindowSenders.set(84, () => true);
    try {
      const sendPromise = getHandler(IPC_CHANNELS.chatSendMessage)(
        { sender: { id: 84 } },
        {
          ...send,
          userMessageId: 'staged-order-race',
          text: 'Must precede fast provider output',
        },
      );
      await deliveredStarted;
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(capturedOnEvent).toBeDefined();
      void capturedOnEvent?.({
        type: 'assistant',
        message: {
          id: 'fast-assistant-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Fast reply during await' }],
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual(['user-prompt', 'provider-event']);
      releaseDelivered?.();
      await expect(sendPromise).resolves.toEqual({ disposition: 'dispatched' });
    } finally {
      releaseDelivered?.();
      migrationSpy.mockRestore();
      mockIngestProviderEvent.mockResolvedValue(true);
      mockIngestProviderEventWithResult.mockImplementation(
        ingestResultFromOutcome,
      );
      mockOneWindowSenders.delete(84);
    }
  });

  it('opens no cowork audit turn on pre-acceptance pairing-guard rejection (CAN-7877)', async () => {
    let paired = true;
    let sessionCreated = false;
    const coworkSendMessage = jest.fn();
    startChatTurnMock.mockClear();
    completeChatTurnMock.mockClear();
    mockedGetOrCreateSession.mockImplementationOnce(() => {
      sessionCreated = true;
      return Promise.resolve({
        ...makeMockSession(),
        sendMessage: coworkSendMessage,
      });
    });
    mockAssertCoworkChatRootPresent.mockImplementation(() => {
      if (sessionCreated) {
        paired = false;
      }
      return Promise.resolve();
    });
    mockOneWindowSenders.set(85, () => paired);
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(
          { sender: { id: 85 } },
          {
            ...send,
            projectId: 'cowork-default',
            userMessageId: 'cowork-revoked-audit-cleanup',
            text: 'Revoked cowork send',
          },
        ),
      ).rejects.toThrow(/no longer authorizes/i);
      expect(coworkSendMessage).not.toHaveBeenCalled();
      expect(startChatTurnMock).not.toHaveBeenCalled();
      expect(completeChatTurnMock).not.toHaveBeenCalled();
    } finally {
      mockAssertCoworkChatRootPresent.mockResolvedValue(undefined);
      mockOneWindowSenders.delete(85);
    }
  });

  it('rejects a revoked guarded send instead of parking it into the queue when a concurrent wake starts (CAN-7877)', async () => {
    const chatTurnOwnership = await import('../services/chat-turn-ownership');
    const sessionEventRouter = await import('../agents/session-event-router');
    const { initialChatTurnState, reduceChatTurn, serializeChatTurnState } =
      await import('@canopy/agent-transcript/turn');
    const queue = getChatQueueService();
    const scope = {
      projectId: send.projectId,
      worktreeId: send.worktreeId,
      chatId: send.chatId,
    };
    const idleTurnState = serializeChatTurnState(initialChatTurnState());
    let currentTurnState = idleTurnState;
    let emitTurnStateChange:
      | ((change: {
          scope: typeof scope;
          state: typeof idleTurnState;
          effects: readonly [];
          generation: number;
          cause: 'lifecycle';
        }) => void)
      | undefined;
    let generation = 0;
    const emitConcurrentWake = (turnId: string): void => {
      const started = reduceChatTurn(initialChatTurnState(), {
        version: 1,
        provider: 'claude',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
        sequence: generation + 1,
        eventId: `evt-${turnId}`,
        observedAtMs: Date.now(),
        type: 'TurnStarted',
        phase: 'start',
        startedAtMs: Date.now(),
        turnId,
        origin: 'autonomous',
        binding: 'unbound',
        submissionIds: [],
        userMessageIds: [],
        providerUserMessageUuids: [],
      });
      currentTurnState = serializeChatTurnState(started.state);
      generation += 1;
      emitTurnStateChange?.({
        scope,
        state: currentTurnState,
        effects: [],
        generation,
        cause: 'lifecycle',
      });
    };
    const ownership = chatTurnOwnership.getChatTurnOwnership();
    const unbindOwnership = ownership.bind(
      {
        getTurnState: () => currentTurnState,
        onTurnStateChange: (listener) => {
          emitTurnStateChange = listener;
          return () => {
            if (emitTurnStateChange === listener) {
              emitTurnStateChange = undefined;
            }
          };
        },
        onTurnStateCommitted: () => () => undefined,
      },
      () => Promise.resolve(currentTurnState),
    );
    const actualParkBehindWake = sessionEventRouter.parkBehindWake;
    const parkBehindWakeSpy = jest.spyOn(sessionEventRouter, 'parkBehindWake');
    try {
      // 1. Revoked during preparation when parkedEarly triggers on a reused session.
      currentTurnState = idleTurnState;
      await ownership.hydrate(scope);
      ownership.markBackgroundFresh(scope);
      let pairedEarly = true;
      const sendMessageEarly = jest.fn();
      const reusedEarlySession = {
        ...makeMockSession(),
        sendMessage: sendMessageEarly,
      };
      queue.resetForTests();
      startChatTurnMock.mockClear();
      completeChatTurnMock.mockClear();
      mockDiscardTurnStart.mockClear();
      parkBehindWakeSpy.mockClear();
      const liveEarlySpy = jest
        .spyOn(sessionEventRouter, 'getLiveRoutedSession')
        .mockReturnValue(reusedEarlySession);
      mockedGetOrCreateSession.mockImplementationOnce(() => {
        emitConcurrentWake('wake-turn-early');
        pairedEarly = false;
        return Promise.resolve(reusedEarlySession);
      });
      mockOneWindowSenders.set(86, () => pairedEarly);
      try {
        await expect(
          getHandler(IPC_CHANNELS.chatSendMessage)(
            { sender: { id: 86 } },
            {
              ...send,
              userMessageId: 'revoked-concurrent-wake-early',
              text: 'Must reject instead of parking early',
            },
          ),
        ).rejects.toThrow(/no longer authorizes/i);
        expect(startChatTurnMock).not.toHaveBeenCalled();
        expect(parkBehindWakeSpy).not.toHaveBeenCalled();
        expect(sendMessageEarly).not.toHaveBeenCalled();
        expect(
          queue.holdsUserMessage(scope, 'revoked-concurrent-wake-early'),
        ).toBe(false);
        expect(
          queue.getWorktreeSnapshots(send.projectId, send.worktreeId),
        ).toEqual([]);
      } finally {
        liveEarlySpy.mockRestore();
        mockOneWindowSenders.delete(86);
      }

      // 2. Revoked after startChatTurn/captureTurnStart when the late parked check triggers.
      ownership.resetScope(scope);
      currentTurnState = idleTurnState;
      await ownership.hydrate(scope);
      ownership.markBackgroundFresh(scope);
      let pairedLate = true;
      const sendMessageLate = jest.fn();
      const reusedLateSession = {
        ...makeMockSession(),
        sendMessage: sendMessageLate,
      };
      queue.resetForTests();
      startChatTurnMock.mockClear();
      completeChatTurnMock.mockClear();
      mockCaptureTurnStart.mockClear();
      mockDiscardTurnStart.mockClear();
      parkBehindWakeSpy.mockClear();
      const liveLateSpy = jest
        .spyOn(sessionEventRouter, 'getLiveRoutedSession')
        .mockReturnValue(reusedLateSession);
      mockedGetOrCreateSession.mockImplementationOnce(() =>
        Promise.resolve(reusedLateSession),
      );
      mockCaptureTurnStart.mockImplementationOnce(() => {
        emitConcurrentWake('wake-turn-late');
        pairedLate = false;
        return Promise.resolve();
      });
      mockOneWindowSenders.set(87, () => pairedLate);
      try {
        await expect(
          getHandler(IPC_CHANNELS.chatSendMessage)(
            { sender: { id: 87 } },
            {
              ...send,
              userMessageId: 'revoked-concurrent-wake-late',
              text: 'Must reject instead of parking late',
            },
          ),
        ).rejects.toThrow(/no longer authorizes/i);
        expect(parkBehindWakeSpy).not.toHaveBeenCalled();
        expect(sendMessageLate).not.toHaveBeenCalled();
        expect(startChatTurnMock).toHaveBeenCalledTimes(1);
        expect(completeChatTurnMock).toHaveBeenCalledTimes(1);
        expect(completeChatTurnMock).toHaveBeenCalledWith(
          send.projectId,
          send.worktreeId,
          send.chatId,
          'interrupted',
        );
        expect(mockDiscardTurnStart).toHaveBeenCalledTimes(1);
        expect(
          queue.holdsUserMessage(scope, 'revoked-concurrent-wake-late'),
        ).toBe(false);
        expect(
          queue.getWorktreeSnapshots(send.projectId, send.worktreeId),
        ).toEqual([]);
      } finally {
        liveLateSpy.mockRestore();
        mockOneWindowSenders.delete(87);
      }

      // 3. Revoked mid-parkBehindWake (during discardPendingTurnRoute) still rejects instead of parking.
      ownership.resetScope(scope);
      currentTurnState = idleTurnState;
      await ownership.hydrate(scope);
      ownership.markBackgroundFresh(scope);
      let pairedMidPark = true;
      const sendMessageMidPark = jest.fn();
      const reusedMidParkSession = {
        ...makeMockSession(),
        sendMessage: sendMessageMidPark,
      };
      queue.resetForTests();
      startChatTurnMock.mockClear();
      completeChatTurnMock.mockClear();
      mockDiscardTurnStart.mockClear();
      parkBehindWakeSpy.mockClear();
      parkBehindWakeSpy.mockImplementationOnce((target, parked) => {
        pairedMidPark = false;
        return actualParkBehindWake(target, parked);
      });
      const liveMidParkSpy = jest
        .spyOn(sessionEventRouter, 'getLiveRoutedSession')
        .mockReturnValue(reusedMidParkSession);
      mockedGetOrCreateSession.mockImplementationOnce(() => {
        emitConcurrentWake('wake-turn-mid-park');
        return Promise.resolve(reusedMidParkSession);
      });
      mockOneWindowSenders.set(88, () => pairedMidPark);
      try {
        await expect(
          getHandler(IPC_CHANNELS.chatSendMessage)(
            { sender: { id: 88 } },
            {
              ...send,
              userMessageId: 'revoked-concurrent-wake-mid-park',
              text: 'Must reject if revoked while parking',
            },
          ),
        ).rejects.toThrow(/no longer authorizes/i);
        expect(parkBehindWakeSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageMidPark).not.toHaveBeenCalled();
        expect(
          queue.holdsUserMessage(scope, 'revoked-concurrent-wake-mid-park'),
        ).toBe(false);
        expect(
          queue.getWorktreeSnapshots(send.projectId, send.worktreeId),
        ).toEqual([]);
      } finally {
        liveMidParkSpy.mockRestore();
        mockOneWindowSenders.delete(88);
      }
    } finally {
      parkBehindWakeSpy.mockRestore();
      unbindOwnership();
      ownership.resetScopesForTests();
    }
  });

  it('discards the pending provider route when a guarded send is rejected for revocation after route registration (CAN-8007)', async () => {
    const chatTurnOwnership = await import('../services/chat-turn-ownership');
    const sessionEventRouter = await import('../agents/session-event-router');
    const { initialChatTurnState, serializeChatTurnState } =
      await import('@canopy/agent-transcript/turn');
    const { pendingRouteCount } =
      sessionEventRouter.sessionEventRouterTestExports;
    const queue = getChatQueueService();
    const scope = {
      projectId: send.projectId,
      worktreeId: send.worktreeId,
      chatId: send.chatId,
    };
    // Bound turn ownership issues the dispatch owner that registers a
    // pending provider route for the attempt.
    const idleTurnState = serializeChatTurnState(initialChatTurnState());
    const ownership = chatTurnOwnership.getChatTurnOwnership();
    const unbindOwnership = ownership.bind(
      {
        getTurnState: () => idleTurnState,
        onTurnStateChange: () => () => undefined,
        onTurnStateCommitted: () => () => undefined,
      },
      () => Promise.resolve(idleTurnState),
    );
    await ownership.hydrate(scope);
    ownership.markBackgroundFresh(scope);
    const routesBefore = pendingRouteCount();
    try {
      // 1. Revoked after route registration, before the pre-send pairing check.
      let pairedEarly = true;
      const sendMessageEarly = jest.fn();
      let routesAtRevocationEarly = 0;
      queue.resetForTests();
      mockedGetOrCreateSession.mockImplementationOnce(() =>
        Promise.resolve({
          ...makeMockSession(),
          sendMessage: sendMessageEarly,
        }),
      );
      mockCaptureTurnStart.mockImplementationOnce(() => {
        routesAtRevocationEarly = pendingRouteCount();
        pairedEarly = false;
        return Promise.resolve();
      });
      mockOneWindowSenders.set(91, () => pairedEarly);
      try {
        await expect(
          getHandler(IPC_CHANNELS.chatSendMessage)(
            { sender: { id: 91 } },
            {
              ...send,
              userMessageId: 'revoked-pending-route-early',
              text: 'Revoked after route registration',
            },
          ),
        ).rejects.toThrow(/no longer authorizes/i);
        expect(routesAtRevocationEarly).toBe(routesBefore + 1);
        expect(sendMessageEarly).not.toHaveBeenCalled();
        expect(pendingRouteCount()).toBe(routesBefore);
        expect(
          queue.holdsUserMessage(scope, 'revoked-pending-route-early'),
        ).toBe(false);
      } finally {
        mockOneWindowSenders.delete(91);
      }

      // 2. Revoked at the final check before the provider send.
      let pairedLate = true;
      let sessionCreated = false;
      const sendMessageLate = jest.fn();
      queue.resetForTests();
      mockedGetOrCreateSession.mockImplementationOnce(() => {
        sessionCreated = true;
        return Promise.resolve({
          ...makeMockSession(),
          sendMessage: sendMessageLate,
        });
      });
      mockAssertCoworkChatRootPresent.mockImplementation(() => {
        if (sessionCreated) pairedLate = false;
        return Promise.resolve();
      });
      mockOneWindowSenders.set(92, () => pairedLate);
      try {
        await expect(
          getHandler(IPC_CHANNELS.chatSendMessage)(
            { sender: { id: 92 } },
            {
              ...send,
              userMessageId: 'revoked-pending-route-late',
              text: 'Revoked at the final send check',
            },
          ),
        ).rejects.toThrow(/no longer authorizes/i);
        expect(sendMessageLate).not.toHaveBeenCalled();
        expect(pendingRouteCount()).toBe(routesBefore);
        expect(
          queue.holdsUserMessage(scope, 'revoked-pending-route-late'),
        ).toBe(false);
      } finally {
        mockOneWindowSenders.delete(92);
        mockAssertCoworkChatRootPresent.mockReset();
        mockAssertCoworkChatRootPresent.mockResolvedValue(undefined);
      }
    } finally {
      unbindOwnership();
      ownership.resetScopesForTests();
    }
  });

  it('defers automation start banner until provider handoff on guarded sends and persists nothing when revoked between tab commit and handoff (CAN-7877)', async () => {
    const resolveWorktree = await import('../lib/resolve-worktree');
    const { sendWorktreeChatMessage } =
      await import('../services/chat-service');
    const resolveTargetSpy = jest
      .spyOn(resolveWorktree, 'resolveWorktreeTargetIds')
      .mockReturnValue({
        projectId: send.projectId,
        worktreeId: send.worktreeId,
      });
    try {
      // 1. Worktree guarded send revoked between ensureChatForTrustedSend and handoff.
      let pairedWorktree = true;
      const sendMessageWorktree = jest.fn();
      mockCommitAutomationStartBanner.mockClear();
      mockIngestProviderEvent.mockClear();
      mockedGetOrCreateSession.mockImplementationOnce(() => {
        pairedWorktree = false;
        return Promise.resolve({
          ...makeMockSession(),
          sendMessage: sendMessageWorktree,
        });
      });
      mockOneWindowSenders.set(89, () => pairedWorktree);
      try {
        await expect(
          getHandler(IPC_CHANNELS.chatSendMessage)(
            { sender: { id: 89 } },
            {
              ...send,
              userMessageId: 'auto-worktree-revoked',
              text: 'Revoked automation worktree send',
              initiationSource: 'automation',
              automationName: 'Nightly audit',
            },
          ),
        ).rejects.toThrow(/no longer authorizes/i);
        expect(sendMessageWorktree).not.toHaveBeenCalled();
        expect(mockCommitAutomationStartBanner).not.toHaveBeenCalled();
        expect(
          mockIngestProviderEvent.mock.calls.filter(
            ([input]) =>
              input.mutationId ===
              `${send.chatId}:auto-worktree-revoked:user-prompt`,
          ),
        ).toHaveLength(0);
      } finally {
        mockOneWindowSenders.delete(89);
      }

      // 2. Cowork guarded send revoked between ensureChatForTrustedSend and handoff.
      let pairedCowork = true;
      const sendMessageCowork = jest.fn();
      mockCommitAutomationStartBanner.mockClear();
      mockIngestProviderEvent.mockClear();
      mockedGetOrCreateSession.mockImplementationOnce(() => {
        pairedCowork = false;
        return Promise.resolve({
          ...makeMockSession(),
          sendMessage: sendMessageCowork,
        });
      });
      mockOneWindowSenders.set(90, () => pairedCowork);
      try {
        await expect(
          getHandler(IPC_CHANNELS.chatSendMessage)(
            { sender: { id: 90 } },
            {
              ...send,
              projectId: 'cowork-default',
              userMessageId: 'auto-cowork-revoked',
              text: 'Revoked automation cowork send',
              initiationSource: 'automation',
              automationName: 'Nightly audit',
            },
          ),
        ).rejects.toThrow(/no longer authorizes/i);
        expect(sendMessageCowork).not.toHaveBeenCalled();
        expect(mockCommitAutomationStartBanner).not.toHaveBeenCalled();
        expect(
          mockIngestProviderEvent.mock.calls.filter(
            ([input]) =>
              input.mutationId ===
              `${send.chatId}:auto-cowork-revoked:user-prompt`,
          ),
        ).toHaveLength(0);
      } finally {
        mockOneWindowSenders.delete(90);
      }

      // 3. Portal guarded send revoked between compatibility tab write and handoff.
      let pairedPortal = true;
      const sendMessagePortal = jest.fn();
      mockReplaceCompatibilityTabs.mockClear();
      mockCommitAutomationStartBanner.mockClear();
      mockIngestProviderEvent.mockClear();
      mockedGetOrCreateSession.mockImplementationOnce(() => {
        pairedPortal = false;
        return Promise.resolve({
          ...makeMockSession(),
          sendMessage: sendMessagePortal,
        });
      });
      await expect(
        sendWorktreeChatMessage(
          {
            ...send,
            chatId: 'auto-portal-new-chat',
            userMessageId: 'auto-portal-revoked',
            text: 'Revoked automation portal send',
            initiationSource: 'automation',
            automationName: 'Nightly audit',
          },
          { getWindow: () => null, canCommit: () => pairedPortal },
        ),
      ).rejects.toThrow(/no longer authorizes/i);
      expect(sendMessagePortal).not.toHaveBeenCalled();
      expect(mockCommitAutomationStartBanner).not.toHaveBeenCalled();
      for (const call of mockReplaceCompatibilityTabs.mock.calls) {
        const writtenTab = call[1]?.tabs.find(
          (t) => t.id === 'auto-portal-new-chat',
        );
        expect(writtenTab?.messages ?? []).toEqual([]);
      }
      expect(
        mockIngestProviderEvent.mock.calls.filter(
          ([input]) =>
            input.mutationId ===
            'auto-portal-new-chat:auto-portal-revoked:user-prompt',
        ),
      ).toHaveLength(0);

      // 4. Authorized guarded send writes banner after handoff, right before prompt ingest.
      const order: string[] = [];
      const sendMessageAllowed = jest.fn(() => {
        order.push('provider-handoff');
      });
      mockCommitAutomationStartBanner.mockImplementationOnce(() => {
        order.push('automation-banner');
        return Promise.resolve();
      });
      mockIngestProviderEvent.mockImplementation((input) => {
        if (
          input.mutationId === `${send.chatId}:auto-worktree-ok:user-prompt`
        ) {
          order.push('user-prompt');
        }
        return Promise.resolve(true);
      });
      mockedGetOrCreateSession.mockResolvedValueOnce({
        ...makeMockSession(),
        sendMessage: sendMessageAllowed,
      });
      mockOneWindowSenders.set(91, () => true);
      try {
        await expect(
          getHandler(IPC_CHANNELS.chatSendMessage)(
            { sender: { id: 91 } },
            {
              ...send,
              userMessageId: 'auto-worktree-ok',
              text: 'Authorized automation worktree send',
              initiationSource: 'automation',
              automationName: 'Nightly audit',
            },
          ),
        ).resolves.toEqual({ disposition: 'dispatched' });
        expect(order).toEqual([
          'provider-handoff',
          'automation-banner',
          'user-prompt',
        ]);
      } finally {
        mockIngestProviderEvent.mockResolvedValue(true);
        mockOneWindowSenders.delete(91);
      }
    } finally {
      resolveTargetSpy.mockRestore();
    }
  });

  // CAN-7854: a turn its managed terminal drives runs outside the chat
  // queue, in a worktree or a Work Entry, so a one-window Stop could not
  // reach it. It is refused instead of answering that the turn is not
  // running.
  it.each([
    ['a worktree', 'proj'],
    ['a Work Entry', 'cowork-default'],
  ])(
    'a one-window Stop of a chat its terminal drives in %s is refused, not reported as not running',
    async (_where, projectId) => {
      mockClaudeTerminalGetState.mockReturnValue({ turnState: 'running' });
      mockOneWindowSenders.set(7, () => true);
      try {
        await expect(
          getHandler(IPC_CHANNELS.chatCancel)(
            { sender: { id: 7 } },
            {
              projectId,
              worktreeId: 'worktree',
              chatId: 'chat',
              expectedUserMessageId: 'terminal-turn',
            },
          ),
        ).rejects.toThrow(
          'This chat runs in a terminal on the other computer.',
        );
        // Read from the live terminals only: no chat storage is opened, so
        // a Stop for a deleted chat recreates nothing.
        expect(mockReadChatTabsFile).not.toHaveBeenCalled();
      } finally {
        mockOneWindowSenders.delete(7);
      }
    },
  );

  // CAN-7854: a Work Entry's exact Stop loads its chat state before it
  // checks the turn. A one-window Stop of a turn that is not running, as for
  // a deleted Work Entry, answers from live state and opens no storage.
  it('a one-window Stop of a Work Entry turn that is not running opens no chat storage', async () => {
    mockOneWindowSenders.set(7, () => true);
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatCancel)(
          { sender: { id: 7 } },
          {
            projectId: 'cowork-default',
            worktreeId: 'worktree',
            chatId: 'chat',
            expectedUserMessageId: 'gone-turn',
          },
        ),
      ).resolves.toEqual({ outcome: 'turn_not_active' });
      expect(mockGetChatState).not.toHaveBeenCalled();
      expect(mockReadChatTabsFile).not.toHaveBeenCalled();
    } finally {
      mockOneWindowSenders.delete(7);
    }
  });

  // CAN-7854: the terminal check awaits, so a pairing removed meanwhile
  // refuses the Stop.
  it('a one-window Stop whose pairing is removed during its terminal check stops nothing', async () => {
    mockOneWindowSenders.set(7, () => false);
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatCancel)(
          { sender: { id: 7 } },
          {
            projectId: 'proj',
            worktreeId: 'worktree',
            chatId: 'chat',
            expectedUserMessageId: 'running-turn',
          },
        ),
      ).rejects.toThrow('This session is no longer paired.');
      expect(mockReadChatTabsFile).not.toHaveBeenCalled();
    } finally {
      mockOneWindowSenders.delete(7);
    }
  });
});
