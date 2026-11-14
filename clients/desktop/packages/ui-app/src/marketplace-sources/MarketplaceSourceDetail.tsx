'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  MarketplaceSource,
  MarketplaceSourcePlugin,
} from '@canopy/app-core/client';
import {
  BulkInstallButton,
  Button,
  ErrorBanner,
  ErrorState,
  MissingPluginsBadge,
  Notice,
  NoticeButton,
  PluginInstallStatusCell,
  SearchField,
  SettingsSelect,
  Heading,
} from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { MarketplaceDetailPageShell } from '../capability/MarketplaceDetailPageShell';
import { MarketplaceEntityHeader } from '../capability/MarketplaceEntityHeader';
import { MarketplaceSourceInvalidBanner } from './MarketplaceSourceInvalidBanner';
import {
  countSourcePluginsNeedingInstall,
  EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS,
  filterMarketplaceSourcePlugins,
  groupMarketplaceSourcePlugins,
  hasMarketplaceSourcePluginFilters,
  MARKETPLACE_SOURCE_FILTER_NONE,
  marketplaceSourceAuthorOptions,
  marketplaceSourceCategoryOptions,
  marketplaceSourcePluginCountLabel,
  safeMarketplaceSourceUrl,
  sourcePluginNeedsInstall,
  type MarketplaceSourceFacetOptions,
  type MarketplaceSourcePluginFilters,
} from './source-plugins';
import {
  marketplaceSourcePluginErrorKey,
  type UseMarketplaceSourcesResult,
} from './useMarketplaceSources';
import { useMarketplaceSourceBulkInstall } from './useMarketplaceSourceBulkInstall';

export interface MarketplaceSourceDetailProps {
  readonly onBulkStateChange?: (state: {
    running: boolean;
    cancelling: boolean;
    done: number;
    total: number;
  }) => void;
  readonly state: UseMarketplaceSourcesResult;
  readonly sourceId: string;
  readonly onNavigateBack: () => void;
  readonly breadcrumbs?: ReactNode;
  /**
   * Host-owned plugin navigation. Rows are interactive only when this is set
   * and `canOpenPlugin` (if given) resolves a destination.
   */
  readonly onOpenPlugin?: (sourceId: string, pluginKey: string) => void;
  readonly canOpenPlugin?: (sourceId: string, pluginKey: string) => boolean;
  /** Controlled filters let a host keep them across plugin detail visits. */
  readonly filters?: MarketplaceSourcePluginFilters;
  readonly onFiltersChange?: (filters: MarketplaceSourcePluginFilters) => void;
}

export function MarketplaceSourceDetail({
  state,
  sourceId,
  onNavigateBack,
  breadcrumbs,
  onOpenPlugin,
  canOpenPlugin,
  filters: controlledFilters,
  onFiltersChange,
  onBulkStateChange,
}: MarketplaceSourceDetailProps): JSX.Element {
  const source = state.sources?.find((entry) => entry.id === sourceId);

  if (!source) {
    return (
      <MarketplaceDetailPageShell
        title="Marketplace"
        breadcrumbs={breadcrumbs}
        onNavigateBack={onNavigateBack}
      >
        {state.loading ? (
          <p role="status" className="text-s fg-secondary">
            Loading marketplace…
          </p>
        ) : state.sources === null && state.listError ? (
          <ErrorState
            message={
              <span className={REPLAY_MASK_CLASS}>{state.listError}</span>
            }
            onRetry={() => void state.reload()}
          />
        ) : (
          <div
            className="flex flex-col items-start gap-3"
            data-testid="marketplace-source-unavailable"
          >
            <p className="text-s fg-secondary">
              This marketplace is no longer available.
            </p>
            <Button size="compact" variant="secondary" onClick={onNavigateBack}>
              Back to marketplaces
            </Button>
          </div>
        )}
      </MarketplaceDetailPageShell>
    );
  }

  return (
    <MarketplaceSourceDetailBody
      key={source.id}
      source={source}
      state={state}
      onNavigateBack={onNavigateBack}
      breadcrumbs={breadcrumbs}
      onOpenPlugin={onOpenPlugin}
      canOpenPlugin={canOpenPlugin}
      controlledFilters={controlledFilters}
      onFiltersChange={onFiltersChange}
      onBulkStateChange={onBulkStateChange}
    />
  );
}

