import { isArtifactDispatchTool } from '@canopy/desktop-shared/lib/agent-artifact-projection';
import {
  extractCanonicalAgentArtifacts,
  MAX_AGENT_ARTIFACT_OUTPUT_CHARS,
  serializeAgentArtifactReceipts,
} from '@canopy/protocol/agent-artifacts';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import {
  copyFile,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import { REMOTE_CONTROL_CHAT_PART_TEXT_MAX_CHARS } from '@canopy/agent-transcript/remote-control/persisted-chat-projection';
import {
  clampVisualHeight,
  findVisualTokens,
  isVisualId,
  VISUAL_PREPARED_MAX_BYTES,
  VISUAL_TITLE_MAX_LENGTH,
  type PersistedArtifactReference,
} from '@canopy/agent-transcript/lib/visual-ref';
import {
  TOOL_OUTPUT_INLINE_BYTES,
  TOOL_OUTPUT_PREVIEW_HEAD_BYTES,
  encodeTranscriptBlockManifest,
  encodeTranscriptBlockPage,
  isTranscriptBlockManifest,
  isTranscriptBlockPage,
  isTranscriptBlocksReference,
  isPersistedToolOutputReference,
  transcriptBodyReferences,
  type TranscriptBlockManifest,
  type TranscriptBlockManifestEntry,
  type TranscriptBlockPage,
  type TranscriptBodyField,
  type TranscriptBodyReference,
} from '@canopy/agent-transcript/transcript-storage';
import {
  recordChatStorageArtifactPublished,
  recordChatStorageAtomicReplacement,
  recordChatStorageFileSync,
  recordChatStorageFileWrite,
} from '@canopy/desktop-shared/node/work-counters';
import { MAX_TRANSCRIPT_ROW_BYTES } from './chat-transcript-prefix-replace';
import {
  FieldSpool,
  SPOOL_YIELD_BYTES,
  Utf8FieldEncoder,
  yieldToEventLoop,
} from './chat-transcript-field-spool';
import {
  storedArtifactLocations,
  storedArtifactRefsOf,
  type StoredArtifactFamily,
} from './chat-artifact-references';
import { fsyncDirectory } from './fsync-directory';
import { isErrnoException } from './type-guards';
import { isPersistedChatBlock } from './persisted-chat-message-validation';

/**
 * Stage the text of a UTF-8 file, then a held high surrogate, as the exact
 * code units of a new spool, and remove the file. The file holds the clean
 * prefix of a body, so decoding it is lossless.
 */
async function spoolUtf8Prefix(
  directory: string,
  encodedPath: string,
  held: string,
  signal: AbortSignal | undefined,
): Promise<FieldSpool> {
  const spool = await FieldSpool.create(directory);
  try {
    const reader = await open(encodedPath, 'r');
    try {
      const decoder = new StringDecoder('utf8');
      const raw = Buffer.allocUnsafe(256 * 1024);
      for (let position = 0; ; ) {
        signal?.throwIfAborted();
        const { bytesRead } = await reader.read(raw, 0, raw.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const text = decoder.write(raw.subarray(0, bytesRead));
        if (text.length > 0) await spool.append(text, signal);
      }
      const rest = decoder.end();
      if (rest.length > 0) await spool.append(rest, signal);
    } finally {
      await reader.close();
    }
    await rm(encodedPath, { force: true });
    if (held.length > 0) await spool.append(held, signal);
    return spool;
  } catch (error) {
    await spool.discard();
    throw error;
  }
}

/**
 * How {@link ChatTranscriptArtifacts.externalize} treats body fields; callers
 * pass it per call from the manifest their scope transaction captured.
 * - `legacy` (default): format 2/3, offloads only tool output, byte-identical
 *   to before.
 * - `format4`: also offloads text, thinking, tool input and delegated answers
 *   of a final row; an open row keeps those fields inline and whole. With
 *   `dryRun`, references are derived from content and nothing is published:
 *   the form a format 4 write would store.
 * - `format4-verify`: replay, checkpoint materialization and readers. Never
 *   publishes and verifies every reference. An over-threshold field without
 *   one is an integrity error: any field of a final row, and tool output of
 *   an open row (whose generalized fields stay inline and whole). With
 *   `committed`, the row is one the log already holds: a format 3 writer may
 *   have committed a generalized field inline and whole before promotion,
 *   and it is kept.
 */
export type TranscriptFieldPolicy =
  | { kind: 'legacy' }
  | { kind: 'format4'; final: boolean; dryRun?: boolean }
  | { kind: 'format4-verify'; final: boolean; committed?: boolean };

/**
 * Whether a normalized tool result needs a Portal logical read for full output.
 * The length check uses the result before artifact preparation shortens it.
 */
export function toolResultNeedsRead(
  block: Extract<PersistedChatBlock, { type: 'tool_result' }>,
): boolean {
  return (
    block.fullOutputRef !== undefined ||
    block.output.length > REMOTE_CONTROL_CHAT_PART_TEXT_MAX_CHARS
  );
}

import {
  SHOW_VISUAL_TOOL_KEY,
  type ExternalizeVisualContext,
  type PromotedVisual,
  type StagedVisual,
} from './chat-visual-contracts';

interface VisualContentReference {
  artifactId: string;
  byteLength: number;
  sha256: string;
}

/** Visual promotion state for one externalized message. */
interface ToolResultVisuals {
  messageId: string;
  /** Present only for real writes; verification and dry runs never promote. */
  context: ExternalizeVisualContext | undefined;
  promoted: PromotedVisual[];
}

type ToolResultBlock = Extract<PersistedChatBlock, { type: 'tool_result' }>;

/** Canonical agent artifact receipts for a tool result, as develop stores them. */
function withCanonicalAgentArtifacts(block: ToolResultBlock): ToolResultBlock {
  const canonical = block.isError
    ? []
    : block.fullOutputRef
      ? serializeAgentArtifactReceipts(block.agentArtifacts)
      : extractCanonicalAgentArtifacts(block.output);
  const next = { ...block };
  delete next.agentArtifacts;
  if (canonical.length) next.agentArtifacts = canonical;
  return next;
}

export function assertTranscriptIdentity(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id)) {
    throw new Error('Invalid transcript identity');
  }
}

function utf8Prefix(value: string, bytes: number): string {
  let end = 0;
  let used = 0;
  while (end < value.length) {
    const point = value.codePointAt(end);
    if (point === undefined) break;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (used + size > bytes) break;
    used += size;
    end += point > 0xffff ? 2 : 1;
  }
  return value.slice(0, end);
}

const PREVIEW_MARKER = '\n[Full output stored separately]\n';

function utf8Suffix(value: string, bytes: number): string {
  let start = value.length;
  let used = 0;
  while (start > 0) {
    const last = value.charCodeAt(start - 1);
    const prior = start >= 2 ? value.charCodeAt(start - 2) : 0;
    const paired =
      last >= 0xdc00 && last <= 0xdfff && prior >= 0xd800 && prior <= 0xdbff;
    const size = paired ? 4 : last < 0x80 ? 1 : last < 0x800 ? 2 : 3;
    if (used + size > bytes) break;
    used += size;
    start -= paired ? 2 : 1;
  }
  return value.slice(start);
}

function preview(output: string): string {
  const head = utf8Prefix(output, TOOL_OUTPUT_PREVIEW_HEAD_BYTES);
  const tailBudget =
    TOOL_OUTPUT_INLINE_BYTES - Buffer.byteLength(head + PREVIEW_MARKER);
  return head + PREVIEW_MARKER + utf8Suffix(output, tailBudget);
}

/** UTF-8 bytes of each edge kept by the first preview reduction tier. */
const REDUCED_PREVIEW_EDGE_BYTES = 1024;

/** First reduction tier: a short head and tail of a reference-backed preview. */
function reducedPreview(value: string): string {
  if (
    Buffer.byteLength(value, 'utf8') <=
    2 * REDUCED_PREVIEW_EDGE_BYTES + Buffer.byteLength(PREVIEW_MARKER)
  )
    return value;
  return (
    utf8Prefix(value, REDUCED_PREVIEW_EDGE_BYTES) +
    PREVIEW_MARKER +
    utf8Suffix(value, REDUCED_PREVIEW_EDGE_BYTES)
  );
}

/** Bytes a string value occupies in the row's serialized JSON. */
function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Measure a transcript row without stringifying its complete block list.
 * Metadata is serialized with an empty list (preserving property order), then
 * each block and its comma separator is measured independently.
 */
export function transcriptRowByteLength(message: PersistedChatMessage): number {
  const metadata = JSON.stringify({ ...message, blocks: [] });
  if (metadata === undefined)
    throw new Error('Transcript row could not be serialized');
  let byteLength = Buffer.byteLength(metadata, 'utf8');
  message.blocks.forEach((block, index) => {
    const serialized = JSON.stringify(block);
    byteLength += Buffer.byteLength(serialized ?? 'null', 'utf8');
    if (index > 0) byteLength += 1;
  });
  return byteLength;
}

async function transcriptRowByteLengthCooperatively(
  message: PersistedChatMessage,
): Promise<number> {
  const metadata = JSON.stringify({ ...message, blocks: [] });
  if (metadata === undefined)
    throw new Error('Transcript row could not be serialized');
  let byteLength = Buffer.byteLength(metadata, 'utf8');
  for (let index = 0; index < message.blocks.length; index += 1) {
    const block: unknown = message.blocks[index];
    const serialized = JSON.stringify(block);
    byteLength += Buffer.byteLength(serialized ?? 'null', 'utf8');
    if (index > 0) byteLength += 1;
    if ((index + 1) % 128 === 0) await yieldToEventLoop();
  }
  return byteLength;
}

async function measureTranscriptRowByteLength(
  message: PersistedChatMessage,
): Promise<number> {
  return message.blocks.length <= 128
    ? transcriptRowByteLength(message)
    : transcriptRowByteLengthCooperatively(message);
}

