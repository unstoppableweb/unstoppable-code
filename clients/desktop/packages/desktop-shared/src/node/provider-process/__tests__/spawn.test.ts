import type * as ChildProcessModule from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type {
  PlatformProcessGroup,
  PlatformProcessIdentity,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';
import { reapDescendantGroups } from '../descendant-groups';
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
    'stops a descendant in its own group and spares an unrelated one',
    async () => {
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
      // Lets the record start: a stop before it does drops it, and the
      // outcome is then unverified. One in flight is awaited at the stop.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await child.stop({ graceMs: 200 });
      await until(() => !present(command), 10_000);
      // CAN-6738: a SIGTERM-ignoring recorded group gets SIGKILL after the
      // grace, and only its proven absence reports `reaped`.
      expect(await child.stopCleanup?.()).toBe('reaped');
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
