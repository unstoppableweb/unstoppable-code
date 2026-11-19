/**
 * CAN-7225: Resume after a clean quit. The quit records each interrupted
 * chat with the turn it interrupted, so a repeat Resume recognizes its own
 * accepted prompt and resolves without sending again. A repeat comes from a
 * second click, a cleanup that failed after the first Resume, or the resume
 * queue dispatching after a manual Resume. Without the turn, the repeat
 * Resume fails and an already-resumed chat is reported as failed.
 *
 * Resume runs through handleResumeUsageLimitedChats, the
 * `usage-limited-chats:resume` handler (IPC_CHANNELS.resumeUsageLimitedChats),
 * and the resume queue through dispatchResumeQueueEntry.
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
  UsageLimitedChatEntry,
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
    clearUsageLimitedChat: (
      ...args: Parameters<typeof actual.clearUsageLimitedChat>
    ): Promise<void> => {
      if (mockFailNextClear) {
        mockFailNextClear = false;
        return Promise.reject(new Error('Registry cleanup failed.'));
      }
      return actual.clearUsageLimitedChat(...args);
    },
  };
});

jest.setTimeout(60_000);

const scope = { projectId: 'project', worktreeId: 'worktree' };
const target = { ...scope, chatId: 'chat-1' };
let root: string;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'resume-after-quit-'));
  process.env.CANOPY_DATA_DIR = root;
  resetResolvedCanopyDataDirForTests();
  mockChat.sent = [];
  mockFailNextClear = false;
  mockChat.tab = {
    id: 'chat-1',
    title: 'Running chat',
    providerType: 'claude',
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

/** A clean quit with chat-1's turn for user-1 running. */
async function quitWithRunningTurn(): Promise<UsageLimitedChatEntry> {
  return inProcess(async ({ sessions, registry }) => {
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
      'claude',
    );
    sessions.markTurnActive(key, 'user-1');
    await sessions.destroyAllSessions({ recordInterrupted: true });
    const [recorded] = await registry.readUsageLimitedChats(true);
    if (!recorded) throw new Error('The quit recorded nothing.');
    return recorded;
  });
}

it('CAN-7225 a clean quit records the interrupted turn, and a repeat Resume after a failed cleanup sends once and ends as a quiet already-resumed', async () => {
  const recorded = await quitWithRunningTurn();
  expect(recorded).toMatchObject({
    ...target,
    resumeReason: 'app_shutdown',
    interruptedUserMessageId: 'user-1',
  });

  await inProcess(async ({ resume, registry }) => {
    mockFailNextClear = true;
    const first = await resume.handleResumeUsageLimitedChats(
      { targets: [target] },
      () => null,
    );
    expect(first).toEqual({ resumedCount: 1, failedTargets: [] });
    expect(await registry.readUsageLimitedChats(true)).toHaveLength(1);

    // The repeat is a quiet 'already resumed': the response the renderer
    // reads as accepted (no failedTargets, so no failed chat or error), and
    // no error logged.
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const second = await resume.handleResumeUsageLimitedChats(
        { targets: [target] },
        () => null,
      );
      expect(second).toEqual({ resumedCount: 1, failedTargets: [] });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    expect(mockChat.sent).toHaveLength(1);
    expect(await registry.readUsageLimitedChats(true)).toEqual([]);
  });
});

it('CAN-7225 a resumed turn interrupted by a later quit replaces the stored entry it resumed, so Resume continues it once', async () => {
  const first = await quitWithRunningTurn();
  const resumed = await inProcess(async ({ resume, registry }) => {
    mockFailNextClear = true;
    expect(
      await resume.handleResumeUsageLimitedChats(
        { targets: [target] },
        () => null,
      ),
    ).toEqual({ resumedCount: 1, failedTargets: [] });
    // The cleanup failed, so the entry for the first quit remains.
    expect(await registry.readUsageLimitedChats(true)).toEqual([first]);
    const [sent] = mockChat.sent;
    if (!sent) throw new Error('The first Resume sent nothing.');
    return sent.userMessageId;
  });
  // The resumed turn is running when the next quit interrupts it.
  mockChat.tab = {
    ...mockChat.tab,
    interruptedTurns: { ...mockChat.tab?.interruptedTurns, [resumed]: {} },
  } as unknown as PersistedChatTab;
  const recorded = await inProcess(async ({ sessions, registry }) => {
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
      'claude',
    );
    sessions.markTurnActive(key, resumed);
    await sessions.destroyAllSessions({ recordInterrupted: true });
    return registry.readUsageLimitedChats(true);
  });
  expect(recorded).toEqual([
    expect.objectContaining({
      ...target,
      resumeReason: 'app_shutdown',
      interruptedUserMessageId: resumed,
    }),
  ]);
  expect(recorded[0]?.detectedAt).toBeGreaterThan(first.detectedAt);

  await inProcess(async ({ resume, registry }) => {
    // The first Resume continues the re-interrupted turn. Its cleanup fails
    // again, and the repeat is a quiet already-resumed.
    mockFailNextClear = true;
    expect(
      await resume.handleResumeUsageLimitedChats(
        { targets: [target] },
        () => null,
      ),
    ).toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockChat.sent).toHaveLength(2);
    expect(mockChat.tab?.interruptedTurns?.[resumed]?.resumedBy).toBe(
      mockChat.sent[1]?.userMessageId,
    );
    expect(
      await resume.handleResumeUsageLimitedChats(
        { targets: [target] },
        () => null,
      ),
    ).toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockChat.sent).toHaveLength(2);
    expect(await registry.readUsageLimitedChats(true)).toEqual([]);
  });
});

