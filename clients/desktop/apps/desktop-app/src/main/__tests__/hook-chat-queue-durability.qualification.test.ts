import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  HookChatTabStartedEvent,
  FileReference,
  PersistedChatTab,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type * as SharedTypes from '@canopy/desktop-shared/types';
import type * as HookChatModule from '../lib/hook-chat';
import type * as RecoveryModule from '../lib/hook-recovery';
import type * as PlaceholderModule from '../lib/hook-chat-placeholders';
import type { OperationRecord } from '@canopy/protocol/canopy-core';
import type { HookQueueSavedEntry } from '@canopy/core-runtime/node/initiated-work';
import {
  createTestInitiatedWork,
  type TestInitiatedWork,
} from './helpers/initiated-work-runtime';
import { resolveHookForRun } from '../services/hooks-service';
import { readWorkspaceWorktreesDetailed } from '../lib/workspace-persistence';

const mockTrace: string[] = [];
const mockRemovedEvents: unknown[] = [];
const mockRemovalStatuses: Promise<OperationRecord['status']>[] = [];
const mockStartedEvents: HookChatTabStartedEvent[] = [];
const mockDispatches: Array<Record<string, unknown>> = [];
const mockCreatedTabs: PersistedChatTab[] = [];
const mockTerminalRequests: Array<{ chatId: string }> = [];
const mockActivityListeners = new Set<() => void>();
let mockActiveTargets = new Set<string>();
let mockRendererAvailable = true;
let mockPreferences: PreferencesData;
let mockFileReferences: FileReference[] | undefined;
const mockRemovedChatIds = new Set<string>();
const mockDeliveredWindows: unknown[] = [];
let mockDispatchError: Error | undefined;
let mockNativeAccepts = true;
let mockAdmissionError: Error | undefined;
let mockBeforePrepare: (() => Promise<void>) | undefined;
let mockBeforeAdmission: (() => Promise<void>) | undefined;
let mockBeforePersist: (() => Promise<void>) | undefined;
let mockRuntime: TestInitiatedWork;
const mockRevalidate = jest.fn<
  ReturnType<typeof RecoveryModule.revalidateQueuedHookWork>,
  Parameters<typeof RecoveryModule.revalidateQueuedHookWork>
