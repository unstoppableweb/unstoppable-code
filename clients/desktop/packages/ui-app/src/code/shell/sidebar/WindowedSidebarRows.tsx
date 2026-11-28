import {
  defaultRangeExtractor,
  measureElement,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from '@tanstack/react-virtual';
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { useScrollMargin } from '../../use-scroll-margin';
import { SidebarList, type SidebarListRowGap } from './SidebarList';

/**
 * A list with more rows than this renders only the rows near the viewport
 * (CAN-8060). Every rendered row costs the window style, layout and paint
 * work on each frame whether or not it is on screen: a paired computer with
 * 200 tasks stalled the window for 100 to 200 ms while a local chat
 * streamed. Shorter lists render every row, as they always did.
 */
export const WINDOWED_SIDEBAR_ROWS_MIN = 30;

/**
 * A row's height before any is measured. The first measured row's height
 * then stands in for every unmeasured one, so the list's height, and a
 * scroll position restored into it, match rows of any density.
 */
const ESTIMATED_ROW_HEIGHT_PX = 32;
/** The last row height any windowed list measured, for the next one. */
let lastRowHeight: number | null = null;
const OVERSCAN_ROWS = 10;
const ROW_GAP_PX: Record<SidebarListRowGap, number> = {
  none: 0,
  hairline: 1,
  thin: 2,
};

/** A row's place in the whole list, for assistive technology. */
export interface SidebarRowListPosition {
  readonly setSize: number;
  readonly posInSet: number;
}

export interface SidebarRowsListProps {
  /** One stable key per row, in order. */
  readonly rowKeys: readonly string[];
  /** A windowed list passes each row's place in the whole list. */
  readonly renderRow: (
    index: number,
    position?: SidebarRowListPosition,
  ) => ReactNode;
  /** Render only the rows near the viewport. */
  readonly windowed: boolean;
  /**
   * Rows a windowed list renders wherever it is scrolled: the selected row,
   * and a row waiting to be revealed, which then scrolls itself into view.
   */
  readonly keepRenderedKeys: readonly string[];
  readonly rowGap: SidebarListRowGap;
  readonly className?: string;
}

function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
  const view = element.ownerDocument.defaultView;
  if (view === null) return null;
  for (
    let ancestor = element.parentElement;
    ancestor !== null;
    ancestor = ancestor.parentElement
  ) {
    const overflowY = view.getComputedStyle(ancestor).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return ancestor;
  }
  return null;
}

/** The list's own child holding `element`, and that child's row index. */
function rowIndexOf(list: HTMLElement, element: EventTarget): number {
  let child = element instanceof Node ? element : null;
  while (child !== null && child.parentNode !== list) child = child.parentNode;
  if (!(child instanceof HTMLElement)) return -1;
  const windowedIndex = child.dataset['index'];
  return windowedIndex === undefined
    ? Array.prototype.indexOf.call(list.children, child)
    : Number(windowedIndex);
}

/** What a row's keyboard focus can sit on besides the row itself. */
const ROW_CONTROLS =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** The focused row, and which of its controls had focus (-1: the row). */
interface FocusedRow {
  readonly key: string;
  readonly control: number;
}

/** The focusable row at `index`, if it is rendered. */
function renderedRow(list: HTMLElement, index: number): HTMLElement | null {
  const child =
    list.querySelector(`:scope > [data-index="${index}"]`)?.firstElementChild ??
    list.children[index];
  return child instanceof HTMLElement ? child : null;
}

/**
 * A sidebar list's rows: all of them, or above the threshold only those near
 * the viewport. The focused row is remembered, so a row that moves between
 * the two (the list crossing the threshold remounts it) gets its focus back.
 */
