import {
  isWorkerPipelineLocalOwnerAction,
  isWorkerPipelineOwnerAction,
  WORKER_PIPELINE_LIST_LIMIT_MAX,
  WorkerPipelineControlResultSchema,
  WorkerPipelineExecutionSchema,
  WorkerPipelineExecutionViewSchema,
  WorkerPipelineRecoveryCheckpointResultSchema,
  WorkerPipelineRecoverySweepResultSchema,
  type CanopyHostExecution,
  type WorkerPipelineCancelMode,
  type WorkerPipelineControlResult,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineExecutionView,
  type WorkerPipelineHostLaunch,
  type WorkerPipelineHostRequest,
  type WorkerPipelineOwnerResult,
  type WorkerPipelineOwnerValues,
  type WorkerPipelinePortableLaunch,
  type WorkerPipelineRecoveryCheckpointResult,
  type WorkerPipelineRecoverySweepParams,
  type WorkerPipelineRecoverySweepResult,
} from '@canopy/protocol/canopy-core';

import type { RedeemedExecutionSecrets } from '../../execution-secrets';
import {
  PipelineHostUnavailableError,
  ownerSettlement,
  type PipelineOwnerSettlement,
} from '../execution/host-requests';
import type { PipelineOwnerChannel } from '../execution/owner-channel';
import {
  PipelineDrainTimeoutError,
  isTerminalPipelineExecution,
  pipelineCheckpointFailedError,
  pipelineControlFailedError,
  pipelineExecutionNotFoundError,
  pipelineHostLostError,
  pipelineHostUnavailableError,
  pipelineLaunchRefusedError,
  pipelineLaunchUnavailableError,
  pipelineModelStepsUnsupportedError,
  pipelineOwnerUnavailableError,
  pipelinePortableLaunchRefusedError,
  pipelineStartFailedError,
  type PipelineControlRequest,
  type PipelineExecutionListPage,
  type PipelineExecutionListQuery,
  type PipelineExecutionNotification,
  type PipelineExecutionObserver,
  type PipelineExecutionWorker,
} from '../execution/worker-pipelines';
import {
  isPipelineHostMessage,
  type PipelineHostControl,
  type PipelineHostErrorCode,
  type PipelineHostLaunch,
  type PipelineHostMessage,
  type PipelineHostRequest,
  type PipelineHostLauncherCommand,
  type PipelineHostMemoryBudget,
  type PipelineHostRequestMessage,
  type PipelineOwnerLease,
  type PipelineOwnerLeaseAnswer,
  type PipelineOwnerLeaseObservation,
  type PipelineHostSettlement,
} from './protocol';