>();
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): unknown => ({
    initiatedWork: mockRuntime.engine,
    hookChatClaims: mockRuntime.hookChatClaims,
    hookQueue: mockRuntime.hookQueue,
  }),
  getActiveDesktopRuntimeIfAccepting: (): unknown => ({
    initiatedWork: mockRuntime.engine,
  }),
}));
jest.mock('../lib/hook-recovery', () => ({
  revalidateQueuedHookWork: (
    ...args: Parameters<typeof RecoveryModule.revalidateQueuedHookWork>
  ): ReturnType<typeof RecoveryModule.revalidateQueuedHookWork> =>
    mockRevalidate(...args),
}));
jest.mock('../lib/hook-runner', () => ({ resumedHookRunBody: jest.fn() }));
jest.mock('../services/hooks-service', () => ({
  resolveHookForRun: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceWorktreesDetailed: jest.fn(() =>
    Promise.resolve({ authority: 'ok', worktrees: [] }),
  ),
  readWorkspaceWorktrees: (): Promise<unknown[]> => Promise.resolve([]),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: (
    _window: unknown,
    channel: string,
    payload: unknown,
  ): boolean => {
    if (!mockRendererAvailable) return false;
    if (channel === 'chat:hook-queue-removed') {
      mockRemovedEvents.push(payload);
      const removed = z.object({ queueId: z.string() }).parse(payload);
      mockRemovalStatuses.push(
        queueOperation(removed.queueId).then((operation) => operation.status),
      );
      return true;
    }
    const event = payload as HookChatTabStartedEvent;
    mockStartedEvents.push(event);
    mockDeliveredWindows.push(_window);
    mockTrace.push(
      `${channel} ${event.worktreeId} ${event.chatId} ${event.queuedMessage ? 'queued' : 'started'}`,
    );
    return true;
  },
}));
jest.mock('../lib/chat-tab-dispatch-utils', () => ({
  removePersistedChatTab: (args: { chatId: string }): Promise<void> => {
    mockTrace.push(`remove ${args.chatId}`);
    return Promise.resolve();
  },
  completePersistedChatTabTurn: (): Promise<void> => Promise.resolve(),
  emitChatDispatchFailure: (): Promise<void> => Promise.resolve(),
  commitProviderChatEvent: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../lib/worktree-chat-turn', () => ({
  dispatchWorktreeChatTurn: (
    args: Record<string, unknown> & { onTurnAccepted?: () => void },
  ): Promise<void> => {
    mockTrace.push(
      `dispatch ${String(args.worktreeId)} ${String(args.chatId)}`,
    );
    mockDispatches.push(args);
    if (mockDispatchError) return Promise.reject(mockDispatchError);
    if (mockNativeAccepts) args.onTurnAccepted?.();
    return Promise.resolve();
  },
}));
jest.mock('../services/chat-queue-service', () => ({
  runAdmittedDirectDispatch: async (
    _target: unknown,
    _userMessageId: string,
    run: (authorization: unknown) => Promise<boolean>,
  ): Promise<void> => {
    await mockBeforeAdmission?.();
    if (mockAdmissionError) {
      const error = mockAdmissionError;
      mockAdmissionError = undefined;
      throw error;
    }
    await run(undefined);
  },
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    createHookChat: async (
      scope: { worktreeId: string },
      tab: PersistedChatTab,
    ): Promise<string> => {
      await mockBeforePersist?.();
      mockCreatedTabs.push(tab);
      if (mockRemovedChatIds.has(tab.id)) return Promise.resolve('removed');
      mockTrace.push(`persist ${scope.worktreeId} ${tab.id} activate=false`);
      return Promise.resolve('created');
    },
    runWithScopeActivity: async <T>(
      _scope: unknown,
      operation: () => Promise<T>,
    ): Promise<T> => operation(),
  }),
}));
jest.mock('../services/active-chat-input', () => ({
  notifyCanonicalChatStarted: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../agents/session-manager', () => ({
  hasActiveChatTurnsForWorktree: (
    projectId: string,
    worktreeId: string,
  ): boolean => mockActiveTargets.has(`${projectId}/${worktreeId}`),
  subscribeChatSessionActivity: (listener: () => void): (() => void) => {
    mockActivityListeners.add(listener);
    return (): void => {
      mockActivityListeners.delete(listener);
    };
  },
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFileDetailed: async (): Promise<{
    preferences: PreferencesData;
    authority: 'ok';
  }> => {
    await mockBeforePrepare?.();
    return { preferences: mockPreferences, authority: 'ok' };
  },
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: (): Promise<PreferencesData> =>
    Promise.resolve(mockPreferences),
}));
jest.mock('../lib/approvals-persistence', () => ({
  readWorkspaceApprovals: (): Promise<unknown> =>
    Promise.resolve({ version: 1, rules: [] }),
}));
jest.mock('../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (): Promise<unknown> =>
    Promise.resolve({ rules: [] }),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<unknown> =>
    Promise.resolve({
      version: 1,
      items: [
        {
          id: 'p',
          name: 'Project',
          repoPath: '/tmp/project',
          color: '#000000',
          worktrees: [],
          collapsed: false,
          order: 0,
          type: 'single-repo',
        },
      ],
    }),
}));
jest.mock('../lib/configured-prompt-resolution', () => ({
  resolveConfiguredPrompt: (args: { prompt: string }): Promise<unknown> =>
    Promise.resolve({
      prompt: args.prompt,
      fileReferences: mockFileReferences,
    }),
}));
jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): unknown => ({
    launch: (request: { chatId: string }): Promise<unknown> => {
      mockTerminalRequests.push(request);
      mockTrace.push(`terminal ${request.chatId}`);
      return Promise.resolve({});
    },
  }),
}));
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({ isEnabled: (): boolean => true }),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({ completeChatTurn: jest.fn() }),
}));

function preferences(): PreferencesData {
  const base = {
    defaultWorktreeProvider: 'codex',
    defaultWorktreeModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'medium' },
      ollama: null,
    },
    approvalDefaults: { worktree: 'ask', cowork: 'ask', appAdvisor: 'ask' },
    defaultChatInterfaceMode: 'canopy',
    scriptTimeoutMinutes: 5,
  };
  return base as unknown as PreferencesData;
}

