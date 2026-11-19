// CAN-4167 golden: code review scheduling as desktop runs it today, captured
// before core.review takes it over. The scheduler, code-review persistence
// and the deletion fence are real, on a temporary data root. The branch diff
// (its fingerprint and bundle), the model generators, helper-task
// bookkeeping, the turn-hook registry lookup and window sends are replaced,
// so each case controls when the diff changes and when a generation settles.
// A change here is a behaviour change: re-record deliberately with
// `pnpm test <this file> -u` and review the snapshot diff.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_DIAGRAM_SCHEMA_VERSION,
  buildCodeReviewScopeKey,
  emptyCodeReviewFile,
  type CodeReviewFile,
  type CodeReviewGetResponse,
  type CodeReviewGenerationResult,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import type * as Scheduler from '../lib/code-review-scheduler';
import type * as Persistence from '../lib/code-review-persistence';
import type * as ReviewDiff from '../lib/code-review-diff';
import type * as Generator from '../lib/code-review-generator';
import type * as Registry from '../lib/code-review-registry';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type * as MainProcessLogging from '../lib/main-process-logging';
import {
  getCodeReviewRegistryFilePath,
  getCodeReviewStateFilePath,
} from '../lib/paths';
import { withReviewStateLock } from '@canopy/core-runtime/node/review';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

// Share function mocks across the host and core-runtime interop namespaces.
jest.mock('node:fs/promises', () => {
  const fs = jest.requireActual<typeof fsPromises>('node:fs/promises');
  return { ...fs, readFile: jest.fn(fs.readFile), rename: jest.fn(fs.rename) };
});

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

it('binds a queued review mutation to the path it locked even if workspace routing changes', async () => {
  registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
  const reviewProject = CODE_REVIEW_CHAT_PROJECT_ID;
  const capturedPath = getCodeReviewStateFilePath(reviewProject, WORKTREE_ID);
  const blocked = gate();
  const acquired = gate();
  const lock = withReviewStateLock(capturedPath, async () => {
    acquired.release();
    await blocked.promise;
  });
  await acquired.promise;
  const mutation = persistence.setCodeReviewArmed(reviewProject, WORKTREE_ID);
  registerWorkspaceTypes(new Map([[reviewProject, 'single-repo']]));
  const otherPath = getCodeReviewStateFilePath(reviewProject, WORKTREE_ID);
  try {
    expect(otherPath).not.toBe(capturedPath);
    blocked.release();
    await lock;
    await mutation;
    expect(JSON.parse(readFileSync(capturedPath, 'utf8'))).toMatchObject({
      armed: true,
    });
    expect(existsSync(otherPath)).toBe(false);
  } finally {
    blocked.release();
    registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
  }
});

function invoke<T>(channel: string, request: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return Promise.resolve(handler({ sender: { id: 1 } }, request)) as Promise<T>;
}

