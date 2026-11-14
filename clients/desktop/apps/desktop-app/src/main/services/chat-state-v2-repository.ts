import { classifyError } from '@canopy/protocol/app-errors/classification';
import type {
  ChildStreamCompatibilityPageReply,
  ChildStreamCompatibilityPageRequest,
} from '../agents/delegation/record-reader-contract';
import { DELEGATION_COMPATIBILITY_PAGE_LIMITS } from '../agents/delegation/record-reader-contract';
import type { DelegationReadMetadataSource } from '@canopy/desktop-shared/node/delegation/record-read-metadata';
import { DelegationRegistryOperationError } from '../lib/chat-delta-journal/delegation-registry-error';
import type {
  DelegationRegistryOperations,
  DelegationRegistryCursorContext,
} from '../lib/chat-delta-journal/delegation-registry-api';
import { isMcpActivationMessage } from './mcp-activation-message';
import type { AgentDelegationTranscriptItem } from '@canopy/protocol/delegation';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { ChildSearchDocumentIdentity } from '../chat-search/child-text';
import {
  TranscriptTargetSchema,
  type TranscriptContentField,
  type TranscriptTarget,
  type TranscriptStreamDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  DelegationRun,
  DelegationRunItems,
} from '../lib/chat-delegation-log';
import type {
  TranscriptDescriptor,
  TranscriptViewRequest,
} from '@canopy/agent-transcript/transcript-storage';
import type { CapturedTranscriptPreview } from '../lib/chat-transcript-log';
import type { ChatRecoveryIndex } from '../lib/chat-storage-v2';
import type {
  ChatTranscriptBlocksPage,
  ChatTranscriptBlocksRequest,
  ChatTranscriptContentRequest,
  ChatTranscriptPageRequest,
  ChatTranscriptSearchRequest,
  ChatTranscriptSearchResult,
  ChatToolOutputRequest,
  ChatToolOutputResponse,
  ChatVisualReadResponse,
} from '@canopy/desktop-shared/types';
import type {
  ChatStorageImportOptions,
  ChatStorageTransactionCheckpoint,
  TranscriptConsumeOptions,
} from './chat-state-v2-backend';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  capturedStreamIdentity,
  type StreamCopyParent,
} from '../lib/chat-delta-journal/stream-closure-copy';
import type {
  ChatCoreMutation,
  ChatJournalRecord,
  ChatTabsFile,
  PersistedChatMessage,
  PersistedChatTab,
  PersistedCommandReceipt,
} from '@canopy/desktop-shared/types';
import type {
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  type DeltaJournalDiagnostic,
  type ChatDeltaJournalWriterOptions,
} from '../lib/chat-delta-journal/writer';
import { getDataDir } from '../lib/paths';
import { isErrnoException } from '../lib/type-guards';
import { VisualStagingStoreImpl } from '../lib/visual-staging';
import { ChatVisualStagingSweep } from '../lib/chat-visual-staging-sweep';
import {
  chatVisualStagingPublicationGeneration,
  chatVisualStagingScopesMarkerExists,
  removeChatVisualStagingScopesMarker,
  withChatVisualStagingScopesMarker,
} from '../lib/visual-staging-scopes-marker';
import type {
  PromotedVisual,
  ProviderVisualAdmission,
  StageVisualDocument,
  VisualStagingSidecar,
  VisualStagingStore,
  VisualStagingTarget,
  VisualToolIdentityResolver,
} from '../lib/chat-visual-contracts';
import {
  deltaJournalBackendOptions,
  deltaJournalLifecycleDiagnostic,
  deltaJournalWriterDiagnostic,
} from '../lib/chat-delta-journal/repository-support';
import type { ActiveTurnDelta } from '../lib/chat-delta-journal/active-turn';
import { registerChatStorageScope } from '@canopy/desktop-shared/node/chat-storage-activity';
import { ArtifactMaintenanceCapacityError } from '../lib/chat-artifact-maintenance';
import {
  migrateLegacyChatScope,
  type LegacyChatScopePaths,
} from '../lib/legacy-chat-migration';
import {
  resolveChatTabsFilePath,
  resolveChatArchivesFilePath,
  resolveChatJournalFilePath,
} from '../lib/resolve-worktree';
import {
  fsyncDirectory,
  type ChatJournalDiagnostic,
} from '../lib/chat-state-journal';
import type { CanonicalChatState } from './chat-state-reducer';
import { markChatApprovalStateChanged } from '../approvals/rule-revisions';
import {
  ChatStateV2Backend,
  type ChildStreamContentRange,
  type ChildStreamRowsPage,
  type ChatReadSelection,
  type V2MutationOptions,
  settledLease,
} from './chat-state-v2-backend';
import { ChatStorageNewerFormatError } from '../lib/chat-delta-journal/format';
import {
  summarizeDeltaJournal,
  type DeltaJournalSummary,
} from '../lib/chat-delta-journal/reader';
import {
  ChatStateRepositoryLoadError,
  ChatStateRevisionConflictError,
  type ChatStateRepositoryOptions,
  type ChatScopeKey,
  type ChatScopeLifecycle,
  type ChatStateCommit,
  type ChatStateCommitListener,
  type ChatStateCommitWaitStarter,
  type ChatStateStorageDiagnostic,
  type ChatStateTransactionContext,
  type ChildStreamWritePreparation,
  type PreparedChildStreamCommit,
} from './chat-state-contracts';
import type { ChatWaitOperation } from '../observability/chat-wait-diagnostics';
import type { ChatFormat4Outcome } from './chat-format4-telemetry';

/** Options of one repository transaction. */
export type ChatStateTransactionOptions = V2MutationOptions & {
  /**
   * Called synchronously once the transaction holds its place in the scope's
   * commit order (its turn of the scope lease is queued). A producer that
   * must keep its own order may submit its next transaction from then on,
   * without waiting for this one to be durable.
   */
  onQueued?: () => void;
};

export interface ChatStateV2RepositoryOptions extends Omit<
  ChatStateRepositoryOptions,
  'hasLiveDependency'
> {
  enableFormat4?: boolean;
  /**
   * Whether a writable format 3 scope may promote to format 4 now, asked at
   * each promotion attempt. Absent means yes. Never demotes a format 4 scope.
   */
  format4Promotion?: (scope: ChatScopeKey) => boolean;
  /** Read-only capsule injection; absent until broker record-v3 adoption. */
  delegationReadMetadata?: DelegationReadMetadataSource;
  /** Test-only journal durability fault observation; absent in production. */
  deltaJournalOnBoundary?: ChatDeltaJournalWriterOptions['onBoundary'];
  hasLiveDependency?: (scope: ChatScopeKey) => boolean | Promise<boolean>;
  /** Delta-journal idle checkpoint delay (P1 §A: about one second). */
  deltaJournalIdleCheckpointMs?: number;
  /** Delta-journal size checkpoint threshold; defaults to 4 MiB. */
  deltaJournalCheckpointBytes?: number;
  /**
   * Format 4 checkpoints restage only changed stream metadata. Off until a
   * stable release carries the relaxed stream metadata readers.
   */
  deltaJournalIncrementalStreamMetadata?: boolean;
  /**
   * Receives each content-free format 4 outcome (CAN-6217) after its local
   * session diagnostic: promotion attempts, newer-format refusals and format 4
   * checkpoint durations. Never changes the storage work.
   */
  format4Telemetry?: (outcome: ChatFormat4Outcome) => void;
  /** Records estimated above this take the version 2 path (tests). */
  deltaJournalLargeRecordBytes?: number;
  /** First retry delay of a failed promotion (doubles); default 30 s. */
  deltaJournalPromotionRetryMs?: number;
  /** Retries of a failed promotion; default 5. */
  deltaJournalPromotionRetryLimit?: number;
  /** Unload idle resident scopes after this delay; 0 disables unloading. */
  idleScopeUnloadMs?: number;
  /** Dynamic scope pin checked before an idle unload. */
  isScopePinned?: (scope: ChatScopeKey) => boolean;
  /**
   * The host has admitted an operation for the scope. Checked only before an
   * idle unload: a v1 migration must not wait on its own caller's admission.
   */
  hasAdmittedOperation?: (scope: ChatScopeKey) => boolean;
  /** Deterministic storage interruption seams used by V2 recovery tests. */
  testHooks?: {
    storageCheckpoint?: (
      point: ChatStorageTransactionCheckpoint,
    ) => Promise<void>;
  };
}

/**
 * Node file-system errors carry a string errno `code`; storage integrity and
 * migration failures do not. Only the former can clear without intervention.
 */
/**
 * A read or write that reaches a scope while it is drained or deleted, as
 * archiving a standalone chat deletes its scope while the renderer and the
 * search index still reach it (CAN-6556). The caller's state changed under
 * it; that is no defect.
 */
function scopeDrainingError(): Error {
  return classifyError(
    new Error('Chat scope is draining'),
    'external.state_changed',
    { source: 'chat-state' },
  );
}

function isOperatingSystemFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) return true;
    current = Reflect.get(current, 'cause');
  }
  return false;
}

function aggregateFailure(errors: unknown[], message: string): Error {
  return Object.assign(new Error(message), { name: 'AggregateError', errors });
}

function errorFromUnknown(value: unknown): Error {
  return value instanceof Error
    ? value
    : Object.assign(new Error(String(value)), { cause: value });
}

export interface ChildSearchDirtyNotification {
  scope: ChatScopeKey;
  parentChatId: string;
  target: Extract<TranscriptTarget, { kind: 'delegation' }>;
}

/**
 * Cleanup is needed only when a mutation can remove a reachability root.
 * An upsert is a replacement unless write preparation proves the whole
 * chat write append-only; absence from a bounded view is not such proof.
 */
export function mutationCanDropArtifactReference(
  mutation: ChatCoreMutation,
  appendOnly = false,
): boolean {
  switch (mutation.type) {
    case 'message.upserted':
      return !appendOnly;
    case 'tab.created':
    case 'tab.removed':
    case 'message.removed':
    case 'messages.replaced':
    case 'archive.upserted':
    case 'archive.removed':
      return true;
    case 'tab.metadata_patched':
    case 'tab.order_changed':
    case 'tab.active_changed':
    case 'pending_question.upserted':
    case 'pending_question.removed':
    case 'runtime.patched':
    case 'archive.read_state_changed':
      return false;
    default: {
      const unclassified: never = mutation;
      return unclassified;
    }
  }
}

type DelegationStreamTarget = Extract<TranscriptTarget, { kind: 'delegation' }>;

interface ScopeEntry {
  scope: ChatScopeKey;
  store: ChatStorageV2;
  paths: LegacyChatScopePaths;
  backend: ChatStateV2Backend;
  /** True once this backend has loaded canonical state or a checkpoint-only read. */
  backendResident: boolean;
  visualStaging?: VisualStagingStore;
  lifecycle: ChatScopeLifecycle;
  loading?: Promise<void>;
  /** A cached non-transient recovery failure; only releaseScope retries it. */
  loadError?: ChatStateRepositoryLoadError;
  deleting: number;
  /**
   * A lease covers admission through completion, including reads/exports.
   * Like the backend's own chain, it settles without the operation's result.
   */
  tail: Promise<void>;
  /** Includes queued and running serialized/admission turns. */
  inFlightTurns: number;
  /** Delegate-log writes that continue after their scope lease is released. */
  outOfLeaseReservations: number;
  /** The one-shot idle unload timer. */
  idleUnloadTimer?: ReturnType<typeof setTimeout>;
  /** Observers see applied commits strictly in revision order per scope. */
  publishTail: Promise<void>;
  /**
   * Entries on `publishTail` not yet finished, including those not yet
   * released: commit publications and child search notifications. A commit's
   * queue depth is the count ahead of it.
   */
  pendingPublications: number;
  /** The commit publication at the head of `publishTail`, when one is. */
  publishingWait?: ChatWaitOperation;
  previewReaders: Set<CapturedTranscriptPreview>;
  previewCloseFailure?: boolean;
  maintenanceChats: Set<string>;
  /** Cleanup intent survives active turns and records awaiting checkpoint. */
  maintenanceDirtyChats: Set<string>;
  maintenanceDeferred: Set<string>;
  maintenanceCapacityChats: Set<string>;
  maintenanceImmediate?: ReturnType<typeof setImmediate>;
  maintenanceCapacityWake?: () => void;
  maintenanceFailure?: string;
  maintenanceFailedChatId?: string;
  /** The delta journal's idle checkpoint (P1 §A). */
  journalIdleTimer?: ReturnType<typeof setTimeout>;
  journalCheckpointQueued?: boolean;
  formatReconcileQueued?: boolean;
}

function hasVisualOwner(
  recovery: ChatRecoveryIndex,
  chatId: string,
  visualId: string,
): boolean {
  // The ledger is read from disk; a malformed entry is not an owner.
  const owners: unknown = recovery.visualOwnersByChatId?.[chatId];
  return (
    typeof owners === 'object' &&
    owners !== null &&
    Object.prototype.hasOwnProperty.call(owners, visualId)
  );
}

async function childDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

function stateHasChat(state: CanonicalChatState, chatId: string): boolean {
  return (
    state.tabsFile.tabs.some((tab) => tab.id === chatId) ||
    state.archivesFile.archived.some((entry) => entry.tab.id === chatId)
  );
}

function removedVisualChats(
  mutations: readonly ChatCoreMutation[],
  state: CanonicalChatState,
): string[] {
  const candidates = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.type === 'tab.removed') candidates.add(mutation.tabId);
    else if (mutation.type === 'archive.removed') {
      candidates.add(mutation.chatId);
      candidates.add(mutation.archiveEntryId);
    }
  }
  return Array.from(candidates).filter(
    (chatId) => !stateHasChat(state, chatId),
  );
}

/** A value as JSON with object keys sorted, so key order never matters. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : nested,
  );
}

function approvalStateOf(tab: PersistedChatTab | undefined): string {
  return canonicalJson([
    tab?.approvalMode ?? null,
    tab?.sessionApprovalRules ?? [],
    tab?.selectedRepoId ?? null,
  ]);
}

const APPROVAL_STATE_PATCH_KEYS = [
  'approvalMode',
  'sessionApprovalRules',
  'selectedRepoId',
] as const;

/** Marks each chat whose approval state these mutations change. */
function noteApprovalStateChanges(
  scope: ChatScopeKey,
  current: CanonicalChatState,
  mutations: readonly ChatCoreMutation[],
): void {
  const tabOf = (chatId: string): PersistedChatTab | undefined =>
    current.tabsFile.tabs.find((tab) => tab.id === chatId) ??
    current.archivesFile.archived.find((entry) => entry.tab.id === chatId)?.tab;
  const mark = (chatId: string): void =>
    markChatApprovalStateChanged({ ...scope, chatId });
  for (const mutation of mutations) {
    if (mutation.type === 'tab.created') {
      if (
        approvalStateOf(tabOf(mutation.tab.id)) !==
        approvalStateOf(mutation.tab)
      )
        mark(mutation.tab.id);
    } else if (mutation.type === 'tab.metadata_patched') {
      const tab = tabOf(mutation.tabId);
      if (
        APPROVAL_STATE_PATCH_KEYS.some(
          (key) =>
            key in mutation.patch &&
            canonicalJson(mutation.patch[key] ?? null) !==
              canonicalJson(tab?.[key] ?? null),
        )
      )
        mark(mutation.tabId);
    } else if (mutation.type === 'tab.removed') {
      mark(mutation.tabId);
    } else if (mutation.type === 'archive.upserted') {
      mark(mutation.entry.tab.id);
    }
  }
}

function markImportedApprovalState(
  scope: ChatScopeKey,
  metadata: Pick<CanonicalChatState, 'tabsFile' | 'archivesFile'>,
): void {
  for (const tab of [
    ...metadata.tabsFile.tabs,
    ...metadata.archivesFile.archived.map((entry) => entry.tab),
  ])
    markChatApprovalStateChanged({ ...scope, chatId: tab.id });
}

/** V2-only scope ownership. Legacy access is confined to first-load migration;
 * no method writes an aggregate snapshot or transcript-bearing scope journal.
 */
/** How a transcript preview was streamed to its consumer. */
export interface TranscriptPreviewRead {
  /**
   * False when only the active sidecar rows were streamed because the
   * consumer already holds a projection of this exact committed prefix.
   */
  committedIncluded: boolean;
  /**
   * The active rows came from a delta journal's in-memory projection: the
   * chat's later updates can be read as deltas (`activeTurnDelta`).
   */
  journalProjected?: boolean;
}

