/**
 * On-disk format of the per-scope chat delta journal (storage manifest
 * version 3). See `docs/desktop-chat-state-ownership.md` § Delta journal.
 *
 * A journal file is a sequence of frames:
 *
 * ```text
 * offset 0   4 bytes   magic "CDJ1"
 * offset 4   4 bytes   payload length, unsigned little-endian
 * offset 8  32 bytes   SHA-256 of the payload (checksum and record digest)
 * offset 40  n bytes   payload: one UTF-8 JSON record
 * ```
 *
 * The first frame is a segment header; every later frame is a commit record.
 * Each record names the digest of the frame before it (`prev`), so the frames
 * form a hash chain anchored by the segment header. The checksum doubles as
 * the record digest, so verifying one verifies the other.
 *
 * This module is pure: it reads, writes and validates bytes and values only.
 */
import { createHash } from 'node:crypto';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import { isPersistedChatMessage } from '../persisted-chat-message-validation';
import { isRecord } from '../type-guards';
import { isIndexDelta, type IndexDelta } from './index-delta';
import {
  TranscriptTargetSchema,
  TranscriptStreamRegistrationSchema,
  DelegationChildRowEnvelopeSchema,
  TranscriptStreamDescriptorUpdateSchema,
  PersistedToolOutputReferenceSchema,
  type TranscriptTarget,
  type TranscriptStreamRegistration,
  type TranscriptStreamDescriptorUpdate,
} from '@canopy/protocol/canopy-core';
import {
  isDelegationStopReason,
  type AgentDelegationUsage,
  type DelegateSettledStatus,
} from '@canopy/protocol/delegation';
import {
  DELEGATION_REGISTRY_MAX_ERROR_LENGTH,
  DELEGATION_REGISTRY_MAX_ID_LENGTH,
  type DelegationTranscriptGenerationEntry,
  type DelegationTranscriptResultEntry,
  type SettledDelegationErrorCode,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { validateDelegationReceiptEntry } from '@canopy/desktop-shared/node/delegation/receipt-reply';
import {
  delegationRegistryJsonFits,
  type DelegationRegistryJournalEffect,
} from './delegation-registry-api';

export const DELTA_JOURNAL_FILE_NAME = 'delta-journal.log';
export const DELTA_JOURNAL_V2_FILE_NAME = 'delta-journal-v2.log';
/**
 * A journal tail that recovery dropped with reason `checksum_mismatch` is
 * first copied, byte for byte, to `<prefix><n>.bin` in the scope directory.
 */
export const DELTA_JOURNAL_QUARANTINE_PREFIX = 'delta-journal-tail-quarantine-';
/** Active rows startup recovery could not reconcile with history (CAN-6902). */
export const DELTA_JOURNAL_ECHO_QUARANTINE_PREFIX =
  'delta-journal-echo-quarantine-';
/** Present only while a checkpoint is being written. */
export const DELTA_CHECKPOINT_MARKER_NAME = 'delta-checkpoint.json';
/** Suffix of an index file a checkpoint staged but has not yet published. */
export const DELTA_CHECKPOINT_STAGED_SUFFIX = '.checkpoint';
/** Scratch area a checkpoint uses for rewrite inputs; never authoritative. */
export const DELTA_CHECKPOINT_WORK_DIRECTORY = 'delta-checkpoint-work';
export const DELTA_JOURNAL_MANIFEST_VERSION = 3;
export const DELTA_JOURNAL_FORMAT = 'chat-delta-journal-v1';
export const DELTA_JOURNAL_V2_FORMAT = 'chat-delta-journal-v2';
export const FORMAT4_MANIFEST_VERSION = 4;
export const MAX_SUPPORTED_CHAT_STORAGE_MANIFEST_VERSION = 4;

const MAGIC = Buffer.from('CDJ1', 'ascii');
export const FRAME_HEADER_BYTES = 40;
/** A record is bounded so a reader never buffers an unbounded frame. */
export const MAX_RECORD_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** Digest the first segment of a new journal chains from. */
export const DELTA_JOURNAL_GENESIS_DIGEST: string = createHash('sha256')
  .update(`${DELTA_JOURNAL_FORMAT}:genesis`)
  .digest('hex');
export const DELTA_JOURNAL_V2_GENESIS_DIGEST: string = createHash('sha256')
  .update(`${DELTA_JOURNAL_V2_FORMAT}:genesis`)
  .digest('hex');

/**
 * The journal or its checkpoint is internally inconsistent: a corrupt frame
 * followed by a valid one, a broken hash chain, a revision gap, an invalid
 * record, or a missing referenced artifact. The scope enters
 * `recovery_error`; the files are preserved and never read as empty.
 */
export class ChatDeltaJournalIntegrityError extends Error {
  public override readonly name = 'ChatDeltaJournalIntegrityError';
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare public readonly cause?: unknown;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/**
 * The scope was written by a newer storage format than this code may change:
 * a version 3 (delta-journal) scope opened by a path that only writes the
 * version 2 files, a future authority manifest, or a journal record of a
 * version this reader does not know.
 * It fails closed; nothing is written and nothing is read as empty.
 */
export class ChatStorageNewerFormatError extends Error {
  public override readonly name = 'ChatStorageNewerFormatError';
}

/** Refuse only a well-formed future authority claim for this scope. */
export function assertNoNewerChatStorageManifest(
  value: unknown,
  scopeId: string,
  maxManifestVersion: 3 | 4 = 4,
): void {
  if (
    isRecord(value) &&
    value.scopeId === scopeId &&
    Number.isInteger(value.version) &&
    typeof value.version === 'number' &&
    value.version > maxManifestVersion
  )
    throw new ChatStorageNewerFormatError(
      'Chat storage was written by a newer version of the app; this version cannot open it',
    );
}

interface Format4ManifestBase {
  version: 4;
  scopeId: string;
  migrationId: string;
  sourceRevision: number;
  sourceDigest: string;
  cleanupComplete: true;
}

export interface Format4JournaledManifest extends Format4ManifestBase {
  journal: typeof DELTA_JOURNAL_V2_FORMAT;
}

export interface Format4CheckpointedManifest extends Format4ManifestBase {
  journal?: never;
}

export type Format4StorageManifest =
  | Format4JournaledManifest
  | Format4CheckpointedManifest;

export type ChatJournalStorageManifest =
  | DeltaJournalStorageManifest
  | Format4StorageManifest;

export interface ChatStorageV2Manifest {
  version: 2;
  scopeId: string;
  migrationId: string;
  sourceRevision: number;
  sourceDigest: string;
  cleanupComplete: boolean;
}

export function isChatStorageV2Manifest(
  value: unknown,
): value is ChatStorageV2Manifest {
  return (
    isRecord(value) &&
    value.version === 2 &&
    typeof value.scopeId === 'string' &&
    typeof value.migrationId === 'string' &&
    Number.isSafeInteger(value.sourceRevision) &&
    typeof value.sourceDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sourceDigest) &&
    typeof value.cleanupComplete === 'boolean'
  );
}

/** Strict format-4 authority parsing; older manifest-3 bytes stay compatible. */
export function parseChatStorageManifest(
  value: unknown,
): ChatJournalStorageManifest {
  if (!isRecord(value))
    throw new ChatDeltaJournalIntegrityError('Invalid chat storage manifest');
  if (value.version !== 3 && value.version !== 4)
    throw new ChatStorageNewerFormatError(
      'Chat storage manifest version is newer than this version',
    );
  if (value.version === 3) {
    if (!isDeltaJournalStorageManifest(value))
      throw new ChatDeltaJournalIntegrityError('Invalid chat storage manifest');
    return value;
  }
  const known = new Set([
    'version',
    'scopeId',
    'migrationId',
    'sourceRevision',
    'sourceDigest',
    'cleanupComplete',
    'journal',
  ]);
  if (Object.keys(value).some((key) => !known.has(key)))
    throw new ChatStorageNewerFormatError(
      'Chat storage manifest has unknown fields',
    );
  if (
    typeof value.scopeId !== 'string' ||
    typeof value.migrationId !== 'string' ||
    !isNonNegativeInteger(value.sourceRevision) ||
    typeof value.sourceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
    value.cleanupComplete !== true
  )
    throw new ChatDeltaJournalIntegrityError('Invalid chat storage manifest');
  if (value.journal !== undefined && value.journal !== DELTA_JOURNAL_V2_FORMAT)
    throw new ChatStorageNewerFormatError(
      'Chat storage journal kind is newer than this version',
    );
  return {
    version: 4,
    scopeId: value.scopeId,
    migrationId: value.migrationId,
    sourceRevision: value.sourceRevision,
    sourceDigest: value.sourceDigest,
    cleanupComplete: true,
    ...(value.journal === DELTA_JOURNAL_V2_FORMAT
      ? { journal: value.journal }
      : {}),
  };
}

export function selectJournal(
  manifest: unknown,
): typeof DELTA_JOURNAL_FORMAT | typeof DELTA_JOURNAL_V2_FORMAT | undefined {
  if (!isRecord(manifest)) return undefined;
  if (
    typeof manifest.version === 'number' &&
    manifest.version > MAX_SUPPORTED_CHAT_STORAGE_MANIFEST_VERSION
  )
    throw new ChatStorageNewerFormatError(
      'Chat storage manifest version is newer than this version',
    );
  if (manifest.version === 3 || manifest.version === 4)
    return parseChatStorageManifest(manifest).journal;
  return undefined;
}

export function journalFileFor(manifest: unknown): string | undefined {
  const selected = selectJournal(manifest);
  return selected === DELTA_JOURNAL_FORMAT
    ? DELTA_JOURNAL_FILE_NAME
    : selected === DELTA_JOURNAL_V2_FORMAT
      ? DELTA_JOURNAL_V2_FILE_NAME
      : undefined;
}

export interface DeltaJournalStorageManifest {
  version: 3;
  scopeId: string;
  migrationId: string;
  sourceRevision: number;
  sourceDigest: string;
  /** Version 3 is only ever published over a cleaned-up version 2 scope. */
  cleanupComplete: true;
  journal: typeof DELTA_JOURNAL_FORMAT;
  /**
   * The version 2 manifest the scope was promoted from, verbatim, so a
   * demotion restores its exact bytes. Readers ignore it.
   */
  demotesTo?: unknown;
}

export function isDeltaJournalStorageManifest(
  value: unknown,
): value is DeltaJournalStorageManifest {
  return (
    isRecord(value) &&
    value.version === DELTA_JOURNAL_MANIFEST_VERSION &&
    typeof value.scopeId === 'string' &&
    typeof value.migrationId === 'string' &&
    Number.isSafeInteger(value.sourceRevision) &&
    typeof value.sourceDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sourceDigest) &&
    value.cleanupComplete === true &&
    value.journal === DELTA_JOURNAL_FORMAT
  );
}

