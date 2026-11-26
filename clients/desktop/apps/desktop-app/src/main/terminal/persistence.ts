import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';
import {
  damagedCopyPath,
  pruneDamagedCopiesSync,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  assertAdmittedWriter,
  STORAGE_OWNERSHIP,
} from '@canopy/core-runtime/storage';
import {
  WORKER_TERMINAL_RECORD_HISTORY_MAX_BYTES,
  WORKER_TERMINAL_RECORD_MAX_OPS,
  WORKER_TERMINAL_RECORD_TEXT_MAX_CHARS,
  type WorkerTerminalRecordApplyResult,
  type WorkerTerminalRecordClient,
  type WorkerTerminalRecordOp,
  type WorkerTerminalRecordOpenResult,
  type WorkerTerminalRecordRetireParams,
  type WorkerTerminalRecordShutdownParams,
} from '@canopy/protocol/canopy-core';
import {
  TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES,
  type LoadWorktreeTerminalStateResponse,
  type PersistedTerminalEntry,
  type PersistedWorktreeTerminalStateFile,
  type SaveWorktreeTerminalStateRequest,
  type TerminalGroup,
  type TerminalRecordHistoryStatus,
  type TerminalSession,
} from '@canopy/desktop-shared/types';
// The pure codec and ops only: the daemon's repository never loads in main.
import {
  appendScrollbackLines,
  composeRecords,
  createEmptyState,
  isDrawerOwnedTerminal,
  isFiniteNumber,
  isPresentationFile,
  normalizeCustomNameMap,
  normalizeSplitSizes,
  readLegacyTerminalState,
  recordsForState,
  retainScrollbackLines,
  type TerminalPresentationFile,
  type TerminalRecords,
  type TerminalWorkerFile,
} from '@canopy/core-runtime/node/terminal/record/codec';
import {
  applyTerminalRecordOp,
  liveBinding,
  mergePendingRecord,
  type TerminalRecordPayloadState,
} from '@canopy/core-runtime/node/terminal/record/ops';
import type { TerminalPersistencePort } from '@canopy/core-runtime/node/terminal';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  getTerminalOutboxDataRoot,
  getWorktreeTerminalLegacyLayout,
  getWorktreeTerminalPresentationFilePath,
  getWorktreeTerminalStateFilePath,
} from '../lib/paths';
import {
  captureDirectoryEffects,
  directoryDeletionSince,
  directoryEffectsAdmitted,
  mutateDirectory,
  drainDirectoryEffects,
  DIRECTORY_EFFECT_DRAIN_BOUND_MS,
  type DirectoryEffectAdmission,
} from '../lib/directory-effect-admission';
import { isRecord } from '../lib/type-guards';
import {
  daemonTerminalRecordClient,
  type TerminalRecordClientPort,
} from './record-client';
import { TerminalRecordAdmissionDeferred } from './record-admission';
import {
  appendScopeOutbox,
  dropRetiredOutboxEntries,
  emptyTerminalRecordOutbox,
  retainRetiredOutboxIdentities,
  TerminalRecordOutbox,
  type TerminalRecordOutboxEntry,
  type TerminalRecordOutboxFile,
  type TerminalRecordScopeOutbox,
} from './record-outbox';

/**
 * Electron main's side of the worktree terminal record (CAN-7051).
 *
 * The daemon's record authority writes each worktree's worker record:
 * membership, sessions, output, exits and names. Daemon terminals reach it
 * through their host; this store reports in-process terminals to it as
 * ordered `apply` batches, and while it cannot be reached keeps them in a
 * durable outbox it drains later. It never writes the record, and never
 * writes `terminal-state.json` except for the forward fence once a
 * worktree's record is imported. It keeps writing the presentation layout,
 * and keeps only metadata of terminals that are not live: their output is
 * read from the record when a load or restore needs it.
 */

type PresentationRead =
  | { kind: 'absent' }
  | { kind: 'readable'; value: TerminalPresentationFile }
  | { kind: 'damaged' }
  | { kind: 'newer' }
  | { kind: 'unreadable'; code: string | undefined };

type ProducerWatermarks = WorkerTerminalRecordOpenResult['producerWatermarks'];

type ReadAdmission = 'allowed' | 'unavailable' | 'denied';

interface AuthorityAdmission {
  readonly scope: ScopeState;
  readonly epoch: number;
}

interface HistorySeedLease {
  readonly scope: ScopeState;
  readonly epoch: number;
  readonly revision: number;
  holders: number;
  revoked: boolean;
  preparation?: Promise<void>;
  entry?: PersistedTerminalEntry;
}

interface TerminalHistoryRead {
  scrollbackLines: string[];
  producerWatermarks: ProducerWatermarks;
}

interface IndexEntry {
  revision: number;
  session: TerminalSession;
  exitCode: number | null;
  signal: string | null;
}

/** What one load served a drawer, and what it was shown since. */
interface ServedView {
  /** The load could not read the record: it saw only part of it. */
  readonly partial: boolean;
  readonly seen: Set<string>;
  /**
   * Names actually served or set by this view. A partial load may serve a
   * live session without its record name; that is not a known unnamed session.
   */
  readonly named: Set<string>;
  /** The collapse this view last showed or saved: a save changes it only if it differs. */
  drawerCollapsed: boolean;
}

interface ScopeState {
  readonly lifetimeId: string;
  metadataAdmission: DirectoryEffectAdmission;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly key: string;
  /** The record as last opened, plus every op since: no output. */
  shadow: TerminalRecordPayloadState;
  lineage: string | null;
  /** The record generation this lifetime last saw; `null` until it sees one. */
  generation: number | null;
  /**
   * This lifetime's worktree incarnation: `undefined` until looked up, `null`
   * when unknown. Kept on the scope, so a lookup that settles after a
   * retirement never seeds the next lifetime.
   */
  incarnation: string | null | undefined;
  presentation: TerminalPresentationFile | undefined;
  presentationInstalled: string | undefined;
  presentationDirty: boolean;
  presentationDamaged: boolean;
  /** False while the presentation on disk must be left as it is. */
  presentationWritable: boolean;
  presentationLoaded: boolean;
  presentationRead: Promise<void> | undefined;
  presentationEpoch: number;
  loadRevision: number;
  authorityRevision: number;
  mutationRevision: number;
  /**
   * Every terminal id this run showed for this worktree (§0.7): what a load
   * served and what a save referenced. A save ungroups only these when it
   * omits them, as main's cache did.
   */
  readonly servedIds: Set<string>;
  /**
   * Each load's view, by the token it returned, least recently used first:
   * a save ungroups only what its own view was shown (R5-F1).
   */
  readonly views: Map<string, ServedView>;
  /**
   * What every partial view was shown, for a save without a token; `null`
   * until a load could not read the record. Never reset this run: such a
   * save may come from any of those views.
   */
  partialFloor: Set<string> | null;
  /** Forgotten live terminals, kept out until a layout references them. */
  readonly suppressed: Set<string>;
  /**
   * The group a newly registered shell or focused script made active, until
   * a save from the drawer chooses (as main's layout did).
   */
  activation: string | null;
  pending: WorkerTerminalRecordOp[];
  inflight: TerminalRecordOutboxEntry | null;
  /** Receipts retained until each concurrent load has rebased its snapshot. */
  readonly loadReceipts: Set<TerminalRecordOutboxEntry[]>;
  /** A flush is deciding where the next batch goes; seqs stay in order. */
  flushing: boolean;
  /** The latest flush, settled or not. */
  flushRun: Promise<void> | undefined;
  /** Its `apply` and `open` calls not settled yet: a retirement waits for them. */
  readonly sends: Set<Promise<unknown>>;
  timer: ReturnType<typeof setTimeout> | undefined;
  draining: Promise<void> | undefined;
  /** Whether this run already wrote or confirmed the legacy fence. */
  fenced: boolean;
  /**
   * The last open lacked an import receipt: nothing is fenced and the
   * layout file is not written until it is (CAN-7051 F3).
   */
  importPending: boolean;
  /** Import has not composed the legacy bytes, rather than just awaiting sync. */
  legacyImportPending: boolean;
}

const WORKTREE_WRITE_DEBOUNCE_MS = 100;
const LOAD_DRAIN_BOUND_MS = DIRECTORY_EFFECT_DRAIN_BOUND_MS;
const INCARNATION_LOOKUP_BOUND_MS = 1_000;
const DRAIN_INTERVAL_MS = 30_000;
// The longest a send that never settles holds a retirement and the drains behind it.
const RETIREMENT_BARRIER_BOUND_MS = 10_000;
// Views kept per worktree; a save from an evicted one forgets nothing.
const SERVED_VIEW_LIMIT = 64;
const PRODUCER_ID = 'electron_main';

function producerWatermarkKey(runId: string): string {
  return `${PRODUCER_ID}/${runId.replace(/%/g, '%25').replace(/\//g, '%2F')}`;
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

/** A daemon call's typed failure kind, such as `invalid_argument`. */
function errorKind(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const payload: unknown = Reflect.get(error, 'payload');
  if (payload === null || typeof payload !== 'object') return undefined;
  const kind: unknown = Reflect.get(payload, 'kind');
  return typeof kind === 'string' ? kind : undefined;
}

/** A split batch part's producer run id, within the protocol's id length. */
function derivedRunId(id: string): string {
  return id.length <= 256
    ? id
    : `split-${createHash('sha256').update(id).digest('hex')}`;
}

async function readFileIfPresent(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function readPresentationFile(
  filePath: string,
): Promise<PresentationRead> {
  let bytes: Buffer | null;
  try {
    bytes = await readFileIfPresent(filePath);
  } catch (error) {
    return { kind: 'unreadable', code: errorCode(error) };
  }
  if (bytes === null) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { kind: 'damaged' };
  }
  if (!isRecord(parsed) || typeof parsed.version !== 'number')
    return { kind: 'damaged' };
  if (parsed.version > 1) return { kind: 'newer' };
  return isPresentationFile(parsed)
    ? { kind: 'readable', value: parsed }
    : { kind: 'damaged' };
}

/**
 * Keeps a damaged file's bytes beside it, with at most the newest five such
 * copies; false when it could not be moved.
 */
function setAsideDamagedStateFile(filePath: string): boolean {
  const asidePath = damagedCopyPath(filePath);
  try {
    renameSync(filePath, asidePath);
  } catch (error) {
    logMainProcessWarn('Failed to set aside damaged terminal state', {
      code: errorCode(error),
    });
    return false;
  }
  pruneDamagedCopiesSync(filePath);
  logMainProcessWarn('Set aside damaged terminal state', { asidePath });
  return true;
}

function emptyPayload(): TerminalRecordPayloadState {
  return { bindings: [], terminals: [], terminalCustomNames: {} };
}

function hasGroupForTerminal(
  groups: TerminalGroup[],
  terminalId: string,
): boolean {
  return groups.some((group) => group.terminalIds.includes(terminalId));
}

function buildSyntheticGroup(
  state: PersistedWorktreeTerminalStateFile,
  terminalId: string,
): TerminalGroup {
  // The group the record gives a live terminal of its own (`liveBinding`).
  const groupId = liveBinding(
    {
      bindings: state.groups.map((group) => ({
        key: group.id,
        groupId: group.id,
        members: [],
      })),
    },
    terminalId,
  ).groupId;
  const ordinal = state.nextGroupOrdinal;
  state.nextGroupOrdinal = ordinal + 1;
  state.groupOrdinals[groupId] = ordinal;
  return {
    id: groupId,
    terminalIds: [terminalId],
    focusedTerminalId: terminalId,
    splitSizes: [1],
  };
}

/**
 * Main's legacy state with a pending record laid over it, as the
 * authority's import will compose them, under the legacy lineage.
 */
function withLegacyUnderneath(
  legacy: TerminalWorkerFile,
  record: TerminalWorkerFile,
): TerminalWorkerFile {
  return { ...legacy, ...mergePendingRecord(legacy, record) };
}

function shouldActivateSyntheticGroup(session: TerminalSession): boolean {
  return session.kind !== 'script' || session.focusOnSpawn === true;
}

/**
 * Bounds output retention and coalesces safe unattempted metadata only.
 * q-51 accepts O(N) custody per distinct membership transition/barrier and
 * O(R) per retained lifetime, not per edit/output. Authority-side net-state
 * layout operations follow up in CAN-7664; never evict custody or refuse edits.
 */
export function enqueueTerminalRecordOp(
  ops: WorkerTerminalRecordOp[],
  op: WorkerTerminalRecordOp,
): void {
  if (op.op === 'layout.save' || op.op === 'rename') {
    for (let index = ops.length - 1; index >= 0; index -= 1) {
      const previous = ops[index];
      if (previous.op === 'forget' || previous.op === 'session.upsert') break;
      if (previous.op === 'layout.save') {
        if (op.op !== 'layout.save') break;
        // Do not collapse membership transitions against an unknown base:
        // intermediate key collisions can remove unseen authority members.
        if (
          JSON.stringify(previous.bindings) !== JSON.stringify(op.bindings) ||
          JSON.stringify([...previous.servedIds].sort()) !==
            JSON.stringify([...op.servedIds].sort()) ||
          JSON.stringify([...previous.referencedIds].sort()) !==
            JSON.stringify([...op.referencedIds].sort())
        )
          break;
        ops.splice(index, 1);
      } else if (
        op.op === 'rename' &&
        previous.op === 'rename' &&
        previous.terminalId === op.terminalId
      ) {
        ops.splice(index, 1);
      }
    }
  }
  if (op.op !== 'output.append') {
    // A replacement or forget supersedes all unattempted output of that
    // history, even across metadata changes and split outbox entries.
    // Keep the membership operations.
    const supersededOutput =
      op.op === 'forget' || op.op === 'output.replace'
        ? new Set([op.terminalId])
        : op.op === 'layout.save'
          ? new Set(op.servedIds.filter((id) => !op.referencedIds.includes(id)))
          : new Set<string>();
    if (supersededOutput.size > 0)
      for (let index = ops.length - 1; index >= 0; index -= 1) {
        const previous = ops[index];
        if (
          (previous.op === 'output.append' ||
            previous.op === 'output.replace') &&
          supersededOutput.has(previous.terminalId)
        )
          ops.splice(index, 1);
      }
    ops.push(op);
    return;
  }
  const indices: number[] = [];
  let text = op.text;
  let replacement = false;
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const earlier = ops[index];
    if (
      earlier.op === 'layout.save' &&
      earlier.servedIds.includes(op.terminalId) &&
      !earlier.referencedIds.includes(op.terminalId)
    )
      break;
    if (!('terminalId' in earlier) || earlier.terminalId !== op.terminalId)
      continue;
    if (earlier.op === 'forget') break;
    // Rename, exit, upsert and non-forgetting layouts preserve history.
    if (earlier.op !== 'output.append' && earlier.op !== 'output.replace')
      continue;
    indices.push(index);
    if (!replacement)
      text = `${earlier.op === 'output.append' ? earlier.text : earlier.lines.join('\n')}${text}`;
    if (earlier.op === 'output.replace') {
      replacement = true;
    }
  }
  // Trimming one long line does not supersede older lines in the record.
  const lines = text
    .split('\n')
    .map((line) => retainScrollbackLines([line])[0]);
  const retained = retainScrollbackLines(lines);
  replacement ||=
    lines.length > TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES ||
    Buffer.byteLength(lines.join('\n')) >
      WORKER_TERMINAL_RECORD_HISTORY_MAX_BYTES;
  for (const index of indices) ops.splice(index, 1);
  if (replacement) {
    ops.push({
      op: 'output.replace',
      terminalId: op.terminalId,
      lines: retained,
    });
    return;
  }
  text = retained.join('\n');
  for (let start = 0; start < text.length; ) {
    let end = Math.min(
      text.length,
      start + WORKER_TERMINAL_RECORD_TEXT_MAX_CHARS,
    );
    // Byte retention must never see half a pair as a complete wire chunk.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    ops.push({
      op: 'output.append',
      terminalId: op.terminalId,
      text: text.slice(start, end),
    });
    start = end;
  }
}

// Keeps an `apply` under the daemon's 8 MiB frame, and each outbox line short.
const APPLY_MAX_ESTIMATED_BYTES = 6 * 1024 * 1024;
// JSON encodes one UTF-16 unit in at most six bytes (`\u001b`).
const JSON_UNIT_MAX_BYTES = 6;

