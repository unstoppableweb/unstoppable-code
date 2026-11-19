/**
 * CAN-4475 R0-F4 on the in-app host (CAN-7176): chat turns interrupted by a
 * desktop quit are recorded for Resume, against the real interruption
 * registry and resume queue files. A quit records each interrupted chat once
 * as `app_shutdown` and keeps every existing usage and authentication
 * reason. Recovery holds even if quit teardown never finishes: the next
 * launch, composed as production composes it, finds the turn's durable
 * running marker in chat storage and leaves exactly one `app_shutdown` entry
 * for the chat. Pipeline runs are not chat interruptions: the quit leaves a
 * queued pipeline resume byte-identical.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  type ResumeQueueSnapshot,
  type UsageLimitedChatEntry,
} from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import type { AgentSession } from '../agents/types';
import type * as SessionManagerModule from '../agents/session-manager';
import {
  buildSessionKey,
  destroyAllSessions,
  markTurnActive,
  registerSession,
} from '../agents/session-manager';
import type * as RegistryModule from '../lib/usage-limited-chats-registry';
import {
  readUsageLimitedChats,
  recordInterruptedChats,
} from '../lib/usage-limited-chats-registry';
import { getResumeQueueFilePath } from '../lib/paths';
import { getChatQueueService } from '../services/chat-queue-service';
import type * as ChatStateModule from '../services/chat-state-service';
import type { ChatStateServiceOptions } from '../services/chat-state-service';
import type * as RepositoryModule from '../services/chat-state-v2-repository';
import { ResumeQueueStorage } from '../services/resume-queue-storage';

jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: () => void; clear: () => void } => ({
    mark: (): void => undefined,
    clear: (): void => undefined,
  }),
}));

jest.setTimeout(60_000);

const scope = { projectId: 'project', worktreeId: 'worktree' };
let root: string;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'r0-quit-resume-'));
  process.env.CANOPY_DATA_DIR = root;
  resetResolvedCanopyDataDirForTests();
});

afterEach(async () => {
  getChatQueueService().resetForTests();
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(root, { recursive: true, force: true });
});

interface AppProcess {
  chatState: typeof ChatStateModule;
  repositories: typeof RepositoryModule;
  sessions: typeof SessionManagerModule;
  registry: typeof RegistryModule;
}

/**
 * One app process: a fresh module registry, so no session, queue or chat
 * state from an earlier process is visible, over the same data root.
 */
async function inProcess<T>(run: (app: AppProcess) => Promise<T>): Promise<T> {
  let outcome: { value: T } | undefined;
  await jest.isolateModulesAsync(async () => {
    outcome = {
      value: await run({
        chatState: await import('../services/chat-state-service'),
        repositories: await import('../services/chat-state-v2-repository'),
        sessions: await import('../agents/session-manager'),
        registry: await import('../lib/usage-limited-chats-registry'),
      }),
    };
  });
  if (!outcome) throw new Error('The app process returned no result.');
  return outcome.value;
}

