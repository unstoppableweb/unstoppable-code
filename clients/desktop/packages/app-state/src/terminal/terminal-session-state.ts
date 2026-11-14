import {
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  TERMINAL_CONNECTION_LOST_SIGNAL,
  TERMINAL_SANDBOX_ASLEEP_SIGNAL,
  TERMINAL_WORKTREE_CLEANUP_SIGNAL,
} from '@canopy/protocol/terminal';
import type { TerminalKind } from '@canopy/protocol/terminal';

export interface TerminalSessionStateLike {
  live: boolean;
  exitCode: number | null;
  signal: string | null;
  kind?: TerminalKind;
}

export function endedByAppShutdown(signal: string | null): boolean {
  const normalizedSignal = normalizeTerminalExitSignal(signal);
  return normalizedSignal === 'app-quit' || normalizedSignal === 'fatal-exit';
}

export function endedByWorktreeCleanup(signal: string | null): boolean {
  const normalizedSignal = normalizeTerminalExitSignal(signal);
  return normalizedSignal === TERMINAL_WORKTREE_CLEANUP_SIGNAL;
}

export function endedByCanopyManagedCleanup(signal: string | null): boolean {
  const normalizedSignal = normalizeTerminalExitSignal(signal);
  return normalizedSignal === TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL;
}

export function isIntentionalTerminalShutdown(signal: string | null): boolean {
  return (
    endedByAppShutdown(signal) ||
    endedByWorktreeCleanup(signal) ||
    endedByCanopyManagedCleanup(signal)
  );
}

/**
 * The environment stopped the shell (cloud connection lost, project asleep).
 * It is neither a command failure nor a completion: activity surfaces clear
 * the terminal's running state without marking it unseen, failed, or toasted,
 * and the terminal panel explains the recovery.
 */
export function isEnvironmentTerminalShutdown(signal: string | null): boolean {
  const normalizedSignal = normalizeTerminalExitSignal(signal);
  return (
    normalizedSignal === TERMINAL_CONNECTION_LOST_SIGNAL ||
    normalizedSignal === TERMINAL_SANDBOX_ASLEEP_SIGNAL
  );
}

export function normalizeTerminalExitSignal(
  signal: string | null,
): string | null {
  return signal === '0' ? null : signal;
}

export function isTerminalRestorableSession(
  session: TerminalSessionStateLike,
): boolean {
  const isShell = session.kind === undefined || session.kind === 'shell';
  return isShell && !session.live && endedByAppShutdown(session.signal);
}

export function isTerminalRestartableSession(
  session: TerminalSessionStateLike,
): boolean {
  const isShell = session.kind === undefined || session.kind === 'shell';
  const signal = normalizeTerminalExitSignal(session.signal);
  return (
    isShell &&
    !session.live &&
    (endedByAppShutdown(signal) ||
      signal === null ||
      signal === 'pipe-error' ||
      isEnvironmentTerminalShutdown(signal))
  );
}

export function getTerminalReadOnlyMessage(
  session: TerminalSessionStateLike,
  appName: string,
): string | null {
  const signal = normalizeTerminalExitSignal(session.signal);
  if (session.live) {
    return null;
  }

  if (endedByAppShutdown(signal)) {
    return 'Restored from a previous app session. Scrollback is preserved, but this shell is read-only. Restart the terminal to keep working.';
  }

  if (signal === TERMINAL_CONNECTION_LOST_SIGNAL) {
    return 'The terminal connection was lost, so the shell and anything running in it stopped. Restart the terminal to keep working.';
  }

  if (signal === TERMINAL_SANDBOX_ASLEEP_SIGNAL) {
    return 'Project is sleeping, so this shell stopped. Send a message to wake it, then restart the terminal.';
  }

  if (signal === 'pipe-error') {
    return 'The terminal connection closed unexpectedly. Restart the terminal to keep working.';
  }

  if (endedByWorktreeCleanup(signal)) {
    return 'This terminal is read-only because worktree cleanup closed it.';
  }

  if (endedByCanopyManagedCleanup(signal)) {
    return `This terminal is read-only because ${appName} closed it.`;
  }

  if (signal !== null) {
    return `This terminal is read-only. The shell exited with signal ${signal}.`;
  }

  if (session.exitCode !== null) {
    return `This terminal is read-only. The shell exited with code ${String(session.exitCode)}.`;
  }

  return 'This terminal is read-only.';
}

/**
 * REG-2987 web tab-chip policy: signals whose `getTerminalListStateLabel`
 * chip is a transport/sleep detail the web terminal panel tab no longer
 * shows. The in-panel recovery notice above the terminal output already
 * explains a lost connection or a sleeping project, and a stale "connection
 * closed" chip duplicated the pipe-error notice. Restart-relevant outcomes
 * (`exit N`, `history`, `closed`) are unaffected and keep showing.
 *
 * This gates on the raw signal constant, never on the translated label
 * string, so a copy change to the label cannot silently change which chips
 * are hidden. Scoped to the web panel tab only: desktop's terminal list rows
 * still call `getTerminalListStateLabel` directly and are unaffected.
 */
export function isHiddenTerminalTabChipSignal(signal: string | null): boolean {
  const normalizedSignal = normalizeTerminalExitSignal(signal);
  return (
    normalizedSignal === TERMINAL_CONNECTION_LOST_SIGNAL ||
    normalizedSignal === TERMINAL_SANDBOX_ASLEEP_SIGNAL ||
    normalizedSignal === 'pipe-error'
  );
}

export function getTerminalListStateLabel(
  session: TerminalSessionStateLike,
): string | null {
  const signal = normalizeTerminalExitSignal(session.signal);
  if (session.live) {
    return null;
  }

  if (isIntentionalTerminalShutdown(signal)) {
    return 'history';
  }

  if (signal === TERMINAL_CONNECTION_LOST_SIGNAL) return 'connection lost';
  if (signal === TERMINAL_SANDBOX_ASLEEP_SIGNAL) return 'project asleep';
  if (signal === 'pipe-error') return 'connection closed';

  if (signal !== null) {
    return signal.toLowerCase();
  }

  if (session.exitCode !== null) {
    return `exit ${String(session.exitCode)}`;
  }

  return 'closed';
}
