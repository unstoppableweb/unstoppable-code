import { randomUUID } from 'node:crypto';
import { CanopyClientError } from '@canopy/core-client';
import { createInMemoryFramedPair } from '@canopy/core-transport';
import {
  CLOUD_MODEL_UNCONFIRMED_CODE,
  CLOUD_PIPELINE_RUN_TARGET_ID,
  CLOUD_RUN_WORKTREE_PREPARING_CODE,
  CloudPipelineRunStartResultSchema,
  KEYED_WRITE_OUTCOME_SHAPES,
  type CanopyErrorPayload,
  type CoreRuntimeInitializeResult,
} from '@canopy/protocol/canopy-core';
import {
  createWebCoreCloudPipelineRunCalls,
  startCloudPipelineRun,
  type CloudPipelineRunCalls,
} from '../cloud-pipeline-runs';

const mockConnectWebCore = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../canopy-cloud/web-core-connection', () => ({
  ...jest.requireActual<object>('../../canopy-cloud/web-core-connection'),
  connectWebCore: (...args: unknown[]): Promise<unknown> =>
    mockConnectWebCore(...args),
}));

jest.mock('electron', () => ({
  app: { isPackaged: false, getVersion: (): string => '0.0.0-golden' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

// CAN-7196 pin: a keyed cloud run start whose answer never came reaches the
// desktop Run dialog's main side as 'unavailable' with retry 'never' (S7c's
// wire shape). Main answers it as an uncertain start, so the dialog keeps the
// launch's key, and the next press sends the same key, which the web core
// answers with the run it recorded: one run, never two.

function operationFor(key: string): Record<string, unknown> {
  const operationId = randomUUID();
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
  lostKind: 'unavailable' | 'deadline_exceeded' = 'unavailable',
  lostRetry: 'never' | 'same_idempotency_key' = 'never',
): {
  readonly calls: CloudPipelineRunCalls;
  readonly runs: Map<string, Record<string, unknown>>;
} {
  const runs = new Map<string, Record<string, unknown>>();
  const unexpected = (): never => {
    throw new Error('Only the start is expected.');
  };
  return {
    runs,
    calls: {
      manifest: unexpected,
      preflight: unexpected,
      request: unexpected,
      start: (_params, key) => {
        const recorded = runs.get(key);
        if (recorded === undefined) {
          runs.set(key, operationFor(key));
          return Promise.reject(
            new CanopyClientError({
              kind: lostKind,
              message: 'The response was lost.',
              retry: { kind: lostRetry },
            }),
          );
        }
        return Promise.resolve(
          CloudPipelineRunStartResultSchema.parse({
            operation: recorded,
            statusReason: null,
            admission: 'admitted',
            replayed: true,
          }),
        );
      },
    },
  };
}

describe('a desktop cloud run start whose answer never came (CAN-7196)', () => {
  // The client's own deadline after dispatch arrives as 'deadline_exceeded'
  // with a same-key retry, and it stays uncertain too.
  it.each([
    ['unavailable', 'never'],
    ['deadline_exceeded', 'same_idempotency_key'],
  ] as const)(
    'answers a lost start read as %s with retry %s as uncertain, and a same-key press starts one run',
    async (lostKind, lostRetry) => {
      const { calls, runs } = webCore(lostKind, lostRetry);
      const request = {
        targetId: CLOUD_PIPELINE_RUN_TARGET_ID,
        pipelineId: 'curated:golden-review',
        scope: 'global',
        requestedOwner: 'personal',
        cloudIdempotencyKey: 'golden-key',
      };
      expect(await startCloudPipelineRun(request, calls)).toEqual({
        success: false,
        errorCode: 'cloud_start_uncertain',
        error:
          "Couldn't confirm the cloud run started. Try again; it won't start twice.",
      });
      expect(await startCloudPipelineRun(request, calls)).toMatchObject({
        success: true,
        cloudRun: { replayed: true },
      });
      expect(runs.size).toBe(1);
    },
  );
});

const UNCERTAIN =
  "Couldn't confirm the cloud run started. Try again; it won't start twice.";

/** A web core that refuses every start with one error, counting the sends. */
function refusingWebCore(error: CanopyErrorPayload | Error): {
  readonly calls: CloudPipelineRunCalls;
  readonly sends: () => number;
} {
  let sends = 0;
  const unexpected = (): never => {
    throw new Error('Only the start is expected.');
  };
  return {
    sends: () => sends,
    calls: {
      manifest: unexpected,
      preflight: unexpected,
      request: unexpected,
      start: () => {
        sends += 1;
        return Promise.reject(
          error instanceof Error ? error : new CanopyClientError(error),
        );
      },
    },
  };
}

async function startRefusedWith(error: CanopyErrorPayload | Error): Promise<{
  readonly errorCode: string | undefined;
  readonly sends: number;
}> {
  const core = refusingWebCore(error);
  const result = await startCloudPipelineRun(
    {
      targetId: CLOUD_PIPELINE_RUN_TARGET_ID,
      pipelineId: 'curated:golden-review',
      scope: 'global',
      requestedOwner: 'personal',
      cloudIdempotencyKey: 'golden-key',
    },
    core.calls,
  );
  if (result.success) throw new Error('The start was not refused.');
  if (result.errorCode === 'cloud_start_uncertain')
    expect(result.error).toBe(UNCERTAIN);
  return { errorCode: result.errorCode, sends: core.sends() };
}

// CAN-6995 S7c: main reads every keyed-write answer through the shared check,
// so the desktop Run dialog agrees with every other cloud surface, and main
// never sends a start again on its own.
describe('a refused desktop cloud run start, read through the shared keyed-write check (S7c)', () => {
  it.each(KEYED_WRITE_OUTCOME_SHAPES.map((shape) => [shape.name, shape]))(
    'reads %s as the shared table does',
    async (_name, shape) => {
      const read = await startRefusedWith(shape.payload);
      expect(read.errorCode === 'cloud_start_uncertain').toBe(shape.unknown);
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
  it.each(kinds)(
    'an answer of %s that will never be retried is definite unless it is a lost reply or an untyped fault',
    async (kind) => {
      const read = await startRefusedWith({
        kind,
        message: 'Answered.',
        retry: { kind: 'never' },
      });
      // CAN-7470: an internal failure with no code may have been recorded.
      expect(read.errorCode === 'cloud_start_uncertain').toBe(
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
      expect(read.errorCode === 'cloud_start_uncertain').toBe(
        kind === 'unavailable',
      );
      expect(read.sends).toBe(1);
    },
  );
  it.each(kinds)(
    'an answer of %s that asks for the same key again could not be confirmed',
    async (kind) => {
      expect(
        await startRefusedWith({
          kind,
          message: 'Answered.',
          retry: { kind: 'same_idempotency_key' },
        }),
      ).toEqual({ errorCode: 'cloud_start_uncertain', sends: 1 });
    },
  );

  it('a send with no answer could not be confirmed', async () => {
    expect(await startRefusedWith(new Error('socket hang up'))).toEqual({
      errorCode: 'cloud_start_uncertain',
      sends: 1,
    });
  });

  it('keeps a task worktree still being set up as its own refusal', async () => {
    expect(
      await startRefusedWith({
        kind: 'unavailable',
        code: CLOUD_RUN_WORKTREE_PREPARING_CODE,
        message: 'The cloud worktree is being set up.',
        retry: { kind: 'same_idempotency_key' },
      }),
    ).toEqual({ errorCode: 'cloud_worktree_preparing', sends: 1 });
  });
});

// CAN-7470: through main's real client, a start whose result it can't read
// arrives as the client's own internal error with no code. It may have been
// recorded, so main answers it as an uncertain start, sent once.
describe('a desktop cloud run start whose result main could not read (CAN-7470)', () => {
  const INITIALIZE: CoreRuntimeInitializeResult = {
    runtime: {
      runtimeId: 'runtime-1',
      hostId: 'host-1',
      authorityId: 'authority-1',
      profile: 'core+worker',
      daemonEpoch: 'epoch-1',
      protocolVersions: [1],
      state: 'ready',
      buildVersion: '0.0.0-golden',
    },
    selectedProtocolVersion: 1,
    capabilities: {
      operations: ['core.pipeline.execution.start'],
      events: [],
      streams: [],
    },
    limits: {},
    authentication: { required: true, methods: [] },
  };

  /** A web core main's real client reaches in memory, answering `answer`. */
  async function serveStartCore(answer: unknown): Promise<{
    readonly methods: string[];
    readonly done: Promise<void>;
  }> {
    const { client, server } = await createInMemoryFramedPair();
    const methods: string[] = [];
    const done = (async (): Promise<void> => {
      for (;;) {
        const message = await server.receive().catch(() => null);
        if (!message) return;
        if (!('method' in message) || !('id' in message)) continue;
        methods.push(message.method);
        await server
          .send({
            jsonrpc: '2.0',
            id: message.id,
            result:
              message.method === 'core.runtime.initialize'
                ? INITIALIZE
                : answer,
          })
          .catch(() => undefined);
      }
    })();
    mockConnectWebCore.mockImplementationOnce(() => Promise.resolve(client));
    return { methods, done };
  }

  it('reads a start whose result main could not read as uncertain, sent once', async () => {
    const core = await serveStartCore({ unexpected: 'reply' });
    const calls = createWebCoreCloudPipelineRunCalls(
      {
        isEnabled: () => true,
        readCredentials: () => Promise.reject(new Error('Not read here.')),
        onAccountChange: () => (): void => undefined,
      },
      '0.0.0-golden',
    );
    const result = await startCloudPipelineRun(
      {
        targetId: CLOUD_PIPELINE_RUN_TARGET_ID,
        pipelineId: 'curated:golden-review',
        scope: 'global',
        requestedOwner: 'personal',
        cloudIdempotencyKey: 'golden-garbled-start',
      },
      calls,
    );
    expect(result).toMatchObject({
      success: false,
      errorCode: 'cloud_start_uncertain',
      error: UNCERTAIN,
    });
    await core.done;
    expect(core.methods).toEqual([
      'core.runtime.initialize',
      'core.pipeline.execution.start',
    ]);
  });
});

// CAN-7470: a start refused for its cloud models recorded nothing, so the
// model preflight main reads next is not a keyed write. However that read
// fails, the start is refused, never uncertain.
describe('the desktop model preflight after a start that recorded nothing (CAN-7470)', () => {
  it.each<[string, CanopyErrorPayload | Error, string]>([
    [
      'an untyped internal',
      { kind: 'internal', message: 'Answered.', retry: { kind: 'never' } },
      'cloud_run_refused',
    ],
    [
      'a lost reply',
      { kind: 'unavailable', message: 'Lost.', retry: { kind: 'never' } },
      'cloud_run_refused',
    ],
    ['no reply at all', new Error('socket hang up'), 'cloud_unavailable'],
  ])(
    'reads a preflight that failed with %s as a refusal, never uncertain',
    async (_name, error, errorCode) => {
      const sent: string[] = [];
      const unexpected = (): never => {
        throw new Error('Only the start and the preflight are expected.');
      };
      const result = await startCloudPipelineRun(
        {
          targetId: CLOUD_PIPELINE_RUN_TARGET_ID,
          pipelineId: 'curated:golden-review',
          scope: 'global',
          requestedOwner: 'personal',
          cloudIdempotencyKey: 'golden-preflight',
        },
        {
          manifest: unexpected,
          request: unexpected,
          start: () => {
            sent.push('start');
            return Promise.reject(
              new CanopyClientError({
                kind: 'failed_precondition',
                code: CLOUD_MODEL_UNCONFIRMED_CODE,
                message: 'Choose cloud models for the steps that need them.',
                retry: { kind: 'never' },
              }),
            );
          },
          preflight: () => {
            sent.push('preflight');
            return Promise.reject(
              error instanceof Error ? error : new CanopyClientError(error),
            );
          },
        },
      );
      expect(result).toMatchObject({ success: false, errorCode });
      expect(sent).toEqual(['start', 'preflight']);
    },
  );
});
