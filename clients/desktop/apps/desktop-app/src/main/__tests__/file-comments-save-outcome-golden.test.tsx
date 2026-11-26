/**
 * CAN-4735: what useFileComments does when a save fails, over the real
 * desktop dispatcher, IPC registration and preload error restore, and for
 * some cases a real Remote Control host session. A save whose folder flush
 * failed after the install answers outcome unknown as data, with the stored
 * document (or, if main can't read it either, the sent one at its base
 * revision), so neither preload's error cache nor Remote Control can lose
 * it: the hook retires the edit and never replays it over a later write. A
 * rejected save, including a conflict whose code didn't arrive, keeps the
 * develop behavior: the edit is replayed on a document that moved. The agent
 * reply tool answers the same unknown outcome with a reload message.
 * Node's environment runs the main graph; React renders into a JSDOM.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type * as PathsModule from '../lib/paths';

/**
 * The real file system. The next flush of `failFlushOf` fails once and then
 * runs `onFlushFailed`; `beforeNextRead` runs before the next read of its
 * path, the read main does after a failed flush to answer the save.
 */
const mockFs = {
  failFlushOf: undefined as string | undefined,
  onFlushFailed: undefined as (() => void) | undefined,
  beforeNextRead: undefined as
    | { path: string; run: () => Promise<void> }
    | undefined,
};

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    readFile: async (
      ...args: Parameters<typeof actual.readFile>
    ): Promise<string | Buffer> => {
      const hold = mockFs.beforeNextRead;
      if (hold && args[0] === hold.path) {
        mockFs.beforeNextRead = undefined;
        await hold.run();
      }
      return actual.readFile(...args);
    },
    open: async (
      ...args: Parameters<typeof actual.open>
    ): ReturnType<typeof actual.open> => {
      const handle = await actual.open(...args);
      const [folder, flags] = args;
      // A folder flush opens 'r', or 'r+' on Windows; state files open 'wx'.
      if ((flags !== 'r' && flags !== 'r+') || folder !== mockFs.failFlushOf)
        return handle;
      handle.sync = (): Promise<void> => {
        mockFs.failFlushOf = undefined;
        const armed = mockFs.onFlushFailed;
        mockFs.onFlushFailed = undefined;
        armed?.();
        return Promise.reject(
          Object.assign(new Error('EIO: flush failed'), { code: 'EIO' }),
        );
      };
      return handle;
    },
  };
});

const mockTempDir = mkdtempSync(path.join(tmpdir(), 'file-comments-outcome-'));
const mockCheckout = path.join(mockTempDir, 'checkout');

jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../lib/paths'),
  getDataDir: (): string => mockTempDir,
  getFileAnnotationsStateFilePath: (
    projectId: string,
    worktreeId: string,
  ): string =>
    path.join(
      mockTempDir,
      'workspaces',
      projectId,
      'worktree-data',
      worktreeId,
      'file-annotations.json',
    ),
}));

jest.mock('../lib/file-browser-roots', () => ({
  getFileBrowserRoots: (): Promise<unknown> => {
    const root = {
      repoId: 'root',
      repoName: 'root',
      absolutePath: mockCheckout,
      rootKind: 'git-repo' as const,
      gitAware: true,
      excludedDescendantRoots: [],
    };
    return Promise.resolve({
      roots: [root],
      rootMap: new Map([['root', root]]),
    });
  },
}));

