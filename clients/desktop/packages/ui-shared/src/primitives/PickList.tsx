'use client';

import { SearchField, type SearchFieldProps } from './SearchField';
import { Skeleton } from './Skeleton';
import { isCoarsePointerNow } from './useMediaQuery';
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  PickerMenuList,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuSearchHeader,
  PickerMenuSearchInput,
  PickerMenuSampleOptions,
  PickerMenuSection,
  PickerMenuSectionLabel,
  PickerMenuState,
} from './PickerMenu';

export interface PickListRowState {
  /** The keyboard-active row (the neutral picker highlight). */
  readonly active: boolean;
  /** The current value, when the list marks one. */
  readonly selected: boolean;
  /** The keyboard skips this row and a click does nothing. */
  readonly disabled: boolean;
}

/** Test ids and `data-*` a host needs on a row; never its role or handlers. */
export type PickListOptionProps = Readonly<
  Record<`data-${string}`, string | undefined>
>;

/** The rows of a list, shared by `PickList` and `PickListResults`. */
interface PickListRowProps<T> {
  readonly items: readonly T[];
  readonly getKey: (item: T) => string;
  /** The default row label, and the text `PickList` matches. */
  readonly getLabel: (item: T) => string;
  /** Row content; defaults to the label. Draw it with the PickerMenuOption parts. */
  readonly renderItem?: (item: T, state: PickListRowState) => ReactNode;
  /**
   * A control beside the row, not inside it (a tab's close button): it stays
   * outside the `option`, so it is reachable and not read as the row.
   */
  readonly renderRowEnd?: (item: T, state: PickListRowState) => ReactNode;
  /** A click, and Enter unless `onActivate` is set. */
  readonly onPick: (item: T) => void;
  /** For a list where a click only selects: a double-click and Enter activate. */
  readonly onActivate?: (item: T) => void;
  /** Heading of a row's section. Rows in a run with one heading form a group. */
  readonly getSection?: (item: T) => string | undefined;
  /** Disabled rows stay visible; the keyboard skips them. */
  readonly isItemDisabled?: (item: T) => boolean;
  /** Names the list of results for assistive tech. */
  readonly listLabel: string;
  /** Results are on their way: placeholder rows replace the list. */
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  /** One sentence for no results: `No commands match.` */
  readonly emptyLabel: ReactNode;
  readonly selectedKey?: string;
  readonly optionTestId?: (item: T) => string;
  readonly optionProps?: (
    item: T,
    state: PickListRowState,
  ) => PickListOptionProps;
}

export interface PickListProps<T> extends PickListRowProps<T> {
  /** Names the search field: `Search commands`. */
  readonly searchLabel: string;
  readonly placeholder?: string;
  /**
   * Controlled search text, for a list whose results come from elsewhere
   * (a server search). Without it the list filters `items` by label.
   */
  readonly query?: string;
  readonly onQueryChange?: (query: string) => void;
  /** Local filter; defaults to a case-insensitive label match. */
  readonly filter?: (item: T, query: string) => boolean;
  /** Between the search field and the list: a row of tabs. */
  readonly header?: ReactNode;
  /** Move focus to the search field on mount (default true). */
  readonly autoFocus?: boolean;
  /** Lets the surrounding floating menu focus the search when positioned. */
  readonly inputRef?: RefObject<HTMLInputElement | null>;
  /** Escape in the search field, for a host that closes on it. */
  readonly onEscape?: () => void;
  readonly 'data-testid'?: string;
  readonly searchTestId?: string;
  /** Initially highlight the selected option when it is visible. */
  readonly preferSelectedForNavigation?: boolean;
  /**
   * Caps the search field and list at this height so the list scrolls:
   * `md` (256px) in a popover or picker, `lg` (384px) in a palette.
   * Default: the host's height.
   */
  readonly listMaxHeight?: 'md' | 'lg';
}

export interface PickListResultsProps<T> extends PickListRowProps<T> {
  /** The listbox's id: the host's `aria-controls`. */
  readonly listId: string;
  /** The active row, from `resolvePickListActiveKey`. */
  readonly activeKey: string | null;
  /** The pointer moved onto a row. */
  readonly onActiveKeyChange: (key: string) => void;
}

/** The DOM id of a row: the host's `aria-activedescendant`. */
export function pickListOptionId(listId: string, key: string): string {
  return `${listId}-option-${encodeURIComponent(key)}`;
}

/**
 * The row to highlight: the one the user moved to while it is still in the
 * list, else the current value, else the first row. `keys` holds only the rows
 * the keyboard can reach. A list refresh keeps the user's row; it never moves
 * the highlight on its own.
 */
