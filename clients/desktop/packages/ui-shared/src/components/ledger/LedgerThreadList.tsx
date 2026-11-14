'use client';

import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  LedgerActorLabel,
  LedgerEntrySearchItem,
  LedgerFileRef,
} from '@canopy/protocol/canopy-core';
import {
  groupLedgerThreads,
  type LedgerThread,
} from '../../lib/ledger-threads';
import { Button } from '../Button';
import { LoadingSpinner } from '../LoadingSpinner';
import { ErrorBanner } from '../StatusBlocks';
import { LedgerEntryThread } from './LedgerEntryThread';
import type { LedgerEntryPostContext } from './LedgerEntryPost';
import type { LedgerEntryRowDetails } from './ledger-entry-attribution';
import type {
  LedgerDensity,
  LedgerEntrySlots,
  LedgerOpenEntry,
} from './ledger-entry-slots';

/** Above this many threads, a list with a scroll element windows its rows. */
export const LEDGER_THREAD_LIST_VIRTUALIZED_THRESHOLD = 120;
const ESTIMATED_THREAD_HEIGHT_PX = 160;

function estimateThreadHeight(): number {
  return ESTIMATED_THREAD_HEIGHT_PX;
}

/** Inputs for a list of entry threads. */
export interface LedgerThreadListProps {
  readonly entries: readonly LedgerEntrySearchItem[];
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly density: LedgerDensity;
  readonly now: Date;
  readonly timeField?: 'createdAt' | 'updatedAt';
  /**
   * Names the list read the entries come from. While it stays the same, the
   * threads already shown keep their places as the entries change in place;
   * a new value, for a list read afresh, places every thread by its newest
   * entry again. Omitted, every change places threads afresh.
   */
  readonly placementKey?: string | number;
  /** The open entry; null when none is. */
  readonly openEntry: LedgerOpenEntry | null;
  readonly onToggleOpen: (entryId: string | null) => void;
  readonly onOpenFile: (
    entry: LedgerEntrySearchItem,
    file: LedgerFileRef,
  ) => void;
  readonly onShowEntry?: (entryId: string) => void;
  readonly rowDetails?: (entry: LedgerEntrySearchItem) => LedgerEntryRowDetails;
  readonly entrySlots?: (
    entry: LedgerEntrySearchItem,
  ) => LedgerEntrySlots | undefined;
  /**
   * Correction boxes to show under threads, keyed by each thread's root entryId.
   * Several can be open at once, across threads and within one thread.
   */
  readonly corrections?: ReadonlyMap<string, ReactNode>;
  /** An entry shown above the list, such as a selected one that is not loaded. */
  readonly pinnedEntry?: LedgerEntrySearchItem | null;
  /** The composer row above everything (LedgerComposerPrompt or the open form). */
  readonly composer?: ReactNode;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMoreError: string | null;
  readonly onLoadMore: () => void;
  readonly loadMoreTestId?: string;
  /** Given one, a long list renders only the threads near the view. */
  readonly scrollElement?: () => HTMLElement | null;
}

/**
 * Whether the open entry is this thread's root or one of its corrections.
 * Only that thread receives it, so a change to the open entry's state
 * renders that thread alone.
 */
function threadOwnsEntry(
  thread: LedgerThread<LedgerEntrySearchItem>,
  openEntry: LedgerOpenEntry | null,
): boolean {
  if (openEntry === null) return false;
  return (
    thread.root.entryId === openEntry.entryId ||
    thread.corrections.some(
      (correction) => correction.entryId === openEntry.entryId,
    )
  );
}

type ThreadRenderer = (
  thread: LedgerThread<LedgerEntrySearchItem>,
) => JSX.Element;

/**
 * How far the windowed threads start below the top of the scroll element's
 * content, such as below the composer and a pinned entry. It is measured
 * again whenever the content above them changes size.
 */
function useScrollMargin(
  windowRef: { readonly current: HTMLElement | null },
  scrollElement: () => HTMLElement | null,
): number {
  const [scrollMargin, setScrollMargin] = useState(0);
  const measure = useCallback((): void => {
    const scroller = scrollElement();
    const element = windowRef.current;
    if (scroller === null || element === null) return;
    const margin = Math.round(
      element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop,
    );
    setScrollMargin((previous) => (previous === margin ? previous : margin));
  }, [scrollElement, windowRef]);
  // After every render, for content added above; equal values don't rerender.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const scroller = scrollElement();
    if (scroller === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    for (const child of Array.from(scroller.children)) observer.observe(child);
    return (): void => observer.disconnect();
  }, [measure, scrollElement]);
  return scrollMargin;
}

