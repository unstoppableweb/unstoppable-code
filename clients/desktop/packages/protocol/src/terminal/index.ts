// ---------------------------------------------------------------------------
// Shared terminal protocol contracts
// ---------------------------------------------------------------------------
//
// These types describe the environment-neutral terminal transport contract.
// TerminalAttachResponse.replay and TerminalOutputEvent.data carry Uint8Array
// values through in-process structured clone and are never JSON payloads.
//
// All terminal IPC payloads carry `{ projectId, worktreeId, terminalId }` so
// the renderer can route events by worktree without maintaining a local
// id→worktree map. The desktop terminal engine owns the authoritative
// ownership table and stamps every outbound event from it.
//
// ManagedTerminalCommand remains a host-only capability and must stay
// unreachable through shared client commands.

/**
 * Discriminator for how a terminal session was launched. The default
 * (`'shell'`) covers the existing user-spawned interactive shell. The
 * `'claude-code'` variant is reserved for the managed Claude Code terminal
 * — these PTYs are owned by the chat tab they were launched from and the
 * main process drives lifecycle events through the `claudeTerminal` IPC
 * surface rather than the drawer UI.
 */
export type TerminalKind = 'shell' | 'script' | 'claude-code' | 'claude-worker';

export type TerminalShellProfileId =
  | 'default'
  | 'zsh'
  | 'bash'
  | 'cmd'
  | 'powershell'
  | 'git-bash';

export interface TerminalShellProfile {
  id: TerminalShellProfileId;
  label: string;
  isDefault: boolean;
}

export type TerminalPresetIcon =
  | { kind: 'character'; value: string }
  | {
      kind: 'image';
      /** Explicit light-mode asset. Falls back to darkDataUrl when omitted. */
      lightDataUrl?: string;
      /** Explicit dark-mode asset. Falls back to lightDataUrl when omitted. */
      darkDataUrl?: string;
    };

/** User-defined shortcut shown in the Terminal panel picker. */
export interface TerminalPreset {
  id: string;
  name: string;
  terminalProfileId: TerminalShellProfileId;
  command: string;
  enabled: boolean;
  icon?: TerminalPresetIcon;
}

/**
 * Description of a non-shell command the main process should spawn under
 * PTY control. Carries provenance fields (`chatId`, `sessionKey`) used by
 * downstream backend modules to wire the bundled `claude` CLI to its
 * generated MCP / hook config files.
 *
 * Existing callers that omit {@link TerminalSpawnRequest.managedCommand}
 * continue to spawn a normal shell — the field is optional precisely so
 * the legacy shell-spawn path is untouched.
 */
export interface ManagedTerminalCommand {
  /** Absolute path to the executable the main process should spawn. */
  executable: string;
  /** Command-line arguments passed verbatim to the executable. */
  args: string[];
  /**
   * Extra environment variables merged onto the child PTY's environment.
   * The main process is responsible for redacting any sensitive values
   * before forwarding diagnostic logs to the renderer.
   */
  env?: Record<string, string>;
  /**
   * Main-process-only PATH entries prepended before spawning the managed
   * command. Renderer IPC callers are not allowed to set this field.
   */
  pathPrepend?: string[];
  /** Display title for the resulting terminal entry. */
  title: string;
  /**
   * Kind of managed command. Restricted to non-shell variants because a
   * `'shell'` kind here would be redundant with the default spawn path.
   */
  kind: Exclude<TerminalKind, 'shell'>;
  /** Whether the renderer should reveal and focus this terminal on spawn. */
  focusOnSpawn?: boolean;
  /** Chat tab that owns the managed command, when applicable. */
  chatId?: string;
  /**
   * Per-runtime session key shared with the managed process via generated
   * config files. Echoed back on {@link TerminalSession.sessionKey} so the
   * renderer can re-correlate the PTY with the owning chat after restart.
   */
  sessionKey?: string;
}

