'use client';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type JSX,
} from 'react';
import {
  Stack,
  Button,
  CenteredLoadingSpinner,
  CopyDetailsButton,
  DelayedLoadingPlaceholder,
  EmptyState,
  ErrorBanner,
  ErrorState,
  Heading,
  Notice,
  SearchEmptyState,
  SearchField,
  SettingsSelect,
  type SettingsSelectOption,
  TextInput,
} from '@canopy/ui-shared/components';
import { RefreshCw } from '@canopy/ui-shared/icons/AppIcons';
import type {
  ExplorerEntityGraph,
  ExplorerFactDetail,
  ExplorerGraphNode,
  ExplorerRetrievalPreview,
} from '@canopy/protocol/settings/organization-memory';
import { withPrivacyClass } from '../account/privacy-class';
import { SETTINGS_LOAD_ERROR_COPY } from '../errors';
import {
  useSettingsClient,
  useSettingsPathname,
  useSettingsPrivacy,
  useSettingsRouter,
  useSettingsSearchParams,
} from '../host';
import { fetchMemoryFactsBatch, fetchMemoryGraph } from './api';
import {
  ENTITY_KIND_COLOR_VARIABLES,
  type EntityGraphKind,
} from './entity-graph-palette';
import { FactCard } from './FactCard';
import { FactCardsSkeleton } from './FactCardsSkeleton';
import { GraphRetrievalPanel } from './GraphRetrievalPanel';
import { useMemoryErrorCopy } from './memory-error-copy';
import {
  countHiddenHighlightEntities,
  deriveRetrievalHighlight,
  entityGraphCacheKey,
  entityGraphFilterSearch,
  hasActiveEntityGraphFilters,
  parseEntityGraphFilters,
  sameEntityGraphFilters,
  sameIdSet,
  type EntityGraphFilters,
  type EntityGraphLiveness,
} from './graph-helpers';
import type { SettingsFailure } from '../errors';
import { Surface } from '@canopy/ui-shared/components';

// Matches MAX_FACT_DETAIL_BATCH on the facts/batch route.
const MAX_SELECTED_FACTS = 25;

const LIVENESS_OPTIONS: readonly SettingsSelectOption<EntityGraphLiveness>[] = [
  { value: 'live', label: 'Live' },
  { value: 'superseded', label: 'Superseded' },
  { value: 'all', label: 'All' },
];

/** The legend over the graph: a swatch of each kind's node color. */
const ENTITY_GRAPH_LEGEND: readonly {
  readonly kind: EntityGraphKind;
  readonly label: string;
}[] = [
  { kind: 'service', label: 'Service' },
  { kind: 'code', label: 'Code' },
  { kind: 'tool', label: 'Tool' },
];

// The graph area fills the space below the page header instead of a fixed
// 650px band; the floor keeps it usable in short windows. Shared by the graph
// section, the facts sidebar, and the loading/empty placeholders so the layout
// doesn't jump between states.
//
// `AppSidebarShell` makes its right-hand scrollport a size query container, so
// `cqh` measures the ACTUAL content region after the optional trial banner and
// mobile fallback header have taken their space. Viewport units are wrong here:
// the graph no longer lives directly in the viewport, and using `dvh` can make
// it overflow the inner scrollport or reserve space for chrome that is not in
// that region. The offset accounts for this page's own heading, tabs, gaps, and
// vertical gutters; the floor keeps the canvas usable in a short window.
const GRAPH_AREA_HEIGHT = 'h-[max(560px,calc(100cqh-9rem))]';

// The canvas force graph needs `window`: it loads in its own chunk and mounts
// only on the client (the server render and hydration show the loading state).
const EntityForceGraph = lazy(() =>
  import('./EntityForceGraph').then((mod) => ({
    default: mod.EntityForceGraph,
  })),
);

/**
 * Holds the canvas while its chunk loads. A spinner, not a skeleton: the graph
 * is drawn on a canvas, so there is nothing to measure.
 */
function GraphLoading(): JSX.Element {
  return (
    <div className="flex h-full p-3">
      <DelayedLoadingPlaceholder>
        <CenteredLoadingSpinner />
      </DelayedLoadingPlaceholder>
    </div>
  );
}

function subscribeToNothing(): () => void {
  return () => undefined;
}

/** `false` on the server and during hydration, `true` once on the client. */
function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}

// Graph payloads are expensive to recompute server-side, so cache them per
// organization + filter signature for the lifetime of the client session. Tab
// switches are client-side navigations, which keeps this module (and the
// cache) alive; the Refresh button invalidates only the current key and full
// page loads fetch fresh data. The payload still only ever comes from the
// authz-checked graph API route.
const graphCache = new Map<string, ExplorerEntityGraph>();

