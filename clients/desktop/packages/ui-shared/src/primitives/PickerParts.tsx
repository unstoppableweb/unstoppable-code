'use client';

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ComponentPropsWithoutRef,
  type JSX,
  type ReactNode,
} from 'react';
import {
  CheckIcon,
  ChevronDownMediumIcon,
  CloseIcon,
  SearchIcon,
} from '../icons/AppIcons';
import { Button, DROPDOWN_TRIGGER_INTERACTION_CLASS } from './Button';
import { COARSE_HIT_AREA_CLASS } from './control-button-shared';
import { useContextMenuPlacement } from './context-menu-placement';
import { OverlayScrollArea } from './OverlayScrollArea';
import { SKELETON_KEEP } from './Skeleton';

export type PickerTriggerVariant = 'capsule' | 'field';

export interface PickerTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: PickerTriggerVariant;
  /**
   * `compact` is a 28px capsule, for a trigger that shares a row with the
   * 28px `SegmentedControl` (the Subagents toolbar's Levels picker). `page`
   * is the quiet 28px dropdown of a page search row (`PageSearchRow`): no
   * fill or edge until hovered or open, 12px before its label and 8px after
   * its chevron (the chevron's own whitespace balances the pill).
   */
  // `composer` preserves the 40px filled field in the New Task footer.
  size?: 'default' | 'compact' | 'page' | 'composer';
  /** Set a branch or path value in the mono face. */
  mono?: boolean;
  /**
   * `secondary` quiets a field's value to the secondary ink (a base-branch
   * field in the PR status bar). A capsule already rests in secondary ink.
   */
  /** `selected` is a filter pill that is on: a filled background, nothing else changes. */
  tone?: 'default' | 'secondary' | 'selected';
  /**
   * A capsule that carries only a label and its trailing chevron (no leading
   * glyph) takes a 14px leading inset, so the label balances the chevron's
   * side instead of sitting closer to the edge than the chevron does. The
   * Marketplace pipeline filters use it.
   */
  labelOnly?: boolean;
  /**
   * The composer row's label-first capsule (no leading glyph): 2px more
   * leading room than a glyph trigger, so the text does not crowd the edge.
   * Lighter than `labelOnly`, which balances a standalone filter.
   */
  textLead?: boolean;
  /**
   * A capsule that ends on its label (no trailing chevron): the label takes
   * the same 12px trailing inset as `textLead`'s leading one.
   */
  textTrail?: boolean;
  /**
   * Keeps the hover surface while any part of the trigger's
   * `group/picker-trigger` wrapper is hovered, for a control seated over the
   * trigger (the project picker's clear button): pointing at that control
   * still reads as pointing at the chip.
   */
  wrapperHover?: boolean;
  /**
   * Can't be used now but stays focusable (`aria-disabled`, dimmed), so a
   * tooltip can say why and focus survives a save. The caller swallows the
   * press and passes `openOnArrowKeys={false}` to its menu.
   */
  unavailable?: boolean;
  /** A 44px-tall hit area on coarse pointers, without changing layout. */
  coarsePointerTarget?: boolean;
}

const COMPOSER_PICKER_FIELD = 'h-10 bg-base px-3';

/** A settled destination, or reserved space while the workspace loads. */
export function ComposerPickerPlaceholder({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId: string;
}): JSX.Element {
  return (
    <span
      data-testid={testId}
      className={`flex min-w-0 max-w-64 items-center text-left opacity-40 fg-primary ${COMPOSER_PICKER_FIELD} ${PICKER_TRIGGER_SHELLS.field}`}
    >
      {children}
    </span>
  );
}

const PICKER_TRIGGER_WRAPPER_HOVERS: Record<PickerTriggerVariant, string> = {
  capsule:
    ' enabled:group-hover/picker-trigger:bg-subtle enabled:group-hover/picker-trigger:fg-primary',
  field: ' enabled:group-hover/picker-trigger:bg-subtle',
};