export function resolvePickListActiveKey(
  keys: readonly string[],
  movedKey: string | null,
  selectedKey?: string,
): string | null {
  if (movedKey !== null && keys.includes(movedKey)) return movedKey;
  if (selectedKey !== undefined && keys.includes(selectedKey)) {
    return selectedKey;
  }
  return keys[0] ?? null;
}

/** The parts of a React or DOM keyboard event the list reads. */
export interface PickListKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly target?: EventTarget | null;
  readonly isComposing?: boolean;
  readonly nativeEvent?: { readonly isComposing: boolean };
  preventDefault: () => void;
}

export interface UsePickListKeysOptions {
  /** Keys of the rendered rows the keyboard can reach, in order. */
  readonly keys: readonly string[];
  readonly activeKey: string | null;
  readonly onActiveKeyChange: (key: string) => void;
  /** Enter on the active row. */
  readonly onPick: (key: string) => void;
  /** Escape, for a host that closes on it. */
  readonly onEscape?: () => void;
  /**
   * An arrow moved past the rendered rows. Return true when the host brought
   * in another window of rows; otherwise the highlight wraps.
   */
  readonly clampEdges?: boolean;
  readonly onEdge?: (direction: 'previous' | 'next') => boolean;
}

/**
 * The list keyboard for whichever input owns focus: a `SearchField`, or a
 * Slate editor through its own hook. The arrows move the active row and Enter
 * picks it. Home and End move the caret in text fields and navigate elsewhere.
 * Keys during an IME composition belong to the input method.
 */
export function usePickListKeys({
  keys,
  activeKey,
  onActiveKeyChange,
  onPick,
  onEscape,
  onEdge,
  clampEdges = false,
}: UsePickListKeysOptions): (event: PickListKeyEvent) => boolean {
  return useCallback(
    (event: PickListKeyEvent): boolean => {
      if (
        (event.nativeEvent?.isComposing ?? event.isComposing) ||
        event.key === 'Process'
      )
        return false;
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        onEscape();
        return true;
      }
      if (keys.length === 0) return false;
      const active = activeKey === null ? -1 : keys.indexOf(activeKey);
      const last = keys.length - 1;
      if (event.key === 'Enter') {
        if (activeKey === null || active < 0) return false;
        event.preventDefault();
        onPick(activeKey);
        return true;
      }
      if (
        (event.key === 'Home' || event.key === 'End') &&
        event.target &&
        'nodeName' in event.target &&
        (event.target.nodeName === 'INPUT' ||
          event.target.nodeName === 'TEXTAREA')
      ) {
        return false;
      }
      let next: number | null = null;
      if (event.key === 'ArrowDown') {
        if (active >= last && onEdge?.('next')) {
          event.preventDefault();
          return true;
        }
        next = active >= last ? (clampEdges ? last : 0) : active + 1;
      } else if (event.key === 'ArrowUp') {
        if (active === 0 && onEdge?.('previous')) {
          event.preventDefault();
          return true;
        }
        next = active <= 0 ? (clampEdges ? 0 : last) : active - 1;
      } else if (event.key === 'Home' && !event.shiftKey) next = 0;
      else if (event.key === 'End' && !event.shiftKey) next = last;
      const nextKey = next === null ? undefined : keys[next];
      if (nextKey === undefined) return false;
      event.preventDefault();
      onActiveKeyChange(nextKey);
      return true;
    },
    [activeKey, keys, onActiveKeyChange, clampEdges, onEdge, onEscape, onPick],
  );
}

interface PickListSearchProps extends Omit<
  ComponentPropsWithoutRef<typeof PickerMenuSearchInput>,
  'onKeyDown' | 'role' | 'aria-controls' | 'aria-activedescendant'
> {
  readonly listId: string;
  readonly activeDescendant?: string;
  readonly keyboard: UsePickListKeysOptions;
}

/** Search field for a list that draws its own groups or compound options. */
export const PickListSearch = forwardRef<HTMLInputElement, PickListSearchProps>(
  function PickListSearch(
    { listId, activeDescendant, keyboard, ...props },
    ref,
  ): JSX.Element {
    const handleKeys = usePickListKeys(keyboard);
    return (
      <PickerMenuSearchInput
        {...props}
        ref={ref}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={activeDescendant}
        onKeyDown={(event) => {
          if (handleKeys(event)) event.stopPropagation();
        }}
      />
    );
  },
);

interface PickListFieldProps extends SearchFieldProps {
  readonly keyboard: UsePickListKeysOptions;
  readonly listId?: string;
  readonly activeDescendant?: string;
}

/** A palette search field that retains focus while controlling its options. */
export const PickListField = forwardRef<HTMLInputElement, PickListFieldProps>(
  function PickListField(
    { keyboard, listId, activeDescendant, ...props },
    ref,
  ): JSX.Element {
    const handleKeys = usePickListKeys(keyboard);
    return (
      <SearchField
        {...props}
        ref={ref}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listId !== undefined}
        aria-controls={listId}
        aria-activedescendant={activeDescendant}
        onKeyDown={(event) => {
          if (handleKeys(event)) event.stopPropagation();
        }}
      />
    );
  },
);

