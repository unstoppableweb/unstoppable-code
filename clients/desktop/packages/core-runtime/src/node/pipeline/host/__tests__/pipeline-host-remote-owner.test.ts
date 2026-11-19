// CAN-6102: with a remote owner, such as the web core over the relay, the
// supervisor's owner timers follow the delegation lease, owner loss pauses
// with `owner_lost`, and a hung owner pauses its run instead of failing the
// step. A fake host records requests and lets each test answer.
import { EventEmitter } from 'node:events';
import type {
  CanopyHostExecution,
  WorkerPipelineExecution,
  WorkerPipelineExecutionStartParams,
  WorkerPipelineHostRequest,
  WorkerPipelineHostRequestsItem,
} from '@canopy/protocol/canopy-core';
import type { CanopyHandlerContext } from '../../../../runtime/types';
import { NO_EXECUTION_SECRETS } from '../../../execution-secrets';
import { createPipelineOwnerChannel } from '../../execution';
import {
  PipelineHostSupervisor,
  type PipelineHostLaunch,
  type PipelineHostMessage,
  type PipelineHostProcess,
  type PipelineHostRequest,
  type PipelineHostRequestMessage,
  type PipelineHostSupervisorOptions,
} from '..';

class FakeHost extends EventEmitter implements PipelineHostProcess {
  readonly requests: PipelineHostRequestMessage[] = [];

  /** Leaves each `hostSettled` unacknowledged, as a slow host does. */
  holdSettled = false;

  postMessage(message: PipelineHostRequestMessage): void {
    this.requests.push(message);
    const { request } = message;
    if (
      request.op === 'configure' ||
      (request.op === 'hostSettled' && !this.holdSettled)
    )
      this.reply(message.id, null);
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

  of<O extends PipelineHostRequest['op']>(
    op: O,
  ): Array<Extract<PipelineHostRequest, { op: O }>> {
    return this.requests
      .map(({ request }) => request)
      .filter(
        (request): request is Extract<PipelineHostRequest, { op: O }> =>
          request.op === op,
      );
  }

  last(op: PipelineHostRequest['op']): PipelineHostRequestMessage {
    const found = [...this.requests]
      .reverse()
      .find((message) => message.request.op === op);
    if (!found) throw new Error(`No ${op} request.`);
    return found;
  }

  reply(id: number, value: unknown): void {
    this.send({ kind: 'response', id, ok: true, value });
  }

  send(message: PipelineHostMessage): void {
    queueMicrotask(() => this.emit('message', message));
  }

  /** Delivers messages in one turn, as one read chunk does. */
  sendTogether(...messages: PipelineHostMessage[]): void {
    queueMicrotask(() => {
      for (const message of messages) this.emit('message', message);
    });
  }
}

function startParams(executionId: string): WorkerPipelineExecutionStartParams {
  return {
    executionId,
    pipelineId: 'pipeline',
    definitionSource: 'inline',
    runScope: 'worktree',
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    owner: 'personal',
    initiationSource: 'user',
  };
}

function hostExecution(ownerBound: boolean): CanopyHostExecution {
  return {
    childEnvironment: { PATH: '/usr/bin' },
    pipelineLaunch: {
      pipeline: { name: 'p', on: 'dispatch', jobs: {} },
      cwd: '/work/tree',
      bundledActionsDir: '/app/actions',
      env: {},
      secretEnv: {},
      ...(ownerBound && { ownerBound: true }),
    },
  };
}

function projection(executionId: string): WorkerPipelineExecution {
  return {
    executionId,
    pipelineId: 'pipeline',
    name: 'p',
    status: 'running',
    runScope: 'worktree',
    definitionSource: 'inline',
    owner: 'personal',
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    parentExecutionId: null,
    startedAt: '2026-11-06T00:00:00.000Z',
    completedAt: null,
    pendingPauseCount: 0,
    error: null,
  };
}

function hostRequest(
  executionId: string,
  requestId: string,
): WorkerPipelineHostRequest {
  return {
    requestId,
    executionId,
    jobId: 'j',
    stepId: 's',
    childExecutionId: null,
    attempt: 0,
    iteration: 0,
    owner: 'personal',
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    request: {
      action: 'create-worktree',
      projectId: 'workspace',
      branch: { kind: 'new', name: 'b' },
      repair: false,
      setup: 'skip',
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

const context = {} as CanopyHandlerContext;

const LEASE_TTL_MS = 10 * 60_000;

function harness(
  prepareOwnerRun?: PipelineHostSupervisorOptions['prepareOwnerRun'],
): {
  hosts: FakeHost[];
  supervisor: PipelineHostSupervisor;
  channel: ReturnType<typeof createPipelineOwnerChannel>;
  launch: jest.Mock<PipelineHostProcess, []>;
} {
  const hosts: FakeHost[] = [];
  const channel = createPipelineOwnerChannel();
  const launch = jest.fn<PipelineHostProcess, []>(() => {
    const host = new FakeHost();
    hosts.push(host);
    return host;
  });
  const supervisor = new PipelineHostSupervisor({
    launch,
    configure: { dataRoot: '/data' },
    resolveLaunch: (params, execution): Promise<PipelineHostLaunch> =>
      Promise.resolve({
        params,
        launch: execution.pipelineLaunch,
        processEnvironment: execution.childEnvironment,
      }),
    idleStopMs: 3_600_000,
    owner: channel,
    remoteOwner: { leaseTtlMs: LEASE_TTL_MS },
    ...(prepareOwnerRun && { prepareOwnerRun }),
  });
  return { hosts, supervisor, channel, launch };
}

/** An owner subscription through the channel's own stream handler. */
async function subscribeOwner(
  channel: ReturnType<typeof createPipelineOwnerChannel>,
): Promise<{ items: WorkerPipelineHostRequestsItem[]; stop: () => void }> {
  const items: WorkerPipelineHostRequestsItem[] = [];
  const stopped = await channel.handlers.streams[
    'worker.pipeline.hostRequests'
  ]({}, context, {
    emit: (item: WorkerPipelineHostRequestsItem) => {
      items.push(item);
      return { epoch: 'e', sequence: items.length };
    },
    emitAt: () => null,
    end: () => undefined,
    endAt: () => undefined,
  } as never);
  return { items, stop: stopped ?? ((): void => undefined) };
}

async function startRun(
  h: ReturnType<typeof harness>,
  executionId: string,
  ownerBound: boolean,
): Promise<FakeHost> {
  const result = h.supervisor.start(
    startParams(executionId),
    new AbortController().signal,
    NO_EXECUTION_SECRETS,
    hostExecution(ownerBound),
  );
  await settle();
  const host = h.hosts[h.hosts.length - 1];
  host.reply(host.last('start').id, projection(executionId));
  await result;
  return host;
}

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'],
  });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('pipeline host supervisor with a remote owner (CAN-6102)', () => {
  it('never substitutes local daemon answers for a remote owner or exposes the local Ledger folder', async () => {
    const answer = jest.fn(() => Promise.resolve(undefined));
    const h = harness(answer);
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    const request: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'ledger-1'),
      request: {
        action: 'owner.ledger.operation',
        attemptKey: 'a',
        cwd: '/local/work/tree',
        operation: 'core.ledger.entries.search',
        params: {},
      },
    };
    host.send({ kind: 'hostRequest', request });
    await settle();
    expect(answer).not.toHaveBeenCalled();
    expect(owner.items).toEqual([
      {
        ...request,
        request: {
          action: 'owner.ledger.operation',
          attemptKey: 'a',
          operation: 'core.ledger.entries.search',
          params: {},
        },
      },
    ]);
    owner.stop();
    expect(host.of('ledgerOwnerAvailability')).toEqual([]);
    await h.supervisor.stop();
  });
  it('keeps owner-bound runs going through a five-minute owner outage and holds its host requests', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    owner.stop();
    jest.advanceTimersByTime(60_000);
    // A host step raised mid-outage waits for the owner instead of failing.
    host.send({
      kind: 'hostRequest',
      request: hostRequest('run-1', 'request-1'),
    });
    await settle();
    jest.advanceTimersByTime(4 * 60_000);
    await settle();
    expect(host.of('pause')).toEqual([]);
    expect(host.of('hostSettled')).toEqual([]);

    const back = await subscribeOwner(h.channel);
    await settle();
    expect(
      back.items.map((item) => ('withdrawn' in item ? null : item.requestId)),
    ).toEqual(['request-1']);
    jest.advanceTimersByTime(LEASE_TTL_MS);
    await settle();
    expect(host.of('pause')).toEqual([]);
    back.stop();
    await h.supervisor.stop();
  });