let replayPlaceholders: typeof PlaceholderModule.replayHookChatPlaceholders;
let dir: string;
let hookChat: typeof HookChatModule;

function loadChat(): void {
  mockActivityListeners.clear();
  jest.isolateModules(() => {
    const types = jest.requireActual<typeof SharedTypes>(
      '@canopy/desktop-shared/types',
    );
    types.initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet' }]);
    types.initCodexModels([
      { id: 'gpt-5.5', label: 'GPT 5.5' },
      { id: 'gpt-5.4', label: 'GPT 5.4' },
    ]);
    hookChat = jest.requireActual<typeof HookChatModule>('../lib/hook-chat');
    replayPlaceholders = jest.requireActual<typeof PlaceholderModule>(
      '../lib/hook-chat-placeholders',
    ).replayHookChatPlaceholders;
  });
  hookChat.registerHookChatQueueHost(() => null);
}
async function runIdentity(): Promise<HookChatModule.HookChatLaunchIdentity> {
  const run = await mockRuntime.operations.admit({
    kind: 'core.initiatedWork.run',
    status: 'running',
    origin: {
      kind: 'hook',
      sourceId: 'project:pr:create',
      context: {
        triggerName: 'pr:create',
        target: 'project',
        invocation: 'automatic',
        projectOwner: { kind: 'personal' },
      },
    },
    owner: { kind: 'principal', id: 'local' },
    scope: { workspaceId: 'p', worktreeId: 'w' },
  });
  return { operationId: run.operation.operationId, actionIndex: 0 };
}
function launch(
  identity: HookChatModule.HookChatLaunchIdentity,
): Promise<HookChatModule.HookChatLaunchResult> {
  return hookChat.launchHookChat({
    identity,
    projectId: 'p',
    worktreeId: 'w',
    action: { type: 'chat', prompt: 'Review', model: 'gpt-5.5' },
    prompt: 'Review',
    triggerName: 'pr:create',
    getWindow: () => null,
  });
}
async function queueOperation(queueId: string): Promise<OperationRecord> {
  const listed = await mockRuntime.operations.list({
    kinds: ['core.initiatedWork.queuedHookChat'],
    limit: 50,
  });
  const found = listed.items.find(
    (operation) => operation.receipt.idempotencyKey === queueId,
  );
  if (!found) throw new Error('Queue operation missing');
  return found;
}
/**
 * Waits for `check`, up to a deadline rather than a count of polls: each poll
 * reads the ledger, which takes far longer on a loaded CI shard. A stall
 * names what it waited for.
 */
