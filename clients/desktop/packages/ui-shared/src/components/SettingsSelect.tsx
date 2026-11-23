'use client';

import {
  Fragment,
  useCallback,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import { ChevronDownIcon } from '../icons/AppIcons';
import { Button } from './Button';
import { useDialogFormFieldDescribedBy } from './dialog-form-field-context';
import { useInDialogFormField } from './DialogFormField';
import {
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuSectionLabel,
} from './PickerMenu';

/** Settings menus scroll past this height (about six rows). */
const SETTINGS_SELECT_MENU_HEIGHT = 208;

export interface SettingsSelectOption<Value extends string = string> {
  readonly value: Value;
  /** Plain text: the trigger shows it and typing a letter jumps to it. */
  readonly label: string;
  readonly disabled?: boolean;
  /** A small picture before the label, such as a theme's accent dot. */
  readonly preview?: ReactNode;
  readonly testId?: string;
}

/** A labelled run of options, drawn like a native `<optgroup>`. */
export interface SettingsSelectGroup<Value extends string = string> {
  readonly label: string;
  readonly options: readonly SettingsSelectOption<Value>[];
}

export type SettingsSelectItem<Value extends string = string> =
  | SettingsSelectOption<Value>
  | SettingsSelectGroup<Value>;

/**
 * `control` (the default) is the 144px Settings column. `field` is the 208px
 * Settings field width: a dropdown in a group beside text fields takes it,
 * so a group mixing fields and dropdowns lines their edges up on one width.
 * `fit` takes the chosen label's width, for a dropdown inside a sentence.
 * `fill` takes the parent's width, for a column the caller sizes.
 */
export type SettingsSelectWidth = 'control' | 'field' | 'fit' | 'fill';

export interface SettingsSelectProps<Value extends string = string> {
  readonly options: readonly SettingsSelectItem<Value>[];
  /** The chosen value. A value no option has shows the placeholder. */
  readonly value: Value | null;
  readonly onValueChange: (value: Value) => void;
  readonly width?: SettingsSelectWidth;
  /** Shown while no option is chosen; defaults to the first option. */
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Set while the value has not been read or is saving. */
  readonly busy?: boolean;
  readonly id?: string;
  /**
   * Names the trigger and the menu. The menu renders at the page body, so a
   * name that includes user content (a member's name) goes through
   * `aria-labelledby` pointing at in-page elements instead.
   */
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string;
  /**
   * Marks the dropdown invalid (`FormField` passes it with its error): the
   * destructive edge at rest, edge and halo while focused or open.
   */
  readonly 'aria-invalid'?: boolean;
  readonly 'data-testid'?: string;
  /**
   * The trigger, like `Select`'s ref: a host that opens a surface on the
   * dropdown (a popover's first field) focuses it through this ref.
   */
  readonly ref?: Ref<HTMLButtonElement>;
  /**
   * Host-owned replay markers for option labels that name user content: the
   * block class for personal data, the mask class for user-authored titles
   * such as project names. They go on the label text only (the chosen label
   * on the trigger and every option label in the menu), never on the control
   * itself, and never change how either looks. With either set, `data-value`
   * holds the option's position instead of its value, since replay records
   * the attribute as is; option test ids must carry no content either.
   */
  readonly replayPrivacy?: {
    readonly blockClassName?: string;
    readonly maskClassName?: string;
  };
}

function isGroup<Value extends string>(
  item: SettingsSelectItem<Value>,
): item is SettingsSelectGroup<Value> {
  return 'options' in item;
}

/** Every option in order, groups flattened. */
export function settingsSelectOptions<Value extends string>(
  items: readonly SettingsSelectItem<Value>[],
): readonly SettingsSelectOption<Value>[] {
  return items.flatMap((item) => (isGroup(item) ? item.options : [item]));
}

/**
 * The 28px dropdown, for everything except a form of 36px fields (use the
 * 36px `Select` there): Settings rows, dialogs with 28px fields, toolbars,
 * and filters. A dropdown matches the height of the fields and buttons beside
 * it (docs/design/forms.md).
 *
 * The Settings dropdown on desktop and web: a 28px secondary rounded
 * rectangle (`Button size="field"`) that opens Canopy's own picker menu, with a
 * checkmark on the chosen row and no selected-row fill. It is 144px wide by
 * default, so dropdowns in consecutive rows line up; in a dialog's form field
 * (`DialogFormField`) it fills the dialog's content width.
 *
 * The menu owns the keyboard (`FloatingMenu`'s listbox mode): ArrowUp or
 * ArrowDown on the trigger opens it on the chosen option; arrows, Home and
 * End move; typing jumps to a matching label; Enter or Space choose; Escape,
 * Tab or an outside press close with focus back on the trigger.
 *
 * Each option row carries `data-value`, so UI automation can choose by value
 * the way it would on a native `<select>`. With `replayPrivacy` set it is the
 * option's position instead.
 */
export function SettingsSelect<Value extends string>({
  options,
  value,
  onValueChange,
  width = 'control',
  placeholder,
  disabled = false,
  busy = false,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  'data-testid': dataTestId,
  ref,
  replayPrivacy,
}: SettingsSelectProps<Value>): JSX.Element {
  const [open, setOpen] = useState(false);
  // Disabling the dropdown closes its menu for good: enabling it again does
  // not pop the menu back open and take focus.
  if (disabled && open) setOpen(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const setTrigger = useCallback(
    (node: HTMLButtonElement | null): void => {
      anchorRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const listId = useId();
  const triggerId = useId();
  const flat = settingsSelectOptions(options);
  const chosen = flat.find((option) => option.value === value);
  // Like a native select, no placeholder falls back to the first option.
  const showsPlaceholder = !chosen && placeholder !== undefined;
  const shownLabel = chosen?.label ?? placeholder ?? flat[0]?.label ?? '';
  const menuOpen = open && !disabled;
  const describedBy = useDialogFormFieldDescribedBy(id, ariaDescribedBy);
  // The host's replay markers: they never change how the trigger or menu
  // looks.
  // eslint-disable-next-line shadcn/require-static-classes -- host-owned marker, not styling
  const privacyClassName = [
    replayPrivacy?.blockClassName,
    replayPrivacy?.maskClassName,
  ]
    .filter((name): name is string => Boolean(name))
    .join(' ');
  const dataValue = (option: SettingsSelectOption<Value>): string =>
    privacyClassName ? String(flat.indexOf(option)) : option.value;
  // In a dialog's form field the dropdown fills the dialog's content width
  // instead of a Settings row's column.
  const inDialogFormField = useInDialogFormField();
  const shownWidth: SettingsSelectWidth =
    inDialogFormField && width === 'control' ? 'fill' : width;
  // `fill` sits the trigger in a shrinkable wrapper: the shared button never
  // shrinks, so a full-width trigger beside other controls would overflow.
  const widthClassName =
    shownWidth === 'fill'
      ? 'w-full'
      : shownWidth === 'fit'
        ? 'max-w-64'
        : shownWidth === 'field'
          ? 'w-52'
          : 'w-36';
  const wrapperClassName =
    shownWidth === 'fill' ? 'inline-flex w-full min-w-0' : 'contents';

  const renderOption = (option: SettingsSelectOption<Value>): JSX.Element => {
    const selected = option.value === value;
    return (
      <PickerMenuOption
        key={option.value}
        role="option"
        aria-selected={selected}
        selected={selected}
        disabled={option.disabled}
        data-value={dataValue(option)}
        data-testid={option.testId}
        style={{ columnGap: option.preview ? 10 : undefined }}
        // Like a native select, choosing the current value changes nothing.
        onClick={() => {
          if (option.value !== value) onValueChange(option.value);
        }}
      >
        {option.preview}
        <PickerMenuOptionContent>
          <PickerMenuOptionLabel className={privacyClassName}>
            {option.label}
          </PickerMenuOptionLabel>
        </PickerMenuOptionContent>
        <PickerMenuOptionCheck selected={selected} />
      </PickerMenuOption>
    );
  };

  return (
    <>
      <span className={wrapperClassName}>
        <Button
          ref={setTrigger}
          id={id ?? triggerId}
          // A dropdown is a field: the 28px rounded rectangle, not the
          // capsule of the actions beside it.
          size="field"
          variant="secondary"
          className={widthClassName}
          style={{
            paddingLeft: chosen?.preview ? 11 : undefined,
            columnGap: chosen?.preview ? 10 : undefined,
          }}
          role="combobox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={describedBy}
          aria-invalid={ariaInvalid}
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? listId : undefined}
          aria-busy={busy || undefined}
          disabled={disabled}
          data-testid={dataTestId}
          data-value={chosen === undefined ? undefined : dataValue(chosen)}
          onClick={() => setOpen((current) => !current)}
        >
          {chosen?.preview}
          <span
            className={`min-w-0 flex-1 truncate text-left ${showsPlaceholder ? 'fg-tertiary' : ''} ${privacyClassName}`}
          >
            {shownLabel}
          </span>
          <ChevronDownIcon
            size={14}
            aria-hidden="true"
            className="fg-tertiary"
          />
        </Button>
      </span>
      <FloatingPickerMenu
        open={menuOpen}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        interaction="listbox"
        heightLimit={SETTINGS_SELECT_MENU_HEIGHT}
        role="listbox"
        id={listId}
        // The menu renders at the page body, outside any replay-blocked page,
        // so a label naming a person must come by `aria-labelledby` (ids
        // only); a plain `aria-label` is repeated here. With neither, the
        // trigger names the menu.
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-labelledby={
          ariaLabelledBy ?? (ariaLabel ? undefined : (id ?? triggerId))
        }
      >
        {options.map((item, index) =>
          isGroup(item) ? (
            <Fragment key={`group-${index}-${item.label}`}>
              <PickerMenuSectionLabel role="presentation">
                {item.label}
              </PickerMenuSectionLabel>
              {item.options.map(renderOption)}
            </Fragment>
          ) : (
            renderOption(item)
          ),
        )}
      </FloatingPickerMenu>
    </>
  );
}
