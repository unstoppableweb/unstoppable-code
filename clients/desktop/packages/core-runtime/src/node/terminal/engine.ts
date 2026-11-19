import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path, { basename } from 'node:path';
import {
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  TERMINAL_CONNECTION_LOST_SIGNAL,
  TERMINAL_SANDBOX_ASLEEP_SIGNAL,
  TERMINAL_WORKTREE_CLEANUP_SIGNAL,
  type PersistedTerminalEntry,
  type TerminalAttachResponse,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type TerminalRunningChangedEvent,
  type TerminalSession,
  type ManagedTerminalCommand,
  type TerminalShellProfile,
  type TerminalShellProfileId,
} from '@canopy/protocol/terminal';
import {
  TerminalAttachments,
  type TerminalAttachmentSource,
  type TerminalAttachmentsOptions,
} from './attachments';
import { sanitizeManagedBaseEnv } from './managed-env';
import type {
  TerminalAttachment,
  TerminalAttachmentRequest,
  TerminalCreateRequest,
  TerminalEngineHost,
  TerminalEnvironment,
  TerminalKillAllOptions,
  TerminalProcessPort,
  TerminalPty,
  TerminalPtySpawnOptions,
  TerminalResourceHandle,
  TerminalRestoreRequest,
  TerminalWorktreeScope,
  WorkerTerminalEvent,
  WorkerTerminalEventListener,
  WorkerTerminalPort,
} from './ports';
import {
  computeTerminalRunningState,
  isTerminalTypeProcessName,
  TerminalRunningDetector,
  type RunningDetectorStore,
  type RunningDetectorTerminalSnapshot,
} from './running-detector';
import type { PlatformOperatingSystem } from '../../platform/platform-services';
import { TerminalReplayWindow } from './replay';
import {
  getErrnoDetail,
  unavailableShellError,
  type ResolvedTerminalShell,
} from './shells';

export const TERMINAL_REPLAY_BUFFER_MAX_BYTES = 256 * 1024;
/** A restored terminal's replay window, which starts with its history. */
export const TERMINAL_RESTORED_REPLAY_MAX_BYTES = 1024 * 1024;
export const TERMINAL_FLUSH_THRESHOLD_BYTES = 8 * 1024;
export const TERMINAL_MAX_UNFLUSHED_BYTES = 2 * 1024 * 1024;
export const TERMINAL_USER_INTERRUPT_SUPPRESS_MS = 5000;
export const WINDOWS_RUNNING_PROCESS_PROBE_INTERVAL_MS = 1000;
export const TERMINAL_KILL_EXIT_GRACE_MS = 2000;
const DEFAULT_MAX_LIVE_TERMINALS = 128;
const WINDOWS_RUNNING_PROCESS_PROBE_TIMEOUT_MS = 1000;
const DEFAULT_LANG = 'en_US.UTF-8';
const INITIAL_COMMAND_SUPPRESSION_MAX_BYTES = 64 * 1024;
const INITIAL_COMMAND_READY_DEBOUNCE_MS = 100;
const INITIAL_COMMAND_FALLBACK_MS = 1000;
const TRUNCATION_MARKER = '\r\n\x1b[33m[output truncated]\x1b[0m\r\n';
/** Prefixes a restored terminal's replay once older bytes left its window. */
export const TRUNCATION_MARKER_BYTES = Buffer.from(TRUNCATION_MARKER, 'utf8');
const RESTORE_MARKER = '[Terminal restarted]';
const CTRL_C = '\x03';
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);
const WINDOWS_TERMINAL_HOST_PROCESS_NAMES = [
  'conhost',
  'openconsole',
  'winpty',
  'winpty-agent',
] as const;

interface PtyInputSocket {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

function getPtyInputSocket(pty: TerminalPty): PtyInputSocket | undefined {
  if (!('_agent' in pty)) return undefined;
  const agent = pty._agent;
  if (typeof agent !== 'object' || agent === null || !('inSocket' in agent)) {
    return undefined;
  }
  const input = agent.inSocket;
  if (
    typeof input !== 'object' ||
    input === null ||
    !('on' in input) ||
    typeof input.on !== 'function'
  ) {
    return undefined;
  }
  const on = input.on;
  return {
    on: (event, listener): unknown =>
      Reflect.apply(on, input, [event, listener]),
  };
}

const WINDOWS_CMD_BUILTIN_COMMANDS = new Set([
  'assoc',
  'break',
  'call',
  'cd',
  'chdir',
  'cls',
  'color',
  'copy',
  'date',
  'del',
  'dir',
  'echo',
  'endlocal',
  'erase',
  'exit',
  'for',
  'ftype',
  'goto',
  'if',
  'md',
  'mkdir',
  'move',
  'path',
  'pause',
  'popd',
  'prompt',
  'pushd',
  'rd',
  'rem',
  'ren',
  'rename',
  'rmdir',
  'set',
  'setlocal',
  'shift',
  'start',
  'time',
  'title',
  'type',
  'ver',
  'verify',
  'vol',
]);
const WINDOWS_POWERSHELL_BUILTIN_COMMANDS = new Set([
  'cd',
  'clear',
  'cls',
  'copy',
  'del',
  'dir',
  'echo',
  'erase',
  'exit',
  'get-childitem',
  'get-location',
  'ls',
  'move',
  'popd',
  'pushd',
  'pwd',
  'rm',
  'set-location',
  'sleep',
  'start-sleep',
  'type',
]);
const WINDOWS_BASH_BUILTIN_COMMANDS = new Set([
  'alias',
  'bg',
  'cd',
  'echo',
  'eval',
  'exec',
  'exit',
  'export',
  'fg',
  'hash',
  'help',
  'history',
  'jobs',
  'popd',
  'pushd',
  'pwd',
  'read',
  'set',
  'shift',
  'source',
  'test',
  'trap',
  'type',
  'unalias',
  'unset',
]);

class TerminalUnsupportedPlatformError extends Error {
  public readonly code = 'ERR_TERMINAL_UNSUPPORTED_PLATFORM';