async function until(
  check: () => boolean | Promise<boolean>,
  label = 'the hook queue',
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error(`Hook queue did not settle: waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
async function saved(
  queueId: string,
): Promise<Pick<HookQueueSavedEntry, 'revision' | 'payload'>> {
  const value: unknown = JSON.parse(
    await readFile(join(dir, 'hook-queue', `${queueId}.json`), 'utf8'),
  );
  return z.object({ revision: z.number(), payload: z.json() }).parse(value);
}
async function restart(): Promise<void> {
  mockRuntime.operations.close();
  mockRuntime = createTestInitiatedWork(dir);
  loadChat();
  await mockRuntime.operations.whenReconciled();
  await mockRuntime.hookQueue.sweep();
}
function clearActivity(): void {
  mockActiveTargets.clear();
  for (const listener of mockActivityListeners) listener();
}
async function finished(queueId: string): Promise<void> {
  await until(
    async () => (await queueOperation(queueId)).status === 'completed',
    `${queueId} to complete`,
  );
  await until(async () => {
    try {
      await access(join(dir, 'hook-queue', `${queueId}.json`));
      return false;
    } catch {
      return true;
    }
  }, `${queueId} to leave the queue folder`);
}
function queueId(identity: HookChatModule.HookChatLaunchIdentity): string {
  return `queued-hook-${identity.operationId}-${identity.actionIndex}`;
}
function chatId(identity: HookChatModule.HookChatLaunchIdentity): string {
  return `chat-hook-${identity.operationId}-${identity.actionIndex}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'hook-chat-durability-'));
  mockRuntime = createTestInitiatedWork(dir);
  mockTrace.length = 0;
  mockStartedEvents.length = 0;
  mockRemovedEvents.length = 0;
  mockRemovalStatuses.length = 0;
  mockDispatches.length = 0;
  mockCreatedTabs.length = 0;
  mockTerminalRequests.length = 0;
  mockRemovedChatIds.clear();
  mockDeliveredWindows.length = 0;
  mockActiveTargets = new Set(['p/w']);
  mockRendererAvailable = true;
  mockPreferences = preferences();
  mockFileReferences = undefined;
  mockNativeAccepts = true;
  mockDispatchError = undefined;
  mockAdmissionError = undefined;
  mockBeforePrepare = undefined;
  mockBeforeAdmission = undefined;
  mockBeforePersist = undefined;
  mockRevalidate.mockResolvedValue({
    status: 'valid',
    cwd: '/project',
    action: { type: 'chat', prompt: 'Review' },
    hook: {
      hookKey: 'project:pr:create',
      triggerName: 'pr:create',
      label: 'PR created',
      target: 'project',
      actions: [{ type: 'chat', prompt: 'Review' }],
    },
  });
  loadChat();
});
afterEach(() => {
  mockRuntime.operations.close();
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

it('never replays a placeholder for an admission that has not committed', async () => {
  const identity = await runIdentity();
  let rejectAdmission: (error: Error) => void = () => {
    throw new Error('Admission has not started');
  };
  const enqueue = jest
    .spyOn(mockRuntime.hookQueue, 'enqueue')
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAdmission = reject;
        }),
    );
  const launching = launch(identity);
  try {
    await until(() => enqueue.mock.calls.length === 1);
    replayPlaceholders(null);
    expect(mockStartedEvents).toHaveLength(0);
  } finally {
    rejectAdmission(new Error('Ledger unavailable'));
    await expect(launching).rejects.toThrow('Ledger unavailable');
  }
  replayPlaceholders(null);
  expect(mockStartedEvents).toHaveLength(0);
  expect(
    hookChat.hasQueuedHookChat({
      projectId: 'p',
      worktreeId: 'w',
      chatId: chatId(identity),
    }),
  ).toBe(false);
});

it.each([false, true])(
  'coalesces concurrent launches after the final durable queue lookup (delayed: %s)',
  async (delayed) => {
    const identity = await runIdentity();
    clearActivity();
    const enqueue = jest.spyOn(mockRuntime.hookQueue, 'enqueue');
    let results: HookChatModule.HookChatLaunchResult[];
    if (delayed) {
      const lookup = mockRuntime.hookQueue.lookup.bind(mockRuntime.hookQueue);
      let callCount = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest
        .spyOn(mockRuntime.hookQueue, 'lookup')
        .mockImplementation(async (...args) => {
          const call = ++callCount;
          const result = await lookup(...args);
          if (call === 2) await gate;
          return result;
        });
      const pending = launch(identity);
      await until(() => callCount === 2);
      const concurrent = launch(identity);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(callCount).toBe(2);
      release();
      results = await Promise.all([pending, concurrent]);
    } else results = await Promise.all([launch(identity), launch(identity)]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'already_started',
      'started',
    ]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(mockCreatedTabs).toHaveLength(1);
    expect(
      mockStartedEvents.filter((event) => event.queuedMessage),
    ).toHaveLength(0);
    expect(mockDispatches).toHaveLength(1);
  },
);

it('shares a failed admission and lets the identity retry after settlement', async () => {
  const identity = await runIdentity();
  const enqueue = jest
    .spyOn(mockRuntime.hookQueue, 'enqueue')
    .mockRejectedValueOnce(new Error('Admission unavailable'));
  const outcomes = await Promise.allSettled([
    launch(identity),
    launch(identity),
  ]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    'rejected',
    'rejected',
  ]);
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(mockStartedEvents).toHaveLength(0);
  expect(await launch(identity)).toMatchObject({ status: 'queued' });
  expect(enqueue).toHaveBeenCalledTimes(2);
  expect(await hookChat.cancelQueuedHookChat(queueId(identity))).toEqual({
    cancelled: true,
  });
});

