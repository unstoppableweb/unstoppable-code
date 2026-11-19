import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerAgentSubagentRunResult,
  type WorkerAgentTurnEvent,
  type WorkerAgentTurnRunParams,
  type WorkerAgentTurnRunResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../../runtime/errors';
import { createCanopyDispatcher } from '../../../../runtime/dispatcher';
import { createDirectLocalWorkerTransport } from '../../../../runtime/local-worker-transport';
import { createWorkerExecutorReceipts } from '../../../../runtime/worker-executor-receipts';
import { LocalWorkerExecution, OperationService } from '../../../operations';
import { OperationLedger } from '../../../operations/ledger';
import {
  CORE_AGENT_SUBAGENT_RUN_KIND,
  CORE_CHAT_TURN_RUN_KIND,
  CoreChatTurnRuns,
  CoreSubagentRuns,
  TurnEventOutOfOrderError,
  createWorkerAgentRunHandlers,
  type ChatTurnTranscriptPort,
  type CoreChatTurnBeginRequest,
  type SubagentExecutionWorker,
  type TurnEventSink,
  type TurnExecutionWorker,
} from '..';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'test-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.agent.execute'],
};
const instructions = WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS;
const definitions = { queries: {}, instructions, streams: {} };
const scope = { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' };
type TranscriptEnvelope = Parameters<ChatTurnTranscriptPort>[0];

interface Harness {
  operations: OperationService;
  localWorker: LocalWorkerExecution;
  turns: CoreChatTurnRuns;
  subagents: CoreSubagentRuns;
  close(): void;
}
function compose(
  ledgerPath: string,
  turns: TurnExecutionWorker,
  subagents: SubagentExecutionWorker = {
    run: (params) =>
      Promise.resolve({
        subagentRunId: params.subagentRunId,
        status: 'completed',
      }),
  },
): Harness {
  const runsRef: { current: CoreChatTurnRuns | null } = { current: null };
  const receipts = createWorkerExecutorReceipts(instructions);
  const handlers = createWorkerAgentRunHandlers({
    turns,
    subagents,
    sinkFor: (id) => runsRef.current?.sinkFor(id) ?? null,
  });
  const dispatcher = createCanopyDispatcher({
    profile: 'core+worker',
    definitions,
    handlers: {
      queries: {},
      instructions: receipts.wrap(handlers.instructions),
      streams: {},
    },
  });
  const operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  const localWorker = new LocalWorkerExecution({
    operations,
    transport: createDirectLocalWorkerTransport({
      dispatcher,
      instructions,
      caller,
      receipts,
    }),
  });
  const runs = new CoreChatTurnRuns({ operations, localWorker });
  runsRef.current = runs;
  return {
    operations,
    localWorker,
    turns: runs,
    subagents: new CoreSubagentRuns({ operations, localWorker }),
    close: (): void => {
      operations.close();
      void dispatcher.shutdown();
    },
  };
}
function params(
  overrides: Partial<WorkerAgentTurnRunParams> = {},
): WorkerAgentTurnRunParams {
  return {
    turnRunId: 'run',
    scope,
    turnId: 'message',
    eventNamespace: 'initial',
    providerId: 'claude',
    model: null,
    materializationId: null,
    ...overrides,
  };
}
function request(
  transcript: CoreChatTurnBeginRequest['transcript'] = () => Promise.resolve(),
  overrides: Partial<WorkerAgentTurnRunParams> = {},
): CoreChatTurnBeginRequest {
  return {
    params: params(overrides),
    origin: { kind: 'client', sourceId: 'test' },
    owner: { kind: 'system', id: 'test' },
    transcript,
  };
}
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let done: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    done = resolve;
  });
  return { promise, resolve: (value) => done(value) };
}
/** A worker the test drives: it exposes the sink and settles on demand. */
function controlledWorker(): {
  worker: TurnExecutionWorker;
  started: Promise<{ sink: TurnEventSink; signal: AbortSignal }>;
  finish(result: WorkerAgentTurnRunResult): void;
  calls: () => number;
} {
  const started = deferred<{ sink: TurnEventSink; signal: AbortSignal }>();
  const finished = deferred<WorkerAgentTurnRunResult>();
  let calls = 0;
  return {
    worker: {
      run: (_params, signal, sink) => {
        calls += 1;
        started.resolve({ sink, signal });
        return finished.promise;
      },
    },
    started: started.promise,
    finish: (result) => finished.resolve(result),
    calls: () => calls,
  };
}
function transcript(
  sequence: number,
  payload: unknown = { type: 'assistant' },
): WorkerAgentTurnEvent {
  return {
    turnRunId: 'run',
    sequence,
    kind: 'transcript',
    format: 'canopy.chat-event.v1',
    terminal: false,
    payload,
  };
}
async function childOf(
  h: Harness,
  parentOperationId: string,
): Promise<unknown> {
  const [delegation] = await h.localWorker.listDelegations(parentOperationId);
  if (!delegation) throw new Error('No dispatch');
  return h.operations.get(delegation.childOperationId);
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'turn-runs-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it('records the parent and the worker dispatch before the launch runs', async () => {
  const seen: unknown[] = [];
  const h = compose(join(root, 'ledger.sqlite'), {
    run: async (run) => {
      const { items } = await h.operations.list({ limit: 10 });
      seen.push(
        items.find((item) => item.kind === CORE_CHAT_TURN_RUN_KIND),
        items.find((item) => item.kind === 'worker.agent.turn.run'),
      );
      return { turnRunId: run.turnRunId, eventCount: 0, status: 'completed' };
    },
  });
  try {
    const run = await h.turns.begin(request());
    expect(await run.settled).toMatchObject({ status: 'completed' });
    expect(seen[0]).toMatchObject({
      status: 'running',
      operationId: run.ref.operationId,
      scope,
    });
    expect(seen[1]).toMatchObject({
      status: 'running',
      parentOperationId: run.ref.operationId,
    });
    expect(await h.operations.get(run.ref.operationId)).toMatchObject({
      status: 'completed',
    });
  } finally {
    h.close();
  }
});

