import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MEMORY_SYNC_LIMITS,
  MEMORY_SYNC_STATE_FILENAME,
  type MemoryDocumentChange,
  type MemoryUsageAggregate,
} from '@canopy/protocol/memory-sync';
import type { MemoryConsolidationResult } from '@canopy/memory-consolidation/run';
import type { MemoryConsolidationMeasurement } from '@canopy/protocol/local-memory/metrics';
import { isNodeError } from '@canopy/memory-store/memory-files';

/*
 * How local memory writes reach the memory sync engine. The engine installs
 * these hooks; without them (every build until sync is on, and every
 * device-local scope) a write is only a file write. Note hooks run inside the
 * writer's scope lock, before the file changes, so the queued operation and
 * the file can never disagree after a crash (design §10.2, §10.3).
 */

export interface LocalMemoryNoteOrigin {
  projectId?: string;
  organizationId?: string;
}

export type LocalMemoryNoteChange =
  /** A new note: `content` is the file about to be written. */
  | { kind: 'put'; fileKey: string; content: string }
  /** An edited note: `content` replaces `previousContent` at `fileKey`. */
  | {
      kind: 'replace';
      fileKey: string;
      previousContent: string;
      content: string;
    }
  /** A deleted note: `content` is the file about to be removed. */
  | { kind: 'tombstone'; fileKey: string; content: string };

/**
 * A writer found its folder no longer a synced replica (its account signed
 * out or sync turned off) after it decided to queue a change there, so it
 * writes nothing rather than a change the outbox never sends.
 */
export class LocalMemoryReplicaUnavailableError extends Error {
  constructor() {
    super('Memory changed since you opened it. Refresh and try again.');
    this.name = 'LocalMemoryReplicaUnavailableError';
  }
}

/** Why sync cannot carry a note as edited. */
export type LocalMemoryNoteUnsyncableReason = 'too_large' | 'empty' | 'invalid';

const UNSYNCABLE_NOTE_MESSAGES: Record<
  LocalMemoryNoteUnsyncableReason,
  string
> = {
  too_large: `This note is too large to sync. Shorten it to ${MEMORY_SYNC_LIMITS.noteBodyMaxBytes / 1024} KiB or less and try again.`,
  empty: "This note can't sync without any text. Add text, or delete the note.",
  invalid: "This note can't sync as edited. Change it and try again.",
};

/**
 * An edit of a synced note that sync cannot carry, refused before anything
 * changes: accepting it would leave the edit on this device and the note it
 * replaced in the cloud.
 */
export class LocalMemoryNoteUnsyncableError extends Error {
  constructor(readonly reason: LocalMemoryNoteUnsyncableReason) {
    super(UNSYNCABLE_NOTE_MESSAGES[reason]);
    this.name = 'LocalMemoryNoteUnsyncableError';
  }
}

/** How a leased commit of a consolidation run ended. */
export type LocalMemorySyncedCommitOutcome =
  /** The cloud accepted it and the replica applied it. */
  | 'committed'
  /**
   * Memory changed meanwhile (another commit, a consumed note, a use of a
   * pruned topic): run again.
   */
  | 'changed'
  /** The lease is gone: drop the output. */
  | 'lost'
  /** The cloud refused it as it is; the same output would be refused again. */
  | 'refused';

/**
 * A note the cloud holds as pending, by the file key it is read from: its ID
 * and, for an import, the hash of the body the cloud holds.
 */
export interface LocalMemorySyncedNote {
  noteId: string;
  contentHash: string | null;
}

/**
 * A consolidation run of a synced replica, held under the scope's lease
 * (design §11, §12.1). The run reads the replica as today; only its apply
 * differs: the plan becomes document changes committed to the cloud.
 */
