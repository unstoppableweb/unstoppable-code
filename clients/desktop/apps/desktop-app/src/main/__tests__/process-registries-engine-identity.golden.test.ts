import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * CAN-6995 S5a-2: the PID registries moved to the execution engine behind a
 * store port and a kill port. Through Electron main's adapters they still
 * write the same files, named by the same path helpers, in the same format,
 * and the Codex registry still kills through Electron main's process-group
 * kill. An engine registry nothing has bound refuses instead of choosing.
 */

let dataRoot = '';

jest.mock('../lib/paths', () => ({
  getClaudeProcessPidsFilePath: (): string =>
    join(dataRoot, 'claude-process-pids.json'),
  getCodexAppServerPidsFilePath: (): string =>
    join(dataRoot, 'codex-app-server-pids.json'),
}));

const killChildProcessGroup = jest.fn<void, [ChildProcess, NodeJS.Signals]>();
jest.mock('../lib/process-kill', () => ({
  killChildProcessGroup: (
    child: ChildProcess,
    signal: NodeJS.Signals,
  ): void => {
    killChildProcessGroup(child, signal);
  },
}));

const mockWrites: Array<{ file: string; text: string }> = [];
jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    writeFile: async (
      ...args: Parameters<typeof actual.writeFile>
    ): Promise<void> => {
      const [file, data] = args;
      if (typeof file === 'string' && typeof data === 'string')
        mockWrites.push({ file, text: data });
      await actual.writeFile(...args);
    },
  };
});

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { pid, exitCode: null, signalCode: null });
  return child;
}