describe('associated-state recovery admission', () => {
  const recoveryScope = { projectId: WORKSPACE_ID, worktreeId: 'recovery-wt' };
  const { projectId, worktreeId } = recoveryScope;
  const statePath = (): string =>
    getCodeReviewStateFilePath(projectId, worktreeId);
  const rawBytes = (): string => readFileSync(statePath(), 'utf8');
  const stored = (): { commentThreads: unknown } => {
    const parsed: unknown = JSON.parse(rawBytes());
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('commentThreads' in parsed)
    ) {
      throw new Error('Stored review is missing commentThreads');
    }
    return parsed;
  };
  const get = (): Promise<CodeReviewGetResponse> =>
    invoke(IPC_CHANNELS.codeReviewGet, recoveryScope);
  const arm = (): Promise<CodeReviewFile> =>
    persistence.setCodeReviewArmed(projectId, worktreeId);
  const save = (commentThreads: unknown[] = []): Promise<unknown> =>
    invoke(IPC_CHANNELS.codeReviewSaveComments, {
      ...recoveryScope,
      commentThreads,
    });
  const envelope = {
    data: null,
    status: 'generating' as const,
    derivedFromFingerprint: 'old',
  };
  const thread: ReviewCommentThread = {
    id: 'replace-me',
    status: 'open',
    createdAt: '2026-11-17',
    anchorState: 'matched',
    anchor: { source: 'code', quote: '', unanchored: true },
    comments: [],
  };
  const rawState = (fields: object): string =>
    JSON.stringify({ ...emptyCodeReviewFile(), ...fields });
  const install = (raw: string): void => {
    writeJson(statePath(), emptyCodeReviewFile());
    writeFileSync(statePath(), raw);
  };
  const rawCases = [
    ['invalid JSON', '{incomplete', 'invalid_json'],
    ['empty file', '', 'invalid_json'],
    ['unsupported version', rawState({ version: 2 }), 'unsupported_version'],
    ['missing version', '{}', 'unsupported_version'],
    ['non-object state', 'null', 'lossy_state'],
    ['array state', '[]', 'lossy_state'],
  ];
  const lossyFields: [string, object][] = [
    ['thread container', { commentThreads: {} }],
    ['null threads', { commentThreads: null }],
    ['missing threads', { commentThreads: undefined }],
    ['missing armed', { armed: undefined }],
    ['missing diagrams', { diagrams: undefined }],
    ['armed value', { armed: 'yes' }],
    ['armed timestamp', { armedAt: 42 }],
    ['diagram container', { diagrams: [] }],
    ['null diagram container', { diagrams: null }],
    ['annotation envelope', { annotations: { status: 'ready' } }],
    [
      'annotation payload',
      { annotations: { ...envelope, data: { damaged: true } } },
    ],
    ['logic envelope', { diagrams: { logicDiff: null } }],
    ['logic payload', { diagrams: { logicDiff: { ...envelope, data: {} } } }],
    [
      'model payload',
      { diagrams: { dataModelDiff: { ...envelope, data: [] } } },
    ],
    ['envelope status', { annotations: { ...envelope, status: 'unknown' } }],
    ['envelope metadata', { annotations: { ...envelope, generatedAt: 42 } }],
    ['unknown extension', { future: { evidence: true } }],
    ['diagram extension', { diagrams: { future: envelope } }],
    ['artifact extension', { annotations: { ...envelope, future: true } }],
  ];
  const mutations = [
    arm,
    save,
    (): Promise<unknown> =>
      persistence.appendReviewCommentReply({
        ...recoveryScope,
        threadId: thread.id,
        body: 'reply',
      }),
    (): Promise<unknown> =>
      persistence.setCodeReviewArtifact(
        projectId,
        worktreeId,
        'logicDiff',
        envelope,
      ),
    (): Promise<unknown> =>
      persistence.removeCodeReviewDiagramArtifact(
        projectId,
        worktreeId,
        'dataModelDiff',
        'old',
      ),
    (): Promise<unknown> =>
      persistence.reevaluateReviewAnchors(projectId, worktreeId),
    (): Promise<unknown> => invoke(IPC_CHANNELS.codeReviewArm, recoveryScope),
    (): Promise<unknown> =>
      invoke(IPC_CHANNELS.codeReviewGenerate, recoveryScope),
  ];
  it.each([
    ...rawCases,
    ...lossyFields.map(([label, fields]) => [
      label,
      rawState(fields),
      'lossy_state',
    ]),
  ])('preserves %s and refuses every mutation', async (_label, raw, reason) => {
    install(raw);
    const failure = { code: 'code_review_state_unavailable', reason };
    for (const mutate of mutations) {
      await expect(mutate()).rejects.toMatchObject(failure);
      expect(rawBytes()).toBe(raw);
    }
    const projection = await get();
    expect(projection.mutationFailure).toMatchObject(failure);
    expect(calls).toEqual([]);
    expect(sends).toEqual([]);
  });
  it.each(['EIO', 'EACCES'])(
    'refuses %s instead of treating it as absence',
    async (code) => {
      const raw = rawState({ armed: true });
      install(raw);
      const error = Object.assign(new Error(code), { code });
      const reader = jest.mocked(fsPromises.readFile).mockRejectedValue(error);
      try {
        await expect(arm()).rejects.toMatchObject({
          code: 'code_review_state_unavailable',
          reason: 'read_failed',
          underlyingError: error,
        });
        await expect(get()).resolves.toMatchObject({
          mutationFailure: {
            code: 'code_review_state_unavailable',
            reason: 'read_failed',
          },
        });
      } finally {
        reader.mockImplementation(
          jest.requireActual<typeof fsPromises>('node:fs/promises').readFile,
        );
      }
      expect(rawBytes()).toBe(raw);
      expect(sends).toEqual([]);
    },
  );
  it('refuses a directory at the state-file path without replacing it', async () => {
    rmSync(statePath(), { force: true });
    mkdirSync(statePath(), { recursive: true });
    const evidence = join(statePath(), 'evidence');
    writeFileSync(evidence, 'keep');
    try {
      await expect(arm()).rejects.toMatchObject({
        code: 'code_review_state_unavailable',
        reason: 'read_failed',
      });
      expect(readFileSync(evidence, 'utf8')).toBe('keep');
      expect(sends).toEqual([]);
    } finally {
      rmSync(statePath(), { recursive: true, force: true });
    }
  });
  it.each(['{broken', rawState({ armed: true, diagrams: null })])(
    'skips refused activity until repair (%s)',
    async (raw) => {
      install(raw);
      const warn = jest.mocked(logMainProcessWarn).mockClear();
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });
      try {
        scheduler.setCodeReviewModalOpen(recoveryScope, true, getWindow);
        for (let i = 0; i < 2; i += 1) {
          scheduler.noteWorktreeActivityForCodeReview(
            projectId,
            worktreeId,
            getWindow,
          );
          await settle();
          await jest.advanceTimersByTimeAsync(
            scheduler.CODE_REVIEW_POLL_INTERVAL_MS,
          );
          await settle();
        }
        expect(warn).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
        expect(sends).toEqual([]);
        expect(rawBytes()).toBe(raw);
        scheduler.setCodeReviewModalOpen(recoveryScope, false, getWindow);
        install(rawState({ armed: true }));
        scheduler.noteWorktreeActivityForCodeReview(
          projectId,
          worktreeId,
          getWindow,
        );
        await settle();
        await jest.advanceTimersByTimeAsync(
          scheduler.CODE_REVIEW_IDLE_DEBOUNCE_MS,
        );
        await waitFor(ran, 'the repaired review');
        expect(calls).toContain('annotations');
        expect(warn).not.toHaveBeenCalled();
      } finally {
        scheduler.__testing.reset();
        jest.useRealTimers();
        warn.mockReset();
      }
    },
  );
  it('logs unexpected background failures with scope and preserves awaited rejection', async () => {
    install(rawState({ armed: true }));
    const error = new Error('fingerprint unavailable');
    const reviewDiff = jest.requireMock<typeof ReviewDiff>(
      '../lib/code-review-diff',
    );
    const fingerprint = jest
      .spyOn(reviewDiff, 'computeReviewFingerprint')
      .mockRejectedValue(error);
    const warn = jest.mocked(logMainProcessWarn).mockClear();
    try {
      scheduler.noteWorktreeActivityForCodeReview(
        projectId,
        worktreeId,
        getWindow,
      );
      await settle();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[code-review] background review failed',
        { ...recoveryScope, error },
      );
      await expect(
        scheduler.requestManualCodeReviewRefresh(recoveryScope, getWindow),
      ).rejects.toBe(error);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([]);
      expect(sends).toEqual([]);
    } finally {
      fingerprint.mockRestore();
      scheduler.__testing.reset();
      warn.mockReset();
    }
  });
  it('keeps readable comment projections available while refusing agent mutations', async () => {
    install(rawState({ armed: 'damaged', commentThreads: [thread] }));
    await expect(
      persistence.readReviewCommentThread(recoveryScope),
    ).resolves.toMatchObject({ ok: true, threads: [thread] });
    await expect(mutations[2]()).rejects.toMatchObject({
      code: 'code_review_state_unavailable',
      reason: 'lossy_state',
    });
  });
  it('creates only on ENOENT and admits repaired state without a cached failure', async () => {
    rmSync(statePath(), { force: true });
    await expect(get()).resolves.not.toHaveProperty('mutationFailure');
    await save([thread]);
    expect(stored().commentThreads).toEqual([thread]);
    install('{broken');
    await expect(arm()).rejects.toMatchObject({ reason: 'invalid_json' });
    await expect(
      persistence.setCodeReviewArmed(projectId, 'healthy-recovery-wt'),
    ).resolves.toMatchObject({ armed: true });
    install(rawState({}));
    await expect(arm()).resolves.toMatchObject({ armed: true });
  });
  it('carries unreadable members and supersedes only a matching ID', async () => {
    const unreadable = [
      { id: thread.id, comments: ['evidence'] },
      null,
      { id: 'keep-me' },
    ];
    const readable = {
      ...thread,
      id: 'readable',
      extension: { keep: true },
      comments: [
        {
          id: 'c1',
          author: 'user',
          body: 'keep',
          createdAt: '',
          extension: true,
        },
      ],
      anchor: { ...thread.anchor, extension: true },
    };
    install(rawState({ commentThreads: [readable, ...unreadable] }));
    await arm();
    expect(stored().commentThreads).toEqual([readable, ...unreadable]);
    await expect(get()).resolves.toMatchObject({ skippedCommentThreads: 3 });
    await save([readable, thread]);
    expect(stored().commentThreads).toEqual([
      readable,
      thread,
      null,
      { id: 'keep-me' },
    ]);
    await expect(get()).resolves.toMatchObject({ skippedCommentThreads: 2 });
  });
  it('publishes skipped threads while a concurrent projection is still reading', async () => {
    install(rawState({ commentThreads: [null] }));
    const broadcastEntered = gate();
    const broadcastBlocked = gate();
    const readEntered = gate();
    const readBlocked = gate();
    const reviewDiff = jest.requireMock<typeof ReviewDiff>(
      '../lib/code-review-diff',
    );
    const fingerprint = jest
      .spyOn(reviewDiff, 'computeReviewFingerprint')
      .mockImplementationOnce(async () => {
        broadcastEntered.release();
        await broadcastBlocked.promise;
        return diff.fingerprint;
      });
    const saving = save();
    await broadcastEntered.promise;
    const readFile =
      jest.requireActual<typeof fsPromises>('node:fs/promises').readFile;
    const reader = jest
      .mocked(fsPromises.readFile)
      .mockImplementationOnce(async (...args) => {
        readEntered.release();
        await readBlocked.promise;
        return readFile(...args);
      });
    const reading = persistence.readCodeReviewStateProjection(
      projectId,
      worktreeId,
    );
    try {
      await readEntered.promise;
      broadcastBlocked.release();
      await saving;
      expect(sentPayloads.at(-1)?.payload).toMatchObject({
        skippedCommentThreads: 1,
      });
      expect(stored().commentThreads).toEqual([null]);
      readBlocked.release();
      await expect(reading).resolves.toMatchObject({
        skippedCommentThreads: 1,
      });
    } finally {
      broadcastBlocked.release();
      readBlocked.release();
      await Promise.allSettled([saving, reading]);
      reader.mockImplementation(readFile);
      fingerprint.mockRestore();
    }
  });
  it.each(['invalid_json', 'lossy_state', 'read_failed'])(
    'ends observed helper lifetimes on %s during generation',
    async (reason) => {
      scheduler.__testing.reset();
      install(rawState({ armed: true, diagrams: { dataModelDiff: envelope } }));
      const blocked = gate();
      hold = blocked;
      const generators = jest.requireMock<typeof Generator>(
        '../lib/code-review-generator',
      );
      const model = jest
        .spyOn(generators, 'generateReviewDataModelDiff')
        .mockImplementation(async () => {
          calls.push('dataModelDiff');
          await blocked.promise;
          return {
            value: {
              schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
              applicable: true,
              diagram: {
                schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
                current: { entities: [], relationships: [] },
                planned: { entities: [], relationships: [] },
                changes: [],
              },
            },
            usage: {},
          };
        });
      const readFile =
        jest.requireActual<typeof fsPromises>('node:fs/promises').readFile;
      const refreshing = scheduler.requestManualCodeReviewRefresh(
        recoveryScope,
        getWindow,
      );
      const rejection = expect(refreshing).rejects.toMatchObject({
        code: 'code_review_state_unavailable',
        reason,
      });
      try {
        await waitFor(() => calls.length === 3, 'all review generators');
        const raw =
          reason === 'invalid_json'
            ? '{damaged during generation'
            : rawState({ armed: reason === 'read_failed' ? true : 'yes' });
        install(raw);
        if (reason === 'read_failed') {
          jest
            .mocked(fsPromises.readFile)
            .mockRejectedValue(
              Object.assign(new Error('read failed'), { code: 'EIO' }),
            );
        }
        sends.length = 0;
        blocked.release();
        await rejection;
        expect(rawBytes()).toBe(raw);
        expect(sends).toEqual([]);
        const starts = helperTasks
          .filter((task) => task.startsWith('start '))
          .map((task) => task.slice(6))
          .sort();
        const failures = helperTasks
          .filter((task) => task.startsWith('failure '))
          .map((task) => task.slice(8))
          .sort();
        expect(starts).toHaveLength(3);
        expect(failures).toEqual(starts);
        expect(helperTasks).toHaveLength(6);
      } finally {
        blocked.release();
        await refreshing.catch(() => undefined);
        hold = null;
        model.mockRestore();
        jest.mocked(fsPromises.readFile).mockImplementation(readFile);
        scheduler.__testing.reset();
      }
    },
  );
  it('does not publish a result or update before rename and preserves old bytes on failure', async () => {
    install(rawState({}));
    const raw = rawBytes();
    const entered = gate();
    const blocked = gate();
    const rename =
      jest.requireActual<typeof fsPromises>('node:fs/promises').rename;
    const writer = jest
      .mocked(fsPromises.rename)
      .mockImplementationOnce(async (...args) => {
        entered.release();
        await blocked.promise;
        return rename(...args);
      });
    let published = false;
    const saving = save([thread]).then(() => {
      published = true;
    });
    try {
      await Promise.race([
        entered.promise,
        saving.then(() => {
          throw new Error('write bypassed rename gate');
        }),
      ]);
      expect(published).toBe(false);
      expect(sends).toEqual([]);
      expect(rawBytes()).toBe(raw);
      blocked.release();
      await saving;
      expect(published).toBe(true);
      expect(sends).toHaveLength(1);
      expect(stored().commentThreads).toEqual([thread]);
      sends.length = 0;
      const installed = rawBytes();
      writer.mockRejectedValueOnce(new Error('rename failed'));
      await expect(save()).rejects.toThrow('rename failed');
      expect(rawBytes()).toBe(installed);
      expect(sends).toEqual([]);
    } finally {
      blocked.release();
      await saving.catch(() => undefined);
      writer.mockImplementation(rename);
    }
  });
  it('rechecks the captured file after queueing, not the new routing branch', async () => {
    const projectId = CODE_REVIEW_CHAT_PROJECT_ID;
    const worktreeId = 'recovery-routing-wt';
    registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
    const captured = getCodeReviewStateFilePath(projectId, worktreeId);
    writeJson(captured, emptyCodeReviewFile());
    const entered = gate();
    const blocked = gate();
    const locking = withReviewStateLock(captured, async () => {
      entered.release();
      await blocked.promise;
    });
    await entered.promise;
    const queued = persistence.setCodeReviewArmed(projectId, worktreeId);
    writeFileSync(captured, '{damaged while queued');
    registerWorkspaceTypes(new Map([[projectId, 'single-repo']]));
    const other = getCodeReviewStateFilePath(projectId, worktreeId);
    writeJson(other, emptyCodeReviewFile());
    try {
      blocked.release();
      await locking;
      await expect(queued).rejects.toMatchObject({
        code: 'code_review_state_unavailable',
        reason: 'invalid_json',
        filePath: captured,
      });
      expect(readFileSync(captured, 'utf8')).toBe('{damaged while queued');
      expect(JSON.parse(readFileSync(other, 'utf8'))).toEqual(
        emptyCodeReviewFile(),
      );
    } finally {
      blocked.release();
      await locking;
      registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
    }
  });
});