import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  decodeIpcAppError,
  formatIpcLegacyError,
  IpcAppErrorRejection,
} from '@canopy/desktop-shared/ipc/app-error-rejection';
import {
  IPC_CHANNELS,
  type FileAnnotationDocument,
} from '@canopy/desktop-shared/types';
import { ANNOTATION_ERROR_CODES } from '@canopy/protocol/canopy-core';
import { annotationCaller } from '../canopy-runtime/annotation-legacy-projection';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { agentCoreOperations } from '../canopy-tools/agent-core-operations';
import { respondToFileComment } from '../canopy-tools/file-comment-core-client';
import { toIpcRejection } from '../ipc/app-error-rejection';
import { registerFileAnnotationsHandlers } from '../ipc/file-annotations';
import type { HostBridge } from '../remote-control/host/bridge-window';
import { RemoteHostSession } from '../remote-control/host/host-session';
import { RemoteUploadStore } from '../remote-control/host/uploads';
import {
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
} from '../remote-control/remote-protocol';
import { RpcPeer } from '../remote-control/transport/rpc-peer';
import {
  flushRelay,
  InMemoryRelayHub,
} from '../remote-control/__tests__/in-memory-relay';
import {
  createTestDevice,
  openControlSession,
} from '../remote-control/__tests__/session-pair';
import {
  resolveIpcAppError,
  resolveIpcOperationFailure as resolvePreloadOperationFailure,
  restoreIpcAppError,
} from '../../preload/ipc-app-errors';
import { resolveIpcOperationFailure } from '../../renderer/src/lib/ipc-operation-failure';
import {
  useFileComments,
  type UseFileComments,
} from '../../renderer/src/components/chat/useFileComments';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const dom = new JSDOM('<div id="root"></div>');
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
});

const filePath = path.join(mockCheckout, 'src', 'a.ts');
const callbacks = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
const event: IpcMainInvokeEvent = {
  sender: new BrowserWindow().webContents,
  senderFrame: null,
  frameId: 1,
  processId: 1,
  type: 'frame',
  preventDefault: () => undefined,
  defaultPrevented: false,
};

/** The Electron message of the last rejected save, as preload received it. */
let lastSaveWrapper = '';

const desktopCaller = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'desktop-local',
  interfaceKind: 'desktop' as const,
  grants: [],
};

/** One IPC call as the renderer sees it: main's rejection, restored by preload. */
async function invoke(channel: string, request: unknown): Promise<unknown> {
  const callback = callbacks.get(channel);
  if (!callback) throw new Error(`No handler for ${channel}`);
  try {
    return await Promise.resolve(callback(event, request));
  } catch (rejection) {
    const wrapper = formatIpcLegacyError(channel, String(rejection));
    if (channel === IPC_CHANNELS.fileAnnotationsSave) lastSaveWrapper = wrapper;
    return restoreIpcAppError(new Error(wrapper));
  }
}

/**
 * Another failure with the same message but other semantics reaches preload,
 * which then attributes no failure to that message (its cache conflicts).
 */
function collideInPreloadCache(): void {
  const decoded = decodeIpcAppError(lastSaveWrapper);
  if (!decoded) throw new Error('No rejected save to collide with');
  const other = new IpcAppErrorRejection(decoded.legacy, undefined, null, {
    status: 'internal',
    retry: { kind: 'never' },
  });
  try {
    restoreIpcAppError(
      new Error(
        formatIpcLegacyError(IPC_CHANNELS.fileAnnotationsSave, String(other)),
      ),
    );
  } catch {
    // Restoring always rethrows; only the cache entry matters here.
  }
}

/**
 * A paired desktop controller: its calls cross the real host session over an
 * encrypted in-memory relay, and the host's bridge window calls main.
 */
interface RemoteControl {
  invoke: (channel: string, request: unknown) => Promise<unknown>;
  close: () => void;
}

async function openRemoteControl(): Promise<RemoteControl> {
  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, 'Laptop');
  const studio = createTestDevice(hub, 'Studio');
  await flushRelay();
  const { initiator, responder } = await openControlSession(laptop, studio);
  const version = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    appVersion: '1.4.0',
  };
  const bridge: HostBridge = {
    getChatInterest: (): undefined => undefined,
    window: null,
    invoke: (channel: string, args: unknown[]): Promise<unknown> =>
      invoke(channel, args[0]),
    post: (): void => undefined,
    onPush: (): (() => void) => (): void => undefined,
    onClosed: (): (() => void) => (): void => undefined,
    destroy: (): void => undefined,
  };
  const session = new RemoteHostSession({
    session: responder,
    kind: 'desktop',
    attributedDeviceId: responder.peerDeviceId,
    createBridge: (): Promise<HostBridge> => Promise.resolve(bridge),
    mainWindowPushes: { subscribe: (): (() => void) => (): void => undefined },
    uploads: new RemoteUploadStore(path.join(mockTempDir, 'remote-uploads')),
    readFile: (): Promise<never> =>
      Promise.reject(new Error('no reads in this test')),
    disposition: (): 'tunnel' => 'tunnel',
    isAuthorized: (): boolean => true,
    version,
    hello: (): { name: string; platform: 'darwin' } => ({
      name: 'Studio',
      platform: 'darwin',
    }),
    onClose: (): void => undefined,
  });
  const controller = new RpcPeer(initiator, {
    onRequest: (): Promise<never> =>
      Promise.reject(new Error('unexpected request')),
    onEvent: (): void => undefined,
  });
  await controller.request(REMOTE_METHODS.hello, { version });
  await session.start();
  return {
    invoke: (channel, request): Promise<unknown> =>
      controller.request(REMOTE_METHODS.invoke, { channel, args: [request] }),
    close: (): void => {
      controller.close('closed');
      session.rpc.close('closed');
    },
  };
}