/** A launched pipeline host, as the execution host port reports it. */
export interface PipelineHostProcess {
  postMessage(message: PipelineHostRequestMessage): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

/**
 * An owner that reaches the supervisor over a network, such as the web core
 * over the relay (CAN-6102), rather than the local app.
 */
export interface PipelineRemoteOwner {
  /**
   * The owner's delegation lease TTL. Owner-bound runs keep running this
   * long after the owner's subscription ends, and host requests wait this
   * long for it to return. Omitted, the supervisor takes the first portable
   * start's `delegationLease.leaseTtlMs` (CP-11): a runner incarnation
   * serves one delegation, so a start that names another TTL is refused
   * `worker.pipeline.launchRefused`, as is one that differs from this.
   */
  readonly leaseTtlMs?: number;
  /**
   * The delegation lease this incarnation holds (CAN-6198): the epoch from
   * its runner credential and when the lease lapses unrenewed. With it the
   * host fences its writes with the epoch instead of its PID, and stops its
   * runs once the lease lapses or a newer epoch is reported
   * ({@link PipelineHostSupervisor.observeOwnerLease}).
   */
  readonly lease?: PipelineOwnerLease;
  /**
   * Resolves what a remote owner's answer names by `routeId` (P9, CAN-6161),
   * such as an LLM proxy route or hosted Feed tools, to the host-local values
   * the step runs with, using credentials the runner holds from bootstrap.
   * A remote owner never sends values itself; without a resolver, or for an
   * answer it cannot resolve, the step runs with none.
   */
  readonly resolveOwnerValues?: (
    request: WorkerPipelineHostRequest,
    answer: WorkerPipelineOwnerResult,
  ) => Promise<Omit<WorkerPipelineOwnerValues, 'requestId'> | undefined>;
  /**
   * Answers the local-only owner requests (`owner.claude.modAdmission`,
   * `owner.mcp.*`), which a remote owner never receives. Default: Claude Mod
   * admission is off for the run, and no MCP credential is bound or presented.
   */
  readonly answerLocally?: (
    request: WorkerPipelineHostRequest,
  ) => Promise<WorkerPipelineOwnerResult>;
}

/** Claude Mod admission off: what a runner answers without its own policy. */
const MOD_ADMISSION_OFF: WorkerPipelineOwnerResult = {
  kind: 'claude.modAdmission',
  context: null,
};

/**
 * What a runner with a remote owner answers a local-only request with when it
 * has no answer of its own: nothing admitted, bound or presented (CAN-6168).
 */
function localRefusal(
  request: WorkerPipelineHostRequest,
): WorkerPipelineOwnerResult {
  switch (request.request.action) {
    case 'owner.mcp.bind':
      return { kind: 'mcp.bind', routeRef: null };
    case 'owner.mcp.authorize':
      return { kind: 'mcp.authorize', grantId: null };
    case 'owner.mcp.rejected':
      return { kind: 'mcp.rejected' };
    // No policy of its own to apply, so nothing loads: the step fails
    // rather than run without its plugins.
    case 'owner.codex.pluginRefs':
      return { kind: 'codex.pluginRefs', selections: null, warnings: [] };
    default:
      return MOD_ADMISSION_OFF;
  }
}

/**
 * An owner request as a remote owner receives it (CAN-6161): the Ledger tool
 * requests without the step's host folder.
 */
function remoteOwnerRequestOf(
  request: WorkerPipelineHostRequest,
): WorkerPipelineHostRequest {
  const action = request.request;
  if (action.action === 'owner.ledger.subprocessTools')
    return {
      ...request,
      request: { action: action.action, attemptKey: action.attemptKey },
    };
  if (action.action === 'owner.ledger.codexTools')
    return {
      ...request,
      request: { action: action.action, attemptKey: action.attemptKey },
    };
  return request;
}

export interface PipelineHostSupervisorOptions {
  /** Starts a new pipeline host process. Throws when it cannot. */
  readonly launch: () => PipelineHostProcess;
  /** Sent as each new host's first request. */
  readonly configure: {
    readonly dataRoot: string;
    /** The daemon's own command, for the host's Codex runtime (CAN-5095 D18). */
    readonly codexMcpLauncher?: PipelineHostLauncherCommand;
    /** A cloud runner's sandbox memory (CAN-6325); the daemon sets none. */
    readonly memory?: PipelineHostMemoryBudget;
  };
  /**
   * Verifies a start's host-local launch and resolves it for the host.
   * Throws {@link pipelineLaunchRefusedError}.
   */
  readonly resolveLaunch: (
    params: WorkerPipelineExecutionStartParams,
    execution: CanopyHostExecution & {
      pipelineLaunch: WorkerPipelineHostLaunch;
    },
  ) => Promise<PipelineHostLaunch>;
  /**
   * Maps a portable start (CAN-6161) to this host's own paths, as a cloud
   * runner does, with the secrets its bindings redeemed as the launch's
   * `secretEnv`. Without it the supervisor runs only host-local launches.
   * Throws {@link pipelineLaunchRefusedError}.
   */
  readonly resolvePortableLaunch?: (
    params: WorkerPipelineExecutionStartParams & {
      portableLaunch: WorkerPipelinePortableLaunch;
    },
    secrets: RedeemedExecutionSecrets,
  ) => Promise<PipelineHostLaunch>;
  /** Holds the daemon up while `executionId` runs; returns its release. */
  readonly holdExecution?: (executionId: string) => () => void;
  /** Ends a step's process group that outlived its host. */
  readonly killProcessGroup?: (processGroupId: number) => void;
  /** Default 30_000. */
  readonly requestTimeoutMs?: number;
  /** Default 60_000. */
  readonly checkpointTimeoutMs?: number;
  /** Default 5_000. */
  readonly idleStopMs?: number;
  /** Observes each host that ended unexpectedly, with how many executions it ran. */
  readonly onHostLost?: (report: {
    readonly code: number;
    readonly lost: number;
  }) => void;
  /** The daemon's owner channel (CAN-5771). Without it, host requests answer unavailable and owner-bound starts are refused. */
  readonly owner?: Pick<
    PipelineOwnerChannel,
    'broker' | 'ownerSubscribed' | 'onOwnerChange'
  >;
  /** How long a host request waits for an owner subscriber. Default 10_000. */
  readonly ownerWaitMs?: number;
  /** How long the owner may be gone before owner-bound runs pause. Default 10_000. */
  readonly ownerAbsentPauseMs?: number;
  /**
   * A remote owner (CAN-6102). Its lease TTL replaces `ownerWaitMs` and
   * `ownerAbsentPauseMs`, an owner-loss pause records `owner_lost` instead of
   * `app_shutdown`, and an owner request still unanswered near its deadline
   * pauses its run instead of failing its step. An owner-bound start it
   * refuses `ownerUnavailable` may be retried with its idempotency key
   * (CAN-6161). Without it the owner is the local app and both timers stay
   * 10 s.
   */
  readonly remoteOwner?: PipelineRemoteOwner;
}

const REQUEST_TIMEOUT_MS = 30_000;
const CHECKPOINT_TIMEOUT_MS = 60_000;
const IDLE_STOP_MS = 5_000;
const EXIT_GRACE_MS = 5_000;
// A drain waits up to 10 s for the run to stop inside the host.
const CANCEL_EXTRA_MS = 10_000;
const OWNER_WAIT_MS = 10_000;
/**
 * The most portable starts a supervisor keeps for recovery controls
 * (CAN-6103), the oldest dropped first; a runner serves one delegation.
 */
const RECOVERABLE_RUNS_MAX = 1_024;
/** Notifications kept for a run no stream follows yet (CAN-5868). */
const UNDELIVERED_NOTIFICATIONS_MAX = 32;
/** How long they are kept once the run pauses or ends. */
const UNDELIVERED_NOTIFICATIONS_TTL_MS = 60_000;
const OWNER_ABSENT_PAUSE_MS = 10_000;
/**
 * How long before an owner request's deadline a remote owner's silence
 * pauses the run: the host fails the step at the deadline itself.
 */
const HUNG_OWNER_PAUSE_LEAD_MS = 5_000;
/** The longest delay a timer takes. */
const TIMER_MAX_MS = 2_147_483_647;
function leaseTtlInRange(ttl: number): boolean {
  return Number.isSafeInteger(ttl) && ttl > 0 && ttl <= TIMER_MAX_MS;
}

/** Host starts a renewal that arrives mid-start may cost (CAN-6198). */
const LEASE_RECONFIGURE_ATTEMPTS = 2;

/** Why a host request failed; the host's own message is never kept. */
class HostRequestFailure extends Error {
  public constructor(
    public readonly reason: 'refused' | 'timeout' | 'exited' | 'unavailable',
    public readonly code?: PipelineHostErrorCode,
  ) {
    super('The pipeline host request failed.');
    this.name = 'HostRequestFailure';
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface LiveHost {
  readonly process: PipelineHostProcess;
  /** The owner-request deadline floor this host was given (CP-11). */
  ownerRequestDeadlineMs: number | undefined;
  readonly pending: Map<number, Pending>;
  /** Executions this host runs that have not paused or ended. */
  readonly executions: Set<string>;
  /** Each step process the host reported, by registration id. */
  readonly processGroups: Map<string, number>;
  readonly observers: Map<string, Set<PipelineExecutionObserver>>;
  /** Executions whose start request this host has not answered yet. */
  readonly pendingStarts: Set<string>;
  /** Executions that paused or ended while their start was still pending. */
  readonly settledEarly: Set<string>;
  readonly exitWaiters: Array<() => void>;
  /** Host requests this host raised that wait on the owner, by request id (CAN-5771). */
  readonly hostCalls: Map<
    string,
    { readonly executionId: string; readonly abort: AbortController }
  >;
  expectedExit: boolean;
  exited: boolean;
  /** Its lease fence closed: it takes no run again (CAN-6198). */
  fenced?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** A portable start as a recovery control runs it again, without its one-shot secret bindings. */
type RecoverableStart = Omit<WorkerPipelineExecutionStartParams, 'secrets'> & {
  readonly portableLaunch: WorkerPipelinePortableLaunch;
};

/** A start's launch, checked and ready to resolve for the host. */
interface PreparedStart {
  readonly ownerBound: boolean;
  /** A portable start, kept so a recovery control can run it again (CAN-6103). */
  readonly recoverable?: RecoverableStart;
  /** With the secrets the start's bindings redeemed, which only a portable start reads. */
  readonly resolve: (
    secrets: RedeemedExecutionSecrets,
  ) => Promise<PipelineHostLaunch>;
}

function isSettled(execution: WorkerPipelineExecution): boolean {
  return (
    execution.status === 'paused' || isTerminalPipelineExecution(execution)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * The host's side of a resume or retry (CAN-6103), without its secret
 * bindings; a `from_start` retry gets its new execution id here when the
 * caller named none. `null` for the matrix controls, which no host serves.
 */
function hostControlOf(
  request: PipelineControlRequest,
): PipelineHostControl | null {
  if (request.operation === 'worker.pipeline.execution.resume') {
    const { secrets: _bindings, ...params } = request.params;
    void _bindings;
    return { operation: request.operation, params };
  }
  if (request.operation === 'worker.pipeline.execution.retry') {
    const { secrets: _bindings, ...params } = request.params;
    void _bindings;
    return {
      operation: request.operation,
      params:
        params.mode === 'from_start' && params.newExecutionId === undefined
          ? { ...params, newExecutionId: crypto.randomUUID() }
          : params,
    };
  }
  return null;
}

/** Whether the control redeemed secret bindings, so a retry would find its grant spent. */
function hasSecretBindings(request: PipelineControlRequest): boolean {
  return (
    request.operation !== 'worker.pipeline.matrixVariant.cancel' &&
    request.params.secrets !== undefined
  );
}

/** The execution a control runs: a start over runs a new one. */
function controlTargetOf(control: PipelineHostControl): string {
  return control.operation === 'worker.pipeline.execution.retry' &&
    control.params.mode === 'from_start' &&
    control.params.newExecutionId !== undefined
    ? control.params.newExecutionId
    : control.params.executionId;
}

/** A list page as the host answers it (CAN-6117); `null` for anything else. */
function parseHostListPage(value: unknown): PipelineExecutionListPage | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('executions' in value) ||
    !('more' in value) ||
    !Array.isArray(value.executions) ||
    value.executions.length > WORKER_PIPELINE_LIST_LIMIT_MAX ||
    typeof value.more !== 'boolean'
  )
    return null;
  const executions: WorkerPipelineExecutionView[] = [];
  for (const item of value.executions) {
    const parsed = WorkerPipelineExecutionViewSchema.safeParse(item);
    if (!parsed.success) return null;
    executions.push(parsed.data);
  }
  return { executions, more: value.more };
}

/**
 * Runs host-local pipeline launches in a supervised pipeline host
 * (CAN-5086): starts the host on first use, routes requests and execution
 * events, and starts a new host on the next request after one ends. A host
 * that ends unexpectedly takes its executions with it: their step process
 * groups are killed and their event streams end with
 * `worker.pipeline.hostLost`.
 *
 * A supervisor that maps portable starts serves resume and retry for the
 * runs it started (CAN-6103), as a cloud runner has no other executor;
 * host-local launches are still resumed by the app that sent them (D10).
 *
 * Owner-bound runs keep running while their owner is away, whether or not
 * the current step needs it, until the owner-absence timer pauses them all.
 * With a remote owner that timer is the delegation lease: once it lapses
 * the owner may hand the run to another runner, so nothing keeps running
 * past it (CAN-6102).
 */
export class PipelineHostSupervisor implements PipelineExecutionWorker {
  private host: LiveHost | null = null;

  private starting: Promise<LiveHost> | null = null;

  private stopped = false;

  private nextId = 1;

  private readonly releases = new Map<string, () => void>();

  /** Notifications no observer received, until a stream takes them (CAN-5868). */
  private readonly undelivered = new Map<
    string,
    {
      readonly items: PipelineExecutionNotification[];
      expiry?: ReturnType<typeof setTimeout>;
    }
  >();

  private readonly starts = new Map<string, Promise<WorkerPipelineExecution>>();

  /** Each portable start, by execution id, for recovery controls (CAN-6103). */
  private readonly recoverable = new Map<string, RecoverableStart>();

  /** Executions a recovery control is resuming or retrying (CAN-6103). */
  private readonly controlling = new Set<string>();

  /** Executions started with `ownerBound` that have not paused or ended (CAN-5771). */
  private readonly ownerBound = new Set<string>();

  private ownerAbsentTimer: ReturnType<typeof setTimeout> | undefined;

  /** The owner has been gone past the pause deadline and has not returned. */
  private ownerGone = false;

  private readonly offOwnerChange: (() => void) | undefined;

  /** The lease as last observed (CAN-6198); each new host is configured with it. */
  private ownerLease: PipelineOwnerLease | undefined;

  /**
   * The remote owner's lease TTL: configured, or the first portable
   * start's (CP-11). Undefined until then.
   */
  private leaseTtlMs: number | undefined;

  /**
   * When the delegation lease lapses unless renewed again, as the owner last
   * reported a renewal of this incarnation's epoch (CP-11). The owner timers
   * run to it; the fence keeps its own, later, end. Undefined until a
   * renewal is reported.
   */
  private renewedLeaseExpiresAt: number | undefined;

  /** Owner waits under way, re-armed when the lease is renewed (CP-11). */
  private readonly ownerWaits = new Set<() => void>();

  /**
   * A newer lease epoch exists, or the published host's fence closed: this
   * incarnation starts no host again (CAN-6198).
   */
  private leaseClosed = false;

  /**
   * Whether this incarnation's lease is gone for good (CAN-6198): a newer
   * epoch exists, or it lapsed unrenewed. A renewal that comes after the
   * expiry does not reopen it.
   */
  private leaseEnded(): boolean {
    return (
      this.leaseClosed ||
      (this.ownerLease !== undefined && Date.now() >= this.ownerLease.expiresAt)
    );
  }

  public constructor(private readonly options: PipelineHostSupervisorOptions) {
    this.ownerLease = options.remoteOwner?.lease;
    const ttl = options.remoteOwner?.leaseTtlMs;
    if (ttl !== undefined && !leaseTtlInRange(ttl))
      throw new RangeError('The owner lease TTL is out of range.');
    this.leaseTtlMs = ttl;
    this.offOwnerChange = options.owner?.onOwnerChange((subscribed) =>
      this.ownerChanged(subscribed),
    );
  }

  /** Whether this supervisor maps portable starts to its own paths (CAN-6161). */
  public get portableLaunches(): boolean {
    return this.options.resolvePortableLaunch !== undefined;
  }

  /**
   * The executions the running host runs that have not paused or ended,
   * with the starts it has not answered yet: a stop checkpoints those too.
   */
  public runningExecutionIds(): readonly string[] {
    const host = this.host;
    return host && !host.exited
      ? [...new Set([...host.executions, ...host.pendingStarts])]
      : [];
  }

  /**
   * A renewal of this incarnation's lease (CP-11): the owner-absence pause
   * and an owner wait run to its expiry instead of a TTL from when the
   * owner left, so an outage early in the lease lasts the lease.
   */
  private noteRenewal(expiresAt: number): void {
    if (
      this.renewedLeaseExpiresAt !== undefined &&
      expiresAt <= this.renewedLeaseExpiresAt
    )
      return;
    this.renewedLeaseExpiresAt = expiresAt;
    // Requests already waiting for the owner wait to the new expiry too.
    for (const rearm of this.ownerWaits) rearm();
    // An owner already away keeps its runs going to the new expiry.
    if (this.ownerAbsentTimer !== undefined) {
      clearTimeout(this.ownerAbsentTimer);
      this.ownerAbsentTimer = undefined;
      this.armOwnerAbsence();
    }
  }

  /**
   * Applies what the runner's binding learned about its delegation lease
   * over the relay (CAN-6198): a renewal, a newer epoch the web core
   * reported, or the relay closing its leg as `superseded`. The host's
   * fence stops its runs once the lease is gone. Ignored without a lease.
   */
  public observeOwnerLease(observation: PipelineOwnerLeaseObservation): void {
    const lease = this.ownerLease;
    if (!lease || this.leaseEnded()) return;
    if (observation.kind === 'superseded') {
      if (
        observation.leaseEpoch === undefined ||
        observation.leaseEpoch > lease.leaseEpoch
      )
        this.closeLease();
      return;
    }
    if (observation.lease.leaseEpoch > lease.leaseEpoch)
      return this.closeLease();
    if (observation.lease.leaseEpoch !== lease.leaseEpoch) return;
    this.noteRenewal(observation.lease.expiresAt);
    if (observation.lease.expiresAt <= lease.expiresAt) return;
    this.ownerLease = observation.lease;
    // A renewal that does not reach the host only makes it stop sooner.
    const host = this.host;
    if (host && !host.exited) void this.forwardLease(host, observation);
  }

  /**
   * Ends this incarnation's lease for good (CAN-6198) and stops the
   * published host: its process is killed, so nothing it runs writes or
   * reports again, whatever became of a message to it. Its runs end as for
   * a lost host, and no host starts again.
   */
  private closeLease(): void {
    this.leaseClosed = true;
    const host = this.host;
    if (host && !host.exited) this.terminateFenced(host);
  }

  /**
   * Sends a lease observation to `host` and answers its fence's state, or
   * null when it did not answer. A published host whose fence closed ends
   * the lease here too, even when the supervisor's own view still holds it,
   * as when a renewal reaches the host just after its expiry.
   */
  private async forwardLease(
    host: LiveHost,
    observation: PipelineOwnerLeaseObservation,
  ): Promise<PipelineOwnerLeaseAnswer['state'] | null> {
    let answer: unknown;
    try {
      answer = await this.send(
        host,
        { op: 'lease', observation },
        this.requestTimeoutMs,
      );
    } catch {
      return null;
    }
    const reported =
      typeof answer === 'object' && answer !== null && 'state' in answer
        ? answer.state
        : null;
    const state =
      reported === 'held' || reported === 'lapsed' || reported === 'superseded'
        ? reported
        : null;
    if (state !== null && state !== 'held' && this.host === host)
      this.closeLease();
    return state;
  }

  /** Starts the host if none runs. Throws {@link pipelineHostUnavailableError}. */
  public async ready(): Promise<void> {
    await this.liveHost();
  }

  public async start(
    params: WorkerPipelineExecutionStartParams,
    signal: AbortSignal,
    secrets: RedeemedExecutionSecrets,
    execution?: CanopyHostExecution,
  ): Promise<WorkerPipelineExecution> {
    const prepared = this.prepareStart(params, execution);
    const { executionId } = params;
    const joined = this.starts.get(executionId);
    if (joined) return joined;
    if (this.host?.executions.has(executionId)) {
      // A resent keyed start joins the run its host is running.
      const current = await this.get(executionId);
      if (current) return current;
    }
    const run = this.runStart(params, signal, prepared, secrets);
    this.starts.set(executionId, run);
    try {
      return await run;
    } finally {
      if (this.starts.get(executionId) === run) this.starts.delete(executionId);
    }
  }

  /**
   * The launch a start runs: its host-local launch, or its portable one on
   * a supervisor that maps them (CAN-6161), never both.
   */
  private prepareStart(
    params: WorkerPipelineExecutionStartParams,
    execution: CanopyHostExecution | undefined,
  ): PreparedStart {
    // A control of this execution is under way (CAN-6103).
    if (this.controlling.has(params.executionId))
      throw pipelineStartFailedError(
        new Error('A control of this workflow run is under way.'),
      );
    const { portableLaunch } = params;
    const pipelineLaunch = execution?.pipelineLaunch;
    if (portableLaunch !== undefined) {
      const resolve = this.options.resolvePortableLaunch;
      if (!resolve || pipelineLaunch !== undefined)
        throw pipelinePortableLaunchRefusedError();
      this.admitLeaseTtl(portableLaunch.delegationLease.leaseTtlMs);
      const { secrets: _bindings, ...recoverable } = params;
      void _bindings;
      return {
        ownerBound: portableLaunch.ownerBound === true,
        recoverable: { ...recoverable, portableLaunch },
        resolve: (secrets) => resolve({ ...params, portableLaunch }, secrets),
      };
    }
    if (!execution || !pipelineLaunch) throw pipelineLaunchUnavailableError();
    return {
      ownerBound: pipelineLaunch.ownerBound === true,
      resolve: () =>
        this.options.resolveLaunch(params, { ...execution, pipelineLaunch }),
    };
  }

  /**
   * One runner incarnation serves one delegation (CP-11): its remote-owner
   * timers follow the first portable start's lease TTL, and a start that
   * names another is refused.
   */
  private admitLeaseTtl(ttl: number): void {
    if (!this.options.remoteOwner) return;
    if (this.leaseTtlMs === undefined) {
      if (!leaseTtlInRange(ttl)) throw pipelineLaunchRefusedError();
      this.leaseTtlMs = ttl;
      return;
    }
    if (ttl !== this.leaseTtlMs) throw pipelineLaunchRefusedError();
  }

  /**
   * Admits a start before its secrets are redeemed: refuses a launch it
   * cannot run, or an owner-bound one with no owner subscribed, which a
   * remote owner may retry with the same key (CAN-6161). Resolves the run a
   * resend of a start already under way joins.
   */
  public async admitStart(
    params: WorkerPipelineExecutionStartParams,
    execution?: CanopyHostExecution,
  ): Promise<WorkerPipelineExecution | null> {
    const prepared = this.prepareStart(params, execution);
    const { executionId } = params;
    const joined = this.starts.get(executionId);
    if (joined) return joined;
    if (this.host?.executions.has(executionId)) {
      const current = await this.get(executionId);
      if (current) return current;
    }
    if (prepared.ownerBound && this.options.owner?.ownerSubscribed() !== true)
      throw pipelineOwnerUnavailableError({
        retryable: this.options.remoteOwner !== undefined,
      });
    return null;
  }

  /**
   * Takes a portable start sent again for a run the store already holds
   * (CAN-6376): on a new runner incarnation, its owner restored the run
   * from its handoff, and this start is the launch its resume and retry run
   * with from now on. Nothing starts and no secret is redeemed; the run
   * answers as `stored` holds it. A start that names another workflow, run
   * owner, scope or workspace than the stored run is refused, and so is one
   * this supervisor would refuse to start.
   */
  public adoptStart(
    params: WorkerPipelineExecutionStartParams,
    stored: WorkerPipelineExecution,
  ): Promise<WorkerPipelineExecution> {
    // Checked first, so a start refused here leaves no lease TTL behind.
    if (
      stored.executionId !== params.executionId ||
      stored.pipelineId !== params.pipelineId ||
      stored.owner !== params.owner ||
      stored.runScope !== params.runScope ||
      stored.workspaceId !== params.workspaceId ||
      stored.worktreeId !== params.worktreeId
    )
      throw pipelineStartFailedError(
        new Error('The stored workflow run does not match this start.'),
      );
    const { recoverable } = this.prepareStart(params, undefined);
    if (!recoverable) return Promise.resolve(stored);
    // A start this incarnation already ran keeps its own launch.
    if (!this.recoverable.has(params.executionId))
      this.keepRecoverable(recoverable);
    return Promise.resolve(stored);
  }

  /**
   * Whether this incarnation still holds its delegation lease (CAN-6198):
   * true without one. A runner restores no run once it is over.
   */
  public leaseHeld(): boolean {
    return !this.leaseEnded();
  }

  private async runStart(
    params: WorkerPipelineExecutionStartParams,
    signal: AbortSignal,
    prepared: PreparedStart,
    secrets: RedeemedExecutionSecrets,
  ): Promise<WorkerPipelineExecution> {
    // The owner left since admission. A retry would find the secret grant
    // already redeemed, so only a start without bindings may retry.
    if (prepared.ownerBound && this.options.owner?.ownerSubscribed() !== true)
      throw pipelineOwnerUnavailableError({
        retryable:
          this.options.remoteOwner !== undefined &&
          params.secrets === undefined,
      });
    const start = await prepared.resolve(secrets);
    const host = await this.liveHost();
    await this.sendOwnerRequestFloor(host);
    if (signal.aborted)
      throw pipelineStartFailedError(
        new Error('The workflow start was cancelled.'),
      );
    // From here on the signal is ignored: a dropped connection never
    // cancels a started run.
    const { executionId } = params;
    // Another client may follow the run before its start answers.
    host.pendingStarts.add(executionId);
    let projection: WorkerPipelineExecution;
    let settledEarly: boolean;
    try {
      projection = await this.sendStart(host, start);
    } catch (error) {
      this.endObservers(host, executionId);
      throw error;
    } finally {
      host.pendingStarts.delete(executionId);
      settledEarly = host.settledEarly.delete(executionId);
    }
    // A start the host answered just before its fence closed: the run
    // stopped without an outcome, so it is not followed (CAN-6198).
    if (host.fenced) throw pipelineHostLostError();
    if (prepared.recoverable) this.keepRecoverable(prepared.recoverable);
    // A run can settle in the same tick its start answers.
    if (!host.exited && !settledEarly && !isSettled(projection))
      this.admitRunning(host, executionId, prepared.ownerBound);
    return projection;
  }

  /** A run the host runs now: held, and paused with the owner-bound ones. */
  private admitRunning(
    host: LiveHost,
    executionId: string,
    ownerBound: boolean,
  ): void {
    if (host.executions.has(executionId)) return;
    host.executions.add(executionId);
    if (ownerBound) {
      this.ownerBound.add(executionId);
      // The owner went past the deadline while this start was pending.
      if (this.ownerGone) void this.pauseOwnerBound();
    }
    const release = this.options.holdExecution?.(executionId);
    if (release) this.releases.set(executionId, release);
  }

  private keepRecoverable(start: RecoverableStart): void {
    this.recoverable.delete(start.executionId);
    this.recoverable.set(start.executionId, start);
    const oldest = this.recoverable.keys().next();
    if (this.recoverable.size > RECOVERABLE_RUNS_MAX && !oldest.done)
      this.recoverable.delete(oldest.value);
  }

  private async sendStart(
    host: LiveHost,
    start: PipelineHostLaunch,
  ): Promise<WorkerPipelineExecution> {
    let value: unknown;
    try {
      value = await this.send(
        host,
        { op: 'start', start },
        this.requestTimeoutMs,
      );
    } catch (error) {
      if (error instanceof HostRequestFailure) {
        if (error.code === 'model_steps')
          throw pipelineModelStepsUnsupportedError();
        if (error.code === 'host_steps') throw pipelineLaunchRefusedError();
        if (error.reason === 'exited') throw pipelineHostLostError();
        if (error.reason === 'timeout') {
          // A host that stops answering is faulted; its exit runs the loss path.
          host.process.kill();
          throw pipelineStartFailedError(
            new Error('The pipeline host did not answer.'),
          );
        }
      }
      throw pipelineStartFailedError(
        new Error('The pipeline host refused the start.'),
      );
    }
    const parsed = WorkerPipelineExecutionSchema.safeParse(value);
    if (!parsed.success)
      throw pipelineStartFailedError(
        new Error('The pipeline host refused the start.'),
      );
    return parsed.data;
  }

  /** Ends the streams that followed a start that never ran. */
  private endObservers(host: LiveHost, executionId: string): void {
    const observers = host.observers.get(executionId);
    if (!observers) return;
    host.observers.delete(executionId);
    const notFound = pipelineExecutionNotFoundError().payload;
    for (const observer of [...observers]) observer.onEnd?.(notFound);
    this.scheduleIdleStop(host);
  }

  /**
   * Resumes or retries a run this supervisor started from a portable launch
   * (CAN-6103), with the CAN-4141 semantics the host's executor applies:
   * the launch is resolved again with the secrets the control's own
   * bindings redeemed, and a `from_start` retry runs it as a new execution.
   * Any other run, and the matrix controls, answer
   * {@link pipelineLaunchUnavailableError}, as before: the app that started
   * a host-local launch resumes it.
   */
  public async control(
    request: PipelineControlRequest,
    signal: AbortSignal,
    secrets: RedeemedExecutionSecrets,
  ): Promise<WorkerPipelineControlResult> {
    const resolve = this.options.resolvePortableLaunch;
    const kept = this.recoverable.get(request.params.executionId);
    const control = hostControlOf(request);
    if (!resolve || !kept || !control) throw pipelineLaunchUnavailableError();
    const target = controlTargetOf(control);
    // One control or start of an execution at a time: they share its host markers.
    const claimed = [kept.executionId, target];
    if (
      claimed.some(
        (executionId) =>
          this.controlling.has(executionId) || this.starts.has(executionId),
      )
    )
      throw pipelineControlFailedError(
        new Error('Another control or start of this run is under way.'),
      );
    for (const executionId of claimed) this.controlling.add(executionId);
    try {
      return await this.runControl(request, control, kept, target, signal, {
        resolve,
        secrets,
      });
    } finally {
      for (const executionId of claimed) this.controlling.delete(executionId);
    }
  }

  private async runControl(
    request: PipelineControlRequest,
    control: PipelineHostControl,
    kept: RecoverableStart,
    target: string,
    signal: AbortSignal,
    {
      resolve,
      secrets,
    }: {
      readonly resolve: NonNullable<
        PipelineHostSupervisorOptions['resolvePortableLaunch']
      >;
      readonly secrets: RedeemedExecutionSecrets;
    },
  ): Promise<WorkerPipelineControlResult> {
    const ownerBound = kept.portableLaunch.ownerBound === true;
    // A run resumed without its owner would only pause again.
    if (ownerBound && this.options.owner?.ownerSubscribed() !== true)
      throw pipelineOwnerUnavailableError({
        retryable:
          this.options.remoteOwner !== undefined && !hasSecretBindings(request),
      });
    const start = await resolve({ ...kept, executionId: target }, secrets);
    const host = await this.liveHost();
    await this.sendOwnerRequestFloor(host);
    if (signal.aborted)
      throw pipelineControlFailedError(
        new Error('The workflow control was cancelled.'),
      );
    // From here on the signal is ignored, as for a start.
    // Requests the run raises before the answer are relayed, as for a start.
    host.pendingStarts.add(target);
    let result: WorkerPipelineControlResult;
    try {
      result = await this.sendControl(host, control, start);
    } finally {
      host.pendingStarts.delete(target);
      // An end seen meanwhile may be an earlier attempt's: the read below decides.
      host.settledEarly.delete(target);
    }
    // A control the host answered just before its fence closed: the run
    // stopped without an outcome, so it is not followed (CAN-6198).
    if (host.fenced) throw pipelineHostLostError();
    if (target !== kept.executionId)
      this.keepRecoverable({ ...kept, executionId: target });
    if (
      result.outcome === 'started' &&
      !host.exited &&
      !isSettled(result.execution)
    ) {
      this.admitRunning(host, target, ownerBound);
      await this.releaseIfSettled(host, target);
    }
    return result;
  }

  /**
   * Releases a run a control admitted if the host reports it settled: it
   * may have ended before or as the control answered (CAN-6103). The read
   * follows every message the host posted before it, so an end it reports
   * is this attempt's, and a later one reaches the execution handler.
   */
  private async releaseIfSettled(
    host: LiveHost,
    executionId: string,
  ): Promise<void> {
    let current: WorkerPipelineExecution | null;
    try {
      current = await this.get(executionId);
    } catch {
      return;
    }
    if (
      current &&
      isSettled(current) &&
      this.host === host &&
      host.executions.delete(executionId)
    ) {
      this.releaseExecution(executionId);
      this.scheduleIdleStop(host);
    }
  }

  private async sendControl(
    host: LiveHost,
    control: PipelineHostControl,
    start: PipelineHostLaunch,
  ): Promise<WorkerPipelineControlResult> {
    let value: unknown;
    try {
      value = await this.send(
        host,
        { op: 'control', control, start },
        this.requestTimeoutMs,
      );
    } catch (error) {
      if (error instanceof HostRequestFailure) {
        if (error.code === 'not_found') throw pipelineExecutionNotFoundError();
        if (error.reason === 'exited') throw pipelineHostLostError();
        if (error.reason === 'timeout') {
          // A host that stops answering is faulted; its exit runs the loss path.
          host.process.kill();
          throw pipelineControlFailedError(
            new Error('The pipeline host did not answer.'),
          );
        }
      }
      throw pipelineControlFailedError(
        new Error('The pipeline host refused the control.'),
      );
    }
    const parsed = WorkerPipelineControlResultSchema.safeParse(value);
    if (!parsed.success)
      throw pipelineControlFailedError(
        new Error('The pipeline host refused the control.'),
      );
    return parsed.data;
  }

  /** One read the host answers; a host that exits under it is lost, as during a start. */
  private async read(request: PipelineHostRequest): Promise<unknown> {
    const host = await this.liveHost();
    try {
      return await this.send(host, request, this.requestTimeoutMs);
    } catch (error) {
      if (error instanceof HostRequestFailure && error.reason === 'exited')
        throw pipelineHostLostError();
      throw pipelineHostUnavailableError();
    }
  }

  public async get(
    executionId: string,
  ): Promise<WorkerPipelineExecution | null> {
    const value = await this.read({ op: 'get', executionId });
    if (value === null) return null;
    const parsed = WorkerPipelineExecutionSchema.safeParse(value);
    if (!parsed.success) throw pipelineHostUnavailableError();
    return parsed.data;
  }

  public async inspect(
    executionId: string,
  ): Promise<WorkerPipelineExecutionView | null> {
    const value = await this.read({ op: 'get', executionId, detail: true });
    if (value === null) return null;
    const parsed = WorkerPipelineExecutionViewSchema.safeParse(value);
    if (!parsed.success || parsed.data.detail === undefined)
      throw pipelineHostUnavailableError();
    return parsed.data;
  }

  public async list(
    query: PipelineExecutionListQuery,
  ): Promise<PipelineExecutionListPage> {
    const page = parseHostListPage(await this.read({ op: 'list', query }));
    if (page === null) throw pipelineHostUnavailableError();
    return page;
  }

  public async cancel(
    executionId: string,
    mode: WorkerPipelineCancelMode,
  ): Promise<WorkerPipelineExecution> {
    const host = await this.liveHost();
    let value: unknown;
    try {
      value = await this.send(
        host,
        { op: 'cancel', executionId, mode },
        this.requestTimeoutMs + CANCEL_EXTRA_MS,
      );
    } catch (error) {
      if (error instanceof HostRequestFailure) {
        if (error.code === 'not_found') throw pipelineExecutionNotFoundError();
        if (error.code === 'drain_timed_out')
          throw new PipelineDrainTimeoutError();
        if (error.reason === 'exited') throw pipelineHostUnavailableError();
      }
      throw new Error('The workflow run could not be cancelled.');
    }
    const parsed = WorkerPipelineExecutionSchema.safeParse(value);
    if (!parsed.success)
      throw new Error('The workflow run could not be cancelled.');
    return parsed.data;
  }

  public async sweep(
    params: WorkerPipelineRecoverySweepParams,
  ): Promise<WorkerPipelineRecoverySweepResult> {
    const host = await this.liveHost();
    let value: unknown;
    try {
      value = await this.send(
        host,
        { op: 'sweep', executionIds: [...params.executionIds] },
        this.requestTimeoutMs,
      );
    } catch {
      throw pipelineHostUnavailableError();
    }
    const parsed = WorkerPipelineRecoverySweepResultSchema.safeParse(value);
    if (!parsed.success) throw pipelineHostUnavailableError();
    return parsed.data;
  }

  public async checkpoint(_params?: {
    requestId: string;
  }): Promise<WorkerPipelineRecoveryCheckpointResult> {
    void _params;
    const host = this.host;
    if (!host || host.exited) return { checkpointedCount: 0 };
    let value: unknown;
    try {
      value = await this.send(
        host,
        { op: 'checkpoint' },
        this.options.checkpointTimeoutMs ?? CHECKPOINT_TIMEOUT_MS,
      );
    } catch {
      throw pipelineCheckpointFailedError(
        new Error('The pipeline host could not checkpoint.'),
      );
    }
    const parsed =
      WorkerPipelineRecoveryCheckpointResultSchema.safeParse(value);
    if (!parsed.success)
      throw pipelineCheckpointFailedError(
        new Error('The pipeline host could not checkpoint.'),
      );
    return parsed.data;
  }

  /**
   * Checkpoints one run so its host can roll over (CAN-6199): no new step
   * starts, its running steps may finish within `drainMs`, then the rest
   * pauses with `host_rollover`. Resolves once it stopped; a run the host
   * is not running answers as it is.
   */
  public async checkpointExecution(params: {
    readonly executionId: string;
    readonly drainMs: number;
  }): Promise<WorkerPipelineExecution> {
    const { executionId, drainMs } = params;
    const host = this.host;
    // A run whose start is still pending is live too: the host waits for it.
    if (
      !host ||
      host.exited ||
      !(host.executions.has(executionId) || host.pendingStarts.has(executionId))
    ) {
      const stored = await this.get(executionId);
      if (!stored) throw pipelineExecutionNotFoundError();
      return stored;
    }
    let value: unknown;
    try {
      value = await this.send(
        host,
        { op: 'checkpointRun', executionId, drainMs },
        drainMs + (this.options.checkpointTimeoutMs ?? CHECKPOINT_TIMEOUT_MS),
      );
    } catch (error) {
      if (error instanceof HostRequestFailure) {
        if (error.code === 'not_found') throw pipelineExecutionNotFoundError();
        if (error.reason === 'exited') throw pipelineHostUnavailableError();
      }
      throw pipelineCheckpointFailedError(
        new Error('The pipeline host could not checkpoint the run.'),
      );
    }
    const parsed = WorkerPipelineExecutionSchema.safeParse(value);
    if (!parsed.success)
      throw pipelineCheckpointFailedError(
        new Error('The pipeline host could not checkpoint the run.'),
      );
    return parsed.data;
  }

  public observe(
    executionId: string,
    observer: PipelineExecutionObserver,
  ): (() => void) | null {
    const host = this.host;
    if (
      !host ||
      host.exited ||
      host.fenced === true ||
      !(host.executions.has(executionId) || host.pendingStarts.has(executionId))
    )
      return null;
    let set = host.observers.get(executionId);
    if (!set) {
      set = new Set();
      host.observers.set(executionId, set);
    }
    set.add(observer);
    this.clearIdle(host);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = host.observers.get(executionId);
      current?.delete(observer);
      if (current?.size === 0) host.observers.delete(executionId);
      this.scheduleIdleStop(host);
    };
  }

  /** Phase 5: checkpoint every live execution, then stop the host. */
  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.offOwnerChange?.();
    if (this.ownerAbsentTimer !== undefined)
      clearTimeout(this.ownerAbsentTimer);
    this.ownerAbsentTimer = undefined;
    const host = this.host;
    if (host) this.abortHostCalls(host);
    if (host && !host.exited) {
      this.clearIdle(host);
      try {
        await this.checkpoint();
      } catch {
        // The host is stopped below whatever it answered.
      }
      host.expectedExit = true;
      this.send(host, { op: 'exit' }, this.requestTimeoutMs).catch(
        () => undefined,
      );
      await Promise.race([this.waitForExit(host), delay(EXIT_GRACE_MS)]);
      if (!host.exited) host.process.kill();
    }
    this.host = null;
    this.recoverable.clear();
    for (const release of this.releases.values()) release();
    this.releases.clear();
    for (const kept of this.undelivered.values())
      if (kept.expiry !== undefined) clearTimeout(kept.expiry);
    this.undelivered.clear();
  }

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  // Until a remote owner's TTL is known no run has started, so the local
  // defaults only time an owner that leaves before the first start.
  private get ownerWaitMs(): number {
    // To a renewed expiry, a wait outlasts the owner-absence pause at that
    // expiry by the checkpoint's time, so the pause withdraws its request
    // instead of the wait failing its step as unavailable.
    const untilExpiry = this.untilRenewedExpiry();
    if (untilExpiry !== null)
      return Math.min(
        TIMER_MAX_MS,
        untilExpiry +
          (this.options.checkpointTimeoutMs ?? CHECKPOINT_TIMEOUT_MS),
      );
    return this.leaseTtlMs ?? this.options.ownerWaitMs ?? OWNER_WAIT_MS;
  }

  /** A remote owner's lease TTL, the least its requests wait (CP-11). */
  private ownerRequestFloor(): number | undefined {
    return this.options.remoteOwner ? this.leaseTtlMs : undefined;
  }

  /**
   * Gives a host that started before the lease TTL was known, as a read
   * starts one before the first start, the owner-request floor (CP-11).
   */
  private async sendOwnerRequestFloor(host: LiveHost): Promise<void> {
    const floor = this.ownerRequestFloor();
    if (floor === undefined || host.ownerRequestDeadlineMs === floor) return;
    host.ownerRequestDeadlineMs = floor;
    await this.send(
      host,
      { op: 'ownerDeadline', ownerRequestDeadlineMs: floor },
      this.requestTimeoutMs,
    ).catch(() => undefined);
  }

  /** Milliseconds to the reported lease expiry, or null before a renewal. */
  private untilRenewedExpiry(): number | null {
    if (this.renewedLeaseExpiresAt === undefined) return null;
    return Math.min(
      TIMER_MAX_MS,
      Math.max(0, this.renewedLeaseExpiresAt - Date.now()),
    );
  }

  private get ownerAbsentPauseMs(): number {
    return (
      this.untilRenewedExpiry() ??
      this.leaseTtlMs ??
      this.options.ownerAbsentPauseMs ??
      OWNER_ABSENT_PAUSE_MS
    );
  }

  private liveHost(): Promise<LiveHost> {
    if (this.stopped) return Promise.reject(pipelineHostUnavailableError());
    if (this.host && !this.host.exited) return Promise.resolve(this.host);
    if (this.leaseEnded())
      return Promise.reject(pipelineHostUnavailableError());
    this.starting ??= this.launchHost().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launchHost(attempt = 0): Promise<LiveHost> {
    let process: PipelineHostProcess;
    try {
      process = this.options.launch();
    } catch {
      throw pipelineHostUnavailableError();
    }
    const host: LiveHost = {
      process,
      pending: new Map(),
      executions: new Set(),
      processGroups: new Map(),
      ownerRequestDeadlineMs: undefined,
      observers: new Map(),
      pendingStarts: new Set(),
      settledEarly: new Set(),
      exitWaiters: [],
      hostCalls: new Map(),
      expectedExit: false,
      exited: false,
    };
    process.on('message', (message) => this.receive(host, message));
    process.on('exit', (code) => this.ended(host, code));
    const configuredLease = this.ownerLease;
    host.ownerRequestDeadlineMs = this.ownerRequestFloor();
    try {
      await this.send(
        host,
        {
          op: 'configure',
          dataRoot: this.options.configure.dataRoot,
          ...(this.options.configure.codexMcpLauncher && {
            codexMcpLauncher: this.options.configure.codexMcpLauncher,
          }),
          ...(configuredLease && { ownerLease: configuredLease }),
          ...(this.options.configure.memory && {
            memory: this.options.configure.memory,
          }),
          // A remote owner's requests wait as long as its lease lasts, so
          // one raised early in an outage outlives it (CP-11).
          ...(this.ownerRequestFloor() !== undefined && {
            ownerRequestDeadlineMs: this.ownerRequestFloor(),
          }),
        },
        this.requestTimeoutMs,
      );
    } catch {
      host.expectedExit = true;
      process.kill();
      throw pipelineHostUnavailableError();
    }
    // A renewal observed while the host started must hold in it before it
    // serves, and the lease may have ended meanwhile (CAN-6198). A host
    // whose fence already lapsed on an older lease is replaced by one
    // configured with the renewed lease.
    let sentLease = configuredLease;
    for (;;) {
      if (this.stopped || host.exited || this.leaseEnded()) {
        host.expectedExit = true;
        process.kill();
        throw pipelineHostUnavailableError();
      }
      const lease = this.ownerLease;
      if (!lease || lease === sentLease) break;
      const state = await this.forwardLease(host, {
        kind: 'renewed',
        lease,
      });
      if (state !== 'held') {
        host.expectedExit = true;
        process.kill();
        if (attempt < LEASE_RECONFIGURE_ATTEMPTS && !this.leaseEnded())
          return this.launchHost(attempt + 1);
        throw pipelineHostUnavailableError();
      }
      sentLease = lease;
    }
    this.host = host;
    this.scheduleIdleStop(host);
    return host;
  }

  private send(
    host: LiveHost,
    request: PipelineHostRequest,
    timeoutMs: number,
  ): Promise<unknown> {
    if (host.exited) return Promise.reject(new HostRequestFailure('exited'));
    this.clearIdle(host);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(id);
        reject(new HostRequestFailure('timeout'));
        this.scheduleIdleStop(host);
      }, timeoutMs);
      host.pending.set(id, { resolve, reject, timer });
      try {
        host.process.postMessage({ id, request });
      } catch {
        clearTimeout(timer);
        host.pending.delete(id);
        reject(new HostRequestFailure('unavailable'));
      }
    });
  }

  private receive(host: LiveHost, message: unknown): void {
    if (host.exited || !isPipelineHostMessage(message)) return;
    this.handle(host, message);
    this.scheduleIdleStop(host);
  }

  private handle(host: LiveHost, message: PipelineHostMessage): void {
    switch (message.kind) {
      case 'response': {
        const pending = host.pending.get(message.id);
        if (!pending) return;
        host.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else
          pending.reject(new HostRequestFailure('refused', message.error.code));
        return;
      }
      case 'execution': {
        const { executionId, event, execution } = message;
        for (const observer of [...(host.observers.get(executionId) ?? [])])
          observer.onExecution(event, execution);
        if (!isSettled(execution)) return;
        this.expireUndelivered(executionId);
        if (host.executions.delete(executionId))
          this.releaseExecution(executionId);
        else if (host.pendingStarts.has(executionId))
          host.settledEarly.add(executionId);
        return;
      }
      case 'output': {
        const { executionId, ...output } = message;
        for (const observer of [...(host.observers.get(executionId) ?? [])])
          observer.onOutput(output);
        return;
      }
      case 'notification': {
        const { executionId, stepId, title, body } = message;
        let delivered = false;
        for (const observer of [...(host.observers.get(executionId) ?? [])])
          if (observer.onNotification?.({ stepId, title, body }) === true)
            delivered = true;
        // A run can notify before a stream can take it; keep it for the next one.
        if (!delivered)
          this.keepUndelivered(executionId, { stepId, title, body });
        return;
      }
      case 'process':
        if (message.state === 'started')
          host.processGroups.set(message.id, message.processGroupId);
        else host.processGroups.delete(message.id);
        return;
      case 'hostRequest':
        void this.relayHostRequest(host, message.request);
        return;
      case 'hostRequestWithdrawn': {
        const call = host.hostCalls.get(message.requestId);
        if (call?.executionId === message.executionId) call.abort.abort();
        return;
      }
      case 'fenced':
        // A host still starting is replaced instead (launchHost).
        if (this.host === host) this.closeLease();
        return;
    }
  }

  /**
   * Raises one host step on the owner channel and answers the host with its
   * settlement (CAN-5771). Nothing here logs or keeps the request.
   */
  private async relayHostRequest(
    host: LiveHost,
    request: WorkerPipelineHostRequest,
  ): Promise<void> {
    const { requestId, executionId } = request;
    // A request can arrive in the same read as its start's answer.
    if (
      !(
        host.executions.has(executionId) || host.pendingStarts.has(executionId)
      ) ||
      host.hostCalls.has(requestId)
    )
      return;
    const abort = new AbortController();
    host.hostCalls.set(requestId, { executionId, abort });
    const hung = this.armHungOwnerPause(request);
    try {
      const settlement = await this.settleHostRequest(request, abort.signal);
      // The owner answered: only an unanswered request pauses its run.
      if (hung !== undefined) clearTimeout(hung);
      if (settlement && !abort.signal.aborted)
        await this.send(
          host,
          { op: 'hostSettled', requestId, settlement },
          this.requestTimeoutMs,
        ).catch(() => undefined);
    } finally {
      if (hung !== undefined) clearTimeout(hung);
      if (host.hostCalls.get(requestId)?.abort === abort)
        host.hostCalls.delete(requestId);
    }
  }

  /** The owner's settlement, `unavailable` without one, or null when withdrawn. */
  private async settleHostRequest(
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
  ): Promise<PipelineHostSettlement | null> {
    const remote = this.options.remoteOwner;
    // A remote owner never receives a request only this host can answer.
    if (remote && isWorkerPipelineLocalOwnerAction(request.request.action))
      return {
        kind: 'owner',
        settlement: await this.answerLocally(remote, request),
      };
    const owner = this.options.owner;
    if (!owner) return { kind: 'unavailable' };
    const present = await this.waitForOwner(owner, signal);
    if (signal.aborted) return null;
    if (!present) return { kind: 'unavailable' };
    try {
      // A model step's owner request (CAN-5095) takes the owner's answer and values as they are.
      if (isWorkerPipelineOwnerAction(request.request.action)) {
        if (!remote)
          return {
            kind: 'owner',
            settlement: await owner.broker.raiseOwner(request, signal),
          };
        const settlement = await owner.broker.raiseOwner(
          remoteOwnerRequestOf(request),
          signal,
        );
        return {
          kind: 'owner',
          settlement: await this.withRemoteValues(remote, request, settlement),
        };
      }
      const answer = await owner.broker.raiseHostStep(request, signal);
      return {
        kind: 'settled',
        result: answer.result,
        values: answer.values ?? null,
      };
    } catch (error) {
      if (error instanceof PipelineHostUnavailableError)
        return { kind: 'unavailable' };
      return null;
    }
  }

  /** A local-only request's answer, checked as an owner's would be (CAN-6161). */
  private async answerLocally(
    remote: PipelineRemoteOwner,
    request: WorkerPipelineHostRequest,
  ): Promise<PipelineOwnerSettlement> {
    let value: WorkerPipelineOwnerResult;
    try {
      value = remote.answerLocally
        ? await remote.answerLocally(request)
        : localRefusal(request);
    } catch {
      value = localRefusal(request);
    }
    return ownerSettlement(request, { status: 'owner', value }, undefined);
  }

  /**
   * A remote owner's settlement with the host-local values its route ids
   * resolve to (P9). Values never come from the owner itself.
   */
  private async withRemoteValues(
    remote: PipelineRemoteOwner,
    request: WorkerPipelineHostRequest,
    settlement: PipelineOwnerSettlement,
  ): Promise<PipelineOwnerSettlement> {
    const { result } = settlement;
    if (result.status !== 'owner' || !remote.resolveOwnerValues)
      return { result };
    let values: Omit<WorkerPipelineOwnerValues, 'requestId'> | undefined;
    try {
      values = await remote.resolveOwnerValues(request, result.value);
    } catch {
      values = undefined;
    }
    return values
      ? { result, values: { ...values, requestId: request.requestId } }
      : { result };
  }

  /** Whether an owner subscribed within the wait; false on timeout or abort. */
  private waitForOwner(
    owner: Pick<PipelineOwnerChannel, 'ownerSubscribed' | 'onOwnerChange'>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (owner.ownerSubscribed()) return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (present: boolean): void => {
        clearTimeout(timer);
        this.ownerWaits.delete(arm);
        off();
        signal.removeEventListener('abort', aborted);
        resolve(present);
      };
      const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => done(false), this.ownerWaitMs);
      };
      const aborted = (): void => done(false);
      arm();
      this.ownerWaits.add(arm);
      const off = owner.onOwnerChange((subscribed) => {
        if (subscribed) done(true);
      });
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  /** Every waiting host call ends; the broker withdraws each from the owner. */
  private abortHostCalls(host: LiveHost): void {
    for (const call of host.hostCalls.values()) call.abort.abort();
    host.hostCalls.clear();
  }

  /** Owner-bound runs pause once the owner has been gone a while (CAN-5771). */
  private ownerChanged(subscribed: boolean): void {
    if (subscribed) {
      this.ownerGone = false;
      if (this.ownerAbsentTimer !== undefined)
        clearTimeout(this.ownerAbsentTimer);
      this.ownerAbsentTimer = undefined;
      return;
    }
    if (this.stopped || this.ownerAbsentTimer !== undefined) return;
    this.armOwnerAbsence();
  }

  /**
   * Pauses owner-bound runs once the owner has been away for the lease: to
   * its reported expiry when the owner reported a renewal, otherwise for
   * the TTL from now.
   */
  private armOwnerAbsence(): void {
    const timer = setTimeout(() => {
      this.ownerAbsentTimer = undefined;
      this.ownerGone = true;
      void this.pauseOwnerBound();
    }, this.ownerAbsentPauseMs);
    timer.unref?.();
    this.ownerAbsentTimer = timer;
  }

  private async pauseOwnerBound(
    executionIds: readonly string[] = [...this.ownerBound],
  ): Promise<void> {
    const host = this.host;
    if (!host || host.exited || executionIds.length === 0) return;
    await this.send(
      host,
      {
        op: 'pause',
        executionIds: [...executionIds],
        // Desktop keeps `app_shutdown`: its resume after restart looks for it.
        ...(this.options.remoteOwner && { reason: 'owner_lost' as const }),
      },
      this.options.checkpointTimeoutMs ?? CHECKPOINT_TIMEOUT_MS,
    ).catch(() => undefined);
  }

  /**
   * With a remote owner, an owner request still unanswered shortly before
   * its deadline pauses its run with `owner_lost`; the host would fail the
   * step at the deadline (CAN-6102). The owner may be silent, as in a web
   * core redeploy that keeps the relay open, or away.
   */
  private armHungOwnerPause(
    request: WorkerPipelineHostRequest,
  ): ReturnType<typeof setTimeout> | undefined {
    if (
      !this.options.remoteOwner ||
      !isWorkerPipelineOwnerAction(request.request.action) ||
      isWorkerPipelineLocalOwnerAction(request.request.action)
    )
      return undefined;
    const deadline = Date.parse(request.deadlineAt);
    if (!Number.isFinite(deadline)) return undefined;
    const { executionId } = request;
    const timer = setTimeout(
      () => {
        if (this.ownerBound.has(executionId))
          void this.pauseOwnerBound([executionId]);
      },
      Math.min(
        TIMER_MAX_MS,
        Math.max(0, deadline - Date.now() - HUNG_OWNER_PAUSE_LEAD_MS),
      ),
    );
    timer.unref?.();
    return timer;
  }

  /** Takes the notifications no stream has received yet for `executionId`. */
  public takeNotifications(
    executionId: string,
  ): readonly PipelineExecutionNotification[] {
    const kept = this.undelivered.get(executionId);
    if (!kept) return [];
    this.undelivered.delete(executionId);
    if (kept.expiry !== undefined) clearTimeout(kept.expiry);
    return kept.items;
  }

  private keepUndelivered(
    executionId: string,
    notification: PipelineExecutionNotification,
  ): void {
    let kept = this.undelivered.get(executionId);
    if (!kept) {
      kept = { items: [] };
      this.undelivered.set(executionId, kept);
    }
    if (kept.items.length < UNDELIVERED_NOTIFICATIONS_MAX)
      kept.items.push(notification);
  }

  private expireUndelivered(executionId: string): void {
    const kept = this.undelivered.get(executionId);
    if (!kept || kept.expiry !== undefined) return;
    const expiry = setTimeout(() => {
      if (this.undelivered.get(executionId) === kept)
        this.undelivered.delete(executionId);
    }, UNDELIVERED_NOTIFICATIONS_TTL_MS);
    expiry.unref?.();
    kept.expiry = expiry;
  }

  /**
   * Stops a host whose lease ended (CAN-6198): its runs end as for a lost
   * host, without an outcome, their holds are released and its process is
   * killed; the step process groups go when it exits.
   */
  private terminateFenced(host: LiveHost): void {
    host.fenced = true;
    host.expectedExit = true;
    if (this.host === host) this.host = null;
    const lost = pipelineHostLostError().payload;
    for (const observers of host.observers.values())
      for (const observer of [...observers]) observer.onEnd?.(lost);
    host.observers.clear();
    for (const executionId of host.executions) {
      this.releaseExecution(executionId);
      this.expireUndelivered(executionId);
    }
    host.executions.clear();
    host.process.kill();
  }

  private releaseExecution(executionId: string): void {
    this.ownerBound.delete(executionId);
    const release = this.releases.get(executionId);
    this.releases.delete(executionId);
    release?.();
  }

  private clearIdle(host: LiveHost): void {
    if (host.idleTimer === undefined) return;
    clearTimeout(host.idleTimer);
    host.idleTimer = undefined;
  }

  private busy(host: LiveHost): boolean {
    return (
      host.executions.size > 0 ||
      host.observers.size > 0 ||
      host.pending.size > 0
    );
  }

  /**
   * Stops a host that holds nothing: no execution, observer or request. It
   * leaves the current slot first, so a request meanwhile starts another.
   */
  private scheduleIdleStop(host: LiveHost): void {
    if (
      host.exited ||
      host.idleTimer !== undefined ||
      this.host !== host ||
      this.busy(host)
    )
      return;
    const timer = setTimeout(() => {
      host.idleTimer = undefined;
      if (this.host !== host || this.busy(host)) return;
      this.host = null;
      host.expectedExit = true;
      this.send(host, { op: 'exit' }, this.requestTimeoutMs).catch(
        () => undefined,
      );
      const kill = setTimeout(() => {
        if (!host.exited) host.process.kill();
      }, EXIT_GRACE_MS);
      kill.unref?.();
    }, this.options.idleStopMs ?? IDLE_STOP_MS);
    timer.unref?.();
    host.idleTimer = timer;
  }

  private waitForExit(host: LiveHost): Promise<void> {
    if (host.exited) return Promise.resolve();
    return new Promise((resolve) => {
      host.exitWaiters.push(resolve);
    });
  }

  private ended(host: LiveHost, code: number): void {
    if (host.exited) return;
    host.exited = true;
    this.abortHostCalls(host);
    this.clearIdle(host);
    if (this.host === host) this.host = null;
    for (const pending of host.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HostRequestFailure('exited'));
    }
    host.pending.clear();
    // Step process groups outlive their host's tree, however it ended.
    for (const group of host.processGroups.values())
      if (group > 0) this.options.killProcessGroup?.(group);
    if (!host.expectedExit) {
      const lost = pipelineHostLostError().payload;
      for (const observers of host.observers.values())
        for (const observer of [...observers]) observer.onEnd?.(lost);
      this.options.onHostLost?.({ code, lost: host.executions.size });
    }
    host.processGroups.clear();
    host.observers.clear();
    for (const executionId of host.executions) {
      this.releaseExecution(executionId);
      this.expireUndelivered(executionId);
    }
    host.executions.clear();
    for (const resolve of host.exitWaiters.splice(0)) resolve();
  }
}
