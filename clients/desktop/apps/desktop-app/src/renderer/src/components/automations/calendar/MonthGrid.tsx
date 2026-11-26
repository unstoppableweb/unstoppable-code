import { ControlButton } from '@canopy/ui-shared/components';
import { useMemo, type JSX } from 'react';
import {
  isToday,
  monthGridDays,
  startOfDay,
  startOfMonth,
} from './calendarDateUtils';
import {
  calendarEventChipAttributes,
  calendarEventTone,
  formatEventTime,
  formatGroupCount,
  isCalendarEventClickable,
  type CalendarEvent,
  type CalendarEventGroup,
} from './calendarEvents';
import type { CalendarView } from './calendarPreferences';
import { HoverCard } from '@canopy/ui-shared/components';
import {
  CalendarDayNumber,
  Button,
  Surface,
} from '@canopy/ui-shared/components';

/** Max event chips shown per cell before collapsing into a "+N more" button. */
export const MAX_CHIPS_PER_CELL = 3;

interface MonthGridProps {
  anchorDate: Date;
  /** Condensed fire groups (one chip per group). */
  groups: CalendarEventGroup[];
  now: Date;
  selectedActivityId: string | null;
  onEventClick: (event: CalendarEvent) => void;
  onAnchorDateChange: (date: Date) => void;
  onCalendarViewChange: (view: CalendarView) => void;
}

interface MonthEventChipProps {
  group: CalendarEventGroup;
  selectedActivityId: string | null;
  onEventClick: (event: CalendarEvent) => void;
}

function MonthGridEvent({
  group,
  selectedActivityId,
  onEventClick,
}: MonthEventChipProps): JSX.Element {
  const event = group.representative;
  const clickable = isCalendarEventClickable(event);
  const selected = selectedActivityId === group.activityId;
  const countLabel = formatGroupCount(group.count);
  const title =
    countLabel === null
      ? `${formatEventTime(group.at)} · ${event.name}`
      : `${formatEventTime(group.at)} · ${event.name} ${countLabel}`;
  return (
    <HoverCard
      content={title}
      triggerWrapperClassName="w-full"
      surfaceClassName="w-max max-w-80"
      surfacePadding="compact"
    >
      <ControlButton
        type="button"
        {...calendarEventChipAttributes(event, selected)}
        data-event-count={group.count}
        onClick={
          clickable
            ? (clickEvent): void => {
                clickEvent.stopPropagation();
                onEventClick(event);
              }
            : undefined
        }
        disabled={!clickable}
        presentation="calendar-event"
        appearance={{
          layout: 'month',
          tone: calendarEventTone(event),
          selected,
          interactive: clickable,
        }}
      >
        <span className="shrink-0 tabular-nums opacity-80">
          {formatEventTime(group.at)}
        </span>
        <span className="truncate">{event.name}</span>
        {countLabel !== null && (
          <span className="ml-auto shrink-0 tabular-nums opacity-70">
            {countLabel}
          </span>
        )}
      </ControlButton>
    </HoverCard>
  );
}

/**
 * Six-row (6×7) month grid. Out-of-month days are dimmed; today's date carries
 * a red marker. Each cell shows up to `MAX_CHIPS_PER_CELL` condensed chips, then
 * a "+N more" button that jumps to that day's Day view.
 */
export function MonthGrid({
  anchorDate,
  groups,
  now,
  selectedActivityId,
  onEventClick,
  onAnchorDateChange,
  onCalendarViewChange,
}: MonthGridProps): JSX.Element {
  const days = useMemo(() => monthGridDays(anchorDate), [anchorDate]);
  const currentMonth = startOfMonth(anchorDate).getMonth();
  const weekdayLabels = useMemo(
    () =>
      days
        .slice(0, 7)
        .map((day) => day.toLocaleDateString(undefined, { weekday: 'short' })),
    [days],
  );
  const groupsByDay = useMemo(() => {
    const nextGroupsByDay = new Map<number, CalendarEventGroup[]>();
    for (const group of groups) {
      const key = startOfDay(group.at).getTime();
      const dayGroups = nextGroupsByDay.get(key);
      if (dayGroups === undefined) {
        nextGroupsByDay.set(key, [group]);
      } else {
        dayGroups.push(group);
      }
    }
    return nextGroupsByDay;
  }, [groups]);

  return (
    <Surface variant="outline" className="overflow-hidden">
      <Surface
        variant="quiet-panel"
        boundary="bottom"
        className="grid grid-cols-7"
      >
        {weekdayLabels.map((label) => (
          <div
            key={label}
            className="px-2 py-1.5 text-center text-3xs fg-secondary "
          >
            {label}
          </div>
        ))}
      </Surface>
      <div className="grid grid-cols-7">
        {days.map((day, index) => {
          const inMonth = day.getMonth() === currentMonth;
          const today = isToday(day, now);
          const dayGroups = groupsByDay.get(startOfDay(day).getTime()) ?? [];
          const overflow = dayGroups.length > MAX_CHIPS_PER_CELL;
          const shown = overflow
            ? dayGroups.slice(0, MAX_CHIPS_PER_CELL - 1)
            : dayGroups;
          const moreCount = dayGroups.length - shown.length;
          return (
            <Surface
              variant="section"
              boundary="top"
              key={day.getTime()}
              className="flex flex-col"
            >
              <Surface
                variant="section"
                boundary={index % 7 === 0 ? 'none' : 'left'}
                className="flex flex-1 flex-col"
              >
                <div className="flex min-h-24 flex-col gap-0.5 p-1">
                  <CalendarDayNumber
                    day={day.getDate()}
                    today={today}
                    outsideMonth={!inMonth}
                    density="month-cell"
                  />
                  {shown.map((group) => (
                    <MonthGridEvent
                      key={group.key}
                      group={group}
                      selectedActivityId={selectedActivityId}
                      onEventClick={onEventClick}
                    />
                  ))}
                  {moreCount > 0 && (
                    // The link takes the cell's 3xs copy size; the inset lines it
                    // up with the chips' labels.
                    <div className="px-1 py-0.5 text-3xs">
                      <Button
                        variant="link"
                        onClick={(): void => {
                          onAnchorDateChange(day);
                          onCalendarViewChange('day');
                        }}
                      >
                        +{moreCount} more
                      </Button>
                    </div>
                  )}
                </div>
              </Surface>
            </Surface>
          );
        })}
      </div>
    </Surface>
  );
}
