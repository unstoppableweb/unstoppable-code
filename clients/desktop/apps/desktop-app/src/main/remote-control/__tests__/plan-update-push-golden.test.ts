/**
 * CAN-7295: a plan the plan-mode agent or a pipeline writes reaches every
 * paired controller window entitled to tracked-plan pushes exactly once, as
 * any other binding's write does, and no other client. Drives the real
 * writers on a real desktop dispatcher and temporary data root, the real
 * window sends and main-window mirror, and real host sessions over an
 * encrypted session pair. Only Electron's window list and the bridge
 * windows behind each session are fakes.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type TrackedPlanData,
  type TrackedPlansUpdatedEvent,
} from '@canopy/desktop-shared/types';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import type { WorkerPipelineHostRequest } from '@canopy/protocol/canopy-core';
import type { ExecutionPlanPersistenceHooks } from '@canopy/execution-engine/node/pipelines/executor/types';
// The proposal-mode writer reads its chat through chat state; one plan-mode
// tab stands in for it.
const mockProposalTabs: Record<string, unknown>[] = [];
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    getState: (): Promise<unknown> =>
      Promise.resolve({ tabsFile: { tabs: mockProposalTabs } }),
    getCompatibilityTabs: (): Promise<unknown> =>
      Promise.resolve({ tabs: mockProposalTabs }),
    retirePlanReview: (): Promise<boolean> => Promise.resolve(true),
    commitPlanExit: (): Promise<boolean> => Promise.resolve(true),
  }),
}));
import type { HostBridge } from '../host/bridge-window';
import { RemoteHostSession } from '../host/host-session';
import {
  createMainWindowPushSource,
  type MainWindowPushSource,
} from '../host/main-window-pushes';
import { RemoteUploadStore } from '../host/uploads';
import {
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
} from '../remote-protocol';
import { RpcPeer } from '../transport/rpc-peer';
import { interceptWebContentsSends } from '../../lib/web-contents-send';
import type { DesktopCanopyDispatcher } from '../../canopy-runtime/desktop-runtime';
import type * as OwnerRequests from '../../pipelines/pipeline-owner-requests';
import type * as ExecutionRuntime from '../../pipelines/execution-runtime';
import type * as PlanMode from '../../agents/plan-mode-tracked-plan';
import type * as PlanExit from '../../services/chat-state-plan-exit';
import type * as InterfacePort from '../../agents/agent-interface-port';
import type * as HostWriters from '../../canopy-runtime/plan-host-writers';
import { flushRelay, InMemoryRelayHub } from './in-memory-relay';
import {
  createTestDevice,
  openControlSession,
  type TestDevice,
} from './session-pair';

jest.setTimeout(60_000);

const VERSION = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  appVersion: '1.4.0',
};
const WORKSPACE_ID = 'push-plans';
const WORKTREE_ID = 'push-wt';
const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };

interface FakeWebContents {
  id: number;
  sent: Array<{ channel: string; args: unknown[] }>;
  send(channel: string, ...args: unknown[]): void;
  getURL(): string;
  isDestroyed(): boolean;
  isCrashed(): boolean;
  mainFrame: { detached: boolean; isDestroyed(): boolean };
}

interface FakeWindow {
  isDestroyed(): boolean;
  webContents: FakeWebContents;
}

let nextWebContentsId = 1;
function fakeWindow(): FakeWindow {
  const webContents: FakeWebContents = {
    id: nextWebContentsId++,
    sent: [],
    send(channel, ...args) {
      this.sent.push({ channel, args });
    },
    getURL: () => 'file:///app/index.html',
    isDestroyed: () => false,
    isCrashed: () => false,
    mainFrame: { detached: false, isDestroyed: () => false },
  };
  return { isDestroyed: () => false, webContents };
}

/** Every window main can reach: this computer's app window, then bridges. */
const appWindow = fakeWindow();
let appWindowOpen = true;
const bridgeWindows: FakeWindow[] = [];
function liveWindows(): FakeWindow[] {
  return appWindowOpen ? [appWindow, ...bridgeWindows] : [...bridgeWindows];
}