/** Set while the hook's calls go through Remote Control instead of IPC. */
let remoteControl: RemoteControl | undefined;

/** The renderer's call: local IPC, or Remote Control while it is open. */
function rendererInvoke(channel: string, request: unknown): Promise<unknown> {
  return remoteControl
    ? remoteControl.invoke(channel, request)
    : invoke(channel, request);
}

/**
 * Preload's cache sees two outcome-unknown failures with the same message
 * but other semantics, so it attributes no failure to that message.
 */
async function poisonOutcomeUnknownInPreloadCache(
  projectId: string,
): Promise<string> {
  await saveAsOther(projectId, (document) => ({
    ...document,
    commentThreads: [
      {
        ...theirThread,
        id: 'poison-thread',
        comments: [{ ...theirComment, id: 'poison', staged: false }],
      },
    ],
  }));
  // A real outcome-unknown failure: a reply whose flush fails after install.
  mockFs.failFlushOf = stateFolder(projectId);
  const failure = await runtime
    .instruction(
      'core.annotation.thread.reply',
      {
        scope: { projectId, worktreeId: 'tree' },
        threadId: 'poison-thread',
        body: 'Poison.',
        resolve: false,
      },
      { caller: annotationCaller(desktopCaller, 'write') },
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(failure).toMatchObject({
    payload: { code: ANNOTATION_ERROR_CODES.OUTCOME_UNKNOWN },
  });
  const wrapper = formatIpcLegacyError(
    IPC_CHANNELS.fileAnnotationsSave,
    String(toIpcRejection(IPC_CHANNELS.fileAnnotationsSave, failure)),
  );
  for (const thrown of [
    new Error(wrapper),
    new Error(
      formatIpcLegacyError(
        IPC_CHANNELS.fileAnnotationsSave,
        String(
          new IpcAppErrorRejection(
            decodeIpcAppError(wrapper)?.legacy ?? '',
            undefined,
            null,
            { status: 'internal', retry: { kind: 'never' } },
          ),
        ),
      ),
    ),
  ]) {
    try {
      restoreIpcAppError(thrown);
    } catch {
      // Restoring always rethrows; only the cache entry matters here.
    }
  }
  return wrapper;
}

function getStored(projectId: string): Promise<FileAnnotationDocument> {
  return invoke(IPC_CHANNELS.fileAnnotationsGet, {
    projectId,
    worktreeId: 'tree',
    filePath,
  }) as Promise<FileAnnotationDocument>;
}

/** Another writer: saves `change` over the stored document. */
async function saveAsOther(
  projectId: string,
  change: (document: FileAnnotationDocument) => FileAnnotationDocument,
): Promise<void> {
  const stored = await getStored(projectId);
  await invoke(IPC_CHANNELS.fileAnnotationsSave, {
    projectId,
    worktreeId: 'tree',
    document: change(stored),
    baseCommentThreadIds: stored.commentThreads.map((thread) => thread.id),
    ...(stored.revision !== undefined
      ? { expectedRevision: stored.revision }
      : {}),
  });
}

const hookSaves: unknown[] = [];
const answers: unknown[] = [];
const rejections: unknown[] = [];
/** Runs once after the hook's next save settles, before the hook sees it. */
let afterNextSave: ((rejected: boolean) => Promise<void>) | undefined;
const updateListeners = new Set<
  (event: { projectId: string; worktreeId: string; document: unknown }) => void
>();

/** Main's file-annotations:updated push for the stored document. */
async function pushUpdate(projectId: string): Promise<void> {
  const document = await getStored(projectId);
  for (const listener of updateListeners)
    listener({ projectId, worktreeId: 'tree', document });
}
let runtime: ReturnType<typeof createDesktopRuntime>;

let root: Root;
let container: HTMLDivElement;
let hook: UseFileComments | undefined;

function Probe(props: { projectId: string }): null {
  hook = useFileComments(props.projectId, 'tree', filePath);
  return null;
}

function current(): UseFileComments {
  if (!hook) throw new Error('Hook not rendered');
  return hook;
}

/** The hook's calls still running. */
let inFlight = 0;

async function tracked<T>(call: Promise<T>): Promise<T> {
  inFlight += 1;
  try {
    return await call;
  } finally {
    inFlight -= 1;
  }
}

/** Lets the hook's saves and reads run until none has run for a while. */
async function settle(): Promise<void> {
  let quiet = 0;
  for (let round = 0; round < 500 && quiet < 10; round++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    quiet = inFlight === 0 ? quiet + 1 : 0;
  }
}

async function render(projectId: string): Promise<void> {
  act(() => {
    root.render(<Probe projectId={projectId} />);
  });
  await settle();
}

function bodies(document: FileAnnotationDocument): string[] {
  return document.commentThreads.flatMap((thread) =>
    thread.comments.map((comment) => comment.body),
  );
}

let createRoot: (container: Element) => Root;

beforeAll(async () => {
  ({ createRoot } = await import('react-dom/client'));
  jest.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => {
    callbacks.set(channel, handler);
  });
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  registerFileAnnotationsHandlers(
    () => [],
    runtime,
    () => desktopCaller,
  );
  Object.assign(window, {
    appErrors: {
      resolve: resolveIpcAppError,
      resolveOperationFailure: resolvePreloadOperationFailure,
    },
    api: {
      fileAnnotations: {
        get: (request: unknown): Promise<unknown> =>
          tracked(rendererInvoke(IPC_CHANNELS.fileAnnotationsGet, request)),
        save: (request: unknown): Promise<unknown> =>
          tracked(saveFromHook(request)),
        dismiss: (request: unknown): Promise<unknown> =>
          tracked(rendererInvoke(IPC_CHANNELS.fileAnnotationsDismiss, request)),
        onUpdated: (
          listener: (event: {
            projectId: string;
            worktreeId: string;
            document: unknown;
          }) => void,
        ): (() => void) => {
          updateListeners.add(listener);
          return (): void => {
            updateListeners.delete(listener);
          };
        },
      },
    },
  });
});