it('CAN-7225 auto-resume through the resume queue after a clean quit and a manual Resume sends once and ends resumed, not failed', async () => {
  const recorded = await quitWithRunningTurn();

  await inProcess(async ({ resume, registry, queue, queueStorage }) => {
    mockFailNextClear = true;
    const manual = await resume.handleResumeUsageLimitedChats(
      { targets: [target] },
      () => null,
    );
    expect(manual).toEqual({ resumedCount: 1, failedTargets: [] });

    const storage = new queueStorage.ResumeQueueStorage(
      join(root, 'resume-queue.json'),
    );
    const service = new queue.ResumeQueueService({
      load: (): Promise<ResumeQueueSnapshot | null> => storage.load(),
      save: (next): Promise<void> => storage.save(next),
      dispatch: (entry: ResumeQueueEntry): Promise<'resumed' | 'skipped'> =>
        resume.dispatchResumeQueueEntry(entry, () => null),
      reconcile: (): Promise<{ status: 'waiting' }> =>
        Promise.resolve({ status: 'waiting' }),
      now: (): number => recorded.detectedAt,
      changed: (): void => undefined,
    });
    await service.enqueue([
      {
        target: { kind: 'chat', ...target },
        title: 'Running chat',
        workspaceName: 'Workspace',
        interruptionId: String(recorded.detectedAt),
      },
    ]);
    await service.tick();
    expect(service.snapshot().entries).toEqual([
      expect.objectContaining({ status: 'resumed' }),
    ]);
    expect(service.snapshot().entries[0]?.error).toBeUndefined();
    expect(mockChat.sent).toHaveLength(1);
    expect(await registry.readUsageLimitedChats(true)).toEqual([]);
  });
});

function shutdownEntry(
  resumeReason: UsageLimitedChatEntry['resumeReason'],
  detectedAt: number,
  interruptedUserMessageId?: string,
): UsageLimitedChatEntry {
  return {
    ...target,
    provider: 'claude',
    detectedAt,
    resumeReason,
    ...(interruptedUserMessageId ? { interruptedUserMessageId } : {}),
    workspaceName: '',
    chatTitle: '',
  };
}

it('CAN-7225 a shutdown entry without its turn takes the turn from a later shutdown record, keeping its own interruption', async () => {
  await inProcess(async ({ registry }) => {
    await registry.recordInterruptedChats([shutdownEntry('app_shutdown', 10)]);
    await registry.recordInterruptedChats([
      shutdownEntry('app_shutdown', 20, 'user-1'),
    ]);
    expect(await registry.readUsageLimitedChats(true)).toEqual([
      shutdownEntry('app_shutdown', 10, 'user-1'),
    ]);

    await registry.recordInterruptedChats([
      shutdownEntry('app_shutdown', 30, 'user-2'),
    ]);
    expect(await registry.readUsageLimitedChats(true)).toEqual([
      shutdownEntry('app_shutdown', 10, 'user-1'),
    ]);
  });
});

it('CAN-7225 a shutdown entry stored without its turn during a quit takes the turn that was running, keeping its own interruption', async () => {
  const [recorded, stored] = await inProcess(async ({ sessions, registry }) => {
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
      'claude',
    );
    sessions.markTurnActive(key, 'user-1');
    // Another path records the same chat first, without its turn.
    const first = shutdownEntry('app_shutdown', Date.now());
    await registry.recordInterruptedChats([first]);
    await sessions.destroyAllSessions({ recordInterrupted: true });
    return [await registry.readUsageLimitedChats(true), first] as const;
  });
  expect(recorded).toEqual([{ ...stored, interruptedUserMessageId: 'user-1' }]);
});

