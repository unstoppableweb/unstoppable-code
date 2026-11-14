/**
 * The one shared data table for desktop and web (docs/design/layout.md#tables).
 *
 * The look is the framed card: a hairline card on `bg-base`, a 32px header
 * band on `bg-secondary` with 12px medium labels, 36px body rows split by a
 * hairline, 13px text with the first column in the primary ink and the rest
 * secondary, numbers right-aligned in tabular figures. A row takes the hover
 * fill only when it does something.
 *
 * Two layers share that look:
 *
 * - {@link DataTable} takes typed columns and rows and owns sorting, the empty
 *   row and the loading rows. Use it whenever each record is one row.
 * - The parts ({@link DataTableFrame}, {@link DataTableHead},
 *   {@link DataTableHeaderCell}, {@link DataTableBody}, {@link DataTableRow},
 *   {@link DataTableCell}, {@link DataTableEmptyRow},
 *   {@link DataTableSkeletonRows}) are for bodies the column model cannot
 *   express: grouped rows that span, virtualized windows, rows that expand.
 *
 * Neither layer takes a `className` that restyles: geometry, type and color
 * are named props, so every table keeps one look.
 */
import { IconCircleQuestionmark } from '../icons/AppGlyphs.generated';
import { Tooltip } from './Tooltip';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { ArrowUpIcon } from '../icons/AppIcons';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { Skeleton, SKELETON_KEEP } from './Skeleton';
import { EmptyStateRow } from './StatusBlocks';

export type DataTableAlign = 'left' | 'center' | 'right';
/**
 * Ink of a body cell. The first column is primary, the rest secondary;
 * `success` is a value that reports a good outcome (Installed).
 */
export type DataTableTone = 'primary' | 'secondary' | 'tertiary' | 'success';
/**
 * What a cell does with text wider than its column: `nowrap` keeps one line
 * and widens the column (the default, for names, numbers and times),
 * `truncate` cuts it with an ellipsis, and `wrap` breaks it onto more lines
 * (descriptions and other prose).
 */
export type DataTableOverflow = 'nowrap' | 'truncate' | 'wrap';
/** The narrowest viewport at which a column shows; below it, it is hidden. */
export type DataTableBreakpoint = 'sm' | 'md' | 'lg' | 'xl';
export type DataTableSortDirection = 'asc' | 'desc';
export type DataTableVerticalAlign = 'middle' | 'top';
/**
 * How session replay records private text: `block` keeps a same-size
 * placeholder, `mask` replaces the characters.
 */
export type DataTableReplay = 'block' | 'mask';

const REPLAY_CLASS: Record<DataTableReplay, string> = {
  block: REPLAY_BLOCK_CLASS,
  mask: REPLAY_MASK_CLASS,
};

export interface DataTableSort {
  readonly key: string;
  readonly direction: DataTableSortDirection;
}

const TEXT_ALIGN_CLASS: Record<DataTableAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

const TONE_CLASS: Record<DataTableTone, string> = {
  primary: 'fg-primary',
  secondary: 'fg-secondary',
  tertiary: 'fg-tertiary',
  success: 'fg-success',
};

const OVERFLOW_CLASS: Record<DataTableOverflow, string> = {
  nowrap: 'whitespace-nowrap',
  truncate: 'max-w-0 truncate',
  wrap: 'break-words',
};

const SHOW_FROM_CLASS: Record<DataTableBreakpoint, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
};

const VERTICAL_ALIGN_CLASS: Record<DataTableVerticalAlign, string> = {
  middle: 'align-middle',
  // Cells keep py-1 for middle rows. Here the larger padding centers a one-line
  // row in h-9 and keeps text level when another cell wraps.
  top: 'align-top [&>td]:py-2 [&>th]:py-2',
};

const ARIA_SORT: Record<DataTableSortDirection, 'ascending' | 'descending'> = {
  asc: 'ascending',
  desc: 'descending',
};

function joinClasses(
  ...classes: ReadonlyArray<string | false | undefined>
): string {
  return classes.filter(Boolean).join(' ');
}

