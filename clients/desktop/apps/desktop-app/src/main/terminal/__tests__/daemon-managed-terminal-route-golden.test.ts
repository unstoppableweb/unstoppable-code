/**
 * CAN-5097 migration golden: Claude Code terminal-mode and worker terminals
 * on the daemon terminal route, over the real terminal service, daemon route,
 * routed worker.terminal port and in-process engine, with a node-pty double,
 * a recording persistence port and a fake daemon client. Placed terminals are created
 * (worker.terminal.create), written to (worker.terminal.write) and killed
 * (worker.terminal.kill) in the daemon; orphans are found with
 * worker.terminal.list. This is the placement every `claude-terminal:launch`
 * request and Claude worker run takes through spawnPlacedManagedTerminal.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  type ManagedTerminalCommand,
  type TerminalSession,
} from '@canopy/desktop-shared/types';
import { DESKTOP_INTEGRATION_TOKEN_ENV_VAR } from '@canopy/desktop-shared/lib/desktop-integration-transport';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import {
  WorkerTerminalCreateParamsSchema,
  WorkerTerminalKillParamsSchema,
  WorkerTerminalWriteParamsSchema,
  type WorkerTerminal,
  type WorkerTerminalAttachItem,
  type WorkerTerminalCreateParams,
  type WorkerTerminalCreateResult,
} from '@canopy/protocol/canopy-core';
import type {
  TerminalEnvironment,
  TerminalPty,
  TerminalPtySpawnOptions,
  WorkerTerminalEvent,
} from '@canopy/core-runtime/node/terminal';
import type * as ConfigPathsModule from '@canopy/execution-engine/pipelines/config-paths';
import type * as PathsModule from '../../lib/paths';
import { markUnreachable } from '../../canopy-runtime/electron-daemon-connection';
import { TerminalRecordAdmissionDeferred } from '../record-admission';
import { terminalPersistenceStore } from '../persistence';

let mockRecordCapability = false;

type Frame = { kind: 'item'; item: WorkerTerminalAttachItem };

interface RouteState {
  root: string;
  stateDir: string;
  platform: 'darwin' | 'linux' | 'win32' | 'freebsd';
  latched: boolean;
  failure: Error | undefined;
  listFailure: Error | undefined;
  listed: WorkerTerminal[];
  calls: string[];
  creates: WorkerTerminalCreateParams[];
  writes: unknown[];
  kills: unknown[];
  sinks: Map<string, (frame: Frame) => void>;
  /** Every attachment opened in the file, so teardown can end each terminal. */
  allSinks: Map<string, (frame: Frame) => void>;
  spawned: Array<{ file: string; env: TerminalEnvironment }>;
  /** Sessions handed to the persistence port. */
  registered: TerminalSession[];
  enhancedEnv: Record<string, string | undefined>;
}
const mockState: RouteState = {
  root: '',
  stateDir: '',
  platform: 'darwin',
  latched: false,
  failure: undefined,
  listFailure: undefined,
  listed: [],
  calls: [],
  creates: [],
  writes: [],
  kills: [],
  sinks: new Map(),
  allSinks: new Map(),
  spawned: [],
  registered: [],
  enhancedEnv: {},
};
const mockWarn = jest.fn<void, unknown[]>();
/** Every warning this file's placements logged, for the token check. */
const mockAllWarnings: unknown[][] = [];

function mockPty(file: string, options: TerminalPtySpawnOptions): TerminalPty {
  mockState.spawned.push({ file, env: options.env });
  const exits = new Set<(event: { exitCode: number }) => void>();
  return {
    // Not a real pid: the engine signals only positive pids before pty.kill().
    pid: 0,
    process: 'claude',
    onData: () => ({ dispose: (): void => undefined }),
    onExit: (listener) => {
      exits.add(listener);
      return { dispose: (): boolean => exits.delete(listener) };
    },
    write: (): void => undefined,
    resize: (): void => undefined,
    kill: (): void => {
      for (const exit of exits) exit({ exitCode: 0 });
    },
  };
}

