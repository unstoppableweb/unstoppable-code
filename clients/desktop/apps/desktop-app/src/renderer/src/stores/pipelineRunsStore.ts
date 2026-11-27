import { PIPELINE_REVISION_CHANGED_MESSAGE } from '@canopy/desktop-shared/constants/pipeline-revision';
import { create } from 'zustand';
import type {
  Pipeline,
  PipelineModelAliasPreference,
  PipelinePluginCollectionPreference,
  PipelinePreferenceLocator,
  PipelinePauseResponse,
  PipelineScalar,
} from '@canopy/execution-engine/types/pipeline';
import type {
  AgentModelConfig,
  AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';
import type {
  CancelMatrixVariantRequest,
  ExecutionEvent,
  ExecutionState,
  ExecutionSummary,
  MatrixIpcErrorCode,
  PipelineAdvisorEvent,
  PipelineAdvisorSnapshot,
  PipelineQueueEvent,
  QueuedPipelineExecutionEntry,
  RetryMatrixJobRequest,
} from '@canopy/execution-engine/types/pipeline';
import { decodeMatrixIpcErrorMessage } from '@canopy/execution-engine/types/pipeline';
import {
  isPipelineExecutionLeased,
  isPipelineExecutionRetainedByInterest,
  pipelineDetailOwnerKey,
  releasePipelineDetailLeasesForOwner,
  subscribePipelineInterestChanges,
} from '../lib/pipelineDetailLeases';
import {
  mergePipelineRunRowEvent,
  toPipelineRunRowState,
  type PipelineRunRowState,
} from '../lib/pipelineRunRowState';
import { extractIpcErrorMessage } from '../lib/errors';
import { resetStepLogsForExecution } from './pipelineStepLogStore';
import { useChatStore } from './chatStore';
import { useNavigationStore } from './navigationStore';
import { useProjectsStore } from './projectsStore';

const MAX_FAILED_QUEUED_EXECUTIONS_PER_WORKTREE = 5;
let executionListInFlight: ReturnType<
  typeof window.pipelines.listExecutions
> | null = null;
let globalPipelineStatusHydrationInFlight: Promise<void> | null = null;
let globalPipelineStatusHydrationQueued = false;
// A pass prunes saved seen IDs only when a caller in its batch asked to; the
// history read skips unreadable files, so a background refresh keeps them.
let globalPipelineStatusPruneRequested = false;
let globalPipelineStatusKeepSeenCall = false;

function listExecutionsSingleFlight(): ReturnType<
  typeof window.pipelines.listExecutions
> {
  if (executionListInFlight) {
    return executionListInFlight;
  }

  const request = window.pipelines.listExecutions();
  executionListInFlight = request;
  const clear = (): void => {
    if (executionListInFlight === request) {
      executionListInFlight = null;
    }
  };
  void request.then(clear, clear);
  return request;
}

/** Result of a targeted matrix retry or cancellation request. */
export interface MatrixActionResult {
  success: boolean;
  code?: MatrixIpcErrorCode;
  error?: string;
  conflict?: boolean;
  retryable?: boolean;
}

export const MATRIX_VARIANT_CANCEL_UNAVAILABLE_TEXT =
  "This variant can't be cancelled right now. Try again in a moment.";

/** Classify the stable bracketed code carried through Electron IPC errors. */
function classifyMatrixActionError(error: unknown): MatrixActionResult {
  const { code, message } = decodeMatrixIpcErrorMessage(
    extractIpcErrorMessage(error),
  );

  if (code === 'matrix/retry-in-progress') {
    // A retry is already running for this job. Nothing was started twice and
    // nothing failed — report it as a benign conflict.
    return { success: true, code, conflict: true };
  }

  if (code === 'matrix/running-variant-unowned') {
    return {
      success: false,
      code,
      retryable: true,
      error: MATRIX_VARIANT_CANCEL_UNAVAILABLE_TEXT,
    };
  }

  return {
    success: false,
    ...(code !== null ? { code } : {}),
    error: message,
  };
}

export interface WorktreePipelineEntry {
  id: string;
  name: string;
  status: ExecutionState['status'];
  startedAt?: string;
  completedAt?: string;
  /** Open whole-run pause; freezes the popover's duration at this instant. */
  pausedAt?: string;
  /** Milliseconds banked by whole-run pauses that already closed. */
  pausedMs?: number;
  runningJobs?: string[];
  failedJobs?: string[];
}

/**
 * A pipeline execution targeted at a worktree that is still in
 * `setupPhase: 'git-pending'`. Stored in
 * `pendingExecutions[`${projectId}/${worktreeId}`]` and drained from the
 * projectsStore git-ready handler. Deliberately omits `cwd` / `repoPath`:
 * those depend on the worktree's on-disk layout, which doesn't exist yet
 * during Phase A and is computed at flush time via `getWorktreePath`.
 */
export interface PendingPipelineExecution {
  /** Renderer-generated id used for cancel + dedupe. */
  localId: string;
  projectId: string;
  worktreeId: string;
  pipelineId: string;
  /** First arg to `pipelines.execute(...)` — captured at enqueue time. */
  pipelineContent: Pipeline;
  /** Forwarded to `getWorktreePath` at flush time so multi-repo callers pick the right repo cwd. */
  selectedRepoId?: string;
  eventName: 'task_ready';
  eventData: { task_ready: { task_text: string } };
  inputs?: Record<string, string>;
  modelConfig?: AgentModelConfig;
  pluginCollectionPreferences: Record<
    string,
    PipelinePluginCollectionPreference
  >;
  /**
   * Per-alias model preferences captured at enqueue time and forwarded to
   * `pipelines.execute` when the worktree is ready. May carry `reset` markers.
   */
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  /**
   * Main refuses the run if the definition it admits when the worktree is
   * ready differs from `pipelineContent`, which was checked (CAN-7513).
   */
  requireSentDefinition?: true;
  /** Display label for the queued-pipeline UI ("Queued — waiting for setup"). */
  pipelineName: string;
  /** Mirror of eventData.task_ready.task_text for UI tooltips. */
  taskText: string;
  /**
   * Optional watcher recipient chosen in the task-ready run modal. Because the
   * queued run starts later, the destination is carried here and sent with the
   * execute request when the worktree is ready.
   */
  watcherDestination?: AppAdvisorWatcherDestination;
  /**
   * Optional follow-up instruction sent to the watcher's destination chat when
   * the pipeline completes. Only meaningful alongside `watcherDestination`.
   */
  watcherFollowUpInstruction?: string;
  enqueuedAt: number;
}

/**
 * Worktrees whose Git setup failed and hasn't succeeded since, with the
 * failure, so a run queued after the failure is held too (CAN-7513). Not
 * store state: nothing renders it.
 */
const setupFailedWorktrees = new Map<string, string>();

export interface FailedPendingPipelineExecution {
  localId: string;
  projectId: string;
  worktreeId: string;
  pipelineId: string;
  pipelineName: string;
  taskText: string;
  error: string;
  failedAt: number;
  /**
   * The queued request, kept so Retry starts the same run again on this
   * worktree with the inputs, watcher and model choices it was queued with.
   * Queuing it again gives it a new id and time.
   */
  request: PendingPipelineExecution;
  /**
   * False when the same request cannot succeed yet: main refused it because
   * the workflow changed after it was chosen (CAN-7513), or the worktree's
   * setup failed and has not succeeded since.
   */
  retryable: boolean;
  /** The worktree's Git setup failed; Retry waits for it to succeed. */
  awaitsSetup?: boolean;
}

/**
 * Renderer-side mirror of a hook-pipeline queue entry. When the main process
 * defers a hook-triggered pipeline because of pipeline concurrency, it emits
 * a `queued` event carrying this shape; the store tracks the entries
 * per-worktree so the activity panel can render queued cards.
 */
export type FailedQueuedPipelineExecution = QueuedPipelineExecutionEntry & {
  error: string;
  failedAt: number;
};

interface PipelineExecutionScope {
  cwd: string;
  projectId?: string;
  worktreeId?: string;
}

interface PipelineRunsState {
  currentCwd: string | null;
  currentProjectId: string | null;
  currentWorktreeId: string | null;
  /**
   * List projection for the selected scope (`currentCwd` and ids). Reset
   * when the scope changes; never the owner of detail state.
   */
  summaries: ExecutionSummary[];
  /** Full execution states are retained only while a detail lease exists. */
  statesById: Record<string, ExecutionState>;
  /** Slim rows retained for listed or explicitly interested executions. */
  rowStatesById: Record<string, PipelineRunRowState>;
  isHydratingGlobalPipelineStatuses: boolean;
  hasHydratedGlobalPipelineStatuses: boolean;
  pendingGlobalExecutionStatesById: Record<
    string,
    GlobalPipelineExecutionRecord
  >;
  runningExecutionsByWorktree: Record<string, Set<string>>;
  pausedExecutionsByWorktree: Record<string, Set<string>>;
  unseenPipelineWorktreeKeys: Set<string>;
  unseenFailedPipelineWorktreeKeys: Set<string>;
  pipelineSummariesByWorktree: Record<string, WorktreePipelineEntry[]>;
  /**
   * Pipeline executions targeted at a worktree that is still in
   * `setupPhase: 'git-pending'`. Keyed by `${projectId}/${worktreeId}`.
   * Drained FIFO from the projectsStore git-ready handler.
   */
  pendingExecutions: Record<string, PendingPipelineExecution[]>;
  failedPendingExecutions: Record<string, FailedPendingPipelineExecution[]>;
  /**
   * Hook-pipeline queue entries currently waiting for active pipelines to
   * finish. Keyed by `${projectId}/${worktreeId}` and ordered FIFO, mirroring
   * the per-worktree slice of the main-process global FIFO.
   */
  queuedExecutionsByWorktree: Record<string, QueuedPipelineExecutionEntry[]>;
  /**
   * Hook-pipeline queue entries that failed to start when their turn came up
   * (the renderer needs the original entry for display copy plus the
   * resolved error string).
   */
  failedQueuedExecutionsByWorktree: Record<
    string,
    FailedQueuedPipelineExecution[]
  >;
  /**
   * Latest Pipeline Advisor (persistent supervisor) snapshot keyed by
   * execution id. Populated by `loadExecutions` and
   * `loadGlobalPipelineStatuses` for known summaries, by
   * `loadExecutionDetails` for a single execution, and refreshed by
   * `handleAdvisorEvent` whenever the main process emits a snapshot mutation.
   */
  advisorSnapshotsByExecutionId: Record<string, PipelineAdvisorSnapshot>;
  enqueuePendingExecution: (
    params: Omit<PendingPipelineExecution, 'localId' | 'enqueuedAt'>,
  ) => string;
  cancelPendingExecution: (localId: string) => void;
  dismissFailedPendingExecution: (localId: string) => void;
  /** Queues a failed queued run again with the request it was queued with. */
  retryFailedPendingExecution: (localId: string) => void;
  flushPendingForWorktree: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
  dropPendingForWorktree: (projectId: string, worktreeId: string) => void;
  /**
   * Turns the worktree's queued runs into failed ones that keep their
   * requests, for Retry, when the worktree's setup fails.
   */
  failPendingForWorktree: (
    projectId: string,
    worktreeId: string,
    error: string,
  ) => void;
  /**
   * The worktree's Git setup succeeded (or it was repaired): runs that
   * failed with its setup can be retried.
   */
  releaseSetupFailedForWorktree: (
    projectId: string,
    worktreeId: string,
  ) => void;
  handleQueueEvent: (event: PipelineQueueEvent) => void;
  cancelQueuedPipelineExecution: (queueId: string) => Promise<void>;
  dismissFailedQueuedExecution: (queueId: string) => void;
  loadExecutions: (scope: PipelineExecutionScope) => Promise<void>;
  loadExecutionDetails: (executionId: string) => Promise<ExecutionState | null>;
  loadExecutionRowState: (
    executionId: string,
  ) => Promise<PipelineRunRowState | null>;
  resumeExecution: (
    executionId: string,
    options?: {
      inputAnswers?: Record<string, PipelineScalar>;
      pauseResponses?: PipelinePauseResponse[];
      statusReasonIds?: string[];
    },
  ) => Promise<{ success: boolean; error?: string }>;
  retryExecution: (
    executionId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  /** Retry a terminal matrix group or selected failed/cancelled variants. */
  retryMatrixJob: (
    request: RetryMatrixJobRequest,
  ) => Promise<MatrixActionResult>;
  cancelMatrixVariant: (
    request: CancelMatrixVariantRequest,
  ) => Promise<MatrixActionResult>;
  rerunExecution: (
    executionId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  setExecutionHidden: (
    executionId: string,
    hidden: boolean,
  ) => Promise<{ success: boolean; error?: string }>;
  handleExecutionEvent: (event: ExecutionEvent) => void;
  trackGlobalExecutionEvent: (event: ExecutionEvent) => void;
  loadGlobalPipelineStatuses: () => Promise<void>;
  /** {@link loadGlobalPipelineStatuses} without pruning saved seen IDs. */
  refreshGlobalPipelineStatusesKeepingSeen: () => Promise<void>;
  /**
   * Fetch advisor snapshots for the given execution ids and merge them into
   * {@link advisorSnapshotsByExecutionId}. Used after summary loads so the
   * activity panel and details modal have an initial snapshot to display
   * before any `onAdvisorEvent` push arrives.
   */
  loadAdvisorSnapshots: (executionIds: string[]) => Promise<void>;
  /**
   * Apply a push event from `window.pipelines.onAdvisorEvent` by upserting
   * the carried snapshot into {@link advisorSnapshotsByExecutionId}. The
   * snapshot is keyed by `event.executionId`.
   */
  handleAdvisorEvent: (event: PipelineAdvisorEvent) => void;
  markWorktreePipelineSeen: (worktreeKey: string) => void;
  /** Prunes one execution after a lease or summary interest was released. */
  releaseExecutionDetail: (executionId: string) => void;
  /**
   * Owner cleanup (worktree archived or removed): releases every detail lease
   * the owner holds and evicts what nothing else retains.
   */
  releaseDetailOwner: (projectId: string, worktreeId: string) => void;
  /**
   * Resets the selected-scope list projection and unretained detail. Global
   * status, queue, advisor, and hydration state are not scope-owned and are
   * kept for the overview, sidebar, and busy consumers.
   */
  clear: () => void;
}

export function summaryFromState(state: ExecutionState): ExecutionSummary {
  const planModified =
    state.plan_hash_before !== undefined &&
    state.plan_hash_after !== undefined &&
    state.plan_hash_before !== state.plan_hash_after;
  const summary: ExecutionSummary = {
    id: state.id,
    pipeline_id: state.pipeline_id,
    pipeline_name: state.pipeline_snapshot.name,
    status: state.status,
    status_reasons: (state.status_reasons ?? []).map((reason) => {
      const safeReason = structuredClone(reason);
      delete safeReason.diagnostic_message;
      return safeReason;
    }),
    started_at: state.started_at,
    completed_at: state.completed_at,
    cwd: state.cwd,
    event_name: state.event_name,
    project_id: state.project_id,
    worktree_id: state.worktree_id,
    planId: state.planId,
    plan_modified: planModified || undefined,
    has_plan: state.plan_hash_after !== undefined ? true : undefined,
    has_report:
      Boolean(
        state.report_outputs?.report_file ||
        state.report_outputs?.report_json_file,
      ) || undefined,
    rerun_source_id: state.rerun_source_id,
    parent_execution_id: state.parent_execution_id,
    parent_step_id: state.parent_step_id,
    parent_attempt: state.parent_attempt,
    parent_iteration: state.parent_iteration,
    hidden: state.hidden,
    trigger_source: state.trigger_source,
    execution_context: state.execution_context,
    initiator: state.initiator,
  };
  return summary;
}

function upsertSummary(
  summaries: ExecutionSummary[],
  nextSummary: ExecutionSummary,
): ExecutionSummary[] {
  const existingIndex = summaries.findIndex((s) => s.id === nextSummary.id);
  const next =
    existingIndex >= 0
      ? summaries.map((summary, index) =>
          index === existingIndex ? nextSummary : summary,
        )
      : [nextSummary, ...summaries];

  return [...next].sort(
    (left, right) =>
      new Date(right.started_at).getTime() -
      new Date(left.started_at).getTime(),
  );
}

function currentExecutionScope(
  state: Pick<
    PipelineRunsState,
    'currentCwd' | 'currentProjectId' | 'currentWorktreeId'
  >,
): PipelineExecutionScope | null {
  if (!state.currentCwd) {
    return null;
  }

  return {
    cwd: state.currentCwd,
    projectId: state.currentProjectId ?? undefined,
    worktreeId: state.currentWorktreeId ?? undefined,
  };
}

function executionScopesEqual(
  left: PipelineExecutionScope | null,
  right: PipelineExecutionScope,
): boolean {
  return (
    left !== null &&
    left.cwd === right.cwd &&
    left.projectId === right.projectId &&
    left.worktreeId === right.worktreeId
  );
}

function executionMatchesScope(
  execution: Pick<ExecutionSummary, 'cwd' | 'project_id' | 'worktree_id'>,
  scope: PipelineExecutionScope,
): boolean {
  const scopeHasIds = Boolean(scope.projectId && scope.worktreeId);
  const executionHasIds = Boolean(
    execution.project_id && execution.worktree_id,
  );

  if (scopeHasIds && executionHasIds) {
    return (
      execution.project_id === scope.projectId &&
      execution.worktree_id === scope.worktreeId
    );
  }

  return execution.cwd === scope.cwd;
}

function isExecutionListed(
  summaries: readonly ExecutionSummary[],
  executionId: string,
): boolean {
  return summaries.some((summary) => summary.id === executionId);
}

function isExecutionRowRetained(
  summaries: readonly ExecutionSummary[],
  executionId: string,
): boolean {
  return (
    isExecutionListed(summaries, executionId) ||
    isPipelineExecutionRetainedByInterest(executionId)
  );
}

function withoutExecution<T>(
  entries: Record<string, T>,
  executionId: string,
): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(entries, executionId)) {
    return entries;
  }
  const next = { ...entries };
  delete next[executionId];
  return next;
}

/** Prunes full state to leased ids and row state to currently eligible ids. */
function prunePipelineExecutionCaches(
  state: Pick<PipelineRunsState, 'summaries' | 'statesById' | 'rowStatesById'>,
): Pick<PipelineRunsState, 'statesById' | 'rowStatesById'> {
  let statesById = state.statesById;
  for (const executionId of Object.keys(statesById)) {
    if (!isPipelineExecutionLeased(executionId)) {
      statesById = withoutExecution(statesById, executionId);
    }
  }

  let rowStatesById = state.rowStatesById;
  for (const executionId of Object.keys(rowStatesById)) {
    if (!isExecutionRowRetained(state.summaries, executionId)) {
      rowStatesById = withoutExecution(rowStatesById, executionId);
    }
  }

  return { statesById, rowStatesById };
}

/**
 * Fold an updated `ExecutionState` returned by a mutation back into the store,
 * upsert the derived summary when the execution belongs to the current view,
 * refresh an eligible row, and retain full detail only under a lease.
 */
function mergeExecutionStateIntoStore(
  prev: PipelineRunsState,
  state: ExecutionState,
): Pick<PipelineRunsState, 'summaries' | 'statesById' | 'rowStatesById'> {
  noteExecutionStateObserved(state.id, state);
  const currentScope = currentExecutionScope(prev);
  const matchesCurrentView =
    currentScope === null ||
    executionMatchesScope(state, currentScope) ||
    (state.parent_execution_id !== undefined &&
      prev.summaries.some((s) => s.id === state.parent_execution_id));

  const summaries = matchesCurrentView
    ? upsertSummary(prev.summaries, summaryFromState(state))
    : prev.summaries;
  const statesById = isPipelineExecutionLeased(state.id)
    ? { ...prev.statesById, [state.id]: state }
    : withoutExecution(prev.statesById, state.id);
  let rowStatesById = prev.rowStatesById;
  if (isExecutionRowRetained(summaries, state.id)) {
    const row = mergePipelineRunRowEvent(rowStatesById[state.id], state);
    if (row) {
      rowStatesById = { ...rowStatesById, [state.id]: row };
    }
  }
  const nextState = { summaries, statesById, rowStatesById };
  return {
    summaries,
    ...prunePipelineExecutionCaches(nextState),
  };
}

function mergeExecutionEventState(
  existing: ExecutionState | undefined,
  incoming: ExecutionState,
): ExecutionState | undefined {
  if (incoming.job_definitions && incoming.job_groups) {
    return incoming;
  }
  if (!existing?.job_definitions || !existing.job_groups) {
    return undefined;
  }
  return {
    ...existing,
    ...incoming,
    job_definitions: existing.job_definitions,
    job_groups: existing.job_groups,
  };
}

/**
 * One in-flight `getExecution` snapshot read.
 *
 * Stale-snapshot guard: `ExecutionState` carries no revision, and its
 * timestamps are not monotonic across pause, resume, retry, and recovery, so
 * the renderer cannot order a snapshot against an event by content. It can
 * order them by observation: any execution event or mutation result for the
 * execution observed after the read was issued is treated as newer than the
 * snapshot, because main may have produced the snapshot before emitting it.
 * The snapshot then only fills in structure the newer state lacks.
 */
interface ExecutionDetailRead {
  superseded: boolean;
  /** Newest state observed while the read was in flight. */
  latestState: ExecutionState | null;
}

const executionDetailReads = new Map<
  string,
  { read: ExecutionDetailRead; promise: Promise<ExecutionState | null> }
>();

/** Records a lifecycle state that supersedes any in-flight snapshot read. */
function noteExecutionStateObserved(
  executionId: string,
  state: ExecutionState,
): void {
  const inFlight = executionDetailReads.get(executionId);
  if (!inFlight) return;
  inFlight.read.superseded = true;
  inFlight.read.latestState = state;
}

/** One shared snapshot read for row and detail callers. */
function loadExecutionSnapshot(executionId: string): {
  read: ExecutionDetailRead;
  promise: Promise<ExecutionState | null>;
} {
  const inFlight = executionDetailReads.get(executionId);
  if (inFlight) return inFlight;

  const read: ExecutionDetailRead = { superseded: false, latestState: null };
  const promise = (async (): Promise<ExecutionState | null> => {
    try {
      const result = await window.pipelines.getExecution(executionId);
      if (!result.success || !result.data) return null;

      const snapshot = result.data;
      let installed: ExecutionState =
        read.superseded && read.latestState
          ? (mergeExecutionEventState(snapshot, read.latestState) ??
            read.latestState)
          : snapshot;

      usePipelineRunsStore.setState((prev) => {
        const latest = read.latestState;
        const current = prev.statesById[executionId];
        if (read.superseded && current) {
          installed = current;
        } else if (read.superseded && latest) {
          installed = mergeExecutionEventState(snapshot, latest) ?? latest;
        }

        const statesById = isPipelineExecutionLeased(executionId)
          ? { ...prev.statesById, [executionId]: installed }
          : withoutExecution(prev.statesById, executionId);
        const projectedRow =
          read.superseded && latest
            ? mergePipelineRunRowEvent(toPipelineRunRowState(snapshot), latest)
            : toPipelineRunRowState(snapshot);
        let rowStatesById = prev.rowStatesById;
        if (
          isExecutionRowRetained(prev.summaries, executionId) &&
          projectedRow
        ) {
          rowStatesById = {
            ...rowStatesById,
            [executionId]: projectedRow,
          };
        }

        const nextState = { ...prev, statesById, rowStatesById };
        return prunePipelineExecutionCaches(nextState);
      });

      return installed;
    } catch {
      return null;
    } finally {
      if (executionDetailReads.get(executionId)?.read === read) {
        executionDetailReads.delete(executionId);
      }
    }
  })();
  const entry = { read, promise };
  executionDetailReads.set(executionId, entry);
  return entry;
}

const advisorSnapshotReads = new Map<string, Promise<void>>();

function loadAdvisorSnapshot(executionId: string): Promise<void> {
  const inFlight = advisorSnapshotReads.get(executionId);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<void> => {
    try {
      if (typeof window.pipelines.getAdvisorSnapshot !== 'function') return;
      const result = await window.pipelines.getAdvisorSnapshot(executionId);
      if (!result.success || !result.data) return;
      const snapshot = result.data;
      usePipelineRunsStore.setState((prev) => ({
        advisorSnapshotsByExecutionId: {
          ...prev.advisorSnapshotsByExecutionId,
          [executionId]: snapshot,
        },
      }));
    } catch {
      // Best-effort — detail consumers render without advisor data.
    } finally {
      advisorSnapshotReads.delete(executionId);
    }
  })();
  advisorSnapshotReads.set(executionId, promise);
  return promise;
}