// ------------------------------------------------------------------- Frame

export interface DataTableFrameProps {
  /** Screen-reader name of the table, rendered as a hidden `<caption>`. */
  readonly caption?: string;
  /**
   * `fixed` sizes columns from the header widths and shares the rest evenly,
   * so long text truncates instead of widening the table. `auto` (the
   * default) sizes columns to their content.
   */
  readonly layout?: 'auto' | 'fixed';
  /**
   * The narrowest the table may get, as a CSS length. Narrower than this the
   * card scrolls sideways instead of squeezing the columns.
   */
  readonly minWidth?: string;
  /**
   * The tallest the card may get, as a CSS length. Taller than this the rows
   * scroll inside the card; pair it with a sticky header.
   */
  readonly maxHeight?: string;
  /**
   * The card fills the rest of a flex column and its rows scroll inside it;
   * pair it with a sticky header.
   */
  readonly fill?: boolean;
  /** The element the rows scroll in, for a virtualizer or scroll restore. */
  readonly scrollRef?: RefObject<HTMLDivElement | null>;
  /** Marks the table busy while its rows load. */
  readonly busy?: boolean;
  readonly testId?: string;
  /** Placement only: margin, width, visibility and flex participation. */
  readonly className?: string;
  readonly children: ReactNode;
}

/** Which sides of a sideways-scrolling table are out of view. */
type FrameOverflow = 'none' | 'start' | 'end' | 'both';

function readFrameOverflow(frame: HTMLElement): FrameOverflow {
  const hidden = frame.scrollWidth - frame.clientWidth;
  if (hidden <= 1) return 'none';
  const before = frame.scrollLeft > 1;
  const after = frame.scrollLeft < hidden - 1;
  if (before && after) return 'both';
  return before ? 'start' : 'end';
}

/**
 * The card and the `<table>`: a hairline card that clips the rows to its
 * radius. A table wider than the card scrolls inside it (CAN-4258): the
 * hidden side fades, since overlay scrollbars hide at rest, and the card
 * becomes a named keyboard stop that arrow keys scroll. A table that fits
 * adds neither.
 */
