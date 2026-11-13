import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  MEMORY_CONSOLIDATION_PACKAGE_VERSION,
  MEMORY_CONSOLIDATION_PROMPT_VERSION,
} from '@canopy/memory-consolidation/version';
import type {
  ConsolidationInput,
  ConsolidationOutput,
} from '@canopy/memory-consolidation/input';
import { isConsolidationInputClean } from '@canopy/memory-consolidation/input';
import type { MemoryConsolidationResult } from '@canopy/memory-consolidation/run';
import type { ScopeTopicInventory } from '@canopy/memory-consolidation/topic-identity';
import {
  MEMORY_SYNC_PROTOCOL_VERSION,
  MEMORY_SYNC_PRIVATE_DIRNAME,
  MEMORY_SYNC_STATE_FILENAME,
  MEMORY_SYNC_TIMINGS,
  checkMemoryChangesPage,
  isMemoryNoteOriginBlocked,
  memoryDocumentRefusal,
  portableFileNameIdentity,
  type MemoryAccountPolicy,
  type MemoryCommitRequest,
  type MemoryCommitResponse,
  type MemoryDevicePlatformSchema,
  type MemoryDocument,
  type MemoryDocumentChange,
  type MemoryNoteOp,
  type MemoryNoteOpResult,
  type MemoryNoteRecord,
  type MemoryOriginPolicy,
  type MemoryProjectSettingList,
  type MemoryRevisionRecord,
  type MemoryScopeRef,
  type MemorySyncSettings,
  type MemorySyncStateFile,
} from '@canopy/protocol/memory-sync';
import { z } from 'zod';
import { withMemoryWriteLock } from '../local/edit-coordination';
import { isNodeError, writeMemoryFileAtomically } from '../local/memory-files';
import { memoryNoteIdAt } from '../local/note-identity';
import {
  beginLocalMemoryConsolidationRun,
  endLocalMemoryConsolidationRun,
  isLocalMemoryConsolidationRunning,
} from '../local/consolidation-run-tracker';
import {
  LocalMemoryReplicaUnavailableError,
  type LocalMemorySyncedCommitOutcome,
  type LocalMemorySyncedConsolidation,
} from '../local/replica-hooks';
import { createReplicaManifest } from '../local/scope-manifest';
import { markMemoryNotesLocalOnly } from './outbox';
import {
  readReplicaConflict,
  settleReplicaConflict,
  type MemoryReplicaConflictView,
} from './conflicts';
import {
  documentChanges,
  firstEnableMergeInput,
  firstEnableNotes,
  firstEnableUpload,
  freeNoteFileKey,
  hasDistinctDocumentIdentities,
  hasFirstEnableSource,
  isFirstEnableNoteHeldBack,
  lateFirstEnableNotes,
  mergedDocuments,
  firstEnableReview,
  readFirstEnableSource,
  readReplicaInboxNotes,
  scopeFolderHasMemory,
  MemoryFirstEnableReviewSchema,
  type MemoryFirstEnableReview,
  type MemoryFirstEnableInboxNote,
  type MemoryFirstEnableSource,
  type MemoryMergeDocument,
} from './first-enable';
import { queueConflictNotes } from './conflict-notes';
import { collectReplicaEdits } from './manual-edits';
import {
  LocalMemoryScopeLockTimeoutError,
  acquireMemoryScopeLock,
  withMemoryScopeLock,
  type MemoryScopeLock,
} from '../local/scope-lock';
import {
  finishMemoryLocalDeletes,
  queueMemoryNoteOp,
  readQueuedMemoryNoteOps,
  recordMemoryUsageDeltas,
  settleMemoryPush,
  settleMemoryUsagePush,
  takeMemoryPushBatch,
  takeMemoryUsagePush,
} from './outbox';
import type { ProjectMemoryScopeTarget } from './project-scopes';
import {
  initialMemorySyncState,
  readMemoryReplicaAccount,
  readMemorySyncState,
  rebindMemoryReplicaFiles,
  writeMemoryReplicaAccount,
  writeMemorySyncState,
  type MemoryReplicaBinding,
} from './replica-files';
import {
  memoryReplicaAccountDir,
  memoryReplicaProjectsDir,
  memoryReplicaScopeDir,
  memoryScopeKey,
} from './replica-layout';
import type { MemoryReplicaRegistry } from './replica-registry';
import {
  MemoryReplicaGapError,
  applyMemoryReplicaChanges,
  applyMemoryReplicaCommit,
  applyMemoryReplicaSnapshot,
  listConsumableNotes,
  type MemoryReplicaApplyResult,
  type MemoryReplicaWriteOptions,
} from './replica-writer';
import type {
  MemorySyncFailure,
  MemorySyncResult,
  MemorySyncTransport,
} from './transport';

/*
 * The desktop memory sync engine for one account (design §8–§10, §16). It
 * keeps that account's replicas in step with Canopy Cloud: it registers this
 * launch's device session, creates a replica from the cloud snapshot, pulls
 * the change feed (on a nudge, every five minutes, on resume) and pushes each
 * scope's outbox, one pass at a time and off every turn's path.
 *
 * It holds no Electron handle: the file system is the replica, and the
 * transport, timers and clock are passed in (D15), so it can move to the core
 * daemon. Only the holder of the account's sync engine lock
 * (`memory-replicas/<accountId>/.lock`) runs passes; another process on the
 * same data saves notes into the replica and its outbox and leaves sending
 * to the holder.
 */

type MemoryDevicePlatform = z.output<typeof MemoryDevicePlatformSchema>;

export interface MemorySyncDevice {
  deviceId: string;
  installationGeneration: number;
  /** Minted once per launch. */
  sessionNonce: string;
  label: string;
  platform: MemoryDevicePlatform;
  appVersion: string;
}

export interface MemorySyncTimer {
  cancel(): void;
}

export interface MemorySyncEngineTiming {
  launchQuietMs: number;
  pushDebounceMs: number;
  pullFallbackIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  serverRetryAfterMaxMs: number;
}

export const MEMORY_SYNC_ENGINE_TIMING: MemorySyncEngineTiming = {
  launchQuietMs: MEMORY_SYNC_TIMINGS.launchQuietMs,
  pushDebounceMs: MEMORY_SYNC_TIMINGS.pushDebounceMs,
  pullFallbackIntervalMs: MEMORY_SYNC_TIMINGS.pullFallbackIntervalMs,
  retryBaseMs: MEMORY_SYNC_TIMINGS.retryBaseMs,
  retryMaxMs: MEMORY_SYNC_TIMINGS.retryMaxMs,
  serverRetryAfterMaxMs: MEMORY_SYNC_TIMINGS.serverRetryAfterMaxMs,
};

export type MemorySyncEngineState =
  /** Waiting for its first pass. */
  | 'starting'
  | 'running'
  /** Another process on this data runs the engine for the account. */
  | 'standby'
  /** Sync is off for the account; replicas keep working locally. */
  | 'paused'
  /** Memory sync is not available to the account (rollout). */
  | 'unavailable'
  /** The server needs a newer app; local memory keeps working. */
  | 'update_required'
  | 'stopped';

export type MemorySyncScopeMode =
  | MemorySyncStateFile['mode']
  /** Device-local memory exists; merging it is the first-enable flow. */
  | 'needs_first_enable';

export interface MemorySyncScopeStatus {
  scope: MemoryScopeRef;
  mode: MemorySyncScopeMode;
  queuedOps: number;
  localOnlyNotes: number;
  conflicts: number;
  lastPulledAt: string | null;
  lastPushedAt: string | null;
  lastError: { code: string; at: string } | null;
}

export interface MemorySyncEngineStatus {
  accountId: string;
  state: MemorySyncEngineState;
  /** Why the engine stopped or pauses, as a code. */
  reason: string | null;
  /** The last pass failed and the engine is backing off (often offline). */
  retrying: boolean;
  scopes: MemorySyncScopeStatus[];
}

/** A content-free event for diagnostics: a kind and a code, never an ID. */
export interface MemorySyncProblem {
  kind:
    | 'page_check'
    | 'replica_gap'
    | 'replica_unreadable'
    | 'commit_refused'
    | 'push_refused'
    | 'usage_refused'
    | 'snapshot_inconsistent'
    | 'pass_failed'
    | 'local_edit_unsettled'
    | 'project_scopes'
    | 'project_replica'
    | 'stopped';
  code: string;
}

export interface MemorySyncEngineOptions {
  accountId: string;
  /** `<data>/memory-replicas`. */
  replicasRoot: string;
  transport: MemorySyncTransport;
  device: MemorySyncDevice;
  registry: MemoryReplicaRegistry;
  /**
   * The scope's device-local folder. A replica is created on its own only
   * when that folder holds no memory; otherwise merging it is the first
   * enable flow's job (design §17).
   */
  deviceLocalDir: (scope: MemoryScopeRef) => string | null;
  now?: () => number;
  /** In [0, 1); jitters a retry. */
  random?: () => number;
  setTimer?: (run: () => void, delayMs: number) => MemorySyncTimer;
  timing?: Partial<MemorySyncEngineTiming>;
  onStatusChanged?: (status: MemorySyncEngineStatus) => void;
  /** A pull wrote into the scope's replica: what shows it should refresh. */
  onScopeChanged?: (scope: MemoryScopeRef) => void;
  /**
   * A consolidation run ended without a commit for a reason the next run may
   * not meet (memory moved on, the lease was held or lost, the network): run
   * the scope's consolidation again after `delayMs` (design §12.1 step 8).
   */
  requestConsolidation?: (scope: MemoryScopeRef, delayMs: number) => void;
  recordProblem?: (problem: MemorySyncProblem) => void;
  /** Content-free sync measures (design §20). */
  recordMetric?: (metric: MemorySyncMetric) => void;
  /**
   * The account's project memory scopes, as the workspaces bound to cloud
   * projects stand now (design §22). A rejection keeps every project scope
   * from syncing that pass. Without it the engine keeps the user scope only.
   */
  projectScopes?: () => Promise<readonly ProjectMemoryScopeTarget[]>;
  /**
   * One project scope as its workspace's files stand now, read again right
   * before anything is sent to it; null when no single workspace of the
   * account maps to it. Without it the engine reads `projectScopes`.
   */
  projectScope?: (
    projectId: string,
  ) => Promise<ProjectMemoryScopeTarget | null>;
  /**
   * Whether the account is still the one signed in and syncing here, asked
   * right before anything is sent to any of its scopes.
   */
  accountEligible?: () => boolean;
  /** The account's per-project modes changed, as read or as set here. */
  onProjectModesChanged?: () => void;
}

/**
 * A project scope waiting for the first-enable merge (design §17, §22): its
 * workspace's device-local folder holds memory, so the engine creates no
 * replica on its own and uploads nothing. The first-enable flow reviews and
 * merges `sourceDir` into `scope`.
 */
export interface ProjectFirstEnableCandidate {
  scope: Extract<MemoryScopeRef, { kind: 'project' }>;
  workspaceId: string;
  sourceDir: string;
}

/** A project replica on disk, by the project its binding names. */
interface ProjectReplica {
  dir: string;
  projectId: string;
  scopeId: string;
}

/** How a leased consolidation ended, for the retry it may ask for. */
interface ConsolidationEnd {
  retry: boolean;
  retryAfterMs?: number;
}
export type MemorySyncMetric =
  | { kind: 'delay'; delayMs: number }
  | {
      kind: 'merge';
      outcome: keyof MemoryReplicaApplyResult['merges'];
      count: number;
    }
  | { kind: 'consolidation'; status: string; durationMs: number }
  | {
      kind: 'first_enable';
      mode: MemoryFirstEnableKind;
      outcome: string;
    };

/**
 * What a scope's pass may send, as it stood when the pass reached the scope
 * (design §22). A binding, private memory or mode change of the scope after
 * `generation` ends it before its next write, and aborts `signal`.
 */
interface ScopeFence {
  scope: MemoryScopeRef;
  key: string;
  generation: number;
  /** The workspace a project scope syncs for; null for the user scope. */
  workspaceId: string | null;
  signal: AbortSignal;
}

/** Asked under the replica's lock right before a write is sent. */
interface WriteGate {
  maySend: () => Promise<boolean>;
  refused: boolean;
}

/** A scope stopped syncing while its pass ran: nothing more is sent to it. */
class MemoryScopeFencedError extends Error {
  constructor() {
    super('The memory scope no longer syncs');
    this.name = 'MemoryScopeFencedError';
  }
}

type PassOutcome =
  | { kind: 'ok' }
  | { kind: 'retry'; retryAfterMs?: number }
  | { kind: 'standby' }
  | { kind: 'halt'; state: MemorySyncEngineState; reason: string };

/** How one scope's sync ended: a pass outcome, or a retry of that scope only. */
type ScopeOutcome =
  | PassOutcome
  | { kind: 'scope_retry'; retryAfterMs?: number };

/** Retry codes about the connection or the whole account, not one scope. */
const ACCOUNT_RETRY_CODES: ReadonlySet<string> = new Set([
  'network',
  'memory_ingest_disabled',
  'memory_rate_limited',
]);

/**
 * Whether a failure concerns the account or the connection (the session,
 * sign-in, the server, the network, rate limits) and so ends the pass, rather
 * than one scope, which waits on its own while the others sync.
 */
function isAccountWide(failure: MemorySyncFailure): boolean {
  switch (failure.kind) {
    case 'register':
    case 'stop':
    case 'update_required':
    case 'unavailable':
    case 'paused':
      return true;
    case 'retry':
      return (
        ACCOUNT_RETRY_CODES.has(failure.code) ||
        failure.code.startsWith('http_')
      );
    default:
      return false;
  }
}

/** A control's answer: done, or a code the settings and panel explain. */
export type MemorySyncControlResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; code: string };

export type MemorySyncSettingsPatch = Partial<
  Pick<
    MemorySyncSettings,
    'enabled' | 'userScope' | 'defaultProjectScope' | 'serverConsolidation'
  >
>;

/**
 * Runs the first-enable merge consolidation without writing anything.
 * `scopeTopics` is the cloud scope's whole topic set, which the input's own
 * topics are only the budgeted part of.
 */
export type MemoryFirstEnableMergeRunner = (
  input: ConsolidationInput,
  scopeTopics: ScopeTopicInventory,
  scopeDir: string,
) => Promise<{
  output: ConsolidationOutput | null;
  consumedFileKeys: string[];
  model: { modelId: string; thinkingLevel?: string } | null;
  reason?: string;
}>;

/**
 * What a first enable does with the two sets of memory: upload this
 * device's to an empty cloud scope, merge them, or keep the cloud's as it
 * is because nothing of this device's is left to merge.
 */
export type MemoryFirstEnableKind = 'upload' | 'merge' | 'keep';

export interface MemoryFirstEnablePreview {
  previewId: string;
  kind: MemoryFirstEnableKind;
  cloud: MemoryMergeDocument[];
  device: MemoryMergeDocument[];
  result: MemoryMergeDocument[];
  deviceNotes: number;
  /**
   * Notes that stay on this device: those an organization keeps off the
   * cloud, and those the cloud refused on an earlier try of this first
   * enable, which `sync-state.json` records as local-only.
   */
  keptOnDevice: number;
  skipped: number;
  /** Memory that is not UTF-8 text, part of {@link skipped}. */
  skippedNotText: number;
  /**
   * Documents a commit cannot carry that go up as ordered notes instead,
   * for the next consolidation to fold in. Not part of {@link skipped}:
   * their content reaches the cloud.
   */
  tooLargeAsNotes: number;
}

/** What an applied first enable left, for what the person is told. */
export interface MemoryFirstEnableApplied {
  /** Notes the cloud refused, which stay on this device only. */
  refusedNotes: number;
}

interface PendingFirstEnable {
  id: string;
  scopeKey: string;
  kind: MemoryFirstEnableKind;
  baseRevision: number;
  sourceDir: string;
  /**
   * The workspace a project scope's memory was read from; null for the user
   * scope. The apply reads the binding again and refuses when it no longer
   * names this workspace, so a project relinked during the review never
   * takes another project's memory (design §22).
   */
  workspaceId: string | null;
  /** What the review showed, to find what was saved after it. */
  review: MemoryFirstEnableReview;
  fingerprint: string;
  /**
   * Every note the merge read, consumed or not, with its organization: a
   * merge may carry any of them into a document, so the apply refuses one
   * that must stay on this device now.
   */
  inputNotes: ReadonlyArray<{ noteId: string; organizationId: string | null }>;
  /** Inbox notes that stay on this device: held back or local-only. */
  keptOnDeviceIds: string[];
  /** This device's inbox notes, written into the replica and queued. */
  inbox: MemoryFirstEnableInboxNote[];
  /** Import notes for a merge, queued without a file. */
  imports: MemoryNoteOp[];
  changes: MemoryDocumentChange[];
  consumedNoteIds: string[];
  inputHash: string | null;
  model: { modelId: string; thinkingLevel?: string } | null;
  cloud: MemoryMergeDocument[];
  device: MemoryMergeDocument[];
  result: MemoryMergeDocument[];
  deviceNotes: number;
  keptOnDevice: number;
  skipped: number;
  skippedNotText: number;
  tooLargeAsNotes: number;
}

/** First enable gives up on notes still queued after this many pushes. */
const FIRST_ENABLE_PUSH_ROUNDS = 20;

/** Replicas moved aside under the account; nothing removes them. */
const RETIRED_DIRNAME = '.retired';

/**
 * What an applied first enable reviewed, kept in its replica until it is
 * done, so the memory saved after the review is carried over even after a
 * restart (design §17).
 */
const FirstEnableReviewFileSchema = z.looseObject({
  version: z.literal(1),
  kind: z.enum(['upload', 'merge', 'keep']),
  review: MemoryFirstEnableReviewSchema,
});

function firstEnableReviewFile(dir: string): string {
  return join(dir, MEMORY_SYNC_PRIVATE_DIRNAME, 'first-enable-review.json');
}

/**
 * The memory a first enable sends, read under its folder's scope lock so a
 * write in progress there is never seen half done; null while a local
 * consolidation, rebuild or restore of that folder runs, which leaves it
 * changing for a while, unless the caller reserved the folder itself.
 */