  public constructor() {
    super(
      'ERR_TERMINAL_UNSUPPORTED_PLATFORM: Terminal unavailable on this platform',
    );
    this.name = 'TerminalUnsupportedPlatformError';
  }
}

interface TerminalRecord {
  archiveDrain?: Promise<void>;
  session: TerminalSession;
  pty: TerminalPty;
  dataDisposable: { dispose(): void } | null;
  exitDisposable: { dispose(): void } | null;
  resourceHandle?: TerminalResourceHandle;
  forcedExitTimer: NodeJS.Timeout | null;
  seq: number;
  queue: Buffer[];
  queuedBytes: number;
  flushScheduled: boolean;
  replay: TerminalReplayWindow;
  /** Restored: replays start with a marker once older history is gone. */
  replayMarksTruncation: boolean;
  attachmentSource: TerminalAttachmentSource;
  initialCommandSuppression: {
    value: string;
    buffered: Buffer;
    sent: boolean;
    sendTimer: NodeJS.Timeout | null;
  } | null;
  running: boolean;
  /** Last-emitted foreground process name; `null` when the shell is in the foreground. */
  lastProcessName: string | null;
  lastWindowsProcessProbeAt: number;
  lastWindowsDescendantProcessName: string | null;
  windowsProcessProbeInFlight: boolean;
  windowsShellCommandActive: boolean;
  windowsActiveCommandName: string | null;
  windowsPendingInputLine: string;
  windowsPromptTail: string;
  exited: boolean;
  pendingExitSignalOverride: string | null;
  /**
   * Killed by an app shutdown or under a signal that ends no command: no
   * idle reaches listeners before its exit, whatever the exit signal.
   */
  killEndsNoCommand: boolean;
  /** An idle dropped during a release drain; reported if the drain fails. */
  heldIdle: { interruptedByUser: boolean } | null;
  pendingUserInterruptAt: number | null;
  pendingUserInterruptProcessName: string | null;
}

interface CreateTerminalRecordOptions {
  projectId: string;
  worktreeId: string;
  cols: number;
  rows: number;
  terminalId?: string;
  selectedRepoId?: string;
  cwd?: string;
  managedCommand?: ManagedTerminalCommand;
  terminalProfileId?: TerminalShellProfileId;
  initialCommand?: string;
  restoredShell?: ResolvedTerminalShell;
  environmentOverride?: TerminalEnvironment;
}

export interface TerminalEngineOptions extends TerminalAttachmentsOptions {
  createTerminalId?: () => string;
  now?: () => number;
  runningDetector?: RunningDetectorController;
  maxLiveTerminals?: number;
  killExitGraceMs?: number;
}

interface RunningDetectorController {
  syncLifecycle(): void;
}

function getCurrentTime(): number {
  return Date.now();
}

function cloneBytes(buffer: Buffer): Uint8Array {
  return Uint8Array.from(buffer);
}

function attachmentSourceFor(
  terminalId: string,
  window: TerminalReplayWindow,
): TerminalAttachmentSource {
  return { terminalId, window, emitted: window.endOffset, exit: null };
}

function normalizeSignal(signal: number | undefined): string | null {
  if (typeof signal !== 'number' || signal === 0) {
    return null;
  }

  return `${signal}`;
}

/**
 * Whether a persisted shell may be restarted. A terminal whose host process
 * ended under it (CAN-5088) restarts like one the app quit under.
 */
export function isRestorableExitSignal(signal: string | null): boolean {
  return (
    signal === null ||
    signal === '0' ||
    signal === 'app-quit' ||
    signal === 'fatal-exit' ||
    signal === 'pipe-error' ||
    signal === TERMINAL_CONNECTION_LOST_SIGNAL
  );
}

/**
 * Whether an exit was caused by the app or the environment rather than by
 * the shell: it finishes no command, so it gets no idle `runningChanged`.
 */
export function exitEndsNoCommand(signal: string | null): boolean {
  return (
    signal === TERMINAL_WORKTREE_CLEANUP_SIGNAL ||
    signal === TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL ||
    signal === TERMINAL_CONNECTION_LOST_SIGNAL ||
    signal === TERMINAL_SANDBOX_ASLEEP_SIGNAL ||
    signal === 'app-quit' ||
    signal === 'fatal-exit'
  );
}

/** The marker a restored terminal's replay and scrollback end with. */
export function buildRestoreMarker(hasReplay: boolean): Buffer {
  const prefix = hasReplay ? '\r\n' : '';
  return Buffer.from(`${prefix}\x1b[2m${RESTORE_MARKER}\x1b[0m\r\n`, 'utf8');
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value);
}

/** Prepends managed PATH entries, as the engine does for a managed command (CAN-5097 reuses it for daemon placement). */
export function prependPathEntries(
  env: Record<string, string | undefined>,
  entries: string[] | undefined,
): Record<string, string | undefined> {
  if (!entries || entries.length === 0) {
    return env;
  }
  return {
    ...env,
    PATH: [...entries, env.PATH].filter(Boolean).join(path.delimiter),
  };
}

function buildPtySpawnOptions(
  options: {
    cols: number;
    rows: number;
    cwd: string;
    env: TerminalEnvironment;
  },
  platform: PlatformOperatingSystem | null,
): TerminalPtySpawnOptions {
  const baseOptions: TerminalPtySpawnOptions = {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  };

  if (platform !== 'win32') {
    return baseOptions;
  }

  return {
    ...baseOptions,
    useConpty: true,
  };
}

