// CAN-4175 equivalence golden: what a person and the paused execution see from
// an automatic transient retry, on develop before the scheduler moved onto
// initiated work (7a7e0a89e83) and on the path it runs on now. Each row holds
// develop's outcome as a literal, from #9707's capture golden or, for the
// restart, origin and cancellation rows that the capture left out, from
// #9787's record of develop. A row may differ from develop only under a named
// deviation; every other row must match it exactly. The compared end state is
// each resume (how long after its pause, how many reasons) and what the
// execution shows afterwards; ledger records are not part of it.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
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
import * as schedulerModule from '../transient-error-retry-scheduler';
import {
  cancelPendingTransientRetryTimer,
  notePipelineExecutionEvent,
  PipelineTransientRetries,
  withPipelineTransientRetryState,
} from '../transient-error-retry-scheduler';

const EXECUTION = 'execution-equivalence';
const START = Date.parse('2026-11-19T09:00:00.000Z');
const HOUR = 60 * 60 * 1_000;
const [FIRST_DELAY = 0] = PIPELINE_TRANSIENT_RETRY_DELAYS_MS;
const CONTROL_KIND = 'core.pipeline.control';

const runtime: ExecutionRuntime = {
  isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
  isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
  executionsDir: join(tmpdir(), 'canopy-transient-retry-equivalence'),
  tempRootDir: tmpdir(),
  bundledActionsDir: tmpdir(),
  getProjectActionsDir: (repoPath: string): string => repoPath,
  getProjectPipelinesDir: (repoPath: string): string => repoPath,
};

type Shown =
  | 'nothing'
  | { attempt: number; exhausted: boolean; counting: boolean };

interface Outcome {
  /** Each resume: how long after its pause it came, and how many reasons. */
  resumes: { afterMs: number; reasons: number }[];
  /** The attempt the countdown showed at each pause, when the row tracks it. */
  attempts?: number[];
  /** What the execution shows once the row has run. */
  shown: Shown;
  /** The resume's origin, as readers that filter on it see it. */
  origin?: string;
}

const DEVIATIONS = {
  R1: 'A retry accepted before a restart resumes after it at its original due time (#9787, the ticket).',
  O2: 'The resume carries the pipeline.transient-retry system origin; legacy readers still see an automation resume (#9787).',
  C1: 'A waiting retry can be cancelled through core.operation.cancel (#9787).',
} as const;

type Verdict = 'equal' | keyof typeof DEVIATIONS;

interface Row {
  name: string;
  /** Develop's outcome. */
  develop: Outcome;
  verdict: Verdict;
  /** The outcome now, for a row under a named deviation. */
  now?: Outcome;
  run: () => Promise<Outcome>;
}

interface ObservedResume {
  statusReasonIds: string[];
  origin: OperationOrigin | undefined;
  at: number;
}

let dir: string;
let operations: OperationService;
let engine: InitiatedWorkEngine;
let resumes: ObservedResume[];
let stored: ExecutionState | null;
let retriesOn: boolean;
let resumeAnswer: 'started' | 'stale-noop' | 'throws';
let reasonCounter: number;

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
  jobId = 'build',
  stepId = 'compile',
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

function pausedState(
  reasons: PipelineStatusReason[],
  mutate: (state: ExecutionState) => void = (): void => undefined,
  executionId = EXECUTION,
): ExecutionState {
  const state = baseState(executionId);
  state.status = 'paused';
  state.status_reasons = reasons;
  mutate(state);
  return state;
}

function pausedEvent(
  reasons: PipelineStatusReason[],
  mutate?: (state: ExecutionState) => void,
  executionId = EXECUTION,
): ExecutionEvent {
  return {
    executionId,
    type: 'execution.paused',
    state: pausedState(reasons, mutate, executionId),
    timestamp: new Date(Date.now()).toISOString(),
  };
}

