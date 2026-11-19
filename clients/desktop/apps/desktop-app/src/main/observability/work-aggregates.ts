import { performance } from 'node:perf_hooks';
import {
  snapshotWorkCounters,
  type WorkCountersSnapshot,
} from '@canopy/desktop-shared/node/work-counters';
import { W5_AGGREGATE_KEYS } from '../lib/w5-work-counters';
import type { ChatWatcherAvailability } from '@canopy/desktop-shared/lib/chat-watcher-contracts';

/**
 * CAN-7064: aggregate phase timers and counters for the GitHub PR poller's
 * sweeps and immediate checks, the watcher service's `list()` and the chat
 * watcher access reads it fans out to, and a W5 projection that separates
 * logical queries, coalesced captures and decoded bytes. Counted in every
 * build, held in memory only, and never keyed by a user, project, worktree,
 * chat or path. Recording never awaits, so it does not change what the
 * counted code does or in what order.
 *
 * The only output is one main-log line per sweep (`finishGitHubSweepLogLine`):
 * the sweep's own phases, the work recorded while it ran, and everything
 * recorded since the previous line. See `docs/desktop-app-performance.md`
 * ("Poller, watcher and W5 aggregates (CAN-7064)").
 */

/** A sweep starting this soon after the previous one ended is back-to-back. */
const SWEEP_BACK_TO_BACK_GAP_MS = 5_000;

const OUTCOME_KEY_LIMIT = 64;
const OUTCOME_OVERFLOW_KEY = 'overflow';

/** Monotonic milliseconds, unaffected by wall-clock changes. */
export function workAggregatesNow(): number {
  return performance.now();
}

interface WorkTimer {
  count: number;
  totalMs: number;
  maxMs: number;
}

/**
 * Phase-1 preparation steps for one worktree. `resolveTargets` includes its
 * `readAvailable` check; `gitReadAdmission` is the time `withWorktreeGitRead`
 * took to admit the read before its callback ran.
 */
const GITHUB_PREPARE_STEPS = [
  'resolveTargets',
  'readAvailable',
  'gitReadAdmission',
  'currentBranch',
  'hookActions',
  'hookWatcher',
  'remote',
] as const;

type GitHubPrepareStep = (typeof GITHUB_PREPARE_STEPS)[number];

type GitHubPrepareSteps = Record<GitHubPrepareStep, WorkTimer>;

/** Records one preparation step's elapsed milliseconds. */
export type GitHubPrepareStepRecorder = (
  step: GitHubPrepareStep,
  elapsedMs: number,
) => void;

/** Records one GitHub refresh ledger write's elapsed milliseconds. */
export type GitHubLedgerWriteRecorder = (elapsedMs: number) => void;

interface GitHubSweepCounts {
  prepareWorktreeMs: WorkTimer;
  steps: GitHubPrepareSteps;
  lookups: WorkTimer;
  lookupFailures: number;
  lookupsSkippedNoToken: number;
  /** Branches named across lookups. */
  lookupBranches: number;
  refreshes: WorkTimer;
  refreshFailures: number;
  /** Entries no longer tracked by phase 3, so not refreshed. */
  refreshesSkipped: number;
  ledgerWrites: WorkTimer;
}

interface GitHubImmediateTotals {
  /** `checkWorktree` runs from the immediate queue. */
  checks: WorkTimer;
  steps: GitHubPrepareSteps;
  ledgerWrites: WorkTimer;
}

const WATCHER_LIST_CALLERS = [
  'autoArchive',
  'chatSummaries',
  'portal',
  'other',
] as const;

/** Who called the watcher service's `list()`. */
export type WatcherListCaller = (typeof WATCHER_LIST_CALLERS)[number];

/** Reads the chat watcher access chain makes, by what they read. */
type WatcherAccessRead =
  /** `requireAuthorizedProjectIdentity` (index.json and workspace.json). */
  | 'identity'
  /**
   * One task's worktree row (`readProjectWorktree`), counted per request:
   * inside a worktree read memo (`list()`, the canonical watcher projection)
   * it is served from a shared list.
   */
  | 'registry.worktrees'
  /** A cowork project's work entries. */
  | 'registry.coworkEntries'
  /** A bot's work entries. */
  | 'registry.botEntries'
  /** A cowork project's discoverable task ids (legacy rows). */
  | 'registry.taskIds'
  /** A committed task chat-state snapshot. */
  | 'taskSnapshot';

