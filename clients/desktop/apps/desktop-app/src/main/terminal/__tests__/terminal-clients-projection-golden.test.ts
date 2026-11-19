import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  type TerminalAttachResponse,
  type TerminalSession,
  type TerminalOutputEvent,
} from '@canopy/desktop-shared/types';
import {
  RemoteTerminals,
  type RemoteTerminalFrame,
  type RemoteTerminalTransport,
  type ResolvedTerminalShell,
  type TerminalAttachment,
  type TerminalCreateRequest,
  type WorkerTerminalEventListener,
  type WorkerTerminalPort,
} from '@canopy/core-runtime/node/terminal';
import type {
  WorkerTerminalCreateParams,
  WorkerTerminalCreateResult,
} from '@canopy/protocol/canopy-core';
import type { WindowAccessors } from '../../ipc';
import type { RoutedWorkerTerminal as RoutedWorkerTerminalClass } from '../routed-worker-terminal';
import { registerTerminalHandlers } from '../../ipc/terminal';
import { terminalPersistenceStore } from '../persistence';
import { createMainWindowPushSource } from '../../remote-control/host/main-window-pushes';

type Channels = typeof IPC_CHANNELS;
interface ScriptedEngine extends WorkerTerminalPort {
  write: jest.Mock<void, [string, string]>;
  createCount: number;
  emitOutput(id: string, bytes: string, seq: number): void;
  emitExit(id: string): void;
  reset(): void;
}
const mockState: {
  root: string;
  bridge: BrowserWindow | undefined;
  daemonHealthy: boolean;
} = {
  root: '',
  bridge: undefined,
  daemonHealthy: false,
};