export function SidebarRowsList({
  rowKeys,
  renderRow,
  windowed,
  keepRenderedKeys,
  rowGap,
  className,
}: SidebarRowsListProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<FocusedRow | null>(null);
  const handleFocus = (event: FocusEvent<HTMLDivElement>): void => {
    const index = rowIndexOf(event.currentTarget, event.target);
    const key = rowKeys[index];
    if (key === undefined) return;
    const row = renderedRow(event.currentTarget, index);
    const control =
      row === null || event.target === row
        ? -1
        : [...row.querySelectorAll(ROW_CONTROLS)].indexOf(event.target);
    setFocused((previous) =>
      previous?.key === key && previous.control === control
        ? previous
        : { key, control },
    );
  };
  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const { target, currentTarget: list } = event;
    // Decided once the change that blurred it is done. A row remounted while
    // focused (the list crossing the threshold) leaves focus nowhere; its key
    // stays, so the row gets focus back where it renders again.
    queueMicrotask(() => {
      if (!target.isConnected) return;
      if (!list.contains(list.ownerDocument.activeElement)) setFocused(null);
    });
  };
  // A row that leaves the list takes its remembered focus with it, so it
  // never takes focus when it comes back.
  useLayoutEffect(() => {
    if (focused !== null && !rowKeys.includes(focused.key)) setFocused(null);
  });
  // Set when the list switches between windowed and plain, which remounts
  // its rows, and only if the list held focus then; the focus is given back
  // once, where its row renders.
  const restorePendingRef = useRef(false);
  const windowedRef = useRef(windowed);
  useLayoutEffect(() => {
    if (windowedRef.current === windowed) return;
    windowedRef.current = windowed;
    restorePendingRef.current = focused !== null;
  }, [windowed, focused]);
  const restoreFocus = useCallback(
    (rowsRendered: boolean): void => {
      if (!restorePendingRef.current || !rowsRendered) return;
      restorePendingRef.current = false;
      const list = listRef.current;
      const document = list?.ownerDocument;
      if (list === null || focused === null || document === undefined) return;
      if (
        document.activeElement !== null &&
        document.activeElement !== document.body
      )
        return;
      const row = renderedRow(list, rowKeys.indexOf(focused.key));
      if (row === null) return;
      const control =
        focused.control < 0
          ? null
          : row.querySelectorAll(ROW_CONTROLS)[focused.control];
      (control instanceof HTMLElement ? control : row).focus({
        preventScroll: true,
      });
    },
    [focused, rowKeys],
  );
  useLayoutEffect(() => {
    if (!windowed) restoreFocus(true);
  });
  // A plain list's row height seeds a windowed list's estimate, so the list
  // that replaces it at the threshold is not shorter for a frame, which
  // would let the browser pull the sidebar's scroll position up.
  useLayoutEffect(() => {
    const list = listRef.current;
    const view = list?.ownerDocument.defaultView;
    if (windowed || list === null || !view?.ResizeObserver) return undefined;
    const observer = new view.ResizeObserver(([entry]) => {
      const rows = list.children.length;
      if (entry === undefined || rows === 0) return;
      const height =
        (entry.contentRect.height - (rows - 1) * ROW_GAP_PX[rowGap]) / rows;
      if (height > 0) lastRowHeight = height;
    });
    observer.observe(list);
    return (): void => {
      observer.disconnect();
    };
  }, [windowed, rowGap]);

  if (!windowed) {
    return (
      <SidebarList
        ref={listRef}
        className={className}
        rowGap={rowGap}
        onFocus={handleFocus}
        onBlur={handleBlur}
      >
        {rowKeys.map((_, index) => renderRow(index))}
      </SidebarList>
    );
  }
  return (
    <WindowedRows
      listRef={listRef}
      rowKeys={rowKeys}
      renderRow={renderRow}
      keepRenderedKeys={keepRenderedKeys}
      focusedKey={focused?.key ?? null}
      rowGap={rowGap}
      className={className}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onRowsRendered={restoreFocus}
    />
  );
}

interface WindowedRowsProps {
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly rowKeys: readonly string[];
  readonly renderRow: SidebarRowsListProps['renderRow'];
  readonly keepRenderedKeys: readonly string[];
  readonly focusedKey: string | null;
  readonly rowGap: SidebarListRowGap;
  readonly className: string | undefined;
  readonly onFocus: (event: FocusEvent<HTMLDivElement>) => void;
  readonly onBlur: (event: FocusEvent<HTMLDivElement>) => void;
  readonly onRowsRendered: (rowsRendered: boolean) => void;
}

/**
 * Renders the rows near the sidebar scroller's viewport, plus the first and
 * last rows, the focused row and its neighbours, and `keepRenderedKeys`, so
 * Tab and Shift+Tab walk every row and can enter the list from either end.
 * Without a scrollable ancestor it renders every row.
 */
