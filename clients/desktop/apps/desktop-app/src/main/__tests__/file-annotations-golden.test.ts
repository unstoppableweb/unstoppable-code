/**
 * Behavior golden for file annotations and comment threads (CAN-4104).
 *
 * A fixed sequence of renderer IPC calls (`file-annotations:*`) and agent
 * comment tools (GetFileComments / RespondToFileComment) runs against the real
 * state file in a temporary directory. Each step records the caller-visible
 * result or error message, every `file-annotations:updated` event, and the
 * parsed state file afterwards.
 *
 * The fixture was recorded from the pre-CAN-4104 path (IPC handlers and agent
 * tools calling `main/lib/file-annotations-persistence` directly). CAN-4104
 * routes the same calls through the desktop dispatcher; the only intended
 * difference is the per-document `revision` it adds, which the comparison
 * strips (`withoutRevisions`). Random UUIDs become `<uuid>`; `Date` is frozen.
 *
 * Re-record only for an intended behavior change:
 * `RECORD_FILE_ANNOTATIONS_GOLDEN=1 pnpm test file-annotations-golden`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as PathsModule from '../lib/paths';
import type * as PlanPersistenceModule from '../lib/plan-persistence';
import type * as WindowSendModule from '../lib/window-send';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ReviewAnnotation,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import { isRecord } from '../lib/type-guards';

const tempDir = mkdtempSync(join(tmpdir(), 'file-annotations-golden-'));
const FIXTURE = join(__dirname, 'fixtures', 'file-annotations-golden.json');
const RECORD = process.env.RECORD_FILE_ANNOTATIONS_GOLDEN === '1';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const mockEvents: Array<{ target: string; channel: string; payload: unknown }> =
  [];

jest.mock('../lib/window-send', () => ({
  ...jest.requireActual<typeof WindowSendModule>('../lib/window-send'),
  sendToWindow: (window: unknown, channel: string, payload: unknown): void => {
    mockEvents.push({ target: String(window), channel, payload });
  },
  sendToAllWindows: (channel: string, payload: unknown): void => {
    mockEvents.push({ target: 'all-windows', channel, payload });
  },
}));

jest.mock('../lib/paths', () => {
  const actual = jest.requireActual<typeof PathsModule>('../lib/paths');
  return {
    ...actual,
    getDataDir: (): string => tempDir,
    getFileAnnotationsStateFilePath: (
      projectId: string,
      worktreeId: string,
    ): string => join(tempDir, `${projectId}-${worktreeId}.json`),
  };
});

jest.mock('../lib/code-review-registry', () => ({
  getCodeReviewTarget: (
    worktreeId: string,
  ): { projectId: string; worktreeId: string } | null =>
    worktreeId === 'review-worktree'
      ? { projectId: 'review-project', worktreeId }
      : null,
}));

jest.mock('../canopy-tools/review-comment-core-client', () => ({
  readReviewCommentThread: (request: { threadId?: string }): Promise<unknown> =>
    Promise.resolve(
      request.threadId === undefined
        ? { ok: true, mode: 'all', threads: [] }
        : { ok: false, error: 'Comment thread not found.' },
    ),
  replyToReviewCommentThread: (): Promise<unknown> =>
    Promise.reject(new Error('Unexpected review reply.')),
}));

jest.mock('../lib/plan-persistence', () => {
  const actual = jest.requireActual<typeof PlanPersistenceModule>(
    '../lib/plan-persistence',
  );
  const mocked = {
    ...actual,
    readScopedPlanCommentThreads: (request: {
      threadId?: string;
    }): ReturnType<typeof PlanPersistenceModule.readScopedPlanCommentThreads> =>
      Promise.resolve(
        request.threadId === undefined
          ? { ok: true, mode: 'all', threads: [] }
          : {
              ok: false,
              reason: 'not-found',
              error: 'Plan comment thread not found.',
            },
      ),
  };
  // See canopy-tools-session-runtime.test.ts: read the grace lazily because
  // the main-process import graph re-enters this factory mid-load.
  Object.defineProperty(mocked, 'PLAN_COMMENT_HANDOFF_GRACE_MS', {
    enumerable: true,
    get: (): number => actual.PLAN_COMMENT_HANDOFF_GRACE_MS,
  });
  return mocked;
});

jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

// Two scopes have file roots, so their documents cross the dispatcher as
// root references; every other scope's files cross as host handles.
jest.mock('../lib/file-browser-roots', () => {
  const actual = jest.requireActual<typeof FileBrowserRootsModule>(
    '../lib/file-browser-roots',
  );
  const root = (
    repoId: string,
    absolutePath: string,
  ): FileBrowserRootsModule.FileBrowserRoot => ({
    repoId,
    repoName: repoId,
    absolutePath,
    rootKind: 'git-repo' as const,
    gitAware: true,
    excludedDescendantRoots: [],
  });
  const rootsByScope: Record<string, ReturnType<typeof root>[]> = {
    'p1/w1': [root('p1', '/workspace')],
    'review-project/review-worktree': [root('review', '/workspace/src')],
  };
  return {
    ...actual,
    getFileBrowserRoots: (
      projectId: string,
      worktreeId: string,
    ): Promise<FileBrowserRootsModule.FileBrowserRootsResult> => {
      const roots = rootsByScope[`${projectId}/${worktreeId}`];
      if (!roots) return Promise.reject(new Error('No file roots.'));
      return Promise.resolve({
        roots,
        rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
      });
    },
  };
});

import type * as FileBrowserRootsModule from '../lib/file-browser-roots';
import { registerIpcHandler } from '../ipc/register';
import { registerFileAnnotationsHandlers } from '../ipc/file-annotations';
import {
  getFileCommentsInSession,
  respondToFileCommentInSession,
} from '../canopy-tools/session-runtime';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';

const WINDOW = 'main-window';

interface Harness {
  ipc(channel: string, request: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * The CAN-4104 wiring: IPC handlers and agent tools reach the store through
 * `core.annotation.*` on a real desktop dispatcher, as a trusted renderer.
 */