interface WatcherTotals {
  list: Record<WatcherListCaller, WorkTimer>;
  chatRowAccess: WorkTimer;
  /** `allowed`, `denied.<availability>` or `threw`. */
  chatRowAccessOutcomes: Record<string, number>;
  inspectResource: number;
  identityReads: number;
  registryReads: {
    worktrees: number;
    coworkEntries: number;
    botEntries: number;
    taskIds: number;
  };
  taskSnapshotReads: number;
}

/**
 * A projection of the `w5` work counters (CAN-5532). Logical work is what
 * callers asked for; coalesced captures are the capture round trips that
 * served it; decoded bytes count every base64 decode of a captured image.
 */
interface W5WorkTotals {
  /** The work-counters generation; it changes when the E2E harness resets. */
  generation: number;
  logicalQueries: { readView: number; preparation: number };
  /** Record reads sent to the daemon record port (`read.backend.capture`). */
  logicalRecordReads: number;
  /** Capture calls: over the record port, or to an in-process host. */
  coalescedCaptures: { port: number; host: number };
  /** Decoded size of the present images those captures returned. */
  capturedBytes: { port: number; host: number };
  /** Decoded bytes: query read views, batched record reads, index probes. */
  decodedBytes: { view: number; record: number; index: number };
}

/** End minus start; after a counter reset, the counts since the reset. */
interface W5WorkDelta extends W5WorkTotals {
  generationChanged: boolean;
}

/** Watcher and W5 work recorded while one sweep ran, by any caller. */
interface GitHubSweepConcurrentWork {
  watcherListCalls: number;
  chatRowAccess: number;
  inspectResource: number;
  identityReads: number;
  registryReads: number;
  taskSnapshotReads: number;
  w5: W5WorkDelta;
}

/** Everything recorded from the previous sweep's end to this one's. */
interface SincePreviousSweep {
  /** Where the interval starts: the previous sweep's end, or module load. */
  startedAt: string;
  immediate: GitHubImmediateTotals;
  watchers: WatcherTotals;
  w5: W5WorkDelta;
}

interface GitHubSweepRecord extends GitHubSweepCounts {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  entries: number;
  /** From the previous sweep's end to this one's start; null for the first. */
  gapSincePreviousMs: number | null;
  backToBack: boolean;
  stoppedForRateLimit: boolean;
  phase1Ms: number;
  /** The credential snapshot between phases 1 and 2, when one was taken. */
  identityMs: number;
  /** Null when the sweep ended before the phase began. */
  phase2Ms: number | null;
  phase3Ms: number | null;
  duringSweep: GitHubSweepConcurrentWork;
  sincePreviousSweep: SincePreviousSweep;
}

function emptyTimer(): WorkTimer {
  return { count: 0, totalMs: 0, maxMs: 0 };
}

