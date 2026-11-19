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
  clearWorktreesSelfWriteTracking,
  isWorktreesSelfWriteContent,
  parseWorktreesFileReconciliationSnapshot,
  recordObservedWorktreesContent,
  seedWorktreesContentBaseline,
  startWorktreesContentTracking,
  wasRecentWorktreesSelfWrite,
  worktreesSelfWritesStarted,
} from './workspace-persistence';
import { sendToWindow } from './window-send';

interface WorktreesFileWatcherEntry {
  watcher: WorktreeWatch | null;
  lastContent: string | null;
  readInFlight: Promise<string | null> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const WORKTREES_FILE_DEBOUNCE_MS = 500;
const worktreesFileWatchers = new Map<string, WorktreesFileWatcherEntry>();

function closeWatcher(entry: WorktreesFileWatcherEntry): void {
  if (entry.debounceTimer !== null) {
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
  }
  entry.watcher?.close();
}

async function readContent(
  entry: WorktreesFileWatcherEntry,
  workspaceId: string,
  afterPending = false,
): Promise<string | null> {
  if (afterPending && entry.readInFlight) await entry.readInFlight;
  if (worktreesFileWatchers.get(workspaceId) !== entry) return null;
  if (!entry.readInFlight) {
    entry.readInFlight = readFile(
      w5RecordReadPaths.worktrees(workspaceId),
      'utf8',
    )
      .catch(() => null)
      .finally(() => {
        entry.readInFlight = null;
      });
  }
  return entry.readInFlight;
}

function scheduleChange(
  workspaceId: string,
  getWindow: () => BrowserWindow | null,
  onExternalSnapshot?: (
    workspaceId: string,
    worktrees: readonly WorktreeData[],
  ) => void,
): void {
  const entry = worktreesFileWatchers.get(workspaceId);
  if (!entry) {
    return;
  }
  if (entry.debounceTimer !== null) {
    clearTimeout(entry.debounceTimer);
  }
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    if (wasRecentWorktreesSelfWrite(workspaceId)) {
      // Non-lossy suppression: an external write can land inside the desktop's
      // own self-write window (the desktop save preserves it on disk but the
      // renderer's memory misses it). Re-arm the debounce instead of dropping
      // the event so the check below runs once the window lapses; a fresh
      // desktop write keeps pushing it back, which is the correct quiet state.
      scheduleChange(workspaceId, getWindow, onExternalSnapshot);
      return;
    }
    void (async (): Promise<void> => {
      // Suppress pure self-write echoes by content, never by event timing: a
      // loaded main process can deliver an echo after the self-write window.
      // Refreshing anyway turns every desktop persist (e.g. the GitHub poller
      // writing lastKnownPrStatus) into a projects reload that re-syncs
      // pollers and churns the sidebar. A self-write that absorbed an
      // unannounced external change never matches (see
      // isWorktreesSelfWriteContent), so that batch still emits.
      // The read intentionally bypasses the persistence layer's write locks: a
      // torn/partial read simply fails the compare and emits (the fail-open
      // direction), and a true self-write settles to a matching read on the
      // next debounce. A read that overlapped one of our writes may predate
      // it, so it is retried rather than classified.
      const writesStarted = worktreesSelfWritesStarted(workspaceId);
      const content = await readContent(entry, workspaceId, true);
      if (worktreesFileWatchers.get(workspaceId) !== entry) return;
      if (content !== null) entry.lastContent = content;
      if (worktreesSelfWritesStarted(workspaceId) !== writesStarted) {
        scheduleChange(workspaceId, getWindow, onExternalSnapshot);
        return;
      }
      if (content !== null && isWorktreesSelfWriteContent(workspaceId, content))
        return;
      recordObservedWorktreesContent(workspaceId, content);
      if (content !== null) {
        const worktrees = parseWorktreesFileReconciliationSnapshot(content);
        if (worktrees !== null) {
          onExternalSnapshot?.(workspaceId, worktrees);
        }
      }
      const event: WorktreesFileChangedEvent = { workspaceId };
      sendToWindow(getWindow(), IPC_CHANNELS.worktreesFileChanged, event);
    })();
  }, WORKTREES_FILE_DEBOUNCE_MS);
}