function installHarness(): Harness {
  const dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  const queries = jest.spyOn(dispatcher, 'query');
  const instructions = jest.spyOn(dispatcher, 'instruction');
  registerFileAnnotationsHandlers(
    () => [WINDOW as never],
    dispatcher,
    () => ({
      principalId: 'local-desktop-user',
      clientInstanceId: 'electron-web-contents:1',
      authorityId: 'desktop-local',
      interfaceKind: 'desktop',
      grants: [],
    }),
  );
  return {
    ipc: (channel, request): Promise<unknown> => {
      const registered = jest
        .mocked(registerIpcHandler)
        .mock.calls.find(([name]) => name === channel);
      if (!registered) throw new Error(`No handler for ${channel}`);
      const handler: unknown = registered[1];
      if (typeof handler !== 'function') throw new Error('Not a handler');
      return Promise.resolve(
        Reflect.apply(handler, undefined, [{ sender: {} }, request]),
      );
    },
    close: async (): Promise<void> => {
      const operations = [...queries.mock.calls, ...instructions.mock.calls]
        .map(([name]) => name)
        .filter((name) => name.startsWith('core.annotation.'));
      // Every scenario surface is served by core.annotation.* operations.
      expect(new Set(operations)).toEqual(
        new Set([
          'core.annotation.document.get',
          'core.annotation.document.save',
          'core.annotation.document.append',
          'core.annotation.document.dismiss',
          'core.annotation.thread.get',
          'core.annotation.thread.list',
          'core.annotation.thread.reply',
        ]),
      );
      await dispatcher.shutdown();
    },
  };
}

const FILE = '/workspace/src/a.ts';

const annotation = (
  id: string,
  overrides: Partial<ReviewAnnotation> = {},
): ReviewAnnotation => ({
  id,
  repoId: 'repo',
  filePath: FILE,
  side: 'new',
  lineStart: 2,
  lineEnd: 3,
  kind: 'context',
  title: `Title ${id}`,
  body: `Body ${id}`,
  ...overrides,
});

