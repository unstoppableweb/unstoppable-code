/**
 * CAN-7254: Resume after a provider sign-in pause. The pause records each
 * interrupted chat with the turn it interrupted, so a queued Resume after a
 * manual Resume recognizes the accepted prompt and resolves as resumed without
 * sending again. Without the turn, the queued Resume fails and an
 * already-resumed chat is reported as failed. A session paused with only a
 * queued message has no turn to record (CAN-7339) and resumes as before.
 *
 * The manual Resume runs through handleResumeUsageLimitedSessions, the
 * `usage-limited-sessions:resume` handler
 * (IPC_CHANNELS.resumeUsageLimitedSessions), with the sign-in attempt, and the
 * resume queue through dispatchResumeQueueEntry.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatTabsFile,
  PersistedChatMessage,
  PersistedChatTab,
  ResumeQueueEntry,
  ResumeQueueSnapshot,
} from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import type { AgentSession } from '../agents/types';
import type * as SessionManagerModule from '../agents/session-manager';
import type * as ResumeModule from '../ipc/usage-limited-chats';
import type * as RegistryModule from '../lib/usage-limited-chats-registry';
import type * as QueueModule from '../services/resume-queue-service';
import type * as QueueStorageModule from '../services/resume-queue-storage';
import type { ChatStateServiceOptions } from '../services/chat-state-service';

interface SentResume {
  userMessageId: string;
  text: string;
}

const mockChat: { tab: PersistedChatTab | undefined; sent: SentResume[] } = {
  tab: undefined,
  sent: [],
};
let mockFailNextClear = false;

/** Overrides a few exports and reads every other one lazily, for import cycles. */
function mockPartially(
  path: string,
  overrides: Record<string, unknown>,
): object {
  return new Proxy(overrides, {
    get: (target, property): unknown =>
      typeof property === 'string' && property in target
        ? target[property]
        : jest.requireActual<Record<string | symbol, unknown>>(path)[property],
    has: (target, property): boolean =>
      property in target ||
      property in jest.requireActual<Record<string | symbol, unknown>>(path),
  });
}

jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: () => void; clear: () => void } => ({
    mark: (): void => undefined,
    clear: (): void => undefined,
  }),
}));

// The sign-in itself is the login manager's; the test only needs the attempt
// to be resumable.
jest.mock('../auth/codex-login', () =>
  mockPartially('../auth/codex-login', {
    codexLoginManager: {
      assertResumeAllowed: (): Promise<void> => Promise.resolve(),
    },
  }),
);

jest.mock('../lib/chat-tabs-reader', () =>
  mockPartially('../lib/chat-tabs-reader', {
    readChatTabsFile: (): Promise<ChatTabsFile> =>
      Promise.resolve({
        version: 1,
        tabs: mockChat.tab ? [mockChat.tab] : [],
        activeTabId: mockChat.tab?.id ?? '',
      }),
  }),
);

// Diagnostics only; its background writes would race the scratch root's removal.
jest.mock('../observability/ingest', () =>
  mockPartially('../observability/ingest', {
    getExecutionObservabilityIngest: (): object =>
      new Proxy({}, { get: (): (() => void) => (): void => undefined }),
  }),
);

jest.mock('../lib/chat-usage-limit-cleanup', () => ({
  capturePersistedUsageLimitBannerSnapshot: (): object => ({}),
  clearPersistedUsageLimitBanner: (): Promise<void> => Promise.resolve(),
}));

jest.mock('../services/chat-service', () =>
  mockPartially('../services/chat-service', {
    buildExistingTabDispatchOptions: (): Promise<object> => Promise.resolve({}),
    sendWorktreeChatMessage: (request: {
      chatId: string;
      text: string;
      userMessageId: string;
      autoResume?: PersistedChatMessage['autoResume'];
    }): Promise<{ ok: true; chatId: string }> => {
      const tab = mockChat.tab;
      if (!tab) throw new Error('No chat to send to.');
      mockChat.sent.push({
        userMessageId: request.userMessageId,
        text: request.text,
      });
      const anchor = request.autoResume?.resumesUserMessageId;
      mockChat.tab = {
        ...tab,
        messages: [
          ...tab.messages,
          {
            id: request.userMessageId,
            role: 'user',
            timestamp: Date.now(),
            userMessageSource: 'auto_resume',
            ...(request.autoResume ? { autoResume: request.autoResume } : {}),
            blocks: [{ type: 'text', text: request.text }],
          },
        ],
        lastAcceptedUserMessageId: request.userMessageId,
        interruptedTurns: anchor
          ? {
              ...tab.interruptedTurns,
              [anchor]: {
                ...tab.interruptedTurns?.[anchor],
                resumedBy: request.userMessageId,
              },
            }
          : tab.interruptedTurns,
      };
      return Promise.resolve({ ok: true, chatId: request.chatId });
    },
  }),
);