  it('pauses owner-bound runs with owner_lost once the lease lapses', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'bound', true);
    await startRun(h, 'free', false);
    owner.stop();
    jest.advanceTimersByTime(LEASE_TTL_MS - 1);
    await settle();
    expect(host.of('pause')).toEqual([]);
    jest.advanceTimersByTime(1);
    await settle();
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['bound'], reason: 'owner_lost' },
    ]);
    host.reply(host.last('pause').id, { pausedCount: 1 });
    await settle();
    await h.supervisor.stop();
  });

  it('pauses a run with owner_lost instead of failing it when the owner stops answering', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    const request: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'owner:run-1:1'),
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      request: { action: 'owner.model.policy', check: 'active' },
    };
    host.send({ kind: 'hostRequest', request });
    await settle();
    expect(owner.items).toEqual([request]);
    // The owner stays subscribed and never answers.
    jest.advanceTimersByTime(114_999);
    await settle();
    expect(host.of('pause')).toEqual([]);
    jest.advanceTimersByTime(1);
    await settle();
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['run-1'], reason: 'owner_lost' },
    ]);
    expect(host.of('hostSettled')).toEqual([]);
    host.reply(host.last('pause').id, { pausedCount: 1 });
    // The paused run withdraws its request, as the host does.
    host.send({
      kind: 'hostRequestWithdrawn',
      executionId: 'run-1',
      requestId: 'owner:run-1:1',
    });
    await settle();
    expect(owner.items[1]).toEqual({
      withdrawn: true,
      executionId: 'run-1',
      requestId: 'owner:run-1:1',
    });
    owner.stop();
    await h.supervisor.stop();
  });

  it('does not pause a run whose owner answered just before the deadline', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    host.holdSettled = true;
    const request: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'owner:run-1:1'),
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      request: { action: 'owner.model.policy', check: 'active' },
    };
    host.send({ kind: 'hostRequest', request });
    await settle();
    jest.advanceTimersByTime(114_000);
    await h.channel.handlers.instructions[
      'worker.pipeline.hostRequest.respond'
    ](
      {
        executionId: 'run-1',
        requestId: 'owner:run-1:1',
        result: {
          status: 'owner',
          value: { kind: 'model.policy', answer: true },
        },
      },
      context,
    );
    await settle();
    expect(host.of('hostSettled')).toHaveLength(1);
    // The host has not acknowledged the settlement yet.
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(host.of('pause')).toEqual([]);
    host.reply(host.last('hostSettled').id, null);
    await settle();
    owner.stop();
    await h.supervisor.stop();
  });
});