export function DataTableFrame({
  caption,
  layout = 'auto',
  minWidth,
  maxHeight,
  fill = false,
  scrollRef,
  busy,
  testId,
  className,
  children,
}: DataTableFrameProps): JSX.Element {
  const ownRef = useRef<HTMLDivElement>(null);
  const frameRef = scrollRef ?? ownRef;
  const [overflow, setOverflow] = useState<FrameOverflow>('none');
  useEffect((): (() => void) | undefined => {
    const frame = frameRef.current;
    if (frame === null) return undefined;
    // Only an edge change re-renders, so scrolling stays off React.
    const update = (): void => setOverflow(readFrameOverflow(frame));
    update();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(frame);
    if (frame.firstElementChild) observer?.observe(frame.firstElementChild);
    frame.addEventListener('scroll', update, { passive: true });
    return (): void => {
      observer?.disconnect();
      frame.removeEventListener('scroll', update);
    };
  }, [frameRef]);
  const scrollable = overflow !== 'none';
  // The card and the scroller are two boxes: the fade mask on the card would
  // also erase its hairline ring, which is drawn outside the box.
  return (
    <div
      data-testid={testId}
      className={joinClasses(
        'min-w-0 overflow-hidden rounded-xl bg-base ring-[length:var(--border-hairline)] ring-line-base',
        fill && 'flex min-h-0 flex-1 flex-col',
        className,
      )}
    >
      <div
        ref={frameRef}
        data-overflow={scrollable ? overflow : undefined}
        {...(scrollable
          ? { role: 'region', 'aria-label': caption ?? 'Table', tabIndex: 0 }
          : {})}
        style={maxHeight === undefined ? undefined : { maxHeight }}
        className={joinClasses(
          'data-table-scroll focus-ring focus-ring-inset overflow-x-auto rounded-xl',
          (maxHeight !== undefined || fill) && 'overflow-y-auto',
          fill && 'min-h-0 flex-1',
        )}
      >
        <table
          aria-busy={busy === true ? true : undefined}
          style={minWidth === undefined ? undefined : { minWidth }}
          className={joinClasses(
            'w-full border-collapse text-s',
            layout === 'fixed' && 'table-fixed',
          )}
        >
          {caption === undefined ? null : (
            <caption className="sr-only">{caption}</caption>
          )}
          {children}
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Header

/** A spanning label rendered as a header row above the column labels. */
export interface DataTableColumnGroup {
  readonly label: string;
  /** Number of columns the group spans. */
  readonly span: number;
}

export interface DataTableHeadProps {
  /** An optional row of group labels above the column labels. */
  readonly groups?: ReadonlyArray<DataTableColumnGroup>;
  /**
   * Keeps the header in view while the card's own rows scroll. The frame is
   * a sideways scroller, so the header cannot pin to an outer scrolling
   * page; a long table bounds the card's height instead.
   */
  readonly sticky?: boolean;
  /** The column labels: {@link DataTableHeaderCell}s. */
  readonly children: ReactNode;
}

const HEAD_ROW_CLASS = 'h-8 bg-secondary text-xs font-medium fg-secondary';

/** The header band; an optional group row sits above the column labels. */
export function DataTableHead({
  groups,
  sticky = false,
  children,
}: DataTableHeadProps): JSX.Element {
  return (
    // Column labels are known before the rows: inside a `Skeleton` the band
    // draws as itself and only the values become bars.
    <thead
      {...SKELETON_KEEP}
      className={sticky ? 'sticky top-0 z-1' : undefined}
    >
      {groups !== undefined && groups.length > 0 ? (
        <tr className={`${HEAD_ROW_CLASS} border-b border-line-base`}>
          {groups.map((group, index) => (
            <th
              key={`${group.label}-${String(index)}`}
              scope="colgroup"
              colSpan={group.span}
              className="whitespace-nowrap px-3 text-left font-medium"
            >
              {group.label}
            </th>
          ))}
        </tr>
      ) : null}
      <tr className={HEAD_ROW_CLASS}>{children}</tr>
    </thead>
  );
}

export interface DataTableHeaderSort {
  /** The direction this column is sorted in, or `null` when it is not. */
  readonly direction: DataTableSortDirection | null;
  readonly onToggle: () => void;
  /** Lands on the sort button, the element automation clicks. */
  readonly testId?: string;
}

export interface DataTableHeaderCellProps {
  readonly align?: DataTableAlign;
  /** A CSS length; most useful with `layout="fixed"`. */
  readonly width?: string;
  /**
   * The narrowest the column may get, as a CSS length, so a column that
   * yields its width to the others (a truncating name) keeps a usable floor.
   */
  readonly minWidth?: string;
  readonly showFrom?: DataTableBreakpoint;
  /** Keeps the label for screen readers only, such as an actions column. */
  readonly labelHidden?: boolean;
  /** A note on what the column means, shown on hover. */
  readonly tooltip?: string;
  /** Makes the label a sort button. */
  readonly sort?: DataTableHeaderSort;
  readonly testId?: string;
  readonly children: ReactNode;
}

/**
 * One column label. A sortable label is a button whose arrow always holds
 * its slot (hidden until hover or focus while the column is inactive), so
 * sorting never shifts the header; `aria-sort` on the cell announces it.
 */
export function DataTableHeaderCell({
  align = 'left',
  width,
  minWidth,
  showFrom,
  labelHidden = false,
  tooltip,
  sort,
  testId,
  children,
}: DataTableHeaderCellProps): JSX.Element {
  const className = joinClasses(
    'whitespace-nowrap px-3 font-medium',
    TEXT_ALIGN_CLASS[align],
    showFrom !== undefined && SHOW_FROM_CLASS[showFrom],
  );
  const style =
    width === undefined && minWidth === undefined
      ? undefined
      : { width, minWidth };
  if (sort === undefined) {
    return (
      <th scope="col" data-testid={testId} style={style} className={className}>
        <Tooltip label={tooltip} disabled={!tooltip}>
          {labelHidden ? <span className="sr-only">{children}</span> : children}
        </Tooltip>
      </th>
    );
  }
  const { direction } = sort;
  let arrowClassName =
    'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100';
  if (direction === 'asc') {
    arrowClassName = 'fg-primary';
  } else if (direction === 'desc') {
    arrowClassName = 'rotate-180 fg-primary';
  }
  return (
    <th
      scope="col"
      aria-sort={direction === null ? 'none' : ARIA_SORT[direction]}
      data-testid={testId}
      style={style}
      className={className}
    >
      <Tooltip label={tooltip} disabled={!tooltip}>
        <button
          type="button"
          data-testid={sort.testId}
          data-sort-direction={direction ?? 'none'}
          onClick={sort.onToggle}
          className={joinClasses(
            'focus-ring group inline-flex items-center gap-1 rounded-sm font-medium hover:fg-primary',
            align === 'right' && 'flex-row-reverse',
            direction !== null && 'fg-primary',
          )}
        >
          {children}
          <ArrowUpIcon
            size="xs"
            aria-hidden="true"
            className={`shrink-0 ${arrowClassName}`}
          />
        </button>
      </Tooltip>
    </th>
  );
}

// -------------------------------------------------------------------- Body

export interface DataTableBodyProps {
  readonly testId?: string;
  /** How session replay records the rows; the header stays recorded. */
  readonly replay?: DataTableReplay;
  readonly children: ReactNode;
}

export function DataTableBody({
  testId,
  replay,
  children,
}: DataTableBodyProps): JSX.Element {
  return (
    <tbody
      data-testid={testId}
      className={replay === undefined ? undefined : REPLAY_CLASS[replay]}
    >
      {children}
    </tbody>
  );
}

/** Data attributes and ARIA state a row or cell may carry. */
export interface DataTableAttributes {
  readonly [key: `data-${string}`]: string | number | boolean | undefined;
  readonly 'aria-expanded'?: boolean;
  readonly 'aria-label'?: string;
  readonly title?: string;
}

export interface DataTableRowProps extends DataTableAttributes {
  /**
   * Makes the row a target: it takes the hover fill and focus, and a click or
   * Enter on the row (not on a control inside it) calls this.
   */
  readonly onActivate?: () => void;
  /** Also activate on Space when preserving a caller's existing row behavior. */
  readonly activateOnSpace?: boolean;
  /** The row the user is on: the selected fill and `aria-current`. */
  readonly selected?: boolean;
  /** Focusable from script without being a tab stop, such as a revealed row. */
  readonly focusable?: boolean;
  /** A record that is switched off: the whole row is dimmed. */
  readonly dimmed?: boolean;
  readonly verticalAlign?: DataTableVerticalAlign;
  readonly ref?: Ref<HTMLTableRowElement>;
  readonly children: ReactNode;
}

const ROW_CONTROL_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="combobox"]',
  '[contenteditable="true"]',
].join(', ');

