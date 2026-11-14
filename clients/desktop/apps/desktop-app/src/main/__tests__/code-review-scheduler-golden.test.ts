// CAN-4167 golden: code review scheduling as desktop runs it today, captured
// before core.review takes it over. The scheduler, code-review persistence
// and the deletion fence are real, on a temporary data root. The branch diff
// (its fingerprint and bundle), the model generators, helper-task
// bookkeeping, the turn-hook registry lookup and window sends are replaced,
// so each case controls when the diff changes and when a generation settles.
// A change here is a behaviour change: re-record deliberately with
// `pnpm test <this file> -u` and review the snapshot diff.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  PLAN_DIAGRAM_SCHEMA_VERSION,
  type CodeReviewFile,
  type CodeReviewGenerationResult,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import type * as Scheduler from '../lib/code-review-scheduler';
import type * as Persistence from '../lib/code-review-persistence';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type * as MainProcessLogging from '../lib/main-process-logging';
import { getCodeReviewStateFilePath } from '../lib/paths';

jest.setTimeout(60_000);

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
const sends: { channel: string; status: unknown }[] = [];
const sentPayloads: { channel: string; payload: unknown }[] = [];
const recordSend = (channel: string, payload: unknown): void => {
  sentPayloads.push({ channel, payload });
  const review = (payload as { review?: CodeReviewFile } | undefined)?.review;
  sends.push({
    channel,
    status: review
      ? {
          armed: review.armed,
          annotations: review.annotations?.status ?? null,
          logicDiff: review.diagrams.logicDiff?.status ?? null,
          dataModelDiff: review.diagrams.dataModelDiff?.status ?? null,
        }
      : null,
  });
};
jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>(
    '../lib/main-process-logging',
  ),
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({
  sendToAllWindows: (channel: string, payload: unknown): void => {
    recordSend(channel, payload);
  },
  sendToWindow: (_window: unknown, channel: string, payload: unknown): void => {
    recordSend(channel, payload);
  },
}));

// The branch diff: each case sets the fingerprint and bundle it wants.
const diff = {
  fingerprint: 'fp-1',
  text: 'diff --git a/src/a.ts b/src/a.ts\n+one',
};
let worktreePath = '';
jest.mock('../lib/code-review-diff', () => ({
  listReviewRepos: (): Promise<{ repoId: string; repoPath: string }[]> =>
    Promise.resolve([{ repoId: '__workspace_root__', repoPath: worktreePath }]),
  computeReviewFingerprint: (): Promise<string> =>
    Promise.resolve(diff.fingerprint),
  buildReviewDiffBundle: (): Promise<{ text: string }> =>
    Promise.resolve({ text: diff.text }),
}));

// Generators settle when a case releases them; every call is counted.
interface Gate {
  release: () => void;
  promise: Promise<void>;
}
const gate = (): Gate => {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
};
let hold: Gate | null = null;
const calls: string[] = [];
const logicDiff = {
  schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
  current: { nodes: [], edges: [] },
  planned: { nodes: [], edges: [] },
  changes: [],
};
jest.mock('../lib/code-review-generator', () => ({
  generateReviewAnnotations: async (): Promise<unknown> => {
    calls.push('annotations');
    if (hold) await hold.promise;
    return {
      value: {
        schemaVersion: 1,
        annotations: [
          {
            id: 'a1',
            repoId: '__workspace_root__',
            filePath: 'src/a.ts',
            side: 'new',
            lineStart: 1,
            lineEnd: 1,
            kind: 'explanation',
            title: 'Adds one',
            body: 'Adds a line.',
          },
        ],
      },
      usage: undefined,
    };
  },
  generateReviewLogicDiff: async (): Promise<unknown> => {
    calls.push('logicDiff');
    if (hold) await hold.promise;
    return { value: logicDiff, usage: undefined };
  },
  generateReviewDataModelDiff: async (): Promise<unknown> => {
    calls.push('dataModelDiff');
    if (hold) await hold.promise;
    return { value: null, usage: undefined };
  },
  sanitizeReviewAnnotations: (value: unknown): Promise<unknown> =>
    Promise.resolve(value),
}));
const helperTasks: string[] = [];
jest.mock('../lib/helper-observed-task', () => ({
  startObservedHelperTask: (task: { taskKey: string }): void => {
    helperTasks.push(`start ${task.taskKey.replace(/:[^:]*$/, ':<fp>')}`);
  },
  finalizeObservedHelperTask: (taskKey: string, outcome: string): void => {
    helperTasks.push(`${outcome} ${taskKey.replace(/:[^:]*$/, ':<fp>')}`);
  },
}));
jest.mock('../lib/helper-transcript-observer', () => ({
  createHelperTranscriptObserver: (): unknown => ({}),
}));
const TURN_SCOPE_KEY = 'golden-review--golden-wt';
jest.mock('../lib/code-review-registry', () => ({
  ...jest.requireActual<object>('../lib/code-review-registry'),
  getCodeReviewTargetSync: (
    key: string,
  ): { projectId: string; worktreeId: string } | null =>
    key === 'golden-review--golden-wt'
      ? { projectId: 'golden-review', worktreeId: 'golden-wt' }
      : null,
}));

