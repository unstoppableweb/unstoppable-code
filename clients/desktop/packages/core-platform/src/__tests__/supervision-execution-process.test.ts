import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import type * as Runtime from '@canopy/core-runtime';
import {
  createExecutionProcessServices,
  ExecutionProcessError,
} from '../supervision/execution-process';
import {
  createJobLauncher,
  OWNED_CHILD_FILE,
} from '../supervision/owned-child';
import { LIBUV_REQUIRED_KEYS } from '../supervision/shared';

// Real execution children on the host OS, under plain Node (no Electron).
// darwin and linux need nothing native. win32 needs the owned-child addon:
// the suite builds it when missing, and CANOPY_OWNED_CHILD_ACCEPTANCE=1 (the
// PlatformServices job) requires the prebuilt CANOPY_OWNED_CHILD_ADDON.

const os = ((): Runtime.PlatformOperatingSystem => {
  const platform: string = process.platform;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32')
    return platform;
  throw new Error(`unsupported test host ${platform}`);
})();
const windows = os === 'win32';
const acceptance = process.env.CANOPY_OWNED_CHILD_ACCEPTANCE === '1';
const ROOT = path.resolve(__dirname, '../../../..');
const MODULE = path.resolve(__dirname, '../supervision/execution-process.ts');
const BUILD = path.join(ROOT, 'scripts', 'build-owned-child.mjs');
const run = promisify(execFile);

// One script, several behaviors. PID files are renamed into place whole.
const FIXTURE = `
const [, , mode, ...rest] = process.argv;
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const hold = () => setInterval(() => undefined, 1 << 30);
// Node's Windows children die with their parent's libuv job; detached ones
// outlive the root yet stay in the owned job. POSIX detached would leave the group.
const outlive = process.platform === 'win32';
const stubborn = () => {
  const child = spawn(process.execPath, [__filename, 'stubborn'], { stdio: 'ignore', detached: outlive });
  fs.writeFileSync(rest[0] + '.tmp', String(child.pid));
  fs.renameSync(rest[0] + '.tmp', rest[0]);
};
switch (mode) {
  case 'eager': {
    // The first thing the root does: a descendant as early as it can be,
    // which on win32 also leaves the root's own libuv job.
    const child = spawn(process.execPath, [__filename, 'stubborn'], { stdio: 'ignore', detached: outlive });
    fs.writeFileSync(rest[0] + '.tmp', String(child.pid));
    fs.renameSync(rest[0] + '.tmp', rest[0]);
    hold();
    break;
  }
  case 'env':
    process.stdout.write(JSON.stringify(process.env));
    break;
  case 'argc':
    process.stdout.write(String(rest.length));
    break;
  case 'echo':
    process.stderr.write('diagnostic');
    process.stdin.pipe(process.stdout);
    process.stdin.on('end', () => { process.exitCode = 3; });
    break;
  case 'flood': {
    const total = Number(rest[0]);
    const chunk = Buffer.alloc(16384, 97);
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        const n = Math.min(chunk.length, total - sent);
        sent += n;
        if (!process.stdout.write(chunk.subarray(0, n))) return void process.stdout.once('drain', pump);
      }
    };
    pump();
    break;
  }
  case 'tree':
    stubborn();
    process.on('SIGTERM', () => undefined);
    hold();
    break;
  case 'survivor':
    stubborn();
    process.exit(0);
    break;
  case 'stubborn':
    process.on('SIGTERM', () => undefined);
    hold();
    break;
  case 'inheritor': {
    // Output is already queued, and the pipe paused, when the root exits.
    process.stdout.write('x');
    const child = spawn(process.execPath, [__filename, 'writer', rest[0]], { stdio: ['ignore', 'inherit', 'ignore'], detached: outlive });
    fs.writeFileSync(rest[0] + '.tmp', String(child.pid));
    fs.renameSync(rest[0] + '.tmp', rest[0]);
    setTimeout(() => process.exit(0), 200);
    break;
  }
  case 'writer': {
    const chunk = Buffer.alloc(65536, 99);
    let sent = 0;
    const pump = () => {
      while (sent < 8 * 1024 * 1024) {
        sent += chunk.length;
        if (!process.stdout.write(chunk)) return void process.stdout.once('drain', pump);
      }
      fs.writeFileSync(rest[0] + '.done', '');
      hold();
    };
    // Starts once the root has exited and Node has flushed its pipes.
    setTimeout(pump, 600);
    break;
  }
  case 'crash':
    if (process.platform === 'win32') process.exit(-1073741819);
    process.kill(process.pid, 'SIGSEGV');
    break;
  case 'sleep':
    hold();
    break;
}
`;

