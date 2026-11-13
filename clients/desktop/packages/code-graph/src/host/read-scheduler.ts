import type { CodeGraphReadFailure } from '../types/code-graph-tools';
import {
  CodeGraphWorkerReadError,
  codeGraphReadFailure,
  isReadFailure,
} from './read-failure';
import { parseGraphDiagnostics } from '../diagnostics';
import {
  codeGraphSummaryProjectionV1Schema,
  type ReadCodeGraphSummaryProjectionResult,
} from '../summary-projection';
import type {
  CodeGraphWorkerReadTask,
  CodeGraphWorkerReadRequest,
  CodeGraphBaseIdentityReadResult,
  CodeGraphWorkerReadResponse,
} from './read-protocol';

/*
 * The code-graph read scheduler: a bounded pool of long-lived read hosts with
 * per-class admission (interactive, comparison, maintenance), queue limits
 * and deadlines, aged turns, warm same-key reuse with LRU eviction, key and
 * workspace fences, awaitable cancellation and a draining shutdown. It is
 * host-neutral: the host that composes it launches read hosts and records
 * telemetry through `CodeGraphReadSchedulerHost`.
 */

export type CodeGraphQueryKind =
  | 'context'
  /**
   * Scheduler-internal staleness read. Kept separate from `context` so the
   * `GetCodeGraphContext` tool's counts and latency percentiles are not
   * dominated by background polling.
   */
  | 'fingerprint-metadata'
  /** Shadow maintenance checking a published base before trusting it. */
  | 'base-validation'
  | 'query'
  | 'search'
  | 'explain'
  | 'impact-radius'
  | 'detect-changed'
  | 'compare-impact'
  | 'review-context'
  | 'ui-summary'
  | 'snapshot-export'
  | 'snapshot-import'
  /** Custom-language validation that loads each grammar (CAN-6010). */
  | 'languages-validate';

export type CodeGraphQueryOutcome =
  | 'success'
  | 'error'
  | 'timeout'
  | 'canceled';

export {
  CodeGraphReadFailureError,
  CodeGraphWorkerReadError,
  codeGraphReadFailure,
  isReadFailure,
  type CodeGraphWorkerReadErrorReason,
} from './read-failure';

type ReadAdmissionClass = 'interactive' | 'comparison' | 'maintenance';

interface ReadRecord {
  key: string;
  diagnosticOwner?: { projectId: string; worktreeId: string };
  kind: CodeGraphQueryKind;
  observe?: (observation: CodeGraphReadObservation) => void;
  request: CodeGraphWorkerReadRequest;
  admissionClass: ReadAdmissionClass;
  queuedAt: number;
  startedAt: number | null;
  worker: ReadWorker | null;
  queueWatchdog: NodeJS.Timeout | null;
  watchdog: NodeJS.Timeout | null;
  /** Detaches the caller's abort listener once the record settles. */
  detachAbort: (() => void) | null;
  settled: boolean;
  resolve: (response: CodeGraphWorkerReadResponse) => void;
  reject: (error: CodeGraphWorkerReadError) => void;
}

/**
 * One long-lived read worker process. It serves one key (a worktree, or a
 * base variant) and answers one request at a time. Between requests it may
 * keep one read-only connection to a completed worktree graph, revalidated
 * before every request (`CodeGraphReadConnectionCache` in `read-worker.ts`).
 */
interface ReadWorker {
  key: string;
  child: CodeGraphReadHostProcess;
  /** The request in flight, or null while idle. */
  current: ReadRecord | null;
  idleTimer: NodeJS.Timeout | null;
  /** Monotonic recency for LRU eviction (wall clocks tie within a tick). */
  lastUsed: number;
  /**
   * Whether it has served a tool read (`keepsWorkerWarm`). Only such a worker
   * idles after a request that keeps no warm state.
   */
  servedToolRead: boolean;
  /** Resolves once the process has exited. */
  exited: Promise<void>;
  hasExited: boolean;
  /**
   * Resolves once a kill has reached the process (or it exited). Electron's
   * `kill()` returns false and does nothing before the process has launched
   * (no pid yet), so a worker retired that early is killed again on 'spawn'.
   */
  killLanded: Promise<void>;
  hasKillLanded: boolean;
  markKillLanded: () => void;
}

/**
 * At most this many read worker processes run at once, busy, idle or still
 * exiting (as before pooling).
 */
const CONCURRENCY_CAP = 4;
/** Per-task-kind active slots; the worker cap remains shared across classes. */
const ACTIVE_LIMITS: Record<ReadAdmissionClass, number> = {
  interactive: 3,
  comparison: 1,
  maintenance: 1,
};
/** Independent bounds on each class's waiting queue. */
const QUEUE_LIMITS: Record<ReadAdmissionClass, number> = {
  interactive: 32,
  comparison: 8,
  maintenance: 32,
};
/** Deadlines apply only while waiting and are cleared when execution starts. */
const QUEUE_TIMEOUTS_MS: Record<ReadAdmissionClass, number> = {
  interactive: 5_000,
  comparison: 30_000,
  maintenance: 30_000,
};
const AGING_THRESHOLDS_MS: Partial<Record<ReadAdmissionClass, number>> = {
  comparison: 15_000,
  maintenance: 5_000,
};
/** An idle read worker exits after this long without a request. */
export const CODE_GRAPH_READ_WORKER_IDLE_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Change impact and snapshot transfer walk the whole graph; language
 * validation loads every custom grammar.
 */
const LONG_TASK_TIMEOUT_MS = 5 * 60_000;