/** The hook's save, recorded, with the case's step after it settles. */
async function saveFromHook(request: unknown): Promise<unknown> {
  hookSaves.push(request);
  let answer: unknown;
  let rejection: { error: unknown } | undefined;
  try {
    answer = await rendererInvoke(IPC_CHANNELS.fileAnnotationsSave, request);
    answers.push(answer);
  } catch (error) {
    rejections.push(error);
    rejection = { error };
  }
  mockFs.failFlushOf = undefined;
  const run = afterNextSave;
  afterNextSave = undefined;
  await run?.(rejection !== undefined);
  if (rejection) throw rejection.error;
  return answer;
}

beforeEach(() => {
  hookSaves.length = 0;
  answers.length = 0;
  rejections.length = 0;
  hook = undefined;
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  mockFs.failFlushOf = undefined;
  mockFs.onFlushFailed = undefined;
  mockFs.beforeNextRead = undefined;
  afterNextSave = undefined;
  remoteControl?.close();
  remoteControl = undefined;
});

function statePath(projectId: string): string {
  return path.join(stateFolder(projectId), 'file-annotations.json');
}

/** Another writer's edit of one comment's body. */
function editBody(
  commentId: string,
  body: string,
): (document: FileAnnotationDocument) => FileAnnotationDocument {
  return (document) => ({
    ...document,
    commentThreads: document.commentThreads.map((entry) => ({
      ...entry,
      comments: entry.comments.map((item) =>
        item.id === commentId ? { ...item, body } : item,
      ),
    })),
  });
}

