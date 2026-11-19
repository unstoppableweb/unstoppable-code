import {
  spawn as spawnOwnedChild,
  type ChildProcess,
} from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { buildSync } from 'esbuild';
import { createExecutionProcessServices } from '@canopy/core-platform';
import type {
  PlatformExecutionProcessServices,
  PlatformOperatingSystem,
} from '@canopy/core-runtime';
import type {
  ConnectedExecutionHostChannel,
  ExecutionHostChannel,
} from '@canopy/desktop-shared/node/execution-host/channel';
import { createOwnedProcessHostPort } from '@canopy/desktop-shared/node/execution-host/owned-process-host';
import {
  type ExecutionHostPort,
  type ExecutionHostProcess,
  ReportedExecutionHost,
} from '@canopy/desktop-shared/node/execution-host/port';
import type * as RunnerModule from '../agents/claude-process-host-runner';
import { registerHostedClaudeProcess } from '../agents/claude-process-registry';
import {
  resetClaudeProcessHostForTests,
  shutdownClaudeProcessHost,
  spawnClaudeCodeProcessOffMain,
} from '../agents/claude-process-host-runner';
import type * as HostModule from '../agents/claude-process-host-worker';
import {
  serveClaudeProcessHost,
  startClaudeProcessHost,
} from '../agents/claude-process-host-worker';
import type * as PortModule from '../execution-host/utility-process-host';
import { setExecutionHostPort } from '../execution-host/utility-process-host';

// The production Claude process host and runner over both channels a host is
// launched with (CAN-4116): the runner's getExecutionHostPort().launch reaches
// a host in process over a parent-port-shaped channel (the utility-process
// adapter's shape), and the host bundled as the desktop bundles it, run as a
// real child under plain Node over the owned-process port (the port the
// daemon composes). Carries the CAN-4833 host guarantees forward.

jest.mock('../agents/claude-process-registry', () => ({
  registerHostedClaudeProcess: jest.fn(),
  unregisterHostedClaudeProcess: jest.fn(),
}));

const os = ((): PlatformOperatingSystem => {
  const platform: string = process.platform;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32')
    return platform;
  throw new Error(`unsupported test host ${platform}`);
})();
const ROOT = path.resolve(__dirname, '../../../../..');
const ENTRY = 'claude-process-host-worker.js';
const CASE_TIMEOUT_MS = 30_000;
const REAP_WITHIN_MS = 8_000;
const FIXTURE_DEADLINE_MS = 60_000;
// Cleanup includes sequential exit waits, process queries and failure diagnostics.
// This hook limit does not extend a case or its product reaping assertion.
const CLEANUP_TIMEOUT_MS = 60_000;
const HOST_EXIT_ERROR =
  /^Claude process host exited before the Claude process \(code -?\d+\)\.$/;

let dir = '';
let ownedRoot: { path: string; dev: number; ino: number } | undefined;
let cleanupConfirmed = true;
const observedPids = new Set<number>();
const cleanupMarkers = new Map<string, string>();
const streamPidFiles = new Set<string>();
const hostPids = new Set<number>();
/** Idle children that a case started to give a fake process a real pid. */
const ownedChildren = new Set<ChildProcess>();
const signalRequested = new WeakSet<ChildProcess>();
const signalledFixtureExits = new Map<
  ChildProcess,
  Array<[number | null, NodeJS.Signals | null]>
>();

function validPid(pid: unknown): pid is number {
  return (
    typeof pid === 'number' &&
    Number.isInteger(pid) &&
    pid > 1 &&
    pid <= 2_147_483_647
  );
}

interface SignalEligibility {
  readonly owned: boolean;
  readonly pid: unknown;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly requested: boolean;
}

function childSignalState(child: ChildProcess): SignalEligibility {
  return {
    owned: ownedChildren.has(child),
    pid: child.pid,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    requested: signalRequested.has(child),
  };
}

function maySignal(state: SignalEligibility): boolean {
  return (
    state.owned &&
    validPid(state.pid) &&
    state.exitCode === null &&
    state.signalCode === null &&
    !state.requested
  );
}

/** The only direct signal delivery in this test. Never accepts a numeric target. */
function signalOwnedChild(
  child: ChildProcess,
  signaller: (child: ChildProcess) => boolean = (owned) =>
    owned.kill('SIGKILL'),
  eligibility = childSignalState(child),
): boolean {
  // Guard rows can supply immutable refusal states with an inert signaller.
  // Delivery still requires the handle's current ownership and lifecycle state.
  if (!maySignal(eligibility) || !maySignal(childSignalState(child)))
    return false;
  signalRequested.add(child);
  return signaller(child);
}

/**
 * Starts an idle child that this test owns. A fake process handed to the
 * host takes this real pid, never a literal one, so a signal path that
 * escapes the mocks can reach only a process the test started. afterEach
 * stops it by its own handle.
 */