function isLongTask(task: CodeGraphWorkerReadTask): boolean {
  return (
    task.kind === 'change-impact' ||
    task.kind === 'snapshot-export' ||
    task.kind === 'snapshot-import' ||
    task.kind === 'languages-validate'
  );
}
/** How long to await a killed worker's exit once the kill has landed. */
const EXIT_WAIT_FALLBACK_MS = 2_000;
/**
 * How long to await a worker retired before it launched: its kill lands on
 * 'spawn'. A launch normally takes milliseconds; this bounds a launch that
 * neither spawns nor reports an exit.
 */
const LAUNCH_WAIT_FALLBACK_MS = 10_000;

function timeoutFor(record: ReadRecord): number {
  return isLongTask(record.request.task)
    ? LONG_TASK_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;
}

function admissionClassFor(
  task: CodeGraphWorkerReadTask,
  kind: CodeGraphQueryKind,
): ReadAdmissionClass {
  switch (task.kind) {
    case 'calls':
      return 'interactive';
    case 'readonly-summary':
      return kind === 'base-validation' ? 'maintenance' : 'interactive';
    case 'detect-changed':
    case 'change-impact':
      return 'comparison';
    default:
      return 'maintenance';
  }
}

function queueTimeoutFor(record: ReadRecord): number {
  return QUEUE_TIMEOUTS_MS[record.admissionClass];
}

/**
 * Whether a request is worth keeping its worker warm for: an agent tool read
 * (`calls`, `detect-changed`, `change-impact`), which reuses the worker's kept
 * connection. Every other request gains at most a fork from a warm process:
 * base validation and the UI summary never use it, and the scheduler's staleness
 * metadata recurs only once the graph has changed. Summaries and staleness
 * checks also arrive in bursts, one per worktree as builds finish or at
 * startup, which would otherwise fill the pool with readers nothing asks again.
 */
function keepsWorkerWarm(task: CodeGraphWorkerReadTask): boolean {
  return (
    task.kind === 'calls' ||
    task.kind === 'detect-changed' ||
    task.kind === 'change-impact'
  );
}

/**
 * Change-impact can build a before-graph, which loads the grammar runtime and
 * leaves a large heap behind, as a snapshot transfer does with the whole graph.
 * Their worker exits after answering instead of idling, so idle readers stay
 * small; the task runs for seconds, so a fresh process costs it little.
 *
 * A worker that has served no tool read exits too, so a build burst over many
 * worktrees does not fill the pool with idle readers nothing will ask again.
 * One warmed by a tool read keeps idling.
 */
function retiresAfter(record: ReadRecord, worker: ReadWorker): boolean {
  const { task } = record.request;
  return isLongTask(task) || (!keepsWorkerWarm(task) && !worker.servedToolRead);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nullableSafeInteger(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

function isDatabaseClassification(value: unknown): boolean {
  return (
    value === 'permission-denied' ||
    value === 'busy' ||
    value === 'corrupt' ||
    value === 'unsupported-schema' ||
    value === 'io'
  );
}

/** Metadata replies are closed DTOs; structural result values keep their existing contract. */
function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function sameClosedShape(value: unknown, parsed: unknown): boolean {
  if (Array.isArray(value) || Array.isArray(parsed)) {
    return (
      Array.isArray(value) &&
      Array.isArray(parsed) &&
      value.length === parsed.length &&
      value.every((entry, index) => sameClosedShape(entry, parsed[index]))
    );
  }
  if (isRecord(value) || isRecord(parsed)) {
    return (
      isRecord(value) &&
      isRecord(parsed) &&
      hasExactKeys(value, Object.keys(parsed)) &&
      Object.keys(parsed).every((key) =>
        sameClosedShape(value[key], parsed[key]),
      )
    );
  }
  return value === parsed;
}

const MAX_METADATA_RESPONSE_BYTES = 1_048_576;
// A ready summary carries independently bounded projection and diagnostics
// components, plus the fixed state/field-name wrapper. Keep the component
// validators below: the larger envelope must not enlarge either component.
const MAX_SUMMARY_RESPONSE_BYTES = 2 * MAX_METADATA_RESPONSE_BYTES + 64;

function boundedJson(
  value: unknown,
  maximumBytes = MAX_METADATA_RESPONSE_BYTES,
): string | null {
  try {
    const raw = JSON.stringify(value);
    return raw !== undefined && Buffer.byteLength(raw, 'utf8') <= maximumBytes
      ? raw
      : null;
  } catch {
    return null;
  }
}

function isBoundedGraphDiagnostics(value: unknown): boolean {
  if (value === null) return true;
  const raw = boundedJson(value);
  if (raw === null) return false;
  const parsed = parseGraphDiagnostics(raw);
  return parsed !== null && sameClosedShape(value, parsed);
}

function isSummaryResult(
  value: unknown,
): value is ReadCodeGraphSummaryProjectionResult {
  if (
    !isRecord(value) ||
    boundedJson(value, MAX_SUMMARY_RESPONSE_BYTES) === null
  )
    return false;
  if (value.state === 'missing') return hasExactKeys(value, ['state']);
  if (value.state === 'error')
    return (
      hasExactKeys(value, ['state', 'classification']) &&
      isDatabaseClassification(value.classification)
    );
  if (value.state === 'ready') {
    return (
      hasExactKeys(value, ['state', 'projection', 'diagnostics']) &&
      codeGraphSummaryProjectionV1Schema.safeParse(value.projection).success &&
      isBoundedGraphDiagnostics(value.diagnostics)
    );
  }
  const observedKeys = [
    'schemaVersion',
    'extractorVersion',
    'projectionRevision',
    'lastBuildAt',
    'completedBuildAt',
    'derivedAt',
  ];
  if (
    value.state !== 'pending' ||
    !hasExactKeys(value, ['state', 'reason', 'observed', 'diagnostics']) ||
    !isRecord(value.observed) ||
    !hasExactKeys(value.observed, observedKeys)
  )
    return false;
  return (
    typeof value.reason === 'string' &&
    [
      'projection-missing',
      'projection-invalid',
      'projection-mismatch',
      'build-incomplete',
    ].includes(value.reason) &&
    observedKeys.every(
      (key) =>
        isRecord(value.observed) && nullableSafeInteger(value.observed[key]),
    ) &&
    isBoundedGraphDiagnostics(value.diagnostics)
  );
}

function containsAsciiIdentityControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeIdentityText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    !/[\\/]/.test(value) &&
    !containsAsciiIdentityControl(value)
  );
}

