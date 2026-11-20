import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { killProcessGroupByPid } from '@canopy/execution-engine/node/lib/process-kill';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';

const execFileAsync = promisify(execFile);

/**
 * The host's PID file (CAN-6995). The registry encodes and decodes it; the
 * host reads and writes the file under its own data root, so Electron main
 * and the daemon each persist where their resolver says.
 */
export interface ClaudeProcessPidStore {
  /** The file's text; rejects when it is missing or unreadable. */
  read(): Promise<string>;
  /** Replaces the file's text. */
  write(text: string): Promise<void>;
}

let pidStore: ClaudeProcessPidStore | undefined;

/** Binds the registry to its host's PID file store, once at import. */
export function configureClaudeProcessRegistry(options: {
  readonly store: ClaudeProcessPidStore;
}): void {
  pidStore = options.store;
}

function boundPidStore(): ClaudeProcessPidStore {
  if (!pidStore)
    throw new Error('The Claude process registry has no PID file store bound.');
  return pidStore;
}

/**
 * Persisted identity of the Claude CLIs the Claude process host started, so
 * the next launch can reap CLIs a crash left behind. The host spawns them
 * detached (their own process groups), so they outlive a crashed Electron
 * main or host. Mirrors the Codex app-server registry
 * (`codex-app-server-process-registry.ts`).
 *
 * CLI argv carries bearer tokens, so only the executable path is persisted
 * and compared, never the arguments.
 */
export interface HostedClaudeProcessRecord {
  pid: number;
  /** Wall-clock time the host took immediately before spawning. */
  startedAtMs: number;
  /** argv[0]: the CLI executable path. */
  executable: string;
  /** The owning chat, when a chat session or its delegated run spawned it. */
  sessionKey?: string;
  sessionInstanceId?: string;
  delegationId?: string;
}

interface ClaudeProcessPidsFile {
  version: 1;
  processes: HostedClaudeProcessRecord[];
}

/** What the OS reports for a live PID. `commandLine` stays in memory only. */
export interface ObservedProcessIdentity {
  commandLine: string;
  /** The latest time the process can have started. */
  startedAtMs: number;
  /**
   * The earliest, when the probe only bounds the start: `ps` reports whole
   * seconds of elapsed time, measured at an unknown moment of the probe.
   */
  earliestStartedAtMs?: number;
}

/** Process operations, injectable for tests. */
export interface ClaudeProcessIdentityOps {
  readProcessIdentity(pid: number): Promise<ObservedProcessIdentity | null>;
  killProcessTree(pid: number): Promise<void>;
}

/**
 * How far an observed start time may sit from the recorded one. `ps` reports
 * elapsed time in whole seconds and a spawn can stall; a reused PID would have
 * to start within this window and run the same executable to be mistaken.
 */
const START_TIME_TOLERANCE_MS = 5_000;
/** Bounds the startup sweep against a corrupt or runaway file. */
const MAX_PERSISTED_RECORDS = 1_024;

const currentRun = new Map<number, HostedClaudeProcessRecord>();
/**
 * PIDs registered while a sweep runs, kept after they exit: the previous
 * run's CLI must have died to free a PID this run spawned under.
 */
const registeredDuringSweeps = new Set<Set<number>>();
let persistQueue: Promise<void> = Promise.resolve();
let previousRunRecords: Promise<HostedClaudeProcessRecord[]> | null = null;
// Opt-in (enabled once at app startup) so unit tests that spawn through the
// runner never write a pid file into a real data dir.
let pidPersistenceEnabled = false;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseRecord(value: unknown): HostedClaudeProcessRecord | null {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.pid) ||
    typeof value.startedAtMs !== 'number' ||
    !Number.isFinite(value.startedAtMs) ||
    typeof value.executable !== 'string' ||
    value.executable.length === 0
  ) {
    return null;
  }
  return {
    pid: value.pid,
    startedAtMs: value.startedAtMs,
    executable: value.executable,
    ...(typeof value.sessionKey === 'string'
      ? { sessionKey: value.sessionKey }
      : {}),
    ...(typeof value.sessionInstanceId === 'string'
      ? { sessionInstanceId: value.sessionInstanceId }
      : {}),
    ...(typeof value.delegationId === 'string'
      ? { delegationId: value.delegationId }
      : {}),
  };
}

