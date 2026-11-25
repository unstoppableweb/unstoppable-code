export const TIMING_NOT_AVAILABLE = 'Not available';

const TIMESTAMP_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

/**
 * One formatter for every timestamp. `toLocaleString` builds a new one per
 * call, which is the slow part: a list of runs formats one per row on every
 * render.
 */
let cachedTimestampFormatter: Intl.DateTimeFormat | null = null;
function timestampFormatter(): Intl.DateTimeFormat {
  cachedTimestampFormatter ??= new Intl.DateTimeFormat(
    undefined,
    TIMESTAMP_FORMAT_OPTIONS,
  );
  return cachedTimestampFormatter;
}

/** Parses an ISO timestamp to epoch ms, or null when absent/invalid. */
export function parseIsoToEpoch(iso: string | undefined): number | null {
  if (!iso) {
    return null;
  }

  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? null : timestamp;
}

/** Locale-formatted timing timestamp used across pipeline surfaces. */
export function formatTimingTimestamp(iso: string | undefined): string {
  const timestamp = parseIsoToEpoch(iso);
  if (timestamp === null) {
    return TIMING_NOT_AVAILABLE;
  }

  return timestampFormatter().format(new Date(timestamp));
}

export interface PipelineElapsedOptions {
  startedAt?: string;
  completedAt?: string;
  /**
   * ISO instant the *execution* entered its current whole-run pause, set only
   * while it is still paused. A single paused step inside an otherwise running
   * execution does not stop the run clock.
   */
  pausedAt?: string;
  /** Milliseconds already banked by earlier, closed whole-run pauses. */
  pausedMs?: number;
  nowMs: number;
  fallbackToNow?: boolean;
}

/**
 * Elapsed run time, excluding whole-run pauses.
 *
 * The clock ends at `completedAt` for a finished entity, at `pausedAt` while a
 * run is paused, and at `nowMs` otherwise; `pausedMs` removes pause windows
 * that already closed. When a terminal timestamp was written without closing
 * the open pause (cancelling a paused run), the earlier of the two wins so the
 * pause is never counted as work.
 */
export function getElapsedMs({
  startedAt,
  completedAt,
  pausedAt,
  pausedMs = 0,
  nowMs,
  fallbackToNow = true,
}: PipelineElapsedOptions): number | null {
  const startedAtMs = parseIsoToEpoch(startedAt);
  if (startedAtMs === null) {
    return null;
  }

  const completedAtMs = parseIsoToEpoch(completedAt);
  const pausedAtMs = parseIsoToEpoch(pausedAt);
  const stoppedAtMs =
    completedAtMs !== null && pausedAtMs !== null
      ? Math.min(completedAtMs, pausedAtMs)
      : (completedAtMs ?? pausedAtMs);
  const endMs = stoppedAtMs ?? (fallbackToNow ? Math.floor(nowMs) : null);

  if (endMs === null || endMs < startedAtMs) {
    return null;
  }

  return Math.max(0, endMs - startedAtMs - Math.max(0, pausedMs));
}

/** Human-readable elapsed label, floored rather than rounded. */
export function formatElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return TIMING_NOT_AVAILABLE;
  }

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${String(totalSeconds)}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0
      ? `${String(totalMinutes)}m ${String(seconds)}s`
      : `${String(totalMinutes)}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (seconds > 0) {
    return `${String(hours)}h ${String(minutes)}m ${String(seconds)}s`;
  }
  if (minutes > 0) {
    return `${String(hours)}h ${String(minutes)}m`;
  }
  return `${String(hours)}h`;
}
