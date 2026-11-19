// ---------------------------------------------------------------------------
// Link context menu "Open in browser" availability (CAN-2632)
// ---------------------------------------------------------------------------
//
// The native link context menu runs in main, which cannot read the renderer's
// selection synchronously. The main window's renderer pushes whether a
// worktree's Browser panel is a valid target: a worktree is selected and the
// main page is showing, not covered by Settings or the Portal. Main resets
// its copy on reload, so the value is published again on every start.

import { useChatStore } from './chatStore';
import { useNavigationStore } from './navigationStore';

let started = false;
let lastSent: boolean | null = null;

/**
 * Whether the selected worktree's Browser panel can take a link right now:
 * a worktree is selected and the main page shows, not covered by Settings or
 * the Portal. Customize, Home and similar pages cannot host the panel.
 */
export function isLinkBrowserTargetAvailable(): boolean {
  const navigation = useNavigationStore.getState();
  return (
    useChatStore.getState().selectedWorktree !== null &&
    navigation.activePage === 'main' &&
    !navigation.settingsOpen &&
    !navigation.remoteControlDialogOpen
  );
}

function publish(): void {
  const available = isLinkBrowserTargetAvailable();
  if (available === lastSent) return;
  lastSent = available;
  window.api.browser.reportLinkBrowserTarget({ available });
}

/** Idempotently report link target availability for the app's lifetime. */
export function startLinkBrowserTargetReporter(): void {
  if (started) return;
  // Partial preload bridges in isolated hosts lack the method; skip there.
  if (typeof window.api.browser.reportLinkBrowserTarget !== 'function') return;
  started = true;
  publish();
  // Both stores update often (chat on every streaming tick), so recompute
  // only when an input changed.
  useChatStore.subscribe((state, prev) => {
    if (state.selectedWorktree !== prev.selectedWorktree) publish();
  });
  useNavigationStore.subscribe((state, prev) => {
    if (
      state.activePage !== prev.activePage ||
      state.settingsOpen !== prev.settingsOpen ||
      state.remoteControlDialogOpen !== prev.remoteControlDialogOpen
    ) {
      publish();
    }
  });
}
