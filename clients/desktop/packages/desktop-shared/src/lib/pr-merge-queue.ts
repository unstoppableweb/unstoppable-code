import { REMOTE_CONTROL_PR_MERGE_QUEUE_PHASES } from '@canopy/protocol/remote-control/shell';
import {
  isPrMergeQueuePhase,
  toPrMergeQueuePhase,
  type PrMergeQueueCursor,
  type PrMergeQueueEnteredRecord,
  type PrMergeQueueHistory,
  type PrMergeQueueKnownPhase,
  type PrMergeQueueMembership,
  type PrMergeQueuePendingExit,
  type PrMergeQueuePhase,
  type PrMergeQueueRemovedRecord,
  type PrMergeQueueSnapshot,
  type PrMergeQueueTimelineEvent,
} from '../types/github';
import type { GitHubPullRequestWatcherEvent } from '../types/github-watchers';

/**
 * Pure merge queue interpretation shared by PR status, PR watchers, and hooks.
 * Browser-safe: no I/O, no Node or Electron dependencies.
 */

const MAX_ENTRY_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;
/** Open samples a `merged`-reason removal is held before it is reported. */
const MERGED_REASON_HOLD_SAMPLES = 2;
/**
 * Minimum age of a held `merged` removal before release. GitHub merges about
 * a second after it, so bunched samples alone must never release the hold.
 */
const MERGED_REASON_HOLD_MIN_AGE_MS = 5 * 60_000;

function heldLongEnough(
  hold: PrMergeQueuePendingExit,
  observedAt: string,
): boolean {
  const since = Date.parse(hold.removedAt ?? hold.observedAt);
  const now = Date.parse(observedAt);
  return (
    Number.isFinite(since) &&
    Number.isFinite(now) &&
    now - since >= MERGED_REASON_HOLD_MIN_AGE_MS
  );
}

function isKnownPhase(
  phase: PrMergeQueuePhase,
): phase is PrMergeQueueKnownPhase {
  return phase !== 'unknown';
}

/** Phases a watcher can select, in GitHub's lifecycle order. */
export const PR_MERGE_QUEUE_KNOWN_PHASES: readonly PrMergeQueueKnownPhase[] =
  REMOTE_CONTROL_PR_MERGE_QUEUE_PHASES.filter(isKnownPhase);

export function isPrMergeQueueKnownPhase(
  value: unknown,
): value is PrMergeQueueKnownPhase {
  return PR_MERGE_QUEUE_KNOWN_PHASES.some((phase) => phase === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedEntryId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, MAX_ENTRY_ID_LENGTH)
    : null;
}

function isoTimestampOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_TIMESTAMP_LENGTH) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function positionOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** A week; GitHub's estimates are minutes, so anything larger is bad data. */
const MAX_ESTIMATED_SECONDS_TO_MERGE = 7 * 24 * 60 * 60;

/**
 * GitHub's `MergeQueueEntry.estimatedTimeToMerge` in whole seconds, or null.
 * It is display data: membership and transitions never read it, so an
 * estimate that changes between samples reports nothing.
 */
export function readMergeQueueEstimatedSeconds(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_ESTIMATED_SECONDS_TO_MERGE
    ? value
    : null;
}

/**
 * Read merge queue membership from GitHub's `isInMergeQueue` and
 * `mergeQueueEntry`. Any entry counts as queued (GitHub removes unmergeable
 * entries); membership without an entry is queued with an `unknown` phase.
 */
