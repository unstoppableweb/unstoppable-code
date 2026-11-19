import type { DelegationChildRow } from '@canopy/agent-transcript';
import type {
  CardState,
  CardStateDraft,
  PersistedToolOutputReference,
  TranscriptContentField,
  TranscriptTarget,
} from '@canopy/protocol/canopy-core';

import type { DelegationReceiptReplyV1 } from './receipt-reply';
import type {
  AgentDelegationErrorCode,
  AgentDelegationUsage,
  AgentDelegationSpawnRequest,
  DelegateSettledStatus,
  DelegationStopReason,
} from '@canopy/protocol/delegation';

export const DELEGATION_REGISTRY_MAX_ID_LENGTH = 256;
export const DELEGATION_REGISTRY_MAX_ERROR_LENGTH = 4096;
export const DELEGATION_REGISTRY_MAX_ENTRY_BYTES = 16 * 1024;
export const DELEGATION_REGISTRY_MAX_CACHED_DELEGATIONS = 64;
export const DELEGATION_REGISTRY_MAX_CURSOR_LENGTH = 2048;
export const DELEGATION_REGISTRY_DEFAULT_PAGE_LIMIT = 100;
export const DELEGATION_REGISTRY_MAX_PAGE_LIMIT = 100;

/**
 * The delegation transcript port (README D5): the in-code boundary through
 * which the shared runner and broker write and read a stream-backed
 * generation's child transcript. The desktop host backs it with the chat
 * repository; the development broker and tests use the in-memory port. It
 * creates no process, socket or second writer. Only stream-backed
 * generations use it, and production creates none before promotion.
 */

export type DelegationTranscriptTarget = Extract<
  TranscriptTarget,
  { kind: 'delegation' }
>;

export type DelegationTranscriptPortErrorCode =
  /** Malformed input, such as two changes to one item in one admission. */
  | 'invalid_request'
  | 'not_found'
  /** The target is not owned by this port's captured scope. */
  | 'unauthorized'
  /** A stale or future revision, or a gapped item revision. */
  | 'stale_identity'
  /** A different payload for a stored item revision, or a change to a final item. */
  | 'conflict'
  /** The scope cannot hold child streams, or the operation needs a later storage version. */
  | 'unsupported_format'
  | 'storage_failure'
  | 'corruption'
  /** Corruption-class failure: repair retained an outcome but lost its answer. */
  | 'answer_unavailable';

export interface DelegationTranscriptPortError {
  readonly code: DelegationTranscriptPortErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** For `stale_identity` on an item: the stored revision to reconcile against. */
  readonly storedItemRevision?: number;
  /** The canonical floor when an asserted result index conflicts. */
  readonly storedLastResultIndex?: number;
}

export type DelegationTranscriptPortResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DelegationTranscriptPortError };

/** A stream's current state, independent of how the host stores it. */
export interface DelegationTranscriptStreamState {
  readonly target: DelegationTranscriptTarget;
  readonly status: 'open' | 'settled';
  /** Increases with every applied admission; stable across replays and reopen. */
  readonly streamRevision: number;
  readonly openedAt: number | null;
  readonly latestRowTimestamp: number | null;
  readonly cardState?: CardState | null;
}

export interface DelegationTranscriptCardStateRequest {
  readonly target: DelegationTranscriptTarget;
  readonly cardRevision: number;
  readonly cardDraft: CardStateDraft;
}

/**
 * One upsert or finalization of one item, as a logical row: its bodies are
 * inline, never field or block references; the host prepares storage. `row.id`
 * is the item's stable identity; `row.itemRevision` starts at 0 and increases
 * by one per change; `row.final` latches; `row.delegationSegment` names the
 * native segment and cannot change.
 */
export interface DelegationTranscriptChange {
  readonly row: DelegationChildRow;
}

export interface DelegationTranscriptItemVersion {
  readonly id: string;
  readonly itemRevision: number;
  readonly final: boolean;
}

/**
 * Current-item replay receipts survive the crash-id window and checkpoint.
 * Request items retain request order. An all-identical batch returns the maximum
 * original admitting revision; a common admitting key wins, otherwise the request
 * key is used. Subsets/recombinations have derived receipts, not stored batches.
 */
export interface DelegationTranscriptReceipt {
  readonly target: DelegationTranscriptTarget;
  readonly mutationKey: string;
  readonly streamRevision: number;
  readonly items: readonly DelegationTranscriptItemVersion[];
  readonly replayed: boolean;
}

