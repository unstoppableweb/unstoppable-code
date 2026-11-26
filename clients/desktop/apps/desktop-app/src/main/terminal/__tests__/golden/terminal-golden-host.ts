// Host stand-ins for the terminal behavior golden (CAN-5063). Everything the
// terminal engine reaches outside itself is recorded here, in call order:
// node-pty, `process.kill`, `taskkill`, the resource monitor, the persistence
// port and main-process warnings. Pure lookups (worktree cwd, environment,
// persisted entries, executable paths) answer from the scenario's tables and
// are not recorded; their effect is visible in what the engine spawns.
//
// The module holds one mutable host so the test file's `jest.mock` factories,
// which run before any scenario, can reach the scenario that is running.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  IDisposable,
  IPty,
  IPtyForkOptions,
  IWindowsPtyForkOptions,
} from 'node-pty';
import type {
  PersistedTerminalEntry,
  TerminalSession,
} from '@canopy/desktop-shared/types';

export type GoldenValue =
  | null
  | boolean
  | number
  | string
  | GoldenValue[]
  | { [key: string]: GoldenValue };

export type GoldenEntry = { [key: string]: GoldenValue };

/** Longer bytes are recorded by length and digest, with a head and tail. */
const INLINE_BYTES_LIMIT = 512;
const BYTES_PREVIEW_CHARS = 48;

type VirtualFileKind = 'exec' | 'plain' | 'dir';

interface ExecFileReply {
  error: { code: string | number; message: string } | null;
  stdout: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeBytes(bytes: Uint8Array): GoldenValue {
  const text = Buffer.from(bytes).toString('utf8');
  if (bytes.length <= INLINE_BYTES_LIMIT) return { text };
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    head: text.slice(0, BYTES_PREVIEW_CHARS),
    tail: text.slice(-BYTES_PREVIEW_CHARS),
  };
}

function errorCode(error: Error): GoldenValue {
  if (!('code' in error)) return null;
  const code = error.code;
  return typeof code === 'string' || typeof code === 'number' ? code : null;
}

export class GoldenHost {
  public entries: GoldenEntry[] = [];

  /** The engine the terminal service's `workerTerminal` port resolves to. */
  public engine: object | null = null;

  /** Absolute paths replaced by stable tokens, longest first. */
  private pathTokens: Array<[string, string]> = [];

  private nextPid = 4101;

  public readonly ptys: GoldenPty[] = [];

  /** Live process ids; a process group shares its leader's id. */
  public readonly liveProcesses = new Set<number>();

  /** Leaders whose group cannot be signalled (no process group). */
  public readonly ungroupedProcesses = new Set<number>();

  /** Signals that `process.kill` reports as refused for a target. */
  public readonly refusedKillTargets = new Map<number, 'EPERM' | 'ESRCH'>();

  public virtualFiles: Record<string, VirtualFileKind> = {};

  public executablesOnPath: Record<string, string> = {};

  public windowsGitBash: string | null = null;

  public bundledClaudePath = '/opt/canopy/bin/claude';

  public enhancedEnv: Record<string, string> = {};

  public worktreeEnv: Record<string, string> = {};

  public worktreeRoot = '/';

  public repoCheckouts: Record<string, string> = {};

  public persistedEntries = new Map<string, PersistedTerminalEntry>();

  public linuxAccountShell: string | undefined = undefined;

  public taskkillExitCode = 0;

  public execFileReply: ExecFileReply = { error: null, stdout: '' };

  /** node-pty `spawn` throws this message instead of returning a PTY. */
  public ptySpawnFailure: string | null = null;

  /** Foreground process node-pty reports; defaults to the spawned file. */
  public ptyProcessName: string | null = null;

  public attachWindowsInputSocket = false;

  public reset(): void {
    this.entries = [];
    this.pathTokens = [];
    this.nextPid = 4101;
    this.ptys.length = 0;
    this.liveProcesses.clear();
    this.ungroupedProcesses.clear();
    this.refusedKillTargets.clear();
    this.virtualFiles = {};
    this.executablesOnPath = {};
    this.windowsGitBash = null;
    this.bundledClaudePath = '/opt/canopy/bin/claude';
    this.enhancedEnv = {};
    this.worktreeEnv = {};
    this.worktreeRoot = '/';
    this.repoCheckouts = {};
    this.persistedEntries = new Map();
    this.linuxAccountShell = undefined;
    this.taskkillExitCode = 0;
    this.execFileReply = { error: null, stdout: '' };
    this.ptySpawnFailure = null;
    this.ptyProcessName = null;
    this.attachWindowsInputSocket = false;
  }

  public tokenizePath(value: string, token: string): void {
    this.pathTokens.push([value, token]);
    this.pathTokens.sort((left, right) => right[0].length - left[0].length);
  }

  public record(entry: { [key: string]: unknown }): void {
    const normalized = this.normalize(entry);
    if (isRecord(normalized) && !Array.isArray(normalized)) {
      this.entries.push(normalized);
    }
  }

