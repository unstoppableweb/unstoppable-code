'use client';

import { Badge, type BadgeTone } from '@canopy/ui-shared/components/Badge';
import { SettingsChartLoading } from '../../pages/loading-skeletons';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type JSX,
} from 'react';
import { SlidersHorizontal } from '@canopy/ui-shared/icons/AppIcons';
import {
  Button,
  DelayedLoadingPlaceholder,
  Dot,
  ErrorBanner,
  Fact,
  FactList,
  FormField,
  SegmentedControl,
  SettingsSelect,
  TabBar,
  type SegmentedControlOption,
  Heading,
  DataTable,
  Popover,
  type DataTableColumn,
  type DataTableColumnGroup,
} from '@canopy/ui-shared/components';
import { getTelemetryToolCategoryLabel } from '@canopy/ui-shared/lib/telemetry-tool-category';
import { formatImpactScore } from '@canopy/ui-shared/lib';
import { classifyPipelineType } from '@canopy/protocol/telemetry';
import type {
  PipelineUsageType,
  SubscriptionPlanUsageRow,
  TelemetryTimeGranularity,
  TelemetryUserLeaderboardRow,
  TeamUsageResponse,
} from '@canopy/protocol/telemetry';
import type {
  OrganizationMember,
  OrganizationSubTeam,
} from '@canopy/protocol/settings/organization';
import {
  SettingsLink,
  useSettingsClient,
  useSettingsPathname,
  useSettingsPrivacy,
  useSettingsRouter,
  useSettingsSearchParams,
} from '../../host';
import { fetchTeamUsage } from '../team-api';
import { useSettingsLoadFailure } from '../../errors';
import {
  STATISTICS_ERROR_SCOPE,
  USAGE_KNOWN_LOAD_ERRORS,
} from './usage-error-copy';
import { useViewerDataSharing } from '../use-viewer-data-sharing';
import { OrganizationDataSharingOptIn } from '../web-data-sharing-opt-in';
import type {
  CategoryBarChart as CategoryBarChartComponent,
  CategoryDatum,
  StackedTimeSeriesChart as StackedTimeSeriesChartComponent,
} from '../../../charts/charts';
import { categoryBarChartHeight } from '../../../charts/chart-layout';
import { memberProfileHref } from '../profile-links';
import { formatProviderLabel } from './run-display';
import { HeadlineCards } from './HeadlineCards';
import { RoutingBacktestCard } from './RoutingBacktestCard';
import {
  costBucketTotal,
  formatCount,
  formatDuration,
  formatImpact,
  formatPercent,
  formatRate,
  formatTokens,
  formatUsd,
  impactBucketTotal,
  pivotBuckets,
  tokenBucketTotal,
} from './format';
import type { SettingsFailure } from '../../errors';
import { Surface } from '@canopy/ui-shared/components';

// recharts loads with the chart chunk, after the statistics shell renders.
const LazyStackedTimeSeriesChart = lazy(() =>
  import('../../../charts/charts').then((module) => ({
    default: module.StackedTimeSeriesChart,
  })),
);
const LazyCategoryBarChart = lazy(() =>
  import('../../../charts/charts').then((module) => ({
    default: module.CategoryBarChart,
  })),
);

/** Join class names, dropping empty ones so no stray whitespace remains. */
function cx(...classNames: ReadonlyArray<string | undefined>): string {
  return classNames.filter(Boolean).join(' ');
}

/**
 * Stacked time-series chart behind a lazy chunk. The fallback keeps the
 * chart's geometry (the empty state's `h-48`, otherwise `h-72`).
 */
function StackedTimeSeriesChart(
  props: ComponentProps<typeof StackedTimeSeriesChartComponent>,
): JSX.Element {
  const empty =
    props.series.rows.length === 0 || props.series.keys.length === 0;
  return (
    <Suspense
      fallback={
        <div
          aria-hidden="true"
          className={empty ? 'h-48 w-full' : 'h-72 w-full'}
          data-testid="chart-loading"
        />
      }
    >
      <LazyStackedTimeSeriesChart {...props} />
    </Suspense>
  );
}

/** Category bar chart behind a lazy chunk, with a same-height fallback. */
function CategoryBarChart(
  props: ComponentProps<typeof CategoryBarChartComponent>,
): JSX.Element {
  return (
    <Suspense
      fallback={
        <div
          aria-hidden="true"
          className={props.data.length === 0 ? 'h-48 w-full' : 'w-full'}
          style={
            props.data.length === 0
              ? undefined
              : { height: categoryBarChartHeight(props.data.length) }
          }
          data-testid="chart-loading"
        />
      }
    >
      <LazyCategoryBarChart {...props} />
    </Suspense>
  );
}

interface TeamStatisticsSectionProps {
  orgId: string;
  /** Org display name for the People tab's data-sharing hint. */
  organizationName: string;
  /** Session identity supplied by the page; invalidates viewer evidence. */
  viewerIdentity?: string;
  /** Server-derived from the request user agent; mobile gets text guidance. */
  mobileBrowser: boolean;
  subTeams: readonly OrganizationSubTeam[];
  members: readonly OrganizationMember[];
  /**
   * The org is the viewer's personal organization. Its statistics are the
   * viewer's own activity, so team scope, person filters, and the People
   * leaderboard (with its member-profile links) are not offered, and stale
   * `scope` / `team` / `user` query params are ignored rather than sent.
   */
  personal?: boolean;
}

const PIPELINE_TYPE_BADGE: Record<
  PipelineUsageType,
  { label: string; tone: BadgeTone }
> = {
  bundled: { label: 'Bundled', tone: 'info' },
  shared: { label: 'Shared', tone: 'success' },
  project: { label: 'Project', tone: 'warning' },
  private: { label: 'Private', tone: 'neutral' },
};

type MetricTab =
  | 'overview'
  | 'tokens'
  | 'people'
  | 'pipelines'
  | 'tools'
  | 'activity';

const METRIC_TABS: ReadonlyArray<{ key: MetricTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'people', label: 'People' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'pipelines', label: 'Workflows' },
  { key: 'tools', label: 'Tools' },
  { key: 'activity', label: 'Activity' },
];

/** Personal statistics cover one person, so there is no People leaderboard. */
const PERSONAL_METRIC_TABS = METRIC_TABS.filter((tab) => tab.key !== 'people');

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type RangeKey = '1h' | '1d' | '7d' | '30d' | '90d';

const RANGE_OPTIONS: ReadonlyArray<{
  key: RangeKey;
  ms: number;
  label: string;
}> = [
  { key: '1h', ms: MS_PER_HOUR, label: 'Last 1 hour' },
  { key: '1d', ms: MS_PER_DAY, label: 'Last 1 day' },
  { key: '7d', ms: 7 * MS_PER_DAY, label: 'Last 7 days' },
  { key: '30d', ms: 30 * MS_PER_DAY, label: 'Last 30 days' },
  { key: '90d', ms: 90 * MS_PER_DAY, label: 'Last 90 days' },
];

const GRANULARITY_OPTIONS: ReadonlyArray<{
  value: TelemetryTimeGranularity;
  label: string;
}> = [
  { value: 'hour', label: 'Hourly' },
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
];

