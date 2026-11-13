// CAN-6161 (cloud pipelines CP-03): the two ends of the worker.pipeline relay
// contract, for the conformance suite in pipeline-relay-conformance.test.ts.
//
// - A fake core, the web core's stand-in, that reaches a runner only through
//   a serializing JSON-RPC pair: every frame is validated and serialized, and
//   no request may carry `_execution`, as over the relay.
// - Two runners behind it: the supervisor composition a cloud runner reuses
//   (PipelineHostSupervisor, the owner channel and the worker.pipeline
//   handlers, apps/core-daemon/src/pipelines.ts) over a fake pipeline host,
//   and a reference in-memory runner for the web core's own suite (CP-20).
//
// Both runners record what their host was asked to run, so the suite can
// check the portable start's mapping to runner paths.
import { EventEmitter } from 'node:events';
import {
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_QUERY_DEFINITIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
  CanopyJsonRpcMessageSchema,
  WorkerPipelineExecutionGetResultSchema,
  WorkerPipelineExecutionListResultSchema,
  WorkerPipelineExecutionEventsItemSchema,
  WorkerPipelineExecutionResultSchema,
  WorkerPipelineHostRequestsItemSchema,
  isWorkerPipelineHostWithdrawal,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyStreamCursor,
  type WorkerPipelineExecutionEventsItem,
  type CanopyJsonRpcMessage,
  type WorkerPipelineControlResult,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineExecutionView,
  type WorkerPipelineHostLaunch,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostRequestsItem,
  type WorkerPipelineHostResult,
  type WorkerPipelinePortableLaunch,
  type WorkerPipelineRecoveryCheckpointResult,
  type WorkerPipelineRecoverySweepResult,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../../runtime/dispatcher';
import {
  createInProcessWorkerBinding,
  type InProcessWorkerBinding,
} from '../../../../runtime/in-process-worker-binding';
import { serializingWorkerPair } from '../../../../runtime/__tests__/serializing-worker-pair';
import { canopyUnavailableError } from '../../../../runtime/errors';
import { connectLocalWorkerBinding } from '../../../../runtime/local-worker-binding-client';
import { serveLocalWorkerBinding } from '../../../../runtime/local-worker-binding-server';
import type { WorkerBindingConnection } from '../../../../runtime/local-worker-binding-wire';
import type { CanopyRuntimeHandlerMaps } from '../../../../runtime/types';
import {
  executionSecretNotGrantedError,
  type ExecutionSecretSource,
  type RedeemedExecutionSecrets,
} from '../../../execution-secrets';
import {
  PipelineEventJournal,
  createPipelineOwnerChannel,
  createWorkerPipelineHandlers,
  withPipelineEventJournal,
  isTerminalPipelineExecution,
  pipelineExecutionNotFoundError,
  pipelineLaunchUnavailableError,
  pipelineOwnerUnavailableError,
  pipelinePortableLaunchRefusedError,
  type PipelineExecutionListPage,
  type PipelineExecutionListQuery,
  type PipelineExecutionObserver,
  type PipelineExecutionWorker,
  type PipelineOwnerChannel,
} from '../../execution';
import {
  PipelineHostSupervisor,
  createPipelineRelaySession,
  servePipelineRelayLeg,
  type PipelineHostLaunch,
  type PipelineHostMessage,
  type PipelineHostProcess,
  type PipelineHostRequestMessage,
  type PipelineHostSettlement,
  type PipelineRemoteOwner,
} from '..';

/** What a runner serves to its primary over the relay: the daemon's set. */
export const RELAY_DEFINITIONS = {
  queries: {
    'worker.pipeline.execution.get':
      WORKER_PIPELINE_QUERY_DEFINITIONS['worker.pipeline.execution.get'],
    'worker.pipeline.execution.list':
      WORKER_PIPELINE_QUERY_DEFINITIONS['worker.pipeline.execution.list'],
  },
  instructions: {
    'worker.pipeline.execution.start':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.execution.start'
      ],
    'worker.pipeline.execution.cancel':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.execution.cancel'
      ],
    'worker.pipeline.hostRequest.respond':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.hostRequest.respond'
      ],
  },
  streams: {
    'worker.pipeline.execution.events':
      WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.execution.events'],
    'worker.pipeline.hostRequests':
      WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.hostRequests'],
  },
};

/** The web core as the runner's caller: its owner, with the host grant. */
export const RELAY_CALLER: CanopyCallerDescriptor = {
  principalId: 'web-core',
  clientInstanceId: 'web-core:pipeline-runs',
  authorityId: 'web-core-authority',
  interfaceKind: 'worker',
  grants: [
    'worker.pipeline.read',
    'worker.pipeline.write',
    'worker.pipeline.host',
  ],
};

/** Where every runner puts things: never sent, never on the wire. */
export const RUNNER_PATHS = Object.freeze({
  checkout: '/runner/checkout',
  bundledActionsDir: '/runner/actions',
  dataRoot: '/runner/data',
  node: '/runner/node/bin/node',
});

/** The value the fake secret source redeems; it must never reach the wire. */
export const SECRET_CANARY = 'relay-secret-canary-6161';

