// CAN-4166 golden: who may share a plan, and as whom, before core.publication
// serves it on desktop. It pins the Remote Control matrix for the shared-plan
// channels and the principal each caller acts as, so serving core.publication
// cannot widen or narrow either one unnoticed. It drives the real
// `tracked-plans:*` IPC handlers, plan persistence, the cloud client and
// account store, App Advisor's sharing actions, a real Remote Control host
// session over the in-memory relay, the remote core access and the renderer
// relay on a temporary data root with a real Git checkout. Every IPC caller is
// resolved by the production resolver. Only IPC registration, window sends,
// the cloud base URL and the Electron bridge window are
// replaced, and HTTP goes to an in-test shared-plan server.
import { execFileSync } from 'node:child_process';
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
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { APP_ADVISOR_ACTION_DISPOSITIONS } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import { PORTAL_COMMAND_TYPES } from '@canopy/protocol/portal';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type * as CloudConfig from '../canopy-cloud/config';
import type * as MainProcessLogging from '../lib/main-process-logging';
import type * as SharedPlanSync from '../lib/shared-plan-sync';
import type * as AdvisorSharingActions from '../app-advisor/advisor-sharing-actions';
import type * as AdvisorSharingActionsHost from '../app-advisor/advisor-sharing-actions-host';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import {
  deriveDesktopIpcCaller,
  type DesktopIpcCallerOptions,
  type DesktopIpcEvent,
  type DesktopIpcFrame,
} from '../canopy-runtime/desktop-ipc-caller';
import {
  createRendererRelay,
  type RendererRelay,
  type RendererRelayEvent,
  type RendererRelaySender,
} from '../canopy-runtime/renderer-relay/relay';
import { createInterimInMemoryBindingProvider } from '../canopy-runtime/renderer-relay/interim-in-memory-binding';
import { resolveTrustedRelaySurface } from '../canopy-runtime/renderer-relay/trusted-surface';
import {
  appAdvisorActionCaller,
  missingAppAdvisorGrants,
} from '../app-advisor/action-caller';
import {
  controllerMayInvoke,
  controllerMayUseChannel,
} from '../remote-control/host/controller-profile';
import { RemoteHostSession } from '../remote-control/host/host-session';
import type { HostBridge } from '../remote-control/host/bridge-window';
import { createRemoteCoreAccess } from '../remote-control/host/remote-core-access';
import { RemoteUploadStore } from '../remote-control/host/uploads';
import {
  HelloResultSchema,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
} from '../remote-control/remote-protocol';
import { RpcPeer } from '../remote-control/transport/rpc-peer';
import { InMemoryRelayHub } from '../remote-control/__tests__/in-memory-relay';
import {
  createTestDevice,
  openControlSession,
} from '../remote-control/__tests__/session-pair';

jest.setTimeout(60_000);

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
const windowSends: { channel: string; payload: unknown }[] = [];
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

const WORKSPACE_ID = 'plan-publication-golden';
const WORKTREE_ID = 'golden-wt';
const TEAM_ID = 'team-golden';
const ORG_ID = 'org-golden';
const API_KEY = 'csk_plan_publication_golden';
const FIXED_TIME = '2026-11-01T12:00:00.000Z';
const CONTROLLER_KINDS: readonly DeviceKind[] = [
  'desktop',
  'mobile',
  'browser',
  'hosted',
];
const SHARED_PLAN_INVOKE_CHANNELS = [
  IPC_CHANNELS.trackedPlansShare,
  IPC_CHANNELS.trackedPlansUnshare,
  IPC_CHANNELS.trackedPlansRefreshComments,
  IPC_CHANNELS.trackedPlansSaveComments,
];
const PUBLICATION_OPERATIONS = {
  query: ['core.publication.get', 'core.publication.list'],
  instruction: [
    'core.publication.create',
    'core.publication.update',
    'core.publication.delete',
  ],
} as const;

// --- In-test shared-plan server ---------------------------------------------

type Json = Record<string, unknown>;
interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
}