it('CAN-7225 a shutdown entry without its turn takes the turn from a later shutdown record whose turn started by then, and gives way to one whose turn started after it', async () => {
  await inProcess(async ({ registry }) => {
    for (const [turnStartedAt, expected] of [
      [10, shutdownEntry('app_shutdown', 10, 'user-1')],
      [11, shutdownEntry('app_shutdown', 20, 'user-1')],
    ] as const) {
      await registry.clearUsageLimitedChat(target);
      await registry.recordInterruptedChats([
        shutdownEntry('app_shutdown', 10),
      ]);
      await registry.recordInterruptedChats([
        { ...shutdownEntry('app_shutdown', 20, 'user-1'), turnStartedAt },
      ]);
      // The turn's start time is never stored.
      expect(await registry.readUsageLimitedChats(true)).toEqual([expected]);
    }
  });
});

it('CAN-7225 a shutdown entry with its turn keeps it against a record for the same turn or for a different turn that started at or before it, and gives way only to a different turn that started after it', async () => {
  const stored = shutdownEntry('app_shutdown', 10, 'user-1');
  await inProcess(async ({ registry }) => {
    for (const [interruptedUserMessageId, turnStartedAt, expected] of [
      ['user-2', undefined, stored],
      ['user-2', 5, stored],
      ['user-2', 10, stored],
      ['user-1', 11, stored],
      ['user-2', 11, shutdownEntry('app_shutdown', 20, 'user-2')],
    ] as const) {
      await registry.clearUsageLimitedChat(target);
      await registry.recordInterruptedChats([stored]);
      await registry.recordInterruptedChats([
        {
          ...shutdownEntry('app_shutdown', 20, interruptedUserMessageId),
          ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
        },
      ]);
      expect(await registry.readUsageLimitedChats(true)).toEqual([expected]);
    }
  });
});

it('CAN-7225 a usage-limit or authentication entry never takes a turn from a shutdown record', async () => {
  await inProcess(async ({ registry }) => {
    for (const resumeReason of ['usage_limit', 'authentication'] as const) {
      await registry.clearUsageLimitedChat(target);
      await registry.recordInterruptedChats([shutdownEntry(resumeReason, 10)]);
      await registry.recordInterruptedChats([
        shutdownEntry('app_shutdown', 20, 'user-1'),
      ]);
      expect(await registry.readUsageLimitedChats(true)).toEqual([
        shutdownEntry(resumeReason, 10),
      ]);
    }
  });
});

/** chat-1 continues with turn B for user-b, accepted at 10 and interrupted. */
function startTurnB(): void {
  mockChat.tab = {
    ...mockChat.tab,
    lastAcceptedUserMessageId: 'user-b',
    interruptedTurns: { 'user-b': {} },
    messages: [
      ...(mockChat.tab?.messages ?? []),
      {
        id: 'user-b',
        role: 'user',
        timestamp: 10,
        blocks: [{ type: 'text', text: 'Next question' }],
      },
    ],
  } as unknown as PersistedChatTab;
}

