import {
  buildTurnIndex,
  isTranscriptTurnIndex,
  type IndexedTurn,
  type TranscriptTurnIndex,
} from './chat-transcript-turn-index';
import type {
  TranscriptBodyField,
  TranscriptViewRequest,
  TranscriptTurnSummary,
} from '@canopy/agent-transcript/transcript-storage';
import { foldTranscriptTodoState } from '@canopy/agent-transcript';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readSync } from 'node:fs';
import {
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type {
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import {
  isHumanAuthoredUserMessage,
  TRANSCRIPT_PAGE_SIZE,
  transcriptBodyReferences,
  type TranscriptPage,
  type TranscriptDescriptor,
} from '@canopy/agent-transcript/transcript-storage';
import { ChatDelegationLogs } from './chat-delegation-log';
import { chatChildDeleteFence } from './chat-child-delete-fence';
import {
  buildChildStreamSequenceIndex,
  childStreamSequencePage,
  findChildStreamSequenceEntry,
  type ChildStreamSequenceEntry,
} from './child-stream-sequence-index';
import {
  ChatTranscriptArtifacts,
  assertTranscriptIdentity,
  type TranscriptFieldPolicy,
} from './chat-transcript-artifacts';
import {
  primaryTranscriptPaths,
  type TranscriptStreamPaths,
} from './transcript-stream-paths';
import {
  artifactIdsOf,
  storedArtifactLocations,
} from './chat-artifact-references';
import {
  recordChatStorageAtomicReplacement,
  recordChatStorageFileSync,
  recordChatStorageFileWrite,
} from '@canopy/desktop-shared/node/work-counters';
import { beginMainTranscriptPerformanceStage } from './transcript-performance';
import { fsyncDirectory } from './fsync-directory';
import { isPersistedChatMessage } from './persisted-chat-message-validation';
import { iterateAsync, writeJsonValuesCooperatively } from './cooperative-json';
import { isErrnoException, isRecord } from './type-guards';
import {
  MAX_TRANSCRIPT_ROW_BYTES,
  replaceSharedPrefix,
} from './chat-transcript-prefix-replace';
import {
  checkActiveSidecarMessageRecordBudget,
  decodeActiveRowAnchors,
  encodeActiveRowAnchors,
  parseActiveRowAnchor,
  rankLogicalPlacement,
  resolveLogicalPlacement,
  validateActiveRowAnchors as validateActiveRowAnchorSet,
  type ActiveRowAnchor,
  type ActiveSidecarMessageRecord,
  type LogicalPlacement,
  type LogicalPlacementRanks,
} from './chat-transcript-live-positions';

const SPARSE_STRIDE = TRANSCRIPT_PAGE_SIZE;
const MAX_COMMITTED_LOCATOR_IDENTITY_KEYS = 100_000;
const COMPLETED_TURN_TAIL_SIZE = 16;
const LIVE_RUN_CHILD_TAIL_SIZE = 16;
const MAX_REDUCER_FRAME_TIMER_ROWS = 16;
const MAX_REDUCER_FRAME_CARD_ROWS = 32;
const MAX_REDUCER_FRAME_TOOL_ROWS = 64;
const MAX_REDUCER_FRAME_TOOL_IDS = 512;
const MAX_REDUCER_FRAME_TOOL_IDS_PER_ROW = 64;
const MAX_REDUCER_FRAME_PENDING_RESULTS = 512;
export { MAX_TRANSCRIPT_ROW_BYTES };
/**
 * Seed of the committed-row hash chain. The chain identifies the committed
 * prefix content: `sha256(previous ‖ rowDigest)` over rows in order, extended
 * on append, recomputed by replace, and derived by every rebuild from JSONL.
 * Active-sidecar updates never touch it.
 */
export const EMPTY_COMMITTED_DIGEST: string = createHash('sha256')
  .update('complete-message-jsonl-v1:committed-digest')
  .digest('hex');

export type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';

/**
 * The durable log holds less than a committed index describes. Callers map
 * this to the scope's `recovery_error` lifecycle; it never becomes a shorter
 * or empty chat.
 */
export class ChatTranscriptIntegrityError extends Error {
  public override readonly name = 'ChatTranscriptIntegrityError';
}

function errorFromUnknown(value: unknown): Error {
  return value instanceof Error
    ? value
    : Object.assign(new Error(String(value)), { cause: value });
}

/**
 * The body-field representation a scope transaction selected from the
 * manifest it captured, passed with each write (never a store setting):
 * - `legacy`: formats 2 and 3; only tool output is offloaded.
 * - `format4`: prepare rows of a format 4 scope; final rows publish
 *   generalized fields, open rows keep them inline.
 * - `format4-verify`: re-apply rows a format 4 writer already prepared
 *   (replay, checkpoint materialization, readers); never publishes.
 * - `format4-committed`: `format4-verify` for rows the log already holds
 *   (patch replay); keeps a field a format 3 writer committed inline and
 *   whole before promotion. A checkpointed format 4 file transaction instead
 *   prepares its whole rewrite, which offloads such a field.
 */
export type TranscriptFieldMode =
  | 'legacy'
  | 'format4'
  | 'format4-verify'
  | 'format4-committed';

export function transcriptFieldPolicy(
  mode: TranscriptFieldMode,
  final: boolean,
): TranscriptFieldPolicy {
  switch (mode) {
    case 'legacy':
      return { kind: 'legacy' };
    case 'format4':
      return { kind: 'format4', final };
    case 'format4-verify':
      return { kind: 'format4-verify', final };
    case 'format4-committed':
      return { kind: 'format4-verify', final, committed: true };
  }
}

/**
 * Prepare `rows` in order where the last `activeTailCount` are open (the
 * active projection) and the rest are final, holding only the tail.
 */
export async function* prepareRowsWithActiveTail(
  rows: Iterable<PersistedChatMessage> | AsyncIterable<PersistedChatMessage>,
  activeTailCount: number,
  prepare: (
    message: PersistedChatMessage,
    final: boolean,
  ) => Promise<PersistedChatMessage>,
): AsyncGenerator<PersistedChatMessage> {
  const tail: PersistedChatMessage[] = [];
  for await (const row of iterateAsync(rows)) {
    tail.push(row);
    if (tail.length <= activeTailCount) continue;
    const head = tail.shift();
    if (head) yield await prepare(head, true);
  }
  for (const row of tail) yield await prepare(row, false);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Artifact ids an unpaged row keeps reachable: body references and visuals. */
function rowArtifactIds(message: PersistedChatMessage): string[] {
  return [
    ...transcriptBodyReferences(message).map(
      ({ reference }) => reference.artifactId,
    ),
    ...message.blocks.flatMap((block) => artifactIdsOf(block, 'visual')),
  ];
}

const STORED_ARTIFACT_LOCATIONS = storedArtifactLocations();

/** Rows are bounded on the write side so a stored row can always be read back. */
export function assertTranscriptRowWithinLimit(
  message: PersistedChatMessage,
): void {
  if (
    Buffer.byteLength(JSON.stringify(message), 'utf8') >
    MAX_TRANSCRIPT_ROW_BYTES
  )
    throw new Error('Transcript row exceeds maximum size');
}

interface SparseReducerFrameReference {
  id: string;
  ordinal: number;
  offset: number;
}

interface ReducerFrameToolResultWitness<Reference> {
  toolUseId: string;
  row: Reference;
}

interface ReducerFrameToolUseRow<Reference> {
  row: Reference;
  toolUseIds: string[];
  resultWitnesses: Array<ReducerFrameToolResultWitness<Reference>>;
}

interface ReducerFrameCardRow<Reference> {
  row: Reference;
  carriesToolUses: boolean;
}

interface ReducerFrameFold<Reference extends { id: string; ordinal: number }> {
  boundary?: Reference;
  timers: Reference[];
  cards: Array<ReducerFrameCardRow<Reference>>;
  toolUses: Array<ReducerFrameToolUseRow<Reference>>;
  pendingResults: Array<ReducerFrameToolResultWitness<Reference>>;
}

interface SparseReducerFrame extends ReducerFrameFold<SparseReducerFrameReference> {
  version: 1;
  /** Committed rows folded; a build that appends without folding leaves it behind. */
  messageCount: number;
}

interface SparseIndex extends TranscriptDescriptor {
  version: 3;
  committedDigest: string;
  offsets: Array<{ ordinal: number; offset: number }>;
  latestHuman?: { ordinal: number; offset: number };
  reducerFrame?: SparseReducerFrame;
}

type ReducerFrameViewRequest = TranscriptViewRequest & {
  reducerFrame?: boolean;
};

interface ReducerFramePageReference {
  id: string;
  ordinal: number;
  offset?: number;
  message: PersistedChatMessage;
  rank: number;
}

function emptyReducerFrameFold<
  Reference extends { id: string; ordinal: number },
>(): ReducerFrameFold<Reference> {
  return { timers: [], cards: [], toolUses: [], pendingResults: [] };
}

function emptySparseReducerFrame(): SparseReducerFrame {
  return {
    version: 1,
    messageCount: 0,
    ...emptyReducerFrameFold<SparseReducerFrameReference>(),
  };
}

function distinctToolUseIds(message: PersistedChatMessage): string[] {
  const ids = new Set<string>();
  for (const block of message.blocks)
    if (block.type === 'tool_use') ids.add(block.toolUseId);
  return Array.from(ids);
}

function distinctToolResultIds(message: PersistedChatMessage): string[] {
  const ids = new Set<string>();
  for (const block of message.blocks)
    if (block.type === 'tool_result') ids.add(block.toolUseId);
  return Array.from(ids);
}

function hasReducerFrameCard(message: PersistedChatMessage): boolean {
  return message.blocks.some(
    (block) =>
      block.type === 'codex_agent_call' ||
      block.type === 'delegated_agent_call' ||
      (block.type === 'tool_use' &&
        (block.toolName === 'Task' || block.toolName === 'Agent')),
  );
}

function hasReducerFrameContent(message: PersistedChatMessage): boolean {
  return (
    isUserTurnBoundary(message) ||
    message.blocks.some(
      (block) =>
        block.type === 'turn_timer' ||
        block.type === 'codex_agent_call' ||
        block.type === 'delegated_agent_call' ||
        block.type === 'tool_use' ||
        block.type === 'tool_result',
    )
  );
}

function addOrReplaceToolResultWitness<
  Reference extends { id: string; ordinal: number },
>(
  witnesses: Array<ReducerFrameToolResultWitness<Reference>>,
  toolUseId: string,
  row: Reference,
): Array<ReducerFrameToolResultWitness<Reference>> {
  return [
    ...witnesses.filter((witness) => witness.toolUseId !== toolUseId),
    { toolUseId, row },
  ].sort((left, right) => left.row.ordinal - right.row.ordinal);
}

/**
 * Bounded reducer context folded as each committed row is recorded. Every cap
 * evicts oldest context first; tool-use rows are evicted as coherent groups
 * so their retained uses always carry result witnesses for every completed id.
 */
function foldReducerFrame<Reference extends { id: string; ordinal: number }>(
  previous: ReducerFrameFold<Reference>,
  message: PersistedChatMessage,
  reference: Reference,
): ReducerFrameFold<Reference> {
  const boundary = isUserTurnBoundary(message);
  const next: ReducerFrameFold<Reference> = boundary
    ? {
        ...emptyReducerFrameFold<Reference>(),
        // A wake gets a timer only when the chat already has one; keep the
        // latest earlier timer so a windowed view sees one too. It stays
        // behind the boundary, so the new turn never reopens it.
        timers: previous.timers.slice(-1),
      }
    : {
        ...previous,
        timers: [...previous.timers],
        cards: [...previous.cards],
        toolUses: previous.toolUses.map((entry) => ({
          ...entry,
          toolUseIds: [...entry.toolUseIds],
          resultWitnesses: [...entry.resultWitnesses],
        })),
        pendingResults: [...previous.pendingResults],
      };
  if (boundary) next.boundary = reference;

  if (message.blocks.some((block) => block.type === 'turn_timer'))
    next.timers = [...next.timers, reference].slice(
      -MAX_REDUCER_FRAME_TIMER_ROWS,
    );

  const toolUseIds = distinctToolUseIds(message);
  if (
    toolUseIds.length > 0 &&
    toolUseIds.length <= MAX_REDUCER_FRAME_TOOL_IDS_PER_ROW
  ) {
    const existingResults = next.pendingResults.filter((witness) =>
      toolUseIds.includes(witness.toolUseId),
    );
    next.toolUses = [
      ...next.toolUses,
      {
        row: reference,
        toolUseIds,
        resultWitnesses: existingResults,
      },
    ].slice(-MAX_REDUCER_FRAME_TOOL_ROWS);
    while (
      next.toolUses.reduce((count, row) => count + row.toolUseIds.length, 0) >
      MAX_REDUCER_FRAME_TOOL_IDS
    )
      next.toolUses.shift();
  }

  const resultIds = distinctToolResultIds(message);
  for (const toolUseId of resultIds) {
    next.toolUses = next.toolUses.map((entry) =>
      entry.toolUseIds.includes(toolUseId)
        ? {
            ...entry,
            resultWitnesses: addOrReplaceToolResultWitness(
              entry.resultWitnesses,
              toolUseId,
              reference,
            ),
          }
        : entry,
    );
    next.pendingResults = [
      ...next.pendingResults.filter(
        (witness) => witness.toolUseId !== toolUseId,
      ),
      { toolUseId, row: reference },
    ].slice(-MAX_REDUCER_FRAME_PENDING_RESULTS);
  }

  const carriesToolUses = toolUseIds.length > 0;
  if (hasReducerFrameCard(message)) {
    const retainedToolRow = next.toolUses.some(
      (entry) => entry.row.id === reference.id,
    );
    if (!carriesToolUses || retainedToolRow)
      next.cards = [
        ...next.cards.filter((entry) => entry.row.id !== reference.id),
        { row: reference, carriesToolUses },
      ].slice(-MAX_REDUCER_FRAME_CARD_ROWS);
  }
  const retainedToolRows = new Set(next.toolUses.map((entry) => entry.row.id));
  next.cards = next.cards.filter(
    (entry) => !entry.carriesToolUses || retainedToolRows.has(entry.row.id),
  );
  return next;
}

function sparseReducerFrameReferences(
  frame: SparseReducerFrame,
  pendingToolUseIds: ReadonlySet<string> = new Set(),
): SparseReducerFrameReference[] {
  const references = new Map<number, SparseReducerFrameReference>();
  const add = (reference: SparseReducerFrameReference): void => {
    const previous = references.get(reference.ordinal);
    if (
      previous &&
      (previous.offset !== reference.offset || previous.id !== reference.id)
    )
      throw new ChatTranscriptIntegrityError(
        'Reducer frame contains conflicting references for one ordinal',
      );
    references.set(reference.ordinal, reference);
  };
  if (frame.boundary) add(frame.boundary);
  frame.timers.forEach(add);
  frame.cards.forEach(({ row }) => add(row));
  for (const tool of frame.toolUses) {
    add(tool.row);
    tool.resultWitnesses.forEach(({ row }) => add(row));
  }
  for (const witness of frame.pendingResults)
    if (pendingToolUseIds.has(witness.toolUseId)) add(witness.row);
  return Array.from(references.values()).sort(
    (left, right) => left.ordinal - right.ordinal,
  );
}

function extendCommittedDigest(previous: string, rowDigest: string): string {
  return createHash('sha256').update(previous).update(rowDigest).digest('hex');
}

function indexChecksum(index: PersistedSparseIndex): string {
  return createHash('sha256').update(JSON.stringify(index)).digest('hex');
}

interface ActiveSidecar {
  version: 1;
  transcriptRevision: number;
  updatedAt: string;
  messages: PersistedChatMessage[];
  activeRowAnchors?: Map<string, ActiveRowAnchor>;
  finalizing?: {
    stagedId: string;
    byteOffset: number;
    messageIds: string[];
    explicitRevision?: unknown;
    child?: true;
    stagedByteLength?: number;
    stagedSha256?: string;
  };
}

function cloneActiveSidecar(sidecar: ActiveSidecar): ActiveSidecar {
  const cloned = structuredClone(sidecar);
  if (!sidecar.activeRowAnchors || sidecar.activeRowAnchors.size === 0) {
    delete cloned.activeRowAnchors;
    return cloned;
  }
  const anchors = new Map<string, ActiveRowAnchor>();
  for (const [id, anchor] of Array.from(sidecar.activeRowAnchors)) {
    const fresh: ActiveRowAnchor = {
      version: 1,
      runId: anchor.runId,
      after: anchor.after,
      tie: anchor.tie,
    };
    Object.freeze(fresh);
    anchors.set(id, fresh);
  }
  cloned.activeRowAnchors = anchors;
  return cloned;
}

type AppendBoundary =
  | 'prepared'
  | 'appended'
  | 'index-published'
  | 'survivors-published'
  | 'abandoned';

type ReplaceBoundary = 'active-sidecar-removed';

interface ChatTranscriptLogTestHooks {
  onReplaceBoundary?: (boundary: ReplaceBoundary) => Promise<void>;
}

interface ActiveSidecarHeaderV2 {
  version: 2;
  transcriptRevision: number;
  updatedAt: string;
  finalizing?: {
    stagedId: string;
    byteOffset: number;
    explicitRevision?: unknown;
    child?: true;
    messageIds?: string[];
    stagedByteLength?: number;
    stagedSha256?: string;
  };
}

function hasExactAppendRevisionMarker(
  marker: unknown,
  finalizing: NonNullable<ActiveSidecar['finalizing']>,
  transcriptRevision: number,
): boolean {
  return (
    isRecord(marker) &&
    typeof marker.stagedId === 'string' &&
    marker.stagedId === finalizing.stagedId &&
    typeof marker.byteOffset === 'number' &&
    Number.isSafeInteger(marker.byteOffset) &&
    marker.byteOffset === finalizing.byteOffset &&
    typeof marker.transcriptRevision === 'number' &&
    Number.isSafeInteger(marker.transcriptRevision) &&
    marker.transcriptRevision >= 0 &&
    marker.transcriptRevision === transcriptRevision
  );
}

interface ActiveSidecarMessageV2 {
  version: 2;
  kind: 'message';
  message: PersistedChatMessage;
  anchor?: unknown;
  finalizing?: true;
}

/** Derived snapshots are shared across log instances, but never with callers. */
class BoundedTranscriptSnapshotCache<T extends object> {
  private readonly entries = new Map<
    string,
    { identity: string; bytes: number; value: T }
  >();
  private retainedBytes = 0;

  public constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly maxEntryBytes: number,
    private readonly cloneValue: (value: T) => T = (value): T =>
      structuredClone(value),
  ) {}

  public get(path: string, identity: string): T | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    if (entry.identity !== identity) {
      this.delete(path);
      return undefined;
    }
    this.entries.delete(path);
    this.entries.set(path, entry);
    return this.cloneValue(entry.value);
  }

  public getProjected<U>(
    path: string,
    identity: string,
    project: (value: T) => U,
  ): { hit: false } | { hit: true; value: U } {
    const entry = this.entries.get(path);
    if (!entry) return { hit: false };
    if (entry.identity !== identity) {
      this.delete(path);
      return { hit: false };
    }
    this.entries.delete(path);
    this.entries.set(path, entry);
    return { hit: true, value: project(entry.value) };
  }

  public set(path: string, identity: string, bytes: number, value: T): void {
    this.delete(path);
    if (bytes > this.maxEntryBytes) return;
    this.entries.set(path, {
      identity,
      bytes,
      value: this.cloneValue(value),
    });
    this.retainedBytes += bytes;
    while (
      this.entries.size > this.maxEntries ||
      this.retainedBytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  public delete(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path);
    this.retainedBytes -= entry.bytes;
  }
}

interface CommittedRecentPage {
  messages: PersistedChatMessage[];
  latestHumanMessage?: PersistedChatMessage;
}

interface InFlightRecentCommittedPage {
  identity: string;
  promise: Promise<CommittedRecentPage | undefined>;
}

export interface ArtifactReferenceSlice {
  identity: string;
  nextOffset: number;
  complete: boolean;
  scannedBytes: number;
  artifactIds: string[];
  activeHeaderFinalizing?: boolean;
  activeFinalizingRows?: number;
}

const activeSnapshots = new BoundedTranscriptSnapshotCache<ActiveSidecar>(
  8,
  4 * 1024 * 1024,
  1024 * 1024,
  cloneActiveSidecar,
);
/**
 * Record anchors of each active sidecar this process last wrote or parsed,
 * keyed by its file identity. Writers that carry anchors forward use this
 * instead of re-parsing a sidecar that `activeSnapshots` no longer holds: that
 * cache is not refreshed on write and skips sidecars over 1 MiB.
 */
const knownActiveAnchors = new Map<
  string,
  { stamp: string; anchors: Map<string, ActiveRowAnchor> }
>();
const KNOWN_ACTIVE_ANCHOR_ENTRIES = 64;

function rememberActiveAnchors(
  path: string,
  stamp: string,
  anchors: ReadonlyMap<string, ActiveRowAnchor> | undefined,
): void {
  knownActiveAnchors.delete(path);
  knownActiveAnchors.set(path, { stamp, anchors: new Map(anchors ?? []) });
  while (knownActiveAnchors.size > KNOWN_ACTIVE_ANCHOR_ENTRIES) {
    const oldest = knownActiveAnchors.keys().next().value;
    if (oldest === undefined) break;
    knownActiveAnchors.delete(oldest);
  }
}

/** Best effort: a failed stat only costs the next writer a verified read. */
async function rememberWrittenActiveAnchors(
  path: string,
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
): Promise<void> {
  try {
    rememberActiveAnchors(path, (await fileIdentity(path)).stamp, anchors);
  } catch {
    knownActiveAnchors.delete(path);
  }
}

// Large recent pages are parsed once per transcript identity, not once per turn boundary.
const recentCommittedPages =
  new BoundedTranscriptSnapshotCache<CommittedRecentPage>(
    4,
    64 * 1024 * 1024,
    64 * 1024 * 1024,
  );
const inFlightRecentCommittedPages = new Map<
  string,
  InFlightRecentCommittedPage
>();
const MAX_MAINTENANCE_INDEX_BYTES = 1024 * 1024;
interface MaintenanceCommittedIndex extends Pick<
  TranscriptDescriptor,
  | 'format'
  | 'committedDigest'
  | 'committedMessageCount'
  | 'committedByteLength'
  | 'transcriptRevision'
  | 'hasActiveSidecar'
  | 'hasOrdinaryActiveRows'
  | 'messageCount'
  | 'userMessageCount'
  | 'firstMessageAt'
  | 'lastMessageAt'
> {
  committedDigest: string;
}
// Only fixed-size verified fields are retained; sparse offset arrays are not.
const maintenanceIndexCache = new Map<
  string,
  { stamp: string; index: MaintenanceCommittedIndex }
>();

interface CommittedAnchorMetadata {
  ordinal: number;
  runId?: string;
  isRunCard: boolean;
}

interface LogicalPlacementSnapshot {
  committedStamp: string;
  fingerprint: string;
  placement: LogicalPlacement<{ id: string }>;
  ranks: LogicalPlacementRanks;
  committedById: Map<string, CommittedAnchorMetadata>;
  estimatedBytes: number;
}

interface LogicalReadContext {
  committedStamp: string;
  fingerprint: string;
  placement: LogicalPlacement<{ id: string }>;
  ranks: LogicalPlacementRanks;
  committedById: Map<string, CommittedAnchorMetadata>;
  anchoredActiveIds: ReadonlySet<string>;
  activeById: Map<string, PersistedChatMessage>;
  activeByRank: Map<number, PersistedChatMessage>;
  totalCount: number;
}

interface LogicalTurnSnapshot {
  committedStamp: string;
  fingerprint: string;
  contentFingerprint: string;
  turnIndex: TranscriptTurnIndex;
  estimatedBytes: number;
}

const logicalPlacementSnapshots = new Map<string, LogicalPlacementSnapshot>();
const logicalTurnSnapshots = new Map<string, LogicalTurnSnapshot>();
const MAX_LOGICAL_SNAPSHOT_CHATS = 8;
const MAX_LOGICAL_PLACEMENT_BYTES = 2 * 1024 * 1024;

type TranscriptTodoState = ReturnType<typeof foldTranscriptTodoState>;
/** The last committed row with an assistant preview, by committed identity. */
const committedPreviewOrdinals = new Map<
  string,
  { stamp: string; ordinal?: number }
>();
interface LogicalTodoOperation {
  ordinal: number;
  message: PersistedChatMessage;
}

/** Committed TODO operations only, cached once for each committed identity. */
const logicalTodoOperations = new Map<
  string,
  { stamp: string; operations: LogicalTodoOperation[] }
>();

function rememberLogicalSnapshot<T>(
  cache: Map<string, T>,
  path: string,
  value: T,
): void {
  cache.delete(path);
  cache.set(path, value);
  while (cache.size > MAX_LOGICAL_SNAPSHOT_CHATS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Whether folding this row can change the TODO aggregates. */
function affectsTodoState(message: PersistedChatMessage): boolean {
  const state = foldTranscriptTodoState({}, message);
  return state.todos !== undefined || state.taskTodos !== undefined;
}

/**
 * A bounded cache of committed rows selected for anchored pages and affected
 * turn rebuilds. It never retains active messages, and committed identity
 * includes inode, size, mtime, and ctime so same-size edits invalidate it.
 * One chat may retain at most 16 MiB and all chats together at most 32 MiB;
 * exceptionally large affected turns above that limit are streamed again.
 */
class BoundedLogicalCommittedRows {
  private readonly entries = new Map<
    string,
    {
      identity: string;
      rows: Map<number, PersistedChatMessage>;
      bytes: number;
    }
  >();
  private retainedBytes = 0;

  public get(
    path: string,
    identity: string,
    ordinal: number,
  ): PersistedChatMessage | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    if (entry.identity !== identity) {
      this.delete(path);
      return undefined;
    }
    const row = entry.rows.get(ordinal);
    if (!row) return undefined;
    this.entries.delete(path);
    this.entries.set(path, entry);
    return structuredClone(row);
  }

  public set(
    path: string,
    identity: string,
    ordinal: number,
    row: PersistedChatMessage,
  ): void {
    let entry = this.entries.get(path);
    if (entry?.identity !== identity) {
      this.delete(path);
      entry = undefined;
    }
    if (!entry) {
      entry = { identity, rows: new Map(), bytes: 0 };
      this.entries.set(path, entry);
    }
    const previous = entry.rows.get(ordinal);
    const serializedBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    const previousBytes = previous
      ? Buffer.byteLength(JSON.stringify(previous), 'utf8')
      : 0;
    if (
      serializedBytes > 16 * 1024 * 1024 ||
      entry.bytes - previousBytes + serializedBytes > 16 * 1024 * 1024
    )
      return;
    entry.rows.set(ordinal, structuredClone(row));
    entry.bytes += serializedBytes - previousBytes;
    this.retainedBytes += serializedBytes - previousBytes;
    this.entries.delete(path);
    this.entries.set(path, entry);
    while (
      this.entries.size > MAX_LOGICAL_SNAPSHOT_CHATS ||
      this.retainedBytes > 32 * 1024 * 1024
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  public delete(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path);
    this.retainedBytes -= entry.bytes;
  }
}

const logicalCommittedRows = new BoundedLogicalCommittedRows();

/** The committed rows one turn page read from the file, pending its identity check. */
interface TurnPageRowRead {
  path: string;
  /** Absent when the committed file could not be identified: nothing is reused or kept. */
  identity?: string;
  stamp?: string;
  rows: Map<number, Buffer>;
  spans: [number, number][];
  bytes: number;
}

const MAX_TURN_PAGE_ROW_BYTES = 16 * 1024 * 1024;

/**
 * The exact committed row bytes a turns-view page selected, by committed
 * identity (index digest and counts, plus the file's inode, size, mtime and
 * ctime), so reopening an unchanged chat does not rescan the sparse strides
 * around every selected row. A hit decodes and validates the retained bytes
 * the way the file read does, so each page still gets its own row objects.
 * `spans` are the ordinal ranges a file read parsed completely: a run is served
 * from here only when the range it would scan was already parsed under this
 * identity, so it cannot skip a row the file read would have rejected. One
 * chat may retain at most 16 MiB and all chats together at most 32 MiB; a page
 * above that is read from the file every time. Any change to the committed
 * file changes its identity, so the first page after a commit reads the file.
 */
class BoundedTurnPageRowBytes {
  private readonly entries = new Map<
    string,
    {
      identity: string;
      rows: Map<number, Buffer>;
      spans: [number, number][];
      bytes: number;
    }
  >();
  private retainedBytes = 0;

  public get(
    path: string,
    identity: string,
  ):
    | {
        rows: ReadonlyMap<number, Buffer>;
        spans: readonly (readonly [number, number])[];
      }
    | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    if (entry.identity !== identity) {
      this.delete(path);
      return undefined;
    }
    this.entries.delete(path);
    this.entries.set(path, entry);
    return entry;
  }

  public add(
    path: string,
    identity: string,
    rows: ReadonlyMap<number, Buffer>,
    spans: readonly (readonly [number, number])[],
  ): void {
    let entry = this.entries.get(path);
    if (entry?.identity !== identity) {
      this.delete(path);
      entry = undefined;
    }
    let added = 0;
    rows.forEach((bytes, ordinal): void => {
      if (!entry?.rows.has(ordinal)) added += bytes.length;
    });
    if (entry && entry.bytes + added > MAX_TURN_PAGE_ROW_BYTES) {
      // Keep the page just read instead of an older one for the same file.
      this.delete(path);
      entry = undefined;
      added = 0;
      rows.forEach((bytes): void => {
        added += bytes.length;
      });
    }
    if (added > MAX_TURN_PAGE_ROW_BYTES) return;
    if (!entry) {
      entry = { identity, rows: new Map(), spans: [], bytes: 0 };
      this.entries.set(path, entry);
    }
    const retained = entry.rows;
    rows.forEach((bytes, ordinal): void => {
      if (!retained.has(ordinal)) retained.set(ordinal, bytes);
    });
    const parsed = entry.spans;
    for (const [from, to] of spans)
      if (!parsed.some(([start, end]) => start <= from && to <= end))
        parsed.push([from, to]);
    entry.bytes += added;
    this.retainedBytes += added;
    this.entries.delete(path);
    this.entries.set(path, entry);
    while (
      this.entries.size > MAX_LOGICAL_SNAPSHOT_CHATS ||
      this.retainedBytes > 32 * 1024 * 1024
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  public delete(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path);
    this.retainedBytes -= entry.bytes;
  }
}

const turnPageRowBytes = new BoundedTurnPageRowBytes();

function fileStatStamp(info: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

async function fileIdentity(
  path: string,
): Promise<{ stamp: string; bytes: number }> {
  const info = await stat(path, { bigint: true });
  return {
    stamp: fileStatStamp(info),
    bytes: Number(info.size),
  };
}

function isActiveSidecar(value: unknown): value is ActiveSidecar {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Number.isSafeInteger(value.transcriptRevision) &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.every(isPersistedChatMessage) &&
    (value.finalizing === undefined ||
      (isRecord(value.finalizing) &&
        typeof value.finalizing.stagedId === 'string' &&
        Number.isSafeInteger(value.finalizing.byteOffset) &&
        Array.isArray(value.finalizing.messageIds) &&
        value.finalizing.messageIds.every((id) => typeof id === 'string') &&
        (value.finalizing.child === undefined ||
          value.finalizing.child === true) &&
        (value.finalizing.stagedByteLength === undefined ||
          Number.isSafeInteger(value.finalizing.stagedByteLength)) &&
        (value.finalizing.stagedSha256 === undefined ||
          (typeof value.finalizing.stagedSha256 === 'string' &&
            /^[a-f0-9]{64}$/.test(value.finalizing.stagedSha256)))))
  );
}

function isActiveSidecarHeaderV2(
  value: unknown,
): value is ActiveSidecarHeaderV2 {
  return (
    isRecord(value) &&
    value.version === 2 &&
    Number.isSafeInteger(value.transcriptRevision) &&
    typeof value.updatedAt === 'string' &&
    (value.finalizing === undefined ||
      (isRecord(value.finalizing) &&
        typeof value.finalizing.stagedId === 'string' &&
        Number.isSafeInteger(value.finalizing.byteOffset) &&
        (value.finalizing.child === undefined ||
          (value.finalizing.child === true &&
            Array.isArray(value.finalizing.messageIds) &&
            value.finalizing.messageIds.every((id) => typeof id === 'string') &&
            Number.isSafeInteger(value.finalizing.stagedByteLength) &&
            typeof value.finalizing.stagedSha256 === 'string' &&
            /^[a-f0-9]{64}$/.test(value.finalizing.stagedSha256)))))
  );
}

function isActiveSidecarMessageV2(
  value: unknown,
): value is ActiveSidecarMessageV2 {
  return (
    isRecord(value) &&
    value.version === 2 &&
    value.kind === 'message' &&
    isPersistedChatMessage(value.message) &&
    (value.finalizing === undefined || value.finalizing === true)
  );
}

/** A present invalid anchor makes the v2 sidecar malformed, never absent. */
function parseSidecarRowAnchor(value: unknown): ActiveRowAnchor | undefined {
  const parsed = parseActiveRowAnchor(value);
  if (parsed.status === 'invalid')
    throw new Error(
      `Invalid active transcript sidecar anchor: ${parsed.reason}`,
    );
  return parsed.status === 'valid' ? parsed.anchor : undefined;
}

function copyActiveRowAnchors(
  anchors: ReadonlyMap<string, ActiveRowAnchor> | undefined,
): Map<string, ActiveRowAnchor> | undefined {
  if (anchors === undefined) return undefined;
  const decoded = decodeActiveRowAnchors(encodeActiveRowAnchors(anchors));
  if (decoded.status === 'invalid')
    throw new Error(`Invalid active row anchor map: ${decoded.reason}`);
  return decoded.anchors;
}

function hasDelegatedAgentCall(message: PersistedChatMessage): boolean {
  return message.blocks.some((block) => block.type === 'delegated_agent_call');
}

function runIdForActiveMessage(
  message: PersistedChatMessage | undefined,
): string | undefined {
  if (!message) return undefined;
  if (hasDelegatedAgentCall(message)) return message.id;
  return message.parentBlockId;
}

function survivingActiveRowAnchors(
  messages: readonly PersistedChatMessage[],
  ...anchorMaps: Array<ReadonlyMap<string, ActiveRowAnchor> | undefined>
): Map<string, ActiveRowAnchor> {
  if (anchorMaps.every((anchors) => !anchors || anchors.size === 0))
    return new Map<string, ActiveRowAnchor>();
  const activeIds = new Set(messages.map((message) => message.id));
  const merged = new Map<string, ActiveRowAnchor>();
  for (const anchors of anchorMaps)
    for (const [id, anchor] of Array.from(anchors ?? []))
      if (activeIds.has(id)) merged.set(id, anchor);
  return merged;
}

function sameActiveMessages(
  left: readonly PersistedChatMessage[],
  right: readonly PersistedChatMessage[],
): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => {
      const other = right[index];
      return other !== undefined && digest(message) === digest(other);
    })
  );
}

function sameActiveAnchors(
  left: ReadonlyMap<string, ActiveRowAnchor> | undefined,
  right: ReadonlyMap<string, ActiveRowAnchor>,
): boolean {
  const leftSize = left?.size ?? 0;
  if (leftSize !== right.size) return false;
  for (const [id, anchor] of Array.from(right)) {
    const other = left?.get(id);
    if (
      !other ||
      other.version !== anchor.version ||
      other.runId !== anchor.runId ||
      other.after !== anchor.after ||
      other.tie !== anchor.tie
    )
      return false;
  }
  return true;
}

function assertActiveSidecarRecordBudgets(
  messages: readonly PersistedChatMessage[],
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
  finalizingIds: ReadonlySet<string> = new Set(),
): void {
  if (anchors.size === 0) return;
  for (const message of messages) {
    const rowAnchor = anchors.get(message.id);
    if (rowAnchor === undefined) continue;
    const record: ActiveSidecarMessageRecord = {
      version: 2,
      kind: 'message',
      message,
      ...(rowAnchor === undefined ? {} : { anchor: rowAnchor }),
      ...(finalizingIds.has(message.id) ? { finalizing: true } : {}),
    };
    const budget = checkActiveSidecarMessageRecordBudget(record);
    if (!budget.withinLimit)
      throw new Error(
        `Active sidecar message record exceeds maximum size (${budget.bytes} of ${budget.ceiling} bytes)`,
      );
  }
}

/** A persisted index whose reducer frame is not yet validated. */
type PersistedSparseIndex = Omit<SparseIndex, 'reducerFrame'> & {
  reducerFrame?: unknown;
};

function isSparseIndexWithChecksum(
  value: unknown,
): value is PersistedSparseIndex & { checksum: string } {
  return (
    isRecord(value) &&
    value.version === 3 &&
    value.format === 'complete-message-jsonl-v1' &&
    typeof value.checksum === 'string' &&
    typeof value.committedDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.committedDigest) &&
    typeof value.committedMessageCount === 'number' &&
    Number.isSafeInteger(value.committedMessageCount) &&
    typeof value.committedByteLength === 'number' &&
    Number.isSafeInteger(value.committedByteLength) &&
    Number.isSafeInteger(value.transcriptRevision) &&
    typeof value.hasActiveSidecar === 'boolean' &&
    (value.hasOrdinaryActiveRows === undefined ||
      typeof value.hasOrdinaryActiveRows === 'boolean') &&
    (value.lastMessageRole === undefined ||
      value.lastMessageRole === 'user' ||
      value.lastMessageRole === 'assistant') &&
    Array.isArray(value.offsets) &&
    value.offsets.every(
      (entry) =>
        isRecord(entry) &&
        Number.isSafeInteger(entry.ordinal) &&
        Number.isSafeInteger(entry.offset),
    ) &&
    (value.latestHuman === undefined ||
      (isRecord(value.latestHuman) &&
        Number.isSafeInteger(value.latestHuman.ordinal) &&
        Number.isSafeInteger(value.latestHuman.offset)))
  );
}

