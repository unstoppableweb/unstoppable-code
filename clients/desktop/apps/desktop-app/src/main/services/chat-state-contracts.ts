import type {
  ChatJournalRecord,
  ChatStateLoadError,
  ChatStateChange,
  PersistedCommandReceipt,
} from '@canopy/desktop-shared/types';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { PersistedToolOutputReference } from '@canopy/agent-transcript/types';
import type { TranscriptStreamDescriptor } from '@canopy/protocol/canopy-core';
import type { CanonicalChatState } from './chat-state-reducer';
import type { writeSyncedJsonTemp } from '../lib/chat-state-journal';
import type { LegacyChatRevisionGapRecovery } from '../lib/legacy-chat-migration';
import type { ChatWaitOperation } from '../observability/chat-wait-diagnostics';

/**
 * A commit observer. `wait`, when present, is the commit's publication timing,
 * started when its publication slot was reserved.
 */
export type ChatStateCommitListener = (
  commit: ChatStateCommit,
  wait?: ChatWaitOperation,
) => void | Promise<void>;

/** Starts a commit's publication timing when its publication slot is reserved. */
export type ChatStateCommitWaitStarter = (
  commit: ChatStateCommit,
) => ChatWaitOperation;

export type ChatScopeLifecycle =
  | 'unloaded'
  | 'loading'
  | 'ready'
  | 'draining'
  | 'disposed'
  | 'recovery_error';

export interface ChatScopeKey {
  projectId: string;
  worktreeId: string;
}

export interface ChatStateCommit {
  /** S2 supplies descriptor-only card changes after durable admission. */
  cardChanges?: Extract<
    ChatStateChange,
    { type: 'delegation.card_state_updated' }
  >[];
  projectId: string;
  worktreeId: string;
  baseRevision: number;
  revision: number;
  record: ChatJournalRecord;
  state: CanonicalChatState;
  /** True only when this call appended a new durable journal record. */
  applied: boolean;
  /**
   * Chat ids whose `transcript.updated` change must carry `reset`: the commit
   * shifted existing rows' logical ranks, or removed or replaced rows. Absent
   * when the backend does not report it; publishers then apply the mutation
   * rule.
   */
  transcriptResets?: readonly string[];
  /**
   * Chats whose delegation state advanced the revision without a change a
   * window shows (a stream's registration or opening, rows on a stream with
   * no card state, a receipt). Their unchanged transcript descriptors stand
   * in for the change, so the revision chain has no gap to resync over.
   */
  advancedChatIds?: readonly string[];
}

export interface ChatMutationOptions {
  source: ChatJournalRecord['source'];
  mutationId?: string;
  commandResult?: Omit<PersistedCommandReceipt, 'revision'>;
  checkpoint?: boolean;
  expectedRevision?: number;
  /** Reserved for the semantic removal committed by deleteScope itself. */
  allowDuringScopeDeletion?: boolean;
  /** Explicit transcript selection used by the per-chat storage backend. */
  chatIds?: readonly string[];
  fullTranscript?: boolean;
  /**
   * Set by a turn start that must move an already-committed prompt to its
   * dispatch position (phase 25): the full rewrite it causes is reported
   * with this reason instead of a patch or removal.
   */
  rewriteReason?: 'prompt_relocation';
  /** Async preparation performed after durable payload staging. */
  preparePublish?: () => Promise<void>;
  /** Synchronous guard immediately before durable publication starts. */
  beforePublish?: () => void;
}

export class ChatStateRevisionConflictError extends Error {
  public override readonly name = 'ChatStateRevisionConflictError';

  public constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(
      `Expected revision ${expectedRevision}, current revision is ${actualRevision}`,
    );
  }
}

export interface ScopePaths {
  tabs: string;
  archives: string;
  journal: string;
}

export interface ChatStateRepositoryOptions {
  resolvePaths?: (scope: ChatScopeKey) => ScopePaths;
  now?: () => number;
  createId?: () => string;
  onCommit?: ChatStateCommitListener;
  hasLiveDependency?: (scope: ChatScopeKey) => boolean;
  /** Injectable checkpoint writer for deterministic cooperative-abort tests. */
  writeSyncedJsonTemp?: typeof writeSyncedJsonTemp;
  checkpointIdleMs?: number;
  checkpointBoundaryDelayMs?: number;
  maxCheckpointAborts?: number;
  maxCheckpointDeferralMs?: number;
  onStorageDiagnostic?: (diagnostic: ChatStateStorageDiagnostic) => void;
}

