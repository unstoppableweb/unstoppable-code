import type {
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedToolOutputReference,
  TranscriptBlocksReference,
  TodoItem,
} from './types';
import type { TurnOutcomeCounts } from '@canopy/protocol/portal';
import type { TurnFileRecord as TranscriptTurnFile } from '@canopy/protocol/turn-files';

export const TRANSCRIPT_PAGE_SIZE = 500;
export const TOOL_OUTPUT_INLINE_BYTES = 65_536;
export const TOOL_OUTPUT_PREVIEW_HEAD_BYTES = 49_152;

/** A row field whose complete body may live in a tool-output artifact. */
export type TranscriptBodyField =
  | 'output'
  | 'text'
  | 'input'
  | 'partialText'
  | 'finalText';

export interface TranscriptBodyReference {
  blockOrdinal: number;
  field: TranscriptBodyField;
  reference: PersistedToolOutputReference;
}

/**
 * One ordered descriptor of a block manifest: a leaf page or a child
 * manifest covering `blockCount` blocks from `firstBlockOrdinal`.
 */
export interface TranscriptBlockManifestEntry {
  kind: 'page' | 'manifest';
  firstBlockOrdinal: number;
  blockCount: number;
  reference: PersistedToolOutputReference;
}

/** Canonical JSON body of a block manifest artifact. */
export interface TranscriptBlockManifest {
  version: 1;
  kind: 'transcript-block-manifest';
  firstBlockOrdinal: number;
  blockCount: number;
  entries: TranscriptBlockManifestEntry[];
}

/** Canonical JSON body of a block page artifact. */
export interface TranscriptBlockPage {
  version: 1;
  kind: 'transcript-block-page';
  firstBlockOrdinal: number;
  blocks: PersistedChatBlock[];
}

const REFERENCE_KEYS = [
  'version',
  'artifactId',
  'byteLength',
  'sha256',
  'encoding',
  'mediaType',
];

const BLOCKS_REFERENCE_KEYS = ['version', 'manifest', 'blockCount'];
const MANIFEST_KEYS = [
  'version',
  'kind',
  'firstBlockOrdinal',
  'blockCount',
  'entries',
];
const MANIFEST_ENTRY_KEYS = [
  'kind',
  'firstBlockOrdinal',
  'blockCount',
  'reference',
];
const BLOCK_PAGE_KEYS = ['version', 'kind', 'firstBlockOrdinal', 'blocks'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTranscriptBlockManifestEntry(
  value: unknown,
): value is TranscriptBlockManifestEntry {
  return (
    isRecord(value) &&
    hasExactKeys(value, MANIFEST_ENTRY_KEYS) &&
    (value.kind === 'page' || value.kind === 'manifest') &&
    isNonNegativeSafeInteger(value.firstBlockOrdinal) &&
    isPositiveSafeInteger(value.blockCount) &&
    Number.isSafeInteger(value.firstBlockOrdinal + value.blockCount) &&
    isPersistedToolOutputReference(value.reference)
  );
}

/**
 * Strict shape check for an untrusted body reference: the protocol schema's
 * fields, nothing else, and an artifact ID derived from its digest.
 */
export function isPersistedToolOutputReference(
  value: unknown,
): value is PersistedToolOutputReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const keys = Object.keys(value);
  if (
    keys.length !== REFERENCE_KEYS.length ||
    !keys.every((key) => REFERENCE_KEYS.includes(key))
  )
    return false;
  return (
    'version' in value &&
    value.version === 1 &&
    'sha256' in value &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    'artifactId' in value &&
    value.artifactId === `sha256-v1-${value.sha256}` &&
    'byteLength' in value &&
    typeof value.byteLength === 'number' &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    'encoding' in value &&
    (value.encoding === 'utf-8' || value.encoding === 'utf-16le') &&
    'mediaType' in value &&
    value.mediaType === 'text/plain'
  );
}

/** Strict shape check for the root reference stored on a paged transcript row. */
export function isTranscriptBlocksReference(
  value: unknown,
): value is TranscriptBlocksReference {
  return (
    isRecord(value) &&
    hasExactKeys(value, BLOCKS_REFERENCE_KEYS) &&
    value.version === 1 &&
    isPersistedToolOutputReference(value.manifest) &&
    isPositiveSafeInteger(value.blockCount)
  );
}