const serverPlans = new Map<string, Json>();
const requests: RecordedRequest[] = [];
let remoteSequence = 0;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// A share's realtime stream stays open until the client aborts it.
function openStream(signal: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      signal?.addEventListener(
        'abort',
        () => controller.error(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function fakeCloud(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(requestUrl(input));
  const method = (init?.method ?? 'GET').toUpperCase();
  const parsed: unknown =
    typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  const body = isRecord(parsed) ? parsed : {};
  const path = url.pathname.replace(/^\/api\/v1\/[^/]+/, '<api>');
  requests.push({
    method,
    path,
    authorization: new Headers(init?.headers).get('authorization'),
  });
  const match = /^<api>\/plans(?:\/([^/]+))?(\/stream)?$/.exec(path);
  if (!match) return Promise.resolve(json(404, { error: 'Not found.' }));
  const remoteId = match[1];
  if (match[2] && remoteId)
    return Promise.resolve(openStream(init?.signal ?? null));
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
      owner:
        body.shareScope === 'team'
          ? {
              type: 'team',
              id: body.teamId,
              name: 'Platform',
              organization: { id: ORG_ID, name: 'Example Org' },
            }
          : { type: 'organization', id: ORG_ID, name: 'Example Org' },
      createdBy: { id: 'account-golden', name: 'Plan Owner', email: null },
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      canUpdate: true,
      canDelete: true,
      content: body.content,
      commentThreads: [],
    };
    serverPlans.set(id, detail);
    return Promise.resolve(json(201, detail));
  }
  const existing = remoteId ? serverPlans.get(remoteId) : undefined;
  if (!remoteId || !existing)
    return Promise.resolve(json(404, { error: 'Shared plan not found.' }));
  if (method === 'GET') return Promise.resolve(json(200, existing));
  if (method === 'DELETE') {
    serverPlans.delete(remoteId);
    return Promise.resolve(json(200, { unshared: true }));
  }
  return Promise.resolve(json(405, { error: 'Method not allowed.' }));
}

// --- Harness ------------------------------------------------------------------

let root: string;
let dataDir: string;
let worktreePath: string;
let sync: typeof SharedPlanSync;
let advisorActions: typeof AdvisorSharingActions;
let advisorHost: typeof AdvisorSharingActionsHost;
let fetchSpy: jest.SpyInstance;
let dispatcher: DesktopCanopyDispatcher;
let relay: RendererRelay;
let dispatcherCalls: () => { name: string; caller: unknown }[];
let clearDispatcherCalls: () => void;
const originalDataDir = process.env.CANOPY_DATA_DIR;

function frameFor(url: string): DesktopIpcFrame {
  return { url, detached: false, isDestroyed: () => false };
}

function sender(id: number, url: string): RendererRelaySender {
  const mainFrame = frameFor(url);
  return {
    id,
    mainFrame,
    getURL: () => url,
    isDestroyed: () => false,
    on: () => undefined,
    removeListener: () => undefined,
  };
}

function eventFrom(from: RendererRelaySender): RendererRelayEvent {
  return { sender: from, senderFrame: from.mainFrame };
}

const RENDERER_URL = 'file:///app/renderer/index.html';
const ADVISOR_URL = 'file:///app/renderer/app-advisor.html';
const BRIDGE_URL = 'file:///app/renderer/remote-bridge.html';
const MAIN_WINDOW = sender(1, RENDERER_URL);
const ADVISOR_WINDOW = sender(2, ADVISOR_URL);
// The hidden window a paired controller's calls replay through.
const BRIDGE_WINDOW = sender(7, BRIDGE_URL);
const MAIN_WINDOW_EVENT = eventFrom(MAIN_WINDOW);
const BRIDGE_EVENT = eventFrom(BRIDGE_WINDOW);
const liveWindow = (
  contents: RendererRelaySender,
): { isDestroyed: () => boolean; webContents: RendererRelaySender } => ({
  isDestroyed: () => false,
  webContents: contents,
});

// The controller behind the bridge window, as bridge-window.ts records it.
let bridgeController: string | null = null;
const CALLER_OPTIONS: DesktopIpcCallerOptions = {
  getAppWindows: () => [liveWindow(MAIN_WINDOW), liveWindow(ADVISOR_WINDOW)],
  packagedRendererUrls: [RENDERER_URL, ADVISOR_URL],
  resolveRemoteBridgeSender: (from) =>
    from === BRIDGE_WINDOW ? bridgeController : null,
};

// Every caller the IPC handlers resolved, in order.
const resolvedCallers: CanopyCallerDescriptor[] = [];

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
    setTimeout(resolve, ms);
  });
}

// Wait until no request or window send has arrived for a few polls.
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