/**
 * Open reads require the exact current revision. Settled reads accept
 * contentRevision <= pin <= current and normalize to contentRevision, including
 * cursors and returned revisions. Older/future pins are stale_identity.
 */
export interface DelegationTranscriptPinnedRead {
  readonly target: DelegationTranscriptTarget;
  readonly streamRevision: number;
}

export interface DelegationTranscriptRowsPage {
  /** Rows in display order: delegation sequence, then id. */
  readonly rows: readonly DelegationChildRow[];
  readonly streamRevision: number;
  /** Continues with older rows; absent at the stream's start. */
  readonly cursor?: string;
}

export interface DelegationTranscriptContentRange {
  readonly text: string;
  readonly nextOffset?: number;
  readonly byteLength: number;
  /** The body's stored encoding, which offsets and lengths count in. */
  readonly encoding: 'utf8' | 'utf16le';
}

export interface DelegationTranscriptRegistryIdentity {
  readonly chatId: string;
  readonly delegationId: string;
}

export interface DelegationTranscriptGenerationRegistration extends DelegationTranscriptRegistryIdentity {
  readonly runGeneration: number;
  readonly createdAt: number;
  readonly store: 'stream' | 'legacy';
  readonly origin: {
    readonly kind: 'launch' | 'follow_up' | 'resume' | 'continuation';
    readonly anchorMessageId?: string;
    readonly authoredItemId?: string;
  };
  readonly executionMode: AgentDelegationSpawnRequest['executionMode'];
}

export interface DelegationTranscriptGenerationEntry extends DelegationTranscriptGenerationRegistration {
  readonly version: 1;
  readonly kind: 'generation';
}

/** A lifetime refusal happens before admission, so it never settles. */
export type SettledDelegationErrorCode = Exclude<
  AgentDelegationErrorCode,
  'lifetime_limit_reached'
>;