it('CAN-7225 a stale shutdown entry without its turn gives way to a later turn recorded at the next quit: Resume continues that turn once, a repeat is quiet, and nothing else changes', async () => {
  const other: UsageLimitedChatEntry = {
    ...scope,
    chatId: 'chat-2',
    provider: 'claude',
    detectedAt: 3,
    resumeReason: 'usage_limit',
    workspaceName: 'Workspace',
    chatTitle: 'chat-2',
  };
  // An unresumed shutdown entry with no turn, from a terminal-mode quit or an
  // older version, then a new turn B that is running at the next quit.
  const stale = shutdownEntry('app_shutdown', 5);
  startTurnB();

  const recorded = await inProcess(async ({ sessions, registry }) => {
    await registry.recordInterruptedChats([stale, other]);
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
      'claude',
    );
    sessions.markTurnActive(key, 'user-b');
    await sessions.destroyAllSessions({ recordInterrupted: true });
    return registry.readUsageLimitedChats(true);
  });
  const replaced = recorded.find((item) => item.chatId === 'chat-1');
  expect(replaced).toMatchObject({
    resumeReason: 'app_shutdown',
    interruptedUserMessageId: 'user-b',
  });
  expect(replaced?.detectedAt).toBeGreaterThan(stale.detectedAt);
  expect(recorded.find((item) => item.chatId === 'chat-2')).toEqual(other);

  await inProcess(async ({ resume, registry, queue, queueStorage }) => {
    const storage = new queueStorage.ResumeQueueStorage(
      join(root, 'resume-queue.json'),
    );
    const service = new queue.ResumeQueueService({
      load: (): Promise<ResumeQueueSnapshot | null> => storage.load(),
      save: (next): Promise<void> => storage.save(next),
      dispatch: (entry: ResumeQueueEntry): Promise<'resumed' | 'skipped'> =>
        resume.dispatchResumeQueueEntry(entry, () => null),
      reconcile: (): Promise<{ status: 'waiting' }> =>
        Promise.resolve({ status: 'waiting' }),
      now: (): number => 1_000,
      changed: (): void => undefined,
    });
    mockFailNextClear = true;
    const first = await resume.handleResumeUsageLimitedChats(
      { targets: [target] },
      () => null,
    );
    expect(first).toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockChat.sent).toHaveLength(1);
    const second = await resume.handleResumeUsageLimitedChats(
      { targets: [target] },
      () => null,
    );
    expect(second).toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockChat.sent).toHaveLength(1);
    await service.enqueue([
      {
        target: { kind: 'chat', ...target },
        title: 'Running chat',
        workspaceName: 'Workspace',
        interruptionId: String(stale.detectedAt),
      },
    ]);
    await service.tick();
    // The queue entry for the stale interruption completes without a send:
    // its interruption is no longer the chat's.
    expect(service.snapshot().entries).toEqual([
      expect.objectContaining({ interruptionId: '5', status: 'skipped' }),
    ]);
    expect(service.snapshot().entries[0]?.error).toBeUndefined();
    expect(mockChat.sent).toHaveLength(1);
    expect(await registry.readUsageLimitedChats(true)).toEqual([other]);
  });
});

/**
 * A manual Resume whose cleanup fails, the resume queue dispatching each
 * interruption the chat was recorded with, then, unless `repeat` is false, a
 * repeat Resume.
 */
async function resumeEveryWay(
  { resume, queue, queueStorage }: App,
  interruptionIds: string[],
  repeat = true,
): Promise<{
  results: Awaited<
    ReturnType<typeof ResumeModule.handleResumeUsageLimitedChats>
  >[];
  entries: ResumeQueueEntry[];
}> {
  const storage = new queueStorage.ResumeQueueStorage(
    join(root, 'resume-queue.json'),
  );
  const service = new queue.ResumeQueueService({
    load: (): Promise<ResumeQueueSnapshot | null> => storage.load(),
    save: (next): Promise<void> => storage.save(next),
    dispatch: (entry: ResumeQueueEntry): Promise<'resumed' | 'skipped'> =>
      resume.dispatchResumeQueueEntry(entry, () => null),
    reconcile: (): Promise<{ status: 'waiting' }> =>
      Promise.resolve({ status: 'waiting' }),
    now: (): number => 1_000,
    changed: (): void => undefined,
  });
  await service.enqueue(
    Array.from(new Set(interruptionIds)).map((interruptionId) => ({
      target: { kind: 'chat' as const, ...target },
      title: 'Running chat',
      workspaceName: 'Workspace',
      interruptionId,
    })),
  );
  mockFailNextClear = true;
  const first = await resume.handleResumeUsageLimitedChats(
    { targets: [target] },
    () => null,
  );
  await service.tick();
  const results = [first];
  if (repeat)
    results.push(
      await resume.handleResumeUsageLimitedChats(
        { targets: [target] },
        () => null,
      ),
    );
  return { results, entries: service.snapshot().entries };
}

const RELAUNCHED_AT = 1_786_104_000_000;

/** Inert host callbacks: nothing dispatches, authorizes or launches. */
function inertHost(): Omit<ChatStateServiceOptions, 'repository'> {
  let ids = 0;
  return {
    now: (): number => RELAUNCHED_AT,
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
 * chat-1 holds a durable running marker for user-1's turn, started at
 * `startedAt`, and the next launch reconciles it as production composes it.
 */
async function relaunchWithRunningTurn(startedAt: number): Promise<void> {
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
        providerType: 'claude',
        model: 'claude-opus-4-6',
      },
    });
    await repository.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'user-1',
            role: 'user',
            timestamp: startedAt,
            blocks: [{ type: 'text', text: 'Question' }],
          },
        },
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'streaming',
            activeTurn: { userMessageId: 'user-1', startedAt },
            queuedMessageIds: [],
          },
        },
      ],
      { source: 'provider' },
    );
    await repository.drainAll();
  });
  await inProcess(async () => {
    const chatState = await import('../services/chat-state-service');
    const app = new chatState.ChatStateService(inertHost());
    try {
      const state = await app.getState(scope);
      expect(state.runtimeByChatId['chat-1']?.status).toBe('interrupted');
    } finally {
      await app.drain();
    }
  });
}