function endedEvent(
  type: 'completed' | 'failed' | 'cancelled',
  status: ExecutionState['status'],
): ExecutionEvent {
  const state = baseState();
  state.status = status;
  return {
    executionId: EXECUTION,
    type: `execution.${type}`,
    state,
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
  engine = new InitiatedWorkEngine({
    operations,
    recoverableOrigins: [
      {
        kind: 'system',
        sourceId: INITIATED_WORK_PIPELINE_TRANSIENT_RETRY_SOURCE,
      },
    ],
  });
}

function listOperations(
  executionId: string,
  kind: string,
): Promise<OperationRecord[]> {
  return operations
    .list({ scope: { executionId }, kinds: [kind], limit: 50 })
    .then((page) => page.items);
}

let scheduler: PipelineTransientRetries | null = null;

/* The runtime constructs the scheduler and main can reach it, not started. */
function createScheduler(): PipelineTransientRetries {
  scheduler = new PipelineTransientRetries(engine);
  setDesktopCanopyRuntime({
    pipelineTransientRetries: scheduler,
  } as unknown as DesktopCanopyDispatcher);
  return scheduler;
}

/* The scheduler as main starts it, and its test-only reset. */
function startScheduler(): void {
  (scheduler ?? createScheduler()).start({
    getWindow: () => null,
    listRetryRuns: (executionId) =>
      listOperations(executionId, 'core.initiatedWork.run'),
    listExecutionControls: (executionId) =>
      listOperations(executionId, CONTROL_KIND),
    readExecution: (executionId) =>
      Promise.resolve(stored && stored.id === executionId ? stored : null),
    listPausedExecutions: () => Promise.resolve(stored ? [stored] : []),
    readPreferences: () =>
      Promise.resolve({ autoRetryTransientErrorsPipelines: retriesOn }),
    resume: (request) => {
      resumes.push({
        statusReasonIds: [...(request.statusReasonIds ?? [])],
        origin: request.origin,
        at: Date.now(),
      });
      if (resumeAnswer === 'throws')
        return Promise.reject(new Error('resume failed'));
      return operations
        .admit({
          kind: CONTROL_KIND,
          status: 'running',
          origin: request.origin ?? {
            kind: 'client',
            sourceId: 'local-desktop-user',
          },
          owner: { kind: 'principal', id: 'local-desktop-user' },
          scope: { executionId: request.executionId },
        })
        .then(() => ({
          status: resumeAnswer === 'stale-noop' ? 'stale-noop' : 'started',
          state: baseState(request.executionId),
        }));
    },
  });
}

function resetScheduler(): void {
  scheduler?.resetForTests();
  scheduler = null;
  setDesktopCanopyRuntime(null);
}

function whenRecovered(): Promise<void> {
  return scheduler?.whenRecovered() ?? Promise.resolve();
}

/*
 * What quit does to the scheduler's runtime: the engine stops starting work,
 * then main clears the runtime accessor (index.ts, after the runtime's
 * shutdown).
 */
function quitRuntime(): void {
  engine.stopStarting();
  setDesktopCanopyRuntime(null);
}

/* A fresh launch: the runtime is up with its scheduler, not yet started. */
async function launch(): Promise<void> {
  engine.stopStarting();
  resetScheduler();
  operations.close();
  openEngine();
  await operations.ready();
  createScheduler();
}

async function restart(): Promise<void> {
  engine.stopStarting();
  resetScheduler();
  operations.close();
  openEngine();
  await operations.ready();
  startScheduler();
  await whenRecovered();
  await jest.advanceTimersByTimeAsync(0);
}

async function observe(next: ExecutionEvent): Promise<void> {
  notePipelineExecutionEvent(next, () => null);
  await jest.advanceTimersByTimeAsync(0);
}

async function elapse(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

function shown(): Shown {
  const retry = withPipelineTransientRetryState(baseState()).transient_retry;
  if (!retry) return 'nothing';
  return {
    attempt: retry.attempt,
    exhausted: retry.exhausted,
    counting: retry.nextRetryAt !== null,
  };
}

function attemptShown(): number {
  const now = shown();
  return now === 'nothing' ? 0 : now.attempt;
}

function resumesSince(pausedAt: number): Outcome['resumes'] {
  return resumes.map((resume) => ({
    afterMs: resume.at - pausedAt,
    reasons: resume.statusReasonIds.length,
  }));
}

/** One pause, the given steps, then the rest of the hour. */
async function onePause(
  before: () => void = (): void => undefined,
  during: () => Promise<void> = (): Promise<void> => Promise.resolve(),
): Promise<Outcome> {
  before();
  const pausedAt = Date.now();
  await observe(pausedEvent([reason()]));
  await during();
  await elapse(HOUR);
  return { resumes: resumesSince(pausedAt), shown: shown() };
}

const ONE_RESUME: Outcome['resumes'] = [{ afterMs: FIRST_DELAY, reasons: 1 }];
const RETRIED: Shown = { attempt: 1, exhausted: false, counting: false };

const ROWS: Row[] = [
  {
    name: 'a pause on an unavailable provider resumes once after the first delay, with its reason',
    develop: { resumes: ONE_RESUME, shown: RETRIED },
    verdict: 'equal',
    run: () => onePause(),
  },
  {
    name: 'repeated pauses back off through the delay table, then show the retries as exhausted',
    develop: {
      resumes: [
        30_000, 30_000, 60_000, 60_000, 120_000, 120_000, 240_000, 240_000,
        480_000, 480_000,
      ].map((afterMs) => ({ afterMs, reasons: 1 })),
      shown: {
        attempt: PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
        exhausted: true,
        counting: false,
      },
    },
    verdict: 'equal',
    run: async () => {
      const delays: Outcome['resumes'] = [];
      for (const delay of PIPELINE_TRANSIENT_RETRY_DELAYS_MS) {
        const pausedAt = Date.now();
        await observe(pausedEvent([reason()]));
        await elapse(delay);
        const latest = resumes.at(-1);
        if (latest)
          delays.push({
            afterMs: latest.at - pausedAt,
            reasons: latest.statusReasonIds.length,
          });
      }
      await observe(pausedEvent([reason()]));
      await elapse(HOUR);
      return { resumes: delays, shown: shown() };
    },
  },
  {
    name: 'attempts count per step, and a step whose job finished starts again at 1',
    develop: {
      resumes: [0, 1, 2, 3].map(() => ({ afterMs: FIRST_DELAY, reasons: 1 })),
      attempts: [1, 2, 1, 1],
      shown: RETRIED,
    },
    verdict: 'equal',
    run: async () => {
      const attempts: number[] = [];
      const pauseTimes: number[] = [];
      const steps: [() => ExecutionEvent, number][] = [
        [
          () => pausedEvent([reason()]),
          PIPELINE_TRANSIENT_RETRY_DELAYS_MS[0] ?? 0,
        ],
        [
          () => pausedEvent([reason()]),
          PIPELINE_TRANSIENT_RETRY_DELAYS_MS[1] ?? 0,
        ],
        [
          () =>
            pausedEvent([reason('test', 'unit')], (state) => {
              const build = state.jobs['build'];
              if (build) build.status = 'running';
            }),
          FIRST_DELAY,
        ],
        [
          () =>
            pausedEvent([reason()], (state) => {
              const build = state.jobs['build'];
              if (build) build.status = 'success';
            }),
          FIRST_DELAY,
        ],
      ];
      for (const [make, wait] of steps) {
        const next = make();
        pauseTimes.push(Date.now());
        await observe(next);
        attempts.push(attemptShown());
        await elapse(wait);
      }
      return {
        resumes: resumes.map((resume, index) => ({
          afterMs: resume.at - (pauseTimes[index] ?? 0),
          reasons: resume.statusReasonIds.length,
        })),
        attempts,
        shown: shown(),
      };
    },
  },
  {
    name: 'every unavailable step of one pause resumes in a single resume',
    develop: {
      resumes: [{ afterMs: FIRST_DELAY, reasons: 2 }],
      shown: RETRIED,
    },
    verdict: 'equal',
    run: async () => {
      const pausedAt = Date.now();
      await observe(pausedEvent([reason(), reason('test', 'unit')]));
      await elapse(HOUR);
      return { resumes: resumesSince(pausedAt), shown: shown() };
    },
  },
  {
    name: 'a child execution, a malformed reason id and any other pause reason are left alone',
    develop: { resumes: [], shown: 'nothing' },
    verdict: 'equal',
    run: async () => {
      const pausedAt = Date.now();
      await observe(
        pausedEvent(
          [reason()],
          (state) => {
            state.parent_execution_id = 'parent-execution';
          },
          'execution-child',
        ),
      );
      await observe(
        pausedEvent([reason('build', 'compile', { id: 'not-a-uuid' })]),
      );
      await observe(
        pausedEvent(
          [reason('test', 'unit', { kind: 'provider_usage_limit' })],
          undefined,
          'execution-usage',
        ),
      );
      await elapse(HOUR);
      return { resumes: resumesSince(pausedAt), shown: shown() };
    },
  },
  {
    name: 'nothing resumes while automatic retries are off at the pause',
    develop: { resumes: [], shown: 'nothing' },
    verdict: 'equal',
    run: () =>
      onePause(() => {
        retriesOn = false;
      }),
  },
  {
    name: 'nothing resumes when automatic retries are turned off before the retry is due',
    develop: { resumes: [], shown: 'nothing' },
    verdict: 'equal',
    run: () =>
      onePause(undefined, () => {
        retriesOn = false;
        return Promise.resolve();
      }),
  },
  ...(
    [
      ['completed', 'success'],
      ['failed', 'failure'],
      ['cancelled', 'cancelled'],
    ] as const
  ).map(
    ([type, status]): Row => ({
      name: `a waiting retry is dropped once the execution is ${type}`,
      develop: { resumes: [], shown: 'nothing' },
      verdict: 'equal',
      run: () =>
        onePause(undefined, async () => {
          await elapse(FIRST_DELAY / 2);
          await observe(endedEvent(type, status));
        }),
    }),
  ),
  {
    name: 'a waiting retry is dropped when someone resumes the execution',
    develop: { resumes: [], shown: 'nothing' },
    verdict: 'equal',
    run: () =>
      onePause(undefined, async () => {
        cancelPendingTransientRetryTimer(EXECUTION);
        await elapse(0);
      }),
  },
  {
    name: 'a waiting retry is dropped when the execution pauses again for another reason',
    develop: { resumes: [], shown: 'nothing' },
    verdict: 'equal',
    run: () =>
      onePause(undefined, () =>
        observe(
          pausedEvent([reason('build', 'compile', { kind: 'input_required' })]),
        ),
      ),
  },
  ...(['stale-noop', 'throws'] as const).map(
    (answer): Row => ({
      name: `a pause is retried once when the resume answers ${answer}`,
      develop: { resumes: ONE_RESUME, shown: 'nothing' },
      verdict: 'equal',
      run: () =>
        onePause(() => {
          resumeAnswer = answer;
        }),
    }),
  ),
  {
    name: 'a restart while a retry waits',
    // Develop lost the timer; the paused execution started again from
    // attempt 1, the first delay after the restart.
    develop: {
      resumes: [{ afterMs: 10_000 + FIRST_DELAY, reasons: 1 }],
      shown: RETRIED,
    },
    verdict: 'R1',
    now: { resumes: [{ afterMs: FIRST_DELAY, reasons: 1 }], shown: RETRIED },
    run: async () => {
      const pause = [reason()];
      stored = pausedState(pause);
      const pausedAt = Date.now();
      await observe(pausedEvent(pause));
      await elapse(10_000);
      await restart();
      await elapse(HOUR);
      return { resumes: resumesSince(pausedAt), shown: shown() };
    },
  },
  {
    name: 'a restart with a paused execution and no waiting retry retries it from attempt 1',
    develop: { resumes: ONE_RESUME, attempts: [1], shown: RETRIED },
    verdict: 'equal',
    run: async () => {
      stored = pausedState([reason()]);
      const restartedAt = Date.now();
      await restart();
      const attempts = [attemptShown()];
      await elapse(HOUR);
      return { resumes: resumesSince(restartedAt), attempts, shown: shown() };
    },
  },
  {
    name: "the retry's resume origin",
    develop: { resumes: ONE_RESUME, shown: RETRIED, origin: 'automation' },
    verdict: 'O2',
    now: {
      resumes: ONE_RESUME,
      shown: RETRIED,
      origin: `system:${INITIATED_WORK_PIPELINE_TRANSIENT_RETRY_SOURCE}, legacy automation`,
    },
    run: async () => {
      const outcome = await onePause();
      const origin = resumes[0]?.origin;
      const legacy = origin ? legacyPipelineResumeOrigin(origin) : undefined;
      return {
        ...outcome,
        origin:
          origin?.kind === 'system'
            ? `system:${origin.sourceId}, legacy ${legacy?.kind ?? 'none'}`
            : (origin?.kind ?? 'automation'),
      };
    },
  },
  {
    name: 'core.operation.cancel on a waiting retry',
    // Develop had no operation for a retry, so nothing could cancel it there.
    develop: { resumes: ONE_RESUME, shown: RETRIED },
    verdict: 'C1',
    now: { resumes: [], shown: 'nothing' },
    run: () =>
      onePause(undefined, async () => {
        const [run] = await listOperations(EXECUTION, 'core.initiatedWork.run');
        if (run)
          await operations.cancel(run.operationId, {
            reason: 'Stop retrying.',
            requestedBy: 'local-desktop-user',
          });
        await elapse(0);
      }),
  },
  {
    name: 'an execution event before the scheduler starts is ignored',
    develop: { resumes: [], shown: 'nothing' },
    verdict: 'equal',
    run: async () => {
      await launch();
      const pausedAt = Date.now();
      await observe(pausedEvent([reason()]));
      startScheduler();
      await whenRecovered();
      await elapse(HOUR);
      return { resumes: resumesSince(pausedAt), shown: shown() };
    },
  },
  {
    name: 'an execution event after quit has shut the runtime down resumes nothing',
    develop: { resumes: [], shown: 'nothing' },
    verdict: 'equal',
    run: async () => {
      quitRuntime();
      const pausedAt = Date.now();
      await observe(pausedEvent([reason()]));
      await elapse(HOUR);
      return { resumes: resumesSince(pausedAt), shown: 'nothing' };
    },
  },
  {
    name: 'the countdown the app reads matches the waiting retry',
    develop: {
      resumes: [],
      shown: { attempt: 1, exhausted: false, counting: true },
    },
    verdict: 'equal',
    run: async () => {
      const pausedAt = Date.now();
      await observe(pausedEvent([reason()]));
      return { resumes: resumesSince(pausedAt), shown: shown() };
    },
  },
];

beforeEach(async () => {
  jest.useFakeTimers({ now: START, doNotFake: ['nextTick', 'setImmediate'] });
  dir = mkdtempSync(join(tmpdir(), 'canopy-retry-equivalence-'));
  resumes = [];
  stored = null;
  retriesOn = true;
  resumeAnswer = 'started';
  reasonCounter = 0;
  resetScheduler();
  openEngine();
  await operations.ready();
  startScheduler();
  await whenRecovered();
});

afterEach(() => {
  engine.stopStarting();
  resetScheduler();
  operations.close();
  rmSync(dir, { recursive: true, force: true });
  jest.useRealTimers();
});

describe('pipeline transient retries match develop (CAN-4175)', () => {
  it.each(ROWS)('$name', async (row) => {
    const expected = row.verdict === 'equal' ? row.develop : row.now;
    expect(await row.run()).toEqual(expected);
  });

  it('a row differs from develop only under a named deviation', () => {
    for (const row of ROWS) {
      if (row.verdict === 'equal') {
        expect(row.now).toBeUndefined();
        continue;
      }
      expect(DEVIATIONS[row.verdict]).toEqual(expect.any(String));
      expect(row.now).toBeDefined();
      expect(row.now).not.toEqual(row.develop);
    }
  });
});

const MAIN = join(__dirname, '..', '..');

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

/** Every function a node calls, by its own name. */
function calledNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) {
      const callee = child.expression;
      if (ts.isIdentifier(callee)) names.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee))
        names.add(callee.name.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

/** The statements of main's `app.whenReady().then(...)` callback. */
function whenReadyStatements(): readonly ts.Statement[] {
  let found: readonly ts.Statement[] | null = null;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'then' &&
      ts.isCallExpression(node.expression.expression) &&
      node.expression.expression.expression.getText() === 'app.whenReady'
    ) {
      const callback = node.arguments[0];
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        ts.isBlock(callback.body)
      )
        found = callback.body.statements;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(join(MAIN, 'index.ts')));
  if (!found) throw new Error('main has no app.whenReady().then callback');
  return found;
}

