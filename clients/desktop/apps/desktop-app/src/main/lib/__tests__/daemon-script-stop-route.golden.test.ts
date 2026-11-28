// Electron main's worker and a daemon double share one run directory, each with its own fence.
import type * as CorePlatform from '@canopy/core-platform';

const mockGet = jest.fn<Promise<unknown>, [unknown, unknown]>();
let mockLatched = false;
let mockPlatform = 'darwin';
let mockDataRoot = '';
jest.mock('../../canopy-runtime/electron-daemon-access', () => ({
  getElectronDaemonConnections: (): unknown => ({
    get: (caller: unknown, signal: unknown) => mockGet(caller, signal),
  }),
  getElectronDaemonFilesContext: (): Promise<unknown> =>
    Promise.resolve({ authorityId: 'local', canonicalDataRoot: mockDataRoot }),
}));
jest.mock('../../canopy-runtime/electron-daemon-health', () => ({
  getElectronDaemonHealth: (): unknown => ({
    setConsumerEnabled: (): void => undefined,
    isLatched: (): boolean => mockLatched,
    noteFallback: (): void => undefined,
  }),
}));
jest.mock('@canopy/core-platform', () => ({
  ...jest.requireActual<typeof CorePlatform>('@canopy/core-platform'),
  hostPlatformOperatingSystem: (): string => mockPlatform,
}));
jest.mock('../../resource-monitor', () => ({
  getResourceMonitorService: (): unknown => ({
    registerProcess: (): unknown => ({ unregister: (): void => undefined }),
  }),
}));

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CanopyClientError } from '@canopy/core-client';
import { refusingExecutionSecretSource } from '@canopy/core-runtime/node/execution-secrets';
import {
  createWorkerScriptHandlers,
  ScriptExecutionWorker,
  scriptRunFileStem,
  type ScriptRunChild,
  type ScriptRunChildStop,
  type ScriptRunGroupStop,
  type ScriptRunWriterFence,
} from '@canopy/core-runtime/node/script/execution';
import type {
  WorkerScriptExecutionStopParams,
  WorkerScriptExecutionStopResult,
} from '@canopy/protocol/canopy-core';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { createWorkerScriptAdapter } from '../../canopy-runtime/worker-script-adapter';
import { markUnreachable } from '../../canopy-runtime/electron-daemon-connection';
import {
  DAEMON_SCRIPT_STOP_PLATFORMS,
  isDaemonScriptStopPlatform,
} from '../daemon-script-route-context';
import { DAEMON_SCRIPT_PLATFORMS } from '../daemon-script-route';
import { desktopScriptRunWriterFence } from '../script-run-writer-fence';

jest.setTimeout(30_000);

const scope = { workspaceId: 'project', worktreeId: 'task' };
const recorded: ScriptRunChild = {
  pid: 4242,
  processGroupId: 4242,
  startIdentity: 'darwin:v1:4242:1700000000',
  executablePath: '/bin/sh',
};

interface Host {
  readonly fence: ScriptRunWriterFence;
  readonly stopChild: jest.Mock<
    Promise<ScriptRunChildStop>,
    [ScriptRunChild, string]
  >;
  readonly stopGroup: jest.Mock<Promise<ScriptRunGroupStop>, unknown[]>;
}

let runRoot = '';

function host(daemon: boolean): Host {
  const stopChild = jest.fn<
    Promise<ScriptRunChildStop>,
    [ScriptRunChild, string]
  >(() => Promise.resolve('stopped'));
  const stopGroup = jest.fn<Promise<ScriptRunGroupStop>, unknown[]>(() =>
    Promise.resolve({ kind: 'done', outcome: 'stopped', members: [] }),
  );
  const fence: ScriptRunWriterFence = {
    self: () => Promise.resolve(null),
    inspect: () => Promise.resolve('gone'),
    stopChild,
    stopGroup,
    ...(daemon
      ? {
          spawner: 'daemon',
          refusesUnidentifiedStop: true,
          stopOwnership: 'own',
        }
      : { spawner: 'electron' }),
  };
  // Electron main's ownership is the real fence's, read on the mocked platform.
  if (!daemon)
    Object.defineProperty(fence, 'stopOwnership', {
      get: () => desktopScriptRunWriterFence.stopOwnership,
    });
  return { fence, stopChild, stopGroup };
}