/** A hidden bridge window, intercepting main's sends to it as the real one does. */
function fakeBridge(): HostBridge {
  const window = fakeWindow();
  bridgeWindows.push(window);
  const listeners = new Set<
    (channel: string, args: ReadonlyArray<unknown>) => void
  >();
  const stop = interceptWebContentsSends(
    window.webContents,
    (channel, args) => {
      for (const listener of Array.from(listeners)) listener(channel, args);
      return true;
    },
  );
  return {
    getChatInterest: (): undefined => undefined,
    window: null,
    invoke: (): Promise<unknown> => Promise.resolve(null),
    post: (): void => undefined,
    onPush: (listener) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    onClosed: (): (() => void) => (): void => undefined,
    destroy: (): void => {
      stop();
      const index = bridgeWindows.indexOf(window);
      if (index >= 0) bridgeWindows.splice(index, 1);
    },
  };
}

interface Controller {
  device: TestDevice;
  session: RemoteHostSession;
  surfaces: RemoteSurface[];
  pushes: Array<{ args: unknown[]; surface?: RemoteSurface }>;
  close(): void;
}

let root: string;
let dataDir: string;
let dispatcher: DesktopCanopyDispatcher;
let mainWindowPushes: MainWindowPushSource;
let hub: InMemoryRelayHub;
let host: TestDevice;
let owner: typeof OwnerRequests;
let planMode: typeof PlanMode;
let planExit: typeof PlanExit;
let interfaces: typeof InterfacePort;
let executionRuntime: typeof ExecutionRuntime;
let hostWriters: typeof HostWriters;
const originalDataDir = process.env.CANOPY_DATA_DIR;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isPlansUpdatedEvent(
  value: unknown,
): value is TrackedPlansUpdatedEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'change' in value &&
    'projectId' in value &&
    'worktreeId' in value
  );
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-update-push-')));
  dataDir = join(root, 'data');
  process.env.CANOPY_DATA_DIR = dataDir;
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Plans',
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
    repoPath: repo,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', WORKSPACE_ID, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: 'push',
        createdAt: '2026-11-19T00:00:00.000Z',
      },
    ],
  });
  mkdirSync(
    join(dataDir, 'workspaces', WORKSPACE_ID, 'worktrees', WORKTREE_ID),
    { recursive: true },
  );
  const registry = await import('../../lib/workspace-registry');
  registry.registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
  const { createDesktopRuntime } =
    await import('../../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  const access = await import('../../canopy-runtime/desktop-runtime-access');
  access.setDesktopCanopyRuntime(dispatcher);
  owner = await import('../../pipelines/pipeline-owner-requests');
  planMode = await import('../../agents/plan-mode-tracked-plan');
  planExit = await import('../../services/chat-state-plan-exit');
  interfaces = await import('../../agents/agent-interface-port');
  executionRuntime = await import('../../pipelines/execution-runtime');
  hostWriters = await import('../../canopy-runtime/plan-host-writers');
  jest
    .spyOn(BrowserWindow, 'getAllWindows')
    .mockImplementation((): never[] => liveWindows() as never[]);
  mainWindowPushes = createMainWindowPushSource(() =>
    appWindowOpen ? appWindow.webContents : null,
  );
});

afterAll(async () => {
  const access = await import('../../canopy-runtime/desktop-runtime-access');
  access.setDesktopCanopyRuntime(null);
  await dispatcher.shutdown();
  // A plan usage event brought up the observability service: flush it into
  // this file's data root before the env is restored (CAN-7485).
  await (await import('../../observability'))
    .peekObservabilityService()
    ?.dispose();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(root, { recursive: true, force: true });
});

let controllers: Controller[] = [];

beforeEach(async () => {
  appWindowOpen = true;
  appWindow.webContents.sent.length = 0;
  mockProposalTabs.length = 0;
  mockProposalTabs.push({
    id: 'push-proposal-chat',
    planMode: true,
    title: 'Proposal',
  });
  hub = new InMemoryRelayHub();
  host = createTestDevice(hub, 'Studio');
  await flushRelay();
});

