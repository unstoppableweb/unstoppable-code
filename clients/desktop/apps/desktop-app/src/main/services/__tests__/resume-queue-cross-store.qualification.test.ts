/**
 * CAN-4708 (Phase 2 leg Q), with CAN-4707's U7 leg, on the in-app host: the
 * resume queue against chat acceptance and pipeline execution reasons,
 * through the production wiring (registerUsageLimitedChatsHandlers, the queue
 * host, its reconcile and dispatch). A crash image stops a process at the
 * queue store's save and relaunches with fresh modules over the same data
 * root. Assertions are outcomes only: what was sent, each entry's status and
 * which interruption survives. Storage mechanics stay with R0-F5 (CAN-7176).
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatTabsFile,
  PersistedChatMessage,
  PersistedChatTab,
  ResumeQueueEntry,
  ResumeQueueItem,
  ResumeQueueSnapshot,
  UsageLimitedChatEntry,
} from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import type {
  ExecutionState,
  Pipeline,
  PipelineStatusReason,
} from '@canopy/execution-engine/types/pipeline';
import type * as ExecutorModule from '@canopy/execution-engine/node/pipelines/executor';
import type { AgentSession } from '../../agents/types';
import type * as SessionManagerModule from '../../agents/session-manager';
import type * as ResumeModule from '../../ipc/usage-limited-chats';
import type * as RegistryModule from '../../lib/usage-limited-chats-registry';
import type * as PathsModule from '../../lib/paths';
import type * as RuntimeModule from '../../pipelines/execution-runtime';
import type * as HostModule from '../resume-queue-host';
import type * as QueueStorageModule from '../resume-queue-storage';

interface SentResume {
  userMessageId: string;
  text: string;
}

const mockChat: {
  tab: PersistedChatTab | undefined;
  sent: SentResume[];
  accept: boolean;
} = { tab: undefined, sent: [], accept: true };

const mockPipelineResumes: {
  calls: {
    executionId: string;
    statusReasonIds?: string[];
    allowStaleNoop?: boolean;
  }[];
  status: 'started' | 'stale-noop';
} = { calls: [], status: 'started' };

// The process stops at the first queue save that matches.
const mockQueueCrash: {
  at?: (snapshot: ResumeQueueSnapshot) => boolean;
} = {};

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

jest.mock('../attention-tracker', () => ({
  getAttentionTracker: (): { mark: () => void; clear: () => void } => ({
    mark: (): void => undefined,
    clear: (): void => undefined,
  }),
}));

jest.mock('../../lib/chat-tabs-reader', () =>
  mockPartially('../../lib/chat-tabs-reader', {
    readChatTabsFile: (): Promise<ChatTabsFile> =>
      Promise.resolve({
        version: 1,
        tabs: mockChat.tab ? [mockChat.tab] : [],
        activeTabId: mockChat.tab?.id ?? '',
      }),
  }),
);

// Diagnostics only; its background writes would race the scratch root's removal.
jest.mock('../../observability/ingest', () =>
  mockPartially('../../observability/ingest', {
    getExecutionObservabilityIngest: (): object =>
      new Proxy({}, { get: (): (() => void) => (): void => undefined }),
  }),
);

jest.mock('../../lib/chat-usage-limit-cleanup', () => ({
  capturePersistedUsageLimitBannerSnapshot: (): object => ({}),
  clearPersistedUsageLimitBanner: (): Promise<void> => Promise.resolve(),
}));

jest.mock('../chat-service', () =>
  mockPartially('../chat-service', {
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
        ...(mockChat.accept
          ? { lastAcceptedUserMessageId: request.userMessageId }
          : {}),
      };
      return Promise.resolve({ ok: true, chatId: request.chatId });
    },
  }),
);

jest.mock('../../pipelines/pipeline-resume-service', () =>
  mockPartially('../../pipelines/pipeline-resume-service', {
    resumePipelineExecutionFromMain: (request: {
      executionId: string;
      statusReasonIds?: string[];
      allowStaleNoop?: boolean;
    }): Promise<{ status: string; state: object }> => {
      mockPipelineResumes.calls.push({
        executionId: request.executionId,
        statusReasonIds: request.statusReasonIds,
        allowStaleNoop: request.allowStaleNoop,
      });
      return Promise.resolve({ status: mockPipelineResumes.status, state: {} });
    },
  }),
);

jest.mock('../resume-queue-storage', () => {
  const actual = jest.requireActual<typeof QueueStorageModule>(
    '../resume-queue-storage',
  );
  class CrashingResumeQueueStorage extends actual.ResumeQueueStorage {
    override save(snapshot: ResumeQueueSnapshot): Promise<void> {
      if (mockQueueCrash.at?.(snapshot)) {
        delete mockQueueCrash.at;
        return Promise.reject(new Error('simulated crash'));
      }
      return super.save(snapshot);
    }
  }
  return { ...actual, ResumeQueueStorage: CrashingResumeQueueStorage };
});

jest.setTimeout(60_000);

const scope = { projectId: 'project', worktreeId: 'worktree' };
const target = { ...scope, chatId: 'chat-1' };
const DETECTED_AT = 1_000;
const STOPPED_COPY =
  'The app stopped during this resume. Check the session before trying again.';
const PIPELINE: Pipeline = {
  name: 'Recovery',
  on: 'dispatch',
  jobs: { j: { steps: [{ id: 'echo', run: 'echo hi' }] } },
};
const RUN_LIVE = '3f1c2a8e-0d4b-4c61-9a7e-1b2c3d4e5f60';
const RUN_CHECKPOINT = '3f1c2a8e-0d4b-4c61-9a7e-1b2c3d4e5f61';
const RUN_CLEARED = '3f1c2a8e-0d4b-4c61-9a7e-1b2c3d4e5f62';
const RUN_GONE = '3f1c2a8e-0d4b-4c61-9a7e-1b2c3d4e5f63';
const REASON_A = '7a0e9b1c-2d3f-4e5a-8b6c-0d1e2f3a4b50';
const REASON_B = '7a0e9b1c-2d3f-4e5a-8b6c-0d1e2f3a4b51';
const REASON_CHECKPOINT = '7a0e9b1c-2d3f-4e5a-8b6c-0d1e2f3a4b52';
const REASON_GONE = '7a0e9b1c-2d3f-4e5a-8b6c-0d1e2f3a4b53';

let root: string;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'resume-queue-cross-store-'));
  process.env.CANOPY_DATA_DIR = root;
  resetResolvedCanopyDataDirForTests();
  mockChat.sent = [];
  mockChat.accept = true;
  mockPipelineResumes.calls = [];
  mockPipelineResumes.status = 'started';
  delete mockQueueCrash.at;
  mockChat.tab = {
    id: 'chat-1',
    title: 'Running chat',
    providerType: 'claude',
    lastAcceptedUserMessageId: 'user-1',
    interruptedTurns: { 'user-1': {} },
    transcript: { lastMessageAt: 1 },
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
  resume: typeof ResumeModule;
  registry: typeof RegistryModule;
  host: typeof HostModule;
  sessions: typeof SessionManagerModule;
  executor: typeof ExecutorModule;
  runtime: typeof RuntimeModule;
  paths: typeof PathsModule;
  queueStorage: typeof QueueStorageModule;
}

/** One app process: fresh module state, the queue wired as main wires it. */
async function inProcess<T>(run: (app: App) => Promise<T>): Promise<T> {
  let outcome: { value: T } | undefined;
  await jest.isolateModulesAsync(async () => {
    const app: App = {
      resume: await import('../../ipc/usage-limited-chats'),
      registry: await import('../../lib/usage-limited-chats-registry'),
      host: await import('../resume-queue-host'),
      sessions: await import('../../agents/session-manager'),
      executor:
        await import('@canopy/execution-engine/node/pipelines/executor'),
      runtime: await import('../../pipelines/execution-runtime'),
      paths: await import('../../lib/paths'),
      queueStorage: await import('../resume-queue-storage'),
    };
    app.resume.registerUsageLimitedChatsHandlers(() => null);
    outcome = { value: await run(app) };
  });
  if (!outcome) throw new Error('The app process returned no result.');
  return outcome.value;
}

