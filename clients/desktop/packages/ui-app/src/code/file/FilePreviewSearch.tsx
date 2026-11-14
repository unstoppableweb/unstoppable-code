'use client';

import {
  createContext,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { SearchBar } from '@canopy/ui-shared/components/SearchBar';
import { PaneSheet } from '@canopy/ui-shared/components/Sheet';
import { createDomSearchExecutor } from '@canopy/ui-shared/lib/dom-search-highlight';

interface PreviewSearchContextValue {
  query: string;
  index: number;
  report: (query: string, count: number) => void;
  open: () => void;
  close: () => void;
}
export const PreviewSearchContext =
  createContext<PreviewSearchContextValue | null>(null);

/**
 * `inline` (default) renders the find drawer and owns Cmd/Ctrl+F. `headless`
 * renders no drawer and ignores the shortcut: the host drives the search
 * through `controlled` from its own find UI (desktop's floating find bar).
 */
export type PreviewSearchPresentation = 'inline' | 'headless';

/** Host-owned search state for the `headless` presentation. */
export interface PreviewSearchControlled {
  open: boolean;
  query: string;
  /** Active match; the host wraps it modulo the reported `totalCount`. */
  index: number;
}

interface FilePreviewSearchProps {
  enabled: boolean;
  remote: boolean;
  searchShortcutActive: boolean;
  header: ReactNode;
  children: ReactNode;
  /** Reset search on a view change without remounting the header controls. */
  resetKey?: string;
  control?: { operation: 'open' | 'close'; revision: number };
  onControlApplied?: (revision: number) => void;
  onStateChange?: (state: PreviewSearchState) => void;
  presentation?: PreviewSearchPresentation;
  controlled?: PreviewSearchControlled;
  /** Headless only: the HTML preview asked to open or close the search. */
  onSearchRequest?: (operation: 'open' | 'close') => void;
  /** A key pressed anywhere inside the viewer (its Save shortcut). */
  onViewerKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export interface PreviewSearchState {
  enabled: boolean;
  open: boolean;
  queryPresent: boolean;
  currentIndex: number;
  totalCount: number;
}

const PREVIEW_SCROLL_SELECTOR = [
  '[data-testid="file-viewer-markdown-scroll"]',
  '[data-testid="file-viewer-csv-table-scroll"]',
  '[data-testid="file-viewer-csv-raw-scroll"]',
  '[data-testid="file-viewer-raw-text-scroll"]',
  '[data-testid="file-viewer-image-scroll"]',
  '[data-testid="file-notebook-preview"]',
].join(', ');

export function resolvePreviewScrollContainer(
  container: HTMLElement | null,
): HTMLElement | null {
  if (!container) return null;
  const scroller = container.querySelector(PREVIEW_SCROLL_SELECTOR);
  if (scroller instanceof HTMLElement) return scroller;
  const child = container.firstElementChild;
  return child instanceof HTMLElement ? child : container;
}

export function FilePreviewSearch({
  enabled,
  remote,
  searchShortcutActive,
  header,
  children,
  resetKey,
  control,
  onControlApplied,
  onStateChange,
  presentation = 'inline',
  controlled,
  onSearchRequest,
  onViewerKeyDown,
}: FilePreviewSearchProps): JSX.Element {
  const headless = presentation === 'headless';
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [openedState, setOpened] = useState(false);
  const [queryState, setQuery] = useState('');
  const [counted, setCounted] = useState({ query: '', total: 0 });
  const [indexState, setIndex] = useState(0);
  const opened = headless ? controlled?.open === true : openedState;
  const query = headless
    ? controlled?.open === true
      ? controlled.query
      : ''
    : queryState;
  // A count belongs to the query it was scanned for: until the debounced scan
  // of a new query lands there are no matches, so a host stepping in that
  // window shows the new query's first match instead of skipping past it.
  const count = counted.query === query ? counted.total : 0;
  const controlledIndex = controlled?.index ?? 0;
  // The host's index can outlive a shrinking match count; clamp it like
  // `report` clamps the inline index.
  const index = headless
    ? count > 0 && controlledIndex >= count
      ? 0
      : controlledIndex
    : indexState;
  const [revision, setRevision] = useState(0);
  const indexRef = useRef(index);
  indexRef.current = index;
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const names = useMemo(
    () => ({
      matches: `preview-matches-${id}`,
      active: `preview-active-${id}`,
      visibleOnly: true,
    }),
    [id],
  );
  const executor = useMemo(
    () =>
      createDomSearchExecutor(
        () => contentRef.current,
        () => resolvePreviewScrollContainer(contentRef.current),
        names,
      ),
    [names],
  );
  const previousResetKey = useRef(resetKey);
  useLayoutEffect(() => {
    if (previousResetKey.current === resetKey) return;
    previousResetKey.current = resetKey;
    setOpened(false);
    setQuery('');
    setCounted({ query: '', total: 0 });
    setIndex(0);
    executor.clearHighlights();
  }, [executor, resetKey]);

  const open = useCallback((): void => {
    if (headless) {
      onSearchRequest?.('open');
      return;
    }
    setOpened(true);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [headless, onSearchRequest]);
  const close = useCallback((): void => {
    if (headless) {
      onSearchRequest?.('close');
      return;
    }
    setOpened(false);
    setQuery('');
    setCounted({ query: '', total: 0 });
    setIndex(0);
    executor.clearHighlights();
    rootRef.current?.focus({ preventScroll: true });
  }, [executor, headless, onSearchRequest]);
  const report = useCallback(
    (searched: string, total: number): void => {
      if (searched !== query) return;
      setCounted({ query: searched, total });
      setIndex((previous) => (previous < total ? previous : 0));
    },
    [query],
  );
  useEffect(() => {
    if (!control || headless) return;
    if (control.operation === 'open') open();
    else close();
    onControlApplied?.(control.revision);
  }, [close, control, headless, onControlApplied, open]);
  useEffect(() => {
    onStateChange?.({
      enabled,
      open: opened,
      queryPresent: query.length > 0,
      currentIndex: index,
      totalCount: count,
    });
  }, [count, enabled, index, onStateChange, opened, query]);

  useEffect(() => {
    if (remote) return;
    const timer = window.setTimeout(() => {
      const total =
        opened && query.length >= 2 ? executor.findMatches(query) : 0;
      report(query, total);
      if (total > 0) {
        const active = indexRef.current < total ? indexRef.current : 0;
        executor.setActiveMatch(active);
        executor.scrollToMatch(active);
      }
      if (!opened || query.length < 2) executor.clearHighlights();
    }, 150);
    return (): void => window.clearTimeout(timer);
  }, [executor, opened, query, remote, report, resetKey, revision]);
  useEffect(() => {
    if (remote || count === 0) return;
    executor.setActiveMatch(index);
    executor.scrollToMatch(index);
  }, [count, executor, index, query, remote, revision]);
  useEffect(() => (): void => executor.clearHighlights(), [executor]);
  useEffect(() => {
    if (!opened || remote || !contentRef.current) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRevision((value) => value + 1));
    });
    observer.observe(contentRef.current, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return (): void => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [opened, remote]);

  // The host identifies the focused file panel even when its tab/header owns
  // focus. Descendant shortcuts still work without a host (e.g. web previews).
  useEffect(() => {
    if (!enabled || !searchShortcutActive || headless) return;
    const doc = rootRef.current?.ownerDocument;
    if (!doc) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !doc.hasFocus()) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault();
        event.stopPropagation();
        open();
      } else if (opened && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    doc.addEventListener('keydown', onKeyDown);
    return (): void => doc.removeEventListener('keydown', onKeyDown);
  }, [enabled, searchShortcutActive, headless, open, opened, close]);

  const context = useMemo(
    () =>
      enabled
        ? { query: opened ? query : '', index, report, open, close }
        : null,
    [enabled, opened, query, index, report, open, close],
  );
  return (
    <PreviewSearchContext.Provider value={context}>
      <div
        ref={rootRef}
        tabIndex={-1}
        className="flex h-full min-h-0 flex-col outline-none"
        data-testid="file-viewer"
        onKeyDown={onViewerKeyDown}
        onPointerDownCapture={(event): void => {
          if (
            enabled &&
            event.target instanceof Element &&
            !event.target.closest(
              'button, input, textarea, select, a, [contenteditable="true"]',
            )
          )
            rootRef.current?.focus({ preventScroll: true });
        }}
        onKeyDownCapture={(event): void => {
          if (!enabled || headless) return;
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === 'f'
          ) {
            event.preventDefault();
            event.stopPropagation();
            open();
          } else if (opened && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        {header}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {enabled && opened && !headless && (
            <PaneSheet
              placement="top-end"
              width="search"
              padding="controls"
              role="search"
              aria-label="Find in preview"
              data-testid="file-preview-search-drawer"
            >
              <SearchBar
                query={query}
                onQueryChange={(value): void => {
                  setQuery(value);
                  setIndex(0);
                }}
                currentIndex={index}
                totalCount={count}
                onNext={(): void =>
                  setIndex((previous) => (count ? (previous + 1) % count : 0))
                }
                onPrevious={(): void =>
                  setIndex((previous) =>
                    count ? (previous - 1 + count) % count : 0,
                  )
                }
                onClose={close}
                inputRef={inputRef}
                autoFocus
                label="Find in preview"
              />
            </PaneSheet>
          )}
          <style>{`::highlight(${names.matches}) { background-color: color-mix(in srgb, var(--fg-warning) 35%, transparent); color: inherit; } ::highlight(${names.active}) { background-color: color-mix(in srgb, var(--fg-warning) 65%, transparent); }`}</style>
          <div
            ref={contentRef}
            className="flex min-h-0 flex-1 flex-col"
            data-testid="file-preview-search-content"
          >
            {children}
          </div>
        </div>
      </div>
    </PreviewSearchContext.Provider>
  );
}