/** Adjacent rows that share a heading. A row with no heading ends a run. */
function sectionRuns<T>(
  items: readonly T[],
  getSection: (item: T) => string | undefined,
): readonly { readonly section: string | undefined; readonly rows: T[] }[] {
  const runs: { section: string | undefined; rows: T[] }[] = [];
  for (const item of items) {
    const section = getSection(item);
    const run = runs.at(-1);
    if (run && section !== undefined && run.section === section) {
      run.rows.push(item);
    } else {
      runs.push({ section, rows: [item] });
    }
  }
  return runs;
}

/**
 * The listbox of a `PickList` for a host that owns its own input (a palette's
 * `SearchField`, a composer's editor): `listbox`, `group` and `option` roles,
 * scrolling the active row into view, and the empty and loading states. It is
 * controlled: `usePickListKeys` moves `activeKey`. Give only the rows to
 * render, so the keyboard and this list never walk a long result set.
 */
export function PickListResults<T>({
  items,
  getKey,
  getLabel,
  renderItem,
  renderRowEnd,
  onPick,
  onActivate,
  getSection,
  isItemDisabled,
  listId,
  listLabel,
  activeKey,
  onActiveKeyChange,
  loading = false,
  loadingLabel = 'Loading',
  emptyLabel,
  selectedKey,
  optionTestId,
  optionProps,
}: PickListResultsProps<T>): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeKey === null) return;
    listRef.current?.ownerDocument
      .getElementById(pickListOptionId(listId, activeKey))
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeKey, items, listId, loading]);

  const renderRow = (item: T): JSX.Element => {
    const key = getKey(item);
    const state: PickListRowState = {
      active: key === activeKey,
      selected: selectedKey === key,
      disabled: isItemDisabled?.(item) ?? false,
    };
    const rowEnd = renderRowEnd?.(item, state);
    const option = (
      <PickerMenuOption
        {...optionProps?.(item, state)}
        key={key}
        id={pickListOptionId(listId, key)}
        role="option"
        tabIndex={-1}
        aria-selected={state.selected}
        aria-disabled={state.disabled || undefined}
        disabled={state.disabled}
        active={state.active}
        {...(renderRowEnd
          ? { trailingSlots: 'one', rowHoverSurface: true }
          : {})}
        {...(optionTestId ? { 'data-testid': optionTestId(item) } : {})}
        // Keep focus in the host's input.
        onMouseDown={(event): void => event.preventDefault()}
        onMouseMove={(): void => {
          if (!state.active && !state.disabled) onActiveKeyChange(key);
        }}
        onClick={(): void => onPick(item)}
        {...(onActivate ? { onDoubleClick: (): void => onActivate(item) } : {})}
      >
        {renderItem ? (
          renderItem(item, state)
        ) : (
          <>
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>{getLabel(item)}</PickerMenuOptionLabel>
            </PickerMenuOptionContent>
            <PickerMenuOptionCheck selected={state.selected} />
          </>
        )}
      </PickerMenuOption>
    );
    if (!renderRowEnd) return option;
    return (
      <div key={key} className="group/model-row relative w-full rounded-md">
        {option}
        <span className="absolute inset-y-0 right-1 flex items-center">
          {rowEnd}
        </span>
      </div>
    );
  };

  return (
    <PickerMenuList
      ref={listRef}
      id={listId}
      aria-label={listLabel}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <Skeleton loading label={loadingLabel}>
          <PickerMenuSampleOptions rows={4} leading={false} />
        </Skeleton>
      ) : items.length === 0 ? (
        <PickerMenuState role="status">{emptyLabel}</PickerMenuState>
      ) : getSection ? (
        sectionRuns(items, getSection).map((run, index) => {
          if (run.section === undefined) return run.rows.map(renderRow);
          // A rule separates a section from the rows above it.
          const Group = index === 0 ? 'div' : PickerMenuSection;
          return (
            <Group
              key={`${run.section}-${index}`}
              role="group"
              aria-labelledby={`${listId}-section-${index}`}
            >
              <PickerMenuSectionLabel id={`${listId}-section-${index}`}>
                {run.section}
              </PickerMenuSectionLabel>
              {run.rows.map(renderRow)}
            </Group>
          );
        })
      ) : (
        items.map(renderRow)
      )}
    </PickerMenuList>
  );
}

