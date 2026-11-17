// CAN-4175 capture golden: automatic retries of a pipeline paused because its
// provider was temporarily unavailable, pinned on unchanged code before the
// scheduler moves into the core lifecycle. It asserts what a person and the
// execution see: which pauses are retried, after how long, with which status
// reasons, how many times, what the countdown shows, and what stops a retry.
// It deliberately leaves out what CAN-4175 changes on purpose: the retry's
// origin and what happens across a restart.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PIPELINE_TRANSIENT_RETRY_DELAYS_MS,
  PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
} from '@canopy/execution-engine/agent-failures';
import {
  createInitialState,
  normalizePipeline,
} from '@canopy/execution-engine/node/pipelines/executor';
import type { ExecutionRuntime } from '@canopy/execution-engine/node/pipelines/executor/types';
import type {
  ExecutionEvent,
  ExecutionState,
  PipelineStatusReason,
  PipelineStatusReasonKind,
  PipelineTransientRetryState,
} from '@canopy/execution-engine/types/pipeline';
import {
  cancelPendingTransientRetryTimer,
  initTransientErrorRetryScheduler,
  notePipelineExecutionEvent,
  resetTransientErrorRetrySchedulerForTests,
} from '../transient-error-retry-scheduler';

const EXECUTION = 'execution-transient';
const START = Date.parse('2026-11-16T12:00:00.000Z');

const runtime: ExecutionRuntime = {
  isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
  isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
  executionsDir: join(tmpdir(), 'canopy-transient-retry-golden'),
  tempRootDir: tmpdir(),
  bundledActionsDir: tmpdir(),
  getProjectActionsDir: (repoPath: string): string => repoPath,
  getProjectPipelinesDir: (repoPath: string): string => repoPath,
};

interface ObservedResume {
  executionId: string;
  statusReasonIds: string[];
  allowStaleNoop: boolean | undefined;
  at: number;
}

interface Harness {
  resumes: ObservedResume[];
  /** The `transient_retry` of every execution update the scheduler sent. */
  shown: (PipelineTransientRetryState | undefined)[];
  preferences: { autoRetryTransientErrorsPipelines: boolean };
  resumeAnswer: 'started' | 'stale-noop' | 'throws';
}

let harness: Harness;
let reasonCounter = 0;

function reasonId(): string {
  reasonCounter += 1;
  return `00000000-0000-4000-8000-${String(reasonCounter).padStart(12, '0')}`;
}

function baseState(executionId = EXECUTION): ExecutionState {
  return createInitialState(
    normalizePipeline({
      name: 'Transient',
      on: 'dispatch',
      jobs: {
        build: { steps: [{ id: 'compile', run: 'echo build' }] },
        test: { steps: [{ id: 'unit', run: 'echo test' }] },
      },
    }),
    {
      cwd: tmpdir(),
      pipelineId: 'transient',
      runtime,
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    },
    executionId,
  );
}

function reason(
  jobId: string,
  stepId: string,
  options: { id?: string; kind?: PipelineStatusReasonKind } = {},
): PipelineStatusReason {
  return {
    id: options.id ?? reasonId(),
    kind: options.kind ?? 'provider_temporarily_unavailable',
    code: 'server_overloaded',
    detected_at: new Date(Date.now()).toISOString(),
    source: { job_id: jobId, step_id: stepId, attempt: 1, iteration: 0 },
  };
}

function event(
  type: ExecutionEvent['type'],
  mutate: (state: ExecutionState) => void = (): void => undefined,
  executionId = EXECUTION,
): ExecutionEvent {
  const state = baseState(executionId);
  mutate(state);
  return {
    executionId,
    type,
    state,
    timestamp: new Date(Date.now()).toISOString(),
  };
}

function paused(
  reasons: PipelineStatusReason[],
  mutate: (state: ExecutionState) => void = (): void => undefined,
  executionId = EXECUTION,
): ExecutionEvent {
  return event(
    'execution.paused',
    (state) => {
      state.status = 'paused';
      state.status_reasons = reasons;
      mutate(state);
    },
    executionId,
  );
}

/** Feed one execution event to the scheduler and let its async work settle. */
async function observe(next: ExecutionEvent): Promise<void> {
  notePipelineExecutionEvent(next, () => null);
  await jest.advanceTimersByTimeAsync(0);
}

