import type {
  LocalMemoryConsolidationStatus,
  LocalMemoryDocument,
  LocalMemoryFileSummary,
  LocalMemoryRebuildResult,
  LocalMemoryScopeRequest,
  LocalMemorySnapshotRestoreResponse,
  LocalMemorySnapshotSummary,
  MemorySource,
  SearchHit,
} from '@canopy/desktop-shared/types';
import type { BoundaryClip } from '@canopy/memory-consolidation/boundary-truncation';
import type { ManualConsolidationOutcome } from './manual-consolidation-trigger';
import type { LocalMemoryNoteOrigin } from './replica-hooks';
import {
  localMemoryScopeDir,
  resolveLocalMemoryScope,
  type ResolvedLocalMemoryScope,
} from './scope-resolver';
import {
  readMemoryFile,
  readMemoryIndex,
  readRecentInboxNoteEntries,
  saveInboxNote,
  searchMemory,
  type RecentInboxNote,
} from './store';
import {
  readUsage,
  recordUsage,
  recordUsageSoon,
  seedEntry,
  usageEntryFor,
  type DeferredUsageKeys,
} from './usage';

/**
 * Local memory behind one interface shaped like the planned `core.memory.*`
 * operations (docs/planning/2026-10-27-cloud-memory-sync/README.md §3).
 * Callers name a scope, never a folder; each operation resolves its scope
 * through {@link resolveLocalMemoryScope}, so the same callers reach an
 * account replica once the sync engine creates one. Runs in Electron main,
 * in process; no operation is registered on a dispatcher yet.
 */
export interface LocalMemoryStore {
  /** Where the scope's files are (design §16.4). */
  resolve(scope: LocalMemoryScopeRequest): ResolvedLocalMemoryScope;
  /**
   * Saves a note into the inbox; its file key, or '' when not written.
   * Rejects with `LocalMemoryScopeReadOnlyError` or, when another process
   * took the scope's lock over first, `LocalMemoryScopeLockLostError`;
   * neither is retried. In a synced replica the note records `origin` and
   * is queued for sync (design §10.4).
   */
  saveNote(
    scope: LocalMemoryScopeRequest,
    note: {
      text: string;
      source: MemorySource;
      origin?: LocalMemoryNoteOrigin;
    },
  ): Promise<string>;
  search(
    scopes: readonly LocalMemoryScopeRequest[],
    query: string,
  ): Promise<SearchHit[]>;
  /** One file a search returned, clipped for a tool result. */
  readFile(
    scope: LocalMemoryScopeRequest,
    fileKey: string,
  ): Promise<string | undefined>;
  /** The index fitted to its limits, for recall. */
  readIndex(scope: LocalMemoryScopeRequest): Promise<BoundaryClip>;
  /** The newest inbox notes, fitted, for recall. */
  readRecentNotes(
    scope: LocalMemoryScopeRequest,
    budget?: { maxNotes?: number; maxCharsPerNote?: number },
  ): Promise<RecentInboxNote[]>;
  /** The scope's documents and notes with usage, for the Memory panel. */
  listDocuments(
    scope: LocalMemoryScopeRequest,
  ): Promise<LocalMemoryFileSummary[]>;
  readDocument(
    scope: LocalMemoryScopeRequest,
    fileKey: string,
  ): Promise<LocalMemoryDocument>;
  /** Replaces a whole document or note at the revision the caller read. */
  writeDocument(
    scope: LocalMemoryScopeRequest,
    request: {
      fileKey: string;
      revision: string;
      title?: string;
      body: string;
    },
  ): Promise<LocalMemoryDocument>;
  /** Deletes a topic or note at the revision the caller read. */
  deleteDocument(
    scope: LocalMemoryScopeRequest,
    request: { fileKey: string; revision: string },
  ): Promise<void>;
  /** Replaces (with `text`) or removes one list item of a document. */
  mutateItem(
    scope: LocalMemoryScopeRequest,
    request: {
      fileKey: string;
      itemId: string;
      revision: string;
      text?: string;
    },
  ): Promise<LocalMemoryDocument>;
  consolidationStatus(
    scope: LocalMemoryScopeRequest,
  ): Promise<LocalMemoryConsolidationStatus>;
  /**
   * A consolidation the user asked for, queued and recorded. Background
   * runs go through the scheduler, which resolves the scope the same way.
   */
  consolidateNow(
    scope: LocalMemoryScopeRequest,
  ): Promise<ManualConsolidationOutcome>;
  /** `precondition` runs under the scope's write lock before anything changes. */
  rebuild(
    scope: LocalMemoryScopeRequest,
    precondition?: () => Promise<void>,
  ): Promise<LocalMemoryRebuildResult>;
  listSnapshots(
    scope: LocalMemoryScopeRequest,
  ): Promise<LocalMemorySnapshotSummary[]>;
  restoreSnapshot(
    scope: LocalMemoryScopeRequest,
    snapshotId: string,
    precondition?: () => Promise<void>,
  ): Promise<LocalMemorySnapshotRestoreResponse>;
  /** Counts a use of each file now. */
  recordUsage(
    scope: LocalMemoryScopeRequest,
    fileKeys: string[],
  ): Promise<void>;
  /** Counts a use of each file in the next batch. */
  recordUsageSoon(
    scope: LocalMemoryScopeRequest,
    fileKeys: string[],
    deferredKeys?: DeferredUsageKeys,
  ): void;
  /** Starts a new file's usage row. */
  seedUsage(scope: LocalMemoryScopeRequest, fileKey: string): Promise<void>;
}