let dir = '';
let fixture = '';
let nativePath: string | undefined;
let services: Runtime.PlatformExecutionProcessServices;
const started = new Set<Runtime.PlatformExecutionProcess>();
/** Grandchild PIDs, stopped directly if a case fails before cleanup. */
const strays = new Set<number>();

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function present(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), 'code') === 'EPERM';
  }
}

async function until<T>(
  read: () => T | undefined,
  label: string,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await delay(10);
  }
}

function pidFrom(file: string): Promise<number> {
  return until(
    () => {
      try {
        const pid = Number(readFileSync(file, 'utf8'));
        if (pid > 1) {
          strays.add(pid);
          return pid;
        }
      } catch {
        /* not written yet */
      }
      return undefined;
    },
    `pid in ${path.basename(file)}`,
  );
}

function environment(): Record<string, string> {
  const pick = (key: string): Record<string, string> => {
    const value = process.env[key];
    return value ? { [key]: value } : {};
  };
  return windows
    ? { ...pick('SystemRoot'), ...pick('TEMP'), ...pick('TMP') }
    : { PATH: '/usr/bin:/bin' };
}

async function start(
  mode: string,
  args: string[] = [],
  request: Partial<Runtime.PlatformExecutionRequest> = {},
): Promise<Runtime.PlatformExecutionProcess> {
  const child = await services.start({
    executable: process.execPath,
    args: [fixture, mode, ...args],
    cwd: dir,
    environment: environment(),
    ...request,
  });
  started.add(child);
  return child;
}

/** Reads to the end, acknowledging each chunk. */
async function collect(
  output: Runtime.PlatformExecutionOutput | null,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  if (!output) return Buffer.alloc(0);
  for (;;) {
    const chunk = await output.read();
    if (chunk === null) return Buffer.concat(chunks);
    chunks.push(Buffer.from(chunk));
    output.acknowledge(chunk.byteLength);
  }
}

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

/** The addon on win32: prebuilt (required in acceptance) or built here. */
async function windowsAddon(): Promise<string> {
  const value = process.env.CANOPY_OWNED_CHILD_ADDON;
  const prebuilt = value ? path.resolve(ROOT, value) : undefined;
  if (prebuilt && existsSync(prebuilt)) return prebuilt;
  if (acceptance)
    throw new Error('Owned-child acceptance requires CANOPY_OWNED_CHILD_ADDON');
  // Loaded addons stay mapped on Windows, so they live outside `dir`.
  const out = path.join(
    ROOT,
    '.cache',
    'native-owned-child',
    `execution-${process.pid}`,
    OWNED_CHILD_FILE,
  );
  mkdirSync(path.dirname(out), { recursive: true });
  await run(process.execPath, [BUILD, '--out', out], {
    cwd: ROOT,
    windowsHide: true,
    timeout: 540_000,
    maxBuffer: 1 << 24,
  });
  return out;
}

beforeAll(async () => {
  dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'execution-')),
  );
  fixture = path.join(dir, 'fixture.js');
  writeFileSync(fixture, FIXTURE);
  if (windows) nativePath = await windowsAddon();
}, 600_000);

beforeEach(() => {
  services = createExecutionProcessServices({ os, nativePath });
});

