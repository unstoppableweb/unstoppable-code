import { randomUUID } from 'node:crypto';
import type * as ChildProcessModule from 'node:child_process';
import {
  spawn as spawnOwnedChild,
  type ChildProcess,
} from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ConnectedExecutionHostChannel } from '@canopy/desktop-shared/node/execution-host/channel';
import {
  ReportedExecutionHost,
  type ExecutionHostPort,
  type ExecutionHostProcess,
} from '@canopy/desktop-shared/node/execution-host/port';
import type {
  ProviderProcess,
  ProviderProcessError,
  ProviderProcessOwner,
  ProviderProcessRequest,
} from '@canopy/desktop-shared/node/provider-process/spawn';
import {
  serveProviderProcessHost,
  startProviderProcessHost,
  type ProviderProcessHostChildSnapshot,
  type ProviderProcessHostHandle,
} from '@canopy/execution-engine/node/agent-host/process/provider-process-host/host';
import {
  isProviderProcessHostRequest,
  isProviderProcessHostResponse,
  PROVIDER_PROCESS_STDERR_LIMIT_BYTES,
  PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
  type ProviderProcessHostRequest,
} from '@canopy/execution-engine/node/agent-host/process/provider-process-host/protocol';
import {
  createProviderProcessHostClient,
  type ProviderProcessHostClient,
} from '@canopy/execution-engine/node/agent-host/process/provider-process-host/runner';
import { startOwnedProviderProcessHost } from './helpers/owned-provider-process-host';

// The provider process host qualified in process (a fake parent port, as the
// utility adapter delivers `{ data }`) and as a real child over the
// owned-process port (the daemon's). Owned-process cases are darwin and linux
// only; the port's own suite covers win32.

type Mode = 'in-process' | 'owned-process';
const posix = process.platform !== 'win32';
const MODES: readonly Mode[] = posix
  ? ['in-process', 'owned-process']
  : ['in-process'];
const describePosix = posix ? describe : describe.skip;
const itPosix = posix ? it : it.skip;

jest.setTimeout(60_000);

let dir = '';
const strays = new Set<number>();
/** Idle children that a case started to give a fake host a real pid. */
const ownedChildren = new Set<ChildProcess>();

/**
 * Starts an idle child that this test owns. A fake host takes this real pid,
 * never a literal one, so a signal path that reads it can reach only a
 * process the test started. afterEach stops it by its own handle.
 */
async function startOwnedIdleChild(): Promise<number> {
  const child = spawnOwnedChild(
    process.execPath,
    ['-e', 'setInterval(() => undefined, 1 << 30)'],
    { stdio: 'ignore' },
  );
  ownedChildren.add(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const { pid } = child;
  if (pid === undefined || pid <= 1) throw new Error('owned child has no pid');
  return pid;
}

/** Stops a child this test started, by its own handle, and waits for it. */
async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  child.kill('SIGKILL');
  await exited;
}

function present(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
  }
}

/** A stray can be reaped between any check and the kill; gone is done. */
function killStray(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    // Node's errors come from outside the test realm, so not `instanceof`.
    const gone =
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'ESRCH';
    if (!gone) throw error;
  }
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with `promise`, or rejects once `ms` pass first. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const OWNER: ProviderProcessOwner = { kind: 'turn', id: 'host-qualification' };

function request(
  args: string[],
  overrides: Partial<ProviderProcessRequest> = {},
): ProviderProcessRequest {
  return {
    command: process.execPath,
    args,
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    owner: OWNER,
    ...overrides,
  };
}

/** A child that starts a grandchild in its group, prints its pid and waits. */
const WAITING_WITH_GRANDCHILD = [
  '-e',
  `const { spawn } = require('node:child_process');
   const grandchild = spawn(process.execPath, ['-e',
     "process.on('SIGTERM', () => undefined); process.stdout.write('ready'); setInterval(() => undefined, 1 << 30);"],
     { stdio: ['ignore', 'pipe', 'ignore'] });
   grandchild.stdout.once('data', () => process.stdout.write(grandchild.pid + '\\n'));
   process.on('SIGTERM', () => process.exit(0));
   setInterval(() => undefined, 1 << 30);`,
];

/** A child that leaves a descendant holding its stdout, prints its pid and exits. */
const EXITS_WHILE_DESCENDANT_HOLDS_STDOUT = [
  '-e',
  `const { spawn } = require('node:child_process');
   const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'],
     { stdio: ['ignore', 'inherit', 'ignore'] });
   process.stdout.write(descendant.pid + '\\n', () => process.exit(0));`,
];

interface Observed {
  errors: ProviderProcessError[];
  closes: [number | null, NodeJS.Signals | null][];
  closed: Promise<void>;
}

function observe(child: ProviderProcess): Observed {
  const errors: ProviderProcessError[] = [];
  const closes: [number | null, NodeJS.Signals | null][] = [];
  child.once('error', (error) => errors.push(error));
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      closes.push([code, signal]);
      resolve();
    });
  });
  return { errors, closes, closed };
}

function readAll(child: ProviderProcess): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    child.stdout.once('end', () => resolve(text));
  });
}

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

