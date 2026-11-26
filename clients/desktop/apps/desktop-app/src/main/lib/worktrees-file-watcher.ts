import type { BrowserWindow } from 'electron';
import {
  createWorktreeWatch,
  type WorktreeWatch,
} from './worktree-watch-recovery';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  IPC_CHANNELS,
  type SidebarItem,
  type WorktreeData,
  type WorktreesFileChangedEvent,
} from '@canopy/desktop-shared/types';
import { w5RecordReadPaths } from './paths';
import {
  parseWorktreesFileReconciliationSnapshot,
  worktreesContentHoldsRows,
} from './workspace-persistence';
import { publishWorktreeLifecycleChange } from './worktree-lifecycle-signals';
import { sendToWindow } from './window-send';
import { markDesktopW5ReadCacheDirty } from '../canopy-runtime/w5-read-cache-server';

/*
 * TRANSITIONAL (CAN-7156): the fallback that notices worktrees.json changes
 * from outside this process while the daemon's W5e commit stream is not live.
 * While it is live, other origins' commits arrive as events
 * (`workspace-commit-events.ts`), so no watcher runs. A watcher announces
 * only content whose bytes differ from what it last read, or, when a
 * delivered projects load started it, content not holding the delivered
 * rows. It records none of this process's writes, so an own write's echo
 * during an outage is announced once. Retire at W5 activation, when change
 * notification moves behind the authority.
 */

type ExternalSnapshotHandler = (
  workspaceId: string,
  worktrees: readonly WorktreeData[],
) => void;

interface WorktreesFileWatcherEntry {
  watcher: WorktreeWatch | null;
  /** The bytes last read (`null`: absent or unreadable); unset until the first read. */
  lastContent: string | null | undefined;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Reads and announcements run one at a time, in order. */
  queue: Promise<void>;
  closed: boolean;
  /** Closed because the stream went live: its final check still runs. */
  draining: boolean;
}

const WORKTREES_FILE_DEBOUNCE_MS = 500;
const worktreesFileWatchers = new Map<string, WorktreesFileWatcherEntry>();
/**
 * Watchers the stream's going live closed. A restart compares against their
 * last read, because a commit the dropped stream never delivered is already
 * on disk when the restarted watcher first reads.
 */
const retiredWatchers = new Map<string, WorktreesFileWatcherEntry>();
/** What the last sync asked to watch; restarted when the stream drops. */
const wantedWorkspaceIds = new Set<string>();
let getTargetWindow: () => BrowserWindow | null = () => null;
let externalSnapshotHandler: ExternalSnapshotHandler | undefined;
let commitEventsLive = false;

function running(entry: WorktreesFileWatcherEntry): boolean {
  return !entry.closed || entry.draining;
}

/** The list file's bytes (`null`: absent or unreadable); W1's compare input. */
export function readWorktreesFileContent(
  workspaceId: string,
): Promise<string | null> {
  return readFile(w5RecordReadPaths.worktrees(workspaceId), 'utf8').catch(
    () => null,
  );
}

function enqueue(
  entry: WorktreesFileWatcherEntry,
  step: () => Promise<void>,
): Promise<void> {
  const run = entry.queue.then(step);
  entry.queue = run.catch(() => undefined);
  return entry.queue;
}

function announce(workspaceId: string, content: string | null): void {
  // Even malformed or missing files invalidate before reconciliation or
  // the renderer reload can read the old cached rows.
  markDesktopW5ReadCacheDirty([{ kind: 'worktrees', workspaceId }]);
  if (content !== null) {
    const worktrees = parseWorktreesFileReconciliationSnapshot(content);
    if (worktrees !== null) externalSnapshotHandler?.(workspaceId, worktrees);
  }
  publishWorktreeLifecycleChange('worktree-list-membership');
  const event: WorktreesFileChangedEvent = { workspaceId };
  sendToWindow(getTargetWindow(), IPC_CHANNELS.worktreesFileChanged, event);
}

/** W1's compare (CAN-7144): only changed bytes are an outside change. */
function enqueueCheck(
  workspaceId: string,
  entry: WorktreesFileWatcherEntry,
): Promise<void> {
  return enqueue(entry, async () => {
    if (!running(entry)) return;
    const content = await readWorktreesFileContent(workspaceId);
    if (!running(entry) || content === entry.lastContent) return;
    entry.lastContent = content;
    announce(workspaceId, content);
  });
}

function scheduleChange(
  workspaceId: string,
  entry: WorktreesFileWatcherEntry,
): void {
  if (entry.closed) return;
  if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    void enqueueCheck(workspaceId, entry);
  }, WORKTREES_FILE_DEBOUNCE_MS);
}

function closeEntry(
  workspaceId: string,
  entry: WorktreesFileWatcherEntry,
  drain: boolean,
): void {
  entry.closed = true;
  entry.draining = drain;
  entry.watcher?.close();
  if (worktreesFileWatchers.get(workspaceId) === entry)
    worktreesFileWatchers.delete(workspaceId);
  if (entry.debounceTimer !== null) {
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
  }
  if (!drain) return;
  // One last read whether or not an event arrived: a write that landed before
  // the stream opened is on disk now, and its file event may still be in flight.
  retiredWatchers.set(workspaceId, entry);
  void enqueueCheck(workspaceId, entry);
}

