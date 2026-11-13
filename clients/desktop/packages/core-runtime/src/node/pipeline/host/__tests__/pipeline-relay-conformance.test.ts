// CAN-6161 (cloud pipelines CP-03): the worker.pipeline relay contract
// between a remote primary (the web core) and a cloud runner. A fake core
// drives each runner over a serializing JSON-RPC pair; the supervisor
// composition a cloud runner reuses and the reference fake runner must both
// pass. See docs/planning/2026-11-10-cloud-pipelines-relay-binding/README.md.
import VECTORS from '../../../../../../protocol/src/pipeline-relay/fixtures/session-vectors.json';
import {
  WORKER_PIPELINE_PORTABLE_LAUNCH_HOST_MEMBERS,
  WORKER_PIPELINE_ROUTE_ID_PATTERN,
  WorkerPipelineExecutionStartParamsSchema,
  WorkerPipelinePortableLaunchSchema,
  type CanopyHostExecution,
  type CanopyStreamCursor,
  type WorkerPipelineExecutionEventsItem,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';
import type { CanopyHandlerContext } from '../../../../runtime/types';
import { NO_EXECUTION_SECRETS } from '../../../execution-secrets';
import {
  PipelineEventJournal,
  createPipelineOwnerChannel,
  createWorkerPipelineHandlers,
  withPipelineEventJournal,
  type PipelineEventJournalEntry,
  type PipelineExecutionWorker,
} from '../../execution';
import {
  createPipelineRelaySession,
  type PipelineHostSettlement,
  type PipelineRelaySession,
  type PipelineRemoteOwner,
} from '..';
import {
  FakePipelineCore,
  RELAY_SESSION_KEY,
  SECRET_CANARY,
  relayLegLink,
  serveRunnerOverRelayLeg,
  FakeRunnerWorker,
  ManualJournalExpiry,
  LEASE_TTL_MS,
  canarySecrets,
  RUNNER_PATHS,
  fakeRunner,
  portableLaunch,
  portableStart,
  settle,
  supervisorRunner,
  type RelayRunner,
  type RelayRunnerOptions,
} from './pipeline-relay-fixtures';
import { workerPipelineRelayConformanceCases } from './pipeline-relay-conformance-cases';

const runners: Array<[string, (options?: RelayRunnerOptions) => RelayRunner]> =
  [
    ['the supervisor runner', supervisorRunner],
    ['the fake runner', fakeRunner],
  ];

describe.each(runners)('worker.pipeline over a relay: %s', (_name, make) => {
  workerPipelineRelayConformanceCases(
    make,
    (runner) => new FakePipelineCore(runner),
  );
});

// CP-11: the same cases through the cloud runner's own relay leg, its
// end-to-end session and the binding it serves, as the runner entry serves
// one relay attachment.
describe.each(runners)(
  'worker.pipeline over the cloud runner relay leg: %s',
  (_name, make) => {
    workerPipelineRelayConformanceCases(
      make,
      (runner) => new FakePipelineCore(runner, relayLegLink(runner)),
    );
  },
);

describe('the portable start contract', () => {
  it('admits no host-local launch member', () => {
    const launch = portableLaunch();
    expect(WorkerPipelinePortableLaunchSchema.safeParse(launch).success).toBe(
      true,
    );
    for (const member of Object.keys(
      WORKER_PIPELINE_PORTABLE_LAUNCH_HOST_MEMBERS,
    ))
      expect(
        WorkerPipelinePortableLaunchSchema.safeParse({
          ...launch,
          [member]: '/host/path',
        }).success,
      ).toBe(false);
  });

  it('pins the definition and carries the delegation lease TTL', () => {
    const launch = portableLaunch();
    const invalid = [
      { ...launch, definition: { ...launch.definition, pin: undefined } },
      {
        ...launch,
        definition: {
          ...launch.definition,
          pin: { contentHash: 'not-a-hash', packageDigest: null },
        },
      },
      {
        ...launch,
        definition: {
          ...launch.definition,
          pin: { contentHash: 'a'.repeat(64), packageDigest: 'sha256:abc' },
        },
      },
      { ...launch, delegationLease: undefined },
      { ...launch, delegationLease: { leaseTtlMs: 0 } },
    ];
    for (const value of invalid)
      expect(WorkerPipelinePortableLaunchSchema.safeParse(value).success).toBe(
        false,
      );
    expect(
      WorkerPipelinePortableLaunchSchema.safeParse({
        ...launch,
        definition: {
          ...launch.definition,
          pin: {
            contentHash: 'a'.repeat(64),
            packageDigest: `pp:v1:${'c'.repeat(43)}`,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      WorkerPipelineExecutionStartParamsSchema.safeParse(
        portableStart('run-schema'),
      ).success,
    ).toBe(true);
  });

  it('a start never runs a portable launch beside a host-local one', async () => {
    const runner = supervisorRunner();
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
    const start =
      runner.handlers.instructions['worker.pipeline.execution.start'];
    if (!start) throw new Error('The runner serves no start.');
    const context = {
      signal: new AbortController().signal,
      execution,
    } as unknown as CanopyHandlerContext;
    await expect(
      Promise.resolve(start(portableStart('run-both'), context)),
    ).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.launchRefused' },
    });
    expect(runner.launched('run-both')).toBeUndefined();
    await runner.stop();
  });
});

/** Journals a run the reference worker holds, as the journaled worker's start does. */
function trackRun(
  worker: FakeRunnerWorker,
  journal: PipelineEventJournal,
  executionId: string,
): void {
  const run = worker.runs.get(executionId);
  if (!run) throw new Error(`No run ${executionId}.`);
  journal.track(worker, executionId, run.execution);
}

describe('the runner event journal', () => {
  const started = async (
    executionId: string,
  ): Promise<{
    worker: FakeRunnerWorker;
    journal: PipelineEventJournal;
    expiry: ManualJournalExpiry;
  }> => {
    const worker = new FakeRunnerWorker(createPipelineOwnerChannel(), {});
    await worker.start(
      portableStart(executionId),
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
    );
    const expiry = new ManualJournalExpiry();
    return {
      worker,
      journal: new PipelineEventJournal({
        expireAfter: expiry.expireAfter,
      }),
      expiry,
    };
  };
  const follow = (
    journal: PipelineEventJournal,
    executionId: string,
    cursor: CanopyStreamCursor | null,
  ): { opened: string; entries: PipelineEventJournalEntry[] } => {
    const entries: PipelineEventJournalEntry[] = [];
    const opened = journal.open(executionId, cursor, {
      entry: (entry) => entries.push(entry),
      end: () => undefined,
    });
    return { opened: opened.kind, entries };
  };

  it('numbers a run journaled again after its journal expired under a new epoch', async () => {
    const { worker, journal, expiry } = await started('run-again');
    trackRun(worker, journal, 'run-again');
    const before = follow(journal, 'run-again', null);
    worker.output('run-again', 'before');
    worker.finish('run-again', 'paused');
    const [first] = before.entries;
    await expiry.expire();

    // Resumed after its journal expired: a new journal, never the old cursors.
    const run = worker.runs.get('run-again');
    if (!run) throw new Error('No run.');
    run.execution = { ...run.execution, status: 'running' };
    trackRun(worker, journal, 'run-again');
    const after = follow(journal, 'run-again', null);
    worker.output('run-again', 'after');
    expect(after.entries[0].cursor.daemonEpoch).not.toBe(
      first.cursor.daemonEpoch,
    );
    expect(follow(journal, 'run-again', first.cursor).opened).toBe(
      'snapshot_required',
    );
    journal.close();
  });

  it('journals how a run that settled before it could be followed is now', async () => {
    const { worker, journal, expiry } = await started('run-instant');
    const run = worker.runs.get('run-instant');
    if (!run) throw new Error('No run.');
    // The start answered `running`, but the run finished in the same tick.
    const stale = run.execution;
    worker.finish('run-instant', 'success');
    journal.track(worker, 'run-instant', stale);
    // Armed once the journal has recorded how the run ended.
    await expiry.whenArmed();
    const ends: unknown[] = [];
    const entries: PipelineEventJournalEntry[] = [];
    const opened = journal.open('run-instant', null, {
      entry: (entry) => entries.push(entry),
      end: (error) => ends.push(error),
    });
    expect(opened).toMatchObject({ kind: 'opened', ended: { error: null } });
    expect(entries[0]?.event).toMatchObject({
      kind: 'execution',
      execution: { status: 'success' },
    });
    journal.close();
  });

  it('reconciles a run that changed after its start answered but before the journal followed it', async () => {
    const { worker, journal } = await started('run-moved');
    const run = worker.runs.get('run-moved');
    if (!run) throw new Error('No run.');
    const stale = run.execution;
    // Changed unseen: no observer was attached yet.
    run.execution = { ...run.execution, pendingPauseCount: 3 };
    journal.track(worker, 'run-moved', stale);
    await settle();
    const entries: PipelineEventJournalEntry[] = [];
    journal.open('run-moved', null, {
      entry: (entry) => entries.push(entry),
      end: () => undefined,
    });
    expect(entries[entries.length - 1]?.event).toMatchObject({
      kind: 'execution',
      event: 'snapshot',
      execution: { status: 'running', pendingPauseCount: 3 },
    });
    journal.close();
  });

  it('keeps what the observer saw over a resume answer that arrives later', async () => {
    const { worker, journal } = await started('run-repaused');
    const run = worker.runs.get('run-repaused');
    if (!run) throw new Error('No run.');
    const resumed = run.execution;
    trackRun(worker, journal, 'run-repaused');
    worker.finish('run-repaused', 'paused');
    // The resume's answer, older than the pause the observer saw.
    journal.track(worker, 'run-repaused', resumed);
    const entries: PipelineEventJournalEntry[] = [];
    journal.open('run-repaused', null, {
      entry: (entry) => entries.push(entry),
      end: () => undefined,
    });
    expect(entries[0]?.event).toMatchObject({
      kind: 'execution',
      execution: { status: 'paused' },
    });
    journal.close();
  });

  it('starts a retried finished run on a new journal its old cursors cannot reach', async () => {
    const { worker, journal } = await started('run-retried');
    trackRun(worker, journal, 'run-retried');
    const before = follow(journal, 'run-retried', null);
    worker.finish('run-retried', 'failure');
    const run = worker.runs.get('run-retried');
    if (!run) throw new Error('No run.');
    run.execution = { ...run.execution, status: 'running', completedAt: null };
    trackRun(worker, journal, 'run-retried');
    expect(
      follow(journal, 'run-retried', before.entries[0].cursor).opened,
    ).toBe('snapshot_required');
    const after = follow(journal, 'run-retried', null);
    expect(after.entries[0]?.event).toMatchObject({
      kind: 'execution',
      execution: { status: 'running' },
    });
    expect(after.entries[0]?.cursor.daemonEpoch).not.toBe(
      before.entries[0].cursor.daemonEpoch,
    );
    journal.close();
  });

  it('keeps no journal for an unfinished run it cannot follow', async () => {
    const { worker, journal } = await started('run-unfollowed');
    const run = worker.runs.get('run-unfollowed');
    if (!run) throw new Error('No run.');
    const stale = run.execution;
    worker.finish('run-unfollowed', 'paused');
    const unobservable: PipelineExecutionWorker = Object.assign(
      Object.create(worker) as FakeRunnerWorker,
      { observe: (): null => null },
    );
    journal.track(unobservable, 'run-unfollowed', stale);
    await settle();
    expect(follow(journal, 'run-unfollowed', null).opened).toBe('untracked');
    journal.close();
  });

  it('keeps the notifications of an unfollowed run for the stream that reads the worker', async () => {
    const { worker, journal } = await started('run-early');
    const run = worker.runs.get('run-early');
    if (!run) throw new Error('No run.');
    const stale = run.execution;
    // Paused before its start answered, after notifying.
    worker.finish('run-early', 'paused');
    const early = { stepId: 's', title: 'early', body: '' };
    let kept = [early];
    const unobservable: PipelineExecutionWorker = Object.assign(
      Object.create(worker) as FakeRunnerWorker,
      {
        observe: (): null => null,
        takeNotifications: () => {
          const taken = kept;
          kept = [];
          return taken;
        },
      },
    );
    journal.track(unobservable, 'run-early', stale);
    await settle();
    expect(follow(journal, 'run-early', null).opened).toBe('untracked');
    expect(
      withPipelineEventJournal(unobservable, journal).takeNotifications?.(
        'run-early',
      ),
    ).toEqual([early]);
    journal.close();
  });

  it('keeps a notification a closed stream never sent for the next one', async () => {
    const { worker, journal } = await started('run-unsent');
    const handlers = createWorkerPipelineHandlers(
      withPipelineEventJournal(worker, journal),
      { secrets: canarySecrets(), journal },
    );
    trackRun(worker, journal, 'run-unsent');
    const open = async (
      blocked: boolean,
    ): Promise<{
      items: WorkerPipelineExecutionEventsItem[];
      stop: (() => void) | void;
    }> => {
      const items: WorkerPipelineExecutionEventsItem[] = [];
      let first = true;
      const sink = {
        // Blocked after the snapshot, as a consumer that stopped reading.
        buffered: (): number => (blocked && !first ? 100_000 : 0),
        emit: (): null => null,
        emitAt: (
          at: CanopyStreamCursor,
          item: WorkerPipelineExecutionEventsItem,
        ): CanopyStreamCursor => {
          first = false;
          items.push(item);
          return at;
        },
        endAt: (): void => undefined,
        end: (): void => undefined,
      };
      const stop = await handlers.streams['worker.pipeline.execution.events'](
        { executionId: 'run-unsent' },
        {
          signal: new AbortController().signal,
        } as unknown as CanopyHandlerContext,
        sink,
      );
      return { items, stop };
    };
    const stuck = await open(true);
    worker.notify('run-unsent', 'unsent');
    await settle();
    expect(stuck.items.map(({ kind }) => kind)).toEqual(['execution']);
    if (typeof stuck.stop === 'function') stuck.stop();

    const next = await open(false);
    expect(next.items).toMatchObject([
      { kind: 'notification', title: 'unsent' },
      { kind: 'execution', event: 'snapshot' },
    ]);
    if (typeof next.stop === 'function') next.stop();
    journal.close();
  });

  it('sends each pending notification once across a retry while an old stream drains', async () => {
    const { worker, journal } = await started('run-acks');
    const handlers = createWorkerPipelineHandlers(
      withPipelineEventJournal(worker, journal),
      { secrets: canarySecrets(), journal },
    );
    trackRun(worker, journal, 'run-acks');
    const stream = async (
      blocked: () => boolean,
    ): Promise<{
      items: WorkerPipelineExecutionEventsItem[];
      stop: (() => void) | void;
    }> => {
      const items: WorkerPipelineExecutionEventsItem[] = [];
      const sink = {
        buffered: (): number => (blocked() ? 100_000 : 0),
        emit: (): null => null,
        emitAt: (
          at: CanopyStreamCursor,
          item: WorkerPipelineExecutionEventsItem,
        ): CanopyStreamCursor => {
          items.push(item);
          return at;
        },
        endAt: (): void => undefined,
        end: (): void => undefined,
      };
      const stop = await handlers.streams['worker.pipeline.execution.events'](
        { executionId: 'run-acks' },
        {
          signal: new AbortController().signal,
        } as unknown as CanopyHandlerContext,
        sink,
      );
      return { items, stop };
    };
    let stalled = false;
    const old = await stream(() => stalled);
    stalled = true;
    worker.notify('run-acks', 'old');
    worker.finish('run-acks', 'failure');
    // A failed-only retry: the run runs again under the same id.
    const run = worker.runs.get('run-acks');
    if (!run) throw new Error('No run.');
    run.execution = { ...run.execution, status: 'running', completedAt: null };
    trackRun(worker, journal, 'run-acks');
    worker.notify('run-acks', 'new');
    // The old stream drains: it sends 'old' under the retired journal's cursor.
    stalled = false;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const titles = (items: WorkerPipelineExecutionEventsItem[]): string[] =>
      items.flatMap((item) =>
        item.kind === 'notification' ? [item.title] : [],
      );
    expect(titles(old.items)).toEqual(['old']);

    const fresh = await stream(() => false);
    expect(titles(fresh.items)).toEqual(['new']);
    for (const opened of [old, fresh])
      if (typeof opened.stop === 'function') opened.stop();
    journal.close();
  });

  it('passes the notifications a worker kept for an unjournaled run through', async () => {
    const { worker, journal } = await started('run-kept');
    const kept = { stepId: 's', title: 'kept', body: '' };
    const journaled = withPipelineEventJournal(
      Object.assign(worker, { takeNotifications: () => [kept] }),
      journal,
    );
    expect(journaled.takeNotifications?.('run-kept')).toEqual([kept]);
    journal.close();
  });

  it('keeps a slow stream bounded: live output collapses into a gap', async () => {
    const { worker, journal } = await started('run-slow');
    const handlers = createWorkerPipelineHandlers(
      withPipelineEventJournal(worker, journal),
      { secrets: canarySecrets(), journal },
    );
    trackRun(worker, journal, 'run-slow');
    let blocked = false;
    const items: WorkerPipelineExecutionEventsItem[] = [];
    const ends: string[] = [];
    const sink = {
      buffered: (): number => (blocked ? 100_000 : 0),
      emit: (): null => null,
      emitAt: (
        at: CanopyStreamCursor,
        item: WorkerPipelineExecutionEventsItem,
      ): CanopyStreamCursor => {
        items.push(item);
        return at;
      },
      endAt: (): void => undefined,
      end: (outcome: string): void => {
        ends.push(outcome);
      },
    };
    const context = {
      signal: new AbortController().signal,
    } as unknown as CanopyHandlerContext;
    const stop = await handlers.streams['worker.pipeline.execution.events'](
      { executionId: 'run-slow' },
      context,
      sink,
    );
    expect(items).toMatchObject([{ kind: 'execution', event: 'snapshot' }]);

    blocked = true;
    worker.notify('run-slow', 'waits');
    for (let index = 0; index < 5_000; index += 1)
      worker.output('run-slow', `line ${index}`);
    blocked = false;
    await new Promise((resolve) => setTimeout(resolve, 120));
    // A gap is reported with the next item, as without a journal.
    worker.finish('run-slow', 'success');
    await settle();
    expect(ends).toEqual(['completed']);
    const outputs = items.filter((item) => item.kind === 'output').length;
    const gaps = items.flatMap((item) =>
      item.kind === 'gap' ? [item.droppedOutputItems] : [],
    );
    expect(items[1]).toMatchObject({ kind: 'notification', title: 'waits' });
    expect(outputs + gaps.reduce((total, count) => total + count, 0)).toBe(
      5_000,
    );
    expect(items.length).toBeLessThan(400);
    expect(items[items.length - 1]).toMatchObject({
      kind: 'execution',
      execution: { status: 'success' },
    });
    if (typeof stop === 'function') stop();
    journal.close();
  });
});

describe('owner requests over a relay: the supervisor runner', () => {
  const PROXY_KEY = 'proxy-key-canary-6161';
  const PROXY_URL = 'https://llm-proxy.runner.internal';
  const STEP_FOLDER = `${RUNNER_PATHS.checkout}/.step`;
  const LLM_ROUTE = 'route_llmproxy0001';
  const FEED_ROUTE = 'route_feedtools0001';

  let request = 0;
  const ownerRequest = (
    executionId: string,
    action: WorkerPipelineHostRequest['request'],
  ): WorkerPipelineHostRequest => ({
    requestId: `owner:${executionId}:${(request += 1)}`,
    executionId,
    jobId: '_run',
    stepId: '_run',
    childExecutionId: null,
    attempt: 0,
    iteration: 0,
    owner: 'personal',
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    request: action,
  });

  /** The web core's answers: route ids for capabilities, never values. */
  const answer = (
    item: WorkerPipelineHostRequest,
  ): WorkerPipelineHostResult => {
    switch (item.request.action) {
      case 'owner.model.routing':
        return {
          status: 'owner',
          value: {
            kind: 'model.routing',
            override: {
              provider: 'claude',
              model: 'claude-sonnet-5-5',
              modelGatewayRouted: false,
              accountProxyRouted: false,
              routeId: LLM_ROUTE,
            },
          },
        };
      case 'owner.ledger.subprocessTools':
        return {
          status: 'owner',
          value: { kind: 'ledger.subprocessTools', routeId: FEED_ROUTE },
        };
      case 'owner.ledger.codexTools':
        return {
          status: 'owner',
          value: { kind: 'ledger.codexTools', tools: null },
        };
      case 'owner.claude.modAdmission':
        return {
          status: 'owner',
          value: { kind: 'claude.modAdmission', context: null },
        };
      default:
        return {
          status: 'failure',
          failureReason: null,
          message: 'Not answered here.',
          outputs: {},
        };
    }
  };

  /** The runner's own route resolution, with its bootstrap credentials. */
  const remoteOwner: PipelineRemoteOwner = {
    leaseTtlMs: LEASE_TTL_MS,
    resolveOwnerValues: (_request, result) =>
      Promise.resolve(
        result.kind === 'model.routing' &&
          result.override?.routeId === LLM_ROUTE
          ? {
              env: {
                ANTHROPIC_BASE_URL: PROXY_URL,
                ANTHROPIC_AUTH_TOKEN: PROXY_KEY,
              },
            }
          : result.kind === 'ledger.subprocessTools' &&
              result.routeId === FEED_ROUTE
            ? {
                ledgerSubprocessTools: {
                  mcpServers: {
                    feed: { type: 'http', url: `${PROXY_URL}/feed` },
                  },
                  allowedTools: ['mcp__feed__add'],
                  secretValues: [PROXY_KEY],
                },
              }
            : undefined,
      ),
  };

  const connect = async (
    options: RelayRunnerOptions,
  ): Promise<{
    core: FakePipelineCore;
    seen: WorkerPipelineHostRequest[];
    raise: (
      action: WorkerPipelineHostRequest['request'],
    ) => Promise<PipelineHostSettlement>;
  }> => {
    const runner = supervisorRunner(options);
    const core = new FakePipelineCore(runner);
    const seen: WorkerPipelineHostRequest[] = [];
    await core.own((item) => {
      seen.push(item);
      return answer(item);
    });
    await core.start(
      portableStart('run-owner', portableLaunch({ ownerBound: true })),
    );
    const raise = runner.raise;
    if (!raise) throw new Error('The runner raises no requests.');
    return {
      core,
      seen,
      raise: (action) => raise(ownerRequest('run-owner', action)),
    };
  };

  const open: FakePipelineCore[] = [];
  afterEach(async () => {
    for (const core of open.splice(0)) {
      core.close();
      await core.runner.stop();
    }
  });

  it('a remote owner gets the Ledger tool requests without the step’s folder and never the local-only ones', async () => {
    const { core, seen, raise } = await connect({ remoteOwner });
    open.push(core);

    const tools = await raise({
      action: 'owner.ledger.subprocessTools',
      attemptKey: 'attempt-1',
      cwd: STEP_FOLDER,
    });
    expect(tools).toMatchObject({
      kind: 'owner',
      settlement: {
        result: { status: 'owner', value: { kind: 'ledger.subprocessTools' } },
        values: {
          ledgerSubprocessTools: { allowedTools: ['mcp__feed__add'] },
        },
      },
    });
    await raise({
      action: 'owner.ledger.codexTools',
      attemptKey: 'attempt-1',
      cwd: STEP_FOLDER,
    });
    const mods = await raise({
      action: 'owner.claude.modAdmission',
      cwd: STEP_FOLDER,
      settingSources: [],
      claudeConfigDir: `${RUNNER_PATHS.dataRoot}/claude`,
    });
    // The runner answered it itself: Mod admission is off for the run.
    expect(mods).toMatchObject({
      kind: 'owner',
      settlement: {
        result: { value: { kind: 'claude.modAdmission', context: null } },
      },
    });
    // CAN-6168: nor does a plugin MCP credential: the runner refuses each.
    const mcp = await Promise.all([
      raise({
        action: 'owner.mcp.bind',
        marketplaceId: 'market',
        pluginName: 'notes',
        serverName: 'docs',
        contentHash: 'a'.repeat(64),
      }),
      raise({
        action: 'owner.mcp.authorize',
        routeRef: 'mcpr1_AAAAAAAAAAAAAAAAAAAAAA',
      }),
      raise({
        action: 'owner.mcp.rejected',
        grantId: 'mcpg1_AAAAAAAAAAAAAAAAAAAAAA',
      }),
    ]);
    expect(
      mcp.map((answer) =>
        answer.kind === 'owner' ? answer.settlement : undefined,
      ),
    ).toEqual([
      {
        result: {
          status: 'owner',
          value: { kind: 'mcp.bind', routeRef: null },
        },
      },
      {
        result: {
          status: 'owner',
          value: { kind: 'mcp.authorize', grantId: null },
        },
      },
      { result: { status: 'owner', value: { kind: 'mcp.rejected' } } },
    ]);

    expect(seen.map(({ request }) => request)).toEqual([
      { action: 'owner.ledger.subprocessTools', attemptKey: 'attempt-1' },
      { action: 'owner.ledger.codexTools', attemptKey: 'attempt-1' },
    ]);
    const wire = core.wireText();
    for (const path of Object.values(RUNNER_PATHS))
      expect(wire).not.toContain(path);
    expect(wire).not.toContain(PROXY_KEY);
  });

  it('a remote owner answers routing with a route id the runner resolves itself (P9)', async () => {
    const { core, raise } = await connect({ remoteOwner });
    open.push(core);
    const routed = await raise({
      action: 'owner.model.routing',
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      routeSessionId: 'route-session-1',
    });
    expect(routed).toMatchObject({
      kind: 'owner',
      settlement: {
        result: {
          value: { kind: 'model.routing', override: { routeId: LLM_ROUTE } },
        },
        values: {
          env: {
            ANTHROPIC_BASE_URL: PROXY_URL,
            ANTHROPIC_AUTH_TOKEN: PROXY_KEY,
          },
        },
      },
    });
    const wire = core.wireText();
    expect(wire).toContain(LLM_ROUTE);
    expect(wire).not.toContain(PROXY_KEY);
    expect(wire).not.toContain(PROXY_URL);
  });

  it('a route id the runner cannot resolve runs the step with no route values', async () => {
    const { core, raise } = await connect({
      remoteOwner: { leaseTtlMs: LEASE_TTL_MS },
    });
    open.push(core);
    const routed = await raise({
      action: 'owner.model.routing',
      provider: 'claude',
      routeSessionId: 'route-session-2',
    });
    expect(routed).toMatchObject({ kind: 'owner' });
    expect(routed.kind === 'owner' && routed.settlement.values).toBeFalsy();
  });

  it('a local owner still gets every request with the step’s folder, as on desktop', async () => {
    const { core, seen, raise } = await connect({});
    open.push(core);
    await raise({
      action: 'owner.ledger.subprocessTools',
      attemptKey: 'attempt-2',
      cwd: STEP_FOLDER,
    });
    await raise({
      action: 'owner.claude.modAdmission',
      cwd: STEP_FOLDER,
      settingSources: ['user'],
    });
    expect(seen.map(({ request }) => request)).toEqual([
      {
        action: 'owner.ledger.subprocessTools',
        attemptKey: 'attempt-2',
        cwd: STEP_FOLDER,
      },
      {
        action: 'owner.claude.modAdmission',
        cwd: STEP_FOLDER,
        settingSources: ['user'],
      },
    ]);
  });

  it('a route id is a reference, never a credential', () => {
    for (const valid of [LLM_ROUTE, 'route_0123456789abcdef_-'])
      expect(WORKER_PIPELINE_ROUTE_ID_PATTERN.test(valid)).toBe(true);
    for (const invalid of [
      PROXY_KEY,
      PROXY_URL,
      'route_short',
      `route_${'x'.repeat(129)}`,
      'route_has space',
    ])
      expect(WORKER_PIPELINE_ROUTE_ID_PATTERN.test(invalid)).toBe(false);
  });
});

/** A core session in front of a relay leg, delivering in order. */
function coreSessionTo(
  leg: ReturnType<typeof serveRunnerOverRelayLeg>,
  key: Uint8Array = RELAY_SESSION_KEY,
): {
  readonly session: PipelineRelaySession;
  readonly received: string[];
  readonly frames: string[];
  readonly failed: string[];
} {
  const received: string[] = [];
  const frames: string[] = [];
  const failed: string[] = [];
  const session = createPipelineRelaySession({
    role: 'core',
    sessionKey: key,
    send: (text) => {
      frames.push(text);
      leg.receive(text);
      return true;
    },
    onReady: () => undefined,
    onMessage: (text) => received.push(text),
    onFailed: (reason) => failed.push(reason),
  });
  leg.listen({
    message: (text) => {
      frames.push(text);
      session.receive(text);
    },
    close: () => failed.push('closed'),
  });
  session.start();
  return { session, received, frames, failed };
}

describe('the cloud runner relay leg (CP-11)', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    jest.useRealTimers();
    for (const stop of stops.splice(0)) await stop();
  });

  it('speaks the session the web core speaks, byte for byte (session vectors)', () => {
    const key = Buffer.from(VECTORS.sessionKey, 'base64url');
    const nonce = (value: string) => (): Buffer =>
      Buffer.from(value, 'base64url');
    const runnerSent: string[] = [];
    const coreSent: string[] = [];
    const opened: string[] = [];
    const runner = createPipelineRelaySession({
      role: 'runner',
      sessionKey: key,
      nonce: nonce(VECTORS.runnerNonce),
      send: (text) => runnerSent.push(text) > 0,
      onReady: () => undefined,
      onMessage: (text) => opened.push(text),
      onFailed: (reason) => {
        throw new Error(reason);
      },
    });
    const core = createPipelineRelaySession({
      role: 'core',
      sessionKey: key,
      nonce: nonce(VECTORS.coreNonce),
      send: (text) => coreSent.push(text) > 0,
      onReady: () => undefined,
      onMessage: (text) => opened.push(text),
      onFailed: (reason) => {
        throw new Error(reason);
      },
    });
    core.start();
    expect(JSON.parse(coreSent[0])).toEqual(VECTORS.coreHello);
    runner.receive(coreSent[0]);
    expect(JSON.parse(runnerSent[0])).toEqual(VECTORS.runnerHello);
    core.receive(runnerSent[0]);
    expect(JSON.parse(coreSent[1])).toEqual(VECTORS.coreReady);
    runner.receive(coreSent[1]);
    expect(runner.ready && core.ready).toBe(true);
    for (const { plaintext, frame } of VECTORS.coreData) {
      core.send(plaintext);
      expect(JSON.parse(coreSent[coreSent.length - 1])).toEqual(frame);
      runner.receive(coreSent[coreSent.length - 1]);
    }
    for (const { plaintext, frame } of VECTORS.runnerData) {
      runner.send(plaintext);
      expect(JSON.parse(runnerSent[runnerSent.length - 1])).toEqual(frame);
      core.receive(runnerSent[runnerSent.length - 1]);
    }
    expect(opened).toEqual([
      ...VECTORS.coreData.map(({ plaintext }) => plaintext),
      ...VECTORS.runnerData.map(({ plaintext }) => plaintext),
    ]);
  });

  it('answers a request that carries _execution invalid_argument without reaching a handler', async () => {
    const runner = supervisorRunner();
    stops.push(() => runner.stop());
    const leg = serveRunnerOverRelayLeg(runner);
    const core = coreSessionTo(leg);
    await settle();
    const { portableLaunch: launch, ...rest } = portableStart('run-host');
    core.session.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'r1',
        method: 'worker.pipeline.execution.start',
        params: {
          ...rest,
          portableLaunch: launch,
          _meta: { idempotencyKey: 'run-host' },
          _execution: { pipelineLaunch: { cwd: '/host/path' } },
        },
      }),
    );
    await settle();
    expect(core.received).toHaveLength(1);
    expect(JSON.parse(core.received[0])).toMatchObject({
      id: 'r1',
      error: { data: { kind: 'invalid_argument' } },
    });
    expect(runner.launched('run-host')).toBeUndefined();
    // The leg stays open: the same start without it runs.
    core.session.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'r2',
        method: 'worker.pipeline.execution.start',
        params: {
          ...rest,
          portableLaunch: launch,
          _meta: { idempotencyKey: 'run-host' },
        },
      }),
    );
    await settle();
    expect(JSON.parse(core.received[1])).toMatchObject({
      id: 'r2',
      result: { execution: { executionId: 'run-host', status: 'running' } },
    });
    leg.close();
  });

  it('carries only ciphertext: no envelope, secret or runner path crosses the relay', async () => {
    const runner = supervisorRunner();
    stops.push(() => runner.stop());
    const link = relayLegLink(runner);
    const core = new FakePipelineCore(runner, link);
    await core.start({
      ...portableStart('run-sealed'),
      secrets: [
        {
          name: 'API_TOKEN',
          source: {
            kind: 'stored-secret',
            family: 'environment',
            record: 'config',
            ref: `ssr1_${'d'.repeat(43)}`,
          },
        },
      ],
    });
    await core.runner.output('run-sealed', 'sealed output');
    await core.get('run-sealed');
    const relayed = link.frames.join('\n');
    for (const plain of [
      'worker.pipeline',
      'run-sealed',
      'sealed output',
      SECRET_CANARY,
      RUNNER_PATHS.checkout,
    ])
      expect(relayed).not.toContain(plain);
    expect(core.wireText()).toContain('run-sealed');
    core.close();
  });

  it('ends the leg on a core that does not hold the session key', async () => {
    const runner = supervisorRunner();
    stops.push(() => runner.stop());
    const leg = serveRunnerOverRelayLeg(runner);
    const core = coreSessionTo(leg, Buffer.alloc(32, 1));
    await settle();
    expect(core.failed).toEqual(['bad_confirmation']);
    expect(core.received).toEqual([]);
    leg.close();
  });

  it('takes the first portable start’s lease TTL and refuses a start that names another', async () => {
    const runner = supervisorRunner({ remoteOwner: {} });
    stops.push(() => runner.stop());
    const core = new FakePipelineCore(runner, relayLegLink(runner));
    await core.start(
      portableStart(
        'run-ttl',
        portableLaunch({ delegationLease: { leaseTtlMs: 10 * 60_000 } }),
      ),
    );
    await expect(
      core.start(
        portableStart(
          'run-other-ttl',
          portableLaunch({ delegationLease: { leaseTtlMs: 60_000 } }),
        ),
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.launchRefused' },
    });
    expect(runner.launched('run-other-ttl')).toBeUndefined();
    core.close();
  });

  it('replays a journal longer than the default stream queue with a live change in the middle', async () => {
    // A runner's journal keeps more than the 4,096 deliveries a stream used
    // to hold, so a replay that long must not end at the next live item.
    const runner = supervisorRunner({ journal: { maxEntries: 5_000 } });
    stops.push(() => runner.stop());
    const core = new FakePipelineCore(runner, relayLegLink(runner));
    await core.start(portableStart('run-long'));
    const first = await core.events('run-long');
    const last = first.cursors[first.cursors.length - 1];
    first.close();
    await settle();
    const lines: string[] = [];
    for (let line = 0; line < 4_500; line += 1) {
      lines.push(`line ${String(line)}`);
      await runner.output('run-long', `line ${String(line)}`);
    }
    const replay = await core.events('run-long', last);
    // A change while most of the replay still waits for the consumer.
    await runner.update('run-long', { pendingPauseCount: 1 });
    await runner.finish('run-long', 'success');
    await expect(replay.ended).resolves.toMatchObject({ outcome: 'completed' });
    expect(
      replay.items.flatMap((item) =>
        item.kind === 'output' ? [item.text] : [],
      ),
    ).toEqual(lines);
    expect(replay.items[replay.items.length - 1]).toMatchObject({
      kind: 'execution',
      execution: { status: 'success' },
    });
    core.close();
  });

  it('gives a host a read started before the first start the lease TTL as its owner-request floor', async () => {
    const runner = supervisorRunner({ remoteOwner: {} });
    stops.push(() => runner.stop());
    const core = new FakePipelineCore(runner, relayLegLink(runner));
    // A read starts the host before any start brings the TTL.
    await core.list();
    expect(runner.ownerDeadlines?.()).toEqual([]);
    await core.start(
      portableStart(
        'run-floor',
        portableLaunch({ delegationLease: { leaseTtlMs: 10 * 60_000 } }),
      ),
    );
    expect(runner.ownerDeadlines?.()).toEqual([10 * 60_000]);
    core.close();
  });

  it('counts a start its host has not answered as running', async () => {
    const runner = supervisorRunner({ holdStarts: true });
    stops.push(() => runner.stop());
    const core = new FakePipelineCore(runner, relayLegLink(runner));
    const started = core.start(portableStart('run-pending'));
    for (
      let turn = 0;
      turn < 50 && (runner.runningExecutionIds?.() ?? []).length === 0;
      turn += 1
    )
      await settle();
    // A stop now checkpoints it, so the exit census counts it.
    expect(runner.runningExecutionIds?.()).toEqual(['run-pending']);
    runner.releaseStarts?.();
    await expect(started).resolves.toMatchObject({
      execution: { executionId: 'run-pending' },
    });
    expect(runner.runningExecutionIds?.()).toEqual(['run-pending']);
    core.close();
  });

  it('pauses an owner-bound run at the renewed expiry before its waiting request can fail', async () => {
    const runner = supervisorRunner({
      remoteOwner: {
        lease: { leaseEpoch: 1, expiresAt: Date.now() + 3_600_000 },
      },
    });
    stops.push(() => runner.stop());
    const core = new FakePipelineCore(runner, relayLegLink(runner));
    const leave = await core.own(() => ({
      status: 'owner',
      value: { kind: 'model.release' },
    }));
    await core.start(
      portableStart(
        'run-expiry',
        portableLaunch({
          ownerBound: true,
          delegationLease: { leaseTtlMs: 60_000 },
        }),
      ),
    );
    leave();
    await settle();
    const raise = runner.raise;
    if (!raise) throw new Error('The runner raises no requests.');
    let settled: PipelineHostSettlement | null = null;
    void raise({
      requestId: 'owner:run-expiry:1',
      executionId: 'run-expiry',
      jobId: '_run',
      stepId: '_run',
      childExecutionId: null,
      attempt: 0,
      iteration: 0,
      owner: 'personal',
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      request: { action: 'owner.model.release', routeSessionId: 'route' },
    }).then((settlement) => {
      settled = settlement;
    });
    // The owner is away when the lease is renewed to a near expiry.
    runner.observeOwnerLease?.({
      kind: 'renewed',
      lease: { leaseEpoch: 1, expiresAt: Date.now() + 300 },
    });
    for (
      let turn = 0;
      turn < 100 && !(runner.paused?.() ?? []).includes('run-expiry');
      turn += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.paused?.()).toContain('run-expiry');
    // The pause came first: the request was not failed as unavailable.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBeNull();
    core.close();
  });

  it('keeps a request waiting for its owner to a lease renewed while it waits', async () => {
    const runner = supervisorRunner({
      remoteOwner: {
        lease: { leaseEpoch: 1, expiresAt: Date.now() + 3_600_000 },
      },
    });
    stops.push(() => runner.stop());
    const core = new FakePipelineCore(runner, relayLegLink(runner));
    await core.start(
      portableStart(
        'run-wait',
        portableLaunch({ delegationLease: { leaseTtlMs: 300 } }),
      ),
    );
    const raise = runner.raise;
    if (!raise) throw new Error('The runner raises no requests.');
    // No owner is subscribed: the request waits, for the 300 ms TTL.
    const settled = raise({
      requestId: 'owner:run-wait:1',
      executionId: 'run-wait',
      jobId: '_run',
      stepId: '_run',
      childExecutionId: null,
      attempt: 0,
      iteration: 0,
      owner: 'personal',
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      request: { action: 'owner.model.release', routeSessionId: 'route' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    runner.observeOwnerLease?.({
      kind: 'renewed',
      lease: { leaseEpoch: 1, expiresAt: Date.now() + 2_000 },
    });
    // Past the TTL, the owner comes back and answers it.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await core.own(() => ({
      status: 'owner',
      value: { kind: 'model.release' },
    }));
    await expect(settled).resolves.toMatchObject({ kind: 'owner' });
    core.close();
  });

  it('survives a five-minute relay outage without losing events or pausing the run', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'],
    });
    const runner = supervisorRunner({ remoteOwner: {} });
    stops.push(() => runner.stop());
    const answer = (): WorkerPipelineHostResult => ({
      status: 'success',
      outputs: {},
    });
    const first = new FakePipelineCore(runner, relayLegLink(runner));
    await first.own(answer);
    await first.start(
      portableStart(
        'run-outage',
        portableLaunch({
          ownerBound: true,
          delegationLease: { leaseTtlMs: 10 * 60_000 },
        }),
      ),
    );
    const before = await first.events('run-outage');
    await runner.output('run-outage', 'before');
    const last = before.cursors[before.cursors.length - 1];

    // The relay drops the runner's connection: its streams and the owner's
    // subscription end with it, and the runner keeps running.
    first.close();
    await settle();
    const during: string[] = [];
    for (let minute = 0; minute < 5; minute += 1) {
      for (let line = 0; line < 200; line += 1) {
        const text = `minute ${String(minute)} line ${String(line)}`;
        during.push(text);
        await runner.output('run-outage', text);
      }
      await jest.advanceTimersByTimeAsync(60_000);
    }

    // The runner dials again: a new attachment, a new session.
    const second = new FakePipelineCore(runner, relayLegLink(runner));
    await second.own(answer);
    const after = await second.events('run-outage', last);
    expect(after.acceptedCursor).toEqual(last);
    // The replay waits for its consumer: a held item retries every 50 ms.
    for (
      let turn = 0;
      turn < 200 && after.items.length < during.length;
      turn += 1
    ) {
      await jest.advanceTimersByTimeAsync(50);
      await settle();
    }
    expect(
      after.items.flatMap((item) =>
        item.kind === 'output' ? [item.text] : [],
      ),
    ).toEqual(during);
    expect(after.items.some((item) => item.kind === 'execution')).toBe(false);
    expect(runner.paused?.()).toEqual([]);
    await expect(second.get('run-outage')).resolves.toMatchObject({
      execution: { status: 'running' },
    });

    // The owner's absence timer was cleared by its return.
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(runner.paused?.()).toEqual([]);
    await runner.finish('run-outage', 'success');
    await expect(after.ended).resolves.toMatchObject({ outcome: 'completed' });
    second.close();
  });
});