jest.mock('@canopy/core-platform', () => ({
  ...jest.requireActual<object>('@canopy/core-platform'),
  hostPlatformOperatingSystem: (): 'darwin' => 'darwin',
}));
jest.mock('@canopy/core-runtime/node', () => ({
  ...jest.requireActual<object>('@canopy/core-runtime/node'),
  createFilesystemScopeResolver: jest.fn(() =>
    jest.fn(() => Promise.resolve({})),
  ),
  readFilesystemScope: jest.fn(() =>
    Promise.resolve({
      roots: [
        { id: 'project', kind: 'repository', absolutePath: mockState.root },
      ],
    }),
  ),
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeTargetIds: (): { projectId: string; worktreeId: string } => ({
    projectId: 'project',
    worktreeId: 'task',
  }),
  resolveWorktreeCwd: (): string => mockState.root,
}));
jest.mock('../../lib/workspace-target-exclusion', () => ({
  withWorkspaceTargetRuntimeStartReservation: (
    _project: string,
    _worktree: string,
    start: () => Promise<unknown>,
  ): Promise<unknown> => start(),
}));
jest.mock('../../services/split-lock-service', () => ({
  assertNotSplitLocked: (): void => undefined,
}));
jest.mock('../../canopy-runtime/electron-daemon-health', () => ({
  getElectronDaemonHealth: jest.fn(() => ({
    isLatched: (): boolean => !mockState.daemonHealthy,
    noteFallback: (): void => undefined,
    setConsumerEnabled: (): void => undefined,
  })),
}));
jest.mock('../../canopy-runtime/electron-daemon-access', () => ({
  getElectronDaemonFilesContext: jest.fn(() =>
    Promise.resolve({ canonicalDataRoot: '/unused', authorityId: 'local' }),
  ),
  getElectronDaemonConnections: jest.fn(() => {
    throw new Error('Unexpected daemon connection');
  }),
}));
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (sender: object): string | null =>
    sender === mockState.bridge?.webContents ? 'controller-1' : null,
}));
jest.mock('../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: jest.fn(() => ({
    setEventSender: (): void => undefined,
    setChatSummaryScheduler: (): void => undefined,
    authorizeAgentInputTerminalWrite: (): undefined => undefined,
    recordPlanImplementationWriteFailure: (): undefined => undefined,
  })),
}));
jest.mock('../../lib/slow-action-tracker', () => ({
  trackSlowAction: (result: unknown): unknown => result,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (): void => undefined,
}));
jest.mock('../persistence', () => ({
  terminalPersistenceStore: {
    getPersistedTerminalEntry: (): null => null,
    registerLiveSession: (): void => undefined,
    appendTerminalOutput: (): void => undefined,
    markTerminalExited: (): void => undefined,
    saveWorktreeState: (): void => undefined,
  },
}));
jest.mock('../worker-terminal', () => {
  const { RoutedWorkerTerminal } = jest.requireActual<{
    RoutedWorkerTerminal: typeof RoutedWorkerTerminalClass;
  }>('../routed-worker-terminal');
  const { IPC_CHANNELS } = jest.requireActual<{ IPC_CHANNELS: Channels }>(
    '@canopy/desktop-shared/types',
  );
  class Engine implements ScriptedEngine {
    createCount = 0;
    private sessions = new Map<string, TerminalSession>();
    private replays = new Map<string, TerminalAttachResponse>();
    private sink: WorkerTerminalEventListener = (): void => undefined;
    reset(): void {
      this.sessions.clear();
      this.replays.clear();
      this.createCount = 0;
      this.write.mockClear();
    }
    create(request: TerminalCreateRequest): TerminalSession {
      this.createCount += 1;
      const session: TerminalSession = {
        id: `engine-${this.createCount}`,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        shell: '/bin/sh',
        shellBasename: 'sh',
        cwd: mockState.root,
        createdAt: 1,
      };
      this.sessions.set(session.id, session);
      this.replays.set(session.id, {
        session,
        replay: new Uint8Array(),
        seq: 0,
      });
      this.sink({ type: 'spawned', payload: session });
      return session;
    }
    restore(request: { terminalId: string }): TerminalSession {
      const session = this.get(request.terminalId);
      if (!session) throw new Error('Missing scripted terminal');
      return session;
    }
    list(): TerminalSession[] {
      return [...this.sessions.values()];
    }
    get(id: string): TerminalSession | null {
      return this.sessions.get(id) ?? null;
    }
    replay(id: string): TerminalAttachResponse {
      const replay = this.replays.get(id);
      if (!replay) throw new Error('Missing scripted replay');
      return replay;
    }
    replayText(id: string): string | null {
      return this.replays.has(id)
        ? Buffer.from(this.replay(id).replay).toString()
        : null;
    }
    emitOutput(id: string, bytes: string, seq: number): void {
      const current = this.replay(id);
      const data = Buffer.from(bytes);
      this.replays.set(id, {
        ...current,
        replay: Buffer.concat([current.replay, data]),
        seq,
      });
      this.sink({
        type: 'output',
        payload: {
          projectId: current.session.projectId,
          worktreeId: current.session.worktreeId,
          terminalId: id,
          data,
          seq,
        },
      });
    }
    emitExit(id: string): void {
      const session = this.get(id);
      if (!session) throw new Error('Missing scripted terminal');
      this.sink({
        type: 'exit',
        payload: {
          projectId: session.projectId,
          worktreeId: session.worktreeId,
          terminalId: id,
          exitCode: 0,
          signal: null,
        },
      });
      this.sessions.delete(id);
    }
    write = jest.fn<void, [string, string]>((): void => undefined);
    resize(): void {}
    kill(id: string): void {
      this.emitExit(id);
    }
    killWorktree(): void {}
    killAll(): void {}
    release(): Promise<void> {
      return Promise.resolve();
    }
    releaseWorktree(): Promise<void> {
      return Promise.resolve();
    }
    hasLiveTerminals(): boolean {
      return this.sessions.size > 0;
    }
    runningWorktrees(): [] {
      return [];
    }
    lowerPriority(): void {}
    profiles(): [] {
      return [];
    }
    defaultShellBasename(): string {
      return 'sh';
    }
    prewarmShell(): Promise<void> {
      return Promise.resolve();
    }
    attach(): TerminalAttachment {
      throw new Error('Windows must use replay');
    }
    acknowledgeAttachment(): void {}
    releaseAttachment(): void {}
    setEventSink(sink: WorkerTerminalEventListener): void {
      this.sink = sink;
    }
    addEventListener(): () => void {
      return (): void => undefined;
    }
  }
  const engine = new Engine();
  return {
    workerTerminal: new RoutedWorkerTerminal(engine),
    testEngine: engine,
    TERMINAL_EVENT_CHANNELS: {
      spawned: IPC_CHANNELS.terminalSpawned,
      output: IPC_CHANNELS.terminalOutput,
      exit: IPC_CHANNELS.terminalExit,
      runningChanged: IPC_CHANNELS.terminalRunningChanged,
    },
    desktopTerminalShells: {
      profile: (): ResolvedTerminalShell => ({
        shell: '/bin/sh',
        args: [],
        shellBasename: 'sh',
      }),
      persisted: (): ResolvedTerminalShell => ({
        shell: '/bin/sh',
        args: [],
        shellBasename: 'sh',
      }),
    },
    desktopTerminalEnvironmentFor: (): Record<string, string> => ({
      PATH: '/usr/bin:/bin',
    }),
    createDesktopTerminalHost: jest.fn(() => ({
      resources: {
        register: jest.fn(() => ({ unregister: (): void => undefined })),
      },
    })),
  };
});