function isWorktreeSelected(worktreeKey: string): boolean {
  if (useNavigationStore.getState().activePage !== 'main') {
    return false;
  }

  const selected = useChatStore.getState().selectedWorktree;
  if (!selected) return false;
  return `${selected.projectId}/${selected.worktreeId}` === worktreeKey;
}

function stringArraysEqual(
  a: string[] | undefined,
  b: string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function entriesMatch(
  left: WorktreePipelineEntry,
  right: WorktreePipelineEntry,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.status === right.status &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.pausedAt === right.pausedAt &&
    left.pausedMs === right.pausedMs &&
    stringArraysEqual(left.runningJobs, right.runningJobs) &&
    stringArraysEqual(left.failedJobs, right.failedJobs)
  );
}

function updateWorktreePipelineEntries(
  currentEntries: WorktreePipelineEntry[] | undefined,
  nextEntry: WorktreePipelineEntry,
  retainEntry: boolean,
): WorktreePipelineEntry[] | null {
  const existingEntries = currentEntries ?? [];
  const existingIndex = existingEntries.findIndex(
    (entry) => entry.id === nextEntry.id,
  );

  if (retainEntry) {
    if (existingIndex < 0) {
      return [...existingEntries, nextEntry];
    }

    if (entriesMatch(existingEntries[existingIndex], nextEntry)) {
      return currentEntries ?? existingEntries;
    }

    const updatedEntries = [...existingEntries];
    updatedEntries[existingIndex] = nextEntry;
    return updatedEntries;
  }

  if (existingIndex < 0) {
    return currentEntries ?? null;
  }

  const updatedEntries = existingEntries.filter(
    (_, index) => index !== existingIndex,
  );
  return updatedEntries.length > 0 ? updatedEntries : null;
}