function buildInitialCommandSubmission(
  command: string,
  shellBasename: string,
): string {
  const normalizedShell = shellBasename.toLowerCase().replace(/\.exe$/, '');
  if (normalizedShell === 'cmd') {
    return `${command} & exit`;
  }
  if (normalizedShell === 'powershell' || normalizedShell === 'pwsh') {
    const quotedCommand = command.replace(/'/g, "''");
    return `& ([scriptblock]::Create('${quotedCommand}')); exit`;
  }
  const quotedCommand = command.replace(/'/g, `'"'"'`);
  return `eval -- '${quotedCommand}'; exit`;
}

function normalizeWindowsProcessName(value: string): string {
  return path.win32
    .basename(value.trim())
    .toLowerCase()
    .replace(/\.exe$/, '');
}

function windowsOutputEndsWithPrompt(output: string): boolean {
  const normalized = output.replace(ANSI_ESCAPE_PATTERN, '');
  return /(?:^|\r?\n)\s*(?:PS\s+[^\r\n>]+>|[A-Za-z]:\\[^\r\n>]*>|\\\\[^\r\n>]+>|[^\r\n]*[$#] +)\s*$/.test(
    normalized,
  );
}

function firstCommandToken(commandLine: string): string | null {
  const trimmed = commandLine.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const match = /^(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function stripWindowsExecutableExtension(commandName: string): string {
  return commandName.replace(/\.(?:cmd|bat|com|exe)$/i, '');
}

function windowsCommandFallbackName(
  commandLine: string,
  shellBasename: string,
): string {
  let remainingCommandLine = commandLine.trim();
  let token = firstCommandToken(remainingCommandLine);
  while (token && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
    remainingCommandLine = remainingCommandLine
      .slice(remainingCommandLine.indexOf(token) + token.length)
      .trimStart();
    token = firstCommandToken(remainingCommandLine);
  }
  if (token === null) {
    return 'command';
  }

  const normalizedShell = normalizeWindowsProcessName(shellBasename);
  const basenameToken = path.win32.basename(path.posix.basename(token));
  const commandName = stripWindowsExecutableExtension(basenameToken);
  const normalizedCommand = commandName.toLowerCase();

  if (
    (normalizedShell === 'cmd' &&
      WINDOWS_CMD_BUILTIN_COMMANDS.has(normalizedCommand)) ||
    ((normalizedShell === 'powershell' || normalizedShell === 'pwsh') &&
      WINDOWS_POWERSHELL_BUILTIN_COMMANDS.has(normalizedCommand)) ||
    (normalizedShell === 'bash' &&
      WINDOWS_BASH_BUILTIN_COMMANDS.has(normalizedCommand))
  ) {
    return 'command';
  }

  if (/\.(?:cmd|bat|com|exe)$/i.test(basenameToken)) {
    return basenameToken;
  }
  return `${commandName}.exe`;
}

function buildWindowsForegroundProcessScript(rootPid: number): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$emitted = @{}',
    'function Emit-ProcessName([int]$processId) {',
    '  if ($processId -eq $PID -or $emitted.ContainsKey($processId)) { return }',
    '  $emitted[$processId] = $true',
    '  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"',
    '  if ($process -and $process.Name) { [string]$process.Name }',
    '}',
    'try {',
    '  $kernel32 = \'using System; using System.Runtime.InteropServices; public static class CanopyConsoleProcesses { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList(uint[] processList, uint processCount); }\'',
    '  Add-Type -ErrorAction SilentlyContinue -TypeDefinition $kernel32',
    '  [CanopyConsoleProcesses]::FreeConsole() | Out-Null',
    `  if ([CanopyConsoleProcesses]::AttachConsole(${rootPid})) {`,
    '    $processIds = New-Object uint[] 256',
    '    $count = [CanopyConsoleProcesses]::GetConsoleProcessList($processIds, $processIds.Length)',
    '    [CanopyConsoleProcesses]::FreeConsole() | Out-Null',
    '    for ($index = 0; $index -lt $count -and $index -lt $processIds.Length; $index++) {',
    '      Emit-ProcessName ([int]$processIds[$index])',
    '    }',
    '  }',
    '} catch {',
    '  try { [CanopyConsoleProcesses]::FreeConsole() | Out-Null } catch {}',
    '}',
    '$queue = New-Object "System.Collections.Generic.Queue[int]"',
    `$queue.Enqueue(${rootPid})`,
    '$seen = @{}',
    'while ($queue.Count -gt 0) {',
    '  $parentPid = $queue.Dequeue()',
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentPid" | ForEach-Object {',
    '    $childPid = [int]$_.ProcessId',
    '    if (-not $seen.ContainsKey($childPid)) {',
    '      $seen[$childPid] = $true',
    '      $queue.Enqueue($childPid)',
    '      Emit-ProcessName $childPid',
    '    }',
    '  }',
    '}',
  ].join('; ');
}

function foregroundProcessNameFromWindowsProbeOutput(
  stdout: string,
  shellBasename: string,
): string | null {
  const shellProcessName = normalizeWindowsProcessName(shellBasename);
  const excludedProcessNames = new Set([
    shellProcessName,
    ...WINDOWS_TERMINAL_HOST_PROCESS_NAMES,
  ]);
  const candidates = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const normalized = normalizeWindowsProcessName(candidate);
    if (excludedProcessNames.has(normalized)) {
      continue;
    }
    return candidate;
  }

  return null;
}

function resolveWindowsForegroundProcessName(
  rootPid: number,
  shellBasename: string,
  resolvePowerShell: () => string | null,
  processes: TerminalProcessPort,
): Promise<string | null> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return Promise.resolve(null);
  }

  const powershell = resolvePowerShell() ?? 'powershell.exe';
  const script = buildWindowsForegroundProcessScript(rootPid);

  return processes
    .probe(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      WINDOWS_RUNNING_PROCESS_PROBE_TIMEOUT_MS,
    )
    .then((stdout) =>
      stdout === null
        ? null
        : foregroundProcessNameFromWindowsProbeOutput(stdout, shellBasename),
    );
}

function attachResponseFromPersistedEntry(
  entry: PersistedTerminalEntry,
): TerminalAttachResponse {
  const replayText = entry.scrollbackLines.join('\n');
  const replayBuffer = Buffer.from(replayText, 'utf8');
  return {
    session: entry.session,
    replay: cloneBytes(replayBuffer),
    seq: Buffer.byteLength(replayText, 'utf8'),
  };
}

