// CAN-6161 (cloud pipelines CP-03): the worker.pipeline relay contract cases
// every primary must pass against every runner. The core-runtime suite runs
// them with its fake core; the web core's suite (CAN-6170, CP-20) runs them
// with the web core's relay client. See
// docs/planning/2026-11-10-cloud-pipelines-relay-binding/README.md.
import type {
  CanopyJsonRpcMessage,
  CanopyStreamCursor,
  WorkerPipelineExecution,
  WorkerPipelineExecutionStartParams,
  WorkerPipelineExecutionView,
  WorkerPipelineHostRequestsItem,
  WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';
import { PIPELINE_REMOTE_OWNER_RETRY_DELAY_MS } from '../../execution';
import {
  LEASE_TTL_MS,
  ManualJournalExpiry,
  RUNNER_PATHS,
  SECRET_CANARY,
  portableLaunch,
  portableStart,
  settle,
  type RelayEventsStream,
  type RelayRunner,
  type RelayRunnerOptions,
} from './pipeline-relay-fixtures';

export const SECRET_REF = `ssr1_${'b'.repeat(43)}`;

/**
 * A primary as the cases drive it: the fake core, or the web core's client.
 * Every answer is the parsed result; a refusal rejects with its `payload`.
 */
export interface RelayCore {
  readonly runner: RelayRunner;
  start(
    params: WorkerPipelineExecutionStartParams,
    idempotencyKey?: string,
  ): Promise<{ execution: WorkerPipelineExecution }>;
  get(executionId: string): Promise<WorkerPipelineExecutionView>;
  list(): Promise<{ executions: WorkerPipelineExecutionView[] }>;
  cancel(executionId: string): Promise<{ execution: WorkerPipelineExecution }>;
  events(
    executionId: string,
    cursor?: CanopyStreamCursor,
  ): Promise<RelayEventsStream>;
  own(
    answer: (
      item: Exclude<WorkerPipelineHostRequestsItem, { withdrawn: true }>,
    ) => WorkerPipelineHostResult,
  ): Promise<() => void>;
  /** Every frame either end sent. */
  wire(): CanopyJsonRpcMessage[];
  wireText(): string;
  wireKeys(): Set<string>;
  close(): void;
}

/**
 * Registers the contract cases for runners `make` builds, each driven by the
 * primary `connectCore` puts in front of it.
 */
export function workerPipelineRelayConformanceCases(
  make: (options?: RelayRunnerOptions) => RelayRunner,
  connectCore: (runner: RelayRunner) => RelayCore,
): void {
  const open: Array<{ core: RelayCore; runner: RelayRunner }> = [];
  const connect = (options?: RelayRunnerOptions): RelayCore => {
    const runner = make(options);
    const core = connectCore(runner);
    open.push({ core, runner });
    return core;
  };

  afterEach(async () => {
    for (const { core, runner } of open.splice(0)) {
      core.close();
      await runner.stop();
    }
  });

  it('runs a portable start in the runner’s own paths, with secrets by reference only', async () => {
    const core = connect();
    const launch = portableLaunch();
    const params = {
      ...portableStart('run-paths', launch),
      secrets: [
        {
          name: 'API_TOKEN',
          source: {
            kind: 'stored-secret' as const,
            family: 'environment' as const,
            record: 'config',
            ref: SECRET_REF,
          },
        },
      ],
    };
    const { execution } = await core.start(params);
    expect(execution).toMatchObject({
      executionId: 'run-paths',
      status: 'running',
      runScope: 'worktree',
    });

    const launched = core.runner.launched('run-paths');
    expect(launched?.launch).toMatchObject({
      pipeline: launch.definition.snapshot,
      cwd: RUNNER_PATHS.checkout,
      bundledActionsDir: RUNNER_PATHS.bundledActionsDir,
      nodeProcess: { command: RUNNER_PATHS.node },
      env: { STEP_VALUE: 'from-start' },
      inputs: { greeting: 'hello' },
      secretEnv: { API_TOKEN: SECRET_CANARY },
    });
    expect(launched?.params).not.toHaveProperty('portableLaunch');
    expect(launched?.params).not.toHaveProperty('secrets');

    // Nothing host-local crossed, in either direction.
    expect(core.wireKeys().has('_execution')).toBe(false);
    const wire = core.wireText();
    expect(wire).not.toContain(SECRET_CANARY);
    for (const path of Object.values(RUNNER_PATHS))
      expect(wire).not.toContain(path);
    expect(wire).toContain(SECRET_REF);
  });

  it('serves get, list, cancel and events for a portable run', async () => {
    const core = connect();
    await core.start(portableStart('run-read'));
    await core.start(portableStart('run-cancel'));

    await expect(core.get('run-read')).resolves.toMatchObject({
      execution: { executionId: 'run-read', status: 'running' },
    });
    const { executions } = await core.list();
    expect(
      executions.map(({ execution }) => execution.executionId).sort(),
    ).toEqual(['run-cancel', 'run-read']);

    const events = await core.events('run-read');
    await settle();
    await core.runner.finish('run-read', 'success');
    await expect(events.ended).resolves.toMatchObject({ outcome: 'completed' });
    const { items } = events;
    expect(items[0]).toMatchObject({ kind: 'execution', event: 'snapshot' });
    expect(items[items.length - 1]).toMatchObject({
      kind: 'execution',
      execution: { status: 'success' },
    });

    await expect(core.cancel('run-cancel')).resolves.toMatchObject({
      execution: { executionId: 'run-cancel' },
    });
    await expect(core.cancel('missing')).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.executionNotFound' },
    });
  });

  it('joins a start resent with its idempotency key, without redeeming its secrets again', async () => {
    const core = connect();
    const params = {
      ...portableStart('run-keyed'),
      secrets: [
        {
          name: 'API_TOKEN',
          source: {
            kind: 'stored-secret' as const,
            family: 'environment' as const,
            record: 'config',
            ref: SECRET_REF,
          },
        },
      ],
    };
    const first = await core.start(params);
    // A lost reply: the same start again. Its grant is already redeemed.
    const again = await core.start(params);
    expect(again.execution.executionId).toBe(first.execution.executionId);
    expect((await core.list()).executions).toHaveLength(1);
  });

  it('joins a keyed resend that overlaps the first start, and one sent after its run settled', async () => {
    const core = connect();
    const params = {
      ...portableStart('run-replay'),
      secrets: [
        {
          name: 'API_TOKEN',
          source: {
            kind: 'stored-secret' as const,
            family: 'environment' as const,
            record: 'config',
            ref: SECRET_REF,
          },
        },
      ],
    };
    // Both reach the runner before either answers.
    const [first, overlapping] = await Promise.all([
      core.start(params),
      core.start(params),
    ]);
    expect(overlapping.execution.executionId).toBe(first.execution.executionId);
    await core.runner.finish('run-replay', 'success');

    // After the run settled, a resend answers the run as it is now.
    await expect(core.start(params)).resolves.toMatchObject({
      execution: { executionId: 'run-replay', status: 'success' },
    });
    expect((await core.list()).executions).toHaveLength(1);
  });

  it('answers a resend whose receipt is gone with the run the worker holds', async () => {
    // Another worker over the same runner state: a restart, or an evicted receipt.
    const runner = make();
    const first = connectCore(runner);
    const second = connectCore(runner.rehandled());
    open.push({ core: first, runner }, { core: second, runner });
    await first.start(portableStart('run-restarted'));
    await runner.finish('run-restarted', 'success');
    await expect(
      second.start(portableStart('run-restarted')),
    ).resolves.toMatchObject({
      execution: { executionId: 'run-restarted', status: 'success' },
    });
    expect((await second.list()).executions).toHaveLength(1);
  });

  it('refuses a start with no launch, and a portable start where the worker maps none', async () => {
    const core = connect();
    const { portableLaunch: _launch, ...bare } = portableStart('run-bare');
    void _launch;
    await expect(core.start(bare)).rejects.toMatchObject({
      payload: {
        code: 'worker.pipeline.launchUnavailable',
        retry: { kind: 'never' },
      },
    });

    const local = connect({ portable: false });
    await expect(local.start(portableStart('run-local'))).rejects.toMatchObject(
      {
        payload: {
          kind: 'invalid_argument',
          code: 'worker.pipeline.launchRefused',
          retry: { kind: 'never' },
        },
      },
    );
    expect(local.runner.launched('run-local')).toBeUndefined();
  });

  it('a remote owner retries an owner-bound start with its key once it subscribes, with its secrets', async () => {
    const core = connect({ remoteOwner: { leaseTtlMs: LEASE_TTL_MS } });
    const params = {
      ...portableStart('run-bound', portableLaunch({ ownerBound: true })),
      secrets: [
        {
          name: 'API_TOKEN',
          source: {
            kind: 'stored-secret' as const,
            family: 'environment' as const,
            record: 'config',
            ref: SECRET_REF,
          },
        },
      ],
    };
    await expect(core.start(params)).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'worker.pipeline.ownerUnavailable',
        retry: {
          kind: 'same_idempotency_key',
          delayMs: PIPELINE_REMOTE_OWNER_RETRY_DELAY_MS,
        },
      },
    });
    expect(core.runner.launched('run-bound')).toBeUndefined();

    await core.own(() => ({ status: 'success', outputs: {} }));
    // The refusal left the secret grant for the retry.
    await expect(core.start(params)).resolves.toMatchObject({
      execution: { executionId: 'run-bound', status: 'running' },
    });
    expect(core.runner.launched('run-bound')?.launch.secretEnv).toEqual({
      API_TOKEN: SECRET_CANARY,
    });
  });

  it('resumes an events stream after its last cursor with what it missed during an outage', async () => {
    const core = connect();
    await core.start(portableStart('run-resume'));
    const first = await core.events('run-resume');
    // Without a cursor the stream starts from a snapshot, with a cursor of its own.
    expect(first.acceptedCursor).toBeNull();
    expect(first.items[0]).toMatchObject({
      kind: 'execution',
      event: 'snapshot',
      execution: { executionId: 'run-resume', status: 'running' },
    });
    await core.runner.output('run-resume', 'one');
    const last = first.cursors[first.cursors.length - 1];
    expect(first.items[first.items.length - 1]).toMatchObject({
      kind: 'output',
      text: 'one',
    });

    first.close();
    await settle();
    await core.runner.output('run-resume', 'two');
    await core.runner.output('run-resume', 'three');

    const second = await core.events('run-resume', last);
    expect(second.acceptedCursor).toEqual(last);
    expect(
      second.items.map((item) =>
        item.kind === 'output' ? item.text : item.kind,
      ),
    ).toEqual(['two', 'three']);
    await core.runner.finish('run-resume', 'success');
    await expect(second.ended).resolves.toMatchObject({ outcome: 'completed' });
    expect(second.items[second.items.length - 1]).toMatchObject({
      kind: 'execution',
      execution: { status: 'success' },
    });

    // One epoch, strictly increasing: the web core dedupes by (runtime, epoch, sequence).
    const cursors = [...first.cursors, ...second.cursors];
    expect(new Set(cursors.map(({ daemonEpoch }) => daemonEpoch)).size).toBe(1);
    for (let index = 1; index < cursors.length; index += 1)
      expect(cursors[index].sequence).toBeGreaterThan(
        cursors[index - 1].sequence,
      );
  });

  it('replays a run that finished during the outage to its end', async () => {
    const core = connect();
    await core.start(portableStart('run-finished'));
    const first = await core.events('run-finished');
    const last = first.cursors[first.cursors.length - 1];
    first.close();
    await settle();
    await core.runner.output('run-finished', 'late');
    await core.runner.finish('run-finished', 'failure');

    const second = await core.events('run-finished', last);
    await expect(second.ended).resolves.toMatchObject({ outcome: 'completed' });
    expect(second.items).toMatchObject([
      { kind: 'output', text: 'late' },
      { kind: 'execution', execution: { status: 'failure' } },
    ]);
  });

  it('answers snapshotRequired for another epoch’s cursor and one older than its journal', async () => {
    const core = connect({ journal: { maxEntries: 3 } });
    await core.start(portableStart('run-old'));
    const first = await core.events('run-old');
    const [{ daemonEpoch }] = first.cursors;
    first.close();
    for (const text of ['a', 'b', 'c', 'd', 'e'])
      await core.runner.output('run-old', text);

    for (const cursor of [
      { daemonEpoch: 'another-incarnation', sequence: 1 },
      { daemonEpoch, sequence: 1 },
    ]) {
      const stream = await core.events('run-old', cursor);
      await expect(stream.ended).resolves.toMatchObject({
        outcome: 'error',
        error: {
          kind: 'failed_precondition',
          code: 'worker.pipeline.snapshotRequired',
          retry: { kind: 'after_refresh' },
        },
      });
      expect(stream.items).toEqual([]);
    }

    // The documented recovery: read the run and reopen without a cursor.
    await expect(core.get('run-old')).resolves.toMatchObject({
      execution: { status: 'running' },
    });
    const fresh = await core.events('run-old');
    expect(fresh.items[0]).toMatchObject({
      kind: 'execution',
      event: 'snapshot',
    });
  });

  it('a worker without a journal answers snapshotRequired for a cursor and a snapshot without one', async () => {
    const core = connect({ journal: false });
    await core.start(portableStart('run-unjournaled'));
    const fresh = await core.events('run-unjournaled');
    expect(fresh.items[0]).toMatchObject({
      kind: 'execution',
      event: 'snapshot',
    });
    const resumed = await core.events('run-unjournaled', fresh.cursors[0]);
    await expect(resumed.ended).resolves.toMatchObject({
      outcome: 'error',
      error: { code: 'worker.pipeline.snapshotRequired' },
    });
  });

  it('opens a stream on a run that just finished with its snapshot first', async () => {
    const core = connect();
    await core.start(portableStart('run-done'));
    await core.runner.finish('run-done', 'success');
    const stream = await core.events('run-done');
    await expect(stream.ended).resolves.toMatchObject({ outcome: 'completed' });
    expect(stream.items).toMatchObject([
      {
        kind: 'execution',
        event: 'snapshot',
        execution: { status: 'success' },
      },
    ]);
  });

  it('gives a new stream only the notifications no stream received', async () => {
    const core = connect();
    await core.start(portableStart('run-notify'));
    const first = await core.events('run-notify');
    await core.runner.notify('run-notify', 'seen');
    expect(first.items[first.items.length - 1]).toMatchObject({
      kind: 'notification',
      title: 'seen',
    });
    first.close();
    await settle();
    await core.runner.notify('run-notify', 'unseen');

    const second = await core.events('run-notify');
    expect(second.items).toMatchObject([
      { kind: 'notification', title: 'unseen' },
      { kind: 'execution', event: 'snapshot' },
    ]);
  });

  it('follows a paused run to its cancel', async () => {
    const core = connect();
    await core.start(portableStart('run-pause-cancel'));
    const stream = await core.events('run-pause-cancel');
    await core.runner.finish('run-pause-cancel', 'paused');
    await core.cancel('run-pause-cancel');
    await expect(stream.ended).resolves.toMatchObject({
      outcome: 'completed',
    });
    expect(stream.items[stream.items.length - 1]).toMatchObject({
      kind: 'execution',
      execution: { status: 'cancelled' },
    });
  });

  it('starts a new stream from the run as last journaled, changes that keep its status included', async () => {
    const core = connect();
    await core.start(portableStart('run-count'));
    await core.runner.update('run-count', { pendingPauseCount: 2 });
    const stream = await core.events('run-count');
    expect(stream.items[0]).toMatchObject({
      kind: 'execution',
      event: 'snapshot',
      execution: { status: 'running', pendingPauseCount: 2 },
    });
  });

  it('ends a stream on a paused run with snapshotRequired once its journal expires', async () => {
    const expiry = new ManualJournalExpiry();
    const core = connect({ journal: { expiry } });
    await core.start(portableStart('run-paused'));
    await core.runner.finish('run-paused', 'paused');
    const stream = await core.events('run-paused');
    expect(stream.items[0]).toMatchObject({
      kind: 'execution',
      execution: { status: 'paused' },
    });
    await expiry.expire();
    await expect(stream.ended).resolves.toMatchObject({
      outcome: 'error',
      error: { code: 'worker.pipeline.snapshotRequired' },
    });
    const resumed = await core.events('run-paused', stream.cursors[0]);
    await expect(resumed.ended).resolves.toMatchObject({
      error: { code: 'worker.pipeline.snapshotRequired' },
    });
  });

  it('a local owner that is gone is never retried', async () => {
    const core = connect();
    await expect(
      core.start(
        portableStart('run-local-owner', portableLaunch({ ownerBound: true })),
      ),
    ).rejects.toMatchObject({
      payload: {
        code: 'worker.pipeline.ownerUnavailable',
        retry: { kind: 'never' },
      },
    });
  });
}