function labelMatches(label: string, query: string): boolean {
  return label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

/**
 * The one search-and-pick list: a search field over picker rows. Typing
 * filters; the arrows move the active row while focus stays in the field,
 * and Enter or a click picks. It owns the combobox, `listbox` and
 * `option` semantics and the empty and loading states, so a palette, a
 * picker and the composer's lists behave and read the same. Put it in a
 * `DialogModal` (a palette), a `FloatingPickerMenu` or a `Popover`. A host
 * that owns its input uses `PickListResults` and `usePickListKeys`.
 */
export function PickList<T>({
  items,
  getKey,
  getLabel,
  renderItem,
  renderRowEnd,
  onPick,
  onActivate,
  getSection,
  isItemDisabled,
  searchLabel,
  placeholder,
  listLabel,
  query: controlledQuery,
  onQueryChange,
  filter,
  header,
  loading = false,
  loadingLabel = 'Loading',
  emptyLabel,
  selectedKey,
  autoFocus = true,
  inputRef: providedInputRef,
  onEscape,
  'data-testid': dataTestId,
  searchTestId,
  preferSelectedForNavigation = true,
  optionTestId,
  optionProps,
  listMaxHeight,
}: PickListProps<T>): JSX.Element {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const localInputRef = useRef<HTMLInputElement>(null);
  const inputRef = providedInputRef ?? localInputRef;
  const [localQuery, setLocalQuery] = useState('');
  const query = controlledQuery ?? localQuery;
  const setQuery = (next: string): void => {
    if (controlledQuery === undefined) setLocalQuery(next);
    onQueryChange?.(next);
  };

  const visible = useMemo((): readonly T[] => {
    if (controlledQuery !== undefined && filter === undefined) return items;
    if (query.trim() === '') return items;
    const matches =
      filter ??
      ((item: T, q: string): boolean => labelMatches(getLabel(item), q));
    return items.filter((item) => matches(item, query));
  }, [controlledQuery, filter, getLabel, items, query]);

  const keys = useMemo(
    (): readonly string[] =>
      loading
        ? []
        : (isItemDisabled
            ? visible.filter((item) => !isItemDisabled(item))
            : visible
          ).map(getKey),
    [getKey, isItemDisabled, loading, visible],
  );

  // A move belongs to the query it was made under: a new query starts on its
  // first row (or the current value), and a refresh of the same query keeps
  // the row.
  const [moved, setMoved] = useState<{
    readonly key: string | null;
    readonly query: string;
  }>({ key: null, query });
  if (moved.query !== query) {
    setMoved({ key: null, query });
  }
  const activeKey = resolvePickListActiveKey(
    keys,
    moved.query === query ? moved.key : null,
    preferSelectedForNavigation ? selectedKey : undefined,
  );
  const moveActive = (key: string): void => setMoved({ key, query });

  useEffect(() => {
    // Focusing on touch would open the keyboard before the user asks.
    if (autoFocus && !isCoarsePointerNow())
      inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus, inputRef]);

  const handleKeys = usePickListKeys({
    keys,
    activeKey,
    onActiveKeyChange: moveActive,
    onPick: (key): void => {
      const item = visible.find((candidate) => getKey(candidate) === key);
      if (item !== undefined) (onActivate ?? onPick)(item);
    },
    ...(onEscape ? { onEscape } : {}),
  });

  return (
    <div
      data-testid={dataTestId}
      className={
        listMaxHeight === 'lg'
          ? 'flex max-h-96 min-h-0 flex-col'
          : listMaxHeight === 'md'
            ? 'flex max-h-64 min-h-0 flex-col'
            : 'flex min-h-0 flex-col'
      }
    >
      <PickerMenuSearchHeader>
        <PickerMenuSearchInput
          ref={inputRef}
          role="combobox"
          aria-label={searchLabel}
          aria-expanded={!loading && visible.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeKey === null ? undefined : pickListOptionId(listId, activeKey)
          }
          placeholder={placeholder ?? searchLabel}
          value={query}
          data-testid={searchTestId}
          onChange={(event): void => setQuery(event.target.value)}
          onKeyDown={handleKeys}
          onClear={query ? (): void => setQuery('') : undefined}
        />
      </PickerMenuSearchHeader>
      {header}
      <PickListResults
        items={visible}
        getKey={getKey}
        getLabel={getLabel}
        onPick={onPick}
        listId={listId}
        listLabel={listLabel}
        activeKey={activeKey}
        onActiveKeyChange={moveActive}
        emptyLabel={emptyLabel}
        loading={loading}
        loadingLabel={loadingLabel}
        {...(renderItem ? { renderItem } : {})}
        {...(renderRowEnd ? { renderRowEnd } : {})}
        {...(onActivate ? { onActivate } : {})}
        {...(getSection ? { getSection } : {})}
        {...(isItemDisabled ? { isItemDisabled } : {})}
        {...(selectedKey === undefined ? {} : { selectedKey })}
        {...(optionTestId ? { optionTestId } : {})}
        {...(optionProps ? { optionProps } : {})}
      />
    </div>
  );
}
