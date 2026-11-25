import {
  INITIAL_BACKGROUND_SERVICE_STATUS,
  type BackgroundServiceConsumer,
  type BackgroundServiceHandoffFailure,
  type BackgroundServiceStatus,
  type BackgroundServiceUnreachableReason,
} from '@canopy/desktop-shared/lib/background-service-status';
import {
  logMainProcessInfo,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import type { ElectronDaemonReachability } from './electron-daemon-connection';

/**
 * Main's one record of whether the local background service can be reached
 * (CAN-5541), fed by the Electron daemon connection service and shared by
 * every consumer that reads through it. An interface-host adapter: no core
 * operation reports that the core itself can't be reached.
 */
export interface ElectronDaemonHealth {
  getStatus(): BackgroundServiceStatus;
  /** Completed outage/reconnect cycles; startup maintenance can re-arm lazily. */
  getRecoverySequence(): number;
  /** Returns its unsubscribe. Listeners see each change once, in order. */
  onStatusChanged(
    listener: (status: BackgroundServiceStatus) => void,
  ): () => void;
  /** The connection service's `onReachability`. */
  observe(event: ElectronDaemonReachability): void;
  /**
   * Whether a consumer currently reads through the service. With none,
   * connection events are ignored, but a failure already shown stays: a
   * closed lease is not proof the service recovered (CAN-7061). Only a reach
   * clears it; a hidden reconnect ends with its last lease.
   */
  setConsumerEnabled(
    consumer: BackgroundServiceConsumer,
    enabled: boolean,
  ): void;
  /**
   * One bounded Try again; concurrent calls share it. A no-op after `stop`,
   * once a restart is required, or with no enabled consumer and nothing
   * shown. `attempt` resolves true only when it holds a live lease: a reused
   * session can still be reconnecting.
   */
  retry(attempt: () => Promise<boolean>): Promise<BackgroundServiceStatus>;
  /**
   * An enabled consumer served a read in-process because the service
   * couldn't be reached. Shows the warning even when no connection event
   * did, and latches like that event would. A lost connection never shows
   * on its own: only its restart failing does.
   */
  noteFallback(
    consumer: BackgroundServiceConsumer,
    reason: BackgroundServiceUnreachableReason,
  ): void;
  /**
   * Whether consumers should skip contacting the service: a start, attach,
   * host or reconnect failure since the last reach. Spares each read a
   * respawn and up to a setup timeout. Try again lifts it while it runs; a
   * failed one re-arms it unless the service was reached meanwhile.
   */
  isLatched(): boolean;
  /**
   * A degraded startup handoff can recover only on the next app launch.
   * Shown at once, before any consumer such as Files is enabled, with the
   * handoff's failure code for diagnostics.
   */
  requireRestart(handoff: BackgroundServiceHandoffFailure): void;
  /** Recovery handoff: one-way latch; no Try again or late reach can lift it. */
  beginRecovery(): void;
  /** Quit: ignores every later event and retry. */
  stop(): void;
}

/** Failures a new attempt would only repeat; a lost session is not one. */
const LATCHING_REASONS: ReadonlySet<BackgroundServiceUnreachableReason> =
  new Set<BackgroundServiceUnreachableReason>([
    'start_failed',
    'endpoint_repair_required',
    'connect_timeout',
    'host_unavailable',
    'reconnect_failed',
  ]);

export interface ElectronDaemonHealthLog {
  /** Reason codes only, never an error message: those can name authorities. */
  warn(
    message: string,
    context: { reason: BackgroundServiceUnreachableReason },
  ): void;
  info(message: string): void;
}

export function createElectronDaemonHealth(
  log: ElectronDaemonHealthLog,
): ElectronDaemonHealth {
  let status: BackgroundServiceStatus = INITIAL_BACKGROUND_SERVICE_STATUS;
  const listeners = new Set<(status: BackgroundServiceStatus) => void>();
  const consumers = new Set<BackgroundServiceConsumer>();
  let retrying: Promise<BackgroundServiceStatus> | undefined;
  let stopped = false;
  let latched = false;
  let reaches = 0;
  let recoveries = 0;
  let restartRequired = false;
  let handoffFailure: BackgroundServiceHandoffFailure | undefined;
  /** The first latched failure kept hidden by the current `reconnecting`. */
  let hiddenReason: BackgroundServiceUnreachableReason | undefined;

  const update = (
    state: BackgroundServiceStatus['state'],
    retry: BackgroundServiceStatus['retry'],
    reason?: BackgroundServiceUnreachableReason,
  ): void => {
    if (state !== 'reconnecting') hiddenReason = undefined;
    const recovery =
      state === 'unavailable' && restartRequired ? 'restart_app' : undefined;
    const handoff = recovery ? handoffFailure : undefined;
    if (
      state === status.state &&
      reason === status.reason &&
      retry === status.retry &&
      recovery === status.recovery &&
      handoff === status.handoff
    )
      return;
    const previous = status;
    status = {
      state,
      ...(reason && { reason }),
      retry,
      ...(recovery && { recovery }),
      ...(handoff && { handoff }),
      sequence: previous.sequence + 1,
    };
    if (status.reason && status.reason !== previous.reason)
      log.warn('Background service unavailable', { reason: status.reason });
    else if (previous.state === 'unavailable' && status.state === 'ok')
      log.info('Background service reachable again');
    for (const listener of Array.from(listeners)) {
      try {
        listener(status);
      } catch {
        // A failing listener never blocks the others or the connection.
      }
    }
  };
  const holdForRestart = (): void => {
    latched = true;
    update(
      'unavailable',
      'idle',
      status.reason === 'endpoint_repair_required'
        ? status.reason
        : 'start_failed',
    );
  };
  // Connection events count while a consumer depends on them or Try again runs.
  const tracking = (): boolean => consumers.size > 0 || retrying !== undefined;
  const reached = (): void => {
    // A late connection cannot repair the already-settled W5 handoff.
    if (restartRequired) return holdForRestart();
    if (status.state !== 'ok') recoveries += 1;
    reaches += 1;
    latched = false;
    update('ok', 'idle');
  };
  /**
   * Whether `reason` replaces the shown status. Later attach failures don't
   * prove the blocking files were repaired, so the repair command stays
   * until reached() clears it. Outside Try again, which reports its own
   * attempt, a lost daemon is the lease's to diagnose: another session's
   * attach failing during the restart, or after the lease gave up, only
   * latches. Its first latched diagnosis otherwise stays.
   */
  const replacesShown = (
    reason: BackgroundServiceUnreachableReason,
  ): boolean => {
    if (status.reason === 'endpoint_repair_required') return false;
    if (
      reason === 'endpoint_repair_required' ||
      reason === 'reconnect_failed' ||
      retrying !== undefined
    )
      return true;
    if (status.state === 'reconnecting') return false;
    return status.reason === undefined || !LATCHING_REASONS.has(status.reason);
  };
  const latch = (reason: BackgroundServiceUnreachableReason): void => {
    if (!LATCHING_REASONS.has(reason)) return;
    latched = true;
    if (status.state === 'reconnecting') hiddenReason ??= reason;
  };
  const unreachable = (reason: BackgroundServiceUnreachableReason): void => {
    latch(reason);
    if (replacesShown(reason)) update('unavailable', status.retry, reason);
  };

  return {
    getStatus: () => status,
    getRecoverySequence: () => recoveries,
    onStatusChanged(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    observe(event): void {
      if (stopped || !tracking()) return;
      switch (event.kind) {
        case 'reached':
          return reached();
        case 'lost':
          // Hidden while the lease restarts the daemon (a crash, an idle
          // exit): Mike, q-13 GA3-1. The lease giving up reports
          // `reconnect_failed`: at once for a failure it never retries, by
          // its 30 s delivery bound for a retried or hung one.
          if (status.state === 'ok') update('reconnecting', status.retry);
          return;
        case 'abandoned':
          // No lease is left to finish the restart it was hiding: show what
          // latched meanwhile, else as when the last consumer turns off.
          if (status.state !== 'reconnecting') return;
          if (!latched) return reached();
          return update(
            'unavailable',
            status.retry,
            hiddenReason ?? 'reconnect_failed',
          );
        case 'unreachable':
          return unreachable(event.reason);
      }
    },
    noteFallback(consumer, reason): void {
      if (stopped || !consumers.has(consumer)) return;
      latch(reason);
      // A real loss reported `lost` first, so the restart decides; from `ok`,
      // the session closed on its own or the lease already replaced it.
      if (reason === 'connection_lost') return;
      // The connection event usually came first; its reason stays.
      if (status.state !== 'unavailable' && replacesShown(reason))
        update('unavailable', status.retry, reason);
    },
    isLatched: () => latched,
    requireRestart(handoff): void {
      if (stopped) return;
      restartRequired = true;
      // The handoff settles once per launch; its first code stays.
      handoffFailure ??= handoff;
      // The failed handoff already closed its lease; Files may never open.
      holdForRestart();
    },
    beginRecovery(): void {
      latched = true;
      stopped = true;
    },
    setConsumerEnabled(consumer, enabled): void {
      if (enabled) consumers.add(consumer);
      else consumers.delete(consumer);
      if (stopped) return;
      if (restartRequired) holdForRestart();
      // No lease is left to finish the restart it was hiding.
      else if (consumers.size === 0 && status.state === 'reconnecting')
        reached();
    },
    retry(attempt): Promise<BackgroundServiceStatus> {
      if (
        stopped ||
        restartRequired ||
        (consumers.size === 0 && status.state !== 'unavailable')
      )
        return Promise.resolve(status);
      if (retrying) return retrying;
      const wasLatched = latched;
      const reachesBefore = reaches;
      latched = false;
      update(status.state, 'running', status.reason);
      const run = (async (): Promise<BackgroundServiceStatus> => {
        let live = false;
        try {
          // Deferred, so `retrying` is set before even a synchronous throw ends it.
          live = await Promise.resolve().then(() =>
            restartRequired ? false : attempt(),
          );
        } catch {
          // The attempt's own unreachable event already set the reason; a
          // refusal from a reached service leaves nothing to show.
        }
        retrying = undefined;
        if (stopped || restartRequired) return status;
        if (live) reached();
        else {
          if (wasLatched && reaches === reachesBefore) latched = true;
          update(
            status.state,
            status.state === 'unavailable' ? 'failed' : 'idle',
            status.reason,
          );
        }
        return status;
      })();
      retrying = run;
      return run;
    },
    stop(): void {
      stopped = true;
    },
  };
}

let health: ElectronDaemonHealth | undefined;

/** The one record every consumer of the Electron daemon connections shares. */
export function getElectronDaemonHealth(): ElectronDaemonHealth {
  health ??= createElectronDaemonHealth({
    warn: logMainProcessWarn,
    info: logMainProcessInfo,
  });
  return health;
}
