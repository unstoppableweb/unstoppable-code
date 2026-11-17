// CAN-4175: restart recovery of one source of an origin kind. The pipeline
// transient-retry source resumes its own interrupted runs, while every other
// source of the same kind (the code-graph scheduler, base maintenance) keeps
// ending as interrupted, and whole-kind recovery (hooks) is unchanged. Real
// operation ledger on disk, reopened to model a restart.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  OperationOrigin,
  OperationRecord,
} from '@canopy/protocol/canopy-core';
import { OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import type { OperationRecovery } from '../../operations/service';
import {
  InitiatedWorkEngine,
  type InitiatedWorkExecution,
  type InitiatedWorkRecoverableOrigin,
  type InitiatedWorkResumer,
  type InitiatedWorkResumption,
} from '../engine';

const RETRY_SOURCE = 'pipeline.transient-retry';
const RECOVERABLE: readonly InitiatedWorkRecoverableOrigin[] = [
  'hook',
  { kind: 'system', sourceId: RETRY_SOURCE },
];
const OWNER = { kind: 'principal' as const, id: 'local' };
const SCOPE = { workspaceId: 'p', worktreeId: 'a' };

let dir: string;
let operations: OperationService;
let engine: InitiatedWorkEngine;

function open(recoverable = RECOVERABLE): void {
  operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operations.sqlite'), {
        retryWindowMs: 1_000,
      }),
  });
  engine = new InitiatedWorkEngine({
    operations,
    recoverableOrigins: recoverable,
  });
}

function origin(
  kind: OperationOrigin['kind'],
  sourceId: string,
  occurrenceKey: string,
): OperationOrigin {
  return { kind, sourceId, occurrenceKey };
}

async function accept(runOrigin: OperationOrigin): Promise<string> {
  const [acceptance] = await engine.acceptOccurrence({
    runs: [
      {
        origin: runOrigin,
        owner: OWNER,
        scope: SCOPE,
        targetKey: `target:${runOrigin.sourceId}`,
      },
    ],
  });
  if (acceptance?.status !== 'accepted')
    throw new Error('Expected an accepted run');
  return acceptance.operationId;
}

interface ObservedResumer extends InitiatedWorkResumer {
  resumed: string[];
  reconciled: string[];
}

function resumer(
  reconcileAs: OperationRecovery = { status: 'completed' },
): ObservedResumer {
  const resumed: string[] = [];
  const reconciled: string[] = [];
  return {
    resumed,
    reconciled,
    targetKey: (operation: OperationRecord): string =>
      `target:${operation.origin.sourceId}`,
    resume: (
      operation: OperationRecord,
    ): Promise<InitiatedWorkResumption<null>> => {
      resumed.push(operation.operationId);
      return Promise.resolve({
        status: 'resume',
        request: {
          gates: [],
          execute: () =>
            Promise.resolve({
              value: null,
              result: { status: 'succeeded', exitCode: 0, durationMs: 0 },
            }),
        },
      });
    },
    reconcile: (operation: OperationRecord): Promise<OperationRecovery> => {
      reconciled.push(operation.operationId);
      return Promise.resolve(reconcileAs);
    },
  };
}

async function restart(): Promise<void> {
  engine.stopStarting();
  operations.close();
  open();
  await operations.ready();
}

async function settled(operationId: string): Promise<OperationRecord> {
  const operation = await operations.waitForTerminal(operationId);
  return operation;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'initiated-work-source-recovery-'));
  open();
});

afterEach(() => {
  operations.close();
  rmSync(dir, { recursive: true, force: true });
});

it('resumes the recoverable source and ends other runs of its kind as interrupted', async () => {
  const retry = await accept(origin('system', RETRY_SOURCE, 'retry-1'));
  const codeGraph = await accept(
    origin('system', 'code-graph.scheduler', 'build-1'),
  );
  const hook = await accept(origin('hook', 'project:pr:create', 'hook-1'));

  await restart();
  const retries = resumer();
  const hooks = resumer();
  engine.registerResumer('system', retries, { sourceId: RETRY_SOURCE });
  engine.registerResumer('hook', hooks);

  expect(await settled(retry)).toMatchObject({ status: 'completed' });
  expect(await settled(hook)).toMatchObject({ status: 'completed' });
  expect(await settled(codeGraph)).toMatchObject({
    status: 'failed',
    error: { code: 'core.operation.interrupted' },
  });
  expect(retries.resumed).toEqual([retry]);
  expect(hooks.resumed).toEqual([hook]);
});

it('reconciles a run of the source that may have started, and never runs it again', async () => {
  let started = (): void => undefined;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  void engine.submit({
    origin: origin('system', RETRY_SOURCE, 'retry-started'),
    owner: OWNER,
    scope: SCOPE,
    targetKey: `target:${RETRY_SOURCE}`,
    gates: [],
    execute: () => {
      started();
      return new Promise<InitiatedWorkExecution<null>>(() => undefined);
    },
  });
  await running;
  const [live] = engine.liveRuns();
  const operationId = live?.operationId;
  if (!operationId) throw new Error('Expected a live run');

  await restart();
  const retries = resumer({ status: 'completed' });
  engine.registerResumer('system', retries, { sourceId: RETRY_SOURCE });

  expect(await settled(operationId)).toMatchObject({ status: 'completed' });
  expect(retries.reconciled).toEqual([operationId]);
  expect(retries.resumed).toEqual([]);
});

it('accepts a resumer only for a recoverable kind or source, once', () => {
  expect(() => engine.registerResumer('system', resumer())).toThrow(
    'not recoverable',
  );
  expect(() =>
    engine.registerResumer('system', resumer(), {
      sourceId: 'code-graph.scheduler',
    }),
  ).toThrow('not recoverable');
  engine.registerResumer('system', resumer(), { sourceId: RETRY_SOURCE });
  expect(() =>
    engine.registerResumer('system', resumer(), { sourceId: RETRY_SOURCE }),
  ).toThrow('already has a resumer');
});

it('ends every system run as interrupted when no system source is recoverable', async () => {
  operations.close();
  open(['hook']);
  const retry = await accept(origin('system', RETRY_SOURCE, 'retry-1'));

  engine.stopStarting();
  operations.close();
  open(['hook']);
  await operations.ready();

  expect(await settled(retry)).toMatchObject({
    status: 'failed',
    error: { code: 'core.operation.interrupted' },
  });
});