it('CAN-7225 a terminal quit then relaunch reconciliation: the turn running at the quit merges into the stored entry, its queued resume stays valid and it resumes once; a turn started after it replaces the entry and resumes once', async () => {
  // The terminal quit records the chat without its turn.
  const terminalQuit = shutdownEntry('app_shutdown', 50);
  for (const [startedAt, recordedAt] of [
    [1, terminalQuit.detectedAt],
    [100, RELAUNCHED_AT],
  ] as const) {
    await rm(root, { recursive: true, force: true });
    mockChat.sent = [];
    mockChat.tab = {
      ...mockChat.tab,
      interruptedTurns: { 'user-1': {} },
      messages: [
        {
          id: 'user-1',
          role: 'user',
          timestamp: startedAt,
          blocks: [{ type: 'text', text: 'Question' }],
        },
      ],
    } as unknown as PersistedChatTab;
    await inProcess(({ registry }) =>
      registry.recordInterruptedChats([terminalQuit]),
    );
    await relaunchWithRunningTurn(startedAt);

    await inProcess(async (app) => {
      expect(await app.registry.readUsageLimitedChats(true)).toEqual([
        expect.objectContaining({
          ...target,
          resumeReason: 'app_shutdown',
          interruptedUserMessageId: 'user-1',
          detectedAt: recordedAt,
        }),
      ]);
      const merged = startedAt === 1;
      // Once the queue resolves a merged entry nothing is left to resume. A
      // replaced entry outlives its failed cleanup until a repeat Resume
      // resolves it quietly.
      const { results, entries } = await resumeEveryWay(
        app,
        [String(terminalQuit.detectedAt)],
        !merged,
      );
      expect(results).toEqual(
        Array.from({ length: merged ? 1 : 2 }, () => ({
          resumedCount: 1,
          failedTargets: [],
        })),
      );
      // A merged entry keeps the terminal quit's interruption, so its queued
      // resume stays current and resolves as already resumed. A replaced
      // entry's interruption is no longer the chat's: its queued resume skips.
      expect(entries).toEqual([
        expect.objectContaining({
          interruptionId: String(terminalQuit.detectedAt),
          status: merged ? 'resumed' : 'skipped',
        }),
      ]);
      expect(entries[0]?.error).toBeUndefined();
      expect(mockChat.sent).toHaveLength(1);
      expect(await app.registry.readUsageLimitedChats(true)).toEqual([]);
    });
  }
});

it('CAN-7225 a stored shutdown entry and a later turn never send twice, whatever the turn start the record carries', async () => {
  const outcomes: Record<string, number> = {};
  for (const [storedKind, stale, turnStartedAt] of [
    'without-turn',
    'with-turn',
  ].flatMap((kind) =>
    [undefined, 1, 5, 10].map(
      (start) =>
        [
          kind,
          kind === 'with-turn'
            ? shutdownEntry('app_shutdown', 5, 'user-1')
            : shutdownEntry('app_shutdown', 5),
          start,
        ] as const,
    ),
  )) {
    mockChat.sent = [];
    mockChat.tab = undefined;
    await rm(root, { recursive: true, force: true });
    mockChat.tab = {
      id: 'chat-1',
      title: 'Running chat',
      providerType: 'claude',
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
    startTurnB();
    await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([stale]);
      await app.registry.recordInterruptedChats([
        {
          ...shutdownEntry('app_shutdown', 20, 'user-b'),
          ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
        },
      ]);
      const [recorded] = await app.registry.readUsageLimitedChats(true);
      await resumeEveryWay(app, [
        String(stale.detectedAt),
        String(recorded?.detectedAt),
      ]);
    });
    expect(mockChat.sent.length).toBeLessThanOrEqual(1);
    // No interrupted turn's prompt is ever sent again.
    const texts = mockChat.sent.map((sent) => sent.text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts).not.toContain('Question');
    outcomes[`${storedKind} ${String(turnStartedAt)}`] = mockChat.sent.length;
  }
  // A start at or before the stored entry keeps today's rule, which can only
  // report the newer turn as failed; a later start resumes it once.
  expect(outcomes).toEqual({
    'without-turn undefined': 0,
    'without-turn 1': 0,
    'without-turn 5': 0,
    'without-turn 10': 1,
    'with-turn undefined': 0,
    'with-turn 1': 0,
    'with-turn 5': 0,
    'with-turn 10': 1,
  });
});