/** Reference identity is its wire fields, not its in-memory object prototype. */
export function sameToolOutputReference(
  left: PersistedToolOutputReference,
  right: PersistedToolOutputReference,
): boolean {
  return (
    left.version === right.version &&
    left.artifactId === right.artifactId &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 &&
    left.encoding === right.encoding &&
    left.mediaType === right.mediaType
  );
}

function isSparseReducerFrameReference(
  value: unknown,
  messageCount: number,
  byteLength: number,
): value is SparseReducerFrameReference {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 512 &&
    typeof value.ordinal === 'number' &&
    Number.isSafeInteger(value.ordinal) &&
    value.ordinal >= 0 &&
    value.ordinal < messageCount &&
    typeof value.offset === 'number' &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0 &&
    value.offset < byteLength
  );
}

function isSortedReducerFrameReferences(
  references: readonly SparseReducerFrameReference[],
): boolean {
  for (let index = 1; index < references.length; index += 1) {
    const previous = references[index - 1];
    const current = references[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous.ordinal > current.ordinal ||
      previous.offset > current.offset
    )
      return false;
  }
  return true;
}

function isSparseReducerFrame(
  value: unknown,
  messageCount: number,
  byteLength: number,
): value is SparseReducerFrame {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.messageCount !== messageCount ||
    !Array.isArray(value.timers) ||
    value.timers.length > MAX_REDUCER_FRAME_TIMER_ROWS ||
    !Array.isArray(value.cards) ||
    value.cards.length > MAX_REDUCER_FRAME_CARD_ROWS ||
    !Array.isArray(value.toolUses) ||
    value.toolUses.length > MAX_REDUCER_FRAME_TOOL_ROWS ||
    !Array.isArray(value.pendingResults) ||
    value.pendingResults.length > MAX_REDUCER_FRAME_PENDING_RESULTS ||
    (value.boundary !== undefined &&
      !isSparseReducerFrameReference(value.boundary, messageCount, byteLength))
  )
    return false;

  const boundaryOrdinal = isSparseReducerFrameReference(
    value.boundary,
    messageCount,
    byteLength,
  )
    ? value.boundary.ordinal
    : 0;
  const isReference = (
    reference: unknown,
  ): reference is SparseReducerFrameReference =>
    isSparseReducerFrameReference(reference, messageCount, byteLength) &&
    reference.ordinal >= boundaryOrdinal;
  const timers = value.timers;
  // The first timer may be the one foldReducerFrame carries across the boundary.
  if (
    !timers.every((timer: unknown, index: number) =>
      index === 0
        ? isSparseReducerFrameReference(timer, messageCount, byteLength)
        : isReference(timer),
    ) ||
    !isSortedReducerFrameReferences(timers)
  )
    return false;

  const cardRows: SparseReducerFrameReference[] = [];
  for (const entry of value.cards) {
    if (
      !isRecord(entry) ||
      typeof entry.carriesToolUses !== 'boolean' ||
      !isReference(entry.row)
    )
      return false;
    cardRows.push(entry.row);
  }
  if (!isSortedReducerFrameReferences(cardRows)) return false;

  const toolRows: SparseReducerFrameReference[] = [];
  let toolIdCount = 0;
  for (const entry of value.toolUses) {
    if (
      !isRecord(entry) ||
      !isReference(entry.row) ||
      !Array.isArray(entry.toolUseIds) ||
      entry.toolUseIds.length === 0 ||
      entry.toolUseIds.length > MAX_REDUCER_FRAME_TOOL_IDS_PER_ROW ||
      !entry.toolUseIds.every(
        (id: unknown) =>
          typeof id === 'string' && id.length > 0 && id.length <= 512,
      ) ||
      new Set(entry.toolUseIds).size !== entry.toolUseIds.length ||
      !Array.isArray(entry.resultWitnesses) ||
      entry.resultWitnesses.length > entry.toolUseIds.length
    )
      return false;
    toolIdCount += entry.toolUseIds.length;
    const witnessedIds = new Set<string>();
    for (const witness of entry.resultWitnesses) {
      if (
        !isRecord(witness) ||
        typeof witness.toolUseId !== 'string' ||
        !entry.toolUseIds.includes(witness.toolUseId) ||
        witnessedIds.has(witness.toolUseId) ||
        !isReference(witness.row)
      )
        return false;
      witnessedIds.add(witness.toolUseId);
    }
    toolRows.push(entry.row);
  }
  if (
    toolIdCount > MAX_REDUCER_FRAME_TOOL_IDS ||
    !isSortedReducerFrameReferences(toolRows)
  )
    return false;

  const pendingRows: SparseReducerFrameReference[] = [];
  const pendingIds = new Set<string>();
  for (const witness of value.pendingResults) {
    if (
      !isRecord(witness) ||
      typeof witness.toolUseId !== 'string' ||
      witness.toolUseId.length === 0 ||
      witness.toolUseId.length > 512 ||
      pendingIds.has(witness.toolUseId) ||
      !isReference(witness.row)
    )
      return false;
    pendingIds.add(witness.toolUseId);
    pendingRows.push(witness.row);
  }
  return isSortedReducerFrameReferences(pendingRows);
}

function messageOwnsToolOutput(
  message: PersistedChatMessage,
  messageId: string,
  toolUseId: string,
  reference: PersistedToolOutputReference,
): boolean {
  return (
    message.id === messageId &&
    message.blocks.some(
      (block) =>
        block.type === 'tool_result' &&
        block.toolUseId === toolUseId &&
        block.fullOutputRef !== undefined &&
        sameToolOutputReference(block.fullOutputRef, reference),
    )
  );
}

function blockOwnsToolOutput(
  block: PersistedChatBlock,
  toolUseId: string,
  reference: PersistedToolOutputReference,
): boolean {
  return (
    block.type === 'tool_result' &&
    block.toolUseId === toolUseId &&
    block.fullOutputRef !== undefined &&
    sameToolOutputReference(block.fullOutputRef, reference)
  );
}

async function pagedMessageOwnsToolOutput(
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  message: PersistedChatMessage,
  messageId: string,
  toolUseId: string,
  reference: PersistedToolOutputReference,
): Promise<boolean> {
  if (message.id !== messageId) return false;
  for await (const block of artifacts.iterateBlocks(chatId, message)) {
    if (blockOwnsToolOutput(block, toolUseId, reference)) return true;
  }
  return false;
}

function inlineBodyEncoding(text: string): 'utf8' | 'utf16le' {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    text,
  )
    ? 'utf16le'
    : 'utf8';
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

export function readInlineBodyRange(
  text: string,
  offset: number,
  limit: number,
): {
  text: string;
  nextOffset?: number;
  byteLength: number;
  encoding: 'utf8' | 'utf16le';
} {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 4 ||
    limit > 65_536
  )
    throw new Error('Invalid transcript content range');
  const encoding = inlineBodyEncoding(text);
  const bytes = Buffer.from(text, encoding === 'utf8' ? 'utf8' : 'utf16le');
  if (offset > bytes.length)
    throw new Error('Invalid transcript content range');
  if (encoding === 'utf8') {
    if (isUtf8ContinuationByte(bytes[offset]))
      throw new Error('Transcript content offset splits a UTF-8 character');
  } else {
    if (offset % 2 !== 0)
      throw new Error('Transcript content offset splits a UTF-16 code unit');
    if (
      offset >= 2 &&
      offset < bytes.length &&
      bytes.readUInt16LE(offset - 2) >= 0xd800 &&
      bytes.readUInt16LE(offset - 2) <= 0xdbff &&
      bytes.readUInt16LE(offset) >= 0xdc00 &&
      bytes.readUInt16LE(offset) <= 0xdfff
    )
      throw new Error('Transcript content offset splits a UTF-16 code unit');
  }

  let end = Math.min(offset + limit, bytes.length);
  if (encoding === 'utf8') {
    while (
      end > offset &&
      end < bytes.length &&
      isUtf8ContinuationByte(bytes[end])
    )
      end -= 1;
  } else {
    end -= (end - offset) % 2;
    if (
      end - offset >= 2 &&
      end < bytes.length &&
      bytes.readUInt16LE(end - 2) >= 0xd800 &&
      bytes.readUInt16LE(end - 2) <= 0xdbff &&
      bytes.readUInt16LE(end) >= 0xdc00 &&
      bytes.readUInt16LE(end) <= 0xdfff
    )
      end -= 2;
  }
  const slice = bytes.subarray(offset, end);
  return {
    text: slice.toString(encoding === 'utf8' ? 'utf8' : 'utf16le'),
    byteLength: bytes.length,
    encoding,
    ...(end < bytes.length ? { nextOffset: end } : {}),
  };
}

export function inlineBodyField(
  block: PersistedChatBlock,
  field: TranscriptBodyField,
): string | undefined {
  if (field === 'output' && block.type === 'tool_result') return block.output;
  if (field === 'input' && block.type === 'tool_use') return block.input;
  if (field === 'text' && (block.type === 'text' || block.type === 'thinking'))
    return block.text;
  if (field === 'partialText' && block.type === 'delegated_agent_call')
    return block.partialText;
  if (field === 'finalText' && block.type === 'delegated_agent_call')
    return block.finalText;
  return undefined;
}

/** Resolve the selected canonical block, never a caller-supplied reference. */
async function ownedBodyBlock(
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  message: PersistedChatMessage,
  selector: { blockOrdinal: number; field: TranscriptBodyField },
  signal?: AbortSignal,
): Promise<PersistedChatBlock | undefined> {
  if (message.blocksRef === undefined)
    return message.blocks[selector.blockOrdinal];
  const [block] = await artifacts.readBlocks(
    chatId,
    message,
    selector.blockOrdinal,
    1,
    signal,
  );
  return block;
}

function messageOwnsVisual(
  message: PersistedChatMessage,
  messageId: string,
  toolUseId: string,
  reference: PersistedVisualReference,
): boolean {
  if (message.id !== messageId) return false;
  return message.blocks.some((block) => {
    if (block.type !== 'tool_result' || block.toolUseId !== toolUseId)
      return false;
    const visual = block.visualRef;
    if (!visual) return false;
    const heightsEqual =
      visual.heights === undefined || reference.heights === undefined
        ? visual.heights === reference.heights
        : visual.heights.length === reference.heights.length &&
          visual.heights.every(
            (pair, index) =>
              pair[0] === reference.heights?.[index]?.[0] &&
              pair[1] === reference.heights?.[index]?.[1],
          );
    return (
      visual.version === reference.version &&
      visual.visualId === reference.visualId &&
      visual.artifactId === reference.artifactId &&
      visual.byteLength === reference.byteLength &&
      visual.sha256 === reference.sha256 &&
      visual.mediaType === reference.mediaType &&
      visual.title === reference.title &&
      visual.maxHeight === reference.maxHeight &&
      heightsEqual
    );
  });
}

interface LoadedLog {
  index: SparseIndex;
  locatorStamp: string;
  locatorsComplete: boolean;
  committedLocatorKeys?: Set<string>;
  committedLocatorInventoryUnavailable?: boolean;
  committedLocatorInventoryBuild?: Promise<Set<string> | undefined>;
  /**
   * Active row ids a read found absent from the committed history whose
   * digest is `committedDigest`, with locators as of `locatorStamp`, so
   * later reads need not probe them again.
   */
  uncommitted?: {
    committedDigest: string;
    locatorStamp: string;
    ids: Set<string>;
  };
}

interface CommittedMessageStateReader {
  committedMessageState(
    message: PersistedChatMessage,
  ): Promise<'absent' | 'identical' | 'different'>;
  hasCommittedMessage(messageId: string): Promise<boolean>;
}

/**
 * Chats whose indexes one log keeps loaded. Every commit of a scope reads
 * each chat its delta journal holds, so this must exceed the chats that
 * stream at once in one worktree; an entry is a sparse index, not rows.
 */
const MAX_LOADED_LOGS = 64;

interface MessageLocator {
  version: 1;
  messageId: string;
  offset: number;
  end: number;
  digest: string;
}

/** Derived indexes are bounded writes; the JSONL is the durable authority. */
async function flushLocatorBatch(
  batch: Array<{ path: string; locator: MessageLocator }>,
): Promise<void> {
  const results = await Promise.allSettled(
    batch.map(({ path, locator }) => {
      const text = JSON.stringify(locator);
      return writeFile(path, text, {
        mode: 0o600,
        flag: 'wx',
      }).then(() => {
        recordChatStorageFileWrite(path, Buffer.byteLength(text), true);
      });
    }),
  );
  batch.length = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') continue;
    if (isErrnoException(result.reason) && result.reason.code === 'EEXIST')
      throw new Error('Invalid or duplicate committed message');
    throw result.reason;
  }
}

function isMessageLocator(value: unknown): value is MessageLocator {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.messageId === 'string' &&
    typeof value.offset === 'number' &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0 &&
    typeof value.end === 'number' &&
    Number.isSafeInteger(value.end) &&
    value.end > value.offset &&
    typeof value.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.digest)
  );
}

function assistantPreview(message: PersistedChatMessage): string | undefined {
  if (message.role !== 'assistant') return undefined;
  let text = '';
  for (const block of message.blocks) {
    if (block.type === 'text')
      text += (text ? ' ' : '') + block.text.slice(0, 201 - text.length);
    if (text.length >= 201) break;
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized
    ? normalized.length > 200
      ? normalized.slice(0, 200) + '...'
      : normalized
    : undefined;
}

function digest(message: PersistedChatMessage): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk))
      throw new Error('Staged append must contain bytes');
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  let renamed = false;
  try {
    await writeJsonValuesCooperatively(temporary, [value], { pretty: false });
    await rename(temporary, path);
    renamed = true;
    recordChatStorageAtomicReplacement(path);
    await fsyncDirectory(dirname(path));
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

async function writeActiveSidecar(
  path: string,
  sidecar: ActiveSidecar,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const finalizing = new Set(sidecar.finalizing?.messageIds ?? []);
  const anchorTuples = encodeActiveRowAnchors(
    sidecar.activeRowAnchors ?? new Map<string, ActiveRowAnchor>(),
  );
  const anchors = new Map(anchorTuples);
  const header: ActiveSidecarHeaderV2 = {
    version: 2,
    transcriptRevision: sidecar.transcriptRevision,
    updatedAt: sidecar.updatedAt,
    ...(sidecar.finalizing
      ? {
          finalizing: {
            stagedId: sidecar.finalizing.stagedId,
            byteOffset: sidecar.finalizing.byteOffset,
            ...(sidecar.finalizing.explicitRevision !== undefined
              ? { explicitRevision: sidecar.finalizing.explicitRevision }
              : {}),
            ...(sidecar.finalizing.child
              ? {
                  child: sidecar.finalizing.child,
                  messageIds: sidecar.finalizing.messageIds,
                  stagedByteLength: sidecar.finalizing.stagedByteLength,
                  stagedSha256: sidecar.finalizing.stagedSha256,
                }
              : {}),
          },
        }
      : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  let renamed = false;
  try {
    await writeJsonValuesCooperatively(
      temporary,
      (function* (): Generator<ActiveSidecarHeaderV2 | ActiveSidecarMessageV2> {
        yield header;
        for (const message of sidecar.messages) {
          assertTranscriptRowWithinLimit(message);
          const rowAnchor = anchors.get(message.id);
          const record: ActiveSidecarMessageRecord = {
            version: 2,
            kind: 'message',
            message,
            ...(rowAnchor === undefined ? {} : { anchor: rowAnchor }),
            ...(finalizing.has(message.id) ? { finalizing: true } : {}),
          };
          if (rowAnchor !== undefined) {
            const budget = checkActiveSidecarMessageRecordBudget(record);
            if (!budget.withinLimit)
              throw new Error(
                `Active sidecar message record exceeds maximum size (${budget.bytes} of ${budget.ceiling} bytes)`,
              );
          }
          // An unanchored message is already bounded to MAX_TRANSCRIPT_ROW_BYTES;
          // the fixed v2 record wrapper (including finalizing) is well within
          // the reader's additional 1024-byte allowance.
          yield record;
        }
      })(),
      { pretty: false, separator: '\n', trailingSeparator: true },
    );
    await rename(temporary, path);
    renamed = true;
    recordChatStorageAtomicReplacement(path);
    await fsyncDirectory(dirname(path));
    await rememberWrittenActiveAnchors(path, anchors);
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

/** Active sidecars use one bounded JSON value per line. */
async function* activeRowsWithOffsets(
  path: string,
  start = 0,
): AsyncGenerator<{ value: unknown; offset: number; end: number }> {
  yield* activeRowsFromChunks(createReadStream(path, { start }), start);
}

async function* activeRowsFromChunks(
  chunks: AsyncIterable<Buffer>,
  start = 0,
): AsyncGenerator<{ value: unknown; offset: number; end: number }> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending: Buffer[] = [];
  let length = 0;
  let offset = start;
  for await (const raw of chunks) {
    if (!Buffer.isBuffer(raw))
      throw new Error('Active transcript stream must contain bytes');
    let begin = 0;
    for (let i = raw.indexOf(10, begin); i !== -1; i = raw.indexOf(10, begin)) {
      const segment = raw.subarray(begin, i);
      if (length + segment.length > MAX_TRANSCRIPT_ROW_BYTES + 1024)
        throw new Error('Active transcript row exceeds maximum size');
      const bytes = pending.length
        ? Buffer.concat([...pending, segment], length + segment.length)
        : segment;
      const end = offset + bytes.length + 1;
      if (bytes.length > 0)
        yield { value: JSON.parse(decoder.decode(bytes)), offset, end };
      offset = end;
      begin = i + 1;
      pending = [];
      length = 0;
    }
    if (begin < raw.length) {
      const segment = raw.subarray(begin);
      if (length + segment.length > MAX_TRANSCRIPT_ROW_BYTES + 1024)
        throw new Error('Active transcript row exceeds maximum size');
      pending.push(segment);
      length += segment.length;
    }
  }
  if (length > 0) throw new Error('Incomplete active transcript row');
}

async function* activeRows(path: string): AsyncGenerator<unknown> {
  for await (const row of activeRowsWithOffsets(path)) yield row.value;
}

/** Stream the previous object-and-array format during rolling upgrades. */
async function readLegacyActiveSidecar(path: string): Promise<ActiveSidecar> {
  return readLegacyActiveSidecarFromChunks(
    createReadStream(path, { encoding: 'utf8' }),
  );
}

async function readLegacyActiveSidecarFromChunks(
  chunks: AsyncIterable<string>,
): Promise<ActiveSidecar> {
  const messagesMarker = '"messages":[';
  const messageIdsMarker = '"messageIds":[';
  let stage: 'header' | 'messages' | 'tail' | 'messageIds' | 'suffix' =
    'header';
  let header = '';
  let tail = '';
  let suffix = '';
  let value = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let metadata:
    | Pick<ActiveSidecar, 'transcriptRevision' | 'updatedAt'>
    | undefined;
  let finalizing:
    | Pick<NonNullable<ActiveSidecar['finalizing']>, 'stagedId' | 'byteOffset'>
    | undefined;
  const messages: PersistedChatMessage[] = [];
  const messageIds: string[] = [];

  const parseHeader = (): void => {
    const parsed: unknown = JSON.parse(
      header.slice(0, -messagesMarker.length) + '"messages":[]}',
    );
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.transcriptRevision !== 'number' ||
      !Number.isSafeInteger(parsed.transcriptRevision) ||
      typeof parsed.updatedAt !== 'string'
    )
      throw new Error('Invalid active transcript sidecar');
    metadata = {
      transcriptRevision: parsed.transcriptRevision,
      updatedAt: parsed.updatedAt,
    };
  };
  const parseTail = (): void => {
    const beforeMarker = tail.slice(0, -messageIdsMarker.length);
    const parsed: unknown = JSON.parse(
      `{"messages":[]${beforeMarker}"messageIds":[]}}`,
    );
    if (
      !isRecord(parsed) ||
      !isRecord(parsed.finalizing) ||
      typeof parsed.finalizing.stagedId !== 'string' ||
      typeof parsed.finalizing.byteOffset !== 'number' ||
      !Number.isSafeInteger(parsed.finalizing.byteOffset)
    )
      throw new Error('Invalid active transcript sidecar');
    finalizing = {
      stagedId: parsed.finalizing.stagedId,
      byteOffset: parsed.finalizing.byteOffset,
    };
  };
  const finishMessage = (): void => {
    const parsed: unknown = JSON.parse(value);
    if (!isPersistedChatMessage(parsed))
      throw new Error('Invalid active transcript message');
    assertTranscriptRowWithinLimit(parsed);
    messages.push(parsed);
    value = '';
  };
  const finishMessageId = (): void => {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'string')
      throw new Error('Invalid active transcript message id');
    messageIds.push(parsed);
    value = '';
  };

  for await (const raw of chunks) {
    const chunk = String(raw);
    for (const character of chunk) {
      if (stage === 'header') {
        header += character;
        if (header.length > 65_536)
          throw new Error('Active transcript header exceeds maximum size');
        if (header.endsWith(messagesMarker)) {
          parseHeader();
          stage = 'messages';
        }
        continue;
      }
      if (stage === 'messages') {
        if (depth === 0) {
          if (/\s|,/.test(character)) continue;
          if (character === ']') {
            stage = 'tail';
            continue;
          }
          if (character !== '{')
            throw new Error('Invalid active transcript message array');
          value = character;
          depth = 1;
          inString = false;
          escaped = false;
          continue;
        }
        value += character;
        if (value.length > MAX_TRANSCRIPT_ROW_BYTES)
          throw new Error('Active transcript row exceeds maximum size');
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
        } else if (character === '"') inString = true;
        else if (character === '{' || character === '[') depth += 1;
        else if (character === '}' || character === ']') {
          depth -= 1;
          if (depth === 0) finishMessage();
        }
        continue;
      }
      if (stage === 'tail') {
        tail += character;
        if (tail.length > 65_536)
          throw new Error('Active transcript metadata exceeds maximum size');
        if (tail.endsWith(messageIdsMarker)) {
          parseTail();
          stage = 'messageIds';
        }
        continue;
      }
      if (stage === 'messageIds') {
        if (!inString) {
          if (/\s|,/.test(character)) continue;
          if (character === ']') {
            stage = 'suffix';
            continue;
          }
          if (character !== '"')
            throw new Error('Invalid active transcript message id array');
          value = character;
          inString = true;
          escaped = false;
          continue;
        }
        value += character;
        if (value.length > MAX_TRANSCRIPT_ROW_BYTES)
          throw new Error('Active transcript message id exceeds maximum size');
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') {
          inString = false;
          finishMessageId();
        }
        continue;
      }
      suffix += character;
      if (suffix.length > 16)
        throw new Error('Invalid active transcript sidecar suffix');
    }
  }
  if (!metadata || stage === 'header' || stage === 'messages')
    throw new Error('Invalid active transcript sidecar');
  if (stage === 'messageIds' || inString)
    throw new Error('Incomplete active transcript sidecar');
  if (stage === 'tail') {
    if (tail.trim() !== '}')
      throw new Error('Invalid active transcript sidecar');
  } else if (!finalizing || suffix.trim() !== '}}') {
    throw new Error('Invalid active transcript sidecar');
  }
  return {
    version: 1,
    ...metadata,
    messages,
    ...(finalizing ? { finalizing: { ...finalizing, messageIds } } : {}),
  };
}

/** Streaming line traversal; keeps only the current complete-message row in memory. */
async function* lines(
  path: string,
  start = 0,
): AsyncGenerator<{
  message: PersistedChatMessage;
  offset: number;
  end: number;
  bytes: Buffer;
}> {
  yield* linesFromChunks(createReadStream(path, { start }), start);
}

/** One complete committed row: strict UTF-8, JSON, and the persisted message shape. */
function decodeTranscriptRow(
  bytes: Buffer,
  decoder: TextDecoder,
): PersistedChatMessage {
  const parsed: unknown = JSON.parse(decoder.decode(bytes));
  if (!isPersistedChatMessage(parsed))
    throw new Error('Invalid complete transcript message');
  return parsed;
}

async function* linesFromChunks(
  chunks: AsyncIterable<Buffer>,
  start = 0,
): AsyncGenerator<{
  message: PersistedChatMessage;
  offset: number;
  end: number;
  bytes: Buffer;
}> {
  let offset = start;
  let pending: Buffer[] = [];
  let length = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const raw of chunks) {
    if (!Buffer.isBuffer(raw))
      throw new Error('Transcript stream must contain bytes');
    const chunk = raw;
    let begin = 0;
    // Native delimiter scanning keeps large tool/message rows off the JS
    // byte-by-byte hot path. Decode only complete rows, with strict UTF-8.
    for (
      let i = chunk.indexOf(10, begin);
      i !== -1;
      i = chunk.indexOf(10, begin)
    ) {
      const segment = chunk.subarray(begin, i);
      if (length + segment.length > MAX_TRANSCRIPT_ROW_BYTES)
        throw new Error('Transcript row exceeds maximum size');
      const bytes = pending.length
        ? Buffer.concat([...pending, segment], length + segment.length)
        : segment;
      const message = decodeTranscriptRow(bytes, decoder);
      const end = offset + bytes.length + 1;
      yield { message, offset, end, bytes };
      offset = end;
      begin = i + 1;
      pending = [];
      length = 0;
    }
    if (begin < chunk.length) {
      const segment = chunk.subarray(begin);
      if (length + segment.length > MAX_TRANSCRIPT_ROW_BYTES)
        throw new Error('Transcript row exceeds maximum size');
      pending.push(segment);
      length += segment.length;
    }
  }
  // A partial tail is preserved. Explicit recovery must reconcile it with the
  // active projection/transaction before it can truncate or acknowledge data.
  if (length > 0)
    throw new Error(`Incomplete transcript tail at byte ${offset}`);
}

interface CapturedPreviewFile {
  handle: FileHandle;
  size: number;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

async function capturedPreviewFile(
  handle: FileHandle,
): Promise<CapturedPreviewFile> {
  const info = await handle.stat({ bigint: true });
  const size = Number(info.size);
  if (!Number.isSafeInteger(size) || size < 0)
    throw new ChatTranscriptIntegrityError(
      'Transcript preview file is too large',
    );
  return {
    handle,
    size,
    dev: info.dev,
    ino: info.ino,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

async function assertCapturedPreviewFileUnchanged(
  file: CapturedPreviewFile,
  allowAppend = false,
): Promise<void> {
  const info = await file.handle.stat({ bigint: true });
  const grewByAppend = allowAppend && info.size > BigInt(file.size);
  if (
    info.dev !== file.dev ||
    info.ino !== file.ino ||
    (info.size !== BigInt(file.size) && !grewByAppend) ||
    (info.mtimeNs !== file.mtimeNs && !grewByAppend) ||
    // Atomic replacement may unlink the old inode. Its bytes remain a valid
    // captured snapshot; an in-place edit on a linked inode does not.
    (info.nlink > BigInt(0) && info.ctimeNs !== file.ctimeNs && !grewByAppend)
  )
    throw new ChatTranscriptIntegrityError(
      'Transcript preview changed during read',
    );
}

async function* capturedPreviewChunks(
  file: CapturedPreviewFile,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  let offset = 0;
  while (offset < file.size) {
    if (signal.aborted) throw new Error('Transcript preview aborted');
    const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, file.size - offset));
    const { bytesRead } = await file.handle.read(
      bytes,
      0,
      bytes.length,
      offset,
    );
    if (signal.aborted) throw new Error('Transcript preview aborted');
    if (bytesRead === 0)
      throw new ChatTranscriptIntegrityError(
        'Transcript preview was truncated',
      );
    offset += bytesRead;
    yield bytes.subarray(0, bytesRead);
  }
}

async function* capturedPreviewTextChunks(
  file: CapturedPreviewFile,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of capturedPreviewChunks(file, signal))
    yield decoder.decode(chunk, { stream: true });
  const tail = decoder.decode();
  if (tail) yield tail;
}

/**
 * The active rows of a chat that a delta journal holds ahead of its files:
 * exactly what the active sidecar holds once a checkpoint writes it, and the
 * transcript revision the log's index then carries.
 */
export interface TranscriptActiveProjection {
  messages: readonly PersistedChatMessage[];
  transcriptRevision: number;
  anchors?: ReadonlyMap<string, ActiveRowAnchor>;
}

/**
 * Supplies a chat's journaled active rows to the read paths. Write paths
 * always use the files: a checkpoint applies the journal to them.
 */
export type TranscriptActiveProjectionSource = (
  chatId: string,
) => TranscriptActiveProjection | undefined;

/**
 * Immutable file handles captured under the repository scope lease. Search
 * deliberately preserves physical committed-row order and active storage
 * order: its index consumes those as two separate bodies. Logical anchoring
 * belongs to the explicit transcript read projection, not this search input.
 */
export interface PinnedCommittedTranscript {
  fd: number;
  size: number;
  count: number;
  digest: string;
}

/** Read-only thread reader. The host owns this descriptor until the thread exits. */
export async function* readPinnedCommittedTranscript(
  input: PinnedCommittedTranscript,
  deadline: number,
): AsyncGenerator<PersistedChatMessage> {
  let count = 0;
  let committedDigest = EMPTY_COMMITTED_DIGEST;
  async function* chunks(): AsyncGenerator<Buffer> {
    for (let offset = 0; offset < input.size; ) {
      if (Date.now() >= deadline)
        throw new Error('Chat learning deadline exceeded');
      const bytes = Buffer.allocUnsafe(
        Math.min(64 * 1024, input.size - offset),
      );
      const read = readSync(input.fd, bytes, 0, bytes.length, offset);
      if (!read) throw new Error('Chat learning transcript truncated');
      offset += read;
      yield await Promise.resolve(bytes.subarray(0, read));
    }
  }
  for await (const row of linesFromChunks(chunks())) {
    if (++count > input.count)
      throw new Error('Chat learning transcript count mismatch');
    committedDigest = extendCommittedDigest(
      committedDigest,
      digest(row.message),
    );
    yield row.message;
  }
  if (count !== input.count || committedDigest !== input.digest)
    throw new Error('Chat learning transcript digest mismatch');
}

export class CapturedTranscriptPreview {
  private readonly controller = new AbortController();
  private closePromise?: Promise<void>;
  private threadConsumption?: Promise<unknown>;
  private consumed = false;
  private complete = false;
  private readonly authority: TranscriptDescriptor;
  private readonly projectedActive?: readonly PersistedChatMessage[];

