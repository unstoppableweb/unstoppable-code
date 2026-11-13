/**
 * Per-owner notification admission for one shared Codex app-server stdout.
 *
 * A pooled app-server multiplexes many owners (one per chat client or thread
 * handle) over a single ordered JSON-RPC stdout. An owner may return an
 * admission promise from a delivered notification (the desktop chat client
 * returns its durable canonical commit). Later transcript frames for that
 * owner wait for admission, but other owners and protocol control do not.
 *
 * The connection reads and routes every frame in pipe order, then hands each
 * transcript frame to `dispatch()`; responses, server requests and control
 * notifications bypass these lanes:
 *
 * - An owner with no pending admission and nothing queued receives the frame
 *   synchronously, exactly as before.
 * - Otherwise the frame joins that owner's FIFO lane and is delivered after
 *   every earlier admission for the owner has settled. A frame fanned out to
 *   several owners is dispatched to each lane separately, so it keeps its
 *   position in every recipient's order.
 * - The connection opts into `perOwnerRetention`: wire bytes above the
 *   owner's soft high water trigger full-snapshot coalescing, until that
 *   owner reaches low water. Only an owner still exceeding its hard limit
 *   after coalescing pauses the shared source, as a last-resort OOM guard.
 *   The primitive's legacy aggregate cap remains available without opt-in.
 * - A retired owner's lane stops holding and drains on a microtask; owners
 *   that are no longer live never hold a lane.
 * - `discardAll()` drops every queued frame when the worker goes away.
 *
 * Admissions that stay pending for `longHoldThresholdMs`, and source pauses
 * that last that long, produce one rate-limited warning line and one
 * content-free report: durations, frame counts and bytes only. An owner's
 * duration is that of one admission, never of the span over which the owner
 * had some admission pending: under an in-flight budget a busy owner's
 * admissions overlap, and it is reported only when one of them was slow.
 * A hard-limit fallback always warns immediately and reports on release or
 * discard, even when short. Diagnostics never contain owner identity/content.
 *
 * Per-owner in-flight budget (`ownerInFlight`, off by default). The desktop
 * app supplies one while its chat storage group-commits: several commits of
 * one chat can then be in flight together, so an owner's lane may deliver
 * further notifications while earlier admissions are pending, in pipe order,
 * up to a bound on the wire bytes and the frames whose admissions are
 * pending. Only frames marked `overlap` are delivered that way. Explicit
 * barriers in the primitive wait for every pending admission; the connection
 * never submits protocol control as a barrier. Bytes in flight count toward
 * the selected retention cap (per owner with opt-in, aggregate otherwise).
 * Without a budget, one admission is pending per owner at a time.
 */

export type OwnerLaneFrameKind = 'notification' | 'response' | 'server-request';

export type CodexIngestionLagSource = 'provider' | 'receipt';

export interface CodexIngestionLagSnapshot {
  lagMs: number;
  catchingUp: boolean;
  source: CodexIngestionLagSource;
}

export interface CodexIngestionLagSample {
  lagMs: number;
  source: CodexIngestionLagSource;
  sampledAtMs: number;
  catchingUp: boolean;
}

export interface CodexIngestionLagChange {
  outcome: 'entered' | 'drained' | 'aborted';
  lagMs: number;
  peakLagMs: number;
  episodeMs: number;
  thresholdMs: number;
  source: CodexIngestionLagSource;
}

export interface OwnerLaneFrame {
  kind: OwnerLaneFrameKind;
  /**
   * Provider lifecycle time in Unix milliseconds, when this frame has one.
   * Invalid or future times are ignored in favor of lane receipt time.
   */
  producedAtMs?: number;
  /**
   * Frames with the same key are full snapshots of one value: a later one
   * replaces an earlier one still queued. Never set for deltas.
   */
  coalesceKey?: string;
  /**
   * A notification that may be delivered while earlier admissions of its
   * owner are pending, when a per-owner in-flight budget applies.
   */
  overlap?: boolean;
  /**
   * Wire size of the frame; only called when the frame is retained, or
   * while a per-owner in-flight budget applies.
   */
  measureBytes(): number;
  /**
   * Delivers the frame to its owner. A returned promise is that owner's
   * admission for the frame: later frames for the owner wait for it.
   */
  deliver(): void | Promise<void>;
}

export type StdoutHoldKind = 'owner-admission' | 'stdout-byte-cap';

/**
 * `released`: the admission settled or the byte cap drained. `detached`: the
 * owner was retired while its admission was pending. `failed`: the admission
 * rejected (connection-fatal). `discarded`: the worker went away.
 */
export type StdoutHoldOutcome =
  | 'released'
  | 'detached'
  | 'failed'
  | 'discarded';

export interface StdoutHoldReport {
  holdKind: StdoutHoldKind;
  holdOutcome: StdoutHoldOutcome;
  holdDurationMs: number;
  /** Peak retained frames during the hold (that owner, or all owners). */
  queuedFrameCount: number;
  /** Peak retained wire bytes during the hold (that owner, or all owners). */
  queuedFrameBytes: number;
  /** Whether a JSON-RPC response was retained during the hold. */
  responseQueued: boolean;
}