/**
 * Wire-level description of a live PTY-backed terminal session.
 *
 * Returned by `terminalSpawn`, `terminalAttach`, and `terminalList`. Both
 * renderer and main read worktree ownership from this record rather than
 * keeping parallel maps.
 */
export interface TerminalSession {
  /** UUID, globally unique across all worktrees and projects. */
  id: string;
  /** Owning project id (worktree-scoped). */
  projectId: string;
  /** Owning worktree id (worktree-scoped). */
  worktreeId: string;
  /** Absolute path to the shell executable, e.g. `/bin/zsh`. */
  shell: string;
  /** Shell basename, e.g. `zsh`. Used by the running-state detector to compare against `pty.process`. */
  shellBasename: string;
  /** Initial working directory at spawn time. */
  cwd: string;
  /** Unix-ms timestamp the session was created. */
  createdAt: number;
  /** Current command-running state, included by terminal list snapshots. */
  running?: boolean;
  /** Current foreground process name, included by terminal list snapshots. */
  processName?: string | null;
  /**
   * One-shot command owned by this terminal session. The shell exits after the
   * command finishes, and restoring the historical terminal reruns it.
   */
  initialCommand?: string;
  /**
   * Discriminator for how this terminal was launched. Absent values are
   * treated as `'shell'` for backward compatibility with existing
   * persisted sessions.
   */
  kind?: TerminalKind;
  /** Whether the renderer should reveal and focus this terminal on spawn. */
  focusOnSpawn?: boolean;
  /**
   * Display title carried through from {@link ManagedTerminalCommand.title}.
   * Only meaningful when {@link kind} is non-shell.
   */
  title?: string;
  /**
   * Chat tab that owns this terminal session, when launched via a managed
   * command. Used by the renderer to route Claude Code terminal events
   * back to the originating chat tab.
   */
  chatId?: string;
  /**
   * Per-runtime session key for managed terminals. Mirrors
   * {@link ManagedTerminalCommand.sessionKey} for routes that need to look
   * up the underlying HTTP integration session.
   */
  sessionKey?: string;
}

/**
 * Renderer-only state for a single terminal group (tab) within a worktree.
 *
 * A group may contain multiple PTY panes rendered side-by-side. Persistence
 * is deferred to v2, but the shape lives in shared types so renderer tests
 * and future persistence work can reference it.
 */
export interface TerminalGroup {
  id: string;
  /** Terminal ids in left-to-right pane order. */
  terminalIds: string[];
  /** Id of the pane that currently owns focus. */
  focusedTerminalId: string;
  /** Normalized flex-basis fractions per pane, aligned with `terminalIds`. */
  splitSizes: number[];
}

/**
 * Renderer-only per-worktree terminal state.
 *
 * `version` is present so future persistence migrations have a reliable
 * discriminator.
 */
export interface WorktreeTerminalState {
  version: 1;
  /** Groups ordered top-to-bottom in the sidebar list. */
  groups: TerminalGroup[];
  /** Currently-active group id, or `null` when no groups exist. */
  activeGroupId: string | null;
}

/**
 * Renderer/main shared layout metadata for a worktree's terminal drawer.
 *
 * This is the worktree-scoped structure the renderer edits and the main
 * process persists under `worktree-data/<worktreeId>/`.
 */
export interface WorktreeTerminalLayoutState {
  /** Whether this worktree's terminal drawer is collapsed. */
  drawerCollapsed: boolean;
  /** Groups ordered top-to-bottom in the sidebar list. */
  groups: TerminalGroup[];
  /** Currently-active group id, or `null` when no groups exist. */
  activeGroupId: string | null;
  /** Monotonic counter used to assign stable group ordinals. */
  nextGroupOrdinal: number;
  /** Stable ordinals keyed by group id. */
  groupOrdinals: Record<string, number>;
  /** User-assigned names keyed by terminal id. */
  terminalCustomNames: Record<string, string>;
  /** User-assigned names keyed by group id. */
  groupCustomNames: Record<string, string>;
}