/**
 * Redeems every binding to the canary once per dispatch, as a staged grant
 * is used up (CAN-5067): a second redemption for the same start fails.
 */
export function canarySecrets(): ExecutionSecretSource {
  const redeemed = new Set<string>();
  return {
    redeem: ({ audience, bindings }) => {
      const key = `${audience.operation}:${audience.key}`;
      if (redeemed.has(key))
        return Promise.reject(executionSecretNotGrantedError());
      redeemed.add(key);
      return Promise.resolve({
        env: Object.fromEntries(
          bindings.map((binding) => [binding.name, SECRET_CANARY]),
        ),
      });
    },
  };
}

export const LEASE_TTL_MS = 5 * 60_000;

export function portableLaunch(
  overrides: Partial<WorkerPipelinePortableLaunch> = {},
): WorkerPipelinePortableLaunch {
  return {
    definition: {
      pin: { contentHash: 'a'.repeat(64), packageDigest: null },
      snapshot: { name: 'relay', on: 'dispatch', jobs: { j: { steps: [] } } },
    },
    inputs: { greeting: 'hello' },
    env: { STEP_VALUE: 'from-start' },
    delegationLease: { leaseTtlMs: LEASE_TTL_MS },
    ...overrides,
  };
}

export function portableStart(
  executionId: string,
  launch: WorkerPipelinePortableLaunch = portableLaunch(),
): WorkerPipelineExecutionStartParams {
  return {
    executionId,
    pipelineId: 'relay-pipeline',
    definitionSource: 'shared',
    runScope: 'worktree',
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    owner: 'personal',
    initiationSource: 'automation',
    portableLaunch: launch,
  };
}

/** The runner's own mapping of a portable start to its paths (CP-07's resolveLaunch). */
export function runnerLaunchOf(
  params: WorkerPipelineExecutionStartParams & {
    portableLaunch: WorkerPipelinePortableLaunch;
  },
  secrets: RedeemedExecutionSecrets,
): PipelineHostLaunch {
  const { portableLaunch: portable, secrets: _bindings, ...rest } = params;
  void _bindings;
  const { definition, delegationLease: _lease, ...members } = portable;
  void _lease;
  const launch: WorkerPipelineHostLaunch = {
    ...members,
    pipeline: definition.snapshot,
    cwd: RUNNER_PATHS.checkout,
    repoPath: RUNNER_PATHS.checkout,
    bundledActionsDir: RUNNER_PATHS.bundledActionsDir,
    nodeProcess: { command: RUNNER_PATHS.node },
    secretEnv: { ...secrets.env },
  };
  return {
    params: rest,
    launch,
    processEnvironment: { PATH: '/usr/bin:/bin' },
  };
}

function projectionOf(
  params: Pick<
    WorkerPipelineExecutionStartParams,
    | 'executionId'
    | 'pipelineId'
    | 'runScope'
    | 'definitionSource'
    | 'owner'
    | 'workspaceId'
    | 'worktreeId'
  >,
): WorkerPipelineExecution {
  return {
    executionId: params.executionId,
    pipelineId: params.pipelineId,
    name: 'relay',
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
  };
}

function journalOf(options: RelayRunnerOptions): PipelineEventJournal | null {
  if (options.journal === false) return null;
  return new PipelineEventJournal({
    ...(options.journal?.maxEntries !== undefined && {
      maxEntries: options.journal.maxEntries,
    }),
    ...(options.journal?.retainMs !== undefined && {
      retainMs: options.journal.retainMs,
    }),
    ...(options.journal?.expiry && {
      expireAfter: options.journal.expiry.expireAfter,
    }),
  });
}

/**
 * Journal expiries a test fires itself (CAN-6221). A retention timer races
 * the test's own work under load: a journal can expire before the stream
 * the test opens on it.
 */
export class ManualJournalExpiry {
  private readonly armed = new Set<() => void>();

  private readonly waiting = new Set<() => void>();

  public readonly expireAfter = (expire: () => void): (() => void) => {
    const fire = (): void => {
      this.armed.delete(fire);
      expire();
    };
    this.armed.add(fire);
    for (const resolve of [...this.waiting]) resolve();
    this.waiting.clear();
    return () => {
      this.armed.delete(fire);
    };
  };

  /** Settles once a journal is waiting to expire. */
  public whenArmed(): Promise<void> {
    if (this.armed.size > 0) return Promise.resolve();
    return new Promise((resolve) => this.waiting.add(resolve));
  }

  /** Expires every journal waiting to, once one is. */
  public async expire(): Promise<void> {
    await this.whenArmed();
    for (const fire of [...this.armed]) fire();
  }
}

function settled(
  execution: WorkerPipelineExecution,
  status: WorkerPipelineExecution['status'],
): WorkerPipelineExecution {
  return {
    ...execution,
    status,
    completedAt: isTerminalPipelineExecution({ ...execution, status })
      ? new Date().toISOString()
      : null,
  };
}

export interface RelayStreamEnd {
  readonly outcome: string;
  readonly error: CanopyErrorPayload | null;
}

