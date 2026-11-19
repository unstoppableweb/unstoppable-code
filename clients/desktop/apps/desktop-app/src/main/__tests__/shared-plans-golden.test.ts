// CAN-4166 golden: shared plan collaboration as desktop serves it today,
// captured before core.publication and core.annotation take ownership. It
// drives the real `tracked-plans:*` IPC handlers, plan persistence, the cloud
// client and account store, the shared-plan sync and its SSE subscription,
// the agent reply path and App Advisor's sharing actions on a temporary data
// root with a real Git checkout. Only IPC registration, window sends and
// the cloud base URL are replaced, and HTTP goes to an in-test shared-plan
// server. Timers are faked so the debounce, retry and
// reconnect delays run on demand. A change here is a behaviour change:
// re-record deliberately with `pnpm test <this file> -u` and review the diff.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type AppAdvisorAction,
  type PlanCommentThread,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { withPlanStateLock } from '@canopy/core-runtime/node/plans';
import { PLAN_DIAGRAM_SCHEMA_VERSION } from '@canopy/protocol/plans';
import type { ShareOperationResult } from '@canopy/protocol/sharing';
import type * as CloudConfig from '../canopy-cloud/config';
import type * as MainProcessLogging from '../lib/main-process-logging';
import type * as PlanPersistence from '../lib/plan-persistence';
import type * as SharedPlanSync from '../lib/shared-plan-sync';
import type * as PlanCommentReply from '../lib/plan-comment-reply';
import type * as AdvisorSharingActions from '../app-advisor/advisor-sharing-actions';
import type * as AdvisorSharingActionsHost from '../app-advisor/advisor-sharing-actions-host';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import {
  deriveDesktopIpcCaller,
  type DesktopIpcCallerOptions,
  type DesktopIpcEvent,
  type DesktopIpcFrame,
  type DesktopIpcSender,
} from '../canopy-runtime/desktop-ipc-caller';