function startWatcher(
  workspaceId: string,
  getWindow: () => BrowserWindow | null,
  onExternalSnapshot?: (
    workspaceId: string,
    worktrees: readonly WorktreeData[],
  ) => void,
  deliveredWorktrees?: readonly WorktreeData[],
): void {
  const filePath = w5RecordReadPaths.worktrees(workspaceId);
  const filenameToWatch = basename(filePath);
  const entry: WorktreesFileWatcherEntry = {
    watcher: null,
    debounceTimer: null,
    lastContent: null,
    readInFlight: null,
  };
  worktreesFileWatchers.set(workspaceId, entry);
  try {
    entry.watcher = createWorktreeWatch({
      path: dirname(filePath),
      label: `worktrees:${workspaceId}`,
      onChange: (_event, filename) => {
        if (filename && filename.toString() !== filenameToWatch) return;
        scheduleChange(workspaceId, getWindow, onExternalSnapshot);
      },
      poll: async () => {
        const content = await readContent(entry, workspaceId);
        if (
          worktreesFileWatchers.get(workspaceId) !== entry ||
          content === null
        )
          return;
        if (content === entry.lastContent) return;
        entry.lastContent = content;
        if (isWorktreesSelfWriteContent(workspaceId, content)) return;
        scheduleChange(workspaceId, getWindow, onExternalSnapshot);
      },
      onFatal: () => {
        closeWatcher(entry);
        if (worktreesFileWatchers.get(workspaceId) === entry)
          worktreesFileWatchers.delete(workspaceId);
      },
    });
    // Seed a content baseline so unchanged polling cannot reload the sidebar.
    // Content the renderer may not hold (e.g. a CLI write whose event fired
    // before this watch existed) is announced like any outside change.
    startWorktreesContentTracking(workspaceId, deliveredWorktrees);
    void readContent(entry, workspaceId).then((content) => {
      if (worktreesFileWatchers.get(workspaceId) !== entry) return;
      entry.lastContent = content;
      if (!seedWorktreesContentBaseline(workspaceId, content))
        scheduleChange(workspaceId, getWindow, onExternalSnapshot);
    });
  } catch (error) {
    worktreesFileWatchers.delete(workspaceId);
    throw error;
  }
}

export function syncWorktreesFileWatchers(
  items: SidebarItem[],
  getWindow: () => BrowserWindow | null,
  preserveWorkspaceIds: ReadonlySet<string> = new Set(),
  onExternalSnapshot?: (
    workspaceId: string,
    worktrees: readonly WorktreeData[],
  ) => void,
  /** True when `items` is the snapshot the renderer receives. */
  itemsDelivered = false,
): void {
  const watchedItems = new Map(
    items
      .filter((item) => item.type !== 'cowork')
      .map((item) => [item.id, item]),
  );
  const workspaceIds = new Set(watchedItems.keys());

  for (const [workspaceId, entry] of Array.from(
    worktreesFileWatchers.entries(),
  )) {
    if (
      !workspaceIds.has(workspaceId) &&
      !preserveWorkspaceIds.has(workspaceId)
    ) {
      closeWatcher(entry);
      worktreesFileWatchers.delete(workspaceId);
      clearWorktreesSelfWriteTracking(workspaceId);
    }
  }

  for (const workspaceId of Array.from(workspaceIds)) {
    if (worktreesFileWatchers.has(workspaceId)) {
      continue;
    }
    try {
      startWatcher(
        workspaceId,
        getWindow,
        onExternalSnapshot,
        itemsDelivered ? watchedItems.get(workspaceId)?.worktrees : undefined,
      );
    } catch {
      // The workspace directory may disappear between the sidebar read and
      // watcher creation. A later projects sync will retry it.
    }
  }
}

export function stopWorktreesFileWatchers(): void {
  for (const [workspaceId, entry] of Array.from(
    worktreesFileWatchers.entries(),
  )) {
    closeWatcher(entry);
    clearWorktreesSelfWriteTracking(workspaceId);
  }
  worktreesFileWatchers.clear();
}
