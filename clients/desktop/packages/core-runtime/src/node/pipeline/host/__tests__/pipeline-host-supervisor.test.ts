// CAN-5086: the supervisor that runs host-local pipeline launches in a
// pipeline host. A fake host records requests and lets each test answer.
import { EventEmitter } from 'node:events';
import {
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
  type CanopyErrorPayload,
  type CanopyHostExecution,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionDetail,
  type WorkerPipelineExecutionEventsItem,
  type WorkerPipelineExecutionStartParams,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../../runtime/dispatcher';
import {
  NO_EXECUTION_SECRETS,
  refusingExecutionSecretSource,
} from '../../../execution-secrets';
import { createWorkerPipelineHandlers } from '../../execution';
import type { CanopyHandlerContext } from '../../../../runtime/types';
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
    if (message.request.op === 'configure') this.reply(message.id, null);
  }

  kill(): boolean {
    return true;
  }

  ops(): Array<PipelineHostRequest['op']> {
    return this.requests.map((message) => message.request.op);
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

  exit(code: number): void {
    this.emit('exit', code);
  }
}

const params: WorkerPipelineExecutionStartParams = {
  executionId: 'run',
  pipelineId: 'pipeline',
  definitionSource: 'inline',
  runScope: 'worktree',
  workspaceId: 'workspace',
  worktreeId: 'worktree',
  owner: 'personal',
  initiationSource: 'user',
};
const execution: CanopyHostExecution = {
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
    executionId: 'run',
    pipelineId: 'pipeline',
    name: 'p',
    status,
    runScope: 'worktree',
    definitionSource: 'inline',
    owner: 'personal',
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    parentExecutionId: null,
    startedAt: '2026-11-05T00:00:00.000Z',
    completedAt: null,
    pendingPauseCount: 0,
    error: null,
  };
}