function WindowedRows({
  listRef,
  rowKeys,
  renderRow,
  keepRenderedKeys,
  focusedKey,
  rowGap,
  className,
  onFocus,
  onBlur,
  onRowsRendered,
}: WindowedRowsProps): JSX.Element {
  // `undefined` until the first layout pass has looked for the scroller.
  const [scrollElement, setScrollElement] = useState<
    HTMLElement | null | undefined
  >(undefined);
  useLayoutEffect(() => {
    const list = listRef.current;
    setScrollElement(list === null ? null : findScrollableAncestor(list));
  }, [listRef]);
  const scrollMargin = useScrollMargin(listRef, scrollElement ?? null);
  const count = rowKeys.length;
  const focusedIndex = focusedKey === null ? -1 : rowKeys.indexOf(focusedKey);
  const keptIndexes = keepRenderedKeys
    .map((key) => rowKeys.indexOf(key))
    .filter((index) => index >= 0)
    .join(',');
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = new Set(defaultRangeExtractor(range));
      indexes.add(0);
      indexes.add(range.count - 1);
      if (focusedIndex >= 0) {
        indexes.add(focusedIndex - 1);
        indexes.add(focusedIndex);
        indexes.add(focusedIndex + 1);
      }
      for (const kept of keptIndexes === '' ? [] : keptIndexes.split(',')) {
        indexes.add(Number(kept));
      }
      return [...indexes]
        .filter((index) => index >= 0 && index < range.count)
        .sort((a, b) => a - b);
    },
    [focusedIndex, keptIndexes],
  );
  const getItemKey = useCallback(
    (index: number): string => rowKeys[index] ?? String(index),
    [rowKeys],
  );
  const [rowHeight, setRowHeight] = useState<number | null>(lastRowHeight);
  const measureRow = useCallback(
    (
      element: Element,
      entry: ResizeObserverEntry | undefined,
      instance: Virtualizer<HTMLElement, Element>,
    ): number => {
      const size = measureElement(element, entry, instance);
      if (size > 0) {
        lastRowHeight = size;
        setRowHeight((previous) => previous ?? size);
      }
      return size;
    },
    [],
  );
  const virtualizer = useVirtualizer({
    count,
    // Started only once the scroller is known, from where it is scrolled:
    // a list that starts windowing must not move the sidebar.
    enabled: scrollElement instanceof HTMLElement,
    initialOffset: (): number => scrollElement?.scrollTop ?? 0,
    getScrollElement: (): HTMLElement | null => scrollElement ?? null,
    estimateSize: (): number => rowHeight ?? ESTIMATED_ROW_HEIGHT_PX,
    measureElement: measureRow,
    getItemKey,
    overscan: OVERSCAN_ROWS,
    gap: ROW_GAP_PX[rowGap],
    scrollMargin,
    rangeExtractor,
  });
  // Re-lays out the unmeasured rows at the measured height.
  useLayoutEffect(() => {
    if (rowHeight !== null) virtualizer.measure();
  }, [rowHeight, virtualizer]);
  const items = virtualizer.getVirtualItems();
  // Rows render once the scroller is known and the virtualizer has attached
  // to it, a commit later; without a scroller, every row renders at once.
  const rowsRendered =
    scrollElement === null || (scrollElement !== undefined && items.length > 0);
  useLayoutEffect(() => {
    onRowsRendered(rowsRendered);
  });

  if (scrollElement === null) {
    return (
      <SidebarList
        ref={listRef}
        className={className}
        rowGap={rowGap}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {rowKeys.map((_, index) =>
          renderRow(index, { setSize: count, posInSet: index + 1 }),
        )}
      </SidebarList>
    );
  }
  return (
    <SidebarList
      ref={listRef}
      className={className === undefined ? 'relative' : `${className} relative`}
      style={{
        // Until the scroller is known, the rows' estimated height, so the
        // sidebar's scroll position has room to stay where it is.
        height:
          scrollElement === undefined
            ? count * (rowHeight ?? ESTIMATED_ROW_HEIGHT_PX) +
              Math.max(0, count - 1) * ROW_GAP_PX[rowGap]
            : virtualizer.getTotalSize(),
      }}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {scrollElement === undefined
        ? null
        : items.map((item) => (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              // `top`, not a transform: the desktop rail finds the selected
              // row by its offsetTop, which a transform would not move.
              className="absolute inset-x-0"
              style={{ top: item.start - scrollMargin }}
            >
              {renderRow(item.index, {
                setSize: count,
                posInSet: item.index + 1,
              })}
            </div>
          ))}
    </SidebarList>
  );
}