export function readPrMergeQueueMembership(raw: {
  isInMergeQueue?: unknown;
  mergeQueueEntry?: unknown;
}): PrMergeQueueMembership {
  const entry = isRecord(raw.mergeQueueEntry) ? raw.mergeQueueEntry : null;
  if (raw.isInMergeQueue !== true && entry === null) {
    return { inQueue: false, entryId: null, enqueuedAt: null, position: null };
  }
  return {
    inQueue: true,
    entryId: boundedEntryId(entry?.id),
    phase: toPrMergeQueuePhase(entry?.state),
    enqueuedAt: isoTimestampOrNull(entry?.enqueuedAt),
    position: positionOrNull(entry?.position),
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * A queue transition without PR identity. `kind` is the watcher event kind,
 * so a caller adds identity fields to produce the delivered event.
 */
export type PrMergeQueueTransition = DistributiveOmit<
  Extract<
    GitHubPullRequestWatcherEvent,
    { kind: `pull_request_queue_${string}` }
  >,
  'repository' | 'number' | 'url' | 'baseBranch' | 'headSha'
>;

export interface PrMergeQueueTransitionFilter {
  entered: boolean;
  phases: readonly PrMergeQueueKnownPhase[];
}

export interface PrMergeQueueInterpretationInput {
  previous: PrMergeQueueMembership;
  next: PrMergeQueueMembership;
  state: 'open' | 'merged' | 'closed';
  history?: PrMergeQueueHistory;
  /** Absent for a watcher that has not baselined its timeline yet. */
  cursor?: PrMergeQueueCursor;
  pendingExit?: PrMergeQueuePendingExit;
  filter: PrMergeQueueTransitionFilter;
  /** A history gap was already reported and not yet recovered. */
  gapReported: boolean;
  observedAt: string;
  previousObservedAt: string;
}

export interface PrMergeQueueInterpretation {
  transitions: PrMergeQueueTransition[];
  cursor?: PrMergeQueueCursor;
  pendingExit?: PrMergeQueuePendingExit;
  /** The timeline since the cursor could not be verified this sample. */
  gap: boolean;
  gapReported: boolean;
}

type HistoryWindow =
  | {
      kind: 'baseline' | 'valid' | 'gap';
      /** Events after the cursor; empty unless `valid`. */
      events: PrMergeQueueTimelineEvent[];
      cursor: PrMergeQueueCursor;
    }
  | { kind: 'unavailable' };

function isWellFormedHistory(
  history: Extract<PrMergeQueueHistory, { status: 'complete' }>,
): boolean {
  const { firstIndex, filteredCount, events } = history;
  return (
    Number.isSafeInteger(firstIndex) &&
    Number.isSafeInteger(filteredCount) &&
    firstIndex >= 0 &&
    filteredCount >= firstIndex &&
    events.length === filteredCount - firstIndex
  );
}

function cursorFromRead(
  history: Extract<PrMergeQueueHistory, { status: 'complete' }>,
): PrMergeQueueCursor {
  const last = history.events[history.events.length - 1];
  return { count: history.filteredCount, lastEventId: last ? last.id : null };
}

function continuesFrom(
  history: Extract<PrMergeQueueHistory, { status: 'complete' }>,
  cursor: PrMergeQueueCursor,
): boolean {
  const { count } = cursor;
  if (
    !Number.isSafeInteger(count) ||
    count < history.firstIndex ||
    count > history.filteredCount
  ) {
    return false;
  }
  if (count === 0) return true;
  // Undefined when the cursor's last event precedes the window.
  const lastInterpreted = history.events[count - 1 - history.firstIndex];
  return (
    lastInterpreted !== undefined && lastInterpreted.id === cursor.lastEventId
  );
}

function readHistoryWindow(
  history: PrMergeQueueHistory | undefined,
  cursor: PrMergeQueueCursor | undefined,
): HistoryWindow {
  if (history?.status !== 'complete' || !isWellFormedHistory(history)) {
    return { kind: 'unavailable' };
  }
  const readCursor = cursorFromRead(history);
  if (!cursor) return { kind: 'baseline', events: [], cursor: readCursor };
  if (!continuesFrom(history, cursor)) {
    return { kind: 'gap', events: [], cursor: readCursor };
  }
  return {
    kind: 'valid',
    events: history.events.slice(cursor.count - history.firstIndex),
    cursor: readCursor,
  };
}

function isMergedReason(reason: string | null | undefined): boolean {
  return reason?.trim().toLowerCase() === 'merged';
}

function hasDifferentEntryIds(
  left: string | null,
  right: string | null,
): boolean {
  return left !== null && right !== null && left !== right;
}

/** Same verified entry in both samples, so no history is needed. */
function isContinuityProven(
  previous: PrMergeQueueMembership,
  next: PrMergeQueueMembership,
): boolean {
  return (
    previous.inQueue &&
    next.inQueue &&
    previous.entryId !== null &&
    previous.entryId === next.entryId
  );
}

interface HistorySummary {
  removals: PrMergeQueueTimelineEvent[];
  latestRemoval: PrMergeQueueTimelineEvent | undefined;
  /** An `added` event follows the latest removal (or any, without removals). */
  addedAfterLatestRemoval: boolean;
}

function summarizeHistory(events: PrMergeQueueTimelineEvent[]): HistorySummary {
  const removals: PrMergeQueueTimelineEvent[] = [];
  let addedAfterLatestRemoval = false;
  for (const event of events) {
    if (event.type === 'removed') {
      removals.push(event);
      addedAfterLatestRemoval = false;
    } else {
      addedAfterLatestRemoval = true;
    }
  }
  return {
    removals,
    latestRemoval: removals[removals.length - 1],
    addedAfterLatestRemoval,
  };
}

interface QueueOutcome {
  transitions: PrMergeQueueTransition[];
  pendingExit?: PrMergeQueuePendingExit;
}

function removedTransition(fields: {
  evidence: 'timeline' | 'entry_changed' | 'membership';
  removedAt: string | null;
  reason: string | null;
  requeued: boolean;
  removals?: number;
}): PrMergeQueueTransition {
  return {
    kind: 'pull_request_queue_removed',
    removedAt: fields.removedAt,
    reason: fields.reason,
    evidence: fields.evidence,
    requeued: fields.requeued,
    ...(fields.removals !== undefined && fields.removals > 1
      ? { removals: fields.removals }
      : {}),
  };
}

function enteredTransitions(
  next: PrMergeQueueMembership,
  filter: PrMergeQueueTransitionFilter,
  reentry: boolean,
): PrMergeQueueTransition[] {
  if (!filter.entered || !next.inQueue) return [];
  return [
    {
      kind: 'pull_request_queue_entered',
      enqueuedAt: next.enqueuedAt,
      phase: next.phase ?? 'unknown',
      position: next.position,
      reentry,
    },
  ];
}

/**
 * Report removals since the last sample as one coalesced timeline removal.
 * `heldRemoval` is an earlier `merged`-reason removal disproved by new
 * activity; it counts toward `removals` and supplies the reason when the
 * window has no newer removal.
 */
function timelineRemoval(
  input: PrMergeQueueInterpretationInput,
  summary: HistorySummary,
  heldRemoval: PrMergeQueuePendingExit | undefined,
): QueueOutcome {
  const { next, filter } = input;
  const latest = summary.latestRemoval;
  const removed = removedTransition({
    evidence: 'timeline',
    removedAt: latest ? latest.createdAt : (heldRemoval?.removedAt ?? null),
    reason: latest ? (latest.reason ?? null) : (heldRemoval?.reason ?? null),
    requeued: next.inQueue,
    removals:
      summary.removals.length +
      (heldRemoval ? heldRemovalCount(heldRemoval) : 0),
  });
  return {
    transitions: [removed, ...enteredTransitions(next, filter, true)],
  };
}

/** Removals a held exit stands for; holds written before the count are 1. */
function heldRemovalCount(hold: PrMergeQueuePendingExit): number {
  const { removals } = hold;
  return removals !== undefined &&
    Number.isSafeInteger(removals) &&
    removals > 1
    ? removals
    : 1;
}

/** `removals` counts every removal the hold stands for, so release keeps it. */
function holdMergedRemoval(
  input: PrMergeQueueInterpretationInput,
  removal: PrMergeQueueTimelineEvent,
  entryId: string | null,
  removals: number,
): QueueOutcome {
  return {
    transitions: [],
    pendingExit: {
      heldFor: 'merged_reason',
      entryId,
      observedAt: input.observedAt,
      samples: 0,
      removedAt: removal.createdAt,
      reason: 'merged',
      ...(removals > 1 ? { removals } : {}),
    },
  };
}

/**
 * GitHub records a `merged` removal about a second before the merge, and the
 * merge sample then wins. Only a `merged` removal not followed by re-entry is
 * held; a later `added` proves the pull request did not merge.
 */
function shouldHoldMergedRemoval(summary: HistorySummary): boolean {
  return (
    summary.latestRemoval !== undefined &&
    isMergedReason(summary.latestRemoval.reason) &&
    !summary.addedAfterLatestRemoval
  );
}

function interpretMergedReasonHold(
  input: PrMergeQueueInterpretationInput,
  summary: HistorySummary,
  hold: PrMergeQueuePendingExit,
): QueueOutcome {
  const { next } = input;
  // Membership can lag the removal, so only a new entry disproves the merge.
  const quiet =
    summary.removals.length === 0 &&
    !summary.addedAfterLatestRemoval &&
    !(next.inQueue && hasDifferentEntryIds(hold.entryId, next.entryId));
  if (quiet) {
    const samples = hold.samples + 1;
    if (
      samples < MERGED_REASON_HOLD_SAMPLES ||
      !heldLongEnough(hold, input.observedAt)
    ) {
      return { transitions: [], pendingExit: { ...hold, samples } };
    }
    return {
      transitions: [
        removedTransition({
          evidence: 'timeline',
          removedAt: hold.removedAt,
          reason: 'merged',
          requeued: next.inQueue,
          removals: heldRemovalCount(hold),
        }),
      ],
    };
  }
  if (shouldHoldMergedRemoval(summary) && summary.latestRemoval) {
    return holdMergedRemoval(
      input,
      summary.latestRemoval,
      hold.entryId,
      summary.removals.length + heldRemovalCount(hold),
    );
  }
  return timelineRemoval(input, summary, hold);
}

function interpretConfirmHold(
  input: PrMergeQueueInterpretationInput,
  hold: PrMergeQueuePendingExit,
): QueueOutcome {
  const { next, filter } = input;
  if (!next.inQueue) {
    return {
      transitions: [
        removedTransition({
          evidence: 'membership',
          removedAt: null,
          reason: null,
          requeued: false,
        }),
      ],
    };
  }
  if (hasDifferentEntryIds(hold.entryId, next.entryId)) {
    return {
      transitions: [
        removedTransition({
          evidence: 'entry_changed',
          removedAt: null,
          reason: null,
          requeued: true,
        }),
        ...enteredTransitions(next, filter, true),
      ],
    };
  }
  // Back in the queue with the same (or an unverifiable) entry: a blip.
  return { transitions: [] };
}

function interpretQueue(
  input: PrMergeQueueInterpretationInput,
  events: PrMergeQueueTimelineEvent[],
): QueueOutcome {
  const { previous, next, filter, pendingExit } = input;
  const summary = summarizeHistory(events);

  if (pendingExit?.heldFor === 'merged_reason') {
    return interpretMergedReasonHold(input, summary, pendingExit);
  }
  // A timeline removal supersedes a confirm hold but keeps its exited entry.
  const exitEntryId = pendingExit ? pendingExit.entryId : previous.entryId;

  if (shouldHoldMergedRemoval(summary) && summary.latestRemoval) {
    return holdMergedRemoval(
      input,
      summary.latestRemoval,
      exitEntryId,
      summary.removals.length,
    );
  }
  if (summary.removals.length > 0) {
    return timelineRemoval(input, summary, undefined);
  }
  if (pendingExit?.heldFor === 'confirm') {
    return interpretConfirmHold(input, pendingExit);
  }
  if (
    previous.inQueue &&
    next.inQueue &&
    hasDifferentEntryIds(previous.entryId, next.entryId)
  ) {
    return {
      transitions: [
        removedTransition({
          evidence: 'entry_changed',
          removedAt: null,
          reason: null,
          requeued: true,
        }),
        ...enteredTransitions(next, filter, true),
      ],
    };
  }
  if (previous.inQueue && !next.inQueue) {
    return {
      transitions: [],
      pendingExit: {
        heldFor: 'confirm',
        entryId: previous.entryId,
        observedAt: input.observedAt,
        samples: 0,
        removedAt: null,
        reason: null,
      },
    };
  }
  if (next.inQueue && (!previous.inQueue || summary.addedAfterLatestRemoval)) {
    return { transitions: enteredTransitions(next, filter, false) };
  }
  // No removal reached this point, so equal ids (both null included) are the
  // same entry.
  const sameEntry = previous.entryId === next.entryId;
  const phase = next.phase ?? 'unknown';
  const previousPhase = previous.phase ?? 'unknown';
  if (
    previous.inQueue &&
    next.inQueue &&
    sameEntry &&
    phase !== previousPhase &&
    filter.phases.some((selected) => selected === phase)
  ) {
    return {
      transitions: [
        {
          kind: 'pull_request_queue_phase_changed',
          previousPhase,
          phase,
          position: next.position,
        },
      ],
    };
  }
  // Position-only and unselected phase changes never wake the watcher.
  return { transitions: [] };
}

/**
 * Interpret one pull request sample against the previous one and the merge
 * queue timeline since the stored cursor. Merge and close take precedence
 * over queue transitions; history alone never produces a removal.
 */
export function interpretPrMergeQueueTransition(
  input: PrMergeQueueInterpretationInput,
): PrMergeQueueInterpretation {
  const historyWindow = readHistoryWindow(input.history, input.cursor);
  const cursor =
    historyWindow.kind === 'unavailable' ? input.cursor : historyWindow.cursor;
  // An unreadable timeline keeps the cursor, so only a later complete read
  // that cannot reach it proves a lost window.
  const gap = historyWindow.kind === 'gap';
  const recovered =
    historyWindow.kind === 'valid' || historyWindow.kind === 'baseline';
  const carriedGapReported = recovered ? false : input.gapReported;
  const base = {
    ...(cursor ? { cursor } : {}),
    gap,
  };

  if (input.state !== 'open') {
    return { ...base, transitions: [], gapReported: carriedGapReported };
  }

  const reportGap =
    gap &&
    !input.gapReported &&
    !isContinuityProven(input.previous, input.next);
  const gapTransitions: PrMergeQueueTransition[] = reportGap
    ? [
        {
          kind: 'pull_request_queue_history_incomplete',
          since: input.previousObservedAt,
          observedAt: input.observedAt,
        },
      ]
    : [];
  const queue = interpretQueue(
    input,
    historyWindow.kind === 'valid' ? historyWindow.events : [],
  );
  return {
    ...base,
    transitions: [...gapTransitions, ...queue.transitions],
    ...(queue.pendingExit ? { pendingExit: queue.pendingExit } : {}),
    gapReported: reportGap || carriedGapReported,
  };
}

// ---------------------------------------------------------------------------
// Hooks: `pr:queue:entered` and `pr:queue:removed`
// ---------------------------------------------------------------------------

/** Dispatch order: a requeue reports its removal first. */
export type PrMergeQueueHookTriggerName =
  | 'pr:queue:removed'
  | 'pr:queue:entered';

export type PrQueueHookVariableName =
  | 'PR_QUEUE_ENTRY_ID'
  | 'PR_QUEUE_REMOVAL_REASON';

const QUEUE_REMOVAL_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const OUT_OF_QUEUE: PrMergeQueueMembership = {
  inQueue: false,
  entryId: null,
  enqueuedAt: null,
  position: null,
};

/** Hooks report entries and removals only; phases are never selected. */
const HOOK_QUEUE_FILTER: PrMergeQueueTransitionFilter = {
  entered: true,
  phases: [],
};

function isSafeIntegerAtLeast(value: unknown, min: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullablePosition(value: unknown): value is number | null {
  return value === null || isSafeIntegerAtLeast(value, 0);
}

export function isPrMergeQueueCursor(
  value: unknown,
): value is PrMergeQueueCursor {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isSafeIntegerAtLeast(value.count, 0) &&
    isNullableString(value.lastEventId)
  );
}

export function isPrMergeQueuePendingExit(
  value: unknown,
): value is PrMergeQueuePendingExit {
  return (
    isRecord(value) &&
    (value.heldFor === 'merged_reason' || value.heldFor === 'confirm') &&
    isNullableString(value.entryId) &&
    typeof value.observedAt === 'string' &&
    isSafeIntegerAtLeast(value.samples, 0) &&
    isNullableString(value.removedAt) &&
    isNullableString(value.reason) &&
    (value.removals === undefined || isSafeIntegerAtLeast(value.removals, 2))
  );
}

function isMembership(value: unknown): value is PrMergeQueueMembership {
  return (
    isRecord(value) &&
    typeof value.inQueue === 'boolean' &&
    isNullableString(value.entryId) &&
    (value.phase === undefined || isPrMergeQueuePhase(value.phase)) &&
    isNullableString(value.enqueuedAt) &&
    isNullablePosition(value.position)
  );
}

function isEnteredRecord(value: unknown): value is PrMergeQueueEnteredRecord {
  return (
    isRecord(value) &&
    isNullableString(value.entryId) &&
    isNullableString(value.enqueuedAt) &&
    isPrMergeQueuePhase(value.phase) &&
    isNullablePosition(value.position) &&
    typeof value.reentry === 'boolean' &&
    typeof value.observedAt === 'string'
  );
}

function isRemovedRecord(value: unknown): value is PrMergeQueueRemovedRecord {
  return (
    isRecord(value) &&
    isNullableString(value.entryId) &&
    isNullableString(value.removedAt) &&
    isNullableString(value.reason) &&
    (value.evidence === 'timeline' ||
      value.evidence === 'entry_changed' ||
      value.evidence === 'membership') &&
    typeof value.requeued === 'boolean' &&
    (value.removals === undefined || isSafeIntegerAtLeast(value.removals, 2)) &&
    typeof value.observedAt === 'string'
  );
}

/**
 * Read stored queue evidence from a tracking snapshot. Invalid required
 * fields make it unknown; invalid optional fields are dropped, so a missing
 * cursor only re-baselines the timeline. `history` is never persisted.
 */
export function readPrMergeQueueSnapshot(
  value: unknown,
): PrMergeQueueSnapshot | undefined {
  if (
    !isRecord(value) ||
    typeof value.required !== 'boolean' ||
    !isMembership(value.membership)
  ) {
    return undefined;
  }
  const { cursor, pendingExit, lastEntered, lastRemoved } = value;
  return {
    required: value.required,
    membership: value.membership,
    ...(isPrMergeQueueCursor(cursor) ? { cursor } : {}),
    ...(isPrMergeQueuePendingExit(pendingExit) ? { pendingExit } : {}),
    ...(isEnteredRecord(lastEntered) ? { lastEntered } : {}),
    ...(isRemovedRecord(lastRemoved) ? { lastRemoved } : {}),
  };
}

export interface PrMergeQueueHookSampleInput {
  /** Stored state; absent for a first sample, a new PR, or older snapshots. */
  previous?: PrMergeQueueSnapshot;
  /** This sample's read; absent when queue state is unknown. */
  next?: PrMergeQueueSnapshot;
  /** Draft PRs are `open`. */
  prState: 'open' | 'merged' | 'closed';
  observedAt: string;
  previousObservedAt: string;
}

export interface PrMergeQueueHookSample {
  triggers: PrMergeQueueHookTriggerName[];
  /** State to store; never carries `history`. */
  mergeQueue: PrMergeQueueSnapshot | undefined;
}

function storedState(
  fields: Omit<PrMergeQueueSnapshot, 'history'>,
): PrMergeQueueSnapshot {
  return {
    required: fields.required,
    membership: fields.membership,
    ...(fields.cursor ? { cursor: fields.cursor } : {}),
    ...(fields.pendingExit ? { pendingExit: fields.pendingExit } : {}),
    ...(fields.lastEntered ? { lastEntered: fields.lastEntered } : {}),
    ...(fields.lastRemoved ? { lastRemoved: fields.lastRemoved } : {}),
  };
}

/**
 * Interpret one PR tracking sample for queue hooks with the shared
 * interpreter. Without stored state the sample is a silent baseline; unknown
 * queue state never fires; a merged or closed PR reports nothing and drops
 * any held exit and its cursor, so a queued merge reports only `pr:merged`
 * and a reopened PR never replays the removal recorded at close.
 */
export function interpretPrMergeQueueHookSample(
  input: PrMergeQueueHookSampleInput,
): PrMergeQueueHookSample {
  const { previous, next } = input;
  if (!next) {
    if (!previous || input.prState === 'open') {
      return { triggers: [], mergeQueue: previous };
    }
    // Without a cursor, a reopened PR re-baselines the timeline instead of
    // replaying removals recorded with the merge or close.
    return {
      triggers: [],
      mergeQueue: storedState({
        ...previous,
        membership: OUT_OF_QUEUE,
        cursor: undefined,
        pendingExit: undefined,
      }),
    };
  }

  const interpretation = interpretPrMergeQueueTransition({
    previous: previous ? previous.membership : next.membership,
    next: next.membership,
    state: input.prState,
    ...(next.history ? { history: next.history } : {}),
    ...(previous?.cursor ? { cursor: previous.cursor } : {}),
    ...(previous?.pendingExit ? { pendingExit: previous.pendingExit } : {}),
    filter: HOOK_QUEUE_FILTER,
    gapReported: false,
    observedAt: input.observedAt,
    previousObservedAt: input.previousObservedAt,
  });

  const triggers: PrMergeQueueHookTriggerName[] = [];
  let lastEntered = previous?.lastEntered;
  let lastRemoved = previous?.lastRemoved;
  for (const transition of previous ? interpretation.transitions : []) {
    if (transition.kind === 'pull_request_queue_removed' && previous) {
      triggers.push('pr:queue:removed');
      lastRemoved = {
        // Coalesced removals report the newest reason, which may belong to a
        // later entry than the one stored, so the entry is left unknown.
        entryId:
          transition.removals !== undefined
            ? null
            : (previous.pendingExit?.entryId ?? previous.membership.entryId),
        removedAt: transition.removedAt,
        reason: transition.reason,
        evidence: transition.evidence,
        requeued: transition.requeued,
        ...(transition.removals !== undefined
          ? { removals: transition.removals }
          : {}),
        observedAt: input.observedAt,
      };
    } else if (transition.kind === 'pull_request_queue_entered') {
      triggers.push('pr:queue:entered');
      lastEntered = {
        entryId: next.membership.entryId,
        enqueuedAt: transition.enqueuedAt,
        phase: transition.phase,
        position: transition.position,
        reentry: transition.reentry,
        observedAt: input.observedAt,
      };
    }
  }

  return {
    triggers,
    mergeQueue: storedState({
      required: next.required,
      membership: next.membership,
      cursor: interpretation.cursor,
      pendingExit: interpretation.pendingExit,
      lastEntered,
      lastRemoved,
    }),
  };
}

/**
 * Bounded queue variables for a hook run: the new entry for
 * `pr:queue:entered`, the exited entry (empty when several removals were
 * coalesced) and GitHub's reason for `pr:queue:removed`. Other triggers get
 * none.
 */
export function buildPrQueueHookVariables(
  snapshot: { mergeQueue?: PrMergeQueueSnapshot } | undefined,
  triggerName: string,
): Partial<Record<PrQueueHookVariableName, string>> {
  if (triggerName === 'pr:queue:entered') {
    return {
      PR_QUEUE_ENTRY_ID:
        boundedEntryId(snapshot?.mergeQueue?.lastEntered?.entryId) ?? '',
      PR_QUEUE_REMOVAL_REASON: '',
    };
  }
  if (triggerName === 'pr:queue:removed') {
    const removed = snapshot?.mergeQueue?.lastRemoved;
    const reason = removed?.reason;
    return {
      PR_QUEUE_ENTRY_ID: boundedEntryId(removed?.entryId) ?? '',
      PR_QUEUE_REMOVAL_REASON:
        typeof reason === 'string' && QUEUE_REMOVAL_REASON_PATTERN.test(reason)
          ? reason
          : '',
    };
  }
  return {};
}
