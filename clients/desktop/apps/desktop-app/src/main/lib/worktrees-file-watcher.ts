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
  wasRecentWorktreesSelfWrite,
} from './workspace-persistence';
import { sendToWindow } from './window-send';

interface WorktreesFileWatcherEntry {
  watcher: WorktreeWatch | null;
  lastContent: string | null;
  readInFlight: Promise<string | null> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /**
   * True when any event in the current debounce batch arrived with no recent
   * desktop self-write — such an event is definitely external, so the batch
   * must emit even if a later desktop read-modify-write leaves the file
   * byte-identical to the last self-write (the CLI-append-then-poller-persist
   * coalescing case: the external change is absorbed into the self-write and
   * a pure content compare would wrongly classify the batch as an echo).
   */
  sawExternalEvent: boolean;
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
      // Suppress pure self-write echoes: if the file on disk is byte-identical
      // to what this process last wrote, the event carries no new information
      // (main-initiated writes already reach the renderer via their own IPC
      // events), and refreshing anyway turns every desktop persist — e.g. the
      // GitHub poller writing lastKnownPrStatus — into a projects reload that
      // re-syncs pollers and churns the sidebar. Only genuinely external
      // content (the CLI adding a worktree) emits the refresh event.
      // The read intentionally bypasses the persistence layer's write locks: a
      // torn/partial read simply fails the compare and emits (the fail-open
      // direction), and a true self-write settles to a matching read on the
      // next debounce.
      const content = await readContent(entry, workspaceId, true);
      if (worktreesFileWatchers.get(workspaceId) !== entry) return;
      if (content !== null) entry.lastContent = content;
      const sawExternalEvent = entry.sawExternalEvent;
      entry.sawExternalEvent = false;
      if (
        !sawExternalEvent &&
        content !== null &&
        isWorktreesSelfWriteContent(workspaceId, content)
      ) {
        return;
      }
      if (sawExternalEvent || content !== null) {
        // External content observed: the retained fingerprint now describes
        // "the last thing the desktop ever wrote", not a write this echo could
        // belong to. Forget it so a later byte-exact external revert (desktop
        // A → CLI B → CLI A) is not misclassified as a self-write echo.
        clearWorktreesSelfWriteTracking(workspaceId);
      }
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
): void {
  const filePath = w5RecordReadPaths.worktrees(workspaceId);
  const filenameToWatch = basename(filePath);
  const entry: WorktreesFileWatcherEntry = {
    watcher: null,
    debounceTimer: null,
    sawExternalEvent: false,
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
        if (!wasRecentWorktreesSelfWrite(workspaceId))
          entry.sawExternalEvent = true;
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
        entry.sawExternalEvent = true;
        scheduleChange(workspaceId, getWindow, onExternalSnapshot);
      },
      onFatal: () => {
        closeWatcher(entry);
        if (worktreesFileWatchers.get(workspaceId) === entry)
          worktreesFileWatchers.delete(workspaceId);
      },
    });
    // Seed a content baseline so unchanged polling cannot reload the sidebar.
    void readContent(entry, workspaceId).then((content) => {
      if (worktreesFileWatchers.get(workspaceId) === entry)
        entry.lastContent = content;
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
): void {
  const workspaceIds = new Set(
    items.filter((item) => item.type !== 'cowork').map((item) => item.id),
  );

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
      startWatcher(workspaceId, getWindow, onExternalSnapshot);
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