jest.setTimeout(30_000);

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
interface WindowSend {
  channel: string;
  payload: unknown;
}
const windowSends: WindowSend[] = [];
jest.mock('../lib/window-send', () => ({
  sendToWindow: (_window: unknown, channel: string, payload: unknown): void => {
    windowSends.push({ channel, payload });
  },
  sendToAllWindows: (channel: string, payload: unknown): void => {
    windowSends.push({ channel, payload });
  },
}));
jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>(
    '../lib/main-process-logging',
  ),
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));
jest.mock('../canopy-cloud/config', () => ({
  ...jest.requireActual<typeof CloudConfig>('../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));

const WORKSPACE_ID = 'shared-plans-golden';
const WORKTREE_ID = 'golden-wt';
const TEAM_ID = 'team-golden';
const ORG_ID = 'org-golden';
const API_KEY = 'csk_shared_plans_golden';
const API = `/api/v1/${BRAND.web.apiNamespace}`;
const FIXED_TIME = '2026-11-01T12:00:00.000Z';
const CREDENTIALED_REMOTE =
  'https://deploy-user:secret-token@git.example.test/acme/widgets.git?ref=x#frag';
const realSetTimeout = setTimeout;

// --- In-test shared-plan server ---------------------------------------------

type Json = Record<string, unknown>;
interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  lastEventId?: string;
  body?: unknown;
}
interface Fault {
  method: string;
  path: string;
  status: number;
  body: Json;
}
interface OpenStream {
  remoteId: string;
  closed: boolean;
  push: (frame: string) => void;
  close: () => void;
}

const serverPlans = new Map<string, Json>();
const requests: RecordedRequest[] = [];
const faults: Fault[] = [];
const streams: OpenStream[] = [];
let remoteSequence = 0;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function mergeThreads(existing: unknown, incoming: unknown): Json[] {
  const merged = records(structuredClone(existing));
  for (const thread of records(structuredClone(incoming))) {
    const current = merged.find((candidate) => candidate.id === thread.id);
    if (!current) {
      merged.push(thread);
      continue;
    }
    current.status = thread.status;
    current.anchor = thread.anchor;
    current.anchorState = thread.anchorState;
    const comments = records(current.comments);
    for (const comment of records(thread.comments)) {
      if (!comments.some((candidate) => candidate.id === comment.id)) {
        comments.push(comment);
      }
    }
    current.comments = comments;
  }
  return merged;
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ownerFor(body: Json): Json {
  if (body.shareScope === 'team') {
    return {
      type: 'team',
      id: body.teamId,
      name: 'Platform',
      organization: { id: ORG_ID, name: 'Example Org' },
    };
  }
  if (body.shareScope === 'organization') {
    return {
      type: 'organization',
      id: body.organizationId,
      name: 'Example Org',
    };
  }
  return { type: 'user', id: 'account-golden', name: 'Plan Owner' };
}

function openStream(remoteId: string, signal: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream: OpenStream = {
    remoteId,
    closed: false,
    push: (frame) => controller?.enqueue(encoder.encode(frame)),
    close: () => {
      if (stream.closed) return;
      stream.closed = true;
      controller?.close();
    },
  };
  const body = new ReadableStream<Uint8Array>({
    start(next): void {
      controller = next;
    },
  });
  signal?.addEventListener(
    'abort',
    () => {
      if (stream.closed) return;
      stream.closed = true;
      controller?.error(new DOMException('Aborted', 'AbortError'));
    },
    { once: true },
  );
  streams.push(stream);
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function fakeCloud(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(requestUrl(input));
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const parsed: unknown =
    typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  const body = isRecord(parsed) ? parsed : {};
  const path = url.pathname.replace(API, '<api>');
  const lastEventId = headers.get('last-event-id');
  requests.push({
    method,
    path,
    authorization: headers.get('authorization'),
    ...(lastEventId === null ? {} : { lastEventId }),
    ...(parsed === undefined ? {} : { body: parsed }),
  });
  const faultIndex = faults.findIndex(
    (fault) => fault.method === method && fault.path === path,
  );
  if (faultIndex >= 0) {
    const fault = must(faults.splice(faultIndex, 1)[0]);
    return Promise.resolve(json(fault.status, fault.body));
  }
  const match = /^<api>\/plans(?:\/([^/]+))?(\/stream)?$/.exec(path);
  if (!match) return Promise.resolve(json(404, { error: 'Not found.' }));
  const remoteId = match[1];
  if (match[2] && remoteId) {
    return Promise.resolve(openStream(remoteId, init?.signal ?? null));
  }
  if (!remoteId && method === 'POST') {
    remoteSequence += 1;
    const id = `remote-plan-${remoteSequence}`;
    const detail: Json = {
      id,
      title: body.title,
      contentHash: 'server-content-hash',
      diagramsHash: 'server-diagrams-hash',
      snapshotHash: body.snapshotHash,
      localRevisionNumber: body.localRevisionNumber,
      remoteRevisionNumber: 1,
      repositories: body.repositories,
      shareScope: body.shareScope,
      owner: ownerFor(body),
      createdBy: { id: 'account-golden', name: 'Plan Owner', email: null },
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      canUpdate: true,
      canDelete: true,
      content: body.content,
      ...(body.diagrams === undefined ? {} : { diagrams: body.diagrams }),
      commentThreads: mergeThreads([], body.commentThreads),
    };
    serverPlans.set(id, detail);
    return Promise.resolve(json(201, detail));
  }
  const existing = remoteId ? serverPlans.get(remoteId) : undefined;
  if (!remoteId || !existing) {
    return Promise.resolve(json(404, { error: 'Shared plan not found.' }));
  }
  if (method === 'GET') return Promise.resolve(json(200, existing));
  if (method === 'DELETE') {
    serverPlans.delete(remoteId);
    return Promise.resolve(json(200, { unshared: true }));
  }
  if (method === 'PUT') {
    if (body.expectedSnapshotHash !== existing.snapshotHash) {
      return Promise.resolve(
        json(409, { error: 'The shared plan changed on the server.' }),
      );
    }
    const revision =
      typeof existing.remoteRevisionNumber === 'number'
        ? existing.remoteRevisionNumber
        : 0;
    const next: Json = {
      ...existing,
      title: body.title,
      content: body.content,
      repositories: body.repositories,
      localRevisionNumber: body.localRevisionNumber,
      remoteRevisionNumber:
        body.snapshotHash === existing.snapshotHash ? revision : revision + 1,
      snapshotHash: body.snapshotHash,
      ...(body.diagrams === undefined ? {} : { diagrams: body.diagrams }),
      commentThreads: mergeThreads(
        existing.commentThreads,
        body.commentThreads,
      ),
    };
    serverPlans.set(remoteId, next);
    return Promise.resolve(json(200, next));
  }
  return Promise.resolve(json(405, { error: 'Method not allowed.' }));
}

// --- Harness ------------------------------------------------------------------

let root: string;
let worktreePath: string;
let persistence: typeof PlanPersistence;
let sync: typeof SharedPlanSync;
let commentReply: typeof PlanCommentReply;
let advisorActions: typeof AdvisorSharingActions;
let advisorHost: typeof AdvisorSharingActionsHost;
let fetchSpy: jest.SpyInstance;
let dispatcher: DesktopCanopyDispatcher;
let plansFilePath: string;

// Every call comes from the main window, and the IPC handlers resolve its
// caller with the production resolver, as ipc/index.ts does.
const RENDERER_URL = 'file:///app/renderer/index.html';
const MAIN_FRAME: DesktopIpcFrame = {
  url: RENDERER_URL,
  detached: false,
  isDestroyed: () => false,
};
const MAIN_WINDOW_SENDER: DesktopIpcSender = {
  id: 1,
  mainFrame: MAIN_FRAME,
  getURL: () => RENDERER_URL,
  isDestroyed: () => false,
};
const MAIN_WINDOW_EVENT: DesktopIpcEvent = {
  sender: MAIN_WINDOW_SENDER,
  senderFrame: MAIN_FRAME,
};
const CALLER_OPTIONS: DesktopIpcCallerOptions = {
  getAppWindows: () => [
    { isDestroyed: () => false, webContents: MAIN_WINDOW_SENDER },
  ],
  packagedRendererUrls: [RENDERER_URL],
};
const originalDataDir = process.env.CANOPY_DATA_DIR;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(args: string[]): void {
  execFileSync('git', args, {
    cwd: worktreePath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Plan Owner',
      GIT_AUTHOR_EMAIL: 'owner@example.test',
      GIT_AUTHOR_DATE: FIXED_TIME,
      GIT_COMMITTER_NAME: 'Plan Owner',
      GIT_COMMITTER_EMAIL: 'owner@example.test',
      GIT_COMMITTER_DATE: FIXED_TIME,
    },
    stdio: 'ignore',
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
}

async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(5);
  }
}

// Wait until no request or window send has arrived for a few polls, so a run
// that is still finishing its last write is never cut short.
async function quiet(): Promise<void> {
  let stable = 0;
  let last = `${requests.length}/${windowSends.length}`;
  while (stable < 4) {
    await sleep(10);
    const now = `${requests.length}/${windowSends.length}`;
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

async function advanceUntil(
  check: () => boolean,
  label: string,
  stepMs: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    jest.advanceTimersByTime(stepMs);
    await sleep(5);
  }
}

// The sync status the plan's latest window update carried since mark().
function lastSentSyncStatus(planId: string): unknown {
  for (const send of windowSends.slice(sendMark).reverse()) {
    const payload = isRecord(send.payload) ? send.payload : {};
    const plan = isRecord(payload.plan) ? payload.plan : {};
    if (plan.id !== planId) continue;
    return isRecord(plan.share) ? plan.share.syncStatus : null;
  }
  return null;
}

// Wait for the plan's sync run to finish, not for a quiet spell, which slow
// disk writes outlast. A run ends by announcing a synced or error share; the
// comment merge that can follow a synced write has queued on the plan state
// lock by then, so taking the lock waits it out.
async function syncSettled(planId: string): Promise<void> {
  await until(() => {
    const status = lastSentSyncStatus(planId);
    return status === 'synced' || status === 'error';
  }, `sync of ${planId} settles`);
  await withPlanStateLock(plansFilePath, () => Promise.resolve());
  await quiet();
}

async function invoke(channel: string, request: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  const result: unknown = await handler(MAIN_WINDOW_EVENT, request);
  return result;
}

function isPlan(value: unknown): value is TrackedPlanData {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.content === 'string'
  );
}

function isShareOutcome(
  value: unknown,
): value is ShareOperationResult<TrackedPlanData | null> {
  if (!isRecord(value)) return false;
  if (value.ok === true) return value.value === null || isPlan(value.value);
  return value.ok === false && isRecord(value.failure);
}

async function invokePlan(
  channel: string,
  request: unknown,
): Promise<TrackedPlanData | null> {
  const result = await invoke(channel, request);
  if (result === null || isPlan(result)) return result;
  throw new Error(`${channel} answered something other than a plan`);
}

async function invokeShare(
  channel: string,
  request: unknown,
): Promise<ShareOperationResult<TrackedPlanData | null>> {
  const result = await invoke(channel, request);
  if (isShareOutcome(result)) return result;
  throw new Error(`${channel} answered something other than a share result`);
}

const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('expected a value');
  return value;
}

async function readPlan(planId: string): Promise<TrackedPlanData> {
  return must(
    await persistence.getTrackedPlan(WORKSPACE_ID, WORKTREE_ID, planId),
  );
}

let requestMark = 0;
let sendMark = 0;
function mark(): void {
  requestMark = requests.length;
  sendMark = windowSends.length;
}
function newRequests(): RecordedRequest[] {
  return requests.slice(requestMark);
}
function countRequests(method: string, path: string): number {
  return newRequests().filter(
    (request) => request.method === method && request.path === path,
  ).length;
}

// The share states each window update carried, in order.
function sentShareStates(): unknown[] {
  return windowSends.slice(sendMark).map((send) => {
    const payload = isRecord(send.payload) ? send.payload : {};
    const plan = isRecord(payload.plan) ? payload.plan : {};
    const share = isRecord(plan.share) ? plan.share : undefined;
    return {
      channel: send.channel,
      syncStatus: share?.syncStatus ?? null,
      ...(share?.lastSyncError === undefined
        ? {}
        : { lastSyncError: share.lastSyncError }),
    };
  });
}

// Ids, times and hashes differ per run; the snapshot keeps their shape, and
// ids and hashes keep their relations through numbered placeholders. The
// product name and the fixture API key are replaced too.
function stable(value: unknown): unknown {
  const uuids = new Map<string, string>();
  const hashes = new Map<string, string>();
  const placeholder = (
    map: Map<string, string>,
    kind: string,
    raw: string,
  ): string => {
    const next = map.get(raw) ?? `<${kind} ${map.size + 1}>`;
    map.set(raw, next);
    return next;
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item));
    if (isRecord(node))
      return Object.fromEntries(
        Object.entries(node).map(([key, entry]) => [key, walk(entry)]),
      );
    if (typeof node !== 'string') return node;
    if (/^\d{4}-\d{2}-\d{2}T/.test(node)) return '<time>';
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        node,
      )
    )
      return placeholder(uuids, 'uuid', node);
    if (/^[0-9a-f]{64}$/.test(node)) return placeholder(hashes, 'hash', node);
    if (/^[0-9a-f]{40}$/.test(node)) return '<commit>';
    const branded = node
      .split(BRAND.displayName)
      .join('<Brand>')
      .split(API_KEY)
      .join('<api key>');
    return branded.includes(root)
      ? branded.split(root).join('<root>').replaceAll('\\', '/')
      : branded;
  };
  return walk(value);
}