async function readPersistedRecords(): Promise<HostedClaudeProcessRecord[]> {
  try {
    const raw = await boundPidStore().read();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.processes)) return [];
    const records: HostedClaudeProcessRecord[] = [];
    for (const value of parsed.processes.slice(0, MAX_PERSISTED_RECORDS)) {
      const record = parseRecord(value);
      if (record) records.push(record);
    }
    return records;
  } catch {
    return [];
  }
}

async function persistCurrentRun(): Promise<void> {
  const data: ClaudeProcessPidsFile = {
    version: 1,
    processes: Array.from(currentRun.values()).sort((a, b) => a.pid - b.pid),
  };
  await boundPidStore().write(JSON.stringify(data, null, 2));
}

function queuePersist(): void {
  if (!pidPersistenceEnabled) return;
  persistQueue = persistQueue.then(persistCurrentRun).catch(() => undefined);
}

/**
 * Turn on pid-file persistence for this process, once at app startup. The
 * previous run's file is read before this run's first write can replace it.
 */
export function enableClaudeProcessPidPersistence(): void {
  if (pidPersistenceEnabled) return;
  // Reads and writes swallow their failures, so an unbound store fails here.
  boundPidStore();
  pidPersistenceEnabled = true;
  const previous = readPersistedRecords();
  previousRunRecords = previous;
  persistQueue = previous.then(() => undefined);
  if (currentRun.size > 0) queuePersist();
}

/** Track a hosted Claude CLI once the host reports its PID. */
export function registerHostedClaudeProcess(
  record: HostedClaudeProcessRecord,
): void {
  if (!isPositiveInteger(record.pid)) return;
  currentRun.set(record.pid, record);
  registeredDuringSweeps.forEach((registered) => registered.add(record.pid));
  queuePersist();
}

/** Stop tracking a hosted Claude CLI once it exited or was SIGKILLed. */
export function unregisterHostedClaudeProcess(pid: number): void {
  if (currentRun.delete(pid)) queuePersist();
}

function commandLineStartsWithExecutable(
  commandLine: string,
  executable: string,
  windows: boolean,
): boolean {
  const normalize = (value: string): string =>
    windows ? value.toLowerCase() : value;
  const line = normalize(commandLine.trim());
  const exe = normalize(executable);
  if (exe.length === 0) return false;
  if (line === exe || line.startsWith(`${exe} `)) return true;
  // Windows quotes an executable path that contains spaces.
  return windows && (line === `"${exe}"` || line.startsWith(`"${exe}" `));
}

/**
 * Whether a live PID is still the recorded CLI: it started when the host
 * spawned it and runs the same executable. Argv beyond argv[0] is never
 * compared because it is never persisted.
 */
export function isSameHostedClaudeProcess(
  record: HostedClaudeProcessRecord,
  observed: ObservedProcessIdentity,
  platform: NodeJS.Platform | null = hostOperatingSystem(),
): boolean {
  const earliest = observed.earliestStartedAtMs ?? observed.startedAtMs;
  if (
    !Number.isFinite(observed.startedAtMs) ||
    !Number.isFinite(earliest) ||
    record.startedAtMs < earliest - START_TIME_TOLERANCE_MS ||
    record.startedAtMs > observed.startedAtMs + START_TIME_TOLERANCE_MS
  ) {
    return false;
  }
  return commandLineStartsWithExecutable(
    observed.commandLine,
    record.executable,
    platform === 'win32',
  );
}

/** Parses `ps -o etime=` (`[[dd-]hh:]mm:ss`) into seconds. */
export function parseElapsedSeconds(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) *
      60 +
    Number(seconds)
  );
}

/**
 * Splits `ps -o etime= -o args=` output into its two columns. `ps` measured
 * the elapsed time between `beforeMs` and `afterMs`, so a slow probe widens
 * the start-time bounds instead of shifting them.
 */
