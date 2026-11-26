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

import type { BrowserDrawerTabId } from '@canopy/execution-engine/types/browser';

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
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
  onRunningChanged(
    listener: (event: TerminalRunningChangedEvent) => void,
  ): () => void;
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

// ---------------------------------------------------------------------------
// Preferences contribution
// ---------------------------------------------------------------------------

/**
 * Preferences fields contributed by the terminal drawer feature.
 *
 * Merged into `PreferencesData` in `src/shared/types.ts`. The main-side
 * normalize/clamp logic lives with the rest of preference validation.
 */
export interface TerminalDrawerPreferences {
  /** Whether the drawer is collapsed. Default: `true`. */
  terminalDrawerCollapsed: boolean;
  /** Drawer height in pixels. Default: 300. Clamp: 180–600. */
  terminalDrawerHeight: number;
  /**
   * Active drawer tab id. Default: `'terminal'`. The shared drawer now hosts
   * both the terminal and the in-app browser, so this accepts
   * {@link BrowserDrawerTabId} (`'terminal' | 'browser'`). The field name is
   * kept for backward compatibility with persisted preferences. Runtime
   * validation / invalid-value normalization of the stored value is a backend
   * concern (see the backend plan).
   */
  terminalDrawerActiveTabId: BrowserDrawerTabId;
  /** Detected shell entries hidden from the Terminal panel picker. */
  disabledTerminalShellProfileIds: TerminalShellProfileId[];
  /** User-defined shell + command shortcuts offered in the panel picker. */
  terminalPresets: TerminalPreset[];
  /**
   * Revision of `disabledTerminalShellProfileIds` and `terminalPresets`
   * (CAN-4148). It moves exactly when either committed value changes; the
   * preference merge sets it and no patch can. Starts at 0.
   */
  terminalSettingsRevision: number;
}
