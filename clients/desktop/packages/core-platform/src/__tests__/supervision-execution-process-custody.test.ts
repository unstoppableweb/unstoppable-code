import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type * as Runtime from '@canopy/core-runtime';
import {
  createExecutionProcessServices,
  type ExecutionProcessOperations,
} from '../supervision/execution-process';
import {
  NODE_SUPERVISION,
  type SupervisionOperations,
} from '../supervision/shared';

// Controlled custody: a fake spawn, fake group signals and a fake owned-child
// addon, so each OS backend's decisions run on any host.

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = jest.fn((signal?: NodeJS.Signals) => {
    setImmediate(() => this.exit(null, signal ?? 'SIGTERM'));
    return true;
  });
  constructor(readonly pid: number | undefined) {
    super();
  }
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
  }
}

const err = (code: string): Error => Object.assign(new Error(code), { code });

interface Harness {
  readonly services: Runtime.PlatformExecutionProcessServices;
  readonly spawned: FakeChild[];
  readonly spawn: jest.Mock;
  readonly kills: [number, string | number][];
}

function harness(
  os: Runtime.PlatformOperatingSystem,
  options: {
    nativePath?: string;
    /** Answers group signals; default: present until SIGKILL. */
    kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => void;
    spawnPid?: number | undefined;
    timing?: Partial<ExecutionProcessOperations>;
  } = {},
): Harness {
  const spawned: FakeChild[] = [];
  const kills: [number, string | number][] = [];
  let gone = false;
  const supervision: SupervisionOperations = {
    ...NODE_SUPERVISION,
    kill:
      options.kill ??
      ((pid, signal): void => {
        kills.push([pid, signal]);
        if (signal === 'SIGKILL') gone = true;
        if (gone && signal === 0) throw err('ESRCH');
      }),
  };
  const spawn = jest.fn<
    ChildProcess,
    [string, readonly string[], SpawnOptions]
  >(() => {
    const child = new FakeChild(
      'spawnPid' in options ? options.spawnPid : 4000 + spawned.length,
    );
    spawned.push(child);
    setImmediate(() =>
      child.pid === undefined
        ? child.emit('error', err('ENOENT'))
        : child.emit('spawn'),
    );
    // The fake stands in for Node's ChildProcess at this seam only.
    return child as unknown as ChildProcess;
  });
  const services = createExecutionProcessServices(
    { os, nativePath: options.nativePath },
    {
      spawn,
      supervision,
      graceMs: 50,
      cleanupMs: 50,
      pollMs: 1,
      survivorPollMs: 5,
      ...options.timing,
    },
  );
  return { services, spawned, spawn, kills };
}

const POSIX_REQUEST: Runtime.PlatformExecutionRequest = {
  executable: '/usr/bin/tool',
  args: ['--flag'],
  cwd: '/work',
  environment: { PATH: '/usr/bin:/bin' },
};

const WINDOWS_REQUEST: Runtime.PlatformExecutionRequest = {
  executable: 'C:\\tools\\tool.exe',
  args: [],
  cwd: 'C:\\work',
  environment: { SystemRoot: 'C:\\Windows' },
};