/** One events stream as the fake core follows it. */
export interface RelayEventsStream {
  readonly acceptedCursor: CanopyStreamCursor | null;
  /** Each item, parsed, with the frame cursor at the same index. */
  readonly items: WorkerPipelineExecutionEventsItem[];
  readonly cursors: CanopyStreamCursor[];
  readonly ended: Promise<RelayStreamEnd>;
  close(): void;
}

/** What a runner under test exposes besides its handlers. */
export interface RelayRunner {
  readonly name: string;
  readonly handlers: CanopyRuntimeHandlerMaps<
    (typeof RELAY_DEFINITIONS)['queries'],
    (typeof RELAY_DEFINITIONS)['instructions'],
    (typeof RELAY_DEFINITIONS)['streams']
  >;
  /** What the runner's host was asked to run for this execution, if anything. */
  launched(executionId: string): PipelineHostLaunch | undefined;
  /**
   * The same runner with a fresh handler layer, as after the worker
   * restarted its handlers or lost a start receipt.
   */
  rehandled(): RelayRunner;
  /** A step's output line, as its host would print it. */
  output(executionId: string, text: string): Promise<void>;
  /** A desktop notification a step asked for (CAN-5868). */
  notify(executionId: string, title: string): Promise<void>;
  /** A change to the run that keeps its status, as its host would report it. */
  update(
    executionId: string,
    patch: Partial<WorkerPipelineExecution>,
  ): Promise<void>;
  /**
   * Raises a host or owner request as the run's host would, and resolves
   * with how the runner settled it for the host; only a runner with a
   * pipeline host raises them.
   */
  readonly raise?: (
    request: WorkerPipelineHostRequest,
  ) => Promise<PipelineHostSettlement>;
  /**
   * Every run its host was asked to pause, in order (an owner-loss or hung
   * owner pause); only a runner with a pipeline host pauses them.
   */
  readonly paused?: () => readonly string[];
  /** Every owner-request floor its hosts were given (CP-11). */
  readonly ownerDeadlines?: () => readonly number[];
  /** What its supervisor counts as running (CP-11). */
  readonly runningExecutionIds?: () => readonly string[];
  /** Answers the starts its hosts held back. */
  readonly releaseStarts?: () => void;
  /** What its relay binding learned about the delegation lease (CAN-6198). */
  readonly observeOwnerLease?: (
    observation: Parameters<PipelineHostSupervisor['observeOwnerLease']>[0],
  ) => void;
  /** Ends a run as its host would. */
  finish(
    executionId: string,
    status: WorkerPipelineExecution['status'],
  ): Promise<void>;
  stop(): Promise<void>;
}

export interface RelayRunnerOptions {
  /** The runner's owner is remote, with this lease (CAN-6102) and route resolution (CAN-6161). */
  readonly remoteOwner?: PipelineRemoteOwner;
  /** Whether the runner maps portable starts; a desktop-like worker doesn't. */
  readonly portable?: boolean;
  /** The runner's event journal (CAN-6161); `false` for none. Default on. */
  readonly journal?:
    | false
    | {
        readonly maxEntries?: number;
        readonly retainMs?: number;
        readonly expiry?: ManualJournalExpiry;
      };
  /**
   * Where the start handler redeems bindings: a hosted activation's grant
   * (CAN-6215). Default: the canary source, a fresh one per handler set.
   */
  readonly secrets?: ExecutionSecretSource;
  /** The host holds its answer to each start until `releaseStarts` (CP-11). */
  readonly holdStarts?: boolean;
}

/** One run as a fake host keeps it. */
interface HostedRun {
  launch: PipelineHostLaunch;
  execution: WorkerPipelineExecution;
}

/** A pipeline host in memory: answers every op the supervisor sends. */
class FakePipelineHost extends EventEmitter implements PipelineHostProcess {
  readonly runs = new Map<string, HostedRun>();

  /** Every execution a `pause` op named. */
  readonly paused: string[] = [];

  /** Every owner-request floor the supervisor gave it (CP-11). */
  readonly ownerDeadlines: number[] = [];

  /** Start answers held back, when it holds them. */
  readonly heldStarts: Array<() => void> = [];

  constructor(private readonly holdStarts = false) {
    super();
  }

  /** What the supervisor settled each raised request with, by request id. */
  private readonly settlements = new Map<
    string,
    (settlement: PipelineHostSettlement) => void
  >();

  raise(request: WorkerPipelineHostRequest): Promise<PipelineHostSettlement> {
    return new Promise((resolve) => {
      this.settlements.set(request.requestId, resolve);
      this.send({ kind: 'hostRequest', request });
    });
  }