async function collectBodyReferencesCooperatively(
  message: PersistedChatMessage,
): Promise<TranscriptBodyReference[]> {
  const references: TranscriptBodyReference[] = [];
  const add = (
    blockOrdinal: number,
    field: TranscriptBodyReference['field'],
    reference: PersistedToolOutputReference | undefined,
  ): void => {
    if (reference) references.push({ blockOrdinal, field, reference });
  };
  for (
    let blockOrdinal = 0;
    blockOrdinal < message.blocks.length;
    blockOrdinal += 1
  ) {
    const block = message.blocks[blockOrdinal];
    if (block === undefined) continue;
    if (block.type === 'tool_result')
      add(blockOrdinal, 'output', block.fullOutputRef);
    else if (block.type === 'text' || block.type === 'thinking')
      add(blockOrdinal, 'text', block.textRef);
    else if (block.type === 'tool_use')
      add(blockOrdinal, 'input', block.inputRef);
    else if (block.type === 'delegated_agent_call') {
      add(blockOrdinal, 'partialText', block.partialTextRef);
      add(blockOrdinal, 'finalText', block.finalTextRef);
    }
    if ((blockOrdinal + 1) % 128 === 0) await yieldToEventLoop();
  }
  return references;
}

function bodyFieldValue(
  block: PersistedChatBlock,
  field: TranscriptBodyField,
): string | undefined {
  switch (field) {
    case 'output':
      return block.type === 'tool_result' ? block.output : undefined;
    case 'text':
      return block.type === 'text' || block.type === 'thinking'
        ? block.text
        : undefined;
    case 'input':
      return block.type === 'tool_use' ? block.input : undefined;
    case 'partialText':
      return block.type === 'delegated_agent_call'
        ? block.partialText
        : undefined;
    case 'finalText':
      return block.type === 'delegated_agent_call'
        ? block.finalText
        : undefined;
  }
}

/** Replace one body field's string in place, keeping property order. */
function withBodyField(
  block: PersistedChatBlock,
  field: TranscriptBodyField,
  value: string,
): PersistedChatBlock {
  if (field === 'output' && block.type === 'tool_result')
    return { ...block, output: value };
  if (field === 'text' && (block.type === 'text' || block.type === 'thinking'))
    return { ...block, text: value };
  if (field === 'input' && block.type === 'tool_use')
    return { ...block, input: value };
  if (field === 'partialText' && block.type === 'delegated_agent_call')
    return { ...block, partialText: value };
  if (field === 'finalText' && block.type === 'delegated_agent_call')
    return { ...block, finalText: value };
  return block;
}

/**
 * Shrink reference-backed previews, in block and field order, until the
 * serialized row fits the row guard: first to a short head and tail, then to
 * the empty string. Every key and reference stays; a string without a
 * reference is never shortened. A row still too large is returned as is for
 * the row guard to reject.
 */
interface BackedPreviewReduction {
  firstTier: PersistedChatMessage;
  fullyReduced: PersistedChatMessage;
}

async function reduceBackedPreviewsByTier(
  message: PersistedChatMessage,
  tier: (value: string) => string,
): Promise<PersistedChatMessage> {
  const backed = await collectBodyReferencesCooperatively(message);
  if (backed.length === 0) return message;
  let rowBytes = await measureTranscriptRowByteLength(message);
  if (rowBytes <= MAX_TRANSCRIPT_ROW_BYTES) return message;
  const blocks = message.blocks.slice();
  for (let index = 0; index < backed.length; index += 1) {
    const reference = backed[index];
    if (reference === undefined) continue;
    const { blockOrdinal, field } = reference;
    if (rowBytes <= MAX_TRANSCRIPT_ROW_BYTES) break;
    const block = blocks[blockOrdinal];
    if (block === undefined) continue;
    const value = bodyFieldValue(block, field);
    if (value === undefined) continue;
    const next = tier(value);
    const saved = jsonStringBytes(value) - jsonStringBytes(next);
    if (saved <= 0) continue;
    rowBytes -= saved;
    blocks[blockOrdinal] = withBodyField(block, field, next);
    if ((index + 1) % 128 === 0) await yieldToEventLoop();
  }
  return { ...message, blocks };
}

async function reduceBackedPreviewsWithFallback(
  message: PersistedChatMessage,
): Promise<BackedPreviewReduction> {
  const firstTier = await reduceBackedPreviewsByTier(message, reducedPreview);
  if (
    (await measureTranscriptRowByteLength(firstTier)) <=
    MAX_TRANSCRIPT_ROW_BYTES
  )
    return { firstTier, fullyReduced: firstTier };
  return {
    firstTier,
    fullyReduced: await reduceBackedPreviewsByTier(firstTier, (): string => ''),
  };
}

async function reduceAllBackedPreviewsToFirstTier(
  message: PersistedChatMessage,
): Promise<PersistedChatMessage> {
  const backed = await collectBodyReferencesCooperatively(message);
  if (backed.length === 0) return message;
  const blocks = message.blocks.slice();
  for (let index = 0; index < backed.length; index += 1) {
    const reference = backed[index];
    if (reference === undefined) continue;
    const { blockOrdinal, field } = reference;
    const block = blocks[blockOrdinal];
    if (block !== undefined) {
      const value = bodyFieldValue(block, field);
      if (value !== undefined)
        blocks[blockOrdinal] = withBodyField(
          block,
          field,
          reducedPreview(value),
        );
    }
    if ((index + 1) % 128 === 0) await yieldToEventLoop();
  }
  return { ...message, blocks };
}

function* encodedOutputChunks(
  output: string,
  encoding: 'utf-8' | 'utf-16le',
  buffer: Buffer,
): Generator<Buffer> {
  const nodeEncoding = encoding === 'utf-8' ? 'utf8' : 'utf16le';
  for (let start = 0; start < output.length; ) {
    let end = Math.min(output.length, start + 16_384);
    if (end < output.length && /[\uD800-\uDBFF]/.test(output.charAt(end - 1)))
      end -= 1;
    const written = buffer.write(
      output.slice(start, end),
      0,
      buffer.length,
      nodeEncoding,
    );
    // The caller must consume each view before advancing: the next chunk
    // overwrites this same backing buffer.
    yield buffer.subarray(0, written);
    start = end;
  }
}

/** The reference `put` publishes `output` under, computed without writing. */
async function contentReference(output: string): Promise<{
  ref: PersistedToolOutputReference;
  encoding: 'utf-8' | 'utf-16le';
  encodingBuffer: Buffer;
}> {
  // JSON permits unpaired UTF-16 code units. Never silently turn them into
  // U+FFFD while extracting an otherwise lossless transcript string.
  const encoding =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      output,
    )
      ? 'utf-16le'
      : 'utf-8';
  const encodingBuffer = Buffer.allocUnsafe(
    Math.min(output.length, 16_384) * (encoding === 'utf-8' ? 3 : 2),
  );
  const hash = createHash('sha256');
  let byteLength = 0;
  let bytesSinceYield = 0;
  const hashChunks = encodedOutputChunks(output, encoding, encodingBuffer);
  for (let next = hashChunks.next(); !next.done; next = hashChunks.next()) {
    const bytes = next.value;
    if (bytesSinceYield + bytes.length > 1024 * 1024) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      bytesSinceYield = 0;
    }
    hash.update(bytes);
    byteLength += bytes.length;
    bytesSinceYield += bytes.length;
  }
  const sha256 = hash.digest('hex');
  return {
    ref: {
      version: 1,
      artifactId: `sha256-v1-${sha256}`,
      byteLength,
      sha256,
      encoding,
      mediaType: 'text/plain',
    },
    encoding,
    encodingBuffer,
  };
}

function isArtifactIntegrityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'Tool output artifact failed integrity validation' ||
      error.message === 'Visual artifact failed integrity validation')
  );
}

function isWellFormedUtf16(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    value,
  );
}

function sameOwner(
  left: { messageId: string; toolUseId: string },
  right: { messageId: string; toolUseId: string },
): boolean {
  return (
    left.messageId === right.messageId && left.toolUseId === right.toolUseId
  );
}

function stagedVisualMatches(
  staged: StagedVisual,
  chatId: string,
  visualId: string,
): boolean {
  const { sidecar, html } = staged;
  if (
    !isVisualId(visualId) ||
    sidecar.version !== 1 ||
    sidecar.visualId !== visualId ||
    sidecar.chatId !== chatId ||
    sidecar.toolKey !== SHOW_VISUAL_TOOL_KEY ||
    !/^[a-f0-9]{64}$/.test(sidecar.sha256) ||
    !Number.isSafeInteger(sidecar.byteLength) ||
    sidecar.byteLength < 0 ||
    sidecar.byteLength > VISUAL_PREPARED_MAX_BYTES ||
    !isWellFormedUtf16(html)
  ) {
    return false;
  }
  const title = sidecar.title.trim();
  if (
    title.length === 0 ||
    title.length > VISUAL_TITLE_MAX_LENGTH ||
    title !== sidecar.title ||
    !Number.isFinite(sidecar.maxHeight) ||
    sidecar.maxHeight !== clampVisualHeight(sidecar.maxHeight)
  ) {
    return false;
  }
  const bytes = Buffer.from(html, 'utf8');
  return (
    bytes.length === sidecar.byteLength &&
    createHash('sha256').update(bytes).digest('hex') === sidecar.sha256
  );
}

/**
 * Artifact files one operation created rather than found in place. Because
 * artifacts are content addressed and every earlier transaction published
 * its own artifacts before its journal record, a file this operation created
 * is referenced by no committed row, active sidecar, or pending payload until
 * the operation's own record publishes. Discarding is therefore exact and
 * needs no reachability scan.
 */
export class CreatedArtifacts {
  private readonly paths = new Set<string>();

  public add(path: string): void {
    this.paths.add(path);
  }

  public get size(): number {
    return this.paths.size;
  }

