/**
 * CAN-7030: Git remote URLs leaving this computer for a remote-control
 * controller. Drives the real host session over an encrypted session pair:
 * tunnelled invoke results and pushes from the main window reach the
 * controller with userinfo stripped and local remotes withheld, and a clone
 * job's source as an empty URL. The values the main window holds are never
 * changed. Only the bridge window is a fake that answers each channel.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatSessionCloudExportListResponse,
  ChatSessionImportInspectResponse,
  CloneJobSnapshot,
  GetRemoteUrlResponse,
  WorkspaceReferenceRepoStatus,
  WorkspaceReferenceRepoStatusEvent,
} from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
jest.mock('../../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: () => void } => ({
    recordAppDiagnostic: (): void => undefined,
  }),
}));
import type { HostBridge } from '../host/bridge-window';
import { CONTROLLER_REMOTE_URL_PROJECTIONS } from '../host/controller-remote-urls';
import { RemoteHostSession } from '../host/host-session';
import { RemoteUploadStore } from '../host/uploads';
import {
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
} from '../remote-protocol';
import { RpcPeer } from '../transport/rpc-peer';
import { createWorkspace } from '../../lib/workspace-creation';
import { flushRelay, InMemoryRelayHub } from './in-memory-relay';
import { createTestDevice, openControlSession } from './session-pair';

const VERSION = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  appVersion: '1.4.0',
};

const TOKEN_URL = 'https://x-access-token:secret@example.invalid/org/repo.git';
const STRIPPED_URL = 'https://example.invalid/org/repo.git';
const SCP_URL = 'deploy@example.invalid:org/scp.git';
const SCP_STRIPPED = 'example.invalid:org/scp.git';
const PLAIN_URL = 'https://example.invalid/org/plain.git';
const LOCAL_PATH = '/Users/someone/origins/private.git';
const FILE_URL = 'file:///Users/someone/origins/private.git';

function referenceStatus(remoteUrl: string): WorkspaceReferenceRepoStatus {
  return {
    referenceRepoPath: '/data/reference',
    healthy: true,
    warnings: [],
    lastCheckedAt: '2026-11-17T00:00:00.000Z',
    remoteUrl,
  };
}

function cloneJob(id: string, remoteUrl: string): CloneJobSnapshot {
  return {
    id,
    repoName: 'repo',
    remoteUrl,
    destinationPath: '/Users/someone/code/repo',
    status: 'running',
    phase: 'counting',
    phasePercent: 40,
    percent: 40,
    processedCount: null,
    totalCount: null,
    received: null,
    throughput: null,
    startedAt: 1_700_000_000_000,
    background: false,
    cancellable: true,
    workspaceId: null,
    workspaceName: null,
    error: null,
  };
}

const exportList: ChatSessionCloudExportListResponse = {
  data: [
    {
      id: 'export-1',
      title: 'Session',
      workspaceName: 'Workspace',
      workspaceType: 'multi-repo',
      repos: [
        { name: 'token', branchName: 'main', remoteUrl: TOKEN_URL },
        { name: 'local', branchName: 'main', remoteUrl: FILE_URL },
        { name: 'none', branchName: 'main' },
      ],
      sizeBytes: 10,
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    },
  ],
  nextCursor: null,
};

const inspection: ChatSessionImportInspectResponse = {
  exportId: 'export-1',
  manifestSummary: {
    title: 'Session',
    exportedAt: '2026-11-17T00:00:00.000Z',
    workspaceType: 'multi-repo',
    repoCount: 2,
    repos: [
      { name: 'token', remoteUrl: TOKEN_URL },
      { name: 'scp', remoteUrl: SCP_URL },
    ],
  },
  workspaceSummary: {
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    workspaceType: 'multi-repo',
    repoCount: 1,
    repos: [{ name: 'local', remoteUrl: LOCAL_PATH }],
  },
  match: 'superset',
  workspaceTypeCompatible: true,
  missingRepos: [{ name: 'token', remoteUrl: TOKEN_URL }],
  warnings: [],
};

/** What the main window's handlers answer, exactly as main holds them. */
const RESULTS: Readonly<Record<string, unknown>> = {
  [IPC_CHANNELS.repoGetRemoteUrl]: { remoteUrl: TOKEN_URL },
  [IPC_CHANNELS.workspaceReadSettingsData]: {
    referenceRepoStatus: referenceStatus(SCP_URL),
  },
  [IPC_CHANNELS.cloneJobsList]: [
    cloneJob('token', TOKEN_URL),
    cloneJob('local', LOCAL_PATH),
  ],
  [IPC_CHANNELS.chatSessionCloudExportList]: exportList,
  [IPC_CHANNELS.chatSessionImportInspect]: inspection,
};

