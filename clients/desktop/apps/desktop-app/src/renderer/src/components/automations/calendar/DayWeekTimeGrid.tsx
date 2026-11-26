import { ControlButton } from '@canopy/ui-shared/components';
import { Divider } from '@canopy/ui-shared/components';
import { useMemo, type JSX } from 'react';
import { isToday, startOfDay } from './calendarDateUtils';
import {
  calendarEventChipAttributes,
  calendarEventTone,
  formatGroupCount,
  formatGroupTimeRange,
  isCalendarEventClickable,
  type CalendarEvent,
  type CalendarEventGroup,
} from './calendarEvents';
import {
  EVENT_MIN_PX,
  HOUR_PX,
  layoutDayGroups,
  type PositionedGroup,
} from './dayWeekLayout';
import { NowIndicator } from './NowIndicator';
import { HoverCard } from '@canopy/ui-shared/components';
import { CalendarDayNumber, Surface } from '@canopy/ui-shared/components';

const DAY_HEIGHT = 24 * HOUR_PX;
const HOURS: readonly number[] = Array.from(
  { length: 24 },
  (_unused, hour) => hour,
);

interface DayWeekTimeGridProps {
  /** One column per day: a single day for Day view, seven for Week view. */
  days: Date[];
  /** Condensed fire groups (one chip per group). */
  groups: CalendarEventGroup[];
  now: Date;
  selectedActivityId: string | null;
  onEventClick: (event: CalendarEvent) => void;
}

interface EventChipProps {
  positioned: PositionedGroup;
  selectedActivityId: string | null;
  onEventClick: (event: CalendarEvent) => void;
}

function formatHourLabel(hour: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display} ${period}`;
}

function TimeGridEvent({
  positioned,
  selectedActivityId,
  onEventClick,
}: EventChipProps): JSX.Element {
  const { group, top, height, lane, laneCount } = positioned;
  const event = group.representative;
  const clickable = isCalendarEventClickable(event);
  const selected = selectedActivityId === group.activityId;
  const countLabel = formatGroupCount(group.count);
  const timeRange = formatGroupTimeRange(group);
  const title =
    countLabel === null
      ? `${timeRange} · ${event.name}`
      : `${timeRange} · ${event.name} ${countLabel}`;
  // Condensed blocks span multiple rows; align their content to the top instead
  // of centering it within a tall block.
  const tall = height > EVENT_MIN_PX * 1.5;
  return (
    <div
      className="absolute px-0.5"
      style={{
        top,
        height,
        left: `${(lane / laneCount) * 100}%`,
        width: `${(1 / laneCount) * 100}%`,
      }}
    >
      <HoverCard
        content={title}
        triggerWrapperClassName="h-full w-full"
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
            layout: tall ? 'timeline-tall' : 'timeline',
            tone: calendarEventTone(event),
            selected,
            interactive: clickable,
          }}
        >
          <span className="flex w-full items-center gap-1">
            <span className="shrink-0 tabular-nums opacity-80">
              {timeRange}
            </span>
            {!tall && <span className="truncate">{event.name}</span>}
            {countLabel !== null && (
              <span className="ml-auto shrink-0 tabular-nums opacity-70">
                {countLabel}
              </span>
            )}
          </span>
          {tall && <span className="truncate">{event.name}</span>}
        </ControlButton>
      </HoverCard>
    </div>
  );
}

/**
 * Shared hour grid for Day (one column) and Week (seven columns). Renders a
 * left hour-label gutter, hour gridlines, time-positioned event chips, and the
 * red now-line inside today's column only.
 */
export function DayWeekTimeGrid({
  days,
  groups,
  now,
  selectedActivityId,
  onEventClick,
}: DayWeekTimeGridProps): JSX.Element {
  const dayKeys = days.map((day) => startOfDay(day).getTime());
  const dayKeySignature = dayKeys.join(',');
  const positionedByDay = useMemo(() => {
    const visibleDayKeys =
      dayKeySignature.length === 0
        ? []
        : dayKeySignature.split(',').map((key) => Number(key));
    const groupsByDay = new Map<number, CalendarEventGroup[]>();
    for (const group of groups) {
      const key = startOfDay(group.at).getTime();
      const dayGroups = groupsByDay.get(key);
      if (dayGroups === undefined) {
        groupsByDay.set(key, [group]);
      } else {
        dayGroups.push(group);
      }
    }
    return new Map(
      visibleDayKeys.map((key) => [
        key,
        layoutDayGroups(groupsByDay.get(key) ?? []),
      ]),
    );
  }, [groups, dayKeySignature]);

  return (
    <Surface variant="outline" className="flex flex-col overflow-hidden">
      {/* Day headers */}
      <Surface variant="quiet-panel" boundary="bottom" className="flex">
        <div className="w-14 shrink-0" />
        {days.map((day) => {
          const today = isToday(day, now);
          return (
            <Surface
              variant="section"
              boundary="left"
              key={day.getTime()}
              className="flex-1"
            >
              <div className="px-2 py-1.5 text-center">
                <div className="text-3xs fg-secondary ">
                  {day.toLocaleDateString(undefined, { weekday: 'short' })}
                </div>
                <CalendarDayNumber
                  day={day.getDate()}
                  today={today}
                  density="day-header"
                />
              </div>
            </Surface>
          );
        })}
      </Surface>
      {/* Scrollable hour body */}
      <div className="max-h-150 overflow-y-auto">
        <div className="flex" style={{ height: DAY_HEIGHT }}>
          {/* Hour-label gutter */}
          <div className="relative w-14 shrink-0">
            {HOURS.map((hour) =>
              hour === 0 ? null : (
                <div
                  key={hour}
                  className="absolute right-1 -translate-y-1/2 text-3xs fg-secondary"
                  style={{ top: hour * HOUR_PX }}
                >
                  {formatHourLabel(hour)}
                </div>
              ),
            )}
          </div>
          {/* Day columns */}
          {days.map((day, dayIndex) => {
            const positioned = positionedByDay.get(dayKeys[dayIndex]) ?? [];
            return (
              <Surface
                variant="section"
                boundary="left"
                key={day.getTime()}
                className="relative flex-1"
              >
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="absolute inset-x-0"
                    style={{ top: hour * HOUR_PX }}
                  >
                    <Divider aria-hidden />
                  </div>
                ))}
                {positioned.map((item) => (
                  <TimeGridEvent
                    key={item.group.key}
                    positioned={item}
                    selectedActivityId={selectedActivityId}
                    onEventClick={onEventClick}
                  />
                ))}
                {isToday(day, now) && (
                  <NowIndicator now={now} hourPx={HOUR_PX} />
                )}
              </Surface>
            );
          })}
        </div>
      </div>
    </Surface>
  );
}
