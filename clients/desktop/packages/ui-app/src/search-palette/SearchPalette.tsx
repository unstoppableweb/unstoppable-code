import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  DialogModal,
  ErrorBanner,
  Heading,
  PickListResults,
  SearchEmptyState,
  SearchField,
  SearchPaletteLayout,
  pickListOptionId,
  usePickListKeys,
} from '@canopy/ui-shared/components';
import { useOptionalCanopyClient } from '@canopy/app-state';
import type { SearchPaletteItem } from './search-palette-items';
import {
  parseSearchPaletteQuery,
  rankSearchPaletteItems,
  rankSearchPaletteScopeWithoutQuery,
  withSearchPaletteContentSection,
  type SearchPaletteFlatEntry,
} from './search-palette-ranking';
import {
  filterSearchPaletteItemsByScope,
  nextSearchPaletteScope,
  searchPalettePlaceholder,
  searchPaletteScopeSearchesContent,
  searchPaletteScopesFor,
  type SearchPaletteScopeId,
} from './search-palette-scopes';
import { SearchPaletteRowContent } from './SearchPaletteRowContent';

/** What opening a result did: whether the palette closes, or why it failed. */
export interface SearchPaletteActivation {
  readonly closePalette: boolean;
  readonly error?: string;
}

export interface SearchPaletteProps<T extends SearchPaletteItem> {
  /** The field's text. The host owns it so it can run its own searches. */
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly scope: SearchPaletteScopeId;
  readonly onScopeChange: (next: SearchPaletteScopeId) => void;
  /** Everything the palette ranks against the query. */
  readonly items: readonly T[];
  /**
   * Content hits from a deferred text search, appended after the ranked
   * sections in scopes that search content. Hits whose chat, plan or
   * archive already has a title row (`titleRowIds`) should be left out.
   */
  readonly buildContentItems?: (
    titleRowIds: ReadonlySet<string>,
  ) => readonly T[];
  /** Opens a result. */
  readonly onActivate: (
    item: T,
  ) => Promise<SearchPaletteActivation> | SearchPaletteActivation;
  readonly onClose: () => void;
  /**
   * Draws a result's project badge when the host resolves avatars itself
   * (desktop reads a repository's owner avatar over IPC). Unset draws the
   * item's `avatarUrl` over the kind badge.
   */
  readonly renderProjectBadge?: (item: T) => ReactNode;
  /** A row's test id, when the host pins some rows for automation. */
  readonly rowTestId?: (item: T) => string | undefined;
}

/**
 * The Cmd+K search palette shared by desktop and the web Portal: the field,
 * the ranked results and the scope tabs in a content-header dialog at the
 * quick prompt's width. The host supplies the items it can serve and opens
 * a result; the palette owns ranking, selection and its keys (Escape closes,
 * Tab and Shift-Tab step through the scopes, the arrows move, Enter opens).
 * Scopes the host's `searchPalette` capability does not serve render
 * unavailable.
 */
