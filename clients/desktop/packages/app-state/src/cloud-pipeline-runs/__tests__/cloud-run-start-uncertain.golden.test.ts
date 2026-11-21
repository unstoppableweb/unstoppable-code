import {
  CLOUD_MODEL_UNCONFIRMED_CODE,
  KEYED_WRITE_OUTCOME_SHAPES,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import type { CoreCoworkInvoker } from '../../core-cowork/invoker';
import {
  CLOUD_RUN_START_UNCERTAIN,
  CLOUD_RUN_UNAVAILABLE,
  launchCloudPipelineRun,
} from '../cloud-run-start';

// CAN-7196 pin: a keyed cloud run start whose answer never came reaches the
// web Run dialog as 'unavailable' with retry 'never' (S7c's wire shape). The
// dialog keeps the launch's key and says it couldn't confirm the start, and
// the next press sends the same key, which the web core answers with the run
// it recorded: one run, never two. The client's own deadline after dispatch
// arrives as 'deadline_exceeded' with a same-key retry, and stays uncertain
// too.

function operationFor(key: string): Record<string, unknown> {
  const operationId = globalThis.crypto.randomUUID();
  const now = '2026-11-17T23:00:00.000Z';
  return {
    operationId,
    kind: 'core.pipeline.run',
    status: 'queued',
    revision: 1,
    parentOperationId: null,
    rootOperationId: operationId,
    authorityId: 'web-core-golden',
    executionTargetId: null,
    runtimeDelegationId: null,
    scope: {},
    origin: { kind: 'client', sourceId: 'user:golden' },
    owner: { kind: 'principal', id: 'user:golden' },
    receipt: { idempotencyKey: key, acceptedAt: now, outcome: 'recorded' },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    progress: null,
    outcome: null,
    error: null,
    cancellation: null,
    restart: null,
  };
}

/** A web core that records each start by its key and loses the first answer. */
function webCore(
  lost: {
    kind: 'unavailable' | 'deadline_exceeded';
    retry: 'never' | 'same_idempotency_key';
  } = { kind: 'unavailable', retry: 'never' },
): {
  readonly invoker: CoreCoworkInvoker;
  readonly runs: Map<string, Record<string, unknown>>;
} {
  const runs = new Map<string, Record<string, unknown>>();
  return {
    runs,
    invoker: {
      request: (method, params) => {
        if (method !== 'core.pipeline.execution.start')
          return Promise.reject(new Error(`${method} is not expected`));
        const key = String(Reflect.get(Object(params._meta), 'idempotencyKey'));
        const recorded = runs.get(key);
        if (recorded === undefined) {
          runs.set(key, operationFor(key));
          return Promise.resolve({
            ok: false,
            error: {
              kind: lost.kind,
              message: 'The response was lost.',
              retry: { kind: lost.retry },
            },
          });
        }
        return Promise.resolve({
          ok: true,
          value: {
            operation: recorded,
            statusReason: null,
            admission: 'admitted',
            replayed: true,
          },
        });
      },
      openStream: () => Promise.reject(new Error('no streams')),
    },
  };
}

describe('a cloud run start whose answer never came (CAN-7196)', () => {
  it.each([
    ['unavailable', 'never'],
    ['deadline_exceeded', 'same_idempotency_key'],
  ] as const)(
    'a lost answer read as %s with retry %s keeps the key, says it could not confirm, and a same-key press starts one run',
    async (kind, retry) => {
      const { invoker, runs } = webCore({ kind, retry });
      const launch = {
        definitionId: 'curated:golden-review',
        owner: 'personal',
        idempotencyKey: 'golden-key',
      };
      expect(await launchCloudPipelineRun(invoker, launch)).toEqual({
        kind: 'refused',
        message: CLOUD_RUN_START_UNCERTAIN,
        uncertain: true,
      });
      const again = await launchCloudPipelineRun(invoker, launch);
      expect(again).toMatchObject({ kind: 'started', replayed: true });
      expect(runs.size).toBe(1);
    },
  );
});

/** A web core that answers every start with one error, counting the sends. */
function refusingWebCore(error: CanopyErrorPayload | Error): {
  readonly invoker: CoreCoworkInvoker;
  readonly sends: () => number;
} {
  let sends = 0;
  return {
    sends: () => sends,
    invoker: {
      request: (method) => {
        if (method !== 'core.pipeline.execution.start')
          return Promise.reject(new Error(`${method} is not expected`));
        sends += 1;
        return error instanceof Error
          ? Promise.reject(error)
          : Promise.resolve({ ok: false, error });
      },
      openStream: () => Promise.reject(new Error('no streams')),
    },
  };
}

const launch = {
  definitionId: 'curated:golden-review',
  owner: 'personal',
  idempotencyKey: 'golden-key',
} as const;

async function startRefusedWith(error: CanopyErrorPayload | Error): Promise<{
  readonly uncertain: boolean;
  readonly message: string;
  readonly sends: number;
}> {
  const core = refusingWebCore(error);
  const outcome = await launchCloudPipelineRun(core.invoker, launch);
  if (outcome.kind !== 'refused') throw new Error(`started: ${outcome.kind}`);
  return {
    uncertain: outcome.uncertain,
    message: outcome.message,
    sends: core.sends(),
  };
}

// CAN-6995 S7c: the start reads every keyed-write answer through the shared
// check, so it agrees with every other cloud surface, and it never sends a
// start again on its own.
describe('a refused cloud run start, read through the shared keyed-write check (S7c)', () => {
  it.each(KEYED_WRITE_OUTCOME_SHAPES.map((shape) => [shape.name, shape]))(
    'reads %s as the shared table does',
    async (_name, shape) => {
      const read = await startRefusedWith(shape.payload);
      expect(read.uncertain).toBe(shape.unknown);
      if (shape.unknown) expect(read.message).toBe(CLOUD_RUN_START_UNCERTAIN);
      else expect(read.message).not.toBe(CLOUD_RUN_START_UNCERTAIN);
      expect(read.sends).toBe(1);
    },
  );

  const kinds = [
    'unavailable',
    'deadline_exceeded',
    'cancelled',
    'internal',
    'resource_exhausted',
  ] as const;
  // CAN-7470: an internal failure with no code may have been recorded; one
  // its producer typed is the producer's own refusal.
  it.each(kinds)(
    'an answer of %s that will never be retried is definite unless it is a lost reply or an untyped fault',
    async (kind) => {
      const read = await startRefusedWith({
        kind,
        message: 'Answered.',
        retry: { kind: 'never' },
      });
      expect(read.uncertain).toBe(
        kind === 'unavailable' || kind === 'internal',
      );
      expect(read.sends).toBe(1);
    },
  );
  it.each(kinds)(
    'an answer of %s with a typed code that will never be retried is definite unless it is a lost reply',
    async (kind) => {
      const read = await startRefusedWith({
        kind,
        message: 'Answered.',
        code: 'core.pipeline.definitionInvalid',
        retry: { kind: 'never' },
      });
      expect(read.uncertain).toBe(kind === 'unavailable');
      if (kind !== 'unavailable') expect(read.message).toBe('Answered.');
      expect(read.sends).toBe(1);
    },
  );
  it.each(kinds)(
    'an answer of %s that asks for the same key again could not be confirmed',
    async (kind) => {
      const read = await startRefusedWith({
        kind,
        message: 'Answered.',
        retry: { kind: 'same_idempotency_key' },
      });
      expect(read).toEqual({
        uncertain: true,
        message: CLOUD_RUN_START_UNCERTAIN,
        sends: 1,
      });
    },
  );

  // Review round 1 on #10253: a start the web core answered with a reply this
  // app can't read may have been recorded, so it keeps the launch's key.
  it('a start whose reply could not be read could not be confirmed', async () => {
    let sends = 0;
    const invoker: CoreCoworkInvoker = {
      request: (method) => {
        if (method !== 'core.pipeline.execution.start')
          return Promise.reject(new Error(`${method} is not expected`));
        sends += 1;
        return Promise.resolve({ ok: true, value: { unexpected: 'reply' } });
      },
      openStream: () => Promise.reject(new Error('no streams')),
    };
    expect(await launchCloudPipelineRun(invoker, launch)).toEqual({
      kind: 'refused',
      message: CLOUD_RUN_START_UNCERTAIN,
      uncertain: true,
    });
    expect(sends).toBe(1);
  });

  it('a send that never reached the web core could not be confirmed', async () => {
    expect(await startRefusedWith(new Error('socket hang up'))).toEqual({
      uncertain: true,
      message: CLOUD_RUN_START_UNCERTAIN,
      sends: 1,
    });
  });
});

// CAN-7470: a start refused for its cloud models recorded nothing, so the
// model preflight it reads next is not a keyed write. However that read
// fails, the launch is refused, never uncertain, and nothing is sent again.
describe('the model preflight after a start that recorded nothing (CAN-7470)', () => {
  function preflightFailing(answer: CanopyErrorPayload | 'garbled' | Error): {
    readonly invoker: CoreCoworkInvoker;
    readonly sends: string[];
  } {
    const sends: string[] = [];
    return {
      sends,
      invoker: {
        request: (method) => {
          sends.push(method);
          if (method === 'core.pipeline.execution.start')
            return Promise.resolve({
              ok: false,
              error: {
                kind: 'failed_precondition',
                code: CLOUD_MODEL_UNCONFIRMED_CODE,
                message: 'Choose cloud models for the steps that need them.',
                retry: { kind: 'never' },
              },
            });
          if (method !== 'core.pipeline.cloudModels.preflight')
            return Promise.reject(new Error(`${method} is not expected`));
          if (answer instanceof Error) return Promise.reject(answer);
          if (answer === 'garbled')
            return Promise.resolve({
              ok: true,
              value: { unexpected: 'reply' },
            });
          return Promise.resolve({ ok: false, error: answer });
        },
        openStream: () => Promise.reject(new Error('no streams')),
      },
    };
  }

  it.each<[string, CanopyErrorPayload | 'garbled' | Error, string]>([
    [
      'an untyped internal',
      { kind: 'internal', message: 'Answered.', retry: { kind: 'never' } },
      'Answered.',
    ],
    [
      'a lost reply',
      { kind: 'unavailable', message: 'Lost.', retry: { kind: 'never' } },
      'Lost.',
    ],
    [
      'a reply it could not read',
      'garbled',
      'The cloud sent a reply this app cannot read.',
    ],
    ['no reply at all', new Error('socket hang up'), CLOUD_RUN_UNAVAILABLE],
  ])(
    'reads a preflight that failed with %s as a refusal, never uncertain',
    async (_name, answer, message) => {
      const core = preflightFailing(answer);
      expect(await launchCloudPipelineRun(core.invoker, launch)).toEqual({
        kind: 'refused',
        message,
        uncertain: false,
      });
      expect(core.sends).toEqual([
        'core.pipeline.execution.start',
        'core.pipeline.cloudModels.preflight',
      ]);
    },
  );
});