// The in-process engine's foreground-process probes would start real `ps` runs.
jest.mock('node:child_process', () => ({
  ...jest.requireActual<object>('node:child_process'),
  execFile: (...args: unknown[]): void => {
    const done = args.at(-1);
    if (typeof done === 'function')
      Reflect.apply(done, undefined, [new Error('no probes in this golden')]);
  },
}));
jest.mock('node-pty', () => ({
  spawn: (
    file: string,
    _args: string[],
    options: TerminalPtySpawnOptions,
  ): TerminalPty => mockPty(file, options),
}));
jest.mock('@canopy/core-platform', () => ({
  hostPlatformOperatingSystem: (): string => mockState.platform,
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
jest.mock('@canopy/execution-engine/pipelines/config-paths', () => ({
  ...jest.requireActual<typeof ConfigPathsModule>(
    '@canopy/execution-engine/pipelines/config-paths',
  ),
  getBundledClaudeBinaryPath: (): string => '/opt/claude',
  getEnhancedEnv: (): Record<string, string | undefined> => ({
    ...mockState.enhancedEnv,
  }),
}));
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../../lib/paths'),
  getWorktreeTerminalStateFilePath: (
    projectId: string,
    worktreeId: string,
  ): string => `${mockState.stateDir}/${projectId}-${worktreeId}.json`,
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeTargetIds: (
    projectId: string,
    worktreeId: string,
  ): { projectId: string; worktreeId: string } | null =>
    projectId === 'project' ? { projectId, worktreeId } : null,
  resolveWorktreeCwd: (): string => mockState.root,
}));
jest.mock('../../lib/workspace-target-exclusion', () => ({
  assertWorkspaceTargetRuntimeStartAllowed: (): void => undefined,
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
    isLatched: (): boolean => mockState.latched,
    noteFallback: (): void => undefined,
    setConsumerEnabled: (): void => undefined,
  })),
}));
jest.mock('../persistence', () => ({
  terminalPersistenceStore: {
    recordClientFor: (): null => null,
    getPersistedTerminalEntry: (): null => null,
    registerLiveSession: (session: TerminalSession): void => {
      mockState.registered.push(session);
    },
    appendTerminalOutput: (): void => undefined,
    markTerminalExited: (): void => undefined,
  },
}));
jest.mock('../../resource-monitor', () => ({
  getResourceMonitorService: (): object => ({
    registerProcess: (): object => ({ unregister: (): void => undefined }),
  }),
}));
jest.mock('../../execution-accounting', () => ({
  getExecutionAccounting: (): object => ({
    track: (): object => ({ release: (): void => undefined }),
  }),
  withExecutionLease: (
    _lease: unknown,
    handle: { unregister(): void },
  ): { unregister(): void } => handle,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (...args: unknown[]): void => {
    mockAllWarnings.push(args);
    mockWarn(...args);
  },
}));
jest.mock('../../canopy-runtime/electron-daemon-access', () => ({
  getElectronDaemonFilesContext: jest.fn(() =>
    Promise.resolve({ canonicalDataRoot: '/unused', authorityId: 'local' }),
  ),
  getElectronDaemonConnections: jest.fn(() => ({
    get: jest.fn(() =>
      Promise.resolve().then(() => {
        if (mockState.failure && !('payload' in mockState.failure))
          throw mockState.failure;
        return {
          client: {
            manifest: {
              has: (): boolean => mockRecordCapability,
              schemaRevisions: new Map([['worker.terminal.create', 2]]),
            },
            signal: new AbortController().signal,
            query: (operation: string): Promise<unknown> =>
              Promise.resolve().then(() => {
                mockState.calls.push(operation);
                if (mockState.listFailure) throw mockState.listFailure;
                return {
                  items: mockState.listed,
                  nextCursor: null,
                  revision: 1,
                };
              }),
            instruction: (operation: string, raw: unknown): Promise<unknown> =>
              Promise.resolve().then(() => {
                mockState.calls.push(operation);
                if (mockState.failure) throw mockState.failure;
                if (operation === 'worker.terminal.create') {
                  const p = WorkerTerminalCreateParamsSchema.parse(raw);
                  mockState.creates.push(p);
                  const terminal: WorkerTerminalCreateResult = {
                    terminalId: `daemon-${mockState.creates.length}`,
                    scope: p.scope,
                    state: 'running',
                    cwdRootId: p.cwdRootId,
                    cwdRelativePath: p.cwdRelativePath,
                    cols: p.cols,
                    rows: p.rows,
                    exitCode: null,
                    signal: null,
                    outputOffset: 0,
                    profileId: null,
                    initialCommand: null,
                  };
                  return terminal;
                }
                if (operation === 'worker.terminal.write') {
                  mockState.writes.push(
                    WorkerTerminalWriteParamsSchema.parse(raw),
                  );
                  return {};
                }
                if (operation === 'worker.terminal.kill') {
                  mockState.kills.push(
                    WorkerTerminalKillParamsSchema.parse(raw),
                  );
                  return {};
                }
                throw new Error(`Unexpected operation: ${operation}`);
              }),
            openStream: jest.fn(
              (_operation: string, params: { terminalId: string }) =>
                Promise.resolve({
                  onFrame: (sink: (frame: Frame) => void): (() => void) => {
                    mockState.sinks.set(params.terminalId, sink);
                    mockState.allSinks.set(params.terminalId, sink);
                    return (): void => undefined;
                  },
                  close: (): void => undefined,
                }),
            ),
          },
        };
      }),
    ),
  })),
}));

