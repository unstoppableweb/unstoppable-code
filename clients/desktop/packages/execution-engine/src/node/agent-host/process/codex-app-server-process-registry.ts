import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

const execFileAsync = promisify(execFile);

/**
 * The host's PID file (CAN-6995). The registry encodes and decodes it; the
 * host reads and writes the file under its own data root.
 */
export interface CodexAppServerPidStore {
  /** The file's text; rejects when it is missing or unreadable. */
  read(): Promise<string>;
  /** Replaces the file's text. */
  write(text: string): Promise<void>;
}

interface CodexAppServerProcessRegistryHost {
  readonly store: CodexAppServerPidStore;
  readonly killChildProcessGroup: (
    child: ChildProcess,
    signal: NodeJS.Signals,
  ) => void;
}

let host: CodexAppServerProcessRegistryHost | undefined;

/**
 * Binds the registry to its host (CAN-6995): the PID file store and the
 * host's process-group kill. Electron main binds both once at import; an
 * unbound registry fails loudly instead of choosing a file or a kill.
 */
export function configureCodexAppServerProcessRegistry(
  options: CodexAppServerProcessRegistryHost,
): void {
  host = options;
}

function boundHost(): CodexAppServerProcessRegistryHost {
  if (!host)
    throw new Error('The Codex app-server registry has no host bound.');
  return host;
}

function killChildProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  boundHost().killChildProcessGroup(child, signal);
}

/**
 * Registry of Codex app-server child processes spawned by this app instance.
 *
 * Why this exists: app-servers are spawned `detached` (own process group) and
 * quit-time teardown historically relied on SIGTERM plus an unref'd SIGKILL
 * timer that dies with the Electron main process. A Codex app-server that is
 * slow to exit (e.g. flushing or recovering a large state DB) survives the app
 * as an orphan holding the shared `~/.codex` state DB — which wedges every
 * app-server spawned by the *next* app launch (chat sessions and marketplace
 * operations alike). The registry provides:
 *
 * 1. `terminateAllCodexAppServerProcesses()` — a bounded, awaited
 *    SIGTERM → wait → SIGKILL sweep for app quit, covering pooled connections
 *    and one-shot connections (marketplace/discovery) that are not owned by a
 *    chat session.
 * 2. Persisted PIDs + `reapStaleCodexAppServerProcesses()` — the next launch
 *    verifies leftover PIDs still run a Codex app-server and force-kills them
 *    before new spawns contend on the shared state DB.
 */

interface CodexAppServerPidsFile {
  version: 1;
  pids: number[];
}

/**
 * Process operations, injectable for tests. Defaults use `ps`/`kill` on
 * POSIX and PowerShell/CIM plus `taskkill` on Windows.
 */
export interface CodexAppServerProcessOps {
  isCodexAppServerProcess(pid: number): Promise<boolean>;
  killProcessTree(pid: number): Promise<void>;
}

const liveProcesses = new Set<ChildProcess>();
const currentRunPids = new Set<number>();
let persistQueue: Promise<void> = Promise.resolve();
// Persistence is opt-in (enabled once at app startup) so unit tests that
// exercise pool spawn paths never write pid files into a real data dir.
let pidPersistenceEnabled = false;

function isCodexAppServerCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return normalized.includes('codex') && normalized.includes('app-server');
}

function isProcessAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function persistCurrentRunPids(): Promise<void> {
  const data: CodexAppServerPidsFile = {
    version: 1,
    pids: Array.from(currentRunPids).sort((a, b) => a - b),
  };
  await boundHost().store.write(JSON.stringify(data, null, 2));
}

function queuePersist(): void {
  if (!pidPersistenceEnabled) {
    return;
  }
  persistQueue = persistQueue
    .then(persistCurrentRunPids)
    .catch(() => undefined);
}

/**
 * Turn on pid-file persistence for this process. Called once from app
 * startup (before reaping); until then, register/unregister only track in
 * memory so unit tests never touch a real data dir.
 */
export function enableCodexAppServerPidPersistence(): void {
  // Reads and writes swallow their failures, so an unbound host fails here.
  boundHost();
  pidPersistenceEnabled = true;
}

/** Track a freshly spawned Codex app-server child process. */
export function registerCodexAppServerProcess(proc: ChildProcess): void {
  liveProcesses.add(proc);
  if (typeof proc.pid === 'number') {
    currentRunPids.add(proc.pid);
    queuePersist();
  }
}

