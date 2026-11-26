/**
 * User-gesture ledger for terminal keyboard focus (CAN-2309).
 *
 * A terminal pane must take the caret ONLY when the user actually put it
 * there — clicking the pane, starting a terminal, or an explicit reveal.
 * Merely becoming the active/visible panel (workspace or task switch, panel
 * group expand/maximize/restore, session restart, cached pane remount) is not
 * a user gesture and must leave the caret where the user left it.
 *
 * Panes cannot infer that from their props, so the surfaces that DO know a
 * gesture happened record the intent here and the pane consumes it exactly
 * once. The revision counter exists so a pane that is already mounted and
 * selected still reacts to a reveal that arrives after mount.
 */

interface PendingFocusRequest {
  readonly ownerDocument: Document;
  readonly recordedAt: number;
  readonly isCurrent?: () => boolean;
}

/**
 * How long a recorded gesture stays redeemable.
 *
 * Every consumer mounts within a frame or two of the gesture, so this is not a
 * timing knob — it is a containment bound. Not every entry point is a direct
 * click: `focusOnSpawn` (`useScriptEventSubscriptions`) records a request from
 * an asynchronous setup/launch script event, which can land while the user is
 * in a different worktree entirely. No pane for that terminal is mounted then,
 * so nothing consumes or clears the request, and it would otherwise sit here
 * until the next window blur — redeemable by a later PASSIVE switch back to
 * that worktree, which is precisely the CAN-2309 leak this module prevents.
 */
const REQUEST_TTL_MS = 10_000;

const pendingRequests = new Map<string, PendingFocusRequest>();
const listeners = new Set<() => void>();
// Both are weak: a popped-out panel window must not be retained by this module
// after the user closes it. A strong `Map` keyed by `Window` would pin every
// aux window opened during a session, along with the listener closures
// installed below, for the lifetime of the renderer.
const focusedWindows = new WeakMap<Window, boolean>();
const trackedWindows = new WeakSet<Window>();
let revision = 0;

function notify(): void {
  revision += 1;
  // Snapshot first: a listener may unsubscribe while being notified.
  Array.from(listeners).forEach((listener) => {
    listener();
  });
}

/**
 * A gesture that has not been honored by the time the app goes to the
 * background is void: the user is no longer here, and honoring it later is
 * exactly how the caret ended up sitting in a terminal when someone came back
 * from a break and started typing.
 */
function discardPendingRequestsForWindow(ownerWindow: Window): void {
  let changed = false;
  for (const [terminalId, request] of Array.from(pendingRequests.entries())) {
    if (request.ownerDocument.defaultView !== ownerWindow) continue;
    pendingRequests.delete(terminalId);
    changed = true;
  }
  if (changed) notify();
}

/** Drops every request whose {@link REQUEST_TTL_MS} window has lapsed. */
function pruneExpiredRequests(now: number): void {
  for (const [terminalId, request] of Array.from(pendingRequests.entries())) {
    if (now - request.recordedAt < REQUEST_TTL_MS) continue;
    pendingRequests.delete(terminalId);
  }
}

/**
 * Starts tracking a window's focus state once, so requests can be rejected
 * while it is backgrounded and invalidated when it blurs or closes. Safe to
 * call on every request; repeat calls for an already-tracked window are a
 * no-op.
 */
function installWindowFocusTracking(ownerDocument: Document): Window | null {
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) return null;
  if (trackedWindows.has(ownerWindow)) return ownerWindow;
  trackedWindows.add(ownerWindow);
  // Deliberately NOT seeded. `focusedWindows` records only observed
  // transitions, so an absent entry means "never observed" and
  // `isWindowFocused` falls back to the live `hasFocus()` reading. Seeding a
  // snapshot here would be a trap: `focus` fires only on a transition, so a
  // window that was already focused when tracking was installed (the main
  // window installs at module evaluation) would never receive one, and a stale
  // `false` would silently drop every focus request for the rest of the
  // session.
  const handleBlur = (): void => {
    focusedWindows.set(ownerWindow, false);
    discardPendingRequestsForWindow(ownerWindow);
  };
  const handleFocus = (): void => {
    focusedWindows.set(ownerWindow, true);
  };
  // A popped-out panel window is torn down when the user closes it. Detach
  // eagerly rather than relying on the weak collections above, so the
  // listeners and their closures go away at a known point and any request
  // still pending for that window is invalidated rather than orphaned.
  const handlePageHide = (): void => {
    discardPendingRequestsForWindow(ownerWindow);
    focusedWindows.delete(ownerWindow);
    trackedWindows.delete(ownerWindow);
    ownerWindow.removeEventListener('blur', handleBlur);
    ownerWindow.removeEventListener('focus', handleFocus);
    ownerWindow.removeEventListener('pagehide', handlePageHide);
  };
  ownerWindow.addEventListener('blur', handleBlur);
  ownerWindow.addEventListener('focus', handleFocus);
  ownerWindow.addEventListener('pagehide', handlePageHide);
  return ownerWindow;
}

