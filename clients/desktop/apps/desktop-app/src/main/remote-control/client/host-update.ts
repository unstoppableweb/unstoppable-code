import { randomUUID } from 'node:crypto';
import {
  CanopyStreamCursorSchema,
  UpdateApplyCancelResultSchema,
  UpdateComponentStatusSchema,
  UpdateStatusGetResultSchema,
  type UpdateComponentStatus,
} from '@canopy/protocol/canopy-core';
import {
  TARGETED_UPDATE_REFUSAL,
  UPDATE_CHANNEL_FOR_FLAVOR,
  type DesktopReleaseFlavor,
} from '@canopy/core-runtime/update';
import type {
  RemoteHostUpdatePhase,
  RemoteHostUpdateReason,
  RemoteHostUpdateStatus,
} from '@canopy/protocol/remote-control';
import { classifyError } from '@canopy/protocol/app-errors/classification';
import {
  CoreCallResultSchema,
  CoreEventParamsSchema,
  REMOTE_CORE_OPERATIONS,
  REMOTE_METHODS,
  type CoreCallResult,
  type HelloResult,
  type RemoteCoreOperation,
} from '../remote-protocol';
import { RpcClosedError, type RpcPeer } from '../transport/rpc-peer';

/*
 * The controller's side of updating a paired computer that runs an older
 * remote-control protocol (CAN-5899, slice 3). The session stays open only
 * for the host's `core.update.*` operations, which their own versions govern;
 * every other call stays refused until the host restarts on a compatible
 * version. The host keeps its own channel, feed, signature checks and restart
 * policy; this computer only asks it to check, download and apply the
 * candidate it found itself.
 */

/** The operations this computer needs a host to serve to update it. */
const REQUIRED_OPERATIONS: readonly RemoteCoreOperation[] = [
  'core.update.status.get',
  'core.update.events',
  'core.update.check',
  'core.update.download',
  'core.update.apply',
  'core.update.apply.cancel',
];

/** Whether a host's hello lists every update operation at our version. */
export function servesHostUpdates(hello: HelloResult): boolean {
  const served = hello.coreOperations;
  if (!served) return false;
  return REQUIRED_OPERATIONS.every(
    (operation) => served[operation] === REMOTE_CORE_OPERATIONS[operation],
  );
}

function isReleaseFlavor(value: unknown): value is DesktopReleaseFlavor {
  return value === 'stable' || value === 'rc' || value === 'internal';
}

/** Unsupported reasons that mean a development build. */
const DEVELOPMENT_BUILD_REASONS = new Set([
  'local_only_build',
  'source_build',
  'not_packaged',
]);

/** How long a restarting host may stay away before this computer says so. */
export const HOST_RESTART_TIMEOUT_MS = 10 * 60_000;

/** Retries of one request the host rate-limited. */
const RATE_LIMIT_RETRIES = 3;

/** How often a wait re-reads the host's status in case its stream is silent. */
const STATUS_POLL_MS = 15_000;

export interface LocalRelease {
  /** `stable`, `rc` or `internal`. */
  readonly flavor: string;
  /** This computer's version as it shows it, such as `internal-123`. */
  readonly displayVersion: string;
}

export interface HostUpdateTrackerOptions {
  readonly local: LocalRelease;
  readonly onChange: () => void;
  readonly restartTimeoutMs?: number;
  readonly statusPollMs?: number;
  readonly newKey?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
}

type Failure = Extract<CoreCallResult, { ok: false }>['error'];

/** The host's refusal of a version someone there picked to install. */
function isTargetedRefusal(failure: Failure): boolean {
  return (
    failure.code === 'core.update.invalidState' &&
    failure.message === TARGETED_UPDATE_REFUSAL
  );
}

/**
 * A refusal in this computer's words. The host writes its refusals from its
 * own side ("this computer"), which would name the wrong computer here; only
 * an updater failure keeps the host's text, which describes the update.
 */