const WORKSPACE_ID = 'golden-review';
const WORKTREE_ID = 'golden-wt';
const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
const getWindow = (): null => null;

let root: string;
let scheduler: typeof Scheduler;
let persistence: typeof Persistence;
const originalDataDir = process.env.CANOPY_DATA_DIR;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'code-review-golden-')));
  const dataDir = join(root, 'data');
  process.env.CANOPY_DATA_DIR = dataDir;
  worktreePath = join(
    dataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktrees',
    WORKTREE_ID,
  );
  mkdirSync(join(worktreePath, 'src'), { recursive: true });
  writeFileSync(join(worktreePath, 'src', 'a.ts'), 'one\n');
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Review',
        type: 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order: 0,
      },
    ],
  });
  writeJson(join(dataDir, 'workspaces', WORKSPACE_ID, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: join(root, 'repo'),
    repos: [],
  });
  // The app hydrates the model catalog at startup; the default review model
  // (haiku) resolves to the Claude harness once it is.
  const { initClaudeModels } = await import('@canopy/desktop-shared/types');
  initClaudeModels([{ id: 'haiku', label: 'Haiku' }]);
  const registry = await import('../lib/workspace-registry');
  registry.registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
  const { registerCodeReviewHandlers } = await import('../ipc/code-review');
  registerCodeReviewHandlers(getWindow);
  scheduler = await import('../lib/code-review-scheduler');
  persistence = await import('../lib/code-review-persistence');
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  sends.length = 0;
  calls.length = 0;
  helperTasks.length = 0;
  hold = null;
});

function invoke<T>(channel: string, request: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return Promise.resolve(handler({ sender: { id: 1 } }, request)) as Promise<T>;
}

// The real clock, captured before any case installs fake timers. Scheduler
// work finishes on the thread pool, so waits are measured in real time, not
// event-loop turns, which a slow runner can exhaust first.
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
// Lets fire-and-forget scheduler work settle.
async function settle(): Promise<void> {
  await sleep(100);
}
// Waits until a fire-and-forget run has produced what a case expects, then
// lets its remaining writes and update event follow.
async function waitFor(done: () => boolean, what: string): Promise<void> {
  // Counted, not timed: fake timers also fake Date. 1,500 x 10 ms is 15 s.
  for (let i = 0; i < 1_500 && !done(); i += 1) await sleep(10);
  if (!done()) throw new Error(`Timed out waiting for ${what}`);
  await settle();
}
const ran = (): boolean =>
  helperTasks.some((t) =>
    t.startsWith('success helper:code-review-annotations'),
  );

function shape(file: CodeReviewFile): unknown {
  const artifact = (a?: {
    status: string;
    derivedFromFingerprint: string;
    error?: string;
    data: unknown;
  }): unknown =>
    a
      ? {
          status: a.status,
          fingerprint: a.derivedFromFingerprint,
          hasData: a.data !== null,
          error: a.error,
        }
      : null;
  return {
    armed: file.armed,
    annotations: artifact(file.annotations),
    logicDiff: artifact(file.diagrams.logicDiff),
    dataModelDiff: artifact(file.diagrams.dataModelDiff),
    threads: file.commentThreads.length,
  };
}

