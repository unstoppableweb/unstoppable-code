import type { JSX } from 'react';
import { CheckIcon } from '../icons/AppIcons';
import { WORKSPACE_COLOR_PALETTE } from './workspace-color-palette';

export interface ColorSwatchOption {
  value: string;
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
}

const SWATCH_SIZE_CLASS_NAMES = {
  default: 'h-6 w-6',
  compact: 'h-5 w-5',
} as const;

// The app checkmark's compact tier, as in a checkbox.
const CHECK_SIZE = 14;

/**
 * The app's one color chooser: a row of fixed palette swatches, the selected
 * one marked with a checkmark inside it (never a ring).
 *
 * Every surface that lets a user color something — workspaces, browser
 * profiles — renders this, so a swatch is the same size, the same shape, and
 * marked the same way wherever it appears. There is deliberately no free-form
 * color input: an arbitrary hue cannot be checked for contrast against the
 * surfaces it lands on, and the palette is what keeps the app's colored marks
 * legible in both color modes.
 *
 * Selection state is the caller's. This component reports a click and nothing
 * else, so a host that tracks dirty state or revisions (the workspace dialog)
 * and one that writes straight through (browser profiles) can share it.
 */
export function ColorSwatchPicker({
  value,
  onChange,
  palette = WORKSPACE_COLOR_PALETTE,
  disabled = false,
  testId,
  size = 'default',
}: ColorSwatchPickerProps): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2" data-testid={testId}>
      {palette.map((option) => {
        const swatch = typeof option === 'string' ? option : option.value;
        const label =
          typeof option === 'string' ? `Color ${option}` : option.label;
        const color = typeof option === 'string' ? option : option.color;
        const selected = value === swatch;
        return (
          <button
            key={swatch}
            type="button"
            aria-label={label}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(swatch)}
            className={`focus-ring inline-flex shrink-0 items-center justify-center rounded-full text-white transition-colors disabled:opacity-60 ${SWATCH_SIZE_CLASS_NAMES[size]} ${
              selected ? '' : 'hover:opacity-80'
            }`}
            style={{ backgroundColor: color }}
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
