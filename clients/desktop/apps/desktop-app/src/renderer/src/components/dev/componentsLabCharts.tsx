import type { JSX } from 'react';
import {
  GranularityPicker,
  RangePicker,
  SegmentedPicker,
} from '@canopy/ui-app/charts/chart-controls';
import {
  CategoryBarChart,
  ComparisonLineChart,
  PairedCategoryBarChart,
  StackedTimeSeriesChart,
} from '@canopy/ui-app/charts/charts';
import { ChartEmpty, ChartTooltip } from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;
const formatCount = (value: number): string => value.toLocaleString('en-US');

const SERIES = {
  keys: ['claude', 'codex'],
  rows: [
    { bucket: '2026-11-02T00:00:00.000Z', claude: 1200, codex: 400 },
    { bucket: '2026-11-03T00:00:00.000Z', claude: 900, codex: 700 },
    { bucket: '2026-11-04T00:00:00.000Z', claude: 1500, codex: 650 },
  ],
};

const COMPARISON = [
  { bucket: '2026-11-02T00:00:00.000Z', actual: 42, routed: 30 },
  { bucket: '2026-11-03T00:00:00.000Z', actual: 58, routed: 37 },
  { bucket: '2026-11-04T00:00:00.000Z', actual: 49, routed: 41 },
];

const COMPARISON_SERIES = [
  { key: 'actual', label: 'Actual', color: 'var(--chart-categorical-1)' },
  { key: 'routed', label: 'Routed', color: 'var(--chart-categorical-2)' },
] as const;

const CATEGORIES = [
  { label: 'Edit', value: 240 },
  { label: 'Read', value: 180 },
  { label: 'Shell', value: 95 },
];

const PAIRED = [
  { label: 'Opus', first: 120, second: 80, firstDetail: '60%' },
  { label: 'Sonnet', first: 60, second: 90, secondDetail: '45%' },
];

const BAR_ROWS = [
  { name: 'Claude', value: 1200, color: 'var(--chart-categorical-1)' },
  { name: 'Codex', value: 400, color: 'var(--chart-categorical-2)' },
];

const LINE_ROWS = [
  { name: 'p50', value: 320, stroke: 'var(--chart-categorical-1)' },
  { name: 'p95', value: 910, stroke: 'var(--chart-categorical-2)' },
];

/** The chart kit: controls, the four charts and what they share. */
export function ChartsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Controls: range, granularity and a mode picker">
        <SpecimenGrid>
          <SpecimenCell label="RangePicker, 30 days kept">
            <RangePicker value="7d" retentionDays={30} onChange={noop} />
          </SpecimenCell>
          <SpecimenCell label="RangePicker, 1 day kept">
            <RangePicker value="24h" retentionDays={1} onChange={noop} />
          </SpecimenCell>
          <SpecimenCell label="GranularityPicker" wide>
            <GranularityPicker value="auto" onChange={noop} />
          </SpecimenCell>
          <SpecimenCell label="SegmentedPicker" wide>
            <SegmentedPicker
              label="Chart mode"
              value="counts"
              testIdPrefix="lab-chart-mode"
              options={[
                { key: 'counts', label: 'Counts' },
                { key: 'distribution', label: 'Distribution' },
              ]}
              onChange={noop}
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="ChartTooltip: on the tooltip surface, by series marker">
        <SpecimenGrid>
          <SpecimenCell label="swatch, for bars">
            <ChartTooltip
              active
              label="Nov 3"
              payload={BAR_ROWS}
              formatValue={formatCount}
            />
          </SpecimenCell>
          <SpecimenCell label="line, for lines">
            <ChartTooltip
              active
              label="Nov 3"
              payload={LINE_ROWS}
              marker="line"
              formatValue={formatCount}
            />
          </SpecimenCell>
          <SpecimenCell label="none, when each bar has its own color">
            <ChartTooltip
              active
              label="Edit"
              payload={[{ name: 'Tools', value: 240 }]}
              marker="none"
              formatValue={formatCount}
            />
          </SpecimenCell>
          <SpecimenCell label="no bucket title">
            <ChartTooltip active payload={BAR_ROWS} formatValue={formatCount} />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="ChartEmpty: a dashed box at the chart's own height">
        <ChartEmpty label="No data for this range" heightPx={192} />
      </SpecimenPanel>

      <SpecimenPanel title="StackedTimeSeriesChart">
        <StackedTimeSeriesChart
          series={SERIES}
          granularity="day"
          valueFormatter={formatCount}
          ariaLabel="Tokens by provider"
        />
      </SpecimenPanel>

      <SpecimenPanel title="ComparisonLineChart">
        <ComparisonLineChart
          data={COMPARISON}
          bucketKey="bucket"
          granularity="day"
          series={COMPARISON_SERIES}
          valueFormatter={formatCount}
          ariaLabel="Actual and routed cost"
        />
      </SpecimenPanel>

      <SpecimenPanel title="CategoryBarChart">
        <CategoryBarChart
          data={CATEGORIES}
          valueFormatter={formatCount}
          ariaLabel="Turns by tool"
        />
      </SpecimenPanel>

      <SpecimenPanel title="PairedCategoryBarChart">
        <PairedCategoryBarChart
          data={PAIRED}
          series={COMPARISON_SERIES}
          valueFormatter={formatCount}
          ariaLabel="Actual and routed by model"
        />
      </SpecimenPanel>
    </div>
  );
}
