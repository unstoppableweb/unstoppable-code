import { type JSX, useEffect, useMemo, useState } from 'react';
import type {
  UsageBreakdownRow,
  UsageGroupById,
  UsageMetricId,
  UsageMetricsViewResponse,
} from '@canopy/desktop-shared/types';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useObservabilityEntriesInterest } from '@/lib/chat-interest';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  DataTable,
  DelayedLoadingPlaceholder,
  SettingsSelect,
  Skeleton,
  type DataTableColumn,
} from '@canopy/ui-shared/components';
import { ErrorBanner } from '@/components/shared/StatusBlocks';
import type { TabSpec } from './tab-specs';
import { formatCurrencyUsd, formatNumber } from './format';

/** Plain rows the loading skeleton measures in the table's own columns. */
const SAMPLE_BREAKDOWN_ROWS: ReadonlyArray<UsageBreakdownRow> = [
  { key: 'sample-1', label: 'Checkout service', count: 128 },
  { key: 'sample-2', label: 'Docs site', count: 64 },
  { key: 'sample-3', label: 'Mobile app', count: 12 },
];

interface MetricsBreakdownPanelProps {
  spec: TabSpec;
}

export function MetricsBreakdownPanel({
  spec,
}: MetricsBreakdownPanelProps): JSX.Element {
  useObservabilityEntriesInterest();
  const [metric, setMetric] = useState<UsageMetricId>(spec.defaultTableMetric);
  const [groupBy, setGroupBy] = useState<UsageGroupById>(
    spec.defaultTableGrouping,
  );

  // Reset to tab defaults when the tab changes.
  useEffect(() => {
    setMetric(spec.defaultTableMetric);
    setGroupBy(spec.defaultTableGrouping);
  }, [spec]);

  const loadUsageMetricsView = useObservabilityStore(
    (s) => s.loadUsageMetricsView,
  );
  const [response, setResponse] = useState<UsageMetricsViewResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setResponse(null);
    loadUsageMetricsView({
      tab: spec.id,
      metric,
      groupBy,
      window: { kind: 'last7d' },
    })
      .then((next) => {
        if (cancelled) return;
        setResponse(next);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error ? reason.message : 'Failed to load breakdown',
        );
      });
    return (): void => {
      cancelled = true;
    };
  }, [spec.id, metric, groupBy, loadUsageMetricsView]);

  const showStats = useMemo(() => {
    return Boolean(response?.stats);
  }, [response]);

  const onMetricChange = (value: string): void => {
    const next = spec.tableMetrics.find((m) => m.value === value);
    if (next) setMetric(next.value);
  };

  const onGroupByChange = (value: string): void => {
    const next = spec.tableGroupings.find((g) => g.value === value);
    if (next) setGroupBy(next.value);
  };

  return (
    <div
      className="flex flex-col gap-2"
      data-testid={`usage-breakdown-${spec.id}`}
    >
      <div className="flex flex-wrap items-center gap-3 text-s">
        <div className="flex items-center gap-2">
          <span
            id={`breakdown-metric-${spec.id}-label`}
            className="text-xs fg-secondary"
          >
            Metric:
          </span>
          <SettingsSelect
            id={`breakdown-metric-${spec.id}`}
            width="fit"
            aria-labelledby={`breakdown-metric-${spec.id}-label`}
            options={spec.tableMetrics.map((opt) => ({
              value: opt.value,
              label: opt.label,
            }))}
            value={metric}
            onValueChange={onMetricChange}
            data-testid={`usage-breakdown-metric-${spec.id}`}
          />
        </div>
        <div className="flex items-center gap-2">
          <span
            id={`breakdown-group-${spec.id}-label`}
            className="text-xs fg-secondary"
          >
            Group by:
          </span>
          <SettingsSelect
            id={`breakdown-group-${spec.id}`}
            width="fit"
            aria-labelledby={`breakdown-group-${spec.id}-label`}
            options={spec.tableGroupings.map((opt) => ({
              value: opt.value,
              label: opt.label,
            }))}
            value={groupBy}
            onValueChange={onGroupByChange}
            data-testid={`usage-breakdown-groupby-${spec.id}`}
          />
        </div>
      </div>
      {error ? (
        <ErrorBanner
          errorSource="metrics-breakdown-panel"
          error={error}
          className=""
        />
      ) : response === null ? (
        <DelayedLoadingPlaceholder slowNote="Still loading breakdown…">
          <Skeleton
            loading
            label="Loading breakdown"
            testId={`usage-breakdown-loading-${spec.id}`}
          >
            <BreakdownTable
              rows={SAMPLE_BREAKDOWN_ROWS}
              showStats={false}
              groupBy={groupBy}
              countColumnLabel={spec.countColumnLabel ?? 'Count'}
              valueFormat={spec.valueFormat ?? 'number'}
              emptyMessage={spec.emptyMessage}
            />
          </Skeleton>
        </DelayedLoadingPlaceholder>
      ) : (
        <BreakdownTable
          rows={response.rows}
          showStats={showStats}
          groupBy={groupBy}
          countColumnLabel={spec.countColumnLabel ?? 'Count'}
          valueFormat={spec.valueFormat ?? 'number'}
          emptyMessage={spec.emptyMessage}
        />
      )}
    </div>
  );
}