async function startOwnedIdleChild(register = true): Promise<ChildProcess> {
  const child = spawnOwnedChild(
    process.execPath,
    [
      '-e',
      `process.stdin.resume();
       process.stdin.once('end', () => process.exit(0));
       setTimeout(() => process.exit(0), ${FIXTURE_DEADLINE_MS});`,
    ],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  if (register) ownedChildren.add(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const { pid } = child;
  if (!validPid(pid)) throw new Error('owned child has no valid pid');
  return child;
}

/** Stops a child this test started, by its own handle, and waits for it. */
async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) return; // A failed spawn created no process.
  if (!signalOwnedChild(child))
    throw new Error(`owned child cleanup was refused (pid ${child.pid})`);
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    REAP_WITHIN_MS,
    () => `owned child did not exit (pid ${child.pid})`,
  );
}

/** Guard-row children exit cooperatively, even after an inert signal record. */
async function endIdleChild(child: ChildProcess): Promise<void> {
  child.stdin?.end();
  try {
    await until(() => child.exitCode !== null, REAP_WITHIN_MS);
  } catch (error) {
    cleanupConfirmed = false;
    throw new Error(`idle fixture did not exit (pid ${child.pid})`, {
      cause: error,
    });
  }
}

/** Linux only: a process's state letter and parent, from /proc. */
function procStat(pid: number): { state: string; parent: number } | undefined {
  if (os !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    const [state, parent] = stat.slice(end + 2).split(' ');
    if (
      end < 0 ||
      !/^[A-Za-z]$/.test(state) ||
      !Number.isInteger(Number(parent)) ||
      Number(parent) < 0
    )
      throw new Error('invalid process stat observation');
    return { state, parent: Number(parent) };
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ESRCH')
    )
      return undefined;
    throw error;
  }
}

/** A bounded, read-only command. Timeout cleanup uses the same owned handle gate. */
async function processObservation(
  command: string,
  args: string[],
  beforeSignalFallback?: Promise<unknown>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawnOwnedChild(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  ownedChildren.add(child);
  let closed = false;
  let failure: Error | undefined;
  let stdout = '';
  let stderr = '';
  child.once('close', () => {
    closed = true;
  });
  child.on('error', (error) => {
    failure = error;
  });
  const collect = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    if (stdout.length + stderr.length + chunk.length > 256 * 1024) {
      failure = new Error('process observation exceeded its output limit');
      return;
    }
    if (stream === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
  };
  child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
  try {
    await until(() => closed || failure !== undefined, 2_000);
    if (failure) throw failure;
    return { code: child.exitCode, stdout, stderr };
  } finally {
    if (beforeSignalFallback && maySignal(childSignalState(child)))
      await beforeSignalFallback;
    await stopOwnedChild(child);
    ownedChildren.delete(child);
  }
}

/** This process, the hosts it launched, and the CLIs and grandchildren. */
function underTest(pid: number): boolean {
  return pid === process.pid || hostPids.has(pid) || observedPids.has(pid);
}

function windowsObserverCommand(systemRoot: string | undefined): string {
  if (!systemRoot || !/^[A-Za-z]:\\/.test(systemRoot))
    throw new Error('Windows system root is not a local absolute drive path');
  return path.win32.join(systemRoot, 'System32', 'tasklist.exe');
}

async function presentPids(
  pids: readonly number[],
  beforeSignalFallback?: Promise<unknown>,
): Promise<number[]> {
  if (!pids.every(validPid)) throw new Error('invalid observation pid');
  if (pids.length === 0) return [];
  // An orphaned zombie has exited and waits on a reaper outside the tree
  // under test. A zombie whose parent is in the tree is not yet reaped.
  if (os === 'linux') {
    if (!procStat(process.pid))
      throw new Error('process observations unavailable');
    return pids.filter((pid) => {
      const stat = procStat(pid);
      return (
        stat !== undefined && (stat.state !== 'Z' || underTest(stat.parent))
      );
    });
  }
  let observerCommand = '/bin/ps';
  if (os === 'win32') {
    observerCommand = windowsObserverCommand(process.env.SystemRoot);
  }
  const result = await processObservation(
    observerCommand,
    os === 'win32'
      ? ['/FO', 'CSV', '/NH']
      : ['-p', pids.join(','), '-o', 'pid='],
    beforeSignalFallback,
  );
  if (
    os !== 'win32' &&
    result.code === 1 &&
    result.stdout.trim() === '' &&
    result.stderr.trim() === ''
  )
    return [];
  if (result.code !== 0 || result.stderr.trim() !== '')
    throw new Error(`process observation failed (exit ${result.code})`);
  const found = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const match =
        os === 'win32'
          ? /^"(?:[^"]|"")*","(\d+)"/.exec(line)
          : /^\s*(\d+)\s*$/.exec(line);
      if (!match) throw new Error('invalid process observation output');
      const pid = Number(match[1]);
      if (
        !Number.isInteger(pid) ||
        pid < 0 ||
        pid > 2_147_483_647 ||
        (os !== 'win32' && !pids.includes(pid))
      )
        throw new Error('invalid process observation pid');
      return pid;
    });
  if (found.length === 0)
    throw new Error('empty successful process observation');
  return pids.filter((pid) => found.includes(pid));
}