// A capsule that is on only swaps its transparent resting fill for a filled
// one; the ink, icon and chevron stay as they were.
const PICKER_TRIGGER_SELECTED_CAPSULE_SHELL =
  'gap-1 rounded-full border-0 bg-muted px-2.5 transition-colors hover:bg-muted hover:fg-primary';

const PICKER_TRIGGER_SHELLS: Record<PickerTriggerVariant, string> = {
  capsule:
    'gap-1 rounded-full border-0 bg-transparent px-2.5 transition-colors hover:bg-subtle hover:fg-primary disabled:hover:bg-transparent disabled:hover:fg-secondary',
  // The shared field look (`TextInput`, `Select`): the 1px `shadow-field` edge
  // on a transparent fill, the shared row corners. Default callers sit in
  // 32px rows; the composer size opts into a 40px filled field.
  field: `gap-2 rounded-row text-s shadow-field transition-[box-shadow,background-color,transform,scale] ${DROPDOWN_TRIGGER_INTERACTION_CLASS} disabled:pointer-events-none`,
};

// Capsule heights, in small text. Field geometry is selected separately below.
const PICKER_TRIGGER_HEIGHTS: Record<
  NonNullable<PickerTriggerProps['size']>,
  string
> = {
  default: 'h-8 text-xs pointer-coarse:min-h-11',
  compact: 'h-7 text-xs pointer-coarse:min-h-11',
  page: 'h-7 pl-3 pr-2 text-xs aria-expanded:bg-subtle pointer-coarse:min-h-11',
  composer: 'h-10 text-xs',
};

// A field focuses like the shared fields: the neutral edge and halo replace
// its resting edge. A capsule keeps the app-wide focus ring.
const PICKER_TRIGGER_FOCUS: Record<PickerTriggerVariant, string> = {
  capsule: 'focus-ring',
  field: 'outline-none focus-visible:shadow-field-focus',
};

const PICKER_TRIGGER_INKS: Record<PickerTriggerVariant, string> = {
  capsule: 'fg-secondary',
  field: 'fg-primary',
};

/**
 * Shared trigger geometry; callers compose their domain icon and label. The
 * disabled treatment is the composer chip's: 40% opacity, no hover surface,
 * and the resting ink kept under the pointer.
 */
export const PickerTrigger = forwardRef<HTMLButtonElement, PickerTriggerProps>(
  function PickerTrigger(
    {
      className = '',
      type = 'button',
      variant = 'capsule',
      size = 'default',
      mono = false,
      tone = 'default',
      labelOnly = false,
      textLead = false,
      textTrail = false,
      wrapperHover = false,
      unavailable = false,
      coarsePointerTarget = false,
      ...props
    },
    ref,
  ): JSX.Element {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        aria-disabled={unavailable || props['aria-disabled']}
        className={`${PICKER_TRIGGER_FOCUS[variant]}${coarsePointerTarget ? ` ${COARSE_HIT_AREA_CLASS}` : ''}${unavailable ? ' cursor-not-allowed opacity-40' : ''} flex min-w-0 items-center text-left disabled:cursor-not-allowed disabled:opacity-40 ${variant === 'capsule' ? PICKER_TRIGGER_HEIGHTS[size] : size === 'composer' ? COMPOSER_PICKER_FIELD : 'h-8 bg-transparent px-2'} ${tone === 'selected' && variant === 'capsule' ? PICKER_TRIGGER_SELECTED_CAPSULE_SHELL : PICKER_TRIGGER_SHELLS[variant]}${
          variant !== 'capsule' || size === 'page'
            ? ''
            : labelOnly
              ? ' pl-3.5'
              : textLead
                ? ' pl-3'
                : ''
        }${variant === 'capsule' && size !== 'page' && textTrail ? ' pr-3' : ''}${wrapperHover ? PICKER_TRIGGER_WRAPPER_HOVERS[variant] : ''} ${tone === 'secondary' ? 'fg-secondary' : tone === 'selected' ? 'fg-secondary' : PICKER_TRIGGER_INKS[variant]}${mono ? ' font-mono' : ''} ${className}`}
      />
    );
  },
);

