import { Stack } from '@canopy/ui-shared/components';
import { type JSX, type ReactNode, useEffect, useMemo, useState } from 'react';
import type {
  PipelineInfo,
  PipelineExecutionScope,
  PipelineTriggerType,
} from '@canopy/execution-engine/types/pipeline';
import { RefreshSpinner } from '../shared/loading/spinners/RefreshSpinner';
import { PageTitlebar } from '../shared/PageTitlebar';
import { WorkflowsPageHeader } from '../workflows/WorkflowsPageHeader';
import { WorkflowsTabPanel } from '../workflows/WorkflowsTabPanel';
import { PageContent } from '../shared/PageContent';
import { PipelineTableRow } from './PipelineTableRow';
import { CreatePipelineSplitButton } from './CreatePipelineSplitButton';
import { PIPELINE_SOURCE_META, PIPELINE_SOURCES } from './pipeline-source-meta';
import { TRIGGER_META, TRIGGER_TYPES } from './pipeline-trigger-meta';
import type { SharedCloudListState } from '../../hooks/usePipelineList';
import type { SharedListFilters } from '../../hooks/useSharedPipelineList';
import { fuzzyMatch } from '@canopy/ui-shared/lib/fuzzy-match';
import { brandText } from '@/lib/brand';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { PIPELINE_EXECUTION_SCOPES } from '@canopy/protocol/pipelines';
import { PIPELINE_EXECUTION_SCOPE_META } from './pipeline-execution-scope-meta';
import { readPipelineInfoScopes } from '@/lib/pipelineExecutionScope';
import { PipelineTemplatesSection, Notice, Tooltip } from '@canopy/ui-shared';
import { useNavigationStore } from '@/stores/navigationStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';

import { useCuratedPipelines } from '../../hooks/useCuratedPipelines';
import {
  curatedPipelineId,
  type PipelineCatalogEntry,
} from './pipeline-catalog-entry';
import type { CuratedPipelineListQuery } from '@canopy/protocol/pipeline-catalog';
import {
  Button,
  BusyLabel,
  DataTableBody,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  EmptyState,
  ErrorBanner,
  SearchField,
  SettingsSelect,
} from '@canopy/ui-shared/components';
import { filterCuratedPipelinesBySearch } from '@canopy/ui-shared/lib';
import { PipelineIcon as AppCatalogPipelineIcon } from '@canopy/ui-shared/icons/AppIcons';

