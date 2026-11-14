import {
  isInputLedger,
  shareInputLedgerText,
} from './chat-input-delivery-state';
import { validateDelegationReceiptEntry } from '@canopy/desktop-shared/node/delegation/receipt-reply';
import {
  chooseSettlementCardDraft,
  prepareCardStateUpdate,
} from '@canopy/desktop-shared/node/delegation/card-state-rules';
import type {
  DelegationRegistryCheckpointReader,
  DelegationRegistryFailure,
  DelegationRegistryReader,
  DelegationRegistryOperations,
  DelegationRegistrySettleMutation,
} from '../lib/chat-delta-journal/delegation-registry-api';
import { DelegationRegistryOperationError } from '../lib/chat-delta-journal/delegation-registry-error';
import { openDelegationRegistryReadView } from '../lib/chat-delta-journal/reader';
import {
  DELEGATION_COMPATIBILITY_NOTICES,
  DELEGATION_COMPATIBILITY_PAGE_LIMITS,
  type ChildStreamCompatibilityPageReply,
  type ChildStreamCompatibilityPageRequest,
} from '../agents/delegation/record-reader-contract';
import {
  estimateTranscriptWindowBytes,
  TRANSCRIPT_PAGE_SIZE,
  type TranscriptViewRequest,
} from '@canopy/agent-transcript/transcript-storage';
import {
  ChildPageRowTooLargeError,
  selectChildPageRows,
  type ChildPageRead,
  type ChildPageSelection,
} from '../lib/child-page-budget';
import { settlePersistedForkMessages } from '../lib/persisted-chat-settle';
import {
  recordChatStorageCommit,
  recordChatStorageIndexClone,
  recordChatStorageMutations,
} from '@canopy/desktop-shared/node/work-counters';
import { createHash, randomUUID } from 'node:crypto';
import {
  CHILD_SEARCH_EXTRACTOR_VERSION,
  ChildSearchText,
  appendChildSearchCard,
  appendChildSearchRow,
  type ChildSearchDocumentIdentity,
  type ChildSearchCard,
} from '../chat-search/child-text';
import { stat } from 'node:fs/promises';
import {
  copyStreamClosure,
  keptStreamTargets,
  selectStreamClosure,
  StreamClosureCopyRefusalError,
  type StreamCopyParent,
  type SelectedStreamCopy,
} from '../lib/chat-delta-journal/stream-closure-copy';
import {
  loadStreamCatalog,
  loadStreamRegistry,
  pruneStreamCatalog,
  streamCatalogPath,
  UnknownTranscriptStreamError,
  validateStreamTarget,
} from '../lib/chat-delta-journal/stream-registry';
import { join } from 'node:path';
import {
  delegationReadCard,
  readLegacyDelegation,
  MissingDelegationTranscriptSourceError,
} from '../lib/chat-delegation-legacy-read';
import {
  decodeChatTranscriptReadCursor,
  encodeChatTranscriptReadCursor,
  type ChatTranscriptReadCursorContext,
} from '../lib/chat-transcript-read-cursor';
import {
  CardStateV1Schema,
  TranscriptTargetSchema,
  type CardStateV1,
  type TranscriptContentField,
  type TranscriptTarget,
  type TranscriptStreamDescriptor,
  type TranscriptStreamDescriptorUpdate,
} from '@canopy/protocol/canopy-core';
import {
  delegationBlockId,
  overlayStreamBackedDelegationCard,
  type DelegationChildRow,
} from '@canopy/agent-transcript';
import {
  delegationStreamKey,
  delegationTranscriptPaths,
} from '../lib/transcript-stream-paths';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  ChatDeltaJournalWriter,
  demoteFromDeltaJournal,
  promoteToDeltaJournal,
  promoteToFormat4Journal,
  transitionFormat4ToCheckpointed,
  removeStrayDeltaJournal,
  type DeltaJournalDiagnostic,
  type ChatDeltaJournalWriterOptions,
  type DeltaJournalWrite,
} from '../lib/chat-delta-journal/writer';
import {
  LARGE_JOURNAL_RECORD_BYTES,
  PromotionRetry,
  estimateJournalBytes,
  journalWritesFor,
  type JournalWriteForms,
  type PromotionRetryOptions,
} from '../lib/chat-delta-journal/backend-policy';
import type { ActiveTurnDelta } from '../lib/chat-delta-journal/active-turn';
import {
  readChildStreamCompatibilityPage,
  readMergedChildStreamPage,
  type ChildStreamCompatibilitySource,
} from '../lib/chat-delta-journal/child-overlay';
import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import {
  ChatTranscriptLog,
  inlineBodyField,
  readInlineBodyRange,
  TranscriptStreamStore,
  isDelegationChildRow,
  transcriptFieldPolicy,
  sameToolOutputReference,
  type CapturedTranscriptPreview,
  type TranscriptFieldMode,
} from '../lib/chat-transcript-log';
import {
  ChatTranscriptArtifacts,
  CreatedArtifacts,
  assertTranscriptIdentity,
} from '../lib/chat-transcript-artifacts';
import { storedArtifactRefsOf } from '../lib/chat-artifact-references';
import {
  DELEGATION_TRANSCRIPT_CHAT_LOG,
  isDelegationStopReason,
  type AgentDelegationErrorCode,
  type DelegateSettledStatus,
  type AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import {
  delegationTranscriptRowDigest,
  delegationTranscriptSettlementDigest,
  canonicalDelegationJson,
} from '@canopy/desktop-shared/node/delegation';
import type {
  DelegationTranscriptGenerationRegistration,
  DelegationTranscriptResultEntry,
  DelegationTranscriptSettleRequest,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { assertChatStorageIndexes } from '../lib/chat-storage-v2';
import { isRecord } from '../lib/type-guards';
import type {
  DelegationRun,
  DelegationRunItems,
} from '../lib/chat-delegation-log';
import { delegationChildMessages } from '@canopy/agent-transcript';
import { searchTranscriptMessages } from '@canopy/agent-transcript/lib/transcript-search';
import {
  reportChatTranscriptFullRewrite,
  type ChatTranscriptFullRewrite,
} from './chat-transcript-rewrite-diagnostics';
import {
  ChatArtifactMaintenance,
  type ArtifactMaintenanceProgress,
} from '../lib/chat-artifact-maintenance';
import type {
  ChatCoreMutation,
  ChatJournalRecord,
  ChatTranscriptBlocksPage,
  ChatTranscriptBlocksRequest,
  ChatTranscriptContentRequest,
  ChatTranscriptSearchRequest,
  ChatTranscriptSearchResult,
  ChatToolOutputRequest,
  ChatToolOutputResponse,
  ChatRuntimeState,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  ChatMutationOptions,
  ChatStateTransactionContext,
} from './chat-state-contracts';
import { reduceChatState, type CanonicalChatState } from './chat-state-reducer';
import {
  ChatStorageTransactions,
  withTranscriptDescriptor,
  type ChatStorageIndexes,
  type ChatTranscriptWrite,
} from '../lib/chat-storage-transactions';
import type {
  ChatStorageV2,
  ChatIndexEntry,
  ChatRecoveryIndex,
} from '../lib/chat-storage-v2';
import type { TranscriptDescriptor } from '../lib/chat-transcript-log';
import {
  VISUAL_STAGING_RETENTION_MS,
  type ExternalizeVisualContext,
  type LinkedToolCall,
  type ProviderVisualAdmission,
  type PromotedVisual,
  type VisualOwnerFence,
} from '../lib/chat-visual-contracts';
import {
  beginMainTranscriptPerformanceStage,
  mainTranscriptPerformanceEnabled,
} from '../lib/transcript-performance';
import {
  transcriptBodyReferences,
  type TranscriptPage,
} from '@canopy/agent-transcript/transcript-storage';
import type {
  PersistedChatBlock,
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import { isErrnoException } from '../lib/type-guards';
import { ChatVisualReadError } from '../lib/chat-visual-read-errors';
import type { ChatFormat4Outcome } from './chat-format4-telemetry';

/** Messages `ChatTranscriptArtifacts` uses when visual bytes fail validation. */
const VISUAL_INTEGRITY_FAILURES: ReadonlySet<string> = new Set([
  'Visual artifact failed integrity validation',
  'Visual artifact changed during validation',
  'Unexpected end of visual artifact',
]);

export interface ChildStreamRowsPage {
  rows: readonly DelegationChildRow[];
  streamRevision: number;
  cursor?: string;
}

export interface ChildStreamContentRange {
  text: string;
  nextOffset?: number;
  byteLength: number;
  encoding: 'utf8' | 'utf16le';
}

/** A child-stream operation was requested from storage below format 4. */
export class ChildStreamUnsupportedFormatError extends Error {
  public constructor() {
    super('Delegation child streams require enabled format-4 storage');
    this.name = 'ChildStreamUnsupportedFormatError';
  }
}

/** The whole body behind one stored reference, read in verified ranges. */
async function readWholeBody(
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  reference: PersistedToolOutputReference,
): Promise<string> {
  const parts: string[] = [];
  let offset = 0;
  do {
    const part = await artifacts.readRange(chatId, reference, offset, 65_536);
    parts.push(part.text);
    if (part.nextOffset === undefined) break;
    offset = part.nextOffset;
  } while (offset < reference.byteLength);
  return parts.join('');
}

/**
 * A block with every stored body read back in place of its preview and the
 * reference removed: the complete logical content for exports.
 */
async function expandBodyFields(
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  block: PersistedChatBlock,
): Promise<PersistedChatBlock> {
  const body = (reference: PersistedToolOutputReference): Promise<string> =>
    readWholeBody(artifacts, chatId, reference);
  if (block.type === 'tool_result' && block.fullOutputRef) {
    const {
      fullOutputRef: reference,
      outputTruncated: _truncated,
      ...rest
    } = block;
    void _truncated;
    return { ...rest, output: await body(reference) };
  }
  if ((block.type === 'text' || block.type === 'thinking') && block.textRef) {
    const { textRef: reference, ...rest } = block;
    return { ...rest, text: await body(reference) };
  }
  if (block.type === 'tool_use' && block.inputRef) {
    const { inputRef: reference, ...rest } = block;
    return { ...rest, input: await body(reference) };
  }
  if (
    block.type === 'delegated_agent_call' &&
    (block.partialTextRef || block.finalTextRef)
  ) {
    const { partialTextRef, finalTextRef, ...rest } = block;
    return {
      ...rest,
      ...(partialTextRef ? { partialText: await body(partialTextRef) } : {}),
      ...(finalTextRef ? { finalText: await body(finalTextRef) } : {}),
    };
  }
  return block;
}

/**
 * A row for a format 2/3 scope: every generalized body read back inline.
 * Tool output keeps its reference, which those formats read.
 */
async function inlineGeneralizedFields(
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  message: PersistedChatMessage,
): Promise<PersistedChatMessage> {
  if (message.blocksRef)
    throw new Error(
      'Block pages require format 4; cannot inline them into format 2 or 3 storage',
    );
  if (
    transcriptBodyReferences(message).every(({ field }) => field === 'output')
  )
    return message;
  const blocks: PersistedChatBlock[] = [];
  for (const block of message.blocks)
    blocks.push(
      block.type === 'tool_result'
        ? block
        : await expandBodyFields(artifacts, chatId, block),
    );
  return { ...message, blocks };
}

async function copyTranscriptClosure(
  source: ChatTranscriptLog,
  sourceChatId: string,
  targetChatId: string,
  targetArtifacts: ChatTranscriptArtifacts,
  targetDelegations: ChatTranscriptLog['delegations'],
  message: PersistedChatMessage,
  created: CreatedArtifacts,
): Promise<void> {
  for await (const reference of source.artifacts.referenceClosure(
    sourceChatId,
    message,
  ))
    await source.artifacts.copyToChat(
      sourceChatId,
      targetChatId,
      reference,
      targetArtifacts,
      created,
    );

  const logical = message.blocksRef
    ? await source.artifacts.expandBlocks(sourceChatId, message)
    : message;
  for (const block of logical.blocks) {
    for (const reference of storedArtifactRefsOf(block))
      await source.artifacts.copyArtifactToChat(
        sourceChatId,
        targetChatId,
        reference,
        targetArtifacts,
        created,
      );
    // A card's child transcript lives beside the transcript, not in it: carry
    // each run even when its bounded parent row stores the card in block pages.
    if (
      block.type === 'delegated_agent_call' &&
      block.transcriptStore === DELEGATION_TRANSCRIPT_CHAT_LOG
    )
      await source.delegations.copyRun(
        sourceChatId,
        targetChatId,
        block,
        targetDelegations,
        created,
      );
    // Stream-marked cards are handled together by copyStreamClosure before
    // the row transaction, never here in a lazy import payload. In particular,
    // every kept primary/child artifact must precede catalog publication.
  }
}

export interface ChatStorageImportOptions {
  merge?: boolean;
  mutationId?: string;
  sourceChatIds?: Readonly<Record<string, string>>;
  settleFork?: boolean;
  /** Destination chat id to inclusive canonical source-message anchor. */
  throughMessageIds?: Readonly<Record<string, string>>;
  transformMessage?: (
    message: PersistedChatMessage,
    chatId: string,
  ) => PersistedChatMessage;
  /** Refreshes asynchronous authorization inputs before the final sync check. */
  preparePublish?: () => Promise<void>;
  /** Final authorization check after payload preparation, before publication. */
  beforePublish?: () => void;
}

export interface ChatReadSelection {
  chatIds?: readonly string[];
  fullTranscript?: boolean;
  /**
   * Return stored delegation cards without the stream descriptor overlay.
   * Startup recovery only: a whole-chat replacement built from overlaid
   * cards would drop their stored text and reference pairs (phase 11b, B4).
   */
  rawStreamCards?: boolean;
  pageOnly?: boolean;
  /** Own-card lookup; legacy cards may also hydrate origin/sibling anchors. */
  messageAnchor?: {
    messageId: string;
    fallbackMessageId?: string;
    previousRunMessageId?: string;
  };
}
export interface V2MutationOptions
  extends ChatMutationOptions, ChatReadSelection {}
export interface V2Commit {
  baseRevision: number;
  revision: number;
  state: CanonicalChatState;
  record: ChatJournalRecord;
  applied: boolean;
  /**
   * Chats whose prepared transcript writes are proven additions only. Missing
   * means callers must treat the commit conservatively.
   */
  appendOnlyChatIds?: readonly string[];
  promotedVisuals?: PromotedVisual[];
}
/** A commit admitted for group commit ({@link ChatStateV2Backend.admit}). */
export interface V2Admission {
  commit: V2Commit;
  /**
   * Present while the commit's delta-journal record is not durable: it
   * resolves when the record's batch is synced and rejects when that batch
   * failed. Absent when the commit is durable already.
   */
  durable?: Promise<void>;
}
/**
 * A lease link: settles when `operation` does, without its outcome, so an
 * idle chain does not keep its last read or commit result alive.
 */
export function settledLease(operation: Promise<unknown>): Promise<void> {
  return operation.then(
    () => undefined,
    () => undefined,
  );
}

function preparedRowKey(chatId: string, messageId: string): string {
  return JSON.stringify([chatId, messageId]);
}

/** Named checkpoints exposed to the repository's deterministic recovery tests. */
export type ChatStorageTransactionCheckpoint =
  | 'prepared'
  | 'journal'
  | 'transcripts'
  | 'indexes';

type TransactionBuilder = (
  current: CanonicalChatState,
  revision: number,
  context: ChatStateTransactionContext,
) => ChatCoreMutation[] | Promise<ChatCoreMutation[]>;
export interface TranscriptConsumeOptions {
  /**
   * Follow each card whose children are in the chat's delegate log with
   * those children as rows, and drop the card's `transcriptStore`: the form
   * cards had before delegate logs. For copies that leave this scope's chat
   * storage (publication, a resumed archive), which carry no delegate logs.
   */
  readonly inlineDelegationChildren?: boolean;
  /**
   * Skip active rows whose id is already committed, as the full compatibility
   * view does, while holding only the active ids.
   */
  readonly excludeCommittedActiveEchoes?: boolean;
  /** A missing chat or a file tab yields no rows instead of failing. */
  readonly skipNonChatTabs?: boolean;
}

interface Delta {
  replacement?: readonly PersistedChatMessage[];
  upserts: Map<string, PersistedChatMessage>;
  insertions: Map<string, string>;
  removed: Set<string>;
  artifactSource?: string;
  reportReplacement?: boolean;
}

type VisualOwnerIndex = NonNullable<ChatRecoveryIndex['visualOwnersByChatId']>;

function isVisualOwnerFence(value: unknown): value is VisualOwnerFence {
  return (
    isRecord(value) &&
    typeof value.messageId === 'string' &&
    value.messageId.length > 0 &&
    typeof value.toolUseId === 'string' &&
    value.toolUseId.length > 0 &&
    typeof value.claimedAt === 'number' &&
    Number.isFinite(value.claimedAt) &&
    (!Object.prototype.hasOwnProperty.call(value, 'codexCallId') ||
      typeof value.codexCallId === 'string')
  );
}

function readVisualOwnerIndex(value: unknown): VisualOwnerIndex | undefined {
  if (!isRecord(value)) return undefined;
  const index: VisualOwnerIndex = {};
  for (const chatId of Object.keys(value)) {
    const rawOwners = value[chatId];
    if (!isRecord(rawOwners)) return undefined;
    const owners: Record<string, VisualOwnerFence> = {};
    for (const visualId of Object.keys(rawOwners)) {
      const owner = rawOwners[visualId];
      if (!isVisualOwnerFence(owner)) return undefined;
      owners[visualId] = owner;
    }
    index[chatId] = owners;
  }
  return index;
}

function sameVisualOwner(
  left: VisualOwnerFence,
  right: Pick<VisualOwnerFence, 'messageId' | 'toolUseId'>,
): boolean {
  return (
    left.messageId === right.messageId && left.toolUseId === right.toolUseId
  );
}

function sameVisualOwnerMessage(
  owner: VisualOwnerFence,
  message: PersistedChatMessage,
  toolUseId: string,
): boolean {
  return owner.messageId === message.id && owner.toolUseId === toolUseId;
}

/** Transaction-local copy-on-write state for one recovery index ledger. */
class VisualOwnerLedgerView {
  private readonly original: VisualOwnerIndex | undefined;
  private readonly edited = new Map<string, Map<string, VisualOwnerFence>>();
  private readonly reservations = new Map<
    string,
    Map<string, VisualOwnerFence>
  >();
  private readonly promotions = new Map<
    string,
    Map<string, VisualOwnerFence>
  >();

  public readonly unknown: boolean;

  public constructor(recovery: ChatRecoveryIndex) {
    const hasLedger = Object.prototype.hasOwnProperty.call(
      recovery,
      'visualOwnersByChatId',
    );
    const raw: unknown = Reflect.get(recovery, 'visualOwnersByChatId');
    const parsed = readVisualOwnerIndex(raw);
    this.unknown = hasLedger && !parsed;
    this.original = parsed;
  }

  public ownerOf(
    chatId: string,
    visualId: string,
  ): VisualOwnerFence | undefined {
    return (
      this.reservations.get(chatId)?.get(visualId) ??
      this.ownerMap(chatId).get(visualId)
    );
  }

  public reserve(
    chatId: string,
    visualId: string,
    owner: VisualOwnerFence,
  ): boolean {
    if (this.unknown) return false;
    const existing = this.ownerOf(chatId, visualId);
    if (existing && !sameVisualOwner(existing, owner)) return false;
    if (!existing)
      this.mutableMap(this.reservations, chatId).set(visualId, owner);
    this.mutableMap(this.promotions, chatId).set(visualId, owner);
    return true;
  }

  public promotionOwner(
    chatId: string,
    visualId: string,
  ): VisualOwnerFence | undefined {
    return this.promotions.get(chatId)?.get(visualId);
  }

  public commitClaim(chatId: string, visualId: string): void {
    const owner = this.reservations.get(chatId)?.get(visualId);
    if (!owner) return;
    this.mutableMap(this.edited, chatId).set(visualId, owner);
    this.reservations.get(chatId)?.delete(visualId);
  }

  public prune(stagedIds: ReadonlySet<string>, now: number): void {
    if (this.unknown) return;
    const cutoff = now - VISUAL_STAGING_RETENTION_MS;
    this.chatIds().forEach((chatId: string) =>
      this.ownerEntries(chatId).forEach((entry: [string, VisualOwnerFence]) => {
        const visualId: string = entry[0];
        const fence: VisualOwnerFence = entry[1];
        if (fence.claimedAt < cutoff && !stagedIds.has(visualId))
          this.mutableMap(this.edited, chatId).delete(visualId);
      }),
    );
  }

  public removeChat(chatId: string): void {
    if (this.unknown) return;
    if (this.ownerEntries(chatId).length > 0)
      this.edited.set(chatId, new Map());
    this.reservations.delete(chatId);
    this.promotions.delete(chatId);
  }

  public toIndex(): VisualOwnerIndex | undefined {
    if (this.unknown) return undefined;
    if (
      this.edited.size === 0 &&
      this.original &&
      Object.values(this.original).every(
        (owners) => Object.keys(owners).length > 0,
      )
    )
      return this.original;
    const next: VisualOwnerIndex = {};
    for (const chatId of Object.keys(this.original ?? {})) {
      const owners = this.original?.[chatId];
      if (owners && Object.keys(owners).length > 0) next[chatId] = owners;
    }
    this.edited.forEach(
      (owners: Map<string, VisualOwnerFence>, chatId: string) => {
        if (owners.size === 0) delete next[chatId];
        else {
          const nextOwners: Record<string, VisualOwnerFence> = {};
          owners.forEach((owner: VisualOwnerFence, visualId: string) => {
            nextOwners[visualId] = owner;
          });
          next[chatId] = nextOwners;
        }
      },
    );
    return Object.keys(next).length > 0 ? next : undefined;
  }

  private ownerMap(chatId: string): ReadonlyMap<string, VisualOwnerFence> {
    const edited = this.edited.get(chatId);
    if (edited) return edited;
    const owners = new Map<string, VisualOwnerFence>();
    const source = this.original?.[chatId];
    if (source)
      for (const visualId of Object.keys(source)) {
        const owner = source[visualId];
        if (owner) owners.set(visualId, owner);
      }
    return owners;
  }

  private ownerEntries(chatId: string): Array<[string, VisualOwnerFence]> {
    const edited = this.edited.get(chatId);
    if (edited) return Array.from(edited.entries());
    const owners = this.original?.[chatId];
    const entries: Array<[string, VisualOwnerFence]> = [];
    if (owners)
      for (const visualId of Object.keys(owners)) {
        const owner = owners[visualId];
        if (owner) entries.push([visualId, owner]);
      }
    return entries;
  }

  private mutableMap(
    target: Map<string, Map<string, VisualOwnerFence>>,
    chatId: string,
  ): Map<string, VisualOwnerFence> {
    let owners = target.get(chatId);
    if (!owners) {
      owners = new Map(this.ownerEntries(chatId));
      target.set(chatId, owners);
    }
    return owners;
  }

  private chatIds(): Set<string> {
    const chatIds = new Set<string>();
    for (const chatId of Object.keys(this.original ?? {})) chatIds.add(chatId);
    const editedChatIds: string[] = Array.from(this.edited.keys());
    for (const chatId of editedChatIds) chatIds.add(chatId);
    return chatIds;
  }
}

function installVisualOwnerLedger(
  recovery: ChatRecoveryIndex,
  ledger: VisualOwnerLedgerView,
): void {
  if (ledger.unknown) return;
  const owners = ledger.toIndex();
  if (owners) recovery.visualOwnersByChatId = owners;
  else delete recovery.visualOwnersByChatId;
}

function codexCallId(toolUseId: string): string | undefined {
  const prefix = 'codex-';
  return toolUseId.startsWith(prefix) && toolUseId.length > prefix.length
    ? toolUseId.slice(prefix.length)
    : undefined;
}

function linkedToolCallFromBlock(
  block: Extract<PersistedChatMessage['blocks'][number], { type: 'tool_use' }>,
): LinkedToolCall {
  const callId = codexCallId(block.toolUseId);
  return {
    toolUseId: block.toolUseId,
    ...(block.toolName.length > 0 ? { toolName: block.toolName } : {}),
    ...(callId ? { codexCallId: callId } : {}),
  };
}

function sameLinkedToolCall(
  left: LinkedToolCall,
  right: LinkedToolCall,
): boolean {
  return (
    left.toolName === right.toolName && left.codexCallId === right.codexCallId
  );
}

function addToolCalls(
  lookup: Map<string, LinkedToolCall | null>,
  messages: readonly PersistedChatMessage[],
): void {
  for (const message of messages)
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      const call = linkedToolCallFromBlock(block);
      if (!lookup.has(call.toolUseId)) lookup.set(call.toolUseId, call);
      else {
        const previous = lookup.get(call.toolUseId);
        if (previous && !sameLinkedToolCall(previous, call))
          lookup.set(call.toolUseId, null);
      }
    }
}

function messagesOnTab(
  tab: PersistedChatTab | undefined,
): PersistedChatMessage[] {
  return tab && Object.prototype.propertyIsEnumerable.call(tab, 'messages')
    ? tab.messages
    : [];
}

function messagesFromMutation(
  mutation: ChatCoreMutation,
  chatId: string,
): readonly PersistedChatMessage[] {
  if (mutation.type === 'message.upserted')
    return mutation.chatId === chatId ? [mutation.message] : [];
  if (mutation.type === 'messages.replaced')
    return mutation.chatId === chatId ? mutation.messages : [];
  if (mutation.type === 'tab.created')
    return mutation.tab.id === chatId ? messagesOnTab(mutation.tab) : [];
  if (mutation.type === 'archive.upserted')
    return mutation.entry.tab.id === chatId
      ? messagesOnTab(mutation.entry.tab)
      : [];
  return [];
}

function erroredToolUseIds(
  messages: readonly PersistedChatMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages)
    for (const block of message.blocks)
      if (block.type === 'tool_result' && block.isError)
        ids.add(block.toolUseId);
  return ids;
}

function lookupToolCall(
  lookup: ReadonlyMap<string, LinkedToolCall | null>,
  toolUseId: string,
): LinkedToolCall | undefined {
  return lookup.get(toolUseId) ?? undefined;
}

function externalizeVisualContext(
  chatId: string,
  admission: ProviderVisualAdmission,
  ledger: VisualOwnerLedgerView,
  incomingMessages: readonly PersistedChatMessage[],
  currentMessages: readonly PersistedChatMessage[],
): ExternalizeVisualContext {
  const incoming = new Map<string, LinkedToolCall | null>();
  const current = new Map<string, LinkedToolCall | null>();
  addToolCalls(incoming, incomingMessages);
  addToolCalls(current, currentMessages);
  const blockedToolUseIds = erroredToolUseIds(incomingMessages);
  return {
    kind: 'provider',
    chatId,
    hasStagedEntries: () => !ledger.unknown && admission.staging.hasEntries(),
    linkedToolCall: (toolUseId): LinkedToolCall | undefined => {
      if (blockedToolUseIds.has(toolUseId)) return undefined;
      if (incoming.has(toolUseId)) return lookupToolCall(incoming, toolUseId);
      return lookupToolCall(current, toolUseId);
    },
    resolveToolKey: admission.resolveToolKey,
    ownerOf: (visualId) => ledger.ownerOf(chatId, visualId),
    reserve: (visualId, owner) => ledger.reserve(chatId, visualId, owner),
    readStaged: (visualId) => admission.staging.readCandidate(chatId, visualId),
    now: () => admission.now(),
  };
}

function preserveVisualReferences(
  previous: PersistedChatMessage | undefined,
  incoming: PersistedChatMessage,
): PersistedChatMessage {
  if (!previous) return incoming;
  const references = new Map<string, PersistedVisualReference>();
  for (const block of previous.blocks)
    if (block.type === 'tool_result' && block.visualRef)
      references.set(block.toolUseId, block.visualRef);
  let changed = false;
  const blocks = incoming.blocks.map((block) => {
    if (block.type !== 'tool_result' || block.visualRef) return block;
    const visualRef = references.get(block.toolUseId);
    if (!visualRef) return block;
    changed = true;
    return { ...block, visualRef };
  });
  return changed ? { ...incoming, blocks } : incoming;
}

function messagesFromMutations(
  mutations: readonly ChatCoreMutation[],
  chatId: string,
): PersistedChatMessage[] {
  const messages: PersistedChatMessage[] = [];
  for (const mutation of mutations)
    messages.push(...messagesFromMutation(mutation, chatId));
  return messages;
}

function messageIdsFromMutation(mutation: ChatCoreMutation): string[] {
  if (mutation.type === 'message.upserted') return [mutation.message.id];
  if (mutation.type === 'messages.replaced')
    return mutation.messages.map((message) => message.id);
  if (mutation.type === 'tab.created')
    return messagesOnTab(mutation.tab).map((message) => message.id);
  if (mutation.type === 'archive.upserted')
    return messagesOnTab(mutation.entry.tab).map((message) => message.id);
  return [];
}

function previousMessagesForMutations(
  mutations: readonly ChatCoreMutation[],
  tabs: ReadonlyMap<string, PersistedChatTab>,
): Map<string, Map<string, PersistedChatMessage>> {
  const requested = new Map<string, Set<string>>();
  for (const mutation of mutations) {
    const chatId =
      mutation.type === 'message.upserted' ||
      mutation.type === 'message.removed' ||
      mutation.type === 'messages.replaced'
        ? mutation.chatId
        : mutation.type === 'tab.created'
          ? mutation.tab.id
          : mutation.type === 'archive.upserted'
            ? mutation.entry.tab.id
            : undefined;
    if (!chatId) continue;
    const ids = messageIdsFromMutation(mutation);
    if (ids.length === 0) continue;
    const wanted = requested.get(chatId) ?? new Set<string>();
    for (const id of ids) wanted.add(id);
    requested.set(chatId, wanted);
  }
  const previous = new Map<string, Map<string, PersistedChatMessage>>();
  requested.forEach((ids: Set<string>, chatId: string) => {
    const messages = new Map<string, PersistedChatMessage>();
    messagesOnTab(tabs.get(chatId)).forEach((message) => {
      if (ids.has(message.id)) messages.set(message.id, message);
    });
    previous.set(chatId, messages);
  });
  return previous;
}

/** Rows a mutation writes into an existing chat's transcript. */
function rowsCarriedBy(
  mutation: ChatCoreMutation,
): { chatId: string; messages: readonly PersistedChatMessage[] } | undefined {
  if (mutation.type === 'message.upserted')
    return { chatId: mutation.chatId, messages: [mutation.message] };
  if (mutation.type === 'messages.replaced')
    return { chatId: mutation.chatId, messages: mutation.messages };
  if (mutation.type === 'archive.upserted')
    return {
      chatId: mutation.entry.tab.id,
      messages: messagesOnTab(mutation.entry.tab),
    };
  if (mutation.type === 'tab.created')
    return { chatId: mutation.tab.id, messages: messagesOnTab(mutation.tab) };
  return undefined;
}

/** A result row whose existing visual reference must be carried forward. */
function needsPreviousResult(message: PersistedChatMessage): boolean {
  return message.blocks.some(
    (block) => block.type === 'tool_result' && !block.visualRef,
  );
}

function currentToolMessagesForMutations(
  mutations: readonly ChatCoreMutation[],
  tabs: ReadonlyMap<string, PersistedChatTab>,
): Map<string, readonly PersistedChatMessage[]> {
  const chatIds = new Set<string>();
  for (const mutation of mutations)
    if (mutation.type === 'message.upserted') chatIds.add(mutation.chatId);
  const messages = new Map<string, readonly PersistedChatMessage[]>();
  chatIds.forEach((chatId: string) => {
    messages.set(chatId, messagesOnTab(tabs.get(chatId)));
  });
  return messages;
}

function externalizeVisualContexts(
  mutations: readonly ChatCoreMutation[],
  currentMessagesByChatId: ReadonlyMap<string, readonly PersistedChatMessage[]>,
  admission: ProviderVisualAdmission | undefined,
  ledger: VisualOwnerLedgerView,
): Map<string, ExternalizeVisualContext> {
  const contexts = new Map<string, ExternalizeVisualContext>();
  if (!admission) return contexts;
  const chatIds = new Set<string>();
  for (const mutation of mutations)
    if (mutation.type === 'message.upserted') chatIds.add(mutation.chatId);
  chatIds.forEach((chatId: string) => {
    contexts.set(
      chatId,
      externalizeVisualContext(
        chatId,
        admission,
        ledger,
        messagesFromMutations(mutations, chatId),
        currentMessagesByChatId.get(chatId) ?? [],
      ),
    );
  });
  return contexts;
}

function promotedVisualsInWrites(
  projectedMessages: ReadonlyMap<ChatCoreMutation, PersistedChatMessage>,
  deltas: ReadonlyMap<string, Delta>,
  writes: readonly ChatTranscriptWrite[],
  ledger: VisualOwnerLedgerView,
): PromotedVisual[] {
  const writableChats = new Set(
    writes
      .filter((write) => write.kind !== 'delete')
      .map((write) => write.chatId),
  );
  const emittedByChat = new Map<string, Set<string>>();
  const promoted: PromotedVisual[] = [];
  projectedMessages.forEach(
    (message: PersistedChatMessage, mutation: ChatCoreMutation) => {
      if (mutation.type !== 'message.upserted') return;
      const delta = deltas.get(mutation.chatId);
      if (
        !writableChats.has(mutation.chatId) ||
        delta?.upserts.get(message.id) !== message
      )
        return;
      for (const block of message.blocks) {
        if (block.type !== 'tool_result' || !block.visualRef) continue;
        const owner = ledger.promotionOwner(
          mutation.chatId,
          block.visualRef.visualId,
        );
        if (!owner || !sameVisualOwnerMessage(owner, message, block.toolUseId))
          continue;
        const emitted = emittedByChat.get(mutation.chatId) ?? new Set<string>();
        if (emitted.has(block.visualRef.visualId)) continue;
        emitted.add(block.visualRef.visualId);
        emittedByChat.set(mutation.chatId, emitted);
        ledger.commitClaim(mutation.chatId, block.visualRef.visualId);
        promoted.push({
          chatId: mutation.chatId,
          visualId: block.visualRef.visualId,
          reference: block.visualRef,
        });
      }
    },
  );
  return promoted;
}

/** A checkpoint replaced the journal file without changing committed state. */
export interface DeltaJournalCheckpointRotation {
  previousMtimeNs: string;
  mtimeNs: string;
}

async function journalMtimeNs(path: string): Promise<string | undefined> {
  try {
    return (await stat(path, { bigint: true })).mtimeNs.toString();
  } catch {
    return undefined;
  }
}

export interface ChatStateV2BackendOptions {
  /** Format 4 writes and promotion; promotion is further gated by `format4Promotion`. */
  enableFormat4?: boolean;
  /**
   * Whether a writable format 3 scope may promote now, asked at each attempt.
   * Absent means yes. A scope already in format 4 stays in format 4.
   */
  format4Promotion?: () => boolean;
  /**
   * Content-free format 4 outcomes (CAN-6217): promotion attempts and
   * checkpoint durations of format 4 scopes. Never changes the storage work.
   */
  onFormat4Outcome?: (outcome: ChatFormat4Outcome) => void;
  /**
   * Admit version 3 (delta-journal) scopes and write them through the
   * journal. Only the chat state repository sets it. A backend constructed
   * without it fails closed on a version 3 scope, as every writer outside
   * the repository must: its version 2 transactions refuse the format.
   */
  deltaJournal?: {
    /** Test-only durability fault seam; absent in production. */
    onBoundary?: ChatDeltaJournalWriterOptions['onBoundary'];
    onDiagnostic?: (diagnostic: DeltaJournalDiagnostic) => void;
    /** Lets journal-mtime fingerprints follow a checkpoint's rotation. */
    onCheckpointed?: (rotation: DeltaJournalCheckpointRotation) => void;
    checkpointJournalBytes?: number;
    /** See {@link ChatDeltaJournalWriterOptions.incrementalStreamMetadata}. */
    incrementalStreamMetadata?: boolean;
    /** Overrides {@link LARGE_JOURNAL_RECORD_BYTES}; tests use it. */
    largeRecordBytes?: number;
    promotionRetry?: PromotionRetryOptions;
  };
  /** Content-free report for an unrecognized or malformed visual owner ledger. */
  onVisualOwnerLedgerInvalid?: (detail: { reason: string }) => void;
  /** Test-only interruption seam, forwarded to the real storage transaction. */
  testHooks?: {
    storageCheckpoint?: (
      point: ChatStorageTransactionCheckpoint,
    ) => Promise<void>;
  };
}

type RegistryIdentity = {
  readonly chatId: string;
  readonly delegationId: string;
};

function registryFailure(
  code: DelegationRegistryFailure['code'],
  message: string,
  details: Pick<
    DelegationRegistryFailure,
    'storedItemRevision' | 'storedLastResultIndex'
  > = {},
): DelegationRegistryOperationError {
  return new DelegationRegistryOperationError({
    code,
    message,
    retryable: false,
    ...details,
  });
}

function validateRegistryIdentity(identity: RegistryIdentity): void {
  if (!isRecord(identity))
    throw registryFailure('invalid_request', 'Invalid delegation identity');
  for (const [name, value] of Object.entries(identity))
    if (
      (name === 'chatId' || name === 'delegationId') &&
      (typeof value !== 'string' || value.length < 1 || value.length > 256)
    )
      throw registryFailure('invalid_request', `Invalid ${name}`);
  if (
    typeof identity.chatId !== 'string' ||
    typeof identity.delegationId !== 'string'
  )
    throw registryFailure('invalid_request', 'Invalid delegation identity');
}

function validCounter(value: unknown, minimum = 0): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
  );
}

