import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useShallow } from 'zustand/shallow';
import { useChatStore } from '@/stores/chatStore';
import { useFileTabUiStore } from '@/stores/fileTabUiStore';
import {
  getWorktreeCacheKey,
  useFileListStore,
  useRetainFileIndex,
} from '@/stores/fileListStore';
import { searchFiles, type FileSearchResult } from '@/lib/fuzzySearch';
import { getFilenameMatchedIndices } from './file-search-palette-helpers';
import { shouldFetchFileSearchPaletteEntry } from './file-search-palette-state';
import { HighlightedSegments, splitMatchSegments } from '@canopy/ui-shared';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  Surface,
  DelayedLoadingPlaceholder,
  DialogModal,
  ErrorState,
  KeyHintFooter,
  ListRow,
  SearchField,
  Skeleton,
} from '@canopy/ui-shared/components';
import { pickerKeyHints } from '@canopy/ui-shared/lib/shortcuts';
import { isCoworkWorkspaceFileRoot } from '@canopy/ui-shared/lib/file-root-groups';

interface FileSearchPaletteProps {
  initialQuery: string;
  onClose: () => void;
}

const RESULT_PAGE_SIZE = 50;

/** Plain files the loading skeleton lays out as result rows. */
const SAMPLE_RESULTS = [
  { filename: 'index.ts', path: 'src/index.ts', repo: 'storefront' },
  {
    filename: 'checkout.tsx',
    path: 'src/checkout/checkout.tsx',
    repo: 'storefront',
  },
  { filename: 'README.md', path: 'README.md', repo: 'storefront' },
] as const;

/**
 * The result list while the file index loads: the same `ListRow` rows, from
 * sample files, measured inside `Skeleton`.
 */