const agentThread: ReviewCommentThread = {
  id: 'agent-thread',
  status: 'open',
  createdAt: '2026-10-01T00:00:00.000Z',
  anchorState: 'matched',
  anchor: {
    source: 'code',
    repoId: 'repo',
    filePath: FILE,
    side: 'new',
    lineStart: 2,
    lineEnd: 3,
    quote: 'two\nthree',
    annotationId: 'ann-1',
  },
  comments: [
    {
      id: 'agent-comment',
      author: 'agent',
      body: 'Could you confirm this?',
      createdAt: '2026-10-01T00:00:00.000Z',
      staged: false,
    },
  ],
};

const userThread = (staged: boolean): ReviewCommentThread => ({
  id: 'user-thread',
  status: 'open',
  createdAt: '2026-10-01T00:01:00.000Z',
  anchorState: 'matched',
  anchor: {
    source: 'code',
    view: 'diff',
    diff: { source: 'uncommitted', snapshotId: 'snapshot-1' },
    repoId: 'repo',
    filePath: FILE,
    side: 'old',
    lineStart: 5,
    quote: 'five',
  },
  comments: [
    {
      id: 'user-comment',
      author: 'user',
      body: 'Please rename this.',
      createdAt: '2026-10-01T00:01:00.000Z',
      staged,
    },
  ],
});

const scope = (
  projectId: string,
  worktreeId: string,
): { projectId: string; worktreeId: string } => ({
  projectId,
  worktreeId,
});

type Step = (harness: Harness) => Promise<unknown>;