// --- URL query defaults (omitted from the URL when a value matches) ---
const DEFAULT_TAB: MetricTab = 'overview';
const DEFAULT_SCOPE: 'organization' | 'team' = 'organization';
const DEFAULT_GRANULARITY: TelemetryTimeGranularity = 'day';
const DEFAULT_RANGE_KEY: RangeKey = '7d';

/** Validate the `tab` query param, falling back to the default metric tab. */
function parseMetricTab(value: string | null): MetricTab {
  switch (value) {
    case 'overview':
    case 'tokens':
    case 'people':
    case 'pipelines':
    case 'tools':
    case 'activity':
      return value;
    default:
      return DEFAULT_TAB;
  }
}

/** Validate the `scope` query param, falling back to organization scope. */
function parseScope(value: string | null): 'organization' | 'team' {
  return value === 'team' ? 'team' : DEFAULT_SCOPE;
}

/** Validate the `gran` query param, falling back to daily granularity. */
function parseGranularity(value: string | null): TelemetryTimeGranularity {
  switch (value) {
    case 'hour':
    case 'day':
    case 'week':
      return value;
    default:
      return DEFAULT_GRANULARITY;
  }
}

/** Validate the `range` short key, falling back to the default 7-day range. */
function parseRangeKey(value: string | null): RangeKey {
  switch (value) {
    case '1h':
    case '1d':
    case '7d':
    case '30d':
    case '90d':
      return value;
    default:
      return DEFAULT_RANGE_KEY;
  }
}

function rangeMsForKey(key: RangeKey): number {
  const match = RANGE_OPTIONS.find((entry) => entry.key === key);
  if (match) {
    return match.ms;
  }
  // Unreachable in practice (RANGE_OPTIONS covers every RangeKey and callers
  // pass validated keys), but fall back to the configured default range rather
  // than a hard-coded literal so this never drifts if DEFAULT_RANGE_KEY changes.
  const fallback = RANGE_OPTIONS.find(
    (entry) => entry.key === DEFAULT_RANGE_KEY,
  );
  return fallback ? fallback.ms : MS_PER_DAY;
}

function rangeKeyForMs(ms: number): RangeKey {
  const option = RANGE_OPTIONS.find((entry) => entry.ms === ms);
  return option ? option.key : DEFAULT_RANGE_KEY;
}

/**
 * Client container for the team Statistics dashboard. Owns the scope / range /
 * granularity / user-filter / metric-tab state, fetches the rolled-up payload
 * from `GET /api/account/organizations/[orgId]/usage`, and renders the active metric
 * tab. All visuals derive from plaintext rollup metadata only.
 */