  /** Remove every tracked file and sync each affected directory. */
  public async discard(): Promise<void> {
    const directories = new Set<string>();
    for (const path of Array.from(this.paths)) {
      await rm(path, { force: true });
      directories.add(dirname(path));
    }
    this.paths.clear();
    for (const directory of Array.from(directories))
      await fsyncDirectory(directory);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

interface PreparedBodyField {
  value: string;
  ref: PersistedToolOutputReference;
}

export interface ChatTranscriptArtifactOptions {
  pageTargetBytes?: number;
  manifestTargetBytes?: number;
  rowTargetBytes?: number;
}

interface PlannedBlockArtifact {
  kind: 'page' | 'manifest';
  content: string;
  reference: PersistedToolOutputReference;
}

interface BlockManifestNode {
  kind: 'page' | 'manifest';
  firstBlockOrdinal: number;
  blockCount: number;
  reference: PersistedToolOutputReference;
}

const DEFAULT_BLOCK_ARTIFACT_TARGET_BYTES = 1024 * 1024;

function serializedValueByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error('Transcript block artifact could not be serialized');
  return Buffer.byteLength(serialized, 'utf8');
}

function sameTranscriptRowWithoutWholeRowStringify(
  left: PersistedChatMessage,
  right: PersistedChatMessage,
): boolean {
  if (left.blocks.length !== right.blocks.length) return false;
  const leftMetadata = JSON.stringify({ ...left, blocks: [] });
  const rightMetadata = JSON.stringify({ ...right, blocks: [] });
  if (leftMetadata !== rightMetadata) return false;
  for (let index = 0; index < left.blocks.length; index += 1) {
    const leftBlock = JSON.stringify(left.blocks[index]);
    const rightBlock = JSON.stringify(right.blocks[index]);
    if ((leftBlock ?? 'null') !== (rightBlock ?? 'null')) return false;
  }
  return true;
}

function transcriptBlockArtifactError(): Error {
  return new Error('Invalid transcript block artifact');
}

/** File paths are derived exclusively from validated identities. */
export class ChatTranscriptArtifacts {
  private readonly verified = new Map<string, string>();
  private readonly pageTargetBytes: number;
  private readonly manifestTargetBytes: number;
  private readonly rowTargetBytes: number;

  public constructor(
    private readonly transcriptsRoot: string,
    private readonly readOnly = false,
    options: ChatTranscriptArtifactOptions = {},
  ) {
    this.pageTargetBytes =
      options.pageTargetBytes ?? DEFAULT_BLOCK_ARTIFACT_TARGET_BYTES;
    this.manifestTargetBytes =
      options.manifestTargetBytes ?? DEFAULT_BLOCK_ARTIFACT_TARGET_BYTES;
    this.rowTargetBytes = options.rowTargetBytes ?? MAX_TRANSCRIPT_ROW_BYTES;
    for (const target of [
      this.pageTargetBytes,
      this.manifestTargetBytes,
      this.rowTargetBytes,
    ]) {
      if (!Number.isSafeInteger(target) || target < 1)
        throw new Error(
          'Transcript artifact targets must be positive integers',
        );
    }
  }

  private directory(
    chatId: string,
    family: StoredArtifactFamily = 'tool-output',
  ): string {
    assertTranscriptIdentity(chatId);
    const location = Array.from(storedArtifactLocations()).find(
      (item) => item.family === family,
    );
    if (!location) throw new Error('Unknown transcript artifact family');
    return join(this.transcriptsRoot, location.directory, chatId);
  }

  /** The caller owns and closes this bounded maintenance iterator. */
  public async openCandidateDirectory(
    chatId: string,
    family: StoredArtifactFamily = 'tool-output',
  ): Promise<Dir | undefined> {
    try {
      return await opendir(this.directory(chatId, family));
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Only a complete canonical reachability pass may authorize these names. */
  public async reclaimCandidates(
    chatId: string,
    artifactIds: readonly string[],
    family: StoredArtifactFamily = 'tool-output',
  ): Promise<void> {
    if (this.readOnly) throw new Error('Transcript store is read-only');
    const directory = this.directory(chatId, family);
    const extension = family === 'visual' ? '.html' : '.txt';
    for (const artifactId of artifactIds) {
      if (!/^sha256-v1-[a-f0-9]{64}$/.test(artifactId))
        throw new Error(
          family === 'visual'
            ? 'Invalid visual artifact identity'
            : 'Invalid tool output artifact identity',
        );
      await rm(join(directory, `${artifactId}${extension}`), { force: true });
      this.verified.delete(
        `${family === 'visual' ? 'visual:' : ''}${artifactId.slice('sha256-v1-'.length)}`,
      );
    }
    if (artifactIds.length) await fsyncDirectory(directory);
  }

  private path(chatId: string, ref: PersistedToolOutputReference): string {
    if (
      ref.version !== 1 ||
      !['utf-8', 'utf-16le'].includes(ref.encoding) ||
      ref.mediaType !== 'text/plain' ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      ref.artifactId !== `sha256-v1-${ref.sha256}` ||
      !Number.isSafeInteger(ref.byteLength) ||
      ref.byteLength < 0
    )
      throw new Error('Invalid tool output reference');
    return join(this.directory(chatId), `${ref.artifactId}.txt`);
  }

  private visualContentPath(
    chatId: string,
    ref: VisualContentReference,
  ): string {
    assertTranscriptIdentity(chatId);
    if (
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      ref.artifactId !== `sha256-v1-${ref.sha256}` ||
      !Number.isSafeInteger(ref.byteLength) ||
      ref.byteLength < 0 ||
      ref.byteLength > VISUAL_PREPARED_MAX_BYTES
    ) {
      throw new Error('Invalid visual reference');
    }
    return join(this.directory(chatId, 'visual'), `${ref.artifactId}.html`);
  }

  private visualPath(chatId: string, ref: PersistedVisualReference): string {
    if (
      ref.version !== 1 ||
      ref.mediaType !== 'text/html' ||
      !isVisualId(ref.visualId)
    ) {
      throw new Error('Invalid visual reference');
    }
    return this.visualContentPath(chatId, ref);
  }

  /** Sync an existing, verified file and its directory before reusing it. */
  private async syncIfVerified(
    chatId: string,
    ref: PersistedToolOutputReference,
  ): Promise<boolean> {
    let handle: FileHandle;
    try {
      // Windows requires write access to sync a file handle.
      handle = await open(this.path(chatId, ref), 'r+');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return false;
      throw error;
    }
    try {
      try {
        await this.verifyHandle(handle, ref);
      } catch (error) {
        if (isArtifactIntegrityError(error)) return false;
        throw error;
      }
      await handle.sync();
      recordChatStorageFileSync(this.path(chatId, ref));
    } finally {
      await handle.close();
    }
    await fsyncDirectory(this.directory(chatId));
    return true;
  }

  /** Content-addressed publication with durable reuse of verified bytes. */
  public async put(
    chatId: string,
    output: string,
    created?: CreatedArtifacts,
  ): Promise<PersistedToolOutputReference> {
    if (this.readOnly) throw new Error('Tool output store is read-only');
    const directory = this.directory(chatId);
    const { ref, encoding, encodingBuffer } = await contentReference(output);
    await mkdir(directory, { recursive: true });
    await fsyncDirectory(join(this.transcriptsRoot, 'tool-output'));
    await fsyncDirectory(this.transcriptsRoot);
    if (await this.syncIfVerified(chatId, ref)) return ref;

    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      const writeChunks = encodedOutputChunks(output, encoding, encodingBuffer);
      for (let next = writeChunks.next(); !next.done; next = writeChunks.next())
        await handle.writeFile(next.value);
      await handle.sync();
      recordChatStorageFileWrite(temporary, ref.byteLength, false);
      recordChatStorageFileSync(temporary);
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    await this.publishTemporary(chatId, temporary, ref, created);
    return ref;
  }

  /** Atomically move a synced temporary file into its artifact path. */
  private async publishTemporary(
    chatId: string,
    temporary: string,
    ref: PersistedToolOutputReference,
    created?: CreatedArtifacts,
  ): Promise<void> {
    const path = this.path(chatId, ref);
    const existed = await exists(path);
    await rename(temporary, path);
    recordChatStorageAtomicReplacement(path);
    recordChatStorageArtifactPublished();
    await fsyncDirectory(this.directory(chatId));
    if (!existed) created?.add(path);
  }

  /** Sync an existing, verified visual before reusing its content address. */
  private async syncVisualIfVerified(
    chatId: string,
    ref: VisualContentReference,
  ): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await open(this.visualContentPath(chatId, ref), 'r+');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return false;
      throw error;
    }
    try {
      try {
        await this.verifyVisualHandle(handle, ref);
      } catch (error) {
        if (isArtifactIntegrityError(error)) return false;
        throw error;
      }
      await handle.sync();
      recordChatStorageFileSync(this.visualContentPath(chatId, ref));
    } finally {
      await handle.close();
    }
    await fsyncDirectory(this.directory(chatId, 'visual'));
    return true;
  }

  /** Publishes well-formed UTF-8 HTML under its byte-only content address. */
  public async putVisual(
    chatId: string,
    html: string,
    created?: CreatedArtifacts,
  ): Promise<VisualContentReference> {
    if (this.readOnly) throw new Error('Visual store is read-only');
    if (!isWellFormedUtf16(html))
      throw new Error('Visual HTML must be well-formed UTF-8');
    const bytes = Buffer.from(html, 'utf8');
    if (bytes.length > VISUAL_PREPARED_MAX_BYTES)
      throw new Error('Visual HTML exceeds the prepared byte limit');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ref: VisualContentReference = {
      artifactId: `sha256-v1-${sha256}`,
      byteLength: bytes.length,
      sha256,
    };
    const directory = this.directory(chatId, 'visual');
    const path = this.visualContentPath(chatId, ref);
    await mkdir(directory, { recursive: true });
    await fsyncDirectory(join(this.transcriptsRoot, 'visuals'));
    await fsyncDirectory(this.transcriptsRoot);
    if (await this.syncVisualIfVerified(chatId, ref)) return ref;

    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      recordChatStorageFileWrite(temporary, ref.byteLength, false);
      recordChatStorageFileSync(temporary);
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    const existed = await exists(path);
    await rename(temporary, path);
    recordChatStorageAtomicReplacement(path);
    recordChatStorageArtifactPublished();
    await fsyncDirectory(directory);
    if (!existed) created?.add(path);
    return ref;
  }

  public async verify(
    chatId: string,
    ref: PersistedToolOutputReference,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const handle = await open(this.path(chatId, ref), 'r');
    try {
      await this.verifyHandle(handle, ref, signal);
    } finally {
      await handle.close();
    }
  }

  public async verifyVisual(
    chatId: string,
    ref: PersistedVisualReference,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const handle = await open(this.visualPath(chatId, ref), 'r');
    try {
      await this.verifyVisualHandle(handle, ref, signal);
    } finally {
      await handle.close();
    }
  }