/**
 * Whether an event target is an element. Realm-safe: a row rendered into an
 * auxiliary window gets that window's elements, which fail `instanceof
 * Element` from this one.
 */
function isDomElement(target: EventTarget | null): target is Element {
  return (
    target !== null &&
    'nodeType' in target &&
    target.nodeType === 1 &&
    'closest' in target
  );
}

/**
 * True when the event started on the row's own cells: not on a control inside
 * them, and not on a portaled menu whose events bubble through React.
 */
function isRowTarget(
  event: MouseEvent<HTMLTableRowElement> | KeyboardEvent<HTMLTableRowElement>,
): boolean {
  const { target, currentTarget } = event;
  if (!isDomElement(target) || !currentTarget.contains(target)) {
    return false;
  }
  const control = target.closest(ROW_CONTROL_SELECTOR);
  return control === null || !currentTarget.contains(control);
}

/** A 36px body row with a hairline above it. */
export function DataTableRow({
  onActivate,
  activateOnSpace = false,
  selected = false,
  focusable = false,
  dimmed = false,
  verticalAlign = 'middle',
  ref,
  children,
  ...attributes
}: DataTableRowProps): JSX.Element {
  const interactive = onActivate !== undefined;
  let tabIndex: number | undefined;
  if (interactive) tabIndex = 0;
  else if (focusable) tabIndex = -1;
  let fillClassName = '';
  if (selected) fillClassName = 'bg-muted';
  else if (interactive) fillClassName = 'hover:bg-subtle';
  return (
    <tr
      {...attributes}
      ref={ref}
      aria-current={selected ? 'true' : undefined}
      tabIndex={tabIndex}
      onClick={
        onActivate === undefined
          ? undefined
          : (event): void => {
              if (isRowTarget(event)) onActivate();
            }
      }
      onKeyDown={
        onActivate === undefined
          ? undefined
          : (event): void => {
              if (
                event.key !== 'Enter' &&
                !(activateOnSpace && event.key === ' ')
              ) {
                return;
              }
              if (event.target !== event.currentTarget) return;
              event.preventDefault();
              onActivate();
            }
      }
      className={joinClasses(
        'group h-9 border-t border-line-base',
        VERTICAL_ALIGN_CLASS[verticalAlign],
        interactive && 'focus-ring focus-ring-inset cursor-pointer',
        dimmed && 'opacity-55',
        fillClassName,
      )}
    >
      {children}
    </tr>
  );
}