  public constructor(
    descriptor: TranscriptDescriptor,
    private readonly committed: CapturedPreviewFile,
    private readonly active?: CapturedPreviewFile,
    /** Journaled active rows; the active sidecar file is then not read. */
    projectedActive?: readonly PersistedChatMessage[],
  ) {
    this.authority = structuredClone(descriptor);
    if (projectedActive)
      this.projectedActive = structuredClone(projectedActive);
  }

  public get descriptor(): TranscriptDescriptor {
    return structuredClone(this.authority);
  }

  /** The active rows come from a delta journal's projection, not the sidecar. */
  public get journalProjected(): boolean {
    return this.projectedActive !== undefined;
  }

  public async *messages(): AsyncGenerator<PersistedChatMessage> {
    if (this.consumed)
      throw new Error('Transcript preview was already consumed');
    this.consumed = true;
    if (this.controller.signal.aborted)
      throw new Error('Transcript preview aborted');
    let count = 0;
    let committedDigest = EMPTY_COMMITTED_DIGEST;
    for await (const row of linesFromChunks(
      capturedPreviewChunks(this.committed, this.controller.signal),
    )) {
      count += 1;
      committedDigest = extendCommittedDigest(
        committedDigest,
        digest(row.message),
      );
      yield row.message;
    }
    if (
      count !== this.authority.committedMessageCount ||
      committedDigest !== this.authority.committedDigest ||
      this.committed.size !== this.authority.committedByteLength
    )
      throw new ChatTranscriptIntegrityError(
        'Transcript preview committed prefix mismatch',
      );
    await assertCapturedPreviewFileUnchanged(this.committed, true);
    yield* this.readActiveRows();
  }

  /**
   * Yields only the active sidecar when the consumer already holds a
   * projection of this exact committed prefix: the captured descriptor's
   * count, byte length, and digest chain identify it. The committed rows are
   * neither read nor parsed, so nothing re-verifies their bytes: the captured
   * file must hold exactly the descriptor's committed length and still be
   * that inode with no change at all. Unlike {@link messages}, growth is not
   * tolerated, because an in-place edit followed by an append would pass a
   * size check alone; callers project the whole transcript instead.
   */
  public async *activeMessages(): AsyncGenerator<PersistedChatMessage> {
    if (this.consumed)
      throw new Error('Transcript preview was already consumed');
    this.consumed = true;
    if (this.controller.signal.aborted)
      throw new Error('Transcript preview aborted');
    if (this.committed.size !== this.authority.committedByteLength)
      throw new ChatTranscriptIntegrityError(
        'Transcript preview committed prefix mismatch',
      );
    await assertCapturedPreviewFileUnchanged(this.committed);
    yield* this.readActiveRows();
  }

  private async *readActiveRows(): AsyncGenerator<PersistedChatMessage> {
    if (this.projectedActive) {
      for (const message of this.projectedActive) {
        if (this.controller.signal.aborted)
          throw new Error('Transcript preview aborted');
        yield message;
      }
      this.complete = true;
      return;
    }
    if (!this.active) {
      if (this.authority.hasActiveSidecar)
        throw new ChatTranscriptIntegrityError(
          'Transcript preview active sidecar is missing',
        );
      this.complete = true;
      return;
    }
    const prefix = Buffer.alloc(1024);
    const { bytesRead } = await this.active.handle.read(
      prefix,
      0,
      prefix.length,
      0,
    );
    if (this.controller.signal.aborted)
      throw new Error('Transcript preview aborted');
    const match = /"version"\s*:\s*(\d+)/.exec(
      prefix.subarray(0, bytesRead).toString('utf8'),
    );
    const version = match ? Number(match[1]) : undefined;
    if (version === 1) {
      const sidecar = await readLegacyActiveSidecarFromChunks(
        capturedPreviewTextChunks(this.active, this.controller.signal),
      );
      if (!isActiveSidecar(sidecar) || sidecar.finalizing)
        throw new ChatTranscriptIntegrityError(
          'Invalid captured active sidecar',
        );
      if (sidecar.transcriptRevision !== this.authority.transcriptRevision)
        throw new ChatTranscriptIntegrityError(
          'Transcript preview active revision mismatch',
        );
      for (const message of sidecar.messages) yield message;
    } else if (version === 2) {
      let header: ActiveSidecarHeaderV2 | undefined;
      let finalizingRows = 0;
      for await (const row of activeRowsFromChunks(
        capturedPreviewChunks(this.active, this.controller.signal),
      )) {
        if (!header) {
          if (!isActiveSidecarHeaderV2(row.value))
            throw new ChatTranscriptIntegrityError(
              'Invalid captured active header',
            );
          header = row.value;
          continue;
        }
        if (!isActiveSidecarMessageV2(row.value))
          throw new ChatTranscriptIntegrityError(
            'Invalid captured active message',
          );
        parseSidecarRowAnchor(row.value);
        if (row.value.finalizing) finalizingRows += 1;
        yield row.value.message;
      }
      if (
        !header ||
        header.transcriptRevision !== this.authority.transcriptRevision ||
        finalizingRows > 0 !== !!header.finalizing ||
        header.finalizing
      )
        throw new ChatTranscriptIntegrityError(
          'Transcript preview active revision mismatch',
        );
    } else
      throw new ChatTranscriptIntegrityError('Invalid captured active sidecar');
    await assertCapturedPreviewFileUnchanged(this.active);
    this.complete = true;
  }

  /** Off-main consumers may borrow only an idle, fully committed bounded prefix.
   * The callback must stop its thread before settling; close/deletion abort it.
   * No row is read, parsed, cloned or rendered by this host method.
   */
  public async consumeCommittedInThread<T>(
    consume: (
      input: PinnedCommittedTranscript,
      signal: AbortSignal,
    ) => Promise<T>,
    limits: { bytes: number; rows: number },
  ): Promise<T> {
    if (
      this.consumed ||
      this.controller.signal.aborted ||
      this.authority.hasActiveSidecar ||
      this.active ||
      this.projectedActive?.length ||
      this.committed.size !== this.authority.committedByteLength ||
      this.committed.size > limits.bytes ||
      this.authority.committedMessageCount > limits.rows ||
      !this.authority.committedDigest
    )
      throw new Error('Chat learning requires a bounded committed transcript');
    this.consumed = true;
    const committedDigest = this.authority.committedDigest;
    const consumption = Promise.resolve().then(() =>
      consume(
        {
          fd: this.committed.handle.fd,
          size: this.committed.size,
          count: this.authority.committedMessageCount,
          digest: committedDigest,
        },
        this.controller.signal,
      ),
    );
    this.threadConsumption = consumption;
    const value = await consumption;
    await assertCapturedPreviewFileUnchanged(this.committed, true);
    if (this.controller.signal.aborted)
      throw new Error('Transcript preview aborted');
    this.complete = true;
    return value;
  }

  public assertComplete(): void {
    if (!this.complete || this.controller.signal.aborted)
      throw new ChatTranscriptIntegrityError(
        'Transcript preview did not complete',
      );
  }

  public close(): Promise<void> {
    if (!this.closePromise) {
      this.controller.abort();
      this.closePromise = (async (): Promise<void> => {
        // Abort requests teardown; the borrower releases the FD only once its
        // thread has stopped. Never close/reuse it while a read can remain.
        await this.threadConsumption?.catch(() => undefined);
        const outcomes = await Promise.allSettled([
          this.committed.handle.close(),
          ...(this.active ? [this.active.handle.close()] : []),
        ]);
        const failure = outcomes.find(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === 'rejected',
        );
        if (failure) throw errorFromUnknown(failure.reason);
      })().catch((error: unknown) => {
        // A failed OS close remains visible and retryable to the owner.
        this.closePromise = undefined;
        throw error;
      });
    }
    return this.closePromise;
  }
}

export async function* readCompleteTranscriptMessages(
  path: string,
): AsyncGenerator<PersistedChatMessage> {
  for await (const row of lines(path)) yield row.message;
}

/** Complete rows with the exact bytes read for each, for integrity hashing. */
export async function* readCompleteTranscriptRows(
  path: string,
): AsyncGenerator<{ message: PersistedChatMessage; bytes: Buffer }> {
  for await (const row of lines(path))
    yield { message: row.message, bytes: row.bytes };
}

export interface ChatTranscriptReplaceMeasurement {
  chatId: string;
  /** JSONL bytes written by the cooperative writer, excluding a cloned prefix. */
  bytesWritten: number;
  durationMs: number;
}

const MAX_REPLACE_OBSERVERS = 256;

export function isDelegationChildRow(
  value: unknown,
): value is DelegationChildRow {
  return (
    isRecord(value) &&
    isPersistedChatMessage(value) &&
    Object.keys(value).every((key) =>
      [
        'id',
        'role',
        'timestamp',
        'parentBlockId',
        'delegationSequence',
        'blocks',
        'blocksRef',
        'itemRevision',
        'final',
        'delegationAuthor',
        'delegationDelivery',
        'delegationSegment',
      ].includes(key),
    ) &&
    (value.delegationSegment === undefined ||
      (typeof value.delegationSegment === 'string' &&
        value.delegationSegment.length > 0)) &&
    Number.isSafeInteger(value.itemRevision) &&
    typeof value.itemRevision === 'number' &&
    value.itemRevision >= 0 &&
    typeof value.final === 'boolean' &&
    typeof value.parentBlockId === 'string' &&
    Number.isSafeInteger(value.delegationSequence)
  );
}

/** Target-neutral transcript mechanics. Scope transactions serialize operations using this store. */
export class TranscriptStreamStore {
  public readonly artifacts: ChatTranscriptArtifacts;
  private readonly loaded = new Map<string, LoadedLog>();
  private readonly tails = new Map<string, Promise<unknown>>();

  public constructor(
    private readonly paths: TranscriptStreamPaths,
    artifacts: ChatTranscriptArtifacts,
    private readonly onAppendBoundary?: (
      boundary: AppendBoundary,
    ) => Promise<void>,
    private readonly options: {
      readOnly?: boolean;
      childMode?: boolean;
      onChildStaged?: () => Promise<void>;
      /** Monotonic clock; injectable for deterministic measurement tests. */
      now?: () => number;
      /** Test-only fault injection; production callers leave this unset. */
      testHooks?: ChatTranscriptLogTestHooks;
    } = {},
  ) {
    this.artifacts = artifacts;
  }

  private readonly replaceObservers = new Set<
    (measurement: ChatTranscriptReplaceMeasurement) => void
  >();

  /** Transaction-scoped observation; bounded and never allowed to reject storage work. */
  public observeReplacements(
    observer: (measurement: ChatTranscriptReplaceMeasurement) => void,
  ): () => void {
    if (this.replaceObservers.size >= MAX_REPLACE_OBSERVERS)
      return (): void => undefined;
    this.replaceObservers.add(observer);
    return (): void => {
      this.replaceObservers.delete(observer);
    };
  }

  private reportReplacement(
    chatId: string,
    bytesWritten: number,
    startedAt: number,
  ): void {
    const durationMs = Math.max(
      0,
      (this.options.now ?? ((): number => performance.now()))() - startedAt,
    );
    for (const observer of Array.from(this.replaceObservers)) {
      try {
        observer({ chatId, bytesWritten, durationMs });
      } catch {
        // Diagnostics cannot affect publication or derived indexes.
      }
    }
  }

  private activeProjection?: TranscriptActiveProjectionSource;

  /**
   * Delta-journal scopes: read paths (descriptors, pages, active rows, tool
   * output ownership, search previews) take a chat's active rows and
   * transcript revision from `source` while it has one, because the journal
   * holds them ahead of the active sidecar. Committed rows are always read
   * from the files. `undefined` restores file-only reads.
   */
  public setActiveProjection(
    source: TranscriptActiveProjectionSource | undefined,
  ): void {
    this.activeProjection = source;
  }

  private projectedActive(
    chatId: string,
  ): TranscriptActiveProjection | undefined {
    return this.activeProjection?.(chatId);
  }

  private async hasOrdinaryActiveRows(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    anchors: ReadonlyMap<string, ActiveRowAnchor> | undefined,
  ): Promise<boolean> {
    for (const message of messages) {
      if (anchors?.has(message.id)) continue;
      if ((await this.readCommittedMessage(chatId, message.id)) === undefined)
        return true;
    }
    return false;
  }

  private async persistOrdinaryActiveMetadata(
    chatId: string,
    index: SparseIndex,
    hasAnchors: boolean,
    hasOrdinaryActiveRows: boolean,
  ): Promise<void> {
    let changed = false;
    if (hasAnchors) {
      if (index.hasOrdinaryActiveRows !== hasOrdinaryActiveRows) {
        index.hasOrdinaryActiveRows = hasOrdinaryActiveRows;
        changed = true;
      }
    } else if (index.hasOrdinaryActiveRows !== undefined) {
      delete index.hasOrdinaryActiveRows;
      changed = true;
    }
    if (changed) await this.writeIndex(chatId, index);
  }

  private path(chatId: string, extension: string): string {
    return this.paths.file(chatId, extension);
  }

  /**
   * Whether an open row is the committed row with its id: the same stored
   * row, or its format 4 final form, whose finalization offloaded fields the
   * open form keeps inline. Replaying a turn's active write after the row
   * was finalized therefore converges, as it does in formats 2 and 3.
   */
  public async matchesCommitted(
    chatId: string,
    open: PersistedChatMessage,
    existing: PersistedChatMessage,
  ): Promise<boolean> {
    return (
      digest(existing) === digest(open) ||
      this.artifacts.isFinalFormOf(this.paths.owner(chatId), open, existing)
    );
  }

  /**
   * Verify rows a format 4 writer prepared, as a `format4-verify` write of
   * them would, without writing anything.
   */
  public async verifyPrepared(
    chatId: string,
    rows: readonly PersistedChatMessage[],
    final: boolean,
  ): Promise<void> {
    for (const row of rows)
      await this.prepareRow(chatId, row, final, 'format4-verify');
  }

  /**
   * Store form of one row under the caller's selected field mode. A child
   * row's finality is its own; a primary row's is where the write puts it.
   */
  private prepareRow(
    chatId: string,
    message: PersistedChatMessage,
    final: boolean,
    fields: TranscriptFieldMode,
  ): Promise<PersistedChatMessage> {
    return this.artifacts.externalize(
      this.paths.owner(chatId),
      message,
      undefined,
      transcriptFieldPolicy(
        fields,
        this.options.childMode && isDelegationChildRow(message)
          ? message.final
          : final,
      ),
    );
  }

  private locatorDirectory(chatId: string): string {
    return this.paths.locatorDirectory(chatId);
  }

  private expandBlocks(
    chatId: string,
    message: PersistedChatMessage,
    signal?: AbortSignal,
  ): Promise<PersistedChatMessage> {
    return this.artifacts.expandBlocks(
      this.paths.owner(chatId),
      message,
      signal,
    );
  }

  private locatorPath(chatId: string, messageId: string): string {
    return this.paths.locatorFile(chatId, messageId);
  }

  private locatorKey(messageId: string): string {
    return createHash('sha256').update(messageId).digest('hex');
  }