afterAll(() => {
  jest.restoreAllMocks();
  rmSync(mockTempDir, { recursive: true, force: true });
});

const anchor = {
  source: 'code' as const,
  repoId: 'root',
  filePath,
  side: 'new' as const,
  lineStart: 1,
  lineEnd: 1,
  quote: '',
};

function stateFolder(projectId: string): string {
  return path.join(
    mockTempDir,
    'workspaces',
    projectId,
    'worktree-data',
    'tree',
  );
}

const theirComment = {
  id: 'their-comment',
  author: 'user' as const,
  body: 'Theirs first.',
  createdAt: '2026-11-25T00:00:00.000Z',
  staged: true,
};

const theirThread = {
  id: 'their-thread',
  status: 'open' as const,
  createdAt: '2026-11-25T00:00:00.000Z',
  anchor: { ...anchor, view: 'file' as const },
  anchorState: 'matched' as const,
  comments: [theirComment],
};

/** Another writer adds its own staged comment first. */
function addTheirs(projectId: string): Promise<void> {
  return saveAsOther(projectId, (document) => ({
    ...document,
    commentThreads: [theirThread],
  }));
}

async function expectReplayedOverTheirs(projectId: string): Promise<void> {
  expect(rejections).toHaveLength(1);
  expect(hookSaves).toHaveLength(2);
  expect(bodies(await getStored(projectId)).sort()).toEqual([
    'Ours second.',
    'Theirs first.',
  ]);
}

