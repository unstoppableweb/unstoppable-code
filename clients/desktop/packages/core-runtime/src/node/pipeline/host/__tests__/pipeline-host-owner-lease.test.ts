// CAN-6198: a cloud runner's supervisor configures each pipeline host with
// the delegation lease the runner holds, forwards what the runner learns
// about it over the relay (a renewal of its epoch, or a newer epoch), and
// starts no host again once a newer epoch exists or the lease lapsed. A fake
// host records the requests.
import { EventEmitter } from 'node:events';
import type {
  CanopyErrorPayload,
  CanopyHostExecution,
  WorkerPipelineExecution,
} from '@canopy/protocol/canopy-core';
import { NO_EXECUTION_SECRETS } from '../../../execution-secrets';
import {
  pipelineHostLostError,
  pipelineHostUnavailableError,
} from '../../execution/worker-pipelines';
import {
  PipelineHostSupervisor,
  type PipelineHostLaunch,
  type PipelineHostMessage,
  type PipelineHostProcess,
  type PipelineHostRequest,
  type PipelineHostRequestMessage,
  type PipelineOwnerLeaseObservation,
} from '..';

class FakeHost extends EventEmitter implements PipelineHostProcess {
  readonly requests: PipelineHostRequest[] = [];

  /** Answers `configure` only when called, as a slow host start does. */
  answerConfigure: (() => void) | null = null;

  /** The state this host's fence answers a `lease` request with. */
  leaseState: 'held' | 'lapsed' | 'superseded' = 'held';

  /** Holds `lease` answers until called, as a busy host does. */
  holdLease = false;

  answerLease: (() => void) | null = null;

  /** Holds `start` answers until called. */
  holdStart = false;

  answerStart: (() => void) | null = null;

  constructor(private readonly holdConfigure: boolean) {
    super();
  }

  postMessage(message: PipelineHostRequestMessage): void {
    this.requests.push(message.request);
    if (this.holdConfigure && message.request.op === 'configure') {
      this.answerConfigure = (): void => this.reply(message.id);
      return;
    }
    if (message.request.op === 'lease' && this.holdLease) {
      this.answerLease = (): void =>
        this.reply(message.id, { state: this.leaseState });
      return;
    }
    const { request } = message;
    if (request.op === 'start' && this.holdStart) {
      this.answerStart = (): void =>
        this.reply(message.id, running(request.start.params.executionId));
      return;
    }
    this.reply(
      message.id,
      request.op === 'lease'
        ? { state: this.leaseState }
        : request.op === 'start'
          ? running(request.start.params.executionId)
          : null,
    );
    if (message.request.op === 'exit')
      queueMicrotask(() => this.emit('exit', 0));
  }

  killed = false;

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }

  private reply(id: number, value: unknown = null): void {
    const message: PipelineHostMessage = {
      kind: 'response',
      id,
      ok: true,
      value,
    };
    queueMicrotask(() => this.emit('message', message));
  }
}

function running(executionId: string): WorkerPipelineExecution {
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
    startedAt: '2026-11-10T00:00:00.000Z',
    completedAt: null,
    pendingPauseCount: 0,
    error: null,
  };
}

const HOST_EXECUTION: CanopyHostExecution = {
  childEnvironment: { PATH: '/usr/bin' },
  pipelineLaunch: {
    pipeline: { name: 'p', on: 'dispatch', jobs: {} },
    cwd: '/work/tree',
    bundledActionsDir: '/app/actions',
    env: {},
    secretEnv: {},
  },
};

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

const NOW = Date.now();
const LEASE = { leaseEpoch: 3, expiresAt: NOW + 600_000 };

function harness(
  lease: { leaseEpoch: number; expiresAt: number } = LEASE,
  holdConfigure = false,
): {
  hosts: FakeHost[];
  supervisor: PipelineHostSupervisor;
  observed: () => PipelineOwnerLeaseObservation[];
} {
  const hosts: FakeHost[] = [];
  const supervisor = new PipelineHostSupervisor({
    launch: (): PipelineHostProcess => {
      // Only the first host starts slowly.
      const host = new FakeHost(holdConfigure && hosts.length === 0);
      hosts.push(host);
      return host;
    },
    configure: { dataRoot: '/data' },
    resolveLaunch: (): Promise<PipelineHostLaunch> =>
      Promise.reject(new Error('No launches in this test.')),
    idleStopMs: 3_600_000,
    remoteOwner: { leaseTtlMs: 60_000, lease },
  });
  return {
    hosts,
    supervisor,
    observed: () =>
      hosts.flatMap((host) =>
        host.requests.flatMap((request) =>
          request.op === 'lease' ? [request.observation] : [],
        ),
      ),
  };
}