import {
  createDesktopTerminalEngine,
  workerTerminal,
} from '../worker-terminal';
import type * as PersistenceModule from '../persistence';
import {
  getDaemonTerminals,
  resetDaemonManagedTerminalSweepForTests,
} from '../daemon-terminal-route';
import { spawnPlacedManagedTerminal } from '../../services/terminal-service';

const CLAUDE: ManagedTerminalCommand = {
  executable: '/opt/claude',
  args: ['--resume', 'sdk-1', '--strict-mcp-config'],
  env: {
    [DESKTOP_INTEGRATION_TOKEN_ENV_VAR]: 'tok-secret',
    [brandEnvName('DESKTOP_INTEGRATION_SESSION_KEY')]: 'key-1',
  },
  pathPrepend: ['/opt/canopy/bin'],
  title: 'Claude Code',
  kind: 'claude-code',
  chatId: 'chat-1',
  sessionKey: 'key-1',
};

function request(
  overrides: Partial<{
    projectId: string;
    worktreeId: string;
    cwd: string;
    cols: number;
    rows: number;
    managedCommand: ManagedTerminalCommand;
  }> = {},
): Parameters<typeof spawnPlacedManagedTerminal>[0] {
  return {
    projectId: 'project',
    worktreeId: 'task',
    cwd: mockState.root,
    cols: 80,
    rows: 24,
    managedCommand: CLAUDE,
    ...overrides,
  };
}

function listed(terminalId: string, kind: string): WorkerTerminal {
  return {
    terminalId,
    scope: { workspaceId: 'project', worktreeId: 'task' },
    state: 'running',
    cwdRootId: 'project',
    cwdRelativePath: '',
    cols: 80,
    rows: 24,
    exitCode: null,
    signal: null,
    outputOffset: 0,
    kind,
  };
}

function exitItem(terminalId: string): Frame {
  return {
    kind: 'item',
    item: {
      terminalId,
      fromOffset: 0,
      toOffset: 0,
      data: '',
      encoding: 'utf8',
      truncatedBefore: false,
      exit: { code: null, signal: 'SIGKILL' },
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

const events: WorkerTerminalEvent[] = [];
workerTerminal.addEventListener((event) => events.push(event));

beforeAll(() => {
  mockState.root = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'managed-route-golden-')),
  );
  mockState.stateDir = join(mockState.root, '.state');
});
afterAll(async () => {
  // pid 0: the engine never signals a process, it only ends the double.
  workerTerminal.killAll();
  for (const [terminalId, sink] of mockState.allSinks)
    sink(exitItem(terminalId));
  // Exits are announced on a timer after their item; let them land first.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await flush();
  rmSync(mockState.root, { recursive: true, force: true });
});
beforeEach(() => {
  mockRecordCapability = false;
  resetDaemonManagedTerminalSweepForTests();
  mockState.platform = 'darwin';
  mockState.latched = false;
  mockState.failure = undefined;
  mockState.listFailure = undefined;
  mockState.listed = [];
  mockState.calls = [];
  mockState.creates = [];
  mockState.writes = [];
  mockState.kills = [];
  mockState.sinks.clear();
  mockState.spawned = [];
  mockState.registered = [];
  mockState.enhancedEnv = { PATH: '/usr/bin:/bin' };
  events.length = 0;
  mockWarn.mockClear();
});

