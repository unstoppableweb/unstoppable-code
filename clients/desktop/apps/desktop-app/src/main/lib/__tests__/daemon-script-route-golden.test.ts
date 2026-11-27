/**
 * CAN-5087 golden: the real `script:run` and `script:stop` IPC handlers,
 * desktop dispatcher, CoreScriptRuns, worker.script adapter and route, which
 * reads no Labs experiment (CAN-5960), over a daemon double: a
 * second script worker behind the real handlers and output stream. The real
 * daemon is covered by script-conformance.
 */
import type * as CorePlatform from '@canopy/core-platform';

const mockGet = jest.fn<Promise<{ client: unknown }>, [unknown, unknown]>();
let mockDataRoot = '';
// CAN-5093: the route outcome labels each script decision sends.
const mockRouteLabels: unknown[] = [];
jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  ...jest.requireActual<object>(
    '@canopy/desktop-instrumentation/electron/main',
  ),
  succeedDesktopOperation: (
    name: string,
    options: { readonly context?: unknown },
  ): void => {
    if (name === 'canopy.daemon_route') mockRouteLabels.push(options.context);
  },
}));
jest.mock('../../canopy-runtime/electron-daemon-access', () => ({
  getElectronDaemonConnections: (): unknown => ({
    get: (caller: unknown, signal: unknown) => mockGet(caller, signal),
  }),
  getElectronDaemonFilesContext: (): Promise<unknown> =>
    Promise.resolve({ authorityId: 'local', canonicalDataRoot: mockDataRoot }),
}));
const mockNoteFallback = jest.fn();
let mockLatched = false;
jest.mock('../../canopy-runtime/electron-daemon-health', () => ({
  getElectronDaemonHealth: (): unknown => ({
    setConsumerEnabled: (): void => undefined,
    isLatched: (): boolean => mockLatched,
    noteFallback: (...args: unknown[]): void => {
      mockNoteFallback(...args);
    },
  }),
}));
let mockPlatform = 'darwin';
jest.mock('@canopy/core-platform', () => ({
  ...jest.requireActual<typeof CorePlatform>('@canopy/core-platform'),
  hostPlatformOperatingSystem: (): string => mockPlatform,
}));
// CAN-5960: the route never reads Labs, so a snapshot that is never ready
// changes nothing.
const mockLabsSnapshot = jest.fn(() => ({ ready: false, experiments: [] }));
jest.mock('../../services/labs-experiments-runtime', () => ({
  getLabsExperimentsService: (): unknown => ({
    getSnapshot: (): unknown => mockLabsSnapshot(),
  }),
}));
let mockBridge = false;
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): unknown => (mockBridge ? {} : null),
}));
let mockProjectPath = '';
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<unknown> =>
    Promise.resolve({
      items: [
        {
          id: 'project',
          type: 'single-repo',
          name: 'project',
          repoPath: mockProjectPath,
          worktrees: [{ id: 'task' }],
          scripts: {
            echo: 'printf \'one\\ntwo\\n\'; printf \'%s %s\' "$SECRET_KEY" "$GH_TOKEN" > /dev/null',
            long: 'sleep 30',
            slow: "sleep 0.5; printf 'done\\n'",
            interactive: { command: 'echo hi', interactive: true },
          },
        },
      ],
    }),
}));
jest.mock('../../lib/user-environment-store', () => ({
  readEnvironmentConfig: jest.fn(),
}));
jest.mock('../../lib/github-pat-env', () => ({
  readGitHubPatForExecution: jest.fn(),
}));
jest.mock('../../lib/linear-auth', () => ({ resolveLinearToken: jest.fn() }));
jest.mock('../../resource-monitor', () => ({
  getResourceMonitorService: (): unknown => ({
    registerProcess: (): unknown => ({ unregister: (): void => undefined }),
  }),
}));

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  createPlatformEndpointServices,
  hostPlatformServices,
} from '@canopy/core-platform';
import { readFilesystemScope } from '@canopy/core-runtime/node';
import { refusingExecutionSecretSource } from '@canopy/core-runtime/node/execution-secrets';
import { executionSecretFingerprints } from '@canopy/core-runtime/node/execution-secrets';
import {
  createWorkerScriptHandlers,
  createWorkerScriptStreamHandlers,
  ScriptExecutionWorker,
  scriptContextDirectory,
  scriptContextUnavailableError,
  scriptRunFileStem,
  type ScriptChildProcess,
  type ScriptExecutionPlace,
  type ScriptRunWriter,
  type ScriptRunWriterState,
} from '@canopy/core-runtime/node/script/execution';
import type {
  CanopyCallerDescriptor,
  CanopyHostExecution,
  WorkerScriptExecuteParams,
  WorkerScriptExecutionOutputItem,
} from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type ScriptRunResponse,
} from '@canopy/desktop-shared/types';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { resetResolvedCanopyDataDirForTests } from '@canopy/execution-engine/canopy-paths';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';
import { registerSecretsEnvInjector } from '@canopy/execution-engine/pipelines/config-paths';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../../canopy-runtime/core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { createWorkerScriptAdapter } from '../../canopy-runtime/worker-script-adapter';
import { markUnreachable } from '../../canopy-runtime/electron-daemon-connection';
import { getDaemonScopeResolver } from '../../canopy-runtime/daemon-scope-resolver';
import { registerScriptHandlers } from '../../ipc/scripts';
import { readEnvironmentConfig } from '../user-environment-store';
import { readGitHubPatForExecution } from '../github-pat-env';
import {
  initializeUserEnvironmentRuntime,
  invalidateUserEnvironmentInjectionCache,
} from '../user-environment-runtime';
import { resolveScriptRunDir } from '../paths';
import {
  desktopScriptWorker,
  drainWorktreeShellScripts,
  listTrackedShellScripts,
} from '../script-runner';
import { isDaemonScriptRunEligible } from '../daemon-script-route-context';
import { withWorkspaceTargetArchiveDrain } from '../workspace-target-exclusion';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
jest.setTimeout(60_000);

const canaries = ['secret-canary-env-5087', 'secret-canary-pat-5087'];
const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
const originalEnv = process.env;
let runtime: DesktopCanopyDispatcher;
let operations: CoreOperationAdapter;
let dispatched: WorkerScriptExecuteParams[];
let main: BrowserWindow;
let double: DaemonDouble;

