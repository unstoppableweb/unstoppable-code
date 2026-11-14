'use client';

import {
  forwardRef,
  useLayoutEffect,
  useRef,
  type ForwardedRef,
  type InputHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { CheckIcon } from '../icons/AppIcons';
import { WORKSPACE_GLYPH_RADIUS_CLASS } from './WorkspaceKindBadge';

/**
 * Canonical choice marks shared by desktop and web: `Checkbox`, `Radio`, and
 * the display-only `ChoiceMark` for rows that are buttons (design decision,
 * 2026-10-30: a radio looks like a radio, a checkbox like a checkbox).
 *
 * - Shape: 16px. A checkbox is a rounded square with the project glyph's
 *   corner (`WORKSPACE_GLYPH_RADIUS_CLASS`, 5px), so a selection mark and a
 *   project icon line up as one shape; a radio is a circle.
 * - Unselected: a thin inset ring in the quiet `fg-quaternary` ink.
 * - Selected: the accent fill. A checkbox shows the white (`fg-emphasis`)
 *   check, a mixed checkbox a white dash, a radio a white centre dot — never
 *   a check.
 * - Hover: a stronger ring unselected, the accent darkened by the
 *   `glow-on-accent-hover` overlay selected. Pressed: a touch darker again.
 * - Focus: the neutral `shadow-field-focus` halo, and a dark ring when
 *   unselected.
 * - Disabled: the quiet ring unselected; the disabled fill and ink selected,
 *   never the accent.
 *
 * `Checkbox` and `Radio` draw the native input itself as the mark, so the
 * real control stays visible and clickable (and reachable by `.check()` in UI
 * automation), and `:checked` / `:indeterminate` drive the look. `className`
 * places the mark; its look belongs here.
 */

type ChoiceKind = 'checkbox' | 'radio';

/**
 * Draws hover or pressed without the pointer, for the fields lab's state
 * matrix and visual tests only. The forced classes are the same as the live
 * ones.
 */
export type ChoiceForcedState = 'hover' | 'pressed';

const SHAPE: Record<ChoiceKind, string> = {
  checkbox: WORKSPACE_GLYPH_RADIUS_CLASS,
  radio: 'rounded-full',
};

/** The native input as the mark: every state comes from its pseudo-classes. */
const INPUT_MARK_CLASS = [
  // No transition: hover, press and selection colors change at once.
  'peer size-4 shrink-0 cursor-pointer appearance-none outline-none',
  // Unselected.
  'ring-1 ring-inset ring-fg-quaternary',
  'enabled:hover:ring-fg-tertiary data-[force-state=hover]:ring-fg-tertiary',
  'enabled:active:ring-fg-secondary data-[force-state=pressed]:ring-fg-secondary',
  // Selected and mixed: the accent fill, darkened on hover and press.
  'checked:bg-accent checked:ring-0',
  'enabled:checked:hover:[background-image:linear-gradient(var(--glow-on-accent-hover),var(--glow-on-accent-hover))]',
  'checked:data-[force-state=hover]:[background-image:linear-gradient(var(--glow-on-accent-hover),var(--glow-on-accent-hover))]',
  'enabled:checked:active:[background-image:linear-gradient(var(--glow-on-accent-pressed),var(--glow-on-accent-pressed))]',
  'checked:data-[force-state=pressed]:[background-image:linear-gradient(var(--glow-on-accent-pressed),var(--glow-on-accent-pressed))]',
  // Focus: the neutral halo, and a dark ring when unselected.
  'focus-visible:shadow-field-focus focus-visible:ring-fg-secondary',
  // Disabled: quiet ring; selected takes the disabled fill, not the accent.
  'disabled:cursor-not-allowed disabled:ring-line-disabled disabled:checked:bg-disabled',
].join(' ');

/**
 * A mixed checkbox looks selected. Checkbox only: an unchecked radio with no
 * checked radio in its group also matches `:indeterminate`.
 */
const CHECKBOX_MIXED_CLASS =
  'indeterminate:bg-accent indeterminate:ring-0 enabled:indeterminate:hover:[background-image:linear-gradient(var(--glow-on-accent-hover),var(--glow-on-accent-hover))] disabled:indeterminate:bg-disabled';

const MARK_REVEAL_CLASS: Record<ChoiceKind, string> = {
  checkbox: 'peer-checked:opacity-100 peer-indeterminate:opacity-100',
  radio: 'peer-checked:opacity-100',
};

/** The same look for `ChoiceMark`, driven by props instead of the input. */
const MARK_OFF =
  'ring-1 ring-inset ring-fg-quaternary group-hover/choice-row:ring-fg-tertiary data-[force-state=hover]:ring-fg-tertiary data-[force-state=pressed]:ring-fg-secondary';
const MARK_ON =
  'bg-accent group-hover/choice-row:[background-image:linear-gradient(var(--glow-on-accent-hover),var(--glow-on-accent-hover))] data-[force-state=hover]:[background-image:linear-gradient(var(--glow-on-accent-hover),var(--glow-on-accent-hover))] data-[force-state=pressed]:[background-image:linear-gradient(var(--glow-on-accent-pressed),var(--glow-on-accent-pressed))]';
const MARK_DISABLED_OFF = 'ring-1 ring-inset ring-line-disabled';
const MARK_DISABLED_ON = 'bg-disabled';

type Glyph = 'check' | 'dash' | 'dot';

function glyphFor(kind: ChoiceKind, indeterminate: boolean): Glyph {
  if (kind === 'radio') return 'dot';
  return indeterminate ? 'dash' : 'check';
}

/** The white mark on the accent fill; the disabled ink when disabled. */
function GlyphMark({
  glyph,
  disabled,
}: {
  readonly glyph: Glyph;
  readonly disabled: boolean;
}): JSX.Element {
  if (glyph === 'check') {
    return (
      <span
        // The scale's smallest check (12px) drawn at 85%, about 10px, so it
        // sits inside the 16px mark with room around it; the stroke is
        // widened by the same factor and still draws 2px.
        className={`flex scale-85 ${disabled ? 'fg-disabled' : 'fg-emphasis'}`}
        data-choice-glyph="check"
      >
        <CheckIcon size="xs" exactSize drawnStrokeWidth={2 / 0.85} />
      </span>
    );
  }
  const fill = disabled ? 'bg-fg-disabled' : 'bg-fg-emphasis';
  return glyph === 'dot' ? (
    <span
      data-choice-glyph="dot"
      className={`block size-1.5 rounded-full ${fill}`}
    />
  ) : (
    <span
      data-choice-glyph="dash"
      className={`block h-0.5 w-2 rounded-full ${fill}`}
    />
  );
}

export interface ChoiceMarkProps {
  kind: ChoiceKind;
  checked: boolean;
  /** A checkbox that is partly selected (some of its children). */
  indeterminate?: boolean;
  disabled?: boolean;
  forceState?: ChoiceForcedState;
  className?: string;
}

/**
 * The mark alone, for a row that is itself the control (a `<button>` with
 * `aria-pressed`). Hidden from assistive technology; the row carries the
 * state. Its hover follows the row (`group/choice-row`).
 */
export function ChoiceMark({
  kind,
  checked,
  indeterminate = false,
  disabled = false,
  forceState,
  className = '',
}: ChoiceMarkProps): JSX.Element {
  const on = checked || indeterminate;
  const surface = disabled
    ? on
      ? MARK_DISABLED_ON
      : MARK_DISABLED_OFF
    : on
      ? MARK_ON
      : MARK_OFF;
  return (
    <span
      aria-hidden="true"
      data-force-state={forceState}
      className={`flex size-4 shrink-0 items-center justify-center ${SHAPE[kind]} ${surface} ${className}`}
    >
      {on ? (
        <GlyphMark glyph={glyphFor(kind, indeterminate)} disabled={disabled} />
      ) : null}
    </span>
  );
}

export type CheckboxProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type'
> & {
  /** Checkbox only: partly selected, drawn as a dash (`aria-checked="mixed"`). */
  readonly indeterminate?: boolean;
  readonly forceState?: ChoiceForcedState;
};

function assignRef(
  ref: ForwardedRef<HTMLInputElement>,
  element: HTMLInputElement | null,
): void {
  if (typeof ref === 'function') ref(element);
  else if (ref) ref.current = element;
}

function ChoiceInput({
  kind,
  props: {
    checked,
    indeterminate = false,
    forceState,
    disabled,
    className = '',
    ...props
  },
  forwardedRef,
}: {
  readonly kind: ChoiceKind;
  readonly props: CheckboxProps;
  readonly forwardedRef: ForwardedRef<HTMLInputElement>;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mixed = kind === 'checkbox' && indeterminate;
  // `indeterminate` is a DOM property with no attribute; it also gives the
  // native control `aria-checked="mixed"`. Set before paint so a mixed box
  // never shows unchecked first. A mixed box sets it again on every render,
  // because a click clears it in the DOM even when the parent keeps the box
  // mixed; it is cleared only when the box stops being mixed, so a caller
  // that sets the property on the input itself keeps it.
  useLayoutEffect(() => {
    if (mixed && inputRef.current) inputRef.current.indeterminate = true;
  });
  useLayoutEffect(() => {
    if (!mixed && inputRef.current) inputRef.current.indeterminate = false;
  }, [mixed]);
  return (
    <span className={`relative flex size-4 shrink-0 ${className}`}>
      <input
        ref={(element) => {
          inputRef.current = element;
          assignRef(forwardedRef, element);
        }}
        type={kind}
        checked={checked}
        disabled={disabled}
        data-force-state={forceState}
        className={`${INPUT_MARK_CLASS} ${SHAPE[kind]}${kind === 'checkbox' ? ` ${CHECKBOX_MIXED_CLASS}` : ''}`}
        {...props}
      />
      {/* Shown by the input's own :checked / :indeterminate, so an
          uncontrolled (defaultChecked) mark draws too. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 ${MARK_REVEAL_CLASS[kind]}`}
      >
        <GlyphMark glyph={glyphFor(kind, mixed)} disabled={disabled === true} />
      </span>
    </span>
  );
}

/** A checkbox whose native input is drawn as the shared mark. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox(props, ref): JSX.Element {
    return <ChoiceInput kind="checkbox" props={props} forwardedRef={ref} />;
  },
);

Checkbox.displayName = 'Checkbox';

export type RadioProps = Omit<CheckboxProps, 'indeterminate'>;

/** A radio whose native input is drawn as the shared mark. */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  function Radio(props, ref): JSX.Element {
    return <ChoiceInput kind="radio" props={props} forwardedRef={ref} />;
  },
);

Radio.displayName = 'Radio';

export type ChoiceFieldProps = CheckboxProps & {
  /** `checkbox` (default) or `radio`. */
  readonly kind?: ChoiceKind;
  /** The text beside the mark; clicking it toggles the choice. */
  readonly label: ReactNode;
  /** A quieter line under the label. */
  readonly description?: ReactNode;
  /**
   * Content in the text column after the label, aligned under the label
   * text but outside the clickable label, so links in it stay links and
   * never toggle the choice (the legal consent row's document links).
   */
  readonly trailing?: ReactNode;
  /**
   * `inline` (default) fits the label to its text. `row` makes the label a
   * whole list row: 36px tall (44px for a coarse pointer) with an 8px inset,
   * so a click anywhere on the row, padding included, toggles the choice.
   */
  readonly layout?: ChoiceFieldLayout;
  /**
   * Decorative content at the row's end, inside the label so clicking it
   * toggles the choice too (the ask-user card's letter hint). Hide it from
   * assistive technology; the label text is the accessible name.
   */
  readonly end?: ReactNode;
};

export type ChoiceFieldLayout = 'inline' | 'row';

const FIELD_LAYOUT_CLASS: Record<ChoiceFieldLayout, string> = {
  inline: '',
  // 8 + the 20px text line + 8 fills the 36px row; the 44px coarse row takes
  // 12px so its content stays centred.
  row: 'min-h-9 w-full min-w-0 px-2 py-2 pointer-coarse:min-h-11 pointer-coarse:py-3',
};

/**
 * A checkbox or radio with its text, where the whole row is the label, so
 * clicking the text toggles it (design follow-up, 2026-10-30). The native
 * input keeps its checkbox/radio role and checked state for assistive
 * technology and UI automation. For a list of choices in a box use
 * `ChoiceList`; for a setting that applies at once use `ToggleSwitch`.
 * `className` places the row.
 */
export const ChoiceField = forwardRef<HTMLInputElement, ChoiceFieldProps>(
  function ChoiceField(
    {
      kind = 'checkbox',
      label,
      description,
      trailing,
      layout = 'inline',
      end,
      className = '',
      disabled,
      indeterminate,
      ...props
    },
    ref,
  ): JSX.Element {
    const row = (
      <label
        className={`flex items-start gap-2 text-s ${FIELD_LAYOUT_CLASS[layout]} ${disabled ? 'cursor-not-allowed fg-disabled' : 'cursor-pointer fg-primary'} ${trailing === undefined ? className : ''}`}
      >
        {/* The 16px mark sits on the first 20px line of the label. */}
        <span className="flex h-5 shrink-0 items-center">
          {kind === 'radio' ? (
            <Radio ref={ref} disabled={disabled} {...props} />
          ) : (
            <Checkbox
              ref={ref}
              disabled={disabled}
              indeterminate={indeterminate}
              {...props}
            />
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>{label}</span>
          {description ? (
            <span className="text-xs text-pretty fg-secondary">
              {description}
            </span>
          ) : null}
        </span>
        {end}
      </label>
    );
    if (trailing === undefined) return row;
    return (
      <div className={className}>
        {row}
        {/* Under the label text: the 16px mark and the 8px gap. */}
        <div
          data-choice-field-trailing=""
          className={`pl-6 text-s text-pretty ${disabled ? 'fg-disabled' : 'fg-primary'}`}
        >
          {trailing}
        </div>
      </div>
    );
  },
);

ChoiceField.displayName = 'ChoiceField';