PickerTrigger.displayName = 'PickerTrigger';

const PICKER_TRIGGER_CHEVRON_INKS: Record<PickerTriggerVariant, string> = {
  capsule: 'fg-quaternary',
  field: 'fg-tertiary',
};

/**
 * The trigger's chevron. Its ink follows the trigger variant: quaternary in a
 * capsule, tertiary beside a field's primary-ink value.
 */
export function PickerTriggerChevron({
  open,
  variant = 'capsule',
  className = '',
}: {
  readonly open: boolean;
  readonly variant?: PickerTriggerVariant;
  readonly className?: string;
}): JSX.Element {
  return (
    <ChevronDownMediumIcon
      size="sm"
      className={`shrink-0 transition-transform ${PICKER_TRIGGER_CHEVRON_INKS[variant]} ${
        open ? 'rotate-180' : ''
      } ${className}`}
      aria-hidden="true"
    />
  );
}

export const PickerSearchHeader = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function PickerSearchHeader({ className = '', ...props }, ref): JSX.Element {
  return (
    <div
      {...props}
      ref={ref}
      className={`canopy-picker-menu-search -mx-1 shrink-0 border-b px-1 pt-1 pb-1 ${className}`}
    />
  );
});

PickerSearchHeader.displayName = 'PickerSearchHeader';

/**
 * The text size of a picker's rows and search field. Early access (the host
 * that opens context menus at the pointer) gives pickers the same small text
 * as its row menus, so a project or branch picker and a right-click menu read
 * as one family; other hosts keep the body size.
 */
function usePickerTextClassName(): 'text-xs' | 'text-s' {
  return useContextMenuPlacement() === 'cursor' ? 'text-xs' : 'text-s';
}

export const PickerSearchInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & {
    /**
     * Renders the shared muted clear button while the field has a value. The
     * browser's own clear control never shows (canopy-tokens-core.css).
     */
    onClear?: () => void;
  }
>(function PickerSearchInput(
  { className = '', type = 'text', onClear, ...props },
  ref,
): JSX.Element {
  const textClassName = usePickerTextClassName();
  // Same px-2 / gap-2 / 16px leading rail as PickerOption so the
  // magnifying glass lines up with row icons and the caret with labels.
  return (
    <div
      className="canopy-picker-menu-search-field flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2"
      onMouseDown={(event): void => {
        const input = event.currentTarget.querySelector('input');
        if (
          !input ||
          event.target === input ||
          (event.target instanceof Element && event.target.closest('button'))
        ) {
          return;
        }
        // A press on the glyph or padding focuses the field instead of nothing.
        event.preventDefault();
        input.focus();
      }}
    >
      <span
        aria-hidden="true"
        className="canopy-picker-menu-search-icon inline-flex h-4 w-4 shrink-0 items-center justify-center fg-quaternary [&>svg]:!h-4 [&>svg]:!w-4"
      >
        <SearchIcon />
      </span>
      <input
        // A query is never prose or a saved credential.
        spellCheck={false}
        autoComplete="off"
        data-1p-ignore=""
        {...props}
        ref={ref}
        type={type}
        className={`min-w-0 flex-1 border-0 bg-transparent ${textClassName} pointer-coarse:text-m outline-none fg-primary placeholder:fg-tertiary ${className}`}
      />
      {onClear && props.value ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          className="-mr-2"
          aria-label="Clear search"
          onMouseDown={(event): void => event.preventDefault()}
          onClick={(event): void => {
            const input = event.currentTarget
              .closest('.canopy-picker-menu-search-field')
              ?.querySelector('input');
            onClear();
            input?.focus();
          }}
        >
          <CloseIcon size={16} />
        </Button>
      ) : null}
    </div>
  );
});