/** Spawns a waiting child with a grandchild; resolves with both pids. */
async function waitingChild(
  client: ProviderProcessHostClient,
  overrides: Partial<ProviderProcessRequest> = {},
): Promise<{ child: ProviderProcess; observed: Observed; pids: number[] }> {
  const child = client.spawn(request(WAITING_WITH_GRANDCHILD, overrides));
  const observed = observe(child);
  const grandchild = Number(await firstLine(child));
  const pid = child.pid;
  if (pid === undefined) throw new Error('child pid not reported');
  strays.add(pid);
  strays.add(grandchild);
  return { child, observed, pids: [pid, grandchild] };
}

/**
 * An execution host running startProviderProcessHost in this process. Frames
 * cross on the next microtask in the `{ data }` shape.
 */
class InProcessHost extends ReportedExecutionHost {
  readonly hostFrames: unknown[] = [];
  readonly launcherFrames: unknown[] = [];
  readonly handle: ProviderProcessHostHandle;
  /** Runs after the host has handled each launcher frame. */
  afterLauncherFrame: () => void = () => undefined;
  /** While set, frames the host posts wait for `releaseFrames`. */
  holdFrames = false;
  private readonly heldFrames: unknown[] = [];
  private readonly hostListeners = new Set<
    (event: { data: unknown }) => void
  >();
  private stopped = false;

  constructor() {
    super();
    this.handle = startProviderProcessHost(
      {
        postMessage: (message) => {
          if (this.stopped) return;
          this.hostFrames.push(message);
          if (this.holdFrames) this.heldFrames.push(message);
          else queueMicrotask(() => this.reportMessage({ data: message }));
        },
        on: (_event, listener) => this.hostListeners.add(listener),
        once: (_event, listener) => this.hostListeners.add(listener),
      },
      (code) => this.exit(code),
    );
    queueMicrotask(() => this.reportSpawn());
  }

  get pid(): number | undefined {
    return this.exited ? undefined : process.pid;
  }

  releaseFrames(): void {
    this.holdFrames = false;
    for (const message of this.heldFrames.splice(0))
      queueMicrotask(() => this.reportMessage({ data: message }));
  }

  postMessage(message: unknown): void {
    if (this.stopped) throw new Error('host exited');
    this.launcherFrames.push(message);
    queueMicrotask(() => {
      if (this.stopped) return;
      for (const listener of this.hostListeners) listener({ data: message });
      this.afterLauncherFrame();
    });
  }

  kill(): boolean {
    if (this.stopped) return false;
    this.exit(1);
    return true;
  }

  /** The host's own exit: later frames from either side are dropped. */
  exit(code: number): void {
    if (this.stopped) return;
    this.stopped = true;
    queueMicrotask(() => this.reportExit(code));
  }
}

interface Harness {
  readonly client: ProviderProcessHostClient;
  /** Hosts launched so far; in process only. */
  readonly launches?: () => number;
  hostPid(): number | undefined;
  killHost(): void;
  dispose(): Promise<void>;
}

function inProcessHarness(
  onHost: (host: InProcessHost) => void = () => undefined,
): Harness & { hosts: InProcessHost[] } {
  const hosts: InProcessHost[] = [];
  const port: ExecutionHostPort = {
    launch: () => {
      const host = new InProcessHost();
      hosts.push(host);
      onHost(host);
      return host;
    },
    probe: () => Promise.reject(new Error('not used')),
  };
  const client = createProviderProcessHostClient(() => port);
  return {
    client,
    hosts,
    launches: () => hosts.length,
    hostPid: () => client.currentHostForTests()?.pid,
    killHost: (): void => {
      hosts.at(-1)?.exit(1);
    },
    dispose: () => client.shutdown(),
  };
}

function ownedHarness(): Harness {
  const owned = startOwnedProviderProcessHost();
  return {
    client: owned.client,
    hostPid: () => owned.hostPid(),
    killHost: () => owned.killHost(),
    dispose: () => owned.dispose(),
  };
}

beforeAll(() => {
  dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'provider-host-q-')),
  );
});

