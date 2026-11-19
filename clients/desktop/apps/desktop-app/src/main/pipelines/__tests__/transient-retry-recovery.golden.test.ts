// CAN-4175: a pipeline's automatic transient retry survives an app restart.
// Each scheduled retry is a `core.initiatedWork.run` with the
// `pipeline.transient-retry` system origin, recorded in a real operation
// ledger on disk that the test reopens to model a restart. Pins: a retry
// accepted before the restart resumes after it, once, at its original time; a
// recovered retry whose execution moved on ends without resuming; startup
// re-arms a paused execution that has no recorded retry, and after a restart
// the attempt count starts again from 1, as on develop; the resume carries the retry's own origin, with
// the old automation shape still available to readers that filter on it; a
// cancelled retry frees its execution and stays cancelled across a restart,
// including a cancellation during its preference read; a pause with many
// reasons still records its retry and recovers it after a restart; and every
// pair of transitions interleaves safely.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { PIPELINE_TRANSIENT_RETRY_DELAYS_MS } from '@canopy/execution-engine/agent-failures';
import {
  createInitialState,
  normalizePipeline,
} from '@canopy/execution-engine/node/pipelines/executor';
import type { ExecutionRuntime } from '@canopy/execution-engine/node/pipelines/executor/types';
import type {
  ExecutionEvent,
  ExecutionState,
  PipelineStatusReason,
} from '@canopy/execution-engine/types/pipeline';
import { InitiatedWorkEngine } from '@canopy/core-runtime/node/initiated-work';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  INITIATED_WORK_PIPELINE_TRANSIENT_RETRY_SOURCE,
  type OperationOrigin,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';
import type { DesktopCanopyDispatcher } from '../../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import { legacyPipelineResumeOrigin } from '../pipeline-worker-dispatch';
import {
  cancelPendingTransientRetryTimer,
  notePipelineExecutionEvent,
  PipelineTransientRetries,
  withPipelineTransientRetryState,
} from '../transient-error-retry-scheduler';

const EXECUTION = 'execution-restart';
/** What core records each resume of an execution as, before it dispatches. */
const PIPELINE_CONTROL_KIND = 'core.pipeline.control';
const START = Date.parse('2026-11-17T09:00:00.000Z');
const [FIRST_DELAY = 0, SECOND_DELAY = 0] = PIPELINE_TRANSIENT_RETRY_DELAYS_MS;

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

const runtime: ExecutionRuntime = {
  isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
  isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
  executionsDir: join(tmpdir(), 'canopy-transient-retry-recovery-golden'),
  tempRootDir: tmpdir(),
  bundledActionsDir: tmpdir(),
  getProjectActionsDir: (repoPath: string): string => repoPath,
  getProjectPipelinesDir: (repoPath: string): string => repoPath,
};

interface ObservedResume {
  executionId: string;
  statusReasonIds: string[];
  origin: OperationOrigin | undefined;
  at: number;
  getWindow: (() => BrowserWindow | null) | undefined;
}

/** The app's window getter, which every resume must carry. */
const mainWindow = (): BrowserWindow | null => null;

let dir: string;
let operations: OperationService;
let engine: InitiatedWorkEngine;
let scheduler: PipelineTransientRetries | null = null;
let resumes: ObservedResume[];
/** What the stored execution looks like to recovery and to the re-arm pass. */
let stored: ExecutionState | null;
let reasonCounter = 0;
/** The resume never settles, as when the app exits while it runs. */
let resumeHangs = false;
/** Recovery's read of the stored execution fails this many more times. */
let readFailures = 0;
/** The preference read waits on this, so a test can act during it. */
let preferencesHold: Promise<void> = Promise.resolve();
/** Recording a retry in the ledger waits on this. */
let acceptHold: Promise<void> = Promise.resolve();
/** Reading an execution's retry history waits on this. */
let historyHold: Promise<void> = Promise.resolve();
/** The startup scan for paused executions waits on this, with its snapshot. */
let scanHold: Promise<void> = Promise.resolve();
/** Execution events the scheduler emitted. */
let emitted: ExecutionEvent[] = [];

