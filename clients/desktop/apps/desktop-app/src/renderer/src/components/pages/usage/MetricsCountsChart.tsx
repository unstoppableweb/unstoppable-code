import { type JSX, useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  UsageCountsTimeseriesBucket,
  UsageMetricId,
} from '@canopy/desktop-shared/types';
import type { PickerOption } from './tab-specs';
import {
  CHART_HEIGHT_PX,
  formatBucketLabel,
  formatCompactNumber,
} from '@canopy/ui-app/charts/chart-controls';
import {
  CHART_GRID_DASH,
  CHART_LINE,
  CHART_TICK_FONT_SIZE,
  CHART_TICK_INK,
} from '@canopy/ui-app/charts/chart-theme';
import { ChartTooltip } from '@canopy/ui-shared/components';
import { formatCompactCurrencyUsd, formatCurrencyUsd } from './format';

// Stable palette for series. Picked to cover up to ~22 categories.
const SERIES_COLORS = [
  '#60a5fa',
  '#a78bfa',
  '#34d399',
  '#fbbf24',
  '#f87171',
  '#22d3ee',
  '#fb923c',
  '#c084fc',
  '#4ade80',
  '#facc15',
  '#fb7185',
  '#38bdf8',
  '#a3e635',
  '#e879f9',
  '#fde047',
  '#fda4af',
  '#7dd3fc',
  '#bef264',
  '#f0abfc',
  '#fef08a',
  '#fecdd3',
  '#bae6fd',
];

export function colorForSeries(metric: UsageMetricId): string {
  let hash = 0;
  for (let i = 0; i < metric.length; i += 1) {
    hash = (hash * 31 + metric.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % SERIES_COLORS.length;
  return SERIES_COLORS[index];
}

interface MetricsCountsChartProps {
  buckets: ReadonlyArray<UsageCountsTimeseriesBucket>;
  visibleSeries: ReadonlySet<UsageMetricId>;
  seriesOptions: ReadonlyArray<PickerOption<UsageMetricId>>;
  bucket: 'hour' | 'day' | 'week';
  valueFormat?: 'number' | 'currency';
}

interface CountsDatum {
  bucketStart: string;
  label: string;
  total: number;
  [key: string]: number | string;
}

export function MetricsCountsChart({
  buckets,
  visibleSeries,
  seriesOptions,
  bucket,
  valueFormat = 'number',
}: MetricsCountsChartProps): JSX.Element {
  const data = useMemo<CountsDatum[]>(() => {
    return buckets.map((b) => {
      const datum: CountsDatum = {
        bucketStart: b.bucketStart,
        label: formatBucketLabel(b.bucketStart, bucket),
        total: 0,
      };
      let total = 0;
      for (const opt of seriesOptions) {
        const value = b.series[opt.value] ?? 0;
        datum[opt.value] = value;
        if (visibleSeries.has(opt.value)) total += value;
      }
      datum.total = total;
      return datum;
    });
  }, [buckets, seriesOptions, visibleSeries, bucket]);

  const formatValue =
    valueFormat === 'currency' ? formatCurrencyUsd : formatCompactNumber;

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT_PX}>
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray={CHART_GRID_DASH} stroke={CHART_LINE} />
        <XAxis
          dataKey="label"
          stroke={CHART_TICK_INK}
          fontSize={CHART_TICK_FONT_SIZE}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke={CHART_TICK_INK}
          fontSize={CHART_TICK_FONT_SIZE}
          tickFormatter={(v: number) =>
            valueFormat === 'currency'
              ? formatCompactCurrencyUsd(v)
              : formatCompactNumber(v)
          }
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: 'var(--bg-secondary)', fillOpacity: 0.4 }}
          content={(props) => (
            <ChartTooltip
              active={props.active}
              label={props.label}
              payload={props.payload}
              accessibilityLayer={props.accessibilityLayer}
              formatValue={formatValue}
            />
          )}
        />
        {seriesOptions
          .filter((opt) => visibleSeries.has(opt.value))
          .map((opt) => (
            <Bar
              key={opt.value}
              dataKey={opt.value as string}
              name={opt.label}
              stackId="counts"
              fill={colorForSeries(opt.value)}
              radius={0}
            />
          ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