async function nonePresent(
  pids: readonly number[],
  beforeSignalFallback?: Promise<unknown>,
): Promise<boolean> {
  return (await presentPids(pids, beforeSignalFallback)).length === 0;
}

/** The remaining pids, with their state and parent where /proc has them. */
async function remaining(pids: readonly number[]): Promise<string> {
  return (await presentPids(pids))
    .map((pid) => {
      const stat = procStat(pid);
      return stat ? `${pid} (${stat.state}, parent ${stat.parent})` : `${pid}`;
    })
    .join(', ');
}

async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  explain?: () => string | Promise<string>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const satisfied = await check();
    if (Date.now() > deadline)
      throw new Error(
        `condition not met in time${explain ? `: ${await explain()}` : ''}`,
      );
    if (satisfied) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The CLI pids whose start the runner has read from the host. */
function trackedPids(): Set<number> {
  return new Set(
    jest
      .mocked(registerHostedClaudeProcess)
      .mock.calls.map(([record]) => record.pid),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A CLI that starts a grandchild in its own group, records both pids and
 * waits. With `ignoreTerm` both ignore SIGTERM.
 */
function waitingScript(pidFile: string, ignoreTerm: boolean): string {
  const ignore = ignoreTerm ? "process.on('SIGTERM', () => undefined);" : '';
  const marker = `${pidFile}.stop`;
  cleanupMarkers.set(pidFile, marker);
  const selfExit = `
    setTimeout(() => process.exit(0), ${FIXTURE_DEADLINE_MS});
    const stopIfRequested = () => {
      const { existsSync } = require('node:fs');
      if (existsSync(${JSON.stringify(marker)}) || !existsSync(${JSON.stringify(dir)})) process.exit(0);
    };
    stopIfRequested();
    setInterval(stopIfRequested, 25);`;
  return `${ignore}${selfExit}
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(
      `${ignore}${selfExit}`,
    )}], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid);`;
}

async function pidsOf(pidFile: string): Promise<[number, number]> {
  await until(
    () =>
      existsSync(pidFile) && /^\d+ \d+$/.test(readFileSync(pidFile, 'utf8')),
  );
  return recordFixturePids(pidFile);
}

function recordFixturePids(pidFile: string): [number, number] {
  const value = readFileSync(pidFile, 'utf8');
  if (!/^\d+ \d+$/.test(value))
    throw new Error('incomplete fixture pid record');
  const [cli, grandchild] = value.split(' ').map(Number);
  if (!validPid(cli) || !validPid(grandchild))
    throw new Error('fixture reported an invalid pid');
  observedPids.add(cli);
  observedPids.add(grandchild);
  return [cli, grandchild];
}

function recordStreamFixturePid(pidFile: string): number {
  const value = readFileSync(pidFile, 'utf8');
  if (!/^\d+$/.test(value))
    throw new Error('incomplete streaming fixture pid record');
  const pid = Number(value);
  if (!validPid(pid)) throw new Error('fixture reported an invalid pid');
  observedPids.add(pid);
  return pid;
}

function checkedRoot(): string {
  if (!ownedRoot) throw new Error('no owned fixture root');
  const stat = lstatSync(ownedRoot.path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== ownedRoot.dev ||
    stat.ino !== ownedRoot.ino ||
    realpathSync.native(ownedRoot.path) !== ownedRoot.path
  )
    throw new Error('owned fixture root identity changed');
  return ownedRoot.path;
}

function checkedFixturePath(target: string): string {
  const root = checkedRoot();
  const prefix = root + path.sep;
  if (!path.resolve(target).startsWith(prefix))
    throw new Error('fixture removal target is outside the owned root');
  const realTarget = realpathSync.native(target);
  if (!realTarget.startsWith(prefix))
    throw new Error('fixture removal target is outside the owned root');
  return realTarget;
}

function writeCleanupMarker(target: string): void {
  const parent = checkedFixturePath(path.dirname(target));
  writeFileSync(path.join(parent, path.basename(target)), 'stop', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function removeOwnedFixture(
  target: string,
  remove: (target: string) => void = (owned) =>
    rmSync(owned, { recursive: true, force: true }),
): void {
  remove(checkedFixturePath(target));
}

interface Observed {
  errors: Error[];
  exits: [number | null, NodeJS.Signals | null][];
}

function observe(proxy: SpawnedProcess): Observed {
  const observed: Observed = { errors: [], exits: [] };
  proxy.on('error', (error: Error) => observed.errors.push(error));
  proxy.on('exit', (code: number | null, signal: NodeJS.Signals | null) =>
    observed.exits.push([code, signal]),
  );
  return observed;
}

function startCli(
  spawn: typeof spawnClaudeCodeProcessOffMain,
  args: string[],
  command: string = process.execPath,
): SpawnedProcess {
  return spawn({
    command,
    args,
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    signal: new AbortController().signal,
  });
}

/**
 * The host in this process, over a channel shaped like Electron's parent
 * port: the runner's messages reach the host as `{ data }`, the host's reach
 * the runner as sent, each on a later microtask.
 */
class InProcessClaudeHost extends ReportedExecutionHost {
  private readonly hostListeners = new Set<
    (event: { data: unknown }) => void
  >();
  private closed = false;
  readonly channel: ExecutionHostChannel;

  constructor(start: typeof startClaudeProcessHost) {
    super();
    const channel: ExecutionHostChannel = {
      postMessage: (message: unknown): void => {
        if (this.closed) return;
        const sent = structuredClone(message);
        queueMicrotask(() => this.reportMessage(sent));
      },
      on: (_event, listener) => {
        this.hostListeners.add(listener);
        return channel;
      },
      once: (_event, listener) => {
        const once = (event: { data: unknown }): void => {
          this.hostListeners.delete(once);
          listener(event);
        };
        this.hostListeners.add(once);
        return channel;
      },
    };
    this.channel = channel;
    start(channel, (code) => this.exit(code));
    queueMicrotask(() => this.reportSpawn());
  }

  get pid(): number | undefined {
    return undefined;
  }

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('The in-process host has exited.');
    const data = structuredClone(message);
    queueMicrotask(() => {
      if (this.closed) return;
      for (const listener of Array.from(this.hostListeners)) listener({ data });
    });
  }

  kill(): boolean {
    if (this.exited || this.closed) return false;
    this.exit(1);
    return true;
  }

  /** Ends the host; `exit` follows every message it already sent. */
  exit(code: number): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.reportExit(code));
  }
}

function inProcessPort(
  start: typeof startClaudeProcessHost,
  hosts: ExecutionHostProcess[],
): ExecutionHostPort {
  return {
    launch() {
      const host = new InProcessClaudeHost(start);
      hosts.push(host);
      return host;
    },
    probe: () => Promise.reject(new Error('not used')),
  };
}

beforeAll(() => {
  const root = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'claude-host-')),
  );
  const stat = lstatSync(root);
  ownedRoot = { path: root, dev: stat.dev, ino: stat.ino };
  dir = path.join(root, 'fixtures');
  mkdirSync(dir);
  if (os === 'win32') return;
  buildSync({
    entryPoints: [
      path.join(
        ROOT,
        'apps/desktop-app/src/main/agents/claude-process-host-worker.ts',
      ),
    ],
    outfile: path.join(dir, ENTRY),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: path.join(ROOT, 'tsconfig.base.json'),
    external: ['electron', 'node:*'],
    define: { __CANOPY_E2E__: 'false' },
    logLevel: 'silent',
  });
});