interface BreakdownTableProps {
  rows: ReadonlyArray<UsageBreakdownRow>;
  showStats: boolean;
  groupBy: UsageGroupById;
  countColumnLabel: string;
  valueFormat: 'number' | 'currency';
  emptyMessage: string;
}

type StatKey = 'min' | 'max' | 'avg' | 'p50' | 'p95' | 'p99';

const STAT_COLUMNS: ReadonlyArray<{ key: StatKey; header: string }> = [
  { key: 'min', header: 'Min' },
  { key: 'max', header: 'Max' },
  { key: 'avg', header: 'Avg' },
  { key: 'p50', header: 'P50' },
  { key: 'p95', header: 'P95' },
  { key: 'p99', header: 'P99' },
];

function BreakdownTable({
  rows,
  showStats,
  groupBy,
  countColumnLabel,
  valueFormat,
  emptyMessage,
}: BreakdownTableProps): JSX.Element {
  const columns: Array<DataTableColumn<UsageBreakdownRow>> = [
    {
      key: 'group',
      header: 'Group',
      render: (row) =>
        groupBy === 'worktree' ? (
          <WorktreeBreakdownLabel row={row} />
        ) : (
          row.label
        ),
    },
    {
      key: 'count',
      header: countColumnLabel,
      align: 'right',
      render: (row) =>
        valueFormat === 'currency'
          ? formatCurrencyUsd(row.count)
          : row.count.toLocaleString(),
    },
  ];
  if (showStats) {
    for (const stat of STAT_COLUMNS) {
      columns.push({
        key: stat.key,
        header: stat.header,
        align: 'right',
        render: (row) => formatNumber(row.stats?.[stat.key]),
      });
    }
  }
  return (
    <DataTable
      caption="Usage breakdown"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.key}
      emptyLabel={emptyMessage}
    />
  );
}

function WorktreeBreakdownLabel({
  row,
}: {
  row: UsageBreakdownRow;
}): JSX.Element {
  const projects = useProjectsStore((s) => s.projects);
  if (!row.worktreeId) return <>{row.label}</>;

  const workspace = row.workspaceId
    ? projects.find((p) => p.id === row.workspaceId)
    : undefined;
  const workspaceLabel =
    workspace?.name ?? row.workspaceLabel ?? row.workspaceId ?? 'Project';
  const worktree =
    workspace && workspace.type !== 'cowork'
      ? workspace.worktrees.find((w) => w.id === row.worktreeId)
      : undefined;
  const branchName = worktree?.branchName;
  if (branchName) {
    return <>{`${workspaceLabel} / ${row.worktreeId} (${branchName})`}</>;
  }
  return <>{`${workspaceLabel} / ${row.worktreeId}`}</>;
}
