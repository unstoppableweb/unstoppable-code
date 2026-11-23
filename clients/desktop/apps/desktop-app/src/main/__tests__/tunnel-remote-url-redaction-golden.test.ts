// CAN-7017: `repo:get-remote-url` answers a paired controller (the remote
// bridge) with the redaction `worker.git.remote.get` applies: a network
// URL without its userinfo, and no URL for a local remote. The trusted local
// window keeps the URL as Git printed it. Real data root, workspace records
// and Git checkouts; only IPC registration is mocked.
//
// CAN-7443: the lifecycle journal's inspect and quarantine answer a remote
// bridge sender with the portable `<data>/…` label, never a host path; the
// local window keeps its local label. Only the bridge lookup is replaced.
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
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
// Sender ids the bridge lookup reports as a paired controller's bridge.
const mockBridgeSenderIds = new Set<number>();
jest.mock('../remote-control/host/bridge-window', () => ({
  ...jest.requireActual<object>('../remote-control/host/bridge-window'),
  resolveRemoteBridgeSender: (sender: { id: number }): string | null =>
    mockBridgeSenderIds.has(sender.id) ? 'device-1' : null,
}));

import { registerRepoHandlers } from '../ipc/repos';
import { registerLifecycleJournalHandlers } from '../ipc/lifecycle-journal';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import {
  deriveDesktopIpcCaller,
  type DesktopIpcCallerOptions,
  type DesktopIpcEvent,
  type DesktopIpcFrame,
  type DesktopIpcSender,
} from '../canopy-runtime/desktop-ipc-caller';

jest.setTimeout(120_000);

const GRANTS: CanopyCallerDescriptor['grants'] = [
  'worker.filesystem.read',
  'core.workspace.read',
  'core.chat.read',
  'core.chat.write',
  'core.worktree.read',
];
// What desktop-ipc-caller.ts derives for a tracked window and for a paired
// controller through the bridge window.
const LOCAL_WINDOW: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: GRANTS,
};
const PAIRED_CONTROLLER: CanopyCallerDescriptor = {
  principalId: 'remote-device:device-1',
  clientInstanceId: 'remote-bridge:7',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: GRANTS,
};

const TOKEN_URL = 'https://x-access-token:secret@example.invalid/org/token.git';
const SCP_URL = 'deploy@example.invalid:org/scp.git';
const PLAIN_URL = 'https://example.invalid/org/plain.git';

let dir: string;
let dataDir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;
let caller: CanopyCallerDescriptor = LOCAL_WINDOW;
// Fixed-caller cases ignore the event; the derivation cases below replace
// this with main's real deriveDesktopIpcCaller.
let resolve: (event: DesktopIpcEvent) => CanopyCallerDescriptor = () => caller;
const repos: Record<string, string> = {};

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

function repoWithOrigin(name: string, origin: string): string {
  const path = join(dir, 'repos', name);
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['remote', 'add', 'origin', origin]);
  return path;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tunnel-remote-url-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;

  const localOrigin = join(dir, 'origins', 'local.git');
  repos.token = repoWithOrigin('token', TOKEN_URL);
  repos.scp = repoWithOrigin('scp', SCP_URL);
  repos.plain = repoWithOrigin('plain', PLAIN_URL);
  repos.localPath = repoWithOrigin('local-path', localOrigin);
  repos.fileUrl = repoWithOrigin('file-url', `file://${localOrigin}`);
  // No workspace records this one: the handler's direct read answers it.
  repos.unrecorded = repoWithOrigin('unrecorded', TOKEN_URL);

  const recorded = ['token', 'scp', 'plain', 'localPath', 'fileUrl'];
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: recorded.map((id, order) => ({
      id,
      name: id,
      type: 'single-repo',
      color: '#38BDF8',
      collapsed: false,
      order,
    })),
  });
  for (const id of recorded)
    writeJson(join(dataDir, 'workspaces', id, 'workspace.json'), {
      version: 1,
      repos: [],
      type: 'single-repo',
      repoPath: repos[id],
    });

  runtime = createDesktopRuntime();
  registerLifecycleJournalHandlers();
  registerRepoHandlers({
    dispatcher: runtime,
    resolveCaller: (event): CanopyCallerDescriptor => resolve(event),
  });
});