describe('Claude terminals on the daemon terminal route (CAN-5097)', () => {
  it('R3 deferred custody opens a managed shell in process before daemon dispatch', async () => {
    mockRecordCapability = true;
    const admission = jest
      .spyOn(terminalPersistenceStore, 'recordClientFor')
      .mockImplementation(() => {
        throw new TerminalRecordAdmissionDeferred();
      });
    try {
      await expect(
        spawnPlacedManagedTerminal(request()),
      ).resolves.toMatchObject({ kind: 'claude-code' });
      expect(admission).toHaveBeenCalledTimes(1);
      expect(mockState.creates).toEqual([]);
      expect(mockState.spawned).toHaveLength(1);
      expect(mockState.latched).toBe(false);
    } finally {
      admission.mockRestore();
    }
  });
  it('an eligible terminal-mode launch runs in the daemon terminal host', async () => {
    const session = await spawnPlacedManagedTerminal(request());

    expect(mockState.creates).toHaveLength(1);
    const created = mockState.creates[0];
    expect(created).toMatchObject({
      kind: 'managed',
      shell: '/opt/claude',
      args: CLAUDE.args,
      cwdRootId: 'project',
      cwdRelativePath: '',
    });
    expect(created).not.toHaveProperty('profileId');
    expect(created).not.toHaveProperty('initialCommand');
    expect(session).toMatchObject({
      kind: 'claude-code',
      title: 'Claude Code',
      chatId: 'chat-1',
      sessionKey: 'key-1',
    });
    expect(workerTerminal.get(session.id)).toEqual(session);
    expect(mockState.spawned).toEqual([]);
    // Main's real persistence store keeps the drawer's terminals only.
    const { TerminalPersistenceStore } =
      jest.requireActual<typeof PersistenceModule>('../persistence');
    const store = new TerminalPersistenceStore();
    for (const registered of mockState.registered)
      store.registerLiveSession(registered);
    expect(mockState.registered).toContainEqual(session);
    expect(store.getPersistedTerminalEntry(session.id)).toBe(null);
  });

  it('a worker session in a worktree runs in the daemon terminal host', async () => {
    const session = await spawnPlacedManagedTerminal(
      request({
        cols: 120,
        rows: 36,
        managedCommand: { ...CLAUDE, kind: 'claude-worker', title: 'Helper' },
      }),
    );

    expect(mockState.creates).toEqual([
      expect.objectContaining({ kind: 'managed', cols: 120, rows: 36 }),
    ]);
    expect(session).toMatchObject({ kind: 'claude-worker', title: 'Helper' });
    expect(mockState.spawned).toEqual([]);
  });

  it('App Advisor, sentinel-id and out-of-root Claude terminals stay in process', async () => {
    await spawnPlacedManagedTerminal(
      request({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
      }),
    );
    await spawnPlacedManagedTerminal(
      request({ projectId: 'workers', worktreeId: 'workers' }),
    );
    await spawnPlacedManagedTerminal(
      request({ cwd: join(mockState.root, '.state') }),
    );

    expect(mockState.creates).toEqual([]);
    expect(mockState.spawned.map(({ file }) => file)).toEqual([
      '/opt/claude',
      '/opt/claude',
      '/opt/claude',
    ]);
  });

  it('a Remote Control launch, an unsupported host, a latched daemon and a full host stay in process', async () => {
    await spawnPlacedManagedTerminal(request(), { fromRemoteBridge: true });
    mockState.platform = 'freebsd';
    await spawnPlacedManagedTerminal(request());
    mockState.platform = 'darwin';
    mockState.latched = true;
    await spawnPlacedManagedTerminal(request());
    mockState.latched = false;
    const count = jest.spyOn(getDaemonTerminals(), 'count').mockReturnValue(48);
    try {
      await spawnPlacedManagedTerminal(request());
    } finally {
      count.mockRestore();
    }

    expect(mockState.creates).toEqual([]);
    expect(mockState.spawned).toHaveLength(4);
  });

  it('the daemon terminal gets the same environment the in-process engine would build', async () => {
    const savedLifecycleScript = process.env.npm_lifecycle_script;
    mockState.enhancedEnv.ELECTRON_RUN_AS_NODE = '1';
    mockState.enhancedEnv.NODE_OPTIONS = '--x';
    mockState.enhancedEnv.Node_Options = '--require inherited';
    mockState.enhancedEnv.LD_PRELOAD = '/inherited';
    mockState.enhancedEnv.dyld_insert_libraries = '/inherited';
    const authorizedEnv = {
      NODE_EXTRA_CA_CERTS: '/ca',
      NODE_USE_ENV_PROXY: '1',
      SSL_CERT_FILE: '/cert',
      SSL_CERT_DIR: '/certs',
      OPENSSL_CONF: '/openssl',
      PYTHONPATH: '/python',
      NODE_ENV: 'production',
    };
    Object.assign(mockState.enhancedEnv, authorizedEnv);
    process.env.npm_lifecycle_script = 'x'.repeat(40_000);
    try {
      const contaminated = request({
        managedCommand: {
          ...CLAUDE,
          env: {
            ...CLAUDE.env,
            NODE_PATH: '/final-merge',
            BASH_ENV: '/final-merge',
          },
        },
      });
      await spawnPlacedManagedTerminal(contaminated, {
        fromRemoteBridge: true,
      });
      await spawnPlacedManagedTerminal(contaminated);
      const inProcess = mockState.spawned[0]?.env;
      const daemonEnv: TerminalEnvironment = Object.fromEntries(
        Object.entries(mockState.creates[0]?.env ?? {}).map(([name, value]) => [
          name,
          typeof value === 'string' ? value : undefined,
        ]),
      );
      if (!inProcess || mockState.creates.length === 0)
        throw new Error('missing spawns');
      expect(
        WorkerTerminalCreateParamsSchema.safeParse(mockState.creates[0])
          .success,
      ).toBe(true);
      expect(daemonEnv).not.toHaveProperty('npm_lifecycle_script');

      // What the terminal host does with the create params (host/server.ts).
      let hosted: TerminalEnvironment | undefined;
      const hostEngine = createDesktopTerminalEngine({
        host: {
          pty: {
            spawn: (_file, _args, options): TerminalPty => {
              hosted = options.env;
              return mockPty('/opt/claude', options);
            },
          },
        },
      });
      hostEngine.create({
        projectId: 'project',
        worktreeId: 'task',
        cols: 80,
        rows: 24,
        cwd: mockState.root,
        shell: {
          shell: '/opt/claude',
          args: CLAUDE.args,
          shellBasename: 'claude',
        },
        environment: daemonEnv,
      });
      hostEngine.killAll();

      expect(hosted).toEqual(inProcess);
      expect(hosted).toMatchObject({
        ...authorizedEnv,
        NODE_PATH: '/final-merge',
        BASH_ENV: '/final-merge',
        [DESKTOP_INTEGRATION_TOKEN_ENV_VAR]: 'tok-secret',
        [brandEnvName('DESKTOP_INTEGRATION_SESSION_KEY')]: 'key-1',
      });
      expect(hosted?.PATH?.startsWith('/opt/canopy/bin')).toBe(true);
      for (const env of [hosted, inProcess]) {
        expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
        for (const key of [
          'NODE_OPTIONS',
          'Node_Options',
          'LD_PRELOAD',
          'dyld_insert_libraries',
        ])
          expect(env).not.toHaveProperty(key);
      }
    } finally {
      if (savedLifecycleScript === undefined)
        delete process.env.npm_lifecycle_script;
      else process.env.npm_lifecycle_script = savedLifecycleScript;
    }
  });

  it.each(['Node_Options', 'LD_PRELOAD', 'dyld_insert_libraries'])(
    'rejects a caller-supplied %s override before either terminal route starts',
    async (name) => {
      for (const fromRemoteBridge of [true, false]) {
        await expect(
          spawnPlacedManagedTerminal(
            request({
              managedCommand: {
                ...CLAUDE,
                env: { ...CLAUDE.env, [name]: '/blocked' },
              },
            }),
            { fromRemoteBridge },
          ),
        ).rejects.toThrow(`Invalid managed terminal env: blocked key ${name}`);
      }
      expect(mockState.creates).toEqual([]);
      expect(mockState.spawned).toEqual([]);
    },
  );

  it('an unreachable daemon opens the terminal in process; another refusal fails the launch', async () => {
    mockState.failure = Object.assign(new Error('setup failed'), {});
    markUnreachable(mockState.failure, 'start_failed');
    await expect(spawnPlacedManagedTerminal(request())).resolves.toMatchObject({
      kind: 'claude-code',
    });
    expect(mockState.spawned).toHaveLength(1);

    const refused = Object.assign(new Error('refused'), {
      payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
    });
    mockState.failure = refused;
    await expect(spawnPlacedManagedTerminal(request())).rejects.toBe(refused);
    expect(mockState.spawned).toHaveLength(1);
  });

  it('a main process sweeps orphaned managed daemon terminals once, before its first placement', async () => {
    mockState.listed = [
      listed('old-claude', 'managed'),
      listed('old-shell', 'interactive'),
    ];
    await spawnPlacedManagedTerminal(request());
    await spawnPlacedManagedTerminal(request());

    expect(mockState.kills).toEqual([
      {
        scope: { workspaceId: 'project', worktreeId: 'task' },
        terminalId: 'old-claude',
      },
    ]);
    expect(
      mockState.calls.filter((call) => call !== 'worker.terminal.write'),
    ).toEqual([
      'worker.terminal.list',
      'worker.terminal.kill',
      'worker.terminal.create',
      'worker.terminal.create',
    ]);

    // Variant: the list fails; the placement still reaches create.
    resetDaemonManagedTerminalSweepForTests();
    mockState.creates = [];
    mockState.listFailure = new Error('list failed');
    await spawnPlacedManagedTerminal(request());

    expect(
      mockWarn.mock.calls.filter(
        ([message]) =>
          message ===
          'Could not sweep daemon Claude terminals; launching anyway.',
      ),
    ).toHaveLength(1);
    expect(mockState.creates).toHaveLength(1);
  });

  it('interrupt and cleanup reach the daemon terminal', async () => {
    const session = await spawnPlacedManagedTerminal(request());
    await flush();

    workerTerminal.write(session.id, '\u001b');
    workerTerminal.kill(session.id, {
      signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    });
    await flush();
    expect(mockState.writes).toEqual([
      expect.objectContaining({ terminalId: session.id, input: '\u001b' }),
    ]);
    expect(mockState.kills).toHaveLength(1);
    expect(mockState.kills[0]).not.toHaveProperty('signal');

    mockState.sinks.get(session.id)?.(exitItem(session.id));
    await flush();
    const exit = events.find(
      (event) =>
        event.type === 'exit' && event.payload.terminalId === session.id,
    );
    expect(exit?.payload).toMatchObject({
      signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
      kind: 'claude-code',
    });
  });

  it('no log line carries the integration token', () => {
    // Runs last: cases 1, 6 and 7 above logged through the same mock.
    expect(mockAllWarnings.length).toBeGreaterThan(0);
    for (const call of mockAllWarnings)
      expect(JSON.stringify(call)).not.toContain('tok-secret');
  });
});