const SCENARIO: Array<[label: string, scope: string, step: Step]> = [
  [
    'get a file with no state',
    'p1-w1',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsGet, {
        ...scope('p1', 'w1'),
        filePath: FILE,
      }),
  ],
  [
    'append annotations and threads, dropping invalid entries',
    'p1-w1',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsAppend, {
        ...scope('p1', 'w1'),
        filePath: FILE,
        annotations: [
          annotation('ann-1'),
          annotation('ann-bad-range', { lineStart: 4, lineEnd: 1 }),
          annotation('ann-bad-line', { lineStart: 0 }),
          { id: 'not-an-annotation' },
        ],
        commentThreads: [
          agentThread,
          {
            ...agentThread,
            id: 'bad-thread',
            anchor: { ...agentThread.anchor, lineEnd: 1 },
          },
          {
            ...agentThread,
            id: 'bad-unanchored-thread',
            anchor: { ...agentThread.anchor, unanchored: true },
          },
        ],
      }),
  ],
  [
    'append keeps stored entries with duplicate ids',
    'p1-w1',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsAppend, {
        ...scope('p1', 'w1'),
        filePath: FILE,
        annotations: [
          annotation('ann-1', { title: 'Replaced?' }),
          annotation('ann-2', { lineStart: 7, lineEnd: 7 }),
        ],
        commentThreads: [{ ...agentThread, status: 'resolved' }],
      }),
  ],
  [
    'get normalizes the requested path',
    'p1-w1',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsGet, {
        ...scope('p1', 'w1'),
        filePath: '/workspace/src/./nested/../a.ts',
      }),
  ],
  [
    'save a staged user thread and an edited annotation',
    'p1-w1',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsSave, {
        ...scope('p1', 'w1'),
        document: {
          filePath: FILE,
          annotations: [annotation('ann-1', { title: 'Edited title' })],
          commentThreads: [agentThread, userThread(true)],
        },
        baseCommentThreadIds: [agentThread.id],
      }),
  ],
  [
    'agent lists open threads (annotation thread hidden until submitted)',
    'p1-w1',
    (): Promise<unknown> => getFileCommentsInSession(scope('p1', 'w1')),
  ],
  [
    'agent cannot reply to a staged-only thread',
    'p1-w1',
    (): Promise<unknown> =>
      respondToFileCommentInSession({
        ...scope('p1', 'w1'),
        threadId: 'user-thread',
        body: 'Done early.',
        resolve: true,
        getWindow: () => null,
      }),
  ],
  [
    'submit the user comment',
    'p1-w1',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsSave, {
        ...scope('p1', 'w1'),
        document: {
          filePath: FILE,
          annotations: [annotation('ann-1', { title: 'Edited title' })],
          commentThreads: [agentThread, userThread(false)],
        },
        baseCommentThreadIds: [agentThread.id, 'user-thread'],
      }),
  ],
  [
    'agent reads the submitted thread',
    'p1-w1',
    (): Promise<unknown> =>
      getFileCommentsInSession({
        ...scope('p1', 'w1'),
        threadId: 'user-thread',
      }),
  ],
  [
    'agent replies and resolves',
    'p1-w1',
    (): Promise<unknown> =>
      respondToFileCommentInSession({
        ...scope('p1', 'w1'),
        threadId: 'user-thread',
        body: 'Renamed.',
        resolve: true,
        getWindow: () => null,
      }),
  ],
  [
    'a stale renderer save keeps the agent reply and resolution',
    'p1-w1',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsSave, {
        ...scope('p1', 'w1'),
        document: {
          filePath: FILE,
          annotations: [annotation('ann-1', { title: 'Edited title' })],
          commentThreads: [agentThread, userThread(false)],
        },
        baseCommentThreadIds: [agentThread.id, 'user-thread'],
      }),
  ],
  [
    'agent replies without resolving',
    'p1-w1',
    (): Promise<unknown> =>
      respondToFileCommentInSession({
        ...scope('p1', 'w1'),
        threadId: 'user-thread',
        body: 'One more note.',
        resolve: false,
        getWindow: () => null,
      }),
  ],
  [
    'dismiss an annotation and detach its thread',
    'p1-w1',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsDismiss, {
        ...scope('p1', 'w1'),
        filePath: FILE,
        annotationId: 'ann-1',
      }),
  ],
  [
    'dismiss on an untouched file writes an empty document',
    'p1-w1',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsDismiss, {
        ...scope('p1', 'w1'),
        filePath: '/workspace/src/b.ts',
        annotationId: 'ann-9',
      }),
  ],
  [
    'append a concurrent thread the renderer has not seen',
    'p1-w1',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsAppend, {
        ...scope('p1', 'w1'),
        filePath: FILE,
        annotations: [],
        commentThreads: [
          {
            ...agentThread,
            id: 'concurrent-thread',
            anchor: { ...agentThread.anchor, annotationId: undefined },
          },
        ],
      }),
  ],
  [
    'save deletes a thread from the base and keeps the concurrent one',
    'p1-w1',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsSave, {
        ...scope('p1', 'w1'),
        document: {
          filePath: FILE,
          annotations: [],
          commentThreads: [],
        },
        baseCommentThreadIds: [agentThread.id],
      }),
  ],
  [
    'agent lists open threads across files',
    'p1-w1',
    (): Promise<unknown> => getFileCommentsInSession(scope('p1', 'w1')),
  ],
  [
    'agent reply to an unknown thread',
    'p1-w1',
    (): Promise<unknown> =>
      respondToFileCommentInSession({
        ...scope('p1', 'w1'),
        threadId: 'missing-thread',
        body: 'Hello?',
        resolve: false,
        getWindow: () => null,
      }),
  ],
  [
    'agent read of an unknown thread',
    'p1-w1',
    (): Promise<unknown> =>
      getFileCommentsInSession({
        ...scope('p1', 'w1'),
        threadId: 'missing-thread',
      }),
  ],
  [
    'code-review chat scope maps to its target',
    'review-project-review-worktree',
    async (h): Promise<unknown> => {
      await h.ipc(IPC_CHANNELS.fileAnnotationsSave, {
        ...scope('review-project', 'review-worktree'),
        document: {
          filePath: FILE,
          annotations: [],
          commentThreads: [userThread(false)],
        },
        baseCommentThreadIds: [],
      });
      return respondToFileCommentInSession({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'review-worktree',
        threadId: 'user-thread',
        body: 'Reviewed.',
        resolve: true,
        getWindow: () => null,
      });
    },
  ],
  [
    'code-review chat scope without a target',
    'none',
    (): Promise<unknown> =>
      getFileCommentsInSession({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'unknown-worktree',
      }),
  ],
  [
    'invalid project id',
    'none',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsAppend, {
        ...scope('INVALID', 'w1'),
        filePath: FILE,
        annotations: [],
        commentThreads: [],
      }),
  ],
  [
    'invalid worktree id on read',
    'none',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsGet, {
        ...scope('p1', '../w1'),
        filePath: FILE,
      }),
  ],
  [
    'read-only recipient scope',
    'none',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsSave, {
        ...scope(SHARED_CONTAINER_VIEWER_PROJECT_ID, 'container-1'),
        document: { filePath: FILE, annotations: [], commentThreads: [] },
        baseCommentThreadIds: [],
      }),
  ],
  [
    'invalid annotation id',
    'none',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsDismiss, {
        ...scope('p1', 'w1'),
        filePath: FILE,
        annotationId: '../ann',
      }),
  ],
  [
    'save without a document path',
    'p2-w2',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsSave, {
        ...scope('p2', 'w2'),
        document: { filePath: 7, annotations: [], commentThreads: [] },
        baseCommentThreadIds: [],
      }),
  ],
  [
    'append without a file path',
    'p2-w2',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsAppend, {
        ...scope('p2', 'w2'),
        filePath: null,
        annotations: [],
        commentThreads: [],
      }),
  ],
  [
    'save with malformed collections',
    'p2-w2',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsSave, {
        ...scope('p2', 'w2'),
        document: { filePath: FILE, annotations: 'x', commentThreads: null },
      }),
  ],
  [
    'corrupt state reads as empty',
    'p3-w3',
    async (h): Promise<unknown> => {
      await writeFile(
        join(tempDir, 'p3-w3.json'),
        '{"version":1,"files":[',
        'utf8',
      );
      return h.ipc(IPC_CHANNELS.fileAnnotationsGet, {
        ...scope('p3', 'w3'),
        filePath: FILE,
      });
    },
  ],
  // CAN-7094: a write refuses a damaged state file instead of replacing it
  // with an empty document, and leaves the file as it was.
  [
    'a save refuses corrupt state and leaves it unchanged',
    'p3-w3',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsSave, {
        ...scope('p3', 'w3'),
        document: {
          filePath: FILE,
          annotations: [annotation('ann-1')],
          commentThreads: [],
        },
        baseCommentThreadIds: [],
      }),
  ],
  [
    'an unknown state version reads as empty',
    'p4-w4',
    async (h): Promise<unknown> => {
      await writeFile(
        join(tempDir, 'p4-w4.json'),
        JSON.stringify({
          version: 2,
          files: [{ filePath: FILE, annotations: [annotation('ann-1')] }],
        }),
        'utf8',
      );
      return h.ipc(IPC_CHANNELS.fileAnnotationsGet, {
        ...scope('p4', 'w4'),
        filePath: FILE,
      });
    },
  ],
  // CAN-7094: after a downgrade, a write never replaces a newer state file.
  [
    'a write refuses an unknown state version and leaves it unchanged',
    'p4-w4',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsAppend, {
        ...scope('p4', 'w4'),
        filePath: FILE,
        annotations: [annotation('ann-2')],
        commentThreads: [],
      }),
  ],
  [
    'existing data keeps unknown fields and drops invalid entries',
    'p5-w5',
    async (h): Promise<unknown> => {
      await writeFile(
        join(tempDir, 'p5-w5.json'),
        JSON.stringify({
          version: 1,
          extra: 'top-level field',
          files: [
            'not a document',
            { filePath: 42 },
            {
              filePath: '/workspace/src/../src/a.ts',
              legacyField: true,
              annotations: [
                { ...annotation('ann-1'), extraAnnotationField: { a: 1 } },
                { ...annotation('ann-2'), lineStart: 1.5 },
                { ...annotation('ann-3'), kind: 'unknown-kind' },
              ],
              commentThreads: [
                {
                  ...userThread(false),
                  extraThreadField: 'kept',
                  anchor: {
                    ...userThread(false).anchor,
                    extraAnchorField: 1,
                  },
                  comments: [
                    {
                      ...userThread(false).comments[0],
                      extraCommentField: [1, 2],
                    },
                  ],
                },
                {
                  ...userThread(false),
                  id: 'diff-without-identity',
                  anchor: { ...userThread(false).anchor, diff: undefined },
                },
                {
                  ...userThread(false),
                  id: 'bad-comment',
                  comments: [{ id: 'c', author: 'robot' }],
                },
              ],
            },
            {
              filePath: '/workspace/src/c.ts',
              annotations: 'not an array',
            },
          ],
        }),
        'utf8',
      );
      return h.ipc(IPC_CHANNELS.fileAnnotationsGet, {
        ...scope('p5', 'w5'),
        filePath: FILE,
      });
    },
  ],
  [
    'agent sees threads from existing data',
    'p5-w5',
    (): Promise<unknown> => getFileCommentsInSession(scope('p5', 'w5')),
  ],
  [
    'a write rewrites existing data in the current format',
    'p5-w5',
    (h): Promise<unknown> =>
      h.ipc(IPC_CHANNELS.fileAnnotationsAppend, {
        ...scope('p5', 'w5'),
        filePath: '/workspace/src/c.ts',
        annotations: [annotation('ann-c', { filePath: '/workspace/src/c.ts' })],
        commentThreads: [],
      }),
  ],
];