/**
 * Persisted snapshot for a single terminal entry in the drawer.
 *
 * The last 5000 newline-delimited lines are retained so the drawer can show a
 * read-only historical terminal after the PTY has exited or the app restarts.
 */
export interface PersistedTerminalEntry {
  session: TerminalSession;
  /** Last 5000 newline-delimited lines of output, preserving ANSI text. */
  scrollbackLines: string[];
  /** Most recent exit code, or `null` when the terminal is still live / unknown. */
  exitCode: number | null;
  /** Most recent signal, or `null` when none was observed. */
  signal: string | null;
}

/**
 * On-disk worktree terminal persistence file stored under `worktree-data/`.
 */
export interface PersistedWorktreeTerminalStateFile extends WorktreeTerminalLayoutState {
  version: 1;
  terminals: PersistedTerminalEntry[];
}

// ---------------------------------------------------------------------------
// IPC request / response payloads
// ---------------------------------------------------------------------------

export interface TerminalSpawnRequest {
  /** POSIX package directory beneath the authoritative selected target. */
  relativeCwd?: string;
  projectId: string;
  worktreeId: string;
  /** Multi-repo workspace repo whose checkout should become the shell cwd. */
  selectedRepoId?: string;
  /**
   * Explicit interactive shell profile to launch. Omitted and `'default'`
   * both preserve the existing platform-default shell behavior.
   */
  terminalProfileId?: TerminalShellProfileId;
  /**
   * Optional one-shot command submitted as part of shell startup. Its startup
   * prompt and input echo are omitted from terminal output so the first
   * visible content comes from the command itself. The owning shell exits when
   * the command finishes; restoring the terminal reruns the same command.
   */
  initialCommand?: string;
  cols: number;
  rows: number;
  /**
   * Optional managed-command override. When present the main process must
   * spawn the supplied executable instead of the user's shell. Callers that
   * omit this field continue to receive a normal interactive shell.
   */
  managedCommand?: ManagedTerminalCommand;
}

export interface TerminalAttachRequest {
  terminalId: string;
}

export interface TerminalAttachResponse {
  session: TerminalSession;
  /**
   * The terminal's replay window of raw PTY bytes (256 KB rolling, 1 MB for
   * a restored terminal). Used for first-mount scrollback and for
   * rehydration after renderer reload; reading it never consumes it.
   */
  replay: Uint8Array;
  /**
   * Monotonic sequence number of the last byte contained in `replay`. The
   * renderer drops live `terminalOutput` frames with `seq <= replayed seq`
   * to deduplicate at the attach → live-subscribe seam.
   */
  seq: number;
}

export interface TerminalWriteRequest {
  terminalId: string;
  data: string;
  /** Stable key used to suppress renderer-replayed terminal side effects. */
  idempotencyKey?: string;
}

export type TerminalWriteDisposition = 'written' | 'already_written';