function tryKillPid(pid: number): boolean {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function forceKillPtyProcessTree(
  pty: TerminalPty,
  platform: PlatformOperatingSystem | null,
  processes: TerminalProcessPort,
): void {
  if (Number.isInteger(pty.pid) && pty.pid > 0) {
    if (platform === 'win32') {
      // The PTY can already be gone after taskkill fails; cleanup is best effort.
      processes.killWindowsTree(pty.pid, () => pty.kill());
      return;
    }

    if (tryKillPid(-pty.pid)) {
      return;
    }
    if (tryKillPid(pty.pid)) {
      return;
    }
  }

  try {
    pty.kill();
  } catch {
    // The PTY can already be gone; cleanup is best effort.
  }
}

function destroyPtyIfAvailable(pty: TerminalPty): void {
  if (!('destroy' in pty)) {
    return;
  }
  const destroy = pty.destroy;
  if (typeof destroy !== 'function') {
    return;
  }
  try {
    destroy.call(pty);
  } catch {
    // Best effort: node-pty may already have torn down its streams.
  }
}

class TerminalCapacityError extends Error {
  public readonly code = 'ERR_TERMINAL_CAPACITY';

  public constructor(limit: number) {
    super(
      `ERR_TERMINAL_CAPACITY: Refusing to spawn more than ${limit} live terminals.`,
    );
    this.name = 'TerminalCapacityError';
  }
}

function isPathInside(parentDir: string, childPath: string): boolean {
  const relative = path.relative(
    path.resolve(parentDir),
    path.resolve(childPath),
  );
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * The terminal engine behind the in-process `worker.terminal` port. It owns
 * live PTYs, their replay and running state; every host fact and effect
 * (PTY spawning, shells, environment, checkouts, accounting, persistence and
 * process control) comes from {@link TerminalEngineHost}.
 */
export class TerminalEngine
  implements WorkerTerminalPort, RunningDetectorStore
{
  private readonly records = new Map<string, TerminalRecord>();

  private readonly createTerminalId: () => string;

  private readonly now: () => number;

  private readonly runningDetector: RunningDetectorController;

  private readonly maxLiveTerminals: number;

  private readonly killExitGraceMs: number;

  private eventSink: WorkerTerminalEventListener = (): void => {};

  private readonly eventListeners = new Set<WorkerTerminalEventListener>();

  private readonly attachments: TerminalAttachments;

  public constructor(
    private readonly host: TerminalEngineHost,
    options: TerminalEngineOptions = {},
  ) {
    this.createTerminalId = options.createTerminalId ?? randomUUID;
    this.now = options.now ?? getCurrentTime;
    this.runningDetector =
      options.runningDetector ??
      new TerminalRunningDetector({
        store: this,
        platform: (): PlatformOperatingSystem | null => host.shells.platform(),
      });
    this.maxLiveTerminals =
      options.maxLiveTerminals ?? DEFAULT_MAX_LIVE_TERMINALS;
    this.killExitGraceMs =
      options.killExitGraceMs ?? TERMINAL_KILL_EXIT_GRACE_MS;
    this.attachments = new TerminalAttachments(options);
  }

  public setEventSink(sink: WorkerTerminalEventListener): void {
    this.eventSink = sink;
  }

  public addEventListener(listener: WorkerTerminalEventListener): () => void {
    this.eventListeners.add(listener);
    let subscribed = true;
    return (): void => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.eventListeners.delete(listener);
    };
  }

  private emitEvent(event: WorkerTerminalEvent): void {
    this.eventSink(event);
    this.eventListeners.forEach((listener) => {
      listener(event);
    });
  }

  private platform(): PlatformOperatingSystem | null {
    return this.host.shells.platform();
  }

  private forceKill(pty: TerminalPty): void {
    forceKillPtyProcessTree(pty, this.platform(), this.host.processes);
  }

  /**
   * Claims a PTY's process tree in execution accounting so a shell and the
   * commands run in it are not counted as processes the host itself runs.
   */
  private registerResource(
    session: TerminalSession,
    pid: number,
  ): TerminalResourceHandle | undefined {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return this.host.resources.register(session, pid);
  }

  private resolveRestoredCwd(
    projectId: string,
    worktreeId: string,
    persistedCwd: string,
  ): string {
    const fallbackCwd = this.host.workspace.worktreeCwd(projectId, worktreeId);
    if (!isAbsolutePath(persistedCwd)) {
      return fallbackCwd;
    }
    if (!isPathInside(fallbackCwd, persistedCwd)) {
      return fallbackCwd;
    }
    if (!existsSync(persistedCwd)) {
      return fallbackCwd;
    }
    return persistedCwd;
  }

  private createRecord(options: CreateTerminalRecordOptions): TerminalRecord {
    const platform = this.platform();
    if (platform === null) {
      throw new TerminalUnsupportedPlatformError();
    }

    const { projectId, worktreeId, cols, rows, terminalId, selectedRepoId } =
      options;
    this.host.workspace.assertStartAllowed(projectId, worktreeId);
    const managedCommand = options.managedCommand;
    const resolvedShell = managedCommand
      ? null
      : (options.restoredShell ??
        this.host.shells.profile(options.terminalProfileId));
    const shell = managedCommand?.executable ?? resolvedShell?.shell ?? '';
    const shellArgs = managedCommand?.args ?? resolvedShell?.args ?? [];
    const shellBasename =
      managedCommand !== undefined
        ? basename(shell)
        : (resolvedShell?.shellBasename ?? basename(shell));
    const cwd =
      options.cwd ??
      this.host.workspace.worktreeCwd(projectId, worktreeId, selectedRepoId);
    const mergedEnv = options.environmentOverride ?? {
      ...this.host.environment.base(),
      ...this.host.environment.worktree(projectId, worktreeId),
    };
    const processEnv = managedCommand
      ? prependPathEntries(
          sanitizeManagedBaseEnv(mergedEnv),
          managedCommand.pathPrepend,
        )
      : mergedEnv;
    const shellEnv =
      managedCommand === undefined &&
      platform === 'darwin' &&
      shellBasename === 'bash'
        ? { BASH_SILENCE_DEPRECATION_WARNING: '1' }
        : {};
    // This is the agent's payload environment. Private-Node hook stubs scrub
    // their own startup variables without removing the agent's CA/tool settings.
    const env = {
      ...processEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // A caller-supplied environment keeps its locale (a daemon's own may
      // differ); in process both are the app's.
      LANG:
        options.environmentOverride?.LANG ??
        this.host.environment.variable('LANG') ??
        DEFAULT_LANG,
      ...shellEnv,
      ...(managedCommand?.env ?? {}),
    };

    let pty: TerminalPty;
    try {
      pty = this.host.pty.spawn(
        shell,
        shellArgs,
        buildPtySpawnOptions({ cols, rows, cwd, env }, platform),
      );
    } catch (error) {
      if (!this.host.shells.linuxLoginShellsSupported() || managedCommand) {
        throw error;
      }
      // Name the shell that failed; never retry another one on the user's behalf.
      const detail = error instanceof Error ? error.message : String(error);
      throw unavailableShellError(`${shell} couldn't start: ${detail}`);
    }

    const session: TerminalSession = {
      id: terminalId ?? this.createTerminalId(),
      projectId,
      worktreeId,
      shell,
      shellBasename,
      cwd,
      createdAt: this.now(),
      ...(options.initialCommand
        ? { initialCommand: options.initialCommand }
        : {}),
      ...(managedCommand
        ? {
            kind: managedCommand.kind,
            focusOnSpawn: managedCommand.focusOnSpawn,
            title: managedCommand.title,
            chatId: managedCommand.chatId,
            sessionKey: managedCommand.sessionKey,
          }
        : {}),
    };

    const initialCommandSubmission = options.initialCommand
      ? buildInitialCommandSubmission(options.initialCommand, shellBasename)
      : null;
    const replay = new TerminalReplayWindow(TERMINAL_REPLAY_BUFFER_MAX_BYTES);
    const record: TerminalRecord = {
      session,
      pty,
      dataDisposable: null,
      exitDisposable: null,
      forcedExitTimer: null,
      seq: 0,
      queue: [],
      queuedBytes: 0,
      flushScheduled: false,
      replay,
      replayMarksTruncation: false,
      attachmentSource: attachmentSourceFor(session.id, replay),
      initialCommandSuppression: initialCommandSubmission
        ? {
            value: initialCommandSubmission,
            buffered: Buffer.alloc(0),
            sent: false,
            sendTimer: null,
          }
        : null,
      running: false,
      lastProcessName: null,
      lastWindowsProcessProbeAt: Number.NEGATIVE_INFINITY,
      lastWindowsDescendantProcessName: null,
      windowsProcessProbeInFlight: false,
      windowsShellCommandActive: false,
      windowsActiveCommandName: null,
      windowsPendingInputLine: '',
      windowsPromptTail: '',
      exited: false,
      pendingExitSignalOverride: null,
      killEndsNoCommand: false,
      heldIdle: null,
      pendingUserInterruptAt: null,
      pendingUserInterruptProcessName: null,
    };

    return record;
  }

  private registerRecord(record: TerminalRecord): TerminalSession {
    const { session, pty } = record;

    if (this.records.size >= this.maxLiveTerminals) {
      this.forceKill(pty);
      destroyPtyIfAvailable(pty);
      throw new TerminalCapacityError(this.maxLiveTerminals);
    }

    this.records.set(session.id, record);

    try {
      record.dataDisposable = pty.onData((data: string): void => {
        this.handlePtyData(session.id, Buffer.from(data, 'utf8'));
      });

      record.exitDisposable = pty.onExit((event): void => {
        this.handlePtyExit(
          session.id,
          event.exitCode,
          normalizeSignal(event.signal),
        );
      });

      // node-pty 1.1.0 exposes onData/onExit for its output socket but leaves
      // the separate Windows input socket without an error listener. Keep this
      // narrowly scoped adapter with the pinned dependency; a public PTY error
      // listener does not receive input-socket EOF/EPIPE events.
      const input = getPtyInputSocket(pty);
      input?.on('error', (error) => {
        if (record.exited || this.records.get(session.id) !== record) return;
        this.host.log.warn('Terminal input pipe failed', {
          terminalId: session.id,
          code: getErrnoDetail(error, 'code'),
          syscall: getErrnoDetail(error, 'syscall'),
        });
        // Finalize first: killing the PTY can synchronously emit onExit.
        this.handlePtyExit(session.id, null, 'pipe-error');
        this.forceKill(pty);
      });

      this.host.persistence.registerLiveSession(session);
      record.resourceHandle = this.registerResource(session, pty.pid);
      if (session.kind === 'script') {
        this.emitEvent({ type: 'spawned', payload: session });
      }
      this.runningDetector.syncLifecycle();
    } catch (error) {
      this.records.delete(session.id);
      record.exited = true;
      this.disposeRecordResources(record, { destroyPty: true });
      this.forceKill(pty);
      throw error;
    }

    return session;
  }

  public create(request: TerminalCreateRequest): TerminalSession {
    const record = this.createRecord({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      cols: request.cols,
      rows: request.rows,
      selectedRepoId: request.repoId,
      managedCommand: request.managedCommand,
      cwd: request.cwd,
      terminalProfileId: request.profileId,
      restoredShell: request.shell,
      initialCommand: request.initialCommand,
      environmentOverride: request.environment,
    });
    const session = this.registerRecord(record);
    if (request.initialCommand) {
      this.scheduleInitialCommand(record, INITIAL_COMMAND_FALLBACK_MS);
    }
    return session;
  }

  /** Lower a live PTY process after spawn when the platform cannot wrap it. */
  public lowerPriority(terminalId: string): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) return;
    this.host.processes.lowerPriority(record.pty.pid);
  }

  public restore(request: TerminalRestoreRequest): TerminalSession {
    const { terminalId, cols, rows } = request;
    const environmentOverride = request.environment;
    const existing = this.records.get(terminalId);
    if (existing && !existing.exited) {
      existing.pty.resize(cols, rows);
      return existing.session;
    }

    const persistedEntry =
      this.host.persistence.getPersistedTerminalEntry(terminalId);
    if (persistedEntry === null) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    const persistedKind = persistedEntry.session.kind ?? 'shell';
    if (
      persistedKind !== 'shell' ||
      !isRestorableExitSignal(persistedEntry.signal)
    ) {
      throw new Error(`Terminal is not restorable: ${terminalId}`);
    }

    const record = this.createRecord({
      projectId: persistedEntry.session.projectId,
      worktreeId: persistedEntry.session.worktreeId,
      cols,
      rows,
      terminalId,
      cwd: this.resolveRestoredCwd(
        persistedEntry.session.projectId,
        persistedEntry.session.worktreeId,
        persistedEntry.session.cwd,
      ),
      restoredShell:
        request.shell ?? this.host.shells.persisted(persistedEntry.session),
      initialCommand: persistedEntry.session.initialCommand,
      environmentOverride,
    });
    const historicalReplay = Buffer.from(
      persistedEntry.scrollbackLines.join('\n'),
      'utf8',
    );
    const restoreMarker = buildRestoreMarker(historicalReplay.length > 0);

    record.replay = new TerminalReplayWindow(
      TERMINAL_RESTORED_REPLAY_MAX_BYTES - TRUNCATION_MARKER_BYTES.length,
      Buffer.concat([historicalReplay, restoreMarker]),
    );
    record.replayMarksTruncation = true;
    record.attachmentSource = attachmentSourceFor(
      record.session.id,
      record.replay,
    );
    record.seq = record.replay.endOffset;

    const session = this.registerRecord(record);
    this.host.persistence.appendTerminalOutput(
      session.projectId,
      session.worktreeId,
      session.id,
      restoreMarker,
    );
    if (persistedEntry.session.initialCommand) {
      this.scheduleInitialCommand(record, INITIAL_COMMAND_FALLBACK_MS);
    }
    return session;
  }

  public replay(terminalId: string): TerminalAttachResponse {
    const record = this.records.get(terminalId);
    if (record) {
      const window = record.replay.snapshot();
      return {
        session: record.session,
        replay: cloneBytes(
          record.replayMarksTruncation && record.replay.startOffset > 0
            ? Buffer.concat([TRUNCATION_MARKER_BYTES, window])
            : window,
        ),
        seq: record.replay.endOffset,
      };
    }

    const persistedEntry =
      this.host.persistence.getPersistedTerminalEntry(terminalId);
    if (persistedEntry !== null) {
      return attachResponseFromPersistedEntry(persistedEntry);
    }

    throw new Error(`Terminal not found: ${terminalId}`);
  }

  public attach(request: TerminalAttachmentRequest): TerminalAttachment {
    const record = this.records.get(request.terminalId);
    if (!record || record.exited) {
      throw new Error(`Terminal not found: ${request.terminalId}`);
    }
    const attachmentId = this.attachments.open(record.attachmentSource, {
      fromOffset: request.fromOffset,
      maxReplayBytes: request.maxReplayBytes,
      sink: request.sink,
    });
    return { attachmentId, session: record.session };
  }

  public acknowledgeAttachment(attachmentId: string, offset: number): void {
    this.attachments.acknowledge(attachmentId, offset);
  }

  public releaseAttachment(attachmentId: string): void {
    this.attachments.release(attachmentId);
  }

  public replayText(terminalId: string): string | null {
    const record = this.records.get(terminalId);
    if (record) {
      return record.replay.text();
    }

    const persistedEntry =
      this.host.persistence.getPersistedTerminalEntry(terminalId);
    if (persistedEntry !== null) {
      return persistedEntry.scrollbackLines.join('\n');
    }

    return null;
  }

  public get(terminalId: string): TerminalSession | null {
    return this.records.get(terminalId)?.session ?? null;
  }

  public write(terminalId: string, data: string): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) {
      return;
    }

    if (record.running && data.includes(CTRL_C)) {
      record.pendingUserInterruptAt = this.now();
      record.pendingUserInterruptProcessName = record.lastProcessName;
    }

    const submittedWindowsCommand =
      this.platform() === 'win32'
        ? this.updateWindowsPendingInputLine(record, data)
        : false;
    if (submittedWindowsCommand) {
      this.markWindowsShellCommandActive(record);
    }

    record.pty.write(data);
  }

  public resize(terminalId: string, cols: number, rows: number): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) {
      return;
    }

    record.pty.resize(cols, rows);
  }

  public kill(
    terminalId: string,
    options: { signal?: string | null } = {},
  ): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) {
      return;
    }

    if (options.signal) {
      record.pendingExitSignalOverride = options.signal;
      record.killEndsNoCommand ||= exitEndsNoCommand(options.signal);
    }
    this.forceKill(record.pty);
    this.scheduleForcedExitCleanup(record);
  }

  private markWindowsShellCommandActive(record: TerminalRecord): void {
    record.windowsShellCommandActive = true;
    record.windowsActiveCommandName =
      windowsCommandFallbackName(
        record.windowsPendingInputLine,
        record.session.shellBasename,
      ) || 'command';
    record.windowsPendingInputLine = '';
    record.windowsPromptTail = '';
  }

  private updateWindowsPendingInputLine(
    record: TerminalRecord,
    data: string,
  ): boolean {
    let submitted = false;
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index];
      if (char === '\x1b') {
        const next = data[index + 1];
        if (next === '[') {
          index += 2;
          while (index < data.length && !/[@-~]/.test(data[index] ?? '')) {
            index += 1;
          }
          continue;
        }
        if (next === ']') {
          index += 2;
          while (
            index < data.length &&
            data[index] !== '\x07' &&
            !(data[index] === '\x1b' && data[index + 1] === '\\')
          ) {
            index += 1;
          }
          if (data[index] === '\x1b') {
            index += 1;
          }
          continue;
        }
        if (next !== undefined) {
          index += 1;
        }
        continue;
      }
      if (char === CTRL_C) {
        record.windowsPendingInputLine = '';
        record.windowsShellCommandActive = false;
        record.windowsActiveCommandName = null;
        record.windowsPromptTail = '';
        continue;
      }
      if (char === '\b' || char === '\x7f') {
        record.windowsPendingInputLine = record.windowsPendingInputLine.slice(
          0,
          -1,
        );
        continue;
      }
      if (char === '\r' || char === '\n') {
        submitted ||= record.windowsPendingInputLine.trim().length > 0;
        continue;
      }
      if (char >= ' ') {
        record.windowsPendingInputLine += char;
      }
    }
    return submitted;
  }

  private getWindowsShellCommandProcessName(
    record: TerminalRecord,
  ): string | null {
    return record.windowsShellCommandActive
      ? (record.windowsActiveCommandName ?? 'command')
      : null;
  }

  private scheduleWindowsProcessProbe(record: TerminalRecord): void {
    if (record.windowsProcessProbeInFlight) {
      return;
    }

    record.windowsProcessProbeInFlight = true;
    record.lastWindowsProcessProbeAt = this.now();
    void resolveWindowsForegroundProcessName(
      record.pty.pid,
      record.session.shellBasename,
      () => this.host.shells.windowsPowerShell(),
      this.host.processes,
    ).then(
      (processName) => {
        const currentRecord = this.records.get(record.session.id);
        if (currentRecord !== record || record.exited) {
          return;
        }

        record.lastWindowsDescendantProcessName = processName;
        record.windowsProcessProbeInFlight = false;
        this.updateRunningStateFromEffectiveProcessName(
          record,
          processName ?? this.getWindowsShellCommandProcessName(record),
        );
      },
      () => {
        const currentRecord = this.records.get(record.session.id);
        if (currentRecord !== record || record.exited) {
          return;
        }

        record.lastWindowsDescendantProcessName = null;
        record.windowsProcessProbeInFlight = false;
        this.updateRunningStateFromEffectiveProcessName(
          record,
          this.getWindowsShellCommandProcessName(record),
        );
      },
    );
  }

  private updateRunningStateFromEffectiveProcessName(
    record: TerminalRecord,
    effectiveProcessName: string | null | undefined,
  ): void {
    const running = computeTerminalRunningState(
      {
        shellBasename: record.session.shellBasename,
        processName: effectiveProcessName,
      },
      { platform: this.platform() },
    );
    const processName =
      running && typeof effectiveProcessName === 'string'
        ? effectiveProcessName
        : null;
    this.setTerminalStatus(record.session.id, running, processName);
  }

  private getEffectiveProcessName(
    record: TerminalRecord,
  ): string | null | undefined {
    const processName = record.pty.process;
    if (
      this.platform() !== 'win32' ||
      !isTerminalTypeProcessName(processName)
    ) {
      return processName;
    }

    const now = this.now();
    if (
      now - record.lastWindowsProcessProbeAt >=
        WINDOWS_RUNNING_PROCESS_PROBE_INTERVAL_MS &&
      !record.windowsProcessProbeInFlight
    ) {
      this.scheduleWindowsProcessProbe(record);
    }

    return (
      record.lastWindowsDescendantProcessName ??
      this.getWindowsShellCommandProcessName(record)
    );
  }

  public list(): TerminalSession[] {
    const sessions = Array.from(this.records.values())
      .map((record) => record.session)
      .sort((left, right) => left.createdAt - right.createdAt);

    const updates = sessions.map((session) => {
      const record = this.records.get(session.id);
      if (!record) {
        return null;
      }

      const effectiveProcessName = this.getEffectiveProcessName(record);
      const running = computeTerminalRunningState(
        {
          shellBasename: record.session.shellBasename,
          processName: effectiveProcessName,
        },
        { platform: this.platform() },
      );
      const processName =
        running && typeof effectiveProcessName === 'string'
          ? effectiveProcessName
          : null;
      record.running = running;
      record.lastProcessName = processName;
      return { terminalId: session.id, running, processName };
    });

    queueMicrotask((): void => {
      for (const update of updates) {
        if (!update) continue;
        const record = this.records.get(update.terminalId);
        if (!record) {
          continue;
        }

        this.emitRunningChanged(record);
      }
    });

    const updatesByTerminalId = new Map(
      updates.flatMap((update) =>
        update === null ? [] : [[update.terminalId, update] as const],
      ),
    );
    return sessions.map((session) => {
      const update = updatesByTerminalId.get(session.id);
      return {
        ...session,
        running: update?.running ?? false,
        processName: update?.processName ?? null,
      };
    });
  }

  public killWorktree({ projectId, worktreeId }: TerminalWorktreeScope): void {
    for (const record of Array.from(this.records.values())) {
      if (
        record.session.projectId === projectId &&
        record.session.worktreeId === worktreeId
      ) {
        record.pendingExitSignalOverride = TERMINAL_WORKTREE_CLEANUP_SIGNAL;
        record.killEndsNoCommand = true;
        this.forceKill(record.pty);
        this.scheduleForcedExitCleanup(record);
      }
    }
  }

  public async release(terminalId: string): Promise<void> {
    const record = this.records.get(terminalId);
    if (!record) return;
    if (!record.archiveDrain) {
      record.pendingExitSignalOverride = TERMINAL_WORKTREE_CLEANUP_SIGNAL;
      const ownedPid = record.pty.pid;
      record.archiveDrain = this.host.processes
        .drainOwned(
          ownedPid,
          () =>
            this.records.get(terminalId) === record &&
            !record.exited &&
            record.pty.pid === ownedPid,
        )
        .then(() => {
          this.handlePtyExit(
            terminalId,
            null,
            TERMINAL_WORKTREE_CLEANUP_SIGNAL,
          );
        })
        .catch((error: unknown) => {
          record.archiveDrain = undefined;
          const held = record.heldIdle;
          if (held && !record.exited)
            this.emitRunningChanged(record, held.interruptedByUser);
          throw error;
        });
    }
    await record.archiveDrain;
  }

  public async releaseWorktree({
    projectId,
    worktreeId,
  }: TerminalWorktreeScope): Promise<void> {
    const terminals = Array.from(this.records.values()).filter(
      (record) =>
        record.session.projectId === projectId &&
        record.session.worktreeId === worktreeId,
    );
    const results = await Promise.allSettled(
      terminals.map((record) => this.release(record.session.id)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  public hasLiveTerminals({
    projectId,
    worktreeId,
  }: TerminalWorktreeScope): boolean {
    return Array.from(this.records.values()).some(
      (record) =>
        !record.exited &&
        record.session.projectId === projectId &&
        record.session.worktreeId === worktreeId,
    );
  }

  public killAll(options?: TerminalKillAllOptions): void {
    for (const record of Array.from(this.records.values())) {
      if (options) record.killEndsNoCommand = true;
      this.forceKill(record.pty);
      this.scheduleForcedExitCleanup(record);
    }
  }

  public getLiveTerminalCount(): number {
    return this.records.size;
  }

  public runningWorktrees(): TerminalWorktreeScope[] {
    return Array.from(this.records.values())
      .filter((record) => !record.exited && record.running)
      .map((record) => ({
        projectId: record.session.projectId,
        worktreeId: record.session.worktreeId,
      }));
  }

  public profiles(): TerminalShellProfile[] {
    return this.host.shells.listProfiles();
  }

  public defaultShellBasename(): string {
    return this.host.shells.defaultShellBasename();
  }

  public prewarmShell(): Promise<void> {
    return this.host.shells.prewarm();
  }

  public getTerminalSnapshots(): Iterable<RunningDetectorTerminalSnapshot> {
    return Array.from(this.records.values(), (record) => ({
      id: record.session.id,
      shellBasename: record.session.shellBasename,
      processName: this.getEffectiveProcessName(record),
      running: record.running,
      lastProcessName: record.lastProcessName,
    }));
  }

  public setTerminalStatus(
    id: string,
    running: boolean,
    processName: string | null,
  ): void {
    const record = this.records.get(id);
    if (!record || record.exited) {
      return;
    }
    if (record.running === running && record.lastProcessName === processName) {
      return;
    }

    let interruptedByUser = false;
    if (running) {
      if (
        record.pendingUserInterruptAt !== null &&
        processName !== record.pendingUserInterruptProcessName
      ) {
        this.clearPendingUserInterrupt(record);
      }
    } else {
      interruptedByUser = this.consumePendingUserInterrupt(
        record,
        record.lastProcessName,
      );
    }

    record.running = running;
    record.lastProcessName = processName;
    this.emitRunningChanged(record, interruptedByUser);
  }

  private handlePtyData(terminalId: string, chunk: Buffer): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) {
      return;
    }

    const visibleChunk = this.filterInitialCommandOutput(record, chunk);
    if (visibleChunk === null || visibleChunk.length === 0) {
      return;
    }
    chunk = visibleChunk;

    if (
      this.platform() === 'win32' &&
      isTerminalTypeProcessName(record.pty.process) &&
      record.windowsShellCommandActive
    ) {
      record.windowsPromptTail = `${record.windowsPromptTail}${chunk.toString(
        'utf8',
      )}`.slice(-512);
      if (windowsOutputEndsWithPrompt(record.windowsPromptTail)) {
        record.windowsShellCommandActive = false;
        record.windowsActiveCommandName = null;
        record.windowsPromptTail = '';
      }
    }

    if (record.queuedBytes + chunk.length > TERMINAL_MAX_UNFLUSHED_BYTES) {
      if (record.queuedBytes > 0) {
        this.flushQueuedOutput(terminalId);
      }

      const truncationChunk = Buffer.from(TRUNCATION_MARKER, 'utf8');
      record.replay.append(truncationChunk);
      this.host.persistence.appendTerminalOutput(
        record.session.projectId,
        record.session.worktreeId,
        record.session.id,
        truncationChunk,
      );
      record.queue = [truncationChunk];
      record.queuedBytes = record.queue[0].length;
      this.flushQueuedOutput(terminalId);
      return;
    }

    record.replay.append(chunk);
    this.host.persistence.appendTerminalOutput(
      record.session.projectId,
      record.session.worktreeId,
      record.session.id,
      chunk,
    );
    record.queue.push(chunk);
    record.queuedBytes += chunk.length;

    if (record.queuedBytes >= TERMINAL_FLUSH_THRESHOLD_BYTES) {
      this.flushQueuedOutput(terminalId);
      return;
    }

    if (record.flushScheduled) {
      return;
    }

    record.flushScheduled = true;
    queueMicrotask((): void => {
      const queuedRecord = this.records.get(terminalId);
      if (!queuedRecord) {
        return;
      }

      queuedRecord.flushScheduled = false;
      this.flushQueuedOutput(terminalId);
    });
  }

  private filterInitialCommandOutput(
    record: TerminalRecord,
    chunk: Buffer,
  ): Buffer | null {
    const suppression = record.initialCommandSuppression;
    if (suppression === null) {
      return chunk;
    }
    if (!suppression.sent) {
      this.scheduleInitialCommand(record, INITIAL_COMMAND_READY_DEBOUNCE_MS);
      return null;
    }

    const buffered =
      suppression.buffered.length === 0
        ? chunk
        : Buffer.concat(
            [suppression.buffered, chunk],
            suppression.buffered.length + chunk.length,
          );
    const rawLineFeedIndex = buffered.indexOf(0x0a);
    if (rawLineFeedIndex >= 0) {
      record.initialCommandSuppression = null;
      return buffered.subarray(rawLineFeedIndex + 1);
    }

    if (buffered.length > INITIAL_COMMAND_SUPPRESSION_MAX_BYTES) {
      record.initialCommandSuppression = null;
      return buffered;
    }

    suppression.buffered = buffered;
    return null;
  }

  private scheduleInitialCommand(
    record: TerminalRecord,
    delayMs: number,
  ): void {
    const suppression = record.initialCommandSuppression;
    if (suppression === null || suppression.sent || record.exited) return;
    if (suppression.sendTimer !== null) {
      clearTimeout(suppression.sendTimer);
    }
    const timer = setTimeout((): void => {
      suppression.sendTimer = null;
      if (
        this.records.get(record.session.id) !== record ||
        record.exited ||
        record.initialCommandSuppression !== suppression
      ) {
        return;
      }
      suppression.sent = true;
      suppression.buffered = Buffer.alloc(0);
      this.write(record.session.id, `${suppression.value}\r`);
    }, delayMs);
    timer.unref?.();
    suppression.sendTimer = timer;
  }

  private flushQueuedOutput(terminalId: string): void {
    const record = this.records.get(terminalId);
    if (!record || record.queue.length === 0) {
      return;
    }

    record.flushScheduled = false;
    const payload = Buffer.concat(record.queue);
    record.queue = [];
    record.queuedBytes = 0;
    record.seq += payload.length;

    const event: TerminalOutputEvent = {
      projectId: record.session.projectId,
      worktreeId: record.session.worktreeId,
      terminalId: record.session.id,
      data: cloneBytes(payload),
      seq: record.seq,
    };
    this.emitEvent({ type: 'output', payload: event });
    record.attachmentSource.emitted = record.seq;
    this.attachments.publish(record.attachmentSource, payload);
  }

  private handlePtyExit(
    terminalId: string,
    exitCode: number | null,
    signal: string | null,
  ): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) {
      return;
    }

    record.exited = true;
    this.disposeRecordResources(record, { destroyPty: true });
    this.flushQueuedOutput(terminalId);
    const resolvedSignal = record.pendingExitSignalOverride ?? signal;
    // `signal`, not the override: an override can outlive a failed release.
    const shouldEmitRunningChanged = !exitEndsNoCommand(signal);

    if (record.running || record.lastProcessName !== null) {
      const interruptedByUser = this.consumePendingUserInterrupt(
        record,
        record.lastProcessName,
      );
      record.running = false;
      record.lastProcessName = null;
      if (shouldEmitRunningChanged) {
        this.emitRunningChanged(record, interruptedByUser);
      }
    }

    const event: TerminalExitEvent = {
      projectId: record.session.projectId,
      worktreeId: record.session.worktreeId,
      terminalId: record.session.id,
      kind: record.session.kind ?? 'shell',
      exitCode,
      signal: resolvedSignal,
    };
    this.emitEvent({ type: 'exit', payload: event });
    record.attachmentSource.exit = event;
    this.attachments.publish(record.attachmentSource);
    this.host.persistence.markTerminalExited(
      record.session.projectId,
      record.session.worktreeId,
      record.session.id,
      exitCode,
      resolvedSignal,
    );

    this.records.delete(terminalId);
    this.runningDetector.syncLifecycle();
  }

  private scheduleForcedExitCleanup(record: TerminalRecord): void {
    if (record.forcedExitTimer !== null || record.exited) {
      return;
    }

    const timer = setTimeout((): void => {
      record.forcedExitTimer = null;
      if (this.records.get(record.session.id) !== record || record.exited) {
        return;
      }

      this.handlePtyExit(
        record.session.id,
        null,
        record.pendingExitSignalOverride ?? 'forced-cleanup',
      );
    }, this.killExitGraceMs);
    timer.unref?.();
    record.forcedExitTimer = timer;
  }

  private disposeRecordResources(
    record: TerminalRecord,
    options: { destroyPty: boolean },
  ): void {
    if (record.forcedExitTimer !== null) {
      clearTimeout(record.forcedExitTimer);
      record.forcedExitTimer = null;
    }
    const initialCommandSuppression = record.initialCommandSuppression;
    if (initialCommandSuppression?.sendTimer) {
      clearTimeout(initialCommandSuppression.sendTimer);
      initialCommandSuppression.sendTimer = null;
    }

    try {
      record.dataDisposable?.dispose();
    } catch {
      // best effort
    }
    record.dataDisposable = null;

    try {
      record.exitDisposable?.dispose();
    } catch {
      // best effort
    }
    record.exitDisposable = null;
    record.resourceHandle?.unregister();
    record.resourceHandle = undefined;

    if (options.destroyPty) {
      destroyPtyIfAvailable(record.pty);
    }
  }

  private emitRunningChanged(
    record: TerminalRecord,
    interruptedByUser = false,
  ): void {
    // The running detector can poll between such a kill and its exit; an
    // in-flight release drain ends no command either.
    if (
      !record.running &&
      (record.killEndsNoCommand || record.archiveDrain !== undefined)
    ) {
      record.heldIdle = { interruptedByUser };
      return;
    }
    record.heldIdle = null;
    const event: TerminalRunningChangedEvent = {
      projectId: record.session.projectId,
      worktreeId: record.session.worktreeId,
      terminalId: record.session.id,
      kind: record.session.kind ?? 'shell',
      running: record.running,
      processName: record.lastProcessName,
    };
    if (interruptedByUser) {
      event.interruptedByUser = true;
    }
    this.emitEvent({ type: 'runningChanged', payload: event });
  }

  private consumePendingUserInterrupt(
    record: TerminalRecord,
    processName: string | null,
  ): boolean {
    if (
      record.pendingUserInterruptAt === null ||
      processName === null ||
      processName !== record.pendingUserInterruptProcessName
    ) {
      return false;
    }

    const elapsedMs = this.now() - record.pendingUserInterruptAt;
    this.clearPendingUserInterrupt(record);
    return elapsedMs <= TERMINAL_USER_INTERRUPT_SUPPRESS_MS;
  }

  private clearPendingUserInterrupt(record: TerminalRecord): void {
    record.pendingUserInterruptAt = null;
    record.pendingUserInterruptProcessName = null;
  }
}