export interface DeltaJournalSegmentRecord {
  type: 'segment';
  v: 1;
  scopeId: string;
  /** Revision of the checkpoint this segment continues from. */
  baseRevision: number;
  /** Digest of the last record of the previous segment, or the genesis. */
  prev: string;
}

/** Messages appended to, or written into the mutable suffix of, one chat. */
export interface DeltaJournalMessagesEffect {
  chatId: string;
  /**
   * `append` finalizes rows into the committed log. `active` and
   * `active-replace` replace the active projection (the latter may drop
   * uncommitted rows). `active-upsert` replaces active rows by id in place
   * and appends new ones, carrying only the rows that changed.
   */
  kind: 'append' | 'active' | 'active-replace' | 'active-upsert';
  /** The chat had no transcript before this record. */
  create: boolean;
  messages: PersistedChatMessage[];
  /**
   * Active kinds only, written by the phase 09 write path: the transcript
   * revision the chat's log index holds once this effect is applied. It lets
   * a checkpoint write a run of active updates once, with the revision the
   * individual writes would have reached. Readers that apply records one by
   * one ignore it.
   */
  transcriptRevision?: number;
}

/** An intentional whole-transcript rewrite (import, reset, replacement). */
export interface DeltaJournalReplaceEffect {
  chatId: string;
  kind: 'replace';
  create: boolean;
  messages: PersistedChatMessage[];
  /** The last `activeTailCount` rows become the active projection. */
  activeTailCount: number;
  /** Transcript revision the replaced log had, for the rewrite revision. */
  priorTranscriptRevision: number;
}

/**
 * A rewrite expressed against the committed rows the chat has when the
 * record applies: drop `removedMessageIds`, replace rows by id from
 * `patches`, move any row whose id is in `tail` to the end, then append
 * `tail`. The last `activeTailCount` rows of the result are active.
 */
export interface DeltaJournalPatchEffect {
  chatId: string;
  kind: 'patch';
  patches: PersistedChatMessage[];
  removedMessageIds: string[];
  tail: PersistedChatMessage[];
  activeTailCount: number;
  priorTranscriptRevision: number;
}

export interface DeltaJournalDeleteEffect {
  chatId: string;
  kind: 'delete';
}

export type DeltaJournalTranscriptEffect =
  | DeltaJournalMessagesEffect
  | DeltaJournalReplaceEffect
  | DeltaJournalPatchEffect
  | DeltaJournalDeleteEffect;

export interface DeltaJournalCommitRecord {
  type: 'commit';
  v: 1;
  prev: string;
  fromRevision: number;
  toRevision: number;
  /** Mutation identities this record applied, for idempotent retry. */
  mutationIds: string[];
  /**
   * Group commit: the byte offset of the first frame of the batch this
   * record was appended with. A batch is written with one append and one
   * sync, so none of it is acknowledged before all of it is durable. Absent
   * on a batch's first record and on a record written alone. Recovery uses
   * it only to tell an unsynced batch's damaged tail from corruption
   * followed by acknowledged data (see {@link scanDeltaJournalFrames}).
   */
  batchStart?: number;
  /** Index metadata change; never whole indexes, never descriptors. */
  delta: IndexDelta;
  /** One effect per chat, applied in order. */
  transcripts: DeltaJournalTranscriptEffect[];
}

export type DeltaJournalRecord =
  | DeltaJournalSegmentRecord
  | DeltaJournalCommitRecord;

export interface DeltaJournalV2SegmentRecord {
  type: 'segment';
  v: 2;
  scopeId: string;
  baseRevision: number;
  prev: string;
}

type WithTarget<T> = T extends unknown
  ? Omit<T, 'chatId'> & { target: TranscriptTarget }
  : never;
