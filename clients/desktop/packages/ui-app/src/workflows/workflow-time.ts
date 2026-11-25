/**
 * Time labels for the Workflows tables (CAN-3981). Pure: every function takes
 * `now` and an optional locale so both hosts and tests format identically.
 */

const DAY_MS = 86_400_000;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Whole calendar days from `now` to `timestamp`; negative is in the past. */
function calendarDayOffset(timestamp: number, now: number): number {
  return Math.round((startOfDay(timestamp) - startOfDay(now)) / DAY_MS);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * One formatter per locale and shape, built once. Building one costs far more
 * than formatting with it, and a Runs table of 100 rows built about 500 per
 * render. The zone offset is in the key because a formatter keeps the time
 * zone it was built in.
 */
function formatter(
  shape: string,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${shape}|${locale ?? ''}|${String(new Date().getTimezoneOffset())}`;
  const known = formatters.get(key);
  if (known) return known;
  const built = new Intl.DateTimeFormat(locale, options);
  formatters.set(key, built);
  return built;
}

function clockLabel(timestamp: number, locale?: string): string {
  return formatter('clock', locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

function weekdayLabel(
  timestamp: number,
  style: 'short' | 'long',
  locale?: string,
): string {
  return formatter(`weekday-${style}`, locale, { weekday: style }).format(
    timestamp,
  );
}

function monthDayLabel(timestamp: number, locale?: string): string {
  return formatter('month-day', locale, {
    month: 'short',
    day: 'numeric',
  }).format(timestamp);
}

/**
 * When a run started: `Today 10:52 AM`, `Yesterday 2:00 AM`, `Sun 4:31 PM`
 * within the last week, then `Sep 24`.
 */
export function formatRunStarted(
  timestamp: number,
  now: number,
  locale?: string,
): string {
  if (!Number.isFinite(timestamp)) return '';
  const offset = calendarDayOffset(timestamp, now);
  const clock = clockLabel(timestamp, locale);
  if (offset === 0) return `Today ${clock}`;
  if (offset === -1) return `Yesterday ${clock}`;
  if (offset < -1 && offset > -7) {
    return `${weekdayLabel(timestamp, 'short', locale)} ${clock}`;
  }
  return monthDayLabel(timestamp, locale);
}

/**
 * When a workflow runs next: `Today, 2:00 AM`, `Tomorrow, 9:00 AM`,
 * `Friday, 4:00 PM` within the next week, then `Oct 2, 10:30 AM`, with the
 * year when it is not this one.
 */
export function formatNextRun(
  timestamp: number,
  now: number,
  locale?: string,
): string {
  if (!Number.isFinite(timestamp)) return '';
  const offset = calendarDayOffset(timestamp, now);
  const clock = clockLabel(timestamp, locale);
  if (offset === 0) return `Today, ${clock}`;
  if (offset === 1) return `Tomorrow, ${clock}`;
  if (offset > 1 && offset < 7) {
    return `${weekdayLabel(timestamp, 'long', locale)}, ${clock}`;
  }
  if (new Date(timestamp).getFullYear() !== new Date(now).getFullYear()) {
    const date = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(timestamp);
    return `${date}, ${clock}`;
  }
  return `${monthDayLabel(timestamp, locale)}, ${clock}`;
}

/** A one-time trigger's date: `Oct 2 at 10:30 AM`. */
export function formatOneTimeTrigger(
  timestamp: number,
  locale?: string,
): string {
  if (!Number.isFinite(timestamp)) return '';
  return `${monthDayLabel(timestamp, locale)} at ${clockLabel(timestamp, locale)}`;
}

/** How long a run took: `42s`, `2m 04s`, `47m`, `1h 12m`. */
export function formatRunDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 30) {
    return `${String(totalMinutes)}m ${String(seconds).padStart(2, '0')}s`;
  }
  if (totalMinutes < 60) return `${String(totalMinutes)}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}h ${String(minutes).padStart(2, '0')}m`;
}