export interface DataTableCellProps extends DataTableAttributes {
  /** `right` for numbers, which also take tabular figures. */
  readonly align?: DataTableAlign;
  readonly tone?: DataTableTone;
  readonly overflow?: DataTableOverflow;
  readonly showFrom?: DataTableBreakpoint;
  readonly colSpan?: number;
  readonly rowSpan?: number;
  /** Renders the cell as the row's `<th scope="row">`. */
  readonly rowHeader?: boolean;
  /** How session replay records a cell with private text. */
  readonly replay?: DataTableReplay;
  readonly children?: ReactNode;
}

/** One body cell: 12px side inset, one line unless it opts into wrapping. */
export function DataTableCell({
  align = 'left',
  tone = 'secondary',
  overflow = 'nowrap',
  showFrom,
  colSpan,
  rowSpan,
  rowHeader = false,
  replay,
  children,
  ...attributes
}: DataTableCellProps): JSX.Element {
  const className = joinClasses(
    'px-3 py-1 font-normal',
    TEXT_ALIGN_CLASS[align],
    align === 'right' && 'tabular-nums',
    TONE_CLASS[tone],
    OVERFLOW_CLASS[overflow],
    showFrom !== undefined && SHOW_FROM_CLASS[showFrom],
    replay !== undefined && REPLAY_CLASS[replay],
  );
  if (rowHeader) {
    // A header spanning several rows heads them all; `scope="row"` would
    // claim only the first, so the table's own header algorithm decides.
    return (
      <th
        {...attributes}
        scope={rowSpan !== undefined && rowSpan > 1 ? undefined : 'row'}
        colSpan={colSpan}
        rowSpan={rowSpan}
        className={className}
      >
        {children}
      </th>
    );
  }
  return (
    <td
      {...attributes}
      colSpan={colSpan}
      rowSpan={rowSpan}
      className={className}
    >
      {children}
    </td>
  );
}

/** One quiet line spanning the table when it has no rows. */
export function DataTableEmptyRow({
  colSpan,
  title,
  testId,
}: {
  readonly colSpan: number;
  /** One short sentence: `No runs yet`. */
  readonly title: ReactNode;
  readonly testId?: string;
}): JSX.Element {
  return (
    <tr className="border-t border-line-base">
      <td colSpan={colSpan} className="px-3">
        <EmptyStateRow title={title} testId={testId} />
      </td>
    </tr>
  );
}