function handler(channel: string): Handler {
  const registered = handlers.get(channel);
  if (!registered) throw new Error(`No handler for ${channel}`);
  return registered;
}

async function invoke(channel: string, request: unknown): Promise<unknown> {
  const result: unknown = await handler(channel)(MAIN_WINDOW_EVENT, request);
  return result;
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('expected a value');
  return value;
}

function isPlan(value: unknown): value is TrackedPlanData {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.projectId === 'string'
  );
}

const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };

async function createPlan(content: string): Promise<TrackedPlanData> {
  const created = await invoke(IPC_CHANNELS.trackedPlansCreate, {
    ...scope,
    source: 'pipeline',
    content,
  });
  if (!isPlan(created)) throw new Error('create answered no plan');
  return created;
}

async function readPlan(planId: string): Promise<TrackedPlanData | null> {
  const plan = await invoke(IPC_CHANNELS.trackedPlansGet, {
    ...scope,
    planId,
  });
  return isPlan(plan) ? plan : null;
}

const plansFile = (): string =>
  join(dataDir, 'workspaces', WORKSPACE_ID, 'plans', `${WORKTREE_ID}.json`);

let requestMark = 0;
let sendMark = 0;
let callerMark = 0;
function mark(): void {
  requestMark = requests.length;
  sendMark = windowSends.length;
  callerMark = resolvedCallers.length;
  clearDispatcherCalls();
}
function newRequests(): RecordedRequest[] {
  return requests.slice(requestMark);
}
function newSends(): { channel: string; payload: unknown }[] {
  return windowSends.slice(sendMark);
}
function newPrincipals(): string[] {
  return resolvedCallers.slice(callerMark).map((caller) => caller.principalId);
}
function hostedWrites(): { method: string; path: string }[] {
  return newRequests()
    .filter((request) => request.method !== 'GET')
    .map(({ method, path }) => ({ method, path }));
}

async function share(
  call: (request: unknown) => Promise<unknown>,
  planId: string,
): Promise<unknown> {
  const result = await call({
    ...scope,
    planId,
    shareScope: 'team',
    teamId: TEAM_ID,
  });
  await quiet();
  return result;
}

function advisorAction(
  action: Parameters<typeof advisorActions.isAdvisorSharingAction>[0],
): AdvisorSharingActions.AdvisorSharingAction {
  if (!advisorActions.isAdvisorSharingAction(action))
    throw new Error(`${action.type} is not a sharing action`);
  return action;
}

function dispatchAdvisor(
  action: Parameters<typeof advisorActions.isAdvisorSharingAction>[0],
): Promise<unknown> {
  return advisorActions.dispatchAdvisorSharingAction(
    advisorAction(action),
    advisorHost.mainAdvisorSharingActionHost({
      chatId: 'advisor-chat',
      idempotencyKey: 'plan-publication-golden',
      getWindow: () => null,
      readTabs: () => Promise.resolve(null),
      requestUserAnswers: () => Promise.resolve([]),
    }),
  );
}

// --- Remote Control host session ---------------------------------------------

interface ControllerSession {
  controller: RpcPeer;
  deviceId: string;
  /** The channels the host replayed through its bridge window. */
  bridgeCalls: string[];
  hello: unknown;
}

const noop = (): void => undefined;