interface DaemonCall {
  readonly name: string;
  readonly params: unknown;
  readonly execution: CanopyHostExecution | undefined;
  readonly idempotencyKey: string | undefined;
}

interface DaemonDouble {
  readonly calls: DaemonCall[];
  spawns: number;
  client: unknown;
  /** Awaited before each output stream opens; a rejection refuses it. */
  openGate?: () => Promise<void>;
  /** Thrown by the next clear once it reaches the double. */
  clearFailure?: Error;
  /** What a clear that reaches the double answers, in place of its worker. */
  clearResult?: { cleared: boolean };
}

function nodeChild(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv | undefined },
): ScriptChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  return {
    get pid(): number | undefined {
      return child.pid;
    },
    stdout: child.stdout && {
      onData: (listener): void => {
        child.stdout?.on('data', listener);
      },
      destroy: (): void => {
        child.stdout?.destroy();
      },
    },
    stderr: child.stderr && {
      onData: (listener): void => {
        child.stderr?.on('data', listener);
      },
      destroy: (): void => {
        child.stderr?.destroy();
      },
    },
    onError: (listener): void => {
      child.on('error', listener);
    },
    onClose: (listener): void => {
      child.on('close', listener);
    },
    killGroup: (signal): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    },
  };
}

/** The daemon double: a second worker writing where Electron main writes. */
function createDaemonDouble(): DaemonDouble {
  const { supervision } = hostPlatformServices(
    createPlatformEndpointServices('darwin'),
  );
  const calls: DaemonCall[] = [];
  const state: DaemonDouble = { calls, spawns: 0, client: undefined };
  const worker = new ScriptExecutionWorker({
    secrets: refusingExecutionSecretSource,
    authorityId: 'local',
    platform: (): string => process.platform,
    findExecutable: (name): string | null => {
      for (const dir of ['/bin', '/usr/bin'])
        try {
          readFileSync(join(dir, name));
          return join(dir, name);
        } catch {
          // Next directory.
        }
      return null;
    },
    windowsGitBash: (): null => null,
    cmdCommandLine: (script): string => script,
    loginShell: (): string => '/bin/sh',
    comSpec: (): undefined => undefined,
    prepareLaunch: (command, args): { command: string; args: string[] } => ({
      command,
      args,
    }),
    lowerPriority: (): void => undefined,
    spawn: (command, args, options): ScriptChildProcess => {
      state.spawns += 1;
      return nodeChild(command, args, options);
    },
    drainOwnedProcess: (pid, isOwned): Promise<void> => {
      try {
        if (isOwned()) process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      return Promise.resolve();
    },
    logPaths: {
      runDir: (projectId, worktreeId): string =>
        resolveScriptRunDir(projectId, worktreeId),
      fileStem: scriptRunFileStem,
    },
    logFiles: {
      writeFileAtomically: async (file, text): Promise<void> => {
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, text, 'utf8');
        await rename(temp, file);
      },
    },
    writerFence: {
      self: async (): Promise<ScriptRunWriter | null> => {
        const found = await supervision.inspectProcess({ pid: process.pid });
        return found.state === 'running'
          ? { pid: process.pid, startIdentity: found.startIdentity }
          : null;
      },
      inspect: async (writer): Promise<ScriptRunWriterState> => {
        const found = await supervision.inspectProcess({ pid: writer.pid });
        if (found.state === 'running')
          return found.startIdentity === writer.startIdentity
            ? 'running'
            : 'gone';
        return found.state === 'absent' ? 'gone' : 'unverifiable';
      },
    },
    resolvePlace: async (
      scope,
      context,
      _secrets,
      execution,
    ): Promise<ScriptExecutionPlace> => {
      const { workspaceId, worktreeId } = scope;
      if (workspaceId === undefined || worktreeId === undefined)
        throw scriptContextUnavailableError();
      const workspaceScope = { workspaceId, worktreeId };
      const catalog = await readFilesystemScope(
        workspaceScope,
        await (
          await getDaemonScopeResolver()
        )(workspaceScope, 'roots'),
        'roots',
      );
      const cwd = scriptContextDirectory(catalog, workspaceScope, context);
      if (cwd === null) throw scriptContextUnavailableError();
      return { cwd, env: { ...execution?.childEnvironment } };
    },
  });
  const scripts = createWorkerScriptHandlers(worker, { detached: true });
  const streams = createWorkerScriptStreamHandlers(worker);
  const context = (options: {
    readonly metadata?: { readonly idempotencyKey?: string };
    readonly execution?: CanopyHostExecution;
  }): Parameters<
    (typeof scripts.instructions)['worker.script.execute']
  >[1] => ({
    requestId: randomUUID(),
    caller: {
      principalId: 'local-desktop-user',
      clientInstanceId: 'electron-main:scripts',
      authorityId: 'local',
      interfaceKind: 'desktop',
      grants: ['worker.script.execute', 'worker.script.read'],
    },
    metadata: { idempotencyKey: options.metadata?.idempotencyKey },
    signal: new AbortController().signal,
    ...(options.execution && { execution: options.execution }),
  });
  state.client = {
    signal: new AbortController().signal,
    instruction: (
      name: string,
      params: unknown,
      options: {
        readonly metadata?: { readonly idempotencyKey?: string };
        readonly execution?: CanopyHostExecution;
      } = {},
    ): Promise<unknown> => {
      calls.push({
        name,
        params,
        execution: options.execution,
        idempotencyKey: options.metadata?.idempotencyKey,
      });
      if (name === 'worker.script.execute')
        return Promise.resolve(
          scripts.instructions['worker.script.execute'](
            params as WorkerScriptExecuteParams,
            context(options),
          ),
        );
      if (name === 'worker.script.execution.clear') {
        if (state.clearFailure !== undefined)
          return Promise.reject(state.clearFailure);
        if (state.clearResult !== undefined)
          return Promise.resolve(state.clearResult);
        return Promise.resolve(
          scripts.instructions['worker.script.execution.clear'](
            params as Parameters<
              (typeof scripts.instructions)['worker.script.execution.clear']
            >[0],
            context(options),
          ),
        );
      }
      if (name === 'worker.script.execution.cancel')
        return Promise.resolve(
          scripts.instructions['worker.script.execution.cancel'](
            params as Parameters<
              (typeof scripts.instructions)['worker.script.execution.cancel']
            >[0],
            context(options),
          ),
        );
      return Promise.reject(new Error(`Unexpected ${name}`));
    },
    query: (name: string, params: unknown): Promise<unknown> => {
      calls.push({
        name,
        params,
        execution: undefined,
        idempotencyKey: undefined,
      });
      if (name === 'worker.script.execution.groupMembers')
        return Promise.resolve(
          scripts.queries['worker.script.execution.groupMembers'](
            params as Parameters<
              (typeof scripts.queries)['worker.script.execution.groupMembers']
            >[0],
            context({}),
          ),
        );
      if (name === 'worker.script.execution.get')
        return Promise.resolve(
          scripts.queries['worker.script.execution.get'](
            params as Parameters<
              (typeof scripts.queries)['worker.script.execution.get']
            >[0],
            context({}),
          ),
        );
      if (name === 'worker.script.execution.list')
        return Promise.resolve(
          scripts.queries['worker.script.execution.list'](
            params as Parameters<
              (typeof scripts.queries)['worker.script.execution.list']
            >[0],
            context({}),
          ),
        );
      return Promise.reject(new Error(`Unexpected ${name}`));
    },
    openStream: async (name: string, params: unknown): Promise<unknown> => {
      calls.push({
        name,
        params,
        execution: undefined,
        idempotencyKey: undefined,
      });
      await state.openGate?.();
      const pending: unknown[] = [];
      const listeners = new Set<(frame: unknown) => void>();
      const deliver = (frame: unknown): void => {
        if (listeners.size === 0) pending.push(frame);
        else listeners.forEach((listener) => listener(frame));
      };
      let sequence = 0;
      const cleanup = await streams['worker.script.execution.output'](
        params as Parameters<
          (typeof streams)['worker.script.execution.output']
        >[0],
        context({}),
        {
          buffered: () => 0,
          emit: (item: WorkerScriptExecutionOutputItem) => {
            sequence += 1;
            deliver({ kind: 'item', item });
            return { daemonEpoch: 'double', sequence };
          },
          emitAt: () => null,
          end: (outcome) => deliver({ kind: 'end', outcome, error: null }),
          endAt: (_cursor, outcome) =>
            deliver({ kind: 'end', outcome, error: null }),
        },
      );
      return {
        onFrame: (listener: (frame: unknown) => void): (() => void) => {
          listeners.add(listener);
          pending.splice(0).forEach((frame) => listener(frame));
          return (): void => {
            listeners.delete(listener);
          };
        },
        close: (): void => cleanup(),
      };
    },
  };
  return state;
}

