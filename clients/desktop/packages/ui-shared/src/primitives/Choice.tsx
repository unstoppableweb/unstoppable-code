'use client';

import {
  forwardRef,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  type ForwardedRef,
  type InputHTMLAttributes,
  type FocusEvent,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { CheckIcon } from '../icons/AppIcons';
import { WORKSPACE_GLYPH_RADIUS_CLASS } from '../lib/workspace-glyph';
import { ChoiceListContext } from './choice-list-context';

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
 * - Disabled: the quiet ring unselected; selected, the muted fill with the
 *   disabled ink, never the accent. The fill is the translucent `bg-muted`,
 *   so the box reads the same on a page, a card or a white group; the opaque
 *   `bg-disabled` all but vanished on the page surface.
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
  // Unselected. Hovering the input's label hovers the input too.
  'ring-1 ring-inset ring-fg-quaternary',
  'enabled:hover:ring-fg-tertiary data-[force-state=hover]:ring-fg-tertiary',
  'enabled:active:ring-fg-secondary data-[force-state=pressed]:ring-fg-secondary',
  // Selected and mixed: the accent fill, darkened on hover and press.
  'checked:bg-accent checked:ring-0',
  'enabled:checked:hover:[background-image:linear-gradient(var(--glow-on-accent-hover),var(--glow-on-accent-hover))]',
  'checked:data-[force-state=hover]:[background-image:linear-gradient(var(--glow-on-accent-hover),var(--glow-on-accent-hover))]',
  'enabled:checked:active:[background-image:linear-gradient(var(--glow-on-accent-pressed),var(--glow-on-accent-pressed))]',
  'checked:data-[force-state=pressed]:[background-image:linear-gradient(var(--glow-on-accent-pressed),var(--glow-on-accent-pressed))]',
  // Disabled: quiet ring; selected takes the muted fill, not the accent.
  'disabled:cursor-not-allowed disabled:ring-line-disabled disabled:checked:bg-muted',
].join(' ');

/** Focus: the neutral halo, and a dark ring when unselected. */
const INPUT_MARK_FOCUS_CLASS =
  'focus-visible:shadow-field-focus focus-visible:ring-fg-secondary';

/**
 * The disabled look on an input that stays focusable (`aria-disabled`): the
 * quiet ring, the muted fill selected, and no hover or press.
 */
const INPUT_MARK_INERT_CLASS =
  'peer size-4 shrink-0 cursor-not-allowed appearance-none outline-none ring-1 ring-inset ring-line-disabled checked:bg-muted checked:ring-0';

/**
 * A mixed checkbox looks selected. Checkbox only: an unchecked radio with no
 * checked radio in its group also matches `:indeterminate`.
 */
const CHECKBOX_MIXED_CLASS =
  'indeterminate:bg-accent indeterminate:ring-0 enabled:indeterminate:hover:[background-image:linear-gradient(var(--glow-on-accent-hover),var(--glow-on-accent-hover))] disabled:indeterminate:bg-muted';