PickerSearchInput.displayName = 'PickerSearchInput';

/** The search field in a menu that moves DOM focus onto matching rows. */
export function menuSearchKeyHandler(
  itemSelector: string,
): (event: React.KeyboardEvent<HTMLInputElement>) => void {
  return (event): void => {
    if (event.nativeEvent.isComposing) {
      event.stopPropagation();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const rows = event.currentTarget
        .closest('[role="menu"]')
        ?.querySelectorAll<HTMLElement>(itemSelector);
      const row =
        event.key === 'ArrowDown' ? rows?.[0] : rows?.[rows.length - 1];
      event.preventDefault();
      event.stopPropagation();
      row?.focus();
      row?.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      // Only a typed query picks a row; an empty field opened with the menu
      // must not switch anything on Enter.
      const row =
        event.currentTarget.value.trim() === ''
          ? null
          : event.currentTarget
              .closest('[role="menu"]')
              ?.querySelector<HTMLElement>(itemSelector);
      // React events cross the portal, so a loose Enter would reach the
      // composer under the menu; keep it here as before.
      event.stopPropagation();
      if (row) {
        event.preventDefault();
        row.click();
      }
    } else if (event.key !== 'Escape' && event.key !== 'Tab') {
      // Keep typing away from the parent menu's typeahead.
      event.stopPropagation();
    }
  };
}

export const MenuSearchInput = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof PickerSearchInput>, 'onKeyDown'> & {
    readonly itemSelector: string;
  }
>(function MenuSearchInput({ itemSelector, ...props }, ref): JSX.Element {
  return (
    <PickerSearchInput
      {...props}
      ref={ref}
      onKeyDown={menuSearchKeyHandler(itemSelector)}
    />
  );
});

export const PickerTabList = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function PickerTabList(
  { className = '', role = 'tablist', ...props },
  ref,
): JSX.Element {
  return (
    <div
      {...props}
      ref={ref}
      role={role}
      className={`canopy-picker-menu-tabs -mx-1 shrink-0 border-b px-1 ${className}`}
    />
  );
});

PickerTabList.displayName = 'PickerTabList';

export interface PickerTabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  /**
   * The tab the arrow keys are resting on while focus stays in the search
   * field: an accent outline that is distinct from the active tab's underline.
   */
  highlighted?: boolean;
}

export const PickerTab = forwardRef<HTMLButtonElement, PickerTabProps>(
  function PickerTab(
    {
      active = false,
      highlighted = false,
      className = '',
      type = 'button',
      ...props
    },
    ref,
  ): JSX.Element {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        data-active={active || undefined}
        data-highlighted={highlighted || undefined}
        className={`canopy-picker-menu-tab focus-ring relative inline-flex h-8 pointer-coarse:h-11 min-w-0 shrink-0 rounded-md items-center justify-center whitespace-nowrap px-2 text-xs font-normal transition-colors ${
          active ? 'fg-primary' : 'fg-secondary hover:fg-primary'
        }${highlighted ? ' outline outline-1 outline-[var(--line-accent)]' : ''} ${className}`}
      />
    );
  },
);

PickerTab.displayName = 'PickerTab';

const NATIVE_PICKER_LIST_CLASS_NAMES = {
  palette: 'p-2',
  'grouped-files': 'py-1',
  'bounded-options':
    'grid max-h-40 grid-cols-1 content-start gap-1 overflow-y-auto',
  'scrolling-tabs':
    'canopy-panel-tab-list-rows min-h-0 overflow-y-auto outline-none',
} as const;

type PickerListProps = HTMLAttributes<HTMLDivElement> & {
  /**
   * Which surface edges the list cancels padding on. `right` keeps a 4px
   * inset on the leading edge, for a list beside a rail divider.
   */
  edges?: 'both' | 'right';
  /** Fade the scrolled edges over this many pixels. */
  edgeFadeSize?: number;
  /** `scrollbar` keeps rows clear of an always-visible scrollbar. */
  gutter?: 'none' | 'scrollbar';
  /** Lists integrated into a native viewport use the matching spacing and focus treatment. */
  presentation?: keyof typeof NATIVE_PICKER_LIST_CLASS_NAMES;
};