/** The engine, with a seam that holds a retry while it is being recorded. */
class HeldEngine extends InitiatedWorkEngine {
  override acceptOccurrence(
    input: Parameters<InitiatedWorkEngine['acceptOccurrence']>[0],
  ): ReturnType<InitiatedWorkEngine['acceptOccurrence']> {
    return acceptHold.then(() => super.acceptOccurrence(input));
  }
}

/** A hold a test releases once it has acted during the held await. */
function hold(): { held: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

function reasonId(): string {
  reasonCounter += 1;
  return `00000000-0000-4000-8000-${String(reasonCounter).padStart(12, '0')}`;
}

function baseState(): ExecutionState {
  return createInitialState(
    normalizePipeline({
      name: 'Transient',
      on: 'dispatch',
      jobs: { build: { steps: [{ id: 'compile', run: 'echo build' }] } },
    }),
    {
      cwd: tmpdir(),
      pipelineId: 'transient',
      runtime,
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    },
    EXECUTION,
  );
}

function reason(
  id = reasonId(),
  step: { job_id: string; step_id: string } = {
    job_id: 'build',
    step_id: 'compile',
  },
): PipelineStatusReason {
  return {
    id,
    kind: 'provider_temporarily_unavailable',
    code: 'server_overloaded',
    detected_at: new Date(Date.now()).toISOString(),
    source: { ...step, attempt: 1, iteration: 0 },
  };
}

function pausedState(reasons: PipelineStatusReason[]): ExecutionState {
  const state = baseState();
  state.status = 'paused';
  state.status_reasons = reasons;
  return state;
}

function pausedEvent(reasons: PipelineStatusReason[]): ExecutionEvent {
  return {
    executionId: EXECUTION,
    type: 'execution.paused',
    state: pausedState(reasons),
    timestamp: new Date(Date.now()).toISOString(),
  };
}

function openEngine(): void {
  operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operations.sqlite'), {
        retryWindowMs: 1_000,
      }),
  });
  engine = new HeldEngine({
    operations,
    recoverableOrigins: [
      {
        kind: 'system',
        sourceId: INITIATED_WORK_PIPELINE_TRANSIENT_RETRY_SOURCE,
      },
    ],
  });
}

/** Forget the scheduler, as the process ending does. */
function resetScheduler(): void {
  scheduler?.resetForTests();
  scheduler = null;
  setDesktopCanopyRuntime(null);
}

function whenTransientRetryRecovered(): Promise<void> {
  return scheduler?.whenRecovered() ?? Promise.resolve();
}

function startScheduler(): void {
  scheduler = new PipelineTransientRetries(engine);
  setDesktopCanopyRuntime({
    pipelineTransientRetries: scheduler,
  } as unknown as DesktopCanopyDispatcher);
  scheduler.start({
    getWindow: mainWindow,
    listRetryRuns: (executionId) =>
      historyHold.then(() =>
        operations
          .list({
            scope: { executionId },
            kinds: ['core.initiatedWork.run'],
            limit: 50,
          })
          .then((page) => page.items),
      ),
    readPreferences: () =>
      preferencesHold.then(() => ({ autoRetryTransientErrorsPipelines: true })),
    readExecution: (executionId) => {
      if (readFailures > 0) {
        readFailures -= 1;
        return Promise.reject(new Error('The execution could not be read.'));
      }
      return Promise.resolve(
        stored && stored.id === executionId ? stored : null,
      );
    },
    listExecutionControls: (executionId) =>
      operations
        .list({
          scope: { executionId },
          kinds: [PIPELINE_CONTROL_KIND],
          limit: 50,
        })
        .then((page) => page.items),
    listPausedExecutions: () => {
      const snapshot = stored ? [stored] : [];
      return scanHold.then(() => snapshot);
    },
    emitEvent: (event) => {
      emitted.push(event);
    },
    resume: (request) => {
      resumes.push({
        executionId: request.executionId,
        statusReasonIds: [...(request.statusReasonIds ?? [])],
        origin: request.origin,
        at: Date.now(),
        getWindow: request.getWindow,
      });
      // Core records the resume as a control of the execution, with the
      // caller's origin, before it dispatches it.
      return operations
        .admit({
          kind: PIPELINE_CONTROL_KIND,
          status: 'running',
          origin: request.origin ?? {
            kind: 'client',
            sourceId: 'local-desktop-user',
          },
          owner: { kind: 'principal', id: 'local-desktop-user' },
          scope: { executionId: request.executionId },
        })
        .then(() =>
          resumeHangs
            ? new Promise<never>(() => undefined)
            : { status: 'started' as const, state: baseState() },
        );
    },
  });
}

