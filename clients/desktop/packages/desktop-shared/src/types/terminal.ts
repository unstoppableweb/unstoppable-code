import type {
  LoadWorktreeTerminalStateRequest,
  LoadWorktreeTerminalStateResponse,
  SaveWorktreeTerminalStateRequest,
  TerminalAttachRequest,
  TerminalAttachResponse,
  TerminalExitEvent,
  TerminalKillRequest,
  TerminalOutputEvent,
  TerminalPreset,
  TerminalResizeRequest,
  TerminalRestoreRequest,
  TerminalRunningChangedEvent,
  TerminalSession,
  TerminalShellProfile,
  TerminalShellProfileId,
  TerminalSpawnRequest,
  TerminalWriteDisposition,
  TerminalWriteRequest,
} from '@canopy/protocol/terminal';

import type {
  CanopyErrorPayload,
  CanopyWorkspaceScope,
  CoreClientWindowRight,
  CoreClientWindowTicket,
  WorkerTerminalAttachParams,
  WorkerTerminalResizeParams,
  WorkerTerminalWriteParams,
} from '@canopy/protocol/canopy-core';

export type { TerminalDrawerPreferences } from '@canopy/protocol/preferences';

export type {
  LoadWorktreeTerminalStateRequest,
  LoadWorktreeTerminalStateResponse,
  TerminalRecordHistoryStatus,
  ManagedTerminalCommand,
  PersistedTerminalEntry,
  PersistedWorktreeTerminalStateFile,
  SaveWorktreeTerminalStateRequest,
  TerminalAttachRequest,
  TerminalAttachResponse,
  TerminalExitEvent,
  TerminalGroup,
  TerminalKillRequest,
  TerminalKind,
  TerminalOutputEvent,
  TerminalPreset,
  TerminalPresetIcon,
  TerminalResizeRequest,
  TerminalRestoreRequest,
  TerminalRunningChangedEvent,
  TerminalSession,
  TerminalShellProfile,
  TerminalShellProfileId,
  TerminalSpawnRequest,
  TerminalWriteDisposition,
  TerminalWriteRequest,
  WorktreeTerminalLayoutState,
  WorktreeTerminalState,
} from '@canopy/protocol/terminal';

export {
  DEFAULT_TERMINAL_DRAWER_ACTIVE_TAB_ID,
  DEFAULT_TERMINAL_DRAWER_COLLAPSED,
  DEFAULT_TERMINAL_DRAWER_HEIGHT,
  MAX_TERMINAL_DRAWER_HEIGHT,
  MIN_TERMINAL_DRAWER_HEIGHT,
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  TERMINAL_CUSTOM_NAME_MAX_LENGTH,
  TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES,
  TERMINAL_USER_CLOSE_SIGNAL,
  TERMINAL_WORKTREE_CLEANUP_SIGNAL,
} from '@canopy/protocol/terminal';

// ---------------------------------------------------------------------------
// Preload bridge surface
// ---------------------------------------------------------------------------

/**
 * Renderer-facing terminal API exposed on `window.api.terminal`.
 *
 * `on*` subscription methods return an unsubscribe function, matching the
 * existing preload event-subscription conventions.
 */
export interface TerminalApi {
  listProfiles(): Promise<TerminalShellProfile[]>;
  /** Terminal settings through `core.terminal.settings.get` (CAN-4148). */
  getSettings(): Promise<TerminalSettings>;
  /** Compare-and-swap through `core.terminal.settings.update` (CAN-4148). */
  updateSettings(
    request: UpdateTerminalSettingsRequest,
  ): Promise<UpdateTerminalSettingsResponse>;
  spawn(request: TerminalSpawnRequest): Promise<TerminalSession>;
  restore(request: TerminalRestoreRequest): Promise<TerminalSession>;
  attach(request: TerminalAttachRequest): Promise<TerminalAttachResponse>;
  write(request: TerminalWriteRequest): Promise<TerminalWriteDisposition>;
  resize(request: TerminalResizeRequest): Promise<void>;
  kill(request: TerminalKillRequest): Promise<void>;
  loadWorktreeState(
    request: LoadWorktreeTerminalStateRequest,
  ): Promise<LoadWorktreeTerminalStateResponse>;
  saveWorktreeState(request: SaveWorktreeTerminalStateRequest): Promise<void>;
  /** List every live terminal across every worktree. */
  list(): Promise<TerminalSession[]>;
  onSpawned(listener: (session: TerminalSession) => void): () => void;
  onOutput(listener: (event: TerminalOutputEvent) => void): () => void;
  /**
   * Output this window reads on its own connection (CAN-8070), which main
   * sends in place of `onOutput`: its `seq`, without the bytes.
   */
  onOutputProgress(
    listener: (event: TerminalOutputProgressEvent) => void,
  ): () => void;
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
  onRunningChanged(
    listener: (event: TerminalRunningChangedEvent) => void,
  ): () => void;
}

// ---------------------------------------------------------------------------
// Window admission to daemon terminals (CAN-8068): local windows only, never
// tunneled to a paired controller.
// ---------------------------------------------------------------------------