function queueFile(app: App): QueueStorageModule.ResumeQueueStorage {
  return new app.queueStorage.ResumeQueueStorage(
    app.paths.getResumeQueueFilePath(),
  );
}

async function storedEntries(app: App): Promise<ResumeQueueEntry[]> {
  return (await queueFile(app).load())?.entries ?? [];
}

/** The queue file a crash left behind. */
async function writeQueue(
  app: App,
  entries: ResumeQueueEntry[],
): Promise<void> {
  await queueFile(app).save({
    version: 1,
    revision: 1,
    paused: false,
    entries,
  });
}

function shutdownEntry(detectedAt = DETECTED_AT): UsageLimitedChatEntry {
  return {
    ...target,
    provider: 'claude',
    detectedAt,
    resumeReason: 'app_shutdown',
    interruptedUserMessageId: 'user-1',
    workspaceName: '',
    chatTitle: '',
  };
}

const chatItem: ResumeQueueItem = {
  target: { kind: 'chat', ...target },
  title: 'Running chat',
  workspaceName: 'Workspace',
  interruptionId: String(DETECTED_AT),
};

function pipelineItem(
  executionId: string,
  statusReasonIds: string[],
): ResumeQueueItem {
  return {
    target: { kind: 'pipeline', executionId, statusReasonIds },
    title: 'Recovery',
    workspaceName: 'Workspace',
    interruptionId: statusReasonIds.join(','),
  };
}

