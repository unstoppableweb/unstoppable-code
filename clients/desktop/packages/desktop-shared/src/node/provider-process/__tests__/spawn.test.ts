import type * as ChildProcessModule from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  PlatformProcessGroup,
  PlatformProcessIdentity,
  PlatformProcessTable,
  PlatformProcessTableRow,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';
import {
  reapDescendantGroups,
  reapDescendantGroupsWithReason,
  traceWithin,
} from '../descendant-groups';
import {
  spawnProviderProcessDirect,
  type ProviderProcess,
  type ProviderProcessError,
  type ProviderProcessOwner,
  type ProviderProcessRequest,
} from '../spawn';

/** Supervision services with only the reads a reap uses; the rest refuse. */
function fakeSupervision(
  overrides: Partial<PlatformSupervisionServices>,
): PlatformSupervisionServices {
  const refuse = (): never => {
    throw new Error('not used');
  };
  return {
    childProcessOptions: refuse,
    childEnvironment: refuse,
    killProcessTree: refuse,
    inspectProcess: refuse,
    readProcessTable: refuse,
    ...overrides,
  };
}

/** Lets a malformed owner through the type system, as an untyped caller would. */
function untypedOwner(value: object): value is ProviderProcessOwner {
  return typeof value === 'object';
}

// Real children under plain Node. Group kills are POSIX-only; Windows keeps
// the forced tree kill, which the port's own suite covers.
const itPosix = process.platform === 'win32' ? it.skip : it;

let dir = '';
const strays = new Set<number>();

function present(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
  }
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function request(
  args: string[],
  overrides: Partial<ProviderProcessRequest> = {},
): ProviderProcessRequest {
  return {
    command: process.execPath,
    args,
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    owner: { kind: 'turn', id: 'spawn-test' },
    ...overrides,
  };
}

interface Observed {
  errors: ProviderProcessError[];
  closes: [number | null, NodeJS.Signals | null][];
  closed: Promise<void>;
  stdout: Promise<Buffer>;
}

function observe(child: ProviderProcess): Observed {
  const errors: ProviderProcessError[] = [];
  const closes: [number | null, NodeJS.Signals | null][] = [];
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const stdout = new Promise<Buffer>((resolve) => {
    child.stdout.once('end', () => resolve(Buffer.concat(chunks)));
  });
  child.once('error', (error) => errors.push(error));
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      closes.push([code, signal]);
      resolve();
    });
  });
  return { errors, closes, closed, stdout };
}

/** Resolves with the first stdout line. */
function firstLine(child: ProviderProcess): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8');
      const end = text.indexOf('\n');
      if (end < 0) return;
      child.stdout.off('data', onData);
      resolve(text.slice(0, end));
    };
    child.stdout.on('data', onData);
  });
}

beforeAll(() => {
  dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'provider-spawn-')),
  );
});

