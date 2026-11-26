import type {
  ManagedTerminalCommand,
  PersistedTerminalEntry,
  TerminalAttachResponse,
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalRunningChangedEvent,
  TerminalSession,
  TerminalShellProfile,
  TerminalShellProfileId,
} from '@canopy/protocol/terminal';
import type { PlatformOperatingSystem } from '../../platform/platform-services';
import type { ResolvedTerminalShell, TerminalShells } from './shells';

/** Environment variables as the host passes them to a PTY. */
export type TerminalEnvironment = Record<string, string | undefined>;

/** The worktree a terminal belongs to. */
export interface TerminalWorktreeScope {
  projectId: string;
  worktreeId: string;
}

export interface TerminalDisposable {
  dispose(): void;
}

/** One live pseudo-terminal, as the host's PTY library exposes it. */
export interface TerminalPty {
  readonly pid: number;
  /** The foreground process name the PTY reports. */
  readonly process: string;
  onData(listener: (data: string) => void): TerminalDisposable;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): TerminalDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface TerminalPtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: TerminalEnvironment;
  /** Windows: use ConPTY rather than winpty. */
  useConpty?: boolean;
}

/** `supervision.pty`: start a shell or managed command in a new PTY. */
export interface TerminalPtyPort {
  spawn(
    file: string,
    args: string[],
    options: TerminalPtySpawnOptions,
  ): TerminalPty;
}

/**
 * `supervision.terminalShell`: the host facts shell selection reads. Each
 * one is read when a terminal is created, never cached by the engine.
 */
export interface TerminalShellHostPort {
  /** The host OS; null when terminals are not supported on it. */
  platform(): PlatformOperatingSystem | null;
  /** Linux x64 hosts launch login shells resolved from the account. */
  linuxLoginShellsSupported(): boolean;
  /** The account's login shell (`getent passwd`), when it can be read. */
  accountShell(): Promise<string | undefined>;
  findOnPath(name: string): string | null;
  windowsGitBash(): string | null;
  /** A variable of the host process environment (`SHELL`, `ComSpec`). */
  variable(name: string): string | undefined;
}

/** The environment a terminal starts with, before its own additions. */
export interface TerminalEnvironmentPort {
  /** The host's base environment for user shells. */
  base(): TerminalEnvironment;
  /** The worktree's data variables, laid over the base environment. */
  worktree(projectId: string, worktreeId: string): TerminalEnvironment;
  /** A variable of the host process environment (`LANG`). */
  variable(name: string): string | undefined;
}

/** Where terminals may start. */
export interface TerminalWorkspacePort {
  /** The checkout a worktree (or one of its repositories) runs in. */
  worktreeCwd(projectId: string, worktreeId: string, repoId?: string): string;
  /** Throws when the worktree may not start new processes (archive drain). */
  assertStartAllowed(projectId: string, worktreeId: string): void;
}

export interface TerminalResourceHandle {
  unregister(): void;
}

/** Execution accounting for a live terminal's process tree. */
export interface TerminalResourcePort {
  register(session: TerminalSession, pid: number): TerminalResourceHandle;
}

/** Terminal state that outlives the process: sessions and scrollback. */
export interface TerminalPersistencePort {
  registerLiveSession(session: TerminalSession): void;
  appendTerminalOutput(
    projectId: string,
    worktreeId: string,
    terminalId: string,
    chunk: Buffer,
  ): void;
  markTerminalExited(
    projectId: string,
    worktreeId: string,
    terminalId: string,
    exitCode: number | null,
    signal: string | null,
  ): void;
  getPersistedTerminalEntry(terminalId: string): PersistedTerminalEntry | null;
}

/** Process effects the engine does not perform itself. */
export interface TerminalProcessPort {
  /** Windows: kill a process tree, calling `onFailure` when that fails. */
  killWindowsTree(pid: number, onFailure: () => void): void;
  /** Stop an owned process tree and wait until it is gone. */
  drainOwned(pid: number, isOwned: () => boolean): Promise<void>;
  /** Lower a running process's scheduling priority. */
  lowerPriority(pid: number): void;
  /**
   * Run a short hidden probe command and resolve its standard output, or
   * null when it fails or exceeds `timeoutMs`. Never rejects.
   */
  probe(
    file: string,
    args: string[],
    timeoutMs: number,
  ): Promise<string | null>;
}