const CHECKBOX_MIXED_INERT_CLASS =
  'indeterminate:bg-muted indeterminate:ring-0';

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
const MARK_DISABLED_ON = 'bg-muted';

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
 * The mark alone, for a row that is itself the control and carries other
 * semantics (a `<button>` with `aria-pressed`, a sidebar row in selection
 * mode). Hidden from assistive technology; the row carries the state. Its
 * hover follows the row (`group/choice-row`). A plain list of choices uses
 * `ChoiceField layout="row"` in a `ChoiceList`, with a native input.
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
  inert = false,
  rowFocus = false,
}: {
  readonly kind: ChoiceKind;
  readonly props: CheckboxProps;
  readonly forwardedRef: ForwardedRef<HTMLInputElement>;
  /** Draw the disabled look on an input that stays focusable. */
  readonly inert?: boolean;
  /** The row around the input draws its keyboard focus, not the mark. */
  readonly rowFocus?: boolean;
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
        className={[
          inert ? INPUT_MARK_INERT_CLASS : INPUT_MARK_CLASS,
          rowFocus ? '' : INPUT_MARK_FOCUS_CLASS,
          SHAPE[kind],
          kind === 'checkbox'
            ? inert
              ? CHECKBOX_MIXED_INERT_CLASS
              : CHECKBOX_MIXED_CLASS
            : '',
        ]
          .filter((part) => part !== '')
          .join(' ')}
        {...props}
      />
      {/* Shown by the input's own :checked / :indeterminate, so an
          uncontrolled (defaultChecked) mark draws too. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 ${MARK_REVEAL_CLASS[kind]}`}
      >
        <GlyphMark
          glyph={glyphFor(kind, mixed)}
          disabled={disabled === true || inert}
        />
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
   * Text that continues the label's sentence on the same line but sits
   * outside the clickable label, so links in it stay links and never toggle
   * the choice (the legal consent row's document links).
   */
  readonly trailing?: ReactNode;
  /**
   * `inline` (default) fits the label to its text. `row` makes the label a
   * whole list row: 36px tall (44px for a coarse pointer) with an 8px inset,
   * so a click anywhere on the row, padding included, toggles the choice.
   * In a `ChoiceList` the row takes the list's look: a 12px inset, a hover
   * and focus fill, and the focus ring inside the row.
   */
  readonly layout?: ChoiceFieldLayout;
  /**
   * Content at the row's end, inside the label so clicking it toggles the
   * choice too: the ask-user card's letter hint (hide it from assistive
   * technology), or in a `ChoiceList` a quiet note or badge.
   */
  readonly end?: ReactNode;
  /**
   * With `disabled`, the input stays focusable (`aria-disabled`) and never
   * toggles, so a host's arrow keys can move through it.
   */
  readonly focusableWhenDisabled?: boolean;
};

export type ChoiceFieldLayout = 'inline' | 'row';

const FIELD_LAYOUT_CLASS: Record<ChoiceFieldLayout, string> = {
  inline: '',
  // 8 + the 20px text line + 8 fills the 36px row; the 44px coarse row takes
  // 12px so its content stays centred.
  row: 'min-h-9 w-full min-w-0 px-2 py-2 pointer-coarse:min-h-11 pointer-coarse:py-3',
};

/**
 * A row in a `ChoiceList`. The list scrolls, and would cut an outside ring
 * off at its sides and the first row's top, so the focus ring sits inside
 * the row; the end rows take the list's corner, so their ring and fill
 * follow the curve.
 */
const LIST_ROW_CLASS =
  'flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-s fg-primary transition-colors first:rounded-t-lg last:rounded-b-lg pointer-coarse:min-h-11 has-[:focus-visible]:bg-subtle has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-line-focus';
// A disabled fieldset disables the input without the prop, so the row reads
// the input's own state.
const LIST_ROW_ENABLED_CLASS =
  'cursor-pointer hover:bg-subtle has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-60 has-[input:disabled]:hover:bg-transparent';
const LIST_ROW_DISABLED_CLASS = 'cursor-not-allowed opacity-60';

/**
 * Keyboard focus lands on the 16px input, so the browser scrolls only the
 * mark into view; bring the whole row in, so a scrolling list never cuts the
 * focused row's ring and fill off at its edge.
 */
function revealFocusedRow(event: FocusEvent<HTMLLabelElement>): void {
  if (event.target.matches(':focus-visible')) {
    event.currentTarget.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * Keys that press the input the way the old button row did. In a
 * `ChoiceList` row, Enter clicks the input: it checks a radio and toggles a
 * checkbox (a native input ignores Enter). A radio with an `onClick` that is
 * already chosen also clicks itself on Space, which a native radio ignores,
 * so a caller can act on pressing the chosen answer again (clear it, retry
 * its load).
 */
function pressLikeRow(
  own: KeyboardEventHandler<HTMLInputElement> | undefined,
  enterClicks: boolean,
  repressChosen: boolean,
): KeyboardEventHandler<HTMLInputElement> {
  return (event: KeyboardEvent<HTMLInputElement>): void => {
    own?.(event);
    if (event.defaultPrevented) return;
    const chosenRepress = repressChosen && event.currentTarget.checked;
    const press =
      (event.key === 'Enter' && (enterClicks || chosenRepress)) ||
      (event.key === ' ' && chosenRepress);
    if (!press) return;
    event.preventDefault();
    event.currentTarget.click();
  };
}

/** Keeps a focusable disabled choice from toggling. */
function preventToggle(event: MouseEvent<HTMLInputElement>): void {
  event.preventDefault();
}

/**
 * A checkbox or radio with its text, where the whole row is the label, so
 * clicking the text toggles it (design follow-up, 2026-10-30). The native
 * input keeps its checkbox/radio role and checked state for assistive
 * technology and UI automation. For a list of choices in a box use
 * `ChoiceField layout="row"` inside `ChoiceList`; for a setting that applies
 * at once use `ToggleSwitch`. `className` places the row.
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
      focusableWhenDisabled = false,
      ...props
    },
    ref,
  ): JSX.Element {
    const list = useContext(ChoiceListContext);
    const generatedId = useId();
    const inputId = props.id ?? generatedId;
    const inListRow =
      list !== null && layout === 'row' && trailing === undefined;
    const inert = focusableWhenDisabled && disabled === true;
    const inputProps: CheckboxProps = {
      ...props,
      id: inputId,
      // A radio list's radios share its name, so the browser groups them.
      name: kind === 'radio' ? (props.name ?? list?.radioName) : props.name,
      onKeyDown: pressLikeRow(
        props.onKeyDown,
        inListRow && !inert,
        kind === 'radio' && props.onClick !== undefined,
      ),
      ...(inert
        ? {
            'aria-disabled': true,
            readOnly: true,
            onChange: undefined,
            onClick: preventToggle,
          }
        : { disabled }),
      ...(kind === 'checkbox' ? { indeterminate } : {}),
    };
    const cursorClass = disabled ? 'cursor-not-allowed' : 'cursor-pointer';
    const toneClass = disabled ? 'fg-disabled' : 'fg-primary';
    /* The 16px mark sits on the first 20px line of the label. */
    const mark = (
      <span className="flex h-5 shrink-0 items-center">
        <ChoiceInput
          kind={kind}
          props={inputProps}
          forwardedRef={ref}
          inert={inert}
          rowFocus={inListRow}
        />
      </span>
    );
    const descriptionLine = description ? (
      <span className="block text-xs text-pretty fg-secondary">
        {description}
      </span>
    ) : null;
    if (inListRow) {
      return (
        <label
          className={`${LIST_ROW_CLASS} ${disabled ? LIST_ROW_DISABLED_CLASS : LIST_ROW_ENABLED_CLASS} ${className}`}
          onFocus={revealFocusedRow}
        >
          {mark}
          <span className="min-w-0 flex-1">
            {label}
            {descriptionLine}
          </span>
          {end ? (
            <span className="shrink-0 text-xs fg-secondary">{end}</span>
          ) : null}
        </label>
      );
    }
    if (trailing === undefined) {
      return (
        <label
          className={`flex items-start gap-2 text-s ${FIELD_LAYOUT_CLASS[layout]} ${cursorClass} ${toneClass} ${className}`}
        >
          {mark}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span>{label}</span>
            {descriptionLine}
          </span>
          {end}
        </label>
      );
    }
    // The label text toggles the input through `htmlFor`; the trailing text
    // after it in the same sentence does not. The mark's label takes the gap
    // as padding, so the space between mark and text toggles it too.
    return (
      <div
        className={`flex items-start text-s ${FIELD_LAYOUT_CLASS[layout]} ${toneClass} ${className}`}
      >
        <label htmlFor={inputId} className={`pr-2 ${cursorClass}`}>
          {mark}
        </label>
        <span className="min-w-0 text-pretty">
          <label htmlFor={inputId} className={cursorClass}>
            {label}
          </label>{' '}
          <span data-choice-field-trailing="">{trailing}</span>
          {descriptionLine ? (
            <label htmlFor={inputId} className={cursorClass}>
              {descriptionLine}
            </label>
          ) : null}
        </span>
        {end}
      </div>
    );
  },
);

ChoiceField.displayName = 'ChoiceField';