it('refuses a second live run for the same chat turn', async () => {
  const control = controlledWorker();
  const h = compose(join(root, 'ledger.sqlite'), control.worker);
  try {
    const first = await h.turns.begin(request());
    await expect(h.turns.begin(request())).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.chat.turnRunActive',
        message: 'This chat turn is already running.',
      },
    });
    expect(
      (await h.operations.list({ kinds: [CORE_CHAT_TURN_RUN_KIND], limit: 10 }))
        .items,
    ).toHaveLength(1);
    const other = await h.turns.begin(
      request(undefined, { turnRunId: 'other', eventNamespace: 'resume' }),
    );
    expect(other.ref.operationId).not.toBe(first.ref.operationId);
    expect(h.turns.findLive(scope, 'message')).toEqual(other.ref);
    control.finish({ turnRunId: 'run', eventCount: 0, status: 'completed' });
    await first.settled;
  } finally {
    h.close();
  }
});

it('findLive keeps an older live namespace when a newer one settles', async () => {
  const finishes = new Map<
    string,
    (result: WorkerAgentTurnRunResult) => void
  >();
  const h = compose(join(root, 'ledger.sqlite'), {
    run: (run) =>
      new Promise((resolve) => {
        finishes.set(run.turnRunId, resolve);
      }),
  });
  const finish = async (turnRunId: string): Promise<void> => {
    for (let attempt = 0; !finishes.has(turnRunId) && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    finishes.get(turnRunId)?.({
      turnRunId,
      eventCount: 0,
      status: 'completed',
    });
  };
  try {
    const initial = await h.turns.begin(request());
    const resumed = await h.turns.begin(
      request(undefined, { turnRunId: 'resumed', eventNamespace: 'resume' }),
    );
    expect(h.turns.findLive(scope, 'message')).toEqual(resumed.ref);
    await finish('resumed');
    await resumed.settled;
    expect(h.turns.findLive(scope, 'message')).toEqual(initial.ref);
    await finish('run');
    await initial.settled;
    expect(h.turns.findLive(scope, 'message')).toBeNull();
  } finally {
    h.close();
  }
});

it('forwards transcript events in order and refuses gaps', async () => {
  const control = controlledWorker();
  const h = compose(join(root, 'ledger.sqlite'), control.worker);
  const port = jest.fn((event: TranscriptEnvelope): Promise<void> => {
    void event;
    return Promise.resolve();
  });
  try {
    const run = await h.turns.begin(request(port));
    const { sink } = await control.started;
    for (const sequence of [0, 1, 2]) await sink(transcript(sequence));
    expect(port.mock.calls.map(([event]) => event.sequence)).toEqual([0, 1, 2]);
    await expect(sink(transcript(4))).rejects.toBeInstanceOf(
      TurnEventOutOfOrderError,
    );
    expect(port).toHaveBeenCalledTimes(3);
    control.finish({ turnRunId: 'run', eventCount: 3, status: 'completed' });
    await run.settled;
  } finally {
    h.close();
  }
});

it("the run's outcome comes from the terminal envelope, never from the payload", async () => {
  const control = controlledWorker();
  const h = compose(join(root, 'ledger.sqlite'), control.worker);
  try {
    const run = await h.turns.begin(request());
    const { sink } = await control.started;
    await sink(transcript(0, { type: 'result', is_error: true }));
    await sink({
      turnRunId: 'run',
      sequence: 1,
      kind: 'terminal',
      outcome: 'completed',
    });
    control.finish({ turnRunId: 'run', eventCount: 2, status: 'completed' });
    expect(await run.settled).toMatchObject({
      status: 'completed',
      eventCount: 2,
    });
    expect(await h.operations.get(run.ref.operationId)).toMatchObject({
      status: 'completed',
    });
  } finally {
    h.close();
  }
});

it('core.operation.cancel stops the exact turn once and settles cancelled', async () => {
  const started = deferred();
  let aborts = 0;
  const h = compose(join(root, 'ledger.sqlite'), {
    run: (run, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborts += 1;
          resolve({
            turnRunId: run.turnRunId,
            eventCount: 0,
            status: 'cancelled',
          });
        });
        started.resolve();
      }),
  });
  try {
    const run = await h.turns.begin(request());
    await started.promise;
    for (const requestedBy of ['first', 'second'])
      await h.operations.cancel(run.ref.operationId, {
        reason: 'Stop',
        requestedBy,
      });
    expect(await run.settled).toMatchObject({ status: 'cancelled' });
    expect(aborts).toBe(1);
    expect(await h.operations.get(run.ref.operationId)).toMatchObject({
      status: 'cancelled',
    });
    expect(await childOf(h, run.ref.operationId)).toMatchObject({
      status: 'cancelled',
    });
  } finally {
    h.close();
  }
});

