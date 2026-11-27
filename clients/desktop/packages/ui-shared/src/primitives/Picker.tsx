'use client';

import { useRef, type CSSProperties, type JSX, type Ref } from 'react';
import { PICKER_GAP, Menu, type MenuProps } from './Menu';
import { PickerSearchList, type PickerSearchListProps } from './PickerSearch';

type PickerStyle = CSSProperties & {
  '--canopy-picker-minimum-width'?: string;
  '--canopy-picker-maximum-width'?: string;
  '--canopy-picker-trigger-width'?: string;
};

/**
 * A searchable picker's list: a search field over option rows. Typing
 * filters, and the arrows move the highlight while focus stays in the field.
 * The picker focuses the field once it is placed, so the list never takes
 * focus itself.
 */
export type PickerSearch<T> = Omit<
  PickerSearchListProps<T>,
  'autoFocus' | 'inputRef'
>;

interface PickerShellProps extends Omit<MenuProps, 'gap' | 'children'> {
  /** The portaled surface element. */
  readonly ref?: Ref<HTMLDivElement>;
  /**
   * Distance from the trigger. Pickers default to 8px; a field-attached
   * dropdown (the shared `Select`) sits 4px from its field.
   */
  readonly gap?: number;
  /** Optional domain-driven minimum within the shared max/viewport cap. */
  readonly minimumWidth?: string;
  /** Optional domain-driven maximum; defaults to the shared 20rem (320px) cap. */
  readonly maximumWidth?: string;
}

/**
 * A picker holds its own rows (`children`), or is searchable (`search`): it
 * then draws the search field and the rows from `search`, and focuses the
 * field when it opens. A searchable picker is a `dialog` named by its list
 * unless the caller names it, and its field keeps every key (`manual`), so
 * no row typeahead takes a letter from the search.
 */
export type PickerProps<T = unknown> = PickerShellProps &
  (
    | { readonly children: MenuProps['children']; readonly search?: undefined }
    | {
        readonly search: PickerSearch<T>;
        readonly children?: undefined;
        readonly interaction?: 'manual';
      }
  );

/**
 * Canonical picker shell. Width follows the longest option between a shared
 * trigger-aware 160px minimum and the 320px/viewport cap. Tabbed or richer
 * pickers may declare a deliberate minimum (or a slightly wider maximum) without
 * bypassing the viewport bound; longer labels grow the shell until its cap.
 * Searchable composites retain manual keyboard ownership while Menu
 * owns portals, collision placement, motion, and dismissal.
 *
 * Outside a floating picker (a `Popover`, a dialog, a palette), the same
 * searchable list is `PickerSearchList`.
 */
export function Picker<T>({
  ref,
  anchorRef,
  open,
  className = '',
  interaction = 'manual',
  maximumWidth,
  minimumWidth,
  style,
  gap = PICKER_GAP,
  initialFocusRef,
  search,
  children,
  role,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  ...props
}: PickerProps<T>): JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null);
  const focusTarget = initialFocusRef ?? (search ? searchRef : undefined);
  const surfaceRole = role ?? (search ? 'dialog' : undefined);
  const surfaceLabel =
    ariaLabel ??
    (search && ariaLabelledBy === undefined ? search.listLabel : undefined);
  const pickerStyle: PickerStyle = {
    ...(minimumWidth ? { '--canopy-picker-minimum-width': minimumWidth } : {}),
    ...(maximumWidth ? { '--canopy-picker-maximum-width': maximumWidth } : {}),
    // A closed menu renders nothing; measuring then would force a layout on
    // every render of every closed picker in a list.
    '--canopy-picker-trigger-width': `${
      open ? (anchorRef.current?.getBoundingClientRect().width ?? 0) : 0
    }px`,
    ...style,
  };

  return (
    <Menu
      {...props}
      {...(ref ? { ref } : {})}
      {...(focusTarget ? { initialFocusRef: focusTarget } : {})}
      {...(surfaceRole === undefined ? {} : { role: surfaceRole })}
      {...(surfaceLabel === undefined ? {} : { 'aria-label': surfaceLabel })}
      {...(ariaLabelledBy === undefined
        ? {}
        : { 'aria-labelledby': ariaLabelledBy })}
      open={open}
      anchorRef={anchorRef}
      gap={gap}
      interaction={search ? 'manual' : interaction}
      shell="picker"
      className={className}
      style={pickerStyle}
    >
      {search ? (
        // The picker focuses the field once it is placed: a field focused
        // while the surface is still hidden would not take focus.
        <PickerSearchList {...search} inputRef={searchRef} autoFocus={false} />
      ) : (
        children
      )}
    </Menu>
  );
}