function isBaseIdentityResult(
  value: unknown,
): value is CodeGraphBaseIdentityReadResult {
  if (!isRecord(value) || boundedJson(value) === null) return false;
  if (value.state === 'missing') return hasExactKeys(value, ['state']);
  if (value.state === 'error')
    return (
      hasExactKeys(value, ['state', 'classification']) &&
      isDatabaseClassification(value.classification)
    );
  const matchKeys = [
    'schema',
    'extractor',
    'canonicalRoot',
    'customLanguagesFingerprint',
    'repoId',
    'gitHead',
    'completed',
  ];
  const observedKeys = [
    'schemaVersion',
    'extractorVersion',
    'lastBuildAt',
    'completedBuildAt',
  ];
  if (
    value.state !== 'readable' ||
    !hasExactKeys(value, ['state', 'matches', 'observed', 'repository']) ||
    !isRecord(value.matches) ||
    !hasExactKeys(value.matches, matchKeys) ||
    !isRecord(value.observed) ||
    !hasExactKeys(value.observed, observedKeys)
  )
    return false;
  return (
    matchKeys.every(
      (key) =>
        isRecord(value.matches) && typeof value.matches[key] === 'boolean',
    ) &&
    observedKeys.every(
      (key) =>
        isRecord(value.observed) && nullableSafeInteger(value.observed[key]),
    ) &&
    (value.repository === null ||
      (isRecord(value.repository) &&
        hasExactKeys(value.repository, ['repoId', 'gitHead']) &&
        safeIdentityText(value.repository.repoId, 1024) &&
        (value.repository.gitHead === null ||
          safeIdentityText(value.repository.gitHead, 512))))
  );
}

function isWorkerResponse(
  value: unknown,
  task: CodeGraphWorkerReadTask,
): value is CodeGraphWorkerReadResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (!value.ok)
    return (
      hasExactKeys(value, ['ok', 'code', 'message']) &&
      isReadFailure(value.code) &&
      typeof value.message === 'string' &&
      Buffer.byteLength(value.message, 'utf8') <= 512
    );
  if (
    !hasExactKeys(value, ['ok', 'result']) ||
    !isRecord(value.result) ||
    value.result.kind !== task.kind
  )
    return false;
  const result = value.result;
  if (task.kind === 'readonly-summary')
    return (
      hasExactKeys(result, ['kind', 'value']) && isSummaryResult(result.value)
    );
  if (task.kind === 'base-identity')
    return (
      hasExactKeys(result, ['kind', 'value']) &&
      isBaseIdentityResult(result.value)
    );
  if (task.kind === 'calls') {
    if (
      !hasExactKeys(result, ['kind', 'value']) ||
      !Array.isArray(result.value) ||
      result.value.length !== task.calls.length
    )
      return false;
    const callValues: unknown[] = result.value;
    return task.calls.every(
      (call, index) =>
        call.method !== 'status' || isSummaryResult(callValues[index]),
    );
  }
  if (task.kind === 'snapshot-import') {
    const value = result.value;
    return (
      hasExactKeys(result, ['kind', 'value']) &&
      isRecord(value) &&
      hasExactKeys(value, [
        'warnings',
        'filesImported',
        'symbolsImported',
        'edgesImported',
      ]) &&
      Array.isArray(value.warnings) &&
      value.warnings.every((warning) => typeof warning === 'string') &&
      nullableSafeInteger(value.filesImported) &&
      value.filesImported !== null &&
      nullableSafeInteger(value.symbolsImported) &&
      value.symbolsImported !== null &&
      nullableSafeInteger(value.edgesImported) &&
      value.edgesImported !== null
    );
  }
  if (task.kind === 'languages-validate')
    return (
      hasExactKeys(result, ['kind', 'value']) &&
      isLanguagesValidation(result.value)
    );
  // Structural payload decoders are intentionally unchanged. Only correlate the task/result kind.
  return true;
}

function isLanguagesValidation(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['config', 'languages', 'diagnostics']) ||
    !['absent', 'invalid', 'present'].includes(String(value.config)) ||
    !Array.isArray(value.languages) ||
    !Array.isArray(value.diagnostics)
  )
    return false;
  const languages: readonly unknown[] = value.languages;
  const diagnostics: readonly unknown[] = value.diagnostics;
  return (
    languages.every(isLoadedLanguage) && diagnostics.every(isLanguageDiagnostic)
  );
}

function isLoadedLanguage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'extensions', 'index', 'abiVersion']) ||
    typeof value.id !== 'string' ||
    !Number.isSafeInteger(value.index) ||
    !Number.isSafeInteger(value.abiVersion) ||
    !Array.isArray(value.extensions)
  )
    return false;
  const extensions: readonly unknown[] = value.extensions;
  return extensions.every((extension) => typeof extension === 'string');
}