function registryMutationId(value: unknown): string {
  return createHash('sha256')
    .update(canonicalDelegationJson(value), 'utf8')
    .digest('hex');
}

const ACTIVE = new Set([
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
]);
const TOOL_OUTPUT_OWNERSHIP_CHAT_CACHE_LIMIT = 64;
const TOOL_OUTPUT_OWNERSHIP_KEY_CACHE_LIMIT = 64;

interface TranscriptReadContext {
  projectId: string;
  worktreeId: string;
  chatId: string;
  target?: TranscriptTarget;
  cursor?: string;
  archivedContainerId?: string;
  standaloneHistory?: boolean;
  before?: number;
  transcriptRevision?: number;
}

type TranscriptPageReadOptions = TranscriptViewRequest &
  Partial<TranscriptReadContext> & { limit?: number };

type DelegationTarget = Extract<TranscriptTarget, { kind: 'delegation' }>;

interface ChildTranscriptReader {
  descriptor: TranscriptStreamDescriptor;
  runTruncated?: true;
  legacy?: true;
  page: (options: { before?: number; limit?: number }) => Promise<{
    rows: readonly DelegationChildRow[];
    nextBefore?: number;
  }>;
  row: (messageId: string) => Promise<DelegationChildRow | undefined>;
  compatibility: () => Promise<ChildStreamCompatibilitySource>;
}

function compatibilityPageFailure(
  code: 'invalid_request' | 'not_found' | 'failed',
  reason: string,
): ChildStreamCompatibilityPageReply {
  return { ok: false, code, reason };
}

interface CompatibilityField {
  text: string;
  truncated: boolean;
}

function compatibilityField(
  value: string,
  referenced: boolean,
): CompatibilityField {
  if (referenced) return { text: value, truncated: true };
  if (
    Buffer.byteLength(value, 'utf8') <=
    DELEGATION_COMPATIBILITY_PAGE_LIMITS.inlineFieldBytes
  )
    return { text: value, truncated: false };

  let text = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (
      bytes + characterBytes >
      DELEGATION_COMPATIBILITY_PAGE_LIMITS.inlineFieldBytes
    )
      break;
    text += character;
    bytes += characterBytes;
  }
  return {
    text: `${text}${DELEGATION_COMPATIBILITY_NOTICES.truncated}`,
    truncated: true,
  };
}

function compatibilityTruncation(truncated: boolean): { truncated?: true } {
  return truncated ? { truncated: true } : {};
}

function isCompatibilityLabel(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
}

function compatibilityItem(
  target: DelegationTarget,
  row: DelegationChildRow,
): AgentDelegationTranscriptItem {
  const sequence = row.delegationSequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence))
    throw new Error('Child row lacks delegation sequence');
  if (row.blocksRef !== undefined)
    throw new Error('Child row block references are unsupported');
  const prefix = `${delegationBlockId(
    target.delegationId,
    target.runGeneration,
  )}:`;
  if (!row.id.startsWith(prefix))
    throw new Error('Child row id does not have the target card prefix');
  const id = row.id.slice(prefix.length);
  if (!isCompatibilityLabel(id))
    throw new Error('Child row id has an invalid compatibility prefix suffix');
  const identity = {
    id,
    sequence,
    occurredAt: row.timestamp,
  };
  const blocks = row.blocks;
  const first = blocks[0];
  if (blocks.length === 1 && first) {
    if (first.type === 'text') {
      const text = compatibilityField(first.text, first.textRef !== undefined);
      return {
        ...identity,
        type: 'text',
        text: text.text,
        ...(row.delegationAuthor === undefined
          ? {}
          : { author: row.delegationAuthor }),
        ...(row.delegationDelivery === undefined
          ? {}
          : { delivery: row.delegationDelivery }),
        ...compatibilityTruncation(text.truncated),
      };
    }
    if (first.type === 'thinking') {
      const text = compatibilityField(first.text, first.textRef !== undefined);
      return {
        ...identity,
        type: 'thinking',
        text: text.text,
        ...compatibilityTruncation(text.truncated),
      };
    }
    if (first.type === 'tool_use') {
      const input = compatibilityField(
        first.input,
        first.inputRef !== undefined,
      );
      return {
        ...identity,
        type: 'tool',
        toolName: first.toolName,
        input: input.text,
        ...compatibilityTruncation(input.truncated),
      };
    }
    if (first.type === 'tool_result') {
      const output = compatibilityField(
        first.output,
        first.fullOutputRef !== undefined,
      );
      return {
        ...identity,
        type: 'tool',
        toolName: first.toolName,
        input: '',
        output: output.text,
        isError: first.isError,
        ...compatibilityTruncation(output.truncated),
      };
    }
    if (first.type === 'image')
      return {
        ...identity,
        type: 'text',
        text: DELEGATION_COMPATIBILITY_NOTICES.image,
        truncated: true,
      };
  }

  const second = blocks[1];
  if (
    first?.type === 'tool_use' &&
    second?.type === 'tool_result' &&
    first.toolUseId === second.toolUseId
  ) {
    const images = blocks.slice(2);
    if (
      images.length === 0 ||
      (images.length <= 4 && images.every((block) => block.type === 'image'))
    ) {
      const input = compatibilityField(
        first.input,
        first.inputRef !== undefined,
      );
      const output = compatibilityField(
        second.output,
        second.fullOutputRef !== undefined,
      );
      const imageNotice =
        images.length > 0 ? DELEGATION_COMPATIBILITY_NOTICES.images : '';
      return {
        ...identity,
        type: 'tool',
        toolName: first.toolName,
        input: input.text,
        output: `${output.text}${imageNotice}`,
        isError: second.isError,
        ...compatibilityTruncation(
          input.truncated || output.truncated || images.length > 0,
        ),
      };
    }
  }

  if (
    first?.type === 'text' &&
    blocks.length >= 2 &&
    blocks.length <= 5 &&
    blocks.slice(1).every((block) => block.type === 'image')
  ) {
    const text = compatibilityField(first.text, first.textRef !== undefined);
    return {
      ...identity,
      type: 'text',
      text: `${text.text}${DELEGATION_COMPATIBILITY_NOTICES.images}`,
      ...(row.delegationAuthor === undefined
        ? {}
        : { author: row.delegationAuthor }),
      ...(row.delegationDelivery === undefined
        ? {}
        : { delivery: row.delegationDelivery }),
      truncated: true,
    };
  }

  throw new Error('Unsupported child row compatibility block shape');
}

function unknownChildStream(): never {
  throw new Error('Unknown child stream');
}

function staleStreamCursor(): never {
  throw new Error('Stale transcript stream cursor');
}

function isStaleStreamCursorError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === 'Stale transcript stream cursor'
  );
}

function staleBlocksCursor(): never {
  throw new Error('Stale transcript blocks cursor');
}

function isUnknownChildStreamError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Unknown child stream';
}

/** Validate supplied target identity at the backend boundary. Legacy readers
 * omit target, so that hot path does no schema work. */
function validateReadTarget(
  target: TranscriptTarget | undefined,
  chatId: string,
): void {
  if (target === undefined) return;
  const parsed = TranscriptTargetSchema.safeParse(target);
  if (!parsed.success) throw new Error('Transcript target does not match chat');
  if (parsed.data.chatId !== chatId) {
    if (parsed.data.kind === 'delegation') return unknownChildStream();
    throw new Error('Transcript target does not match chat');
  }
}

function streamBackedTarget(
  chatId: string,
  block: PersistedChatBlock,
): DelegationTarget | undefined {
  return block.type === 'delegated_agent_call' &&
    block.transcriptStore === 'chat-stream-v2'
    ? {
        kind: 'delegation',
        chatId,
        delegationId: block.delegationId,
        runGeneration: block.runGeneration,
      }
    : undefined;
}
const EMPTY_DESCRIPTOR: TranscriptDescriptor = {
  format: 'complete-message-jsonl-v1',
  committedMessageCount: 0,
  committedByteLength: 0,
  transcriptRevision: 0,
  hasActiveSidecar: false,
};

/** Unloaded history is an explicit programming error, never an empty array. */
export class ChatTranscriptNotLoadedError extends Error {
  public constructor(public readonly chatId: string) {
    super(`Transcript ${chatId} was not selected for this operation`);
  }
}

function metadataTab(
  entry: ChatIndexEntry,
  guarded: boolean,
): PersistedChatTab {
  const { transcript, ...metadata } = entry;
  const tab: PersistedChatTab = normalizeLegacyPersistedChatTab({
    ...metadata,
    messages: [],
  });
  Object.defineProperty(
    tab,
    'messages',
    guarded
      ? {
          enumerable: false,
          configurable: true,
          get: (): never => {
            throw new ChatTranscriptNotLoadedError(entry.id);
          },
        }
      : { enumerable: true, configurable: true, writable: true, value: [] },
  );
  // Internal readers can inspect counts without loading the body. Transport
  // snapshots attach this explicitly rather than serializing a guarded tab.
  Object.defineProperty(tab, 'transcript', {
    enumerable: true,
    value: transcript,
  });
  return tab;
}

function metadataState(
  indexes: ChatStorageIndexes,
  guarded: boolean,
): CanonicalChatState {
  const { tabs, runtimeByChatId, ...live } = indexes.live;
  return {
    tabsFile: {
      ...live,
      version: 1,
      tabs: tabs.map((tab) => metadataTab(tab, guarded)),
    },
    archivesFile: {
      version: 1,
      revision: indexes.archive.revision,
      archived: indexes.archive.archived.map((entry) => ({
        ...entry,
        tab: metadataTab(entry.tab, guarded),
      })),
    },
    runtimeByChatId,
  };
}

/**
 * A view's private copy of `indexes`, except each tab's turn history: those
 * fields hold megabytes in long chats and every writer replaces them through
 * a spread, never edits them, so views share them with the committed indexes.
 */
function cloneSharingTurnHistory(
  indexes: ChatStorageIndexes,
): ChatStorageIndexes {
  const withoutHistory = ({
    turnDiffs: _turnDiffs,
    inputDelivery: _inputDelivery,
    agentArtifactCarryByTurn: _carry,
    ...entry
  }: ChatIndexEntry): ChatIndexEntry => {
    void _turnDiffs;
    void _inputDelivery;
    void _carry;
    return entry;
  };
  const withHistory = (
    copy: ChatIndexEntry,
    { turnDiffs, inputDelivery, agentArtifactCarryByTurn }: ChatIndexEntry,
  ): ChatIndexEntry => ({
    ...copy,
    ...(turnDiffs === undefined ? {} : { turnDiffs }),
    ...(inputDelivery === undefined ? {} : { inputDelivery }),
    ...(agentArtifactCarryByTurn === undefined
      ? {}
      : { agentArtifactCarryByTurn }),
  });
  const copy = structuredClone({
    ...indexes,
    live: { ...indexes.live, tabs: indexes.live.tabs.map(withoutHistory) },
    archive: {
      ...indexes.archive,
      archived: indexes.archive.archived.map((entry) => ({
        ...entry,
        tab: withoutHistory(entry.tab),
      })),
    },
  });
  return {
    ...copy,
    live: {
      ...copy.live,
      tabs: copy.live.tabs.map((tab, index) =>
        withHistory(tab, indexes.live.tabs[index] ?? tab),
      ),
    },
    archive: {
      ...copy.archive,
      archived: copy.archive.archived.map((entry, index) => ({
        ...entry,
        tab: withHistory(
          entry.tab,
          indexes.archive.archived[index]?.tab ?? entry.tab,
        ),
      })),
    },
  };
}

function allEntries(indexes: ChatStorageIndexes): ChatIndexEntry[] {
  return [
    ...indexes.live.tabs,
    ...indexes.archive.archived.map((entry) => entry.tab),
  ];
}
function boundedIds(
  values: readonly string[],
  additions: readonly string[],
  limit: number,
): string[] {
  const set = new Set(values);
  for (const id of additions) {
    set.delete(id);
    set.add(id);
  }
  return Array.from(set).slice(-limit);
}

/** A load may introduce independent strings in every live and archived ledger. */
function shareLoadedInputLedgerText(
  indexes: ChatStorageIndexes,
): ChatStorageIndexes {
  for (const tab of indexes.live.tabs) shareInputLedgerText(tab.inputDelivery);
  for (const entry of indexes.archive.archived)
    shareInputLedgerText(entry.tab.inputDelivery);
  return indexes;
}

interface InputLedgerTextChange {
  archived: boolean;
  index: number;
  previous: ChatIndexEntry | undefined;
}

function inputHiddenTextHolder(payload: unknown): object | undefined {
  if (!isRecord(payload)) return undefined;
  const context: unknown = Reflect.get(payload, 'hiddenContext');
  return isRecord(context) ? context : undefined;
}

function rememberInputText(
  holder: object | undefined,
  key: string,
  parents: Map<string, string>,
): void {
  if (!holder) return;
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  if (
    descriptor &&
    'value' in descriptor &&
    typeof descriptor.value === 'string'
  )
    parents.set(descriptor.value, descriptor.value);
}

function retainInputTextProperty(
  holder: object | undefined,
  key: string,
  parents: ReadonlyMap<string, string>,
): void {
  if (!holder) return;
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  if (
    !descriptor ||
    !('value' in descriptor) ||
    descriptor.writable !== true ||
    typeof descriptor.value !== 'string'
  )
    return;
  const parent = parents.get(descriptor.value);
  if (parent !== undefined)
    Reflect.defineProperty(holder, key, { ...descriptor, value: parent });
}

/**
 * The journal retains its checkpoint graph until rotation. Reuse equal parent
 * strings from the previous canonical row so a replacement row does not keep
 * another flat copy alive alongside that checkpoint. Never retain a text table.
 */
function retainPreviousInputText(ledger: unknown, previous: unknown): void {
  try {
    if (
      !isInputLedger(previous) ||
      !isInputLedger(ledger) ||
      ledger.rows === previous.rows
    )
      return;
    const previousRows = new Map(previous.rows.map((row) => [row.id, row]));
    for (const row of ledger.rows) {
      const previousRow = previousRows.get(row.id);
      if (!previousRow || row === previousRow) continue;
      const submittedParents = new Map<string, string>();
      const hiddenParents = new Map<string, string>();
      rememberInputText(
        inputHiddenTextHolder(previousRow.payload),
        'text',
        hiddenParents,
      );
      for (const attempt of previousRow.attempts) {
        rememberInputText(attempt, 'submittedText', submittedParents);
        rememberInputText(
          inputHiddenTextHolder(attempt.payloadSnapshot),
          'text',
          hiddenParents,
        );
      }
      retainInputTextProperty(
        inputHiddenTextHolder(row.payload),
        'text',
        hiddenParents,
      );
      for (const attempt of row.attempts) {
        retainInputTextProperty(attempt, 'submittedText', submittedParents);
        retainInputTextProperty(
          inputHiddenTextHolder(attempt.payloadSnapshot),
          'text',
          hiddenParents,
        );
      }
    }
  } catch {
    // Host-owned malformed, frozen or exotic values cannot reject a commit.
  }
}

/** Commit projections preserve tab order; visit only changed ledger positions. */
function shareChangedInputLedgerText(
  indexes: ChatStorageIndexes,
  changes: readonly InputLedgerTextChange[],
): ChatStorageIndexes {
  for (const change of changes) {
    const tab = change.archived
      ? indexes.archive.archived[change.index]?.tab
      : indexes.live.tabs[change.index];
    if (
      tab &&
      (!change.previous || tab.inputDelivery !== change.previous.inputDelivery)
    ) {
      retainPreviousInputText(
        tab.inputDelivery,
        change.previous?.inputDelivery,
      );
      shareInputLedgerText(tab.inputDelivery);
    }
  }
  return indexes;
}

/** Canonical metadata ownership plus explicit per-chat transcript views. */
export class ChatStateV2Backend {
  public readonly storage: ChatStorageTransactions;
  private readonly artifactMaintenance: ChatArtifactMaintenance;
  /** Read-only verifier shared by checkpoint-only registry views. */
  private registryArtifacts?: ChatTranscriptArtifacts;
  private indexes?: ChatStorageIndexes;
  /** Settles without the last operation's result; see `settledLease`. */
  private tail: Promise<void> = Promise.resolve();
  /** The open delta journal while the scope is version 3. */
  private journal?: ChatDeltaJournalWriter;
  /**
   * A large import or replacement demoted the scope for one version 2
   * transaction; it is promoted again at its next idle point.
   */
  private repromote = false;
  private readonly promotionRetry: PromotionRetry;
  private readonly format4PromotionRetry: PromotionRetry;
  // Cache only successful ownership proofs. Transcript revision changes force
  // revalidation, while caps keep occasional artifact reads from accumulating.
  private readonly verifiedArtifactOwnership = new Map<
    string,
    { transcriptRevision: number; keys: Set<string> }
  >();
  // Committed child logs whose full digest was verified, by stream key and
  // file version, so later pages of the same log stay bounded reads.
  private readonly verifiedChildLogs = new Map<string, string>();
  public constructor(
    private readonly store: ChatStorageV2,
    private readonly options: ChatStateV2BackendOptions = {},
  ) {
    if (options.enableFormat4 && store.maxManifestVersion !== 4)
      throw new Error('Format 4 requires a ceiling-4 chat store');
    this.storage = new ChatStorageTransactions(
      store,
      options.testHooks?.storageCheckpoint,
    );
    this.promotionRetry = new PromotionRetry(
      options.deltaJournal?.promotionRetry,
    );
    this.format4PromotionRetry = new PromotionRetry(
      options.deltaJournal?.promotionRetry,
    );
    this.artifactMaintenance = new ChatArtifactMaintenance(
      this.storage,
      store.directory,
    );
  }

  /** Whether the scope is version 3 and committed through its journal. */
  /**
   * The field mode of the manifest this scope transaction selected: the
   * open journal's captured manifest, else the manifest read now, inside
   * the serialized transaction. Never cached on a store.
   */
  private async transcriptFieldMode(): Promise<TranscriptFieldMode> {
    if (this.journal) return this.journal.fieldMode;
    return (await this.store.format()) === 'v4' ? 'format4' : 'legacy';
  }

  public isDeltaJournal(): boolean {
    return this.journal !== undefined;
  }

  /**
   * Whether promotion is wanted at this idle point: after a temporary
   * demotion, or a failed promotion's bounded retry is due.
   */
  public wantsRepromotion(): boolean {
    // A due format 4 retry waits, with its backoff kept, while promotion is
    // withheld; asking for it then would re-queue reconciliation forever.
    return (
      this.repromote ||
      this.promotionRetry.due() ||
      (this.allowsFormat4Promotion() && this.format4PromotionRetry.due())
    );
  }

  /** Promotion policy only: handling selected format 4 never uses this gate. */
  public wantsFormat4Promotion(): boolean {
    return Boolean(
      this.allowsFormat4Promotion() && this.format4PromotionRetry.canAttempt(),
    );
  }

  /** Whether a format 3 scope may start promoting now, before retry limits. */
  public allowsFormat4Promotion(): boolean {
    return Boolean(
      this.options.enableFormat4 && (this.options.format4Promotion?.() ?? true),
    );
  }