// One paired controller of `kind` on a real host session. Only the Electron
// bridge window is replaced: it replays each call through the real IPC
// handler as the bridge window's sender, as the hidden window does.
async function withController(
  kind: DeviceKind,
  run: (session: ControllerSession) => Promise<void>,
): Promise<void> {
  const hub = new InMemoryRelayHub();
  const controllerDevice = createTestDevice(hub, 'Controller');
  const hostDevice = createTestDevice(hub, 'Host');
  const { initiator, responder } = await openControlSession(
    controllerDevice,
    hostDevice,
  );
  const bridgeCalls: string[] = [];
  const bridge: HostBridge = {
    window: null,
    getChatInterest: (): undefined => undefined,
    invoke: async (channel, args) => {
      bridgeCalls.push(channel);
      const result: unknown = await handler(channel)(BRIDGE_EVENT, ...args);
      return result;
    },
    post: noop,
    onPush: () => noop,
    onClosed: () => noop,
    destroy: noop,
  };
  const version = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    appVersion: '2.0.0',
  };
  const host = new RemoteHostSession({
    session: responder,
    kind,
    attributedDeviceId: controllerDevice.identity.deviceId,
    createBridge: (): Promise<HostBridge> => Promise.resolve(bridge),
    mainWindowPushes: { subscribe: (): (() => void) => noop },
    uploads: new RemoteUploadStore(join(root, 'uploads')),
    readFile: (): Promise<never> =>
      Promise.reject(new Error('Unexpected file read')),
    disposition: getRemoteChannelDisposition,
    isAuthorized: (): boolean => true,
    version,
    hello: (): { name: string; platform: 'darwin' } => ({
      name: 'Host',
      platform: 'darwin',
    }),
    onClose: noop,
    core: createRemoteCoreAccess(() => dispatcher),
  });
  bridgeController = host.controllerDeviceId;
  const controller = new RpcPeer(initiator, {
    onRequest: (): Promise<never> =>
      Promise.reject(new Error('Unexpected host request')),
    onEvent: noop,
  });
  try {
    const hello = HelloResultSchema.parse(
      await controller.request(REMOTE_METHODS.hello, { version }),
    );
    await run({
      controller,
      deviceId: host.controllerDeviceId,
      bridgeCalls,
      hello,
    });
  } finally {
    bridgeController = null;
    controller.close('closed');
    host.close('closed');
    for (const device of [controllerDevice, hostDevice]) {
      device.manager.dispose();
      device.endpoint.stop();
    }
  }
}

function remoteInvoke(
  session: ControllerSession,
  channel: string,
  request: unknown,
): Promise<unknown> {
  return session.controller.request(REMOTE_METHODS.invoke, {
    channel,
    args: [request],
  });
}

// --- Setup --------------------------------------------------------------------

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-publication-golden-')));
  dataDir = join(root, 'data');
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
      { id: WORKTREE_ID, branchName: 'golden', createdAt: FIXED_TIME },
    ],
  });
  git(['init', '--quiet', '--initial-branch=golden']);
  git(['remote', 'add', 'origin', 'https://git.example.test/acme/widgets.git']);
  // A local origin/HEAD keeps the default-branch read off the network.
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  git(['commit', '--quiet', '--allow-empty', '-m', 'Initial commit']);

  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(fakeCloud);

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
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  });
  const registry = await import('../lib/workspace-registry');
  registry.registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  const querySpy = jest.spyOn(dispatcher, 'query');
  const instructionSpy = jest.spyOn(dispatcher, 'instruction');
  dispatcherCalls = (): { name: string; caller: unknown }[] =>
    [...querySpy.mock.calls, ...instructionSpy.mock.calls].map((call) => {
      const [name, , options] = [...call];
      const caller =
        isRecord(options) && 'caller' in options ? options.caller : undefined;
      return { name: String(name), caller };
    });
  clearDispatcherCalls = (): void => {
    querySpy.mockClear();
    instructionSpy.mockClear();
  };
  const { registerPlansHandlers } = await import('../ipc/plans');
  registerPlansHandlers(
    () => null,
    dispatcher,
    (event: DesktopIpcEvent) => {
      const caller = deriveDesktopIpcCaller(event, CALLER_OPTIONS);
      resolvedCallers.push(caller);
      return caller;
    },
  );
  const { RENDERER_RELAY_GRANTS } = await import('../ipc/canopy-core-relay');
  relay = createRendererRelay({
    bindingProvider: createInterimInMemoryBindingProvider(dispatcher),
    resolveSurface: (event) =>
      resolveTrustedRelaySurface(
        event,
        [
          {
            surface: 'main',
            window: liveWindow(MAIN_WINDOW),
            url: RENDERER_URL,
          },
          {
            surface: 'app-advisor',
            window: liveWindow(ADVISOR_WINDOW),
            url: ADVISOR_URL,
          },
        ],
        RENDERER_RELAY_GRANTS,
      ),
  });
  sync = await import('../lib/shared-plan-sync');
  advisorActions = await import('../app-advisor/advisor-sharing-actions');
  advisorHost = await import('../app-advisor/advisor-sharing-actions-host');
  sync.initializeSharedPlanSync({ getWindow: () => null });
});

afterAll(async () => {
  sync.stopAllPlanRealtimeSubscriptions();
  relay.dispose();
  await dispatcher.shutdown();
  fetchSpy.mockRestore();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mark();
});

// --- Cases --------------------------------------------------------------------