export interface DataTableSkeletonColumn {
  readonly align?: DataTableAlign;
  readonly showFrom?: DataTableBreakpoint;
  /** The column label, which the sample values are drawn from. */
  readonly header?: string;
}

/** First-column samples, varied so the rows read as distinct records. */
const SKELETON_FIRST_COLUMN = [
  'Sample record',
  'Another sample record',
  'Sample',
] as const;

/** Right-aligned samples: numbers in tabular figures. */
const SKELETON_NUMBERS = ['1,240', '86', '312'] as const;

/**
 * A sample value for one cell, from the column model: a name in the first
 * column, a number in a right-aligned one, and the column's own label
 * elsewhere, so each bar is about as wide as that column's values.
 */
function skeletonCellText(
  column: DataTableSkeletonColumn,
  columnIndex: number,
  rowIndex: number,
): string {
  if (columnIndex === 0) {
    return SKELETON_FIRST_COLUMN[rowIndex % SKELETON_FIRST_COLUMN.length] ?? '';
  }
  if (column.align === 'right') {
    return SKELETON_NUMBERS[rowIndex % SKELETON_NUMBERS.length] ?? '';
  }
  return column.header === undefined || column.header === ''
    ? 'Sample'
    : column.header;
}

/**
 * Sample rows in the table's own columns while its rows load: real
 * {@link DataTableRow}s and {@link DataTableCell}s holding plain values from
 * the column model. Wrap the whole {@link DataTableFrame} in the measured
 * `Skeleton`, which draws a bar over each value and announces the load; the
 * header band stays as itself.
 */
export function DataTableSkeletonRows({
  columns,
  rows = 3,
  testId,
}: {
  /** One entry per column, in order. */
  readonly columns: ReadonlyArray<DataTableSkeletonColumn>;
  readonly rows?: number;
  readonly testId?: string;
}): JSX.Element {
  const rowIndexes = Array.from(
    { length: Math.max(1, Math.floor(rows)) },
    (_, index) => index,
  );
  return (
    <>
      {rowIndexes.map((rowIndex) => (
        <DataTableRow
          key={rowIndex}
          data-testid={rowIndex === 0 ? testId : undefined}
        >
          {columns.map((column, columnIndex) => (
            <DataTableCell
              key={columnIndex}
              align={column.align}
              tone={columnIndex === 0 ? 'primary' : 'secondary'}
              showFrom={column.showFrom}
            >
              {skeletonCellText(column, columnIndex, rowIndex)}
            </DataTableCell>
          ))}
        </DataTableRow>
      ))}
    </>
  );
}

// --------------------------------------------------------------- DataTable

export interface DataTableColumn<T> {
  /** Stable id: the React key, the sort key and the sort test id suffix. */
  readonly key: string;
  readonly header: string;
  /** Keeps the header for screen readers only, such as an actions column. */
  readonly headerHidden?: boolean;
  /** `right` for numbers, which also take tabular figures. */
  readonly align?: DataTableAlign;
  /**
   * Defaults to primary for the first column and secondary for the rest; a
   * function picks it per row (an `Installed` status in the success ink).
   */
  readonly tone?: DataTableTone | ((row: T) => DataTableTone);
  readonly overflow?: DataTableOverflow;
  /** A CSS length; most useful with `layout="fixed"`. */
  readonly width?: string;
  /** The narrowest the column may get, as a CSS length. */
  readonly minWidth?: string;
  readonly showFrom?: DataTableBreakpoint;
  /** Renders this column's cells as row headers (`<th scope="row">`). */
  readonly rowHeader?: boolean;
  /** A visible help icon beside the header, for a label that needs explaining. */
  readonly headerHint?: string;
  /** A note on what the column means, shown on hover over the header. */
  readonly tooltip?: string;
  /** How session replay records a column of private text. */
  readonly replay?: DataTableReplay;
  readonly render: (row: T, index: number) => ReactNode;
  /**
   * Makes the column sortable. Numbers compare numerically and strings with
   * `localeCompare`; `null` is a missing value, which always sorts last.
   */
  readonly sortValue?: (row: T) => number | string | null;
  /** Direction of the first sort on this column. Numbers default to `desc`. */
  readonly firstSortDirection?: DataTableSortDirection;
}