export interface TerminalLogPort {
  warn(message: string, details?: Record<string, unknown>): void;
}

/** Everything the engine needs from its host. */
export interface TerminalEngineHost {
  /** Shell selection over the host's `supervision.terminalShell` facts. */
  shells: TerminalShells;
  pty: TerminalPtyPort;
  environment: TerminalEnvironmentPort;
  workspace: TerminalWorkspacePort;
  resources: TerminalResourcePort;
  persistence: TerminalPersistencePort;
  processes: TerminalProcessPort;
  log: TerminalLogPort;
}

export interface TerminalCreateRequest extends TerminalWorktreeScope {
  cols: number;
  rows: number;
  /** A repository of a multi-repository worktree to start in. */
  repoId?: string;
  /** A managed command to run instead of a user shell. */
  managedCommand?: ManagedTerminalCommand;
  /**
   * A host directory to start in instead of the worktree checkout, already
   * resolved and contained by the trusted in-process caller. Not a wire
   * field: the `worker.terminal.create` projection carries `cwdRootId` and
   * `cwdRelativePath` instead (CAN-5092 when terminal state leaves Electron main).
   */
  cwd?: string;
  profileId?: TerminalShellProfileId;
  /**
   * A shell the trusted caller already resolved, used instead of
   * `profileId`; a terminal host takes the shell its client selected.
   */
  shell?: ResolvedTerminalShell;
  /** A one-shot command the shell runs, then exits. */
  initialCommand?: string;
  /** Replaces the host's base and worktree environment. */
  environment?: TerminalEnvironment;
}

export interface TerminalRestoreRequest {
  terminalId: string;
  cols: number;
  rows: number;
  /** Replaces the host's base and worktree environment. */
  environment?: TerminalEnvironment;
  /** Restarts a persisted terminal with this shell instead of its own. */
  shell?: ResolvedTerminalShell;
}

/** One delivery to an attachment: output bytes, or the terminal's exit. */
export interface TerminalAttachmentItem {
  attachmentId: string;
  terminalId: string;
  /** Offset of the first byte of `data`. */
  fromOffset: number;
  /** Offset just past the last byte of `data`; the output `seq` it ends at. */
  toOffset: number;
  data: Uint8Array;
  /**
   * Bytes before `fromOffset` that the attachment asked for, or that
   * followed its previous item, left the replay window before delivery.
   */
  truncatedBefore: boolean;
  /** Set only on the last item, after every byte the terminal wrote. */
  exit: TerminalExitEvent | null;
}

/**
 * How an attachment ended. `completed`: the terminal exited and its exit
 * item was delivered. `cancelled`: the attachment was released.
 */
export type TerminalAttachmentOutcome = 'completed' | 'cancelled';

export interface TerminalAttachmentEnd {
  attachmentId: string;
  terminalId: string;
  outcome: TerminalAttachmentOutcome;
  /** Offset just past the last byte delivered to the attachment. */
  offset: number;
}

/** Where one attachment's deliveries go, in order. */
export interface TerminalAttachmentSink {
  item(item: TerminalAttachmentItem): void;
  end(end: TerminalAttachmentEnd): void;
}

export interface TerminalAttachmentRequest {
  terminalId: string;
  /** Replay from this offset; 0 replays the whole window. */
  fromOffset: number;
  /** Replay at most this many of the newest bytes (default and cap: 1 MiB). */
  maxReplayBytes?: number;
  sink: TerminalAttachmentSink;
}

export interface TerminalAttachment {
  attachmentId: string;
  session: TerminalSession;
}

export type WorkerTerminalEvent =
  | { type: 'spawned'; payload: TerminalSession }
  | { type: 'output'; payload: TerminalOutputEvent }
  | { type: 'exit'; payload: TerminalExitEvent }
  | { type: 'runningChanged'; payload: TerminalRunningChangedEvent };