describe('Remote Control matrix for plan sharing (CAN-4166 PR 3a)', () => {
  it('tunnels tracked-plans:share and the shared-plan channels to desktop controllers only', () => {
    const request = { ...scope, planId: 'plan-1', shareScope: 'team' };
    const matrix = Object.fromEntries(
      CONTROLLER_KINDS.map((kind) => [
        kind,
        {
          invoke: SHARED_PLAN_INVOKE_CHANNELS.filter((channel) =>
            controllerMayInvoke(
              kind,
              channel,
              [request],
              getRemoteChannelDisposition,
            ),
          ),
          push: controllerMayUseChannel(
            kind,
            IPC_CHANNELS.trackedPlansUpdated,
            getRemoteChannelDisposition,
          ),
        },
      ]),
    );
    expect(
      Object.fromEntries(
        [...SHARED_PLAN_INVOKE_CHANNELS, IPC_CHANNELS.trackedPlansUpdated].map(
          (channel) => [channel, getRemoteChannelDisposition(channel)],
        ),
      ),
    ).toEqual({
      'tracked-plans:share': 'tunnel',
      'tracked-plans:unshare': 'blocked',
      'tracked-plans:refresh-comments': 'tunnel',
      'tracked-plans:save-comments': 'tunnel',
      'tracked-plans:updated': 'tunnel',
    });
    expect(matrix).toEqual({
      desktop: {
        invoke: [
          'tracked-plans:share',
          'tracked-plans:refresh-comments',
          'tracked-plans:save-comments',
        ],
        push: true,
      },
      mobile: { invoke: [], push: true },
      browser: { invoke: [], push: true },
      hosted: { invoke: [], push: false },
    });
  });

  it('refuses tracked-plans:share from mobile, browser and hosted controllers before the bridge, with no hosted request or local write', async () => {
    const plan = await createPlan('# Remote share\n\nRefused off desktop.');
    for (const kind of ['mobile', 'browser', 'hosted'] as const) {
      const before = readFileSync(plansFile(), 'utf8');
      mark();
      await withController(kind, async (session) => {
        await expect(
          remoteInvoke(session, IPC_CHANNELS.trackedPlansShare, {
            ...scope,
            planId: plan.id,
            shareScope: 'team',
            teamId: TEAM_ID,
          }),
        ).rejects.toMatchObject({
          code: 'remote_channel_unavailable',
          message:
            '"tracked-plans:share" is not available while controlling another computer.',
        });
        expect(session.bridgeCalls).toEqual([]);
      });
      await quiet();
      expect({ kind, requests: newRequests(), sends: newSends() }).toEqual({
        kind,
        requests: [],
        sends: [],
      });
      expect(newPrincipals()).toEqual([]);
      expect(readFileSync(plansFile(), 'utf8')).toBe(before);
    }
    expect(must(await readPlan(plan.id)).share).toBeUndefined();
  });

  it('keeps tracked-plans:unshare blocked for every controller kind, with no hosted request or local write', async () => {
    const plan = await createPlan('# Shared plan\n\nOnly the window unshares.');
    const shared = await share(
      (request) => invoke(IPC_CHANNELS.trackedPlansShare, request),
      plan.id,
    );
    expect(shared).toMatchObject({ ok: true });
    const storedShare = must(await readPlan(plan.id)).share;
    expect(storedShare).toMatchObject({ shareScope: 'team', teamId: TEAM_ID });
    for (const kind of CONTROLLER_KINDS) {
      const before = readFileSync(plansFile(), 'utf8');
      mark();
      await withController(kind, async (session) => {
        await expect(
          remoteInvoke(session, IPC_CHANNELS.trackedPlansUnshare, {
            ...scope,
            planId: plan.id,
          }),
        ).rejects.toMatchObject({
          code: 'remote_channel_unavailable',
          message:
            '"tracked-plans:unshare" is not available while controlling another computer.',
        });
        expect(session.bridgeCalls).toEqual([]);
      });
      await quiet();
      expect({ kind, requests: newRequests(), sends: newSends() }).toEqual({
        kind,
        requests: [],
        sends: [],
      });
      expect(newPrincipals()).toEqual([]);
      expect(readFileSync(plansFile(), 'utf8')).toBe(before);
    }
    expect(must(await readPlan(plan.id)).share).toEqual(storedShare);
    expect(serverPlans.size).toBeGreaterThan(0);
  });

  it('serves no core.publication operation over the remote core session', async () => {
    const plan = await createPlan('# Core session\n\nNot published remotely.');
    const before = readFileSync(plansFile(), 'utf8');
    mark();
    const operations = [
      ...PUBLICATION_OPERATIONS.query,
      ...PUBLICATION_OPERATIONS.instruction,
    ];
    await withController('desktop', async (session) => {
      expect(
        Object.keys(
          isRecord(session.hello) && isRecord(session.hello.coreOperations)
            ? session.hello.coreOperations
            : {},
        ).filter((operation) => operation.startsWith('core.publication.')),
      ).toEqual([]);
      for (const operation of operations) {
        await expect(
          session.controller.request(REMOTE_METHODS.coreCall, {
            operation,
            version: 1,
            params: {
              resource: { kind: 'plan', id: plan.id, scope },
              scope: 'team',
              audienceIds: [TEAM_ID],
            },
          }),
        ).resolves.toEqual({
          ok: false,
          error: {
            kind: 'capability_unavailable',
            message: `This computer does not serve ${operation} version 1.`,
            retry: { kind: 'never' },
          },
        });
      }
      expect(session.bridgeCalls).toEqual([]);
    });
    await quiet();
    expect(newRequests()).toEqual([]);
    expect(dispatcherCalls()).toEqual([]);
    expect(readFileSync(plansFile(), 'utf8')).toBe(before);
  });

  it('refuses core.publication on the app-advisor relay surface and the bridge window', async () => {
    for (const operation of [
      ...PUBLICATION_OPERATIONS.query,
      ...PUBLICATION_OPERATIONS.instruction,
    ]) {
      const request = { kind: 'request', method: operation, params: {} };
      await expect(
        relay.invoke(eventFrom(ADVISOR_WINDOW), request),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          kind: 'capability_unavailable',
          message: `${operation} is not available here.`,
        },
      });
      await expect(relay.invoke(BRIDGE_EVENT, request)).resolves.toMatchObject({
        ok: false,
        error: { kind: 'permission_denied', message: 'Untrusted renderer.' },
      });
    }
    expect(newRequests()).toEqual([]);
    expect(dispatcherCalls()).toEqual([]);
  });

  it('answers core.publication on the main relay surface as unavailable today', async () => {
    for (const operation of [
      ...PUBLICATION_OPERATIONS.query,
      ...PUBLICATION_OPERATIONS.instruction,
    ]) {
      await expect(
        relay.invoke(MAIN_WINDOW_EVENT, {
          kind: 'request',
          method: operation,
          params: {},
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          kind: 'capability_unavailable',
          message: `${operation} is not available here.`,
        },
      });
    }
    expect(newRequests()).toEqual([]);
    expect(dispatcherCalls()).toEqual([]);
  });
});