/** Inert host callbacks: nothing dispatches, authorizes or launches. */
function inertHost(): ChatStateServiceOptions {
  let ids = 0;
  return {
    now: (): number => 1_786_104_000_000,
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

function entry(
  chatId: string,
  resumeReason: UsageLimitedChatEntry['resumeReason'],
): UsageLimitedChatEntry {
  return {
    ...scope,
    chatId,
    provider: 'claude',
    detectedAt: 1,
    resumeReason,
    workspaceName: 'Workspace',
    chatTitle: chatId,
  };
}

function standInSession(
  register: typeof registerSession,
  key: string,
  destroy: () => Promise<void> = (): Promise<void> => Promise.resolve(),
): void {
  const session: Partial<AgentSession> = {
    isDisposed: (): boolean => false,
    destroy,
    setApprovalMode: (): Promise<void> => Promise.resolve(),
  };
  register(key, session as AgentSession, new AbortController(), 'claude');
}

/** A relaunch composed as production composes it, with no injected repository. */
function relaunch(): Promise<{
  status: string | undefined;
  entries: UsageLimitedChatEntry[];
}> {
  return inProcess(async ({ chatState, registry }) => {
    const app = new chatState.ChatStateService(inertHost());
    try {
      const state = await app.getState(scope);
      return {
        status: state.runtimeByChatId['chat-1']?.status,
        entries: await registry.readUsageLimitedChats(true),
      };
    } finally {
      await app.drain();
    }
  });
}

it('R0-F4 relaunch: a quit whose teardown never finishes still leaves exactly one app_shutdown entry after relaunch reconciliation', async () => {
  await inProcess(async ({ chatState, repositories, sessions }) => {
    const repository = new repositories.ChatStateV2Repository({
      enableFormat4: true,
    });
    const app = new chatState.ChatStateService({
      repository,
      ...inertHost(),
    });
    const created = await app.command({
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
    expect(created.outcome).toBe('applied');
    await repository.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'user-1',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Question' }],
          },
        },
      ],
      { source: 'migration' },
    );
    await app.ingestProviderEvent({
      ...scope,
      chatId: 'chat-1',
      mutationId: 'chat-1:user-1:accepted',
      turnUserMessageId: 'user-1',
      data: {
        type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
        canopy_turn_user_message_id: 'user-1',
      },
    });
    await repository.transact(
      scope,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'streaming',
            activeTurn: { userMessageId: 'user-1', startedAt: 1 },
            queuedMessageIds: [],
          },
        },
      ],
      { source: 'provider' },
    );

    const key = sessions.buildSessionKey(
      scope.projectId,
      scope.worktreeId,
      'chat-1',
    );
    let teardownStarted: () => void = (): void => undefined;
    const tearingDown = new Promise<void>((resolve) => {
      teardownStarted = resolve;
    });
    standInSession(sessions.registerSession, key, (): Promise<void> => {
      teardownStarted();
      return new Promise<void>(() => undefined);
    });
    sessions.markTurnActive(key, 'user-1');
    void sessions.destroyAllSessions({ recordInterrupted: true });
    await tearingDown;
    // The process stops here, with quit teardown still pending.
    await repository.drainAll();
  });

  const first = await relaunch();
  expect(first.status).toBe('interrupted');
  const recorded = first.entries.filter((item) => item.chatId === 'chat-1');
  expect(recorded).toEqual([
    expect.objectContaining({
      ...scope,
      chatId: 'chat-1',
      resumeReason: 'app_shutdown',
      interruptedUserMessageId: 'user-1',
    }),
  ]);

  const second = await relaunch();
  expect(second.status).toBe('interrupted');
  expect(second.entries).toEqual(first.entries);
});

it('R0-F4 quit: each interrupted chat is recorded once as app_shutdown, existing reasons are kept, and a queued pipeline resume is untouched', async () => {
  await recordInterruptedChats([
    entry('limited', 'usage_limit'),
    entry('signed-out', 'authentication'),
  ]);
  const queueFile = getResumeQueueFilePath();
  const pipelineQueue: ResumeQueueSnapshot = {
    version: 1,
    revision: 1,
    paused: false,
    entries: [
      {
        id: 'pipeline-entry',
        target: {
          kind: 'pipeline',
          executionId: 'execution',
          statusReasonIds: ['reason-a'],
        },
        title: 'Workflow',
        workspaceName: 'Workspace',
        interruptionId: 'interruption-pipeline',
        createdAt: 1,
        status: 'waiting',
      },
    ],
  };
  await new ResumeQueueStorage(queueFile).save(pipelineQueue);
  const queueBytes = await readFile(queueFile);

  const keyFor = (chatId: string): string =>
    buildSessionKey(scope.projectId, scope.worktreeId, chatId);
  standInSession(registerSession, keyFor('running'));
  markTurnActive(keyFor('running'), 'user-run');
  standInSession(registerSession, keyFor('limited'));
  markTurnActive(keyFor('limited'), 'user-limited');
  standInSession(registerSession, keyFor('idle'));

  await destroyAllSessions({ recordInterrupted: true });

  const entries = await readUsageLimitedChats(true);
  const reasons = Object.fromEntries(
    entries.map((item) => [item.chatId, item.resumeReason]),
  );
  expect(reasons).toEqual({
    limited: 'usage_limit',
    'signed-out': 'authentication',
    running: 'app_shutdown',
  });
  expect(entries.filter((item) => item.chatId === 'running')).toHaveLength(1);
  expect(await readFile(queueFile)).toEqual(queueBytes);
});