export type DeltaJournalV2TranscriptEffect =
  | WithTarget<DeltaJournalTranscriptEffect>
  | {
      kind: 'child-upsert';
      target: Extract<TranscriptTarget, { kind: 'delegation' }>;
      rows: DelegationChildRow[];
    }
  | {
      kind: 'child-settle';
      target: Extract<TranscriptTarget, { kind: 'delegation' }>;
      rows: DelegationChildRow[];
      settlementKey: string;
    };
export interface DeltaJournalV2CommitRecord {
  type: 'commit';
  v: 2;
  prev: string;
  fromRevision: number;
  toRevision: number;
  mutationIds: string[];
  batchStart?: number;
  delta: IndexDelta;
  transcripts: DeltaJournalV2TranscriptEffect[];
  streamRegistrations: TranscriptStreamRegistration[];
  descriptorUpdates: TranscriptStreamDescriptorUpdate[];
  /** Canonical registry entries admitted atomically with transcript effects. */
  registryEffects?: DelegationRegistryJournalEffect[];
}
export type DeltaJournalV2Record =
  | DeltaJournalV2SegmentRecord
  | DeltaJournalV2CommitRecord;
export type AnyDeltaJournalRecord = DeltaJournalRecord | DeltaJournalV2Record;

/** Stable identity for per-record duplicate detection and stream lookup. */
export function transcriptTargetKey(target: TranscriptTarget): string {
  return JSON.stringify(
    target.kind === 'primary'
      ? ['primary', target.chatId]
      : [
          'delegation',
          target.chatId,
          target.delegationId,
          target.runGeneration,
        ],
  );
}

export function normalizeV1TranscriptEffect(
  effect: DeltaJournalTranscriptEffect,
): DeltaJournalV2TranscriptEffect {
  const { chatId, ...payload } = effect;
  return { ...payload, target: { kind: 'primary', chatId } };
}

export interface DeltaJournalFrame {
  /** Byte offset of the frame in the file. */
  offset: number;
  /** Byte offset just past the frame. */
  end: number;
  digest: string;
  payload: Buffer;
}

/**
 * Why the bytes after the verified prefix are not a frame.
 *
 * - `incomplete`: the header or the payload it declares runs past the end
 *   of the file, as an append cut short leaves it.
 * - `checksum_mismatch`: a complete header whose magic, length or checksum
 *   is invalid, as a full-length write whose sync never completed can leave
 *   it after power loss.
 *
 * Either way no verified frame follows, so the record was never
 * acknowledged and the log ends before it. A verified frame whose payload is
 * not a valid record is neither: its checksum proves those bytes were
 * written, so it fails closed instead.
 */
export type DeltaJournalTailReason = 'incomplete' | 'checksum_mismatch';

export interface DeltaJournalTornTail {
  offset: number;
  bytes: number;
  reason: DeltaJournalTailReason;
}

export interface DeltaJournalFrameScan {
  frames: DeltaJournalFrame[];
  /** Length of the longest prefix made only of complete, verified frames. */
  validEnd: number;
  /**
   * Bytes after `validEnd` that do not form a verified frame and are not
   * followed by one: an append that was never acknowledged.
   */
  tornTail?: DeltaJournalTornTail;
}

export function encodeDeltaJournalFrame(record: AnyDeltaJournalRecord): {
  frame: Buffer;
  digest: string;
} {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  if (payload.length > MAX_RECORD_PAYLOAD_BYTES)
    throw new Error('Delta journal record exceeds the maximum record size');
  const checksum = createHash('sha256').update(payload).digest();
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(payload.length, 4);
  checksum.copy(header, 8);
  return {
    frame: Buffer.concat([header, payload]),
    digest: checksum.toString('hex'),
  };
}

type FrameProbe = DeltaJournalFrame | 'incomplete' | 'invalid';

function probeFrame(bytes: Buffer, offset: number): FrameProbe {
  if (offset + FRAME_HEADER_BYTES > bytes.length) return 'incomplete';
  if (!bytes.subarray(offset, offset + MAGIC.length).equals(MAGIC))
    return 'invalid';
  const length = bytes.readUInt32LE(offset + 4);
  if (length > MAX_RECORD_PAYLOAD_BYTES) return 'invalid';
  const end = offset + FRAME_HEADER_BYTES + length;
  if (end > bytes.length) return 'incomplete';
  const payload = bytes.subarray(offset + FRAME_HEADER_BYTES, end);
  const checksum = createHash('sha256').update(payload).digest();
  if (!checksum.equals(bytes.subarray(offset + 8, offset + FRAME_HEADER_BYTES)))
    return 'invalid';
  return { offset, end, digest: checksum.toString('hex'), payload };
}

/**
 * Split a journal file into verified frames. An invalid or incomplete frame
 * that no verified frame follows is a torn tail: a write that was never
 * synced, so never acknowledged. Anything after it is reported, not
 * returned. A verified frame after an invalid one means acknowledged data
 * follows corruption, which fails closed, unless that frame is a later
 * record of the batch the invalid bytes are in: the batch was one unsynced
 * append, so the tail starts at the invalid bytes.
 */
export function scanDeltaJournalFrames(bytes: Buffer): DeltaJournalFrameScan {
  const frames: DeltaJournalFrame[] = [];
  let offset = 0;
  let stop: FrameProbe | undefined;
  while (offset < bytes.length) {
    const probe = probeFrame(bytes, offset);
    if (probe === 'incomplete' || probe === 'invalid') {
      stop = probe;
      break;
    }
    frames.push(probe);
    offset = probe.end;
  }
  if (offset === bytes.length) return { frames, validEnd: offset };
  let batchFollows = false;
  for (
    let candidate = bytes.indexOf(MAGIC, offset + 1);
    candidate !== -1;
    candidate = bytes.indexOf(MAGIC, candidate + 1)
  ) {
    const probe = probeFrame(bytes, candidate);
    if (typeof probe !== 'object') continue;
    // Group commit writes a batch with one append and one sync. A verified
    // frame of the batch the damage is in was never acknowledged either.
    // Any other verified frame was appended after that batch's sync.
    if (!continuesBatchFrom(probe, offset))
      throw new ChatDeltaJournalIntegrityError(
        `Delta journal is corrupt at byte ${offset} before a later valid record`,
      );
    batchFollows = true;
  }
  return {
    frames,
    validEnd: offset,
    tornTail: {
      offset,
      bytes: bytes.length - offset,
      // Whole frames follow the damage: keep them for inspection.
      reason:
        stop === 'incomplete' && !batchFollows
          ? 'incomplete'
          : 'checksum_mismatch',
    },
  };
}

/**
 * Whether a verified frame found after damage at `damagedAt` is a later
 * record of a batch that began at or before the damage: it names that
 * batch's first frame (`batchStart`), which only a record that is not the
 * first of its batch does.
 */
function continuesBatchFrom(
  frame: DeltaJournalFrame,
  damagedAt: number,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(frame.payload.toString('utf8'));
  } catch {
    return false;
  }
  return (
    isRecord(value) &&
    value.type === 'commit' &&
    isNonNegativeInteger(value.batchStart) &&
    value.batchStart <= damagedAt &&
    value.batchStart < frame.offset
  );
}

