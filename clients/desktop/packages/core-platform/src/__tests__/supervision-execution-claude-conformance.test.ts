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
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type * as Runtime from '@canopy/core-runtime';
import { createExecutionProcessServices } from '../supervision/execution-process';
import { OWNED_CHILD_FILE } from '../supervision/owned-child';

// The Claude process-host protocol as the backpressure and crash conformance
// fixture for execution processes: the adapter below serves it over the
// primitive, and each case replays a production worker behavior
// (apps/desktop-app/src/main/__tests__/claude-process-host-worker.test.ts)
// against real children on the host OS. The protocol shapes are restated
// here, since core-platform cannot import the app; the drift check compares
// them with the app's protocol source. win32 needs the owned-child addon, as
// in supervision-execution-process.test.ts.

const PROTOCOL = path.resolve(
  __dirname,
  '../../../execution-engine/src/node/agent-host/process/claude-process-host-protocol.ts',
);
const STDOUT_WINDOW_BYTES = 64 * 1024;

type Request =
  | {
      type: 'spawn';
      requestId: string;
      command: string;
      args: string[];
      cwd?: string;
      env: Record<string, string | undefined>;
      captureStderr?: boolean;
    }
  | { type: 'stdin'; requestId: string; dataBase64: string }
  | { type: 'stdin-end'; requestId: string }
  | { type: 'kill'; requestId: string; signal: NodeJS.Signals }
  | { type: 'stdout-ack'; requestId: string; bytes: number }
  | { type: 'shutdown' };

type Response =
  | { type: 'started'; requestId: string; pid: number }
  | { type: 'stdout'; requestId: string; dataBase64: string }
  | { type: 'stderr'; requestId: string; dataBase64: string }
  | {
      type: 'exit';
      requestId: string;
      code: number | null;
      signal: string | null;
    }
  | { type: 'error'; requestId: string; message: string }
  | { type: 'shutdown-complete' };

/**
 * The worker's request handling over execution processes: stdout is
 * forwarded within the protocol's credit window and acknowledged by the
 * runner, stderr is forwarded or drained, and exit follows the last stdout.
 */
function claudeHost(
  services: Runtime.PlatformExecutionProcessServices,
  cwd: string,
  post: (response: Response) => void,
): (request: Request) => void {
  const active = new Map<string, Runtime.PlatformExecutionProcess | null>();
  // The worker spawns synchronously; requests that arrive while a start is
  // pending wait for it, in order.
  const waiting = new Map<string, Request[]>();
  let shuttingDown = false;

  async function forward(
    requestId: string,
    output: Runtime.PlatformExecutionOutput | null,
    type: 'stdout' | 'stderr',
  ): Promise<void> {
    if (!output) return;
    for (;;) {
      const chunk = await output.read();
      if (chunk === null) return;
      post({
        type,
        requestId,
        dataBase64: Buffer.from(chunk).toString('base64'),
      });
      // stderr carries no runner credit.
      if (type === 'stderr') output.acknowledge(chunk.byteLength);
    }
  }

  async function run(
    request: Extract<Request, { type: 'spawn' }>,
  ): Promise<void> {
    const { requestId } = request;
    let child: Runtime.PlatformExecutionProcess;
    try {
      const environment: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.env))
        if (value !== undefined) environment[key] = value;
      child = await services.start({
        executable: request.command,
        args: request.args,
        cwd: request.cwd ?? cwd,
        environment,
        stdin: 'pipe',
        stderr: request.captureStderr ? 'pipe' : 'discard',
        outputWindowBytes: STDOUT_WINDOW_BYTES,
      });
    } catch (error) {
      active.delete(requestId);
      waiting.delete(requestId);
      post({ type: 'error', requestId, message: String(error) });
      return;
    }
    active.set(requestId, child);
    post({ type: 'started', requestId, pid: child.pid });
    const queued = waiting.get(requestId) ?? [];
    waiting.delete(requestId);
    queued.forEach(handle);
    await Promise.all([
      forward(requestId, child.stdout, 'stdout'),
      forward(requestId, child.stderr, 'stderr'),
    ]);
    const outcome = await child.outcome;
    active.delete(requestId);
    if (outcome.kind === 'lost')
      post({ type: 'error', requestId, message: 'lost' });
    else
      post({
        type: 'exit',
        requestId,
        code: outcome.code,
        signal: outcome.signal,
      });
  }

  function handle(request: Request): void {
    if (request.type === 'shutdown') {
      shuttingDown = true;
      void services
        .shutdown()
        .finally(() => post({ type: 'shutdown-complete' }));
      return;
    }
    const child = active.get(request.requestId);
    if (request.type === 'spawn') {
      if (shuttingDown || active.has(request.requestId)) {
        post({
          type: 'error',
          requestId: request.requestId,
          message: shuttingDown ? 'shutting down' : 'duplicate',
        });
        return;
      }
      active.set(request.requestId, null);
      void run(request);
    } else if (child === null)
      waiting.set(request.requestId, [
        ...(waiting.get(request.requestId) ?? []),
        request,
      ]);
    else if (!child) return;
    else if (request.type === 'stdin')
      void child.stdin
        ?.write(Buffer.from(request.dataBase64, 'base64'))
        .catch(() => undefined);
    else if (request.type === 'stdin-end') void child.stdin?.end();
    else if (request.type === 'kill')
      void child
        .terminate({
          mode: request.signal === 'SIGKILL' ? 'force' : 'graceful',
        })
        .catch(() => undefined);
    else if (request.type === 'stdout-ack' && request.bytes > 0)
      child.stdout.acknowledge(Math.floor(request.bytes));
  }
  return handle;
}

