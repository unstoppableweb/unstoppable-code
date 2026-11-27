import { useId, useRef, useState, type JSX } from 'react';
import {
  Button,
  Picker,
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionLabel,
} from '@canopy/ui-shared/components';
import { ChevronDownIcon } from '@canopy/ui-shared/icons';
import type { CalendarView } from './calendarPreferences';

const VIEW_LABELS: Record<CalendarView, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  schedule: 'Schedule',
};

const VIEW_ORDER: readonly CalendarView[] = [
  'day',
  'week',
  'month',
  'schedule',
];

interface CalendarViewPickerProps {
  calendarView: CalendarView;
  onChange: (view: CalendarView) => void;
}

/**
 * Google-Calendar-style "Week ▾" dropdown of Day / Week / Month / Schedule,
 * on the shared picker shell.
 */
export function CalendarViewPicker({
  calendarView,
  onChange,
}: CalendarViewPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  return (
    <>
      <Button
        size="compact"
        ref={anchorRef}
        onClick={(): void => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid="automations-calendar-view-picker"
      >
        <span>{VIEW_LABELS[calendarView]}</span>
        <ChevronDownIcon size="sm" />
      </Button>
      <Picker
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-left"
        interaction="listbox"
        role="listbox"
        aria-label="Calendar view"
        data-testid="automations-calendar-view-menu"
      >
        {VIEW_ORDER.map((view) => {
          const selected = view === calendarView;
          return (
            <PickerOption
              key={view}
              role="option"
              aria-selected={selected}
              selected={selected}
              data-testid={`automations-calendar-view-${view}`}
              onClick={(): void => {
                setOpen(false);
                onChange(view);
              }}
            >
              <PickerOptionContent>
                <PickerOptionLabel>{VIEW_LABELS[view]}</PickerOptionLabel>
              </PickerOptionContent>
              <PickerOptionCheck selected={selected} />
            </PickerOption>
          );
        })}
      </Picker>
    </>
  );
}
