/**
 * Per-worktree panel-layout persistence (Phase 5).
 *
 * Mirrors the terminal drawer persistence template
 * (`../terminal/persistence.ts`): versioned JSON file under
 * `workspaces/{workspaceId}/worktree-data/{worktreeId}/panel-layout.json`,
 * synchronous debounced writes (100ms), mkdir-before-write, never-throw
 * reads, and a synchronous flush-all hook wired into app shutdown.
 *
 * Validation posture: saves run through `migratePanelLayout` from
 * `@canopy/protocol/panels` so a bad writer cannot clobber the last good file.
 * Loads return raw parsed JSON because the renderer must migrate historical
 * unbound Browser placeholders before the current validator can accept them;
 * the renderer then validates the transformed layout before restoring it.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  migratePanelLayout,
  type SerializablePanelLayoutFile,
} from '@canopy/protocol/panels';
import {
  captureDirectoryEffects,
  directoryEffectsAdmitted,
  type DirectoryEffectAdmission,
} from '../lib/directory-effect-admission';
import { getWorktreePanelLayoutFilePath } from '../lib/paths';

const WORKTREE_WRITE_DEBOUNCE_MS = 100;

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

interface PendingPanelLayoutWrite {
  filePath: string;
  admission: DirectoryEffectAdmission;
  layout: SerializablePanelLayoutFile & { readonly hasUserChanges: boolean };
  timer: ReturnType<typeof setTimeout>;
}

export class PanelLayoutPersistenceStore {
  private readonly pendingWrites = new Map<string, PendingPanelLayoutWrite>();

  /**
   * Loads raw parsed layout JSON for a worktree, or `null` when the file is
   * missing, unreadable, or invalid JSON. Validation intentionally happens in
   * the renderer after its legacy Browser placeholder migration. A save still
   * pending in the debounce window is returned directly so load-after-save is
   * consistent.
   */
  public loadWorktreeLayout(projectId: string, worktreeId: string): unknown {
    const pending = this.pendingWrites.get(worktreeKey(projectId, worktreeId));
    if (pending) {
      return pending.layout;
    }

    const filePath = getWorktreePanelLayoutFilePath(projectId, worktreeId);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
    return parsed;
  }

  /**
   * Schedules a debounced synchronous write of the layout file. Invalid
   * layouts (anything `migratePanelLayout` rejects) are dropped so a bad
   * writer can never clobber the last good file on disk.
   */
  public saveWorktreeLayout(
    projectId: string,
    worktreeId: string,
    layout: SerializablePanelLayoutFile,
    hasUserChanges = true,
  ): void {
    const validated = migratePanelLayout(layout);
    if (validated === null) {
      return;
    }

    const key = worktreeKey(projectId, worktreeId);
    this.clearPendingWrite(key);
    const filePath = getWorktreePanelLayoutFilePath(projectId, worktreeId);
    const admission = captureDirectoryEffects(dirname(filePath));
    if (!directoryEffectsAdmitted(admission)) return;
    this.pendingWrites.set(key, {
      admission,
      filePath,
      layout: { ...validated, hasUserChanges },
      timer: setTimeout((): void => {
        this.flushWorktreeSync(key);
      }, WORKTREE_WRITE_DEBOUNCE_MS),
    });
  }

  /** Cancels any pending write and removes the persisted layout file. */
  public deleteWorktreeLayout(projectId: string, worktreeId: string): void {
    this.clearPendingWrite(worktreeKey(projectId, worktreeId));
    rmSync(getWorktreePanelLayoutFilePath(projectId, worktreeId), {
      force: true,
    });
  }

  /**
   * Drops a write still in its debounce window without touching the file, for
   * callers that are about to remove the worktree's data directory themselves.
   */
  public cancelPendingWrite(projectId: string, worktreeId: string): void {
    this.clearPendingWrite(worktreeKey(projectId, worktreeId));
  }

  /** Synchronously flushes every pending write (app-quit / fatal-exit hook). */
  public flushAllSync(): void {
    for (const key of Array.from(this.pendingWrites.keys())) {
      this.flushWorktreeSync(key);
    }
  }

  private clearPendingWrite(key: string): void {
    const existing = this.pendingWrites.get(key);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
      this.pendingWrites.delete(key);
    }
  }

  private flushWorktreeSync(key: string): void {
    const pending = this.pendingWrites.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingWrites.delete(key);
    if (!directoryEffectsAdmitted(pending.admission)) return;
    mkdirSync(dirname(pending.filePath), { recursive: true });
    writeFileSync(
      pending.filePath,
      JSON.stringify(pending.layout, null, 2),
      'utf8',
    );
  }
}

export const panelLayoutPersistenceStore = new PanelLayoutPersistenceStore();