describe('pipeline host supervisor with a delegation lease (CAN-6198)', () => {
  it('configures the host with the lease and forwards its renewals', async () => {
    const h = harness();
    await h.supervisor.ready();
    expect(h.hosts[0]?.requests[0]).toMatchObject({
      op: 'configure',
      ownerLease: LEASE,
    });

    const renewed = { leaseEpoch: 3, expiresAt: NOW + 1_200_000 };
    h.supervisor.observeOwnerLease({ kind: 'renewed', lease: renewed });
    // Neither an older expiry nor an older epoch moves the lease.
    h.supervisor.observeOwnerLease({
      kind: 'renewed',
      lease: { leaseEpoch: 3, expiresAt: NOW + 900_000 },
    });
    h.supervisor.observeOwnerLease({
      kind: 'renewed',
      lease: { leaseEpoch: 2, expiresAt: NOW + 9_000_000 },
    });
    h.supervisor.observeOwnerLease({ kind: 'superseded', leaseEpoch: 3 });
    await settle();
    expect(h.observed()).toEqual([{ kind: 'renewed', lease: renewed }]);

    // A host started later is configured with the renewed lease.
    h.hosts[0]?.emit('exit', 1);
    await settle();
    await h.supervisor.ready();
    expect(h.hosts[1]?.requests[0]).toMatchObject({
      op: 'configure',
      ownerLease: renewed,
    });
    await h.supervisor.stop();
  });

  it('stops the host at a newer epoch and starts no host after it', async () => {
    const h = harness();
    await h.supervisor.ready();
    h.supervisor.observeOwnerLease({ kind: 'superseded' });
    h.supervisor.observeOwnerLease({
      kind: 'renewed',
      lease: { leaseEpoch: 3, expiresAt: NOW + 5_000_000 },
    });
    await settle();
    // The host is killed rather than told, so a lost message cannot keep it.
    expect(h.hosts[0]?.killed).toBe(true);
    expect(h.observed()).toEqual([]);
    await expect(h.supervisor.ready()).rejects.toEqual(
      pipelineHostUnavailableError(),
    );
    expect(h.hosts).toHaveLength(1);
    await h.supervisor.stop();
  });

  it('reconciles a lease observed while the host starts', async () => {
    const renewing = harness(LEASE, true);
    const ready = renewing.supervisor.ready();
    await settle();
    const renewed = { leaseEpoch: 3, expiresAt: NOW + 1_200_000 };
    renewing.supervisor.observeOwnerLease({ kind: 'renewed', lease: renewed });
    renewing.hosts[0]?.answerConfigure?.();
    await ready;
    await settle();
    expect(renewing.observed()).toEqual([{ kind: 'renewed', lease: renewed }]);
    await renewing.supervisor.stop();

    const superseding = harness(LEASE, true);
    const refused = superseding.supervisor.ready();
    await settle();
    superseding.supervisor.observeOwnerLease({ kind: 'superseded' });
    superseding.hosts[0]?.answerConfigure?.();
    await expect(refused).rejects.toEqual(pipelineHostUnavailableError());
    await superseding.supervisor.stop();

    // A host whose fence lapsed on the older lease while it started is
    // replaced by one configured with the renewed lease.
    const lapsing = harness(LEASE, true);
    const replaced = lapsing.supervisor.ready();
    await settle();
    lapsing.supervisor.observeOwnerLease({ kind: 'renewed', lease: renewed });
    const first = lapsing.hosts[0];
    if (first) first.leaseState = 'lapsed';
    first?.answerConfigure?.();
    await replaced;
    expect(lapsing.hosts).toHaveLength(2);
    expect(lapsing.hosts[1]?.requests[0]).toMatchObject({
      op: 'configure',
      ownerLease: renewed,
    });
    await lapsing.supervisor.stop();
  });

  it('does not publish a host whose lease ended while it took a renewal', async () => {
    const h = harness(LEASE, true);
    const ready = h.supervisor.ready();
    await settle();
    h.supervisor.observeOwnerLease({
      kind: 'renewed',
      lease: { leaseEpoch: 3, expiresAt: NOW + 1_200_000 },
    });
    const host = h.hosts[0];
    if (host) host.holdLease = true;
    host?.answerConfigure?.();
    await settle();
    h.supervisor.observeOwnerLease({ kind: 'superseded' });
    host?.answerLease?.();
    await expect(ready).rejects.toEqual(pipelineHostUnavailableError());
    expect(h.hosts).toHaveLength(1);
    await h.supervisor.stop();
  });

  it("ends the lease when the published host's fence closes", async () => {
    const h = harness();
    await h.supervisor.ready();
    h.hosts[0]?.emit('message', { kind: 'fenced', state: 'superseded' });
    await settle();
    expect(h.hosts[0]?.killed).toBe(true);
    await expect(h.supervisor.ready()).rejects.toEqual(
      pipelineHostUnavailableError(),
    );

    // A renewal the host answers as lapsed ends it too.
    const late = harness();
    await late.supervisor.ready();
    const host = late.hosts[0];
    if (host) host.leaseState = 'lapsed';
    late.supervisor.observeOwnerLease({
      kind: 'renewed',
      lease: { leaseEpoch: 3, expiresAt: NOW + 1_200_000 },
    });
    await settle();
    expect(host?.killed).toBe(true);
    await expect(late.supervisor.ready()).rejects.toEqual(
      pipelineHostUnavailableError(),
    );
    await h.supervisor.stop();
    await late.supervisor.stop();
  });

  it('keeps a lapsed lease ended through a late renewal and a host loss', async () => {
    const h = harness({ leaseEpoch: 3, expiresAt: Date.now() + 100 });
    await h.supervisor.ready();
    await new Promise((resolve) => setTimeout(resolve, 150));
    h.supervisor.observeOwnerLease({
      kind: 'renewed',
      lease: { leaseEpoch: 3, expiresAt: Date.now() + 600_000 },
    });
    await settle();
    expect(h.observed()).toEqual([]);

    h.hosts[0]?.emit('exit', 1);
    await settle();
    await expect(h.supervisor.ready()).rejects.toEqual(
      pipelineHostUnavailableError(),
    );
    expect(h.hosts).toHaveLength(1);
    await h.supervisor.stop();
  });
  it("retires a fenced host's runs: their streams end and their holds release", async () => {
    const hosts: FakeHost[] = [];
    const released: string[] = [];
    const supervisor = new PipelineHostSupervisor({
      launch: (): PipelineHostProcess => {
        const host = new FakeHost(false);
        hosts.push(host);
        return host;
      },
      configure: { dataRoot: '/data' },
      resolveLaunch: (params, execution): Promise<PipelineHostLaunch> =>
        Promise.resolve({
          params,
          launch: execution.pipelineLaunch,
          processEnvironment: execution.childEnvironment,
        }),
      holdExecution: (executionId) => (): void => {
        released.push(executionId);
      },
      idleStopMs: 3_600_000,
      remoteOwner: { leaseTtlMs: 60_000, lease: LEASE },
    });
    await supervisor.start(
      {
        executionId: 'run-1',
        pipelineId: 'pipeline',
        definitionSource: 'inline',
        runScope: 'worktree',
        workspaceId: 'workspace',
        worktreeId: 'worktree',
        owner: 'personal',
        initiationSource: 'user',
      },
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
      HOST_EXECUTION,
    );
    const ended: CanopyErrorPayload[] = [];
    const stop = supervisor.observe('run-1', {
      onExecution: () => undefined,
      onOutput: () => undefined,
      onEnd: (error) => ended.push(error),
    });
    expect(stop).not.toBeNull();

    hosts[0]?.emit('message', { kind: 'fenced', state: 'lapsed' });
    await settle();
    expect(ended).toEqual([pipelineHostLostError().payload]);
    expect(released).toEqual(['run-1']);
    await supervisor.stop();
  });
  it('follows no run whose start answers after its host was fenced', async () => {
    const hosts: FakeHost[] = [];
    const released: string[] = [];
    const supervisor = new PipelineHostSupervisor({
      launch: (): PipelineHostProcess => {
        const host = new FakeHost(false);
        host.holdStart = true;
        hosts.push(host);
        return host;
      },
      configure: { dataRoot: '/data' },
      resolveLaunch: (params, execution): Promise<PipelineHostLaunch> =>
        Promise.resolve({
          params,
          launch: execution.pipelineLaunch,
          processEnvironment: execution.childEnvironment,
        }),
      holdExecution: (executionId) => (): void => {
        released.push(executionId);
      },
      idleStopMs: 3_600_000,
      remoteOwner: { leaseTtlMs: 60_000, lease: LEASE },
    });
    const started = supervisor.start(
      {
        executionId: 'run-late',
        pipelineId: 'pipeline',
        definitionSource: 'inline',
        runScope: 'worktree',
        workspaceId: 'workspace',
        worktreeId: 'worktree',
        owner: 'personal',
        initiationSource: 'user',
      },
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
      HOST_EXECUTION,
    );
    await settle();
    const ended: CanopyErrorPayload[] = [];
    supervisor.observe('run-late', {
      onExecution: () => undefined,
      onOutput: () => undefined,
      onEnd: (error) => ended.push(error),
    });
    hosts[0]?.emit('message', { kind: 'fenced', state: 'superseded' });
    hosts[0]?.answerStart?.();
    await expect(started).rejects.toEqual(pipelineHostLostError());
    expect(ended).toEqual([pipelineHostLostError().payload]);
    expect(released).toEqual([]);
    expect(
      supervisor.observe('run-late', {
        onExecution: () => undefined,
        onOutput: () => undefined,
      }),
    ).toBeNull();
    await supervisor.stop();
  });
});