function dir(scope: LocalMemoryScopeRequest): string {
  return localMemoryScopeDir(scope);
}

/**
 * The scope's files with each one's usage count. Usage is advisory: while
 * tracking is unknown for the scope, or reading it fails, files carry none.
 */
async function listWithUsage(
  scopeDir: string,
): Promise<LocalMemoryFileSummary[]> {
  const { listLocalMemoryFiles } = await import('./explorer');
  const [files, usage] = await Promise.all([
    listLocalMemoryFiles(scopeDir),
    readUsage(scopeDir).catch(() => null),
  ]);
  if (!usage || usage.trackingSince === null) return files;
  return files.map((file) => {
    const entry = usageEntryFor(usage.entries, file.fileKey);
    return { ...file, usageCount: entry?.usageCount ?? 0 };
  });
}

// The explorer, snapshot, status and consolidation modules load on first
// use, keeping the turn path (save, search, recall) free of them. An
// explorer write resolves its scope before that load, and is bound to the
// replica it resolved while it waits for the scope's lock.
export const localMemoryStore: LocalMemoryStore = {
  resolve: resolveLocalMemoryScope,
  saveNote: (scope, note) =>
    saveInboxNote(() => resolveLocalMemoryScope(scope), note),
  search: (scopes, query) =>
    searchMemory(
      scopes.map((scope) => ({ scope: scope.scope, dir: dir(scope) })),
      query,
    ),
  readFile: (scope, fileKey) => readMemoryFile(dir(scope), fileKey),
  readIndex: (scope) => readMemoryIndex(dir(scope)),
  readRecentNotes: (scope, budget) =>
    readRecentInboxNoteEntries(dir(scope), budget),
  listDocuments: (scope) => listWithUsage(dir(scope)),
  readDocument: async (scope, fileKey) => {
    const { readLocalMemoryDocument } = await import('./explorer');
    return readLocalMemoryDocument(dir(scope), fileKey);
  },
  writeDocument: async (scope, request) => {
    const target = resolveLocalMemoryScope(scope);
    const { updateLocalMemoryFile } = await import('./explorer');
    return updateLocalMemoryFile(target, request);
  },
  deleteDocument: async (scope, request) => {
    const target = resolveLocalMemoryScope(scope);
    const { deleteLocalMemoryFile } = await import('./explorer');
    return deleteLocalMemoryFile(target, request);
  },
  mutateItem: async (scope, request) => {
    const target = resolveLocalMemoryScope(scope);
    const { mutateLocalMemoryItem } = await import('./explorer');
    return mutateLocalMemoryItem(target, request);
  },
  consolidationStatus: async (scope) => {
    const { readLocalMemoryConsolidationStatus } =
      await import('./consolidation-status');
    return readLocalMemoryConsolidationStatus(dir(scope));
  },
  consolidateNow: async (scope) => {
    const { runManualLocalMemoryConsolidation } =
      await import('./manual-consolidation-trigger');
    return runManualLocalMemoryConsolidation(scope);
  },
  rebuild: async (scope, precondition) => {
    const { runManualLocalMemoryRebuild } =
      await import('./manual-consolidation-trigger');
    return runManualLocalMemoryRebuild(scope, precondition);
  },
  listSnapshots: async (scope) => {
    const { listLocalMemorySnapshots } = await import('./snapshots');
    return listLocalMemorySnapshots(dir(scope));
  },
  restoreSnapshot: async (scope, snapshotId, precondition) => {
    const { restoreManualLocalMemorySnapshot } =
      await import('./manual-consolidation-trigger');
    return restoreManualLocalMemorySnapshot(scope, snapshotId, precondition);
  },
  recordUsage: (scope, fileKeys) => recordUsage(dir(scope), fileKeys),
  recordUsageSoon: (scope, fileKeys, deferredKeys) => {
    recordUsageSoon(dir(scope), fileKeys, deferredKeys);
  },
  seedUsage: (scope, fileKey) => seedEntry(dir(scope), fileKey),
};