/** The smallest detail a host may answer (CAN-6117). */
function detail(): WorkerPipelineExecutionDetail {
  return {
    revision: 'a'.repeat(64),
    definition: { contentHash: null, revision: null, packageDigest: null },
    initiation: {
      source: 'user',
      initiator: { kind: 'user' },
      hook: null,
      event: 'dispatch',
      rerunSourceId: null,
      parentStep: null,
    },
    rerun: {
      inputsPersisted: true,
      planReadyText: false,
      taskReadyText: false,
    },
    hidden: false,
    pausedAt: null,
    pausedMs: 0,
    plan: null,
    artifacts: [],
    jobs: [],
    pendingPauses: [],
    statusReasons: [],
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

function harness(overrides: { launch?: () => PipelineHostProcess } = {}): {
  hosts: FakeHost[];
  supervisor: PipelineHostSupervisor;
  launch: jest.Mock<PipelineHostProcess, []>;
  holds: string[];
  releases: jest.Mock<void, [string]>;
  killed: number[];
} {
  const hosts: FakeHost[] = [];
  const holds: string[] = [];
  const releases = jest.fn<void, [string]>();
  const killed: number[] = [];
  const launch = jest.fn<PipelineHostProcess, []>(
    overrides.launch ??
      ((): PipelineHostProcess => {
        const host = new FakeHost();
        hosts.push(host);
        return host;
      }),
  );
  const resolved: PipelineHostLaunch = {
    params,
    launch: execution.pipelineLaunch ?? {
      pipeline: {},
      cwd: '/',
      bundledActionsDir: '/',
      env: {},
      secretEnv: {},
    },
    processEnvironment: execution.childEnvironment,
  };
  const supervisor = new PipelineHostSupervisor({
    launch,
    configure: { dataRoot: '/data' },
    resolveLaunch: (): Promise<PipelineHostLaunch> => Promise.resolve(resolved),
    holdExecution: (id): (() => void) => {
      holds.push(id);
      return (): void => releases(id);
    },
    killProcessGroup: (group): void => {
      killed.push(group);
    },
    idleStopMs: 60_000,
  });
  return { hosts, supervisor, launch, holds, releases, killed };
}

async function started(
  h: ReturnType<typeof harness>,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ host: FakeHost; result: Promise<WorkerPipelineExecution> }> {
  const result = h.supervisor.start(
    params,
    signal,
    NO_EXECUTION_SECRETS,
    execution,
  );
  await settle();
  const host = h.hosts[h.hosts.length - 1];
  return { host, result };
}

describe('PipelineHostSupervisor', () => {
  it('refuses a start without a pipeline launch before starting a host', async () => {
    const h = harness();
    await expect(
      h.supervisor.start(
        params,
        new AbortController().signal,
        NO_EXECUTION_SECRETS,
        { childEnvironment: {} },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.launchUnavailable' },
    });
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('answers hostUnavailable when the host cannot start, and sends nothing', async () => {
    const posted: unknown[] = [];
    const h = harness({
      launch: () => {
        posted.push('launch');
        throw new Error('spawn failed');
      },
    });
    await expect(
      h.supervisor.start(
        params,
        new AbortController().signal,
        NO_EXECUTION_SECRETS,
        execution,
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.hostUnavailable' },
    });
    expect(h.hosts).toHaveLength(0);
  });

  it('joins a resent start for an execution its host is running', async () => {
    const h = harness();
    const { host, result } = await started(h);
    host.reply(host.last('start').id, projection('running'));
    await expect(result).resolves.toMatchObject({ status: 'running' });

    const resent = h.supervisor.start(
      params,
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
      execution,
    );
    await settle();
    host.reply(host.last('get').id, projection('running'));
    await expect(resent).resolves.toMatchObject({ executionId: 'run' });
    expect(host.ops().filter((op) => op === 'start')).toHaveLength(1);
    expect(host.ops().filter((op) => op === 'get')).toHaveLength(1);
  });

  it('does not cancel a started run when the start’s signal aborts', async () => {
    const h = harness();
    const controller = new AbortController();
    const { host, result } = await started(h, controller.signal);
    controller.abort();
    host.reply(host.last('start').id, projection('running'));
    await expect(result).resolves.toMatchObject({ status: 'running' });
    expect(host.ops()).not.toContain('cancel');
  });

  it('holds the daemon up from start until the execution pauses or ends', async () => {
    const h = harness();
    const { host, result } = await started(h);
    host.reply(host.last('start').id, projection('running'));
    await result;
    expect(h.holds).toEqual(['run']);
    host.send({
      kind: 'execution',
      executionId: 'run',
      event: 'execution.updated',
      execution: projection('running'),
    });
    await settle();
    expect(h.releases).not.toHaveBeenCalled();
    host.send({
      kind: 'execution',
      executionId: 'run',
      event: 'execution.paused',
      execution: projection('paused'),
    });
    await settle();
    expect(h.releases).toHaveBeenCalledTimes(1);
  });

  it('a lost host kills its step process groups and ends its streams with hostLost', async () => {
    const h = harness();
    const { host, result } = await started(h);
    host.reply(host.last('start').id, projection('running'));
    await result;

    const handlers = createWorkerPipelineHandlers(h.supervisor, {
      secrets: refusingExecutionSecretSource,
    });
    const items: WorkerPipelineExecutionEventsItem[] = [];
    const ends: Array<{ outcome: string; error?: CanopyErrorPayload }> = [];
    const context: CanopyHandlerContext = {
      requestId: 'events',
      caller: {
        principalId: 'client',
        clientInstanceId: 'client',
        authorityId: 'authority',
        interfaceKind: 'daemon',
        grants: ['worker.pipeline.read'],
      },
      metadata: {},
      signal: new AbortController().signal,
    };
    const opened = handlers.streams['worker.pipeline.execution.events'](
      { executionId: 'run' },
      context,
      {
        emit: (item) => {
          items.push(item);
          return { daemonEpoch: 'e', sequence: items.length };
        },
        end: (outcome, error) => {
          ends.push({ outcome, error });
        },
      },
    );
    await settle();
    host.reply(host.last('get').id, projection('running'));
    await settle();
    host.reply(host.last('get').id, projection('running'));
    await opened;

    host.send({
      kind: 'process',
      state: 'started',
      id: 'step-1',
      processGroupId: 4242,
    });
    await settle();
    host.exit(1);
    await settle();

    expect(h.killed).toEqual([4242]);
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome).toBe('error');
    expect(ends[0].error?.code).toBe('worker.pipeline.hostLost');
    expect(h.releases).toHaveBeenCalledWith('run');

    const later = h.supervisor.get('run');
    await settle();
    expect(h.hosts).toHaveLength(2);
    h.hosts[1].reply(h.hosts[1].last('get').id, null);
    await expect(later).resolves.toBeNull();
  });

  // Review fix: a run that settles in the same tick as its start response.
  it('takes no hold for a run that settled before its start returned', async () => {
    const h = harness();
    const { host, result } = await started(h);
    host.emit('message', {
      kind: 'response',
      id: host.last('start').id,
      ok: true,
      value: projection('running'),
    });
    host.emit('message', {
      kind: 'execution',
      executionId: 'run',
      event: 'execution.paused',
      execution: projection('paused'),
    });
    await result;
    await settle();
    expect(h.holds.length).toBe(h.releases.mock.calls.length);
  });

  // Review fix: a host killed at stop takes its step process groups with it.
  it('kills step process groups when stop has to kill the host', async () => {
    const h = harness();
    const { host, result } = await started(h);
    host.reply(host.last('start').id, projection('running'));
    await result;
    host.send({
      kind: 'process',
      state: 'started',
      id: 'step-1',
      processGroupId: 4343,
    });
    await settle();
    host.kill = (): boolean => {
      host.exit(137);
      return true;
    };
    const stopped = h.supervisor.stop();
    await settle();
    host.send({
      kind: 'response',
      id: host.last('checkpoint').id,
      ok: false,
      error: { code: 'checkpoint_failed', message: 'stuck' },
    });
    await stopped;
    expect(h.killed).toEqual([4343]);
  }, 15_000);

  // Review fix: a second client can follow a run whose start is still pending.
  it('an events stream opened during a pending start follows the run', async () => {
    const h = harness();
    const { host, result } = await started(h);
    const handlers = createWorkerPipelineHandlers(h.supervisor, {
      secrets: refusingExecutionSecretSource,
    });
    const items: WorkerPipelineExecutionEventsItem[] = [];
    const ends: string[] = [];
    const opened = handlers.streams['worker.pipeline.execution.events'](
      { executionId: 'run' },
      {
        requestId: 'events',
        caller: {
          principalId: 'client',
          clientInstanceId: 'second',
          authorityId: 'authority',
          interfaceKind: 'daemon',
          grants: ['worker.pipeline.read'],
        },
        metadata: {},
        signal: new AbortController().signal,
      },
      {
        emit: (item) => {
          items.push(item);
          return { daemonEpoch: 'e', sequence: items.length };
        },
        end: (outcome) => {
          ends.push(outcome);
        },
      },
    );
    await settle();
    host.reply(host.last('get').id, projection('running'));
    await settle();
    host.reply(host.last('get').id, projection('running'));
    await opened;
    expect(ends).toEqual([]);

    host.reply(host.last('start').id, projection('running'));
    await result;
    host.send({
      kind: 'output',
      executionId: 'run',
      jobId: 'j',
      stepId: 's',
      stream: 'stdout',
      text: 'hello',
    });
    host.send({
      kind: 'execution',
      executionId: 'run',
      event: 'execution.completed',
      execution: projection('success'),
    });
    await settle();
    expect(items.map((item) => item.kind)).toEqual([
      'execution',
      'output',
      'execution',
    ]);
    expect(ends).toEqual(['completed']);
  });

  // Coordinator ruling: a host lost during a start answers hostLost.
  it('serves the detail and list reads over the host channel and checks each answer (CAN-6117)', async () => {
    const h = harness();
    const { host, result } = await started(h);
    host.reply(host.last('start').id, projection('running'));
    await result;
    const handlers = createWorkerPipelineHandlers(h.supervisor, {
      secrets: refusingExecutionSecretSource,
    });
    const context: CanopyHandlerContext = {
      requestId: 'reads',
      caller: {
        principalId: 'client',
        clientInstanceId: 'client',
        authorityId: 'authority',
        interfaceKind: 'daemon',
        grants: ['worker.pipeline.read'],
      },
      metadata: {},
      signal: new AbortController().signal,
    };

    const got = handlers.queries['worker.pipeline.execution.get'](
      { executionId: 'run', detail: true },
      context,
    );
    await settle();
    expect(host.last('get').request).toEqual({
      op: 'get',
      executionId: 'run',
      detail: true,
    });
    host.reply(host.last('get').id, {
      execution: projection('running'),
      detail: detail(),
    });
    await expect(got).resolves.toEqual({
      execution: projection('running'),
      detail: detail(),
    });

    const listed = handlers.queries['worker.pipeline.execution.list'](
      { scope: { worktreeId: 'worktree' }, limit: 1, detail: true },
      context,
    );
    await settle();
    expect(host.last('list').request).toEqual({
      op: 'list',
      query: {
        worktreeId: 'worktree',
        detail: true,
        after: null,
        limit: 1,
      },
    });
    host.reply(host.last('list').id, {
      executions: [{ execution: projection('running'), detail: detail() }],
      more: true,
    });
    const page = await listed;
    expect(page.executions).toEqual([
      { execution: projection('running'), detail: detail() },
    ]);
    expect(page.nextCursor).toEqual(expect.any(String));

    // A summary without the detail it asked for, or a malformed page, is refused.
    const bare = h.supervisor.inspect('run');
    await settle();
    host.reply(host.last('get').id, { execution: projection('running') });
    await expect(bare).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.hostUnavailable' },
    });
    const malformed = h.supervisor.list({
      detail: false,
      after: null,
      limit: 1,
    });
    await settle();
    host.reply(host.last('list').id, { executions: 'nope', more: false });
    await expect(malformed).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.hostUnavailable' },
    });
  });

  it('a start whose host exits before answering fails with hostLost', async () => {
    const h = harness();
    const handlers = createWorkerPipelineHandlers(h.supervisor, {
      secrets: refusingExecutionSecretSource,
    });
    const dispatcher = createCanopyDispatcher({
      profile: 'worker',
      definitions: {
        queries: {},
        instructions: {
          'worker.pipeline.execution.start':
            WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
              'worker.pipeline.execution.start'
            ],
        },
        streams: {},
      },
      handlers: {
        queries: {},
        instructions: {
          'worker.pipeline.execution.start':
            handlers.instructions['worker.pipeline.execution.start'],
        },
        streams: {},
      },
    });
    const started = dispatcher.instruction(
      'worker.pipeline.execution.start',
      params,
      {
        caller: {
          principalId: 'core',
          clientInstanceId: 'core',
          authorityId: 'authority',
          interfaceKind: 'daemon',
          grants: ['worker.pipeline.write'],
        },
        metadata: { idempotencyKey: 'run' },
        execution,
      },
    );
    await settle();
    h.hosts[0].exit(1);
    await expect(started).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.hostLost' },
    });
    await dispatcher.shutdown();
  });

  // CAN-5868: a step can notify before main's stream follows the run.
  it('a notification sent before any stream opens reaches the first stream, even after the run ended', async () => {
    const h = harness();
    const { host, result } = await started(h);
    host.reply(host.last('start').id, projection('running'));
    await result;
    host.send({
      kind: 'notification',
      executionId: 'run',
      stepId: 'notify',
      title: 'Daemon run',
      body: 'It finished.',
    });
    host.send({
      kind: 'execution',
      executionId: 'run',
      event: 'execution.completed',
      execution: projection('success'),
    });
    await settle();
    const handlers = createWorkerPipelineHandlers(h.supervisor, {
      secrets: refusingExecutionSecretSource,
    });
    const open = async (): Promise<{
      items: WorkerPipelineExecutionEventsItem[];
      ends: string[];
    }> => {
      const items: WorkerPipelineExecutionEventsItem[] = [];
      const ends: string[] = [];
      const opened = handlers.streams['worker.pipeline.execution.events'](
        { executionId: 'run' },
        {
          requestId: 'events',
          caller: {
            principalId: 'client',
            clientInstanceId: 'client',
            authorityId: 'authority',
            interfaceKind: 'daemon',
            grants: ['worker.pipeline.read'],
          },
          metadata: {},
          signal: new AbortController().signal,
        },
        {
          emit: (item) => {
            items.push(item);
            return { daemonEpoch: 'e', sequence: items.length };
          },
          end: (outcome) => {
            ends.push(outcome);
          },
        },
      );
      await settle();
      host.reply(host.last('get').id, projection('success'));
      await opened;
      return { items, ends };
    };
    const first = await open();
    expect(first.items.map((item) => item.kind)).toEqual([
      'notification',
      'execution',
    ]);
    expect(first.items[0]).toEqual({
      kind: 'notification',
      stepId: 'notify',
      title: 'Daemon run',
      body: 'It finished.',
    });
    expect(first.ends).toEqual(['completed']);
    // A later stream does not show it again.
    const second = await open();
    expect(second.items.map((item) => item.kind)).toEqual(['execution']);
  });

  // CAN-5868 review fix: a stream cancelled during its snapshot leaves them.
  it('a stream cancelled before its snapshot leaves the kept notifications for the next one', async () => {
    const h = harness();
    const { host, result } = await started(h);
    host.reply(host.last('start').id, projection('running'));
    await result;
    host.send({
      kind: 'notification',
      executionId: 'run',
      stepId: 'notify',
      title: 'Daemon run',
      body: 'It finished.',
    });
    await settle();
    const handlers = createWorkerPipelineHandlers(h.supervisor, {
      secrets: refusingExecutionSecretSource,
    });
    const open = (
      signal: AbortSignal,
    ): {
      items: WorkerPipelineExecutionEventsItem[];
      opened: Promise<unknown>;
    } => {
      const items: WorkerPipelineExecutionEventsItem[] = [];
      const opened = handlers.streams['worker.pipeline.execution.events'](
        { executionId: 'run' },
        {
          requestId: 'events',
          caller: {
            principalId: 'client',
            clientInstanceId: 'client',
            authorityId: 'authority',
            interfaceKind: 'daemon',
            grants: ['worker.pipeline.read'],
          },
          metadata: {},
          signal,
        },
        {
          emit: (item) => {
            if (signal.aborted) return null;
            items.push(item);
            return { daemonEpoch: 'e', sequence: items.length };
          },
          end: () => undefined,
        },
      );
      return { items, opened };
    };
    const cancelled = new AbortController();
    const first = open(cancelled.signal);
    await settle();
    cancelled.abort();
    host.reply(host.last('get').id, projection('running'));
    await first.opened;
    const second = open(new AbortController().signal);
    await settle();
    host.reply(host.last('get').id, projection('running'));
    await settle();
    host.reply(host.last('get').id, projection('running'));
    await second.opened;
    expect(second.items.map((item) => item.kind)).toEqual([
      'notification',
      'execution',
    ]);
  });

  // CAN-5868 review fix: a stream aborted while it is still being set up.
  it('a notification an aborted stream could not take is kept for the next one', async () => {
    const h = harness();
    const { host, result } = await started(h);
    host.reply(host.last('start').id, projection('running'));
    await result;
    const handlers = createWorkerPipelineHandlers(h.supervisor, {
      secrets: refusingExecutionSecretSource,
    });
    const open = (
      signal: AbortSignal,
    ): {
      items: WorkerPipelineExecutionEventsItem[];
      opened: Promise<unknown>;
    } => {
      const items: WorkerPipelineExecutionEventsItem[] = [];
      const opened = handlers.streams['worker.pipeline.execution.events'](
        { executionId: 'run' },
        {
          requestId: 'events',
          caller: {
            principalId: 'client',
            clientInstanceId: 'client',
            authorityId: 'authority',
            interfaceKind: 'daemon',
            grants: ['worker.pipeline.read'],
          },
          metadata: {},
          signal,
        },
        {
          emit: (item) => {
            if (signal.aborted) return null;
            items.push(item);
            return { daemonEpoch: 'e', sequence: items.length };
          },
          end: () => undefined,
        },
      );
      return { items, opened };
    };
    const aborted = new AbortController();
    const first = open(aborted.signal);
    await settle();
    host.reply(host.last('get').id, projection('running'));
    await settle();
    // Its observer is registered and its second snapshot is pending.
    aborted.abort();
    host.send({
      kind: 'notification',
      executionId: 'run',
      stepId: 'notify',
      title: 'Daemon run',
      body: 'It finished.',
    });
    await settle();
    host.reply(host.last('get').id, projection('running'));
    await first.opened;
    const second = open(new AbortController().signal);
    await settle();
    host.reply(host.last('get').id, projection('running'));
    await settle();
    host.reply(host.last('get').id, projection('running'));
    await second.opened;
    expect(second.items.map((item) => item.kind)).toEqual([
      'notification',
      'execution',
    ]);
  });

  // CAN-5856: a stream whose snapshot `get` is in flight when its host exits.
  it('an events stream opened while its host exits ends with hostLost', async () => {
    const h = harness();
    const { host, result } = await started(h);
    host.reply(host.last('start').id, projection('running'));
    await result;
    const handlers = createWorkerPipelineHandlers(h.supervisor, {
      secrets: refusingExecutionSecretSource,
    });
    const dispatcher = createCanopyDispatcher({
      profile: 'worker',
      definitions: {
        queries: {},
        instructions: {},
        streams: {
          'worker.pipeline.execution.events':
            WORKER_PIPELINE_STREAM_DEFINITIONS[
              'worker.pipeline.execution.events'
            ],
        },
      },
      handlers: {
        queries: {},
        instructions: {},
        streams: {
          'worker.pipeline.execution.events':
            handlers.streams['worker.pipeline.execution.events'],
        },
      },
    });
    const stream = await dispatcher.openStream(
      'worker.pipeline.execution.events',
      { executionId: 'run' },
      {
        caller: {
          principalId: 'client',
          clientInstanceId: 'client',
          authorityId: 'authority',
          interfaceKind: 'daemon',
          grants: ['worker.pipeline.read'],
        },
        metadata: {},
      },
    );
    const frames: Array<{
      kind: string;
      outcome?: string;
      error?: CanopyErrorPayload | null;
    }> = [];
    stream.onFrame((frame) => {
      frames.push(frame);
    });
    await settle();
    expect(host.last('get')).toBeDefined();
    host.exit(1);
    await settle();
    expect(frames.map((frame) => frame.kind)).toEqual(['end']);
    expect(frames[0].outcome).toBe('error');
    expect(frames[0].error?.code).toBe('worker.pipeline.hostLost');
    await dispatcher.shutdown();
  });
});