function controllerMessage(failure: Failure): string {
  switch (failure.code) {
    case 'core.update.failed':
      return failure.message;
    case 'core.update.disabled':
      return "The other computer doesn't allow updates from other computers.";
    case 'core.update.rateLimited':
      return 'The other computer is busy with another update request. Try again in a few seconds.';
    case 'core.update.invalidState':
      return isTargetedRefusal(failure)
        ? 'Someone at the other computer picked a specific version to install. Finish or cancel it there.'
        : "The other computer's update changed while this one asked. Try again.";
    default:
      return "The other computer couldn't take that update step. Try again.";
  }
}

/** A step the host refused, worded from this computer's side. */
export class HostUpdateRefusedError extends Error {
  constructor(readonly failure: Failure) {
    super(controllerMessage(failure));
    classifyError(this, 'external.state_changed');
  }
}

/**
 * Someone at the host withdrew a restart while this computer's request for
 * one waited out a rate limit; sending it then would undo their cancel.
 */
class HostUpdateWithdrawnError extends Error {
  constructor() {
    super('Someone at the other computer cancelled the restart.');
    classifyError(this, 'external.state_changed');
  }
}

class HostUpdateSessionClosedError extends Error {
  constructor() {
    super('The connection to the other computer closed.');
    classifyError(this, 'external.state_changed');
  }
}

/** The session went away under a request: the host closed or quit. */
function isSessionClosed(error: unknown): boolean {
  return (
    error instanceof HostUpdateSessionClosedError ||
    error instanceof RpcClosedError
  );
}

/** Refusals the notice explains in its own words, naming the host. */
function refusalReason(failure: Failure): RemoteHostUpdateReason | null {
  if (failure.code === 'core.update.disabled') return 'remote-updates-off';
  if (isTargetedRefusal(failure)) return 'targeted-update-pending';
  return null;
}

interface Waiter {
  readonly until: (status: UpdateComponentStatus) => boolean;
  readonly resolve: (status: UpdateComponentStatus) => void;
  readonly reject: (error: Error) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Follows one paired computer's update while the two can't connect: across
 * its sessions, its restart and its return.
 */
export class RemoteHostUpdateTracker {
  private rpc: RpcPeer | null = null;
  private hello: HelloResult | null = null;
  private subscriptionKey: string | null = null;
  private latest: UpdateComponentStatus | null = null;
  private waiters: Waiter[] = [];
  /** A chain of update steps this computer started is under way. */
  private running: 'check' | 'download' | null = null;
  /** This computer asked the host to restart and install. */
  private restartRequested = false;
  /** This computer is withdrawing its restart. */
  private cancelling = false;
  /** The host went away to install; set until it answers again. */
  private restarting = false;
  /** The host version before its restart, to tell whether it updated. */
  private versionBeforeRestart: string | null = null;
  /**
   * The host's event stream epoch. Each run of the host has its own, so a
   * session that closed without one changing was a dropped connection, not
   * a restart.
   */
  private epoch: string | null = null;
  private epochBeforeRestart: string | null = null;
  /** What the host was before it went away, judged on its first status back. */
  private restartVerdict: {
    readonly version: string | null;
    readonly epoch: string | null;
  } | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private notBack = false;
  private reason: RemoteHostUpdateReason | null = null;
  /** The last check found nothing newer on the host's channel. */
  private upToDate = false;
  /** A step failed before the host could report it in its status. */
  private stepError: string | null = null;
  /** How many statuses the host has reported, to tell new ones from old. */
  private observations = 0;
  /** `observations` when the last write was sent. */
  private observationsAtWrite = 0;
  /** How many pending restarts the host has withdrawn, by anyone. */
  private withdrawals = 0;
  /** Why the last step was refused, when it has its own explanation. */
  private stepReason: RemoteHostUpdateReason | null = null;
  private disposed = false;

  constructor(private readonly options: HostUpdateTrackerOptions) {}

  /** Starts following the host over a session that answered its hello. */
  attach(rpc: RpcPeer, hello: HelloResult): void {
    this.rpc = rpc;
    this.hello = hello;
    this.clearRestartTimer();
    this.notBack = false;
    if (this.restarting) {
      // Whether it restarted, and on which version, shows in its first status.
      this.restartVerdict = {
        version: this.versionBeforeRestart,
        epoch: this.epochBeforeRestart,
      };
      this.restarting = false;
      this.versionBeforeRestart = null;
      this.epochBeforeRestart = null;
      this.latest = null;
    }
    this.subscribe(rpc);
    this.emit();
  }

