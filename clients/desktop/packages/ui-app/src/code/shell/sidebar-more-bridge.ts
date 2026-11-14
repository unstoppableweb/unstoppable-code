import { useSyncExternalStore } from 'react';
import type { SnapshotWorktree } from './worktree-status';

/**
 * The bridge between the shared sidebar and the More page.
 *
 * With hidden worktrees placed behind the More row, the sidebar no longer
 * lists them, but it still owns them: their rows come from its snapshot, and
 * Open, Unhide, Archive and Delete run through its own handlers and its own
 * confirmation. The sidebar publishes each workspace's hidden worktrees here
 * and serves requests from here, so the More page on either host shows the
 * same rows and takes the same paths as the sidebar's own row menus.
 */

export type SidebarHiddenWorktreeRequest =
  | {
      readonly kind: 'open' | 'unhide';
      readonly workspaceLocalId: string;
      readonly worktreeLocalId: string;
    }
  | {
      readonly kind: 'remove';
      readonly workspaceLocalId: string;
      readonly worktreeLocalId: string;
      readonly mode: 'archive' | 'delete';
    };

/** What the sidebar can do for a hidden worktree right now. */
export interface SidebarHiddenWorktreeAbilities {
  readonly unhide: boolean;
  readonly archive: boolean;
  readonly delete: boolean;
  /**
   * Archive and Delete are offered but locked, as the row menu locks them: a
   * running session, a split PR, or a removal already under way.
   */
  readonly removalLocked: boolean;
}

export interface SidebarHiddenWorktreeEntry {
  readonly worktree: SnapshotWorktree;
  /** The row's name as the sidebar shows it. */
  readonly label: string;
  readonly abilities: SidebarHiddenWorktreeAbilities;
}

/** A workspace whose hidden worktrees wait behind More. */
export interface SidebarMoreWorkspace {
  readonly name: string;
  /** What its rows are called, plural: `Worktrees` or `Chats`. */
  readonly unitLabelPlural: string;
  readonly hidden: readonly SidebarHiddenWorktreeEntry[];
}

type RequestHandler = (request: SidebarHiddenWorktreeRequest) => void;

const EMPTY_HIDDEN: readonly SidebarHiddenWorktreeEntry[] = Object.freeze([]);
let workspacesById: ReadonlyMap<string, SidebarMoreWorkspace> = new Map();
const listeners = new Set<() => void>();
let handler: RequestHandler | null = null;
/**
 * Whether the sidebar that registered `handler` is mounted. A sidebar can
 * unmount while the page stays (the mobile web drawer closes): Open still
 * reaches the host through its last handler. Unhide, Archive and Delete
 * change the list the sidebar publishes (and Archive and Delete need its
 * confirmation), so they wait until it is back.
 */
let attached = false;

function sameEntries(
  a: readonly SidebarHiddenWorktreeEntry[],
  b: readonly SidebarHiddenWorktreeEntry[],
): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        entry.worktree === other.worktree &&
        entry.label === other.label &&
        entry.abilities.unhide === other.abilities.unhide &&
        entry.abilities.archive === other.abilities.archive &&
        entry.abilities.delete === other.abilities.delete &&
        entry.abilities.removalLocked === other.abilities.removalLocked
      );
    })
  );
}

function sameWorkspace(
  a: SidebarMoreWorkspace,
  b: SidebarMoreWorkspace,
): boolean {
  return (
    a.name === b.name &&
    a.unitLabelPlural === b.unitLabelPlural &&
    sameEntries(a.hidden, b.hidden)
  );
}

/** The sidebar publishes every More workspace and its hidden worktrees. */
export function publishSidebarMoreWorkspaces(
  next: ReadonlyMap<string, SidebarMoreWorkspace>,
): void {
  const merged = new Map<string, SidebarMoreWorkspace>();
  let changed = next.size !== workspacesById.size;
  for (const [workspaceLocalId, workspace] of next) {
    const previous = workspacesById.get(workspaceLocalId);
    if (previous !== undefined && sameWorkspace(previous, workspace)) {
      merged.set(workspaceLocalId, previous);
    } else {
      merged.set(workspaceLocalId, workspace);
      changed = true;
    }
  }
  if (!changed) return;
  workspacesById = merged;
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** The sidebar serves the page's requests; its last handler outlives it. */
export function registerSidebarHiddenWorktreeHandler(
  next: RequestHandler,
): () => void {
  handler = next;
  attached = true;
  notify();
  return () => {
    if (handler !== next) return;
    attached = false;
    notify();
  };
}

/**
 * Asks the sidebar to act on a hidden worktree. False when nothing can serve
 * it: no sidebar has mounted, or anything but Open while it is unmounted.
 */
export function requestSidebarHiddenWorktreeAction(
  request: SidebarHiddenWorktreeRequest,
): boolean {
  if (handler === null) return false;
  if (request.kind !== 'open' && !attached) return false;
  handler(request);
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A More workspace as its sidebar shows it; undefined until it publishes. */
export function useSidebarMoreWorkspace(
  workspaceLocalId: string,
): SidebarMoreWorkspace | undefined {
  return useSyncExternalStore(
    subscribe,
    () => workspacesById.get(workspaceLocalId),
    () => undefined,
  );
}

/** A workspace's hidden worktrees, as its sidebar lists them. */
export function useSidebarHiddenWorktrees(
  workspaceLocalId: string,
): readonly SidebarHiddenWorktreeEntry[] {
  return useSidebarMoreWorkspace(workspaceLocalId)?.hidden ?? EMPTY_HIDDEN;
}

/** Whether the sidebar is mounted to serve Unhide, Archive and Delete. */
export function useSidebarHiddenWorktreeRemovalAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => attached,
    () => false,
  );
}