/** A retired watcher whose workspace is no longer wanted announces nothing. */
function forgetRetired(workspaceId: string): void {
  const retired = retiredWatchers.get(workspaceId);
  if (!retired) return;
  retired.draining = false;
  retiredWatchers.delete(workspaceId);
}

function startWatcher(
  workspaceId: string,
  deliveredWorktrees?: readonly WorktreeData[],
): void {
  const filePath = w5RecordReadPaths.worktrees(workspaceId);
  const filenameToWatch = basename(filePath);
  const entry: WorktreesFileWatcherEntry = {
    watcher: null,
    lastContent: undefined,
    debounceTimer: null,
    queue: Promise.resolve(),
    closed: false,
    draining: false,
  };
  // Deep copy: the caller keeps and may change the delivered rows.
  const delivered =
    deliveredWorktrees === undefined
      ? undefined
      : structuredClone(Array.from(deliveredWorktrees));
  worktreesFileWatchers.set(workspaceId, entry);
  try {
    entry.watcher = createWorktreeWatch({
      path: dirname(filePath),
      label: `worktrees:${workspaceId}`,
      onChange: (_event, filename) => {
        if (filename && filename.toString() !== filenameToWatch) return;
        scheduleChange(workspaceId, entry);
      },
      poll: () =>
        enqueue(entry, async () => {
          if (entry.closed) return;
          const content = await readWorktreesFileContent(workspaceId);
          if (!entry.closed && content !== entry.lastContent)
            scheduleChange(workspaceId, entry);
        }),
      onFatal: () => closeEntry(workspaceId, entry, false),
    });
  } catch (error) {
    worktreesFileWatchers.delete(workspaceId);
    throw error;
  }
  const retired = retiredWatchers.get(workspaceId);
  retiredWatchers.delete(workspaceId);
  const retiredDone = retired?.queue;
  // The first read is the baseline. Content is announced like any outside
  // change when it does not hold a delivered load's rows (an outside write
  // between the load's read and this watch), or, without them, when it
  // differs from the retired watcher's last read.
  void enqueue(entry, async () => {
    if (retired) {
      await retiredDone;
      retired.draining = false;
    }
    const content = await readWorktreesFileContent(workspaceId);
    entry.lastContent = content;
    if (!running(entry)) return;
    const unannounced =
      delivered !== undefined
        ? !worktreesContentHoldsRows(workspaceId, content, delivered)
        : retired?.lastContent !== undefined && content !== retired.lastContent;
    if (unannounced) announce(workspaceId, content);
  });
}

function startWanted(
  delivered?: ReadonlyMap<string, readonly WorktreeData[]>,
): void {
  for (const workspaceId of Array.from(wantedWorkspaceIds)) {
    if (worktreesFileWatchers.has(workspaceId)) continue;
    try {
      startWatcher(workspaceId, delivered?.get(workspaceId));
    } catch {
      // The workspace directory may disappear between the sidebar read and
      // watcher creation. A later projects sync will retry it.
    }
  }
}

export function syncWorktreesFileWatchers(
  items: SidebarItem[],
  getWindow: () => BrowserWindow | null,
  preserveWorkspaceIds: ReadonlySet<string> = new Set(),
  onExternalSnapshot?: ExternalSnapshotHandler,
  /** True when `items` is the snapshot the renderer receives. */
  itemsDelivered = false,
): void {
  getTargetWindow = getWindow;
  externalSnapshotHandler = onExternalSnapshot;
  const watchedItems = new Map<string, readonly WorktreeData[]>(
    items.flatMap((item) =>
      item.type === 'cowork' ? [] : [[item.id, item.worktrees]],
    ),
  );
  for (const workspaceId of Array.from(wantedWorkspaceIds)) {
    if (watchedItems.has(workspaceId) || preserveWorkspaceIds.has(workspaceId))
      continue;
    wantedWorkspaceIds.delete(workspaceId);
    forgetRetired(workspaceId);
    const entry = worktreesFileWatchers.get(workspaceId);
    if (entry) closeEntry(workspaceId, entry, false);
  }
  for (const workspaceId of Array.from(watchedItems.keys()))
    wantedWorkspaceIds.add(workspaceId);
  if (!commitEventsLive) startWanted(itemsDelivered ? watchedItems : undefined);
}

/**
 * Follows the W5e commit stream (CAN-7156): live stops every watcher after
 * one final check; not live starts the wanted ones again.
 */
export function setWorktreesFileWatchersCommitEventsLive(live: boolean): void {
  if (live === commitEventsLive) return;
  commitEventsLive = live;
  if (!live) {
    startWanted();
    return;
  }
  for (const [workspaceId, entry] of Array.from(
    worktreesFileWatchers.entries(),
  ))
    closeEntry(workspaceId, entry, true);
}

export function stopWorktreesFileWatchers(): void {
  for (const [workspaceId, entry] of Array.from(
    worktreesFileWatchers.entries(),
  ))
    closeEntry(workspaceId, entry, false);
  for (const workspaceId of Array.from(retiredWatchers.keys()))
    forgetRetired(workspaceId);
  wantedWorkspaceIds.clear();
}
