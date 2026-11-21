import type { JSX } from 'react';

export function CalendarDayNumber({
  day,
  today,
  density,
  outsideMonth = false,
}: {
  readonly day: number;
  readonly today: boolean;
  readonly density: 'day-header' | 'month-cell';
  readonly outsideMonth?: boolean;
}): JSX.Element {
  const size =
    density === 'day-header'
      ? 'mx-auto mt-0.5 size-6 text-s'
      : 'mb-0.5 size-5 self-start text-2xs';
  const tone = today
    ? 'rounded-full bg-destructive font-semibold fg-emphasis'
    : outsideMonth
      ? 'fg-secondary/50'
      : 'fg-primary';
  return (
    <div className={`flex items-center justify-center ${size} ${tone}`}>
      {day}
    </div>
  );
}

/** A calendar date gets the same red emphasis as the current day marker. */
export function CalendarAgendaDayLabel({
  date,
  today,
}: {
  readonly date: Date;
  readonly today: boolean;
}): JSX.Element {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return (
    <time
      dateTime={`${year}-${month}-${day}`}
      aria-current={today ? 'date' : undefined}
      className={`text-s font-semibold ${today ? 'fg-destructive' : 'fg-primary'}`}
    >
      {date.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })}
    </time>
  );
}

/** An agenda entry's dot has the same status ink and fill as its event. */
export function CalendarAgendaDot({
  statusClasses,
  paused = false,
}: {
  readonly statusClasses: string;
  readonly paused?: boolean;
}): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 10 10"
      className={`size-2.5 shrink-0 overflow-visible ${statusClasses}${paused ? ' opacity-50' : ''}`}
    >
      <circle
        cx="5"
        cy="5"
        r="4.5"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeOpacity="0.5"
        strokeDasharray={paused ? '2 1' : undefined}
      />
    </svg>
  );
}

/** Current-time line inside a calendar column. */
export function CalendarNowMark({
  top,
  testId,
}: {
  readonly top: number;
  readonly testId?: string;
}): JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      className="pointer-events-none absolute inset-x-0 z-20 flex items-center"
      style={{ top }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 8 8"
        className="-ml-1 size-2 shrink-0"
      >
        <circle cx="4" cy="4" r="4" fill="var(--bg-destructive)" />
      </svg>
      <span className="h-0.5 flex-1 bg-destructive" />
    </div>
  );
}