function entry(
  item: ResumeQueueItem,
  id: string,
  status: ResumeQueueEntry['status'],
  createdAt = 5_000,
): ResumeQueueEntry {
  return { ...item, id, status, createdAt };
}

const recordsOutcome = (snapshot: ResumeQueueSnapshot): boolean =>
  snapshot.entries.some(
    (item) => item.status !== 'waiting' && item.status !== 'resuming',
  );

function reason(
  id: string,
  overrides: Partial<PipelineStatusReason> = {},
): PipelineStatusReason {
  return {
    id,
    kind: 'provider_usage_limit',
    code: 'usage_limit_exceeded',
    provider: 'claude',
    detected_at: new Date(DETECTED_AT).toISOString(),
    source: { job_id: 'j', step_id: 'echo', attempt: 1, iteration: 1 },
    ...overrides,
  };
}

/** A paused run in the execution store, as the executor saves it. */
async function seedRun(
  app: App,
  executionId: string,
  change: (state: ExecutionState) => void,
): Promise<void> {
  const runtime = app.runtime.createElectronExecutionRuntime();
  const state = app.executor.createInitialState(
    app.executor.normalizePipeline(PIPELINE),
    { cwd: root, pipelineId: 'pipeline', runtime },
    executionId,
  );
  state.status = 'paused';
  state.project_id = scope.projectId;
  state.worktree_id = scope.worktreeId;
  change(state);
  await app.executor.saveExecutionState(state, runtime.executionsDir);
}

async function executionFiles(app: App): Promise<Record<string, string>> {
  const directory = app.runtime.createElectronExecutionRuntime().executionsDir;
  const files: Record<string, string> = {};
  for (const name of await readdir(directory, { recursive: true }).catch(
    () => [] as string[],
  )) {
    const path = join(directory, name);
    files[name] = await readFile(path, 'utf8').catch(() => '<directory>');
  }
  return files;
}

