// ADR 23 (CAN-6214, plan CP-21): the records desktop's core leaves when it
// dispatches a pipeline run's start to its in-process worker are the
// reference every other placement of a run start is checked against
// (`DESKTOP_PIPELINE_START_PLACEMENT`). This keeps that reference equal,
// field for field, to what the operation ledger records today.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESKTOP_PIPELINE_START_PLACEMENT,
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  delegationPlacementDifferences,
  type CanopyCallerDescriptor,
  type WorkerPipelineExecutionStartParams,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { createDirectLocalWorkerTransport } from '../../../runtime/local-worker-transport';
import { createWorkerExecutorReceipts } from '../../../runtime/worker-executor-receipts';
import { LocalWorkerExecution, OperationService } from '..';
import { OperationLedger } from '../ledger';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'test-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.pipeline.write'],
};
const START = 'worker.pipeline.execution.start';
const instructions = {
  [START]: WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[START],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipeline-start-placement-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('records a run start on the in-process worker as the reference placement', async () => {
  const receipts = createWorkerExecutorReceipts(instructions);
  const dispatcher = createCanopyDispatcher({
    profile: 'core+worker',
    definitions: { queries: {}, instructions, streams: {} },
    handlers: {
      queries: {},
      instructions: receipts.wrap({
        [START]: (params: WorkerPipelineExecutionStartParams) =>
          Promise.resolve({
            execution: {
              executionId: params.executionId,
              pipelineId: params.pipelineId,
              name: 'Nightly',
              status: 'running',
              runScope: params.runScope,
              definitionSource: params.definitionSource,
              owner: params.owner,
              workspaceId: params.workspaceId,
              worktreeId: params.worktreeId,
              parentExecutionId: null,
              startedAt: new Date().toISOString(),
              completedAt: null,
              pendingPauseCount: 0,
              error: null,
            },
          }),
      }),
      streams: {},
    },
  });
  const operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operation-ledger.sqlite')),
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
  try {
    // As `CorePipelineRuns` starts a run: the run, then its start's dispatch.
    const { operation: run } = await operations.admit({
      kind: 'core.pipeline.run',
      status: 'running',
      origin: { kind: 'client', sourceId: 'desktop-window-1' },
      owner: { kind: 'principal', id: 'local-user' },
      scope: { executionId: 'execution-1' },
    });
    const dispatched = await localWorker.dispatch({
      parentOperationId: run.operationId,
      operation: START,
      params: {
        executionId: 'execution-1',
        pipelineId: 'shared:canopy-cloud:1',
        definitionSource: 'shared',
        runScope: 'global',
        workspaceId: null,
        worktreeId: null,
        owner: 'personal',
        initiationSource: 'user',
      },
      idempotencyKey: 'execution-1',
    });
    const target = (await operations.ready()).getTarget(
      dispatched.delegation.targetId,
    );
    if (target === null) throw new Error('The target is not registered.');
    expect(
      delegationPlacementDifferences(
        DESKTOP_PIPELINE_START_PLACEMENT,
        {
          target,
          delegation: dispatched.delegation,
          lease: await localWorker.lease(),
          child: dispatched.operation,
        },
        { samePlacement: true },
      ),
    ).toEqual([]);
  } finally {
    operations.close();
    await dispatcher.shutdown();
  }
});