export function SearchPalette<T extends SearchPaletteItem>({
  query,
  onQueryChange,
  scope,
  onScopeChange,
  items,
  buildContentItems,
  onActivate,
  onClose,
  renderProjectBadge,
  rowTestId,
}: SearchPaletteProps<T>): JSX.Element {
  const { commandsOnly, query: parsedQuery } = parseSearchPaletteQuery(query);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(),
  );
  // Scopes the host's client does not serve stay visible but unavailable.
  const capabilities = useOptionalCanopyClient()?.capabilities;
  const scopes = useMemo(
    () => searchPaletteScopesFor(capabilities),
    [capabilities],
  );
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemIdRef = useRef<string | null>(null);
  const pendingExpandedSelectionRef = useRef<{
    sectionId: string;
    visibleItemCount: number;
  } | null>(null);
  // True once the user explicitly moved the selection (arrows/hover) for the
  // current query. Until then the default selection tracks the best-scoring
  // item, so late-arriving low-score sections (e.g. marketplace plugins
  // rendered above the pinned-last commands) cannot steal Enter.
  const userNavigatedRef = useRef(false);

  // `>` always lists the commands catalog, whatever the scope.
  const scopedItems = useMemo(
    () =>
      commandsOnly ? items : filterSearchPaletteItemsByScope(items, scope),
    [items, scope, commandsOnly],
  );

  const baseRanking = useMemo(
    () =>
      scope !== 'all' && !commandsOnly && parsedQuery.length === 0
        ? rankSearchPaletteScopeWithoutQuery(scopedItems, expandedSections)
        : rankSearchPaletteItems(
            scopedItems,
            query,
            undefined,
            expandedSections,
          ),
    [scopedItems, scope, commandsOnly, parsedQuery, query, expandedSections],
  );

  // Ids of visible chat/plan title rows — content hits for the same doc are
  // dropped rather than shown twice.
  const titleRowIds = useMemo(
    () =>
      new Set(
        baseRanking.sections
          .flatMap((section) => section.items)
          .filter(
            ({ item }) =>
              item.kind === 'chat' ||
              item.kind === 'plan' ||
              item.kind === 'archive',
          )
          .map(({ item }) => item.id),
      ),
    [baseRanking],
  );

  const contentItems = useMemo(
    () =>
      buildContentItems && searchPaletteScopeSearchesContent(scope)
        ? buildContentItems(titleRowIds)
        : [],
    [buildContentItems, scope, titleRowIds],
  );

  const ranking = useMemo(
    () => withSearchPaletteContentSection(baseRanking, contentItems),
    [baseRanking, contentItems],
  );

  const flatItems = ranking.flat;

  // Also covers palette open: the first render runs this effect.
  useEffect(() => {
    userNavigatedRef.current = false;
    setExpandedSections(new Set());
  }, [query, scope]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const pending = pendingExpandedSelectionRef.current;
    if (pending) {
      const sectionIndex = ranking.sections.findIndex(
        (section) => section.id === pending.sectionId,
      );
      const item =
        ranking.sections[sectionIndex]?.items[pending.visibleItemCount];
      const expandedIndex = item
        ? flatItems.findIndex((entry) => entry.id === item.item.id)
        : -1;
      pendingExpandedSelectionRef.current = null;
      if (expandedIndex >= 0) {
        userNavigatedRef.current = true;
        selectedItemIdRef.current = item?.item.id ?? null;
        setSelectedIndex(expandedIndex);
        inputRef.current?.focus();
        return;
      }
    }
    if (flatItems.length === 0) {
      setSelectedIndex(-1);
      return;
    }
    setSelectedIndex((currentIndex) => {
      if (!userNavigatedRef.current) {
        let bestIndex = 0;
        for (let index = 1; index < flatItems.length; index += 1) {
          const entry = flatItems[index];
          const bestEntry = flatItems[bestIndex];
          if (
            entry?.type === 'item' &&
            (bestEntry?.type !== 'item' ||
              entry.ranked.score > bestEntry.ranked.score)
          ) {
            bestIndex = index;
          }
        }
        selectedItemIdRef.current = flatItems[bestIndex]?.id ?? null;
        return bestIndex;
      }
      const selectedId = selectedItemIdRef.current;
      if (selectedId !== null) {
        const refreshedIndex = flatItems.findIndex(
          (entry) => entry.id === selectedId,
        );
        if (refreshedIndex >= 0) {
          return refreshedIndex;
        }
      }
      if (currentIndex < 0) {
        selectedItemIdRef.current = flatItems[0]?.id ?? null;
        return 0;
      }
      if (currentIndex >= flatItems.length) {
        const clampedIndex = flatItems.length - 1;
        selectedItemIdRef.current = flatItems[clampedIndex]?.id ?? null;
        return clampedIndex;
      }
      selectedItemIdRef.current = flatItems[currentIndex]?.id ?? null;
      return currentIndex;
    });
  }, [flatItems, ranking.sections]);

  const activeKey =
    selectedIndex >= 0 ? (flatItems[selectedIndex]?.id ?? null) : null;

  const activateItem = useCallback(
    async (item: T): Promise<void> => {
      setErrorMessage(null);
      try {
        const result = await onActivate(item);
        if (result.error) {
          setErrorMessage(result.error);
        }
        if (result.closePalette) {
          onClose();
        }
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : 'Command failed',
        );
      }
    },
    [onActivate, onClose],
  );

  const activateEntry = useCallback(
    (entry: SearchPaletteFlatEntry<T> | undefined): void => {
      if (!entry) {
        return;
      }
      if (entry.type === 'show-more') {
        const { sectionId, visibleItemCount } = entry;
        pendingExpandedSelectionRef.current = {
          sectionId,
          visibleItemCount,
        };
        setExpandedSections((current) => {
          const next = new Set(current);
          next.add(sectionId);
          return next;
        });
        inputRef.current?.focus();
        return;
      }
      void activateItem(entry.ranked.item);
    },
    [activateItem],
  );

  // The pointer or the arrows moved the highlight to `key`.
  const handleActiveKeyChange = useCallback(
    (key: string): void => {
      const index = flatItems.findIndex((entry) => entry.id === key);
      if (index < 0) return;
      userNavigatedRef.current = true;
      selectedItemIdRef.current = key;
      setSelectedIndex(index);
    },
    [flatItems],
  );

  const handlePickKey = useCallback(
    (key: string): void => {
      activateEntry(flatItems.find((entry) => entry.id === key));
    },
    [activateEntry, flatItems],
  );

  const listKeys = useMemo(
    () => flatItems.map((entry) => entry.id),
    [flatItems],
  );
  // The field keeps focus: the arrows, Home and End move the highlight and
  // Enter opens it.
  const handleListKeys = usePickListKeys({
    keys: listKeys,
    activeKey,
    onActiveKeyChange: handleActiveKeyChange,
    onPick: handlePickKey,
  });

  const sectionLabelByEntryId = useMemo(() => {
    const labels = new Map<string, string>();
    for (const section of ranking.sections) {
      for (const ranked of section.items) {
        labels.set(ranked.item.id, section.label);
      }
      labels.set(`show-more:${section.id}`, section.label);
    }
    return labels;
  }, [ranking]);

  function resetSelection(): void {
    setErrorMessage(null);
    selectedItemIdRef.current = null;
    setSelectedIndex(0);
  }

  function changeScope(next: SearchPaletteScopeId): void {
    onScopeChange(next);
    resetSelection();
    inputRef.current?.focus();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    // Tab and Shift-Tab step through the scopes, as in the tabs below.
    if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      changeScope(nextSearchPaletteScope(scopes, scope, event.shiftKey));
      return;
    }
  }

  return (
    <DialogModal
      onClose={onClose}
      header="content"
      titleId="command-palette-title"
      placement="top"
      maxWidth="xl"
      inset="flush"
      scrollableBody={false}
      dataTestId="command-palette"
    >
      {/* The field names the palette; the heading names the dialog. */}
      <Heading
        level={2}
        variant="title"
        id="command-palette-title"
        className="sr-only"
      >
        Search
      </Heading>
      {/* The palette's own keys: Escape closes and Tab steps through the
          scopes from anywhere inside, a focused scope tab included. */}
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={handleKeyDown}>
        <SearchPaletteLayout
          scopes={scopes}
          scope={scope}
          onScopeChange={changeScope}
          scopeLabel="Search in"
          scopesTestId="command-palette-scopes"
          resultsTestId="command-palette-results"
          field={
            <SearchField
              ref={inputRef}
              size="lg"
              value={query}
              onValueChange={(next): void => {
                onQueryChange(next);
                resetSelection();
              }}
              // Escape closes the palette at once (the dialog's handler); the
              // nested button clears the query.
              clearOnEscape={false}
              onKeyDown={handleListKeys}
              aria-label="Search"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={flatItems.length > 0}
              aria-controls={listId}
              aria-activedescendant={
                activeKey === null
                  ? undefined
                  : pickListOptionId(listId, activeKey)
              }
              placeholder={searchPalettePlaceholder(scopes, scope)}
              data-testid="command-palette-input"
              clearTestId="command-palette-clear"
            />
          }
        >
          {errorMessage && (
            <div className="shrink-0 px-3 pt-3">
              <ErrorBanner
                errorSource="search-palette"
                error={errorMessage}
                className=""
              />
            </div>
          )}
          {/* Session replay records the results; a transcript or plan snippet
            row blocks its own snippet (`SearchPaletteRowContent`). */}
          {flatItems.length === 0 ? (
            <SearchEmptyState
              testId="command-palette-empty"
              title={
                scope === 'content' && parsedQuery.length === 0
                  ? 'Type to search the text of your chats and plans.'
                  : 'Nothing matches your search.'
              }
              actionLabel={query === '' ? undefined : 'Clear search'}
              onAction={(): void => {
                onQueryChange('');
                resetSelection();
                inputRef.current?.focus();
              }}
              actionTestId="command-palette-empty-clear"
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col px-2 py-1">
              <PickListResults
                items={flatItems}
                getKey={(entry): string => entry.id}
                getLabel={(entry): string =>
                  entry.type === 'item'
                    ? entry.ranked.item.title
                    : `Show ${entry.count} more`
                }
                getSection={(entry): string | undefined =>
                  sectionLabelByEntryId.get(entry.id)
                }
                renderItem={(entry): ReactNode =>
                  entry.type === 'item' ? (
                    <SearchPaletteRowContent
                      item={entry.ranked.item}
                      titleIndices={entry.ranked.titleIndices}
                      projectBadge={
                        entry.ranked.item.project
                          ? renderProjectBadge?.(entry.ranked.item)
                          : undefined
                      }
                    />
                  ) : (
                    <span className="min-w-0 truncate">
                      Show {entry.count} more
                    </span>
                  )
                }
                onPick={activateEntry}
                listId={listId}
                listLabel="Results"
                activeKey={activeKey}
                onActiveKeyChange={handleActiveKeyChange}
                emptyLabel="Nothing matches your search."
                optionTestId={(entry): string =>
                  entry.type === 'show-more'
                    ? 'command-palette-show-more'
                    : (rowTestId?.(entry.ranked.item) ??
                      'command-palette-result')
                }
                optionProps={(entry) => ({
                  'data-palette-kind':
                    entry.type === 'item' ? entry.ranked.item.kind : undefined,
                })}
              />
            </div>
          )}
        </SearchPaletteLayout>
      </div>
    </DialogModal>
  );
}