export interface DataTableProps<T> {
  readonly columns: ReadonlyArray<DataTableColumn<T>>;
  readonly rows: readonly T[];
  readonly rowKey: (row: T, index: number) => string;
  /** Screen-reader name of the table. */
  readonly caption?: string;
  /** The line shown in place of rows when there are none. */
  readonly emptyLabel?: ReactNode;
  /**
   * Shows the table in the measured skeleton: the header as itself, and
   * sample rows from the column model drawn as bars.
   */
  readonly loading?: boolean;
  /** How many sample rows to show while loading (default 3). */
  readonly loadingRows?: number;
  /** An optional header row of group labels above the column labels. */
  readonly columnGroups?: ReadonlyArray<DataTableColumnGroup>;
  /** Sort on first render. Without it or `sort`, rows keep the input order. */
  readonly defaultSort?: DataTableSort;
  /** The current sort, for a caller that owns it (`null`: unsorted). */
  readonly sort?: DataTableSort | null;
  readonly onSortChange?: (sort: DataTableSort) => void;
  /** Makes rows targets: a click or Enter on a row calls this. */
  readonly onRowActivate?: (row: T) => void;
  /** Rows that are not targets even though `onRowActivate` is set. */
  readonly isRowInert?: (row: T) => boolean;
  readonly selectedRowKey?: string | null;
  /** Data attributes and ARIA state for each row. */
  readonly rowAttributes?: (row: T, index: number) => DataTableAttributes;
  readonly verticalAlign?: DataTableVerticalAlign;
  readonly layout?: 'auto' | 'fixed';
  readonly minWidth?: string;
  readonly stickyHeader?: boolean;
  /**
   * Root test id. Derived ids: `-empty` on the empty line, `-loading` on the
   * loading status region and `-sort-<key>` on sort buttons. While loading,
   * the root id is kept aside on the sample table, so it marks loaded rows
   * only.
   */
  readonly testId?: string;
  /** Placement only: margin, width, visibility and flex participation. */
  readonly className?: string;
}

function compareSortValues(
  a: number | string | null,
  b: number | string | null,
  direction: number,
): number {
  // Missing values sort last in both directions, mirroring the `—` the cell
  // shows rather than floating to the top.
  if (a === null || b === null) {
    if (a === null && b === null) return 0;
    return a === null ? 1 : -1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return (a - b) * direction;
  }
  return String(a).localeCompare(String(b)) * direction;
}

function derivedTestId(
  testId: string | undefined,
  suffix: string,
): string | undefined {
  return testId === undefined ? undefined : `${testId}-${suffix}`;
}