function worker(fence: ScriptRunWriterFence): ScriptExecutionWorker {
  const unused = (): never => {
    throw new Error('Not used by Stop.');
  };
  return new ScriptExecutionWorker({
    secrets: refusingExecutionSecretSource,
    authorityId: 'local',
    platform: (): string => process.platform,
    findExecutable: (): null => null,
    windowsGitBash: (): null => null,
    cmdCommandLine: (script): string => script,
    loginShell: (): string => '/bin/sh',
    comSpec: (): undefined => undefined,
    prepareLaunch: (command, args): { command: string; args: string[] } => ({
      command,
      args,
    }),
    lowerPriority: (): void => undefined,
    spawn: unused,
    drainOwnedProcess: (): Promise<void> => Promise.resolve(),
    logPaths: {
      runDir: (projectId, worktreeId): string =>
        join(runRoot, projectId, worktreeId),
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
    writerFence: fence,
    resolvePlace: unused,
  });
}

function metaPath(): string {
  return join(runRoot, 'project', 'task', `${scriptRunFileStem('dev')}.json`);
}

async function readRaw(): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(metaPath(), 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Unreadable metadata.');
  return Object.fromEntries(Object.entries(value));
}

async function orphanBy(spawner: string | undefined): Promise<string> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  await mkdir(dirname(metaPath()), { recursive: true });
  await writeFile(
    metaPath(),
    JSON.stringify({
      version: 1,
      runId,
      script: {
        scriptKey: 'dev',
        scriptName: 'dev',
        label: 'Dev',
        command: 'sleep 60',
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
      instanceId: 'an-earlier-instance',
      child: recorded,
      orphaned: true,
      ...(spawner !== undefined ? { spawner } : {}),
    }),
    'utf8',
  );
  return runId;
}

interface DaemonCall {
  readonly name: string;
  readonly params: unknown;
  readonly idempotencyKey: string | undefined;
}

// `drop`: the daemon acts, then the session aborts and rejects, as a lost reply.
function daemonDouble(daemon: ScriptExecutionWorker): {
  readonly calls: DaemonCall[];
  session(options?: { readonly drop?: boolean }): unknown;
} {
  const handlers = createWorkerScriptHandlers(daemon, { detached: true });
  const calls: DaemonCall[] = [];
  return {
    calls,
    session: (options = {}) => {
      const lifetime = new AbortController();
      return {
        signal: lifetime.signal,
        instruction: async (
          name: string,
          params: unknown,
          instruction: {
            readonly metadata?: { readonly idempotencyKey?: string };
          } = {},
        ): Promise<unknown> => {
          calls.push({
            name,
            params,
            idempotencyKey: instruction.metadata?.idempotencyKey,
          });
          if (name !== 'worker.script.execution.stop')
            throw new Error(`Unexpected ${name}`);
          let answer: WorkerScriptExecutionStopResult;
          try {
            answer = await handlers.instructions[
              'worker.script.execution.stop'
            ](params as WorkerScriptExecutionStopParams, {
              requestId: randomUUID(),
              caller: {
                principalId: 'local-desktop-user',
                clientInstanceId: 'electron-main:scripts',
                authorityId: 'local',
                interfaceKind: 'desktop',
                grants: ['worker.script.execute', 'worker.script.read'],
              },
              metadata: {
                idempotencyKey: instruction.metadata?.idempotencyKey,
              },
              signal: new AbortController().signal,
            });
          } catch (error) {
            const payload = (error as { payload?: unknown }).payload;
            throw payload === undefined
              ? error
              : new CanopyClientError(
                  payload as ConstructorParameters<typeof CanopyClientError>[0],
                );
          }
          if (options.drop) {
            lifetime.abort();
            throw markUnreachable(new Error('closed'), 'connection_lost');
          }
          return answer;
        },
      };
    },
  };
}

type Registration = (lease: unknown, client: unknown) => unknown;

// A session whose lease is live on `client`: it issues each registration at once.
function live(client: unknown): unknown {
  return {
    signal: new AbortController().signal,
    client,
    lease: {
      state: 'active',
      register: (_key: string, issue: Registration): (() => void) => {
        void issue({ leaseId: 'lease' }, client);
        return () => undefined;
      },
    },
  };
}

// A session reused while its lease reconnects: its client throws until
// `attach`, which issues the registrations on the replacement client.
function reconnecting(
  replacement: unknown,
  signal = new AbortController().signal,
): { readonly session: unknown; readonly attach: () => void } {
  let attached = false;
  const waiting: Registration[] = [];
  return {
    session: {
      signal,
      get client(): unknown {
        if (!attached)
          throw markUnreachable(new Error('closed'), 'connection_lost');
        return replacement;
      },
      lease: {
        get state(): string {
          return attached ? 'active' : 'reconnecting';
        },
        register: (_key: string, issue: Registration): (() => void) => {
          if (attached) void issue({ leaseId: 'replacement' }, replacement);
          else waiting.push(issue);
          return () => {
            const at = waiting.indexOf(issue);
            if (at !== -1) waiting.splice(at, 1);
          };
        },
      },
    },
    attach: () => {
      attached = true;
      for (const issue of waiting.splice(0))
        void issue({ leaseId: 'replacement' }, replacement);
    },
  };
}

// The `scripts.stop` route counts recorded since the last reset.
function stopRoutes(): Record<string, number> {
  return Object.fromEntries(
    Object.entries(snapshotWorkCounters().route).filter(([key]) =>
      key.startsWith('scripts.stop.'),
    ),
  );
}

function stopParams(
  runId: string,
  extra: Partial<WorkerScriptExecutionStopParams> = {},
): WorkerScriptExecutionStopParams {
  return {
    scope,
    scriptKey: 'dev',
    executionId: runId,
    mode: 'stop',
    ...extra,
  };
}

let mainHost: Host;
let daemonHost: Host;
let double: ReturnType<typeof daemonDouble>;
let adapter: ReturnType<typeof createWorkerScriptAdapter>;

function stop(
  params: WorkerScriptExecutionStopParams,
  idempotencyKey = randomUUID(),
): Promise<WorkerScriptExecutionStopResult> {
  return Promise.resolve(
    adapter.instructions['worker.script.execution.stop'](params, {
      requestId: randomUUID(),
      caller: {
        principalId: 'local-desktop-user',
        clientInstanceId: 'renderer',
        authorityId: 'local',
        interfaceKind: 'desktop',
        grants: ['worker.script.execute'],
      },
      metadata: { idempotencyKey },
      signal: new AbortController().signal,
    }),
  );
}

beforeEach(() => {
  runRoot = mkdtempSync(join(tmpdir(), 'daemon-script-stop-route-'));
  mockDataRoot = runRoot;
  mockPlatform = 'darwin';
  mockLatched = false;
  mainHost = host(false);
  daemonHost = host(true);
  const mainWorker = worker(mainHost.fence);
  double = daemonDouble(worker(daemonHost.fence));
  mockGet.mockReset();
  mockGet.mockImplementation(() =>
    Promise.resolve({ client: double.session() }),
  );
  resetWorkCounters();
  adapter = createWorkerScriptAdapter(() => Promise.resolve(mainWorker));
});

afterEach(() => {
  rmSync(runRoot, { recursive: true, force: true });
});

describe('an orphaned run stops on the host that started it (CAN-7586)', () => {
  it('sends a Stop of a run the daemon started to the daemon on darwin and linux; Electron main signals nothing', async () => {
    for (const platform of ['darwin', 'linux']) {
      mockPlatform = platform;
      const runId = await orphanBy('daemon');
      const key = randomUUID();
      await expect(stop(stopParams(runId), key)).resolves.toEqual({
        outcome: 'stopped',
      });
      expect(mainHost.stopChild).not.toHaveBeenCalled();
      expect(double.calls.at(-1)).toEqual({
        name: 'worker.script.execution.stop',
        params: stopParams(runId),
        idempotencyKey: key,
      });
    }
    expect(daemonHost.stopChild).toHaveBeenCalledTimes(2);
    expect(stopRoutes()).toEqual({ 'scripts.stop.daemon.served': 2 });
  });

  it('keeps a Stop of a run Electron main started, or of an earlier record, in process; the daemon is not called', async () => {
    for (const spawner of ['electron', undefined]) {
      const runId = await orphanBy(spawner);
      await expect(stop(stopParams(runId))).resolves.toEqual({
        outcome: 'stopped',
      });
    }
    expect(mainHost.stopChild).toHaveBeenCalledTimes(2);
    expect(mockGet).not.toHaveBeenCalled();
    expect(daemonHost.stopChild).not.toHaveBeenCalled();
    expect(stopRoutes()).toEqual({ 'scripts.stop.direct': 2 });
  });

  it('refuses in process a run naming a host this version does not know, signalling nothing', async () => {
    const runId = await orphanBy('future-host');
    await expect(stop(stopParams(runId))).rejects.toMatchObject({
      payload: { code: 'worker.script.notOwner' },
    });
    expect(mainHost.stopChild).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(stopRoutes()).toEqual({ 'scripts.stop.direct': 1 });
  });

  it("refuses a daemon-started run's Stop as daemonUnavailable when the daemon can't be reached, signalling nothing in process", async () => {
    const runId = await orphanBy('daemon');
    mockLatched = true;
    await expect(stop(stopParams(runId))).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'worker.script.daemonUnavailable',
        retry: { kind: 'same_idempotency_key' },
      },
    });
    mockLatched = false;
    mockGet.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(stop(stopParams(runId))).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'worker.script.daemonUnavailable',
        retry: { kind: 'same_idempotency_key' },
      },
    });
    expect(mainHost.stopChild).not.toHaveBeenCalled();
    expect(daemonHost.stopChild).not.toHaveBeenCalled();
    expect(await readRaw()).toMatchObject({
      status: 'running',
      orphaned: true,
    });
    expect(stopRoutes()).toEqual({ 'scripts.stop.daemon.unavailable': 2 });
  });

  it('reads a reused PID through the route as not_same and records the run lost', async () => {
    const runId = await orphanBy('daemon');
    daemonHost.stopChild.mockResolvedValueOnce('not_same');
    await expect(stop(stopParams(runId))).resolves.toEqual({
      outcome: 'not_same',
    });
    expect(await readRaw()).toMatchObject({
      status: 'failed',
      outcome: 'lost',
    });
    expect(mainHost.stopChild).not.toHaveBeenCalled();
    expect(stopRoutes()).toEqual({ 'scripts.stop.daemon.served': 1 });
  });

  it("passes the daemon's refusals and a group Force stop through unchanged", async () => {
    let runId = await orphanBy('daemon');
    // `force` without the user's confirmation: the daemon refuses it.
    await expect(
      stop(stopParams(runId, { mode: 'force' })),
    ).rejects.toMatchObject({
      payload: { code: 'worker.script.confirmationRequired' },
    });
    // The run changed after main routed it: the daemon's notOrphaned.
    mockGet.mockImplementationOnce(async () => {
      const raw = await readRaw();
      await writeFile(metaPath(), JSON.stringify({ ...raw, runId: 'newer' }));
      return { client: double.session() };
    });
    await expect(stop(stopParams(runId))).rejects.toMatchObject({
      payload: { code: 'worker.script.notOrphaned' },
    });
    expect(daemonHost.stopChild).not.toHaveBeenCalled();
    runId = await orphanBy('daemon');
    const members = [{ pid: 4243, startIdentity: 'member' }];
    const group = stopParams(runId, {
      mode: 'force_group',
      confirmed: true,
      members,
    });
    await expect(stop(group)).resolves.toEqual({
      outcome: 'stopped',
      members: [],
    });
    expect(double.calls.at(-1)?.params).toEqual(group);
    expect(daemonHost.stopGroup).toHaveBeenCalledWith(
      recorded,
      expect.any(Number),
      runId,
      members,
    );
    expect(mainHost.stopGroup).not.toHaveBeenCalled();
    expect(stopRoutes()).toEqual({
      'scripts.stop.daemon.refused': 2,
      'scripts.stop.daemon.served': 1,
    });
  });

  it('resends a Stop whose reply was lost once, with the same key, and gets the replayed outcome', async () => {
    const runId = await orphanBy('daemon');
    mockGet
      .mockImplementationOnce(() =>
        Promise.resolve({ client: double.session({ drop: true }) }),
      )
      .mockImplementationOnce(() => Promise.resolve(live(double.session())));
    const key = randomUUID();
    await expect(stop(stopParams(runId), key)).resolves.toEqual({
      outcome: 'stopped',
    });
    expect(double.calls.map((call) => call.idempotencyKey)).toEqual([key, key]);
    // The resend replayed the first settlement; the daemon stopped once.
    expect(daemonHost.stopChild).toHaveBeenCalledTimes(1);
    expect(mainHost.stopChild).not.toHaveBeenCalled();
    expect(stopRoutes()).toEqual({ 'scripts.stop.daemon.served': 1 });
  });

  it('waits for a reconnecting session before the same-key resend', async () => {
    const runId = await orphanBy('daemon');
    const replacement = reconnecting(double.session());
    mockGet
      .mockImplementationOnce(() =>
        Promise.resolve({ client: double.session({ drop: true }) }),
      )
      .mockImplementationOnce(() => {
        setTimeout(replacement.attach, 50);
        return Promise.resolve(replacement.session);
      });
    const key = randomUUID();
    await expect(stop(stopParams(runId), key)).resolves.toEqual({
      outcome: 'stopped',
    });
    expect(double.calls.map((call) => call.idempotencyKey)).toEqual([key, key]);
    expect(daemonHost.stopChild).toHaveBeenCalledTimes(1);
    expect(mainHost.stopChild).not.toHaveBeenCalled();
    expect(stopRoutes()).toEqual({ 'scripts.stop.daemon.served': 1 });
  });

  it('answers outcomeUnknown when the session ends before it reconnects', async () => {
    const runId = await orphanBy('daemon');
    const lifetime = new AbortController();
    const replacement = reconnecting(double.session(), lifetime.signal);
    mockGet
      .mockImplementationOnce(() =>
        Promise.resolve({ client: double.session({ drop: true }) }),
      )
      .mockImplementationOnce(() => {
        setTimeout(() => lifetime.abort(), 50);
        return Promise.resolve(replacement.session);
      });
    await expect(stop(stopParams(runId))).rejects.toMatchObject({
      payload: { code: 'worker.script.outcomeUnknown' },
    });
    expect(double.calls).toHaveLength(1);
    expect(mainHost.stopChild).not.toHaveBeenCalled();
    expect(stopRoutes()).toEqual({ 'scripts.stop.daemon.outcomeUnknown': 1 });
  });

  it('answers outcomeUnknown, never still_running, when the reply is lost twice', async () => {
    const runId = await orphanBy('daemon');
    mockGet.mockImplementation(() =>
      Promise.resolve(live(double.session({ drop: true }))),
    );
    await expect(stop(stopParams(runId))).rejects.toMatchObject({
      payload: { code: 'worker.script.outcomeUnknown' },
    });
    expect(double.calls).toHaveLength(2);
    expect(daemonHost.stopChild).toHaveBeenCalledTimes(1);
    expect(mainHost.stopChild).not.toHaveBeenCalled();
    expect(stopRoutes()).toEqual({ 'scripts.stop.daemon.outcomeUnknown': 1 });
  });

  it('replays a repeated Stop with the same key after the daemon stopped the run, asking neither host again', async () => {
    const runId = await orphanBy('daemon');
    const key = randomUUID();
    await expect(stop(stopParams(runId), key)).resolves.toEqual({
      outcome: 'stopped',
    });
    await expect(stop(stopParams(runId), key)).resolves.toEqual({
      outcome: 'stopped',
    });
    expect(double.calls).toHaveLength(1);
    expect(daemonHost.stopChild).toHaveBeenCalledTimes(1);
    expect(mainHost.stopChild).not.toHaveBeenCalled();
    expect(stopRoutes()).toEqual({ 'scripts.stop.daemon.served': 1 });
  });

  it('keeps no refusal, so the same key is tried again once the daemon is back', async () => {
    const runId = await orphanBy('daemon');
    const key = randomUUID();
    mockLatched = true;
    await expect(stop(stopParams(runId), key)).rejects.toMatchObject({
      payload: { code: 'worker.script.daemonUnavailable' },
    });
    mockLatched = false;
    await expect(stop(stopParams(runId), key)).resolves.toEqual({
      outcome: 'stopped',
    });
    expect(daemonHost.stopChild).toHaveBeenCalledTimes(1);
    expect(mainHost.stopChild).not.toHaveBeenCalled();
    expect(stopRoutes()).toEqual({
      'scripts.stop.daemon.unavailable': 1,
      'scripts.stop.daemon.served': 1,
    });
  });

  it('keeps every Stop in process on win32, with its own stop gate', async () => {
    expect(DAEMON_SCRIPT_PLATFORMS.win32).toBe(true);
    expect(DAEMON_SCRIPT_STOP_PLATFORMS).toEqual({
      darwin: true,
      linux: true,
      win32: false,
    });
    expect(isDaemonScriptStopPlatform('win32')).toBe(false);
    mockPlatform = 'win32';
    const runId = await orphanBy('daemon');
    await expect(stop(stopParams(runId))).resolves.toEqual({
      outcome: 'stopped',
    });
    // Electron main's own confirmed Stop on Windows, unchanged.
    expect(mainHost.stopChild).toHaveBeenCalledTimes(1);
    expect(mockGet).not.toHaveBeenCalled();
    expect(stopRoutes()).toEqual({ 'scripts.stop.direct': 1 });
  });
});