jest.mock('../lib/usage-limited-chats-registry', () => {
  const actual = jest.requireActual<typeof RegistryModule>(
    '../lib/usage-limited-chats-registry',
  );
  return {
    ...actual,
    clearAuthenticationInterruptedChat: (
      ...args: Parameters<typeof actual.clearAuthenticationInterruptedChat>
    ): Promise<void> => {
      if (mockFailNextClear) {
        mockFailNextClear = false;
        return Promise.reject(new Error('Registry cleanup failed.'));
      }
      return actual.clearAuthenticationInterruptedChat(...args);
    },
  };
});

jest.setTimeout(60_000);

const scope = { projectId: 'project', worktreeId: 'worktree' };
const target = { ...scope, chatId: 'chat-1' };
const attemptId = 'attempt-1';
let root: string;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'resume-after-sign-in-'));
  process.env.CANOPY_DATA_DIR = root;
  resetResolvedCanopyDataDirForTests();
  mockChat.sent = [];
  mockFailNextClear = false;
  mockChat.tab = {
    id: 'chat-1',
    title: 'Running chat',
    providerType: 'codex',
    lastAcceptedUserMessageId: 'user-1',
    interruptedTurns: { 'user-1': {} },
    messages: [
      {
        id: 'user-1',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Question' }],
      },
    ],
  } as unknown as PersistedChatTab;
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(root, { recursive: true, force: true });
});

interface App {
  sessions: typeof SessionManagerModule;
  resume: typeof ResumeModule;
  registry: typeof RegistryModule;
  queue: typeof QueueModule;
  queueStorage: typeof QueueStorageModule;
}

/** One app process with its own session, queue and registry module state. */
async function inProcess<T>(run: (app: App) => Promise<T>): Promise<T> {
  let outcome: { value: T } | undefined;
  await jest.isolateModulesAsync(async () => {
    outcome = {
      value: await run({
        sessions: await import('../agents/session-manager'),
        resume: await import('../ipc/usage-limited-chats'),
        registry: await import('../lib/usage-limited-chats-registry'),
        queue: await import('../services/resume-queue-service'),
        queueStorage: await import('../services/resume-queue-storage'),
      }),
    };
  });
  if (!outcome) throw new Error('The app process returned no result.');
  return outcome.value;
}

/** A Codex sign-in pause with chat-1's turn for user-1 running. */
async function pauseWithRunningTurn({ sessions }: App): Promise<void> {
  const key = sessions.buildSessionKey(
    scope.projectId,
    scope.worktreeId,
    'chat-1',
  );
  const session: Partial<AgentSession> = {
    isDisposed: (): boolean => false,
    destroy: (): Promise<void> => Promise.resolve(),
    setApprovalMode: (): Promise<void> => Promise.resolve(),
  };
  sessions.registerSession(
    key,
    session as AgentSession,
    new AbortController(),
    'codex',
    undefined,
    'default',
    'default',
    false,
    'codex',
  );
  sessions.markTurnActive(key, 'user-1');
  const { paused, release } =
    sessions.pauseCodexSessionsForAuthentication(attemptId);
  try {
    expect(await paused).toBe(1);
  } finally {
    release();
  }
}

/** The resume queue dispatching one interruption through the real service. */
async function queueResume(
  app: App,
  interruptionId: string,
): Promise<ResumeQueueEntry[]> {
  const storage = new app.queueStorage.ResumeQueueStorage(
    join(root, 'resume-queue.json'),
  );
  const service = new app.queue.ResumeQueueService({
    load: (): Promise<ResumeQueueSnapshot | null> => storage.load(),
    save: (next): Promise<void> => storage.save(next),
    dispatch: (entry: ResumeQueueEntry): Promise<'resumed' | 'skipped'> =>
      app.resume.dispatchResumeQueueEntry(entry, () => null),
    reconcile: (): Promise<{ status: 'waiting' }> =>
      Promise.resolve({ status: 'waiting' }),
    now: (): number => 1_000,
    changed: (): void => undefined,
  });
  await service.enqueue([
    {
      target: { kind: 'chat', ...target },
      title: 'Running chat',
      workspaceName: 'Workspace',
      interruptionId,
    },
  ]);
  await service.tick();
  return service.snapshot().entries;
}