describe('CAN-4708 Q3 chat acceptance', () => {
  it('CAN-4708 Q3 C2: a resume the chat accepted before the queue recorded it is resumed on relaunch, clears the interruption it finished and is never sent again', async () => {
    await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([shutdownEntry()]);
      const queue = app.host.getResumeQueue();
      await queue.enqueue([chatItem]);
      mockQueueCrash.at = recordsOutcome;
      await queue.tick().catch(() => undefined);
      expect(mockChat.sent).toHaveLength(1);
      expect(await storedEntries(app)).toEqual([
        expect.objectContaining({ status: 'resuming' }),
      ]);
    });

    await inProcess(async (app) => {
      const queue = app.host.getResumeQueue();
      await queue.initialize();
      expect(queue.snapshot().entries).toEqual([
        expect.objectContaining({ status: 'resumed' }),
      ]);
      await queue.tick();
      expect(mockChat.sent).toHaveLength(1);
      expect(await app.registry.readUsageLimitedChats(true)).toEqual([]);
    });
  });

  it('CAN-4708 Q3: reconciling an accepted resume keeps a newer interruption recorded for the same chat', async () => {
    await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([shutdownEntry()]);
      const queue = app.host.getResumeQueue();
      await queue.enqueue([chatItem]);
      mockQueueCrash.at = recordsOutcome;
      await queue.tick().catch(() => undefined);
      expect(mockChat.sent).toHaveLength(1);
      await app.registry.recordUsageLimitedChat({
        ...shutdownEntry(DETECTED_AT + 1),
        resumeReason: 'usage_limit',
      });
    });

    await inProcess(async (app) => {
      const queue = app.host.getResumeQueue();
      await queue.initialize();
      expect(queue.snapshot().entries).toEqual([
        expect.objectContaining({ status: 'resumed' }),
      ]);
      expect(await app.registry.readUsageLimitedChats(true)).toEqual([
        expect.objectContaining({
          ...target,
          detectedAt: DETECTED_AT + 1,
          resumeReason: 'usage_limit',
        }),
      ]);
      expect(mockChat.sent).toHaveLength(1);
    });
  });

  it('CAN-4708 Q3: a chat with a running turn is skipped and nothing is sent', async () => {
    await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([shutdownEntry()]);
      const key = app.sessions.buildSessionKey(
        scope.projectId,
        scope.worktreeId,
        'chat-1',
      );
      const session: Partial<AgentSession> = {
        isDisposed: (): boolean => false,
        destroy: (): Promise<void> => Promise.resolve(),
        setApprovalMode: (): Promise<void> => Promise.resolve(),
      };
      app.sessions.registerSession(
        key,
        session as AgentSession,
        new AbortController(),
        'claude',
      );
      app.sessions.markTurnActive(key, 'user-2');
      const queue = app.host.getResumeQueue();
      await queue.enqueue([chatItem]);
      await queue.tick();
      expect(queue.snapshot().entries).toEqual([
        expect.objectContaining({ status: 'skipped' }),
      ]);
      expect(mockChat.sent).toEqual([]);
      expect(await app.registry.readUsageLimitedChats(true)).toHaveLength(1);
    });
  });
});

describe('CAN-4708 Q2 ambiguous sends', () => {
  it('CAN-4708 Q2 C3: a prompt persisted without acceptance when the app stopped ends failed with its copy and is never sent again', async () => {
    await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([shutdownEntry()]);
      const queue = app.host.getResumeQueue();
      await queue.enqueue([chatItem]);
      mockChat.accept = false;
      mockQueueCrash.at = recordsOutcome;
      await queue.tick().catch(() => undefined);
      expect(mockChat.sent).toHaveLength(1);
      expect(await storedEntries(app)).toEqual([
        expect.objectContaining({ status: 'resuming' }),
      ]);
    });

    await inProcess(async (app) => {
      const queue = app.host.getResumeQueue();
      await queue.initialize();
      expect(queue.snapshot().entries).toEqual([
        expect.objectContaining({ status: 'failed', error: STOPPED_COPY }),
      ]);
      await queue.tick();
      expect(mockChat.sent).toHaveLength(1);
    });
  });

  it('CAN-4708 Q2: chat activity after the resume was queued, without its prompt, also ends failed and unsent', async () => {
    mockChat.tab = {
      ...mockChat.tab,
      transcript: { lastMessageAt: 6_000 },
    } as unknown as PersistedChatTab;
    await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([shutdownEntry()]);
      await writeQueue(app, [entry(chatItem, 'claimed', 'resuming', 5_000)]);
      const queue = app.host.getResumeQueue();
      await queue.initialize();
      expect(queue.snapshot().entries).toEqual([
        expect.objectContaining({ status: 'failed', error: STOPPED_COPY }),
      ]);
      await queue.tick();
      expect(mockChat.sent).toEqual([]);
    });
  });

  it('CAN-4708 Q2 control: a claimed resume with no trace in the chat returns to waiting on relaunch and is sent once', async () => {
    await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([shutdownEntry()]);
      await writeQueue(app, [entry(chatItem, 'claimed', 'resuming', 5_000)]);
      const queue = app.host.getResumeQueue();
      await queue.initialize();
      expect(queue.snapshot().entries).toEqual([
        expect.objectContaining({ status: 'waiting' }),
      ]);
      await queue.tick();
      expect(queue.snapshot().entries).toEqual([
        expect.objectContaining({ status: 'resumed' }),
      ]);
      expect(mockChat.sent).toHaveLength(1);
      expect(await app.registry.readUsageLimitedChats(true)).toEqual([]);
    });
  });
});