afterAll(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

async function remoteUrl(
  as: CanopyCallerDescriptor,
  repoPath: string,
): Promise<unknown> {
  const handler = mockHandlers.get(IPC_CHANNELS.repoGetRemoteUrl);
  if (!handler) throw new Error('repo:get-remote-url was not registered');
  caller = as;
  const event: Partial<IpcMainInvokeEvent> = {};
  return handler(event, { repoPath });
}

describe('repo:get-remote-url through the remote-control bridge (CAN-7017)', () => {
  it('strips the userinfo from a network URL before it reaches a paired controller', async () => {
    expect(await remoteUrl(PAIRED_CONTROLLER, repos.token)).toEqual({
      remoteUrl: 'https://example.invalid/org/token.git',
    });
    expect(await remoteUrl(PAIRED_CONTROLLER, repos.scp)).toEqual({
      remoteUrl: 'example.invalid:org/scp.git',
    });
    expect(await remoteUrl(PAIRED_CONTROLLER, repos.plain)).toEqual({
      remoteUrl: PLAIN_URL,
    });
  });

  it('sends a paired controller no URL for a local remote', async () => {
    expect(await remoteUrl(PAIRED_CONTROLLER, repos.localPath)).toEqual({
      remoteUrl: null,
    });
    expect(await remoteUrl(PAIRED_CONTROLLER, repos.fileUrl)).toEqual({
      remoteUrl: null,
    });
  });

  it('redacts the direct read of a repository no workspace records', async () => {
    expect(await remoteUrl(PAIRED_CONTROLLER, repos.unrecorded)).toEqual({
      remoteUrl: 'https://example.invalid/org/token.git',
    });
  });

  it('keeps the URL as Git printed it for the local window', async () => {
    expect(await remoteUrl(LOCAL_WINDOW, repos.token)).toEqual({
      remoteUrl: TOKEN_URL,
    });
    expect(await remoteUrl(LOCAL_WINDOW, repos.scp)).toEqual({
      remoteUrl: SCP_URL,
    });
    expect(await remoteUrl(LOCAL_WINDOW, repos.localPath)).toEqual({
      remoteUrl: join(dir, 'origins', 'local.git'),
    });
    expect(await remoteUrl(LOCAL_WINDOW, repos.unrecorded)).toEqual({
      remoteUrl: TOKEN_URL,
    });
  });

  it('redacts for any caller that is not the local window', async () => {
    const unknown: CanopyCallerDescriptor = {
      ...LOCAL_WINDOW,
      principalId: 'some-future-interface',
      clientInstanceId: 'future:1',
    };
    expect(await remoteUrl(unknown, repos.token)).toEqual({
      remoteUrl: 'https://example.invalid/org/token.git',
    });
    expect(await remoteUrl(unknown, repos.localPath)).toEqual({
      remoteUrl: null,
    });
  });
});

describe('repo:get-remote-url with the caller main derives (CAN-7017)', () => {
  const RENDERER_URL = 'file:///Applications/Canopy.app/renderer/index.html';
  const bridgeSenderIds = new Set<number>();

  function liveSender(id: number): DesktopIpcSender {
    const mainFrame: DesktopIpcFrame = {
      url: RENDERER_URL,
      detached: false,
      isDestroyed: () => false,
    };
    return {
      id,
      mainFrame,
      getURL: () => RENDERER_URL,
      isDestroyed: () => false,
    };
  }

  // The main window: tracked, on this launch's renderer page.
  const mainWindowSender = liveSender(1);
  // The hidden bridge window a paired session creates: not an app window.
  const bridgeWindowSender = liveSender(7);
  const options: DesktopIpcCallerOptions = {
    getAppWindows: () => [
      { isDestroyed: () => false, webContents: mainWindowSender },
    ],
    packagedRendererUrls: [RENDERER_URL],
    resolveRemoteBridgeSender: (sender) =>
      bridgeSenderIds.has(sender.id) ? 'device-1' : null,
  };

  async function remoteUrlFrom(
    sender: DesktopIpcSender,
    repoPath: string,
  ): Promise<unknown> {
    const handler = mockHandlers.get(IPC_CHANNELS.repoGetRemoteUrl);
    if (!handler) throw new Error('repo:get-remote-url was not registered');
    const event: DesktopIpcEvent = { sender, senderFrame: sender.mainFrame };
    return handler(event, { repoPath });
  }

  beforeEach(() => {
    bridgeSenderIds.clear();
    resolve = (event): CanopyCallerDescriptor =>
      deriveDesktopIpcCaller(event, options);
  });
  afterEach(() => {
    resolve = (): CanopyCallerDescriptor => caller;
  });

  it('keeps the URL for the tracked main window', async () => {
    expect(await remoteUrlFrom(mainWindowSender, repos.token)).toEqual({
      remoteUrl: TOKEN_URL,
    });
  });

  it('redacts a call the bridge window relays for a paired controller', async () => {
    bridgeSenderIds.add(bridgeWindowSender.id);
    expect(await remoteUrlFrom(bridgeWindowSender, repos.token)).toEqual({
      remoteUrl: 'https://example.invalid/org/token.git',
    });
    expect(await remoteUrlFrom(bridgeWindowSender, repos.localPath)).toEqual({
      remoteUrl: null,
    });
  });

  it('redacts a bridge sender even when it is a tracked window on the renderer page', async () => {
    bridgeSenderIds.add(mainWindowSender.id);
    expect(await remoteUrlFrom(mainWindowSender, repos.token)).toEqual({
      remoteUrl: 'https://example.invalid/org/token.git',
    });
  });

  it('refuses an untracked sender that is not a bridge', async () => {
    await expect(
      remoteUrlFrom(bridgeWindowSender, repos.token),
    ).rejects.toThrow();
  });
});

describe('lifecycle journal labels through the remote-control bridge (CAN-7443)', () => {
  const LOCAL_SENDER = { id: 1 };
  const BRIDGE_SENDER = { id: 7 };

  async function invoke(
    channel: string,
    sender: { id: number },
    request?: unknown,
  ): Promise<unknown> {
    const handler = mockHandlers.get(channel);
    if (!handler) throw new Error(`${channel} was not registered`);
    return handler({ sender }, request);
  }

  function unreadableEntry(name: string): void {
    const journal = join(dataDir, 'w5', 'destructive-lifecycles');
    mkdirSync(journal, { recursive: true });
    writeFileSync(join(journal, name), '{ not json');
  }

  function entriesOf(
    inspection: unknown,
  ): { name: string; identity: string }[] {
    if (
      typeof inspection !== 'object' ||
      inspection === null ||
      !('entries' in inspection) ||
      !Array.isArray(inspection.entries)
    )
      throw new Error('no unreadable entries');
    const entries: unknown[] = inspection.entries;
    return entries.flatMap((entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'name' in entry &&
      typeof entry.name === 'string' &&
      'identity' in entry &&
      typeof entry.identity === 'string'
        ? [{ name: entry.name, identity: entry.identity }]
        : [],
    );
  }

  beforeEach(() => {
    mockBridgeSenderIds.clear();
    mockBridgeSenderIds.add(BRIDGE_SENDER.id);
  });
  afterAll(() => {
    mockBridgeSenderIds.clear();
  });

  it('labels inspect and quarantine for a bridge with <data>, and locally with the host location', async () => {
    const journal = join(dataDir, 'w5', 'destructive-lifecycles');
    const quarantine = join(dataDir, 'w5', 'quarantined-lifecycles');
    expect(
      await invoke(IPC_CHANNELS.lifecycleJournalInspect, BRIDGE_SENDER),
    ).toEqual({
      status: 'clear',
      locationLabel: '<data>/w5/destructive-lifecycles',
    });
    // The test data root is outside the home folder, so the local label is
    // the location as is.
    expect(
      await invoke(IPC_CHANNELS.lifecycleJournalInspect, LOCAL_SENDER),
    ).toEqual({ status: 'clear', locationLabel: journal });

    unreadableEntry(`${'a'.repeat(64)}.json`);
    unreadableEntry(`${'b'.repeat(64)}.json`);
    const remote = await invoke(
      IPC_CHANNELS.lifecycleJournalInspect,
      BRIDGE_SENDER,
    );
    expect(remote).toMatchObject({
      status: 'unreadable-entries',
      locationLabel: '<data>/w5/destructive-lifecycles',
      quarantineLocationLabel: '<data>/w5/quarantined-lifecycles',
    });
    expect(JSON.stringify(remote)).not.toContain(dir);
    const local = await invoke(
      IPC_CHANNELS.lifecycleJournalInspect,
      LOCAL_SENDER,
    );
    expect(local).toMatchObject({
      locationLabel: journal,
      quarantineLocationLabel: quarantine,
    });

    const [first, second] = entriesOf(remote);
    if (!first || !second) throw new Error('expected two unreadable entries');
    const moved = await invoke(
      IPC_CHANNELS.lifecycleJournalQuarantine,
      BRIDGE_SENDER,
      { name: first.name, identity: first.identity },
    );
    expect(moved).toMatchObject({
      status: 'quarantined',
      name: first.name,
      quarantineLocationLabel: '<data>/w5/quarantined-lifecycles',
    });
    expect(JSON.stringify(moved)).not.toContain(dir);
    expect(
      await invoke(IPC_CHANNELS.lifecycleJournalQuarantine, LOCAL_SENDER, {
        name: second.name,
        identity: second.identity,
      }),
    ).toMatchObject({
      status: 'quarantined',
      quarantineLocationLabel: quarantine,
    });

    // A refusal carries no location either.
    const refusal = invoke(
      IPC_CHANNELS.lifecycleJournalQuarantine,
      BRIDGE_SENDER,
      { name: first.name, identity: first.identity },
    );
    await expect(refusal).rejects.toThrow('This record is no longer there');
    await refusal.catch((error: unknown) => {
      expect(String(error)).not.toContain(dir);
    });
  });
});
