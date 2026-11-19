// CAN-4167 golden: code review scheduling as desktop runs it, captured
// before core.review took it over. The scheduler, code-review persistence
// and the deletion fence are real, on a temporary data root; since PR 2c the
// `code-review:get`, `arm` and `save-comments` handlers dispatch
// `core.review.*` on a real desktop dispatcher. The branch diff
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
  type ReviewAnnotation,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import {
  ReviewCommentThreadSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
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
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { controllerMayInvoke } from '../remote-control/host/controller-profile';
import { relayAllows } from '../canopy-runtime/renderer-relay/surface-allowlist';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
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
let dispatcher: DesktopCanopyDispatcher;
// The dispatcher's calls since the case began, without their spies' types.
let dispatcherCalls: { calls(): unknown[][]; clear(): void };
const originalDataDir = process.env.CANOPY_DATA_DIR;

const RENDERER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'desktop-local',
  interfaceKind: 'desktop',
  grants: [],
};
// The caller the IPC handlers resolve for the next call: the renderer, or a
// paired controller's bridge.
let ipcCaller: CanopyCallerDescriptor = RENDERER;

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
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  const querySpy = jest.spyOn(dispatcher, 'query');
  const instructionSpy = jest.spyOn(dispatcher, 'instruction');
  dispatcherCalls = {
    calls: (): unknown[][] =>
      [...querySpy.mock.calls, ...instructionSpy.mock.calls].map(
        (call): unknown[] => [...call],
      ),
    clear: (): void => {
      querySpy.mockClear();
      instructionSpy.mockClear();
    },
  };
  const { registerCodeReviewHandlers } = await import('../ipc/code-review');
  registerCodeReviewHandlers(getWindow, dispatcher, () => ipcCaller);
  scheduler = await import('../lib/code-review-scheduler');
  persistence = await import('../lib/code-review-persistence');
});

