'use client';

import {
  forwardRef,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  ChevronLeftMediumIcon,
  ChevronRightMediumIcon,
} from '../icons/AppIcons';
import { Button } from './Button';
import {
  useFormFieldDescribedBy,
  useFormFieldLabelledBy,
} from './form-field-context';
import { FieldPickerChevron, FieldPickerTrigger } from './Field';
import { FLOATING_MENU_GAP } from './FloatingMenu';
import { Popover } from './Popover';

const DAYS_PER_WEEK = 7;

function pad(value: number, length = 2): string {
  return value.toString().padStart(length, '0');
}

/** A local calendar day as `YYYY-MM-DD`, the value a date field holds. */
export function toIsoDateValue(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
}

/** The local day a `YYYY-MM-DD` value names, or `null` when it names none. */
export function parseIsoDateValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  // Rejects values that roll over, such as 2026-02-31.
  return toIsoDateValue(date) === value ? date : null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The same day of another month, clamped to that month's last day. */
function addMonths(date: Date, months: number): Date {
  const lastDay = new Date(
    date.getFullYear(),
    date.getMonth() + months + 1,
    0,
  ).getDate();
  return new Date(
    date.getFullYear(),
    date.getMonth() + months,
    Math.min(date.getDate(), lastDay),
  );
}

function sameDay(a: Date, b: Date): boolean {
  return toIsoDateValue(a) === toIsoDateValue(b);
}

interface DateFormats {
  readonly trigger: Intl.DateTimeFormat;
  readonly dayLabel: Intl.DateTimeFormat;
  readonly month: Intl.DateTimeFormat;
  readonly weekdays: readonly {
    readonly short: string;
    readonly long: string;
  }[];
}

let dateFormats: DateFormats | null = null;

/**
 * The calendar's formatters, built on first use rather than when the module
 * loads, so a page that only imports the shared components pays nothing.
 */