export const PickerList = forwardRef<HTMLDivElement, PickerListProps>(
  function PickerList(
    {
      className = '',
      role = 'listbox',
      edges = 'both',
      edgeFadeSize = 0,
      gutter = 'none',
      presentation,
      children,
      ...props
    },
    ref,
  ): JSX.Element {
    if (presentation) {
      return (
        <div
          {...props}
          ref={ref}
          role={role}
          className={`${NATIVE_PICKER_LIST_CLASS_NAMES[presentation]} ${className}`}
        >
          {children}
        </div>
      );
    }
    // Overlay scrollbar: the native scrollbar is hidden and never participates
    // in layout, so option rows keep symmetric left/right insets; the shared
    // 6px thumb clears the surface corners at both scroll extremes.
    return (
      <OverlayScrollArea
        className={
          edges === 'both' ? '-mx-1 min-h-0 flex-1' : '-mr-1 min-h-0 flex-1'
        }
        edgeFadeSize={edgeFadeSize}
        viewport="pickerList"
        contentInset
        viewportRef={ref}
        viewportProps={{ ...props, role }}
        viewportClassName={
          gutter === 'scrollbar'
            ? `overflow-x-hidden py-1 pl-1 pr-4 ${className}`
            : `overflow-x-hidden ${className}`
        }
        contentClassName="px-1"
        // Full-bleed scroll (cancels MenuSurface `p-1`) so in-list
        // section dividers can -mx-1 to the surface edge without being clipped
        // by overflow-x:hidden. Content `px-1` restores the row inset; the rail
        // sits on the surface edge (thumb still 2px in via OverlayScrollArea).
        railClassName="right-1"
        thumbEndInset={8}
      >
        {children}
      </OverlayScrollArea>
    );
  },
);

PickerList.displayName = 'PickerList';

/**
 * Row ink. `accent` marks an action row (Connect GitHub, New project) and
 * carries into the leading rail; `secondary` quiets a plain choice list.
 */
export type PickerOptionTone = 'primary' | 'secondary' | 'accent';

export interface PickerOptionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  /** Distinguishes a keyboard-active option from the neutral hover surface. */
  activeTone?: 'neutral' | 'accent';
  selected?: boolean;
  tone?: PickerOptionTone;
  /**
   * A row the user can still activate to learn why it cannot be chosen (a
   * locked model): it reads as unavailable, secondary ink at half opacity
   * with no hover or focus surface, but keeps its tab stop and click, unlike
   * `disabled`.
   */
  unavailable?: boolean;
  /**
   * Reserve room at the trailing edge for a control overlaid on the row (the
   * model picker's favorite toggle).
   */
  trailingControl?: boolean;
  /**
   * Room for 28px controls overlaid on the row's trailing edge. The
   * `*-on-row-hover` values widen by one slot while the row's
   * `group/model-row` wrapper is hovered or focused, for a control that only
   * shows then.
   */
  trailingSlots?: PickerOptionTrailingSlots;
  /** Tint the row while its `group/model-row` wrapper is hovered. */
  rowHoverSurface?: boolean;
}

export type PickerOptionTrailingSlots =
  | 'none'
  | 'one'
  | 'two'
  | 'one-on-row-hover'
  | 'two-on-row-hover';

const TRAILING_SLOT_CLASS_NAMES: Record<PickerOptionTrailingSlots, string> = {
  none: '',
  one: ' pr-9',
  two: ' pr-16.5',
  'one-on-row-hover':
    ' pr-2 group-hover/model-row:pr-9 group-focus-within/model-row:pr-9 [@media(hover:none)]:pr-9',
  'two-on-row-hover':
    ' pr-9 group-hover/model-row:pr-16.5 group-focus-within/model-row:pr-16.5 [@media(hover:none)]:pr-16.5',
};