it('registration IPC keeps colliding targets apart and preserves the historical key owner', async () => {
  // Both targets built `ipc-project--part--tree` before CAN-6848 PR 4.
  const legacyKey = 'ipc-project--part--tree';
  const historical = { projectId: 'ipc-project--part', worktreeId: 'tree' };
  const other = { projectId: 'ipc-project', worktreeId: 'part--tree' };
  const registryPath = getCodeReviewRegistryFilePath();
  const readTargets = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('targets' in parsed))
      throw new Error('registry has no targets');
    const { targets } = parsed;
    if (typeof targets !== 'object' || targets === null)
      throw new Error('registry targets are not an object');
    return { ...targets };
  };
  writeJson(registryPath, {
    version: 1,
    targets: {
      ...(existsSync(registryPath) ? readTargets() : {}),
      [legacyKey]: historical,
    },
  });
  for (const target of [historical, other, other])
    await invoke(IPC_CHANNELS.codeReviewRegister, target);
  const historicalKey = buildCodeReviewScopeKey(
    historical.projectId,
    historical.worktreeId,
  );
  const otherKey = buildCodeReviewScopeKey(other.projectId, other.worktreeId);
  // The persisted format: changing it orphans registered review chats.
  expect([historicalKey, otherKey]).toEqual([
    'cr2-1ipc-0project-0-0part-1tree',
    'cr2-1ipc-0project-1part-0-0tree',
  ]);
  const targets = readTargets();
  expect(targets[legacyKey]).toEqual(historical);
  expect(targets[historicalKey]).toMatchObject({
    ...historical,
    state: 'active',
  });
  expect(targets[otherKey]).toMatchObject({ ...other, state: 'active' });
  const registry = jest.requireActual<typeof Registry>(
    '../lib/code-review-registry',
  );
  expect(await registry.getCodeReviewTarget(legacyKey)).toEqual(historical);
  expect(await registry.getCodeReviewTarget(historicalKey)).toEqual(historical);
  expect(await registry.getCodeReviewTarget(otherKey)).toEqual(other);
  // A versioned key only ever names the target it encodes.
  await expect(
    registry.registerCodeReviewTarget(otherKey, historical),
  ).rejects.toMatchObject({ reason: 'owner_changed' });
  expect(readTargets()).toEqual(targets);
});

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
// Waits until the stored review holds `fingerprint`'s finished annotations
// and logic diagram: the run that made them has written its last artifact.
// Under load a run reaches its generators after any fixed wait, so a case
// that counts a run's calls waits for the run itself (CAN-6826).
async function waitForReviewOf(fingerprint: string): Promise<void> {
  const finished = (artifact?: {
    status: string;
    derivedFromFingerprint: string;
  }): boolean =>
    artifact?.derivedFromFingerprint === fingerprint &&
    artifact.status !== 'generating';
  // Counted, not timed: fake timers also fake Date. 1,500 x 10 ms is 15 s.
  for (let i = 0; i < 1_500; i += 1) {
    const file = await persistence.readCodeReviewState(
      WORKSPACE_ID,
      WORKTREE_ID,
    );
    if (finished(file.annotations) && finished(file.diagrams.logicDiff)) {
      await settle();
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for the review of ${fingerprint}`);
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
  // A finished run starts its queued rerun fire-and-forget. Left running, it
  // takes the next case's request as another rerun and writes the review
  // under that case, so each case waits until the scope has no task left.
  afterEach(() => scheduler.__testing.idle(scope));

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
      await waitForReviewOf('fp-4');
      const whileOpen = calls.filter((c) => c === 'annotations').length;
      scheduler.setCodeReviewModalOpen(scope, false, getWindow, 'golden');
      // Closing stops the poll, but a debounce an earlier tick scheduled
      // still fires once.
      diff.fingerprint = 'fp-5';
      calls.length = 0;
      await jest.advanceTimersByTimeAsync(
        scheduler.CODE_REVIEW_IDLE_DEBOUNCE_MS * 2,
      );
      await waitForReviewOf('fp-5');
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
    await scheduler.__testing.idle(scope);
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