describe('CAN-4708 Q4 execution reasons', () => {
  it('CAN-4708 Q4: on relaunch a claimed pipeline resume waits while a reason or shutdown checkpoint is live, is resumed without dispatch once its reasons are gone, and is skipped when the run is gone', async () => {
    await inProcess(async (app) => {
      await seedRun(app, RUN_LIVE, (state) => {
        state.status_reasons = [reason(REASON_A)];
      });
      await seedRun(app, RUN_CHECKPOINT, (state) => {
        state.status_reasons = [];
        state.shutdown_checkpoint = {
          id: REASON_CHECKPOINT,
          detected_at: new Date(DETECTED_AT).toISOString(),
        };
      });
      await seedRun(app, RUN_CLEARED, (state) => {
        state.status_reasons = [];
      });
      await writeQueue(app, [
        entry(pipelineItem(RUN_LIVE, [REASON_A]), 'live', 'resuming'),
        entry(
          pipelineItem(RUN_CHECKPOINT, [REASON_CHECKPOINT]),
          'checkpoint',
          'resuming',
        ),
        entry(pipelineItem(RUN_CLEARED, [REASON_B]), 'cleared', 'resuming'),
        entry(pipelineItem(RUN_GONE, [REASON_GONE]), 'gone', 'resuming'),
      ]);
      const before = await executionFiles(app);
      const queue = app.host.getResumeQueue();
      await queue.initialize();
      expect(
        Object.fromEntries(
          queue.snapshot().entries.map((item) => [item.id, item.status]),
        ),
      ).toEqual({
        live: 'waiting',
        checkpoint: 'waiting',
        cleared: 'resumed',
        gone: 'skipped',
      });
      expect(mockPipelineResumes.calls).toEqual([]);
      expect(await executionFiles(app)).toEqual(before);
    });
  });

  it('CAN-4708 Q4: a waiting pipeline resume hands the run its exact reason ids with a stale no-op allowed, and a stale run ends skipped', async () => {
    mockPipelineResumes.status = 'stale-noop';
    await inProcess(async (app) => {
      await seedRun(app, RUN_LIVE, (state) => {
        state.status_reasons = [reason(REASON_A), reason(REASON_B)];
      });
      const queue = app.host.getResumeQueue();
      await queue.enqueue([pipelineItem(RUN_LIVE, [REASON_A, REASON_B])]);
      await queue.tick();
      expect(mockPipelineResumes.calls).toEqual([
        {
          executionId: RUN_LIVE,
          statusReasonIds: [REASON_A, REASON_B],
          allowStaleNoop: true,
        },
      ]);
      expect(queue.snapshot().entries).toEqual([
        expect.objectContaining({ status: 'skipped' }),
      ]);
    });
  });

  it('CAN-4707 U7 and CAN-4708 Q4: a pipeline authentication pause and its claimed resume keep the same reason ids through a relaunch, and the resume completes without dispatch once the run clears them', async () => {
    const pause = { attempt_id: 'attempt-1', reason_ids: [REASON_A] };
    await inProcess(async (app) => {
      await seedRun(app, RUN_LIVE, (state) => {
        state.status_reasons = [
          reason(REASON_A, {
            kind: 'provider_authentication_required',
            code: 'authentication_failed',
            provider: 'codex',
            authentication_attempt_id: pause.attempt_id,
          }),
        ];
        state.authentication_pause = pause;
      });
      await writeQueue(app, [
        entry(pipelineItem(RUN_LIVE, [REASON_A]), 'paused-run', 'resuming'),
      ]);
      const before = await executionFiles(app);
      const queue = app.host.getResumeQueue();
      await queue.initialize();
      expect(queue.snapshot().entries).toEqual([
        expect.objectContaining({
          status: 'waiting',
          target: {
            kind: 'pipeline',
            executionId: RUN_LIVE,
            statusReasonIds: [REASON_A],
          },
        }),
      ]);
      expect(await storedEntries(app)).toEqual(queue.snapshot().entries);
      expect(await executionFiles(app)).toEqual(before);
      expect(await app.registry.readUsageLimitedChats(true)).toEqual([]);
    });

    await inProcess(async (app) => {
      await seedRun(app, RUN_LIVE, (state) => {
        state.status_reasons = [];
      });
      await writeQueue(app, [
        entry(pipelineItem(RUN_LIVE, [REASON_A]), 'paused-run', 'resuming'),
      ]);
      const queue = app.host.getResumeQueue();
      await queue.initialize();
      expect(queue.snapshot().entries).toEqual([
        expect.objectContaining({ status: 'resumed' }),
      ]);
      expect(mockPipelineResumes.calls).toEqual([]);
    });
  });
});