export function TeamStatisticsSection({
  orgId,
  organizationName,
  viewerIdentity,
  mobileBrowser,
  subTeams,
  members,
  personal = false,
}: TeamStatisticsSectionProps): JSX.Element {
  const client = useSettingsClient();
  const router = useSettingsRouter();
  const pathname = useSettingsPathname();
  const searchParams = useSettingsSearchParams();
  const { blockClassName } = useSettingsPrivacy();

  // The URL query string is the single source of truth for the view state, so
  // refreshing or sharing a link reproduces the exact tab + filter selection.
  // A personal org ignores team/person params: the server rejects them, and a
  // shared or stale link must not turn the page into an error.
  const parsedTab = parseMetricTab(searchParams.get('tab'));
  const activeTab =
    personal && parsedTab === 'people' ? DEFAULT_TAB : parsedTab;
  const scope = personal
    ? DEFAULT_SCOPE
    : parseScope(searchParams.get('scope'));
  const teamId = personal ? '' : (searchParams.get('team') ?? '');
  const granularity = parseGranularity(searchParams.get('gran'));
  const rangeKey = parseRangeKey(searchParams.get('range'));
  const rangeMs = rangeMsForKey(rangeKey);
  const userId = personal ? '' : (searchParams.get('user') ?? '');

  /**
   * Merge `partial` into the current query string and navigate. A `null` or
   * empty value deletes its key so canonical/short URLs stay clean (Overview
   * with default filters collapses back to a bare `/statistics`).
   */
  const updateParams = useCallback(
    (partial: Record<string, string | null>): void => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(partial)) {
        if (value === null || value === '') {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Purely-internal within-tab toggles stay local: they are not part of the
  // request and would only clutter the shareable URL.
  const [tokenDim, setTokenDim] = useState<'provider' | 'model'>('provider');
  const [costDim, setCostDim] = useState<'provider' | 'model'>('provider');
  const [peopleDetailed, setPeopleDetailed] = useState(false);

  const loadErrorCopy = useSettingsLoadFailure(STATISTICS_ERROR_SCOPE);
  const [usage, setUsage] = useState<TeamUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SettingsFailure | null>(null);
  // Bumped by Retry to fetch the usage again.
  const [reloadToken, setReloadToken] = useState(0);

  const effectiveTeamId = scope === 'team' ? teamId : '';
  // Derived during render so the effect never synchronously syncs state: a
  // team-scoped view waits for a team selection before fetching.
  const awaitingTeamSelection = scope === 'team' && !effectiveTeamId;

  useEffect(() => {
    if (awaitingTeamSelection) {
      return;
    }

    let ignore = false;
    const endIso = new Date().toISOString();
    const startIso = new Date(Date.now() - rangeMs).toISOString();

    // The state updates live inside an async closure (not the synchronous
    // effect body) so the kickoff doesn't trigger a cascading re-render.
    void (async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchTeamUsage(client, orgId, {
          scope,
          teamId: effectiveTeamId || undefined,
          granularity,
          startIso,
          endIso,
          userId: userId || undefined,
        });
        if (!ignore) {
          setUsage(result);
        }
      } catch (err: unknown) {
        if (!ignore) {
          setError(loadErrorCopy(err, USAGE_KNOWN_LOAD_ERRORS));
          setUsage(null);
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    })();

    return (): void => {
      ignore = true;
    };
  }, [
    client,
    orgId,
    scope,
    effectiveTeamId,
    granularity,
    rangeMs,
    userId,
    awaitingTeamSelection,
    loadErrorCopy,
    reloadToken,
  ]);

  // Signals (via a dot on the filter trigger) whether any filter still hidden
  // in the popover differs from its default. Range is now a visible standalone
  // control, so it is intentionally excluded — a dot driven by range would be
  // confusing when every popover field reads default. A short range still lights
  // the dot indirectly via granularity, since it forces `hour` (a genuinely
  // non-default granularity).
  const hasActiveFilters =
    scope !== DEFAULT_SCOPE ||
    granularity !== DEFAULT_GRANULARITY ||
    userId !== '';

  // People-tab data-sharing hint (CAN-3383). It names the viewer's absence
  // from the leaderboard, so it waits for BOTH the usage payload and the
  // viewer's status: loading is not absence. Team scope and a person filter
  // narrow `byUser` for reasons sharing cannot fix, so they never show it.
  const viewerSharing = useViewerDataSharing(orgId, viewerIdentity);
  const viewerUserId =
    viewerSharing.state === 'ready'
      ? viewerSharing.status.viewerUserId.toLowerCase()
      : null;
  const viewerMissingFromLeaderboard =
    viewerUserId !== null &&
    !loading &&
    usage !== null &&
    scope === 'organization' &&
    usage.scope === 'organization' &&
    userId === '' &&
    usage.filterUserId === null &&
    !usage.byUser.some((row) => row.userId?.toLowerCase() === viewerUserId);
  const peopleSharingHint = viewerMissingFromLeaderboard ? (
    <OrganizationDataSharingOptIn
      feature="leaderboards"
      orgId={orgId}
      organizationName={organizationName}
      mobileBrowser={mobileBrowser}
      sharing={viewerSharing}
    />
  ) : null;

  const handleRangeChange = (ms: number): void => {
    // Range and granularity move together: a short range forces hourly, and
    // returning to a multi-day range steps hourly back up to daily (hourly
    // over 90 days would issue ~2,160 buckets). A coarser manual choice
    // (weekly) is preserved. Write both keys in one navigation so the
    // derived-from-URL clamp holds.
    const nextGranularity: TelemetryTimeGranularity =
      ms <= MS_PER_DAY ? 'hour' : granularity === 'hour' ? 'day' : granularity;
    updateParams({
      range: ms === rangeMsForKey(DEFAULT_RANGE_KEY) ? null : rangeKeyForMs(ms),
      gran: nextGranularity === DEFAULT_GRANULARITY ? null : nextGranularity,
    });
  };

  return (
    <section
      className="flex flex-col gap-5"
      data-testid="team-statistics-section"
    >
      {/* Six peer views: page tabs, with the range and filter beneath. */}
      <div className="flex flex-col gap-3">
        <TabBar
          items={(personal ? PERSONAL_METRIC_TABS : METRIC_TABS).map((tab) => ({
            id: tab.key,
            label: tab.label,
            dataTestId: `usage-metric-tab-${tab.key}`,
          }))}
          value={activeTab}
          onChange={(tab): void =>
            updateParams({ tab: tab === DEFAULT_TAB ? null : tab })
          }
          label="Usage metrics"
          scrollable
          dataTestId="usage-metric-tabs"
        />

        <div className="flex items-center justify-end gap-2">
          <SelectControl
            label="Range"
            value={String(rangeMs)}
            testId="usage-range-select"
            onChange={(value) => handleRangeChange(Number(value))}
            options={RANGE_OPTIONS.map((option) => ({
              value: String(option.ms),
              label: option.label,
            }))}
          />

          <FilterPopover
            scope={scope}
            onScopeChange={(next) =>
              updateParams({
                scope: next === 'organization' ? null : 'team',
                // Switching back to the whole org clears any stale team filter.
                team: next === 'organization' ? null : teamId,
              })
            }
            teamId={teamId}
            onTeamChange={(next) => updateParams({ team: next })}
            subTeams={subTeams}
            granularity={granularity}
            onGranularityChange={(next) =>
              updateParams({ gran: next === DEFAULT_GRANULARITY ? null : next })
            }
            userId={userId}
            onUserChange={(next) => updateParams({ user: next })}
            members={members}
            hasActiveFilters={hasActiveFilters}
            personal={personal}
            blockClassName={blockClassName}
          />
        </div>
      </div>

      <ErrorBanner
        errorSource="team-statistics-section"
        error={error?.copy}
        details={error?.details}
        onRetry={() => setReloadToken((token) => token + 1)}
      />

      {awaitingTeamSelection ? (
        <Surface variant="dashed">
          <p
            className="px-4 py-12 text-center text-s fg-secondary"
            data-testid="usage-select-team"
          >
            Select a team to view its usage.
          </p>
        </Surface>
      ) : loading && !usage ? (
        <div data-testid="usage-loading">
          <DelayedLoadingPlaceholder>
            <SettingsChartLoading />
          </DelayedLoadingPlaceholder>
        </div>
      ) : error ? null : !usage ? (
        <Surface variant="dashed">
          <p
            className="px-4 py-12 text-center text-s fg-secondary"
            data-testid="usage-empty"
          >
            No usage data available for this selection.
          </p>
        </Surface>
      ) : (
        <TabContent
          tab={activeTab}
          orgId={orgId}
          blockClassName={blockClassName}
          usage={usage}
          tokenDim={tokenDim}
          onTokenDimChange={setTokenDim}
          costDim={costDim}
          onCostDimChange={setCostDim}
          peopleDetailed={peopleDetailed}
          onPeopleDetailedChange={setPeopleDetailed}
          peopleSharingHint={peopleSharingHint}
          routingBacktest={(variant) => (
            <RoutingBacktestCard
              variant={variant}
              subject={{
                kind: 'organization',
                orgId,
                scope,
                ...(effectiveTeamId ? { teamId: effectiveTeamId } : {}),
                ...(userId ? { userId } : {}),
              }}
              rangeMs={rangeMs}
              rangeLabel={
                RANGE_OPTIONS.find((option) => option.ms === rangeMs)?.label ??
                ''
              }
              billingHref={`/organization/${encodeURIComponent(orgId)}/settings?tab=billing`}
            />
          )}
        />
      )}
    </section>
  );
}

interface TabContentProps {
  tab: MetricTab;
  /** Org id used to link People rows through to each member's profile. */
  orgId: string;
  /** Replay-privacy class for member names; empty on hosts without replay. */
  blockClassName: string;
  usage: TeamUsageResponse;
  tokenDim: 'provider' | 'model';
  onTokenDimChange: (dim: 'provider' | 'model') => void;
  costDim: 'provider' | 'model';
  onCostDimChange: (dim: 'provider' | 'model') => void;
  peopleDetailed: boolean;
  onPeopleDetailedChange: (detailed: boolean) => void;
  /** Data-sharing hint rendered directly above the Impact leaderboard. */
  peopleSharingHint?: JSX.Element | null;
  /**
   * Automatic model routing estimate for the Overview tab. It nests inside
   * the "Auto model routing" panel when that panel shows, and stands alone
   * otherwise.
   */
  routingBacktest?: (variant: 'card' | 'inset') => JSX.Element;
}

function TabContent({
  tab,
  orgId,
  blockClassName,
  usage,
  tokenDim,
  onTokenDimChange,
  costDim,
  onCostDimChange,
  peopleDetailed,
  onPeopleDetailedChange,
  peopleSharingHint = null,
  routingBacktest,
}: TabContentProps): JSX.Element {
  const granularity = usage.range.granularity;
  const bucketGrid = useMemo(
    () => ({
      startIso: usage.range.startIso,
      endIso: usage.range.endIso,
      granularity,
    }),
    [granularity, usage.range.endIso, usage.range.startIso],
  );
  const tokenBuckets =
    tokenDim === 'provider' ? usage.tokensByProvider : usage.tokensByModel;
  const tokenSeries = useMemo(
    () => pivotBuckets(tokenBuckets, tokenBucketTotal, bucketGrid),
    [bucketGrid, tokenBuckets],
  );
  const tokenBreakdown = useMemo(
    () => aggregateTokenBreakdown(tokenBuckets),
    [tokenBuckets],
  );
  const costBuckets =
    costDim === 'provider' ? usage.costByProvider : usage.costByModel;
  const costSeries = useMemo(
    () => pivotBuckets(costBuckets, costBucketTotal, bucketGrid),
    [bucketGrid, costBuckets],
  );
  const costBreakdown = useMemo(
    () => aggregateCostBreakdown(costBuckets),
    [costBuckets],
  );
  // Billed cost aggregated per provider (lowercased key) for the observed-vs-
  // billed columns. Provider keys differ in case between the observed rollup
  // (`t.provider` enum → `CLAUDE`) and the billed buckets (`claude`), so match
  // case-insensitively.
  const billedByProvider = useMemo(() => {
    const map = new Map<string, number>();
    for (const bucket of usage.billedCost?.byBucket ?? []) {
      const key = bucket.key.toLowerCase();
      map.set(key, (map.get(key) ?? 0) + bucket.totalCostUsd);
    }
    return map;
  }, [usage.billedCost]);
  const peopleTableColumns = useMemo(
    () => peopleColumns(orgId, peopleDetailed, blockClassName),
    [orgId, peopleDetailed, blockClassName],
  );
  const impactSeries = useMemo(
    () => pivotBuckets(usage.impactByUser, impactBucketTotal, bucketGrid),
    [bucketGrid, usage.impactByUser],
  );
  const pipelinePeopleColumns = useMemo(
    () => peoplePipelineColumns(orgId, blockClassName),
    [orgId, blockClassName],
  );
  // Per-user pipeline execution rows: only users with completed runs in range,
  // ordered by executed pipeline agent steps. That metric lives only in this
  // breakdown — the summary column and the Impact bonus now key on agent turns.
  // `filter` returns a fresh array, so `sort` never mutates state.
  const pipelinePeopleRows = useMemo(
    () =>
      usage.byUser
        .filter((row) => row.pipelineRuns > 0)
        .sort((a, b) => b.pipelineAgentSteps - a.pipelineAgentSteps),
    [usage.byUser],
  );

  switch (tab) {
    case 'overview':
      return (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-4">
            <Heading level={2} variant="section">
              Key metrics
            </Heading>
            <HeadlineCards cards={usage.headline} />
          </section>
          <section className="flex flex-col gap-4">
            <Heading level={2} variant="section">
              Usage details
            </Heading>
            <Panel
              title="Usage over time"
              action={
                <DimToggle
                  value={costDim}
                  onChange={onCostDimChange}
                  testId="cost-dim-toggle"
                />
              }
            >
              <StackedTimeSeriesChart
                series={costSeries}
                granularity={granularity}
                valueFormatter={formatUsd}
                ariaLabel="Observed usage over time"
              />
            </Panel>
            <Panel title={`Usage by ${costDim}`}>
              <DataTable
                testId="cost-breakdown-table"
                rows={costBreakdown}
                rowKey={(row) => row.key}
                emptyLabel="No observed usage recorded for this range."
                columns={costBreakdownColumns(
                  costDim,
                  costDim === 'provider' && usage.billedCost
                    ? billedByProvider
                    : undefined,
                )}
              />
            </Panel>
            {usage.billedCost ? (
              <Panel
                title="Subscriptions"
                subtitle="Estimated subscription billing grouped by provider and plan type."
              >
                <>
                  <DataTable
                    testId="subscriptions-table"
                    rows={usage.billedCost.plans}
                    rowKey={(row) => `${row.provider}:${row.planKey}`}
                    emptyLabel="No subscription plans attributed for this range."
                    columns={subscriptionPlanColumns()}
                  />
                  {usage.billedCost.unpricedAccountCount > 0 ? (
                    <p
                      className="mt-2 text-xs fg-secondary"
                      data-testid="subscriptions-unpriced-note"
                    >
                      {usage.billedCost.unpricedAccountCount} subscription
                      account
                      {usage.billedCost.unpricedAccountCount === 1
                        ? ''
                        : 's'}{' '}
                      on unpriced plans — set prices in Settings.
                    </p>
                  ) : null}
                </>
              </Panel>
            ) : null}
            {usage.autoRoutingSavings ? (
              <Panel
                title="Model routing"
                subtitle="What model routing saved by picking a model for each message. Counted separately from subscription savings."
                testId="auto-routing-panel"
              >
                <div className="flex flex-col gap-4">
                  <AutoRoutingSavingsPanel savings={usage.autoRoutingSavings} />
                  {routingBacktest?.('inset') ?? null}
                </div>
              </Panel>
            ) : (
              (routingBacktest?.('card') ?? null)
            )}
          </section>
        </div>
      );

    case 'tokens': {
      return (
        <div className="flex flex-col gap-6">
          <Panel
            title="Tokens over time"
            action={
              <DimToggle
                value={tokenDim}
                onChange={onTokenDimChange}
                testId="token-dim-toggle"
              />
            }
          >
            <StackedTimeSeriesChart
              series={tokenSeries}
              granularity={granularity}
              valueFormatter={formatTokens}
              ariaLabel="Tokens over time"
            />
          </Panel>
          <Panel title={`Tokens by ${tokenDim}`}>
            <DataTable
              testId="tokens-breakdown-table"
              rows={tokenBreakdown}
              rowKey={(row) => row.key}
              emptyLabel="No token usage for this range."
              columns={tokenBreakdownColumns(tokenDim)}
            />
          </Panel>
        </div>
      );
    }

    case 'people':
      return (
        <div className="flex flex-col gap-6">
          <Panel
            title="Team impact over time"
            subtitle="Merged PRs at merge time; Cowork work items at last activity"
          >
            <StackedTimeSeriesChart
              series={impactSeries}
              granularity={granularity}
              valueFormatter={formatImpact}
              ariaLabel="Team impact over time"
              className={blockClassName || undefined}
            />
          </Panel>
          {peopleSharingHint}
          <Panel
            title="Impact leaderboard"
            action={
              <ColumnsToggle
                detailed={peopleDetailed}
                onChange={onPeopleDetailedChange}
              />
            }
          >
            <DataTable
              testId="people-table"
              rows={usage.byUser}
              rowKey={(row) => row.userId ?? 'unknown'}
              emptyLabel="No attributed usage for this range."
              defaultSort={{ key: 'impact', direction: 'desc' }}
              columnGroups={
                peopleDetailed
                  ? PEOPLE_COLUMN_GROUPS_DETAILED
                  : PEOPLE_COLUMN_GROUPS_COMPACT
              }
              columns={peopleTableColumns}
            />
          </Panel>
          {peopleDetailed ? (
            <Panel title="Workflows">
              <DataTable
                testId="people-pipelines-table"
                rows={pipelinePeopleRows}
                rowKey={(row) => row.userId ?? 'unknown'}
                emptyLabel="No completed workflow runs for this range."
                defaultSort={{ key: 'agentSteps', direction: 'desc' }}
                columns={pipelinePeopleColumns}
              />
            </Panel>
          ) : null}
        </div>
      );

    case 'pipelines':
      return (
        <Panel title="Workflow usage">
          <DataTable
            testId="pipelines-table"
            rows={usage.pipelines}
            rowKey={(row) => row.clientPipelineId}
            emptyLabel="No workflow runs for this range."
            columns={[
              {
                key: 'pipeline',
                header: 'Workflow',
                render: (row) => row.pipelineName ?? row.clientPipelineId,
              },
              {
                key: 'type',
                header: 'Type',
                render: (row) => {
                  const { label, tone } =
                    PIPELINE_TYPE_BADGE[
                      classifyPipelineType(row.clientPipelineId)
                    ];
                  return <Badge tone={tone}>{label}</Badge>;
                },
              },
              {
                key: 'runs',
                header: 'Runs',
                align: 'right',
                render: (row) => formatCount(row.runCount),
              },
              {
                key: 'agentTime',
                header: 'Agent time',
                align: 'right',
                render: (row) => formatDuration(row.agentTimeMs),
              },
              {
                key: 'cost',
                header: 'Observed usage',
                align: 'right',
                render: (row) => formatUsd(row.totalCostUsd),
              },
              {
                key: 'tokens',
                header: 'Tokens',
                align: 'right',
                render: (row) =>
                  formatTokens(row.inputTokens + row.outputTokens),
              },
            ]}
          />
        </Panel>
      );

    case 'tools': {
      const data: CategoryDatum[] = usage.toolCategoryTotals.map((total) => ({
        label: getTelemetryToolCategoryLabel(total.toolCategory),
        value: total.total,
      }));
      return (
        <Panel title="Tool usage by category">
          <CategoryBarChart
            data={data}
            valueFormatter={formatCount}
            ariaLabel="Tool usage by category"
          />
        </Panel>
      );
    }

    case 'activity':
      return (
        <Panel title="Turns by event type & status">
          <DataTable
            testId="activity-table"
            rows={usage.eventTypeStatusCounts}
            rowKey={(row, index) => `${row.eventType}-${row.status}-${index}`}
            emptyLabel="No agent activity for this range."
            columns={[
              {
                key: 'eventType',
                header: 'Event type',
                render: (row) => row.eventType,
              },
              {
                key: 'status',
                header: 'Status',
                render: (row) => row.status,
              },
              {
                key: 'count',
                header: 'Count',
                align: 'right',
                render: (row) => formatCount(row.count),
              },
            ]}
          />
        </Panel>
      );

    default:
      return <></>;
  }
}

interface TokenBreakdownRow {
  key: string;
  inputTokens: number;
  outputTokens: number;
  total: number;
}

function aggregateTokenBreakdown(
  buckets: TeamUsageResponse['tokensByProvider'],
): TokenBreakdownRow[] {
  const byKey = new Map<string, TokenBreakdownRow>();
  for (const bucket of buckets) {
    const row = byKey.get(bucket.key) ?? {
      key: bucket.key,
      inputTokens: 0,
      outputTokens: 0,
      total: 0,
    };
    row.inputTokens += bucket.inputTokens;
    row.outputTokens += bucket.outputTokens;
    row.total += tokenBucketTotal(bucket);
    byKey.set(bucket.key, row);
  }
  return Array.from(byKey.values()).sort((a, b) => b.total - a.total);
}

function tokenBreakdownColumns(
  dim: 'provider' | 'model',
): Array<DataTableColumn<TokenBreakdownRow>> {
  return [
    { key: 'key', header: dim, render: (row) => row.key },
    {
      key: 'input',
      header: 'Input',
      align: 'right',
      render: (row) => formatTokens(row.inputTokens),
    },
    {
      key: 'output',
      header: 'Output',
      align: 'right',
      render: (row) => formatTokens(row.outputTokens),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      render: (row) => formatTokens(row.total),
    },
  ];
}

interface CostBreakdownRow {
  key: string;
  total: number;
}

function aggregateCostBreakdown(
  buckets: TeamUsageResponse['costByProvider'],
): CostBreakdownRow[] {
  const byKey = new Map<string, CostBreakdownRow>();
  for (const bucket of buckets) {
    const row = byKey.get(bucket.key) ?? { key: bucket.key, total: 0 };
    row.total += costBucketTotal(bucket);
    byKey.set(bucket.key, row);
  }
  return Array.from(byKey.values()).sort((a, b) => b.total - a.total);
}

function costBreakdownColumns(
  dim: 'provider' | 'model',
  billedByKey?: ReadonlyMap<string, number>,
): Array<DataTableColumn<CostBreakdownRow>> {
  const columns: Array<DataTableColumn<CostBreakdownRow>> = [
    { key: 'key', header: dim, render: (row) => row.key },
    {
      key: 'total',
      header: 'Observed usage',
      align: 'right',
      render: (row) => formatUsd(row.total),
    },
  ];
  if (billedByKey) {
    columns.push(
      {
        key: 'billed',
        header: 'Subscription cost (est.)',
        align: 'right',
        render: (row) => formatUsd(billedByKey.get(row.key.toLowerCase()) ?? 0),
      },
      {
        key: 'savings',
        header: 'Savings (est.)',
        align: 'right',
        render: (row) =>
          formatUsd(row.total - (billedByKey.get(row.key.toLowerCase()) ?? 0)),
      },
    );
  }
  return columns;
}

function subscriptionPlanColumns(): Array<
  DataTableColumn<SubscriptionPlanUsageRow>
> {
  return [
    { key: 'plan', header: 'Plan', render: (row) => row.label },
    {
      key: 'provider',
      header: 'Provider',
      render: (row) => formatProviderLabel(row.provider),
    },
    {
      key: 'accounts',
      header: 'Accounts',
      align: 'right',
      render: (row) => formatCount(row.accountCount),
    },
    {
      key: 'monthly',
      header: 'Monthly price',
      align: 'right',
      render: (row) =>
        row.effectiveMonthlyUsd === null
          ? '—'
          : formatUsd(row.effectiveMonthlyUsd),
    },
    {
      key: 'billed',
      header: 'Billed in range',
      align: 'right',
      render: (row) => formatUsd(row.billedUsd),
    },
  ];
}

/** Short plain-language explanation of the Impact Score for the header tooltip. */
const IMPACT_TOOLTIP =
  'Merged-PR base score (commit type + size) plus ticket linkage and cross-repo ' +
  'work, a delivery score for Cowork work items, a bonus per implemented plan, ' +
  'and a soft-capped bonus for agent turns weighted by the tools they used.';

/** Grouped header row spanning the full (detailed) leaderboard columns. */
const PEOPLE_COLUMN_GROUPS_DETAILED: ReadonlyArray<DataTableColumnGroup> = [
  { label: 'Person', span: 1 },
  { label: 'Impact', span: 1 },
  { label: 'Activity', span: 13 },
  { label: 'Quality', span: 2 },
  { label: 'Tickets', span: 1 },
  { label: 'Usage', span: 4 },
];

/**
 * Grouped header row for the default (compact) view. The spans below must sum
 * to `COMPACT_PEOPLE_COLUMN_KEYS.length` — asserted by the People table test so
 * adding a column cannot silently desync the group header from the body.
 */
const PEOPLE_COLUMN_GROUPS_COMPACT: ReadonlyArray<DataTableColumnGroup> = [
  { label: 'Person', span: 1 },
  { label: 'Impact', span: 1 },
  { label: 'Activity', span: 4 },
  { label: 'Tickets', span: 1 },
  { label: 'Usage', span: 1 },
];

/**
 * Column `key`s shown in the default compact view. Expanding to the detailed
 * view reveals the rest. The compact subset preserves the detailed column order
 * so toggling reveals/hides columns in place rather than reshuffling them.
 */
const COMPACT_PEOPLE_COLUMN_KEYS: ReadonlySet<string> = new Set([
  'user',
  'impact',
  'prsMerged',
  'plansImplemented',
  'agentTurns',
  'deliveryEntries',
  'ticketLinked',
  'costPerMergedPr',
]);

/**
 * Sort key for a rate column: a zero denominator returns `null` (a "missing"
 * value the table always sorts to the bottom, mirroring the `'—'` the cell
 * renders) instead of producing `NaN` or a direction-dependent sentinel.
 */
function rateForSort(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * A leaderboard person cell: a member-profile link when the row is
 * attributed, plain text otherwise. Names carry the replay-privacy class.
 */
function MemberName({
  orgId,
  row,
  blockClassName,
}: {
  orgId: string;
  row: TelemetryUserLeaderboardRow;
  blockClassName: string;
}): JSX.Element | string {
  const name = row.userName ?? 'Unknown';
  if (row.userId) {
    return (
      <SettingsLink
        href={memberProfileHref(orgId, row.userId)}
        data-testid="member-profile-link"
        className={cx('font-medium fg-accent hover:underline', blockClassName)}
      >
        {name}
      </SettingsLink>
    );
  }
  return blockClassName ? <span className={blockClassName}>{name}</span> : name;
}

/**
 * Build the People-tab leaderboard columns in their full (detailed) order.
 * Impact leads and is the default sort; every column is sortable. Rate cells
 * guard division (`'—'` on a zero denominator) and sort consistently via
 * {@link rateForSort}. The compact view ({@link COMPACT_PEOPLE_COLUMN_KEYS})
 * is a filtered subset of this same ordered list, so toggling reveals/hides
 * columns in place. Columns within each block follow the order of
 * {@link PEOPLE_COLUMN_GROUPS_DETAILED}.
 */
function peopleColumns(
  orgId: string,
  detailed: boolean,
  blockClassName: string,
): Array<DataTableColumn<TelemetryUserLeaderboardRow>> {
  const columns: Array<DataTableColumn<TelemetryUserLeaderboardRow>> = [
    {
      key: 'user',
      header: 'Person',
      tooltip:
        'Team member the activity is attributed to. Links to their profile.',
      sortValue: (row) => row.userName ?? 'Unknown',
      render: (row) => (
        <MemberName orgId={orgId} row={row} blockClassName={blockClassName} />
      ),
    },
    {
      key: 'impact',
      header: 'Score',
      align: 'right',
      tooltip: IMPACT_TOOLTIP,
      sortValue: (row) => row.impactScore,
      render: (row) => (
        <span className="font-semibold fg-primary" title={IMPACT_TOOLTIP}>
          {formatImpactScore(row.impactScore)}
        </span>
      ),
    },
    // --- Activity ---
    {
      key: 'prsOpened',
      header: 'PRs opened',
      align: 'right',
      tooltip: 'Pull requests this person opened during the selected range.',
      sortValue: (row) => row.prsCreated,
      render: (row) => formatCount(row.prsCreated),
    },
    {
      key: 'prsMerged',
      header: 'PRs merged',
      align: 'right',
      tooltip:
        'Pull requests this person had merged during the range. Drives the base Impact score.',
      sortValue: (row) => row.prsMerged,
      render: (row) => formatCount(row.prsMerged),
    },
    {
      key: 'mergeRate',
      header: 'Merge rate',
      align: 'right',
      tooltip:
        'PRs merged divided by PRs opened, in range. Shown as a percent; blank when no PRs were opened.',
      sortValue: (row) => rateForSort(row.prsMerged, row.prsCreated),
      render: (row) => formatPercent(row.prsMerged, row.prsCreated),
    },
    {
      key: 'plans',
      header: 'Plans created',
      align: 'right',
      tooltip: 'Plans this person created during the range.',
      sortValue: (row) => row.plansCreated,
      render: (row) => formatCount(row.plansCreated),
    },
    {
      key: 'plansImplemented',
      header: 'Plans',
      align: 'right',
      tooltip:
        'Plans this person started implementing in range. Each adds +1 to Impact, capped at PRs merged.',
      sortValue: (row) => row.plansImplemented,
      render: (row) => formatCount(row.plansImplemented),
    },
    {
      key: 'worktrees',
      header: 'Worktrees',
      align: 'right',
      tooltip: 'Worktrees this person created during the range.',
      sortValue: (row) => row.worktreesCreated,
      render: (row) => formatCount(row.worktreesCreated),
    },
    {
      key: 'linesChanged',
      header: 'Lines',
      align: 'right',
      tooltip:
        'Total lines changed (additions + deletions) across the PRs this person opened in range.',
      sortValue: (row) => row.linesChanged,
      render: (row) => formatCount(row.linesChanged),
    },
    {
      key: 'cycleTime',
      header: 'Avg cycle',
      align: 'right',
      tooltip:
        'Mean time from PR opened to merged, over merged PRs that have both timestamps.',
      sortValue: (row) => row.avgCycleTimeMs,
      render: (row) =>
        row.avgCycleTimeMs > 0 ? formatDuration(row.avgCycleTimeMs) : '—',
    },
    {
      key: 'agentTurns',
      header: 'Agent turns',
      align: 'right',
      tooltip:
        'Agent turns that actually ran for this person in range — chat, plan ' +
        'chat, Cowork chat and workflow agent steps. Excludes helper and ' +
        'advisory turns, and turns still running. Feeds a soft-capped bonus ' +
        'into Impact, weighted by the tools each turn used. Metric definition ' +
        'changed on 2026-08-21; earlier rows counted declared workflow steps.',
      sortValue: (row) => row.agentTurns,
      render: (row) => formatCount(row.agentTurns),
    },
    {
      key: 'turnsPerUnit',
      header: 'Turns / unit',
      align: 'right',
      tooltip:
        'Agent turns divided by delivered units (PRs merged + scoring Cowork ' +
        'work items). A cost-shape signal, not a quality score — hard problems ' +
        'legitimately cost more turns. Blank when nothing was delivered.',
      sortValue: (row) =>
        rateForSort(row.agentTurns, row.prsMerged + row.deliveryEntries),
      render: (row): string => {
        const units = row.prsMerged + row.deliveryEntries;
        return units > 0 ? formatRate(row.agentTurns / units) : '—';
      },
    },
    {
      key: 'deliveryEntries',
      header: 'Work items',
      align: 'right',
      tooltip:
        'Cowork work items with enough in-range substance to score. Each one adds ' +
        'its own delivery points to Impact.',
      sortValue: (row) => row.deliveryEntries,
      render: (row) => formatCount(row.deliveryEntries),
    },
    {
      key: 'deliveryArtifacts',
      header: 'Artifacts',
      align: 'right',
      tooltip:
        'Files written or edited across scoring Cowork work items. Sizes each ' +
        "item's delivery contribution to Impact.",
      sortValue: (row) => row.deliveryArtifacts,
      render: (row) => formatCount(row.deliveryArtifacts),
    },
    {
      key: 'deliverySharedRuns',
      header: 'Shared',
      align: 'right',
      tooltip:
        'Cowork runs shared with the team in range. Adds a bonus to Impact, ' +
        'capped at the number of scoring work items.',
      sortValue: (row) => row.deliverySharedRuns,
      render: (row) => formatCount(row.deliverySharedRuns),
    },
    // --- Quality ---
    {
      key: 'checkPassRate',
      header: 'Check pass',
      align: 'right',
      tooltip:
        'PRs with passing checks divided by PRs with a decided check status (passing or failing).',
      sortValue: (row) => rateForSort(row.checksPassing, row.checksDecided),
      render: (row) => formatPercent(row.checksPassing, row.checksDecided),
    },
    {
      key: 'avgPrSize',
      header: 'Avg PR size',
      align: 'right',
      tooltip:
        'Mean lines changed (additions + deletions) per PR this person opened in range.',
      sortValue: (row) => row.avgPrSize,
      render: (row) => (row.avgPrSize > 0 ? formatCount(row.avgPrSize) : '—'),
    },
    // --- Linkage ---
    {
      key: 'ticketLinked',
      header: 'Linked',
      align: 'right',
      tooltip:
        'Share of PRs whose title references a Linear-style ticket (e.g. ABC-123). Earns Impact linkage and cross-repo bonuses.',
      sortValue: (row) => rateForSort(row.prsWithTicket, row.prsCreated),
      render: (row) => formatPercent(row.prsWithTicket, row.prsCreated),
    },
    // --- Usage ---
    {
      key: 'billedTurns',
      header: 'Billed turns',
      align: 'right',
      tooltip:
        'Every agent turn attributed to this person in range, including helper ' +
        'and advisory turns. This is the denominator the cost and token ' +
        'columns are measured over, so it runs higher than Agent turns.',
      sortValue: (row) => row.turnCount,
      render: (row) => formatCount(row.turnCount),
    },
    {
      key: 'cost',
      header: 'Observed usage',
      align: 'right',
      tooltip:
        'Total observed agent usage (USD) attributed to this person in range.',
      sortValue: (row) => row.totalCostUsd,
      render: (row) => formatUsd(row.totalCostUsd),
    },
    {
      key: 'costPerMergedPr',
      header: '$ / PR',
      align: 'right',
      tooltip: 'Total observed agent usage divided by PRs merged in range.',
      sortValue: (row) => rateForSort(row.totalCostUsd, row.prsMerged),
      render: (row) =>
        row.prsMerged > 0 ? formatUsd(row.totalCostUsd / row.prsMerged) : '—',
    },
    {
      key: 'tokens',
      header: 'Tokens',
      align: 'right',
      tooltip:
        'Total input + output tokens attributed to this person in range.',
      sortValue: (row) => row.inputTokens + row.outputTokens,
      render: (row) => formatTokens(row.inputTokens + row.outputTokens),
    },
  ];

  return detailed
    ? columns
    : columns.filter((column) => COMPACT_PEOPLE_COLUMN_KEYS.has(column.key));
}

/**
 * Columns for the detailed-only per-user Pipelines breakdown. Surfaces the
 * richer pipeline-execution stats (runs, success rate, distinct pipelines,
 * retries, avg duration) that would over-crowd the main leaderboard, plus the
 * declared agent-steps pipeline-shape stat that no longer feeds Impact and is
 * only honest here. Rate/duration cells guard division and render
 * `'—'` when there is nothing to show, sorting consistently via
 * {@link rateForSort}.
 */
function peoplePipelineColumns(
  orgId: string,
  blockClassName: string,
): Array<DataTableColumn<TelemetryUserLeaderboardRow>> {
  return [
    {
      key: 'user',
      header: 'Person',
      tooltip:
        'Team member the workflow runs are attributed to. Links to their profile.',
      sortValue: (row) => row.userName ?? 'Unknown',
      render: (row) => (
        <MemberName orgId={orgId} row={row} blockClassName={blockClassName} />
      ),
    },
    {
      key: 'runs',
      header: 'Runs',
      align: 'right',
      tooltip: 'Completed workflow runs attributed to this person in range.',
      sortValue: (row) => row.pipelineRuns,
      render: (row) => formatCount(row.pipelineRuns),
    },
    {
      key: 'successRate',
      header: 'Success rate',
      align: 'right',
      tooltip:
        'Succeeded runs divided by decided runs (succeeded + failed). Blank when no runs were decided.',
      sortValue: (row) =>
        rateForSort(
          row.pipelineRunsSucceeded,
          row.pipelineRunsSucceeded + row.pipelineRunsFailed,
        ),
      render: (row) =>
        formatPercent(
          row.pipelineRunsSucceeded,
          row.pipelineRunsSucceeded + row.pipelineRunsFailed,
        ),
    },
    {
      key: 'agentSteps',
      header: 'Agent steps',
      align: 'right',
      tooltip:
        'Agent steps that actually ran across completed workflow runs in ' +
        'range, counted separately per matrix variant, retry attempt, ' +
        'iteration and parallel agent. No longer feeds Impact; Agent turns ' +
        'does. Metric definition changed on 2026-08-21; earlier rows count ' +
        'every declared step, including steps that never ran.',
      sortValue: (row) => row.pipelineAgentSteps,
      render: (row) => formatCount(row.pipelineAgentSteps),
    },
    {
      key: 'distinctPipelines',
      header: 'Distinct workflows',
      align: 'right',
      tooltip: 'Distinct workflows this person ran to completion in range.',
      sortValue: (row) => row.pipelineDistinctPipelines,
      render: (row) => formatCount(row.pipelineDistinctPipelines),
    },
    {
      key: 'retries',
      header: 'Retries',
      align: 'right',
      tooltip: 'Total step retries across this person’s completed runs.',
      sortValue: (row) => row.pipelineRetries,
      render: (row) => formatCount(row.pipelineRetries),
    },
    {
      key: 'avgRun',
      header: 'Avg run',
      align: 'right',
      tooltip: 'Mean run duration over this person’s completed runs in range.',
      sortValue: (row) => row.pipelineAvgRunMs,
      render: (row) =>
        row.pipelineAvgRunMs > 0 ? formatDuration(row.pipelineAvgRunMs) : '—',
    },
  ];
}

interface FilterPopoverProps {
  scope: 'organization' | 'team';
  onScopeChange: (scope: 'organization' | 'team') => void;
  teamId: string;
  onTeamChange: (teamId: string) => void;
  subTeams: readonly OrganizationSubTeam[];
  granularity: TelemetryTimeGranularity;
  onGranularityChange: (granularity: TelemetryTimeGranularity) => void;
  userId: string;
  onUserChange: (userId: string) => void;
  members: readonly OrganizationMember[];
  /** Offer granularity only: personal statistics have no team or person scope. */
  personal: boolean;
  /** Replay-privacy class for the Person select, which lists member names. */
  blockClassName: string;
  /**
   * Renders the active-filter dot when a collapsed popover filter
   * (scope / granularity / person) is off its default. Range is excluded — it
   * is a visible standalone control, so it never drives the dot on its own.
   */
  hasActiveFilters: boolean;
}

/**
 * Collapses the Scope / Granularity / Person filters behind a single icon
 * trigger so the tab-bar row stays a clean single line. The shared `Popover`
 * owns focus, Escape, outside presses (its selects' menus count as inside)
 * and focus return. A small dot on the trigger signals when one of these
 * collapsed filters is non-default; range lives outside the popover and is
 * excluded.
 */
function FilterPopover({
  scope,
  onScopeChange,
  teamId,
  onTeamChange,
  subTeams,
  granularity,
  onGranularityChange,
  userId,
  onUserChange,
  members,
  hasActiveFilters,
  personal,
  blockClassName,
}: FilterPopoverProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative">
      <Button
        ref={triggerRef}
        size="compact"
        iconOnly
        variant="ghost"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Filters"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="usage-filters-panel"
        data-testid="usage-filters-trigger"
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        {hasActiveFilters && (
          <Dot
            tone="filter"
            data-testid="usage-filters-active-dot"
            className="absolute right-0.5 top-0.5"
          />
        )}
      </Button>

      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        gap={8}
        id="usage-filters-panel"
        aria-label="Filters"
        data-testid="usage-controls"
      >
        <div className="flex flex-col gap-3">
          {!personal && (
            <SelectControl
              stacked
              label="Scope"
              value={scope}
              testId="usage-scope-select"
              onChange={(value) =>
                onScopeChange(value === 'team' ? 'team' : 'organization')
              }
              options={[
                { value: 'organization', label: 'Whole organization' },
                { value: 'team', label: 'Specific team' },
              ]}
            />
          )}

          {!personal && scope === 'team' && (
            <SelectControl
              stacked
              label="Team"
              value={teamId}
              testId="usage-team-select"
              onChange={onTeamChange}
              options={[
                { value: '', label: 'Select a team…' },
                ...subTeams.map((team) => ({
                  value: team.id,
                  label: team.name,
                })),
              ]}
            />
          )}

          <SelectControl
            stacked
            label="Granularity"
            value={granularity}
            testId="usage-granularity-select"
            onChange={(value) => {
              if (value === 'hour' || value === 'day' || value === 'week') {
                onGranularityChange(value);
              }
            }}
            options={GRANULARITY_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          />

          {!personal && (
            <SelectControl
              stacked
              label="Person"
              value={userId}
              testId="usage-user-select"
              selectClassName={blockClassName}
              onChange={onUserChange}
              options={[
                { value: '', label: 'Everyone' },
                ...members.map((member) => ({
                  value: member.id,
                  label: member.name,
                })),
              ]}
            />
          )}
        </div>
      </Popover>
    </div>
  );
}

interface SelectControlProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  testId: string;
  /**
   * Stacks the label above a full-width select instead of the default inline
   * label-beside-select layout. Used inside the narrow filter popover.
   */
  stacked?: boolean;
  /** Extra classes for the `<select>` (for example replay privacy). */
  selectClassName?: string;
}

function SelectControl({
  label,
  value,
  onChange,
  options,
  testId,
  stacked = false,
  selectClassName = '',
}: SelectControlProps): JSX.Element {
  const labelId = useId();
  if (stacked) {
    return (
      <FormField label={label}>
        {(control) => (
          <div className="relative flex">
            <SettingsSelect
              {...control}
              value={value}
              onValueChange={onChange}
              data-testid={testId}
              width="fill"
              replayPrivacy={{ blockClassName: selectClassName }}
              options={options}
            />
          </div>
        )}
      </FormField>
    );
  }
  // A toolbar filter: the name sits beside its dropdown on one line.
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium fg-secondary">
      <span id={labelId}>{label}</span>
      <div className="relative inline-flex">
        <SettingsSelect
          aria-labelledby={labelId}
          value={value}
          onValueChange={onChange}
          data-testid={testId}
          width="control"
          replayPrivacy={{ blockClassName: selectClassName }}
          options={options}
        />
      </div>
    </span>
  );
}

interface DimToggleProps {
  value: 'provider' | 'model';
  onChange: (value: 'provider' | 'model') => void;
  testId: string;
}

function DimToggle({ value, onChange, testId }: DimToggleProps): JSX.Element {
  return (
    <SegmentedControl
      label="Group by"
      semantics="toggle"
      width="content"
      dataTestId={testId}
      value={value}
      onChange={onChange}
      options={DIM_OPTIONS}
    />
  );
}

const DIM_OPTIONS: readonly SegmentedControlOption<'provider' | 'model'>[] = [
  { value: 'provider', label: 'Provider' },
  { value: 'model', label: 'Model' },
];

interface ColumnsToggleProps {
  detailed: boolean;
  onChange: (detailed: boolean) => void;
}

/**
 * Toggles the People leaderboard between the default compact column set and the
 * full detailed set, on the shared segmented control like {@link DimToggle}.
 */
function ColumnsToggle({
  detailed,
  onChange,
}: ColumnsToggleProps): JSX.Element {
  return (
    <SegmentedControl
      label="People columns"
      semantics="toggle"
      width="content"
      dataTestId="people-columns-toggle"
      value={detailed ? 'detailed' : 'summary'}
      onChange={(next) => onChange(next === 'detailed')}
      options={COLUMNS_OPTIONS}
    />
  );
}

const COLUMNS_OPTIONS: readonly SegmentedControlOption<
  'summary' | 'detailed'
>[] = [
  { value: 'summary', label: 'Summary', dataTestId: 'people-columns-summary' },
  {
    value: 'detailed',
    label: 'Detailed',
    dataTestId: 'people-columns-detailed',
  },
];

interface PanelProps {
  title: string;
  subtitle?: string;
  action?: JSX.Element;
  children: JSX.Element;
  testId?: string;
}

/**
 * Bounded Auto comparison for the selected scope and range.
 *
 * Every figure is an ESTIMATE and is labelled as one. `comparableTurnCount`
 * is shown separately from `autoTurnCount` on purpose: a turn whose harness
 * has no eligible, comparably priced default contributes to the Auto count but
 * not to the money, and hiding that gap would turn an estimate into a claim.
 */
function AutoRoutingSavingsPanel({
  savings,
}: {
  readonly savings: NonNullable<TeamUsageResponse['autoRoutingSavings']>;
}): JSX.Element {
  const rows: readonly {
    readonly key: string;
    readonly label: string;
    readonly value: string;
  }[] = [
    {
      key: 'benchmark',
      label: 'Your usual model (est.)',
      value:
        savings.benchmarkEstimatedExecutionCostUsd === null
          ? '—'
          : formatUsd(savings.benchmarkEstimatedExecutionCostUsd),
    },
    {
      key: 'selected',
      label: 'With model routing (est.)',
      value:
        savings.actualWithAutoCostUsd === null
          ? '—'
          : formatUsd(savings.actualWithAutoCostUsd),
    },
    {
      key: 'routing',
      label: 'Cost of picking',
      value:
        savings.routingCostUsd === null
          ? '—'
          : formatUsd(savings.routingCostUsd),
    },
    {
      key: 'net',
      label: 'Model routing savings (est.)',
      value:
        savings.netEstimatedSavingsUsd === null
          ? '—'
          : formatUsd(savings.netEstimatedSavingsUsd),
    },
  ];
  return (
    <div className="flex flex-col gap-3" data-testid="auto-routing-savings">
      <FactList
        layout="stacked"
        columns={4}
        valueSize="large"
        labelTone="secondary"
        columnGap="3"
        rowGap="3"
      >
        {rows.map((row) => (
          <Fact
            key={row.key}
            label={row.label}
            testId={`auto-routing-savings-${row.key}`}
          >
            {row.value}
          </Fact>
        ))}
      </FactList>
      <p
        className="text-xs fg-secondary"
        data-testid="auto-routing-savings-basis"
      >
        Based on {formatCount(savings.comparableTurnCount)} of{' '}
        {formatCount(savings.autoTurnCount)} routed turn
        {savings.autoTurnCount === 1 ? '' : 's'}.
      </p>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  action,
  children,
  testId,
}: PanelProps): JSX.Element {
  return (
    <Surface variant="raised" padding="default" data-testid={testId}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <Heading level={3} variant="title">
            {title}
          </Heading>
          {subtitle ? <p className="text-xs fg-secondary">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </Surface>
  );
}
