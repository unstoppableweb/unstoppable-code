import {
  KEYED_WRITE_OUTCOME_SHAPES,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import type { CoreCoworkInvoker } from '../../core-cowork/invoker';
import {
  createCloudPipelineRunSession,
  type CloudRunControlKeys,
} from '../cloud-run-session';

// CAN-6995 S7c: a cloud run's keyed controls read every answer through the
// shared keyed-write check, and the host-shared control keys are the history:
// once a control's outcome is unknown its ids stay, whatever a later send of
// it is answered, until a result settles it. Every surface sharing the keys
// replays the same control under the same key, so it acts once. Nothing is
// ever sent again on its own.

const EXECUTION_ID = 'run-golden';
const RETRY = 'worker.pipeline.execution.retry';
const CANCEL = 'worker.pipeline.execution.cancel';
const RESUME = 'worker.pipeline.execution.resume';

function execution(status: string): Record<string, unknown> {
  return {
    executionId: EXECUTION_ID,
    pipelineId: 'curated:golden-review',
    name: 'Golden review',
    status,
    runScope: 'global',
    definitionSource: 'curated',
    owner: 'personal',
    workspaceId: null,
    worktreeId: null,
    parentExecutionId: null,
    startedAt: '2026-11-19T10:00:00.000Z',
    completedAt: '2026-11-19T10:05:00.000Z',
    pendingPauseCount: 0,
    error: null,
  };
}

/**
 * A scripted answer: a refusal, a result, the request failing with no reply
 * at all ('hangup'), or a reply this app can't read ('garbled').
 */
type Answer = CanopyErrorPayload | 'result' | 'hangup' | 'garbled';

interface Send {
  readonly method: string;
  readonly key: string;
  readonly newExecutionId: unknown;
}

/**
 * A web core that answers each control send with the next scripted answer
 * for its method, records every send's key, and applies an effect once per
 * key it answers with a result.
 */
function webCore(script: Record<string, Answer[]>): {
  readonly invoker: CoreCoworkInvoker;
  readonly sends: Send[];
  readonly effects: Set<string>;
} {
  const sends: Send[] = [];
  const effects = new Set<string>();
  return {
    sends,
    effects,
    invoker: {
      request: (method, params) => {
        // Reads a settled control triggers (the run's detail, its cost) are
        // not sends of a control.
        if (method !== RETRY && method !== CANCEL && method !== RESUME)
          return Promise.reject(new Error(`${method} is not under test`));
        const key = String(Reflect.get(Object(params._meta), 'idempotencyKey'));
        sends.push({ method, key, newExecutionId: params.newExecutionId });
        const answer = script[method]?.shift();
        if (answer === undefined)
          return Promise.reject(new Error(`${method} is not expected`));
        if (answer === 'hangup')
          return Promise.reject(new Error('socket hang up'));
        if (answer === 'garbled')
          return Promise.resolve({ ok: true, value: { unexpected: 'reply' } });
        if (answer !== 'result')
          return Promise.resolve({ ok: false, error: answer });
        effects.add(`${method}:${key}`);
        const value =
          method === 'worker.pipeline.execution.cancel'
            ? { execution: execution('cancelled') }
            : { outcome: 'started', execution: execution('failure') };
        return Promise.resolve({ ok: true, value });
      },
      openStream: () => Promise.reject(new Error('no streams')),
    },
  };
}

function session(
  invoker: CoreCoworkInvoker,
  controlKeys: CloudRunControlKeys,
): ReturnType<typeof createCloudPipelineRunSession> {
  let id = 0;
  return createCloudPipelineRunSession({
    invoker,
    executionId: EXECUTION_ID,
    controlKeys,
    randomId: () => `id-${++id}`,
    // Rereads are not under test: hold each timer without ever firing it.
    setTimer: () => {
      const timer = setTimeout(() => undefined, 0);
      clearTimeout(timer);
      return timer;
    },
    clearTimer: () => undefined,
  });
}

function answer(
  kind: CanopyErrorPayload['kind'],
  retry: 'never' | 'same_idempotency_key',
  extra: Partial<CanopyErrorPayload> = {},
): CanopyErrorPayload {
  return { kind, message: 'Answered.', retry: { kind: retry }, ...extra };
}

describe('a cloud run control, read through the shared keyed-write check (S7c)', () => {
  it.each(KEYED_WRITE_OUTCOME_SHAPES.map((shape) => [shape.name, shape]))(
    'reads %s as the shared table does, and never sends it again',
    async (_name, shape) => {
      const keys: CloudRunControlKeys = new Map();
      const core = webCore({ [RETRY]: [shape.payload] });
      const run = session(core.invoker, keys);
      await expect(run.retry()).rejects.toBeDefined();
      expect(keys.size).toBe(shape.unknown ? 1 : 0);
      expect(run.getState().controlUnknown).toBe(shape.unknown);
      expect(core.sends).toHaveLength(1);
    },
  );

  const kinds = [
    'unavailable',
    'deadline_exceeded',
    'cancelled',
    'internal',
    'resource_exhausted',
  ] as const;
  // CAN-7470: an internal failure with no code may have landed; one its
  // producer typed is the producer's own refusal.
  const unknownWhenNever = (kind: CanopyErrorPayload['kind']): boolean =>
    kind === 'unavailable' || kind === 'internal';
  it.each(kinds)(
    'an answer of %s that will never be retried is definite unless it is a lost reply or an untyped fault',
    async (kind) => {
      const keys: CloudRunControlKeys = new Map();
      const run = session(
        webCore({ [RETRY]: [answer(kind, 'never')] }).invoker,
        keys,
      );
      await expect(run.retry()).rejects.toBeDefined();
      expect(run.getState().controlUnknown).toBe(unknownWhenNever(kind));
      expect(keys.size).toBe(unknownWhenNever(kind) ? 1 : 0);
    },
  );
  it.each(kinds)(
    'an answer of %s with a typed code that will never be retried is definite unless it is a lost reply',
    async (kind) => {
      const keys: CloudRunControlKeys = new Map();
      const run = session(
        webCore({
          [RETRY]: [
            answer(kind, 'never', { code: 'worker.pipeline.controlFailed' }),
          ],
        }).invoker,
        keys,
      );
      await expect(run.retry()).rejects.toBeDefined();
      expect(run.getState().controlUnknown).toBe(kind === 'unavailable');
      expect(keys.size).toBe(kind === 'unavailable' ? 1 : 0);
    },
  );
  it.each(kinds)(
    'an answer of %s that asks for the same key again could not be confirmed',
    async (kind) => {
      const keys: CloudRunControlKeys = new Map();
      const run = session(
        webCore({ [RETRY]: [answer(kind, 'same_idempotency_key')] }).invoker,
        keys,
      );
      await expect(run.retry()).rejects.toBeDefined();
      expect(run.getState().controlUnknown).toBe(true);
      expect(keys.size).toBe(1);
    },
  );
});

describe('the shared control keys are the history (S7c)', () => {
  it('keeps an unknown control unknown through a definite refusal of its replay, and only a result clears it', async () => {
    const keys: CloudRunControlKeys = new Map();
    const core = webCore({
      [RETRY]: [
        answer('unavailable', 'never'),
        answer('failed_precondition', 'never'),
        'result',
      ],
    });
    const run = session(core.invoker, keys);

    await expect(run.retry()).rejects.toBeDefined();
    await expect(run.retry()).rejects.toBeDefined();
    expect(keys.size).toBe(1);
    expect(run.getState().controlUnknown).toBe(true);

    await run.retry();
    expect(keys.size).toBe(0);
    expect(run.getState().controlUnknown).toBe(false);
    expect(new Set(core.sends.map((send) => send.key)).size).toBe(1);
    expect(core.sends).toHaveLength(3);
  });

  it('replays a control resent from another surface under the same key, so it acts once', async () => {
    const keys: CloudRunControlKeys = new Map();
    const core = webCore({
      [RETRY]: [answer('unavailable', 'never'), 'result'],
    });
    const row = session(core.invoker, keys);
    const detail = session(core.invoker, keys);

    await expect(row.retry()).rejects.toBeDefined();
    await detail.retry();

    expect(core.sends.map((send) => send.key)).toEqual([
      core.sends[0]?.key,
      core.sends[0]?.key,
    ]);
    expect(core.effects.size).toBe(1);
    expect(keys.size).toBe(0);
    expect(detail.getState().controlUnknown).toBe(false);
    // Each session's flag covers the controls it sent itself.
    expect(row.getState().controlUnknown).toBe(true);
  });

  it('reads an allowlisted not-applied mark as definite, unless an earlier send of the control was unknown', async () => {
    const busy = answer('resource_exhausted', 'same_idempotency_key', {
      code: 'core.chat.attachment.busy',
    });

    const fresh = new Map() as CloudRunControlKeys;
    const first = session(webCore({ [RETRY]: [busy] }).invoker, fresh);
    await expect(first.retry()).rejects.toBeDefined();
    expect(fresh.size).toBe(0);
    expect(first.getState().controlUnknown).toBe(false);

    const replayed = new Map() as CloudRunControlKeys;
    const second = session(
      webCore({ [RETRY]: [answer('unavailable', 'never'), busy] }).invoker,
      replayed,
    );
    await expect(second.retry()).rejects.toBeDefined();
    await expect(second.retry()).rejects.toBeDefined();
    expect(replayed.size).toBe(1);
    expect(second.getState().controlUnknown).toBe(true);
  });

  it('clears only the control a result settles, and stays unknown while another is', async () => {
    const keys: CloudRunControlKeys = new Map();
    const core = webCore({
      [RETRY]: [answer('unavailable', 'never'), 'result'],
      [CANCEL]: [answer('deadline_exceeded', 'same_idempotency_key'), 'result'],
    });
    const run = session(core.invoker, keys);

    await expect(run.retry()).rejects.toBeDefined();
    await expect(run.cancel()).rejects.toBeDefined();
    expect(keys.size).toBe(2);

    await run.retry();
    expect(keys.size).toBe(1);
    expect(run.getState().controlUnknown).toBe(true);

    await run.cancel();
    expect(keys.size).toBe(0);
    expect(run.getState().controlUnknown).toBe(false);
  });
});

// Review round 1 on #10253: a control whose request failed with no reply, or
// whose reply couldn't be read, may have been applied, so it keeps its ids
// and the next press replays it under the same key.
describe('a control whose answer never came or could not be read (S7c)', () => {
  type Control = (run: ReturnType<typeof session>) => Promise<unknown>;
  it.each<[string, string, Control, boolean]>([
    ['try again', RETRY, (run): Promise<unknown> => run.retry(), false],
    ['resume', RESUME, (run): Promise<unknown> => run.resume(), false],
    ['cancel', CANCEL, (run): Promise<unknown> => run.cancel(), false],
    ['start over', RETRY, (run): Promise<unknown> => run.rerun(), true],
  ])(
    'keeps a %s whose request failed with no reply unknown, and resends it unchanged',
    async (_name, method, press, newExecution) => {
      const keys: CloudRunControlKeys = new Map();
      const core = webCore({ [method]: ['hangup', 'result'] });
      const run = session(core.invoker, keys);

      await expect(press(run)).rejects.toThrow('socket hang up');
      expect(run.getState().controlUnknown).toBe(true);
      expect(keys.size).toBe(1);

      await press(run);
      const [first, second] = core.sends;
      expect(first?.method).toBe(method);
      expect(typeof first?.newExecutionId === 'string').toBe(newExecution);
      // The same key, and for a start-over the same new execution id.
      expect(second).toEqual(first);
      expect(core.effects.size).toBe(1);
      expect(run.getState().controlUnknown).toBe(false);
      expect(keys.size).toBe(0);
    },
  );

  it('keeps a control whose reply could not be read unknown, and replays it under the same key', async () => {
    const keys: CloudRunControlKeys = new Map();
    const core = webCore({ [RETRY]: ['garbled', 'result'] });
    const run = session(core.invoker, keys);

    await expect(run.retry()).rejects.toBeDefined();
    expect(run.getState().controlUnknown).toBe(true);
    expect(keys.size).toBe(1);

    await run.retry();
    expect(new Set(core.sends.map((send) => send.key)).size).toBe(1);
    expect(run.getState().controlUnknown).toBe(false);
  });
});