const { workerTerminal: routed, testEngine: engine } = jest.requireMock<{
  workerTerminal: RoutedWorkerTerminalClass;
  testEngine: ScriptedEngine;
}>('../worker-terminal');
const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
let main: BrowserWindow;
let advisor: BrowserWindow;
let bridge: BrowserWindow;
let unsubscribe: () => void;
let remotePushes: { channel: string; args: readonly unknown[] }[];
let daemonCreates: WorkerTerminalCreateParams[];
/** The last attachment the daemon mirror opened, to deliver its frames. */
let daemonFrames: ((frame: RemoteTerminalFrame) => void) | undefined;

const unexpectedDaemonCall = (): Promise<never> =>
  Promise.reject(new Error('Unexpected daemon terminal call'));
const daemonTransport: RemoteTerminalTransport = {
  create: (params) => {
    daemonCreates.push(params);
    const created: WorkerTerminalCreateResult = {
      terminalId: `daemon-${daemonCreates.length}`,
      scope: params.scope,
      state: 'running',
      cwdRootId: params.cwdRootId,
      cwdRelativePath: params.cwdRelativePath,
      cols: params.cols,
      rows: params.rows,
      exitCode: null,
      signal: null,
      outputOffset: 0,
      profileId: null,
      initialCommand: null,
    };
    return Promise.resolve(created);
  },
  restore: unexpectedDaemonCall,
  write: unexpectedDaemonCall,
  resize: unexpectedDaemonCall,
  kill: unexpectedDaemonCall,
  release: unexpectedDaemonCall,
  attach: (_params, onFrame) => {
    daemonFrames = onFrame;
    return Promise.resolve({ close: (): void => undefined });
  },
};