// Install immediately so an async spawn that finishes after the first window
// blur cannot miss that transition merely because no prior request existed.
if (typeof document !== 'undefined') installWindowFocusTracking(document);

/**
 * Whether `ownerWindow` currently has focus.
 *
 * `focusedWindows` holds only OBSERVED transitions. An absent entry means no
 * `focus`/`blur` has been seen yet, in which case the live `hasFocus()`
 * reading is authoritative — that is what lets tracking installed while a
 * window was already focused self-heal instead of rejecting every request for
 * the session. Once a transition has been observed the stored value wins, so
 * blur invalidation is unaffected.
 */
function isWindowFocused(
  ownerWindow: Window,
  ownerDocument: Document,
): boolean {
  return focusedWindows.get(ownerWindow) ?? ownerDocument.hasFocus();
}

/**
 * Records that the user explicitly asked `terminalId` to take the caret. The
 * matching pane consumes this the next time it evaluates its focus claim.
 *
 * Only real user gestures may call this — a click on a pane, the Start
 * terminal button, adding a terminal tab, an explicit reveal. Their async
 * work can complete after the user backgrounds the app, so requests made
 * while blurred are rejected and pending requests are discarded on blur.
 */
export function requestTerminalFocus(
  terminalId: string,
  ownerDocument: Document = document,
  isCurrent?: () => boolean,
): void {
  if (isCurrent && !isCurrent()) return;
  const ownerWindow = installWindowFocusTracking(ownerDocument);
  if (ownerWindow !== null && !isWindowFocused(ownerWindow, ownerDocument)) {
    return;
  }
  const now = Date.now();
  pruneExpiredRequests(now);
  pendingRequests.set(terminalId, {
    ownerDocument,
    recordedAt: now,
    isCurrent,
  });
  notify();
}

/**
 * Consumes a pending request. Returns true exactly once per
 * {@link requestTerminalFocus} call, so a pane that re-renders for an
 * unrelated reason never re-claims the caret.
 */
export function consumeTerminalFocusRequest(
  terminalId: string,
  ownerDocument: Document = document,
): boolean {
  const request = pendingRequests.get(terminalId);
  if (request === undefined) return false;
  if (request.ownerDocument !== ownerDocument) return false;
  pendingRequests.delete(terminalId);
  if (request.isCurrent && !request.isCurrent()) return false;
  // A request nobody consumed in time is void. Deleting it above is what stops
  // a later passive activation from redeeming it.
  if (Date.now() - request.recordedAt >= REQUEST_TTL_MS) return false;
  const ownerWindow = installWindowFocusTracking(ownerDocument);
  return ownerWindow === null || isWindowFocused(ownerWindow, ownerDocument);
}

/** Drops a pending request without claiming (pane unmount / terminal death). */
export function clearTerminalFocusRequest(terminalId: string): void {
  pendingRequests.delete(terminalId);
}

/** Subscribe helper for `useSyncExternalStore`. */
export function subscribeTerminalFocusRequests(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** Snapshot helper for `useSyncExternalStore`. */
export function getTerminalFocusRequestRevision(): number {
  return revision;
}

/**
 * Test-only reset so module state does not leak between specs.
 *
 * The main window is explicitly marked focused rather than cleared. Deleting
 * the entry would hand the decision to `isWindowFocused`'s live fallback, and
 * jsdom reports `document.hasFocus() === false`, which would make every spec
 * behave as if the app were backgrounded. A focused app is the right default
 * for a spec; the fallback path is covered with its own documents instead.
 *
 * `trackedWindows` is deliberately left alone: its listeners are still
 * attached, so dropping the entry would make the next call install a second
 * set on the same window.
 */
export function __resetTerminalFocusIntentForTests(): void {
  pendingRequests.clear();
  listeners.clear();
  revision = 0;
  if (typeof window !== 'undefined') focusedWindows.set(window, true);
}