async function readFirstEnableSourceSettled(
  sourceDir: string,
  reserved = false,
): Promise<MemoryFirstEnableSource | null> {
  if (!reserved && isLocalMemoryConsolidationRunning(sourceDir)) return null;
  if (!(await pathExists(sourceDir))) return readFirstEnableSource(sourceDir);
  try {
    return await withMemoryScopeLock(sourceDir, () =>
      readFirstEnableSource(sourceDir),
    );
  } catch (error) {
    if (error instanceof LocalMemoryScopeLockTimeoutError) return null;
    throw error;
  }
}

/** Which folder in `.retired/` a pending re-enable sends. */
const RetiredSourceRecordSchema = z.looseObject({
  version: z.literal(1),
  dir: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

function noteIdOf(op: MemoryNoteOp): string {
  return op.op === 'tombstone' ? op.noteId : op.note.noteId;
}

function isMergeOutcome(
  value: string,
): value is keyof MemoryReplicaApplyResult['merges'] {
  return ['theirs', 'ours', 'same', 'merged', 'conflict'].includes(value);
}

function failureCode(failure: MemorySyncFailure): string | null {
  return 'code' in failure && typeof failure.code === 'string'
    ? failure.code
    : null;
}

function controlResultOf(failure: MemorySyncFailure): {
  ok: false;
  code: string;
} {
  switch (failure.kind) {
    case 'retry':
      return {
        ok: false,
        code: failure.code === 'memory_busy' ? 'memory_busy' : 'offline',
      };
    case 'unavailable':
      return { ok: false, code: 'offline' };
    case 'paused':
      return { ok: false, code: 'sync_off' };
    case 'update_required':
      return { ok: false, code: 'update_required' };
    default:
      return { ok: false, code: failureCode(failure) ?? failure.kind };
  }
}

interface LeaseRun {
  lost: boolean;
  committed: boolean;
  /** Ended for a reason the next run may not meet: run again later. */
  retry: boolean;
  /** Released: no renewal may be scheduled any more. */
  done: boolean;
  renewal: MemorySyncTimer | null;
}

function leaseOutcome(
  committed: boolean,
  result: MemoryConsolidationResult | null,
): Parameters<MemorySyncTransport['releaseLease']>[1]['outcome'] {
  if (committed) return 'committed';
  switch (result?.status) {
    case 'clean':
      return 'clean';
    case 'failed':
    case 'invalid-output':
      return 'failed';
    default:
      return 'abandoned';
  }
}

/** A failure another attempt may not meet. */
function isTransient(failure: MemorySyncFailure): boolean {
  return (
    failure.kind === 'retry' ||
    failure.kind === 'conflict' ||
    failure.kind === 'snapshot' ||
    failure.kind === 'register'
  );
}

/**
 * How long a consolidation that ended worth retrying waits before the next
 * run: the idle debounce, doubled for each such run in a row, up to the
 * per-scope interval, and never less than the server asked.
 */
function consolidationRetryDelay(
  attempt: number,
  retryAfterMs: number | undefined,
): number {
  const cap = MEMORY_SYNC_TIMINGS.consolidationMinIntervalMs;
  const backoff = Math.min(
    MEMORY_SYNC_TIMINGS.desktopIdleDebounceMs * 2 ** (attempt - 1),
    cap,
  );
  return Math.max(backoff, Math.min(retryAfterMs ?? 0, cap));
}

const MAX_PAGES_PER_PASS = 1_000;
const MAX_PUSHES_PER_PASS = 100;
const USER_SCOPE: MemoryScopeRef = { kind: 'user' };

type ProjectScopeRef = Extract<MemoryScopeRef, { kind: 'project' }>;

function projectScopeRef(projectId: string): ProjectScopeRef {
  return { kind: 'project', projectId };
}

/** Whether a replica's binding names `scope` for `accountId`. */
function bindsScope(
  binding: MemoryReplicaBinding,
  accountId: string,
  scope: MemoryScopeRef,
): boolean {
  return (
    binding.accountId === accountId &&
    binding.kind === scope.kind &&
    binding.projectId === (scope.kind === 'project' ? scope.projectId : null)
  );
}

function sameProjectModes(
  left: ReadonlyMap<string, string> | null,
  right: ReadonlyMap<string, string> | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.size !== right.size) return false;
  for (const [projectId, mode] of left) {
    if (right.get(projectId) !== mode) return false;
  }
  return true;
}

function emptyScopeStatus(
  scope: MemoryScopeRef,
  mode: MemorySyncScopeMode,
): MemorySyncScopeStatus {
  return {
    scope,
    mode,
    queuedOps: 0,
    localOnlyNotes: 0,
    conflicts: 0,
    lastPulledAt: null,
    lastPushedAt: null,
    lastError: null,
  };
}

function defaultSetTimer(run: () => void, delayMs: number): MemorySyncTimer {
  const handle = setTimeout(run, delayMs);
  handle.unref();
  return {
    cancel: (): void => {
      clearTimeout(handle);
    },
  };
}

function isReady(state: MemorySyncStateFile): boolean {
  return (
    state.cursor !== null &&
    (state.firstEnable === null || state.firstEnable.state === 'done')
  );
}

/** A replica created here that has not been registered for the first time. */
function awaitsFirstEnable(state: MemorySyncStateFile): boolean {
  return state.firstEnable !== null && state.firstEnable.state !== 'done';
}

function firstEnableStarted(
  at: Date,
): NonNullable<MemorySyncStateFile['firstEnable']> {
  return {
    state: 'uploading',
    startedAt: at.toISOString(),
    preMergeRevision: null,
  };
}

function abortError(): Error {
  const error = new Error('Memory sync pass cancelled');
  error.name = 'AbortError';
  return error;
}

export class MemorySyncEngine {
  private readonly timing: MemorySyncEngineTiming;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (
    run: () => void,
    delayMs: number,
  ) => MemorySyncTimer;
  private readonly accountDir: string;
  private engineState: MemorySyncEngineState = 'starting';
  private reason: string | null = null;
  private lock: MemoryScopeLock | null = null;
  /** The release of a lock a halt gave up, which `stop` waits for. */
  private lockReleased: Promise<void> = Promise.resolve();
  private deviceSessionId: string | null = null;
  private settings: MemorySyncSettings | null = null;
  private policy: MemoryAccountPolicy | null = null;
  private quietUntil = 0;
  /** After a failed pass, no trigger runs another before this time. */
  private retryNotBefore = 0;
  private timer: MemorySyncTimer | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private running: Promise<void> | null = null;
  private rerunAt: number | null = null;
  private failures = 0;
  private controller = new AbortController();
  private stopped = false;
  /** Stopped by the server (a newer client, another session): no more passes. */
  private halted = false;
  /** A halt a leased run met, for the next pass to apply. */
  private pendingHalt: PassOutcome | null = null;
  private exclusiveTail: Promise<void> = Promise.resolve();
  /** The reviewed first enable of each scope, by scope key, until applied. */
  private readonly firstEnables = new Map<string, PendingFirstEnable>();
  /** A pending re-enable's deleted copy this engine serves, by scope key. */
  private readonly retiredServed = new Map<string, string>();
  private readonly scopeStatus = new Map<string, MemorySyncScopeStatus>();
  /** Consolidation runs in a row that ended worth retrying, by scope key. */
  private readonly consolidationRetries = new Map<string, number>();
  /** The account's project replicas on disk, by the project each names. */
  private projectReplicas = new Map<string, ProjectReplica>();
  /** Projects more than one replica on disk names: none of them is used. */
  private contestedProjects = new Set<string>();
  /** The projects bound workspaces map to, as the last pass read them. */
  private targetedProjects = new Set<string>();
  /** The account's per-project modes as last read; null before a read. */
  private projectModes: Map<string, 'sync' | 'device_only'> | null = null;
  /** "Keep memory on this device" asked for here and not answered yet. */
  private readonly requestedProjectModes = new Map<
    string,
    'sync' | 'device_only'
  >();
  /** Counts eligibility changes; a fence holds while nothing changed after it. */
  private eligibilityClock = 0;
  /** When each scope's eligibility last changed, by scope key. */
  private readonly scopeChangedAt = new Map<string, number>();
  /** When a change that may concern any project scope last happened. */
  private projectsChangedAt = 0;
  /** Aborts the requests of a scope's pass when its eligibility changes. */
  private readonly scopeControllers = new Map<string, AbortController>();
  /** Project scopes whose change waits to be applied outside a pass. */
  private pendingSettle: Set<string> | 'all' | null = null;
  /** Scopes waiting out a failure of their own, by scope key. */
  private readonly scopeRetries = new Map<
    string,
    { failures: number; notBefore: number }
  >();

  constructor(private readonly options: MemorySyncEngineOptions) {
    this.timing = { ...MEMORY_SYNC_ENGINE_TIMING, ...options.timing };
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.accountDir = memoryReplicaAccountDir(
      options.replicasRoot,
      options.accountId,
    );
  }

  get accountId(): string {
    return this.options.accountId;
  }

  /** This device's name, as its notes record it. */
  get deviceLabel(): string {
    return this.options.device.label;
  }

  /**
   * Registers the account's ready replicas, so the resolver finds them now.
   * Reads local files only. Every standby pass runs it again, so a process
   * that lost the lock race finds a replica the holder made ready later.
   */
  async loadReplicas(): Promise<void> {
    await this.registerReplica(USER_SCOPE);
    const targets = await this.readProjectTargets();
    await this.scanProjectReplicas();
    for (const target of targets ?? []) {
      if (!this.contestedProjects.has(target.scope.projectId)) {
        await this.registerReplica(target.scope);
      }
    }
  }

  /** The bound project scopes, or null when they cannot be read now. */
  private async readProjectTargets(): Promise<
    readonly ProjectMemoryScopeTarget[] | null
  > {
    if (this.options.projectScopes === undefined) return [];
    try {
      return await this.options.projectScopes();
    } catch (error) {
      this.options.recordProblem?.({
        kind: 'project_scopes',
        code: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    }
  }

  /**
   * Finds the account's project replicas on disk by the project their
   * binding names, which is the folder's own name unless the cloud keyed
   * its scope to another project since. A project two folders name is used
   * by neither (fail closed).
   */
  private async scanProjectReplicas(): Promise<void> {
    const root = memoryReplicaProjectsDir(
      this.options.replicasRoot,
      this.options.accountId,
    );
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTDIR')) {
        throw error;
      }
      names = [];
    }
    const found = new Map<string, ProjectReplica[]>();
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const dir = join(root, name);
      const state = await readMemorySyncState(dir).catch(() => null);
      if (state === undefined || state === null) continue;
      const { binding } = state;
      if (
        binding.accountId !== this.options.accountId ||
        binding.kind !== 'project' ||
        binding.projectId === null
      ) {
        continue;
      }
      found.set(binding.projectId, [
        ...(found.get(binding.projectId) ?? []),
        { dir, projectId: binding.projectId, scopeId: binding.scopeId },
      ]);
    }
    const replicas = new Map<string, ProjectReplica>();
    const contested = new Set<string>();
    for (const [projectId, dirs] of found) {
      const [only, ...others] = dirs;
      if (only !== undefined && others.length === 0) {
        replicas.set(projectId, only);
        continue;
      }
      contested.add(projectId);
      for (const replica of dirs)
        this.options.registry.unregisterDir(replica.dir);
      this.options.recordProblem?.({
        kind: 'project_replica',
        code: 'contested',
      });
    }
    this.projectReplicas = replicas;
    this.contestedProjects = contested;
  }

  /**
   * Settles the local deletes and edits cut short in every replica of this
   * account, whatever the pass does next: sync off, a device-only or deleted
   * scope, a failed request and standby all return before the scope syncs.
   */
  private async finishLocalDeletes(): Promise<void> {
    await this.scanProjectReplicas();
    const dirs = [
      this.scopeDir(USER_SCOPE),
      ...[...this.projectReplicas.values()].map((replica) => replica.dir),
    ];
    for (const dir of dirs) {
      const state = await readMemorySyncState(dir);
      if (
        state === undefined ||
        state === null ||
        state.binding.accountId !== this.options.accountId
      ) {
        continue;
      }
      const unsettled = await finishMemoryLocalDeletes(
        dir,
        new Date(this.now()),
      );
      if (unsettled > 0) {
        this.options.recordProblem?.({
          kind: 'local_edit_unsettled',
          code: 'replacement_missing',
        });
      }
      await this.queueConflictNotes(dir, state.binding);
    }
  }

  /**
   * Finishes the conflict notes a crash cut short or an earlier build never
   * queued (see {@link queueConflictNotes}); a failure waits for the next pass.
   */
  private async queueConflictNotes(
    dir: string,
    binding: MemoryReplicaBinding,
  ): Promise<void> {
    try {
      const queued = await withMemoryWriteLock(dir, () =>
        queueConflictNotes(
          dir,
          binding,
          {
            deviceId: this.options.device.deviceId,
            label: this.options.device.label,
          },
          new Date(this.now()),
        ),
      );
      if (queued > 0) this.requestPush();
    } catch (error) {
      this.options.recordProblem?.({
        kind: 'pass_failed',
        code: error instanceof Error ? error.name : 'conflict_notes',
      });
    }
  }

  /** Starts passes after the launch quiet period. Reads nothing before. */
  start(): void {
    if (this.stopped) return;
    this.quietUntil = this.now() + this.timing.launchQuietMs;
    this.schedule(0);
  }

  /** Cancels what is in flight and releases the account's engine lock. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    this.controller.abort();
    for (const controller of this.scopeControllers.values()) controller.abort();
    this.scopeControllers.clear();
    this.scopeRetries.clear();
    await this.running?.catch(() => undefined);
    await this.exclusiveTail;
    await this.lock?.release().catch(() => undefined);
    this.lock = null;
    await this.lockReleased;
    this.engineState = 'stopped';
    this.reason ??= 'stopped';
    this.emitStatus();
  }

  /**
   * A workspace's binding or private memory, or the account's mode for a
   * project, changed (design §22): a pass of those project scopes (of every
   * project scope without `projectIds`) sends nothing more, and a scope that
   * no longer syncs is kept as local memory now, its queued notes unsent.
   */
  projectEligibilityChanged(projectIds?: readonly string[]): void {
    if (projectIds?.length === 0) return;
    this.eligibilityClock += 1;
    if (projectIds === undefined) {
      this.projectsChangedAt = this.eligibilityClock;
      for (const [key, controller] of this.scopeControllers) {
        if (key === memoryScopeKey(USER_SCOPE)) continue;
        controller.abort();
        this.scopeControllers.delete(key);
      }
      for (const key of [...this.scopeRetries.keys()]) {
        if (key !== memoryScopeKey(USER_SCOPE)) this.scopeRetries.delete(key);
      }
    } else {
      for (const projectId of projectIds) {
        const key = memoryScopeKey(projectScopeRef(projectId));
        this.scopeChangedAt.set(key, this.eligibilityClock);
        this.scopeControllers.get(key)?.abort();
        this.scopeControllers.delete(key);
        this.scopeRetries.delete(key);
      }
    }
    this.settleProjectsSoon(projectIds);
  }

  /** A note changed here: push after the debounce. */
  requestPush(): void {
    this.schedule(this.timing.pushDebounceMs);
  }

  /** A nudge, a resume or a network change: pull now. */
  requestPull(): void {
    this.schedule(0);
  }

  /**
   * Runs a pass now, past the launch quiet period and any retry wait, once
   * any pass in flight has finished. Resolves with the status after it.
   */
  async syncNow(): Promise<MemorySyncEngineStatus> {
    if (this.stopped || this.halted) return this.status();
    await this.running?.catch(() => undefined);
    if (this.running === null && !this.stopped && !this.halted) {
      this.timer?.cancel();
      this.timer = null;
      this.timerAt = Number.POSITIVE_INFINITY;
      await this.runPass();
    }
    return this.status();
  }

  /**
   * The first-enable hook for project scopes (design §17, §22): every bound
   * project whose memory syncs and whose workspace still holds device-local
   * memory the cloud has not merged. The engine never creates such a
   * project's replica on its own; the first-enable flow reviews and merges
   * each candidate's `sourceDir` into its scope. Reads the bindings fresh.
   */
  async projectFirstEnableCandidates(): Promise<ProjectFirstEnableCandidate[]> {
    const targets = await this.firstEnableTargets();
    const candidates: ProjectFirstEnableCandidate[] = [];
    for (const target of targets) {
      const candidate = await this.firstEnableCandidate(target);
      if (candidate !== null) candidates.push(candidate);
    }
    return candidates;
  }

  /**
   * One project scope's first-enable source, read fresh, or null when the
   * scope may not be merged now: no longer bound by exactly one workspace of
   * this account, kept on this device, private, detached or moved, its modes
   * unread, its replica contested or already merged, or no device-local
   * memory left. The first-enable flow asks again right before it writes and
   * stops on null, so a binding that changed meanwhile never mixes memory.
   */
  async projectFirstEnableSource(
    scope: ProjectScopeRef,
  ): Promise<ProjectFirstEnableCandidate | null> {
    const target = (await this.firstEnableTargets()).find(
      (entry) => entry.scope.projectId === scope.projectId,
    );
    return target === undefined ? null : this.firstEnableCandidate(target);
  }

  private async firstEnableTargets(): Promise<
    readonly ProjectMemoryScopeTarget[]
  > {
    if (this.stopped || this.settings?.enabled !== true) return [];
    const targets = await this.readProjectTargets();
    if (targets === null) return [];
    await this.scanProjectReplicas();
    return targets;
  }

  private async firstEnableCandidate(
    target: ProjectMemoryScopeTarget,
  ): Promise<ProjectFirstEnableCandidate | null> {
    const { scope } = target;
    const settings = this.settings;
    if (
      settings === null ||
      this.contestedProjects.has(scope.projectId) ||
      this.projectScopeMode(target, settings) !== 'sync'
    ) {
      return null;
    }
    const state = await readMemorySyncState(this.scopeDir(scope)).catch(
      () => null,
    );
    if (state === null) return null;
    const rebinding = await this.awaitsRebinding(scope);
    if (state !== undefined) {
      if (!bindsScope(state.binding, this.options.accountId, scope)) {
        return null;
      }
      if (!awaitsFirstEnable(state) && !rebinding) return null;
    }
    // The memory a first enable of this project would send: the copy a
    // re-enable moved aside, else the workspace's own folder. A replica the
    // cloud deleted still gets its review and no-op apply, as the user
    // scope's does.
    const sourceDir = await this.firstEnableSourceDir(scope);
    if (sourceDir === null) return null;
    if (!(await this.firstEnableSourceHasMemory(scope)) && !rebinding) {
      return null;
    }
    return { scope, workspaceId: target.workspaceId, sourceDir };
  }

  /**
   * The account's mode for a project: its own choice, else the default for
   * projects; null until this engine has read them.
   */
  projectMode(projectId: string): 'sync' | 'device_only' | null {
    if (this.projectModes === null || this.settings === null) return null;
    return (
      this.projectModes.get(projectId) ?? this.settings.defaultProjectScope
    );
  }

  /**
   * Sets "keep memory on this device" for a project (design §22): the
   * account's choice, which every device honors. Refused while sync is off
   * for the account. Keeping memory on this device fences the project's
   * sync at once, before the cloud answers; the next pass applies the rest.
   */
  async setProjectMode(
    projectId: string,
    mode: 'sync' | 'device_only',
  ): Promise<MemorySyncResult<null>> {
    if (this.stopped || this.halted) {
      return { ok: false, failure: { kind: 'stop', code: 'stopped' } };
    }
    if (this.settings?.enabled !== true) {
      return {
        ok: false,
        failure: { kind: 'paused', code: 'memory_sync_disabled' },
      };
    }
    this.requestedProjectModes.set(projectId, mode);
    if (mode === 'device_only') this.projectEligibilityChanged([projectId]);
    let result: Awaited<ReturnType<MemorySyncTransport['setProjectSetting']>>;
    try {
      result = await this.options.transport.setProjectSetting(
        projectId,
        mode,
        this.controller.signal,
      );
    } finally {
      if (this.requestedProjectModes.get(projectId) === mode) {
        this.requestedProjectModes.delete(projectId);
      }
    }
    if (!result.ok) {
      if (mode === 'device_only') this.requestPull();
      return result;
    }
    if (this.projectModes !== null) {
      const before = this.projectMode(projectId);
      this.projectModes.set(projectId, mode);
      if (before !== mode) this.options.onProjectModesChanged?.();
    }
    this.requestPull();
    return { ok: true, value: null };
  }

  status(): MemorySyncEngineStatus {
    return {
      accountId: this.options.accountId,
      state: this.engineState,
      reason: this.reason,
      retrying: this.failures > 0,
      scopes: [...this.scopeStatus.values()],
    };
  }

  private emitStatus(): void {
    this.options.onStatusChanged?.(this.status());
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.halted) return;
    const at = Math.max(
      this.now() + delayMs,
      this.quietUntil,
      this.retryNotBefore,
    );
    if (this.running !== null) {
      this.rerunAt = Math.min(this.rerunAt ?? Number.POSITIVE_INFINITY, at);
      return;
    }
    if (this.timer !== null && this.timerAt <= at) return;
    this.timer?.cancel();
    this.timerAt = at;
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        this.timerAt = Number.POSITIVE_INFINITY;
        void this.runPass();
      },
      Math.max(0, at - this.now()),
    );
  }

  private runPass(): Promise<void> {
    if (this.stopped || this.running !== null) {
      return this.running ?? Promise.resolve();
    }
    this.running = this.exclusive(() => this.pass(this.controller.signal))
      .catch((error: unknown): PassOutcome => {
        if (error instanceof Error && error.name === 'AbortError') {
          return { kind: 'halt', state: 'stopped', reason: 'stopped' };
        }
        this.options.recordProblem?.({
          kind: 'pass_failed',
          code: error instanceof Error ? error.name : 'unknown',
        });
        return { kind: 'retry' };
      })
      .then((outcome) => {
        this.running = null;
        this.afterPass(outcome);
      });
    return this.running;
  }

  private afterPass(outcome: PassOutcome): void {
    let nextDelay: number | null;
    switch (outcome.kind) {
      case 'ok':
        this.failures = 0;
        this.retryNotBefore = 0;
        this.engineState = 'running';
        this.reason = null;
        nextDelay = Math.min(
          this.timing.pullFallbackIntervalMs,
          Math.max(
            this.nextScopeRetryAt() - this.now(),
            this.timing.retryBaseMs,
          ),
        );
        break;
      case 'standby':
        this.engineState = 'standby';
        nextDelay = this.timing.pullFallbackIntervalMs;
        break;
      case 'retry':
        this.failures += 1;
        nextDelay = this.retryDelay(this.failures, outcome.retryAfterMs);
        this.retryNotBefore = this.now() + nextDelay;
        break;
      case 'halt':
        this.engineState = outcome.state;
        this.reason = outcome.reason;
        nextDelay =
          outcome.state === 'paused' || outcome.state === 'unavailable'
            ? this.timing.pullFallbackIntervalMs
            : null;
        if (nextDelay === null && !this.stopped) {
          this.halted = true;
          this.options.recordProblem?.({
            kind: 'stopped',
            code: outcome.reason,
          });
          this.lockReleased =
            this.lock?.release().catch(() => undefined) ?? Promise.resolve();
          this.lock = null;
        }
        break;
    }
    this.emitStatus();
    if (this.stopped || nextDelay === null) return;
    const rerunAt = this.rerunAt;
    this.rerunAt = null;
    this.schedule(
      rerunAt !== null && outcome.kind !== 'retry'
        ? Math.min(rerunAt - this.now(), nextDelay)
        : nextDelay,
    );
  }

  private retryDelay(
    failures: number,
    retryAfterMs: number | undefined,
  ): number {
    const exponential = Math.min(
      this.timing.retryBaseMs * 2 ** Math.max(0, failures - 1),
      this.timing.retryMaxMs,
    );
    const jittered = exponential * (0.5 + this.random() / 2);
    return retryAfterMs === undefined
      ? jittered
      : Math.max(
          jittered,
          Math.min(retryAfterMs, this.timing.serverRetryAfterMaxMs),
        );
  }

  /**
   * When the first scope still waiting out its own failure may sync again,
   * infinite without one: a deadline already past asks for no pass of its
   * own, so passes keep their own spacing.
   */
  private nextScopeRetryAt(): number {
    const now = this.now();
    let at = Number.POSITIVE_INFINITY;
    for (const retry of this.scopeRetries.values()) {
      if (retry.notBefore > now) at = Math.min(at, retry.notBefore);
    }
    return at;
  }

  /** Whether a scope still waits out a failure of its own. */
  private scopeWaits(key: string): boolean {
    return (this.scopeRetries.get(key)?.notBefore ?? 0) > this.now();
  }

  /**
   * Forgets a scope's backoff, which only scopes that sync here now keep: a
   * scope this pass skipped or held waits out nothing, so its deadline never
   * outlives its eligibility and asks for passes of a scope that stopped
   * syncing.
   */
  private clearScopeRetry(scope: MemoryScopeRef): void {
    this.scopeRetries.delete(memoryScopeKey(scope));
  }

  /**
   * Records how a scope's sync ended: a retry of that scope backs it off on
   * its own schedule, and the pass goes on; anything else about the whole
   * engine ends the pass, returned here.
   */
  private afterScope(key: string, outcome: ScopeOutcome): PassOutcome | null {
    if (outcome.kind === 'scope_retry') {
      const failures = (this.scopeRetries.get(key)?.failures ?? 0) + 1;
      this.scopeRetries.set(key, {
        failures,
        notBefore: this.now() + this.retryDelay(failures, outcome.retryAfterMs),
      });
      return null;
    }
    if (outcome.kind !== 'ok') return outcome;
    this.scopeRetries.delete(key);
    return null;
  }

  /** What a scope's failure means: that scope's retry, or the engine's. */
  private scopeFailureOutcome(failure: MemorySyncFailure): ScopeOutcome {
    if (isAccountWide(failure)) return this.engineOutcome(failure);
    switch (failure.kind) {
      case 'retry':
      case 'conflict':
        return failure.retryAfterMs === undefined
          ? { kind: 'scope_retry' }
          : { kind: 'scope_retry', retryAfterMs: failure.retryAfterMs };
      default:
        return { kind: 'scope_retry' };
    }
  }

  private checkAborted(signal: AbortSignal): void {
    if (signal.aborted || this.stopped) throw abortError();
  }

  private reportApplied(result: MemoryReplicaApplyResult): void {
    const record = this.options.recordMetric;
    if (record === undefined) return;
    for (const delayMs of result.delaysMs) record({ kind: 'delay', delayMs });
    for (const [outcome, count] of Object.entries(result.merges)) {
      if (count > 0 && isMergeOutcome(outcome)) {
        record({ kind: 'merge', outcome, count });
      }
    }
  }

  private writeOptions(): MemoryReplicaWriteOptions {
    return {
      deviceId: this.options.device.deviceId,
      deviceLabel: this.options.device.label,
      blockedOriginOrganizationIds: new Set(
        this.policy?.blockedOriginOrganizationIds ?? [],
      ),
      now: () => new Date(this.now()),
    };
  }

  private async takeLock(): Promise<boolean> {
    if (this.lock !== null && !this.lock.lost) return true;
    if (this.lock !== null) await this.lock.release().catch(() => undefined);
    try {
      this.lock = await acquireMemoryScopeLock(this.accountDir, {
        timeoutMs: 0,
      });
      return true;
    } catch (error) {
      this.lock = null;
      if (error instanceof LocalMemoryScopeLockTimeoutError) return false;
      throw error;
    }
  }

  private async pass(signal: AbortSignal): Promise<PassOutcome> {
    await this.finishLocalDeletes();
    if (!(await this.takeLock())) {
      await this.loadReplicas();
      return { kind: 'standby' };
    }
    this.checkAborted(signal);
    const halt = this.pendingHalt;
    this.pendingHalt = null;
    if (halt !== null) return halt;
    if (this.deviceSessionId === null) {
      const failure = await this.registerDevice(signal);
      if (failure === 'unsupported') {
        return {
          kind: 'halt',
          state: 'update_required',
          reason: 'memory_unsupported_protocol',
        };
      }
      if (failure !== null) return this.engineOutcome(failure);
    } else {
      const settings = await this.options.transport.settings(signal);
      if (!settings.ok) return this.engineOutcome(settings.failure);
      this.settings = settings.value.settings;
      this.policy = settings.value.policy;
    }
    this.checkAborted(signal);
    const settings = this.settings;
    if (settings === null) return { kind: 'retry' };
    if (!settings.enabled) {
      this.scopeRetries.clear();
      await this.setIdleMode(USER_SCOPE, 'paused');
      for (const replica of this.projectReplicas.values()) {
        await this.setIdleMode(projectScopeRef(replica.projectId), 'paused');
      }
      return { kind: 'halt', state: 'paused', reason: 'memory_sync_disabled' };
    }
    if (settings.userScope === 'sync') {
      const fence = this.openFence(USER_SCOPE, null);
      if (!this.scopeWaits(fence.key)) {
        const user = await this.syncFenced(fence);
        if (user === 'fenced') return { kind: 'retry' };
        const stop = this.afterScope(fence.key, user);
        if (stop !== null) return stop;
      }
    } else {
      await this.setIdleMode(USER_SCOPE, 'device_only');
    }
    return this.syncProjects(settings, signal);
  }

  /**
   * Syncs every project scope a bound workspace maps to (design §22): a
   * project keeping private memory, kept on its devices by the account's
   * choice, or whose binding was detached or moved keeps its replica as
   * local memory and syncs nothing. A replica no workspace maps to any more
   * stops resolving and syncing, and stays on disk.
   */
  private async syncProjects(
    settings: MemorySyncSettings,
    signal: AbortSignal,
  ): Promise<PassOutcome> {
    const targets = await this.readProjectTargets();
    await this.scanProjectReplicas();
    if (targets === null) return { kind: 'ok' };
    this.targetedProjects = new Set(
      targets.map((target) => target.scope.projectId),
    );
    for (const replica of this.projectReplicas.values()) {
      if (this.targetedProjects.has(replica.projectId)) continue;
      const scope = projectScopeRef(replica.projectId);
      this.options.registry.unregisterDir(replica.dir);
      this.scopeStatus.delete(memoryScopeKey(scope));
      await this.setIdleMode(scope, 'paused');
    }
    for (const key of [...this.scopeStatus.keys()]) {
      const status = this.scopeStatus.get(key);
      if (
        status?.scope.kind === 'project' &&
        !this.targetedProjects.has(status.scope.projectId)
      ) {
        this.scopeStatus.delete(key);
      }
    }
    const targetKeys = new Set(
      targets.map((target) => memoryScopeKey(target.scope)),
    );
    for (const key of [...this.scopeRetries.keys()]) {
      if (key !== memoryScopeKey(USER_SCOPE) && !targetKeys.has(key)) {
        this.scopeRetries.delete(key);
      }
    }
    if (targets.some((target) => target.mode === 'sync')) {
      const read = await this.options.transport.projectSettings(signal);
      if (read.ok) {
        this.applyProjectModes(read.value);
      } else {
        this.applyProjectModes(null);
        const failure = read.failure;
        if (
          failure.kind === 'retry' ||
          failure.kind === 'register' ||
          failure.kind === 'stop' ||
          failure.kind === 'update_required' ||
          failure.kind === 'paused'
        ) {
          return this.engineOutcome(failure);
        }
        this.options.recordProblem?.({
          kind: 'project_scopes',
          code: 'project_settings_unavailable',
        });
      }
    }
    const generation = this.eligibilityClock;
    for (const target of targets) {
      this.checkAborted(signal);
      const stop = await this.syncProject(target, settings, generation);
      if (stop !== null) return stop;
    }
    return { kind: 'ok' };
  }

  /**
   * Syncs one bound project as the pass found it, under a fence opened at
   * `generation`. Returns the outcome that ends the pass, else null.
   */
  private async syncProject(
    target: ProjectMemoryScopeTarget,
    settings: MemorySyncSettings,
    generation: number,
  ): Promise<PassOutcome | null> {
    const { scope } = target;
    if (this.contestedProjects.has(scope.projectId)) {
      this.clearScopeRetry(scope);
      this.scopeStatus.set(
        memoryScopeKey(scope),
        emptyScopeStatus(scope, 'paused'),
      );
      return null;
    }
    const mode = this.projectScopeMode(target, settings);
    if (mode === null) {
      this.clearScopeRetry(scope);
      return null;
    }
    if (mode !== 'sync') {
      await this.holdProjectScope(
        scope,
        mode === 'stopped' ? 'paused' : 'device_only',
      );
      return null;
    }
    if (this.options.deviceLocalDir(scope) === null) {
      this.clearScopeRetry(scope);
      return null;
    }
    const fence = this.openFence(scope, target.workspaceId, generation);
    if (this.scopeWaits(fence.key)) return null;
    const outcome = await this.syncFenced(fence);
    if (outcome !== 'fenced') return this.afterScope(fence.key, outcome);
    if (this.options.accountEligible?.() === false) return { kind: 'retry' };
    if (await this.settleProject(scope, settings)) this.requestPull();
    return null;
  }

  /**
   * Syncs a scope under its fence: 'fenced' when the scope stopped syncing
   * for this account meanwhile, so the pass sent nothing more to it.
   */
  private async syncFenced(
    fence: ScopeFence,
  ): Promise<ScopeOutcome | 'fenced'> {
    let outcome: ScopeOutcome;
    try {
      outcome = await this.syncScope(fence);
    } catch (error) {
      if (!this.isFenced(error)) throw error;
      return 'fenced';
    }
    return this.fenceHolds(fence) ? outcome : 'fenced';
  }

  private isFenced(error: unknown): boolean {
    if (error instanceof MemoryScopeFencedError) return true;
    return (
      error instanceof Error &&
      error.name === 'AbortError' &&
      !this.stopped &&
      !this.controller.signal.aborted
    );
  }

  /** Opens a scope's fence as its eligibility stood at `generation`. */
  private openFence(
    scope: MemoryScopeRef,
    workspaceId: string | null,
    generation = this.eligibilityClock,
  ): ScopeFence {
    const key = memoryScopeKey(scope);
    let controller = this.scopeControllers.get(key);
    if (controller === undefined) {
      controller = new AbortController();
      this.scopeControllers.set(key, controller);
    }
    if (this.stopped) controller.abort();
    return { scope, key, generation, workspaceId, signal: controller.signal };
  }

  /**
   * Whether a fence still holds as the engine stands now: nothing about its
   * scope changed after it opened, the account is still the one syncing
   * here with sync on, and the scope's own mode is sync.
   */
  private fenceHolds(fence: ScopeFence): boolean {
    const changedAt = Math.max(
      this.scopeChangedAt.get(fence.key) ?? 0,
      fence.scope.kind === 'project' ? this.projectsChangedAt : 0,
    );
    const settings = this.settings;
    if (
      this.stopped ||
      fence.signal.aborted ||
      changedAt > fence.generation ||
      this.options.accountEligible?.() === false ||
      settings?.enabled !== true
    ) {
      return false;
    }
    if (fence.scope.kind === 'user') return settings.userScope === 'sync';
    return (
      !this.contestedProjects.has(fence.scope.projectId) &&
      this.accountProjectMode(fence.scope.projectId, settings) === 'sync'
    );
  }

  private ensureFence(fence: ScopeFence): void {
    if (!this.fenceHolds(fence)) throw new MemoryScopeFencedError();
  }

  /**
   * Whether the fence's scope still syncs as its workspace's files stand
   * now: read again, it maps to the same workspace and syncs.
   */
  private async stillBound(fence: ScopeFence): Promise<boolean> {
    if (fence.scope.kind === 'user') return true;
    const target = await this.freshProjectTarget(fence.scope.projectId);
    return (
      target !== 'unreadable' &&
      target !== null &&
      target.workspaceId === fence.workspaceId &&
      target.mode === 'sync'
    );
  }

  /**
   * Whether a write to the cloud scope `scopeId` may go now, decided under
   * the replica's lock: the fence holds, the replica still syncs that scope
   * for this account, and the scope's binding, read again, still syncs.
   */
  private async mayWrite(
    fence: ScopeFence,
    dir: string,
    scopeId: string,
  ): Promise<boolean> {
    if (!this.fenceHolds(fence)) return false;
    const state = await readMemorySyncState(dir).catch(() => null);
    if (
      state === undefined ||
      state === null ||
      state.binding.scopeId !== scopeId ||
      !bindsScope(state.binding, this.options.accountId, fence.scope) ||
      (state.mode !== 'syncing' && state.mode !== 'repair_needed')
    ) {
      return false;
    }
    return (await this.stillBound(fence)) && this.fenceHolds(fence);
  }

  private writeGate(
    fence: ScopeFence,
    dir: string,
    scopeId: string,
  ): WriteGate {
    const gate: WriteGate = {
      refused: false,
      maySend: async (): Promise<boolean> => {
        const allowed = await this.mayWrite(fence, dir, scopeId);
        gate.refused = !allowed;
        return allowed;
      },
    };
    return gate;
  }

  /** A project scope as its workspace's files stand now. */
  private async freshProjectTarget(
    projectId: string,
  ): Promise<ProjectMemoryScopeTarget | null | 'unreadable'> {
    const { projectScope } = this.options;
    if (projectScope !== undefined) {
      return projectScope(projectId).catch(() => 'unreadable' as const);
    }
    const targets = await this.readProjectTargets();
    if (targets === null) return 'unreadable';
    return (
      targets.find((target) => target.scope.projectId === projectId) ?? null
    );
  }

  /** The account's mode for a project, a device-only choice here first. */
  private accountProjectMode(
    projectId: string,
    settings: MemorySyncSettings,
  ): 'sync' | 'device_only' | null {
    if (this.requestedProjectModes.get(projectId) === 'device_only') {
      return 'device_only';
    }
    if (this.projectModes === null) return null;
    return this.projectModes.get(projectId) ?? settings.defaultProjectScope;
  }

  /**
   * Applies a project's eligibility change outside a pass, after the one in
   * flight: a scope that no longer syncs is kept as local memory at once.
   */
  private settleProjectsSoon(projectIds: readonly string[] | undefined): void {
    if (this.stopped || this.halted) return;
    const queued = this.pendingSettle;
    if (queued !== null) {
      if (projectIds === undefined) this.pendingSettle = 'all';
      else if (queued !== 'all') for (const id of projectIds) queued.add(id);
      return;
    }
    this.pendingSettle = projectIds === undefined ? 'all' : new Set(projectIds);
    void this.exclusive(async () => {
      const pending = this.pendingSettle;
      this.pendingSettle = null;
      const settings = this.settings;
      if (
        pending === null ||
        this.stopped ||
        settings?.enabled !== true ||
        this.lock === null ||
        this.lock.lost
      ) {
        return;
      }
      await this.scanProjectReplicas();
      const projectIds =
        pending === 'all' ? [...this.projectReplicas.keys()] : [...pending];
      for (const projectId of projectIds) {
        if (this.stopped) return;
        if (!this.projectReplicas.has(projectId)) continue;
        await this.settleProject(projectScopeRef(projectId), settings);
      }
    }).catch((error: unknown) => {
      this.options.recordProblem?.({
        kind: 'pass_failed',
        code: error instanceof Error ? error.name : 'unknown',
      });
    });
  }

  /**
   * Puts a project scope whose eligibility changed in the state its
   * workspace's files ask for now: no longer bound here, it stops resolving
   * and pauses; private, kept on this device, detached or moved, it is kept
   * as local memory. True when it still syncs.
   */
  private async settleProject(
    scope: ProjectScopeRef,
    settings: MemorySyncSettings,
  ): Promise<boolean> {
    const target = await this.freshProjectTarget(scope.projectId);
    if (target === 'unreadable') return false;
    if (target === null) {
      const replica = this.projectReplicas.get(scope.projectId);
      if (replica !== undefined)
        this.options.registry.unregisterDir(replica.dir);
      this.scopeStatus.delete(memoryScopeKey(scope));
      await this.setIdleMode(scope, 'paused');
      return false;
    }
    const mode = this.projectScopeMode(target, settings);
    if (mode === null) {
      this.clearScopeRetry(scope);
      return false;
    }
    if (mode === 'sync') return true;
    await this.holdProjectScope(
      scope,
      mode === 'stopped' ? 'paused' : 'device_only',
    );
    return false;
  }

  /** Keeps the account's per-project modes as read; null when unread. */
  private applyProjectModes(list: MemoryProjectSettingList | null): void {
    const next =
      list === null
        ? null
        : new Map(
            list.projects.map((project) => [project.projectId, project.mode]),
          );
    const before = this.projectModes;
    this.projectModes = next;
    if (sameProjectModes(before, next)) return;
    this.options.onProjectModesChanged?.();
    if (before === null) return;
    if (next === null) {
      this.projectEligibilityChanged();
      return;
    }
    const changed = [...new Set([...before.keys(), ...next.keys()])].filter(
      (projectId) => before.get(projectId) !== next.get(projectId),
    );
    this.projectEligibilityChanged(changed);
  }

  /**
   * What a bound project's memory does now: the workspace's own state, then
   * the account's choice for the project, else its default for projects.
   * Null while the account's choices could not be read: nothing syncs.
   */
  private projectScopeMode(
    target: ProjectMemoryScopeTarget,
    settings: MemorySyncSettings,
  ): ProjectMemoryScopeTarget['mode'] | null {
    if (target.mode !== 'sync') return target.mode;
    const mode = this.accountProjectMode(target.scope.projectId, settings);
    if (mode === null) return null;
    return mode === 'device_only' ? 'device_only' : 'sync';
  }

  /**
   * Keeps a project scope that does not sync: its replica, when it has a
   * ready one, stays the workspace's memory in `mode`; without one the
   * workspace keeps its device-local folder.
   */
  private async holdProjectScope(
    scope: ProjectScopeRef,
    mode: 'paused' | 'device_only',
  ): Promise<void> {
    this.clearScopeRetry(scope);
    const state = await readMemorySyncState(this.scopeDir(scope)).catch(
      () => null,
    );
    if (
      state === undefined ||
      state === null ||
      !bindsScope(state.binding, this.options.accountId, scope)
    ) {
      this.scopeStatus.set(
        memoryScopeKey(scope),
        emptyScopeStatus(scope, mode),
      );
      return;
    }
    await this.setIdleMode(scope, mode);
    await this.registerReplica(scope);
  }

  /**
   * Takes over a replica of this account that no workspace maps to any
   * more when the cloud has keyed its scope to `scope`'s project (a merged
   * duplicate, or a project moved into or out of an organization, design
   * §21.6): the same memory, so its files stay where they are and only its
   * binding names the project now. A scope that is not that replica's is
   * never touched, so two projects' memory never mix.
   */
  private async adoptRekeyedReplica(
    scope: ProjectScopeRef,
    signal: AbortSignal,
  ): Promise<MemorySyncFailure | null> {
    const candidates = [...this.projectReplicas.values()].filter(
      (replica) =>
        replica.projectId !== scope.projectId &&
        !this.targetedProjects.has(replica.projectId) &&
        !this.contestedProjects.has(replica.projectId),
    );
    if (candidates.length === 0) return null;
    const resolved = await this.options.transport.resolveScope(
      scope,
      false,
      signal,
    );
    if (!resolved.ok) {
      return resolved.failure.kind === 'refused' ? null : resolved.failure;
    }
    const { scopeId } = resolved.value.scope;
    const matches = candidates.filter((replica) => replica.scopeId === scopeId);
    const [replica] = matches;
    if (replica === undefined || matches.length !== 1) return null;
    await withMemoryWriteLock(replica.dir, async () => {
      const state = await readMemorySyncState(replica.dir);
      if (
        state === undefined ||
        state === null ||
        state.binding.scopeId !== scopeId ||
        !bindsScope(
          state.binding,
          this.options.accountId,
          projectScopeRef(replica.projectId),
        )
      ) {
        return;
      }
      await rebindMemoryReplicaFiles(replica.dir, {
        ...state.binding,
        projectId: scope.projectId,
      });
    });
    this.options.registry.unregisterDir(replica.dir);
    this.scopeStatus.delete(memoryScopeKey(projectScopeRef(replica.projectId)));
    await this.scanProjectReplicas();
    return null;
  }

  /**
   * Registers this device and keeps its session, settings and policy. Null
   * once registered; `unsupported` when the server needs a newer protocol.
   */
  private async registerDevice(
    signal: AbortSignal,
  ): Promise<MemorySyncFailure | 'unsupported' | null> {
    const { device, transport } = this.options;
    const result = await transport.register(
      {
        protocolVersion: MEMORY_SYNC_PROTOCOL_VERSION,
        device: {
          deviceId: device.deviceId,
          installationGeneration: device.installationGeneration,
          sessionNonce: device.sessionNonce,
          label: device.label,
          platform: device.platform,
          appVersion: device.appVersion,
        },
      },
      signal,
    );
    if (!result.ok) return result.failure;
    if (result.value.minimumProtocolVersion > MEMORY_SYNC_PROTOCOL_VERSION) {
      return 'unsupported';
    }
    this.deviceSessionId = result.value.deviceSessionId;
    transport.setDeviceSession(result.value.deviceSessionId);
    this.settings = result.value.settings;
    this.policy = result.value.policy;
    return null;
  }

  /** What a failure means for the whole engine. */
  private engineOutcome(failure: MemorySyncFailure): PassOutcome {
    switch (failure.kind) {
      case 'retry':
        return failure.retryAfterMs === undefined
          ? { kind: 'retry' }
          : { kind: 'retry', retryAfterMs: failure.retryAfterMs };
      case 'register':
        this.forgetDeviceSession();
        return { kind: 'retry' };
      case 'update_required':
        return {
          kind: 'halt',
          state: 'update_required',
          reason: 'memory_unsupported_protocol',
        };
      case 'unavailable':
        return { kind: 'halt', state: 'unavailable', reason: 'not_found' };
      case 'paused':
        return { kind: 'halt', state: 'paused', reason: failure.code };
      case 'stop':
        return { kind: 'halt', state: 'stopped', reason: failure.code };
      case 'conflict':
        return { kind: 'retry' };
      case 'snapshot':
      case 'device_only':
      case 'scope_deleted':
      case 'refused':
        return { kind: 'retry' };
    }
  }

  /**
   * Settles a failure met outside a pass (a leased run's lease call, pull or
   * commit, or a control call) as a pass would: a lost registration is
   * forgotten and a halt kept, and the pass asked for now registers again or
   * halts.
   */
  private leaseRunFailure(failure: MemorySyncFailure): void {
    const outcome = this.engineOutcome(failure);
    if (outcome.kind === 'halt') this.pendingHalt = outcome;
    else if (failure.kind !== 'register') return;
    this.requestPull();
  }

  /**
   * A control call's answer for `failure`, settled as a pass settles it
   * first: a call that finds this device unregistered leaves the next one
   * to register again.
   */
  private controlFailure(failure: MemorySyncFailure): {
    ok: false;
    code: string;
  } {
    this.leaseRunFailure(failure);
    return controlResultOf(failure);
  }

  /**
   * Registers this device before a control call writes, when no session is
   * known: none yet, or the last one was lost or ended by deleting cloud
   * memory, which deletes the account's devices.
   */
  private async ensureDeviceSession(
    signal: AbortSignal,
  ): Promise<{ ok: false; code: string } | null> {
    if (this.deviceSessionId !== null) return null;
    const failure = await this.registerDevice(signal);
    if (failure === null) return null;
    return failure === 'unsupported'
      ? { ok: false, code: 'update_required' }
      : this.controlFailure(failure);
  }

  private forgetDeviceSession(): void {
    this.deviceSessionId = null;
    this.options.transport.setDeviceSession(null);
  }

  private scopeDir(scope: MemoryScopeRef): string {
    if (scope.kind === 'project') {
      const replica = this.projectReplicas.get(scope.projectId);
      if (replica !== undefined) return replica.dir;
    }
    return memoryReplicaScopeDir(
      this.options.replicasRoot,
      this.options.accountId,
      scope,
    );
  }

  /** Puts a replica the account no longer syncs into an idle mode. */
  private async setIdleMode(
    scope: MemoryScopeRef,
    mode: 'paused' | 'device_only',
  ): Promise<void> {
    this.clearScopeRetry(scope);
    const dir = this.scopeDir(scope);
    const state = await readMemorySyncState(dir);
    if (state === undefined || state === null) return;
    if (state.mode !== mode && state.mode !== 'deleted_in_cloud') {
      await this.updateState(dir, { mode });
    }
    await this.refreshScopeStatus(scope);
  }

  private async updateState(
    dir: string,
    patch: Partial<MemorySyncStateFile>,
  ): Promise<void> {
    await withMemoryWriteLock(dir, async () => {
      const state = await readMemorySyncState(dir);
      if (state === undefined || state === null) return;
      await writeMemorySyncState(dir, { ...state, ...patch });
    });
  }

  private async recordScopeError(dir: string, code: string): Promise<void> {
    await this.updateState(dir, {
      lastError: { code, at: new Date(this.now()).toISOString() },
    });
  }

  /**
   * Registers a replica that is ready (pulled at least once, first enable
   * done) and bound to this account, so the resolver uses it. A stopped
   * engine registers nothing: its host has already unregistered its
   * replicas, also when a pass in flight gets here after that.
   */
  private async registerReplica(scope: MemoryScopeRef): Promise<boolean> {
    const dir = this.scopeDir(scope);
    if (this.stopped) return false;
    const state = await readMemorySyncState(dir);
    if (
      state === undefined ||
      state === null ||
      !bindsScope(state.binding, this.options.accountId, scope) ||
      !isReady(state)
    ) {
      // Until a re-enable is done, its deleted copy stays this device's memory.
      const retired = await this.pendingRetiredSource(scope);
      if (retired !== null) await this.registerRetiredSource(scope, retired);
      return false;
    }
    const retired = this.retiredServed.get(memoryScopeKey(scope));
    if (retired !== undefined) {
      this.options.registry.unregisterDir(retired);
      this.retiredServed.delete(memoryScopeKey(scope));
    }
    this.options.registry.register({
      accountId: this.options.accountId,
      scope,
      dir,
      binding: state.binding,
      device: {
        deviceId: this.options.device.deviceId,
        label: this.options.device.label,
      },
      onLocalChange: () => {
        this.requestPush();
      },
      recordUsage: (counts, usedAt) => {
        void recordMemoryUsageDeltas(dir, state.binding, counts, usedAt).catch(
          (error: unknown) => {
            this.options.recordProblem?.({
              kind: 'pass_failed',
              code: error instanceof Error ? error.name : 'usage',
            });
          },
        );
      },
      runConsolidation: (reason, run) =>
        this.runLeasedConsolidation(scope, reason, run),
    });
    return true;
  }

  private async syncScope(fence: ScopeFence): Promise<ScopeOutcome> {
    const { scope, signal } = fence;
    let dir = this.scopeDir(scope);
    const key = memoryScopeKey(scope);
    let state = await readMemorySyncState(dir);
    if (state === null) {
      this.options.recordProblem?.({ kind: 'replica_unreadable', code: key });
      return { kind: 'ok' };
    }
    if (state === undefined && scope.kind === 'project') {
      const adopted = await this.adoptRekeyedReplica(scope, signal);
      if (adopted !== null) return this.scopeFailureOutcome(adopted);
      dir = this.scopeDir(scope);
      state = await readMemorySyncState(dir);
      if (state === null) return { kind: 'ok' };
    }
    if (state === undefined) {
      const created = await this.createReplica(fence);
      if (created.kind !== 'ok') return created;
      state = await readMemorySyncState(dir);
      if (state === undefined || state === null) return { kind: 'ok' };
    }
    if (!bindsScope(state.binding, this.options.accountId, scope)) {
      this.options.recordProblem?.({
        kind: 'replica_unreadable',
        code: 'binding',
      });
      return { kind: 'ok' };
    }
    if (state.mode === 'deleted_in_cloud') {
      await this.registerReplica(scope);
      await this.refreshScopeStatus(scope);
      return { kind: 'ok' };
    }
    // A replica held paused or on this computer while its first enable was
    // unfinished syncs again before that first enable resumes.
    if (state.mode !== 'syncing' && state.mode !== 'repair_needed') {
      state = { ...state, mode: 'syncing' };
      await this.updateState(dir, { mode: 'syncing' });
    }
    if (state.firstEnable === null && state.cursor === null) {
      // An earlier build created replicas without a pending first enable.
      state = {
        ...state,
        firstEnable: firstEnableStarted(new Date(this.now())),
      };
      await this.updateState(dir, { firstEnable: state.firstEnable });
    }
    if (awaitsFirstEnable(state) && state.firstEnable?.commitId !== undefined) {
      const recovered = await this.recoverFirstEnable(scope, signal);
      if (recovered !== 'none' && recovered !== 'done') {
        return this.scopeOutcome(scope, recovered);
      }
      state = (await readMemorySyncState(dir)) ?? state;
    }
    const firstEnable = awaitsFirstEnable(state);
    if (firstEnable && (await this.firstEnableSourceHasMemory(scope))) {
      await this.registerReplica(scope);
      this.markNeedsFirstEnable(scope);
      return { kind: 'ok' };
    }
    const pulled = await this.pull(scope, signal);
    if (pulled !== null) return this.scopeOutcome(scope, pulled);
    if (!firstEnable) {
      await this.registerReplica(scope);
    } else if (!(await this.finishFirstEnable(scope))) {
      this.markNeedsFirstEnable(scope);
      return { kind: 'ok' };
    }
    const steps: Array<{
      refusal: MemorySyncProblem['kind'];
      run: () => Promise<MemorySyncFailure | null>;
    }> = [
      { refusal: 'commit_refused', run: () => this.commitEdits(fence) },
      { refusal: 'push_refused', run: () => this.push(fence) },
      { refusal: 'usage_refused', run: () => this.pushUsage(fence) },
    ];
    // A refusal answers that one request: it is recorded and the next step
    // still runs. Only a failure worth retrying or one about the whole scope
    // or engine ends the pass here.
    for (const step of steps) {
      this.checkAborted(signal);
      const failure = await step.run();
      if (failure === null) continue;
      if (failure.kind === 'refused') {
        await this.recordRefusal(dir, step.refusal, failure.code);
        continue;
      }
      await this.refreshScopeStatus(scope);
      return this.scopeOutcome(scope, failure);
    }
    await this.refreshScopeStatus(scope);
    return { kind: 'ok' };
  }

  private async recordRefusal(
    dir: string,
    kind: MemorySyncProblem['kind'],
    code: string,
  ): Promise<void> {
    this.options.recordProblem?.({ kind, code });
    await this.recordScopeError(dir, code);
  }

  /**
   * Commits the replica's document edits as one `manual_edit` at its base
   * (design §13.1). A compare-and-set loss pulls, which merges, and sends
   * what is left once more.
   */
  private async commitEdits(
    fence: ScopeFence,
  ): Promise<MemorySyncFailure | null> {
    const { scope, signal } = fence;
    const dir = this.scopeDir(scope);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const edits = await collectReplicaEdits(dir);
      const [refused] = edits.refused;
      if (refused !== undefined) {
        await this.recordScopeError(dir, `document_${refused.reason}`);
      }
      if (edits.changes.length === 0 || !this.keeps(dir)) return null;
      const state = await readMemorySyncState(dir);
      if (state === undefined || state === null) return null;
      const sent = await this.sendCommit(
        scope,
        state,
        {
          kind: 'manual_edit',
          lease: null,
          changes: edits.changes,
          consumedNoteIds: [],
          metadata: {
            model: null,
            promptVersion: null,
            consolidationPackageVersion: null,
            inputHash: null,
          },
        },
        fence,
      );
      if (sent.ok) {
        if (edits.deferred > 0) this.requestPush();
        return null;
      }
      if (
        sent.failure.kind !== 'conflict' ||
        sent.failure.code !== 'memory_revision_conflict'
      ) {
        return sent.failure;
      }
      const pulled = await this.pull(scope, signal);
      if (pulled !== null) return pulled;
    }
    return null;
  }

  /**
   * Sends a commit, recording it as pending first so a crash is resolved by
   * the next pull (design §12.1), and applies the accepted revision through
   * the replica writer. A manual edit leaves the live documents as they are.
   * An applied revision that wrote into the replica is reported as a scope
   * change, as a pulled one is.
   */
  private async sendCommit(
    scope: MemoryScopeRef,
    state: MemorySyncStateFile,
    body: Omit<MemoryCommitRequest, 'commitId' | 'baseRevision'>,
    fence: ScopeFence,
    commitId: string = memoryNoteIdAt(this.now()),
  ): Promise<MemorySyncResult<MemoryCommitResponse>> {
    const dir = this.scopeDir(scope);
    const request: MemoryCommitRequest = {
      commitId,
      baseRevision: state.baseRevision,
      ...body,
    };
    const gate = this.writeGate(fence, dir, state.binding.scopeId);
    await withMemoryWriteLock(dir, async () => {
      if (!(await gate.maySend())) return;
      const current = await readMemorySyncState(dir);
      if (current === undefined || current === null) return;
      await writeMemorySyncState(dir, {
        ...current,
        pendingCommit: {
          commitId: request.commitId,
          kind: request.kind,
          baseRevision: request.baseRevision,
          startedAt: new Date(this.now()).toISOString(),
        },
      });
    });
    if (gate.refused) throw new MemoryScopeFencedError();
    this.ensureFence(fence);
    const result = await this.options.transport.commit(
      state.binding.scopeId,
      request,
      fence.signal,
    );
    if (result.ok) {
      const applied = await applyMemoryReplicaCommit(
        dir,
        {
          revision: result.value.revision,
          changes: request.changes,
          consumedNoteIds: request.consumedNoteIds,
          keepLiveDocuments: request.kind === 'manual_edit',
        },
        this.writeOptions(),
      );
      this.reportApplied(applied);
      if (applied.documentsChanged > 0 || request.consumedNoteIds.length > 0) {
        this.options.onScopeChanged?.(scope);
      }
    } else if (result.failure.kind !== 'retry') {
      // Refused: the commit did not land. A lost answer stays pending.
      await this.updateState(dir, { pendingCommit: null });
    }
    return result;
  }

  /**
   * Sends the scope's usage deltas (design §15) the way notes go: the push
   * is taken and marked sent under the scope lock, sent again as it was
   * until it is answered, and settled by its `seq`.
   */
  private async pushUsage(
    fence: ScopeFence,
  ): Promise<MemorySyncFailure | null> {
    const dir = this.scopeDir(fence.scope);
    const state = await readMemorySyncState(dir);
    if (state === undefined || state === null) return null;
    const gate = this.writeGate(fence, dir, state.binding.scopeId);
    const push = await takeMemoryUsagePush(dir, state.binding, gate.maySend);
    if (gate.refused) throw new MemoryScopeFencedError();
    if (push === null) return null;
    this.ensureFence(fence);
    const result = await this.options.transport.pushUsage(
      state.binding.scopeId,
      { deltas: [...push.deltas] },
      fence.signal,
    );
    if (!result.ok) {
      // Sent again as it is, a refused push would be refused forever and
      // hold back every later use: drop it.
      if (result.failure.kind === 'refused') {
        await settleMemoryUsagePush(dir, state.binding, push.seq);
      }
      return result.failure;
    }
    await settleMemoryUsagePush(dir, state.binding, push.seq);
    return null;
  }

  /**
   * Runs a consolidation of a synced scope holding its lease (design §11,
   * §12.1): pull to the head, take the lease (desktop first, D4a), settle
   * the local deletes and edits cut short and pull again under it, as a pass
   * does, renew it every 30 seconds while `run` generates, commit under its
   * epoch, and release it. A lease held elsewhere or a base that moved
   * cancels the run; nothing is applied unless the commit is accepted.
   */
  async runLeasedConsolidation(
    scope: MemoryScopeRef,
    reason: 'scheduled' | 'manual',
    run: (
      consolidation: LocalMemorySyncedConsolidation,
    ) => Promise<MemoryConsolidationResult>,
  ): Promise<MemoryConsolidationResult> {
    const ended: ConsolidationEnd = { retry: false };
    const startedMs = this.now();
    try {
      const result = await this.leasedConsolidation(scope, reason, run, ended);
      this.options.recordMetric?.({
        kind: 'consolidation',
        status: result.status,
        durationMs: Math.max(0, this.now() - startedMs),
      });
      return result;
    } catch (error) {
      ended.retry = false;
      throw error;
    } finally {
      this.afterConsolidation(scope, ended);
    }
  }

  /**
   * Asks the host for another run of a consolidation that ended worth
   * retrying, waiting longer for each in a row; any other end starts over.
   * Nothing is asked for a replica this engine no longer keeps.
   */
  private afterConsolidation(
    scope: MemoryScopeRef,
    ended: ConsolidationEnd,
  ): void {
    const key = memoryScopeKey(scope);
    if (!ended.retry || !this.keeps(this.scopeDir(scope))) {
      this.consolidationRetries.delete(key);
      return;
    }
    const attempt = (this.consolidationRetries.get(key) ?? 0) + 1;
    this.consolidationRetries.set(key, attempt);
    this.options.requestConsolidation?.(
      scope,
      consolidationRetryDelay(attempt, ended.retryAfterMs),
    );
  }

  private async leasedConsolidation(
    scope: MemoryScopeRef,
    reason: 'scheduled' | 'manual',
    run: (
      consolidation: LocalMemorySyncedConsolidation,
    ) => Promise<MemoryConsolidationResult>,
    ended: ConsolidationEnd,
  ): Promise<MemoryConsolidationResult> {
    const cancelled = (why: string): MemoryConsolidationResult => ({
      status: 'cancelled',
      reason: why,
    });
    const dir = this.scopeDir(scope);
    const engine = await this.syncNow();
    const scopeFence = await this.syncingFence(scope);
    if (engine.state !== 'running') {
      // Still starting: no pass has synced yet, each one failing for a
      // reason worth retrying (the network, a registration). Any other state
      // is one this process does not consolidate in.
      ended.retry = engine.state === 'starting';
      return cancelled('cancelled');
    }
    const state = await readMemorySyncState(dir);
    if (
      state === undefined ||
      state === null ||
      state.mode !== 'syncing' ||
      state.binding.accountId !== this.options.accountId ||
      !this.keeps(dir) ||
      scopeFence === null
    ) {
      return cancelled('cancelled');
    }
    const { signal } = this.controller;
    const scopeId = state.binding.scopeId;
    const acquired = await this.options.transport.acquireLease(
      scopeId,
      reason,
      signal,
    );
    if (!acquired.ok) {
      this.leaseRunFailure(acquired.failure);
      ended.retry = isTransient(acquired.failure);
      const retryAfterMs =
        'retryAfterMs' in acquired.failure
          ? acquired.failure.retryAfterMs
          : undefined;
      if (retryAfterMs !== undefined) ended.retryAfterMs = retryAfterMs;
      return cancelled(
        acquired.failure.kind === 'retry' &&
          acquired.failure.code === 'memory_lease_held'
          ? 'already-running'
          : 'cancelled',
      );
    }
    const { lease } = acquired.value;
    const fence = { leaseId: lease.leaseId, epoch: lease.epoch };
    const maxUntil = Date.parse(lease.maxUntil);
    const held: LeaseRun = {
      lost: false,
      committed: false,
      retry: false,
      done: false,
      renewal: null,
    };
    const scheduleRenewal = (): void => {
      if (held.done || held.lost || this.stopped) return;
      held.renewal = this.setTimer(() => {
        void this.options.transport
          .renewLease(scopeId, fence, signal)
          .then((renewed) => {
            if (!renewed.ok) {
              this.leaseRunFailure(renewed.failure);
              if (renewed.failure.kind !== 'retry') {
                held.lost = true;
                held.retry = isTransient(renewed.failure);
              }
            }
            scheduleRenewal();
          });
      }, MEMORY_SYNC_TIMINGS.leaseRenewIntervalMs);
    };
    let result: MemoryConsolidationResult | null = null;
    try {
      const pulled = await this.exclusive(async () => {
        await this.finishLocalDeletes();
        return this.pull(scope, signal);
      });
      if (pulled !== null) {
        this.leaseRunFailure(pulled);
        held.retry = isTransient(pulled);
        return cancelled('cancelled');
      }
      if (
        (await readMemorySyncState(dir))?.baseRevision !== lease.baseRevision
      ) {
        held.retry = true;
        return cancelled('cancelled');
      }
      scheduleRenewal();
      result = await run({
        consumable: await listConsumableNotes(dir, this.originPolicy(scope)),
        listConsumable: () =>
          listConsumableNotes(dir, this.originPolicy(scope)),
        usage: acquired.value.usage,
        shouldContinue: () =>
          !held.lost &&
          this.keeps(dir) &&
          this.fenceHolds(scopeFence) &&
          this.now() < maxUntil,
        commit: (request) =>
          this.exclusive(() =>
            this.commitConsolidation(
              scope,
              lease.baseRevision,
              held,
              request.inputsCurrent,
              {
                kind: 'consolidation',
                lease: fence,
                changes: request.changes,
                consumedNoteIds: request.consumedNoteIds,
                ...(request.prunedTopicPaths.length > 0
                  ? { prunedTopicPaths: request.prunedTopicPaths }
                  : {}),
                metadata: {
                  model: request.model,
                  promptVersion: MEMORY_CONSOLIDATION_PROMPT_VERSION,
                  consolidationPackageVersion:
                    MEMORY_CONSOLIDATION_PACKAGE_VERSION,
                  inputHash: request.inputHash,
                },
              },
              maxUntil,
              scopeFence,
            ),
          ),
      });
      return result;
    } finally {
      ended.retry = held.retry && !held.committed;
      held.done = true;
      held.renewal?.cancel();
      const released = await this.options.transport
        .releaseLease(scopeId, {
          ...fence,
          outcome: leaseOutcome(held.committed, result),
        })
        .catch(() => null);
      if (released !== null && !released.ok) {
        this.leaseRunFailure(released.failure);
      }
      if (!held.committed) this.requestPull();
    }
  }

  /**
   * Commits a leased run's output, unless the lease is gone, the base moved,
   * or something the run read changed meanwhile (`inputsCurrent`, checked
   * here so no pass runs between it and the commit).
   */
  private async commitConsolidation(
    scope: MemoryScopeRef,
    leaseBase: number,
    held: LeaseRun,
    inputsCurrent: () => Promise<boolean>,
    body: Omit<MemoryCommitRequest, 'commitId' | 'baseRevision'>,
    maxUntil: number,
    fence: ScopeFence,
  ): Promise<LocalMemorySyncedCommitOutcome> {
    const dir = this.scopeDir(scope);
    if (
      held.lost ||
      !this.keeps(dir) ||
      !this.fenceHolds(fence) ||
      this.now() >= maxUntil
    ) {
      return 'lost';
    }
    const current = await readMemorySyncState(dir);
    if (
      current === undefined ||
      current === null ||
      current.baseRevision !== leaseBase ||
      !(await inputsCurrent())
    ) {
      held.retry = true;
      return 'changed';
    }
    let sent: MemorySyncResult<MemoryCommitResponse>;
    try {
      sent = await this.sendCommit(scope, current, body, fence);
    } catch (error) {
      if (!this.isFenced(error)) throw error;
      return 'lost';
    }
    if (sent.ok) {
      held.committed = true;
      return 'committed';
    }
    if (!this.fenceHolds(fence)) return 'lost';
    this.leaseRunFailure(sent.failure);
    if (
      sent.failure.kind === 'conflict' &&
      sent.failure.code.startsWith('memory_lease')
    ) {
      held.lost = true;
      held.retry = true;
      return 'lost';
    }
    if (sent.failure.kind === 'refused') {
      await this.recordRefusal(dir, 'commit_refused', sent.failure.code);
      return 'refused';
    }
    held.retry = isTransient(sent.failure);
    return 'changed';
  }

  /**
   * A fence for a scope that syncs now, its project's binding read fresh;
   * null when the scope does not sync for this account.
   */
  private async syncingFence(
    scope: MemoryScopeRef,
  ): Promise<ScopeFence | null> {
    const generation = this.eligibilityClock;
    if (scope.kind === 'user') {
      const fence = this.openFence(scope, null, generation);
      return this.fenceHolds(fence) ? fence : null;
    }
    const target = await this.freshProjectTarget(scope.projectId);
    if (target === 'unreadable' || target === null || target.mode !== 'sync') {
      return null;
    }
    const fence = this.openFence(scope, target.workspaceId, generation);
    return this.fenceHolds(fence) ? fence : null;
  }

  /**
   * Whether this engine still keeps the replica at `dir`: it runs and the
   * replica is registered for its account. An engine that stopped, or whose
   * host unregistered its replicas, commits nothing more to them.
   */
  private keeps(dir: string): boolean {
    return (
      !this.stopped &&
      this.options.registry.entryForDir(dir)?.accountId ===
        this.options.accountId
    );
  }

  // Controls the Memory settings and panel call (design §14, §17).

  /** The account's settings and policy as the engine last read them. */
  accountSettings(): {
    settings: MemorySyncSettings;
    policy: MemoryAccountPolicy;
  } | null {
    return this.settings === null || this.policy === null
      ? null
      : { settings: this.settings, policy: this.policy };
  }

  /** The scope's sync state on disk, or null when it has no replica. */
  async scopeState(scope: MemoryScopeRef): Promise<MemorySyncStateFile | null> {
    return (await readMemorySyncState(this.scopeDir(scope))) ?? null;
  }

  private controlling(): { ok: false; code: string } | null {
    return this.engineState === 'running' || this.engineState === 'paused'
      ? null
      : { ok: false, code: 'not_running' };
  }

  /** Changes account settings, reapplying once over a newer revision. */
  async updateSettings(
    patch: MemorySyncSettingsPatch,
  ): Promise<MemorySyncControlResult<null>> {
    const refused = this.controlling();
    if (refused !== null) return refused;
    const result = await this.exclusive(async () => {
      const { signal } = this.controller;
      let last: MemorySyncFailure = { kind: 'retry', code: 'settings' };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (this.settings === null || attempt > 0) {
          const fresh = await this.options.transport.settings(signal);
          if (!fresh.ok) return fresh;
          this.settings = fresh.value.settings;
          this.policy = fresh.value.policy;
        }
        const current = this.settings;
        const updated = await this.options.transport.updateSettings(
          { revision: current.revision, ...patch },
          signal,
        );
        if (updated.ok) {
          this.settings = updated.value.settings;
          this.policy = updated.value.policy;
          return updated;
        }
        last = updated.failure;
        if (failureCode(last) !== 'memory_settings_conflict') break;
      }
      return { ok: false as const, failure: last };
    });
    this.requestPull();
    return result.ok
      ? { ok: true, value: null }
      : this.controlFailure(result.failure);
  }

  async listHistory(
    scope: MemoryScopeRef,
    before: number | null,
  ): Promise<
    MemorySyncControlResult<{
      revisions: MemoryRevisionRecord[];
      nextBefore: number | null;
      baseRevision: number;
    }>
  > {
    const state = await this.scopeState(scope);
    if (state === null) return { ok: false, code: 'not_synced' };
    const result = await this.options.transport.listRevisions(
      state.binding.scopeId,
      before,
      this.controller.signal,
    );
    return result.ok
      ? {
          ok: true,
          value: { ...result.value, baseRevision: state.baseRevision },
        }
      : this.controlFailure(result.failure);
  }

  /** Restores an earlier revision in the cloud and pulls it (design §14.1). */
  async restoreRevision(
    scope: MemoryScopeRef,
    targetRevision: number,
  ): Promise<MemorySyncControlResult<null>> {
    const refused = this.controlling();
    if (refused !== null) return refused;
    const result = await this.exclusive(async () => {
      const { signal } = this.controller;
      const unregistered = await this.ensureDeviceSession(signal);
      if (unregistered !== null) return unregistered;
      const dir = this.scopeDir(scope);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const state = await readMemorySyncState(dir);
        if (state === undefined || state === null) {
          return { ok: false as const, code: 'not_synced' };
        }
        if (targetRevision >= state.baseRevision) {
          return { ok: false as const, code: 'invalid_revision' };
        }
        const restored = await this.options.transport.restore(
          state.binding.scopeId,
          {
            commitId: memoryNoteIdAt(this.now()),
            targetRevision,
            baseRevision: state.baseRevision,
          },
          signal,
        );
        if (restored.ok) {
          const pulled = await this.pull(scope, signal);
          return pulled === null
            ? { ok: true as const, value: null }
            : this.controlFailure(pulled);
        }
        if (failureCode(restored.failure) !== 'memory_revision_conflict') {
          return this.controlFailure(restored.failure);
        }
        const pulled = await this.pull(scope, signal);
        if (pulled !== null) return this.controlFailure(pulled);
      }
      return { ok: false as const, code: 'changed' };
    });
    await this.refreshScopeStatus(scope);
    this.emitStatus();
    return result;
  }

  /**
   * "Delete from the cloud" (design §14.4): every scope of the account and
   * sync off. Replicas stay on this device as local memory.
   */
  async deleteFromCloud(): Promise<MemorySyncControlResult<null>> {
    const refused = this.controlling();
    if (refused !== null) return refused;
    const result = await this.exclusive(async () => {
      const purged = await this.options.transport.purge(this.controller.signal);
      // The purge deletes the account's devices: the next write registers.
      if (purged.ok) this.forgetDeviceSession();
      return purged;
    });
    if (!result.ok) return this.controlFailure(result.failure);
    this.requestPull();
    return { ok: true, value: null };
  }

  async readConflict(
    scope: MemoryScopeRef,
    path: string,
  ): Promise<MemoryReplicaConflictView | null> {
    return readReplicaConflict(this.scopeDir(scope), path);
  }

  /**
   * Restores this device's kept version of a conflict (committed next as a
   * manual edit) or dismisses the entry. Conflicts resolve themselves, so
   * both are optional (design §13.2).
   */
  async settleConflict(
    scope: MemoryScopeRef,
    path: string,
    action: 'restore' | 'dismiss',
  ): Promise<MemorySyncControlResult<null>> {
    const dir = this.scopeDir(scope);
    let settled: Awaited<ReturnType<typeof settleReplicaConflict>>;
    try {
      settled = await settleReplicaConflict(dir, path, action, () => {
        if (!this.keeps(dir)) throw new LocalMemoryReplicaUnavailableError();
      });
    } catch (error) {
      if (error instanceof LocalMemoryReplicaUnavailableError) {
        return { ok: false, code: 'not_synced' };
      }
      throw error;
    }
    if (settled !== 'settled') return { ok: false, code: settled };
    await this.refreshScopeStatus(scope);
    this.emitStatus();
    this.requestPush();
    return { ok: true, value: null };
  }

  /**
   * The first-enable review (design §17), changing nothing anywhere: this
   * device's memory against the cloud's, and what merging them leaves. An
   * empty cloud scope is uploaded as it is; otherwise `runMerge` runs the
   * merge consolidation over the cloud documents and this device's memory.
   * When the filters leave it nothing of this device's to read, the cloud
   * memory is kept as it is and the review is a `keep`, which the apply only
   * records. A first enable the cloud already accepted is finished instead,
   * answering `already_applied`.
   *
   * `nothing_to_merge` answers a scope a pass finishes on its own: an empty
   * device folder is bound and pulled without a review. A replica the cloud
   * deleted, or one a re-enable already moved aside, is not such a scope:
   * only a first enable retires and binds it again, so an empty one still
   * gets this review and its no-op apply (see {@link awaitsRebinding}).
   */
  async previewFirstEnable(
    scope: MemoryScopeRef,
    runMerge: MemoryFirstEnableMergeRunner,
  ): Promise<MemorySyncControlResult<MemoryFirstEnablePreview>> {
    const refused = this.controlling();
    if (refused !== null) return refused;
    const { signal } = this.controller;
    const unregistered = await this.exclusive(() =>
      this.ensureDeviceSession(signal),
    );
    if (unregistered !== null) return unregistered;
    const recovered = await this.exclusive(() =>
      this.recoverFirstEnable(scope, signal),
    );
    if (recovered !== 'none') {
      await this.refreshScopeStatus(scope);
      this.emitStatus();
      return recovered === 'done'
        ? { ok: false, code: 'already_applied' }
        : this.controlFailure(recovered);
    }
    const sourceDir = await this.firstEnableSourceDir(scope);
    if (sourceDir === null) return { ok: false, code: 'nothing_to_merge' };
    // A project scope is reviewed only while its binding still allows the
    // merge, read again here (design §22): one workspace of this account
    // bound to it, syncing, neither private nor detached nor moved.
    const bound = await this.boundFirstEnableWorkspace(scope);
    if (bound === null) return { ok: false, code: 'not_bound' };
    const source = await readFirstEnableSourceSettled(sourceDir);
    if (source === null) return { ok: false, code: 'memory_busy' };
    if (!hasFirstEnableSource(source) && !(await this.awaitsRebinding(scope))) {
      return { ok: false, code: 'nothing_to_merge' };
    }
    const resolved = await this.options.transport.resolveScope(
      scope,
      false,
      signal,
    );
    let cloud: {
      revision: number;
      documents: MemoryDocument[];
      pendingNotes: MemoryNoteRecord[];
    } = { revision: 0, documents: [], pendingNotes: [] };
    // Notes an earlier try sent that the cloud has consumed since: replayed
    // into this merge they could never be consumed again.
    let consumedInCloud = new Set<string>();
    if (resolved.ok) {
      const read = await this.readSnapshot(
        resolved.value.scope.scopeId,
        signal,
      );
      if (!read.ok) return this.controlFailure(read.failure);
      cloud = read.value;
      consumedInCloud = await this.earlierTryConsumed(
        scope,
        resolved.value.scope.scopeId,
        cloud.pendingNotes,
      );
    } else if (failureCode(resolved.failure) !== 'memory_scope_not_found') {
      return this.controlFailure(resolved.failure);
    }
    const device = {
      deviceId: this.options.device.deviceId,
      label: this.options.device.label,
    };
    const notes = firstEnableNotes(source, device);
    const origins = this.originPolicy(scope);
    // Notes the cloud refused or an organization held back on an earlier
    // try stay on this device: a merge that consumed one would be refused.
    const localOnly = await this.localOnlyNoteIds(scope, sourceDir);
    const keptOnDeviceIds = notes.inbox
      .filter(
        (note) =>
          isFirstEnableNoteHeldBack(note.op, origins) ||
          localOnly.has(note.op.note.noteId),
      )
      .map((note) => note.op.note.noteId);
    const kept = new Set(keptOnDeviceIds);
    const sendable = notes.inbox.filter(
      (note) => !kept.has(note.op.note.noteId),
    );
    const keptOnDevice = keptOnDeviceIds.length;
    const imports = notes.imports.filter((op) => !localOnly.has(noteIdOf(op)));
    const mergeable = (op: MemoryNoteOp): boolean =>
      !consumedInCloud.has(noteIdOf(op));
    const skipped = notes.skipped + notes.imports.length - imports.length;
    const cloudDocuments = cloud.documents.map((document) => ({
      path: document.path,
      content: document.content,
    }));
    // Two spellings of one topic are merged, never uploaded side by side.
    const empty =
      cloud.revision === 0 &&
      cloud.documents.length === 0 &&
      cloud.pendingNotes.length === 0 &&
      hasDistinctDocumentIdentities(source.documents);
    const id = memoryNoteIdAt(this.now());
    let preview: PendingFirstEnable;
    if (empty) {
      const upload = firstEnableUpload(source, device);
      const result = upload.documents;
      // A note the cloud refused on an earlier try stays on this device, as
      // it does on the merge path.
      const uploadNotes = upload.notes.filter(
        (op) => !localOnly.has(noteIdOf(op)),
      );
      // The documents go up as themselves here, not as notes, so what stays
      // behind is what the read carried nothing from, an inbox note that
      // could not be made into one, a document no budget could carry even as
      // notes, and a note refused before. A staged import is not sent on
      // this path and waits for the outbox, which reports it as any note.
      const skipped =
        source.skipped.length +
        (source.notes.length - notes.inbox.length) +
        upload.skipped +
        (upload.notes.length - uploadNotes.length);
      preview = {
        id,
        scopeKey: memoryScopeKey(scope),
        kind: 'upload',
        baseRevision: 0,
        sourceDir,
        workspaceId: bound.workspaceId,
        review: firstEnableReview(source, device),
        fingerprint: source.fingerprint,
        inputNotes: [],
        keptOnDeviceIds,
        inbox: notes.inbox,
        imports: uploadNotes,
        changes: documentChanges([], result),
        consumedNoteIds: [],
        inputHash: null,
        model: null,
        cloud: [],
        // Every document this computer holds, the ones going up as notes
        // included: the review says what is here before what goes up.
        device: source.documents.map(({ path, content }) => ({
          path,
          content,
        })),
        result,
        deviceNotes: sendable.length,
        keptOnDevice,
        skipped,
        skippedNotText: notes.notText,
        tooLargeAsNotes: upload.asNotes,
      };
    } else {
      const merge = firstEnableMergeInput(
        cloud,
        [...sendable.map((note) => note.op), ...imports].filter(mergeable),
        new Date(this.now()).toISOString(),
        origins,
      );
      // Nothing of this device's is left for the merge to read: every note
      // stays here, or another device consumed them all. Consolidation
      // would do nothing, so no model runs and the cloud memory is kept as
      // it is; the apply just records this device's first enable.
      const run = isConsolidationInputClean(merge.input)
        ? null
        : await runMerge(merge.input, merge.scopeTopics, this.scopeDir(scope));
      const output = run === null ? null : run.output;
      if (run !== null && output === null) {
        return { ok: false, code: run.reason ?? 'merge_failed' };
      }
      const result =
        output === null
          ? cloudDocuments
          : mergedDocuments(cloudDocuments, output);
      preview = {
        id,
        scopeKey: memoryScopeKey(scope),
        kind: output === null ? 'keep' : 'merge',
        baseRevision: cloud.revision,
        sourceDir,
        workspaceId: bound.workspaceId,
        review: firstEnableReview(source, device),
        fingerprint: source.fingerprint,
        inputNotes: merge.inputs,
        keptOnDeviceIds,
        inbox: notes.inbox.filter((note) => mergeable(note.op)),
        imports: imports.filter(mergeable),
        changes: documentChanges(cloudDocuments, result),
        consumedNoteIds: (run?.consumedFileKeys ?? []).flatMap((fileKey) => {
          const noteId = merge.noteIds.get(fileKey);
          return noteId === undefined ? [] : [noteId];
        }),
        inputHash: merge.input.inputHash,
        model: run?.model ?? null,
        cloud: cloudDocuments,
        device: source.documents.map(({ path, content }) => ({
          path,
          content,
        })),
        result,
        deviceNotes: sendable.length,
        keptOnDevice,
        skipped,
        skippedNotText: notes.notText,
        // Every document goes up as notes on this path, split to fit, and
        // the merge has already folded in those it read.
        tooLargeAsNotes: 0,
      };
    }
    // Nothing a review shows may be refused when it is applied: an upload
    // leaves a document outside the contract on this device, so only a merge
    // answer can reach this, and an answer no commit could carry is no
    // answer. Showing it would give a review that fails on every apply.
    if (
      preview.changes.some(
        (change) =>
          change.op === 'put' &&
          memoryDocumentRefusal(change.path, change.content) !== null,
      )
    ) {
      return { ok: false, code: 'merge_failed' };
    }
    this.firstEnables.set(preview.scopeKey, preview);
    return {
      ok: true,
      value: {
        previewId: preview.id,
        kind: preview.kind,
        cloud: preview.cloud,
        device: preview.device,
        result: preview.result,
        deviceNotes: preview.deviceNotes,
        keptOnDevice: preview.keptOnDevice,
        skipped: preview.skipped,
        skippedNotText: preview.skippedNotText,
        tooLargeAsNotes: preview.tooLargeAsNotes,
      },
    };
  }

  /**
   * Applies a reviewed first enable: binds the replica, sends this device's
   * notes, and commits the upload (`import`) or the merge (`merge`) under a
   * `first_enable` lease at the reviewed base. `changed` means memory moved
   * since the review and it must be shown again. A first enable the cloud
   * already accepted, whose answer or the pull after it was lost, is
   * finished without sending anything again.
   */
  async applyFirstEnable(
    scope: MemoryScopeRef,
    previewId: string,
  ): Promise<MemorySyncControlResult<MemoryFirstEnableApplied>> {
    const refused = this.controlling();
    if (refused !== null) return refused;
    const preview = this.firstEnables.get(memoryScopeKey(scope)) ?? null;
    const result = await this.exclusive(
      async (): Promise<MemorySyncControlResult<MemoryFirstEnableApplied>> => {
        const unregistered = await this.ensureDeviceSession(
          this.controller.signal,
        );
        if (unregistered !== null) return unregistered;
        const recovered = await this.recoverFirstEnable(
          scope,
          this.controller.signal,
        );
        if (recovered === 'done') {
          return { ok: true, value: { refusedNotes: 0 } };
        }
        if (recovered !== 'none') return this.controlFailure(recovered);
        if (
          preview?.id !== previewId ||
          preview.scopeKey !== memoryScopeKey(scope)
        ) {
          return { ok: false, code: 'changed' };
        }
        // The scope's source is resolved again: one that moved or is gone
        // since the review is reviewed again.
        if ((await this.firstEnableSourceDir(scope)) !== preview.sourceDir) {
          return { ok: false, code: 'changed' };
        }
        // And a project's binding is read again right here: a project
        // unbound, relinked, made private, detached, moved or kept on this
        // device since the review sends nothing (design §22). Every write
        // below is fenced on it too; this refuses before the first one.
        const stillBound = await this.boundFirstEnableWorkspace(scope);
        if (
          stillBound === null ||
          stillBound.workspaceId !== preview.workspaceId
        ) {
          return { ok: false, code: 'changed' };
        }
        // No local consolidation, rebuild or restore of the memory sent
        // starts while it is sent, and none may be in progress now.
        const reserved = preview.sourceDir;
        if (!beginLocalMemoryConsolidationRun(reserved, 'first_enable')) {
          return { ok: false, code: 'memory_busy' };
        }
        try {
          const current = await readFirstEnableSourceSettled(reserved, true);
          if (current === null) return { ok: false, code: 'memory_busy' };
          if (current.fingerprint !== preview.fingerprint) {
            return { ok: false, code: 'changed' };
          }
          return await this.firstEnableSteps(scope, preview);
        } catch (error) {
          if (!this.isFenced(error)) throw error;
          return {
            ok: false,
            code: scope.kind === 'user' ? 'sync_off' : 'changed',
          };
        } finally {
          endLocalMemoryConsolidationRun(reserved);
        }
      },
    );
    if (preview !== null) {
      this.options.recordMetric?.({
        kind: 'first_enable',
        mode: preview.kind,
        outcome: result.ok ? 'applied' : result.code,
      });
    }
    if (result.ok) this.firstEnables.delete(memoryScopeKey(scope));
    await this.refreshScopeStatus(scope);
    this.emitStatus();
    this.requestPush();
    return result;
  }

  /**
   * The notes an earlier try of this first enable sent that the cloud no
   * longer holds as pending: consumed (or removed) since, so a merge that
   * read them again could never consume them. Empty without an earlier try
   * of this cloud scope.
   */
  private async earlierTryConsumed(
    scope: MemoryScopeRef,
    scopeId: string,
    cloudPending: readonly MemoryNoteRecord[],
  ): Promise<Set<string>> {
    const dir = this.scopeDir(scope);
    const state = await readMemorySyncState(dir);
    if (
      state === undefined ||
      state === null ||
      state.binding.scopeId !== scopeId ||
      !awaitsFirstEnable(state)
    ) {
      return new Set();
    }
    const pending = new Set(cloudPending.map((note) => note.noteId));
    const queued = new Set(
      (await readQueuedMemoryNoteOps(dir, state.binding).catch(() => [])).map(
        (entry) => noteIdOf(entry.op),
      ),
    );
    return new Set(
      (state.firstEnable?.sentNoteIds ?? []).filter(
        (noteId) => !pending.has(noteId) && !queued.has(noteId),
      ),
    );
  }

  /**
   * The memory a first enable sends: the deleted copy a re-enable moved
   * aside, until that first enable is done; a replica the cloud deleted,
   * before it moves; otherwise this device's own folder. Null once the
   * replica is in use.
   */
  private async firstEnableSourceDir(
    scope: MemoryScopeRef,
  ): Promise<string | null> {
    const retired = await this.pendingRetiredSource(scope);
    if (retired !== null) return retired;
    const state = await this.scopeState(scope);
    if (state !== null && !awaitsFirstEnable(state)) {
      return state.mode === 'deleted_in_cloud' ? this.scopeDir(scope) : null;
    }
    return this.options.deviceLocalDir(scope);
  }

  /**
   * Whether only a first enable can put this scope back in use: a replica
   * the cloud deleted has to be retired and bound to a new cloud scope, and
   * one a re-enable already moved aside has to finish. A pass does neither,
   * so such a scope is reviewed and applied even with nothing of this
   * device's left to merge; the apply is then the `keep` or empty-`upload`
   * no-op, which still retires and rebinds.
   */
  private async awaitsRebinding(scope: MemoryScopeRef): Promise<boolean> {
    if ((await this.pendingRetiredSource(scope)) !== null) return true;
    return (await this.scopeState(scope))?.mode === 'deleted_in_cloud';
  }

  /**
   * The workspace whose memory a first enable of `scope` would send, read
   * again now: null when a project scope may not be merged (design §22).
   * The user scope has no binding and answers `null` for its workspace.
   */
  private async boundFirstEnableWorkspace(
    scope: MemoryScopeRef,
  ): Promise<{ workspaceId: string | null } | null> {
    if (scope.kind === 'user') return { workspaceId: null };
    const candidate = await this.projectFirstEnableSource(scope);
    return candidate === null ? null : { workspaceId: candidate.workspaceId };
  }

  /** Whether the memory a first enable would send holds anything. */
  private async firstEnableSourceHasMemory(
    scope: MemoryScopeRef,
  ): Promise<boolean> {
    const retired = await this.pendingRetiredSource(scope);
    return retired === null
      ? this.deviceLocalHasMemory(scope)
      : scopeFolderHasMemory(retired);
  }

  /**
   * Notes that stay on this device for the scope: those the cloud refused
   * or an organization held back, recorded by the replica of an earlier try
   * and by a deleted copy being sent again.
   */
  private async localOnlyNoteIds(
    scope: MemoryScopeRef,
    sourceDir: string,
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const dir of new Set([this.scopeDir(scope), sourceDir])) {
      const state = await readMemorySyncState(dir);
      for (const noteId of state?.localOnlyNoteIds ?? []) ids.add(noteId);
    }
    return ids;
  }

  /** `.retired/` under the account, where moved-aside replicas are kept. */
  private get retiredDir(): string {
    return join(this.accountDir, RETIRED_DIRNAME);
  }

  /**
   * Names the deleted copy a pending re-enable sends; written before it
   * moves. It is keyed by the scope's own folder name, not the folder a
   * re-keyed project maps to now, so a restart that maps the scope to
   * another folder still finds it.
   */
  private retiredSourceRecord(scope: MemoryScopeRef): string {
    const scopeName = basename(
      memoryReplicaScopeDir(
        this.options.replicasRoot,
        this.options.accountId,
        scope,
      ),
    );
    return join(this.retiredDir, `first-enable-${scopeName}.json`);
  }

  /**
   * The deleted copy a re-enable moved aside, while its first enable is
   * pending: it is what the review shows and sends, and this device's
   * memory meanwhile. A record left once the replica is ready is removed.
   */
  private async pendingRetiredSource(
    scope: MemoryScopeRef,
  ): Promise<string | null> {
    const record = this.retiredSourceRecord(scope);
    let name: unknown;
    try {
      name = RetiredSourceRecordSchema.safeParse(
        JSON.parse(await readFile(record, 'utf8')),
      ).data?.dir;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (typeof name !== 'string') return null;
    const dir = join(this.retiredDir, name);
    const moved = await pathExists(join(dir, MEMORY_SYNC_STATE_FILENAME));
    const state = await readMemorySyncState(this.scopeDir(scope));
    if (state !== undefined && state !== null && !awaitsFirstEnable(state)) {
      // A ready replica: its first enable is done, unless the record was
      // just written and the deleted copy has not moved yet.
      if (moved) await rm(record, { force: true });
      return null;
    }
    return moved ? dir : null;
  }

  /**
   * Moves a replica the cloud deleted aside, so a new replica can take its
   * folder, and keeps serving it as this device's memory until the first
   * enable sending it is done. Its new place is recorded first, so a
   * failure or a quit at any later step still finds it.
   */
  private async retireDeletedReplica(scope: MemoryScopeRef): Promise<string> {
    const dir = this.scopeDir(scope);
    const name = `${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${basename(dir)}`;
    await mkdir(this.retiredDir, { recursive: true });
    await writeMemoryFileAtomically(
      this.retiredDir,
      this.retiredSourceRecord(scope),
      `${JSON.stringify({ version: 1, dir: name })}\n`,
    );
    this.options.registry.unregisterDir(dir);
    const retired = join(this.retiredDir, name);
    try {
      await rename(dir, retired);
    } catch (error) {
      await rm(this.retiredSourceRecord(scope), { force: true });
      throw error;
    } finally {
      await this.registerReplica(scope);
    }
    return retired;
  }

  /** Serves a pending re-enable's deleted copy as the scope's memory. */
  private async registerRetiredSource(
    scope: MemoryScopeRef,
    dir: string,
  ): Promise<boolean> {
    const state = await readMemorySyncState(dir);
    if (
      this.stopped ||
      state === undefined ||
      state === null ||
      state.binding.accountId !== this.options.accountId
    ) {
      return false;
    }
    this.options.registry.unregisterDir(this.scopeDir(scope));
    this.retiredServed.set(memoryScopeKey(scope), dir);
    this.options.registry.register({
      accountId: this.options.accountId,
      scope,
      dir,
      binding: state.binding,
      device: {
        deviceId: this.options.device.deviceId,
        label: this.options.device.label,
      },
      onLocalChange: () => undefined,
      recordUsage: () => undefined,
      runConsolidation: () =>
        Promise.resolve({ status: 'cancelled', reason: 'cancelled' }),
    });
    return true;
  }

  /**
   * Finishes a first enable whose commit the cloud accepted though this
   * device never saw it land (its answer or the pull after it was lost):
   * the commit recorded before sending is looked up in the scope's history,
   * and when it is there the replica pulls it, is marked done and is used.
   * Its notes are never sent again: the cloud consumed them. `none` when no
   * such commit is pending or it did not land.
   */
  private async recoverFirstEnable(
    scope: MemoryScopeRef,
    signal: AbortSignal,
  ): Promise<'none' | 'done' | MemorySyncFailure> {
    const dir = this.scopeDir(scope);
    const state = await readMemorySyncState(dir);
    const firstEnable = state?.firstEnable ?? null;
    if (
      state === undefined ||
      state === null ||
      firstEnable === null ||
      !awaitsFirstEnable(state) ||
      firstEnable.commitId === undefined ||
      firstEnable.preMergeRevision === null
    ) {
      return 'none';
    }
    const parent = firstEnable.preMergeRevision;
    const forget = async (): Promise<'none'> => {
      await this.updateState(dir, {
        firstEnable: {
          state: firstEnable.state,
          startedAt: firstEnable.startedAt,
          preMergeRevision: firstEnable.preMergeRevision,
          ...(firstEnable.sentNoteIds === undefined
            ? {}
            : { sentNoteIds: firstEnable.sentNoteIds }),
        },
      });
      return 'none';
    };
    const listed = await this.options.transport.listRevisions(
      state.binding.scopeId,
      parent + 2,
      signal,
    );
    if (!listed.ok) {
      // The scope is gone, and the commit with it: the next review starts
      // over from this device's memory, which nothing changed.
      return listed.failure.kind === 'scope_deleted' ||
        failureCode(listed.failure) === 'memory_scope_not_found'
        ? forget()
        : listed.failure;
    }
    const landed = listed.value.revisions.find(
      (revision) => revision.revision === parent + 1,
    );
    if (landed === undefined) return 'none';
    // Another commit took that revision: this one never will.
    if (landed.commitId !== firstEnable.commitId) return forget();
    const pulled = await this.pull(scope, signal);
    if (pulled !== null) return pulled;
    const done: NonNullable<MemorySyncStateFile['firstEnable']> = {
      state: 'done',
      startedAt: firstEnable.startedAt,
      preMergeRevision: landed.kind === 'merge' ? parent : null,
    };
    // The review the replica recorded carries what was saved since it into
    // the replica, in this session or after a restart.
    const reviewed = await this.readFirstEnableReview(dir);
    const sourceDir =
      reviewed === null ? null : await this.firstEnableSourceDir(scope);
    if (reviewed === null || sourceDir === null) {
      await this.markFirstEnableDone(scope, done);
      return 'done';
    }
    if (isLocalMemoryConsolidationRunning(sourceDir)) {
      return { kind: 'retry', code: 'memory_busy' };
    }
    await this.finishAppliedFirstEnable(
      scope,
      state.binding,
      { ...reviewed, sourceDir },
      done,
    );
    return 'done';
  }

  /** Records the first enable done, uses the replica, forgets its source. */
  private async markFirstEnableDone(
    scope: MemoryScopeRef,
    firstEnable: NonNullable<MemorySyncStateFile['firstEnable']>,
  ): Promise<void> {
    await this.updateState(this.scopeDir(scope), { firstEnable });
    await this.registerReplica(scope);
    await rm(this.retiredSourceRecord(scope), { force: true });
    await rm(firstEnableReviewFile(this.scopeDir(scope)), { force: true });
  }

  private async firstEnableSteps(
    scope: MemoryScopeRef,
    preview: PendingFirstEnable,
  ): Promise<MemorySyncControlResult<MemoryFirstEnableApplied>> {
    const { signal } = this.controller;
    // The scope's eligibility as it stands right now, its project binding
    // read again: every write below is gated on it still holding, so a
    // project unbound, made private or set device_only during the apply
    // sends nothing (design §22).
    const scopeFence = await this.syncingFence(scope);
    if (scopeFence === null) {
      return {
        ok: false,
        code: scope.kind === 'user' ? 'sync_off' : 'changed',
      };
    }
    const dir = this.scopeDir(scope);
    const resolved = await this.options.transport.resolveScope(
      scope,
      true,
      signal,
    );
    if (!resolved.ok) return this.controlFailure(resolved.failure);
    const record = resolved.value.scope;
    if (record.revision !== preview.baseRevision) {
      return { ok: false, code: 'changed' };
    }
    // The organizations that keep notes off the cloud now, not at the
    // review: nothing a merge read and nothing sent may be held back.
    const settings = await this.options.transport.settings(signal);
    if (!settings.ok) return this.controlFailure(settings.failure);
    this.settings = settings.value.settings;
    this.policy = settings.value.policy;
    if (this.reviewHoldsBackNotes(scope, preview)) {
      return { ok: false, code: 'changed' };
    }
    const existing = await readMemorySyncState(dir);
    if (existing !== undefined && existing !== null) {
      if (!awaitsFirstEnable(existing)) {
        if (existing.mode !== 'deleted_in_cloud') {
          return { ok: false, code: 'already_applied' };
        }
        // The deleted copy is the memory being sent: it moves aside now,
        // after the cloud scope was checked, and stays this device's memory
        // until the first enable is done.
        preview.sourceDir = await this.retireDeletedReplica(scope);
      } else if (existing.binding.scopeId !== record.scopeId) {
        // An earlier try's replica of a cloud scope that is gone holds only
        // copies; it moves aside so this one starts clean.
        await mkdir(this.retiredDir, { recursive: true });
        await rename(
          dir,
          join(
            this.retiredDir,
            `${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${basename(dir)}-unfinished`,
          ),
        );
      }
    }
    const binding: MemoryReplicaBinding = {
      accountId: this.options.accountId,
      scopeId: record.scopeId,
      kind: record.kind,
      projectId: record.projectId,
    };
    await this.ensureAccountFile();
    const startedAt = new Date(this.now()).toISOString();
    await withMemoryScopeLock(dir, async () => {
      await createReplicaManifest(dir, binding);
      const read = await readMemorySyncState(dir);
      const state =
        read === undefined || read === null
          ? initialMemorySyncState(binding, this.options.device.deviceId)
          : read;
      await writeMemorySyncState(dir, {
        ...state,
        // A note kept on this device stays so in the new replica, also when
        // a re-enable sends a deleted copy that kept it.
        localOnlyNoteIds: [
          ...new Set([...state.localOnlyNoteIds, ...preview.keptOnDeviceIds]),
        ],
        firstEnable: {
          state: 'uploading',
          startedAt,
          preMergeRevision: preview.baseRevision,
          ...(state.firstEnable?.sentNoteIds === undefined
            ? {}
            : { sentNoteIds: state.firstEnable.sentNoteIds }),
        },
      });
      await writeMemoryFileAtomically(
        dir,
        firstEnableReviewFile(dir),
        `${JSON.stringify({ version: 1, kind: preview.kind, review: preview.review })}\n`,
      );
    });
    const synced = await this.pull(scope, signal);
    if (synced !== null) return this.controlFailure(synced);
    await this.queueFirstEnableNotes(
      dir,
      binding,
      preview.inbox,
      preview.imports,
      new Set(preview.keptOnDeviceIds),
    );
    const pushed = await this.pushFirstEnableNotes(scopeFence, preview);
    if (!pushed.ok) return pushed;
    const { consumedNoteIds, refusedNotes } = pushed.value;
    const commitId =
      preview.changes.length > 0 || consumedNoteIds.length > 0
        ? memoryNoteIdAt(this.now())
        : null;
    const sent = (await readMemorySyncState(dir))?.firstEnable?.sentNoteIds;
    await this.updateState(dir, {
      firstEnable: {
        state: 'merging',
        startedAt,
        preMergeRevision: preview.baseRevision,
        ...(commitId === null ? {} : { commitId }),
        ...(sent === undefined ? {} : { sentNoteIds: sent }),
      },
    });
    if (commitId !== null) {
      const committed = await this.commitFirstEnable(
        scopeFence,
        binding.scopeId,
        preview,
        commitId,
        consumedNoteIds,
      );
      if (!committed.ok) return committed;
    }
    const pulled = await this.pull(scope, signal);
    if (pulled !== null) return this.controlFailure(pulled);
    const finished = await this.finishAppliedFirstEnable(
      scope,
      binding,
      {
        kind: preview.kind,
        review: preview.review,
        sourceDir: preview.sourceDir,
      },
      {
        state: 'done',
        startedAt,
        preMergeRevision:
          preview.kind === 'merge' ? preview.baseRevision : null,
      },
      scopeFence,
    );
    if (!finished) {
      return {
        ok: false,
        code: scope.kind === 'user' ? 'sync_off' : 'changed',
      };
    }
    return { ok: true, value: { refusedNotes } };
  }

  /**
   * The organizations that keep this scope's notes off the cloud now, as the
   * account policy names them. The review, the apply, the outbox and a
   * leased consolidation all hold back notes by this one rule.
   */
  private originPolicy(scope: MemoryScopeRef): MemoryOriginPolicy {
    return {
      scopeKind: scope.kind,
      blockedOriginOrganizationIds: new Set(
        this.policy?.blockedOriginOrganizationIds ?? [],
      ),
    };
  }

  /**
   * Whether a note the review sends or its merge read must stay on this
   * device under the current policy: the merge may carry any note it read
   * into a document, consumed or not, so the review must be shown again.
   */
  private reviewHoldsBackNotes(
    scope: MemoryScopeRef,
    preview: PendingFirstEnable,
  ): boolean {
    const origins = this.originPolicy(scope);
    const kept = new Set(preview.keptOnDeviceIds);
    return (
      preview.inputNotes.some(({ organizationId }) =>
        isMemoryNoteOriginBlocked(origins, organizationId),
      ) ||
      preview.inbox.some(
        ({ op }) =>
          !kept.has(op.note.noteId) && isFirstEnableNoteHeldBack(op, origins),
      )
    );
  }

  /** The review an applied first enable recorded in its replica, if any. */
  private async readFirstEnableReview(dir: string): Promise<{
    kind: MemoryFirstEnableKind;
    review: MemoryFirstEnableReview;
  } | null> {
    try {
      const parsed = FirstEnableReviewFileSchema.safeParse(
        JSON.parse(await readFile(firstEnableReviewFile(dir), 'utf8')),
      );
      return parsed.success
        ? { kind: parsed.data.kind, review: parsed.data.review }
        : null;
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Marks an applied first enable done and uses the replica, in one critical
   * section under the scope lock of the memory it sent, which every writer
   * to that folder holds: memory saved there after the review goes into the
   * replica as notes first (an inbox note as itself, a document or import
   * as an import note), so nothing saved meanwhile is left behind. A save
   * that waited for the lock finds the scope resolving to the replica.
   */
  private async finishAppliedFirstEnable(
    scope: MemoryScopeRef,
    binding: MemoryReplicaBinding,
    applied: {
      kind: MemoryFirstEnableKind;
      review: MemoryFirstEnableReview;
      sourceDir: string;
    },
    firstEnable: NonNullable<MemorySyncStateFile['firstEnable']>,
    fence?: ScopeFence,
  ): Promise<boolean> {
    return withMemoryScopeLock(applied.sourceDir, async () => {
      // A scope relinked, unbound or kept on this device since the apply
      // began takes no late note and stays unfinished.
      if (
        fence !== undefined &&
        (!this.fenceHolds(fence) || !(await this.stillBound(fence)))
      ) {
        return false;
      }
      const current = await readFirstEnableSource(applied.sourceDir);
      const late = lateFirstEnableNotes(
        applied.review,
        current,
        {
          deviceId: this.options.device.deviceId,
          label: this.options.device.label,
        },
        applied.kind,
      );
      const origins = this.originPolicy(scope);
      await this.queueFirstEnableNotes(
        this.scopeDir(scope),
        binding,
        late.inbox,
        late.imports,
        new Set(
          late.inbox
            .filter(({ op }) => isFirstEnableNoteHeldBack(op, origins))
            .map(({ op }) => op.note.noteId),
        ),
      );
      await this.markFirstEnableDone(scope, firstEnable);
      return true;
    });
  }

  /**
   * Puts this device's inbox notes into the replica as its own notes, each
   * queued before its file is written as a note save does, and queues import
   * notes alone. A note in `kept` stays on this device: it is marked
   * local-only before its file is written and never sent. A note the
   * replica already holds (pending or consumed), or that an earlier try
   * queued, is left as it is; one whose name another note holds is written
   * under a name of its own.
   */
  private async queueFirstEnableNotes(
    dir: string,
    binding: MemoryReplicaBinding,
    inbox: readonly MemoryFirstEnableInboxNote[],
    imports: readonly MemoryNoteOp[],
    kept: ReadonlySet<string>,
  ): Promise<void> {
    const now = new Date(this.now());
    await withMemoryWriteLock(dir, async () => {
      const queued = new Set(
        (await readQueuedMemoryNoteOps(dir, binding)).map((entry) =>
          noteIdOf(entry.op),
        ),
      );
      const present = await readReplicaInboxNotes(dir);
      for (const { content, op } of inbox) {
        const { noteId } = op.note;
        if (queued.has(noteId) || present.noteIds.has(noteId)) continue;
        const fileKey = freeNoteFileKey(op.note.fileKey, noteId, present.names);
        if (kept.has(noteId)) {
          await markMemoryNotesLocalOnly(dir, [noteId]);
        } else {
          await queueMemoryNoteOp(
            dir,
            binding,
            fileKey === op.note.fileKey
              ? op
              : { ...op, note: { ...op.note, fileKey } },
            now,
            null,
          );
        }
        await writeMemoryFileAtomically(dir, join(dir, fileKey), content);
        present.noteIds.add(noteId);
        present.names.add(portableFileNameIdentity(fileKey));
        queued.add(noteId);
      }
      for (const op of imports) {
        if (!queued.has(noteIdOf(op))) {
          await queueMemoryNoteOp(dir, binding, op, now, null);
          queued.add(noteIdOf(op));
        }
      }
      const state = await readMemorySyncState(dir);
      const firstEnable = state?.firstEnable ?? null;
      if (state && firstEnable !== null && firstEnable.state !== 'done') {
        const sent = [
          ...inbox
            .map(({ op }) => op.note.noteId)
            .filter((noteId) => !kept.has(noteId)),
          ...imports.map(noteIdOf),
        ];
        await writeMemorySyncState(dir, {
          ...state,
          firstEnable: {
            ...firstEnable,
            sentNoteIds: [
              ...new Set([...(firstEnable.sentNoteIds ?? []), ...sent]),
            ],
          },
        });
      }
    });
  }

  /**
   * Sends the first enable's notes the way every note goes: in batches taken
   * from the outbox under the scope lock, holding back notes an organization
   * keeps off the cloud (design §10.4), settled by `seq`. Resolves the notes
   * the merge may consume: those the cloud took, by the ID it keeps. A note
   * the merge read that now stays here (its organization began keeping it
   * off the cloud, or the cloud refused it) answers `changed`, consumed or
   * not: the merged documents may carry its content, so the person reviews
   * again without it. Also resolves how many of this device's notes the
   * cloud refused, so the apply never reports a plain success for a first
   * enable that left notes here.
   */
  private async pushFirstEnableNotes(
    scopeFence: ScopeFence,
    preview: PendingFirstEnable,
  ): Promise<
    MemorySyncControlResult<{
      consumedNoteIds: string[];
      refusedNotes: number;
    }>
  > {
    const { scope } = scopeFence;
    const dir = this.scopeDir(scope);
    const ours = new Set([
      ...preview.inbox.map(({ op }) => op.note.noteId),
      ...preview.imports.map(noteIdOf),
    ]);
    const canonical = new Map<string, string>();
    const refusedIds = new Set<string>();
    for (let round = 0; round < FIRST_ENABLE_PUSH_ROUNDS; round += 1) {
      const failure = await this.push(scopeFence, (results) => {
        for (const result of results) {
          if (result.outcome === 'deduplicated') {
            canonical.set(result.noteId, result.canonicalNoteId);
          } else if (result.outcome === 'rejected' && ours.has(result.noteId)) {
            refusedIds.add(result.noteId);
          }
        }
      });
      if (failure !== null) return this.controlFailure(failure);
      const state = await readMemorySyncState(dir);
      if (state === undefined || state === null) {
        return { ok: false, code: 'not_synced' };
      }
      const queued = await readQueuedMemoryNoteOps(dir, state.binding);
      if (!queued.some((entry) => ours.has(noteIdOf(entry.op)))) {
        const keptLocal = new Set(state.localOnlyNoteIds);
        if (
          preview.inputNotes.some(({ noteId }) => keptLocal.has(noteId)) ||
          this.reviewHoldsBackNotes(scope, preview)
        ) {
          return { ok: false, code: 'changed' };
        }
        return {
          ok: true,
          value: {
            consumedNoteIds: [
              ...new Set(
                preview.consumedNoteIds.map(
                  (noteId) => canonical.get(noteId) ?? noteId,
                ),
              ),
            ],
            refusedNotes: refusedIds.size,
          },
        };
      }
    }
    return { ok: false, code: 'offline' };
  }

  private async commitFirstEnable(
    scopeFence: ScopeFence,
    scopeId: string,
    preview: PendingFirstEnable,
    commitId: string,
    consumedNoteIds: string[],
  ): Promise<MemorySyncControlResult<null>> {
    const { scope, signal } = scopeFence;
    const acquired = await this.options.transport.acquireLease(
      scopeId,
      'first_enable',
      signal,
    );
    if (!acquired.ok) return this.controlFailure(acquired.failure);
    const { lease } = acquired.value;
    const fence = { leaseId: lease.leaseId, epoch: lease.epoch };
    let committed = false;
    try {
      const state = await readMemorySyncState(this.scopeDir(scope));
      // The replica is not registered until the first enable is done, so
      // nothing else stops this commit for an engine that stopped or a
      // replica bound to another account.
      if (
        this.stopped ||
        state?.binding.accountId !== this.options.accountId ||
        state.binding.scopeId !== scopeId
      ) {
        return { ok: false, code: 'not_running' };
      }
      if (
        state === undefined ||
        state === null ||
        lease.baseRevision !== preview.baseRevision ||
        state.baseRevision !== preview.baseRevision
      ) {
        return { ok: false, code: 'changed' };
      }
      const sent = await this.sendCommit(
        scope,
        state,
        {
          kind: preview.kind === 'upload' ? 'import' : 'merge',
          lease: fence,
          changes: preview.changes,
          consumedNoteIds,
          metadata: {
            model: preview.model,
            promptVersion:
              preview.kind === 'upload'
                ? null
                : MEMORY_CONSOLIDATION_PROMPT_VERSION,
            consolidationPackageVersion:
              preview.kind === 'upload'
                ? null
                : MEMORY_CONSOLIDATION_PACKAGE_VERSION,
            inputHash: preview.inputHash,
          },
        },
        scopeFence,
        commitId,
      );
      if (!sent.ok) {
        const code = failureCode(sent.failure);
        return code === 'memory_revision_conflict' ||
          code === 'memory_notes_changed'
          ? { ok: false, code: 'changed' }
          : this.controlFailure(sent.failure);
      }
      committed = true;
      return { ok: true, value: null };
    } finally {
      const released = await this.options.transport
        .releaseLease(scopeId, {
          ...fence,
          outcome: committed ? 'committed' : 'abandoned',
        })
        .catch(() => null);
      if (released !== null && !released.ok) {
        this.leaseRunFailure(released.failure);
      }
    }
  }

  /** Runs `section` alone among passes and commits. */
  private exclusive<T>(section: () => Promise<T>): Promise<T> {
    const next = this.exclusiveTail.then(section, section);
    this.exclusiveTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * What a scope's failure means: scope modes here, a retry of the scope's
   * own on its schedule, and what concerns the account engine-wide.
   */
  private async scopeOutcome(
    scope: MemoryScopeRef,
    failure: MemorySyncFailure,
  ): Promise<ScopeOutcome> {
    const dir = this.scopeDir(scope);
    switch (failure.kind) {
      case 'scope_deleted':
        await this.updateState(dir, { mode: 'deleted_in_cloud' });
        await this.registerReplica(scope);
        await this.refreshScopeStatus(scope);
        return { kind: 'ok' };
      case 'device_only':
        await this.updateState(dir, { mode: 'device_only' });
        await this.refreshScopeStatus(scope);
        return { kind: 'ok' };
      case 'paused':
        await this.updateState(dir, { mode: 'paused' });
        await this.refreshScopeStatus(scope);
        return { kind: 'halt', state: 'paused', reason: failure.code };
      case 'refused':
        await this.recordRefusal(dir, 'push_refused', failure.code);
        await this.refreshScopeStatus(scope);
        return { kind: 'ok' };
      default: {
        const outcome = this.scopeFailureOutcome(failure);
        if (outcome.kind === 'scope_retry' && 'code' in failure) {
          await this.recordScopeError(dir, failure.code);
        }
        await this.refreshScopeStatus(scope);
        return outcome;
      }
    }
  }

  /**
   * Creates the replica of a scope this device has no memory in yet: the
   * cloud scope, its folder bound to it, then its snapshot.
   */
  private async createReplica(fence: ScopeFence): Promise<ScopeOutcome> {
    const { scope, signal } = fence;
    if (await this.firstEnableSourceHasMemory(scope)) {
      await this.registerReplica(scope);
      this.markNeedsFirstEnable(scope);
      return { kind: 'ok' };
    }
    if (!(await this.stillBound(fence))) throw new MemoryScopeFencedError();
    this.ensureFence(fence);
    const resolved = await this.options.transport.resolveScope(
      scope,
      true,
      signal,
    );
    if (!resolved.ok) {
      return scope.kind === 'project'
        ? this.projectCreateRefusal(scope, resolved.failure)
        : this.scopeFailureOutcome(resolved.failure);
    }
    this.checkAborted(signal);
    const record = resolved.value.scope;
    const binding: MemoryReplicaBinding = {
      accountId: this.options.accountId,
      scopeId: record.scopeId,
      kind: record.kind,
      projectId: record.projectId,
    };
    await this.ensureAccountFile();
    const dir = this.scopeDir(scope);
    await withMemoryScopeLock(dir, async () => {
      await createReplicaManifest(dir, binding);
      if ((await readMemorySyncState(dir)) === undefined) {
        await writeMemorySyncState(dir, {
          ...initialMemorySyncState(binding, this.options.device.deviceId),
          firstEnable: firstEnableStarted(new Date(this.now())),
        });
      }
    });
    return { kind: 'ok' };
  }

  /**
   * A project scope the cloud will not create (kept on devices, private, a
   * project this account can no longer use) is that project's state, not
   * the engine's: the other scopes still sync.
   */
  private projectCreateRefusal(
    scope: ProjectScopeRef,
    failure: MemorySyncFailure,
  ): ScopeOutcome {
    const key = memoryScopeKey(scope);
    if (failure.kind === 'device_only') {
      this.scopeStatus.set(key, emptyScopeStatus(scope, 'device_only'));
      return { kind: 'ok' };
    }
    if (failure.kind === 'refused' || failure.kind === 'scope_deleted') {
      this.options.recordProblem?.({
        kind: 'project_replica',
        code: failure.code,
      });
      this.scopeStatus.set(key, {
        ...emptyScopeStatus(scope, 'paused'),
        lastError: {
          code: failure.code,
          at: new Date(this.now()).toISOString(),
        },
      });
      return { kind: 'ok' };
    }
    return this.scopeFailureOutcome(failure);
  }

  private async deviceLocalHasMemory(scope: MemoryScopeRef): Promise<boolean> {
    const localDir = this.options.deviceLocalDir(scope);
    return localDir !== null && (await scopeFolderHasMemory(localDir));
  }

  /** Device-local memory exists: merging it is the first-enable flow's job. */
  private markNeedsFirstEnable(scope: MemoryScopeRef): void {
    this.scopeStatus.set(memoryScopeKey(scope), {
      scope,
      mode: 'needs_first_enable',
      queuedOps: 0,
      localOnlyNotes: 0,
      conflicts: 0,
      lastPulledAt: null,
      lastPushedAt: null,
      lastError: null,
    });
  }

  /**
   * Registers a replica created here for the first time, in one critical
   * section under the device-local folder's scope lock, which every writer
   * to that folder holds while it writes: the folder must still hold no
   * memory, otherwise the first enable stays pending (design §17) and the
   * device keeps its device-local memory. A save that waited for the lock
   * finds the scope resolving to the replica. The bare scope lock, unlike
   * `withMemoryWriteLock`, neither backfills the device-local folder nor
   * refuses one a newer build made read-only.
   */
  private async finishFirstEnable(scope: MemoryScopeRef): Promise<boolean> {
    const dir = this.scopeDir(scope);
    const localDir =
      (await this.pendingRetiredSource(scope)) ??
      this.options.deviceLocalDir(scope);
    const finish = async (): Promise<boolean> => {
      if (localDir !== null && (await scopeFolderHasMemory(localDir))) {
        return false;
      }
      await withMemoryWriteLock(dir, async () => {
        const state = await readMemorySyncState(dir);
        if (state === undefined || state === null) return;
        await writeMemorySyncState(dir, {
          ...state,
          firstEnable: {
            ...(state.firstEnable ?? firstEnableStarted(new Date(this.now()))),
            state: 'done',
          },
        });
      });
      const registered = await this.registerReplica(scope);
      if (registered)
        await rm(this.retiredSourceRecord(scope), { force: true });
      return registered;
    };
    return localDir === null ? finish() : withMemoryScopeLock(localDir, finish);
  }

  private async ensureAccountFile(): Promise<void> {
    if ((await readMemoryReplicaAccount(this.accountDir)) !== undefined) return;
    await writeMemoryReplicaAccount(this.accountDir, {
      version: 1,
      accountId: this.options.accountId,
      deviceId: this.options.device.deviceId,
      createdAt: new Date(this.now()).toISOString(),
      settingsRevision: this.settings?.revision ?? 0,
    });
  }

  /** Pulls to the head; takes a snapshot when there is no usable cursor. */
  private async pull(
    scope: MemoryScopeRef,
    signal: AbortSignal,
  ): Promise<MemorySyncFailure | null> {
    const dir = this.scopeDir(scope);
    let snapshotTaken = false;
    for (let page = 0; page < MAX_PAGES_PER_PASS; page += 1) {
      this.checkAborted(signal);
      const state = await readMemorySyncState(dir);
      if (state === undefined || state === null) return null;
      if (state.cursor !== null && state.mode !== 'repair_needed') {
        const step = await this.pullPage(
          scope,
          state.binding.scopeId,
          state.cursor,
          signal,
        );
        if (step === 'done') {
          // Caught up: a commit this replica sent and never saw land did
          // not land (design §12.1); its run is gone.
          if ((await readMemorySyncState(dir))?.pendingCommit != null) {
            await this.updateState(dir, { pendingCommit: null });
          }
          return null;
        }
        if (step !== 'more') return step;
        continue;
      }
      if (snapshotTaken) return { kind: 'retry', code: 'snapshot_repeated' };
      snapshotTaken = true;
      const failure = await this.snapshot(scope, state.binding.scopeId, signal);
      if (failure !== null) {
        return failure.kind === 'snapshot'
          ? { kind: 'retry', code: failure.code }
          : failure;
      }
    }
    return null;
  }

  /**
   * Pulls and applies one page from `fromCursor`. A page that does not
   * continue the replica marks it for a snapshot ('more' then takes it).
   */
  private async pullPage(
    scope: MemoryScopeRef,
    scopeId: string,
    fromCursor: string,
    signal: AbortSignal,
  ): Promise<'done' | 'more' | MemorySyncFailure> {
    const dir = this.scopeDir(scope);
    const needsSnapshot = async (
      problem: MemorySyncProblem,
    ): Promise<'more'> => {
      this.options.recordProblem?.(problem);
      await this.updateState(dir, { mode: 'repair_needed' });
      return 'more';
    };
    const result = await this.options.transport.changesPage(
      scopeId,
      fromCursor,
      signal,
    );
    if (!result.ok) {
      return result.failure.kind === 'snapshot'
        ? needsSnapshot({ kind: 'page_check', code: result.failure.code })
        : result.failure;
    }
    const problem = checkMemoryChangesPage(fromCursor, result.value);
    if (problem !== null)
      return needsSnapshot({ kind: 'page_check', code: problem });
    try {
      this.reportApplied(
        await applyMemoryReplicaChanges(
          dir,
          {
            fromCursor,
            nextCursor: result.value.nextCursor,
            changes: result.value.changes,
          },
          this.writeOptions(),
        ),
      );
    } catch (error) {
      if (!(error instanceof MemoryReplicaGapError)) throw error;
      return needsSnapshot({ kind: 'replica_gap', code: error.reason });
    }
    if (result.value.changes.length > 0) this.options.onScopeChanged?.(scope);
    return result.value.hasMore ? 'more' : 'done';
  }

  /** Every page of the scope's snapshot, pinned to one revision. */
  private async readSnapshot(
    scopeId: string,
    signal: AbortSignal,
  ): Promise<
    MemorySyncResult<{
      revision: number;
      cursor: string;
      documents: MemoryDocument[];
      pendingNotes: MemoryNoteRecord[];
    }>
  > {
    const documents: MemoryDocument[] = [];
    const pendingNotes: MemoryNoteRecord[] = [];
    let pinned: { revision: number; cursor: string } | null = null;
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES_PER_PASS; page += 1) {
      this.checkAborted(signal);
      const result = await this.options.transport.snapshotPage(
        scopeId,
        pageToken,
        signal,
      );
      if (!result.ok) return result;
      const value = result.value;
      if (
        pinned !== null &&
        (pinned.revision !== value.revision || pinned.cursor !== value.cursor)
      ) {
        this.options.recordProblem?.({
          kind: 'snapshot_inconsistent',
          code: 'pin_moved',
        });
        return {
          ok: false,
          failure: { kind: 'retry', code: 'snapshot_inconsistent' },
        };
      }
      pinned = { revision: value.revision, cursor: value.cursor };
      documents.push(...value.documents);
      pendingNotes.push(...value.pendingNotes);
      pageToken = value.nextPageToken;
      if (pageToken === null) break;
    }
    if (pinned === null || pageToken !== null) {
      return {
        ok: false,
        failure: { kind: 'retry', code: 'snapshot_incomplete' },
      };
    }
    return { ok: true, value: { ...pinned, documents, pendingNotes } };
  }

  private async snapshot(
    scope: MemoryScopeRef,
    scopeId: string,
    signal: AbortSignal,
  ): Promise<MemorySyncFailure | null> {
    const read = await this.readSnapshot(scopeId, signal);
    if (!read.ok) return read.failure;
    const { revision, cursor, documents, pendingNotes } = read.value;
    const pinned = { revision, cursor };
    const dir = this.scopeDir(scope);
    await applyMemoryReplicaSnapshot(
      dir,
      { ...pinned, documents, pendingNotes },
      this.writeOptions(),
    );
    this.options.onScopeChanged?.(scope);
    await this.updateState(dir, { mode: 'syncing' });
    return null;
  }

  /**
   * Sends the scope's outbox in order, one batch at a time. Each batch is
   * taken from the outbox as it is then, under the account's current origin
   * policy, so a note queued during a push is held back like any other.
   * When an answer replays a note the last snapshot kept for the outbox's
   * sake, the scope pulls again afterwards, which settles that note.
   */
  private async push(
    fence: ScopeFence,
    onResults?: (results: readonly MemoryNoteOpResult[]) => void,
  ): Promise<MemorySyncFailure | null> {
    const { scope, signal } = fence;
    const dir = this.scopeDir(scope);
    let replayedKept = false;
    for (let push = 0; push < MAX_PUSHES_PER_PASS; push += 1) {
      this.checkAborted(signal);
      const state = await readMemorySyncState(dir);
      if (state === undefined || state === null) return null;
      const gate = this.writeGate(fence, dir, state.binding.scopeId);
      const batch = await takeMemoryPushBatch(
        dir,
        new Set(this.policy?.blockedOriginOrganizationIds ?? []),
        gate.maySend,
      );
      if (gate.refused) throw new MemoryScopeFencedError();
      if (batch.length === 0) break;
      this.ensureFence(fence);
      const result = await this.options.transport.pushNotes(
        state.binding.scopeId,
        { ops: batch.map(({ op }) => op) },
        signal,
      );
      if (!result.ok) return result.failure;
      onResults?.(result.value.results);
      const settled = await settleMemoryPush(
        dir,
        batch,
        result.value.results,
        new Date(this.now()),
        result.value.cursor,
      );
      if (settled.snapshotKeptReplayed > 0) replayedKept = true;
      if (settled.rejectedCode !== null) {
        this.options.recordProblem?.({
          kind: 'push_refused',
          code: settled.rejectedCode,
        });
      }
      if (settled.acknowledged + settled.keptLocal === 0) {
        return { kind: 'retry', code: 'push_unacknowledged' };
      }
    }
    return replayedKept ? this.pull(scope, signal) : null;
  }

  private async refreshScopeStatus(scope: MemoryScopeRef): Promise<void> {
    const dir = this.scopeDir(scope);
    const state = await readMemorySyncState(dir).catch(() => null);
    if (state === undefined || state === null) return;
    const queued = await readQueuedMemoryNoteOps(dir, state.binding).catch(
      () => [],
    );
    this.scopeStatus.set(memoryScopeKey(scope), {
      scope,
      mode: state.mode,
      queuedOps: queued.length,
      localOnlyNotes: state.localOnlyNoteIds.length,
      conflicts: state.conflicts.length,
      lastPulledAt: state.lastPulledAt,
      lastPushedAt: state.lastPushedAt,
      lastError:
        state.lastError === null
          ? null
          : { code: state.lastError.code, at: state.lastError.at },
    });
  }
}