it('starts a queued hook chat after a restart', async () => {
  mockFileReferences = [
    {
      displayPath: 'review.txt',
      absolutePath: '/project/review.txt',
      repoName: 'Project',
      kind: 'text',
      textStart: 7,
    },
  ];
  const identity = await runIdentity();
  expect(await launch(identity)).toMatchObject({
    status: 'queued',
    queueId: queueId(identity),
  });
  expect((await saved(queueId(identity))).payload).toMatchObject({
    fileReferences: mockFileReferences,
  });
  expect(JSON.stringify(await queueOperation(queueId(identity)))).not.toContain(
    '/project/review.txt',
  );
  await restart();
  clearActivity();
  await finished(queueId(identity));
  expect(mockTrace.filter((line) => line.startsWith('persist '))).toHaveLength(
    1,
  );
  expect(mockDispatches).toHaveLength(1);
  expect(mockDispatches[0]).toMatchObject({
    chatId: chatId(identity),
    fileReferences: mockFileReferences,
  });
  expect(await queueOperation(queueId(identity))).toMatchObject({
    status: 'completed',
    outcome: { kind: 'chat', result: 'started' },
  });
});
it('keeps all seven queued edits across a restart', async () => {
  const identity = await runIdentity();
  await launch(identity);
  const target = { projectId: 'p', worktreeId: 'w', chatId: chatId(identity) };
  await hookChat.updateQueuedHookChatModel({
    ...target,
    model: 'claude-sonnet-4-6',
  });
  expect(
    hookChat.updateQueuedHookChatInterfaceMode({
      ...target,
      interfaceMode: 'claude-code',
    }),
  ).toBe(true);
  hookChat.updateQueuedHookChatCodexFastMode({ ...target, enabled: true });
  await hookChat.updateQueuedHookChatModel({ ...target, model: 'gpt-5.4' });
  hookChat.updateQueuedHookChatThinkingLevel({ ...target, level: 'low' });
  hookChat.updateQueuedHookChatPlanMode({ ...target, enabled: true });
  hookChat.updateQueuedHookChatApprovalMode({ ...target, mode: 'auto' });
  const plugins = {
    collectionIds: ['collection'],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
  hookChat.updateQueuedHookChatPluginSelections({
    ...target,
    pluginSelections: plugins,
    deferredToolsAllowed: false,
  });
  await until(() =>
    saved(queueId(identity)).then(
      (entry) => entry.revision >= 9,
      () => false,
    ),
  );
  expect((await saved(queueId(identity))).payload).toMatchObject({
    model: 'gpt-5.4',
    interfaceMode: 'claude-code',
    retainedCodexSpeed: 'fast',
    planMode: true,
    approvalMode: 'auto',
    thinkingLevel: 'low',
    pluginSelections: plugins,
  });
  await restart();
  clearActivity();
  await finished(queueId(identity));
  expect(mockDispatches[0]).toMatchObject({
    model: 'gpt-5.4',
    planMode: true,
    approvalMode: 'auto',
    thinkingLevel: 'low',
    modelConfig: { speed: 'fast', fastMode: true, thinkingLevel: 'low' },
    pluginSelections: plugins,
    deferredToolsAllowed: false,
  });
  expect(mockCreatedTabs[0]).toMatchObject({ interfaceMode: 'claude-code' });
});
it('keeps recovered hook chats ahead of new ones on their worktree', async () => {
  const first = await runIdentity();
  const second = await runIdentity();
  await launch(first);
  await launch(second);
  const release = Promise.withResolvers<void>();
  mockRevalidate.mockImplementation(async () => {
    await release.promise;
    return {
      status: 'valid',
      cwd: '/project',
      action: { type: 'chat', prompt: 'Review' },
      hook: {
        hookKey: 'project:pr:create',
        triggerName: 'pr:create',
        label: 'PR created',
        target: 'project',
        actions: [{ type: 'chat', prompt: 'Review' }],
      },
    };
  });
  mockRuntime.operations.close();
  mockRuntime = createTestInitiatedWork(dir);
  loadChat();
  await mockRuntime.operations.ready();
  clearActivity();
  const third = await runIdentity();
  expect(await launch(third)).toMatchObject({ status: 'queued' });
  release.resolve();
  await mockRuntime.operations.whenReconciled();
  await finished(queueId(third));
  expect(mockDispatches.map((args) => args.chatId)).toEqual([
    chatId(first),
    chatId(second),
    chatId(third),
  ]);
});
it('returns removed for a cancelled identity after a restart', async () => {
  const identity = await runIdentity();
  await launch(identity);
  expect(await hookChat.cancelQueuedHookChat(queueId(identity))).toEqual({
    cancelled: true,
  });
  await restart();
  clearActivity();
  expect(await launch(identity)).toEqual({
    status: 'removed',
    chatId: chatId(identity),
  });
  expect(mockDispatches).toHaveLength(0);
});
it('keeps the entry queued when its cancel cannot be recorded', async () => {
  const identity = await runIdentity();
  await launch(identity);
  jest
    .spyOn(mockRuntime.hookQueue, 'finishCancelled')
    .mockRejectedValueOnce(new Error('Ledger unavailable'));
  await expect(
    hookChat.cancelQueuedHookChat(queueId(identity)),
  ).rejects.toThrow('Ledger unavailable');
  expect(
    hookChat.hasQueuedHookChat({
      projectId: 'p',
      worktreeId: 'w',
      chatId: chatId(identity),
    }),
  ).toBe(true);
  expect((await queueOperation(queueId(identity))).status).toBe('queued');
  clearActivity();
  await finished(queueId(identity));
  expect(mockDispatches).toHaveLength(1);
});
it.each([
  ['worktree is gone', 'This worktree no longer exists.'],
  [
    'hook action changed',
    "This hook's action changed, so the queued work was not run.",
  ],
  ['hook is now paused', 'This hook is paused.'],
])(
  'ends a recovered hook chat invalidated when its %s',
  async (_case, message) => {
    const identity = await runIdentity();
    await launch(identity);
    mockRevalidate.mockResolvedValue({ status: 'invalidated', message });
    await restart();
    clearActivity();
    expect(await queueOperation(queueId(identity))).toMatchObject({
      status: 'failed',
      error: { code: 'core.initiatedWork.hookQueue.invalidated', message },
    });
    expect(mockCreatedTabs).toHaveLength(0);
    expect(mockDispatches).toHaveLength(0);
  },
);
it.each([true, false])(
  'distinguishes an unavailable model from damaged saved data (model unavailable: %s)',
  async (unavailable) => {
    const identity = await runIdentity();
    await launch(identity);
    const savedEntry = await saved(queueId(identity));
    const payload = z.record(z.string(), z.json()).parse(savedEntry.payload);
    await mockRuntime.hookQueue.saveEdit({
      version: 1,
      kind: 'chat',
      queueId: queueId(identity),
      runOperationId: identity.operationId,
      actionIndex: identity.actionIndex,
      revision: 2,
      savedAt: new Date().toISOString(),
      payload: unavailable
        ? { ...payload, model: 'removed-model' }
        : { ...payload, prompt: 17 },
    });
    await restart();
    if (unavailable) expect(mockRevalidate).toHaveBeenCalled();
    else expect(mockRevalidate).not.toHaveBeenCalled();
    expect(await queueOperation(queueId(identity))).toMatchObject({
      status: 'failed',
      error: {
        code: unavailable
          ? 'core.initiatedWork.hookQueue.modelUnavailable'
          : 'core.initiatedWork.hookQueue.invalidated',
        message: unavailable
          ? "The queued hook chat's model is no longer available."
          : "This queued hook work's saved details could not be read, so it was not run.",
      },
    });
    clearActivity();
    expect(mockDispatches).toHaveLength(0);
  },
);

it.each([true, false])(
  'reconciles a hook chat that may have started with its start claim (claim: %s)',
  async (withClaim) => {
    const identity = await runIdentity();
    await launch(identity);
    const blocked = (): Promise<void> => new Promise(() => {});
    if (withClaim) mockBeforePersist = blocked;
    else mockBeforeAdmission = blocked;
    clearActivity();
    await until(async () => {
      if ((await queueOperation(queueId(identity))).status !== 'running')
        return false;
      return (
        !withClaim ||
        (await mockRuntime.hookChatClaims.lookup({
          runOperationId: identity.operationId,
          chatId: chatId(identity),
          userMessageId: `msg-hook-${identity.operationId}-0`,
          scope: { workspaceId: 'p', worktreeId: 'w' },
        })) !== null
      );
    }, 'the start to run and record its claim');
    mockActiveTargets.add('p/w');
    mockBeforePersist = undefined;
    mockBeforeAdmission = undefined;
    await restart();
    clearActivity();
    await finished(queueId(identity));
    expect(mockDispatches).toHaveLength(withClaim ? 0 : 1);
    expect(mockCreatedTabs).toHaveLength(withClaim ? 0 : 1);
    expect(
      (
        await mockRuntime.operations.list({
          kinds: ['core.initiatedWork.hookChat'],
          limit: 50,
        })
      ).items,
    ).toHaveLength(1);
  },
  // A launch, a restart that loads the hook chat module afresh, and three
  // ledger polls: about half a second on a quiet machine, and past Jest's
  // 5 s default on a loaded CI shard.
  20_000,
);
it('does not confirm a starting cancellation until its ledger write succeeds', async () => {
  const identity = await runIdentity();
  await launch(identity);
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const markStarting = mockRuntime.hookQueue.markStarting.bind(
    mockRuntime.hookQueue,
  );
  const mark = jest
    .spyOn(mockRuntime.hookQueue, 'markStarting')
    .mockImplementationOnce(async (id) => {
      const result = await markStarting(id);
      await blocked;
      return result;
    });
  clearActivity();
  await until(() => mark.mock.calls.length === 1);
  await until(
    async () => (await queueOperation(queueId(identity))).status === 'running',
  );
  const finish = jest
    .spyOn(mockRuntime.hookQueue, 'finishCancelled')
    .mockRejectedValue(new Error('Cancel write failed'));
  const cancelling = hookChat.cancelQueuedHookChat(queueId(identity));
  release();
  await expect(cancelling).rejects.toThrow('Cancel write failed');
  expect((await queueOperation(queueId(identity))).status).toBe('running');
  expect(mockDispatches).toHaveLength(0);
  finish.mockRestore();
  expect(await hookChat.cancelQueuedHookChat(queueId(identity))).toEqual({
    cancelled: true,
  });
  await restart();
  clearActivity();
  expect((await queueOperation(queueId(identity))).status).toBe('cancelled');
  expect(mockDispatches).toHaveLength(0);
});

it.each([true, false])(
  'keeps an entry cancellable when marking it running fails (force: %s)',
  async (force) => {
    const identity = await runIdentity();
    await launch(identity);
    const mark = jest
      .spyOn(mockRuntime.hookQueue, 'markStarting')
      .mockRejectedValueOnce(new Error('Writer unavailable'));
    if (force)
      await expect(
        hookChat.forceQueuedHookChat(queueId(identity)),
      ).rejects.toThrow('Writer unavailable');
    else {
      clearActivity();
      await until(() => mark.mock.calls.length > 0);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect((await queueOperation(queueId(identity))).status).toBe('queued');
    expect(
      hookChat.hasQueuedHookChat({
        projectId: 'p',
        worktreeId: 'w',
        chatId: chatId(identity),
      }),
    ).toBe(true);
    expect(await hookChat.cancelQueuedHookChat(queueId(identity))).toEqual({
      cancelled: true,
    });
    await restart();
    clearActivity();
    expect(mockDispatches).toHaveLength(0);
  },
);

it('retries a failed running transition on later activity ahead of newer work', async () => {
  const first = await runIdentity();
  await launch(first);
  const mark = jest
    .spyOn(mockRuntime.hookQueue, 'markStarting')
    .mockRejectedValueOnce(new Error('Writer unavailable'));
  clearActivity();
  await until(() => mark.mock.calls.length === 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = await runIdentity();
  await launch(second);
  expect(mark).toHaveBeenCalledTimes(1);
  clearActivity();
  await finished(queueId(first));
  await finished(queueId(second));
  expect(mockDispatches.map((request) => request.chatId)).toEqual([
    chatId(first),
    chatId(second),
  ]);
});

it('retains a core-cancelled placeholder until the terminal ledger write succeeds', async () => {
  const identity = await runIdentity();
  await launch(identity);
  const operation = await queueOperation(queueId(identity));
  const ledger = await mockRuntime.operations.ready();
  jest.spyOn(ledger, 'finish').mockImplementationOnce(() => {
    throw new Error('Terminal ledger write failed');
  });
  await expect(
    mockRuntime.operations.cancel(operation.operationId, {
      requestedBy: 'portal-client',
      reason: 'stop',
    }),
  ).rejects.toThrow('Terminal ledger write failed');
  expect(
    hookChat.hasQueuedHookChat({
      projectId: 'p',
      worktreeId: 'w',
      chatId: chatId(identity),
    }),
  ).toBe(true);
  expect(mockRemovedEvents).toHaveLength(0);
  clearActivity();
  expect(await hookChat.forceQueuedHookChat(queueId(identity))).toEqual({
    forced: false,
  });
  expect(await hookChat.cancelQueuedHookChat(queueId(identity))).toEqual({
    cancelled: true,
  });
  expect((await queueOperation(queueId(identity))).status).toBe('cancelled');
  expect(mockRemovedEvents).toHaveLength(1);
  clearActivity();
  expect(mockDispatches).toHaveLength(0);
});

it('cancels a waiting hook chat through core.operation.cancel', async () => {
  const identity = await runIdentity();
  await launch(identity);
  const operation = await queueOperation(queueId(identity));
  await mockRuntime.operations.cancel(operation.operationId, {
    requestedBy: 'portal-client',
    reason: 'stop',
  });
  expect(
    hookChat.hasQueuedHookChat({
      projectId: 'p',
      worktreeId: 'w',
      chatId: chatId(identity),
    }),
  ).toBe(false);
  expect((await queueOperation(queueId(identity))).status).toBe('cancelled');
  expect(mockRemovedEvents).toEqual([
    {
      projectId: 'p',
      worktreeId: 'w',
      chatId: chatId(identity),
      queueId: queueId(identity),
    },
  ]);
  expect(await Promise.all(mockRemovalStatuses)).toEqual(['cancelled']);
  clearActivity();
  expect(mockDispatches).toHaveLength(0);
});

describe('revalidateQueuedHookWork', () => {
  it('invalidates queued work whose worktree no longer exists', async () => {
    const identity = await runIdentity();
    await launch(identity);
    jest
      .mocked(readWorkspaceWorktreesDetailed)
      .mockResolvedValue({ authority: 'ok', worktrees: [] });
    const recovery = jest.requireActual<typeof RecoveryModule>(
      '../lib/hook-recovery',
    );
    expect(
      await recovery.revalidateQueuedHookWork(
        await queueOperation(queueId(identity)),
        0,
        'chat',
        new AbortController().signal,
      ),
    ).toEqual({
      status: 'invalidated',
      message: 'This worktree no longer exists.',
    });
  });
  it('invalidates queued work whose hook action changed', async () => {
    const identity = await runIdentity();
    await launch(identity);
    jest.mocked(readWorkspaceWorktreesDetailed).mockResolvedValue({
      authority: 'ok',
      worktrees: [
        { id: 'w', branchName: 'feature', createdAt: '2026-11-05T10:00:00Z' },
      ],
    });
    jest.mocked(resolveHookForRun).mockResolvedValue({
      hook: {
        hookKey: 'project:pr:create',
        triggerName: 'pr:create',
        label: 'PR created',
        target: 'project',
        actions: [{ type: 'command', command: 'notify' }],
      },
      cwd: '/project',
      workspaceId: 'p',
      repoStorageKey: 'project',
    });
    const recovery = jest.requireActual<typeof RecoveryModule>(
      '../lib/hook-recovery',
    );
    expect(
      await recovery.revalidateQueuedHookWork(
        await queueOperation(queueId(identity)),
        0,
        'chat',
        new AbortController().signal,
      ),
    ).toEqual({
      status: 'invalidated',
      message: "This hook's action changed, so the queued work was not run.",
    });
  });
});
