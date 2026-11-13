'use client';

import {
  forwardRef,
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from '@tanstack/react-virtual';
import {
  ChoiceList,
  ChoiceListRow,
  Heading,
  Divider,
  HighlightedText,
  SearchEmptyState,
  SearchField,
  SegmentedControl,
  StatusLabel,
  Surface,
} from '@canopy/ui-shared/components';
import type { ModelGatewayModel } from '@canopy/protocol/canopy-server';
import { useSettingsPrivacy } from '../host';
import { joinClassNames } from '../organization/settings/join-class-names';
import {
  foldGatewayQuery,
  gatewayHighlightIndices,
  gatewayModelListView,
  indexGatewayModels,
  type GatewayModelFilter,
  type GatewayModelListItem,
} from './gateway-model-search';

export interface GatewayModelBrowserProps {
  readonly models: readonly ModelGatewayModel[];
  /** Model IDs that are on. */
  readonly selected: ReadonlySet<string>;
  /** The preset's suggested gateway IDs, in its order; none for custom. */
  readonly suggestedIds?: readonly string[];
  /**
   * Gateway IDs the gateway marked as open-weight. The Open weights filter
   * shows only when the gateway marked at least one.
   */
  readonly openWeightIds?: ReadonlySet<string>;
  /** Saved models that count against `limit` but aren't rows here. */
  readonly reservedCount?: number;
  readonly limit: number;
  /** Shown in the attention tone once the limit is reached. */
  readonly capHint: string;
  readonly disabled: boolean;
  readonly onToggle: (id: string) => void;
  /** Opens the add form with this gateway ID filled in. */
  readonly onAddManually: (gatewayId: string) => void;
  readonly layout: 'page' | 'dialog';
  /** Focus the search once mounted, as Connect succeeds. */
  readonly autoFocus?: boolean;
}

// One two-line row (name over ID) plus the hairline above it.
const OPTION_HEIGHT_PX = 55;
const HEADER_HEIGHT_PX = 28;
const LIST_HEIGHT_PX = { page: 360, dialog: 300 } as const;
const ROW_SELECTOR = '[role="checkbox"]';
// Stable defaults, so the memoized view isn't rebuilt on every render.
const NO_SUGGESTIONS: readonly string[] = [];
const NO_SELECTION: ReadonlySet<string> = new Set();
const NO_OPEN_WEIGHTS: ReadonlySet<string> = new Set();

/** The last group header at or above the first row in view, or null. */
function stickyIndexFor(
  stickyIndexes: readonly number[],
  startIndex: number,
): number | null {
  let sticky: number | null = null;
  for (const at of stickyIndexes) {
    if (at > startIndex) break;
    sticky = at;
  }
  return sticky;
}

/**
 * Every model a gateway lists, browsable at 500+ rows: a search pinned
 * above a virtualized list of checkboxes, filters, and provider groups whose header
 * sticks while its rows scroll. Nothing is paged away; search, filters and
 * groups make the whole catalog reachable.
 */
export const GatewayModelBrowser = forwardRef<
  HTMLInputElement,
  GatewayModelBrowserProps
>(function GatewayModelBrowser(
  {
    models,
    selected,
    suggestedIds = NO_SUGGESTIONS,
    openWeightIds = NO_OPEN_WEIGHTS,
    reservedCount = 0,
    limit,
    capHint,
    disabled,
    onToggle,
    onAddManually,
    layout,
    autoFocus = false,
  },
  searchRef,
): JSX.Element | null {
  const { maskClassName } = useSettingsPrivacy();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState<GatewayModelFilter>('all');
  // The last focused option, by key: an index would point at another row
  // once a search or filter changes the list.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<number | null>(null);

  const index = useMemo(
    () => indexGatewayModels(models, openWeightIds),
    [models, openWeightIds],
  );
  const hasOpenWeights = openWeightIds.size > 0;
  // A refresh that no longer reports open weights can't strand the filter.
  const shownFilter = filter === 'open' && !hasOpenWeights ? 'all' : filter;
  // Only the On filter reads the selection, so a toggle elsewhere doesn't
  // regroup the catalog.
  const viewSelected = shownFilter === 'on' ? selected : NO_SELECTION;
  const { items, optionCount } = useMemo(
    () =>
      gatewayModelListView({
        index,
        query: deferredQuery,
        filter: shownFilter,
        selected: viewSelected,
        suggestedIds,
      }),
    [index, deferredQuery, shownFilter, viewSelected, suggestedIds],
  );
  const selectedCount = useMemo(
    () => models.filter((model) => selected.has(model.id)).length,
    [models, selected],
  );
  const enabledCount = selectedCount + reservedCount;
  const atCapacity = enabledCount >= limit;
  // A query of separators only (`-`) folds away and isn't a search.
  const searching = foldGatewayQuery(deferredQuery).tokens.length > 0;

  const stickyIndexes = useMemo(
    () => items.flatMap((item, at) => (item.kind === 'header' ? [at] : [])),
    [items],
  );
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const sticky = stickyIndexFor(stickyIndexes, range.startIndex);
      const indexes = defaultRangeExtractor(range);
      return sticky === null || indexes.includes(sticky)
        ? indexes
        : [sticky, ...indexes];
    },
    [stickyIndexes],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (at) =>
      items[at]?.kind === 'header' ? HEADER_HEIGHT_PX : OPTION_HEIGHT_PX,
    getItemKey: (at) => items[at]?.key ?? at,
    overscan: 12,
    rangeExtractor,
    initialRect: { width: 0, height: LIST_HEIGHT_PX[layout] },
  });

  // A search or filter change can drop the pending row for good, so it
  // never steals focus later.
  useLayoutEffect(() => {
    pendingFocusRef.current = null;
  }, [items]);

  // Focus follows a key press once its row has rendered: `scrollToIndex`
  // runs first, so focus never lands on a row the virtualizer dropped.
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending === null) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(
      `[data-index="${pending}"] ${ROW_SELECTOR}`,
    );
    if (!row) return;
    pendingFocusRef.current = null;
    row.focus();
  });

  if (models.length === 0) return null;

  const optionIndexes = (): number[] =>
    items.flatMap((item, at) => (item.kind === 'option' ? [at] : []));
  const focusOption = (at: number | undefined): void => {
    if (at === undefined) return;
    setActiveKey(items[at]?.key ?? null);
    pendingFocusRef.current = at;
    virtualizer.scrollToIndex(at);
    // Already rendered rows take focus now; others when they render.
    const row = scrollRef.current?.querySelector<HTMLElement>(
      `[data-index="${at}"] ${ROW_SELECTOR}`,
    );
    if (row) {
      pendingFocusRef.current = null;
      row.focus();
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const current = Number(
      target.closest('[data-index]')?.getAttribute('data-index') ?? -1,
    );
    const options = optionIndexes();
    const at = options.indexOf(current);
    let next: number | undefined;
    if (event.key === 'ArrowDown')
      next = options[Math.min(at + 1, options.length - 1)];
    else if (event.key === 'ArrowUp') next = options[Math.max(at - 1, 0)];
    else if (event.key === 'Home') next = options[0];
    else if (event.key === 'End') next = options[options.length - 1];
    else return;
    event.preventDefault();
    focusOption(next);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    focusOption(optionIndexes()[0]);
  };

  const activeAt =
    activeKey === null
      ? -1
      : items.findIndex(
          (item) => item.kind === 'option' && item.key === activeKey,
        );
  const preferredStop =
    activeAt !== -1
      ? activeAt
      : items.findIndex((item) => item.kind === 'option');
  // The virtualizer drops far-off rows; keep the tab stop on a rendered
  // option so Tab still reaches the list after a scroll.
  const renderedRows = virtualizer.getVirtualItems();
  // `range` is the one `rangeExtractor` just saw.
  const activeSticky = virtualizer.range
    ? stickyIndexFor(stickyIndexes, virtualizer.range.startIndex)
    : null;
  const tabStop = renderedRows.some((row) => row.index === preferredStop)
    ? preferredStop
    : (renderedRows.find((row) => items[row.index]?.kind === 'option')?.index ??
      preferredStop);
  const matchCount = optionCount === 1 ? '1 match' : `${optionCount} matches`;
  const emptyTitle = searching ? (
    <>
      No models match “
      <span className={maskClassName}>{deferredQuery.trim()}</span>”.
    </>
  ) : shownFilter === 'on' ? (
    'No models are on.'
  ) : shownFilter === 'claude' ? (
    'No Claude models listed.'
  ) : shownFilter === 'open' ? (
    'No open-weight models listed.'
  ) : (
    'No OpenAI models listed.'
  );

  const renderItem = (item: GatewayModelListItem, at: number): JSX.Element =>
    item.kind === 'header' ? (
      // Opaque, so rows scroll under the header that sticks.
      <Surface variant="pane" extent="parent" role="presentation">
        <div className="flex h-full items-center px-3 text-xs font-medium fg-secondary">
          {`${item.label} · ${item.count}`}
        </div>
      </Surface>
    ) : (
      <ChoiceListRow
        focusableWhenDisabled
        selected={selected.has(item.model.id)}
        disabled={disabled || (atCapacity && !selected.has(item.model.id))}
        tabIndex={at === tabStop ? 0 : -1}
        data-testid={`ai-gateway-model-choice-${item.model.gatewayId}`}
        onFocus={() => setActiveKey(item.key)}
        onClick={() => onToggle(item.model.id)}
      >
        <span className={joinClassNames('block truncate', maskClassName)}>
          <HighlightedText
            text={item.model.label}
            indices={gatewayHighlightIndices(item.model.label, deferredQuery)}
          />
        </span>
        <span
          className={joinClassNames(
            'block truncate font-mono text-xs fg-secondary',
            maskClassName,
          )}
          title={item.model.gatewayId}
        >
          <HighlightedText
            text={item.model.gatewayId}
            indices={gatewayHighlightIndices(
              item.model.gatewayId,
              deferredQuery,
            )}
          />
        </span>
      </ChoiceListRow>
    );

  return (
    <div className="flex flex-col gap-2" data-testid="ai-gateway-model-browser">
      <div className="flex items-center justify-between gap-3">
        <Heading level={3} variant="title">
          Models
        </Heading>
        <span className="flex items-center gap-2 text-xs fg-secondary">
          {atCapacity ? (
            <StatusLabel
              tone="attention"
              size="xs"
              data-testid="ai-gateway-model-cap-hint"
            >
              {capHint}
            </StatusLabel>
          ) : null}
          <span data-testid="ai-gateway-model-count">
            {reservedCount > 0
              ? // Refresh: saved models aren't rows here, so name both counts.
                `${selectedCount} new · ${enabledCount} of ${limit}`
              : `${enabledCount} on · up to ${limit}`}
          </span>
        </span>
      </div>
      <SearchField
        ref={searchRef}
        size="sm"
        aria-label="Search models"
        placeholder={`Search ${models.length} models`}
        value={query}
        onValueChange={setQuery}
        count={searching ? matchCount : undefined}
        clearOnEscape
        autoFocus={autoFocus}
        fieldTestId="ai-gateway-model-search"
        onKeyDown={onSearchKeyDown}
      />
      <SegmentedControl<GatewayModelFilter>
        label="Show models"
        value={shownFilter}
        width="content"
        dataTestId="ai-gateway-model-filter"
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'claude', label: 'Claude' },
          { value: 'openai', label: 'OpenAI' },
          // The industry term: published weights, whatever the license.
          ...(hasOpenWeights
            ? [{ value: 'open' as const, label: 'Open weights' }]
            : []),
          { value: 'on', label: `On (${selectedCount})` },
        ]}
      />
      {items.length === 0 ? (
        <SearchEmptyState
          testId="ai-gateway-model-empty"
          title={emptyTitle}
          {...(searching && !atCapacity
            ? {
                actionLabel: 'Add it manually',
                actionTestId: 'ai-gateway-model-add-manually',
                onAction: () => onAddManually(deferredQuery.trim()),
              }
            : {})}
        />
      ) : (
        // The list scrolls inside this fixed-height box, so the search
        // and filters above it never scroll away.
        <div
          className={
            layout === 'dialog'
              ? 'flex max-h-75 flex-col'
              : 'flex max-h-90 flex-col'
          }
        >
          <ChoiceList
            ref={scrollRef}
            aria-label="Models"
            data-testid="ai-gateway-model-list"
            onKeyDown={onListKeyDown}
          >
            <div
              className="relative w-full shrink-0"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {renderedRows.map((row) => {
                const item = items[row.index];
                if (!item) return null;
                const sticky = activeSticky === row.index;
                return (
                  <div
                    key={row.key}
                    data-index={row.index}
                    className={joinClassNames(
                      'left-0 top-0 flex w-full flex-col overflow-hidden',
                      sticky ? 'sticky z-10' : 'absolute',
                    )}
                    style={{
                      height: row.size,
                      ...(sticky
                        ? {}
                        : { transform: `translateY(${row.start}px)` }),
                    }}
                  >
                    {item.kind === 'option' ? (
                      <Divider
                        aria-hidden
                        className={
                          items[row.index - 1]?.kind === 'option'
                            ? undefined
                            : 'invisible'
                        }
                      />
                    ) : null}
                    {renderItem(item, row.index)}
                  </div>
                );
              })}
            </div>
          </ChoiceList>
        </div>
      )}
    </div>
  );
});