  postMessage({ id, request }: PipelineHostRequestMessage): void {
    switch (request.op) {
      case 'hostSettled':
        this.settlements.get(request.requestId)?.(request.settlement);
        this.settlements.delete(request.requestId);
        this.reply(id, null);
        return;
      case 'pause':
        this.paused.push(...request.executionIds);
        this.reply(id, null);
        return;
      case 'configure':
        if (request.ownerRequestDeadlineMs !== undefined)
          this.ownerDeadlines.push(request.ownerRequestDeadlineMs);
        this.reply(id, null);
        return;
      case 'start': {
        const { params } = request.start;
        const execution = projectionOf(params);
        this.runs.set(params.executionId, { launch: request.start, execution });
        if (this.holdStarts)
          this.heldStarts.push(() => this.reply(id, execution));
        else this.reply(id, execution);
        return;
      }
      case 'get': {
        const run = this.runs.get(request.executionId);
        if (!run) this.reply(id, null);
        else
          this.reply(
            id,
            request.detail ? { execution: run.execution } : run.execution,
          );
        return;
      }
      case 'list':
        this.reply(id, {
          executions: [...this.runs.values()].map(({ execution }) => ({
            execution,
          })),
          more: false,
        });
        return;
      case 'cancel': {
        const run = this.runs.get(request.executionId);
        if (!run) {
          this.send({
            kind: 'response',
            id,
            ok: false,
            error: { code: 'not_found', message: 'No such run.' },
          });
          return;
        }
        this.finish(request.executionId, 'cancelled');
        this.reply(id, run.execution);
        return;
      }
      case 'sweep':
        this.reply(id, { failureCount: 0 });
        return;
      case 'checkpoint':
        this.reply(id, { checkpointedCount: 0 });
        return;
      case 'ownerDeadline':
        this.ownerDeadlines.push(request.ownerRequestDeadlineMs);
        this.reply(id, null);
        return;
      case 'exit':
        this.reply(id, null);
        queueMicrotask(() => this.emit('exit', 0));
        return;
    }
  }

  kill(): boolean {
    queueMicrotask(() => this.emit('exit', 137));
    return true;
  }

  update(executionId: string, patch: Partial<WorkerPipelineExecution>): void {
    const run = this.runs.get(executionId);
    if (!run) throw new Error(`No run ${executionId}.`);
    run.execution = { ...run.execution, ...patch };
    this.send({
      kind: 'execution',
      executionId,
      event: 'execution.updated',
      execution: run.execution,
    });
  }

  notify(executionId: string, title: string): void {
    this.send({
      kind: 'notification',
      executionId,
      stepId: 's',
      title,
      body: '',
    });
  }

  output(executionId: string, text: string): void {
    this.send({
      kind: 'output',
      executionId,
      jobId: 'j',
      stepId: 's',
      stream: 'stdout',
      text,
    });
  }

  finish(executionId: string, status: WorkerPipelineExecution['status']): void {
    const run = this.runs.get(executionId);
    if (!run) throw new Error(`No run ${executionId}.`);
    run.execution = settled(run.execution, status);
    this.send({
      kind: 'execution',
      executionId,
      event: 'execution.completed',
      execution: run.execution,
    });
  }

  private reply(id: number, value: unknown): void {
    this.send({ kind: 'response', id, ok: true, value });
  }

  private send(message: PipelineHostMessage): void {
    queueMicrotask(() => this.emit('message', message));
  }
}

function handlersOf(
  worker: PipelineExecutionWorker,
  owner: PipelineOwnerChannel,
  journal: PipelineEventJournal | null,
  secrets: ExecutionSecretSource = canarySecrets(),
): RelayRunner['handlers'] {
  const all = createWorkerPipelineHandlers(
    journal ? withPipelineEventJournal(worker, journal) : worker,
    { secrets, ...(journal && { journal }) },
  );
  return {
    queries: {
      'worker.pipeline.execution.get':
        all.queries['worker.pipeline.execution.get'],
      'worker.pipeline.execution.list':
        all.queries['worker.pipeline.execution.list'],
    },
    instructions: {
      'worker.pipeline.execution.start':
        all.instructions['worker.pipeline.execution.start'],
      'worker.pipeline.execution.cancel':
        all.instructions['worker.pipeline.execution.cancel'],
      'worker.pipeline.hostRequest.respond':
        owner.handlers.instructions['worker.pipeline.hostRequest.respond'],
    },
    streams: {
      'worker.pipeline.execution.events':
        all.streams['worker.pipeline.execution.events'],
      'worker.pipeline.hostRequests':
        owner.handlers.streams['worker.pipeline.hostRequests'],
    },
  };
}