export interface OwnerAdmissionLanesHost<TOwner> {
  /** Owners that are not live (retired or unregistered) never hold a lane. */
  isLiveOwner(owner: TOwner): boolean;
  pauseSource(): void;
  resumeSource(): void;
  /** Called when the byte-cap pause starts (`true`) or ends (`false`). */
  onSourcePauseChange(paused: boolean): void;
  /** An owner admission rejected while it held its lane. */
  onAdmissionFailure(error: Error): void;
  /** Delivering a queued frame threw synchronously. */
  onDeliveryFailure(error: Error): void;
  reportLongHold(report: StdoutHoldReport): void;
  warnLongHold(message: string): void;
  /** Reporting is observational and must not affect owner admission. */
  onIngestionLagChange?(owner: TOwner, change: CodexIngestionLagChange): void;
  /** Periodic lag samples are observational and must not affect admission. */
  onIngestionLagSample?(owner: TOwner, sample: CodexIngestionLagSample): void;
}

/** What one owner may have delivered and not yet admitted. */
export interface OwnerInFlightBudget {
  /** Wire bytes of the frames whose admissions are pending. */
  bytes: number;
  /** Frames whose admissions are pending. */
  frames: number;
}

export interface OwnerAdmissionLanesLimits {
  highWaterBytes: number;
  lowWaterBytes: number;
  longHoldThresholdMs: number;
  /**
   * Explicit opt-in to per-owner retention. high/low water become the owner's
   * snapshot-coalescing hysteresis, not shared-source pause thresholds. Only
   * an owner exceeding hardLimitBytes after coalescing pauses the source.
   * Absent: preserve the primitive's legacy aggregate high/low byte cap.
   */
  perOwnerRetention?: { hardLimitBytes: number };
  /**
   * The per-owner in-flight budget in force now, read at each delivery
   * decision. Absent or undefined: one pending admission per owner.
   */
  ownerInFlight?: () => OwnerInFlightBudget | undefined;
}

/**
 * Rejects the drains of an owner whose retained frames were dropped with
 * their worker. The connection caused it, so it is never a new failure.
 */
export class TranscriptAdmissionDiscardedError extends Error {
  constructor() {
    super('Codex transcript admission discarded');
    this.name = 'TranscriptAdmissionDiscardedError';
  }
}

/**
 * Coalesce snapshots at 8 MiB per owner, returning to ordinary FIFO below
 * 4 MiB. 64 MiB leaves headroom for lossless deltas/output while bounding a
 * single stalled owner's retention without creating a second canonical store.
 */
export const DEFAULT_OWNER_LANE_HIGH_WATER_BYTES = 8 * 1024 * 1024;
export const DEFAULT_OWNER_LANE_LOW_WATER_BYTES = 4 * 1024 * 1024;
export const DEFAULT_OWNER_LANE_HARD_LIMIT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_LONG_STDOUT_HOLD_THRESHOLD_MS = 5_000;
export const DEFAULT_INGESTION_LAG_THRESHOLD_MS = 5_000;
const LONG_HOLD_WARNING_WINDOW_MS = 30_000;
const MAX_LONG_HOLD_WATCH_INTERVAL_MS = 1_000;
const INGESTION_LAG_SAMPLE_INTERVAL_MS = 1_000;
const QUEUE_COMPACTION_THRESHOLD = 1_024;

interface QueuedFrame {
  // Coalesced slots are tombstones, with their payload released immediately.
  frame: OwnerLaneFrame | undefined;
  bytes: number;
  /** Order in which the frame reached its owner's lane. */
  seq: number;
  producedAtMs: number;
  source: CodexIngestionLagSource;
  previousLive: QueuedFrame | null;
  nextLive: QueuedFrame | null;
}

interface FrameTiming {
  producedAtMs: number;
  source: CodexIngestionLagSource;
}

interface HoldStats {
  startedAt: number;
  peakFrames: number;
  peakBytes: number;
  responseQueued: boolean;
  warned: boolean;
}

/** One delivered frame's admission, from its delivery until it settles. */
interface PendingAdmission {
  startedAt: number;
  /** The frame's order in its owner's lane. */
  seq: number;
  producedAtMs: number;
  source: CodexIngestionLagSource;
}

interface IngestionLagEpisode {
  startedAt: number;
  peakLagMs: number;
  source: CodexIngestionLagSource;
}

/** Waits until every frame up to `throughSeq` is delivered and admitted. */
interface DrainWaiter {
  throughSeq: number;
  resolve(): void;
  reject(error: Error): void;
}

/**
 * One owner's hold: from its first pending admission to its last.
 * `startedAt` is when the oldest admission still pending was delivered.
 */
interface OwnerHold extends HoldStats {
  /** The pending admissions, oldest first. */
  admissions: Set<PendingAdmission>;
  /**
   * The longest an admission of this hold took to settle since the last
   * report; a long hold is one slow admission, not a busy owner.
   */
  longestSettledMs: number;
  /** Admissions pending for this hold; always 1 without a budget. */
  pending: number;
  /** Wire bytes of the frames those admissions belong to (budget only). */
  pendingBytes: number;
  /** A pending admission belongs to a frame that may not overlap. */
  exclusive: boolean;
}