describe('principal per caller for plan sharing (CAN-4166 PR 3a)', () => {
  const ACCOUNT_AUTHORIZATION = `Bearer ${API_KEY}`;

  it('runs tracked-plans:share from the main window with no principal, though its plan reads run as local-desktop-user', async () => {
    const plan = await createPlan('# Window share\n\nFrom the dialog.');
    mark();
    await readPlan(plan.id);
    expect(newPrincipals()).toEqual(['local-desktop-user']);
    expect(dispatcherCalls()).toMatchObject([
      {
        name: 'core.plan.get',
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: 'electron-web-contents:1',
          grants: ['core.plan.read'],
        },
      },
    ]);

    mark();
    const result = await share(
      (request) => invoke(IPC_CHANNELS.trackedPlansShare, request),
      plan.id,
    );
    expect(result).toMatchObject({ ok: true });
    expect(newPrincipals()).toEqual([]);
    expect(dispatcherCalls()).toEqual([]);
    expect(hostedWrites()).toEqual([{ method: 'POST', path: '<api>/plans' }]);
    expect(
      new Set(newRequests().map((request) => request.authorization)),
    ).toEqual(new Set([ACCOUNT_AUTHORIZATION]));
  });

  it("runs a desktop controller's tracked-plans:share with no principal, though its plan reads run as its own device", async () => {
    const plan = await createPlan(
      '# Controller share\n\nFrom a paired desktop.',
    );
    await withController('desktop', async (session) => {
      mark();
      const read = await remoteInvoke(session, IPC_CHANNELS.trackedPlansGet, {
        ...scope,
        planId: plan.id,
      });
      expect(isPlan(read) && read.id).toBe(plan.id);
      expect(newPrincipals()).toEqual([`remote-device:${session.deviceId}`]);
      expect(dispatcherCalls()).toMatchObject([
        {
          name: 'core.plan.get',
          caller: {
            principalId: `remote-device:${session.deviceId}`,
            clientInstanceId: 'remote-bridge:7',
            grants: ['core.plan.read'],
          },
        },
      ]);

      mark();
      const result = await share(
        (request) =>
          remoteInvoke(session, IPC_CHANNELS.trackedPlansShare, request),
        plan.id,
      );
      expect(result).toMatchObject({ ok: true });
      expect(session.bridgeCalls).toEqual([
        IPC_CHANNELS.trackedPlansGet,
        IPC_CHANNELS.trackedPlansShare,
      ]);
      expect(newPrincipals()).toEqual([]);
      expect(dispatcherCalls()).toEqual([]);
      expect(hostedWrites()).toEqual([{ method: 'POST', path: '<api>/plans' }]);
      expect(
        new Set(newRequests().map((request) => request.authorization)),
      ).toEqual(new Set([ACCOUNT_AUTHORIZATION]));
    });
    expect(must(await readPlan(plan.id)).share).toMatchObject({
      shareScope: 'team',
      teamId: TEAM_ID,
    });
  });

  it("runs App Advisor's plan.share and plan.unshare with no principal, behind the advisor's core.sharing.write gate", async () => {
    const caller = appAdvisorActionCaller('advisor-chat');
    expect(caller).toMatchObject({
      principalId: 'desktop-app-advisor',
      clientInstanceId: 'app-advisor-chat:advisor-chat',
      interfaceKind: 'mcp',
    });
    for (const type of ['plan.share', 'plan.unshare'] as const) {
      const disposition = APP_ADVISOR_ACTION_DISPOSITIONS[type];
      expect(disposition).toMatchObject({
        kind: 'core',
        access: 'write',
        grants: ['core.sharing.write'],
      });
      if (disposition.kind !== 'core' || disposition.access !== 'write')
        throw new Error(`${type} is not a core write`);
      expect(missingAppAdvisorGrants(caller, disposition.grants)).toEqual([]);
    }
    expect(caller.grants).not.toContain('core.publication.read');
    expect(caller.grants).not.toContain('core.publication.write');

    const plan = await createPlan('# Advisor share\n\nShared by the advisor.');
    const target = { ...scope, planId: plan.id };
    mark();
    const shared = await dispatchAdvisor({
      type: 'plan.share',
      ...target,
      shareScope: 'organization',
      organizationId: ORG_ID,
    });
    await quiet();
    expect(shared).toMatchObject({
      ok: true,
      result: { shareScope: 'organization', syncStatus: 'synced' },
    });
    expect(newPrincipals()).toEqual([]);
    expect(dispatcherCalls()).toEqual([]);
    expect(hostedWrites()).toEqual([{ method: 'POST', path: '<api>/plans' }]);
    expect(
      new Set(newRequests().map((request) => request.authorization)),
    ).toEqual(new Set([ACCOUNT_AUTHORIZATION]));

    mark();
    const unshared = await dispatchAdvisor({ type: 'plan.unshare', ...target });
    await quiet();
    expect(unshared).toEqual({
      ok: true,
      result: { planId: plan.id, unshared: true },
    });
    expect(newPrincipals()).toEqual([]);
    expect(dispatcherCalls()).toEqual([]);
    expect(hostedWrites()).toEqual([
      expect.objectContaining({ method: 'DELETE' }),
    ]);
    expect(
      new Set(newRequests().map((request) => request.authorization)),
    ).toEqual(new Set([ACCOUNT_AUTHORIZATION]));
  });

  it('gives the Portal no command that shares or unshares a plan', () => {
    expect(
      PORTAL_COMMAND_TYPES.filter((type) => type.startsWith('portal.plan.')),
    ).toEqual([
      'portal.plan.list',
      'portal.plan.get',
      'portal.plan.create',
      'portal.plan.update',
      'portal.plan.delete',
      'portal.plan.open',
    ]);
    expect(
      PORTAL_COMMAND_TYPES.filter(
        (type) => /share/i.test(type) && /plan/i.test(type),
      ),
    ).toEqual([]);
  });
});