function isLanguageDiagnostic(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['entryId', 'index', 'message']) &&
    (value.entryId === null || typeof value.entryId === 'string') &&
    Number.isSafeInteger(value.index) &&
    typeof value.message === 'string'
  );
}

function responseReadFailure(
  response: CodeGraphWorkerReadResponse,
): CodeGraphReadFailure | undefined {
  if (!response.ok) return response.code;
  const result = response.result;
  if (result.kind === 'calls') {
    for (const value of result.value) {
      if (isSummaryResult(value) && value.state === 'error') {
        return value.classification === 'busy' ? 'busy' : 'database-error';
      }
    }
  }
  if (
    (result.kind === 'readonly-summary' || result.kind === 'base-identity') &&
    result.value.state === 'error'
  ) {
    return result.value.classification === 'busy' ? 'busy' : 'database-error';
  }
  return undefined;
}

function outcomeForError(
  error: CodeGraphWorkerReadError,
): CodeGraphQueryOutcome {
  if (error.reason === 'timeout' || error.reason === 'queue-timeout') {
    return 'timeout';
  }
  if (error.reason === 'canceled') return 'canceled';
  return 'error';
}

/** A launched read host, as the scheduler drives it. */
export interface CodeGraphReadHostProcess {
  /** Throws once the host can no longer receive messages. */
  postMessage(message: unknown): void;
  /** False when nothing could be stopped yet: the host has not launched. */
  kill(): boolean;
  on(event: 'spawn', listener: () => void): this;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
}

export interface CodeGraphReadTelemetry {
  kind: CodeGraphQueryKind;
  outcome: CodeGraphQueryOutcome;
  queueDurationMs: number;
  executionDurationMs: number;
}

/** One settled read's telemetry, with its failure when it failed. */
export type CodeGraphReadObservation = CodeGraphReadTelemetry & {
  readFailure?: CodeGraphReadFailure;
};

export interface CodeGraphReadSchedulerHost {
  /** Launches one read host with its entry and memory budget; throws when it can't. */
  launchReadHost(): CodeGraphReadHostProcess;
  recordReadDiagnostic(
    input: CodeGraphReadTelemetry & {
      key: string;
      readFailure?: CodeGraphReadFailure;
    },
  ): void;
  /** Flushes buffered telemetry once the pool has drained at shutdown. */
  flushTelemetry(): void;
}

export interface CodeGraphWorkerReadInput {
  key: string;
  diagnosticOwner?: { projectId: string; worktreeId: string };
  kind: CodeGraphQueryKind;
  request: CodeGraphWorkerReadRequest;
  /**
   * Cancels this read alone: a queued read leaves the queue, and a running
   * one retires its host, as a key cancel does.
   */
  signal?: AbortSignal;
  /**
   * Receives this read's telemetry too, once it settles, so a worker can
   * report it to the requester that records it (CAN-5691).
   */
  observe?: (observation: CodeGraphReadObservation) => void;
}

/** One scheduler per host process; see the module comment. */
export interface CodeGraphReadScheduler {
  /** Admits one read; every terminal path settles the promise. */
  run(input: CodeGraphWorkerReadInput): Promise<CodeGraphWorkerReadResponse>;
  /**
   * Refuses new reads for `key` until the returned release runs, so nothing can
   * start a reader for a worktree while its data is being removed. Fences nest;
   * each release is idempotent.
   */
  fence(key: string): () => void;
  /**
   * Refuses new reads for every key of a project (`${workspaceId}/…`: its
   * worktrees and base variants) until the returned release runs.
   */
  fenceWorkspace(workspaceId: string): () => void;
  /**
   * Cancels every queued and running read for `key` and kills every host
   * serving it, busy or idle, then waits until each of those processes, and any
   * already shutting down for the key (idle timeout, eviction, watchdog), has
   * exited.
   */
  cancel(key: string): Promise<void>;
  /** `cancel` for every key of a project (its worktrees and base variants). */
  cancelWorkspace(workspaceId: string): Promise<void>;
  /** Refuses new reads, cancels every record and awaits every host's exit. */
  shutdown(): Promise<void>;
  resetForTests(): void;
}