function invoke(
  channel: string,
  request: unknown,
  window: BrowserWindow | null = main,
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler ${channel}`);
  const event = {
    sender: window?.webContents ?? new BrowserWindow().webContents,
    senderFrame: null,
    frameId: 1,
    processId: 1,
    type: 'frame',
    preventDefault: (): void => undefined,
    defaultPrevented: false,
  } satisfies IpcMainInvokeEvent;
  return Promise.resolve().then((): unknown => handler(event, request));
}

function runRequest(scriptName: string): unknown {
  return {
    target: 'project',
    projectId: 'project',
    worktreeId: 'task',
    scriptName,
  };
}

function runDirFiles(): string[] {
  try {
    return readdirSync(resolveScriptRunDir('project', 'task'));
  } catch {
    return [];
  }
}

function seed(root: string): void {
  const write = (file: string, value: unknown): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify(value));
  };
  write('workspaces/index.json', {
    version: 1,
    workspaces: [
      { id: 'project', name: 'project', type: 'single-repo', color: '#fff' },
    ],
  });
  write('workspaces/project/workspace.json', {
    version: 1,
    type: 'single-repo',
    repos: [],
  });
  write('workspaces/project/worktrees.json', {
    version: 1,
    worktrees: [{ id: 'task', branchName: 'topic', createdAt: 'now' }],
  });
  mkdirSync(join(root, 'workspaces/project/worktrees/task'), {
    recursive: true,
  });
}

function scanLedger(root: string): void {
  for (const name of readdirSync(join(root, 'ledger'))) {
    const bytes = readFileSync(join(root, 'ledger', name));
    for (const canary of canaries)
      expect(bytes.includes(Buffer.from(canary))).toBe(false);
  }
}

let root = '';

beforeAll(() => {
  // One data root for the file: the daemon scope resolver is built once.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'daemon-script-route-')));
  mockDataRoot = root;
  mockProjectPath = join(root, 'workspaces/project/worktrees/task');
  mkdirSync(join(root, 'home'));
  seed(root);
  jest.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => {
    handlers.set(channel, handler);
  });
});

beforeEach(() => {
  mockRouteLabels.length = 0;
  mockPlatform = 'darwin';
  mockLabsSnapshot.mockClear();
  mockBridge = false;
  mockLatched = false;
  mockNoteFallback.mockReset();
  mkdirSync(join(root, 'ledger'));
  process.env = {
    NODE_ENV: 'test',
    HOME: join(root, 'home'),
    USER: 'fixture',
    PATH: originalEnv.PATH,
    SHELL: '/bin/sh',
    TMPDIR: originalEnv.TMPDIR,
    CANOPY_DATA_DIR: root,
  };
  resetResolvedCanopyDataDirForTests();
  const now = '2026-11-05T00:00:00.000Z';
  const config = createDefaultEnvironmentConfig(now);
  config.environments.push({
    id: 'secrets',
    name: 'Secrets',
    parentId: null,
    isDefault: false,
    uiMode: 'key-value',
    createdAt: now,
    updatedAt: now,
    variables: [{ key: 'SECRET_KEY', value: canaries[0], secret: true }],
  });
  config.globalRuntimes.canopy = 'secrets';
  jest
    .mocked(readEnvironmentConfig)
    .mockResolvedValue({ data: config, encryptionAvailable: true });
  jest.mocked(readGitHubPatForExecution).mockReturnValue(canaries[1]);
  invalidateUserEnvironmentInjectionCache();
  initializeUserEnvironmentRuntime();
  registerSecretsEnvInjector(() => ({ GH_TOKEN: canaries[1] }));
  double = createDaemonDouble();
  mockGet.mockReset();
  mockGet.mockResolvedValue({ client: double.client });
  operations = createCoreOperationAdapter({
    ledgerPath: (): string => join(root, 'ledger', 'operations.sqlite'),
  });
  dispatched = [];
  const adapter = createWorkerScriptAdapter();
  const execute = adapter.instructions['worker.script.execute'];
  adapter.instructions['worker.script.execute'] = (
    params,
    context,
  ): ReturnType<typeof execute> => {
    dispatched.push(params);
    return execute(params, context);
  };
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    workerScriptAdapter: adapter,
    shutdownTimeoutMs: 25,
  });
  main = new BrowserWindow();
  registerScriptHandlers(
    {
      dispatcher: runtime,
      resolveCaller: () => ({
        principalId: 'local-desktop-user',
        clientInstanceId: 'renderer',
        authorityId: 'local',
        interfaceKind: 'desktop',
        grants: [],
      }),
    },
    {
      getMainWindow: () => main,
      getAppAdvisorWindow: () => null,
    },
  );
});

afterEach(async () => {
  try {
    await drainWorktreeShellScripts('project', 'task').catch(() => undefined);
    await runtime.shutdown();
    scanLedger(root);
  } finally {
    registerSecretsEnvInjector(null);
    invalidateUserEnvironmentInjectionCache();
    process.env = originalEnv;
    resetResolvedCanopyDataDirForTests();
    rmSync(join(root, 'ledger'), { recursive: true, force: true });
    rmSync(join(root, 'workspaces/project/script-runs'), {
      recursive: true,
      force: true,
    });
  }
});

afterAll(() => {
  jest.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function executes(): DaemonCall[] {
  return double.calls.filter(({ name }) => name === 'worker.script.execute');
}

describePosix('daemon script route (CAN-5087)', () => {
  it.each(['darwin', 'linux', 'win32'])(
    "routes a local window's run on macOS, Linux and Windows (%s)",
    async (platform) => {
      mockPlatform = platform;
      const local = jest.spyOn(desktopScriptWorker, 'execute');
      const send = jest.spyOn(main.webContents, 'send');
      const relayOf = desktopScriptWorker.relay.bind(desktopScriptWorker);
      const truncated: boolean[] = [];
      const relays = jest
        .spyOn(desktopScriptWorker, 'relay')
        .mockImplementation((executionId) => {
          const inner = relayOf(executionId);
          return {
            ...inner,
            finished: (outcome): void => {
              truncated.push(outcome.outputTruncated);
              inner.finished(outcome);
            },
          };
        });
      let seen = false;
      const response = invoke(IPC_CHANNELS.scriptRun, runRequest('slow'));
      for (let attempt = 0; attempt < 100 && !seen; attempt += 1) {
        seen = listTrackedShellScripts().some(({ scriptKey }) =>
          scriptKey.endsWith('slow'),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(seen).toBe(true);
      const result = (await response) as ScriptRunResponse;
      expect(result.success).toBe(true);
      expect(double.spawns).toBe(1);
      expect(local).not.toHaveBeenCalled();
      expect(mockLabsSnapshot).not.toHaveBeenCalled();
      const output = send.mock.calls.filter(
        ([channel]) => channel === IPC_CHANNELS.scriptOutput,
      );
      expect(JSON.stringify(output)).toContain('done');
      // The stream ended with the run, so none of its output is missing.
      expect(truncated).toEqual([false]);
      relays.mockRestore();
      const [parent] = (
        await operations.service.list({ kinds: ['core.script.run'], limit: 10 })
      ).items;
      expect(parent?.status).toBe('completed');
      if (!parent) throw new Error('Missing operation');
      expect(
        await runtime.localWorker.listDelegations(parent.operationId),
      ).toHaveLength(1);
      local.mockRestore();
    },
  );

  it.each([
    [
      'keeps runs on an unsupported host in process',
      (): void => void (mockPlatform = 'freebsd'),
    ],
    [
      'keeps remote-bridge runs in process',
      (): void => void (mockBridge = true),
    ],
  ])('%s', async (_name, arrange) => {
    arrange();
    await invoke(IPC_CHANNELS.scriptRun, runRequest('echo')).catch(
      () => undefined,
    );
    expect(double.calls).toEqual([]);
  });

  it('keeps Portal runs in process', async () => {
    const { runScript } = await import('../../services/scripts-service');
    const result = await runScript({
      target: 'project',
      projectId: 'project',
      worktreeId: 'task',
      scriptName: 'echo',
    });
    expect(result.success).toBe(true);
    expect(double.calls).toEqual([]);
  });

  it('keeps interactive, background, shared-container and automation-home runs in process', async () => {
    const base: WorkerScriptExecuteParams = {
      scope: { workspaceId: 'project', worktreeId: 'task' },
      executionId: randomUUID(),
      context: { kind: 'project' },
      command: 'echo',
      shellStartup: 'interactive',
      timeoutMs: null,
      priority: 'normal',
      record: {
        script: {
          scriptKey: 'k',
          scriptName: 'k',
          label: 'k',
          command: 'echo',
          lifecycle: 'custom',
          target: 'project',
        },
        invocation: 'manual-run',
      },
    };
    expect(isDaemonScriptRunEligible(base)).toBe(true);
    expect(isDaemonScriptRunEligible({ ...base, terminal: {} })).toBe(false);
    expect(isDaemonScriptRunEligible({ ...base, priority: 'background' })).toBe(
      false,
    );
    expect(
      isDaemonScriptRunEligible({
        ...base,
        context: { kind: 'shared-container', repoId: 'r', environmentKeys: [] },
      }),
    ).toBe(false);
    expect(
      isDaemonScriptRunEligible({
        ...base,
        context: { kind: 'automation-home' },
      }),
    ).toBe(false);
    await invoke(IPC_CHANNELS.scriptRun, runRequest('interactive')).catch(
      () => undefined,
    );
    expect(executes()).toEqual([]);
  });

  it('sends the complete environment and no secret binding', async () => {
    const result = (await invoke(
      IPC_CHANNELS.scriptRun,
      runRequest('echo'),
    )) as ScriptRunResponse;
    expect(result.success).toBe(true);
    const [call] = executes();
    if (!call) throw new Error('Missing daemon run');
    expect(call.params).not.toHaveProperty('secrets');
    expect(call.execution?.childEnvironment).toMatchObject({
      SECRET_KEY: canaries[0],
      GH_TOKEN: canaries[1],
    });
    const [original] = dispatched;
    expect(original?.secrets?.length).toBeGreaterThan(0);
    const [parent] = (
      await operations.service.list({ kinds: ['core.script.run'], limit: 10 })
    ).items;
    if (!parent) throw new Error('Missing operation');
    const [delegation] = await runtime.localWorker.listDelegations(
      parent.operationId,
    );
    expect(delegation?.secrets).toEqual(
      executionSecretFingerprints(original?.secrets),
    );
  });

  it('a Portal run after a daemon run runs in process with nothing repaired', async () => {
    await invoke(IPC_CHANNELS.scriptRun, runRequest('echo'));
    expect(executes()).toHaveLength(1);
    const { runScript } = await import('../../services/scripts-service');
    const result = await runScript({
      target: 'project',
      projectId: 'project',
      worktreeId: 'task',
      scriptName: 'echo',
    });
    expect(result.success).toBe(true);
    expect(executes()).toHaveLength(1);
    const files = runDirFiles();
    expect(files.filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith('.log'))).toHaveLength(1);
    expect(files.some((name) => name.includes('.unreadable-'))).toBe(false);
    const meta: unknown = JSON.parse(
      readFileSync(
        join(
          resolveScriptRunDir('project', 'task'),
          files.find((name) => name.endsWith('.json')) ?? '',
        ),
        'utf8',
      ),
    );
    expect(meta).toMatchObject({
      status: 'success',
      instanceId: desktopScriptWorker.logs.instanceId,
    });
  });

  it('refuses a run whose worktree starts archiving while it waits for the daemon', async () => {
    const pending: Array<() => void> = [];
    mockGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push((): void => resolve({ client: double.client }));
        }),
    );
    const response = invoke(IPC_CHANNELS.scriptRun, runRequest('echo')).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, value: error }),
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (mockGet.mock.calls.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(mockGet).toHaveBeenCalled();
    // The archive stays open until the run has settled.
    let settled = false;
    const drain = withWorkspaceTargetArchiveDrain(
      'project',
      'task',
      async (): Promise<void> => {
        while (!settled)
          await new Promise((resolve) => setTimeout(resolve, 10));
      },
    );
    mockGet.mockResolvedValue({ client: double.client });
    pending.splice(0).forEach((release) => release());
    const outcome = await response;
    settled = true;
    await drain;
    expect(
      outcome.ok
        ? (outcome.value as ScriptRunResponse).success
        : String(outcome.value),
    ).not.toBe(true);
    expect(executes()).toEqual([]);
    expect(double.spawns).toBe(0);
  });

  it('an unreachable daemon runs in process and notes the fallback', async () => {
    mockGet.mockRejectedValue(
      markUnreachable(new Error('down'), 'connection_lost'),
    );
    const result = (await invoke(
      IPC_CHANNELS.scriptRun,
      runRequest('echo'),
    )) as ScriptRunResponse;
    expect(result.success).toBe(true);
    expect(double.spawns).toBe(0);
    expect(mockNoteFallback).toHaveBeenCalledWith('scripts', 'connection_lost');
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockRouteLabels).toEqual([
      {
        route_family: 'scripts',
        route_host: 'in_process',
        route_reason: 'unreachable',
      },
    ]);
  });

  it('a renderer stop cancels the daemon run', async () => {
    const response = invoke(IPC_CHANNELS.scriptRun, runRequest('long'));
    let tracked = listTrackedShellScripts();
    for (let attempt = 0; attempt < 100 && tracked.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      tracked = listTrackedShellScripts();
    }
    const [run] = tracked;
    if (!run) throw new Error('The run never started.');
    await invoke(IPC_CHANNELS.scriptStop, {
      projectId: 'project',
      worktreeId: 'task',
      scriptKey: run.scriptKey,
    });
    const result = (await response) as ScriptRunResponse;
    expect(result.success).toBe(false);
    const cancel = double.calls.find(
      ({ name }) => name === 'worker.script.execution.cancel',
    );
    expect(cancel?.params).toMatchObject({ executionId: run.runId });
    // Started in the daemon, so it counts as served once however it ends.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockRouteLabels).toEqual([
      { route_family: 'scripts', route_host: 'daemon', route_reason: 'served' },
    ]);
  });

  it("worktree removal drains a routed daemon run's whole tree", async () => {
    const response = invoke(IPC_CHANNELS.scriptRun, runRequest('long'));
    let tracked = listTrackedShellScripts();
    for (let attempt = 0; attempt < 100 && tracked.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      tracked = listTrackedShellScripts();
    }
    const [run] = tracked;
    if (!run) throw new Error('The run never started.');
    await drainWorktreeShellScripts('project', 'task');
    const result = (await response) as ScriptRunResponse;
    expect(result.success).toBe(false);
    const cancels = double.calls.filter(
      ({ name }) => name === 'worker.script.execution.cancel',
    );
    // The routed run's own abort only stops it; the drain reaches its tree.
    expect(cancels[0]?.params).toEqual({
      scope: { workspaceId: 'project', worktreeId: 'task' },
      scriptKey: run.scriptKey,
      drain: true,
    });
  });

  it('worktree removal leaves the daemon alone without a live daemon run', async () => {
    const dir = resolveScriptRunDir('project', 'task');
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `${scriptRunFileStem('finished')}.json`),
      JSON.stringify({
        version: 1,
        runId: randomUUID(),
        script: {
          scriptKey: 'finished',
          scriptName: 'finished',
          label: 'Finished',
          command: 'true',
          lifecycle: 'custom',
          target: 'project',
        },
        invocation: 'manual-run',
        status: 'success',
        startedAt: now,
        updatedAt: now,
        completedAt: now,
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        instanceId: 'app-instance',
      }),
    );
    await drainWorktreeShellScripts('project', 'task');
    expect(double.calls).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it.each([
    ['while the drain reads the run logs', 'sweeping'],
    ['once the drain has stopped the run', 'stopped'],
  ] as const)(
    'a drain while the daemon refuses the run leaves nothing running in process (%s)',
    async (_when, phase) => {
      const until = async (check: () => boolean): Promise<void> => {
        for (let attempt = 0; attempt < 500 && !check(); attempt += 1)
          await new Promise((resolve) => setTimeout(resolve, 20));
        expect(check()).toBe(true);
      };
      let refuse = (): void => undefined;
      double.openGate = (): Promise<void> =>
        new Promise((_resolve, reject) => {
          refuse = (): void => reject(new Error('refused'));
        });
      const local = jest.spyOn(desktopScriptWorker, 'execute');
      const response = invoke(IPC_CHANNELS.scriptRun, runRequest('echo'));
      await until(() =>
        double.calls.some(
          ({ name }) => name === 'worker.script.execution.output',
        ),
      );
      // The drain's run-log read is held so the refusal lands at a known point.
      const listOf = desktopScriptWorker.list.bind(desktopScriptWorker);
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reading = false;
      let read = false;
      const list = jest
        .spyOn(desktopScriptWorker, 'list')
        .mockImplementation(async (params) => {
          reading = true;
          await held;
          const runs = await listOf(params);
          read = true;
          return runs;
        });
      let drainSettled = false;
      const drained = drainWorktreeShellScripts('project', 'task').finally(
        () => {
          drainSettled = true;
        },
      );
      if (phase === 'sweeping') {
        await until(() => reading);
        refuse();
        await response.catch(() => undefined);
        release();
      } else {
        release();
        await until(() => read);
        // The drain waits for the run it stopped to end.
        expect(drainSettled).toBe(false);
        refuse();
      }
      await drained;
      await response.catch(() => undefined);
      list.mockRestore();
      const inProcess = local.mock.calls.length;
      local.mockRestore();
      expect(inProcess).toBe(0);
      expect(double.spawns).toBe(0);
    },
  );

  it('worktree removal drains a daemon run it did not route', async () => {
    const { supervision } = hostPlatformServices(
      createPlatformEndpointServices('darwin'),
    );
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const pid = sleeper.pid;
      if (pid === undefined) throw new Error('No sleeper.');
      const found = await supervision.inspectProcess({ pid });
      if (found.state !== 'running') throw new Error('Sleeper not running.');
      const executionId = randomUUID();
      const dir = resolveScriptRunDir('project', 'task');
      mkdirSync(dir, { recursive: true });
      const now = new Date().toISOString();
      writeFileSync(
        join(dir, `${scriptRunFileStem('foreign')}.json`),
        JSON.stringify({
          version: 1,
          runId: executionId,
          script: {
            scriptKey: 'foreign',
            scriptName: 'foreign',
            label: 'Foreign',
            command: 'sleep 30',
            lifecycle: 'custom',
            target: 'project',
          },
          invocation: 'manual-run',
          status: 'running',
          startedAt: now,
          updatedAt: now,
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          instanceId: 'daemon-instance',
          writer: { pid, startIdentity: found.startIdentity },
        }),
      );
      await drainWorktreeShellScripts('project', 'task');
      const cancels = double.calls.filter(
        ({ name }) => name === 'worker.script.execution.cancel',
      );
      // By script key: older daemon runs of the key that its run log no
      // longer lists stop too. A drain waits for each run's process tree.
      expect(cancels.map(({ params }) => params)).toEqual([
        {
          scope: { workspaceId: 'project', worktreeId: 'task' },
          scriptKey: 'foreign',
          drain: true,
        },
      ]);
    } finally {
      sleeper.kill('SIGKILL');
    }
  });
});

// CAN-7663: an orphaned run's group members, read through the real desktop
// dispatcher and worker.script adapter.
describePosix('daemon script reads (CAN-7663)', () => {
  const READER: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'renderer',
    authorityId: 'local',
    interfaceKind: 'desktop',
    grants: ['worker.script.read'],
  };
  const groupMembers = (): Promise<unknown> =>
    runtime.query(
      'worker.script.execution.groupMembers',
      {
        scope: { workspaceId: 'project', worktreeId: 'task' },
        scriptKey: 'echo',
        executionId: 'not-a-run',
      },
      { caller: READER },
    );
  const notOrphaned = { payload: { code: 'worker.script.notOrphaned' } };
  const reads = (): DaemonCall[] =>
    double.calls.filter(
      ({ name }) => name === 'worker.script.execution.groupMembers',
    );

  it.each(['darwin', 'linux'])(
    "reads an orphaned run's group members from the daemon (%s)",
    async (platform) => {
      mockPlatform = platform;
      const local = jest.spyOn(desktopScriptWorker, 'groupMembers');
      try {
        // The daemon's refusal is the answer: nothing reads in process.
        await expect(groupMembers()).rejects.toMatchObject(notOrphaned);
        expect(reads().map(({ params }) => params)).toEqual([
          {
            scope: { workspaceId: 'project', worktreeId: 'task' },
            scriptKey: 'echo',
            executionId: 'not-a-run',
          },
        ]);
        expect(local).not.toHaveBeenCalled();
      } finally {
        local.mockRestore();
      }
    },
  );

  it.each([
    ['on Windows', (): void => void (mockPlatform = 'win32')],
    [
      'while the daemon is latched unreachable',
      (): void => void (mockLatched = true),
    ],
  ])('reads the group members in process %s', async (_name, arrange) => {
    arrange();
    const local = jest.spyOn(desktopScriptWorker, 'groupMembers');
    try {
      await expect(groupMembers()).rejects.toMatchObject(notOrphaned);
      expect(double.calls).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
      expect(local).toHaveBeenCalledTimes(1);
    } finally {
      local.mockRestore();
    }
  });

  it('an unreachable daemon reads the group members in process and notes the fallback', async () => {
    mockGet.mockRejectedValue(
      markUnreachable(new Error('down'), 'connection_lost'),
    );
    const local = jest.spyOn(desktopScriptWorker, 'groupMembers');
    try {
      await expect(groupMembers()).rejects.toMatchObject(notOrphaned);
      expect(local).toHaveBeenCalledTimes(1);
      expect(mockNoteFallback).toHaveBeenCalledWith(
        'scripts',
        'connection_lost',
      );
    } finally {
      local.mockRestore();
    }
  });
});

// CAN-7663: each key's latest run and one key's run, read through the real
// desktop dispatcher and worker.script adapter.
describePosix('daemon script run log reads (CAN-7663)', () => {
  const READER: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'renderer',
    authorityId: 'local',
    interfaceKind: 'desktop',
    grants: ['worker.script.read'],
  };
  const scope = { workspaceId: 'project', worktreeId: 'task' };
  const get = (): Promise<unknown> =>
    runtime.query(
      'worker.script.execution.get',
      { scope, scriptKey: 'echo', tailLines: 0 },
      { caller: READER },
    );
  const list = (): Promise<unknown> =>
    runtime.query(
      'worker.script.execution.list',
      { scope, tailLines: 0 },
      { caller: READER },
    );
  const reads = (): string[] =>
    double.calls
      .map(({ name }) => name)
      .filter(
        (name) =>
          name === 'worker.script.execution.get' ||
          name === 'worker.script.execution.list',
      );

  it.each(['darwin', 'linux'])(
    'reads a run and the runs from the daemon (%s)',
    async (platform) => {
      mockPlatform = platform;
      const localGet = jest.spyOn(desktopScriptWorker, 'get');
      const localList = jest.spyOn(desktopScriptWorker, 'list');
      try {
        await expect(get()).resolves.toEqual({ run: null });
        await expect(list()).resolves.toEqual({ runs: [] });
        expect(reads()).toEqual([
          'worker.script.execution.get',
          'worker.script.execution.list',
        ]);
        expect(localGet).not.toHaveBeenCalled();
        expect(localList).not.toHaveBeenCalled();
      } finally {
        localGet.mockRestore();
        localList.mockRestore();
      }
    },
  );

  it.each([
    ['on Windows', (): void => void (mockPlatform = 'win32')],
    [
      'while the daemon is latched unreachable',
      (): void => void (mockLatched = true),
    ],
  ])('reads a run and the runs in process %s', async (_name, arrange) => {
    arrange();
    const localGet = jest.spyOn(desktopScriptWorker, 'get');
    const localList = jest.spyOn(desktopScriptWorker, 'list');
    try {
      await expect(get()).resolves.toEqual({ run: null });
      await expect(list()).resolves.toEqual({ runs: [] });
      expect(double.calls).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
      expect(localGet).toHaveBeenCalledTimes(1);
      expect(localList).toHaveBeenCalledTimes(1);
    } finally {
      localGet.mockRestore();
      localList.mockRestore();
    }
  });

  it('an unreachable daemon reads in process and notes the fallback', async () => {
    mockGet.mockRejectedValue(
      markUnreachable(new Error('down'), 'connection_lost'),
    );
    const localGet = jest.spyOn(desktopScriptWorker, 'get');
    const localList = jest.spyOn(desktopScriptWorker, 'list');
    try {
      await expect(get()).resolves.toEqual({ run: null });
      await expect(list()).resolves.toEqual({ runs: [] });
      expect(localGet).toHaveBeenCalledTimes(1);
      expect(localList).toHaveBeenCalledTimes(1);
      expect(mockNoteFallback).toHaveBeenCalledWith(
        'scripts',
        'connection_lost',
      );
    } finally {
      localGet.mockRestore();
      localList.mockRestore();
    }
  });
});

// CAN-7663: each routed script run read counts where it ran in the `route`
// work counters, which a performance receipt reads as route evidence.
describePosix('daemon script read route records (CAN-7663)', () => {
  const READER: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'renderer',
    authorityId: 'local',
    interfaceKind: 'desktop',
    grants: ['worker.script.read'],
  };
  const scope = { workspaceId: 'project', worktreeId: 'task' };
  const readAll = async (): Promise<void> => {
    await runtime.query(
      'worker.script.execution.get',
      { scope, scriptKey: 'echo', tailLines: 0 },
      { caller: READER },
    );
    await runtime.query(
      'worker.script.execution.list',
      { scope, tailLines: 0 },
      { caller: READER },
    );
    await expect(
      runtime.query(
        'worker.script.execution.groupMembers',
        { scope, scriptKey: 'echo', executionId: 'not-a-run' },
        { caller: READER },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.script.notOrphaned' },
    });
  };
  const scriptRoutes = (): Record<string, number> =>
    Object.fromEntries(
      Object.entries(snapshotWorkCounters().route).filter(([key]) =>
        key.startsWith('scripts.'),
      ),
    );

  beforeEach(() => {
    resetWorkCounters();
  });

  it.each(['darwin', 'linux'])(
    'counts each read on the daemon path (%s)',
    async (platform) => {
      mockPlatform = platform;
      await readAll();
      expect(scriptRoutes()).toEqual({
        'scripts.get.daemon.served': 1,
        'scripts.list.daemon.served': 1,
        'scripts.groupMembers.daemon.refused': 1,
      });
    },
  );

  it.each([
    ['on Windows', (): void => void (mockPlatform = 'win32')],
    [
      'while the daemon is latched unreachable',
      (): void => void (mockLatched = true),
    ],
  ])('counts each read as direct %s', async (_name, arrange) => {
    arrange();
    await readAll();
    expect(scriptRoutes()).toEqual({
      'scripts.get.direct': 1,
      'scripts.list.direct': 1,
      'scripts.groupMembers.direct': 1,
    });
  });

  it('counts each read an unreachable daemon left in process as a fallback', async () => {
    mockGet.mockRejectedValue(
      markUnreachable(new Error('down'), 'connection_lost'),
    );
    await readAll();
    expect(scriptRoutes()).toEqual({
      'scripts.get.daemon.fallback': 1,
      'scripts.list.daemon.fallback': 1,
      'scripts.groupMembers.daemon.fallback': 1,
    });
  });
});

// CAN-7663: a finished run's clear, sent through the real desktop dispatcher
// and worker.script adapter with the caller's key.
describePosix('daemon script run clears (CAN-7663)', () => {
  const CLEARER: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'renderer',
    authorityId: 'local',
    interfaceKind: 'desktop',
    grants: ['worker.script.execute'],
  };
  const params = {
    scope: { workspaceId: 'project', worktreeId: 'task' },
    scriptKey: 'echo',
    executionId: 'not-a-run',
  };
  const clear = (): Promise<unknown> =>
    runtime.instruction('worker.script.execution.clear', params, {
      caller: CLEARER,
      metadata: { idempotencyKey: 'clear-key' },
    });
  const clears = (): DaemonCall[] =>
    double.calls.filter(({ name }) => name === 'worker.script.execution.clear');
  // The daemon scopes keys per peer, so the caller's key is bound to its
  // principal before it shares main's script session.
  const boundKey = (principalId: string, key: string): string =>
    createHash('sha256')
      .update(`worker.script.execution.clear\0${principalId}\0${key}`)
      .digest('hex');
  const clearRoutes = (): Record<string, number> =>
    Object.fromEntries(
      Object.entries(snapshotWorkCounters().route).filter(([key]) =>
        key.startsWith('scripts.clear.'),
      ),
    );

  beforeEach(() => {
    resetWorkCounters();
  });

  it.each(['darwin', 'linux'])(
    "clears a run on the daemon with the caller's key (%s)",
    async (platform) => {
      mockPlatform = platform;
      const local = jest.spyOn(desktopScriptWorker, 'clear');
      try {
        await expect(clear()).resolves.toEqual({ cleared: false });
        expect(
          clears().map(({ params: sent, idempotencyKey }) => ({
            sent,
            idempotencyKey,
          })),
        ).toEqual([
          {
            sent: params,
            idempotencyKey: boundKey('local-desktop-user', 'clear-key'),
          },
        ]);
        expect(local).not.toHaveBeenCalled();
        expect(clearRoutes()).toEqual({ 'scripts.clear.daemon.served': 1 });
      } finally {
        local.mockRestore();
      }
    },
  );

  it("keeps two principals' clears apart when they reuse a key, and replays a retry", async () => {
    mockPlatform = 'darwin';
    const other: CanopyCallerDescriptor = {
      ...CLEARER,
      principalId: 'remote-user',
      clientInstanceId: 'remote',
    };
    const as = (caller: CanopyCallerDescriptor): Promise<unknown> =>
      runtime.instruction('worker.script.execution.clear', params, {
        caller,
        metadata: { idempotencyKey: 'clear-key' },
      });
    await expect(as(CLEARER)).resolves.toEqual({ cleared: false });
    await expect(as(other)).resolves.toEqual({ cleared: false });
    await expect(as(CLEARER)).resolves.toEqual({ cleared: false });
    expect(clears().map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      boundKey('local-desktop-user', 'clear-key'),
      boundKey('remote-user', 'clear-key'),
    ]);
    expect(boundKey('local-desktop-user', 'clear-key')).not.toBe(
      boundKey('remote-user', 'clear-key'),
    );
  });

  it('replays a same-key clear after the route changes, with nothing cleared again', async () => {
    mockPlatform = 'darwin';
    double.clearResult = { cleared: true };
    const local = jest.spyOn(desktopScriptWorker, 'clear');
    try {
      await expect(clear()).resolves.toEqual({ cleared: true });
      mockLatched = true;
      await expect(clear()).resolves.toEqual({ cleared: true });
      expect(clears()).toHaveLength(1);
      expect(local).not.toHaveBeenCalled();
    } finally {
      local.mockRestore();
    }
  });

  it('refuses a same-key clear with other parameters after the route changes', async () => {
    mockPlatform = 'darwin';
    double.clearResult = { cleared: true };
    const local = jest.spyOn(desktopScriptWorker, 'clear');
    try {
      await expect(clear()).resolves.toEqual({ cleared: true });
      mockLatched = true;
      await expect(
        runtime.instruction(
          'worker.script.execution.clear',
          { ...params, executionId: 'another-run' },
          { caller: CLEARER, metadata: { idempotencyKey: 'clear-key' } },
        ),
      ).rejects.toMatchObject({
        payload: { code: 'worker.script.idempotencyKeyReused' },
      });
      expect(clears()).toHaveLength(1);
      expect(local).not.toHaveBeenCalled();
    } finally {
      local.mockRestore();
    }
  });

  it.each([
    ['on Windows', (): void => void (mockPlatform = 'win32')],
    [
      'while the daemon is latched unreachable',
      (): void => void (mockLatched = true),
    ],
  ])('clears a run in process %s', async (_name, arrange) => {
    arrange();
    const local = jest.spyOn(desktopScriptWorker, 'clear');
    try {
      await expect(clear()).resolves.toEqual({ cleared: false });
      expect(double.calls).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
      expect(local).toHaveBeenCalledTimes(1);
      expect(clearRoutes()).toEqual({ 'scripts.clear.direct': 1 });
    } finally {
      local.mockRestore();
    }
  });

  it('sends a retry after a lost reply again, with the same key', async () => {
    mockPlatform = 'darwin';
    const lost = new Error('gone');
    markUnreachable(lost, 'connection_lost');
    double.clearFailure = lost;
    await expect(clear()).rejects.toMatchObject({
      payload: { kind: 'internal' },
    });
    double.clearFailure = undefined;
    double.clearResult = { cleared: true };
    await expect(clear()).resolves.toEqual({ cleared: true });
    expect(clears().map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      boundKey('local-desktop-user', 'clear-key'),
      boundKey('local-desktop-user', 'clear-key'),
    ]);
  });

  it('a daemon unreachable before the send clears in process and notes the fallback', async () => {
    mockGet.mockRejectedValue(
      markUnreachable(new Error('down'), 'connection_lost'),
    );
    const local = jest.spyOn(desktopScriptWorker, 'clear');
    try {
      await expect(clear()).resolves.toEqual({ cleared: false });
      expect(local).toHaveBeenCalledTimes(1);
      expect(mockNoteFallback).toHaveBeenCalledWith(
        'scripts',
        'connection_lost',
      );
      expect(clearRoutes()).toEqual({ 'scripts.clear.daemon.fallback': 1 });
    } finally {
      local.mockRestore();
    }
  });

  it('a clear lost after the send is the answer, never cleared in process', async () => {
    const lost = new Error('gone');
    markUnreachable(lost, 'connection_lost');
    double.clearFailure = lost;
    const local = jest.spyOn(desktopScriptWorker, 'clear');
    try {
      await expect(clear()).rejects.toMatchObject({
        payload: { kind: 'internal' },
      });
      expect(clears()).toHaveLength(1);
      expect(local).not.toHaveBeenCalled();
      expect(clearRoutes()).toEqual({ 'scripts.clear.daemon.failed': 1 });
    } finally {
      local.mockRestore();
    }
  });
});