it('a wait keeps the run running and reaches the observer once', async () => {
  const control = controlledWorker();
  const h = compose(join(root, 'ledger.sqlite'), control.worker);
  const opened = jest.fn();
  const resolved = jest.fn();
  h.turns.observeWaits({ opened, resolved });
  try {
    const run = await h.turns.begin(request());
    const { sink } = await control.started;
    for (const sequence of [0, 1])
      await sink({
        turnRunId: 'run',
        sequence,
        kind: 'wait_opened',
        waitId: 'wait',
        waitKind: 'approval',
      });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(run.ref, {
      waitId: 'wait',
      waitKind: 'approval',
    });
    expect(await h.operations.get(run.ref.operationId)).toMatchObject({
      status: 'running',
    });
    control.finish({ turnRunId: 'run', eventCount: 2, status: 'completed' });
    await run.settled;
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith(run.ref, {
      waitId: 'wait',
      resolution: 'cancelled',
    });
  } finally {
    h.close();
  }
});

it('late transcript frames still reach the transcript port after settlement', async () => {
  const control = controlledWorker();
  const h = compose(join(root, 'ledger.sqlite'), control.worker);
  const port = jest.fn((event: TranscriptEnvelope): Promise<void> => {
    void event;
    return Promise.resolve();
  });
  try {
    const run = await h.turns.begin(request(port));
    const { sink } = await control.started;
    await sink({
      turnRunId: 'run',
      sequence: 0,
      kind: 'terminal',
      outcome: 'completed',
    });
    control.finish({ turnRunId: 'run', eventCount: 1, status: 'completed' });
    await run.settled;
    await sink(transcript(1, { type: 'late' }));
    await sink({
      turnRunId: 'run',
      sequence: 2,
      kind: 'terminal',
      outcome: 'failed',
    });
    expect(port).toHaveBeenCalledTimes(1);
    expect(port.mock.calls[0]?.[0].payload).toEqual({ type: 'late' });
    expect(await h.operations.get(run.ref.operationId)).toMatchObject({
      status: 'completed',
    });
    expect(h.turns.sinkFor('run')).toBeNull();
  } finally {
    h.close();
  }
});

it('a restart finds an unfinished turn run lost and replays nothing', async () => {
  const control = controlledWorker();
  const ledgerPath = join(root, 'ledger.sqlite');
  const before = compose(ledgerPath, control.worker);
  const run = await before.turns.begin(request());
  await control.started;
  before.close();
  const after = compose(ledgerPath, control.worker);
  try {
    await after.operations.whenReconciled();
    expect(await after.operations.get(run.ref.operationId)).toMatchObject({
      status: 'failed',
      error: { code: 'core.operation.interrupted' },
      restart: { class: 'lost', disposition: 'lost' },
    });
    expect(await childOf(after, run.ref.operationId)).toMatchObject({
      status: 'failed',
      restart: { class: 'lost', disposition: 'lost' },
    });
    expect(control.calls()).toBe(1);
  } finally {
    control.finish({ turnRunId: 'run', eventCount: 0, status: 'completed' });
    await run.settled;
    after.close();
  }
});