/** Stop tracking a Codex app-server child once it has exited (or failed). */
export function unregisterCodexAppServerProcess(proc: ChildProcess): void {
  liveProcesses.delete(proc);
  if (typeof proc.pid === 'number' && currentRunPids.delete(proc.pid)) {
    queuePersist();
  }
}

async function readPersistedPids(): Promise<number[]> {
  try {
    const raw = await boundHost().store.read();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.pids)) {
      return [];
    }
    return parsed.pids.filter(
      (pid): pid is number =>
        typeof pid === 'number' && Number.isInteger(pid) && pid > 0,
    );
  } catch {
    return [];
  }
}

async function defaultIsCodexAppServerProcess(pid: number): Promise<boolean> {
  try {
    if (hostOperatingSystem() === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          [
            '$ErrorActionPreference = "Stop"',
            `$process = Get-CimInstance Win32_Process -Filter "ProcessId=${String(
              pid,
            )}"`,
            'if ($null -ne $process) { [string]$process.CommandLine }',
          ].join('; '),
        ],
        { windowsHide: true },
      );
      return isCodexAppServerCommand(stdout);
    }
    const { stdout } = await execFileAsync('ps', [
      '-p',
      String(pid),
      '-o',
      'command=',
    ]);
    return isCodexAppServerCommand(stdout);
  } catch {
    // `ps`/PowerShell fail when the pid no longer exists — nothing to reap.
    return false;
  }
}

async function defaultKillProcessTree(pid: number): Promise<void> {
  if (hostOperatingSystem() === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
      });
    } catch {
      // Best effort: the process may have exited between check and kill.
    }
    return;
  }

  try {
    // App-servers are spawned detached (own process group), so signal the
    // whole group first.
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Best effort: the process may have exited between check and kill.
    }
  }
}

const defaultProcessOps: CodexAppServerProcessOps = {
  isCodexAppServerProcess: defaultIsCodexAppServerProcess,
  killProcessTree: defaultKillProcessTree,
};

/**
 * Kill Codex app-server orphans left behind by a previous run of this app
 * instance (same data dir). Each persisted PID is verified to still be a
 * Codex app-server before it is killed, so PID reuse can never take down an
 * unrelated process. Returns the number of reaped processes.
 */
export async function reapStaleCodexAppServerProcesses(
  ops: CodexAppServerProcessOps = defaultProcessOps,
): Promise<number> {
  const persistedPids = await readPersistedPids();
  let reaped = 0;
  for (const pid of persistedPids) {
    if (currentRunPids.has(pid)) {
      continue;
    }
    if (await ops.isCodexAppServerProcess(pid)) {
      await ops.killProcessTree(pid);
      reaped += 1;
    }
  }
  // Rewrite the file so it only reflects this run's live spawns.
  queuePersist();
  await persistQueue;
  return reaped;
}

/**
 * Quit-time sweep: SIGTERM every live Codex app-server process group, wait up
 * to `graceMs` for exits, then SIGKILL survivors. Bounded and awaited from
 * `cleanupRuntimeResources` so the escalation actually runs before the main
 * process exits (unlike the pool's unref'd force-kill timers).
 */
export async function terminateAllCodexAppServerProcesses(
  graceMs = 1_500,
): Promise<void> {
  const procs = Array.from(liveProcesses).filter(isProcessAlive);
  if (procs.length === 0) {
    return;
  }

  for (const proc of procs) {
    try {
      killChildProcessGroup(proc, 'SIGTERM');
    } catch {
      // Best effort per process; survivors are SIGKILLed below.
    }
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && procs.some(isProcessAlive)) {
    await delay(50);
  }

  for (const proc of procs) {
    if (!isProcessAlive(proc)) {
      continue;
    }
    try {
      killChildProcessGroup(proc, 'SIGKILL');
    } catch {
      // Best effort: the process may have exited between check and kill.
    }
  }
}

/** Test-only: reset module state between tests. */
export function resetCodexAppServerProcessRegistryForTests(): void {
  liveProcesses.clear();
  currentRunPids.clear();
  persistQueue = Promise.resolve();
  pidPersistenceEnabled = false;
}

/** Test-only: await any queued pid-file writes. */
export function flushCodexAppServerPidPersistenceForTests(): Promise<void> {
  return persistQueue;
}

/** Test-only: expose the command-line predicate used before reaping stale PIDs. */
export function isCodexAppServerCommandForTests(command: string): boolean {
  return isCodexAppServerCommand(command);
}