export function createCodeGraphReadScheduler(
  host: CodeGraphReadSchedulerHost,
): CodeGraphReadScheduler {
  const queue: ReadRecord[] = [];
  const active = new Set<ReadRecord>();
  /** Live workers that can take a request (busy or idle); counts toward the cap. */
  const workers = new Set<ReadWorker>();
  /** Killed workers whose process has not exited yet. */
  const retiring = new Set<ReadWorker>();
  /**
   * Retiring workers that still count toward the cap. A killed process keeps its
   * slot until it exits, or until the exit wait gives up on it, so a replacement
   * never runs beside it.
   */
  const heldSlots = new Set<ReadWorker>();
  /**
   * Prevent finalization in a cancellation batch from pumping another queued
   * request before every matching record has been removed.
   */
  let queuePumpSuppressionDepth = 0;
  let isPumpingQueue = false;
  /** After an aged noninteractive turn, the next dispatch uses normal priority. */
  let preferNormalAfterAgedTurn = false;
  /** Keys whose reads are refused (a worktree being removed), with a hold count. */
  const fencedKeys = new Map<string, number>();
  /**
   * Projects whose reads are refused (the project is being deleted), with a hold
   * count. Covers every key under `${workspaceId}/`.
   */
  const fencedWorkspaces = new Map<string, number>();
  let useCounter = 0;
  let shuttingDown = false;

  function emitTelemetry(
    record: ReadRecord,
    outcome: CodeGraphQueryOutcome,
    readFailure?: CodeGraphReadFailure,
  ): void {
    const completedAt = Date.now();
    const timings = {
      queueDurationMs:
        record.startedAt === null
          ? completedAt - record.queuedAt
          : record.startedAt - record.queuedAt,
      executionDurationMs:
        record.startedAt === null ? 0 : completedAt - record.startedAt,
    };
    try {
      host.recordReadDiagnostic({
        key:
          record.diagnosticOwner === undefined
            ? record.key
            : `${record.diagnosticOwner.projectId}/${record.diagnosticOwner.worktreeId}`,
        kind: record.kind,
        outcome,
        ...timings,
        ...(readFailure === undefined ? {} : { readFailure }),
      });
    } catch {
      // Local diagnostic storage must not prevent settlement or queue cleanup.
    }
    try {
      record.observe?.({
        kind: record.kind,
        outcome,
        ...timings,
        ...(readFailure === undefined ? {} : { readFailure }),
      });
    } catch {
      // Neither may a caller's observer.
    }
  }

  function clearIdleTimer(worker: ReadWorker): void {
    if (worker.idleTimer !== null) {
      clearTimeout(worker.idleTimer);
      worker.idleTimer = null;
    }
  }

  /** Kills a retiring worker's process unless a kill has already landed. */
  function killWorkerProcess(worker: ReadWorker): void {
    if (worker.hasExited || worker.hasKillLanded) return;
    try {
      // False before launch: 'spawn' kills it again (see `spawnWorker`).
      if (!worker.child.kill()) return;
    } catch {
      // A worker that already exited needs no further cleanup.
    }
    worker.markKillLanded();
  }

  /**
   * Takes a worker out of service and kills it. Until its process exits it stays
   * in `retiring`, where worktree cleanup and app shutdown still await it.
   */
  function retireWorker(worker: ReadWorker): void {
    clearIdleTimer(worker);
    worker.current = null;
    if (!workers.delete(worker)) return;
    if (worker.hasExited) return;
    retiring.add(worker);
    heldSlots.add(worker);
    void waitForWorkerExit(worker).then(() => {
      if (heldSlots.delete(worker)) pumpQueue();
    });
    killWorkerProcess(worker);
  }

  function slotsInUse(): number {
    return workers.size + heldSlots.size;
  }

  function markIdle(worker: ReadWorker): void {
    worker.current = null;
    worker.lastUsed = ++useCounter;
    clearIdleTimer(worker);
    worker.idleTimer = setTimeout(() => {
      worker.idleTimer = null;
      retireWorker(worker);
    }, CODE_GRAPH_READ_WORKER_IDLE_TIMEOUT_MS);
    worker.idleTimer.unref?.();
  }

  function clearQueueWatchdog(record: ReadRecord): void {
    if (record.queueWatchdog === null) return;
    clearTimeout(record.queueWatchdog);
    record.queueWatchdog = null;
  }

  function clearExecutionWatchdog(record: ReadRecord): void {
    if (record.watchdog === null) return;
    clearTimeout(record.watchdog);
    record.watchdog = null;
  }

  function finalize(record: ReadRecord): void {
    record.detachAbort?.();
    record.detachAbort = null;
    clearQueueWatchdog(record);
    clearExecutionWatchdog(record);
    active.delete(record);
    const queuedIndex = queue.indexOf(record);
    if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
    pumpQueue();
  }

  function resolveRecord(
    record: ReadRecord,
    response: CodeGraphWorkerReadResponse,
  ): void {
    if (record.settled) return;
    record.settled = true;
    const worker = record.worker;
    if (worker !== null && worker.current === record) {
      if (
        retiresAfter(record, worker) ||
        shuttingDown ||
        isFenced(record.key)
      ) {
        retireWorker(worker);
      } else {
        markIdle(worker);
      }
    }
    const failure = responseReadFailure(response);
    emitTelemetry(record, failure === undefined ? 'success' : 'error', failure);
    finalize(record);
    record.resolve(response);
  }

  /** Settles a record with an error and discards the worker it was running on. */
  function rejectRecord(
    record: ReadRecord,
    error: CodeGraphWorkerReadError,
  ): void {
    if (record.settled) return;
    record.settled = true;
    if (record.worker !== null && record.worker.current === record) {
      retireWorker(record.worker);
    }
    emitTelemetry(record, outcomeForError(error), codeGraphReadFailure(error));
    finalize(record);
    record.reject(error);
  }

  function handleWorkerMessage(worker: ReadWorker, message: unknown): void {
    if (!workers.has(worker)) {
      // A retired worker's answer is ignored; one retired before it launched
      // is still alive, so make sure the kill lands.
      killWorkerProcess(worker);
      return;
    }
    const record = worker.current;
    if (record === null) {
      // Nothing was asked: a worker that speaks out of turn is not trusted.
      retireWorker(worker);
      pumpQueue();
      return;
    }
    const payload =
      isRecord(message) && 'data' in message ? message.data : message;
    if (!isWorkerResponse(payload, record.request.task)) {
      rejectRecord(
        record,
        new CodeGraphWorkerReadError(
          'malformed-response',
          'Code-graph read worker returned a malformed response.',
        ),
      );
      return;
    }
    resolveRecord(
      record,
      payload.ok
        ? payload
        : {
            ...payload,
            message: 'The retained Code Graph could not be read. Try again.',
          },
    );
  }

  function handleWorkerExit(worker: ReadWorker, code: number): void {
    worker.hasExited = true;
    retiring.delete(worker);
    const wasLive = workers.delete(worker);
    clearIdleTimer(worker);
    const record = worker.current;
    worker.current = null;
    if (record !== null && !record.settled) {
      rejectRecord(
        record,
        new CodeGraphWorkerReadError(
          'worker-exit',
          `Code-graph read worker exited (code ${code}) before responding.`,
        ),
      );
      return;
    }
    // A crashed idle worker frees a slot for a queued request.
    if (wasLive) pumpQueue();
  }

  function spawnWorker(key: string): ReadWorker | Error {
    let child: CodeGraphReadHostProcess;
    try {
      child = host.launchReadHost();
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    let markExited: () => void = () => undefined;
    let resolveKillLanded: () => void = () => undefined;
    const worker: ReadWorker = {
      key,
      child,
      current: null,
      idleTimer: null,
      lastUsed: ++useCounter,
      servedToolRead: false,
      exited: new Promise<void>((resolve) => {
        markExited = resolve;
      }),
      hasExited: false,
      killLanded: new Promise<void>((resolve) => {
        resolveKillLanded = resolve;
      }),
      hasKillLanded: false,
      markKillLanded: (): void => {
        worker.hasKillLanded = true;
        resolveKillLanded();
      },
    };
    workers.add(worker);
    child.on('spawn', () => {
      // Retired before it launched (canceled, timed out, post failed): the
      // earlier kill did nothing, and the process would otherwise serve its
      // queued request and idle with no owner until app quit.
      if (retiring.has(worker)) killWorkerProcess(worker);
    });
    child.on('message', (message: unknown) => {
      handleWorkerMessage(worker, message);
    });
    child.on('exit', (code: number) => {
      if (worker.hasExited) return;
      handleWorkerExit(worker, code);
      worker.markKillLanded();
      markExited();
    });
    return worker;
  }

  function startOnWorker(record: ReadRecord, worker: ReadWorker): void {
    clearQueueWatchdog(record);
    clearIdleTimer(worker);
    worker.current = record;
    worker.lastUsed = ++useCounter;
    if (keepsWorkerWarm(record.request.task)) worker.servedToolRead = true;
    record.worker = worker;
    record.startedAt = Date.now();
    active.add(record);

    record.watchdog = setTimeout(() => {
      record.watchdog = null;
      rejectRecord(
        record,
        new CodeGraphWorkerReadError(
          'timeout',
          `Code-graph ${record.kind} read exceeded ${timeoutFor(record)} ms.`,
        ),
      );
    }, timeoutFor(record));
    record.watchdog.unref?.();

    try {
      worker.child.postMessage(record.request);
    } catch (error) {
      rejectRecord(
        record,
        new CodeGraphWorkerReadError(
          'post-failed',
          `Failed to post code-graph read request: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  function idleWorkerFor(key: string): ReadWorker | undefined {
    let best: ReadWorker | undefined;
    for (const worker of Array.from(workers)) {
      if (worker.key !== key || worker.current !== null) continue;
      // The most recently used idle worker is the warmest.
      if (best === undefined || worker.lastUsed > best.lastUsed) best = worker;
    }
    return best;
  }

  function leastRecentlyUsedIdleWorker(): ReadWorker | undefined {
    let oldest: ReadWorker | undefined;
    for (const worker of Array.from(workers)) {
      if (worker.current !== null) continue;
      if (oldest === undefined || worker.lastUsed < oldest.lastUsed) {
        oldest = worker;
      }
    }
    return oldest;
  }

  /**
   * A warm worker for `key`, or a newly forked worker while a shared slot is
   * free. Returns null when allocation would require eviction; the queue pump
   * makes that decision only after scanning every request for a runnable key.
   */
  function acquireAvailableWorker(key: string): ReadWorker | Error | null {
    const idle = idleWorkerFor(key);
    if (idle !== undefined) return idle;
    if (slotsInUse() < CONCURRENCY_CAP) return spawnWorker(key);
    return null;
  }

  function activeCountFor(admissionClass: ReadAdmissionClass): number {
    let count = 0;
    for (const record of Array.from(active)) {
      if (record.admissionClass === admissionClass) count += 1;
    }
    return count;
  }

  function hasActiveCapacity(record: ReadRecord): boolean {
    return (
      activeCountFor(record.admissionClass) <
      ACTIVE_LIMITS[record.admissionClass]
    );
  }

  /** Eligibility here intentionally never evicts an idle worker. */
  function canStartWithoutEviction(record: ReadRecord): boolean {
    if (!hasActiveCapacity(record)) return false;
    return (
      idleWorkerFor(record.key) !== undefined || slotsInUse() < CONCURRENCY_CAP
    );
  }

  function oldestRecord(records: ReadRecord[]): ReadRecord | undefined {
    let oldest: ReadRecord | undefined;
    for (const record of records) {
      if (oldest === undefined || record.queuedAt < oldest.queuedAt) {
        oldest = record;
      }
    }
    return oldest;
  }

  function isAgedForFairness(record: ReadRecord, now: number): boolean {
    const threshold = AGING_THRESHOLDS_MS[record.admissionClass];
    return threshold !== undefined && now - record.queuedAt >= threshold;
  }

  interface QueueSelection {
    record: ReadRecord;
    isAgedTurn: boolean;
  }

  /**
   * Choose among already-eligible requests. An aged noninteractive request gets
   * one dispatch turn; the next dispatch uses the normal interactive-first
   * preference even if another noninteractive request is also aged.
   */
  function selectQueuedRecord(
    candidates: ReadRecord[],
    now: number,
  ): QueueSelection | undefined {
    const interactive = oldestRecord(
      candidates.filter((record) => record.admissionClass === 'interactive'),
    );
    const noninteractive = oldestRecord(
      candidates.filter((record) => record.admissionClass !== 'interactive'),
    );
    const normal = interactive ?? noninteractive;
    if (normal === undefined) return undefined;

    if (!preferNormalAfterAgedTurn) {
      const aged = oldestRecord(
        candidates.filter((record) => isAgedForFairness(record, now)),
      );
      if (aged !== undefined) return { record: aged, isAgedTurn: true };
    }
    return { record: normal, isAgedTurn: false };
  }

  /**
   * Starts the highest-priority eligible queued request. First scan for requests
   * that can use a warm same-key worker or a free global slot without evicting;
   * only when none can run does one selected cold request evict the LRU idle
   * worker. Busy, idle and retiring workers all continue to hold the shared cap.
   */
  function pumpQueue(): void {
    if (shuttingDown || queuePumpSuppressionDepth > 0 || isPumpingQueue) {
      return;
    }
    isPumpingQueue = true;
    try {
      while (queue.length > 0) {
        const fencedRecords = queue.filter((record) => isFenced(record.key));
        for (const record of fencedRecords) {
          rejectRecord(
            record,
            new CodeGraphWorkerReadError(
              'canceled',
              'Code-graph reads for this worktree are being removed.',
            ),
          );
        }
        if (queue.length === 0) return;
        if (fencedRecords.length > 0) continue;

        const now = Date.now();
        // A completion may pump before an overdue queue timer's callback runs.
        // A deadline is an admission bound, not a race against timer ordering.
        const expired = queue.filter(
          (record) => now - record.queuedAt >= queueTimeoutFor(record),
        );
        for (const record of expired) {
          rejectRecord(
            record,
            new CodeGraphWorkerReadError(
              'queue-timeout',
              `Code-graph ${record.kind} read waited longer than ${queueTimeoutFor(record)} ms.`,
            ),
          );
        }
        if (expired.length > 0) continue;
        const runnable = queue.filter(canStartWithoutEviction);
        if (runnable.length > 0) {
          const selection = selectQueuedRecord(runnable, now);
          if (selection === undefined) return;
          const { record } = selection;
          const worker = acquireAvailableWorker(record.key);
          if (worker === null) return;
          if (worker instanceof Error) {
            rejectRecord(
              record,
              new CodeGraphWorkerReadError(
                'spawn-failed',
                `Failed to spawn code-graph read worker: ${worker.message}`,
              ),
            );
            continue;
          }
          const queueIndex = queue.indexOf(record);
          if (queueIndex >= 0) queue.splice(queueIndex, 1);
          preferNormalAfterAgedTurn = selection.isAgedTurn;
          startOnWorker(record, worker);
          continue;
        }

        // Do not sacrifice a warm same-key worker to a blocked cold head. At
        // most one LRU eviction is initiated, and an already-held retiring slot
        // prevents another eviction until it is released.
        const leastRecentlyUsedIdle =
          heldSlots.size === 0 ? leastRecentlyUsedIdleWorker() : undefined;
        if (leastRecentlyUsedIdle !== undefined) {
          const capacityEligible = queue.filter(hasActiveCapacity);
          const selection = selectQueuedRecord(capacityEligible, now);
          if (selection !== undefined) retireWorker(leastRecentlyUsedIdle);
        }
        return;
      }
    } finally {
      isPumpingQueue = false;
    }
  }

  function workspaceKeyPrefix(workspaceId: string): string {
    return `${workspaceId}/`;
  }

  function isFenced(key: string): boolean {
    if ((fencedKeys.get(key) ?? 0) > 0) return true;
    for (const workspaceId of Array.from(fencedWorkspaces.keys())) {
      if (key.startsWith(workspaceKeyPrefix(workspaceId))) return true;
    }
    return false;
  }

  function scheduleQueueWatchdog(record: ReadRecord): void {
    record.queueWatchdog = setTimeout(() => {
      record.queueWatchdog = null;
      rejectRecord(
        record,
        new CodeGraphWorkerReadError(
          'queue-timeout',
          `Code-graph ${record.kind} read waited longer than ${queueTimeoutFor(record)} ms.`,
        ),
      );
    }, queueTimeoutFor(record));
    record.queueWatchdog.unref?.();
  }

  function runCodeGraphWorkerRead(
    input: CodeGraphWorkerReadInput,
  ): Promise<CodeGraphWorkerReadResponse> {
    if (shuttingDown) {
      return Promise.reject(
        new CodeGraphWorkerReadError(
          'canceled',
          'Code-graph reads are shutting down.',
        ),
      );
    }
    if (isFenced(input.key)) {
      return Promise.reject(
        new CodeGraphWorkerReadError(
          'canceled',
          'Code-graph reads for this worktree are being removed.',
        ),
      );
    }
    if (input.signal?.aborted === true) {
      return Promise.reject(
        new CodeGraphWorkerReadError('canceled', 'Code-graph read canceled.'),
      );
    }
    return new Promise((resolve, reject) => {
      const record: ReadRecord = {
        key: input.key,
        ...(input.diagnosticOwner === undefined
          ? {}
          : { diagnosticOwner: input.diagnosticOwner }),
        kind: input.kind,
        ...(input.observe === undefined ? {} : { observe: input.observe }),
        request: input.request,
        admissionClass: admissionClassFor(input.request.task, input.kind),
        queuedAt: Date.now(),
        startedAt: null,
        worker: null,
        queueWatchdog: null,
        watchdog: null,
        detachAbort: null,
        settled: false,
        resolve,
        reject,
      };
      const queuedForClass = queue.filter(
        (queued) => queued.admissionClass === record.admissionClass,
      ).length;
      if (queuedForClass >= QUEUE_LIMITS[record.admissionClass]) {
        rejectRecord(
          record,
          new CodeGraphWorkerReadError(
            'busy',
            'Code-graph read queue is full for this task class.',
          ),
        );
        return;
      }
      const { signal } = input;
      if (signal !== undefined) {
        const abort = (): void => {
          rejectRecord(
            record,
            new CodeGraphWorkerReadError(
              'canceled',
              'Code-graph read canceled.',
            ),
          );
        };
        signal.addEventListener('abort', abort, { once: true });
        record.detachAbort = (): void => {
          signal.removeEventListener('abort', abort);
        };
      }
      queue.push(record);
      scheduleQueueWatchdog(record);
      pumpQueue();
    });
  }

  /**
   * Resolves once the worker has exited. The exit fallback counts from the
   * moment the kill landed, not from a kill refused before launch.
   */
  function waitForWorkerExit(worker: ReadWorker): Promise<void> {
    if (worker.hasExited) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      const timers = new Set<NodeJS.Timeout>();
      const finish = (): void => {
        if (finished) return;
        finished = true;
        for (const timer of Array.from(timers)) clearTimeout(timer);
        timers.clear();
        resolve();
      };
      const clearTimer = (timer: NodeJS.Timeout | null): void => {
        if (timer === null || !timers.delete(timer)) return;
        clearTimeout(timer);
      };
      const arm = (delayMs: number): NodeJS.Timeout | null => {
        if (finished) return null;
        const timer = setTimeout(() => {
          timers.delete(timer);
          finish();
        }, delayMs);
        timer.unref?.();
        timers.add(timer);
        return timer;
      };
      const launchWait = arm(LAUNCH_WAIT_FALLBACK_MS);
      void worker.killLanded.then(() => {
        if (finished) return;
        // From here only the exit wait applies, even for a late launch.
        clearTimer(launchWait);
        arm(EXIT_WAIT_FALLBACK_MS);
      });
      void worker.exited.then(finish);
    });
  }

  function holdFence(holds: Map<string, number>, id: string): () => void {
    holds.set(id, (holds.get(id) ?? 0) + 1);
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      const remaining = (holds.get(id) ?? 1) - 1;
      if (remaining > 0) holds.set(id, remaining);
      else holds.delete(id);
    };
  }

  /**
   * Refuses new reads for `key` until the returned release runs, so nothing can
   * start a reader for a worktree while its data is being removed. Fences nest;
   * each release is idempotent.
   */
  function fenceCodeGraphReads(key: string): () => void {
    return holdFence(fencedKeys, key);
  }

  /**
   * Refuses new reads for every key of a project (`${workspaceId}/…`: its
   * worktrees and base variants) until the returned release runs. Project
   * deletion holds it while it removes the project's directory.
   */
  function fenceCodeGraphReadsForWorkspace(workspaceId: string): () => void {
    return holdFence(fencedWorkspaces, workspaceId);
  }

  /**
   * Cancels every queued and running read for `key` and kills every worker
   * serving it, busy or idle, then waits until each of those processes, and any
   * already shutting down for the key (idle timeout, eviction, watchdog), has
   * exited. Worktree cleanup relies on this before it closes and removes graph
   * data.
   */
  function cancelCodeGraphReads(key: string): Promise<void> {
    return cancelMatchingReads((candidate) => candidate === key);
  }

  /**
   * `cancelCodeGraphReads` for every key of a project (its worktrees and base
   * variants). Project deletion awaits it before removing the project directory,
   * which holds every worktree's graph.
   */
  function cancelCodeGraphReadsForWorkspace(
    workspaceId: string,
  ): Promise<void> {
    const prefix = workspaceKeyPrefix(workspaceId);
    return cancelMatchingReads((key) => key.startsWith(prefix));
  }

  async function cancelMatchingReads(
    matchesKey: (key: string) => boolean,
  ): Promise<void> {
    const matches = [...queue, ...Array.from(active)].filter((record) =>
      matchesKey(record.key),
    );
    queuePumpSuppressionDepth += 1;
    try {
      for (const record of matches) {
        rejectRecord(
          record,
          new CodeGraphWorkerReadError('canceled', 'Code-graph read canceled.'),
        );
      }
    } finally {
      queuePumpSuppressionDepth -= 1;
      if (queuePumpSuppressionDepth === 0) pumpQueue();
    }
    const keyWorkers = Array.from(workers).filter((worker) =>
      matchesKey(worker.key),
    );
    for (const worker of keyWorkers) retireWorker(worker);
    const awaited = Array.from(retiring).filter((worker) =>
      matchesKey(worker.key),
    );
    await Promise.all(awaited.map(waitForWorkerExit));
  }

  async function shutdownCodeGraphReadWorkers(): Promise<void> {
    shuttingDown = true;
    const records = [...queue, ...Array.from(active)];
    for (const record of records) {
      rejectRecord(
        record,
        new CodeGraphWorkerReadError(
          'canceled',
          'Code-graph read canceled during shutdown.',
        ),
      );
    }
    for (const worker of Array.from(workers)) retireWorker(worker);
    await Promise.all(Array.from(retiring).map(waitForWorkerExit));
    host.flushTelemetry();
  }

  function resetForTests(): void {
    shuttingDown = false;
    queuePumpSuppressionDepth = 0;
    isPumpingQueue = false;
    preferNormalAfterAgedTurn = false;
    fencedKeys.clear();
    fencedWorkspaces.clear();
    heldSlots.clear();
  }

  return {
    run: runCodeGraphWorkerRead,
    fence: fenceCodeGraphReads,
    fenceWorkspace: fenceCodeGraphReadsForWorkspace,
    cancel: cancelCodeGraphReads,
    cancelWorkspace: cancelCodeGraphReadsForWorkspace,
    shutdown: shutdownCodeGraphReadWorkers,
    resetForTests,
  };
}
