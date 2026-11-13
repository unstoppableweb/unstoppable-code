/**
 * Whether the docked Orchestrator page covers this window's content area.
 * The pages under it stay mounted but hidden, so the chat they hold is not
 * in view: it counts as not visible for unread, attention and OS
 * notifications (`getVisibleWorktreeKey`). Only the main window's App sets
 * it; the Orchestrator's own renderer never is covered.
 */
let covered = false;
const listeners = new Set<() => void>();

export function isMainContentCoveredByAppAdvisorDock(): boolean {
  return covered;
}

export function setMainContentCoveredByAppAdvisorDock(next: boolean): void {
  if (covered === next) return;
  covered = next;
  listeners.forEach((listener) => listener());
}

export function subscribeAppAdvisorDockCover(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * Leaves the docked Orchestrator page for an explicit navigation, through the
 * handler the main window's App installs (`lib/appAdvisorDockLeave.ts`). A
 * no-op elsewhere, the Orchestrator's own renderer included. Kept here, free
 * of store imports, so `dismissPageLikeViewers` can call it without a cycle.
 */
let leaveHandler: (() => void) | null = null;

export function setAppAdvisorDockLeaveHandler(handler: () => void): () => void {
  leaveHandler = handler;
  return (): void => {
    if (leaveHandler === handler) leaveHandler = null;
  };
}

export function leaveAppAdvisorDock(): void {
  leaveHandler?.();
}
