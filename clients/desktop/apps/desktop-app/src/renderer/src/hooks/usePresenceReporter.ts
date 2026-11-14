import { useEffect, useRef } from 'react';
import { isWebCoreScope } from '../lib/chat-authority';
import { useChatStore } from '../stores/chatStore';

/**
 * Minimum gap between two presence reports, per worktree.
 *
 * Presence only has to answer "was a human at this machine in the last few
 * minutes", so the useful resolution is coarse. One report per interaction
 * would be thousands of IPC messages for an hour of typing and would tell the
 * server nothing it did not already know from the first one.
 */
export const PRESENCE_REPORT_INTERVAL_MS = 60_000;

/**
 * The interactions that count as a human being present.
 *
 * Deliberately real input only. Scroll, focus, and visibility changes all fire
 * without a person doing anything (a streaming message can scroll the view, a
 * window can be raised by another app), and presence exists precisely to
 * distinguish "watching it finish" from "walked away".
 */
const PRESENCE_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

/**
 * Report coarse human presence for the selected worktree (CAN-3195).
 *
 * The server uses this to suppress the low-urgency "your run finished" push
 * while the user is demonstrably sitting in front of that worktree watching it
 * finish. It never suppresses `needs_input` / `blocked` — being at the desk is
 * not the same as having answered.
 *
 * Nothing is reported when no worktree is selected: presence is per-worktree,
 * and a report attributed to the wrong one would suppress a push the user
 * should have received.
 */
export function usePresenceReporter(): void {
  const selected = useChatStore((state) => state.selectedWorktree);
  // Read inside the listener rather than re-subscribing the DOM listeners on
  // every selection change: the listeners are document-level and capture-phase,
  // and re-binding them on each worktree switch is pure churn.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const lastReportedAtRef = useRef(new Map<string, number>());

  useEffect(() => {
    const report = (): void => {
      const current = selectedRef.current;
      // This computer's telemetry knows only local worktrees; a cloud task's
      // ids never go to its IPC (CAN-6395).
      if (!current || isWebCoreScope(current.projectId)) {
        return;
      }
      const key = `${current.projectId}::${current.worktreeId}`;
      const now = Date.now();
      const last = lastReportedAtRef.current.get(key) ?? 0;
      if (now - last < PRESENCE_REPORT_INTERVAL_MS) {
        return;
      }
      lastReportedAtRef.current.set(key, now);
      window.api.telemetrySync.recordActivity(
        current.projectId,
        current.worktreeId,
      );
    };
    for (const event of PRESENCE_EVENTS) {
      // Capture phase so an interaction inside a component that stops
      // propagation (menus, editors, the terminal) still counts as presence.
      document.addEventListener(event, report, {
        capture: true,
        passive: true,
      });
    }
    return (): void => {
      for (const event of PRESENCE_EVENTS) {
        document.removeEventListener(event, report, { capture: true });
      }
    };
  }, []);
}