/**
 * A table of records, one per row, in the shared framed-card look. A column
 * with `sortValue` is sortable once `defaultSort`, `sort` or `onSortChange`
 * is set.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  emptyLabel,
  loading = false,
  loadingRows,
  columnGroups,
  defaultSort,
  sort: controlledSort,
  onSortChange,
  onRowActivate,
  isRowInert,
  selectedRowKey,
  rowAttributes,
  verticalAlign,
  layout,
  minWidth,
  stickyHeader,
  testId,
  className,
}: DataTableProps<T>): JSX.Element {
  const [ownSort, setOwnSort] = useState<DataTableSort | null>(
    defaultSort ?? null,
  );
  const sortable =
    controlledSort !== undefined ||
    defaultSort !== undefined ||
    onSortChange !== undefined;
  const sort = controlledSort === undefined ? ownSort : controlledSort;

  const sortedRows = useMemo(() => {
    if (sort === null) return rows;
    const sortValue = columns.find(
      (column) => column.key === sort.key,
    )?.sortValue;
    if (sortValue === undefined) return rows;
    const direction = sort.direction === 'asc' ? 1 : -1;
    // A copy leaves the caller's array untouched; the sort is stable, so
    // ties keep their input order.
    return [...rows].sort((a, b) =>
      compareSortValues(sortValue(a), sortValue(b), direction),
    );
  }, [rows, columns, sort]);

  const toggleSort = (column: DataTableColumn<T>): void => {
    let next: DataTableSort;
    if (sort !== null && sort.key === column.key) {
      next = {
        key: column.key,
        direction: sort.direction === 'asc' ? 'desc' : 'asc',
      };
    } else {
      next = {
        key: column.key,
        direction:
          column.firstSortDirection ??
          (column.align === 'right' ? 'desc' : 'asc'),
      };
    }
    if (controlledSort === undefined) setOwnSort(next);
    onSortChange?.(next);
  };

  let body: ReactNode = null;
  if (loading) {
    body = <DataTableSkeletonRows columns={columns} rows={loadingRows} />;
  } else if (sortedRows.length === 0) {
    if (emptyLabel !== undefined) {
      body = (
        <DataTableEmptyRow
          colSpan={columns.length}
          title={emptyLabel}
          testId={derivedTestId(testId, 'empty')}
        />
      );
    }
  } else {
    body = sortedRows.map((row, index) => {
      const key = rowKey(row, index);
      const activate =
        onRowActivate === undefined || isRowInert?.(row) === true
          ? undefined
          : (): void => onRowActivate(row);
      return (
        <DataTableRow
          key={key}
          {...rowAttributes?.(row, index)}
          onActivate={activate}
          selected={selectedRowKey === key}
          verticalAlign={verticalAlign}
        >
          {columns.map((column, columnIndex) => (
            <DataTableCell
              key={column.key}
              align={column.align}
              tone={
                typeof column.tone === 'function'
                  ? column.tone(row)
                  : (column.tone ??
                    (columnIndex === 0 ? 'primary' : 'secondary'))
              }
              overflow={column.overflow}
              showFrom={column.showFrom}
              rowHeader={column.rowHeader}
              replay={column.replay}
            >
              {column.render(row, index)}
            </DataTableCell>
          ))}
        </DataTableRow>
      );
    });
  }

  const table = (
    <DataTableFrame
      caption={caption}
      layout={layout}
      minWidth={minWidth}
      busy={loading}
      testId={testId}
      className={loading ? undefined : className}
    >
      <DataTableHead groups={columnGroups} sticky={stickyHeader}>
        {columns.map((column) => (
          <DataTableHeaderCell
            key={column.key}
            align={column.align}
            width={column.width}
            minWidth={column.minWidth}
            showFrom={column.showFrom}
            labelHidden={column.headerHidden}
            tooltip={column.tooltip}
            sort={
              sortable && column.sortValue !== undefined
                ? {
                    direction: sort?.key === column.key ? sort.direction : null,
                    onToggle: (): void => toggleSort(column),
                    testId: derivedTestId(testId, `sort-${column.key}`),
                  }
                : undefined
            }
          >
            {column.headerHint ? (
              <span className="inline-flex items-center gap-1">
                {column.header}
                <Tooltip label={column.headerHint}>
                  <span
                    tabIndex={0}
                    aria-label={column.headerHint}
                    role="img"
                    data-testid={derivedTestId(testId, `hint-${column.key}`)}
                    className="focus-ring inline-flex rounded-sm fg-tertiary"
                  >
                    <IconCircleQuestionmark size={12} />
                  </span>
                </Tooltip>
              </span>
            ) : (
              column.header
            )}
          </DataTableHeaderCell>
        ))}
      </DataTableHead>
      <DataTableBody>{body}</DataTableBody>
    </DataTableFrame>
  );
  if (!loading) return table;
  // The real table with sample rows, measured: the bars sit where the
  // values will, and the rows replace them in place.
  return (
    <Skeleton
      loading
      label="Loading"
      testId={derivedTestId(testId, 'loading')}
      className={className}
    >
      {table}
    </Skeleton>
  );
}