describe('a completed worker result reporting cancelled settles the child cancelled', () => {
  it('for worker.agent.turn.run', async () => {
    const h = compose(join(root, 'ledger.sqlite'), {
      run: (run) =>
        Promise.resolve({
          turnRunId: run.turnRunId,
          eventCount: 0,
          status: 'cancelled',
        }),
    });
    try {
      const run = await h.turns.begin(request());
      expect(await run.settled).toMatchObject({ status: 'cancelled' });
      const cancelled = {
        turnRunId: 'run',
        eventCount: 0,
        status: 'cancelled',
      };
      expect(await childOf(h, run.ref.operationId)).toMatchObject({
        status: 'cancelled',
        outcome: cancelled,
      });
      const replay = await h.localWorker.dispatch({
        parentOperationId: run.ref.operationId,
        operation: 'worker.agent.turn.run',
        params: request().params,
        idempotencyKey: 'run',
      });
      expect(replay).toMatchObject({ replayed: true, result: cancelled });
    } finally {
      h.close();
    }
  });

  it('for worker.agent.subagent.run', async () => {
    const h = compose(join(root, 'ledger.sqlite'), controlledWorker().worker, {
      run: (run): Promise<WorkerAgentSubagentRunResult> =>
        Promise.resolve({
          subagentRunId: run.subagentRunId,
          status: 'cancelled',
        }),
    });
    try {
      const run = await h.subagents.begin({
        params: {
          subagentRunId: 'sub',
          delegationId: 'delegation',
          runGeneration: 1,
          harnessId: 'local-delegation-claude-v1',
          scope,
        },
        origin: { kind: 'system', sourceId: 'subagent:test' },
        owner: { kind: 'system', id: 'test' },
        parentOperationId: null,
      });
      expect(await run.settled).toMatchObject({ status: 'cancelled' });
      expect(
        (
          await h.operations.list({
            kinds: [CORE_AGENT_SUBAGENT_RUN_KIND],
            limit: 10,
          })
        ).items[0],
      ).toMatchObject({ status: 'cancelled' });
      expect(await childOf(h, run.ref.operationId)).toMatchObject({
        status: 'cancelled',
        outcome: { subagentRunId: 'sub', status: 'cancelled' },
      });
    } finally {
      h.close();
    }
  });
});

it('records a typed dispatch refusal without its private message or retry instructions', async () => {
  const h = compose(join(root, 'ledger.sqlite'), controlledWorker().worker);
  const refusal = new CanopyOperationError({
    kind: 'permission_denied',
    code: 'worker.agent.privateRefusal',
    message: 'private refusal sentinel',
    details: { resource: 'private resource sentinel' },
    retry: { kind: 'same_request' },
  });
  jest.spyOn(h.localWorker, 'dispatch').mockRejectedValueOnce(refusal);
  try {
    const run = await h.turns.begin(request());
    const result = await run.settled;
    const expected = {
      kind: 'permission_denied',
      code: 'worker.agent.privateRefusal',
      message: 'This chat turn could not be dispatched.',
      retry: { kind: 'never' },
    };
    expect(result).toMatchObject({ status: 'failed', error: expected });
    expect((await h.operations.get(run.ref.operationId))?.error).toEqual(
      expected,
    );
    expect(JSON.stringify(result)).not.toContain('sentinel');
    expect(h.turns.sinkFor('run')).toBeNull();
  } finally {
    h.close();
  }
});

it('cancellation while reading a refused dispatch wins over its typed failure', async () => {
  const h = compose(join(root, 'ledger.sqlite'), controlledWorker().worker);
  const controller = new AbortController();
  const refusal = new CanopyOperationError({
    kind: 'unavailable',
    code: 'core.delegation.notStarted',
    message: 'private refusal',
    retry: { kind: 'never' },
  });
  jest.spyOn(h.localWorker, 'dispatch').mockRejectedValueOnce(refusal);
  const get = h.operations.get.bind(h.operations);
  jest.spyOn(h.operations, 'get').mockImplementationOnce(async (id) => {
    controller.abort();
    return get(id);
  });
  try {
    const run = await h.turns.begin(request(), { signal: controller.signal });
    expect(await run.settled).toMatchObject({ status: 'cancelled' });
    expect(await h.operations.get(run.ref.operationId)).toMatchObject({
      status: 'cancelled',
    });
    expect(h.turns.sinkFor('run')).toBeNull();
  } finally {
    h.close();
  }
});