  /** JSON-safe, host-independent form of a value crossing the boundary. */
  public normalize(value: unknown): GoldenValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return this.normalizeString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Uint8Array) return describeBytes(value);
    if (value instanceof Error) {
      return {
        error: value.name,
        code: errorCode(value),
        message: this.normalizeString(value.message),
      };
    }
    if (Array.isArray(value)) return value.map((item) => this.normalize(item));
    if (isRecord(value)) {
      const result: { [key: string]: GoldenValue } = {};
      for (const key of Object.keys(value).sort()) {
        const item = value[key];
        if (item === undefined || typeof item === 'function') continue;
        result[key] = this.normalize(item);
      }
      return result;
    }
    return typeof value === 'bigint' ? value.toString() : null;
  }

  private normalizeString(value: string): string {
    let result = value;
    for (const [path, token] of this.pathTokens) {
      result = result.split(path).join(token);
    }
    return result;
  }

  public allocatePid(): number {
    const pid = this.nextPid;
    this.nextPid += 1;
    this.liveProcesses.add(pid);
    return pid;
  }

  public pty(index: number): GoldenPty {
    const pty = this.ptys[index];
    if (!pty) throw new Error(`No PTY ${index} was spawned`);
    return pty;
  }

  /** node-pty `spawn`. */
  public spawnPty(
    file: string,
    args: string[] | string,
    options: IPtyForkOptions | IWindowsPtyForkOptions,
  ): IPty {
    this.record({ at: 'pty.spawn', file, args, options });
    if (this.ptySpawnFailure !== null) {
      throw new Error(this.ptySpawnFailure);
    }
    const pty = new GoldenPty(this, this.allocatePid(), {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      processName: this.ptyProcessName ?? file.split(/[\\/]/).pop() ?? file,
      withInputSocket: this.attachWindowsInputSocket,
    });
    this.ptys.push(pty);
    return pty;
  }

  /** `process.kill`; models POSIX process groups by their leader's id. */
  public killProcess(
    target: number,
    signal: string | number | undefined,
  ): true {
    const signalName = signal ?? 'SIGTERM';
    this.record({ at: 'process.kill', target, signal: signalName });
    const refused = this.refusedKillTargets.get(target);
    if (refused) throw this.errno(refused, target);
    const leader = Math.abs(target);
    const reachable =
      this.liveProcesses.has(leader) &&
      (target > 0 || !this.ungroupedProcesses.has(leader));
    if (!reachable) throw this.errno('ESRCH', target);
    if (signalName !== 0) this.liveProcesses.delete(leader);
    return true;
  }

  private errno(code: string, target: number): Error {
    return Object.assign(new Error(`kill ${code} ${target}`), { code });
  }

  /** `child_process.spawn`, used for `taskkill`. */
  public spawnChild(
    file: string,
    args: readonly string[],
    options: unknown,
  ): EventEmitter {
    this.record({ at: 'child_process.spawn', file, args, options });
    const child = new EventEmitter();
    const code = this.taskkillExitCode;
    setImmediate(() => {
      if (code === 0) this.endTaskkillTree(file, args);
      this.record({ at: 'child_process.exit', file, code });
      child.emit('exit', code);
    });
    return child;
  }

  /** `child_process.execFile`, used for `taskkill` drains. */
  public execFile(
    file: string,
    args: readonly string[],
    options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): EventEmitter {
    this.record({ at: 'child_process.execFile', file, args, options });
    const reply = this.execFileReply;
    setImmediate(() => {
      if (reply.error === null) this.endTaskkillTree(file, args);
      const error = reply.error
        ? Object.assign(new Error(reply.error.message), {
            code: reply.error.code,
          })
        : null;
      callback(error, reply.stdout, '');
    });
    return new EventEmitter();
  }

  /** A successful `taskkill /pid N /t` ends that process tree. */
  private endTaskkillTree(file: string, args: readonly string[]): void {
    if (file !== 'taskkill') return;
    const pidIndex = args.indexOf('/pid');
    const pid = Number(args[pidIndex + 1]);
    if (pidIndex >= 0 && Number.isInteger(pid)) this.liveProcesses.delete(pid);
  }

  public registerResource(input: { id: string }): {
    update: (patch: unknown) => void;
    unregister: () => void;
  } {
    this.record({ at: 'resource.register', input });
    return {
      update: (patch: unknown): void => {
        this.record({ at: 'resource.update', id: input.id, patch });
      },
      unregister: (): void => {
        this.record({ at: 'resource.unregister', id: input.id });
      },
    };
  }

  public persistence = {
    registerLiveSession: (session: TerminalSession): void => {
      this.record({ at: 'persistence.registerLiveSession', session });
    },
    appendTerminalOutput: (
      projectId: string,
      worktreeId: string,
      terminalId: string,
      chunk: Buffer,
    ): void => {
      this.record({
        at: 'persistence.appendTerminalOutput',
        projectId,
        worktreeId,
        terminalId,
        chunk,
      });
    },
    markTerminalExited: (
      projectId: string,
      worktreeId: string,
      terminalId: string,
      exitCode: number | null,
      signal: string | null,
    ): void => {
      this.record({
        at: 'persistence.markTerminalExited',
        projectId,
        worktreeId,
        terminalId,
        exitCode,
        signal,
      });
    },
    getPersistedTerminalEntry: (
      terminalId: string,
    ): PersistedTerminalEntry | null =>
      this.persistedEntries.get(terminalId) ?? null,
    // CAN-7051: main seeds a restore's history from the record first; the
    // fake already holds every persisted entry.
    prefetchPersistedEntry: (): Promise<() => void> =>
      Promise.resolve(() => undefined),
    getTerminalMetadata: (
      terminalId: string,
    ): Omit<PersistedTerminalEntry, 'scrollbackLines'> | null =>
      this.persistedEntries.get(terminalId) ?? null,
  };

  public resolveWorktreeCwd(
    _projectId: string,
    _worktreeId: string,
    selectedRepoId?: string,
  ): string {
    if (selectedRepoId !== undefined) {
      const checkout = this.repoCheckouts[selectedRepoId];
      if (checkout !== undefined) return checkout;
    }
    return this.worktreeRoot;
  }

  public lookupVirtualFile(file: unknown): VirtualFileKind | null | undefined {
    if (typeof file !== 'string' || !isVirtualPath(file)) return undefined;
    return this.virtualFiles[file] ?? null;
  }
}