/** Strict shape and contiguous coverage check for a block manifest artifact. */
export function isTranscriptBlockManifest(
  value: unknown,
): value is TranscriptBlockManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, MANIFEST_KEYS) ||
    value.version !== 1 ||
    value.kind !== 'transcript-block-manifest' ||
    !isNonNegativeSafeInteger(value.firstBlockOrdinal) ||
    !isPositiveSafeInteger(value.blockCount) ||
    !Array.isArray(value.entries)
  ) {
    return false;
  }

  const endBlockOrdinal = value.firstBlockOrdinal + value.blockCount;
  if (!Number.isSafeInteger(endBlockOrdinal)) return false;

  let nextBlockOrdinal = value.firstBlockOrdinal;
  for (const entry of value.entries) {
    if (
      !isTranscriptBlockManifestEntry(entry) ||
      entry.firstBlockOrdinal !== nextBlockOrdinal
    ) {
      return false;
    }
    nextBlockOrdinal += entry.blockCount;
    if (!Number.isSafeInteger(nextBlockOrdinal)) return false;
  }

  return nextBlockOrdinal === endBlockOrdinal;
}

/** Strict shape check for a block page, using the caller's block schema. */
export function isTranscriptBlockPage(
  value: unknown,
  isBlock: (value: unknown) => value is PersistedChatBlock,
): value is TranscriptBlockPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, BLOCK_PAGE_KEYS) ||
    value.version !== 1 ||
    value.kind !== 'transcript-block-page' ||
    !isNonNegativeSafeInteger(value.firstBlockOrdinal) ||
    !Array.isArray(value.blocks) ||
    value.blocks.length === 0 ||
    !Number.isSafeInteger(value.firstBlockOrdinal + value.blocks.length)
  ) {
    return false;
  }
  return value.blocks.every(isBlock);
}

function canonicalReference(
  reference: PersistedToolOutputReference,
): PersistedToolOutputReference {
  return {
    version: reference.version,
    artifactId: reference.artifactId,
    byteLength: reference.byteLength,
    sha256: reference.sha256,
    encoding: reference.encoding,
    mediaType: reference.mediaType,
  };
}

function stringifyCanonical(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('Transcript block artifact cannot be encoded as JSON');
  }
  return encoded;
}

/** Encode a validated manifest using the canonical persisted key order. */
export function encodeTranscriptBlockManifest(
  value: TranscriptBlockManifest,
): string {
  if (!isTranscriptBlockManifest(value)) {
    throw new TypeError('Invalid transcript block manifest');
  }
  return stringifyCanonical({
    version: value.version,
    kind: value.kind,
    firstBlockOrdinal: value.firstBlockOrdinal,
    blockCount: value.blockCount,
    entries: value.entries.map((entry) => ({
      kind: entry.kind,
      firstBlockOrdinal: entry.firstBlockOrdinal,
      blockCount: entry.blockCount,
      reference: canonicalReference(entry.reference),
    })),
  });
}

/** Encode a block page without rewriting any opaque persisted block keys. */
export function encodeTranscriptBlockPage(value: TranscriptBlockPage): string {
  return stringifyCanonical({
    version: value.version,
    kind: value.kind,
    firstBlockOrdinal: value.firstBlockOrdinal,
    blocks: value.blocks,
  });
}

/**
 * Every artifact reference a row's blocks carry, in block order. Closure,
 * capture, copy and recovery enumerate references only through this.
 */
export function transcriptBodyReferences(
  message: Pick<PersistedChatMessage, 'blocks'>,
): TranscriptBodyReference[] {
  const references: TranscriptBodyReference[] = [];
  message.blocks.forEach((block, blockOrdinal) => {
    const add = (
      field: TranscriptBodyField,
      reference: PersistedToolOutputReference | undefined,
    ): void => {
      if (reference) references.push({ blockOrdinal, field, reference });
    };
    if (block.type === 'tool_result') add('output', block.fullOutputRef);
    else if (block.type === 'text' || block.type === 'thinking')
      add('text', block.textRef);
    else if (block.type === 'tool_use') add('input', block.inputRef);
    else if (block.type === 'delegated_agent_call') {
      add('partialText', block.partialTextRef);
      add('finalText', block.finalTextRef);
    }
  });
  return references;
}

export interface TranscriptDescriptor {
  format: 'complete-message-jsonl-v1';
  committedMessageCount: number;
  committedByteLength: number;
  transcriptRevision: number;
  hasActiveSidecar: boolean;
  /**
   * Whether uncommitted active rows without an anchor exist: the parent's
   * unfinished ordinary tail. Anchored rows of a live delegate run do not
   * count. Present only while the active sidecar includes anchored rows;
   * without anchors, `hasActiveSidecar` already describes the same predicate.
   * Also absent on older descriptors, so readers that infer an unfinished
   * turn fall back to `hasActiveSidecar`.
   */
  hasOrdinaryActiveRows?: boolean;
  /**
   * Hash chain over the committed rows in order, seeded by a fixed constant;
   * identifies the committed prefix content independently of its length or
   * of active-sidecar updates. Absent only on descriptors persisted before it
   * existed.
   */
  committedDigest?: string;
  /** Counts include the active suffix in scope index descriptors. */
  messageCount?: number;
  userMessageCount?: number;
  firstMessageAt?: number;
  lastMessageAt?: number;
  lastMessageId?: string;
  /** Newest user/assistant row, ignoring system/tool rows. Absent when unknown. */
  lastMessageRole?: 'user' | 'assistant';
  /** Bounded derived text for unread badges; never a transcript source. */
  lastAssistantPreview?: string;
  todos?: TodoItem[];
  taskTodos?: TodoItem[];
}