function isMessageList(value: unknown): value is PersistedChatMessage[] {
  return Array.isArray(value) && value.every(isPersistedChatMessage);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

const MESSAGE_KINDS = new Set([
  'append',
  'active',
  'active-replace',
  'active-upsert',
]);
export const V1_KNOWN_KINDS = new Set([
  ...Array.from(MESSAGE_KINDS),
  'replace',
  'patch',
  'delete',
]);
export const V2_PRIMARY_KINDS = new Set(V1_KNOWN_KINDS);
export const V2_CHILD_KINDS = new Set(['child-upsert', 'child-settle']);

function parseEffect(value: unknown): DeltaJournalTranscriptEffect {
  if (!isRecord(value) || typeof value.chatId !== 'string')
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
  const kind = value.kind;
  if (typeof kind !== 'string' || !V1_KNOWN_KINDS.has(kind))
    throw new ChatStorageNewerFormatError(
      'Delta journal effect kind is newer than this version',
    );
  const chatId = value.chatId;
  if (kind === 'delete') return { chatId, kind };
  if (
    kind === 'append' ||
    kind === 'active' ||
    kind === 'active-replace' ||
    kind === 'active-upsert'
  ) {
    if (typeof value.create !== 'boolean' || !isMessageList(value.messages))
      throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
    const revision = value.transcriptRevision;
    if (
      revision !== undefined &&
      (kind === 'append' || !isNonNegativeInteger(revision))
    )
      throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
    return {
      chatId,
      kind,
      create: value.create,
      messages: value.messages,
      ...(isNonNegativeInteger(revision)
        ? { transcriptRevision: revision }
        : {}),
    };
  }
  if (
    !isNonNegativeInteger(value.activeTailCount) ||
    !isNonNegativeInteger(value.priorTranscriptRevision)
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
  if (kind === 'replace') {
    if (
      typeof value.create !== 'boolean' ||
      !isMessageList(value.messages) ||
      value.activeTailCount > value.messages.length
    )
      throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
    return {
      chatId,
      kind,
      create: value.create,
      messages: value.messages,
      activeTailCount: value.activeTailCount,
      priorTranscriptRevision: value.priorTranscriptRevision,
    };
  }
  const removed = value.removedMessageIds;
  if (
    !isMessageList(value.patches) ||
    !isMessageList(value.tail) ||
    !Array.isArray(removed) ||
    !removed.every((id) => typeof id === 'string') ||
    value.activeTailCount > value.tail.length
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
  return {
    chatId,
    kind: 'patch',
    patches: value.patches,
    removedMessageIds: removed.filter(
      (id): id is string => typeof id === 'string',
    ),
    tail: value.tail,
    activeTailCount: value.activeTailCount,
    priorTranscriptRevision: value.priorTranscriptRevision,
  };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Decode one verified frame. Unknown record versions fail closed. */
export function decodeDeltaJournalRecord(
  frame: DeltaJournalFrame,
): DeltaJournalRecord {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(frame.payload));
  } catch {
    throw new ChatDeltaJournalIntegrityError(
      'Delta journal record is not valid JSON',
    );
  }
  if (!isRecord(value) || typeof value.prev !== 'string')
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal record');
  if (value.v !== 1 || (value.type !== 'segment' && value.type !== 'commit'))
    throw new ChatStorageNewerFormatError(
      'Delta journal record is newer than this version',
    );
  if (value.type === 'segment') {
    if (
      typeof value.scopeId !== 'string' ||
      !isNonNegativeInteger(value.baseRevision)
    )
      throw new ChatDeltaJournalIntegrityError('Invalid delta journal segment');
    return {
      type: 'segment',
      v: 1,
      scopeId: value.scopeId,
      baseRevision: value.baseRevision,
      prev: value.prev,
    };
  }
  const mutationIds = value.mutationIds;
  if (
    !isNonNegativeInteger(value.fromRevision) ||
    !isNonNegativeInteger(value.toRevision) ||
    value.toRevision <= value.fromRevision ||
    !Array.isArray(mutationIds) ||
    !mutationIds.every((id) => typeof id === 'string') ||
    !isIndexDelta(value.delta) ||
    !Array.isArray(value.transcripts)
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal record');
  const transcripts = value.transcripts.map(parseEffect);
  const chats = new Set(transcripts.map((effect) => effect.chatId));
  if (chats.size !== transcripts.length)
    throw new ChatDeltaJournalIntegrityError(
      'Delta journal record has two effects for one chat',
    );
  const batchStart = value.batchStart;
  if (
    batchStart !== undefined &&
    (!isNonNegativeInteger(batchStart) || batchStart >= frame.offset)
  )
    throw new ChatDeltaJournalIntegrityError(
      'Invalid delta journal batch offset',
    );
  return {
    type: 'commit',
    v: 1,
    prev: value.prev,
    fromRevision: value.fromRevision,
    toRevision: value.toRevision,
    mutationIds: mutationIds.filter(
      (id): id is string => typeof id === 'string',
    ),
    delta: value.delta,
    transcripts,
    ...(batchStart !== undefined ? { batchStart } : {}),
  };
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ChatStorageNewerFormatError(
      'Delta journal record contains unknown fields',
    );
}

function parseV2Effect(value: unknown): DeltaJournalV2TranscriptEffect {
  if (!isRecord(value))
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
  const kind = value.kind;
  if (
    typeof kind !== 'string' ||
    (!V2_PRIMARY_KINDS.has(kind) && !V2_CHILD_KINDS.has(kind))
  )
    throw new ChatStorageNewerFormatError(
      'Delta journal effect kind is newer than this version',
    );
  const common = ['target', 'kind'];
  if (V2_CHILD_KINDS.has(kind)) return parseChildEffect(value);
  rejectUnknownFields(
    value,
    kind === 'delete'
      ? common
      : MESSAGE_KINDS.has(kind)
        ? [...common, 'create', 'messages', 'transcriptRevision']
        : kind === 'replace'
          ? [
              ...common,
              'create',
              'messages',
              'activeTailCount',
              'priorTranscriptRevision',
            ]
          : [
              ...common,
              'patches',
              'removedMessageIds',
              'tail',
              'activeTailCount',
              'priorTranscriptRevision',
            ],
  );
  const targetResult = TranscriptTargetSchema.safeParse(value.target);
  if (!targetResult.success) {
    if (
      isRecord(value.target) &&
      typeof value.target.kind === 'string' &&
      value.target.kind !== 'primary' &&
      value.target.kind !== 'delegation'
    )
      throw new ChatStorageNewerFormatError(
        'Delta journal target kind is newer than this version',
      );
    if (
      isRecord(value.target) &&
      targetResult.error.issues.some(
        (issue) => issue.code === 'unrecognized_keys',
      )
    )
      throw new ChatStorageNewerFormatError(
        'Delta journal target contains unknown fields',
      );
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal target');
  }
  if (targetResult.data.kind !== 'primary')
    throw new ChatDeltaJournalIntegrityError(
      'Primary effect requires primary target',
    );
  // The legacy payload validator retains all six effect semantics. Its
  // synthesized chatId is never used for addressing the child stream.
  const parsed = parseEffect({ ...value, chatId: targetResult.data.chatId });
  if (parsed.kind === 'delete')
    return { kind: 'delete', target: targetResult.data };
  if (parsed.kind === 'patch')
    return {
      kind: 'patch',
      target: targetResult.data,
      patches: parsed.patches,
      removedMessageIds: parsed.removedMessageIds,
      tail: parsed.tail,
      activeTailCount: parsed.activeTailCount,
      priorTranscriptRevision: parsed.priorTranscriptRevision,
    };
  if (parsed.kind === 'replace')
    return {
      kind: 'replace',
      target: targetResult.data,
      create: parsed.create,
      messages: parsed.messages,
      activeTailCount: parsed.activeTailCount,
      priorTranscriptRevision: parsed.priorTranscriptRevision,
    };
  return {
    kind: parsed.kind,
    target: targetResult.data,
    create: parsed.create,
    messages: parsed.messages,
    ...(parsed.transcriptRevision === undefined
      ? {}
      : { transcriptRevision: parsed.transcriptRevision }),
  };
}

/** Child payloads never enter the primary effect parser. */
function parseChildEffect(
  value: Record<string, unknown>,
): DeltaJournalV2TranscriptEffect {
  rejectUnknownFields(
    value,
    value.kind === 'child-settle'
      ? ['kind', 'target', 'rows', 'settlementKey']
      : ['kind', 'target', 'rows'],
  );
  const target = TranscriptTargetSchema.safeParse(value.target);
  if (!target.success || target.data.kind !== 'delegation')
    throw new ChatDeltaJournalIntegrityError(
      'Child effect requires delegation target',
    );
  if (!Array.isArray(value.rows))
    throw new ChatDeltaJournalIntegrityError('Invalid child rows');
  const rows = value.rows.map((row: unknown) => {
    const parsed = DelegationChildRowEnvelopeSchema.safeParse({
      version: 1,
      row,
    });
    if (!parsed.success || !isPersistedChatMessage(row))
      throw new ChatDeltaJournalIntegrityError('Invalid child row');
    if (
      Object.keys(row).some(
        (key) =>
          ![
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
      )
    )
      throw new ChatStorageNewerFormatError(
        'Child row contains unknown fields',
      );
    if (
      row.delegationSegment !== undefined &&
      (typeof row.delegationSegment !== 'string' ||
        row.delegationSegment.length === 0)
    )
      throw new ChatDeltaJournalIntegrityError('Invalid child row segment');
    return {
      ...row,
      itemRevision: parsed.data.row.itemRevision,
      final: parsed.data.row.final,
    };
  });
  if (value.kind === 'child-settle') {
    if (
      typeof value.settlementKey !== 'string' ||
      value.settlementKey.length === 0 ||
      rows.some((row) => !row.final)
    )
      throw new ChatDeltaJournalIntegrityError('Invalid child settlement');
    return {
      kind: 'child-settle',
      target: target.data,
      rows,
      settlementKey: value.settlementKey,
    };
  }
  return { kind: 'child-upsert', target: target.data, rows };
}

function isRegistryId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DELEGATION_REGISTRY_MAX_ID_LENGTH
  );
}

function assertRegistryKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ChatStorageNewerFormatError(`${label} contains unknown fields`);
}

function registryEntryWithinLimit(value: unknown): boolean {
  try {
    return delegationRegistryJsonFits(value);
  } catch {
    return false;
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function parseGenerationEntry(
  value: unknown,
): DelegationTranscriptGenerationEntry {
  if (!isRecord(value))
    throw new ChatDeltaJournalIntegrityError('Invalid delegation generation');
  assertRegistryKeys(
    value,
    [
      'version',
      'kind',
      'chatId',
      'delegationId',
      'runGeneration',
      'createdAt',
      'store',
      'origin',
      'executionMode',
    ],
    'Delegation generation',
  );
  if (
    value.version !== 1 ||
    value.kind !== 'generation' ||
    !isRegistryId(value.chatId) ||
    !isRegistryId(value.delegationId) ||
    !isNonNegativeInteger(value.runGeneration) ||
    !isSafeInteger(value.createdAt) ||
    (value.store !== 'stream' && value.store !== 'legacy') ||
    (value.executionMode !== 'background' &&
      value.executionMode !== 'foreground') ||
    !isRecord(value.origin)
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delegation generation');
  assertRegistryKeys(
    value.origin,
    ['kind', 'anchorMessageId', 'authoredItemId'],
    'Delegation generation origin',
  );
  if (
    (value.origin.kind !== 'launch' &&
      value.origin.kind !== 'follow_up' &&
      value.origin.kind !== 'resume' &&
      value.origin.kind !== 'continuation') ||
    (value.origin.anchorMessageId !== undefined &&
      !isRegistryId(value.origin.anchorMessageId)) ||
    (value.origin.authoredItemId !== undefined &&
      !isRegistryId(value.origin.authoredItemId)) ||
    !registryEntryWithinLimit(value)
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delegation generation');
  return {
    version: 1,
    kind: 'generation',
    chatId: value.chatId,
    delegationId: value.delegationId,
    runGeneration: value.runGeneration,
    createdAt: value.createdAt,
    store: value.store,
    origin: {
      kind: value.origin.kind,
      ...(value.origin.anchorMessageId === undefined
        ? {}
        : { anchorMessageId: value.origin.anchorMessageId }),
      ...(value.origin.authoredItemId === undefined
        ? {}
        : { authoredItemId: value.origin.authoredItemId }),
    },
    executionMode: value.executionMode,
  };
}

function isSettledStatus(value: unknown): value is DelegateSettledStatus {
  return (
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'deadline_exceeded' ||
    value === 'interrupted'
  );
}

/** Stored results never carry the spawn-only lifetime refusal. */
function isDelegationErrorCode(
  value: unknown,
): value is SettledDelegationErrorCode {
  return (
    value === 'invalid_request' ||
    value === 'capability_unavailable' ||
    value === 'route_unavailable' ||
    value === 'auth_required' ||
    value === 'interaction_required' ||
    value === 'policy_blocked' ||
    value === 'capacity_exceeded' ||
    value === 'parent_unavailable' ||
    value === 'launch_uncertain' ||
    value === 'runtime_error' ||
    value === 'apply_failed' ||
    value === 'terminated_by_parent'
  );
}

function parseSettlementOutcome(
  value: unknown,
): DelegationTranscriptResultEntry['outcome'] {
  if (!isRecord(value))
    throw new ChatDeltaJournalIntegrityError('Invalid delegation result');
  assertRegistryKeys(
    value,
    ['status', 'error', 'usage', 'stopReason', 'startedAt', 'finishedAt'],
    'Delegation result outcome',
  );
  if (
    !isSettledStatus(value.status) ||
    !isSafeInteger(value.finishedAt) ||
    (value.startedAt !== undefined && !isSafeInteger(value.startedAt))
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delegation result');
  let error: DelegationTranscriptResultEntry['outcome']['error'];
  if (value.error !== undefined) {
    if (!isRecord(value.error))
      throw new ChatDeltaJournalIntegrityError('Invalid delegation result');
    assertRegistryKeys(
      value.error,
      ['code', 'message', 'retryable'],
      'Delegation result error',
    );
    if (
      !isDelegationErrorCode(value.error.code) ||
      typeof value.error.message !== 'string' ||
      value.error.message.length > DELEGATION_REGISTRY_MAX_ERROR_LENGTH ||
      typeof value.error.retryable !== 'boolean'
    )
      throw new ChatDeltaJournalIntegrityError('Invalid delegation result');
    error = {
      code: value.error.code,
      message: value.error.message,
      retryable: value.error.retryable,
    };
  }
  let usage: AgentDelegationUsage | undefined;
  if (value.usage !== undefined) {
    if (!isRecord(value.usage))
      throw new ChatDeltaJournalIntegrityError('Invalid delegation result');
    assertRegistryKeys(
      value.usage,
      [
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'cacheCreationInputTokens',
        'costUsd',
      ],
      'Delegation result usage',
    );
    for (const [key, amount] of Object.entries(value.usage))
      if (
        typeof amount !== 'number' ||
        amount < 0 ||
        (key === 'costUsd'
          ? !Number.isFinite(amount)
          : !Number.isSafeInteger(amount))
      )
        throw new ChatDeltaJournalIntegrityError('Invalid delegation result');
    usage = {
      ...(typeof value.usage.inputTokens === 'number'
        ? { inputTokens: value.usage.inputTokens }
        : {}),
      ...(typeof value.usage.outputTokens === 'number'
        ? { outputTokens: value.usage.outputTokens }
        : {}),
      ...(typeof value.usage.cachedInputTokens === 'number'
        ? { cachedInputTokens: value.usage.cachedInputTokens }
        : {}),
      ...(typeof value.usage.cacheCreationInputTokens === 'number'
        ? { cacheCreationInputTokens: value.usage.cacheCreationInputTokens }
        : {}),
      ...(typeof value.usage.costUsd === 'number'
        ? { costUsd: value.usage.costUsd }
        : {}),
    };
  }
  if (
    value.stopReason !== undefined &&
    !isDelegationStopReason(value.stopReason)
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delegation result');
  return {
    status: value.status,
    ...(error === undefined ? {} : { error }),
    ...(usage === undefined ? {} : { usage }),
    ...(value.stopReason === undefined ? {} : { stopReason: value.stopReason }),
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }),
    finishedAt: value.finishedAt,
  };
}

function parseResultAnswer(
  value: unknown,
): DelegationTranscriptResultEntry['answer'] {
  if (!isRecord(value) || typeof value.kind !== 'string')
    throw new ChatDeltaJournalIntegrityError(
      'Invalid delegation result answer',
    );
  if (value.kind === 'none') {
    assertRegistryKeys(value, ['kind'], 'Delegation result answer');
    return { kind: 'none' };
  }
  if (value.kind === 'empty') {
    assertRegistryKeys(value, ['kind', 'role'], 'Delegation result answer');
    if (value.role !== 'final' && value.role !== 'partial')
      throw new ChatDeltaJournalIntegrityError(
        'Invalid delegation result answer',
      );
    return { kind: 'empty', role: value.role };
  }
  if (value.kind === 'lost') {
    assertRegistryKeys(
      value,
      ['kind', 'role', 'sha256', 'length'],
      'Delegation result answer',
    );
    if (
      (value.role !== 'final' && value.role !== 'partial') ||
      !isNonNegativeInteger(value.length) ||
      value.length < 1 ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    )
      throw new ChatDeltaJournalIntegrityError(
        'Invalid delegation result answer',
      );
    return {
      kind: 'lost',
      role: value.role,
      sha256: value.sha256,
      length: value.length,
    };
  }
  if (value.kind !== 'body')
    throw new ChatStorageNewerFormatError(
      'Delegation result answer kind is newer than this version',
    );
  assertRegistryKeys(
    value,
    ['kind', 'role', 'byteLength', 'encoding', 'sha256', 'ref'],
    'Delegation result answer',
  );
  const ref = PersistedToolOutputReferenceSchema.safeParse(value.ref);
  if (!ref.success) {
    if (ref.error.issues.some((issue) => issue.code === 'unrecognized_keys'))
      throw new ChatStorageNewerFormatError(
        'Delegation result answer reference contains unknown fields',
      );
    throw new ChatDeltaJournalIntegrityError(
      'Invalid delegation result answer reference',
    );
  }
  if (
    (value.role !== 'final' && value.role !== 'partial') ||
    !isNonNegativeInteger(value.byteLength) ||
    (value.encoding !== 'utf8' && value.encoding !== 'utf16le') ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    ref.data.byteLength !== value.byteLength ||
    ref.data.sha256 !== value.sha256 ||
    ref.data.encoding !== (value.encoding === 'utf8' ? 'utf-8' : 'utf-16le')
  )
    throw new ChatDeltaJournalIntegrityError(
      'Invalid delegation result answer',
    );
  return {
    kind: 'body',
    role: value.role,
    byteLength: value.byteLength,
    encoding: value.encoding,
    sha256: value.sha256,
    ref: ref.data,
  };
}

function parseResultEntry(value: unknown): DelegationTranscriptResultEntry {
  if (!isRecord(value))
    throw new ChatDeltaJournalIntegrityError('Invalid delegation result');
  assertRegistryKeys(
    value,
    [
      'version',
      'kind',
      'resultIndex',
      'runGeneration',
      'settlementKey',
      'settlementDigest',
      'outcome',
      'answer',
      'settlement',
    ],
    'Delegation result',
  );
  if (
    value.version !== 1 ||
    value.kind !== 'result' ||
    !isNonNegativeInteger(value.resultIndex) ||
    value.resultIndex === 0 ||
    !isNonNegativeInteger(value.runGeneration) ||
    !isRegistryId(value.settlementKey) ||
    typeof value.settlementDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.settlementDigest) ||
    !isRecord(value.settlement)
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delegation result');
  assertRegistryKeys(
    value.settlement,
    ['streamRevision', 'contentRevision', 'finalItemCount', 'finalItemsDigest'],
    'Delegation result settlement',
  );
  if (
    !isNonNegativeInteger(value.settlement.streamRevision) ||
    value.settlement.streamRevision === 0 ||
    value.settlement.contentRevision !== value.settlement.streamRevision ||
    !isNonNegativeInteger(value.settlement.finalItemCount) ||
    typeof value.settlement.finalItemsDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.settlement.finalItemsDigest)
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delegation result');
  const entry: DelegationTranscriptResultEntry = {
    version: 1,
    kind: 'result',
    resultIndex: value.resultIndex,
    runGeneration: value.runGeneration,
    settlementKey: value.settlementKey,
    settlementDigest: value.settlementDigest,
    outcome: parseSettlementOutcome(value.outcome),
    answer: parseResultAnswer(value.answer),
    settlement: {
      streamRevision: value.settlement.streamRevision,
      contentRevision: value.settlement.contentRevision,
      finalItemCount: value.settlement.finalItemCount,
      finalItemsDigest: value.settlement.finalItemsDigest,
    },
  };
  if (!registryEntryWithinLimit(entry))
    throw new ChatDeltaJournalIntegrityError(
      'Delegation result entry exceeds its metadata bound',
    );
  return entry;
}

function parseRegistryEffect(value: unknown): DelegationRegistryJournalEffect {
  const effect = parseRegistryEffectFields(value);
  // The store bounds the whole effect: refuse here, before the record syncs.
  if (!registryEntryWithinLimit(effect))
    throw new ChatDeltaJournalIntegrityError(
      'Delegation registry effect exceeds its metadata bound',
    );
  return effect;
}

function parseRegistryEffectFields(
  value: unknown,
): DelegationRegistryJournalEffect {
  if (!isRecord(value) || typeof value.kind !== 'string')
    throw new ChatDeltaJournalIntegrityError(
      'Invalid delegation registry effect',
    );
  if (value.kind === 'delegation-generation') {
    assertRegistryKeys(
      value,
      ['kind', 'identity', 'entry'],
      'Delegation registry effect',
    );
    if (
      !isRecord(value.identity) ||
      !isRegistryId(value.identity.chatId) ||
      !isRegistryId(value.identity.delegationId)
    )
      throw new ChatDeltaJournalIntegrityError(
        'Invalid delegation registry identity',
      );
    assertRegistryKeys(
      value.identity,
      ['chatId', 'delegationId'],
      'Delegation registry identity',
    );
    const entry = parseGenerationEntry(value.entry);
    if (
      entry.chatId !== value.identity.chatId ||
      entry.delegationId !== value.identity.delegationId
    )
      throw new ChatDeltaJournalIntegrityError(
        'Delegation generation identity mismatch',
      );
    return {
      kind: 'delegation-generation',
      identity: {
        chatId: value.identity.chatId,
        delegationId: value.identity.delegationId,
      },
      entry,
    };
  }
  if (value.kind === 'delegation-result') {
    assertRegistryKeys(
      value,
      ['kind', 'target', 'entry'],
      'Delegation registry effect',
    );
    const target = TranscriptTargetSchema.safeParse(value.target);
    if (!target.success || target.data.kind !== 'delegation')
      throw new ChatDeltaJournalIntegrityError(
        'Delegation result requires delegation target',
      );
    const entry = parseResultEntry(value.entry);
    if (entry.runGeneration !== target.data.runGeneration)
      throw new ChatDeltaJournalIntegrityError(
        'Delegation result generation mismatch',
      );
    return { kind: 'delegation-result', target: target.data, entry };
  }
  if (value.kind === 'child-admission') {
    assertRegistryKeys(
      value,
      ['kind', 'target', 'items'],
      'Delegation registry effect',
    );
    const target = TranscriptTargetSchema.safeParse(value.target);
    if (!target.success || target.data.kind !== 'delegation')
      throw new ChatDeltaJournalIntegrityError(
        'Child admission requires delegation target',
      );
    if (!Array.isArray(value.items))
      throw new ChatDeltaJournalIntegrityError('Invalid child admission');
    const itemIds = new Set<string>();
    const items = value.items.map((item: unknown) => {
      if (!isRecord(item))
        throw new ChatDeltaJournalIntegrityError('Invalid child admission');
      assertRegistryKeys(
        item,
        ['id', 'itemRevision', 'admittingStreamRevision', 'mutationKey'],
        'Child admission metadata',
      );
      if (
        !isRegistryId(item.id) ||
        !isNonNegativeInteger(item.itemRevision) ||
        !isNonNegativeInteger(item.admittingStreamRevision) ||
        item.admittingStreamRevision === 0 ||
        !isRegistryId(item.mutationKey) ||
        itemIds.has(item.id)
      )
        throw new ChatDeltaJournalIntegrityError('Invalid child admission');
      itemIds.add(item.id);
      return {
        id: item.id,
        itemRevision: item.itemRevision,
        admittingStreamRevision: item.admittingStreamRevision,
        mutationKey: item.mutationKey,
      };
    });
    return { kind: 'child-admission', target: target.data, items };
  }
  if (value.kind === 'delegation-receipt') {
    assertRegistryKeys(
      value,
      ['kind', 'owner', 'entry'],
      'Delegation registry effect',
    );
    if (
      !isRecord(value.owner) ||
      value.owner.kind !== 'chat_receipts' ||
      !isRegistryId(value.owner.chatId)
    )
      throw new ChatDeltaJournalIntegrityError(
        'Invalid delegation receipt owner',
      );
    assertRegistryKeys(
      value.owner,
      ['kind', 'chatId'],
      'Delegation receipt owner',
    );
    const receipt = validateDelegationReceiptEntry(value.entry);
    if (!receipt.ok || receipt.entry.chatId !== value.owner.chatId)
      throw new ChatDeltaJournalIntegrityError(
        'Invalid delegation receipt entry or owner mismatch',
      );
    return {
      kind: 'delegation-receipt',
      owner: { kind: 'chat_receipts', chatId: value.owner.chatId },
      entry: receipt.entry,
    };
  }
  throw new ChatStorageNewerFormatError(
    'Delegation registry effect kind is newer than this version',
  );
}

function validateRegistryEffectClosure(
  effects: readonly DelegationRegistryJournalEffect[],
  transcripts: readonly DeltaJournalV2TranscriptEffect[],
  descriptorUpdates: readonly TranscriptStreamDescriptorUpdate[],
  toRevision: number,
): void {
  const childEffects = transcripts.filter(
    (effect) =>
      effect.kind === 'child-upsert' || effect.kind === 'child-settle',
  );
  for (const effect of effects) {
    if (effect.kind === 'delegation-result') {
      const settledRows = childEffects.find(
        (candidate) =>
          candidate.kind === 'child-settle' &&
          transcriptTargetKey(candidate.target) ===
            transcriptTargetKey(effect.target) &&
          candidate.settlementKey === effect.entry.settlementKey,
      );
      const update = descriptorUpdates.find(
        (candidate) =>
          transcriptTargetKey(candidate.target) ===
          transcriptTargetKey(effect.target),
      );
      if (
        !settledRows ||
        !update ||
        update.status !== 'settled' ||
        update.nextStreamRevision !== effect.entry.settlement.streamRevision ||
        update.settleReceipt?.scopeRevision !== toRevision ||
        update.settleReceipt.committedRowCount !==
          effect.entry.settlement.finalItemCount ||
        update.settleReceipt.committedSha256 !==
          effect.entry.settlement.finalItemsDigest
      )
        throw new ChatDeltaJournalIntegrityError(
          'Delegation result is not atomic with its child settlement',
        );
    }
    if (effect.kind === 'child-admission') {
      const child = childEffects.find(
        (candidate) =>
          transcriptTargetKey(candidate.target) ===
          transcriptTargetKey(effect.target),
      );
      if (
        !child ||
        effect.items.some(
          (metadata) =>
            !child.rows.some(
              (row) =>
                row.id === metadata.id &&
                row.itemRevision === metadata.itemRevision,
            ),
        )
      )
        throw new ChatDeltaJournalIntegrityError(
          'Child admission metadata has no matching transcript row',
        );
    }
  }
}

/** Decode a strict format-4 record without changing the v1 decoder. */
export function decodeDeltaJournalV2Record(
  frame: DeltaJournalFrame,
): DeltaJournalV2Record {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(frame.payload));
  } catch {
    throw new ChatDeltaJournalIntegrityError(
      'Delta journal record is not valid JSON',
    );
  }
  if (!isRecord(value) || typeof value.prev !== 'string')
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal record');
  if (value.v !== 2 || (value.type !== 'segment' && value.type !== 'commit'))
    throw new ChatStorageNewerFormatError(
      'Delta journal record is newer than this version',
    );
  if (value.type === 'segment') {
    rejectUnknownFields(value, [
      'type',
      'v',
      'scopeId',
      'baseRevision',
      'prev',
    ]);
    if (
      typeof value.scopeId !== 'string' ||
      !isNonNegativeInteger(value.baseRevision)
    )
      throw new ChatDeltaJournalIntegrityError('Invalid delta journal segment');
    return {
      type: 'segment',
      v: 2,
      scopeId: value.scopeId,
      baseRevision: value.baseRevision,
      prev: value.prev,
    };
  }
  rejectUnknownFields(value, [
    'type',
    'v',
    'prev',
    'fromRevision',
    'toRevision',
    'mutationIds',
    'batchStart',
    'delta',
    'transcripts',
    'streamRegistrations',
    'descriptorUpdates',
    'registryEffects',
  ]);
  if (
    !isNonNegativeInteger(value.fromRevision) ||
    !isNonNegativeInteger(value.toRevision) ||
    value.toRevision <= value.fromRevision ||
    !Array.isArray(value.mutationIds) ||
    !value.mutationIds.every((id) => typeof id === 'string') ||
    !isIndexDelta(value.delta) ||
    !Array.isArray(value.transcripts) ||
    !Array.isArray(value.streamRegistrations) ||
    !Array.isArray(value.descriptorUpdates) ||
    (value.registryEffects !== undefined &&
      !Array.isArray(value.registryEffects))
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal record');
  const descriptorUpdates = value.descriptorUpdates.map((update: unknown) => {
    const parsed = TranscriptStreamDescriptorUpdateSchema.safeParse(update);
    if (!parsed.success) {
      if (
        parsed.error.issues.some(
          (issue) =>
            issue.code === 'unrecognized_keys' ||
            issue.code === 'invalid_value',
        )
      )
        throw new ChatStorageNewerFormatError(
          'Delta journal descriptor update contains unknown fields',
        );
      throw new ChatDeltaJournalIntegrityError(
        'Invalid delta journal descriptor update',
      );
    }
    if (
      parsed.data.nextStreamRevision !==
      parsed.data.expectedStreamRevision + 1
    )
      throw new ChatDeltaJournalIntegrityError(
        'Invalid descriptor revision step',
      );
    return parsed.data;
  });
  const transcripts = value.transcripts.map(parseV2Effect);
  const targets = new Set(
    transcripts.map((effect) => transcriptTargetKey(effect.target)),
  );
  if (targets.size !== transcripts.length)
    throw new ChatDeltaJournalIntegrityError(
      'Delta journal record has two effects for one target',
    );
  const registryEffects =
    value.registryEffects === undefined
      ? undefined
      : value.registryEffects.map(parseRegistryEffect);
  if (registryEffects) {
    const registryIdentities = new Set<string>();
    for (const effect of registryEffects) {
      // A large batch's admissions span several effects for one target, so
      // admissions are duplicates only per item revision.
      const keys =
        effect.kind === 'delegation-generation'
          ? [
              JSON.stringify([
                'generation',
                effect.identity.chatId,
                effect.identity.delegationId,
                effect.entry.runGeneration,
              ]),
            ]
          : effect.kind === 'delegation-result'
            ? [
                JSON.stringify([
                  'result',
                  transcriptTargetKey(effect.target),
                  effect.entry.resultIndex,
                ]),
              ]
            : effect.kind === 'delegation-receipt'
              ? [
                  JSON.stringify([
                    'receipt',
                    effect.owner.chatId,
                    effect.entry.receiptKind,
                    effect.entry.key,
                  ]),
                ]
              : effect.items.map((item) =>
                  JSON.stringify([
                    'admission',
                    transcriptTargetKey(effect.target),
                    item.id,
                    item.itemRevision,
                  ]),
                );
      for (const key of keys) {
        if (registryIdentities.has(key))
          throw new ChatDeltaJournalIntegrityError(
            'Delta journal record has duplicate registry effects',
          );
        registryIdentities.add(key);
      }
    }
    validateRegistryEffectClosure(
      registryEffects,
      transcripts,
      descriptorUpdates,
      value.toRevision,
    );
  }
  const registrations = value.streamRegistrations.map(
    (registration: unknown) => {
      const result = TranscriptStreamRegistrationSchema.safeParse(registration);
      if (!result.success) {
        if (
          (isRecord(registration) && registration.version !== 1) ||
          result.error.issues.some(
            (issue) => issue.code === 'unrecognized_keys',
          )
        )
          throw new ChatStorageNewerFormatError(
            'Delta journal registration contains unknown fields',
          );
        throw new ChatDeltaJournalIntegrityError(
          'Invalid delta journal registration',
        );
      }
      return result.data;
    },
  );
  const registered = new Set(
    registrations.map((entry) => transcriptTargetKey(entry.target)),
  );
  if (
    registered.size !== registrations.length ||
    registrations.some(
      (entry) => entry.registeredAtRevision !== value.toRevision,
    )
  )
    throw new ChatDeltaJournalIntegrityError(
      'Delta journal record has duplicate or misrevisioned registrations',
    );
  if (
    value.batchStart !== undefined &&
    (!isNonNegativeInteger(value.batchStart) ||
      value.batchStart >= frame.offset)
  )
    throw new ChatDeltaJournalIntegrityError(
      'Invalid delta journal batch offset',
    );
  return {
    type: 'commit',
    v: 2,
    prev: value.prev,
    fromRevision: value.fromRevision,
    toRevision: value.toRevision,
    mutationIds: value.mutationIds,
    delta: value.delta,
    transcripts,
    streamRegistrations: registrations,
    descriptorUpdates,
    ...(registryEffects === undefined ? {} : { registryEffects }),
    ...(value.batchStart !== undefined ? { batchStart: value.batchStart } : {}),
  };
}

export function decodeJournalRecordForSegment(
  frame: DeltaJournalFrame,
  segmentVersion: 1 | 2,
): AnyDeltaJournalRecord {
  let header: unknown;
  try {
    header = JSON.parse(UTF8.decode(frame.payload));
  } catch {
    throw new ChatDeltaJournalIntegrityError(
      'Delta journal record is not valid JSON',
    );
  }
  if (!isRecord(header) || header.v !== segmentVersion)
    throw new ChatStorageNewerFormatError(
      'Delta journal segment and commit versions differ',
    );
  return segmentVersion === 1
    ? decodeDeltaJournalRecord(frame)
    : decodeDeltaJournalV2Record(frame);
}

/** Effects that change only a chat's active projection. */
export function isActiveEffect(
  effect: DeltaJournalTranscriptEffect,
): effect is DeltaJournalMessagesEffect & {
  kind: 'active' | 'active-replace' | 'active-upsert';
} {
  return (
    (effect.kind === 'active' ||
      effect.kind === 'active-replace' ||
      effect.kind === 'active-upsert') &&
    !effect.create
  );
}

/** Every message an effect carries, for artifact verification. */
export function effectMessages(
  effect: DeltaJournalTranscriptEffect,
): PersistedChatMessage[] {
  if (effect.kind === 'delete') return [];
  if (effect.kind === 'patch') return [...effect.patches, ...effect.tail];
  return effect.messages;
}

/**
 * The effect's rows with the finality its write gives them: appended,
 * patched and replaced committed rows are final; active rows and the
 * active suffix (`activeTailCount`) are open.
 */
export function effectRowsWithFinality(
  effect: DeltaJournalTranscriptEffect,
): Array<{ message: PersistedChatMessage; final: boolean }> {
  const suffix = (
    rows: readonly PersistedChatMessage[],
    activeTailCount: number,
  ): Array<{ message: PersistedChatMessage; final: boolean }> =>
    rows.map((message, index) => ({
      message,
      final: index < rows.length - activeTailCount,
    }));
  switch (effect.kind) {
    case 'delete':
      return [];
    case 'patch':
      return [
        ...effect.patches.map((message) => ({ message, final: true })),
        ...suffix(effect.tail, effect.activeTailCount),
      ];
    case 'replace':
      return suffix(effect.messages, effect.activeTailCount);
    case 'append':
      return effect.messages.map((message) => ({ message, final: true }));
    default:
      return effect.messages.map((message) => ({ message, final: false }));
  }
}