function FileSearchResultsSkeleton(): JSX.Element {
  return (
    <DelayedLoadingPlaceholder slowNote="Still loading files…">
      <Skeleton
        loading
        label="Loading files"
        testId="file-search-palette-loading"
      >
        <ul className="px-2 py-2">
          {SAMPLE_RESULTS.map((sample) => (
            <li key={sample.path}>
              <ListRow description={sample.path} trailing={sample.repo}>
                {sample.filename}
              </ListRow>
            </li>
          ))}
        </ul>
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}

export function FileSearchPalette({
  initialQuery,
  onClose,
}: FileSearchPaletteProps): JSX.Element {
  const [query, setQuery] = useState(initialQuery);
  const [{ selectedIndex, visibleStart, visibleCount }, setNavigation] =
    useState({
      selectedIndex: 0,
      visibleStart: 0,
      visibleCount: RESULT_PAGE_SIZE,
    });
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectionScrollRef = useRef(false);
  const itemRefs = useRef<Map<number, HTMLLIElement>>(new Map());
  const deferredQuery = useDeferredValue(query);

  const selectedWorktree = useChatStore((state) => state.selectedWorktree);
  const openFileTab = useChatStore((state) => state.openFileTab);

  const cacheKey = selectedWorktree
    ? getWorktreeCacheKey(
        selectedWorktree.projectId,
        selectedWorktree.worktreeId,
      )
    : null;
  useRetainFileIndex(cacheKey);

  const { entry, error, isLoading, fetchFileIndex } = useFileListStore(
    useShallow((state) => ({
      entry: cacheKey ? state.indexCache[cacheKey] : undefined,
      error: cacheKey ? state.indexErrors[cacheKey] : undefined,
      isLoading: cacheKey ? state.indexLoading.has(cacheKey) : false,
      fetchFileIndex: state.fetchFileIndex,
    })),
  );

  useEffect(() => {
    if (!selectedWorktree) return;
    if (!shouldFetchFileSearchPaletteEntry(entry, isLoading, error)) return;
    void fetchFileIndex(
      selectedWorktree.projectId,
      selectedWorktree.worktreeId,
    );
  }, [entry, error, fetchFileIndex, isLoading, selectedWorktree]);

  // Rank once per query/index. Scrolling reveals another page from this
  // cached result set without rescanning files or repeating the sort.
  const allResults = useMemo(() => {
    const repos = entry?.data.repos ?? [];
    return searchFiles(deferredQuery, repos, Infinity, 'path-coverage');
  }, [entry, deferredQuery]);
  const renderedVisibleStart =
    allResults.length === 0
      ? 0
      : Math.min(
          visibleStart,
          Math.floor((allResults.length - 1) / RESULT_PAGE_SIZE) *
            RESULT_PAGE_SIZE,
        );
  const results = useMemo(
    () =>
      allResults.slice(
        renderedVisibleStart,
        renderedVisibleStart + visibleCount,
      ),
    [allResults, renderedVisibleStart, visibleCount],
  );

  useEffect(() => {
    setNavigation({
      selectedIndex: 0,
      visibleStart: 0,
      visibleCount: RESULT_PAGE_SIZE,
    });
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [deferredQuery, cacheKey]);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    setNavigation((current) => {
      const nextIndex =
        allResults.length === 0
          ? -1
          : Math.max(0, Math.min(current.selectedIndex, allResults.length - 1));
      const nextVisibleStart =
        allResults.length === 0
          ? 0
          : Math.min(
              current.visibleStart,
              Math.floor((allResults.length - 1) / RESULT_PAGE_SIZE) *
                RESULT_PAGE_SIZE,
            );
      const remainingResults = allResults.length - nextVisibleStart;
      const nextVisibleCount =
        allResults.length === 0
          ? RESULT_PAGE_SIZE
          : Math.min(RESULT_PAGE_SIZE, remainingResults);
      return nextIndex === current.selectedIndex &&
        nextVisibleStart === current.visibleStart &&
        nextVisibleCount === current.visibleCount
        ? current
        : {
            selectedIndex: nextIndex,
            visibleStart: nextVisibleStart,
            visibleCount: nextVisibleCount,
          };
    });
  }, [allResults]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [visibleStart]);

  useEffect(() => {
    if (selectedIndex < 0) return;
    const item = itemRefs.current.get(selectedIndex);
    if (!item) return;
    selectionScrollRef.current = true;
    item.scrollIntoView({ block: 'nearest' });
    const frame = requestAnimationFrame((): void => {
      selectionScrollRef.current = false;
    });
    return (): void => cancelAnimationFrame(frame);
  }, [selectedIndex]);

  function handleSelect(result: FileSearchResult | undefined): void {
    if (!result) return;
    const file = {
      absolutePath: result.absolutePath,
      filename: result.filename,
    };
    // Quick-open from an ACTIVE empty file tab fills that tab (the empty
    // state advertises this shortcut) instead of opening a second tab.
    const chat = useChatStore.getState();
    const sel = chat.selectedWorktree;
    const wc = sel
      ? chat.worktreeChats[`${sel.projectId}/${sel.worktreeId}`]
      : undefined;
    const activeTab = wc?.tabs.find((tab) => tab.id === wc.activeTabId);
    if (
      activeTab?.kind === 'file' &&
      (activeTab.filePath === undefined || activeTab.filePath === '')
    ) {
      const assigned = chat.assignFileTab(activeTab.id, file);
      if (assigned === activeTab.id) {
        useFileTabUiStore.getState().setFileTreeVisible(activeTab.id, false);
      }
    } else {
      openFileTab(file);
    }
    onClose();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (allResults.length === 0) return;
      setNavigation((current) => {
        const nextIndex =
          current.selectedIndex < 0
            ? 0
            : (current.selectedIndex + 1) % allResults.length;
        const visibleEnd = current.visibleStart + current.visibleCount;
        if (nextIndex === 0) {
          return {
            selectedIndex: nextIndex,
            visibleStart: 0,
            visibleCount: Math.min(RESULT_PAGE_SIZE, allResults.length),
          };
        }
        if (nextIndex < current.visibleStart || nextIndex >= visibleEnd) {
          const nextVisibleStart =
            Math.floor(nextIndex / RESULT_PAGE_SIZE) * RESULT_PAGE_SIZE;
          return {
            selectedIndex: nextIndex,
            visibleStart: nextVisibleStart,
            visibleCount: Math.min(
              RESULT_PAGE_SIZE,
              allResults.length - nextVisibleStart,
            ),
          };
        }
        return {
          ...current,
          selectedIndex: nextIndex,
        };
      });
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (allResults.length === 0) return;
      setNavigation((current) => {
        const nextIndex =
          current.selectedIndex <= 0
            ? allResults.length - 1
            : current.selectedIndex - 1;
        if (
          nextIndex < current.visibleStart ||
          nextIndex >= current.visibleStart + current.visibleCount
        ) {
          const nextVisibleStart =
            Math.floor(nextIndex / RESULT_PAGE_SIZE) * RESULT_PAGE_SIZE;
          return {
            selectedIndex: nextIndex,
            visibleStart: nextVisibleStart,
            visibleCount: Math.min(
              RESULT_PAGE_SIZE,
              allResults.length - nextVisibleStart,
            ),
          };
        }
        return {
          ...current,
          selectedIndex: nextIndex,
        };
      });
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const selected =
        selectedIndex >= 0 ? allResults[selectedIndex] : undefined;
      handleSelect(selected);
    }
  }

  const showLoading = !!selectedWorktree && isLoading && !entry;
  const showEmpty =
    !!selectedWorktree && !showLoading && allResults.length === 0 && !error;

  return (
    <DialogModal
      onClose={onClose}
      title="File search"
      titleId="file-search-palette-title"
      placement="top"
      maxWidth="2xl"
      inset="flush"
      headerBorder={false}
      scrollableBody={false}
      dataTestId="file-search-palette"
    >
      {/* The palette's own keys: Escape closes from anywhere inside, even a
          focused result row, which the dialog's Escape leaves to the list. */}
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={handleKeyDown}>
        <Surface variant="section" boundary="bottom">
          <SearchField
            ref={inputRef}
            size="lg"
            aria-label="Search files"
            clearOnEscape={false}
            value={query}
            onValueChange={(next) => {
              setQuery(next);
              setNavigation({
                selectedIndex: 0,
                visibleStart: 0,
                visibleCount: RESULT_PAGE_SIZE,
              });
            }}
            placeholder={
              selectedWorktree
                ? 'Search files…'
                : 'Select a worktree to search files'
            }
            data-testid="file-search-palette-input"
            disabled={!selectedWorktree}
          />
        </Surface>
        <div
          ref={scrollRef}
          data-testid="file-search-palette-scroll"
          className="max-h-88 min-h-0 overflow-y-auto"
          onScroll={(event) => {
            if (selectionScrollRef.current) return;
            const { scrollTop, scrollHeight, clientHeight } =
              event.currentTarget;
            if (scrollHeight - scrollTop - clientHeight > 0) return;
            setNavigation((current) => {
              const nextVisibleStart =
                current.visibleStart + current.visibleCount;
              if (nextVisibleStart >= allResults.length) return current;
              return {
                selectedIndex: nextVisibleStart,
                visibleStart: nextVisibleStart,
                visibleCount: Math.min(
                  RESULT_PAGE_SIZE,
                  allResults.length - nextVisibleStart,
                ),
              };
            });
          }}
        >
          {!selectedWorktree && (
            <div className="px-4 py-8 text-center text-s fg-secondary">
              Select a worktree to search files
            </div>
          )}
          {showLoading && <FileSearchResultsSkeleton />}
          {error && <ErrorState space="panel" message={error} />}
          {showEmpty && (
            <div className="px-4 py-8 text-center text-s fg-secondary">
              {deferredQuery
                ? 'No matching files'
                : 'No files in this worktree'}
            </div>
          )}
          {!showLoading && !error && allResults.length > 0 && (
            <ul role="listbox" aria-label="Files" className="px-2 py-2">
              {results.map((result, visibleIndex) => {
                const index = renderedVisibleStart + visibleIndex;
                const isSelected = index === selectedIndex;
                const filenameSegments = splitMatchSegments(
                  result.filename,
                  getFilenameMatchedIndices(result),
                );
                const pathSegments = splitMatchSegments(
                  result.relativePath,
                  result.matchedIndices,
                );
                return (
                  <li
                    key={`${result.repoId}:${result.absolutePath}`}
                    ref={(node): void => {
                      if (node) {
                        itemRefs.current.set(index, node);
                      } else {
                        itemRefs.current.delete(index);
                      }
                    }}
                  >
                    <ListRow
                      role="option"
                      aria-selected={isSelected}
                      selected={isSelected}
                      data-testid="file-search-palette-result"
                      data-path={result.relativePath}
                      onMouseEnter={() =>
                        setNavigation((current) => ({
                          ...current,
                          selectedIndex: index,
                        }))
                      }
                      onClick={() => handleSelect(result)}
                      description={
                        <HighlightedSegments segments={pathSegments} />
                      }
                      trailing={
                        <span
                          className={
                            isCoworkWorkspaceFileRoot({
                              id: result.repoId,
                              kind: result.rootKind,
                            })
                              ? REPLAY_MASK_CLASS
                              : undefined
                          }
                        >
                          {result.repoName}
                        </span>
                      }
                    >
                      <HighlightedSegments segments={filenameSegments} />
                    </ListRow>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <KeyHintFooter hints={pickerKeyHints('open')} />
      </div>
    </DialogModal>
  );
}