export interface DelegationTranscriptSettlementOutcome {
  readonly status: DelegateSettledStatus;
  readonly error?: {
    readonly code: SettledDelegationErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly usage?: AgentDelegationUsage;
  readonly stopReason?: DelegationStopReason;
  readonly startedAt?: number;
  /** Caller-stable completion time; also the result's settlement time. */
  readonly finishedAt: number;
}

export type DelegationTranscriptAnswer =
  | { readonly kind: 'none' }
  | { readonly kind: 'empty'; readonly role: 'final' | 'partial' }
  | {
      readonly kind: 'body';
      readonly role: 'final' | 'partial';
      readonly byteLength: number;
      readonly encoding: 'utf8' | 'utf16le';
      readonly sha256: string;
      readonly ref: PersistedToolOutputReference;
    }
  | {
      /**
       * Only trusted repair creates lost answers (11c). The identity is logical:
       * SHA-256 over UTF-16LE code units and the UTF-16 code-unit length, as in
       * the settlement identity. It recovers no text, encoding or stored length.
       */
      readonly kind: 'lost';
      readonly role: 'final' | 'partial';
      readonly sha256: string;
      readonly length: number;
    };

export interface DelegationTranscriptSettlement {
  readonly streamRevision: number;
  readonly contentRevision: number;
  readonly finalItemCount: number;
  /** Physical committed-row digest; not the logical settlement identity digest. */
  readonly finalItemsDigest: string;
}

export interface DelegationTranscriptResultEntry {
  readonly version: 1;
  readonly kind: 'result';
  readonly resultIndex: number;
  readonly runGeneration: number;
  readonly settlementKey: string;
  readonly settlementDigest: string;
  readonly outcome: DelegationTranscriptSettlementOutcome;
  readonly answer: DelegationTranscriptAnswer;
  readonly settlement: DelegationTranscriptSettlement;
}

export interface DelegationTranscriptSettleRequest {
  readonly cardDraft?: CardStateDraft;
  readonly cardRevision?: number;
  readonly target: DelegationTranscriptTarget;
  readonly settlementKey: string;
  readonly resultIndex: number;
  readonly outcome: DelegationTranscriptSettlementOutcome;
  readonly finalChanges: readonly DelegationTranscriptChange[];
  readonly answer: DelegationTranscriptSettleAnswer;
  /**
   * `reject` (the default) refuses a settle while rows stay open. `finalize`
   * closes every remaining stored open row at its stored content as its next
   * item revision, after the explicit final changes, inside the same atomic
   * settle. Generated finals never enter the settlement identity.
   */
  readonly openRows?: 'reject' | 'finalize';
}

export type DelegationTranscriptSettleAnswer =
  | {
      readonly role: 'final' | 'partial';
      readonly text: string;
    }
  | {
      /** Trusted repair only: the body is gone, its logical identity is not. */
      readonly role: 'final' | 'partial';
      readonly lost: {
        readonly sha256: string;
        /** UTF-16 code units, at least 1; an empty answer uses `text: ''`. */
        readonly length: number;
      };
    }
  | null;

export interface DelegationTranscriptSettleResult {
  readonly settlement: {
    readonly target: DelegationTranscriptTarget;
    readonly settlementKey: string;
    readonly streamRevision: number;
    readonly contentRevision: number;
    readonly finalItemCount: number;
    readonly replayed: boolean;
  };
  readonly result: DelegationTranscriptResultEntry;
}

/** Generation entries are snapshotted; stream fields are current, not pinned. */
export interface DelegationTranscriptGeneration {
  readonly entry: DelegationTranscriptGenerationEntry;
  /** Null includes queued and never-dispatched generations. */
  readonly stream:
    | (DelegationTranscriptStreamState & {
        readonly contentRevision: number | null;
      })
    | null;
  readonly result: DelegationTranscriptResultEntry | null;
}

export interface DelegationTranscriptRegistryPageRequest extends DelegationTranscriptRegistryIdentity {
  /** Opaque scope/archive/copy-bound kind, position and registry high-water. */
  readonly cursor?: string;
  readonly limit: number;
}
export interface DelegationTranscriptResultsPage {
  readonly results: readonly DelegationTranscriptResultEntry[];
  readonly cursor?: string;
}
export interface DelegationTranscriptGenerationsPage {
  readonly generations: readonly DelegationTranscriptGeneration[];
  readonly cursor?: string;
}
export type DelegationTranscriptResultRequest =
  DelegationTranscriptRegistryIdentity & {
    readonly resultIndex: number;
  };
export type DelegationTranscriptGenerationRequest =
  DelegationTranscriptRegistryIdentity & {
    readonly runGeneration: number;
  };
/**
 * Chat-scoped receipts (11c1, C1). The broker (11c3) rolls command and stop
 * acknowledgements out of its bounded record windows into these immutable
 * entries and finds them again by key. One `command` namespace covers every
 * agent and user command key, including failed message admissions; `stop` is
 * one entry per stop alias key; `stop_outcome` is keyed by the operationId.
 */
export type DelegationTranscriptReceiptKind =
  | 'command'
  | 'stop'
  | 'stop_outcome';

export type DelegationTranscriptReceiptOperation =
  | 'follow_up'
  | 'resume'
  | 'steer'
  | 'interrupt'
  | 'apply'
  | 'discard'
  | 'stop';

export interface DelegationTranscriptReceiptIdentity {
  readonly chatId: string;
  readonly receiptKind: DelegationTranscriptReceiptKind;
  /** 64 lowercase hex for command and stop; the lowercase UUID operationId for stop_outcome. */
  readonly key: string;
}

export interface DelegationTranscriptReceiptEntry extends DelegationTranscriptReceiptIdentity {
  readonly version: 1;
  readonly kind: 'receipt';
  readonly delegationId: string;
  readonly runGeneration: number | null;
  /** Canonical lowercase UUID. */
  readonly operationId: string;
  /** 64 lowercase hex; null for stop_outcome. */
  readonly requestHash: string | null;
  readonly operation: DelegationTranscriptReceiptOperation;
  /** Milliseconds, a non-negative safe integer. */
  readonly admittedAt: number;
  /** `reply.kind` equals `receiptKind`; see receipt-reply.ts. */
  readonly reply: DelegationReceiptReplyV1;
}

export interface DelegationTranscriptReceiptAppendResult {
  readonly entry: DelegationTranscriptReceiptEntry;
  readonly replayed: boolean;
}

export type DelegationTranscriptSettlementKeyRequest =
  DelegationTranscriptRegistryIdentity & {
    readonly settlementKey: string;
  };
export type DelegationTranscriptResultAnswerRequest =
  DelegationTranscriptResultRequest & {
    readonly offset: number;
    readonly limit: number;
  };

export interface DelegationTranscriptPort {
  /**
   * Append an immutable receipt, authorized by chat. An identical entry
   * replays; a different entry under the same identity is `conflict`; an entry
   * over the 16 KiB effect bound is `invalid_request` (the receipt-reply
   * fitters make that unreachable for validated drafts).
   */
  appendReceipt(
    input: DelegationTranscriptReceiptEntry,
    signal?: AbortSignal,
  ): Promise<
    DelegationTranscriptPortResult<DelegationTranscriptReceiptAppendResult>
  >;
  /** Point read by identity; `not_found` when absent. */
  receipt(
    input: DelegationTranscriptReceiptIdentity,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptReceiptEntry>>;
  /** Register the target, or return the existing identical registration. */
  open(
    input: { readonly target: DelegationTranscriptTarget },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptStreamState>>;
  /**
   * Durably admit ordered changes, at most one per item. Identity is the
   * target, item id and item revision, compared against the stored item, in
   * this order: identical to the stored revision is a replay; a stored final
   * item is a `conflict`; the same revision with different content, or a
   * changed segment, is a `conflict`; any revision other than stored + 1 (or
   * 0 for a new item) is `stale_identity`. `mutationKey` deduplicates crash
   * retries only; it is not an identity, and reusing it carries no promise.
   * All-current-identical replay uses each item's original admitting revision
   * and raw key (see Receipt), even beyond 4096 crash ids. Stored-final conflict
   * precedes stale revision. Mixed replay/new batches retain ordinary admission
   * behavior. Metadata-less format-4 test rows replay as unsupported_format;
   * never invent original receipts.
   */
  appendChanges(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly mutationKey: string;
      readonly changes: readonly DelegationTranscriptChange[];
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptReceipt>>;
  /** Resolve once every admission through `streamRevision` is durable. */
  flush(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly streamRevision: number;
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptStreamState>>;
  /**
   * Atomic final-row/descriptor/result admission. Known-key digest replay is
   * checked before mutable descriptor/card state; a changed digest conflicts.
   * New indices must be last + 1; the first positive index is a trusted seed.
   * Failed admission consumes no index. Final changes retain request order.
   */
  settle(
    input: DelegationTranscriptSettleRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptSettleResult>>;
  /** Descriptor-only card update. Dormant until the S1/S2 implementation. */
  updateCardState(
    input: DelegationTranscriptCardStateRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptStreamState>>;
  /** Idempotent by generation; changed metadata conflicts, even before open. */
  registerGeneration(
    input: DelegationTranscriptGenerationRegistration,
    signal?: AbortSignal,
  ): Promise<
    DelegationTranscriptPortResult<DelegationTranscriptGenerationEntry>
  >;
  result(
    input: DelegationTranscriptResultRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultEntry>>;
  /** Point read for repair; `not_found` when absent, other failures structured. */
  resultBySettlementKey(
    input: DelegationTranscriptSettlementKeyRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultEntry>>;
  /** Point read for repair and the watcher; works without a generation entry. */
  resultByGeneration(
    input: DelegationTranscriptGenerationRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultEntry>>;
  generation(
    input: DelegationTranscriptGenerationRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptGeneration>>;
  generationsPage(
    input: DelegationTranscriptRegistryPageRequest,
    signal?: AbortSignal,
  ): Promise<
    DelegationTranscriptPortResult<DelegationTranscriptGenerationsPage>
  >;
  /** Same byte rules as contentRange; none -> not_found, lost -> answer_unavailable. */
  resultAnswerRange(
    input: DelegationTranscriptResultAnswerRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptContentRange>>;
  page(
    input: DelegationTranscriptPinnedRead & {
      readonly cursor?: string;
      readonly limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptRowsPage>>;
  message(
    input: DelegationTranscriptPinnedRead & { readonly messageId: string },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationChildRow>>;
  /**
   * A byte range of one field of one block, inline or referenced, counted in
   * the body's stored encoding (UTF-16LE when the text has a lone surrogate,
   * otherwise UTF-8, for inline fields too); an offset inside a character is
   * `invalid_request`.
   */
  contentRange(
    input: DelegationTranscriptPinnedRead & {
      readonly messageId: string;
      readonly blockOrdinal: number;
      readonly field: TranscriptContentField;
      readonly offset: number;
      readonly limit: number;
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptContentRange>>;
  /** Metadata only, ascending index order, pinned to the first page high-water.
   * Foreign, malformed or out-of-range cursors return invalid_request.
   */
  resultsPage(
    input: DelegationTranscriptRegistryPageRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultsPage>>;
}

/** The registry-dependent operations' answer before slice P3c. */
export function delegationTranscriptRegistryUnsupported(): {
  readonly ok: false;
  readonly error: DelegationTranscriptPortError;
} {
  return {
    ok: false,
    error: {
      code: 'unsupported_format',
      message:
        'Delegation results need the result registry, which this storage version does not have.',
      retryable: false,
    },
  };
}