/** The supervisor composition a cloud runner reuses (ADR 31), over a fake host. */
export function supervisorRunner(
  options: RelayRunnerOptions = {},
): RelayRunner {
  const owner = createPipelineOwnerChannel();
  const hosts: FakePipelineHost[] = [];
  const supervisor = new PipelineHostSupervisor({
    launch: (): PipelineHostProcess => {
      const host = new FakePipelineHost(options.holdStarts === true);
      hosts.push(host);
      return host;
    },
    configure: { dataRoot: RUNNER_PATHS.dataRoot },
    // A runner never runs a host-local launch: nothing on its host stages one.
    resolveLaunch: (): Promise<PipelineHostLaunch> =>
      Promise.reject(pipelinePortableLaunchRefusedError()),
    ...(options.portable !== false && {
      resolvePortableLaunch: (params, secrets): Promise<PipelineHostLaunch> =>
        Promise.resolve(runnerLaunchOf(params, secrets)),
    }),
    idleStopMs: 3_600_000,
    owner,
    ...(options.remoteOwner && { remoteOwner: options.remoteOwner }),
  });
  const hostOf = (executionId: string): FakePipelineHost | undefined =>
    hosts.find((host) => host.runs.has(executionId));
  const journal = journalOf(options);
  const runner: RelayRunner = {
    name: 'supervisor runner',
    handlers: handlersOf(supervisor, owner, journal, options.secrets),
    rehandled: () => ({
      ...runner,
      handlers: handlersOf(supervisor, owner, journal, options.secrets),
    }),
    output: async (executionId, text) => {
      const host = hostOf(executionId);
      if (!host) throw new Error(`No run ${executionId}.`);
      host.output(executionId, text);
      await settle();
    },
    notify: async (executionId, title) => {
      const host = hostOf(executionId);
      if (!host) throw new Error(`No run ${executionId}.`);
      host.notify(executionId, title);
      await settle();
    },
    update: async (executionId, patch) => {
      const host = hostOf(executionId);
      if (!host) throw new Error(`No run ${executionId}.`);
      host.update(executionId, patch);
      await settle();
    },
    raise: (request) => {
      const host = hostOf(request.executionId);
      if (!host) throw new Error(`No run ${request.executionId}.`);
      return host.raise(request);
    },
    launched: (executionId) =>
      hostOf(executionId)?.runs.get(executionId)?.launch,
    paused: () => hosts.flatMap((host) => host.paused),
    ownerDeadlines: () => hosts.flatMap((host) => host.ownerDeadlines),
    runningExecutionIds: () => supervisor.runningExecutionIds(),
    releaseStarts: () => {
      for (const host of hosts)
        for (const answer of host.heldStarts.splice(0)) answer();
    },
    observeOwnerLease: (observation) =>
      supervisor.observeOwnerLease(observation),
    finish: async (executionId, status) => {
      const host = hostOf(executionId);
      if (!host) throw new Error(`No run ${executionId}.`);
      host.finish(executionId, status);
      await settle();
    },
    stop: async () => {
      journal?.close();
      await supervisor.stop();
    },
  };
  return runner;
}

/**
 * A reference runner in memory: it serves the contract with no pipeline
 * host, for the web core's suite (CP-20). It refuses what the supervisor
 * refuses, with the same errors.
 */
export class FakeRunnerWorker implements PipelineExecutionWorker {
  readonly runs = new Map<string, HostedRun>();

  private readonly observers = new Map<
    string,
    Set<PipelineExecutionObserver>
  >();

  constructor(
    private readonly owner: PipelineOwnerChannel,
    private readonly options: RelayRunnerOptions,
  ) {}

  get portableLaunches(): boolean {
    return this.options.portable !== false;
  }

  admitStart(
    params: WorkerPipelineExecutionStartParams,
  ): Promise<WorkerPipelineExecution | null> {
    const { portableLaunch: portable } = params;
    if (!portable) return Promise.reject(pipelineLaunchUnavailableError());
    const running = this.runs.get(params.executionId);
    if (running) return Promise.resolve(running.execution);
    if (portable.ownerBound === true && !this.owner.ownerSubscribed())
      return Promise.reject(
        pipelineOwnerUnavailableError({
          retryable: this.options.remoteOwner !== undefined,
        }),
      );
    return Promise.resolve(null);
  }

  start(
    params: WorkerPipelineExecutionStartParams,
    _signal: AbortSignal,
    secrets: RedeemedExecutionSecrets,
  ): Promise<WorkerPipelineExecution> {
    void _signal;
    const { portableLaunch: portable } = params;
    if (!portable) return Promise.reject(pipelineLaunchUnavailableError());
    const running = this.runs.get(params.executionId);
    if (running) return Promise.resolve(running.execution);
    const execution = projectionOf(params);
    this.runs.set(params.executionId, {
      launch: runnerLaunchOf({ ...params, portableLaunch: portable }, secrets),
      execution,
    });
    return Promise.resolve(execution);
  }

  control(): Promise<WorkerPipelineControlResult> {
    return Promise.reject(pipelineLaunchUnavailableError());
  }

  sweep(): Promise<WorkerPipelineRecoverySweepResult> {
    return Promise.resolve({ failureCount: 0 });
  }

  checkpoint(): Promise<WorkerPipelineRecoveryCheckpointResult> {
    return Promise.resolve({ checkpointedCount: 0 });
  }

  get(executionId: string): Promise<WorkerPipelineExecution | null> {
    return Promise.resolve(this.runs.get(executionId)?.execution ?? null);
  }

  inspect(executionId: string): Promise<WorkerPipelineExecutionView | null> {
    const run = this.runs.get(executionId);
    return Promise.resolve(run ? { execution: run.execution } : null);
  }

  list(_query: PipelineExecutionListQuery): Promise<PipelineExecutionListPage> {
    void _query;
    return Promise.resolve({
      executions: [...this.runs.values()].map(({ execution }) => ({
        execution,
      })),
      more: false,
    });
  }

  cancel(executionId: string): Promise<WorkerPipelineExecution> {
    if (!this.runs.has(executionId))
      return Promise.reject(pipelineExecutionNotFoundError());
    return Promise.resolve(this.finish(executionId, 'cancelled'));
  }