export function parsePsIdentity(
  stdout: string,
  beforeMs: number,
  afterMs: number = beforeMs,
): ObservedProcessIdentity | null {
  const line = stdout.replace(/^\s+/, '').replace(/\r?\n$/, '');
  const separator = line.search(/\s/);
  if (separator <= 0) return null;
  const elapsedSeconds = parseElapsedSeconds(line.slice(0, separator));
  const commandLine = line.slice(separator + 1);
  if (elapsedSeconds === null || commandLine.length === 0) return null;
  return {
    commandLine,
    startedAtMs: afterMs - elapsedSeconds * 1_000,
    earliestStartedAtMs: beforeMs - (elapsedSeconds + 1) * 1_000,
  };
}

async function defaultReadProcessIdentity(
  pid: number,
): Promise<ObservedProcessIdentity | null> {
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
            'if ($null -ne $process) { @{ commandLine = [string]$process.CommandLine; startedAtMs = ([DateTimeOffset]$process.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }',
          ].join('; '),
        ],
        { windowsHide: true },
      );
      if (stdout.trim().length === 0) return null;
      const parsed: unknown = JSON.parse(stdout);
      if (
        !isRecord(parsed) ||
        typeof parsed.commandLine !== 'string' ||
        typeof parsed.startedAtMs !== 'number'
      ) {
        return null;
      }
      return {
        commandLine: parsed.commandLine,
        startedAtMs: parsed.startedAtMs,
      };
    }
    const beforeMs = Date.now();
    const { stdout } = await execFileAsync('ps', [
      '-ww',
      '-p',
      String(pid),
      '-o',
      'etime=',
      '-o',
      'args=',
    ]);
    return parsePsIdentity(stdout, beforeMs, Date.now());
  } catch {
    // `ps`/PowerShell fail when the PID no longer exists: nothing to reap.
    return null;
  }
}

const defaultProcessOps: ClaudeProcessIdentityOps = {
  readProcessIdentity: defaultReadProcessIdentity,
  killProcessTree: (pid) =>
    killProcessGroupByPid(pid, 'SIGKILL', { timeoutMs: 5_000 }),
};

/**
 * Kill Claude CLIs a previous run of this app instance (same data dir) left
 * running. Each persisted PID is killed only while it still matches the
 * recorded start time and executable, so a reused PID is spared. Returns the
 * reaped records.
 */
export async function reapStaleClaudeProcesses(
  ops: ClaudeProcessIdentityOps = defaultProcessOps,
): Promise<HostedClaudeProcessRecord[]> {
  const registeredDuringSweep = new Set<number>();
  registeredDuringSweeps.add(registeredDuringSweep);
  const hostedByThisRun = (pid: number): boolean =>
    currentRun.has(pid) || registeredDuringSweep.has(pid);
  const reaped: HostedClaudeProcessRecord[] = [];
  try {
    const records = await (previousRunRecords ?? readPersistedRecords());
    previousRunRecords = null;
    for (const record of records) {
      if (hostedByThisRun(record.pid)) continue;
      let observed: ObservedProcessIdentity | null;
      try {
        observed = await ops.readProcessIdentity(record.pid);
      } catch {
        observed = null;
      }
      if (!observed || !isSameHostedClaudeProcess(record, observed)) continue;
      // Recheck: this run may have spawned under the PID during the probe.
      if (hostedByThisRun(record.pid)) continue;
      await ops.killProcessTree(record.pid);
      reaped.push(record);
    }
  } finally {
    registeredDuringSweeps.delete(registeredDuringSweep);
  }
  // Rewrite the file so it reflects only this run's live CLIs.
  queuePersist();
  await persistQueue;
  return reaped;
}

/** Test-only: reset module state between tests. */
export function resetClaudeProcessRegistryForTests(): void {
  currentRun.clear();
  registeredDuringSweeps.clear();
  persistQueue = Promise.resolve();
  previousRunRecords = null;
  pidPersistenceEnabled = false;
}

/** Test-only: await queued pid-file writes. */
export function flushClaudeProcessPidPersistenceForTests(): Promise<void> {
  return persistQueue;
}