interface PipelineListViewProps {
  pipelines: PipelineInfo[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  /** Opens the manual pipeline builder ("Build manually"). */
  onCreateNew: () => void;
  /**
   * Starts the AI pipeline interview in a new Cowork chat — the main
   * "New pipeline" action (CAN-3487).
   */
  onStartInterview: () => void;
  /** True while the interview chat is being created. */
  interviewPending?: boolean;
  onEdit: (pipeline: PipelineInfo) => void;
  onDelete: (id: string) => Promise<void>;
  onDuplicate: (pipeline: PipelineInfo) => Promise<void>;
  /** Raise a Share request for a row. Omitted when sharing is unavailable. */
  onShare?: (pipeline: PipelineInfo) => void;
  /** Source-qualified `<source>:<id>` of the row whose Share is in flight. */
  sharePendingId?: string | null;
  /**
   * Failure text for a row action that has no row-level place to report —
   * today, a Share whose definition could not be loaded.
   */
  actionError?: string | null;

  /** Pipeline ids the user has disabled (hidden from run pickers). */
  disabledPipelineIds: Set<string>;
  /** Enable or disable a pipeline. */
  onToggleEnabled: (id: string, enabled: boolean) => Promise<void>;

  /**
   * Singleton shared-pipeline state from the configured Canopy Cloud account.
   *
   * The desktop app is bound to exactly one Canopy Cloud backend, so this
   * view renders a single shared section (no tabs, no server names).
   */
  sharedState: SharedCloudListState;
  onSharedActivate: () => void;
  onSharedRefresh: () => Promise<void>;
  onLoadMoreShared: () => Promise<void>;
  onSharedFilterChange: (filters: SharedListFilters) => void;
  onSharedDelete: (remoteId: string) => Promise<void>;
  onOpenAccountSettings: () => void;
  headerAction?: ReactNode;
  onOpenImported?: (id: string) => void;
}

const SOURCE_RANK: Record<PipelineCatalogEntry['source'], number> = {
  user: 0,
  project: 1,
  bundled: 2,
  shared: 3,
  curated: 4,
};

function parseTriggerFilter(value: string): PipelineTriggerType | 'all' {
  switch (value) {
    case 'dispatch':
    case 'plan_ready':
    case 'task_ready':
    case 'workflow':
      return value;
    default:
      return 'all';
  }
}

export function PipelineListView({
  pipelines,
  loading,
  error,
  onRefresh,
  onCreateNew,
  onStartInterview,
  interviewPending = false,
  onEdit,
  onDelete,
  onDuplicate,
  onShare,
  sharePendingId = null,
  actionError = null,
  disabledPipelineIds,
  onToggleEnabled,
  sharedState,
  onSharedActivate,
  onSharedRefresh,
  onLoadMoreShared,
  onSharedFilterChange,
  onSharedDelete,
  onOpenAccountSettings,
  headerAction,
  onOpenImported,
}: PipelineListViewProps): JSX.Element {
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [triggerFilter, setTriggerFilter] = useState<
    PipelineTriggerType | 'all'
  >('all');

  const [scopeFilter, setScopeFilter] = useState<
    PipelineExecutionScope | 'all'
  >('all');

  const cloudReady = isCanopyCloudConnected(sharedState.cloudAccount);
  const showShared = sourceFilter === 'all' || sourceFilter === 'shared';

  const [templateQuery, setTemplateQuery] = useState<CuratedPipelineListQuery>(
    {},
  );
  const curated = useCuratedPipelines({
    ...templateQuery,
    enabled: cloudReady,
    onImported: () => {
      void onRefresh();
    },
    onOpenImported,
  });
  // Templates keep the enable/disable preference the table rows used to own:
  // a disabled template stays hidden from launch pickers until re-enabled.
  const [templateToggling, setTemplateToggling] = useState(false);
  const selectedTemplateId = curated.selectedKey
    ? curatedPipelineId(curated.selectedKey)
    : null;
  const templateAvailability = selectedTemplateId
    ? {
        enabled: !disabledPipelineIds.has(selectedTemplateId),
        pending: templateToggling,
        onChange: (enabled: boolean): void => {
          setTemplateToggling(true);
          void onToggleEnabled(selectedTemplateId, enabled).finally(() =>
            setTemplateToggling(false),
          );
        },
      }
    : undefined;
  // The hook drops `q` from catalog requests and loads every page while a
  // search is set, so the search narrows those complete rows here.
  const templateRows = useMemo(
    () => filterCuratedPipelinesBySearch(curated.rows, templateQuery.q),
    [curated.rows, templateQuery.q],
  );
  useCurrentUiStateReporter(
    'pipelines.curatedPreview',
    curated.selectedKey
      ? {
          open: true,
          key: curated.selectedKey,
          loading: curated.detailLoading === true,
          errorVisible: Boolean(curated.detailError),
        }
      : null,
  );
  const pendingCuratedPipelinePreviewKey = useNavigationStore(
    (state) => state.pendingCuratedPipelinePreviewKey,
  );
  useEffect(() => {
    if (!pendingCuratedPipelinePreviewKey || !cloudReady) return;
    useNavigationStore.getState().consumeCuratedPipelinePreview();
    curated.onSelectKey(pendingCuratedPipelinePreviewKey);
  }, [cloudReady, curated, pendingCuratedPipelinePreviewKey]);

  // Lazy-load the first page the first time the shared rows would be shown.
  useEffect(() => {
    if (!cloudReady || !showShared) return;
    if (sharedState.loaded || sharedState.loading) return;
    onSharedActivate();
  }, [
    cloudReady,
    showShared,
    sharedState.loaded,
    sharedState.loading,
    onSharedActivate,
  ]);

  useEffect(() => {
    if (!showShared) return;
    onSharedFilterChange({
      q: search.trim() || undefined,
      triggerType: triggerFilter === 'all' ? undefined : triggerFilter,
    });
  }, [onSharedFilterChange, search, showShared, triggerFilter]);

  // Combine local pipelines with already-loaded shared rows so search and
  // filters apply uniformly across every source.
  const allPipelines = useMemo<PipelineCatalogEntry[]>(
    () => [
      ...pipelines.filter((pipeline) => pipeline.source !== 'curated'),
      ...sharedState.rows,
    ],
    [pipelines, sharedState.rows],
  );

  const filtered = useMemo<PipelineCatalogEntry[]>(() => {
    const query = search.trim();
    return allPipelines
      .filter((p) => {
        if (sourceFilter !== 'all' && p.source !== sourceFilter) return false;
        if (
          scopeFilter !== 'all' &&
          !readPipelineInfoScopes(p).includes(scopeFilter)
        )
          return false;
        if (
          triggerFilter !== 'all' &&
          p.triggerTypes !== undefined &&
          !p.triggerTypes.some((t) => t === triggerFilter)
        ) {
          return false;
        }
        if (query) {
          const nameMatch = fuzzyMatch(query, p.name) !== null;
          const descMatch = p.description
            ? fuzzyMatch(query, p.description) !== null
            : false;
          if (!nameMatch && !descMatch) return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
          a.name.localeCompare(b.name),
      );
  }, [allPipelines, search, sourceFilter, triggerFilter, scopeFilter]);

  function handleRowDelete(pipeline: PipelineInfo): Promise<void> {
    if (pipeline.source === 'shared') {
      return pipeline.remoteId
        ? onSharedDelete(pipeline.remoteId)
        : Promise.resolve();
    }
    return onDelete(pipeline.id);
  }

  const hasActiveFilters =
    search.trim() !== '' ||
    sourceFilter !== 'all' ||
    triggerFilter !== 'all' ||
    scopeFilter !== 'all';
  // The first page of shared rows is still in flight, so "no pipelines" would
  // be premature.
  const sharedInitialLoading =
    cloudReady && sharedState.loading && sharedState.rows.length === 0;

  const emptyState = filtered.length === 0 &&
    allPipelines.length === 0 &&
    !error &&
    !sharedInitialLoading && (
      <EmptyState
        icon={<AppCatalogPipelineIcon size="xl" className="fg-secondary" />}
        title="No workflows yet"
        subtitle="Create your first workflow to get started"
        action={
          <CreatePipelineSplitButton
            onStartInterview={onStartInterview}
            onBuildManually={onCreateNew}
            interviewPending={interviewPending}
            testIdPrefix="pipeline-empty-create-new"
          />
        }
      />
    );

  return (
    <div
      className="page-scroll-gutter h-full overflow-auto"
      data-testid="page-pipelines"
    >
      <PageTitlebar />
      <PageContent>
        <WorkflowsPageHeader
          actions={
            <>
              {headerAction}
              <Tooltip label="Refresh workflows">
                <Button
                  variant="secondary"
                  size="compact"
                  iconOnly
                  onClick={() => {
                    void onRefresh();
                    void onSharedRefresh();
                    if (cloudReady) curated.onRefresh();
                  }}
                  aria-label="Refresh workflows"
                >
                  <RefreshSpinner spinning={loading} />
                </Button>
              </Tooltip>
              <CreatePipelineSplitButton
                onStartInterview={onStartInterview}
                onBuildManually={onCreateNew}
                interviewPending={interviewPending}
                testIdPrefix="pipeline-create-new"
              />
            </>
          }
        />

        <WorkflowsTabPanel className="flex flex-col pt-4">
          <Stack gap="group">
            {/* Toolbar: search + filters */}
            <div className="flex items-center gap-2 flex-wrap">
              <SearchField
                value={search}
                onValueChange={setSearch}
                placeholder="Search workflows…"
                aria-label="Search workflows"
                data-testid="pipeline-search"
                className="flex-1 min-w-45"
              />
              <SettingsSelect
                width="fit"
                value={sourceFilter}
                onValueChange={setSourceFilter}
                data-testid="pipeline-source-filter"
                aria-label="Filter by source"
                options={[
                  { value: 'all', label: 'All sources' },
                  ...PIPELINE_SOURCES.filter(
                    (source) => source !== 'curated',
                  ).map((source) => ({
                    value: source,
                    label: PIPELINE_SOURCE_META[source].label,
                  })),
                ]}
              />
              <SettingsSelect
                width="fit"
                value={triggerFilter}
                onValueChange={(value) =>
                  setTriggerFilter(parseTriggerFilter(value))
                }
                data-testid="pipeline-trigger-filter"
                aria-label="Filter by trigger type"
                options={[
                  { value: 'all', label: 'All triggers' },
                  ...TRIGGER_TYPES.map((trigger) => ({
                    value: trigger,
                    label: TRIGGER_META[trigger].label,
                  })),
                ]}
              />
            </div>

            <div>
              <SettingsSelect
                width="fit"
                data-testid="pipeline-scope-filter"
                aria-label="Filter by execution scope"
                value={scopeFilter}
                onValueChange={(value) =>
                  setScopeFilter(
                    PIPELINE_EXECUTION_SCOPES.find(
                      (scope) => scope === value,
                    ) ?? 'all',
                  )
                }
                options={[
                  { value: 'all', label: 'All execution scopes' },
                  ...PIPELINE_EXECUTION_SCOPES.map((scope) => ({
                    value: scope,
                    label: PIPELINE_EXECUTION_SCOPE_META[scope].label,
                  })),
                ]}
              />
            </div>
            <Stack gap="section">
              {((loading && filtered.length === 0) || error) && (
                <div>
                  {/* Loading */}
                  {loading && filtered.length === 0 && (
                    <div className="flex items-center justify-center py-16">
                      <p className="text-s fg-secondary">Loading workflows…</p>
                    </div>
                  )}

                  {/* Error */}
                  <ErrorBanner
                    errorSource="pipeline-list"
                    error={error}
                    className=""
                  />
                </div>
              )}

              {actionError && (
                <div data-testid="pipeline-list-action-error">
                  <Notice
                    errorSource="pipeline-list-action"
                    intent="destructive"
                  >
                    {actionError}
                  </Notice>
                </div>
              )}

              {(!loading || filtered.length > 0) && (
                <Stack gap="group">
                  {/* Table */}
                  {filtered.length > 0 && (
                    <DataTableFrame
                      testId="pipelines-table"
                      caption="Workflows"
                      layout="fixed"
                      minWidth="56.25rem"
                    >
                      <DataTableHead>
                        <DataTableHeaderCell>Workflow</DataTableHeaderCell>
                        <DataTableHeaderCell width="8rem">
                          Source
                        </DataTableHeaderCell>
                        <DataTableHeaderCell width="8rem">
                          Scope
                        </DataTableHeaderCell>
                        <DataTableHeaderCell width="7rem">
                          Triggers
                        </DataTableHeaderCell>
                        {/* Fits the widest row: 6 actions (toggle, share link,
                      edit/view, share, duplicate, delete) on a shared row
                      with delete rights =
                      6*26px + 5*2px gap + 24px cell padding = 190px. */}
                        <DataTableHeaderCell width="13rem" align="right">
                          Actions
                        </DataTableHeaderCell>
                      </DataTableHead>
                      <DataTableBody>
                        {filtered.map((p) => (
                          <PipelineTableRow
                            key={`${p.source}:${p.id}`}
                            pipeline={p}
                            enabled={!disabledPipelineIds.has(p.id)}
                            onToggleEnabled={(enabled) =>
                              onToggleEnabled(p.id, enabled)
                            }
                            onEdit={onEdit}
                            onDelete={() => handleRowDelete(p)}
                            onDuplicate={onDuplicate}
                            onShare={onShare}
                            sharePending={
                              sharePendingId === `${p.source}:${p.id}`
                            }
                          />
                        ))}
                      </DataTableBody>
                    </DataTableFrame>
                  )}

                  <div>
                    <div
                      className="flex flex-wrap items-center gap-3 text-xs fg-secondary"
                      data-testid="pipeline-list-status"
                    >
                      <span>
                        {filtered.length} loaded{' '}
                        {filtered.length === 1 ? 'workflow' : 'workflows'}
                      </span>
                    </div>
                    {/* No results from active filters */}
                    {filtered.length === 0 &&
                      allPipelines.length > 0 &&
                      hasActiveFilters &&
                      !sharedInitialLoading && (
                        <p className="py-12 text-center text-s fg-secondary">
                          No workflows match the current filters.
                        </p>
                      )}

                    {!showShared && emptyState}
                  </div>
                  {/* Shared-cloud status + affordances */}
                  {showShared && (
                    <div data-testid="shared-pipelines-section">
                      <Stack gap="inline">
                        {cloudReady && showShared && (
                          <ErrorBanner
                            errorSource="pipeline-list-shared"
                            error={sharedState.error}
                            className=""
                            onRetry={() => void onSharedRefresh()}
                          />
                        )}
                        {cloudReady && showShared && (
                          <div className="flex items-center justify-between gap-2">
                            {sharedState.error ? (
                              <span />
                            ) : sharedState.loading &&
                              sharedState.rows.length === 0 ? (
                              <p className="text-xs fg-secondary">
                                Loading shared workflows…
                              </p>
                            ) : (
                              <span />
                            )}
                            <div className="flex items-center gap-3">
                              {sharedState.nextCursor && (
                                <Button
                                  size="compact"
                                  onClick={() => void onLoadMoreShared()}
                                  disabled={sharedState.loadingMore}
                                >
                                  <BusyLabel busy={sharedState.loadingMore}>
                                    Load more shared
                                  </BusyLabel>
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="compact"
                                onClick={() => void onSharedRefresh()}
                              >
                                Refresh shared
                              </Button>
                            </div>
                          </div>
                        )}
                        {!cloudReady && !sharedState.cloudLoading && (
                          <div className="flex items-center gap-3">
                            <p className="text-xs fg-secondary">
                              No {brandText.appName} Cloud account configured —
                              shared and curated workflows are unavailable.
                            </p>
                            <Button
                              size="compact"
                              onClick={onOpenAccountSettings}
                            >
                              Open account settings
                            </Button>
                          </div>
                        )}
                      </Stack>
                      {emptyState}
                    </div>
                  )}

                  {/* Empty state: no pipelines from any source (and the shared
                first page isn't still loading). */}
                </Stack>
              )}
            </Stack>
          </Stack>
          <PipelineTemplatesSection
            catalog={{
              ...curated,
              // The search box shows the text as typed; the hook requests and
              // filters with the trimmed text.
              query: { ...curated.query, q: templateQuery.q },
              rows: templateRows,
              cloudDisplayName: `${brandText.appName} Cloud`,
              launchAvailability: templateAvailability,
              onQueryChange: setTemplateQuery,
            }}
          />
        </WorkflowsTabPanel>
      </PageContent>
    </div>
  );
}