const OPTION_TONE_CLASS_NAMES: Record<PickerOptionTone, string> = {
  primary: 'fg-primary',
  secondary: 'fg-secondary',
  accent: 'fg-accent',
};

const OPTION_UNAVAILABLE_CLASS_NAME =
  'cursor-not-allowed fg-secondary opacity-50 hover:bg-transparent focus-visible:bg-transparent';

/**
 * The parts below read the row's tone and disabled state through the
 * `picker-option` group, so a caller sets them once on the row. An
 * unavailable row stays readable in the quaternary ink rather than the
 * control-disabled ink: the picker keeps every row and explains why one is
 * unavailable (DESIGN.md), which a faded row cannot do.
 */
export const PickerOption = forwardRef<HTMLButtonElement, PickerOptionProps>(
  function PickerOption(
    {
      active = false,
      activeTone = 'neutral',
      className = '',
      selected = false,
      tone = 'primary',
      unavailable = false,
      trailingControl = false,
      trailingSlots = 'none',
      rowHoverSurface = false,
      type = 'button',
      ...props
    },
    ref,
  ): JSX.Element {
    const textClassName = usePickerTextClassName();
    const accentActive = active && !selected && activeTone === 'accent';
    const interactionClassName = accentActive
      ? 'bg-accent-subtle fg-accent-strong hover:bg-accent-subtle focus-visible:bg-accent-subtle'
      : 'hover:bg-subtle focus-visible:bg-subtle';
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        data-active={active || undefined}
        data-selected={selected ? 'true' : undefined}
        data-tone={tone === 'primary' ? undefined : tone}
        className={`canopy-picker-menu-option group/picker-option focus-ring flex min-h-8 pointer-coarse:min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left ${textClassName} font-normal transition-colors ${interactionClassName} disabled:cursor-not-allowed disabled:fg-quaternary disabled:opacity-100 disabled:hover:bg-transparent ${
          accentActive
            ? unavailable
              ? 'cursor-not-allowed opacity-50'
              : ''
            : unavailable
              ? OPTION_UNAVAILABLE_CLASS_NAME
              : OPTION_TONE_CLASS_NAMES[tone]
        }${trailingControl ? ' pr-10' : ''}${TRAILING_SLOT_CLASS_NAMES[trailingSlots]}${
          rowHoverSurface ? ' group-hover/model-row:bg-subtle' : ''
        } ${active && !selected && !accentActive ? 'bg-subtle' : ''} ${className}`}
      />
    );
  },
);

PickerOption.displayName = 'PickerOption';

export type PickerOptionLeadingTone =
  | 'quaternary'
  | 'tertiary'
  | 'secondary'
  | 'primary'
  | 'accent';

const LEADING_TONE_CLASS_NAMES: Record<PickerOptionLeadingTone, string> = {
  quaternary: 'fg-quaternary',
  tertiary: 'fg-tertiary',
  secondary: 'fg-secondary',
  primary: 'fg-primary',
  accent: 'fg-accent',
};

/** The row's tone and disabled state, read through the `picker-option` group. */
const FOLLOWS_ROW_CLASS_NAME =
  'group-data-[tone=accent]/picker-option:fg-accent group-disabled/picker-option:fg-quaternary';

export interface PickerOptionLeadingProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * Resting ink. `secondary` for a settings glyph that should read as a
   * control; `primary` for a swatch drawn in the row's own ink; `accent` for
   * the selected mark of a row that is not itself an accent row. An accent
   * row and a disabled row override it through the group.
   */
  tone?: PickerOptionLeadingTone;
}