function getDateFormats(): DateFormats {
  if (dateFormats) return dateFormats;
  const narrow = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
  const long = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  // The grid is Gregorian, so its labels are too, whatever calendar the
  // locale defaults to (fa-IR's is Persian).
  const calendar = 'gregory';
  dateFormats = {
    trigger: new Intl.DateTimeFormat(undefined, {
      calendar,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
    dayLabel: new Intl.DateTimeFormat(undefined, {
      calendar,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }),
    month: new Intl.DateTimeFormat(undefined, {
      calendar,
      month: 'long',
      year: 'numeric',
    }),
    // 2023-01-01 was a Sunday; the calendar's weeks start on Sunday.
    weekdays: Array.from({ length: DAYS_PER_WEEK }, (_, index) => {
      const day = new Date(2023, 0, 1 + index);
      return { short: narrow.format(day), long: long.format(day) };
    }),
  };
  return dateFormats;
}

interface MonthCalendarProps {
  readonly selected: Date | null;
  readonly min: Date | null;
  readonly onPick: (date: Date) => void;
  /** Set to the day that takes focus when the calendar opens. */
  readonly focusedDayRef: RefObject<HTMLButtonElement | null>;
}

/**
 * One month of days, drawn with the shared `Button`. Arrow keys move a day
 * or a week, Home and End go to the week's ends, Page Up and Page Down move a
 * month, and Enter or Space pick the focused day.
 */
function MonthCalendar({
  selected,
  min,
  onPick,
  focusedDayRef,
}: MonthCalendarProps): JSX.Element {
  const formats = getDateFormats();
  const today = useMemo(() => new Date(), []);
  const [focused, setFocused] = useState<Date>(() => {
    const start = selected ?? today;
    return min && start < min ? min : start;
  });
  // Set by a keyboard move in the grid: the next render moves focus to the
  // day it landed on, once. The month buttons leave it unset, so they keep
  // focus themselves.
  const focusLandedDay = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const monthLabelId = useId();
  const year = focused.getFullYear();
  const month = focused.getMonth();
  const leadingBlanks = new Date(year, month, 1).getDay();
  const dayCount = new Date(year, month + 1, 0).getDate();
  const minMonthStart = min
    ? new Date(min.getFullYear(), min.getMonth(), 1)
    : null;
  const canGoBack =
    minMonthStart === null || new Date(year, month, 1) > minMonthStart;

  // The roving tab stop never lands on a day before `min`, which is disabled.
  const clamp = (next: Date): Date => (min && next < min ? min : next);
  const move = (next: Date): void => {
    focusLandedDay.current = true;
    // A fresh Date always re-renders, so the flag is consumed even when the
    // clamp lands on the day already focused.
    setFocused(new Date(clamp(next).getTime()));
  };

  // Keyboard moves follow focus to the day they land on, even across months.
  useEffect((): void => {
    if (!focusLandedDay.current) return;
    focusLandedDay.current = false;
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-date="${toIsoDateValue(focused)}"]`)
      ?.focus();
  }, [focused]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const steps: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focused, -1),
      ArrowRight: () => addDays(focused, 1),
      ArrowUp: () => addDays(focused, -DAYS_PER_WEEK),
      ArrowDown: () => addDays(focused, DAYS_PER_WEEK),
      Home: () => addDays(focused, -focused.getDay()),
      End: () => addDays(focused, DAYS_PER_WEEK - 1 - focused.getDay()),
      PageUp: () => addMonths(focused, -1),
      PageDown: () => addMonths(focused, 1),
    };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    move(step());
  };

  return (
    // Escape inside the calendar closes only the calendar: the boundary keeps
    // a dialog beneath it from taking the press first.
    <div
      className="flex flex-col gap-2"
      data-canopy-escape-boundary="true"
      data-testid="date-field-calendar"
    >
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          aria-label="Previous month"
          disabled={!canGoBack}
          onClick={() => setFocused(clamp(addMonths(focused, -1)))}
          data-testid="date-field-previous-month"
        >
          <ChevronLeftMediumIcon size={16} />
        </Button>
        <span
          id={monthLabelId}
          aria-live="polite"
          className="text-s font-medium fg-primary"
        >
          {formats.month.format(focused)}
        </span>
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          aria-label="Next month"
          onClick={() => setFocused(addMonths(focused, 1))}
          data-testid="date-field-next-month"
        >
          <ChevronRightMediumIcon size={16} />
        </Button>
      </div>
      <div
        ref={gridRef}
        role="group"
        aria-labelledby={monthLabelId}
        onKeyDown={handleKeyDown}
        // Coarse pointers space the 28px days 16px apart, so each day's 44px
        // touch area (the default) fills its cell without taking a
        // neighbour's taps.
        className="grid grid-cols-7 gap-0.5 pointer-coarse:gap-4"
      >
        {formats.weekdays.map((weekday) => (
          <abbr
            key={weekday.long}
            title={weekday.long}
            className="flex h-7 items-center justify-center text-xs no-underline fg-tertiary"
          >
            {weekday.short}
          </abbr>
        ))}
        {Array.from({ length: leadingBlanks }, (_, index) => (
          <span key={`blank-${index}`} aria-hidden="true" />
        ))}
        {Array.from({ length: dayCount }, (_, index) => {
          const day = new Date(year, month, index + 1);
          const isSelected = selected !== null && sameDay(day, selected);
          const isToday = sameDay(day, today);
          const isFocused = sameDay(day, focused);
          return (
            <Button
              key={index}
              variant={isSelected ? 'primary' : 'ghost'}
              size="compact"
              iconOnly
              aria-label={formats.dayLabel.format(day)}
              aria-pressed={isSelected}
              aria-current={isToday ? 'date' : undefined}
              disabled={min !== null && day < min}
              ref={isFocused ? focusedDayRef : undefined}
              tabIndex={isFocused ? 0 : -1}
              data-date={toIsoDateValue(day)}
              onFocus={() => {
                if (!isFocused) setFocused(day);
              }}
              onClick={() => onPick(day)}
            >
              {/* Today reads in the accent ink until it is the chosen day. */}
              {isToday && !isSelected ? (
                <span className="fg-accent">{index + 1}</span>
              ) : (
                index + 1
              )}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export interface DateFieldProps {
  /** The chosen local day as `YYYY-MM-DD`, or `''` while none is chosen. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** The earliest day that can be picked, as `YYYY-MM-DD`. */
  readonly min?: string;
  /** Shown in the tertiary ink while no day is chosen. */
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'aria-label'?: string;
  /** The error and help text that describe the field (`FormField` sets it). */
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
  readonly 'data-testid'?: string;
  /** The document the calendar opens in, for a field in an aux window. */
  readonly ownerDocument?: Document;
}

/**
 * The 36px date field, drawn by Canopy rather than the operating system so it
 * follows the app's theme. The trigger is the `Select` field; it opens a
 * month calendar in a `Popover`. The value is a local `YYYY-MM-DD` day, the
 * same string a native date input holds.
 */
export const DateField = forwardRef<HTMLButtonElement, DateFieldProps>(
  function DateField(
    {
      value,
      onValueChange,
      min,
      placeholder = 'Choose a date',
      disabled = false,
      id,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedBy,
      'aria-invalid': ariaInvalid,
      'data-testid': dataTestId,
      ownerDocument,
    }: DateFieldProps,
    forwardedRef,
  ): JSX.Element {
    const [open, setOpen] = useState(false);
    if (disabled && open) setOpen(false);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const focusedDayRef = useRef<HTMLButtonElement | null>(null);
    const calendarId = useId();
    const describedBy = useFormFieldDescribedBy(id, ariaDescribedBy);
    const labelledBy = useFormFieldLabelledBy(id, ariaLabel, undefined);
    const selected = parseIsoDateValue(value);
    const minDate = min ? parseIsoDateValue(min) : null;

    return (
      <span className="relative flex w-full">
        <FieldPickerTrigger
          ref={(element) => {
            triggerRef.current = element;
            if (typeof forwardedRef === 'function') forwardedRef(element);
            else if (forwardedRef) forwardedRef.current = element;
          }}
          id={id}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? calendarId : undefined}
          aria-label={ariaLabel}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={ariaInvalid}
          disabled={disabled}
          data-testid={dataTestId}
          data-value={value}
          onClick={() => setOpen((current) => !current)}
        >
          <span
            className={`min-w-0 flex-1 truncate ${selected ? '' : 'fg-tertiary'}`}
          >
            {selected ? getDateFormats().trigger.format(selected) : placeholder}
          </span>
        </FieldPickerTrigger>
        <FieldPickerChevron />
        <Popover
          open={open}
          onOpenChange={setOpen}
          anchorRef={triggerRef}
          ownerDocument={ownerDocument}
          gap={FLOATING_MENU_GAP}
          width="content"
          initialFocusRef={focusedDayRef}
          id={calendarId}
          aria-label="Choose a date"
          data-testid={dataTestId ? `${dataTestId}-calendar` : undefined}
        >
          {open ? (
            <MonthCalendar
              selected={selected}
              min={minDate}
              focusedDayRef={focusedDayRef}
              onPick={(day) => {
                onValueChange(toIsoDateValue(day));
                setOpen(false);
              }}
            />
          ) : null}
        </Popover>
      </span>
    );
  },
);

DateField.displayName = 'DateField';