afterEach(() => {
  for (const controller of controllers) controller.close();
  controllers = [];
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await flushRelay();
}

async function connect(
  name: string,
  kind: DeviceKind,
  surfaces: RemoteSurface[] = ['main'],
  createBridge: () => Promise<HostBridge> = (): Promise<HostBridge> =>
    Promise.resolve(fakeBridge()),
): Promise<Controller> {
  const device = createTestDevice(hub, name);
  await flushRelay();
  const { initiator, responder } = await openControlSession(device, host);
  const session = new RemoteHostSession({
    session: responder,
    kind,
    attributedDeviceId: responder.peerDeviceId,
    createBridge,
    mainWindowPushes,
    uploads: new RemoteUploadStore(join(root, `uploads-${name}`)),
    readFile: (): Promise<never> =>
      Promise.reject(new Error('no reads in this test')),
    disposition: getRemoteChannelDisposition,
    isAuthorized: (): boolean => true,
    version: VERSION,
    hello: (): { name: string; platform: 'darwin' } => ({
      name: 'Studio',
      platform: 'darwin',
    }),
    onClose: (): void => undefined,
  });
  const pushes: Controller['pushes'] = [];
  const rpc = new RpcPeer(initiator, {
    onRequest: (): Promise<never> =>
      Promise.reject(new Error('unexpected request')),
    onEvent: (event, payload): void => {
      if (
        event === REMOTE_EVENTS.push &&
        typeof payload === 'object' &&
        payload !== null &&
        'channel' in payload &&
        payload.channel === IPC_CHANNELS.trackedPlansUpdated &&
        'args' in payload &&
        Array.isArray(payload.args)
      )
        pushes.push({
          args: payload.args,
          ...('surface' in payload &&
          (payload.surface === 'main' || payload.surface === 'app-advisor')
            ? { surface: payload.surface }
            : {}),
        });
    },
  });
  await rpc.request(REMOTE_METHODS.hello, { version: VERSION });
  for (const surface of surfaces) await session.bridgeFor(surface);
  const controller: Controller = {
    device,
    session,
    surfaces,
    pushes,
    close: (): void => {
      rpc.close('closed');
      session.rpc.close('closed');
    },
  };
  controllers.push(controller);
  return controller;
}

/** What each of the controller's windows received, by surface. */
function perWindow(controller: Controller): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const push of controller.pushes)
    for (const surface of push.surface ? [push.surface] : controller.surfaces)
      counts[surface] = (counts[surface] ?? 0) + 1;
  return counts;
}

function ownerRequest(
  executionId: string,
  request: WorkerPipelineHostRequest['request'],
): WorkerPipelineHostRequest {
  return {
    requestId: `owner-${executionId}-${Math.random()}`,
    executionId,
    jobId: 'job',
    stepId: 'step',
    childExecutionId: null,
    attempt: 0,
    iteration: 0,
    owner: null,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    request,
  };
}

function ownerPlanId(settlement: { result: unknown }): string {
  const { result } = settlement;
  if (
    typeof result === 'object' &&
    result !== null &&
    'value' in result &&
    typeof result.value === 'object' &&
    result.value !== null &&
    'planId' in result.value &&
    typeof result.value.planId === 'string'
  )
    return result.value.planId;
  throw new Error(`no plan id in ${JSON.stringify(result)}`);
}

function inProcessHooks(): ExecutionPlanPersistenceHooks {
  const hooks =
    executionRuntime.createElectronExecutionRuntime().planPersistence;
  if (!hooks) throw new Error('no plan hooks');
  return hooks;
}