describe('code review scheduling (CAN-4167 golden)', () => {
  it('arms through IPC and generates every artifact once', async () => {
    const result = await invoke<CodeReviewGenerationResult>(
      IPC_CHANNELS.codeReviewArm,
      scope,
    );
    const review = await persistence.readCodeReviewState(
      WORKSPACE_ID,
      WORKTREE_ID,
    );
    // The artifact runs are concurrent, so only order-free facts are pinned:
    // which helper tasks ran, and the first and last update events.
    expect({
      result,
      review: shape(review),
      calls: [...calls].sort(),
      helperTasks: [...helperTasks].sort(),
      updates: { count: sends.length, first: sends[0], last: sends.at(-1) },
    }).toMatchSnapshot();
  });

  it('answers fresh without a generation when the diff has not moved', async () => {
    const result = await invoke<CodeReviewGenerationResult>(
      IPC_CHANNELS.codeReviewGenerate,
      scope,
    );
    expect(result).toEqual({ status: 'fresh' });
    expect(calls).toEqual([]);
  });

  it('coalesces activity into one run after the idle debounce', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    try {
      diff.fingerprint = 'fp-2';
      scheduler.noteWorktreeActivityForCodeReview(
        WORKSPACE_ID,
        WORKTREE_ID,
        getWindow,
      );
      await settle();
      await jest.advanceTimersByTimeAsync(10_000);
      scheduler.noteWorktreeActivityForCodeReview(
        WORKSPACE_ID,
        WORKTREE_ID,
        getWindow,
      );
      await settle();
      await jest.advanceTimersByTimeAsync(
        scheduler.CODE_REVIEW_IDLE_DEBOUNCE_MS - 1,
      );
      await settle();
      const beforeDebounce = [...calls];
      await jest.advanceTimersByTimeAsync(1);
      await waitFor(ran, 'the debounced run');
      expect(beforeDebounce).toEqual([]);
      expect(calls.filter((c) => c === 'annotations')).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
    const review = await persistence.readCodeReviewState(
      WORKSPACE_ID,
      WORKTREE_ID,
    );
    expect(shape(review)).toMatchSnapshot();
  });

  it('holds a debounced run while a turn runs, and runs it when the turn ends', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    try {
      diff.fingerprint = 'fp-3';
      scheduler.noteCodeReviewTurnStart(TURN_SCOPE_KEY);
      scheduler.noteWorktreeActivityForCodeReview(
        WORKSPACE_ID,
        WORKTREE_ID,
        getWindow,
      );
      await settle();
      await jest.advanceTimersByTimeAsync(
        scheduler.CODE_REVIEW_IDLE_DEBOUNCE_MS + 1,
      );
      await settle();
      const duringTurn = [...calls];
      scheduler.noteCodeReviewTurnEnd(TURN_SCOPE_KEY, getWindow);
      await waitFor(ran, 'the run after the turn');
      expect(duringTurn).toEqual([]);
      expect(calls.filter((c) => c === 'annotations')).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('polls only while a review view is open', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    try {
      diff.fingerprint = 'fp-4';
      scheduler.setCodeReviewModalOpen(scope, true, getWindow, 'golden');
      await jest.advanceTimersByTimeAsync(
        scheduler.CODE_REVIEW_POLL_INTERVAL_MS,
      );
      await settle();
      await jest.advanceTimersByTimeAsync(
        scheduler.CODE_REVIEW_IDLE_DEBOUNCE_MS,
      );
      await waitFor(ran, 'the polled run');
      const whileOpen = calls.filter((c) => c === 'annotations').length;
      scheduler.setCodeReviewModalOpen(scope, false, getWindow, 'golden');
      // Closing stops the poll, but a debounce an earlier tick scheduled
      // still fires once.
      diff.fingerprint = 'fp-5';
      calls.length = 0;
      await jest.advanceTimersByTimeAsync(
        scheduler.CODE_REVIEW_IDLE_DEBOUNCE_MS * 2,
      );
      await settle();
      const afterClose = [...calls].sort();
      diff.fingerprint = 'fp-5b';
      calls.length = 0;
      await jest.advanceTimersByTimeAsync(
        scheduler.CODE_REVIEW_POLL_INTERVAL_MS * 3 +
          scheduler.CODE_REVIEW_IDLE_DEBOUNCE_MS,
      );
      await settle();
      expect(whileOpen).toBe(1);
      expect({ afterClose }).toMatchSnapshot();
      expect(calls).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('queues one rerun for a request made while a run is in flight', async () => {
    diff.fingerprint = 'fp-6';
    hold = gate();
    const first = invoke<CodeReviewGenerationResult>(
      IPC_CHANNELS.codeReviewGenerate,
      scope,
    );
    // Counted, not timed: under load a fixed wait can let the next step run
    // before the review reaches its generators.
    await waitFor(() => calls.length > 0, 'the review to reach its generators');
    const second = await invoke<CodeReviewGenerationResult>(
      IPC_CHANNELS.codeReviewGenerate,
      scope,
    );
    const third = await invoke<CodeReviewGenerationResult>(
      IPC_CHANNELS.codeReviewGenerate,
      scope,
    );
    const midFlight = shape(
      await persistence.readCodeReviewState(WORKSPACE_ID, WORKTREE_ID),
    );
    hold.release();
    hold = null;
    const firstResult = await first;
    await settle();
    expect({ second, third, firstResult, midFlight }).toMatchSnapshot();
    // One run, then one queued rerun that finds the diff fresh.
    expect(calls.filter((c) => c === 'annotations')).toHaveLength(1);
  });

  it('settles an armed review with an empty diff without touching its artifacts', async () => {
    diff.fingerprint = 'fp-empty';
    const before = diff.text;
    diff.text = '';
    try {
      const result = await invoke<CodeReviewGenerationResult>(
        IPC_CHANNELS.codeReviewGenerate,
        scope,
      );
      expect(result).toEqual({ status: 'empty' });
      expect(calls).toEqual([]);
    } finally {
      diff.text = before;
    }
  });

  it('saves comment threads and an agent reply', async () => {
    // A thread as the review panel saves it: one user comment on a line.
    const thread: ReviewCommentThread = {
      id: 't1',
      status: 'open',
      createdAt: '2026-11-12T00:00:00.000Z',
      anchorState: 'matched',
      anchor: {
        source: 'code',
        quote: 'one',
        repoId: '__workspace_root__',
        filePath: 'src/a.ts',
        side: 'new',
        lineStart: 1,
        lineEnd: 1,
      },
      comments: [
        {
          id: 'c1',
          author: 'user',
          body: 'Why one?',
          createdAt: '2026-11-12T00:00:00.000Z',
        },
      ],
    };
    const saved = await invoke<CodeReviewFile | null>(
      IPC_CHANNELS.codeReviewSaveComments,
      {
        ...scope,
        commentThreads: [thread],
      },
    );
    const reply = await persistence.appendReviewCommentReply({
      ...scope,
      threadId: 't1',
      body: 'Because the plan says so.',
    });
    expect(reply?.ok).toBe(true);
    const after = await persistence.readCodeReviewState(
      WORKSPACE_ID,
      WORKTREE_ID,
    );
    expect({
      savedThreads: saved?.commentThreads.length ?? null,
      replyKeys: Object.keys(reply ?? {}).sort(),
      comments: after.commentThreads.flatMap((t) =>
        t.comments.map((c) => ({ author: c.author, body: c.body })),
      ),
    }).toMatchSnapshot();
  });

  // Changed on purpose in CAN-6667. The save used to write a thread the
  // reader does not accept, so it vanished on the next read and a reply to
  // it failed. The save now refuses it and keeps the stored threads.
  it('refuses a malformed thread on save and leaves the stored threads unchanged (CAN-6667)', async () => {
    const before = await persistence.readCodeReviewState(
      WORKSPACE_ID,
      WORKTREE_ID,
    );
    await expect(
      invoke<CodeReviewFile | null>(IPC_CHANNELS.codeReviewSaveComments, {
        ...scope,
        commentThreads: [{ id: 't-bad', status: 'open', comments: [] }],
      }),
    ).rejects.toThrow('This comment thread could not be saved.');
    const reread = await persistence.readCodeReviewState(
      WORKSPACE_ID,
      WORKTREE_ID,
    );
    expect(reread.commentThreads.map((thread) => thread.id)).toEqual(
      before.commentThreads.map((thread) => thread.id),
    );
  });

  // CAN-6667: a thread the reader rejects used to vanish silently, and the
  // next write erased it. A read keeps the valid threads and reports the one
  // it skipped to the person; writes carry it on disk as it was.
  it('reads the valid threads beside a malformed one, tells the person, and keeps it through a write (CAN-6667)', async () => {
    const file = getCodeReviewStateFilePath(WORKSPACE_ID, WORKTREE_ID);
    const state = JSON.parse(readFileSync(file, 'utf8')) as {
      commentThreads: unknown[];
    };
    const valid = (
      await persistence.readCodeReviewState(WORKSPACE_ID, WORKTREE_ID)
    ).commentThreads.length;
    state.commentThreads.push({ id: 't-bad', status: 'open', comments: [] });
    writeFileSync(file, JSON.stringify(state, null, 2));
    jest.mocked(logMainProcessWarn).mockClear();
    const reread = await persistence.readCodeReviewState(
      WORKSPACE_ID,
      WORKTREE_ID,
    );
    expect(reread.commentThreads).toHaveLength(valid);
    expect(jest.mocked(logMainProcessWarn)).toHaveBeenCalledWith(
      expect.stringContaining('skipped 1 unreadable comment thread'),
      expect.objectContaining({ worktreeId: WORKTREE_ID, skipped: 1 }),
    );
    await expect(
      invoke(IPC_CHANNELS.codeReviewGet, scope),
    ).resolves.toMatchObject({ skippedCommentThreads: 1 });

    sentPayloads.length = 0;
    await invoke(IPC_CHANNELS.codeReviewSaveComments, {
      ...scope,
      commentThreads: reread.commentThreads,
    });
    const stored = (
      JSON.parse(readFileSync(file, 'utf8')) as {
        commentThreads: { id?: unknown }[];
      }
    ).commentThreads.map((thread) => thread.id);
    expect(stored).toContain('t-bad');
    expect(stored).toHaveLength(valid + 1);
    expect(
      sentPayloads.find(
        (sent) => sent.channel === IPC_CHANNELS.codeReviewUpdated,
      )?.payload,
    ).toMatchObject({ skippedCommentThreads: 1 });
    await expect(
      invoke(IPC_CHANNELS.codeReviewGet, scope),
    ).resolves.toMatchObject({ skippedCommentThreads: 1 });
  });

  it('keeps a generating artifact as it is after a restart', async () => {
    const file = await persistence.readCodeReviewState(
      WORKSPACE_ID,
      WORKTREE_ID,
    );
    const generating = { ...file.annotations, status: 'generating' };
    await persistence.setCodeReviewArtifact(
      WORKSPACE_ID,
      WORKTREE_ID,
      'annotations',
      generating as Parameters<typeof persistence.setCodeReviewArtifact>[3],
    );
    let afterRestart: CodeReviewFile | null = null;
    await jest.isolateModulesAsync(async () => {
      const isolated = await import('../lib/code-review-persistence');
      afterRestart = await isolated.readCodeReviewState(
        WORKSPACE_ID,
        WORKTREE_ID,
      );
    });
    // R1 (CAN-4167): nothing reconciles it today, so it stays generating.
    expect((afterRestart as CodeReviewFile | null)?.annotations?.status).toBe(
      'generating',
    );
  });

  it('drains an in-flight review on worktree delete, then refuses new work', async () => {
    diff.fingerprint = 'fp-7';
    hold = gate();
    const running = invoke<CodeReviewGenerationResult>(
      IPC_CHANNELS.codeReviewGenerate,
      scope,
    );
    // Counted, not timed: under load a fixed wait can let the next step run
    // before the review reaches its generators.
    await waitFor(() => calls.length > 0, 'the review to reach its generators');
    let drained = false;
    const drain = scheduler
      .drainCodeReviewForDeletion(WORKSPACE_ID, WORKTREE_ID)
      .then(() => {
        drained = true;
      });
    await settle();
    const drainedBeforeRelease = drained;
    hold.release();
    hold = null;
    const inFlight = await running.then(
      (result) => ({ result }),
      (error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await drain;
    const afterDrain = await invoke<CodeReviewGenerationResult>(
      IPC_CHANNELS.codeReviewGenerate,
      scope,
    );
    expect({
      drainedBeforeRelease,
      drained,
      inFlight,
      afterDrain,
    }).toMatchSnapshot();
  });
});