function VirtualizedThreads({
  threads,
  scrollElement,
  renderThread,
  openEntry,
}: {
  readonly threads: readonly LedgerThread<LedgerEntrySearchItem>[];
  readonly scrollElement: () => HTMLElement | null;
  readonly renderThread: ThreadRenderer;
  readonly openEntry: LedgerOpenEntry | null;
}): JSX.Element {
  const windowRef = useRef<HTMLDivElement>(null);
  const getItemKey = useCallback(
    (index: number): string => threads[index]?.root.entryId ?? String(index),
    [threads],
  );
  const scrollMargin = useScrollMargin(windowRef, scrollElement);
  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: scrollElement,
    getItemKey,
    estimateSize: estimateThreadHeight,
    overscan: 12,
    scrollMargin,
  });
  const measure = useCallback(
    (element: HTMLDivElement | null): void => {
      virtualizer.measureElement(element);
    },
    [virtualizer],
  );
  // An entry opened from elsewhere (Open entry) may sit outside the window,
  // where no row renders: scroll to it once, so its row exists to show. An
  // entry opened on screen keeps the list where it is.
  const revealedEntryId = useRef<string | null>(null);
  useLayoutEffect(() => {
    const entryId = openEntry?.entryId ?? null;
    if (entryId === revealedEntryId.current) return;
    const index = threads.findIndex((thread) =>
      threadOwnsEntry(thread, openEntry),
    );
    if (entryId !== null && index < 0) return;
    revealedEntryId.current = entryId;
    if (
      index < 0 ||
      virtualizer.getVirtualItems().some((item) => item.index === index)
    ) {
      return;
    }
    virtualizer.scrollToIndex(index, { align: 'start' });
  }, [openEntry, threads, virtualizer]);
  // Item positions include the scroll margin; the total size does not.
  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0];
  const paddingTop = first === undefined ? 0 : first.start - scrollMargin;
  const last = virtualItems[virtualItems.length - 1];
  const paddingBottom =
    last === undefined
      ? 0
      : virtualizer.getTotalSize() - (last.end - scrollMargin);

  return (
    <div
      ref={windowRef}
      data-testid="ledger-thread-window"
      className="flex flex-col"
    >
      {paddingTop > 0 && (
        <div aria-hidden="true" style={{ height: paddingTop }} />
      )}
      {virtualItems.map((virtualItem) => {
        const thread = threads[virtualItem.index];
        if (thread === undefined) return null;
        const isLast = virtualItem.index === threads.length - 1;
        return (
          <div
            key={thread.root.entryId}
            data-index={virtualItem.index}
            ref={measure}
            className={isLast ? undefined : 'border-b border-line-base'}
          >
            {renderThread(thread)}
          </div>
        );
      })}
      {paddingBottom > 0 && (
        <div aria-hidden="true" style={{ height: paddingBottom }} />
      )}
    </div>
  );
}

interface LedgerThreadPlacement {
  readonly placementKey: string | number | undefined;
  readonly entries: readonly LedgerEntrySearchItem[];
  readonly threads: readonly LedgerThread<LedgerEntrySearchItem>[];
}

/**
 * The threads in display order, regrouped only when the entries or the
 * placement key change. It keeps the order it last rendered, the way React
 * stores information from previous renders, so rendering stays pure.
 */
function useLedgerThreadPlacement(
  entries: readonly LedgerEntrySearchItem[],
  placementKey: string | number | undefined,
): readonly LedgerThread<LedgerEntrySearchItem>[] {
  const [placement, setPlacement] = useState<LedgerThreadPlacement>(() => ({
    placementKey,
    entries,
    threads: groupLedgerThreads(entries),
  }));
  if (
    placement.entries === entries &&
    placement.placementKey === placementKey
  ) {
    return placement.threads;
  }
  const previousOrder =
    placementKey !== undefined && placement.placementKey === placementKey
      ? placement.threads.map((thread) => thread.root.entryId)
      : undefined;
  const threads = groupLedgerThreads(entries, previousOrder);
  setPlacement({ placementKey, entries, threads });
  return threads;
}

