import { type JSX, useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UsageDistributionTimeseriesBucket } from '@canopy/desktop-shared/types';
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

export type Percentile = 'p50' | 'p95' | 'p99';

const PERCENTILE_COLORS: Record<Percentile, string> = {
  p50: '#34d399',
  p95: '#fbbf24',
  p99: '#f87171',
};

interface MetricsDistributionChartProps {
  buckets: ReadonlyArray<UsageDistributionTimeseriesBucket>;
  visiblePercentiles: ReadonlySet<Percentile>;
  bucket: 'hour' | 'day' | 'week';
}

interface DistributionDatum {
  bucketStart: string;
  label: string;
  p50: number;
  p95: number;
  p99: number;
  sampleCount: number;
}

export function MetricsDistributionChart({
  buckets,
  visiblePercentiles,
  bucket,
}: MetricsDistributionChartProps): JSX.Element {
  const data = useMemo<DistributionDatum[]>(
    () =>
      buckets.map((b) => ({
        bucketStart: b.bucketStart,
        label: formatBucketLabel(b.bucketStart, bucket),
        p50: b.p50,
        p95: b.p95,
        p99: b.p99,
        sampleCount: b.sampleCount,
      })),
    [buckets, bucket],
  );

  const percentileOrder: ReadonlyArray<Percentile> = ['p50', 'p95', 'p99'];

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT_PX}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
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
          tickFormatter={(v: number) => formatCompactNumber(v)}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ stroke: 'var(--bg-secondary)', strokeWidth: 1 }}
          content={(props) => (
            <ChartTooltip
              active={props.active}
              label={props.label}
              payload={props.payload}
              accessibilityLayer={props.accessibilityLayer}
              marker="line"
              formatValue={formatCompactNumber}
            />
          )}
        />
        {percentileOrder.map((p) =>
          visiblePercentiles.has(p) ? (
            <Line
              key={p}
              type="monotone"
              dataKey={p}
              stroke={PERCENTILE_COLORS[p]}
              dot={false}
              strokeWidth={2}
            />
          ) : null,
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
