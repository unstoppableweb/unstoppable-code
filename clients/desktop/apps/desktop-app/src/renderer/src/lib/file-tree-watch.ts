/**
 * Renderer-side refcount over the main-process file-tree watch IPC.
 *
 * Main keys native watches by `senderId:projectId/worktreeId` WITHOUT
 * refcounting, so with multiple mounted explorer surfaces for the same
 * worktree (the standalone File Explorer panel plus any number of embedded
 * per-file-tab trees) the first unmount would tear down the watch every other
 * instance still relies on. This wrapper keeps one main-side watch alive per
 * worktree until the last renderer consumer releases it.
 */

interface SharedWatch {
  count: number;
  /** The single underlying IPC start, shared by every concurrent consumer. */
  started: Promise<void>;
}

const watches = new Map<string, SharedWatch>();

function watchKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

/**
 * Acquire a shared watch for the worktree. The returned promise settles with
 * the one underlying IPC start (shared across consumers); a rejected start
 * still leaves this consumer holding its count — pair every acquire with
 * exactly one {@link releaseFileTreeWatch}.
 */
export function acquireFileTreeWatch(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const key = watchKey(projectId, worktreeId);
  const existing = watches.get(key);
  if (existing) {
    existing.count += 1;
    return existing.started;
  }
  const shared: SharedWatch = {
    count: 1,
    started: window.api.startFileTreeWatch({ projectId, worktreeId }),
  };
  watches.set(key, shared);
  return shared.started;
}

/** Release one consumer; stops the main-side watch when none remain. */
export function releaseFileTreeWatch(
  projectId: string,
  worktreeId: string,
): void {
  const key = watchKey(projectId, worktreeId);
  const shared = watches.get(key);
  if (!shared) return;
  shared.count -= 1;
  if (shared.count > 0) return;
  watches.delete(key);
  // Send the stop immediately so main processes start/stop in renderer send
  // order (main registers a start's subscription synchronously, so a stop
  // arriving mid-start still tears it down; a stop for a failed start
  // no-ops). Deferring the stop could reorder it after a subsequent
  // re-acquire's start and kill the new watch.
  void window.api
    .stopFileTreeWatch({ projectId, worktreeId })
    .catch(() => undefined);
}