function updateExecutionIdSet(
  currentSet: Set<string> | undefined,
  executionId: string,
  shouldInclude: boolean,
): Set<string> | null {
  if (shouldInclude) {
    if (currentSet?.has(executionId)) {
      return currentSet;
    }

    const nextSet = new Set(currentSet);
    nextSet.add(executionId);
    return nextSet;
  }

  if (!currentSet?.has(executionId)) {
    return currentSet ?? null;
  }

  const nextSet = new Set(currentSet);
  nextSet.delete(executionId);
  return nextSet.size > 0 ? nextSet : null;
}

function buildWorktreeKey(
  projectId: string | undefined,
  worktreeId: string | undefined,
): string | null {
  if (!projectId || !worktreeId) return null;
  return `${projectId}/${worktreeId}`;
}

function groupQueuedExecutionsByWorktree(
  entries: QueuedPipelineExecutionEntry[],
): Record<string, QueuedPipelineExecutionEntry[]> {
  const next: Record<string, QueuedPipelineExecutionEntry[]> = {};
  for (const entry of entries) {
    const key = buildWorktreeKey(entry.projectId, entry.worktreeId);
    if (!key) {
      continue;
    }
    next[key] = [...(next[key] ?? []), entry];
  }
  return next;
}

function parseWorktreeKey(
  worktreeKey: string,
): { projectId: string; worktreeId: string } | null {
  const separatorIndex = worktreeKey.indexOf('/');
  if (separatorIndex < 0) {
    return null;
  }

  const projectId = worktreeKey.slice(0, separatorIndex);
  const worktreeId = worktreeKey.slice(separatorIndex + 1);
  if (projectId.length === 0 || worktreeId.length === 0) {
    return null;
  }

  return { projectId, worktreeId };
}