afterEach(async () => {
  await Promise.allSettled(
    Array.from(started, (child) => child.terminate({ mode: 'force' })),
  );
  started.clear();
  for (const pid of Array.from(strays)) {
    try {
      if (present(pid)) process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  strays.clear();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('execution processes', () => {
  (windows ? it : it.skip)(
    'shares one lazy native launcher without sharing shutdown custody between services',
    async () => {
      const launcher = createJobLauncher({ os, nativePath: nativePath ?? '' });
      const load = jest.spyOn(process, 'dlopen');
      const first = createExecutionProcessServices({
        os,
        windowsLauncher: launcher,
      });
      const second = createExecutionProcessServices({
        os,
        windowsLauncher: launcher,
      });
      const request: Runtime.PlatformExecutionRequest = {
        executable: process.execPath,
        args: [fixture, 'echo'],
        cwd: dir,
        environment: environment(),
        stdin: 'pipe',
      };
      try {
        const [a, b] = await Promise.all([
          first.start(request),
          second.start(request),
        ]);
        expect(a.pid).not.toBe(b.pid);
        expect(load).toHaveBeenCalledTimes(1);
        await first.shutdown();
        await expect(a.outcome).resolves.toMatchObject({ kind: 'cancelled' });
        const stdin = b.stdin;
        if (!stdin) throw new Error('no stdin');
        const [out, err] = await Promise.all([
          collect(b.stdout),
          collect(b.stderr),
          stdin
            .write(Buffer.from('still owned by second'))
            .then(() => stdin.end()),
        ]);
        expect(out.toString()).toBe('still owned by second');
        expect(err.toString()).toBe('diagnostic');
        await expect(b.outcome).resolves.toMatchObject({
          kind: 'exited',
          code: 3,
        });
        await second.shutdown();
      } finally {
        await Promise.allSettled([first.shutdown(), second.shutdown()]);
        load.mockRestore();
      }
    },
  );

  it('round-trips stdin, keeps stderr separate and reports the exit once', async () => {
    const child = await start('echo', [], { stdin: 'pipe' });
    expect(child.pid).toBeGreaterThan(1);
    const stdin = child.stdin;
    if (!stdin) throw new Error('no stdin');
    const bytes = Buffer.from([0, 1, 2, 255, 10]);
    const [out, err] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      stdin.write(bytes).then(() => stdin.end()),
    ]);
    expect(out).toEqual(bytes);
    expect(err.toString('utf8')).toBe('diagnostic');
    await expect(child.outcome).resolves.toEqual({
      kind: 'exited',
      code: 3,
      signal: null,
      output: 'complete',
    });
    await expect(stdin.write(bytes)).rejects.toEqual(
      typed('failed_precondition'),
    );
  });

  it('gives the child exactly the requested environment', async () => {
    const child = await start('env');
    const parsed: unknown = JSON.parse(
      (await collect(child.stdout)).toString(),
    );
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null;
    if (!record(parsed)) throw new Error('no environment printed');
    const seen = parsed;
    const requested = environment();
    // macOS CoreFoundation sets this inside every process it loads in, and
    // Windows children get libuv's required keys empty, as Node gives them.
    const upper = new Set(Object.keys(requested).map((k) => k.toUpperCase()));
    const padded = windows
      ? LIBUV_REQUIRED_KEYS.filter((key) => !upper.has(key))
      : [];
    const added = new Set(['__CF_USER_TEXT_ENCODING']);
    const own = Object.fromEntries(
      Object.entries(seen).filter(([key]) => !added.has(key)),
    );
    expect(own).toEqual({
      ...requested,
      ...Object.fromEntries(padded.map((key) => [key, ''])),
    });
  });

  it('passes thousands of arguments, as Node spawn does', async () => {
    const child = await start(
      'argc',
      Array.from({ length: 5000 }, () => 'a'),
    );
    expect((await collect(child.stdout)).toString()).toBe('5000');
    await expect(child.outcome).resolves.toMatchObject({ kind: 'exited' });
  });

  it('never has more than the window of unacknowledged output outstanding', async () => {
    const total = 1024 * 1024;
    const window = 16 * 1024;
    const child = await start('flood', [String(total)], {
      outputWindowBytes: window,
      stderr: 'discard',
    });
    expect(child.stderr).toBeNull();
    let held = 0;
    while (held < window) {
      const chunk = await child.stdout.read();
      if (!chunk) throw new Error('ended early');
      held += chunk.byteLength;
    }
    expect(held).toBe(window);
    // Without credit the next read waits, however much the child has written.
    let extra = false;
    const pending = child.stdout.read().then((chunk) => {
      extra = true;
      return chunk;
    });
    await delay(300);
    expect(extra).toBe(false);
    child.stdout.acknowledge(held);
    const next = await pending;
    let received = held + (next?.byteLength ?? 0);
    child.stdout.acknowledge(next?.byteLength ?? 0);
    received += (await collect(child.stdout)).byteLength;
    expect(received).toBe(total);
    await expect(child.outcome).resolves.toMatchObject({
      kind: 'exited',
      code: 0,
      output: 'complete',
    });
  });

  it('delivers the terminal outcome when output is never read', async () => {
    const child = await start('flood', [String(64 * 1024 * 1024)], {
      outputWindowBytes: 1,
    });
    await delay(200);
    await child.terminate();
    const outcome = await child.outcome;
    expect(outcome).toMatchObject({ kind: 'cancelled', output: 'discarded' });
    // A stopped tree reports the signal on every host; Windows reports SIGKILL.
    expect(outcome.signal).not.toBeNull();
    if (windows)
      expect(outcome).toMatchObject({ code: null, signal: 'SIGKILL' });
    await expect(child.stdout.read()).resolves.toBeNull();
  });

  it('keeps the exit status of a root that ended before its unread output was discarded', async () => {
    const child = await start('flood', [String(32 * 1024)], {
      outputWindowBytes: 1,
    });
    // Node drains the pipe into the bounded queue, so the root can finish.
    await until(() => (present(child.pid) ? undefined : true), 'root exit');
    let settled = false;
    void child.outcome.then(() => (settled = true));
    await delay(100);
    expect(settled).toBe(false);
    await child.terminate();
    await expect(child.outcome).resolves.toEqual({
      kind: 'exited',
      code: 0,
      signal: null,
      output: 'discarded',
    });
  });

  it('keeps output bounded when a descendant writes to the pipe of an exited root', async () => {
    const file = path.join(dir, 'inheritor');
    const child = await start('inheritor', [file], { outputWindowBytes: 1 });
    const writer = await pidFrom(file);
    await until(() => (present(child.pid) ? undefined : true), 'root exit');
    // Without credit the writer blocks long before its 8 MiB are queued.
    await delay(1_500);
    expect(existsSync(`${file}.done`)).toBe(false);
    expect(present(writer)).toBe(true);
    await child.terminate({ mode: 'force' });
    expect(present(writer)).toBe(false);
    await expect(child.outcome).resolves.toMatchObject({
      kind: 'exited',
      code: 0,
      output: 'discarded',
    });
  }, 15_000);

  it.each<Runtime.PlatformStopMode>(['graceful', 'force'])(
    'stops the whole tree on a %s terminate, TERM-ignoring members included',
    async (mode) => {
      const file = path.join(dir, `tree-${mode}`);
      const child = await start('tree', [file]);
      const grandchild = await pidFrom(file);
      await Promise.all([child.terminate({ mode }), child.terminate({ mode })]);
      expect(present(grandchild)).toBe(false);
      expect(present(child.pid)).toBe(false);
      await expect(child.outcome).resolves.toMatchObject({ kind: 'cancelled' });
      await expect(child.terminate()).resolves.toBeUndefined();
    },
    15_000,
  );

  it.each(['terminate', 'shutdown'] as const)(
    'stops a descendant the root starts first thing, through %s',
    async (via) => {
      const file = path.join(dir, `eager-${via}`);
      const child = await start('eager', [file]);
      const grandchild = await pidFrom(file);
      if (via === 'terminate') await child.terminate({ mode: 'force' });
      else await services.shutdown();
      expect(present(grandchild)).toBe(false);
      expect(present(child.pid)).toBe(false);
      await expect(child.outcome).resolves.toMatchObject({ kind: 'cancelled' });
    },
  );

  (windows ? it : it.skip)(
    'runs nothing of a win32 child before its pipes are connected and it is resumed',
    async () => {
      const launcher = createJobLauncher({ os, nativePath: nativePath ?? '' });
      const file = path.join(dir, 'suspended');
      const tree = launcher.launch({
        executable: process.execPath,
        argv: [process.execPath, fixture, 'eager', file],
        cwd: dir,
        environment: environment(),
        stdin: false,
      });
      const sockets = [tree.pipes.stdout, tree.pipes.stderr].map((pipe) =>
        connect(pipe),
      );
      try {
        await Promise.all(
          sockets.map(
            (socket) =>
              new Promise((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('error', reject);
              }),
          ),
        );
        await delay(500);
        expect(existsSync(file)).toBe(false);
        tree.resume();
        const grandchild = await pidFrom(file);
        await tree.stop();
        expect(present(grandchild)).toBe(false);
        expect(present(tree.pid)).toBe(false);
        await expect(tree.exited).resolves.toEqual({
          code: null,
          signal: 'SIGKILL',
        });
      } finally {
        sockets.forEach((socket) => socket.destroy());
        await tree.stop();
      }
    },
  );

  (windows ? it : it.skip)(
    'refuses to resume a win32 child whose pipes this process did not connect',
    async () => {
      const launcher = createJobLauncher({ os, nativePath: nativePath ?? '' });
      const file = path.join(dir, 'unconnected');
      const tree = launcher.launch({
        executable: process.execPath,
        argv: [process.execPath, fixture, 'eager', file],
        cwd: dir,
        environment: environment(),
        stdin: false,
      });
      try {
        let refused: unknown;
        try {
          tree.resume();
        } catch (error) {
          refused = error;
        }
        expect(refused).toMatchObject({ code: 'failed_precondition' });
      } finally {
        await tree.stop();
      }
      expect(present(tree.pid)).toBe(false);
      expect(existsSync(file)).toBe(false);
    },
  );

  it('keeps custody of survivors after the root exits until terminate', async () => {
    const file = path.join(dir, 'survivor');
    const child = await start('survivor', [file]);
    const grandchild = await pidFrom(file);
    await expect(child.outcome).resolves.toEqual({
      kind: 'exited',
      code: 0,
      signal: null,
      output: 'complete',
    });
    expect(present(grandchild)).toBe(true);
    await child.terminate();
    expect(present(grandchild)).toBe(false);
  });

  it('shuts down every owned tree and refuses later starts', async () => {
    const files = [path.join(dir, 'shutdown-a'), path.join(dir, 'shutdown-b')];
    const children = await Promise.all(
      files.map((file) => start('tree', [file])),
    );
    const grandchildren = await Promise.all(files.map(pidFrom));
    await services.shutdown();
    for (const pid of [...grandchildren, ...children.map((c) => c.pid)])
      expect(present(pid)).toBe(false);
    for (const child of children)
      await expect(child.outcome).resolves.toMatchObject({ kind: 'cancelled' });
    expect(await rejection(() => start('sleep'))).toEqual(
      typed('failed_precondition'),
    );
  });

  it('reports a crash distinctly from an exit', async () => {
    const child = await start('crash');
    await expect(child.outcome).resolves.toEqual(
      windows
        ? {
            kind: 'crashed',
            code: 0xc0000005,
            signal: null,
            output: 'complete',
          }
        : {
            kind: 'crashed',
            code: null,
            signal: 'SIGSEGV',
            output: 'complete',
          },
    );
  });

  it('rejects a start that creates no process and serves later starts', async () => {
    const missing = path.join(dir, windows ? 'missing.exe' : 'missing');
    const error = await rejection(() =>
      services.start({
        executable: missing,
        args: [],
        cwd: dir,
        environment: environment(),
      }),
    );
    expect(error).toBeInstanceOf(ExecutionProcessError);
    expect(error).toEqual(typed('failed_precondition'));
    const child = await start('crash');
    await expect(child.outcome).resolves.toMatchObject({ kind: 'crashed' });
  });

  it.each<[string, Partial<Runtime.PlatformExecutionRequest>]>([
    ['relative executable', { executable: 'node' }],
    ['relative cwd', { cwd: 'work' }],
    ['NUL argument', { args: ['\0'] }],
    ['empty environment name', { environment: { '': 'x' } }],
    ['zero window', { outputWindowBytes: 0 }],
    ['oversized window', { outputWindowBytes: 2 * 1024 * 1024 }],
    ['unknown stdin', { stdin: 'inherit' as 'pipe' }],
  ])('rejects a %s before starting anything', async (_, change) => {
    const error = await rejection(() =>
      services.start({
        executable: process.execPath,
        args: [fixture, 'sleep'],
        cwd: dir,
        environment: environment(),
        ...change,
      }),
    );
    expect(error).toEqual(typed('invalid_argument'));
  });

  it('force-stops owned trees when the host exits', async () => {
    const host = path.join(dir, 'host.mjs');
    const entry = path.join(dir, 'host-entry.ts');
    writeFileSync(
      entry,
      `import { createExecutionProcessServices } from ${JSON.stringify(MODULE)};
const [, , fixture, file, nativePath] = process.argv;
const services = createExecutionProcessServices({ os: ${JSON.stringify(os)}, nativePath: nativePath || undefined });
const child = await services.start({ executable: process.execPath, args: [fixture, 'tree', file], cwd: ${JSON.stringify(dir)}, environment: ${JSON.stringify(environment())} });
process.stdout.write(String(child.pid));
const { existsSync } = await import('node:fs');
while (!existsSync(file)) await new Promise((r) => setTimeout(r, 10));
process.exit(7);
`,
    );
    buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: host,
      logLevel: 'silent',
    });
    const file = path.join(dir, 'host-tree');
    const [code, stdout] = await new Promise<[number, string]>((resolve) =>
      execFile(
        process.execPath,
        [host, fixture, file, nativePath ?? ''],
        { timeout: 20_000, windowsHide: true },
        (error, out) =>
          resolve([error ? Number(Reflect.get(error, 'code')) : 0, out]),
      ),
    );
    expect(code).toBe(7);
    const root = Number(stdout);
    const grandchild = await pidFrom(file);
    await until(
      () => (present(root) || present(grandchild) ? undefined : true),
      'tree gone after host exit',
      5_000,
    );
  }, 30_000);
});