// CAN-6103: a cloud runner's resume and retry admit the run they start
// only when the host still runs it, whatever ends arrive around the answer.
describe('PipelineHostSupervisor recovery controls', () => {
  function runner(): {
    readonly host: () => FakeHost;
    readonly supervisor: PipelineHostSupervisor;
    readonly held: () => number;
  } {
    const hosts: FakeHost[] = [];
    let holds = 0;
    const resolved: PipelineHostLaunch = {
      params,
      launch: {
        pipeline: { name: 'p', on: 'dispatch', jobs: {} },
        cwd: '/w',
        bundledActionsDir: '/a',
        env: {},
        secretEnv: {},
      },
      processEnvironment: {},
    };
    const supervisor = new PipelineHostSupervisor({
      launch: (): FakeHost => {
        const host = new FakeHost();
        hosts.push(host);
        return host;
      },
      configure: { dataRoot: '/data' },
      resolveLaunch: (): Promise<PipelineHostLaunch> =>
        Promise.reject(new Error('Not a host-local run.')),
      resolvePortableLaunch: (): Promise<PipelineHostLaunch> =>
        Promise.resolve(resolved),
      holdExecution: (): (() => void) => {
        holds += 1;
        return (): void => {
          holds -= 1;
        };
      },
      idleStopMs: 60_000,
    });
    return {
      host: () => {
        const host = hosts[hosts.length - 1];
        if (!host) throw new Error('No host.');
        return host;
      },
      supervisor,
      held: () => holds,
    };
  }

  async function startPortable(r: ReturnType<typeof runner>): Promise<void> {
    const result = r.supervisor.start(
      {
        ...params,
        portableLaunch: {
          definition: {
            pin: { contentHash: 'a'.repeat(64), packageDigest: null },
            snapshot: { name: 'p', on: 'dispatch', jobs: {} },
          },
          env: {},
          delegationLease: { leaseTtlMs: 60_000 },
        },
      },
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
    );
    await settle();
    r.host().reply(r.host().last('start').id, projection('running'));
    await result;
  }

  /** Answers the reconciling read with the run as the host has it. */
  async function answerRead(
    r: ReturnType<typeof runner>,
    status: WorkerPipelineExecution['status'],
  ): Promise<void> {
    await settle();
    r.host().reply(r.host().last('get').id, projection(status));
    await settle();
  }

  it('does not keep a run that ended as its live resume answered', async () => {
    const r = runner();
    await startPortable(r);
    expect(r.held()).toBe(1);
    const resumed = r.supervisor.control(
      {
        operation: 'worker.pipeline.execution.resume',
        params: {
          requestId: 'r1',
          executionId: 'run',
          initiationSource: 'user',
        },
      },
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
    );
    await settle();
    // The answer and the run's end arrive together.
    r.host().reply(r.host().last('control').id, {
      outcome: 'started',
      execution: projection('running'),
    });
    r.host().send({
      kind: 'execution',
      executionId: 'run',
      event: 'execution.completed',
      execution: projection('success'),
    });
    await answerRead(r, 'success');
    await resumed;
    expect(r.held()).toBe(0);
  });

  it('admits a retry when its earlier attempt ends, twice, before the answer', async () => {
    const r = runner();
    await startPortable(r);
    const retried = r.supervisor.control(
      {
        operation: 'worker.pipeline.execution.retry',
        params: { requestId: 'r2', executionId: 'run', mode: 'failed_only' },
      },
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
    );
    await settle();
    // The executor-error path posts the earlier attempt's end twice.
    for (const event of ['execution.failed', 'execution.updated'])
      r.host().send({
        kind: 'execution',
        executionId: 'run',
        event,
        execution: projection('failure'),
      });
    r.host().reply(r.host().last('control').id, {
      outcome: 'started',
      execution: projection('running'),
    });
    await answerRead(r, 'running');
    await retried;
    expect(r.held()).toBe(1);
    expect(
      r.supervisor.observe('run', {
        onExecution: () => undefined,
        onOutput: () => undefined,
      }),
    ).not.toBeNull();
  });
});