afterAll(async () => {
  await dispatcher.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dispatcherCalls.clear();
  ipcCaller = RENDERER;
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

  // Pinned when CAN-4167 PR 2c moved these channels onto core.review. Since
  // CAN-6848 a write over a stored review that cannot be read is refused,
  // with its message, and the file is left as it is; a read still answers
  // the empty review.
  it('refuses a write over an unreadable review and leaves the file as it is', async () => {
    const file = getCodeReviewStateFilePath(WORKSPACE_ID, WORKTREE_ID);
    const original = readFileSync(file, 'utf8');
    const damaged = '{"version": 1, "commentThreads": [';
    writeFileSync(file, damaged);
    try {
      const read = await invoke<{ review: CodeReviewFile }>(
        IPC_CHANNELS.codeReviewGet,
        scope,
      );
      const save = await invoke(IPC_CHANNELS.codeReviewSaveComments, {
        ...scope,
        commentThreads: [],
      }).then(
        () => 'saved',
        (error: unknown) => (error instanceof Error ? error.message : error),
      );
      const arm = await invoke(IPC_CHANNELS.codeReviewArm, scope).then(
        (result) => result,
        (error: unknown) => (error instanceof Error ? error.message : error),
      );
      expect({
        read: shape(read.review),
        save,
        arm,
        unchanged: readFileSync(file, 'utf8') === damaged,
        calls,
      }).toMatchSnapshot();
    } finally {
      writeFileSync(file, original);
    }
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

// Remote Control reaches code review state only through these tunnelled
// channels. Pinned before CAN-4167 PR 2c moved them onto core.review.
describe('Remote Control access to code review state (CAN-4167 equivalence)', () => {
  const channels = [
    IPC_CHANNELS.codeReviewGet,
    IPC_CHANNELS.codeReviewArm,
    IPC_CHANNELS.codeReviewSaveComments,
  ];
  const request = { ...scope, commentThreads: [] };
  const allowed = (
    kind: 'desktop' | 'mobile' | 'browser' | 'hosted',
  ): Record<string, boolean> =>
    Object.fromEntries(
      channels.map((channel) => [
        channel,
        controllerMayInvoke(
          kind,
          channel,
          [request],
          getRemoteChannelDisposition,
        ),
      ]),
    );

  it('keeps each controller to the code review channels it had', () => {
    expect({
      desktop: allowed('desktop'),
      mobile: allowed('mobile'),
      browser: allowed('browser'),
      hosted: allowed('hosted'),
    }).toMatchSnapshot();
  });
});

// CAN-4167 PR 2c: code review state is served by core.review.* on the
// desktop dispatcher. These cases pin what the move keeps and what it adds.
describe('code review state on core.review (CAN-4167 equivalence)', () => {
  const other = { projectId: WORKSPACE_ID, worktreeId: 'golden-wt-dispatch' };
  const writer = (
    key: string,
  ): {
    caller: CanopyCallerDescriptor;
    metadata: { idempotencyKey: string };
  } => ({
    caller: { ...RENDERER, grants: ['core.review.write'] },
    metadata: { idempotencyKey: key },
  });
  const thread = (id: string): ReviewCommentThread => ({
    id,
    status: 'open',
    createdAt: '2026-11-16T00:00:00.000Z',
    anchorState: 'matched',
    anchor: { source: 'code', quote: 'one', filePath: 'src/a.ts' },
    comments: [
      {
        id: `${id}-c1`,
        author: 'user',
        body: 'Why one?',
        createdAt: '2026-11-16T00:00:00.000Z',
      },
    ],
  });
  /** The core.review operations dispatched since the case began. */
  const dispatched = (): { name: string; caller: unknown }[] =>
    dispatcherCalls
      .calls()
      .map((call) => {
        const [name, , options] = call;
        const caller =
          options && typeof options === 'object' && 'caller' in options
            ? options.caller
            : undefined;
        return { name: String(name), caller };
      })
      .filter(({ name }) => name.startsWith('core.review.'));
  const updates = (): unknown[] =>
    sentPayloads
      .filter(({ channel }) => channel === IPC_CHANNELS.codeReviewUpdated)
      .map(({ payload }) => payload);

  beforeEach(() => {
    sentPayloads.length = 0;
  });

  it('serves each state channel through core.review with only the grant it needs', async () => {
    await invoke(IPC_CHANNELS.codeReviewGet, other);
    await invoke(IPC_CHANNELS.codeReviewSaveComments, {
      ...other,
      commentThreads: [thread('e1')],
    });
    // A save announces the review to every window, as it always did.
    expect(updates()).toHaveLength(1);
    await invoke<CodeReviewGenerationResult>(IPC_CHANNELS.codeReviewArm, other);
    expect(dispatched().sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [
        ['core.review.arm', 'core.review.write'],
        ['core.review.comment.upsert', 'core.review.write'],
        ['core.review.get', 'core.review.read'],
      ].map(([name, grant]) => ({
        name,
        caller: { ...RENDERER, grants: [grant] },
      })),
    );
    const review = await persistence.readCodeReviewState(
      other.projectId,
      other.worktreeId,
    );
    expect(review.armed).toBe(true);
    expect(review.commentThreads.map(({ id }) => id)).toEqual(['e1']);
  });

  it("dispatches a paired controller's calls as its own device", async () => {
    ipcCaller = {
      principalId: 'remote-device:golden-device',
      clientInstanceId: 'remote-bridge:7',
      authorityId: 'desktop-local',
      interfaceKind: 'desktop',
      grants: ['core.workspace.read', 'core.chat.write'],
    };
    const read = await invoke<{ review: CodeReviewFile }>(
      IPC_CHANNELS.codeReviewGet,
      other,
    );
    await invoke(IPC_CHANNELS.codeReviewSaveComments, {
      ...other,
      commentThreads: read.review.commentThreads,
    });
    expect(dispatched()).toEqual(
      [
        ['core.review.get', 'core.review.read'],
        ['core.review.comment.upsert', 'core.review.write'],
      ].map(([name, grant]) => ({
        name,
        caller: { ...ipcCaller, grants: [grant] },
      })),
    );
  });

  it('dispatches the agent comment tools as their own principal', async () => {
    const { AgentToolOperationRefusedError, agentCoreOperations } =
      await import('../canopy-tools/agent-core-operations');
    const client = await import('../canopy-tools/review-comment-core-client');
    const tools = agentCoreOperations('review', dispatcher);
    const read = await client.readReviewCommentThread(
      { ...other, threadId: 'e1' },
      tools,
    );
    const reply = await client.replyToReviewCommentThread(
      { ...other, threadId: 'e1', body: 'Because.', resolve: true },
      tools,
    );
    const missing = await client.replyToReviewCommentThread(
      { ...other, threadId: 'missing', body: 'Hello?' },
      tools,
    );
    // The review family reaches nothing but its two rows: every other review
    // write the dispatcher serves is refused before dispatch, even with the
    // write grant. (comment.resolve isn't served at all.)
    const toolWriter: {
      caller: CanopyCallerDescriptor;
      metadata: { idempotencyKey: string };
    } = {
      caller: {
        ...RENDERER,
        principalId: 'desktop-review-comment-tools',
        clientInstanceId: 'desktop-main',
        grants: ['core.review.write'],
      },
      metadata: { idempotencyKey: 'tools-refused' },
    };
    const refusals = [
      tools.instruction('core.review.arm', { scope: other }, toolWriter),
      tools.instruction(
        'core.review.comment.upsert',
        { scope: other, commentThreads: [] },
        toolWriter,
      ),
    ];
    for (const [index, operation] of [
      'core.review.arm',
      'core.review.comment.upsert',
    ].entries()) {
      await expect(refusals[index]).rejects.toBeInstanceOf(
        AgentToolOperationRefusedError,
      );
      await expect(refusals[index]).rejects.toMatchObject({
        family: 'review',
        operation,
      });
    }
    expect(read).toMatchObject({ ok: true, mode: 'single' });
    expect(reply.review?.commentThreads[0]).toMatchObject({
      status: 'resolved',
      comments: [
        { author: 'user' },
        { author: 'agent', body: 'Because.', staged: false },
      ],
    });
    expect(missing).toEqual({ ok: false, error: 'Comment thread not found.' });
    expect(dispatched().map(({ name }) => name)).toEqual([
      'core.review.get',
      'core.review.comment.reply',
      'core.review.comment.reply',
    ]);
    expect(dispatched()).toMatchObject([
      {
        name: 'core.review.get',
        caller: {
          principalId: 'desktop-review-comment-tools',
          grants: ['core.review.read'],
        },
      },
      ...[1, 2].map(() => ({
        name: 'core.review.comment.reply',
        caller: {
          principalId: 'desktop-review-comment-tools',
          grants: ['core.review.write'],
        },
      })),
    ]);
    // The committed reply reaches every window, as the tools always sent it.
    expect(updates()).toMatchObject([
      {
        ...other,
        fingerprint: diff.fingerprint,
        review: { commentThreads: [{ status: 'resolved' }] },
      },
    ]);
  });

  it('announces a write from another binding to every window', async () => {
    const stored = await persistence.readCodeReviewState(
      other.projectId,
      other.worktreeId,
    );
    const resolved = ReviewCommentThreadSchema.parse(stored.commentThreads[0]);
    await dispatcher.instruction(
      'core.review.comment.upsert',
      {
        scope: other,
        commentThreads: [{ ...resolved, status: 'open' }],
        baseCommentThreads: [resolved],
      },
      writer('relay-reopen-1'),
    );
    expect(updates()).toMatchObject([
      {
        ...other,
        fingerprint: diff.fingerprint,
        review: { commentThreads: [{ status: 'open' }] },
      },
    ]);
  });

  it('replays a keyed write once and refuses its key with other parameters', async () => {
    const params = { scope: other, threadId: 'e1', body: 'Once.' };
    const first = await dispatcher.instruction(
      'core.review.comment.reply',
      params,
      writer('keyed-1'),
    );
    const repeat = await dispatcher.instruction(
      'core.review.comment.reply',
      params,
      writer('keyed-1'),
    );
    expect(repeat).toEqual(first);
    const stored = await persistence.readCodeReviewState(
      other.projectId,
      other.worktreeId,
    );
    expect(
      stored.commentThreads[0]?.comments.filter(({ body }) => body === 'Once.'),
    ).toHaveLength(1);
    await expect(
      dispatcher.instruction(
        'core.review.comment.reply',
        { ...params, body: 'Twice.' },
        writer('keyed-1'),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
  });

  it('refuses an unknown thread and a malformed one with typed errors', async () => {
    await expect(
      dispatcher.instruction(
        'core.review.comment.reply',
        { scope: other, threadId: 'missing', body: 'Hello?' },
        writer('missing-core.review.comment.reply'),
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.review.threadNotFound' },
    });
    await expect(
      dispatcher.instruction(
        'core.review.comment.upsert',
        {
          scope: other,
          commentThreads: [
            {
              ...ReviewCommentThreadSchema.parse(thread('e2')),
              anchor: { source: 'code', quote: 'one', filePath: '../a.ts' },
            },
          ],
        },
        writer('malformed-1'),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    // The IPC channel keeps the message it always gave.
    await expect(
      invoke(IPC_CHANNELS.codeReviewSaveComments, {
        ...other,
        commentThreads: [
          {
            ...thread('e2'),
            anchor: { ...thread('e2').anchor, filePath: '../a.ts' },
          },
        ],
      }),
    ).rejects.toThrow('This comment thread could not be saved.');
  });

  // core.review.comment.resolve isn't served yet. Code-review persistence
  // has no status change it makes under its lock, and that lock isn't
  // re-entrant, so a resolve composed over it would read and then save
  // outside one lock, and a thread deleted between the two would come back.
  // It is refused before anything runs, whichever binding sends it, and
  // nothing reads or writes the review: the desktop dispatcher doesn't
  // define it, the main window relay answers capability_unavailable, agents
  // can't reach it, and the advertised operations leave it out.
  it('refuses core.review.comment.resolve as unavailable, so a deleted thread stays deleted', async () => {
    const { statSync } = await import('node:fs');
    const { effectiveRuntimeOperations } = await import('@canopy/core-runtime');
    const { RELAY_DEFINITIONS } =
      await import('../canopy-runtime/renderer-relay/definitions');
    const { createRendererRelay } =
      await import('../canopy-runtime/renderer-relay/relay');
    const { createInterimInMemoryBindingProvider } =
      await import('../canopy-runtime/renderer-relay/interim-in-memory-binding');
    const resolveScope = {
      projectId: WORKSPACE_ID,
      worktreeId: 'golden-wt-resolve',
    };
    const resolvePath = getCodeReviewStateFilePath(
      resolveScope.projectId,
      resolveScope.worktreeId,
    );
    await invoke(IPC_CHANNELS.codeReviewSaveComments, {
      ...resolveScope,
      commentThreads: [thread('r1'), thread('r2')],
    });
    // The person deletes r1.
    await invoke(IPC_CHANNELS.codeReviewSaveComments, {
      ...resolveScope,
      commentThreads: [thread('r2')],
      baseCommentThreadIds: ['r1', 'r2'],
    });
    const bytes = readFileSync(resolvePath, 'utf8');
    const mtime = statSync(resolvePath).mtimeMs;
    // Every code-review persistence function the adapter or the update
    // publisher can call, and the scheduler's arm.
    const recorded = [
      ...(
        [
          'readCodeReviewState',
          'readCodeReviewStateProjection',
          'readReviewCommentThread',
          'saveCodeReviewComments',
          'appendReviewCommentReply',
          'setCodeReviewArmed',
          'setCodeReviewArtifact',
          'removeCodeReviewDiagramArtifact',
          'reevaluateReviewAnchors',
          'skippedCommentThreadsField',
        ] as const
      ).map((name) => jest.spyOn(persistence, name)),
      jest.spyOn(scheduler, 'armCodeReview'),
    ];
    sentPayloads.length = 0;
    dispatcherCalls.clear();
    const frame = {
      url: 'canopy://app',
      detached: false,
      isDestroyed: (): boolean => false,
    };
    const event = {
      sender: {
        id: 42,
        mainFrame: frame,
        getURL: (): string => frame.url,
        isDestroyed: (): boolean => false,
        on: (): void => undefined,
        removeListener: (): void => undefined,
      },
      senderFrame: frame,
    };
    const relay = createRendererRelay({
      bindingProvider: createInterimInMemoryBindingProvider(dispatcher),
      resolveSurface: () => ({
        surface: 'main',
        caller: {
          ...RENDERER,
          grants: ['core.review.read', 'core.review.write'],
        },
      }),
    });
    const params = (threadId: string): object => ({
      scope: resolveScope,
      threadId,
      resolved: true,
    });
    // The typed dispatcher has no core.review.comment.resolve to name, so
    // this calls it by name, as any binding would.
    const direct = (threadId: string, key: string): Promise<unknown> => {
      const instruction: unknown = Reflect.get(dispatcher, 'instruction');
      if (typeof instruction !== 'function')
        throw new Error('The dispatcher has no instruction method.');
      const call: unknown = Reflect.apply(instruction, dispatcher, [
        'core.review.comment.resolve',
        params(threadId),
        writer(key),
      ]);
      return Promise.resolve(call);
    };
    const relayed = (threadId: string, key: string): Promise<unknown> =>
      relay.invoke(event, {
        kind: 'request',
        method: 'core.review.comment.resolve',
        params: { ...params(threadId), _meta: { idempotencyKey: key } },
      });
    try {
      for (const [threadId, key] of [
        ['r1', 'resolve-direct-deleted'],
        ['r2', 'resolve-direct-kept'],
      ])
        await expect(direct(threadId, key)).rejects.toMatchObject({
          payload: {
            kind: 'capability_unavailable',
            message: 'The requested operation is unavailable.',
            retry: { kind: 'never' },
          },
        });
      // The relay allowlist names it; the relay refuses it, since the
      // desktop dispatcher doesn't define it.
      expect(
        relayAllows('main', 'instruction', 'core.review.comment.resolve'),
      ).toBe(true);
      for (const [threadId, key] of [
        ['r1', 'resolve-relay-deleted'],
        ['r2', 'resolve-relay-kept'],
      ])
        await expect(relayed(threadId, key)).resolves.toEqual({
          ok: false,
          error: {
            kind: 'capability_unavailable',
            message: 'core.review.comment.resolve is not available here.',
            retry: { kind: 'never' },
          },
        });
    } finally {
      relay.dispose();
      for (const spy of recorded) spy.mockRestore();
    }
    for (const spy of recorded) expect(spy).not.toHaveBeenCalled();
    // Only the two direct calls reached the dispatcher.
    expect(dispatched().map(({ name }) => name)).toEqual([
      'core.review.comment.resolve',
      'core.review.comment.resolve',
    ]);
    expect(readFileSync(resolvePath, 'utf8')).toBe(bytes);
    expect(statSync(resolvePath).mtimeMs).toBe(mtime);
    expect(updates()).toEqual([]);
    const stored = await persistence.readCodeReviewState(
      resolveScope.projectId,
      resolveScope.worktreeId,
    );
    expect(
      stored.commentThreads.map(({ id, status }) => ({ id, status })),
    ).toEqual([{ id: 'r2', status: 'open' }]);
    // What the main window relay advertises in its handshake and routes,
    // RELAY_DEFINITIONS, built from the desktop dispatcher's definitions:
    // the four review operations the desktop serves, and never resolve.
    const served = [
      'core.review.arm',
      'core.review.comment.reply',
      'core.review.comment.upsert',
      'core.review.get',
    ];
    expect(
      [
        ...Object.keys(RELAY_DEFINITIONS.queries),
        ...Object.keys(RELAY_DEFINITIONS.instructions),
        ...Object.keys(RELAY_DEFINITIONS.streams),
      ]
        .filter((name) => name.startsWith('core.review.'))
        .sort(),
    ).toEqual(served);
    // The runtime manifest, asked for unavailable operations too, never
    // offers resolve to an interface caller holding the write grant.
    expect(
      effectiveRuntimeOperations({
        profile: 'core+worker',
        definitions: RELAY_DEFINITIONS,
        principal: 'interface',
        grants: ['core.review.read', 'core.review.write'],
        includeUnavailable: true,
      }).find(({ name }) => name === 'core.review.comment.resolve'),
    ).toBeUndefined();
  });

  it('answers stopped for a worktree whose review state was removed', async () => {
    // The previous suite drained this worktree's review for deletion.
    await expect(
      dispatcher.instruction('core.review.arm', { scope }, writer('stopped-1')),
    ).resolves.toEqual({ status: 'stopped' });
    await expect(
      dispatcher.instruction(
        'core.review.comment.upsert',
        { scope, commentThreads: [] },
        writer('stopped-2'),
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'failed_precondition', code: 'core.review.stopped' },
    });
    await expect(
      invoke(IPC_CHANNELS.codeReviewSaveComments, {
        ...scope,
        commentThreads: [],
      }),
    ).rejects.toThrow('Code review state is being removed for this worktree.');
  });

  // Code-review persistence stores a finished generation's annotations as
  // they were written, as develop's generator and scheduler hand them over:
  // the file's bytes are develop's. A core.review read normalises each path
  // before the repository-relative check, and leaves out and counts one that
  // still leaves the repository, writing nothing.
  it("normalises a finished generation's annotation paths on read, and leaves out and counts the ones outside the repository", async () => {
    const annotationsScope = {
      projectId: WORKSPACE_ID,
      worktreeId: 'golden-wt-annotations',
    };
    const annotation = (id: string, filePath: string): ReviewAnnotation => ({
      id,
      repoId: '__workspace_root__',
      filePath,
      side: 'new',
      lineStart: 1,
      lineEnd: 1,
      kind: 'explanation',
      title: `Note ${id}`,
      body: 'Explains a line.',
    });
    await persistence.setCodeReviewArtifact(
      annotationsScope.projectId,
      annotationsScope.worktreeId,
      'annotations',
      {
        derivedFromFingerprint: 'fp-1',
        status: 'generating',
        data: null,
      },
    );
    // A model may spell a repository path with a leading `./`, a doubled
    // separator or a `..` that stays inside; a path that still leaves the
    // repository after normalisation is left out on its own and counted.
    const ready = {
      derivedFromFingerprint: 'fp-1',
      status: 'ready' as const,
      generatedAt: '2026-11-17T00:00:00.000Z',
      data: {
        schemaVersion: 1 as const,
        annotations: [
          annotation('a1', './src/a.ts'),
          annotation('a2', 'src//b.ts'),
          annotation('a3', '../outside.ts'),
          annotation('a4', 'src/../../outside.ts'),
          annotation('a5', '/etc/passwd'),
          annotation('a6', 'src\\..\\..\\outside.ts'),
          annotation('a7', 'C:\\outside.ts'),
          // Refused as written; kept only because normalisation runs first.
          annotation('a8', 'src/../src/c.ts'),
          annotation('a9', 'src/d.ts'),
        ],
      },
    };
    await persistence.setCodeReviewArtifact(
      annotationsScope.projectId,
      annotationsScope.worktreeId,
      'annotations',
      ready,
    );
    const annotationsPath = getCodeReviewStateFilePath(
      annotationsScope.projectId,
      annotationsScope.worktreeId,
    );
    const written = readFileSync(annotationsPath, 'utf8');
    const onDisk: unknown = JSON.parse(written);
    // Stored exactly as handed over: no path rewritten, no count added.
    expect(onDisk).toHaveProperty('annotations', ready);
    const review = await persistence.readCodeReviewState(
      annotationsScope.projectId,
      annotationsScope.worktreeId,
    );
    expect(review.annotations?.status).toBe('ready');
    expect(
      review.annotations?.data?.annotations.map(({ filePath }) => filePath),
    ).toEqual([
      './src/a.ts',
      'src//b.ts',
      '../outside.ts',
      'src/../../outside.ts',
      '/etc/passwd',
      'src\\..\\..\\outside.ts',
      'C:\\outside.ts',
      'src/../src/c.ts',
      'src/d.ts',
    ]);
    expect(review.annotations?.skippedAnnotations).toBeUndefined();
    const answered = await invoke<CodeReviewGetResponse>(
      IPC_CHANNELS.codeReviewGet,
      annotationsScope,
    );
    expect(answered.review.annotations?.status).toBe('ready');
    expect(
      answered.review.annotations?.data?.annotations.map(
        ({ id, filePath }) => ({ id, filePath }),
      ),
    ).toEqual([
      { id: 'a1', filePath: 'src/a.ts' },
      { id: 'a2', filePath: 'src/b.ts' },
      { id: 'a8', filePath: 'src/c.ts' },
      { id: 'a9', filePath: 'src/d.ts' },
    ]);
    expect(answered.review.annotations?.skippedAnnotations).toBe(5);
    expect(readFileSync(annotationsPath, 'utf8')).toBe(written);
  });

  // Code-review persistence keeps a stored annotation path such as
  // `./src/a.ts` as written, and the file stays writable. A core.review read
  // shows it normalised and leaves out and counts one outside the
  // repository; a write that does not replace the annotations carries them
  // through unchanged.
  // The artifacts are fresh, so arming writes the arming and nothing else.
  it('carries stored annotations through writes unchanged while a read normalises and counts them', async () => {
    const carryScope = {
      projectId: WORKSPACE_ID,
      worktreeId: 'golden-wt-carry',
    };
    const carryPath = getCodeReviewStateFilePath(
      carryScope.projectId,
      carryScope.worktreeId,
    );
    const stored = (filePath: string, id: string): object => ({
      id,
      repoId: '__workspace_root__',
      filePath,
      side: 'new',
      lineStart: 1,
      lineEnd: 1,
      kind: 'explanation',
      title: `Note ${id}`,
      body: 'Explains a line.',
    });
    const fingerprint = diff.fingerprint;
    const annotations = {
      derivedFromFingerprint: fingerprint,
      status: 'ready',
      generatedAt: '2026-11-17T00:00:00.000Z',
      data: {
        schemaVersion: 1,
        annotations: [
          stored('./src/a.ts', 'a1'),
          stored('src//b.ts', 'a2'),
          stored('/etc/passwd', 'a3'),
        ],
      },
    };
    const storedThread = {
      id: 'c1',
      status: 'open',
      createdAt: '2026-11-16T00:00:00.000Z',
      anchorState: 'matched',
      anchor: { source: 'code', quote: 'one', filePath: 'src/a.ts' },
      comments: [
        {
          id: 'c1-1',
          author: 'user',
          body: 'Why one?',
          createdAt: '2026-11-16T00:00:00.000Z',
        },
      ],
    };
    writeJson(carryPath, {
      version: 1,
      armed: false,
      commentThreads: [storedThread],
      annotations,
      diagrams: {
        logicDiff: {
          derivedFromFingerprint: fingerprint,
          status: 'ready',
          generatedAt: '2026-11-17T00:00:00.000Z',
          data: logicDiff,
        },
      },
    });
    const storedAnnotations = (): unknown => {
      const parsed: unknown = JSON.parse(readFileSync(carryPath, 'utf8'));
      return typeof parsed === 'object' &&
        parsed !== null &&
        'annotations' in parsed
        ? parsed.annotations
        : undefined;
    };
    const savedThread = {
      ...storedThread,
      comments: [
        ...storedThread.comments,
        {
          id: 'c1-2',
          author: 'user',
          body: 'And two?',
          createdAt: '2026-11-17T00:00:00.000Z',
        },
      ],
    };
    await expect(
      invoke(IPC_CHANNELS.codeReviewSaveComments, {
        ...carryScope,
        commentThreads: [savedThread],
      }),
    ).resolves.toMatchObject({ commentThreads: [savedThread] });
    expect(storedAnnotations()).toEqual(annotations);
    await expect(
      invoke(IPC_CHANNELS.codeReviewArm, carryScope),
    ).resolves.toEqual({ status: 'fresh' });
    expect(storedAnnotations()).toEqual(annotations);
    // The save's and the arm's code-review:updated pushes carry the review as
    // code-review persistence wrote it, as develop's pushes do: the stored
    // annotations as written, the one outside the repository included, and
    // no annotation count. Only a read normalises and counts them.
    const pushed = updates();
    expect(pushed).toHaveLength(2);
    for (const update of pushed)
      expect(update).toMatchObject({ ...carryScope, review: { annotations } });
    expect(JSON.stringify(pushed)).not.toContain('skippedAnnotations');
    const answered = await invoke<CodeReviewGetResponse>(
      IPC_CHANNELS.codeReviewGet,
      carryScope,
    );
    expect(answered.mutationFailure).toBeUndefined();
    expect(answered.review.armed).toBe(true);
    expect(answered.review.commentThreads).toEqual([savedThread]);
    expect(answered.review.annotations?.skippedAnnotations).toBe(1);
    expect(calls).toEqual([]);
    expect(
      answered.review.annotations?.data?.annotations.map(
        ({ id, filePath }) => ({
          id,
          filePath,
        }),
      ),
    ).toEqual([
      { id: 'a1', filePath: 'src/a.ts' },
      { id: 'a2', filePath: 'src/b.ts' },
    ]);
  });

  // Develop refused a stored diagram whose body the desktop reader drops
  // (CAN-6848), so its next write could not store it as null. A diagram
  // with the right schema version and a malformed body is lossy_state, and
  // every write is refused before anything is written.
  it.each(['logicDiff', 'dataModelDiff'] as const)(
    'refuses writes over a stored %s with a malformed body and leaves the file as it is',
    async (kind) => {
      const malformedScope = {
        projectId: WORKSPACE_ID,
        worktreeId: `golden-wt-malformed-${kind.toLowerCase()}`,
      };
      const malformedPath = getCodeReviewStateFilePath(
        malformedScope.projectId,
        malformedScope.worktreeId,
      );
      writeJson(malformedPath, {
        version: 1,
        armed: false,
        commentThreads: [],
        diagrams: {
          [kind]: {
            derivedFromFingerprint: 'fp-old',
            status: 'ready',
            data: {
              schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
              current: 'damaged',
            },
          },
        },
      });
      const raw = readFileSync(malformedPath, 'utf8');
      const refusal = {
        code: 'code_review_state_unavailable',
        reason: 'lossy_state',
      };
      await expect(
        persistence.setCodeReviewArmed(
          malformedScope.projectId,
          malformedScope.worktreeId,
        ),
      ).rejects.toMatchObject(refusal);
      expect(readFileSync(malformedPath, 'utf8')).toBe(raw);
      await expect(
        persistence.setCodeReviewArtifact(
          malformedScope.projectId,
          malformedScope.worktreeId,
          kind,
          {
            derivedFromFingerprint: 'fp-new',
            status: 'generating',
            data: null,
          },
        ),
      ).rejects.toMatchObject(refusal);
      expect(readFileSync(malformedPath, 'utf8')).toBe(raw);
      await expect(
        invoke(IPC_CHANNELS.codeReviewArm, malformedScope),
      ).rejects.toMatchObject(refusal);
      expect(readFileSync(malformedPath, 'utf8')).toBe(raw);
      const answered = await invoke<CodeReviewGetResponse>(
        IPC_CHANNELS.codeReviewGet,
        malformedScope,
      );
      expect(answered.mutationFailure).toMatchObject(refusal);
      expect(answered.review.diagrams[kind]).toMatchObject({
        status: 'ready',
        data: null,
      });
      expect(calls).toEqual([]);
      expect(updates()).toEqual([]);
    },
  );

  it('serves review state to the main window relay, reads only when read-only, and nothing to App Advisor or Remote Control', () => {
    const writes = [
      'core.review.arm',
      'core.review.comment.upsert',
      'core.review.comment.reply',
      'core.review.comment.resolve',
    ];
    expect(relayAllows('main', 'query', 'core.review.get')).toBe(true);
    expect(relayAllows('main', 'query', 'core.review.get', 'read-only')).toBe(
      true,
    );
    expect(relayAllows('app-advisor', 'query', 'core.review.get')).toBe(false);
    for (const method of writes) {
      expect(relayAllows('main', 'instruction', method)).toBe(true);
      expect(relayAllows('main', 'instruction', method, 'read-only')).toBe(
        false,
      );
      expect(relayAllows('app-advisor', 'instruction', method)).toBe(false);
    }
    // A paired controller never reaches the relay; it keeps the channels.
    for (const kind of ['desktop', 'mobile', 'browser', 'hosted'] as const)
      expect(
        controllerMayInvoke(
          kind,
          IPC_CHANNELS.canopyCoreRelay,
          [{ kind: 'query', method: 'core.review.get' }],
          getRemoteChannelDisposition,
        ),
      ).toBe(false);
  });

  // CAN-6848 on core.review: a write over a stored review it cannot write
  // safely is refused before anything is written, whichever caller sends it.
  describe('refusal before any write, for each core.review caller (CAN-6848)', () => {
    const lossyScope = {
      projectId: WORKSPACE_ID,
      worktreeId: 'golden-wt-lossy',
    };
    const lossyPath = (): string =>
      getCodeReviewStateFilePath(lossyScope.projectId, lossyScope.worktreeId);
    const lossy = `${JSON.stringify(
      {
        version: 1,
        armed: true,
        commentThreads: [thread('l1')],
        diagrams: {},
        future: { evidence: true },
      },
      null,
      2,
    )}\n`;
    const install = (raw: string): void => {
      rmSync(lossyPath(), { recursive: true, force: true });
      mkdirSync(join(lossyPath(), '..'), { recursive: true });
      writeFileSync(lossyPath(), raw);
    };
    const refusal = {
      code: 'code_review_state_unavailable',
      reason: 'lossy_state',
    };
    const message =
      "Couldn't update this code review because code-review.json could not be read safely. Keep the original file and repair it before trying again.";
    const damaged = (stateFailure: string): unknown => ({
      kind: 'failed_precondition',
      code: 'core.review.damagedState',
      message,
      details: { reason: 'DAMAGED_STATE', stateFailure },
    });
    const save = (): Promise<unknown> =>
      invoke(IPC_CHANNELS.codeReviewSaveComments, {
        ...lossyScope,
        commentThreads: [thread('l1'), thread('l2')],
      });
    /** Each core.review call since the case began, by caller, in name order. */
    const principals = (): string[] =>
      dispatched()
        .map(({ name, caller }) =>
          caller && typeof caller === 'object' && 'principalId' in caller
            ? `${name} ${String(caller.principalId)}`
            : name,
        )
        .sort();

    beforeEach(() => {
      install(lossy);
      dispatcherCalls.clear();
    });

    it('refuses the renderer through the IPC channels and reports why on get', async () => {
      await expect(save()).rejects.toMatchObject(refusal);
      await expect(
        invoke(IPC_CHANNELS.codeReviewArm, lossyScope),
      ).rejects.toMatchObject(refusal);
      expect(readFileSync(lossyPath(), 'utf8')).toBe(lossy);
      await expect(
        invoke(IPC_CHANNELS.codeReviewGet, lossyScope),
      ).resolves.toMatchObject({
        review: { commentThreads: [thread('l1')] },
        mutationFailure: { ...refusal, message },
      });
      expect(principals()).toEqual([
        'core.review.arm local-desktop-user',
        'core.review.comment.upsert local-desktop-user',
        'core.review.get local-desktop-user',
      ]);
      expect(updates()).toEqual([]);
      expect(calls).toEqual([]);
    });

    // The relay passes no `details` of a core error to the renderer, so the
    // window learns the reason from core.review.get's `stateFailure`.
    it('refuses the main window through the renderer relay, and its get says why', async () => {
      const { createRendererRelay } =
        await import('../canopy-runtime/renderer-relay/relay');
      const { createInterimInMemoryBindingProvider } =
        await import('../canopy-runtime/renderer-relay/interim-in-memory-binding');
      const frame = {
        url: 'canopy://app',
        detached: false,
        isDestroyed: (): boolean => false,
      };
      const event = {
        sender: {
          id: 41,
          mainFrame: frame,
          getURL: (): string => frame.url,
          isDestroyed: (): boolean => false,
          on: (): void => undefined,
          removeListener: (): void => undefined,
        },
        senderFrame: frame,
      };
      const relay = createRendererRelay({
        bindingProvider: createInterimInMemoryBindingProvider(dispatcher),
        resolveSurface: () => ({
          surface: 'main',
          caller: {
            ...RENDERER,
            grants: ['core.review.read', 'core.review.write'],
          },
        }),
      });
      const relayed = (method: string, params: object): Promise<unknown> =>
        relay.invoke(event, { kind: 'request', method, params });
      const refusedOverRelay = {
        ok: false,
        error: {
          kind: 'failed_precondition',
          code: 'core.review.damagedState',
          message,
        },
      };
      try {
        await expect(
          relayed('core.review.comment.upsert', {
            scope: lossyScope,
            commentThreads: [thread('l1'), thread('l2')],
            _meta: { idempotencyKey: 'relay-lossy' },
          }),
        ).resolves.toMatchObject(refusedOverRelay);
        await expect(
          relayed('core.review.comment.reply', {
            scope: lossyScope,
            threadId: 'l1',
            body: 'Because.',
            _meta: { idempotencyKey: 'relay-lossy-reply' },
          }),
        ).resolves.toMatchObject(refusedOverRelay);
        expect(readFileSync(lossyPath(), 'utf8')).toBe(lossy);
        await expect(
          relayed('core.review.get', { scope: lossyScope }),
        ).resolves.toMatchObject({
          ok: true,
          value: {
            review: { commentThreads: [thread('l1')] },
            stateFailure: 'lossy_state',
          },
        });
      } finally {
        relay.dispose();
      }
      expect(principals()).toEqual([
        'core.review.comment.reply local-desktop-renderer:main',
        'core.review.comment.upsert local-desktop-renderer:main',
        'core.review.get local-desktop-renderer:main',
      ]);
      // One relay session: the refused writes and the read share one caller.
      const callers = dispatched().map(({ caller }) => caller);
      expect(callers).toHaveLength(3);
      for (const caller of callers) expect(caller).toEqual(callers[0]);
      expect(updates()).toEqual([]);
    });

    it("refuses a paired controller's device through the IPC channels", async () => {
      ipcCaller = {
        principalId: 'remote-device:golden-device',
        clientInstanceId: 'remote-bridge:7',
        authorityId: 'desktop-local',
        interfaceKind: 'desktop',
        grants: ['core.workspace.read', 'core.chat.write'],
      };
      await expect(save()).rejects.toMatchObject(refusal);
      await expect(
        invoke(IPC_CHANNELS.codeReviewArm, lossyScope),
      ).rejects.toMatchObject(refusal);
      expect(readFileSync(lossyPath(), 'utf8')).toBe(lossy);
      expect(principals()).toEqual([
        'core.review.arm remote-device:golden-device',
        'core.review.comment.upsert remote-device:golden-device',
      ]);
      expect(updates()).toEqual([]);
      expect(calls).toEqual([]);
    });

    it('refuses the agent comment tools with each reason, while they can still read the thread', async () => {
      const { agentCoreOperations } =
        await import('../canopy-tools/agent-core-operations');
      const client = await import('../canopy-tools/review-comment-core-client');
      const tools = agentCoreOperations('review', dispatcher);
      const reply = (): Promise<unknown> =>
        client.replyToReviewCommentThread(
          { ...lossyScope, threadId: 'l1', body: 'Because.', resolve: true },
          tools,
        );
      await expect(
        client.readReviewCommentThread(
          { ...lossyScope, threadId: 'l1' },
          tools,
        ),
      ).resolves.toEqual({ ok: true, mode: 'single', thread: thread('l1') });
      await expect(reply()).rejects.toMatchObject({
        payload: damaged('lossy_state'),
      });
      expect(readFileSync(lossyPath(), 'utf8')).toBe(lossy);
      for (const [stateFailure, raw] of [
        ['invalid_json', '{"version": 1, "commentThreads": ['],
        ['unsupported_version', '{"version": 2, "commentThreads": []}'],
      ]) {
        install(raw);
        await expect(reply()).rejects.toMatchObject({
          payload: damaged(stateFailure),
        });
        expect(readFileSync(lossyPath(), 'utf8')).toBe(raw);
      }
      rmSync(lossyPath(), { force: true });
      mkdirSync(lossyPath());
      writeFileSync(join(lossyPath(), 'evidence'), 'keep');
      try {
        await expect(reply()).rejects.toMatchObject({
          payload: damaged('read_failed'),
        });
        expect(readFileSync(join(lossyPath(), 'evidence'), 'utf8')).toBe(
          'keep',
        );
      } finally {
        rmSync(lossyPath(), { recursive: true, force: true });
      }
      expect(principals()).toEqual([
        ...Array.from(
          { length: 4 },
          () => 'core.review.comment.reply desktop-review-comment-tools',
        ),
        'core.review.get desktop-review-comment-tools',
      ]);
      expect(updates()).toEqual([]);
    });
  });
});
