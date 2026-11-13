'use client';

import {
  forwardRef,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type JSX,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import type { AppError } from '@canopy/protocol/app-errors';
import { ChevronDownMediumIcon, WarningIcon } from '../icons/AppIcons';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { DROPDOWN_TRIGGER_INTERACTION_CLASS } from './Button';
import { useDialogFormFieldDescribedBy } from './dialog-form-field-context';
import { FLOATING_MENU_GAP } from './FloatingMenu';
import {
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
} from './PickerMenu';

/**
 * Canonical form fields shared by desktop and web: `TextInput`, `TextArea`,
 * and `Select`. One recipe owns the box so every field reads the same:
 *
 * - Edge: `shadow-field`, the UI-Kit 1px inset `line-base` edge. It is a
 *   box-shadow rather than a border so focus can replace it outright.
 * - Focus: `shadow-field-focus`, a neutral grey edge with a soft halo,
 *   swapped in on `:focus-visible` (text fields match it for pointer focus
 *   too). No accent and no outline stacked around the edge.
 * - Inset: 12px across, 8px down, so a single-line field is 36px from its
 *   padding and a textarea's first line sits where single-line text does.
 *   A `compact` text input is the 28px toolbar field (the browser's address
 *   bar): 10px across, with the 10px radius of the 28px fields beside it,
 *   and 13px text like the tab titles above it.
 * - Text: typed values wrap normally, because `text-wrap: pretty` re-breaks
 *   finished lines as the last one grows; placeholders never change and
 *   stay pretty.
 *
 * `className` is for placement only (width, margins, flex). Surface, edge,
 * radius, inset, typography, and states belong here.
 */
/**
 * The field edge at rest. A composite field (`SearchField`) draws it on the
 * box around its input and swaps in {@link FIELD_FOCUS_WITHIN_CLASS}.
 */
export const FIELD_EDGE_CLASS = 'shadow-field transition-shadow';

/**
 * The neutral field focus, for a box whose input has focus. A field never
 * fills on hover or focus: the edge and halo alone show focus.
 */
export const FIELD_FOCUS_WITHIN_CLASS = 'has-[input:focus]:shadow-field-focus';

/**
 * The invalid field (`aria-invalid`): the destructive edge at rest and the
 * destructive focus (edge + soft halo) while focused, never the grey focus
 * halo around a red edge. For a field whose own element is focused.
 */
export const FIELD_INVALID_CLASS =
  'aria-invalid:shadow-field-invalid aria-invalid:focus-visible:shadow-field-invalid-focus';

/** The same for a box around an input (`TextInput` adornments). */
const FIELD_INVALID_WITHIN_CLASS =
  'has-[input[aria-invalid=true]]:shadow-field-invalid has-[input[aria-invalid=true]:focus]:shadow-field-invalid-focus';

// Touch screens get 16px text: iOS Safari zooms the page into a focused
// field set smaller than 16px.
const FIELD_SURFACE_CLASS = `w-full bg-transparent text-s pointer-coarse:text-m fg-primary text-wrap placeholder:text-pretty placeholder:fg-tertiary outline-none ${FIELD_EDGE_CLASS} focus-visible:shadow-field-focus ${FIELD_INVALID_CLASS} disabled:cursor-not-allowed disabled:bg-disabled disabled:fg-disabled`;

const FIELD_CLASS = `min-h-9 rounded-lg px-3 py-2 pointer-coarse:min-h-11 ${FIELD_SURFACE_CLASS}`;

/**
 * Field size. `default` is the 36px form field (12px corners). `compact` is
 * the 28px field that sits in a toolbar row of 28px controls. `settings` is
 * the same 28px rounded rectangle (10px `rounded-row` corners, about the
 * 36px field's 12px scaled to 28px; 10px insets) on a Settings,
 * account, or organization page: it keeps the value on one line. Every
 * density marks an invalid value with the destructive edge. Fields are rounded rectangles and
 * only buttons are capsules (design decision, 2026-10-30).
 */
export type TextInputDensity = 'default' | 'compact' | 'settings';

const TEXT_INPUT_CLASS: Record<TextInputDensity, string> = {
  default: FIELD_CLASS,
  settings: `h-7 rounded-row px-2.5 py-0 pointer-coarse:h-9 ${FIELD_SURFACE_CLASS.replace('text-s ', 'text-xs ').replace('text-wrap placeholder:text-pretty', 'whitespace-nowrap placeholder:whitespace-nowrap')}`,
  // The toolbar field reads at the 13px of the tab titles and controls
  // around it, one step under a form field's 14px.
  compact: `h-7 rounded-row px-2.5 py-0 pointer-coarse:h-9 ${FIELD_SURFACE_CLASS.replace('text-s ', 'text-xs ')}`,
};

/**
 * The box of a field with a `leading` or `trailing` adornment: the same
 * height, corners, insets, and edge as the plain field, drawn around the
 * adornments and a borderless input, with the neutral focus edge while the
 * input has focus.
 */
const ADORNED_BOX_CLASS: Record<TextInputDensity, string> = {
  default: `min-h-9 rounded-lg px-3 pointer-coarse:min-h-11 text-s pointer-coarse:text-m`,
  compact: `h-7 rounded-row px-2.5 pointer-coarse:h-9 text-xs pointer-coarse:text-m`,
  settings: `h-7 rounded-row px-2.5 pointer-coarse:h-9 text-xs pointer-coarse:text-m whitespace-nowrap`,
};

const ADORNED_SHELL_CLASS = `flex w-full min-w-0 items-baseline gap-1.5 bg-transparent fg-primary ${FIELD_EDGE_CLASS} ${FIELD_FOCUS_WITHIN_CLASS} ${FIELD_INVALID_WITHIN_CLASS} has-[input:disabled]:cursor-not-allowed has-[input:disabled]:bg-disabled has-[input:disabled]:fg-disabled`;

const ADORNED_INPUT_CLASS: Record<TextInputDensity, string> = {
  default: 'py-2',
  compact: 'h-full py-0',
  settings: 'h-full py-0',
};

/**
 * Text adornments (`@`, `days`, `$`) inherit the value's size and line and
 * sit on its baseline (the shell aligns its items to the baseline). Icon
 * adornments centre in the field box instead, which for a single line is the
 * optical centre of the value, the way a button centres its icon beside its
 * label.
 */
const ADORNMENT_CLASS: Record<AdornmentKind, string> = {
  text: 'shrink-0 fg-tertiary select-none',
  icon: 'flex shrink-0 items-center self-center fg-tertiary select-none',
};

type AdornmentKind = 'text' | 'icon';

/** A string or number is text; any element is an icon. */
function adornmentKind(node: ReactNode): AdornmentKind {
  return typeof node === 'string' || typeof node === 'number' ? 'text' : 'icon';
}

function Adornment({
  side,
  children,
}: {
  readonly side: 'leading' | 'trailing';
  readonly children: ReactNode;
}): JSX.Element {
  const kind = adornmentKind(children);
  return (
    <span
      data-field-adornment={side}
      data-field-adornment-kind={kind}
      className={ADORNMENT_CLASS[kind]}
    >
      {children}
    </span>
  );
}

function withPlacement(base: string, className: string): string {
  return className ? `${base} ${className}` : base;
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly density?: TextInputDensity;
  /** Monospace for code, commands, and patterns. */
  readonly mono?: boolean;
  /**
   * `center` centers the value, for a field that shows a short summary of
   * its value at rest (an address bar showing only the host).
   */
  readonly align?: 'start' | 'center';
  /**
   * Fixed text or a glyph inside the field edge before the value (`@` before
   * a username), in the tertiary ink like `SearchField`'s icon.
   */
  readonly leading?: ReactNode;
  /** Fixed text or a glyph inside the field edge after the value (a unit). */
  readonly trailing?: ReactNode;
}

/**
 * Single-line text, number, date, password, email, or URL field. With
 * `leading` or `trailing`, the field box moves to a wrapper around the
 * adornments and the input; `ref`, `id`, and every input prop stay on the
 * input, and `className` places the box.
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(
    {
      type = 'text',
      density = 'default',
      mono = false,
      align = 'start',
      className = '',
      leading,
      trailing,
      'aria-describedby': ariaDescribedBy,
      ...props
    },
    ref,
  ): JSX.Element {
    const describedBy = useDialogFormFieldDescribedBy(
      props.id,
      ariaDescribedBy,
    );
    if (leading !== undefined || trailing !== undefined) {
      return (
        <span
          className={withPlacement(
            `${ADORNED_SHELL_CLASS} ${ADORNED_BOX_CLASS[density]}`,
            className,
          )}
          onMouseDown={(event): void => {
            // A press on the box's padding or a text or glyph adornment
            // focuses the input, as a press on a field's edge does; a
            // control inside an adornment (Show password) keeps its press.
            const target = event.target;
            if (
              !(target instanceof Element) ||
              target.closest('input, button, a, select, textarea, [tabindex]')
            ) {
              return;
            }
            event.preventDefault();
            event.currentTarget.querySelector('input')?.focus();
          }}
        >
          {leading !== undefined ? (
            <Adornment side="leading">{leading}</Adornment>
          ) : null}
          <input
            ref={ref}
            type={type}
            className={`min-w-0 flex-1 bg-transparent outline-none placeholder:fg-tertiary disabled:cursor-not-allowed ${ADORNED_INPUT_CLASS[density]} ${align === 'center' ? 'text-center' : ''} ${mono ? 'font-mono' : ''}`}
            aria-describedby={describedBy}
            {...props}
          />
          {trailing !== undefined ? (
            <Adornment side="trailing">{trailing}</Adornment>
          ) : null}
        </span>
      );
    }
    const base =
      align === 'center'
        ? `${TEXT_INPUT_CLASS[density]} text-center`
        : TEXT_INPUT_CLASS[density];
    const treatment = mono ? `${base} font-mono` : base;
    return (
      <input
        ref={ref}
        type={type}
        className={withPlacement(treatment, className)}
        aria-describedby={describedBy}
        {...props}
      />
    );
  },
);

TextInput.displayName = 'TextInput';

/**
 * A field's validation message, directly under the field it is about. Point
 * the field at it with `aria-describedby={id}` and set `aria-invalid`.
 *
 * Show it only after the person submits, keep what they typed, and drop it as
 * soon as they edit the field: a message about a value they are still
 * changing is not news. Say what is needed (`Enter a name.`), never
 * `invalid`. The glyph and the copy carry the destructive ink; the field keeps
 * its shape.
 */
/** Only input errors belong under a field; anything else is a banner. */
export type FieldInputError = Extract<AppError, { kind: 'input' }>;

interface FieldErrorBaseProps {
  readonly id: string;
  /**
   * Announce the message when it appears (`role="alert"`). Set it when the
   * message arrives after an action (a submit, a failed save, a stale value)
   * rather than as the person types.
   */
  readonly announce?: boolean;
  /** A corrective action after the message (`Use suggested name`). */
  readonly action?: ReactNode;
  readonly 'data-testid'?: string;
}

export type FieldErrorProps = FieldErrorBaseProps &
  (
    | { readonly children: ReactNode; readonly error?: never }
    | {
        /**
         * An input error's catalog copy (or its allowed override). Input
         * failures are the person's to fix, so nothing records them.
         */
        readonly error: FieldInputError;
        readonly children?: never;
      }
  );

export function FieldError({
  id,
  announce = false,
  children,
  error,
  action,
  'data-testid': dataTestId,
}: FieldErrorProps): JSX.Element {
  const copy = error
    ? [error.copy.title, error.copy.description].filter(Boolean).join(' ')
    : children;
  return (
    <p
      id={id}
      role={announce ? 'alert' : undefined}
      data-testid={dataTestId}
      className="flex items-start gap-1 text-xs fg-destructive text-pretty"
    >
      {/* One 18px line of the 13px text, so the 12px glyph (the Badge
          recipe: exact size, 1.5px drawn stroke) sits on the first line. */}
      <span aria-hidden="true" className="flex h-4.5 shrink-0 items-center">
        <WarningIcon size={12} exactSize drawnStrokeWidth={1.5} />
      </span>
      <span>{copy}</span>
      {action ? <span className="shrink-0 fg-primary">{action}</span> : null}
    </p>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Monospace for code, commands, and patterns. */
  readonly mono?: boolean;
  /**
   * `field` (the default) is the form field. `composer` is the editor of a
   * composer prompt's text row where the chat's own composer is not there
   * to supply one (the Feed's plan reply): the composer's text with no
   * field edge, one line that grows with what is typed, never resized.
   */
  readonly variant?: 'field' | 'composer';
}

/** The composer prompt's text row: the composer's text, no field edge. */
const COMPOSER_TEXT_AREA_CLASS =
  'block w-full resize-none bg-transparent text-s pointer-coarse:text-m fg-primary outline-none field-sizing-content placeholder:fg-tertiary disabled:cursor-not-allowed';

/**
 * Multi-line field. Keeps native vertical resizing; `field-resize-grip`
 * repaints Chromium's grip 4px clear of the edge instead of flush in the
 * rounded corner.
 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  function TextArea(
    {
      rows,
      mono = false,
      variant = 'field',
      className = '',
      'aria-describedby': ariaDescribedBy,
      ...props
    },
    ref,
  ): JSX.Element {
    const describedBy = useDialogFormFieldDescribedBy(
      props.id,
      ariaDescribedBy,
    );
    const treatment =
      variant === 'composer'
        ? COMPOSER_TEXT_AREA_CLASS
        : `${FIELD_CLASS} field-resize-grip resize-y${mono ? ' font-mono' : ''}`;
    return (
      <textarea
        ref={ref}
        rows={rows ?? (variant === 'composer' ? 1 : 2)}
        className={withPlacement(treatment, className)}
        aria-describedby={describedBy}
        {...props}
      />
    );
  },
);

TextArea.displayName = 'TextArea';

/**
 * An open `Select` shows the focus edge (destructive when invalid) while
 * focus is in its menu, like the 28px dropdowns' `DROPDOWN_INVALID_CLASS`.
 */
const SELECT_OPEN_EDGE_CLASS =
  'aria-expanded:shadow-field-focus aria-invalid:aria-expanded:shadow-field-invalid-focus';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  /** The label is a user-authored title, masked in session replay. */
  readonly maskInReplay?: boolean;
}

export interface SelectProps {
  readonly options: readonly SelectOption[];
  /** The chosen value, or `null` while nothing is chosen. */
  readonly value: string | null;
  readonly onValueChange: (value: string) => void;
  /** Shown in the tertiary ink while nothing is chosen. */
  readonly placeholder?: string;
  /**
   * The labels and placeholder are conversation content: session replay
   * blocks them and records the field and its options. Option values are
   * recorded (`data-value`), so they must carry no content.
   */
  readonly blockLabelsInReplay?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  /** The error and help text that describe the field (`FormField` sets it). */
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
  readonly 'data-testid'?: string;
  /** Placement only (width, margins, flex). */
  readonly className?: string;
}

/**
 * The 36px dropdown, for a form whose single-line fields are the 36px
 * `TextInput`. Everywhere else (Settings rows, dialogs with 28px fields,
 * toolbars, filters) use the 28px `SettingsSelect`: a dropdown matches the
 * height of the fields and buttons beside it (docs/design/forms.md).
 *
 * Single-choice select drawn by Canopy rather than the operating system. The
 * trigger is a field (same edge, focus, inset, and app chevron as
 * `TextInput`); the menu is the shared picker (`FloatingPickerMenu` with
 * `PickerMenuOption` rows and a checkmark on the chosen one), at least as wide
 * as the field.
 *
 * `FloatingMenu`'s listbox mode owns the keyboard: ArrowUp/ArrowDown on the
 * trigger open the menu on the chosen option, arrows, Home, and End move,
 * typing jumps to a matching label, Enter or Space choose, and Escape, Tab,
 * or an outside press close with focus back on the trigger.
 *
 * For several choices use `Checkbox` rows; there is no multiple mode.
 *
 * The ref is the trigger (to focus it on open). The trigger and each option
 * carry `data-value`, so UI automation can read and choose by value as it
 * would on a native `<select>`.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  function Select(
    {
      options,
      value,
      onValueChange,
      placeholder = 'Choose an option',
      blockLabelsInReplay = false,
      disabled = false,
      required,
      id,
      'aria-label': ariaLabel,
      'aria-labelledby': ariaLabelledBy,
      'aria-describedby': ariaDescribedBy,
      'aria-invalid': ariaInvalid,
      'data-testid': dataTestId,
      className = '',
    }: SelectProps,
    forwardedRef,
  ): JSX.Element {
    const [open, setOpen] = useState(false);
    // Disabling the field closes its menu for good: enabling it again does
    // not pop the menu back open.
    if (disabled && open) setOpen(false);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const listboxId = useId();
    const generatedTriggerId = useId();
    const triggerId = id ?? generatedTriggerId;
    const describedBy = useDialogFormFieldDescribedBy(id, ariaDescribedBy);
    const chosen = options.find((option) => option.value === value);

    return (
      <span className={withPlacement('relative flex w-full', className)}>
        <FieldPickerTrigger
          ref={(element) => {
            triggerRef.current = element;
            if (typeof forwardedRef === 'function') forwardedRef(element);
            else if (forwardedRef) forwardedRef.current = element;
          }}
          id={triggerId}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={describedBy}
          aria-invalid={ariaInvalid}
          aria-required={required}
          disabled={disabled}
          data-testid={dataTestId}
          data-value={chosen?.value}
          onClick={() => setOpen((current) => !current)}
        >
          <span
            className={`min-w-0 flex-1 truncate ${chosen ? '' : 'fg-tertiary'}${blockLabelsInReplay ? ` ${REPLAY_BLOCK_CLASS}` : chosen?.maskInReplay ? ` ${REPLAY_MASK_CLASS}` : ''}`}
          >
            {chosen?.label ?? placeholder}
          </span>
        </FieldPickerTrigger>
        <FieldPickerChevron />
        <FloatingPickerMenu
          open={open}
          onOpenChange={setOpen}
          anchorRef={triggerRef}
          placement="bottom-left"
          // A field-attached menu sits closer than a free-standing picker.
          gap={FLOATING_MENU_GAP}
          interaction="listbox"
          role="listbox"
          id={listboxId}
          // With no name of its own (a `FormField` names the trigger with a
          // `<label>`), the trigger names the menu.
          aria-label={ariaLabel}
          aria-labelledby={
            ariaLabelledBy ?? (ariaLabel ? undefined : triggerId)
          }
          // A field-wide select opens a menu as wide as the field.
          maximumWidth="max(20rem, var(--canopy-picker-trigger-width))"
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <PickerMenuOption
                key={option.value}
                role="option"
                data-value={option.value}
                aria-selected={selected}
                selected={selected}
                disabled={option.disabled}
                onClick={() => onValueChange(option.value)}
              >
                <PickerMenuOptionContent>
                  <PickerMenuOptionLabel>
                    {blockLabelsInReplay ? (
                      <span className={REPLAY_BLOCK_CLASS}>{option.label}</span>
                    ) : option.maskInReplay ? (
                      <span className={REPLAY_MASK_CLASS}>{option.label}</span>
                    ) : (
                      option.label
                    )}
                  </PickerMenuOptionLabel>
                </PickerMenuOptionContent>
                <PickerMenuOptionCheck selected={selected} />
              </PickerMenuOption>
            );
          })}
        </FloatingPickerMenu>
      </span>
    );
  },
);

Select.displayName = 'Select';

/**
 * The 36px field that opens a Canopy-drawn picker: `Select`'s listbox and
 * `DateField`'s calendar. Same edge, focus, inset, and press as `TextInput`;
 * open, it keeps the focus edge while focus is in the picker. Pair it with
 * `FieldPickerChevron` inside a `relative` wrapper.
 */
export const FieldPickerTrigger = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'>
>(function FieldPickerTrigger(props, ref): JSX.Element {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      // Presses, hovers, and holds its open look like the secondary Button;
      // the transition keeps the focus edge and adds the press (the
      // press sets `scale`, not `transform`). Open, focus is in the menu,
      // so the trigger keeps the focus edge itself, as SettingsSelect does.
      className={`${FIELD_CLASS.replace('transition-shadow', 'transition-[box-shadow,transform,scale]')} ${DROPDOWN_TRIGGER_INTERACTION_CLASS} ${SELECT_OPEN_EDGE_CLASS} flex cursor-pointer items-center pr-9 text-left disabled:pointer-events-none disabled:cursor-not-allowed`}
    />
  );
});

FieldPickerTrigger.displayName = 'FieldPickerTrigger';

/** The app chevron at the end of a `FieldPickerTrigger`. */
export function FieldPickerChevron(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 fg-tertiary"
    >
      <ChevronDownMediumIcon size={16} />
    </span>
  );
}