export interface LocalMemorySyncedConsolidation {
  /** The notes and imports the cloud holds as pending: only these may be consumed. */
  consumable: ReadonlyMap<string, LocalMemorySyncedNote>;
  /** The same listing read again now, to check a run's inputs before it commits. */
  listConsumable(): Promise<ReadonlyMap<string, LocalMemorySyncedNote>>;
  /** The scope's usage across devices, from the lease grant (design §15). */
  usage: MemoryUsageAggregate;
  /** False once the lease is lost or past its hard cap. */
  shouldContinue(): boolean;
  commit(request: {
    consolidation: MemoryConsolidationMeasurement;
    changes: MemoryDocumentChange[];
    consumedNoteIds: string[];
    /**
     * The topics `changes` deletes as unused. The cloud refuses the commit
     * (`changed`) when any was used after the usage aggregate was read.
     */
    prunedTopicPaths: string[];
    model: { modelId: string; thinkingLevel?: string } | null;
    inputHash: string | null;
    /**
     * Whether everything the run read is still as it read it, checked just
     * before the commit is sent; false drops the run as `changed`.
     */
    inputsCurrent: () => Promise<boolean>;
  }): Promise<LocalMemorySyncedCommitOutcome>;
}

export interface LocalMemoryReplicaHooks {
  /**
   * Front matter a note saved into `scopeDir` carries (its device), or null
   * when the folder is not a synced replica.
   */
  noteFields(scopeDir: string): Readonly<Record<string, string>> | null;
  /**
   * The account whose synced replica `scopeDir` is now, or null when the
   * folder is not one (signed out, sync off or never a replica).
   */
  replicaAccountId(scopeDir: string): string | null;
  /**
   * Queues the change; the caller holds the scope's write lock. Rejects with
   * {@link LocalMemoryReplicaUnavailableError} when `scopeDir` is no longer
   * a synced replica, and with {@link LocalMemoryNoteUnsyncableError}, before
   * writing anything, for an edit of a synced note that sync cannot carry.
   */
  queueNoteChange(
    scopeDir: string,
    change: LocalMemoryNoteChange,
  ): Promise<void>;
  /**
   * Finishes the deletes and edits a crash or failure cut short in
   * `scopeDir`; the caller holds the scope's write lock, and calls it before
   * reading a note it changes, so no change builds on a note whose last
   * change is not on disk yet.
   */
  settleNoteChanges(scopeDir: string): Promise<void>;
  /** Drops a queued new note whose file could not be written. */
  dropNoteChange(scopeDir: string, noteId: string): Promise<void>;
  /** After a note or document write and its lock: the engine syncs soon. */
  noteChanged(scopeDir: string): void;
  /** Uses counted in `usage.json`, added to the scope's usage deltas. */
  usageRecorded(
    scopeDir: string,
    counts: ReadonlyMap<string, number>,
    usedAt: string,
  ): void;
  /**
   * Runs `run` holding the scope's consolidation lease. Resolves `run`'s
   * result, or a cancelled one when the lease cannot be taken now.
   */
  runSyncedConsolidation(
    scopeDir: string,
    reason: 'scheduled' | 'manual',
    run: (
      consolidation: LocalMemorySyncedConsolidation,
    ) => Promise<MemoryConsolidationResult>,
  ): Promise<MemoryConsolidationResult>;
}

let hooks: LocalMemoryReplicaHooks | null = null;

export function setLocalMemoryReplicaHooks(
  next: LocalMemoryReplicaHooks | null,
): void {
  hooks = next;
}

export function localMemoryReplicaHooks(): LocalMemoryReplicaHooks | null {
  return hooks;
}

/**
 * Rejects a write into a synced replica that stopped syncing for the account
 * it was resolved as (a sign-out, an account switch or sync turned off while
 * the write waited for the lock): written now, the change would stay on this
 * device without the engine that commits or sends it. `accountId` is null
 * for device-local memory, which needs no check.
 */
export function assertReplicaStillSyncing(target: {
  dir: string;
  accountId: string | null;
}): void {
  if (
    target.accountId !== null &&
    hooks?.replicaAccountId(target.dir) !== target.accountId
  ) {
    throw new LocalMemoryReplicaUnavailableError();
  }
}

/**
 * Whether `scopeDir` is an account replica: one the sync engine keeps in step
 * now, or one with a sync state while no engine runs for its account (signed
 * out, another account signed in, sync off). Only cloud commits change a
 * replica's documents, so a caller that resolved the folder earlier never
 * consolidates it locally once its engine has stopped.
 */
export async function isSyncedMemoryReplica(
  scopeDir: string,
): Promise<boolean> {
  if (hooks?.noteFields(scopeDir) != null) return true;
  try {
    await lstat(join(scopeDir, MEMORY_SYNC_STATE_FILENAME));
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}