  observe(
    executionId: string,
    observer: PipelineExecutionObserver,
  ): (() => void) | null {
    const run = this.runs.get(executionId);
    if (!run || isTerminalPipelineExecution(run.execution)) return null;
    const set = this.observers.get(executionId) ?? new Set();
    set.add(observer);
    this.observers.set(executionId, set);
    return () => {
      set.delete(observer);
    };
  }

  output(executionId: string, text: string): void {
    for (const observer of [...(this.observers.get(executionId) ?? [])])
      observer.onOutput({ jobId: 'j', stepId: 's', stream: 'stdout', text });
  }

  notify(executionId: string, title: string): void {
    for (const observer of [...(this.observers.get(executionId) ?? [])])
      observer.onNotification?.({ stepId: 's', title, body: '' });
  }

  update(executionId: string, patch: Partial<WorkerPipelineExecution>): void {
    const run = this.runs.get(executionId);
    if (!run) throw new Error(`No run ${executionId}.`);
    run.execution = { ...run.execution, ...patch };
    for (const observer of [...(this.observers.get(executionId) ?? [])])
      observer.onExecution('execution.updated', run.execution);
  }

  finish(
    executionId: string,
    status: WorkerPipelineExecution['status'],
  ): WorkerPipelineExecution {
    const run = this.runs.get(executionId);
    if (!run) throw new Error(`No run ${executionId}.`);
    run.execution = settled(run.execution, status);
    for (const observer of [...(this.observers.get(executionId) ?? [])])
      observer.onExecution('execution.completed', run.execution);
    return run.execution;
  }
}

export function fakeRunner(options: RelayRunnerOptions = {}): RelayRunner {
  const owner = createPipelineOwnerChannel();
  const worker = new FakeRunnerWorker(owner, options);
  const journal = journalOf(options);
  const runner: RelayRunner = {
    name: 'fake runner',
    handlers: handlersOf(worker, owner, journal, options.secrets),
    rehandled: () => ({
      ...runner,
      handlers: handlersOf(worker, owner, journal, options.secrets),
    }),
    output: async (executionId, text) => {
      worker.output(executionId, text);
      await settle();
    },
    notify: async (executionId, title) => {
      worker.notify(executionId, title);
      await settle();
    },
    update: async (executionId, patch) => {
      worker.update(executionId, patch);
      await settle();
    },
    launched: (executionId) => worker.runs.get(executionId)?.launch,
    finish: async (executionId, status) => {
      worker.finish(executionId, status);
      await settle();
    },
    stop: () => {
      journal?.close();
      return Promise.resolve();
    },
  };
  return runner;
}

export async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

/** Every key, at any depth, of a JSON value. */
function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) keysOf(entry, into);
  else if (typeof value === 'object' && value !== null)
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      keysOf(entry, into);
    }
  return into;
}

/** How a fake core reaches its runner: a binding, and the wire it carries. */
export interface FakeCoreLink {
  readonly binding: Pick<
    InProcessWorkerBinding,
    'query' | 'instruction' | 'openStream'
  > & { close(): void };
  /** Every envelope either end sent, as JSON. */
  wire(): CanopyJsonRpcMessage[];
}

/** The runner's handlers behind a serializing JSON-RPC pair. */
function serializingLink(runner: RelayRunner): FakeCoreLink {
  const pair = serializingWorkerPair();
  const dispatcher = createCanopyDispatcher({
    profile: 'worker',
    definitions: RELAY_DEFINITIONS,
    handlers: runner.handlers,
  });
  return {
    binding: createInProcessWorkerBinding({
      dispatcher,
      definitions: RELAY_DEFINITIONS,
      caller: RELAY_CALLER,
      pair,
    }),
    wire: () =>
      [...pair.client.send.mock.calls, ...pair.server.send.mock.calls].map(
        ([message]) => message,
      ),
  };
}

/**
 * The fake web core: it reaches its runner only over a serializing JSON-RPC
 * pair, or over the runner's relay leg (CP-11), and records every frame both
 * ways, as the relay would carry them.
 */
export class FakePipelineCore {
  private readonly binding: FakeCoreLink['binding'];

  constructor(
    readonly runner: RelayRunner,
    private readonly link: FakeCoreLink = serializingLink(runner),
  ) {
    this.binding = link.binding;
  }

  /** Every frame either end sent, as JSON. */
  wire(): CanopyJsonRpcMessage[] {
    return this.link.wire();
  }

  /** The wire as one string, to look for values that must never cross. */
  wireText(): string {
    return JSON.stringify(this.wire());
  }

  /** Every member name any frame carried. */
  wireKeys(): Set<string> {
    return keysOf(this.wire());
  }

  // Every answer is parsed as the web core would parse it.
  async start(
    params: WorkerPipelineExecutionStartParams,
    idempotencyKey = params.executionId,
  ): Promise<{ execution: WorkerPipelineExecution }> {
    return WorkerPipelineExecutionResultSchema.parse(
      await this.binding.instruction(
        'worker.pipeline.execution.start',
        params,
        {
          metadata: { idempotencyKey },
        },
      ),
    );
  }

  async get(executionId: string): Promise<WorkerPipelineExecutionView> {
    return WorkerPipelineExecutionGetResultSchema.parse(
      await this.binding.query('worker.pipeline.execution.get', {
        executionId,
      }),
    );
  }

