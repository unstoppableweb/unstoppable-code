'use client';

import {
  Fragment,
  forwardRef,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { CheckIcon, ListFilterIcon } from '../icons/AppIcons';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
  DropdownMenuRowStyleProvider,
  QUIET_MENU_ROW_STYLE,
} from '../primitives/DropdownMenu';
import { FloatingMenu } from '../primitives/FloatingMenu';
import { NestedMenuFlyout } from '../primitives/NestedMenuFlyout';
import { PickerTrigger, PickerTriggerChevron } from '../primitives/PickerMenu';
import { SearchField, type SearchFieldProps } from '../primitives/SearchField';

/**
 * A page search row: one row 16px under the page header (or its tabs) and
 * 16px above the list. The 32px search fills the row and holds only its
 * glyph, the result count and Clear; the page's filters and its sort follow
 * as quiet 28px dropdowns sized to their label, in one
 * {@link PageSearchControls} group. On a narrow page the group wraps under
 * the field rather than squeezing it below 160px. Up to
 * {@link PAGE_SEARCH_INLINE_FILTER_LIMIT} filters sit inline; more go behind
 * one Filter dropdown (`PageSearchFilters`). Tabs stay in the header.
 *
 * `className` is placement only (the row's margins).
 */
export function PageSearchRow({
  children,
  className = '',
  testId,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly testId?: string;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      data-page-search-row=""
      className={`flex min-w-0 flex-wrap items-center gap-2 ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The row's dropdowns as one group after the search: no gap between them,
 * 8px from the field, pulled out by the quiet trigger's 8px end inset so
 * the last chevron's ink meets the content edge and its hover pill hangs
 * past it, as a ghost button's does.
 */
export function PageSearchControls({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-page-search-controls=""
      className="-mr-2 flex shrink-0 items-center"
    >
      {children}
    </div>
  );
}

export type PageSearchFieldProps = Omit<SearchFieldProps, 'size' | 'actions'>;

/**
 * The search of a `PageSearchRow`: the shared 32px `SearchField` on the
 * subtle fill inside a hairline, growing to fill the row. Filters and the sort never nest in
 * it; they follow it in the row.
 */
export const PageSearchField = forwardRef<
  HTMLInputElement,
  PageSearchFieldProps
>(function PageSearchField({ className = '', ...props }, ref): JSX.Element {
  return (
    <SearchField
      {...props}
      ref={ref}
      size="md"
      className={`min-w-40 flex-1 ${className}`}
    />
  );
});

PageSearchField.displayName = 'PageSearchField';

export interface PageDropdownTriggerProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  /** What the dropdown keeps now: `Any status`, `Sort: Name`, `Filter · 2`. */
  readonly label: ReactNode;
  readonly open: boolean;
  /** A filter is on: the label takes the primary ink. */
  readonly active?: boolean;
  /**
   * `page` is the quiet 28px trigger of a page search row; `default` is the
   * 32px capsule of a toolbar (the Schedule calendar's).
   */
  readonly size?: 'default' | 'page';
  /** A leading glyph, so the trigger names the filter before it is set. */
  readonly icon?: ReactNode;
  /** Selected, the trigger takes the accent tint (Customize's filter pills). */
  readonly pill?: boolean;
}

/**
 * A quiet dropdown trigger: its label and chevron, no fill until hovered.
 * Filters, the sort and the Filter menu of a page search row share it.
 */
export const PageDropdownTrigger = forwardRef<
  HTMLButtonElement,
  PageDropdownTriggerProps
>(function PageDropdownTrigger(
  { label, open, active = false, size = 'page', icon, pill = false, ...props },
  ref,
): JSX.Element {
  return (
    <PickerTrigger
      {...props}
      ref={ref}
      variant="capsule"
      size={size}
      labelOnly
      tone={pill && active ? 'selected' : active ? 'default' : 'secondary'}
      aria-expanded={open}
      aria-haspopup="menu"
      data-active={active ? 'true' : 'false'}
      className="shrink-0"
    >
      {icon ? (
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {icon}
        </span>
      ) : null}
      <span
        className={`whitespace-nowrap ${active && !pill ? 'fg-primary' : ''}`.trim()}
      >
        {label}
      </span>
      <PickerTriggerChevron open={open} />
    </PickerTrigger>
  );
});

PageDropdownTrigger.displayName = 'PageDropdownTrigger';

export interface FilterOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Rows carrying this value in the unfiltered set; omitted when unknown. */
  readonly count?: number;
  readonly icon?: ReactNode;
}

interface FilterRowsProps<T extends string> {
  /** The row that clears the filter: `Any trigger`. Omit for a lone toggle. */
  readonly anyLabel?: string;
  readonly options: readonly FilterOption<T>[];
  readonly selected: readonly T[];
  readonly onToggle: (value: T) => void;
  readonly onClear: () => void;
  readonly multiple: boolean;
  readonly testId: string;
  readonly replayPrivacy?: FilterReplayPrivacy;
}

/**
 * Host-owned replay markers for option labels that name user content: the
 * block class for personal data, the mask class for user-authored titles
 * such as project names.
 */
interface FilterReplayPrivacy {
  readonly blockClassName?: string;
  readonly maskClassName?: string;
}

/** The markers as one class list, empty when the host supplies none. */
function replayPrivacyClassName(privacy?: FilterReplayPrivacy): string {
  return [privacy?.blockClassName, privacy?.maskClassName]
    .filter((name): name is string => Boolean(name))
    .join(' ');
}

/** The "any" row, then one checkable row per value with its count. */
function FilterRows<T extends string>({
  anyLabel,
  options,
  selected,
  onToggle,
  onClear,
  multiple,
  testId,
  replayPrivacy,
}: FilterRowsProps<T>): JSX.Element {
  const valueClassName = replayPrivacyClassName(replayPrivacy);
  const active = selected.length > 0;
  return (
    <>
      {anyLabel === undefined ? null : (
        <DropdownMenuItem
          role="menuitemradio"
          aria-checked={!active}
          data-testid={`${testId}-any`}
          onClick={onClear}
        >
          <DropdownMenuItemIcon>
            {active ? null : <CheckIcon size="sm" aria-hidden="true" />}
          </DropdownMenuItemIcon>
          <span className="truncate">{anyLabel}</span>
        </DropdownMenuItem>
      )}
      {options.map((option, index) => {
        const checked = selected.includes(option.value);
        return (
          <DropdownMenuItem
            key={option.value}
            role={multiple ? 'menuitemcheckbox' : 'menuitemradio'}
            aria-checked={checked}
            data-testid={`${testId}-option-${valueClassName ? String(index) : option.value}`}
            onClick={(): void => onToggle(option.value)}
          >
            <DropdownMenuItemIcon>
              {checked ? <CheckIcon size="sm" aria-hidden="true" /> : null}
            </DropdownMenuItemIcon>
            {option.icon ? (
              <DropdownMenuItemIcon>{option.icon}</DropdownMenuItemIcon>
            ) : null}
            <span className={`min-w-0 flex-1 truncate ${valueClassName}`}>
              {option.label}
            </span>
            {option.count !== undefined ? (
              <span className="shrink-0 pl-3 text-xs tabular-nums fg-tertiary">
                {option.count}
              </span>
            ) : null}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

export interface FilterDropdownProps<T extends string> {
  /** The menu's heading and the trigger's accessible name: `Trigger`. */
  readonly title: string;
  /** The trigger's text for the current selection: `Any trigger`. */
  readonly label: string;
  /** The row that clears the filter: `Any trigger`. Omit for a lone toggle. */
  readonly anyLabel?: string;
  readonly options: readonly FilterOption<T>[];
  readonly selected: readonly T[];
  readonly onToggle: (value: T) => void;
  readonly onClear: () => void;
  /** Keep the menu open so several values can be picked. */
  readonly multiple?: boolean;
  readonly testId: string;
  /** `page` in a page search row; `default` in a toolbar. */
  readonly size?: 'default' | 'page';
  /** A leading glyph on the trigger. */
  readonly icon?: ReactNode;
  /** The trigger takes the accent tint while a value is picked. */
  readonly pill?: boolean;
  /**
   * Keeps the picked value and each option's label out of session replay,
   * for values such as people's names or project titles; the accessible name
   * then carries only the title. With a marker set, an option's test id
   * carries its position instead of its value, since replay records the
   * attribute as is.
   */
  readonly replayPrivacy?: FilterReplayPrivacy;
}

/**
 * One filter as a quiet dropdown of counted values. The trigger names what
 * the filter keeps; picking the "any" row clears it.
 */
export function FilterDropdown<T extends string>({
  title,
  label,
  anyLabel,
  options,
  selected,
  onToggle,
  onClear,
  multiple = false,
  testId,
  size = 'page',
  icon,
  pill = false,
  replayPrivacy,
}: FilterDropdownProps<T>): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const active = selected.length > 0;
  return (
    <>
      <PageDropdownTrigger
        ref={anchorRef}
        size={size}
        icon={icon}
        pill={pill}
        label={
          active && replayPrivacy ? (
            <span className={replayPrivacyClassName(replayPrivacy)}>
              {label}
            </span>
          ) : (
            label
          )
        }
        open={open}
        active={active}
        aria-label={active && replayPrivacy ? title : `${title}: ${label}`}
        data-testid={testId}
        onClick={(): void => setOpen((current) => !current)}
      />
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-left"
        closeOnSelect={!multiple}
        className="min-w-52"
        data-testid={`${testId}-menu`}
      >
        <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
          <DropdownMenuLabel>{title}</DropdownMenuLabel>
          <FilterRows
            anyLabel={anyLabel}
            options={options}
            selected={selected}
            onToggle={onToggle}
            onClear={onClear}
            multiple={multiple}
            testId={testId}
            replayPrivacy={replayPrivacy}
          />
        </DropdownMenuRowStyleProvider>
      </FloatingMenu>
    </>
  );
}

export interface PageToggleFilterProps {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly pressed: boolean;
  readonly onPressedChange: (pressed: boolean) => void;
  /** A small counter after the label, such as new shares. */
  readonly count?: number;
  readonly testId: string;
  readonly countTestId?: string;
}

/**
 * One on/off filter as a quiet pill in a page search row: icon and label,
 * the accent tint while it is on, pressed again to clear it.
 */
export function PageToggleFilter({
  label,
  icon,
  pressed,
  onPressedChange,
  count,
  testId,
  countTestId,
}: PageToggleFilterProps): JSX.Element {
  return (
    <PickerTrigger
      variant="capsule"
      size="page"
      labelOnly
      tone={pressed ? 'selected' : 'secondary'}
      aria-pressed={pressed}
      data-testid={testId}
      data-active={pressed ? 'true' : 'false'}
      className="shrink-0"
      onClick={(): void => onPressedChange(!pressed)}
    >
      {icon ? (
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {icon}
        </span>
      ) : null}
      <span className="whitespace-nowrap">{label}</span>
      {count !== undefined && count > 0 ? (
        <span
          data-testid={countTestId}
          className="text-xs tabular-nums fg-tertiary"
        >
          {count}
        </span>
      ) : null}
    </PickerTrigger>
  );
}

/** `Filter`, or `Filter · 2` while two filters are on. */
export function filterMenuLabel(activeCount: number): string {
  return activeCount > 0 ? `Filter · ${String(activeCount)}` : 'Filter';
}

export interface FilterMenuTriggerProps extends Omit<
  PageDropdownTriggerProps,
  'label' | 'active' | 'size'
> {
  /** Filters that are on. */
  readonly activeCount: number;
}

/**
 * The quiet `Filter` dropdown after a page's search, for a page with more
 * filters than fit inline. It counts the filters that are on.
 */
export const FilterMenuTrigger = forwardRef<
  HTMLButtonElement,
  FilterMenuTriggerProps
>(function FilterMenuTrigger(
  { activeCount, open, ...props },
  ref,
): JSX.Element {
  const active = activeCount > 0;
  return (
    <PageDropdownTrigger
      aria-label={active ? `Filters: ${String(activeCount)} on` : 'Filter'}
      {...props}
      ref={ref}
      label={filterMenuLabel(activeCount)}
      open={open}
      active={active}
    />
  );
});

FilterMenuTrigger.displayName = 'FilterMenuTrigger';

/** One filter in a {@link FilterMenuButton}'s menu: a row and its submenu. */
export interface FilterMenuGroup {
  readonly key: string;
  /** The row's name: `Status`. */
  readonly title: string;
  /** The row's leading 14px glyph, as in the sidebar's submenu rows. */
  readonly icon: ReactNode;
  readonly active: boolean;
  /** Keep the submenu open so several values can be picked. */
  readonly multiple: boolean;
  /** The row's test id; its submenu is `{testId}-menu`. */
  readonly testId: string;
  /** The submenu's rows. */
  readonly rows: ReactNode;
}

export interface FilterMenuButtonProps {
  /** One row per filter, each opening its own submenu. */
  readonly groups: readonly FilterMenuGroup[];
  readonly onClearAll: () => void;
  readonly testId: string;
  /** The trigger's accessible name: `Filter entries`. Defaults to `Filter`. */
  readonly name?: string;
}

/**
 * The Filter dropdown: one row per filter (its glyph, its name and a
 * chevron, like the sidebar's submenu rows), each opening that filter's
 * values as a submenu (one open at a time); a row whose filter is on keeps
 * the selected surface. Clear filters ends the menu while any is on.
 */
export function FilterMenuButton({
  groups,
  onClearAll,
  testId,
  name,
}: FilterMenuButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const activeCount = groups.filter((group) => group.active).length;
  const accessibleName =
    name === undefined
      ? undefined
      : activeCount > 0
        ? `${name}: ${String(activeCount)} on`
        : name;
  return (
    <>
      <FilterMenuTrigger
        ref={anchorRef}
        activeCount={activeCount}
        open={open}
        data-testid={testId}
        {...(accessibleName === undefined
          ? {}
          : { 'aria-label': accessibleName })}
        onClick={(): void => setOpen((current) => !current)}
      />
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        closeOnSelect={false}
        className="min-w-56"
        data-testid={`${testId}-menu`}
      >
        <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
          {groups.map((group) => (
            <NestedMenuFlyout
              key={group.key}
              label={group.title}
              leading={group.icon}
              triggerTestId={group.testId}
              menuTestId={`${group.testId}-menu`}
              closeOnSelect={!group.multiple}
              containsSelection={group.active}
            >
              {group.rows}
            </NestedMenuFlyout>
          ))}
          {activeCount > 0 ? (
            <>
              <DropdownMenuDivider />
              <DropdownMenuItem
                data-testid={`${testId}-clear`}
                onClick={(): void => {
                  onClearAll();
                  setOpen(false);
                  // The menu stays open on select, so it never hands focus
                  // back itself; the row this closes was focused.
                  anchorRef.current?.focus();
                }}
              >
                <DropdownMenuItemIcon />
                <span className="truncate">Clear filters</span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuRowStyleProvider>
      </FloatingMenu>
    </>
  );
}

export interface SortDropdownProps<T extends string> {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
  readonly testId: string;
}

/** The sort, last in a page search row: `Sort: Recently run`. */
export function SortDropdown<T extends string>({
  value,
  options,
  onChange,
  testId,
}: SortDropdownProps<T>): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const current = options.find((option) => option.value === value);
  const label = `Sort: ${current?.label ?? ''}`.trim();
  return (
    <>
      <PageDropdownTrigger
        ref={anchorRef}
        label={label}
        open={open}
        aria-label={label}
        data-testid={testId}
        onClick={(): void => setOpen((currentOpen) => !currentOpen)}
      />
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        className="min-w-48"
        data-testid={`${testId}-menu`}
      >
        <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
          <DropdownMenuLabel>Sort by</DropdownMenuLabel>
          {options.map((option) => {
            const checked = option.value === value;
            return (
              <DropdownMenuItem
                key={option.value}
                role="menuitemradio"
                aria-checked={checked}
                data-testid={`${testId}-option-${option.value}`}
                onClick={(): void => onChange(option.value)}
              >
                <DropdownMenuItemIcon>
                  {checked ? <CheckIcon size="sm" aria-hidden="true" /> : null}
                </DropdownMenuItemIcon>
                <span className="truncate">{option.label}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuRowStyleProvider>
      </FloatingMenu>
    </>
  );
}

/** Filters that still sit inline after the search; more go behind Filter. */
export const PAGE_SEARCH_INLINE_FILTER_LIMIT = 3;

/**
 * One filter of a page search row, drawn either as its own dropdown or as a
 * row of the Filter menu. Build it with {@link pageFilter}.
 */
export interface PageFilter {
  readonly key: string;
  readonly active: boolean;
  readonly dropdown: ReactNode;
  readonly group: FilterMenuGroup;
}

export interface PageFilterSpec<T extends string> extends Omit<
  FilterDropdownProps<T>,
  'label' | 'size'
> {
  readonly key: string;
  /**
   * The dropdown's text for the current selection. Defaults to the any
   * row, the one value picked, or `{title}: {n}`.
   */
  readonly label?: string;
  /** The filter's glyph on its Filter menu row. Defaults to the filter glyph. */
  readonly groupIcon?: ReactNode;
}

/** One filter, ready to sit inline or in the Filter menu. */
export function pageFilter<T extends string>({
  key,
  label,
  groupIcon = <ListFilterIcon />,
  ...spec
}: PageFilterSpec<T>): PageFilter {
  const picked = spec.selected;
  const first = picked[0];
  const anyText = spec.anyLabel ?? spec.title;
  const pickedLabel =
    first === undefined
      ? anyText
      : (spec.options.find((option) => option.value === first)?.label ??
        anyText);
  return {
    key,
    active: picked.length > 0,
    dropdown: (
      <FilterDropdown<T>
        {...spec}
        label={
          label ??
          (picked.length > 1
            ? `${spec.title}: ${String(picked.length)}`
            : pickedLabel)
        }
      />
    ),
    group: {
      key,
      title: spec.title,
      icon: groupIcon,
      active: picked.length > 0,
      multiple: spec.multiple === true,
      testId: spec.testId,
      rows: (
        <FilterRows<T>
          anyLabel={spec.anyLabel}
          options={spec.options}
          selected={spec.selected}
          onToggle={spec.onToggle}
          onClear={spec.onClear}
          multiple={spec.multiple === true}
          testId={spec.testId}
          replayPrivacy={spec.replayPrivacy}
        />
      ),
    },
  };
}

export interface PageSearchFiltersProps {
  readonly filters: readonly PageFilter[];
  /** Clears every filter at once, from the Filter menu. */
  readonly onClearAll: () => void;
  /** The Filter dropdown's test id, when the filters go behind it. */
  readonly testId: string;
}

/**
 * A page's filters after its search: inline dropdowns for up to
 * {@link PAGE_SEARCH_INLINE_FILTER_LIMIT}, otherwise one Filter dropdown
 * holding them all.
 */
export function PageSearchFilters({
  filters,
  onClearAll,
  testId,
}: PageSearchFiltersProps): JSX.Element {
  if (filters.length > PAGE_SEARCH_INLINE_FILTER_LIMIT) {
    return (
      <FilterMenuButton
        groups={filters.map((filter) => filter.group)}
        onClearAll={onClearAll}
        testId={testId}
      />
    );
  }
  return (
    <>
      {filters.map((filter) => (
        <Fragment key={filter.key}>{filter.dropdown}</Fragment>
      ))}
    </>
  );
}
