import { createHash } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type {
  InitiatedWorkEngine,
  InitiatedWorkExecution,
  InitiatedWorkRequest,
  InitiatedWorkResumer,
  InitiatedWorkResumption,
  InitiatedWorkRunControl,
} from '@canopy/core-runtime/node/initiated-work';
import type { OperationRecovery } from '@canopy/core-runtime/node/operations/service';
import {
  PIPELINE_TRANSIENT_RETRY_DELAYS_MS,
  PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
} from '@canopy/execution-engine/agent-failures';
import type {
  ExecutionEvent,
  ExecutionState,
  PipelineTransientRetryState,
} from '@canopy/execution-engine/types/pipeline';
import {
  INITIATED_WORK_PIPELINE_TRANSIENT_RETRY_SOURCE,
  InitiatedWorkPipelineTransientRetryOriginContextSchema,
  type CanopyWorkspaceScope,
  type InitiatedWorkPipelineTransientRetryOriginContext,
  type InitiatedWorkRunRecord,
  type InitiatedWorkRunResult,
  type OperationOrigin,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';
import { pipelineExecutionOwnerOf } from './pipeline-operation-owner';
import type {
  ResumePipelineExecutionFromMainRequest,
  ResumePipelineExecutionFromMainResult,
} from './pipeline-resume-service';

/*
 * Automatic retries of a pipeline paused because its provider was
 * temporarily unavailable (CAN-4175). Each scheduled retry is one
 * `core.initiatedWork.run` with the `pipeline.transient-retry` system origin:
 * the ledger records which pause it resumes, which attempt it is, when it is
 * due and how many attempts each step had used, so a restart resumes an
 * accepted retry at its original time and a later pause keeps counting.
 * Which pauses are retried, the delay table, the per-step limit and what
 * stops a retry are unchanged.
 */

interface PipelineRetryPreferences {
  autoRetryTransientErrorsPipelines: boolean;
}

interface PipelineRetryEntry {
  lastEvent: ExecutionEvent;
  display?: PipelineTransientRetryState;
  attempts: Map<string, number>;
  scheduledReasonIds: string[];
  scheduledSignatures: string[];
  token: number;
  /** A retry run is recorded for this pause and has not finished. */
  pending: boolean;
  /** Starts the recorded run when it is due. */
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Ends the recorded run while it waits for its due time, giving back the
   * place it holds on the execution's target.
   */
  dropAccepted: (() => Promise<void>) | null;
}

export type TransientRetryEngine = Pick<
  InitiatedWorkEngine,
  | 'acceptOccurrence'
  | 'runAccepted'
  | 'cancelWhere'
  | 'liveRuns'
  | 'registerResumer'
  | 'whenRecovered'
  | 'waitForRun'
>;

export interface TransientErrorRetrySchedulerDependencies {
  emitEvent?: (event: ExecutionEvent) => void;
  resume: (
    request: ResumePipelineExecutionFromMainRequest,
  ) => Promise<ResumePipelineExecutionFromMainResult>;
  readPreferences: () => Promise<PipelineRetryPreferences>;
  engine: TransientRetryEngine;
  /** This execution's initiated-work runs, newest first. */
  listRetryRuns: (executionId: string) => Promise<OperationRecord[]>;
  /** The stored execution, for recovery after a restart. */
  readExecution: (executionId: string) => Promise<ExecutionState | null>;
  /**
   * This execution's resume and recovery controls, as core recorded them
   * before dispatching each: a retry's own carries its run's origin.
   */
  listExecutionControls: (executionId: string) => Promise<OperationRecord[]>;
  /** Stored executions paused now, for the startup re-arm. */
  listPausedExecutions: () => Promise<ExecutionState[]>;
  /** The app's window, for retries that start after a restart. */
  getWindow: () => BrowserWindow | null;
}

const SOURCE = INITIATED_WORK_PIPELINE_TRANSIENT_RETRY_SOURCE;
/** How core records an operation a restart interrupted. */
const INTERRUPTED_RUN_CODE = 'core.operation.interrupted';
const RETRY_CANCEL = {
  reason: 'The pending automatic retry no longer applies.',
  requestedBy: 'desktop-pipeline-transient-retry',
};
const retryEntries = new Map<string, PipelineRetryEntry>();
let initializedDependencies: TransientErrorRetrySchedulerDependencies | null =
  null;
let recovered: Promise<void> = Promise.resolve();
let tokenCounter = 0;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/*
 * Each execution's transitions run one at a time, in the order they arrive:
 * a pause, a terminal event, a manual resume, a due retry, recovery and the
 * startup re-arm. A step that waits (the preference read, the ledger write)
 * keeps its lane, so what it read still holds when it acts, and the entry's
 * token says which pause a step belongs to. Only the abort signal and the
 * resume itself act outside a lane; the resume calls back into this module.
 */
const lanes = new Map<string, Promise<void>>();

function inLane<T>(
  executionId: string,
  step: () => T | Promise<T>,
): Promise<T> {
  const prior = lanes.get(executionId);
  // An idle lane runs its step at once, so an event's effect is visible
  // before the caller broadcasts it.
  const result = prior
    ? prior.then(step)
    : new Promise<T>((resolve) => {
        resolve(step());
      });
  const settled = result.then(
    (): void => undefined,
    (): void => undefined,
  );
  lanes.set(executionId, settled);
  void settled.then((): void => {
    if (lanes.get(executionId) === settled) lanes.delete(executionId);
  });
  return result;
}

/*
 * An execution's epoch moves on when something supersedes its pause: a
 * terminal event, a manual resume or a pause for other reasons. It moves on
 * when that arrives, not when its step runs, so a step waiting in the lane
 * (or inside one, on a read) sees that it no longer applies and does
 * nothing.
 */
const epochs = new Map<string, number>();
/** The reasons a recovery or the startup re-arm is restoring, by execution. */
const restoring = new Map<string, readonly string[]>();

function epochOf(executionId: string): number {
  return epochs.get(executionId) ?? 0;
}

function supersede(executionId: string): number {
  const epoch = epochOf(executionId) + 1;
  epochs.set(executionId, epoch);
  return epoch;
}

function isCurrent(executionId: string, epoch: number): boolean {
  return epochOf(executionId) === epoch;
}

function nextToken(): number {
  tokenCounter += 1;
  return tokenCounter;
}

function targetKeyOf(executionId: string): string {
  return `pipeline-execution:${executionId}`;
}

function isRetryRun(origin: OperationOrigin): boolean {
  return origin.kind === 'system' && origin.sourceId === SOURCE;
}

function retryContextOf(
  origin: OperationOrigin,
): InitiatedWorkPipelineTransientRetryOriginContext | null {
  if (!isRetryRun(origin)) return null;
  const parsed =
    InitiatedWorkPipelineTransientRetryOriginContextSchema.safeParse(
      origin.context,
    );
  return parsed.success ? parsed.data : null;
}

function clearTimer(entry: PipelineRetryEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
}

function cancelRetryRun(entry: PipelineRetryEntry): void {
  const engine = initializedDependencies?.engine;
  if (!engine) return;
  const dropAccepted = entry.dropAccepted;
  entry.dropAccepted = null;
  const targetKey = targetKeyOf(entry.lastEvent.executionId);
  void (
    dropAccepted
      ? dropAccepted()
      : engine.cancelWhere(
          (run) => run.targetKey === targetKey && isRetryRun(run.origin),
          RETRY_CANCEL,
        )
  ).catch(() => undefined);
}

/**
 * Cancel a run that was accepted but not started, then hand it to the engine
 * so the place it reserved on its target is given back.
 */
async function dropAcceptedRun(
  engine: TransientRetryEngine,
  operationId: string,
  run: Pick<
    InitiatedWorkRequest<null>,
    'origin' | 'owner' | 'scope' | 'targetKey'
  >,
): Promise<void> {
  await engine.cancelWhere(
    (candidate) => candidate.operationId === operationId,
    RETRY_CANCEL,
  );
  await engine.runAccepted(operationId, {
    ...run,
    gates: [],
    execute: () => Promise.resolve(ended('stopped', Date.now())),
  });
}

export function withPipelineTransientRetryState(
  state: ExecutionState,
): ExecutionState {
  const display = retryEntries.get(state.id)?.display;
  return state.transient_retry === display
    ? state
    : { ...state, transient_retry: display };
}

/**
 * When a retry's run ends cancelled (through core, or before it resumed), its
 * pause keeps the recorded retry, so it is not scheduled again, but the
 * countdown goes.
 */
function clearCountdownWhenCancelled(
  executionId: string,
  token: number,
  operationId: string,
): void {
  const engine = initializedDependencies?.engine;
  if (!engine) return;
  void engine
    .waitForRun(operationId)
    .then(({ status }) =>
      inLane(executionId, (): void => {
        const current = retryEntries.get(executionId);
        if (status !== 'cancelled' || current?.token !== token) return;
        if (!current.display) return;
        current.display = undefined;
        emitRetryState(current);
      }),
    )
    .catch(() => undefined);
}

function emitRetryState(entry: PipelineRetryEntry): void {
  initializedDependencies?.emitEvent?.({
    ...entry.lastEvent,
    type: 'execution.updated',
    state: withPipelineTransientRetryState(entry.lastEvent.state),
    timestamp: new Date().toISOString(),
  });
}

function deleteEntry(
  executionId: string,
  options: { cancelRun: boolean } = { cancelRun: true },
): void {
  const entry = retryEntries.get(executionId);
  retryEntries.delete(executionId);
  if (entry) clearTimer(entry);
  if (entry?.pending && options.cancelRun) cancelRetryRun(entry);
  if (entry) emitRetryState(entry);
}

function isTerminalEvent(event: ExecutionEvent): boolean {
  return (
    event.type === 'execution.completed' ||
    event.type === 'execution.failed' ||
    event.type === 'execution.cancelled' ||
    event.state.status === 'success' ||
    event.state.status === 'failure' ||
    event.state.status === 'cancelled'
  );
}

type StatusReason = ExecutionEvent['state']['status_reasons'][number];

function transientReasonSignature(reason: StatusReason): string {
  return `${reason.source.job_id}\0${reason.source.step_id}`;
}

function transientStepSignature(reasons: readonly StatusReason[]): string[] {
  return Array.from(new Set(reasons.map(transientReasonSignature))).sort();
}

function transientReasonsOf(state: ExecutionState): StatusReason[] {
  return state.status_reasons.filter(
    (reason) =>
      reason.kind === 'provider_temporarily_unavailable' &&
      UUID_PATTERN.test(reason.id),
  );
}

function isTerminalStatus(status: string | undefined): boolean {
  return (
    status === 'success' ||
    status === 'failure' ||
    status === 'cancelled' ||
    status === 'skipped'
  );
}

function pruneTerminalAttemptHistory(
  attempts: Map<string, number>,
  state: ExecutionState,
): void {
  for (const signature of Array.from(attempts.keys())) {
    const [jobId] = signature.split('\0');
    const job = jobId ? state.jobs[jobId] : undefined;
    if (isTerminalStatus(job?.status)) attempts.delete(signature);
  }
}

function clearScheduledBatch(entry: PipelineRetryEntry): void {
  clearTimer(entry);
  if (entry.pending) cancelRetryRun(entry);
  entry.pending = false;
  entry.scheduledReasonIds = [];
  entry.scheduledSignatures = [];
  entry.display = undefined;
  entry.token = nextToken();
  emitRetryState(entry);
}

type StepAttempts =
  InitiatedWorkPipelineTransientRetryOriginContext['stepAttempts'];

/** The most steps a retry's context records; the resume takes 256 reasons. */
const MAX_RECORDED_STEPS = 256;

/** A step's identity in a retry's context, a fixed size however long its IDs. */
function stepDigest(signature: string): string {
  return createHash('sha256').update(signature).digest('hex').slice(0, 16);
}

/**
 * The steps this retry resumes first, then the others with the most attempts
 * used, up to the context's limit.
 */
function stepAttemptsOf(
  attempts: Map<string, number>,
  scheduledSignatures: readonly string[],
): StepAttempts {
  const scheduled = new Set(scheduledSignatures);
  return Array.from(new Set([...scheduledSignatures, ...attempts.keys()]))
    .map((signature) => ({
      signature,
      used: attempts.get(signature) ?? 0,
      scheduled: scheduled.has(signature),
    }))
    .sort(
      (a, b) =>
        Number(b.scheduled) - Number(a.scheduled) ||
        b.used - a.used ||
        a.signature.localeCompare(b.signature),
    )
    .slice(0, MAX_RECORDED_STEPS)
    .map(({ signature, used, scheduled: isScheduled }) => ({
      step: stepDigest(signature),
      used,
      scheduled: isScheduled,
    }));
}

/** The execution's steps by digest: its paused steps and every job's steps. */
function stepsByDigest(state: ExecutionState): Map<string, string> {
  const steps = new Map<string, string>();
  const add = (jobId: string, stepId: string): void => {
    const signature = `${jobId}\0${stepId}`;
    steps.set(stepDigest(signature), signature);
  };
  for (const reason of state.status_reasons)
    add(reason.source.job_id, reason.source.step_id);
  for (const [jobId, job] of Object.entries(state.jobs))
    for (const stepId of Object.keys(job.steps)) add(jobId, stepId);
  return steps;
}

function scopeOf(state: ExecutionState): CanopyWorkspaceScope {
  return {
    executionId: state.id,
    ...(state.project_id ? { workspaceId: state.project_id } : {}),
    ...(state.worktree_id ? { worktreeId: state.worktree_id } : {}),
  };
}

function waitUntil(time: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const dueTimer = setTimeout(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      Math.max(0, time - Date.now()),
    );
    const abort = (): void => {
      clearTimeout(dueTimer);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function ended(
  status: InitiatedWorkRunResult['status'],
  startedAt: number,
): InitiatedWorkExecution<null> {
  return {
    value: null,
    result: {
      status,
      exitCode: status === 'succeeded' ? 0 : null,
      durationMs: Math.max(0, Date.now() - startedAt),
    },
  };
}

/**
 * One retry's work: resume the pause. A run recovered after a restart first
 * waits out what is left of its delay.
 */
async function runRetry(
  executionId: string,
  token: number,
  origin: OperationOrigin,
  control: InitiatedWorkRunControl,
  getWindow: () => BrowserWindow | null,
  dueAt?: number,
): Promise<InitiatedWorkExecution<null>> {
  const startedAt = Date.now();
  if (dueAt !== undefined) {
    try {
      await waitUntil(dueAt, control.signal);
    } catch {
      return ended('stopped', startedAt);
    }
  }
  const dependencies = initializedDependencies;
  if (!dependencies) return ended('stopped', startedAt);
  type Decision =
    | { go: false; status: InitiatedWorkRunResult['status'] }
    | { go: true; statusReasonIds: string[] };
  const epoch = epochOf(executionId);
  const decision = await inLane(executionId, async (): Promise<Decision> => {
    const entry = retryEntries.get(executionId);
    if (!entry || entry.token !== token || !isCurrent(executionId, epoch))
      return { go: false, status: 'stopped' };
    let preferences: PipelineRetryPreferences;
    try {
      preferences = await dependencies.readPreferences();
    } catch {
      deleteEntry(executionId, { cancelRun: false });
      return { go: false, status: 'failed' };
    }
    if (control.signal.aborted || !isCurrent(executionId, epoch))
      return { go: false, status: 'stopped' };
    if (!preferences.autoRetryTransientErrorsPipelines) {
      deleteEntry(executionId, { cancelRun: false });
      return { go: false, status: 'stopped' };
    }
    const signatures = [...entry.scheduledSignatures];
    if (signatures.length === 0) return { go: false, status: 'stopped' };
    for (const signature of signatures)
      entry.attempts.set(signature, (entry.attempts.get(signature) ?? 0) + 1);
    if (entry.display) {
      entry.display = { ...entry.display, nextRetryAt: null };
      emitRetryState(entry);
    }
    control.recordArtifact({ kind: 'pipelineExecution', id: executionId });
    return { go: true, statusReasonIds: [...entry.scheduledReasonIds] };
  });
  if (!decision.go) return ended(decision.status, startedAt);
  let result: ResumePipelineExecutionFromMainResult;
  try {
    result = await dependencies.resume({
      executionId,
      statusReasonIds: decision.statusReasonIds,
      allowStaleNoop: true,
      initiationSource: 'automation',
      origin,
      transientRetryOwnToken: token,
      getWindow,
    });
  } catch {
    await inLane(executionId, () => {
      if (retryEntries.get(executionId)?.token === token)
        deleteEntry(executionId, { cancelRun: false });
    });
    return ended('failed', startedAt);
  }
  return inLane(executionId, () => {
    const current = retryEntries.get(executionId);
    if (current?.token !== token) return ended('succeeded', startedAt);
    current.pending = false;
    if (result.status === 'stale-noop') {
      deleteEntry(executionId, { cancelRun: false });
      return ended('stopped', startedAt);
    }
    return ended('succeeded', startedAt);
  });
}

interface RetryPlan {
  attempt: number;
  notBefore: number;
  priorAttempts: Map<string, number>;
  /** Distinguishes a re-armed retry from an earlier run for the same pause. */
  occurrenceSuffix?: string;
}

/**
 * Record the retry as accepted, not started, then start it when it is due,
 * so a restart before then finds it queued and resumes it.
 */
async function submitRetry(
  entry: PipelineRetryEntry,
  token: number,
  epoch: number,
  plan: RetryPlan,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const dependencies = initializedDependencies;
  if (!dependencies) return;
  const { state, executionId } = entry.lastEvent;
  const statusReasonIds = [...entry.scheduledReasonIds];
  const context: InitiatedWorkPipelineTransientRetryOriginContext = {
    executionId,
    statusReasonIds,
    attempt: plan.attempt,
    notBefore: new Date(plan.notBefore).toISOString(),
    stepAttempts: stepAttemptsOf(plan.priorAttempts, entry.scheduledSignatures),
  };
  // A digest of the pause's reasons keeps the key within the ID limit however
  // many reasons the pause has.
  const reasonsDigest = createHash('sha256')
    .update([...statusReasonIds].sort().join(','))
    .digest('hex');
  const occurrence = `${executionId}:${reasonsDigest}`;
  const origin: OperationOrigin = {
    kind: 'system',
    sourceId: SOURCE,
    occurrenceKey: plan.occurrenceSuffix
      ? `${occurrence}:${plan.occurrenceSuffix}`
      : occurrence,
    context,
  };
  const run = {
    origin,
    owner: pipelineExecutionOwnerOf(state.execution_context),
    scope: scopeOf(state),
    targetKey: targetKeyOf(executionId),
  };
  const abandon = (): void => {
    if (retryEntries.get(executionId)?.token === token)
      deleteEntry(executionId, { cancelRun: false });
  };
  entry.pending = true;
  try {
    const [acceptance] = await dependencies.engine.acceptOccurrence({
      runs: [run],
    });
    if (acceptance?.status !== 'accepted') {
      abandon();
      return;
    }
    const live = retryEntries.get(executionId);
    if (live?.token !== token || !isCurrent(executionId, epoch)) {
      if (live?.token === token) live.pending = false;
      await dropAcceptedRun(dependencies.engine, acceptance.operationId, run);
      return;
    }
    clearCountdownWhenCancelled(executionId, token, acceptance.operationId);
    live.dropAccepted = (): Promise<void> =>
      dropAcceptedRun(dependencies.engine, acceptance.operationId, run);
    live.timer = setTimeout(
      () => {
        live.timer = null;
        live.dropAccepted = null;
        void dependencies.engine
          .runAccepted(acceptance.operationId, {
            ...run,
            gates: [],
            execute: (control) =>
              runRetry(executionId, token, origin, control, getWindow),
          })
          .catch(() => inLane(executionId, abandon));
      },
      Math.max(0, plan.notBefore - Date.now()),
    );
  } catch {
    abandon();
  }
}

/**
 * Schedule the pause's retry from the attempts its steps have used: read the
 * preference, then record the run with its due time.
 */
async function scheduleRetry(
  executionId: string,
  token: number,
  epoch: number,
  getWindow: () => BrowserWindow | null,
  occurrenceSuffix?: string,
): Promise<void> {
  const dependencies = initializedDependencies;
  if (!dependencies) return;
  try {
    const preferences = await dependencies.readPreferences();
    const liveEntry = retryEntries.get(executionId);
    if (!liveEntry || liveEntry.token !== token) return;
    if (!isCurrent(executionId, epoch)) return;
    if (!preferences.autoRetryTransientErrorsPipelines) {
      deleteEntry(executionId);
      return;
    }
    const attempt = Math.min(
      ...liveEntry.scheduledSignatures.map(
        (signature) => liveEntry.attempts.get(signature) ?? 0,
      ),
    );
    const delay = PIPELINE_TRANSIENT_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    const notBefore = Date.now() + delay;
    liveEntry.display = {
      attempt: attempt + 1,
      maxAttempts: PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
      nextRetryAt: notBefore,
      exhausted: false,
    };
    emitRetryState(liveEntry);
    await submitRetry(
      liveEntry,
      token,
      epoch,
      {
        attempt: attempt + 1,
        notBefore,
        priorAttempts: new Map(liveEntry.attempts),
        ...(occurrenceSuffix ? { occurrenceSuffix } : {}),
      },
      getWindow,
    );
  } catch {
    if (retryEntries.get(executionId)?.token === token)
      deleteEntry(executionId);
  }
}

function handlePaused(
  event: ExecutionEvent,
  epoch: number,
  getWindow: () => BrowserWindow | null,
  occurrenceSuffix?: string,
): Promise<void> | undefined {
  if (event.state.parent_execution_id) return;

  const transientReasons = transientReasonsOf(event.state);
  const existing = retryEntries.get(event.executionId);
  if (existing) pruneTerminalAttemptHistory(existing.attempts, event.state);
  if (transientReasons.length === 0) {
    if (existing) clearScheduledBatch(existing);
    return;
  }
  const entry: PipelineRetryEntry = existing ?? {
    lastEvent: event,
    attempts: new Map<string, number>(),
    scheduledReasonIds: [],
    scheduledSignatures: [],
    token: nextToken(),
    pending: false,
    timer: null,
    dropAccepted: null,
  };
  if (!existing) pruneTerminalAttemptHistory(entry.attempts, event.state);
  const scheduledReasons = transientReasons.filter(
    (reason) =>
      (entry.attempts.get(transientReasonSignature(reason)) ?? 0) <
      PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
  );
  const scheduledReasonIds = Array.from(
    new Set(scheduledReasons.map((reason) => reason.id)),
  );
  // The same pause seen again keeps the retry already recorded for it.
  if (
    existing?.pending &&
    scheduledReasonIds.length > 0 &&
    scheduledReasonIds.join() === existing.scheduledReasonIds.join()
  )
    return;
  clearTimer(entry);
  if (existing?.pending) cancelRetryRun(existing);
  entry.pending = false;
  const token = nextToken();
  entry.scheduledReasonIds = scheduledReasonIds;
  entry.scheduledSignatures = transientStepSignature(scheduledReasons);
  entry.token = token;
  retryEntries.set(event.executionId, entry);
  if (entry.scheduledSignatures.length === 0) {
    entry.display = {
      attempt: PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
      maxAttempts: PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
      nextRetryAt: null,
      exhausted: true,
    };
    emitRetryState(entry);
    return;
  }
  return scheduleRetry(
    event.executionId,
    token,
    epoch,
    getWindow,
    occurrenceSuffix,
  );
}

function pausedOn(
  state: ExecutionState | null,
  statusReasonIds: readonly string[],
): state is ExecutionState {
  if (state?.status !== 'paused') return false;
  const transient = new Set(transientReasonsOf(state).map((r) => r.id));
  return statusReasonIds.every((id) => transient.has(id));
}

function sameReasons(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join() === [...b].sort().join();
}

function pausedEventOf(state: ExecutionState): ExecutionEvent {
  return {
    executionId: state.id,
    type: 'execution.paused',
    state,
    timestamp: new Date().toISOString(),
  };
}

/** Restart recovery for this source's runs: resume, reconcile or end. */
function createResumer(): InitiatedWorkResumer<null> {
  return {
    targetKey: (operation) =>
      targetKeyOf(
        retryContextOf(operation.origin)?.executionId ?? operation.operationId,
      ),
    resume: async (operation): Promise<InitiatedWorkResumption<null>> => {
      const dependencies = initializedDependencies;
      const context = retryContextOf(operation.origin);
      if (!dependencies || !context)
        return { status: 'invalidated', message: 'Unknown retry run.' };
      const executionId = context.executionId;
      const epoch = epochOf(executionId);
      restoring.set(executionId, context.statusReasonIds);
      return inLane(executionId, () =>
        recoverRetry(dependencies, operation, context, epoch),
      ).finally(() => {
        if (restoring.get(executionId) === context.statusReasonIds)
          restoring.delete(executionId);
      });
    },
    reconcile: async (operation): Promise<OperationRecovery> => {
      const context = retryContextOf(operation.origin);
      const dependencies = initializedDependencies;
      if (!context || !dependencies) return { status: 'lost' };
      const state = await dependencies.readExecution(context.executionId);
      if (pausedOn(state, context.statusReasonIds)) return { status: 'lost' };
      // A resume that went ahead moved the execution off these reasons, so
      // the run records the execution and a later pause counts its attempt.
      const outcome: InitiatedWorkRunRecord = {
        disposition: 'ran',
        gates: [],
        artifacts: [{ kind: 'pipelineExecution', id: context.executionId }],
        result: null,
      };
      return { status: 'completed', outcome };
    },
  };
}

/**
 * Recover a queued retry in its execution's lane: end it when the execution
 * moved on, the preference is off or a newer pause has its own retry;
 * otherwise restore its entry and resume it once it is due.
 */
async function recoverRetry(
  dependencies: TransientErrorRetrySchedulerDependencies,
  operation: OperationRecord,
  context: InitiatedWorkPipelineTransientRetryOriginContext,
  epoch: number,
): Promise<InitiatedWorkResumption<null>> {
  const superseded: InitiatedWorkResumption<null> = {
    status: 'invalidated',
    message: 'The execution changed while its retry was recovered.',
  };
  if (!isCurrent(context.executionId, epoch)) return superseded;
  const state = await dependencies.readExecution(context.executionId);
  if (!isCurrent(context.executionId, epoch)) return superseded;
  if (!pausedOn(state, context.statusReasonIds))
    return {
      status: 'invalidated',
      message: 'The execution is no longer paused for this retry.',
    };
  const preferences = await dependencies.readPreferences();
  if (!isCurrent(context.executionId, epoch)) return superseded;
  if (!preferences.autoRetryTransientErrorsPipelines)
    return {
      status: 'invalidated',
      message: 'Automatic retries are off.',
    };
  const steps = stepsByDigest(state);
  const scheduledSignatures: string[] = [];
  for (const step of context.stepAttempts) {
    if (!step.scheduled) continue;
    const signature = steps.get(step.step);
    if (signature === undefined)
      return {
        status: 'invalidated',
        message: 'The execution no longer has the steps this retry resumes.',
      };
    scheduledSignatures.push(signature);
  }
  // A pause seen while recovery ran has its own retry; leave it in place.
  const current = retryEntries.get(context.executionId);
  if (
    current &&
    !sameReasons(current.scheduledReasonIds, context.statusReasonIds)
  )
    return {
      status: 'invalidated',
      message: 'A newer pause has its own retry.',
    };
  const token = nextToken();
  const entry: PipelineRetryEntry = {
    lastEvent: pausedEventOf(state),
    // A restart resets the attempt count, as it does on develop.
    attempts: new Map<string, number>(),
    scheduledReasonIds: [...context.statusReasonIds],
    scheduledSignatures,
    token,
    pending: true,
    timer: null,
    dropAccepted: null,
    display: {
      attempt: 1,
      maxAttempts: PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
      nextRetryAt: Date.parse(context.notBefore),
      exhausted: false,
    },
  };
  retryEntries.set(context.executionId, entry);
  emitRetryState(entry);
  clearCountdownWhenCancelled(
    context.executionId,
    token,
    operation.operationId,
  );
  return {
    status: 'resume',
    request: {
      gates: [],
      execute: (control) =>
        runRetry(
          context.executionId,
          token,
          operation.origin,
          control,
          dependencies.getWindow,
          Date.parse(context.notBefore),
        ),
    },
  };
}

/** The execution's latest retry run. */
async function latestRetryRun(
  executionId: string,
): Promise<OperationRecord | null> {
  const dependencies = initializedDependencies;
  if (!dependencies) return null;
  const runs = await dependencies.listRetryRuns(executionId);
  return (
    runs.find(
      (operation) =>
        retryContextOf(operation.origin)?.executionId === executionId,
    ) ?? null
  );
}

/**
 * Startup: schedule a retry for each paused execution that has none, from
 * attempt 1, as develop does after a restart. A pause whose latest retry was
 * cancelled stays without one.
 */
async function rearm(): Promise<void> {
  const dependencies = initializedDependencies;
  if (!dependencies) return;
  await dependencies.engine.whenRecovered();
  const live = new Set(
    dependencies.engine
      .liveRuns()
      .filter((run) => isRetryRun(run.origin))
      .map((run) => run.targetKey),
  );
  // The epochs the scan's snapshots belong to: anything that supersedes an
  // execution while the scan runs, or while an earlier execution is
  // re-armed, leaves its snapshot stale, so it is skipped.
  const scannedEpochs = new Map(epochs);
  for (const state of await dependencies.listPausedExecutions()) {
    if (state.parent_execution_id || state.status !== 'paused') continue;
    if (transientReasonsOf(state).length === 0) continue;
    const epoch = scannedEpochs.get(state.id) ?? 0;
    const reasons = transientReasonsOf(state).map((reason) => reason.id);
    restoring.set(state.id, reasons);
    await inLane(state.id, () =>
      rearmExecution(dependencies, state, live, epoch),
    ).finally(() => {
      if (restoring.get(state.id) === reasons) restoring.delete(state.id);
    });
  }
}

/**
 * Whether a retry run's resume began: core records the resume, with the
 * run's own origin and occurrence, before it dispatches it.
 */
async function resumeBegan(
  dependencies: TransientErrorRetrySchedulerDependencies,
  executionId: string,
  run: OperationRecord,
): Promise<boolean> {
  const controls = await dependencies.listExecutionControls(executionId);
  return controls.some(
    (control) =>
      isRetryRun(control.origin) &&
      control.origin.occurrenceKey === run.origin.occurrenceKey,
  );
}

/** The startup re-arm for one paused execution, in its lane. */
async function rearmExecution(
  dependencies: TransientErrorRetrySchedulerDependencies,
  state: ExecutionState,
  live: ReadonlySet<string>,
  epoch: number,
): Promise<void> {
  if (!isCurrent(state.id, epoch)) return;
  if (retryEntries.has(state.id) || live.has(targetKeyOf(state.id))) return;
  const latest = await latestRetryRun(state.id);
  if (!isCurrent(state.id, epoch)) return;
  const context = latest ? retryContextOf(latest.origin) : null;
  // The latest retry, when it was for the pause the execution is in now.
  const samePause =
    latest &&
    context?.statusReasonIds.every((id) =>
      state.status_reasons.some((reason) => reason.id === id),
    )
      ? latest
      : null;
  // A cancelled retry stays cancelled for the pause it was for.
  if (samePause?.status === 'cancelled') return;
  // A retry a restart interrupted after its resume began may be what stopped
  // the app, so its pause is not tried again: develop never retries after a
  // restart. One interrupted before its resume began (while it waited out
  // its delay, or in recovery) is re-armed.
  if (
    samePause?.status === 'failed' &&
    samePause.error?.code === INTERRUPTED_RUN_CODE &&
    (await resumeBegan(dependencies, state.id, samePause))
  )
    return;
  if (!isCurrent(state.id, epoch)) return;
  // A new retry for the same pause needs its own occurrence.
  await handlePaused(
    pausedEventOf(state),
    epoch,
    dependencies.getWindow,
    samePause ? `after-${samePause.operationId}` : undefined,
  );
}

export function initTransientErrorRetryScheduler(
  dependencies: TransientErrorRetrySchedulerDependencies,
): void {
  initializedDependencies = dependencies;
  dependencies.engine.registerResumer('system', createResumer(), {
    sourceId: SOURCE,
  });
  recovered = rearm().catch(() => undefined);
}

/** Resolves once restart recovery and the startup re-arm have run. */
export function whenTransientRetryRecovered(): Promise<void> {
  return recovered;
}

export function notePipelineExecutionEvent(
  event: ExecutionEvent,
  getWindow: () => BrowserWindow | null,
): void {
  if (!initializedDependencies) return;
  const epoch = supersedes(event)
    ? supersede(event.executionId)
    : epochOf(event.executionId);
  void inLane(event.executionId, () => {
    const existing = retryEntries.get(event.executionId);
    if (existing) existing.lastEvent = event;
    // An ending clears the retry in lane order, whatever arrived after it.
    if (isTerminalEvent(event)) {
      deleteEntry(event.executionId);
      return undefined;
    }
    if (!isCurrent(event.executionId, epoch)) return undefined;
    return event.type === 'execution.paused'
      ? handlePaused(event, epoch, getWindow)
      : undefined;
  }).catch(() => undefined);
}

/**
 * Whether an event supersedes the pause being retried or restored: a
 * terminal event or a pause for other reasons does; the same pause seen
 * again does not.
 */
function supersedes(event: ExecutionEvent): boolean {
  if (isTerminalEvent(event)) return true;
  if (event.type !== 'execution.paused') return false;
  const entry = retryEntries.get(event.executionId);
  const current = entry?.pending
    ? entry.scheduledReasonIds
    : restoring.get(event.executionId);
  if (!current) return true;
  const scheduled = transientReasonsOf(event.state)
    .filter(
      (reason) =>
        (entry?.attempts.get(transientReasonSignature(reason)) ?? 0) <
        PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
    )
    .map((reason) => reason.id);
  return !sameReasons(Array.from(new Set(scheduled)), current);
}

export function cancelPendingTransientRetryTimer(
  executionId: string,
  ownToken?: number,
): void {
  // A retry's own resume does not cancel it; anything else supersedes it.
  const current = retryEntries.get(executionId);
  if (current && ownToken !== undefined && ownToken === current.token) return;
  supersede(executionId);
  // The reset runs in lane order even when a later pause has moved the epoch
  // on, so that pause starts from a fresh attempt count.
  void inLane(executionId, () => {
    const entry = retryEntries.get(executionId);
    if (!entry || ownToken === entry.token) return;
    deleteEntry(executionId);
  }).catch(() => undefined);
}

export function resetTransientErrorRetrySchedulerForTests(): void {
  retryEntries.clear();
  lanes.clear();
  epochs.clear();
  restoring.clear();
  initializedDependencies = null;
  recovered = Promise.resolve();
  tokenCounter = 0;
}
