// CAN-6199: the supervisor checkpoints one run by asking its host, including
// a run whose start the host has not answered yet, so the checkpoint never
// answers `running` for a run it did not stop. A fake host records requests
// and lets each test answer.
import { EventEmitter } from 'node:events';
import type {
  CanopyHostExecution,
  WorkerPipelineExecution,
  WorkerPipelineExecutionStartParams,
} from '@canopy/protocol/canopy-core';
import { NO_EXECUTION_SECRETS } from '../../../execution-secrets';
import {
  PipelineHostSupervisor,
  type PipelineHostLaunch,
  type PipelineHostMessage,
  type PipelineHostProcess,
  type PipelineHostRequest,
  type PipelineHostRequestMessage,
} from '..';

class FakeHost extends EventEmitter implements PipelineHostProcess {
  readonly requests: PipelineHostRequestMessage[] = [];

  postMessage(message: PipelineHostRequestMessage): void {
    this.requests.push(message);
    const { request } = message;
    if (request.op === 'configure') this.reply(message.id, null);
    if (request.op === 'checkpoint')
      this.reply(message.id, { checkpointedCount: 0 });
    if (request.op === 'exit') {
      this.reply(message.id, null);
      queueMicrotask(() => this.emit('exit', 0));
    }
  }

  kill(): boolean {
    return true;
  }

  find(op: PipelineHostRequest['op']): PipelineHostRequestMessage | undefined {
    return this.requests.find((message) => message.request.op === op);
  }

  reply(id: number, value: unknown): void {
    const message: PipelineHostMessage = {
      kind: 'response',
      id,
      ok: true,
      value,
    };
    queueMicrotask(() => this.emit('message', message));
  }
}

const startParams: WorkerPipelineExecutionStartParams = {
  executionId: 'run-1',
  pipelineId: 'pipeline',
  definitionSource: 'inline',
  runScope: 'worktree',
  workspaceId: 'workspace',
  worktreeId: 'worktree',
  owner: 'personal',
  initiationSource: 'user',
};

const hostExecution: CanopyHostExecution = {
  childEnvironment: { PATH: '/usr/bin' },
  pipelineLaunch: {
    pipeline: { name: 'p', on: 'dispatch', jobs: {} },
    cwd: '/work/tree',
    bundledActionsDir: '/app/actions',
    env: {},
    secretEnv: {},
  },
};

function projection(
  status: WorkerPipelineExecution['status'],
): WorkerPipelineExecution {
  return {
    executionId: 'run-1',
    pipelineId: 'pipeline',
    name: 'p',
    status,
    runScope: 'worktree',
    definitionSource: 'inline',
    owner: 'personal',
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    parentExecutionId: null,
    startedAt: '2026-11-10T00:00:00.000Z',
    completedAt: null,
    pendingPauseCount: 0,
    ...(status === 'paused' && {
      statusReasonKinds: ['host_rollover' as const],
    }),
    error: null,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

describe('pipeline host supervisor run checkpoint (CAN-6199)', () => {
  it('asks the host to checkpoint a run whose start is still pending', async () => {
    const host = new FakeHost();
    const supervisor = new PipelineHostSupervisor({
      launch: (): PipelineHostProcess => host,
      configure: { dataRoot: '/data' },
      resolveLaunch: (params, execution): Promise<PipelineHostLaunch> =>
        Promise.resolve({
          params,
          launch: execution.pipelineLaunch,
          processEnvironment: execution.childEnvironment,
        }),
      idleStopMs: 3_600_000,
    });
    try {
      const started = supervisor.start(
        startParams,
        new AbortController().signal,
        NO_EXECUTION_SECRETS,
        hostExecution,
      );
      started.catch(() => undefined);
      await settle();
      const start = host.find('start');
      if (!start) throw new Error('No start request.');
      // The start is pending: the host has not answered it.
      const checkpointed = supervisor.checkpointExecution({
        executionId: 'run-1',
        drainMs: 0,
      });
      checkpointed.catch(() => undefined);
      await settle();
      const checkpoint = host.find('checkpointRun');
      expect(checkpoint?.request).toEqual({
        op: 'checkpointRun',
        executionId: 'run-1',
        drainMs: 0,
      });
      expect(host.find('get')).toBeUndefined();
      host.reply(start.id, projection('running'));
      if (!checkpoint) throw new Error('No checkpointRun request.');
      host.reply(checkpoint.id, projection('paused'));
      await started;
      await expect(checkpointed).resolves.toMatchObject({
        status: 'paused',
        statusReasonKinds: ['host_rollover'],
      });
    } finally {
      await supervisor.stop();
    }
  });
});