describe('CAN-4708 Q5 restore', () => {
  it('CAN-4708 Q5: an older queue restored over newer chat, registry and run state sends nothing', async () => {
    const older = await inProcess(async (app) => {
      await app.registry.recordInterruptedChats([shutdownEntry()]);
      await seedRun(app, RUN_CLEARED, (state) => {
        state.status_reasons = [reason(REASON_A)];
      });
      const queue = app.host.getResumeQueue();
      await queue.enqueue([chatItem, pipelineItem(RUN_CLEARED, [REASON_A])]);
      const snapshot = await storedEntries(app);
      await queue.tick();
      expect(mockChat.sent).toHaveLength(1);
      expect(await app.registry.readUsageLimitedChats(true)).toEqual([]);
      await seedRun(app, RUN_CLEARED, (state) => {
        state.status_reasons = [];
      });
      return snapshot;
    });
    const [chat, pipeline] = older;
    if (!chat || !pipeline) throw new Error('The queue lost an entry.');
    const pipelineResumesBefore = mockPipelineResumes.calls.length;

    // Restored with the chat still waiting: its interruption is gone.
    await inProcess(async (app) => {
      await writeQueue(app, [chat, { ...pipeline, status: 'resuming' }]);
      const queue = app.host.getResumeQueue();
      await queue.initialize();
      await queue.tick();
      expect(
        Object.fromEntries(
          queue
            .snapshot()
            .entries.map((item) => [item.target.kind, item.status]),
        ),
      ).toEqual({ chat: 'skipped', pipeline: 'resumed' });
    });

    // Restored with the chat claimed: the chat already accepted its resume.
    await inProcess(async (app) => {
      await writeQueue(app, [{ ...chat, status: 'resuming' }]);
      const queue = app.host.getResumeQueue();
      await queue.initialize();
      await queue.tick();
      expect(queue.snapshot().entries).toEqual([
        expect.objectContaining({ status: 'resumed' }),
      ]);
    });

    expect(mockChat.sent).toHaveLength(1);
    expect(mockPipelineResumes.calls).toHaveLength(pipelineResumesBefore);
  });
});