function addTimer(timer: WorkTimer, elapsedMs: number): void {
  const value = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  timer.count += 1;
  timer.totalMs += value;
  if (value > timer.maxMs) timer.maxMs = value;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function emptySteps(): GitHubPrepareSteps {
  return {
    resolveTargets: emptyTimer(),
    readAvailable: emptyTimer(),
    gitReadAdmission: emptyTimer(),
    currentBranch: emptyTimer(),
    hookActions: emptyTimer(),
    hookWatcher: emptyTimer(),
    remote: emptyTimer(),
  };
}

function emptySweepCounts(): GitHubSweepCounts {
  return {
    prepareWorktreeMs: emptyTimer(),
    steps: emptySteps(),
    lookups: emptyTimer(),
    lookupFailures: 0,
    lookupsSkippedNoToken: 0,
    lookupBranches: 0,
    refreshes: emptyTimer(),
    refreshFailures: 0,
    refreshesSkipped: 0,
    ledgerWrites: emptyTimer(),
  };
}

function emptyImmediateTotals(): GitHubImmediateTotals {
  return {
    checks: emptyTimer(),
    steps: emptySteps(),
    ledgerWrites: emptyTimer(),
  };
}

function emptyWatcherTotals(): WatcherTotals {
  return {
    list: {
      autoArchive: emptyTimer(),
      chatSummaries: emptyTimer(),
      portal: emptyTimer(),
      other: emptyTimer(),
    },
    chatRowAccess: emptyTimer(),
    chatRowAccessOutcomes: {},
    inspectResource: 0,
    identityReads: 0,
    registryReads: {
      worktrees: 0,
      coworkEntries: 0,
      botEntries: 0,
      taskIds: 0,
    },
    taskSnapshotReads: 0,
  };
}

function addOutcome(outcomes: Record<string, number>, key: string): void {
  const current = outcomes[key];
  if (current !== undefined) {
    outcomes[key] = current + 1;
    return;
  }
  if (Object.keys(outcomes).length >= OUTCOME_KEY_LIMIT) {
    outcomes[OUTCOME_OVERFLOW_KEY] = (outcomes[OUTCOME_OVERFLOW_KEY] ?? 0) + 1;
    return;
  }
  outcomes[key] = 1;
}

/** Running counts a sweep diffs to find the watcher work during it. */
interface WatcherCounts {
  listCalls: number;
  chatRowAccess: number;
  inspectResource: number;
  identityReads: number;
  registryReads: number;
  taskSnapshotReads: number;
}

function emptyWatcherCounts(): WatcherCounts {
  return {
    listCalls: 0,
    chatRowAccess: 0,
    inspectResource: 0,
    identityReads: 0,
    registryReads: 0,
    taskSnapshotReads: 0,
  };
}

function projectW5(snapshot: WorkCountersSnapshot): W5WorkTotals {
  const w5 = snapshot.w5;
  const read = (key: string): number => w5[key] ?? 0;
  return {
    generation: snapshot.generation,
    logicalQueries: {
      readView: read(W5_AGGREGATE_KEYS.queryReadView),
      preparation: read(W5_AGGREGATE_KEYS.queryPreparation),
    },
    logicalRecordReads: read(W5_AGGREGATE_KEYS.recordReads),
    coalescedCaptures: {
      port: read(W5_AGGREGATE_KEYS.portCaptures),
      host: read(W5_AGGREGATE_KEYS.hostCaptures),
    },
    capturedBytes: {
      port: read(W5_AGGREGATE_KEYS.portCapturedBytes),
      host: read(W5_AGGREGATE_KEYS.hostCapturedBytes),
    },
    decodedBytes: {
      view: read(W5_AGGREGATE_KEYS.viewDecodedBytes),
      record: read(W5_AGGREGATE_KEYS.recordDecodedBytes),
      index: read(W5_AGGREGATE_KEYS.indexDecodedBytes),
    },
  };
}

function snapshotW5(): W5WorkTotals {
  return projectW5(snapshotWorkCounters());
}

function diffW5(start: W5WorkTotals, end: W5WorkTotals): W5WorkDelta {
  if (start.generation !== end.generation)
    return { ...end, generationChanged: true };
  const minus = (a: number, b: number): number => Math.max(0, a - b);
  return {
    generation: end.generation,
    generationChanged: false,
    logicalQueries: {
      readView: minus(
        end.logicalQueries.readView,
        start.logicalQueries.readView,
      ),
      preparation: minus(
        end.logicalQueries.preparation,
        start.logicalQueries.preparation,
      ),
    },
    logicalRecordReads: minus(end.logicalRecordReads, start.logicalRecordReads),
    coalescedCaptures: {
      port: minus(end.coalescedCaptures.port, start.coalescedCaptures.port),
      host: minus(end.coalescedCaptures.host, start.coalescedCaptures.host),
    },
    capturedBytes: {
      port: minus(end.capturedBytes.port, start.capturedBytes.port),
      host: minus(end.capturedBytes.host, start.capturedBytes.host),
    },
    decodedBytes: {
      view: minus(end.decodedBytes.view, start.decodedBytes.view),
      record: minus(end.decodedBytes.record, start.decodedBytes.record),
      index: minus(end.decodedBytes.index, start.decodedBytes.index),
    },
  };
}

/** Since the previous sweep line; replaced when a sweep finishes. */
interface Interval {
  readonly startedAtEpochMs: number;
  readonly w5Start: W5WorkTotals;
  readonly immediate: GitHubImmediateTotals;
  readonly watchers: WatcherTotals;
}

function newInterval(w5Start: W5WorkTotals = snapshotW5()): Interval {
  return {
    startedAtEpochMs: Date.now(),
    w5Start,
    immediate: emptyImmediateTotals(),
    watchers: emptyWatcherTotals(),
  };
}

let interval = newInterval();
/** Never reset: sweeps diff it, so overlapping sweeps stay exact. */
const runningWatcherCounts = emptyWatcherCounts();
let previousSweepEndedAtMs: number | null = null;

/** Counting must never change the measured path. */
function safely(apply: () => void): void {
  try {
    apply();
  } catch {
    // Dropped: a lost count is better than a changed call.
  }
}

function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * One GitHub sweep. The poller calls its methods in phase order; `finish`
 * must run once, also when the sweep stops early.
 */
export class GitHubSweepRun {
  private readonly startedAtEpochMs = Date.now();
  private readonly startedAtMs = workAggregatesNow();
  private readonly gapSincePreviousMs: number | null;
  private phase1StartedAtMs: number | null = null;
  private phase1EndedAtMs: number | null = null;
  private phase2StartedAtMs: number | null = null;
  private phase3StartedAtMs: number | null = null;
  private identityMs = 0;
  private stoppedForRateLimit = false;
  private finished: GitHubSweepRecord | null = null;
  private readonly counts = emptySweepCounts();
  private readonly watchersAtStart: WatcherCounts = { ...runningWatcherCounts };
  private readonly w5AtStart = snapshotW5();

  public constructor(private readonly entries: number) {
    this.gapSincePreviousMs =
      previousSweepEndedAtMs === null
        ? null
        : Math.max(0, this.startedAtEpochMs - previousSweepEndedAtMs);
  }

  /** Passed down to the preparation of each entry. */
  public readonly recordStep: GitHubPrepareStepRecorder = (step, elapsedMs) => {
    safely(() => addTimer(this.counts.steps[step], elapsedMs));
  };

  public readonly recordLedgerWrite: GitHubLedgerWriteRecorder = (
    elapsedMs,
  ) => {
    safely(() => addTimer(this.counts.ledgerWrites, elapsedMs));
  };

  public recordPrepareWorktree(elapsedMs: number): void {
    safely(() => addTimer(this.counts.prepareWorktreeMs, elapsedMs));
  }

  /** Phase 1 starts after the sweep's own setup reads. */
  public beginPhase1(): void {
    this.phase1StartedAtMs ??= workAggregatesNow();
  }

  public endPhase1(): void {
    this.beginPhase1();
    this.phase1EndedAtMs ??= workAggregatesNow();
  }

  public recordIdentity(elapsedMs: number): void {
    if (Number.isFinite(elapsedMs) && elapsedMs > 0)
      this.identityMs += elapsedMs;
  }

  public beginPhase2(): void {
    this.endPhase1();
    this.phase2StartedAtMs ??= workAggregatesNow();
  }

  public recordLookupSkippedNoToken(): void {
    this.counts.lookupsSkippedNoToken += 1;
  }

  public recordLookup(
    elapsedMs: number,
    branches: number,
    outcome: 'ok' | 'failed',
  ): void {
    safely(() => {
      addTimer(this.counts.lookups, elapsedMs);
      this.counts.lookupBranches += branches;
      if (outcome === 'failed') this.counts.lookupFailures += 1;
    });
  }

  public beginPhase3(): void {
    this.beginPhase2();
    this.phase3StartedAtMs ??= workAggregatesNow();
  }

  public recordRefreshSkipped(): void {
    this.counts.refreshesSkipped += 1;
  }

  public recordRefresh(elapsedMs: number, outcome: 'ok' | 'failed'): void {
    safely(() => {
      addTimer(this.counts.refreshes, elapsedMs);
      if (outcome === 'failed') this.counts.refreshFailures += 1;
    });
  }

  public markStoppedForRateLimit(): void {
    this.stoppedForRateLimit = true;
  }

  private duringSweep(w5AtEnd: W5WorkTotals): GitHubSweepConcurrentWork {
    const start = this.watchersAtStart;
    const end = runningWatcherCounts;
    return {
      watcherListCalls: end.listCalls - start.listCalls,
      chatRowAccess: end.chatRowAccess - start.chatRowAccess,
      inspectResource: end.inspectResource - start.inspectResource,
      identityReads: end.identityReads - start.identityReads,
      registryReads: end.registryReads - start.registryReads,
      taskSnapshotReads: end.taskSnapshotReads - start.taskSnapshotReads,
      w5: diffW5(this.w5AtStart, w5AtEnd),
    };
  }

  /**
   * Ends the sweep and the interval since the previous sweep line, and
   * starts the next interval. Later calls return the first record.
   */
  public finish(): GitHubSweepRecord {
    if (this.finished) return this.finished;
    const endedAtMs = workAggregatesNow();
    const endedAtEpochMs = Date.now();
    const w5AtEnd = snapshotW5();
    const ended = interval;
    interval = newInterval(w5AtEnd);
    const phase1Ms =
      this.phase1StartedAtMs === null
        ? 0
        : (this.phase1EndedAtMs ?? endedAtMs) - this.phase1StartedAtMs;
    const phase2Ms =
      this.phase2StartedAtMs === null
        ? null
        : (this.phase3StartedAtMs ?? endedAtMs) - this.phase2StartedAtMs;
    const phase3Ms =
      this.phase3StartedAtMs === null
        ? null
        : endedAtMs - this.phase3StartedAtMs;
    const sweepRecord: GitHubSweepRecord = {
      startedAt: isoAt(this.startedAtEpochMs),
      endedAt: isoAt(endedAtEpochMs),
      durationMs: roundMs(endedAtMs - this.startedAtMs),
      entries: this.entries,
      gapSincePreviousMs: this.gapSincePreviousMs,
      backToBack:
        this.gapSincePreviousMs !== null &&
        this.gapSincePreviousMs < SWEEP_BACK_TO_BACK_GAP_MS,
      stoppedForRateLimit: this.stoppedForRateLimit,
      phase1Ms: roundMs(phase1Ms),
      identityMs: roundMs(this.identityMs),
      phase2Ms: phase2Ms === null ? null : roundMs(phase2Ms),
      phase3Ms: phase3Ms === null ? null : roundMs(phase3Ms),
      ...this.counts,
      duringSweep: this.duringSweep(w5AtEnd),
      sincePreviousSweep: {
        startedAt: isoAt(ended.startedAtEpochMs),
        immediate: ended.immediate,
        watchers: ended.watchers,
        w5: diffW5(ended.w5Start, w5AtEnd),
      },
    };
    this.finished = sweepRecord;
    previousSweepEndedAtMs = endedAtEpochMs;
    return sweepRecord;
  }
}

/** Starts one sweep over `entries` tracked worktrees. */
export function beginGitHubSweep(entries: number): GitHubSweepRun {
  return new GitHubSweepRun(entries);
}

/** One `checkWorktree` run from the immediate queue. */
class GitHubImmediateCheck {
  private readonly startedAtMs = workAggregatesNow();
  private done = false;

  public readonly recordStep: GitHubPrepareStepRecorder = (step, elapsedMs) => {
    safely(() => addTimer(interval.immediate.steps[step], elapsedMs));
  };

  public readonly recordLedgerWrite: GitHubLedgerWriteRecorder = (
    elapsedMs,
  ) => {
    safely(() => addTimer(interval.immediate.ledgerWrites, elapsedMs));
  };

  public finish(): void {
    if (this.done) return;
    this.done = true;
    const elapsedMs = workAggregatesNow() - this.startedAtMs;
    safely(() => addTimer(interval.immediate.checks, elapsedMs));
  }
}

export function beginGitHubImmediateCheck(): GitHubImmediateCheck {
  return new GitHubImmediateCheck();
}

/** `{ n, ms, max }`, rounded to a microsecond. */
function timerSummary(timer: WorkTimer): {
  n: number;
  ms: number;
  max: number;
} {
  return {
    n: timer.count,
    ms: roundMs(timer.totalMs),
    max: roundMs(timer.maxMs),
  };
}

function stepsSummary(
  steps: GitHubPrepareSteps,
): Record<string, ReturnType<typeof timerSummary>> {
  const summary: Record<string, ReturnType<typeof timerSummary>> = {};
  for (const step of GITHUB_PREPARE_STEPS)
    if (steps[step].count > 0) summary[step] = timerSummary(steps[step]);
  return summary;
}

function isEmptyLogValue(value: unknown): boolean {
  return (
    value === 0 ||
    value === false ||
    value === null ||
    value === undefined ||
    (typeof value === 'object' && Object.keys(value).length === 0)
  );
}

/**
 * `value` without zero counts, false flags, nulls and the objects left
 * empty by dropping them. Keeps the line short: about one sweep a minute
 * shares main.log's 10 MB rotation with every other log line.
 */
function withoutEmpty(value: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const compacted =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? withoutEmpty(Object.fromEntries(Object.entries(entry)))
        : entry;
    if (!isEmptyLogValue(compacted)) kept[key] = compacted;
  }
  return kept;
}