export type WorkerTerminalEventType = WorkerTerminalEvent['type'];

export type WorkerTerminalEventListener = (event: WorkerTerminalEvent) => void;

/**
 * An app shutdown kills every terminal: their exits end no command, so none
 * gets an idle `runningChanged`. The in-process engine keeps PTY exit signals;
 * revision 2 remote terminals use the quit reason, matching main's prior
 * record stamp (CAN-7051).
 */
export interface TerminalKillAllOptions {
  readonly reason: 'app-quit' | 'fatal-exit';
}

/**
 * The in-process `worker.terminal` port. Every terminal effect goes through
 * it; the engine behind it holds no host services of its own. Operations are
 * synchronous where today's callers are, and named after the
 * `worker.terminal.*` catalog they will serve.
 *
 * Lifetime (D4): a terminal lives until it exits, is killed or released, or
 * its host shuts down; desktop quit kills every terminal. Attachments and
 * listeners never keep one alive, and terminals hold no daemon keep-alive
 * obligation.
 */
export interface WorkerTerminalPort {
  /** `worker.terminal.create` */
  create(request: TerminalCreateRequest): TerminalSession;
  /** `worker.terminal.restore`: resize a live terminal or restart a persisted shell. */
  restore(request: TerminalRestoreRequest): TerminalSession;
  /** `worker.terminal.list`: live terminals with their running state. */
  list(): TerminalSession[];
  /** `worker.terminal.get`: a live terminal, without attaching. */
  get(terminalId: string): TerminalSession | null;
  /**
   * The replay window of a live or persisted terminal and the offset of its
   * last byte, without attaching. Interfaces that receive output through the
   * event sink read it; the window is never consumed.
   */
  replay(terminalId: string): TerminalAttachResponse;
  /**
   * `worker.terminal.attach`: a new attachment with its own replay and
   * cursor. Replay and live output arrive on its sink as items of at most
   * 64 KiB; at most 128 stay unacknowledged, and output that leaves the
   * replay window meanwhile is skipped and flagged `truncatedBefore`. An
   * attachment never keeps its terminal alive.
   */
  attach(request: TerminalAttachmentRequest): TerminalAttachment;
  /** Return credit for every item delivered up to `offset`. */
  acknowledgeAttachment(attachmentId: string, offset: number): void;
  /**
   * End one attachment (`cancelled`); the terminal and its other
   * attachments are unaffected. Unknown or ended attachments are ignored.
   */
  releaseAttachment(attachmentId: string): void;
  /** The replay of a live or persisted terminal as text. */
  replayText(terminalId: string): string | null;
  /** `worker.terminal.write` */
  write(terminalId: string, data: string): void;
  /** `worker.terminal.resize` */
  resize(terminalId: string, cols: number, rows: number): void;
  /** `worker.terminal.kill`: kill the process tree; exit follows. */
  kill(terminalId: string, options?: { signal?: string | null }): void;
  killWorktree(scope: TerminalWorktreeScope): void;
  killAll(options?: TerminalKillAllOptions): void;
  /** `worker.terminal.release`: stop the process tree and wait until it is gone. */
  release(terminalId: string): Promise<void>;
  releaseWorktree(scope: TerminalWorktreeScope): Promise<void>;
  hasLiveTerminals(scope: TerminalWorktreeScope): boolean;
  /** Worktrees with a terminal whose foreground process is not the shell. */
  runningWorktrees(): TerminalWorktreeScope[];
  /** Lower a live terminal's priority where it could not start lowered. */
  lowerPriority(terminalId: string): void;
  /** `worker.terminal.profile.list` */
  profiles(): TerminalShellProfile[];
  /** The default shell's name, for rendering reviewed command arguments. */
  defaultShellBasename(): string;
  /** Warm shell selection before a user default is chosen. Never rejects. */
  prewarmShell(): Promise<void>;
  /** The interface's event sink, called before every other listener. */
  setEventSink(sink: WorkerTerminalEventListener): void;
  addEventListener(listener: WorkerTerminalEventListener): () => void;
}