describe('useFileComments after a rejected save (file_annotations)', () => {
  it('replays the edit on the latest document after a revision conflict', async () => {
    const projectId = 'conflict';
    await render(projectId);
    await addTheirs(projectId);

    act(() => current().addComment(anchor, 'Ours second.'));
    await settle();

    expect(resolveIpcOperationFailure(rejections[0])?.code).toBe(
      ANNOTATION_ERROR_CODES.REVISION_CONFLICT,
    );
    await expectReplayedOverTheirs(projectId);
  });

  it('still replays a conflict over Remote Control, which drops the code', async () => {
    const projectId = 'remote-conflict';
    await render(projectId);
    await addTheirs(projectId);
    remoteControl = await openRemoteControl();

    act(() => current().addComment(anchor, 'Ours second.'));
    await settle();

    expect(resolveIpcOperationFailure(rejections[0])?.code).toBeUndefined();
    await expectReplayedOverTheirs(projectId);
  });

  it('still replays a conflict whose code the preload cache lost', async () => {
    const projectId = 'cache-conflict';
    await render(projectId);
    await addTheirs(projectId);
    afterNextSave = (): Promise<void> => {
      collideInPreloadCache();
      return Promise.resolve();
    };

    act(() => current().addComment(anchor, 'Ours second.'));
    await settle();

    expect(resolveIpcOperationFailure(rejections[0])).toBeUndefined();
    await expectReplayedOverTheirs(projectId);
  });

  it('answers a save whose flush failed after the install with outcome unknown and the stored document', async () => {
    const projectId = 'answer';
    await addTheirs(projectId);
    const stored = await getStored(projectId);
    mockFs.failFlushOf = stateFolder(projectId);

    const answer = await invoke(IPC_CHANNELS.fileAnnotationsSave, {
      projectId,
      worktreeId: 'tree',
      document: { ...stored, commentThreads: [] },
      baseCommentThreadIds: stored.commentThreads.map((thread) => thread.id),
      ...(stored.revision !== undefined
        ? { expectedRevision: stored.revision }
        : {}),
    });

    expect(answer).toMatchObject({ outcome: 'unknown', commentThreads: [] });
    expect(bodies(await getStored(projectId))).toEqual([]);
  });

  it('retires an edit the store already holds when the save answers outcome unknown', async () => {
    const projectId = 'stored';
    await render(projectId);
    mockFs.failFlushOf = stateFolder(projectId);

    act(() => current().addComment(anchor, 'Stored once.'));
    await settle();

    expect(rejections).toEqual([]);
    expect(answers).toEqual([expect.objectContaining({ outcome: 'unknown' })]);
    expect(hookSaves).toHaveLength(1);
    expect(bodies(await getStored(projectId))).toEqual(['Stored once.']);
    expect(current().stagedCount).toBe(1);
  });

  /** A staged comment of ours, saved, before the case's failing edit. */
  async function stageFirstDraft(
    projectId: string,
  ): Promise<{ threadId: string; commentId: string }> {
    await render(projectId);
    act(() => current().addComment(anchor, 'First draft.'));
    await settle();
    const [thread] = current().document.commentThreads;
    const [comment] = thread?.comments ?? [];
    if (!thread || !comment) throw new Error('Missing staged comment');
    hookSaves.length = 0;
    answers.length = 0;
    return { threadId: thread.id, commentId: comment.id };
  }

  /** Our staged edit's save answers outcome unknown; another writer then edits it. */
  async function editThenLaterWrite(projectId: string): Promise<void> {
    const { threadId, commentId } = await stageFirstDraft(projectId);
    mockFs.failFlushOf = stateFolder(projectId);
    afterNextSave = (): Promise<void> =>
      saveAsOther(projectId, editBody(commentId, 'Their later edit.'));
    act(() => current().editStagedComment(threadId, commentId, 'Our edit.'));
    await settle();
  }

  /** The user's next, unrelated edit, which flushes whatever is still queued. */
  async function unrelatedEdit(): Promise<void> {
    act(() =>
      current().addComment(
        { ...anchor, lineStart: 2, lineEnd: 2 },
        'Unrelated.',
      ),
    );
    await settle();
  }

  async function expectLaterWriteKept(projectId: string): Promise<void> {
    expect(bodies(await getStored(projectId))).toEqual(['Their later edit.']);
    expect(hookSaves).toHaveLength(1);
    expect(rejections).toEqual([]);
    expect(answers).toEqual([expect.objectContaining({ outcome: 'unknown' })]);
  }

  it('keeps a later write when the save answers outcome unknown', async () => {
    const projectId = 'later-write';
    await editThenLaterWrite(projectId);
    await expectLaterWriteKept(projectId);
  });

  it('keeps a later write when the outcome-unknown answer crosses Remote Control', async () => {
    const projectId = 'remote-later-write';
    await render(projectId);
    remoteControl = await openRemoteControl();
    await editThenLaterWrite(projectId);
    await expectLaterWriteKept(projectId);
  });

  it('never resubmits an outcome-unknown edit over a write the re-read saw, even after an unrelated edit', async () => {
    const projectId = 'unknown-then-unrelated';
    const { threadId, commentId } = await stageFirstDraft(projectId);
    // Another writer lands between our install and main's re-read.
    mockFs.failFlushOf = stateFolder(projectId);
    mockFs.onFlushFailed = (): void => {
      mockFs.beforeNextRead = {
        path: statePath(projectId),
        run: (): Promise<void> =>
          saveAsOther(projectId, editBody(commentId, 'Their later edit.')),
      };
    };
    act(() => current().editStagedComment(threadId, commentId, 'Our edit.'));
    await settle();

    expect(rejections).toEqual([]);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ outcome: 'unknown' });
    expect(bodies(answers[0] as FileAnnotationDocument)).toEqual([
      'Their later edit.',
    ]);

    await unrelatedEdit();
    expect(bodies(await getStored(projectId)).sort()).toEqual([
      'Their later edit.',
      'Unrelated.',
    ]);
    expect(bodies(current().document).sort()).toEqual([
      'Their later edit.',
      'Unrelated.',
    ]);
  });

  it("answers outcome unknown, without replaying, when main can't re-read after the failed flush", async () => {
    const projectId = 'reread-fails';
    const { threadId, commentId } = await stageFirstDraft(projectId);
    mockFs.failFlushOf = stateFolder(projectId);
    mockFs.onFlushFailed = (): void => {
      mockFs.beforeNextRead = {
        path: statePath(projectId),
        run: (): Promise<void> =>
          Promise.reject(
            Object.assign(new Error('EIO: read failed'), { code: 'EIO' }),
          ),
      };
    };
    // Another writer changes the same comment before the hook reads again.
    afterNextSave = (): Promise<void> =>
      saveAsOther(projectId, editBody(commentId, 'Their later edit.'));
    act(() => current().editStagedComment(threadId, commentId, 'Our edit.'));
    await settle();
    await unrelatedEdit();

    expect(bodies(await getStored(projectId)).sort()).toEqual([
      'Their later edit.',
      'Unrelated.',
    ]);
    expect(answers[0]).toMatchObject({ outcome: 'unknown' });
  });

  it('keeps a newer pushed revision when an outcome-unknown answer arrives after it', async () => {
    const projectId = 'late-answer';
    await render(projectId);
    mockFs.failFlushOf = stateFolder(projectId);
    afterNextSave = async (): Promise<void> => {
      await saveAsOther(projectId, (document) => ({
        ...document,
        commentThreads: [...document.commentThreads, theirThread],
      }));
      await pushUpdate(projectId);
    };

    act(() => current().addComment(anchor, 'Ours.'));
    await settle();

    expect(answers).toEqual([expect.objectContaining({ outcome: 'unknown' })]);
    expect(current().document.revision).toBe(
      (await getStored(projectId)).revision,
    );
    expect(bodies(current().document).sort()).toEqual([
      'Ours.',
      'Theirs first.',
    ]);
  });

  it("keeps a later write when preload's error cache can't attribute an outcome-unknown failure", async () => {
    const projectId = 'cache-later-write';
    const wrapper = await poisonOutcomeUnknownInPreloadCache(
      `${projectId}-poison`,
    );
    let restored: unknown;
    try {
      restoreIpcAppError(new Error(wrapper));
    } catch (error) {
      restored = error;
    }
    expect(resolveIpcOperationFailure(restored)).toBeUndefined();

    await editThenLaterWrite(projectId);
    await expectLaterWriteKept(projectId);
  });
});

