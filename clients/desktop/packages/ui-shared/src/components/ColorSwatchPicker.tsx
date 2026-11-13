import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { CheckIcon } from '../icons/AppIcons';
import { parseCssColor, uniqueColorNames } from '../lib/color-names';
import { WORKSPACE_COLOR_PALETTE } from './workspace-color-palette';

export interface ColorSwatchOption {
  value: string;
  /** Read out only until the rendered color has been named. */
  label: string;
  /** Semantic CSS color, independent of the persisted value. */
  color: string;
}

export interface ColorSwatchPickerProps {
  /** Currently selected color, or `undefined` when nothing is chosen yet. */
  value: string | undefined;
  onChange: (color: string) => void;
  /** Defaults to the app-wide workspace palette. */
  palette?: readonly (string | ColorSwatchOption)[];
  disabled?: boolean;
  /** Applied to the swatch row, for automation. */
  testId?: string;
  /**
   * `compact` is the 20px swatch that sits in a settings row beside its
   * label; `default` is the 24px swatch of a menu or a page of its own.
   */
  size?: 'default' | 'compact';
  /** The radio group's accessible name. */
  label?: string;
}

const SWATCH_SIZE_CLASS_NAMES = {
  default: 'h-6 w-6',
  compact: 'h-5 w-5',
} as const;

// The app checkmark's compact tier, as in a checkbox.
const CHECK_SIZE = 14;

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}

/**
 * Each swatch's name, from the color it renders in now: the palette's slots
 * change hue with the theme and brand (CAN-6407). Measured again when the
 * document's theme attributes or the system color scheme change.
 */
function useRenderedColorNames(
  options: readonly ColorSwatchOption[],
  buttons: RefObject<(HTMLButtonElement | null)[]>,
): string[] {
  const initial = useMemo(
    () =>
      uniqueColorNames(
        options.map((option) => parseCssColor(option.color)),
        (index) => options[index]?.label ?? `Color ${index + 1}`,
      ),
    [options],
  );
  const [names, setNames] = useState(initial);
  useLayoutEffect(() => {
    const first = buttons.current?.find((button) => button !== null);
    const view = first?.ownerDocument.defaultView;
    if (!first || !view) {
      setNames((previous) =>
        sameNames(previous, initial) ? previous : initial,
      );
      return;
    }
    const measure = (): void => {
      const measured = uniqueColorNames(
        options.map((_, index) => {
          const button = buttons.current?.[index];
          return button
            ? parseCssColor(view.getComputedStyle(button).backgroundColor)
            : null;
        }),
        (index) => initial[index] ?? `Color ${index + 1}`,
      );
      setNames((previous) =>
        sameNames(previous, measured) ? previous : measured,
      );
    };
    measure();
    const observer = new view.MutationObserver(measure);
    observer.observe(first.ownerDocument.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-brand', 'style'],
    });
    const scheme = view.matchMedia?.('(prefers-color-scheme: dark)');
    scheme?.addEventListener?.('change', measure);
    return (): void => {
      observer.disconnect();
      scheme?.removeEventListener?.('change', measure);
    };
  }, [buttons, initial, options]);
  return names;
}

/**
 * The app's one color chooser: a row of fixed palette swatches, the selected
 * one marked with a checkmark inside it (never a ring).
 *
 * Every surface that lets a user color something — workspaces, sidebar
 * groups, browser profiles — renders this, so a swatch is the same size, the
 * same shape, and marked the same way wherever it appears. There is
 * deliberately no free-form color input: an arbitrary hue cannot be checked
 * for contrast against the surfaces it lands on, and the palette is what
 * keeps the app's colored marks legible in both color modes.
 *
 * The row is a radio group: each swatch is announced by the name of the
 * color it shows, the selected one is checked, and arrow keys move the
 * choice. Selection state is the caller's. This component reports a choice
 * and nothing else, so a host that tracks dirty state or revisions (the
 * workspace dialog) and one that writes straight through (browser profiles)
 * can share it.
 */
export function ColorSwatchPicker({
  value,
  onChange,
  palette = WORKSPACE_COLOR_PALETTE,
  disabled = false,
  testId,
  size = 'default',
  label = 'Color',
}: ColorSwatchPickerProps): JSX.Element {
  const options = useMemo(
    (): ColorSwatchOption[] =>
      palette.map((option) =>
        typeof option === 'string'
          ? { value: option, label: `Color ${option}`, color: option }
          : option,
      ),
    [palette],
  );
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const names = useRenderedColorNames(options, buttons);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0;

  const choose = (index: number): void => {
    const option = options[index];
    if (!option) return;
    buttons.current[index]?.focus();
    onChange(option.value);
  };
  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    if (disabled || options.length === 0) return;
    const last = options.length - 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    choose(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className="flex flex-wrap gap-2"
      data-testid={testId}
    >
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={option.value}
            ref={(button): void => {
              buttons.current[index] = button;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={names[index] ?? option.label}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`focus-ring inline-flex shrink-0 items-center justify-center rounded-full text-white transition-colors disabled:opacity-60 ${SWATCH_SIZE_CLASS_NAMES[size]} ${
              selected ? '' : 'hover:opacity-80'
            }`}
            style={{ backgroundColor: option.color }}
          >
            {selected ? (
              <CheckIcon size={CHECK_SIZE} aria-hidden={true} />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