/** An upper bound on an op's JSON size, without encoding its output. */
function estimatedOpBytes(op: WorkerTerminalRecordOp): number {
  if (op.op === 'output.append')
    return 64 + JSON_UNIT_MAX_BYTES * (op.terminalId.length + op.text.length);
  if (op.op === 'output.replace')
    return op.lines.reduce(
      (bytes, line) => bytes + 3 + JSON_UNIT_MAX_BYTES * line.length,
      64 + JSON_UNIT_MAX_BYTES * op.terminalId.length,
    );
  return Buffer.byteLength(JSON.stringify(op));
}

/**
 * How many ops from `start` one `apply` carries: within its op count and
 * estimated bytes, and at least one. The same ops always split the same way,
 * so a batch with an unknown outcome is never split again.
 */
function applyBatchLength(
  ops: readonly WorkerTerminalRecordOp[],
  start: number,
  maxBytes: number,
): number {
  let count = 0;
  let bytes = 0;
  while (start + count < ops.length && count < WORKER_TERMINAL_RECORD_MAX_OPS) {
    bytes += estimatedOpBytes(ops[start + count]);
    if (count > 0 && bytes > maxBytes) break;
    count += 1;
  }
  return Math.max(count, 1);
}

function serializeResponse(
  state: PersistedWorktreeTerminalStateFile,
  liveTerminalIds: string[],
  history: TerminalRecordHistoryStatus,
  historyHeld: boolean,
  viewToken: string,
): LoadWorktreeTerminalStateResponse {
  return {
    drawerCollapsed: state.drawerCollapsed,
    groups: state.groups.map((group) => ({
      id: group.id,
      terminalIds: [...group.terminalIds],
      focusedTerminalId: group.focusedTerminalId,
      splitSizes: [...group.splitSizes],
    })),
    activeGroupId: state.activeGroupId,
    nextGroupOrdinal: state.nextGroupOrdinal,
    groupOrdinals: { ...state.groupOrdinals },
    terminalCustomNames: { ...state.terminalCustomNames },
    groupCustomNames: { ...state.groupCustomNames },
    terminals: state.terminals.map((entry) => ({
      session: entry.session,
      scrollbackLines: [...entry.scrollbackLines],
      exitCode: entry.exitCode,
      signal: entry.signal,
    })),
    liveTerminalIds,
    history,
    ...(historyHeld && { historyHeld }),
    viewToken,
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface TerminalPersistenceStoreOptions {
  readonly records?: TerminalRecordClientPort;
  /** Main's own data root, never the identity-pinned one. */
  readonly outboxRoot?: () => string;
  readonly outbox?: TerminalRecordOutbox;
  /** The worktree's incarnation (its creation time); `null` when unknown. */
  readonly incarnation?: (
    projectId: string,
    worktreeId: string,
  ) => Promise<string | null>;
  /** How long attribution or replay waits for a worktree identity lookup. */
  readonly incarnationLookupBoundMs?: number;
  /** Read admission only; never gates shell creation or cleanup. */
  readonly scopeExists?: (
    projectId: string,
    worktreeId: string,
  ) => Promise<boolean | null>;
  /** How long a retirement waits for its lifetimes' sends in flight. */
  readonly retirementBarrierBoundMs?: number;
  /** Estimated JSON bytes one `apply`, and so one outbox line, carries. */
  readonly applyBatchMaxBytes?: number;
}

/**
 * A worktree's creation time, which tells a reused worktree id's new
 * worktree from the old one (CAN-7051 §5.12), as the cost index reads it.
 */
export function worktreeIncarnation(
  projectId: string,
  worktreeId: string,
): Promise<string | null> {
  return withTimeout(
    readWorktreeIncarnation(projectId, worktreeId),
    INCARNATION_LOOKUP_BOUND_MS,
  );
}

/** Null means inconclusive, not authoritative absence. */
export function terminalWorktreeExists(
  projectId: string,
  worktreeId: string,
): Promise<boolean | null> {
  return withTimeout(
    readTerminalWorktreeExists(projectId, worktreeId),
    INCARNATION_LOOKUP_BOUND_MS,
  );
}

async function readTerminalWorktreeExists(
  projectId: string,
  worktreeId: string,
): Promise<boolean | null> {
  const { readWorkspaceWorktreesDetailed } =
    await import('../lib/workspace-persistence');
  const list = await readWorkspaceWorktreesDetailed(projectId);
  if (list.worktrees.some((entry) => entry.id === worktreeId)) return true;
  if (list.authority !== 'ok' && list.authority !== 'absent') return null;
  const { readWorkEntriesFile } =
    await import('../lib/cowork-work-entries-file');
  try {
    return (
      await readWorkEntriesFile(projectId, { strict: true })
    ).entries.some((entry) => entry.id === worktreeId);
  } catch {
    return null;
  }
}

async function readWorktreeIncarnation(
  projectId: string,
  worktreeId: string,
): Promise<string | null> {
  const { getWorkspaceWorktreeCreatedAt } =
    await import('../lib/workspace-persistence');
  const { readWorkEntriesFile } =
    await import('../lib/cowork-work-entries-file');
  const createdAt =
    (await getWorkspaceWorktreeCreatedAt(projectId, worktreeId)) ??
    (await readWorkEntriesFile(projectId)).entries.find(
      (entry) => entry.id === worktreeId,
    )?.createdAt;
  return typeof createdAt === 'string' ? createdAt : null;
}

function decoderKey(scopeKey: string, terminalId: string): string {
  return `${scopeKey}\u0000${terminalId}`;
}

export class TerminalPersistenceStore implements TerminalPersistencePort {
  private readonly scopes = new Map<string, ScopeState>();

  private readonly liveSessions = new Map<string, TerminalSession>();

  /** Per worktree and terminal: ids are unique only within a worktree. */
  private readonly decoders = new Map<string, StringDecoder>();

  /**
   * Each worktree's last batch seq this run. It outlives a retirement, so a
   * reused worktree's batches never repeat a seq the old record holds.
   */
  private readonly seqs = new Map<string, number>();

  /** Metadata of every terminal a load or a live session made known (§5.9). */
  private readonly index = new Map<string, IndexEntry>();
  private nextIndexRevision = 0;

  /** Entries prefetched for one synchronous engine restore or replay. */
  private readonly seeded = new Map<string, HistorySeedLease>();

  private producerRunId: string | undefined;

  private get runId(): string {
    return (this.producerRunId ??= randomUUID());
  }

  /** Live daemon terminals the worker's record keeps (CAN-7051). */
  private readonly recordedIds = new Set<string>();

  private readonly records: TerminalRecordClientPort;

  private readonly outbox: TerminalRecordOutbox | null;

  private outboxWarning = false;

  /** The outbox in memory holds batches its file does not yet. */
  private outboxDirty = false;
  private outboxWriteRevision = 0;

  /** Worktrees and projects retired this run: late writes are dropped. */
  private readonly retiredScopes = new Set<string>();

  private readonly retiredProjects = new Set<string>();

  /** Only exact, installed mappings on current queue objects may issue. */
  private readonly installedBatches = new WeakMap<
    TerminalRecordOutboxEntry,
    TerminalRecordOutboxEntry & { client: WorkerTerminalRecordClient }
  >();
  private readonly readRevisions = new Map<string, number>();
  private readonly metadataWrites = new Map<string, Promise<void>>();

  /** Worktrees of a retired project that a new lifetime started in again. */
  private readonly revivedScopes = new Set<string>();

  private readonly warningListeners = new Set<(warning: boolean) => void>();

  private drainTimer: ReturnType<typeof setInterval> | undefined;

  private retirementsDraining: Promise<void> | undefined;

  /**
   * Per retirement of this run, the sends of the lifetimes it detached that
   * were still in flight: it reaches the authority only after them, so a
   * late one without a generation never recreates the record it retires.
   * The wait is bounded (`waitForRetirementBarrier`).
   */
  private readonly retirementBarriers = new WeakMap<
    WorkerTerminalRecordRetireParams,
    Promise<true>
  >();

  private sealed: string | null = null;

  /**
   * Every queued batch and retirement; the outbox file mirrors it, with the
   * run's start time, which orders a run's own file among runs' (R5-F2).
   */
  private readonly outboxState: TerminalRecordOutboxFile =
    emptyTerminalRecordOutbox(Date.now());

  /**
   * Earlier runs' outbox, merged in before this run's first outbox write or
   * drain, so neither overwrites nor overtakes it.
   */
  private started: Promise<void> | undefined;

  private earlierMerged = false;

  /** `null` for the shared outbox file, else this run's own file. */
  private outboxFile: string | null = null;

  /** Earlier runs' own files, discarded once the shared file holds them. */
  private mergedRunFiles: string[] = [];

  private outboxWrites: Promise<void> = Promise.resolve();

  private scopeExists: TerminalPersistenceStoreOptions['scopeExists'];

  public constructor(
    private readonly options: TerminalPersistenceStoreOptions = {},
  ) {
    this.scopeExists = options.scopeExists;
    this.records = options.records ?? daemonTerminalRecordClient;
    this.outbox =
      options.outbox ??
      (options.outboxRoot
        ? new TerminalRecordOutbox(options.outboxRoot)
        : null);
  }

  // -----------------------------------------------------------------------
  // Scopes
  // -----------------------------------------------------------------------

  /** The record client of a worktree, for daemon terminals' attribution. */
  public async recordClientFor(
    projectId: string,
    worktreeId: string,
  ): Promise<WorkerTerminalRecordClient> {
    const scope = this.scope(projectId, worktreeId);
    const admission = await this.authorityAdmission(scope);
    if (!admission) throw new TerminalRecordAdmissionDeferred();
    await this.resolveIncarnation(scope);
    if (!this.admissionCurrent(admission))
      throw new TerminalRecordAdmissionDeferred();
    return this.clientFor(scope);
  }

  /** Looks a lifetime's incarnation up once; unknown stays `null`. */
  private async resolveIncarnation(scope: ScopeState): Promise<void> {
    if (scope.incarnation !== undefined) return;
    if (!this.options.incarnation) {
      scope.incarnation = null;
      return;
    }
    let incarnation: string | null = null;
    try {
      // Unknown identity must not wedge attribution, flushes or later drains.
      incarnation = await withTimeout(
        this.options.incarnation(scope.projectId, scope.worktreeId),
        this.options.incarnationLookupBoundMs ?? INCARNATION_LOOKUP_BOUND_MS,
      );
    } catch {
      // Unknown: a null incarnation never retires a record.
    }
    if (scope.incarnation === undefined) scope.incarnation = incarnation;
  }

  /**
   * The client of one lifetime, from its own scope only: its incarnation
   * once resolved (else `null`) and, unless left out, the generation it
   * last saw, so the authority orders its requests (CAN-7051 §5.7).
   */
  private clientFor(
    scope: Pick<
      ScopeState,
      'projectId' | 'worktreeId' | 'incarnation' | 'generation' | 'lifetimeId'
    >,
    withGeneration = true,
  ): WorkerTerminalRecordClient {
    let legacyLayout: WorkerTerminalRecordClient['legacyLayout'] = 'workspaces';
    try {
      legacyLayout = getWorktreeTerminalLegacyLayout(scope.projectId);
    } catch {
      // An unregistered scope keeps the default layout.
    }
    return {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      legacyLayout,
      lifetimeId: scope.lifetimeId,
      incarnation: scope.incarnation ?? null,
      ...(withGeneration &&
        scope.generation !== null && { generation: scope.generation }),
    };
  }

  /**
   * Whether this scope is still its worktree's current lifetime. A scope a
   * retirement detached never sends, queues or installs again.
   */
  private owns(scope: ScopeState): boolean {
    return this.scopes.get(scope.key) === scope;
  }

  private scope(projectId: string, worktreeId: string): ScopeState {
    const key = worktreeKey(projectId, worktreeId);
    const existing = this.scopes.get(key);
    if (existing) return existing;
    const lifetimeId = randomUUID();
    const created: ScopeState = {
      lifetimeId,
      metadataAdmission: captureDirectoryEffects(
        dirname(getWorktreeTerminalPresentationFilePath(projectId, worktreeId)),
      ),
      projectId,
      worktreeId,
      key,
      shadow: emptyPayload(),
      lineage: null,
      generation: null,
      incarnation: undefined,
      presentation: undefined,
      presentationInstalled: undefined,
      presentationDirty: false,
      presentationDamaged: false,
      presentationWritable: true,
      presentationLoaded: false,
      presentationRead: undefined,
      presentationEpoch: 0,
      loadRevision: 0,
      authorityRevision: 0,
      mutationRevision: 0,
      servedIds: new Set(),
      views: new Map(),
      partialFloor: null,
      suppressed: new Set(),
      activation: null,
      pending: [],
      inflight: null,
      loadReceipts: new Set(),
      flushing: false,
      flushRun: undefined,
      sends: new Set(),
      timer: undefined,
      draining: undefined,
      fenced: false,
      importPending: false,
      legacyImportPending: false,
    };
    this.scopes.set(key, created);
    return created;
  }

  /** A save after a deletion installs only once its worktree is confirmed. */
  private readmitMetadataLater(scope: ScopeState): void {
    const revoked = scope.metadataAdmission;
    if (directoryEffectsAdmitted(revoked)) return;
    const candidate = captureDirectoryEffects(revoked.directory);
    if (!directoryEffectsAdmitted(candidate)) return;
    if (!this.scopeExists) {
      scope.metadataAdmission = candidate;
      return;
    }
    void this.scopeExists(scope.projectId, scope.worktreeId)
      .then((exists) => {
        if (
          exists !== true ||
          !this.owns(scope) ||
          scope.metadataAdmission !== revoked ||
          !directoryEffectsAdmitted(candidate)
        )
          return;
        scope.metadataAdmission = candidate;
        this.installPresentation(scope);
      })
      .catch(() => undefined);
  }

  private loadPresentation(scope: ScopeState): Promise<void> {
    if (scope.presentationLoaded) return Promise.resolve();
    if (scope.presentationRead) return scope.presentationRead;
    const epoch = scope.presentationEpoch;
    const run = this.classifyPresentation(scope, epoch);
    scope.presentationRead = run;
    void run
      .finally(() => {
        if (scope.presentationRead === run) scope.presentationRead = undefined;
      })
      .catch(() => undefined);
    return run;
  }

  private async classifyPresentation(
    scope: ScopeState,
    epoch: number,
  ): Promise<void> {
    const admission = scope.metadataAdmission;
    const read = await readPresentationFile(
      getWorktreeTerminalPresentationFilePath(
        scope.projectId,
        scope.worktreeId,
      ),
    );
    if (
      !this.owns(scope) ||
      scope.presentationEpoch !== epoch ||
      !directoryEffectsAdmitted(admission)
    )
      return;
    if (read.kind === 'readable') {
      scope.presentation ??= read.value;
      scope.presentationInstalled = JSON.stringify(read.value, null, 2);
    } else if (read.kind === 'damaged') scope.presentationDamaged = true;
    else if (read.kind === 'newer' || read.kind === 'unreadable') {
      scope.presentationWritable = false;
      logMainProcessWarn(
        'Leaving terminal presentation unchanged this session',
        {
          reason: read.kind,
        },
      );
    }
    scope.presentationLoaded = true;
    this.installPresentation(scope);
  }

  // -----------------------------------------------------------------------
  // The producer: TerminalPersistencePort for in-process terminals
  // -----------------------------------------------------------------------

  /** Records what a load served, and returns the token its saves carry. */
  private openView(
    scope: ScopeState,
    partial: boolean,
    served: readonly string[],
    named: readonly string[],
    drawerCollapsed: boolean,
  ): string {
    const token = randomUUID();
    scope.views.set(token, {
      partial,
      seen: new Set(served),
      named: new Set(named),
      drawerCollapsed,
    });
    // Partial views go first: a history retry opens one per try, and must
    // not evict the full views of drawers that loaded once.
    while (scope.views.size > SERVED_VIEW_LIMIT) {
      const views = Array.from(scope.views);
      const [stale] =
        views.find(([key, view]) => view.partial && key !== token) ?? views[0];
      scope.views.delete(stale);
    }
    if (partial) {
      const floor = scope.partialFloor;
      scope.partialFloor =
        floor === null
          ? new Set(served)
          : new Set(served.filter((terminalId) => floor.has(terminalId)));
    }
    return token;
  }

  /**
   * The view a save was made from, most recently used again; `null` for a
   * save without a token, `undefined` for a token this lifetime never served.
   */
  private viewFor(
    scope: ScopeState,
    token: unknown,
  ): ServedView | null | undefined {
    if (typeof token !== 'string') return null;
    const view = scope.views.get(token);
    if (!view) return undefined;
    scope.views.delete(token);
    scope.views.set(token, view);
    return view;
  }

  private enqueue(scope: ScopeState, op: WorkerTerminalRecordOp): void {
    if (this.sealed !== null || !this.owns(scope)) return;
    scope.mutationRevision += 1;
    applyTerminalRecordOp(scope.shadow, stripOutput(op));
    enqueueTerminalRecordOp(scope.pending, op);
    this.scheduleFlush(scope);
  }

  private isRetired(projectId: string, worktreeId: string): boolean {
    const key = worktreeKey(projectId, worktreeId);
    return (
      this.retiredScopes.has(key) ||
      (this.retiredProjects.has(projectId) && !this.revivedScopes.has(key))
    );
  }

  /** A new lifetime in a retired worktree starts its record afresh. */
  private revive(projectId: string, worktreeId: string): void {
    const key = worktreeKey(projectId, worktreeId);
    this.retiredScopes.delete(key);
    if (this.retiredProjects.has(projectId)) this.revivedScopes.add(key);
  }

  private scheduleFlush(scope: ScopeState): void {
    if (scope.timer !== undefined) return;
    scope.timer = setTimeout(() => {
      scope.timer = undefined;
      void this.flushScope(scope);
    }, WORKTREE_WRITE_DEBOUNCE_MS);
  }

  public registerLiveSession(session: TerminalSession): void {
    if (!isDrawerOwnedTerminal(session)) return;
    this.revive(session.projectId, session.worktreeId);
    this.revokeSeed(session.id);
    this.liveSessions.set(session.id, session);
    const scope = this.scope(session.projectId, session.worktreeId);
    scope.metadataAdmission = captureDirectoryEffects(
      dirname(
        getWorktreeTerminalPresentationFilePath(
          session.projectId,
          session.worktreeId,
        ),
      ),
    );
    if (scope.suppressed.has(session.id)) return;
    this.index.set(session.id, {
      revision: ++this.nextIndexRevision,
      session,
      exitCode: null,
      signal: null,
    });
    const grouped = scope.shadow.bindings.some((binding) =>
      binding.members.some((member) => member.terminalId === session.id),
    );
    this.enqueue(scope, { op: 'session.upsert', session });
    if (grouped || !shouldActivateSyntheticGroup(session)) return;
    // A new shell, or a script that asked for focus, becomes the active
    // group; a background script never does.
    const binding = scope.shadow.bindings.find((candidate) =>
      candidate.members.some((member) => member.terminalId === session.id),
    );
    if (!binding) return;
    scope.activation = binding.groupId;
    if (scope.presentation && scope.lineage === scope.presentation.lineage) {
      scope.presentation = {
        ...scope.presentation,
        activeGroupId: binding.groupId,
      };
      scope.presentationDirty = true;
    }
  }

  /** Non-drawer output and exits must never enter the durable outbox. */
  private recordsTerminal(terminalId: string): boolean {
    if (this.isRecordedDaemonTerminal(terminalId)) return false;
    const session =
      this.liveSessions.get(terminalId) ?? this.index.get(terminalId)?.session;
    return session !== undefined && isDrawerOwnedTerminal(session);
  }

  public appendTerminalOutput(
    projectId: string,
    worktreeId: string,
    terminalId: string,
    chunk: Buffer,
  ): void {
    if (!this.recordsTerminal(terminalId)) return;
    if (this.isRetired(projectId, worktreeId)) return;
    const scope = this.scope(projectId, worktreeId);
    if (scope.suppressed.has(terminalId)) return;
    const key = decoderKey(scope.key, terminalId);
    let decoder = this.decoders.get(key);
    if (!decoder) {
      decoder = new StringDecoder('utf8');
      this.decoders.set(key, decoder);
    }
    const text = decoder.write(chunk);
    if (text.length === 0) return;
    this.enqueue(scope, { op: 'output.append', terminalId, text });
  }

  public markTerminalExited(
    projectId: string,
    worktreeId: string,
    terminalId: string,
    exitCode: number | null,
    signal: string | null,
  ): void {
    const recorded = this.recordsTerminal(terminalId);
    this.liveSessions.delete(terminalId);
    const key = decoderKey(worktreeKey(projectId, worktreeId), terminalId);
    const trailing = this.decoders.get(key)?.end() ?? '';
    this.decoders.delete(key);
    // A cleaned-up worktree's late exit never recreates its record.
    if (!recorded || this.isRetired(projectId, worktreeId)) return;
    const scope = this.scope(projectId, worktreeId);
    const indexed = this.index.get(terminalId);
    if (indexed && !isShutdown(indexed.signal)) {
      indexed.exitCode = exitCode;
      indexed.signal = signal;
    }
    // Exit ends a forgotten lifetime's suppression without resurrecting it.
    if (scope.suppressed.delete(terminalId)) return;
    if (trailing.length > 0)
      this.enqueue(scope, { op: 'output.append', terminalId, text: trailing });
    this.enqueue(scope, { op: 'exit', terminalId, exitCode, signal });
  }

  /** Seeded only around a synchronous restore or replay (§5.9). */
  public getPersistedTerminalEntry(
    terminalId: string,
  ): PersistedTerminalEntry | null {
    const lease = this.seeded.get(terminalId);
    const seeded =
      lease && this.seedCurrent(terminalId, lease) ? lease.entry : undefined;
    return seeded
      ? {
          session: seeded.session,
          scrollbackLines: [...seeded.scrollbackLines],
          exitCode: seeded.exitCode,
          signal: seeded.signal,
        }
      : null;
  }

  private seedCurrent(terminalId: string, lease: HistorySeedLease): boolean {
    const indexed = this.index.get(terminalId);
    return (
      !lease.revoked &&
      this.owns(lease.scope) &&
      lease.epoch === (this.readRevisions.get(lease.scope.key) ?? 0) &&
      indexed?.revision === lease.revision &&
      indexed.session.projectId === lease.scope.projectId &&
      indexed.session.worktreeId === lease.scope.worktreeId &&
      this.canPublishRead(lease.scope, lease.epoch)
    );
  }

  private revokeSeed(terminalId: string): void {
    const lease = this.seeded.get(terminalId);
    if (lease) lease.revoked = true;
    this.seeded.delete(terminalId);
  }

  /**
   * The port of daemon terminals the worker's record keeps (CAN-7051): it
   * tracks their live sessions for loads and writes nothing (q-28 (4)).
   */
  public readonly recordedTerminals: TerminalPersistencePort = {
    registerLiveSession: (session) => {
      this.revokeSeed(session.id);
      this.recordedIds.add(session.id);
      this.liveSessions.set(session.id, session);
      if (!isDrawerOwnedTerminal(session)) return;
      this.index.set(session.id, {
        revision: ++this.nextIndexRevision,
        session,
        exitCode: null,
        signal: null,
      });
      // Shown, and so forgettable, once a load serves it or a save
      // references it (§0.7); its host keeps its record meanwhile.
      this.scope(session.projectId, session.worktreeId);
    },
    appendTerminalOutput: () => undefined,
    markTerminalExited: (
      _projectId,
      _worktreeId,
      terminalId,
      exitCode,
      signal,
    ) => {
      this.recordedIds.delete(terminalId);
      this.liveSessions.delete(terminalId);
      const indexed = this.index.get(terminalId);
      if (indexed && !isShutdown(indexed.signal)) {
        indexed.exitCode = exitCode;
        indexed.signal = signal;
      }
    },
    getPersistedTerminalEntry: (terminalId) =>
      this.getPersistedTerminalEntry(terminalId),
  };

  // -----------------------------------------------------------------------
  // Sending, the outbox and its drain (§5.5–5.7)
  // -----------------------------------------------------------------------

  /** A send of this lifetime, kept until it settles (see `retirementBarriers`). */
  private track<T>(scope: ScopeState, send: Promise<T>): Promise<T> {
    scope.sends.add(send);
    const settled = (): void => {
      scope.sends.delete(send);
    };
    send.then(settled, settled);
    return send;
  }

  private nextSeq(scope: ScopeState): number {
    const seq = (this.seqs.get(scope.key) ?? 0) + 1;
    this.seqs.set(scope.key, seq);
    return seq;
  }

  private applyBatchLength(
    ops: readonly WorkerTerminalRecordOp[],
    start = 0,
  ): number {
    return applyBatchLength(
      ops,
      start,
      this.options.applyBatchMaxBytes ?? APPLY_MAX_ESTIMATED_BYTES,
    );
  }

  private takeBatch(scope: ScopeState): TerminalRecordOutboxEntry | null {
    if (scope.pending.length === 0) return null;
    const ops = scope.pending.splice(0, this.applyBatchLength(scope.pending));
    if (scope.pending.length > 0) this.scheduleFlush(scope);
    return {
      seq: this.nextSeq(scope),
      runId: this.runId,
      client: this.clientFor(scope),
      ...(scope.generation !== null && { generation: scope.generation }),
      ops,
    };
  }

  /**
   * The worktree's queued batches, in the order they go out: one outbox per
   * run of batches under one client incarnation, so none is ever sent under
   * another's. The outbox file's state is their one owner: no worktree keeps
   * a reference that a drain or a retirement could leave detached from it
   * (memory only).
   */
  private queuedOutboxes(
    scope: Pick<ScopeState, 'projectId' | 'worktreeId'>,
  ): TerminalRecordScopeOutbox[] {
    return this.outboxState.scopes.filter(
      ({ client }) =>
        client.projectId === scope.projectId &&
        client.worktreeId === scope.worktreeId,
    );
  }

  private queuedEntries(scope: ScopeState): TerminalRecordOutboxEntry[] {
    return this.queuedOutboxes(scope).flatMap(({ entries }) => entries);
  }

  private replayEntries(scope: ScopeState): TerminalRecordOutboxEntry[] {
    return this.queuedOutboxes(scope).flatMap(({ client, entries }) =>
      entries.filter((entry) => this.canReplay(scope, entry.client ?? client)),
    );
  }

  /**
   * Only this lifetime's own batches replay. An earlier lifetime's stay
   * durable in custody, never sent or overlaid: they leak rather than block.
   */
  private canReplay(
    scope: ScopeState,
    client: WorkerTerminalRecordClient,
  ): boolean {
    return client.lifetimeId === scope.lifetimeId;
  }

  private async readAdmission(scope: ScopeState): Promise<ReadAdmission> {
    if (!this.owns(scope)) return 'denied';
    try {
      const exists = this.scopeExists
        ? await this.scopeExists(scope.projectId, scope.worktreeId)
        : true;
      if (exists === false || !this.owns(scope)) return 'denied';
      if (exists === null) return 'unavailable';
      await withTimeout(this.whenStarted(), LOAD_DRAIN_BOUND_MS);
      return this.owns(scope) && this.earlierMerged ? 'allowed' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  private emptyRead(
    scope: ScopeState,
    includeLive: boolean,
  ): LoadWorktreeTerminalStateResponse {
    const state = createEmptyState();
    const liveTerminalIds =
      includeLive && this.owns(scope)
        ? this.mergeLiveSessions(scope, state)
        : [];
    const viewToken = this.openView(
      scope,
      true,
      liveTerminalIds,
      [],
      state.drawerCollapsed,
    );
    return serializeResponse(
      state,
      liveTerminalIds,
      { status: 'unavailable', reason: 'background_service' },
      this.outboxWarning,
      viewToken,
    );
  }

  private canPublishRead(
    scope: ScopeState,
    revision = this.readRevisions.get(scope.key) ?? 0,
  ): boolean {
    return (
      this.owns(scope) && revision === (this.readRevisions.get(scope.key) ?? 0)
    );
  }

  private async authorityAdmission(
    scope: ScopeState,
  ): Promise<AuthorityAdmission | null> {
    const epoch = this.readRevisions.get(scope.key) ?? 0;
    const token = { scope, epoch };
    try {
      await withTimeout(this.whenStarted(), LOAD_DRAIN_BOUND_MS);
      if (!this.earlierMerged || !this.owns(scope) || this.sealed !== null)
        return null;
      if (this.retirementPending(scope))
        await withTimeout(this.drainRetirements(), LOAD_DRAIN_BOUND_MS);
      return this.admissionCurrent(token) ? token : null;
    } catch {
      return null;
    }
  }

  private admissionCurrent(token: AuthorityAdmission): boolean {
    const { scope, epoch } = token;
    return (
      this.sealed === null &&
      this.owns(scope) &&
      this.earlierMerged &&
      epoch === (this.readRevisions.get(scope.key) ?? 0) &&
      !this.retirementPending(scope)
    );
  }

  /**
   * Whether this lifetime has batches to replay. An earlier lifetime's held
   * custody is inert: it neither orders nor delays this lifetime's sends.
   */
  private hasOutbox(scope: ScopeState): boolean {
    return this.queuedOutboxes(scope).some(({ client, entries }) =>
      entries.some((entry) => this.canReplay(scope, entry.client ?? client)),
    );
  }

  /** A retirement of this worktree not applied yet: its writes queue behind it. */
  private retirementPending(
    scope: Pick<ScopeState, 'projectId' | 'worktreeId'>,
  ): boolean {
    return this.outboxState.retirements.some(
      (retirement) =>
        retirement.projectId === scope.projectId &&
        (retirement.worktreeId === undefined ||
          retirement.worktreeId === scope.worktreeId),
    );
  }

  /**
   * Checked again after every await: a retirement may have detached it
   * (R4-F2). Earlier runs' files still in custody never gate it.
   */
  private canSendOnline(scope: ScopeState): boolean {
    return (
      this.owns(scope) &&
      this.earlierMerged &&
      !this.hasOutbox(scope) &&
      !this.retirementPending(scope) &&
      !scope.inflight &&
      scope.pending.length > 0
    );
  }

  private flushScope(scope: ScopeState): Promise<void> {
    // One flush at a time per worktree, so a later batch never overtakes an
    // earlier one (its seq would raise the watermark past it).
    if (scope.inflight || scope.flushing) {
      this.scheduleFlush(scope);
      return Promise.resolve();
    }
    scope.flushing = true;
    const run = (async (): Promise<void> => {
      try {
        await this.resolveIncarnation(scope);
        // Layout lands only once its membership is applied or durably
        // queued (§5.15).
        if (await this.flushScopeOnce(scope)) {
          this.installPresentation(scope);
          await this.fenceAppliedRecord(scope);
        }
      } finally {
        scope.flushing = false;
      }
    })();
    scope.flushRun = run;
    return run;
  }

  /** True once this flush's writes are applied or durably queued. */
  private async flushScopeOnce(scope: ScopeState): Promise<boolean> {
    await this.whenStarted();
    const admission = await this.authorityAdmission(scope);
    if (
      admission &&
      this.canSendOnline(scope) &&
      (await this.records.available()) &&
      this.canSendOnline(scope) &&
      this.admissionCurrent(admission)
    ) {
      const batch = this.takeBatch(scope);
      if (!batch) return true;
      scope.inflight = batch;
      try {
        const result = await this.track(
          scope,
          this.records.apply({
            client: batch.client ?? this.clientFor(scope),
            producer: { id: PRODUCER_ID, runId: batch.runId },
            seq: batch.seq,
            ...(batch.generation !== undefined && {
              generation: batch.generation,
            }),
            ops: batch.ops,
          }),
        );
        this.acknowledgeBatch(scope, batch, result);
        return true;
      } catch (error) {
        logMainProcessWarn('Deferring terminal record writes', {
          reason: error instanceof Error ? error.name : 'error',
        });
        // An unknown outcome: the same batch under the same seq.
        return await this.toOutbox(scope, { ...batch, attempted: true });
      } finally {
        if (scope.inflight === batch) scope.inflight = null;
      }
    }
    // Unsent, so the outbox splits it into `apply` batches in one write.
    const batch = this.takeBatchAll(scope);
    const durable = batch ? await this.toOutbox(scope, batch) : true;
    // Until discovery succeeds, drainAll owns retries of unreadable sources.
    if (this.earlierMerged && this.hasOutbox(scope))
      void this.drainScope(scope);
    return durable;
  }

  /**
   * Compacts the unattempted suffix across entry boundaries, then writes
   * the outbox. Resolves true once it is durable.
   */
  private toOutbox(
    scope: ScopeState,
    batch: TerminalRecordOutboxEntry,
  ): Promise<boolean> {
    // A retired lifetime's late batch never reaches its successor's record.
    if (this.scopes.get(scope.key) !== scope) return Promise.resolve(true);
    const { entries } = this.outboxOf(scope);
    let first = entries.length;
    // An unknown outcome must retry exact bytes, never a compacted batch.
    if (!batch.attempted) {
      while (first > 0) {
        const previous = entries[first - 1];
        if (
          previous.attempted ||
          previous.sealed !== undefined ||
          previous.runId !== batch.runId ||
          previous.generation !== batch.generation ||
          previous.client?.incarnation !== batch.client?.incarnation ||
          previous.client?.generation !== batch.client?.generation ||
          previous.client?.legacyLayout !== batch.client?.legacyLayout
        )
          break;
        first -= 1;
      }
    }
    const suffix = entries.splice(first);
    if (suffix.length > 0) {
      const ops: WorkerTerminalRecordOp[] = [];
      for (const entry of [...suffix, batch])
        for (const op of entry.ops) enqueueTerminalRecordOp(ops, op);
      this.pushOutboxEntries(scope, entries, {
        ...suffix[0],
        ops,
        ...(batch.sealed && { sealed: batch.sealed }),
      });
    } else this.pushOutboxEntries(scope, entries, batch);
    this.outboxDirty = true;
    this.ensureDrainTimer();
    return this.persistOutbox();
  }

  /**
   * Appends this run's batch as entries of at most one `apply` each, in
   * order under increasing seqs; only the last carries the seal.
   */
  private pushOutboxEntries(
    scope: ScopeState,
    entries: TerminalRecordOutboxEntry[],
    batch: TerminalRecordOutboxEntry,
  ): void {
    const { sealed, attempted, ...rest } = batch;
    let start = 0;
    do {
      const end = start + this.applyBatchLength(batch.ops, start);
      const ops = batch.ops.slice(start, end);
      const first = start === 0;
      start = end;
      entries.push({
        ...rest,
        // A later chunk was never sent: a seq of its own.
        ...(first
          ? attempted !== undefined && { attempted }
          : { seq: this.nextSeq(scope) }),
        ops,
        ...(start >= batch.ops.length && sealed && { sealed }),
      });
    } while (start < batch.ops.length);
  }

  /**
   * A newer generation the authority answered with. A `dropped` answer is
   * never adopted: it names the record that replaced this lifetime's, and
   * adopting it would let this lifetime's next batch pass for that one.
   * Accepted receipts also stay available to loads still reading history.
   */
  private acknowledgeBatch(
    scope: ScopeState,
    batch: TerminalRecordOutboxEntry,
    result: WorkerTerminalRecordApplyResult,
  ): void {
    if (result.outcome === 'dropped') return;
    scope.authorityRevision += 1;
    scope.generation = Math.max(scope.generation ?? 1, result.generation);
    for (const acknowledged of scope.loadReceipts) acknowledged.push(batch);
  }

  /**
   * Drops an earlier run's queued writes of another known incarnation: they
   * belong to a worktree its id no longer names, and sent now they would
   * retire this lifetime's record. Returns whether it dropped any.
   */
  private dropForeignOutbox(scope: ScopeState): boolean {
    const { incarnation } = scope;
    if (typeof incarnation !== 'string') return false;
    const foreign = this.queuedOutboxes(scope).filter(
      ({ client }) =>
        client.incarnation !== null && client.incarnation !== incarnation,
    );
    if (foreign.length === 0) return false;
    logMainProcessWarn(
      'Dropped terminal record writes queued for an earlier worktree',
      {
        entries: foreign.reduce((sum, { entries }) => sum + entries.length, 0),
      },
    );
    this.outboxState.scopes = this.outboxState.scopes.filter(
      (candidate) => !foreign.includes(candidate),
    );
    this.outboxDirty = true;
    return true;
  }

  /**
   * The outbox this lifetime's next batch joins: the worktree's last one
   * when it is under this lifetime's client incarnation, else a new one
   * after it. One not looked up yet queues as unknown (`null`), never under
   * an earlier worktree's client, whose outbox a later drain may drop. The
   * client carries no generation: each entry carries its own.
   */
  private outboxOf(scope: ScopeState): TerminalRecordScopeOutbox {
    this.dropForeignOutbox(scope);
    const client = this.clientFor(scope, false);
    return appendScopeOutbox(this.outboxState.scopes, { client, entries: [] });
  }

  private dropEmptyScopes(): void {
    this.outboxState.scopes = this.outboxState.scopes.filter(
      ({ entries }) => entries.length > 0,
    );
  }

  /**
   * Writes the outbox, in order, once earlier runs' outbox is merged in. A
   * failed write keeps every batch in memory and shows the persistent
   * warning; the next change or drain retries it (q-28 (1)): shells keep
   * running. Resolves whether the write succeeded.
   */
  private persistOutbox(): Promise<boolean> {
    this.outboxDirty = true;
    const revision = ++this.outboxWriteRevision;
    const write = this.outboxWrites
      .then(() => this.whenStarted())
      .then(async (): Promise<boolean> => {
        if (this.sealed !== null) return false;
        this.dropEmptyScopes();
        try {
          if (!this.outbox) throw new Error('No terminal outbox root.');
          const empty =
            this.outboxState.scopes.length === 0 &&
            this.outboxState.retirements.length === 0;
          const merged =
            this.outboxFile === null && this.mergedRunFiles.length > 0;
          // Even an empty ledger suppresses retired writes in surviving sources.
          if (empty && !merged) await this.outbox.remove(this.outboxFile);
          else {
            const publicationId = randomUUID();
            const entries = this.publicationEntries();
            await this.outbox.write(
              { ...this.outboxState, publicationId },
              this.outboxFile,
              (image) => this.certifyPublication(entries, image),
            );
          }
          if (this.sealed !== null) return false;
          // Earlier runs' own files are merged into this one now.
          if (merged) {
            await this.outbox.discard(this.mergedRunFiles);
            if (empty) await this.outbox.remove(this.outboxFile);
            this.mergedRunFiles = [];
            delete this.outboxState.merged;
          }
          // A later queued write may hold changes absent from this install.
          if (revision === this.outboxWriteRevision) this.outboxDirty = false;
          this.setOutboxWarning(false);
          // Layout that waited on these writes may land now (§5.15).
          for (const scope of this.scopes.values())
            this.installPresentation(scope);
          return true;
        } catch (error) {
          if (this.sealed !== null) return false;
          logMainProcessWarn('Could not write the terminal outbox; retrying', {
            code: errorCode(error),
          });
          this.outboxDirty = true;
          this.setOutboxWarning(true);
          this.ensureDrainTimer();
          return false;
        } finally {
          this.reconcileRetries();
        }
      });
    this.outboxWrites = write.then(() => undefined);
    return write;
  }

  private setOutboxWarning(warning: boolean): void {
    if (this.outboxWarning === warning) return;
    this.outboxWarning = warning;
    for (const listener of this.warningListeners) listener(warning);
  }

  /** The persistent q-28 (1) warning: in-process terminal history is held in memory. */
  public isOutboxWarningShown(): boolean {
    return this.outboxWarning;
  }

  public onOutboxWarningChanged(
    listener: (warning: boolean) => void,
  ): () => void {
    this.warningListeners.add(listener);
    return () => this.warningListeners.delete(listener);
  }

  private installedBatchKey(
    client: WorkerTerminalRecordClient,
    entry: TerminalRecordOutboxEntry,
  ): string {
    return JSON.stringify([
      client.projectId,
      client.worktreeId,
      entry.runId,
      entry.seq,
    ]);
  }

  private publicationEntries(): Map<string, TerminalRecordOutboxEntry> {
    const entries = new Map<string, TerminalRecordOutboxEntry>();
    for (const queued of this.outboxState.scopes)
      for (const entry of queued.entries)
        entries.set(this.installedBatchKey(queued.client, entry), entry);
    return entries;
  }

  private certifyPublication(
    entries: Map<string, TerminalRecordOutboxEntry>,
    image: TerminalRecordOutboxFile,
  ): void {
    for (const queued of image.scopes)
      for (const installed of queued.entries) {
        const entry = entries.get(
          this.installedBatchKey(queued.client, installed),
        );
        if (entry)
          this.installedBatches.set(entry, {
            ...installed,
            client: installed.client ?? queued.client,
          });
      }
  }

  private hasRetryResponsibility(): boolean {
    return (
      this.sealed === null &&
      // Loads stay unavailable until an unreadable outbox is merged.
      ((this.outbox !== null && !this.earlierMerged) ||
        Array.from(this.scopes.values()).some((scope) =>
          this.hasOutbox(scope),
        ) ||
        this.outboxState.retirements.length > 0 ||
        this.outboxDirty ||
        this.mergedRunFiles.length > 0)
    );
  }

  private reconcileRetries(): void {
    if (this.hasRetryResponsibility()) this.ensureDrainTimer();
    else if (this.drainTimer !== undefined) {
      clearInterval(this.drainTimer);
      this.drainTimer = undefined;
    }
  }

  private ensureDrainTimer(): void {
    if (this.sealed !== null) return;
    if (this.drainTimer !== undefined) return;
    this.drainTimer = setInterval(() => {
      if (!this.hasRetryResponsibility()) {
        this.reconcileRetries();
        return;
      }
      void this.drainAll();
    }, DRAIN_INTERVAL_MS);
    this.drainTimer.unref?.();
  }

  /** Applies a worktree's outbox in order; stops at the first failure. */
  private drainScope(scope: ScopeState): Promise<void> {
    // Serialized, and every request gets a pass that starts after it.
    const settled = (scope.draining ?? Promise.resolve())
      .then(() => this.drainOnce(scope))
      .catch(() => undefined);
    scope.draining = settled;
    void settled.then(() => {
      if (scope.draining === settled) scope.draining = undefined;
    });
    return settled;
  }

  private canContinueDrain(scope: ScopeState): boolean {
    return this.sealed === null && this.owns(scope);
  }

  private async drainOnce(scope: ScopeState): Promise<void> {
    await this.whenStarted();
    if (!this.earlierMerged || !this.canContinueDrain(scope)) return;
    await this.drainRetirements();
    const admission = await this.authorityAdmission(scope);
    if (!admission) return;
    if (!this.canContinueDrain(scope)) return;
    await this.resolveIncarnation(scope);
    // Quit keeps these batches in custody, even after a late lookup.
    if (!this.canContinueDrain(scope)) return;
    if (this.dropForeignOutbox(scope)) await this.persistOutbox();
    if (!this.canContinueDrain(scope)) return;
    // A retirement not applied yet holds this worktree's writes behind it.
    if (
      this.retirementPending(scope) ||
      !this.hasOutbox(scope) ||
      !(await this.records.available())
    )
      return;
    for (;;) {
      // A retired lifetime's drain stops: what is queued now is its successor's.
      if (!this.admissionCurrent(admission)) return;
      // Earlier lifetimes' batches stay in custody; this lifetime's go past them.
      const outbox = this.queuedOutboxes(scope).find(
        ({ client, entries }) =>
          entries[0] !== undefined &&
          this.canReplay(scope, entries[0].client ?? client),
      );
      const entry = outbox?.entries[0];
      if (!outbox || !entry) break;
      const installed = this.installedBatches.get(entry);
      // Replacements (including rejected-batch splits) have no certificate.
      // An older certified object displaced meanwhile is never a drain source.
      if (
        !installed ||
        !this.admissionCurrent(admission) ||
        !this.outboxState.scopes.includes(outbox) ||
        outbox.entries[0] !== entry
      )
        return;
      entry.attempted = true;
      try {
        const result = await this.track(
          scope,
          this.records.apply({
            client: installed.client,
            producer: { id: PRODUCER_ID, runId: installed.runId },
            seq: installed.seq,
            ...(installed.generation !== undefined && {
              generation: installed.generation,
            }),
            ...(installed.sealed && { sealed: installed.sealed }),
            ops: installed.ops,
          }),
        );
        if (result.outcome !== 'applied')
          logMainProcessWarn('Terminal record batch not applied', {
            outcome: result.outcome,
          });
        this.acknowledgeBatch(scope, entry, result);
      } catch (error) {
        if (!this.canContinueDrain(scope)) return;
        // A batch the authority can never accept must not hold every later
        // write behind it: it is split until only the op it rejects is left.
        if (errorKind(error) === 'invalid_argument') {
          this.splitRejectedEntry(outbox, entry);
          await this.persistOutbox();
          continue;
        }
        logMainProcessWarn('Terminal outbox drain paused', {
          reason: error instanceof Error ? error.name : 'error',
        });
        await this.persistOutbox();
        return;
      }
      if (!this.canContinueDrain(scope)) return;
      // Rewritten without the batch only after its receipt.
      if (outbox.entries[0] === entry) outbox.entries.shift();
      await this.persistOutbox();
    }
    await this.fenceAppliedRecord(scope);
    if (this.canContinueDrain(scope) && scope.pending.length > 0)
      this.scheduleFlush(scope);
  }

  /**
   * Splits the head entry the authority rejected: into whole `apply`
   * batches when it holds more ops than one carries, else in half, and
   * drops it, logged, once a single op is left. Every part but the last
   * goes under a run id derived from the entry's own, so each still applies
   * at most once; the last keeps the entry's seq and seal.
   */
  private splitRejectedEntry(
    outbox: TerminalRecordScopeOutbox,
    entry: TerminalRecordOutboxEntry,
  ): void {
    const { entries } = outbox;
    // Dropped meanwhile, with its outbox, by a retirement.
    if (entries[0] !== entry || !this.outboxState.scopes.includes(outbox))
      return;
    if (entry.ops.length <= 1) {
      logMainProcessWarn('Dropped a terminal record batch it rejects', {
        op: entry.ops[0]?.op ?? 'none',
      });
      entries.shift();
      return;
    }
    const size =
      entry.ops.length > WORKER_TERMINAL_RECORD_MAX_OPS
        ? WORKER_TERMINAL_RECORD_MAX_OPS
        : Math.ceil(entry.ops.length / 2);
    const parts: TerminalRecordOutboxEntry[] = [];
    const { sealed, ...rest } = entry;
    for (let start = 0; start < entry.ops.length; start += size) {
      const ops = entry.ops.slice(start, start + size);
      parts.push(
        start + size >= entry.ops.length
          ? { ...rest, ops, attempted: true, ...(sealed && { sealed }) }
          : {
              ...rest,
              // The entry's size keeps each split's ids apart, so a later
              // split of the last part never reuses an applied part's run.
              runId: derivedRunId(
                `${entry.runId}~${entry.seq}.${entry.ops.length}.${parts.length}`,
              ),
              ops,
              attempted: false,
            },
      );
    }
    logMainProcessWarn('Split a terminal record batch it rejects', {
      ops: entry.ops.length,
      parts: parts.length,
    });
    entries.splice(0, 1, ...parts);
  }

  /**
   * Flushes the writes pending now, without their debounce. A direct flush
   * takes one `apply` batch and an outbox flush takes them all, so output
   * that keeps arriving cannot hold this, and a flush that takes none ends it.
   */
  private async flushPending(scope: ScopeState): Promise<void> {
    for (let passes = scope.pending.length; passes > 0; passes -= 1) {
      const queued = this.hasOutbox(scope);
      const taken = this.seqs.get(scope.key);
      if (scope.timer !== undefined) clearTimeout(scope.timer);
      scope.timer = undefined;
      await this.flushScope(scope);
      await scope.flushRun;
      if (
        queued ||
        scope.pending.length === 0 ||
        this.seqs.get(scope.key) === taken
      )
        return;
    }
  }

  /** Drains every outbox, retirements first: on reconnect and every 30 s. */
  public async drainAll(refreshSession = false): Promise<void> {
    await this.whenStarted();
    if (this.sealed !== null) return;
    // Refresh the session even when an idle reconnect has nothing to drain.
    if (refreshSession) await this.records.available();
    await this.drainRetirements();
    // Held custody still gets its drain, which drops another worktree's.
    await Promise.all(
      Array.from(this.scopes.values())
        .filter((scope) => this.queuedEntries(scope).length > 0)
        .map((scope) => this.drainScope(scope)),
    );
    // Then this run's writes waiting on their debounce go now, in order.
    for (const scope of Array.from(this.scopes.values())) {
      await scope.flushRun;
      if (scope.pending.length === 0) continue;
      await this.flushPending(scope);
      // This lifetime's queued batches route new writes through the outbox.
      // Join their replay once, bounded: a silent daemon retains durable
      // custody and its serialized drain after the wait expires.
      if (scope.draining)
        await withTimeout(scope.draining, LOAD_DRAIN_BOUND_MS);
    }
    // A partial source cleanup can leave only the merge ledger to retry.
    if (this.outboxDirty || this.mergedRunFiles.length > 0)
      await this.persistOutbox();
    this.reconcileRetries();
  }

  /**
   * Merges the outbox earlier runs left, once, ahead of this run's batches,
   * before this run's first outbox write or drain. An outbox that cannot be
   * read is left in place, and this run queues in a file of its own beside
   * it, so neither overwrites the other.
   */
  private whenStarted(): Promise<void> {
    this.started ??= this.mergeEarlierOutbox().then(() => {
      if (!this.earlierMerged) this.started = undefined;
    });
    return this.started;
  }

  private async mergeEarlierOutbox(): Promise<void> {
    try {
      const earlier = await this.outbox?.read(this.runId);
      if (earlier) {
        this.mergedRunFiles = earlier.runFiles;
        // Named in the shared file until discarded, so a quit or crash
        // before the discard never has the next run merge them twice.
        if (earlier.outbox.merged?.length)
          this.outboxState.merged = earlier.outbox.merged;
        // This run's retirements so far drop earlier writes to those scopes.
        const retired = (outbox: TerminalRecordScopeOutbox): boolean =>
          this.outboxState.retirements.some((retirement) =>
            dropRetiredOutboxEntries(retirement, outbox),
          );
        // This run's outboxes so far, after the earlier runs' ones.
        const mine = this.outboxState.scopes;
        const merged: TerminalRecordScopeOutbox[] = [];
        for (const loaded of earlier.outbox.scopes) {
          if (retired(loaded)) continue;
          // Known, so a drain of every worktree reaches it.
          this.scope(loaded.client.projectId, loaded.client.worktreeId);
          // An earlier worktree's writes never go out under this one's
          // client: of another known incarnation, they are dropped now;
          // otherwise they keep their own client, and once this run knows
          // its incarnation, the drain drops them if it differs (rule 4).
          const { incarnation } = loaded.client;
          if (
            incarnation !== null &&
            this.queuedOutboxes(loaded.client).some(
              ({ client }) =>
                client.incarnation !== null &&
                client.incarnation !== incarnation,
            )
          ) {
            logMainProcessWarn(
              'Dropped terminal record writes queued for an earlier worktree',
              { entries: loaded.entries.length },
            );
            continue;
          }
          appendScopeOutbox(merged, loaded);
          // Decoding/merging preserves the exact mapping installed by its source.
          for (const entry of loaded.entries)
            this.installedBatches.set(entry, {
              ...structuredClone(entry),
              client: structuredClone(entry.client ?? loaded.client),
            });
        }
        for (const queued of mine) appendScopeOutbox(merged, queued);
        this.outboxState.scopes = merged;
        this.outboxState.retirements = [
          ...earlier.outbox.retirements,
          ...this.outboxState.retirements,
        ];
      }
      this.outboxFile = null;
      this.earlierMerged = true;
      this.reconcileRetries();
    } catch (error) {
      logMainProcessWarn('Could not read the terminal outbox; keeping it', {
        code: errorCode(error),
      });
      this.outboxFile = this.runId;
      this.ensureDrainTimer();
    }
  }

  /** Picks up the outbox earlier runs left, then drains it when possible. */
  public start(
    scopeExists?: TerminalPersistenceStoreOptions['scopeExists'],
  ): void {
    if (scopeExists) this.scopeExists = scopeExists;
    void this.whenStarted().then(() => {
      if (
        Array.from(this.scopes.values()).some((scope) =>
          this.hasOutbox(scope),
        ) ||
        this.outboxState.retirements.length > 0
      )
        this.ensureDrainTimer();
      return this.drainAll();
    });
  }

  // -----------------------------------------------------------------------
  // Reads (§5.9)
  // -----------------------------------------------------------------------

  private async readHistory(
    client: WorkerTerminalRecordClient,
    terminalId: string,
    occurrence = 0,
  ): Promise<TerminalHistoryRead> {
    let text = '';
    let cursor: string | null = null;
    let historyRevision: number | undefined;
    let producerWatermarks: ProducerWatermarks;
    for (let pages = 0; pages < 64; pages += 1) {
      const page = await this.records.historyRead({
        client,
        terminalId,
        ...(occurrence > 0 && { occurrence }),
        maxBytes: WORKER_TERMINAL_RECORD_HISTORY_MAX_BYTES,
        ...(cursor !== null && { cursor }),
        ...(historyRevision !== undefined && { historyRevision }),
      });
      if (page.restarted) text = '';
      text += page.text;
      historyRevision = page.historyRevision;
      producerWatermarks =
        page.snapshotProducerWatermarks ?? page.producerWatermarks;
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    return {
      scrollbackLines: text.length > 0 ? text.split('\n') : [],
      producerWatermarks,
    };
  }

  private async openRecord(scope: ScopeState): Promise<{
    worker: TerminalWorkerFile;
    opened: WorkerTerminalRecordOpenResult;
    historyWatermarks: Map<string, ProducerWatermarks>;
    authorityRevision: number;
  } | null> {
    await this.whenStarted();
    const admission = await this.authorityAdmission(scope);
    if (!admission) return null;
    await this.resolveIncarnation(scope);
    if (!(await this.records.available())) return null;
    // A queued retirement of this worktree goes first, so the next lifetime
    // never opens the record it retires.
    if (this.retirementPending(scope))
      await withTimeout(this.drainRetirements(), LOAD_DRAIN_BOUND_MS);
    if (this.hasOutbox(scope))
      await withTimeout(this.drainScope(scope), LOAD_DRAIN_BOUND_MS);
    await this.resolveIncarnation(scope);
    // Detached by a retirement while it waited, or still behind one: served
    // as unavailable, and nothing opened would recreate the record.
    if (!this.admissionCurrent(admission)) return null;
    // Receipts drained before this snapshot are already represented by it.
    const authorityRevision = scope.authorityRevision;
    const opened = await this.track(
      scope,
      this.records.open(this.clientFor(scope)),
    );
    // Its pages read the generation this open served, never a newer one.
    const client: WorkerTerminalRecordClient = {
      ...this.clientFor(scope, false),
      generation: opened.generation,
    };
    const terminals: PersistedTerminalEntry[] = [];
    const historyWatermarks = new Map<string, ProducerWatermarks>();
    for (const entry of opened.terminals) {
      const read =
        entry.historyBytes > 0
          ? await this.readHistory(
              client,
              entry.session.id,
              // A legacy record may hold an id more than once.
              terminals.filter(
                (earlier) => earlier.session.id === entry.session.id,
              ).length,
            )
          : null;
      // Record ops affect the first occurrence of a duplicated legacy id.
      if (!historyWatermarks.has(entry.session.id))
        historyWatermarks.set(
          entry.session.id,
          read?.producerWatermarks ??
            opened.snapshotProducerWatermarks ??
            opened.producerWatermarks,
        );
      terminals.push({
        session: entry.session,
        scrollbackLines: read?.scrollbackLines ?? [],
        exitCode: entry.exitCode,
        signal: entry.signal,
      });
    }
    return {
      opened,
      historyWatermarks,
      authorityRevision,
      worker: {
        version: 2,
        lineage: opened.lineage,
        bindings: opened.bindings,
        terminals,
        terminalCustomNames: opened.terminalCustomNames,
      },
    };
  }

  /**
   * A successful apply is durable, unlike an absent read or an outbox write.
   * One that also landed a pending import ends it here, not at the next
   * load: an offline load in between would read the unfenced legacy file.
   */
  private async fenceAppliedRecord(scope: ScopeState): Promise<void> {
    if (
      scope.fenced ||
      !this.owns(scope) ||
      (scope.presentationDirty && !scope.importPending) ||
      !scope.presentationWritable ||
      this.hasOutbox(scope)
    )
      return;
    try {
      const admission = await this.authorityAdmission(scope);
      if (!admission || !this.admissionCurrent(admission)) return;
      const opened = await withTimeout(
        this.track(scope, this.records.open(this.clientFor(scope))),
        LOAD_DRAIN_BOUND_MS,
      );
      if (!opened || opened.import.pending || !this.admissionCurrent(admission))
        return;
      if (scope.importPending) {
        // A presentation of another lineage is the next load's to replace.
        if (
          scope.lineage !== opened.lineage ||
          (scope.presentation !== undefined &&
            scope.presentation.lineage !== opened.lineage)
        )
          return;
        scope.importPending = false;
        scope.legacyImportPending = false;
        await this.loadPresentation(scope);
        if (!this.admissionCurrent(admission)) return;
        this.installPresentation(scope);
        if (scope.presentationDirty) return;
      }
      await this.writeFence(scope, opened);
    } catch (error) {
      logMainProcessWarn(
        'Could not confirm the terminal record for its fence',
        {
          code: errorCode(error),
        },
      );
    }
  }

  /**
   * Once a worktree's record is imported, main's legacy file becomes the
   * forward fence: an older build reads it as newer and leaves terminal
   * state alone for the session (downgrade freeze; terminals still work).
   */
  private writeMetadata(
    scope: ScopeState,
    write: () => Promise<void>,
  ): Promise<void> {
    const admission = scope.metadataAdmission;
    const run = (this.metadataWrites.get(scope.key) ?? Promise.resolve()).then(
      async () => {
        if (this.owns(scope) && directoryEffectsAdmitted(admission))
          await write();
      },
    );
    const settled = run.catch(() => undefined);
    this.metadataWrites.set(scope.key, settled);
    void settled.then(() => {
      if (this.metadataWrites.get(scope.key) === settled)
        this.metadataWrites.delete(scope.key);
    });
    return run;
  }

  private writeFence(
    scope: ScopeState,
    opened: WorkerTerminalRecordOpenResult,
  ): Promise<void> {
    return this.writeMetadata(scope, () => this.writeFenceNow(scope, opened));
  }

  private async writeFenceNow(
    scope: ScopeState,
    opened: WorkerTerminalRecordOpenResult,
  ): Promise<void> {
    const admission = scope.metadataAdmission;
    if (scope.fenced || opened.import.from === 'newer') return;
    await this.loadPresentation(scope);
    const filePath = getWorktreeTerminalStateFilePath(
      scope.projectId,
      scope.worktreeId,
    );
    try {
      const legacy = readLegacyTerminalState(
        await readFileIfPresent(filePath),
        scope.projectId,
        scope.worktreeId,
      );
      if (!this.owns(scope) || !directoryEffectsAdmitted(admission)) return;
      // A producer may import before the drawer ever loads its v1 geometry.
      // Changed legacy bytes belong in the damaged copy below, not this layout.
      if (
        opened.import.from === 'v1' &&
        legacy.kind === 'v1' &&
        legacy.records.worker.lineage === opened.lineage
      ) {
        if (scope.presentation?.lineage !== opened.lineage) {
          scope.presentation = legacy.records.presentation;
          scope.presentationDirty = true;
        }
        this.installPresentation(scope);
      }
      if (
        !this.owns(scope) ||
        scope.presentationDirty ||
        !scope.presentationWritable
      )
        return;
      if (legacy.kind === 'fenced') {
        scope.fenced = true;
        return;
      }
      // Empty reads/quit must not create a legacy file. A later durable
      // session or binding needs a fence even if there was nothing to import.
      if (
        legacy.kind === 'absent' &&
        opened.terminals.length === 0 &&
        opened.bindings.length === 0 &&
        Object.keys(opened.terminalCustomNames).length === 0
      )
        return;
      // A newer build's file is left alone, as is a retired lifetime's.
      if (legacy.kind === 'newer' || !this.owns(scope)) return;
      // Bytes the record never imported (an older build wrote after the
      // import) are kept beside the fence, never overwritten: the record
      // stays, and the import backup holds only what it imported.
      const unimported =
        (legacy.kind === 'v1' || legacy.kind === 'v2') &&
        legacy.sha256 !== opened.import.sourceSha256;
      if (unimported)
        logMainProcessWarn('Legacy terminal state changed after import', {});
      // A refused layout writer must not create its directory via a fence.
      assertAdmittedWriter(
        'terminal_presentation',
        'electron_main',
        'main/terminal/persistence',
        STORAGE_OWNERSHIP,
      );
      assertAdmittedWriter(
        'terminal_state',
        'electron_main',
        'main/terminal/persistence',
        STORAGE_OWNERSHIP,
      );
      const installed = await mutateDirectory(
        admission,
        async (lease) => {
          if (legacy.kind === 'damaged' || unimported)
            await lease.rename(filePath, damagedCopyPath(filePath));
          if (!this.owns(scope) || !directoryEffectsAdmitted(admission)) return;
          await lease.mkdir(dirname(filePath));
          await lease.install(
            filePath,
            JSON.stringify(
              {
                version: 3,
                movedTo: 'terminal-record-authority',
                lineage: opened.lineage,
                sourceSha256: opened.import.sourceSha256,
              },
              null,
              2,
            ),
            {
              encoding: 'utf8',
              durable: true,
              admittedWriter: {
                namespace: 'terminal_state',
                writer: 'electron_main',
                module: 'main/terminal/persistence',
              },
            },
          );
        },
        () => this.owns(scope),
      );
      if (!installed) return;
      scope.fenced = true;
    } catch (error) {
      logMainProcessWarn('Could not fence legacy terminal state', {
        code: errorCode(error),
      });
    }
  }

  /**
   * Main's own legacy pair, read only, for a worktree never imported: a
   * fenced file is never read as state again. A newer build's file leaves
   * the presentation as it is too, as main's pair froze together.
   */
  private async readLegacy(scope: ScopeState): Promise<TerminalRecords | null> {
    const epoch = this.readRevisions.get(scope.key) ?? 0;
    if (
      !this.canPublishRead(scope) ||
      !this.earlierMerged ||
      this.retirementPending(scope)
    )
      return null;
    try {
      const bytes = await readFileIfPresent(
        getWorktreeTerminalStateFilePath(scope.projectId, scope.worktreeId),
      );
      if (!this.canPublishRead(scope, epoch)) return null;
      const legacy = readLegacyTerminalState(
        bytes,
        scope.projectId,
        scope.worktreeId,
      );
      if (legacy.kind === 'newer') this.freezePresentation(scope, 'newer');
      return legacy.kind === 'v1' || legacy.kind === 'v2'
        ? legacy.records
        : null;
    } catch {
      return null;
    }
  }

  private freezePresentation(scope: ScopeState, reason: string): void {
    if (!scope.presentationWritable) return;
    scope.presentationWritable = false;
    logMainProcessWarn('Leaving terminal presentation unchanged this session', {
      reason,
    });
  }

  /**
   * A worktree's terminal state for its drawer: the record and its history
   * from the daemon's authority, with this run's queued writes and live
   * sessions on top. While the authority cannot be reached, it serves what
   * is queued here (and, for a worktree never imported, main's own legacy
   * state) with `history: unavailable` (q-28 (2)).
   */
  public async loadWorktreeState(
    projectId: string,
    worktreeId: string,
    historyStatusOnly = false,
  ): Promise<LoadWorktreeTerminalStateResponse> {
    if (historyStatusOnly) {
      // A probe never reads output, opens a drawer view or revives a retired scope.
      const available = this.records.peekAvailable?.() === true;
      return {
        ...createEmptyState(),
        liveTerminalIds: [],
        history: available
          ? { status: 'available' }
          : { status: 'unavailable', reason: 'background_service' },
        historyHeld: this.outboxWarning,
        historyRefreshSupported: true,
      };
    }
    // Retired or revoked terminal state needs confirmed existence; shell
    // registration remains non-blocking. Directory epochs independently
    // revoke old callbacks.
    const directoryAdmission = captureDirectoryEffects(
      dirname(getWorktreeTerminalPresentationFilePath(projectId, worktreeId)),
    );
    const allocated = this.scopes.get(worktreeKey(projectId, worktreeId));
    if (
      this.isRetired(projectId, worktreeId) ||
      !directoryEffectsAdmitted(directoryAdmission) ||
      (allocated && !directoryEffectsAdmitted(allocated.metadataAdmission))
    ) {
      const key = worktreeKey(projectId, worktreeId);
      const revision = this.readRevisions.get(key) ?? 0;
      let exists: boolean | null = null;
      try {
        exists = this.scopeExists
          ? await this.scopeExists(projectId, worktreeId)
          : true;
      } catch {
        /* Unknown, not permission to revive. */
      }
      // An unallocated scope has no read revision to advance: a deletion that
      // began during the check shows only in the directory epoch.
      if (
        exists !== true ||
        revision !== (this.readRevisions.get(key) ?? 0) ||
        directoryDeletionSince(directoryAdmission)
      )
        return {
          ...createEmptyState(),
          liveTerminalIds: [],
          history: { status: 'unavailable', reason: 'background_service' },
          historyHeld: this.outboxWarning,
          historyRefreshSupported: true,
        };
    }
    this.revive(projectId, worktreeId);
    const scope = this.scope(projectId, worktreeId);
    scope.metadataAdmission = directoryAdmission;
    await this.loadPresentation(scope);
    const acknowledged: TerminalRecordOutboxEntry[] = [];
    scope.loadReceipts.add(acknowledged);
    try {
      return await this.loadScopeState(scope, acknowledged);
    } finally {
      scope.loadReceipts.delete(acknowledged);
      acknowledged.length = 0;
    }
  }

  private async loadScopeState(
    scope: ScopeState,
    acknowledged: TerminalRecordOutboxEntry[],
  ): Promise<LoadWorktreeTerminalStateResponse> {
    const { projectId, worktreeId } = scope;
    const loadRevision = ++scope.loadRevision;
    let authorityRevision = scope.authorityRevision;
    const mutationRevision = scope.mutationRevision;
    const readRevision = this.readRevisions.get(scope.key) ?? 0;
    const indexedBeforeRead = new Map(
      Array.from(this.index, ([id, entry]) => [
        id,
        { entry, exitCode: entry.exitCode, signal: entry.signal },
      ]),
    );
    const canCommitMetadata = (): boolean =>
      this.canPublishRead(scope, readRevision) &&
      scope.loadRevision === loadRevision &&
      scope.authorityRevision === authorityRevision;
    const canCommit = (): boolean =>
      canCommitMetadata() && scope.mutationRevision === mutationRevision;

    const admission = await this.readAdmission(scope);
    if (admission === 'denied') return this.emptyRead(scope, false);
    const persistedAllowed = admission === 'allowed';
    let worker: TerminalWorkerFile | null = null;
    let history: TerminalRecordHistoryStatus = persistedAllowed
      ? { status: 'available' }
      : { status: 'unavailable', reason: 'background_service' };
    let opened: WorkerTerminalRecordOpenResult | null = null;
    let historyWatermarks = new Map<string, ProducerWatermarks>();
    try {
      const result = persistedAllowed
        ? await withTimeout(this.openRecord(scope), LOAD_DRAIN_BOUND_MS * 2)
        : null;
      if (result) {
        worker = result.worker;
        opened = result.opened;
        historyWatermarks = result.historyWatermarks;
        authorityRevision = result.authorityRevision;
      }
      // A timed-out read may never settle; it must retain no more receipts.
      else scope.loadReceipts.delete(acknowledged);
    } catch (error) {
      logMainProcessWarn('Terminal record unavailable for a load', {
        reason: error instanceof Error ? error.name : 'error',
      });
      scope.loadReceipts.delete(acknowledged);
    }
    if (!this.canPublishRead(scope, readRevision))
      return this.emptyRead(scope, false);
    let legacyPresentation: TerminalPresentationFile | undefined;
    if (!worker && persistedAllowed) {
      history = { status: 'unavailable', reason: 'background_service' };
      const legacy = await this.readLegacy(scope);
      if (legacy) {
        worker = legacy.worker;
        legacyPresentation = legacy.presentation;
      } else history = { status: 'unavailable', reason: 'background_service' };
    }
    if (!this.canPublishRead(scope, readRevision))
      return this.emptyRead(scope, false);
    let nextLineage = worker?.lineage ?? scope.lineage;
    const pending = opened?.import.pending === true;
    const legacyImportPending = pending && opened?.import.from === 'none';
    if (opened) {
      if (pending) {
        const legacy = await this.readLegacy(scope);
        if (legacy && worker) {
          if (legacyImportPending)
            worker = withLegacyUnderneath(legacy.worker, worker);
          legacyPresentation = legacy.presentation;
        } else if (legacyImportPending)
          history = { status: 'unavailable', reason: 'background_service' };
      } else if (
        canCommit() &&
        scope.importPending &&
        scope.presentation?.lineage !== opened.lineage
      ) {
        scope.presentation = undefined;
        scope.presentationInstalled = undefined;
        scope.presentationDirty = false;
        scope.presentationLoaded = false;
        scope.presentationEpoch += 1;
        scope.presentationRead = undefined;
        await this.loadPresentation(scope);
      }
      nextLineage =
        legacyImportPending && worker ? worker.lineage : opened.lineage;
      if (opened.import.from === 'v1') {
        const legacy = await this.readLegacy(scope);
        if (legacy?.worker.lineage === opened.lineage)
          legacyPresentation = legacy.presentation;
      }
    }
    if (!this.canPublishRead(scope, readRevision))
      return this.emptyRead(scope, false);
    const commit = canCommit();
    if (opened && canCommitMetadata()) {
      scope.importPending = pending;
      scope.legacyImportPending = legacyImportPending;
      scope.lineage = nextLineage;
      scope.generation = Math.max(scope.generation ?? 1, opened.generation);
      if (opened.import.from === 'newer')
        this.freezePresentation(scope, 'newer');
    } else if (worker && commit) scope.lineage ??= worker.lineage;
    const lineage = nextLineage ?? randomUUID();
    // A load that reads no record keeps the membership this lifetime last
    // knew for its live terminals, so a partial drawer's save never splits
    // their saved groups.
    const base: TerminalWorkerFile = worker ?? {
      version: 2,
      lineage,
      bindings: scope.shadow.bindings,
      terminals: scope.shadow.terminals.filter((entry) => {
        const live = this.liveSessions.get(entry.session.id);
        return (
          live?.projectId === projectId &&
          live.worktreeId === worktreeId &&
          !scope.suppressed.has(live.id)
        );
      }),
      terminalCustomNames: {},
    };
    // This run's writes, including receipts newer than the opened snapshot.
    const overlay: TerminalRecordPayloadState = {
      bindings: base.bindings.map((binding) => ({
        ...binding,
        members: [...binding.members],
      })),
      terminals: base.terminals.map((entry) => ({
        ...entry,
        scrollbackLines: [...entry.scrollbackLines],
      })),
      terminalCustomNames: { ...base.terminalCustomNames },
    };
    // Only batches the opened snapshot does not hold: a send with an unknown
    // outcome may be applied already, and must not show its output twice.
    scope.loadReceipts.delete(acknowledged);
    const watermarks =
      opened?.snapshotProducerWatermarks ?? opened?.producerWatermarks;
    const held = (
      entry: TerminalRecordOutboxEntry,
      snapshot: ProducerWatermarks,
    ): boolean => {
      if (!isRecord(snapshot)) return false;
      const watermark = snapshot[producerWatermarkKey(entry.runId)];
      return typeof watermark === 'number' && entry.seq <= watermark;
    };
    // A receipt may have removed a batch while this load read history. Keep
    // those writes ahead of the remaining queue, but replay each batch once.
    const queued = [
      ...acknowledged,
      ...this.replayEntries(scope),
      ...(scope.inflight ? [scope.inflight] : []),
    ].filter(
      (entry) =>
        (!entry.client || this.canReplay(scope, entry.client)) &&
        !held(entry, watermarks),
    );
    const replayed = new Set<string>();
    for (const entry of queued) {
      const key = `${entry.runId}/${entry.seq}`;
      if (replayed.has(key)) continue;
      replayed.add(key);
      for (const op of entry.ops) {
        // Pages may precede or follow a receipt. Skip output only when that
        // terminal's history snapshot already holds the batch. Older pages
        // lack watermarks: prefer duplicate output to losing a later write.
        if (
          (op.op === 'output.append' || op.op === 'output.replace') &&
          held(entry, historyWatermarks.get(op.terminalId) ?? watermarks)
        )
          continue;
        applyTerminalRecordOp(overlay, op);
        // A held upsert may recreate an entry removed by a preceding forget.
        // Its history page already includes the recreated session's output.
        if (
          op.op === 'session.upsert' &&
          held(entry, historyWatermarks.get(op.session.id))
        ) {
          const paged = base.terminals.find(
            (terminal) => terminal.session.id === op.session.id,
          );
          const rebased = overlay.terminals.find(
            (terminal) => terminal.session.id === op.session.id,
          );
          if (paged && rebased)
            rebased.scrollbackLines = [...paged.scrollbackLines];
        }
      }
    }
    for (const op of scope.pending) applyTerminalRecordOp(overlay, op);
    if (commit)
      scope.shadow = {
        bindings: overlay.bindings,
        terminals: overlay.terminals.map((entry) => ({
          ...entry,
          scrollbackLines: [],
        })),
        // A load that could not read the record keeps the names this lifetime
        // last knew: a drawer may still show them (R6-F2).
        terminalCustomNames:
          history.status === 'unavailable'
            ? {
                ...scope.shadow.terminalCustomNames,
                ...overlay.terminalCustomNames,
              }
            : { ...overlay.terminalCustomNames },
      };
    const presentation =
      scope.presentation?.lineage === lineage
        ? scope.presentation
        : legacyPresentation?.lineage === lineage
          ? legacyPresentation
          : undefined;
    if (commit && presentation && presentation !== scope.presentation) {
      scope.presentation = presentation;
      scope.presentationDirty = true;
    }
    const state = composeRecords(
      { version: 2, lineage, ...overlay },
      presentation,
      projectId,
      worktreeId,
    );
    const recorded = new Set(
      overlay.terminals.map((entry) => entry.session.id),
    );
    const liveTerminalIds = this.mergeLiveSessions(scope, state);
    // A live in-process terminal this worktree's record lacks joins it with
    // the group it was just shown in.
    for (const terminalId of liveTerminalIds) {
      const live = this.liveSessions.get(terminalId);
      if (
        commit &&
        live &&
        !recorded.has(terminalId) &&
        !this.isRecordedDaemonTerminal(terminalId)
      )
        this.enqueue(scope, { op: 'session.upsert', session: live });
    }
    state.activeGroupId = this.activeGroupFor(
      scope,
      state,
      presentation?.activeGroupId ?? null,
    );
    const viewToken = this.openView(
      scope,
      history.status === 'unavailable',
      state.terminals.map((entry) => entry.session.id),
      Object.keys(state.terminalCustomNames),
      state.drawerCollapsed,
    );
    // A lifetime retired while this load awaited never fills the index of
    // the next one.
    const owned = this.canPublishRead(scope, readRevision);
    for (const entry of state.terminals) {
      scope.servedIds.add(entry.session.id);
      const current = this.index.get(entry.session.id);
      const before = indexedBeforeRead.get(entry.session.id);
      // PTY output invalidates a layout snapshot, not unrelated history.
      // A forget, replacement or newer load must keep its own index decision.
      // Publishing once also keeps occurrence zero of a duplicated legacy id.
      if (
        owned &&
        !this.liveSessions.has(entry.session.id) &&
        current === before?.entry &&
        current?.exitCode === before?.exitCode &&
        current?.signal === before?.signal
      )
        this.index.set(entry.session.id, {
          revision:
            this.index.get(entry.session.id)?.revision ??
            ++this.nextIndexRevision,
          session: entry.session,
          exitCode: entry.exitCode,
          signal: entry.signal,
        });
    }
    // A complete record read is the truth: an entry an earlier fallback read
    // indexed from unfenced legacy state, and the record no longer holds,
    // must not seed a restore. The same guard keeps newer index decisions.
    if (owned && opened && !pending && history.status === 'available') {
      const shown = new Set(state.terminals.map((entry) => entry.session.id));
      for (const [terminalId, before] of indexedBeforeRead) {
        const current = this.index.get(terminalId);
        if (
          !shown.has(terminalId) &&
          !this.liveSessions.has(terminalId) &&
          current === before.entry &&
          current.exitCode === before.exitCode &&
          current.signal === before.signal &&
          current.session.projectId === projectId &&
          current.session.worktreeId === worktreeId
        )
          this.invalidateRestoreEntry(scope, terminalId);
      }
    }
    // The imported layout lands before the fence, which stops main reading
    // the legacy file it came from; a failed install retries next load.
    if (commit && scope.presentationDirty) this.installPresentation(scope);
    // A layout that cannot be written leaves the legacy file unfenced too.
    if (
      opened &&
      owned &&
      commit &&
      !scope.importPending &&
      !scope.presentationDirty &&
      scope.presentationWritable
    )
      await this.writeFence(scope, opened);
    if (!this.canPublishRead(scope, readRevision))
      return this.emptyRead(scope, false);
    return serializeResponse(
      state,
      liveTerminalIds,
      history,
      this.outboxWarning,
      viewToken,
    );
  }

  /**
   * The drawer's active group as main's layout kept it: the group a new
   * shell or focused script activated, else the one the layout names, else
   * the first group that is not only background scripts of this run.
   */
  private activeGroupFor(
    scope: ScopeState,
    state: PersistedWorktreeTerminalStateFile,
    named: string | null,
  ): string | null {
    const has = (groupId: string | null): groupId is string =>
      groupId !== null && state.groups.some((group) => group.id === groupId);
    if (has(scope.activation)) return scope.activation;
    if (has(named)) return named;
    const background = (terminalId: string): boolean => {
      const live = this.liveSessions.get(terminalId);
      return live !== undefined && !shouldActivateSyntheticGroup(live);
    };
    return (
      state.groups.find(
        (group) => !group.terminalIds.every((id) => background(id)),
      )?.id ?? null
    );
  }

  private mergeLiveSessions(
    scope: ScopeState,
    state: PersistedWorktreeTerminalStateFile,
  ): string[] {
    const liveTerminalIds: string[] = [];
    for (const session of Array.from(this.liveSessions.values())) {
      if (
        session.projectId !== scope.projectId ||
        session.worktreeId !== scope.worktreeId ||
        !isDrawerOwnedTerminal(session) ||
        scope.suppressed.has(session.id)
      )
        continue;
      liveTerminalIds.push(session.id);
      const existing = state.terminals.find(
        (entry) => entry.session.id === session.id,
      );
      if (existing) existing.session = session;
      else
        state.terminals.push({
          session,
          scrollbackLines: [],
          exitCode: null,
          signal: null,
        });
      if (!hasGroupForTerminal(state.groups, session.id)) {
        const group = buildSyntheticGroup(state, session.id);
        state.groups.push(group);
        if (
          state.activeGroupId === null &&
          shouldActivateSyntheticGroup(session)
        )
          state.activeGroupId = group.id;
      }
    }
    return liveTerminalIds;
  }

  /** The metadata main keeps of a terminal, live or loaded. */
  public getTerminalMetadata(terminalId: string): IndexEntry | null {
    const indexed = this.index.get(terminalId);
    return indexed ? { ...indexed } : null;
  }

  /** A host switch must not let the old shell's writes reach its successor. */
  public async prepareDaemonRestore(terminalId: string): Promise<boolean> {
    const indexed = this.index.get(terminalId);
    if (!indexed) return false;
    const scope = this.scope(
      indexed.session.projectId,
      indexed.session.worktreeId,
    );
    const admission = await this.authorityAdmission(scope);
    if (!admission) return false;
    const drain = async (): Promise<true> => {
      await this.whenStarted();
      await this.drainRetirements();
      await scope.flushRun;
      if (scope.timer !== undefined) clearTimeout(scope.timer);
      scope.timer = undefined;
      await this.flushScope(scope);
      await scope.flushRun;
      await this.flushPending(scope);
      await this.drainScope(scope);
      return true;
    };
    const drained = await withTimeout(drain(), LOAD_DRAIN_BOUND_MS).catch(
      () => null,
    );
    return (
      drained === true &&
      this.admissionCurrent(admission) &&
      this.owns(scope) &&
      this.index.get(terminalId)?.revision === indexed.revision &&
      !this.retirementPending(scope) &&
      !scope.importPending &&
      !this.hasOutbox(scope) &&
      !scope.inflight &&
      !scope.flushing &&
      scope.pending.length === 0
    );
  }

  private async readRestoreHistory(
    scope: ScopeState,
    client: WorkerTerminalRecordClient,
    terminalId: string,
  ): Promise<TerminalHistoryRead & { importPending: boolean }> {
    const read = await this.readHistory(client, terminalId);
    if (!scope.importPending || !this.owns(scope))
      return { ...read, importPending: false };
    try {
      const admission = await this.authorityAdmission(scope);
      if (!admission || !this.admissionCurrent(admission))
        throw new TerminalRecordAdmissionDeferred();
      const opened = await this.track(scope, this.records.open(client));
      if (opened.import.pending === true && opened.import.from === 'none')
        return { ...read, importPending: true };
      // Import may have completed in either call. Re-read instead of prefixing
      // legacy bytes to a page that may already include them.
      return {
        ...(await this.readHistory(client, terminalId)),
        importPending: false,
      };
    } catch {
      return { ...read, importPending: scope.legacyImportPending };
    }
  }

  /**
   * Seeds a terminal's history for a synchronous engine restore or replay,
   * from the record, or main's legacy state for a worktree never imported;
   * with queued output overlaid when a host switch cannot drain (§5.9).
   * Returns the release of the seed.
   */
  public async prefetchPersistedEntry(terminalId: string): Promise<() => void> {
    const indexed = this.index.get(terminalId);
    if (!indexed) return () => undefined;
    let lease = this.seeded.get(terminalId);
    if (!lease || !this.seedCurrent(terminalId, lease)) {
      this.revokeSeed(terminalId);
      lease = {
        scope: this.scope(
          indexed.session.projectId,
          indexed.session.worktreeId,
        ),
        epoch:
          this.readRevisions.get(
            worktreeKey(indexed.session.projectId, indexed.session.worktreeId),
          ) ?? 0,
        revision: indexed.revision,
        holders: 1,
        revoked: false,
      };
      this.seeded.set(terminalId, lease);
      const preparing = lease;
      lease.preparation = Promise.resolve().then(() =>
        this.prepareHistorySeed(terminalId, indexed, preparing),
      );
    } else lease.holders += 1;
    const held = lease;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders === 0 && this.seeded.get(terminalId) === held)
        this.revokeSeed(terminalId);
    };
    try {
      await held.preparation;
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  private async prepareHistorySeed(
    terminalId: string,
    indexed: IndexEntry,
    lease: HistorySeedLease,
  ): Promise<void> {
    const { session } = indexed;
    const scope = this.scope(session.projectId, session.worktreeId);
    const readRevision = this.readRevisions.get(scope.key) ?? 0;
    const admission = await this.readAdmission(scope);
    if (admission === 'denied') return;
    const persistedAllowed = admission === 'allowed';
    const receipts: TerminalRecordOutboxEntry[] = [];
    scope.loadReceipts.add(receipts);
    let scrollbackLines: string[] = [];
    let watermarks: ProducerWatermarks = undefined;
    try {
      if (persistedAllowed && this.retirementPending(scope))
        await withTimeout(this.drainRetirements(), LOAD_DRAIN_BOUND_MS);
      await this.resolveIncarnation(scope);
      const client = this.clientFor(scope);
      const read =
        persistedAllowed &&
        this.canPublishRead(scope, readRevision) &&
        !this.retirementPending(scope) &&
        (await this.records.available().catch(() => false))
          ? await withTimeout(
              this.readRestoreHistory(scope, client, terminalId),
              LOAD_DRAIN_BOUND_MS * 2,
            ).catch(() => null)
          : null;
      const legacy =
        persistedAllowed && (read?.importPending ?? scope.legacyImportPending)
          ? await this.readLegacy(scope)
          : null;
      const legacyEntry = legacy?.worker.terminals.find(
        (entry) => entry.session.id === terminalId,
      );
      if (legacyEntry) {
        scrollbackLines =
          read && read.scrollbackLines.length > 0
            ? appendScrollbackLines(
                legacyEntry.scrollbackLines,
                read.scrollbackLines.join('\n'),
              )
            : legacyEntry.scrollbackLines;
        watermarks = read?.producerWatermarks;
      } else if (read) {
        scrollbackLines = read.scrollbackLines;
        watermarks = read.producerWatermarks;
      } else {
        const legacy = persistedAllowed ? await this.readLegacy(scope) : null;
        scrollbackLines =
          legacy?.worker.terminals.find(
            (entry) => entry.session.id === terminalId,
          )?.scrollbackLines ?? [];
      }
    } catch (error) {
      logMainProcessWarn('Restoring a terminal without its history', {
        reason: error instanceof Error ? error.name : 'error',
      });
    } finally {
      scope.loadReceipts.delete(receipts);
    }
    // A forget or replacement while history was in flight invalidates its seed.
    if (
      !this.canPublishRead(scope, readRevision) ||
      this.index.get(terminalId)?.revision !== indexed.revision
    )
      return;
    const entry: PersistedTerminalEntry = {
      session,
      scrollbackLines,
      exitCode: indexed.exitCode,
      signal: indexed.signal,
    };
    const overlay: TerminalRecordPayloadState = {
      bindings: [],
      // An old index entry is metadata, not evidence of readable history.
      // Uncertain admission can seed only a live session or this lifetime's ops.
      terminals:
        persistedAllowed || this.liveSessions.has(terminalId) ? [entry] : [],
      terminalCustomNames: {},
    };
    const replayed = new Set<string>();
    for (const batch of [
      ...receipts,
      ...this.replayEntries(scope),
      ...(scope.inflight ? [scope.inflight] : []),
    ]) {
      if (batch.client && !this.canReplay(scope, batch.client)) continue;
      const key = `${batch.runId}/${batch.seq}`;
      if (replayed.has(key)) continue;
      replayed.add(key);
      const watermark = watermarks?.[producerWatermarkKey(batch.runId)];
      if (typeof watermark === 'number' && batch.seq <= watermark) continue;
      for (const op of batch.ops) applyTerminalRecordOp(overlay, op);
    }
    for (const op of scope.pending) applyTerminalRecordOp(overlay, op);
    const restored = overlay.terminals.find(
      (candidate) => candidate.session.id === terminalId,
    );
    if (!restored) return;
    if (this.seedCurrent(terminalId, lease)) lease.entry = restored;
  }

  // -----------------------------------------------------------------------
  // Layout saves (§5.8) and presentation
  // -----------------------------------------------------------------------

  public saveWorktreeState(request: SaveWorktreeTerminalStateRequest): void {
    // A late save of a retired worktree never recreates its record; a load
    // starts the next lifetime first.
    if (this.isRetired(request.projectId, request.worktreeId)) return;
    const scope = this.scope(request.projectId, request.worktreeId);
    this.readmitMetadataLater(scope);
    scope.mutationRevision += 1;
    scope.activation = null;
    const referenced = new Set<string>();
    for (const group of request.groups)
      for (const terminalId of group.terminalIds) referenced.add(terminalId);
    // A layout save never deletes history: only a close's
    // `forgetTerminalIds` forgets (CAN-6616). An id the same save still
    // groups is stale and is kept.
    for (const terminalId of request.forgetTerminalIds ?? [])
      if (!referenced.has(terminalId))
        this.forgetInScope(scope, terminalId, true);
    // What this run showed, the save's own view was shown, and the save omits
    // leaves its group, keeping history and name, as develop's cache does
    // (CAN-6616); what the view was never shown keeps its membership. A save
    // without a token may come from any view: after a partial load, only
    // what every partial view was shown. A token this lifetime never served
    // ungroups nothing.
    const view = this.viewFor(scope, request.viewToken);
    const shown =
      view === null
        ? (scope.partialFloor ?? scope.servedIds)
        : (view?.seen ?? new Set<string>());
    const ungrouped = Array.from(shown).filter(
      (terminalId) =>
        scope.servedIds.has(terminalId) && !referenced.has(terminalId),
    );
    // Referencing a session is not name knowledge: preserve names never served.
    // A tokenless save after a partial load cannot prove which names it knew.
    const named =
      view === null && scope.partialFloor === null
        ? scope.servedIds
        : (view?.named ?? new Set<string>());
    const unknownNames: Record<string, string> = {};
    for (const terminalId of referenced) {
      const kept = scope.shadow.terminalCustomNames[terminalId];
      if (kept !== undefined && !named.has(terminalId))
        unknownNames[terminalId] = kept;
    }
    for (const terminalId of referenced) {
      // Only the saving view is known to show it.
      scope.servedIds.add(terminalId);
      view?.seen.add(terminalId);
      // A referenced live lifetime that was forgotten rejoins the record.
      if (!scope.suppressed.delete(terminalId)) continue;
      const live = this.liveSessions.get(terminalId);
      if (live) {
        this.index.set(terminalId, {
          revision: ++this.nextIndexRevision,
          session: live,
          exitCode: null,
          signal: null,
        });
        if (!this.isRecordedDaemonTerminal(terminalId))
          this.enqueue(scope, { op: 'session.upsert', session: live });
      }
    }

    const requestedNames = normalizeCustomNameMap(
      request.terminalCustomNames,
      referenced,
    );
    const ungroupedNames: Record<string, string> = {};
    for (const terminalId of ungrouped) {
      const kept = scope.shadow.terminalCustomNames[terminalId];
      if (kept !== undefined) ungroupedNames[terminalId] = kept;
    }
    for (const terminalId of Object.keys(requestedNames))
      view?.named.add(terminalId);

    const nextGroups: TerminalGroup[] = [];
    for (const group of request.groups) {
      const terminalIds = group.terminalIds.filter((id) => referenced.has(id));
      if (terminalIds.length === 0) continue;
      nextGroups.push({
        id: group.id,
        terminalIds,
        focusedTerminalId: terminalIds.includes(group.focusedTerminalId)
          ? group.focusedTerminalId
          : terminalIds[0],
        splitSizes: normalizeSplitSizes(terminalIds.length, group.splitSizes),
      });
    }
    const groupIdSet = new Set(nextGroups.map((group) => group.id));
    const groupOrdinals: Record<string, number> = {};
    for (const group of nextGroups) {
      const rawOrdinal = request.groupOrdinals[group.id];
      if (isFiniteNumber(rawOrdinal) && rawOrdinal >= 1)
        groupOrdinals[group.id] = Math.round(rawOrdinal);
    }
    let nextGroupOrdinal =
      isFiniteNumber(request.nextGroupOrdinal) && request.nextGroupOrdinal >= 1
        ? Math.round(request.nextGroupOrdinal)
        : 1;
    for (const ordinal of Object.values(groupOrdinals))
      if (ordinal >= nextGroupOrdinal) nextGroupOrdinal = ordinal + 1;
    const state: PersistedWorktreeTerminalStateFile = {
      ...createEmptyState(),
      drawerCollapsed: request.drawerCollapsed,
      groups: nextGroups,
      groupOrdinals,
      nextGroupOrdinal,
      terminalCustomNames: {
        ...ungroupedNames,
        ...unknownNames,
        ...requestedNames,
      },
      groupCustomNames: normalizeCustomNameMap(
        request.groupCustomNames,
        groupIdSet,
      ),
      activeGroupId:
        request.activeGroupId !== null && groupIdSet.has(request.activeGroupId)
          ? request.activeGroupId
          : (nextGroups[0]?.id ?? null),
    };
    const lineage = scope.lineage ?? randomUUID();
    const records = recordsForState(state, lineage, {
      worker: {
        version: 2,
        lineage,
        bindings: scope.shadow.bindings,
        terminals: [],
        terminalCustomNames: scope.shadow.terminalCustomNames,
      },
      presentation:
        scope.presentation ??
        recordsForState(createEmptyState(), lineage).presentation,
    });
    const workerChanged =
      records.worker.bindings.length !== scope.shadow.bindings.length ||
      records.worker.bindings.some((binding, index) => {
        const previous = scope.shadow.bindings[index];
        return (
          !previous ||
          binding.key !== previous.key ||
          binding.groupId !== previous.groupId ||
          binding.members.length !== previous.members.length ||
          binding.members.some(
            (member, memberIndex) =>
              member.key !== previous.members[memberIndex]?.key ||
              member.terminalId !== previous.members[memberIndex]?.terminalId,
          )
        );
      }) ||
      Object.keys(records.worker.terminalCustomNames).length !==
        Object.keys(scope.shadow.terminalCustomNames).length ||
      Object.entries(records.worker.terminalCustomNames).some(
        ([id, name]) => name !== scope.shadow.terminalCustomNames[id],
      );
    if (workerChanged)
      this.enqueue(scope, {
        op: 'layout.save',
        // A save forgets nothing; closes send `forget` ops. Listing an
        // ungrouped terminal as referenced drops its stale membership.
        servedIds: [],
        referencedIds: [...referenced, ...ungrouped],
        bindings: records.worker.bindings,
        terminalCustomNames: records.worker.terminalCustomNames,
      });
    // Presentation for an unknown lineage waits for a load (§5.15), and a
    // save from a partial view never rewrites the layout of what it missed.
    const wholeView =
      view === null ? scope.partialFloor === null : view?.partial === false;
    const collapseChanged =
      view !== null &&
      view !== undefined &&
      view.drawerCollapsed !== request.drawerCollapsed;
    if (view) view.drawerCollapsed = request.drawerCollapsed;
    if (scope.lineage !== null && wholeView) {
      scope.presentation = records.presentation;
      scope.presentationDirty = true;
      if (!workerChanged) this.scheduleFlush(scope);
    } else if (collapseChanged && scope.presentation) {
      // Collapse is the one scalar a partial view sees whole; an unchanged
      // fallback value never overwrites the saved one.
      scope.presentation = {
        ...scope.presentation,
        drawerCollapsed: request.drawerCollapsed,
      };
      scope.presentationDirty = true;
      if (!workerChanged) this.scheduleFlush(scope);
    }
  }

  /**
   * Explicit deletion from every worktree this run knows the terminal in;
   * never scans unloaded worktrees and never kills a shell. A live lifetime
   * stays out of the record until a layout references it again.
   */
  public forget(terminalId: string): void {
    for (const scope of Array.from(this.scopes.values()))
      this.forgetInScope(scope, terminalId);
  }

  /** `explicit`: a close names it, so the record forgets it even unknown here. */
  private forgetInScope(
    scope: ScopeState,
    terminalId: string,
    explicit = false,
  ): void {
    this.invalidateRestoreEntry(scope, terminalId);
    const { shadow } = scope;
    const present =
      shadow.terminals.some((entry) => entry.session.id === terminalId) ||
      shadow.bindings.some((binding) =>
        binding.members.some((member) => member.terminalId === terminalId),
      ) ||
      Object.prototype.hasOwnProperty.call(
        shadow.terminalCustomNames,
        terminalId,
      );
    if (!present && !explicit) return;
    const lineage = scope.lineage;
    // The drawer as shown, less the terminal, as main's layout dropped it.
    const state =
      lineage === null
        ? null
        : composeRecords(
            { version: 2, lineage, ...shadow },
            scope.presentation,
            scope.projectId,
            scope.worktreeId,
          );
    scope.servedIds.delete(terminalId);
    this.decoders.delete(decoderKey(scope.key, terminalId));
    const live = this.liveSessions.get(terminalId);
    if (
      live &&
      live.projectId === scope.projectId &&
      live.worktreeId === scope.worktreeId &&
      isDrawerOwnedTerminal(live)
    )
      scope.suppressed.add(terminalId);
    this.enqueue(scope, { op: 'forget', terminalId });
    if (!state || lineage === null) return;
    state.terminals = state.terminals.filter(
      (entry) => entry.session.id !== terminalId,
    );
    delete state.terminalCustomNames[terminalId];
    state.groups = state.groups.flatMap((group) => {
      const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
      if (!terminalIds.length) return [];
      if (terminalIds.length === group.terminalIds.length) return [group];
      return [
        {
          ...group,
          terminalIds,
          focusedTerminalId: terminalIds.includes(group.focusedTerminalId)
            ? group.focusedTerminalId
            : terminalIds[0],
          splitSizes: normalizeSplitSizes(terminalIds.length),
        },
      ];
    });
    const groupIds = new Set(state.groups.map((group) => group.id));
    state.groupOrdinals = Object.fromEntries(
      Object.entries(state.groupOrdinals).filter(([id]) => groupIds.has(id)),
    );
    state.groupCustomNames = Object.fromEntries(
      Object.entries(state.groupCustomNames).filter(([id]) => groupIds.has(id)),
    );
    if (state.activeGroupId !== null && !groupIds.has(state.activeGroupId))
      state.activeGroupId = state.groups[0]?.id ?? null;
    const { presentation } = recordsForState(state, lineage, {
      worker: {
        version: 2,
        lineage,
        bindings: shadow.bindings,
        terminals: [],
        terminalCustomNames: shadow.terminalCustomNames,
      },
      presentation:
        scope.presentation ??
        recordsForState(createEmptyState(), lineage).presentation,
    });
    if (JSON.stringify(presentation) === JSON.stringify(scope.presentation))
      return;
    scope.presentation = presentation;
    scope.presentationDirty = true;
  }

  private invalidateRestoreEntry(scope: ScopeState, terminalId: string): void {
    const indexed = this.index.get(terminalId);
    if (
      indexed?.session.projectId === scope.projectId &&
      indexed.session.worktreeId === scope.worktreeId
    ) {
      this.index.delete(terminalId);
    }
    const seeded = this.seeded.get(terminalId);
    if (seeded?.scope === scope) this.revokeSeed(terminalId);
  }

  private isRecordedDaemonTerminal(terminalId: string): boolean {
    return this.recordedIds.has(terminalId);
  }

  /**
   * Membership the layout may reference that is neither applied nor durable
   * in the outbox yet: the layout waits for it (§5.15).
   */
  private membershipPending(scope: ScopeState): boolean {
    const membership = (ops: readonly WorkerTerminalRecordOp[]): boolean =>
      ops.some(
        (op) =>
          op.op === 'session.upsert' ||
          op.op === 'layout.save' ||
          op.op === 'forget',
      );
    return (
      membership(scope.pending) ||
      (scope.inflight !== null && membership(scope.inflight.ops)) ||
      this.queuedEntries(scope).some(
        (entry) => !this.installedBatches.has(entry) && membership(entry.ops),
      )
    );
  }

  private installPresentation(scope: ScopeState, atQuit = false): void {
    if (this.sealed !== null && !atQuit) return;
    if (!scope.presentationDirty || !scope.presentation) return;
    if (!scope.presentationLoaded) {
      if (this.sealed === null)
        void this.loadPresentation(scope).catch((error: unknown) => {
          logMainProcessWarn('Could not classify terminal presentation', {
            code: errorCode(error),
          });
        });
      return;
    }
    // A retired lifetime's late flush never recreates its removed layout.
    if (
      this.scopes.get(scope.key) !== scope ||
      !directoryEffectsAdmitted(scope.metadataAdmission) ||
      !scope.presentationLoaded ||
      !scope.presentationWritable ||
      scope.importPending ||
      this.membershipPending(scope)
    )
      return;
    const filePath = getWorktreeTerminalPresentationFilePath(
      scope.projectId,
      scope.worktreeId,
    );
    try {
      // Admitted before evidence is moved or a directory is created.
      assertAdmittedWriter(
        'terminal_presentation',
        'electron_main',
        'main/terminal/persistence',
        STORAGE_OWNERSHIP,
      );
      if (scope.presentationDamaged) {
        if (!setAsideDamagedStateFile(filePath)) {
          scope.presentationWritable = false;
          return;
        }
        scope.presentationDamaged = false;
      }
      const bytes = JSON.stringify(scope.presentation, null, 2);
      if (scope.presentationInstalled !== bytes) {
        mkdirSync(dirname(filePath), { recursive: true });
        // Main-owned layout keeps develop's non-durable install, not record custody.
        writeFileAtomicallySync(filePath, bytes, {
          encoding: 'utf8',
          admittedWriter: {
            namespace: 'terminal_presentation',
            writer: 'electron_main',
            module: 'main/terminal/persistence',
          },
        });
        scope.presentationInstalled = bytes;
      }
      scope.presentationDirty = false;
    } catch (error) {
      logMainProcessWarn('Failed to write terminal presentation', {
        code: errorCode(error),
      });
    }
  }

  // -----------------------------------------------------------------------
  // Quit, cleanup and retirement (§5.10, §5.12)
  // -----------------------------------------------------------------------

  /**
   * Quit: stamps every live in-process terminal's exit, then seals this
   * run's unacknowledged and pending writes into the outbox synchronously.
   * They stay there in durable custody (only a current lifetime replays);
   * a sealed run never recreates a shell. Daemon terminals the record keeps
   * are stamped by the daemon.
   */
  public markAllLiveTerminalsExited(
    signal: WorkerTerminalRecordShutdownParams['signal'],
  ): void {
    if (this.sealed !== null) return;
    for (const session of Array.from(this.liveSessions.values())) {
      if (this.isRecordedDaemonTerminal(session.id)) continue;
      this.markTerminalExited(
        session.projectId,
        session.worktreeId,
        session.id,
        null,
        signal,
      );
    }
    for (const scope of this.scopes.values()) {
      if (scope.timer !== undefined) clearTimeout(scope.timer);
      scope.timer = undefined;
      const inflight = scope.inflight;
      const batch = this.takeBatchAll(scope);
      if (inflight) void this.toOutbox(scope, { ...inflight, attempted: true });
      // Its reply no longer matters: the outbox holds it under its seq.
      scope.inflight = null;
      if (batch)
        void this.toOutbox(scope, { ...batch, sealed: { reason: signal } });
    }
    this.sealed = signal;
    this.dropEmptyScopes();
    if (
      this.outboxState.scopes.length > 0 ||
      this.outboxState.retirements.length > 0
    ) {
      // Before earlier runs' outbox is merged, this run seals into its own
      // file rather than overwrite theirs.
      const file = this.earlierMerged ? this.outboxFile : this.runId;
      if (this.sealOutbox(file)) this.outboxDirty = false;
    }
    this.flushAllSync();
  }

  private sealOutbox(file: string | null): boolean {
    try {
      const entries = this.publicationEntries();
      this.outbox?.seal(this.outboxState, file, (image) =>
        this.certifyPublication(entries, image),
      );
      return this.outbox !== null;
    } catch (error) {
      logMainProcessWarn('Could not seal the terminal outbox at quit', {
        code: errorCode(error),
      });
      return false;
    }
  }

  private takeBatchAll(scope: ScopeState): TerminalRecordOutboxEntry | null {
    if (scope.pending.length === 0) return null;
    const ops = scope.pending.splice(0);
    return {
      seq: this.nextSeq(scope),
      runId: this.runId,
      client: this.clientFor(scope),
      ...(scope.generation !== null && { generation: scope.generation }),
      ops,
    };
  }

  /** Captures identity without retiring live state or queuing a write. */
  public async prepareTerminalRecordRetirement(params: {
    projectId: string;
    worktreeId?: string;
    incarnation?: string | null;
  }): Promise<WorkerTerminalRecordRetireParams> {
    await this.whenStarted();
    return this.captureTerminalRecordRetirement(params);
  }

  private captureTerminalRecordRetirement(params: {
    projectId: string;
    worktreeId?: string;
    incarnation?: string | null;
  }): WorkerTerminalRecordRetireParams {
    const fence = this.retirementFence(params);
    const lifetimeIds = Array.from(this.scopes.values())
      .filter(
        (scope) =>
          scope.projectId === params.projectId &&
          (params.worktreeId === undefined ||
            scope.worktreeId === params.worktreeId),
      )
      .map((scope) => scope.lifetimeId);
    const worktreeIds = Array.from(this.scopes.values())
      .filter((scope) => scope.projectId === params.projectId)
      .map((scope) => scope.worktreeId);
    const retirement: WorkerTerminalRecordRetireParams = {
      projectId: params.projectId,
      ...(params.worktreeId !== undefined && { worktreeId: params.worktreeId }),
      ...fence,
      lifetimeIds,
      ...(params.worktreeId === undefined && { worktreeIds }),
      // A record a newer lifetime starts after this is left alone, even
      // when neither incarnation is known.
      requestedAt: Date.now(),
    };
    for (const outbox of this.outboxState.scopes)
      retainRetiredOutboxIdentities(retirement, outbox);
    return retirement;
  }

  /** Drops this lifetime's writes and durably queues retirement (§5.12). */
  public retireTerminalRecord(params: {
    projectId: string;
    worktreeId?: string;
    incarnation?: string | null;
  }): Promise<boolean> {
    if (!this.earlierMerged)
      return this.prepareTerminalRecordRetirement(params).then((retirement) =>
        this.retirePreparedTerminalRecord(retirement),
      );
    return this.retirePreparedTerminalRecord(
      this.captureTerminalRecordRetirement(params),
    );
  }

  /**
   * Activates the captured intent only once its owner commits deletion.
   * Resolves whether it is durable in the outbox or applied by the authority.
   */
  public async retirePreparedTerminalRecord(
    retirement: WorkerTerminalRecordRetireParams,
  ): Promise<boolean> {
    const params = retirement;
    const inFlight: Promise<unknown>[] = [];
    const metadataDirectories = new Set<string>();
    const detached = new Set<string>();
    for (const scope of Array.from(this.scopes.values())) {
      if (
        scope.projectId !== params.projectId ||
        (params.worktreeId !== undefined &&
          scope.worktreeId !== params.worktreeId) ||
        !params.lifetimeIds?.includes(scope.lifetimeId)
      )
        continue;
      inFlight.push(...scope.sends);
      for (const receipts of scope.loadReceipts) receipts.length = 0;
      scope.loadReceipts.clear();
      if (scope.timer !== undefined) clearTimeout(scope.timer);
      this.scopes.delete(scope.key);
      this.readRevisions.set(
        scope.key,
        (this.readRevisions.get(scope.key) ?? 0) + 1,
      );
      metadataDirectories.add(scope.metadataAdmission.directory);
      detached.add(scope.key);
      // A partial character of the old lifetime never prefixes a new one.
      const prefix = decoderKey(scope.key, '');
      for (const key of Array.from(this.decoders.keys()))
        if (key.startsWith(prefix)) this.decoders.delete(key);
    }
    for (const session of Array.from(this.liveSessions.values()))
      if (detached.has(worktreeKey(session.projectId, session.worktreeId)))
        this.liveSessions.delete(session.id);
    for (const [terminalId, entry] of Array.from(this.index))
      if (
        detached.has(
          worktreeKey(entry.session.projectId, entry.session.worktreeId),
        )
      ) {
        this.index.delete(terminalId);
        this.revokeSeed(terminalId);
      }
    for (const [id, lease] of this.seeded)
      if (detached.has(lease.scope.key)) this.revokeSeed(id);
    // This run's and earlier runs' queued writes for it are dropped, with
    // their client: a new lifetime queues under its own.
    this.outboxState.scopes = this.outboxState.scopes.filter(
      (outbox) => !dropRetiredOutboxEntries(retirement, outbox),
    );
    this.outboxState.retirements.push(retirement);
    if (inFlight.length > 0)
      this.retirementBarriers.set(
        retirement,
        Promise.allSettled(inFlight).then(() => true),
      );
    this.outboxDirty = true;
    if (params.worktreeId === undefined) {
      if (
        !Array.from(this.scopes.values()).some(
          (scope) => scope.projectId === params.projectId,
        )
      )
        this.retiredProjects.add(params.projectId);
      for (const key of Array.from(this.revivedScopes))
        if (key.startsWith(`${params.projectId}/`))
          this.revivedScopes.delete(key);
    } else if (
      !this.scopes.has(worktreeKey(params.projectId, params.worktreeId))
    )
      this.retiredScopes.add(worktreeKey(params.projectId, params.worktreeId));
    this.reconcileRetries();
    let durable = await this.persistOutbox();
    const draining = this.drainRetirements();
    // Never memory-only (q-26): an unwritten retirement must reach the
    // authority, or a retried write land, first. Bounded: never refused.
    if (!durable) {
      await withTimeout(draining, LOAD_DRAIN_BOUND_MS);
      durable =
        !this.outboxState.retirements.includes(retirement) ||
        (await this.persistOutbox());
    }
    await Promise.all(
      Array.from(metadataDirectories, (path) => drainDirectoryEffects(path)),
    );
    return durable;
  }

  /** Replays an exact journaled intent, never the current worktree lifetime. */
  public async replayTerminalRecordRetirement(
    retirement: WorkerTerminalRecordRetireParams,
  ): Promise<boolean> {
    await this.whenStarted();
    this.outboxState.scopes = this.outboxState.scopes.filter(
      (outbox) => !dropRetiredOutboxEntries(retirement, outbox),
    );
    if (
      !this.outboxState.retirements.some(
        (entry) => JSON.stringify(entry) === JSON.stringify(retirement),
      )
    )
      this.outboxState.retirements.push(retirement);
    this.outboxDirty = true;
    this.reconcileRetries();
    const durable = await this.persistOutbox();
    void this.drainRetirements();
    return durable;
  }

  /**
   * The incarnation and generation a worktree retirement is limited to: the
   * caller's incarnation, else the one this run resolved, and the newest
   * generation this run saw. Unknown ones are left out, as before.
   */
  private retirementFence(params: {
    projectId: string;
    worktreeId?: string;
    incarnation?: string | null;
  }): Pick<WorkerTerminalRecordRetireParams, 'incarnation' | 'generation'> {
    if (params.worktreeId === undefined)
      return params.incarnation !== undefined
        ? { incarnation: params.incarnation }
        : {};
    const scope = this.scopes.get(
      worktreeKey(params.projectId, params.worktreeId),
    );
    const incarnation = params.incarnation ?? scope?.incarnation;
    const generation = scope?.generation ?? null;
    return {
      ...(incarnation !== undefined && { incarnation }),
      ...(generation !== null && { generation }),
    };
  }

  /** Kept for the worktree cleanup fence's callers: retires the record. */
  public forgetWorktree(projectId: string, worktreeId: string): void {
    void this.retireTerminalRecord({ projectId, worktreeId });
  }

  private drainRetirements(): Promise<void> {
    const settled = (this.retirementsDraining ?? Promise.resolve())
      .then(() => this.drainRetirementsOnce())
      .catch(() => undefined);
    this.retirementsDraining = settled;
    void settled.then(() => {
      if (this.retirementsDraining === settled)
        this.retirementsDraining = undefined;
    });
    return settled;
  }

  private async drainRetirementsOnce(): Promise<void> {
    await this.whenStarted();
    if (!this.earlierMerged || this.sealed !== null) return;
    if (
      this.outboxState.retirements.length === 0 ||
      !(await this.records.available())
    )
      return;
    for (const retirement of this.outboxState.retirements.slice()) {
      await this.waitForRetirementBarrier(retirement);
      if (this.sealed !== null) return;
      try {
        // Zero is final: absent scopes and successor fences need no retry.
        await this.records.retire(retirement);
      } catch (error) {
        // One the authority can never accept is dropped, logged, rather
        // than hold every retirement and the worktree's writes behind it.
        if (errorKind(error) !== 'invalid_argument') return;
        logMainProcessWarn(
          'Dropped a terminal record retirement it rejects',
          {},
        );
      }
      const index = this.outboxState.retirements.indexOf(retirement);
      if (index >= 0) this.outboxState.retirements.splice(index, 1);
      await this.persistOutbox();
    }
  }

  /**
   * Waits, at most once and bounded, for the sends a retirement must follow.
   * A send that never settles then delays the retirement, and every drain
   * behind it, by the bound only; if it lands later, it may leave a record
   * behind, which beats stalling every record write.
   */
  private async waitForRetirementBarrier(
    retirement: WorkerTerminalRecordRetireParams,
  ): Promise<void> {
    const barrier = this.retirementBarriers.get(retirement);
    if (!barrier) return;
    const settled = await withTimeout(
      barrier,
      this.options.retirementBarrierBoundMs ?? RETIREMENT_BARRIER_BOUND_MS,
    );
    this.retirementBarriers.delete(retirement);
    if (settled === null)
      logMainProcessWarn(
        'Retiring a terminal record before an earlier write settled',
        {},
      );
  }

  /** Quit's daemon stage: the authority stamps its live daemon terminals. */
  public async shutdownDaemonTerminals(
    signal: WorkerTerminalRecordShutdownParams['signal'],
  ): Promise<void> {
    if (this.recordedIds.size === 0) return;
    await withTimeout(
      this.records.shutdown(signal).catch(() => undefined),
      1_000,
    );
  }

  /** Installs every pending presentation now: quit and tests. */
  public flushAllSync(): void {
    for (const scope of this.scopes.values())
      this.installPresentation(scope, this.sealed !== null);
  }
}

/** The shadow keeps no output; ops without output change it as they will the record. */
function stripOutput(op: WorkerTerminalRecordOp): WorkerTerminalRecordOp {
  if (op.op === 'output.append') return { ...op, text: '' };
  if (op.op === 'output.replace') return { ...op, lines: [] };
  return op;
}

function isShutdown(signal: string | null): boolean {
  return signal === 'app-quit' || signal === 'fatal-exit';
}

export const terminalPersistenceStore = new TerminalPersistenceStore({
  outboxRoot: getTerminalOutboxDataRoot,
  incarnation: worktreeIncarnation,
  // The host binds its read policy at startup, before registering IPC.
  scopeExists: (): Promise<boolean> => Promise.resolve(false),
});