  /** The session closed. The host may be restarting to install. */
  sessionClosed(): void {
    this.rpc = null;
    this.subscriptionKey = null;
    this.rejectWaiters(new HostUpdateSessionClosedError());
    const installing =
      this.restartRequested ||
      this.latest?.state === 'applying' ||
      this.latest?.restartPending != null;
    if (installing && !this.restarting) {
      this.restarting = true;
      this.versionBeforeRestart = this.hello?.appVersion ?? null;
      this.epochBeforeRestart = this.epoch;
      this.clearRestartTimer();
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.notBack = true;
        this.emit();
      }, this.options.restartTimeoutMs ?? HOST_RESTART_TIMEOUT_MS);
      this.restartTimer.unref?.();
    }
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.clearRestartTimer();
    this.rejectWaiters(new HostUpdateSessionClosedError());
    const rpc = this.rpc;
    const key = this.subscriptionKey;
    this.rpc = null;
    this.subscriptionKey = null;
    if (rpc && key && !rpc.isClosed) {
      void rpc
        .request(REMOTE_METHODS.coreUnsubscribe, { subscriptionKey: key })
        .catch(() => undefined);
    }
  }

  /** A `core.event` frame from the host. */
  handleEvent(payload: unknown): void {
    const event = CoreEventParamsSchema.safeParse(payload);
    if (!event.success || event.data.subscriptionKey !== this.subscriptionKey) {
      return;
    }
    const frame = event.data.frame;
    if (typeof frame !== 'object' || frame === null || !('kind' in frame)) {
      return;
    }
    if (frame.kind === 'end') {
      // The host closed the stream on its own; open it again.
      this.subscriptionKey = null;
      if (this.rpc && !this.rpc.isClosed) this.subscribe(this.rpc);
      return;
    }
    if (frame.kind !== 'item' || !('item' in frame)) return;
    const item = UpdateComponentStatusSchema.safeParse(frame.item);
    if (!item.success || item.data.component !== 'desktop') return;
    const cursor = CanopyStreamCursorSchema.safeParse(
      'cursor' in frame ? frame.cursor : null,
    );
    this.observe(item.data, cursor.success ? cursor.data.daemonEpoch : null);
  }

  get status(): RemoteHostUpdateStatus | null {
    const hello = this.hello;
    if (!hello) return null;
    const latest = this.latest;
    const { phase, reason } = this.phase();
    return {
      target: 'host',
      hostVersion: latest?.displayVersion ?? hello.appVersion,
      localVersion: this.options.local.displayVersion,
      hostFlavor: latest?.releaseFlavor ?? null,
      localFlavor: this.options.local.flavor,
      phase,
      reason,
      progress: phase === 'downloading' ? (latest?.progress ?? null) : null,
      detail:
        phase === 'failed'
          ? (this.stepError ?? latest?.message ?? null)
          : phase === 'unavailable' && reason === 'manual-update'
            ? (latest?.manualInstructions ?? null)
            : null,
      waitingForChats:
        phase === 'waiting' && latest?.blockers?.activeChatWork === true,
      requestedBy:
        phase === 'waiting' && !this.restartRequested
          ? (latest?.restartPending?.requestedBy?.name ?? null)
          : null,
      canCancel: phase === 'waiting' && this.restartRequested,
    };
  }

  /**
   * Updates the host to the newest release of its own channel: checks when
   * it has no candidate yet, downloads it, then asks it to restart once its
   * running chats finish.
   */
  async update(): Promise<void> {
    if (this.running) return;
    this.reason = null;
    this.upToDate = false;
    this.stepError = null;
    this.stepReason = null;
    try {
      this.running = 'check';
      this.emit();
      let status = await this.readStatus();
      if (status.availableVersion === null || status.state === 'failed') {
        const flavor = status.releaseFlavor;
        await this.write('core.update.check', {
          components: ['desktop'],
          // The host refuses any channel but its own compiled one.
          channel:
            UPDATE_CHANNEL_FOR_FLAVOR[
              isReleaseFlavor(flavor) ? flavor : 'stable'
            ],
          requestedVersion: null,
          force: false,
          _meta: { idempotencyKey: this.newKey() },
        });
        // The host's check settles before it answers, so this status is the
        // check's outcome: no candidate means its channel has nothing newer.
        status = await this.readStatus();
        if (status.availableVersion === null) {
          this.upToDate = status.state !== 'failed';
          return;
        }
      }
      const version = status.availableVersion;
      if (version === null) return;
      if (status.state !== 'ready') {
        this.running = 'download';
        this.emit();
        // A failure counts only once the host reports after this request; an
        // earlier failed check must not end the wait before it starts.
        const since = this.observations;
        // A download already under way, from the host or another computer,
        // is only waited for.
        if (status.state !== 'downloading') {
          await this.write('core.update.download', {
            component: 'desktop',
            version,
            _meta: { idempotencyKey: this.newKey() },
          });
        }
        status = await this.waitFor(
          (next) =>
            next.state === 'ready' ||
            (next.state === 'failed' && this.observations > since),
        );
        if (status.state !== 'ready') return;
      }
      // Joining a restart already pending at the host doesn't make it ours:
      // whoever asked for it keeps it, and only they can withdraw it.
      const joined = status.restartPending != null;
      const withdrawals = this.withdrawals;
      await this.write(
        'core.update.apply',
        {
          component: 'desktop',
          version: status.availableVersion ?? version,
          restartPolicy: 'when_idle',
          _meta: { idempotencyKey: this.newKey() },
        },
        () => this.withdrawals === withdrawals,
      );
      if (!joined) this.restartRequested = true;
    } catch (error) {
      if (error instanceof HostUpdateWithdrawnError) {
        this.reason = 'cancelled-at-host';
      } else if (!isSessionClosed(error)) {
        if (error instanceof HostUpdateRefusedError) {
          this.stepReason = refusalReason(error.failure);
          // The host turned the switch back on after refusing: its status
          // saying so can arrive before this refusal is handled.
          if (
            this.stepReason === 'remote-updates-off' &&
            this.observations > this.observationsAtWrite &&
            this.latest?.remoteUpdatesAllowed === true
          )
            this.stepReason = null;
        }
        if (this.stepReason === null) {
          this.stepError =
            error instanceof Error ? error.message : 'The update failed.';
        }
      }
      throw error;
    } finally {
      this.running = null;
      this.emit();
    }
  }

  /**
   * Reads the host's status again, as Reconnect does in a window that can't
   * show the host: a switch turned on there, or a manual update finished
   * without a restart, shows at once.
   */
  refresh(): void {
    this.stepError = null;
    this.stepReason = null;
    this.readStatus().catch(() => undefined);
  }

  /** Restarts the host now, stopping what runs there, instead of waiting. */
  async restartNow(): Promise<void> {
    if (this.running) {
      throw classifyError(
        new Error(
          'The other computer is still getting its update ready. Try again when it has downloaded.',
        ),
        'external.state_changed',
      );
    }
    const version = this.latest?.availableVersion ?? null;
    if (version === null) {
      throw classifyError(
        new Error('The other computer has no update ready to install.'),
        'external.state_changed',
      );
    }
    this.stepError = null;
    const withdrawals = this.withdrawals;
    await this.write(
      'core.update.apply',
      {
        component: 'desktop',
        version,
        restartPolicy: 'immediate',
        _meta: { idempotencyKey: this.newKey() },
      },
      () => this.withdrawals === withdrawals,
    );
    this.restartRequested = true;
    this.emit();
  }

  /** Withdraws the restart this computer asked for. */
  async cancel(): Promise<void> {
    this.cancelling = true;
    try {
      const result = UpdateApplyCancelResultSchema.safeParse(
        await this.write('core.update.apply.cancel', { component: 'desktop' }),
      );
      this.restartRequested = false;
      if (!result.success || !result.data.cancelled) {
        throw classifyError(
          new Error(
            "This computer didn't ask for the other computer's restart, so it can't cancel it. Someone at the other computer can.",
          ),
          'external.state_changed',
        );
      }
    } finally {
      this.cancelling = false;
      this.emit();
    }
  }

  private phase(): {
    phase: RemoteHostUpdatePhase;
    reason: RemoteHostUpdateReason | null;
  } {
    if (this.restarting) {
      return { phase: this.notBack ? 'not-back' : 'restarting', reason: null };
    }
    // The connection dropped without a restart; it reconnects on its own.
    if (!this.rpc || this.rpc.isClosed) {
      return { phase: 'reconnecting', reason: null };
    }
    const latest = this.latest;
    if (!latest) return { phase: 'checking', reason: null };
    if (latest.supported === false) {
      return {
        phase: 'unavailable',
        reason: DEVELOPMENT_BUILD_REASONS.has(latest.unsupportedReason ?? '')
          ? 'development-build'
          : 'manual-update',
      };
    }
    if (latest.state === 'applying')
      return { phase: 'restarting', reason: null };
    if (latest.restartPending) return { phase: 'waiting', reason: null };
    if (
      latest.remoteUpdatesAllowed === false ||
      this.stepReason === 'remote-updates-off'
    ) {
      return { phase: 'unavailable', reason: 'remote-updates-off' };
    }
    if (this.running === 'check' || latest.state === 'checking') {
      return { phase: 'checking', reason: null };
    }
    if (
      latest.state === 'downloading' ||
      (this.running === 'download' && latest.state === 'available')
    ) {
      return { phase: 'downloading', reason: null };
    }
    if (this.stepReason !== null) {
      return { phase: 'failed', reason: this.stepReason };
    }
    if (this.stepError !== null || latest.state === 'failed') {
      return { phase: 'failed', reason: this.reason };
    }
    if (this.upToDate) return { phase: 'up-to-date', reason: null };
    return { phase: 'ready', reason: this.reason };
  }

  private observe(status: UpdateComponentStatus, epoch: string | null): void {
    this.observations += 1;
    const previous = this.latest;
    this.latest = status;
    if (previous?.restartPending && !status.restartPending)
      this.withdrawals += 1;
    // The person at the host turned updates from other computers back on.
    if (
      this.stepReason === 'remote-updates-off' &&
      status.remoteUpdatesAllowed === true
    )
      this.stepReason = null;
    if (epoch !== null) this.epoch = epoch;
    this.judgeRestart(status, epoch);
    // A restart this computer asked for was withdrawn at the host.
    if (
      this.restartRequested &&
      !this.cancelling &&
      previous?.restartPending &&
      !status.restartPending &&
      status.state !== 'applying' &&
      // A failed update withdraws its restart too; it shows as a failure.
      status.state !== 'failed'
    ) {
      this.restartRequested = false;
      this.reason = 'cancelled-at-host';
    }
    for (const waiter of [...this.waiters]) {
      if (!waiter.until(status)) continue;
      this.waiters = this.waiters.filter((entry) => entry !== waiter);
      waiter.resolve(status);
    }
    this.emit();
  }

  /**
   * Decides, on the first status back, whether the host restarted while it
   * was away. Its stream epoch changes with each run, so the same epoch means
   * the connection dropped and a restart it was waiting for still waits. A
   * failed attempt the host recorded means it restarted on its old version.
   * Without either, the decision waits for a status that has them.
   */
  private judgeRestart(
    status: UpdateComponentStatus,
    epoch: string | null,
  ): void {
    const verdict = this.restartVerdict;
    if (!verdict) return;
    let restarted: boolean;
    if (epoch !== null && verdict.epoch !== null) {
      restarted = epoch !== verdict.epoch;
    } else if (status.lastAttempt) {
      restarted = true;
    } else if (epoch !== null || this.subscriptionKey === null) {
      // No epoch to compare with (none from before it went away, or a host
      // that serves no events stream), and no failed attempt recorded: a host
      // that restarted on its old version records one, so this run is the
      // same and the connection only dropped.
      restarted = false;
    } else {
      return;
    }
    this.restartVerdict = null;
    if (!restarted) return;
    this.restartRequested = false;
    this.stepError = null;
    this.stepReason = null;
    if (
      status.lastAttempt ||
      (verdict.version !== null && verdict.version === this.hello?.appVersion)
    )
      this.reason = 'restarted-without-updating';
  }

  private subscribe(rpc: RpcPeer): void {
    const key = `update-${this.newKey()}`;
    this.subscriptionKey = key;
    void rpc
      .request(REMOTE_METHODS.coreSubscribe, {
        subscriptionKey: key,
        operation: 'core.update.events',
        version: REMOTE_CORE_OPERATIONS['core.update.events'],
        params: { components: ['desktop'] },
      })
      .then((result: unknown) => {
        const parsed = CoreCallResultSchema.safeParse(result);
        if (parsed.success && parsed.data.ok) return;
        // Without the stream, read the status once so the notice is right.
        if (this.subscriptionKey === key) this.subscriptionKey = null;
        return this.readStatus().then(() => undefined);
      })
      .catch(() => undefined);
  }

  private async readStatus(): Promise<UpdateComponentStatus> {
    const result = UpdateStatusGetResultSchema.parse(
      await this.call('core.update.status.get', { components: ['desktop'] }),
    );
    const desktop = result.components.find(
      (component) => component.component === 'desktop',
    );
    if (!desktop) {
      throw classifyError(
        new Error("The other computer didn't report its update status."),
        'external.state_changed',
      );
    }
    this.observe(desktop, null);
    return desktop;
  }

  private waitFor(
    until: (status: UpdateComponentStatus) => boolean,
  ): Promise<UpdateComponentStatus> {
    const latest = this.latest;
    if (latest && until(latest)) return Promise.resolve(latest);
    if (!this.rpc || this.rpc.isClosed) {
      return Promise.reject(new HostUpdateSessionClosedError());
    }
    return new Promise((resolve, reject) => {
      // The stream should deliver; a silent one must not leave this waiting
      // until the session closes.
      const poll = setInterval(() => {
        this.readStatus().catch(() => undefined);
      }, this.options.statusPollMs ?? STATUS_POLL_MS);
      poll.unref?.();
      this.waiters.push({
        until,
        resolve: (status) => {
          clearInterval(poll);
          resolve(status);
        },
        reject: (error) => {
          clearInterval(poll);
          reject(error);
        },
      });
    });
  }

  /**
   * A write the host may rate-limit: it says how long to wait, and the
   * retry keeps the same key so the host never runs it twice.
   */
  private async write(
    operation: RemoteCoreOperation,
    params: unknown,
    /** Checked before each retry; false stops it, as when the host withdrew. */
    stillWanted?: () => boolean,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.observationsAtWrite = this.observations;
        return await this.call(operation, params);
      } catch (error) {
        const retry =
          error instanceof HostUpdateRefusedError &&
          error.failure.kind === 'resource_exhausted' &&
          error.failure.retry?.kind === 'same_idempotency_key'
            ? error.failure.retry
            : null;
        if (!retry || attempt >= RATE_LIMIT_RETRIES) throw error;
        const delayMs = retry.delayMs ?? 10_000;
        await (this.options.sleep ?? defaultSleep)(Math.min(delayMs, 15_000));
        if (this.disposed) throw new HostUpdateSessionClosedError();
        if (stillWanted && !stillWanted()) throw new HostUpdateWithdrawnError();
      }
    }
  }

  private async call(
    operation: RemoteCoreOperation,
    params: unknown,
  ): Promise<unknown> {
    const rpc = this.rpc;
    if (!rpc || rpc.isClosed) throw new HostUpdateSessionClosedError();
    const result = CoreCallResultSchema.parse(
      await rpc.request(REMOTE_METHODS.coreCall, {
        operation,
        version: REMOTE_CORE_OPERATIONS[operation],
        params,
      }),
    );
    if (!result.ok) throw new HostUpdateRefusedError(result.error);
    return result.result;
  }

  private newKey(): string {
    return (this.options.newKey ?? randomUUID)();
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private emit(): void {
    if (!this.disposed) this.options.onChange();
  }
}