it('CAN-7254 a sign-in pause records the interrupted turn', async () => {
  await inProcess(async (app) => {
    await pauseWithRunningTurn(app);
    expect(await app.registry.readUsageLimitedChats(true)).toEqual([
      expect.objectContaining({
        ...target,
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: attemptId,
        interruptedUserMessageId: 'user-1',
      }),
    ]);
  });
});

it('CAN-7254 a queued Resume after a manual sign-in Resume whose cleanup failed sends once and ends resumed, not failed', async () => {
  await inProcess(async (app) => {
    await pauseWithRunningTurn(app);
    const [paused] = await app.registry.readUsageLimitedChats(true);
    if (!paused) throw new Error('The sign-in pause recorded nothing.');

    mockFailNextClear = true;
    const manual = await app.resume.handleResumeUsageLimitedSessions(
      {
        targets: [{ kind: 'chat', ...target }],
        authenticationAttemptId: attemptId,
      },
      () => null,
    );
    expect(manual).toEqual(
      expect.objectContaining({ resumedCount: 1, failedTargets: [] }),
    );
    expect(mockChat.sent).toHaveLength(1);
    // The cleanup failed, so the sign-in entry remains.
    expect(await app.registry.readUsageLimitedChats(true)).toHaveLength(1);

    const storage = new app.queueStorage.ResumeQueueStorage(
      join(root, 'resume-queue.json'),
    );
    const service = new app.queue.ResumeQueueService({
      load: (): Promise<ResumeQueueSnapshot | null> => storage.load(),
      save: (next): Promise<void> => storage.save(next),
      dispatch: (entry: ResumeQueueEntry): Promise<'resumed' | 'skipped'> =>
        app.resume.dispatchResumeQueueEntry(entry, () => null),
      reconcile: (): Promise<{ status: 'waiting' }> =>
        Promise.resolve({ status: 'waiting' }),
      now: (): number => 1_000,
      changed: (): void => undefined,
    });
    await service.enqueue([
      {
        target: { kind: 'chat', ...target },
        title: 'Running chat',
        workspaceName: 'Workspace',
        interruptionId: String(paused.detectedAt),
      },
    ]);
    await service.tick();
    expect(service.snapshot().entries).toEqual([
      expect.objectContaining({
        interruptionId: String(paused.detectedAt),
        status: 'resumed',
      }),
    ]);
    expect(service.snapshot().entries[0]?.error).toBeUndefined();
    expect(mockChat.sent).toHaveLength(1);
    expect(await app.registry.readUsageLimitedChats(true)).toEqual([]);
  });
});

it('CAN-7254 a repeat manual sign-in Resume after a failed cleanup reconciles quietly without sending again', async () => {
  await inProcess(async (app) => {
    await pauseWithRunningTurn(app);
    mockFailNextClear = true;
    const request = {
      targets: [{ kind: 'chat' as const, ...target }],
      authenticationAttemptId: attemptId,
    };
    expect(
      await app.resume.handleResumeUsageLimitedSessions(request, () => null),
    ).toEqual(expect.objectContaining({ resumedCount: 1, failedTargets: [] }));
    expect(
      await app.resume.handleResumeUsageLimitedSessions(request, () => null),
    ).toEqual(expect.objectContaining({ failedTargets: [] }));
    expect(mockChat.sent).toHaveLength(1);
    expect(await app.registry.readUsageLimitedChats(true)).toEqual([]);
  });
});

it('CAN-7254 a sign-in Resume for a different attempt is refused as stale and sends nothing', async () => {
  await inProcess(async (app) => {
    await pauseWithRunningTurn(app);
    const before = await app.registry.readUsageLimitedChats(true);
    expect(
      await app.resume.handleResumeUsageLimitedSessions(
        {
          targets: [{ kind: 'chat', ...target }],
          authenticationAttemptId: 'attempt-2',
        },
        () => null,
      ),
    ).toEqual(
      expect.objectContaining({
        resumedCount: 0,
        staleCount: 1,
        failedTargets: [],
      }),
    );
    expect(mockChat.sent).toHaveLength(0);
    expect(await app.registry.readUsageLimitedChats(true)).toEqual(before);
  });
});