  /** Records after the last checkpoint, or 0 for a version 2 scope. */
  public pendingJournalRecords(): number {
    try {
      return this.journal?.isOpen() ? this.journal.pendingRecordCount : 0;
    } catch {
      return 0;
    }
  }

  /** Primary/index work alone may arm an idle checkpoint. */
  public pendingPrimaryRecordCount(): number {
    try {
      return this.journal?.isOpen()
        ? this.journal.pendingPrimaryRecordCount()
        : 0;
    } catch {
      return 0;
    }
  }

  /** The journal reached its size threshold (P1 §A). */
  public journalCheckpointDue(): boolean {
    try {
      return this.journal?.isOpen() === true && this.journal.needsCheckpoint();
    } catch {
      return false;
    }
  }

  /**
   * Whether the idle trigger should checkpoint: not while an in-progress
   * turn's active rows live only in the journal (phase 10). Its turn-end
   * record checkpoints them, through the append, without a sidecar rewrite.
   */
  public journalIdleCheckpointWanted(): boolean {
    try {
      return this.journal?.isOpen() === true && !this.journal.holdsActiveTurn();
    } catch {
      return false;
    }
  }

  private async openJournal(): Promise<ChatDeltaJournalWriter> {
    // A previous writer (poisoned, or retired by a demotion) must not stay
    // wired into the log the new writer recovers through.
    this.closeJournal();
    const settings = this.options.deltaJournal ?? {};
    const journal = await ChatDeltaJournalWriter.open(this.store, {
      log: this.storage.transcripts,
      ...(settings.onBoundary ? { onBoundary: settings.onBoundary } : {}),
      ...(settings.onDiagnostic ? { onDiagnostic: settings.onDiagnostic } : {}),
      ...(settings.checkpointJournalBytes !== undefined
        ? { checkpointJournalBytes: settings.checkpointJournalBytes }
        : {}),
      ...(settings.incrementalStreamMetadata
        ? { incrementalStreamMetadata: true }
        : {}),
    });
    this.journal = journal;
    this.storage.transcripts.setActiveProjection((chatId) =>
      this.journal === journal && journal.isOpen()
        ? journal.activeProjection(chatId)
        : undefined,
    );
    this.storage.setDeltaJournalClear(() => {
      try {
        return (
          this.journal === journal &&
          journal.isOpen() &&
          journal.pendingRecordCount === 0
        );
      } catch {
        return false;
      }
    });
    return journal;
  }

  private closeJournal(): void {
    this.journal = undefined;
    this.storage.transcripts.setActiveProjection(undefined);
    this.storage.setDeltaJournalClear(undefined);
  }

  /**
   * Detach the writer and forget the cached indexes, so the next operation
   * reloads from the manifest on disk after a compatibility demotion.
   */
  public releaseJournal(): void {
    this.closeJournal();
    this.indexes = undefined;
  }

  /** A failed removal leaves a journal version 2 never reads; retried on load. */
  private async removeStrayJournal(): Promise<void> {
    try {
      await removeStrayDeltaJournal(this.store);
    } catch {
      // The next load tries again.
    }
  }

  /**
   * The committed indexes: version 2 files, or for a delta-journal scope the
   * journal's metadata with each journaled chat's descriptor projected from
   * its files plus its journaled active rows.
   */
  private async loadIndexes(): Promise<ChatStorageIndexes> {
    if (this.options.deltaJournal && (await this.store.journalFile())) {
      const journal = this.journal?.isOpen()
        ? this.journal
        : await this.openJournal();
      // A crash between a record changing committed rows and its checkpoint:
      // finish the checkpoint before anything reads those rows.
      if (journal.hasCommittedRowChanges()) await journal.checkpoint();
      await this.removeStrayJournal();
      const indexes = shareLoadedInputLedgerText(
        await this.projectedIndexes(journal),
      );
      this.reportInvalidVisualOwnerLedger(indexes);
      return indexes;
    }
    if (this.journal) this.closeJournal();
    if (this.options.deltaJournal) await this.removeStrayJournal();
    const indexes = shareLoadedInputLedgerText(await this.storage.load());
    this.reportInvalidVisualOwnerLedger(indexes);
    return indexes;
  }

  private reportInvalidVisualOwnerLedger(indexes: ChatStorageIndexes): void {
    const hasLedger = Object.prototype.hasOwnProperty.call(
      indexes.recovery,
      'visualOwnersByChatId',
    );
    if (
      hasLedger &&
      !readVisualOwnerIndex(
        Reflect.get(indexes.recovery, 'visualOwnersByChatId'),
      )
    ) {
      try {
        this.options.onVisualOwnerLedgerInvalid?.({
          reason: 'malformed_visual_owner_ledger',
        });
      } catch {
        // A diagnostic sink must not make a valid storage load fail.
      }
    }
  }

  /**
   * Child/registry projections leave ledger identities unchanged. Fresh loads
   * and checkpoints share every ledger; ordinary transactions share only the
   * changed positions collected by their existing tab-conversion pass.
   */
  private async projectedIndexes(
    journal: ChatDeltaJournalWriter,
  ): Promise<ChatStorageIndexes> {
    let indexes = journal.indexes();
    for (const chatId of journal.journaledChatIds())
      indexes = withTranscriptDescriptor(
        indexes,
        chatId,
        await this.storage.transcripts.descriptor(chatId),
      );
    return indexes;
  }

  private async checkpointJournal(
    journal: ChatDeltaJournalWriter,
    currentWriteChats: ReadonlySet<string> = new Set(),
  ): Promise<ChatStorageIndexes> {
    const startedAt = performance.now();
    // Current transaction writes are counted by committed() after this call.
    // Other active projections have already been counted, but their physical
    // sidecars are only now materialized. Capture no transcript rows here.
    const identities = new Map<string, string | undefined>();
    for (const chatId of journal.journaledChatIds()) {
      if (currentWriteChats.has(chatId)) continue;
      try {
        identities.set(
          chatId,
          await this.artifactMaintenance.identityIfCached(chatId),
        );
      } catch {
        identities.set(chatId, undefined);
      }
    }
    const rebase = async (): Promise<void> => {
      for (const [chatId, identity] of Array.from(identities))
        try {
          await this.artifactMaintenance.checkpointedJournal(chatId, identity);
        } catch {
          try {
            await this.artifactMaintenance.invalidate(chatId);
          } catch {
            // Cleanup accounting cannot reject a durable checkpoint.
          }
        }
    };
    const onCheckpointed = this.options.deltaJournal?.onCheckpointed;
    if (!onCheckpointed) {
      await journal.checkpoint();
      await rebase();
      await this.reportFormat4Checkpoint(startedAt);
      return shareLoadedInputLedgerText(journal.indexes());
    }
    // Admitted records reach the journal first, so the rotation below covers
    // exactly the committed state the earlier modification time stamped.
    await journal.pendingDurability()?.catch(() => undefined);
    const journalFile = await this.store.journalFile();
    if (!journalFile)
      throw new Error('Checkpoint requires a journaled manifest');
    const path = join(this.store.directory, journalFile);
    const previousMtimeNs = await journalMtimeNs(path);
    await journal.checkpoint();
    await rebase();
    const mtimeNs = await journalMtimeNs(path);
    if (
      previousMtimeNs !== undefined &&
      mtimeNs !== undefined &&
      mtimeNs !== previousMtimeNs
    )
      onCheckpointed({ previousMtimeNs, mtimeNs });
    await this.reportFormat4Checkpoint(startedAt);
    return shareLoadedInputLedgerText(journal.indexes());
  }

  /**
   * Checkpoint a delta-journal scope. The repository holds the scope lease.
   * False when nothing was pending, or, for the repository's idle and size
   * timers (`trigger: 'timer'`), while an in-progress turn is journaled and
   * the size trigger is not due.
   */
  public async checkpointPendingJournal(trigger?: 'timer'): Promise<boolean> {
    return this.serial(async () => {
      this.indexes ??= await this.loadIndexes();
      const journal = this.journal;
      if (!journal || journal.pendingRecordCount === 0) return false;
      if (
        trigger === 'timer' &&
        journal.holdsActiveTurn() &&
        !journal.needsCheckpoint()
      )
        return false;
      this.indexes = await this.checkpointJournal(journal);
      return true;
    });
  }

  /**
   * Promote a settled version-2 scope to format 3, or re-enter the format-4
   * journal from selected checkpointed format 4. The
   * repository holds the scope lease and decides which scopes promote.
   */
  public async promoteToDeltaJournal(): Promise<boolean> {
    return this.serial(async () => {
      this.repromote = false;
      if (!this.options.deltaJournal) return false;
      if (
        (await this.store.format()) !== 'v2' &&
        (await this.store.format()) !== 'v4'
      )
        return false;
      try {
        const current = await this.storage.load();
        this.reportInvalidVisualOwnerLedger(current);
        await promoteToDeltaJournal(this.store);
      } catch (error) {
        this.promotionRetry.failed();
        throw error;
      }
      this.promotionRetry.reset();
      this.indexes = await this.loadIndexes();
      return true;
    });
  }

  /**
   * Opt-in format-3 to format-4 promotion, after repository recovery and ready.
   * A failed attempt returns false only after reopening the selected authority;
   * failure of that reopen/recovery propagates as a storage error.
   */
  public async promoteToFormat4(): Promise<boolean> {
    return this.serial(async () => {
      if (!this.options.enableFormat4 || !this.options.deltaJournal)
        throw new Error('Format 4 promotion is not enabled');
      if ((await this.store.format()) === 'v4') {
        await promoteToFormat4Journal(this.store, {
          log: this.storage.transcripts,
          ...(this.options.deltaJournal?.onBoundary
            ? { onBoundary: this.options.deltaJournal.onBoundary }
            : {}),
        });
        return false;
      }
      if (!this.wantsFormat4Promotion()) return false;
      if ((await this.store.format()) !== 'v3')
        throw new Error('Format 4 promotion requires a format-3 scope');
      const attempt = this.format4PromotionRetry.failureCount() + 1;
      try {
        await promoteToFormat4Journal(this.store, {
          ...(this.journal?.isOpen() ? { writer: this.journal } : {}),
          log: this.storage.transcripts,
          ...(this.options.deltaJournal?.onBoundary
            ? { onBoundary: this.options.deltaJournal.onBoundary }
            : {}),
        });
      } catch (error) {
        this.format4PromotionRetry.failed();
        const reportFailure = (): void => {
          this.reportFormat4({ event: 'promotion_failed', attempt, error });
          if (this.format4PromotionRetry.exhausted())
            this.reportFormat4({ event: 'retries_exhausted', attempt });
        };
        // The helper retires its old writer before publication. Never reuse
        // it, and never infer the selected manifest from the fault location.
        this.releaseJournal();
        try {
          this.indexes = await this.loadIndexes();
        } catch (recoveryError) {
          // Report what the manifest shows: a published format 4 promoted,
          // even when its reopen and this recovery both failed.
          let published = false;
          try {
            published = (await this.store.format()) === 'v4';
          } catch {
            // Unreadable: report the attempt's own failure.
          }
          if (published) this.reportFormat4({ event: 'promoted', attempt });
          else reportFailure();
          throw recoveryError;
        }
        if ((await this.store.format()) === 'v4') {
          this.format4PromotionRetry.reset();
          this.reportFormat4({ event: 'promoted', attempt });
          return false;
        }
        reportFailure();
        return false;
      }
      // Published: report it before the reload, which can still fail.
      this.reportFormat4({ event: 'promoted', attempt });
      this.releaseJournal();
      this.indexes = await this.loadIndexes();
      this.format4PromotionRetry.reset();
      return true;
    });
  }

  /** A format 4 scope's checkpoint duration, for the slow-checkpoint signal. */
  private async reportFormat4Checkpoint(startedAt: number): Promise<void> {
    if (!this.options.onFormat4Outcome) return;
    const durationMs = performance.now() - startedAt;
    try {
      if ((await this.store.format()) !== 'v4') return;
    } catch {
      return;
    }
    this.reportFormat4({ event: 'slow_checkpoint', durationMs });
  }

  private reportFormat4(outcome: ChatFormat4Outcome): void {
    try {
      this.options.onFormat4Outcome?.(outcome);
    } catch {
      // Diagnostics never change the storage outcome.
    }
  }

  private async assertChildStreamSupport(): Promise<void> {
    if (
      this.store.maxManifestVersion !== 4 ||
      (await this.store.format()) !== 'v4'
    )
      throw new ChildStreamUnsupportedFormatError();
  }

  private async assertChildParentInScope(chatId: string): Promise<void> {
    this.indexes ??= await this.loadIndexes();
    if (!allEntries(this.indexes).some((tab) => tab.id === chatId))
      throw new Error(
        'Delegation transcript target is outside the captured scope',
      );
  }

  private async withDelegationRegistryReadView<T>(
    chatId: string,
    operation: (reader: DelegationRegistryCheckpointReader) => Promise<T>,
  ): Promise<T> {
    await this.assertRegistrySupport();
    await this.assertRegistryParentInScope(chatId);
    const journal = this.journal;
    if (journal?.isOpen()) return operation(journal);
    this.registryArtifacts ??= new ChatTranscriptArtifacts(
      join(this.store.directory, 'transcripts'),
      true,
    );
    const view = await openDelegationRegistryReadView(
      {
        directory: this.store.directory,
        scopeId: this.store.descriptor().scopeId,
      },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
      this.registryArtifacts,
    );
    try {
      return await operation(view.registry);
    } finally {
      await view.dispose();
    }
  }

  private async writableDelegationRegistry(): Promise<ChatDeltaJournalWriter> {
    await this.assertRegistrySupport();
    if (!this.journal?.isOpen()) {
      if (!this.options.deltaJournal)
        throw registryFailure(
          'unsupported_format',
          'Delegation registry writes require the format-4 journal writer',
        );
      if (!(await this.store.journalFile()))
        await promoteToDeltaJournal(this.store);
      const journal = await this.openJournal();
      // Loading the projection is read-only. In particular, do not call
      // loadIndexes(): its recovery path may checkpoint committed child rows.
      this.indexes = shareLoadedInputLedgerText(
        await this.projectedIndexes(journal),
      );
    }
    const writer = this.journal;
    if (!writer || !writer.isOpen())
      throw registryFailure(
        'unsupported_format',
        'Delegation registry writer is unavailable',
      );
    return writer;
  }

  private async assertRegistryParentInScope(chatId: string): Promise<void> {
    let indexes: ChatStorageIndexes;
    if (this.journal?.isOpen())
      indexes = await this.projectedIndexes(this.journal);
    else indexes = this.indexes ?? (await this.storage.load());
    if (allEntries(indexes).some((entry) => entry.id === chatId)) return;
    const fence = this.storage.transcripts.childDeleteFence;
    if (fence.isDeleted(chatId))
      throw registryFailure('not_found', 'Parent chat not found');
    throw registryFailure('unauthorized', 'Chat is outside the captured scope');
  }

  private async assertRegistrySupport(): Promise<void> {
    try {
      await this.assertChildStreamSupport();
    } catch (error) {
      if (error instanceof ChildStreamUnsupportedFormatError)
        throw registryFailure(
          'unsupported_format',
          'Delegation registry requires enabled format-4 storage',
        );
      throw error;
    }
  }

  private validateSettlementInput(
    input: DelegationTranscriptSettleRequest,
  ): void {
    if (!isRecord(input))
      throw registryFailure('invalid_request', 'Invalid settlement request');
    const parsedTarget = TranscriptTargetSchema.safeParse(input.target);
    if (!parsedTarget.success || parsedTarget.data.kind !== 'delegation')
      throw registryFailure('invalid_request', 'Invalid delegation target');
    validateRegistryIdentity(parsedTarget.data);
    if (
      input.openRows !== undefined &&
      input.openRows !== 'reject' &&
      input.openRows !== 'finalize'
    )
      throw registryFailure('invalid_request', 'Invalid open row policy');
    if (
      typeof input.settlementKey !== 'string' ||
      input.settlementKey.length < 1 ||
      input.settlementKey.length > 256
    )
      throw registryFailure('invalid_request', 'Invalid settlement key');
    if (!validCounter(input.resultIndex, 1))
      throw registryFailure('invalid_request', 'Invalid result index');
    if (!Array.isArray(input.finalChanges))
      throw registryFailure(
        'invalid_request',
        'Final changes must be an array',
      );
    const ids = new Set<string>();
    for (const change of input.finalChanges) {
      if (!isRecord(change) || !isDelegationChildRow(change.row))
        throw registryFailure(
          'invalid_request',
          'Invalid final transcript row',
        );
      const row = change.row;
      if (
        row.id.length < 1 ||
        row.id.length > 256 ||
        !validCounter(row.itemRevision) ||
        ids.has(row.id)
      )
        throw registryFailure(
          'invalid_request',
          'Invalid or duplicate final row',
        );
      ids.add(row.id);
    }
    const outcome: unknown = input.outcome;
    if (!isRecord(outcome))
      throw registryFailure('invalid_request', 'Invalid settlement outcome');
    const statuses: readonly DelegateSettledStatus[] = [
      'completed',
      'failed',
      'cancelled',
      'deadline_exceeded',
      'interrupted',
    ];
    if (
      typeof outcome.status !== 'string' ||
      !statuses.some((status) => status === outcome.status) ||
      typeof outcome.finishedAt !== 'number' ||
      !validCounter(outcome.finishedAt)
    )
      throw registryFailure('invalid_request', 'Invalid settlement outcome');
    if (
      outcome.startedAt !== undefined &&
      (typeof outcome.startedAt !== 'number' ||
        !validCounter(outcome.startedAt))
    )
      throw registryFailure('invalid_request', 'Invalid settlement start time');
    if (
      outcome.stopReason !== undefined &&
      !isDelegationStopReason(outcome.stopReason)
    )
      throw registryFailure(
        'invalid_request',
        'Invalid settlement stop reason',
      );
    if (outcome.error !== undefined) {
      const codes: readonly AgentDelegationErrorCode[] = [
        'invalid_request',
        'capability_unavailable',
        'route_unavailable',
        'auth_required',
        'interaction_required',
        'policy_blocked',
        'capacity_exceeded',
        'parent_unavailable',
        'launch_uncertain',
        'runtime_error',
        'apply_failed',
        'terminated_by_parent',
      ];
      const error = outcome.error;
      if (!isRecord(error))
        throw registryFailure('invalid_request', 'Invalid settlement error');
      const code = error.code;
      if (
        typeof code !== 'string' ||
        !codes.some((candidate) => candidate === code) ||
        typeof error.message !== 'string' ||
        error.message.length > 4_096 ||
        typeof error.retryable !== 'boolean'
      )
        throw registryFailure('invalid_request', 'Invalid settlement error');
    }
    if (outcome.usage !== undefined) {
      if (!isRecord(outcome.usage))
        throw registryFailure('invalid_request', 'Invalid settlement usage');
      for (const [name, value] of Object.entries(outcome.usage))
        if (
          ![
            'inputTokens',
            'outputTokens',
            'cachedInputTokens',
            'cacheCreationInputTokens',
            'costUsd',
          ].includes(name) ||
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < 0 ||
          (name !== 'costUsd' && !Number.isSafeInteger(value))
        )
          throw registryFailure('invalid_request', 'Invalid settlement usage');
    }
    if (input.answer !== null) {
      if (
        !isRecord(input.answer) ||
        (input.answer.role !== 'final' && input.answer.role !== 'partial') ||
        ((!('text' in input.answer) || typeof input.answer.text !== 'string') &&
          (!('lost' in input.answer) ||
            !isRecord(input.answer.lost) ||
            !validCounter(input.answer.lost.length, 1) ||
            typeof input.answer.lost.sha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(input.answer.lost.sha256)))
      )
        throw registryFailure('invalid_request', 'Invalid settlement answer');
    }
    try {
      delegationTranscriptSettlementDigest(input);
    } catch {
      throw registryFailure(
        'invalid_request',
        'Invalid settlement identity data',
      );
    }
  }

  /** Read a canonical replay before repository load can recreate a journal. */
  public readDelegationSettlementReplay(
    input: DelegationTranscriptSettleRequest,
  ): Promise<
    | Awaited<
        ReturnType<DelegationRegistryOperations['settleDelegationResult']>
      >
    | undefined
  > {
    return this.serial(() => this.settlementReplay(input));
  }

  private async settlementReplay(
    input: DelegationTranscriptSettleRequest,
  ): Promise<
    | Awaited<
        ReturnType<DelegationRegistryOperations['settleDelegationResult']>
      >
    | undefined
  > {
    this.validateSettlementInput(input);
    const target = TranscriptTargetSchema.parse(input.target);
    if (target.kind !== 'delegation')
      throw registryFailure('invalid_request', 'Invalid delegation target');

    // A key is an immutable receipt. Compare its logical digest before looking
    // at a descriptor or row that a prior settlement is allowed to have changed.
    const existing = await this.withDelegationRegistryReadView(
      target.chatId,
      (reader) =>
        reader.resultBySettlementKey({
          chatId: target.chatId,
          delegationId: target.delegationId,
          settlementKey: input.settlementKey,
        }),
    );
    const digest = delegationTranscriptSettlementDigest(input);
    if (existing) {
      if (existing.settlementDigest !== digest)
        throw registryFailure(
          'conflict',
          'Settlement key was reused with different content',
        );
      return {
        settlement: {
          target,
          settlementKey: existing.settlementKey,
          streamRevision: existing.settlement.streamRevision,
          contentRevision: existing.settlement.contentRevision,
          finalItemCount: existing.settlement.finalItemCount,
          replayed: true,
        },
        result: existing,
      };
    }

    return undefined;
  }

  private async settleRegistryResult(
    input: DelegationTranscriptSettleRequest,
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['settleDelegationResult']>>
  > {
    const replay = await this.settlementReplay(input);
    if (replay !== undefined) return replay;
    const target = TranscriptTargetSchema.parse(input.target);
    if (target.kind !== 'delegation')
      throw registryFailure('invalid_request', 'Invalid delegation target');
    const digest = delegationTranscriptSettlementDigest(input);
    const writer = await this.writableDelegationRegistry();

    let current: ChildTranscriptReader;
    try {
      current = await this.childReader(target.chatId, target);
    } catch (error) {
      if (isUnknownChildStreamError(error))
        throw registryFailure(
          'not_found',
          'Delegation transcript stream not found',
        );
      throw error;
    }
    const descriptor = current.descriptor;
    const chosenCard = chooseSettlementCardDraft(descriptor.cardState, input);
    if (!chosenCard.ok)
      throw new DelegationRegistryOperationError(chosenCard.error);

    for (const change of input.finalChanges) {
      const next = change.row;
      const stored = await current.row(next.id);
      if (stored === undefined) {
        if (next.itemRevision !== 0)
          throw registryFailure(
            'stale_identity',
            'Final item revision is stale',
            {
              storedItemRevision: 0,
            },
          );
        if (!next.final)
          throw registryFailure(
            'invalid_request',
            'Settlement rows must be final',
          );
        continue;
      }
      const expanded = await this.expandChildStreamRow(target.chatId, stored);
      if (next.delegationSegment !== expanded.delegationSegment)
        throw registryFailure(
          'conflict',
          'Transcript item segment cannot change',
        );
      const sameRevisionAndContent =
        next.itemRevision === expanded.itemRevision &&
        delegationTranscriptRowDigest(next) ===
          delegationTranscriptRowDigest(expanded);
      if (expanded.final) {
        if (!sameRevisionAndContent)
          throw registryFailure(
            'conflict',
            'A final transcript item cannot change',
          );
        continue;
      }
      if (next.itemRevision !== expanded.itemRevision + 1) {
        if (next.itemRevision === expanded.itemRevision)
          throw registryFailure(
            'conflict',
            'A transcript revision has different content',
          );
        throw registryFailure(
          'stale_identity',
          'Final item revision is stale',
          {
            storedItemRevision: expanded.itemRevision,
          },
        );
      }
      if (!next.final)
        throw registryFailure(
          'invalid_request',
          'Settlement rows must be final',
        );
    }

    if (descriptor.status === 'settled')
      throw registryFailure(
        'conflict',
        'Delegation transcript is already settled',
      );

    const resultEntry: Omit<
      DelegationTranscriptResultEntry,
      'answer' | 'settlement'
    > = {
      version: 1,
      kind: 'result',
      resultIndex: input.resultIndex,
      runGeneration: target.runGeneration,
      settlementKey: input.settlementKey,
      settlementDigest: digest,
      outcome: input.outcome,
    };
    const mutation: DelegationRegistrySettleMutation = {
      target,
      mutationId: registryMutationId({
        target,
        settlementKey: input.settlementKey,
      }),
      mutationKey: input.settlementKey,
      finalRows: input.finalChanges.map((change) => change.row),
      descriptorSettle: { expectedStreamRevision: descriptor.streamRevision },
      resultEntry,
      answerBody: input.answer,
      openRows: input.openRows ?? 'reject',
      ...(input.cardDraft === undefined ? {} : { cardDraft: input.cardDraft }),
      ...(input.cardRevision === undefined
        ? {}
        : { cardRevision: input.cardRevision }),
    };
    const fence = this.storage.transcripts.childDeleteFence;
    const lease = fence.acquire(target.chatId);
    if (!lease) throw registryFailure('not_found', 'Parent chat not found');
    try {
      if (fence.isDeleted(target.chatId, lease.generation))
        throw registryFailure('not_found', 'Parent chat not found');
      const result = await writer.settleDelegationResult(mutation);
      this.indexes = await this.projectedIndexes(writer);
      return result;
    } finally {
      lease.release();
    }
  }

  public result(
    ...args: Parameters<DelegationRegistryOperations['result']>
  ): Promise<Awaited<ReturnType<DelegationRegistryOperations['result']>>> {
    const [input] = args;
    validateRegistryIdentity(input);
    if (!validCounter(input.resultIndex, 1))
      return Promise.reject(
        registryFailure('invalid_request', 'Invalid result index'),
      );
    return this.serial(() =>
      this.withDelegationRegistryReadView(input.chatId, (reader) =>
        reader.result(input),
      ),
    );
  }

  public receipt(
    ...args: Parameters<DelegationRegistryOperations['receipt']>
  ): ReturnType<DelegationRegistryOperations['receipt']> {
    const [input] = args;
    this.validateReceiptIdentity(input);
    return this.serial(() =>
      this.withDelegationRegistryReadView(input.chatId, (reader) =>
        reader.receipt(input),
      ),
    );
  }

  private validateReceiptIdentity(
    input: Parameters<DelegationRegistryOperations['receipt']>[0],
  ): void {
    if (
      !isRecord(input) ||
      typeof input.chatId !== 'string' ||
      !['command', 'stop', 'stop_outcome'].includes(input.receiptKind) ||
      typeof input.key !== 'string' ||
      !(input.receiptKind === 'stop_outcome'
        ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            input.key,
          )
        : /^[0-9a-f]{64}$/.test(input.key))
    )
      throw registryFailure('invalid_request', 'Invalid receipt identity');
    try {
      assertTranscriptIdentity(input.chatId);
    } catch {
      throw registryFailure('invalid_request', 'Invalid receipt chat identity');
    }
  }