describe('PID registries through Electron main after the engine move (CAN-6995 S5a-2)', () => {
  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'pid-reg-'));
    killChildProcessGroup.mockReset();
    jest.resetModules();
  });
  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('writes the Claude PID file at the same path helper, in the same format', async () => {
    const registry = await import('../agents/claude-process-registry');
    registry.enableClaudeProcessPidPersistence();
    registry.registerHostedClaudeProcess({
      pid: 4242,
      startedAtMs: 1_700_000_000_000,
      executable: '/usr/local/bin/claude',
      sessionKey: 'session-1',
    });
    await registry.flushClaudeProcessPidPersistenceForTests();
    const text = await readFile(
      join(dataRoot, 'claude-process-pids.json'),
      'utf8',
    );
    expect(JSON.parse(text)).toEqual({
      version: 1,
      processes: [
        {
          pid: 4242,
          startedAtMs: 1_700_000_000_000,
          executable: '/usr/local/bin/claude',
          sessionKey: 'session-1',
        },
      ],
    });
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
    registry.resetClaudeProcessRegistryForTests();
  });

  it('writes the Codex PID file at the same path helper and kills through Electron main', async () => {
    const registry = await import('../codex/app-server-process-registry');
    registry.enableCodexAppServerPidPersistence();
    const child = fakeChild(5151);
    registry.registerCodexAppServerProcess(child);
    await registry.flushCodexAppServerPidPersistenceForTests();
    const text = await readFile(
      join(dataRoot, 'codex-app-server-pids.json'),
      'utf8',
    );
    expect(JSON.parse(text)).toEqual({ version: 1, pids: [5151] });
    expect(text).toBe(JSON.stringify({ version: 1, pids: [5151] }, null, 2));

    await registry.terminateAllCodexAppServerProcesses(0);
    expect(killChildProcessGroup.mock.calls).toEqual([
      [child, 'SIGTERM'],
      [child, 'SIGKILL'],
    ]);
    registry.resetCodexAppServerProcessRegistryForTests();
  });

  it('makes the same PID-file writes, in the same order, through the adapters', async () => {
    mockWrites.length = 0;
    const claude = await import('../agents/claude-process-registry');
    const codex = await import('../codex/app-server-process-registry');
    claude.enableClaudeProcessPidPersistence();
    codex.enableCodexAppServerPidPersistence();
    const claudeFile = join(dataRoot, 'claude-process-pids.json');
    const codexFile = join(dataRoot, 'codex-app-server-pids.json');
    const base = { startedAtMs: 1_700_000_000_000, executable: '/bin/claude' };
    const claudeText = (processes: object[]): string =>
      JSON.stringify({ version: 1, processes }, null, 2);
    const codexText = (pids: number[]): string =>
      JSON.stringify({ version: 1, pids }, null, 2);

    // register, update, register, unregister
    claude.registerHostedClaudeProcess({ pid: 31, ...base, sessionKey: 'a' });
    await claude.flushClaudeProcessPidPersistenceForTests();
    claude.registerHostedClaudeProcess({ pid: 31, ...base, sessionKey: 'b' });
    await claude.flushClaudeProcessPidPersistenceForTests();
    claude.registerHostedClaudeProcess({ pid: 32, ...base });
    await claude.flushClaudeProcessPidPersistenceForTests();
    claude.unregisterHostedClaudeProcess(31);
    await claude.flushClaudeProcessPidPersistenceForTests();

    // register, register, unregister, terminateAll, then the exit's unregister
    const first = fakeChild(41);
    const second = fakeChild(42);
    codex.registerCodexAppServerProcess(first);
    await codex.flushCodexAppServerPidPersistenceForTests();
    codex.registerCodexAppServerProcess(second);
    await codex.flushCodexAppServerPidPersistenceForTests();
    codex.unregisterCodexAppServerProcess(first);
    await codex.flushCodexAppServerPidPersistenceForTests();
    await codex.terminateAllCodexAppServerProcesses(0);
    await codex.flushCodexAppServerPidPersistenceForTests();
    codex.unregisterCodexAppServerProcess(second);
    await codex.flushCodexAppServerPidPersistenceForTests();

    expect(mockWrites).toEqual([
      {
        file: claudeFile,
        text: claudeText([{ pid: 31, ...base, sessionKey: 'a' }]),
      },
      {
        file: claudeFile,
        text: claudeText([{ pid: 31, ...base, sessionKey: 'b' }]),
      },
      {
        file: claudeFile,
        text: claudeText([
          { pid: 31, ...base, sessionKey: 'b' },
          { pid: 32, ...base },
        ]),
      },
      { file: claudeFile, text: claudeText([{ pid: 32, ...base }]) },
      { file: codexFile, text: codexText([41]) },
      { file: codexFile, text: codexText([41, 42]) },
      { file: codexFile, text: codexText([42]) },
      { file: codexFile, text: codexText([]) },
    ]);
    expect(killChildProcessGroup.mock.calls).toEqual([
      [second, 'SIGTERM'],
      [second, 'SIGKILL'],
    ]);
    claude.resetClaudeProcessRegistryForTests();
    codex.resetCodexAppServerProcessRegistryForTests();
  });

  it('rewrites each PID file after every register and unregister, in order', async () => {
    const claude = await import('../agents/claude-process-registry');
    const codex = await import('../codex/app-server-process-registry');
    claude.enableClaudeProcessPidPersistence();
    codex.enableCodexAppServerPidPersistence();
    const claudeFile = join(dataRoot, 'claude-process-pids.json');
    const codexFile = join(dataRoot, 'codex-app-server-pids.json');
    const snapshot = async (file: string): Promise<unknown> => {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      return parsed;
    };
    const record = (
      pid: number,
    ): { pid: number; startedAtMs: number; executable: string } => ({
      pid,
      startedAtMs: 1_700_000_000_000,
      executable: '/usr/local/bin/claude',
    });

    const claudeSeen: unknown[] = [];
    claude.registerHostedClaudeProcess(record(11));
    await claude.flushClaudeProcessPidPersistenceForTests();
    claudeSeen.push(await snapshot(claudeFile));
    claude.registerHostedClaudeProcess(record(12));
    await claude.flushClaudeProcessPidPersistenceForTests();
    claudeSeen.push(await snapshot(claudeFile));
    claude.unregisterHostedClaudeProcess(11);
    await claude.flushClaudeProcessPidPersistenceForTests();
    claudeSeen.push(await snapshot(claudeFile));
    expect(claudeSeen).toEqual([
      { version: 1, processes: [record(11)] },
      { version: 1, processes: [record(11), record(12)] },
      { version: 1, processes: [record(12)] },
    ]);

    const first = fakeChild(21);
    const second = fakeChild(22);
    const codexSeen: unknown[] = [];
    codex.registerCodexAppServerProcess(first);
    await codex.flushCodexAppServerPidPersistenceForTests();
    codexSeen.push(await snapshot(codexFile));
    codex.registerCodexAppServerProcess(second);
    await codex.flushCodexAppServerPidPersistenceForTests();
    codexSeen.push(await snapshot(codexFile));
    codex.unregisterCodexAppServerProcess(first);
    await codex.flushCodexAppServerPidPersistenceForTests();
    codexSeen.push(await snapshot(codexFile));
    expect(codexSeen).toEqual([
      { version: 1, pids: [21] },
      { version: 1, pids: [21, 22] },
      { version: 1, pids: [22] },
    ]);
    claude.resetClaudeProcessRegistryForTests();
    codex.resetCodexAppServerProcessRegistryForTests();
  });

  it('kills a hosted Claude CLI through Electron main, SIGTERM then the SIGKILL escalation', async () => {
    const worker = await import('../agents/claude-process-host-worker');
    const listeners: Array<(event: unknown) => void> = [];
    const posted: Array<{ type: string; requestId?: string }> = [];
    const channel = {
      postMessage: (message: { type: string; requestId?: string }): void => {
        posted.push(message);
      },
      on: (event: string, listener: (event: unknown) => void): void => {
        if (event === 'message') listeners.push(listener);
      },
    };
    const send = (message: unknown): void => {
      for (const listener of listeners) listener({ data: message });
    };
    const host = worker.startClaudeProcessHost(
      channel as unknown as Parameters<typeof worker.startClaudeProcessHost>[0],
      () => undefined,
    );
    send({
      type: 'spawn',
      requestId: 'cli-1',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: dataRoot,
      env: { PATH: process.env.PATH },
    });
    const started = (): boolean =>
      posted.some((message) => message.type === 'started');
    for (let i = 0; i < 200 && !started(); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started()).toBe(true);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      send({ type: 'kill', requestId: 'cli-1', signal: 'SIGTERM' });
      expect(
        killChildProcessGroup.mock.calls.map(([, signal]) => signal),
      ).toEqual(['SIGTERM']);
      jest.advanceTimersByTime(4_999);
      expect(killChildProcessGroup).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(
        killChildProcessGroup.mock.calls.map(([, signal]) => signal),
      ).toEqual(['SIGTERM', 'SIGKILL']);
      const [[child]] = killChildProcessGroup.mock.calls;
      expect(killChildProcessGroup.mock.calls[1]?.[0]).toBe(child);
      child.kill('SIGKILL');
    } finally {
      jest.useRealTimers();
    }
    await host.shutdown();
  });

  it('refuses persistence from an engine registry nothing has bound', async () => {
    const claude =
      await import('@canopy/execution-engine/node/agent-host/process/claude-process-registry');
    const codex =
      await import('@canopy/execution-engine/node/agent-host/process/codex-app-server-process-registry');
    expect(() => claude.enableClaudeProcessPidPersistence()).toThrow(
      'The Claude process registry has no PID file store bound.',
    );
    expect(() => codex.enableCodexAppServerPidPersistence()).toThrow(
      'The Codex app-server registry has no host bound.',
    );
  });
});