/** The daemon endpoint main's verified terminal connection reached. */
export interface TerminalWindowDaemonEndpoint {
  readonly kind: 'socket' | 'pipe';
  readonly path: string;
  readonly auth: {
    /** The token file's secret; only keys the connection's nonce proof. */
    readonly secret: string | Uint8Array;
    readonly dataRootHash: string;
  };
  readonly maxFrameBytes?: number;
}

/** `terminal:window-connect`: everything a window needs to present its ticket. */
export interface TerminalWindowConnectResponse {
  readonly windowInstanceId: string;
  readonly endpoint: TerminalWindowDaemonEndpoint;
  /**
   * The runtime main's connection reached at `endpoint` (CAN-8069). A window
   * skips main's runtime checks, so it keeps a connection only to this one.
   */
  readonly runtime: {
    readonly runtimeId: string;
    readonly daemonEpoch: string;
  };
  /** Single use, bound to main's terminal lease. */
  readonly ticket: CoreClientWindowTicket;
  readonly expiresAt: string;
}

export interface TerminalWindowRouteRequest {
  readonly terminalId: string;
}

/**
 * `terminal:window-connect` (CAN-8070): the terminal a window connects for.
 * Main answers `null` at once, contacting no daemon, unless it mirrors that
 * daemon terminal for the window.
 */
export type TerminalWindowConnectRequest = TerminalWindowRouteRequest;

/**
 * `terminal:window-connect` for a window connection's own reconnect
 * (CAN-8070): main answers `null`, contacting no daemon, unless the window
 * still reads a daemon terminal main mirrors.
 */
export interface TerminalWindowReconnectRequest {
  readonly reconnect: true;
}

/** `terminal:output-progress`: a terminal's output position, without its bytes. */
export type TerminalOutputProgressEvent = Pick<
  TerminalOutputEvent,
  'projectId' | 'worktreeId' | 'terminalId' | 'seq'
>;

/** `terminal:window-route`: a daemon terminal this window was granted. */
export interface TerminalWindowRouteResponse {
  readonly scope: CanopyWorkspaceScope;
  readonly terminalId: string;
  readonly rights: readonly CoreClientWindowRight[];
  readonly session: TerminalSession;
}

/** A window call's outcome: the daemon's result or its error payload. */
export type TerminalWindowReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: CanopyErrorPayload };

/** One `worker.terminal.attach` stream on the window's own connection. */
export interface TerminalWindowStream {
  /** The next frame as the shared client delivers it; `done` once it ends. */
  next(): Promise<
    { readonly done: true } | { readonly done: false; readonly value: unknown }
  >;
  /** Drops the stream, which frees its daemon attachment at once (CAN-8067). */
  close(): Promise<void>;
}

export type TerminalWindowStreamOpen =
  | { readonly ok: true; readonly stream: TerminalWindowStream }
  | { readonly ok: false; readonly error: CanopyErrorPayload };

/**
 * `window.api.terminalWindow` (CAN-8069): this window's own daemon connection,
 * for the terminals main grants it, which the renderer's terminal router
 * streams (CAN-8070); main alone decides when a terminal is lost.
 */
export interface TerminalWindowApi {
  /**
   * Connects once, lazily, for a daemon terminal main mirrors (CAN-8070);
   * `false` keeps that terminal on main's relay.
   */
  connect(request: TerminalWindowConnectRequest): Promise<boolean>;
  /** Grants this window one daemon terminal, or `null` to keep main's relay. */
  route(
    request: TerminalWindowRouteRequest,
  ): Promise<TerminalWindowRouteResponse | null>;
  /**
   * Hands a routed terminal back to main's relay (CAN-8070): main sends its
   * output again and revokes the grant. Resolves once main has.
   */
  release(request: TerminalWindowRouteRequest): Promise<void>;
  attach(params: WorkerTerminalAttachParams): Promise<TerminalWindowStreamOpen>;
  write(params: WorkerTerminalWriteParams): Promise<TerminalWindowReply>;
  resize(params: WorkerTerminalResizeParams): Promise<TerminalWindowReply>;
  /** Fires when the connection ends for good; `connect` opens a new one. */
  onClosed(listener: () => void): () => void;
  close(): Promise<void>;
}

/** Terminal settings with image icons as data URLs, as windows show them. */
export interface TerminalSettings {
  revision: number;
  disabledTerminalShellProfileIds: TerminalShellProfileId[];
  terminalPresets: TerminalPreset[];
}

export interface UpdateTerminalSettingsRequest {
  expectedRevision: number;
  disabledTerminalShellProfileIds: TerminalShellProfileId[];
  terminalPresets: TerminalPreset[];
  /** One per save attempt; a retry of the same attempt reuses it. */
  idempotencyKey: string;
}

export type UpdateTerminalSettingsResponse =
  | { ok: true; settings: TerminalSettings }
  | {
      ok: false;
      error: { code: 'conflict'; message: string; settings: TerminalSettings };
    }
  | { ok: false; error: { code: 'invalid'; message: string } };