/** Loads the next entries, or says why the last attempt failed. */
function LoadMoreFooter({
  loadingMore,
  loadMoreError,
  onLoadMore,
  loadMoreTestId,
}: {
  readonly loadingMore: boolean;
  readonly loadMoreError: string | null;
  readonly onLoadMore: () => void;
  readonly loadMoreTestId: string;
}): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-1 px-2 pb-2">
      <ErrorBanner
        errorSource="load-more-footer"
        className="self-stretch"
        error={loadMoreError}
      />
      {loadingMore ? (
        <span className="flex items-center gap-2 py-1.5 text-xs fg-secondary">
          <LoadingSpinner tone="secondary" decorative />
          Loading more entries…
        </span>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={loadMoreTestId}
          onClick={onLoadMore}
        >
          {loadMoreError === null ? 'Show more entries' : 'Try again'}
        </Button>
      )}
    </div>
  );
}

/** All entry threads in one column, with one open row and optional windowing. */
export const LedgerThreadList = memo(function LedgerThreadList({
  entries,
  actors,
  density,
  now,
  timeField = 'createdAt',
  placementKey,
  openEntry,
  onToggleOpen,
  onOpenFile,
  onShowEntry,
  rowDetails,
  entrySlots,
  corrections,
  pinnedEntry,
  composer,
  hasMore,
  loadingMore,
  loadMoreError,
  onLoadMore,
  loadMoreTestId = 'ledger-load-more',
  scrollElement,
}: LedgerThreadListProps): JSX.Element {
  const context = useMemo<LedgerEntryPostContext>(
    () => ({
      actors,
      density,
      now,
      timeField,
      onOpenFile,
      onToggleOpen,
      ...(onShowEntry === undefined ? {} : { onShowEntry }),
    }),
    [actors, density, now, timeField, onOpenFile, onToggleOpen, onShowEntry],
  );
  const threads = useLedgerThreadPlacement(entries, placementKey);
  const pinnedThread =
    useMemo<LedgerThread<LedgerEntrySearchItem> | null>(() => {
      if (
        pinnedEntry === undefined ||
        pinnedEntry === null ||
        entries.some((entry) => entry.entryId === pinnedEntry.entryId)
      ) {
        return null;
      }
      return {
        root: pinnedEntry,
        corrections: [],
        orphan: pinnedEntry.supersedesEntryId !== undefined,
      };
    }, [entries, pinnedEntry]);
  const makeThread = useCallback(
    (
      thread: LedgerThread<LedgerEntrySearchItem>,
      pinned?: boolean,
    ): JSX.Element => (
      <LedgerEntryThread
        key={thread.root.entryId}
        thread={thread}
        context={context}
        rowDetails={rowDetails}
        entrySlots={entrySlots}
        openEntry={threadOwnsEntry(thread, openEntry) ? openEntry : null}
        correctionBox={corrections?.get(thread.root.entryId)}
        pinned={pinned}
      />
    ),
    [context, rowDetails, entrySlots, openEntry, corrections],
  );
  const windowedIn =
    threads.length > LEDGER_THREAD_LIST_VIRTUALIZED_THRESHOLD
      ? scrollElement
      : undefined;

  return (
    <div
      data-testid="ledger-entry-list"
      data-entry-count={entries.length}
      data-virtualized={windowedIn === undefined ? undefined : 'true'}
      className="flex flex-col"
    >
      {composer}
      {pinnedThread !== null && (
        <div className="border-b border-line-base">
          {makeThread(pinnedThread, true)}
        </div>
      )}
      {windowedIn === undefined ? (
        <div className="flex flex-col">
          {threads.map((thread, index) => (
            <div
              key={thread.root.entryId}
              className={
                index < threads.length - 1
                  ? 'border-b border-line-base'
                  : undefined
              }
            >
              {makeThread(thread)}
            </div>
          ))}
        </div>
      ) : (
        <VirtualizedThreads
          threads={threads}
          scrollElement={windowedIn}
          renderThread={makeThread}
          openEntry={openEntry}
        />
      )}
      {(hasMore || loadMoreError !== null) && (
        <LoadMoreFooter
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
          onLoadMore={onLoadMore}
          loadMoreTestId={loadMoreTestId}
        />
      )}
    </div>
  );
});