describe('what CAN-4175 PR 4 adds: one scheduler instance, started before IPC', () => {
  it('two schedulers share no state', async () => {
    const own = scheduler;
    if (!own) throw new Error('no scheduler started');
    const otherDir = mkdtempSync(join(tmpdir(), 'canopy-retry-other-'));
    const otherOperations = new OperationService({
      openLedger: (): OperationLedger =>
        OperationLedger.open(join(otherDir, 'operations.sqlite')),
    });
    const other = new PipelineTransientRetries(
      new InitiatedWorkEngine({
        operations: otherOperations,
        recoverableOrigins: [
          {
            kind: 'system',
            sourceId: INITIATED_WORK_PIPELINE_TRANSIENT_RETRY_SOURCE,
          },
        ],
      }),
    );
    try {
      const pausedAt = Date.now();
      await observe(pausedEvent([reason()]));
      expect(own.withDisplay(baseState()).transient_retry).toMatchObject({
        attempt: 1,
      });
      expect(other.withDisplay(baseState()).transient_retry).toBeUndefined();
      other.cancelPending(EXECUTION);
      other.resetForTests();
      await elapse(HOUR);
      expect(resumesSince(pausedAt)).toEqual(ONE_RESUME);
    } finally {
      otherOperations.close();
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('the scheduler module keeps no state of its own', () => {
    const file = parse(
      join(MAIN, 'pipelines', 'transient-error-retry-scheduler.ts'),
    );
    const moduleState: string[] = [];
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const mutable = !(statement.declarationList.flags & ts.NodeFlags.Const);
      for (const declaration of statement.declarationList.declarations)
        if (
          mutable ||
          (declaration.initializer &&
            ts.isNewExpression(declaration.initializer))
        )
          moduleState.push(declaration.name.getText());
    }
    expect(moduleState).toEqual([]);
    expect(Object.keys(schedulerModule)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^(initTransientErrorRetryScheduler|whenTransientRetryRecovered|resetTransientErrorRetrySchedulerForTests)$/,
        ),
      ]),
    );
  });

  it('main starts it after the runtime exists and before any IPC handler is registered', () => {
    const statements = whenReadyStatements();
    const first = (name: string): number =>
      statements.findIndex((statement) => calledNames(statement).has(name));
    const runtimeReady = first('setDesktopCanopyRuntime');
    const started = first('startPipelineTransientRetries');
    const ipc = first('registerAllIpcHandlers');
    const pipelineIpc = first('registerPipelineHandlers');
    expect(runtimeReady).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(runtimeReady);
    expect(ipc).toBeGreaterThan(started);
    expect(pipelineIpc).toBeGreaterThan(started);
    const registersHandlers = (name: string): boolean =>
      /^register[A-Za-z]*Handlers?$|^registerIpcHandler$|^handle$/.test(name);
    const earlier = statements
      .slice(0, started)
      .flatMap((statement) => [...calledNames(statement)])
      .filter(registersHandlers);
    expect(earlier).toEqual([]);
    expect(
      calledNames(parse(join(MAIN, 'ipc', 'index.ts'))).has(
        'startPipelineTransientRetries',
      ),
    ).toBe(false);
  });
});