export interface ChatStateStorageDiagnostic {
  kind:
    | 'journal_loaded'
    | 'journal_growth'
    | 'transcript_bearing_mutation'
    | 'checkpoint_aborted'
    | 'checkpoint_starvation'
    | 'checkpoint_forced'
    | 'checkpoint_completed'
    | 'artifact_maintenance_failed'
    | 'transcript_preview_close_failed'
    | 'legacy_chat_revision_gap_recovered'
    /**
     * A delta-journal record this build does not know (written by a newer
     * build) stopped the load; the scope is in `recovery_error`.
     */
    | 'delta_journal_newer_format'
    /**
     * Unacknowledged bytes after a delta journal's last verified record were
     * excluded from replay (`recordBytes`), never treated as committed.
     */
    | 'delta_journal_torn_tail_dropped'
    /** The scope moved to the delta journal (storage manifest version 3). */
    | 'delta_journal_promoted'
    /** Promotion failed; the scope stays version 2; retried with backoff. */
    | 'delta_journal_promotion_failed'
    /** The scope returned to version 2 storage; its journal was removed. */
    | 'delta_journal_demoted'
    /**
     * Demotion failed; the scope stays version 3, readable and writable
     * through its journal, and a later sweep or load retries.
     */
    | 'delta_journal_demotion_failed'
    /** The scope moved from format 3 to storage format 4 (manifest version 4). */
    | 'format4_promoted'
    /** A format 4 promotion attempt failed; the scope stays format 3. */
    | 'format4_promotion_failed'
    /** Every format 4 promotion retry is spent until the next process. */
    | 'format4_promotion_exhausted';
  occurredAt: string;
  /** The rollback-safe initial release remains entirely v1-authoritative. */
  storageAuthority: 'v1' | 'v2';
  projectId: string;
  worktreeId: string;
  journalBytes: number;
  recordBytes?: number;
  recordCount?: number;
  maxRecordBytes?: number;
  meanRecordBytes?: number;
  checkpointDurationMs?: number;
  checkpointAbortCount?: number;
  maintenanceReason?:
    | 'io'
    | 'capacity'
    | 'pending_replay'
    | 'invalid_sidecar'
    | 'unknown';
  /**
   * `delta_journal_torn_tail_dropped` only: why the tail was not a frame
   * (`incomplete`: cut short; `checksum_mismatch`: complete but invalid).
   */
  journalTailReason?: 'incomplete' | 'checksum_mismatch';
  /**
   * `delta_journal_torn_tail_dropped` only: base name of the quarantine copy
   * in the scope directory, when the tail was kept for inspection.
   */
  journalQuarantineFile?: string;
  /** `legacy_chat_revision_gap_recovered` only; revisions, never content. */
  revisionGap?: LegacyChatRevisionGapRecovery;
}

export interface ChatStateTransactionContext {
  getPortalSendReceipt(
    userMessageId: string,
  ): PersistedCommandReceipt | undefined;
  hasRemovedTab(tabId: string): boolean;
  hasRemovedArchiveEntry(archiveEntryId: string): boolean;
  /** Omitting chatId retains the legacy scope-wide fence. */
  hasRemovedMessage(messageId: string, chatId?: string): boolean;
  /**
   * Format 4 scopes only; absent otherwise and in older repositories. Lets
   * ingest publish a final body from chunks inside the transaction, under its
   * rollback, instead of building the whole body string.
   */
  transcriptFields?: TranscriptFieldPreparation;
}

export interface TranscriptFieldPreparation {
  readonly format: 4;
  /** The reference `ChatTranscriptArtifacts.put` would give the joined chunks. */
  publish(
    chatId: string,
    chunks: Iterable<string> | AsyncIterable<string>,
    signal?: AbortSignal,
  ): Promise<PersistedToolOutputReference>;
}

export class ChatStateRepositoryLoadError
  extends Error
  implements ChatStateLoadError
{
  public override readonly name = 'ChatStateLoadError';
  public readonly code = 'recovery_error' as const;
  public readonly retryable = false;
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare public readonly cause?: unknown;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options && 'cause' in options) {
      this.cause = options.cause;
    }
  }
}

/**
 * Prepares a child stream write inside the scope lease turn that commits it:
 * receives the stream's descriptor (undefined when it is not registered) and
 * a point read of a stored row at that descriptor's revision, and returns the
 * rows to commit. Returning none commits nothing; throwing refuses the write.
 */
export type ChildStreamWritePreparation = (
  descriptor: TranscriptStreamDescriptor | undefined,
  storedRow: (messageId: string) => Promise<DelegationChildRow | undefined>,
) => Promise<readonly DelegationChildRow[]>;

/** The outcome of a prepared child stream write. */
export type PreparedChildStreamCommit =
  | {
      readonly committed: false;
      readonly prepared: TranscriptStreamDescriptor | undefined;
    }
  | {
      readonly committed: true;
      readonly prepared: TranscriptStreamDescriptor | undefined;
      readonly applied: boolean;
      readonly revision: number;
      readonly descriptor: TranscriptStreamDescriptor;
    };