interface EntityGraphViewProps {
  orgId: string;
}

export function EntityGraphView({ orgId }: EntityGraphViewProps): JSX.Element {
  const client = useSettingsClient();
  const router = useSettingsRouter();
  const pathname = useSettingsPathname();
  const searchParams = useSettingsSearchParams();
  const { blockClassName } = useSettingsPrivacy();
  const isClient = useIsClient();
  const errorCopy = useMemoryErrorCopy();
  // Filters live in the URL search params so they survive reload and are
  // shareable. They are read once on mount; the URL is then kept in sync with
  // a router replace, which leaves this component (and its state) mounted.
  const [filters, setFilters] = useState<EntityGraphFilters>(() =>
    parseEntityGraphFilters(searchParams),
  );
  const [queryInput, setQueryInput] = useState(() => filters.q);
  const [graph, setGraph] = useState<ExplorerEntityGraph | null>(
    () => graphCache.get(entityGraphCacheKey(orgId, filters)) ?? null,
  );
  const [graphError, setGraphError] = useState<SettingsFailure | null>(null);
  // The failure Try again is reading past: it stays on screen, its capsule
  // spinning, until the read settles, instead of blanking to the skeleton.
  const [retriedGraphError, setRetriedGraphError] = useState<string | null>(
    null,
  );
  const [graphLoading, setGraphLoading] = useState(() => graph === null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selectionTitle, setSelectionTitle] = useState('Select a node or edge');
  const [selectedFactIds, setSelectedFactIds] = useState<string[]>([]);
  const [selectedFacts, setSelectedFacts] = useState<ExplorerFactDetail[]>([]);
  const [selectedFactsError, setSelectedFactsError] =
    useState<SettingsFailure | null>(null);
  // Bumped by the facts sidebar's Retry to read the same selection again.
  const [selectedFactsRetry, setSelectedFactsRetry] = useState(0);
  const [preview, setPreview] = useState<ExplorerRetrievalPreview | null>(null);
  const graphRequestRef = useRef(0);
  const selectedFactIdsRef = useRef<string[]>([]);

  useEffect(() => {
    // Claim a fresh sequence number so any in-flight fetch (earlier filter
    // change or refresh) is superseded the moment this one starts.
    const requestId = graphRequestRef.current + 1;
    graphRequestRef.current = requestId;
    const key = entityGraphCacheKey(orgId, filters);
    const load = async (): Promise<void> => {
      const cached = graphCache.get(key);
      if (cached !== undefined) {
        setGraph(cached);
        setGraphError(null);
        setGraphLoading(false);
        setRetriedGraphError(null);
        return;
      }
      setGraphLoading(true);
      setGraphError(null);
      try {
        // Defaults are omitted, matching the shareable URL search.
        const payload = await fetchMemoryGraph(client, {
          organizationId: orgId,
          liveness: filters.liveness === 'live' ? undefined : filters.liveness,
          from: filters.from.length > 0 ? filters.from : undefined,
          to: filters.to.length > 0 ? filters.to : undefined,
          q: filters.q.length > 0 ? filters.q : undefined,
        });
        if (graphRequestRef.current !== requestId) return;
        graphCache.set(key, payload);
        setGraph(payload);
        setGraphError(null);
      } catch (caught) {
        if (graphRequestRef.current !== requestId) return;
        setGraphError(errorCopy.loadFailure(caught));
      } finally {
        if (graphRequestRef.current === requestId) {
          setGraphLoading(false);
          setRetriedGraphError(null);
        }
      }
    };
    void load();
  }, [client, errorCopy, orgId, filters, refreshVersion]);

  const applyFilters = useCallback(
    (next: EntityGraphFilters): void => {
      setFilters((current) =>
        sameEntityGraphFilters(current, next) ? current : next,
      );
      // URL sync: preserve any unrelated params, replace only ours.
      const params = new URLSearchParams(searchParams.toString());
      for (const name of ['liveness', 'from', 'to', 'q']) {
        params.delete(name);
      }
      for (const [name, value] of new URLSearchParams(
        entityGraphFilterSearch(next),
      )) {
        params.set(name, value);
      }
      const search = params.toString();
      router.replace(search.length > 0 ? `${pathname}?${search}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  const clearSelection = useCallback((): void => {
    setSelectionTitle('Select a node or edge');
    selectedFactIdsRef.current = [];
    setSelectedFactIds([]);
    setSelectedFacts([]);
    setSelectedFactsError(null);
  }, []);

  const handleRefresh = useCallback((): void => {
    graphCache.delete(entityGraphCacheKey(orgId, filters));
    clearSelection();
    setRefreshVersion((version) => version + 1);
  }, [orgId, filters, clearSelection]);

  // Re-clicking the same node/edge (same fact-id set) keeps the loaded facts
  // instead of clearing and refetching the batch.
  const applySelection = useCallback(
    (title: string, factIds: readonly string[]): void => {
      setSelectionTitle(title);
      if (sameIdSet(selectedFactIdsRef.current, factIds)) {
        return;
      }
      selectedFactIdsRef.current = [...factIds];
      setSelectedFacts([]);
      setSelectedFactsError(null);
      setSelectedFactIds([...factIds]);
    },
    [],
  );

  const handleSelectNode = useCallback(
    (node: ExplorerGraphNode): void => {
      applySelection(
        `${node.canonicalName} · ${node.factCount} facts`,
        node.factIds,
      );
    },
    [applySelection],
  );

  const handleSelectEdge = useCallback(
    (sourceName: string, targetName: string, factIds: string[]): void => {
      applySelection(`${sourceName} ↔ ${targetName}`, factIds);
    },
    [applySelection],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const ids = selectedFactIds.slice(0, MAX_SELECTED_FACTS);
      try {
        const payload = await fetchMemoryFactsBatch(client, orgId, ids);
        if (cancelled) return;
        setSelectedFacts(payload.facts);
        if (payload.facts.length === 0) {
          setSelectedFactsError({ copy: 'Unable to load facts' });
        } else if (payload.facts.length < ids.length) {
          setSelectedFactsError({ copy: 'Some facts could not be loaded' });
        } else {
          setSelectedFactsError(null);
        }
      } catch (caught) {
        if (cancelled) return;
        setSelectedFactsError(errorCopy.loadFailure(caught));
      }
    };
    // Clearing stale facts happens in the click handlers (setState in an
    // effect body triggers cascading renders and is linted against).
    if (selectedFactIds.length > 0) {
      void load();
    }
    return (): void => {
      cancelled = true;
    };
  }, [client, errorCopy, orgId, selectedFactIds, selectedFactsRetry]);

  const retrySelectedFacts = useCallback((): void => {
    setSelectedFacts([]);
    setSelectedFactsError(null);
    setSelectedFactsRetry((attempt) => attempt + 1);
  }, []);

  const highlight = useMemo(
    () => (preview === null ? null : deriveRetrievalHighlight(preview)),
    [preview],
  );

  const hiddenEntityCount = useMemo(() => {
    if (highlight === null || graph === null) return 0;
    return countHiddenHighlightEntities(
      highlight,
      new Set(graph.nodes.map((node) => node.id)),
    );
  }, [highlight, graph]);

  const onLivenessChange = (value: string): void => {
    const liveness: EntityGraphLiveness =
      value === 'superseded' || value === 'all' ? value : 'live';
    applyFilters({ ...filters, liveness });
  };

  const submitQuery = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    applyFilters({ ...filters, q: queryInput.trim() });
  };

  const onQueryChange = (value: string): void => {
    setQueryInput(value);
    // Clearing the input immediately drops the name filter without requiring
    // another submit; non-empty edits still wait for one.
    if (value.trim().length === 0 && filters.q.length > 0) {
      applyFilters({ ...filters, q: '' });
    }
  };

  const filtersActive = hasActiveEntityGraphFilters(filters);

  return (
    <Stack gap="group">
      <Surface gap="item" variant="card" padding="default">
        <form onSubmit={submitQuery} className="flex gap-2">
          <SearchField
            value={queryInput}
            onValueChange={onQueryChange}
            placeholder="Filter entities by name"
            aria-label="Filter entities by name"
            className="min-w-0 flex-1"
          />
          <Button
            type="submit"
            size="compact"
            disabled={graphLoading || queryInput.trim() === filters.q}
            className="self-center"
          >
            Filter
          </Button>
        </form>
        <div className="grid gap-2 sm:grid-cols-3">
          <SettingsSelect
            value={filters.liveness}
            onValueChange={onLivenessChange}
            width="fill"
            aria-label="Fact liveness"
            options={LIVENESS_OPTIONS}
          />
          <TextInput
            density="settings"
            type="date"
            value={filters.from}
            onChange={(event) =>
              applyFilters({ ...filters, from: event.target.value })
            }
            aria-label="Facts created from"
          />
          <TextInput
            density="settings"
            type="date"
            value={filters.to}
            onChange={(event) =>
              applyFilters({ ...filters, to: event.target.value })
            }
            aria-label="Facts created to"
          />
        </div>
      </Surface>

      <GraphRetrievalPanel
        orgId={orgId}
        preview={preview}
        hiddenEntityCount={hiddenEntityCount}
        onPreview={setPreview}
      />

      {/* The graph === null fallback card below already shows the error, so
          this alert only covers failures while a graph is on screen. */}
      {graph !== null && (
        <ErrorBanner
          errorSource="entity-graph"
          className=""
          error={graphError?.copy}
          details={graphError?.details}
          onRetry={handleRefresh}
        />
      )}

      {graph === null && graphLoading && retriedGraphError === null ? (
        <div className={`flex ${GRAPH_AREA_HEIGHT}`}>
          <DelayedLoadingPlaceholder>
            <CenteredLoadingSpinner />
          </DelayedLoadingPlaceholder>
        </div>
      ) : graph === null ? (
        <div
          className={`flex ${GRAPH_AREA_HEIGHT} items-center justify-center`}
        >
          <ErrorState
            testId="memory-graph-load-failed"
            message={
              graphError?.copy ?? retriedGraphError ?? SETTINGS_LOAD_ERROR_COPY
            }
            retrying={graphLoading}
            onRetry={(): void => {
              setRetriedGraphError(
                graphError?.copy ?? SETTINGS_LOAD_ERROR_COPY,
              );
              handleRefresh();
            }}
          />
        </div>
      ) : graph.nodes.length === 0 ? (
        filtersActive ? (
          <SearchEmptyState title="No entities match the current filters. Adjust or clear them to see the graph." />
        ) : (
          <EmptyState
            title="No entities yet"
            subtitle="Run entity backfill to populate the organization graph."
            action={
              <Button
                size="compact"
                onClick={handleRefresh}
                disabled={graphLoading}
              >
                <RefreshCw size={14} />
                Refresh
              </Button>
            }
          />
        )
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,24rem)]">
          <Surface variant="card" className="overflow-hidden">
            <section className={`relative ${GRAPH_AREA_HEIGHT}`}>
              <div className="absolute left-4 top-4 z-10 flex flex-wrap items-center gap-3 rounded-lg border bg-card/90 px-3 py-2 text-xs fg-secondary backdrop-blur">
                {ENTITY_GRAPH_LEGEND.map(({ kind, label }) => (
                  <span key={kind}>
                    <i
                      className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full"
                      style={{
                        background: `var(${ENTITY_KIND_COLOR_VARIABLES[kind]})`,
                      }}
                    />
                    {label}
                  </span>
                ))}
                {graph.truncated && (
                  <span className="fg-tertiary">
                    Truncated — showing the most connected activity
                  </span>
                )}
                <Button
                  size="compact"
                  onClick={handleRefresh}
                  disabled={graphLoading}
                  aria-label="Refresh graph"
                >
                  <RefreshCw
                    size={14}
                    className={graphLoading ? 'animate-spin' : ''}
                  />
                  Refresh
                </Button>
              </div>
              {/* The canvas paints entity names. */}
              <div
                className={withPrivacyClass('h-full w-full', blockClassName)}
              >
                {isClient ? (
                  <Suspense fallback={<GraphLoading />}>
                    <EntityForceGraph
                      graph={graph}
                      onSelectNode={handleSelectNode}
                      onSelectEdge={handleSelectEdge}
                      highlight={highlight}
                    />
                  </Suspense>
                ) : (
                  <GraphLoading />
                )}
              </div>
            </section>
          </Surface>
          <Surface variant="card" className="overflow-hidden">
            <aside className={`${GRAPH_AREA_HEIGHT} overflow-y-auto p-4`}>
              <Heading level={2} variant="section">
                <span
                  className={blockClassName === '' ? undefined : blockClassName}
                >
                  {selectionTitle}
                </span>
              </Heading>
              {selectedFactIds.length === 0 ? (
                <p className="mt-2 text-s fg-secondary">
                  Click an entity or connection to inspect its facts. Drag to
                  rearrange, scroll to zoom, hover to highlight neighbors.
                </p>
              ) : selectedFactsError !== null && selectedFacts.length === 0 ? (
                <ErrorBanner
                  errorSource="entity-graph-selected-facts"
                  className="mt-4"
                  error={selectedFactsError?.copy}
                  details={selectedFactsError?.details}
                  onRetry={retrySelectedFacts}
                />
              ) : selectedFacts.length === 0 ? (
                <DelayedLoadingPlaceholder className="mt-4">
                  <FactCardsSkeleton layout="column" />
                </DelayedLoadingPlaceholder>
              ) : (
                <Stack gap="item" className="mt-4">
                  {selectedFactsError !== null && (
                    <Notice
                      intent="attention"
                      actions={
                        selectedFactsError.details !== undefined ? (
                          <CopyDetailsButton
                            details={selectedFactsError.details}
                          />
                        ) : undefined
                      }
                    >
                      {selectedFactsError.copy}
                    </Notice>
                  )}
                  {selectedFacts.map((fact) => (
                    <FactCard key={fact.id} fact={fact} />
                  ))}
                </Stack>
              )}
            </aside>
          </Surface>
        </div>
      )}
    </Stack>
  );
}