  /** Verify any stored artifact against its reference. */
  public async verifyArtifact(
    chatId: string,
    ref: PersistedArtifactReference,
    signal?: AbortSignal,
  ): Promise<void> {
    switch (ref.family) {
      case 'tool-output':
        return this.verify(chatId, ref.reference, signal);
      case 'visual':
        return this.verifyVisual(chatId, ref.reference, signal);
    }
  }

  /** Copy any stored artifact to another chat, as `copyToChat` does. */
  public async copyArtifactToChat(
    sourceChatId: string,
    targetChatId: string,
    ref: PersistedArtifactReference,
    destination: ChatTranscriptArtifacts = this,
    created?: CreatedArtifacts,
  ): Promise<void> {
    switch (ref.family) {
      case 'tool-output':
        return this.copyToChat(
          sourceChatId,
          targetChatId,
          ref.reference,
          destination,
          created,
        );
      case 'visual':
        return this.copyVisualToChat(
          sourceChatId,
          targetChatId,
          ref.reference,
          destination,
          created,
        );
    }
  }

  /** Copy while the caller holds the source scope lease. The destination is
   * independent of future source deletion; reference bytes remain identical.
   */
  public async copyToChat(
    sourceChatId: string,
    targetChatId: string,
    ref: PersistedToolOutputReference,
    destination: ChatTranscriptArtifacts = this,
    created?: CreatedArtifacts,
  ): Promise<void> {
    if (destination.readOnly) throw new Error('Tool output store is read-only');
    await this.verify(sourceChatId, ref);
    if (
      this.transcriptsRoot === destination.transcriptsRoot &&
      sourceChatId === targetChatId
    )
      return;
    const directory = destination.directory(targetChatId);
    await mkdir(directory, { recursive: true });
    // Persist newly created directory entries before publishing their artifacts.
    await fsyncDirectory(join(destination.transcriptsRoot, 'tool-output'));
    await fsyncDirectory(destination.transcriptsRoot);
    if (await destination.syncIfVerified(targetChatId, ref)) return;
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      await copyFile(this.path(sourceChatId, ref), temporary);
      // Verification reads the copy; Windows fsync also requires write access.
      const handle = await open(temporary, 'r+');
      try {
        await this.verifyHandle(handle, ref);
        await handle.sync();
        recordChatStorageFileWrite(temporary, ref.byteLength, false);
        recordChatStorageFileSync(temporary);
      } finally {
        await handle.close();
      }
      const path = destination.path(targetChatId, ref);
      const existed = await exists(path);
      await rename(temporary, path);
      renamed = true;
      recordChatStorageAtomicReplacement(path);
      recordChatStorageArtifactPublished();
      await fsyncDirectory(directory);
      if (!existed) created?.add(path);
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }

  private async copyVisualToChat(
    sourceChatId: string,
    targetChatId: string,
    ref: PersistedVisualReference,
    destination: ChatTranscriptArtifacts,
    created?: CreatedArtifacts,
  ): Promise<void> {
    if (destination.readOnly) throw new Error('Visual store is read-only');
    await this.verifyVisual(sourceChatId, ref);
    if (
      this.transcriptsRoot === destination.transcriptsRoot &&
      sourceChatId === targetChatId
    )
      return;
    const directory = destination.directory(targetChatId, 'visual');
    await mkdir(directory, { recursive: true });
    await fsyncDirectory(join(destination.transcriptsRoot, 'visuals'));
    await fsyncDirectory(destination.transcriptsRoot);
    if (await destination.syncVisualIfVerified(targetChatId, ref)) return;
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      await copyFile(this.visualPath(sourceChatId, ref), temporary);
      const handle = await open(temporary, 'r+');
      try {
        await destination.verifyVisualHandle(handle, ref);
        await handle.sync();
        recordChatStorageFileWrite(temporary, ref.byteLength, false);
        recordChatStorageFileSync(temporary);
      } finally {
        await handle.close();
      }
      const path = destination.visualPath(targetChatId, ref);
      const existed = await exists(path);
      await rename(temporary, path);
      renamed = true;
      recordChatStorageAtomicReplacement(path);
      recordChatStorageArtifactPublished();
      await fsyncDirectory(directory);
      if (!existed) created?.add(path);
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }

