import {
  useEffect,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

/** One tab of a {@link TabBar}. */
export interface TabBarItem<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Shown before the label. */
  readonly icon?: ReactNode;
  /** Shown after the label, in the current context. Zero shows none. */
  readonly count?: number;
  /** `destructive` for a tab whose view holds a destructive action. */
  readonly tone?: 'default' | 'destructive';
  readonly dataTestId?: string;
  /** Test id of the count, when one shows. */
  readonly countTestId?: string;
  /** The tab's element id, for the panel's `aria-labelledby`. */
  readonly tabId?: string;
  /** The panel this tab shows, when each tab has its own panel. */
  readonly panelId?: string;
}

/** How the user picked a tab. */
export type TabBarChangeSource = 'pointer' | 'keyboard';

export type TabBarOrientation = 'horizontal' | 'vertical';

/**
 * `default`: the 14px label of a page header's tabs. `compact`: the 13px
 * medium label of tabs in a dialog header.
 */
export type TabBarDensity = 'default' | 'compact';

/** Horizontal inset of the tabs inside a full-width list. */
export type TabBarInset = 'none' | 'dialog';

export interface TabBarProps<T extends string> {
  readonly items: readonly TabBarItem<T>[];
  readonly value: T;
  readonly onChange: (next: T, source: TabBarChangeSource) => void;
  /** Accessible name of the tab list. */
  readonly label: string;
  readonly orientation?: TabBarOrientation;
  readonly density?: TabBarDensity;
  /** Id of the panel the tabs show, set as every tab's `aria-controls`. */
  readonly panelId?: string;
  /**
   * Focus the selected tab when the bar mounts. A host whose panels each
   * render their own bar sets it after a keyboard change, so focus follows
   * the selection into the new panel's bar.
   */
  readonly focusSelectedOnMount?: boolean;
  /**
   * Scroll sideways instead of overflowing when the tabs do not fit, such as
   * a dialog header that can be narrower than its tabs.
   */
  readonly scrollable?: boolean;
  /**
   * `dialog` insets the tabs 24px from the list's edges, in line with a
   * dialog's content, while the divider still runs edge to edge.
   */
  readonly inset?: TabBarInset;
  readonly dataTestId?: string;
  /** Placement only; the tab list owns its own layout. */
  readonly className?: string;
}

const NEXT_KEY: Readonly<Record<TabBarOrientation, string>> = {
  horizontal: 'ArrowRight',
  vertical: 'ArrowDown',
};

const PREVIOUS_KEY: Readonly<Record<TabBarOrientation, string>> = {
  horizontal: 'ArrowLeft',
  vertical: 'ArrowUp',
};