/**
 * The per-sweep log payload: counts, milliseconds and bytes only. The
 * sweep's head fields, phases included (null when a phase never began), are
 * always present; everything else is left out when zero, false, null or
 * empty.
 */
function summarizeGitHubSweep(sweep: GitHubSweepRecord): unknown {
  const during = sweep.duringSweep;
  const since = sweep.sincePreviousSweep;
  const list: Record<string, ReturnType<typeof timerSummary>> = {};
  for (const caller of WATCHER_LIST_CALLERS)
    if (since.watchers.list[caller].count > 0)
      list[caller] = timerSummary(since.watchers.list[caller]);
  return {
    startedAt: sweep.startedAt,
    endedAt: sweep.endedAt,
    durationMs: sweep.durationMs,
    entries: sweep.entries,
    gapSincePreviousMs: sweep.gapSincePreviousMs,
    backToBack: sweep.backToBack,
    phase1Ms: sweep.phase1Ms,
    phase2Ms: sweep.phase2Ms,
    phase3Ms: sweep.phase3Ms,
    ...withoutEmpty(summarizeGitHubSweepWork(sweep, during, since, list)),
  };
}

function summarizeGitHubSweepWork(
  sweep: GitHubSweepRecord,
  during: GitHubSweepConcurrentWork,
  since: SincePreviousSweep,
  list: Record<string, ReturnType<typeof timerSummary>>,
): Record<string, unknown> {
  return {
    stoppedForRateLimit: sweep.stoppedForRateLimit,
    prepareWorktree: timerSummary(sweep.prepareWorktreeMs),
    steps: stepsSummary(sweep.steps),
    identityMs: sweep.identityMs,
    lookups: timerSummary(sweep.lookups),
    lookupFailures: sweep.lookupFailures,
    lookupsSkippedNoToken: sweep.lookupsSkippedNoToken,
    lookupBranches: sweep.lookupBranches,
    refreshes: timerSummary(sweep.refreshes),
    refreshFailures: sweep.refreshFailures,
    refreshesSkipped: sweep.refreshesSkipped,
    ledgerWrites: timerSummary(sweep.ledgerWrites),
    duringSweep: {
      watcherListCalls: during.watcherListCalls,
      chatRowAccess: during.chatRowAccess,
      inspectResource: during.inspectResource,
      identityReads: during.identityReads,
      registryReads: during.registryReads,
      taskSnapshotReads: during.taskSnapshotReads,
      w5LogicalQueries:
        during.w5.logicalQueries.readView +
        during.w5.logicalQueries.preparation,
      w5LogicalRecordReads: during.w5.logicalRecordReads,
      w5Captures:
        during.w5.coalescedCaptures.port + during.w5.coalescedCaptures.host,
      w5DecodedBytes:
        during.w5.decodedBytes.view +
        during.w5.decodedBytes.record +
        during.w5.decodedBytes.index,
    },
    sincePreviousSweep: {
      startedAt: since.startedAt,
      immediate: {
        checks: timerSummary(since.immediate.checks),
        steps: stepsSummary(since.immediate.steps),
        ledgerWrites: timerSummary(since.immediate.ledgerWrites),
      },
      watcherList: list,
      chatRowAccess: timerSummary(since.watchers.chatRowAccess),
      chatRowAccessOutcomes: since.watchers.chatRowAccessOutcomes,
      inspectResource: since.watchers.inspectResource,
      identityReads: since.watchers.identityReads,
      registryReads: since.watchers.registryReads,
      taskSnapshotReads: since.watchers.taskSnapshotReads,
      w5: {
        generationChanged: since.w5.generationChanged,
        logicalQueries: since.w5.logicalQueries,
        logicalRecordReads: since.w5.logicalRecordReads,
        coalescedCaptures: since.w5.coalescedCaptures,
        capturedBytes: since.w5.capturedBytes,
        decodedBytes: since.w5.decodedBytes,
      },
    },
  };
}