async function restart(): Promise<void> {
  engine.stopStarting();
  resetScheduler();
  operations.close();
  openEngine();
  await operations.ready();
  startScheduler();
  await whenTransientRetryRecovered();
  await jest.advanceTimersByTimeAsync(0);
}

/** Restart without waiting for recovery, so a test can act during it. */
async function restartHeld(): Promise<void> {
  engine.stopStarting();
  resetScheduler();
  operations.close();
  openEngine();
  await operations.ready();
  startScheduler();
  await jest.advanceTimersByTimeAsync(0);
}

async function retryRuns(): Promise<OperationRecord[]> {
  const page = await operations.list({
    kinds: ['core.initiatedWork.run'],
    limit: 100,
  });
  return page.items
    .filter(
      (operation) =>
        operation.origin.kind === 'system' &&
        operation.origin.sourceId ===
          INITIATED_WORK_PIPELINE_TRANSIENT_RETRY_SOURCE,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function observe(next: ExecutionEvent): Promise<void> {
  notePipelineExecutionEvent(next, () => null);
  await jest.advanceTimersByTimeAsync(0);
}

beforeEach(async () => {
  jest.useFakeTimers({ now: START, doNotFake: ['nextTick', 'setImmediate'] });
  dir = mkdtempSync(join(tmpdir(), 'canopy-retry-recovery-'));
  resumes = [];
  stored = null;
  reasonCounter = 0;
  resumeHangs = false;
  readFailures = 0;
  preferencesHold = Promise.resolve();
  acceptHold = Promise.resolve();
  historyHold = Promise.resolve();
  scanHold = Promise.resolve();
  emitted = [];
  resetScheduler();
  openEngine();
  await operations.ready();
  startScheduler();
  await whenTransientRetryRecovered();
});

afterEach(() => {
  engine.stopStarting();
  resetScheduler();
  operations.close();
  rmSync(dir, { recursive: true, force: true });
  jest.useRealTimers();
});

describe('pipeline transient retries across a restart (CAN-4175)', () => {
  it('a retry accepted before a restart resumes after it, once, at its original time', async () => {
    const pause = [reason()];
    stored = pausedState(pause);
    await observe(pausedEvent(pause));

    const [accepted] = await retryRuns();
    expect(accepted?.origin).toMatchObject({
      kind: 'system',
      sourceId: INITIATED_WORK_PIPELINE_TRANSIENT_RETRY_SOURCE,
      context: {
        executionId: EXECUTION,
        statusReasonIds: [pause[0]?.id],
        attempt: 1,
        notBefore: new Date(START + FIRST_DELAY).toISOString(),
      },
    });

    await jest.advanceTimersByTimeAsync(10_000);
    expect(resumes).toEqual([]);
    await restart();

    await jest.advanceTimersByTimeAsync(FIRST_DELAY - 10_001);
    expect(resumes).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(resumes).toEqual([
      expect.objectContaining({
        executionId: EXECUTION,
        statusReasonIds: [pause[0]?.id],
        at: START + FIRST_DELAY,
      }),
    ]);
    const [recovered] = await retryRuns();
    expect(recovered?.operationId).toBe(accepted?.operationId);
    expect(
      (
        await operations.waitForTerminal(
          required(accepted, 'accepted run').operationId,
        )
      ).status,
    ).toBe('completed');
  });

  it('a recovered retry whose execution moved on ends without resuming', async () => {
    const pause = [reason()];
    stored = pausedState(pause);
    await observe(pausedEvent(pause));
    const [accepted] = await retryRuns();

    // While the app was down someone resumed it and it paused for a new reason.
    stored = pausedState([{ ...reason(), kind: 'input_required' }]);
    await restart();
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);

    expect(resumes).toEqual([]);
    const ended = await operations.waitForTerminal(
      required(accepted, 'accepted run').operationId,
    );
    expect(ended.status).toBe('failed');
    expect(ended.error?.code).toBe('core.initiatedWork.run.invalidated');
  });

  it('startup re-arms a paused execution that has no recorded retry, from attempt 1 as on develop', async () => {
    const first = [reason()];
    stored = pausedState(first);
    await observe(pausedEvent(first));
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes).toHaveLength(1);

    // The step paused again while the app was down: no event, no recorded run.
    const second = [reason()];
    stored = pausedState(second);
    await restart();

    const runs = await retryRuns();
    expect(runs).toHaveLength(2);
    const restartAt = START + FIRST_DELAY;
    expect(runs[1]?.origin).toMatchObject({
      context: {
        statusReasonIds: [second[0]?.id],
        attempt: 1,
        notBefore: new Date(restartAt + FIRST_DELAY).toISOString(),
      },
    });
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes).toHaveLength(2);
    expect(resumes[1]?.statusReasonIds).toEqual([second[0]?.id]);
  });

  it("the resume carries the retry's system origin, and readers that filter on the old shape still see an automation resume", async () => {
    const pause = [reason()];
    stored = pausedState(pause);
    await observe(pausedEvent(pause));
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);

    const origin = resumes[0]?.origin;
    expect(origin).toMatchObject({
      kind: 'system',
      sourceId: INITIATED_WORK_PIPELINE_TRANSIENT_RETRY_SOURCE,
    });
    expect(
      legacyPipelineResumeOrigin(required(origin, 'resume origin')),
    ).toEqual({
      kind: 'automation',
      sourceId: EXECUTION,
    });
    const client: OperationOrigin = { kind: 'client', sourceId: 'local' };
    expect(legacyPipelineResumeOrigin(client)).toBe(client);
  });

  it('a retry cancelled before it is due frees its execution for the next retry', async () => {
    const first = [reason()];
    stored = pausedState(first);
    await observe(pausedEvent(first));
    const [cancelled] = await retryRuns();

    // A manual resume drops the pending retry; the run then pauses again.
    cancelPendingTransientRetryTimer(EXECUTION);
    await jest.advanceTimersByTimeAsync(0);
    const second = [reason()];
    stored = pausedState(second);
    await observe(pausedEvent(second));

    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes).toEqual([
      expect.objectContaining({ statusReasonIds: [second[0]?.id] }),
    ]);
    expect(
      (
        await operations.waitForTerminal(
          required(cancelled, 'cancelled run').operationId,
        )
      ).status,
    ).toBe('cancelled');
  });

  it('a retry cancelled through core stays cancelled after a restart', async () => {
    const pause = [reason()];
    stored = pausedState(pause);
    await observe(pausedEvent(pause));
    const [accepted] = await retryRuns();
    const operationId = required(accepted, 'accepted run').operationId;

    await operations.cancel(operationId, {
      reason: 'Stop retrying.',
      requestedBy: 'local-desktop-user',
    });
    await jest.advanceTimersByTimeAsync(0);
    expect((await operations.waitForTerminal(operationId)).status).toBe(
      'cancelled',
    );
    await restart();
    await jest.advanceTimersByTimeAsync(FIRST_DELAY + SECOND_DELAY);

    expect(resumes).toEqual([]);
    expect(await retryRuns()).toHaveLength(1);
  });

  it('a pause with many transient reasons still records its retry and resumes it after a restart', async () => {
    const pause = Array.from({ length: 200 }, () => reason());
    stored = pausedState(pause);
    await observe(pausedEvent(pause));

    const [accepted] = await retryRuns();
    expect(accepted?.origin.occurrenceKey?.length).toBeLessThanOrEqual(512);
    await restart();
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.statusReasonIds).toHaveLength(200);
    expect(
      (
        await operations.waitForTerminal(
          required(accepted, 'accepted run').operationId,
        )
      ).status,
    ).toBe('completed');
  });

  it('a retry cancelled while it reads the preference does not resume', async () => {
    const pause = [reason()];
    stored = pausedState(pause);
    await observe(pausedEvent(pause));
    const [accepted] = await retryRuns();
    const operationId = required(accepted, 'accepted run').operationId;

    let release = (): void => undefined;
    preferencesHold = new Promise((resolve) => {
      release = resolve;
    });
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    await operations.cancel(operationId, {
      reason: 'Stop retrying.',
      requestedBy: 'local-desktop-user',
    });
    release();
    await jest.advanceTimersByTimeAsync(0);

    expect(resumes).toEqual([]);
    expect((await operations.waitForTerminal(operationId)).status).toBe(
      'cancelled',
    );
  });

  it('a retry that started before a restart is not run again, and the next pause starts from attempt 1', async () => {
    const first = [reason()];
    stored = pausedState(first);
    resumeHangs = true;
    await observe(pausedEvent(first));
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes).toHaveLength(1);

    // The resume went ahead, the step paused again, and the app exited.
    resumeHangs = false;
    const second = [reason()];
    stored = pausedState(second);
    await restart();

    const runs = await retryRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.status).toBe('completed');
    expect(resumes).toHaveLength(1);
    const restartAt = START + FIRST_DELAY;
    expect(runs[1]?.origin).toMatchObject({
      context: {
        statusReasonIds: [second[0]?.id],
        attempt: 1,
        notBefore: new Date(restartAt + FIRST_DELAY).toISOString(),
      },
    });
  });

  it('recovery leaves alone a newer retry that took over during its preference read', async () => {
    const first = [reason()];
    stored = pausedState(first);
    await observe(pausedEvent(first));
    const [recovering] = await retryRuns();

    let release = (): void => undefined;
    preferencesHold = new Promise((resolve) => {
      release = resolve;
    });
    engine.stopStarting();
    resetScheduler();
    operations.close();
    openEngine();
    await operations.ready();
    startScheduler();
    await jest.advanceTimersByTimeAsync(0);

    // A manual resume and a new pause arrive while recovery reads the preference.
    const second = [reason()];
    stored = pausedState(second);
    await observe(pausedEvent(second));
    release();
    await whenTransientRetryRecovered();
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);

    expect(resumes).toEqual([
      expect.objectContaining({ statusReasonIds: [second[0]?.id] }),
    ]);
    expect(
      (
        await operations.waitForTerminal(
          required(recovering, 'recovered run').operationId,
        )
      ).status,
    ).toBe('failed');
  });

  it("recovered and re-armed retries resume with the app's window", async () => {
    const first = [reason()];
    stored = pausedState(first);
    await observe(pausedEvent(first));
    await restart();
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);

    const second = [reason()];
    stored = pausedState(second);
    await restart();
    await jest.advanceTimersByTimeAsync(SECOND_DELAY);

    expect(resumes).toHaveLength(2);
    expect(resumes.map((resume) => resume.getWindow)).toEqual([
      mainWindow,
      mainWindow,
    ]);
  });

  type Hold = 'preferences' | 'accept' | 'history' | 'scan';
  interface Await {
    held: Hold;
    /** A retry is recorded for the first pause before the hold. */
    recorded: boolean;
    /** The held step runs after a restart. */
    restarts: boolean;
    reach: (first: PipelineStatusReason[]) => Promise<void>;
  }
  const awaits: Record<string, Await> = {
    "a scheduled retry's preference read": {
      held: 'preferences',
      recorded: false,
      restarts: false,
      reach: (first) => observe(pausedEvent(first)),
    },
    'a retry being recorded': {
      held: 'accept',
      recorded: false,
      restarts: false,
      reach: (first) => observe(pausedEvent(first)),
    },
    "a due retry's preference read": {
      held: 'preferences',
      recorded: true,
      restarts: false,
      reach: () => jest.advanceTimersByTimeAsync(FIRST_DELAY),
    },
    "recovery's preference read": {
      held: 'preferences',
      recorded: true,
      restarts: true,
      reach: restartHeld,
    },
    "the startup re-arm's paused-execution scan": {
      held: 'scan',
      recorded: false,
      restarts: true,
      reach: restartHeld,
    },
    "the startup re-arm's history read": {
      held: 'history',
      recorded: false,
      restarts: true,
      reach: restartHeld,
    },
    "the startup re-arm's preference read": {
      held: 'preferences',
      recorded: false,
      restarts: true,
      reach: restartHeld,
    },
  };
  const interleavings = Object.entries(awaits).flatMap(([during, step]) =>
    (['pause', 'manualResume', 'terminal'] as const).map((other) => ({
      name: `${
        other === 'pause'
          ? 'a new pause'
          : other === 'manualResume'
            ? 'a manual resume'
            : 'a terminal event'
      } during ${during}`,
      step,
      other,
    })),
  );

  it.each(interleavings)('$name', async ({ step, other }) => {
    const first = [reason()];
    stored = pausedState(first);
    if (step.recorded) await observe(pausedEvent(first));

    const gate = hold();
    if (step.held === 'preferences') preferencesHold = gate.held;
    else if (step.held === 'accept') acceptHold = gate.held;
    else if (step.held === 'history') historyHold = gate.held;
    else scanHold = gate.held;
    await step.reach(first);

    const second = [reason()];
    const before = emitted.length;
    if (other === 'pause') {
      stored = pausedState(second);
      await observe(pausedEvent(second));
    } else if (other === 'manualResume') {
      stored = { ...pausedState(first), status: 'running', status_reasons: [] };
      cancelPendingTransientRetryTimer(EXECUTION);
    } else {
      stored = { ...pausedState(first), status: 'success', status_reasons: [] };
      await observe({
        executionId: EXECUTION,
        type: 'execution.completed',
        state: stored,
        timestamp: new Date(Date.now()).toISOString(),
      });
    }
    gate.release();
    if (step.restarts) await whenTransientRetryRecovered();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(FIRST_DELAY + SECOND_DELAY);

    expect(resumes.map((resume) => resume.statusReasonIds)).toEqual(
      other === 'pause' ? [[second[0]?.id]] : [],
    );
    // Once it finished, nothing re-broadcasts the superseded pause.
    const firstIds = first.map((r) => r.id);
    if (other === 'terminal')
      expect(
        emitted
          .slice(before)
          .filter((event) =>
            event.state.status_reasons.some((r) => firstIds.includes(r.id)),
          )
          .filter((event) => event.state.status === 'paused'),
      ).toEqual([]);
    for (const run of await retryRuns())
      expect(['completed', 'cancelled', 'failed']).toContain(run.status);
  });

  it('the largest pause records its retry within the origin limit and resumes it after a restart', async () => {
    const longId = (prefix: string, n: number): string =>
      `${prefix}-${String(n).padStart(4, '0')}-${'x'.repeat(240)}`;
    const pause = Array.from({ length: 256 }, (_, n) =>
      reason(undefined, {
        job_id: longId('job', n),
        step_id: longId('step', n),
      }),
    );
    stored = pausedState(pause);
    await observe(pausedEvent(pause));

    const [accepted] = await retryRuns();
    expect(accepted).toBeDefined();
    expect(
      JSON.stringify(required(accepted, 'accepted run').origin.context).length,
    ).toBeLessThanOrEqual(32_768);
    await restart();
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.statusReasonIds).toHaveLength(256);
  });

  it('a recovered retry cancelled through core clears its countdown', async () => {
    const pause = [reason()];
    stored = pausedState(pause);
    await observe(pausedEvent(pause));
    const [accepted] = await retryRuns();
    await restart();
    expect(
      withPipelineTransientRetryState(pausedState(pause)).transient_retry,
    ).toMatchObject({ nextRetryAt: START + FIRST_DELAY });

    await operations.cancel(required(accepted, 'accepted run').operationId, {
      reason: 'Stop retrying.',
      requestedBy: 'local-desktop-user',
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(
      withPipelineTransientRetryState(pausedState(pause)).transient_retry,
    ).toBeUndefined();
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes).toEqual([]);
  });

  it('a manual resume resets the attempt count even when a new pause arrives before its cleanup runs', async () => {
    const first = [reason()];
    stored = pausedState(first);
    await observe(pausedEvent(first));
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes).toHaveLength(1);

    // The step paused again; its second retry is reading the preference.
    const gate = hold();
    preferencesHold = gate.held;
    const second = [reason()];
    stored = pausedState(second);
    await observe(pausedEvent(second));
    // Someone resumes it by hand, and it pauses again before anything runs.
    cancelPendingTransientRetryTimer(EXECUTION);
    const third = [reason()];
    stored = pausedState(third);
    await observe(pausedEvent(third));
    gate.release();
    await jest.advanceTimersByTimeAsync(0);

    const latest = (await retryRuns()).at(-1);
    expect(latest?.origin.context).toMatchObject({
      statusReasonIds: [third[0]?.id],
      attempt: 1,
    });
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes.map((resume) => resume.statusReasonIds)).toEqual([
      [first[0]?.id],
      [third[0]?.id],
    ]);
  });

  it('after a restart the attempt count starts again from 1, as on develop', async () => {
    // Two retries run in session, so the step's next retry would be attempt 3.
    for (let n = 0; n < 2; n += 1) {
      const pause = [reason()];
      stored = pausedState(pause);
      await observe(pausedEvent(pause));
      await jest.advanceTimersByTimeAsync(
        PIPELINE_TRANSIENT_RETRY_DELAYS_MS[n] ?? 0,
      );
    }
    expect(resumes).toHaveLength(2);
    const third = [reason()];
    stored = pausedState(third);
    await observe(pausedEvent(third));
    expect((await retryRuns()).at(-1)?.origin.context).toMatchObject({
      attempt: 3,
    });

    // The app restarts before it is due: the recovered retry still runs at
    // its due time, but counts as the first attempt.
    await restart();
    expect(
      withPipelineTransientRetryState(pausedState(third)).transient_retry,
    ).toMatchObject({ attempt: 1 });
    await jest.advanceTimersByTimeAsync(
      PIPELINE_TRANSIENT_RETRY_DELAYS_MS[2] ?? 0,
    );
    expect(resumes).toHaveLength(3);

    // The step pauses again in session: attempt 2, not 4.
    const fourth = [reason()];
    stored = pausedState(fourth);
    await observe(pausedEvent(fourth));
    expect((await retryRuns()).at(-1)?.origin.context).toMatchObject({
      statusReasonIds: [fourth[0]?.id],
      attempt: 2,
    });
  });

  it('a retry that crashed the app mid-resume is not retried for that pause again, across relaunches, as on develop', async () => {
    const pause = [reason()];
    stored = pausedState(pause);
    resumeHangs = true;
    await observe(pausedEvent(pause));
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes).toHaveLength(1);

    // The app dies during the resume and is relaunched twice; the execution
    // is still paused on the same reasons each time.
    for (let relaunch = 0; relaunch < 2; relaunch += 1) {
      await restart();
      await jest.advanceTimersByTimeAsync(FIRST_DELAY + SECOND_DELAY);
    }

    expect(resumes).toHaveLength(1);
    const runs = await retryRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error?.code).toBe('core.operation.interrupted');
    // The user sees develop's paused run: its reasons and a manual resume,
    // with no countdown (CAN-7084 adds the reason line).
    expect(
      withPipelineTransientRetryState(pausedState(pause)).transient_retry,
    ).toBeUndefined();
    // The same pause seen again in session stays without a retry.
    await observe(pausedEvent(pause));
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes).toHaveLength(1);
    // Resume run resumes it once: no automatic retry runs alongside.
    cancelPendingTransientRetryTimer(EXECUTION);
    stored = { ...pausedState(pause), status: 'running', status_reasons: [] };
    await jest.advanceTimersByTimeAsync(FIRST_DELAY + SECOND_DELAY);
    expect(resumes).toHaveLength(1);
  });

  it('a pause whose latest retry finished normally still re-arms after a relaunch', async () => {
    const first = [reason()];
    stored = pausedState(first);
    await observe(pausedEvent(first));
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(resumes).toHaveLength(1);
    expect((await retryRuns())[0]?.status).toBe('completed');

    const second = [reason()];
    stored = pausedState(second);
    await restart();
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);

    expect(resumes.map((resume) => resume.statusReasonIds)).toEqual([
      [first[0]?.id],
      [second[0]?.id],
    ]);
  });

  it('a recovered retry interrupted while it waited out its delay is re-armed, since its resume never began', async () => {
    const pause = [reason()];
    stored = pausedState(pause);
    await observe(pausedEvent(pause));
    await jest.advanceTimersByTimeAsync(5_000);
    // Recovered, then the app quits again while the retry waits for its due time.
    await restart();
    await jest.advanceTimersByTimeAsync(5_000);
    await restart();
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);

    expect(resumes.map((resume) => resume.statusReasonIds)).toEqual([
      [pause[0]?.id],
    ]);
  });

  it('a retry whose recovery failed is re-armed, since its resume never began', async () => {
    const pause = [reason()];
    stored = pausedState(pause);
    await observe(pausedEvent(pause));
    readFailures = 1;
    await restart();
    await jest.advanceTimersByTimeAsync(FIRST_DELAY);

    expect(resumes.map((resume) => resume.statusReasonIds)).toEqual([
      [pause[0]?.id],
    ]);
  });
});