export function tabNavigationIndex(
  key: string,
  index: number,
  count: number,
  orientation: TabBarOrientation = 'horizontal',
): number | undefined {
  switch (key) {
    case NEXT_KEY[orientation]:
      return (index + 1) % count;
    case PREVIOUS_KEY[orientation]:
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

const LABEL_CLASS_NAME: Readonly<Record<TabBarDensity, string>> = {
  default: 'text-s',
  compact: 'text-xs font-medium',
};

const INSET_CLASS_NAME: Readonly<Record<TabBarInset, string>> = {
  none: '',
  dialog: ' px-6',
};

function listClassName(
  orientation: TabBarOrientation,
  scrollable: boolean,
  inset: TabBarInset,
  className: string | undefined,
): string {
  const layout =
    orientation === 'vertical'
      ? `flex flex-col gap-0.5${INSET_CLASS_NAME[inset]}`
      : `canopy-tab-list flex shrink-0${scrollable ? ' min-w-0 overflow-x-auto overflow-y-hidden' : ''}${INSET_CLASS_NAME[inset]}`;
  return className ? `${layout} ${className}` : layout;
}

function inkClassName(selected: boolean, destructive: boolean): string {
  // A destructive tab stays full red whether or not it is selected; the
  // underline marks the selection.
  if (destructive) return 'fg-destructive';
  return selected ? 'fg-primary' : 'fg-secondary hover:fg-primary';
}

/**
 * A vertical tab draws its focus ring inside the row, like a sidebar row, so
 * the rail's scroll box cannot cut it off. A horizontal tab has no side
 * padding (its label is the underline's width), so an inside ring would sit
 * on the glyphs; it keeps the outside ring except in a scrolling bar.
 */
function tabClassName(
  orientation: TabBarOrientation,
  density: TabBarDensity,
  scrollable: boolean,
  selected: boolean,
  destructive: boolean,
): string {
  if (orientation === 'vertical') {
    // The sidebar row's surfaces (sidebar-item-classes): selection is a
    // background change, never color alone.
    const surface = selected ? 'bg-muted' : 'hover:bg-subtle';
    return `focus-ring focus-ring-inset flex h-8 w-full items-center gap-2 rounded-row px-2 text-left ${LABEL_CLASS_NAME[density]} transition-colors ${surface} ${inkClassName(selected, destructive)}`;
  }
  return `canopy-tab-trigger focus-ring${scrollable ? ' focus-ring-inset' : ''} inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 pointer-coarse:min-h-11 ${LABEL_CLASS_NAME[density]} transition-colors ${inkClassName(selected, destructive)}`;
}

/**
 * The shared tab bar: peer views within one stable context. Only the selected
 * tab is in the Tab order; the arrow keys (Left/Right, or Up/Down when
 * vertical), Home and End move between tabs and select the one they land on.
 * Horizontal tabs draw the shared underline; vertical tabs are sidebar rows.
 */
export function TabBar<T extends string>({
  items,
  value,
  onChange,
  label,
  orientation = 'horizontal',
  density = 'default',
  panelId,
  focusSelectedOnMount = false,
  scrollable = false,
  inset = 'none',
  dataTestId,
  className,
}: TabBarProps<T>): JSX.Element {
  const tabRefs = useRef(new Map<T, HTMLButtonElement>());
  const initial = useRef({ value, focusSelectedOnMount });

  useEffect(() => {
    if (initial.current.focusSelectedOnMount) {
      tabRefs.current.get(initial.current.value)?.focus();
    }
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    // From the focused tab, not the value: a host that selects later (a
    // router) or not at all must not hold the arrows on one tab.
    const index = items.findIndex(
      (item) => tabRefs.current.get(item.id) === event.currentTarget,
    );
    const nextIndex = tabNavigationIndex(
      event.key,
      index,
      items.length,
      orientation,
    );
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = items[nextIndex];
    if (next === undefined) return;
    tabRefs.current.get(next.id)?.focus();
    onChange(next.id, 'keyboard');
  };

  // A value that names no tab still leaves one tab reachable with Tab.
  const tabbableId = items.some((item) => item.id === value)
    ? value
    : items[0]?.id;

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation={orientation === 'vertical' ? 'vertical' : undefined}
      data-testid={dataTestId}
      className={listClassName(orientation, scrollable, inset, className)}
    >
      {items.map((item) => {
        const selected = item.id === value;
        const count = item.count;
        return (
          <button
            key={item.id}
            ref={(element): void => {
              if (element) tabRefs.current.set(item.id, element);
              else tabRefs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={item.tabId}
            data-testid={item.dataTestId}
            aria-selected={selected}
            aria-controls={item.panelId ?? panelId}
            tabIndex={item.id === tabbableId ? 0 : -1}
            onClick={(): void => onChange(item.id, 'pointer')}
            onKeyDown={onKeyDown}
            className={tabClassName(
              orientation,
              density,
              scrollable,
              selected,
              item.tone === 'destructive',
            )}
          >
            {item.icon}
            <span>{item.label}</span>
            {count !== undefined && count > 0 ? (
              <span
                className="text-xs tabular-nums fg-tertiary"
                data-testid={item.countTestId}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
