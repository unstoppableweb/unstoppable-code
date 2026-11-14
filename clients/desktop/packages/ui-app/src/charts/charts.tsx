'use client';

import type { JSX } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartEmpty, ChartTooltip } from '@canopy/ui-shared/components';
import {
  compactNumber,
  formatBucketTick,
  type PivotedSeries,
  seriesColor,
} from '../settings/organization/statistics/format';
import { categoryBarChartHeight } from './chart-layout';
import {
  CHART_BAR_CURSOR,
  CHART_GRID_DASH,
  CHART_LINE,
  CHART_TICK,
} from './chart-theme';

function NoData(): JSX.Element {
  return <ChartEmpty label="No data for this range" heightPx={192} />;
}

interface StackedTimeSeriesChartProps {
  series: PivotedSeries;
  granularity: 'hour' | 'day' | 'week';
  /** Formats a stacked value for the tooltip (e.g. tokens vs. currency). */
  valueFormatter: (value: number) => string;
  /** Accessible chart title. */
  ariaLabel: string;
  /** Extra classes for the chart frame (for example replay privacy). */
  className?: string;
}

/**
 * Stacked vertical bar chart over time buckets, one stack segment per series
 * key (provider or model). Empty series render a muted placeholder.
 */
export function StackedTimeSeriesChart({
  series,
  granularity,
  valueFormatter,
  ariaLabel,
  className,
}: StackedTimeSeriesChartProps): JSX.Element {
  if (series.rows.length === 0 || series.keys.length === 0) {
    return <NoData />;
  }
  return (
    <div
      className={className ? `h-72 w-full ${className}` : 'h-72 w-full'}
      data-testid="stacked-time-series"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={series.rows}
          margin={{ top: 8, right: 8, bottom: 4, left: 4 }}
          aria-label={ariaLabel}
        >
          <CartesianGrid
            strokeDasharray={CHART_GRID_DASH}
            stroke={CHART_LINE}
            vertical={false}
          />
          <XAxis
            dataKey="bucket"
            tickFormatter={(value: string) =>
              formatBucketTick(value, granularity)
            }
            tick={CHART_TICK}
            stroke={CHART_LINE}
          />
          <YAxis
            tickFormatter={(value: number) => compactNumber(value, 1)}
            tick={CHART_TICK}
            stroke={CHART_LINE}
            width={48}
          />
          <Tooltip
            cursor={CHART_BAR_CURSOR}
            content={(props) => (
              <ChartTooltip
                active={props.active}
                label={props.label}
                payload={props.payload}
                accessibilityLayer={props.accessibilityLayer}
                formatValue={valueFormatter}
                formatLabel={(label) => formatBucketTick(label, granularity)}
              />
            )}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.keys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="usage"
              fill={seriesColor(index)}
              radius={
                index === series.keys.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]
              }
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface CategoryDatum {
  label: string;
  value: number;
}

interface CategoryBarChartProps {
  data: readonly CategoryDatum[];
  valueFormatter: (value: number) => string;
  ariaLabel: string;
}

/** Horizontal bar chart for a flat category breakdown (e.g. tool categories). */
export function CategoryBarChart({
  data,
  valueFormatter,
  ariaLabel,
}: CategoryBarChartProps): JSX.Element {
  if (data.length === 0) {
    return <NoData />;
  }
  const rows = data.map((datum) => ({ ...datum }));
  return (
    <div
      className="w-full"
      style={{ height: categoryBarChartHeight(rows.length) }}
      data-testid="category-bar-chart"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          aria-label={ariaLabel}
        >
          <CartesianGrid
            strokeDasharray={CHART_GRID_DASH}
            stroke={CHART_LINE}
            horizontal={false}
          />
          <XAxis
            type="number"
            tickFormatter={(value: number) => compactNumber(value, 1)}
            tick={CHART_TICK}
            stroke={CHART_LINE}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={CHART_TICK}
            stroke={CHART_LINE}
            width={120}
          />
          <Tooltip
            cursor={CHART_BAR_CURSOR}
            content={(props) => (
              <ChartTooltip
                active={props.active}
                label={props.label}
                payload={props.payload}
                accessibilityLayer={props.accessibilityLayer}
                marker="none"
                formatValue={valueFormatter}
              />
            )}
          />
          <Bar dataKey="value" radius={[0, 3, 3, 0]}>
            {rows.map((row, index) => (
              <Cell key={row.label} fill={seriesColor(index)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface ComparisonSeries {
  /** Row key in `data`. */
  key: string;
  label: string;
  /** Fixed theme role, e.g. `var(--fg-accent)`. */
  color: string;
}

interface ComparisonLineChartProps {
  data: ReadonlyArray<Record<string, string | number>>;
  /** Row key holding the bucket start ISO timestamp. */
  bucketKey: string;
  granularity: 'hour' | 'day' | 'week';
  series: readonly [ComparisonSeries, ComparisonSeries];
  valueFormatter: (value: number) => string;
  ariaLabel: string;
  testId?: string;
}

/** Two named series over time buckets, legend top right. */
export function ComparisonLineChart({
  data,
  bucketKey,
  granularity,
  series,
  valueFormatter,
  ariaLabel,
  testId = 'comparison-line-chart',
}: ComparisonLineChartProps): JSX.Element {
  if (data.length === 0) {
    return <NoData />;
  }
  const rows = data.map((row) => ({ ...row }));
  return (
    <div className="h-72 w-full" data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={rows}
          margin={{ top: 8, right: 8, bottom: 4, left: 4 }}
          aria-label={ariaLabel}
        >
          <CartesianGrid
            strokeDasharray={CHART_GRID_DASH}
            stroke={CHART_LINE}
            vertical={false}
          />
          <XAxis
            dataKey={bucketKey}
            tickFormatter={(value: string) =>
              formatBucketTick(value, granularity)
            }
            tick={CHART_TICK}
            stroke={CHART_LINE}
          />
          <YAxis
            tickFormatter={(value: number) => valueFormatter(value)}
            tick={CHART_TICK}
            stroke={CHART_LINE}
            width={64}
          />
          <Tooltip
            content={(props) => (
              <ChartTooltip
                active={props.active}
                label={props.label}
                payload={props.payload}
                accessibilityLayer={props.accessibilityLayer}
                marker="line"
                formatValue={valueFormatter}
                formatLabel={(label) => formatBucketTick(label, granularity)}
              />
            )}
          />
          <Legend
            verticalAlign="top"
            align="right"
            wrapperStyle={{ fontSize: 12, paddingBottom: 8 }}
          />
          {series.map((line) => (
            <Line
              key={line.key}
              type="monotone"
              dataKey={line.key}
              name={line.label}
              stroke={line.color}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface PairedCategoryDatum {
  label: string;
  first: number;
  second: number;
  /** Optional tooltip detail per side (e.g. cost share). */
  firstDetail?: string;
  secondDetail?: string;
}

interface PairedCategoryBarChartProps {
  data: readonly PairedCategoryDatum[];
  series: readonly [ComparisonSeries, ComparisonSeries];
  /** Formats bar-end labels and the axis. */
  valueFormatter: (value: number) => string;
  ariaLabel: string;
  testId?: string;
}

/** Grouped horizontal bars (two per category) with value labels at the end. */
export function PairedCategoryBarChart({
  data,
  series,
  valueFormatter,
  ariaLabel,
  testId = 'paired-category-bar-chart',
}: PairedCategoryBarChartProps): JSX.Element {
  if (data.length === 0) {
    return <NoData />;
  }
  const rows = data.map((datum) => ({ ...datum }));
  return (
    <div
      className="w-full"
      style={{ height: Math.max(180, rows.length * 56 + 48) }}
      data-testid={testId}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 48, bottom: 4, left: 8 }}
          aria-label={ariaLabel}
          barGap={2}
        >
          <CartesianGrid
            strokeDasharray={CHART_GRID_DASH}
            stroke={CHART_LINE}
            horizontal={false}
          />
          <XAxis
            type="number"
            tickFormatter={(value: number) => valueFormatter(value)}
            tick={CHART_TICK}
            stroke={CHART_LINE}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={CHART_TICK}
            stroke={CHART_LINE}
            width={140}
          />
          <Tooltip
            cursor={CHART_BAR_CURSOR}
            content={(props) => (
              <ChartTooltip
                active={props.active}
                label={props.label}
                payload={props.payload}
                accessibilityLayer={props.accessibilityLayer}
                formatValue={(value, entry) => {
                  const detailKey =
                    entry.dataKey === 'first' ? 'firstDetail' : 'secondDetail';
                  const detail: unknown =
                    typeof entry.row === 'object' &&
                    entry.row !== null &&
                    detailKey in entry.row
                      ? Reflect.get(entry.row, detailKey)
                      : undefined;
                  const formatted = valueFormatter(value);
                  return typeof detail === 'string'
                    ? `${formatted} (${detail})`
                    : formatted;
                }}
              />
            )}
          />
          <Legend
            verticalAlign="top"
            align="right"
            wrapperStyle={{ fontSize: 12, paddingBottom: 8 }}
          />
          <Bar
            dataKey="first"
            name={series[0].label}
            fill={series[0].color}
            radius={[0, 3, 3, 0]}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="first"
              position="right"
              formatter={(value: unknown) => valueFormatter(Number(value))}
              style={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            />
          </Bar>
          <Bar
            dataKey="second"
            name={series[1].label}
            fill={series[1].color}
            radius={[0, 3, 3, 0]}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="second"
              position="right"
              formatter={(value: unknown) => valueFormatter(Number(value))}
              style={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