function normalize(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(UUID, '<uuid>');
  if (Array.isArray(value)) return value.map(normalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

/** CAN-4104 adds a per-document revision; equivalence ignores it. */
function withoutRevisions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRevisions);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !(
              key === 'revision' &&
              typeof value.filePath === 'string' &&
              Array.isArray(value.annotations)
            ),
        )
        .map(([key, child]) => [key, withoutRevisions(child)]),
    );
  }
  return value;
}

async function readState(name: string): Promise<unknown> {
  if (name === 'none') return null;
  try {
    const raw = await readFile(join(tempDir, `${name}.json`), 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      return { unparsed: raw };
    }
  } catch {
    return null;
  }
}

interface GoldenStep {
  label: string;
  outcome: { result: unknown } | { error: string };
  events: unknown[];
  state: unknown;
}

function isGoldenSteps(value: unknown): value is GoldenStep[] {
  return Array.isArray(value) && value.every(isRecord);
}

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('file annotations behavior golden', () => {
  beforeAll(() => {
    jest.useFakeTimers({
      now: new Date('2026-10-22T12:00:00.000Z'),
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
        'hrtime',
        'performance',
      ],
    });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('matches the recorded pre-dispatcher behavior', async () => {
    const harness = installHarness();
    const steps: GoldenStep[] = [];
    try {
      for (const [label, stateName, step] of SCENARIO) {
        mockEvents.length = 0;
        let outcome: GoldenStep['outcome'];
        try {
          outcome = { result: await step(harness) };
        } catch (error) {
          outcome = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
        steps.push({
          label,
          outcome,
          events: [...mockEvents],
          state: await readState(stateName),
        });
      }
    } finally {
      await harness.close();
    }
    const actual = normalize(withoutRevisions(steps));
    if (RECORD) {
      await writeFile(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    }
    const expected: unknown = JSON.parse(await readFile(FIXTURE, 'utf8'));
    if (!isGoldenSteps(expected)) throw new Error('Malformed golden fixture.');
    expect(actual).toEqual(expected);
  });
});