function invoke(
  channel: string,
  request?: unknown,
  window = main,
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler ${channel}`);
  const event: IpcMainInvokeEvent = {
    sender: window.webContents,
    senderFrame: null,
    frameId: 1,
    processId: 1,
    type: 'frame',
    preventDefault: () => undefined,
    defaultPrevented: false,
  };
  return Promise.resolve().then((): unknown => handler(event, request));
}
function outputs(window: BrowserWindow): unknown[] {
  const calls: readonly unknown[][] = jest.spyOn(window.webContents, 'send')
    .mock.calls;
  return calls
    .filter(([channel]) => channel === IPC_CHANNELS.terminalOutput)
    .map((call) => call[1]);
}
function mirroredOutput(): unknown[] {
  return remotePushes
    .filter(({ channel }) => channel === IPC_CHANNELS.terminalOutput)
    .map(({ args }) => args[0]);
}
function engineId(): string {
  const id = engine.list()[0]?.id;
  if (!id) throw new Error('Scripted engine did not create a terminal');
  return id;
}
const REQUEST = {
  projectId: 'project',
  worktreeId: 'task',
  cols: 80,
  rows: 24,
};

beforeAll(() => {
  mockState.root = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'terminal-clients-golden-')),
  );
  jest.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => {
    handlers.set(channel, handler);
  });
});
afterAll(() => {
  jest.restoreAllMocks();
  rmSync(mockState.root, { recursive: true, force: true });
});
beforeEach(() => {
  jest.useFakeTimers();
  engine.reset();
  mockState.daemonHealthy = false;
  daemonCreates = [];
  daemonFrames = undefined;
  routed.useDaemonTerminals(
    new RemoteTerminals({
      transport: daemonTransport,
      persistence: {
        getPersistedTerminalEntry: (): null => null,
        registerLiveSession: (): void => undefined,
        appendTerminalOutput: (): void => undefined,
        markTerminalExited: (): void => undefined,
      },
      resources: {
        register: (): { unregister: () => void } => ({
          unregister: (): void => undefined,
        }),
      },
      emit: (event): void => routed.emit(event),
      log: (): void => undefined,
      createIdempotencyKey: (): string => `key-${daemonCreates.length}`,
    }),
  );
  main = new BrowserWindow();
  advisor = new BrowserWindow();
  bridge = new BrowserWindow();
  mockState.bridge = bridge;
  for (const window of [main, advisor, bridge]) {
    Object.assign(window.webContents, {
      isCrashed: (): boolean => false,
      mainFrame: { detached: false, isDestroyed: (): boolean => false },
    });
  }
  jest.spyOn(main.webContents, 'send');
  jest.spyOn(advisor.webContents, 'send');
  jest.spyOn(bridge.webContents, 'send');
  remotePushes = [];
  unsubscribe = createMainWindowPushSource(() => main.webContents).subscribe(
    (channel, args) => {
      remotePushes.push({ channel, args });
    },
  );
  registerTerminalHandlers({
    getMainWindow: () => main,
    getAppAdvisorWindow: () => advisor,
  } as unknown as WindowAccessors);
});
afterEach(() => {
  unsubscribe();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('terminal clients project one worker terminal (CAN-4148)', () => {
  it('every window attaches to the same in-process terminal and sees the same output', async () => {
    await invoke(IPC_CHANNELS.terminalSpawn, REQUEST);
    const id = engineId();
    engine.emitOutput(id, 'hello', 5);
    jest.advanceTimersByTime(20);
    const payload: TerminalOutputEvent = {
      projectId: 'project',
      worktreeId: 'task',
      terminalId: id,
      data: Buffer.from('hello'),
      seq: 5,
    };
    expect(outputs(main)).toEqual([payload]);
    expect(mirroredOutput()).toEqual([payload]);
    expect(outputs(advisor)).toEqual([]);
    const attachments = await Promise.all(
      [main, advisor, bridge].map((window) =>
        invoke(IPC_CHANNELS.terminalAttach, { terminalId: id }, window),
      ),
    );
    expect(attachments).toEqual([
      engine.replay(id),
      engine.replay(id),
      engine.replay(id),
    ]);
    expect(attachments[0]).toMatchObject({
      session: { id },
      replay: Buffer.from('hello'),
      seq: 5,
    });
    expect(routed.list()).toEqual([engine.get(id)]);
    expect(engine.createCount).toBe(1);
  });
  it("the Orchestrator window and Remote Control see an App Advisor terminal's output once each", async () => {
    await invoke(
      IPC_CHANNELS.terminalSpawn,
      { ...REQUEST, projectId: APP_ADVISOR_PROJECT_ID },
      advisor,
    );
    const id = engineId();
    engine.emitOutput(id, 'hello', 5);
    jest.advanceTimersByTime(20);
    const payload: TerminalOutputEvent = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'task',
      terminalId: id,
      data: Buffer.from('hello'),
      seq: 5,
    };
    expect(outputs(main)).toEqual([payload]);
    expect(outputs(advisor)).toEqual([payload]);
    expect(mirroredOutput()).toEqual([payload]);
  });
  it('with a healthy daemon, a local window spawn is daemon-hosted while a Remote Control spawn stays in process', async () => {
    mockState.daemonHealthy = true;
    const local = await invoke(IPC_CHANNELS.terminalSpawn, REQUEST, main);
    expect(local).toMatchObject({ id: 'daemon-1', cwd: mockState.root });
    expect(routed.daemonTerminals?.has('daemon-1')).toBe(true);
    expect(daemonCreates).toEqual([
      expect.objectContaining({ cwdRootId: 'project', cwdRelativePath: '' }),
    ]);
    expect(engine.createCount).toBe(0);

    await invoke(IPC_CHANNELS.terminalSpawn, REQUEST, bridge);
    const id = engineId();
    expect(engine.createCount).toBe(1);
    expect(daemonCreates).toHaveLength(1);
    expect(routed.daemonTerminals?.has(id)).toBe(false);
    for (const window of [main, advisor])
      await expect(
        invoke(IPC_CHANNELS.terminalList, undefined, window),
      ).resolves.toEqual([
        engine.get(id),
        expect.objectContaining({ id: 'daemon-1' }),
      ]);
  });
  it('a daemon terminal projects through the same port for every window', async () => {
    const session: TerminalSession = {
      id: 'daemon-1',
      projectId: 'project',
      worktreeId: 'task',
      shell: '/bin/sh',
      shellBasename: 'sh',
      cwd: mockState.root,
      createdAt: 1,
    };
    const replay: TerminalAttachResponse = {
      session,
      replay: Buffer.from('daemon output'),
      seq: 13,
    };
    const remote = {
      has: (id: string): boolean => id === session.id,
      get: (): TerminalSession => session,
      list: (): TerminalSession[] => [session],
      replay: (): TerminalAttachResponse => replay,
      write: jest.fn(),
    };
    routed.useDaemonTerminals(remote as unknown as RemoteTerminals);
    const payload: TerminalOutputEvent = {
      projectId: 'project',
      worktreeId: 'task',
      terminalId: session.id,
      data: Buffer.from('daemon output'),
      seq: 13,
    };
    routed.emit({ type: 'output', payload });
    jest.advanceTimersByTime(20);
    expect(outputs(main)).toEqual([payload]);
    expect(mirroredOutput()).toEqual([payload]);
    for (const window of [main, advisor, bridge])
      await expect(
        invoke(IPC_CHANNELS.terminalAttach, { terminalId: session.id }, window),
      ).resolves.toEqual(replay);
    await invoke(
      IPC_CHANNELS.terminalWrite,
      { terminalId: session.id, data: 'ls\n' },
      bridge,
    );
    expect(remote.write).toHaveBeenCalledWith(session.id, 'ls\n');
    expect(engine.write).not.toHaveBeenCalled();
  });
  it("two windows see a daemon Claude terminal's output once each and replay does not consume it", async () => {
    const daemon = routed.daemonTerminals;
    if (!daemon) throw new Error('No daemon terminals');
    const session = await daemon.create({
      projectId: 'project',
      worktreeId: 'task',
      scope: { workspaceId: 'project', worktreeId: 'task' },
      cwdRootId: 'project',
      cwdRelativePath: '',
      cwd: mockState.root,
      shell: { shell: '/opt/claude', args: [], shellBasename: 'claude' },
      environment: {},
      cols: 80,
      rows: 24,
      managed: { kind: 'claude-code', title: 'Claude Code', chatId: 'chat-1' },
    });
    expect(daemonCreates).toEqual([
      expect.objectContaining({ kind: 'managed' }),
    ]);
    expect(session).toMatchObject({ kind: 'claude-code', chatId: 'chat-1' });
    daemonFrames?.({
      kind: 'item',
      item: {
        terminalId: session.id,
        fromOffset: 0,
        toOffset: 13,
        data: 'claude output',
        encoding: 'utf8',
        truncatedBefore: false,
        exit: null,
      },
    });
    jest.advanceTimersByTime(20);
    const payload: unknown = expect.objectContaining({
      projectId: 'project',
      worktreeId: 'task',
      terminalId: session.id,
      data: Buffer.from('claude output'),
    });
    expect(outputs(main)).toEqual([payload]);
    expect(mirroredOutput()).toEqual([payload]);
    const replays = [];
    for (const window of [main, bridge])
      replays.push(
        await invoke(
          IPC_CHANNELS.terminalAttach,
          { terminalId: session.id },
          window,
        ),
      );
    expect(replays[0]).toMatchObject({
      session: { id: session.id, kind: 'claude-code' },
      replay: Buffer.from('claude output'),
    });
    expect(replays[1]).toEqual(replays[0]);
  });

  it('terminal:save-worktree-state rejects malformed forgetTerminalIds before saving (CAN-6616)', async () => {
    const save = jest.spyOn(terminalPersistenceStore, 'saveWorktreeState');
    const layout = {
      projectId: 'project',
      worktreeId: 'task',
      drawerCollapsed: false,
      groups: [],
      activeGroupId: null,
      groupOrdinals: {},
      nextGroupOrdinal: 1,
      terminalCustomNames: {},
      groupCustomNames: {},
    };
    for (const forgetTerminalIds of ['term-1', [''], ['../term-1'], [1], null])
      await expect(
        invoke(IPC_CHANNELS.terminalSaveWorktreeState, {
          ...layout,
          forgetTerminalIds,
        }),
      ).rejects.toThrow('Invalid forgetTerminalIds');
    expect(save).not.toHaveBeenCalled();
    await invoke(IPC_CHANNELS.terminalSaveWorktreeState, layout);
    await invoke(IPC_CHANNELS.terminalSaveWorktreeState, {
      ...layout,
      forgetTerminalIds: ['term-1'],
    });
    expect(save).toHaveBeenCalledTimes(2);
  });
});