function getErrorMessage(error: unknown): string {
  return extractIpcErrorMessage(error);
}

function isSeenEligibleStatus(status: ExecutionState['status']): boolean {
  return (
    status === 'paused' ||
    status === 'success' ||
    status === 'failure' ||
    status === 'cancelled'
  );
}

function shouldPersistPipelineEntry(
  status: ExecutionState['status'],
  isSelected: boolean,
  isSeen: boolean,
): boolean {
  if (status === 'paused') {
    return true;
  }

  if (status === 'pending' || status === 'running') {
    return true;
  }

  return !isSelected && !isSeen;
}

function getSeenPipelineExecutionIdsByWorktree(): Record<string, Set<string>> {
  const seenByWorktree: Record<string, Set<string>> = {};

  for (const project of useProjectsStore.getState().projects) {
    if (project.type === 'cowork') {
      continue;
    }

    for (const worktree of project.worktrees) {
      if (
        !worktree.seenPipelineExecutionIds ||
        worktree.seenPipelineExecutionIds.length === 0
      ) {
        continue;
      }

      seenByWorktree[`${project.id}/${worktree.id}`] = new Set(
        worktree.seenPipelineExecutionIds,
      );
    }
  }

  return seenByWorktree;
}

function hasSeenPipelineExecutionId(
  projectId: string,
  worktreeId: string,
  executionId: string,
): boolean {
  const project = useProjectsStore
    .getState()
    .projects.find((item) => item.id === projectId);
  if (!project || project.type === 'cowork') {
    return false;
  }

  const worktree = project.worktrees.find((item) => item.id === worktreeId);
  return worktree?.seenPipelineExecutionIds?.includes(executionId) ?? false;
}

interface GlobalPipelineStatusesSnapshot {
  runningExecutionsByWorktree: Record<string, Set<string>>;
  pausedExecutionsByWorktree: Record<string, Set<string>>;
  unseenPipelineWorktreeKeys: Set<string>;
  unseenFailedPipelineWorktreeKeys: Set<string>;
  pipelineSummariesByWorktree: Record<string, WorktreePipelineEntry[]>;
  activeExecutionIdsByWorktree: Record<string, Set<string>>;
}

interface GlobalPipelineExecutionRecord {
  id: string;
  projectId?: string;
  worktreeId?: string;
  name: string;
  status: ExecutionState['status'];
  startedAt?: string;
  completedAt?: string;
  pausedAt?: string;
  pausedMs?: number;
  runningJobs?: string[];
  failedJobs?: string[];
}

function createEmptyGlobalPipelineStatusesSnapshot(): GlobalPipelineStatusesSnapshot {
  return {
    runningExecutionsByWorktree: {},
    pausedExecutionsByWorktree: {},
    unseenPipelineWorktreeKeys: new Set<string>(),
    unseenFailedPipelineWorktreeKeys: new Set<string>(),
    pipelineSummariesByWorktree: {},
    activeExecutionIdsByWorktree: {},
  };
}

function createGlobalPipelineExecutionRecordFromSummary(
  summary: ExecutionSummary,
): GlobalPipelineExecutionRecord {
  return {
    id: summary.id,
    projectId: summary.project_id,
    worktreeId: summary.worktree_id,
    name: summary.pipeline_name,
    status: summary.status,
    startedAt: summary.started_at,
    completedAt: summary.completed_at,
    pausedAt: summary.paused_at,
    pausedMs: summary.paused_ms,
  };
}

function createGlobalPipelineExecutionRecordFromState(
  state: ExecutionState,
): GlobalPipelineExecutionRecord {
  const runningJobs: string[] = [];
  const failedJobs: string[] = [];

  for (const [jobId, job] of Object.entries(state.jobs)) {
    const jobName =
      state.job_definitions?.[jobId]?.name ??
      state.pipeline_snapshot.jobs[jobId]?.name ??
      jobId;
    if (job.status === 'running' || job.status === 'restarting') {
      runningJobs.push(jobName);
    } else if (job.status === 'failure') {
      failedJobs.push(jobName);
    }
  }

  return {
    id: state.id,
    projectId: state.project_id,
    worktreeId: state.worktree_id,
    name: state.pipeline_snapshot.name,
    status: state.status,
    startedAt: state.started_at,
    completedAt: state.completed_at,
    pausedAt: state.paused_at,
    pausedMs: state.paused_ms,
    runningJobs: runningJobs.length > 0 ? runningJobs : undefined,
    failedJobs: failedJobs.length > 0 ? failedJobs : undefined,
  };
}

function addExecutionIdToWorktree(
  entriesByWorktree: Record<string, Set<string>>,
  worktreeKey: string,
  executionId: string,
): void {
  if (!entriesByWorktree[worktreeKey]) {
    entriesByWorktree[worktreeKey] = new Set<string>();
  }
  entriesByWorktree[worktreeKey].add(executionId);
}

function applyGlobalPipelineExecutionRecord(
  snapshot: GlobalPipelineStatusesSnapshot,
  record: GlobalPipelineExecutionRecord,
  seenByWorktree: Record<string, Set<string>>,
): void {
  const worktreeKey = buildWorktreeKey(record.projectId, record.worktreeId);
  if (!worktreeKey) {
    return;
  }

  addExecutionIdToWorktree(
    snapshot.activeExecutionIdsByWorktree,
    worktreeKey,
    record.id,
  );

  const selected = isWorktreeSelected(worktreeKey);
  const seenIds = seenByWorktree[worktreeKey];
  const isSeen = seenIds?.has(record.id) ?? false;

  if (record.status === 'pending' || record.status === 'running') {
    addExecutionIdToWorktree(
      snapshot.runningExecutionsByWorktree,
      worktreeKey,
      record.id,
    );
  } else if (record.status === 'paused') {
    addExecutionIdToWorktree(
      snapshot.pausedExecutionsByWorktree,
      worktreeKey,
      record.id,
    );
  }

  if (shouldPersistPipelineEntry(record.status, selected, isSeen)) {
    if (!snapshot.pipelineSummariesByWorktree[worktreeKey]) {
      snapshot.pipelineSummariesByWorktree[worktreeKey] = [];
    }
    snapshot.pipelineSummariesByWorktree[worktreeKey].push({
      id: record.id,
      name: record.name,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      pausedAt: record.pausedAt,
      pausedMs: record.pausedMs,
      runningJobs: record.runningJobs,
      failedJobs: record.failedJobs,
    });
  }

  if (!selected && !isSeen && isSeenEligibleStatus(record.status)) {
    snapshot.unseenPipelineWorktreeKeys.add(worktreeKey);
  }

  if (!selected && !isSeen && record.status === 'failure') {
    snapshot.unseenFailedPipelineWorktreeKeys.add(worktreeKey);
  }
}

function buildGlobalPipelineStatusesSnapshot(
  summaries: readonly ExecutionSummary[],
  pendingRecordsById: Record<string, GlobalPipelineExecutionRecord>,
  seenByWorktree: Record<string, Set<string>>,
): GlobalPipelineStatusesSnapshot {
  const records = new Map<string, GlobalPipelineExecutionRecord>();
  for (const summary of summaries) {
    records.set(
      summary.id,
      createGlobalPipelineExecutionRecordFromSummary(summary),
    );
  }

  for (const record of Object.values(pendingRecordsById)) {
    records.set(record.id, record);
  }

  const snapshot = createEmptyGlobalPipelineStatusesSnapshot();
  for (const record of Array.from(records.values())) {
    applyGlobalPipelineExecutionRecord(snapshot, record, seenByWorktree);
  }

  return snapshot;
}