interface Lane<TOwner> {
  owner: TOwner;
  queue: QueuedFrame[];
  head: number;
  oldestQueued: QueuedFrame | null;
  newestQueued: QueuedFrame | null;
  queuedBytes: number;
  queuedFrames: number;
  coalescing: boolean;
  snapshots: Map<string, QueuedFrame>;
  hardPaused: boolean;
  /** Sequence of the latest frame that reached this lane. */
  lastSeq: number;
  drainWaiters: Set<DrainWaiter>;
  queuedResponses: number;
  hold: OwnerHold | null;
  ingestionLagEpisode: IngestionLagEpisode | null;
  lastIngestionLagSampledAtMs: number | null;
  retired: boolean;
  drainScheduled: boolean;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

export class OwnerAdmissionLanes<TOwner> {
  private readonly lanes = new Map<TOwner, Lane<TOwner>>();
  private queuedBytes = 0;
  /** Wire bytes delivered under a budget whose admissions are pending. */
  private inFlightBytes = 0;
  private queuedFrames = 0;
  private queuedResponses = 0;
  private sourcePause: HoldStats | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private warningWindowStartedAt = Number.NEGATIVE_INFINITY;
  private suppressedWarnings = 0;

  constructor(
    private readonly host: OwnerAdmissionLanesHost<TOwner>,
    private readonly limits: OwnerAdmissionLanesLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Delivers `frame` to `owner` now, or retains it behind the owner's pending
   * admission. Synchronous delivery errors propagate to the caller.
   */
  dispatch(owner: TOwner, frame: OwnerLaneFrame): void {
    const timing = this.frameTiming(frame, this.now());
    const lane = this.lanes.get(owner);
    if (lane) {
      lane.lastSeq += 1;
      // Behind a retained frame every later frame keeps its place.
      if (lane.head < lane.queue.length || !this.mayOverlap(lane, frame)) {
        this.enqueue(lane, frame, lane.lastSeq, timing);
        return;
      }
      const overlapping = frame.deliver();
      if (overlapping)
        this.beginHold(owner, lane, overlapping, frame, lane.lastSeq, timing);
      this.updateIngestionLag(lane, this.now());
      this.updateSourcePressure();
      return;
    }
    const admission = frame.deliver();
    if (admission) {
      this.beginHold(owner, null, admission, frame, undefined, timing);
      this.updateSourcePressure();
    }
  }

  /**
   * Whether `frame` may be delivered while the lane's earlier admissions
   * are pending: only under a budget, only a frame marked for it, only
   * beside admissions of frames marked for it, and within the budget.
   */
  private mayOverlap(
    lane: Lane<TOwner>,
    frame: OwnerLaneFrame,
    measuredBytes?: number,
  ): boolean {
    const hold = lane.hold;
    if (!hold || hold.exclusive || lane.retired) return false;
    if (frame.kind !== 'notification' || frame.overlap !== true) return false;
    const budget = this.limits.ownerInFlight?.();
    if (!budget || hold.pending >= budget.frames) return false;
    const bytes = measuredBytes ?? Math.max(0, frame.measureBytes());
    return hold.pendingBytes + bytes <= budget.bytes;
  }

  /** Whether a frame dispatched to `owner` now would be retained. */
  isBusy(owner: TOwner): boolean {
    return this.lanes.has(owner);
  }

  /**
   * Reads the live oldest-frame lag for a registered owner. A registered
   * owner with no outstanding transcript has a zero receipt-based snapshot.
   */
  ingestionLag(owner: TOwner): CodexIngestionLagSnapshot | undefined {
    if (!this.host.isLiveOwner(owner)) return undefined;
    const lane = this.lanes.get(owner);
    if (!lane || lane.retired)
      return { lagMs: 0, catchingUp: false, source: 'receipt' };
    const now = this.now();
    this.updateIngestionLag(lane, now);
    const oldest = this.oldestOutstandingFrame(lane);
    if (!oldest) return { lagMs: 0, catchingUp: false, source: 'receipt' };
    return {
      lagMs: this.frameLagMs(oldest, now),
      catchingUp: lane.ingestionLagEpisode !== null,
      source: oldest.source,
    };
  }

  isSourcePaused(): boolean {
    return this.sourcePause !== null;
  }

  /** Whether frames already read for `owner` wait in its lane, undelivered. */
  hasQueuedFrames(owner: TOwner): boolean {
    const lane = this.lanes.get(owner);
    return lane !== undefined && lane.head < lane.queue.length;
  }

  /**
   * Settles once every frame that has reached `owner`'s lane so far is
   * delivered and admitted; frames that arrive later do not extend it. A
   * terminal control frame uses it to follow the transcript read before it
   * without being retained in the lane. Undefined when nothing is retained or
   * pending for the owner. Rejects when an admission fails or the worker goes
   * away.
   */
  whenDrained(owner: TOwner): Promise<void> | undefined {
    const lane = this.lanes.get(owner);
    if (!lane) return undefined;
    const throughSeq = lane.lastSeq;
    const drained = new Promise<void>((resolve, reject) => {
      lane.drainWaiters.add({ throughSeq, resolve, reject });
    });
    // A caller may return without observing the drain; its rejection must
    // never surface as an unhandled rejection.
    void drained.catch(() => undefined);
    this.settleDrainWaiters(lane);
    return drained;
  }

  /**
   * Stops waiting for a retired owner's admission. Frames already retained
   * for it are delivered on a microtask, in order, without holding again.
   */
  retire(owner: TOwner): void {
    const lane = this.lanes.get(owner);
    if (!lane) return;
    lane.retired = true;
    this.abortIngestionLagEpisode(lane);
    const hold = lane.hold;
    if (hold) {
      lane.hold = null;
      this.inFlightBytes -= hold.pendingBytes;
      this.finishOwnerHold('detached', hold);
    }
    this.scheduleDrain(lane);
  }

  /**
   * Drops every retained frame and pending hold (the worker is going away).
   * Returns whether any owner lane or source pause was active, in which case
   * the caller should stop reading the old source entirely.
   */
  discardAll(): boolean {
    const hadActiveLanes = this.lanes.size > 0;
    for (const lane of Array.from(this.lanes.values())) {
      this.abortIngestionLagEpisode(lane);
      const hold = lane.hold;
      lane.hold = null;
      if (hold) this.finishOwnerHold('discarded', hold);
      for (const waiter of Array.from(lane.drainWaiters))
        waiter.reject(new TranscriptAdmissionDiscardedError());
      lane.drainWaiters.clear();
    }
    this.lanes.clear();
    this.queuedBytes = 0;
    this.inFlightBytes = 0;
    this.queuedFrames = 0;
    this.queuedResponses = 0;
    const pause = this.sourcePause;
    this.sourcePause = null;
    if (pause) {
      this.host.onSourcePauseChange(false);
      this.finishHold(
        'stdout-byte-cap',
        'discarded',
        pause,
        this.now() - pause.startedAt,
        Boolean(this.limits.perOwnerRetention),
      );
    }
    this.stopWatch();
    return hadActiveLanes || pause !== null;
  }

  private createLane(owner: TOwner): Lane<TOwner> {
    const lane: Lane<TOwner> = {
      owner,
      queue: [],
      head: 0,
      oldestQueued: null,
      newestQueued: null,
      queuedBytes: 0,
      queuedFrames: 0,
      coalescing: false,
      snapshots: new Map(),
      hardPaused: false,
      lastSeq: 0,
      drainWaiters: new Set(),
      queuedResponses: 0,
      hold: null,
      ingestionLagEpisode: null,
      lastIngestionLagSampledAtMs: null,
      retired: false,
      drainScheduled: false,
    };
    this.lanes.set(owner, lane);
    return lane;
  }

  private beginHold(
    owner: TOwner,
    existingLane: Lane<TOwner> | null,
    admission: Promise<void>,
    frame: OwnerLaneFrame,
    seq: number | undefined,
    timing: FrameTiming,
    measuredBytes?: number,
  ): void {
    if (existingLane?.retired === true || !this.host.isLiveOwner(owner)) {
      // Matches a detached receipt: the owner is gone, so nothing waits for
      // it and a late rejection is not connection-fatal.
      void Promise.resolve(admission).catch(() => undefined);
      return;
    }
    const lane = existingLane ?? this.createLane(owner);
    // A frame delivered with no lane opens one as its first frame.
    const admissionSeq = seq ?? (lane.lastSeq += 1);
    // Frames in flight are charged only while a budget lets them overlap.
    const bytes = this.limits.ownerInFlight?.()
      ? (measuredBytes ?? Math.max(0, frame.measureBytes()))
      : 0;
    const pendingAdmission: PendingAdmission = {
      startedAt: this.now(),
      seq: admissionSeq,
      producedAtMs: timing.producedAtMs,
      source: timing.source,
    };
    let hold = lane.hold;
    if (!hold) {
      hold = {
        startedAt: pendingAdmission.startedAt,
        peakFrames: lane.queuedFrames,
        peakBytes: lane.queuedBytes,
        responseQueued: lane.queuedResponses > 0,
        warned: false,
        admissions: new Set(),
        longestSettledMs: 0,
        pending: 0,
        pendingBytes: 0,
        exclusive: false,
      };
      lane.hold = hold;
      this.ensureWatch();
    }
    const current = hold;
    current.admissions.add(pendingAdmission);
    current.pending += 1;
    current.pendingBytes += bytes;
    this.inFlightBytes += bytes;
    if (frame.kind !== 'notification' || frame.overlap !== true)
      current.exclusive = true;
    this.updateIngestionLag(lane, this.now());
    Promise.resolve(admission).then(
      () => {
        if (lane.hold !== current) return;
        current.pending -= 1;
        current.pendingBytes -= bytes;
        this.inFlightBytes -= bytes;
        this.settleAdmission(lane, current, pendingAdmission);
        this.updateIngestionLag(lane, this.now());
        if (this.lanes.get(owner) === lane) this.drain(lane);
        else this.updateSourcePressure();
      },
      (error: unknown) => {
        if (lane.hold !== current) return;
        this.abortIngestionLagEpisode(lane);
        lane.hold = null;
        this.inFlightBytes -= current.pendingBytes;
        this.finishOwnerHold('failed', current);
        for (const waiter of Array.from(lane.drainWaiters))
          waiter.reject(toError(error));
        lane.drainWaiters.clear();
        if (this.lanes.get(owner) !== lane) return;
        this.host.onAdmissionFailure(toError(error));
      },
    );
  }

  /**
   * One admission of `hold` settled. The hold ends with its last admission.
   * While others stay pending, the hold is measured from the oldest of them,
   * and a slow admission is reported once nothing older than the threshold
   * remains, so admissions that stalled together produce one report.
   */
  private settleAdmission(
    lane: Lane<TOwner>,
    hold: OwnerHold,
    settled: PendingAdmission,
  ): void {
    const now = this.now();
    hold.admissions.delete(settled);
    hold.longestSettledMs = Math.max(
      hold.longestSettledMs,
      now - settled.startedAt,
    );
    const oldest = this.oldestAdmission(hold);
    if (!oldest) {
      lane.hold = null;
      this.finishHold(
        'owner-admission',
        'released',
        hold,
        hold.longestSettledMs,
      );
      return;
    }
    hold.startedAt = oldest.startedAt;
    const threshold = this.limits.longHoldThresholdMs;
    if (hold.longestSettledMs < threshold) return;
    if (now - oldest.startedAt >= threshold) return;
    this.finishHold('owner-admission', 'released', hold, hold.longestSettledMs);
    // The owner stays held: later admissions start a new measurement.
    hold.longestSettledMs = 0;
    hold.warned = false;
    hold.peakFrames = lane.queuedFrames;
    hold.peakBytes = lane.queuedBytes;
    hold.responseQueued = lane.queuedResponses > 0;
  }

  private oldestAdmission(hold: OwnerHold): PendingAdmission | undefined {
    const first = hold.admissions.values().next();
    return first.done === true ? undefined : first.value;
  }

  private frameTiming(
    frame: OwnerLaneFrame,
    receivedAtMs: number,
  ): FrameTiming {
    const providerTime = frame.producedAtMs;
    if (
      typeof providerTime === 'number' &&
      Number.isFinite(providerTime) &&
      providerTime > 0 &&
      providerTime <= receivedAtMs
    ) {
      return { producedAtMs: providerTime, source: 'provider' };
    }
    return { producedAtMs: receivedAtMs, source: 'receipt' };
  }

  private oldestOutstandingFrame(
    lane: Lane<TOwner>,
  ): PendingAdmission | QueuedFrame | undefined {
    const pending = lane.hold ? this.oldestAdmission(lane.hold) : undefined;
    const queued = lane.oldestQueued ?? undefined;
    if (!pending) return queued;
    if (!queued) return pending;
    return pending.seq <= queued.seq ? pending : queued;
  }

  private frameLagMs(
    frame: PendingAdmission | QueuedFrame,
    now: number,
  ): number {
    return Math.max(0, now - frame.producedAtMs);
  }

  private updateIngestionLag(lane: Lane<TOwner>, now: number): void {
    if (lane.retired) return;
    const oldest = this.oldestOutstandingFrame(lane);
    const episode = lane.ingestionLagEpisode;
    if (!oldest) {
      if (!episode) return;
      lane.ingestionLagEpisode = null;
      this.reportIngestionLagChange(lane.owner, {
        outcome: 'drained',
        lagMs: 0,
        peakLagMs: episode.peakLagMs,
        episodeMs: Math.max(0, now - episode.startedAt),
        thresholdMs: DEFAULT_INGESTION_LAG_THRESHOLD_MS,
        source: episode.source,
      });
      this.reportIngestionLagSample(lane.owner, {
        lagMs: 0,
        source: episode.source,
        sampledAtMs: now,
        catchingUp: false,
      });
      lane.lastIngestionLagSampledAtMs = null;
      return;
    }

    const lagMs = this.frameLagMs(oldest, now);
    if (!episode) {
      if (lagMs <= DEFAULT_INGESTION_LAG_THRESHOLD_MS) return;
      lane.ingestionLagEpisode = {
        startedAt: now,
        peakLagMs: lagMs,
        source: oldest.source,
      };
      this.reportIngestionLagChange(lane.owner, {
        outcome: 'entered',
        lagMs,
        peakLagMs: lagMs,
        episodeMs: 0,
        thresholdMs: DEFAULT_INGESTION_LAG_THRESHOLD_MS,
        source: oldest.source,
      });
      lane.lastIngestionLagSampledAtMs = now;
      this.reportIngestionLagSample(lane.owner, {
        lagMs,
        source: oldest.source,
        sampledAtMs: now,
        catchingUp: true,
      });
      return;
    }

    episode.peakLagMs = Math.max(episode.peakLagMs, lagMs);
    episode.source = oldest.source;
  }

  private abortIngestionLagEpisode(lane: Lane<TOwner>): void {
    const episode = lane.ingestionLagEpisode;
    if (!episode) return;
    const now = this.now();
    const oldest = this.oldestOutstandingFrame(lane);
    lane.ingestionLagEpisode = null;
    lane.lastIngestionLagSampledAtMs = null;
    this.reportIngestionLagChange(lane.owner, {
      outcome: 'aborted',
      lagMs: oldest ? this.frameLagMs(oldest, now) : 0,
      peakLagMs: episode.peakLagMs,
      episodeMs: Math.max(0, now - episode.startedAt),
      thresholdMs: DEFAULT_INGESTION_LAG_THRESHOLD_MS,
      source: oldest?.source ?? episode.source,
    });
    this.reportIngestionLagSample(lane.owner, {
      lagMs: oldest ? this.frameLagMs(oldest, now) : 0,
      source: oldest?.source ?? episode.source,
      sampledAtMs: now,
      catchingUp: false,
    });
  }

  private reportIngestionLagChange(
    owner: TOwner,
    change: CodexIngestionLagChange,
  ): void {
    try {
      this.host.onIngestionLagChange?.(owner, change);
    } catch {
      // Lag reporting is observational and must not affect admission.
    }
  }

  private reportIngestionLagSample(
    owner: TOwner,
    sample: CodexIngestionLagSample,
  ): void {
    try {
      this.host.onIngestionLagSample?.(owner, sample);
    } catch {
      // Lag sampling is observational and must not affect owner admission.
    }
  }

  /** Ends a hold whose admissions did not all settle. */
  private finishOwnerHold(
    holdOutcome: StdoutHoldOutcome,
    hold: OwnerHold,
  ): void {
    this.finishHold(
      'owner-admission',
      holdOutcome,
      hold,
      Math.max(hold.longestSettledMs, this.now() - hold.startedAt),
    );
  }

  private appendQueued(lane: Lane<TOwner>, queued: QueuedFrame): void {
    const previous = lane.newestQueued;
    queued.previousLive = previous;
    if (previous) previous.nextLive = queued;
    else lane.oldestQueued = queued;
    lane.newestQueued = queued;
  }

  private unlinkQueued(lane: Lane<TOwner>, queued: QueuedFrame): void {
    if (queued.previousLive) queued.previousLive.nextLive = queued.nextLive;
    else if (lane.oldestQueued === queued) lane.oldestQueued = queued.nextLive;
    if (queued.nextLive) queued.nextLive.previousLive = queued.previousLive;
    else if (lane.newestQueued === queued)
      lane.newestQueued = queued.previousLive;
    queued.previousLive = null;
    queued.nextLive = null;
  }

  private enqueue(
    lane: Lane<TOwner>,
    frame: OwnerLaneFrame,
    seq: number,
    timing: FrameTiming,
  ): void {
    const bytes = Math.max(0, frame.measureBytes());
    const queued: QueuedFrame = {
      frame,
      bytes,
      seq,
      producedAtMs: timing.producedAtMs,
      source: timing.source,
      previousLive: null,
      nextLive: null,
    };
    this.appendQueued(lane, queued);
    lane.queue.push(queued);
    lane.queuedBytes += bytes;
    lane.queuedFrames += 1;
    this.queuedBytes += bytes;
    this.queuedFrames += 1;
    const isResponse = frame.kind === 'response';
    if (isResponse) {
      lane.queuedResponses += 1;
      this.queuedResponses += 1;
    }
    if (this.limits.perOwnerRetention) {
      if (lane.coalescing) this.coalesceSnapshot(lane, queued);
      else if (this.heldBytes(lane) > this.limits.highWaterBytes) {
        lane.coalescing = true;
        for (let index = lane.head; index < lane.queue.length; index += 1) {
          const entry = lane.queue[index];
          if (entry) this.coalesceSnapshot(lane, entry);
        }
      }
      // Bound tombstone overhead as well as releasing obsolete wire payloads.
      if (
        lane.queue.length >= QUEUE_COMPACTION_THRESHOLD &&
        lane.queue.length >= lane.queuedFrames * 2
      ) {
        lane.queue = lane.queue.slice(lane.head).filter((entry) => entry.frame);
        lane.head = 0;
      }
    }
    const hold = lane.hold;
    if (hold) {
      hold.peakFrames = Math.max(hold.peakFrames, lane.queuedFrames);
      hold.peakBytes = Math.max(hold.peakBytes, lane.queuedBytes);
      if (isResponse) hold.responseQueued = true;
    }
    const pause = this.sourcePause;
    if (pause) {
      pause.peakFrames = Math.max(pause.peakFrames, this.queuedFrames);
      pause.peakBytes = Math.max(pause.peakBytes, this.queuedBytes);
      if (isResponse) pause.responseQueued = true;
    }
    this.updateSourcePressure();
    this.updateIngestionLag(lane, this.now());
  }

  private shift(lane: Lane<TOwner>): QueuedFrame | undefined {
    let next: QueuedFrame | undefined;
    // Coalesced slots are skipped in a loop: a long run of them must not
    // recurse once per slot.
    while (!next?.frame) {
      if (lane.head >= lane.queue.length) return undefined;
      next = lane.queue[lane.head];
      lane.head += 1;
      if (lane.head >= lane.queue.length) {
        lane.queue = [];
        lane.head = 0;
      } else if (
        lane.head >= QUEUE_COMPACTION_THRESHOLD &&
        lane.head * 2 >= lane.queue.length
      ) {
        lane.queue = lane.queue.slice(lane.head);
        lane.head = 0;
      }
    }
    const key = next.frame.coalesceKey;
    if (key && lane.snapshots.get(key) === next) lane.snapshots.delete(key);
    this.unlinkQueued(lane, next);
    lane.queuedBytes -= next.bytes;
    lane.queuedFrames -= 1;
    this.queuedBytes -= next.bytes;
    this.queuedFrames -= 1;
    if (next.frame.kind === 'response') {
      lane.queuedResponses -= 1;
      this.queuedResponses -= 1;
    }
    return next;
  }

  private scheduleDrain(lane: Lane<TOwner>): void {
    if (lane.drainScheduled) return;
    lane.drainScheduled = true;
    queueMicrotask(() => {
      lane.drainScheduled = false;
      if (this.lanes.get(lane.owner) === lane) this.drain(lane);
    });
  }

  private drain(lane: Lane<TOwner>): void {
    while (this.lanes.get(lane.owner) === lane) {
      // Skip coalesced slots before deciding whether the next live frame overlaps.
      while (lane.head < lane.queue.length && !lane.queue[lane.head]?.frame)
        lane.head += 1;
      const head = lane.queue[lane.head];
      if (
        lane.hold !== null &&
        (!head?.frame || !this.mayOverlap(lane, head.frame, head.bytes))
      )
        break;
      const next = this.shift(lane);
      if (!next?.frame) {
        if (!lane.drainScheduled) {
          this.updateIngestionLag(lane, this.now());
          this.lanes.delete(lane.owner);
          for (const waiter of Array.from(lane.drainWaiters)) waiter.resolve();
          lane.drainWaiters.clear();
        }
        break;
      }
      let admission: void | Promise<void>;
      try {
        admission = next.frame.deliver();
      } catch (error) {
        this.abortIngestionLagEpisode(lane);
        this.host.onDeliveryFailure(toError(error));
        return;
      }
      if (admission)
        this.beginHold(
          lane.owner,
          lane,
          admission,
          next.frame,
          next.seq,
          { producedAtMs: next.producedAtMs, source: next.source },
          next.bytes,
        );
      else this.updateIngestionLag(lane, this.now());
    }
    if (this.lanes.get(lane.owner) === lane) this.settleDrainWaiters(lane);
    this.updateSourcePressure();
  }

  /**
   * Resolves the drains whose frames are all delivered and admitted. Frames
   * reach a lane, are delivered and start their admissions in sequence order,
   * so the oldest frame still queued or pending bounds every drain.
   */
  private settleDrainWaiters(lane: Lane<TOwner>): void {
    if (lane.drainWaiters.size === 0) return;
    let outstanding = Number.POSITIVE_INFINITY;
    const pending = lane.hold ? this.oldestAdmission(lane.hold) : undefined;
    if (pending) outstanding = pending.seq;
    const queued = lane.oldestQueued;
    if (queued) outstanding = Math.min(outstanding, queued.seq);
    for (const waiter of Array.from(lane.drainWaiters)) {
      if (waiter.throughSeq >= outstanding) continue;
      lane.drainWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private updateSourcePressure(): void {
    if (this.limits.perOwnerRetention) {
      this.updatePerOwnerPressure(this.limits.perOwnerRetention.hardLimitBytes);
      return;
    }
    // Retained frames, plus frames delivered under a budget whose admissions
    // are pending.
    const heldBytes = this.queuedBytes + this.inFlightBytes;
    if (!this.sourcePause) {
      if (heldBytes > this.limits.highWaterBytes) {
        this.sourcePause = {
          startedAt: this.now(),
          peakFrames: this.queuedFrames,
          peakBytes: this.queuedBytes,
          responseQueued: this.queuedResponses > 0,
          warned: false,
        };
        this.host.pauseSource();
        this.host.onSourcePauseChange(true);
        this.ensureWatch();
      }
      return;
    }
    if (heldBytes <= this.limits.lowWaterBytes) {
      const pause = this.sourcePause;
      this.sourcePause = null;
      this.host.onSourcePauseChange(false);
      this.host.resumeSource();
      this.finishHold('stdout-byte-cap', 'released', pause);
    }
  }

  private heldBytes(lane: Lane<TOwner>): number {
    return lane.queuedBytes + (lane.hold?.pendingBytes ?? 0);
  }

  private coalesceSnapshot(lane: Lane<TOwner>, entry: QueuedFrame): void {
    const frame = entry.frame;
    if (!frame) return;
    const key = frame.coalesceKey;
    if (!key) return;
    const previous = lane.snapshots.get(key);
    if (previous?.frame) {
      this.unlinkQueued(lane, previous);
      lane.queuedBytes -= previous.bytes;
      this.queuedBytes -= previous.bytes;
      lane.queuedFrames -= 1;
      this.queuedFrames -= 1;
      previous.frame = undefined;
      previous.bytes = 0;
    }
    // Keep the replacement at its newest position, not at the obsolete slot:
    // every surviving frame keeps pipe order, including other items/deltas.
    lane.snapshots.set(key, entry);
  }

  private updatePerOwnerPressure(hardLimitBytes: number): void {
    let hardPaused = false;
    for (const lane of Array.from(this.lanes.values())) {
      const bytes = this.heldBytes(lane);
      if (bytes <= this.limits.lowWaterBytes) {
        lane.coalescing = false;
        lane.snapshots.clear();
        lane.hardPaused = false;
      }
      if (bytes > hardLimitBytes) lane.hardPaused = true;
      hardPaused ||= lane.hardPaused;
    }
    if (!this.sourcePause && hardPaused) {
      // One multiplexed pipe has no per-owner flow-control protocol. Once an
      // owner's lossless content (deltas, tool output, distinct snapshots) still
      // exceeds 64 MiB after coalescing, pausing is the last-resort OOM guard.
      // It necessarily delays unread peer/control frames until that owner
      // drains to low water. Never drop deltas or spill into a second store.
      const pause: HoldStats = {
        startedAt: this.now(),
        peakFrames: this.queuedFrames,
        peakBytes: this.queuedBytes,
        responseQueued: this.queuedResponses > 0,
        warned: true,
      };
      this.sourcePause = pause;
      this.host.pauseSource();
      this.host.onSourcePauseChange(true);
      this.host.warnLongHold(
        `Codex app-server stdout paused at the ${String(hardLimitBytes)}-byte hard per-owner retained-frame limit after snapshot coalescing; last-resort shared-pipe OOM guard`,
      );
      // Warn immediately; record the content-free hold diagnostic on release
      // or discard, even for a pause shorter than the long-hold threshold.
      this.ensureWatch();
    } else if (this.sourcePause && !hardPaused) {
      const pause = this.sourcePause;
      this.sourcePause = null;
      this.host.onSourcePauseChange(false);
      this.host.resumeSource();
      this.finishHold(
        'stdout-byte-cap',
        'released',
        pause,
        this.now() - pause.startedAt,
        true,
      );
    }
  }

  private finishHold(
    holdKind: StdoutHoldKind,
    holdOutcome: StdoutHoldOutcome,
    hold: HoldStats,
    durationMs: number = this.now() - hold.startedAt,
    forceReport = false,
  ): void {
    const holdDurationMs = Math.max(0, durationMs);
    if (!forceReport && holdDurationMs < this.limits.longHoldThresholdMs)
      return;
    if (!hold.warned) {
      hold.warned = true;
      this.warn(holdKind, holdDurationMs, hold);
    }
    this.host.reportLongHold({
      holdKind,
      holdOutcome,
      holdDurationMs,
      queuedFrameCount: hold.peakFrames,
      queuedFrameBytes: hold.peakBytes,
      responseQueued: hold.responseQueued,
    });
  }

  private ensureWatch(): void {
    if (this.watchTimer !== null) return;
    const intervalMs = Math.max(
      1,
      Math.min(
        MAX_LONG_HOLD_WATCH_INTERVAL_MS,
        this.limits.longHoldThresholdMs,
      ),
    );
    this.watchTimer = setInterval(() => this.checkLongHolds(), intervalMs);
    this.watchTimer.unref?.();
  }

  private stopWatch(): void {
    if (this.watchTimer !== null) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  /** Warns once, while still pending, about each hold past the threshold. */
  private checkLongHolds(): void {
    let active = false;
    const now = this.now();
    for (const lane of Array.from(this.lanes.values())) {
      this.updateIngestionLag(lane, now);
      const episode = lane.ingestionLagEpisode;
      const oldest = this.oldestOutstandingFrame(lane);
      const lastSampledAtMs = lane.lastIngestionLagSampledAtMs;
      if (
        episode &&
        oldest &&
        (lastSampledAtMs === null ||
          now - lastSampledAtMs >= INGESTION_LAG_SAMPLE_INTERVAL_MS)
      ) {
        lane.lastIngestionLagSampledAtMs = now;
        this.reportIngestionLagSample(lane.owner, {
          lagMs: this.frameLagMs(oldest, now),
          source: oldest.source,
          sampledAtMs: now,
          catchingUp: true,
        });
      }
      const hold = lane.hold;
      if (!hold) {
        active ||= lane.oldestQueued !== null;
        continue;
      }
      active = true;
      const elapsedMs = now - hold.startedAt;
      if (!hold.warned && elapsedMs >= this.limits.longHoldThresholdMs) {
        hold.warned = true;
        this.warn('owner-admission', elapsedMs, hold);
      }
    }
    const pause = this.sourcePause;
    if (pause) {
      active = true;
      const elapsedMs = now - pause.startedAt;
      if (!pause.warned && elapsedMs >= this.limits.longHoldThresholdMs) {
        pause.warned = true;
        this.warn('stdout-byte-cap', elapsedMs, pause);
      }
    }
    if (!active) this.stopWatch();
  }

  private warn(kind: StdoutHoldKind, elapsedMs: number, hold: HoldStats): void {
    const now = this.now();
    if (now - this.warningWindowStartedAt < LONG_HOLD_WARNING_WINDOW_MS) {
      this.suppressedWarnings += 1;
      return;
    }
    const suppressed = this.suppressedWarnings;
    this.suppressedWarnings = 0;
    this.warningWindowStartedAt = now;
    const queued = `${String(hold.peakFrames)} frame(s), ${String(
      hold.peakBytes,
    )} bytes${hold.responseQueued ? ', including a JSON-RPC response' : ''}`;
    const summary =
      suppressed > 0
        ? `; suppressed ${String(suppressed)} similar warning(s) in the previous ${String(
            LONG_HOLD_WARNING_WINDOW_MS / 1000,
          )}s`
        : '';
    this.host.warnLongHold(
      kind === 'owner-admission'
        ? `Codex app-server owner admission held for ${formatSeconds(
            elapsedMs,
          )}s (${queued} queued for that owner); other owners continue${summary}`
        : `Codex app-server stdout paused for ${formatSeconds(
            elapsedMs,
          )}s at the ${String(
            this.limits.highWaterBytes,
          )}-byte retained-frame cap (${queued} queued)${summary}`,
    );
  }
}
