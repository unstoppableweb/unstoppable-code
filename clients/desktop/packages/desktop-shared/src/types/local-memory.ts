export interface MemorySource {
  provider: string;
  chatId: string;
  sessionId?: string;
}

export interface SearchHit {
  fileKey: string;
  scope: 'user' | 'workspace';
  snippet: string;
  heading?: string;
  /** Rebuild source retained after consolidation; ranked after live memory. */
  archived?: boolean;
  /** Original creation time, or preserved file mtime for legacy notes/imports. */
  savedAt?: string;
}

export type LocalMemoryScopeRequest =
  | { scope: 'user' }
  | { scope: 'workspace'; workspaceId: string };

export interface LocalMemoryFileSummary {
  fileKey: string;
  kind: 'index' | 'topic' | 'inbox';
  modifiedAt: string;
  sizeBytes: number;
  /** First-line ATX level-1 heading text, when the file starts with one. */
  title?: string;
  /** First line of the body after the title, plain text and clipped. */
  excerpt?: string;
  /** The chat that saved an inbox note, from its front matter. */
  source?: { provider: string; chatId: string };
  /** The computer a synced inbox note was saved on, from its front matter. */
  deviceLabel?: string;
  /**
   * Times agents used this file (searches, reads and injected recall), while
   * usage tracking is intact for the scope. Absent when usage is unknown.
   */
  usageCount?: number;
}

export interface LocalMemoryItem {
  id: string;
  kind: 'heading' | 'list-item' | 'paragraph' | 'code' | 'block';
  text: string;
  level?: number;
  children: LocalMemoryItem[];
}

export interface LocalMemoryDocument {
  fileKey: string;
  revision: string;
  items: LocalMemoryItem[];
  /** The file's Markdown after its front matter, as written. */
  markdown?: string;
}

export type LocalMemoryReadRequest = LocalMemoryScopeRequest & {
  fileKey: string;
};
export type LocalMemoryDeleteRequest = LocalMemoryReadRequest & {
  itemId: string;
  revision: string;
};
export type LocalMemoryUpdateRequest = LocalMemoryDeleteRequest & {
  text: string;
};
/** Deletes a whole topic or inbox note; the index cannot be deleted. */
export type LocalMemoryDeleteFileRequest = LocalMemoryReadRequest & {
  revision: string;
};
/**
 * Replaces a memory file's Markdown body. Front matter is kept, and `title`
 * becomes the level-1 heading that starts the body when given.
 */
export type LocalMemoryUpdateFileRequest = LocalMemoryDeleteFileRequest & {
  title?: string;
  body: string;
};

export type LocalMemoryConsolidationResult =
  | 'success'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export interface LocalMemoryConsolidationStatus {
  /** Top-level `inbox/*.md` notes not yet folded into the index. */
  pendingNotes: number;
  running: boolean;
  /** True while a rebuild owns the scope; `running` is true as well. */
  rebuilding: boolean;
  /** When the last consolidation run of any outcome finished. */
  lastRunAt: string | null;
  lastResult: LocalMemoryConsolidationResult | null;
  /** Skip/failure reason, or the user-facing message for a blocked model. */
  lastReason: string | null;
  /** When the last successful consolidation rewrote the index. */
  lastConsolidatedAt: string | null;
}

export interface LocalMemoryRebuildResult {
  /**
   * `completed`: nothing is left pending. `stopped`: a consolidation run did
   * not succeed or stopped making progress, so pending sources remain queued.
   * `failed`: the rebuild could not prepare the scope. `skipped`: nothing ran.
   */
  status: 'completed' | 'stopped' | 'failed' | 'skipped';
  reason?: string;
  /** Snapshot taken before the rebuild changed anything, when one was taken. */
  snapshotId: string | null;
  restoredInboxNotes: number;
  restoredImports: number;
  /** Consolidation runs the rebuild performed. */
  runs: number;
}

export interface LocalMemoryRebuildResponse {
  rebuild: LocalMemoryRebuildResult;
  status: LocalMemoryConsolidationStatus;
}

/** `sync`: taken before a synced replica applies a pulled revision. */
export type LocalMemorySnapshotReason =
  | 'consolidation'
  | 'rebuild'
  | 'restore'
  | 'sync';

export interface LocalMemorySnapshotSummary {
  id: string;
  createdAt: string;
  reason: LocalMemorySnapshotReason;
  /** Topic files captured alongside the index. */
  topicCount: number;
}

export type LocalMemorySnapshotRestoreRequest = LocalMemoryScopeRequest & {
  snapshotId: string;
};

export interface LocalMemorySnapshotRestoreResponse {
  status: 'restored' | 'skipped';
  reason?: string;
  /** Snapshot of the state the restore replaced, when one was taken. */
  previousSnapshotId: string | null;
}

export {
  LOCAL_MEMORY_FULL_SENTENCE_REASONS,
  LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
  LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
} from '@canopy/protocol/local-memory';