afterEach(async () => {
  for (const pid of Array.from(strays)) killStray(pid);
  strays.clear();
  await Promise.all(Array.from(ownedChildren, stopOwnedChild));
  ownedChildren.clear();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('retains explicit Windows quoting through the launcher, host and native spawn', async () => {
  const childProcess =
    jest.requireActual<typeof ChildProcessModule>('node:child_process');
  const spawnSpy = jest.spyOn(childProcess, 'spawn');
  const script = path.join(dir, 'quoted hook script.cjs');
  writeFileSync(script, 'process.stdout.write("quoted path reached");');
  const harness = inProcessHarness();
  try {
    const args = [process.platform === 'win32' ? `"${script}"` : script];
    const child = harness.client.spawn(
      request(args, { windowsVerbatimArguments: true }),
    );
    const observed = observe(child);
    expect(await readAll(child)).toBe('quoted path reached');
    await observed.closed;
    expect(observed.closes).toEqual([[0, null]]);
    expect(spawnSpy.mock.calls[0]?.[2]?.windowsVerbatimArguments).toBe(true);
    expect(
      isProviderProcessHostRequest({
        ...request(args),
        type: 'spawn',
        requestId: 'invalid-quoting-mode',
        windowsVerbatimArguments: 'true',
      }),
    ).toBe(false);
  } finally {
    await harness.dispose();
  }
});

describe.each(MODES)('provider process host (%s)', (mode) => {
  let harness: Harness;

  beforeEach(() => {
    harness = mode === 'in-process' ? inProcessHarness() : ownedHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("streams a child's stdout with credit and reports its close", async () => {
    const child = harness.client.spawn(
      request([
        '-e',
        `const bytes = Buffer.alloc(1024 * 1024);
         for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
         process.stdout.write(bytes, () => { process.exitCode = 0; });`,
      ]),
    );
    const observed = observe(child);
    const chunks: Buffer[] = [];
    let sinceSleep = 0;
    for await (const chunk of child.stdout) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from([]);
      chunks.push(buffer);
      sinceSleep += buffer.length;
      if (sinceSleep >= 64 * 1024) {
        sinceSleep = 0;
        await sleep(50);
      }
    }
    await observed.closed;
    const bytes = Buffer.concat(chunks);
    expect(bytes.length).toBe(1024 * 1024);
    for (let i = 0; i < bytes.length; i++)
      if (bytes[i] !== i % 251) throw new Error(`byte ${i} out of order`);
    expect(observed.closes).toEqual([[0, null]]);
    expect(observed.errors).toEqual([]);
  });

  if (mode === 'owned-process')
    it("a hosted child's parent is the host process, not the launcher", async () => {
      const child = harness.client.spawn(
        request(['-e', 'process.stdout.write(String(process.ppid))']),
      );
      const observed = observe(child);
      const parent = Number(await readAll(child));
      await observed.closed;
      expect(parent).toBe(harness.hostPid());
      expect(parent).not.toBe(process.pid);
    });

  it('stdin reaches the child and stdin end closes it', async () => {
    const child = harness.client.spawn(
      request(['-e', 'process.stdin.pipe(process.stdout)']),
    );
    const observed = observe(child);
    const output = readAll(child);
    const { stdin } = child;
    if (!stdin) throw new Error('A default request pipes stdin.');
    stdin.write('hello ');
    stdin.end('host');
    expect(await output).toBe('hello host');
    await observed.closed;
    expect(observed.closes).toEqual([[0, null]]);
  });

  it('reports exit before close while a descendant holds stdout', async () => {
    const child = harness.client.spawn(
      request(EXITS_WHILE_DESCENDANT_HOLDS_STDOUT),
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

  it('a request with stdin ignored gives the hosted child no input', async () => {
    const child = harness.client.spawn(
      request(
        [
          '-e',
          "process.stdout.write(String(require('fs').readFileSync(0).length))",
        ],
        { stdin: 'ignore' },
      ),
    );
    const observed = observe(child);
    const output = readAll(child);
    expect(child.stdin).toBeNull();
    expect(await output).toBe('0');
    await observed.closed;
    expect(observed.closes).toEqual([[0, null]]);
    const frame = {
      type: 'spawn',
      requestId: 'stdin-mode',
      command: process.execPath,
      args: [],
      cwd: dir,
      env: {},
      owner: OWNER,
    };
    expect(isProviderProcessHostRequest({ ...frame, stdin: 'ignore' })).toBe(
      true,
    );
    expect(isProviderProcessHostRequest({ ...frame, stdin: 'inherit' })).toBe(
      false,
    );
  });

  it("stop ends the child's whole group", async () => {
    const { child, observed, pids } = await waitingChild(harness.client);
    const grandchild = pids[1];
    expect(present(grandchild)).toBe(true);
    await child.stop({ graceMs: 200 });
    // Windows forces the tree kill, so the SIGTERM handler never runs there.
    if (posix) expect(observed.closes).toEqual([[0, null]]);
    else expect(observed.closes).toHaveLength(1);
    await until(() => !present(grandchild), 3_000);
  });

  it('a host that exits ends every proxy once and reaps their groups', async () => {
    const first = await waitingChild(harness.client);
    const second = await waitingChild(harness.client);
    const killed = harness.client.currentHostForTests();
    harness.killHost();
    await Promise.all([first.observed.closed, second.observed.closed]);
    for (const { observed } of [first, second]) {
      expect(observed.errors.map((error) => error.code)).toEqual([
        'ERR_PROVIDER_PROCESS_HOST_EXIT',
      ]);
      expect(observed.errors[0].message).toMatch(
        /^Provider process host exited before the provider process \(code -?\d+\)\.$/,
      );
      expect(observed.closes).toEqual([[null, 'SIGKILL']]);
    }
    await until(
      () => [...first.pids, ...second.pids].every((pid) => !present(pid)),
      8_000,
    );
    const next = harness.client.spawn(
      request(['-e', 'process.stdout.write("again")']),
    );
    const observed = observe(next);
    expect(await readAll(next)).toBe('again');
    await observed.closed;
    expect(observed.closes).toEqual([[0, null]]);
    const relaunched = harness.client.currentHostForTests();
    expect(relaunched).toBeDefined();
    expect(relaunched).not.toBe(killed);
    if (harness.launches) expect(harness.launches()).toBe(2);
  });

  it('shutdown stops every child and the host', async () => {
    const first = await waitingChild(harness.client);
    const second = await waitingChild(harness.client);
    const hostPid = harness.hostPid();
    await harness.client.shutdown();
    expect(first.observed.closes).toHaveLength(1);
    expect(second.observed.closes).toHaveLength(1);
    await until(
      () => [...first.pids, ...second.pids].every((pid) => !present(pid)),
      8_000,
    );
    if (mode === 'owned-process' && hostPid !== undefined)
      await until(() => !present(hostPid), 8_000);
    expect(harness.client.currentHostForTests()).toBeUndefined();
  });

  it('stop completes for a child whose unread stdout used up its credit', async () => {
    const child = harness.client.spawn(
      request([
        '-e',
        `const chunk = Buffer.alloc(64 * 1024, 120);
         const write = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', write); };
         write();`,
      ]),
    );
    const observed = observe(child);
    await until(() => child.pid !== undefined);
    const pid = child.pid;
    if (pid !== undefined) strays.add(pid);
    // Nobody reads the proxy's stdout, so the host's credit runs out.
    await sleep(300);
    await within(child.stop({ graceMs: 200 }), 8_000);
    expect(observed.closes).toHaveLength(1);
  });

  it('a stopping child that floods stdout stays within the credit window', async () => {
    const child = harness.client.spawn(
      request([
        '-e',
        `process.on('SIGTERM', () => undefined);
         const chunk = Buffer.alloc(64 * 1024, 120);
         const write = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', write); };
         write();`,
      ]),
    );
    const host = harness.client.currentHostForTests();
    if (!host) throw new Error('the spawn launched no host');
    const sent = jest.spyOn(host, 'postMessage');
    const observed = observe(child);
    await until(() => child.pid !== undefined);
    const pid = child.pid;
    if (pid !== undefined) strays.add(pid);
    // Nobody reads the proxy's stdout while the child is stopped.
    await sleep(200);
    await within(child.stop({ graceMs: 1_000 }), 8_000);
    expect(observed.closes).toHaveLength(1);
    // The proxy acknowledges what its stream buffers below its high-water
    // mark, so the window bounds only the bytes it holds unacknowledged.
    const acked = sent.mock.calls.reduce((total, [message]) => {
      if (
        isProviderProcessHostRequest(message) &&
        message.type === 'stdout-ack'
      )
        return total + message.bytes;
      return total;
    }, 0);
    const held = child.stdout.readableLength;
    expect(held - acked).toBeLessThanOrEqual(
      PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
    );
    expect(held).toBeLessThan(
      PROVIDER_PROCESS_STDOUT_WINDOW_BYTES + child.stdout.readableHighWaterMark,
    );
  });

  itPosix('stop reaps the group of a child that already closed', async () => {
    const child = harness.client.spawn(
      request([
        '-e',
        `const { spawn } = require('node:child_process');
         const grandchild = spawn(process.execPath, ['-e',
           "process.on('SIGTERM', () => undefined); process.stdout.write('ready'); setInterval(() => undefined, 1 << 30);"],
           { stdio: ['ignore', 'pipe', 'ignore'] });
         grandchild.stdout.once('data', () => {
           process.stdout.write(grandchild.pid + '\\n', () => process.exit(0));
         });`,
      ]),
    );
    const observed = observe(child);
    const grandchild = Number(await firstLine(child));
    strays.add(grandchild);
    await observed.closed;
    expect(observed.closes).toEqual([[0, null]]);
    expect(present(grandchild)).toBe(true);
    await child.stop();
    await until(() => !present(grandchild), 3_000);
  });

  it('an invalid owner launches no host', async () => {
    const owner: ProviderProcessOwner = { kind: 'turn', id: '' };
    const child = harness.client.spawn(request(['-e', ''], { owner }));
    const observed = observe(child);
    await observed.closed;
    expect(observed.errors.map((error) => error.code)).toEqual([
      'ERR_PROVIDER_PROCESS_OWNER',
    ]);
    expect(observed.closes).toEqual([[null, null]]);
    if (harness.launches) expect(harness.launches()).toBe(0);
    expect(harness.client.currentHostForTests()).toBeUndefined();
  });
});

describePosix('provider process host lifecycle', () => {
  it('a launcher that disconnects leaves no child running', async () => {
    const posted: unknown[] = [];
    const listeners = new Set<(event: { data: unknown }) => void>();
    let disconnect: (() => void) | undefined;
    const exit = jest.fn();
    const channel: ConnectedExecutionHostChannel = {
      postMessage: (message) => posted.push(message),
      on: (_event, listener) => listeners.add(listener),
      once: (_event, listener) => listeners.add(listener),
      exit,
      congested: () => false,
      onceDrained: (listener) => listener(),
      onDisconnect: (handler) => {
        disconnect = handler;
      },
    };
    serveProviderProcessHost(channel);
    const spawn: ProviderProcessHostRequest = {
      type: 'spawn',
      requestId: 'disconnect-child',
      command: process.execPath,
      args: WAITING_WITH_GRANDCHILD,
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      owner: OWNER,
    };
    for (const listener of listeners) listener({ data: spawn });
    let pid: number | undefined;
    let grandchild: number | undefined;
    await until(() => {
      let stdout = '';
      for (const frame of posted.filter(isProviderProcessHostResponse)) {
        if (frame.type === 'started') pid = frame.pid;
        if (frame.type === 'stdout')
          stdout += Buffer.from(frame.dataBase64, 'base64').toString('utf8');
      }
      if (stdout.includes('\n')) grandchild = Number(stdout.split('\n')[0]);
      return pid !== undefined && grandchild !== undefined;
    });
    if (pid === undefined || grandchild === undefined)
      throw new Error('child did not start');
    strays.add(pid);
    strays.add(grandchild);
    if (!disconnect) throw new Error('no disconnect handler');
    disconnect();
    const childPid = pid;
    const grandchildPid = grandchild;
    await until(() => !present(childPid) && !present(grandchildPid), 8_000);
    await until(() => exit.mock.calls.length > 0, 8_000);
    expect(
      posted.some(
        (frame) =>
          isProviderProcessHostResponse(frame) &&
          frame.type === 'shutdown-complete',
      ),
    ).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

/**
 * A host that never starts until told: kill() is false before spawn. Its pid
 * is a real idle child that the test owns, never a literal one.
 */
class UnstartedHost extends ReportedExecutionHost {
  private running = false;
  readonly kills = jest.fn();
  private readonly ownedPid: number;

  constructor(ownedPid: number) {
    super();
    this.ownedPid = ownedPid;
  }

  get pid(): number | undefined {
    return this.running ? this.ownedPid : undefined;
  }

  postMessage(): void {
    // Queued until spawn; this host never answers.
  }

  kill(): boolean {
    this.kills();
    if (!this.running) return false;
    this.running = false;
    this.reportExit(137);
    return true;
  }

  start(): void {
    this.running = true;
    this.reportSpawn();
  }
}

describePosix('provider process host stop races', () => {
  const EXITING_WITH_GRANDCHILD = [
    '-e',
    `const { spawn } = require('node:child_process');
     const grandchild = spawn(process.execPath, ['-e',
       "process.on('SIGTERM', () => undefined); process.stdout.write('ready'); setInterval(() => undefined, 1 << 30);"],
       { stdio: ['ignore', 'pipe', 'ignore'] });
     grandchild.stdout.once('data', () => {
       process.stdout.write(grandchild.pid + '\\n', () => process.exit(0));
     });`,
  ];

  it("a stop that crosses the child's close still reaps its group", async () => {
    let current: InProcessHost | undefined;
    const harness = inProcessHarness((host) => {
      current = host;
    });
    try {
      const child = harness.client.spawn(request(EXITING_WITH_GRANDCHILD));
      const observed = observe(child);
      const grandchild = Number(await firstLine(child));
      strays.add(grandchild);
      const host = current;
      if (!host) throw new Error('no host');
      host.holdFrames = true;
      // The host has seen the close; the launcher has not.
      await until(() => host.handle.liveChildren().length === 0);
      const stopped = child.stop();
      host.releaseFrames();
      await stopped;
      expect(observed.closes).toEqual([[0, null]]);
      await until(() => !present(grandchild), 3_000);
    } finally {
      await harness.dispose();
    }
  });

  it('shutdown force-kills a child already stopping with a long grace', async () => {
    let current: InProcessHost | undefined;
    const harness = inProcessHarness((host) => {
      current = host;
    });
    try {
      const child = harness.client.spawn(
        request([
          '-e',
          `process.on('SIGTERM', () => undefined);
           process.stdout.write('ready\\n');
           setInterval(() => undefined, 1 << 30);`,
        ]),
      );
      const observed = observe(child);
      await firstLine(child);
      const pid = child.pid;
      if (pid === undefined) throw new Error('no pid');
      strays.add(pid);
      void child.stop({ graceMs: 60_000 });
      await sleep(100);
      const host = current;
      if (!host) throw new Error('no host');
      await within(host.handle.shutdown(), 3_000);
      await until(() => !present(pid), 1_000);
      expect(observed.closes).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });
});

// Host and launcher share this process, so one spy sees every signal either
// sends. Once the child has exited its pid may be reused: only its group may
// be signalled.
describePosix('provider process host signals after exit', () => {
  let current: InProcessHost | undefined;
  let harness: ReturnType<typeof inProcessHarness>;

  beforeEach(() => {
    current = undefined;
    harness = inProcessHarness((host) => {
      current = host;
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  const bareSignals = (
    kill: jest.SpyInstance<true, Parameters<typeof process.kill>>,
    pid: number,
  ): unknown[] => kill.mock.calls.filter(([target]) => target === pid);

  it('a child that exits inside the TERM window gets no bare-pid signal', async () => {
    const child = harness.client.spawn(
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
    await within(child.stop({ graceMs: 5_000 }), 4_000);
    expect(observed.closes).toEqual([[0, null]]);
    expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
    expect(bareSignals(kill, pid)).toEqual([]);
  });

  it('a stop after the child closed signals only its group', async () => {
    const child = harness.client.spawn(
      request(['-e', "process.stdout.write('ready\\n')"]),
    );
    const observed = observe(child);
    await firstLine(child);
    await observed.closed;
    const pid = child.pid;
    if (pid === undefined) throw new Error('no pid');
    const kill = jest.spyOn(process, 'kill');
    await child.stop();
    expect(kill.mock.calls).toEqual([[-pid, 'SIGKILL']]);
  });

  it('a stop that crosses a childless close signals only its group', async () => {
    const child = harness.client.spawn(
      request([
        '-e',
        "process.stdout.write('ready\\n'); setTimeout(() => process.exit(0), 200);",
      ]),
    );
    const observed = observe(child);
    await firstLine(child);
    const pid = child.pid;
    if (pid === undefined) throw new Error('no pid');
    const host = current;
    if (!host) throw new Error('no host');
    host.holdFrames = true;
    // The host has seen the close; the launcher has not.
    await until(() => host.handle.liveChildren().length === 0);
    const kill = jest.spyOn(process, 'kill');
    const stopped = child.stop();
    host.releaseFrames();
    await stopped;
    expect(observed.closes).toEqual([[0, null]]);
    expect(kill.mock.calls).toEqual([[-pid, 'SIGKILL']]);
  });

  it('shutdown after a child exited signals only its group', async () => {
    // The descendant leads its own group and holds stdout: the child has
    // exited, its group is gone, and its close has not come.
    const child = harness.client.spawn(
      request([
        '-e',
        `const { spawn } = require('node:child_process');
         const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'],
           { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
         process.stdout.write(descendant.pid + '\\n', () => process.exit(0));`,
      ]),
    );
    const observed = observe(child);
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    const descendant = Number(await firstLine(child));
    strays.add(descendant);
    await exited;
    const pid = child.pid;
    if (pid === undefined) throw new Error('no pid');
    const kill = jest.spyOn(process, 'kill');
    await within(harness.client.shutdown(), 8_000);
    expect(observed.closes).toEqual([[null, 'SIGKILL']]);
    expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
    expect(bareSignals(kill, pid)).toEqual([]);
  });
});

/**
 * A child the host spawns through an in-test spawner, fed by the test. Its
 * pid is a real idle child that the test started, so a host signal that
 * reaches the pid can only reach the test's own child.
 */
class ScriptedChild extends EventEmitter implements ProviderProcess {
  constructor(readonly pid: number) {
    super();
  }

  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  stop(): Promise<void> {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', null, 'SIGKILL');
    return Promise.resolve();
  }
}

/** A child that stays open while stopping until the test closes it. */
class StoppingChild extends ScriptedChild {
  readonly stops: number[] = [];

  override stop(options?: { graceMs?: number }): Promise<void> {
    this.stops.push(options?.graceMs ?? -1);
    return Promise.resolve();
  }

  finish(): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', null, 'SIGKILL');
  }
}

describe('provider process host exit frames', () => {
  it('posts exit before close while a descendant holds stdout', async () => {
    const posted: unknown[] = [];
    const listeners = new Set<(event: { data: unknown }) => void>();
    let disconnect: (() => void) | undefined;
    const exit = jest.fn();
    const channel: ConnectedExecutionHostChannel = {
      postMessage: (message) => posted.push(message),
      on: (_event, listener) => listeners.add(listener),
      once: (_event, listener) => listeners.add(listener),
      exit,
      congested: () => false,
      onceDrained: (listener) => listener(),
      onDisconnect: (handler) => {
        disconnect = handler;
      },
    };
    serveProviderProcessHost(channel);
    const spawn: ProviderProcessHostRequest = {
      type: 'spawn',
      requestId: 'exit-before-close',
      command: process.execPath,
      args: EXITS_WHILE_DESCENDANT_HOLDS_STDOUT,
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      owner: OWNER,
    };
    for (const listener of listeners) listener({ data: spawn });
    const frames = (): string[] =>
      posted.filter(isProviderProcessHostResponse).map((frame) => frame.type);
    let descendant: number | undefined;
    await until(() => {
      let stdout = '';
      for (const frame of posted.filter(isProviderProcessHostResponse))
        if (frame.type === 'stdout')
          stdout += Buffer.from(frame.dataBase64, 'base64').toString('utf8');
      if (stdout.includes('\n')) descendant = Number(stdout.split('\n')[0]);
      return descendant !== undefined && frames().includes('exit');
    });
    if (descendant === undefined) throw new Error('child did not start');
    strays.add(descendant);
    expect(present(descendant)).toBe(true);
    expect(frames()).not.toContain('close');
    expect(posted).toContainEqual({
      type: 'exit',
      requestId: 'exit-before-close',
      code: 0,
      signal: null,
    });
    process.kill(descendant, 'SIGKILL');
    await until(() => frames().includes('close'));
    expect(frames().indexOf('exit')).toBeLessThan(frames().indexOf('close'));
    const frame = { type: 'exit', requestId: 'exit-frame', signal: null };
    expect(isProviderProcessHostResponse({ ...frame, code: 0 })).toBe(true);
    expect(isProviderProcessHostResponse({ ...frame, code: '0' })).toBe(false);
    if (!disconnect) throw new Error('no disconnect handler');
    disconnect();
    await until(() => exit.mock.calls.length > 0, 8_000);
  });
});

describe('provider process host stdout credit', () => {
  it('a chunk that crosses the credit window waits for the ack and stays in order', async () => {
    const child = new StoppingChild(await startOwnedIdleChild());
    const posted: unknown[] = [];
    const listeners = new Set<(event: { data: unknown }) => void>();
    startProviderProcessHost(
      {
        postMessage: (message) => posted.push(message),
        on: (_event, listener) => listeners.add(listener),
        once: (_event, listener) => listeners.add(listener),
      },
      () => undefined,
      () => child,
    );
    const send = (data: ProviderProcessHostRequest): void => {
      for (const listener of listeners) listener({ data });
    };
    const relayed = (): Buffer =>
      Buffer.concat(
        posted
          .filter(isProviderProcessHostResponse)
          .flatMap((frame) =>
            frame.type === 'stdout'
              ? [Buffer.from(frame.dataBase64, 'base64')]
              : [],
          ),
      );
    const requestId = 'crossing-chunk';
    send({
      type: 'spawn',
      requestId,
      command: process.execPath,
      args: [],
      cwd: dir,
      env: {},
      owner: OWNER,
    });
    // A partial first read, then a full one, before the launcher acks.
    const first = 36_544;
    child.stdout.write(Buffer.alloc(first, 97));
    await sleep(20);
    child.stdout.write(Buffer.alloc(PROVIDER_PROCESS_STDOUT_WINDOW_BYTES, 98));
    await sleep(20);
    expect(relayed().length).toBe(PROVIDER_PROCESS_STDOUT_WINDOW_BYTES);
    send({ type: 'stdout-ack', requestId, bytes: first });
    await sleep(20);
    const bytes = relayed();
    expect(bytes.length).toBe(first + PROVIDER_PROCESS_STDOUT_WINDOW_BYTES);
    expect(bytes.subarray(0, first).every((byte) => byte === 97)).toBe(true);
    expect(bytes.subarray(first).every((byte) => byte === 98)).toBe(true);
    child.finish();
  });
});

describe('provider process host stdout while stopping', () => {
  it('relayed stdout stays a prefix once a stopping child exceeds its credit', async () => {
    const child = new StoppingChild(await startOwnedIdleChild());
    const posted: unknown[] = [];
    const listeners = new Set<(event: { data: unknown }) => void>();
    startProviderProcessHost(
      {
        postMessage: (message) => posted.push(message),
        on: (_event, listener) => listeners.add(listener),
        once: (_event, listener) => listeners.add(listener),
      },
      () => undefined,
      () => child,
    );
    const send = (data: ProviderProcessHostRequest): void => {
      for (const listener of listeners) listener({ data });
    };
    const requestId = 'stopping-child';
    send({
      type: 'spawn',
      requestId,
      command: process.execPath,
      args: [],
      cwd: dir,
      env: {},
      owner: OWNER,
    });
    send({ type: 'stop', requestId, graceMs: 1_000 });
    child.stdout.write(Buffer.alloc(PROVIDER_PROCESS_STDOUT_WINDOW_BYTES, 97));
    child.stdout.write(Buffer.alloc(100, 98));
    await sleep(20);
    send({
      type: 'stdout-ack',
      requestId,
      bytes: PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
    });
    child.stdout.write(Buffer.alloc(50, 99));
    await sleep(20);
    const relayed = Buffer.concat(
      posted
        .filter(isProviderProcessHostResponse)
        .flatMap((frame) =>
          frame.type === 'stdout'
            ? [Buffer.from(frame.dataBase64, 'base64')]
            : [],
        ),
    );
    expect(relayed.length).toBe(PROVIDER_PROCESS_STDOUT_WINDOW_BYTES);
    expect(relayed.every((byte) => byte === 97)).toBe(true);
    child.finish();
  });
});

describe('provider process host stderr', () => {
  it('relayed stderr stays a prefix once a chunk is dropped', async () => {
    const child = new ScriptedChild(await startOwnedIdleChild());
    const posted: unknown[] = [];
    const listeners = new Set<(event: { data: unknown }) => void>();
    startProviderProcessHost(
      {
        postMessage: (message) => posted.push(message),
        on: (_event, listener) => listeners.add(listener),
        once: (_event, listener) => listeners.add(listener),
      },
      () => undefined,
      () => child,
    );
    const spawn: ProviderProcessHostRequest = {
      type: 'spawn',
      requestId: 'stderr-child',
      command: process.execPath,
      args: [],
      cwd: dir,
      env: {},
      owner: OWNER,
    };
    for (const listener of listeners) listener({ data: spawn });
    const first = PROVIDER_PROCESS_STDERR_LIMIT_BYTES - 10;
    child.stderr.write(Buffer.alloc(first, 97));
    child.stderr.write(Buffer.alloc(100, 98));
    child.stderr.write(Buffer.alloc(5, 99));
    await sleep(20);
    const relayed = Buffer.concat(
      posted
        .filter(isProviderProcessHostResponse)
        .flatMap((frame) =>
          frame.type === 'stderr'
            ? [Buffer.from(frame.dataBase64, 'base64')]
            : [],
        ),
    );
    expect(relayed.length).toBe(first);
    expect(relayed.every((byte) => byte === 97)).toBe(true);
    await child.stop();
  });
});

describe('provider process host shutdown before spawn', () => {
  it('shutdown stops a host that has not spawned yet', async () => {
    const ownedPid = await startOwnedIdleChild();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const host = new UnstartedHost(ownedPid);
    const launch = jest.fn((): ExecutionHostProcess => host);
    const client = createProviderProcessHostClient(() => ({
      launch,
      probe: (): Promise<never> => Promise.reject(new Error('not used')),
    }));
    const child = client.spawn(request(['-e', '']));
    const observed = observe(child);
    let resolved = false;
    const shutdown = client.shutdown().then(() => {
      resolved = true;
    });
    await jest.advanceTimersByTimeAsync(6_000);
    expect(host.kills).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);
    host.start();
    await shutdown;
    expect(host.kills).toHaveBeenCalledTimes(2);
    expect(observed.closes).toEqual([[null, 'SIGKILL']]);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe('provider process host secrecy', () => {
  it("no spawn request's environment or arguments leak", async () => {
    const canary = `canary-${randomUUID()}`;
    const spied = [
      jest.spyOn(console, 'log'),
      jest.spyOn(console, 'info'),
      jest.spyOn(console, 'warn'),
      jest.spyOn(console, 'error'),
      jest.spyOn(console, 'debug'),
      jest.spyOn(process.stdout, 'write'),
      jest.spyOn(process.stderr, 'write'),
    ];
    const snapshots: (readonly ProviderProcessHostChildSnapshot[])[] = [];
    let current: InProcessHost | undefined;
    const takeSnapshot = (): void => {
      if (current) snapshots.push(current.handle.liveChildren());
    };
    const harness = inProcessHarness((host) => {
      current = host;
      host.afterLauncherFrame = takeSnapshot;
    });
    const errors: ProviderProcessError[] = [];
    const collect = (child: ProviderProcess): Observed => {
      const observed = observe(child);
      child.once('error', (error) => errors.push(error));
      return observed;
    };
    const env = { PATH: process.env.PATH ?? '', CANARY_TOKEN: canary };
    try {
      // (a) a child that exits with the canary in env and args.
      const exiting = harness.client.spawn(
        request(['-e', 'process.exit(3)', '--', `--token=${canary}`], { env }),
      );
      const a = collect(exiting);
      exiting.stdout.resume();
      exiting.stderr.resume();
      await a.closed;
      expect(a.closes).toEqual([[3, null]]);
      // (b) a missing command with the canary in env and args.
      const missing = harness.client.spawn(
        request([`--token=${canary}`], {
          command: path.join(dir, 'missing'),
          env,
        }),
      );
      const b = collect(missing);
      await b.closed;
      expect(b.errors.map((error) => error.code)).toEqual(['ENOENT']);
      // (c) a waiting child ended by the host's own exit.
      const waiting = await waitingChild(harness.client, { env });
      waiting.child.once('error', (error) => errors.push(error));
      takeSnapshot();
      harness.killHost();
      await waiting.observed.closed;
      await until(() => waiting.pids.every((pid) => !present(pid)), 8_000);
    } finally {
      for (const spy of spied) spy.mockRestore();
    }
    const frames = harness.hosts.flatMap((host) => [
      ...host.hostFrames.map((frame) =>
        isProviderProcessHostResponse(frame) &&
        (frame.type === 'stdout' || frame.type === 'stderr')
          ? { ...frame, dataBase64: '' }
          : frame,
      ),
      ...host.launcherFrames.filter(
        (frame) =>
          typeof frame !== 'object' ||
          frame === null ||
          (Reflect.get(frame, 'type') !== 'spawn' &&
            Reflect.get(frame, 'type') !== 'stdin'),
      ),
    ]);
    const collected = [
      ...frames.map((frame) => JSON.stringify(frame)),
      ...errors.flatMap((error) => [
        error.message,
        String(error.code),
        String(error),
        JSON.stringify(error),
      ]),
      ...snapshots.map((snapshot) => JSON.stringify(snapshot)),
      ...spied.flatMap((spy) =>
        spy.mock.calls.map((call) => JSON.stringify(call)),
      ),
    ];
    expect(snapshots.flat().length).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(frames.length).toBeGreaterThan(0);
    for (const text of collected) expect(text).not.toContain(canary);
    await harness.dispose();
  });
});