async function elapse(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

function lastShown(): PipelineTransientRetryState | undefined {
  return harness.shown.at(-1);
}

beforeEach(() => {
  jest.useFakeTimers({ now: START });
  reasonCounter = 0;
  resetTransientErrorRetrySchedulerForTests();
  harness = {
    resumes: [],
    shown: [],
    preferences: { autoRetryTransientErrorsPipelines: true },
    resumeAnswer: 'started',
  };
  initTransientErrorRetryScheduler({
    emitEvent: (sent) => harness.shown.push(sent.state.transient_retry),
    readPreferences: () => Promise.resolve({ ...harness.preferences }),
    resume: (request) => {
      harness.resumes.push({
        executionId: request.executionId,
        statusReasonIds: [...(request.statusReasonIds ?? [])],
        allowStaleNoop: request.allowStaleNoop,
        at: Date.now(),
      });
      if (harness.resumeAnswer === 'throws')
        return Promise.reject(new Error('resume failed'));
      return Promise.resolve({
        status: harness.resumeAnswer,
        state: baseState(request.executionId),
      });
    },
  });
});

afterEach(() => {
  resetTransientErrorRetrySchedulerForTests();
  jest.useRealTimers();
});

describe('pipeline transient retries (CAN-4175 capture)', () => {
  it('retries a paused step after the first delay, with the pause reason, and shows the countdown', async () => {
    const first = reason('build', 'compile');
    await observe(paused([first]));

    expect(lastShown()).toEqual({
      attempt: 1,
      maxAttempts: PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
      nextRetryAt: START + PIPELINE_TRANSIENT_RETRY_DELAYS_MS[0],
      exhausted: false,
    });
    await elapse(PIPELINE_TRANSIENT_RETRY_DELAYS_MS[0] - 1);
    expect(harness.resumes).toEqual([]);

    await elapse(1);
    expect(harness.resumes).toEqual([
      {
        executionId: EXECUTION,
        statusReasonIds: [first.id],
        allowStaleNoop: true,
        at: START + PIPELINE_TRANSIENT_RETRY_DELAYS_MS[0],
      },
    ]);
    expect(lastShown()).toMatchObject({ attempt: 1, nextRetryAt: null });
  });

  it('backs off through the delay table, then stops and shows the retries as exhausted', async () => {
    expect(PIPELINE_TRANSIENT_RETRY_DELAYS_MS).toEqual([
      30_000, 30_000, 60_000, 60_000, 120_000, 120_000, 240_000, 240_000,
      480_000, 480_000,
    ]);
    const observedDelays: number[] = [];
    for (
      let attempt = 0;
      attempt < PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const pausedAt = Date.now();
      await observe(paused([reason('build', 'compile')]));
      expect(lastShown()).toMatchObject({
        attempt: attempt + 1,
        exhausted: false,
      });
      await elapse(PIPELINE_TRANSIENT_RETRY_DELAYS_MS[attempt]);
      expect(harness.resumes).toHaveLength(attempt + 1);
      observedDelays.push(harness.resumes[attempt].at - pausedAt);
    }
    expect(observedDelays).toEqual([...PIPELINE_TRANSIENT_RETRY_DELAYS_MS]);

    await observe(paused([reason('build', 'compile')]));
    expect(lastShown()).toEqual({
      attempt: PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
      maxAttempts: PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
      nextRetryAt: null,
      exhausted: true,
    });
    await elapse(60 * 60 * 1_000);
    expect(harness.resumes).toHaveLength(PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS);
  });

  it('counts attempts per step, and a step whose job finished starts counting again', async () => {
    await observe(paused([reason('build', 'compile')]));
    await elapse(PIPELINE_TRANSIENT_RETRY_DELAYS_MS[0]);
    await observe(paused([reason('build', 'compile')]));
    expect(lastShown()).toMatchObject({ attempt: 2 });
    await elapse(PIPELINE_TRANSIENT_RETRY_DELAYS_MS[1]);

    // Another step's first pause is its own first attempt.
    await observe(
      paused([reason('test', 'unit')], (state) => {
        state.jobs['build'].status = 'running';
      }),
    );
    expect(lastShown()).toMatchObject({ attempt: 1 });
    await elapse(PIPELINE_TRANSIENT_RETRY_DELAYS_MS[0]);

    // Once `build` finishes, a later pause of its step starts at attempt 1.
    await observe(
      paused([reason('build', 'compile')], (state) => {
        state.jobs['build'].status = 'success';
      }),
    );
    expect(lastShown()).toMatchObject({ attempt: 1 });
    await elapse(PIPELINE_TRANSIENT_RETRY_DELAYS_MS[0]);
    expect(harness.resumes).toHaveLength(4);
  });

  it('retries every temporarily unavailable step of one pause in a single resume', async () => {
    const build = reason('build', 'compile');
    const test = reason('test', 'unit');
    await observe(paused([build, test]));
    await elapse(PIPELINE_TRANSIENT_RETRY_DELAYS_MS[0]);

    expect(harness.resumes).toHaveLength(1);
    expect([...harness.resumes[0].statusReasonIds].sort()).toEqual(
      [build.id, test.id].sort(),
    );
  });

  it('leaves alone a child execution, a malformed reason id and any other pause reason', async () => {
    await observe(
      paused(
        [reason('build', 'compile')],
        (state) => {
          state.parent_execution_id = 'parent-execution';
        },
        'execution-child',
      ),
    );
    await observe(
      paused([reason('build', 'compile', { id: 'not-a-uuid' })], undefined),
    );
    await observe(
      paused(
        [reason('test', 'unit', { kind: 'provider_usage_limit' })],
        undefined,
        'execution-usage',
      ),
    );
    await elapse(60 * 60 * 1_000);

    expect(harness.resumes).toEqual([]);
    expect(harness.shown.filter((shown) => shown !== undefined)).toEqual([]);
  });

  it('does not retry while automatic retries are off, when paused or when due', async () => {
    harness.preferences.autoRetryTransientErrorsPipelines = false;
    await observe(paused([reason('build', 'compile')]));
    await elapse(60 * 60 * 1_000);
    expect(harness.resumes).toEqual([]);

    harness.preferences.autoRetryTransientErrorsPipelines = true;
    await observe(
      paused([reason('test', 'unit')], undefined, 'execution-turned-off'),
    );
    expect(lastShown()).toMatchObject({ attempt: 1, exhausted: false });
    harness.preferences.autoRetryTransientErrorsPipelines = false;
    await elapse(60 * 60 * 1_000);
    expect(harness.resumes).toEqual([]);
    expect(lastShown()).toBeUndefined();
  });

  it.each([
    ['completed', 'success'],
    ['failed', 'failure'],
    ['cancelled', 'cancelled'],
  ] as const)(
    'drops a pending retry once the execution is %s',
    async (type, status) => {
      await observe(paused([reason('build', 'compile')]));
      await elapse(PIPELINE_TRANSIENT_RETRY_DELAYS_MS[0] / 2);
      await observe(
        event(`execution.${type}`, (state) => {
          state.status = status;
        }),
      );
      await elapse(60 * 60 * 1_000);

      expect(harness.resumes).toEqual([]);
      expect(lastShown()).toBeUndefined();
    },
  );

  it('drops a pending retry when someone resumes the execution', async () => {
    await observe(paused([reason('build', 'compile')]));
    cancelPendingTransientRetryTimer(EXECUTION);
    await elapse(60 * 60 * 1_000);

    expect(harness.resumes).toEqual([]);
    expect(lastShown()).toBeUndefined();
  });

  it('drops a pending retry when the execution pauses again for another reason', async () => {
    await observe(paused([reason('build', 'compile')]));
    await observe(
      paused([reason('build', 'compile', { kind: 'input_required' })]),
    );
    await elapse(60 * 60 * 1_000);

    expect(harness.resumes).toEqual([]);
    expect(lastShown()).toBeUndefined();
  });

  it.each(['stale-noop', 'throws'] as const)(
    'retries a pause once when the resume answers %s',
    async (answer) => {
      harness.resumeAnswer = answer;
      await observe(paused([reason('build', 'compile')]));
      await elapse(60 * 60 * 1_000);

      expect(harness.resumes).toHaveLength(1);
      expect(lastShown()).toBeUndefined();
    },
  );
});