/** Fixed 16px leading rail shared by project, worktree, and branch rows. */
export function PickerOptionLeading({
  className = '',
  tone = 'tertiary',
  ...props
}: PickerOptionLeadingProps): JSX.Element {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:!h-4 [&>svg]:!w-4 ${LEADING_TONE_CLASS_NAMES[tone]} ${FOLLOWS_ROW_CLASS_NAME} ${className}`}
    />
  );
}

export function PickerOptionContent({
  className = '',
  ...props
}: HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span
      {...props}
      className={`flex min-w-0 flex-1 flex-col justify-center gap-1 truncate ${className}`}
    />
  );
}

export interface PickerOptionLabelProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * `inherit` takes the row's ink. `quiet` rests one step lighter (primary at
   * 80%) without dropping to secondary: the model list's label ink, which
   * lets the selected mark and the extra-charge marker stand out.
   */
  tone?: 'inherit' | 'quiet';
  /** Inline reference text that shares the label's native truncation, rather than a trailing rail. */
  readonly meta?: ReactNode;
}

export function PickerOptionLabel({
  className = '',
  tone = 'inherit',
  meta,
  ...props
}: PickerOptionLabelProps): JSX.Element {
  const textClassName = usePickerTextClassName();
  const labelClassName = `canopy-picker-menu-option-label block truncate ${textClassName} leading-4${tone === 'quiet' ? ' fg-primary/80' : ''} ${className}`;
  if (meta == null || typeof meta === 'boolean' || meta === '') {
    return <span {...props} className={labelClassName} />;
  }
  return (
    <span {...props} className={labelClassName}>
      {props.children}
      {/* Keep references in the native inline run: a flex rail changes which
          text gets the browser's ellipsis. This inset belongs to the label. */}
      <span className="pl-2 fg-secondary empty:pl-0">{meta}</span>
    </span>
  );
}

export function PickerOptionDescription({
  className = '',
  ...props
}: HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span
      {...props}
      className={`block truncate text-2xs leading-3 fg-tertiary group-disabled/picker-option:fg-quaternary ${className}`}
    />
  );
}

export interface PickerOptionTrailingProps extends HTMLAttributes<HTMLSpanElement> {
  /** `tertiary` for a count the row reports; the default is the quiet badge ink. */
  tone?: 'quaternary' | 'tertiary';
  /**
   * A badge that carries its own tooltip (a branch's local/remote marker)
   * brightens under the pointer so it reads as something to hover.
   */
  interactive?: boolean;
}

export function PickerOptionTrailing({
  className = '',
  tone = 'quaternary',
  interactive = false,
  ...props
}: PickerOptionTrailingProps): JSX.Element {
  return (
    <span
      {...props}
      className={`canopy-picker-menu-option-trailing inline-flex min-w-0 shrink-0 items-center justify-end text-2xs tabular-nums [&>svg]:!h-4 [&>svg]:!w-4 ${
        tone === 'tertiary' ? 'fg-tertiary' : 'fg-quaternary'
      }${interactive ? ' hover:fg-secondary' : ''} ${className}`}
    />
  );
}

/**
 * Selection checkmark. By default mounts only when selected so the right rail
 * can host a status icon (draft/fork/local/remote) until selection replaces it
 * with the check. Pass `reserveSpace` for leading checkbox rails that must not
 * jump on toggle.
 */
export function PickerOptionCheck({
  selected,
  reserveSpace = false,
  className = '',
}: {
  readonly selected: boolean;
  /** Keep a 16px rail when unselected (leading checkbox pattern). */
  readonly reserveSpace?: boolean;
  readonly className?: string;
}): JSX.Element | null {
  if (!selected && !reserveSpace) {
    return null;
  }

  return (
    <span
      aria-hidden="true"
      data-picker-selected-check={selected ? 'true' : 'false'}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center fg-primary ${className}`}
    >
      {selected ? <CheckIcon size="sm" /> : null}
    </span>
  );
}

export function PickerSectionLabel({
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      {...props}
      className={`canopy-picker-menu-section-label flex items-center px-2 py-1 text-xs font-normal normal-case fg-tertiary ${className}`}
    />
  );
}