interface Harness {
  controller: RpcPeer;
  pushes: Array<{ channel: string; args: unknown[] }>;
  mainPush: (channel: string, args: unknown[]) => void;
  close: () => void;
}

async function harness(): Promise<Harness> {
  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, 'Laptop');
  const studio = createTestDevice(hub, 'Studio');
  await flushRelay();
  const { initiator, responder } = await openControlSession(laptop, studio);
  const mainListeners = new Set<(channel: string, args: unknown[]) => void>();
  const bridge: HostBridge = {
    getChatInterest: (): undefined => undefined,
    window: null,
    invoke: (channel: string): Promise<unknown> =>
      Promise.resolve(RESULTS[channel] ?? null),
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
    mainWindowPushes: {
      subscribe: (listener): (() => void) => {
        mainListeners.add(listener);
        return (): void => {
          mainListeners.delete(listener);
        };
      },
    },
    uploads: new RemoteUploadStore(join(tmpdir(), 'controller-urls-uploads')),
    readFile: (): Promise<never> =>
      Promise.reject(new Error('no reads in this test')),
    disposition: (): 'tunnel' => 'tunnel',
    isAuthorized: (): boolean => true,
    version: VERSION,
    hello: (): { name: string; platform: 'darwin' } => ({
      name: 'Studio',
      platform: 'darwin',
    }),
    onClose: (): void => undefined,
  });
  const pushes: Array<{ channel: string; args: unknown[] }> = [];
  const controller = new RpcPeer(initiator, {
    onRequest: (): Promise<never> =>
      Promise.reject(new Error('unexpected request')),
    onEvent: (name, payload): void => {
      if (
        name === REMOTE_EVENTS.push &&
        typeof payload === 'object' &&
        payload !== null &&
        'channel' in payload &&
        typeof payload.channel === 'string' &&
        'args' in payload &&
        Array.isArray(payload.args)
      )
        pushes.push({ channel: payload.channel, args: payload.args });
    },
  });
  await controller.request(REMOTE_METHODS.hello, { version: VERSION });
  await session.start();
  return {
    controller,
    pushes,
    mainPush: (channel, args): void => {
      for (const listener of Array.from(mainListeners)) listener(channel, args);
    },
    close: (): void => {
      controller.close('closed');
      session.rpc.close('closed');
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await flushRelay();
}

describe('remote URLs a paired controller receives (CAN-7030)', () => {
  let current: Harness | null = null;
  afterEach(() => {
    current?.close();
    current = null;
  });

  const invoke = (channel: string): Promise<unknown> => {
    if (!current) throw new Error('no harness');
    return current.controller.request(REMOTE_METHODS.invoke, {
      channel,
      args: [],
    });
  };

  it('strips userinfo from repo:get-remote-url, and withholds a local remote', async () => {
    current = await harness();
    const expected: GetRemoteUrlResponse = { remoteUrl: STRIPPED_URL };
    expect(await invoke(IPC_CHANNELS.repoGetRemoteUrl)).toEqual(expected);
  });

  it("redacts the reference repository's origin in the settings data", async () => {
    current = await harness();
    expect(await invoke(IPC_CHANNELS.workspaceReadSettingsData)).toEqual({
      referenceRepoStatus: referenceStatus(SCP_STRIPPED),
    });
  });

  it('sends a clone job its source as an empty URL', async () => {
    current = await harness();
    expect(await invoke(IPC_CHANNELS.cloneJobsList)).toEqual([
      cloneJob('token', ''),
      cloneJob('local', ''),
    ]);
  });

  it('redacts every repo URL in the session export and import channels', async () => {
    current = await harness();
    expect(await invoke(IPC_CHANNELS.chatSessionCloudExportList)).toEqual({
      ...exportList,
      data: [
        {
          ...exportList.data[0],
          repos: [
            { name: 'token', branchName: 'main', remoteUrl: STRIPPED_URL },
            { name: 'local', branchName: 'main' },
            { name: 'none', branchName: 'main' },
          ],
        },
      ],
    });
    expect(await invoke(IPC_CHANNELS.chatSessionImportInspect)).toEqual({
      ...inspection,
      manifestSummary: {
        ...inspection.manifestSummary,
        repos: [
          { name: 'token', remoteUrl: STRIPPED_URL },
          { name: 'scp', remoteUrl: SCP_STRIPPED },
        ],
      },
      workspaceSummary: {
        ...inspection.workspaceSummary,
        repos: [{ name: 'local' }],
      },
      missingRepos: [{ name: 'token', remoteUrl: STRIPPED_URL }],
    });
  });

  it('redacts pushes and leaves the values the main window holds unchanged', async () => {
    current = await harness();
    const statusEvent: WorkspaceReferenceRepoStatusEvent = {
      workspaceId: 'workspace-1',
      status: referenceStatus(TOKEN_URL),
    };
    const localStatusEvent: WorkspaceReferenceRepoStatusEvent = {
      workspaceId: 'workspace-2',
      status: referenceStatus(LOCAL_PATH),
    };
    const jobs = [cloneJob('plain', PLAIN_URL)];
    current.mainPush(IPC_CHANNELS.workspaceReferenceRepoStatusEvent, [
      statusEvent,
    ]);
    current.mainPush(IPC_CHANNELS.workspaceReferenceRepoStatusEvent, [
      localStatusEvent,
    ]);
    current.mainPush(IPC_CHANNELS.cloneJobsChanged, [jobs]);
    await settle();

    const localWithout = Object.fromEntries(
      Object.entries(referenceStatus(LOCAL_PATH)).filter(
        ([key]) => key !== 'remoteUrl',
      ),
    );
    expect(current.pushes).toEqual([
      {
        channel: IPC_CHANNELS.workspaceReferenceRepoStatusEvent,
        args: [{ ...statusEvent, status: referenceStatus(STRIPPED_URL) }],
      },
      {
        channel: IPC_CHANNELS.workspaceReferenceRepoStatusEvent,
        args: [{ ...localStatusEvent, status: localWithout }],
      },
      {
        channel: IPC_CHANNELS.cloneJobsChanged,
        args: [[cloneJob('plain', '')]],
      },
    ]);
    // The main window's own copies are untouched.
    expect(statusEvent.status?.remoteUrl).toBe(TOKEN_URL);
    expect(jobs[0]?.remoteUrl).toBe(PLAIN_URL);
  });

  it("refuses a controller's retry with the empty source before any effect", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'controller-urls-')));
    const destinationDir = join(dir, 'code');
    mkdirSync(destinationDir);
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = join(dir, 'data');
    const cwdBefore = readdirSync(process.cwd()).sort();
    try {
      // Retry reopens Add project with the job's source, so the controller
      // submits the empty URL it was sent.
      await expect(
        createWorkspace({
          source: 'remote',
          variant: { kind: 'remote-clone', remoteUrl: '', destinationDir },
        }),
      ).rejects.toMatchObject({
        name: 'WorkspaceCreationRefusedError',
        reason: 'invalid-remote',
      });
      // The empty URL is never resolved as a relative path: nothing was
      // cloned into the destination or the working directory, and no
      // workspace was recorded.
      expect(readdirSync(destinationDir)).toEqual([]);
      expect(readdirSync(process.cwd()).sort()).toEqual(cwdBefore);
      expect(existsSync(join(dir, 'data'))).toBe(false);
    } finally {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers every channel this test drives and nothing else', () => {
    expect(Object.keys(CONTROLLER_REMOTE_URL_PROJECTIONS).sort()).toEqual(
      [
        ...Object.keys(RESULTS),
        IPC_CHANNELS.workspaceReferenceRepoStatusEvent,
        IPC_CHANNELS.cloneJobsChanged,
      ].sort(),
    );
  });

  it('records exactly the projected fields in remote-url-fields.json', () => {
    const recorded: unknown = JSON.parse(
      readFileSync(join(__dirname, '..', 'remote-url-fields.json'), 'utf8'),
    );
    const projected =
      typeof recorded === 'object' &&
      recorded !== null &&
      'projected' in recorded
        ? recorded.projected
        : undefined;
    expect(projected).toEqual(
      Object.fromEntries(
        Object.entries(CONTROLLER_REMOTE_URL_PROJECTIONS)
          .map(([channel, { fields }]): [string, string[]] => [
            channel,
            [...fields].sort(),
          ])
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  });
});