describe('file-annotations:append after a flush failed (file_annotations)', () => {
  it('answers the stored document, so the annotation is applied once and nothing invites a retry', async () => {
    const projectId = 'append-flush-fails';
    await addTheirs(projectId);
    mockFs.failFlushOf = stateFolder(projectId);

    const answer = await invoke(IPC_CHANNELS.fileAnnotationsAppend, {
      projectId,
      worktreeId: 'tree',
      filePath,
      annotations: [
        {
          id: 'shown-note',
          repoId: 'root',
          filePath,
          side: 'new',
          lineStart: 1,
          lineEnd: 1,
          kind: 'context',
          title: 'Shown note',
          body: 'Applied once.',
        },
      ],
      commentThreads: [],
    });

    expect(answer).toMatchObject({
      annotations: [expect.objectContaining({ id: 'shown-note' })],
    });
    const stored = await getStored(projectId);
    expect(stored.annotations.map((note) => note.id)).toEqual(['shown-note']);
  });
});

describe('RespondToFileComment after a reply whose flush failed (file_annotations)', () => {
  it('tells the agent the reply may already be saved', async () => {
    const projectId = 'agent-reply';
    await saveAsOther(projectId, (document) => ({
      ...document,
      commentThreads: [
        {
          id: 'submitted-thread',
          status: 'open',
          createdAt: '2026-11-25T00:00:00.000Z',
          anchor: { ...anchor, view: 'file' },
          anchorState: 'matched',
          comments: [
            {
              id: 'user-comment',
              author: 'user',
              body: 'Please check this.',
              createdAt: '2026-11-25T00:00:00.000Z',
            },
          ],
        },
      ],
    }));
    mockFs.failFlushOf = stateFolder(projectId);

    const result = await respondToFileComment(
      {
        projectId,
        worktreeId: 'tree',
        threadId: 'submitted-thread',
        body: 'Agent reply.',
        resolve: false,
      },
      agentCoreOperations('annotation', runtime),
    );

    expect(result).toEqual({
      ok: false,
      resolved: false,
      error:
        'The reply may already be saved. Reload the thread before trying again.',
    });
    expect(bodies(await getStored(projectId))).toEqual([
      'Please check this.',
      'Agent reply.',
    ]);
  });
});
