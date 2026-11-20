// CAN-4169 golden: shared-run comments as desktop serves them today, captured
// before core.publication takes ownership. It drives the real
// runs:comments:* handlers, the comments registry file, the cloud client, the
// account store and the comment poller, with its runs:comments:updated push,
// on a data root the golden owns. Only IPC registration, window sends, the
// cloud base URL, observability and the chat's saved share metadata are
// replaced, and HTTP goes to the in-test runs server in
// helpers/shared-runs-golden-harness.ts. Two runs start shared, as the share
// goldens leave them. Timers and the clock are faked so the poll interval and
// the focus throttle run on demand. A change here is a behaviour change:
// re-record deliberately with `pnpm test <this file> -u` and review the diff.
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  RunShareScope,
  SharedRunComment,
  SharedRunCommentAnchor,
  SharedRunCommentThread,
  SharedRunDetail,
} from '@canopy/protocol/runs';
import { isUuid } from '@canopy/protocol/uuid';
import type * as CloudConfig from '../canopy-cloud/config';
import type * as ChatTabsReader from '../lib/chat-tabs-reader';
import type * as CommentPoller from '../services/shared-run-comment-poller';
import {
  cloud,
  diagnostics,
  drain,
  fakeCloud,
  FIXED_TIME,
  handlers,
  invoke,
  isRecord,
  json,
  mark as markLists,
  must,
  observability,
  ORG_ID,
  fault,
  ownDataRoot,
  quiet as quietFor,
  registryFile as readRegistry,
  runId,
  saveAccount,
  savedShares,
  saveShare,
  session,
  since,
  stable,
  teamShare,
  track,
  until,
  type Json,
  type OwnedDataRoot,
  type RecordedRequest,
} from './helpers/shared-runs-golden-harness';

jest.setTimeout(30_000);

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));
const pushes: { channel: string; payload: unknown }[] = [];
jest.mock('../lib/web-contents-send', () => ({
  sendToWebContents: (
    _target: unknown,
    channel: string,
    payload: unknown,
  ): void => {
    pushes.push({ channel, payload });
  },
}));
jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<object>('../lib/main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../canopy-cloud/config', () => ({
  ...jest.requireActual<typeof CloudConfig>('../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  ...jest.requireActual<typeof ChatTabsReader>('../lib/chat-tabs-reader'),
  readSharedRunMetadata: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): Promise<unknown> =>
    Promise.resolve(
      savedShares.get(`${projectId}/${worktreeId}/${chatId}`) ?? null,
    ),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): typeof observability => observability,
}));
// Loaded by the share path in ipc/runs, which these goldens never take.
jest.mock('../services/telemetry-sync-service', () => ({}));
jest.mock('../services/diff-service', () => ({}));

const OWNER_USER = 'user-owner';
const TEAMMATE_USER = 'user-teammate';
interface ServerRun {
  externalId: string;
  clientLocalRunId: string;
  shareScope: RunShareScope;
  title: string;
  clientChatId: string;
  messages: SharedRunDetail['messages'];
  commentRevision: number;
  commentThreads: Omit<SharedRunCommentThread, 'anchorState'>[];
  /** The caller lost access: hosted answers the same 404 as a missing run. */
  revoked?: boolean;
}
const serverRuns = new Map<string, ServerRun>();
const ANCHORED_MESSAGE = 'turn-1:msg-1';