afterEach(() => {
  for (const pid of Array.from(strays))
    if (present(pid)) process.kill(pid, 'SIGKILL');
  strays.clear();
  jest.restoreAllMocks();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('spawnProviderProcessDirect', () => {
  it('streams stdout and reports close with code and signal', async () => {
    const child = spawnProviderProcessDirect(
      request([
        '-e',
        `const bytes = Buffer.alloc(100 * 1024);
         for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
         process.stdout.write(bytes, () => { process.exitCode = 3; });`,
      ]),
    );
    const observed = observe(child);
    expect(Number.isInteger(child.pid)).toBe(true);
    expect(child.pid).toBeGreaterThan(0);
    const bytes = await observed.stdout;
    await observed.closed;
    expect(bytes.length).toBe(100 * 1024);
    for (let i = 0; i < bytes.length; i++)
      if (bytes[i] !== i % 251) throw new Error(`byte ${i} out of order`);
    expect(observed.closes).toEqual([[3, null]]);
    expect(observed.errors).toEqual([]);
  });

  it('a request with stdin ignored gives the child no input', async () => {
    const child = spawnProviderProcessDirect(
      request(
        [
          '-e',
          "process.stdout.write(String(require('fs').readFileSync(0).length))",
        ],
        { stdin: 'ignore' },
      ),
    );
    const observed = observe(child);
    expect(child.stdin).toBeNull();
    expect((await observed.stdout).toString()).toBe('0');
    await observed.closed;
    expect(observed.closes).toEqual([[0, null]]);
    expect(observed.errors).toEqual([]);
  });

  it('spawns with stdio[0] ignore when asked and pipe by default', async () => {
    await jest.isolateModulesAsync(async (): Promise<void> => {
      const childProcess =
        jest.requireActual<typeof ChildProcessModule>('node:child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn');
      const { spawnProviderProcessDirect: isolatedSpawn } =
        await import('../spawn');
      for (const mode of ['ignore', undefined] as const) {
        const child = isolatedSpawn(
          request(['-e', ''], mode ? { stdin: mode } : {}),
        );
        await observe(child).closed;
      }
      expect(spawnSpy.mock.calls.map((call) => call[2]?.stdio)).toEqual([
        ['ignore', 'pipe', 'pipe'],
        ['pipe', 'pipe', 'pipe'],
      ]);
    });
  });

  it('reports exit before close while a descendant holds stdout', async () => {
    const child = spawnProviderProcessDirect(
      request([
        '-e',
        `const { spawn } = require('node:child_process');
         const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'],
           { stdio: ['ignore', 'inherit', 'ignore'] });
         process.stdout.write(descendant.pid + '\\n', () => process.exit(0));`,
      ]),
    );
    const observed = observe(child);
    const events: string[] = [];
    const exited = new Promise<[number | null, NodeJS.Signals | null]>(
      (resolve) => {
        child.once('exit', (code, signal) => {
          events.push('exit');
          resolve([code, signal]);
        });
      },
    );
    child.once('close', () => events.push('close'));
    const descendant = Number(await firstLine(child));
    strays.add(descendant);
    expect(await exited).toEqual([0, null]);
    expect(present(descendant)).toBe(true);
    expect(observed.closes).toEqual([]);
    process.kill(descendant, 'SIGKILL');
    await observed.closed;
    expect(events).toEqual(['exit', 'close']);
    expect(observed.closes).toEqual([[0, null]]);
  });

  it('a missing executable reports one error then close(null, null)', async () => {
    const child = spawnProviderProcessDirect(
      request([], { command: path.join(dir, 'missing') }),
    );
    const observed = observe(child);
    const exits = jest.fn();
    child.once('exit', exits);
    await observed.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(observed.errors.map((error) => error.code)).toEqual(['ENOENT']);
    expect(observed.closes).toEqual([[null, null]]);
    expect(exits).not.toHaveBeenCalled();
    expect(child.pid).toBeUndefined();
  });

  it('an invalid owner spawns nothing', async () => {
    await jest.isolateModulesAsync(async (): Promise<void> => {
      const childProcess =
        jest.requireActual<typeof ChildProcessModule>('node:child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn');
      const { spawnProviderProcessDirect: isolatedSpawn } =
        await import('../spawn');
      const owners: object[] = [
        { kind: 'turn', id: '' },
        { kind: 'other', id: 'x' },
      ];
      for (const owner of owners) {
        // Owners arrive from callers the compiler cannot see.
        if (!untypedOwner(owner)) throw new Error('unreachable');
        const child = isolatedSpawn({ ...request(['-e', '']), owner });
        const observed = observe(child);
        await observed.closed;
        expect(observed.errors.map((error) => error.code)).toEqual([
          'ERR_PROVIDER_PROCESS_OWNER',
        ]);
        expect(observed.closes).toEqual([[null, null]]);
        expect(child.pid).toBeUndefined();
      }
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  });

  itPosix(
    'stop kills the whole group even after the leader closed',
    async () => {
      const child = spawnProviderProcessDirect(
        request([
          '-e',
          `const { spawn } = require('node:child_process');
           const grandchild = spawn(process.execPath, ['-e',
             "process.on('SIGTERM', () => undefined); process.stdout.write('ready'); setInterval(() => undefined, 1 << 30);"],
             { stdio: ['ignore', 'pipe', 'ignore'] });
           grandchild.stdout.once('data', () => process.stdout.write(grandchild.pid + '\\n'));
           process.on('SIGTERM', () => process.exit(0));
           setInterval(() => undefined, 1 << 30);`,
        ]),
      );
      const observed = observe(child);
      const grandchild = Number(await firstLine(child));
      strays.add(grandchild);
      expect(present(grandchild)).toBe(true);
      await child.stop({ graceMs: 200 });
      expect(observed.closes).toEqual([[0, null]]);
      await until(() => !present(grandchild), 3_000);
    },
  );

  itPosix('stop escalates an ignored SIGTERM after the grace', async () => {
    const child = spawnProviderProcessDirect(
      request([
        '-e',
        `process.on('SIGTERM', () => undefined);
         process.stdout.write('ready\\n');
         setInterval(() => undefined, 1 << 30);`,
      ]),
    );
    const observed = observe(child);
    await firstLine(child);
    const started = Date.now();
    await child.stop({ graceMs: 300 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(observed.closes).toEqual([[null, 'SIGKILL']]);
  });

  itPosix(
    'stop signals only the group of a child that exits inside the TERM window',
    async () => {
      const child = spawnProviderProcessDirect(
        request([
          '-e',
          `process.on('SIGTERM', () => process.exit(0));
           process.stdout.write('ready\\n');
           setInterval(() => undefined, 1 << 30);`,
        ]),
      );
      const observed = observe(child);
      await firstLine(child);
      const pid = child.pid;
      if (pid === undefined) throw new Error('no pid');
      const kill = jest.spyOn(process, 'kill');
      await child.stop({ graceMs: 5_000 });
      expect(observed.closes).toEqual([[0, null]]);
      expect(kill.mock.calls).toEqual([
        [-pid, 'SIGTERM'],
        [-pid, 'SIGKILL'],
      ]);
    },
  );

  itPosix('stop after close signals only the group', async () => {
    const child = spawnProviderProcessDirect(request(['-e', '']));
    const observed = observe(child);
    await observed.closed;
    const pid = child.pid;
    if (pid === undefined) throw new Error('no pid');
    const kill = jest.spyOn(process, 'kill');
    await child.stop({ graceMs: 100 });
    expect(kill.mock.calls).toEqual([
      [-pid, 'SIGTERM'],
      [-pid, 'SIGKILL'],
    ]);
  });

  it('stop is idempotent', async () => {
    const child = spawnProviderProcessDirect(
      request(['-e', 'setInterval(() => undefined, 1 << 30);']),
    );
    const observed = observe(child);
    const first = child.stop({ graceMs: 100 });
    const second = child.stop({ graceMs: 5_000 });
    expect(second).toBe(first);
    await first;
    expect(observed.closes).toHaveLength(1);
  });
});

/**
 * CAN-6726: a provider that starts a command in its own session (as
 * Antigravity does for approved commands) and opts in to reaping leaves
 * nothing behind; a process outside its tree is never signalled.
 */
describe('spawnProviderProcessDirect reapDescendantGroups', () => {
  /** Starts a command in its own session that ignores SIGTERM, prints its pid. */
  const STARTS_OWN_GROUP_COMMAND = [
    '-e',
    `const { spawn } = require('node:child_process');
     const command = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'],
       { detached: true, stdio: 'ignore' });
     command.unref();
     process.stdout.write(command.pid + '\\n');
     setInterval(() => undefined, 1 << 30);`,
  ];

  afterEach(() => {
    for (const pid of Array.from(strays)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  itPosix(
    'spares an unrelated process and never reports a requested record as no cleanup',
    async () => {
      // Real processes and real reads, so only load-independent facts are
      // asserted. Whether the record lands before the stop, and whether its
      // reads meet their budgets, depends on the host's load. The fake-clock
      // goldens below pin when the outcome is `reaped` and when it is
      // `unverified` (CAN-7026).
      const unrelated = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 60'], {
        detached: true,
        stdio: 'ignore',
      });
      unrelated.unref();
      const unrelatedPid = unrelated.pid;
      if (unrelatedPid === undefined) throw new Error('no unrelated pid');
      strays.add(unrelatedPid);
      const child = spawnProviderProcessDirect(
        request(STARTS_OWN_GROUP_COMMAND, { reapDescendantGroups: true }),
      );
      const command = Number(await firstLine(child));
      strays.add(command);
      child.recordDescendants?.();
      await child.stop({ graceMs: 200 });
      const cleanup = await child.stopCleanup?.();
      const reason = await child.stopCleanupReason?.();
      // The reason names the path that fired, so a CI failure explains itself.
      expect(`${String(cleanup)} (${String(reason)})`).toMatch(
        /^(reaped \(undefined\)|unverified \([a-z-]+\))$/,
      );
      expect(present(unrelatedPid)).toBe(true);
    },
    30_000,
  );
});

/**
 * CAN-6726: the reap only signals a recorded group while a member with a
 * recorded start identity is still in it, so a group id reused by unrelated
 * processes is never signalled.
 */
describe('reapDescendantGroups membership proof', () => {
  it('never signals a group whose recorded PID now belongs to another process', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const reused: PlatformProcessGroup = {
      state: 'listed',
      members: [
        {
          pid: 900,
          startIdentity: 'darwin:v1:900:2',
          startedAtMs: 2_000,
          command: 'sh',
        },
      ],
    };
    const services: Partial<PlatformSupervisionServices> = {
      identifyProcess: (): Promise<PlatformProcessIdentity> =>
        Promise.resolve({
          state: 'running',
          startIdentity: 'darwin:v1:900:2',
          processGroupId: 900,
          executablePath: '/bin/sh',
        }),
      listProcessGroup: (): Promise<PlatformProcessGroup> =>
        Promise.resolve(reused),
    };
    await reapDescendantGroups(
      new Map([[900, new Map([['darwin:v1:900:1', 900]])]]),
      10,
      10,
      fakeSupervision(services),
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(['listed', 'stale-listed', 'unverifiable', 'rejected'] as const)(
    'never signals a group reused while its %s listing is pending',
    async (listingState) => {
      const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let identity = 'darwin:v1:900:1';
      const services: Partial<PlatformSupervisionServices> = {
        identifyProcess: (): Promise<PlatformProcessIdentity> =>
          Promise.resolve({
            state: 'running',
            startIdentity: identity,
            processGroupId: 900,
            executablePath: '/bin/sh',
          }),
        listProcessGroup: async (): Promise<PlatformProcessGroup> => {
          const earlyIdentity = identity;
          entered.resolve();
          await release.promise;
          if (listingState === 'rejected') throw new Error('listing failed');
          if (listingState === 'unverifiable')
            return {
              state: 'unverifiable',
              reason: 'fixture listing unavailable',
            };
          return {
            state: 'listed',
            members: [
              {
                pid: 900,
                startIdentity:
                  listingState === 'stale-listed' ? earlyIdentity : identity,
                startedAtMs: 2_000,
                command: 'sh',
              },
            ],
          };
        },
      };
      const cleanup = reapDescendantGroups(
        new Map([[900, new Map([['darwin:v1:900:1', 900]])]]),
        10,
        10,
        fakeSupervision(services),
      );
      await entered.promise;
      expect(kill).not.toHaveBeenCalled();
      identity = 'darwin:v1:900:2';
      release.resolve();
      await cleanup;
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it('never signals a recorded group id that now holds only new processes', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const listed: PlatformProcessGroup = {
      state: 'listed',
      members: [
        {
          pid: 900,
          startIdentity: 'darwin:v1:900:2',
          startedAtMs: 2_000,
          command: 'sh',
        },
      ],
    };
    const services: Partial<PlatformSupervisionServices> = {
      listProcessGroup: (): Promise<PlatformProcessGroup> =>
        Promise.resolve(listed),
    };
    await reapDescendantGroups(
      new Map([[900, new Map([['darwin:v1:900:1', 900]])]]),
      10,
      10,
      fakeSupervision(services),
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it('proves a killed group gone after a read that was inconclusive while it was torn down', async () => {
    // CAN-7026: a killed member can be unreadable for a moment while it is
    // torn down; the check that killed groups are gone reads it again.
    let killed = false;
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      killed = true;
      return true;
    });
    let afterKill = 0;
    const services: Partial<PlatformSupervisionServices> = {
      identifyProcess: (): Promise<PlatformProcessIdentity> => {
        if (!killed)
          return Promise.resolve({
            state: 'running',
            startIdentity: 'darwin:v1:900:1',
            processGroupId: 900,
            executablePath: '/bin/sh',
          });
        afterKill += 1;
        return Promise.resolve(
          afterKill === 1
            ? { state: 'unverifiable', reason: 'process query failed (ENOENT)' }
            : { state: 'absent' },
        );
      },
    };
    await expect(
      reapDescendantGroups(
        new Map([[900, new Map([['darwin:v1:900:1', 900]])]]),
        10,
        0,
        fakeSupervision(services),
      ),
    ).resolves.toBe('reaped');
    expect(kill).toHaveBeenCalled();
    expect(afterKill).toBe(2);
  });
});

describe('descendant cleanup on a fake clock (CAN-7026)', () => {
  // A child whose descendant shell runs in its own group and ignores
  // SIGTERM, driven entirely by fakes: the spawn, the kernel's signals, the
  // supervision reads and the clock. Whether the outcome is `reaped` or
  // `unverified` then depends only on when the reads answer.
  const CHILD = 4_101;
  const GROUP = 4_102;
  const row = (
    pid: number,
    ppid: number,
    pgid: number,
  ): PlatformProcessTableRow => ({
    pid,
    ppid,
    pgid,
    cpuPercent: 0,
    memoryRssBytes: 0,
    command: 'sh',
  });
  const table: PlatformProcessTable = {
    kind: 'sampled',
    rows: new Map([
      [CHILD, row(CHILD, 1, CHILD)],
      [GROUP, row(GROUP, CHILD, GROUP)],
    ]),
  };

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function cleanupWith(
    readTable: PlatformSupervisionServices['readProcessTable'],
  ): Promise<{ cleanup: unknown; reason: unknown; groupSignals: unknown[] }> {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    const child = Object.assign(new EventEmitter(), {
      pid: CHILD,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    let ended = false;
    const end = (signal: NodeJS.Signals): void => {
      if (ended) return;
      ended = true;
      child.emit('exit', null, signal);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null, signal);
    };
    let groupKilled = false;
    const groupSignals: unknown[] = [];
    jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (
        Math.abs(pid) === CHILD &&
        (signal === 'SIGTERM' || signal === 'SIGKILL')
      )
        end(signal);
      if (pid === -GROUP) {
        groupSignals.push(signal);
        if (signal === 'SIGKILL') groupKilled = true;
      }
      return true;
    });
    const supervision = fakeSupervision({
      readProcessTable: readTable,
      identifyProcess: ({ pid }): Promise<PlatformProcessIdentity> =>
        Promise.resolve(
          pid === GROUP && !groupKilled
            ? {
                state: 'running',
                startIdentity: `linux:v1:${GROUP}:1`,
                processGroupId: GROUP,
                executablePath: '/bin/sh',
              }
            : { state: 'absent' },
        ),
    });
    let cleanup: unknown;
    let reason: unknown;
    await jest.isolateModulesAsync(async (): Promise<void> => {
      const childProcess =
        jest.requireActual<typeof ChildProcessModule>('node:child_process');
      jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
        process.nextTick(() => child.emit('spawn'));
        return child as never;
      });
      const { spawnProviderProcessDirect: isolatedSpawn } =
        await import('../spawn');
      const spawned = isolatedSpawn(
        request(['-e', ''], { reapDescendantGroups: true }),
        supervision,
      );
      await new Promise((resolve) => process.nextTick(resolve));
      spawned.recordDescendants?.();
      await jest.advanceTimersByTimeAsync(0);
      let settled = false;
      const stopped = spawned.stop({ graceMs: 200 }).then(async () => {
        cleanup = await spawned.stopCleanup?.();
        reason = await spawned.stopCleanupReason?.();
        settled = true;
      });
      for (let step = 0; step < 400 && !settled; step += 1)
        await jest.advanceTimersByTimeAsync(50);
      await stopped;
    });
    return { cleanup, reason, groupSignals };
  }

  // Descendant reaping is off on Windows (spawn.ts), so these are POSIX-only.
  itPosix(
    'reports a recorded SIGTERM-ignoring group reaped when every read answers within its budget',
    async () => {
      const { cleanup, reason, groupSignals } = await cleanupWith(() =>
        Promise.resolve(table),
      );
      expect(groupSignals).toEqual(['SIGTERM', 'SIGKILL']);
      expect({ cleanup, reason }).toEqual({
        cleanup: 'reaped',
        reason: undefined,
      });
    },
  );

  itPosix(
    'reports the cleanup unverified when the process table answers after the record budget',
    async () => {
      // The record's trace gives up at its budget, so the group is never
      // recorded or signalled, and the cleanup cannot speak for it. The
      // product fails closed here; budgets stay as they are.
      let tableSignal: AbortSignal | undefined;
      const { cleanup, reason, groupSignals } = await cleanupWith(
        ({ signal } = {}) =>
          new Promise((resolve) => {
            tableSignal ??= signal;
            setTimeout(() => resolve(table), 10_000);
          }),
      );
      // A budget aborts the read with a TimeoutError, as AbortSignal.timeout does.
      expect(tableSignal?.aborted).toBe(true);
      const abortReason: unknown = tableSignal?.reason;
      expect(abortReason).toBeInstanceOf(DOMException);
      expect(abortReason instanceof DOMException && abortReason.name).toBe(
        'TimeoutError',
      );
      expect(groupSignals).toEqual([]);
      expect({ cleanup, reason }).toEqual({
        cleanup: 'unverified',
        reason: 'record-incomplete',
      });
    },
  );
});

describe('descendant reads of a member that is exiting', () => {
  // CAN-7026: on Linux a process that is exiting but not yet a zombie still
  // reads as running while its executable link is gone, so it reads as
  // unverifiable for a moment. The test command's `sleep 1` loop has a
  // member exiting every second.
  const exiting = (): (() => PlatformProcessIdentity) => {
    let reads = 0;
    return () => {
      reads += 1;
      return reads === 1
        ? { state: 'unverifiable', reason: 'executable path is unreadable' }
        : { state: 'absent' };
    };
  };

  it('keeps a trace complete when a descendant is unreadable while it exits', async () => {
    const row = (
      pid: number,
      ppid: number,
      pgid: number,
    ): PlatformProcessTableRow => ({
      pid,
      ppid,
      pgid,
      cpuPercent: 0,
      memoryRssBytes: 0,
      command: 'sh',
    });
    const table: PlatformProcessTable = {
      kind: 'sampled',
      rows: new Map([
        [100, row(100, 1, 100)],
        [200, row(200, 100, 200)],
        [201, row(201, 200, 200)],
      ]),
    };
    const sleepRead = exiting();
    let sleepReads = 0;
    const services = fakeSupervision({
      readProcessTable: () => Promise.resolve(table),
      identifyProcess: ({ pid }): Promise<PlatformProcessIdentity> => {
        if (pid === 201) {
          sleepReads += 1;
          return Promise.resolve(sleepRead());
        }
        return Promise.resolve({
          state: 'running',
          startIdentity: `linux:v1:${pid}:1`,
          processGroupId: 200,
          executablePath: '/bin/sh',
        });
      },
    });
    const into = new Map<number, Map<string, number>>();
    await expect(traceWithin(100, into, 2_000, services)).resolves.toBe(true);
    expect(into.get(200)).toEqual(new Map([['linux:v1:200:1', 200]]));
    expect(sleepReads).toBe(2);
  });

  it('reports no cleanup when a forced stop reads a group whose only recorded member is exiting', async () => {
    // A forced stop proves each group in one round, so the exiting member's
    // unreadable moment must be read again within that round.
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const read = exiting();
    const services = fakeSupervision({
      identifyProcess: (): Promise<PlatformProcessIdentity> =>
        Promise.resolve(read()),
    });
    await expect(
      reapDescendantGroups(
        new Map([[900, new Map([['linux:v1:901:1', 901]])]]),
        10,
        0,
        services,
      ),
    ).resolves.toBe('none');
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  it('counts a member gone, and signals nothing, when its pid is read again as a different process', async () => {
    // The re-read compares the recorded start identity, not just the pid: a
    // pid that now belongs to a process with another start time means the
    // recorded member is gone, and that new process is never signalled.
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    let reads = 0;
    const services = fakeSupervision({
      identifyProcess: (): Promise<PlatformProcessIdentity> => {
        reads += 1;
        return Promise.resolve(
          reads === 1
            ? { state: 'unverifiable', reason: 'executable path is unreadable' }
            : {
                state: 'running',
                startIdentity: 'linux:v1:901:2',
                processGroupId: 900,
                executablePath: '/bin/sh',
              },
        );
      },
    });
    await expect(
      reapDescendantGroups(
        new Map([[900, new Map([['linux:v1:901:1', 901]])]]),
        10,
        0,
        services,
      ),
    ).resolves.toBe('none');
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  it('names the missed deadline when a killed group is never proven gone', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const services = fakeSupervision({
      identifyProcess: (): Promise<PlatformProcessIdentity> =>
        Promise.resolve({
          state: 'running',
          startIdentity: 'linux:v1:901:1',
          processGroupId: 900,
          executablePath: '/bin/sh',
        }),
    });
    let result: unknown;
    const reaping = reapDescendantGroupsWithReason(
      new Map([[900, new Map([['linux:v1:901:1', 901]])]]),
      10,
      0,
      services,
    ).then((value) => {
      result = value;
    });
    for (let step = 0; step < 100 && result === undefined; step += 1)
      await jest.advanceTimersByTimeAsync(50);
    await reaping;
    expect(result).toEqual({
      cleanup: 'unverified',
      reason: 'verify-deadline',
    });
    expect(kill).toHaveBeenCalledWith(-900, 'SIGKILL');
    kill.mockRestore();
    jest.useRealTimers();
  });

  it('stays unverified when a member never reads absent within its budget', async () => {
    // Re-reading is bounded by the existing budget and never assumes the
    // member is gone: one that stays unreadable keeps the outcome unverified.
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const services = fakeSupervision({
      identifyProcess: (): Promise<PlatformProcessIdentity> =>
        Promise.resolve({
          state: 'unverifiable',
          reason: 'executable path is unreadable',
        }),
    });
    await expect(
      reapDescendantGroupsWithReason(
        new Map([[900, new Map([['linux:v1:901:1', 901]])]]),
        10,
        0,
        services,
      ),
    ).resolves.toEqual({ cleanup: 'unverified', reason: 'proof-inconclusive' });
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });
});
