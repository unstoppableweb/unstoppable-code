import { randomUUID } from 'node:crypto';
import { CanopyClientError } from '@canopy/core-client';
import {
  CLOUD_PIPELINE_RUN_TARGET_ID,
  CloudPipelineRunStartResultSchema,
} from '@canopy/protocol/canopy-core';
import {
  startCloudPipelineRun,
  type CloudPipelineRunCalls,
} from '../cloud-pipeline-runs';

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