function shareResult(
  result: ShareOperationResult<TrackedPlanData | null>,
): unknown {
  return result.ok
    ? { ok: true, share: result.value?.share ?? null }
    : { ok: false, failure: result.failure };
}

function ownerThread(): PlanCommentThread {
  return {
    id: 'thread-owner',
    status: 'open',
    createdAt: FIXED_TIME,
    anchor: { quote: 'Second step.', lineStart: 5, lineEnd: 5 },
    anchorState: 'matched',
    comments: [
      {
        id: 'comment-owner-1',
        author: 'user',
        body: 'Should this run before the migration?',
        createdAt: FIXED_TIME,
        staged: false,
      },
    ],
  };
}

function frame(id: number, remoteId: string): string {
  const envelope = {
    type: 'plan.detail',
    eventId: `event-${id}`,
    occurredAt: FIXED_TIME,
    sequence: id,
    payload: { planId: remoteId, revision: id },
  };
  return `id: ${id}\nevent: plan.detail\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function openStreams(remoteId: string): OpenStream[] {
  return streams.filter(
    (stream) => stream.remoteId === remoteId && !stream.closed,
  );
}

function advisorAction(
  action: AppAdvisorAction,
): AdvisorSharingActions.AdvisorSharingAction {
  if (!advisorActions.isAdvisorSharingAction(action))
    throw new Error(`${action.type} is not a sharing action`);
  return action;
}

function dispatchAdvisor(action: AppAdvisorAction): Promise<unknown> {
  return advisorActions.dispatchAdvisorSharingAction(
    advisorAction(action),
    advisorHost.mainAdvisorSharingActionHost({
      chatId: 'advisor-chat',
      idempotencyKey: 'advisor-golden',
      getWindow: () => null,
      readTabs: () => Promise.resolve(null),
      requestUserAnswers: () => Promise.resolve([]),
    }),
  );
}

async function createPlan(content: string): Promise<TrackedPlanData> {
  return must(
    await invokePlan(IPC_CHANNELS.trackedPlansCreate, {
      ...scope,
      source: 'claude',
      content,
    }),
  );
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'shared-plans-golden-')));
  const dataDir = join(root, 'data');
  process.env.CANOPY_DATA_DIR = dataDir;
  worktreePath = join(
    dataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktrees',
    WORKTREE_ID,
  );
  mkdirSync(worktreePath, { recursive: true });
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Widgets',
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
    repoPath: worktreePath,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', WORKSPACE_ID, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: 'golden',
        createdAt: FIXED_TIME,
      },
    ],
  });
  git(['init', '--quiet', '--initial-branch=golden']);
  git(['remote', 'add', 'origin', CREDENTIALED_REMOTE]);
  // A local origin/HEAD keeps the default-branch read off the network.
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  git(['commit', '--quiet', '--allow-empty', '-m', 'Initial commit']);

  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(fakeCloud);
  jest.useFakeTimers({
    doNotFake: [
      'nextTick',
      'setImmediate',
      'queueMicrotask',
      'Date',
      'hrtime',
      'performance',
    ],
  });

  const accountStore = await import('../lib/canopy-cloud-account-store');
  await accountStore.saveCanopyCloudAccount({
    apiKey: API_KEY,
    capabilities: ['plans-crud-v1'],
    organizations: [
      {
        id: ORG_ID,
        name: 'Example Org',
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    teams: [
      {
        id: TEAM_ID,
        name: 'Platform',
        organization: {
          id: ORG_ID,
          name: 'Example Org',
          createdAt: FIXED_TIME,
          updatedAt: FIXED_TIME,
        },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  });
  const registry = await import('../lib/workspace-registry');
  registry.registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
  const { resolveTrackedPlansFilePath } =
    await import('../lib/resolve-worktree');
  plansFilePath = resolveTrackedPlansFilePath(WORKSPACE_ID, WORKTREE_ID);
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  const { registerPlansHandlers } = await import('../ipc/plans');
  registerPlansHandlers(
    () => null,
    dispatcher,
    (event: DesktopIpcEvent) => deriveDesktopIpcCaller(event, CALLER_OPTIONS),
  );
  persistence = await import('../lib/plan-persistence');
  sync = await import('../lib/shared-plan-sync');
  commentReply = await import('../lib/plan-comment-reply');
  advisorActions = await import('../app-advisor/advisor-sharing-actions');
  advisorHost = await import('../app-advisor/advisor-sharing-actions-host');
  // The same wiring ipc/index.ts installs at startup.
  sync.initializeSharedPlanSync({ getWindow: () => null });
  persistence.addPlanShareChangeListener((plan) => {
    sync.queueSharedPlanSync(plan, 'plan');
    sync.syncPlanRealtimeSubscription(plan);
  });
  persistence.addPlanDiagramArtifactChangeListener((plan) => {
    sync.queueSharedPlanSync(plan, 'diagram');
  });
});

afterAll(async () => {
  sync.stopAllPlanRealtimeSubscriptions();
  await dispatcher.shutdown();
  jest.useRealTimers();
  fetchSpy.mockRestore();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mark();
});

describe('shared plan collaboration (CAN-4166 golden)', () => {
  let planA: TrackedPlanData;

  it('shares a plan to a team through tracked-plans:share', async () => {
    planA = await createPlan('# Rollout plan\n\nFirst step.\n\nSecond step.');
    const withComments = await invokePlan(
      IPC_CHANNELS.trackedPlansSaveComments,
      { ...scope, planId: planA.id, commentThreads: [ownerThread()] },
    );
    expect(must(withComments).share).toBeUndefined();
    const beforeShare = newRequests().length;

    const result = await invokeShare(IPC_CHANNELS.trackedPlansShare, {
      ...scope,
      planId: planA.id,
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    await until(
      () => openStreams('remote-plan-1').length === 1,
      'realtime stream for the new share',
    );
    await quiet();

    expect(beforeShare).toBe(0);
    expect(result.ok).toBe(true);
    const wire = JSON.stringify(requests);
    expect(wire).not.toContain('secret-token');
    expect(wire).not.toContain('deploy-user');
    expect(must(serverPlans.get('remote-plan-1')).shareScope).toBe('team');
    expect(
      stable({
        result: shareResult(result),
        requests: newRequests(),
        windowUpdates: sentShareStates(),
        stored: (await readPlan(planA.id)).share,
      }),
    ).toMatchSnapshot();
  });

  it('pushes after a plan write and after a diagram write', async () => {
    const updated = await invokePlan(IPC_CHANNELS.trackedPlansUpdate, {
      ...scope,
      planId: planA.id,
      content: '# Rollout plan\n\nFirst step.\n\nSecond step.\n\nThird step.',
    });
    expect(must(updated).latestRevisionNumber).toBe(2);
    expect(countRequests('PUT', '<api>/plans/remote-plan-1')).toBe(0);
    jest.advanceTimersByTime(999);
    await sleep(20);
    expect(countRequests('PUT', '<api>/plans/remote-plan-1')).toBe(0);
    jest.advanceTimersByTime(1);
    await until(
      () => countRequests('PUT', '<api>/plans/remote-plan-1') === 1,
      'push after the plan write',
    );
    await syncSettled(planA.id);
    const afterPlanWrite = {
      requests: newRequests(),
      windowUpdates: sentShareStates(),
      stored: (await readPlan(planA.id)).share,
    };

    mark();
    await persistence.setPlanDiagramArtifact(
      WORKSPACE_ID,
      WORKTREE_ID,
      planA.id,
      'sequence',
      {
        data: {
          schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
          nodes: [],
          edges: [],
        },
        derivedFromRevision: 2,
        status: 'ready',
        generatedAt: FIXED_TIME,
      },
    );
    jest.advanceTimersByTime(1000);
    await until(
      () => countRequests('PUT', '<api>/plans/remote-plan-1') === 1,
      'push after the diagram write',
    );
    await syncSettled(planA.id);
    expect(must(serverPlans.get('remote-plan-1')).diagrams).toMatchObject({
      sequence: { status: 'ready' },
    });
    expect(
      stable({
        afterPlanWrite,
        afterDiagramWrite: {
          requests: newRequests(),
          windowUpdates: sentShareStates(),
          stored: (await readPlan(planA.id)).share,
        },
      }),
    ).toMatchSnapshot();
  });

  it('pushes saved comments and agent replies, and refuses a draft-only reply', async () => {
    const reply: PlanCommentThread = {
      ...ownerThread(),
      comments: [
        ...ownerThread().comments,
        {
          id: 'comment-owner-2',
          author: 'user',
          body: 'Also check the rollback.',
          createdAt: FIXED_TIME,
          staged: false,
        },
      ],
    };
    const saved = await invokePlan(IPC_CHANNELS.trackedPlansSaveComments, {
      ...scope,
      planId: planA.id,
      commentThreads: [reply],
    });
    jest.advanceTimersByTime(1000);
    await until(
      () => countRequests('PUT', '<api>/plans/remote-plan-1') === 1,
      'push after saved comments',
    );
    await syncSettled(planA.id);
    const afterSave = {
      returnedThreads: must(saved).commentThreads,
      requests: newRequests(),
      windowUpdates: sentShareStates(),
    };

    mark();
    const agentReply = await commentReply.replyToPlanCommentThread({
      ...scope,
      planId: planA.id,
      threadId: 'thread-owner',
      body: 'It runs after the migration; I moved it.',
      resolve: true,
      requireSubmittedThread: true,
    });
    jest.advanceTimersByTime(1000);
    await until(
      () => countRequests('PUT', '<api>/plans/remote-plan-1') === 1,
      'push after the agent reply',
    );
    await syncSettled(planA.id);
    const afterAgentReply = {
      result: { ok: agentReply.ok, error: agentReply.error ?? null },
      requests: newRequests(),
      windowUpdates: sentShareStates(),
    };

    mark();
    const draftOnly: PlanCommentThread = {
      id: 'thread-draft',
      status: 'open',
      createdAt: FIXED_TIME,
      anchor: { quote: 'First step.', lineStart: 3, lineEnd: 3 },
      anchorState: 'matched',
      comments: [
        {
          id: 'comment-draft-1',
          author: 'user',
          body: 'Draft, not sent yet.',
          createdAt: FIXED_TIME,
          staged: true,
        },
      ],
    };
    await invoke(IPC_CHANNELS.trackedPlansSaveComments, {
      ...scope,
      planId: planA.id,
      commentThreads: [draftOnly],
    });
    jest.advanceTimersByTime(1000);
    await until(
      () => countRequests('PUT', '<api>/plans/remote-plan-1') === 1,
      'push after the draft comment',
    );
    await syncSettled(planA.id);
    mark();
    let refused: PlanPersistence.AppendPlanCommentReplyResult | null = null;
    void commentReply
      .replyToPlanCommentThread(
        {
          ...scope,
          planId: planA.id,
          threadId: 'thread-draft',
          body: 'Replying to a draft.',
          resolve: false,
          requireSubmittedThread: true,
        },
        { handoffGraceMs: 50 },
      )
      .then((value) => {
        refused = value;
      });
    await advanceUntil(() => refused !== null, 'draft-only refusal', 50);
    await quiet();
    jest.advanceTimersByTime(1000);
    await quiet();
    const missing = await commentReply.replyToPlanCommentThread({
      ...scope,
      planId: planA.id,
      threadId: 'thread-gone',
      body: 'Nobody reads this.',
      resolve: false,
      requireSubmittedThread: true,
    });
    const serverThreads = records(
      must(serverPlans.get('remote-plan-1')).commentThreads,
    );
    expect(
      serverThreads.find((thread) => thread.id === 'thread-owner'),
    ).toMatchObject({ status: 'resolved' });
    expect(
      stable({
        afterSave,
        afterAgentReply,
        draftOnlyReply: { result: refused, requests: newRequests() },
        missingThreadReply: missing,
      }),
    ).toMatchSnapshot();
  });

  it('pulls teammate comments through tracked-plans:refresh-comments', async () => {
    const detail = must(serverPlans.get('remote-plan-1'));
    detail.commentThreads = mergeThreads(detail.commentThreads, [
      {
        id: 'thread-teammate',
        status: 'open',
        createdAt: FIXED_TIME,
        anchor: { quote: 'Third step.', lineStart: 7, lineEnd: 7 },
        anchorState: 'matched',
        comments: [
          {
            id: 'comment-teammate-1',
            author: 'remote',
            remoteAuthor: { userId: 'teammate-1', displayName: 'Teammate' },
            body: 'Can we split this step?',
            createdAt: FIXED_TIME,
          },
        ],
      },
    ]);
    const refreshed = await invokePlan(
      IPC_CHANNELS.trackedPlansRefreshComments,
      { ...scope, planId: planA.id },
    );
    await quiet();
    const firstPull = {
      threads: must(refreshed).commentThreads?.map((thread) => ({
        id: thread.id,
        status: thread.status,
        comments: thread.comments.map((comment) => ({
          id: comment.id,
          author: comment.author,
          remoteAuthor: comment.remoteAuthor ?? null,
        })),
      })),
      requests: newRequests(),
      windowUpdates: sentShareStates(),
    };
    mark();
    const again = await invokePlan(IPC_CHANNELS.trackedPlansRefreshComments, {
      ...scope,
      planId: planA.id,
    });
    await quiet();
    const unchangedPull = {
      requests: newRequests(),
      windowUpdates: sentShareStates(),
    };
    const unshared = await createPlan('# Local only\n\nNot shared.');
    mark();
    const notShared = await invokePlan(
      IPC_CHANNELS.trackedPlansRefreshComments,
      { ...scope, planId: unshared.id },
    );
    const unknown = await invokePlan(IPC_CHANNELS.trackedPlansRefreshComments, {
      ...scope,
      planId: 'plan-missing',
    });
    expect(must(again).commentThreads).toEqual(must(refreshed).commentThreads);
    expect(
      stable({
        firstPull,
        unchangedPull,
        notShared: {
          share: must(notShared).share ?? null,
          requests: newRequests(),
        },
        unknownPlan: unknown,
      }),
    ).toMatchSnapshot();
  });

  it('pulls on a realtime signal and resumes with Last-Event-ID after a reconnect', async () => {
    const stream = must(openStreams('remote-plan-1')[0]);
    const detail = must(serverPlans.get('remote-plan-1'));
    const teammate = must(
      records(detail.commentThreads).find(
        (thread) => thread.id === 'thread-teammate',
      ),
    );
    teammate.comments = [
      ...records(teammate.comments),
      {
        id: 'comment-teammate-2',
        author: 'remote',
        remoteAuthor: { userId: 'teammate-1', displayName: 'Teammate' },
        body: 'Pushed over the live stream.',
        createdAt: FIXED_TIME,
      },
    ];
    stream.push(': keepalive\n\n');
    stream.push('id: 6\nevent: other.event\ndata: {}\n\n');
    stream.push(frame(7, 'remote-plan-1'));
    await until(
      () => countRequests('GET', '<api>/plans/remote-plan-1') === 1,
      'pull on the realtime signal',
    );
    // The pull's merge announces the plan right after writing it.
    await until(
      async () =>
        (await readPlan(planA.id)).commentThreads?.some((thread) =>
          thread.comments.some(
            (comment) => comment.id === 'comment-teammate-2',
          ),
        ) === true,
      'realtime pull merges the teammate comment',
    );
    await quiet();
    const local = await readPlan(planA.id);
    const pulled = {
      requests: newRequests(),
      windowUpdates: sentShareStates(),
      teammateComments: local.commentThreads
        ?.find((thread) => thread.id === 'thread-teammate')
        ?.comments.map((comment) => comment.id),
    };

    mark();
    stream.close();
    await sleep(20);
    jest.advanceTimersByTime(4_999);
    await sleep(20);
    const beforeBackoff = newRequests().length;
    jest.advanceTimersByTime(1);
    await until(
      () => openStreams('remote-plan-1').length === 1,
      'reconnect after the backoff',
    );
    await quiet();
    expect(beforeBackoff).toBe(0);
    expect(stable({ pulled, reconnect: newRequests() })).toMatchSnapshot();
  });

  it('queues sync and reopens subscriptions from the startup inventory', async () => {
    sync.initializeSharedPlanSync({ getWindow: () => null });
    await until(
      () => openStreams('remote-plan-1').length === 0,
      'subscriptions stop on re-initialization',
    );
    const inventory = await sync.readStartupTrackedPlanInventory();
    mark();
    await sync.initializeSharedPlanStartup();
    await until(
      () => openStreams('remote-plan-1').length === 1,
      'startup subscription',
    );
    jest.advanceTimersByTime(1000);
    await until(
      () => countRequests('PUT', '<api>/plans/remote-plan-1') === 1,
      'startup sync',
    );
    await syncSettled(planA.id);
    expect(
      stable({
        inventory: inventory.map((entry) => ({
          projectId: entry.projectId,
          worktreeId: entry.worktreeId,
          plans: entry.plans.map((plan) => ({
            title: plan.title,
            shared: plan.share !== undefined,
          })),
        })),
        requests: newRequests(),
        windowUpdates: sentShareStates(),
        stored: (await readPlan(planA.id)).share,
      }),
    ).toMatchSnapshot();
  });

  it('refuses read-only and recipient-scope callers', async () => {
    const viewer = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: planA.id,
    };
    const share = await invokeShare(IPC_CHANNELS.trackedPlansShare, {
      ...viewer,
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    const unshare = await invokeShare(IPC_CHANNELS.trackedPlansUnshare, viewer);
    let saveError: unknown = null;
    await invoke(IPC_CHANNELS.trackedPlansSaveComments, {
      ...viewer,
      commentThreads: [ownerThread()],
    }).catch((error: unknown) => {
      saveError = error instanceof Error ? error.message : error;
    });
    const refresh = await invokePlan(
      IPC_CHANNELS.trackedPlansRefreshComments,
      viewer,
    ).catch((error: unknown) =>
      error instanceof Error ? { error: error.message } : error,
    );
    expect((await readPlan(planA.id)).share?.remoteId).toBe('remote-plan-1');
    expect(
      stable({
        share: shareResult(share),
        unshare: shareResult(unshare),
        saveComments: saveError,
        refreshComments: refresh,
        requests: newRequests(),
      }),
    ).toMatchSnapshot();
  });

  it('refuses a share without the needed audience or permission', async () => {
    const planC = await createPlan('# Viewer plan\n\nRead only.');
    mark();
    const noTeam = await invokeShare(IPC_CHANNELS.trackedPlansShare, {
      ...scope,
      planId: planC.id,
      shareScope: 'team',
    });
    const noOrganization = await invokeShare(IPC_CHANNELS.trackedPlansShare, {
      ...scope,
      planId: planC.id,
      shareScope: 'organization',
    });
    const audienceRequests = newRequests();
    mark();
    faults.push({
      method: 'POST',
      path: '<api>/plans',
      status: 403,
      body: {
        error: 'Viewers cannot share plans with this team.',
        reason: 'publisher_role_required',
      },
    });
    const forbidden = await invokeShare(IPC_CHANNELS.trackedPlansShare, {
      ...scope,
      planId: planC.id,
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    const missingPlan = await invokeShare(IPC_CHANNELS.trackedPlansShare, {
      ...scope,
      planId: 'plan-missing',
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    await quiet();
    expect((await readPlan(planC.id)).share).toBeUndefined();
    expect(
      stable({
        teamWithoutTeamId: shareResult(noTeam),
        organizationWithoutId: shareResult(noOrganization),
        audienceRequests,
        viewerRole: shareResult(forbidden),
        missingPlan: shareResult(missingPlan),
        requests: newRequests().map((request) => ({
          method: request.method,
          path: request.path,
        })),
      }),
    ).toMatchSnapshot();
  });

  it('shares and unshares through App Advisor', async () => {
    const planB = await createPlan('# Advisor plan\n\nShared by the advisor.');
    const target = { ...scope, planId: planB.id };
    mark();
    const noContext = await dispatchAdvisor({
      type: 'plan.share',
      ...target,
      shareScope: 'organization',
    });
    const forged = await dispatchAdvisor({
      type: 'plan.share',
      ...target,
      shareScope: 'organization',
      organizationId: 'org-elsewhere',
    });
    const notFound = await dispatchAdvisor({
      type: 'plan.share',
      ...scope,
      planId: 'plan-missing',
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    const refusalRequests = newRequests();
    mark();
    const shared = await dispatchAdvisor({
      type: 'plan.share',
      ...target,
      shareScope: 'organization',
      organizationId: ORG_ID,
    });
    await until(
      () => openStreams('remote-plan-2').length === 1,
      'realtime stream for the advisor share',
    );
    await quiet();
    const shareRequests = newRequests().map((request) => ({
      method: request.method,
      path: request.path,
      ...(isRecord(request.body)
        ? {
            shareScope: request.body.shareScope,
            organizationId: request.body.organizationId,
          }
        : {}),
    }));

    mark();
    faults.push({
      method: 'DELETE',
      path: '<api>/plans/remote-plan-2',
      status: 503,
      body: { error: 'Service unavailable.' },
    });
    const failedUnshare = await invokeShare(
      IPC_CHANNELS.trackedPlansUnshare,
      target,
    );
    const keptShare = (await readPlan(planB.id)).share;
    jest.advanceTimersByTime(1000);
    await quiet();
    const failedUnshareRequests = newRequests();

    mark();
    const unshared = await dispatchAdvisor({ type: 'plan.unshare', ...target });
    await until(
      () => openStreams('remote-plan-2').length === 0,
      'advisor unshare stops the stream',
    );
    const unsharedAgain = await dispatchAdvisor({
      type: 'plan.unshare',
      ...target,
    });
    const unshareMissing = await dispatchAdvisor({
      type: 'plan.unshare',
      ...scope,
      planId: 'plan-missing',
    });
    await quiet();
    expect(serverPlans.has('remote-plan-2')).toBe(false);
    expect((await readPlan(planB.id)).share).toBeUndefined();
    expect(
      stable({
        organizationWithoutContext: noContext,
        forgedOrganization: forged,
        missingPlan: notFound,
        refusalRequests,
        shared,
        shareRequests,
        failedUnshare: shareResult(failedUnshare),
        keptShare,
        failedUnshareRequests,
        unshared,
        unsharedAgain,
        unshareMissing,
        unshareRequests: newRequests(),
      }),
    ).toMatchSnapshot();
  });

  it('refuses writes to a revoked share and still clears it on unshare', async () => {
    serverPlans.delete('remote-plan-1');
    await invoke(IPC_CHANNELS.trackedPlansUpdate, {
      ...scope,
      planId: planA.id,
      content: '# Rollout plan\n\nFirst step.\n\nRevoked edit.',
    });
    jest.advanceTimersByTime(1000);
    await until(
      () => countRequests('PUT', '<api>/plans/remote-plan-1') === 1,
      'push to the revoked share',
    );
    await syncSettled(planA.id);
    const revokedPush = {
      requests: newRequests(),
      windowUpdates: sentShareStates(),
      stored: (await readPlan(planA.id)).share,
    };
    mark();
    jest.advanceTimersByTime(10 * 60 * 1000);
    await quiet();
    const retriesAfterRefusal = newRequests().length;

    mark();
    const reshare = await invokeShare(IPC_CHANNELS.trackedPlansShare, {
      ...scope,
      planId: planA.id,
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    await quiet();
    const reshareRequests = newRequests();

    mark();
    const unshare = await invokeShare(IPC_CHANNELS.trackedPlansUnshare, {
      ...scope,
      planId: planA.id,
    });
    await until(
      () => openStreams('remote-plan-1').length === 0,
      'unshare stops the stream',
    );
    await quiet();
    const unshareRequests = newRequests();

    mark();
    await invoke(IPC_CHANNELS.trackedPlansUpdate, {
      ...scope,
      planId: planA.id,
      content: '# Rollout plan\n\nAfter unsharing.',
    });
    jest.advanceTimersByTime(1000);
    await quiet();
    const local = await readPlan(planA.id);
    expect(local.share).toBeUndefined();
    expect(local.commentThreads?.map((thread) => thread.id)).toEqual(
      expect.arrayContaining(['thread-owner', 'thread-teammate']),
    );
    expect(
      stable({
        revokedPush,
        retriesAfterRefusal,
        reshare: shareResult(reshare),
        reshareRequests,
        unshare: shareResult(unshare),
        unshareRequests,
        writeAfterUnshare: newRequests(),
      }),
    ).toMatchSnapshot();
  });
});