const os = ((): Runtime.PlatformOperatingSystem => {
  const platform: string = process.platform;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32')
    return platform;
  throw new Error(`unsupported test host ${platform}`);
})();
const windows = os === 'win32';
const acceptance = process.env.CANOPY_OWNED_CHILD_ACCEPTANCE === '1';
const ROOT = path.resolve(__dirname, '../../../..');
const run = promisify(execFile);

const FIXTURE = `
const [, , mode, ...rest] = process.argv;
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const hold = () => setInterval(() => undefined, 1 << 30);
const write = (stream, total, done) => {
  const chunk = Buffer.alloc(16384, 98);
  let sent = 0;
  const pump = () => {
    while (sent < total) {
      const n = Math.min(chunk.length, total - sent);
      sent += n;
      if (!stream.write(chunk.subarray(0, n))) return void stream.once('drain', pump);
    }
    if (done) done();
  };
  pump();
};
switch (mode) {
  case 'echo':
    process.stderr.write('stderr-bytes');
    process.stdin.pipe(process.stdout);
    break;
  case 'flood':
    write(process.stdout, Number(rest[0]));
    break;
  case 'noisy':
    write(process.stderr, 4 * 1024 * 1024, () => process.stdout.write('done'));
    break;
  case 'tree': {
    const child = spawn(process.execPath, [__filename, 'stubborn'], { stdio: 'ignore' });
    fs.writeFileSync(rest[0] + '.tmp', String(child.pid));
    fs.renameSync(rest[0] + '.tmp', rest[0]);
    process.on('SIGTERM', () => undefined);
    hold();
    break;
  }
  case 'stubborn':
    process.on('SIGTERM', () => undefined);
    hold();
    break;
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
let responses: Response[] = [];
let send: (request: Request) => void = () => undefined;
let services: Runtime.PlatformExecutionProcessServices;
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

async function until(
  check: () => boolean,
  label: string,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await delay(10);
  }
}

function env(): Record<string, string> {
  if (!windows) return { PATH: '/usr/bin:/bin' };
  const out: Record<string, string> = {};
  for (const key of ['SystemRoot', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value) out[key] = value;
  }
  return out;
}

const spawnRequest = (
  requestId: string,
  mode: string,
  args: string[] = [],
  captureStderr = true,
): Request => ({
  type: 'spawn',
  requestId,
  command: process.execPath,
  args: [fixture, mode, ...args],
  cwd: dir,
  env: env(),
  captureStderr,
});

const of = (requestId: string, type?: Response['type']): Response[] =>
  responses.filter(
    (response) =>
      'requestId' in response &&
      response.requestId === requestId &&
      (type === undefined || response.type === type),
  );

const stdoutBytes = (requestId: string): number =>
  of(requestId, 'stdout').reduce(
    (sum, response) =>
      sum +
      ('dataBase64' in response
        ? Buffer.from(response.dataBase64, 'base64').byteLength
        : 0),
    0,
  );

const started = async (requestId: string): Promise<number> => {
  await until(() => of(requestId, 'started').length > 0, `${requestId} start`);
  const [response] = of(requestId, 'started');
  return response.type === 'started' ? response.pid : 0;
};

const exited = (requestId: string): Promise<void> =>
  until(() => of(requestId, 'exit').length > 0, `${requestId} exit`);

async function pidFrom(file: string): Promise<number> {
  let pid = 0;
  await until(() => {
    try {
      pid = Number(readFileSync(file, 'utf8'));
    } catch {
      pid = 0;
    }
    return pid > 1;
  }, 'grandchild');
  strays.add(pid);
  return pid;
}

async function windowsAddon(): Promise<string> {
  const value = process.env.CANOPY_OWNED_CHILD_ADDON;
  const prebuilt = value ? path.resolve(ROOT, value) : undefined;
  if (prebuilt && existsSync(prebuilt)) return prebuilt;
  if (acceptance)
    throw new Error('Owned-child acceptance requires CANOPY_OWNED_CHILD_ADDON');
  const out = path.join(
    ROOT,
    '.cache',
    'native-owned-child',
    `claude-conformance-${process.pid}`,
    OWNED_CHILD_FILE,
  );
  mkdirSync(path.dirname(out), { recursive: true });
  await run(
    process.execPath,
    [path.join(ROOT, 'scripts', 'build-owned-child.mjs'), '--out', out],
    { cwd: ROOT, windowsHide: true, timeout: 540_000, maxBuffer: 1 << 24 },
  );
  return out;
}

beforeAll(async () => {
  dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'claude-host-')),
  );
  fixture = path.join(dir, 'fixture.js');
  writeFileSync(fixture, FIXTURE);
  if (windows) nativePath = await windowsAddon();
}, 600_000);

beforeEach(() => {
  responses = [];
  services = createExecutionProcessServices({ os, nativePath });
  send = claudeHost(services, dir, (response) => responses.push(response));
});

afterEach(async () => {
  await services.shutdown().catch(() => undefined);
  for (const pid of Array.from(strays))
    try {
      if (present(pid)) process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  strays.clear();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Claude process-host conformance', () => {
  it('restates the app protocol', () => {
    const source = readFileSync(PROTOCOL, 'utf8');
    const literals = (block: string): string[] =>
      Array.from(
        block.matchAll(/type: '([a-z-]+)'/g),
        (match) => match[1],
      ).sort();
    const requests = [
      'kill',
      'shutdown',
      'spawn',
      'stdin',
      'stdin-end',
      'stdout-ack',
    ];
    const responseTypes = [
      'error',
      'exit',
      'shutdown-complete',
      'started',
      'stderr',
      'stdout',
    ];
    expect(literals(source)).toEqual([...requests, ...responseTypes].sort());
    expect(source).toContain(
      'CLAUDE_PROCESS_HOST_STDOUT_WINDOW_BYTES = 64 * 1024',
    );
  });

  it('drains stderr without forwarding it when capture is disabled', async () => {
    send(spawnRequest('quiet', 'noisy', [], false));
    await exited('quiet');
    expect(of('quiet', 'stderr')).toEqual([]);
    expect(of('quiet', 'exit')).toEqual([
      { type: 'exit', requestId: 'quiet', code: 0, signal: null },
    ]);
  });

  it('preserves stdin, stdout and stderr bytes', async () => {
    send(spawnRequest('echo', 'echo'));
    await started('echo');
    const bytes = Buffer.from([0, 1, 255, 10]);
    send({
      type: 'stdin',
      requestId: 'echo',
      dataBase64: bytes.toString('base64'),
    });
    send({ type: 'stdin-end', requestId: 'echo' });
    await exited('echo');
    const out = Buffer.concat(
      of('echo', 'stdout').map((r) =>
        Buffer.from('dataBase64' in r ? r.dataBase64 : '', 'base64'),
      ),
    );
    const err = Buffer.concat(
      of('echo', 'stderr').map((r) =>
        Buffer.from('dataBase64' in r ? r.dataBase64 : '', 'base64'),
      ),
    );
    expect(out).toEqual(bytes);
    expect(err.toString()).toBe('stderr-bytes');
    // Exit comes last, after every stdout chunk.
    expect(of('echo').at(-1)).toEqual({
      type: 'exit',
      requestId: 'echo',
      code: 0,
      signal: null,
    });
  });

  it('kills only the addressed process tree', async () => {
    const files = [path.join(dir, 'kill-a'), path.join(dir, 'kill-b')];
    send(spawnRequest('a', 'tree', [files[0]]));
    send(spawnRequest('b', 'tree', [files[1]]));
    const [rootA, rootB] = await Promise.all([started('a'), started('b')]);
    const [grandA, grandB] = await Promise.all(files.map(pidFrom));
    send({ type: 'kill', requestId: 'a', signal: 'SIGKILL' });
    await exited('a');
    await until(() => !present(grandA) && !present(rootA), 'a tree gone');
    expect(present(rootB)).toBe(true);
    expect(present(grandB)).toBe(true);
    expect(of('b', 'exit')).toEqual([]);
  });

  it('bounds unacknowledged stdout to the window, per child', async () => {
    send(spawnRequest('x', 'flood', [String(1024 * 1024)]));
    send(spawnRequest('y', 'flood', [String(1024 * 1024)]));
    await until(
      () =>
        stdoutBytes('x') === STDOUT_WINDOW_BYTES &&
        stdoutBytes('y') === STDOUT_WINDOW_BYTES,
      'both windows full',
    );
    await delay(300);
    expect(stdoutBytes('x')).toBe(STDOUT_WINDOW_BYTES);
    expect(stdoutBytes('y')).toBe(STDOUT_WINDOW_BYTES);
    // Credit for one child moves only that child.
    send({ type: 'stdout-ack', requestId: 'x', bytes: STDOUT_WINDOW_BYTES });
    await until(
      () => stdoutBytes('x') === 2 * STDOUT_WINDOW_BYTES,
      'x second window',
    );
    await delay(100);
    expect(stdoutBytes('y')).toBe(STDOUT_WINDOW_BYTES);
    // Acknowledge whatever arrived; the outstanding bytes never pass the window.
    let acked = 2 * STDOUT_WINDOW_BYTES;
    send({ type: 'stdout-ack', requestId: 'x', bytes: STDOUT_WINDOW_BYTES });
    while (of('x', 'exit').length === 0) {
      const outstanding = stdoutBytes('x') - acked;
      expect(outstanding).toBeLessThanOrEqual(STDOUT_WINDOW_BYTES);
      if (outstanding > 0) {
        send({ type: 'stdout-ack', requestId: 'x', bytes: outstanding });
        acked += outstanding;
      }
      await delay(2);
    }
    expect(stdoutBytes('x')).toBe(1024 * 1024);
    await exited('x');
    expect(of('x', 'exit')).toEqual([
      { type: 'exit', requestId: 'x', code: 0, signal: null },
    ]);
  });

  it('releases a killed child whose stdout is blocked on credit', async () => {
    send(spawnRequest('blocked', 'flood', [String(64 * 1024 * 1024)]));
    await until(
      () => stdoutBytes('blocked') === STDOUT_WINDOW_BYTES,
      'window full',
    );
    send({ type: 'kill', requestId: 'blocked', signal: 'SIGTERM' });
    await exited('blocked');
    expect(of('blocked', 'exit')).toHaveLength(1);
    expect(of('blocked', 'error')).toEqual([]);
  });

  it('releases a credit-blocked child killed after it already exited', async () => {
    send(spawnRequest('done', 'flood', [String(STDOUT_WINDOW_BYTES + 4096)]));
    const pid = await started('done');
    await until(() => !present(pid), 'root exit');
    await delay(50);
    expect(of('done', 'exit')).toEqual([]);
    send({ type: 'kill', requestId: 'done', signal: 'SIGTERM' });
    await exited('done');
    expect(of('done', 'exit')).toEqual([
      { type: 'exit', requestId: 'done', code: 0, signal: null },
    ]);
  });

  it('reports a crashed child once and keeps serving others', async () => {
    send(spawnRequest('crash', 'crash'));
    send(spawnRequest('steady', 'echo'));
    await exited('crash');
    expect(of('crash', 'exit')).toEqual([
      windows
        ? { type: 'exit', requestId: 'crash', code: 0xc0000005, signal: null }
        : { type: 'exit', requestId: 'crash', code: null, signal: 'SIGSEGV' },
    ]);
    send({ type: 'stdin-end', requestId: 'steady' });
    await exited('steady');
    expect(of('steady', 'exit')).toHaveLength(1);
  });

  it('kills every active tree before shutdown completes', async () => {
    const files = [path.join(dir, 'down-a'), path.join(dir, 'down-b')];
    send(spawnRequest('a', 'tree', [files[0]]));
    send(spawnRequest('b', 'tree', [files[1]]));
    const roots = await Promise.all([started('a'), started('b')]);
    const grandchildren = await Promise.all(files.map(pidFrom));
    send({ type: 'shutdown' });
    await until(
      () => responses.some((r) => r.type === 'shutdown-complete'),
      'shutdown',
    );
    for (const pid of [...roots, ...grandchildren])
      expect(present(pid)).toBe(false);
    send(spawnRequest('late', 'sleep'));
    expect(of('late', 'error')).toHaveLength(1);
  });

  it('reports spawn failures without affecting later requests', async () => {
    send({
      ...spawnRequest('missing', 'sleep'),
      command: path.join(dir, windows ? 'missing.exe' : 'missing'),
    } as Request);
    await until(() => of('missing', 'error').length > 0, 'spawn error');
    expect(of('missing', 'started')).toEqual([]);
    send(spawnRequest('after', 'echo'));
    send({ type: 'stdin-end', requestId: 'after' });
    await exited('after');
    expect(of('after', 'exit')).toEqual([
      { type: 'exit', requestId: 'after', code: 0, signal: null },
    ]);
  });
});