/**
 * Estimate a loaded transcript window from durable aggregate metadata without
 * traversing or serializing message bodies on an application event loop.
 */
export function estimateTranscriptWindowBytes(
  descriptor: Pick<
    TranscriptDescriptor,
    'committedByteLength' | 'committedMessageCount'
  >,
  loadedRows: number,
): number {
  if (
    !Number.isSafeInteger(descriptor.committedByteLength) ||
    descriptor.committedByteLength <= 0 ||
    !Number.isSafeInteger(descriptor.committedMessageCount) ||
    descriptor.committedMessageCount <= 0 ||
    !Number.isSafeInteger(loadedRows) ||
    loadedRows <= 0
  ) {
    return 0;
  }
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.round(
      (descriptor.committedByteLength / descriptor.committedMessageCount) *
        loadedRows,
    ),
  );
}

export function isHumanAuthoredUserMessage(
  message: Pick<
    PersistedChatMessage,
    'role' | 'watcherFired' | 'userMessageSource'
  >,
): boolean {
  return (
    message.role === 'user' &&
    message.watcherFired === undefined &&
    (message.userMessageSource === undefined ||
      message.userMessageSource === 'human')
  );
}

export interface TranscriptPage {
  messages: PersistedChatMessage[];
  /** Present only when a delegation run is known to have truncated output. */
  runTruncated?: true;
  view?: 'turns';
  turnId?: string;
  messageOrdinals?: Record<string, number>;
  turns?: TranscriptTurnSummary[];
  /** Ordinal exclusive upper bound for the next older page. */
  before?: number;
  totalMessages: number;
  transcriptRevision: number;
  /** A child stream's opaque cursor for the next older page. */
  cursor?: string;
  /** Render as a sticky supplement, never as an extra chronological row. */
  latestHumanMessage?: PersistedChatMessage;
  /**
   * How the page's turns ended, by prompt id, for a host whose tabs record
   * no turn ends (the web core names them only in its timer rows, CAN-6560).
   * The reader lays them over the tab's own.
   */
  turnEnds?: Record<
    string,
    { outcome: 'completed' | 'failed' | 'cancelled'; endedAt: number }
  >;
}

export interface TurnSummaryCounts {
  messages: number;
  thinking: number;
  bash: number;
  read: number;
  readLines: number;
  writeEdit: number;
  plan: number;
  fileEdit: number;
  fileAdd: number;
  fileDelete: number;
  search: number;
  grep: number;
  web: number;
  agent: number;
  workflow: number;
  tasks: number;
  taskStop: number;
  skills: number;
  monitor: number;
  claude: number;
  scheduleWakeup: number;
  askUser: number;
  scriptOutput: number;
  watcher: number;
  canopy: number;
  graph: number;
  appAdvisor: number;
  pipelineEditor: number;
  computerUse: number;
  mcp: number;
  other: number;
}

export interface TranscriptViewRequest {
  view?: 'turns';
  /** User message ID owning an interior gap; before is a raw ordinal. */
  turnId?: string;
}
export type { TurnFileRecord as TranscriptTurnFile } from '@canopy/protocol/turn-files';

export interface TranscriptTurnSummary {
  id: string;
  start: number;
  end: number;
  complete: boolean;
  summary: TurnSummaryCounts;
  /** Full-turn projection; absent only when a legacy producer has no metadata. */
  outcomes?: TurnOutcomeCounts;
  /** Root denial correlation for landing when its receipt is outside the page. */
  deniedToolUseIds?: string[];
  /** Display IDs selected before any interior rows were omitted. */
  finalMessageIds: string[];
  /** Local file outputs survive omission of interior tool history. */
  files?: TranscriptTurnFile[];
  /** Display-only frame for legacy turns without a persisted timer. */
  frameTimer?: PersistedChatMessage;
  /** Earliest loaded contiguous suffix; absent when the turn is complete in memory. */
  before?: number;
  /**
   * Tools-loaded continuations in this prompt's span, by their group id. Each
   * shows as its own turn, so it keeps its own projection for compaction.
   */
  continuations?: Record<string, TranscriptTurnContinuation>;
}

/** A tools-loaded continuation's projection within its prompt's turn. */
export type TranscriptTurnContinuation = Pick<
  TranscriptTurnSummary,
  'complete' | 'summary' | 'outcomes' | 'finalMessageIds' | 'files'
>;