export interface TerminalResizeRequest {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalKillRequest {
  terminalId: string;
  /** Cloud history can close before its terminal record has hydrated. */
  scope?: { projectId: string; worktreeId: string };
}

export interface TerminalRestoreRequest {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface LoadWorktreeTerminalStateRequest {
  projectId: string;
  worktreeId: string;
}

export interface LoadWorktreeTerminalStateResponse extends WorktreeTerminalLayoutState {
  terminals: PersistedTerminalEntry[];
  /** Terminal ids backed by a currently-live PTY in the main process. */
  liveTerminalIds: string[];
}

export interface SaveWorktreeTerminalStateRequest extends WorktreeTerminalLayoutState {
  projectId: string;
  worktreeId: string;
  /** Closed terminals whose history to delete; omission from `groups` keeps it. */
  forgetTerminalIds?: string[];
}

// ---------------------------------------------------------------------------
// Push events (main → renderer)
// ---------------------------------------------------------------------------

/**
 * PTY output frame.
 *
 * `data` is a `Uint8Array`, NOT a JSON-encoded string: output transport is
 * binary end-to-end. Electron's structured clone preserves typed arrays.
 * Frames are microtask-coalesced on the main side with an 8 KB immediate
 * flush threshold; the desktop renderer receives a terminal's frames at once
 * when it sent none in the last 16 ms, otherwise merged per 16 ms or 64 KiB
 * (a merged frame carries the last frame's `seq`).
 *
 * `seq` is monotonically increasing per terminal and is reused by
 * `TerminalAttachResponse.seq` for attach-seam deduplication.
 */
export interface TerminalOutputEvent {
  projectId: string;
  worktreeId: string;
  terminalId: string;
  data: Uint8Array;
  seq: number;
}

export interface TerminalExitEvent {
  projectId: string;
  worktreeId: string;
  terminalId: string;
  /**
   * Discriminator for the terminal that exited. Optional for compatibility
   * with older renderer/main payloads.
   */
  kind?: TerminalKind;
  exitCode: number | null;
  signal: string | null;
}

export const TERMINAL_WORKTREE_CLEANUP_SIGNAL = 'worktree-cleanup';
export const TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL = 'app-managed-cleanup';
/**
 * Stable prefix of a main-process error whose rest is a plain sentence about a
 * shell the user chose (or restored) that cannot start. Hosts may show that
 * sentence instead of their generic start/restart text.
 */
export const TERMINAL_SHELL_UNAVAILABLE_PREFIX = 'Terminal shell unavailable: ';
export const TERMINAL_USER_CLOSE_SIGNAL = 'user-close';
export const TERMINAL_CONNECTION_LOST_SIGNAL = 'connection-lost';
export const TERMINAL_SANDBOX_ASLEEP_SIGNAL = 'sandbox-asleep';

export interface TerminalRunningChangedEvent {
  projectId: string;
  worktreeId: string;
  terminalId: string;
  /**
   * Discriminator for the terminal whose foreground process changed.
   * Optional for compatibility with older renderer/main payloads.
   */
  kind?: TerminalKind;
  running: boolean;
  /**
   * Foreground process name when different from the shell; `null` when the
   * foreground process is the shell itself. Surfaced to the renderer as an
   * inline preview ("what's currently running?") next to each terminal in
   * the per-worktree terminal list.
   */
  processName: string | null;
  /**
   * True when this transition to idle was caused by a user Ctrl+C interrupt.
   * Used by the renderer to avoid treating aborted commands as completions.
   */
  interruptedByUser?: boolean;
  /**
   * Outcome of the command that just finished, meaningful only on a
   * running→idle transition (`running: false`). Additive and optional:
   *
   * - a number: the observed exit status of that command (`0` = success);
   * - `null`: the producer reports exit statuses, but this command's outcome
   *   is unknown (for example, it ended without a status mark). Consumers must
   *   treat it as neither success nor failure;
   * - omitted: a legacy producer without exit-status reporting (the desktop
   *   terminal engine, which never sets it). Consumers keep their existing
   *   completion behavior.
   *
   * The web cloud terminal sends an explicit `null` for an unknown outcome, so
   * `null` and omitted must never be conflated. Producers omit it on
   * `running: true`.
   */
  exitCode?: number | null;
}

/** Maximum length for a terminal or split custom name. */
export const TERMINAL_CUSTOM_NAME_MAX_LENGTH = 64;

/** Maximum persisted newline-delimited scrollback lines per terminal. */
export const TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES = 5000;

/** Default value for `terminalDrawerCollapsed`. */
export const DEFAULT_TERMINAL_DRAWER_COLLAPSED = true;

/** Default value for `terminalDrawerHeight`, in px. */
export const DEFAULT_TERMINAL_DRAWER_HEIGHT = 300;

/** Minimum allowed `terminalDrawerHeight`, in px. */
export const MIN_TERMINAL_DRAWER_HEIGHT = 180;

/** Maximum allowed `terminalDrawerHeight`, in px. */
export const MAX_TERMINAL_DRAWER_HEIGHT = 600;

/** Default value for `terminalDrawerActiveTabId`. */
export const DEFAULT_TERMINAL_DRAWER_ACTIVE_TAB_ID = 'terminal';