interface MarketplaceSourceDetailBodyProps {
  readonly onBulkStateChange?: MarketplaceSourceDetailProps['onBulkStateChange'];
  readonly source: MarketplaceSource;
  readonly state: UseMarketplaceSourcesResult;
  readonly onNavigateBack: () => void;
  readonly breadcrumbs?: ReactNode;
  readonly onOpenPlugin?: (sourceId: string, pluginKey: string) => void;
  readonly canOpenPlugin?: (sourceId: string, pluginKey: string) => boolean;
  readonly controlledFilters?: MarketplaceSourcePluginFilters;
  readonly onFiltersChange?: (filters: MarketplaceSourcePluginFilters) => void;
}

function MarketplaceSourceDetailBody({
  source,
  state,
  onNavigateBack,
  breadcrumbs,
  onOpenPlugin,
  canOpenPlugin,
  controlledFilters,
  onFiltersChange,
  onBulkStateChange,
}: MarketplaceSourceDetailBodyProps): JSX.Element {
  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    detailRef.current?.focus();
  }, [source.id]);
  const [localFilters, setLocalFilters] = useState(
    EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS,
  );
  const filters = controlledFilters ?? localFilters;
  const setFilters = useCallback(
    (next: MarketplaceSourcePluginFilters) => {
      setLocalFilters(next);
      onFiltersChange?.(next);
    },
    [onFiltersChange],
  );

  const canInstall = state.canInstall;
  const filtered = useMemo(
    () => filterMarketplaceSourcePlugins(source.plugins, filters),
    [filters, source.plugins],
  );
  const groups = useMemo(
    () => groupMarketplaceSourcePlugins(filtered),
    [filtered],
  );
  const categories = useMemo(
    () => marketplaceSourceCategoryOptions(source.plugins),
    [source.plugins],
  );
  const authors = useMemo(
    () => marketplaceSourceAuthorOptions(source.plugins),
    [source.plugins],
  );
  const missingCount = canInstall
    ? countSourcePluginsNeedingInstall(source)
    : 0;
  const filteredMissingKeys = useMemo(
    () =>
      canInstall
        ? [...groups.recommended, ...groups.others]
            .filter(sourcePluginNeedsInstall)
            .map((plugin) => plugin.key)
        : [],
    [canInstall, groups],
  );
  const filtering = hasMarketplaceSourcePluginFilters(filters);

  const pluginsByKey = useMemo(
    () => new Map(source.plugins.map((plugin) => [plugin.key, plugin])),
    [source.plugins],
  );
  const bulk = useMarketplaceSourceBulkInstall({
    sourceId: source.id,
    enabled: canInstall,
    canStart: (): boolean =>
      state.operations[source.id] === undefined && !state.refreshing,
    installPlugin: state.installPlugin,
    stillNeedsInstall: (key): boolean => {
      const plugin = pluginsByKey.get(key);
      return plugin !== undefined && sourcePluginNeedsInstall(plugin);
    },
  });

  useEffect(() => {
    onBulkStateChange?.({
      running: bulk.running,
      cancelling: bulk.cancelling,
      done: bulk.progress?.done ?? 0,
      total: bulk.progress?.total ?? 0,
    });
  }, [bulk.running, bulk.cancelling, bulk.progress, onBulkStateChange]);
  useEffect(
    () => (): void =>
      onBulkStateChange?.({
        running: false,
        cancelling: false,
        done: 0,
        total: 0,
      }),
    [onBulkStateChange],
  );

  const operation = state.operations[source.id];
  const installingKey = state.installingPlugins[source.id];
  const sourceBusy = operation !== undefined && operation !== 'install';
  const sourceUrl = safeMarketplaceSourceUrl(source.sourceUrl);
  const isInteractive = (plugin: MarketplaceSourcePlugin): boolean =>
    onOpenPlugin !== undefined &&
    (canOpenPlugin?.(source.id, plugin.key) ?? true);

  const renderPlugin = (plugin: MarketplaceSourcePlugin): JSX.Element => {
    const errorKey = marketplaceSourcePluginErrorKey(source.id, plugin.key);
    const label = (
      <>
        <span
          className={`block truncate text-s fg-primary ${REPLAY_MASK_CLASS}`}
        >
          {plugin.name}
        </span>
        {plugin.description && (
          <span
            className={`mt-0.5 line-clamp-2 block text-xs fg-secondary ${REPLAY_MASK_CLASS}`}
          >
            {plugin.description}
          </span>
        )}
        {(plugin.version || plugin.author) && (
          <span
            className={`mt-0.5 block text-3xs fg-tertiary ${REPLAY_MASK_CLASS}`}
          >
            {[plugin.version && `v${plugin.version}`, plugin.author]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </>
    );
    return (
      <li
        key={plugin.key}
        className="flex items-start justify-between gap-3 py-2"
        data-testid="marketplace-source-plugin"
        data-plugin-key={plugin.key}
      >
        {isInteractive(plugin) ? (
          <button
            type="button"
            className="focus-ring min-w-0 flex-1 rounded text-left"
            onClick={() => onOpenPlugin?.(source.id, plugin.key)}
          >
            {label}
          </button>
        ) : (
          <div className="min-w-0 flex-1">{label}</div>
        )}
        {canInstall && plugin.installState && (
          <PluginInstallStatusCell
            pluginName={plugin.key}
            needsInstall={sourcePluginNeedsInstall(plugin)}
            installing={installingKey === plugin.key}
            disabled={operation !== undefined || bulk.running}
            error={state.pluginErrors[errorKey]}
            onInstall={() => void state.installPlugin(source.id, plugin.key)}
          />
        )}
        {state.pluginErrors[errorKey] && (
          <Notice
            errorSource="marketplace-source-detail"
            intent="destructive"
            actions={
              <NoticeButton onClick={() => void state.reload()}>
                Refresh status
              </NoticeButton>
            }
          >
            <span className={REPLAY_MASK_CLASS}>
              {state.pluginErrors[errorKey]}
            </span>
          </Notice>
        )}
      </li>
    );
  };

  return (
    <MarketplaceDetailPageShell
      title={source.name}
      privateTitle
      breadcrumbs={breadcrumbs}
      onNavigateBack={onNavigateBack}
      contentOwnsTitle
    >
      <div
        ref={detailRef}
        tabIndex={-1}
        className="flex flex-col gap-6 outline-none"
        data-testid="marketplace-source-detail"
      >
        <MarketplaceEntityHeader
          privateName
          name={source.name}
          meta={
            <>
              <span className={REPLAY_MASK_CLASS}>
                {sourceUrl ? (
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline-offset-2 hover:underline"
                  >
                    {source.sourceLabel}
                  </a>
                ) : (
                  source.sourceLabel
                )}
              </span>
              {' · '}
              {marketplaceSourcePluginCountLabel(source.pluginCount)}
            </>
          }
        >
          {source.description && (
            <p className={`mt-2 text-s fg-secondary ${REPLAY_MASK_CLASS}`}>
              {source.description}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <MissingPluginsBadge
              count={missingCount}
              testId="marketplace-source-detail-missing-count"
            />
            {source.actions.update && (
              <Button
                size="compact"
                variant="secondary"
                disabled={operation !== undefined || bulk.running}
                onClick={() => void state.update(source.id)}
              >
                {operation === 'update' ? 'Updating…' : 'Update'}
              </Button>
            )}
          </div>
        </MarketplaceEntityHeader>

        <MarketplaceSourceInvalidBanner source={source} state={state} />
        {state.sourceErrors[source.id] ? (
          <ErrorBanner
            errorSource="marketplace-source-detail-body"
            className=""
            error={state.sourceErrors[source.id]}
            blockMessageFromReplay
            onRetry={() => void state.reload()}
            retryLabel="Refresh status"
          />
        ) : state.sourceWarnings[source.id] ? (
          <Notice
            intent="attention"
            actions={
              <NoticeButton onClick={() => void state.reload()}>
                Refresh status
              </NoticeButton>
            }
          >
            <span className={REPLAY_MASK_CLASS}>
              {state.sourceWarnings[source.id]}
            </span>
          </Notice>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            value={filters.query}
            onValueChange={(query) => setFilters({ ...filters, query })}
            placeholder="Search plugins"
            aria-label="Search plugins"
            data-testid="marketplace-source-search"
            className="min-w-48 flex-1"
          />
          <FacetSelect
            label="Category"
            allLabel="All categories"
            options={categories}
            value={filters.category}
            onChange={(category) => setFilters({ ...filters, category })}
          />
          <FacetSelect
            label="Author"
            allLabel="All authors"
            options={authors}
            value={filters.author}
            onChange={(author) => setFilters({ ...filters, author })}
          />
          {canInstall && (
            <BulkInstallButton
              disabled={
                !bulk.running && (operation !== undefined || state.refreshing)
              }
              missingCount={filteredMissingKeys.length}
              installing={bulk.running}
              progress={bulk.progress}
              summary={bulk.summary}
              onClick={() =>
                bulk.running ? bulk.cancel() : bulk.start(filteredMissingKeys)
              }
            />
          )}
        </div>
        {canInstall && filtering && filteredMissingKeys.length > 0 && (
          <p className="-mt-4 text-3xs fg-tertiary">
            Install applies to the {filteredMissingKeys.length} matching{' '}
            {filteredMissingKeys.length === 1 ? 'plugin' : 'plugins'}.
          </p>
        )}

        {source.plugins.length === 0 ? (
          <p
            className="text-s fg-secondary"
            data-testid="marketplace-source-no-plugins"
          >
            This marketplace has no plugins.
          </p>
        ) : filtered.length === 0 ? (
          <div
            className="flex flex-col items-start gap-2"
            data-testid="marketplace-source-no-matches"
          >
            <p className="text-s fg-secondary">
              No plugins match your filters.
            </p>
            <Button
              size="compact"
              variant="ghost"
              onClick={() =>
                setFilters(EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS)
              }
            >
              Clear filters
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4" aria-busy={sourceBusy}>
            {groups.recommended.length > 0 && (
              <section aria-labelledby="marketplace-source-recommended">
                <Heading
                  level={2}
                  variant="label"
                  id="marketplace-source-recommended"
                >
                  Recommended ({groups.recommended.length})
                </Heading>
                <ul className="divide-y">
                  {groups.recommended.map(renderPlugin)}
                </ul>
              </section>
            )}
            {groups.others.length > 0 && (
              <section aria-labelledby="marketplace-source-all-plugins">
                <Heading
                  level={2}
                  variant="label"
                  id="marketplace-source-all-plugins"
                >
                  {groups.recommended.length > 0 ? 'More plugins' : 'Plugins'} (
                  {groups.others.length})
                </Heading>
                <ul className="divide-y">{groups.others.map(renderPlugin)}</ul>
              </section>
            )}
          </div>
        )}
      </div>
    </MarketplaceDetailPageShell>
  );
}

interface FacetSelectProps {
  readonly label: string;
  readonly allLabel: string;
  readonly options: MarketplaceSourceFacetOptions;
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}

function FacetSelect({
  label,
  allLabel,
  options,
  value,
  onChange,
}: FacetSelectProps): JSX.Element | null {
  if (options.values.length === 0) return null;
  return (
    <SettingsSelect
      aria-label={label}
      width="fit"
      value={value ?? ''}
      onValueChange={(next) => onChange(next === '' ? null : next)}
      options={[
        { value: '', label: allLabel },
        ...(options.hasNone
          ? [{ value: MARKETPLACE_SOURCE_FILTER_NONE, label: 'None' }]
          : []),
        ...options.values.map((option) => ({ value: option, label: option })),
      ]}
    />
  );
}
