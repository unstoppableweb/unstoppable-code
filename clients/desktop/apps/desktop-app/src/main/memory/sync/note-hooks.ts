import {
  MEMORY_SYNC_LIMITS,
  type MemoryDeviceRef,
  type MemoryNoteOp,
} from '@canopy/protocol/memory-sync';
import { memoryNoteId } from '@canopy/memory-store/note-identity';
import {
  LocalMemoryNoteUnsyncableError,
  LocalMemoryReplicaUnavailableError,
  type LocalMemoryNoteChange,
  type LocalMemoryNoteUnsyncableReason,
  type LocalMemoryReplicaHooks,
} from '../local/replica-hooks';
import { inboxNoteBody, inboxNoteToWire } from './note-records';
import {
  dropQueuedMemoryNoteOp,
  keepMemoryNoteEditLocal,
  markMemoryNotesLocalOnly,
  queueMemoryNoteOp,
  settleMemoryLocalChanges,
  type MemoryRetiredNoteFile,
} from './outbox';
import { readMemorySyncState } from './replica-files';
import type { MemoryReplicaRegistry } from './replica-registry';

/*
 * The local store's note writes, turned into outbox operations for the
 * replicas the registry knows (design §10.2, §10.3). A note that cannot
 * travel (no ID, no body) stays on this device as a local-only note, so a
 * later snapshot never moves it aside, and so does every edit of a note that
 * already stays here. An edit that would make a synced note one that cannot
 * travel is refused instead: the cloud would keep the note it replaced.
 */

function noteOp(
  change: LocalMemoryNoteChange,
  device: MemoryDeviceRef,
  now: Date,
): MemoryNoteOp | null {
  if (change.kind === 'tombstone') {
    const noteId = memoryNoteId(change.content);
    return noteId === null
      ? null
      : { op: 'tombstone', noteId, deletedAt: now.toISOString() };
  }
  const note = inboxNoteToWire({
    fileKey: change.fileKey,
    content: change.content,
    modifiedMs: now.getTime(),
    thisDevice: device,
  });
  if (note === null) return null;
  return change.kind === 'replace' && note.supersedes !== undefined
    ? { op: 'replace', note }
    : { op: 'put', note };
}

/**
 * Whether the note an edit replaces syncs: it can travel and is not kept on
 * this device only. An unreadable sync state counts as syncing.
 */
async function replacesSyncedNote(
  scopeDir: string,
  change: Extract<LocalMemoryNoteChange, { kind: 'replace' }>,
  device: MemoryDeviceRef,
  now: Date,
): Promise<boolean> {
  const previous = noteOp(
    { kind: 'put', fileKey: change.fileKey, content: change.previousContent },
    device,
    now,
  );
  const previousId = memoryNoteId(change.previousContent);
  if (previous === null || previousId === null) return false;
  const state = await readMemorySyncState(scopeDir);
  return !(state?.localOnlyNoteIds.includes(previousId) ?? false);
}

/** The file a change removes or replaces, as it read it. */
function retiredFile(
  change: LocalMemoryNoteChange,
): MemoryRetiredNoteFile | null {
  switch (change.kind) {
    case 'put':
      return null;
    case 'replace':
      return {
        fileKey: change.fileKey,
        content: change.previousContent,
        replacement: change.content,
      };
    case 'tombstone':
      return { fileKey: change.fileKey, content: change.content };
  }
}

function unsyncableReason(content: string): LocalMemoryNoteUnsyncableReason {
  const body = inboxNoteBody(content);
  if (body === null) return 'invalid';
  if (Buffer.byteLength(body, 'utf8') > MEMORY_SYNC_LIMITS.noteBodyMaxBytes) {
    return 'too_large';
  }
  return body === '' ? 'empty' : 'invalid';
}

export function createMemoryReplicaHooks(
  registry: MemoryReplicaRegistry,
  now: () => Date = () => new Date(),
): LocalMemoryReplicaHooks {
  return {
    noteFields(scopeDir) {
      const entry = registry.entryForDir(scopeDir);
      return entry === null
        ? null
        : { device: entry.device.deviceId, deviceLabel: entry.device.label };
    },
    replicaAccountId(scopeDir) {
      return registry.entryForDir(scopeDir)?.accountId ?? null;
    },
    async queueNoteChange(scopeDir, change) {
      const entry = registry.entryForDir(scopeDir);
      if (entry === null) throw new LocalMemoryReplicaUnavailableError();
      const at = now();
      const noteId = memoryNoteId(change.content);
      const synced =
        change.kind !== 'replace' ||
        (await replacesSyncedNote(scopeDir, change, entry.device, at));
      const op = synced ? noteOp(change, entry.device, at) : null;
      if (op !== null) {
        await queueMemoryNoteOp(
          scopeDir,
          entry.binding,
          op,
          at,
          retiredFile(change),
        );
        return;
      }
      if (change.kind === 'tombstone' || noteId === null) return;
      if (change.kind !== 'replace') {
        await markMemoryNotesLocalOnly(scopeDir, [noteId]);
        return;
      }
      if (synced) {
        throw new LocalMemoryNoteUnsyncableError(
          unsyncableReason(change.content),
        );
      }
      const previousId = memoryNoteId(change.previousContent);
      if (previousId === null) {
        await markMemoryNotesLocalOnly(scopeDir, [noteId]);
        return;
      }
      await keepMemoryNoteEditLocal(scopeDir, entry.binding, {
        noteId: previousId,
        fileKey: change.fileKey,
        previousContent: change.previousContent,
        replacementId: noteId,
        content: change.content,
      });
    },
    async settleNoteChanges(scopeDir) {
      if (registry.entryForDir(scopeDir) === null) return;
      await settleMemoryLocalChanges(scopeDir, now());
    },
    async dropNoteChange(scopeDir, noteId) {
      const entry = registry.entryForDir(scopeDir);
      if (entry === null) return;
      await dropQueuedMemoryNoteOp(scopeDir, entry.binding, noteId);
    },
    noteChanged(scopeDir) {
      registry.entryForDir(scopeDir)?.onLocalChange();
    },
    usageRecorded(scopeDir, counts, usedAt) {
      registry.entryForDir(scopeDir)?.recordUsage(counts, usedAt);
    },
    runSyncedConsolidation(scopeDir, reason, run) {
      const entry = registry.entryForDir(scopeDir);
      return entry === null
        ? Promise.resolve({ status: 'cancelled', reason: 'cancelled' })
        : entry.runConsolidation(reason, run);
    },
  };
}