export interface TranscriptPreviewOptions {
  /**
   * Receives the captured descriptor. Returning true streams only the active
   * sidecar rows; the committed prefix is identified, not re-read.
   */
  reuseCommittedPrefix?: (descriptor: TranscriptDescriptor) => boolean;
}

export class ChatStateV2Repository {
  private readonly scopes = new Map<string, ScopeEntry>();
  private readonly childTargetTails = new Map<string, Promise<void>>();
  private readonly delegationTails = new Map<string, Promise<void>>();
  private accepting = true;
  private readonly diagnosticListeners = new Set<
    (diagnostic: ChatStateStorageDiagnostic) => void
  >();
  private readonly diagnostics = new Map<
    string,
    ChatStateStorageDiagnostic[]
  >();
  private onCommit?: ChatStateRepositoryOptions['onCommit'];
  private startCommitWait?: ChatStateCommitWaitStarter;
  private readonly childSearchListeners = new Set<
    (event: ChildSearchDirtyNotification) => void
  >();

  public subscribeChildSearchDirty(
    listener: (event: ChildSearchDirtyNotification) => void,
  ): () => void {
    this.childSearchListeners.add(listener);
    return (): void => {
      this.childSearchListeners.delete(listener);
    };
  }

  private async notifyChildSearchDirty(
    scope: ChatScopeKey,
    target: TranscriptTarget,
  ): Promise<void> {
    if (target.kind !== 'delegation') return;
    const entry = this.entry(scope);
    const event: ChildSearchDirtyNotification = {
      scope: { ...scope },
      parentChatId: target.chatId,
      target: { ...target },
    };
    const publication = this.trackPublication(
      entry,
      entry.publishTail.then((): void => {
        for (const listener of Array.from(this.childSearchListeners)) {
          try {
            listener(event);
          } catch {
            /* A projection cannot reject durable admission. */
          }
        }
      }),
    );
    entry.publishTail = publication;
    await publication;
  }

  /**
   * A child stream write. The operation calls `noteBase` once the scope is
   * loaded. If the write then advanced the scope revision, the advance is
   * published (`reserveStreamAdvance`): when the delegation's card has V2
   * state, as a card change with the unchanged card state and the new stream
   * revision. Subscribers that apply events in revision order (the renderer)
   * then see no gap, so they do not resync the scope, and mounted readers
   * learn of the new rows.
   *
   * A group-committed write calls `noteDurable` with its record's durability.
   * The scope lease is released at admission, so other scope operations do
   * not wait for the sync, and concurrent writes share one; the write is
   * published, announced to search and answered only once it is durable.
   * With `turn: 'admission'` the write does not first wait for the syncs of
   * records admitted before it, as a transaction admission does not.
   */
  private async childSearchWrite<T>(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    operation: (
      noteBase: () => Promise<void>,
      noteDurable: (durable: Promise<void>) => void,
    ) => Promise<T>,
    turn: 'serialized' | 'admission' = 'serialized',
  ): Promise<T> {
    const capturedScope = { ...scope };
    const capturedTarget = { ...target };
    const entry = this.entry(capturedScope);
    const admitted = await this.leaseTurn(
      entry,
      turn === 'admission',
      async () => {
        let baseRevision: number | undefined;
        let durable: Promise<void> | undefined;
        const result = await operation(
          async (): Promise<void> => {
            baseRevision ??= await entry.backend.revision();
          },
          (pending): void => {
            durable = pending;
          },
        );
        const advance = await this.reserveStreamAdvance(
          entry,
          capturedScope,
          capturedTarget,
          baseRevision,
          durable,
        );
        return {
          result,
          durable,
          publication: advance?.publication,
          dirty: this.reserveChildSearchDirty(
            entry,
            capturedScope,
            capturedTarget,
          ),
        };
      },
    );
    try {
      await admitted.durable;
    } finally {
      // Always released: later publications queue behind it.
      admitted.dirty.release();
    }
    await admitted.publication;
    await admitted.dirty.publication;
    return admitted.result;
  }

  /**
   * Publishes a delegation write that advanced the scope revision: as a card
   * change when the card has V2 state, otherwise as its chat's unchanged
   * transcript descriptor (`advancedChatIds`). Every advance is published,
   * so subscribers that chain events by revision never see a gap.
   */
  private async reserveStreamAdvance(
    entry: ScopeEntry,
    scope: ChatScopeKey,
    target: Pick<DelegationStreamTarget, 'chatId'> &
      Partial<Pick<DelegationStreamTarget, 'delegationId' | 'runGeneration'>>,
    baseRevision: number | undefined,
    durable?: Promise<void>,
  ): Promise<{ publication: Promise<void> } | undefined> {
    if (baseRevision === undefined) return undefined;
    const revision = await entry.backend.revision();
    if (revision === baseRevision) return undefined;
    const delegation =
      target.delegationId !== undefined && target.runGeneration !== undefined
        ? {
            kind: 'delegation' as const,
            chatId: target.chatId,
            delegationId: target.delegationId,
            runGeneration: target.runGeneration,
          }
        : undefined;
    const descriptor = delegation
      ? await entry.backend.childStreamDescriptor(delegation)
      : undefined;
    // Reserved under the lease and wrapped, so an async return does not adopt
    // it; the caller awaits it after leaving the lease.
    const publication = this.reservePublication(
      entry,
      {
        ...scope,
        baseRevision,
        revision,
        applied: true,
        state: await entry.backend.state({ chatIds: [] }),
        record: {
          v: 1,
          revision,
          mutationId: randomUUID(),
          source: 'automation',
          occurredAt: new Date().toISOString(),
          mutations: [],
        },
        ...(delegation && descriptor?.cardState?.version === 2
          ? {
              cardChanges: [
                {
                  type: 'delegation.card_state_updated' as const,
                  chatId: delegation.chatId,
                  delegationId: delegation.delegationId,
                  runGeneration: delegation.runGeneration,
                  cardRevision: descriptor.cardState.cardRevision,
                  streamRevision: descriptor.streamRevision,
                  cardState: descriptor.cardState,
                },
              ],
            }
          : { advancedChatIds: [target.chatId] }),
      },
      durable,
    );
    return { publication };
  }

  /** Reserve durability order inside the lease, but invoke observers outside it. */
  private reserveChildSearchDirty(
    entry: ScopeEntry,
    scope: ChatScopeKey,
    target: TranscriptTarget,
  ): { release: () => void; publication: Promise<void> } {
    let release: () => void = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const event =
      target.kind === 'delegation'
        ? {
            scope: { ...scope },
            parentChatId: target.chatId,
            target: { ...target },
          }
        : undefined;
    const publication = this.trackPublication(
      entry,
      entry.publishTail.then(async (): Promise<void> => {
        await released;
        if (!event) return;
        for (const listener of Array.from(this.childSearchListeners)) {
          try {
            listener(event);
          } catch {
            /* Durable state cannot be rolled back by a projection. */
          }
        }
      }),
    );
    entry.publishTail = publication;
    return { release, publication };
  }
  /** Visual staging sweeps of unloaded scopes; a load of the same directory waits. */
  private readonly sweepLocks = new Map<string, Promise<void>>();
  /** Visual staging sweeps in flight; a drain stops them and waits for them. */
  private readonly sweeps = new Set<Promise<void>>();
  private readonly visualStagingSweep: ChatVisualStagingSweep;
  private visualStagingSweepStarted = false;
  public constructor(
    private readonly options: ChatStateV2RepositoryOptions = {},
  ) {
    this.onCommit = options.onCommit;
    this.visualStagingSweep = new ChatVisualStagingSweep(() =>
      this.runVisualStagingSweep(),
    );
    if (options.onStorageDiagnostic)
      this.diagnosticListeners.add(options.onStorageDiagnostic);
  }

  /**
   * Shared-container viewer scopes are read-only projections of a replica
   * and never promote; every other repository scope (worktrees, cowork Work
   * Entries, App Advisor, Code Review, Pipeline Editor, plan-explore, and
   * legacy scopes once migrated) does.
   */
  private promotable(scope: ChatScopeKey): boolean {
    return scope.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID;
  }

  /**
   * A format 4 outcome: its own local session diagnostic (never the format 3
   * `delta_journal_*` kinds), then the content-free telemetry.
   */
  private recordFormat4Outcome(
    directory: string,
    scope: ChatScopeKey,
    outcome: ChatFormat4Outcome,
  ): void {
    const kind =
      outcome.event === 'promoted'
        ? 'format4_promoted'
        : outcome.event === 'promotion_failed'
          ? 'format4_promotion_failed'
          : outcome.event === 'retries_exhausted'
            ? 'format4_promotion_exhausted'
            : undefined;
    if (kind !== undefined)
      this.recordDeltaJournalLifecycle(this.scopes.get(directory), scope, kind);
    this.sendFormat4Telemetry(outcome);
  }

  private sendFormat4Telemetry(outcome: ChatFormat4Outcome): void {
    try {
      this.options.format4Telemetry?.(outcome);
    } catch {
      // Telemetry never changes the storage outcome.
    }
  }

  private recordDeltaJournalLifecycle(
    entry: ScopeEntry | undefined,
    scope: ChatScopeKey,
    kind: ChatStateStorageDiagnostic['kind'],
  ): void {
    const diagnostic = deltaJournalLifecycleDiagnostic(scope, kind);
    if (entry) this.recordStorageDiagnostic(entry, diagnostic);
    else
      for (const listener of Array.from(this.diagnosticListeners))
        try {
          listener(diagnostic);
        } catch {
          // Diagnostics never change the storage outcome.
        }
  }

  private recordDeltaJournalDiagnostic(
    directory: string,
    diagnostic: DeltaJournalDiagnostic,
    fallbackScope?: ChatScopeKey,
  ): void {
    const entry = this.scopes.get(directory);
    const scope = entry?.scope ?? fallbackScope;
    if (!scope) return;
    const record = deltaJournalWriterDiagnostic(scope, diagnostic);
    if (entry) this.recordStorageDiagnostic(entry, record);
    else
      for (const listener of Array.from(this.diagnosticListeners))
        try {
          listener(record);
        } catch {
          // Diagnostics never change the storage outcome.
        }
  }

  private recordVisualOwnerLedgerInvalid(
    directory: string,
    scope: ChatScopeKey,
    reason: string,
  ): void {
    const diagnostic: ChatStateStorageDiagnostic = {
      kind: 'artifact_maintenance_failed',
      occurredAt: new Date().toISOString(),
      storageAuthority: 'v2',
      ...scope,
      journalBytes: 0,
      maintenanceReason: reason === 'io' ? 'io' : 'unknown',
    };
    const entry = this.scopes.get(directory);
    if (entry) {
      this.recordStorageDiagnostic(entry, diagnostic);
      return;
    }
    for (const listener of Array.from(this.diagnosticListeners))
      try {
        listener(diagnostic);
      } catch {
        // Invalid recovery metadata must not change repository admission.
      }
  }

  private async tryPromote(entry: ScopeEntry): Promise<void> {
    if (!this.promotable(entry.scope)) return;
    // Re-entering a checkpointed format 4 journal is handling, not promotion,
    // so it never waits on the option.
    if (!entry.backend.isDeltaJournal()) {
      try {
        if (await entry.backend.promoteToDeltaJournal())
          this.recordDeltaJournalLifecycle(
            entry,
            entry.scope,
            'delta_journal_promoted',
          );
      } catch {
        // Version 2 remains selected; later activity may trigger a bounded retry.
        this.recordDeltaJournalLifecycle(
          entry,
          entry.scope,
          'delta_journal_promotion_failed',
        );
      }
    }
    if (
      entry.backend.isDeltaJournal() &&
      entry.backend.wantsFormat4Promotion() &&
      (await entry.store.format()) === 'v3'
    ) {
      // False is a recovered promotion fault; a failed reopen must escape
      // and become a repository load/storage error, never a ready scope.
      // The backend reports the outcome, under the format 4 kinds.
      await entry.backend.promoteToFormat4();
    }
  }