afterEach(async () => {
  try {
    // Markers follow the case's lifecycle assertions and product shutdown.
    // They cannot satisfy the product's reaping assertions on its behalf.
    const cleanupErrors: unknown[] = [];
    for (const marker of cleanupMarkers.values()) {
      try {
        writeCleanupMarker(marker);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    // Request every owned idle fixture's cooperative exit, even when another
    // fixture's marker could not be written. Do not signal before these waits.
    for (const child of ownedChildren) {
      try {
        child.stdin?.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    // A case can fail before pidsOf. Missing or partial records cannot prove
    // that its fixtures exited, so they fail cleanup and retain the root.
    for (const pidFile of [...cleanupMarkers.keys(), ...streamPidFiles]) {
      try {
        if (streamPidFiles.has(pidFile)) recordStreamFixturePid(pidFile);
        else recordFixturePids(pidFile);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const cooperativeWaits = Promise.allSettled(
      Array.from(ownedChildren, (child) =>
        until(
          () => child.exitCode !== null || child.signalCode !== null,
          REAP_WITHIN_MS,
        ),
      ),
    );
    // Poll during the cooperative waits; only a live observer's signal fallback
    // waits for every cooperative wait to settle. Closed observers do not wait.
    const observedExits = await Promise.allSettled([
      until(
        () => nonePresent(Array.from(observedPids), cooperativeWaits),
        REAP_WITHIN_MS,
      ),
    ]);
    const cooperativeExits = await cooperativeWaits;
    for (const result of [...cooperativeExits, ...observedExits]) {
      if (result.status === 'rejected') cleanupErrors.push(result.reason);
    }
    // The fallback is only for a still-live owned idle handle, after EVERY
    // fixture has received its cooperative request and its bounded exit wait.
    await Promise.all(Array.from(ownedChildren, stopOwnedChild));
    for (const [child, exits] of signalledFixtureExits) {
      await until(() => exits.length === 1, REAP_WITHIN_MS);
      expect(exits).toEqual([[null, 'SIGKILL']]);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBe('SIGKILL');
      // Read the real handle's state. Only request history is cleared in this
      // immutable snapshot; the real signalCode is now the only refusal input.
      const lifecycleState = { ...childSignalState(child), requested: false };
      expect(lifecycleState).toMatchObject({
        owned: true,
        exitCode: null,
        signalCode: 'SIGKILL',
        requested: false,
      });
      expect(validPid(lifecycleState.pid)).toBe(true);
      expect(maySignal(lifecycleState)).toBe(false);
      const calls: ChildProcess[] = [];
      expect(
        signalOwnedChild(child, (owned) => {
          calls.push(owned);
          return true;
        }),
      ).toBe(false);
      expect(calls).toEqual([]);
    }
    await until(
      () => nonePresent(Array.from(observedPids)),
      REAP_WITHIN_MS,
      () => remaining(Array.from(observedPids)),
    );
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        cleanupErrors,
        'cooperative fixture cleanup failed',
      );
  } catch (error) {
    cleanupConfirmed = false;
    const children = Array.from(ownedChildren, (child) => child.pid).filter(
      validPid,
    );
    throw new Error(
      `fixture cleanup unconfirmed; retained ${ownedRoot?.path}; observed pids [${Array.from(observedPids).join(', ')}]; owned pids [${children.join(', ')}]`,
      { cause: error },
    );
  } finally {
    observedPids.clear();
    hostPids.clear();
    cleanupMarkers.clear();
    streamPidFiles.clear();
    ownedChildren.clear();
    signalledFixtureExits.clear();
  }
}, CLEANUP_TIMEOUT_MS);

afterAll(() => {
  if (!ownedRoot) return;
  if (!cleanupConfirmed)
    throw new Error(
      `cleanup unconfirmed; retained fixtures at ${ownedRoot.path}`,
    );
  removeOwnedFixture(dir);
  rmdirSync(checkedRoot()); // Empty owned root only; never recursive.
});

describe('qualification fixture cleanup guards', () => {
  it('resolves the Windows observer only from a local absolute drive root', () => {
    expect(windowsObserverCommand('C:\\Windows')).toBe(
      'C:\\Windows\\System32\\tasklist.exe',
    );
  });

  it.each([
    ['missing', undefined],
    ['drive-relative', 'C:Windows'],
    ['current-drive-rooted', '\\Windows'],
    ['UNC network', '\\\\server\\share'],
    ['extended device', '\\\\?\\C:\\Windows'],
    ['device namespace', '\\\\.\\C:\\Windows'],
  ])('refuses a %s Windows observer root', (_name, root) => {
    expect(() => windowsObserverCommand(root)).toThrow(
      'Windows system root is not a local absolute drive path',
    );
  });

  it('refuses a second signal after its owned fixture exits from a signal', async () => {
    const child = await startOwnedIdleChild();
    expect(validPid(child.pid)).toBe(true);
    const exits: Array<[number | null, NodeJS.Signals | null]> = [];
    signalledFixtureExits.set(child, exits);
    child.once('exit', (code, signal) => exits.push([code, signal]));
    expect(signalOwnedChild(child)).toBe(true);
    // afterEach waits for the real exit event before checking inert refusal.
  });

  it('records only a live owned handle and refuses unsafe or reaped targets', async () => {
    const child = await startOwnedIdleChild();
    const records: Array<{
      child: ChildProcess;
      pid: number | undefined;
      signal: 'SIGKILL';
    }> = [];
    const inertSignaller = (owned: ChildProcess): boolean => {
      records.push({ child: owned, pid: owned.pid, signal: 'SIGKILL' });
      return true;
    };
    try {
      const state = childSignalState(child);
      const refusals: SignalEligibility[] = [
        ...[
          undefined,
          null,
          NaN,
          Infinity,
          -2,
          -1,
          0,
          1,
          1.5,
          2_147_483_648,
        ].map((pid) => ({ ...state, pid })),
        { ...state, owned: false },
        { ...state, exitCode: 0 },
        { ...state, signalCode: 'SIGKILL' },
        { ...state, requested: true },
      ];
      // Invalid numbers stay in immutable guard inputs. No handle field changes,
      // and every guard row uses the inert signaller, never a system signal.
      for (const refusal of refusals) {
        expect(signalOwnedChild(child, inertSignaller, refusal)).toBe(false);
        expect(records).toEqual([]);
      }
      expect(signalOwnedChild(child, inertSignaller)).toBe(true);
      expect(records).toEqual([{ child, pid: child.pid, signal: 'SIGKILL' }]);
      expect(signalOwnedChild(child, inertSignaller)).toBe(false);
      expect(records).toHaveLength(1);
    } finally {
      await endIdleChild(child);
    }

    const reaped = await startOwnedIdleChild();
    await endIdleChild(reaped);
    records.length = 0;
    expect(signalOwnedChild(reaped, inertSignaller)).toBe(false);
    expect(records).toEqual([]);

    const unregistered = await startOwnedIdleChild(false);
    try {
      expect(signalOwnedChild(unregistered, inertSignaller)).toBe(false);
      expect(records).toEqual([]);
    } finally {
      await endIdleChild(unregistered);
    }
  });

  it('records only a contained removal and refuses root, prefix and symlink escapes', () => {
    const root = checkedRoot();
    const target = path.join(dir, 'removal-guard');
    mkdirSync(target);
    const escape = path.join(dir, 'removal-escape');
    symlinkSync(root, escape, 'junction');
    const removals: string[] = [];
    const inertRemover = (candidate: string): void => {
      removals.push(candidate);
    };
    for (const outside of [
      root,
      `${root}-sibling`,
      path.dirname(root),
      escape,
    ]) {
      expect(() => removeOwnedFixture(outside, inertRemover)).toThrow(
        'fixture removal target is outside the owned root',
      );
      expect(removals).toEqual([]);
    }
    removeOwnedFixture(target, inertRemover);
    expect(removals).toEqual([realpathSync.native(target)]);
    expect(existsSync(target)).toBe(true);

    const marker = path.join(target, 'cleanup.stop');
    writeCleanupMarker(marker);
    expect(readFileSync(marker, 'utf8')).toBe('stop');
    expect(() => writeCleanupMarker(marker)).toThrow();
    const sentinel = path.join(target, 'marker-sentinel');
    writeFileSync(sentinel, 'unchanged', 'utf8');
    const linkedMarker = path.join(target, 'linked.stop');
    symlinkSync(
      os === 'win32' ? target : sentinel,
      linkedMarker,
      os === 'win32' ? 'junction' : 'file',
    );
    expect(() => writeCleanupMarker(linkedMarker)).toThrow();
    expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
    expect(() => writeCleanupMarker(path.join(escape, 'cleanup.stop'))).toThrow(
      'fixture removal target is outside the owned root',
    );
  });
});

describe.each(['in-process', 'owned-process'] as const)(
  'Claude process host %s',
  (mode) => {
    const describeMode =
      mode === 'owned-process' && os === 'win32' ? describe.skip : describe;

    describeMode('over the execution host port', () => {
      let hosts: ExecutionHostProcess[];
      let services: PlatformExecutionProcessServices | undefined;

      beforeEach(() => {
        resetClaudeProcessHostForTests();
        jest.mocked(registerHostedClaudeProcess).mockClear();
        hosts = [];
        services = undefined;
        if (mode === 'in-process') {
          setExecutionHostPort(inProcessPort(startClaudeProcessHost, hosts));
          return;
        }
        services = createExecutionProcessServices({ os });
        const owned = createOwnedProcessHostPort({
          services,
          nodeExecutable: process.execPath,
          entryDirectory: dir,
          cwd: dir,
          environment: () => process.env,
        });
        setExecutionHostPort({
          launch(request) {
            const host = owned.launch(request);
            hosts.push(host);
            host.once('spawn', () => {
              if (host.pid !== undefined) hostPids.add(host.pid);
            });
            return host;
          },
          probe: (request) => owned.probe(request),
        });
      });

      afterEach(async () => {
        await shutdownClaudeProcessHost();
        resetClaudeProcessHostForTests();
        await services?.shutdown();
        setExecutionHostPort(undefined);
      });

      it(
        "streams a CLI's stdout with credit and reports its exit",
        async () => {
          const size = 200 * 1024;
          const expected = Buffer.alloc(size);
          for (let i = 0; i < size; i += 1) expected[i] = i % 251;
          const pidFile = path.join(dir, `${mode}-stream.pid`);
          // Enroll the record before launch, so any early failure still makes
          // cleanup recover the pid or fail closed and retain the artifacts.
          streamPidFiles.add(pidFile);
          const proxy = startCli(spawnClaudeCodeProcessOffMain, [
            '-e',
            `setTimeout(() => process.exit(3), ${FIXTURE_DEADLINE_MS}).unref();
             const b = Buffer.alloc(${size});
             for (let i = 0; i < b.length; i += 1) b[i] = i % 251;
             require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
             process.stdout.write(b);`,
          ]);
          const observed = observe(proxy);
          const chunks: Buffer[] = [];
          proxy.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
          const ended = new Promise<void>((resolve) =>
            proxy.stdout.once('end', () => resolve()),
          );
          await ended;
          await until(() => observed.exits.length > 0);
          await delay(50);

          expect(Buffer.concat(chunks).equals(expected)).toBe(true);
          expect(observed.exits).toEqual([[0, null]]);
          expect(observed.errors).toEqual([]);
          const pid = recordStreamFixturePid(pidFile);
          await until(() => nonePresent([pid]));
        },
        CASE_TIMEOUT_MS,
      );

      it(
        "an ignored SIGTERM ends the CLI's whole group",
        async () => {
          const pidFile = path.join(dir, `${mode}-sigterm.pid`);
          const proxy = startCli(spawnClaudeCodeProcessOffMain, [
            '-e',
            waitingScript(pidFile, true),
          ]);
          const observed = observe(proxy);
          const [cli, grandchild] = await pidsOf(pidFile);

          expect(proxy.kill('SIGTERM')).toBe(true);
          await until(() => nonePresent([cli, grandchild]), REAP_WITHIN_MS);
          await until(() => observed.exits.length > 0);
          expect(observed.exits).toHaveLength(1);
        },
        CASE_TIMEOUT_MS,
      );

      it(
        'a host that exits ends every proxy once and reaps their groups',
        async () => {
          const files = [1, 2].map((n) =>
            path.join(dir, `${mode}-host-exit-${n}.pid`),
          );
          const proxies = files.map((file) =>
            startCli(spawnClaudeCodeProcessOffMain, [
              '-e',
              waitingScript(file, false),
            ]),
          );
          const observed = proxies.map(observe);
          const groups = await Promise.all(files.map(pidsOf));
          const pids = groups.flat();
          // The runner reaps the groups of CLIs whose start it has read. A pid
          // file shows a CLI runs, not that the host's report of it arrived.
          await until(
            () => groups.every(([cli]) => trackedPids().has(cli)),
            undefined,
            () =>
              `runner tracked [${Array.from(trackedPids()).join(', ')}] of CLIs [${groups
                .map(([cli]) => cli)
                .join(', ')}]`,
          );
          expect(hosts).toHaveLength(1);

          const host = hosts[0];
          if (host instanceof InProcessClaudeHost) host.exit(1);
          else expect(host.kill()).toBe(true);

          await until(
            () => nonePresent(pids),
            REAP_WITHIN_MS,
            async () =>
              `still present: ${await remaining(pids)}; proxies ended: ${
                observed.filter((o) => o.exits.length > 0).length
              } of ${observed.length}`,
          );
          await until(() => observed.every((o) => o.exits.length > 0));
          await delay(50);
          for (const o of observed) {
            expect(o.errors).toHaveLength(1);
            expect(o.errors[0].message).toMatch(HOST_EXIT_ERROR);
            expect(o.exits).toEqual([[null, 'SIGKILL']]);
          }
        },
        CASE_TIMEOUT_MS,
      );
    });
  },
);

describe('Claude process host in-process: a post-spawn error', () => {
  it(
    'a child that errors after it spawned stays tracked until it exits',
    async () => {
      const fake = Object.assign(new EventEmitter(), {
        pid: (await startOwnedIdleChild()).pid,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: jest.fn(() => true),
      });
      let fakeExited = false;
      // The case exits the child itself, once it has seen the child stay
      // tracked; a timer here would race those checks on a loaded runner.
      const exitFake = (): void => {
        fakeExited = true;
        fake.stdout.end();
        fake.stderr.end();
        fake.emit('exit', 0, null);
        fake.emit('close', 0, null);
      };
      const spawn = jest.fn(() => {
        setImmediate(() => {
          fake.emit('error', new Error('kill EPERM'));
          fake.emit('error', new Error('kill EPERM'));
        });
        return fake;
      });
      let runner: typeof RunnerModule | undefined;
      let host: typeof HostModule | undefined;
      let port: typeof PortModule | undefined;
      jest.isolateModules(() => {
        jest.doMock('node:child_process', () => ({
          ...jest.requireActual<object>('node:child_process'),
          spawn,
        }));
        // The fake's pid (an idle child this test owns) must never reach a
        // real process group.
        jest.doMock('../lib/process-kill', () => ({
          ...jest.requireActual<object>('../lib/process-kill'),
          killChildProcessGroup: jest.fn(
            (
              child: { kill(signal: NodeJS.Signals): boolean },
              signal: NodeJS.Signals,
            ) => child.kill(signal),
          ),
        }));
        jest.doMock('@canopy/execution-engine/node/lib/process-kill', () => ({
          ...jest.requireActual<object>(
            '@canopy/execution-engine/node/lib/process-kill',
          ),
          killProcessGroupByPid: jest.fn(() => Promise.resolve()),
        }));
        host = jest.requireActual<typeof HostModule>(
          '../agents/claude-process-host-worker',
        );
        runner = jest.requireActual<typeof RunnerModule>(
          '../agents/claude-process-host-runner',
        );
        port = jest.requireActual<typeof PortModule>(
          '../execution-host/utility-process-host',
        );
      });
      if (!runner || !host || !port) throw new Error('modules did not load');
      port.setExecutionHostPort(inProcessPort(host.startClaudeProcessHost, []));

      try {
        const proxy = startCli(
          runner.spawnClaudeCodeProcessOffMain,
          [],
          'claude',
        );
        const observed = observe(proxy);
        const exitedBeforeExit: boolean[] = [];
        proxy.on('exit', () => exitedBeforeExit.push(fakeExited));

        await until(() => observed.errors.length > 0);
        await delay(20);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(observed.errors).toHaveLength(1);
        expect(observed.errors[0].message).toBe('kill EPERM');
        expect(observed.exits).toEqual([]);
        expect(proxy.kill('SIGKILL')).toBe(true);
        await until(() => fake.kill.mock.calls.length > 0);
        expect(fake.kill).toHaveBeenCalledWith('SIGKILL');
        await delay(20);
        expect(observed.exits).toEqual([]);

        exitFake();
        await until(() => observed.exits.length > 0);
        await delay(50);
        expect(observed.exits).toEqual([[0, null]]);
        expect(exitedBeforeExit).toEqual([true]);
        expect(observed.errors).toHaveLength(1);
      } finally {
        // A case that failed early still lets the fake child exit.
        if (!fakeExited) exitFake();
        await runner.shutdownClaudeProcessHost();
        runner.resetClaudeProcessHostForTests();
        port.setExecutionHostPort(undefined);
      }
    },
    CASE_TIMEOUT_MS,
  );
});

describe('Claude process host served over a launched channel', () => {
  it(
    'a launcher that disconnects leaves no CLI running',
    async () => {
      const posted: unknown[] = [];
      const listeners = new Set<(event: { data: unknown }) => void>();
      let disconnect: (() => void) | undefined;
      const exit = jest.fn();
      const channel: ConnectedExecutionHostChannel = {
        postMessage: (message) => {
          posted.push(message);
        },
        on: (_event, listener) => {
          listeners.add(listener);
          return channel;
        },
        once: (_event, listener) => {
          const once = (event: { data: unknown }): void => {
            listeners.delete(once);
            listener(event);
          };
          listeners.add(once);
          return channel;
        },
        exit,
        congested: () => false,
        onceDrained: (listener) => listener(),
        onDisconnect: (handler) => {
          disconnect = handler;
        },
      };
      serveClaudeProcessHost(channel);
      const pidFile = path.join(dir, 'disconnect.pid');
      for (const listener of Array.from(listeners))
        listener({
          data: {
            type: 'spawn',
            requestId: 'disconnect-1',
            command: process.execPath,
            args: ['-e', waitingScript(pidFile, false)],
            cwd: dir,
            env: { PATH: process.env.PATH ?? '' },
          },
        });
      const [cli, grandchild] = await pidsOf(pidFile);

      if (!disconnect) throw new Error('the host registered no disconnect');
      disconnect();
      await until(() => nonePresent([cli, grandchild]), REAP_WITHIN_MS);
      await until(() => exit.mock.calls.length > 0);
      expect(posted).toContainEqual({ type: 'shutdown-complete' });
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    },
    CASE_TIMEOUT_MS,
  );
});

/** A host that reports `spawn` only when told and never exits by itself. */
class PendingHost extends ReportedExecutionHost {
  private launched = false;
  readonly kill = jest.fn((): boolean => this.launched);

  get pid(): number | undefined {
    return undefined;
  }

  postMessage(): void {
    // Messages wait for a start that the test controls.
  }

  start(): void {
    this.launched = true;
    this.reportSpawn();
  }

  end(code: number): void {
    this.reportExit(code);
  }
}

describe('Claude process host shutdown before spawn', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetClaudeProcessHostForTests();
    setExecutionHostPort(undefined);
  });

  it('shutdown stops a host that has not spawned yet', async () => {
    jest.useFakeTimers();
    resetClaudeProcessHostForTests();
    const host = new PendingHost();
    setExecutionHostPort({
      launch: () => host,
      probe: () => Promise.reject(new Error('not used')),
    });
    const proxy = startCli(spawnClaudeCodeProcessOffMain, [], 'claude');
    observe(proxy);

    const shutdown = shutdownClaudeProcessHost();
    await jest.advanceTimersByTimeAsync(6_000);
    expect(host.kill).toHaveBeenCalledTimes(1);
    expect(host.kill).toHaveReturnedWith(false);

    host.start();
    expect(host.kill).toHaveBeenCalledTimes(2);
    expect(host.kill).toHaveLastReturnedWith(true);

    host.end(0);
    await expect(shutdown).resolves.toBeUndefined();
  });
});