  async list(): Promise<{ executions: WorkerPipelineExecutionView[] }> {
    return WorkerPipelineExecutionListResultSchema.parse(
      await this.binding.query('worker.pipeline.execution.list', {}),
    );
  }

  async cancel(
    executionId: string,
  ): Promise<{ execution: WorkerPipelineExecution }> {
    return WorkerPipelineExecutionResultSchema.parse(
      await this.binding.instruction(
        'worker.pipeline.execution.cancel',
        { executionId },
        { metadata: { idempotencyKey: `cancel:${executionId}` } },
      ),
    );
  }

  /**
   * Follows one run's events, from just after `cursor` when given, until the
   * stream ends or `close` drops it as a relay outage would.
   */
  async events(
    executionId: string,
    cursor?: CanopyStreamCursor,
  ): Promise<RelayEventsStream> {
    const handle = await this.binding.openStream(
      'worker.pipeline.execution.events',
      { executionId, ...(cursor && { cursor }) },
    );
    const items: WorkerPipelineExecutionEventsItem[] = [];
    const cursors: CanopyStreamCursor[] = [];
    const ended = new Promise<RelayStreamEnd>((resolve) => {
      handle.onFrame((frame) => {
        if (frame.kind === 'item') {
          items.push(WorkerPipelineExecutionEventsItemSchema.parse(frame.item));
          cursors.push(frame.cursor);
        } else resolve({ outcome: frame.outcome, error: frame.error });
      });
    });
    await settle();
    return {
      acceptedCursor: handle.openResult.acceptedCursor,
      items,
      cursors,
      ended,
      close: () => handle.close(),
    };
  }

  /**
   * Holds the owner subscription and answers each host request with
   * `answer`; returns its stop, which ends the subscription as a relay
   * outage would.
   */
  async own(
    answer: (
      item: Exclude<WorkerPipelineHostRequestsItem, { withdrawn: true }>,
    ) => WorkerPipelineHostResult,
  ): Promise<() => void> {
    const handle = await this.binding.openStream(
      'worker.pipeline.hostRequests',
      {},
    );
    handle.onFrame((frame) => {
      if (frame.kind !== 'item') return;
      const request = WorkerPipelineHostRequestsItemSchema.parse(frame.item);
      if (isWorkerPipelineHostWithdrawal(request)) return;
      void this.binding.instruction('worker.pipeline.hostRequest.respond', {
        executionId: request.executionId,
        requestId: request.requestId,
        result: answer(request),
      });
    });
    await settle();
    return () => handle.close();
  }

  close(): void {
    this.binding.close();
  }
}

/** The far end of a runner served over text frames, as a relay carries them. */
export interface RelayTextEnd {
  /** Sends one text frame to the runner. */
  send(text: string): void;
  /** Receives every text frame the runner sends, and the end of the link. */
  listen(listener: { message(text: string): void; close(): void }): void;
  /** Ends the link as a lost connection would; the runner keeps running. */
  close(): void;
  /** Every frame either end sent, as text. */
  readonly frames: readonly string[];
}

/**
 * Serves a runner's worker.pipeline binding over one text-frame link, for a
 * primary outside this package (the web core's relay client, CP-20). Each
 * frame is one JSON-RPC envelope, validated on the way in as the relay's
 * runner end would.
 */
export function serveRunnerOverText(runner: RelayRunner): RelayTextEnd {
  const controller = new AbortController();
  const frames: string[] = [];
  const inbound: CanopyJsonRpcMessage[] = [];
  let waiting:
    | {
        resolve(message: CanopyJsonRpcMessage): void;
        reject(error: Error): void;
      }
    | undefined;
  let listener: { message(text: string): void; close(): void } | undefined;
  const pending: string[] = [];
  const stop = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    waiting?.reject(canopyUnavailableError());
    waiting = undefined;
    queueMicrotask(() => listener?.close());
  };
  const connection: WorkerBindingConnection = {
    signal: controller.signal,
    send: (message) =>
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw canopyUnavailableError();
        const text = JSON.stringify(message);
        frames.push(text);
        if (listener) listener.message(text);
        else pending.push(text);
      }),
    receive: () => {
      if (controller.signal.aborted)
        return Promise.reject(canopyUnavailableError());
      const next = inbound.shift();
      if (next) return Promise.resolve(next);
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    close: stop,
  };
  serveLocalWorkerBinding({
    dispatcher: createCanopyDispatcher({
      profile: 'worker',
      definitions: RELAY_DEFINITIONS,
      handlers: runner.handlers,
    }),
    definitions: RELAY_DEFINITIONS,
    caller: RELAY_CALLER,
    connection,
  });
  return {
    frames,
    send: (text) => {
      if (controller.signal.aborted) return;
      frames.push(text);
      const message = CanopyJsonRpcMessageSchema.parse(JSON.parse(text));
      queueMicrotask(() => {
        const receiver = waiting;
        waiting = undefined;
        if (receiver) receiver.resolve(message);
        else inbound.push(message);
      });
    },
    listen: (next) => {
      listener = next;
      for (const text of pending.splice(0)) next.message(text);
      if (controller.signal.aborted) queueMicrotask(() => next.close());
    },
    close: stop,
  };
}