export const PickerSection = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function PickerSection({ className = '', ...props }, ref): JSX.Element {
  return (
    <div
      {...props}
      ref={ref}
      className={`canopy-picker-menu-section relative -mx-1 px-1 pt-2 before:pointer-events-none before:absolute before:inset-x-0 before:top-1 before:h-[var(--border-hairline)] before:bg-line-base ${className}`}
    />
  );
});

PickerSection.displayName = 'PickerSection';

export const PickerFooter = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function PickerFooter({ className = '', ...props }, ref): JSX.Element {
  return (
    <div
      {...props}
      ref={ref}
      className={`canopy-picker-menu-footer -mx-1 shrink-0 border-t px-1 pt-1 pb-1 ${className}`}
    />
  );
});

PickerFooter.displayName = 'PickerFooter';

export function PickerState({
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  // min-h-8 matches a single option row; multi-line empty/error copy must be
  // allowed to grow (fixed h-8 crushed two-line GitHub auth messages).
  return (
    <div
      {...props}
      className={`flex min-h-8 items-center px-2 py-2 text-xs leading-snug text-pretty fg-tertiary ${className}`}
    />
  );
}

/** A sample label's width, in Tailwind's spacing steps. */
export type PickerSampleLabelWidth = 20 | 22 | 24 | 28 | 32 | 34 | 36 | 40;

/**
 * Sample labels about as wide as each step (80px to 160px in the row's
 * text), so the measured bars keep the varied widths of a real list.
 */
const SAMPLE_LABELS: Record<PickerSampleLabelWidth, string> = {
  20: 'Release notes',
  22: 'Sample option',
  24: 'Another option',
  28: 'Fix the login form',
  32: 'Update the setup guide',
  34: 'Refresh the sidebar list',
  36: 'Stabilize the checkout test',
  40: 'Move billing to the new page',
};

/** Varied label widths so placeholder rows read as a list, not a block. */
const SKELETON_LABEL_WIDTHS = [
  32, 24, 40, 28, 36, 20,
] as const satisfies readonly PickerSampleLabelWidth[];

/**
 * One sample option for a measured `Skeleton`: the real `PickerOption`
 * with its leading rail and a plain label of about the given width. It is
 * sample content, so render it only inside a `Skeleton`, which draws it as
 * bars and keeps it inert.
 */
export function PickerSampleOption({
  labelWidth,
  leading = true,
}: {
  readonly labelWidth: PickerSampleLabelWidth;
  /** Keep the 16px leading rail, for a list whose rows lead with an icon. */
  readonly leading?: boolean;
}): JSX.Element {
  return (
    <PickerOption tabIndex={-1}>
      {leading ? <PickerOptionLeading {...SKELETON_KEEP} /> : null}
      <PickerOptionContent>
        <PickerOptionLabel>{SAMPLE_LABELS[labelWidth]}</PickerOptionLabel>
      </PickerOptionContent>
    </PickerOption>
  );
}

export interface PickerSampleOptionsProps {
  /** Sample rows to draw. */
  readonly rows?: number;
  /** Whether the list's rows lead with an icon (branches, models). */
  readonly leading?: boolean;
}

/**
 * Sample rows for a picker whose options are loading, so the picker can open
 * at once. Wrap them in `Skeleton`: they are real option rows with sample
 * labels, so each bar sits where an option's label will.
 */
export function PickerSampleOptions({
  rows = 6,
  leading = true,
}: PickerSampleOptionsProps): JSX.Element {
  return (
    <div className="flex flex-col">
      {Array.from({ length: rows }, (_, index) => (
        <PickerSampleOption
          key={index}
          leading={leading}
          labelWidth={
            SKELETON_LABEL_WIDTHS[index % SKELETON_LABEL_WIDTHS.length] ?? 32
          }
        />
      ))}
    </div>
  );
}
