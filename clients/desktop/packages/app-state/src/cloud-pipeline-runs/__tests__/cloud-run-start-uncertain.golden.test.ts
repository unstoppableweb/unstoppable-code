import type { CoreCoworkInvoker } from '../../core-cowork/invoker';
import {
  CLOUD_RUN_START_UNCERTAIN,
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
