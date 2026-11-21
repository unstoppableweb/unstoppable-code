/**
 * A time short enough to sit inside a one-line notice or on a button: a
 * clock time when it falls today, a weekday plus time otherwise. Shared by
 * the usage-limit banner's reset time and its scheduled-resume time so both
 * read the same way ("Resume at Tue 9:00 AM", "resumes automatically at
 * Tue 9:00 AM").
 */
export function formatUsageLimitTimeLabel(
  at: number | string | undefined,
): string | null {
  // `0` and `''` are "no time" from the callers' stores, not the epoch.
  if (at === undefined || at === 0 || at === '') return null;
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return null;
  const sameDay = when.toDateString() === new Date().toDateString();
  return sameDay
    ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : when.toLocaleString([], {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      });
}

/**
 * A usage check's next time (CAN-7483): a clock time today, otherwise the
 * date with it. A check can be up to seven days out, where a weekday alone
 * would be ambiguous.
 */
export function formatUsageLimitCheckTimeLabel(
  at: number | string | undefined,
): string | null {
  if (at === undefined || at === 0 || at === '') return null;
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return null;
  return when.toDateString() === new Date().toDateString()
    ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : when.toLocaleString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}