/** System locations the scenarios own; everything else is the real disk. */
function isVirtualPath(file: string): boolean {
  return (
    file.startsWith('/bin/') ||
    file.startsWith('/usr/') ||
    file.startsWith('/opt/') ||
    file.startsWith('/sbin/') ||
    /^[A-Za-z]:\\/.test(file)
  );
}

interface GoldenPtyOptions {
  cols: number;
  rows: number;
  processName: string;
  withInputSocket: boolean;
}

class GoldenPty implements IPty {
  public readonly pid: number;

  public cols: number;

  public rows: number;

  public process: string;

  public handleFlowControl = false;

  /** node-pty's Windows input socket, present only when a scenario asks. */
  public readonly _agent?: { inSocket: EventEmitter };

  private dataListener: ((data: string) => void) | null = null;

  private exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | null = null;

  public constructor(
    private readonly host: GoldenHost,
    pid: number,
    options: GoldenPtyOptions,
  ) {
    this.pid = pid;
    this.cols = options.cols;
    this.rows = options.rows;
    this.process = options.processName;
    if (options.withInputSocket) {
      this._agent = { inSocket: new EventEmitter() };
    }
  }

  public readonly onData = (listener: (data: string) => void): IDisposable => {
    this.dataListener = listener;
    return {
      dispose: (): void => {
        this.host.record({ at: 'pty.onData.dispose', pid: this.pid });
        this.dataListener = null;
      },
    };
  };

  public readonly onExit = (
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): IDisposable => {
    this.exitListener = listener;
    return {
      dispose: (): void => {
        this.host.record({ at: 'pty.onExit.dispose', pid: this.pid });
        this.exitListener = null;
      },
    };
  };

  public resize(cols: number, rows: number): void {
    this.host.record({ at: 'pty.resize', pid: this.pid, cols, rows });
    this.cols = cols;
    this.rows = rows;
  }

  public clear(): void {
    this.host.record({ at: 'pty.clear', pid: this.pid });
  }

  public write(data: string | Buffer): void {
    this.host.record({
      at: 'pty.write',
      pid: this.pid,
      data: typeof data === 'string' ? data : data.toString('utf8'),
    });
  }

  public kill(signal?: string): void {
    this.host.record({ at: 'pty.kill', pid: this.pid, signal: signal ?? null });
  }

  public destroy(): void {
    this.host.record({ at: 'pty.destroy', pid: this.pid });
  }

  public pause(): void {
    this.host.record({ at: 'pty.pause', pid: this.pid });
  }

  public resume(): void {
    this.host.record({ at: 'pty.resume', pid: this.pid });
  }

  /** The child wrote to the terminal. */
  public output(data: string): void {
    this.dataListener?.(data);
  }

  /** The child exited; node-pty reports signal 0 for a clean exit. */
  public exit(exitCode: number, signal?: number): void {
    this.host.liveProcesses.delete(this.pid);
    this.exitListener?.({
      exitCode,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** The Windows input socket failed (EOF/EPIPE). */
  public failInput(code: string, syscall: string): void {
    const socket = this._agent?.inSocket;
    if (!socket) throw new Error('This PTY has no input socket');
    socket.emit(
      'error',
      Object.assign(new Error(`${syscall} ${code}`), { code, syscall }),
    );
  }
}

export const goldenHost = new GoldenHost();