  private async locatorStamp(chatId: string): Promise<string> {
    try {
      const info = await stat(
        this.options.childMode
          ? this.path(chatId, 'jsonl')
          : this.locatorDirectory(chatId),
        { bigint: true },
      );
      return `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  /** Check derived-index closure without hydrating transcript bodies. */
  private async locatorsComplete(
    chatId: string,
    expected: number,
  ): Promise<boolean> {
    let count = 0;
    try {
      for await (const entry of await opendir(this.locatorDirectory(chatId))) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))
          return false;
        if (++count > expected) return false;
      }
      return count === expected;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT')
        return expected === 0;
      throw error;
    }
  }

  private async writeLocators(
    chatId: string,
    rows: ReadonlyArray<{
      message: PersistedChatMessage;
      offset: number;
      end: number;
    }>,
  ): Promise<void> {
    if (this.options.childMode) {
      await this.extendChildSequenceIndex(chatId, rows);
      return;
    }
    if (rows.length === 0) return;
    const directory = this.locatorDirectory(chatId);
    await mkdir(directory, { recursive: true });
    for (let start = 0; start < rows.length; start += 64) {
      const batch = rows
        .slice(start, start + 64)
        .map(({ message, offset, end }) => ({
          path: this.locatorPath(chatId, message.id),
          locator: {
            version: 1 as const,
            messageId: message.id,
            offset,
            end,
            digest: digest(message),
          },
        }));
      // Locators are reconstructible from the already-synced JSONL. Keep
      // bounded writes and directory publication, as the rebuild path does.
      await flushLocatorBatch(batch);
    }
    await fsyncDirectory(directory);
    await fsyncDirectory(dirname(directory));
  }

  private isChildSequenceEntries(
    value: unknown,
  ): value is ChildStreamSequenceEntry[] {
    if (!Array.isArray(value)) return false;
    const ids = new Set<string>();
    let previousSequence: number | undefined;
    for (const entry of value) {
      if (
        !isRecord(entry) ||
        typeof entry.id !== 'string' ||
        entry.id.length === 0 ||
        typeof entry.delegationSequence !== 'number' ||
        !Number.isSafeInteger(entry.delegationSequence) ||
        typeof entry.offset !== 'number' ||
        !Number.isSafeInteger(entry.offset) ||
        entry.offset < 0 ||
        typeof entry.end !== 'number' ||
        !Number.isSafeInteger(entry.end) ||
        entry.end <= entry.offset ||
        ids.has(entry.id) ||
        (previousSequence !== undefined &&
          entry.delegationSequence < previousSequence)
      )
        return false;
      ids.add(entry.id);
      previousSequence = entry.delegationSequence;
    }
    return true;
  }

  private async extendChildSequenceIndex(
    streamKey: string,
    rows: ReadonlyArray<{
      message: PersistedChatMessage;
      offset: number;
      end: number;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const indexPath = this.path(streamKey, 'sequence-index.json');
    let previous: ChildStreamSequenceEntry[] | undefined;
    try {
      const saved: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
      if (
        isRecord(saved) &&
        saved.version === 1 &&
        saved.logBytes === rows[0].offset &&
        this.isChildSequenceEntries(saved.entries)
      )
        previous = saved.entries;
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !(isErrnoException(error) && error.code === 'ENOENT')
      )
        throw error;
    }
    if (!previous && rows[0].offset !== 0) {
      await this.childSequenceIndex(streamKey);
      return;
    }
    const appended: Array<{
      row: DelegationChildRow;
      offset: number;
      end: number;
    }> = [];
    for (const { message, offset, end } of rows) {
      if (!isDelegationChildRow(message))
        throw new Error('Invalid child transcript row');
      appended.push({ row: message, offset, end });
    }
    const entries = [
      ...(previous ?? []),
      ...buildChildStreamSequenceIndex(appended),
    ].sort(
      (left, right) =>
        left.delegationSequence - right.delegationSequence ||
        left.id.localeCompare(right.id),
    );
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new Error('Duplicate child sequence index row');
    const temporary = `${indexPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          logBytes: rows[rows.length - 1].end,
          entries,
        }),
      );
      await rename(temporary, indexPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /**
   * {@link readCommittedMessage} for an active row, probing a row absent
   * from the committed history `loaded` describes only once. Every commit
   * reads its chat's active rows twice and a checkpoint rewrites them, so
   * probing each row every time grows each commit with the turn. Callers
   * load `loaded` in the same serial section, before any committed write.
   * A new committed digest or any locator change (a rebuild restoring a
   * missing locator) starts over.
   */
  private async committedCopy(
    chatId: string,
    loaded: LoadedLog,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined> {
    if (
      loaded.uncommitted?.committedDigest !== loaded.index.committedDigest ||
      loaded.uncommitted.locatorStamp !== loaded.locatorStamp
    )
      loaded.uncommitted = {
        committedDigest: loaded.index.committedDigest,
        locatorStamp: loaded.locatorStamp,
        ids: new Set(),
      };
    const absent = loaded.uncommitted.ids;
    if (absent.has(messageId)) return undefined;
    const existing = await this.readCommittedMessageForGeneration(
      chatId,
      loaded,
      messageId,
      false,
    );
    if (existing === undefined) absent.add(messageId);
    return existing;
  }

  private async readCommittedMessage(
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined> {
    if (this.options.childMode)
      return this.childStreamRowById(chatId, messageId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(this.locatorPath(chatId, messageId), 'utf8'),
      );
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        // Read-only archives cannot rebuild derived files. Scan only when
        // their locator inventory is known to be incomplete.
        if (this.loaded.get(chatId)?.locatorsComplete === false)
          for await (const row of lines(this.path(chatId, 'jsonl')))
            if (row.message.id === messageId) return row.message;
        return undefined;
      }
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!isMessageLocator(parsed) || parsed.messageId !== messageId) {
      // A durable directory can contain a torn derived file after power loss.
      // Rebuild from complete rows, without weakening row/digest validation.
      if (this.options.readOnly) {
        for await (const row of lines(this.path(chatId, 'jsonl')))
          if (row.message.id === messageId) return row.message;
        return undefined;
      }
      await this.load(chatId, true);
      return this.readCommittedMessage(chatId, messageId);
    }
    const length = parsed.end - parsed.offset;
    if (length > MAX_TRANSCRIPT_ROW_BYTES + 1)
      throw new Error('Committed message locator exceeds maximum row size');
    const handle = await open(this.path(chatId, 'jsonl'), 'r');
    try {
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(
          bytes,
          read,
          length - read,
          parsed.offset + read,
        );
        if (result.bytesRead === 0)
          throw new Error('Committed message locator exceeds transcript');
        read += result.bytesRead;
      }
      if (bytes[length - 1] !== 10)
        throw new Error('Committed message locator is not row-aligned');
      if (parsed.offset > 0) {
        const boundary = Buffer.alloc(1);
        await handle.read(boundary, 0, 1, parsed.offset - 1);
        if (boundary[0] !== 10)
          throw new Error('Committed message locator is not row-aligned');
      }
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, length - 1),
        ),
      );
      if (
        !isPersistedChatMessage(value) ||
        value.id !== messageId ||
        digest(value) !== parsed.digest
      )
        throw new Error('Committed message locator does not match transcript');
      return value;
    } finally {
      await handle.close();
    }
  }

  private async buildCommittedLocatorKeys(
    chatId: string,
    loaded: LoadedLog,
  ): Promise<Set<string> | undefined> {
    if (
      !loaded.locatorsComplete ||
      loaded.committedLocatorInventoryUnavailable ||
      this.loaded.get(chatId) !== loaded
    )
      return undefined;
    if (loaded.committedLocatorKeys) return loaded.committedLocatorKeys;
    if (
      loaded.index.committedMessageCount > MAX_COMMITTED_LOCATOR_IDENTITY_KEYS
    ) {
      loaded.committedLocatorInventoryUnavailable = true;
      return undefined;
    }

    const keys = new Set<string>();
    let complete = true;
    try {
      for await (const entry of await opendir(this.locatorDirectory(chatId))) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
          complete = false;
          break;
        }
        if (keys.size >= MAX_COMMITTED_LOCATOR_IDENTITY_KEYS) {
          complete = false;
          break;
        }
        keys.add(entry.name.slice(0, -5));
        if (keys.size > loaded.index.committedMessageCount) {
          complete = false;
          break;
        }
      }
    } catch (error) {
      if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
      complete = loaded.index.committedMessageCount === 0;
    }
    if (keys.size !== loaded.index.committedMessageCount) complete = false;

    // The set is useful only for the exact directory generation validated by
    // load(). The second stamp closes the race with external locator writers.
    if (
      !complete ||
      (await this.locatorStamp(chatId)) !== loaded.locatorStamp ||
      this.loaded.get(chatId) !== loaded
    ) {
      loaded.committedLocatorInventoryUnavailable = true;
      return undefined;
    }
    loaded.committedLocatorKeys = keys;
    return keys;
  }

  private async committedLocatorKeysForProbe(
    chatId: string,
    loaded: LoadedLog,
  ): Promise<Set<string> | undefined> {
    if (loaded.committedLocatorKeys) return loaded.committedLocatorKeys;
    if (loaded.committedLocatorInventoryBuild)
      return loaded.committedLocatorInventoryBuild;
    const build = this.buildCommittedLocatorKeys(chatId, loaded);
    loaded.committedLocatorInventoryBuild = build;
    try {
      return await build;
    } finally {
      delete loaded.committedLocatorInventoryBuild;
    }
  }

  private async readCommittedMessageForGeneration(
    chatId: string,
    loaded: LoadedLog,
    messageId: string,
    buildIdentitySet: boolean,
  ): Promise<PersistedChatMessage | undefined> {
    let keys = loaded.committedLocatorKeys;
    if (buildIdentitySet && !keys)
      keys = await this.committedLocatorKeysForProbe(chatId, loaded);
    if (keys && !keys.has(this.locatorKey(messageId))) return undefined;
    return this.readCommittedMessage(chatId, messageId);
  }

  /** Read a locator without load(), repair, or transcript-wide fallback. */
  private async readCommittedMessageAtLocator(
    chatId: string,
    messageId: string,
  ): Promise<
    { valid: true; message: PersistedChatMessage } | { valid: false }
  > {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(this.locatorPath(chatId, messageId), 'utf8'),
      );
    } catch (error) {
      if (
        (isErrnoException(error) && error.code === 'ENOENT') ||
        error instanceof SyntaxError
      )
        return { valid: false };
      throw error;
    }
    if (!isMessageLocator(parsed) || parsed.messageId !== messageId)
      return { valid: false };
    const length = parsed.end - parsed.offset;
    if (length < 2 || length > MAX_TRANSCRIPT_ROW_BYTES + 1)
      return { valid: false };
    let handle: FileHandle;
    try {
      handle = await open(this.path(chatId, 'jsonl'), 'r');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT')
        return { valid: false };
      throw error;
    }
    try {
      if (parsed.offset > 0) {
        const previous = Buffer.alloc(1);
        const result = await handle.read(previous, 0, 1, parsed.offset - 1);
        if (result.bytesRead !== 1 || previous[0] !== 10)
          return { valid: false };
      }
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(
          bytes,
          read,
          length - read,
          parsed.offset + read,
        );
        if (result.bytesRead === 0) return { valid: false };
        read += result.bytesRead;
      }
      if (bytes[length - 1] !== 10) return { valid: false };
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            bytes.subarray(0, length - 1),
          ),
        );
      } catch {
        return { valid: false };
      }
      if (
        !isPersistedChatMessage(value) ||
        value.id !== messageId ||
        digest(value) !== parsed.digest
      )
        return { valid: false };
      return { valid: true, message: value };
    } finally {
      await handle.close();
    }
  }

  /** Resolve an indexed committed row's zero-based ordinal from its locator. */
  private async committedOrdinal(
    chatId: string,
    index: SparseIndex,
    messageId: string,
  ): Promise<number | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(this.locatorPath(chatId, messageId), 'utf8'),
      );
    } catch (error) {
      if (
        !(isErrnoException(error) && error.code === 'ENOENT') &&
        !(error instanceof SyntaxError)
      )
        throw error;
    }
    if (isMessageLocator(parsed) && parsed.messageId === messageId) {
      const checkpoint = [...index.offsets]
        .reverse()
        .find((entry) => entry.offset <= parsed.offset);
      if (!checkpoint)
        throw new Error('Committed locator has no sparse checkpoint');
      let ordinal = checkpoint.ordinal;
      for await (const row of lines(
        this.path(chatId, 'jsonl'),
        checkpoint.offset,
      )) {
        if (row.offset === parsed.offset) return ordinal;
        if (row.offset > parsed.offset) break;
        ordinal += 1;
        if (ordinal - checkpoint.ordinal > SPARSE_STRIDE)
          throw new Error('Committed locator exceeded its sparse checkpoint');
      }
      throw new Error('Committed locator offset is not indexed');
    }

    // Read-only archives may legitimately lack a complete locator inventory.
    // This is the slow recovery fallback; normal indexed reads scan at most one
    // sparse stride above.
    let ordinal = 0;
    for await (const row of lines(this.path(chatId, 'jsonl'))) {
      if (row.message.id === messageId) return ordinal;
      ordinal += 1;
    }
    return undefined;
  }

  /** Read a small set of physical ordinals, grouping seeks by sparse stride. */
  private async committedRowsAt(
    chatId: string,
    index: SparseIndex,
    identity: string,
    ordinals: readonly number[],
  ): Promise<Map<number, PersistedChatMessage>> {
    const path = this.path(chatId, 'jsonl');
    const unique = Array.from(new Set(ordinals)).sort(
      (left, right) => left - right,
    );
    const result = new Map<number, PersistedChatMessage>();
    const missingByStride = new Map<number, number[]>();
    for (const ordinal of unique) {
      const cached = logicalCommittedRows.get(path, identity, ordinal);
      if (cached) {
        result.set(ordinal, cached);
        continue;
      }
      const stride = Math.floor(ordinal / SPARSE_STRIDE);
      const missing = missingByStride.get(stride) ?? [];
      missing.push(ordinal);
      missingByStride.set(stride, missing);
    }
    const strideGroups: number[][] = [];
    missingByStride.forEach((missing: number[]): void => {
      strideGroups.push(missing);
    });
    for (const missing of strideGroups) {
      const start = missing[0];
      const last = missing[missing.length - 1];
      if (start === undefined || last === undefined) continue;
      let ordinal = start;
      for await (const message of this.range(chatId, index, start, last + 1)) {
        logicalCommittedRows.set(path, identity, ordinal, message);
        result.set(ordinal, message);
        ordinal += 1;
      }
    }
    return result;
  }

  /**
   * Full committed turn rows are retained only for turn ranges that anchors
   * actually affect. This lets turn paging reuse a large affected turn without
   * hydrating unrelated history; the bounded row cache documents the oversized
   * range exception above.
   */
  private async committedRangeCached(
    chatId: string,
    index: SparseIndex,
    identity: string,
    start: number,
    end: number,
  ): Promise<PersistedChatMessage[]> {
    if (start >= end) return [];
    const path = this.path(chatId, 'jsonl');
    const cached: PersistedChatMessage[] = [];
    let complete = true;
    for (let ordinal = start; ordinal < end; ordinal += 1) {
      const message = logicalCommittedRows.get(path, identity, ordinal);
      if (!message) {
        complete = false;
        break;
      }
      cached.push(message);
    }
    if (complete) return cached;

    const rows: PersistedChatMessage[] = [];
    let ordinal = start;
    for await (const message of this.range(chatId, index, start, end)) {
      rows.push(message);
      logicalCommittedRows.set(path, identity, ordinal, message);
      ordinal += 1;
    }
    if (rows.length !== end - start)
      throw new Error('Committed transcript turn range is incomplete');
    return rows;
  }

  /** Build or reuse a validated sparse placement for an anchored sidecar. */
  private async logicalReadContext(
    chatId: string,
    index: SparseIndex,
    activeRows: readonly PersistedChatMessage[],
    anchors: ReadonlyMap<string, ActiveRowAnchor>,
  ): Promise<LogicalReadContext> {
    const committedPath = this.path(chatId, 'jsonl');
    const committedIdentity = await fileIdentity(committedPath);
    const activeById = new Map<string, PersistedChatMessage>();
    const rowShape = activeRows.map((message) => {
      if (activeById.has(message.id))
        throw new Error(
          `Invalid active row anchor: duplicate active row ${message.id}`,
        );
      activeById.set(message.id, message);
      return [
        message.id,
        runIdForActiveMessage(message) ?? null,
        hasDelegatedAgentCall(message),
      ];
    });
    const anchorShape = Array.from(anchors.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, anchor]) => [id, anchor.runId, anchor.after, anchor.tie]);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ rowShape, anchorShape }))
      .digest('hex');
    const cached = logicalPlacementSnapshots.get(committedPath);
    if (
      cached?.committedStamp === committedIdentity.stamp &&
      cached.fingerprint === fingerprint
    ) {
      logicalPlacementSnapshots.delete(committedPath);
      logicalPlacementSnapshots.set(committedPath, cached);
      for (const message of activeRows) {
        const committed = cached.committedById.get(message.id);
        if (!committed) continue;
        let persisted = logicalCommittedRows.get(
          committedPath,
          committedIdentity.stamp,
          committed.ordinal,
        );
        if (!persisted) {
          persisted = await this.readCommittedMessage(chatId, message.id);
          if (!persisted)
            throw new Error(`Committed active echo disappeared: ${message.id}`);
          logicalCommittedRows.set(
            committedPath,
            committedIdentity.stamp,
            committed.ordinal,
            persisted,
          );
        }
        if (!(await this.matchesCommitted(chatId, message, persisted)))
          throw new Error('Active message conflicts with committed history');
      }
      const logicalActiveById = new Map<string, PersistedChatMessage>();
      for (const message of activeRows)
        if (!cached.committedById.has(message.id))
          logicalActiveById.set(message.id, message);
      const activeByRank = new Map<number, PersistedChatMessage>();
      cached.ranks.activeRankById.forEach((rank: number, id: string): void => {
        const message = logicalActiveById.get(id);
        if (message) activeByRank.set(rank, message);
      });
      return {
        committedStamp: committedIdentity.stamp,
        fingerprint,
        placement: cached.placement,
        ranks: cached.ranks,
        committedById: cached.committedById,
        anchoredActiveIds: new Set(
          Array.from(anchors.keys()).filter(
            (id) => !cached.committedById.has(id),
          ),
        ),
        activeById: logicalActiveById,
        activeByRank,
        totalCount: cached.ranks.bodyCount + cached.placement.tail.length,
      };
    }

    const committedMessages = new Map<string, PersistedChatMessage>();
    const committedById = new Map<string, CommittedAnchorMetadata>();
    const rememberCommitted = async (
      id: string,
      message: PersistedChatMessage | undefined,
    ): Promise<void> => {
      if (!message) return;
      const ordinal = await this.committedOrdinal(chatId, index, id);
      if (ordinal === undefined) return;
      committedMessages.set(id, message);
      committedById.set(id, {
        ordinal,
        ...(runIdForActiveMessage(message)
          ? { runId: runIdForActiveMessage(message) }
          : {}),
        isRunCard: hasDelegatedAgentCall(message),
      });
      logicalCommittedRows.set(
        committedPath,
        committedIdentity.stamp,
        ordinal,
        message,
      );
    };

    for (const message of activeRows) {
      const committed = await this.readCommittedMessage(chatId, message.id);
      if (
        committed &&
        !(await this.matchesCommitted(chatId, message, committed))
      )
        throw new Error('Active message conflicts with committed history');
      await rememberCommitted(message.id, committed);
    }
    const candidateIds = new Set<string>();
    anchors.forEach((anchor: ActiveRowAnchor): void => {
      if (!activeById.has(anchor.runId)) candidateIds.add(anchor.runId);
      if (anchor.after !== null && !activeById.has(anchor.after))
        candidateIds.add(anchor.after);
    });
    const orderedCandidateIds: string[] = [];
    candidateIds.forEach((id: string): void => {
      orderedCandidateIds.push(id);
    });
    for (const id of orderedCandidateIds) {
      if (committedById.has(id)) continue;
      await rememberCommitted(id, await this.readCommittedMessage(chatId, id));
    }

    const knownRunCardIds = new Set<string>();
    for (const message of activeRows)
      if (hasDelegatedAgentCall(message)) knownRunCardIds.add(message.id);
    committedById.forEach(
      (metadata: CommittedAnchorMetadata, id: string): void => {
        if (metadata.isRunCard) knownRunCardIds.add(id);
      },
    );
    const ordinalById = new Map<string, number>();
    committedById.forEach((metadata: CommittedAnchorMetadata, id: string) =>
      ordinalById.set(id, metadata.ordinal),
    );

    let placement: LogicalPlacement<{ id: string }>;
    try {
      placement = resolveLogicalPlacement({
        activeRows: activeRows.map((message) => ({ id: message.id })),
        anchors,
        isCommittedMessage: (id) => committedById.has(id),
        knownRunCardIds,
        runIdForMessage: (id) =>
          runIdForActiveMessage(
            activeById.get(id) ?? committedMessages.get(id),
          ),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid active row anchor: ${reason}`);
    }
    const ranks = rankLogicalPlacement(
      placement,
      index.committedMessageCount,
      ordinalById,
    );
    const logicalActiveById = new Map<string, PersistedChatMessage>();
    for (const message of activeRows)
      if (!committedById.has(message.id))
        logicalActiveById.set(message.id, message);
    const activeByRank = new Map<number, PersistedChatMessage>();
    ranks.activeRankById.forEach((rank: number, id: string): void => {
      const message = logicalActiveById.get(id);
      if (message) activeByRank.set(rank, message);
    });
    const estimatedBytes = Buffer.byteLength(
      JSON.stringify({ rowShape, anchorShape }),
      'utf8',
    );
    const snapshot: LogicalPlacementSnapshot = {
      committedStamp: committedIdentity.stamp,
      fingerprint,
      placement,
      ranks,
      committedById,
      estimatedBytes,
    };
    logicalPlacementSnapshots.delete(committedPath);
    if (estimatedBytes <= MAX_LOGICAL_PLACEMENT_BYTES) {
      logicalPlacementSnapshots.set(committedPath, snapshot);
      while (logicalPlacementSnapshots.size > MAX_LOGICAL_SNAPSHOT_CHATS) {
        const oldest = logicalPlacementSnapshots.keys().next().value;
        if (oldest === undefined) break;
        logicalPlacementSnapshots.delete(oldest);
      }
    }
    return {
      committedStamp: committedIdentity.stamp,
      fingerprint,
      placement,
      ranks,
      committedById,
      anchoredActiveIds: new Set(
        Array.from(anchors.keys()).filter((id) => !committedById.has(id)),
      ),
      activeById: logicalActiveById,
      activeByRank,
      totalCount: ranks.bodyCount + placement.tail.length,
    };
  }

  private logicalActiveMessages(
    context: LogicalReadContext,
    rows: readonly { id: string }[],
  ): PersistedChatMessage[] {
    const messages: PersistedChatMessage[] = [];
    for (const row of rows) {
      const message = context.activeById.get(row.id);
      if (!message) throw new Error(`Logical active row is missing: ${row.id}`);
      messages.push(message);
    }
    return messages;
  }

  private async latestLogicalHuman(
    chatId: string,
    index: SparseIndex,
    context: LogicalReadContext,
  ): Promise<PersistedChatMessage | undefined> {
    let activeLatest: PersistedChatMessage | undefined;
    let activeRank = -1;
    context.activeByRank.forEach(
      (message: PersistedChatMessage, rank: number): void => {
        if (rank > activeRank && isHumanAuthoredUserMessage(message)) {
          activeLatest = message;
          activeRank = rank;
        }
      },
    );
    const committedOrdinal = index.latestHuman?.ordinal;
    if (committedOrdinal === undefined) return activeLatest;
    const committedRank =
      context.ranks.committedRankByOrdinal(committedOrdinal);
    if (activeLatest && activeRank > committedRank) return activeLatest;
    const committed = await this.committedRowsAt(
      chatId,
      index,
      context.committedStamp,
      [committedOrdinal],
    );
    return committed.get(committedOrdinal);
  }

  /**
   * Metadata for an anchored chat, read off its logical sequence. Counts skip
   * committed echoes, and the last row, preview and TODO state follow logical
   * order rather than sidecar order. Rows after all committed history fold
   * onto the committed aggregates; a TODO tool before later committed rows
   * instead merges with the cached committed TODO operations by logical rank.
   */
  private async logicalDescriptor(
    chatId: string,
    index: SparseIndex,
    descriptor: TranscriptDescriptor,
    context: LogicalReadContext,
  ): Promise<TranscriptDescriptor> {
    const { placement, ranks } = context;
    const committedCount = index.committedMessageCount;
    let afterCommittedHistory = placement.start;
    if (committedCount > 0)
      afterCommittedHistory =
        (index.lastMessageId === undefined
          ? undefined
          : placement.afterCommitted.get(index.lastMessageId)) ?? [];
    const trailing = this.logicalActiveMessages(context, [
      ...afterCommittedHistory,
      ...placement.tail,
    ]);
    const trailingIds = new Set(trailing.map((message) => message.id));
    const activeRows = Array.from(context.activeById.values());

    let newestPreview: { rank: number; text: string } | undefined;
    for (const [rank, message] of Array.from(context.activeByRank)) {
      if (newestPreview !== undefined && rank < newestPreview.rank) continue;
      const text = assistantPreview(message);
      if (text !== undefined) newestPreview = { rank, text };
    }
    let lastAssistantPreview = descriptor.lastAssistantPreview;
    if (newestPreview !== undefined) {
      const lastCommittedRank =
        committedCount > 0
          ? ranks.committedRankByOrdinal(committedCount - 1)
          : -1;
      const committedOrdinal =
        newestPreview.rank > lastCommittedRank ||
        lastAssistantPreview === undefined
          ? undefined
          : await this.lastCommittedPreviewOrdinal(
              chatId,
              index,
              context.committedStamp,
            );
      if (
        committedOrdinal === undefined ||
        ranks.committedRankByOrdinal(committedOrdinal) < newestPreview.rank
      )
        lastAssistantPreview = newestPreview.text;
    }

    const todoState = activeRows.some(
      (message) => !trailingIds.has(message.id) && affectsTodoState(message),
    )
      ? await this.logicalTodoState(chatId, context)
      : trailing.reduce(foldTranscriptTodoState, {
          todos: index.todos,
          taskTodos: index.taskTodos,
        });
    const lastRow = trailing[trailing.length - 1];
    const firstRow =
      placement.start.length > 0 || committedCount === 0
        ? context.activeByRank.get(0)
        : undefined;
    return {
      ...descriptor,
      ...todoState,
      ...(lastAssistantPreview !== undefined ? { lastAssistantPreview } : {}),
      messageCount: context.totalCount,
      userMessageCount:
        (index.userMessageCount ?? 0) +
        activeRows.filter((message) => message.role === 'user').length,
      hasOrdinaryActiveRows: activeRows.some(
        (message) => !context.anchoredActiveIds.has(message.id),
      ),
      ...(lastRow
        ? { lastMessageAt: lastRow.timestamp, lastMessageId: lastRow.id }
        : {}),
      ...(firstRow ? { firstMessageAt: firstRow.timestamp } : {}),
    };
  }

  /**
   * The ordinal of the last committed row with an assistant preview. Scans
   * back one sparse stride at a time from the end, and caches the answer per
   * committed file identity.
   */
  private async lastCommittedPreviewOrdinal(
    chatId: string,
    index: SparseIndex,
    committedStamp: string,
  ): Promise<number | undefined> {
    const path = this.path(chatId, 'jsonl');
    const cached = committedPreviewOrdinals.get(path);
    if (cached?.stamp === committedStamp) return cached.ordinal;
    let found: number | undefined;
    for (
      let stride = index.offsets.length - 1;
      stride >= 0 && found === undefined;
      stride -= 1
    ) {
      const start = index.offsets[stride]?.ordinal;
      if (start === undefined) continue;
      const end =
        index.offsets[stride + 1]?.ordinal ?? index.committedMessageCount;
      let ordinal = start;
      for await (const message of this.range(chatId, index, start, end)) {
        if (assistantPreview(message) !== undefined) found = ordinal;
        ordinal += 1;
      }
    }
    rememberLogicalSnapshot(committedPreviewOrdinals, path, {
      stamp: committedStamp,
      ...(found === undefined ? {} : { ordinal: found }),
    });
    return found;
  }

  /**
   * TODO state folded over logical order when an active TODO row is placed
   * before committed history. Committed operations are cached by committed
   * identity; each active update only rank-merges its TODO-bearing rows.
   */
  private async logicalTodoState(
    chatId: string,
    context: LogicalReadContext,
  ): Promise<TranscriptTodoState> {
    const path = this.path(chatId, 'jsonl');
    let cached = logicalTodoOperations.get(path);
    if (cached?.stamp !== context.committedStamp) {
      const operations: LogicalTodoOperation[] = [];
      let ordinal = 0;
      for await (const row of lines(path)) {
        const message = row.message;
        if (affectsTodoState(message))
          operations.push({
            ordinal,
            message: {
              ...message,
              blocks: message.blocks.filter(
                (block) =>
                  block.type === 'tool_use' &&
                  (block.toolName === 'TodoWrite' ||
                    block.toolName === 'TaskCreate' ||
                    block.toolName === 'TaskUpdate'),
              ),
            },
          });
        ordinal += 1;
      }
      cached = { stamp: context.committedStamp, operations };
      rememberLogicalSnapshot(logicalTodoOperations, path, cached);
    }
    const ranked: Array<{ rank: number; message: PersistedChatMessage }> = [];
    for (const operation of cached.operations)
      ranked.push({
        rank: context.ranks.committedRankByOrdinal(operation.ordinal),
        message: operation.message,
      });
    for (const [rank, message] of Array.from(context.activeByRank))
      if (affectsTodoState(message)) ranked.push({ rank, message });
    ranked.sort((left, right) => left.rank - right.rank);
    let state: TranscriptTodoState = {};
    for (const operation of ranked)
      state = foldTranscriptTodoState(state, operation.message);
    return state;
  }

  private async logicalRawPage(
    chatId: string,
    index: SparseIndex,
    context: LogicalReadContext,
    before: number | undefined,
    transcriptRevision: number,
  ): Promise<TranscriptPage> {
    const bodyCount = context.ranks.bodyCount;
    const end = before ?? bodyCount;
    if (!Number.isSafeInteger(end) || end < 0 || end > bodyCount)
      throw new Error('Invalid transcript page cursor');
    const start = Math.max(0, end - TRANSCRIPT_PAGE_SIZE);
    const selectedByRank = new Map<number, PersistedChatMessage>();
    const committedOrdinals: number[] = [];
    for (let rank = start; rank < end; rank += 1) {
      const active = context.activeByRank.get(rank);
      if (active) {
        selectedByRank.set(rank, active);
        continue;
      }
      const ordinal = context.ranks.committedOrdinalByBodyRank(rank);
      if (ordinal === undefined)
        throw new Error(`Logical body rank ${rank} has no transcript row`);
      committedOrdinals.push(ordinal);
    }
    const committed = await this.committedRowsAt(
      chatId,
      index,
      context.committedStamp,
      committedOrdinals,
    );
    for (const ordinal of committedOrdinals) {
      const rank = context.ranks.committedRankByOrdinal(ordinal);
      const message = committed.get(ordinal);
      if (!message)
        throw new Error(`Committed transcript ordinal is missing: ${ordinal}`);
      selectedByRank.set(rank, message);
    }
    const messages: PersistedChatMessage[] = [];
    for (let rank = start; rank < end; rank += 1) {
      const message = selectedByRank.get(rank);
      if (!message)
        throw new Error(`Logical transcript row is missing at ${rank}`);
      messages.push(message);
    }
    if (before === undefined)
      messages.push(
        ...this.logicalActiveMessages(context, context.placement.tail),
      );
    const latestHumanMessage = await this.latestLogicalHuman(
      chatId,
      index,
      context,
    );
    return {
      messages,
      totalMessages: context.totalCount,
      transcriptRevision,
      ...(start > 0 ? { before: start } : {}),
      ...(latestHumanMessage &&
      !messages.some((message) => message.id === latestHumanMessage.id)
        ? { latestHumanMessage }
        : {}),
    };
  }

  private async logicalTurnIndex(
    chatId: string,
    index: SparseIndex,
    context: LogicalReadContext,
  ): Promise<TranscriptTurnIndex> {
    const path = this.path(chatId, 'jsonl');
    const contentHasher = createHash('sha256');
    context.activeById.forEach((message: PersistedChatMessage): void => {
      contentHasher.update(digest(message));
    });
    const contentFingerprint = contentHasher.digest('hex');
    const cached = logicalTurnSnapshots.get(path);
    if (
      cached?.committedStamp === context.committedStamp &&
      cached.fingerprint === context.fingerprint &&
      cached.contentFingerprint === contentFingerprint
    ) {
      logicalTurnSnapshots.delete(path);
      logicalTurnSnapshots.set(path, cached);
      return cached.turnIndex;
    }

    const committedIndex = await this.turnIndex(chatId, index);
    const baseTurns = committedIndex.turns;
    const affected = new Set<number>();
    const receiptTurns = baseTurns.map((turn) => ({
      id: turn.id,
      deniedToolUseIds: [...turn.deniedToolUseIds],
    }));
    context.activeById.forEach((message: PersistedChatMessage): void => {
      for (const block of message.blocks) {
        if (
          block.type !== 'approval_safety_denied_info' ||
          !block.toolUseId ||
          block.subagentId ||
          block.turnUserMessageId === undefined
        )
          continue;
        const owner = receiptTurns.findIndex(
          (turn) => turn.id === block.turnUserMessageId,
        );
        if (owner < 0) continue;
        affected.add(owner);
        const turn = receiptTurns[owner];
        if (!turn.deniedToolUseIds.includes(block.toolUseId))
          turn.deniedToolUseIds.push(block.toolUseId);
      }
    });
    if (context.placement.start.length > 0 && baseTurns.length > 0)
      affected.add(0);
    context.placement.afterCommitted.forEach(
      (_rows: Array<{ id: string }>, predecessorId: string): void => {
        const metadata = context.committedById.get(predecessorId);
        if (!metadata)
          throw new Error(
            `Committed anchor predecessor is missing: ${predecessorId}`,
          );
        const turnIndex = baseTurns.findIndex(
          (turn) =>
            turn.start <= metadata.ordinal && metadata.ordinal < turn.end,
        );
        if (turnIndex < 0)
          throw new Error(
            `No turn owns committed anchor predecessor ${predecessorId}`,
          );
        affected.add(turnIndex);
      },
    );
    if (context.placement.tail.length > 0 && baseTurns.length > 0)
      affected.add(baseTurns.length - 1);

    const turns: IndexedTurn[] = [];
    if (baseTurns.length === 0) {
      const activeRows = [
        ...this.logicalActiveMessages(context, context.placement.start),
        ...this.logicalActiveMessages(context, context.placement.tail),
      ];
      turns.push(...(await buildTurnIndex(activeRows, 0)));
    } else {
      for (
        let turnPosition = 0;
        turnPosition < baseTurns.length;
        turnPosition += 1
      ) {
        const turn = baseTurns[turnPosition];
        if (!turn) throw new Error(`Missing committed turn at ${turnPosition}`);
        const startRank = context.ranks.committedRankByOrdinal(turn.start);
        const endRank =
          turn.end === index.committedMessageCount
            ? context.ranks.bodyCount
            : context.ranks.committedRankByOrdinal(turn.end);
        if (!affected.has(turnPosition)) {
          turns.push({
            ...turn,
            start: startRank,
            end: endRank,
            frame: turn.frame.map((ordinal) =>
              context.ranks.committedRankByOrdinal(ordinal),
            ),
            retained: turn.retained.map((ordinal) =>
              context.ranks.committedRankByOrdinal(ordinal),
            ),
          });
          continue;
        }

        const committedRows = await this.committedRangeCached(
          chatId,
          index,
          context.committedStamp,
          turn.start,
          turn.end,
        );
        const mergedRows: PersistedChatMessage[] = [];
        const isFirstTurn = turnPosition === 0;
        if (isFirstTurn && context.placement.start.length > 0)
          mergedRows.push(
            ...this.logicalActiveMessages(context, context.placement.start),
          );
        for (const message of committedRows) {
          mergedRows.push(message);
          const followers = context.placement.afterCommitted.get(message.id);
          if (followers)
            mergedRows.push(...this.logicalActiveMessages(context, followers));
        }
        if (turnPosition === baseTurns.length - 1)
          mergedRows.push(
            ...this.logicalActiveMessages(context, context.placement.tail),
          );

        const hasNextTurn = turnPosition < baseTurns.length - 1;
        let sentinelRank: number | undefined;
        if (hasNextTurn) {
          const next = baseTurns[turnPosition + 1];
          if (!next) throw new Error('Missing next committed turn');
          const sentinel = await this.committedRangeCached(
            chatId,
            index,
            context.committedStamp,
            next.start,
            next.start + 1,
          );
          const firstNextMessage = sentinel[0];
          if (!firstNextMessage)
            throw new Error('Missing next-turn completion boundary');
          sentinelRank = context.ranks.committedRankByOrdinal(next.start);
          mergedRows.push(firstNextMessage);
        }
        const buildStart =
          isFirstTurn && context.placement.start.length > 0 ? 0 : startRank;
        const rebuilt = await buildTurnIndex(
          mergedRows,
          buildStart,
          receiptTurns,
        );
        turns.push(
          ...rebuilt.filter(
            (rebuiltTurn) =>
              sentinelRank === undefined || rebuiltTurn.start < sentinelRank,
          ),
        );
      }
    }

    // A live anchored run card is durable context for its owner turn. Keep the
    // card visible in turn pages; logicalTurnPage also retains recent progress.
    context.anchoredActiveIds.forEach((id: string): void => {
      const message = context.activeById.get(id);
      if (!message || !hasDelegatedAgentCall(message)) return;
      const ordinal = context.ranks.activeRankById.get(id);
      if (ordinal === undefined) return;
      const owner = turns.find(
        (turn) => turn.start <= ordinal && ordinal < turn.end,
      );
      if (!owner) throw new Error(`No turn owns delegated agent card: ${id}`);
      if (!owner.retained.includes(ordinal))
        owner.retained = [...owner.retained, ordinal].sort(
          (left, right) => left - right,
        );
    });

    const logicalIndex: TranscriptTurnIndex = {
      version: 10,
      committedByteLength: index.committedByteLength,
      committedMessageCount: context.totalCount,
      turns,
    };
    const estimatedBytes = Buffer.byteLength(
      JSON.stringify(logicalIndex),
      'utf8',
    );
    logicalTurnSnapshots.delete(path);
    if (estimatedBytes <= MAX_LOGICAL_PLACEMENT_BYTES) {
      logicalTurnSnapshots.set(path, {
        committedStamp: context.committedStamp,
        fingerprint: context.fingerprint,
        contentFingerprint,
        turnIndex: logicalIndex,
        estimatedBytes,
      });
      while (logicalTurnSnapshots.size > MAX_LOGICAL_SNAPSHOT_CHATS) {
        const oldest = logicalTurnSnapshots.keys().next().value;
        if (oldest === undefined) break;
        logicalTurnSnapshots.delete(oldest);
      }
    }
    return logicalIndex;
  }

  private async logicalTurnPage(
    chatId: string,
    index: SparseIndex,
    context: LogicalReadContext,
    before: number | undefined,
    options: TranscriptViewRequest,
    transcriptRevision: number,
  ): Promise<TranscriptPage> {
    const records = (await this.logicalTurnIndex(chatId, index, context)).turns;
    const end = before ?? context.totalCount;
    if (!Number.isSafeInteger(end) || end < 0 || end > context.totalCount)
      throw new Error('Invalid transcript page cursor');
    const owner = options.turnId
      ? records.find((turn) => turn.id === options.turnId)
      : undefined;
    if (options.turnId && !owner) throw new Error('Unknown transcript turn');
    if (owner && (end <= owner.start || end > owner.end))
      throw new Error('Invalid turn page cursor');
    const selected = owner
      ? [owner]
      : records.filter((turn) => turn.start < end).slice(-100);
    const historyBefore = selected[0]?.start;
    const latestHumanMessage = await this.latestLogicalHuman(
      chatId,
      index,
      context,
    );
    if (!owner && latestHumanMessage && historyBefore !== undefined) {
      const activeLatestOrdinal = Array.from(
        context.activeByRank.entries(),
      ).find(([, message]) => message.id === latestHumanMessage.id)?.[0];
      const latestOrdinal =
        activeLatestOrdinal ??
        (index.latestHuman
          ? context.ranks.committedRankByOrdinal(index.latestHuman.ordinal)
          : undefined);
      if (latestOrdinal !== undefined && latestOrdinal < historyBefore) {
        const stickyTurn = records.find(
          (turn) => turn.start <= latestOrdinal && latestOrdinal < turn.end,
        );
        if (stickyTurn) selected.unshift(stickyTurn);
      }
    }

    // Only active, anchored cards can be live. Passive committed copies must
    // retain the ordinary historical compaction behavior, regardless of status.
    const liveRuns = new Map<
      string,
      { cardOrdinal: number; childOrdinals: number[] }
    >();
    context.anchoredActiveIds.forEach((id: string): void => {
      const message = context.activeById.get(id);
      const cardOrdinal = context.ranks.activeRankById.get(id);
      if (!message || cardOrdinal === undefined) return;
      for (const block of message.blocks) {
        if (
          block.type === 'delegated_agent_call' &&
          (block.status === 'pending' || block.status === 'running')
        ) {
          liveRuns.set(block.agentBlockId, { cardOrdinal, childOrdinals: [] });
        }
      }
    });
    // Ranks need not arrive in logical order. Keep a bounded, sorted suffix per
    // run using the read context, without reading any additional transcript rows.
    context.anchoredActiveIds.forEach((id: string): void => {
      const message = context.activeById.get(id);
      const ordinal = context.ranks.activeRankById.get(id);
      if (!message?.parentBlockId || ordinal === undefined) return;
      const run = liveRuns.get(message.parentBlockId);
      if (!run) return;
      const insertion = run.childOrdinals.findIndex((rank) => rank > ordinal);
      if (insertion < 0) run.childOrdinals.push(ordinal);
      else run.childOrdinals.splice(insertion, 0, ordinal);
      if (run.childOrdinals.length > LIVE_RUN_CHILD_TAIL_SIZE)
        run.childOrdinals.shift();
    });

    const ordinals = new Set<number>();
    const pageTurns: TranscriptTurnSummary[] = [];
    for (const turn of selected) {
      const newest = turn === records[records.length - 1];
      const tailStart = owner
        ? Math.max(turn.start, end - TRANSCRIPT_PAGE_SIZE)
        : newest || !turn.complete
          ? Math.max(turn.start, turn.end - 1000)
          : Math.max(turn.start, turn.end - COMPLETED_TURN_TAIL_SIZE);
      const tailEnd = owner ? end : turn.end;
      for (let ordinal = tailStart; ordinal < tailEnd; ordinal += 1)
        ordinals.add(ordinal);
      for (const ordinal of [...turn.frame, ...turn.retained])
        ordinals.add(ordinal);
      // Explicit turn pages load a contiguous history window; only compacted
      // overview turns need their live progress gaps filled.
      if (!owner && !newest && turn.complete) {
        liveRuns.forEach((run): void => {
          if (run.cardOrdinal < turn.start || run.cardOrdinal >= turn.end)
            return;
          for (const ordinal of run.childOrdinals) ordinals.add(ordinal);
        });
      }
      let gapEnd = tailStart;
      while (gapEnd > turn.start && ordinals.has(gapEnd - 1)) gapEnd -= 1;
      let gapStart = turn.start;
      while (gapStart < gapEnd && ordinals.has(gapStart)) gapStart += 1;
      pageTurns.push({
        id: turn.id,
        start: turn.start,
        end: turn.end,
        complete: turn.complete,
        summary: turn.summary,
        outcomes: turn.outcomes,
        deniedToolUseIds: turn.deniedToolUseIds,
        finalMessageIds: turn.finalMessageIds,
        files: turn.files,
        ...(turn.frameTimer ? { frameTimer: turn.frameTimer } : {}),
        ...(gapEnd > gapStart ? { before: gapEnd } : {}),
        ...(turn.continuations ? { continuations: turn.continuations } : {}),
      });
    }

    const ordered = Array.from(ordinals).sort((left, right) => left - right);
    const committedOrdinals: number[] = [];
    const activeMessagesByOrdinal = new Map<number, PersistedChatMessage>();
    for (const ordinal of ordered) {
      const active = context.activeByRank.get(ordinal);
      if (active) activeMessagesByOrdinal.set(ordinal, active);
      else {
        const committedOrdinal =
          context.ranks.committedOrdinalByBodyRank(ordinal);
        if (committedOrdinal === undefined)
          throw new Error(`Logical turn ordinal has no row: ${ordinal}`);
        committedOrdinals.push(committedOrdinal);
      }
    }
    const committedRows = await this.committedRowsAt(
      chatId,
      index,
      context.committedStamp,
      committedOrdinals,
    );
    const messages: PersistedChatMessage[] = [];
    for (const ordinal of ordered) {
      const active = activeMessagesByOrdinal.get(ordinal);
      if (active) {
        messages.push(active);
        continue;
      }
      const committedOrdinal =
        context.ranks.committedOrdinalByBodyRank(ordinal);
      const message =
        committedOrdinal === undefined
          ? undefined
          : committedRows.get(committedOrdinal);
      if (!message)
        throw new Error(`Logical turn row is missing at ordinal ${ordinal}`);
      messages.push(message);
    }
    const messageOrdinals = Object.fromEntries(
      messages.map((message, position) => [message.id, ordered[position]]),
    );
    return {
      messages,
      view: 'turns',
      turns: pageTurns,
      totalMessages: context.totalCount,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      messageOrdinals,
      transcriptRevision,
      ...(!owner && historyBefore !== undefined && historyBefore > 0
        ? { before: historyBefore }
        : {}),
    };
  }

  /**
   * Check anchor semantics against active rows and committed membership.
   * WAL validation uses verified locators first and scans only for candidate
   * rows whose locator is missing or invalid; it never repairs the index.
   */
  private async validateActiveAnchorSet(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    anchors: ReadonlyMap<string, ActiveRowAnchor>,
    readOnlyCommitted = false,
  ): Promise<void> {
    if (anchors.size === 0) return;
    const normalized = copyActiveRowAnchors(anchors);
    if (!normalized) return;

    const activeById = new Map(
      messages.map((message) => [message.id, message]),
    );
    const activeIds = new Set(activeById.keys());
    const candidateIds = new Set<string>();
    for (const rowAnchor of Array.from(normalized.values())) {
      if (!activeIds.has(rowAnchor.runId)) candidateIds.add(rowAnchor.runId);
      if (rowAnchor.after !== null && !activeIds.has(rowAnchor.after))
        candidateIds.add(rowAnchor.after);
    }

    const committedById = new Map<string, PersistedChatMessage>();
    if (readOnlyCommitted) {
      if (candidateIds.size > 0) {
        const fallbackIds = new Set<string>();
        const candidateIdList: string[] = [];
        candidateIds.forEach((id: string): void => {
          candidateIdList.push(id);
        });
        for (const id of candidateIdList) {
          const located = await this.readCommittedMessageAtLocator(chatId, id);
          if (located.valid) committedById.set(id, located.message);
          else fallbackIds.add(id);
        }
        if (fallbackIds.size > 0) {
          try {
            for await (const row of lines(this.path(chatId, 'jsonl'))) {
              if (fallbackIds.has(row.message.id)) {
                committedById.set(row.message.id, row.message);
                fallbackIds.delete(row.message.id);
                if (fallbackIds.size === 0) break;
              }
            }
          } catch (error) {
            if (!(isErrnoException(error) && error.code === 'ENOENT'))
              throw error;
          }
        }
      }
    } else {
      for (const id of Array.from(candidateIds)) {
        const message = await this.readCommittedMessage(chatId, id);
        if (message) committedById.set(id, message);
      }
    }

    const knownRunCardIds = new Set<string>();
    for (const message of Array.from(activeById.values()))
      if (hasDelegatedAgentCall(message)) knownRunCardIds.add(message.id);
    for (const message of Array.from(committedById.values()))
      if (hasDelegatedAgentCall(message)) knownRunCardIds.add(message.id);

    const result = validateActiveRowAnchorSet(normalized, {
      isCommittedMessage: (id) => committedById.has(id),
      activeIds,
      runIdForMessage: (id) =>
        runIdForActiveMessage(activeById.get(id) ?? committedById.get(id)),
      knownRunCardIds,
    });
    if (!result.valid)
      throw new Error(`Invalid active row anchor: ${result.reason}`);
  }

  private async writeIndex(chatId: string, index: SparseIndex): Promise<void> {
    if (this.options.readOnly) return;
    await atomicJson(this.path(chatId, 'index.json'), {
      ...index,
      checksum: indexChecksum(index),
    });
  }

  private assertWritable(): void {
    if (this.options.readOnly) throw new Error('Transcript store is read-only');
  }

  protected async serial<T>(
    chatId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    this.paths.assertKey(chatId);
    const pending = (this.tails.get(chatId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    this.tails.set(chatId, pending);
    try {
      return await pending;
    } catch (error) {
      this.loaded.delete(chatId);
      activeSnapshots.delete(this.path(chatId, 'active.json'));
      recentCommittedPages.delete(this.path(chatId, 'jsonl'));
      turnPageRowBytes.delete(this.path(chatId, 'jsonl'));
      throw error;
    } finally {
      if (this.tails.get(chatId) === pending) this.tails.delete(chatId);
    }
  }

  protected async active(chatId: string): Promise<ActiveSidecar | undefined> {
    const path = this.path(chatId, 'active.json');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let before: { stamp: string; bytes: number };
      try {
        before = await fileIdentity(path);
      } catch (error) {
        activeSnapshots.delete(path);
        if (isErrnoException(error) && error.code === 'ENOENT')
          return undefined;
        throw error;
      }
      const cached = activeSnapshots.get(path, before.stamp);
      if (cached) return cached;
      let parsed: ActiveSidecar | undefined;
      let readError: unknown;
      try {
        parsed = await this.readActiveUncached(chatId);
      } catch (error) {
        readError = error;
      }
      let after: { stamp: string; bytes: number };
      try {
        after = await fileIdentity(path);
      } catch (error) {
        activeSnapshots.delete(path);
        if (isErrnoException(error) && error.code === 'ENOENT') {
          if (attempt < 2) continue;
          return undefined;
        }
        throw error;
      }
      if (before.stamp !== after.stamp || parsed === undefined) {
        activeSnapshots.delete(path);
        if (before.stamp === after.stamp && readError)
          throw errorFromUnknown(readError);
        if (attempt < 2) continue;
        throw new Error('Active transcript sidecar changed during read');
      }
      activeSnapshots.set(path, after.stamp, after.bytes, parsed);
      rememberActiveAnchors(path, after.stamp, parsed.activeRowAnchors);
      return parsed;
    }
    throw new Error('Active transcript sidecar changed during read');
  }

  /**
   * Copy just cached anchors on write paths that already have their message
   * projection. A cache miss falls back to the verified sidecar reader.
   */
  private async activeRowAnchorsForWrite(
    chatId: string,
  ): Promise<Map<string, ActiveRowAnchor>> {
    const path = this.path(chatId, 'active.json');
    try {
      const identity = await fileIdentity(path);
      const known = knownActiveAnchors.get(path);
      if (known?.stamp === identity.stamp)
        return (
          copyActiveRowAnchors(known.anchors) ??
          new Map<string, ActiveRowAnchor>()
        );
      const cached = activeSnapshots.getProjected(
        path,
        identity.stamp,
        (sidecar) => copyActiveRowAnchors(sidecar.activeRowAnchors),
      );
      if (cached.hit) return cached.value ?? new Map<string, ActiveRowAnchor>();
    } catch (error) {
      if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
      activeSnapshots.delete(path);
      knownActiveAnchors.delete(path);
      return new Map<string, ActiveRowAnchor>();
    }
    const active = await this.active(chatId);
    return (
      copyActiveRowAnchors(active?.activeRowAnchors) ??
      new Map<string, ActiveRowAnchor>()
    );
  }

  private async readActiveUncached(
    chatId: string,
  ): Promise<ActiveSidecar | undefined> {
    const path = this.path(chatId, 'active.json');
    let version: number | undefined;
    try {
      const handle = await open(path, 'r');
      try {
        const prefix = Buffer.alloc(1024);
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        const match = /"version"\s*:\s*(\d+)/.exec(
          prefix.subarray(0, bytesRead).toString('utf8'),
        );
        version = match ? Number(match[1]) : undefined;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
    if (version === 2) {
      let header: ActiveSidecarHeaderV2 | undefined;
      const messages: PersistedChatMessage[] = [];
      const anchorTuples: Array<[string, ActiveRowAnchor]> = [];
      const finalizingIds: string[] = [];
      for await (const row of activeRows(path)) {
        if (!header) {
          if (!isActiveSidecarHeaderV2(row))
            throw new Error('Invalid active transcript sidecar header');
          header = row;
          continue;
        }
        if (!isActiveSidecarMessageV2(row))
          throw new Error('Invalid active transcript sidecar message');
        const rowAnchor = parseSidecarRowAnchor(row);
        messages.push(row.message);
        if (rowAnchor) anchorTuples.push([row.message.id, rowAnchor]);
        if (row.finalizing) finalizingIds.push(row.message.id);
      }
      if (
        !header ||
        (header.finalizing?.child
          ? finalizingIds.length !== 0
          : finalizingIds.length > 0 !== !!header.finalizing)
      )
        throw new Error('Invalid active transcript finalization state');
      const decodedAnchors = decodeActiveRowAnchors(anchorTuples);
      if (decodedAnchors.status === 'invalid')
        throw new Error(
          `Invalid active transcript sidecar anchors: ${decodedAnchors.reason}`,
        );
      return {
        version: 1,
        transcriptRevision: header.transcriptRevision,
        updatedAt: header.updatedAt,
        messages,
        ...(decodedAnchors.anchors.size > 0
          ? { activeRowAnchors: decodedAnchors.anchors }
          : {}),
        ...(header.finalizing
          ? {
              finalizing: {
                ...header.finalizing,
                messageIds: header.finalizing.child
                  ? (header.finalizing.messageIds ?? [])
                  : finalizingIds,
              },
            }
          : {}),
      };
    }
    if (version !== 1) throw new Error('Invalid active transcript sidecar');
    const parsed = await readLegacyActiveSidecar(path);
    if (!isActiveSidecar(parsed))
      throw new Error('Invalid active transcript sidecar');
    return parsed;
  }

  private async committedRecentPage(
    chatId: string,
    index: SparseIndex,
  ): Promise<CommittedRecentPage> {
    const path = this.path(chatId, 'jsonl');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await fileIdentity(path);
      const identity = `${index.committedDigest}:${index.committedMessageCount}:${index.committedByteLength}:${index.latestHuman?.ordinal ?? -1}:${index.latestHuman?.offset ?? -1}:${before.stamp}`;
      const cached = recentCommittedPages.get(path, identity);
      if (cached) return cached;
      const pending = inFlightRecentCommittedPages.get(path);
      const read =
        pending?.identity === identity
          ? pending
          : {
              identity,
              promise: this.readCommittedRecentPageAttempt(
                path,
                index,
                identity,
                before,
              ),
            };
      if (read !== pending) inFlightRecentCommittedPages.set(path, read);
      let page: CommittedRecentPage | undefined;
      try {
        page = await read.promise;
      } finally {
        if (inFlightRecentCommittedPages.get(path)?.promise === read.promise)
          inFlightRecentCommittedPages.delete(path);
      }
      if (page !== undefined) return structuredClone(page);
      recentCommittedPages.delete(path);
      if (attempt < 2) continue;
      throw new Error('Committed transcript changed during page read');
    }
    throw new Error('Committed transcript changed during page read');
  }

  private async readCommittedRecentPageAttempt(
    path: string,
    index: SparseIndex,
    identity: string,
    before: { stamp: string; bytes: number },
  ): Promise<CommittedRecentPage | undefined> {
    let page: CommittedRecentPage | undefined;
    let pageBytes = 256;
    let readError: unknown;
    try {
      const end = index.committedMessageCount;
      const start = Math.max(0, end - TRANSCRIPT_PAGE_SIZE);
      const checkpoint = [...index.offsets]
        .reverse()
        .find((entry) => entry.ordinal <= start);
      const messages: PersistedChatMessage[] = [];
      if (checkpoint && start < end) {
        let ordinal = checkpoint.ordinal;
        for await (const row of lines(path, checkpoint.offset)) {
          if (ordinal >= start && ordinal < end) {
            messages.push(row.message);
            pageBytes += row.end - row.offset;
          }
          ordinal += 1;
          if (ordinal >= end) break;
        }
      }
      if (messages.length !== end - start)
        throw new Error('Committed transcript page is incomplete');
      let latestHumanMessage: PersistedChatMessage | undefined;
      if (index.latestHuman) {
        if (
          index.latestHuman.ordinal >= start &&
          index.latestHuman.ordinal < end
        )
          latestHumanMessage = messages[index.latestHuman.ordinal - start];
        else
          for await (const row of lines(path, index.latestHuman.offset)) {
            latestHumanMessage = row.message;
            pageBytes += row.end - row.offset;
            break;
          }
      }
      page = {
        messages,
        ...(latestHumanMessage ? { latestHumanMessage } : {}),
      };
    } catch (error) {
      readError = error;
    }
    const after = await fileIdentity(path);
    if (before.stamp !== after.stamp) {
      recentCommittedPages.delete(path);
      return undefined;
    }
    if (readError) throw errorFromUnknown(readError);
    if (!page) throw new Error('Committed transcript page is unavailable');
    recentCommittedPages.set(path, identity, pageBytes, page);
    return page;
  }

  private remember(chatId: string, value: LoadedLog): void {
    this.loaded.delete(chatId);
    this.loaded.set(chatId, value);
    while (this.loaded.size > MAX_LOADED_LOGS) {
      const oldest = this.loaded.keys().next().value;
      if (oldest === undefined) break;
      this.loaded.delete(oldest);
    }
  }

  private async load(
    chatId: string,
    rebuildLocators = false,
  ): Promise<LoadedLog> {
    const cached = this.loaded.get(chatId);
    const locatorStamp = await this.locatorStamp(chatId);
    if (!rebuildLocators && cached?.locatorStamp === locatorStamp)
      return cached;
    if (!this.options.readOnly)
      await mkdir(this.paths.directory(chatId), { recursive: true });
    // Only an explicit initializer may create a missing log. Missing files for
    // an indexed chat are recovery errors, never interpreted as empty history.
    let active = await this.active(chatId);
    await this.removeOrphanedStagedAppends(
      chatId,
      active?.finalizing?.stagedId,
    );
    if (active?.finalizing) {
      this.assertWritable();
      active = await this.finishOrAbandonAppend(chatId, active);
    }
    let persistedRevision = 0;
    {
      let persisted: SparseIndex | undefined;
      try {
        const parsed: unknown = JSON.parse(
          await readFile(this.path(chatId, 'index.json'), 'utf8'),
        );
        if (!isSparseIndexWithChecksum(parsed))
          throw new SyntaxError('Invalid sparse transcript index');
        const { checksum, ...candidate } = parsed;
        const size = (await stat(this.path(chatId, 'jsonl'))).size;
        if (
          Number.isSafeInteger(candidate?.transcriptRevision) &&
          candidate.transcriptRevision >= 0
        )
          persistedRevision = candidate.transcriptRevision;
        const trusted =
          candidate.version === 3 &&
          checksum === indexChecksum(candidate) &&
          candidate.format === 'complete-message-jsonl-v1';
        // A verified index that describes more bytes than the log holds is a
        // truncated transcript. Rebuilding would silently shorten the chat.
        if (trusted && candidate.committedByteLength > size)
          throw new ChatTranscriptIntegrityError(
            `Transcript ${chatId} is shorter than its committed index: ${size} of ${candidate.committedByteLength} bytes`,
          );
        const indexedByteLength = candidate.committedByteLength;
        if (
          trusted &&
          Number.isSafeInteger(candidate.committedMessageCount) &&
          candidate.committedMessageCount >= 0 &&
          (candidate.committedMessageCount === 0
            ? indexedByteLength === 0
            : indexedByteLength > 0) &&
          (indexedByteLength === size ||
            (active?.finalizing !== undefined &&
              hasExactAppendRevisionMarker(
                active.finalizing.explicitRevision,
                active.finalizing,
                active.transcriptRevision,
              ) &&
              !this.options.childMode &&
              indexedByteLength === active.finalizing.byteOffset)) &&
          Number.isSafeInteger(candidate.transcriptRevision) &&
          Array.isArray(candidate.offsets) &&
          candidate.offsets.length ===
            Math.ceil(candidate.committedMessageCount / SPARSE_STRIDE) &&
          candidate.offsets.every(
            (entry, i) =>
              entry.ordinal === i * SPARSE_STRIDE &&
              Number.isSafeInteger(entry.offset) &&
              entry.offset >= 0 &&
              entry.offset < indexedByteLength &&
              (i === 0
                ? entry.offset === 0
                : entry.offset > candidate.offsets[i - 1].offset),
          ) &&
          (candidate.latestHuman === undefined ||
            (candidate.latestHuman.offset >= 0 &&
              candidate.latestHuman.offset < indexedByteLength &&
              candidate.latestHuman.ordinal >= 0 &&
              candidate.latestHuman.ordinal < candidate.committedMessageCount))
        ) {
          const {
            version,
            format,
            committedMessageCount,
            committedByteLength,
            committedDigest,
            transcriptRevision,
            hasActiveSidecar,
            offsets,
            reducerFrame,
            ...metadata
          } = candidate;
          // Match a freshly built index, even when an earlier loader moved
          // the frame to the end. Reserve its slot before refolding, too:
          // property order is part of the serialized bytes and checksum.
          persisted = {
            version,
            format,
            committedMessageCount,
            committedByteLength,
            committedDigest,
            transcriptRevision,
            hasActiveSidecar,
            offsets,
            reducerFrame: isSparseReducerFrame(
              reducerFrame,
              committedMessageCount,
              committedByteLength,
            )
              ? reducerFrame
              : undefined,
            ...metadata,
          };
          if (
            indexedByteLength !== size &&
            active?.finalizing !== undefined &&
            hasExactAppendRevisionMarker(
              active.finalizing.explicitRevision,
              active.finalizing,
              active.transcriptRevision,
            ) &&
            !this.options.childMode
          ) {
            if (
              isSparseReducerFrame(
                persisted.reducerFrame,
                persisted.committedMessageCount,
                persisted.committedByteLength,
              )
            )
              persisted = await this.extendRecoveredAppendIndex(
                chatId,
                persisted,
                active,
                size,
              );
            else persisted = undefined;
          }
        }
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(isErrnoException(error) && error.code === 'ENOENT')
        )
          throw error;
      }
      if (persisted && !rebuildLocators) {
        const locatorsComplete =
          this.options.childMode ||
          (await this.locatorsComplete(
            chatId,
            persisted.committedMessageCount,
          ));
        if (locatorsComplete || this.options.readOnly) {
          // A frame that is missing (written before the frame existed),
          // stale or malformed is folded again from the log; the index keeps
          // its locators and revision.
          if (!persisted.reducerFrame) {
            persisted.reducerFrame = await this.foldReducerFrameFromLog(
              chatId,
              persisted.committedMessageCount,
            );
            if (!this.options.readOnly)
              await this.writeIndex(chatId, persisted);
          }
          const result = { index: persisted, locatorStamp, locatorsComplete };
          this.remember(chatId, result);
          if (active?.finalizing) await this.clearFinalized(chatId, active);
          return result;
        }
      }
    }
    const index: SparseIndex = {
      version: 3,
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 0,
      committedByteLength: 0,
      committedDigest: EMPTY_COMMITTED_DIGEST,
      transcriptRevision: 0,
      hasActiveSidecar: false,
      offsets: [],
      reducerFrame: emptySparseReducerFrame(),
    };
    const activeIds = new Set(
      active?.messages.map((message) => message.id) ?? [],
    );
    const committedActiveIds = new Set<string>();
    const locatorTemporary = `${this.locatorDirectory(chatId)}.${randomUUID()}.tmp`;
    const locatorBatch: Array<{ path: string; locator: MessageLocator }> = [];
    if (!this.options.readOnly && !this.options.childMode)
      await mkdir(locatorTemporary, { recursive: true });
    try {
      for await (const row of lines(this.path(chatId, 'jsonl'))) {
        const locatorPath = join(
          locatorTemporary,
          `${createHash('sha256').update(row.message.id).digest('hex')}.json`,
        );
        if (!this.options.readOnly && !this.options.childMode) {
          locatorBatch.push({
            path: locatorPath,
            locator: {
              version: 1,
              messageId: row.message.id,
              offset: row.offset,
              end: row.end,
              digest: digest(row.message),
            },
          });
          if (locatorBatch.length === 64) await flushLocatorBatch(locatorBatch);
        }
        if (activeIds.has(row.message.id))
          committedActiveIds.add(row.message.id);
        const logical = row.message.blocksRef
          ? await this.expandBlocks(chatId, row.message)
          : row.message;
        this.record(
          index,
          row.message,
          row.offset,
          row.end,
          undefined,
          logical,
        );
      }
      if (!this.options.readOnly && !this.options.childMode) {
        await flushLocatorBatch(locatorBatch);
        await fsyncDirectory(locatorTemporary);
        await mkdir(this.paths.locatorParent(chatId), { recursive: true });
        await rm(this.locatorDirectory(chatId), {
          recursive: true,
          force: true,
        });
        await rename(locatorTemporary, this.locatorDirectory(chatId));
        recordChatStorageAtomicReplacement(this.locatorDirectory(chatId));
        await fsyncDirectory(this.paths.locatorParent(chatId));
      }
    } finally {
      if (!this.options.readOnly && !this.options.childMode)
        await rm(locatorTemporary, { recursive: true, force: true });
    }
    index.hasActiveSidecar =
      active?.messages.some((message) => !committedActiveIds.has(message.id)) ??
      false;
    const finalizingIds = new Set(active?.finalizing?.messageIds ?? []);
    const survivingAnchors = survivingActiveRowAnchors(
      active?.messages.filter((message) => !finalizingIds.has(message.id)) ??
        [],
      active?.activeRowAnchors,
    );
    if (survivingAnchors.size > 0) {
      index.hasOrdinaryActiveRows =
        active?.messages.some(
          (message) =>
            !committedActiveIds.has(message.id) &&
            !finalizingIds.has(message.id) &&
            !survivingAnchors.has(message.id),
        ) ?? false;
    }
    index.transcriptRevision = Math.max(
      persistedRevision,
      active?.transcriptRevision ?? 0,
      index.committedMessageCount,
    );
    const fresh: LoadedLog = {
      index,
      locatorStamp: await this.locatorStamp(chatId),
      locatorsComplete: !this.options.readOnly,
    };
    // Rebuild in place: a caller holding the cached object across a forced
    // reload keeps writing the index this cache serves. No identity set
    // survives into the new generation.
    const result = cached ?? fresh;
    if (cached) {
      delete cached.committedLocatorKeys;
      delete cached.committedLocatorInventoryUnavailable;
      delete cached.committedLocatorInventoryBuild;
      delete cached.uncommitted;
      Object.assign(cached, fresh);
    }
    await this.writeIndex(chatId, index);
    if (active?.finalizing) await this.clearFinalized(chatId, active);
    this.remember(chatId, result);
    return result;
  }

  /**
   * Extend a verified old index from the exact staged append after log append
   * but before index publication. This avoids rebuilding derived state from
   * the committed prefix during the ordinary append-recovery window.
   */
  private async extendRecoveredAppendIndex(
    chatId: string,
    index: SparseIndex,
    pending: ActiveSidecar,
    logSize: number,
  ): Promise<SparseIndex> {
    const intent = pending.finalizing;
    if (
      !intent ||
      !hasExactAppendRevisionMarker(
        intent.explicitRevision,
        intent,
        pending.transcriptRevision,
      ) ||
      intent.child ||
      !Number.isSafeInteger(intent.byteOffset) ||
      index.committedByteLength !== intent.byteOffset
    )
      throw new Error('Invalid transcript append recovery base');

    const stagedPath = this.paths.stagedAppendFile(chatId, intent.stagedId);
    const stagedSize = (await stat(stagedPath)).size;
    if (logSize !== intent.byteOffset + stagedSize)
      throw new Error('Recovered transcript append extent differs from intent');

    const stagedMessages: PersistedChatMessage[] = [];
    for await (const row of lines(stagedPath)) stagedMessages.push(row.message);
    if (
      stagedMessages.length === 0 ||
      stagedMessages.length !== intent.messageIds.length ||
      !stagedMessages.every(
        (message, position) =>
          message.id === intent.messageIds[position] &&
          pending.messages.some(
            (candidate) =>
              candidate.id === message.id &&
              digest(candidate) === digest(message),
          ),
      )
    )
      throw new Error(
        'Recovered staged append differs from its durable intent',
      );

    const locatorRows: Array<{
      message: PersistedChatMessage;
      offset: number;
      end: number;
    }> = [];
    // Replacement drops active-only metadata before recording final rows, as
    // `replace` does when it starts a fresh index.
    delete index.hasOrdinaryActiveRows;
    let offset = intent.byteOffset;
    for (const message of stagedMessages) {
      const end =
        offset + Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
      locatorRows.push({ message, offset, end });
      const logical = message.blocksRef
        ? await this.expandBlocks(chatId, message)
        : message;
      this.record(index, message, offset, end, undefined, logical);
      offset = end;
    }
    if (offset !== logSize)
      throw new Error('Recovered staged append byte length differs from log');

    const newLocatorRows: typeof locatorRows = [];
    for (const row of locatorRows) {
      try {
        const parsed: unknown = JSON.parse(
          await readFile(this.locatorPath(chatId, row.message.id), 'utf8'),
        );
        if (
          !isMessageLocator(parsed) ||
          parsed.messageId !== row.message.id ||
          parsed.offset !== row.offset ||
          parsed.end !== row.end ||
          parsed.digest !== digest(row.message)
        )
          throw new Error('Recovered append locator conflicts with staged row');
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
          newLocatorRows.push(row);
          continue;
        }
        throw error;
      }
    }
    await this.writeLocators(chatId, newLocatorRows);

    const finalizingIds = new Set(intent.messageIds);
    const activeRows = pending.messages.filter(
      (message) => !finalizingIds.has(message.id),
    );
    const activeAnchors = survivingActiveRowAnchors(
      activeRows,
      pending.activeRowAnchors,
    );
    index.transcriptRevision = pending.transcriptRevision;
    index.hasActiveSidecar = activeRows.length > 0;
    if (activeAnchors.size > 0)
      index.hasOrdinaryActiveRows = await this.hasOrdinaryActiveRows(
        chatId,
        activeRows,
        activeAnchors,
      );
    else delete index.hasOrdinaryActiveRows;
    await this.writeIndex(chatId, index);
    return index;
  }

  private async foldReducerFrameFromLog(
    chatId: string,
    committedMessageCount: number,
  ): Promise<SparseReducerFrame> {
    let frame = emptyReducerFrameFold<SparseReducerFrameReference>();
    let ordinal = 0;
    if (committedMessageCount > 0)
      for await (const row of lines(this.path(chatId, 'jsonl'))) {
        frame = foldReducerFrame(frame, row.message, {
          id: row.message.id,
          ordinal,
          offset: row.offset,
        });
        ordinal += 1;
        if (ordinal >= committedMessageCount) break;
      }
    return { ...frame, version: 1, messageCount: ordinal };
  }

  private record(
    index: SparseIndex,
    message: PersistedChatMessage,
    offset: number,
    end: number,
    rowDigest = digest(message),
    logicalMessage: PersistedChatMessage = message,
  ): void {
    const ordinal = index.committedMessageCount;
    const reference: SparseReducerFrameReference = {
      id: message.id,
      ordinal,
      offset,
    };
    const foldedReducerFrame = foldReducerFrame(
      index.reducerFrame ?? emptySparseReducerFrame(),
      message,
      reference,
    );
    index.reducerFrame = {
      ...foldedReducerFrame,
      version: 1,
      messageCount: ordinal + 1,
    };
    if (ordinal % SPARSE_STRIDE === 0) index.offsets.push({ ordinal, offset });
    if (isHumanAuthoredUserMessage(message))
      index.latestHuman = { ordinal, offset };
    index.firstMessageAt ??= message.timestamp;
    index.lastMessageAt = message.timestamp;
    index.lastMessageId = message.id;
    if (message.role === 'user' || message.role === 'assistant')
      index.lastMessageRole = message.role;
    const preview = assistantPreview(logicalMessage);
    if (preview) index.lastAssistantPreview = preview;
    Object.assign(index, foldTranscriptTodoState(index, logicalMessage));
    index.committedMessageCount += 1;
    if (message.role === 'user')
      index.userMessageCount = (index.userMessageCount ?? 0) + 1;
    index.committedByteLength = end;
    index.committedDigest = extendCommittedDigest(
      index.committedDigest,
      rowDigest,
    );
  }

  public async initialize(chatId: string): Promise<void> {
    this.assertWritable();
    await this.serial(chatId, async () => {
      activeSnapshots.delete(this.path(chatId, 'active.json'));
      recentCommittedPages.delete(this.path(chatId, 'jsonl'));
      turnPageRowBytes.delete(this.path(chatId, 'jsonl'));
      await mkdir(this.paths.directory(chatId), { recursive: true });
      const handle = await open(this.path(chatId, 'jsonl'), 'ax', 0o600);
      try {
        await handle.sync();
        recordChatStorageFileSync(this.path(chatId, 'jsonl'));
      } finally {
        await handle.close();
      }
      await fsyncDirectory(this.paths.directory(chatId));
    });
  }

  public async descriptor(chatId: string): Promise<TranscriptDescriptor> {
    return this.serial(chatId, async () => {
      const { index } = await this.load(chatId);
      const {
        offsets: _offsets,
        latestHuman: _human,
        reducerFrame: _reducerFrame,
        version: _version,
        ...descriptor
      } = index;
      void _offsets;
      void _human;
      void _reducerFrame;
      void _version;
      const projection = this.projectedActive(chatId);
      const activeSidecar = projection ? undefined : await this.active(chatId);
      const active = projection
        ? [...projection.messages]
        : (activeSidecar?.messages ?? []);
      const anchors = projection
        ? survivingActiveRowAnchors(
            active,
            copyActiveRowAnchors(projection.anchors),
          )
        : activeSidecar?.activeRowAnchors;
      if (anchors && anchors.size > 0) {
        const logicalBase = projection
          ? {
              ...descriptor,
              transcriptRevision: projection.transcriptRevision,
              hasActiveSidecar: projection.messages.length > 0,
            }
          : descriptor;
        const logical = await this.logicalDescriptor(
          chatId,
          index,
          logicalBase,
          await this.logicalReadContext(chatId, index, active, anchors),
        );
        if (!projection)
          await this.persistOrdinaryActiveMetadata(
            chatId,
            index,
            true,
            logical.hasOrdinaryActiveRows === true,
          );
        return logical;
      }
      let preview: string | undefined;
      let lastMessageRole = descriptor.lastMessageRole;
      const todos = {
        todos: descriptor.todos,
        taskTodos: descriptor.taskTodos,
      };
      for (const message of active) {
        if (message.role === 'user' || message.role === 'assistant')
          lastMessageRole = message.role;
        const logical = message.blocksRef
          ? await this.expandBlocks(chatId, message)
          : message;
        Object.assign(todos, foldTranscriptTodoState(todos, logical));
        preview = assistantPreview(logical) ?? preview;
      }
      const result: TranscriptDescriptor = {
        ...descriptor,
        ...(lastMessageRole === 'user' || lastMessageRole === 'assistant'
          ? { lastMessageRole }
          : {}),
        // Existing keys keep their positions, as in the index a checkpoint
        // writes after applying the journaled active rows.
        ...(projection
          ? {
              transcriptRevision: projection.transcriptRevision,
              hasActiveSidecar: projection.messages.length > 0,
            }
          : {}),
        ...todos,
        ...(preview ? { lastAssistantPreview: preview } : {}),
        messageCount: index.committedMessageCount + active.length,
        userMessageCount:
          (index.userMessageCount ?? 0) +
          active.filter((message) => message.role === 'user').length,
        ...(active.length
          ? {
              lastMessageAt: active[active.length - 1].timestamp,
              lastMessageId: active[active.length - 1].id,
              firstMessageAt: index.firstMessageAt ?? active[0].timestamp,
            }
          : {}),
      };
      if (anchors && anchors.size > 0)
        result.hasOrdinaryActiveRows = await this.hasOrdinaryActiveRows(
          chatId,
          active,
          anchors,
        );
      else delete result.hasOrdinaryActiveRows;
      if (!projection)
        await this.persistOrdinaryActiveMetadata(
          chatId,
          index,
          anchors !== undefined && anchors.size > 0,
          result.hasOrdinaryActiveRows === true,
        );
      return result;
    });
  }

  private async readActiveSnapshot(
    chatId: string,
    includeAnchors: boolean,
  ): Promise<{
    messages: PersistedChatMessage[];
    anchors?: Map<string, ActiveRowAnchor>;
  }> {
    await this.load(chatId);
    const projection = this.projectedActive(chatId);
    if (projection) {
      const anchors = includeAnchors
        ? survivingActiveRowAnchors(
            projection.messages,
            copyActiveRowAnchors(projection.anchors),
          )
        : undefined;
      return {
        messages: [...projection.messages],
        ...(anchors && anchors.size > 0 ? { anchors } : {}),
      };
    }
    const active = await this.active(chatId);
    const anchors = includeAnchors
      ? copyActiveRowAnchors(active?.activeRowAnchors)
      : undefined;
    return {
      messages: active?.messages ?? [],
      ...(anchors && anchors.size > 0 ? { anchors } : {}),
    };
  }

  public async activeMessages(chatId: string): Promise<PersistedChatMessage[]> {
    const finishPerformanceStage = beginMainTranscriptPerformanceStage(
      'active_tail_reconstruction',
      chatId,
    );
    return this.serial(chatId, async () => {
      const { messages } = await this.readActiveSnapshot(chatId, false);
      finishPerformanceStage({ loadedRows: messages.length });
      return messages;
    });
  }

  /**
   * Atomically snapshot the active rows plus their record anchors: what a
   * checkpoint must preserve across finalization, and what tells an ordered
   * read whether anchors place rows (`anchors` is absent when none do).
   * Journal projections are authoritative for messages and their snapshot
   * anchors, matching the durable sidecar shape after checkpoint.
   */
  public async activeSnapshot(chatId: string): Promise<{
    messages: PersistedChatMessage[];
    anchors?: Map<string, ActiveRowAnchor>;
  }> {
    const finishPerformanceStage = beginMainTranscriptPerformanceStage(
      'active_tail_reconstruction',
      chatId,
    );
    return this.serial(chatId, async () => {
      const snapshot = await this.readActiveSnapshot(chatId, true);
      finishPerformanceStage({ loadedRows: snapshot.messages.length });
      return snapshot;
    });
  }

  public async ownsToolOutputReference(
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedToolOutputReference,
  ): Promise<boolean> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      const committed = await this.readCommittedMessage(chatId, messageId);
      if (committed) {
        if (committed.blocksRef === undefined) {
          if (messageOwnsToolOutput(committed, messageId, toolUseId, reference))
            return true;
        } else if (
          await pagedMessageOwnsToolOutput(
            this.artifacts,
            this.paths.owner(chatId),
            committed,
            messageId,
            toolUseId,
            reference,
          )
        )
          return true;
      }
      const active =
        this.projectedActive(chatId)?.messages ??
        (await this.active(chatId))?.messages ??
        [];
      for (const message of active) {
        if (message.id !== messageId) continue;
        if (message.blocksRef === undefined) {
          if (messageOwnsToolOutput(message, messageId, toolUseId, reference))
            return true;
          continue;
        }
        if (
          await pagedMessageOwnsToolOutput(
            this.artifacts,
            this.paths.owner(chatId),
            message,
            messageId,
            toolUseId,
            reference,
          )
        )
          return true;
      }
      return false;
    });
  }

  /**
   * A verified byte range of one body field of a retained row. The row must
   * carry a reference for exactly that field, unless logical mode opts into
   * inline fallback. Foreign references and bad offsets still fail explicitly.
   */
  public async readFieldRange(
    streamKey: string,
    messageId: string,
    selector: { blockOrdinal: number; field: TranscriptBodyField },
    offset = 0,
    limit = 65_536,
    signal?: AbortSignal,
    fieldSource?: 'stored' | 'logical',
  ): Promise<{ text: string; nextOffset?: number; byteLength: number }> {
    const row = await this.readMessage(streamKey, messageId);
    const block = row
      ? await ownedBodyBlock(
          this.artifacts,
          this.paths.owner(streamKey),
          row,
          selector,
          signal,
        )
      : undefined;
    const reference = block
      ? transcriptBodyReferences({ blocks: [block] }).find(
          (entry) => entry.field === selector.field,
        )?.reference
      : undefined;
    if (reference) {
      return this.artifacts.readRange(
        this.paths.owner(streamKey),
        reference,
        offset,
        limit,
        signal,
      );
    }
    const inline =
      fieldSource === 'logical' && block
        ? inlineBodyField(block, selector.field)
        : undefined;
    if (inline === undefined)
      throw new Error('Transcript field has no stored body for this row');
    const range = readInlineBodyRange(inline, offset, limit);
    return {
      text: range.text,
      byteLength: range.byteLength,
      ...(range.nextOffset === undefined
        ? {}
        : { nextOffset: range.nextOffset }),
    };
  }

  public async ownsVisualReference(
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedVisualReference,
  ): Promise<boolean> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      // A paged row's blocks live in its pages.
      const owns = async (message: PersistedChatMessage): Promise<boolean> =>
        message.id === messageId &&
        messageOwnsVisual(
          message.blocksRef
            ? await this.expandBlocks(chatId, message)
            : message,
          messageId,
          toolUseId,
          reference,
        );
      const committed = await this.readCommittedMessage(chatId, messageId);
      if (committed && (await owns(committed))) return true;
      const active =
        this.projectedActive(chatId)?.messages ??
        (await this.active(chatId))?.messages ??
        [];
      for (const message of active) if (await owns(message)) return true;
      return false;
    });
  }

  public async committedMessageState(
    chatId: string,
    message: PersistedChatMessage,
  ): Promise<'absent' | 'identical' | 'different'> {
    return this.withCommittedMessageStates(chatId, (reader) =>
      reader.committedMessageState(message),
    );
  }

  /**
   * Resolve committed identities against one loaded locator generation. The
   * callback is serialized with every other operation for this chat, while
   * repeated row checks reuse the same validated generation.
   */
  public async withCommittedMessageStates<T>(
    chatId: string,
    operation: (reader: CommittedMessageStateReader) => Promise<T> | T,
  ): Promise<T> {
    return this.serial(chatId, async () => {
      const loaded = await this.load(chatId);
      const reader: CommittedMessageStateReader = {
        committedMessageState: async (
          message: PersistedChatMessage,
        ): Promise<'absent' | 'identical' | 'different'> => {
          const existing = await this.readCommittedMessageForGeneration(
            chatId,
            loaded,
            message.id,
            true,
          );
          // The writers' rule (CAN-6902): a committed row that is the final
          // form of this open row is the same message.
          return existing === undefined
            ? 'absent'
            : (await this.matchesCommitted(chatId, message, existing))
              ? 'identical'
              : 'different';
        },
        hasCommittedMessage: async (messageId: string): Promise<boolean> =>
          (await this.readCommittedMessageForGeneration(
            chatId,
            loaded,
            messageId,
            true,
          )) !== undefined,
      };
      return operation(reader);
    });
  }

  /** The committed row with this id, read through its locator. */
  public async committedMessage(
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      return this.readCommittedMessage(chatId, messageId);
    });
  }

  public async hasCommittedMessage(
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.withCommittedMessageStates(chatId, (reader) =>
      reader.hasCommittedMessage(messageId),
    );
  }

  /**
   * The id of the last committed row, from the chat's index without reading
   * the transcript. `undefined` when no row is committed, or when an older
   * index does not record it.
   */
  public async lastCommittedMessageId(
    chatId: string,
  ): Promise<string | undefined> {
    return this.serial(chatId, async () => {
      const { index } = await this.load(chatId);
      return index.committedMessageCount > 0 ? index.lastMessageId : undefined;
    });
  }

  /**
   * A committed row and the contiguous rows after it whose `parentBlockId` is
   * its id (its direct-child group), read from the row's locator without
   * scanning earlier history. `undefined` when the row is not committed.
   */
  public async readCommittedGroup(
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage[] | undefined> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      const head = await this.readCommittedMessage(chatId, messageId);
      if (!head) return undefined;
      const group = [head];
      let end: number | undefined;
      try {
        const parsed: unknown = JSON.parse(
          await readFile(this.locatorPath(chatId, messageId), 'utf8'),
        );
        if (isMessageLocator(parsed) && parsed.messageId === messageId)
          end = parsed.end;
      } catch (error) {
        if (
          !(isErrnoException(error) && error.code === 'ENOENT') &&
          !(error instanceof SyntaxError)
        )
          throw error;
      }
      let inGroup = end !== undefined;
      // Without a locator (read-only archives), find the row by scanning, as
      // readCommittedMessage does.
      for await (const row of lines(this.path(chatId, 'jsonl'), end ?? 0)) {
        if (!inGroup) {
          inGroup = row.message.id === messageId;
          continue;
        }
        if (row.message.parentBlockId !== messageId) break;
        group.push(row.message);
      }
      return group;
    });
  }

  /** Read one retained row without materializing its surrounding history. */
  public async readMessage(
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      const active =
        this.projectedActive(chatId)?.messages ??
        (await this.active(chatId))?.messages ??
        [];
      return (
        active.find((message) => message.id === messageId) ??
        (await this.readCommittedMessage(chatId, messageId))
      );
    });
  }

  /**
   * Snapshot the record-level active-row anchors before an ordered transcript
   * replacement removes the sidecar. The returned map and values are fresh.
   */
  public async activeRowAnchors(
    chatId: string,
  ): Promise<Map<string, ActiveRowAnchor>> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      const active = await this.active(chatId);
      return (
        copyActiveRowAnchors(active?.activeRowAnchors) ??
        new Map<string, ActiveRowAnchor>()
      );
    });
  }

  /**
   * Snapshot active messages for recovery validation without calling `load`.
   * This is intentionally read-only: WAL validation must not repair indexes or
   * replay/abandon a pending append before its replacement has been accepted.
   */
  public async activeMessagesForAnchorValidation(
    chatId: string,
  ): Promise<PersistedChatMessage[]> {
    return this.serial(chatId, async () => {
      const active = await this.active(chatId);
      return active?.messages.map((message) => structuredClone(message)) ?? [];
    });
  }

  /**
   * Validate a proposed active projection before publishing it from the WAL.
   * This read-only seam does not call `load`: malformed WAL validation must
   * not replay/abandon an append or repair canonical indexes as a side effect.
   * Explicit map shapes are checked before inactive IDs are filtered.
   */
  public async validateActiveRowAnchors(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    anchors: ReadonlyMap<string, ActiveRowAnchor>,
  ): Promise<void> {
    const explicitAnchors = copyActiveRowAnchors(anchors) ?? new Map();
    await this.serial(chatId, async () => {
      const effectiveAnchors = survivingActiveRowAnchors(
        messages,
        explicitAnchors,
      );
      await this.validateActiveAnchorSet(
        chatId,
        messages,
        effectiveAnchors,
        true,
      );
      for (const message of messages) {
        const rowAnchor = effectiveAnchors.get(message.id);
        if (!rowAnchor) continue;
        const record: ActiveSidecarMessageRecord = {
          version: 2,
          kind: 'message',
          message,
          anchor: rowAnchor,
        };
        const budget = checkActiveSidecarMessageRecordBudget(record);
        if (!budget.withinLimit)
          throw new Error(
            `Active sidecar message record exceeds maximum size (${budget.bytes} of ${budget.ceiling} bytes)`,
          );
      }
    });
  }

  /**
   * Intentional one-chat rewrite (reset, amendment, import). The caller's
   * durable scope transaction retains the source until all indexes commit,
   * and replays this replacement after a crash. Never use a paged projection
   * as an authoritative replacement.
   *
   * An unchanged committed prefix is preserved (`replaceSharedPrefix`): only
   * the changed suffix and its locators are written. Both appends and rewrites
   * with a shared prefix clone the existing log to a temporary file and
   * atomically rename it. Without a trusted baseline or a shared first row,
   * the whole log and a fresh locator directory are written.
   */
  public async replace(
    chatId: string,
    messages:
      | Iterable<PersistedChatMessage>
      | AsyncIterable<PersistedChatMessage>,
    revision: number,
    fields: TranscriptFieldMode = 'legacy',
  ): Promise<void> {
    this.assertWritable();
    await this.serial(chatId, async () => {
      // Monotonic elapsed time inside the serialized operation: queue wait is
      // excluded; publication, syncs and derived-index/cache work are included.
      const startedAt = (
        this.options.now ?? ((): number => performance.now())
      )();
      const index: SparseIndex = {
        version: 3,
        format: 'complete-message-jsonl-v1',
        committedMessageCount: 0,
        committedByteLength: 0,
        committedDigest: EMPTY_COMMITTED_DIGEST,
        transcriptRevision: revision,
        hasActiveSidecar: false,
        offsets: [],
        reducerFrame: emptySparseReducerFrame(),
      };
      const cached = this.loaded.get(chatId);
      const verifiedIndex =
        cached?.locatorsComplete === true &&
        cached.locatorStamp === (await this.locatorStamp(chatId))
          ? {
              committedDigest: cached.index.committedDigest,
              committedMessageCount: cached.index.committedMessageCount,
              committedByteLength: cached.index.committedByteLength,
            }
          : undefined;
      const preserved = await replaceSharedPrefix({
        logPath: this.path(chatId, 'jsonl'),
        indexPath: this.path(chatId, 'index.json'),
        turnsPath: this.path(chatId, 'turns.json'),
        temporaryPath: this.path(chatId, `${randomUUID()}.rewrite.tmp`),
        locatorDirectory: this.locatorDirectory(chatId),
        messages,
        // Every replaced row is committed, hence final.
        externalize: (message) =>
          this.prepareRow(chatId, message, true, fields),
        record: (message, offset, end, rowDigest) =>
          message.blocksRef
            ? this.expandBlocks(chatId, message).then((logical) =>
                this.record(index, message, offset, end, rowDigest, logical),
              )
            : this.record(index, message, offset, end, rowDigest),
        verifiedIndex,
      });
      if (preserved.kind === 'preserved') {
        await this.writeIndex(chatId, index);
        await rm(this.path(chatId, 'active.json'), { force: true });
        if (this.options.testHooks?.onReplaceBoundary)
          await this.options.testHooks.onReplaceBoundary(
            'active-sidecar-removed',
          );
        await fsyncDirectory(this.paths.directory(chatId));
        await this.turnIndex(chatId, index, preserved.reusableTurns);
        this.remember(chatId, {
          index,
          locatorStamp: await this.locatorStamp(chatId),
          locatorsComplete: true,
        });
        this.reportReplacement(chatId, preserved.bytesWritten, startedAt);
        return;
      }
      const replacement = preserved.messages;
      const temporary = this.path(chatId, `${randomUUID()}.rewrite.tmp`);
      const locatorTemporary = `${this.locatorDirectory(chatId)}.${randomUUID()}.tmp`;
      const locatorBatch: Array<{ path: string; locator: MessageLocator }> = [];
      await mkdir(locatorTemporary, { recursive: true });
      const prepareRow = this.prepareRow.bind(this);
      const expandBlocks = this.expandBlocks.bind(this);
      const record = this.record.bind(this);
      let bytesWritten = 0;
      try {
        bytesWritten = await writeJsonValuesCooperatively(
          temporary,
          (async function* (): AsyncGenerator<string> {
            for await (const message of iterateAsync(replacement)) {
              const stored = await prepareRow(chatId, message, true, fields);
              if (!isPersistedChatMessage(stored))
                throw new Error('Invalid or duplicate replacement message');
              const json = JSON.stringify(stored);
              const offset = index.committedByteLength;
              const rowBytes = Buffer.byteLength(json, 'utf8');
              if (rowBytes > MAX_TRANSCRIPT_ROW_BYTES)
                throw new Error('Transcript row exceeds maximum size');
              const end = offset + rowBytes + 1;
              const rowDigest = createHash('sha256').update(json).digest('hex');
              const locatorPath = join(
                locatorTemporary,
                `${createHash('sha256').update(stored.id).digest('hex')}.json`,
              );
              locatorBatch.push({
                path: locatorPath,
                locator: {
                  version: 1,
                  messageId: stored.id,
                  offset,
                  end,
                  digest: rowDigest,
                },
              });
              if (locatorBatch.length === 64)
                await flushLocatorBatch(locatorBatch);
              const logical = stored.blocksRef
                ? await expandBlocks(chatId, stored)
                : stored;
              record(index, stored, offset, end, rowDigest, logical);
              yield json;
            }
          })(),
          {
            pretty: false,
            serializedValues: true,
            separator: '\n',
            trailingSeparator: true,
          },
        );
        await flushLocatorBatch(locatorBatch);
        // A crash must not leave an old but byte-length-compatible sparse index
        // silently describing the replacement log.
        await rm(this.path(chatId, 'turns.json'), { force: true });
        await rm(this.path(chatId, 'index.json'), { force: true });
        await fsyncDirectory(this.paths.directory(chatId));
        await rename(temporary, this.path(chatId, 'jsonl'));
        recordChatStorageAtomicReplacement(this.path(chatId, 'jsonl'));
        await fsyncDirectory(this.paths.directory(chatId));
        await mkdir(this.paths.locatorParent(chatId), { recursive: true });
        await fsyncDirectory(locatorTemporary);
        await rm(this.locatorDirectory(chatId), {
          recursive: true,
          force: true,
        });
        await rename(locatorTemporary, this.locatorDirectory(chatId));
        recordChatStorageAtomicReplacement(this.locatorDirectory(chatId));
        await fsyncDirectory(this.paths.locatorParent(chatId));
        await this.writeIndex(chatId, index);
        await rm(this.path(chatId, 'active.json'), { force: true });
        if (this.options.testHooks?.onReplaceBoundary)
          await this.options.testHooks.onReplaceBoundary(
            'active-sidecar-removed',
          );
        await fsyncDirectory(this.paths.directory(chatId));
        await this.turnIndex(chatId, index);
        this.remember(chatId, {
          index,
          locatorStamp: await this.locatorStamp(chatId),
          locatorsComplete: true,
        });
      } finally {
        await rm(temporary, { force: true });
        await rm(locatorTemporary, { recursive: true, force: true });
      }
      this.reportReplacement(chatId, bytesWritten, startedAt);
    });
  }

  /** Scope metadata/tombstones must commit before physical deletion. */
  public async remove(chatId: string): Promise<void> {
    this.assertWritable();
    await this.serial(chatId, async () => {
      for (const extension of [
        'jsonl',
        'index.json',
        'active.json',
        'turns.json',
      ])
        await rm(this.path(chatId, extension), { force: true });
      await this.removeOwnedContent(chatId);
      await rm(this.locatorDirectory(chatId), { recursive: true, force: true });
      this.loaded.delete(chatId);
      activeSnapshots.delete(this.path(chatId, 'active.json'));
      recentCommittedPages.delete(this.path(chatId, 'jsonl'));
      turnPageRowBytes.delete(this.path(chatId, 'jsonl'));
      await fsyncDirectory(this.paths.directory(chatId));
    });
  }

  protected removeOwnedContent(key: string): Promise<void> {
    void key;
    return Promise.resolve();
  }

  /** Append final rows before clearing any redundant active projection. */
  public async append(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    anchors?: ReadonlyMap<string, ActiveRowAnchor>,
    activeTailCount?: number,
    fields: TranscriptFieldMode = 'legacy',
  ): Promise<void> {
    this.assertWritable();
    if (
      activeTailCount !== undefined &&
      (!Number.isSafeInteger(activeTailCount) || activeTailCount < 0)
    )
      throw new Error('Invalid active transcript suffix count');
    const explicitAnchors = copyActiveRowAnchors(anchors);
    await this.serial(chatId, async () =>
      this.appendLocked(
        chatId,
        messages,
        fields,
        undefined,
        explicitAnchors,
        activeTailCount,
      ),
    );
  }

  /**
   * Append a format-4 replacement tail and publish its active suffix in one
   * transaction. Returns false without staging or publishing when the rows do
   * not form an appendable tail; callers can then use the general replacement
   * path. Already-committed final rows are accepted only as an identical,
   * contiguous suffix at the end of the committed log.
   */
  public async tryAppendPatch(
    chatId: string,
    tail: readonly PersistedChatMessage[],
    activeTailCount: number,
    replacementRevision: number,
    fields: TranscriptFieldMode,
    capturedAnchors?: ReadonlyMap<string, ActiveRowAnchor>,
  ): Promise<boolean> {
    if (
      (fields !== 'format4' && fields !== 'format4-committed') ||
      this.options.childMode
    )
      return false;
    if (
      !Number.isSafeInteger(activeTailCount) ||
      activeTailCount < 0 ||
      activeTailCount > tail.length ||
      !Number.isSafeInteger(replacementRevision) ||
      replacementRevision < 0 ||
      replacementRevision >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Invalid mixed transcript patch');

    this.assertWritable();
    const explicitAnchors = copyActiveRowAnchors(capturedAnchors);
    const finalCount = tail.length - activeTailCount;
    const targetRevision = replacementRevision + (activeTailCount > 0 ? 1 : 0);
    return this.serial(chatId, async () => {
      const loaded = await this.load(chatId);
      if (!loaded.locatorsComplete) return false;

      const ids = new Set<string>();
      const committedFinalRows: Array<{
        locator: MessageLocator;
        message: PersistedChatMessage;
      }> = [];
      let missingFinalRow = false;
      for (let position = 0; position < tail.length; position += 1) {
        const message = tail[position];
        if (!message || ids.has(message.id)) return false;
        ids.add(message.id);
        const isFinal = position < finalCount;
        if (!isFinal) {
          if (await this.hasLocatorFile(chatId, message.id)) return false;
          continue;
        }

        const located = await this.readCommittedMessageAtLocator(
          chatId,
          message.id,
        );
        if (!located.valid) {
          if (await this.hasLocatorFile(chatId, message.id)) return false;
          missingFinalRow = true;
          continue;
        }
        if (missingFinalRow) return false;
        if (
          digest(located.message) !== digest(message) &&
          !(await this.artifacts.isFinalFormOf(
            this.paths.owner(chatId),
            message,
            located.message,
          ))
        )
          return false;
        const locatorValue: unknown = JSON.parse(
          await readFile(this.locatorPath(chatId, message.id), 'utf8'),
        );
        if (
          !isMessageLocator(locatorValue) ||
          locatorValue.messageId !== message.id
        )
          return false;
        committedFinalRows.push({
          locator: locatorValue,
          message: located.message,
        });
      }

      if (committedFinalRows.length > 0) {
        const last = committedFinalRows[committedFinalRows.length - 1];
        if (
          !last ||
          last.message.id !== loaded.index.lastMessageId ||
          last.locator.end !== loaded.index.committedByteLength
        )
          return false;
        for (let index = 1; index < committedFinalRows.length; index += 1) {
          const previous = committedFinalRows[index - 1];
          const current = committedFinalRows[index];
          if (
            !previous ||
            !current ||
            previous.locator.end !== current.locator.offset
          )
            return false;
        }
      }

      const openRows = tail.slice(finalCount);
      const currentActive = await this.active(chatId);
      const expectedAnchors = survivingActiveRowAnchors(
        openRows,
        explicitAnchors ?? currentActive?.activeRowAnchors,
      );
      // The prefix will be committed before the retained suffix is visible.
      // Include it in the bounded validation view, as appendLocked does.
      await this.validateActiveAnchorSet(chatId, tail, expectedAnchors);
      assertActiveSidecarRecordBudgets(
        openRows,
        expectedAnchors,
        new Set<string>(),
      );

      const activeAlreadyPublished =
        sameActiveMessages(currentActive?.messages ?? [], openRows) &&
        sameActiveAnchors(currentActive?.activeRowAnchors, expectedAnchors);
      if (
        committedFinalRows.length === finalCount &&
        loaded.index.transcriptRevision === targetRevision &&
        activeAlreadyPublished
      )
        return true;

      await this.appendLocked(
        chatId,
        tail,
        fields,
        undefined,
        expectedAnchors,
        activeTailCount,
        {
          replaceActive: true,
          transcriptRevision: targetRevision,
          exactRevision: true,
        },
      );
      return true;
    });
  }

  private async hasLocatorFile(
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    try {
      await stat(this.locatorPath(chatId, messageId));
      return true;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * A delta-journal checkpoint's turn-end write: a run of journaled active
   * updates and the append that finalizes rows, as one append. The run's
   * rows and transcript revision stand in for an active sidecar that is
   * never written, so the files equal those of
   * {@link writeActiveAtRevision} followed by {@link append}; the append's
   * intent still holds every row, as for any append. Idempotent: once the
   * log index is past the run's revision the append already happened, and a
   * resumed checkpoint repeating it does nothing.
   */
  public async appendAfterActive(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    active: readonly PersistedChatMessage[],
    transcriptRevision: number,
    anchors?: ReadonlyMap<string, ActiveRowAnchor>,
    fields: TranscriptFieldMode = 'legacy',
  ): Promise<void> {
    this.assertWritable();
    const explicitAnchors = copyActiveRowAnchors(anchors);
    if (!Number.isSafeInteger(transcriptRevision) || transcriptRevision < 0)
      throw new Error('Invalid transcript revision');
    await this.serial(chatId, async () => {
      const loaded = await this.load(chatId);
      if (loaded.index.transcriptRevision > transcriptRevision) return;
      await this.appendLocked(
        chatId,
        messages,
        fields,
        {
          messages: await this.uncommittedActiveRows(
            chatId,
            loaded,
            active,
            fields,
          ),
          transcriptRevision,
        },
        explicitAnchors,
      );
    });
  }

  /** Checkpoint child finals in finalization order, independent of display sequence. */
  public async appendChildFinalRows(
    streamKey: string,
    finalized: readonly DelegationChildRow[],
    open: readonly DelegationChildRow[],
    streamRevision: number,
    fields: TranscriptFieldMode = 'legacy',
  ): Promise<void> {
    if (!this.options.childMode) throw new Error('Child mode required');
    if (
      finalized.some((row) => !isDelegationChildRow(row) || !row.final) ||
      open.some((row) => !isDelegationChildRow(row) || row.final)
    )
      throw new Error('Invalid child row finality');
    this.assertWritable();
    if (!Number.isSafeInteger(streamRevision) || streamRevision < 0)
      throw new Error('Invalid transcript revision');
    // Not appendAfterActive's revision guard: a rebuilt child index derives its
    // revision from the row count, not the scope. Committed row IDs make this idempotent.
    await this.serial(streamKey, async () => {
      const loaded = await this.load(streamKey);
      await this.appendLocked(streamKey, finalized, fields, {
        messages: await this.uncommittedActiveRows(
          streamKey,
          loaded,
          open,
          fields,
        ),
        transcriptRevision: streamRevision,
      });
    });
  }

  /** Replace child active state with only still-open rows. */
  public async writeChildOpenRows(
    streamKey: string,
    open: readonly DelegationChildRow[],
    streamRevision: number,
    fields: TranscriptFieldMode = 'legacy',
  ): Promise<void> {
    if (
      !this.options.childMode ||
      open.some((row) => !isDelegationChildRow(row) || row.final)
    )
      throw new Error('Invalid child open rows');
    await this.writeActiveAtRevision(
      streamKey,
      open,
      streamRevision,
      undefined,
      fields,
    );
  }

  private async childSequenceIndex(
    streamKey: string,
  ): Promise<ChildStreamSequenceEntry[]> {
    if (!this.options.childMode) throw new Error('Child mode required');
    const logPath = this.path(streamKey, 'jsonl');
    const indexPath = this.path(streamKey, 'sequence-index.json');
    let size: number;
    try {
      size = (await stat(logPath)).size;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    try {
      const saved: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
      if (
        isRecord(saved) &&
        saved.version === 1 &&
        saved.logBytes === size &&
        this.isChildSequenceEntries(saved.entries)
      )
        return saved.entries;
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !(isErrnoException(error) && error.code === 'ENOENT')
      )
        throw error;
    }
    // Keep only the index fields; row bodies can be as large as the transcript.
    const rows: Parameters<typeof buildChildStreamSequenceIndex>[0][number][] =
      [];
    for await (const entry of lines(logPath)) {
      if (!isDelegationChildRow(entry.message))
        throw new Error('Invalid child transcript row');
      const { id, delegationSequence } = entry.message;
      rows.push({
        row: { id, delegationSequence },
        offset: entry.offset,
        end: entry.end,
      });
    }
    const entries = buildChildStreamSequenceIndex(rows);
    if (!this.options.readOnly)
      await writeFile(
        indexPath,
        JSON.stringify({ version: 1, logBytes: size, entries }),
      );
    return entries;
  }

  /** Read sequence metadata without hydrating the committed row bodies. */
  public async childStreamSequenceEntries(
    streamKey: string,
  ): Promise<ChildStreamSequenceEntry[]> {
    return (await this.childSequenceIndex(streamKey)).map((entry) => ({
      ...entry,
    }));
  }

  private async childRowAt(
    streamKey: string,
    entry: ChildStreamSequenceEntry,
  ): Promise<DelegationChildRow> {
    const handle = await open(this.path(streamKey, 'jsonl'), 'r');
    try {
      const buffer = Buffer.alloc(entry.end - entry.offset);
      let read = 0;
      while (read < buffer.length) {
        const result = await handle.read(
          buffer,
          read,
          buffer.length - read,
          entry.offset + read,
        );
        if (result.bytesRead === 0)
          throw new Error('Damaged child transcript row');
        read += result.bytesRead;
      }
      if (buffer[buffer.length - 1] !== 10)
        throw new Error('Damaged child transcript row');
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          buffer.subarray(0, -1),
        ),
      );
      if (
        !isDelegationChildRow(value) ||
        value.id !== entry.id ||
        value.delegationSequence !== entry.delegationSequence
      )
        throw new Error('Child transcript index mismatch');
      return value;
    } finally {
      await handle.close();
    }
  }

  /** Read one row selected from the sequence index. */
  public readChildStreamSequenceEntry(
    streamKey: string,
    entry: ChildStreamSequenceEntry,
  ): Promise<DelegationChildRow> {
    return this.childRowAt(streamKey, entry);
  }

  public async readChildStreamPage(
    streamKey: string,
    options: { before?: number; limit?: number } = {},
  ): Promise<{ rows: readonly DelegationChildRow[]; nextBefore?: number }> {
    const entries = await this.childSequenceIndex(streamKey);
    const page = childStreamSequencePage(
      entries,
      options.before,
      options.limit,
    );
    const rows: DelegationChildRow[] = [];
    for (const entry of page.entries)
      rows.push(await this.childRowAt(streamKey, entry));
    return {
      rows,
      ...(page.before === undefined ? {} : { nextBefore: page.before }),
    };
  }

  public async childStreamRowById(
    streamKey: string,
    rowId: string,
  ): Promise<DelegationChildRow | undefined> {
    const entry = findChildStreamSequenceEntry(
      await this.childSequenceIndex(streamKey),
      rowId,
    );
    return entry ? this.childRowAt(streamKey, entry) : undefined;
  }

  /**
   * `messages` without rows the log already commits, externalized, as an
   * active write stores them; a different committed row is a conflict.
   */
  private async uncommittedActiveRows(
    chatId: string,
    loaded: LoadedLog,
    messages: readonly PersistedChatMessage[],
    fields: TranscriptFieldMode,
  ): Promise<PersistedChatMessage[]> {
    const stored: PersistedChatMessage[] = [];
    const ids = new Set<string>();
    for (const message of messages) {
      if (ids.has(message.id)) throw new Error('Duplicate active message');
      ids.add(message.id);
      const next = await this.prepareRow(chatId, message, false, fields);
      const existing = await this.committedCopy(chatId, loaded, next.id);
      if (existing !== undefined) {
        if (!(await this.matchesCommitted(chatId, next, existing)))
          throw new Error('Active message conflicts with committed history');
      } else stored.push(next);
    }
    return stored;
  }

  /**
   * {@link append} under the chat's serial lock. `before`, when given, is
   * the active state the append follows instead of the sidecar's.
   */
  private async appendLocked(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    fields: TranscriptFieldMode,
    before?: {
      messages: PersistedChatMessage[];
      transcriptRevision: number;
    },
    explicitAnchors?: ReadonlyMap<string, ActiveRowAnchor>,
    activeTailCount?: number,
    options?: {
      replaceActive?: boolean;
      transcriptRevision?: number;
      exactRevision?: boolean;
    },
  ): Promise<void> {
    const loaded = await this.load(chatId);
    const suffixCount = activeTailCount ?? 0;
    const suffixMode = activeTailCount !== undefined;
    if (suffixMode && suffixCount > messages.length)
      throw new Error('Active transcript suffix exceeds append payload');
    const committedPayloadCount = suffixMode
      ? messages.length - suffixCount
      : messages.length;
    const prepared: PersistedChatMessage[] = [];
    const activeSuffix: PersistedChatMessage[] = [];
    const ids = new Set<string>();
    for (let position = 0; position < messages.length; position += 1) {
      const message = messages[position];
      if (!message) throw new Error('Invalid append payload');
      if (this.options.childMode && !isDelegationChildRow(message))
        throw new Error('Invalid child transcript row');
      // Rows in the active suffix use the open-row policy; the preceding
      // payload is committed and uses the final-row policy.
      const isActiveSuffix = suffixMode && position >= committedPayloadCount;
      const stored = await this.prepareRow(
        chatId,
        message,
        !isActiveSuffix,
        fields,
      );
      assertTranscriptRowWithinLimit(stored);
      const hash = digest(stored);
      const existing = await this.readCommittedMessage(chatId, stored.id);
      if (existing !== undefined) {
        if (digest(existing) !== hash)
          throw new Error(`Conflicting committed message ${stored.id}`);
        if (suffixMode && position >= committedPayloadCount)
          throw new Error(
            `Active suffix message is already committed: ${stored.id}`,
          );
        continue;
      }
      if (ids.has(stored.id)) throw new Error('Duplicate message in append');
      ids.add(stored.id);
      if (suffixMode && position >= committedPayloadCount)
        activeSuffix.push(stored);
      else prepared.push(stored);
    }
    if (prepared.length === 0 && !suffixMode) {
      const sidecar =
        before || options?.replaceActive
          ? undefined
          : await this.active(chatId);
      const active = before ?? sidecar;
      const existingAnchors = before
        ? await this.activeRowAnchorsForWrite(chatId)
        : options?.replaceActive
          ? undefined
          : sidecar?.activeRowAnchors;
      if (options?.replaceActive) delete loaded.index.hasOrdinaryActiveRows;
      const effectiveAnchors = survivingActiveRowAnchors(
        active?.messages ?? [],
        existingAnchors,
        explicitAnchors,
      );
      await this.validateActiveAnchorSet(
        chatId,
        active?.messages ?? [],
        effectiveAnchors,
      );
      if (before) {
        // Nothing to finalize: the run alone, as writeActiveAtRevision.
        loaded.index.transcriptRevision =
          options?.transcriptRevision ?? before.transcriptRevision;
        await this.persistActive(
          chatId,
          loaded,
          before.messages,
          effectiveAnchors,
        );
        await this.writeIndex(chatId, loaded.index);
      } else if (explicitAnchors && explicitAnchors.size > 0) {
        await this.persistActive(
          chatId,
          loaded,
          active?.messages ?? [],
          effectiveAnchors,
        );
      }
      return;
    }
    if (prepared.length === 0 && suffixMode) {
      const sidecar =
        before || options?.replaceActive
          ? undefined
          : await this.active(chatId);
      const active = before ?? sidecar;
      const existingAnchors = before
        ? await this.activeRowAnchorsForWrite(chatId)
        : options?.replaceActive
          ? undefined
          : sidecar?.activeRowAnchors;
      const effectiveAnchors = survivingActiveRowAnchors(
        activeSuffix,
        existingAnchors,
        explicitAnchors,
      );
      await this.validateActiveAnchorSet(
        chatId,
        activeSuffix,
        effectiveAnchors,
      );
      if (
        sameActiveMessages(active?.messages ?? [], activeSuffix) &&
        sameActiveAnchors(existingAnchors, effectiveAnchors) &&
        options?.replaceActive !== true &&
        (options?.transcriptRevision === undefined ||
          loaded.index.transcriptRevision === options.transcriptRevision)
      )
        return;
      if (options?.replaceActive) delete loaded.index.hasOrdinaryActiveRows;
      loaded.index.transcriptRevision =
        options?.transcriptRevision ??
        (before?.transcriptRevision ?? loaded.index.transcriptRevision) + 1;
      await this.persistActive(chatId, loaded, activeSuffix, effectiveAnchors);
      await this.writeIndex(chatId, loaded.index);
      return;
    }
    const sidecar =
      before || options?.replaceActive ? undefined : await this.active(chatId);
    const active = before ?? sidecar;
    const existingAnchors = before
      ? await this.activeRowAnchorsForWrite(chatId)
      : options?.replaceActive
        ? undefined
        : sidecar?.activeRowAnchors;
    const orderingAnchors = survivingActiveRowAnchors(
      [...(active?.messages ?? []), ...prepared, ...activeSuffix],
      existingAnchors,
      explicitAnchors,
    );
    const ordinaryPendingIds: string[] = [];
    for (const message of active?.messages ?? [])
      if (
        !orderingAnchors.has(message.id) &&
        !(await this.readCommittedMessage(chatId, message.id))
      )
        ordinaryPendingIds.push(message.id);
    const ordinaryPrepared = prepared.filter(
      (message) => !orderingAnchors.has(message.id),
    );
    // An explicit suffix allows newly materialized rows ahead of retained
    // ordinary rows. Rows already in the sidecar must still commit as a prefix
    // of its ordinary order: retaining the first cannot finalize the second.
    const ordinaryPendingSet = new Set(ordinaryPendingIds);
    const orderedPrepared = suffixMode
      ? ordinaryPrepared.filter((message) => ordinaryPendingSet.has(message.id))
      : ordinaryPrepared;
    if (
      !this.options.childMode &&
      orderedPrepared.some((message, index) =>
        index < ordinaryPendingIds.length
          ? message.id !== ordinaryPendingIds[index]
          : false,
      )
    ) {
      throw new Error('Finalized messages must follow active transcript order');
    }
    const committedPayloadIds = new Set<string>();
    for (const message of prepared) {
      const rowAnchor = orderingAnchors.get(message.id);
      if (
        rowAnchor?.after !== undefined &&
        rowAnchor.after !== null &&
        !committedPayloadIds.has(rowAnchor.after) &&
        !(await this.readCommittedMessage(chatId, rowAnchor.after))
      )
        throw new Error(
          `Invalid active row anchor predecessor: ${rowAnchor.after} must be committed or earlier in append payload`,
        );
      committedPayloadIds.add(message.id);
    }
    const pendingMessages = suffixMode
      ? [...prepared, ...activeSuffix]
      : [
          ...prepared,
          ...(active?.messages.filter((message) => !ids.has(message.id)) ?? []),
        ];
    const effectiveAnchors = survivingActiveRowAnchors(
      pendingMessages,
      existingAnchors,
      explicitAnchors,
    );
    await this.validateActiveAnchorSet(
      chatId,
      pendingMessages,
      effectiveAnchors,
    );
    assertActiveSidecarRecordBudgets(
      pendingMessages,
      effectiveAnchors,
      new Set(prepared.map((message) => message.id)),
    );
    if (options?.replaceActive) delete loaded.index.hasOrdinaryActiveRows;
    const stagedId = randomUUID();
    await writeJsonValuesCooperatively(
      this.paths.stagedAppendFile(chatId, stagedId),
      prepared,
      {
        pretty: false,
        separator: '\n',
        trailingSeparator: true,
      },
    );
    const stagedPath = this.paths.stagedAppendFile(chatId, stagedId);
    const childIntent:
      | Pick<
          NonNullable<ActiveSidecar['finalizing']>,
          'child' | 'stagedByteLength' | 'stagedSha256'
        >
      | undefined = this.options.childMode
      ? {
          child: true,
          stagedByteLength: (await stat(stagedPath)).size,
          stagedSha256: await fileDigest(stagedPath),
        }
      : undefined;
    if (this.options.childMode) await this.options.onChildStaged?.();
    const pendingTranscriptRevision =
      options?.transcriptRevision ??
      (before?.transcriptRevision ?? loaded.index.transcriptRevision) + 1;
    const pending: ActiveSidecar = {
      version: 1,
      transcriptRevision: pendingTranscriptRevision,
      updatedAt: new Date().toISOString(),
      // Child rows stay in the digest-pinned staged file, not the sidecar.
      messages: this.options.childMode
        ? pendingMessages.slice(prepared.length)
        : pendingMessages,
      ...(effectiveAnchors.size > 0
        ? { activeRowAnchors: effectiveAnchors }
        : {}),
      finalizing: {
        stagedId,
        byteOffset: loaded.index.committedByteLength,
        ...(options?.exactRevision
          ? {
              explicitRevision: {
                stagedId,
                byteOffset: loaded.index.committedByteLength,
                transcriptRevision: pendingTranscriptRevision,
              },
            }
          : {}),
        // Child rows stay in the digest-pinned staged file, not the sidecar.
        messageIds: this.options.childMode
          ? []
          : prepared.map((message) => message.id),
        ...childIntent,
      },
    };
    await writeActiveSidecar(this.path(chatId, 'active.json'), pending);
    await this.notifyAppendBoundary('prepared');
    await this.finishAppend(chatId, pending);
    const locatorRows: Array<{
      message: PersistedChatMessage;
      offset: number;
      end: number;
    }> = [];
    let hasFinalTurnTimer = false;
    for (const message of prepared) {
      const offset = loaded.index.committedByteLength;
      const end =
        offset + Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
      locatorRows.push({ message, offset, end });
      const logical = message.blocksRef
        ? await this.expandBlocks(chatId, message)
        : message;
      this.record(loaded.index, message, offset, end, undefined, logical);
      if (
        logical.blocks.some(
          (block) => block.type === 'turn_timer' && block.completedAt != null,
        )
      )
        hasFinalTurnTimer = true;
    }
    if (
      loaded.committedLocatorKeys &&
      (await this.locatorStamp(chatId)) !== loaded.locatorStamp
    ) {
      delete loaded.committedLocatorKeys;
      loaded.committedLocatorInventoryUnavailable = true;
      this.loaded.delete(chatId);
    }
    await this.writeLocators(chatId, locatorRows);
    const nextLocatorStamp = await this.locatorStamp(chatId);
    if (loaded.committedLocatorKeys) {
      if (
        loaded.committedLocatorKeys.size + prepared.length >
        MAX_COMMITTED_LOCATOR_IDENTITY_KEYS
      ) {
        delete loaded.committedLocatorKeys;
        loaded.committedLocatorInventoryUnavailable = true;
      } else {
        for (const message of prepared)
          loaded.committedLocatorKeys.add(this.locatorKey(message.id));
      }
    }
    loaded.locatorStamp = nextLocatorStamp;
    loaded.index.transcriptRevision = pending.transcriptRevision;
    loaded.index.hasActiveSidecar = this.options.childMode
      ? pending.messages.length > 0
      : pending.messages.length > prepared.length;
    const finalizingIds = new Set(pending.finalizing?.messageIds ?? []);
    const activeSurvivors = pending.messages.filter(
      (message) => !finalizingIds.has(message.id),
    );
    const survivingAnchors = survivingActiveRowAnchors(
      activeSurvivors,
      effectiveAnchors,
    );
    if (survivingAnchors.size > 0)
      loaded.index.hasOrdinaryActiveRows = await this.hasOrdinaryActiveRows(
        chatId,
        activeSurvivors,
        survivingAnchors,
      );
    else delete loaded.index.hasOrdinaryActiveRows;
    await this.writeIndex(chatId, loaded.index);
    await this.notifyAppendBoundary('index-published');
    await this.clearFinalized(chatId, pending);
    if (hasFinalTurnTimer) await this.turnIndex(chatId, loaded.index);
  }

  /**
   * Staged rows are redundant with the durable active projection until the
   * log is extended. An intent whose staged file cannot be read is abandoned
   * only while the log still ends at the recorded offset; any other failure
   * stays a recovery error.
   */
  private async finishOrAbandonAppend(
    chatId: string,
    pending: ActiveSidecar,
  ): Promise<ActiveSidecar> {
    const intent = pending.finalizing;
    if (!intent) return pending;
    const anchors =
      copyActiveRowAnchors(pending.activeRowAnchors) ??
      new Map<string, ActiveRowAnchor>();
    await this.validateActiveAnchorSet(
      chatId,
      pending.messages,
      survivingActiveRowAnchors(pending.messages, anchors),
      true,
    );
    assertActiveSidecarRecordBudgets(
      pending.messages,
      anchors,
      new Set(intent.messageIds),
    );
    try {
      await this.finishAppend(chatId, pending);
      return pending;
    } catch (error) {
      const size = (await stat(this.path(chatId, 'jsonl'))).size;
      if (size !== intent.byteOffset) throw error;
      const { finalizing: _finalizing, ...settled } = pending;
      void _finalizing;
      await writeActiveSidecar(this.path(chatId, 'active.json'), settled);
      await this.notifyAppendBoundary('abandoned');
      await rm(this.paths.stagedAppendFile(chatId, intent.stagedId), {
        force: true,
      });
      await fsyncDirectory(this.paths.directory(chatId));
      return settled;
    }
  }

  /** A staged append that no intent references can never be replayed. */
  private async removeOrphanedStagedAppends(
    chatId: string,
    referencedStagedId: string | undefined,
  ): Promise<void> {
    if (this.options.readOnly) return;
    const referenced =
      referencedStagedId === undefined
        ? undefined
        : this.paths.stagedAppendFile(chatId, referencedStagedId);
    let removed = false;
    for await (const entry of await opendir(this.paths.directory(chatId))) {
      if (
        !entry.isFile() ||
        !this.paths.isStagedAppend(chatId, entry.name) ||
        join(this.paths.directory(chatId), entry.name) === referenced
      )
        continue;
      await rm(join(this.paths.directory(chatId), entry.name), { force: true });
      removed = true;
    }
    if (removed) await fsyncDirectory(this.paths.directory(chatId));
  }

  /** Replays only a proved prefix of our staged append; unrelated corruption is preserved. */
  private async finishAppend(
    chatId: string,
    pending: ActiveSidecar,
  ): Promise<void> {
    const intent = pending.finalizing;
    if (!intent) return;
    assertTranscriptIdentity(intent.stagedId);
    if (
      !Number.isSafeInteger(intent.byteOffset) ||
      intent.byteOffset < 0 ||
      !Array.isArray(intent.messageIds)
    ) {
      throw new Error('Invalid transcript append intent');
    }
    const stagedPath = this.paths.stagedAppendFile(chatId, intent.stagedId);
    const finalizing = new Set(intent.messageIds);
    if (intent.child) {
      if (
        !this.options.childMode ||
        !Number.isSafeInteger(intent.stagedByteLength) ||
        typeof intent.stagedSha256 !== 'string' ||
        (await stat(stagedPath)).size !== intent.stagedByteLength ||
        (await fileDigest(stagedPath)) !== intent.stagedSha256 ||
        intent.messageIds.length !== 0
      )
        throw new Error('Invalid child staged append intent');
      const stagedIds = new Set<string>();
      for await (const row of lines(stagedPath)) {
        if (
          !isDelegationChildRow(row.message) ||
          !row.message.final ||
          stagedIds.has(row.message.id)
        )
          throw new Error('Staged child append differs from intent');
        stagedIds.add(row.message.id);
      }
      if (stagedIds.size === 0) throw new Error('Empty child staged append');
    } else {
      const stagedMessages: PersistedChatMessage[] = [];
      for await (const row of lines(stagedPath))
        stagedMessages.push(row.message);
      if (
        finalizing.size !== stagedMessages.length ||
        !stagedMessages.every(
          (message, i) =>
            message.id === intent.messageIds[i] &&
            pending.messages.some(
              (candidate) =>
                candidate.id === message.id &&
                digest(candidate) === digest(message),
            ),
        )
      ) {
        throw new Error('Staged append differs from durable active projection');
      }
    }
    const logPath = this.path(chatId, 'jsonl');
    const logHandle = await open(logPath, 'r+');
    try {
      const stagedHandle = await open(stagedPath, 'r');
      try {
        const logLength = (await logHandle.stat()).size;
        const stagedLength = (await stagedHandle.stat()).size;
        if (
          logLength < intent.byteOffset ||
          logLength > intent.byteOffset + stagedLength
        )
          throw new Error('Unexpected transcript append extent');
        if (intent.byteOffset > 0) {
          const boundary = Buffer.alloc(1);
          await logHandle.read(boundary, 0, 1, intent.byteOffset - 1);
          if (boundary[0] !== 10)
            throw new Error('Append intent does not target a message boundary');
        }
        const actual = Buffer.alloc(65_536);
        const expected = Buffer.alloc(65_536);
        for (let offset = 0; offset < logLength - intent.byteOffset; ) {
          const length = Math.min(
            actual.length,
            logLength - intent.byteOffset - offset,
          );
          const a = await logHandle.read(
            actual,
            0,
            length,
            intent.byteOffset + offset,
          );
          const b = await stagedHandle.read(expected, 0, length, offset);
          if (
            a.bytesRead !== length ||
            b.bytesRead !== length ||
            !actual.subarray(0, length).equals(expected.subarray(0, length))
          ) {
            throw new Error('Transcript suffix does not match staged append');
          }
          offset += length;
        }
        // Continue at the exact persisted byte, including a partial UTF-8/JSON
        // token. No accepted bytes are truncated or reconstructed from a preview.
        for (
          let offset = logLength - intent.byteOffset;
          offset < stagedLength;
        ) {
          const { bytesRead } = await stagedHandle.read(
            expected,
            0,
            Math.min(expected.length, stagedLength - offset),
            offset,
          );
          if (bytesRead === 0)
            throw new Error('Unexpected end of staged append');
          let written = 0;
          while (written < bytesRead) {
            const result = await logHandle.write(
              expected,
              written,
              bytesRead - written,
              intent.byteOffset + offset + written,
            );
            if (!result.bytesWritten)
              throw new Error('Transcript append made no progress');
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
        await logHandle.sync();
        // The log grows by copying the staged bytes it does not hold yet.
        recordChatStorageFileWrite(
          logPath,
          stagedLength - (logLength - intent.byteOffset),
          false,
        );
        recordChatStorageFileSync(logPath);
      } finally {
        await stagedHandle.close();
      }
    } finally {
      await logHandle.close();
    }
    await this.notifyAppendBoundary('appended');
  }

  private async notifyAppendBoundary(boundary: AppendBoundary): Promise<void> {
    if (this.onAppendBoundary) await this.onAppendBoundary(boundary);
  }

  /** The committed sparse index and revision must be durable before clearing. */
  private async clearFinalized(
    chatId: string,
    pending: ActiveSidecar,
  ): Promise<void> {
    const intent = pending.finalizing;
    if (!intent) return;
    const finalizing = new Set(intent.messageIds);
    const remaining = pending.messages.filter(
      (message) => !finalizing.has(message.id),
    );
    if (remaining.length) {
      const { finalizing: _finalizing, ...settled } = pending;
      void _finalizing;
      const remainingAnchors = survivingActiveRowAnchors(
        remaining,
        pending.activeRowAnchors,
      );
      await writeActiveSidecar(this.path(chatId, 'active.json'), {
        ...settled,
        messages: remaining,
        activeRowAnchors: remainingAnchors,
      });
    } else {
      await rm(this.path(chatId, 'active.json'), { force: true });
      await fsyncDirectory(this.paths.directory(chatId));
    }
    await this.notifyAppendBoundary('survivors-published');
    await rm(this.paths.stagedAppendFile(chatId, intent.stagedId), {
      force: true,
    });
    await fsyncDirectory(this.paths.directory(chatId));
  }

  private async persistActive(
    chatId: string,
    loaded: LoadedLog,
    messages: PersistedChatMessage[],
    activeRowAnchors?: ReadonlyMap<string, ActiveRowAnchor>,
  ): Promise<void> {
    if (messages.length === 0) {
      await rm(this.path(chatId, 'active.json'), { force: true });
      await fsyncDirectory(this.paths.directory(chatId));
    } else {
      await writeActiveSidecar(this.path(chatId, 'active.json'), {
        version: 1,
        transcriptRevision: loaded.index.transcriptRevision,
        updatedAt: new Date().toISOString(),
        messages,
        ...(activeRowAnchors && activeRowAnchors.size > 0
          ? { activeRowAnchors: new Map(activeRowAnchors) }
          : {}),
      } satisfies ActiveSidecar);
    }
    loaded.index.hasActiveSidecar = messages.length > 0;
    if (activeRowAnchors && activeRowAnchors.size > 0)
      loaded.index.hasOrdinaryActiveRows = messages.some(
        (message) => !activeRowAnchors.has(message.id),
      );
    else delete loaded.index.hasOrdinaryActiveRows;
  }

  private async updateActive(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    allowRemoval: boolean,
    fields: TranscriptFieldMode,
    anchors?: ReadonlyMap<string, ActiveRowAnchor>,
  ): Promise<void> {
    this.assertWritable();
    const explicitAnchors = copyActiveRowAnchors(anchors);
    await this.serial(chatId, async () => {
      const loaded = await this.load(chatId);
      const stored: PersistedChatMessage[] = [];
      const ids = new Set<string>();
      for (const message of messages) {
        if (ids.has(message.id)) throw new Error('Duplicate active message');
        ids.add(message.id);
        const next = await this.prepareRow(chatId, message, false, fields);
        const existing = await this.readCommittedMessageForGeneration(
          chatId,
          loaded,
          next.id,
          true,
        );
        if (existing !== undefined) {
          if (!(await this.matchesCommitted(chatId, next, existing)))
            throw new Error('Active message conflicts with committed history');
        } else stored.push(next);
      }
      const previous = await this.active(chatId);
      if (!allowRemoval)
        for (const message of previous?.messages ?? [])
          if (
            !ids.has(message.id) &&
            !(await this.readCommittedMessageForGeneration(
              chatId,
              loaded,
              message.id,
              true,
            ))
          )
            throw new Error(
              'Active transcript replacement would discard an uncommitted message',
            );
      const effectiveAnchors = survivingActiveRowAnchors(
        stored,
        previous?.activeRowAnchors,
        explicitAnchors,
      );
      await this.validateActiveAnchorSet(chatId, stored, effectiveAnchors);
      loaded.index.transcriptRevision += 1;
      await this.persistActive(chatId, loaded, stored, effectiveAnchors);
      await this.writeIndex(chatId, loaded.index);
    });
  }

  public async writeActive(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    anchors?: ReadonlyMap<string, ActiveRowAnchor>,
    fields: TranscriptFieldMode = 'legacy',
  ): Promise<void> {
    await this.updateActive(chatId, messages, false, fields, anchors);
  }

  /** Explicitly replace the mutable sidecar without touching committed rows. */
  public async replaceActive(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    anchors?: ReadonlyMap<string, ActiveRowAnchor>,
    fields: TranscriptFieldMode = 'legacy',
  ): Promise<void> {
    await this.updateActive(chatId, messages, true, fields, anchors);
  }

  /**
   * A delta-journal checkpoint's single write for a run of journaled active
   * updates: the rows the run left active and the transcript revision its
   * individual writes reached, so the files match those of writing each
   * update in turn. Rows already committed are dropped, as
   * {@link writeActive} drops them; the journal admitted every update
   * against the same history. Idempotent, so a resumed checkpoint may repeat
   * it.
   */
  public async writeActiveAtRevision(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    transcriptRevision: number,
    anchors?: ReadonlyMap<string, ActiveRowAnchor>,
    fields: TranscriptFieldMode = 'legacy',
  ): Promise<void> {
    this.assertWritable();
    const explicitAnchors = copyActiveRowAnchors(anchors);
    if (!Number.isSafeInteger(transcriptRevision) || transcriptRevision < 0)
      throw new Error('Invalid transcript revision');
    await this.serial(chatId, async () => {
      const loaded = await this.load(chatId);
      const stored = await this.uncommittedActiveRows(
        chatId,
        loaded,
        messages,
        fields,
      );
      const previousAnchors = await this.activeRowAnchorsForWrite(chatId);
      const effectiveAnchors = survivingActiveRowAnchors(
        stored,
        previousAnchors,
        explicitAnchors,
      );
      await this.validateActiveAnchorSet(chatId, stored, effectiveAnchors);
      loaded.index.transcriptRevision = transcriptRevision;
      await this.persistActive(chatId, loaded, stored, effectiveAnchors);
      await this.writeIndex(chatId, loaded.index);
    });
  }

  private async turnIndex(
    chatId: string,
    index: SparseIndex,
    reusable: readonly IndexedTurn[] = [],
  ): Promise<TranscriptTurnIndex> {
    const finishPerformanceStage = beginMainTranscriptPerformanceStage(
      'turn_index',
      chatId,
      { committedRows: index.committedMessageCount },
    );
    let previous: TranscriptTurnIndex | undefined;
    try {
      const stored: unknown = JSON.parse(
        await readFile(this.path(chatId, 'turns.json'), 'utf8'),
      );
      if (isRecord(stored)) {
        const { checksum, ...value } = stored;
        if (
          typeof checksum === 'string' &&
          createHash('sha256').update(JSON.stringify(value)).digest('hex') ===
            checksum &&
          isTranscriptTurnIndex(value)
        )
          previous = value;
      }
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !(isErrnoException(error) && error.code === 'ENOENT')
      )
        throw error;
    }
    if (
      previous?.committedByteLength === index.committedByteLength &&
      previous.committedMessageCount === index.committedMessageCount
    ) {
      finishPerformanceStage({ reused: 1, turns: previous.turns.length });
      return previous;
    }
    // Appends normally revisit only the last turn. A delayed safety receipt
    // also invalidates its explicit owner, even across a later user boundary.
    // Replacements remove the derived file before publishing the new log,
    // so equal-size rewrites cannot reuse
    // it; a prefix-preserving replacement passes the turns it cannot change.
    let prefix =
      previous && previous.committedMessageCount < index.committedMessageCount
        ? previous.turns.slice(0, -1)
        : [...reusable];
    if (
      previous &&
      previous.committedMessageCount < index.committedMessageCount &&
      prefix.length > 0
    ) {
      const positions = new Map(
        prefix.map((turn, position) => [turn.id, position]),
      );
      let reusableCount = prefix.length;
      for await (const message of this.range(
        chatId,
        index,
        previous.committedMessageCount,
        index.committedMessageCount,
      )) {
        for (const block of message.blocks) {
          if (
            block.type !== 'approval_safety_denied_info' ||
            !block.toolUseId ||
            block.subagentId ||
            block.turnUserMessageId === undefined
          )
            continue;
          const owner = positions.get(block.turnUserMessageId);
          if (owner !== undefined)
            reusableCount = Math.min(reusableCount, owner);
        }
      }
      prefix = prefix.slice(0, reusableCount);
    } else if (!previous) {
      // A replaced suffix can remove a late receipt owned by an earlier turn.
      const owner = prefix.findIndex(
        (turn) => turn.deniedToolUseIds.length > 0,
      );
      if (owner >= 0) prefix = prefix.slice(0, owner);
    }
    const start = prefix[prefix.length - 1]?.end ?? 0;
    const source = this.range(
      chatId,
      index,
      start,
      index.committedMessageCount,
    );
    const artifacts = this.artifacts;
    const owner = this.paths.owner(chatId);
    async function* withCanonicalReceipts(): AsyncGenerator<PersistedChatMessage> {
      for await (const row of source)
        yield await artifacts.hydrateAgentArtifacts(owner, row);
    }
    const turns = [
      ...prefix,
      // A paged row has no inline blocks; hydrate them once expanded.
      ...(await buildTurnIndex(
        withCanonicalReceipts(),
        start,
        previous && previous.committedMessageCount < index.committedMessageCount
          ? previous.turns
          : [],
        async (message) =>
          artifacts.hydrateAgentArtifacts(
            owner,
            await this.expandBlocks(chatId, message),
          ),
      )),
    ];
    const next: TranscriptTurnIndex = {
      version: 10,
      committedByteLength: index.committedByteLength,
      committedMessageCount: index.committedMessageCount,
      turns,
    };
    if (!this.options.readOnly)
      await atomicJson(this.path(chatId, 'turns.json'), {
        ...next,
        checksum: createHash('sha256')
          .update(JSON.stringify(next))
          .digest('hex'),
      });
    finishPerformanceStage({ rebuilt: 1, turns: next.turns.length });
    return next;
  }

  private async *range(
    chatId: string,
    index: SparseIndex,
    start: number,
    end: number,
  ): AsyncGenerator<PersistedChatMessage> {
    if (start >= end) return;
    const checkpoint = [...index.offsets]
      .reverse()
      .find((entry) => entry.ordinal <= start);
    if (!checkpoint) return;
    let ordinal = checkpoint.ordinal;
    for await (const row of lines(
      this.path(chatId, 'jsonl'),
      checkpoint.offset,
    )) {
      if (ordinal >= start && ordinal < end) yield row.message;
      ordinal += 1;
      if (ordinal >= end) break;
    }
  }

  /** Identify the committed file a turn page is about to read rows from. */
  private async beginTurnPageRowRead(
    chatId: string,
    index: SparseIndex,
  ): Promise<TurnPageRowRead> {
    const path = this.path(chatId, 'jsonl');
    const read: TurnPageRowRead = {
      path,
      rows: new Map(),
      spans: [],
      bytes: 0,
    };
    if (index.committedMessageCount === 0) return read;
    try {
      const { stamp } = await fileIdentity(path);
      read.stamp = stamp;
      read.identity = `${index.committedDigest}:${index.committedMessageCount}:${index.committedByteLength}:${stamp}`;
    } catch {
      // The read below reports a missing or unreadable file as it always has.
    }
    return read;
  }

  /**
   * The rows of `[start, end)` that `wanted` selects (all of them when it is
   * absent), in order: `range` with the rows a turn page discards left out.
   * Rows this page or an earlier one already parsed from the same committed
   * identity are decoded from their retained bytes instead of the file.
   */
  private async turnPageRows(
    index: SparseIndex,
    read: TurnPageRowRead,
    start: number,
    end: number,
    wanted?: ReadonlySet<number>,
  ): Promise<PersistedChatMessage[]> {
    const messages: PersistedChatMessage[] = [];
    if (start >= end) return messages;
    const checkpoint = [...index.offsets]
      .reverse()
      .find((entry) => entry.ordinal <= start);
    if (!checkpoint) return messages;
    const retained = read.identity
      ? turnPageRowBytes.get(read.path, read.identity)
      : undefined;
    if (
      retained?.spans.some(
        ([from, to]) => from <= checkpoint.ordinal && end <= to,
      )
    ) {
      const selected: Buffer[] = [];
      let complete = true;
      for (let ordinal = start; ordinal < end; ordinal += 1) {
        if (wanted && !wanted.has(ordinal)) continue;
        const bytes = retained.rows.get(ordinal);
        if (!bytes) {
          complete = false;
          break;
        }
        selected.push(bytes);
      }
      if (complete) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for (const bytes of selected)
          messages.push(decodeTranscriptRow(bytes, decoder));
        return messages;
      }
    }
    let ordinal = checkpoint.ordinal;
    for await (const row of lines(read.path, checkpoint.offset)) {
      if (
        ordinal >= start &&
        ordinal < end &&
        (!wanted || wanted.has(ordinal))
      ) {
        messages.push(row.message);
        if (read.identity) {
          read.bytes += row.bytes.length;
          // A page too large to retain is read from the file every time.
          if (read.bytes > MAX_TURN_PAGE_ROW_BYTES) {
            read.identity = undefined;
            read.rows.clear();
          } else {
            // The row is a view of its stream chunk; keep only its own bytes.
            read.rows.set(ordinal, Buffer.from(row.bytes));
          }
        }
      }
      ordinal += 1;
      if (ordinal >= end) break;
    }
    read.spans.push([checkpoint.ordinal, ordinal]);
    return messages;
  }

  /** Keep what this page read only if the committed file did not change meanwhile. */
  private async finishTurnPageRowRead(read: TurnPageRowRead): Promise<void> {
    if (!read.identity || read.rows.size === 0) return;
    try {
      if ((await fileIdentity(read.path)).stamp !== read.stamp) return;
    } catch {
      return;
    }
    turnPageRowBytes.add(read.path, read.identity, read.rows, read.spans);
  }

  private async turnPage(
    chatId: string,
    index: SparseIndex,
    active: PersistedChatMessage[],
    before: number | undefined,
    options: TranscriptViewRequest,
    transcriptRevision: number = index.transcriptRevision,
  ): Promise<TranscriptPage> {
    const cached = await this.turnIndex(chatId, index);
    const rowRead = await this.beginTurnPageRowRead(chatId, index);
    let records = cached.turns;
    // Active messages are already a provider-side projection. Fold only the
    // current committed turn with its active suffix. A receipt can also name
    // an earlier owner; start there and keep its canonical receipt correlation.
    let activeTail: PersistedChatMessage[] | undefined;
    let activeTurn = Math.max(0, records.length - 1);
    for (const message of active) {
      for (const block of message.blocks) {
        if (
          block.type !== 'approval_safety_denied_info' ||
          !block.toolUseId ||
          block.subagentId ||
          block.turnUserMessageId === undefined
        )
          continue;
        const owner = records.findIndex(
          (turn) => turn.id === block.turnUserMessageId,
        );
        if (owner >= 0) activeTurn = Math.min(activeTurn, owner);
      }
    }
    const activeStart = records[activeTurn]?.start ?? 0;
    if (active.length > 0) {
      activeTail = await this.turnPageRows(
        index,
        rowRead,
        activeStart,
        index.committedMessageCount,
      );
      activeTail.push(...active);
      records = [
        ...records.slice(0, activeTurn),
        ...(await buildTurnIndex(
          activeTail,
          activeStart,
          cached.turns,
          (message) => this.expandBlocks(chatId, message),
        )),
      ];
    }
    const totalMessages = index.committedMessageCount + active.length;
    const owner = options.turnId
      ? records.find((turn) => turn.id === options.turnId)
      : undefined;
    if (options.turnId && !owner) throw new Error('Unknown transcript turn');
    // A turn read without a cursor starts at that turn's own end.
    const end = before ?? owner?.end ?? totalMessages;
    if (!Number.isSafeInteger(end) || end < 0 || end > totalMessages)
      throw new Error('Invalid transcript page cursor');
    if (owner && (end <= owner.start || end > owner.end))
      throw new Error('Invalid turn page cursor');
    const selected = owner
      ? [owner]
      : records.filter((turn) => turn.start < end).slice(-100);
    const historyBefore = selected[0]?.start;
    // Watcher/internal turns continue the preceding human's sticky section.
    // Include that frame even when a page contains only generated follow-ups,
    // without moving the history cursor past the intervening turns.
    if (
      !owner &&
      index.latestHuman &&
      historyBefore !== undefined &&
      index.latestHuman.ordinal < historyBefore
    ) {
      const ordinal = index.latestHuman.ordinal;
      const context = records.find(
        (turn) => turn.start <= ordinal && ordinal < turn.end,
      );
      if (context) selected.unshift(context);
    }
    const ordinals = new Set<number>();
    const turns: TranscriptTurnSummary[] = [];
    for (const turn of selected) {
      const newest = turn === records[records.length - 1];
      const tailStart = owner
        ? Math.max(turn.start, end - TRANSCRIPT_PAGE_SIZE)
        : newest || !turn.complete
          ? Math.max(turn.start, turn.end - 1000)
          : Math.max(turn.start, turn.end - COMPLETED_TURN_TAIL_SIZE);
      const tailEnd = owner ? end : turn.end;
      for (let ordinal = tailStart; ordinal < tailEnd; ordinal += 1)
        ordinals.add(ordinal);
      for (const ordinal of [...turn.frame, ...turn.retained])
        ordinals.add(ordinal);
      let gapEnd = tailStart;
      while (gapEnd > turn.start && ordinals.has(gapEnd - 1)) gapEnd -= 1;
      let gapStart = turn.start;
      while (gapStart < gapEnd && ordinals.has(gapStart)) gapStart += 1;
      turns.push({
        id: turn.id,
        start: turn.start,
        end: turn.end,
        complete: turn.complete,
        summary: turn.summary,
        outcomes: turn.outcomes,
        deniedToolUseIds: turn.deniedToolUseIds,
        finalMessageIds: turn.finalMessageIds,
        files: turn.files,
        ...(turn.frameTimer ? { frameTimer: turn.frameTimer } : {}),
        ...(gapEnd > gapStart ? { before: gapEnd } : {}),
        ...(turn.continuations ? { continuations: turn.continuations } : {}),
      });
    }
    const ordered = Array.from(ordinals).sort((a, b) => a - b);
    const messages: PersistedChatMessage[] = [];
    // Coalesce nearby runs that would seek from the same sparse checkpoint.
    // Otherwise each retained frame/tail reparses that checkpoint's prefix.
    // Large gaps still seek independently; only selected rows are retained.
    for (let i = 0; i < ordered.length; ) {
      const start = ordered[i];
      let end = start + 1;
      while (
        ++i < ordered.length &&
        (ordered[i] === end ||
          Math.floor(ordered[i] / SPARSE_STRIDE) ===
            Math.floor((end - 1) / SPARSE_STRIDE))
      )
        end = ordered[i] + 1;
      if (activeTail && start >= activeStart) {
        for (let ordinal = start; ordinal < end; ordinal += 1)
          if (ordinals.has(ordinal))
            messages.push(activeTail[ordinal - activeStart]);
      } else {
        for (const row of await this.turnPageRows(
          index,
          rowRead,
          start,
          Math.min(end, index.committedMessageCount),
          ordinals,
        ))
          messages.push(row);
        for (
          let ordinal = Math.max(start, index.committedMessageCount);
          ordinal < end;
          ordinal += 1
        )
          if (ordinals.has(ordinal))
            messages.push(active[ordinal - index.committedMessageCount]);
      }
    }
    await this.finishTurnPageRowRead(rowRead);
    const messageOrdinals = Object.fromEntries(
      messages.map((message, i) => [message.id, ordered[i]]),
    );
    return {
      messages,
      view: 'turns',
      turns,
      totalMessages,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      messageOrdinals,
      transcriptRevision,
      ...(!owner && historyBefore !== undefined && historyBefore > 0
        ? { before: historyBefore }
        : {}),
    };
  }

  private async readReducerFrameRow(
    chatId: string,
    reference: SparseReducerFrameReference,
  ): Promise<PersistedChatMessage> {
    for await (const row of lines(
      this.path(chatId, 'jsonl'),
      reference.offset,
    )) {
      if (row.offset !== reference.offset || row.message.id !== reference.id)
        throw new ChatTranscriptIntegrityError(
          `Reducer frame reference does not match transcript row ${reference.id}`,
        );
      return row.message;
    }
    throw new ChatTranscriptIntegrityError(
      `Reducer frame transcript row is missing: ${reference.id}`,
    );
  }

  private reducerFramePageRanks(
    page: TranscriptPage,
    index: SparseIndex,
    before: number | undefined,
    options: ReducerFrameViewRequest,
    activeMessages: readonly PersistedChatMessage[],
    context: LogicalReadContext | undefined,
  ): Map<string, number> {
    const ranks = new Map<string, number>();
    if (page.messageOrdinals) {
      for (const message of page.messages) {
        const ordinal = page.messageOrdinals[message.id];
        if (Number.isSafeInteger(ordinal)) ranks.set(message.id, ordinal);
      }
      if (ranks.size === page.messages.length) return ranks;
      ranks.clear();
    }

    if (context) {
      const end = before ?? context.ranks.bodyCount;
      const start = Math.max(0, end - TRANSCRIPT_PAGE_SIZE);
      const bodyPageLength = end - start;
      page.messages.forEach((message, position) => {
        if (position < bodyPageLength) {
          ranks.set(message.id, start + position);
          return;
        }
        const activeRank = context.ranks.activeRankById.get(message.id);
        if (activeRank !== undefined) ranks.set(message.id, activeRank);
      });
      return ranks;
    }

    const end = before ?? index.committedMessageCount;
    const start = Math.max(0, end - TRANSCRIPT_PAGE_SIZE);
    const committedPageLength = end - start;
    page.messages.forEach((message, position) => {
      if (position < committedPageLength) {
        ranks.set(message.id, start + position);
        return;
      }
      const activePosition = activeMessages.findIndex(
        (active) => active.id === message.id,
      );
      if (activePosition >= 0)
        ranks.set(message.id, index.committedMessageCount + activePosition);
    });
    if (options.view === 'turns') return ranks;
    return ranks;
  }

  /**
   * Supplement a default reducer view with a bounded current-turn frame. Each
   * selected committed offset is read as exactly one JSONL row; a long current
   * turn is never rescanned. Anchored active rows rank through their logical
   * placement so displaced timers/cards keep their user-visible order.
   */
  private async supplementReducerFrame(
    chatId: string,
    index: SparseIndex,
    page: TranscriptPage,
    before: number | undefined,
    options: ReducerFrameViewRequest,
    activeMessages: readonly PersistedChatMessage[],
    context?: LogicalReadContext,
  ): Promise<TranscriptPage> {
    const persistedFrame = index.reducerFrame;
    if (!options.reducerFrame || !persistedFrame || options.view === 'turns')
      return page;

    const activeReferences: ReducerFramePageReference[] = [];
    if (context) {
      const ranked = Array.from(context.activeByRank.entries()).sort(
        ([left], [right]) => left - right,
      );
      for (const [rank, message] of ranked)
        activeReferences.push({
          id: message.id,
          ordinal: rank,
          message,
          rank,
        });
    } else {
      activeMessages.forEach((message, position) => {
        const rank = index.committedMessageCount + position;
        activeReferences.push({
          id: message.id,
          ordinal: rank,
          message,
          rank,
        });
      });
    }

    const committedBoundaryRank = persistedFrame.boundary
      ? (context?.ranks.committedRankByOrdinal(
          persistedFrame.boundary.ordinal,
        ) ?? persistedFrame.boundary.ordinal)
      : undefined;
    let latestActiveBoundary: ReducerFramePageReference | undefined;
    for (const reference of activeReferences)
      if (
        isUserTurnBoundary(reference.message) &&
        (latestActiveBoundary === undefined ||
          reference.rank > latestActiveBoundary.rank)
      )
        latestActiveBoundary = reference;
    const activeBoundaryOwnsFrame =
      latestActiveBoundary !== undefined &&
      (committedBoundaryRank === undefined ||
        latestActiveBoundary.rank > committedBoundaryRank);
    const currentBoundaryRank =
      activeBoundaryOwnsFrame && latestActiveBoundary
        ? latestActiveBoundary.rank
        : committedBoundaryRank;
    const includeAfterBoundary = (rank: number, isBoundary: boolean): boolean =>
      currentBoundaryRank === undefined ||
      rank > currentBoundaryRank ||
      (isBoundary && rank === currentBoundaryRank);

    const activeEvents = activeReferences.filter(
      (reference) =>
        hasReducerFrameContent(reference.message) &&
        includeAfterBoundary(
          reference.rank,
          isUserTurnBoundary(reference.message),
        ),
    );
    const activeToolUseIds = new Set<string>();
    for (const event of activeEvents)
      for (const toolUseId of distinctToolUseIds(event.message))
        activeToolUseIds.add(toolUseId);

    const sparseReferences = sparseReducerFrameReferences(
      persistedFrame,
      activeToolUseIds,
    );
    const pageMessagesById = new Map(
      page.messages.map((message) => [message.id, message]),
    );
    // The latest timer before the current boundary rides along: the reducer
    // gives a wake a timer only when the chat already has one.
    const timerKeys = new Set(
      persistedFrame.timers.map((timer) => `${timer.ordinal}:${timer.id}`),
    );
    let carriedTimer: SparseReducerFrameReference | undefined;
    if (currentBoundaryRank !== undefined)
      for (const reference of sparseReferences) {
        const rank =
          context?.ranks.committedRankByOrdinal(reference.ordinal) ??
          reference.ordinal;
        if (
          rank < currentBoundaryRank &&
          timerKeys.has(`${reference.ordinal}:${reference.id}`)
        )
          carriedTimer = reference;
      }
    const committedEvents: ReducerFramePageReference[] = [];
    for (const reference of sparseReferences) {
      const rank =
        context?.ranks.committedRankByOrdinal(reference.ordinal) ??
        reference.ordinal;
      const isBoundary =
        persistedFrame.boundary?.ordinal === reference.ordinal &&
        persistedFrame.boundary.id === reference.id;
      if (
        reference !== carriedTimer &&
        !includeAfterBoundary(rank, isBoundary && !activeBoundaryOwnsFrame)
      )
        continue;
      const inPage = pageMessagesById.get(reference.id);
      const message =
        inPage ?? (await this.readReducerFrameRow(chatId, reference));
      committedEvents.push({
        id: message.id,
        ordinal: reference.ordinal,
        offset: reference.offset,
        message,
        rank,
      });
    }

    const events = [...committedEvents, ...activeEvents].sort(
      (left, right) =>
        left.rank - right.rank ||
        left.ordinal - right.ordinal ||
        left.id.localeCompare(right.id),
    );
    let foldedFrame = emptyReducerFrameFold<ReducerFramePageReference>();
    for (const event of events)
      foldedFrame = foldReducerFrame(foldedFrame, event.message, event);

    const selectedFrameRows = new Map<string, ReducerFramePageReference>();
    const addFrameRow = (reference: ReducerFramePageReference): void => {
      selectedFrameRows.set(reference.id, reference);
    };
    if (foldedFrame.boundary) addFrameRow(foldedFrame.boundary);
    foldedFrame.timers.forEach(addFrameRow);
    foldedFrame.cards.forEach(({ row }) => addFrameRow(row));
    for (const tool of foldedFrame.toolUses) {
      addFrameRow(tool.row);
      tool.resultWitnesses.forEach(({ row }) => addFrameRow(row));
    }

    const pageRanks = this.reducerFramePageRanks(
      page,
      index,
      before,
      options,
      activeMessages,
      context,
    );
    const orderedRows = new Map<
      string,
      { message: PersistedChatMessage; rank: number; insertion: number }
    >();
    page.messages.forEach((message, insertion) => {
      const rank = pageRanks.get(message.id);
      if (rank === undefined)
        throw new ChatTranscriptIntegrityError(
          `Transcript page row has no logical rank: ${message.id}`,
        );
      orderedRows.set(message.id, { message, rank, insertion });
    });
    for (const reference of Array.from(selectedFrameRows.values()))
      if (!orderedRows.has(reference.id)) {
        orderedRows.set(reference.id, {
          message: reference.message,
          rank: reference.rank,
          insertion: reference.rank,
        });
      }
    const messages = Array.from(orderedRows.values())
      .sort(
        (left, right) =>
          left.rank - right.rank || left.insertion - right.insertion,
      )
      .map(({ message }) => message);
    return { ...page, messages };
  }

  private async readPageWithActive(
    chatId: string,
    before?: number,
    options: ReducerFrameViewRequest = {},
  ): Promise<{
    page: TranscriptPage;
    activeMessages: PersistedChatMessage[];
    anchored?: true;
  }> {
    return this.serial(chatId, async () => {
      const loaded = await this.load(chatId);
      const { index } = loaded;
      const projection = this.projectedActive(chatId);
      const activeSidecar = projection ? undefined : await this.active(chatId);
      const activeMessages = projection
        ? [...projection.messages]
        : (activeSidecar?.messages ?? []);
      const transcriptRevision =
        projection?.transcriptRevision ?? index.transcriptRevision;
      const anchors = activeSidecar?.activeRowAnchors;
      if (anchors && anchors.size > 0) {
        const context = await this.logicalReadContext(
          chatId,
          index,
          activeMessages,
          anchors,
        );
        const page =
          options.view === 'turns'
            ? await this.logicalTurnPage(
                chatId,
                index,
                context,
                before,
                options,
                transcriptRevision,
              )
            : await this.logicalRawPage(
                chatId,
                index,
                context,
                before,
                transcriptRevision,
              );
        return {
          page: await this.supplementReducerFrame(
            chatId,
            index,
            page,
            before,
            options,
            activeMessages,
            context,
          ),
          activeMessages,
          anchored: true,
        };
      }
      const active: PersistedChatMessage[] = [];
      for (const message of activeMessages) {
        const existing = await this.committedCopy(chatId, loaded, message.id);
        if (existing === undefined) active.push(message);
        else if (!(await this.matchesCommitted(chatId, message, existing)))
          throw new Error('Active message conflicts with committed history');
      }
      if (options.view === 'turns')
        return {
          page: await this.turnPage(
            chatId,
            index,
            active,
            before,
            options,
            transcriptRevision,
          ),
          activeMessages,
        };
      const totalMessages = index.committedMessageCount + active.length;
      const end = before ?? index.committedMessageCount;
      if (
        !Number.isSafeInteger(end) ||
        end < 0 ||
        end > index.committedMessageCount
      )
        throw new Error('Invalid transcript page cursor');
      const start = Math.max(0, end - TRANSCRIPT_PAGE_SIZE);
      let committedPage: CommittedRecentPage;
      if (before === undefined)
        committedPage = await this.committedRecentPage(chatId, index);
      else {
        const messages: PersistedChatMessage[] = [];
        const checkpoint = [...index.offsets]
          .reverse()
          .find((entry) => entry.ordinal <= start);
        if (checkpoint && start < index.committedMessageCount) {
          let ordinal = checkpoint.ordinal;
          for await (const row of lines(
            this.path(chatId, 'jsonl'),
            checkpoint.offset,
          )) {
            if (ordinal >= start && ordinal < end) messages.push(row.message);
            ordinal += 1;
            if (ordinal >= Math.min(end, index.committedMessageCount)) break;
          }
        }
        committedPage = { messages };
      }
      const messages = committedPage.messages;
      if (before === undefined) messages.push(...active);
      let latestHumanMessage =
        [...active].reverse().find(isHumanAuthoredUserMessage) ??
        committedPage.latestHumanMessage;
      if (!latestHumanMessage && index.latestHuman) {
        for await (const row of lines(
          this.path(chatId, 'jsonl'),
          index.latestHuman.offset,
        )) {
          latestHumanMessage = row.message;
          break;
        }
      }
      const page: TranscriptPage = {
        messages,
        totalMessages,
        transcriptRevision,
        ...(start > 0 ? { before: start } : {}),
        ...(latestHumanMessage &&
        !messages.some((message) => message.id === latestHumanMessage.id)
          ? { latestHumanMessage }
          : {}),
      };
      return {
        page: await this.supplementReducerFrame(
          chatId,
          index,
          page,
          before,
          options,
          active,
        ),
        activeMessages,
      };
    });
  }

  public async page(
    chatId: string,
    before?: number,
    options: TranscriptViewRequest = {},
  ): Promise<TranscriptPage> {
    const finishRangeRead = beginMainTranscriptPerformanceStage(
      'range_read',
      chatId,
    );
    const result = (await this.readPageWithActive(chatId, before, options))
      .page;
    finishRangeRead({ loadedRows: result.messages.length });
    return result;
  }

  /**
   * The page plus the active rows it was built from. `anchored` is set when
   * the sidecar's anchors placed rows, so the page is already in logical
   * order; callers must not re-append active rows then. It is absent for an
   * anchor-free chat, whose page is exactly today's.
   */
  public async pageWithActiveMessages(
    chatId: string,
    before?: number,
    options: ReducerFrameViewRequest = {},
  ): Promise<{
    page: TranscriptPage;
    activeMessages: PersistedChatMessage[];
    anchored?: true;
  }> {
    const finishRangeRead = beginMainTranscriptPerformanceStage(
      'range_read',
      chatId,
    );
    const result = await this.readPageWithActive(chatId, before, options);
    finishRangeRead({ loadedRows: result.page.messages.length });
    return result;
  }

  public async *iterate(chatId: string): AsyncGenerator<PersistedChatMessage> {
    // Caller holds the scope read/export lease to prevent concurrent rewrites.
    await this.load(chatId);
    for await (const row of lines(this.path(chatId, 'jsonl')))
      yield row.message;
  }

  /**
   * Stream the complete logical transcript. The existing `iterate` and search
   * preview APIs remain physical: callers that need the user-visible order
   * opt into this projection explicitly.
   */
  public async *iterateLogical(
    chatId: string,
  ): AsyncGenerator<PersistedChatMessage> {
    const { index } = await this.load(chatId);
    const projection = this.projectedActive(chatId);
    const sidecar = projection ? undefined : await this.active(chatId);
    const activeRows = projection?.messages ?? sidecar?.messages ?? [];
    const anchors = sidecar?.activeRowAnchors;
    if (anchors && anchors.size > 0) {
      const context = await this.logicalReadContext(
        chatId,
        index,
        activeRows,
        anchors,
      );
      for (const message of this.logicalActiveMessages(
        context,
        context.placement.start,
      ))
        yield message;
      for await (const row of lines(this.path(chatId, 'jsonl'))) {
        yield row.message;
        const followers = context.placement.afterCommitted.get(row.message.id);
        if (followers)
          for (const message of this.logicalActiveMessages(context, followers))
            yield message;
      }
      for (const message of this.logicalActiveMessages(
        context,
        context.placement.tail,
      ))
        yield message;
      return;
    }

    const activeById = new Map<string, PersistedChatMessage[]>();
    for (const message of activeRows) {
      const rows = activeById.get(message.id) ?? [];
      rows.push(message);
      activeById.set(message.id, rows);
    }
    for await (const row of lines(this.path(chatId, 'jsonl'))) {
      const activeEchoes = activeById.get(row.message.id);
      if (activeEchoes) {
        for (const message of activeEchoes)
          if (!(await this.matchesCommitted(chatId, message, row.message)))
            throw new Error('Active message conflicts with committed history');
        activeById.delete(row.message.id);
      }
      yield row.message;
    }
    for (const message of activeRows) {
      if (activeById.has(message.id)) yield message;
    }
  }

  /** Read a run card and its anchored active rows in logical transcript order. */
  public async readRunMessages(
    chatId: string,
    runId: string,
  ): Promise<PersistedChatMessage[]> {
    return this.serial(chatId, async () => {
      const { index } = await this.load(chatId);
      const projection = this.projectedActive(chatId);
      const sidecar = projection ? undefined : await this.active(chatId);
      const activeRows = projection?.messages ?? sidecar?.messages ?? [];
      const anchors = sidecar?.activeRowAnchors;
      if (!anchors || anchors.size === 0) {
        const activeCard = activeRows.find(
          (message) => message.id === runId && hasDelegatedAgentCall(message),
        );
        if (activeCard) {
          const committed = await this.readCommittedMessage(chatId, runId);
          if (
            committed &&
            !(await this.matchesCommitted(chatId, activeCard, committed))
          )
            throw new Error('Active message conflicts with committed history');
          return [activeCard];
        }
        const committedCard = await this.readCommittedMessage(chatId, runId);
        return committedCard && hasDelegatedAgentCall(committedCard)
          ? [committedCard]
          : [];
      }
      const context = await this.logicalReadContext(
        chatId,
        index,
        activeRows,
        anchors,
      );

      let card = activeRows.find(
        (message) => message.id === runId && hasDelegatedAgentCall(message),
      );
      let cardRank = context.ranks.activeRankById.get(runId);
      if (context.committedById.has(runId)) {
        const metadata = context.committedById.get(runId);
        if (!metadata?.isRunCard) return [];
        cardRank = context.ranks.committedRankByOrdinal(metadata.ordinal);
        card = logicalCommittedRows.get(
          this.path(chatId, 'jsonl'),
          context.committedStamp,
          metadata.ordinal,
        );
        if (!card) {
          card = await this.readCommittedMessage(chatId, runId);
          if (!card) return [];
          logicalCommittedRows.set(
            this.path(chatId, 'jsonl'),
            context.committedStamp,
            metadata.ordinal,
            card,
          );
        }
      } else if (!card) {
        const committedCard = await this.readCommittedMessage(chatId, runId);
        if (!committedCard || !hasDelegatedAgentCall(committedCard)) return [];
        const ordinal = await this.committedOrdinal(chatId, index, runId);
        if (ordinal === undefined) return [];
        cardRank = context.ranks.committedRankByOrdinal(ordinal);
        card = committedCard;
        logicalCommittedRows.set(
          this.path(chatId, 'jsonl'),
          context.committedStamp,
          ordinal,
          committedCard,
        );
      }
      if (!card || cardRank === undefined) return [];

      const runRows: Array<{ rank: number; message: PersistedChatMessage }> = [
        { rank: cardRank, message: card },
      ];
      context.activeById.forEach((message: PersistedChatMessage): void => {
        if (message.id === runId) return;
        if (anchors.get(message.id)?.runId !== runId) return;
        const rank = context.ranks.activeRankById.get(message.id);
        if (rank !== undefined) runRows.push({ rank, message });
      });
      runRows.sort((left, right) => left.rank - right.rank);
      return runRows.map(({ message }) => message);
    });
  }

  /** Capture only file handles and a verified descriptor under the scope lease.
   * Search parses the immutable committed prefix and active snapshot later.
   * This path does not inventory or rebuild derived message locators when its
   * sparse index is valid.
   */
  /**
   * {@link capturePreview} for a chat whose active rows a delta journal holds
   * ahead of its files: the committed prefix comes from the log, the active
   * rows from the projection, and no active sidecar handle is captured.
   */
  private async captureProjectedPreview(
    chatId: string,
    canonical: TranscriptDescriptor,
    projection: TranscriptActiveProjection,
  ): Promise<CapturedTranscriptPreview> {
    const { index } = await this.load(chatId);
    if (
      canonical.format !== index.format ||
      canonical.committedMessageCount !== index.committedMessageCount ||
      canonical.committedByteLength !== index.committedByteLength ||
      (canonical.committedDigest !== undefined &&
        canonical.committedDigest !== index.committedDigest)
    )
      throw new ChatTranscriptIntegrityError(
        'Transcript preview canonical descriptor mismatch',
      );
    const committedHandle = await open(this.path(chatId, 'jsonl'), 'r');
    let transferred = false;
    try {
      const committed = await capturedPreviewFile(committedHandle);
      if (committed.size !== index.committedByteLength)
        throw new ChatTranscriptIntegrityError(
          'Transcript preview committed length mismatch',
        );
      const hasActiveSidecar = projection.messages.length > 0;
      const anchors = survivingActiveRowAnchors(
        projection.messages,
        copyActiveRowAnchors(projection.anchors),
      );
      const descriptor: TranscriptDescriptor = {
        ...canonical,
        format: index.format,
        committedDigest: index.committedDigest,
        committedMessageCount: index.committedMessageCount,
        committedByteLength: index.committedByteLength,
        transcriptRevision: projection.transcriptRevision,
        hasActiveSidecar,
      };
      if (anchors.size > 0)
        descriptor.hasOrdinaryActiveRows = await this.hasOrdinaryActiveRows(
          chatId,
          projection.messages,
          anchors,
        );
      else delete descriptor.hasOrdinaryActiveRows;
      if (
        canonical.transcriptRevision !== projection.transcriptRevision ||
        canonical.hasActiveSidecar !== hasActiveSidecar ||
        canonical.hasOrdinaryActiveRows !== descriptor.hasOrdinaryActiveRows
      ) {
        // The caller's descriptor describes another active generation.
        delete descriptor.messageCount;
        delete descriptor.userMessageCount;
        delete descriptor.firstMessageAt;
        delete descriptor.lastMessageAt;
        delete descriptor.lastMessageId;
        delete descriptor.lastMessageRole;
        delete descriptor.lastAssistantPreview;
        delete descriptor.todos;
        delete descriptor.taskTodos;
      }
      transferred = true;
      return new CapturedTranscriptPreview(
        descriptor,
        committed,
        undefined,
        projection.messages,
      );
    } finally {
      if (!transferred) await committedHandle.close();
    }
  }

  /** Warm, committed-only handle capture. Never loads/rebuilds an index or
   * reads active rows on the host; the thread verifies the canonical digest.
   */
  public async captureCommittedPreview(
    chatId: string,
    canonical: TranscriptDescriptor,
  ): Promise<CapturedTranscriptPreview> {
    if (
      canonical.hasActiveSidecar ||
      this.projectedActive(chatId)?.messages.length ||
      !canonical.committedDigest ||
      canonical.committedByteLength > 16 * 1024 * 1024 ||
      canonical.committedMessageCount > 20_000
    )
      throw new Error('Chat learning requires a bounded committed transcript');
    const handle = await open(this.path(chatId, 'jsonl'), 'r');
    try {
      const file = await capturedPreviewFile(handle);
      if (file.size !== canonical.committedByteLength)
        throw new Error('Chat learning committed length mismatch');
      return new CapturedTranscriptPreview(canonical, file);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  public async capturePreview(
    chatId: string,
    canonical: TranscriptDescriptor,
  ): Promise<CapturedTranscriptPreview> {
    return this.serial(chatId, async () => {
      const projection = this.projectedActive(chatId);
      if (projection)
        return this.captureProjectedPreview(chatId, canonical, projection);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let index: MaintenanceCommittedIndex;
        try {
          index = await this.maintenanceCommittedIndex(chatId);
        } catch {
          // A legacy or damaged derived index uses the ordinary recovery path.
          // A valid common-case index never pays for locator inventory here.
          this.loaded.delete(chatId);
          const loaded = await this.load(chatId);
          const candidate = loaded.index;
          index = {
            format: candidate.format,
            committedDigest: candidate.committedDigest,
            committedMessageCount: candidate.committedMessageCount,
            committedByteLength: candidate.committedByteLength,
            transcriptRevision: candidate.transcriptRevision,
            hasActiveSidecar: candidate.hasActiveSidecar,
            ...(candidate.hasOrdinaryActiveRows === undefined
              ? {}
              : { hasOrdinaryActiveRows: candidate.hasOrdinaryActiveRows }),
            messageCount: candidate.messageCount,
            userMessageCount: candidate.userMessageCount,
            firstMessageAt: candidate.firstMessageAt,
            lastMessageAt: candidate.lastMessageAt,
          };
        }
        if (
          canonical.format !== index.format ||
          canonical.committedMessageCount !== index.committedMessageCount ||
          canonical.committedByteLength !== index.committedByteLength ||
          (canonical.committedDigest !== undefined &&
            canonical.committedDigest !== index.committedDigest)
        )
          throw new ChatTranscriptIntegrityError(
            'Transcript preview canonical descriptor mismatch',
          );
        const committedHandle = await open(this.path(chatId, 'jsonl'), 'r');
        let activeHandle: FileHandle | undefined;
        let retryFinalization = false;
        let transferred = false;
        try {
          const committed = await capturedPreviewFile(committedHandle);
          if (committed.size !== index.committedByteLength)
            throw new ChatTranscriptIntegrityError(
              'Transcript preview committed length mismatch',
            );
          try {
            activeHandle = await open(this.path(chatId, 'active.json'), 'r');
          } catch (error) {
            if (!(isErrnoException(error) && error.code === 'ENOENT'))
              throw error;
          }
          if (!!activeHandle !== index.hasActiveSidecar)
            throw new ChatTranscriptIntegrityError(
              'Transcript preview active sidecar mismatch',
            );
          const active = activeHandle
            ? await capturedPreviewFile(activeHandle)
            : undefined;
          if (active) {
            const prefix = Buffer.alloc(1024);
            const { bytesRead } = await active.handle.read(
              prefix,
              0,
              prefix.length,
              0,
            );
            const firstLine = prefix
              .subarray(0, bytesRead)
              .toString('utf8')
              .split('\n')[0];
            const version = /"version"\s*:\s*(\d+)/.exec(firstLine)?.[1];
            if (version === '2') {
              const parsed: unknown = JSON.parse(firstLine);
              if (!isActiveSidecarHeaderV2(parsed))
                throw new ChatTranscriptIntegrityError(
                  'Invalid captured active header',
                );
              if (parsed.transcriptRevision !== index.transcriptRevision)
                throw new ChatTranscriptIntegrityError(
                  'Transcript preview active revision mismatch',
                );
              retryFinalization = !!parsed.finalizing;
            } else if (version === '1' && attempt === 0)
              retryFinalization = true;
            else if (version !== '1')
              throw new ChatTranscriptIntegrityError(
                'Invalid captured active sidecar',
              );
          }
          if (!retryFinalization) {
            const descriptor: TranscriptDescriptor = {
              ...canonical,
              format: index.format,
              committedDigest: index.committedDigest,
              committedMessageCount: index.committedMessageCount,
              committedByteLength: index.committedByteLength,
              transcriptRevision: index.transcriptRevision,
              hasActiveSidecar: index.hasActiveSidecar,
            };
            const activeSnapshot = activeHandle
              ? await this.active(chatId)
              : undefined;
            const anchors = activeSnapshot?.activeRowAnchors;
            if (anchors && anchors.size > 0)
              descriptor.hasOrdinaryActiveRows =
                await this.hasOrdinaryActiveRows(
                  chatId,
                  activeSnapshot.messages,
                  anchors,
                );
            else delete descriptor.hasOrdinaryActiveRows;
            if (
              canonical.transcriptRevision !== index.transcriptRevision ||
              canonical.hasActiveSidecar !== index.hasActiveSidecar ||
              canonical.hasOrdinaryActiveRows !==
                descriptor.hasOrdinaryActiveRows
            ) {
              // An out-of-band active-sidecar replacement can advance the log
              // index before the scope summary. Its optional derived metadata
              // then describes a different active generation.
              delete descriptor.messageCount;
              delete descriptor.userMessageCount;
              delete descriptor.firstMessageAt;
              delete descriptor.lastMessageAt;
              delete descriptor.lastMessageId;
              delete descriptor.lastMessageRole;
              delete descriptor.lastAssistantPreview;
              delete descriptor.todos;
              delete descriptor.taskTodos;
            }
            transferred = true;
            return new CapturedTranscriptPreview(descriptor, committed, active);
          }
        } finally {
          if (!transferred)
            await Promise.all([committedHandle.close(), activeHandle?.close()]);
        }
        this.loaded.delete(chatId);
        await this.load(chatId);
      }
      throw new ChatTranscriptIntegrityError(
        'Transcript preview finalization did not settle',
      );
    });
  }

  /** Cleanup must not invoke load(): missing derived locators can make it
   * rebuild and stream an entire transcript before a nominally bounded slice.
   */
  private async maintenanceCommittedIndex(
    chatId: string,
    expected?: TranscriptDescriptor,
  ): Promise<MaintenanceCommittedIndex> {
    const path = this.path(chatId, 'index.json');
    const before = await fileIdentity(path);
    if (before.bytes < 1 || before.bytes > MAX_MAINTENANCE_INDEX_BYTES)
      throw new Error('Artifact maintenance index exceeds size limit');
    let cached = maintenanceIndexCache.get(path);
    if (cached?.stamp !== before.stamp) {
      maintenanceIndexCache.delete(path);
      const handle = await open(path, 'r');
      try {
        if (fileStatStamp(await handle.stat({ bigint: true })) !== before.stamp)
          throw new Error('Artifact maintenance index changed during read');
        const bytes = Buffer.alloc(before.bytes);
        let read = 0;
        while (read < bytes.length) {
          const result = await handle.read(
            bytes,
            read,
            bytes.length - read,
            read,
          );
          if (result.bytesRead === 0)
            throw new Error('Artifact maintenance index changed during read');
          read += result.bytesRead;
        }
        if (
          fileStatStamp(await handle.stat({ bigint: true })) !== before.stamp ||
          (await fileIdentity(path)).stamp !== before.stamp
        )
          throw new Error('Artifact maintenance index changed during read');
        const parsed: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
        if (!isSparseIndexWithChecksum(parsed))
          throw new Error('Invalid artifact maintenance index');
        const { checksum, ...candidate } = parsed;
        if (
          checksum !== indexChecksum(candidate) ||
          candidate.committedMessageCount < 0 ||
          candidate.committedByteLength < 0
        )
          throw new Error('Invalid artifact maintenance index');
        cached = {
          stamp: before.stamp,
          index: {
            format: candidate.format,
            committedDigest: candidate.committedDigest,
            committedMessageCount: candidate.committedMessageCount,
            committedByteLength: candidate.committedByteLength,
            transcriptRevision: candidate.transcriptRevision,
            hasActiveSidecar: candidate.hasActiveSidecar,
            ...(candidate.hasOrdinaryActiveRows === undefined
              ? {}
              : { hasOrdinaryActiveRows: candidate.hasOrdinaryActiveRows }),
            messageCount: candidate.messageCount,
            userMessageCount: candidate.userMessageCount,
            firstMessageAt: candidate.firstMessageAt,
            lastMessageAt: candidate.lastMessageAt,
          },
        };
        maintenanceIndexCache.set(path, cached);
        while (maintenanceIndexCache.size > 8) {
          const oldest = maintenanceIndexCache.keys().next().value;
          if (oldest === undefined) break;
          maintenanceIndexCache.delete(oldest);
        }
      } finally {
        await handle.close();
      }
    }
    if (!cached) throw new Error('Invalid artifact maintenance index');
    const index = cached.index;
    if (
      expected &&
      (expected.format !== index.format ||
        expected.committedDigest !== index.committedDigest ||
        expected.committedMessageCount !== index.committedMessageCount ||
        expected.committedByteLength !== index.committedByteLength)
    )
      throw new Error('Artifact maintenance canonical descriptor mismatch');
    const log = await fileIdentity(this.path(chatId, 'jsonl'));
    if (log.bytes !== index.committedByteLength)
      throw new ChatTranscriptIntegrityError(
        'Artifact maintenance committed transcript length mismatch',
      );
    return index;
  }

  /** A bounded, row-aligned maintenance read. The caller owns the scope lease. */
  public async artifactReferenceSlice(
    chatId: string,
    offset: number,
    maxBytes: number,
    expected?: TranscriptDescriptor,
  ): Promise<ArtifactReferenceSlice> {
    return this.serial(chatId, async () => {
      const index = await this.maintenanceCommittedIndex(chatId, expected);
      return this.committedReferenceSlice(
        chatId,
        offset,
        maxBytes,
        index.committedByteLength,
        `${index.committedDigest}:${index.committedMessageCount}:${index.committedByteLength}`,
      );
    });
  }

  /**
   * {@link artifactReferenceSlice} for a child stream, bounded by its
   * descriptor's committed length: the descriptor, not the store index, is
   * a child stream's authority.
   */
  public async childArtifactReferenceSlice(
    streamKey: string,
    offset: number,
    maxBytes: number,
    committedByteLength: number,
  ): Promise<ArtifactReferenceSlice> {
    if (!this.options.childMode) throw new Error('Child mode required');
    return this.serial(streamKey, async () => {
      const log = await fileIdentity(this.path(streamKey, 'jsonl'));
      if (log.bytes !== committedByteLength)
        throw new ChatTranscriptIntegrityError(
          'Artifact maintenance child transcript length mismatch',
        );
      return this.committedReferenceSlice(
        streamKey,
        offset,
        maxBytes,
        committedByteLength,
        String(committedByteLength),
      );
    });
  }

  private async committedReferenceSlice(
    chatId: string,
    offset: number,
    maxBytes: number,
    committedByteLength: number,
    committedIdentity: string,
  ): Promise<ArtifactReferenceSlice> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > committedByteLength ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 1024 * 1024
    )
      throw new Error('Invalid artifact reference scan cursor');
    const path = this.path(chatId, 'jsonl');
    const before = await fileIdentity(path);
    const identity = `${committedIdentity}:${before.stamp}`;
    let nextOffset = offset;
    let scannedBytes = 0;
    const artifactIds: string[] = [];
    if (offset < committedByteLength)
      for await (const row of lines(path, offset)) {
        if (row.end > committedByteLength)
          throw new Error('Artifact scan crossed committed transcript');
        nextOffset = row.end;
        scannedBytes += row.end - row.offset;
        if (row.message.blocksRef) {
          const references = await this.pagedArtifactIds(chatId, row.message);
          artifactIds.push(...references.artifactIds);
          scannedBytes += references.pageBytes;
        } else artifactIds.push(...rowArtifactIds(row.message));
        if (scannedBytes >= maxBytes) break;
      }
    const after = await fileIdentity(path);
    if (before.stamp !== after.stamp)
      throw new Error('Committed transcript changed during artifact scan');
    if (nextOffset === offset && offset < committedByteLength)
      throw new Error('Artifact scan did not advance');
    return {
      identity,
      nextOffset,
      complete: nextOffset === committedByteLength,
      scannedBytes,
      artifactIds,
    };
  }

  /** A paged row's closure, with the bytes its traversal read. */
  private async pagedArtifactIds(
    chatId: string,
    message: PersistedChatMessage,
  ): Promise<{ artifactIds: string[]; pageBytes: number }> {
    const artifactIds: string[] = [];
    let pageBytes = 0;
    for await (const reference of this.artifacts.referenceClosure(
      this.paths.owner(chatId),
      message,
    )) {
      artifactIds.push(reference.artifactId);
      pageBytes += reference.byteLength;
    }
    // The closure covers tool output; visuals live on the paged blocks.
    for (const block of (await this.expandBlocks(chatId, message)).blocks)
      artifactIds.push(...artifactIdsOf(block, 'visual'));
    return { artifactIds, pageBytes };
  }

  /** Bound the mutable sidecar pass as well as the committed-prefix pass. */
  public async artifactActiveReferenceSlice(
    chatId: string,
    offset: number,
    maxBytes: number,
  ): Promise<ArtifactReferenceSlice> {
    return this.serial(chatId, async () => {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 1024 * 1024
      )
        throw new Error('Invalid active artifact scan cursor');
      const path = this.path(chatId, 'active.json');
      let before: Awaited<ReturnType<typeof fileIdentity>>;
      try {
        before = await fileIdentity(path);
      } catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
        if (offset !== 0)
          throw new Error('Active transcript changed during artifact scan');
        return {
          identity: 'absent',
          nextOffset: 0,
          complete: true,
          scannedBytes: 0,
          artifactIds: [],
        };
      }
      if (offset > before.bytes)
        throw new Error('Active artifact scan crossed sidecar length');
      const prefix = Buffer.alloc(1024);
      const handle = await open(path, 'r');
      let bytesRead = 0;
      try {
        ({ bytesRead } = await handle.read(prefix, 0, prefix.length, 0));
      } finally {
        await handle.close();
      }
      const match = /"version"\s*:\s*(\d+)/.exec(
        prefix.subarray(0, bytesRead).toString('utf8'),
      );
      const version = match ? Number(match[1]) : undefined;
      const artifactIds: string[] = [];
      let nextOffset = offset;
      let scannedBytes = 0;
      let activeHeaderFinalizing: boolean | undefined;
      let activeFinalizingRows = 0;
      if (version === 1) {
        // Rolling-upgrade sidecars use an object/array format. A larger legacy
        // sidecar waits for the next canonical write to replace it with v2.
        if (offset !== 0 || before.bytes > maxBytes)
          throw new Error(
            'Large legacy active sidecar defers artifact cleanup',
          );
        const legacy = await readLegacyActiveSidecar(path);
        if (!isActiveSidecar(legacy))
          throw new Error('Invalid active transcript sidecar');
        scannedBytes = before.bytes;
        for (const message of legacy.messages)
          if (message.blocksRef) {
            const references = await this.pagedArtifactIds(chatId, message);
            artifactIds.push(...references.artifactIds);
            scannedBytes += references.pageBytes;
          } else artifactIds.push(...rowArtifactIds(message));
        nextOffset = before.bytes;
      } else if (version === 2) {
        if (offset < before.bytes)
          for await (const row of activeRowsWithOffsets(path, offset)) {
            if (row.end > before.bytes)
              throw new Error('Active artifact scan crossed sidecar length');
            if (row.offset === 0) {
              if (!isActiveSidecarHeaderV2(row.value))
                throw new Error('Invalid active transcript sidecar header');
              activeHeaderFinalizing = !!row.value.finalizing;
            } else {
              if (!isActiveSidecarMessageV2(row.value))
                throw new Error('Invalid active transcript sidecar message');
              parseSidecarRowAnchor(row.value);
              if (row.value.finalizing) activeFinalizingRows += 1;
              if (row.value.message.blocksRef) {
                const references = await this.pagedArtifactIds(
                  chatId,
                  row.value.message,
                );
                artifactIds.push(...references.artifactIds);
                scannedBytes += references.pageBytes;
              } else artifactIds.push(...rowArtifactIds(row.value.message));
            }
            nextOffset = row.end;
            scannedBytes += row.end - row.offset;
            if (scannedBytes >= maxBytes) break;
          }
      } else throw new Error('Invalid active transcript sidecar');
      const after = await fileIdentity(path);
      if (before.stamp !== after.stamp)
        throw new Error('Active transcript changed during artifact scan');
      if (nextOffset === offset && offset < before.bytes)
        throw new Error('Active artifact scan did not advance');
      return {
        identity: before.stamp,
        nextOffset,
        complete: nextOffset === before.bytes,
        scannedBytes,
        artifactIds,
        ...(activeHeaderFinalizing !== undefined
          ? { activeHeaderFinalizing }
          : {}),
        activeFinalizingRows,
      };
    });
  }

  /** Descriptor plus inode identity; verify again immediately before unlink. */
  public async artifactReferenceIdentity(
    chatId: string,
    expected?: TranscriptDescriptor,
    childInputs: readonly {
      streamKey: string;
      streamRevision: number;
      committedSha256: string;
      committedByteLength: number;
      pendingJournalDigest?: string;
    }[] = [],
  ): Promise<string> {
    return this.serial(chatId, async () => {
      const index = await this.maintenanceCommittedIndex(chatId, expected);
      const committed = await fileIdentity(this.path(chatId, 'jsonl'));
      let active = 'absent';
      try {
        active = (await fileIdentity(this.path(chatId, 'active.json'))).stamp;
      } catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
      }
      const child = [...childInputs].sort((left, right) =>
        left.streamKey.localeCompare(right.streamKey),
      );
      const primary = `${index.committedDigest}:${index.committedMessageCount}:${index.committedByteLength}:${committed.stamp}:${active}`;
      return child.length === 0
        ? primary
        : `${primary}:${createHash('sha256').update(JSON.stringify(child)).digest('hex')}`;
    });
  }
}

/** Primary-chat facade preserves owner cleanup and the existing constructor. */
export class ChatTranscriptLog extends TranscriptStreamStore {
  public readonly delegations: ChatDelegationLogs;
  public readonly childDeleteFence: ReturnType<typeof chatChildDeleteFence>;

  public constructor(
    root: string,
    onAppendBoundary?: (boundary: AppendBoundary) => Promise<void>,
    options: {
      readOnly?: boolean;
      now?: () => number;
      testHooks?: ChatTranscriptLogTestHooks;
    } = {},
  ) {
    super(
      primaryTranscriptPaths(root),
      new ChatTranscriptArtifacts(root, options.readOnly),
      onAppendBoundary,
      options,
    );
    this.delegations = new ChatDelegationLogs(root, options.readOnly);
    this.childDeleteFence = chatChildDeleteFence(root);
    this.root = root;
  }

  private readonly root: string;

  /**
   * Chat ids whose active sidecar holds at least one row anchor. Lists the
   * sidecar files and parses only those, without loading or repairing logs.
   */
  public async anchoredChatIds(): Promise<string[]> {
    const suffix = '.active.json';
    const names: string[] = [];
    try {
      const directory = await opendir(this.root);
      for await (const entry of directory)
        if (entry.isFile() && entry.name.endsWith(suffix))
          names.push(entry.name.slice(0, -suffix.length));
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    const anchored: string[] = [];
    for (const chatId of names.sort()) {
      try {
        assertTranscriptIdentity(chatId);
      } catch {
        continue;
      }
      const sidecar = await this.serial(chatId, () => this.active(chatId));
      if (sidecar?.activeRowAnchors && sidecar.activeRowAnchors.size > 0)
        anchored.push(chatId);
    }
    return anchored;
  }

  protected override async removeOwnedContent(chatId: string): Promise<void> {
    for (const { directory } of STORED_ARTIFACT_LOCATIONS) {
      const familyDirectory = join(this.root, directory);
      const chatArtifactDirectory = join(familyDirectory, chatId);
      const existed = await directoryExists(chatArtifactDirectory);
      await rm(chatArtifactDirectory, { recursive: true, force: true });
      if (existed) await fsyncDirectory(familyDirectory);
    }
    // A format-4 checkpoint records removal of v2 streams in its publishing
    // marker and removes them only after the scope indexes no longer own the
    // parent. Keep the whole delegation tree until that publication barrier,
    // but fence appends now so none recreates it afterwards.
    try {
      await stat(join(this.root, 'delegations', chatId, 'v2'));
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
      await this.delegations.remove(chatId);
      return;
    }
    await this.delegations.retire(chatId);
  }
}