/** The incarnation's session key both ends of a kit relay leg hold. */
export const RELAY_SESSION_KEY = Buffer.alloc(32, 0x5a);

/** A runner's relay leg (CP-11), as the relay reaches it with session frames. */
export interface RelayLegEnd {
  /** One session frame from the core, through the relay. */
  receive(text: string): void;
  /** Receives every session frame the leg sends, and the leg's end. */
  listen(listener: { message(text: string): void; close(): void }): void;
  /** The relay drops the runner's connection; the runner keeps running. */
  close(): void;
  /** Every envelope the leg opened or sealed, in plaintext. */
  readonly envelopes: readonly string[];
  /** Every lease notice the core sent the leg (CP-11). */
  readonly leases: readonly { leaseEpoch: number; expiresAt: number }[];
}

/**
 * Serves a runner over the cloud runner's relay leg: the end-to-end session
 * in its runner role and the worker binding behind it, refusing
 * `_execution`, exactly as the runner entry serves one relay attachment.
 */
export function serveRunnerOverRelayLeg(
  runner: RelayRunner,
  sessionKey: Uint8Array = RELAY_SESSION_KEY,
): RelayLegEnd {
  const envelopes: string[] = [];
  const leases: { leaseEpoch: number; expiresAt: number }[] = [];
  const pending: string[] = [];
  let listener: { message(text: string): void; close(): void } | undefined;
  let closed = false;
  const ended = (): void => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => listener?.close());
  };
  const leg = servePipelineRelayLeg({
    dispatcher: createCanopyDispatcher({
      profile: 'worker',
      definitions: RELAY_DEFINITIONS,
      handlers: runner.handlers,
    }),
    definitions: RELAY_DEFINITIONS,
    caller: RELAY_CALLER,
    sessionKey,
    send: (text) => {
      if (closed) return false;
      const to = listener;
      if (to) queueMicrotask(() => to.message(text));
      else pending.push(text);
      return true;
    },
    onEnded: ended,
    onLease: (lease): void => {
      leases.push(lease);
    },
    trace: (_direction, envelope) => envelopes.push(envelope),
  });
  return {
    envelopes,
    leases,
    receive: (text) => {
      if (!closed) queueMicrotask(() => leg.receive(text));
    },
    listen: (next) => {
      listener = next;
      for (const text of pending.splice(0)) next.message(text);
      if (closed) queueMicrotask(() => next.close());
    },
    close: () => {
      leg.close();
      ended();
    },
  };
}

/** A fake core's link through a runner's relay leg, with the core's session. */
export interface RelayLegLink extends FakeCoreLink {
  /** Every session frame the relay carried, as text. */
  readonly frames: readonly string[];
}

/**
 * The core's end of one relay attachment: its session in the core role,
 * and the worker binding client over it, in front of the runner's leg.
 * Closing the binding drops the attachment, as a relay outage does.
 */
export function relayLegLink(
  runner: RelayRunner,
  sessionKey: Uint8Array = RELAY_SESSION_KEY,
): RelayLegLink {
  const end = serveRunnerOverRelayLeg(runner, sessionKey);
  const frames: string[] = [];
  const controller = new AbortController();
  const inbound: CanopyJsonRpcMessage[] = [];
  let waiting:
    | {
        resolve(message: CanopyJsonRpcMessage): void;
        reject(error: Error): void;
      }
    | undefined;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const stop = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    session.close();
    end.close();
    waiting?.reject(canopyUnavailableError());
    waiting = undefined;
    resolveReady();
  };
  const session = createPipelineRelaySession({
    role: 'core',
    sessionKey,
    send: (text) => {
      if (controller.signal.aborted) return false;
      frames.push(text);
      end.receive(text);
      return true;
    },
    onReady: () => resolveReady(),
    onMessage: (plaintext) => {
      const message = CanopyJsonRpcMessageSchema.parse(JSON.parse(plaintext));
      const receiver = waiting;
      waiting = undefined;
      if (receiver) receiver.resolve(message);
      else inbound.push(message);
    },
    onFailed: stop,
  });
  end.listen({
    message: (text) => {
      frames.push(text);
      session.receive(text);
    },
    close: stop,
  });
  session.start();
  const connection: WorkerBindingConnection = {
    signal: controller.signal,
    send: async (message) => {
      await ready;
      if (controller.signal.aborted || !session.send(JSON.stringify(message)))
        throw canopyUnavailableError();
    },
    receive: () => {
      if (controller.signal.aborted)
        return Promise.reject(canopyUnavailableError());
      const next = inbound.shift();
      if (next) return Promise.resolve(next);
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    close: stop,
  };
  const client = connectLocalWorkerBinding({
    definitions: RELAY_DEFINITIONS,
    caller: RELAY_CALLER,
    connection,
  });
  return {
    frames,
    binding: {
      query: (...args) => client.query(...args),
      instruction: (...args) => client.instruction(...args),
      openStream: (...args) => client.openStream(...args),
      close: () => client.close(),
    },
    wire: () =>
      end.envelopes.map((envelope) =>
        CanopyJsonRpcMessageSchema.parse(JSON.parse(envelope)),
      ),
  };
}
