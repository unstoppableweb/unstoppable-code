// ---------------------------------------------------------------------------
// xterm.js instance cache
// ---------------------------------------------------------------------------
//
// xterm instances are stored in a module-scope Map keyed by terminal id so
// they survive React unmounts (drawer collapse/expand, worktree switch, page
// navigation). Scrollback and selection stay cached while each mounted owner
// reattaches to recover output emitted while the pane was detached.
//
// The xterm stylesheet is imported here so the CSS ships whenever any
// terminal UI component mounts, regardless of which one renders first.

import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { isShortcutEvent } from '../../find/shortcut-target';
import { findEditableSafePanelShortcut } from '../panels/panel-commands';
import {
  createTerminalHostContainer,
  TERMINAL_GEOMETRY_OPTIONS,
} from './terminal-geometry';

import { TERMINAL_THEME } from './terminal-theme';
import { notifyTerminalInput } from './terminal-input';
export { TERMINAL_BG_COLOR, TERMINAL_THEME } from './terminal-theme';
/**
 * Find-bar match highlights, in the other find modes' warning amber: the
 * dark-theme `--fg-warning` (`#E28530`) at 35% (matches) and 65% (active)
 * over `TERMINAL_BG_COLOR`, since the search addon only accepts opaque
 * `#RRGGBB` colors. The match decoration's background can paint over the
 * active one's, so only the active match is outlined. The overview-ruler
 * colors are required by the addon even though the terminal shows no
 * overview ruler.
 */
export const TERMINAL_FIND_DECORATIONS = {
  matchBackground: '#56361b',
  matchOverviewRuler: '#56361b',
  activeMatchBackground: '#975b25',
  activeMatchBorder: '#e28530',
  activeMatchColorOverviewRuler: '#975b25',
} satisfies NonNullable<ISearchOptions['decorations']>;
const TERMINAL_ESCAPE = '\u001b';
const TERMINAL_CARRIAGE_RETURN = '\r';

/** Cached xterm instance and its host DOM container. */
export interface TerminalInstanceEntry {
  term: Terminal;
  fit: FitAddon;
  /** Scrollback search behind the find bar's terminal mode. */
  search: SearchAddon;
  /**
   * True while a find controller is registered for this terminal. The custom
   * key handler then declines the find chord so xterm neither sends it to the
   * PTY nor stops its propagation, letting the window shortcut open the bar.
   * A plain flag rather than a count: the find controller registry keeps
   * one controller per terminal id, and only the one still registered
   * resets it when old and new panes overlap during navigation.
   */
  findShortcutClaimed: boolean;
  /** Set once `disposeInstance` tore the xterm down; never call into it then. */
  disposed: boolean;
  /** Detached host element owned by the cache — panes mount it into the DOM. */
  container: HTMLDivElement;
  /**
   * Monotonic `seq` of the last byte the renderer has already written via the
   * attach replay. Incoming live output frames with `seq <= lastReplayedSeq`
   * are dropped to avoid duplicating the replay at the attach → live-subscribe
   * seam.
   */
  lastReplayedSeq: number;
  /** Queued history writes, including writes started by a retired pane owner. */
  pendingReplayWrites: number;
  /** True once the renderer has successfully completed `terminalAttach`. */
  attached: boolean;
  /** Lazily-installed xterm input subscription used by `TerminalPane`. */
  inputDisposable: IDisposable | null;
  /** Pane-owned transport pipeline; replaced atomically on cached remount. */
  outputDisposable: IDisposable | null;
}

const instances = new Map<string, TerminalInstanceEntry>();

/**
 * Return the cached entry for this terminal id, creating it lazily on first
 * access. The returned `container` is a detached `<div>` ready to be appended
 * into a pane host element.
 */
export function getOrCreateInstance(terminalId: string): TerminalInstanceEntry {
  const existing = instances.get(terminalId);
  if (existing) {
    return existing;
  }

  const container = createTerminalHostContainer(document);

  const term = new Terminal({
    ...TERMINAL_GEOMETRY_OPTIONS,
    cursorBlink: true,
    allowProposedApi: true,
    theme: { ...TERMINAL_THEME },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);

  const entry: TerminalInstanceEntry = {
    term,
    fit,
    search,
    findShortcutClaimed: false,
    disposed: false,
    container,
    lastReplayedSeq: -1,
    pendingReplayWrites: 0,
    attached: false,
    inputDisposable: null,
    outputDisposable: null,
  };

  // xterm.js maps both Enter and Shift+Enter to a bare carriage return. TUIs
  // such as Claude Code expect the conventional terminal binding for modified
  // Enter (Escape + carriage return) so they can insert a newline without
  // submitting. Keep other Enter chords on xterm's native path.
  //
  // xterm handles Ctrl+F itself (readline forward-char) and stops its
  // propagation, so a window-level find shortcut never sees it. While a find
  // controller claims this terminal, decline the platform find chord on
  // every event type: xterm then skips it and it bubbles to the window.
  //
  // The panel tab-cycle chords (CAN-4616) are declined the same way. xterm
  // would send Ctrl+Tab and Ctrl+PageDown/PageUp to the shell and stop them,
  // so cycling could never leave a terminal tab it landed on.
  //
  // xterm supports one custom key handler, so every rule lives here.
  term.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
    if (entry.findShortcutClaimed && isShortcutEvent(event, 'f')) {
      return false;
    }
    if (findEditableSafePanelShortcut(event) !== undefined) {
      return false;
    }
    const isShiftEnter =
      event.key === 'Enter' &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey;
    if (!isShiftEnter || event.type !== 'keydown') {
      return true;
    }

    event.preventDefault();
    if (!term.options.disableStdin) notifyTerminalInput(terminalId);
    term.input(`${TERMINAL_ESCAPE}${TERMINAL_CARRIAGE_RETURN}`);
    return false;
  });

  instances.set(terminalId, entry);
  return entry;
}

/** Return the cached entry for this id, or `undefined` if none exists. */
export function peekInstance(
  terminalId: string,
): TerminalInstanceEntry | undefined {
  return instances.get(terminalId);
}

/**
 * Dispose the xterm instance for this terminal id and drop it from the cache.
 * Safe to call for ids that are not cached.
 */
export function disposeInstance(terminalId: string): void {
  const entry = instances.get(terminalId);
  if (!entry) {
    return;
  }
  entry.disposed = true;
  try {
    entry.outputDisposable?.dispose();
    entry.inputDisposable?.dispose();
    entry.term.dispose();
  } catch {
    // xterm dispose never throws in normal operation; swallow in case the
    // instance is already torn down.
  }
  instances.delete(terminalId);
}
