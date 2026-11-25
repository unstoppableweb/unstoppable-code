import { app, BrowserWindow } from 'electron';
import { shouldShowUiAutomationWindow } from './ui-automation-window';

let resolveMainWindow: () => BrowserWindow | null = () => null;

export function setMainWindowResolver(
  resolve: () => BrowserWindow | null,
): void {
  resolveMainWindow = resolve;
}

/** The main window, for host effects that report progress to it. */
export function getMainWindow(): BrowserWindow | null {
  return resolveMainWindow();
}

export interface FocusMainWindowOptions {
  /**
   * Actively pull the window in front of the app the user is currently looking
   * at. Only set this when the user just performed an action in another app
   * that is expected to hand control back to the desktop app (finishing an
   * OAuth sign-in in the browser, for example).
   *
   * Defaults to `false`, which restores/shows the window and requests focus
   * without fighting the foreground app.
   *
   * Every caller of this helper is a user action (deep link, notification or
   * campaign click, artifact card click, focus shortcut, OAuth return), so it
   * may `show()` a hidden window. Agent- and automation-driven raises must not
   * use it while the app is in the background: on macOS `show()` is
   * `activateIgnoringOtherApps:YES`, which yanks the whole app in front of
   * whatever the user is working in (CAN-1993). See {@link isAppFrontmost}.
   *
   * Raising is best-effort and platform-dependent. On macOS this calls
   * `app.focus({ steal: true })`, which is reliable.
   *
   * On Windows the OS foreground lock means a background process usually
   * cannot raise a window directly, so this pins the window on top, raises it,
   * focuses it, and un-pins. The un-pin is deliberately last: releasing it
   * before the focus lands frequently loses the raise. Even so, when the
   * foreground lock applies the taskbar button may simply flash instead — this
   * path has not been verified on real Windows hardware.
   *
   * On Linux the behavior is left to the window manager.
   */
  steal?: boolean;
  /**
   * Order the window above its siblings after focusing it. This is a plain
   * z-order nudge, not a foreground steal, and is safe on every platform.
   */
  moveTop?: boolean;
}

/**
 * Focus an explicitly supplied window. Callers that want the app's main window
 * should use {@link focusMainWindow} instead, which resolves it for them.
 */
export function focusWindow(
  window: BrowserWindow | null,
  options?: FocusMainWindowOptions,
): void {
  if (!window || window.isDestroyed()) return;
  if (!shouldShowUiAutomationWindow()) return;
  noteUserActivation();

  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();

  if (options?.steal && process.platform === 'win32') {
    // Pin -> raise -> focus -> un-pin. Never leave the window pinned if it
    // was not already, and never un-pin one the user pinned themselves.
    //
    // The un-pin is in `finally` because callers treat focusing as
    // best-effort and swallow throws: without it, a throwing `moveTop()` or
    // `focus()` would leave the app pinned above every other application with
    // nothing to put it back.
    const alreadyPinned = window.isAlwaysOnTop();
    if (!alreadyPinned) window.setAlwaysOnTop(true);
    try {
      window.moveTop?.();
      window.focus();
    } finally {
      if (!alreadyPinned) window.setAlwaysOnTop(false);
    }
    return;
  }

  if (options?.steal && process.platform === 'darwin') {
    app.focus({ steal: true });
  }

  window.focus();
  if (options?.moveTop) window.moveTop?.();
}

export function focusMainWindow(options?: FocusMainWindowOptions): void {
  focusWindow(resolveMainWindow(), options);
}

/**
 * Whether one of this app's windows currently holds OS keyboard focus, i.e.
 * the user is looking at this app rather than another application. Agent- and
 * automation-driven window raises must check this before calling `show()`,
 * `focus()`, or `moveTop()` so background work never steals the foreground.
 */
export function isAppFrontmost(): boolean {
  return BrowserWindow.getFocusedWindow() !== null;
}

/** How long after a person's own raise a follow-up request may still raise. */
const USER_ACTIVATION_GRACE_MS = 3000;
let lastUserActivationAt = Number.NEGATIVE_INFINITY;

/**
 * Records that the person just asked for the app from outside it (a
 * notification click, the focus shortcut, a deep link). OS activation is
 * asynchronous, so the request that follows can arrive before a window holds
 * focus; {@link mayTakeForeground} lets it through.
 */
export function noteUserActivation(): void {
  lastUserActivationAt = Date.now();
}

/**
 * Whether a window may come in front of other applications now: the person
 * is already in this app, or just asked for it. A request from the renderer
 * while neither holds cannot come from their own input, whatever it says, so
 * it must show without activating.
 */
export function mayTakeForeground(): boolean {
  return (
    isAppFrontmost() ||
    Date.now() - lastUserActivationAt < USER_ACTIVATION_GRACE_MS
  );
}