// As apps/web/src/lib/runs/run-api.ts: anchors reconcile against `messages`.
function detailOf(run: ServerRun): SharedRunDetail {
  const ids = new Set(run.messages.map((message) => message.messageId));
  return {
    externalId: run.externalId,
    shareScope: run.shareScope,
    title: run.title,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    clientChatId: run.clientChatId,
    summary: '',
    transcript: [],
    messages: structuredClone(run.messages),
    diff: '',
    rollup: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0,
      toolUseCount: 0,
      turnCount: 1,
      provider: 'claude',
      status: 'success',
    },
    author: { name: 'Owner', image: null, userId: OWNER_USER },
    organizationId: run.shareScope === 'organization' ? ORG_ID : null,
    plans: [],
    commentThreads: run.commentThreads.map((thread) => ({
      ...structuredClone(thread),
      anchorState:
        thread.anchor.kind === 'message' && !ids.has(thread.anchor.messageId)
          ? 'orphaned'
          : 'matched',
    })),
    commentRevision: run.commentRevision,
    viewerUserId: OWNER_USER,
  };
}
// Runs a test names; the server mints UUID run ids and `web:<uuid>` thread ids.
const RUN_1 = runId(1);
const RUN_2 = runId(2);
const RUN_LEGACY = runId(10);
const RUN_GONE = runId(11);
const threadId = (n: number): string =>
  `web:00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
let threadSequence = 0;
let commentSequence = 0;

function comment(userId: string, body: string): SharedRunComment {
  commentSequence += 1;
  return {
    id: `comment-${commentSequence}`,
    author: { userId, displayName: null, image: null },
    body,
    createdAt: new Date().toISOString(),
  };
}

function addThread(
  run: ServerRun,
  anchor: SharedRunCommentAnchor,
  first: SharedRunComment,
): void {
  threadSequence += 1;
  run.commentThreads.push({
    id: threadId(threadSequence),
    status: 'open',
    anchor,
    createdAt: new Date().toISOString(),
    comments: [first],
  });
  run.commentRevision += 1;
}

cloud.route = (method, path, body): Response => {
  const match = /^<api>\/runs\/([^/]+)(\/comments(?:\/([^/]+))?)?$/.exec(path);
  const id = match?.[1] ? decodeURIComponent(match[1]) : '';
  // As apps/web/src/lib/runs: a malformed or unknown run id is a uniform 404.
  const run = isUuid(id) ? serverRuns.get(id) : undefined;
  if (!match || !run || run.revoked) {
    return json(404, { error: 'Run not found' });
  }
  if (!match[2]) {
    return method === 'GET'
      ? json(200, detailOf(run))
      : json(405, { error: 'Method not allowed.' });
  }
  const thread = match[3] ? decodeURIComponent(match[3]) : undefined;
  if (!thread && method === 'POST') {
    const anchor = isRecord(body.anchor) ? body.anchor : {};
    addThread(
      run,
      typeof anchor.messageId === 'string'
        ? { kind: 'message', messageId: anchor.messageId }
        : { kind: 'run' },
      comment(OWNER_USER, String(body.body)),
    );
    return json(200, detailOf(run));
  }
  const found = run.commentThreads.find((candidate) => candidate.id === thread);
  if (!found) return json(404, { error: 'Comment thread not found' });
  if (method === 'POST') {
    found.comments.push(comment(OWNER_USER, String(body.body)));
  } else if (method === 'PATCH') {
    found.status = body.status === 'resolved' ? 'resolved' : 'open';
  } else {
    return json(405, { error: 'Method not allowed.' });
  }
  run.commentRevision += 1;
  return json(200, detailOf(run));
};

// Someone comments from the web: a new thread on the run.
function webComment(
  externalId: string,
  body: string,
  user = TEAMMATE_USER,
): void {
  addThread(
    must(serverRuns.get(externalId)),
    { kind: 'run' },
    comment(user, body),
  );
}
// While set, the next poll fetch of RUN_1 waits on it until releaseRun1().
let holdRun1: Promise<void> | null = null;
let releaseRun1 = (): void => undefined;

const { faults } = cloud;
let owned: OwnedDataRoot | undefined;
let dataDir: string;
let poller:
  | ReturnType<typeof CommentPoller.getSharedRunCommentPoller>
  | undefined;
const appListeners = new Map<string, Set<() => void>>();

function mark(): void {
  markLists(cloud.requests, pushes, diagnostics);
}
const newRequests = (): RecordedRequest[] => since(cloud.requests);
const newPushes = (): unknown[] => since(pushes);
const newDiagnostics = (): Json[] => since(diagnostics);
const registryFile = (): unknown => readRegistry(dataDir);
const quiet = (): Promise<void> =>
  quietFor(
    () =>
      `${cloud.requests.length}/${pushes.length}/${diagnostics.length}/${JSON.stringify(registryFile())}`,
  );

function focusWindow(): void {
  for (const listener of appListeners.get('browser-window-focus') ?? []) {
    listener();
  }
}

// A run the share goldens leave behind: shared, registered for comments.
async function sharedRun(
  chatId: string,
  run: Partial<ServerRun>,
): Promise<void> {
  const externalId = runId(serverRuns.size + 1);
  serverRuns.set(externalId, {
    externalId,
    clientLocalRunId: `client-${externalId}`,
    shareScope: 'team',
    title: 'Fix the flaky upload test',
    clientChatId: chatId,
    messages: [],
    commentRevision: 0,
    commentThreads: [],
    ...run,
  });
  const { registerSharedRunForComments } =
    await import('../lib/shared-run-comments-registry');
  await registerSharedRunForComments({ ...session(chatId), externalId });
}

beforeAll(async () => {
  // The golden owns its data roots before any code under test loads.
  owned = ownDataRoot('shared-run-comments-golden-');
  dataDir = owned.dataDir;

  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const response = fakeCloud(input, init);
    const gate =
      cloud.requests.at(-1)?.path === `<api>/runs/${RUN_1}` ? holdRun1 : null;
    if (!gate) return response;
    holdRun1 = null;
    return gate.then(() => response);
  });
  jest.useFakeTimers({
    now: new Date(FIXED_TIME),
    doNotFake: [
      'nextTick',
      'setImmediate',
      'queueMicrotask',
      'hrtime',
      'performance',
    ],
  });

  // The poller listens for app focus and pushes to every open window.
  const electron = await import('electron');
  jest
    .spyOn(electron.app, 'on')
    .mockImplementation((event: string, listener: () => void) => {
      const listeners = appListeners.get(event) ?? new Set();
      listeners.add(listener);
      appListeners.set(event, listeners);
      return electron.app;
    });
  jest
    .spyOn(electron.app, 'removeListener')
    .mockImplementation((event: string, listener: () => void) => {
      appListeners.get(event)?.delete(listener);
      return electron.app;
    });
  const mainWindow = new electron.BrowserWindow();
  jest
    .spyOn(electron.BrowserWindow, 'getAllWindows')
    .mockReturnValue([mainWindow]);

  await saveAccount(['runs-crud-v1', 'run-comments-v1']);
  await sharedRun('chat-shared', {
    shareScope: 'organization',
    messages: [
      {
        messageId: ANCHORED_MESSAGE,
        chatId: 'chat-shared',
        role: 'assistant',
        status: 'complete',
        text: 'I changed the retry loop.',
        createdAtMs: Date.parse(FIXED_TIME),
      },
    ],
  });
  await sharedRun('chat-retry', {});
  const { registerRunsHandlers } = await import('../ipc/runs');
  registerRunsHandlers();
  poller = (
    await import('../services/shared-run-comment-poller')
  ).getSharedRunCommentPoller();
  // Teardown waits for every poll the interval or a focus started.
  const pollOnce = poller.pollOnce.bind(poller);
  jest.spyOn(poller, 'pollOnce').mockImplementation(() => track(pollOnce()));
});

// Safe after a partial setup. In-flight polls settle before the guard and env
// come off, so a late registry write can't reach the restored data root.
afterAll(async () => {
  try {
    poller?.shutdown();
    // A step that failed while holding a fetch must not hang the drain.
    releaseRun1();
    await drain();
    jest.useRealTimers();
    jest.restoreAllMocks();
  } finally {
    owned?.release();
  }
});

beforeEach(() => {
  mark();
});

// Every planned fault is used by the step it was set for.
afterEach(() => {
  expect(faults).toEqual([]);
  expect(owned?.outsideWrites).toEqual([]);
});

describe('shared runs (CAN-4169 golden)', () => {
  it('lists, creates, replies to and resolves run comments', async () => {
    const unshared = await invoke(
      IPC_CHANNELS.runsCommentsList,
      session('chat-unshared'),
    );
    const unsharedCreate = await invoke(IPC_CHANNELS.runsCommentsCreate, {
      ...session('chat-unshared'),
      body: 'Not shared yet',
    });
    const unsharedRequests = newRequests();

    // A run shared before comments shipped has no registry entry: the first
    // read registers it.
    saveShare('chat-shared', {
      externalId: RUN_1,
      shareScope: 'organization',
      organizationId: ORG_ID,
      sharedAt: FIXED_TIME,
    });
    saveShare('chat-legacy', teamShare(RUN_LEGACY));
    serverRuns.set(RUN_LEGACY, {
      externalId: RUN_LEGACY,
      clientLocalRunId: 'legacy-client-run',
      shareScope: 'team',
      title: 'Legacy run',
      clientChatId: 'chat-legacy',
      messages: [],
      commentRevision: 0,
      commentThreads: [],
    });
    mark();
    const backfill = await invoke(
      IPC_CHANNELS.runsCommentsList,
      session('chat-legacy'),
    );
    const backfillRequests = newRequests();
    const registryAfterBackfill = registryFile();

    mark();
    const created = await invoke(IPC_CHANNELS.runsCommentsCreate, {
      ...session('chat-shared'),
      body: 'Why did the retry loop change?',
      anchor: { kind: 'message', messageId: ANCHORED_MESSAGE },
    });
    const replied = await invoke(IPC_CHANNELS.runsCommentsReply, {
      ...session('chat-shared'),
      threadId: threadId(1),
      body: 'Because uploads time out.',
    });
    const resolved = await invoke(IPC_CHANNELS.runsCommentsSetStatus, {
      ...session('chat-shared'),
      threadId: threadId(1),
      status: 'resolved',
    });
    const invalidThread = await invoke(IPC_CHANNELS.runsCommentsReply, {
      ...session('chat-shared'),
      threadId: '../thread',
      body: 'Escapes the path',
    });
    // Lost access: hosted answers 404 (run-comments.ts, never 403); nothing
    // is created on the server or in the registry.
    const run1 = must(serverRuns.get(RUN_1));
    const beforeRevoked = [run1.commentRevision, registryFile()];
    run1.revoked = true;
    const revoked = await invoke(IPC_CHANNELS.runsCommentsCreate, {
      ...session('chat-shared'),
      body: 'After access was revoked',
    });
    run1.revoked = false;
    expect([run1.commentRevision, registryFile()]).toEqual(beforeRevoked);
    const listed = await invoke(
      IPC_CHANNELS.runsCommentsList,
      session('chat-shared'),
    );
    // Pins current defect; fix tracked in CAN-7426.
    // A run deleted on the server rejects the read and stays registered.
    saveShare('chat-gone', teamShare(RUN_GONE));
    const goneRun = await invoke(
      IPC_CHANNELS.runsCommentsList,
      session('chat-gone'),
    );
    const registryAfterGone = registryFile();
    expect(
      stable({
        unshared,
        unsharedCreate,
        unsharedRequests,
        backfill,
        backfillRequests,
        registryAfterBackfill,
        created,
        replied,
        resolved,
        invalidThread,
        revoked,
        listed,
        goneRun,
        registryAfterGone,
        requests: newRequests(),
      }),
    ).toMatchSnapshot();
  });

  it('polls comments on the interval and on focus, and pushes runs:comments:updated', async () => {
    webComment(RUN_1, 'Looks good, one question.');
    must(poller).start();
    must(poller).start();
    jest.advanceTimersByTime(5 * 60_000 - 1);
    await quiet();
    const beforeInterval = newRequests().length;
    jest.advanceTimersByTime(1);
    await until(
      () => newPushes().length === 1 && newRequests().length === 4,
      'interval tick pushes',
    );
    await quiet();
    const intervalTick = {
      requests: newRequests(),
      pushes: newPushes(),
      registry: registryFile(),
    };

    // Nothing changed: the next tick fetches but pushes nothing.
    mark();
    jest.advanceTimersByTime(5 * 60_000);
    await until(() => newRequests().length === 3, 'quiet tick fetches');
    await quiet();
    const quietTick = { requests: newRequests(), pushes: newPushes() };

    // Focus polls at most once a minute.
    mark();
    webComment(RUN_LEGACY, 'Can you rerun this?');
    focusWindow();
    await until(
      () => newPushes().length === 1 && newRequests().length === 3,
      'focus tick pushes',
    );
    await quiet();
    focusWindow();
    await quiet();
    const focusTick = { requests: newRequests(), pushes: newPushes() };
    mark();
    jest.advanceTimersByTime(59_999);
    focusWindow();
    await quiet();
    const focusBeforeMinute = newRequests().length;
    jest.advanceTimersByTime(1);
    focusWindow();
    await until(() => newRequests().length === 3, 'focus after a minute');
    await quiet();
    const focusAfterMinute = newRequests().length;

    // markSeen clears the badge and never moves backwards.
    mark();
    const seen = await invoke(IPC_CHANNELS.runsCommentsMarkSeen, {
      ...session('chat-shared'),
      commentRevision: 4,
    });
    const seenBackwards = await invoke(IPC_CHANNELS.runsCommentsMarkSeen, {
      ...session('chat-shared'),
      commentRevision: 1,
    });
    const seenUnknown = await invoke(IPC_CHANNELS.runsCommentsMarkSeen, {
      ...session('chat-unshared'),
      commentRevision: 3,
    });
    const listedAfterSeen = await invoke(
      IPC_CHANNELS.runsCommentsList,
      session('chat-shared'),
    );
    const requests = newRequests().map(
      ({ method, path }) => `${method} ${path}`,
    );
    const registryAfterSeen = registryFile();

    // Only the user's own web comment: the push says so, so the renderer
    // skips the OS notification; the badge still counts it.
    // Pins current defect; fix tracked in CAN-7426.
    mark();
    webComment(RUN_1, 'Replied from the browser.', OWNER_USER);
    jest.advanceTimersByTime(5 * 60_000);
    await until(() => newPushes().length === 1, 'own comment tick pushes');
    await quiet();
    const ownComment = { pushes: newPushes(), registry: registryFile() };

    // A markSeen that lands while the poll's fetch is in flight wins.
    mark();
    webComment(RUN_1, 'Read while the poll was in flight.');
    holdRun1 = new Promise((done) => {
      releaseRun1 = done;
    });
    let seenInFlight: unknown;
    try {
      jest.advanceTimersByTime(5 * 60_000);
      await until(() => holdRun1 === null, 'poll holds the run 1 fetch');
      seenInFlight = await invoke(IPC_CHANNELS.runsCommentsMarkSeen, {
        ...session('chat-shared'),
        commentRevision: 6,
      });
    } finally {
      releaseRun1();
    }
    await until(() => newRequests().length === 3, 'held tick fetches');
    await quiet();
    const seenWhilePolling = {
      seenInFlight,
      pushes: newPushes(),
      registry: registryFile(),
    };
    expect(
      stable({
        beforeInterval,
        intervalTick,
        quietTick,
        focusTick,
        focusBeforeMinute,
        focusAfterMinute,
        seen,
        seenBackwards,
        seenUnknown,
        listedAfterSeen,
        registry: registryAfterSeen,
        requests,
        ownComment,
        seenWhilePolling,
      }),
    ).toMatchSnapshot();
  });

  it('drops a revoked run from the poll and records other poll failures', async () => {
    // Pins current defect; fix tracked in CAN-7426: a 401 is kept and retried.
    fault('GET', `<api>/runs/${RUN_1}`, 401, 'Invalid API key.');
    fault('GET', `<api>/runs/${RUN_LEGACY}`, 404, 'Run not found');
    jest.advanceTimersByTime(5 * 60_000);
    await until(
      () => newRequests().length === 3 && newDiagnostics().length === 1,
      'failing tick fetches',
    );
    await quiet();
    const failingTick = {
      requests: newRequests(),
      pushes: newPushes(),
      diagnostics: newDiagnostics(),
      registry: registryFile(),
    };

    // A gone grant via 410 is dropped too.
    mark();
    fault('GET', `<api>/runs/${RUN_1}`, 410, 'Run was deleted.');
    jest.advanceTimersByTime(5 * 60_000);
    await until(() => newRequests().length === 2, 'gone tick fetches');
    await quiet();
    const goneTick = {
      requests: newRequests(),
      registry: registryFile(),
    };

    // The next tick polls only the runs still registered.
    mark();
    jest.advanceTimersByTime(5 * 60_000);
    await until(() => newRequests().length === 1, 'next tick fetches');
    await quiet();
    const nextTick = newRequests();

    // A read registers the run again; after shutdown nothing polls it.
    await invoke(IPC_CHANNELS.runsCommentsList, session('chat-shared'));
    must(poller).shutdown();
    mark();
    focusWindow();
    jest.advanceTimersByTime(10 * 60_000);
    await quiet();
    expect(
      stable({
        failingTick,
        goneTick,
        nextTick,
        afterShutdown: newRequests(),
      }),
    ).toMatchSnapshot();
  });

  it('degrades comments to none on a server without run-comments-v1', async () => {
    cloud.capabilities = ['runs-crud-v1'];
    await saveAccount(['runs-crud-v1']);
    saveShare('chat-retry', teamShare(RUN_2));
    mark();
    const listed = await invoke(
      IPC_CHANNELS.runsCommentsList,
      session('chat-retry'),
    );
    const created = await invoke(IPC_CHANNELS.runsCommentsCreate, {
      ...session('chat-retry'),
      body: 'On an older server',
    });
    expect(
      stable({ listed, created, requests: newRequests() }),
    ).toMatchSnapshot();
  });
});