  private async verifyHandle(
    handle: FileHandle,
    ref: PersistedToolOutputReference,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const info = await handle.stat();
    if (info.size !== ref.byteLength)
      throw new Error('Tool output artifact failed integrity validation');
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (this.verified.get(ref.sha256) === signature) return;
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
      signal,
    })) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      byteLength += bytes.length;
    }
    if (byteLength !== ref.byteLength || hash.digest('hex') !== ref.sha256) {
      throw new Error('Tool output artifact failed integrity validation');
    }
    const after = await handle.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw new Error('Tool output artifact changed during validation');
    this.verified.set(ref.sha256, signature);
    if (this.verified.size > 128) {
      const oldest = this.verified.keys().next().value;
      if (oldest !== undefined) this.verified.delete(oldest);
    }
  }

  private async verifyVisualHandle(
    handle: FileHandle,
    ref: VisualContentReference,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const info = await handle.stat();
    if (info.size !== ref.byteLength)
      throw new Error('Visual artifact failed integrity validation');
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cacheKey = `visual:${ref.sha256}`;
    if (this.verified.get(cacheKey) === signature) return;
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
      signal,
    })) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      byteLength += bytes.length;
    }
    if (byteLength !== ref.byteLength || hash.digest('hex') !== ref.sha256)
      throw new Error('Visual artifact failed integrity validation');
    const after = await handle.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw new Error('Visual artifact changed during validation');
    this.verified.set(cacheKey, signature);
    if (this.verified.size > 128) {
      const oldest = this.verified.keys().next().value;
      if (oldest !== undefined) this.verified.delete(oldest);
    }
  }

  /** Read an exact raw-byte range after verifying the complete visual. */
  public async readVisualRange(
    chatId: string,
    ref: PersistedVisualReference,
    offset = 0,
    limit = 65_536,
    signal?: AbortSignal,
  ): Promise<{
    bytes: Buffer;
    offset: number;
    length: number;
    byteLength: number;
    sha256: string;
  }> {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > ref.byteLength ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_048_576
    ) {
      throw new Error('Invalid visual range');
    }
    const handle = await open(this.visualPath(chatId, ref), 'r');
    try {
      await this.verifyVisualHandle(handle, ref, signal);
      const length = Math.min(limit, ref.byteLength - offset);
      const bytes = Buffer.alloc(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        signal?.throwIfAborted();
        const read = await handle.read(
          bytes,
          bytesRead,
          length - bytesRead,
          offset + bytesRead,
        );
        if (read.bytesRead === 0)
          throw new Error('Unexpected end of visual artifact');
        bytesRead += read.bytesRead;
      }
      signal?.throwIfAborted();
      return {
        bytes,
        offset,
        length,
        byteLength: ref.byteLength,
        sha256: ref.sha256,
      };
    } finally {
      await handle.close();
    }
  }

  public async readRange(
    chatId: string,
    ref: PersistedToolOutputReference,
    offset = 0,
    limit = 65_536,
    signal?: AbortSignal,
  ): Promise<{ text: string; nextOffset?: number; byteLength: number }> {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > ref.byteLength ||
      !Number.isSafeInteger(limit) ||
      limit < 4 ||
      limit > 65_536
    ) {
      throw new Error('Invalid tool output range');
    }
    const handle = await open(this.path(chatId, ref), 'r');
    try {
      await this.verifyHandle(handle, ref, signal);
      const buffer = Buffer.alloc(Math.min(limit + 4, ref.byteLength - offset));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        signal?.throwIfAborted();
        const read = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          offset + bytesRead,
        );
        if (read.bytesRead === 0)
          throw new Error('Unexpected end of tool output artifact');
        bytesRead += read.bytesRead;
      }
      signal?.throwIfAborted();
      if (
        ref.encoding === 'utf-8' &&
        bytesRead > 0 &&
        (buffer[0] & 0xc0) === 0x80
      ) {
        throw new Error('Tool output offset splits a UTF-8 character');
      }
      let end = Math.min(limit, bytesRead);
      if (ref.encoding === 'utf-8') {
        while (end > 0 && end < bytesRead && (buffer[end] & 0xc0) === 0x80)
          end -= 1;
      } else {
        if (offset % 2 !== 0 || ref.byteLength % 2 !== 0)
          throw new Error('Tool output offset splits a UTF-16 code unit');
        // A start on the low half of a well-formed pair splits that character.
        if (offset >= 2 && bytesRead >= 2) {
          const unit = buffer.readUInt16LE(0);
          if (unit >= 0xdc00 && unit <= 0xdfff) {
            const before = Buffer.alloc(2);
            const read = await handle.read(before, 0, 2, offset - 2);
            if (read.bytesRead !== 2)
              throw new Error('Unexpected end of tool output artifact');
            const previous = before.readUInt16LE(0);
            if (previous >= 0xd800 && previous <= 0xdbff)
              throw new Error('Tool output offset splits a UTF-16 code unit');
          }
        }
        end -= end % 2;
        // Keep well-formed surrogate pairs together between range responses.
        if (
          end >= 2 &&
          end + 2 <= bytesRead &&
          buffer.readUInt16LE(end - 2) >= 0xd800 &&
          buffer.readUInt16LE(end - 2) <= 0xdbff &&
          buffer.readUInt16LE(end) >= 0xdc00 &&
          buffer.readUInt16LE(end) <= 0xdfff
        )
          end -= 2;
      }
      return {
        text: buffer
          .subarray(0, end)
          .toString(ref.encoding === 'utf-8' ? 'utf8' : 'utf16le'),
        byteLength: ref.byteLength,
        ...(offset + end < ref.byteLength ? { nextOffset: offset + end } : {}),
      };
    } finally {
      await handle.close();
    }
  }

  private async promoteVisual(
    chatId: string,
    messageId: string,
    toolUseId: string,
    output: string,
    created: CreatedArtifacts | undefined,
    visualContext: ExternalizeVisualContext | undefined,
  ): Promise<PromotedVisual | undefined> {
    if (!visualContext || visualContext.chatId !== chatId) return undefined;
    try {
      if (!visualContext.hasStagedEntries()) return undefined;
    } catch {
      return undefined;
    }

    for (const visualId of findVisualTokens(output)) {
      try {
        const owner = visualContext.ownerOf(visualId);
        if (owner && !sameOwner(owner, { messageId, toolUseId })) continue;
        const call = visualContext.linkedToolCall(toolUseId);
        if (
          !call ||
          call.toolUseId !== toolUseId ||
          visualContext.resolveToolKey(call) !== SHOW_VISUAL_TOOL_KEY
        ) {
          continue;
        }
        const staged = await visualContext.readStaged(visualId);
        if (!staged || !stagedVisualMatches(staged, chatId, visualId)) continue;
        if (
          staged.sidecar.codexCallId !== undefined &&
          call.codexCallId !== staged.sidecar.codexCallId
        ) {
          continue;
        }
        const ownerFence = {
          messageId,
          toolUseId,
          ...(call.codexCallId !== undefined
            ? { codexCallId: call.codexCallId }
            : {}),
          claimedAt: visualContext.now(),
        };
        if (!visualContext.reserve(visualId, ownerFence)) continue;

        const artifact = await this.putVisual(chatId, staged.html, created);
        const reference: PersistedVisualReference = {
          version: 1,
          visualId,
          artifactId: artifact.artifactId,
          byteLength: artifact.byteLength,
          sha256: artifact.sha256,
          mediaType: 'text/html',
          title: staged.sidecar.title,
          maxHeight: staged.sidecar.maxHeight,
          ...(staged.sidecar.heights !== undefined
            ? { heights: staged.sidecar.heights }
            : {}),
        };
        return { chatId, visualId, reference };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /** Bounded lazy upgrade for old rows whose canonical result is already externalized. */
  public async hydrateAgentArtifacts(
    chatId: string,
    message: PersistedChatMessage,
  ): Promise<PersistedChatMessage> {
    let changed = false;
    const blocks: PersistedChatMessage['blocks'] = [];
    for (const block of message.blocks) {
      if (
        block.type !== 'tool_result' ||
        block.isError ||
        !block.fullOutputRef ||
        block.agentArtifacts?.length ||
        !isArtifactDispatchTool(block.toolName) ||
        block.fullOutputRef.byteLength > MAX_AGENT_ARTIFACT_OUTPUT_CHARS
      ) {
        blocks.push(block);
        continue;
      }
      try {
        let output = '';
        let offset: number | undefined = 0;
        while (offset !== undefined) {
          const page = await this.readRange(
            chatId,
            block.fullOutputRef,
            offset,
            64 * 1024,
          );
          output += page.text;
          offset = page.nextOffset;
        }
        const receipts = extractCanonicalAgentArtifacts(output);
        if (receipts.length) {
          blocks.push({ ...block, agentArtifacts: receipts });
          changed = true;
        } else blocks.push(block);
      } catch {
        blocks.push(block);
      }
    }
    return changed ? { ...message, blocks } : message;
  }

  /**
   * Publish a body from chunks; the reference, bytes and digest equal
   * {@link put} of the joined chunks for every partition, including a
   * surrogate pair split between chunks and empty chunks. Exact UTF-16LE code
   * units are staged in a same-directory temporary file, then encoded once,
   * as UTF-8 unless the body holds an unpaired surrogate. On abort or any
   * failure the staged files are removed and nothing is published.
   */
  public async putStream(
    chatId: string,
    chunks: Iterable<string> | AsyncIterable<string>,
    created?: CreatedArtifacts,
    options: { signal?: AbortSignal } = {},
  ): Promise<PersistedToolOutputReference> {
    if (this.readOnly) throw new Error('Tool output store is read-only');
    const { signal } = options;
    signal?.throwIfAborted();
    const directory = this.directory(chatId);
    await mkdir(directory, { recursive: true });
    await fsyncDirectory(join(this.transcriptsRoot, 'tool-output'));
    await fsyncDirectory(this.transcriptsRoot);
    const encodedPath = join(directory, `.${randomUUID()}.tmp`);
    let encodedHandle: FileHandle | undefined;
    let spool: FieldSpool | undefined;
    try {
      let hash = createHash('sha256');
      let byteLength = 0;
      let bytesSinceYield = 0;
      const consume = async (bytes: Buffer): Promise<void> => {
        if (bytesSinceYield + bytes.length > SPOOL_YIELD_BYTES) {
          await yieldToEventLoop();
          signal?.throwIfAborted();
          bytesSinceYield = 0;
        }
        hash.update(bytes);
        byteLength += bytes.length;
        bytesSinceYield += bytes.length;
      };
      // A body without an unpaired surrogate is stored as UTF-8, so it is
      // encoded and hashed as it arrives. One that turns out to hold one is
      // stored as its exact UTF-16LE code units: the clean prefix written so
      // far decodes losslessly into a spool, which takes the rest.
      const encodedFile = await open(encodedPath, 'wx', 0o600);
      encodedHandle = encodedFile;
      const encoder = new Utf8FieldEncoder();
      for await (const chunk of chunks) {
        signal?.throwIfAborted();
        if (!spool && encoder.accept(chunk)) {
          await encoder.encode(chunk, async (bytes) => {
            await consume(bytes);
            await encodedFile.writeFile(bytes);
          });
          continue;
        }
        if (!spool) {
          await encodedFile.close();
          encodedHandle = undefined;
          spool = await spoolUtf8Prefix(
            directory,
            encodedPath,
            encoder.held,
            signal,
          );
        }
        await spool.append(chunk, signal);
      }
      if (!spool && !encoder.finish()) {
        await encodedFile.close();
        encodedHandle = undefined;
        spool = await spoolUtf8Prefix(
          directory,
          encodedPath,
          encoder.held,
          signal,
        );
      }
      let encoding: 'utf-8' | 'utf-16le' = 'utf-8';
      if (spool) {
        encoding = await spool.finish(signal);
        if (encoding !== 'utf-16le')
          throw new Error('Staged transcript field lost its surrogate');
        // The staged code units already are the artifact's exact bytes.
        hash = createHash('sha256');
        byteLength = 0;
        for await (const bytes of spool.rawChunks(signal)) await consume(bytes);
      }
      const sha256 = hash.digest('hex');
      const ref: PersistedToolOutputReference = {
        version: 1,
        artifactId: `sha256-v1-${sha256}`,
        byteLength,
        sha256,
        encoding,
        mediaType: 'text/plain',
      };
      signal?.throwIfAborted();
      if (await this.syncIfVerified(chatId, ref)) return ref;
      const temporary = spool ? spool.path : encodedPath;
      if (spool) await spool.sync();
      else await encodedHandle?.sync();
      recordChatStorageFileWrite(temporary, byteLength, false);
      recordChatStorageFileSync(temporary);
      await encodedHandle?.close();
      encodedHandle = undefined;
      await spool?.close();
      signal?.throwIfAborted();
      await this.publishTemporary(chatId, temporary, ref, created);
      return ref;
    } finally {
      // A published temporary has already moved, so removal is a no-op.
      try {
        await encodedHandle?.close();
      } finally {
        await rm(encodedPath, { force: true });
        await spool?.discard();
      }
    }
  }

  /**
   * Prepare a row for durable storage under `policy` (see
   * {@link TranscriptFieldPolicy}). Existing references are always verified,
   * and their previews must fit the inline budget; a field that already has a
   * reference is never published again.
   */
  public async externalize(
    chatId: string,
    message: PersistedChatMessage,
    created?: CreatedArtifacts,
    policy: TranscriptFieldPolicy = { kind: 'legacy' },
    visualContext?: ExternalizeVisualContext,
  ): Promise<PersistedChatMessage> {
    const result = await this.externalizeWithVisuals(
      chatId,
      message,
      created,
      policy,
      visualContext,
    );
    return result.message;
  }

  /** Externalize a message and expose newly promoted visuals for publication. */
  public async externalizeWithVisuals(
    chatId: string,
    message: PersistedChatMessage,
    created?: CreatedArtifacts,
    policy: TranscriptFieldPolicy = { kind: 'legacy' },
    visualContext?: ExternalizeVisualContext,
  ): Promise<{
    message: PersistedChatMessage;
    promotedVisuals: PromotedVisual[];
  }> {
    const promotedVisuals: PromotedVisual[] = [];
    // Promotion writes the visual and reserves its owner, so only real writes
    // may promote; verification and dry runs never do.
    const writes =
      policy.kind === 'legacy' ||
      (policy.kind === 'format4' && policy.dryRun !== true);
    const stored = await this.externalizeFields(
      chatId,
      message,
      created,
      policy,
      {
        messageId: message.id,
        context: writes ? visualContext : undefined,
        promoted: promotedVisuals,
      },
    );
    return { message: stored, promotedVisuals };
  }

  private async externalizeFields(
    chatId: string,
    message: PersistedChatMessage,
    created: CreatedArtifacts | undefined,
    policy: TranscriptFieldPolicy,
    visuals: ToolResultVisuals,
  ): Promise<PersistedChatMessage> {
    if (message.blocksRef !== undefined) {
      if (policy.kind === 'legacy')
        throw new Error('Block pages require format 4');
      await this.verifyPagedMessage(chatId, message, policy);
      return message;
    }
    if (policy.kind === 'legacy')
      return this.externalizeToolOutput(chatId, message, created, visuals);
    const format4 = policy.kind === 'format4';
    const blocks: PersistedChatMessage['blocks'] = [];
    let blocksSinceYield = 0;
    for (const block of message.blocks) {
      blocksSinceYield += 1;
      if (blocksSinceYield >= 128) {
        await yieldToEventLoop();
        blocksSinceYield = 0;
      }
      if (block.type === 'tool_result') {
        // Open and final tool output are stored alike, so a dry run verifies.
        blocks.push(
          await this.prepareToolResult(chatId, block, policy, created, visuals),
        );
        continue;
      }
      const field = (
        value: string,
        ref: PersistedToolOutputReference | undefined,
      ): Promise<PreparedBodyField | undefined> =>
        this.prepareBodyField(chatId, value, ref, policy, created);
      if (block.type === 'text' || block.type === 'thinking') {
        const next = await field(block.text, block.textRef);
        blocks.push(
          next ? { ...block, text: next.value, textRef: next.ref } : block,
        );
      } else if (block.type === 'tool_use') {
        const next = await field(block.input, block.inputRef);
        blocks.push(
          next ? { ...block, input: next.value, inputRef: next.ref } : block,
        );
      } else if (block.type === 'delegated_agent_call') {
        let card = block;
        if (card.partialText !== undefined) {
          const next = await field(card.partialText, card.partialTextRef);
          if (next)
            card = {
              ...card,
              partialText: next.value,
              partialTextRef: next.ref,
            };
        } else if (card.partialTextRef)
          await this.verify(chatId, card.partialTextRef);
        if (card.finalText !== undefined) {
          const next = await field(card.finalText, card.finalTextRef);
          if (next)
            card = { ...card, finalText: next.value, finalTextRef: next.ref };
        } else if (card.finalTextRef)
          await this.verify(chatId, card.finalTextRef);
        blocks.push(card);
      } else blocks.push(block);
    }
    const prepared = { ...message, blocks };
    if (!format4) return prepared;
    const reduced = await reduceBackedPreviewsWithFallback(prepared);
    if (
      !policy.final ||
      (await measureTranscriptRowByteLength(reduced.fullyReduced)) <=
        this.rowTargetBytes
    )
      return reduced.fullyReduced;
    return this.externalizeBlockPages(
      chatId,
      await reduceAllBackedPreviewsToFirstTier(prepared),
      created,
      policy.dryRun === true,
    );
  }

  private async verifyPagedMessage(
    chatId: string,
    message: PersistedChatMessage,
    policy: Exclude<TranscriptFieldPolicy, { kind: 'legacy' }>,
  ): Promise<void> {
    const expanded = await this.expandBlocks(chatId, message);
    const verifyPolicy: TranscriptFieldPolicy =
      policy.kind === 'format4-verify'
        ? policy
        : { kind: 'format4-verify', final: policy.final };
    await this.externalize(chatId, expanded, undefined, verifyPolicy);
  }

  /**
   * Read and verify the exact bytes that are decoded and parsed. Keeping the
   * read on one open handle prevents a path replacement between verification
   * and parsing from substituting unverified bytes.
   */
  private async readBlockArtifact(
    chatId: string,
    reference: PersistedToolOutputReference,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      !isPersistedToolOutputReference(reference) ||
      reference.encoding !== 'utf-8'
    )
      throw transcriptBlockArtifactError();
    signal?.throwIfAborted();
    const path = this.path(chatId, reference);
    const handle = await open(path, 'r');
    try {
      const before = await handle.stat();
      if (before.size !== reference.byteLength)
        throw new Error('Tool output artifact failed integrity validation');
      const bytes = await handle.readFile();
      if (bytes.byteLength !== reference.byteLength)
        throw new Error('Tool output artifact failed integrity validation');
      const hash = createHash('sha256');
      let bytesSinceYield = 0;
      for (
        let offset = 0;
        offset < bytes.byteLength;
        offset += SPOOL_YIELD_BYTES
      ) {
        signal?.throwIfAborted();
        const chunk = bytes.subarray(
          offset,
          Math.min(bytes.byteLength, offset + SPOOL_YIELD_BYTES),
        );
        hash.update(chunk);
        bytesSinceYield += chunk.byteLength;
        if (bytesSinceYield >= SPOOL_YIELD_BYTES) {
          await yieldToEventLoop();
          bytesSinceYield = 0;
        }
      }
      signal?.throwIfAborted();
      if (hash.digest('hex') !== reference.sha256)
        throw new Error('Tool output artifact failed integrity validation');
      const after = await handle.stat();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error('Tool output artifact changed during validation');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw transcriptBlockArtifactError();
      }
      try {
        return JSON.parse(text);
      } catch {
        throw transcriptBlockArtifactError();
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Walk only pages intersecting an ordinal interval. Manifests still verify
   * the complete child layout, but nested manifests and pages outside the
   * requested interval remain unopened.
   */
  private async *walkBlockPageRange(
    chatId: string,
    blocksRef: NonNullable<PersistedChatMessage['blocksRef']>,
    firstBlockOrdinal: number,
    endBlockOrdinal: number,
    signal?: AbortSignal,
  ): AsyncGenerator<{
    firstBlockOrdinal: number;
    blocks: PersistedChatBlock[];
  }> {
    if (
      !isTranscriptBlocksReference(blocksRef) ||
      !Number.isSafeInteger(firstBlockOrdinal) ||
      !Number.isSafeInteger(endBlockOrdinal) ||
      firstBlockOrdinal < 0 ||
      endBlockOrdinal <= firstBlockOrdinal ||
      endBlockOrdinal > blocksRef.blockCount
    )
      throw transcriptBlockArtifactError();

    type PendingArtifact = {
      kind: 'manifest' | 'page';
      firstBlockOrdinal: number;
      blockCount: number;
      reference: PersistedToolOutputReference;
    };
    const pending: PendingArtifact[] = [
      {
        kind: 'manifest',
        firstBlockOrdinal: 0,
        blockCount: blocksRef.blockCount,
        reference: blocksRef.manifest,
      },
    ];
    const visited = new Set<string>();
    while (pending.length > 0) {
      signal?.throwIfAborted();
      const current = pending.pop();
      if (current === undefined) continue;
      const currentEnd = current.firstBlockOrdinal + current.blockCount;
      if (
        !Number.isSafeInteger(current.firstBlockOrdinal) ||
        !Number.isSafeInteger(current.blockCount) ||
        current.firstBlockOrdinal < 0 ||
        current.blockCount < 1 ||
        !Number.isSafeInteger(currentEnd)
      )
        throw transcriptBlockArtifactError();
      if (
        currentEnd <= firstBlockOrdinal ||
        current.firstBlockOrdinal >= endBlockOrdinal
      )
        continue;
      if (
        !isPersistedToolOutputReference(current.reference) ||
        current.reference.encoding !== 'utf-8'
      )
        throw transcriptBlockArtifactError();
      if (visited.has(current.reference.artifactId))
        throw new Error('Transcript block artifact cycle detected');
      visited.add(current.reference.artifactId);
      if (current.kind === 'page') await yieldToEventLoop();
      const value = await this.readBlockArtifact(
        chatId,
        current.reference,
        signal,
      );
      if (current.kind === 'page') {
        if (
          !isTranscriptBlockPage(value, isPersistedChatBlock) ||
          value.firstBlockOrdinal !== current.firstBlockOrdinal ||
          value.blocks.length !== current.blockCount
        )
          throw transcriptBlockArtifactError();
        yield {
          firstBlockOrdinal: current.firstBlockOrdinal,
          blocks: value.blocks,
        };
        continue;
      }
      if (
        !isTranscriptBlockManifest(value) ||
        value.firstBlockOrdinal !== current.firstBlockOrdinal ||
        value.blockCount !== current.blockCount ||
        value.entries.length === 0
      )
        throw transcriptBlockArtifactError();
      const children: PendingArtifact[] = [];
      let nextOrdinal = current.firstBlockOrdinal;
      for (let index = 0; index < value.entries.length; index += 1) {
        const entry = value.entries[index];
        if (entry === undefined) throw transcriptBlockArtifactError();
        if (
          !Number.isSafeInteger(entry.firstBlockOrdinal) ||
          !Number.isSafeInteger(entry.blockCount) ||
          entry.blockCount < 1 ||
          entry.firstBlockOrdinal !== nextOrdinal ||
          !isPersistedToolOutputReference(entry.reference) ||
          entry.reference.encoding !== 'utf-8'
        )
          throw transcriptBlockArtifactError();
        nextOrdinal += entry.blockCount;
        if (!Number.isSafeInteger(nextOrdinal))
          throw transcriptBlockArtifactError();
        children.push({
          kind: entry.kind,
          firstBlockOrdinal: entry.firstBlockOrdinal,
          blockCount: entry.blockCount,
          reference: entry.reference,
        });
        if ((index + 1) % 128 === 0) await yieldToEventLoop();
      }
      if (nextOrdinal !== currentEnd) throw transcriptBlockArtifactError();
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (
          child !== undefined &&
          child.firstBlockOrdinal < endBlockOrdinal &&
          child.firstBlockOrdinal + child.blockCount > firstBlockOrdinal
        )
          pending.push(child);
      }
    }
  }

  private async *walkBlockArtifacts(
    chatId: string,
    blocksRef: NonNullable<PersistedChatMessage['blocksRef']>,
    signal?: AbortSignal,
  ): AsyncGenerator<{
    reference: PersistedToolOutputReference;
    blocks?: PersistedChatBlock[];
  }> {
    if (
      !isTranscriptBlocksReference(blocksRef) ||
      !Number.isSafeInteger(blocksRef.blockCount) ||
      blocksRef.blockCount < 1
    )
      throw transcriptBlockArtifactError();
    type PendingArtifact = {
      kind: 'manifest' | 'page';
      firstBlockOrdinal: number;
      blockCount: number;
      reference: PersistedToolOutputReference;
    };
    const pending: PendingArtifact[] = [
      {
        kind: 'manifest',
        firstBlockOrdinal: 0,
        blockCount: blocksRef.blockCount,
        reference: blocksRef.manifest,
      },
    ];
    const visited = new Set<string>();
    while (pending.length > 0) {
      signal?.throwIfAborted();
      const current = pending.pop();
      if (current === undefined) continue;
      if (
        !isPersistedToolOutputReference(current.reference) ||
        current.reference.encoding !== 'utf-8'
      )
        throw transcriptBlockArtifactError();
      if (visited.has(current.reference.artifactId))
        throw new Error('Transcript block artifact cycle detected');
      visited.add(current.reference.artifactId);
      if (current.kind === 'page') await yieldToEventLoop();
      const value = await this.readBlockArtifact(
        chatId,
        current.reference,
        signal,
      );
      if (current.kind === 'page') {
        if (
          !isTranscriptBlockPage(value, isPersistedChatBlock) ||
          value.firstBlockOrdinal !== current.firstBlockOrdinal ||
          value.blocks.length !== current.blockCount
        )
          throw transcriptBlockArtifactError();
        yield { reference: current.reference, blocks: value.blocks };
        continue;
      }
      if (
        !isTranscriptBlockManifest(value) ||
        value.firstBlockOrdinal !== current.firstBlockOrdinal ||
        value.blockCount !== current.blockCount ||
        value.entries.length === 0
      )
        throw transcriptBlockArtifactError();
      const children: PendingArtifact[] = [];
      let nextOrdinal = current.firstBlockOrdinal;
      for (let index = 0; index < value.entries.length; index += 1) {
        const entry = value.entries[index];
        if (entry === undefined) throw transcriptBlockArtifactError();
        if (
          !Number.isSafeInteger(entry.firstBlockOrdinal) ||
          !Number.isSafeInteger(entry.blockCount) ||
          entry.blockCount < 1 ||
          entry.firstBlockOrdinal !== nextOrdinal ||
          !isPersistedToolOutputReference(entry.reference)
        )
          throw transcriptBlockArtifactError();
        nextOrdinal += entry.blockCount;
        if (!Number.isSafeInteger(nextOrdinal))
          throw transcriptBlockArtifactError();
        children.push({
          kind: entry.kind,
          firstBlockOrdinal: entry.firstBlockOrdinal,
          blockCount: entry.blockCount,
          reference: entry.reference,
        });
        if ((index + 1) % 128 === 0) await yieldToEventLoop();
      }
      if (nextOrdinal !== current.firstBlockOrdinal + current.blockCount)
        throw transcriptBlockArtifactError();
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) pending.push(child);
      }
      yield { reference: current.reference };
    }
  }

  private async planBlockArtifact(
    kind: PlannedBlockArtifact['kind'],
    content: string,
    planned: PlannedBlockArtifact[],
  ): Promise<PersistedToolOutputReference> {
    const { ref } = await contentReference(content);
    planned.push({ kind, content, reference: ref });
    return ref;
  }

  private async planBlockPages(
    blocks: PersistedChatBlock[],
    planned: PlannedBlockArtifact[],
  ): Promise<BlockManifestNode[]> {
    const pages: BlockManifestNode[] = [];
    let pageBlocks: PersistedChatBlock[] = [];
    let firstBlockOrdinal = 0;
    let pageBytes = 0;
    const pageBaseBytes = (ordinal: number): number => {
      const emptyPage: TranscriptBlockPage = {
        version: 1,
        kind: 'transcript-block-page',
        firstBlockOrdinal: ordinal,
        blocks: [],
      };
      return Buffer.byteLength(encodeTranscriptBlockPage(emptyPage), 'utf8');
    };
    const finishPage = async (): Promise<void> => {
      if (pageBlocks.length === 0) return;
      const pending: Array<{
        firstBlockOrdinal: number;
        blocks: PersistedChatBlock[];
      }> = [{ firstBlockOrdinal, blocks: pageBlocks }];
      while (pending.length > 0) {
        const candidate = pending.pop();
        if (candidate === undefined) continue;
        const page: TranscriptBlockPage = {
          version: 1,
          kind: 'transcript-block-page',
          firstBlockOrdinal: candidate.firstBlockOrdinal,
          blocks: candidate.blocks,
        };
        const content = encodeTranscriptBlockPage(page);
        if (
          Buffer.byteLength(content, 'utf8') > this.pageTargetBytes &&
          candidate.blocks.length > 1
        ) {
          const middle = Math.floor(candidate.blocks.length / 2);
          pending.push({
            firstBlockOrdinal: candidate.firstBlockOrdinal + middle,
            blocks: candidate.blocks.slice(middle),
          });
          pending.push({
            firstBlockOrdinal: candidate.firstBlockOrdinal,
            blocks: candidate.blocks.slice(0, middle),
          });
          continue;
        }
        const reference = await this.planBlockArtifact(
          'page',
          content,
          planned,
        );
        pages.push({
          kind: 'page',
          firstBlockOrdinal: candidate.firstBlockOrdinal,
          blockCount: candidate.blocks.length,
          reference,
        });
        if (pages.length % 128 === 0) await yieldToEventLoop();
      }
      firstBlockOrdinal += pageBlocks.length;
      pageBlocks = [];
      pageBytes = pageBaseBytes(firstBlockOrdinal);
    };

    pageBytes = pageBaseBytes(0);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block === undefined) throw transcriptBlockArtifactError();
      const blockBytes = serializedValueByteLength(block);
      if (blockBytes > MAX_TRANSCRIPT_ROW_BYTES)
        throw new Error('Transcript row exceeds maximum size');
      const separatorBytes = pageBlocks.length > 0 ? 1 : 0;
      if (
        pageBlocks.length > 0 &&
        pageBytes + separatorBytes + blockBytes > this.pageTargetBytes
      ) {
        await finishPage();
      }
      pageBlocks.push(block);
      pageBytes += (pageBlocks.length > 1 ? 1 : 0) + blockBytes;
      if ((index + 1) % 128 === 0) await yieldToEventLoop();
    }
    await finishPage();
    return pages;
  }

  private async planManifest(
    nodes: BlockManifestNode[],
    planned: PlannedBlockArtifact[],
  ): Promise<BlockManifestNode> {
    if (nodes.length === 0) throw transcriptBlockArtifactError();
    const firstBlockOrdinal = nodes[0]?.firstBlockOrdinal;
    if (firstBlockOrdinal === undefined) throw transcriptBlockArtifactError();
    let blockCount = 0;
    const entries: TranscriptBlockManifestEntry[] = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node === undefined) throw transcriptBlockArtifactError();
      if (node.firstBlockOrdinal !== firstBlockOrdinal + blockCount)
        throw transcriptBlockArtifactError();
      blockCount += node.blockCount;
      if (!Number.isSafeInteger(blockCount))
        throw transcriptBlockArtifactError();
      entries.push({
        kind: node.kind,
        firstBlockOrdinal: node.firstBlockOrdinal,
        blockCount: node.blockCount,
        reference: node.reference,
      });
      if ((index + 1) % 128 === 0) await yieldToEventLoop();
    }
    const manifest: TranscriptBlockManifest = {
      version: 1,
      kind: 'transcript-block-manifest',
      firstBlockOrdinal,
      blockCount,
      entries,
    };
    const content = encodeTranscriptBlockManifest(manifest);
    const reference = await this.planBlockArtifact(
      'manifest',
      content,
      planned,
    );
    return {
      kind: 'manifest',
      firstBlockOrdinal,
      blockCount,
      reference,
    };
  }

  private manifestCandidateBytes(
    firstBlockOrdinal: number,
    blockCount: number,
    entryBytes: number,
    entryCount: number,
  ): number {
    const emptyManifest: TranscriptBlockManifest = {
      version: 1,
      kind: 'transcript-block-manifest',
      firstBlockOrdinal,
      blockCount,
      entries: [],
    };
    return (
      serializedValueByteLength(emptyManifest) +
      entryBytes +
      Math.max(0, entryCount - 1)
    );
  }

  private async buildBlockManifest(
    initialNodes: BlockManifestNode[],
    planned: PlannedBlockArtifact[],
  ): Promise<BlockManifestNode> {
    let nodes = initialNodes;
    while (true) {
      const root = await this.planManifest(nodes, planned);
      const rootArtifact = planned[planned.length - 1];
      if (
        rootArtifact?.kind !== 'manifest' ||
        rootArtifact.reference.artifactId !== root.reference.artifactId
      )
        throw transcriptBlockArtifactError();
      if (
        Buffer.byteLength(rootArtifact.content, 'utf8') <=
        this.manifestTargetBytes
      )
        return root;
      if (nodes.length < 2)
        throw new Error('Transcript block manifest target is too small');

      // The oversized tentative root is not part of the graph. It is safe to
      // remove from the plan because references are content-derived only.
      planned.pop();
      const parents: BlockManifestNode[] = [];
      let group: BlockManifestNode[] = [];
      let entryBytes = 0;
      let groupCount = 0;
      const flush = async (): Promise<void> => {
        if (group.length === 0) return;
        const parent = await this.planManifest(group, planned);
        const artifact = planned[planned.length - 1];
        if (
          artifact?.kind !== 'manifest' ||
          Buffer.byteLength(artifact.content, 'utf8') > this.manifestTargetBytes
        )
          throw new Error('Transcript block manifest target is too small');
        parents.push(parent);
        group = [];
        entryBytes = 0;
        groupCount = 0;
      };
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node === undefined) throw transcriptBlockArtifactError();
        const entry: TranscriptBlockManifestEntry = {
          kind: node.kind,
          firstBlockOrdinal: node.firstBlockOrdinal,
          blockCount: node.blockCount,
          reference: node.reference,
        };
        const nextCount = groupCount + node.blockCount;
        const nextEntryBytes = entryBytes + serializedValueByteLength(entry);
        const candidateBytes = this.manifestCandidateBytes(
          group[0]?.firstBlockOrdinal ?? node.firstBlockOrdinal,
          nextCount,
          nextEntryBytes,
          group.length + 1,
        );
        if (group.length > 0 && candidateBytes > this.manifestTargetBytes) {
          await flush();
        }
        const singleEntryBytes = serializedValueByteLength(entry);
        const singleCandidateBytes = this.manifestCandidateBytes(
          node.firstBlockOrdinal,
          node.blockCount,
          singleEntryBytes,
          1,
        );
        if (singleCandidateBytes > this.manifestTargetBytes)
          throw new Error('Transcript block manifest target is too small');
        group.push(node);
        entryBytes += singleEntryBytes;
        groupCount += node.blockCount;
        if ((index + 1) % 128 === 0) await yieldToEventLoop();
      }
      await flush();
      if (parents.length >= nodes.length)
        throw new Error('Transcript block manifest target is too small');
      nodes = parents;
    }
  }

  private async externalizeBlockPages(
    chatId: string,
    message: PersistedChatMessage,
    created: CreatedArtifacts | undefined,
    dryRun: boolean,
  ): Promise<PersistedChatMessage> {
    if (message.blocks.length === 0)
      throw new Error('Transcript row exceeds maximum size');
    const planned: PlannedBlockArtifact[] = [];
    const pages = await this.planBlockPages(message.blocks, planned);
    const root = await this.buildBlockManifest(pages, planned);
    const paged: PersistedChatMessage = {
      ...message,
      blocks: [],
      blocksRef: {
        version: 1,
        manifest: root.reference,
        blockCount: message.blocks.length,
      },
    };
    if (
      (await measureTranscriptRowByteLength(paged)) > MAX_TRANSCRIPT_ROW_BYTES
    )
      throw new Error('Transcript row exceeds maximum size');
    if (!dryRun) {
      for (const artifact of planned) {
        const published = await this.put(chatId, artifact.content, created);
        if (!isDeepStrictEqual(published, artifact.reference))
          throw new Error(
            'Transcript block artifact changed during publication',
          );
      }
    }
    return paged;
  }

  /**
   * Every artifact `message` depends on: its body references and, for a
   * paged row, its block manifests, pages and the body references of the
   * paged blocks. Manifests and pages are read and verified; body references
   * are only yielded, possibly more than once.
   */
  public async *referenceClosure(
    chatId: string,
    message: PersistedChatMessage,
    signal?: AbortSignal,
  ): AsyncGenerator<PersistedToolOutputReference> {
    signal?.throwIfAborted();
    for (const { reference } of transcriptBodyReferences(message))
      yield reference;
    if (message.blocksRef === undefined) return;
    if (message.blocks.length !== 0) throw transcriptBlockArtifactError();
    for await (const visit of this.walkBlockArtifacts(
      chatId,
      message.blocksRef,
      signal,
    )) {
      yield visit.reference;
      for (const block of visit.blocks ?? [])
        for (const { reference } of transcriptBodyReferences({
          blocks: [block],
        }))
          yield reference;
    }
  }

  /** Read a bounded ordinal interval without materializing the rest of a row. */
  public async readBlocks(
    chatId: string,
    message: PersistedChatMessage,
    firstBlockOrdinal: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PersistedChatBlock[]> {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(firstBlockOrdinal) ||
      firstBlockOrdinal < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 0
    )
      throw new Error('Invalid transcript block range');
    if (message.blocksRef === undefined) {
      const start = Math.min(firstBlockOrdinal, message.blocks.length);
      const count = Math.min(limit, message.blocks.length - start);
      return message.blocks.slice(start, start + count);
    }
    if (
      message.blocks.length !== 0 ||
      !isTranscriptBlocksReference(message.blocksRef)
    )
      throw transcriptBlockArtifactError();
    if (limit === 0 || firstBlockOrdinal >= message.blocksRef.blockCount)
      return [];

    const first = firstBlockOrdinal;
    const count = Math.min(limit, message.blocksRef.blockCount - first);
    const end = first + count;
    const blocks: PersistedChatBlock[] = [];
    let nextOrdinal = first;
    for await (const page of this.walkBlockPageRange(
      chatId,
      message.blocksRef,
      first,
      end,
      signal,
    )) {
      const pageEnd = page.firstBlockOrdinal + page.blocks.length;
      const overlapStart = Math.max(first, page.firstBlockOrdinal);
      const overlapEnd = Math.min(end, pageEnd);
      if (overlapStart !== nextOrdinal || overlapEnd <= overlapStart)
        throw transcriptBlockArtifactError();
      for (
        let index = overlapStart - page.firstBlockOrdinal;
        index < overlapEnd - page.firstBlockOrdinal;
        index += 1
      ) {
        const block = page.blocks[index];
        if (block === undefined) throw transcriptBlockArtifactError();
        blocks.push(block);
      }
      nextOrdinal = overlapEnd;
    }
    if (nextOrdinal !== end || blocks.length !== count)
      throw transcriptBlockArtifactError();
    return blocks;
  }

  /**
   * Lazily read a row's blocks in order. Consumers that stop early leave all
   * later manifests and pages unopened.
   */
  public async *iterateBlocks(
    chatId: string,
    message: PersistedChatMessage,
    signal?: AbortSignal,
  ): AsyncGenerator<PersistedChatBlock> {
    signal?.throwIfAborted();
    if (message.blocksRef === undefined) {
      for (const block of message.blocks) {
        signal?.throwIfAborted();
        yield block;
      }
      return;
    }
    if (
      message.blocks.length !== 0 ||
      !isTranscriptBlocksReference(message.blocksRef)
    )
      throw transcriptBlockArtifactError();
    let nextOrdinal = 0;
    for await (const page of this.walkBlockPageRange(
      chatId,
      message.blocksRef,
      0,
      message.blocksRef.blockCount,
      signal,
    )) {
      if (page.firstBlockOrdinal !== nextOrdinal)
        throw transcriptBlockArtifactError();
      for (const block of page.blocks) {
        signal?.throwIfAborted();
        yield block;
        nextOrdinal += 1;
      }
    }
    if (nextOrdinal !== message.blocksRef.blockCount)
      throw transcriptBlockArtifactError();
  }

  /**
   * The logical row: a paged row's blocks read back from its pages, in
   * order, without `blocksRef`. Bodies stay references. A row without
   * `blocksRef` is returned unchanged.
   */
  public async expandBlocks(
    chatId: string,
    message: PersistedChatMessage,
    signal?: AbortSignal,
  ): Promise<PersistedChatMessage> {
    signal?.throwIfAborted();
    if (!message.blocksRef) return message;
    if (message.blocks.length !== 0) throw transcriptBlockArtifactError();
    const blocks: PersistedChatBlock[] = [];
    for await (const visit of this.walkBlockArtifacts(
      chatId,
      message.blocksRef,
      signal,
    )) {
      for (const block of visit.blocks ?? []) blocks.push(block);
    }
    if (blocks.length !== message.blocksRef.blockCount)
      throw transcriptBlockArtifactError();
    const expanded = { ...message, blocks };
    delete expanded.blocksRef;
    return expanded;
  }

  /**
   * Whether committed row `stored` is the format 4 final form of `open`, the
   * open form of the same row: its finalization offloaded fields the open
   * form keeps inline. Publishes nothing.
   */
  public async isFinalFormOf(
    chatId: string,
    open: PersistedChatMessage,
    stored: PersistedChatMessage,
  ): Promise<boolean> {
    if (
      transcriptBodyReferences(stored).length === 0 &&
      stored.blocksRef === undefined
    )
      return false;
    const final = await this.externalize(chatId, open, undefined, {
      kind: 'format4',
      final: true,
      dryRun: true,
    });
    return sameTranscriptRowWithoutWholeRowStringify(final, stored);
  }

  /**
   * One generalized body field of a format 4 row: a replacement preview and
   * its newly published reference, or `undefined` to keep the field as is.
   */
  private async prepareBodyField(
    chatId: string,
    value: string,
    ref: PersistedToolOutputReference | undefined,
    policy: Exclude<TranscriptFieldPolicy, { kind: 'legacy' }>,
    created?: CreatedArtifacts,
  ): Promise<PreparedBodyField | undefined> {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (ref) {
      await this.verify(chatId, ref);
      if (bytes > TOOL_OUTPUT_INLINE_BYTES)
        throw new Error(
          'Referenced transcript field preview exceeds inline budget',
        );
      return undefined;
    }
    // An open row keeps generalized fields inline and whole.
    if (!policy.final || bytes <= TOOL_OUTPUT_INLINE_BYTES) return undefined;
    if (policy.kind === 'format4-verify') {
      if (policy.committed) return undefined;
      throw new Error(
        'Transcript field exceeds inline budget without a lossless artifact',
      );
    }
    return {
      value: preview(value),
      ref: policy.dryRun
        ? (await contentReference(value)).ref
        : await this.put(chatId, value, created),
    };
  }

  /** Format 4 tool output: legacy offload, or verification only. */
  private async prepareToolResult(
    chatId: string,
    block: Extract<PersistedChatBlock, { type: 'tool_result' }>,
    policy: Exclude<TranscriptFieldPolicy, { kind: 'legacy' }>,
    created: CreatedArtifacts | undefined,
    visuals: ToolResultVisuals,
  ): Promise<PersistedChatBlock> {
    const overBudget =
      Buffer.byteLength(block.output, 'utf8') > TOOL_OUTPUT_INLINE_BYTES;
    if (
      policy.kind === 'format4' &&
      policy.dryRun === true &&
      !block.fullOutputRef &&
      !block.outputTruncated &&
      overBudget
    ) {
      // Canonicalize as a real write would, so a dry run matches the stored row.
      return {
        ...withCanonicalAgentArtifacts(block),
        output: preview(block.output),
        outputTruncated: true,
        fullOutputRef: (await contentReference(block.output)).ref,
      };
    }
    if (
      policy.kind === 'format4-verify' &&
      !block.fullOutputRef &&
      !block.outputTruncated &&
      overBudget
    )
      throw new Error(
        'Transcript field exceeds inline budget without a lossless artifact',
      );
    const [prepared] = (
      await this.externalizeToolOutput(
        chatId,
        { blocks: [block] },
        created,
        visuals,
      )
    ).blocks;
    if (prepared === undefined) throw new Error('Tool result was not prepared');
    return prepared;
  }

  /** Format 2/3 behaviour: only tool output is offloaded. */
  private async externalizeToolOutput<
    Row extends Pick<PersistedChatMessage, 'blocks'>,
  >(
    chatId: string,
    message: Row,
    created: CreatedArtifacts | undefined,
    visuals: ToolResultVisuals,
  ): Promise<Row> {
    const blocks: PersistedChatMessage['blocks'] = [];
    for (const block of message.blocks) {
      if (block.type !== 'tool_result') {
        blocks.push(block);
        continue;
      }
      for (const ref of storedArtifactRefsOf(block))
        await this.verifyArtifact(chatId, ref);
      const promotion = block.visualRef
        ? undefined
        : await this.promoteVisual(
            chatId,
            visuals.messageId,
            block.toolUseId,
            block.output,
            created,
            visuals.context,
          );
      if (promotion) visuals.promoted.push(promotion);
      const promotedBlock = withCanonicalAgentArtifacts({
        ...block,
        ...(promotion ? { visualRef: promotion.reference } : {}),
      });
      if (block.fullOutputRef) {
        if (
          Buffer.byteLength(block.output, 'utf8') > TOOL_OUTPUT_INLINE_BYTES
        ) {
          throw new Error(
            'Referenced tool output preview exceeds inline budget',
          );
        }
        blocks.push(promotedBlock);
      } else if (block.outputTruncated) {
        throw new Error('Truncated tool output has no lossless artifact');
      } else if (
        Buffer.byteLength(block.output, 'utf8') > TOOL_OUTPUT_INLINE_BYTES
      ) {
        const fullOutputRef = await this.put(chatId, block.output, created);
        blocks.push({
          ...promotedBlock,
          output: preview(block.output),
          outputTruncated: true,
          fullOutputRef,
        });
      } else {
        blocks.push(promotedBlock);
      }
    }
    return { ...message, blocks };
  }
}