it('CAN-7254 a sign-in pause whose interrupted prompt was never accepted still resumes exactly once through the queue', async () => {
  // The interrupted prompt is persisted, but no turn ever accepted it, and no
  // resume prompt was sent before. The recorded turn must not let Resume treat
  // the chat as already resumed.
  mockChat.tab = {
    ...mockChat.tab,
    lastAcceptedUserMessageId: undefined,
    interruptedTurns: { 'user-1': {} },
    messages: [
      {
        id: 'user-1',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Question' }],
      },
    ],
  } as unknown as PersistedChatTab;
  await inProcess(async (app) => {
    await pauseWithRunningTurn(app);
    const [paused] = await app.registry.readUsageLimitedChats(true);
    if (!paused) throw new Error('The sign-in pause recorded nothing.');
    const entries = await queueResume(app, String(paused.detectedAt));
    expect(entries).toEqual([expect.objectContaining({ status: 'resumed' })]);
    expect(entries[0]?.error).toBeUndefined();
    expect(mockChat.sent).toHaveLength(1);
    expect(await app.registry.readUsageLimitedChats(true)).toEqual([]);
  });
});

/** Inert host callbacks: nothing dispatches, authorizes or launches. */
function inertHost(): Omit<ChatStateServiceOptions, 'repository'> {
  let ids = 0;
  return {
    now: (): number => 1_000,
    createId: (): string => `event-${(ids += 1)}`,
    dispatch: (): Promise<void> => Promise.resolve(),
    onInputPickup: (): Promise<void> => Promise.resolve(),
    authorizeSend: (): Promise<void> => Promise.resolve(),
    approvePlanReview: (): Promise<boolean> => Promise.resolve(true),
    withPlanReviewRevision: async <T>(
      _request: unknown,
      commit: () => Promise<T>,
    ): Promise<{ accepted: true; result: T }> => ({
      accepted: true,
      result: await commit(),
    }),
    cleanupSession: (): Promise<void> => Promise.resolve(),
    recordDiagnostic: (): void => undefined,
  };
}

/**
 * The worktree's chat store, already migrated: an earlier launch created
 * chat-1 in the canonical V2 store. An unmigrated store cannot load while
 * the worktree has live work, such as a queued message.
 */
async function migratedChatStore(): Promise<void> {
  await inProcess(async () => {
    const chatState = await import('../services/chat-state-service');
    const repositories = await import('../services/chat-state-v2-repository');
    const repository = new repositories.ChatStateV2Repository({
      enableFormat4: true,
    });
    const app = new chatState.ChatStateService({ repository, ...inertHost() });
    await app.command({
      schemaVersion: 1,
      commandId: 'create',
      ...scope,
      command: {
        type: 'chat.create_tab',
        tabId: 'chat-1',
        title: 'Running chat',
        providerType: 'codex',
        model: 'gpt-6-astra',
      },
    });
    await repository.drainAll();
  });
}

it('CAN-7339 a sign-in pause of a session with only a queued message records no turn, and the queue still resumes it once', async () => {
  // The prompt is queued: no turn has reached the provider, so nothing has
  // been accepted or interrupted.
  mockChat.tab = {
    ...mockChat.tab,
    lastAcceptedUserMessageId: undefined,
    interruptedTurns: undefined,
  } as unknown as PersistedChatTab;
  await migratedChatStore();
  await inProcess(async (app) => {
    const { sessions } = app;
    const key = sessions.buildSessionKey(
      scope.projectId,
      scope.worktreeId,
      'chat-1',
    );
    const session: Partial<AgentSession> = {
      isDisposed: (): boolean => false,
      destroy: (): Promise<void> => Promise.resolve(),
      setApprovalMode: (): Promise<void> => Promise.resolve(),
    };
    sessions.registerSession(
      key,
      session as AgentSession,
      new AbortController(),
      'codex',
      undefined,
      'default',
      'default',
      false,
      'codex',
    );
    sessions.noteSessionMessageQueued(key, 1);
    const { paused, release } =
      sessions.pauseCodexSessionsForAuthentication(attemptId);
    try {
      expect(await paused).toBe(1);
    } finally {
      release();
    }

    const [recorded, ...others] =
      await app.registry.readUsageLimitedChats(true);
    expect(others).toEqual([]);
    expect(recorded).toEqual(
      expect.objectContaining({
        ...target,
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: attemptId,
      }),
    );
    expect(recorded).not.toHaveProperty('interruptedUserMessageId');
    if (!recorded) throw new Error('The sign-in pause recorded nothing.');

    const entries = await queueResume(app, String(recorded.detectedAt));
    expect(entries).toEqual([expect.objectContaining({ status: 'resumed' })]);
    expect(entries[0]?.error).toBeUndefined();
    expect(mockChat.sent).toHaveLength(1);
    expect(await app.registry.readUsageLimitedChats(true)).toEqual([]);
  });
});
