import { join } from 'node:path';
import {
  memoryDocumentIdentity,
  type MemoryConflictReason,
} from '@canopy/protocol/memory-sync';
import {
  recordMemoryEdit,
  withMemoryWriteLock,
} from '../local/edit-coordination';
import {
  readMemoryFile,
  replaceMemoryFileIfUnchanged,
  sameMemoryFileContent,
  type MemoryFileContent,
} from '../local/memory-files';
import {
  readMemoryConflictSide,
  type MemoryConflictSide,
} from './conflict-notes';
import { readMemorySyncState, writeMemorySyncState } from './replica-files';
import { removeMemoryFile } from './replica-writer';

/*
 * The merged edits view's reads and writes (design §13.2). A conflict
 * resolves itself: the cloud version stays live, this device's version is
 * kept under `.sync/conflicts/` (at the `oursFile` its entry records) and
 * goes to the next consolidation as inbox notes. Nothing waits on the
 * person. They may look at the kept copy, restore it as a manual edit, or
 * dismiss the entry; the kept copy is never deleted.
 */

export interface MemoryReplicaConflictView {
  path: string;
  detectedAt: string;
  reason: MemoryConflictReason;
  /** Its notes are queued for the next consolidation. */
  merged: boolean;
  /** The cloud version, live now. */
  cloud: MemoryConflictSide;
  /** This device's version. */
  mine: MemoryConflictSide;
}

function sameDocument(left: string, right: string): boolean {
  return memoryDocumentIdentity(left) === memoryDocumentIdentity(right);
}

function latestConflict<Entry extends { path: string }>(
  conflicts: readonly Entry[],
  path: string,
): Entry | undefined {
  return [...conflicts]
    .reverse()
    .find((entry) => sameDocument(entry.path, path));
}

/** The latest conflict on `path`, with both versions, or null. */
export async function readReplicaConflict(
  scopeDir: string,
  path: string,
): Promise<MemoryReplicaConflictView | null> {
  const state = await readMemorySyncState(scopeDir);
  if (state === undefined || state === null) return null;
  const conflict = latestConflict(state.conflicts, path);
  if (conflict === undefined) return null;
  return {
    path: conflict.path,
    detectedAt: conflict.detectedAt,
    reason: conflict.reason,
    merged: conflict.autoNotesQueued === true,
    cloud: await readMemoryConflictSide(join(scopeDir, conflict.path)),
    mine:
      conflict.oursDeleted === true
        ? { kind: 'deleted' }
        : await readMemoryConflictSide(join(scopeDir, conflict.oursFile)),
  };
}

/** How {@link settleReplicaConflict} ended. */
export type MemoryReplicaConflictSettlement =
  | 'settled'
  | 'not_found'
  /** The live document changed while it was replaced: nothing was written. */
  | 'changed';

/**
 * Settles the entries on `path` in the scope's write lock, after
 * `assertKept` confirms the replica still syncs for the account it was
 * resolved for. `restore` puts this device's kept version back live, or
 * removes the live document when this device had deleted it, only while the
 * live document still holds what was read under the lock; the next pass
 * commits it as a manual edit. Either way the entries go and the kept copy
 * stays.
 */
export function settleReplicaConflict(
  scopeDir: string,
  path: string,
  action: 'restore' | 'dismiss',
  assertKept: () => void,
): Promise<MemoryReplicaConflictSettlement> {
  return withMemoryWriteLock(scopeDir, async () => {
    assertKept();
    const state = await readMemorySyncState(scopeDir);
    if (state === undefined || state === null) return 'not_found';
    const conflict = latestConflict(state.conflicts, path);
    if (conflict === undefined) return 'not_found';
    if (action === 'restore') {
      const live = join(scopeDir, conflict.path);
      const deleted = conflict.oursDeleted === true;
      // The kept copy's own bytes go back, whatever they decode to: a
      // decode replaces bytes that are not UTF-8 with U+FFFD, and writing
      // that back would overwrite the person's file with the replacement.
      const mine: MemoryFileContent | null = deleted
        ? null
        : await readMemoryFile(join(scopeDir, conflict.oursFile));
      if (!deleted && mine === null) return 'not_found';
      const current = await readMemoryFile(live);
      const unchanged = async (): Promise<boolean> =>
        sameMemoryFileContent(await readMemoryFile(live), current);
      await recordMemoryEdit(scopeDir);
      const written =
        mine === null
          ? current === null ||
            (await removeMemoryFile(scopeDir, live, unchanged))
          : await replaceMemoryFileIfUnchanged(
              scopeDir,
              live,
              mine.bytes,
              unchanged,
            );
      if (!written) return 'changed';
    }
    state.conflicts = state.conflicts.filter(
      (entry) => !sameDocument(entry.path, path),
    );
    await writeMemorySyncState(scopeDir, state);
    return 'settled';
  });
}