const GITHUB_SWEEP_LOG_MESSAGE = 'GitHub PR sweep finished';

/**
 * Finishes `run` and returns its main-log line, or null if that failed. The
 * summary is inlined as JSON: a context object would make electron-log's
 * file transport spread it over one line per key.
 */
export function finishGitHubSweepLogLine(run: GitHubSweepRun): string | null {
  try {
    return `${GITHUB_SWEEP_LOG_MESSAGE} ${JSON.stringify(
      summarizeGitHubSweep(run.finish()),
    )}`;
  } catch {
    return null;
  }
}

/** One watcher service `list()` call and its elapsed milliseconds. */
export function recordWatcherList(
  caller: WatcherListCaller,
  elapsedMs: number,
): void {
  safely(() => {
    addTimer(interval.watchers.list[caller], elapsedMs);
    runningWatcherCounts.listCalls += 1;
  });
}

/** One chat watcher row access decision. */
export function recordChatRowAccess(
  elapsedMs: number,
  outcome:
    | { allowed: true }
    | { allowed: false; reason: ChatWatcherAvailability }
    | 'threw',
): void {
  safely(() => {
    const key =
      outcome === 'threw'
        ? 'threw'
        : outcome.allowed
          ? 'allowed'
          : `denied.${outcome.reason}`;
    addTimer(interval.watchers.chatRowAccess, elapsedMs);
    addOutcome(interval.watchers.chatRowAccessOutcomes, key);
    runningWatcherCounts.chatRowAccess += 1;
  });
}

/** One `inspectResource` call of the chat watcher access chain. */
export function recordWatcherInspectResource(): void {
  interval.watchers.inspectResource += 1;
  runningWatcherCounts.inspectResource += 1;
}

/** One read the chat watcher access chain started. */
export function recordWatcherAccessRead(read: WatcherAccessRead): void {
  const watchers = interval.watchers;
  switch (read) {
    case 'identity':
      watchers.identityReads += 1;
      runningWatcherCounts.identityReads += 1;
      return;
    case 'taskSnapshot':
      watchers.taskSnapshotReads += 1;
      runningWatcherCounts.taskSnapshotReads += 1;
      return;
    case 'registry.worktrees':
      watchers.registryReads.worktrees += 1;
      break;
    case 'registry.coworkEntries':
      watchers.registryReads.coworkEntries += 1;
      break;
    case 'registry.botEntries':
      watchers.registryReads.botEntries += 1;
      break;
    case 'registry.taskIds':
      watchers.registryReads.taskIds += 1;
      break;
  }
  runningWatcherCounts.registryReads += 1;
}