function generatePendingExecutionLocalId(): string {
  if (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto?.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const usePipelineRunsStore = create<PipelineRunsState>((set, get) => ({
  currentCwd: null,
  currentProjectId: null,
  currentWorktreeId: null,
  summaries: [],
  statesById: {},
  rowStatesById: {},
  isHydratingGlobalPipelineStatuses: false,
  hasHydratedGlobalPipelineStatuses: false,
  pendingGlobalExecutionStatesById: {},
  runningExecutionsByWorktree: {},
  pausedExecutionsByWorktree: {},
  unseenPipelineWorktreeKeys: new Set<string>(),
  unseenFailedPipelineWorktreeKeys: new Set<string>(),
  pipelineSummariesByWorktree: {},
  pendingExecutions: {},
  failedPendingExecutions: {},
  queuedExecutionsByWorktree: {},
  failedQueuedExecutionsByWorktree: {},
  advisorSnapshotsByExecutionId: {},

  enqueuePendingExecution: (params): string => {
    const localId = generatePendingExecutionLocalId();
    const entry: PendingPipelineExecution = {
      ...params,
      localId,
      enqueuedAt: Date.now(),
    };
    const key = buildWorktreeKey(params.projectId, params.worktreeId);
    if (!key) return localId;
    // A worktree whose Git setup already failed doesn't run it: the run waits
    // as a failed run, held until setup succeeds (CAN-7513).
    const setupError = setupFailedWorktrees.get(key);
    if (setupError !== undefined) {
      set((prev) => ({
        failedPendingExecutions: {
          ...prev.failedPendingExecutions,
          [key]: [
            ...(prev.failedPendingExecutions[key] ?? []),
            {
              localId,
              projectId: params.projectId,
              worktreeId: params.worktreeId,
              pipelineId: params.pipelineId,
              pipelineName: params.pipelineName,
              taskText: params.taskText,
              error: setupError,
              failedAt: Date.now(),
              request: entry,
              retryable: false,
              awaitsSetup: true,
            },
          ],
        },
      }));
      return localId;
    }
    const foundProject = useProjectsStore
      .getState()
      .projects.find((project) => project.id === params.projectId);
    const worktree =
      foundProject && foundProject.type !== 'cowork'
        ? foundProject.worktrees.find(
            (candidate) => candidate.id === params.worktreeId,
          )
        : undefined;
    const shouldStartImmediately =
      worktree !== undefined && worktree.setupPhase !== 'git-pending';

    set((prev) => ({
      pendingExecutions: {
        ...prev.pendingExecutions,
        [key]: [...(prev.pendingExecutions[key] ?? []), entry],
      },
    }));
    if (shouldStartImmediately) {
      void get().flushPendingForWorktree(params.projectId, params.worktreeId);
    }
    return localId;
  },

  cancelPendingExecution: (localId): void => {
    set((prev) => {
      let removed = false;
      const next: Record<string, PendingPipelineExecution[]> = {};
      for (const [key, list] of Object.entries(prev.pendingExecutions)) {
        const filtered = list.filter((entry) => entry.localId !== localId);
        if (filtered.length !== list.length) {
          removed = true;
        }
        if (filtered.length > 0) {
          next[key] = filtered;
        }
      }
      if (!removed) return prev;
      return { pendingExecutions: next };
    });
  },

  dismissFailedPendingExecution: (localId): void => {
    set((prev) => {
      let removed = false;
      const next: Record<string, FailedPendingPipelineExecution[]> = {};
      for (const [key, list] of Object.entries(prev.failedPendingExecutions)) {
        const filtered = list.filter((entry) => entry.localId !== localId);
        if (filtered.length !== list.length) {
          removed = true;
        }
        if (filtered.length > 0) {
          next[key] = filtered;
        }
      }
      if (!removed) return prev;
      return { failedPendingExecutions: next };
    });
  },

  retryFailedPendingExecution: (localId): void => {
    const failed = Object.values(get().failedPendingExecutions)
      .flat()
      .find((entry) => entry.localId === localId);
    if (failed === undefined || !failed.retryable) return;
    get().dismissFailedPendingExecution(localId);
    get().enqueuePendingExecution(failed.request);
  },

  failPendingForWorktree: (projectId, worktreeId, error): void => {
    const key = buildWorktreeKey(projectId, worktreeId);
    if (!key) return;
    // Remembered for runs queued after the failure arrives, too.
    setupFailedWorktrees.set(key, error);
    set((prev) => {
      const queued = prev.pendingExecutions[key];
      if (!queued || queued.length === 0) return prev;
      const next = { ...prev.pendingExecutions };
      delete next[key];
      const failedAt = Date.now();
      return {
        pendingExecutions: next,
        failedPendingExecutions: {
          ...prev.failedPendingExecutions,
          [key]: [
            ...(prev.failedPendingExecutions[key] ?? []),
            ...queued.map((entry) => ({
              localId: entry.localId,
              projectId,
              worktreeId,
              pipelineId: entry.pipelineId,
              pipelineName: entry.pipelineName,
              taskText: entry.taskText,
              error,
              failedAt,
              request: entry,
              retryable: false,
              awaitsSetup: true,
            })),
          ],
        },
      };
    });
  },

  releaseSetupFailedForWorktree: (projectId, worktreeId): void => {
    const key = buildWorktreeKey(projectId, worktreeId);
    if (!key) return;
    setupFailedWorktrees.delete(key);
    set((prev) => {
      const failed = prev.failedPendingExecutions[key];
      if (!failed?.some((entry) => entry.awaitsSetup)) return prev;
      return {
        failedPendingExecutions: {
          ...prev.failedPendingExecutions,
          [key]: failed.map((entry) =>
            entry.awaitsSetup
              ? { ...entry, awaitsSetup: false, retryable: true }
              : entry,
          ),
        },
      };
    });
  },

  dropPendingForWorktree: (projectId, worktreeId): void => {
    const key = buildWorktreeKey(projectId, worktreeId);
    if (!key) return;
    setupFailedWorktrees.delete(key);
    set((prev) => {
      if (
        !(key in prev.pendingExecutions) &&
        !(key in prev.failedPendingExecutions) &&
        !(key in prev.queuedExecutionsByWorktree) &&
        !(key in prev.failedQueuedExecutionsByWorktree)
      ) {
        return prev;
      }
      const next = { ...prev.pendingExecutions };
      const nextFailed = { ...prev.failedPendingExecutions };
      const nextQueued = { ...prev.queuedExecutionsByWorktree };
      const nextFailedQueued = { ...prev.failedQueuedExecutionsByWorktree };
      delete next[key];
      delete nextFailed[key];
      delete nextQueued[key];
      delete nextFailedQueued[key];
      return {
        pendingExecutions: next,
        failedPendingExecutions: nextFailed,
        queuedExecutionsByWorktree: nextQueued,
        failedQueuedExecutionsByWorktree: nextFailedQueued,
      };
    });
  },

  handleQueueEvent: (event: PipelineQueueEvent): void => {
    if (event.type === 'queued') {
      const key = buildWorktreeKey(
        event.entry.projectId,
        event.entry.worktreeId,
      );
      if (!key) return;
      set((prev) => {
        const existing = prev.queuedExecutionsByWorktree[key] ?? [];
        if (existing.some((entry) => entry.queueId === event.entry.queueId)) {
          return prev;
        }
        return {
          queuedExecutionsByWorktree: {
            ...prev.queuedExecutionsByWorktree,
            [key]: [...existing, event.entry],
          },
        };
      });
      return;
    }

    if (event.type === 'started' || event.type === 'cancelled') {
      set((prev) => {
        let removed = false;
        const next: Record<string, QueuedPipelineExecutionEntry[]> = {};
        for (const [key, list] of Object.entries(
          prev.queuedExecutionsByWorktree,
        )) {
          const filtered = list.filter(
            (entry) => entry.queueId !== event.queueId,
          );
          if (filtered.length !== list.length) {
            removed = true;
          }
          if (filtered.length > 0) {
            next[key] = filtered;
          }
        }
        if (!removed) return prev;
        return { queuedExecutionsByWorktree: next };
      });
      return;
    }

    if (event.type === 'failed') {
      const key = buildWorktreeKey(
        event.entry.projectId,
        event.entry.worktreeId,
      );
      if (!key) return;
      set((prev) => {
        const existing = prev.queuedExecutionsByWorktree[key] ?? [];
        const filtered = existing.filter(
          (entry) => entry.queueId !== event.queueId,
        );
        const queuedNext: Record<string, QueuedPipelineExecutionEntry[]> = {
          ...prev.queuedExecutionsByWorktree,
        };
        if (filtered.length > 0) {
          queuedNext[key] = filtered;
        } else {
          delete queuedNext[key];
        }

        const failedExisting = prev.failedQueuedExecutionsByWorktree[key] ?? [];
        const alreadyFailed = failedExisting.some(
          (entry) => entry.queueId === event.queueId,
        );
        const failedNext: Record<string, FailedQueuedPipelineExecution[]> = {
          ...prev.failedQueuedExecutionsByWorktree,
        };
        failedNext[key] = alreadyFailed
          ? failedExisting
          : [
              ...failedExisting,
              {
                ...event.entry,
                error: event.error,
                failedAt: Date.now(),
              },
            ].slice(-MAX_FAILED_QUEUED_EXECUTIONS_PER_WORKTREE);
        return {
          queuedExecutionsByWorktree: queuedNext,
          failedQueuedExecutionsByWorktree: failedNext,
        };
      });
    }
  },

  cancelQueuedPipelineExecution: async (queueId): Promise<void> => {
    try {
      await window.pipelines.cancelQueuedExecution(queueId);
    } catch {
      // Cancellation is best-effort. The main process emits a `cancelled`
      // queue event when the entry is removed; if the IPC call fails the
      // card stays so the user can retry.
    }
  },

  dismissFailedQueuedExecution: (queueId): void => {
    set((prev) => {
      let removed = false;
      const next: Record<string, FailedQueuedPipelineExecution[]> = {};
      for (const [key, list] of Object.entries(
        prev.failedQueuedExecutionsByWorktree,
      )) {
        const filtered = list.filter((entry) => entry.queueId !== queueId);
        if (filtered.length !== list.length) {
          removed = true;
        }
        if (filtered.length > 0) {
          next[key] = filtered;
        }
      }
      if (!removed) return prev;
      return { failedQueuedExecutionsByWorktree: next };
    });
  },

  flushPendingForWorktree: (projectId, worktreeId): Promise<void> => {
    const key = buildWorktreeKey(projectId, worktreeId);
    if (!key) return Promise.resolve();

    const queued = get().pendingExecutions[key];
    if (!queued || queued.length === 0) return Promise.resolve();

    // Clear the bucket up front so re-entry (e.g. a duplicate git-ready event)
    // is a no-op rather than a double-execute.
    set((prev) => {
      if (!(key in prev.pendingExecutions)) return prev;
      const next = { ...prev.pendingExecutions };
      delete next[key];
      return { pendingExecutions: next };
    });

    // FIFO start order, but no awaiting between entries — each execute is
    // dispatched independently and surfaced through the existing global
    // pipeline event subscription.
    for (const entry of queued) {
      void (async (): Promise<void> => {
        try {
          const cwd = await window.api.getWorktreePath({
            projectId,
            worktreeId,
            ...(entry.selectedRepoId ? { repoId: entry.selectedRepoId } : {}),
          });
          const result = await window.pipelines.execute(entry.pipelineContent, {
            cwd,
            // pipelineFilePath intentionally omitted — pipeline.info.filePath
            // was discovered against the source-repo cwd and is not a valid
            // path inside the newly created worktree. The captured
            // pipelineContent is authoritative for this flow.
            repoPath: cwd,
            pipelineId: entry.pipelineId,
            projectId,
            worktreeId,
            eventName: entry.eventName,
            eventData: entry.eventData,
            ...(entry.inputs && Object.keys(entry.inputs).length > 0
              ? { inputs: entry.inputs }
              : {}),
            pluginCollectionPreferences: entry.pluginCollectionPreferences,
            ...(entry.modelAliasPreferences
              ? { modelAliasPreferences: entry.modelAliasPreferences }
              : {}),
            ...(entry.requireSentDefinition
              ? { requireSentDefinition: true }
              : {}),
            modelConfig: entry.modelConfig,
            ...(entry.watcherDestination
              ? {
                  appAdvisorPipelineWatchers: [
                    {
                      destination: entry.watcherDestination,
                      watcher: {
                        ...(entry.watcherFollowUpInstruction
                          ? {
                              followUpInstruction:
                                entry.watcherFollowUpInstruction,
                            }
                          : {}),
                      },
                    },
                  ],
                }
              : {}),
            ...(entry.pipelinePreferenceLocator
              ? {
                  pipelinePreferenceLocator: entry.pipelinePreferenceLocator,
                }
              : {}),
          });
          if (!result.success) {
            throw new Error(
              result.error ?? 'Failed to start queued workflow execution',
            );
          }
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          set((prev) => ({
            failedPendingExecutions: {
              ...prev.failedPendingExecutions,
              [key]: [
                ...(prev.failedPendingExecutions[key] ?? []),
                {
                  localId: entry.localId,
                  projectId,
                  worktreeId,
                  pipelineId: entry.pipelineId,
                  pipelineName: entry.pipelineName,
                  taskText: entry.taskText,
                  error: errorMessage,
                  failedAt: Date.now(),
                  request: entry,
                  retryable: errorMessage !== PIPELINE_REVISION_CHANGED_MESSAGE,
                },
              ],
            },
          }));
        }
      })();
    }
    return Promise.resolve();
  },

  loadExecutions: async (scope: PipelineExecutionScope): Promise<void> => {
    const previousScope = currentExecutionScope(get());
    if (!executionScopesEqual(previousScope, scope)) {
      set((prev) => {
        const nextState = {
          ...prev,
          currentCwd: scope.cwd,
          currentProjectId: scope.projectId ?? null,
          currentWorktreeId: scope.worktreeId ?? null,
          summaries: [],
        };
        return { ...nextState, ...prunePipelineExecutionCaches(nextState) };
      });
    }

    const emptyQueuedResult: {
      success: true;
      data: QueuedPipelineExecutionEntry[];
    } = {
      success: true,
      data: [],
    };
    const queuedResultPromise = Promise.resolve()
      .then(() => {
        if (typeof window.pipelines.listQueuedExecutions !== 'function') {
          return emptyQueuedResult;
        }
        return window.pipelines.listQueuedExecutions();
      })
      .catch(() => emptyQueuedResult);
    const [result, queuedResult] = await Promise.all([
      Promise.resolve()
        .then(listExecutionsSingleFlight)
        .catch(() => null),
      queuedResultPromise,
    ]);
    const queuedExecutionsByWorktree =
      queuedResult.success && queuedResult.data
        ? groupQueuedExecutionsByWorktree(queuedResult.data)
        : {};
    if (!result || !result.success || !result.data) {
      set((prev) => {
        if (!executionScopesEqual(currentExecutionScope(prev), scope)) {
          return prev;
        }
        const nextState = {
          ...prev,
          summaries: [],
          queuedExecutionsByWorktree,
        };
        return { ...nextState, ...prunePipelineExecutionCaches(nextState) };
      });
      return;
    }
    const filtered = result.data.filter((s) => executionMatchesScope(s, scope));
    const visible = new Set(filtered.map((s) => s.id));
    let added = true;
    while (added) {
      added = false;
      for (const s of result.data) {
        if (
          !visible.has(s.id) &&
          s.parent_execution_id &&
          visible.has(s.parent_execution_id)
        ) {
          filtered.push(s);
          visible.add(s.id);
          added = true;
        }
      }
    }
    filtered.sort(
      (a, b) =>
        new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
    );
    set((prev) => {
      if (!executionScopesEqual(currentExecutionScope(prev), scope)) {
        return prev;
      }
      const nextState = {
        ...prev,
        summaries: filtered,
        queuedExecutionsByWorktree,
      };
      return { ...nextState, ...prunePipelineExecutionCaches(nextState) };
    });

    // Load Pipeline Advisor snapshots for the visible summaries so the
    // activity panel can render the advisor badge immediately without
    // waiting for the first `onAdvisorEvent` push to arrive.
    const summaryIds = filtered.map((summary) => summary.id);
    if (summaryIds.length > 0) {
      await get().loadAdvisorSnapshots(summaryIds);
    }
  },

  loadExecutionDetails: (
    executionId: string,
  ): Promise<ExecutionState | null> => {
    const cached = get().statesById[executionId];
    if (
      !executionDetailReads.has(executionId) &&
      cached &&
      isPipelineExecutionLeased(executionId)
    ) {
      return Promise.resolve(cached);
    }

    return loadExecutionSnapshot(executionId).promise.then(async (state) => {
      if (state) await loadAdvisorSnapshot(executionId);
      return state;
    });
  },

  loadExecutionRowState: (
    executionId: string,
  ): Promise<PipelineRunRowState | null> => {
    const current = get();
    const rowRetained = isExecutionRowRetained(current.summaries, executionId);
    if (!executionDetailReads.has(executionId) && rowRetained) {
      const cachedRow = current.rowStatesById[executionId];
      if (cachedRow) return Promise.resolve(cachedRow);

      const cachedFull = current.statesById[executionId];
      if (cachedFull) {
        const row = toPipelineRunRowState(cachedFull);
        set((prev) => {
          if (!isExecutionRowRetained(prev.summaries, executionId)) {
            return prunePipelineExecutionCaches(prev);
          }
          const nextState = {
            ...prev,
            rowStatesById: {
              ...prev.rowStatesById,
              [executionId]: row,
            },
          };
          return prunePipelineExecutionCaches(nextState);
        });
        return Promise.resolve(row);
      }
    }

    return loadExecutionSnapshot(executionId).promise.then((state) =>
      state ? toPipelineRunRowState(state) : null,
    );
  },

  resumeExecution: async (
    executionId,
    options,
  ): Promise<{ success: boolean; error?: string }> => {
    const result = await window.pipelines.resume(executionId, {
      inputAnswers: options?.inputAnswers,
      pauseResponses: options?.pauseResponses,
      statusReasonIds: options?.statusReasonIds,
    });
    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error ?? 'Failed to resume execution',
      };
    }

    const state = result.data;
    set((prev) => mergeExecutionStateIntoStore(prev, state));

    return { success: true };
  },

  retryExecution: async (
    executionId,
  ): Promise<{ success: boolean; error?: string }> => {
    // External retry reuses the execution id and can restart at attempt 0.
    // Drop the prior live stream before invoking main so early output from the
    // new process cannot be merged with a cancelled/failed attempt.
    resetStepLogsForExecution(executionId);
    const result = await window.pipelines.retryExecution(executionId);
    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error ?? 'Failed to retry execution',
      };
    }

    const state = result.data;
    set((prev) => mergeExecutionStateIntoStore(prev, state));

    return { success: true };
  },

  retryMatrixJob: async (request): Promise<MatrixActionResult> => {
    try {
      resetStepLogsForExecution(request.executionId);
      const state = await window.pipelines.retryMatrixJob(request);
      set((prev) => mergeExecutionStateIntoStore(prev, state));
      return { success: true };
    } catch (error) {
      return classifyMatrixActionError(error);
    }
  },
  cancelMatrixVariant: async (request): Promise<MatrixActionResult> => {
    try {
      const state = await window.pipelines.cancelMatrixVariant(request);
      set((prev) => mergeExecutionStateIntoStore(prev, state));
      return { success: true };
    } catch (error) {
      return classifyMatrixActionError(error);
    }
  },

  rerunExecution: async (
    executionId,
  ): Promise<{ success: boolean; error?: string }> => {
    const result = await window.pipelines.rerunExecution(executionId);
    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error ?? 'Failed to rerun execution',
      };
    }

    const state = result.data;
    set((prev) => mergeExecutionStateIntoStore(prev, state));

    return { success: true };
  },

  setExecutionHidden: async (
    executionId,
    hidden,
  ): Promise<{ success: boolean; error?: string }> => {
    const result = await window.pipelines.setExecutionHidden(
      executionId,
      hidden,
    );
    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error ?? 'Failed to update hidden state',
      };
    }

    const state = result.data;
    noteExecutionStateObserved(executionId, state);
    set((prev) => {
      const summaries = prev.summaries.map((summary) =>
        summary.id === executionId
          ? { ...summary, hidden: hidden || undefined }
          : summary,
      );
      const statesById = isPipelineExecutionLeased(executionId)
        ? { ...prev.statesById, [executionId]: state }
        : withoutExecution(prev.statesById, executionId);
      let rowStatesById = prev.rowStatesById;
      if (isExecutionRowRetained(summaries, executionId)) {
        const row = mergePipelineRunRowEvent(rowStatesById[executionId], state);
        if (row) rowStatesById = { ...rowStatesById, [executionId]: row };
      }
      const nextState = { ...prev, summaries, statesById, rowStatesById };
      return { summaries, ...prunePipelineExecutionCaches(nextState) };
    });

    return { success: true };
  },

  handleExecutionEvent: (event: ExecutionEvent): void => {
    const executionId = event.executionId;
    // Any lifecycle event supersedes an in-flight snapshot read, whether or
    // not this renderer caches the execution.
    noteExecutionStateObserved(executionId, event.state);

    set((prev) => {
      const scope = currentExecutionScope(prev);
      // The selected list projects in-scope executions and children of
      // listed runs.
      const alreadyListed = isExecutionListed(prev.summaries, executionId);
      const parentListed =
        event.state.parent_execution_id !== undefined &&
        isExecutionListed(prev.summaries, event.state.parent_execution_id);
      const inList =
        alreadyListed ||
        (scope !== null &&
          (executionMatchesScope(event.state, scope) || parentListed));

      const summaries = inList
        ? upsertSummary(prev.summaries, summaryFromState(event.state))
        : prev.summaries;

      let statesById = prev.statesById;
      if (isPipelineExecutionLeased(executionId)) {
        const fullState = mergeExecutionEventState(
          prev.statesById[executionId],
          event.state,
        );
        statesById = fullState
          ? { ...prev.statesById, [executionId]: fullState }
          : withoutExecution(prev.statesById, executionId);
      } else {
        statesById = withoutExecution(prev.statesById, executionId);
      }

      let rowStatesById = prev.rowStatesById;
      if (isExecutionRowRetained(summaries, executionId)) {
        const row = mergePipelineRunRowEvent(
          rowStatesById[executionId],
          event.state,
        );
        if (row) rowStatesById = { ...rowStatesById, [executionId]: row };
      } else {
        rowStatesById = withoutExecution(rowStatesById, executionId);
      }

      if (
        summaries === prev.summaries &&
        statesById === prev.statesById &&
        rowStatesById === prev.rowStatesById
      ) {
        return prev;
      }
      return { summaries, statesById, rowStatesById };
    });
  },

  trackGlobalExecutionEvent: (event: ExecutionEvent): void => {
    // The renderer bridge (`hooks/usePipelineRunsBridge.ts`) delivers each
    // execution event here exactly once. Project it into the list and cached
    // detail first, then into the global worktree status maps.
    get().handleExecutionEvent(event);

    const key = buildWorktreeKey(
      event.state.project_id,
      event.state.worktree_id,
    );
    if (!key) return;

    const status = event.state.status;
    const execId = event.executionId;
    const selected = isWorktreeSelected(key);
    const worktree = parseWorktreeKey(key);
    const isFinishedWorktreeExecution =
      worktree !== null &&
      (event.type === 'execution.completed' ||
        event.type === 'execution.failed') &&
      (status === 'success' || status === 'failure');
    const shouldClearSeenExecution =
      worktree !== null &&
      (status === 'pending' || status === 'running') &&
      hasSeenPipelineExecutionId(
        worktree.projectId,
        worktree.worktreeId,
        execId,
      );

    if (worktree && shouldClearSeenExecution) {
      void useProjectsStore
        .getState()
        .clearWorktreeSeenPipelineExecutions(
          worktree.projectId,
          worktree.worktreeId,
          [execId],
        );
    }

    if (isFinishedWorktreeExecution) {
      // Match the main-process known-PR fast refresh: pipeline completion may
      // have changed commits and the working tree, so promote this worktree's
      // local Git stats ahead of the periodic fleet sweep.
      useProjectsStore
        .getState()
        .fastRefreshWorktreeDiffStats(worktree.projectId, worktree.worktreeId);
    }

    set((prev) => {
      let running = prev.runningExecutionsByWorktree;
      let paused = prev.pausedExecutionsByWorktree;
      let unseen = prev.unseenPipelineWorktreeKeys;
      let unseenFailed = prev.unseenFailedPipelineWorktreeKeys;
      let summaries = prev.pipelineSummariesByWorktree;
      let changed = false;

      const runningJobs: string[] = [];
      const failedJobs: string[] = [];
      for (const [jobId, job] of Object.entries(event.state.jobs)) {
        const jobName =
          event.state.job_definitions?.[jobId]?.name ??
          event.state.pipeline_snapshot.jobs[jobId]?.name ??
          jobId;
        if (job.status === 'running' || job.status === 'restarting') {
          runningJobs.push(jobName);
        } else if (job.status === 'failure') {
          failedJobs.push(jobName);
        }
      }

      const entry: WorktreePipelineEntry = {
        id: execId,
        name: event.state.pipeline_snapshot.name,
        status,
        startedAt: event.state.started_at,
        completedAt: event.state.completed_at,
        pausedAt: event.state.paused_at,
        pausedMs: event.state.paused_ms,
        runningJobs: runningJobs.length > 0 ? runningJobs : undefined,
        failedJobs: failedJobs.length > 0 ? failedJobs : undefined,
      };
      const pendingGlobalExecutionStatesById =
        prev.isHydratingGlobalPipelineStatuses
          ? {
              ...prev.pendingGlobalExecutionStatesById,
              [execId]: createGlobalPipelineExecutionRecordFromState(
                event.state,
              ),
            }
          : prev.pendingGlobalExecutionStatesById;
      const currentEntries = prev.pipelineSummariesByWorktree[key];
      const nextEntries = updateWorktreePipelineEntries(
        currentEntries,
        entry,
        shouldPersistPipelineEntry(status, selected, false),
      );
      if (nextEntries !== currentEntries) {
        summaries = { ...prev.pipelineSummariesByWorktree };
        if (nextEntries) {
          summaries[key] = nextEntries;
        } else {
          delete summaries[key];
        }
        changed = true;
      }

      const nextRunning = updateExecutionIdSet(
        prev.runningExecutionsByWorktree[key],
        execId,
        status === 'pending' || status === 'running',
      );
      if (nextRunning !== prev.runningExecutionsByWorktree[key]) {
        running = { ...prev.runningExecutionsByWorktree };
        if (nextRunning) {
          running[key] = nextRunning;
        } else {
          delete running[key];
        }
        changed = true;
      }

      const nextPaused = updateExecutionIdSet(
        prev.pausedExecutionsByWorktree[key],
        execId,
        status === 'paused',
      );
      if (nextPaused !== prev.pausedExecutionsByWorktree[key]) {
        paused = { ...prev.pausedExecutionsByWorktree };
        if (nextPaused) {
          paused[key] = nextPaused;
        } else {
          delete paused[key];
        }
        changed = true;
      }

      const shouldMarkUnseen = isSeenEligibleStatus(status) && !selected;
      if (shouldMarkUnseen && !prev.unseenPipelineWorktreeKeys.has(key)) {
        unseen = new Set(prev.unseenPipelineWorktreeKeys);
        unseen.add(key);
        changed = true;
      }

      // Retry events replace the existing entry for an execution id. Derive
      // worktree severity from those current entries as well, so a successful
      // retry clears its stale failure without hiding another failed run.
      const hasUnseenFailure =
        nextEntries?.some((summary) => summary.status === 'failure') ?? false;
      if (hasUnseenFailure !== prev.unseenFailedPipelineWorktreeKeys.has(key)) {
        unseenFailed = new Set(prev.unseenFailedPipelineWorktreeKeys);
        if (hasUnseenFailure) {
          unseenFailed.add(key);
        } else {
          unseenFailed.delete(key);
        }
        changed = true;
      }

      if (
        !changed &&
        pendingGlobalExecutionStatesById ===
          prev.pendingGlobalExecutionStatesById
      ) {
        const caches = prunePipelineExecutionCaches(prev);
        return caches.statesById === prev.statesById &&
          caches.rowStatesById === prev.rowStatesById
          ? prev
          : caches;
      }

      const nextState = {
        ...prev,
        isHydratingGlobalPipelineStatuses:
          prev.isHydratingGlobalPipelineStatuses,
        pendingGlobalExecutionStatesById,
        runningExecutionsByWorktree: running,
        pausedExecutionsByWorktree: paused,
        unseenPipelineWorktreeKeys: unseen,
        unseenFailedPipelineWorktreeKeys: unseenFailed,
        pipelineSummariesByWorktree: summaries,
      };
      return {
        isHydratingGlobalPipelineStatuses:
          prev.isHydratingGlobalPipelineStatuses,
        pendingGlobalExecutionStatesById,
        runningExecutionsByWorktree: running,
        pausedExecutionsByWorktree: paused,
        unseenPipelineWorktreeKeys: unseen,
        unseenFailedPipelineWorktreeKeys: unseenFailed,
        pipelineSummariesByWorktree: summaries,
        ...prunePipelineExecutionCaches(nextState),
      };
    });
  },

  loadGlobalPipelineStatuses: async (): Promise<void> => {
    if (!globalPipelineStatusKeepSeenCall) {
      globalPipelineStatusPruneRequested = true;
    }
    globalPipelineStatusKeepSeenCall = false;
    if (globalPipelineStatusHydrationInFlight) {
      globalPipelineStatusHydrationQueued = true;
      return globalPipelineStatusHydrationInFlight;
    }

    const run = (async (): Promise<void> => {
      do {
        globalPipelineStatusHydrationQueued = false;
        const pruneSeen = globalPipelineStatusPruneRequested;
        globalPipelineStatusPruneRequested = false;
        set({
          isHydratingGlobalPipelineStatuses: true,
          pendingGlobalExecutionStatesById: {},
        });

        let result: Awaited<
          ReturnType<typeof listExecutionsSingleFlight>
        > | null = null;
        try {
          result = await listExecutionsSingleFlight();
        } catch {
          set({
            isHydratingGlobalPipelineStatuses: false,
            hasHydratedGlobalPipelineStatuses: true,
            pendingGlobalExecutionStatesById: {},
          });
          continue;
        }
        if (result === null || !result.success || !result.data) {
          set({
            isHydratingGlobalPipelineStatuses: false,
            hasHydratedGlobalPipelineStatuses: true,
            pendingGlobalExecutionStatesById: {},
          });
          continue;
        }

        const summaries = result.data;
        const seenByWorktree = getSeenPipelineExecutionIdsByWorktree();
        let activeExecutionIdsByWorktree: Record<string, Set<string>> = {};

        set((prev) => {
          const next = buildGlobalPipelineStatusesSnapshot(
            summaries,
            prev.pendingGlobalExecutionStatesById,
            seenByWorktree,
          );
          activeExecutionIdsByWorktree = next.activeExecutionIdsByWorktree;

          return {
            isHydratingGlobalPipelineStatuses: false,
            hasHydratedGlobalPipelineStatuses: true,
            pendingGlobalExecutionStatesById: {},
            runningExecutionsByWorktree: next.runningExecutionsByWorktree,
            pausedExecutionsByWorktree: next.pausedExecutionsByWorktree,
            unseenPipelineWorktreeKeys: next.unseenPipelineWorktreeKeys,
            unseenFailedPipelineWorktreeKeys:
              next.unseenFailedPipelineWorktreeKeys,
            pipelineSummariesByWorktree: next.pipelineSummariesByWorktree,
          };
        });

        if (!pruneSeen) {
          activeExecutionIdsByWorktree =
            getSeenPipelineExecutionIdsByWorktree();
        }
        await useProjectsStore
          .getState()
          .pruneStaleSeenPipelineExecutionIds(activeExecutionIdsByWorktree);

        // Hydrate advisor snapshots for the global summaries so overview /
        // worktree status surfaces can read the latest ETA without waiting for a
        // push event.
        const summaryIds = summaries.map((summary) => summary.id);
        if (summaryIds.length > 0) {
          await get().loadAdvisorSnapshots(summaryIds);
        }
      } while (globalPipelineStatusHydrationQueued);
    })().finally(() => {
      if (globalPipelineStatusHydrationInFlight === run) {
        globalPipelineStatusHydrationInFlight = null;
      }
    });

    globalPipelineStatusHydrationInFlight = run;
    return run;
  },

  refreshGlobalPipelineStatusesKeepingSeen: (): Promise<void> => {
    globalPipelineStatusKeepSeenCall = true;
    return get().loadGlobalPipelineStatuses();
  },

  loadAdvisorSnapshots: async (executionIds: string[]): Promise<void> => {
    if (executionIds.length === 0) {
      return;
    }
    if (typeof window.pipelines.listAdvisorSnapshots !== 'function') {
      return;
    }
    try {
      const result = await window.pipelines.listAdvisorSnapshots(executionIds);
      if (!result.success || !result.data || result.data.length === 0) {
        return;
      }
      const snapshots = result.data;
      set((prev) => {
        const next = { ...prev.advisorSnapshotsByExecutionId };
        for (const snapshot of snapshots) {
          next[snapshot.executionId] = snapshot;
        }
        return { advisorSnapshotsByExecutionId: next };
      });
    } catch {
      // Best-effort — the UI falls back to displaying no advisor data.
    }
  },

  handleAdvisorEvent: (event: PipelineAdvisorEvent): void => {
    const executionId = event.executionId;
    if (!executionId) return;
    set((prev) => ({
      advisorSnapshotsByExecutionId: {
        ...prev.advisorSnapshotsByExecutionId,
        [executionId]: event.snapshot,
      },
    }));
  },

  markWorktreePipelineSeen: (worktreeKey: string): void => {
    const worktree = parseWorktreeKey(worktreeKey);
    if (!worktree) {
      return;
    }

    const entries = get().pipelineSummariesByWorktree[worktreeKey] ?? [];
    const executionIds = entries
      .filter((entry) => isSeenEligibleStatus(entry.status))
      .map((entry) => entry.id);
    if (executionIds.length > 0) {
      void useProjectsStore
        .getState()
        .markWorktreePipelineExecutionsSeen(
          worktree.projectId,
          worktree.worktreeId,
          executionIds,
        );
    }

    set((prev) => {
      const hadUnseen = prev.unseenPipelineWorktreeKeys.has(worktreeKey);
      const hadFailed = prev.unseenFailedPipelineWorktreeKeys.has(worktreeKey);
      if (!hadUnseen && !hadFailed) return prev;

      const unseen = new Set(prev.unseenPipelineWorktreeKeys);
      unseen.delete(worktreeKey);
      const unseenFailed = new Set(prev.unseenFailedPipelineWorktreeKeys);
      unseenFailed.delete(worktreeKey);

      // Remove terminal entries from summaries since they've been seen
      const summaries = { ...prev.pipelineSummariesByWorktree };
      const entries = summaries[worktreeKey];
      if (entries) {
        const active = entries.filter(
          (e) =>
            e.status === 'pending' ||
            e.status === 'running' ||
            e.status === 'paused',
        );
        if (active.length > 0) {
          summaries[worktreeKey] = active;
        } else {
          delete summaries[worktreeKey];
        }
      }

      return {
        unseenPipelineWorktreeKeys: unseen,
        unseenFailedPipelineWorktreeKeys: unseenFailed,
        pipelineSummariesByWorktree: summaries,
      };
    });
  },

  releaseExecutionDetail: (executionId: string): void => {
    if (isPipelineExecutionLeased(executionId)) return;
    set((prev) => prunePipelineExecutionCaches(prev));
  },

  releaseDetailOwner: (projectId: string, worktreeId: string): void => {
    const unleased = releasePipelineDetailLeasesForOwner(
      pipelineDetailOwnerKey({ projectId, worktreeId }),
    );
    for (const executionId of unleased) {
      get().releaseExecutionDetail(executionId);
    }
    set((prev) => prunePipelineExecutionCaches(prev));
  },

  clear: (): void => {
    set((prev) => {
      const nextState = {
        ...prev,
        currentCwd: null,
        currentProjectId: null,
        currentWorktreeId: null,
        summaries: [],
      };
      return { ...nextState, ...prunePipelineExecutionCaches(nextState) };
    });
  },
}));

let pipelineInterestPrunePending = false;

subscribePipelineInterestChanges(() => {
  if (pipelineInterestPrunePending) return;
  pipelineInterestPrunePending = true;
  queueMicrotask(() => {
    pipelineInterestPrunePending = false;
    usePipelineRunsStore.setState((prev) => {
      const caches = prunePipelineExecutionCaches(prev);
      return caches.statesById === prev.statesById &&
        caches.rowStatesById === prev.rowStatesById
        ? prev
        : caches;
    });
  });
});