async function rejection(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const typed = (code: string): unknown =>
  expect.objectContaining({ name: 'ExecutionProcessError', code });

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const exitListeners = new Set<(...args: never[]) => void>();
beforeEach(() => {
  process.listeners('exit').forEach((listener) => exitListeners.add(listener));
});
afterEach(() => {
  process.listeners('exit').forEach((listener) => {
    if (!exitListeners.has(listener)) process.removeListener('exit', listener);
  });
  exitListeners.clear();
  jest.restoreAllMocks();
});
const runHostExit = (): void =>
  process
    .listeners('exit')
    .filter((listener) => !exitListeners.has(listener))
    .forEach((listener) => listener(0));

describe.each<Runtime.PlatformOperatingSystem>(['darwin', 'linux'])(
  '%s process-group custody',
  (os) => {
    it('spawns a detached group leader with exactly the requested environment', async () => {
      const h = harness(os);
      await h.services.start({ ...POSIX_REQUEST, stdin: 'pipe' });
      expect(h.spawn).toHaveBeenCalledWith('/usr/bin/tool', ['--flag'], {
        detached: true,
        windowsHide: false,
        cwd: '/work',
        env: { PATH: '/usr/bin:/bin' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    });

    it('observes root exit before stream EOF without changing the credited outcome', async () => {
      const observe = jest.fn<
        void,
        Parameters<NonNullable<ExecutionProcessOperations['onRootTreeEmpty']>>
      >(() => {
        throw new Error('observer failure must not affect execution');
      });
      const h = harness(os, { timing: { onRootTreeEmpty: observe } });
      const child = await h.services.start(POSIX_REQUEST);
      const settled = jest.fn<void, [Runtime.PlatformExecutionOutcome]>();
      void child.outcome.then(settled);
      try {
        // Unlike FakeChild.exit(), this leaves both credited streams open.
        h.spawned[0].emit('exit', 7, null);
        await tick();
        expect(observe).toHaveBeenCalledTimes(1);
        expect(observe).toHaveBeenCalledWith(false, {
          kind: 'exited',
          code: 7,
          signal: null,
        });
        expect(settled).not.toHaveBeenCalled();
        h.spawned[0].stdout.end();
        h.spawned[0].stderr.end();
        expect(await child.stdout.read()).toBeNull();
        expect(await child.stderr?.read()).toBeNull();
        await expect(child.outcome).resolves.toEqual({
          kind: 'exited',
          code: 7,
          signal: null,
          output: 'complete',
        });
      } finally {
        await h.services.shutdown();
      }
    });

    it('sends TERM to the group, then KILL after the grace, until it is empty', async () => {
      const h = harness(os);
      const child = await h.services.start(POSIX_REQUEST);
      const pid = h.spawned[0].pid ?? 0;
      await child.terminate();
      const signals = h.kills.map(([target, signal]) => {
        expect(target).toBe(-pid);
        return signal;
      });
      expect(signals[0]).toBe(0);
      expect(signals).toContain('SIGTERM');
      expect(signals.indexOf('SIGTERM')).toBeLessThan(
        signals.indexOf('SIGKILL'),
      );
      expect(signals.at(-1)).toBe(0);
      // Custody ended: a later terminate signals nothing.
      const count = h.kills.length;
      await child.terminate({ mode: 'force' });
      expect(h.kills).toHaveLength(count);
    });

    it('gives a KILL sent by a late poll its probes and its whole cleanup window', async () => {
      // A loaded host resumes the poll after the grace and the cleanup window
      // have both passed. The group outlives the first probe after the KILL.
      let lag = 0;
      const now = performance.now.bind(performance);
      jest.spyOn(performance, 'now').mockImplementation(() => now() + lag);
      let probesAfterKill = -1;
      const h = harness(os, {
        timing: { cleanupMs: 10_000 },
        kill: (pid, signal) => {
          h.kills.push([pid, signal]);
          if (signal === 'SIGTERM') lag += 60_000;
          if (signal === 'SIGKILL')
            probesAfterKill = Math.max(probesAfterKill, 0);
          if (signal === 0 && probesAfterKill >= 0 && ++probesAfterKill > 1)
            throw err('ESRCH');
        },
      });
      const child = await h.services.start(POSIX_REQUEST);
      await expect(child.terminate()).resolves.toBeUndefined();
      expect(h.kills.map(([, signal]) => signal).slice(-2)).toEqual([
        'SIGKILL',
        0,
      ]);
    });

    it('counts an EPERM group as present and reports lost cleanup as the outcome', async () => {
      const kills: [number, string | number][] = [];
      const h = harness(os, {
        kill: (pid, signal) => {
          kills.push([pid, signal]);
          throw err('EPERM');
        },
      });
      const child = await h.services.start(POSIX_REQUEST);
      expect(await rejection(() => child.terminate({ mode: 'force' }))).toEqual(
        typed('unavailable'),
      );
      await expect(child.outcome).resolves.toEqual({
        kind: 'lost',
        code: null,
        signal: null,
        output: 'discarded',
      });
      // Every KILL is probed before custody is given up.
      kills.forEach(([, signal], index) => {
        if (signal === 'SIGKILL') expect(kills[index + 1]?.[1]).toBe(0);
      });
      expect(kills.at(-1)?.[1]).toBe(0);
    });

    it('never signals a group once a probe found it empty', async () => {
      const h = harness(os, {
        kill: (pid, signal) => {
          h.kills.push([pid, signal]);
          if (signal === 0) throw err('ESRCH');
        },
      });
      const child = await h.services.start(POSIX_REQUEST);
      h.spawned[0].exit(0, null);
      await expect(child.outcome).resolves.toMatchObject({ kind: 'exited' });
      await child.terminate();
      runHostExit();
      expect(h.kills.map(([, signal]) => signal)).toEqual([0]);
    });

    it('rechecks survivors of an exited root and releases them when gone', async () => {
      let members = true;
      const h = harness(os, {
        kill: (pid, signal) => {
          h.kills.push([pid, signal]);
          if (signal === 0 && !members) throw err('ESRCH');
        },
      });
      await h.services.start(POSIX_REQUEST);
      h.spawned[0].exit(0, null);
      await tick();
      members = false;
      await new Promise((resolve) => setTimeout(resolve, 30));
      const probes = h.kills.length;
      await h.services.shutdown();
      runHostExit();
      expect(h.kills).toHaveLength(probes);
      expect(h.kills.every(([, signal]) => signal === 0)).toBe(true);
    });

    it('stops a tree whose start a shutdown overtook', async () => {
      const h = harness(os);
      const starting = h.services.start(POSIX_REQUEST);
      await h.services.shutdown();
      const group = -(h.spawned[0].pid ?? 0);
      expect(h.kills).toContainEqual([group, 'SIGKILL']);
      const child = await starting;
      h.spawned[0].exit(null, 'SIGKILL');
      await expect(child.outcome).resolves.toMatchObject({ kind: 'cancelled' });
    });

    it('lets custody of an exited root lapse rather than signal a group it can no longer vouch for', async () => {
      const h = harness(os, {
        timing: { survivorPollMs: 60_000, reservationMs: 20 },
      });
      const child = await h.services.start(POSIX_REQUEST);
      h.spawned[0].exit(0, null);
      await expect(child.outcome).resolves.toMatchObject({ kind: 'exited' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await rejection(() => child.terminate({ mode: 'force' }))).toEqual(
        typed('unavailable'),
      );
      expect(await rejection(() => h.services.shutdown())).toEqual(
        typed('unavailable'),
      );
      runHostExit();
      expect(h.kills.map(([, signal]) => signal)).toEqual([0]);
    });

    it('kills an owned group synchronously when the host exits', async () => {
      const h = harness(os);
      await h.services.start(POSIX_REQUEST);
      runHostExit();
      const group = -(h.spawned[0].pid ?? 0);
      expect(h.kills).toEqual([
        [group, 0],
        [group, 'SIGKILL'],
      ]);
    });
  },
);

describe('win32 job custody', () => {
  type Native = Record<string, jest.Mock | undefined>;
  const PIPES = {
    stdin: '\\\\.\\pipe\\canopy-execution-1-a-0',
    stdout: '\\\\.\\pipe\\canopy-execution-1-a-1',
    stderr: '\\\\.\\pipe\\canopy-execution-1-a-2',
  };
  interface State {
    root: 'running' | 'exited' | 'lost';
    exit: { code: number | null; signal: number | null };
    members: boolean;
    released: boolean;
  }
  function addon(overrides: Partial<Native> = {}): {
    native: Native;
    state: State;
  } {
    const state: State = {
      root: 'running',
      exit: { code: 0, signal: null },
      members: true,
      released: false,
    };
    // A released record's handle is invalid, as in the addon.
    const live = (): void => {
      if (state.released) throw err('ERR_OWNED_CHILD_HANDLE');
    };
    const native: Native = {
      spawn: jest.fn(),
      launch: jest.fn(
        (
          _executable: string,
          _argv: string[],
          _environment: string[],
          _cwd: string,
          _nonce: string,
          stdin: boolean,
        ) => ({
          handle: {},
          pid: 4000,
          stdin: stdin ? PIPES.stdin : null,
          stdout: PIPES.stdout,
          stderr: PIPES.stderr,
        }),
      ),
      resume: jest.fn(() => true),
      observe: jest.fn(() => {
        live();
        return state.root === 'exited'
          ? { state: 'exited', ...state.exit }
          : { state: state.root };
      }),
      stopGroup: jest.fn(() => {
        live();
        state.root = 'exited';
        state.exit = { code: null, signal: 9 };
        state.members = false;
        return true;
      }),
      members: jest.fn(() => (state.members ? 1 : 0)),
      release: jest.fn(() => {
        live();
        state.released = state.root === 'exited' && !state.members;
        return state.released;
      }),
      commit: jest.fn(),
      rollbackSync: jest.fn(() => true),
      rollbackUndelivered: jest.fn(() => true),
      ...overrides,
    };
    jest.spyOn(process, 'dlopen').mockImplementation((module) => {
      Object.assign(module, { exports: native });
    });
    return { native, state };
  }
  const NATIVE = 'C:\\addon\\core-owned-child.node';
  const opened: Runtime.PlatformExecutionProcessServices[] = [];
  // Running children keep their exit poll referenced, as Node's handles do.
  afterEach(async () => {
    await Promise.allSettled(opened.splice(0).map((s) => s.shutdown()));
  });

  /** Fake pipe connections; each resolves when `open` runs, unless held. */
  function pipes(options: { hold?: boolean; refuse?: string } = {}): {
    readonly connect: jest.Mock<Promise<PassThrough>, [string, boolean]>;
    readonly streams: Map<string, PassThrough>;
    open(): void;
  } {
    const streams = new Map<string, PassThrough>();
    const waiting: (() => void)[] = [];
    const connect = jest.fn<Promise<PassThrough>, [string, boolean]>(
      (pipe) =>
        new Promise<PassThrough>((resolve, reject) => {
          const settle = (): void => {
            if (pipe === options.refuse) return reject(err('ENOENT'));
            const stream = new PassThrough();
            streams.set(pipe, stream);
            resolve(stream);
          };
          if (options.hold) waiting.push(settle);
          else settle();
        }),
    );
    return {
      connect,
      streams,
      open: () => waiting.splice(0).forEach((settle) => settle()),
    };
  }

  type Pipes = ReturnType<typeof pipes>;
  type WindowsHarness = Harness & { readonly pipes: Pipes };
  function windows(
    options: { connect?: Pipes; files?: readonly string[] } = {},
  ): WindowsHarness {
    const connected = options.connect ?? pipes();
    const files = new Set(options.files ?? ['C:\\tools\\tool.exe']);
    const h = harness('win32', {
      nativePath: NATIVE,
      timing: {
        connect: connected.connect,
        isFile: (file) => files.has(file),
      },
    });
    opened.push(h.services);
    return { ...h, pipes: connected };
  }

  /** Ends the fake streams, as a child's exit ends its pipes. */
  function exit(h: WindowsHarness, state: State, code: number): void {
    state.root = 'exited';
    state.exit = { code, signal: null };
    h.pipes.streams.forEach((stream) => stream.end());
  }

  it('creates the child suspended inside its job and resumes it once every pipe is connected', async () => {
    const { native } = addon();
    const connected = pipes({ hold: true });
    const h = windows({ connect: connected });
    const starting = h.services.start({
      ...WINDOWS_REQUEST,
      args: ['--flag', 'a b'],
      stdin: 'pipe',
    });
    expect(native.launch).toHaveBeenCalledWith(
      'C:\\tools\\tool.exe',
      ['C:\\tools\\tool.exe', '--flag', 'a b'],
      [
        'SystemRoot=C:\\Windows',
        'HOMEDRIVE=',
        'HOMEPATH=',
        'LOGONSERVER=',
        'PATH=',
        'SYSTEMDRIVE=',
        'TEMP=',
        'USERDOMAIN=',
        'USERNAME=',
        'USERPROFILE=',
        'WINDIR=',
      ],
      'C:\\work',
      expect.stringMatching(/^[0-9a-f]{32}$/),
      true,
    );
    await tick();
    expect(
      connected.connect.mock.calls.sort(([a], [b]) => a.localeCompare(b)),
    ).toEqual([
      [PIPES.stdin, true],
      [PIPES.stdout, false],
      [PIPES.stderr, false],
    ]);
    expect(native.resume).not.toHaveBeenCalled();
    connected.open();
    const child = await starting;
    expect(native.resume).toHaveBeenCalledTimes(1);
    expect(child.pid).toBe(4000);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('serves stdio over the connected pipes', async () => {
    const { state } = addon();
    const h = windows();
    const child = await h.services.start({ ...WINDOWS_REQUEST, stdin: 'pipe' });
    const received: Buffer[] = [];
    h.pipes.streams.get(PIPES.stdin)?.on('data', (chunk: Buffer) => {
      received.push(chunk);
    });
    await child.stdin?.write(Buffer.from('in'));
    h.pipes.streams.get(PIPES.stdout)?.write('out');
    h.pipes.streams.get(PIPES.stderr)?.write('err');
    expect(Buffer.from((await child.stdout.read()) ?? []).toString()).toBe(
      'out',
    );
    expect(Buffer.from((await child.stderr?.read()) ?? []).toString()).toBe(
      'err',
    );
    expect(Buffer.concat(received).toString()).toBe('in');
    exit(h, state, 3);
    child.stdout.acknowledge(3);
    child.stderr?.acknowledge(3);
    await expect(child.outcome).resolves.toEqual({
      kind: 'exited',
      code: 3,
      signal: null,
      output: 'complete',
    });
  });

  it('starts the file libuv would pick and refuses batch files', async () => {
    const { native } = addon();
    const h = windows({
      files: [
        'C:\\tools\\tool.exe',
        'C:\\tools\\run.cmd',
        'C:\\tools\\run.bat.',
        'C:\\tools\\run.cmd ',
      ],
    });
    await h.services.start({
      ...WINDOWS_REQUEST,
      executable: 'C:\\tools\\tool',
    });
    expect(native.launch).toHaveBeenCalledWith(
      'C:\\tools\\tool.exe',
      ['C:\\tools\\tool'],
      expect.any(Array),
      'C:\\work',
      expect.any(String),
      false,
    );
    native.launch?.mockClear();
    for (const executable of [
      'C:\\tools\\run.cmd',
      'C:\\tools\\run.bat.',
      'C:\\tools\\run.cmd ',
      'C:\\tools\\missing.exe',
    ])
      expect(
        await rejection(() =>
          h.services.start({ ...WINDOWS_REQUEST, executable }),
        ),
      ).toEqual(typed('failed_precondition'));
    expect(native.launch).not.toHaveBeenCalled();
  });

  it('stops through the job like a daemon root and reports cancellation', async () => {
    const { native } = addon();
    const h = windows();
    const child = await h.services.start(WINDOWS_REQUEST);
    await child.terminate();
    expect(native.stopGroup).toHaveBeenCalled();
    expect(native.release).toHaveBeenLastCalledWith(expect.any(Object));
    await expect(child.outcome).resolves.toEqual({
      kind: 'cancelled',
      code: null,
      signal: 'SIGKILL',
      output: 'discarded',
    });
  });

  it('shares one stop between terminate and shutdown', async () => {
    addon();
    const h = windows();
    const child = await h.services.start(WINDOWS_REQUEST);
    const stopping = child.terminate();
    await expect(h.services.shutdown()).resolves.toBeUndefined();
    await expect(stopping).resolves.toBeUndefined();
    await expect(child.outcome).resolves.toMatchObject({ kind: 'cancelled' });
  });

  it('classifies an exception status as a crash', async () => {
    const { state } = addon();
    const h = windows();
    const child = await h.services.start(WINDOWS_REQUEST);
    exit(h, state, 0xc0000005);
    await expect(child.outcome).resolves.toMatchObject({
      kind: 'crashed',
      code: 0xc0000005,
    });
  });

  it('reports a root it can no longer observe as lost', async () => {
    const { state } = addon();
    const h = windows();
    const child = await h.services.start(WINDOWS_REQUEST);
    state.root = 'lost';
    await expect(child.outcome).resolves.toEqual({
      kind: 'lost',
      code: null,
      signal: null,
      output: 'discarded',
    });
  });

  it('keeps an exited root with live job members until they are gone', async () => {
    const { native, state } = addon();
    const h = windows();
    const child = await h.services.start(WINDOWS_REQUEST);
    exit(h, state, 0);
    await expect(child.outcome).resolves.toMatchObject({ kind: 'exited' });
    runHostExit();
    expect(native.rollbackSync).toHaveBeenCalledTimes(1);
    state.members = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    native.rollbackSync?.mockClear();
    runHostExit();
    expect(native.rollbackSync).not.toHaveBeenCalled();
    expect(native.stopGroup).not.toHaveBeenCalled();
  });

  it('ends a child whose pipe another process connected before it ran', async () => {
    const { native } = addon({
      resume: jest.fn(() => {
        throw err('ERR_OWNED_CHILD_SPAWN');
      }),
    });
    const h = windows();
    expect(await rejection(() => h.services.start(WINDOWS_REQUEST))).toEqual(
      typed('failed_precondition'),
    );
    expect(native.stopGroup).toHaveBeenCalled();
    h.pipes.streams.forEach((stream) => expect(stream.destroyed).toBe(true));
  });

  it('ends a child whose pipe could not be connected, without running it', async () => {
    const { native } = addon();
    const h = windows({ connect: pipes({ refuse: PIPES.stderr }) });
    expect(await rejection(() => h.services.start(WINDOWS_REQUEST))).toEqual(
      typed('failed_precondition'),
    );
    expect(native.resume).not.toHaveBeenCalled();
    expect(native.stopGroup).toHaveBeenCalled();
    expect(h.pipes.streams.get(PIPES.stdout)?.destroyed).toBe(true);
  });

  it('reports unconfirmed cleanup when a child that never ran cannot be ended', async () => {
    addon({
      resume: jest.fn(() => {
        throw err('ERR_OWNED_CHILD_SPAWN');
      }),
      stopGroup: jest.fn(() => {
        throw err('ERR_OWNED_CHILD_LOST');
      }),
    });
    const h = windows();
    expect(await rejection(() => h.services.start(WINDOWS_REQUEST))).toEqual(
      typed('unavailable'),
    );
  });

  it('keeps shutdown unconfirmed after native launch rollback fails before handle delivery', async () => {
    const { native } = addon({
      launch: jest.fn((): never => {
        throw err('ERR_OWNED_CHILD_CLEANUP');
      }),
    });
    const h = windows();
    await expect(h.services.start(WINDOWS_REQUEST)).rejects.toEqual(
      typed('unavailable'),
    );
    expect(native.resume).not.toHaveBeenCalled();
    expect(h.pipes.connect).not.toHaveBeenCalled();
    await expect(h.services.shutdown()).rejects.toEqual(typed('unavailable'));
    await expect(h.services.shutdown()).rejects.toEqual(typed('unavailable'));
    runHostExit();
    expect(native.rollbackUndelivered).toHaveBeenCalledTimes(1);
  });

  it('allows shutdown after native launch confirms rollback before handle delivery', async () => {
    const { native } = addon({
      launch: jest.fn((): never => {
        throw err('ERR_OWNED_CHILD_SPAWN');
      }),
    });
    const h = windows();
    await expect(h.services.start(WINDOWS_REQUEST)).rejects.toEqual(
      typed('failed_precondition'),
    );
    await expect(h.services.shutdown()).resolves.toBeUndefined();
    runHostExit();
    expect(native.rollbackUndelivered).not.toHaveBeenCalled();
  });

  it('still stops delivered jobs when an undelivered launch keeps shutdown unconfirmed', async () => {
    const { native } = addon();
    const h = windows();
    const child = await h.services.start(WINDOWS_REQUEST);
    native.launch?.mockImplementation((): never => {
      throw err('ERR_OWNED_CHILD_CLEANUP');
    });
    await expect(h.services.start(WINDOWS_REQUEST)).rejects.toEqual(
      typed('unavailable'),
    );
    await expect(h.services.shutdown()).rejects.toEqual(typed('unavailable'));
    expect(native.stopGroup).toHaveBeenCalled();
    await expect(child.outcome).resolves.toMatchObject({ kind: 'cancelled' });
  });

  // Simulates the Windows write-only pipe on POSIX sockets; on Windows the
  // native echo suites exercise the real pipe.
  (process.platform === 'win32' ? it.skip : it)(
    'keeps stdin writable over a pipe whose readable side ends at once',
    async () => {
      // A write-only client handle reads as ended immediately, as the server
      // end of an inbound pipe shows a Node client; stdin must stay open.
      const dir = mkdtempSync(path.join(tmpdir(), 'pipes-'));
      const received: Buffer[] = [];
      const servers: Server[] = [];
      const listen = (
        name: string,
        onSocket: (socket: Socket) => void,
      ): Promise<string> => {
        const file =
          process.platform === 'win32'
            ? `\\\\.\\pipe\\${path.basename(dir)}-${name}`
            : path.join(dir, name);
        const server = createServer({ allowHalfOpen: true }, onSocket);
        servers.push(server);
        return new Promise<string>((resolve, reject) => {
          server.once('error', reject);
          server.listen(file, () => resolve(file));
        });
      };
      try {
        const sockets: Socket[] = [];
        const keep = (socket: Socket): void => {
          sockets.push(socket);
        };
        const [stdin, stdout, stderr] = await Promise.all([
          listen('in', (socket) => {
            keep(socket);
            socket.on('data', (chunk: Buffer) => received.push(chunk));
            socket.end();
          }),
          listen('out', keep),
          listen('err', keep),
        ]);
        addon({
          launch: jest.fn(() => ({
            handle: {},
            pid: 4000,
            stdin,
            stdout,
            stderr,
          })),
        });
        const h = harness('win32', {
          nativePath: NATIVE,
          timing: { isFile: () => true },
        });
        opened.push(h.services);
        const child = await h.services.start({
          ...WINDOWS_REQUEST,
          stdin: 'pipe',
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await child.stdin?.write(Buffer.from('in'));
        await child.stdin?.end();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(Buffer.concat(received).toString()).toBe('in');
        await child.terminate();
        sockets.forEach((socket) => socket.destroy());
      } finally {
        await Promise.all(
          servers.map(
            (server) => new Promise((resolve) => server.close(resolve)),
          ),
        );
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('lets shutdown retry a child that never ran when its first cleanup failed', async () => {
    let failures = 1;
    const { native } = addon();
    const stop = native.stopGroup;
    native.stopGroup = jest.fn((handle: object): unknown => {
      if (failures-- > 0) throw err('ERR_OWNED_CHILD_LOST');
      return stop?.(handle);
    });
    const h = windows({ connect: pipes({ refuse: PIPES.stderr }) });
    expect(await rejection(() => h.services.start(WINDOWS_REQUEST))).toEqual(
      typed('unavailable'),
    );
    const attempts = native.stopGroup?.mock.calls.length ?? 0;
    await expect(h.services.shutdown()).resolves.toBeUndefined();
    expect(native.stopGroup?.mock.calls.length).toBeGreaterThan(attempts);
    expect(native.release).toHaveBeenLastCalledWith(expect.any(Object));
  });

  it('ends a child whose start a shutdown overtook before it ran', async () => {
    const { native } = addon();
    const connected = pipes({ hold: true });
    const h = windows({ connect: connected });
    const starting = h.services.start(WINDOWS_REQUEST);
    await h.services.shutdown();
    expect(native.stopGroup).toHaveBeenCalled();
    connected.open();
    expect(await rejection(() => starting)).toEqual(
      typed('failed_precondition'),
    );
    expect(native.resume).not.toHaveBeenCalled();
  });

  it('refuses before launching when the addon cannot launch', async () => {
    const { native } = addon({ launch: undefined });
    const h = windows();
    expect(await rejection(() => h.services.start(WINDOWS_REQUEST))).toEqual(
      typed('capability_unavailable'),
    );
    expect(native.resume).not.toHaveBeenCalled();
  });

  it('refuses without an addon path', async () => {
    const h = harness('win32');
    expect(await rejection(() => h.services.start(WINDOWS_REQUEST))).toEqual(
      typed('capability_unavailable'),
    );
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('rejects a POSIX path on win32 without loading the addon', async () => {
    const { native } = addon();
    const h = windows();
    expect(await rejection(() => h.services.start(POSIX_REQUEST))).toEqual(
      typed('invalid_argument'),
    );
    expect(native.launch).not.toHaveBeenCalled();
  });

  it.each([
    ['case-duplicate environment names', { Path: 'C:\\a', PATH: 'C:\\b' }],
    ['a name with =', { '=C:': 'C:\\' }],
  ])('rejects %s', async (_, environment) => {
    const { native } = addon();
    const h = windows();
    expect(
      await rejection(() =>
        h.services.start({ ...WINDOWS_REQUEST, environment }),
      ),
    ).toEqual(typed('invalid_argument'));
    expect(native.launch).not.toHaveBeenCalled();
  });
});

describe('credit-metered output', () => {
  async function started(window = 4): Promise<{
    child: Runtime.PlatformExecutionProcess;
    fake: FakeChild;
  }> {
    const h = harness('linux');
    const child = await h.services.start({
      ...POSIX_REQUEST,
      outputWindowBytes: window,
    });
    return { child, fake: h.spawned[0] };
  }

  it('splits chunks at the window and waits for acknowledgement', async () => {
    const { child, fake } = await started(4);
    fake.stdout.write(Buffer.from('abcdefgh'));
    expect(Buffer.from((await child.stdout.read()) ?? [])).toEqual(
      Buffer.from('abcd'),
    );
    let more = false;
    const pending = child.stdout.read().then((chunk) => {
      more = true;
      return chunk;
    });
    await tick();
    expect(more).toBe(false);
    child.stdout.acknowledge(2);
    expect(Buffer.from((await pending) ?? [])).toEqual(Buffer.from('ef'));
    child.stdout.acknowledge(100);
    expect(Buffer.from((await child.stdout.read()) ?? [])).toEqual(
      Buffer.from('gh'),
    );
  });

  it('holds the outcome until output is delivered, never until it is acknowledged', async () => {
    const { child, fake } = await started(4);
    fake.stdout.write(Buffer.from('ab'));
    fake.exit(5, null);
    let settled = false;
    void child.outcome.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    expect(Buffer.from((await child.stdout.read()) ?? [])).toEqual(
      Buffer.from('ab'),
    );
    await expect(child.outcome).resolves.toEqual({
      kind: 'exited',
      code: 5,
      signal: null,
      output: 'complete',
    });
    await expect(child.stdout.read()).resolves.toBeNull();
  });

  it('settles the outcome only after the caller resumed from the last read', async () => {
    const { child, fake } = await started(4);
    fake.stdout.write(Buffer.from('ab'));
    fake.exit(0, null);
    const order: string[] = [];
    void child.outcome.then(() => order.push('outcome'));
    await child.stdout.read();
    order.push('read');
    await child.outcome;
    expect(order).toEqual(['read', 'outcome']);
  });

  it('finishes a child whose stdout fails before it ends', async () => {
    const { child, fake } = await started();
    fake.stdout.destroy(new Error('pipe failed'));
    fake.exit(0, null);
    await expect(child.outcome).resolves.toMatchObject({
      kind: 'exited',
      code: 0,
    });
    await expect(child.stdout.read()).resolves.toBeNull();
  });

  it('lets shutdown settle a child whose tree is gone but whose output is unread', async () => {
    const h = harness('linux', {
      kill: (pid, signal) => {
        h.kills.push([pid, signal]);
        if (signal === 0) throw err('ESRCH');
      },
    });
    const child = await h.services.start({
      ...POSIX_REQUEST,
      outputWindowBytes: 4,
    });
    const fake = h.spawned[0];
    fake.stdout.write(Buffer.from('abcdefgh'));
    await child.stdout.read();
    fake.exit(0, null);
    let settled = false;
    void child.outcome.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    await h.services.shutdown();
    await expect(child.outcome).resolves.toEqual({
      kind: 'exited',
      code: 0,
      signal: null,
      output: 'discarded',
    });
    expect(h.kills.map(([, signal]) => signal)).toEqual([0]);
  });

  it('refuses a second concurrent read and bad acknowledgements', async () => {
    const { child } = await started();
    const first = child.stdout.read();
    expect(await rejection(() => child.stdout.read())).toEqual(
      typed('failed_precondition'),
    );
    for (const bytes of [-1, 1.5, Number.NaN]) {
      let thrown: unknown;
      try {
        child.stdout.acknowledge(bytes);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toEqual(typed('invalid_argument'));
    }
    child.stdout.discard();
    await expect(first).resolves.toBeNull();
  });

  it('rejects an aborted read with its reason and keeps the stream readable', async () => {
    const { child, fake } = await started();
    const controller = new AbortController();
    const reason = new Error('stop waiting');
    const read = child.stdout.read({ signal: controller.signal });
    controller.abort(reason);
    await expect(read).rejects.toBe(reason);
    fake.stdout.write(Buffer.from('x'));
    expect(Buffer.from((await child.stdout.read()) ?? [])).toEqual(
      Buffer.from('x'),
    );
  });

  it('reports output discarded by a stop, not by a stderr discard request', async () => {
    const h = harness('linux');
    const quiet = await h.services.start({
      ...POSIX_REQUEST,
      stderr: 'discard',
    });
    h.spawned[0].stderr.write('noise');
    h.spawned[0].exit(0, null);
    await expect(quiet.outcome).resolves.toMatchObject({ output: 'complete' });
  });
});