/** Each writer in turn, by name, each writing one plan change. */
function writers(): Array<[string, () => Promise<string>]> {
  const sessions: PlanMode.PlanModeSessionPlans = new Map();
  const upsert = (plan: string): Promise<TrackedPlanData> =>
    planMode.upsertPlanModeTrackedPlan(
      sessions,
      'push-session',
      WORKSPACE_ID,
      WORKTREE_ID,
      'push-plan-mode-chat',
      'claude',
      { plan },
    );
  const hooks = inProcessHooks();
  const executionId = `execution-${Math.random().toString(36).slice(2)}`;
  const context = new owner.PipelineOwnerRunContext({
    executionId,
    scope: (): OwnerRequests.PipelineOwnerRunScope => ({
      ...scope,
      folder: root,
    }),
    secretValues: [],
  });
  let inProcess = '';
  let daemon = '';
  let proposalId = '';
  return [
    ['plan-mode create', async () => (await upsert('# Plan mode')).id],
    ['plan-mode revise', async () => (await upsert('# Plan mode, again')).id],
    [
      'proposal-mode create',
      async () => {
        await planExit.publishOpenCodePlanProposal({
          ...scope,
          chatId: 'push-proposal-chat',
          plan: '# Proposal',
          isCurrent: () => true,
          presentPlanExit: (event): void =>
            interfaces
              .windowAgentInterfacePort(() => null)
              .presentPlanExit(event),
        });
        const listed = await dispatcher.query(
          'core.plan.list',
          { scope },
          {
            caller: {
              principalId: 'local-desktop-user',
              clientInstanceId: 'push-golden',
              authorityId: 'local-desktop',
              interfaceKind: 'desktop',
              grants: ['core.plan.read'],
            },
          },
        );
        const proposal = listed.plans.find(
          (plan) => plan.source === 'opencode',
        );
        if (!proposal) throw new Error('no proposal plan');
        proposalId = proposal.id;
        return proposal.id;
      },
    ],
    [
      'in-process create',
      async () => {
        inProcess = (
          await hooks.createTrackedPlan({
            ...scope,
            source: 'pipeline',
            content: '# In process',
            reviewStatus: 'approved',
            linkedExecutionId: executionId,
          })
        ).id;
        return inProcess;
      },
    ],
    [
      'in-process link',
      async () => {
        await hooks.updateTrackedPlan({
          ...scope,
          planId: inProcess,
          linkedExecutionId: `${executionId}-2`,
        });
        return inProcess;
      },
    ],
    [
      'in-process approval',
      async () => {
        await hooks.updateTrackedPlan({
          ...scope,
          planId: inProcess,
          source: 'pipeline',
          reviewStatus: 'approved',
          approvedAt: new Date().toISOString(),
          dismissedAt: null,
          linkedExecutionId: `${executionId}-2`,
        });
        return inProcess;
      },
    ],
    [
      'owner create',
      async () => {
        daemon = ownerPlanId(
          await context.apply(
            ownerRequest(executionId, {
              action: 'owner.plan.create',
              content: '# Daemon',
            }),
            new AbortController().signal,
          ),
        );
        return daemon;
      },
    ],
    [
      'owner update',
      async () => {
        await context.apply(
          ownerRequest(executionId, {
            action: 'owner.plan.update',
            planId: daemon,
            approve: true,
          }),
          new AbortController().signal,
        );
        await context.close(null);
        return daemon;
      },
    ],
    [
      'proposal approval',
      async () => {
        const { plan } = await dispatcher.query(
          'core.plan.get',
          { scope, planId: proposalId },
          {
            caller: {
              principalId: 'local-desktop-user',
              clientInstanceId: 'push-golden',
              authorityId: 'local-desktop',
              interfaceKind: 'desktop',
              grants: ['core.plan.read'],
            },
          },
        );
        if (!plan) throw new Error('no proposal plan');
        const approved = await hostWriters.approveProposalPlanReview({
          ...scope,
          chatId: 'push-proposal-chat',
          planId: proposalId,
          revisionNumber: plan.latestRevisionNumber,
          approvedAt: new Date().toISOString(),
        });
        if (!approved) throw new Error('the proposal was not approved');
        return proposalId;
      },
    ],
    [
      'implicit approval',
      async () => {
        await hostWriters.approvePlanForPipelineRun({
          ...scope,
          planId: inProcess,
          executionId: `${executionId}-3`,
          approvedAt: new Date().toISOString(),
          initiationSource: 'user',
        });
        return inProcess;
      },
    ],
    [
      'relay update',
      async () => {
        await dispatcher.instruction(
          'core.plan.update',
          { scope, planId: inProcess, content: '# From the relay' },
          {
            caller: {
              principalId: 'local-desktop-renderer:main',
              clientInstanceId: 'renderer-relay:push',
              authorityId: 'local-desktop',
              interfaceKind: 'desktop',
              grants: ['core.plan.write'],
            },
            metadata: { idempotencyKey: `push-relay-${Math.random()}` },
          },
        );
        return inProcess;
      },
    ],
  ];
}