  public resultBySettlementKey(
    ...args: Parameters<DelegationRegistryOperations['resultBySettlementKey']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['resultBySettlementKey']>>
  > {
    const [input] = args;
    validateRegistryIdentity(input);
    if (
      typeof input.settlementKey !== 'string' ||
      input.settlementKey.length < 1 ||
      input.settlementKey.length > 256
    )
      return Promise.reject(
        registryFailure('invalid_request', 'Invalid settlement key'),
      );
    return this.serial(() =>
      this.withDelegationRegistryReadView(input.chatId, (reader) =>
        reader.resultBySettlementKey(input),
      ),
    );
  }

  public resultByGeneration(
    ...args: Parameters<DelegationRegistryOperations['resultByGeneration']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['resultByGeneration']>>
  > {
    const [input] = args;
    validateRegistryIdentity(input);
    if (!validCounter(input.runGeneration, 1))
      return Promise.reject(
        registryFailure('invalid_request', 'Invalid run generation'),
      );
    return this.serial(() =>
      this.withDelegationRegistryReadView(input.chatId, (reader) =>
        reader.resultByGeneration(input),
      ),
    );
  }

  public generation(
    ...args: Parameters<DelegationRegistryOperations['generation']>
  ): Promise<Awaited<ReturnType<DelegationRegistryOperations['generation']>>> {
    const [input] = args;
    validateRegistryIdentity(input);
    if (!validCounter(input.runGeneration, 1))
      return Promise.reject(
        registryFailure('invalid_request', 'Invalid run generation'),
      );
    return this.serial(() =>
      this.withDelegationRegistryReadView(input.chatId, (reader) =>
        reader.generation(input),
      ),
    );
  }

  public resultsPage(
    ...args: Parameters<DelegationRegistryReader['resultsPage']>
  ): Promise<Awaited<ReturnType<DelegationRegistryReader['resultsPage']>>> {
    const [input, context] = args;
    validateRegistryIdentity(input);
    if (
      !validCounter(input.limit, 1) ||
      input.limit > 100 ||
      (input.cursor !== undefined &&
        (typeof input.cursor !== 'string' || input.cursor.length > 2048))
    )
      return Promise.reject(
        registryFailure('invalid_request', 'Invalid results page size'),
      );
    return this.serial(() =>
      this.withDelegationRegistryReadView(input.chatId, (reader) =>
        reader.resultsPage(input, context),
      ),
    );
  }

  public generationsPage(
    ...args: Parameters<DelegationRegistryReader['generationsPage']>
  ): Promise<Awaited<ReturnType<DelegationRegistryReader['generationsPage']>>> {
    const [input, context] = args;
    validateRegistryIdentity(input);
    if (
      !validCounter(input.limit, 1) ||
      input.limit > 100 ||
      (input.cursor !== undefined &&
        (typeof input.cursor !== 'string' || input.cursor.length > 2048))
    )
      return Promise.reject(
        registryFailure('invalid_request', 'Invalid generations page size'),
      );
    return this.serial(() =>
      this.withDelegationRegistryReadView(input.chatId, (reader) =>
        reader.generationsPage(input, context),
      ),
    );
  }

  public resultAnswerRange(
    ...args: Parameters<DelegationRegistryOperations['resultAnswerRange']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['resultAnswerRange']>>
  > {
    const [input, signal] = args;
    validateRegistryIdentity(input);
    if (
      !validCounter(input.resultIndex, 1) ||
      !validCounter(input.offset) ||
      !validCounter(input.limit, 1) ||
      input.limit > 65_536
    )
      return Promise.reject(
        registryFailure('invalid_request', 'Invalid answer byte range'),
      );
    return this.serial(() =>
      this.withDelegationRegistryReadView(input.chatId, (reader) =>
        reader.resultAnswerRange(input, signal),
      ),
    );
  }

  public itemAdmission(
    ...args: Parameters<DelegationRegistryOperations['itemAdmission']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['itemAdmission']>>
  > {
    const [input] = args;
    const target = TranscriptTargetSchema.safeParse(input.target);
    if (!target.success || target.data.kind !== 'delegation')
      return Promise.reject(
        registryFailure('invalid_request', 'Invalid delegation target'),
      );
    validateRegistryIdentity(target.data);
    if (
      typeof input.messageId !== 'string' ||
      input.messageId.length < 1 ||
      input.messageId.length > 256 ||
      !validCounter(input.itemRevision)
    )
      return Promise.reject(
        registryFailure('invalid_request', 'Invalid item admission request'),
      );
    return this.serial(() =>
      this.withDelegationRegistryReadView(target.data.chatId, (reader) =>
        reader.itemAdmission(input),
      ),
    );
  }

  public registerGeneration(
    ...args: Parameters<DelegationRegistryOperations['registerGeneration']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['registerGeneration']>>
  > {
    const [input] = args;
    validateRegistryIdentity(input);
    if (
      !validCounter(input.runGeneration, 1) ||
      !validCounter(input.createdAt) ||
      (input.store !== 'stream' && input.store !== 'legacy') ||
      (input.executionMode !== 'foreground' &&
        input.executionMode !== 'background') ||
      !isRecord(input.origin) ||
      !['launch', 'follow_up', 'resume', 'continuation'].includes(
        input.origin.kind,
      )
    )
      return Promise.reject(
        registryFailure('invalid_request', 'Invalid generation registration'),
      );
    for (const value of [
      input.origin.anchorMessageId,
      input.origin.authoredItemId,
    ])
      if (
        value !== undefined &&
        (typeof value !== 'string' || value.length < 1 || value.length > 256)
      )
        return Promise.reject(
          registryFailure('invalid_request', 'Invalid generation origin'),
        );
    return this.serial(async () => {
      const registration: DelegationTranscriptGenerationRegistration = input;
      await this.assertRegistryParentInScope(input.chatId);
      const writer = await this.writableDelegationRegistry();
      const fence = this.storage.transcripts.childDeleteFence;
      const lease = fence.acquire(input.chatId);
      if (!lease) throw registryFailure('not_found', 'Parent chat not found');
      try {
        if (fence.isDeleted(input.chatId, lease.generation))
          throw registryFailure('not_found', 'Parent chat not found');
        const result = await writer.registerGeneration({
          mutationId: registryMutationId(registration),
          registration,
        });
        this.indexes = await this.projectedIndexes(writer);
        return result;
      } finally {
        lease.release();
      }
    });
  }

  public appendDelegationReceipt(
    ...args: Parameters<DelegationRegistryOperations['appendDelegationReceipt']>
  ): ReturnType<DelegationRegistryOperations['appendDelegationReceipt']> {
    const checked = validateDelegationReceiptEntry(args[0]);
    if (!checked.ok) throw registryFailure('invalid_request', checked.reason);
    const entry = structuredClone(checked.entry);
    const identity = {
      chatId: entry.chatId,
      receiptKind: entry.receiptKind,
      key: entry.key,
    };
    this.validateReceiptIdentity(identity);
    return this.serial(async () => {
      // Check replay/conflict without promoting a checkpoint-only scope.
      const existing = await this.withDelegationRegistryReadView(
        entry.chatId,
        (reader) => reader.receipt(identity),
      );
      if (existing !== undefined) {
        if (
          canonicalDelegationJson(existing) !== canonicalDelegationJson(entry)
        )
          throw registryFailure(
            'conflict',
            'Receipt identity conflicts with stored entry',
          );
        return { entry: existing, replayed: true };
      }
      const writer = await this.writableDelegationRegistry();
      const fence = this.storage.transcripts.childDeleteFence;
      const lease = fence.acquire(entry.chatId);
      if (!lease) throw registryFailure('not_found', 'Parent chat not found');
      try {
        if (fence.isDeleted(entry.chatId, lease.generation))
          throw registryFailure('not_found', 'Parent chat not found');
        const result = await writer.appendDelegationReceipt({
          mutationId: registryMutationId(entry),
          entry,
        });
        this.indexes = await this.projectedIndexes(writer);
        return result;
      } finally {
        lease.release();
      }
    });
  }

  public updateCardState(
    ...args: Parameters<DelegationRegistryOperations['updateCardState']>
  ): ReturnType<DelegationRegistryOperations['updateCardState']> {
    const [input] = args;
    return this.serial(async () => {
      const parsed = TranscriptTargetSchema.safeParse(input.target);
      if (!parsed.success || parsed.data.kind !== 'delegation')
        throw registryFailure('invalid_request', 'Invalid delegation target');
      const target = parsed.data;
      await this.assertRegistrySupport();
      await this.assertRegistryParentInScope(target.chatId);
      const writer = await this.writableDelegationRegistry();
      let reader: ChildTranscriptReader;
      try {
        reader = await this.childReader(target.chatId, target);
      } catch (error) {
        if (isUnknownChildStreamError(error))
          throw registryFailure('not_found', 'Child transcript not found');
        throw error;
      }
      const descriptor = reader.descriptor;
      const prepared = prepareCardStateUpdate(
        descriptor.cardState,
        descriptor.status === 'settled',
        input.cardRevision,
        input.cardDraft,
      );
      if (!prepared.ok)
        throw new DelegationRegistryOperationError(prepared.error);
      if (!prepared.value.replayed) {
        if (!validCounter(descriptor.streamRevision + 1))
          throw registryFailure(
            'invalid_request',
            'The stream revision is exhausted',
          );
        await this.writeChildStreamCardState(
          writer,
          target,
          descriptor.streamRevision,
          prepared.value.cardState,
        );
      }
      return {
        target,
        status: descriptor.status,
        streamRevision:
          descriptor.streamRevision + (prepared.value.replayed ? 0 : 1),
        openedAt: descriptor.openedAt ?? null,
        latestRowTimestamp: descriptor.latestRowTimestamp,
        cardState: prepared.value.cardState,
      };
    });
  }

  public settleDelegationResult(
    ...args: Parameters<DelegationRegistryOperations['settleDelegationResult']>
  ): Promise<
    Awaited<ReturnType<DelegationRegistryOperations['settleDelegationResult']>>
  > {
    const [input] = args;
    return this.serial(() => this.settleRegistryResult(input));
  }

  /** Current descriptor projected from the journal, falling back to storage. */
  public async childStreamDescriptor(
    target: TranscriptTarget,
  ): Promise<TranscriptStreamDescriptor | undefined> {
    return this.serial(async () => {
      await this.assertChildStreamSupport();
      const validated = TranscriptTargetSchema.parse(target);
      if (validated.kind !== 'delegation')
        throw new Error('Only delegation streams have child descriptors');
      await this.assertChildParentInScope(validated.chatId);
      try {
        return (await this.childReader(validated.chatId, validated, true))
          .descriptor;
      } catch (error) {
        if (isUnknownChildStreamError(error)) return undefined;
        throw error;
      }
    });
  }

  /** Test-facing admission of an empty delegation stream. */
  public async registerTranscriptStream(
    target: TranscriptTarget,
  ): Promise<void> {
    return this.serial(async () => {
      const validated = TranscriptTargetSchema.parse(target);
      if (validated.kind !== 'delegation')
        throw new Error('Only delegation streams can be registered');
      if ((await this.store.format()) !== 'v4')
        throw new Error('Stream registration requires format 4');
      if (this.store.maxManifestVersion !== 4)
        throw new Error('Format-4 child admission is not enabled');
      // Recovery may checkpoint this parent's deletion and retire its fence,
      // which waits for leases; take ours only after indexes are loaded.
      this.indexes ??= await this.loadIndexes();
      this.indexedChat(validated.chatId);
      if (!this.journal) {
        if (!this.options.deltaJournal)
          throw new Error('Format-4 journal re-entry is not enabled');
        await promoteToDeltaJournal(this.store);
        this.indexes = await this.loadIndexes();
      }
      const fence = this.storage.transcripts.childDeleteFence;
      const lease = fence.acquire(validated.chatId);
      if (!lease) throw new Error('Child stream parent was deleted');
      try {
        const journal = this.journal;
        if (!journal) throw new Error('Format-4 journal is unavailable');
        const current = this.indexes ?? journal.indexes();
        const mutationId = randomUUID();
        const next: ChatStorageIndexes = {
          ...current,
          live: { ...current.live, revision: current.live.revision + 1 },
          archive: {
            ...current.archive,
            revision: current.archive.revision + 1,
          },
          recovery: {
            ...current.recovery,
            mutationIds: [...current.recovery.mutationIds, mutationId].slice(
              -4096,
            ),
          },
        };
        await journal.commit({
          expectedRevision: current.live.revision,
          next,
          writes: [],
          mutationIds: [mutationId],
          streamRegistrations: [
            {
              target: validated,
              streamKey: delegationStreamKey(validated),
              openedAt: Date.now(),
            },
          ],
          beforePublish: () => {
            if (fence.isDeleted(validated.chatId, lease.generation))
              throw new Error('Child stream parent was deleted');
          },
        });
        this.indexes = await this.projectedIndexes(journal);
      } finally {
        lease.release();
      }
    });
  }

  /** Test-facing format-4 child admission; legacy delegate logs are unchanged. */
  public async commitChildStream(
    target: TranscriptTarget,
    mutationId: string,
    rows: readonly DelegationChildRow[],
    settle?: {
      key: string;
      descriptorUpdate: TranscriptStreamDescriptorUpdate;
    },
    rawMutationKey?: string,
  ): Promise<{ applied: boolean; revision: number }> {
    const { durable, ...result } = await this.admitChildStream(
      target,
      mutationId,
      rows,
      settle,
      rawMutationKey,
    );
    await durable;
    return result;
  }

  /**
   * Format-4 child admission through group commit: the record joins the
   * journal's next batch, and `durable` settles once that batch is synced.
   * The caller must not acknowledge or publish it before then. The parent's
   * delete fence is checked as the record is queued (`beforeAdmit`): a
   * checkpoint, which retires the fence, first makes every queued record
   * durable, and this admission's fence lease is held until its record is.
   */
  public async admitChildStream(
    target: TranscriptTarget,
    mutationId: string,
    rows: readonly DelegationChildRow[],
    settle?: {
      key: string;
      descriptorUpdate: TranscriptStreamDescriptorUpdate;
    },
    rawMutationKey?: string,
  ): Promise<{ applied: boolean; revision: number; durable: Promise<void> }> {
    return this.serial(async () => {
      const validated = TranscriptTargetSchema.parse(target);
      if (validated.kind !== 'delegation')
        throw new Error('Only delegation streams accept child rows');
      if (
        this.store.maxManifestVersion !== 4 ||
        (await this.store.format()) !== 'v4'
      )
        throw new Error('Format-4 child admission is not enabled');
      // Load first: see registerTranscriptStream.
      this.indexes ??= await this.loadIndexes();
      this.indexedChat(validated.chatId);
      if (!this.journal) {
        if (!this.options.deltaJournal)
          throw new Error('Format-4 journal re-entry is not enabled');
        await promoteToDeltaJournal(this.store);
        this.indexes = await this.loadIndexes();
      }
      const fence = this.storage.transcripts.childDeleteFence;
      const lease = fence.acquire(validated.chatId);
      if (!lease) throw new Error('Child stream parent was deleted');
      let durable: Promise<void> | undefined;
      try {
        const journal = this.journal;
        if (!journal) throw new Error('Format-4 journal is unavailable');
        const current = this.indexes ?? journal.indexes();
        const next: ChatStorageIndexes = {
          ...current,
          live: { ...current.live, revision: current.live.revision + 1 },
          archive: {
            ...current.archive,
            revision: current.archive.revision + 1,
          },
          recovery: {
            ...current.recovery,
            mutationIds: boundedIds(
              current.recovery.mutationIds,
              [mutationId],
              4096,
            ),
          },
        };
        const admitted = await journal.admit({
          expectedRevision: current.live.revision,
          next,
          writes: [],
          mutationIds: [mutationId],
          childWrites: [
            {
              target: validated,
              rows: [...rows],
              ...(rawMutationKey !== undefined
                ? { mutationKey: rawMutationKey }
                : {}),
              ...(settle ? { settle } : {}),
            },
          ],
          beforeAdmit: () => {
            if (fence.isDeleted(validated.chatId, lease.generation))
              throw new Error('Child stream parent was deleted');
          },
        });
        durable = admitted.durable;
        this.indexes = await this.projectedIndexes(journal);
        return {
          applied: admitted.result.applied,
          revision: admitted.result.revision,
          durable: admitted.durable,
        };
      } finally {
        if (durable) void durable.then(lease.release, lease.release);
        else lease.release();
      }
    });
  }

  /** Point-read one child row with all stored block and body refs expanded. */
  public async childStreamMessage(
    target: TranscriptTarget,
    messageId: string,
    streamRevision: number,
  ): Promise<DelegationChildRow | undefined> {
    return this.serial(async () => {
      await this.assertChildStreamSupport();
      const validated = TranscriptTargetSchema.parse(target);
      if (validated.kind !== 'delegation')
        throw new Error('Only delegation streams have child messages');
      await this.assertChildParentInScope(validated.chatId);
      const reader = await this.childReader(validated.chatId, validated, true);
      const readRevision = this.normalizeChildReadRevision(
        reader.descriptor,
        streamRevision,
      );
      void readRevision;
      const row = await reader.row(messageId);
      return row === undefined
        ? undefined
        : this.expandChildStreamRow(validated.chatId, row);
    });
  }

  /** Phase-08 cursor page, pinned to the caller's observed stream revision. */
  public async childStreamPage(
    scope: { projectId: string; worktreeId: string },
    target: TranscriptTarget,
    streamRevision: number,
    cursor: string | undefined,
    limit: number,
  ): Promise<ChildStreamRowsPage> {
    return this.serial(async () => {
      await this.assertChildStreamSupport();
      const validated = TranscriptTargetSchema.parse(target);
      if (validated.kind !== 'delegation')
        throw new Error('Only delegation streams have child pages');
      await this.assertChildParentInScope(validated.chatId);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512)
        throw new Error('Invalid child transcript page size');
      const current = await this.childReader(validated.chatId, validated, true);
      const readRevision = this.normalizeChildReadRevision(
        current.descriptor,
        streamRevision,
      );
      const options: TranscriptPageReadOptions = {
        target: validated,
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: validated.chatId,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      };
      const page = await this.childTranscriptPage(
        validated.chatId,
        undefined,
        options,
        readRevision,
      );
      const rows: DelegationChildRow[] = [];
      for (const message of page.messages) {
        if (!isDelegationChildRow(message))
          throw new Error('Invalid child transcript row');
        rows.push(await this.expandChildStreamRow(validated.chatId, message));
      }
      return {
        rows,
        streamRevision: readRevision,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      };
    });
  }

  /** A pinned byte range from an inline or artifact-backed child field. */
  public async childStreamContentRange(
    target: TranscriptTarget,
    streamRevision: number,
    messageId: string,
    blockOrdinal: number,
    field: TranscriptContentField,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ChildStreamContentRange> {
    return this.serial(async () => {
      await this.assertChildStreamSupport();
      signal?.throwIfAborted();
      const validated = TranscriptTargetSchema.parse(target);
      if (validated.kind !== 'delegation')
        throw new Error('Only delegation streams have child content');
      await this.assertChildParentInScope(validated.chatId);
      const reader = await this.childReader(validated.chatId, validated, true);
      const readRevision = this.normalizeChildReadRevision(
        reader.descriptor,
        streamRevision,
      );
      void readRevision;
      const row = await reader.row(messageId);
      if (row === undefined) throw new Error('Transcript message not found');
      const result = await this.readChildContentRange(
        validated.chatId,
        row,
        { blockOrdinal, field, offset, limit },
        true,
        signal,
        'Transcript field not found for this row',
        'Invalid transcript block range',
      );
      return result;
    });
  }

  /** Internal descriptor-only card update used by the format-4 fixture. */
  public async updateChildStreamCardState(
    target: TranscriptTarget,
    expectedRevision: number,
    cardState: CardStateV1,
  ): Promise<void> {
    const parsedTarget = TranscriptTargetSchema.safeParse(target);
    if (!parsedTarget.success || parsedTarget.data.kind !== 'delegation')
      throw registryFailure('invalid_request', 'Invalid delegation target');
    const validatedTarget = parsedTarget.data;
    if (!validCounter(expectedRevision) || !validCounter(expectedRevision + 1))
      throw registryFailure('invalid_request', 'Invalid stream revision');
    const parsedCardState = CardStateV1Schema.safeParse(cardState);
    if (!parsedCardState.success)
      throw registryFailure('invalid_request', 'Invalid delegation card state');
    await this.assertRegistrySupport();
    await this.assertRegistryParentInScope(validatedTarget.chatId);
    return this.serial(async () => {
      const writer = await this.writableDelegationRegistry();
      let reader: ChildTranscriptReader;
      try {
        reader = await this.childReader(
          validatedTarget.chatId,
          validatedTarget,
        );
      } catch (error) {
        if (isUnknownChildStreamError(error))
          throw registryFailure('not_found', 'Child transcript not found');
        throw error;
      }
      if (reader.descriptor.streamRevision !== expectedRevision)
        throw registryFailure('stale_identity', 'Stream revision is stale');
      await this.writeChildStreamCardState(
        writer,
        validatedTarget,
        expectedRevision,
        parsedCardState.data,
      );
    });
  }

  private async writeChildStreamCardState(
    writer: ChatDeltaJournalWriter,
    validatedTarget: Extract<TranscriptTarget, { kind: 'delegation' }>,
    expectedRevision: number,
    cardState: NonNullable<TranscriptStreamDescriptor['cardState']>,
  ): Promise<void> {
    const fence = this.storage.transcripts.childDeleteFence;
    const lease = fence.acquire(validatedTarget.chatId);
    if (!lease) throw registryFailure('not_found', 'Parent chat not found');
    try {
      if (fence.isDeleted(validatedTarget.chatId, lease.generation))
        throw registryFailure('not_found', 'Parent chat not found');
      const current = await this.projectedIndexes(writer);
      const mutationId = randomUUID();
      const next: ChatStorageIndexes = {
        ...current,
        live: { ...current.live, revision: current.live.revision + 1 },
        archive: {
          ...current.archive,
          revision: current.archive.revision + 1,
        },
        recovery: {
          ...current.recovery,
          mutationIds: boundedIds(
            current.recovery.mutationIds,
            [mutationId],
            4096,
          ),
        },
      };
      const update: TranscriptStreamDescriptorUpdate = {
        version: 1,
        target: validatedTarget,
        expectedStreamRevision: expectedRevision,
        nextStreamRevision: expectedRevision + 1,
        cardState,
      };
      await writer.commit({
        expectedRevision: current.live.revision,
        next,
        writes: [],
        mutationIds: [mutationId],
        streamDescriptorUpdates: [{ target: validatedTarget, update }],
        beforePublish: () => {
          if (fence.isDeleted(validatedTarget.chatId, lease.generation))
            throw registryFailure('not_found', 'Parent chat not found');
        },
      });
      this.indexes = await this.projectedIndexes(writer);
    } finally {
      lease.release();
    }
  }

  private normalizeChildReadRevision(
    descriptor: TranscriptStreamDescriptor,
    requestedRevision: number,
  ): number {
    if (!validCounter(requestedRevision)) return staleStreamCursor();
    if (descriptor.status === 'open') {
      if (requestedRevision !== descriptor.streamRevision)
        return staleStreamCursor();
      return descriptor.streamRevision;
    }
    const contentRevision = descriptor.settleReceipt?.streamRevision;
    if (
      contentRevision === undefined ||
      contentRevision === null ||
      requestedRevision < contentRevision ||
      requestedRevision > descriptor.streamRevision
    )
      return staleStreamCursor();
    return contentRevision;
  }

  /** Shared block/field resolution for phase-08 content and child-stream reads. */
  private async readChildContentRange(
    chatId: string,
    row: DelegationChildRow,
    request: {
      blockOrdinal: number;
      field: TranscriptContentField;
      offset: number;
      limit: number;
    },
    includeInline: boolean,
    signal: AbortSignal | undefined,
    missingFieldMessage: string,
    missingBlockMessage: string,
  ): Promise<ChildStreamContentRange> {
    const [block] =
      row.blocksRef === undefined
        ? [row.blocks[request.blockOrdinal]]
        : await this.readBlocksForRow(
            chatId,
            row,
            request.blockOrdinal,
            1,
            signal,
          );
    if (block === undefined) throw new Error(missingBlockMessage);
    const reference = transcriptBodyReferences({ blocks: [block] }).find(
      (entry) => entry.field === request.field,
    )?.reference;
    if (reference !== undefined) {
      const range = await this.storage.transcripts.artifacts.readRange(
        chatId,
        reference,
        request.offset,
        request.limit,
        signal,
      );
      return {
        ...range,
        encoding: reference.encoding === 'utf-8' ? 'utf8' : 'utf16le',
      };
    }
    const text = includeInline
      ? inlineBodyField(block, request.field)
      : undefined;
    if (text === undefined) throw new Error(missingFieldMessage);
    return readInlineBodyRange(text, request.offset, request.limit);
  }

  private async expandChildStreamRow(
    chatId: string,
    row: DelegationChildRow,
  ): Promise<DelegationChildRow> {
    const blockCount = row.blocksRef?.blockCount ?? row.blocks.length;
    const blocks = await this.readBlocksForRow(chatId, row, 0, blockCount);
    const expandedBlocks: PersistedChatBlock[] = [];
    for (const block of blocks)
      expandedBlocks.push(
        await expandBodyFields(
          this.storage.transcripts.artifacts,
          chatId,
          block,
        ),
      );
    const { blocksRef: _blocksRef, ...metadata } = row;
    void _blocksRef;
    return { ...metadata, blocks: expandedBlocks };
  }

  /**
   * Enter the file-transaction state: format 3 demotes to 2, while format 4
   * checkpoints and retains its version. False when already checkpointed.
   */
  public async demoteFromDeltaJournal(): Promise<boolean> {
    return this.serial(async () => this.demoteLocked());
  }

  private async demoteLocked(): Promise<boolean> {
    this.repromote = false;
    this.promotionRetry.reset();
    if (!(await this.store.journalFile())) {
      if (this.journal) this.closeJournal();
      await this.removeStrayJournal();
      return false;
    }
    const settings = this.options.deltaJournal ?? {};
    const writer = this.journal?.isOpen() ? this.journal : undefined;
    // A writer that cannot be used must not answer the log's reads while the
    // demotion opens its own.
    if (!writer) this.closeJournal();
    try {
      const transition =
        (await this.store.format()) === 'v4'
          ? transitionFormat4ToCheckpointed
          : demoteFromDeltaJournal;
      await transition(this.store, {
        ...(writer ? { writer } : {}),
        log: this.storage.transcripts,
        ...(settings.onBoundary ? { onBoundary: settings.onBoundary } : {}),
        ...(settings.onDiagnostic
          ? { onDiagnostic: settings.onDiagnostic }
          : {}),
      });
    } catch (error) {
      // The manifest on disk decides: once version 2 is published, no write
      // may reach the journal again, whatever failed after it.
      this.releaseJournal();
      if (await this.store.journalFile().catch(() => 'unknown')) throw error;
    }
    this.closeJournal();
    this.indexes = shareLoadedInputLedgerText(await this.storage.load());
    this.reportInvalidVisualOwnerLedger(this.indexes);
    return true;
  }

  /**
   * A large import or replacement uses one version 2 transaction: demote
   * now, while this transaction holds the scope's write order, and promote
   * at the next idle point.
   */
  private async demoteForLargeMutation(): Promise<void> {
    if (!this.journal) return;
    await this.demoteLocked();
    this.repromote = true;
  }

  /** The repository must hold the scope lease around this bounded chunk. */
  public async maintainArtifacts(
    chatId: string,
    maxBytes = 64 * 1024,
  ): Promise<ArtifactMaintenanceProgress> {
    return this.serialDerived(async () =>
      this.artifactMaintenance.maintain(chatId, maxBytes, () =>
        Promise.resolve(this.indexedChat(chatId).transcript),
      ),
    );
  }

  public async pendingArtifactMaintenanceChats(
    hints?: readonly string[],
  ): Promise<string[]> {
    const indexes = this.indexes ?? (await this.load());
    // Journal records may reference any artifact; maintenance waits for the
    // checkpoint that writes them, after which the repository asks again.
    if (this.pendingJournalRecords() > 0) return [];
    // Provider commits mostly hint an actively streaming chat. Check its
    // cached runtime before traversing the whole live/archive catalog.
    const inactiveHints = hints
      ? Array.from(new Set(hints)).filter(
          (id) =>
            !ACTIVE.has(indexes.live.runtimeByChatId[id]?.status ?? 'idle'),
        )
      : undefined;
    if (inactiveHints?.length === 0) return [];
    const existing = new Set(allEntries(indexes).map((entry) => entry.id));
    const chats = inactiveHints
      ? inactiveHints.filter((id) => existing.has(id))
      : Array.from(existing);
    const pending: string[] = [];
    for (const chatId of chats) {
      if (ACTIVE.has(indexes.live.runtimeByChatId[chatId]?.status ?? 'idle'))
        continue;
      if (await this.artifactMaintenance.hasWork(chatId)) pending.push(chatId);
    }
    return pending;
  }

  public artifactMaintenanceEligible(chatId: string): boolean {
    if (!this.indexes) return false;
    if (!allEntries(this.indexes).some((entry) => entry.id === chatId))
      return false;
    return !ACTIVE.has(
      this.indexes.live.runtimeByChatId[chatId]?.status ?? 'idle',
    );
  }

  /** An absent index means recovery may still be pending, not chat deletion. */
  public artifactMaintenanceChatRetired(chatId: string): boolean {
    return (
      this.indexes !== undefined &&
      !allEntries(this.indexes).some((entry) => entry.id === chatId)
    );
  }

  public async abandonArtifactMaintenance(chatId: string): Promise<void> {
    await this.serialDerived(async () =>
      this.artifactMaintenance.abandon(chatId),
    );
  }

  public async disposeArtifactMaintenance(): Promise<void> {
    await this.artifactMaintenance.dispose();
  }

  public onArtifactMaintenanceCapacityAvailable(
    listener: () => void,
  ): () => void {
    return this.artifactMaintenance.onCapacityAvailable(listener);
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => {
      this.dropUndurableIndexes();
      return work();
    });
    this.tail = settledLease(next);
    try {
      return await next;
    } catch (error) {
      this.indexes = undefined;
      throw error;
    }
  }
  /** Derived cleanup shares ordering without invalidating canonical indexes. */
  private async serialDerived<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => {
      this.dropUndurableIndexes();
      return work();
    });
    this.tail = settledLease(next);
    return next;
  }

  /**
   * A group-committed batch that failed leaves the cached indexes ahead of
   * the journal, with no failing operation to drop them. Its writer is then
   * no longer open: forget the indexes, so the next operation reloads from
   * the files and the records that are durable.
   */
  private dropUndurableIndexes(): void {
    if (this.journal && !this.journal.isOpen()) this.indexes = undefined;
  }

  /**
   * Settles when every commit admitted for group commit ({@link admit}) is
   * durable; rejects when its batch failed. Undefined when nothing is
   * pending. Until then this backend's state is ahead of the journal: the
   * repository lets only the next admission run, and every other operation
   * under the scope lease waits.
   */
  public pendingJournalDurability(): Promise<void> | undefined {
    return this.journal?.pendingDurability();
  }
  public async load(): Promise<ChatStorageIndexes> {
    return this.serial(async () => {
      const indexes = (this.indexes ??= await this.loadIndexes());
      recordChatStorageIndexClone();
      return structuredClone(indexes);
    });
  }
  /**
   * Read one compatibility suffix. encodedBudget counts UTF-8 bytes of the
   * compact JSON.stringify(items), including the empty-array `[]` case.
   */
  public childStreamCompatibilityPage(
    request: ChildStreamCompatibilityPageRequest,
  ): Promise<ChildStreamCompatibilityPageReply> {
    return this.serial(async () => {
      if (!isRecord(request))
        return compatibilityPageFailure(
          'invalid_request',
          'Invalid child compatibility page request',
        );
      const parsedTarget = TranscriptTargetSchema.safeParse(request.target);
      if (!parsedTarget.success || parsedTarget.data.kind !== 'delegation')
        return compatibilityPageFailure(
          'invalid_request',
          'Invalid delegation transcript target',
        );
      const target = parsedTarget.data;
      if (
        !validCounter(request.streamRevision) ||
        (request.beforeSequence !== undefined &&
          !validCounter(request.beforeSequence, 1)) ||
        !validCounter(request.limit, 1) ||
        request.limit > DELEGATION_COMPATIBILITY_PAGE_LIMITS.maxRows ||
        !validCounter(request.encodedBudget) ||
        request.encodedBudget >
          DELEGATION_COMPATIBILITY_PAGE_LIMITS.encodedBytes
      )
        return compatibilityPageFailure(
          'invalid_request',
          'Invalid child compatibility page bounds',
        );

      try {
        await this.assertChildStreamSupport();
        await this.assertChildParentInScope(target.chatId);
        let staleRetries = 0;
        let requestedRevision = request.streamRevision;
        while (true) {
          const reader = await this.childReader(target.chatId, target, true);
          let readRevision: number;
          try {
            readRevision = this.normalizeChildReadRevision(
              reader.descriptor,
              requestedRevision,
            );
          } catch (error) {
            if (!isStaleStreamCursorError(error)) throw error;
            if (
              staleRetries >= DELEGATION_COMPATIBILITY_PAGE_LIMITS.staleRetries
            )
              return compatibilityPageFailure(
                'failed',
                'Child stream changed before compatibility page read',
              );
            staleRetries += 1;
            requestedRevision = reader.descriptor.streamRevision;
            continue;
          }
          const source = await reader.compatibility();
          const page = await readChildStreamCompatibilityPage(
            source.committedEntries,
            source.activeRows,
            source.pendingRows,
            source.readCommittedRow,
            (row) => compatibilityItem(target, row),
            {
              ...(request.beforeSequence === undefined
                ? {}
                : { beforeSequence: request.beforeSequence }),
              limit: request.limit,
              physicalByteBudget:
                DELEGATION_COMPATIBILITY_PAGE_LIMITS.physicalBytes,
              encodedBudget: request.encodedBudget,
            },
          );
          const latest = await this.childReader(target.chatId, target, true);
          if (
            latest.descriptor.streamRevision !==
            reader.descriptor.streamRevision
          ) {
            if (
              staleRetries < DELEGATION_COMPATIBILITY_PAGE_LIMITS.staleRetries
            ) {
              staleRetries += 1;
              requestedRevision = latest.descriptor.streamRevision;
              continue;
            }
            return compatibilityPageFailure(
              'failed',
              'Child stream changed during compatibility page read',
            );
          }
          return {
            ok: true,
            items: page.items,
            hasMore: page.hasMore,
            streamRevision: reader.descriptor.streamRevision,
            readRevision,
          };
        }
      } catch (error) {
        if (isUnknownChildStreamError(error))
          return compatibilityPageFailure(
            'not_found',
            'Child transcript stream not found',
          );
        return compatibilityPageFailure(
          'failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  }

  /** Read one stored parent row without applying the stream-card overlay. */
  public readStoredParentMessage(
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined> {
    return this.serial(async () => {
      if (
        typeof chatId !== 'string' ||
        chatId.length === 0 ||
        typeof messageId !== 'string' ||
        messageId.length === 0
      )
        return undefined;
      this.indexes ??= await this.loadIndexes();
      if (!allEntries(this.indexes).some((entry) => entry.id === chatId))
        return undefined;
      return this.storage.transcripts.readMessage(chatId, messageId);
    });
  }

  public async state(
    selection: ChatReadSelection = {},
  ): Promise<CanonicalChatState> {
    return this.serial(async () => {
      const state = await this.view(
        (this.indexes ??= await this.loadIndexes()),
        selection,
      );
      if (selection.rawStreamCards || !this.canOverlayStreamBackedCards())
        return state;
      const selected = new Set(selection.chatIds ?? []);
      for (const tab of [
        ...state.tabsFile.tabs,
        ...state.archivesFile.archived.map((entry) => entry.tab),
      ]) {
        if (!selected.has(tab.id)) continue;
        if (!this.hasStreamBackedCards(tab.id, tab.messages)) continue;
        tab.messages = await this.overlayStreamBackedCards(
          tab.id,
          tab.messages,
        );
      }
      return state;
    });
  }

  public async revision(): Promise<number> {
    return this.serial(
      async () => (this.indexes ??= await this.loadIndexes()).live.revision,
    );
  }

  /**
   * Make the files the complete state: reload a version 2 scope, checkpoint
   * a delta-journal one. Capture, copy, export, eviction and drain call it
   * under the scope lease before they read the files.
   */
  public async flush(): Promise<void> {
    await this.serial(async () => {
      this.indexes = await this.loadIndexes();
      if (this.journal && this.journal.pendingRecordCount > 0)
        this.indexes = await this.checkpointJournal(this.journal);
      else await this.reclaimStreamOrphans();
    });
  }

  /** Held serial, after recovery/checkpointing; never prune on failure. */
  private async reclaimStreamOrphans(): Promise<void> {
    if (this.journal || (await this.store.format()) !== 'v4') return;
    const indexes = (this.indexes ??= await this.loadIndexes());
    await pruneStreamCatalog(
      join(this.store.directory, 'transcripts'),
      new Set(allEntries(indexes).map((tab) => tab.id)),
    );
  }

  private async refuseStreamCopyDestinations(
    selected: readonly SelectedStreamCopy[],
    current: ChatStorageIndexes,
  ): Promise<void> {
    if (!selected.length) return;
    if ((await this.store.format()) !== 'v4')
      throw new StreamClosureCopyRefusalError(
        'unsupported_destination',
        'Child stream copy requires a format-4 destination',
      );
    const indexed = new Set(allEntries(current).map((tab) => tab.id));
    if (selected.some(({ parent }) => indexed.has(parent.targetChatId)))
      throw new StreamClosureCopyRefusalError(
        'indexed_destination',
        'Child stream copy destination is already indexed',
      );
  }

  private async refuseStreamCopyCollisions(
    selected: readonly SelectedStreamCopy[],
  ): Promise<void> {
    if (!selected.length) return;
    const catalog = await loadStreamCatalog(
      join(this.store.directory, 'transcripts'),
    );
    if (selected.some(({ parent }) => catalog.parents[parent.targetChatId]))
      throw new StreamClosureCopyRefusalError(
        'stream_collision',
        'Child stream copy destination has registered streams',
      );
  }

  /** Restore uses the ordinary durable transaction, with one streamed payload
   * per chat. The captured source remains intact until the caller commits the
   * surrounding container restore.
   */
  public async importScope(
    source: ChatStorageV2,
    metadata: Pick<CanonicalChatState, 'tabsFile' | 'archivesFile'>,
    options: ChatStorageImportOptions = {},
  ): Promise<V2Commit> {
    return this.serial(async () => {
      this.indexes ??= await this.loadIndexes();
      const mutationId = options.mutationId ?? randomUUID();
      let current = this.indexes;
      if (current.recovery.mutationIds.includes(mutationId))
        return {
          baseRevision: current.live.revision,
          revision: current.live.revision,
          applied: false,
          state: await this.view(current, {}),
          record: {
            v: 1,
            revision: current.live.revision,
            mutationId,
            source: 'import',
            occurredAt: new Date().toISOString(),
            mutations: [],
          },
        };
      const incomingIds = new Set(
        [
          ...metadata.tabsFile.tabs,
          ...metadata.archivesFile.archived.map((entry) => entry.tab),
        ].map((tab) => tab.id),
      );
      if (
        options.merge &&
        allEntries(current).some((tab) => incomingIds.has(tab.id))
      )
        throw new Error('Import would overwrite an existing chat');
      if (
        !options.merge &&
        (allEntries(current).some(
          (tab) =>
            (tab.transcript.messageCount ??
              tab.transcript.committedMessageCount) > 0 ||
            tab.pendingSystemInstructions?.length,
        ) ||
          current.live.pendingQuestions?.length ||
          Object.values(current.live.runtimeByChatId).some(
            (runtime) =>
              ACTIVE.has(runtime.status) || runtime.queuedMessageIds.length,
          ))
      )
        throw new Error('Restore destination contains existing chat data');
      const captured = await source.indexes();
      if (
        !options.settleFork &&
        Object.values(captured.live.runtimeByChatId).some(
          (runtime) =>
            ACTIVE.has(runtime.status) || runtime.queuedMessageIds.length,
        )
      )
        throw new Error('Restore source requires all active turns to settle');
      const sourceEntries = new Map(
        allEntries(captured).map((tab) => [tab.id, tab]),
      );
      const capturedEntries = new Map<string, ChatIndexEntry>();
      for (const id of options.merge
        ? Array.from(incomingIds)
        : Array.from(sourceEntries.keys())) {
        const entry = sourceEntries.get(options.sourceChatIds?.[id] ?? id);
        if (!entry) throw new Error('Restore metadata targets an unknown chat');
        capturedEntries.set(id, entry);
      }
      const sourceLog = new ChatTranscriptLog(
        join(source.directory, 'transcripts'),
        undefined,
        { readOnly: true },
      );
      const parents: StreamCopyParent[] = Array.from(
        capturedEntries,
        ([targetChatId, entry]) => ({
          sourceChatId: entry.id,
          targetChatId,
          rows: async function* (): AsyncGenerator<PersistedChatMessage> {
            const through = options.throughMessageIds?.[targetChatId];
            for await (const row of sourceLog.iterate(entry.id)) {
              yield row;
              if (row.id === through) return;
            }
            for (const row of await sourceLog.activeMessages(entry.id)) {
              yield row;
              if (row.id === through) return;
            }
            if (through !== undefined)
              throw new Error('Canonical branch message anchor was not found');
          },
        }),
      );
      const selected =
        (await source.format()) === 'v4'
          ? await selectStreamClosure(
              join(source.directory, 'transcripts'),
              sourceLog,
              parents,
            )
          : [];
      // Read-only refusals before demotion, then recovered orphan reclaim.
      await this.refuseStreamCopyDestinations(selected, current);
      if (this.journal) await this.demoteForLargeMutation();
      current = this.indexes ??= await this.loadIndexes();
      await this.reclaimStreamOrphans();
      await this.refuseStreamCopyCollisions(selected);
      const visualOwners = new VisualOwnerLedgerView(current.recovery);
      const previousEntries = new Map(
        allEntries(current).map((tab) => [tab.id, tab]),
      );
      const convert = (tab: PersistedChatTab): ChatIndexEntry => {
        const previous = previousEntries.get(tab.id);
        if (!previous || tab.inputDelivery !== previous.inputDelivery) {
          retainPreviousInputText(tab.inputDelivery, previous?.inputDelivery);
          shareInputLedgerText(tab.inputDelivery);
        }
        const entry = capturedEntries.get(tab.id);
        if (!entry) throw new Error('Restore metadata targets an unknown chat');
        const copy = { ...tab };
        Reflect.deleteProperty(copy, 'messages');
        Reflect.deleteProperty(copy, 'transcriptLoaded');
        Reflect.deleteProperty(copy, 'transcriptWindow');
        return { ...copy, transcript: entry.transcript };
      };
      const revision = current.live.revision + 1;
      const indexes: ChatStorageIndexes = {
        live: {
          ...metadata.tabsFile,
          version: 2,
          revision,
          tabs: metadata.tabsFile.tabs.map(convert),
          runtimeByChatId: Object.fromEntries(
            metadata.tabsFile.tabs
              .filter((tab) => tab.kind !== 'file')
              .map((tab): [string, ChatRuntimeState] => [
                tab.id,
                {
                  status: 'idle',
                  queuedMessageIds: [],
                  turn: serializeChatTurnState(initialChatTurnState()),
                },
              ]),
          ),
        },
        archive: {
          version: 2,
          revision,
          archived: metadata.archivesFile.archived.map((entry) => ({
            ...entry,
            tab: convert(entry.tab),
          })),
        },
        recovery: { ...current.recovery },
      };
      if (
        allEntries(indexes).length !== capturedEntries.size ||
        new Set(allEntries(indexes).map((tab) => tab.id)).size !==
          capturedEntries.size
      )
        throw new Error('Restore must preserve every captured chat');
      const importedEntries = allEntries(indexes);
      if (options.merge) {
        indexes.live.tabs.unshift(...current.live.tabs);
        indexes.archive.archived.unshift(...current.archive.archived);
        indexes.live.runtimeByChatId = {
          ...indexes.live.runtimeByChatId,
          ...current.live.runtimeByChatId,
        };
        indexes.live.pendingQuestions = [
          ...(current.live.pendingQuestions ?? []),
          ...(indexes.live.pendingQuestions ?? []),
        ];
      }
      indexes.recovery.mutationIds = boundedIds(
        current.recovery.mutationIds,
        [mutationId],
        4096,
      );
      const evidence = await source.copyRecoveryEvidenceTo(
        this.store,
        current.recovery.legacyEvidence ?? [],
      );
      if (evidence.length) indexes.recovery.legacyEvidence = evidence;
      const targetArtifacts = this.storage.transcripts.artifacts;
      const targetDelegations = this.storage.transcripts.delegations;
      // A format 2/3 reader knows no generalized field reference: it would
      // show the preview as the content and reclaim the body. Promotion is
      // one-way, so a format 4 destination stays one through the commit.
      const inlineFields = (await this.transcriptFieldMode()) === 'legacy';
      const created = new CreatedArtifacts();
      let checkSources: () => void;
      try {
        checkSources = await copyStreamClosure({
          sourceRoot: join(source.directory, 'transcripts'),
          destinationRoot: join(this.store.directory, 'transcripts'),
          source: sourceLog,
          destination: this.storage.transcripts,
          selected,
          created,
          copyPrimary: (parent, row) =>
            copyTranscriptClosure(
              sourceLog,
              parent.sourceChatId,
              parent.targetChatId,
              targetArtifacts,
              targetDelegations,
              row,
              created,
            ),
        });
      } catch (error) {
        await created.discard();
        throw error;
      }
      const writes: ChatTranscriptWrite[] = (
        options.merge ? [] : allEntries(current)
      )
        .filter((tab) => !capturedEntries.has(tab.id))
        .map((tab) => ({ chatId: tab.id, kind: 'delete' }));
      for (const tab of importedEntries) {
        const sourceId = capturedEntries.get(tab.id)?.id ?? tab.id;
        writes.push({
          chatId: tab.id,
          kind: 'replace',
          messages: (async function* (): AsyncGenerator<PersistedChatMessage> {
            const throughMessageId = options.throughMessageIds?.[tab.id];
            const copy = async (
              original: PersistedChatMessage,
            ): Promise<PersistedChatMessage> => {
              const message = inlineFields
                ? await inlineGeneralizedFields(
                    sourceLog.artifacts,
                    sourceId,
                    original,
                  )
                : original;
              await copyTranscriptClosure(
                sourceLog,
                sourceId,
                tab.id,
                targetArtifacts,
                targetDelegations,
                message,
                created,
              );
              return options.transformMessage?.(message, tab.id) ?? message;
            };
            for await (const message of sourceLog.iterate(sourceId)) {
              yield await copy(message);
              if (message.id === throughMessageId) return;
            }
            const active = await sourceLog.activeMessages(sourceId);
            for (const message of options.settleFork
              ? settlePersistedForkMessages(active, Date.now())
              : active) {
              yield await copy(message);
              if (message.id === throughMessageId) return;
            }
            if (throughMessageId !== undefined)
              throw new Error('Canonical branch message anchor was not found');
          })(),
        });
      }
      for (const tab of importedEntries) visualOwners.removeChat(tab.id);
      for (const write of writes)
        if (write.kind === 'delete') visualOwners.removeChat(write.chatId);
      installVisualOwnerLedger(indexes.recovery, visualOwners);
      this.indexes = await this.storage.commit(
        current.live.revision,
        indexes,
        writes,
        created,
        () => {
          options.beforePublish?.();
          checkSources();
        },
        options.preparePublish,
      );
      const state = await this.view(this.indexes, {
        chatIds: [indexes.live.activeTabId],
        pageOnly: true,
      });
      const mutations: ChatCoreMutation[] = [
        ...(options.merge ? [] : current.live.tabs).map(
          (tab): ChatCoreMutation => ({ type: 'tab.removed', tabId: tab.id }),
        ),
        ...(options.merge ? [] : current.archive.archived).map(
          (entry): ChatCoreMutation => ({
            type: 'archive.removed',
            archiveEntryId: entry.tab.id,
            chatId: entry.tab.id,
          }),
        ),
        ...state.tabsFile.tabs
          .filter((tab) => incomingIds.has(tab.id))
          .map(
            (tab): ChatCoreMutation => ({
              type: 'tab.created',
              tab: {
                ...tab,
                messages:
                  tab.id === indexes.live.activeTabId ? tab.messages : [],
                transcriptLoaded: tab.id === indexes.live.activeTabId,
              },
            }),
          ),
        ...state.archivesFile.archived
          .filter((entry) => incomingIds.has(entry.tab.id))
          .map(
            (entry): ChatCoreMutation => ({
              type: 'archive.upserted',
              entry: {
                ...entry,
                tab: { ...entry.tab, messages: [], transcriptLoaded: false },
              },
            }),
          ),
        { type: 'tab.active_changed', activeTabId: indexes.live.activeTabId },
      ];
      recordChatStorageMutations(mutations.length, this.store.directory);
      return {
        baseRevision: current.live.revision,
        revision,
        applied: true,
        state,
        record: {
          v: 1,
          revision,
          mutationId,
          source: 'import',
          occurredAt: new Date().toISOString(),
          mutations,
        },
      };
    });
  }

  private indexedChat(chatId: string): ChatIndexEntry {
    const indexes = this.indexes;
    if (!indexes)
      throw new Error('Artifact maintenance requires loaded canonical indexes');
    const entry =
      indexes.live.tabs.find((candidate) => candidate.id === chatId) ??
      indexes.archive.archived.find((candidate) => candidate.tab.id === chatId)
        ?.tab;
    if (!entry) throw new Error(`Unknown chat: ${chatId}`);
    return entry;
  }

  /** Whether an index lists the chat, so its delegate log may be written. */
  public async listsDelegationChat(chatId: string): Promise<boolean> {
    return this.serial(async () => {
      this.indexes ??= await this.loadIndexes();
      return allEntries(this.indexes).some((tab) => tab.id === chatId);
    });
  }

  /**
   * Writes delegated runs' new and changed child transcript items to the
   * chat's delegate logs, each run's file in parallel. Not serialized with
   * the scope: the log store orders writes per file and drops writes for a
   * chat whose logs were removed.
   */
  public async appendDelegationLog(
    chatId: string,
    runs: readonly DelegationRunItems[],
  ): Promise<void> {
    await Promise.all(
      runs.map(({ run, items }) =>
        this.storage.transcripts.delegations.append(chatId, run, items),
      ),
    );
  }

  /**
   * Appends delegated runs' items to the chat's delegate logs. Returns false,
   * writing nothing, when no index lists the chat (it was deleted): a late
   * append never recreates its directory.
   */
  public async appendDelegationItems(
    chatId: string,
    runs: readonly DelegationRunItems[],
  ): Promise<boolean> {
    if (!(await this.listsDelegationChat(chatId))) return false;
    await this.appendDelegationLog(chatId, runs);
    return true;
  }

  /** A delegated run's child transcript items from the chat's delegate log. */
  public async readDelegationItems(
    chatId: string,
    run: DelegationRun,
  ): Promise<AgentDelegationTranscriptItem[]> {
    return this.serial(async () => {
      await this.requireChat(chatId);
      // A stream is never an empty legacy log; its readers are target-aware.
      if (await this.streamChildReader(chatId, run))
        throw new Error(
          'Stream-backed delegation requires target-aware transcript reads',
        );
      return this.storage.transcripts.delegations.read(chatId, run);
    });
  }

  private async streamChildReader(
    chatId: string,
    run: DelegationRun,
  ): Promise<ChildTranscriptReader | undefined> {
    try {
      return await this.childReader(chatId, {
        kind: 'delegation',
        chatId,
        delegationId: run.delegationId,
        runGeneration: run.runGeneration,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unknown child stream')
        return undefined;
      throw error;
    }
  }

  /** Portable children of one stream card, oldest first, a page at a time. */
  private async *portableStreamChildren(
    chatId: string,
    run: DelegationRun,
  ): AsyncGenerator<PersistedChatMessage> {
    const reader = await this.streamChildReader(chatId, run);
    if (!reader) return;
    const limit = 100;
    // Pages count back from the newest row; pin the total, then read forward.
    const latest = await reader.page({ limit });
    const total = (latest.nextBefore ?? 0) + latest.rows.length;
    for (let start = 0; start < total; start += limit) {
      const end = Math.min(total, start + limit);
      for (const row of (await reader.page({ before: end, limit: end - start }))
        .rows)
        yield row.blocksRef
          ? await this.storage.transcripts.artifacts.expandBlocks(chatId, row)
          : row;
    }
  }

  /** Registered retained generations, never discovery from dangling cards. */
  public listChildSearchDocuments(
    chatId: string,
    signal?: AbortSignal,
  ): Promise<ChildSearchDocumentIdentity[]> {
    return this.serial(() => this.childSearchDocuments(chatId, signal));
  }

  private async childSearchDocuments(
    chatId: string,
    signal?: AbortSignal,
  ): Promise<ChildSearchDocumentIdentity[]> {
    signal?.throwIfAborted();
    if ((await this.store.format()) !== 'v4') return [];
    await this.requireChat(chatId);
    const journal = this.journal?.isOpen() ? this.journal : undefined;
    let targets: DelegationTarget[];
    if (journal) {
      targets = Array.from(journal.childTargets()).filter(
        (target): target is DelegationTarget =>
          target.kind === 'delegation' && target.chatId === chatId,
      );
    } else {
      const root = join(this.store.directory, 'transcripts');
      const catalog = await loadStreamCatalog(root);
      if (!catalog.parents[chatId]) return [];
      targets = (
        await loadStreamRegistry(root, chatId, { readOnly: true })
      ).entries.map((entry) => entry.target);
    }
    if (targets.length === 0) return [];
    const documents: ChildSearchDocumentIdentity[] = [];
    for (const target of targets) {
      signal?.throwIfAborted();
      const reader = await this.childReader(chatId, target, true);
      documents.push({
        target,
        descriptor: reader.descriptor,
        fingerprint: await this.childSearchFingerprint(reader),
      });
    }
    return documents;
  }

  private async childSearchFingerprint(
    reader: ChildTranscriptReader,
  ): Promise<string> {
    // There is no existing exact open-only revision accessor in the private
    // reader/writer API. compatibility() supplies actual open/pending identity
    // but also walks committed sequence metadata; root measures this cost.
    const state = await reader.compatibility();
    return createHash('sha256')
      .update(
        canonicalDelegationJson({
          extractor: CHILD_SEARCH_EXTRACTOR_VERSION,
          ownerGeneration: this.storage.transcripts.childDeleteFence.generation(
            reader.descriptor.target.chatId,
          ),
          descriptor: {
            target: reader.descriptor.target,
            openedAt: reader.descriptor.openedAt ?? null,
            streamRevision: reader.descriptor.streamRevision,
            status: reader.descriptor.status,
            committedSha256: reader.descriptor.committedSha256,
            committedRowCount: reader.descriptor.committedRowCount,
            committedByteLength: reader.descriptor.committedByteLength,
          },
          open: state.activeRows,
          pending: state.pendingRows,
          // D11: creation-card text is write-once. Card overlays are descriptor-owned.
          card: [
            reader.descriptor.target.delegationId,
            reader.descriptor.target.runGeneration,
            reader.descriptor.cardState,
          ],
        }),
      )
      .digest('hex');
  }

  private async childSearchCard(
    target: DelegationTarget,
    signal?: AbortSignal,
  ): Promise<ChildSearchCard | undefined> {
    const transcript = this.storage.transcripts;
    const find = async (
      row: PersistedChatMessage,
    ): Promise<ChildSearchCard | undefined> => {
      for await (const block of transcript.artifacts.iterateBlocks(
        target.chatId,
        row,
        signal,
      ))
        if (
          block.type === 'delegated_agent_call' &&
          block.transcriptStore === 'chat-stream-v2' &&
          block.delegationId === target.delegationId &&
          block.runGeneration === target.runGeneration
        )
          return block;
      return undefined;
    };
    const anchor = await transcript.readMessage(
      target.chatId,
      delegationBlockId(target.delegationId, target.runGeneration),
    );
    if (anchor) {
      const card = await find(anchor);
      if (card) return card;
    }
    // Older creation cards did not always use the stable anchor as row id.
    for await (const row of transcript.iterate(target.chatId)) {
      signal?.throwIfAborted();
      const card = await find(row);
      if (card) return card;
    }
    for (const row of await transcript.activeMessages(target.chatId)) {
      signal?.throwIfAborted();
      const card = await find(row);
      if (card) return card;
    }
    return undefined;
  }

  /** One bounded child per serial/normal repository read lease. */
  public readChildSearchDocument(
    identity: ChildSearchDocumentIdentity,
    signal?: AbortSignal,
  ): Promise<{ body: string; fingerprint: string }> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const reader = await this.childReader(
        identity.target.chatId,
        identity.target,
        true,
      );
      const fingerprint = await this.childSearchFingerprint(reader);
      if (fingerprint !== identity.fingerprint)
        throw new Error('Child search source was superseded');
      const storedCard = await this.childSearchCard(identity.target, signal);
      const card =
        storedCard &&
        overlayStreamBackedDelegationCard(
          storedCard,
          reader.descriptor.cardState,
        );
      const output = new ChildSearchText();
      await appendChildSearchCard(
        output,
        this.storage.transcripts.artifacts,
        identity.target.chatId,
        card,
        signal,
      );
      const latest = await reader.page({ limit: 1 });
      const total = (latest.nextBefore ?? 0) + latest.rows.length;
      for (let start = 0; start < total && output.remaining > 0; start += 100) {
        signal?.throwIfAborted();
        const end = Math.min(total, start + 100);
        const page = await reader.page({ before: end, limit: end - start });
        for (const row of page.rows) {
          if (output.remaining === 0) break;
          await appendChildSearchRow(
            output,
            this.storage.transcripts.artifacts,
            identity.target.chatId,
            row,
            signal,
          );
        }
      }
      signal?.throwIfAborted();
      return { body: output.text(), fingerprint };
    });
  }

  private async requireChat(chatId: string): Promise<ChatIndexEntry> {
    this.indexes ??= await this.loadIndexes();
    return this.indexedChat(chatId);
  }

  private childTarget(
    target: TranscriptTarget | undefined,
    chatId: string,
  ): DelegationTarget {
    const parsed = TranscriptTargetSchema.safeParse(target);
    if (
      !parsed.success ||
      parsed.data.kind !== 'delegation' ||
      parsed.data.chatId !== chatId
    )
      return unknownChildStream();
    return parsed.data;
  }

  /**
   * A registered stream is authoritative; legacy generations never register.
   * Only an unregistered target scans the parent for its exact card, so stream
   * reads never pay for it, and the card alone names any legacy source.
   */
  private async targetReader(
    chatId: string,
    target: TranscriptTarget | undefined,
  ): Promise<ChildTranscriptReader> {
    try {
      return await this.childReader(chatId, target);
    } catch (error) {
      if (!isUnknownChildStreamError(error)) throw error;
    }
    const child = this.childTarget(target, chatId);
    try {
      await this.requireChat(chatId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown chat:'))
        return unknownChildStream();
      throw error;
    }

    // A cold legacy lookup must not rebuild a derived parent index or recover
    // a sidecar. Scope recovery belongs to load, before this read boundary.
    // shortcut: each legacy read scans the whole parent chat; cache the card
    // and rows per parent revision if legacy delegation paging becomes hot.
    const parentLog = new ChatTranscriptLog(
      join(this.store.directory, 'transcripts'),
      undefined,
      { readOnly: true },
    );
    parentLog.setActiveProjection((id) =>
      this.journal?.isOpen() ? this.journal.activeProjection(id) : undefined,
    );
    const parentRows: PersistedChatMessage[] = [];
    for await (const row of parentLog.iterate(chatId)) parentRows.push(row);
    parentRows.push(...(await parentLog.activeMessages(chatId)));
    const cardRows: PersistedChatMessage[] = [];
    for (const row of parentRows)
      cardRows.push(
        row.blocksRef
          ? await parentLog.artifacts.expandBlocks(chatId, row)
          : row,
      );
    const card = delegationReadCard(child, cardRows);
    if (!card) return unknownChildStream();
    if (card.transcriptStore === 'chat-stream-v2')
      throw new MissingDelegationTranscriptSourceError('chat-stream-v2');
    const legacy = await readLegacyDelegation(
      child,
      card,
      parentRows,
      parentLog.delegations,
    );
    return {
      descriptor: legacy.descriptor,
      legacy: true,
      ...(legacy.runTruncated ? { runTruncated: true } : {}),
      page: ({
        before = legacy.rows.length,
        limit = TRANSCRIPT_PAGE_SIZE,
      }): ReturnType<ChildTranscriptReader['page']> => {
        const start = Math.max(0, before - limit);
        return Promise.resolve({
          rows: legacy.rows.slice(start, before),
          ...(start > 0 ? { nextBefore: start } : {}),
        });
      },
      row: (messageId) =>
        Promise.resolve(legacy.rows.find((row) => row.id === messageId)),
      compatibility: () =>
        Promise.resolve({
          committedEntries: [],
          activeRows: [...legacy.rows],
          pendingRows: [],
          readCommittedRow: () =>
            Promise.reject(new Error('Legacy read has no stream entries')),
        }),
    };
  }

  /** Registered stream-only reader: retained port and writer behavior is unchanged. */
  private async childReader(
    chatId: string,
    target: TranscriptTarget | undefined,
    checkpointRegistryView = false,
  ): Promise<ChildTranscriptReader> {
    if (this.store.maxManifestVersion !== 4) return unknownChildStream();
    const child = this.childTarget(target, chatId);
    try {
      await this.requireChat(chatId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown chat:'))
        return unknownChildStream();
      throw error;
    }

    const journal = this.journal?.isOpen() ? this.journal : undefined;
    if (journal) {
      if (!journal.hasChildStreams()) return unknownChildStream();
      const registered = Array.from(journal.childTargets()).some(
        (candidate) =>
          candidate.kind === 'delegation' &&
          delegationStreamKey(candidate) === delegationStreamKey(child),
      );
      if (!registered) return unknownChildStream();
      return {
        descriptor: await journal.childDescriptor(child),
        page: (options) => journal.childPage(child, options),
        row: (messageId) => journal.childRow(child, messageId),
        compatibility: () => journal.childCompatibilitySnapshot(child),
      };
    }

    const root = join(this.store.directory, 'transcripts');
    let catalog: Awaited<ReturnType<typeof loadStreamCatalog>>;
    try {
      catalog = await loadStreamCatalog(root);
    } catch (error) {
      if (error instanceof Error && error.message === 'Missing stream catalog')
        return unknownChildStream();
      throw error;
    }
    const streamKey = delegationStreamKey(child);
    const paths = delegationTranscriptPaths(root, child);
    const logVersion = await stat(paths.file(streamKey, 'jsonl'), {
      bigint: true,
    }).then(
      (log) => `${log.ino}:${log.size}:${log.mtimeNs}`,
      () => undefined,
    );
    const deep =
      logVersion === undefined ||
      this.verifiedChildLogs.get(streamKey) !== logVersion;
    let descriptor: TranscriptStreamDescriptor;
    try {
      descriptor = await validateStreamTarget(root, catalog, child, {
        readOnly: true,
        deep,
      });
    } catch (error) {
      if (error instanceof UnknownTranscriptStreamError)
        return unknownChildStream();
      throw error;
    }
    if (
      checkpointRegistryView &&
      (await this.store.journalFile()) === undefined
    ) {
      const view = await openDelegationRegistryReadView(
        {
          directory: this.store.directory,
          scopeId: this.store.descriptor().scopeId,
        },
        assertChatStorageIndexes,
        { maxManifestVersion: 4 },
      );
      try {
        const pinnedDescriptor = await view.descriptor(child);
        if (pinnedDescriptor === undefined) return unknownChildStream();
        descriptor = pinnedDescriptor;
      } finally {
        await view.dispose();
      }
    }
    if (deep && logVersion !== undefined)
      this.verifiedChildLogs.set(streamKey, logVersion);
    const store = new TranscriptStreamStore(
      paths,
      this.storage.transcripts.artifacts,
      undefined,
      { childMode: true, readOnly: true },
    );
    // Open rows stay in the stream's active sidecar, as the journal's child
    // overlay reads them.
    const openRows = async (): Promise<DelegationChildRow[]> => {
      const open: DelegationChildRow[] = [];
      for (const row of await store.activeMessages(streamKey)) {
        if (!isDelegationChildRow(row))
          throw new Error('Invalid open child row');
        open.push(row);
      }
      return open;
    };
    return {
      descriptor,
      page: async (options) =>
        readMergedChildStreamPage(
          descriptor.committedRowCount,
          await openRows(),
          (pageOptions) => store.readChildStreamPage(streamKey, pageOptions),
          options,
        ),
      row: async (messageId) =>
        (await openRows()).find((row) => row.id === messageId) ??
        store.childStreamRowById(streamKey, messageId),
      compatibility: async () => ({
        committedEntries: await store.childStreamSequenceEntries(streamKey),
        activeRows: await openRows(),
        pendingRows: [],
        readCommittedRow: (entry) =>
          store.readChildStreamSequenceEntry(streamKey, entry),
      }),
    };
  }

  private cursorContext(
    context: Partial<TranscriptReadContext>,
    chatId: string,
    kind: 'stream' | 'blocks',
  ): ChatTranscriptReadCursorContext {
    if (
      typeof context.projectId !== 'string' ||
      context.projectId.length === 0 ||
      typeof context.worktreeId !== 'string' ||
      context.worktreeId.length === 0 ||
      (context.chatId !== undefined && context.chatId !== chatId)
    )
      return kind === 'stream' ? staleStreamCursor() : staleBlocksCursor();
    return {
      projectId: context.projectId,
      worktreeId: context.worktreeId,
      chatId,
      ...(context.target !== undefined ? { target: context.target } : {}),
      ...(context.archivedContainerId !== undefined
        ? { archivedContainerId: context.archivedContainerId }
        : {}),
      ...(context.standaloneHistory !== undefined
        ? { standaloneHistory: context.standaloneHistory }
        : {}),
    };
  }

  private canOverlayStreamBackedCards(): boolean {
    if (this.store.maxManifestVersion !== 4) return false;
    const journal = this.journal?.isOpen() ? this.journal : undefined;
    return journal === undefined || journal.hasChildStreams();
  }

  private hasStreamBackedCards(
    chatId: string,
    messages: readonly PersistedChatMessage[],
  ): boolean {
    return messages.some((message) =>
      message.blocks.some((block) => streamBackedTarget(chatId, block)),
    );
  }

  /** A primary read projection; descriptor state never enters stored messages. */
  private async overlayStreamBackedCards(
    chatId: string,
    messages: readonly PersistedChatMessage[],
  ): Promise<PersistedChatMessage[]> {
    if (this.store.maxManifestVersion !== 4) return [...messages];
    const journal = this.journal?.isOpen() ? this.journal : undefined;
    if (journal && !journal.hasChildStreams()) return [...messages];
    const candidates = new Map<string, DelegationTarget>();
    for (const message of messages)
      for (const block of message.blocks) {
        const target = streamBackedTarget(chatId, block);
        if (target) candidates.set(delegationStreamKey(target), target);
      }
    if (candidates.size === 0) return [...messages];

    const states = new Map<
      string,
      Pick<TranscriptStreamDescriptor, 'cardState' | 'streamRevision'>
    >();
    if (journal) {
      // The writer's O(1) guard avoids walking its target registry in the
      // overwhelmingly common format-4 scope with no registered children.
      const registered = new Map<string, DelegationTarget>();
      for (const target of Array.from(journal.childTargets()))
        if (target.kind === 'delegation' && target.chatId === chatId)
          registered.set(delegationStreamKey(target), target);
      for (const [key, target] of Array.from(candidates.entries())) {
        if (!registered.has(key)) continue;
        const descriptor = await journal.childDescriptor(target);
        states.set(key, {
          cardState: descriptor.cardState,
          streamRevision: descriptor.streamRevision,
        });
      }
    } else {
      const root = join(this.store.directory, 'transcripts');
      try {
        await stat(streamCatalogPath(root));
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return [...messages];
        throw error;
      }
      const catalog = await loadStreamCatalog(root);
      if (catalog.parents[chatId] === undefined) return [...messages];
      for (const [key, target] of Array.from(candidates.entries())) {
        try {
          const descriptor = await validateStreamTarget(root, catalog, target, {
            readOnly: true,
            deep: false,
          });
          states.set(key, {
            cardState: descriptor.cardState,
            streamRevision: descriptor.streamRevision,
          });
        } catch (error) {
          if (error instanceof UnknownTranscriptStreamError) continue;
          throw error;
        }
      }
    }

    if (states.size === 0) return [...messages];
    return messages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block) => {
        const target = streamBackedTarget(chatId, block);
        if (!target || block.type !== 'delegated_agent_call') return block;
        const state = states.get(delegationStreamKey(target));
        return state === undefined
          ? block
          : overlayStreamBackedDelegationCard(
              block,
              state.cardState,
              state.streamRevision,
            );
      }),
    }));
  }

  private async childTranscriptPage(
    chatId: string,
    expectedRevision: number | undefined,
    options: TranscriptPageReadOptions,
    pinnedRevision?: number,
  ): Promise<TranscriptPage> {
    if (
      expectedRevision !== undefined ||
      options.transcriptRevision !== undefined
    )
      return staleStreamCursor();
    const reader =
      pinnedRevision === undefined
        ? await this.targetReader(chatId, options.target)
        : await this.childReader(chatId, options.target, true);
    const revision =
      pinnedRevision === undefined
        ? reader.descriptor.streamRevision
        : this.normalizeChildReadRevision(reader.descriptor, pinnedRevision);
    const context = this.cursorContext(options, chatId, 'stream');
    const limit = options.limit ?? TRANSCRIPT_PAGE_SIZE;
    const read: ChildPageRead = (pageOptions) => reader.page(pageOptions);
    let selection: ChildPageSelection;
    let totalMessages: number;
    if (options.cursor !== undefined) {
      if (options.before !== undefined) return staleStreamCursor();
      const cursor = decodeChatTranscriptReadCursor(
        options.cursor,
        'stream',
        context,
      );
      if (
        cursor.kind !== 'stream' ||
        cursor.revision !== revision ||
        cursor.position <= 0 ||
        cursor.position >= cursor.totalMessages ||
        cursor.position >= Number.MAX_SAFE_INTEGER
      )
        return staleStreamCursor();
      let boundary: Awaited<ReturnType<ChildTranscriptReader['page']>>;
      try {
        boundary = await reader.page({
          before: cursor.position + 1,
          limit: 1,
        });
      } catch {
        return staleStreamCursor();
      }
      if (boundary.rows[0]?.id !== cursor.messageId) return staleStreamCursor();
      try {
        selection = await selectChildPageRows(read, cursor.position, limit);
      } catch (error) {
        if (error instanceof ChildPageRowTooLargeError) throw error;
        return staleStreamCursor();
      }
      totalMessages = cursor.totalMessages;
    } else {
      if (options.before !== undefined) return staleStreamCursor();
      selection = await selectChildPageRows(read, undefined, limit);
      totalMessages = selection.end;
    }

    // The next older page ends at the oldest row this page kept, so rows left
    // out for size are read next, in order.
    const cursor =
      selection.start > 0
        ? encodeChatTranscriptReadCursor(context, {
            kind: 'stream',
            revision,
            position: selection.start,
            messageId: selection.rows[0]?.id ?? '',
            totalMessages,
          })
        : undefined;
    if (selection.start > 0 && cursor === undefined) return staleStreamCursor();
    return {
      messages: selection.rows,
      totalMessages,
      transcriptRevision: revision,
      ...(reader.runTruncated ? { runTruncated: true } : {}),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }

  public async page(
    chatId: string,
    before?: number,
    expectedRevision?: number,
    options: TranscriptPageReadOptions = {},
  ): Promise<TranscriptPage> {
    validateReadTarget(options.target, chatId);
    if (options.target?.kind === 'delegation')
      return this.serial(async () => {
        if (before !== undefined || options.before !== undefined)
          return staleStreamCursor();
        return this.childTranscriptPage(chatId, expectedRevision, options);
      });
    if (options.cursor !== undefined) return staleStreamCursor();
    return this.serial(async () => {
      const entry = await this.requireChat(chatId);
      const page = await this.storage.transcripts.page(chatId, before, options);
      if (
        expectedRevision !== undefined &&
        expectedRevision !== page.transcriptRevision
      )
        throw new Error("Couldn't load messages.");
      if (mainTranscriptPerformanceEnabled()) {
        const finishSerialization = beginMainTranscriptPerformanceStage(
          'payload_bytes_estimate',
          chatId,
          { loadedRows: page.messages.length },
        );
        finishSerialization({
          serializedBytes: estimateTranscriptWindowBytes(
            entry.transcript,
            page.messages.length,
          ),
        });
      }
      if (!this.canOverlayStreamBackedCards()) return page;
      let messages = page.messages;
      let latestHumanMessage = page.latestHumanMessage;
      const hasStreamBackedPageCards = this.hasStreamBackedCards(
        chatId,
        messages,
      );
      const hasStreamBackedLatestHumanCard =
        latestHumanMessage?.blocks.some(
          (block) => streamBackedTarget(chatId, block) !== undefined,
        ) ?? false;
      if (!hasStreamBackedPageCards && !hasStreamBackedLatestHumanCard)
        return page;
      const overlayInput = latestHumanMessage
        ? [...messages, latestHumanMessage]
        : messages;
      const projected = await this.overlayStreamBackedCards(
        chatId,
        overlayInput,
      );
      messages = projected.slice(0, messages.length);
      if (latestHumanMessage) latestHumanMessage = projected[messages.length];
      return {
        ...page,
        messages,
        ...(latestHumanMessage === undefined ? {} : { latestHumanMessage }),
      };
    });
  }

  private readBlocksForRow(
    chatId: string,
    row: PersistedChatMessage,
    firstBlockOrdinal: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PersistedChatBlock[]> | PersistedChatBlock[] {
    if (row.blocksRef === undefined) {
      const start = Math.min(firstBlockOrdinal, row.blocks.length);
      const count = Math.min(limit, row.blocks.length - start);
      return row.blocks.slice(start, start + count);
    }
    return this.storage.transcripts.artifacts.readBlocks(
      chatId,
      row,
      firstBlockOrdinal,
      limit,
      signal,
    );
  }

  public async blocks(
    request: ChatTranscriptBlocksRequest,
    signal?: AbortSignal,
  ): Promise<ChatTranscriptBlocksPage> {
    validateReadTarget(request.target, request.chatId);
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 512
      )
        throw new Error('Invalid transcript block range');
      const cursorContext = this.cursorContext(
        request,
        request.chatId,
        'blocks',
      );
      if (
        request.cursor !== undefined &&
        request.firstBlockOrdinal !== undefined
      )
        return staleBlocksCursor();
      // Validate cursor ownership before resolving a possibly different target.
      const incomingCursor =
        request.cursor === undefined
          ? undefined
          : decodeChatTranscriptReadCursor(
              request.cursor,
              'blocks',
              cursorContext,
              request.messageId,
            );
      const child = request.target?.kind === 'delegation';
      const reader = child
        ? await this.targetReader(request.chatId, request.target)
        : undefined;
      if (!child) await this.requireChat(request.chatId);
      let revision: number;
      if (reader) {
        revision = reader.descriptor.streamRevision;
      } else {
        revision = (await this.storage.transcripts.descriptor(request.chatId))
          .transcriptRevision;
      }
      let firstBlockOrdinal: number;
      if (incomingCursor !== undefined) {
        if (
          incomingCursor.kind !== 'blocks' ||
          incomingCursor.revision !== revision ||
          incomingCursor.position <= 0
        )
          return staleBlocksCursor();
        firstBlockOrdinal = incomingCursor.position;
      } else {
        firstBlockOrdinal = request.firstBlockOrdinal ?? 0;
        if (!Number.isSafeInteger(firstBlockOrdinal) || firstBlockOrdinal < 0)
          throw new Error('Invalid transcript block range');
      }
      const row = child
        ? await reader?.row(request.messageId)
        : await this.storage.transcripts.readMessage(
            request.chatId,
            request.messageId,
          );
      if (!row) throw new Error('Transcript message not found');
      const blockCount = row.blocksRef?.blockCount ?? row.blocks.length;
      if (request.cursor !== undefined && firstBlockOrdinal >= blockCount)
        return staleBlocksCursor();
      if (firstBlockOrdinal > blockCount) {
        if (request.cursor !== undefined) return staleBlocksCursor();
        throw new Error('Invalid transcript block range');
      }
      const blocks =
        row.blocksRef === undefined
          ? row.blocks.slice(
              firstBlockOrdinal,
              firstBlockOrdinal + request.limit,
            )
          : await this.readBlocksForRow(
              request.chatId,
              row,
              firstBlockOrdinal,
              request.limit,
              signal,
            );
      const nextBlockOrdinal = firstBlockOrdinal + blocks.length;
      const hasMore = nextBlockOrdinal < blockCount;
      const cursor = hasMore
        ? encodeChatTranscriptReadCursor(cursorContext, {
            kind: 'blocks',
            revision,
            position: nextBlockOrdinal,
            messageId: request.messageId,
          })
        : undefined;
      let displayedBlocks = blocks;
      if (
        !child &&
        this.canOverlayStreamBackedCards() &&
        blocks.some(
          (block) => streamBackedTarget(request.chatId, block) !== undefined,
        )
      ) {
        const projected = await this.overlayStreamBackedCards(request.chatId, [
          { ...row, blocks },
        ]);
        const projectedRow = projected[0];
        if (projectedRow) displayedBlocks = projectedRow.blocks;
      }
      return {
        messageId: request.messageId,
        firstBlockOrdinal,
        blocks: displayedBlocks,
        blockCount,
        ...(hasMore ? { nextBlockOrdinal, cursor } : {}),
        transcriptRevision: revision,
        ...(reader?.runTruncated ? { runTruncated: true } : {}),
      };
    });
  }

  public async content(
    request: ChatTranscriptContentRequest,
    signal?: AbortSignal,
  ): Promise<ChatToolOutputResponse> {
    validateReadTarget(request.target, request.chatId);
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (request.target?.kind !== 'delegation') {
        await this.requireChat(request.chatId);
        return this.storage.transcripts.readFieldRange(
          request.chatId,
          request.messageId,
          { blockOrdinal: request.blockOrdinal, field: request.field },
          request.offset,
          request.limit,
          signal,
          request.fieldSource,
        );
      }
      const reader = await this.targetReader(request.chatId, request.target);
      const row = await reader.row(request.messageId);
      if (!row)
        throw new Error('Transcript field has no stored body for this row');
      const range = await this.readChildContentRange(
        request.chatId,
        row,
        request,
        reader.legacy === true || request.fieldSource === 'logical',
        signal,
        'Transcript field has no stored body for this row',
        'Transcript field has no stored body for this row',
      );
      return {
        text: range.text,
        byteLength: range.byteLength,
        ...(reader.runTruncated ? { runTruncated: true } : {}),
        ...(range.nextOffset === undefined
          ? {}
          : { nextOffset: range.nextOffset }),
      };
    });
  }

  private async *primarySearchRows(
    chatId: string,
    messages: AsyncIterable<PersistedChatMessage>,
  ): AsyncGenerator<PersistedChatMessage> {
    for await (const message of messages) {
      if (
        !message.blocks.some(
          (block) => streamBackedTarget(chatId, block) !== undefined,
        )
      ) {
        yield message;
        continue;
      }
      // Search is a primary display reader. Portable consume and recovery
      // intentionally continue to see the raw stored row.
      yield* await this.overlayStreamBackedCards(chatId, [message]);
    }
  }

  public async search(
    request: ChatTranscriptSearchRequest,
    signal?: AbortSignal,
  ): Promise<ChatTranscriptSearchResult> {
    validateReadTarget(request.target, request.chatId);
    if (request.target?.kind !== 'delegation') {
      return this.consumeTranscript(request.chatId, false, (messages) =>
        searchTranscriptMessages(
          this.canOverlayStreamBackedCards()
            ? this.primarySearchRows(request.chatId, messages)
            : messages,
          request.query,
          signal,
        ),
      );
    }
    return this.serial(async () => {
      signal?.throwIfAborted();
      // Legacy generations never register; search reads them as pages do.
      const reader = await this.targetReader(request.chatId, request.target);
      const latestPage = await reader.page({ limit: 1 });
      const latestRow = latestPage.rows[0];
      if (!latestRow) return { matches: [], totalCount: 0 };
      const ownerBlockId = latestRow.parentBlockId;
      if (!ownerBlockId) return unknownChildStream();
      const childMessages = async function* (
        backend: ChatStateV2Backend,
      ): AsyncGenerator<PersistedChatMessage> {
        yield {
          id: ownerBlockId,
          role: 'assistant',
          timestamp: 0,
          blocks: [],
        };
        const totalMessages =
          (latestPage.nextBefore ?? 0) + latestPage.rows.length;
        let offset = 0;
        while (offset < totalMessages) {
          const limit = Math.min(TRANSCRIPT_PAGE_SIZE, totalMessages - offset);
          const before = offset + limit;
          const page = await reader.page({ before, limit });
          for (const row of page.rows) {
            signal?.throwIfAborted();
            const blocks: PersistedChatBlock[] = [];
            for await (const block of backend.storage.transcripts.artifacts.iterateBlocks(
              request.chatId,
              row,
              signal,
            ))
              blocks.push(block);
            const { blocksRef: _blocksRef, ...metadata } = row;
            void _blocksRef;
            yield { ...metadata, blocks };
          }
          if (page.rows.length !== limit)
            throw new Error('Child transcript page changed during search');
          offset += page.rows.length;
        }
      };
      const result = await searchTranscriptMessages(
        childMessages(this),
        request.query,
        signal,
      );
      return {
        ...result,
        matches: result.matches.map((match) => ({
          ...match,
          turnId: ownerBlockId,
        })),
      };
    });
  }

  /** Point lookup for one message id in a live or auto-archived chat: the
   * active tail plus the committed per-message locator. It never iterates or
   * pages the committed transcript. An unknown chat contains no messages.
   */
  public async hasMessage(chatId: string, messageId: string): Promise<boolean> {
    return this.serial(async () => {
      if (!this.indexes) {
        this.indexes = shareLoadedInputLedgerText(await this.storage.load());
        this.reportInvalidVisualOwnerLedger(this.indexes);
      }
      if (!allEntries(this.indexes).some((entry) => entry.id === chatId))
        return false;
      const transcript = this.storage.transcripts;
      const active = await transcript.activeMessages(chatId);
      if (active.some((message) => message.id === messageId)) return true;
      return transcript.hasCommittedMessage(chatId, messageId);
    });
  }

  public async toolOutput(
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedToolOutputReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
    request?: ChatToolOutputRequest,
  ): Promise<{ text: string; nextOffset?: number; byteLength: number }> {
    validateReadTarget(request?.target, chatId);
    if (request !== undefined && request.chatId !== chatId)
      throw new Error('Transcript target does not match chat');
    if (request?.target?.kind === 'delegation')
      return this.serial(async () => {
        if (request.chatId !== chatId) return unknownChildStream();
        signal?.throwIfAborted();
        const reader = await this.childReader(chatId, request.target);
        const row = await reader.row(messageId);
        let ownsReference = row?.id === messageId;
        if (row && ownsReference) {
          ownsReference = false;
          for await (const block of this.storage.transcripts.artifacts.iterateBlocks(
            chatId,
            row,
            signal,
          )) {
            signal?.throwIfAborted();
            if (
              block.type === 'tool_result' &&
              block.toolUseId === toolUseId &&
              block.fullOutputRef !== undefined &&
              sameToolOutputReference(block.fullOutputRef, reference)
            ) {
              ownsReference = true;
              break;
            }
          }
        }
        if (!ownsReference)
          throw new Error(
            'Transcript block does not own tool output reference',
          );
        return this.storage.transcripts.artifacts.readRange(
          chatId,
          reference,
          offset,
          length,
          signal,
        );
      });
    return this.serial(async () => {
      await this.requireChat(chatId);
      signal?.throwIfAborted();
      const ownsReference = await this.verifyArtifactOwnership(
        chatId,
        `tool:${JSON.stringify([
          messageId,
          toolUseId,
          reference.version,
          reference.artifactId,
          reference.byteLength,
          reference.sha256,
          reference.encoding,
          reference.mediaType,
        ])}`,
        () =>
          this.storage.transcripts.ownsToolOutputReference(
            chatId,
            messageId,
            toolUseId,
            reference,
          ),
        signal,
      );
      if (!ownsReference)
        throw new Error('Transcript block does not own tool output reference');
      return this.storage.transcripts.artifacts.readRange(
        chatId,
        reference,
        offset,
        length,
        signal,
      );
    });
  }

  public async visual(
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedVisualReference,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{
    bytes: Uint8Array;
    offset: number;
    length: number;
    byteLength: number;
    sha256: string;
  }> {
    return this.serial(async () => {
      await this.requireChat(chatId);
      signal?.throwIfAborted();
      const ownsReference = await this.verifyArtifactOwnership(
        chatId,
        `visual:${JSON.stringify([
          messageId,
          toolUseId,
          reference.version,
          reference.visualId,
          reference.artifactId,
          reference.byteLength,
          reference.sha256,
          reference.mediaType,
          reference.title,
          reference.maxHeight,
          reference.heights,
        ])}`,
        () =>
          this.storage.transcripts.ownsVisualReference(
            chatId,
            messageId,
            toolUseId,
            reference,
          ),
        signal,
      );
      if (!ownsReference) throw new ChatVisualReadError('not_found');
      try {
        return await this.storage.transcripts.artifacts.readVisualRange(
          chatId,
          reference,
          offset,
          limit,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isErrnoException(error) && error.code === 'ENOENT')
          throw new ChatVisualReadError('not_found');
        if (
          error instanceof Error &&
          VISUAL_INTEGRITY_FAILURES.has(error.message)
        )
          throw new ChatVisualReadError('invalid_state');
        // Other I/O failures are not integrity failures; the adapter reports
        // them as `internal` with a fixed message.
        throw error;
      }
    });
  }

  private async verifyArtifactOwnership(
    chatId: string,
    ownershipKey: string,
    verify: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { transcriptRevision } =
      await this.storage.transcripts.descriptor(chatId);
    let ownership = this.verifiedArtifactOwnership.get(chatId);
    if (!ownership || ownership.transcriptRevision !== transcriptRevision) {
      if (
        !ownership &&
        this.verifiedArtifactOwnership.size >=
          TOOL_OUTPUT_OWNERSHIP_CHAT_CACHE_LIMIT
      ) {
        const oldest = this.verifiedArtifactOwnership.keys().next();
        if (!oldest.done) this.verifiedArtifactOwnership.delete(oldest.value);
      }
      ownership = { transcriptRevision, keys: new Set() };
      this.verifiedArtifactOwnership.set(chatId, ownership);
    }
    let ownsReference = ownership.keys.has(ownershipKey);
    if (!ownsReference) {
      ownsReference = await verify();
      signal?.throwIfAborted();
      if (ownsReference) {
        if (ownership.keys.size >= TOOL_OUTPUT_OWNERSHIP_KEY_CACHE_LIMIT) {
          const oldest = ownership.keys.values().next();
          if (!oldest.done) ownership.keys.delete(oldest.value);
        }
        ownership.keys.add(ownershipKey);
      }
    }
    return ownsReference;
  }

  /** Capture preview file handles while the repository owns its short scope
   * lease. No callback or transcript projection runs in this serializer.
   */
  public async captureTranscriptPreview(
    chatId: string,
  ): Promise<CapturedTranscriptPreview> {
    return this.serial(async () => {
      const entry = await this.requireChat(chatId);
      if (!entry.transcript)
        throw new Error(`Chat ${chatId} has no transcript descriptor`);
      return this.storage.transcripts.capturePreview(chatId, entry.transcript);
    });
  }

  /**
   * The rows a chat's in-progress turn changed since transcript revision
   * `since`, with the chat's descriptor at the same point, for chat search's
   * incremental projection. Undefined for a version 2 scope, or when only a
   * full read of the active rows can answer.
   */
  public async activeTurnDelta(
    chatId: string,
    since: number,
  ): Promise<
    { descriptor: TranscriptDescriptor; delta: ActiveTurnDelta } | undefined
  > {
    return this.serial(async () => {
      await this.requireChat(chatId);
      const journal = this.journal;
      if (!journal?.isOpen()) return undefined;
      const delta = journal.activeTurnDelta(chatId, since);
      if (!delta) return undefined;
      const descriptor = await this.storage.transcripts.descriptor(chatId);
      if (descriptor.transcriptRevision !== delta.transcriptRevision)
        return undefined;
      return { descriptor, delta };
    });
  }

  /** The consumer completes while the scope lease excludes reset/delete.
   * Streaming exports/reconstruction opt into full outputs one message at a
   * time; preview-only search never reads artifact bodies.
   */
  public async consumeTranscript<T>(
    chatId: string,
    fullOutputs: boolean,
    consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
    options: TranscriptConsumeOptions = {},
  ): Promise<T> {
    return this.serial(async () => {
      if (options.skipNonChatTabs) {
        this.indexes ??= await this.loadIndexes();
        if (
          !allEntries(this.indexes).some(
            (entry) => entry.id === chatId && entry.kind !== 'file',
          )
        )
          return consume(
            (async function* (): AsyncGenerator<PersistedChatMessage> {})(),
          );
      } else await this.requireChat(chatId);
      const transcript = this.storage.transcripts;
      const overlay = (
        messages: readonly PersistedChatMessage[],
      ): Promise<PersistedChatMessage[]> =>
        this.overlayStreamBackedCards(chatId, messages);
      const streamChildren = (
        run: DelegationRun,
      ): AsyncGenerator<PersistedChatMessage> =>
        this.portableStreamChildren(chatId, run);
      const active = await transcript.activeMessages(chatId);
      const stored = async function* (): AsyncGenerator<PersistedChatMessage> {
        if (!options.excludeCommittedActiveEchoes) {
          yield* transcript.iterate(chatId);
          yield* active;
          return;
        }
        const uncommitted = new Set(active.map((message) => message.id));
        for await (const message of transcript.iterate(chatId)) {
          uncommitted.delete(message.id);
          yield message;
        }
        for (const message of active)
          if (uncommitted.has(message.id)) yield message;
      };
      const rows = async function* (): AsyncGenerator<PersistedChatMessage> {
        if (!options.inlineDelegationChildren) {
          yield* stored();
          return;
        }
        // Read under this lease directly: the chat's log reads would wait
        // for it through the repository.
        const inlined = new Set<string>();
        for await (const storedMessage of stored()) {
          const message = storedMessage.blocksRef
            ? await transcript.artifacts.expandBlocks(chatId, storedMessage)
            : storedMessage;
          if (message.parentBlockId && inlined.has(message.parentBlockId))
            continue;
          const cards = message.blocks.filter(
            (block) =>
              block.type === 'delegated_agent_call' &&
              (block.transcriptStore === DELEGATION_TRANSCRIPT_CHAT_LOG ||
                block.transcriptStore === 'chat-stream-v2'),
          );
          if (cards.length === 0) {
            yield message;
            continue;
          }
          // A stream card shows its descriptor state before losing its marker.
          const [shown = message] = await overlay([message]);
          yield {
            ...shown,
            blocks: shown.blocks.map((block) => {
              if (
                block.type !== 'delegated_agent_call' ||
                block.transcriptStore === undefined
              )
                return block;
              const { transcriptStore: _store, ...card } = block;
              void _store;
              return card;
            }),
          };
          for (const card of cards) {
            if (card.type !== 'delegated_agent_call') continue;
            inlined.add(card.agentBlockId);
            if (card.transcriptStore === 'chat-stream-v2')
              yield* streamChildren(card);
            else
              yield* delegationChildMessages(
                card.agentBlockId,
                await transcript.delegations.read(chatId, card),
              );
          }
        }
      };
      return consume(
        (async function* (): AsyncGenerator<PersistedChatMessage> {
          for await (const storedMessage of rows()) {
            if (!fullOutputs) {
              yield storedMessage;
              continue;
            }
            const message = storedMessage.blocksRef
              ? await transcript.artifacts.expandBlocks(chatId, storedMessage)
              : storedMessage;
            if (transcriptBodyReferences(message).length === 0) {
              yield message;
              continue;
            }
            const blocks: PersistedChatBlock[] = [];
            for (const block of message.blocks)
              blocks.push(
                await expandBodyFields(transcript.artifacts, chatId, block),
              );
            yield { ...message, blocks };
          }
        })(),
      );
    });
  }
  private async view(
    indexes: ChatStorageIndexes,
    selection: ChatReadSelection,
  ): Promise<CanonicalChatState> {
    recordChatStorageIndexClone();
    const state = metadataState(cloneSharingTurnHistory(indexes), true);
    const selected = new Set(selection.chatIds ?? []);
    for (const tab of [
      ...state.tabsFile.tabs,
      ...state.archivesFile.archived.map((entry) => entry.tab),
    ]) {
      if (!selected.has(tab.id)) continue;
      let messages: PersistedChatMessage[];
      if (selection.fullTranscript) {
        const active = await this.storage.transcripts.activeMessages(tab.id);
        messages = [];
        for await (const message of this.storage.transcripts.iterate(tab.id))
          messages.push(message);
        const ids = new Set(messages.map((message) => message.id));
        messages.push(...active.filter((message) => !ids.has(message.id)));
      } else {
        const { page, activeMessages: active } =
          await this.storage.transcripts.pageWithActiveMessages(
            tab.id,
            undefined,
            // Transactions also need the current turn's frame (prompt, timers,
            // open cards and tools) when it is older than the newest page.
            selection.pageOnly ? { view: 'turns' } : { reducerFrame: true },
          );
        if (selection.pageOnly) {
          const { messages: _messages, ...window } = page;
          void _messages;
          tab.transcriptWindow = window;
        }
        const activeIds = new Set(active.map((message) => message.id));
        messages = selection.pageOnly
          ? page.messages
          : [
              ...page.messages.filter((message) => !activeIds.has(message.id)),
              ...active,
            ];
        if (
          page.latestHumanMessage &&
          !messages.some(
            (message) => message.id === page.latestHumanMessage?.id,
          )
        )
          messages.unshift(page.latestHumanMessage);
        if (!selection.pageOnly && selection.messageAnchor) {
          const { messageId, fallbackMessageId, previousRunMessageId } =
            selection.messageAnchor;
          if (!messages.some((message) => message.id === messageId)) {
            const anchor = await this.storage.transcripts.readMessage(
              tab.id,
              messageId,
            );
            if (anchor) messages.unshift(anchor);
            else {
              if (
                fallbackMessageId !== undefined &&
                !messages.some((message) => message.id === fallbackMessageId)
              ) {
                const parent = await this.storage.transcripts.readMessage(
                  tab.id,
                  fallbackMessageId,
                );
                if (parent) messages.unshift(parent);
              }
              if (
                previousRunMessageId &&
                !messages.some((message) => message.id === previousRunMessageId)
              ) {
                const previous = await this.storage.transcripts.readMessage(
                  tab.id,
                  previousRunMessageId,
                );
                if (previous) {
                  const parentIndex = messages.findIndex(
                    (message) => message.id === fallbackMessageId,
                  );
                  messages.splice(
                    parentIndex < 0 ? 0 : parentIndex + 1,
                    0,
                    previous,
                  );
                }
              }
            }
          }
        }
      }
      Object.defineProperty(tab, 'messages', {
        enumerable: true,
        configurable: true,
        writable: true,
        value: messages,
      });
    }
    return state;
  }

  /** Commit one transaction; resolves once it is durable. */
  public async transact(
    build: TransactionBuilder,
    options: V2MutationOptions,
    visualAdmission?: ProviderVisualAdmission,
  ): Promise<V2Commit> {
    return (await this.runTransaction(build, options, false, visualAdmission))
      .commit;
  }

  /**
   * Commit one transaction, letting a delta-journal record share its sync
   * with the commits admitted around it (group commit). The transaction is
   * validated and applied in memory before this resolves, so the next one
   * is built against it. When `durable` is returned the commit must not be
   * acknowledged or published before it resolves; if it rejects, the commit
   * was not made durable and the scope reloads on its next operation.
   *
   * Without `durable` the commit is durable already: a version 2 scope, a
   * commit with publish hooks, and a record that changes committed rows,
   * which is checkpointed before this resolves.
   */
  public admit(
    build: TransactionBuilder,
    options: V2MutationOptions,
    visualAdmission?: ProviderVisualAdmission,
  ): Promise<V2Admission> {
    return this.runTransaction(build, options, true, visualAdmission);
  }

  /**
   * A re-reported result whose row is outside the loaded window, or in a
   * chat the transaction did not load, is read from storage so its visual
   * reference is carried forward rather than dropped.
   */
  private async addUnloadedPreviousResults(
    mutations: readonly ChatCoreMutation[],
    previous: Map<string, Map<string, PersistedChatMessage>>,
    existingChatIds: ReadonlySet<string>,
    loadedChatIds: ReadonlySet<string>,
  ): Promise<void> {
    const activeByChatId = new Map<string, PersistedChatMessage[]>();
    for (const mutation of mutations) {
      const carried = rowsCarriedBy(mutation);
      if (!carried || !existingChatIds.has(carried.chatId)) continue;
      const { chatId } = carried;
      const known =
        previous.get(chatId) ?? new Map<string, PersistedChatMessage>();
      for (const message of carried.messages) {
        if (!needsPreviousResult(message)) continue;
        const existing =
          known.get(message.id) ??
          (await this.unloadedMessage(
            chatId,
            message.id,
            loadedChatIds.has(chatId),
            activeByChatId,
          ));
        if (existing)
          known.set(
            message.id,
            existing.blocksRef
              ? await this.storage.transcripts.artifacts.expandBlocks(
                  chatId,
                  existing,
                )
              : existing,
          );
      }
      if (known.size > 0) previous.set(chatId, known);
    }
  }

  private async unloadedMessage(
    chatId: string,
    messageId: string,
    activeLoaded: boolean,
    activeByChatId: Map<string, PersistedChatMessage[]>,
  ): Promise<PersistedChatMessage | undefined> {
    const transcripts = this.storage.transcripts;
    const committed = await transcripts.committedMessage(chatId, messageId);
    if (committed || activeLoaded) return committed;
    let active = activeByChatId.get(chatId);
    if (!active) {
      active = await transcripts.activeMessages(chatId);
      activeByChatId.set(chatId, active);
    }
    return active.find((row) => row.id === messageId);
  }

  private async runTransaction(
    build: TransactionBuilder,
    options: V2MutationOptions,
    group: boolean,
    visualAdmission?: ProviderVisualAdmission,
  ): Promise<V2Admission> {
    return this.serial(async () => {
      let current = (this.indexes ??= await this.loadIndexes());
      const baseRevision = current.live.revision;
      const mutationId = options.mutationId ?? randomUUID();
      let view = await this.view(current, options);
      const empty: ChatJournalRecord = {
        v: 1,
        revision: baseRevision,
        mutationId,
        source: options.source,
        occurredAt: new Date().toISOString(),
        mutations: [],
      };
      // Nothing is written, but `view` may hold commits admitted ahead of
      // this one that are not durable yet: wait for them before answering.
      const unapplied = (): V2Admission => {
        const pending = group ? this.pendingJournalDurability() : undefined;
        return {
          commit: {
            baseRevision,
            revision: baseRevision,
            state: view,
            record: empty,
            applied: false,
          },
          ...(pending ? { durable: pending } : {}),
        };
      };
      if (current.recovery.mutationIds.includes(mutationId)) return unapplied();
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== baseRevision
      )
        throw new Error(
          `Chat revision conflict: expected ${options.expectedRevision}, current ${baseRevision}`,
        );
      // Artifacts are externalized while building and preparing the writes,
      // before the scope transaction publishes its journal record. Track the
      // files this transaction created so a failure before publication
      // reclaims exactly those and nothing an earlier commit or pending
      // payload references.
      const created = new CreatedArtifacts();
      const fields = await this.transcriptFieldMode();
      const artifacts = this.storage.transcripts.artifacts;
      const viewChats = new Set(
        [
          ...view.tabsFile.tabs,
          ...view.archivesFile.archived.map((entry) => entry.tab),
        ].map((tab) => tab.id),
      );
      let mutations: ChatCoreMutation[];
      try {
        mutations = await build(view, baseRevision, {
          getPortalSendReceipt: (userMessageId) =>
            current.recovery.receipts.find(
              (receipt) => receipt.portalSend?.userMessageId === userMessageId,
            ),
          hasRemovedTab: (id) => current.recovery.removedTabIds.includes(id),
          hasRemovedArchiveEntry: (id) =>
            current.recovery.removedArchiveEntryIds.includes(id),
          hasRemovedMessage: (id, chatId) =>
            chatId === undefined
              ? current.recovery.removedMessageIds.includes(id)
              : (current.recovery.removedMessageKeys ?? []).includes(
                  JSON.stringify([chatId, id]),
                ),
          // Only a scope whose selected manifest is format 4 publishes
          // bodies during build, under this transaction's rollback.
          ...(fields === 'format4'
            ? {
                transcriptFields: {
                  format: 4,
                  publish: (
                    chatId,
                    chunks,
                    signal,
                  ): Promise<PersistedToolOutputReference> => {
                    if (!viewChats.has(chatId))
                      return Promise.reject(
                        new Error('Transcript body owner is not in this scope'),
                      );
                    return artifacts.putStream(
                      chatId,
                      chunks,
                      created,
                      signal ? { signal } : {},
                    );
                  },
                },
              }
            : {}),
        });
      } catch (error) {
        await created.discard();
        throw error;
      }
      if (!mutations.length) {
        await created.discard();
        return unapplied();
      }
      // A retained stream card needs checkpointed files, not the journal's
      // projected sidecars. Detect before constructing transcript writes.
      const copyParents: StreamCopyParent[] = [];
      let copiesStreams = false;
      const streamDestinationIds = new Set<string>();
      try {
        for (const mutation of mutations) {
          if (
            (mutation.type !== 'tab.created' &&
              mutation.type !== 'archive.upserted') ||
            !mutation.transcriptSourceChatId
          )
            continue;
          const tab =
            mutation.type === 'tab.created' ? mutation.tab : mutation.entry.tab;
          const sourceChatId = mutation.transcriptSourceChatId;
          const rows = mutations.flatMap((candidate) =>
            candidate.type === 'messages.replaced' &&
            candidate.chatId === tab.id
              ? candidate.messages
              : candidate.type === 'message.upserted' &&
                  candidate.chatId === tab.id
                ? [candidate.message]
                : [],
          );
          copyParents.push({
            sourceChatId,
            targetChatId: tab.id,
            rows: (): PersistedChatMessage[] => [
              ...(tab.messages ?? []),
              ...rows,
            ],
          });
        }
        if (copyParents.length && (await this.store.format()) === 'v4') {
          const known = new Set<string>();
          if (this.journal) {
            for (const target of Array.from(this.journal.childTargets()))
              if (target.kind === 'delegation')
                known.add(delegationStreamKey(target));
          } else {
            const root = join(this.store.directory, 'transcripts');
            const catalog = await loadStreamCatalog(root);
            for (const parent of copyParents)
              if (catalog.parents[parent.sourceChatId])
                for (const entry of (
                  await loadStreamRegistry(root, parent.sourceChatId, {
                    readOnly: true,
                  })
                ).entries)
                  known.add(entry.streamKey);
          }
          for (const parent of copyParents)
            if (
              (await keptStreamTargets(this.storage.transcripts, parent)).some(
                (target) => known.has(delegationStreamKey(target)),
              )
            ) {
              copiesStreams = true;
              streamDestinationIds.add(parent.targetChatId);
            }
        }
        if (copiesStreams) {
          // A refusal must not stage files, and an indexed empty id is still owned.
          const indexed = new Set(allEntries(current).map((entry) => entry.id));
          if (Array.from(streamDestinationIds).some((id) => indexed.has(id))) {
            await created.discard();
            throw new StreamClosureCopyRefusalError(
              'indexed_destination',
              'Child stream copy destination is already indexed',
            );
          }
          await this.demoteForLargeMutation();
          current = this.indexes ??= await this.loadIndexes();
          view = await this.view(current, options);
          await this.reclaimStreamOrphans();
        }
      } catch (error) {
        await created.discard();
        throw error;
      }
      const revision = baseRevision + 1;
      const oldEntries = new Map(
        allEntries(current).map((tab) => [tab.id, tab]),
      );
      const viewTabs = new Map(
        [
          ...view.tabsFile.tabs,
          ...view.archivesFile.archived.map((entry) => entry.tab),
        ].map((tab) => [tab.id, tab]),
      );
      const currentMessagesByChatId = previousMessagesForMutations(
        mutations,
        viewTabs,
      );
      try {
        await this.addUnloadedPreviousResults(
          mutations,
          currentMessagesByChatId,
          new Set(oldEntries.keys()),
          new Set(options.chatIds ?? []),
        );
      } catch (error) {
        await created.discard();
        throw error;
      }
      const visualOwners = new VisualOwnerLedgerView(current.recovery);
      if (visualAdmission)
        visualOwners.prune(
          visualAdmission.staging.stagedIds(),
          visualAdmission.now(),
        );
      const visualContexts = externalizeVisualContexts(
        mutations,
        currentToolMessagesForMutations(mutations, viewTabs),
        visualAdmission,
        visualOwners,
      );
      const deltas = new Map<string, Delta>();
      const projectedMessages = new Map<
        ChatCoreMutation,
        PersistedChatMessage
      >();
      const delta = (id: string): Delta => {
        let value = deltas.get(id);
        if (!value) {
          value = {
            upserts: new Map(),
            insertions: new Map(),
            removed: new Set(),
          };
          deltas.set(id, value);
        }
        return value;
      };
      const metadataMutations: ChatCoreMutation[] = [];
      /** Committed rows in their prepared final form, by chat and row. */
      const prepared = new Map<string, PersistedChatMessage>();
      let committing = false;
      /** Pending while the commit's journal record waits for its batch. */
      let durable: Promise<void> | undefined;
      let commandResult: V2Commit['record']['commandResult'];
      let promotedVisuals: PromotedVisual[] = [];
      const preparedAppendOnlyChats = new Set<string>();
      let appendOnlyChatIds: string[] = [];
      try {
        for (const mutation of mutations) {
          if (mutation.type === 'message.upserted') {
            // The open form; `writes` prepares the rows it commits as final.
            const incoming = preserveVisualReferences(
              currentMessagesByChatId
                .get(mutation.chatId)
                ?.get(mutation.message.id),
              mutation.message,
            );
            const stored = await this.storage.transcripts.artifacts.externalize(
              mutation.chatId,
              incoming,
              created,
              transcriptFieldPolicy(fields, false),
              visualContexts.get(mutation.chatId),
            );
            projectedMessages.set(mutation, stored);
            const change = delta(mutation.chatId);
            change.upserts.set(stored.id, stored);
            if (mutation.afterMessageId)
              change.insertions.set(stored.id, mutation.afterMessageId);
            change.removed.delete(mutation.message.id);
            // The real body is carried only by the per-chat delta below.
            metadataMutations.push({
              ...mutation,
              message: { ...mutation.message, blocks: [] },
            });
          } else if (mutation.type === 'message.removed') {
            const change = delta(mutation.chatId);
            change.upserts.delete(mutation.messageId);
            change.insertions.delete(mutation.messageId);
            change.removed.add(mutation.messageId);
            metadataMutations.push(mutation);
          } else if (mutation.type === 'messages.replaced') {
            if (oldEntries.has(mutation.chatId) && !options.fullTranscript)
              throw new Error(
                'Replacing existing history requires an explicit full-transcript operation',
              );
            const change = delta(mutation.chatId);
            const previous = currentMessagesByChatId.get(mutation.chatId);
            change.replacement = mutation.messages.map((message) =>
              preserveVisualReferences(previous?.get(message.id), message),
            );
            // Explicit removals accompany intentional reset operations.
            // Imports and migrations are not incidental rewrites.
            change.reportReplacement =
              options.source !== 'import' &&
              options.source !== 'migration' &&
              mutation.removedMessageIds.length === 0;
            change.upserts.clear();
            change.insertions.clear();
            change.removed.clear();
            metadataMutations.push({ ...mutation, messages: [] });
          } else if (
            mutation.type === 'tab.created' ||
            mutation.type === 'archive.upserted'
          ) {
            const incoming =
              mutation.type === 'tab.created'
                ? mutation.tab
                : mutation.entry.tab;
            if (mutation.type === 'archive.upserted') delta(incoming.id);
            if (mutation.transcriptSourceChatId) {
              if (!oldEntries.has(mutation.transcriptSourceChatId))
                throw new Error('Unknown source transcript');
              delta(incoming.id).artifactSource =
                mutation.transcriptSourceChatId;
            }
            if (mutation.replaceTranscript) {
              if (
                !options.fullTranscript ||
                !Object.prototype.propertyIsEnumerable.call(
                  incoming,
                  'messages',
                )
              )
                throw new Error(
                  'Replacing existing history requires an explicit full-transcript operation',
                );
              if (
                incoming.transcriptLoaded === false ||
                incoming.transcriptWindow?.view === 'turns' ||
                incoming.transcriptWindow?.before !== undefined ||
                (incoming.transcript?.messageCount ?? 0) >
                  incoming.messages.length
              )
                throw new Error(
                  'Replacing history requires a complete transcript',
                );
              delta(incoming.id).replacement = incoming.messages;
            }
            if (
              Object.prototype.propertyIsEnumerable.call(incoming, 'messages')
            ) {
              const previous = viewTabs.get(incoming.id);
              const sameArray =
                previous &&
                Object.prototype.propertyIsEnumerable.call(
                  previous,
                  'messages',
                ) &&
                previous.messages === incoming.messages;
              if (!sameArray) {
                // An archived update carries its whole reduced view. Keep a
                // new row where the view puts it when retained rows follow.
                const known =
                  mutation.type === 'archive.upserted' &&
                  previous &&
                  Object.prototype.propertyIsEnumerable.call(
                    previous,
                    'messages',
                  )
                    ? new Set(previous.messages.map((message) => message.id))
                    : undefined;
                let lastKnown = -1;
                if (known)
                  incoming.messages.forEach((message, index) => {
                    if (known.has(message.id)) lastKnown = index;
                  });
                incoming.messages.forEach((message, index) => {
                  const change = delta(incoming.id);
                  change.upserts.set(
                    message.id,
                    preserveVisualReferences(
                      currentMessagesByChatId.get(incoming.id)?.get(message.id),
                      message,
                    ),
                  );
                  const afterMessageId = incoming.messages[index - 1]?.id;
                  if (
                    known &&
                    afterMessageId &&
                    index < lastKnown &&
                    !known.has(message.id)
                  )
                    change.insertions.set(message.id, afterMessageId);
                });
              }
            }
            const stripped = { ...incoming, messages: [] };
            metadataMutations.push(
              mutation.type === 'tab.created'
                ? { ...mutation, tab: stripped }
                : { ...mutation, entry: { ...mutation.entry, tab: stripped } },
            );
          } else {
            if (mutation.type === 'runtime.patched') delta(mutation.chatId);
            metadataMutations.push(mutation);
          }
        }
        const nextState = reduceChatState(
          metadataState(current, false),
          metadataMutations,
        );
        const inputLedgerTextChanges: InputLedgerTextChange[] = [];
        const convert = (
          {
            messages: _messages,
            transcriptLoaded: _loaded,
            transcriptWindow: _window,
            ...tab
          }: PersistedChatTab,
          index: number,
          archived: boolean,
        ): ChatIndexEntry => {
          void _messages;
          void _loaded;
          void _window;
          const previous = oldEntries.get(tab.id);
          if (!previous || tab.inputDelivery !== previous.inputDelivery)
            inputLedgerTextChanges.push({ archived, index, previous });
          return {
            ...tab,
            transcript: oldEntries.get(tab.id)?.transcript ?? {
              ...EMPTY_DESCRIPTOR,
            },
          };
        };
        const indexes: ChatStorageIndexes = {
          live: {
            ...nextState.tabsFile,
            version: 2,
            revision,
            tabs: nextState.tabsFile.tabs.map((tab, index) =>
              convert(tab, index, false),
            ),
            runtimeByChatId: nextState.runtimeByChatId,
          },
          archive: {
            version: 2,
            revision,
            archived: nextState.archivesFile.archived.map((entry, index) => ({
              ...entry,
              tab: convert(entry.tab, index, true),
            })),
          },
          // Every recovery field this commit changes is reassigned below, never
          // mutated in place, so a shallow copy keeps `current` intact.
          recovery: { ...current.recovery },
        };
        indexes.recovery.mutationIds = boundedIds(
          indexes.recovery.mutationIds,
          [mutationId],
          4096,
        );
        for (const mutation of mutations) {
          const removedIds =
            mutation.type === 'message.removed'
              ? [mutation.messageId]
              : mutation.type === 'messages.replaced'
                ? mutation.removedMessageIds
                : [];
          if (
            removedIds.length > 0 &&
            (mutation.type === 'message.removed' ||
              mutation.type === 'messages.replaced')
          ) {
            indexes.recovery.removedMessageKeys = boundedIds(
              indexes.recovery.removedMessageKeys ?? [],
              removedIds.map((id) => JSON.stringify([mutation.chatId, id])),
              1024,
            );
          }
          if (mutation.type === 'tab.removed')
            indexes.recovery.removedTabIds = boundedIds(
              indexes.recovery.removedTabIds,
              [mutation.tabId],
              1024,
            );
          if (mutation.type === 'archive.removed')
            indexes.recovery.removedArchiveEntryIds = boundedIds(
              indexes.recovery.removedArchiveEntryIds,
              [mutation.archiveEntryId],
              1024,
            );
          if (mutation.type === 'message.removed')
            indexes.recovery.removedMessageIds = boundedIds(
              indexes.recovery.removedMessageIds,
              [mutation.messageId],
              1024,
            );
          if (mutation.type === 'messages.replaced')
            indexes.recovery.removedMessageIds = boundedIds(
              indexes.recovery.removedMessageIds,
              mutation.removedMessageIds,
              1024,
            );
        }
        const receipt = options.commandResult
          ? { ...options.commandResult, revision }
          : undefined;
        commandResult = receipt;
        if (receipt)
          indexes.recovery.receipts = [
            ...indexes.recovery.receipts.filter(
              (existing) => existing.commandId !== receipt.commandId,
            ),
            receipt,
          ].slice(-256);
        const previousActive = new Map<string, PersistedChatMessage[]>();
        const forms: JournalWriteForms = {
          patches: new Map(),
          active: new Map(),
        };
        const fullRewrites: ChatTranscriptFullRewrite[] = [];
        let checkCopySources: () => void = (): void => {};
        if (copiesStreams) {
          const parents: StreamCopyParent[] = [];
          for (const [targetChatId, change] of Array.from(deltas)) {
            if (!change.artifactSource) continue;
            const rows = [
              ...(change.replacement ?? []),
              ...Array.from(change.upserts.values()),
            ];
            parents.push({
              sourceChatId: change.artifactSource,
              targetChatId,
              rows: (): PersistedChatMessage[] => rows,
            });
          }
          const root = join(this.store.directory, 'transcripts');
          const selected = await selectStreamClosure(
            root,
            this.storage.transcripts,
            parents,
          );
          await this.refuseStreamCopyDestinations(selected, current);
          await this.refuseStreamCopyCollisions(selected);
          checkCopySources = await copyStreamClosure({
            sourceRoot: root,
            destinationRoot: root,
            source: this.storage.transcripts,
            destination: this.storage.transcripts,
            selected,
            created,
            copyPrimary: (parent, row) =>
              copyTranscriptClosure(
                this.storage.transcripts,
                parent.sourceChatId,
                parent.targetChatId,
                artifacts,
                this.storage.transcripts.delegations,
                row,
                created,
              ),
          });
        }
        const writes = await this.writes(
          current,
          indexes,
          deltas,
          created,
          previousActive,
          this.journal ? forms : undefined,
          fullRewrites,
          fields,
          prepared,
          currentMessagesByChatId,
          viewTabs,
          options.rewriteReason,
          preparedAppendOnlyChats,
        );
        for (const write of writes)
          if (write.kind === 'delete') visualOwners.removeChat(write.chatId);
        // Claims refer to the admitted upsert identity, before final-field
        // preparation replaces it with a bounded or block-paged projection.
        promotedVisuals = promotedVisualsInWrites(
          projectedMessages,
          deltas,
          writes,
          visualOwners,
        );
        installVisualOwnerLedger(indexes.recovery, visualOwners);
        // Publish the representation the commit stores for each row.
        for (const [mutation, message] of Array.from(projectedMessages)) {
          if (mutation.type !== 'message.upserted') continue;
          const stored = prepared.get(
            preparedRowKey(mutation.chatId, message.id),
          );
          if (stored) projectedMessages.set(mutation, stored);
        }
        let journalWrites: DeltaJournalWrite[] | undefined;
        if (
          this.journal &&
          Array.from(deltas.values()).some((delta) => delta.insertions.size > 0)
        ) {
          // The delta patch format cannot express insertion into committed
          // history. Use the V2 ordered rewrite for this uncommon recovery.
          await this.demoteForLargeMutation();
        } else if (this.journal) {
          journalWrites = journalWritesFor(writes, forms);
          if (
            estimateJournalBytes(journalWrites) >
            (this.options.deltaJournal?.largeRecordBytes ??
              LARGE_JOURNAL_RECORD_BYTES)
          ) {
            // Too large for one record: this transaction is version 2.
            await this.demoteForLargeMutation();
            journalWrites = undefined;
          }
        }
        if (!journalWrites && fields === 'format4' && forms.patches.size > 0) {
          // A size/insertion demotion uses V2 writes, not the journal patch
          // forms. Restore its replacement semantics only on that fallback.
          const previous = new Map(
            allEntries(current).map((tab) => [tab.id, tab]),
          );
          for (let index = 0; index < writes.length; index++) {
            const write = writes[index];
            if (write?.kind !== 'append') continue;
            const patch = forms.patches.get(write.chatId);
            if (!patch) continue;
            const chatId = write.chatId;
            const transcript = this.storage.transcripts;
            writes[index] = {
              chatId,
              kind: 'replace',
              activeTailCount: patch.activeTailCount,
              messages:
                (async function* (): AsyncGenerator<PersistedChatMessage> {
                  yield* transcript.iterate(chatId);
                  yield* patch.tail;
                })(),
            };
            const committed = previous.get(chatId)?.transcript;
            if (committed && committed.committedMessageCount > 0)
              fullRewrites.push({
                chatId,
                reason: options.rewriteReason ?? 'mixed_active',
                committedRows: committed.committedMessageCount,
                committedBytes: committed.committedByteLength,
                patchedRows: 0,
                removedRows: 0,
                patchedBlockTypes: [],
                activeTail: true,
              });
          }
        }
        appendOnlyChatIds = writes.flatMap((write, index) => {
          if (
            !preparedAppendOnlyChats.has(write.chatId) ||
            !Array.isArray(write.messages) ||
            (write.kind !== 'append' && write.kind !== 'active')
          )
            return [];
          const effect = journalWrites?.[index];
          const equivalent =
            !journalWrites ||
            (effect?.chatId === write.chatId &&
              (effect.kind === 'append' ||
                effect.kind === 'active' ||
                effect.kind === 'active-upsert' ||
                (effect.kind === 'patch' &&
                  effect.patches.length === 0 &&
                  effect.removedMessageIds.length === 0)));
          return equivalent ? [write.chatId] : [];
        });
        const beforeArtifactIdentities = new Map<string, string>();
        for (const write of writes)
          try {
            const identity = await this.artifactMaintenance.identityIfCached(
              write.chatId,
            );
            if (identity) beforeArtifactIdentities.set(write.chatId, identity);
          } catch {
            // Derived accounting cannot reject the canonical transaction.
          }
        // The scope commit is serialized. Observe only its application/checkpoint,
        // correlate by chat, and release the bounded observer on either outcome.
        // Never retain measurements for recovery or emit before durability.
        const stopObserving = this.storage.transcripts.observeReplacements(
          (measurement) => {
            for (const rewrite of fullRewrites)
              if (rewrite.chatId === measurement.chatId)
                rewrite.measurement = measurement;
          },
        );
        try {
          committing = true;
          const journal = this.journal;
          if (journal && journalWrites) {
            const committed = await this.commitToJournal(
              journal,
              baseRevision,
              indexes,
              journalWrites,
              mutationId,
              created,
              options,
              group,
              inputLedgerTextChanges,
            );
            this.indexes = committed.indexes;
            durable = committed.durable;
          } else
            this.indexes = shareChangedInputLedgerText(
              await this.storage.commit(
                baseRevision,
                indexes,
                writes,
                created,
                () => {
                  options.beforePublish?.();
                  checkCopySources();
                },
                options.preparePublish,
              ),
              inputLedgerTextChanges,
            );
        } finally {
          stopObserving();
        }
        const markCommitted = (): void => {
          recordChatStorageMutations(mutations.length, this.store.directory);
          this.promotionRetry.activity();
          this.format4PromotionRetry.activity();
          // Durable now; report the rewrites this commit performed. A
          // journaled commit is no exception: a record that changes committed
          // rows is checkpointed before it is acknowledged, and that
          // checkpoint runs the same committed replacement.
          for (const rewrite of fullRewrites)
            if (rewrite.measurement !== undefined)
              reportChatTranscriptFullRewrite(rewrite);
        };
        if (durable) {
          // Group commit: counted and reported once, when the commit's batch
          // is durable. Batches settle in commit order.
          durable = durable.then(markCommitted, async (error: unknown) => {
            for (const write of writes)
              try {
                await this.artifactMaintenance.invalidate(write.chatId);
              } catch {
                // The failed journal remains a reclamation fence.
              }
            throw error;
          });
          // The caller observes the outcome; a failure before it does must
          // not surface as an unhandled rejection.
          durable.catch(() => undefined);
        } else markCommitted();
        for (const write of writes)
          try {
            // Active records count their logical projection in commit order;
            // the journal fence forbids unlink until a trusted checkpoint
            // rebases the physical identity. Rewrites still reset the filter.
            await this.artifactMaintenance.committed(
              write.chatId,
              write,
              previousActive.get(write.chatId) ?? [],
              beforeArtifactIdentities.get(write.chatId),
              { journalPending: this.pendingJournalRecords() > 0 },
            );
          } catch {
            try {
              await this.artifactMaintenance.invalidate(write.chatId);
            } catch {
              // Never turn a durable acknowledgement into a cleanup failure.
            }
          }
      } catch (error) {
        // The scope transaction owns reclamation once it starts; it knows
        // whether its journal record published.
        if (!committing) await created.discard();
        throw error;
      }
      // Publish the same lossless reference/preview representation that was
      // durably committed. A write must never stream its raw artifact body to
      // every renderer subscriber after the disk layer has externalized it.
      const projected: ChatCoreMutation[] = [];
      for (const mutation of mutations) {
        if (mutation.type === 'message.upserted') {
          const message = projectedMessages.get(mutation);
          if (!message) throw new Error('Missing prepared message projection');
          projected.push({
            ...mutation,
            message,
          });
        } else if (
          mutation.type === 'tab.created' ||
          mutation.type === 'archive.upserted'
        ) {
          const id =
            mutation.type === 'tab.created'
              ? mutation.tab.id
              : mutation.entry.tab.id;
          const entry = allEntries(this.indexes).find((tab) => tab.id === id);
          if (!entry) {
            projected.push(mutation);
            continue;
          }
          // A raw tail can start inside a long turn, losing its owning prompt
          // and timer. Publish the same bounded, framed view as initial loads.
          const page = await this.storage.transcripts.page(id, undefined, {
            view: 'turns',
          });
          const { messages, ...window } = page;
          const tab: PersistedChatTab = {
            ...entry,
            messages: [
              ...(page.latestHumanMessage &&
              !messages.some(
                (message) => message.id === page.latestHumanMessage?.id,
              )
                ? [page.latestHumanMessage]
                : []),
              ...messages,
            ],
            transcriptLoaded: true,
            transcriptWindow: window,
          };
          projected.push(
            mutation.type === 'tab.created'
              ? { ...mutation, tab }
              : { ...mutation, entry: { ...mutation.entry, tab } },
          );
        } else if (mutation.type === 'messages.replaced') {
          const page = await this.storage.transcripts.page(mutation.chatId);
          projected.push({
            ...mutation,
            messages: [
              ...(page.latestHumanMessage &&
              !page.messages.some(
                (message) => message.id === page.latestHumanMessage?.id,
              )
                ? [page.latestHumanMessage]
                : []),
              ...page.messages,
            ],
          });
        } else projected.push(mutation);
      }

      return {
        commit: {
          baseRevision,
          revision,
          state: await this.view(this.indexes, options),
          applied: true,
          record: {
            ...empty,
            revision,
            mutations: projected,
            ...(commandResult ? { commandResult } : {}),
          },
          ...(promotedVisuals.length > 0 ? { promotedVisuals } : {}),
          ...(appendOnlyChatIds.length > 0 ? { appendOnlyChatIds } : {}),
        },
        ...(durable ? { durable } : {}),
      };
    });
  }

  /**
   * Commit through the delta journal: artifacts were published while the
   * writes were prepared; the writer appends one record and syncs the
   * journal once. A record that changes committed rows (an append, a
   * rewrite, a chat created or deleted) is checkpointed before this returns,
   * so committed rows are always read from the files; metadata and active
   * rows stay journaled until a later checkpoint.
   *
   * With `group`, the record is admitted for group commit instead: it shares
   * one append and one sync with the records admitted while a sync is in
   * flight. A record that stays journaled returns at once with `durable`;
   * one that must be checkpointed waits for its batch here, then checkpoints,
   * as before. A commit with publish hooks is always written alone, so its
   * check stays at the write boundary.
   */
  private async commitToJournal(
    journal: ChatDeltaJournalWriter,
    baseRevision: number,
    next: ChatStorageIndexes,
    writes: readonly DeltaJournalWrite[],
    mutationId: string,
    created: CreatedArtifacts,
    options: V2MutationOptions,
    group: boolean,
    inputLedgerTextChanges: readonly InputLedgerTextChange[],
  ): Promise<{ indexes: ChatStorageIndexes; durable?: Promise<void> }> {
    const startedAt = performance.now();
    const input = {
      expectedRevision: baseRevision,
      next,
      writes,
      mutationIds: [mutationId],
      created,
    };
    const recordCommit = (): void =>
      recordChatStorageCommit({
        scopeDirectory: this.store.directory,
        durationMs: performance.now() - startedAt,
        queueWaitMs: 0,
      });
    if (!group || options.preparePublish || options.beforePublish) {
      const result = await journal.commit({
        ...input,
        ...(options.preparePublish
          ? { preparePublish: options.preparePublish }
          : {}),
        ...(options.beforePublish
          ? { beforePublish: options.beforePublish }
          : {}),
      });
      if (!result.applied)
        throw new Error('Delta journal already holds this mutation');
      recordCommit();
      if (options.checkpoint === true || journal.hasCommittedRowChanges())
        return {
          indexes: await this.checkpointJournal(
            journal,
            new Set(writes.map((write) => write.chatId)),
          ),
        };
      return {
        indexes: shareChangedInputLedgerText(
          await this.projectedIndexes(journal),
          inputLedgerTextChanges,
        ),
      };
    }
    const admitted = await journal.admit(input);
    if (!admitted.result.applied)
      throw new Error('Delta journal already holds this mutation');
    if (options.checkpoint === true || journal.hasCommittedRowChanges()) {
      // A checkpoint applies records the journal holds durably.
      await admitted.durable;
      recordCommit();
      return {
        indexes: await this.checkpointJournal(
          journal,
          new Set(writes.map((write) => write.chatId)),
        ),
      };
    }
    const indexes = shareChangedInputLedgerText(
      await this.projectedIndexes(journal),
      inputLedgerTextChanges,
    );
    return { indexes, durable: admitted.durable.then(recordCommit) };
  }

  private async writes(
    current: ChatStorageIndexes,
    next: ChatStorageIndexes,
    deltas: Map<string, Delta>,
    created: CreatedArtifacts,
    previousActive?: Map<string, PersistedChatMessage[]>,
    forms?: JournalWriteForms,
    fullRewrites?: ChatTranscriptFullRewrite[],
    fields: TranscriptFieldMode = 'legacy',
    prepared?: Map<string, PersistedChatMessage>,
    currentMessagesByChatId?: ReadonlyMap<
      string,
      ReadonlyMap<string, PersistedChatMessage>
    >,
    viewTabs?: ReadonlyMap<string, PersistedChatTab>,
    rewriteReason?: ChatMutationOptions['rewriteReason'],
    appendOnlyChats?: Set<string>,
  ): Promise<ChatTranscriptWrite[]> {
    const artifacts = this.storage.transcripts.artifacts;
    /** A committed row's stored form: format 4 offloads its final fields. */
    const prepareFinal = async (
      chatId: string,
      message: PersistedChatMessage,
    ): Promise<PersistedChatMessage> => {
      const stored = await artifacts.externalize(
        chatId,
        message,
        created,
        transcriptFieldPolicy(fields, true),
      );
      prepared?.set(preparedRowKey(chatId, stored.id), stored);
      return stored;
    };
    const previous = new Map(allEntries(current).map((tab) => [tab.id, tab]));
    const remaining = new Map(allEntries(next).map((tab) => [tab.id, tab]));
    const writes: ChatTranscriptWrite[] = [];
    for (const id of Array.from(previous.keys()))
      if (!remaining.has(id)) writes.push({ chatId: id, kind: 'delete' });
    for (const id of Array.from(remaining.keys())) {
      const change = deltas.get(id);
      const old = previous.get(id);
      if (!change && old) continue;
      if (change?.artifactSource) {
        for (const message of [
          ...(change.replacement ?? []),
          ...Array.from(change.upserts.values()),
        ])
          await copyTranscriptClosure(
            this.storage.transcripts,
            change.artifactSource,
            id,
            artifacts,
            this.storage.transcripts.delegations,
            message,
            created,
          );
      }
      const isActive = ACTIVE.has(
        next.live.runtimeByChatId[id]?.status ?? 'idle',
      );
      const existingMessages = currentMessagesByChatId?.get(id);
      if (change?.replacement) {
        const rows = new Map<string, PersistedChatMessage>();
        for (const message of change.replacement)
          rows.set(
            message.id,
            preserveVisualReferences(
              existingMessages?.get(message.id),
              message,
            ),
          );
        if (rows.size !== change.replacement.length)
          throw new Error('Duplicate replacement message id');
        for (const message of Array.from(change.upserts.values()))
          rows.set(
            message.id,
            preserveVisualReferences(
              existingMessages?.get(message.id),
              message,
            ),
          );
        for (const removed of Array.from(change.removed)) rows.delete(removed);
        const replacementRows = Array.from(rows.values());
        const priorCommittedRows: PersistedChatMessage[] = [];
        if (old) {
          const previousView = viewTabs?.get(id);
          if (
            previousView &&
            Object.prototype.propertyIsEnumerable.call(previousView, 'messages')
          ) {
            const priorActiveIds = new Set(
              (await this.storage.transcripts.activeMessages(id)).map(
                (row) => row.id,
              ),
            );
            for (const row of previousView.messages)
              if (!priorActiveIds.has(row.id)) priorCommittedRows.push(row);
          } else
            for await (const row of this.storage.transcripts.iterate(id))
              priorCommittedRows.push(row);
        }
        // Only a suffix after the last retained committed row can be mutable.
        // Reordering or patching committed rows rewrites the committed log; it
        // never transfers those rows into the active sidecar. New rows inserted
        // before committed rows likewise belong to the committed replacement.
        const previouslyCommitted = new Set(
          priorCommittedRows.map((message) => message.id),
        );
        let committedPrefixCount = 0;
        for (let index = 0; index < replacementRows.length; index += 1) {
          const row = replacementRows[index];
          if (row && previouslyCommitted.has(row.id))
            committedPrefixCount = index + 1;
        }
        const activeTailCount = isActive
          ? replacementRows.length - committedPrefixCount
          : 0;
        if (
          change.reportReplacement &&
          old &&
          old.transcript.committedMessageCount > 0
        ) {
          const committedCount = replacementRows.length - activeTailCount;
          let changedCommitted = false;
          for (
            let ordinal = 0;
            ordinal < committedCount && ordinal < priorCommittedRows.length;
            ordinal += 1
          )
            if (
              !isDeepStrictEqual(
                replacementRows[ordinal],
                priorCommittedRows[ordinal],
              )
            ) {
              changedCommitted = true;
              break;
            }
          // An unchanged prefix with only a new/changed active tail (or an
          // intentional truncation/reset) does not rewrite existing row data.
          if (changedCommitted)
            fullRewrites?.push({
              chatId: id,
              reason: rewriteReason ?? 'replacement',
              committedRows: old.transcript.committedMessageCount,
              committedBytes: old.transcript.committedByteLength,
              patchedRows: 0,
              removedRows: 0,
              patchedBlockTypes: [],
              activeTail: activeTailCount > 0,
            });
        }
        writes.push({
          chatId: id,
          kind: 'replace',
          messages: replacementRows,
          ...(isActive ? { activeTailCount } : {}),
        });
        continue;
      }
      const active = old
        ? await this.storage.transcripts.activeMessages(id)
        : [];
      previousActive?.set(id, active);
      const mutable = new Map(active.map((message) => [message.id, message]));
      const patches = new Map<string, PersistedChatMessage>();
      const removed = change?.removed ?? new Set<string>();
      const changedActive = new Set<string>();
      // Positions apply only to rows this write adds; stored rows keep theirs.
      const added = new Set<string>();
      let rewrite = false;
      let removedFromActive = false;
      let removedCommittedRows = 0;
      let changed = !old;
      for (const message of Array.from(change?.upserts.values() ?? [])) {
        const preserved = preserveVisualReferences(
          existingMessages?.get(message.id),
          message,
        );
        const stored = await artifacts.externalize(
          id,
          preserved,
          created,
          transcriptFieldPolicy(fields, false),
        );
        if (mutable.has(stored.id)) {
          mutable.set(stored.id, stored);
          changedActive.add(stored.id);
          changed = true;
          continue;
        }
        // A committed row compares, and is patched, in the final form the
        // writer stores; then an unchanged re-upsert stays identical.
        const committed =
          fields !== 'legacy' &&
          old &&
          (await this.storage.transcripts.hasCommittedMessage(id, stored.id))
            ? await prepareFinal(id, preserved)
            : stored;
        const status = old
          ? await this.storage.transcripts.committedMessageState(id, committed)
          : 'absent';
        if (status === 'identical') continue;
        changed = true;
        if (status === 'different') {
          patches.set(committed.id, committed);
          rewrite = true;
        } else {
          mutable.set(stored.id, stored);
          changedActive.add(stored.id);
          added.add(stored.id);
        }
      }
      for (const messageId of Array.from(removed)) {
        const removedActiveMessage = mutable.delete(messageId);
        const removedFromCommitted = old
          ? await this.storage.transcripts.hasCommittedMessage(id, messageId)
          : false;
        if (removedActiveMessage) removedFromActive = true;
        if (removedActiveMessage || removedFromCommitted) changed = true;
        if (removedFromCommitted) {
          rewrite = true;
          removedCommittedRows += 1;
        }
      }
      const committedInsertions = new Map<string, PersistedChatMessage[]>();
      const committedInsertionIds = new Set<string>();
      for (const [messageId, afterMessageId] of Array.from(
        change?.insertions ?? [],
      )) {
        if (!added.has(messageId)) {
          change?.insertions.delete(messageId);
          continue;
        }
        const inserted = mutable.get(messageId);
        if (!inserted || messageId === afterMessageId)
          throw new Error(
            `Invalid positioned message insertion ${messageId} after ${afterMessageId}`,
          );
        if (mutable.has(afterMessageId)) {
          const ordered = Array.from(mutable.values()).filter(
            (message) => message.id !== messageId,
          );
          const anchorIndex = ordered.findIndex(
            (message) => message.id === afterMessageId,
          );
          let insertAt = anchorIndex + 1;
          while (
            insertAt < ordered.length &&
            ordered[insertAt]?.parentBlockId === afterMessageId
          )
            insertAt += 1;
          ordered.splice(insertAt, 0, inserted);
          mutable.clear();
          for (const message of ordered) mutable.set(message.id, message);
        } else if (
          committedInsertionIds.has(afterMessageId) ||
          (old &&
            (await this.storage.transcripts.hasCommittedMessage(
              id,
              afterMessageId,
            )))
        ) {
          mutable.delete(messageId);
          const siblings = committedInsertions.get(afterMessageId) ?? [];
          siblings.push(
            fields === 'legacy' ? inserted : await prepareFinal(id, inserted),
          );
          committedInsertions.set(afterMessageId, siblings);
          committedInsertionIds.add(messageId);
          rewrite = true;
        } else {
          throw new Error(
            `Positioned message anchor is missing: ${afterMessageId}`,
          );
        }
      }
      const tail = Array.from(mutable.values());
      const firstMutable = isActive
        ? tail.findIndex((message) => message.role !== 'user')
        : -1;
      const committedPrefixCount = isActive
        ? firstMutable === -1
          ? tail.length
          : firstMutable
        : tail.length;
      const activeTailCount = isActive ? tail.length - committedPrefixCount : 0;
      // The committed prefix is final; the active suffix stays open.
      if (fields !== 'legacy')
        for (let index = 0; index < committedPrefixCount; index++) {
          const row = tail[index];
          if (row) tail[index] = await prepareFinal(id, row);
        }
      const mixedCommittedAndActive =
        committedPrefixCount > 0 && activeTailCount > 0;
      const appendMixedTail = mixedCommittedAndActive && !this.isDeltaJournal();
      const canReplaceOnlyActive =
        removedFromActive &&
        ((isActive && committedPrefixCount === 0) || tail.length === 0);
      if (removedFromActive && !canReplaceOnlyActive) rewrite = true;
      // Reuse admission's exact membership facts, never a bounded read view.
      // A final append may still replace an active row, so its kind alone
      // is insufficient (notably a settlement that replaces final output).
      const addsOnly =
        !rewrite &&
        !removedFromActive &&
        removed.size === 0 &&
        patches.size === 0 &&
        committedInsertions.size === 0 &&
        (change?.upserts.size ?? 0) > 0 &&
        Array.from(change?.upserts.keys() ?? []).every((id) => added.has(id));
      if (
        old &&
        forms &&
        fields === 'format4' &&
        mixedCommittedAndActive &&
        !rewrite &&
        patches.size === 0 &&
        removed.size === 0 &&
        committedInsertions.size === 0
      ) {
        let appendOnly = true;
        for (const message of tail)
          if (
            await this.storage.transcripts.hasCommittedMessage(id, message.id)
          ) {
            appendOnly = false;
            break;
          }
        if (appendOnly) {
          if (addsOnly) appendOnlyChats?.add(id);
          // Keep the format-4 patch encoding, but neither build a history
          // generator nor report a rewrite for its guarded append checkpoint.
          forms.patches.set(id, {
            patches: [],
            removedMessageIds: [],
            tail,
            activeTailCount,
          });
          writes.push({
            chatId: id,
            kind: 'append',
            messages: tail,
            activeTailCount,
          });
          continue;
        }
      }
      if (rewrite || (mixedCommittedAndActive && this.isDeltaJournal())) {
        const committed = old?.transcript;
        if (committed && committed.committedMessageCount > 0)
          fullRewrites?.push({
            chatId: id,
            reason:
              rewriteReason ??
              (patches.size > 0
                ? 'patch'
                : rewrite
                  ? 'removal'
                  : 'mixed_active'),
            committedRows: committed.committedMessageCount,
            committedBytes: committed.committedByteLength,
            patchedRows: patches.size,
            removedRows: removedCommittedRows,
            patchedBlockTypes: Array.from(patches.values()).flatMap((message) =>
              message.blocks.map((block) => block.type),
            ),
            activeTail: isActive,
          });
        const transcript = this.storage.transcripts;
        const insertedAfter = (anchorId: string): PersistedChatMessage[] => {
          const rows: PersistedChatMessage[] = [];
          const collect = (id: string): void => {
            for (const inserted of committedInsertions.get(id) ?? []) {
              rows.push(inserted);
              collect(inserted.id);
            }
          };
          collect(anchorId);
          return rows;
        };
        if (old)
          forms?.patches.set(id, {
            patches: Array.from(patches.values()),
            removedMessageIds: Array.from(removed),
            tail,
            activeTailCount,
          });
        writes.push({
          chatId: id,
          kind: 'replace',
          ...(isActive ? { activeTailCount } : {}),
          messages: (async function* (): AsyncGenerator<PersistedChatMessage> {
            let pendingGroup: string | undefined;
            if (old)
              for await (const message of transcript.iterate(id)) {
                if (pendingGroup && message.parentBlockId !== pendingGroup) {
                  yield* insertedAfter(pendingGroup);
                  pendingGroup = undefined;
                }
                if (!removed.has(message.id)) {
                  yield patches.get(message.id) ?? message;
                  if (committedInsertions.has(message.id))
                    pendingGroup = message.id;
                }
              }
            if (pendingGroup) yield* insertedAfter(pendingGroup);
            yield* tail;
          })(),
        });
      } else if (changed || (!isActive && active.length)) {
        if (addsOnly && !canReplaceOnlyActive) appendOnlyChats?.add(id);
        if (old)
          forms?.active.set(id, {
            previous: active,
            next: tail,
            changed: changedActive,
          });
        writes.push({
          chatId: id,
          kind: canReplaceOnlyActive
            ? 'active-replace'
            : isActive && committedPrefixCount === 0
              ? 'active'
              : 'append',
          messages: tail,
          ...(appendMixedTail ? { activeTailCount } : {}),
        });
      }
    }
    return writes;
  }
}
import { normalizeLegacyPersistedChatTab } from '@canopy/desktop-shared/persisted-chat-state';