  /** Promote a writable scope between operations, under its scope lease. */
  private async reconcileFormat(entry: ScopeEntry): Promise<void> {
    entry.formatReconcileQueued = false;
    if (entry.lifecycle !== 'ready' || entry.deleting || !this.accepting)
      return;
    try {
      await this.tryPromote(entry);
    } catch (cause) {
      // A promotion fault is recoverable only if the backend reopened the
      // selected authority. Failed reopen/recovery is a load error, including
      // when reconciliation was queued after an acknowledged commit.
      entry.lifecycle = 'recovery_error';
      const error = new ChatStateRepositoryLoadError(
        `Unable to load chat scope ${entry.scope.projectId}/${entry.scope.worktreeId}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
      if (!isOperatingSystemFailure(cause)) entry.loadError = error;
      throw error;
    }
    this.scheduleJournalWork(entry);
  }

  private queueFormatReconcile(entry: ScopeEntry): void {
    if (entry.formatReconcileQueued) return;
    entry.formatReconcileQueued = true;
    void this.serialized(entry, () => this.reconcileFormat(entry)).catch(() => {
      entry.formatReconcileQueued = false;
    });
  }

  private clearIdleUnloadTimer(entry: ScopeEntry): void {
    if (entry.idleUnloadTimer) clearTimeout(entry.idleUnloadTimer);
    entry.idleUnloadTimer = undefined;
  }

  private restartIdleUnloadTimer(entry: ScopeEntry): void {
    this.clearIdleUnloadTimer(entry);
    this.armIdleUnloadTimer(entry);
  }

  private armIdleUnloadTimer(entry: ScopeEntry): void {
    const delay = this.options.idleScopeUnloadMs ?? 300_000;
    // Eligibility checks transient blockers when the interval actually fires.
    if (
      delay <= 0 ||
      entry.idleUnloadTimer ||
      !this.accepting ||
      this.scopes.get(entry.store.directory) !== entry ||
      entry.inFlightTurns !== 0 ||
      !entry.backendResident ||
      (entry.lifecycle !== 'ready' && entry.lifecycle !== 'unloaded')
    )
      return;

    entry.idleUnloadTimer = setTimeout(() => {
      entry.idleUnloadTimer = undefined;
      void this.serialized(entry, async (): Promise<void> => {
        try {
          await this.unloadIdleScope(entry);
        } catch (error: unknown) {
          this.recordIdleUnloadFailure(entry, error);
        }
      }).catch((error: unknown) => {
        this.recordIdleUnloadFailure(entry, error);
        this.armIdleUnloadTimer(entry);
      });
    }, delay);
    entry.idleUnloadTimer.unref?.();
  }

  private hasRegistryLockForDirectory(directory: string): boolean {
    const prefix = `[${JSON.stringify(directory)},`;
    return (
      Array.from(this.childTargetTails.keys()).some((key) =>
        key.startsWith(prefix),
      ) ||
      Array.from(this.delegationTails.keys()).some((key) =>
        key.startsWith(prefix),
      )
    );
  }

  /** Names each reason the scope cannot unload now; empty means eligible. */
  private idleUnloadBlockers(entry: ScopeEntry, ownTurns: number): string[] {
    const blockers: Array<[boolean, string]> = [
      [!this.accepting, 'repository-draining'],
      [this.scopes.get(entry.store.directory) !== entry, 'replaced'],
      [
        entry.lifecycle !== 'ready' &&
          !(entry.lifecycle === 'unloaded' && entry.backendResident),
        `lifecycle-${entry.lifecycle}`,
      ],
      [entry.loading !== undefined, 'loading'],
      [entry.deleting !== 0, 'deleting'],
      [entry.inFlightTurns !== ownTurns, 'turns'],
      [entry.pendingPublications !== 0, 'publications'],
      [entry.outOfLeaseReservations !== 0, 'delegate-log-appends'],
      [
        this.hasRegistryLockForDirectory(entry.store.directory),
        'registry-lock',
      ],
      [entry.maintenanceChats.size !== 0, 'maintenance'],
      [entry.maintenanceDirtyChats.size !== 0, 'maintenance-dirty'],
      [entry.maintenanceDeferred.size !== 0, 'maintenance-deferred'],
      [entry.maintenanceCapacityChats.size !== 0, 'maintenance-capacity'],
      [entry.maintenanceImmediate !== undefined, 'maintenance-scheduled'],
      [entry.maintenanceCapacityWake !== undefined, 'maintenance-wake'],
      [entry.journalCheckpointQueued === true, 'journal-checkpoint'],
      [entry.formatReconcileQueued === true, 'format-reconcile'],
      [
        entry.backend.pendingJournalDurability() !== undefined,
        'journal-durability',
      ],
      [entry.previewReaders.size !== 0, 'preview-readers'],
      [this.sweepLocks.has(entry.store.directory), 'visual-sweep'],
    ];
    return blockers.filter(([blocked]) => blocked).map(([, name]) => name);
  }

  private idleUnloadSynchronousEligible(entry: ScopeEntry): boolean {
    return this.idleUnloadBlockers(entry, 1).length === 0;
  }

  /**
   * Diagnostic view of every admitted scope and what keeps it resident. It
   * reports the synchronous blockers, the pin and admitted host operations,
   * not the host's asynchronous live check.
   */
  public residencySnapshot(): Array<{
    scope: ChatScopeKey;
    lifecycle: ChatScopeLifecycle;
    backendResident: boolean;
    blockers: string[];
  }> {
    return Array.from(this.scopes.values()).map((entry) => {
      const blockers = this.idleUnloadBlockers(entry, 0);
      if (this.isScopePinned(entry)) blockers.push('pinned');
      if (this.hasAdmittedOperation(entry)) blockers.push('admitted-operation');
      return {
        scope: { ...entry.scope },
        lifecycle: entry.lifecycle,
        backendResident: entry.backendResident,
        blockers,
      };
    });
  }

  private isScopePinned(entry: ScopeEntry): boolean {
    try {
      return this.options.isScopePinned?.({ ...entry.scope }) === true;
    } catch {
      return true;
    }
  }

  private hasAdmittedOperation(entry: ScopeEntry): boolean {
    try {
      return this.options.hasAdmittedOperation?.({ ...entry.scope }) === true;
    } catch {
      return true;
    }
  }

  private async idleUnloadEligible(entry: ScopeEntry): Promise<boolean> {
    if (!this.idleUnloadSynchronousEligible(entry)) return false;

    let hasLiveDependency = false;
    try {
      hasLiveDependency =
        (await this.options.hasLiveDependency?.({ ...entry.scope })) ?? false;
    } catch {
      return false;
    }
    if (!this.idleUnloadSynchronousEligible(entry) || hasLiveDependency)
      return false;
    if (this.isScopePinned(entry) || this.hasAdmittedOperation(entry))
      return false;
    if (!this.idleUnloadSynchronousEligible(entry)) return false;

    const checkpointOnlyRead =
      entry.lifecycle === 'unloaded' &&
      (await this.checkpointOnlyChildScope(entry));
    if (!this.idleUnloadSynchronousEligible(entry)) return false;
    const indexes = checkpointOnlyRead
      ? await entry.store.indexes()
      : await entry.backend.load();
    if (!this.idleUnloadSynchronousEligible(entry)) return false;
    if (
      indexes.live.pendingQuestions?.length ||
      Object.values(indexes.live.runtimeByChatId).some((runtime) =>
        [
          'queued',
          'starting',
          'streaming',
          'awaiting_input',
          'completing',
        ].includes(runtime.status),
      )
    )
      return false;

    try {
      hasLiveDependency =
        (await this.options.hasLiveDependency?.({ ...entry.scope })) ?? false;
    } catch {
      return false;
    }
    if (!this.idleUnloadSynchronousEligible(entry) || hasLiveDependency)
      return false;
    return (
      !this.isScopePinned(entry) &&
      !this.hasAdmittedOperation(entry) &&
      this.idleUnloadSynchronousEligible(entry)
    );
  }

  private async unloadIdleScope(entry: ScopeEntry): Promise<void> {
    if (!(await this.idleUnloadEligible(entry))) return;

    this.cancelArtifactMaintenance(entry);
    this.clearJournalIdleTimer(entry);
    await this.closePreviewReaders(entry);
    if (!(await this.idleUnloadEligible(entry))) return;

    await entry.backend.disposeArtifactMaintenance();
    if (!(await this.idleUnloadEligible(entry))) return;

    await entry.backend.flush();
    if (!(await this.idleUnloadEligible(entry))) return;

    entry.backend = this.createBackend(entry.store, entry.scope);
    entry.backendResident = false;
    entry.visualStaging = undefined;
    entry.maintenanceChats.clear();
    entry.maintenanceDirtyChats.clear();
    entry.maintenanceDeferred.clear();
    entry.maintenanceCapacityChats.clear();
    entry.maintenanceFailure = undefined;
    entry.maintenanceFailedChatId = undefined;
    entry.previewCloseFailure = false;
    entry.lifecycle = 'unloaded';
  }

  private recordIdleUnloadFailure(entry: ScopeEntry, error: unknown): void {
    this.recordArtifactMaintenanceFailure(entry, '', error);
    // This was not a maintenance failure. Keep its diagnostic but do not let
    // the reporting fields permanently block a later idle retry.
    entry.maintenanceFailure = undefined;
    entry.maintenanceFailedChatId = undefined;
  }

  private clearJournalIdleTimer(entry: ScopeEntry): void {
    if (entry.journalIdleTimer) clearTimeout(entry.journalIdleTimer);
    entry.journalIdleTimer = undefined;
  }

  /** Queue a checkpoint of pending journal records under the scope lease. */
  private queueJournalCheckpoint(entry: ScopeEntry): void {
    this.clearJournalIdleTimer(entry);
    if (entry.journalCheckpointQueued) return;
    entry.journalCheckpointQueued = true;
    void this.serialized(entry, async () => {
      entry.journalCheckpointQueued = false;
      if (entry.lifecycle !== 'ready' || entry.deleting || !this.accepting)
        return;
      if (await entry.backend.checkpointPendingJournal('timer'))
        await this.requestDirtyArtifactMaintenance(entry);
    }).catch(() => {
      // A failed checkpoint leaves the records journaled; the next commit
      // re-arms the triggers and a reload recovers the writer.
      entry.journalCheckpointQueued = false;
    });
  }

  /**
   * After a commit: the size trigger checkpoints right away, otherwise the
   * idle trigger is (re)armed; a scope demoted for one large transaction,
   * or whose failed promotion's retry is due, is offered promotion again.
   */
  private scheduleJournalWork(entry: ScopeEntry): void {
    if (!this.accepting || entry.lifecycle !== 'ready' || entry.deleting) {
      this.clearJournalIdleTimer(entry);
      return;
    }
    if (entry.backend.wantsRepromotion()) this.queueFormatReconcile(entry);
    if (entry.backend.pendingJournalRecords() === 0) {
      this.clearJournalIdleTimer(entry);
      return;
    }
    if (entry.backend.journalCheckpointDue()) {
      this.queueJournalCheckpoint(entry);
      return;
    }
    this.clearJournalIdleTimer(entry);
    if (
      entry.backend.pendingPrimaryRecordCount() === 0 &&
      entry.maintenanceDirtyChats.size === 0
    )
      return;
    if (!entry.backend.journalIdleCheckpointWanted()) return;
    entry.journalIdleTimer = setTimeout(() => {
      entry.journalIdleTimer = undefined;
      this.queueJournalCheckpoint(entry);
    }, this.options.deltaJournalIdleCheckpointMs ?? 1000);
    entry.journalIdleTimer.unref?.();
  }

  private async runVisualStagingSweep(): Promise<void> {
    if (!this.accepting) return;
    const sweep = this.sweepVisualStagingScopes();
    this.sweeps.add(sweep);
    try {
      await sweep;
    } finally {
      this.sweeps.delete(sweep);
    }
  }

  private async sweepVisualStagingScopes(): Promise<void> {
    const dataDir = getDataDir();
    if (!(await chatVisualStagingScopesMarkerExists(dataDir))) return;
    if (!this.accepting) return;
    const generation = chatVisualStagingPublicationGeneration();
    let roots: string[];
    try {
      roots = [
        dataDir,
        ...(await childDirectories(join(dataDir, 'workspaces'))),
        ...(await childDirectories(join(dataDir, 'app-workspaces'))),
      ];
    } catch {
      return;
    }
    let clean = true;
    for (const root of roots) {
      if (!this.accepting) return;
      let scopeDirectories: string[];
      try {
        scopeDirectories = await childDirectories(
          join(root, 'chat-storage-v2'),
        );
      } catch {
        clean = false;
        continue;
      }
      for (const directory of scopeDirectories) {
        if (!this.accepting) return;
        try {
          const result = await this.sweepVisualStagingDirectory(directory);
          if (result.remaining > 0) clean = false;
        } catch {
          clean = false;
        }
      }
    }
    if (clean && this.accepting)
      await removeChatVisualStagingScopesMarker(generation, dataDir).catch(
        () => false,
      );
  }

  private async sweepVisualStagingDirectory(
    scopeDirectory: string,
  ): Promise<{ removed: number; remaining: number }> {
    const loaded = this.scopes.get(scopeDirectory);
    if (loaded && ['ready', 'loading', 'draining'].includes(loaded.lifecycle)) {
      return this.serialized(loaded, async () => {
        if (
          this.scopes.get(scopeDirectory) !== loaded ||
          loaded.lifecycle === 'disposed'
        )
          return this.sweepLockedVisualStagingDirectory(scopeDirectory);
        if (loaded.lifecycle === 'ready') {
          if (!loaded.visualStaging)
            throw new Error('Visual staging is not initialized');
          return loaded.visualStaging.sweep(this.visualNow());
        }
        if (
          ['unloaded', 'recovery_error', 'disposed'].includes(loaded.lifecycle)
        )
          return this.sweepLockedVisualStagingDirectory(scopeDirectory);
        return this.sweepUnloadedVisualStaging(scopeDirectory);
      });
    }
    return this.sweepLockedVisualStagingDirectory(scopeDirectory);
  }

  private async sweepLockedVisualStagingDirectory(
    scopeDirectory: string,
  ): Promise<{ removed: number; remaining: number }> {
    const run = (this.sweepLocks.get(scopeDirectory) ?? Promise.resolve())
      .catch(() => undefined)
      .then(
        (): Promise<{ removed: number; remaining: number }> =>
          this.sweepUnloadedVisualStaging(scopeDirectory),
      );
    const lock = run.then(() => undefined);
    this.sweepLocks.set(scopeDirectory, lock);
    try {
      return await run;
    } finally {
      if (this.sweepLocks.get(scopeDirectory) === lock)
        this.sweepLocks.delete(scopeDirectory);
      const entry = this.scopes.get(scopeDirectory);
      if (entry) this.restartIdleUnloadTimer(entry);
    }
  }

  private async sweepUnloadedVisualStaging(
    scopeDirectory: string,
  ): Promise<{ removed: number; remaining: number }> {
    const staging = new VisualStagingStoreImpl(
      join(scopeDirectory, 'visual-staging'),
      { now: (): number => this.visualNow() },
    );
    const now = this.visualNow();
    return staging.sweep(now);
  }

  private resolve(scope: ChatScopeKey): LegacyChatScopePaths {
    return (
      this.options.resolvePaths?.(scope) ?? {
        tabs: resolveChatTabsFilePath(scope.projectId, scope.worktreeId),
        archives: resolveChatArchivesFilePath(
          scope.projectId,
          scope.worktreeId,
        ),
        journal: resolveChatJournalFilePath(scope.projectId, scope.worktreeId),
      }
    );
  }

  private createBackend(
    store: ChatStorageV2,
    scope: ChatScopeKey,
  ): ChatStateV2Backend {
    const format4Promotion = this.options.format4Promotion;
    return new ChatStateV2Backend(store, {
      enableFormat4: this.options.enableFormat4,
      onFormat4Outcome: (outcome): void =>
        this.recordFormat4Outcome(store.directory, scope, outcome),
      ...(format4Promotion
        ? { format4Promotion: (): boolean => format4Promotion(scope) }
        : {}),
      deltaJournal: {
        onBoundary: this.options.deltaJournalOnBoundary,
        ...deltaJournalBackendOptions(this.options, (diagnostic): void =>
          this.recordDeltaJournalDiagnostic(store.directory, diagnostic),
        ),
        onCheckpointed: (rotation): void => {
          // A Work Entry summary is fingerprinted by its journal's
          // modification time, which a checkpoint changes.
          void import('../lib/cowork-work-entries')
            .then(({ refreshWorkEntrySummaryStamp }) =>
              refreshWorkEntrySummaryStamp(
                scope.projectId,
                scope.worktreeId,
                rotation,
              ),
            )
            .catch(() => undefined);
        },
      },
      onVisualOwnerLedgerInvalid: ({ reason }): void =>
        this.recordVisualOwnerLedgerInvalid(store.directory, scope, reason),
      testHooks: {
        storageCheckpoint: this.options.testHooks?.storageCheckpoint,
      },
    });
  }

  private entry(scope: ChatScopeKey, readmit = true): ScopeEntry {
    const paths = this.resolve(scope);
    const store = ChatStorageV2.fromLegacyPaths(paths, {
      maxManifestVersion: 4,
    });
    let entry = this.scopes.get(store.directory);
    // A completed deletion leaves a disposed entry so continuations that
    // still hold it drain. Once no deletion is in flight, the same scope id
    // (a recreated worktree or Work Entry) admits again as a fresh scope.
    if (readmit && entry?.lifecycle === 'disposed' && !entry.deleting)
      entry = undefined;
    if (!entry) {
      if (!this.accepting) throw new Error('Chat state repository is draining');
      entry = {
        scope,
        store,
        paths,
        backend: this.createBackend(store, scope),
        backendResident: false,
        lifecycle: 'unloaded',
        deleting: 0,
        tail: Promise.resolve(),
        inFlightTurns: 0,
        outOfLeaseReservations: 0,
        publishTail: Promise.resolve(),
        pendingPublications: 0,
        previewReaders: new Set(),
        maintenanceChats: new Set(),
        maintenanceDirtyChats: new Set(),
        maintenanceDeferred: new Set(),
        maintenanceCapacityChats: new Set(),
      };
      this.scopes.set(store.directory, entry);
      // Lets the local chat-storage activity summaries name their scope.
      registerChatStorageScope(store.directory, scope);
    }
    return entry;
  }
  /**
   * One turn of the scope lease. Commits admitted for group commit
   * ({@link admission}) may still be waiting for their journal sync: the
   * backend's state is then ahead of the journal, so the operation starts
   * only once they are durable (or their batch failed and the scope will
   * reload). Reads, captures, copies, imports, checkpoints, promotion,
   * demotion, eviction, deletion and drain therefore never run beside an
   * open batch. With nothing pending the operation starts as before.
   */
  private async serialized<T>(
    entry: ScopeEntry,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.clearIdleUnloadTimer(entry);
    entry.inFlightTurns += 1;
    const next = entry.tail.then(() => {
      const pending = entry.backend.pendingJournalDurability();
      return pending ? pending.then(operation, operation) : operation();
    });
    const settled = next.then(
      (result): T => {
        this.finishTurn(entry);
        return result;
      },
      (error: unknown): never => {
        this.finishTurn(entry);
        throw error;
      },
    );
    entry.tail = settledLease(settled);
    return settled;
  }

  /**
   * A turn of the scope lease for a commit that may be group committed: it
   * does not wait for the journal sync of the commits admitted before it,
   * so it is prepared against their state and can share their next sync.
   * The lease still orders admissions one at a time.
   */
  private async admission<T>(
    entry: ScopeEntry,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.clearIdleUnloadTimer(entry);
    entry.inFlightTurns += 1;
    const next = entry.tail.then(operation);
    const settled = next.then(
      (result): T => {
        this.finishTurn(entry);
        return result;
      },
      (error: unknown): never => {
        this.finishTurn(entry);
        throw error;
      },
    );
    entry.tail = settledLease(settled);
    return settled;
  }

  /** A scope lease turn; an admission turn does not wait for group commits. */
  private leaseTurn<T>(
    entry: ScopeEntry,
    admission: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    return admission
      ? this.admission(entry, operation)
      : this.serialized(entry, operation);
  }

  private finishTurn(entry: ScopeEntry): void {
    entry.inFlightTurns -= 1;
    if (entry.inFlightTurns === 0) this.armIdleUnloadTimer(entry);
  }

  private async closePreviewReaders(entry: ScopeEntry): Promise<void> {
    const readers = Array.from(entry.previewReaders);
    const outcomes = await Promise.allSettled(
      readers.map((reader) => reader.close()),
    );
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled')
        entry.previewReaders.delete(readers[index]);
    });
    const failures = outcomes
      .filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected',
      )
      .map((outcome): unknown => outcome.reason);
    if (failures.length) {
      this.recordPreviewCloseFailure(entry);
      throw aggregateFailure(failures, 'Transcript preview close failed');
    }
    entry.previewCloseFailure = false;
  }

  private recordPreviewCloseFailure(entry: ScopeEntry): void {
    if (entry.previewCloseFailure) return;
    entry.previewCloseFailure = true;
    const diagnostic: ChatStateStorageDiagnostic = {
      kind: 'transcript_preview_close_failed',
      occurredAt: new Date().toISOString(),
      storageAuthority: 'v2',
      ...entry.scope,
      journalBytes: 0,
    };
    const retained = this.diagnostics.get(entry.store.directory) ?? [];
    this.diagnostics.set(
      entry.store.directory,
      [...retained, diagnostic].slice(-64),
    );
    for (const listener of Array.from(this.diagnosticListeners))
      try {
        listener(diagnostic);
      } catch {
        // Operational diagnostics cannot alter canonical storage work.
      }
  }

  private recordArtifactMaintenanceFailure(
    entry: ScopeEntry,
    chatId: string,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const reason: NonNullable<ChatStateStorageDiagnostic['maintenanceReason']> =
      error instanceof ArtifactMaintenanceCapacityError
        ? 'capacity'
        : isOperatingSystemFailure(error)
          ? 'io'
          : message.includes('replay is pending')
            ? 'pending_replay'
            : message.includes('sidecar') || message.includes('transcript')
              ? 'invalid_sidecar'
              : 'unknown';
    const changed =
      entry.maintenanceFailedChatId !== chatId ||
      entry.maintenanceFailure !== message;
    entry.maintenanceFailedChatId = chatId;
    entry.maintenanceFailure = message;
    if (!changed) return;
    const diagnostic: ChatStateStorageDiagnostic = {
      kind: 'artifact_maintenance_failed',
      occurredAt: new Date().toISOString(),
      storageAuthority: 'v2',
      ...entry.scope,
      journalBytes: 0,
      maintenanceReason: reason,
    };
    const retained = this.diagnostics.get(entry.store.directory) ?? [];
    this.diagnostics.set(
      entry.store.directory,
      [...retained, diagnostic].slice(-64),
    );
    for (const listener of Array.from(this.diagnosticListeners))
      try {
        listener(diagnostic);
      } catch {
        // Operational diagnostics cannot alter canonical storage work.
      }
  }

  private cancelArtifactMaintenance(entry: ScopeEntry): void {
    if (entry.maintenanceImmediate) clearImmediate(entry.maintenanceImmediate);
    entry.maintenanceImmediate = undefined;
    entry.maintenanceCapacityWake?.();
    entry.maintenanceCapacityWake = undefined;
  }

  private armArtifactMaintenanceCapacity(entry: ScopeEntry): void {
    if (
      entry.maintenanceCapacityWake ||
      !entry.maintenanceCapacityChats.size ||
      !this.accepting ||
      entry.lifecycle !== 'ready' ||
      entry.deleting
    )
      return;
    entry.maintenanceCapacityWake =
      entry.backend.onArtifactMaintenanceCapacityAvailable(() => {
        entry.maintenanceCapacityWake?.();
        entry.maintenanceCapacityWake = undefined;
        if (!this.accepting || entry.lifecycle !== 'ready') return;
        for (const chatId of Array.from(entry.maintenanceCapacityChats)) {
          entry.maintenanceDeferred.delete(chatId);
          entry.maintenanceChats.add(chatId);
        }
        entry.maintenanceCapacityChats.clear();
        this.armArtifactMaintenance(entry);
      });
  }

  private async runArtifactMaintenanceChunk(entry: ScopeEntry): Promise<void> {
    if (entry.lifecycle !== 'ready' || entry.deleting) return;
    const chatId = entry.maintenanceChats.values().next().value;
    if (chatId === undefined) return;
    if (!entry.backend.artifactMaintenanceEligible(chatId)) {
      entry.maintenanceChats.delete(chatId);
      try {
        await entry.backend.abandonArtifactMaintenance(chatId);
      } catch (error) {
        this.recordArtifactMaintenanceFailure(entry, chatId, error);
      }
      return;
    }
    let progress: Awaited<ReturnType<ChatStateV2Backend['maintainArtifacts']>>;
    try {
      progress = await entry.backend.maintainArtifacts(chatId, 64 * 1024);
    } catch (error) {
      entry.maintenanceChats.delete(chatId);
      entry.maintenanceDeferred.add(chatId);
      if (!(error instanceof ArtifactMaintenanceCapacityError))
        this.recordArtifactMaintenanceFailure(entry, chatId, error);
      // Every scope shares the maintenance slots, so waiting for one is
      // backpressure, not a failure: it is retried when a slot frees and
      // never reported as `artifact_maintenance_failed`.
      else if (this.accepting && entry.lifecycle === 'ready') {
        entry.maintenanceCapacityChats.add(chatId);
        this.armArtifactMaintenanceCapacity(entry);
      }
      throw error;
    }
    if (progress.complete) {
      entry.maintenanceChats.delete(chatId);
      entry.maintenanceDirtyChats.delete(chatId);
    }
    if (entry.maintenanceFailedChatId === chatId) {
      entry.maintenanceFailedChatId = undefined;
      entry.maintenanceFailure = undefined;
    }
  }

  private armArtifactMaintenance(entry: ScopeEntry): void {
    if (
      entry.maintenanceImmediate ||
      !this.accepting ||
      entry.lifecycle !== 'ready' ||
      entry.deleting ||
      !entry.maintenanceChats.size
    )
      return;
    entry.maintenanceImmediate = setImmediate(() => {
      entry.maintenanceImmediate = undefined;
      if (!this.accepting) return;
      void this.serialized(entry, () => this.runArtifactMaintenanceChunk(entry))
        .then(() => this.armArtifactMaintenance(entry))
        .catch(() => {
          // Keep candidates for a later eligible trigger; never spin on EIO.
          this.armArtifactMaintenance(entry);
        });
    });
  }

  private async requestArtifactMaintenance(
    entry: ScopeEntry,
    hints?: readonly string[],
  ): Promise<void> {
    if (!this.accepting || entry.lifecycle !== 'ready' || entry.deleting)
      return;
    try {
      // Startup/import sweeps must survive a pending journal as well. The
      // eligible probe can return no chats until its checkpoint is clear.
      if (hints === undefined) {
        const indexes = await entry.backend.load();
        for (const tab of indexes.live.tabs)
          entry.maintenanceDirtyChats.add(tab.id);
        for (const archive of indexes.archive.archived)
          entry.maintenanceDirtyChats.add(archive.tab.id);
      }
      const tracked = hints
        ? new Set(hints)
        : new Set([
            ...Array.from(entry.maintenanceChats),
            ...Array.from(entry.maintenanceDeferred),
            ...Array.from(entry.maintenanceCapacityChats),
            ...(entry.maintenanceFailedChatId
              ? [entry.maintenanceFailedChatId]
              : []),
          ]);
      for (const chatId of Array.from(tracked)) {
        if (
          !entry.maintenanceChats.has(chatId) &&
          !entry.maintenanceDirtyChats.has(chatId) &&
          !entry.maintenanceDeferred.has(chatId) &&
          !entry.maintenanceCapacityChats.has(chatId) &&
          entry.maintenanceFailedChatId !== chatId
        )
          continue;
        if (!entry.backend.artifactMaintenanceChatRetired(chatId)) continue;
        entry.maintenanceChats.delete(chatId);
        entry.maintenanceDirtyChats.delete(chatId);
        entry.maintenanceDeferred.delete(chatId);
        entry.maintenanceCapacityChats.delete(chatId);
        if (entry.maintenanceFailedChatId === chatId) {
          entry.maintenanceFailedChatId = undefined;
          entry.maintenanceFailure = undefined;
        }
        try {
          await entry.backend.abandonArtifactMaintenance(chatId);
        } catch (error) {
          this.recordArtifactMaintenanceFailure(entry, chatId, error);
        }
      }
      const pending =
        await entry.backend.pendingArtifactMaintenanceChats(hints);
      for (const chatId of pending) {
        entry.maintenanceDirtyChats.add(chatId);
        entry.maintenanceDeferred.delete(chatId);
        entry.maintenanceCapacityChats.delete(chatId);
        entry.maintenanceChats.add(chatId);
      }
      if (entry.backend.pendingJournalRecords() === 0)
        for (const chatId of hints ?? Array.from(entry.maintenanceDirtyChats))
          if (
            !pending.includes(chatId) &&
            entry.backend.artifactMaintenanceEligible(chatId)
          )
            entry.maintenanceDirtyChats.delete(chatId);
      if (!entry.maintenanceCapacityChats.size) {
        entry.maintenanceCapacityWake?.();
        entry.maintenanceCapacityWake = undefined;
      }
      this.armArtifactMaintenance(entry);
    } catch (error) {
      this.recordArtifactMaintenanceFailure(entry, '', error);
    }
  }
  private async requestDirtyArtifactMaintenance(
    entry: ScopeEntry,
  ): Promise<void> {
    if (entry.maintenanceDirtyChats.size > 0)
      await this.requestArtifactMaintenance(
        entry,
        Array.from(entry.maintenanceDirtyChats),
      );
  }
  private async load(scope: ChatScopeKey, entry: ScopeEntry): Promise<void> {
    if (entry.lifecycle === 'disposed' || entry.lifecycle === 'draining')
      throw scopeDrainingError();
    if (entry.lifecycle === 'ready') return;
    // A failed recovery is sticky: re-running migration on every access would
    // repeat the same expensive, failing work. releaseScope is the retry.
    if (entry.loadError) throw entry.loadError;
    if (!entry.loading) {
      entry.lifecycle = 'loading';
      entry.loading = (async (): Promise<void> => {
        let transient = false;
        try {
          // A visual staging sweep of this directory finishes first.
          await this.sweepLocks
            .get(entry.store.directory)
            ?.catch(() => undefined);
          if (
            (await entry.store.authority()) === 'v1' &&
            (await this.options.hasLiveDependency?.(scope))
          ) {
            transient = true;
            throw classifyError(
              new Error('Chat migration is waiting for active turns to settle'),
              'external.service_unavailable',
            );
          }
          const migration = ['v3', 'v4'].includes(await entry.store.format())
            ? undefined
            : await migrateLegacyChatScope(entry.store, entry.paths);
          if (migration?.revisionGapRecovery)
            this.recordStorageDiagnostic(entry, {
              kind: 'legacy_chat_revision_gap_recovered',
              occurredAt: new Date().toISOString(),
              storageAuthority: 'v2',
              ...scope,
              journalBytes: 0,
              revisionGap: migration.revisionGapRecovery,
            });
          const indexes = await entry.backend.load();
          const visualStaging = new VisualStagingStoreImpl(
            join(entry.store.directory, 'visual-staging'),
            { now: (): number => this.visualNow() },
          );
          await visualStaging.initialize(this.visualNow());
          entry.visualStaging = visualStaging;
          // Defer the local recovery module to break the chat-state/delegation cycle.
          // Verified in build:mac: Vite folds this local import into the packaged main bundle.
          const {
            hasDelegationRecoveryRecords,
            loadDelegationRecoveryRecords,
            loadDelegationRecoveryMutations,
          } = await import('../agents/delegation/recovery');
          const records = (await hasDelegationRecoveryRecords(scope))
            ? await loadDelegationRecoveryRecords(scope)
            : [];
          // Recovery changes only the parent chat of a retained record.
          const parents = new Set(
            records.map((record) => record.parent.chatId),
          );
          const chatIds = [
            ...indexes.live.tabs.map((tab) => tab.id),
            ...indexes.archive.archived.map((archive) => archive.tab.id),
          ].filter((chatId) => parents.has(chatId));
          if (chatIds.length > 0) {
            const state = await entry.backend.state({
              chatIds,
              fullTranscript: true,
              rawStreamCards: true,
            });
            const mutations = await loadDelegationRecoveryMutations(
              scope,
              state.tabsFile,
              state.archivesFile,
              { readMetadata: this.options.delegationReadMetadata },
              records,
            );
            if (mutations.length > 0) {
              const digest = createHash('sha256')
                .update(JSON.stringify(mutations))
                .digest('hex');
              await entry.backend.transact(() => mutations, {
                source: 'provider',
                chatIds,
                fullTranscript: true,
                mutationId: `delegation-recovery:${digest}`,
              });
            }
          }
          entry.lifecycle = 'ready';
          entry.backendResident = true;
          // Always promote writable scopes after any pending
          // version 2 transaction and the recovery above.
          await this.tryPromote(entry);
          await this.requestArtifactMaintenance(entry);
          this.scheduleJournalWork(entry);
        } catch (cause) {
          entry.visualStaging = undefined;
          entry.lifecycle = 'recovery_error';
          if (cause instanceof ChatStorageNewerFormatError)
            await this.recordNewerFormat(entry, scope);
          const error = new ChatStateRepositoryLoadError(
            `Unable to load chat scope ${scope.projectId}/${scope.worktreeId}: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
          // Waiting on a live host settles on its own, and an operating-system
          // I/O failure (EIO, EBUSY, EMFILE, ...) may clear; the next access
          // retries those. Integrity failures stay sticky until releaseScope.
          if (!transient && !isOperatingSystemFailure(cause))
            entry.loadError = error;
          throw error;
        } finally {
          entry.loading = undefined;
        }
      })();
    }
    try {
      await entry.loading;
    } finally {
      this.startVisualStagingSweep();
    }
  }

  private visualNow(): number {
    return this.options.now?.() ?? Date.now();
  }

  private startVisualStagingSweep(): void {
    if (this.visualStagingSweepStarted || !this.accepting) return;
    this.visualStagingSweepStarted = true;
    this.visualStagingSweep.start();
  }
  /** Ordered post-commit publication. Observers and projections cannot roll
   * back durable state, so a failing listener never rejects an applied commit.
   */
  private publish(entry: ScopeEntry, commit: ChatStateCommit): Promise<void> {
    return this.orderedPublication(entry, commit, undefined);
  }

  /**
   * Reserve a commit's place in the publication order while its lease turn
   * still runs, so the order is the revision order by construction even
   * when commits become durable together (group commit). The commit is
   * published once `durable` resolves; a commit whose batch failed was never
   * made durable and is not published. Used for delta-journal scopes; a
   * version 2 scope publishes after its lease turn, as before.
   */
  private reservePublication(
    entry: ScopeEntry,
    commit: ChatStateCommit,
    durable: Promise<void> | undefined,
    diagnostic?: ChatStateStorageDiagnostic,
  ): Promise<void> {
    return this.orderedPublication(entry, commit, durable, diagnostic);
  }

  /**
   * Queues a commit's publication behind the scope's earlier ones. Its timing
   * starts here, so the wait for earlier publications (`queue_wait`) and for
   * its batch (`required_durability`) are attributed before observers run.
   * A queue wait names the commit publication ahead of it; a child search
   * notification ahead counts in the depth but is not a named operation.
   */
  private orderedPublication(
    entry: ScopeEntry,
    commit: ChatStateCommit,
    durable: Promise<void> | undefined,
    diagnostic?: ChatStateStorageDiagnostic,
  ): Promise<void> {
    let wait: ChatWaitOperation | undefined;
    try {
      wait = this.startCommitWait?.(commit);
      wait?.enterQueue(entry.pendingPublications, () => entry.publishingWait);
    } catch {
      // Diagnostics cannot change the publication they observe.
    }
    const publication = this.trackPublication(
      entry,
      entry.publishTail.then(async (): Promise<void> => {
        entry.publishingWait = wait;
        try {
          if (durable) {
            wait?.phase('required_durability');
            try {
              await durable;
            } catch {
              wait?.failPhase();
              wait?.finish('failed');
              return;
            }
          }
          try {
            if (diagnostic) this.recordStorageDiagnostic(entry, diagnostic);
            await this.onCommit?.(commit, wait);
            wait?.finish('completed');
          } catch {
            // Post-commit observers cannot reject a durable commit.
            wait?.finish('failed');
          }
        } finally {
          if (entry.publishingWait === wait) entry.publishingWait = undefined;
        }
      }),
    );
    entry.publishTail = publication;
    return publication;
  }

  /** Count both reserved and currently running publications as scope users. */
  private trackPublication(
    entry: ScopeEntry,
    publication: Promise<void>,
  ): Promise<void> {
    this.clearIdleUnloadTimer(entry);
    entry.pendingPublications += 1;
    void publication.then(
      (): void => this.finishPublication(entry),
      (): void => this.finishPublication(entry),
    );
    return publication;
  }

  private finishPublication(entry: ScopeEntry): void {
    entry.pendingPublications -= 1;
    if (entry.pendingPublications === 0) this.restartIdleUnloadTimer(entry);
  }
  private assertWritable(
    entry: ScopeEntry,
    allowDuringScopeDeletion = false,
  ): void {
    if (
      !this.accepting ||
      entry.lifecycle === 'draining' ||
      entry.lifecycle === 'disposed'
    )
      throw new Error('Chat state repository is draining');
    if (entry.deleting && !allowDuringScopeDeletion)
      throw new Error('Chat scope is being deleted');
  }

  /** `startWait` times each commit from its publication reservation. */
  public setCommitListener(
    listener: ChatStateCommitListener,
    startWait?: ChatStateCommitWaitStarter,
  ): void {
    this.onCommit = listener;
    this.startCommitWait = startWait;
  }
  public async getState(
    scope: ChatScopeKey,
    selection: ChatReadSelection = {},
  ): Promise<CanonicalChatState> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.state(selection);
    });
  }
  public async getRevision(scope: ChatScopeKey): Promise<number> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.revision();
    });
  }
  /**
   * Resolve generation-store policy from the authority selected by the
   * repository after its ordered recovery and promotion work has completed.
   */
  public async generationStoreReadiness(scope: ChatScopeKey): Promise<{
    formatVersion: 1 | 2 | 3 | 4;
    enableFormat4: boolean;
    /** Whether this format 3 scope may still promote: its attempt is due. */
    promotes: boolean;
  }> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      const wantsPromotion = async (): Promise<boolean> =>
        (await entry.store.format()) === 'v3' &&
        this.promotable(scope) &&
        entry.backend.wantsFormat4Promotion();
      // A scope loaded before promotion was allowed promotes here, on the
      // same path a load takes, instead of refusing its spawns until reload.
      if (await wantsPromotion()) await this.reconcileFormat(entry);
      const format = await entry.store.format();
      const formatVersion =
        format === 'v4' ? 4 : format === 'v3' ? 3 : format === 'v2' ? 2 : 1;
      return {
        formatVersion,
        enableFormat4: this.options.enableFormat4 === true,
        promotes: await wantsPromotion(),
      };
    });
  }
  public async assertExpectedRevision(
    scope: ChatScopeKey,
    expected: number | undefined,
  ): Promise<number> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      this.assertWritable(entry);
      await this.load(scope, entry);
      const actual = (await entry.backend.load()).live.revision;
      if (expected !== undefined && expected !== actual)
        throw new ChatStateRevisionConflictError(expected, actual);
      return actual;
    });
  }
  private async recovery(scope: ChatScopeKey): Promise<ChatRecoveryIndex> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return (await entry.backend.load()).recovery;
    });
  }
  public async getReceipt(
    scope: ChatScopeKey,
    commandId: string,
  ): Promise<PersistedCommandReceipt | undefined> {
    return (await this.recovery(scope)).receipts.find(
      (receipt) => receipt.commandId === commandId,
    );
  }
  public async getPortalSendReceipt(
    scope: ChatScopeKey,
    userMessageId: string,
  ): Promise<PersistedCommandReceipt | undefined> {
    return (await this.recovery(scope)).receipts.find(
      (receipt) => receipt.portalSend?.userMessageId === userMessageId,
    );
  }
  public async hasMutation(
    scope: ChatScopeKey,
    mutationId: string,
  ): Promise<boolean> {
    return (await this.recovery(scope)).mutationIds.includes(mutationId);
  }
  public async hasRemovedTab(
    scope: ChatScopeKey,
    tabId: string,
  ): Promise<boolean> {
    return (await this.recovery(scope)).removedTabIds.includes(tabId);
  }
  public async hasRemovedMessage(
    scope: ChatScopeKey,
    messageId: string,
  ): Promise<boolean> {
    return (await this.recovery(scope)).removedMessageIds.includes(messageId);
  }

  public async transact(
    scope: ChatScopeKey,
    mutations: readonly ChatCoreMutation[],
    options: V2MutationOptions,
  ): Promise<ChatStateCommit> {
    return this.transactWith(scope, () => [...mutations], options);
  }

  public async stageVisual(
    scope: ChatScopeKey,
    target: VisualStagingTarget,
    document: StageVisualDocument,
  ): Promise<VisualStagingSidecar> {
    const entry = this.entry(scope);
    this.assertWritable(entry);
    return this.serialized(entry, async () => {
      this.assertWritable(entry);
      await this.load(scope, entry);
      const staging = entry.visualStaging;
      if (!staging) throw new Error('Visual staging is not initialized');
      const indexes = await entry.backend.load();
      const chatExists =
        indexes.live.tabs.some((tab) => tab.id === target.chatId) ||
        indexes.archive.archived.some(
          (archive) => archive.tab.id === target.chatId,
        );
      if (!chatExists) throw new Error('Unknown chat');
      if (hasVisualOwner(indexes.recovery, target.chatId, document.visualId))
        throw new Error('Visual id is already owned by a transcript block');
      return withChatVisualStagingScopesMarker(
        () => staging.stage(target, document, this.visualNow()),
        getDataDir(),
      );
    });
  }

  public async transactWith(
    scope: ChatScopeKey,
    build: (
      current: CanonicalChatState,
      revision: number,
      context: ChatStateTransactionContext,
    ) => ChatCoreMutation[] | Promise<ChatCoreMutation[]>,
    options: ChatStateTransactionOptions,
  ): Promise<ChatStateCommit> {
    return this.transactInternal(scope, build, options);
  }

  public async transactProviderEventWith(
    scope: ChatScopeKey,
    build: (
      current: CanonicalChatState,
      revision: number,
      context: ChatStateTransactionContext,
    ) => ChatCoreMutation[] | Promise<ChatCoreMutation[]>,
    options: ChatStateTransactionOptions,
    admission: { resolveToolKey: VisualToolIdentityResolver },
  ): Promise<ChatStateCommit> {
    return this.transactInternal(scope, build, options, admission);
  }

  private async transactInternal(
    scope: ChatScopeKey,
    build: (
      current: CanonicalChatState,
      revision: number,
      context: ChatStateTransactionContext,
    ) => ChatCoreMutation[] | Promise<ChatCoreMutation[]>,
    options: ChatStateTransactionOptions,
    visualAdmission?: { resolveToolKey: VisualToolIdentityResolver },
  ): Promise<ChatStateCommit> {
    const { onQueued, ...mutationOptions } = options;
    const entry = this.entry(scope);
    this.assertWritable(entry, options.allowDuringScopeDeletion);
    const tracked: typeof build = (current, revision, context) => {
      const built = build(current, revision, context);
      if (Array.isArray(built)) {
        noteApprovalStateChanges(scope, current, built);
        return built;
      }
      return built.then((mutations) => {
        noteApprovalStateChanges(scope, current, mutations);
        return mutations;
      });
    };
    const turn = async (): Promise<{
      commit: ChatStateCommit;
      durable?: Promise<void>;
      published?: Promise<void>;
      promotedVisuals?: PromotedVisual[];
      deletedChatIds: string[];
    }> => {
      this.assertWritable(entry, options.allowDuringScopeDeletion);
      await this.load(scope, entry);
      const indexes = await entry.backend.load();
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== indexes.live.revision &&
        !indexes.recovery.mutationIds.includes(options.mutationId ?? '')
      )
        throw new ChatStateRevisionConflictError(
          options.expectedRevision,
          indexes.live.revision,
        );
      const journaled = entry.backend.isDeltaJournal();
      const staging = entry.visualStaging;
      if (visualAdmission && !staging)
        throw new Error('Visual staging is not initialized');
      const providerAdmission: ProviderVisualAdmission | undefined =
        visualAdmission && staging
          ? {
              staging,
              resolveToolKey: visualAdmission.resolveToolKey,
              now: () => this.visualNow(),
            }
          : undefined;
      const { commit: result, durable } = await entry.backend.admit(
        tracked,
        {
          ...mutationOptions,
          mutationId:
            options.mutationId ?? this.options.createId?.() ?? randomUUID(),
        },
        providerAdmission,
      );
      if (result.applied) {
        const appendOnly = new Set(result.appendOnlyChatIds ?? []);
        for (const mutation of result.record.mutations) {
          if (
            !mutationCanDropArtifactReference(
              mutation,
              'chatId' in mutation && appendOnly.has(mutation.chatId),
            )
          )
            continue;
          if ('chatId' in mutation)
            entry.maintenanceDirtyChats.add(mutation.chatId);
          else if (mutation.type === 'tab.created')
            entry.maintenanceDirtyChats.add(mutation.tab.id);
          else if (mutation.type === 'tab.removed')
            entry.maintenanceDirtyChats.add(mutation.tabId);
          else if (mutation.type === 'archive.upserted')
            entry.maintenanceDirtyChats.add(mutation.entry.tab.id);
        }
        // Runtime/status commits only resume previously deferred destructive
        // work; they cannot make a clean chat's references obsolete. This also
        // avoids rediscovery after a bounded maintenance slot was evicted.
        await this.requestDirtyArtifactMaintenance(entry);
      }
      const commit = { ...result, ...scope };
      // Prepared-write proof is backend-internal, not a new broadcast field.
      delete commit.appendOnlyChatIds;
      const deletedChatIds = result.applied
        ? removedVisualChats(result.record.mutations, result.state)
        : [];
      if (!durable && !journaled)
        return {
          commit,
          deletedChatIds,
          ...(result.promotedVisuals
            ? { promotedVisuals: result.promotedVisuals }
            : {}),
        };
      return {
        commit,
        deletedChatIds,
        ...(result.promotedVisuals
          ? { promotedVisuals: result.promotedVisuals }
          : {}),
        ...(durable ? { durable } : {}),
        ...(commit.applied
          ? {
              published: this.reservePublication(
                entry,
                commit,
                durable,
                this.commitDiagnostic(scope, commit),
              ),
            }
          : {}),
      };
    };
    // A commit whose publish hooks must run at the exact write boundary is
    // written alone, after every commit admitted before it is durable.
    const admitted =
      options.beforePublish || options.preparePublish
        ? this.serialized(entry, turn)
        : this.admission(entry, turn);
    // Its turn of the lease is queued: a caller may now submit the commit
    // that follows it in the caller's own order.
    onQueued?.();
    const { commit, durable, published, promotedVisuals, deletedChatIds } =
      await admitted;
    this.scheduleJournalWork(entry);
    let publication = published;
    if (commit.applied && !durable && !publication) {
      this.recordStorageDiagnostic(entry, this.commitDiagnostic(scope, commit));
      publication = this.publish(entry, commit);
    }
    if (publication && (promotedVisuals?.length || deletedChatIds.length))
      this.scheduleVisualStagingCleanup(
        entry,
        publication,
        durable,
        promotedVisuals ?? [],
        deletedChatIds,
      );
    // Group commit: acknowledged only once the commit's batch is durable.
    if (durable) {
      await durable;
      // Activity-gated promotion retries are signalled only by durable
      // commits, not the optimistic admission above.
      this.scheduleJournalWork(entry);
    }
    if (publication) await publication;
    return commit;
  }

  private scheduleVisualStagingCleanup(
    entry: ScopeEntry,
    publication: Promise<void>,
    durable: Promise<void> | undefined,
    promotedVisuals: readonly PromotedVisual[],
    deletedChatIds: readonly string[],
  ): void {
    const cleanup = (): void => {
      void this.serialized(entry, () =>
        this.cleanupVisualStaging(entry, promotedVisuals, deletedChatIds),
      ).catch((error: unknown) =>
        this.recordVisualStagingFailure(entry, error),
      );
    };
    const publicationFailed = (error: unknown): void =>
      this.recordVisualStagingFailure(entry, error);
    if (durable) {
      void durable.then(
        () => void publication.then(cleanup, publicationFailed),
        () => undefined,
      );
      return;
    }
    void publication.then(cleanup, publicationFailed);
  }

  private async cleanupVisualStaging(
    entry: ScopeEntry,
    promotedVisuals: readonly PromotedVisual[],
    deletedChatIds: readonly string[],
  ): Promise<void> {
    if (
      entry.lifecycle !== 'ready' ||
      this.scopes.get(entry.store.directory) !== entry
    )
      return;
    const staging = entry.visualStaging;
    if (!staging) return;
    const removedVisuals = await Promise.allSettled(
      promotedVisuals.map((visual) => staging.remove(visual.visualId)),
    );
    removedVisuals.forEach((outcome) => {
      if (outcome.status === 'rejected')
        this.recordVisualStagingFailure(entry, outcome.reason);
    });
    const removedChats = await Promise.allSettled(
      deletedChatIds.map((chatId) => staging.removeChat(chatId)),
    );
    removedChats.forEach((outcome) => {
      if (outcome.status === 'rejected')
        this.recordVisualStagingFailure(entry, outcome.reason);
    });
  }

  private recordVisualStagingFailure(entry: ScopeEntry, error: unknown): void {
    this.recordStorageDiagnostic(entry, {
      kind: 'artifact_maintenance_failed',
      occurredAt: new Date().toISOString(),
      storageAuthority: 'v2',
      ...entry.scope,
      journalBytes: 0,
      maintenanceReason: isOperatingSystemFailure(error) ? 'io' : 'unknown',
    });
  }

  private commitDiagnostic(
    scope: ChatScopeKey,
    commit: ChatStateCommit,
  ): ChatStateStorageDiagnostic {
    return {
      kind: 'checkpoint_completed',
      occurredAt: commit.record.occurredAt,
      storageAuthority: 'v2',
      ...scope,
      journalBytes: 0,
      recordCount: 1,
    };
  }
  /**
   * A delta-journal scope this build reads but never writes: record the
   * refusal, and any unacknowledged journal tail replay excludes, as
   * content-free session diagnostics. Diagnostics never change the load.
   */
  private async recordNewerFormat(
    entry: ScopeEntry,
    scope: ChatScopeKey,
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    let summary: DeltaJournalSummary | undefined;
    try {
      summary = await summarizeDeltaJournal({
        directory: entry.store.directory,
        scopeId: entry.store.descriptor().scopeId,
      });
    } catch {
      // An unreadable journal is still a refused newer format.
    }
    this.sendFormat4Telemetry({ event: 'newer_format_refused' });
    this.recordStorageDiagnostic(entry, {
      kind: 'delta_journal_newer_format',
      occurredAt,
      storageAuthority: 'v2',
      ...scope,
      journalBytes: summary?.journalBytes ?? 0,
      ...(summary ? { recordCount: summary.recordCount } : {}),
    });
    if (summary?.tornTail)
      this.recordStorageDiagnostic(entry, {
        kind: 'delta_journal_torn_tail_dropped',
        occurredAt,
        storageAuthority: 'v2',
        ...scope,
        journalBytes: summary.validEnd,
        recordBytes: summary.tornTail.bytes,
        recordCount: summary.recordCount,
        journalTailReason: summary.tornTail.reason,
      });
  }

  private recordStorageDiagnostic(
    entry: ScopeEntry,
    diagnostic: ChatStateStorageDiagnostic,
  ): void {
    const retained = this.diagnostics.get(entry.store.directory) ?? [];
    this.diagnostics.set(
      entry.store.directory,
      [...retained, diagnostic].slice(-64),
    );
    for (const listener of Array.from(this.diagnosticListeners)) {
      try {
        listener(diagnostic);
      } catch {
        /* Diagnostics must not change commit acknowledgement or load. */
      }
    }
  }

  public async page(
    scope: ChatScopeKey,
    chatId: string,
    before?: number,
    expectedRevision?: number,
    options: TranscriptViewRequest & Partial<ChatTranscriptPageRequest> = {},
  ): Promise<TranscriptPage> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.page(chatId, before, expectedRevision, options);
    });
  }
  /**
   * A chat's state and the end of its transcript, read under one scope lease
   * so that no commit lands between the two: `fromState` derives what the
   * read needs from the state, then transcript pages are read back from the
   * end until `reachedStart` accepts a page, or to the transcript's start.
   * Both callbacks run under the lease and must not call the repository.
   */
  public async readTranscriptTail<T>(
    scope: ChatScopeKey,
    chatId: string,
    selection: ChatReadSelection,
    reader: {
      fromState: (state: CanonicalChatState) => T;
      reachedStart: (
        value: T,
        page: readonly PersistedChatMessage[],
      ) => boolean;
    },
  ): Promise<{ value: T; messages: PersistedChatMessage[] }> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      const value = reader.fromState(await entry.backend.state(selection));
      let messages: PersistedChatMessage[] = [];
      let before: number | undefined;
      let transcriptRevision: number | undefined;
      do {
        const page = await entry.backend.page(
          chatId,
          before,
          transcriptRevision,
        );
        messages = [...page.messages, ...messages];
        if (reader.reachedStart(value, page.messages)) break;
        before = page.before;
        transcriptRevision = page.transcriptRevision;
      } while (before !== undefined);
      return { value, messages };
    });
  }
  public async hasMessage(
    scope: ChatScopeKey,
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.hasMessage(chatId, messageId);
    });
  }

  public result(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['result']>
  ): ReturnType<DelegationRegistryOperations['result']> {
    return this.registryOperation(scope, (backend) => backend.result(...args));
  }

  public receipt(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['receipt']>
  ): ReturnType<DelegationRegistryOperations['receipt']> {
    return this.registryOperation(scope, (backend) => backend.receipt(...args));
  }

  public resultBySettlementKey(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultBySettlementKey']>
  ): ReturnType<DelegationRegistryOperations['resultBySettlementKey']> {
    return this.registryOperation(scope, (backend) =>
      backend.resultBySettlementKey(...args),
    );
  }

  public resultByGeneration(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultByGeneration']>
  ): ReturnType<DelegationRegistryOperations['resultByGeneration']> {
    return this.registryOperation(scope, (backend) =>
      backend.resultByGeneration(...args),
    );
  }

  public generation(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['generation']>
  ): ReturnType<DelegationRegistryOperations['generation']> {
    return this.registryOperation(scope, (backend) =>
      backend.generation(...args),
    );
  }

  public resultsPage(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultsPage']>
  ): ReturnType<DelegationRegistryOperations['resultsPage']> {
    return this.registryOperation(scope, (backend, context) =>
      backend.resultsPage(args[0], context),
    );
  }

  public generationsPage(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['generationsPage']>
  ): ReturnType<DelegationRegistryOperations['generationsPage']> {
    return this.registryOperation(scope, (backend, context) =>
      backend.generationsPage(args[0], context),
    );
  }

  public resultAnswerRange(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultAnswerRange']>
  ): ReturnType<DelegationRegistryOperations['resultAnswerRange']> {
    return this.registryOperation(scope, (backend) =>
      backend.resultAnswerRange(...args),
    );
  }

  public itemAdmission(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['itemAdmission']>
  ): ReturnType<DelegationRegistryOperations['itemAdmission']> {
    return this.registryOperation(scope, (backend) =>
      backend.itemAdmission(...args),
    );
  }

  public registerGeneration(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['registerGeneration']>
  ): ReturnType<DelegationRegistryOperations['registerGeneration']> {
    const target = TranscriptTargetSchema.parse({
      kind: 'delegation',
      chatId: args[0].chatId,
      delegationId: args[0].delegationId,
      runGeneration: args[0].runGeneration,
    });
    if (target.kind !== 'delegation')
      throw new Error('Only delegation targets have a registry');
    return this.withDelegation(scope, target.chatId, target.delegationId, () =>
      this.withChildStreamTarget(scope, target, () =>
        this.childSearchWrite(scope, target, async (noteBase) => {
          const entry = this.entry(scope);
          this.assertWritable(entry);
          await this.load(scope, entry);
          await noteBase();
          this.assertWritable(entry);
          return entry.backend.registerGeneration(...args);
        }),
      ),
    );
  }

  public updateCardState(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['updateCardState']>
  ): ReturnType<DelegationRegistryOperations['updateCardState']> {
    const target = TranscriptTargetSchema.parse(args[0].target);
    if (target.kind !== 'delegation')
      throw new Error('Only delegation targets have a registry');
    // prepareCardStateUpdate accepts only CardStateDraft (no artifact refs)
    // and preserves the stored canonical answer, so status drafts cannot
    // drop a root. Settlements below retain their full-scan cleanup trigger.
    return this.withDelegation(scope, target.chatId, target.delegationId, () =>
      this.withChildStreamTarget(scope, target, () =>
        this.withCardStatePublication(scope, target, () =>
          this.entry(scope).backend.updateCardState(...args),
        ),
      ),
    );
  }

  public settleDelegationResult(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['settleDelegationResult']>
  ): ReturnType<DelegationRegistryOperations['settleDelegationResult']> {
    const target = TranscriptTargetSchema.parse(args[0].target);
    if (target.kind !== 'delegation')
      throw new Error('Only delegation targets have a registry');
    return this.withDelegation(scope, target.chatId, target.delegationId, () =>
      this.withChildStreamTarget(scope, target, () =>
        this.settleRegistryOperation(scope, args[0]),
      ),
    );
  }

  public async appendDelegationReceipt(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['appendDelegationReceipt']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['appendDelegationReceipt']>>
  > {
    const entry = this.entry(scope);
    const admitted = await this.serialized(entry, async () => {
      this.assertWritable(entry);
      // Replay must remain read-only even when no journal exists.
      await this.loadChildReadScope(scope, entry);
      this.assertWritable(entry);
      const baseRevision = await entry.backend.revision();
      const result = await entry.backend.appendDelegationReceipt(...args);
      const advance = await this.reserveStreamAdvance(
        entry,
        scope,
        { chatId: args[0].chatId },
        baseRevision,
      );
      return { result, publication: advance?.publication };
    });
    await admitted.publication;
    return admitted.result;
  }

  private settleRegistryOperation(
    scope: ChatScopeKey,
    input: Parameters<
      DelegationRegistryOperations['settleDelegationResult']
    >[0],
  ): ReturnType<DelegationRegistryOperations['settleDelegationResult']> {
    const entry = this.entry(scope);
    return this.withCardStatePublication(scope, input.target, async () => {
      this.assertWritable(entry);
      if (await this.checkpointOnlyChildScope(entry)) {
        const replay =
          await entry.backend.readDelegationSettlementReplay(input);
        if (replay !== undefined) return replay;
      }
      // Only a genuinely new settlement takes the existing load/promotion path.
      await this.load(scope, entry);
      this.assertWritable(entry);
      const revision = await entry.backend.revision();
      const result = await entry.backend.settleDelegationResult(input);
      if ((await entry.backend.revision()) !== revision) {
        entry.maintenanceDirtyChats.add(input.target.chatId);
        await this.requestDirtyArtifactMaintenance(entry);
      }
      return result;
    });
  }

  /** Reserve notification order under the scope lease; observers run only after durability. */
  private async withCardStatePublication<T>(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    const entry = this.entry(scope);
    const admitted = await this.serialized(entry, async () => {
      this.assertWritable(entry);
      await this.loadChildReadScope(scope, entry);
      const baseRevision = await entry.backend.revision();
      const result = await operation();
      const advance =
        target.kind === 'delegation'
          ? await this.reserveStreamAdvance(entry, scope, target, baseRevision)
          : undefined;
      if (advance) this.scheduleJournalWork(entry);
      return {
        result,
        publication: advance?.publication,
        dirty: this.reserveChildSearchDirty(entry, scope, target),
      };
    });
    admitted.dirty.release();
    await admitted.publication;
    await admitted.dirty.publication;
    return admitted.result;
  }

  private async checkpointOnlyChildScope(entry: ScopeEntry): Promise<boolean> {
    return (
      this.options.enableFormat4 === true &&
      (await entry.store.format()) === 'v4' &&
      (await entry.store.journalFile()) === undefined
    );
  }

  private async loadChildReadScope(
    scope: ChatScopeKey,
    entry: ScopeEntry,
  ): Promise<void> {
    if (await this.checkpointOnlyChildScope(entry)) {
      this.assertWritable(entry);
      if (entry.loadError) throw entry.loadError;
      entry.backendResident = true;
      return;
    }
    await this.load(scope, entry);
  }

  private registryOperation<T>(
    scope: ChatScopeKey,
    operation: (
      backend: ChatStateV2Backend,
      context: DelegationRegistryCursorContext,
    ) => Promise<T>,
    writable = false,
  ): Promise<T> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      if (writable) this.assertWritable(entry);
      if (!writable) await this.loadChildReadScope(scope, entry);
      else await this.load(scope, entry);
      if (writable) this.assertWritable(entry);
      return operation(entry.backend, {
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        archive: { kind: 'live' },
        storageIdentity: createHash('sha256')
          .update(entry.store.directory)
          .digest('hex'),
      });
    });
  }

  private withDelegation<T>(
    scope: ChatScopeKey,
    chatId: string,
    delegationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const entry = this.entry(scope);
    const key = canonicalJson([
      entry.store.directory,
      scope.projectId,
      scope.worktreeId,
      chatId,
      delegationId,
    ]);
    return this.withRegistryLock(this.delegationTails, key, operation, entry);
  }

  private async withRegistryLock<T>(
    tails: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
    entry: ScopeEntry,
  ): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => lock);
    tails.set(key, tail);
    this.clearIdleUnloadTimer(entry);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
      this.restartIdleUnloadTimer(entry);
    }
  }

  /**
   * Serialize a complete child-stream operation without holding a scope lease
   * while its callback runs. The callback can call other repository methods;
   * each takes and releases its own normal scope lease.
   */
  public async withChildStreamTarget<T>(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    const validated = TranscriptTargetSchema.parse(target);
    if (validated.kind !== 'delegation')
      throw new Error('Only delegation targets can be serialized');
    const entry = this.entry(scope);
    const key = canonicalJson([
      entry.store.directory,
      scope.projectId,
      scope.worktreeId,
      validated,
    ]);
    return this.withRegistryLock(this.childTargetTails, key, operation, entry);
  }

  /** Register a complete target once, or return its current descriptor. */
  public async openChildStream(
    scope: ChatScopeKey,
    target: TranscriptTarget,
  ): Promise<TranscriptStreamDescriptor> {
    const validated = TranscriptTargetSchema.parse(target);
    if (validated.kind !== 'delegation')
      throw new Error('Only delegation targets can be opened');
    return this.withChildStreamTarget(scope, validated, async () => {
      const entry = this.entry(scope);
      return this.childSearchWrite(scope, validated, async (noteBase) => {
        this.assertWritable(entry);
        if (await this.checkpointOnlyChildScope(entry)) {
          const existing = await entry.backend.childStreamDescriptor(validated);
          if (existing !== undefined) return existing;
        }
        await this.load(scope, entry);
        await noteBase();
        this.assertWritable(entry);
        const current = await entry.backend.childStreamDescriptor(validated);
        if (current !== undefined) return current;
        this.assertWritable(entry);
        await entry.backend.registerTranscriptStream(validated);
        const registered = await entry.backend.childStreamDescriptor(validated);
        if (registered === undefined)
          throw new Error(
            'Child stream registration did not produce a descriptor',
          );
        return registered;
      });
    });
  }

  /**
   * One bounded stored compatibility page, under the normal read lease.
   * encodedBudget covers UTF-8 JSON.stringify(items), including its `[]`:
   * the service subtracts (bytes(envelope with items: []) - 2) from 4 MiB.
   */
  public async childStreamCompatibilityPage(
    scope: ChatScopeKey,
    request: ChildStreamCompatibilityPageRequest,
  ): Promise<ChildStreamCompatibilityPageReply> {
    const target = TranscriptTargetSchema.safeParse(request?.target);
    if (
      !target.success ||
      target.data.kind !== 'delegation' ||
      !Number.isSafeInteger(request.streamRevision) ||
      request.streamRevision < 0 ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > DELEGATION_COMPATIBILITY_PAGE_LIMITS.maxRows ||
      !Number.isSafeInteger(request.encodedBudget) ||
      request.encodedBudget < 0 ||
      request.encodedBudget >
        DELEGATION_COMPATIBILITY_PAGE_LIMITS.encodedBytes ||
      (request.beforeSequence !== undefined &&
        (!Number.isSafeInteger(request.beforeSequence) ||
          request.beforeSequence < 1))
    )
      return {
        ok: false,
        code: 'invalid_request',
        reason: 'Invalid compatibility page request',
      };
    try {
      const entry = this.entry(scope);
      return await this.serialized(entry, async () => {
        await this.loadChildReadScope(scope, entry);
        return entry.backend.childStreamCompatibilityPage(request);
      });
    } catch (error) {
      return {
        ok: false,
        code: 'failed',
        reason:
          error instanceof Error
            ? error.message
            : 'Compatibility page read failed',
      };
    }
  }

  /** A point read of the stored parent row, never the descriptor overlay. */
  public async readStoredParentMessage(
    scope: ChatScopeKey,
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.loadChildReadScope(scope, entry);
      return entry.backend.readStoredParentMessage(chatId, messageId);
    });
  }

  /** Return the journal-projected descriptor, or the checkpointed descriptor. */
  public async getChildStreamState(
    scope: ChatScopeKey,
    target: TranscriptTarget,
  ): Promise<TranscriptStreamDescriptor | undefined> {
    const validated = TranscriptTargetSchema.parse(target);
    if (validated.kind !== 'delegation')
      throw new Error('Only delegation targets have stream state');
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.loadChildReadScope(scope, entry);
      return entry.backend.childStreamDescriptor(validated);
    });
  }

  /** Deterministically identify and durably commit the supplied child rows. */
  public async commitChildStream(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    mutationKey: string,
    rows: readonly DelegationChildRow[],
  ): Promise<{
    applied: boolean;
    revision: number;
    descriptor: TranscriptStreamDescriptor;
  }> {
    const committed = await this.commitChildRows(
      scope,
      target,
      mutationKey,
      () => Promise.resolve(rows),
      true,
    );
    if (!committed.committed) throw new Error('Child rows were not committed');
    return {
      applied: committed.applied,
      revision: committed.revision,
      descriptor: committed.descriptor,
    };
  }

  /**
   * Prepares and commits a child write in one admission turn of the scope
   * lease: the stream's descriptor and stored rows are read, and the rows to
   * commit chosen, in the turn that commits them. Separate reads each waited
   * a pass of the scope's queue, which concurrent delegates keep long.
   */
  public commitPreparedChildStream(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    mutationKey: string,
    prepare: ChildStreamWritePreparation,
  ): Promise<PreparedChildStreamCommit> {
    return this.commitChildRows(scope, target, mutationKey, prepare, false);
  }

  private async commitChildRows(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    mutationKey: string,
    prepare: ChildStreamWritePreparation,
    commitWhenEmpty: boolean,
  ): Promise<PreparedChildStreamCommit> {
    const validated = TranscriptTargetSchema.parse(target);
    if (validated.kind !== 'delegation')
      throw new Error('Only delegation targets accept child rows');
    const mutationId = createHash('sha256')
      .update(canonicalJson({ target: validated, mutationKey }))
      .digest('hex');
    const entry = this.entry(scope);
    return this.childSearchWrite(
      scope,
      validated,
      async (noteBase, noteDurable): Promise<PreparedChildStreamCommit> => {
        this.assertWritable(entry);
        // Preparation reads as a reader does, so a write that commits
        // nothing, such as a replay, leaves a checkpoint-only scope as it is.
        await this.loadChildReadScope(scope, entry);
        const prepared = await entry.backend.childStreamDescriptor(validated);
        const rows = await prepare(prepared, (messageId) =>
          entry.backend.childStreamMessage(
            validated,
            messageId,
            normalizedChildPin(prepared, prepared?.streamRevision ?? 0),
          ),
        );
        if (rows.length === 0 && !commitWhenEmpty)
          return { committed: false, prepared };
        this.assertWritable(entry);
        await this.load(scope, entry);
        await noteBase();
        this.assertWritable(entry);
        await entry.backend.childStreamDescriptor(validated);
        this.assertWritable(entry);
        const { durable, ...result } = await entry.backend.admitChildStream(
          validated,
          mutationId,
          rows,
          undefined,
          mutationKey,
        );
        noteDurable(durable);
        // Existing child rows may be revised (including their body references).
        // Brand-new rows only add roots; unknown/revised rows are conservative.
        if (result.applied && rows.some((row) => row.itemRevision > 0)) {
          entry.maintenanceDirtyChats.add(validated.chatId);
          await this.requestDirtyArtifactMaintenance(entry);
        }
        const descriptor = await entry.backend.childStreamDescriptor(validated);
        if (descriptor === undefined)
          throw new Error('Child stream disappeared after commit');
        return { committed: true, prepared, ...result, descriptor };
      },
      'admission',
    );
  }

  public listChildSearchDocuments(
    scope: ChatScopeKey,
    chatId: string,
    signal?: AbortSignal,
  ): Promise<ChildSearchDocumentIdentity[]> {
    const entry = this.entry(scope, false);
    return this.serialized(entry, async () => {
      signal?.throwIfAborted();
      await this.loadChildReadScope(scope, entry);
      return entry.backend.listChildSearchDocuments(chatId, signal);
    });
  }

  public readChildSearchDocument(
    scope: ChatScopeKey,
    identity: ChildSearchDocumentIdentity,
    signal?: AbortSignal,
  ): Promise<{ body: string; fingerprint: string }> {
    const entry = this.entry(scope, false);
    return this.serialized(entry, async () => {
      signal?.throwIfAborted();
      await this.loadChildReadScope(scope, entry);
      return entry.backend.readChildSearchDocument(identity, signal);
    });
  }

  /** Close the validation/publication race with canonical admissions/deletion. */
  public commitChildSearchDocuments(
    scope: ChatScopeKey,
    chatId: string,
    identities: readonly ChildSearchDocumentIdentity[],
    publish: () => Promise<void>,
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const entry = this.entry(scope, false);
    return this.serialized(entry, async () => {
      signal?.throwIfAborted();
      if (!isCurrent() || entry.deleting || entry.lifecycle === 'disposed')
        return false;
      await this.loadChildReadScope(scope, entry);
      const current = await entry.backend.listChildSearchDocuments(
        chatId,
        signal,
      );
      if (
        !isCurrent() ||
        JSON.stringify(current.map((child) => child.fingerprint)) !==
          JSON.stringify(identities.map((child) => child.fingerprint))
      )
        return false;
      await publish();
      return true;
    });
  }

  /** Point-read a complete logical row only when its stream revision is current. */
  public async getChildStreamMessage(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    messageId: string,
    streamRevision: number,
  ): Promise<DelegationChildRow | undefined> {
    const validated = TranscriptTargetSchema.parse(target);
    if (validated.kind !== 'delegation')
      throw new Error('Only delegation targets have child messages');
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.loadChildReadScope(scope, entry);
      const revision = normalizedChildPin(
        await entry.backend.childStreamDescriptor(validated),
        streamRevision,
      );
      return entry.backend.childStreamMessage(validated, messageId, revision);
    });
  }

  /** Read one pinned cursor page through the existing phase-08 child reader. */
  public async getChildStreamPage(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    streamRevision: number,
    cursor?: string,
    limit = 100,
  ): Promise<ChildStreamRowsPage> {
    const validated = TranscriptTargetSchema.parse(target);
    if (validated.kind !== 'delegation')
      throw new Error('Only delegation targets have child pages');
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.loadChildReadScope(scope, entry);
      const revision = normalizedChildPin(
        await entry.backend.childStreamDescriptor(validated),
        streamRevision,
      );
      return entry.backend.childStreamPage(
        scope,
        validated,
        revision,
        cursor,
        limit,
      );
    });
  }

  /** Read a pinned byte range from an inline or referenced child field. */
  public async readChildStreamContent(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    streamRevision: number,
    messageId: string,
    blockOrdinal: number,
    field: TranscriptContentField,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ChildStreamContentRange> {
    const validated = TranscriptTargetSchema.parse(target);
    if (validated.kind !== 'delegation')
      throw new Error('Only delegation targets have child content');
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.loadChildReadScope(scope, entry);
      const revision = normalizedChildPin(
        await entry.backend.childStreamDescriptor(validated),
        streamRevision,
      );
      return entry.backend.childStreamContentRange(
        validated,
        revision,
        messageId,
        blockOrdinal,
        field,
        offset,
        limit,
        signal,
      );
    });
  }
  public async locateMessage(
    scope: ChatScopeKey,
    chatId: string,
    messageId: string,
  ): Promise<'missing' | 'active' | { committed: true; last: boolean }> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      const transcript = entry.backend.storage.transcripts;
      const active = await transcript.activeMessages(chatId);
      const lastCommittedMessageId =
        await transcript.lastCommittedMessageId(chatId);

      return transcript.withCommittedMessageStates(
        chatId,
        async (
          reader,
        ): Promise<
          'missing' | 'active' | { committed: true; last: boolean }
        > => {
          const isCommitted = await reader.hasCommittedMessage(messageId);
          const isActive = active.some((message) => message.id === messageId);
          if (!isCommitted) return isActive ? 'active' : 'missing';

          if (lastCommittedMessageId !== messageId)
            return { committed: true, last: false };

          // Active rows follow committed history, so the prompt is last
          // unless an active row is more than a committed echo.
          for (const message of active)
            if (!(await reader.hasCommittedMessage(message.id)))
              return { committed: true, last: false };
          return { committed: true, last: true };
        },
      );
    });
  }
  /**
   * See {@link ChatStateV2Backend.appendDelegationItems}. Only the check that
   * the chat still exists takes the scope lease; the log writes and syncs run
   * after it, so they never hold chat commits back.
   */
  public async appendDelegationItems(
    scope: ChatScopeKey,
    chatId: string,
    runs: readonly DelegationRunItems[],
  ): Promise<boolean> {
    const entry = this.entry(scope);
    const listed = await this.serialized(entry, async () => {
      this.assertWritable(entry);
      await this.load(scope, entry);
      const exists = await entry.backend.listsDelegationChat(chatId);
      if (exists) {
        this.clearIdleUnloadTimer(entry);
        entry.outOfLeaseReservations += 1;
      }
      return exists;
    });
    if (!listed) return false;
    try {
      await entry.backend.appendDelegationLog(chatId, runs);
      for (const run of runs)
        await this.notifyChildSearchDirty(scope, {
          kind: 'delegation',
          chatId,
          delegationId: run.run.delegationId,
          runGeneration: run.run.runGeneration,
        });
      return true;
    } finally {
      entry.outOfLeaseReservations -= 1;
      this.restartIdleUnloadTimer(entry);
    }
  }
  public async readDelegationItems(
    scope: ChatScopeKey,
    chatId: string,
    run: DelegationRun,
  ): Promise<AgentDelegationTranscriptItem[]> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.readDelegationItems(chatId, run);
    });
  }
  public async toolOutput(
    scope: ChatScopeKey,
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedToolOutputReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
    request?: ChatToolOutputRequest,
  ): Promise<ChatToolOutputResponse> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.toolOutput(
        chatId,
        messageId,
        toolUseId,
        reference,
        offset,
        length,
        signal,
        request,
      );
    });
  }

  public async content(
    request: ChatTranscriptContentRequest,
    signal?: AbortSignal,
  ): Promise<ChatToolOutputResponse> {
    const scope: ChatScopeKey = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
    };
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.content(request, signal);
    });
  }

  public async blocks(
    request: ChatTranscriptBlocksRequest,
    signal?: AbortSignal,
  ): Promise<ChatTranscriptBlocksPage> {
    const scope: ChatScopeKey = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
    };
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.blocks(request, signal);
    });
  }

  public async search(
    request: ChatTranscriptSearchRequest,
    signal?: AbortSignal,
  ): Promise<ChatTranscriptSearchResult> {
    const scope: ChatScopeKey = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
    };
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.search(request, signal);
    });
  }

  public async visual(
    scope: ChatScopeKey,
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedVisualReference,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ChatVisualReadResponse> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.visual(
        chatId,
        messageId,
        toolUseId,
        reference,
        offset,
        limit,
        signal,
      );
    });
  }
  /** The scope lease ends after the immutable handles are registered. Search
   * builds preview text outside it; deletion cancels handles without awaiting
   * a consumer callback that may itself be awaiting deletion.
   */
  public async consumeTranscriptPreview<T>(
    scope: ChatScopeKey,
    chatId: string,
    consume: (
      messages: AsyncIterable<PersistedChatMessage>,
      descriptor: TranscriptDescriptor,
      read: TranscriptPreviewRead,
    ) => Promise<T>,
    isCurrent?: () => boolean,
    options: TranscriptPreviewOptions = {},
  ): Promise<T> {
    const assertCurrent = (): void => {
      if (isCurrent && !isCurrent())
        throw new Error('Transcript preview was superseded');
    };
    assertCurrent();
    const entry = this.entry(scope, false);
    const captured = await this.serialized(entry, async () => {
      assertCurrent();
      if (
        !this.accepting ||
        entry.deleting ||
        entry.lifecycle === 'draining' ||
        entry.lifecycle === 'disposed'
      )
        throw scopeDrainingError();
      await this.load(scope, entry);
      assertCurrent();
      const preview = await entry.backend.captureTranscriptPreview(chatId);
      // Registration owns close retries even when cancellation arrives while
      // capture is awaiting the filesystem. A failed first close must remain
      // visible to drain/deletion rather than orphaning open handles.
      entry.previewReaders.add(preview);
      if (
        !this.accepting ||
        entry.deleting ||
        entry.lifecycle !== 'ready' ||
        (isCurrent && !isCurrent())
      ) {
        try {
          await preview.close();
        } catch (error) {
          this.recordPreviewCloseFailure(entry);
          throw error;
        }
        entry.previewReaders.delete(preview);
        throw scopeDrainingError();
      }
      return preview;
    });
    let projected:
      | { success: true; value: T }
      | { success: false; error: unknown };
    try {
      assertCurrent();
      const descriptor = captured.descriptor;
      const committedIncluded =
        options.reuseCommittedPrefix?.(descriptor) !== true;
      const value = await consume(
        committedIncluded ? captured.messages() : captured.activeMessages(),
        descriptor,
        {
          committedIncluded,
          ...(captured.journalProjected ? { journalProjected: true } : {}),
        },
      );
      captured.assertComplete();
      assertCurrent();
      projected = { success: true, value };
    } catch (error) {
      projected = { success: false, error };
    }
    try {
      await captured.close();
    } catch (error) {
      this.recordPreviewCloseFailure(entry);
      throw errorFromUnknown(error);
    }
    entry.previewReaders.delete(captured);
    if (!projected.success) throw errorFromUnknown(projected.error);
    return projected.value;
  }

  /**
   * The rows a chat's in-progress turn changed since transcript revision
   * `since`, read from the delta journal in memory (chat search's
   * incremental projection). Undefined when only a full read can answer.
   */
  public async activeTurnDelta(
    scope: ChatScopeKey,
    chatId: string,
    since: number,
  ): Promise<
    { descriptor: TranscriptDescriptor; delta: ActiveTurnDelta } | undefined
  > {
    const entry = this.entry(scope, false);
    return this.serialized(entry, async () => {
      if (!this.accepting || entry.deleting || entry.lifecycle !== 'ready')
        return undefined;
      return entry.backend.activeTurnDelta(chatId, since);
    });
  }

  public async consumeTranscript<T>(
    scope: ChatScopeKey,
    chatId: string,
    fullOutputs: boolean,
    consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
    options?: TranscriptConsumeOptions,
  ): Promise<T> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.consumeTranscript<T>(
        chatId,
        fullOutputs,
        consume,
        options,
      );
    });
  }

  public async captureScope(
    scope: ChatScopeKey,
    destination: ChatStorageV2,
    allowDuringScopeDeletion = false,
    captureExecutor: (
      source: ChatStorageV2,
      destination: ChatStorageV2,
    ) => Promise<void> = (source, target) => source.copyTo(target),
  ): Promise<void> {
    // Capture never re-admits a deleted scope: a retry must observe disposal.
    const entry = this.entry(scope, false);
    return this.serialized(entry, async () => {
      // A committed capture may be the only surviving payload after deletion
      // removed its live scope. A retry must not replace it with an empty one.
      const captured = (await destination.authority()) === 'v2';
      if (captured && entry.lifecycle === 'disposed') {
        await captureExecutor(destination, destination);
        return;
      }
      this.assertWritable(entry, allowDuringScopeDeletion);
      await this.load(scope, entry);
      await entry.backend.flush();
      const current = await entry.backend.load();
      if (
        captured &&
        !current.live.tabs.length &&
        !current.archive.archived.length
      ) {
        await captureExecutor(destination, destination);
        return;
      }
      await captureExecutor(entry.store, destination);
    });
  }

  public async importScope(
    scope: ChatScopeKey,
    source: ChatStorageV2,
    metadata: Pick<CanonicalChatState, 'tabsFile' | 'archivesFile'>,
    options: ChatStorageImportOptions = {},
  ): Promise<void> {
    const entry = this.entry(scope);
    const { commit, published } = await this.serialized(entry, async () => {
      this.assertWritable(entry);
      await this.load(scope, entry);
      const journaled = entry.backend.isDeltaJournal();
      markImportedApprovalState(scope, metadata);
      const result = await entry.backend.importScope(source, metadata, options);
      if (result.applied) await this.requestArtifactMaintenance(entry);
      const imported = { ...result, ...scope };
      return {
        commit: imported,
        // After commits whose group-committed publication is still queued.
        published:
          journaled && imported.applied
            ? this.reservePublication(entry, imported, undefined)
            : undefined,
      };
    });
    this.scheduleJournalWork(entry);
    if (published) await published;
    else if (commit.applied) await this.publish(entry, commit);
  }

  /** Copy selected chats under both scope leases in a stable order. This also
   * supports resumable startup splits without ever serializing sibling bodies.
   */
  public async copyChats(
    sourceScope: ChatScopeKey,
    destinationScope: ChatScopeKey,
    metadata: Pick<CanonicalChatState, 'tabsFile' | 'archivesFile'>,
    sourceChatIds?: Readonly<Record<string, string>>,
    transformMessage?: ChatStorageImportOptions['transformMessage'],
    throughMessageIds?: ChatStorageImportOptions['throughMessageIds'],
    beforePublish?: ChatStorageImportOptions['beforePublish'],
    preparePublish?: ChatStorageImportOptions['preparePublish'],
  ): Promise<void> {
    const source = this.entry(sourceScope);
    const destination = this.entry(destinationScope);
    if (source === destination)
      throw new Error('Cross-scope copy requires distinct scopes');
    const ordered = [source, destination].sort((a, b) =>
      a.store.directory.localeCompare(b.store.directory),
    );
    const { commit, published } = await this.serialized(ordered[0], () =>
      this.serialized(ordered[1], async () => {
        this.assertWritable(destination);
        this.assertWritable(source);
        await this.load(sourceScope, source);
        await this.load(destinationScope, destination);
        const journaled = destination.backend.isDeltaJournal();
        await source.backend.flush();
        const indexes = await source.backend.load();
        const ids = [
          ...metadata.tabsFile.tabs,
          ...metadata.archivesFile.archived.map((entry) => entry.tab),
        ].map((tab) => tab.id);
        const entries = [
          ...indexes.live.tabs,
          ...indexes.archive.archived.map((entry) => entry.tab),
        ].filter((tab) =>
          ids.some((id) => (sourceChatIds?.[id] ?? id) === tab.id),
        );
        const streamParents: StreamCopyParent[] = ids
          .slice()
          .sort()
          .map((targetChatId) => {
            const sourceChatId = sourceChatIds?.[targetChatId] ?? targetChatId;
            const log = source.backend.storage.transcripts;
            return {
              sourceChatId,
              targetChatId,
              rows: async function* (): AsyncGenerator<PersistedChatMessage> {
                const through = throughMessageIds?.[targetChatId];
                for await (const row of log.iterate(sourceChatId)) {
                  yield row;
                  if (row.id === through) return;
                }
                for (const row of await log.activeMessages(sourceChatId)) {
                  yield row;
                  if (row.id === through) return;
                }
              },
            };
          });
        const streamIdentity =
          (await source.store.format()) === 'v4'
            ? await capturedStreamIdentity(
                join(source.store.directory, 'transcripts'),
                source.backend.storage.transcripts,
                streamParents,
              )
            : [];
        const legacyIdentity = [
          source.store.directory,
          ids,
          sourceChatIds,
          entries.map((tab) => [tab.id, tab.transcript.transcriptRevision]),
        ];
        const mutationId = `copy:${createHash('sha256')
          .update(
            streamIdentity.length
              ? canonicalJson([
                  ...legacyIdentity,
                  throughMessageIds,
                  streamIdentity,
                ])
              : JSON.stringify(legacyIdentity),
          )
          .digest('hex')}`;
        markImportedApprovalState(destinationScope, metadata);
        const result = await destination.backend.importScope(
          source.store,
          metadata,
          {
            merge: true,
            mutationId,
            sourceChatIds,
            settleFork: sourceChatIds !== undefined,
            transformMessage,
            throughMessageIds,
            preparePublish,
            beforePublish,
          },
        );
        if (result.applied)
          await this.requestArtifactMaintenance(destination, ids);
        const copied = { ...result, ...destinationScope };
        return {
          commit: copied,
          // After commits whose group-committed publication is still queued.
          published:
            journaled && copied.applied
              ? this.reservePublication(destination, copied, undefined)
              : undefined,
        };
      }),
    );
    this.scheduleJournalWork(source);
    this.scheduleJournalWork(destination);
    if (published) await published;
    else if (commit.applied) await this.publish(destination, commit);
  }

  /** Explicit import/compatibility command; omitted history is never deletion.
   * Only an authoritative restore may replace existing transcript contents.
   */
  public async replaceCompatibilityTabs(
    scope: ChatScopeKey,
    incoming: ChatTabsFile,
    options: {
      changedTabIds?: readonly string[];
      removedTabIds?: readonly string[];
      activeTabId?: string;
      authoritative?: boolean;
      source?: ChatJournalRecord['source'];
      mutationId?: string;
      beforePublish?: () => void;
      preparePublish?: () => Promise<void>;
      additionalTabMutations?: (
        tab: PersistedChatTab,
        current: CanonicalChatState,
      ) => ChatCoreMutation[];
    } = {},
  ): Promise<CanonicalChatState> {
    const commit = await this.transactWith(
      scope,
      (current, revision, context) => {
        const mutations: ChatCoreMutation[] = [];
        const fresh = incoming.revision === revision;
        const authoritative = options.authoritative === true;
        const changed = options.changedTabIds
          ? new Set(options.changedTabIds)
          : undefined;
        const remaining = new Set(current.tabsFile.tabs.map((tab) => tab.id));
        for (const incomingTab of incoming.tabs) {
          remaining.delete(incomingTab.id);
          if (changed && !changed.has(incomingTab.id)) continue;
          const existing = current.tabsFile.tabs.find(
            (tab) => tab.id === incomingTab.id,
          );
          if (
            !existing &&
            !authoritative &&
            context.hasRemovedTab(incomingTab.id)
          )
            continue;
          const hasBody = Object.prototype.propertyIsEnumerable.call(
            incomingTab,
            'messages',
          );
          if (
            authoritative &&
            (!hasBody ||
              incomingTab.transcriptLoaded === false ||
              incomingTab.transcriptWindow?.before !== undefined ||
              (incomingTab.transcript?.messageCount ??
                incomingTab.transcript?.committedMessageCount ??
                0) > incomingTab.messages.length)
          )
            throw new Error(
              'Authoritative import requires complete transcript contents',
            );
          const messages = hasBody
            ? authoritative
              ? incomingTab.messages
              : incomingTab.messages.filter(
                  (message) =>
                    !context.hasRemovedMessage(message.id) &&
                    (!existing || !isMcpActivationMessage(message)),
                )
            : undefined;
          let metadata =
            existing && !authoritative && !fresh && !changed
              ? existing
              : incomingTab;
          if (existing && !authoritative) {
            const preserved = { ...metadata };
            if (existing.automaticTitleState !== undefined) {
              preserved.automaticTitleState = existing.automaticTitleState;
            }
            for (const key of [
              'mcpActivation',
              'inputDelivery',
              'trackedPlanImplementation',
              'lastAcceptedUserMessageId',
              'unacceptedTurnEnds',
              'turnEnds',
              'rootTurnInputIds',
              'reducedRootTerminalTurnIds',
              'interruptedTurns',
              'autoArchiveTurnId',
            ] as const) {
              if (existing[key] === undefined) delete preserved[key];
              else Object.assign(preserved, { [key]: existing[key] });
            }
            metadata = preserved;
          }
          const nextTab: PersistedChatTab = {
            ...metadata,
            ...(messages ? { messages } : {}),
          };
          mutations.push({ type: 'tab.created', tab: nextTab });
          if (messages && !options.removedTabIds?.includes(nextTab.id))
            mutations.push(
              ...(options.additionalTabMutations?.(nextTab, current) ?? []),
            );
          if (authoritative && existing && messages)
            mutations.push({
              type: 'messages.replaced',
              chatId: existing.id,
              messages,
              removedMessageIds: existing.messages
                .filter(
                  (message) =>
                    !messages.some((candidate) => candidate.id === message.id),
                )
                .map((message) => message.id),
            });
        }
        const removed = new Set(options.removedTabIds ?? []);
        if (authoritative || (!changed && fresh))
          for (const id of Array.from(remaining)) removed.add(id);
        for (const id of Array.from(removed))
          if (current.tabsFile.tabs.some((tab) => tab.id === id))
            mutations.push({ type: 'tab.removed', tabId: id });
        if (authoritative || (!changed && fresh)) {
          const order = incoming.tabs
            .map((tab) => tab.id)
            .filter((id) => !removed.has(id));
          mutations.push({ type: 'tab.order_changed', tabIds: order });
          if (order.length)
            mutations.push({
              type: 'tab.active_changed',
              activeTabId: order.includes(incoming.activeTabId)
                ? incoming.activeTabId
                : (order[0] ?? ''),
              lastActiveEditableChatId: incoming.lastActiveEditableChatId,
              lastActiveChatProvider: incoming.lastActiveChatProvider,
            });
          for (const question of current.tabsFile.pendingQuestions ?? [])
            if (
              !incoming.pendingQuestions?.some(
                (candidate) => candidate.requestId === question.requestId,
              )
            )
              mutations.push({
                type: 'pending_question.removed',
                requestId: question.requestId,
                chatId: question.chatId,
              });
          for (const question of incoming.pendingQuestions ?? [])
            mutations.push({ type: 'pending_question.upserted', question });
        } else if (options.activeTabId !== undefined) {
          const activeTabExists = incoming.tabs.some(
            (tab) =>
              tab.id === options.activeTabId &&
              !removed.has(options.activeTabId),
          );
          if (!activeTabExists)
            throw new Error('Active tab must be present in imported tabs');
          mutations.push({
            type: 'tab.active_changed',
            activeTabId: options.activeTabId,
            lastActiveEditableChatId: incoming.lastActiveEditableChatId,
            lastActiveChatProvider: incoming.lastActiveChatProvider,
          });
        }
        return mutations;
      },
      {
        source: options.source ?? 'import',
        mutationId: options.mutationId,
        fullTranscript: options.authoritative,
        ...(options.authoritative
          ? { chatIds: incoming.tabs.map((tab) => tab.id) }
          : {}),
        beforePublish: options.beforePublish,
        preparePublish: options.preparePublish,
      },
    );
    return commit.state;
  }

  public async flushScope(
    scope: ChatScopeKey,
    options: { allowDuringScopeDeletion?: boolean } = {},
  ): Promise<void> {
    const entry = this.entry(scope);
    await this.serialized(entry, async () => {
      this.assertWritable(entry, options.allowDuringScopeDeletion);
      await this.load(scope, entry);
      await entry.backend.flush();
      if (entry.backend.pendingJournalRecords() === 0)
        this.clearJournalIdleTimer(entry);
      await this.requestDirtyArtifactMaintenance(entry);
    });
  }
  public async runWithScopeDeletion<T>(
    scope: ChatScopeKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    const entry = this.entry(scope);
    this.clearIdleUnloadTimer(entry);
    entry.deleting++;
    this.cancelArtifactMaintenance(entry);
    try {
      await this.serialized(entry, async () => {
        try {
          await this.closePreviewReaders(entry);
        } catch {
          // Close failures retain readers for drain/retry and emit diagnostics.
        }
        try {
          await entry.backend.disposeArtifactMaintenance();
        } catch (error) {
          // A derived close failure is reported, but cannot skip deletion.
          this.recordArtifactMaintenanceFailure(entry, '', error);
        }
      });
      return await operation();
    } finally {
      entry.deleting--;
      this.armArtifactMaintenanceCapacity(entry);
      this.armArtifactMaintenance(entry);
      this.restartIdleUnloadTimer(entry);
    }
  }
  public async deleteEmptyScope(scope: ChatScopeKey): Promise<void> {
    const entry = this.entry(scope);
    this.clearIdleUnloadTimer(entry);
    await this.serialized(entry, async () => {
      await this.load(scope, entry);
      const index = await entry.backend.load();
      if (
        index.live.tabs.length ||
        index.archive.archived.length ||
        index.live.pendingQuestions?.length ||
        Object.keys(index.live.runtimeByChatId).length
      )
        throw new Error(
          'Chat scope must be semantically empty before deleting sidecars',
        );
      this.cancelArtifactMaintenance(entry);
      this.clearJournalIdleTimer(entry);
      await this.closePreviewReaders(entry);
      await entry.backend.disposeArtifactMaintenance();
      entry.lifecycle = 'draining';
      // Empty metadata is already durable. Removing authority first ensures a
      // crash can leave only an unselected orphan, never a missing live log.
      await rm(entry.store.manifestPath, { force: true });
      await fsyncDirectory(dirname(entry.store.manifestPath));
      await rm(entry.store.directory, { recursive: true, force: true });
      await fsyncDirectory(dirname(entry.store.directory));
      entry.visualStaging = undefined;
      entry.lifecycle = 'disposed';
    });
  }
  public async evictScope(scope: ChatScopeKey): Promise<boolean> {
    const entry = this.entry(scope);
    this.clearIdleUnloadTimer(entry);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      const index = await entry.backend.load();
      if (
        entry.deleting ||
        (await this.options.hasLiveDependency?.(scope)) ||
        index.live.pendingQuestions?.length ||
        Object.values(index.live.runtimeByChatId).some((runtime) =>
          [
            'queued',
            'starting',
            'streaming',
            'awaiting_input',
            'completing',
          ].includes(runtime.status),
        )
      )
        return false;
      this.cancelArtifactMaintenance(entry);
      this.clearJournalIdleTimer(entry);
      let previewCloseError: unknown;
      try {
        await this.closePreviewReaders(entry);
      } catch (error) {
        previewCloseError = error;
      }
      try {
        await this.runArtifactMaintenanceChunk(entry);
      } catch {
        /* Recorded by the chunk. */
      }
      let closeError: unknown;
      try {
        await entry.backend.disposeArtifactMaintenance();
      } catch (error) {
        closeError = error;
        this.recordArtifactMaintenanceFailure(entry, '', error);
      }
      await entry.backend.flush();
      if (closeError || previewCloseError) return false;
      entry.visualStaging = undefined;
      entry.lifecycle = 'disposed';
      this.scopes.delete(entry.store.directory);
      return true;
    });
  }
  /** The deliberate retry boundary for a cached recovery failure: drops the
   * failed entry so the next access re-runs migration and load from disk.
   */
  public async releaseScope(scope: ChatScopeKey): Promise<boolean> {
    const directory = ChatStorageV2.fromLegacyPaths(
      this.resolve(scope),
    ).directory;
    const entry = this.scopes.get(directory);
    if (!entry) return true;
    this.clearIdleUnloadTimer(entry);
    if (entry.lifecycle !== 'recovery_error' || entry.deleting) return false;
    this.cancelArtifactMaintenance(entry);
    await this.closePreviewReaders(entry);
    await entry.backend.disposeArtifactMaintenance();
    await entry.tail;
    if (entry.lifecycle !== 'recovery_error' || entry.loading) return false;
    entry.visualStaging = undefined;
    if (this.scopes.get(directory) === entry) this.scopes.delete(directory);
    return true;
  }
  public async drainAll(): Promise<void> {
    this.accepting = false;
    await this.visualStagingSweep.stop();
    for (const entry of Array.from(this.scopes.values())) {
      this.cancelArtifactMaintenance(entry);
      this.clearIdleUnloadTimer(entry);
      this.clearJournalIdleTimer(entry);
    }
    // A sweep stops at its next scope; the one it is sweeping finishes.
    await Promise.allSettled(Array.from(this.sweeps));
    const outcomes = await Promise.allSettled(
      Array.from(this.scopes.values()).map((entry) =>
        this.serialized(entry, async () => {
          if (entry.lifecycle === 'ready' || entry.lifecycle === 'draining') {
            if (entry.lifecycle === 'ready') {
              try {
                await this.runArtifactMaintenanceChunk(entry);
              } catch {
                /* Recorded by the chunk. */
              }
            }
            entry.lifecycle = 'draining';
            let closeError: unknown;
            try {
              await this.closePreviewReaders(entry);
            } catch (error) {
              closeError = error;
            }
            try {
              await entry.backend.disposeArtifactMaintenance();
            } catch (error) {
              closeError ??= error;
              this.recordArtifactMaintenanceFailure(entry, '', error);
            }
            await entry.backend.flush();
            if (closeError) throw errorFromUnknown(closeError);
            entry.visualStaging = undefined;
            entry.lifecycle = 'disposed';
          }
        }),
      ),
    );
    const failures = outcomes
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .map((result): unknown => result.reason);
    if (failures.length)
      throw aggregateFailure(failures, 'Chat scope drain failed');
  }
  public getLifecycle(scope: ChatScopeKey): ChatScopeLifecycle {
    return (
      this.scopes.get(
        ChatStorageV2.fromLegacyPaths(this.resolve(scope)).directory,
      )?.lifecycle ?? 'unloaded'
    );
  }
  public getArtifactMaintenanceStatus(scope: ChatScopeKey): {
    pendingChats: number;
    deferredChats: number;
    failure?: string;
  } {
    const entry = this.scopes.get(
      ChatStorageV2.fromLegacyPaths(this.resolve(scope)).directory,
    );
    return {
      pendingChats: entry?.maintenanceChats.size ?? 0,
      deferredChats: entry?.maintenanceDeferred.size ?? 0,
      ...(entry?.maintenanceFailure
        ? { failure: entry.maintenanceFailure }
        : {}),
    };
  }
  public getDiagnostics(scope: ChatScopeKey): readonly ChatJournalDiagnostic[] {
    const entry = this.scopes.get(
      ChatStorageV2.fromLegacyPaths(this.resolve(scope)).directory,
    );
    return entry?.loadError
      ? [{ kind: 'unrecoverable_journal', message: entry.loadError.message }]
      : [];
  }
  public getStorageDiagnostics(
    scope: ChatScopeKey,
  ): readonly ChatStateStorageDiagnostic[] {
    return (
      this.diagnostics.get(
        ChatStorageV2.fromLegacyPaths(this.resolve(scope)).directory,
      ) ?? []
    );
  }
  public subscribeStorageDiagnostics(
    listener: (diagnostic: ChatStateStorageDiagnostic) => void,
  ): () => void {
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }
}

/** Port-only child methods normalize settled content; public core reads are unchanged. */
function normalizedChildPin(
  descriptor: TranscriptStreamDescriptor | undefined,
  pin: number,
): number {
  if (!descriptor)
    throw new DelegationRegistryOperationError({
      code: 'not_found',
      message: 'The child stream was not found.',
      retryable: false,
    });
  const revision =
    descriptor.status === 'settled'
      ? descriptor.settleReceipt?.streamRevision
      : descriptor.streamRevision;
  if (revision === undefined)
    throw new DelegationRegistryOperationError({
      code: 'corruption',
      message: 'The settled child stream has no receipt.',
      retryable: false,
    });
  if (
    !Number.isSafeInteger(pin) ||
    pin < revision ||
    pin > descriptor.streamRevision
  )
    throw new DelegationRegistryOperationError({
      code: 'stale_identity',
      message: 'The child stream revision is stale.',
      retryable: false,
    });
  return revision;
}