describe('agent and pipeline plans reach Remote Control (CAN-7295)', () => {
  it("every writer's plan reaches each entitled controller window exactly once", async () => {
    const desktop = await connect('Laptop', 'desktop', ['main', 'app-advisor']);
    const browser = await connect('Browser', 'browser');
    const mobile = await connect('Phone', 'mobile');
    const received: Record<string, unknown> = {};
    for (const [name, write] of writers()) {
      for (const controller of [desktop, browser, mobile])
        controller.pushes.length = 0;
      appWindow.webContents.sent.length = 0;
      await write();
      await settle();
      received[name] = {
        desktop: perWindow(desktop),
        browser: perWindow(browser),
        mobile: perWindow(mobile),
      };
      // Each controller receives the event the app window got, unchanged.
      const [sent] = appWindow.webContents.sent.filter(
        ({ channel }) => channel === IPC_CHANNELS.trackedPlansUpdated,
      );
      for (const controller of [desktop, browser, mobile])
        for (const push of controller.pushes)
          expect(push.args).toEqual(sent?.args);
    }
    const once = {
      desktop: { main: 1, 'app-advisor': 1 },
      browser: { main: 1 },
      mobile: { main: 1 },
    };
    expect(received).toEqual({
      'plan-mode create': once,
      'plan-mode revise': once,
      'proposal-mode create': once,
      'in-process create': once,
      'in-process link': once,
      'in-process approval': once,
      'owner create': once,
      'owner update': once,
      'proposal approval': once,
      'implicit approval': once,
      'relay update': once,
    });
  });

  it('a paired client the push is not for gets nothing', async () => {
    const browser = await connect('Browser', 'browser');
    const hosted = await connect('Hosted', 'hosted');
    const revoked = await connect('Revoked', 'browser');
    const unconnected = createTestDevice(hub, 'Tablet');
    await flushRelay();
    revoked.session.end('revoked');
    await settle();
    revoked.pushes.length = 0;
    const toUnconnected = (): number =>
      hub.delivered.filter(({ to }) => to === unconnected.identity.deviceId)
        .length;
    const before = toUnconnected();
    const names: string[] = [];
    for (const [name, write] of writers()) {
      await write();
      names.push(name);
    }
    await settle();
    expect({
      hosted: hosted.pushes.length,
      revoked: revoked.pushes.length,
      unconnected: toUnconnected() - before,
      unconnectedSessions: unconnected.incoming.length,
    }).toEqual({
      hosted: 0,
      revoked: 0,
      unconnected: 0,
      unconnectedSessions: 0,
    });
    // The entitled browser beside them hears every write.
    expect(browser.pushes).toHaveLength(names.length);
  });

  it('reaches each controller window once while the app window is closed', async () => {
    const desktop = await connect('Laptop', 'desktop', ['main', 'app-advisor']);
    const mobile = await connect('Phone', 'mobile');
    appWindowOpen = false;
    const received: Record<string, unknown> = {};
    for (const [name, write] of writers()) {
      desktop.pushes.length = 0;
      mobile.pushes.length = 0;
      await write();
      await settle();
      received[name] = {
        desktop: perWindow(desktop),
        mobile: perWindow(mobile),
      };
    }
    for (const counts of Object.values(received))
      expect(counts).toEqual({
        desktop: { main: 1, 'app-advisor': 1 },
        mobile: { main: 1 },
      });
    expect(appWindow.webContents.sent).toEqual([]);
  });

  // CAN-4165 PR 4b-1: implicit approval used to reach a closed app window's
  // controllers through the main-window mirror; its broadcast now reaches
  // sessions through their bridge windows. A session whose main bridge has
  // not started misses the push, and reads the approved plan once it has.
  it('a session whose bridge is still starting reads the current plan once it starts', async () => {
    let startBridge = (): void => undefined;
    const mobile = await connect(
      'Phone',
      'mobile',
      [],
      () =>
        new Promise<HostBridge>((resolve) => {
          startBridge = (): void => resolve(fakeBridge());
        }),
    );
    appWindowOpen = false;
    const created = await inProcessHooks().createTrackedPlan({
      ...scope,
      source: 'pipeline',
      content: '# Before the bridge',
    });
    await settle();
    mobile.pushes.length = 0;
    await hostWriters.approvePlanForPipelineRun({
      ...scope,
      planId: created.id,
      executionId: 'execution-bridge-starting',
      approvedAt: new Date().toISOString(),
    });
    await settle();
    expect(mobile.pushes).toEqual([]);
    startBridge();
    await mobile.session.bridgeFor('main');
    const { plan } = await dispatcher.query(
      'core.plan.get',
      { scope, planId: created.id },
      {
        caller: {
          principalId: `remote-device:${mobile.device.identity.deviceId}`,
          clientInstanceId: 'remote-bridge:push',
          authorityId: 'local-desktop',
          interfaceKind: 'desktop',
          grants: ['core.plan.read'],
        },
      },
    );
    expect(plan).toMatchObject({
      id: created.id,
      reviewStatus: 'approved',
      linkedExecutionIds: ['execution-bridge-starting'],
    });
  });

  it('names only the worktree written, as every tracked-plan push does', async () => {
    const browser = await connect('Browser', 'browser');
    const written: string[] = [];
    for (const [, write] of writers()) written.push(await write());
    await settle();
    const events = browser.pushes.flatMap(({ args }) =>
      args.filter(isPlansUpdatedEvent),
    );
    expect(events).toHaveLength(written.length);
    events.forEach((event, index) => {
      expect(event).toMatchObject({ ...scope, change: 'upsert' });
      expect(event.change === 'upsert' ? event.plan.id : null).toBe(
        written[index],
      );
    });
  });
});
